// Diagnostic only: stdio + -EncodedCommand is not interactive ConPTY. A fast
// result cannot clear the native shell failure; a slow result can narrow it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStderrStructure } from './stderr-structure.mjs';

export const DIAGNOSTIC_ITERATIONS = 2;
export const MAX_VARIANTS = 8;

// No cmdlet executes before the first Get-Location measurement.
export const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  [Console]::WriteLine('P1_VERSION|' + $PSVersionTable.PSVersion.ToString())
  [Console]::WriteLine('P1_START|reference')
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $path = $ExecutionContext.SessionState.Path.CurrentLocation.Path
  $watch.Stop()
  [Console]::WriteLine('P1_RESULT|reference|' + $watch.Elapsed.TotalMilliseconds.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture) + '|' + [Convert]::ToBase64String($utf8.GetBytes($path)))
  [Console]::WriteLine('P1_START|first')
  $watch.Restart()
  $path = (Get-Location).Path
  $watch.Stop()
  [Console]::WriteLine('P1_RESULT|first|' + $watch.Elapsed.TotalMilliseconds.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture) + '|' + [Convert]::ToBase64String($utf8.GetBytes($path)))
  [Console]::WriteLine('P1_START|second')
  $watch.Restart()
  $path = (Get-Location).Path
  $watch.Stop()
  [Console]::WriteLine('P1_RESULT|second|' + $watch.Elapsed.TotalMilliseconds.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture) + '|' + [Convert]::ToBase64String($utf8.GetBytes($path)))
  [Console]::WriteLine('P1_DONE')
} catch {
  [Console]::WriteLine('P1_ERROR')
  exit 1
}
`;

// Mirrors local_shell.rs Windows powershell branch, including required vars.
export function productEnvironment(source) {
  const result = {};
  for (const name of ['SystemRoot', 'PATH', 'ComSpec', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
    const key = Object.keys(source).find(key => key.toUpperCase() === name.toUpperCase());
    if (key !== undefined) result[name] = source[key];
    else if (name === 'SystemRoot' || name === 'PATH') throw new Error(`Required variable missing: ${name}`);
  }
  return result;
}

function environmentKey(source, wanted) {
  return Object.keys(source).find(key => key.toUpperCase() === wanted.toUpperCase());
}

function withoutEnvironmentKey(source, wanted) {
  const result = { ...source };
  const key = environmentKey(result, wanted);
  if (key !== undefined) delete result[key];
  return result;
}

function withSourceKeys(base, source, names) {
  const result = { ...base };
  for (const name of names) {
    const key = environmentKey(source, name);
    if (key !== undefined) result[name] = source[key];
  }
  return result;
}

/**
 * Builds the bounded diagnostic environments without changing the product
 * whitelist. Each sample is spawned as a fresh process by `sample`.
 */
export function diagnosticEnvironments(source) {
  const inherited = { ...source };
  const product = productEnvironment(source);
  const parentModuleKey = environmentKey(source, 'PSModulePath');
  const productWithParentModulePath = { ...product };
  if (parentModuleKey !== undefined) productWithParentModulePath.PSModulePath = source[parentModuleKey];
  const systemPath = withSourceKeys(product, source, [
    'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'windir',
  ]);
  const identity = withSourceKeys(product, source, [
    'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'LOGONSERVER', 'SESSIONNAME', 'PUBLIC',
  ]);
  const processRuntime = withSourceKeys(product, source, [
    'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
    'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  ]);
  const explicitEmptyPsmodulepath = { ...product, PSModulePath: '' };
  return [
    { mode: 'inherited', env: inherited },
    { mode: 'product-whitelist', env: product },
    { mode: 'product-whitelist-parent-psmodulepath', env: productWithParentModulePath },
    { mode: 'inherited-without-psmodulepath', env: withoutEnvironmentKey(source, 'PSModulePath') },
    { mode: 'product-whitelist-system-path', env: systemPath },
    { mode: 'product-whitelist-identity', env: identity },
    { mode: 'product-whitelist-process-runtime', env: processRuntime },
    { mode: 'product-whitelist-explicit-empty-psmodulepath', env: explicitEmptyPsmodulepath },
  ];
}

export function diagnosticOrder(environments, iteration) {
  return iteration % 2 === 0 ? [...environments].reverse() : [...environments];
}

/** Classifies stderr in memory; raw bytes never enter the returned report. */
export function normalizeStderrText(value) {
  return value.toString().replace(/^\uFEFF/, '').replaceAll('\0', '')
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '').trim();
}

export function classifyStderrChunk(chunk) {
  const text = normalizeStderrText(Buffer.from(chunk, 'utf8'));
  if (text.length === 0) return 'empty';
  if (/^(?:At line:\s*\d+|ParserError:|NativeCommandError:)/mi.test(text)
    || /(^|\n)\s*\+\s+/.test(text)) return 'powershell-error';
  if (/^(?:WARNING|VERBOSE|DEBUG|INFORMATION|PROGRESS):/mi.test(text)) return 'powershell-stream';
  return 'unknown';
}

/**
 * Returns a bounded shape summary for an stderr chunk without retaining text.
 * Counts are deliberately structural so an unknown stream remains a failure
 * while repeated runs can be compared without exposing its contents.
 */
export function summarizeStderrChunk(chunk) {
  const bytes = Buffer.from(chunk);
  let validUtf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    validUtf8 = false;
  }
  const summary = {
    chunks: 1,
    bytes: bytes.length,
    validUtf8Bytes: validUtf8 ? bytes.length : 0,
    invalidUtf8Bytes: validUtf8 ? 0 : bytes.length,
    asciiBytes: 0,
    printableBytes: 0,
    controlBytes: 0,
    escapeBytes: 0,
    nulBytes: 0,
    newlineBytes: 0,
    carriageReturnBytes: 0,
  };
  for (const byte of bytes) {
    if (byte < 0x80) summary.asciiBytes++;
    if (byte >= 0x20 && byte !== 0x7f) summary.printableBytes++;
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) summary.controlBytes++;
    if (byte === 0x1b) summary.escapeBytes++;
    if (byte === 0x00) summary.nulBytes++;
    if (byte === 0x0a) summary.newlineBytes++;
    if (byte === 0x0d) summary.carriageReturnBytes++;
  }
  return summary;
}

function emptyStderrSummary() {
  return {
    chunks: 0,
    bytes: 0,
    validUtf8Bytes: 0,
    invalidUtf8Bytes: 0,
    asciiBytes: 0,
    printableBytes: 0,
    controlBytes: 0,
    escapeBytes: 0,
    nulBytes: 0,
    newlineBytes: 0,
    carriageReturnBytes: 0,
  };
}

function addStderrSummary(target, source) {
  for (const key of Object.keys(source)) target[key] += source[key];
}

// Retain only verified schema fields, including a valid prefix on failure.
// Unexpected output and stderr contents never enter the artifact.
export function parseMeasurements(text, expectedCwd) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const measurements = [];
  const report = { version: null, measurements, complete: false, error: null };
  const expected = ['version', 'start:reference', 'result:reference', 'start:first', 'result:first', 'start:second', 'result:second', 'done'];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const step = expected[index];
    if (line === 'P1_ERROR') { report.error = 'PowerShell script error'; break; }
    if (step === 'version' && /^P1_VERSION\|5\.1\.\d+\.\d+$/.test(line)) {
      report.version = line.slice('P1_VERSION|'.length);
    } else if (step?.startsWith('start:') && line === `P1_START|${step.slice(6)}`) {
      report.pending = step.slice(6);
    } else if (step?.startsWith('result:')) {
      const fields = line.split('|');
      const milliseconds = Number(fields[2]);
      const bytes = Buffer.from(fields[3] ?? '', 'base64');
      if (fields.length !== 4 || fields[0] !== 'P1_RESULT' || fields[1] !== step.slice(7)
        || !/^\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(fields[2])
        || !Number.isFinite(milliseconds) || milliseconds < 0
        || bytes.toString('base64') !== fields[3] || bytes.toString('utf8') !== expectedCwd) {
        report.error = 'Invalid measurement or cwd mismatch'; break;
      }
      measurements.push({ phase: fields[1], milliseconds, cwdMatches: true });
      delete report.pending;
    } else if (step === 'done' && line === 'P1_DONE') {
      report.complete = true;
    } else { report.error = 'Unexpected measurement schema'; break; }
  }
  if (report.error) report.complete = false;
  if (!report.complete && !report.error) report.error = 'Incomplete measurement sequence';
  return report;
}

async function killTree(child, systemRoot, spawnProcess, timeoutMs) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  // Only the PID returned by our own spawn is targeted. Kill the tree before
  // killing the parent so taskkill can still discover descendants.
  const killed = await new Promise(resolveKill => {
    let killer;
    let timer;
    const finish = result => { clearTimeout(timer); resolveKill(result); };
    try {
      killer = spawnProcess(win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      timer = setTimeout(() => {
        try { killer.kill(); } catch { /* Cleanup failure is reported below. */ }
        killer.unref();
        finish(false);
      }, timeoutMs);
      killer.once('error', () => finish(false));
      killer.once('close', code => finish(code === 0));
    } catch { finish(false); }
  });
  if (!killed) {
    try { child.kill(); } catch { /* Never expose OS error text or environment. */ }
  }
  return killed;
}

export async function sample(executable, cwd, env, systemRoot, {
  spawnProcess = spawn, processTimeoutMs = 60_000, terminationTimeoutMs = 5_000,
} = {}) {
  const started = performance.now();
  const child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let outputBytes = 0;
  let stderrBytes = 0;
  const stderr = { knownBytes: {}, unknownBytes: 0, unknown: false, summary: emptyStderrSummary() };
  const stderrHash = createHash('sha256');
  const stderrStructure = createStderrStructure();
  let stderrLineBuffer = Buffer.alloc(0);
  const classifyStderrLine = line => {
    const bytes = Buffer.from(line);
    const kind = classifyStderrChunk(bytes);
    if (kind === 'unknown') {
      stderr.unknown = true;
      stderr.unknownBytes += bytes.length;
      addStderrSummary(stderr.summary, summarizeStderrChunk(bytes));
    }
    else if (kind !== 'empty') stderr.knownBytes[kind] = (stderr.knownBytes[kind] ?? 0) + bytes.length;
  };
  let failure = null;
  let cleanup;
  let terminationTimer;
  let closeObserved = false;
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const arrivals = [];
  const stop = reason => {
    failure ??= reason;
    if (cleanup) return;
    cleanup = killTree(child, systemRoot, spawnProcess, terminationTimeoutMs);
    // taskkill and child.kill need not produce a close event. Bound the wait
    // independently, detach handles, and stop the run if cleanup is unproven.
    terminationTimer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolveExit({ code: null, signal: null });
    }, terminationTimeoutMs + 1_000);
  };
  const timer = setTimeout(() => stop('60 second process timeout'), processTimeoutMs);
  child.stdout.on('data', chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 16_384) { stop('Output limit exceeded'); return; }
    stdout += chunk.toString('utf8'); // Protocol is ASCII: path payloads are base64.
    arrivals.push({ milliseconds: performance.now() - started, bytes: chunk.length });
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    stderrHash.update(chunk);
    stderrStructure.push(chunk);
    stderrLineBuffer = Buffer.concat([stderrLineBuffer, chunk]);
    if (stderrLineBuffer.length > 16_384) {
      stderr.unknown = true;
      stderr.unknownBytes += stderrLineBuffer.length;
      addStderrSummary(stderr.summary, summarizeStderrChunk(stderrLineBuffer));
      stderrLineBuffer = Buffer.alloc(0);
    }
    let newline;
    let start = 0;
    while ((newline = stderrLineBuffer.indexOf(0x0a, start)) !== -1) {
      classifyStderrLine(stderrLineBuffer.subarray(start, newline + 1));
      start = newline + 1;
    }
    if (start > 0) stderrLineBuffer = stderrLineBuffer.subarray(start);
    if (stderrBytes > 16_384) stop('Stderr limit exceeded');
  });
  child.on('error', () => {
    if (child.pid) {
      // kill() may emit an error while the child remains alive. Keep the
      // termination deadline armed until close or explicit handle detachment.
      stop('Process lifecycle failure');
    } else {
      failure ??= 'Process spawn failed';
      resolveExit({ code: null, signal: null });
    }
  });
  child.once('close', (code, signal) => { closeObserved = true; resolveExit({ code, signal }); });
  const exit = await exited;
  clearTimeout(timer);
  clearTimeout(terminationTimer);
  const treeKilled = cleanup ? await cleanup : null;
  const cleanupSucceeded = cleanup ? treeKilled && closeObserved : null;
  if (stderrLineBuffer.length > 0) classifyStderrLine(stderrLineBuffer);
  const measurement = parseMeasurements(stdout, cwd);
  if (exit.code !== 0 || exit.signal || stderrBytes > 0) failure ??= 'Process exit or stderr failure';
  failure ??= measurement.error;
  return { ...measurement, exit, stderrBytes, stderr: { ...stderr, structure: stderrStructure.summarize({ complete: closeObserved && !cleanup }), sha256: stderrBytes ? stderrHash.digest('hex') : null }, outputBytes, arrivals, wallMilliseconds: performance.now() - started, passed: failure === null, failure, cleanupSucceeded };
}

export async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only diagnostic');
  const cleanEnv = productEnvironment(process.env);
  const systemRoot = cleanEnv.SystemRoot;
  if (!/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('SystemRoot must be a local absolute path');
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const outputDir = resolve('.artifacts/p1/powershell-latency');
  await mkdir(outputDir, { recursive: true });
  // PowerShell resolves Windows short-name TEMP aliases to the long path.
  const directory = await mkdtemp(join(tmpdir(), 'p1 shell 中文-'));
  const report = {
    schema: 3,
    limitation: 'stdio/-EncodedCommand, not interactive ConPTY; fast results cannot clear native failures',
    variantModes: [],
    limits: { iterations: DIAGNOSTIC_ITERATIONS, maxVariants: MAX_VARIANTS, processTimeoutMs: 60_000 },
    samples: [],
  };
  let stopReason = null;
  try {
    const cwd = await realpath(directory);
    const environments = diagnosticEnvironments(process.env);
    if (environments.length > MAX_VARIANTS) throw new Error('Diagnostic variant limit exceeded');
    report.variantModes = environments.map(({ mode }) => mode);
    samples: for (let iteration = 1; iteration <= DIAGNOSTIC_ITERATIONS; iteration++) {
      const order = diagnosticOrder(environments, iteration);
      for (let position = 0; position < order.length; position++) {
        const { mode, env } = order[position];
        const result = await sample(executable, cwd, env, systemRoot);
        report.samples.push({ mode, iteration, position: position + 1, firstSample: iteration === 1 && position === 0, ...result });
        // Save every sample, including failure, before continuing; no retries.
        await writeFile(join(outputDir, 'measurements.json'), `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`${mode} ${iteration}: ${result.passed ? 'PASS' : 'FAIL'}\n`);
        if (result.cleanupSucceeded === false) {
          stopReason = 'cleanup failure';
          process.exitCode = 1;
          break samples;
        }
      }
    }
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      report.directoryCleanupFailed = true;
      stopReason ??= 'temporary directory cleanup failure';
      process.exitCode = 1;
      await writeFile(join(outputDir, 'measurements.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  if (report.samples.length !== report.variantModes.length * DIAGNOSTIC_ITERATIONS) {
    stopReason ??= 'sample count did not reach bounded matrix';
    process.exitCode = 1;
  }
  if (report.samples.some(result => !result.passed)) {
    stopReason ??= 'one or more samples failed';
    process.exitCode = 1;
  }
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify({
    schema: 1,
    variantModes: report.variantModes,
    iterations: DIAGNOSTIC_ITERATIONS,
    expectedSamples: report.variantModes.length * DIAGNOSTIC_ITERATIONS,
    samples: report.samples.length,
    failedSamples: report.samples.filter(result => !result.passed).length,
    stopReason,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('PowerShell diagnostic failed\n'); process.exitCode = 1; });
}
