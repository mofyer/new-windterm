import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ARMS, createSampleParser, runDiagnostic, runProcess } from './conpty-qualified-report.mjs';

function child() {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => true;
  process.unref = () => { process.unrefed = true; };
  return process;
}

test('runner never serializes compiler output or spawn exceptions', async () => {
  const process = child();
  const promise = runProcess('cargo', [], { spawnProcess: () => process });
  process.stdout.write('Compiling /private/SECRET');
  process.stderr.write('Error C:\\private\\SECRET');
  process.emit('close', 101);
  const report = await promise;
  assert.equal(report.failure, 'process-exit');
  assert.equal(report.cleanup.termination, 'observed');
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private|Compiling/);
  const failed = await runProcess('cargo', [], { spawnProcess: () => { throw new Error('/private/SECRET'); } });
  assert.equal(failed.failure, 'spawn-error');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET|private/);
});

for (const trigger of ['timeout', 'output-limit', 'protocol-error']) test(`first ${trigger} requests tree kill and remains failed`, async () => {
  const process = child();
  process.pid = 123;
  const helper = child();
  const calls = [];
  const promise = runProcess('probe', [], {
    platform: 'win32', timeoutMs: trigger === 'timeout' ? 5 : 1000, cleanupTimeoutMs: 30,
    outputLimit: trigger === 'output-limit' ? 2 : 1000,
    consume: () => trigger !== 'protocol-error',
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) return process;
      queueMicrotask(() => { process.emit('close', 1); helper.emit('close', 0); });
      return helper;
    },
  });
  if (trigger !== 'timeout') process.stdout.write('SECRET');
  const report = await promise;
  assert.equal(report.failure, trigger);
  assert.equal(report.cleanup.treeKill, 'completed');
  assert.equal(report.cleanup.termination, 'observed');
  assert.equal(process.stdout.destroyed, true);
  assert.equal(process.unrefed, true);
  assert.deepEqual(calls[1].args, ['/PID', '123', '/T', '/F']);
  assert.equal(calls[1].options.stdio, 'ignore');
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test('throwing protocol consumer is bounded and does not leak details', async () => {
  const process = child();
  process.kill = () => { process.emit('close', 0); return true; };
  const promise = runProcess('probe', [], { platform: 'darwin', spawnProcess: () => process, consume: () => { throw new Error('SECRET'); } });
  process.stdout.write('x');
  const report = await promise;
  assert.equal(report.failure, 'protocol-error');
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test('tree helper completion does not claim child termination without close', async () => {
  const process = child();
  process.pid = 123;
  const helper = child();
  let calls = 0;
  const report = await runProcess('probe', [], {
    timeoutMs: 5, cleanupTimeoutMs: 10, platform: 'win32',
    spawnProcess: () => {
      if (calls++ === 0) return process;
      queueMicrotask(() => helper.emit('close', 0));
      return helper;
    },
  });
  assert.equal(report.failure, 'timeout');
  assert.equal(report.cleanup.treeKill, 'completed');
  assert.equal(report.cleanup.termination, 'unconfirmed');
  assert.equal(process.unrefed, true);
});

test('hung helper and kill errors retain bounded failure and release resources', async () => {
  const process = child();
  process.pid = 123;
  process.kill = () => { process.emit('error', new Error('/private/SECRET')); return false; };
  const helper = child();
  helper.kill = () => { helper.emit('error', new Error('/private/SECRET')); return false; };
  let calls = 0;
  const report = await runProcess('probe', [], {
    timeoutMs: 5, cleanupTimeoutMs: 10, platform: 'win32', spawnProcess: () => calls++ === 0 ? process : helper,
  });
  assert.equal(report.failure, 'timeout');
  assert.equal(report.cleanup.termination, 'unconfirmed');
  assert.equal(helper.unrefed, true);
  assert.equal(process.stderr.destroyed, true);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private/);
});

const measurement = (arm = ARMS[0], overrides = {}) => ({
  schema: 2, arm, q1Ms: 123, q2Ms: 0.2, startupMs: 44, hostMs: 124, wallMs: 170,
  versionOk: true, cwd1Ok: true, cwd2Ok: true, exitCode: 0, cprReplies: 1,
  mergedBytes: 100, complete: true, cleanupOk: true, failure: null,
  expectedStage: 'after-end', protocolReason: null,
  terminalCounters: { cr: 3, lf: 3, csiCursor: 0, csiErase: 0, markerLines: 6, duplicateMarkers: 0, embeddedMarkerLines: 0, ignoredLines: 1 },
  killRequested: false, exitObservedBeforeKill: true, ...overrides,
});
const line = value => Buffer.from(`${JSON.stringify(value)}\n`);
const processResult = (exitCode = 0, failure = null) => ({ exitCode, failure, outputBytes: 0, cleanup: { termination: 'observed', treeKill: 'not-requested', localResources: 'released' } });

test('fixed sample schema accepts chunked JSON without retaining raw protocol', () => {
  const parser = createSampleParser(ARMS[0]);
  const data = line(measurement());
  for (let i = 0; i < data.length; i += 7) assert.equal(parser.write('stdout', data.subarray(i, i + 7)), true);
  assert.deepEqual(parser.finish(0), { measurement: measurement(), failure: null });
});

test('schema 2 rejects unknown diagnostic fields, enums and non-bounded counters without retaining them', () => {
  const counters = measurement().terminalCounters;
  const { cr: _cr, ...missingCounter } = counters;
  for (const overrides of [
    { expectedStage: '/private/SECRET' }, { protocolReason: '/private/SECRET' },
    { terminalCounters: { ...counters, path: '/private/SECRET' } }, { terminalCounters: missingCounter },
    ...[-1, 0.5, 262_145, '/private/SECRET'].map(cr => ({ terminalCounters: { ...counters, cr } })),
    { killRequested: 'SECRET' }, { exitObservedBeforeKill: 'SECRET' },
    { killRequested: null, exitObservedBeforeKill: true },
    { complete: false, failure: 'exit-error', protocolReason: 'exit-error', killRequested: null, exitObservedBeforeKill: null },
    { killRequested: false, exitObservedBeforeKill: false },
    { killRequested: false, exitObservedBeforeKill: null },
  ]) {
    const parser = createSampleParser(ARMS[0]);
    assert.equal(parser.write('stdout', line(measurement(ARMS[0], overrides))), false);
    assert.deepEqual(parser.finish(0), { measurement: null, failure: 'protocol-error' });
  }
  const duplicate = JSON.stringify(measurement()).replace('"cr":3', '"cr":3,"cr":3');
  const parser = createSampleParser(ARMS[0]);
  assert.equal(parser.write('stdout', Buffer.from(`${duplicate}\n`)), false);
  assert.deepEqual(parser.finish(0), { measurement: null, failure: 'protocol-error' });
});

test('first failure context survives cleanup failure and unknown kill history', () => {
  for (const [killRequested, exitObservedBeforeKill] of [[null, null], [false, true], [true, true], [true, false], [true, null]]) {
    const value = measurement(ARMS[0], {
      complete: false, cleanupOk: false, failure: 'cleanup-failed', protocolReason: 'unexpected-record',
      expectedStage: 'await-result-2', q2Ms: null, cwd2Ok: false, exitCode: null,
      killRequested, exitObservedBeforeKill,
      terminalCounters: { ...measurement().terminalCounters, cr: 262_144 },
    });
    const parser = createSampleParser(ARMS[0]);
    assert.equal(parser.write('stdout', line(value)), 'cleanup-failed');
    assert.deepEqual(parser.finish(null), { measurement: value, failure: null });
  }
});

test('setup failures and cursor waits preserve supported diagnostic states', () => {
  for (const [expectedStage, versionOk, startupMs, protocolReason] of [
    ['not-started', false, null, 'setup-error'],
    ['await-cursor', false, 5001, 'startup-timeout'],
    ['await-cursor', true, 5001, 'startup-timeout'],
    ['await-ready', false, 5001, 'startup-timeout'],
  ]) {
    const value = measurement(ARMS[0], {
      complete: false, failure: protocolReason, protocolReason, expectedStage, versionOk, startupMs,
      q1Ms: null, q2Ms: null, cwd1Ok: false, cwd2Ok: false, hostMs: null, exitCode: null,
      killRequested: expectedStage === 'not-started' ? null : true,
      exitObservedBeforeKill: expectedStage === 'not-started' ? null : false,
      terminalCounters: Object.fromEntries(Object.keys(measurement().terminalCounters).map(key => [key, 0])),
    });
    const parser = createSampleParser(ARMS[0]);
    assert.equal(parser.write('stdout', line(value)), true);
    assert.deepEqual(parser.finish(1), { measurement: value, failure: null });
  }
});

test('stage and verified query prefixes cannot contradict each other', () => {
  for (const overrides of [
    { expectedStage: 'not-started' }, { expectedStage: 'await-ready' },
    { expectedStage: 'await-start-1' }, { expectedStage: 'await-result-1' },
    { expectedStage: 'await-start-2' }, { expectedStage: 'await-result-2' },
    { expectedStage: 'await-end', q2Ms: null, cwd2Ok: false },
    { expectedStage: 'after-end', q1Ms: null, cwd1Ok: false, q2Ms: null, cwd2Ok: false },
    { complete: true, expectedStage: 'await-end', failure: null, protocolReason: null },
    { protocolReason: null },
  ]) {
    const parser = createSampleParser(ARMS[0]);
    assert.equal(parser.write('stdout', line(measurement(ARMS[0], {
      complete: false, failure: 'protocol-error', protocolReason: 'unexpected-record', ...overrides,
    }))), false);
    assert.equal(parser.finish(1).measurement, null);
  }
});

for (const [name, overrides] of Object.entries({
  extra: { path: '/private/SECRET' }, arm: { arm: 'SECRET' }, version: { schema: 1 },
  range: { q1Ms: 45_001 }, total: { q1Ms: 20_000, q2Ms: 20_000 },
  negative: { wallMs: -1 }, huge: { wallMs: Infinity }, integer: { cprReplies: 0.5 },
  capacity: { mergedBytes: 256 * 1024 + 4097 }, failure: { failure: 'SECRET' },
  contradiction: { complete: true, failure: 'protocol-error' },
  identity: { versionOk: false }, cleanup: { cleanupOk: false }, missingtime: { q1Ms: null },
  prefix: { complete: false, failure: 'command-timeout', q1Ms: null, cwd1Ok: false },
  cwd: { cwd2Ok: false }, singlelimit: { complete: false, failure: 'command-timeout', q1Ms: 30_001, q2Ms: null, cwd2Ok: false },
  startup: { startupMs: 5001 }, host: { hostMs: 30_001 },
})) test(`invalid ${name} rejects immediately with fixed failure only`, () => {
  const parser = createSampleParser(ARMS[0]);
  assert.equal(parser.write('stdout', line(measurement(ARMS[0], overrides))), false);
  const result = parser.finish(0);
  assert.equal(result.failure, 'protocol-error');
  assert.equal(result.measurement, null);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private/);
});

