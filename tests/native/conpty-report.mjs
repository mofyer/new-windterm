// Consume compiler/probe output in memory. Only allowlisted measurements leave
// this process; never log a child error, command, path, or original output line.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODES = Object.freeze([
  'inherited', 'product-whitelist', 'product-whitelist-parent-psmodulepath',
  'inherited-without-psmodulepath', 'product-whitelist-system-path',
  'product-whitelist-identity', 'product-whitelist-process-runtime',
  'product-whitelist-explicit-empty-psmodulepath',
]);
export const TIMEOUT_MS = 14 * 60_000;
export const OUTPUT_LIMIT = 4 * 1024 * 1024;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = 'x86_64-pc-windows-msvc';
const SUMMARY = 'PowerShell ConPTY probe failed: one or more ConPTY samples failed';
const NUMBER = '(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?';
const PASS = new RegExp(`^PASS mode=(${MODES.join('|')}) iteration=([12]) inner_ms=(${NUMBER}) host_ms=(${NUMBER})$`);
const FAIL = new RegExp(`^FAIL mode=(${MODES.join('|')}) iteration=([12]): PowerShell ConPTY marker timed out$`);

export function createProbeParser() {
  const pending = { stdout: '', stderr: '' };
  const samples = [];
  const seen = new Set();
  const lastIndex = { stdout: -1, stderr: -1 };
  const sampleIndex = sample => sample.iteration === 1 ? MODES.indexOf(sample.mode) : 15 - MODES.indexOf(sample.mode);
  let failure = null;
  let summary = false;
  const reject = reason => { failure ??= reason; };
  const line = (source, value) => {
    if (value === SUMMARY && source === 'stderr') {
      if (summary) reject('duplicate-summary');
      summary = true;
      return;
    }
    const match = (source === 'stdout' ? PASS : FAIL).exec(value);
    if (!match) { reject('unknown-probe-output'); return; }
    const mode = match[1];
    const iteration = Number(match[2]);
    const key = `${mode}:${iteration}`;
    if (seen.has(key)) { reject('duplicate-sample'); return; }
    if (samples.length >= 16) { reject('extra-sample'); return; }
    // Separate stdout/stderr pipes have no shared arrival ordering. Validate
    // each stream's subsequence, then sort the complete set for the report.
    const index = sampleIndex({ mode, iteration });
    if (index <= lastIndex[source]) reject('sample-order');
    lastIndex[source] = index;
    if (summary && source === 'stderr') reject('sample-after-summary');
    seen.add(key);
    if (source === 'stdout') {
      const inner_ms = Number(match[3]);
      const host_ms = Number(match[4]);
      if (!Number.isFinite(inner_ms) || !Number.isFinite(host_ms)) { reject('invalid-timing'); return; }
      samples.push({ mode, iteration, status: 'pass', inner_ms, host_ms });
    } else {
      samples.push({ mode, iteration, status: 'fail', failure: 'marker-timeout' });
    }
  };
  return {
    write(source, chunk) {
      // A line is bounded independently from the process-wide output budget.
      const text = pending[source] + chunk.toString('utf8');
      pending[source] = '';
      const lines = text.split('\n');
      const tail = lines.pop();
      for (const value of lines) {
        if (value.length > 8192) reject('line-limit');
        else line(source, value.replace(/\r$/, ''));
      }
      if (tail.length > 8192) reject('line-limit');
      else pending[source] = tail;
    },
    finish(exitCode) {
      for (const source of ['stdout', 'stderr']) {
        if (pending[source]) line(source, pending[source].replace(/\r$/, ''));
        pending[source] = '';
      }
      if (samples.length !== 16) reject('missing-samples');
      const failedSamples = samples.some(sample => sample.status === 'fail');
      if (summary !== failedSamples) reject('summary-mismatch');
      if (exitCode !== (failedSamples ? 1 : 0)) reject('exit-mismatch');
      if (failedSamples) reject('sample-failed');
      samples.sort((left, right) => sampleIndex(left) - sampleIndex(right));
      return { status: failure ? 'fail' : 'pass', failure, samples };
    },
  };
}

