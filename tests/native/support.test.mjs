// Unit tests for the native smoke's process helpers, msedgedriver version
// handling and the macOS skip. None of them needs tauri-driver or a WebView.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import test from 'node:test';
import { createTraceRuntime } from './terminal-trace.test.mjs';
import { environmentQueries, fill, isCwdOutput, isShellVersionOutput, localTerminalShell, typeInTerminal } from './scenarios.mjs';
import { driverUrl, parseDriverVersion, parseRegVersion } from './msedgedriver.mjs';
import { freePort, parseFixtureBanner, resolveExecutable, spawnLogged, startSshFixture, stopProcess, stopSshFixture } from './processes.mjs';

const BANNER = [
  'host=127.0.0.1',
  'port=50123',
  'username=fixture',
  'privateKeyPath=C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\new-windterm-terminal-1\\client_ed25519',
  'encryptedPrivateKeyPath=C:\\Temp\\client_ed25519_encrypted (passphrase p0-fixture)',
  'password=p0-password',
  'fingerprint=SHA256:AbCdEf0123456789+/xyz',
  'Stop: press Enter; automatic stop after 600 seconds',
  '',
].join('\n');

test('shell scenario writes distinct prefixed success/failure and trace artifacts without changing commands', async () => {
  const allPaths = new Set();
  for (const { failure, missingTrace = false } of [{ failure: false }, { failure: true }, { failure: false, missingTrace: true }]) {
    for (const artifactPrefix of ['', 'diag-shell-01-', 'diag-shell-02-']) {
      let tabs = 1;
      let state = '';
      let rows = [];
      const commands = [];
      const written = [];
      let trace;
      let savedLaunch;
      const opens = [];
      // Model the form left by scenario 7 before diagnostic shell repetitions.
      const env = [{ name: 'P1_ENV_SAMPLE', value: 'previous fixture value' }, { name: 'P1_ENV_EMPTY', value: '' }];
      const locale = { value: 'custom', dispatchEvent() {} };
      const input = { value: '', dispatchEvent() {} };
      const select = { value: 'powershell', disabled: false, options: [{ value: 'powershell', disabled: false }],
        selectedOptions: [{ textContent: 'Windows PowerShell' }], dispatchEvent() {} };
      const area = { focus: () => { document.activeElement = area; } };
      const pane = { contains: target => target === area, querySelectorAll: () => rows.map(textContent => ({ textContent })) };
      const document = {
        activeElement: null,
        addEventListener() {}, removeEventListener() {},
        querySelectorAll: () => Array(tabs).fill({}),
        querySelector: css => {
          if (css === '#local-dialog') return { open: true };
          if (css === '#local-cwd-input') return input;
          if (css === '#local-shell-select') return select;
          if (css === '[data-env-remove]') return env.length ? {} : null;
          if (css === '#local-locale-mode') return locale;
          if (css === '#terminal-state') return { textContent: state };
          if (css === '#terminal-size' || css === '#session-detail') return { textContent: '' };
          if (css.endsWith('.xterm-helper-textarea')) return area;
          if (css.startsWith('.terminal-pane')) return pane;
          throw new Error(`unexpected selector: ${css}`);
        },
      };
      const runtime = createTraceRuntime((_command, args, { deliver }) => {
        opens.push(args);
        const id = `fixture-${opens.length}`;
        deliver(Number(args.onEvent.slice('__CHANNEL__:'.length)), { index: 0,
          message: { id, kind: 'data', sequence: 1, data: [27, 91, 54, 110] } });
        return { id };
      });
      const { window } = runtime;
      // Negative case: install in a detached world while the fixture invokes
      // the real transport. Functional success must not approve an empty trace.
      const tracedWindow = missingTrace ? Object.create(window) : window;
      const realm = createContext({ window: tracedWindow, document, TextEncoder, performance, Map, Event: class {} });
      const session = {
        execute: async (script, args) => { realm.args = args; return runInContext(`(function () { ${script} }).apply(null, args)`, realm); },
        findElement: async css => css,
        clear: async () => { input.value = ''; },
        click: async css => {
          if (css === '[data-env-remove]') env.shift();
          if (css === '#local-start' || css === '#local-reopen') {
            if (css === '#local-start') savedLaunch = { cwd: input.value, shell: select.value,
              env: env.map(item => ({ ...item })), locale: { mode: locale.value,
                variables: locale.value === 'custom' ? [{ name: 'LANG', value: 'C.UTF-8' }] : [] } };
            await window.__TAURI_INTERNALS__.invoke('pty_open', { ...savedLaunch, onEvent: runtime.channel(() => {}).value });
            tabs++; state = '本机 shell 已启动';
          }
          if (css.includes('.tab-close')) tabs--;
        },
        sendKeys: async (css, text) => {
          if (css === '#local-cwd-input') { input.value = text; return; }
          commands.push(text.slice(0, -1));
          if (text.startsWith('(Get-Location).Path')) {
            if (failure) throw new Error('fixture cwd input failed');
            rows = [input.value];
          } else if (text.startsWith("'P1_SHELL='")) rows = ['P1_SHELL=5.1.20348.1'];
          else if (text.startsWith('exit 7')) state = '已退出 · code 7';
        },
      };
      const ctx = { session, platform: 'win32', artifactPrefix, log() {},
        writeText: async (path, text) => { written.push(path); if (path.endsWith('-trace.json')) trace = JSON.parse(text); },
        screenshot: async name => { written.push(`${name}.png`); },
      };
      if (failure) await assert.rejects(localTerminalShell(ctx), /fixture cwd input failed/);
      else if (missingTrace) await assert.rejects(localTerminalShell(ctx), /trace is incomplete/);
      else await localTerminalShell(ctx);
      const base = `${artifactPrefix}06-local-terminal-shell`;
      assert.deepEqual(written, failure
        ? [`${base}-failure.json`, `${base}-failure.png`, `${base}-trace.json`]
        : [`${base}.txt`, `${base}.png`, `${base}-trace.json`]);
      for (const path of written) {
        const qualified = `${missingTrace ? 'missing-trace' : failure ? 'failure' : 'success'}/${path}`;
        assert.ok(!allPaths.has(qualified), `artifact overwritten: ${qualified}`);
        allPaths.add(qualified);
      }
      const query = ['[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "'P1_SHELL=' + $PSVersionTable.PSVersion.ToString()", '(Get-Location).Path'];
      assert.deepEqual(commands, failure ? query : [...query, 'exit 7', ...query, 'exit 7']);
      assert.equal(opens.length, failure ? 1 : 2);
      for (const launch of opens) {
        assert.deepEqual(launch.env, []);
        assert.deepEqual(launch.locale, { mode: 'default', variables: [] });
      }
      assert.deepEqual(trace.records.filter(item => item.command === 'pty_open' && item.state === 'begin')
        .map(item => item.slot), missingTrace ? [] : failure ? [1] : [1, 2]);
      assert.equal(trace.records.filter(item => item.event === 'data' && item.hex === '1b5b366e').length, missingTrace ? 0 : opens.length);
      assert.equal(trace.incomplete, failure || missingTrace);
      assert.equal(tabs, 1);
      assert.equal(tracedWindow.__P1_NATIVE_SHELL_TRACE__, undefined);
    }
  }
});

test('empty form values clear and read back without sending empty WebDriver text', async () => {
  for (const clearWorks of [true, false]) {
    const calls = [];
    const input = { value: 'previous value', dispatchEvent: event => calls.push(event.type) };
    const ctx = {
      log: () => calls.push('fallback log'),
      session: {
        findElement: async css => { assert.equal(css, '#field'); return 'field-id'; },
        clear: async id => { assert.equal(id, 'field-id'); calls.push('clear'); if (clearWorks) input.value = ''; },
        sendKeys: async (_id, value) => {
          assert.notEqual(value, '', 'WebKitGTK rejects empty sendKeys with Missing text parameter');
          calls.push('sendKeys');
        },
        execute: async (script, args) => {
          calls.push('execute');
          return runInNewContext(`(function () { ${script} }).apply(null, args)`, {
            args,
            document: { querySelector: css => { assert.equal(css, '#field'); return input; } },
            Event: class { constructor(type) { this.type = type; } },
          });
        },
      },
    };
    assert.equal(await fill(ctx, '#field', ''), clearWorks ? 'typed' : 'script');
    assert.equal(input.value, '');
    assert.deepEqual(calls, clearWorks
      ? ['clear', 'execute']
      : ['clear', 'execute', 'fallback log', 'execute', 'input']);
  }
});

test('terminal typing timing is opt-in and records only elapsed milliseconds', async () => {
  const calls = [];
  const ctx = {
    session: {
      execute: async () => true,
      findElement: async css => css,
      sendKeys: async (_id, value) => calls.push(value),
    },
  };
  assert.equal(await typeInTerminal(ctx, 'probe\u000d'), 'element send keys');
  assert.deepEqual(calls, ['probe\u000d']);
  const events = [];
  assert.equal(await typeInTerminal(ctx, 'timed\u000d', milliseconds => events.push(milliseconds)), 'element send keys');
  assert.equal(events.length, 1);
  assert.equal(typeof events[0], 'number');
  assert.ok(events[0] >= 0);
});

test('parseFixtureBanner reads the ssh_terminal_fixture banner once every field has arrived', () => {
  assert.deepEqual(parseFixtureBanner(BANNER), {
    host: '127.0.0.1', port: 50123, username: 'fixture',
    privateKeyPath: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\new-windterm-terminal-1\\client_ed25519',
    fingerprint: 'SHA256:AbCdEf0123456789+/xyz',
  });
  assert.equal(parseFixtureBanner(BANNER.replace(/\r?\n/g, '\r\n')).port, 50123);
  assert.equal(parseFixtureBanner(BANNER.slice(0, BANNER.indexOf('fingerprint='))), undefined);
  // A read that stops inside the fingerprint must not yield a truncated value.
  assert.equal(parseFixtureBanner(BANNER.slice(0, BANNER.indexOf('+/xyz'))), undefined);
  assert.equal(parseFixtureBanner(BANNER.replace('port=50123', 'port=70000')), undefined);
  assert.equal(parseFixtureBanner(BANNER.replace('SHA256:', 'MD5:')), undefined);
});

test('resolveExecutable adds .exe on Windows only when that file exists', () => {
  const exists = (path) => path.endsWith('app.exe');
  assert.ok(resolveExecutable('target/debug/app', 'win32', exists).endsWith('app.exe'));
  assert.ok(!resolveExecutable('target/debug/other', 'win32', exists).endsWith('.exe'));
  assert.ok(!resolveExecutable('target/debug/app', 'linux', exists).endsWith('.exe'));
  assert.ok(resolveExecutable('target/debug/app.exe', 'win32', () => false).endsWith('app.exe'));
});

test('freePort returns a bindable loopback port', async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});

