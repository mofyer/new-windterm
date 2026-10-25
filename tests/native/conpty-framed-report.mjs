// Only fixed startup measurements are persisted; build/terminal text stays in memory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess, TIMEOUT_MS, SAMPLE_TIMEOUT_MS } from './conpty-qualified-report.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = 'x86_64-pc-windows-msvc';
const BIN = 'powershell_conpty_qualified_probe';
const FAILURES = new Set(['setup-error', 'startup-timeout', 'output-limit', 'protocol-error', 'read-error', 'write-error', 'command-error', 'exit-error', 'cleanup-failed']);
const REASONS = new Set(['setup-error', 'startup-timeout', 'output-limit', 'read-error', 'write-error', 'command-error', 'exit-error', 'cleanup-failed', 'escape-limit', 'invalid-utf8', 'invalid-frame', 'frame-control', 'incomplete-frame', 'duplicate-frame', 'unexpected-frame', 'unsupported-control', 'incomplete-control', 'eof-before-complete', 'late-cpr']);
const STAGES = new Set(['not-started', 'await-cursor', 'await-frame', 'after-frame']);
const KEYS = ['schema', 'mode', 'startupMs', 'wallMs', 'versionOk', 'exitCode', 'cprReplies', 'mergedBytes', 'startupComplete', 'complete', 'cleanupOk', 'failure', 'expectedStage', 'protocolReason', 'killRequested', 'exitObservedBeforeKill', 'readyWriteCompleted', 'readyWriteMs', 'frameCount'];

export function createFramedParser() {
  let pending = '';
  let measurement = null;
  let failure = null;
  const reject = () => { failure ??= 'protocol-error'; return false; };
  const parse = line => {
    let value;
    try { value = JSON.parse(line); } catch { return reject(); }
    const keys = [...line.matchAll(/"([^"\\]*)"\s*:/g)].map(match => match[1]);
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(value, key))
      || keys.length !== KEYS.length || new Set(keys).size !== keys.length
      || value.schema !== 1 || value.mode !== 'startup-framed') return reject();
    const number = (input, max) => typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= max;
    const integer = (input, max) => Number.isInteger(input) && number(input, max);
    if (!STAGES.has(value.expectedStage) || (value.protocolReason !== null && !REASONS.has(value.protocolReason))
      || (value.failure !== null && !FAILURES.has(value.failure))) return reject();
    if (['versionOk', 'startupComplete', 'complete', 'cleanupOk', 'readyWriteCompleted'].some(key => typeof value[key] !== 'boolean')
      || ['killRequested', 'exitObservedBeforeKill'].some(key => value[key] !== null && typeof value[key] !== 'boolean')) return reject();
    if ((value.startupMs !== null && !number(value.startupMs, SAMPLE_TIMEOUT_MS))
      || !number(value.wallMs, SAMPLE_TIMEOUT_MS)
      || (value.readyWriteMs !== null && !number(value.readyWriteMs, 5000))
      || !integer(value.cprReplies, 65_536) || !integer(value.mergedBytes, 256 * 1024 + 4096)
      || !integer(value.frameCount, 1)
      || (value.exitCode !== null && !integer(value.exitCode, 0xffffffff))) return reject();
    if (value.readyWriteCompleted !== (value.readyWriteMs !== null)
      || (value.readyWriteCompleted && (value.startupMs === null || value.readyWriteMs >= 5000 || value.readyWriteMs > value.startupMs))
      || (value.killRequested === null && (value.exitObservedBeforeKill !== null
        || (value.expectedStage !== 'not-started' && value.cleanupOk)))
      || (value.killRequested === false && value.exitObservedBeforeKill !== true)
      || (!value.cleanupOk && value.failure !== 'cleanup-failed')
      || ((value.failure === null) !== (value.protocolReason === null))) return reject();
    if (value.expectedStage === 'not-started' && (value.versionOk || value.startupMs !== null
      || value.startupComplete || value.readyWriteCompleted || value.frameCount !== 0
      || value.cprReplies !== 0 || value.mergedBytes !== 0
      || value.killRequested !== null || value.protocolReason !== 'setup-error')) return reject();
    if ((value.versionOk !== (value.frameCount === 1))
      || (value.expectedStage === 'await-frame' && value.versionOk)
      || (value.expectedStage === 'after-frame' && !value.versionOk)) return reject();
    if (value.startupComplete && (!value.versionOk || !value.readyWriteCompleted || value.frameCount !== 1
      || value.expectedStage !== 'after-frame' || value.startupMs === null || value.startupMs >= 5000)) return reject();
    if (value.complete && (!value.startupComplete || !value.cleanupOk || value.failure !== null
      || value.expectedStage !== 'after-frame' || value.killRequested === null
      || value.exitCode !== 0 || value.mergedBytes > 256 * 1024)) return reject();
    if (value.failure === null && !value.complete) return reject();
    measurement = Object.fromEntries(KEYS.map(key => [key, value[key]]));
    return value.cleanupOk ? true : 'cleanup-failed';
  };
  return {
    write(source, chunk) {
      if (failure) return false;
      if (source !== 'stdout') return chunk.length === 0 ? true : reject();
      if (measurement && chunk.length > 0) return reject();
      pending += chunk.toString('utf8');
      if (pending.length > 4096) return reject();
      const newline = pending.indexOf('\n');
      if (newline === -1) return true;
      if (newline !== pending.length - 1) return reject();
      const line = pending.slice(0, -1).replace(/\r$/, '');
      pending = '';
      return parse(line);
    },
    finish(exitCode) {
      if (pending || !measurement) failure ??= 'protocol-error';
      if (!failure && measurement.cleanupOk && exitCode !== (measurement.failure === null ? 0 : 1)) failure = 'exit-mismatch';
      return { measurement, failure };
    },
  };
}

