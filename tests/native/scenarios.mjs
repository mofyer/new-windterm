// Native WebView smoke scenarios. Each one drives the real app (production
// frontend, real Tauri IPC through the bundled ACL/capabilities) and returns
// evidence, or throws with what it saw.
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { Keys, WebDriverError, waitFor } from './webdriver.mjs';

const PANE = '.terminal-pane.focused-pane:not([hidden])';
const TEXTAREA = `${PANE} .xterm-helper-textarea`;
const BUNDLED_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)(\/|$)/;

/** Runs `fn` in the page; it is serialised, so it must not close over Node values. */
export const inPage = (session, fn, ...args) => session.execute(`return (${fn}).apply(null, arguments);`, args);

const tabCount = (session) => inPage(session, () => document.querySelectorAll('#tabs [role="tab"]').length);
const statusLine = (session) => inPage(session, () => ({
  state: document.querySelector('#terminal-state')?.textContent ?? '',
  size: document.querySelector('#terminal-size')?.textContent ?? '',
  detail: document.querySelector('#session-detail')?.textContent ?? '',
}));

/** Rows of the focused terminal: xterm's accessibility tree and its DOM renderer rows. */
export function terminalRows(session) {
  return inPage(session, (pane) => {
    const root = document.querySelector(pane);
    const clean = (text) => (text ?? '').replace(/ /g, ' ').replace(/\s+$/, '');
    const read = (selector) => (root ? [...root.querySelectorAll(selector)].map(row => clean(row.textContent)) : []);
    return { tree: read('.xterm-accessibility-tree > *'), dom: read('.xterm-rows > *') };
  }, PANE);
}

/** Evidence text: both row sources, labelled, for each snapshot. */
const rowsText = (snapshots) => Object.entries(snapshots)
  .map(([label, rows]) => [`--- ${label}: accessibility tree ---`, ...rows.tree, `--- ${label}: DOM renderer rows ---`, ...rows.dom].join('\n'))
  .join('\n') + '\n';

const rowsMatching = (rows, predicate) => [...rows.tree, ...rows.dom].filter(row => predicate(row.trim()));

async function waitForRow(ctx, predicate, description, timeoutMs = 30_000) {
  return waitFor(async () => {
    const rows = await terminalRows(ctx.session);
    const found = rowsMatching(rows, predicate);
    return found.length ? { row: found[0].trim(), rows } : null;
  }, { timeoutMs, description });
}

async function clickCss(session, css) {
  await session.click(await session.findElement(css));
}

/** Focuses xterm's input textarea, then types; falls back to the actions API if a driver refuses the hidden element. */
export async function typeInTerminal(ctx, text) {
  const focused = await inPage(ctx.session, (css) => {
    const area = document.querySelector(css);
    area?.focus();
    return !!area && document.activeElement === area;
  }, TEXTAREA);
  if (!focused) throw new Error('the focused terminal textarea did not take focus');
  try {
    await ctx.session.sendKeys(await ctx.session.findElement(TEXTAREA), text);
    return 'element send keys';
  } catch (error) {
    if (!(error instanceof WebDriverError) || !['element not interactable', 'invalid element state'].includes(error.error)) throw error;
    ctx.log(`element send keys refused (${error.error}); typing through the actions API`);
    await ctx.session.performKeys(text);
    await ctx.session.releaseActions();
    return 'actions API';
  }
}

