import assert from 'node:assert/strict';
import test from 'node:test';
import { createFramedParser, runDiagnostic } from './conpty-framed-report.mjs';

const measurement = (overrides = {}) => ({
  schema: 1, mode: 'startup-framed', startupMs: 100, wallMs: 130, versionOk: true,
  exitCode: 0, cprReplies: 1, mergedBytes: 100, startupComplete: true, complete: true,
  cleanupOk: true, failure: null, expectedStage: 'after-frame', protocolReason: null,
  killRequested: false, exitObservedBeforeKill: true,
  readyWriteCompleted: true, readyWriteMs: 95, frameCount: 1, ...overrides,
});
const line = value => Buffer.from(`${JSON.stringify(value)}\n`);
const processResult = (exitCode = 0, failure = null) => ({ exitCode, failure, outputBytes: 0, cleanup: { termination: 'observed', treeKill: 'not-requested', localResources: 'released' } });
const timeout = (overrides = {}) => measurement({
  startupMs: 5005, startupComplete: false, complete: false, versionOk: false,
  failure: 'startup-timeout', protocolReason: 'startup-timeout', expectedStage: 'await-frame',
  exitCode: 1, frameCount: 0, killRequested: true, exitObservedBeforeKill: false, ...overrides,
});

test('chunked startup JSON preserves only the exact fixed record', () => {
  const parser = createFramedParser();
  const input = line(measurement());
  for (let index = 0; index < input.length; index += 3) assert.equal(parser.write('stdout', input.subarray(index, index + 3)), true);
  assert.deepEqual(parser.finish(0), { measurement: measurement(), failure: null });
});

for (const [name, overrides] of Object.entries({
  schema: { schema: 2 }, mode: { mode: 'startup-only' }, query: { q1Ms: 1 },
  private: { raw: '/private/SECRET' }, stage: { expectedStage: 'SECRET' }, reason: { protocolReason: 'SECRET' },
  failure: { failure: 'command-timeout' }, bool: { startupComplete: 1 },
  writeMissing: { readyWriteMs: null }, writeContradiction: { readyWriteCompleted: false },
  writeLate: { readyWriteMs: 5001 }, successfulStartupLate: { startupMs: 5001 },
  startupDeadline: { startupMs: 5000 }, versionWithoutReady: { frameCount: 0 },
  afterReadyWithoutVersion: { versionOk: false },
  writeDeadline: { readyWriteMs: 5000 }, writeAfterStartup: { readyWriteMs: 101 },
  startupStage: { expectedStage: 'await-cursor' },
  wall: { wallMs: 45001 }, infinite: { wallMs: Infinity }, negative: { wallMs: -1 },
  cpr: { cprReplies: 65537 }, bytes: { mergedBytes: 256 * 1024 + 4097 },
  count: { frameCount: 0.5 }, saturated: { frameCount: 2 },
  oldCounters: { terminalCounters: {} }, oldStrict: { strictReadyCount: 1 }, oldEmbedded: { embeddedReadyCount: 0 },
  unknownHistory: { killRequested: null, exitObservedBeforeKill: null },
  killContradiction: { killRequested: false, exitObservedBeforeKill: false },
  exit: { exitCode: 1 }, startupFalse: { startupComplete: false }, cleanup: { cleanupOk: false },
})) test(`invalid startup ${name} fails without retaining private input`, () => {
  const parser = createFramedParser();
  assert.equal(parser.write('stdout', line(measurement(overrides))), false);
  assert.deepEqual(parser.finish(0), { measurement: null, failure: 'protocol-error' });
});

test('frame controls and duplicate tail retain a validated startup prefix without turning failure into success', () => {
  for (const protocolReason of ['duplicate-frame', 'frame-control', 'incomplete-control']) {
    const value = measurement({ complete: false, failure: 'protocol-error', protocolReason, exitCode: 1 });
    const parser = createFramedParser();
    assert.equal(parser.write('stdout', line(value)), true);
    assert.deepEqual(parser.finish(1), { measurement: value, failure: null });
  }
});

test('READY frame observed without an in-window write ACK remains failed', () => {
  const value = timeout({ versionOk: true, frameCount: 1, expectedStage: 'after-frame', readyWriteCompleted: false, readyWriteMs: null });
  const parser = createFramedParser();
  assert.equal(parser.write('stdout', line(value)), true);
  assert.deepEqual(parser.finish(1), { measurement: value, failure: null });
});

