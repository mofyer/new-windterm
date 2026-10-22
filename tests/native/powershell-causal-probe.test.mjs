import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CAUSAL_ARMS, causalOrder, causalScript, parseCausalMeasurement, sampleCausal, runExperiment } from './powershell-causal-probe.mjs';

const cwd = 'C:\\private\\中文';
const env = { SystemRoot: 'C:\\Windows', PATH: 'private-env' };
const version = 'P1_CAUSAL_VERSION|5.1.20348.5622\r\n';
const success = `${version}P1_CAUSAL_RESULT|12.5|${Buffer.from(cwd).toString('base64')}\r\n`;
const progress = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress"><S>private-text</S></Obj></Objs>';
function child() {
  const value = new EventEmitter();
  Object.assign(value, { pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; }, unref() { this.unreferenced = true; } });
  return value;
}
function spawning(output = success, stderr = '', code = 0) {
  return () => {
    const process = child();
    queueMicrotask(() => { process.stdout.write(output); process.stderr.write(stderr); process.exitCode = code; process.emit('close', code, null); });
    return process;
  };
}
const sample = (arm = 'get-location', options = {}) => sampleCausal('powershell.exe', cwd, env, env.SystemRoot, arm, options);

test('bounded forward/reverse schedule has ten independent samples', () => {
  assert.equal(CAUSAL_ARMS.length, 5);
  assert.deepEqual(causalOrder(1), CAUSAL_ARMS);
  assert.deepEqual(causalOrder(2), [...CAUSAL_ARMS].reverse());
  assert.throws(() => causalOrder(3));
});
test('scripts contain no cmdlet before stopwatch and isolate treatments', () => {
  for (const arm of CAUSAL_ARMS) {
    const script = causalScript(arm);
    const prefix = script.split('$watch = [System.Diagnostics.Stopwatch]::StartNew()')[0];
    assert.doesNotMatch(prefix, /Get-\w+|Write-\w+|Import-Module|ConvertTo-/);
    assert.doesNotMatch(script, /Get-Command|Import-Module/);
    assert.equal(script.includes("$ProgressPreference = 'SilentlyContinue'"), arm === 'progress-suppressed');
    assert.equal(script.includes("$PSModuleAutoLoadingPreference = 'None'"), arm === 'autoload-disabled');
    assert.match(script, /catch \[System.Management.Automation.CommandNotFoundException\]/);
  }
  assert.doesNotMatch(causalScript('direct-location'), /Get-Location|Write-Progress/);
  assert.match(causalScript('progress-only'), /Write-Progress.*\n.*Write-Progress.*-Completed/);
  assert.throws(() => causalScript('private-unknown'));
});
test('strict measurement parsing never returns raw text or cwd', () => {
  assert.deepEqual(parseCausalMeasurement(success, cwd, 'get-location', 0), { elapsedMs: 12.5, cwdMatches: true, measurementComplete: true, observationComplete: true, observation: 'measured', failure: null });
  for (const text of [success + 'SECRET', success.replace('12.5', 'NaN'), success.replace('12.5', '-1'), success.replace('12.5', 'Infinity'), success.replace('12.5', '60001'), success.replace(Buffer.from(cwd).toString('base64'), 'YQ=='), 'P1_CAUSAL_ERROR|SECRET\n', '\ufffd']) {
    const result = parseCausalMeasurement(text, cwd, 'get-location', 0);
    assert.equal(result.measurementComplete, false);
    assert.equal(result.elapsedMs, null);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private|中文/);
  }
});
test('command-not-found is a non-timing observation only for typed designated arm and exit 2', () => {
  const token = version + 'P1_CAUSAL_ERROR|command-not-found\r\n';
  const result = parseCausalMeasurement(token, cwd, 'autoload-disabled', 2);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.observationComplete, true);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.observation, 'command-not-found');
  for (const [arm, code] of [['get-location', 2], ['autoload-disabled', 0], ['autoload-disabled', 1]]) assert.equal(parseCausalMeasurement(token, cwd, arm, code).measurementComplete, false);
  assert.equal(parseCausalMeasurement(version + 'P1_CAUSAL_ERROR|script-error\n', cwd, 'get-location', 1).failure, 'script-error');
});
test('fresh child receives fixed arguments and environment only', async () => {
  let args;
  await sample('direct-location', { spawnProcess: (...values) => { args = values; return spawning()(); } });
  assert.deepEqual(args[1].slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(args[2].env, env);
  assert.equal(args[2].cwd, cwd);
});
test('progress CLIXML completes evidence but fails strict gate, report stays private', async () => {
  const result = await sample('get-location', { spawnProcess: spawning(success, progress) });
  assert.equal(result.measurementComplete, true);
  assert.equal(result.strictPassed, false);
  assert.equal(result.stopReason, null);
  assert.equal(result.stderr.structure.streams.progress, 1);
  assert.equal(result.stderr.sha256.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /private|中文|P1_CAUSAL_RESULT|CLIXML/);
});
test('every nonempty stderr fails closed and unrecognized/nonprogress streams stop', async () => {
  for (const stderr of [' ', 'SECRET', progress.replace('progress', 'error'), progress + 'SECRET', progress.replace('</Objs>', ''), progress.replace('</Objs>', '<S>SECRET</S></Objs>'), progress.replace('</Objs>', '<Obj><S S="error">SECRET</S></Obj></Objs>')]) {
    const result = await sample('get-location', { spawnProcess: spawning(success, stderr) });
    assert.equal(result.strictPassed, false);
    assert.equal(result.stopReason, 'stderr-format');
  }
});
test('spawn and protocol errors use fixed categories', async () => {
  const failed = await sample('get-location', { spawnProcess() { throw Error('SECRET'); } });
  assert.equal(failed.stopReason, 'spawn-error');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
  const invalid = await sample('get-location', { spawnProcess: spawning('SECRET', '', 0) });
  assert.equal(invalid.stopReason, 'protocol-error');
});
test('timeout cleanup targets child tree, bounds unconfirmed termination and stops', async () => {
  const process = child();
  const calls = [];
  const result = await sample('get-location', { processTimeoutMs: 5, terminationTimeoutMs: 5, spawnProcess(executable, args) {
    calls.push([executable, args]);
    if (calls.length === 1) return process;
    return child();
  } });
  assert.equal(result.stopReason, 'cleanup-failed');
  assert.equal(result.failure, 'timeout');
  assert.equal(result.cleanupSucceeded, false);
  assert.deepEqual(calls[1][1], ['/PID', '123', '/T', '/F']);
  assert.equal(process.stdout.destroyed, true);
  assert.equal(process.stderr.destroyed, true);
  assert.equal(process.unreferenced, true);
});
test('output caps stop child and report bounded shape without payload', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const process = child();
    let calls = 0;
    const result = await sample('get-location', { terminationTimeoutMs: 5, spawnProcess() {
      if (++calls > 1) { const killer = child(); queueMicrotask(() => { killer.emit('close', 0); process.emit('close', 1, null); }); return killer; }
      queueMicrotask(() => process[stream].write(Buffer.alloc(20_000, 65)));
      return process;
    } });
    assert.equal(result.failure, `${stream}-limit`);
    assert.equal(result.strictPassed, false);
    assert.equal(result.stderr.shape.bytes <= 16_384, true);
    assert.doesNotMatch(JSON.stringify(result), /AAAA/);
  }
});
test('experiment has no retries, distinguishes complete collection and strict gate', async () => {
  const calls = [];
  const result = await runExperiment({ executable: 'ps', cwd, env, systemRoot: env.SystemRoot }, { sample: async (...args) => {
    calls.push(args[4]);
    return { measurementComplete: true, observationComplete: true, strictPassed: false, stopReason: null };
  } });
  assert.deepEqual(calls, [...CAUSAL_ARMS, ...[...CAUSAL_ARMS].reverse()]);
  assert.equal(result.experimentComplete, true);
  assert.equal(result.strictPassed, false);
  assert.equal(result.samples.length, 10);
});
test('experiment stops immediately on unsafe lifecycle or protocol result', async () => {
  let count = 0;
  const report = await runExperiment({ executable: 'ps', cwd, env, systemRoot: env.SystemRoot }, { sample: async () => { count++; return { measurementComplete: false, strictPassed: false, stopReason: 'timeout' }; } });
  assert.equal(count, 1);
  assert.equal(report.experimentComplete, false);
  assert.equal(report.stopReason, 'timeout');
});

