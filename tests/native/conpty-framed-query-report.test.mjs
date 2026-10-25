import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueryParser, runDiagnostic, runPreparedDiagnostic } from './conpty-framed-query-report.mjs';

const value = (overrides = {}) => ({
  schema: 1, mode: 'query-framed', arm: 'unqualified', q1Ms: 12.5, q2Ms: 0.25,
  startupMs: 100, hostMs: 20, wallMs: 140, versionOk: true, cwd1Ok: true, cwd2Ok: true,
  exitCode: 0, cprReplies: 1, mergedBytes: 500, startupComplete: true, complete: true,
  cleanupOk: true, failure: null, expectedStage: 'after-end', protocolReason: null,
  killRequested: false, exitObservedBeforeKill: true, readyWriteCompleted: true, readyWriteMs: 10, frameCount: 6, ...overrides,
});
const line = measurement => Buffer.from(`${JSON.stringify(measurement)}\n`);
const processResult = (overrides = {}) => ({ exitCode: 0, failure: null, outputBytes: 10,
  cleanup: { termination: 'observed', treeKill: 'not-requested', localResources: 'released' }, ...overrides });
const failed = overrides => value({ complete: false, failure: 'protocol-error', protocolReason: 'duplicate-record', exitCode: 1, ...overrides });

test('exact 25-key query frame report survives every split', () => {
  const bytes = line(value());
  for (let cut = 0; cut <= bytes.length; cut++) {
    const parser = createQueryParser('unqualified');
    assert.equal(parser.write('stdout', bytes.subarray(0, cut)), true);
    assert.equal(parser.write('stdout', bytes.subarray(cut)), true);
    assert.deepEqual(parser.finish(0), { measurement: value(), failure: null });
  }
});

for (const [name, overrides] of Object.entries({
  extra: { raw: '/private/SECRET' }, oldMode: { mode: 'startup-framed' }, schema: { schema: 2 },
  wrongArm: { arm: 'module-qualified' }, reason: { protocolReason: 'SECRET' }, stage: { expectedStage: 'SECRET' },
  badFailure: { failure: 'SECRET' }, count: { frameCount: 7 }, fractionalCount: { frameCount: 5.5 },
  missingEnd: { frameCount: 5 }, falseVersion: { versionOk: false }, falseCwd: { cwd2Ok: false },
  absentQ1: { q1Ms: null }, absentQ2: { q2Ms: null }, negativeQ: { q1Ms: -1 },
  largeQ: { q1Ms: 30001 }, sumLimit: { q1Ms: 20000, q2Ms: 10000.0001 },
  absentHost: { hostMs: null }, lateHost: { hostMs: 30001 }, lateStartup: { startupMs: 5000 },
  absentStartup: { startupMs: null }, noStartup: { startupComplete: false }, noAck: { readyWriteCompleted: false },
  lateAck: { readyWriteMs: 5000 }, ackAfterStartup: { readyWriteMs: 101 }, absentAck: { readyWriteMs: null },
  wall: { wallMs: 45001 }, nan: { wallMs: NaN }, negativeWall: { wallMs: -1 },
  cpr: { cprReplies: 65537 }, bytes: { mergedBytes: 256 * 1024 + 4097 },
  cleanup: { cleanupOk: false }, exit: { exitCode: 1 }, negativeExit: { exitCode: -1 },
  unknownKill: { killRequested: null }, killContradiction: { exitObservedBeforeKill: false },
  reasonWithoutFailure: { protocolReason: 'late-cpr' }, failureWithoutReason: { failure: 'protocol-error' },
})) test(`contradictory or private query field ${name} fails closed`, () => {
  const parser = createQueryParser('unqualified');
  assert.equal(parser.write('stdout', line(value(overrides))), false);
  assert.deepEqual(parser.finish(0), { measurement: null, failure: 'protocol-error' });
});

test('failure keeps each legitimate frame prefix without claiming query success', () => {
  const stages = ['await-frame', 'await-start-1', 'await-result-1', 'await-start-2', 'await-result-2', 'await-end', 'after-end'];
  for (let count = 0; count <= 6; count++) {
    const measurement = failed({ expectedStage: stages[count], frameCount: count,
      versionOk: count > 0, startupComplete: count > 0,
      readyWriteCompleted: count > 0, readyWriteMs: count > 0 ? 10 : null,
      q1Ms: count >= 3 ? 12.5 : null, cwd1Ok: count >= 3,
      q2Ms: count >= 5 ? 0.25 : null, cwd2Ok: count >= 5,
      hostMs: count > 0 ? 20 : null,
    });
    const parser = createQueryParser('unqualified');
    assert.equal(parser.write('stdout', line(measurement)), true);
    assert.deepEqual(parser.finish(1), { measurement, failure: null });
  }
});

