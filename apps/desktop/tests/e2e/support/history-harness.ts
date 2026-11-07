import type { CDPSession, Page, TestInfo } from '@playwright/test';

/**
 * Shared helpers of the cold-history specs (P1 slice 5, steps 5 and 6). The workbench's own
 * archives and terminals are found through the heap (CDP `Runtime.queryObjects`), not by
 * importing history-archive.ts into the test page: after a source edit the dev server serves the
 * app's copy under a `?t=` URL, which would give the page a second, unrelated module instance.
 *
 * Environment: Chrome + Vite dev server + IPC stub. Nothing here reaches WKWebView, WebView2,
 * WebKitGTK, Tauri IPC or a Rust PTY.
 */
export const CHUNK = 4096; // Rust PtyEvent::Data block size
const GROUP = 'history-harness';

/** Page helpers as `window.captureQa`: the app's Terminal prototype and a mixed-content line generator. */
export async function installModules(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const terminal = await import('/src/terminal.ts');
    const probe = terminal.createWorkspaceTerminal();
    const terminalPrototype = Object.getPrototypeOf(probe);
    probe.dispose();
    const id = (i: number) => String(i).padStart(6, '0');
    /** One logical line of the mixed stream, with its expected plain text. */
    const line = (i: number): { raw: string; plain: string } => {
      switch (i % 7) {
        case 0: return { raw: `${id(i)} 中文宽字符 🌏 表格`, plain: `${id(i)} 中文宽字符 🌏 表格` };
        case 1: return {
          raw: `\x1b[1;31m${id(i)} red\x1b[0m plain \x1b[38;2;10;20;30mrgb\x1b[0m`,
          plain: `${id(i)} red plain rgb`,
        };
        // Wraps over several rows at any workbench width.
        case 2: return { raw: `${id(i)} ${'abcdefghij'.repeat(25)}末`, plain: `${id(i)} ${'abcdefghij'.repeat(25)}末` };
        case 3: return { raw: '', plain: '' };
        // Combining accent, ZWJ family, skin tone modifier.
        case 4: return { raw: `${id(i)} é 👨‍👩‍👧 👍🏽`, plain: `${id(i)} é 👨‍👩‍👧 👍🏽` };
        // Wide characters across row boundaries leave wrap padding in xterm.
        case 5: return { raw: `${id(i)} ${'漢字'.repeat(80)}`, plain: `${id(i)} ${'漢字'.repeat(80)}` };
        default: return { raw: `${id(i)} plain ascii line`, plain: `${id(i)} plain ascii line` };
      }
    };
    const encode = (lines: string[]) => new TextEncoder().encode(lines.map((l) => `${l}\r\n`).join(''));
    const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
    (window as any).captureQa = { ...terminal, terminalPrototype, line, encode, stripSgr };
  });
}

// V8 also names the synthetic class-field initializer after the class; it has no prototype.
const CLASSES = {
  archivePrototype: "f => f.name === 'HistoryArchive' && typeof f.prototype?.capture === 'function'",
  // The read-only history view (step 7).
  viewPrototype: "f => f.name === 'HistoryView' && typeof f.prototype?.refresh === 'function'",
} as const;

export type LivePrototype = 'terminalPrototype' | keyof typeof CLASSES;

/** The prototype `fn` applies to: the app's xterm Terminal, HistoryArchive or HistoryView class. */
async function prototypeId(cdp: CDPSession, prototype: LivePrototype): Promise<string> {
  if (prototype === 'terminalPrototype') {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.captureQa.terminalPrototype', objectGroup: GROUP });
    return result.objectId!;
  }
  const test = CLASSES[prototype];
  const { result: functionPrototype } = await cdp.send('Runtime.evaluate', { expression: 'Function.prototype', objectGroup: GROUP });
  const { objects: functions } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: functionPrototype.objectId!, objectGroup: GROUP });
  const { result: classes } = await cdp.send('Runtime.callFunctionOn', {
    objectId: functions.objectId!, objectGroup: GROUP, returnByValue: true,
    functionDeclaration: `function () { return this.filter(${test}).length; }`,
  });
  if (classes.value !== 1) throw new Error(`expected one ${prototype} class, found ${classes.value}`);
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: functions.objectId!, objectGroup: GROUP,
    functionDeclaration: `function () { return this.find(${test}).prototype; }`,
  });
  return result.objectId!;
}

/** Live objects with the given prototype after a full GC, then `fn` on that array. */
export async function onLive<T>(cdp: CDPSession, prototype: LivePrototype, fn: string): Promise<T> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: await prototypeId(cdp, prototype), objectGroup: GROUP });
  const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId!, functionDeclaration: fn, returnByValue: true, awaitPromise: true,
  });
  // The inspector holds every object it returned until the group is released.
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: GROUP });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value as T;
}
export const liveArchives = (cdp: CDPSession) => onLive<number>(cdp, 'archivePrototype', 'function () { return this.length; }');
export const liveTerminals = (cdp: CDPSession) => onLive<number>(cdp, 'terminalPrototype', 'function () { return this.length; }');
export const liveViews = (cdp: CDPSession) => onLive<number>(cdp, 'viewPrototype', 'function () { return this.length; }');

export const diagnostics = (page: Page) =>
  page.evaluate(() => (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot() as Record<string, number>);

export async function record(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  console.log(`${name} ${JSON.stringify(value)}`);
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}