test('write timestamp confirmed at timeout freeze does not turn failed startup into success', () => {
  const value = timeout({ versionOk: true, frameCount: 1, expectedStage: 'after-frame', readyWriteCompleted: true, readyWriteMs: 4999 });
  const parser = createFramedParser();
  assert.equal(parser.write('stdout', line(value)), true);
  assert.deepEqual(parser.finish(1), { measurement: value, failure: null });
});

test('startup success remains visible when later exit or cleanup fails', () => {
  for (const [failure, cleanupOk, killRequested, exitObservedBeforeKill] of [
    ['exit-error', true, true, true], ['cleanup-failed', false, null, null], ['cleanup-failed', false, true, null],
  ]) {
    const value = measurement({ complete: false, failure, protocolReason: failure, cleanupOk, killRequested, exitObservedBeforeKill, exitCode: null });
    const parser = createFramedParser();
    assert.equal(parser.write('stdout', line(value)), cleanupOk ? true : 'cleanup-failed');
    assert.deepEqual(parser.finish(cleanupOk ? 1 : null), { measurement: value, failure: null });
  }
});

test('setup failures have no confirmed startup or cleanup invocation history', () => {
  const value = timeout({
    startupMs: null, cprReplies: 0, mergedBytes: 0, expectedStage: 'not-started', failure: 'setup-error', protocolReason: 'setup-error',
    readyWriteCompleted: false, readyWriteMs: null, killRequested: null, exitObservedBeforeKill: null,
  });
  const parser = createFramedParser();
  assert.equal(parser.write('stdout', line(value)), true);
  assert.deepEqual(parser.finish(1), { measurement: value, failure: null });
});

test('duplicate keys, unknown stderr, extra records and incomplete JSON are rejected', () => {
  for (const action of [
    parser => parser.write('stderr', Buffer.from('SECRET')),
    parser => parser.write('stdout', Buffer.from(JSON.stringify(measurement()).replace('"frameCount":1', '"frameCount":1,"frameCount":1') + '\n')),
    parser => { parser.write('stdout', line(measurement())); parser.write('stdout', line(measurement())); },
    parser => parser.write('stdout', Buffer.from(JSON.stringify(measurement()))),
    parser => parser.write('stdout', Buffer.from('{SECRET}\n')),
    parser => parser.write('stdout', Buffer.alloc(4097, 0xff)),
  ]) {
    const parser = createFramedParser();
    action(parser);
    const result = parser.finish(0);
    assert.equal(result.failure, 'protocol-error');
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('worker exit must match the fixed record', () => {
  const parser = createFramedParser();
  parser.write('stdout', line(measurement()));
  assert.equal(parser.finish(1).failure, 'exit-mismatch');
});

test('tests and fresh build precede exactly two identical startup-framed workers', async () => {
  const calls = [];
  const snapshots = [];
  const report = await runDiagnostic({ onUpdate: async report => snapshots.push(structuredClone(report)), execute: async (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length <= 2) return processResult();
    assert.deepEqual(args, ['--startup-framed']);
    assert.equal(options.consume('stdout', line(measurement())), true);
    return processResult();
  } });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].args[0], 'test');
  assert.equal(calls[1].args[0], 'build');
  for (const call of calls.slice(0, 2)) {
    assert.ok(call.args.includes('--locked'));
    assert.ok(call.args.includes('--all-features'));
    assert.ok(call.args.includes('x86_64-pc-windows-msvc'));
    assert.ok(call.args.includes('powershell_conpty_qualified_probe'));
  }
  assert.match(calls[2].command, /conpty-framed-build[/\\]x86_64-pc-windows-msvc[/\\]debug[/\\]powershell_conpty_qualified_probe\.exe$/);
  assert.equal(calls[2].options.timeoutMs, 45000);
  assert.equal(calls[2].options.outputLimit, 4096);
  assert.deepEqual(report.samples.map(sample => sample.order), [1, 2]);
  assert.equal(report.experimentComplete, true);
  assert.equal(report.startupSuccess, true);
  assert.equal(report.diagnosticPassed, true);
  assert.equal(report.stderrObservedSeparately, false);
  assert.equal(snapshots[0].samples.length, 0);
  assert.equal(snapshots.at(-1).samples.length, 2);
});