/** Types into a form field and checks the value; sets it from script only if typing did not land. */
async function fill(ctx, css, value) {
  const id = await ctx.session.findElement(css);
  await ctx.session.clear(id);
  await ctx.session.sendKeys(id, value);
  const typed = await inPage(ctx.session, (selector) => document.querySelector(selector)?.value, css);
  if (typed === value) return 'typed';
  ctx.log(`typing into ${css} produced ${JSON.stringify(typed)}; setting the value from script`);
  await inPage(ctx.session, (selector, text) => {
    const input = document.querySelector(selector);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, css, value);
  return 'script';
}

/** Waits for the status bar to show `wanted`; stops early when the session reports an error. */
async function waitForSessionState(ctx, wanted, description, timeoutMs = 30_000) {
  const status = await waitFor(async () => {
    const line = await statusLine(ctx.session);
    return line.state.includes(wanted) || line.state.includes('错误') ? line : null;
  }, { timeoutMs, description });
  if (!status.state.includes(wanted)) throw new Error(`session failed while waiting for ${description}: ${status.state}`);
  return status;
}

async function closeActiveTab(ctx, expectedTabs) {
  await clickCss(ctx.session, '#tabs .tab.active .tab-close');
  await waitFor(async () => (await tabCount(ctx.session)) === expectedTabs, { description: `tab count back to ${expectedTabs}` });
}

/** 1. The bundled frontend loads in the native WebView and the workbench renders. */
export async function workbench(ctx) {
  const page = await waitFor(() => inPage(ctx.session, () => {
    if (document.readyState !== 'complete') return null;
    const tabs = document.querySelectorAll('#tabs [role="tab"]').length;
    const tree = document.querySelector('.terminal-pane .xterm-accessibility-tree')?.textContent ?? '';
    if (tabs < 1 || !tree.includes('Terminal workspace')) return null;
    return {
      href: location.href,
      title: document.title,
      tabs,
      runtimeNote: document.querySelector('#runtime-note')?.textContent ?? '',
      tauriInvoke: typeof window.__TAURI_INTERNALS__?.invoke,
      theme: document.documentElement.dataset.theme ?? '',
      viewport: [innerWidth, innerHeight],
      userAgent: navigator.userAgent,
    };
  }), { timeoutMs: 60_000, description: 'workbench with the demo tab rendered by xterm.js' });
  if (!BUNDLED_ORIGIN.test(page.href)) throw new Error(`not the bundled frontend (custom protocol): ${page.href}`);
  if (page.tauriInvoke !== 'function') throw new Error('window.__TAURI_INTERNALS__.invoke is missing; not a Tauri WebView');
  if (!page.runtimeNote.startsWith('桌面原型')) throw new Error(`frontend did not detect Tauri: ${page.runtimeNote}`);
  const windowTitle = await ctx.session.title();
  await ctx.screenshot('01-workbench');
  return { ...page, windowTitle };
}

/** 2. A real local PTY (bash on Linux, cmd.exe on Windows) runs a typed echo. */
export async function localTerminal(ctx) {
  const before = await tabCount(ctx.session);
  await clickCss(ctx.session, '#local-open');
  await waitFor(async () => (await tabCount(ctx.session)) === before + 1, { description: 'a new local terminal tab' });
  const started = await waitForSessionState(ctx, '本机 shell 已启动', 'pty_open to return a session');
  const marker = `p0native${randomBytes(6).toString('hex')}`;
  const input = await typeInTerminal(ctx, `echo ${marker}${Keys.ENTER}`);
  // The typed line also contains the marker after "echo "; only shell output is the marker alone.
  const echoed = await waitForRow(ctx, row => row === marker, `shell output line "${marker}"`);
  // Shell identity with unshifted keys: `ver` is a cmd.exe built-in, `help help` a Bash built-in.
  const windows = ctx.platform === 'win32';
  await typeInTerminal(ctx, `${windows ? 'ver' : 'help help'}${Keys.ENTER}`);
  const identity = await waitForRow(ctx,
    windows ? row => /^Microsoft Windows \[Version \d+\.\d+\.\d+/.test(row) : row => row.startsWith('help: help ['),
    windows ? 'cmd.exe `ver` output' : 'Bash `help help` output');
  const status = await statusLine(ctx.session);
  await ctx.writeText('02-local-terminal.txt', rowsText({ 'after echo': echoed.rows, 'after identity': identity.rows }));
  await ctx.screenshot('02-local-terminal');
  await closeActiveTab(ctx, before);
  return { marker, input, startedState: started.state, shellIdentity: identity.row, status };
}

/** A real exited local PTY keeps its output while reopen starts a separate, usable shell. */
export async function localTerminalReopen(ctx) {
  const { session } = ctx;
  const before = await tabCount(session);
  const oldTab = `#tabs .tab:nth-child(${before + 1}) [role="tab"]`;
  const newTab = `#tabs .tab:nth-child(${before + 2}) [role="tab"]`;
  await clickCss(session, '#local-open');
  await waitFor(async () => (await tabCount(session)) === before + 1, { description: 'the local tab to exit' });
  await waitForSessionState(ctx, '本机 shell 已启动', 'initial local PTY startup');
  // WebKitWebDriver getText can return an empty string for these visibly rendered
  // tab buttons. Read their DOM text as in the runner's failure evidence instead.
  const oldLabel = await inPage(session, css => document.querySelector(css)?.textContent?.trim() ?? '', oldTab);
  if (!oldLabel) throw new Error('initial local tab has no DOM label');
  const oldMarker = `p1old${randomBytes(6).toString('hex')}`;
  await typeInTerminal(ctx, `echo ${oldMarker}${Keys.ENTER}`);
  const original = await waitForRow(ctx, row => row === oldMarker, 'old shell marker as a standalone output row');
  // Both the Linux Bash fixture and Windows cmd.exe support this exit status.
  await typeInTerminal(ctx, `exit 7${Keys.ENTER}`);
  const exited = await waitForSessionState(ctx, '已退出 · code 7', 'local exit status 7');
  const reopen = 'button[aria-label="重新打开本地终端"]';
  await waitFor(() => inPage(session, (css) => {
    const button = document.querySelector(css);
    return !!button && !button.disabled && button.getClientRects().length > 0;
  }, reopen), { description: 'an enabled, visible local reopen button' });
  await clickCss(session, reopen);
  await waitFor(async () => (await tabCount(session)) === before + 2, { description: 'a second local tab without replacing the exited tab' });
  const restarted = await waitForSessionState(ctx, '本机 shell 已启动', 'reopened local PTY startup');
  const reopenedTabs = await inPage(session, (oldCss, newCss) => ({
    oldLabel: document.querySelector(oldCss)?.textContent?.trim() ?? '',
    newLabel: document.querySelector(newCss)?.textContent?.trim() ?? '',
    newSelected: document.querySelector(newCss)?.getAttribute('aria-selected'),
  }), oldTab, newTab);
  const newLabel = reopenedTabs.newLabel;
  if (reopenedTabs.oldLabel !== oldLabel) throw new Error('reopening changed the exited tab label');
  if (!newLabel) throw new Error('reopened local tab has no DOM label');
  if (oldLabel === newLabel) throw new Error(`reopened tab reused the old label: ${oldLabel}`);
  if (reopenedTabs.newSelected !== 'true') throw new Error('reopened local tab was not selected');
  const newMarker = `p1new${randomBytes(6).toString('hex')}`;
  await typeInTerminal(ctx, `echo ${newMarker}${Keys.ENTER}`);
  // An input echo contains "echo "; it cannot satisfy the exact output-row predicate.
  const resumed = await waitForRow(ctx, row => row === newMarker, 'reopened shell marker as a standalone output row');
  if (rowsMatching(resumed.rows, row => row === oldMarker).length)
    throw new Error('reopened shell contains output from the old shell');
  await clickCss(session, oldTab);
  const preservedState = await waitForSessionState(ctx, '已退出 · code 7', 'old tab to retain its exit status');
  const preserved = await waitForRow(ctx, row => row === oldMarker, 'old output still readable after reopening');
  if (rowsMatching(preserved.rows, row => row === newMarker).length)
    throw new Error('old shell contains output from the reopened shell');
  await ctx.writeText('04-local-terminal-reopen.txt', rowsText({ original: original.rows, reopened: resumed.rows, preserved: preserved.rows }));
  await ctx.screenshot('04-local-terminal-reopen');
  await clickCss(session, newTab);
  await waitForSessionState(ctx, '本机 shell 已启动', 'new tab selected for cleanup');
  await closeActiveTab(ctx, before + 1);
  await clickCss(session, oldTab);
  await closeActiveTab(ctx, before);
  return { oldLabel, newLabel, oldMarker, newMarker, exitState: exited.state, restartedState: restarted.state,
    preservedState: preservedState.state, remainingTabs: await tabCount(session) };
}

/** Only a complete shell output row proves cwd; prompts and echoed commands do not. */
export function isCwdOutput(row, expected, platform) {
  if (platform === 'win32') {
    // cmd.exe may preserve a different drive/path letter case than fs.realpath.
    return win32.normalize(row).toLowerCase() === win32.normalize(expected).toLowerCase();
  }
  return row === expected;
}

/** 5. The configured directory reaches the real shell and survives reopening. */
export async function localTerminalCwd(ctx) {
  const { session } = ctx;
  const before = await tabCount(session);
  // Keep this short so the complete path fits a terminal row on hosted Windows.
  // All paths go through the form/IPC; none is interpolated into shell input.
  const directory = await mkdtemp(join(tmpdir(), 'p1 中文-'));
  const oldTab = `#tabs .tab:nth-child(${before + 1}) [role="tab"]`;
  const newTab = `#tabs .tab:nth-child(${before + 2}) [role="tab"]`;
  try {
    const expected = await realpath(directory);
    await clickCss(session, '#local-options-open');
    await waitFor(() => inPage(session, () => document.querySelector('#local-dialog')?.open === true),
      { description: 'local startup options dialog' });
    const filled = await fill(ctx, '#local-cwd-input', directory);
    await clickCss(session, '#local-start');
    await waitFor(async () => (await tabCount(session)) === before + 1, { description: 'custom cwd local tab' });
    await waitForSessionState(ctx, '本机 shell 已启动', 'custom cwd PTY startup');
    const query = ctx.platform === 'win32' ? 'cd' : 'pwd -P';
    // cmd.exe's legacy code page can lose Chinese cwd characters. Change only
    // this test shell; ConPTY transports the resulting console text as UTF-8.
    if (ctx.platform === 'win32') await typeInTerminal(ctx, `chcp 65001${Keys.ENTER}`);
    await typeInTerminal(ctx, `${query}${Keys.ENTER}`);
    const initial = await waitForRow(ctx, row => isCwdOutput(row, expected, ctx.platform), 'actual initial shell cwd output');
    await typeInTerminal(ctx, `exit 7${Keys.ENTER}`);
    await waitForSessionState(ctx, '已退出 · code 7', 'custom cwd shell exit');
    await clickCss(session, '#local-reopen');
    await waitFor(async () => (await tabCount(session)) === before + 2, { description: 'reopened custom cwd tab' });
    await waitForSessionState(ctx, '本机 shell 已启动', 'reopened custom cwd PTY startup');
    if (ctx.platform === 'win32') await typeInTerminal(ctx, `chcp 65001${Keys.ENTER}`);
    await typeInTerminal(ctx, `${query}${Keys.ENTER}`);
    const reopened = await waitForRow(ctx, row => isCwdOutput(row, expected, ctx.platform), 'actual reopened shell cwd output');
    await ctx.writeText('05-local-terminal-cwd.txt', rowsText({ initial: initial.rows, reopened: reopened.rows }));
    await ctx.screenshot('05-local-terminal-cwd');
    await clickCss(session, newTab);
    await closeActiveTab(ctx, before + 1);
    await clickCss(session, oldTab);
    await closeActiveTab(ctx, before);
    return { directory, expected, filled, query, initialCwd: initial.row, reopenedCwd: reopened.row,
      remainingTabs: await tabCount(session) };
  } finally {
    // Close only tabs created by this scenario, even when a cwd assertion fails.
    // Windows can briefly keep cwd open while the backend worker is reaping.
    try {
      while ((await tabCount(session)) > before) {
        await clickCss(session, '#tabs .tab:last-child [role="tab"]');
        await closeActiveTab(ctx, (await tabCount(session)) - 1);
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

/** 3. SSH terminal to the loopback russh fixture: real probe, fingerprint check, shell channel round trip. */
export async function sshTerminal(ctx) {
  const fixture = ctx.fixture?.info;
  if (!fixture) return { skipped: 'P0_NATIVE_SSH_FIXTURE is not set; build ssh_terminal_fixture with --features dev-tools' };
  const { session } = ctx;
  const before = await tabCount(session);
  await clickCss(session, '#connect-open');
  await waitFor(() => inPage(session, () => document.querySelector('#connect-dialog')?.open === true), { description: 'connect dialog' });
  await clickCss(session, '#ssh-terminal-open');
  await waitFor(() => inPage(session, () => {
    const dialog = document.querySelector('#ssh-verification-dialog');
    const probe = dialog?.querySelector('#ssh-probe');
    return !!dialog?.open && !!probe && !probe.disabled;
  }), { description: 'SSH dialog enabled by ssh_context' });
  const filled = {};
  filled.host = await fill(ctx, '#ssh-host', fixture.host);
  filled.port = await fill(ctx, '#ssh-port', String(fixture.port));
  filled.username = await fill(ctx, '#ssh-username', fixture.username);
  filled.keyPath = await fill(ctx, '#ssh-key-path', fixture.privateKeyPath);
  await clickCss(session, '#ssh-probe');
  const challenge = await waitFor(() => inPage(session, () => {
    const dialog = document.querySelector('#ssh-verification-dialog');
    const failure = dialog.querySelector('#ssh-error')?.textContent ?? '';
    if (failure) return { failure };
    const fingerprint = dialog.querySelector('#ssh-fingerprint')?.textContent ?? '';
    if (dialog.querySelector('#ssh-challenge')?.hidden !== false || !fingerprint) return null;
    return { fingerprint, endpoint: dialog.querySelector('#ssh-endpoint')?.textContent ?? '', algorithm: dialog.querySelector('#ssh-algorithm')?.textContent ?? '' };
  }), { timeoutMs: 30_000, description: 'host key challenge from ssh_probe' });
  if (challenge.failure) throw new Error(`ssh_probe failed: ${challenge.failure}`);
  if (challenge.fingerprint !== fixture.fingerprint)
    throw new Error(`fingerprint mismatch: app shows ${challenge.fingerprint}, fixture has ${fixture.fingerprint}`);
  await clickCss(session, '#ssh-accept');
  await waitFor(async () => (await tabCount(session)) === before + 1, { description: 'a new SSH terminal tab' });
  const connected = await waitForSessionState(ctx, 'SSH 已连接', 'ssh_open to return a session');
  await waitForRow(ctx, row => row.startsWith('P0 SSH terminal fixture'), 'fixture shell banner');
  const input = await typeInTerminal(ctx, `size${Keys.ENTER}`);
  // The fixture prints its `> ` prompt before each reply.
  const size = await waitForRow(ctx, row => /^(?:> )?SIZE \d+ \d+$/.test(row), 'fixture SIZE reply');
  const sizeStatus = await statusLine(session);
  await typeInTerminal(ctx, `unicode${Keys.ENTER}`);
  const unicode = await waitForRow(ctx, row => row.includes('中文') && row.includes('🌏'), 'fixture UTF-8 reply');
  await ctx.writeText('03-ssh-terminal.txt', rowsText({ 'after unicode': unicode.rows }));
  await ctx.screenshot('03-ssh-terminal');
  await typeInTerminal(ctx, `exit${Keys.ENTER}`);
  const exited = await waitForSessionState(ctx, '已退出 · code 7', 'remote exit status 7');
  await closeActiveTab(ctx, before);
  return { fingerprint: challenge.fingerprint, endpoint: challenge.endpoint, algorithm: challenge.algorithm, filled, input,
    connectedState: connected.state, sizeReply: size.row, statusSize: sizeStatus.size, unicodeReply: unicode.row, exitState: exited.state };
}

export const SCENARIOS = Object.freeze([
  { name: 'workbench', run: workbench },
  { name: 'local-terminal', run: localTerminal },
  { name: 'ssh-terminal', run: sshTerminal },
  { name: 'local-terminal-reopen', run: localTerminalReopen },
  { name: 'local-terminal-cwd', run: localTerminalCwd },
]);
