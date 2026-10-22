import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createProbeParser, MODES, runDiagnostic, runProcess } from './conpty-report.mjs';

const sequence = [...MODES.map(mode => ({ mode, iteration: 1 })), ...MODES.toReversed().map(mode => ({ mode, iteration: 2 }))];
const passLine = ({ mode, iteration }) => `PASS mode=${mode} iteration=${iteration} inner_ms=12.300 host_ms=15.100\n`;
const timeoutLine = ({ mode, iteration }) => `FAIL mode=${mode} iteration=${iteration}: PowerShell ConPTY marker timed out\n`;
const summary = 'PowerShell ConPTY probe failed: one or more ConPTY samples failed\n';
function full(parser, overrides = {}) {
  for (const [index, sample] of sequence.entries()) {
    const line = overrides[index] ?? passLine(sample);
    parser.write(line.startsWith('FAIL') ? 'stderr' : 'stdout', Buffer.from(line));
  }
}
function child() {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => true;
  process.unref = () => { process.unrefed = true; };
  return process;
}
const processResult = (exitCode = 0, failure = null) => ({ exitCode, failure, outputBytes: 0, cleanup: { termination: 'observed', treeKill: 'not-requested', localResources: 'released' } });

test('complete sixteen samples retain only fixed schema and finite measurements', () => {
  const parser = createProbeParser();
  full(parser);
  const report = parser.finish(0);
  assert.equal(report.status, 'pass');
  assert.equal(report.samples.length, 16);
  assert.deepEqual(report.samples[0], { mode: 'inherited', iteration: 1, status: 'pass', inner_ms: 12.3, host_ms: 15.1 });
});

test('chunked CRLF lines and final line without newline parse', () => {
  const parser = createProbeParser();
  const text = sequence.map(passLine).join('').trimEnd().replaceAll('\n', '\r\n');
  for (let i = 0; i < text.length; i += 7) parser.write('stdout', Buffer.from(text.slice(i, i + 7)));
  assert.equal(parser.finish(0).status, 'pass');
});

test('marker timeout is preserved as failure with fixed summary and original exit', () => {
  const parser = createProbeParser();
  full(parser, { 1: timeoutLine(sequence[1]) });
  parser.write('stderr', Buffer.from(summary));
  const report = parser.finish(1);
  assert.equal(report.status, 'fail');
  assert.equal(report.failure, 'sample-failed');
  assert.deepEqual(report.samples[1], { mode: MODES[1], iteration: 1, status: 'fail', failure: 'marker-timeout' });
});

for (const [name, value] of Object.entries({
  secret: 'unexpected /Users/private/token=SECRET\n',
  mode: 'PASS mode=secret-path iteration=1 inner_ms=1 host_ms=2\n',
  iteration: 'PASS mode=inherited iteration=3 inner_ms=1 host_ms=2\n',
  negative: 'PASS mode=inherited iteration=1 inner_ms=-1 host_ms=2\n',
  nan: 'PASS mode=inherited iteration=1 inner_ms=NaN host_ms=2\n',
  infinity: `PASS mode=inherited iteration=1 inner_ms=${'9'.repeat(400)} host_ms=2\n`,
  suffix: `${passLine(sequence[0]).trimEnd()} secret=SECRET\n`,
  failure: 'FAIL mode=inherited iteration=1: C:\\private\\SECRET\n',
})) test(`rejects ${name} without serializing arbitrary text`, () => {
  const parser = createProbeParser();
  full(parser, { 0: value });
  const result = parser.finish(0);
  assert.equal(result.status, 'fail');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|secret-path|private/);
});

test('duplicate, missing, wrong order and incorrect output stream fail closed', () => {
  const duplicate = createProbeParser();
  full(duplicate);
  duplicate.write('stdout', Buffer.from(passLine(sequence[0])));
  assert.equal(duplicate.finish(0).failure, 'duplicate-sample');
  const partial = createProbeParser();
  partial.write('stdout', Buffer.from(passLine(sequence[0])));
  assert.equal(partial.finish(0).failure, 'missing-samples');
  const order = createProbeParser();
  full(order, { 0: passLine(sequence[1]), 1: passLine(sequence[0]) });
  assert.equal(order.finish(0).failure, 'sample-order');
  const stream = createProbeParser();
  stream.write('stderr', Buffer.from(passLine(sequence[0])));
  assert.equal(stream.finish(0).failure, 'unknown-probe-output');
});