test('Rust test or build failure prevents all sampling', async () => {
  for (const failedCall of [1, 2]) {
    let calls = 0;
    const report = await runDiagnostic({ execute: async () => ++calls === failedCall ? processResult(101, 'process-exit') : processResult() });
    assert.equal(calls, failedCall);
    assert.equal(report.failure, failedCall === 1 ? 'tests-failed' : 'build-failed');
    assert.equal(report.samples.length, 0);
  }
});

test('first failed worker stops without retries and retains the fixed failure', async () => {
  for (const cleanupOk of [true, false]) {
    let calls = 0;
    const report = await runDiagnostic({ execute: async (_command, _args, options) => {
      if (++calls <= 2) return processResult();
      const value = timeout(cleanupOk ? {} : { cleanupOk: false, failure: 'cleanup-failed', killRequested: null, exitObservedBeforeKill: null });
      assert.equal(options.consume('stdout', line(value)), cleanupOk ? true : 'cleanup-failed');
      return processResult(1, cleanupOk ? 'process-exit' : 'cleanup-failed');
    } });
    assert.equal(calls, 3);
    assert.equal(report.samples.length, 1);
    assert.equal(report.samples[0].measurement.protocolReason, 'startup-timeout');
    assert.equal(report.failure, cleanupOk ? 'sample-failed' : 'cleanup-failed');
    assert.equal(report.experimentComplete, false);
    assert.equal(report.diagnosticPassed, false);
  }
});

test('old query protocol is rejected and never starts a second worker', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async (_command, _args, options) => {
    if (++calls <= 2) return processResult();
    assert.equal(options.consume('stdout', line({ schema: 2, arm: 'unqualified', q1Ms: 42 })), false);
    return processResult(1, 'protocol-error');
  } });
  assert.equal(calls, 3);
  assert.equal(report.samples[0].measurement, null);
  assert.equal(report.failure, 'protocol-error');
});

test('two completed startups remain successful when the second worker later fails exit or cleanup', async () => {
  for (const failure of ['exit-error', 'cleanup-failed']) {
    let calls = 0;
    const snapshots = [];
    const cleanupOk = failure !== 'cleanup-failed';
    const report = await runDiagnostic({ onUpdate: async report => snapshots.push(structuredClone(report)), execute: async (_command, _args, options) => {
      if (++calls <= 2) return processResult();
      if (calls === 3) {
        assert.equal(options.consume('stdout', line(measurement())), true);
        return processResult();
      }
      const value = measurement({ complete: false, failure, protocolReason: failure, cleanupOk, exitCode: null,
        killRequested: cleanupOk ? true : null, exitObservedBeforeKill: null });
      assert.equal(options.consume('stdout', line(value)), cleanupOk ? true : 'cleanup-failed');
      return processResult(1, cleanupOk ? 'process-exit' : 'cleanup-failed');
    } });
    assert.equal(calls, 4);
    assert.equal(report.samples.length, 2);
    assert.equal(report.startupSuccess, true);
    assert.equal(report.experimentComplete, false);
    assert.equal(report.diagnosticPassed, false);
    assert.equal(report.status, 'fail');
    assert.equal(report.failure, cleanupOk ? 'sample-failed' : 'cleanup-failed');
    assert.equal(snapshots.at(-1).startupSuccess, true);
    assert.equal(snapshots.at(-1).experimentComplete, false);
    assert.equal(snapshots.at(-1).diagnosticPassed, false);
  }
});

for (const protocolReason of ['invalid-frame', 'frame-control', 'incomplete-frame', 'duplicate-frame', 'unexpected-frame', 'unsupported-control', 'incomplete-control', 'invalid-utf8', 'escape-limit', 'output-limit']) test(`bounded frame reason ${protocolReason} survives sanitization`, () => {
  const value = timeout({ failure: protocolReason === 'output-limit' ? 'output-limit' : 'protocol-error', protocolReason });
  const parser = createFramedParser();
  assert.equal(parser.write('stdout', line(value)), true);
  assert.deepEqual(parser.finish(1), { measurement: value, failure: null });
});
