// Persist only fixed query measurements; preparation, compiler and terminal text stays in memory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess, TIMEOUT_MS, SAMPLE_TIMEOUT_MS } from './conpty-qualified-report.mjs';
import { runDiagnostic as prepareDiagnostic } from './conpty-framed-prepared-report.mjs';

const ARMS = ['discover-query', 'import-query'];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = 'x86_64-pc-windows-msvc';
const BIN = 'powershell_conpty_qualified_probe';
const KEYS = ['schema', 'mode', 'arm', 'q1Ms', 'q2Ms', 'startupMs', 'hostMs', 'wallMs', 'versionOk', 'cwd1Ok', 'cwd2Ok', 'exitCode', 'cprReplies', 'mergedBytes', 'startupComplete', 'complete', 'cleanupOk', 'failure', 'expectedStage', 'protocolReason', 'killRequested', 'exitObservedBeforeKill', 'readyWriteCompleted', 'readyWriteMs', 'frameCount', 'prepMs', 'identityOk'];
const FAILURES = new Set(['setup-error', 'startup-timeout', 'command-timeout', 'output-limit', 'protocol-error', 'read-error', 'write-error', 'command-error', 'cwd-mismatch', 'exit-error', 'cleanup-failed', 'identity-mismatch']);
const REASONS = new Set(['invalid-frame', 'frame-control', 'incomplete-frame', 'duplicate-frame', 'unexpected-frame', 'unsupported-control', 'incomplete-control', 'invalid-utf8', 'escape-limit', 'output-limit', 'invalid-number', 'timing-bound', 'unexpected-record', 'duplicate-record', 'cwd-mismatch', 'command-error', 'setup-error', 'startup-timeout', 'command-timeout', 'read-error', 'write-error', 'exit-error', 'cleanup-failed', 'eof-before-complete', 'late-cpr', 'identity-mismatch']);
const STAGE_COUNTS = new Map([['not-started', 0], ['await-cursor', 0], ['await-frame', 0], ['after-ready', 1], ['await-prep-start', 1], ['await-prep-result', 2], ['await-start-1', 3], ['await-result-1', 4], ['await-start-2', 5], ['await-result-2', 6], ['await-end', 7], ['after-end', 8]]);

