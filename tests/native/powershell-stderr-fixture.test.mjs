import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXPECTED, STDERR_CASES, classify, runCase, shape } from './powershell-stderr-fixture.mjs';

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
  child.stderr.destroy();
});
