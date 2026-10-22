// Build/test output is consumed in memory; only fixed probe records are saved.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = 'x86_64-pc-windows-msvc';
export const TIMEOUT_MS = 14 * 60_000;
export const OUTPUT_LIMIT = 4 * 1024 * 1024;
export const ARMS = Object.freeze(['unqualified', 'module-qualified']);
export const SAMPLE_TIMEOUT_MS = 45_000;
const BIN = 'powershell_conpty_qualified_probe';
const FAILURES = new Set(['setup-error', 'startup-timeout', 'command-timeout', 'output-limit', 'protocol-error', 'read-error', 'write-error', 'command-error', 'cwd-mismatch', 'exit-error', 'cleanup-failed']);
const STAGES = new Set(['not-started', 'await-cursor', 'await-ready', 'await-start-1', 'await-result-1', 'await-start-2', 'await-result-2', 'await-end', 'after-end']);
const REASONS = new Set(['setup-error', 'startup-timeout', 'command-timeout', 'output-limit', 'line-limit', 'escape-limit', 'invalid-utf8', 'unexpected-record', 'invalid-version', 'invalid-number', 'timing-bound', 'cwd-mismatch', 'command-error', 'incomplete-marker', 'eof-before-complete', 'read-error', 'write-error', 'exit-error', 'cleanup-failed', 'late-cpr']);
const COUNTER_KEYS = ['cr', 'lf', 'csiCursor', 'csiErase', 'markerLines', 'duplicateMarkers', 'embeddedMarkerLines', 'ignoredLines'];
const SAMPLE_KEYS = ['schema', 'arm', 'q1Ms', 'q2Ms', 'startupMs', 'hostMs', 'wallMs', 'versionOk', 'cwd1Ok', 'cwd2Ok', 'exitCode', 'cprReplies', 'mergedBytes', 'complete', 'cleanupOk', 'failure', 'expectedStage', 'protocolReason', 'terminalCounters', 'killRequested', 'exitObservedBeforeKill'];