export function createPhaseParser(arm) {
  if (!ARMS.includes(arm)) throw new Error('Invalid phase arm');
  let pending = '';
  let measurement = null;
  let failure = null;
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reject = () => { failure ??= 'protocol-error'; return false; };
  const parse = line => {
    let value;
    try { value = JSON.parse(line); } catch { return reject(); }
    const keys = [...line.matchAll(/"([^"\\]*)"\s*:/g)].map(match => match[1]);
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(value, key))
      || keys.length !== KEYS.length || new Set(keys).size !== keys.length
      || value.schema !== 1 || value.mode !== 'phase-framed' || value.arm !== arm) return reject();
    const number = (input, max) => typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= max;
    const integer = (input, max) => Number.isInteger(input) && number(input, max);
    if (!STAGE_COUNTS.has(value.expectedStage) || value.frameCount !== STAGE_COUNTS.get(value.expectedStage)
      || (value.failure !== null && !FAILURES.has(value.failure))
      || (value.protocolReason !== null && !REASONS.has(value.protocolReason))) return reject();
    if (['versionOk', 'cwd1Ok', 'cwd2Ok', 'startupComplete', 'complete', 'cleanupOk', 'readyWriteCompleted'].some(key => typeof value[key] !== 'boolean')
      || ['killRequested', 'exitObservedBeforeKill', 'identityOk'].some(key => value[key] !== null && typeof value[key] !== 'boolean')) return reject();
    if (['startupMs', 'hostMs'].some(key => value[key] !== null && !number(value[key], SAMPLE_TIMEOUT_MS))
      || !number(value.wallMs, SAMPLE_TIMEOUT_MS)
      || (value.readyWriteMs !== null && !number(value.readyWriteMs, 5000))
      || !integer(value.cprReplies, 65_536) || !integer(value.mergedBytes, 256 * 1024 + 4096)
      || (value.exitCode !== null && !integer(value.exitCode, 0xffffffff))) return reject();
    for (const key of ['prepMs', 'q1Ms', 'q2Ms']) {
      if (value[key] !== null && (!number(value[key], 30_000) || Number(value[key].toFixed(4)) !== value[key])) return reject();
    }
    if (['prepMs', 'q1Ms', 'q2Ms'].reduce((sum, key) => sum + (value[key] === null ? 0 : Math.round(value[key] * 10_000)), 0) > 300_000_000) return reject();
    if (value.versionOk !== (value.frameCount >= 1)
      || (value.q1Ms !== null) !== value.cwd1Ok || value.cwd1Ok !== (value.frameCount >= 5)
      || (value.q2Ms !== null) !== value.cwd2Ok || value.cwd2Ok !== (value.frameCount >= 7)
      || value.readyWriteCompleted !== (value.readyWriteMs !== null)
      || (value.readyWriteCompleted && (value.startupMs === null || value.readyWriteMs >= 5000 || value.readyWriteMs > value.startupMs))
      || (value.killRequested === null && (value.exitObservedBeforeKill !== null || (value.expectedStage !== 'not-started' && value.cleanupOk)))
      || (value.killRequested === false && value.exitObservedBeforeKill !== true)
      || (!value.cleanupOk && value.failure !== 'cleanup-failed')
      || ((value.failure === null) !== (value.protocolReason === null))) return reject();
    if (value.expectedStage === 'not-started' && (value.startupMs !== null || value.hostMs !== null
      || value.startupComplete || value.readyWriteCompleted || value.cprReplies !== 0 || value.mergedBytes !== 0
      || value.killRequested !== null || value.protocolReason !== 'setup-error')) return reject();
    if (value.startupComplete && (!value.versionOk || !value.readyWriteCompleted || value.startupMs === null || value.startupMs >= 5000)) return reject();
    if ((!value.startupComplete && value.hostMs !== null)
      || ((value.frameCount >= 2 || value.expectedStage === 'await-prep-start') && (!value.startupComplete || value.hostMs === null))) return reject();
    if (value.complete && (!value.startupComplete || value.frameCount !== 8 || value.hostMs === null || value.hostMs >= 30_000
      || !value.cleanupOk || value.failure !== null || value.killRequested === null || value.exitCode !== 0 || value.mergedBytes > 256 * 1024)) return reject();
    if ((value.prepMs !== null) !== (value.frameCount >= 3)
      || (value.identityOk === true) !== (value.frameCount >= 3)) return reject();
    if (value.identityOk === false && (value.expectedStage !== 'await-prep-result'
      || value.protocolReason !== 'identity-mismatch')) return reject();
    if (value.protocolReason === 'identity-mismatch' && (value.expectedStage !== 'await-prep-result'
      || value.identityOk !== false || value.prepMs !== null)) return reject();
    if (value.failure === null && !value.complete) return reject();
    measurement = Object.fromEntries(KEYS.map(key => [key, value[key]]));
    return value.cleanupOk ? true : 'cleanup-failed';
  };
  return {
    write(source, chunk) {
      if (failure) return false;
      if (source !== 'stdout') return chunk.length === 0 ? true : reject();
      if (measurement && chunk.length > 0) return reject();
      bytes += chunk.length;
      if (bytes > 4096) return reject();
      try { pending += decoder.decode(chunk, { stream: true }); } catch { return reject(); }
      const newline = pending.indexOf('\n');
      if (newline === -1) return true;
      if (newline !== pending.length - 1) return reject();
      const line = pending.slice(0, -1).replace(/\r$/, '');
      pending = '';
      return parse(line);
    },
    finish(exitCode) {
      try { pending += decoder.decode(); } catch { failure ??= 'protocol-error'; }
      if (pending || !measurement) failure ??= 'protocol-error';
      if (!failure && measurement.cleanupOk && exitCode !== (measurement.failure === null ? 0 : 1)) failure = 'exit-mismatch';
      return { measurement, failure };
    },
  };
}

