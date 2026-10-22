// Test-only interventions under one fixed environment; never a product gate.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productEnvironment, summarizeStderrChunk } from './powershell-latency-probe.mjs';
import { summarizeStderrStructure } from './stderr-structure.mjs';

export const CAUSAL_ARMS = Object.freeze(['direct-location', 'progress-only', 'get-location', 'progress-suppressed', 'autoload-disabled']);
const LIMIT = 16_384;
export function causalOrder(round) {
  if (round !== 1 && round !== 2) throw new Error('Invalid causal round');
  return round === 1 ? [...CAUSAL_ARMS] : [...CAUSAL_ARMS].reverse();
}
export function causalScript(arm) {
  if (!CAUSAL_ARMS.includes(arm)) throw new Error('Invalid causal arm');
  const treatment = arm === 'progress-suppressed' ? "$ProgressPreference = 'SilentlyContinue'" : arm === 'autoload-disabled' ? "$PSModuleAutoLoadingPreference = 'None'" : '';
  const operation = arm === 'direct-location' ? '$path = $ExecutionContext.SessionState.Path.CurrentLocation.Path' : arm === 'progress-only' ? `Write-Progress -Activity 'P1_CAUSAL_FIXED' -Status 'P1_CAUSAL_FIXED' -PercentComplete 50
  Write-Progress -Activity 'P1_CAUSAL_FIXED' -Completed
  $path = $ExecutionContext.SessionState.Path.CurrentLocation.Path` : '$path = (Get-Location).Path';
  return `$ErrorActionPreference = 'Stop'
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  [Console]::WriteLine('P1_CAUSAL_VERSION|' + $PSVersionTable.PSVersion.ToString())
  ${treatment}
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  ${operation}
  $watch.Stop()
  [Console]::WriteLine('P1_CAUSAL_RESULT|' + $watch.Elapsed.TotalMilliseconds.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture) + '|' + [Convert]::ToBase64String($utf8.GetBytes($path)))
} catch [System.Management.Automation.CommandNotFoundException] {
  [Console]::WriteLine('P1_CAUSAL_ERROR|command-not-found')
  exit 2
} catch {
  [Console]::WriteLine('P1_CAUSAL_ERROR|script-error')
  exit 1
}
`;
}
export function parseCausalMeasurement(text, cwd, arm, exitCode) {
  const result = { elapsedMs: null, cwdMatches: null, measurementComplete: false, observationComplete: false, observation: null, failure: 'protocol-error' };
  const match = /^P1_CAUSAL_VERSION\|5\.1\.\d{1,10}\.\d{1,10}\r?\n([^\r\n]+)\r?\n$/.exec(text);
  if (!match) return result;
  if (match[1] === 'P1_CAUSAL_ERROR|command-not-found') {
    if (arm === 'autoload-disabled' && exitCode === 2) return { ...result, observationComplete: true, observation: 'command-not-found', failure: null };
    return { ...result, failure: 'unexpected-command-not-found' };
  }
  if (match[1] === 'P1_CAUSAL_ERROR|script-error') return { ...result, failure: 'script-error' };
  const fields = /^P1_CAUSAL_RESULT\|(\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)\|([A-Za-z0-9+/]*={0,2})$/.exec(match[1]);
  if (!fields || exitCode !== 0) return result;
  const elapsedMs = Number(fields[1]);
  const path = Buffer.from(fields[2], 'base64');
  if (!Number.isFinite(elapsedMs) || elapsedMs > 60_000 || path.toString('base64') !== fields[2]
    || !path.equals(Buffer.from(cwd, 'utf8'))) return result;
  return { elapsedMs, cwdMatches: true, measurementComplete: true, observationComplete: true, observation: 'measured', failure: null };
}

