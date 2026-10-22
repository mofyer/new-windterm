import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXPECTED, STDERR_CASES, STDERR_CAPTURE_LIMIT, classify, runCase, shape } from './powershell-stderr-fixture.mjs';

test('fixture covers warning, error, empty and unknown streams without content in summaries', () => {
  assert.deepEqual(Object.keys(STDERR_CASES), ['warning', 'error', 'empty', 'unknown']);
  assert.equal(classify('WARNING: fixture\r\n'), 'powershell-stream');
  assert.equal(classify('At line: 1 char: 2\r\n+ x'), 'powershell-error');
  assert.equal(classify('Write-Error: fixture\r\n'), 'powershell-error');
  assert.equal(classify(''), 'empty');
  assert.equal(classify('private fixture text'), 'unknown');
  const summary = JSON.stringify({ shape: shape(Buffer.from('private fixture text\r\n')) });
  assert.equal(summary.includes('private'), false);
});

test('runCase keeps only bounded evidence and enforces expected classifications', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const resultPromise = runCase('warning', STDERR_CASES.warning, {
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('WARNING: fixture\\r\\n');
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  const result = await resultPromise;
  assert.equal(result.exitCode, EXPECTED.warning.exitCode);
  assert.deepEqual(result.stderr.classifications, { 'powershell-stream': 1 });
  assert.equal(result.stderr.totalBytes, result.stderr.capturedBytes);
  assert.equal(result.failure, null);
  assert.equal(JSON.stringify(result).includes('fixture'), false);
});

test('runCase returns a bounded timeout result', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; return true; };
  const result = await runCase('unknown', STDERR_CASES.unknown, { spawnProcess: () => child, timeoutMs: 5 });
  assert.equal(result.failure, 'timeout');
  assert.equal(killed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(result.cleanup.termination, 'unconfirmed');
});

for (const mode of ['false', 'throw']) {
  test(`timeout releases local resources when kill returns ${mode}`, async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let unreferenced = false;
    child.unref = () => { unreferenced = true; };
    child.kill = () => {
      if (mode === 'throw') throw new Error('private cleanup detail');
      return false;
    };
    const result = await runCase('unknown', STDERR_CASES.unknown, { spawnProcess: () => child, timeoutMs: 5 });
    assert.equal(result.failure, 'timeout');
    assert.equal(result.exitCode, null);
    assert.deepEqual(result.cleanup, { kill: 'failed', termination: 'unconfirmed', localResources: 'released' });
    assert.ok(unreferenced);
    assert.ok([child.stdin, child.stdout, child.stderr].every(stream => stream.destroyed));
    const snapshot = JSON.stringify(result);
    // A close/error/data race after settling must neither digest twice nor
    // change a timeout into success or include the late private output.
    child.stderr.emit('data', Buffer.from('private late output'));
    child.emit('error', new Error('private late error'));
    child.emit('close', 0);
    assert.equal(JSON.stringify(result), snapshot);
    assert.equal(snapshot.includes('private'), false);
  });
}

test('timeout releases actual subprocess handles even when termination fails', () => {
  const fixtureUrl = new URL('./powershell-stderr-fixture.mjs', import.meta.url).href;
  const script = `
    import { spawn } from 'node:child_process';
    import { runCase } from ${JSON.stringify(fixtureUrl)};
    const result = await runCase('unknown', '', {
      timeoutMs: 20,
      spawnProcess: () => {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
        process.stdout.write(String(child.pid) + '\\n');
        child.kill = () => false;
        return child;
      },
    });
    process.stdout.write(JSON.stringify(result) + '\\n');
  `;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  const [pidText, resultText] = probe.stdout.trim().split('\n');
  // This is the process created by this test only. Always reap its deliberately
  // unconfirmed termination, including when the wrapper fails to exit.
  try {
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0);
    const result = JSON.parse(resultText);
    assert.equal(result.failure, 'timeout');
    assert.equal(result.cleanup.termination, 'unconfirmed');
  } finally {
    if (/^\d+$/.test(pidText)) {
      try { process.kill(Number(pidText), 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
});

test('stderr overflow retains a capped prefix and full-stream hash but fails', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  const bytes = Buffer.alloc(STDERR_CAPTURE_LIMIT + 8192, 65);
  const result = await runCase('unknown', STDERR_CASES.unknown, {
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write(bytes.subarray(0, 1024));
        child.stderr.write(bytes.subarray(1024));
        child.emit('close', 0);
      });
      return child;
    },
  });
  child.stderr.destroy();
  assert.equal(result.failure, 'stderr-limit');
  assert.equal(result.stderr.structure.status, 'truncated');
  assert.equal(result.stderr.truncated, true);
  assert.equal(result.stderr.capturedBytes, STDERR_CAPTURE_LIMIT);
  assert.equal(result.stderr.shape.bytes, STDERR_CAPTURE_LIMIT);
  assert.equal(result.stderr.totalBytes, bytes.length);
  assert.equal(result.stderr.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(result.stderr.classifications, { unknown: 1 });
  assert.equal(JSON.stringify(result).includes('AAAA'), false);
});


test('fixture exposes bounded CLIXML structure while classification remains unknown', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  const stderr = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="warning">SECRET</S></Objs>';
  const result = await runCase('warning', STDERR_CASES.warning, {
    spawnProcess: () => {
      queueMicrotask(() => {
        for (const byte of Buffer.from(stderr)) child.stderr.write(Buffer.from([byte]));
        child.emit('close', 0);
      });
      return child;
    },
  });
  child.stderr.destroy();
  assert.equal(result.stderr.structure.status, 'clixml');
  assert.equal(result.stderr.structure.streams.warning, 1);
  assert.deepEqual(result.stderr.classifications, { unknown: 1 });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
