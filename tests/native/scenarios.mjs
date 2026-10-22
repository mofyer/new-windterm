// Native WebView smoke scenarios. Each one drives the real app (production
// frontend, real Tauri IPC through the bundled ACL/capabilities) and returns
// evidence, or throws with what it saw.
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { Keys, WebDriverError, waitFor } from './webdriver.mjs';
import { installTerminalTrace } from './terminal-trace.mjs';

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
export async function typeInTerminal(ctx, text, onTiming, onReturned) {
  const focused = await inPage(ctx.session, (css) => {
    const area = document.querySelector(css);
    area?.focus();
    return !!area && document.activeElement === area;
  }, TEXTAREA);
  if (!focused) throw new Error('the focused terminal textarea did not take focus');
  const started = onTiming ? performance.now() : 0;
  let inputMethod;
  try {
    await ctx.session.sendKeys(await ctx.session.findElement(TEXTAREA), text);
    inputMethod = 'element send keys';
  } catch (error) {
    if (!(error instanceof WebDriverError) || !['element not interactable', 'invalid element state'].includes(error.error)) throw error;
    ctx.log(`element send keys refused (${error.error}); typing through the actions API`);
    await ctx.session.performKeys(text);
    await ctx.session.releaseActions();
    inputMethod = 'actions API';
  } finally {
    if (onTiming) onTiming(performance.now() - started);
  }
  if (onReturned) await onReturned();
  return inputMethod;
}

