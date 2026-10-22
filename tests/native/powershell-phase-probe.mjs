// Test-only preparation/first-call/second-call timings; not product acceptance.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productEnvironment, summarizeStderrChunk } from './powershell-latency-probe.mjs';
import { summarizeStderrStructure } from './stderr-structure.mjs';

export const PHASE_ARMS = Object.freeze(['cold-query', 'discover-query', 'import-query']);
const LIMIT = 16_384;
function phasesFor(arm) {
  if (!PHASE_ARMS.includes(arm)) throw new Error('Invalid phase arm');
  return [...(arm === 'discover-query' ? ['discover'] : arm === 'import-query' ? ['import'] : []), 'query-1', 'query-2'];
}
export function phaseOrder(round) {
  if (round !== 1 && round !== 2) throw new Error('Invalid phase round');
  return round === 1 ? [...PHASE_ARMS] : [...PHASE_ARMS].reverse();
}
export function phaseScript(arm) {
  const stages = phasesFor(arm).map(phase => {
    const query = phase.startsWith('query-');
    let operation = '$path = (Get-Location).Path';
    if (phase === 'discover') operation = `$command = @(Get-Command -Name Get-Location -CommandType Cmdlet -ErrorAction Stop)
  if ($command.Count -ne 1 -or $command[0] -isnot [System.Management.Automation.CmdletInfo] -or $command[0].Name -cne 'Get-Location' -or $command[0].ModuleName -cne 'Microsoft.PowerShell.Management') {
    [Console]::WriteLine('P1_PHASE_ERROR|identity-mismatch')
    exit 1
  }`;
    if (phase === 'import') operation = `$module = @(Import-Module -Name Microsoft.PowerShell.Management -PassThru -ErrorAction Stop)
  if ($module.Count -ne 1 -or $module[0] -isnot [System.Management.Automation.PSModuleInfo] -or $module[0].Name -cne 'Microsoft.PowerShell.Management' -or -not $module[0].ExportedCommands.ContainsKey('Get-Location')) {
    [Console]::WriteLine('P1_PHASE_ERROR|identity-mismatch')
    exit 1
  }
  $command = $module[0].ExportedCommands['Get-Location']
  if ($command -isnot [System.Management.Automation.CmdletInfo] -or $command.Name -cne 'Get-Location' -or $command.ModuleName -cne 'Microsoft.PowerShell.Management') {
    [Console]::WriteLine('P1_PHASE_ERROR|identity-mismatch')
    exit 1
  }`;
    return `  [Console]::WriteLine('P1_PHASE_START|${phase}')
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  ${operation}
  $watch.Stop()
  [Console]::WriteLine('P1_PHASE_DONE|${phase}|' + $watch.Elapsed.TotalMilliseconds.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture) + '|' + ${query ? '[Convert]::ToBase64String($utf8.GetBytes($path))' : "'identity-ok'"})`;
  });
  return `$ErrorActionPreference = 'Stop'
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  [Console]::WriteLine('P1_PHASE_VERSION|' + $PSVersionTable.PSVersion.ToString())
${stages.join('\n')}
  [Console]::WriteLine('P1_PHASE_COMPLETE')
} catch [System.Management.Automation.CommandNotFoundException] {
  [Console]::WriteLine('P1_PHASE_ERROR|command-not-found')
  exit 1
} catch {
  [Console]::WriteLine('P1_PHASE_ERROR|script-error')
  exit 1
}
`;
}

