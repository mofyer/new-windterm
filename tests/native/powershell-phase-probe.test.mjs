import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { PHASE_ARMS, phaseOrder, phaseScript, parsePhaseMeasurements, samplePhase, runPhaseExperiment } from './powershell-phase-probe.mjs';

const cwd = 'C:\\private\\中文';
const env = { SystemRoot: 'C:\\Windows', PATH: 'private-env' };
const version = 'P1_PHASE_VERSION|5.1.20348.5622';
const encoded = Buffer.from(cwd).toString('base64');
const phaseNames = arm => [...(arm === 'discover-query' ? ['discover'] : arm === 'import-query' ? ['import'] : []), 'query-1', 'query-2'];
const lines = arm => [version, ...phaseNames(arm).flatMap(phase => [`P1_PHASE_START|${phase}`, `P1_PHASE_DONE|${phase}|12.5|${phase.startsWith('query-') ? encoded : 'identity-ok'}`]), 'P1_PHASE_COMPLETE'];
const success = arm => lines(arm).join('\r\n') + '\r\n';
const progress = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress"><S>private-text</S></Obj></Objs>';
function child() {
  const value = new EventEmitter();
  Object.assign(value, { pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; }, unref() { this.unreferenced = true; } });
  return value;
}
function spawning(output = success('cold-query'), stderr = '', code = 0) {
  return () => {
    const process = child();
    queueMicrotask(() => { process.stdout.write(output); process.stderr.write(stderr); process.exitCode = code; process.emit('close', code, null); });
    return process;
  };
}
const sample = (arm = 'cold-query', options = {}) => samplePhase('powershell.exe', cwd, env, env.SystemRoot, arm, options);

