// Unit tests for the native smoke's process helpers, msedgedriver version
// handling and the macOS skip. None of them needs tauri-driver or a WebView.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isCwdOutput } from './scenarios.mjs';
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
