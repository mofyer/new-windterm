#!/usr/bin/env node
// Native WebView smoke runner: launches the built app through tauri-driver
// (WebKitGTK on Linux, WebView2 on Windows) and runs tests/native/scenarios.mjs.
// Evidence (screenshots, logs, summary.json) goes to P0_NATIVE_OUT.
//
// Environment:
//   P0_NATIVE_APP          app binary (default: target/debug/new-windterm-desktop[.exe])
//   P0_NATIVE_OUT          evidence directory (default: a new directory under the OS temp dir)
//   P0_NATIVE_TAURI_DRIVER tauri-driver binary (default: `tauri-driver` from PATH)
//   P0_NATIVE_EDGEDRIVER   Windows: msedgedriver.exe matching the WebView2 Runtime
//   P0_NATIVE_SSH_FIXTURE  built ssh_terminal_fixture; without it the SSH scenario is skipped
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  console.log('skipped: tauri-driver does not support macOS');
  process.exit(0);
}
if (!['linux', 'win32'].includes(process.platform)) {
  console.log(`skipped: tauri-driver supports only Linux and Windows, not ${process.platform}`);
  process.exit(0);
}

const { createWebDriver, waitFor } = await import('./webdriver.mjs');
const { freePort, resolveExecutable, startSshFixture, startTauriDriver, stopProcess, stopSshFixture } = await import('./processes.mjs');
const { SCENARIOS } = await import('./scenarios.mjs');

const root = fileURLToPath(new URL('../../', import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'apps/desktop/src-tauri/target');
const config = {
  app: resolveExecutable(process.env.P0_NATIVE_APP || join(targetDir, `debug/new-windterm-desktop${exe}`)),
  out: resolve(process.env.P0_NATIVE_OUT || join(tmpdir(), `p0-native-${Date.now()}`)),
  tauriDriver: process.env.P0_NATIVE_TAURI_DRIVER ? resolveExecutable(process.env.P0_NATIVE_TAURI_DRIVER) : 'tauri-driver',
  edgeDriver: process.env.P0_NATIVE_EDGEDRIVER ? resolveExecutable(process.env.P0_NATIVE_EDGEDRIVER) : undefined,
  sshFixture: process.env.P0_NATIVE_SSH_FIXTURE ? resolveExecutable(process.env.P0_NATIVE_SSH_FIXTURE) : undefined,
};
await mkdir(config.out, { recursive: true });
const runLog = join(config.out, 'run.log');
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  return appendFile(runLog, `${line}\n`).catch(() => {});
};

const summary = {
  platform: process.platform, arch: process.arch, node: process.version,
  startedAt: new Date().toISOString(), app: config.app, scenarios: [],
};
let driver;
let fixture;
let session;
let failed = false;
// The async finally below does not run on a signal; tauri-driver leads its own
// process group, so an interrupted run must stop it (and the fixture) here.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void log(`received ${signal}; stopping tauri-driver and the SSH fixture`);
    Promise.allSettled([stopProcess(driver, { graceMs: 2_000 }), stopSshFixture(fixture)])
      .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