test('unknown stderr, duplicate records, missing newline and malformed bytes fail', () => {
  for (const action of [
    parser => parser.write('stderr', Buffer.from('/private/SECRET')),
    parser => { parser.write('stdout', line(measurement())); parser.write('stdout', line(measurement())); },
    parser => parser.write('stdout', Buffer.from(JSON.stringify(measurement()))),
    parser => parser.write('stdout', Buffer.from('{SECRET}\n')),
    parser => parser.write('stdout', Buffer.from(JSON.stringify(measurement()).replace('"schema":2', '"schema":2,"schema":2') + '\n')),
    parser => parser.write('stdout', Buffer.alloc(4097, 0xff)),
  ]) {
    const parser = createSampleParser(ARMS[0]);
    action(parser);
    const result = parser.finish(0);
    assert.equal(result.failure, 'protocol-error');
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private/);
  }
});

test('cleanup-failed record requests immediate termination while retaining verified prefix', () => {
  const value = measurement(ARMS[0], { complete: false, cleanupOk: false, failure: 'cleanup-failed', protocolReason: 'cleanup-failed', exitCode: null });
  const parser = createSampleParser(ARMS[0]);
  assert.equal(parser.write('stdout', line(value)), 'cleanup-failed');
  assert.deepEqual(parser.finish(null), { measurement: value, failure: null });
});