test('READY frame without write acknowledgement cannot imply startup or query completion', () => {
  const measurement = failed({ failure: 'startup-timeout', protocolReason: 'startup-timeout', expectedStage: 'after-ready',
    frameCount: 1, startupMs: 5001, startupComplete: false, readyWriteCompleted: false, readyWriteMs: null,
    hostMs: null, q1Ms: null, q2Ms: null, cwd1Ok: false, cwd2Ok: false });
  const parser = createQueryParser('unqualified');
  assert.equal(parser.write('stdout', line(measurement)), true);
  assert.deepEqual(parser.finish(1), { measurement, failure: null });
});

test('exit and cleanup failures retain completed query prefix', () => {
  for (const cleanupOk of [true, false]) {
    const measurement = failed({ failure: cleanupOk ? 'exit-error' : 'cleanup-failed', protocolReason: cleanupOk ? 'exit-error' : 'cleanup-failed', cleanupOk });
    const parser = createQueryParser('unqualified');
    assert.equal(parser.write('stdout', line(measurement)), cleanupOk ? true : 'cleanup-failed');
    assert.deepEqual(parser.finish(cleanupOk ? 1 : null), { measurement, failure: null });
  }
});

test('duplicates, stderr, multiple records, invalid UTF8 and unfinished JSON never authorize success', () => {
  for (const input of [
    Buffer.from(JSON.stringify(value()).replace('"frameCount":6', '"frameCount":6,"frameCount":6') + '\n'),
    Buffer.concat([line(value()), line(value())]), Buffer.from('{"SECRET":\xff}\n', 'latin1'),
  ]) {
    const parser = createQueryParser('unqualified');
    assert.equal(parser.write('stdout', input), false);
    assert.equal(parser.finish(0).failure, 'protocol-error');
  }
  const stderr = createQueryParser('unqualified');
  assert.equal(stderr.write('stderr', Buffer.from('SECRET')), false);
  const incomplete = createQueryParser('unqualified');
  incomplete.write('stdout', Buffer.from(JSON.stringify(value())));
  assert.equal(incomplete.finish(0).failure, 'protocol-error');
});

function executeSamples(failAt = 0, failureAtExit = false) {
  const calls = [];
  return { calls, execute: async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs, outputLimit: options.outputLimit });
    if (command === 'cargo') return processResult();
    const order = calls.length - 2;
    const measurement = value({ arm: args[1] });
    if (order === failAt) Object.assign(measurement, failed({ arm: args[1], ...(failureAtExit ? { failure: 'exit-error', protocolReason: 'exit-error' } : {}) }));
    options.consume('stdout', line(measurement));
    return processResult({ exitCode: measurement.failure ? 1 : 0, failure: measurement.failure ? 'process-exit' : null });
  } };
}