test('full sample count cannot override failing or signaled process exit', () => {
  for (const exitCode of [1, 101, null]) {
    const parser = createProbeParser();
    full(parser);
    assert.equal(parser.finish(exitCode).failure, 'exit-mismatch');
  }
});

test('summary must match failed samples and may not precede them or repeat', () => {
  const parser = createProbeParser();
  full(parser);
  parser.write('stderr', Buffer.from(summary));
  assert.equal(parser.finish(0).failure, 'summary-mismatch');
  const repeated = createProbeParser();
  repeated.write('stderr', Buffer.from(summary + summary));
  assert.equal(repeated.finish(1).failure, 'duplicate-summary');
});

test('overlong output lines are rejected and never retained in report', () => {
  const parser = createProbeParser();
  parser.write('stdout', Buffer.from('SECRET'.repeat(2000)));
  assert.equal(parser.finish(0).failure, 'line-limit');
});

test('compiler noise is discarded and exact freshly built target is executed', async () => {
  const calls = [];
  const report = await runDiagnostic({ execute: async (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1) {
      assert.equal(command, 'cargo');
      assert.equal(options.consume, undefined);
      return processResult();
    }
    for (const sample of sequence) options.consume('stdout', Buffer.from(passLine(sample)));
    return processResult();
  } });
  assert.equal(report.status, 'pass');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--target-dir'));
  assert.ok(calls[0].args.includes('x86_64-pc-windows-msvc'));
  assert.match(calls[1].command, /conpty-build[/\\]x86_64-pc-windows-msvc[/\\]debug[/\\]powershell_conpty_probe\.exe$/);
  assert.deepEqual(calls[1].args, []);
  assert.ok(calls[1].options.timeoutMs <= calls[0].options.timeoutMs);
});

test('failed build never executes a stale probe binary', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async () => { calls++; return processResult(101, 'process-exit'); } });
  assert.equal(calls, 1);
  assert.equal(report.failure, 'build-failed');
  assert.equal(report.build.exitCode, 101);
  assert.equal(report.probe, null);
});

test('runner drops path and secret noise and preserves failure exit', async () => {
  const process = child();
  const promise = runProcess('cargo', [], { spawnProcess: () => process });
  process.stdout.write('Compiling /Users/private/token=SECRET\n');
  process.stderr.write('error C:\\private\\SECRET\n');
  process.emit('close', 101);
  const report = await promise;
  assert.equal(report.exitCode, 101);
  assert.equal(report.failure, 'process-exit');
  assert.equal(report.cleanup.termination, 'observed');
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private|Compiling/);
});

test('synchronous spawn failure never exposes exception details', async () => {
  const report = await runProcess('cargo', [], { spawnProcess: () => { throw new Error('/private/SECRET'); } });
  assert.equal(report.failure, 'spawn-error');
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private/);
});