test('msedgedriver helpers parse reg output, build the exact URL and read the driver version', () => {
  const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\r\n    pv    REG_SZ    130.0.2849.80\r\n\r\n';
  assert.equal(parseRegVersion(reg), '130.0.2849.80');
  assert.equal(parseRegVersion(reg.replace('130.0.2849.80', '0.0.0.0')), undefined);
  assert.equal(parseRegVersion('    pv    REG_SZ    \r\n'), undefined);
  assert.equal(parseRegVersion('ERROR: The system was unable to find the specified registry key or value.'), undefined);
  assert.equal(driverUrl('130.0.2849.80'), 'https://msedgedriver.microsoft.com/130.0.2849.80/edgedriver_win64.zip');
  assert.throws(() => driverUrl('130.0'), /four-part/);
  assert.throws(() => driverUrl('1.2.3.4/../x'), /four-part/);
  assert.equal(parseDriverVersion('Microsoft Edge WebDriver 130.0.2849.80 (a1b2c3d4)'), '130.0.2849.80');
  assert.equal(parseDriverVersion('ChromeDriver 130.0.6723.58'), undefined);
});

test('startSshFixture waits for the banner and stopSshFixture stops it through stdin', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'p0-native-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A stand-in with the real binary's stdout contract: banner, then stop on a stdin newline.
  const script = `process.stdout.write(${JSON.stringify(BANNER)});
    process.stdin.once('data', () => { console.log('Stopped; active fixture sessions=0; auth attempts=1'); process.exit(0); });`;
  const fixture = await startSshFixture({ binary: process.execPath, args: ['-e', script], logPath: join(dir, 'fixture.log'), timeoutMs: 10_000 });
  assert.equal(fixture.info.port, 50123);
  assert.ok(fixture.running());
  const stopped = await stopSshFixture(fixture);
  assert.equal(stopped.code, 0);
  assert.equal(stopped.report, 'Stopped; active fixture sessions=0; auth attempts=1');
  assert.match(await readFile(join(dir, 'fixture.log'), 'utf8'), /\[exit\] code=0/);
});