export function createSampleParser(arm) {
  if (!ARMS.includes(arm)) throw new Error('Invalid qualified arm');
  let pending = '';
  let measurement = null;
  let failure = null;
  const reject = () => { failure ??= 'protocol-error'; return false; };
  const parse = line => {
    if (measurement) return reject();
    let value;
    try { value = JSON.parse(line); } catch { return reject(); }
    const keys = [...line.matchAll(/"([^"\\]*)"\s*:/g)].map(match => match[1]);
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== SAMPLE_KEYS.length || SAMPLE_KEYS.some(key => !Object.hasOwn(value, key))
      || keys.length !== SAMPLE_KEYS.length + COUNTER_KEYS.length || new Set(keys).size !== keys.length
      || value.schema !== 2 || value.arm !== arm) return reject();
    const number = (input, max) => typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= max;
    if (!STAGES.has(value.expectedStage) || (value.protocolReason !== null && !REASONS.has(value.protocolReason))) return reject();
    const counters = value.terminalCounters;
    if (!counters || Array.isArray(counters) || typeof counters !== 'object'
      || Object.keys(counters).length !== COUNTER_KEYS.length
      || COUNTER_KEYS.some(key => !Object.hasOwn(counters, key) || !Number.isInteger(counters[key]) || !number(counters[key], 262_144))) return reject();
    if (['killRequested', 'exitObservedBeforeKill'].some(key => value[key] !== null && typeof value[key] !== 'boolean')) return reject();
    if ((value.killRequested === null && value.exitObservedBeforeKill !== null)
      || (value.killRequested === false && value.exitObservedBeforeKill !== true)) return reject();
    if (value.killRequested === null && value.expectedStage !== 'not-started' && value.cleanupOk !== false) return reject();
    for (const key of ['q1Ms', 'q2Ms', 'startupMs', 'hostMs']) {
      if (value[key] !== null && !number(value[key], SAMPLE_TIMEOUT_MS)) return reject();
    }
    if (!number(value.wallMs, SAMPLE_TIMEOUT_MS)
      || !Number.isInteger(value.cprReplies) || !number(value.cprReplies, 65_536)
      || !Number.isInteger(value.mergedBytes) || !number(value.mergedBytes, 256 * 1024 + 4096)
      || (value.exitCode !== null && (!Number.isInteger(value.exitCode) || !number(value.exitCode, 0xffffffff)))) return reject();
    if (['versionOk', 'cwd1Ok', 'cwd2Ok', 'complete', 'cleanupOk'].some(key => typeof value[key] !== 'boolean')) return reject();
    if (value.failure !== null && !FAILURES.has(value.failure)) return reject();
    if ((value.failure === null) !== (value.protocolReason === null)) return reject();
    if (!value.cleanupOk && value.failure !== 'cleanup-failed') return reject();
    if ((value.q1Ms !== null) !== value.cwd1Ok || (value.q2Ms !== null) !== value.cwd2Ok) return reject();
    if ((value.q1Ms !== null && (!value.versionOk || value.hostMs === null))
      || (value.q2Ms !== null && value.q1Ms === null)
      || (value.hostMs !== null && (!value.versionOk || value.startupMs === null))) return reject();
    if ((value.q1Ms !== null && value.q1Ms > 30_000) || (value.q2Ms !== null && value.q2Ms > 30_000)) return reject();
    if (value.q1Ms !== null && value.q2Ms !== null && value.q1Ms + value.q2Ms > 30_000) return reject();
    if (value.expectedStage === 'not-started' && (value.versionOk || value.q1Ms !== null || value.q2Ms !== null
      || value.killRequested !== null || value.exitObservedBeforeKill !== null
      || value.protocolReason !== 'setup-error' || COUNTER_KEYS.some(key => counters[key] !== 0))) return reject();
    // await-cursor is a host-side state: the unchanged parser can already have
    // seen READY in a chunk before a complete CPR request is observed.
    if (value.expectedStage === 'await-ready' && (value.versionOk || value.q1Ms !== null || value.q2Ms !== null)) return reject();
    if (['await-start-1', 'await-result-1'].includes(value.expectedStage)
      && (!value.versionOk || value.q1Ms !== null || value.q2Ms !== null)) return reject();
    if (['await-start-2', 'await-result-2'].includes(value.expectedStage)
      && (value.q1Ms === null || value.q2Ms !== null)) return reject();
    if (['await-end', 'after-end'].includes(value.expectedStage) && (value.q1Ms === null || value.q2Ms === null)) return reject();
    if (value.complete && (!value.versionOk || !value.cwd1Ok || !value.cwd2Ok || !value.cleanupOk || value.failure !== null
      || value.q1Ms === null || value.q2Ms === null || value.startupMs === null || value.hostMs === null
      || value.expectedStage !== 'after-end' || value.killRequested === null
      || value.startupMs > 5000 || value.hostMs > 30_000 || value.mergedBytes > 256 * 1024)) return reject();
    if (value.failure === null && (!value.complete || !value.cleanupOk || value.exitCode !== 0)) return reject();
    measurement = Object.fromEntries(SAMPLE_KEYS.map(key => [key, key === 'terminalCounters'
      ? Object.fromEntries(COUNTER_KEYS.map(counter => [counter, counters[counter]])) : value[key]]));
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

// A local runner is needed because the qualified protocol must stop its child
// on the first parser rejection. The older matrix runner has no abort callback.
export function runProcess(command, args, {
  spawnProcess = spawn, platform = process.platform, timeoutMs = TIMEOUT_MS,
  outputLimit = OUTPUT_LIMIT, cleanupTimeoutMs = 2_000, consume = () => true,
} = {}) {
  return new Promise(resolveProcess => {
    let child;
    let killer;
    let timer;
    let cleanupTimer;
    let stopped = false;
    let settled = false;
    let closed = false;
    let exitCode = null;
    let outputBytes = 0;
    let stopFailure = null;
    const cleanup = { termination: 'unconfirmed', treeKill: 'not-requested', localResources: 'released' };
    const release = process => {
      for (const stream of [process?.stdin, process?.stdout, process?.stderr]) {
        try { stream?.destroy(); } catch { cleanup.localResources = 'release-failed'; }
      }
      try { process?.unref(); } catch { cleanup.localResources = 'release-failed'; }
    };
    const finish = failure => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      release(child);
      release(killer);
      cleanup.termination = closed ? 'observed' : 'unconfirmed';
      resolveProcess({ exitCode, failure, outputBytes, cleanup });
    };
    const stop = failure => {
      if (settled || stopped) return;
      stopped = true;
      stopFailure = failure;
      clearTimeout(timer);
      cleanupTimer = setTimeout(() => {
        try { if (!closed) child?.kill(); } catch { /* Fixed failure only. */ }
        try { killer?.kill(); } catch { /* Fixed failure only. */ }
        finish(stopFailure);
      }, cleanupTimeoutMs);
      if (platform === 'win32' && Number.isInteger(child?.pid) && child.pid > 0) {
        try {
          killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          cleanup.treeKill = 'requested';
          killer.once('close', code => {
            if (settled) return;
            cleanup.treeKill = code === 0 ? 'completed' : 'failed';
            if (closed) finish(stopFailure);
          });
          killer.on('error', () => {
            if (settled) return;
            cleanup.treeKill = 'failed';
            if (closed) finish(stopFailure);
          });
        } catch { cleanup.treeKill = 'failed'; }
      } else {
        try { child?.kill(); } catch { /* Unconfirmed until close. */ }
      }
    };
    try {
      child = spawnProcess(command, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { finish('spawn-error'); return; }
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const source of ['stdout', 'stderr']) {
      child[source].on('error', () => stop('stream-error'));
      child[source].on('data', chunk => {
        if (settled || stopped) return;
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) { stop('output-limit'); return; }
        try {
          const result = consume(source, chunk);
          if (result === 'cleanup-failed') stop('cleanup-failed');
          else if (result === false) stop('protocol-error');
        } catch { stop('protocol-error'); }
      });
    }
    child.on('error', () => stop('spawn-error'));
    child.once('close', code => {
      closed = true;
      exitCode = Number.isInteger(code) ? code : null;
      if (!stopped) finish(code === 0 ? null : 'process-exit');
      else if (cleanup.treeKill !== 'requested') finish(stopFailure);
    });
  });
}