const healthy = process => process.failure === null && process.exitCode === 0
  && process.cleanup.termination === 'observed' && process.cleanup.localResources === 'released';

export async function runDiagnostic({ execute = runProcess, timeoutMs = TIMEOUT_MS, onUpdate = async () => {} } = {}) {
  const report = { version: 1, mode: 'phase-framed', environment: 'product-whitelist', outputMode: 'conpty-merged', stderrObservedSeparately: false,
    limitation: 'Bounded ConPTY preparation and query comparison; no pure component attribution or product acceptance',
    experimentComplete: false, startupSuccess: false, commandSuccess: false, diagnosticPassed: false,
    status: 'fail', failure: null, tests: null, build: null, samples: [] };
  const targetDir = join(ROOT, '.artifacts/p1/conpty-phase-build');
  const args = ['--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--all-features', '--bin', BIN, '--target', TARGET, '--target-dir', targetDir];
  const deadline = performance.now() + timeoutMs;
  await onUpdate(report);
  for (const [key, command] of [['tests', 'test'], ['build', 'build']]) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) { report.failure = 'build-timeout'; await onUpdate(report); return report; }
    report[key] = await execute('cargo', [command, ...args], { timeoutMs: remaining });
    if (!healthy(report[key])) report.failure = key === 'tests' ? 'tests-failed' : 'build-failed';
    await onUpdate(report);
    if (report.failure) return report;
  }
  const executable = join(targetDir, TARGET, 'debug', `${BIN}.exe`);
  for (const [index, arm] of [...ARMS, ...ARMS.toReversed()].entries()) {
    const parser = createPhaseParser(arm);
    const process = await execute(executable, ['--phase-framed', arm], { timeoutMs: SAMPLE_TIMEOUT_MS, outputLimit: 4096, consume: parser.write });
    const parsed = parser.finish(process.exitCode);
    report.samples.push({ arm, round: index < 2 ? 1 : 2, order: index % 2 + 1, process, ...parsed });
    report.experimentComplete = report.samples.length === 4 && report.samples.every(sample => sample.measurement?.complete);
    report.startupSuccess = report.samples.length === 4 && report.samples.every(sample => sample.measurement?.startupComplete);
    report.commandSuccess = report.experimentComplete && report.samples.every(sample => sample.measurement.exitCode === 0 && sample.measurement.failure === null);
    if (parsed.measurement?.cleanupOk === false) report.failure = 'cleanup-failed';
    else if (parsed.failure) report.failure = parsed.failure;
    else if (parsed.measurement?.failure) report.failure = 'sample-failed';
    else if (!healthy(process)) report.failure = 'worker-failed';
    await onUpdate(report);
    if (report.failure) return report;
  }
  report.diagnosticPassed = report.commandSuccess && report.samples.every(sample => healthy(sample.process) && !sample.failure);
  report.status = report.diagnosticPassed ? 'pass' : 'fail';
  await onUpdate(report);
  return report;
}

export async function runPreparedDiagnostic({ onUpdate = async () => {}, ...options } = {}) {
  const report = await prepareDiagnostic({ ...options, framed: runDiagnostic,
    onUpdate: value => onUpdate({ ...value, mode: 'phase-framed-prepared' }) });
  return { ...report, mode: 'phase-framed-prepared' };
}

export async function main() {
  const directory = join(ROOT, '.artifacts/p1/powershell-conpty-phase');
  await mkdir(directory, { recursive: true });
  const report = await runPreparedDiagnostic({ onUpdate: value => writeFile(join(directory, 'report.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8') });
  if (!report.diagnosticPassed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('ConPTY phase diagnostic failed\n');
  process.exitCode = 1;
});