test('startSshFixture fails with the output when the fixture exits before its banner', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'p0-native-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    startSshFixture({ binary: process.execPath, args: ['-e', 'console.error("bind failed"); process.exit(3)'], logPath: join(dir, 'fixture.log') }),
    /exited before its banner:[\s\S]*bind failed/);
});

test('a binary that cannot start resolves exited, is not running and closes its log', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'p0-native-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handle = spawnLogged(join(dir, 'missing-binary'), [], join(dir, 'missing.log'));
  const result = await handle.exited;
  assert.match(result.error, /ENOENT/);
  assert.equal(handle.running(), false);
  assert.match(handle.tail(), /\[spawn error\]/);
  assert.equal(await stopProcess(handle), result);
  await new Promise(resolveLater => setTimeout(resolveLater, 50));
  assert.match(await readFile(join(dir, 'missing.log'), 'utf8'), /\[spawn error\] .*ENOENT/);
});

test('run.mjs skips on macOS with the documented message and exit 0', { skip: process.platform === 'darwin' ? undefined : 'macOS-only behaviour' }, () => {
  const run = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [run], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'skipped: tauri-driver does not support macOS\n');
});


test('cwd evidence accepts an exact physical shell path, not prompts, commands or partial paths', () => {
  const unix = '/private/tmp/p1 中文-ab12';
  assert.ok(isCwdOutput(unix, unix, 'darwin'));
  assert.ok(!isCwdOutput('/tmp/p1 中文-ab12', unix, 'darwin'));
  assert.ok(!isCwdOutput(`P0 ${unix} % pwd -P`, unix, 'darwin'));
  assert.ok(!isCwdOutput(`cd ${unix}`, unix, 'linux'));
  assert.ok(!isCwdOutput(`${unix}/other`, unix, 'linux'));
  assert.ok(!isCwdOutput('/private/tmp/p1', unix, 'linux'));
  const windows = String.raw`C:\Users\runner\Temp\p1 中文-ab12`;
  assert.ok(isCwdOutput(windows, windows, 'win32'));
  assert.ok(isCwdOutput(windows.toLowerCase(), windows, 'win32'));
  assert.ok(!isCwdOutput(`P0 ${windows}> cd`, windows, 'win32'));
  assert.ok(!isCwdOutput(`cd ${windows}`, windows, 'win32'));
  assert.ok(!isCwdOutput(`${windows}\\other`, windows, 'win32'));
  // A short-name alias is not textual proof of the canonical cwd. The scenario
  // supplies the canonical path itself instead of relaxing this assertion.
  assert.ok(!isCwdOutput(String.raw`C:\Users\RUNNER~1\Temp\p1 中文-ab12`,
    String.raw`C:\Users\runneradmin\Temp\p1 中文-ab12`, 'win32'));
});