test('exit status must agree with valid worker record', () => {
  for (const exitCode of [1, 101, null]) {
    const parser = createSampleParser(ARMS[0]);
    parser.write('stdout', line(measurement()));
    assert.equal(parser.finish(exitCode).failure, 'exit-mismatch');
  }
  const parser = createSampleParser(ARMS[0]);
  parser.write('stdout', line(measurement(ARMS[0], { complete: false, failure: 'command-timeout', protocolReason: 'command-timeout', expectedStage: 'await-result-2', q2Ms: null, cwd2Ok: false, exitCode: null })));
  assert.equal(parser.finish(1).failure, null);
});

test('Windows stream errors stop the exact child with no raw exception', async () => {
  const process = child();
  process.pid = 123;
  const helper = child();
  let calls = 0;
  const promise = runProcess('probe', [], {
    platform: 'win32', cleanupTimeoutMs: 20, spawnProcess: () => {
      if (calls++ === 0) return process;
      queueMicrotask(() => { helper.emit('close', 0); process.emit('close', 1); });
      return helper;
    },
  });
  process.stdout.emit('error', new Error('/private/SECRET'));
  const result = await promise;
  assert.equal(result.failure, 'stream-error');
  assert.equal(result.cleanup.treeKill, 'completed');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private/);
});

