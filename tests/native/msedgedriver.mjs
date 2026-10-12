#!/usr/bin/env node
// Windows CI: downloads the msedgedriver build whose version equals the
// installed WebView2 Runtime, records both versions and the archive SHA-256,
// and prints the driver path on stdout (logs go to stderr).
//
//   node tests/native/msedgedriver.mjs --dest <dir> [--record <file.json>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** EdgeUpdate client ID of the Evergreen WebView2 Runtime (Microsoft's documented detection keys). */
export const WEBVIEW2_CLIENT = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
export const WEBVIEW2_KEYS = Object.freeze([
  `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
  `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
  `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
]);
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;

/** The `pv` value of `reg query <key> /v pv`, or undefined when absent or "0.0.0.0". */
export function parseRegVersion(output) {
  const version = /^\s*pv\s+REG_SZ\s+(\S+)\s*$/m.exec(String(output))?.[1];
  return version && VERSION.test(version) && version !== '0.0.0.0' ? version : undefined;
}

/** Download URL of the x64 msedgedriver for exactly `version`. */
export function driverUrl(version) {
  if (!VERSION.test(String(version))) throw new Error(`not a four-part version: ${version}`);
  return `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
}

/** Version printed by `msedgedriver --version`, e.g. "Microsoft Edge WebDriver 130.0.2849.80 (…)". */
export function parseDriverVersion(output) {
  return /Microsoft Edge WebDriver\s+(\d+\.\d+\.\d+\.\d+)/.exec(String(output))?.[1];
}

function webview2Version() {
  for (const key of WEBVIEW2_KEYS) {
    try {
      const version = parseRegVersion(execFileSync('reg', ['query', key, '/v', 'pv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      if (version) return { version, key };
    } catch {
      /* Key absent: try the next documented location. */
    }
  }
  throw new Error('WebView2 Runtime is not installed (no EdgeUpdate pv value); the native smoke needs it');
}

async function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (process.platform !== 'win32') throw new Error('msedgedriver.mjs only runs on Windows');
  const dest = resolve(option('--dest') ?? 'msedgedriver');
  const record = option('--record');
  const runtime = webview2Version();
  const url = driverUrl(runtime.version);
  console.error(`WebView2 Runtime ${runtime.version} (${runtime.key}); downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`no msedgedriver published for WebView2 ${runtime.version}: HTTP ${response.status} ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await mkdir(dest, { recursive: true });
  const zip = join(dest, 'edgedriver_win64.zip');
  await writeFile(zip, archive);
  const quote = (path) => `'${path.replaceAll("'", "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dest)} -Force`], { stdio: ['ignore', 'ignore', 'inherit'] });
  const driver = join(dest, 'msedgedriver.exe');
  if (!existsSync(driver)) throw new Error(`archive did not contain msedgedriver.exe: ${url}`);
  const versionOutput = execFileSync(driver, ['--version'], { encoding: 'utf8' }).trim();
  const driverVersion = parseDriverVersion(versionOutput);
  if (driverVersion !== runtime.version)
    throw new Error(`msedgedriver reports ${driverVersion ?? versionOutput}, WebView2 Runtime is ${runtime.version}`);
  const evidence = { webview2Runtime: runtime.version, registryKey: runtime.key, msedgedriver: versionOutput, url, sha256 };
  console.error(JSON.stringify(evidence));
  if (record) await writeFile(resolve(record), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(driver);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`msedgedriver setup failed: ${error.message}`);
    process.exit(1);
  });
}