for (const reason of ['timeout', 'output-limit']) test(`Windows ${reason} requests tree kill, releases handles and stays failed`, async () => {
  const process = child();
  process.pid = 123;
  const helper = child();
  const calls = [];
  const promise = runProcess('cargo', [], {
    timeoutMs: reason === 'timeout' ? 5 : 1000, outputLimit: 10, platform: 'win32',
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) return process;
      queueMicrotask(() => { process.emit('close', 1); helper.emit('close', 0); });
      return helper;
    },
  });
  if (reason === 'output-limit') process.stdout.write('SECRET'.repeat(10));
  const report = await promise;
  assert.equal(report.failure, reason);
  assert.equal(report.cleanup.treeKill, 'completed');
  assert.equal(report.cleanup.termination, 'observed');
  assert.equal(process.stdout.destroyed, true);
  assert.equal(process.stderr.destroyed, true);
  assert.equal(process.unrefed, true);
  assert.equal(calls[1].command, 'taskkill.exe');
  assert.deepEqual(calls[1].args, ['/PID', '123', '/T', '/F']);
  assert.equal(calls[1].options.stdio, 'ignore');
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test('cross-pipe arrival reordering is accepted while each pipe preserves sample order', () => {
  const parser = createProbeParser();
  // stderr may arrive before earlier stdout data, including the final summary.
  parser.write('stderr', Buffer.from(timeoutLine(sequence[1]) + summary));
  sequence.forEach((sample, index) => {
    if (index !== 1) parser.write('stdout', Buffer.from(passLine(sample)));
  });
  const report = parser.finish(1);
  assert.equal(report.failure, 'sample-failed');
  assert.equal(report.samples.length, 16);
  assert.equal(report.samples[1].failure, 'marker-timeout');
});

test('unknown stderr cannot be hidden by a complete successful sample set', () => {
  const parser = createProbeParser();
  full(parser);
  parser.write('stderr', Buffer.from('warning: /private/SECRET\n'));
  const report = parser.finish(0);
  assert.equal(report.failure, 'unknown-probe-output');
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private/);
});

test('partial framing and samples after same-stream summary fail', () => {
  const parser = createProbeParser();
  full(parser);
  parser.write('stdout', Buffer.from('PASS mode=inherited'));
  assert.equal(parser.finish(0).failure, 'unknown-probe-output');
  const order = createProbeParser();
  order.write('stderr', Buffer.from(summary + timeoutLine(sequence[0])));
  assert.equal(order.finish(1).failure, 'sample-after-summary');
});

test('tree-kill failure and synchronous close race do not turn timeout into success', async () => {
  const process = child();
  process.pid = 123;
  process.kill = () => { process.emit('close', 0); return true; };
  const helper = child();
  helper.kill = () => { helper.emit('close', 1); return false; };
  let calls = 0;
  const report = await runProcess('cargo', [], {
    timeoutMs: 5, platform: 'win32', spawnProcess: () => {
      if (calls++ === 0) return process;
      queueMicrotask(() => helper.emit('close', 1));
      return helper;
    },
  });
  assert.equal(report.failure, 'timeout');
  assert.equal(report.exitCode, 0);
  assert.equal(report.cleanup.treeKill, 'failed');
  assert.equal(report.cleanup.termination, 'observed');
});

test('hung tree-kill helper is killed and unreferenced at bounded cleanup deadline', async () => {
  const process = child();
  process.pid = 123;
  const helper = child();
  let helperKills = 0;
  helper.kill = () => { helperKills++; return false; };
  let calls = 0;
  const report = await runProcess('cargo', [], {
    timeoutMs: 5, platform: 'win32', spawnProcess: () => calls++ === 0 ? process : helper,
  });
  assert.equal(report.failure, 'timeout');
  assert.equal(report.cleanup.treeKill, 'requested');
  assert.equal(report.cleanup.termination, 'unconfirmed');
  assert.equal(helperKills, 1);
  assert.equal(helper.unrefed, true);
  assert.equal(process.stdout.destroyed, true);
  helper.emit('close', 0);
  assert.equal(report.cleanup.treeKill, 'requested');
});

test('cleanup kill errors are absorbed without leaking raw error messages', async () => {
  const process = child();
  process.pid = 123;
  process.kill = () => { process.emit('error', new Error('/private/SECRET')); return false; };
  const helper = child();
  helper.kill = () => { helper.emit('error', new Error('/private/SECRET')); return false; };
  let calls = 0;
  const report = await runProcess('cargo', [], {
    timeoutMs: 5, platform: 'win32', spawnProcess: () => {
      if (calls++ === 0) return process;
      queueMicrotask(() => helper.emit('error', new Error('/private/SECRET')));
      return helper;
    },
  });
  assert.equal(report.failure, 'timeout');
  assert.equal(report.cleanup.treeKill, 'failed');
  assert.equal(report.cleanup.termination, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private/);
});
