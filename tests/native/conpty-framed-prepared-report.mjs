// npm/compiler/terminal output stays in memory. Only bounded process evidence is saved.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from './conpty-qualified-report.mjs';
import { runDiagnostic as runFramedDiagnostic } from './conpty-framed-report.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = join(ROOT, 'apps/desktop/dist');
export const PREPARATION_TIMEOUT_MS = 180_000;

// setup-node and standard Node installations place npm beside node or under ../lib.
// Never invoke a .cmd through a shell, or persist any resolved installation paths.
export async function findNpmCli(nodeExecutable = process.execPath) {
  const nodeDirectory = dirname(await realpath(nodeExecutable));
  const candidates = [join(nodeDirectory, 'node_modules/npm'), join(nodeDirectory, '../lib/node_modules/npm')];
  for (const candidate of candidates) {
    try {
      const packageDirectory = await realpath(candidate);
      const metadata = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
      const cli = await realpath(join(packageDirectory, 'bin/npm-cli.js'));
      if (metadata.name === 'npm' && metadata.bin?.npm === 'bin/npm-cli.js'
        && cli === join(packageDirectory, 'bin/npm-cli.js') && (await lstat(cli)).isFile()) return cli;
    } catch { /* Try the other fixed installation layout without retaining error text. */ }
  }
  return null;
}

export async function freshDist(directory = DIST) {
  try { await lstat(directory); return false; } catch (error) { return error.code === 'ENOENT'; }
}
export async function readyDist(dist = DIST) {
  try {
    const directory = await lstat(dist);
    const index = await lstat(join(dist, 'index.html'));
    return directory.isDirectory() && !directory.isSymbolicLink() && index.isFile() && !index.isSymbolicLink() && index.size > 0;
  } catch { return false; }
}

const healthy = process => process.failure === null && process.exitCode === 0
  && process.cleanup.termination === 'observed' && process.cleanup.localResources === 'released';

export async function runDiagnostic({
  execute = runProcess, framed = runFramedDiagnostic, npmCli = findNpmCli,
  beforeBuild = freshDist, afterBuild = readyDist,
  preparationTimeoutMs = PREPARATION_TIMEOUT_MS, onUpdate = async () => {}, now = () => performance.now(),
} = {}) {
  const report = { version: 1, mode: 'startup-framed-prepared', phase: 'preparation', status: 'fail', failure: null,
    preparation: { dependencyInstall: null, frontendBuild: null, distReady: false }, diagnostic: null, diagnosticPassed: false };
  const deadline = now() + preparationTimeoutMs;
  await onUpdate(report);
  if (!await beforeBuild()) report.failure = 'dist-not-fresh';
  const cli = report.failure ? null : await npmCli();
  if (!report.failure && !cli) report.failure = 'npm-unavailable';
  if (!report.failure) {
    for (const [key, args, failure] of [
      ['dependencyInstall', ['ci'], 'dependency-install-failed'],
      ['frontendBuild', ['run', 'build'], 'frontend-build-failed'],
    ]) {
      const remaining = deadline - now();
      if (remaining <= 0) { report.failure = 'preparation-timeout'; break; }
      report.preparation[key] = await execute(process.execPath, [cli, '--logs-max=0', '--prefix', 'apps/desktop', ...args], { timeoutMs: remaining });
      if (!healthy(report.preparation[key])) report.failure = failure;
      await onUpdate(report);
      if (report.failure) break;
    }
  }
  if (!report.failure) {
    report.preparation.distReady = await afterBuild();
    if (!report.preparation.distReady) report.failure = 'dist-missing';
    else if (now() >= deadline) report.failure = 'preparation-timeout';
  }
  await onUpdate(report);
  if (report.failure) return report;
  report.phase = 'diagnostic';
  await onUpdate(report);
  report.diagnostic = await framed({ execute, onUpdate: async diagnostic => {
    report.diagnostic = diagnostic;
    await onUpdate(report);
  } });
  report.diagnosticPassed = report.diagnostic.diagnosticPassed === true;
  if (report.diagnosticPassed) { report.phase = 'done'; report.status = 'pass'; }
  else report.failure = 'diagnostic-failed';
  await onUpdate(report);
  return report;
}

export async function main() {
  const directory = join(ROOT, '.artifacts/p1/powershell-conpty-framed-prepared');
  await mkdir(directory, { recursive: true });
  const report = await runDiagnostic({ onUpdate: value => writeFile(join(directory, 'report.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8') });
  if (!report.diagnosticPassed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('Prepared ConPTY framed diagnostic failed\n');
  process.exitCode = 1;
});