test('schedule uses three arms forward then reverse, six fresh samples', () => {
  assert.deepEqual(PHASE_ARMS, ['cold-query', 'discover-query', 'import-query']);
  assert.deepEqual(phaseOrder(1), PHASE_ARMS);
  assert.deepEqual(phaseOrder(2), [...PHASE_ARMS].reverse());
  assert.throws(() => phaseOrder(3));
});
test('each script has only its registered preparation and fixed identity check', () => {
  for (const arm of PHASE_ARMS) {
    const script = phaseScript(arm);
    const prefix = script.split("[Console]::WriteLine('P1_PHASE_START|")[0];
    assert.doesNotMatch(prefix, /Get-\w+|Write-\w+|Import-Module|ConvertTo-/);
    assert.equal((script.match(/\(Get-Location\)\.Path/g) ?? []).length, 2);
    assert.equal(script.includes('Get-Command -Name Get-Location -CommandType Cmdlet -ErrorAction Stop'), arm === 'discover-query');
    assert.equal(script.includes('Import-Module -Name Microsoft.PowerShell.Management -PassThru -ErrorAction Stop'), arm === 'import-query');
    assert.doesNotMatch(script, /ProgressPreference|PSModuleAutoLoadingPreference|Get-Module/);
    if (arm !== 'cold-query') assert.match(script, /identity-mismatch/);
  }
  assert.throws(() => phaseScript('SECRET'));
});
test('all registered phase sequences parse and publish only fixed identities and cwd booleans', () => {
  for (const arm of PHASE_ARMS) {
    const result = parsePhaseMeasurements(success(arm), cwd, arm, 0);
    assert.equal(result.measurementComplete, true);
    assert.equal(result.observationComplete, true);
    assert.equal(result.failure, null);
    assert.deepEqual(result.phases.map(item => item.phase), phaseNames(arm));
    for (const item of result.phases) {
      assert.equal(item.complete, true);
      assert.equal(item.elapsedMs, 12.5);
      assert.equal(item.cwdMatches, item.phase.startsWith('query-') ? true : null);
      assert.equal(item.identityMatches, item.phase.startsWith('query-') ? null : true);
    }
    assert.doesNotMatch(JSON.stringify(result), /private|中文|identity-ok|Microsoft/);
  }
});
test('timeout/incomplete stream retains only fully validated completed phase prefix', () => {
  const partial = lines('discover-query').slice(0, 4).join('\n') + '\n';
  const result = parsePhaseMeasurements(partial, cwd, 'discover-query', null);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.phases[0].complete, true);
  assert.equal(result.phases[0].elapsedMs, 12.5);
  assert.equal(result.phases[1].started, true);
  assert.equal(result.phases[1].elapsedMs, null);
  assert.equal(result.phases[2].started, false);
  assert.equal(result.pendingPhase, 'query-1');
});
test('missing COMPLETE or a truncated final line never completes sample', () => {
  const text = success('cold-query');
  for (const value of [text.slice(0, -1), text.replace('P1_PHASE_COMPLETE\r\n', ''), text.replace('P1_PHASE_COMPLETE\r\n', 'P1_PHASE_COM')]) {
    const result = parsePhaseMeasurements(value, cwd, 'cold-query', 0);
    assert.equal(result.measurementComplete, false);
    assert.equal(result.phases[1].complete, true);
  }
  const incompleteDone = lines('cold-query').slice(0, 2).join('\n') + '\nP1_PHASE_DONE|query-1|12.5|' + encoded;
  assert.equal(parsePhaseMeasurements(incompleteDone, cwd, 'cold-query', 0).phases[0].elapsedMs, null);
});
test('protocol rejects duplicate, reorder, wrong version/identity/cwd/timing and trailing data', () => {
  const text = success('discover-query');
  for (const value of [
    text.replace('5.1.', '7.1.'), text + 'SECRET\n', text + '\n', text + text,
    text.replace('P1_PHASE_START|discover', 'P1_PHASE_START|import'),
    text.replace('identity-ok', 'identity-failed'), text.replace(encoded, 'YQ=='),
    text.replace('12.5', '-1'), text.replace('12.5', 'NaN'), text.replace('12.5', '1e999'),
    text.replace('12.5', '60001'), text.replaceAll('12.5', '30001'),
    text.replace('P1_PHASE_DONE|discover|12.5|identity-ok', 'P1_PHASE_ERROR|script-error\r\nP1_PHASE_DONE|discover|12.5|identity-ok'),
  ]) {
    const result = parsePhaseMeasurements(value, cwd, 'discover-query', 0);
    assert.equal(result.measurementComplete, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private|中文|identity-failed/);
  }
  assert.equal(parsePhaseMeasurements(text, cwd, 'cold-query', 0).measurementComplete, false);
  assert.equal(parsePhaseMeasurements(text, cwd, 'discover-query', 1).measurementComplete, false);
});
test('all script errors stop, command-not-found has no observation exception', () => {
  for (const category of ['command-not-found', 'identity-mismatch', 'script-error']) {
    const value = `${version}\nP1_PHASE_START|discover\nP1_PHASE_ERROR|${category}\n`;
    const result = parsePhaseMeasurements(value, cwd, 'discover-query', 1);
    assert.equal(result.failure, category);
    assert.equal(result.measurementComplete, false);
    assert.equal(result.phases[0].elapsedMs, null);
  }
});
test('spawn receives fixed arguments/environment and reports wall separately', async () => {
  let args;
  const result = await sample('cold-query', { spawnProcess: (...values) => { args = values; return spawning()(); } });
  assert.deepEqual(args[1].slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(args[2].env, env);
  assert.equal(args[2].cwd, cwd);
  assert.equal(Number.isFinite(result.wallMilliseconds) && result.wallMilliseconds >= 0, true);
  assert.equal(result.strictPassed, true);
  assert.equal(typeof result.observationComplete, 'boolean');
  assert.equal(result.observationComplete, true);
});
test('complete progress evidence may continue but any stderr fails strict gate', async () => {
  const result = await sample('cold-query', { spawnProcess: spawning(success('cold-query'), progress) });
  assert.equal(result.measurementComplete, true);
  assert.equal(result.strictPassed, false);
  assert.equal(result.stopReason, null);
  assert.equal(result.stderr.structure.streams.progress, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|中文|P1_PHASE|CLIXML/);
});
test('unknown or uncovered/nested stream records stop without source disclosure', async () => {
  for (const stderr of [' ', 'SECRET', progress.replace('progress', 'error'), progress + 'SECRET', progress.replace('</Objs>', '<S>SECRET</S></Objs>'), progress.replace('<S>private-text</S>', '<S S="error">SECRET</S>'), progress.replace('</Objs>', '<Obj N=" S=\'progress\'">SECRET</Obj></Objs>')]) {
    const result = await sample('cold-query', { spawnProcess: spawning(success('cold-query'), stderr) });
    assert.equal(result.strictPassed, false);
    assert.equal(result.stopReason, 'stderr-format');
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});
test('timeout retains verified prefix but stops with bounded unconfirmed cleanup', async () => {
  const process = child();
  const calls = [];
  const result = await sample('discover-query', { processTimeoutMs: 5, terminationTimeoutMs: 5, spawnProcess(executable, args) {
    calls.push([executable, args]);
    if (calls.length === 1) { queueMicrotask(() => process.stdout.write(lines('discover-query').slice(0, 4).join('\n') + '\n')); return process; }
    return child();
  } });
  assert.equal(result.stopReason, 'cleanup-failed');
  assert.equal(result.failure, 'timeout');
  assert.equal(result.cleanupSucceeded, false);
  assert.deepEqual(calls[1][1], ['/PID', '123', '/T', '/F']);
  assert.equal(process.stdout.destroyed, true);
  assert.equal(process.stderr.destroyed, true);
  assert.equal(process.unreferenced, true);
  assert.equal(result.phases[0].complete, true);
  assert.equal(result.phases[1].elapsedMs, null);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.stderr.structure.status, 'truncated');
});
test('both output caps stop immediately without retaining excess payload', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const process = child();
    let calls = 0;
    const result = await sample('cold-query', { terminationTimeoutMs: 5, spawnProcess() {
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
test('repeated process/killer errors and throwing destroy release remaining handles', async () => {
  const process = child();
  const killer = child();
  process.stdout.destroy = () => { throw Error('SECRET'); };
  let calls = 0;
  const result = await sample('cold-query', { processTimeoutMs: 5, terminationTimeoutMs: 5, spawnProcess() {
    if (++calls === 1) return process;
    queueMicrotask(() => { process.emit('error', Error('SECRET')); process.emit('error', Error('SECRET')); killer.emit('error', Error('SECRET')); killer.emit('error', Error('SECRET')); });
    return killer;
  } });
  assert.equal(result.stopReason, 'cleanup-failed');
  assert.equal(process.stderr.destroyed, true);
  assert.equal(process.unreferenced, true);
  assert.equal(killer.unreferenced, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
test('repeated pipe errors and late errors are absorbed while collection stops', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const process = child();
    let calls = 0;
    const result = await sample('cold-query', { terminationTimeoutMs: 5, spawnProcess() {
      if (++calls === 1) { queueMicrotask(() => { process[stream].emit('error', Error('SECRET')); process[stream].emit('error', Error('SECRET')); }); return process; }
      const killer = child();
      queueMicrotask(() => { killer.emit('close', 0); process.emit('close', 1, null); });
      return killer;
    } });
    assert.equal(result.failure, 'process-error');
    assert.equal(result.cleanupSucceeded, true);
    process[stream].emit('error', Error('SECRET'));
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});
test('experiment runs six fresh samples without retries and distinguishes strict failure', async () => {
  const calls = [];
  const result = await runPhaseExperiment({ executable: 'ps', cwd, env, systemRoot: env.SystemRoot }, { sample: async (...args) => {
    calls.push(args[4]);
    return { measurementComplete: true, strictPassed: false, stopReason: null };
  } });
  assert.deepEqual(calls, [...PHASE_ARMS, ...[...PHASE_ARMS].reverse()]);
  assert.equal(result.experimentComplete, true);
  assert.equal(result.strictPassed, false);
});
test('unexpected failure stops platform immediately', async () => {
  let count = 0;
  const report = await runPhaseExperiment({ executable: 'ps', cwd, env, systemRoot: env.SystemRoot }, { sample: async () => { count++; return { measurementComplete: false, strictPassed: false, stopReason: 'command-not-found' }; } });
  assert.equal(count, 1);
  assert.equal(report.experimentComplete, false);
  assert.equal(report.stopReason, 'command-not-found');
});

test('spawn failures cannot leak errors or report observations', async () => {
  const result = await sample('cold-query', { spawnProcess() { throw Error('SECRET'); } });
  assert.equal(result.failure, 'spawn-error');
  assert.equal(result.observationComplete, false);
  assert.equal(result.phases.every(phase => phase.elapsedMs === null), true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
test('close failure after completed phases cannot convert prefix into complete observation', async () => {
  const result = await sample('cold-query', { spawnProcess: spawning(success('cold-query'), '', 1) });
  assert.equal(result.phases.every(phase => phase.complete), true);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.observationComplete, false);
  assert.equal(result.strictPassed, false);
  assert.equal(result.stopReason, 'protocol-error');
});
test('malicious binary/truncated lines cannot produce a completed stage or raw output', () => {
  for (const tail of ['P1_PHASE_DONE|query-1|12.5|' + encoded, 'P1_PHASE_DONE|query-1|12.5|' + encoded + '\ufffd\n', '\u0000SECRET\n']) {
    const result = parsePhaseMeasurements(`${version}\nP1_PHASE_START|query-1\n${tail}`, cwd, 'cold-query', null);
    assert.equal(result.phases[0].complete, false);
    assert.equal(result.phases[0].elapsedMs, null);
    assert.equal(result.observationComplete, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private|中文|\ufffd/);
  }
});