// Complete validated prefixes survive a later timeout/error, but do not imply
// a complete sample. No unvalidated tokens or path text leave this parser.
export function parsePhaseMeasurements(text, cwd, arm, exitCode) {
  const phases = phasesFor(arm).map(phase => ({ phase, started: false, complete: false, elapsedMs: null, cwdMatches: null, identityMatches: null }));
  const result = { phases, pendingPhase: null, measurementComplete: false, observationComplete: false, failure: 'protocol-error' };
  if (Buffer.byteLength(text) > LIMIT) return result;
  const lines = text.split(/\r?\n/);
  const terminated = lines.pop() === '';
  if (!/^P1_PHASE_VERSION\|5\.1\.\d{1,10}\.\d{1,10}$/.test(lines[0] ?? '')) return result;
  let position = 1;
  let totalMs = 0;
  const errorAtPosition = () => {
    const match = /^P1_PHASE_ERROR\|(command-not-found|identity-mismatch|script-error)$/.exec(lines[position] ?? '');
    if (match && position === lines.length - 1 && terminated && exitCode !== 0) result.failure = match[1];
    return Boolean(match);
  };
  for (const phase of phases) {
    if (errorAtPosition()) return result;
    if (lines[position++] !== `P1_PHASE_START|${phase.phase}`) return result;
    phase.started = true;
    result.pendingPhase = phase.phase;
    if (errorAtPosition()) return result;
    const fields = (lines[position++] ?? '').split('|');
    if (fields.length !== 4 || fields[0] !== 'P1_PHASE_DONE' || fields[1] !== phase.phase
      || !/^\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(fields[2])) return result;
    const elapsedMs = Number(fields[2]);
    if (!Number.isFinite(elapsedMs) || elapsedMs > 60_000 || totalMs + elapsedMs > 60_000) return result;
    const query = phase.phase.startsWith('query-');
    if (query) {
      const bytes = Buffer.from(fields[3], 'base64');
      if (bytes.toString('base64') !== fields[3] || !bytes.equals(Buffer.from(cwd, 'utf8'))) return result;
    } else if (fields[3] !== 'identity-ok') return result;
    totalMs += elapsedMs;
    Object.assign(phase, { complete: true, elapsedMs, cwdMatches: query ? true : null, identityMatches: query ? null : true });
    result.pendingPhase = null;
  }
  if (errorAtPosition()) return result;
  if (!terminated || lines[position] !== 'P1_PHASE_COMPLETE' || lines.length !== position + 1 || exitCode !== 0) return result;
  return { ...result, measurementComplete: true, observationComplete: true, failure: null };
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
export async function samplePhase(executable, cwd, env, systemRoot, arm, {
  spawnProcess = spawn, processTimeoutMs = 60_000, terminationTimeoutMs = 5_000,
} = {}) {
  const script = phaseScript(arm);
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
  const parsed = parsePhaseMeasurements(Buffer.concat(stdout).toString('utf8'), cwd, arm, code);
  const progressOnly = onlyProgressRecords(bytes, structure);
  let stopReason = failure ?? parsed.failure;
  if (cleanupSucceeded === false) stopReason = 'cleanup-failed';
  if (!stopReason && bytes.length > 0 && !progressOnly) stopReason = 'stderr-format';
  const trusted = !stopReason;
  return {
    ...parsed,
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
export async function runPhaseExperiment(context, { sample = samplePhase, onSample = async () => {} } = {}) {
  const report = {
    schema: 1,
    limitation: 'Test-only stdio phase timings; preparation deliberately warms queries and is not pure discovery/loading; complete collection is not product acceptance or causal proof',
    environment: 'product-whitelist',
    limits: { rounds: 2, expectedSamples: 6, processTimeoutMs: 60_000, streamBytes: LIMIT },
    experimentComplete: false, strictPassed: false, stopReason: null, samples: [],
  };
  outer: for (let round = 1; round <= 2; round++) {
    const arms = phaseOrder(round);
    for (let index = 0; index < arms.length; index++) {
      const arm = arms[index];
      const result = await sample(context.executable, context.cwd, context.env, context.systemRoot, arm);
      report.samples.push({ arm, round, order: index + 1, ...result });
      report.stopReason = result.stopReason;
      await onSample(report);
      if (result.stopReason) break outer;
    }
  }
  report.experimentComplete = report.samples.length === 6 && report.samples.every(item => item.measurementComplete) && !report.stopReason;
  report.strictPassed = report.experimentComplete && report.samples.every(item => item.strictPassed);
  await onSample(report);
  return report;
}
export async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only diagnostic');
  const env = productEnvironment(process.env);
  const systemRoot = env.SystemRoot;
  if (!/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('Invalid system root');
  const outputDir = resolve('.artifacts/p1/powershell-phase');
  await mkdir(outputDir, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'p1 phase 中文-'));
  let report;
  const save = value => writeFile(join(outputDir, 'measurements.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    report = await runPhaseExperiment({ env, systemRoot, cwd: await realpath(directory), executable: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }, { onSample: save });
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
  main().catch(() => { process.stderr.write('PowerShell phase diagnostic failed\n'); process.exitCode = 1; });
}