/** Types into a form field and checks the value; sets it from script only if typing did not land. */
export async function fill(ctx, css, value) {
  const id = await ctx.session.findElement(css);
  await ctx.session.clear(id);
  // WebKitGTK rejects an empty sendKeys payload. Clearing already supplies the
  // requested empty value; still read it back and retain the fallback below.
  if (value !== '') await ctx.session.sendKeys(id, value);
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

/** Version expansion must be a complete output row, not a typed command or prompt. */
export function isShellVersionOutput(row, shell) {
  if (shell === 'powershell') return /^P1_SHELL=\d+\.\d+\.\d+(?:\.\d+)?$/.test(row);
  if (shell === 'bash') return /^P1_SHELL=\d+\.\d+\.\d+(?:\(\d+\))?(?:-release)?$/.test(row);
  return false;
}

/** 5. The configured directory reaches the default shell and survives reopening. */
export async function localTerminalCwd(ctx) {
  return localStartup(ctx, null);
}

/** 6. Explicit shell selection executes that shell before and after reopening. */
export async function localTerminalShell(ctx) {
  return localStartup(ctx, ctx.platform === 'win32' ? 'powershell' : 'bash');
}

/** Only fixed variable names and enumerated phases enter shell source; values go through the form. */
export function environmentQueries(platform, phase, sample, custom) {
  if (!['initial', 'independent', 'retained', 'modified', 'reopened', 'defaults'].includes(phase))
    throw new Error('unsupported environment evidence phase');
  const windows = platform === 'win32';
  const lang = custom || !windows ? (platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8') : '';
  const fields = [
    ['SAMPLE_PRESENT', 'P1_ENV_SAMPLE', true, sample === null ? 'no' : 'yes'],
    ['SAMPLE', 'P1_ENV_SAMPLE', false, sample ?? ''],
    ['EMPTY_PRESENT', 'P1_ENV_EMPTY', true, custom ? 'yes' : 'no'],
    ['EMPTY', 'P1_ENV_EMPTY', false, ''],
    ['LANG_PRESENT', 'LANG', true, custom || !windows ? 'yes' : 'no'],
    ['LANG', 'LANG', false, lang],
    ['LC_ALL_PRESENT', 'LC_ALL', true, !custom && platform === 'linux' ? 'yes' : 'no'],
    ['LC_ALL', 'LC_ALL', false, !custom && platform === 'linux' ? 'C.UTF-8' : ''],
    ['LC_CTYPE_PRESENT', 'LC_CTYPE', true, !custom && platform === 'darwin' ? 'yes' : 'no'],
    ['LC_CTYPE', 'LC_CTYPE', false, !custom && platform === 'darwin' ? 'UTF-8' : ''],
  ];
  return fields.map(([field, name, presence, value]) => {
    const prefix = `P1_${phase}_${field}`;
    let expression;
    if (windows) {
      expression = presence
        ? `$(if ([Environment]::GetEnvironmentVariables('Process').Contains('${name}')) {'yes'} else {'no'})`
        : `$env:${name}`;
    } else {
      expression = presence ? `"$(if [ \"\${${name}+x}\" = x ]; then printf yes; else printf no; fi)"` : `"$${name}"`;
    }
    const command = windows ? `'${prefix}=[' + ${expression} + ']'` : `printf '${prefix}=[%s]\\n' ${expression}`;
    return { command, expected: `${prefix}=[${value}]` };
  });
}

/** 7. Literal per-session env/locale, independent live tabs, and original configuration on reopen. */
export async function localTerminalEnvironment(ctx) {
  const { session } = ctx;
  const before = await tabCount(session);
  const windows = ctx.platform === 'win32';
  const shell = windows ? 'powershell' : 'bash';
  const artifact = '07-local-terminal-environment';
  const evidence = {};
  let phase = 'open';
  const firstTab = `#tabs .tab:nth-child(${before + 1}) [role="tab"]`;
  const secondTab = `#tabs .tab:nth-child(${before + 2}) [role="tab"]`;
  async function read(phaseName, sample, custom) {
    phase = phaseName;
    if (windows) await typeInTerminal(ctx, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8${Keys.ENTER}`);
    const found = [];
    for (const { command, expected } of environmentQueries(ctx.platform, phaseName, sample, custom)) {
      await typeInTerminal(ctx, `${command}${Keys.ENTER}`);
      const result = await waitForRow(ctx, row => row === expected, `${phaseName} exact environment output ${expected.split('=')[0]}`);
      found.push(result.row);
    }
    evidence[phaseName] = found;
  }
  async function openConfigured(sample) {
    await clickCss(session, '#local-options-open');
    await waitFor(() => inPage(session, () => document.querySelector('#local-dialog')?.open === true),
      { description: 'environment launch dialog' });
    await fill(ctx, '#local-cwd-input', '');
    await waitFor(() => inPage(session, value => {
      const select = document.querySelector('#local-shell-select');
      const option = select && [...select.options].find(item => item.value === value);
      return !!option && !option.disabled && !select.disabled;
    }, shell), { description: `environment ${shell} choice` });
    await inPage(session, value => {
      const select = document.querySelector('#local-shell-select');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, shell);
    while (await inPage(session, () => !!document.querySelector('[data-env-remove]')))
      await clickCss(session, '[data-env-remove]');
    for (const [index, name, value] of [[1, 'P1_ENV_SAMPLE', sample], [2, 'P1_ENV_EMPTY', '']]) {
      await clickCss(session, '#local-env-add');
      await fill(ctx, `#local-env-rows > :nth-child(${index}) [data-env-name]`, name);
      await fill(ctx, `#local-env-rows > :nth-child(${index}) [data-env-value]`, value);
    }
    await inPage(session, () => {
      const select = document.querySelector('#local-locale-mode');
      select.value = 'custom';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    while (await inPage(session, () => !!document.querySelector('[data-locale-remove]')))
      await clickCss(session, '[data-locale-remove]');
    await clickCss(session, '#local-locale-add');
    await inPage(session, () => {
      const select = document.querySelector('#local-locale-rows [data-locale-name]');
      select.value = 'LANG';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await fill(ctx, '#local-locale-rows [data-locale-value]', ctx.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8');
    const count = await tabCount(session);
    await clickCss(session, '#local-start');
    await waitFor(async () => (await tabCount(session)) === count + 1, { description: 'configured environment tab' });
    await waitForSessionState(ctx, '本机 shell 已启动', 'configured environment PTY');
  }
  try {
    await openConfigured('中文 space=one');
    await read('initial', '中文 space=one', true);
    await openConfigured('独立 space=two');
    await read('independent', '独立 space=two', true);
    await clickCss(session, firstTab);
    await read('retained', '中文 space=one', true);
    await typeInTerminal(ctx, `${windows ? "$env:P1_ENV_SAMPLE = 'runtime-change'" : "export P1_ENV_SAMPLE='runtime-change'"}${Keys.ENTER}`);
    await read('modified', 'runtime-change', true);
    await typeInTerminal(ctx, `exit 7${Keys.ENTER}`);
    evidence.exitState = (await waitForSessionState(ctx, '已退出 · code 7', 'environment shell exit')).state;
    await clickCss(session, '#local-reopen');
    await waitFor(async () => (await tabCount(session)) === before + 3, { description: 'reopened original environment tab' });
    await waitForSessionState(ctx, '本机 shell 已启动', 'reopened environment PTY');
    await read('reopened', '中文 space=one', true);
    await typeInTerminal(ctx, `exit 7${Keys.ENTER}`);
    evidence.reopenedExitState = (await waitForSessionState(ctx, '已退出 · code 7', 'reopened environment exit')).state;
    await ctx.screenshot(artifact);
    // Keep the second shell alive while the default session starts; opening and
    // reopening another session must not change its process environment.
    await clickCss(session, secondTab);
    await typeInTerminal(ctx, `${windows ? "'P1_SECOND_STILL=[' + $env:P1_ENV_SAMPLE + ']'" : "printf 'P1_SECOND_STILL=[%s]\\n' \"$P1_ENV_SAMPLE\""}${Keys.ENTER}`);
    evidence.secondStill = (await waitForRow(ctx, row => row === 'P1_SECOND_STILL=[独立 space=two]', 'second live session remains isolated')).row;
    if (windows) {
      // The default Windows shell is cmd.exe. Use fixed built-ins rather than
      // switching it to PowerShell or modifying its environment first.
      await clickCss(session, '#local-open');
      await waitForSessionState(ctx, '本机 shell 已启动', 'fresh default cmd environment');
      phase = 'defaults';
      const rows = [];
      for (const name of ['P1_ENV_SAMPLE', 'P1_ENV_EMPTY', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
        await typeInTerminal(ctx, `if defined ${name} (echo P1_DEFAULT_${name}=present) else (echo P1_DEFAULT_${name}=absent)${Keys.ENTER}`);
        rows.push((await waitForRow(ctx, row => row === `P1_DEFAULT_${name}=absent`, `default cmd ${name} absent`)).row);
      }
      // IF DEFINED alone treats an empty variable as absent. Enumerate only the
      // synthetic prefix too, so an inherited P1_ENV_EMPTY= cannot pass unnoticed.
      await typeInTerminal(ctx, `set P1_ENV_ & echo P1_DEFAULT_ENV_SCAN_DONE${Keys.ENTER}`);
      const scan = await waitForRow(ctx, row => row === 'P1_DEFAULT_ENV_SCAN_DONE', 'default cmd synthetic environment scan completed');
      if (rowsMatching(scan.rows, row => /^P1_ENV_(SAMPLE|EMPTY)=/i.test(row)).length)
        throw new Error('default cmd retained a synthetic environment entry');
      evidence.defaults = rows;
    } else {
      await clickCss(session, '#local-open');
      await waitForSessionState(ctx, '本机 shell 已启动', 'fresh default environment');
      await read('defaults', null, false);
    }
    await ctx.writeText(`${artifact}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    // Test-only values are safe to capture. Never enumerate the process env or
    // general launch configuration; retain the failure before closing our tabs.
    await ctx.writeText(`${artifact}-failure.json`, `${JSON.stringify({ phase, evidence,
      error: String(error?.stack ?? error), status: await statusLine(session), rows: await terminalRows(session) }, null, 2)}\n`)
      .catch(captureError => ctx.log(`environment failure text unavailable: ${captureError.message}`));
    await ctx.screenshot(`${artifact}-failure`).catch(captureError => ctx.log(`environment failure screenshot unavailable: ${captureError.message}`));
    throw error;
  } finally {
    while ((await tabCount(session)) > before) {
      await clickCss(session, '#tabs .tab:last-child [role="tab"]');
      await closeActiveTab(ctx, (await tabCount(session)) - 1);
    }
  }
  return { shell, ...evidence, remainingTabs: await tabCount(session) };
}

async function localStartup(ctx, shell) {
  const { session } = ctx;
  const before = await tabCount(session);
  // Keep this short so the complete path fits a terminal row on hosted Windows.
  // All paths go through the form/IPC; none is interpolated into shell input.
  const directory = await mkdtemp(join(tmpdir(), 'p1 中文-'));
  const oldTab = `#tabs .tab:nth-child(${before + 1}) [role="tab"]`;
  const newTab = `#tabs .tab:nth-child(${before + 2}) [role="tab"]`;
  const query = shell === 'powershell' ? '(Get-Location).Path' : ctx.platform === 'win32' ? 'cd' : 'pwd -P';
  const versionQuery = shell === 'powershell'
    ? "'P1_SHELL=' + $PSVersionTable.PSVersion.ToString()"
    : `printf 'P1_SHELL=%s\\n' "$BASH_VERSION"`;
  const artifact = shell ? `${ctx.artifactPrefix ?? ''}06-local-terminal-shell` : '05-local-terminal-cwd';
  const identities = [];
  const timings = [];
  const recordTiming = (phaseName, event, started) => {
    if (ctx.webviewTiming) timings.push({ phase: phaseName, event, milliseconds: performance.now() - started });
  };
  const recordTypeTiming = (event, milliseconds) => {
    if (ctx.webviewTiming) timings.push({ phase, event, milliseconds });
  };
  const markInputReturn = async () => {
    if (ctx.webviewTiming && tracing) {
      await inPage(session, () => window.__P1_NATIVE_SHELL_TRACE__.mark('webdriver-input-return'));
    }
  };
  let selected;
  async function queryCwd() {
    if (shell === 'powershell') {
      await typeInTerminal(ctx, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8${Keys.ENTER}`);
    } else if (ctx.platform === 'win32') {
      // Change only the fixture shell's legacy code page, not the user's system.
      await typeInTerminal(ctx, `chcp 65001${Keys.ENTER}`);
    }
    if (shell) {
      const versionStarted = ctx.webviewTiming ? performance.now() : 0;
      await typeInTerminal(ctx, `${versionQuery}${Keys.ENTER}`, milliseconds => recordTypeTiming('version-typeInTerminal', milliseconds), markInputReturn);
      const identity = await waitForRow(ctx, row => isShellVersionOutput(row, shell), `actual ${shell} version expansion`);
      recordTiming(phase, 'version-send-to-row', versionStarted);
      identities.push(identity.row);
    }
    const cwdStarted = ctx.webviewTiming ? performance.now() : 0;
    await typeInTerminal(ctx, `${query}${Keys.ENTER}`, milliseconds => recordTypeTiming('cwd-typeInTerminal', milliseconds), markInputReturn);
    const result = await waitForRow(ctx, row => isCwdOutput(row, expected, ctx.platform), 'actual shell cwd output');
    recordTiming(phase, 'cwd-send-to-row', cwdStarted);
    return result;
  }
  let expected;
  let filled;
  let phase = 'open';
  let tracing = false;
  let succeeded = false;
  try {
    expected = await realpath(directory);
    if (shell) {
      await inPage(session, installTerminalTrace, shell, expected, { stageTiming: ctx.webviewTiming === true });
      tracing = true;
    }
    await clickCss(session, '#local-options-open');
    await waitFor(() => inPage(session, () => document.querySelector('#local-dialog')?.open === true),
      { description: 'local startup options dialog' });
    // Windows TEMP may contain RUNNER~1, while realpath resolves the long name.
    // Send the same physical spelling we assert; do not accept a partial path.
    filled = await fill(ctx, '#local-cwd-input', expected);
    await waitFor(() => inPage(session, (value) => {
      const select = document.querySelector('#local-shell-select');
      const option = select && [...select.options].find(option => option.value === value);
      return !!option && !option.disabled && !select.disabled;
    }, shell ?? ''), { description: `available ${shell ?? 'default'} shell option` });
    selected = await inPage(session, (value) => {
      const select = document.querySelector('#local-shell-select');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: select.value, label: select.selectedOptions[0]?.textContent };
    }, shell ?? '');
    if (selected.value !== (shell ?? '')) throw new Error('shell selection did not stick');
    if (shell) {
      // Diagnostic repetitions run after the environment scenario. Reset its
      // retained form draft so these remain the original default-env fixtures.
      while (await inPage(session, () => !!document.querySelector('[data-env-remove]')))
        await clickCss(session, '[data-env-remove]');
      await inPage(session, () => {
        const select = document.querySelector('#local-locale-mode');
        select.value = 'default';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    if (tracing) await inPage(session, () => window.__P1_NATIVE_SHELL_TRACE__.arm());
    const initialOpenStarted = ctx.webviewTiming ? performance.now() : 0;
    await clickCss(session, '#local-start');
    await waitFor(async () => (await tabCount(session)) === before + 1, { description: 'custom cwd local tab' });
    await waitForSessionState(ctx, '本机 shell 已启动', 'custom cwd PTY startup');
    recordTiming('initial cwd query', 'open-to-ready', initialOpenStarted);
    phase = 'initial cwd query';
    const initial = await queryCwd();
    await typeInTerminal(ctx, `exit 7${Keys.ENTER}`);
    await waitForSessionState(ctx, '已退出 · code 7', 'custom cwd shell exit');
    if (tracing) await inPage(session, () => window.__P1_NATIVE_SHELL_TRACE__.arm());
    const reopenedOpenStarted = ctx.webviewTiming ? performance.now() : 0;
    await clickCss(session, '#local-reopen');
    await waitFor(async () => (await tabCount(session)) === before + 2, { description: 'reopened custom cwd tab' });
    await waitForSessionState(ctx, '本机 shell 已启动', 'reopened custom cwd PTY startup');
    recordTiming('reopened cwd query', 'open-to-ready', reopenedOpenStarted);
    phase = 'reopened cwd query';
    const reopened = await queryCwd();
    if (shell && identities[0] !== identities[1]) throw new Error('reopened shell version changed');
    await typeInTerminal(ctx, `exit 7${Keys.ENTER}`);
    await waitForSessionState(ctx, '已退出 · code 7', 'reopened custom startup shell exit');
    await ctx.writeText(`${artifact}.txt`, rowsText({ initial: initial.rows, reopened: reopened.rows }));
    await ctx.screenshot(artifact);
    await clickCss(session, newTab);
    await closeActiveTab(ctx, before + 1);
    await clickCss(session, oldTab);
    await closeActiveTab(ctx, before);
    const remainingTabs = await tabCount(session);
    succeeded = true;
    return { directory, expected, filled, shell, selected, identities, query, initialCwd: initial.row, reopenedCwd: reopened.row,
      ...(ctx.webviewTiming ? { timings } : {}), remainingTabs };
  } catch (error) {
    // The runner captures after this function returns, when finally has already
    // closed the terminal. Preserve the actual failing shell before cleanup.
    try {
      await ctx.writeText(`${artifact}-failure.json`, `${JSON.stringify({
        directory, expected, filled, shell, selected, identities, query, phase,
        ...(ctx.webviewTiming ? { timings } : {}), error: String(error?.stack ?? error),
        status: await statusLine(session), rows: await terminalRows(session),
      }, null, 2)}\n`);
    } catch (captureError) {
      ctx.log(`cwd failure text unavailable: ${captureError.message}`);
    }
    await ctx.screenshot(`${artifact}-failure`)
      .catch(captureError => ctx.log(`cwd failure screenshot unavailable: ${captureError.message}`));
    throw error;
  } finally {
    try {
      if (tracing) {
        const trace = await inPage(session, () => window.__P1_NATIVE_SHELL_TRACE__.stop());
        await ctx.writeText(`${artifact}-trace.json`, `${JSON.stringify(trace)}\n`);
        if (succeeded && (trace.incomplete || trace.truncated)) {
          throw new Error('shell diagnostic trace is incomplete or truncated; inspect its trace artifact');
        }
      }
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
  { name: 'local-terminal-shell', run: localTerminalShell },
  { name: 'local-terminal-environment', run: localTerminalEnvironment },
]);