try {
  for (const [name, path] of [['app', config.app], ['ssh fixture', config.sshFixture], ['msedgedriver', config.edgeDriver]])
    if (path && !existsSync(path)) throw new Error(`${name} not found: ${path}`);
  if (config.tauriDriver !== 'tauri-driver' && !existsSync(config.tauriDriver)) throw new Error(`tauri-driver not found: ${config.tauriDriver}`);

  const [port, nativePort] = [await freePort(), await freePort()];
  await log(`tauri-driver ${config.tauriDriver} on 127.0.0.1:${port} (native ${nativePort})`);
  driver = startTauriDriver({ binary: config.tauriDriver, port, nativePort, nativeDriver: config.edgeDriver, logPath: join(config.out, 'tauri-driver.log') });
  const webdriver = createWebDriver(`http://127.0.0.1:${port}`);
  summary.driverStatus = await waitFor(async () => {
    if (!driver.running()) throw Object.assign(new Error(`tauri-driver exited:\n${driver.tail()}`), { fatal: true });
    const status = await webdriver.status().catch(() => null);
    return status?.ready === false ? null : status;
  }, { timeoutMs: 30_000, intervalMs: 300, description: 'tauri-driver and the native driver to accept sessions' });

  if (config.sshFixture) {
    fixture = await startSshFixture({ binary: config.sshFixture, logPath: join(config.out, 'ssh-fixture.log') });
    await log(`SSH fixture on ${fixture.info.host}:${fixture.info.port}, ${fixture.info.fingerprint}`);
  }

  await log(`new session for ${config.app}`);
  const created = await webdriver.newSession({ alwaysMatch: { 'tauri:options': { application: config.app } } });
  session = created.session;
  summary.capabilities = pick(created.capabilities, ['browserName', 'browserVersion', 'platformName', 'webkitgtk:browserOptions', 'msedge']);
  await session.setTimeouts({ script: 30_000, pageLoad: 60_000, implicit: 0 });

  const ctx = {
    session, platform: process.platform, fixture, log,
    screenshot: async (name) => writeFile(join(config.out, `${name}.png`), await session.screenshot()),
    writeText: (name, text) => writeFile(join(config.out, name), text),
  };
  for (const scenario of SCENARIOS) {
    const started = Date.now();
    await log(`scenario ${scenario.name}: start`);
    try {
      const evidence = await scenario.run(ctx);
      const status = evidence?.skipped ? 'skipped' : 'passed';
      summary.scenarios.push({ name: scenario.name, status, durationMs: Date.now() - started, evidence });
      await log(`scenario ${scenario.name}: ${status}${evidence?.skipped ? ` (${evidence.skipped})` : ''}`);
    } catch (error) {
      failed = true;
      summary.scenarios.push({ name: scenario.name, status: 'failed', durationMs: Date.now() - started, error: String(error?.stack ?? error) });
      await log(`scenario ${scenario.name}: FAILED ${error?.message ?? error}`);
      await ctx.screenshot(`failure-${scenario.name}`).catch(e => log(`failure screenshot unavailable: ${e.message}`));
      await dumpPage(ctx, `failure-${scenario.name}.json`);
    }
  }
} catch (error) {
  failed = true;
  summary.error = String(error?.stack ?? error);
  await log(`FATAL ${error?.message ?? error}`);
  if (driver) await log(`tauri-driver output tail:\n${driver.tail()}`);
} finally {
  if (session) await session.delete().catch(error => log(`delete session: ${error.message}`));
  summary.driverExit = await stopProcess(driver);
  summary.fixtureExit = await stopSshFixture(fixture);
  summary.finishedAt = new Date().toISOString();
  summary.result = failed ? 'failed' : 'passed';
  await writeFile(join(config.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeStepSummary(summary);
  await log(`result: ${summary.result}; evidence in ${config.out}`);
}
process.exit(failed ? 1 : 0);

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
}

async function dumpPage(ctx, name) {
  try {
    const state = await ctx.session.execute(`return {
      href: location.href,
      status: document.querySelector('#terminal-state')?.textContent ?? '',
      toast: document.querySelector('#toast')?.textContent ?? '',
      dialogs: [...document.querySelectorAll('dialog[open]')].map(d => ({ id: d.id, text: d.textContent.slice(0, 2000) })),
      tabs: [...document.querySelectorAll('#tabs [role="tab"]')].map(t => t.textContent),
      rows: [...document.querySelectorAll('.terminal-pane.focused-pane .xterm-accessibility-tree > *')].map(r => r.textContent),
    };`);
    await ctx.writeText(name, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    await log(`page dump unavailable: ${error.message}`);
  }
}

async function writeStepSummary(result) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  // WebKitGTK reports the embedder (wry) here; the WebKitGTK package version is recorded by CI.
  const runtime = `browserName=${result.capabilities?.browserName ?? '?'}, browserVersion=${result.capabilities?.browserVersion ?? '?'}`;
  const rows = result.scenarios.map(s => `| ${s.name} | ${s.status} | ${s.durationMs} ms |`).join('\n');
  const text = [
    `### Native WebView smoke (${result.platform}/${result.arch}) — ${result.result}`, '',
    `WebDriver session capabilities: ${runtime}`, '',
    '| Scenario | Outcome | Time |', '| --- | --- | --- |', rows || '| (none) | not run | |', '',
    result.error ? `Fatal: \`${result.error.split('\n')[0]}\`\n` : '',
    'Drives the debug app with the bundled frontend through tauri-driver. Not verified here: macOS WKWebView, IME, accessibility, high-output performance, signing or installers.', '',
  ].join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, text).catch(() => {});
}
