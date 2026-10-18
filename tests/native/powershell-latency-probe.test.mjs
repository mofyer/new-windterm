import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseMeasurements, POWERSHELL_SCRIPT, productEnvironment, sample } from './powershell-latency-probe.mjs';

const cwd = 'C:\\Temp\\p1 shell 中文-fixture';
const encoded = Buffer.from(cwd).toString('base64');
const lines = ['P1_VERSION|5.1.20348.5622', ...['reference', 'first', 'second'].flatMap(phase => [`P1_START|${phase}`, `P1_RESULT|${phase}|21.026|${encoded}`]), 'P1_DONE'];

test('strict schema validates all three timings, version and exact Unicode cwd', () => {
  const result = parseMeasurements(`${lines.join('\r\n')}\r\n`, cwd);
  assert.equal(result.complete, true);
  assert.equal(result.error, null);
  assert.equal(result.measurements.length, 3);
  assert.equal(result.measurements[1].milliseconds, 21.026);
});

test('partial failure retains verified prefix and pending phase', () => {
  const result = parseMeasurements(`${lines.slice(0, 4).join('\n')}\n`, cwd);
  assert.equal(result.complete, false);
  assert.equal(result.pending, 'first');
  assert.equal(result.measurements.length, 1);
  assert.equal(result.error, 'Incomplete measurement sequence');
});

test('reject wrong identity, cwd, unexpected output, order and invalid times without raw output', () => {
  for (const text of [lines.join('\n').replace('5.1.', '7.1.'), lines.join('\n').replace(encoded, Buffer.from('other').toString('base64')), `${lines.join('\n')}\nSECRET`, lines.join('\n').replace('21.026', 'NaN'), lines.join('\n').replace('21.026', '-1'), lines.join('\n').replace('P1_START|first', 'P1_START|second')]) {
    const result = parseMeasurements(text, cwd);
    assert.equal(result.complete, false);
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('script failure is explicit and does not count complete', () => {
  const result = parseMeasurements(`${lines.slice(0, 4).join('\n')}\nP1_ERROR\n`, cwd);
  assert.equal(result.error, 'PowerShell script error');
  assert.equal(result.complete, false);
});

test('environment whitelist matches product source and never mutates inherited source', () => {
  const source = { systemroot: 'C:\\Windows', Path: 'path', ComSpec: 'cmd', USERPROFILE: 'profile', TEMP: 'temp', TMP: 'tmp', APPDATA: 'app', LOCALAPPDATA: 'local', SECRET: 'hidden', PSModulePath: 'modules' };
  const original = { ...source };
  const env = productEnvironment(source);
  assert.deepEqual(Object.keys(env), ['SystemRoot', 'PATH', 'ComSpec', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']);
  assert.equal(env.SECRET, undefined);
  assert.equal(env.PSModulePath, undefined);
  assert.deepEqual(source, original);
  assert.throws(() => productEnvironment({ SystemRoot: 'C:\\Windows' }), /PATH/);
  const product = readFileSync(new URL('../../apps/desktop/src-tauri/src/local_shell.rs', import.meta.url), 'utf8');
  assert.ok(product.includes('for name in ["SystemRoot", "PATH"]'));
  assert.ok(product.includes('for name in ["USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]'));
  assert.ok(product.includes('std::env::var_os("ComSpec")'));
});

test('static script does not invoke a cmdlet ahead of first measurement', () => {
  const prefix = POWERSHELL_SCRIPT.slice(0, POWERSHELL_SCRIPT.indexOf('$path = (Get-Location).Path'));
  assert.ok(prefix.includes('$ExecutionContext.SessionState.Path.CurrentLocation.Path'));
  assert.ok(!/\b(?:New-Object|ConvertTo-Json|Write-Output|Get-Command|Import-Module)\b/.test(POWERSHELL_SCRIPT));
  assert.equal(POWERSHELL_SCRIPT.match(/\(Get-Location\)\.Path/g).length, 2);
});

function fakeProcess(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => false, unref: () => { child.detached = true; } });
  return child;
}

test('successful sample preserves exact Unicode cwd and launches only the controlled script', async () => {
  const child = fakeProcess(101);
  const result = await sample('powershell.exe', cwd, {}, 'C:\\Windows', {
    spawnProcess: (file, args, options) => {
      assert.equal(file, 'powershell.exe');
      assert.equal(options.cwd, cwd);
      assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), POWERSHELL_SCRIPT);
      queueMicrotask(() => {
        child.stdout.write(lines.join('\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.cleanupSucceeded, null);
  assert.equal(result.measurements.length, 3);
});

for (const killerMode of ['failed', 'stalled', 'throws', 'kill-error-event']) {
  test(`bounded termination when taskkill ${killerMode} and child never closes`, { timeout: 3_000 }, async () => {
    const child = fakeProcess(102);
    const killer = fakeProcess(103);
    let launches = 0;
    let fallbackKills = 0;
    child.kill = () => {
      fallbackKills++;
      if (killerMode === 'kill-error-event') {
        child.emit('error', new Error('SECRET EPERM'));
        return false;
      }
      throw new Error('SECRET OS error');
    };
    const result = await sample('powershell.exe', cwd, {}, 'C:\\Windows', {
      processTimeoutMs: 5,
      terminationTimeoutMs: 5,
      spawnProcess: (file, args) => {
        if (++launches === 1) return child;
        assert.equal(file, 'C:\\Windows\\System32\\taskkill.exe');
        assert.deepEqual(args, ['/PID', '102', '/T', '/F']);
        if (killerMode === 'throws') throw new Error('SECRET spawn error');
        if (killerMode === 'failed' || killerMode === 'kill-error-event') queueMicrotask(() => killer.emit('close', 1));
        return killer;
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.failure, '60 second process timeout');
    assert.equal(result.cleanupSucceeded, false);
    assert.equal(child.detached, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(fallbackKills, 1);
    if (killerMode === 'stalled') assert.equal(killer.detached, true);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
}

test('timeout keeps failure even when taskkill and child close succeed', async () => {
  const child = fakeProcess(104);
  const killer = fakeProcess(105);
  let launches = 0;
  const result = await sample('powershell.exe', cwd, {}, 'C:\\Windows', {
    processTimeoutMs: 5,
    terminationTimeoutMs: 5,
    spawnProcess: () => {
      if (++launches === 1) return child;
      queueMicrotask(() => { killer.emit('close', 0); child.emit('close', 1, null); });
      return killer;
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.cleanupSucceeded, true);
  assert.equal(result.failure, '60 second process timeout');
});