const healthy = process => process.failure === null && process.exitCode === 0
  && process.cleanup.termination === 'observed' && process.cleanup.localResources === 'released';

export async function runDiagnostic({ execute = runProcess, timeoutMs = TIMEOUT_MS, onUpdate = async () => {} } = {}) {
  const report = {
    version: 1, mode: 'startup-framed', environment: 'product-whitelist', outputMode: 'conpty-merged', stderrObservedSeparately: false,
    limitation: 'Framed startup diagnostic; no query performance or product acceptance conclusion',
    experimentComplete: false, startupSuccess: false, diagnosticPassed: false,
    status: 'fail', failure: null, tests: null, build: null, samples: [],
  };
  const targetDir = join(ROOT, '.artifacts', 'p1', 'conpty-framed-build');
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
  for (const order of [1, 2]) {
    const parser = createFramedParser();
    const process = await execute(executable, ['--startup-framed'], {
      timeoutMs: SAMPLE_TIMEOUT_MS, outputLimit: 4096, consume: parser.write,
    });
    const parsed = parser.finish(process.exitCode);
    report.samples.push({ order, process, ...parsed });
    report.experimentComplete = report.samples.length === 2 && report.samples.every(sample => sample.measurement?.complete);
    report.startupSuccess = report.samples.length === 2 && report.samples.every(sample => sample.measurement?.startupComplete);
    if (parsed.measurement?.cleanupOk === false) report.failure = 'cleanup-failed';
    else if (parsed.failure) report.failure = parsed.failure;
    else if (parsed.measurement?.failure) report.failure = 'sample-failed';
    else if (!healthy(process)) report.failure = 'worker-failed';
    await onUpdate(report);
    if (report.failure) return report;
  }
  report.diagnosticPassed = report.experimentComplete && report.startupSuccess
    && report.samples.every(sample => healthy(sample.process) && !sample.failure);
  report.status = report.diagnosticPassed ? 'pass' : 'fail';
  await onUpdate(report);
  return report;
}

export async function main() {
  const directory = join(ROOT, '.artifacts', 'p1', 'powershell-conpty-framed');
  await mkdir(directory, { recursive: true });
  const report = await runDiagnostic({ onUpdate: report => writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8') });
  if (!report.diagnosticPassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('ConPTY framed diagnostic failed\n');
  process.exitCode = 1;
});
