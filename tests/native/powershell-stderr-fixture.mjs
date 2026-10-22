// Isolated Windows PowerShell stderr fixture. The report is deliberately
// content-free: it contains only case names, counts, byte shapes and hashes.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STDERR_TIMEOUT_MS = 30_000;
export const STDERR_CAPTURE_LIMIT = 16 * 1024;

export const STDERR_CASES = Object.freeze({
  warning: "Write-Warning -Message 'FIXTURE_WARNING'",
  error: "Write-Error -Message 'FIXTURE_ERROR' -ErrorAction Continue",
  empty: '$null = 1',
  unknown: "[Console]::Error.WriteLine('FIXTURE_UNKNOWN')",
});

export const EXPECTED = Object.freeze({
  // Windows PowerShell 5.1 emits host-wrapped warning/error records for these
  // commands. The wrapper is deliberately retained as unknown evidence until
  // its structure is separately decoded; this fixture must not bless it.
  warning: { classification: 'unknown', exitCode: 0 },
  error: { classification: 'unknown', exitCode: 1 },
  empty: { classification: 'empty', exitCode: 0 },
  unknown: { classification: 'unknown', exitCode: 0 },
});

export function classify(text) {
  const value = text.replace(/^\uFEFF/, '').replaceAll('\0', '').replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '').trim();
  if (!value) return 'empty';
  if (/^(?:At line:\s*\d+|ParserError:|NativeCommandError:|Write-Error:)/mi.test(value) || /(^|\n)\s*\+\s+/.test(value)) return 'powershell-error';
  if (/^(?:WARNING|VERBOSE|DEBUG|INFORMATION|PROGRESS):/mi.test(value)) return 'powershell-stream';
  return 'unknown';
}

export function shape(bytes) {
  const result = { bytes: bytes.length, asciiBytes: 0, printableBytes: 0, controlBytes: 0, newlineBytes: 0, carriageReturnBytes: 0 };
  for (const byte of bytes) {
    if (byte < 0x80) result.asciiBytes++;
    if (byte >= 0x20 && byte !== 0x7f) result.printableBytes++;
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) result.controlBytes++;
    if (byte === 0x0a) result.newlineBytes++;
    if (byte === 0x0d) result.carriageReturnBytes++;
  }
  return result;
}

export function runCase(name, command, { spawnProcess = spawn, timeoutMs = STDERR_TIMEOUT_MS } = {}) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Continue'; ${command}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    } catch {
      resolve({ name, exitCode: null, failure: 'spawn-error', stderr: { classifications: { unknown: 1 }, shape: shape(Buffer.alloc(0)), totalBytes: 0, capturedBytes: 0, truncated: false, sha256: null } });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let captured = 0;
    let truncated = false;
    const hash = createHash('sha256');
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stderr.on('data', chunk => {
      if (settled) return;
      const value = Buffer.from(chunk);
      bytes += value.length;
      hash.update(value);
      const remaining = Math.max(0, STDERR_CAPTURE_LIMIT - captured);
      if (remaining > 0) {
        chunks.push(value.subarray(0, remaining));
        captured += Math.min(value.length, remaining);
      }
      if (value.length > remaining) truncated = true;
    });
    child.once('error', () => {
      if (settled) return;
      finish({ name, exitCode: null, failure: 'spawn-error', stderr: { classifications: { unknown: 1 }, shape: shape(Buffer.alloc(0)), totalBytes: bytes, capturedBytes: captured, truncated, sha256: bytes ? hash.digest('hex') : null } });
    });
    child.once('close', code => {
      if (settled) return;
      const capturedBytes = Buffer.concat(chunks);
      const text = capturedBytes.toString('utf8');
      finish({ name, exitCode: code, failure: truncated ? 'stderr-limit' : null, stderr: { classifications: { [classify(text)]: 1 }, shape: shape(capturedBytes), totalBytes: bytes, capturedBytes: capturedBytes.length, truncated, sha256: bytes ? hash.digest('hex') : null } });
    });
    const timer = setTimeout(() => {
      try { child.kill?.(); } catch { /* bounded diagnostic cleanup */ }
      finish({ name, exitCode: null, failure: 'timeout', stderr: { classifications: { unknown: 1 }, shape: shape(Buffer.concat(chunks)), totalBytes: bytes, capturedBytes: captured, truncated, sha256: bytes ? hash.digest('hex') : null } });
    }, timeoutMs);
  });
}

export async function main() {
  if (process.platform !== 'win32') return;
  const results = [];
  for (const [name, command] of Object.entries(STDERR_CASES)) results.push(await runCase(name, command));
  const report = { version: 1, cases: results };
  const directory = join(process.cwd(), '.artifacts', 'p1', 'powershell-stderr-fixture');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  const failures = results.filter(result => {
    const expected = EXPECTED[result.name];
    const classification = Object.keys(result.stderr.classifications)[0];
    return !expected || result.exitCode !== expected.exitCode || result.failure !== null
      || classification !== expected.classification;
  });
  if (failures.length) throw new Error('stderr fixture expectation failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('PowerShell stderr fixture failed\n'); process.exitCode = 1; });