export function runProcess(command, args, {
  spawnProcess = spawn, platform = process.platform, timeoutMs = TIMEOUT_MS,
  outputLimit = OUTPUT_LIMIT, consume = () => {},
} = {}) {
  return new Promise(resolve => {
    let child;
    let timer;
    let cleanupTimer;
    let stopping = false;
    let settled = false;
    let exitCode = null;
    let closed = false;
    let outputBytes = 0;
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
      cleanup.termination = closed ? 'observed' : 'unconfirmed';
      resolve({ exitCode, failure, outputBytes, cleanup });
    };
    const stop = failure => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      let killer;
      let cleaning = false;
      const complete = () => {
        if (settled || cleaning) return;
        cleaning = true;
        try { if (!closed) child?.kill(); } catch { /* termination remains unconfirmed */ }
        try { killer?.kill(); } catch { /* helper termination is unconfirmed */ }
        release(killer);
        finish(failure);
      };
      cleanupTimer = setTimeout(complete, 2000);
      // Killing cargo alone can orphan rustc or the probe. Request a bounded
      // Windows tree kill, with no helper stdout/stderr inherited by this job.
      if (platform === 'win32' && Number.isInteger(child?.pid) && child.pid > 0) {
        try {
          killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          cleanup.treeKill = 'requested';
          killer.once('close', code => { if (!settled) { cleanup.treeKill = code === 0 ? 'completed' : 'failed'; complete(); } });
          killer.on('error', () => { if (!settled) { cleanup.treeKill = 'failed'; complete(); } });
        } catch { cleanup.treeKill = 'failed'; complete(); }
      } else {
        try { child?.kill(); } catch { /* retain unconfirmed termination */ }
        // Give close a bounded chance to confirm termination before releasing.
      }
    };
    try {
      child = spawnProcess(command, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { finish('spawn-error'); return; }
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const source of ['stdout', 'stderr']) child[source].on('data', chunk => {
      if (settled || stopping) return;
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) { stop('output-limit'); return; }
      consume(source, chunk);
    });
    child.on('error', () => stop('spawn-error'));
    child.once('close', code => {
      closed = true;
      exitCode = Number.isInteger(code) ? code : null;
      if (!stopping) finish(code === 0 ? null : 'process-exit');
    });
  });
}

export async function runDiagnostic({ execute = runProcess, timeoutMs = TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  const targetDir = join(ROOT, '.artifacts', 'p1', 'conpty-build');
  // Explicit target and target-dir override Cargo environment/config defaults.
  // Only a successful build permits execution of this exact target's binary.
  const build = await execute('cargo', ['build', '--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--features', 'dev-tools', '--bin', 'powershell_conpty_probe', '--target', TARGET, '--target-dir', targetDir], { timeoutMs });
  if (build.failure || build.exitCode !== 0) return { version: 1, status: 'fail', failure: 'build-failed', build, probe: null };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { version: 1, status: 'fail', failure: 'timeout', build, probe: null };
  const parser = createProbeParser();
  const process = await execute(join(targetDir, TARGET, 'debug', 'powershell_conpty_probe.exe'), [], { timeoutMs: remaining, consume: parser.write });
  const parsed = parser.finish(process.exitCode);
  const probe = { ...process, ...parsed, failure: process.failure ?? parsed.failure };
  probe.status = probe.failure ? 'fail' : 'pass';
  return { version: 1, status: probe.status, failure: probe.failure ? 'probe-failed' : null, build, probe };
}

export async function main() {
  const report = await runDiagnostic();
  const directory = join(ROOT, '.artifacts', 'p1', 'powershell-conpty');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('ConPTY sanitized diagnostic failed\n');
  process.exitCode = 1;
});