// The structural summary counts annotated records, but does not establish that
// every root record is annotated. Require coverage before continuing collection.
function onlyProgressRecords(bytes, structure) {
  if (structure.status !== 'clixml' || structure.streams.progress < 1
    || Object.entries(structure.streams).some(([key, count]) => key !== 'progress' && count !== 0)) return false;
  let depth = 0;
  const tags = bytes.toString('utf8').matchAll(/<\/?[A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/g);
  for (const [tag] of tags) {
    if (tag.startsWith('</')) { depth--; continue; }
    const attributes = [...tag.matchAll(/\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)];
    const stream = attributes.find(attribute => attribute[1] === 'S');
    if (depth === 1 && (!stream || (stream[2] ?? stream[3]).toLowerCase() !== 'progress')) return false;
    if (depth > 1 && stream) return false;
    if (!tag.endsWith('/>')) depth++;
  }
  return depth === 0;
}

// The child PID comes only from this spawn. Cleanup is bounded independently of
// child close so a failed taskkill cannot strand the diagnostic runner.
async function killTree(child, systemRoot, spawnProcess, timeoutMs) {
  if (!child.pid) return false;
  return new Promise(resolveKill => {
    let killer;
    let timer;
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) {
        try { child.kill(); } catch { /* Fixed failure only. */ }
        try { killer?.kill(); } catch { /* Fixed failure only. */ }
        try { killer?.unref(); } catch { /* Fixed failure only. */ }
      }
      resolveKill(ok);
    };
    try {
      killer = spawnProcess(win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      timer = setTimeout(() => finish(false), timeoutMs);
      killer.on('error', () => finish(false));
      killer.once('close', code => finish(code === 0));
    } catch { finish(false); }
  });
}
export async function sampleCausal(executable, cwd, env, systemRoot, arm, {
  spawnProcess = spawn, processTimeoutMs = 60_000, terminationTimeoutMs = 5_000,
} = {}) {
  const script = causalScript(arm);
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let child;
  let failure = null;
  let cleanup;
  let terminationTimer;
  let closeObserved = false;
  let stopped = false;
  let resourcesReleased = true;
  let code = null;
  let resolveExit;
  const exited = new Promise(resolveExitPromise => { resolveExit = resolveExitPromise; });
  const detach = () => {
    for (const stream of [child.stdout, child.stderr]) {
      try { stream?.destroy(); } catch { resourcesReleased = false; }
    }
    try { child.unref?.(); } catch { resourcesReleased = false; }
  };
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    failure = reason;
    cleanup = killTree(child, systemRoot, spawnProcess, terminationTimeoutMs);
    terminationTimer = setTimeout(() => { detach(); resolveExit(); }, terminationTimeoutMs + 1_000);
  };
  let timer;
  const started = performance.now();
  try {
    child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    timer = setTimeout(() => stop('timeout'), processTimeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', () => {
        if (!closeObserved && !stopped) stop('process-error');
      });
    }
    child.stdout.on('data', chunk => {
      if (stopped) return;
      const value = Buffer.from(chunk);
      stdout.push(value.subarray(0, Math.max(0, LIMIT - stdoutBytes)));
      stdoutBytes += value.length;
      if (stdoutBytes > LIMIT) stop('stdout-limit');
    });
    child.stderr.on('data', chunk => {
      if (stopped) return;
      const value = Buffer.from(chunk);
      stderr.push(value.subarray(0, Math.max(0, LIMIT - stderrBytes)));
      stderrBytes += value.length;
      if (stderrBytes > LIMIT) stop('stderr-limit');
    });
    child.on('error', () => {
      if (closeObserved || stopped) return;
      if (child.pid) stop('process-error');
      else { stopped = true; failure = 'spawn-error'; detach(); resolveExit(); }
    });
    child.once('close', (exitCode, signal) => {
      closeObserved = true;
      code = Number.isInteger(exitCode) ? exitCode : null;
      if (signal) failure ??= 'process-error';
      resolveExit();
    });
    await exited;
  } catch {
    if (child?.pid) { stop('process-error'); await exited; }
    else failure = 'spawn-error';
  }
  clearTimeout(timer);
  clearTimeout(terminationTimer);
  const cleanupSucceeded = cleanup ? (await cleanup) && closeObserved && resourcesReleased : null;
  const wallMilliseconds = performance.now() - started;
  const bytes = Buffer.concat(stderr);
  const structure = summarizeStderrStructure(bytes, { truncated: stderrBytes > LIMIT, complete: closeObserved && !stopped });
  const parsed = parseCausalMeasurement(Buffer.concat(stdout).toString('utf8'), cwd, arm, code);
  const progressOnly = onlyProgressRecords(bytes, structure);
  let stopReason = failure ?? parsed.failure;
  if (cleanupSucceeded === false) stopReason = 'cleanup-failed';
  if (!stopReason && bytes.length > 0 && !progressOnly) stopReason = 'stderr-format';
  const trusted = !stopReason;
  return {
    ...parsed,
    elapsedMs: trusted ? parsed.elapsedMs : null,
    cwdMatches: trusted ? parsed.cwdMatches : null,
    measurementComplete: trusted && parsed.measurementComplete,
    observationComplete: trusted && parsed.observationComplete,
    exitCode: code,
    wallMilliseconds,
    stdoutBytes,
    stderr: { shape: summarizeStderrChunk(bytes), sha256: bytes.length ? createHash('sha256').update(bytes).digest('hex') : null, structure },
    strictPassed: trusted && parsed.measurementComplete && code === 0 && stderrBytes === 0,
    failure: failure ?? parsed.failure,
    cleanupSucceeded,
    stopReason,
  };
}
export async function runExperiment(context, { sample = sampleCausal, onSample = async () => {} } = {}) {
  const report = {
    schema: 1,
    limitation: 'Test-only stdio interventions; collection complete is not product acceptance or causal proof; fresh processes do not reset machine caches',
    environment: 'product-whitelist',
    limits: { rounds: 2, expectedSamples: 10, processTimeoutMs: 60_000, streamBytes: LIMIT },
    experimentComplete: false, strictPassed: false, stopReason: null, samples: [],
  };
  outer: for (let round = 1; round <= 2; round++) {
    const arms = causalOrder(round);
    for (let index = 0; index < arms.length; index++) {
      const arm = arms[index];
      const result = await sample(context.executable, context.cwd, context.env, context.systemRoot, arm);
      report.samples.push({ arm, round, order: index + 1, ...result });
      report.stopReason = result.stopReason;
      await onSample(report);
      if (result.stopReason) break outer;
    }
  }
  report.experimentComplete = report.samples.length === 10 && report.samples.every(item => item.observationComplete) && !report.stopReason;
  report.strictPassed = report.experimentComplete && report.samples.every(item => item.strictPassed);
  await onSample(report);
  return report;
}
export async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only diagnostic');
  const env = productEnvironment(process.env);
  const systemRoot = env.SystemRoot;
  if (!/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('Invalid system root');
  const outputDir = resolve('.artifacts/p1/powershell-causal');
  await mkdir(outputDir, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'p1 causal 中文-'));
  let report;
  const save = value => writeFile(join(outputDir, 'measurements.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    report = await runExperiment({ env, systemRoot, cwd: await realpath(directory), executable: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }, { onSample: save });
  } finally {
    try { await rm(directory, { recursive: true, force: true }); }
    catch {
      if (report) { report.stopReason = 'directory-cleanup-failed'; report.experimentComplete = false; report.strictPassed = false; await save(report); }
      process.exitCode = 1;
    }
  }
  if (!report?.strictPassed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('PowerShell causal diagnostic failed\n'); process.exitCode = 1; });
}