test('version, duplicate records, wrong exits and trailing bytes fail protocol', () => {
  for (const text of [success.replace('5.1.', '7.1.'), success + success, success + '\n', success.replace(version, ''), success.replace('12.5', '1e999')]) {
    assert.equal(parseCausalMeasurement(text, cwd, 'get-location', 0).observationComplete, false);
  }
  for (const code of [1, 2, null]) assert.equal(parseCausalMeasurement(success, cwd, 'get-location', code).measurementComplete, false);
});
test('typed autoload failure completes observation but never records fast timing', async () => {
  const result = await sample('autoload-disabled', { spawnProcess: spawning(version + 'P1_CAUSAL_ERROR|command-not-found\r\n', progress, 2) });
  assert.equal(result.measurementComplete, false);
  assert.equal(result.observationComplete, true);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.cwdMatches, null);
  assert.equal(Number.isFinite(result.wallMilliseconds) && result.wallMilliseconds >= 0, true);
  assert.equal(result.strictPassed, false);
  assert.equal(result.stopReason, null);
});
test('root annotation coverage cannot be spoofed inside attribute values or nested nodes', async () => {
  for (const xml of [
    progress.replace('</Objs>', '<Obj N=" S=\'progress\'">SECRET</Obj></Objs>'),
    progress.replace('<S>private-text</S>', '<S S="error">SECRET</S>'),
    progress.replace('</Objs>', '<S/>\n</Objs>'),
  ]) {
    const result = await sample('get-location', { spawnProcess: spawning(success, xml) });
    assert.equal(result.stopReason, 'stderr-format');
  }
});
test('repeated process/killer errors remain bounded and release other handles after destroy failure', async () => {
  const process = child();
  const killer = child();
  process.stdout.destroy = () => { throw Error('PRIVATE'); };
  let calls = 0;
  const result = await sample('get-location', { processTimeoutMs: 5, terminationTimeoutMs: 5, spawnProcess() {
    if (++calls === 1) return process;
    queueMicrotask(() => {
      process.emit('error', Error('PRIVATE'));
      process.emit('error', Error('PRIVATE'));
      killer.emit('error', Error('PRIVATE'));
      killer.emit('error', Error('PRIVATE'));
    });
    return killer;
  } });
  assert.equal(result.stopReason, 'cleanup-failed');
  assert.equal(result.cleanupSucceeded, false);
  assert.equal(process.stderr.destroyed, true);
  assert.equal(process.unreferenced, true);
  assert.equal(killer.unreferenced, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('stderr truncation and unobserved close cannot trust a complete captured XML', async () => {
  const process = child();
  let calls = 0;
  const result = await sample('get-location', { processTimeoutMs: 5, terminationTimeoutMs: 5, spawnProcess() {
    if (++calls === 1) { queueMicrotask(() => { process.stdout.write(success); process.stderr.write(progress); }); return process; }
    const killer = child();
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  } });
  assert.equal(result.stderr.structure.status, 'truncated');
  assert.equal(result.observationComplete, false);
  assert.equal(result.stopReason, 'cleanup-failed');
});

test('repeated pipe errors stop safely and late cleanup errors remain absorbed', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const process = child();
    let calls = 0;
    const result = await sample('get-location', { terminationTimeoutMs: 5, spawnProcess() {
      if (++calls === 1) {
        queueMicrotask(() => { process[stream].emit('error', Error('PRIVATE')); process[stream].emit('error', Error('PRIVATE')); });
        return process;
      }
      const killer = child();
      queueMicrotask(() => { killer.emit('close', 0); process.emit('close', 1, null); });
      return killer;
    } });
    assert.equal(result.failure, 'process-error');
    assert.equal(result.stopReason, 'process-error');
    assert.equal(result.cleanupSucceeded, true);
    assert.equal(result.strictPassed, false);
    process[stream].emit('error', Error('PRIVATE'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});