test('tests and build precede four exact fresh workers in forward/reverse order', async () => {
  const calls = [];
  const snapshots = [];
  const report = await runDiagnostic({ onUpdate: async report => snapshots.push(JSON.parse(JSON.stringify(report))), execute: async (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length <= 2) return processResult();
    assert.equal(options.consume('stdout', line(measurement(args[1]))), true);
    return processResult();
  } });
  assert.equal(calls.length, 6);
  assert.equal(calls[0].args[0], 'test');
  assert.equal(calls[1].args[0], 'build');
  for (const call of calls.slice(0, 2)) {
    assert.ok(call.args.includes('--locked'));
    assert.ok(call.args.includes('dev-tools'));
    assert.ok(call.args.includes('powershell_conpty_qualified_probe'));
    assert.ok(call.args.includes('x86_64-pc-windows-msvc'));
    assert.equal(call.options.consume, undefined);
  }
  assert.deepEqual(calls.slice(2).map(call => call.args), [...ARMS, ...ARMS.toReversed()].map(arm => ['--sample', arm]));
  assert.match(calls[2].command, /conpty-qualified-build[/\\]x86_64-pc-windows-msvc[/\\]debug[/\\]powershell_conpty_qualified_probe\.exe$/);
  assert.equal(calls[2].options.timeoutMs, 45_000);
  assert.equal(report.experimentComplete, true);
  assert.equal(report.commandSuccess, true);
  assert.equal(report.diagnosticPassed, true);
  assert.equal(report.stderrObservedSeparately, false);
  assert.equal(report.version, 2);
  assert.equal(snapshots[0].samples.length, 0);
  assert.equal(snapshots.at(-1).samples.length, 4);
});

test('historical schema 1 cannot start another worker or enter a schema 2 report', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async (_command, args, options) => {
    calls++;
    if (calls <= 2) return processResult();
    assert.equal(options.consume('stdout', line(measurement(args[1], { schema: 1 }))), false);
    return processResult(1, 'protocol-error');
  } });
  assert.equal(calls, 3);
  assert.equal(report.version, 2);
  assert.equal(report.failure, 'protocol-error');
  assert.equal(report.samples.length, 1);
  assert.equal(report.samples[0].measurement, null);
  assert.equal(report.experimentComplete, false);
});

test('failing Rust unit tests prevent build and experiment', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async () => { calls++; return processResult(101, 'process-exit'); } });
  assert.equal(calls, 1);
  assert.equal(report.failure, 'tests-failed');
  assert.equal(report.build, null);
  assert.equal(report.samples.length, 0);
});

test('failed build cannot run a stale worker', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async () => ++calls === 1 ? processResult() : processResult(101, 'process-exit') });
  assert.equal(calls, 2);
  assert.equal(report.failure, 'build-failed');
  assert.equal(report.samples.length, 0);
});

test('first failed worker stops platform while retaining earlier successful samples', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async (_command, args, options) => {
    calls++;
    if (calls <= 2) return processResult();
    const failed = calls === 4;
    options.consume('stdout', line(measurement(args[1], failed ? { complete: false, failure: 'command-timeout', protocolReason: 'command-timeout', expectedStage: 'await-result-2', q2Ms: null, cwd2Ok: false, exitCode: null } : {})));
    return processResult(failed ? 1 : 0, failed ? 'process-exit' : null);
  } });
  assert.equal(calls, 4);
  assert.equal(report.samples.length, 2);
  assert.equal(report.samples[0].measurement.complete, true);
  assert.equal(report.failure, 'sample-failed');
  assert.equal(report.experimentComplete, false);
});

test('cleanup-failed worker preserves classification and no next worker starts', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async (_command, args, options) => {
    if (++calls <= 2) return processResult();
    assert.equal(options.consume('stdout', line(measurement(args[1], { complete: false, cleanupOk: false, failure: 'cleanup-failed', protocolReason: 'cleanup-failed' }))), 'cleanup-failed');
    return processResult(null, 'cleanup-failed');
  } });
  assert.equal(calls, 3);
  assert.equal(report.failure, 'cleanup-failed');
  assert.equal(report.samples[0].measurement.failure, 'cleanup-failed');
});