test('shell evidence requires expanded version output and rejects echoed commands and prompts', () => {
  assert.ok(isShellVersionOutput('P1_SHELL=3.2.57(1)-release', 'bash'));
  assert.ok(isShellVersionOutput('P1_SHELL=5.2.21(1)-release', 'bash'));
  assert.ok(isShellVersionOutput('P1_SHELL=5.1.20348.2849', 'powershell'));
  assert.ok(isShellVersionOutput('P1_SHELL=7.4.6', 'powershell'));
  for (const shell of ['bash', 'powershell']) {
    for (const row of [
      'P1_SHELL=', 'P1_SHELL=$BASH_VERSION',
      "printf 'P1_SHELL=%s\\n' \"$BASH_VERSION\"",
      "'P1_SHELL=' + $PSVersionTable.PSVersion.ToString()",
      'P0 /tmp $ P1_SHELL=5.2.21', 'PS C:\\Temp> P1_SHELL=5.1.20348.2849',
      'P1_SHELL=5.2.21 suffix', 'prefix P1_SHELL=5.2.21',
    ]) assert.ok(!isShellVersionOutput(row, shell), `${shell}: ${row}`);
  }
  assert.ok(!isShellVersionOutput('P1_SHELL=5.1.20348.2849', 'cmd'));
});

test('environment evidence separates empty from absent and never interpolates values into commands', () => {
  const sample = "中文 space=one ' $(touch unwanted)";
  for (const platform of ['linux', 'darwin', 'win32']) {
    const custom = environmentQueries(platform, 'initial', sample, true);
    const defaults = environmentQueries(platform, 'defaults', null, false);
    assert.equal(custom.length, 10);
    assert.ok(custom.some(({ expected }) => expected.endsWith(`SAMPLE=[${sample}]`)));
    assert.ok(custom.some(({ expected }) => expected.endsWith('EMPTY_PRESENT=[yes]')));
    assert.ok(defaults.some(({ expected }) => expected.endsWith('EMPTY_PRESENT=[no]')));
    for (const { command, expected } of custom) {
      assert.ok(!command.includes(sample));
      assert.notEqual(command, expected);
      assert.notEqual(`P0 ${expected}`, expected);
    }
    if (platform === 'win32') assert.ok(custom.some(({ command }) => command.includes("Contains('P1_ENV_EMPTY')")));
  }
  assert.throws(() => environmentQueries('linux', "'; touch unwanted", '', true), /phase/);
});

test('fixed environment queries read literal Unicode and empty values from a real Bash child', {
  skip: process.platform === 'win32' ? 'Bash not required on Windows; native PowerShell lane validates there' : undefined,
}, () => {
  const sample = "中文 space=one ' $(touch unwanted)";
  const queries = environmentQueries('linux', 'initial', sample, true);
  const child = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', queries.map(item => item.command).join('\n')], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', P1_ENV_SAMPLE: sample, P1_ENV_EMPTY: '' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(child.stdout.trimEnd().split('\n'), queries.map(item => item.expected));
});