test('runs only U,Q,Q,U with locked all-features build and original deadlines', async () => {
  const fixture = executeSamples();
  const report = await runDiagnostic(fixture);
  assert.equal(report.diagnosticPassed, true);
  assert.equal(report.commandSuccess, true);
  assert.equal(report.startupSuccess, true);
  assert.deepEqual(report.samples.map(sample => sample.arm), ['unqualified', 'module-qualified', 'module-qualified', 'unqualified']);
  assert.deepEqual(report.samples.map(sample => [sample.round, sample.order]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
  for (const call of fixture.calls.slice(0, 2)) {
    assert.ok(call.args.includes('--locked'));
    assert.ok(call.args.includes('--all-features'));
    assert.ok(call.timeoutMs <= 14 * 60_000);
  }
  for (const call of fixture.calls.slice(2)) {
    assert.equal(call.args[0], '--sample-framed');
    assert.equal(call.timeoutMs, 45_000);
    assert.equal(call.outputLimit, 4096);
  }
});

for (const failAt of [1, 2, 3, 4]) test(`first failed worker ${failAt} stops without retries`, async () => {
  const fixture = executeSamples(failAt, true);
  const report = await runDiagnostic(fixture);
  assert.equal(fixture.calls.length, 2 + failAt);
  assert.equal(report.samples.length, failAt);
  assert.equal(report.diagnosticPassed, false);
  assert.equal(report.startupSuccess, failAt === 4);
  assert.equal(report.commandSuccess, false);
});

test('cargo test failure prevents build and every worker', async () => {
  let calls = 0;
  const report = await runDiagnostic({ execute: async () => { calls++; return processResult({ exitCode: 101, failure: 'process-exit' }); } });
  assert.equal(calls, 1);
  assert.equal(report.failure, 'tests-failed');
  assert.equal(report.build, null);
  assert.deepEqual(report.samples, []);
});

test('prepared entry reuses failure gates and changes only fixed outer mode', async () => {
  const updates = [];
  const report = await runPreparedDiagnostic({ beforeBuild: async () => false,
    execute: async () => assert.fail('preparation failure must not execute Cargo or worker'),
    onUpdate: async value => updates.push(structuredClone(value)) });
  assert.equal(report.mode, 'query-framed-prepared');
  assert.equal(report.failure, 'dist-not-fresh');
  assert.equal(report.diagnostic, null);
  assert.ok(updates.length > 0 && updates.every(update => update.mode === 'query-framed-prepared'));
});

test('prepared success invokes query runner, keeping nested mode and every update consistent', async () => {
  const fixture = executeSamples();
  let npmCalls = 0;
  const updates = [];
  const report = await runPreparedDiagnostic({ beforeBuild: async () => true, afterBuild: async () => true,
    npmCli: async () => '/private/npm-cli.js', execute: async (command, args, options) => {
      if (command === process.execPath) { npmCalls++; assert.ok(args.includes('--logs-max=0')); return processResult(); }
      return fixture.execute(command, args, options);
    }, onUpdate: async value => updates.push(structuredClone(value)) });
  assert.equal(npmCalls, 2);
  assert.equal(report.diagnosticPassed, true);
  assert.equal(report.mode, 'query-framed-prepared');
  assert.equal(report.diagnostic.mode, 'query-framed');
  assert.equal(report.diagnostic.samples.length, 4);
  assert.ok(updates.every(update => update.mode === 'query-framed-prepared'));
  assert.equal(JSON.stringify(report).includes('/private/'), false);
});

for (const q1Ms of [0, 0.0001, 0.0003, 123.4567]) test(`F4 duration ${q1Ms} remains valid despite binary floating-point representation`, () => {
  const parser = createQueryParser('unqualified');
  const measurement = value({ q1Ms });
  assert.equal(parser.write('stdout', line(measurement)), true);
  assert.deepEqual(parser.finish(0), { measurement, failure: null });
});
for (const q1Ms of [1.00001, Infinity, NaN, 30000.0001]) test(`non-F4 or non-finite query duration ${q1Ms} is rejected`, () => {
  const parser = createQueryParser('unqualified');
  assert.equal(parser.write('stdout', line(value({ q1Ms }))), false);
});

test('sum is checked in integer F4 ticks, keeping exactly 30000 ms valid in a failed prefix', () => {
  for (const [q1Ms, q2Ms, accepted] of [[29999.9997, 0.0003, true], [29999.9998, 0.0003, false]]) {
    const parser = createQueryParser('unqualified');
    const measurement = failed({ q1Ms, q2Ms, hostMs: 30001, failure: 'command-timeout', protocolReason: 'command-timeout' });
    assert.equal(parser.write('stdout', line(measurement)), accepted);
    if (accepted) assert.deepEqual(parser.finish(1), { measurement, failure: null });
  }
});

test('setup failure retains no startup, query, CPR or cleanup invocation evidence', () => {
  const measurement = value({ q1Ms: null, q2Ms: null, startupMs: null, hostMs: null,
    versionOk: false, cwd1Ok: false, cwd2Ok: false, exitCode: null, cprReplies: 0, mergedBytes: 0,
    startupComplete: false, complete: false, failure: 'setup-error', expectedStage: 'not-started', protocolReason: 'setup-error',
    killRequested: null, exitObservedBeforeKill: null, readyWriteCompleted: false, readyWriteMs: null, frameCount: 0 });
  const parser = createQueryParser('unqualified');
  assert.equal(parser.write('stdout', line(measurement)), true);
  assert.deepEqual(parser.finish(1), { measurement, failure: null });
});

test('post-startup enqueue failure may have host time while still after-ready', () => {
  const measurement = failed({ q1Ms: null, q2Ms: null, cwd1Ok: false, cwd2Ok: false, frameCount: 1,
    expectedStage: 'after-ready', failure: 'write-error', protocolReason: 'write-error' });
  const parser = createQueryParser('unqualified');
  assert.equal(parser.write('stdout', line(measurement)), true);
});

test('report limits, trailing invalid UTF8, worker exit mismatch and caller arm are enforced', () => {
  assert.throws(() => createQueryParser('SECRET'), /Invalid query arm/);
  const huge = createQueryParser('unqualified');
  assert.equal(huge.write('stdout', Buffer.alloc(4097, 32)), false);
  const tail = createQueryParser('unqualified');
  tail.write('stdout', Buffer.concat([line(value()), Buffer.from([0xe2])]));
  assert.equal(tail.finish(0).failure, 'protocol-error');
  const mismatch = createQueryParser('unqualified');
  mismatch.write('stdout', line(value()));
  assert.equal(mismatch.finish(1).failure, 'exit-mismatch');
});

test('prepared nested query failure cannot turn successful frontend preparation into diagnostic success', async () => {
  const fixture = executeSamples(1);
  const report = await runPreparedDiagnostic({ beforeBuild: async () => true, afterBuild: async () => true,
    npmCli: async () => '/private/npm-cli.js', execute: async (command, args, options) =>
      command === process.execPath ? processResult() : fixture.execute(command, args, options) });
  assert.equal(report.preparation.distReady, true);
  assert.equal(report.mode, 'query-framed-prepared');
  assert.equal(report.failure, 'diagnostic-failed');
  assert.equal(report.diagnosticPassed, false);
  assert.equal(report.diagnostic.failure, 'sample-failed');
  assert.equal(report.diagnostic.samples.length, 1);
});