const healthy = process => process.failure === null && process.exitCode === 0
  && process.cleanup.termination === 'observed' && process.cleanup.localResources === 'released';

export async function runDiagnostic({ execute = runProcess, timeoutMs = TIMEOUT_MS, onUpdate = async () => {} } = {}) {
  const report = {
    version: 2, environment: 'product-whitelist', outputMode: 'conpty-merged', stderrObservedSeparately: false,
    limitation: 'Bounded interactive ConPTY comparison; diagnostic success is not product acceptance or proof of empty stderr',
    experimentComplete: false, commandSuccess: false, diagnosticPassed: false,
    status: 'fail', failure: null, tests: null, build: null, samples: [],
  };
  const targetDir = join(ROOT, '.artifacts', 'p1', 'conpty-qualified-build');
  const deadline = performance.now() + timeoutMs;
  const args = ['--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--features', 'dev-tools', '--bin', BIN, '--target', TARGET, '--target-dir', targetDir];
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
    const parser = createSampleParser(arm);
    const process = await execute(executable, ['--sample', arm], {
      timeoutMs: SAMPLE_TIMEOUT_MS, outputLimit: 4096, consume: parser.write,
    });
    const parsed = parser.finish(process.exitCode);
    report.samples.push({ arm, round: index < 2 ? 1 : 2, order: index % 2 + 1, process, ...parsed });
    if (parsed.measurement?.cleanupOk === false) report.failure = 'cleanup-failed';
    else if (parsed.failure) report.failure = parsed.failure;
    else if (parsed.measurement?.failure) report.failure = 'sample-failed';
    else if (!healthy(process)) report.failure = 'worker-failed';
    await onUpdate(report);
    if (report.failure) return report;
  }
  report.experimentComplete = report.samples.length === 4 && report.samples.every(sample => sample.measurement?.complete);
  report.commandSuccess = report.experimentComplete && report.samples.every(sample => sample.measurement.exitCode === 0 && sample.measurement.failure === null);
  report.diagnosticPassed = report.commandSuccess && report.samples.every(sample => healthy(sample.process) && sample.measurement.cleanupOk && !sample.failure);
  report.status = report.diagnosticPassed ? 'pass' : 'fail';
  await onUpdate(report);
  return report;
}

export async function main() {
  const directory = join(ROOT, '.artifacts', 'p1', 'powershell-conpty-qualified');
  await mkdir(directory, { recursive: true });
  const report = await runDiagnostic({ onUpdate: report => writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8') });
  if (!report.diagnosticPassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('ConPTY qualified diagnostic failed\n');
  process.exitCode = 1;
});
