import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Isolated T09 experiment: @xterm/addon-image 0.9.0 on @xterm/xterm 6.0.0 with the DOM
// renderer, loaded through src/terminal-compat/sixel-image.ts. Nothing here is wired into the
// production terminal. Results are recorded in docs/p0/TERMINAL_CORE_ADR.zh-CN.md.

const ESC = '\x1b';
const ST = `${ESC}\\`;
// 12 x 36 px: six bands of six pixel rows; columns 0-5 red, 6-11 blue.
const BAND = '#0!6~#1!6~';
const SIXEL_12X36 = `${ESC}P0;1;0q"1;1;12;36#0;2;100;0;0#1;2;0;0;100${Array(6).fill(BAND).join('-')}${ST}`;
// Declares 100 x 100 px: over a 64 x 64 pixel limit before any pixel is decoded.
const SIXEL_OVER_PIXELS = `${ESC}P0;1;0q"1;1;100;100#0;2;100;0;0#0!100~${ST}`;
// A 1 x 6 px image whose payload is padded with redundant colour selections.
const sixelPadded = (selections: number) => `${ESC}Pq#0;2;0;100;0${'#0'.repeat(selections)}~${ST}`;
// 1 x 1 PNG for the iTerm2 inline image protocol (OSC 1337).
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const iip = (base64: string) => `${ESC}]1337;File=inline=1;size=${atob(base64).length}:${base64}\x07`;

const tauriConf = JSON.parse(readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'));
const PRODUCTION_CSP: string = tauriConf.app.security.csp;

interface Setup { overrides?: Record<string, unknown>; raw?: boolean; timeoutMs?: number }

// raw: load the addon directly, bypassing the prototype's WebAssembly and readiness checks.
async function open(page: Page, setup: Setup = {}) {
  return page.evaluate(async ({ overrides = {}, raw = false, timeoutMs }) => {
    const { Terminal } = await import(/* @vite-ignore */ '/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { ImageAddon } = await import(/* @vite-ignore */ '/node_modules/@xterm/addon-image/lib/addon-image.mjs');
    const compat = await import(/* @vite-ignore */ '/src/terminal-compat/sixel-image.ts');
    (window as any).sxQa?.term.dispose();
    document.body.replaceChildren();
    const host = document.createElement('div');
    host.style.cssText = 'width:640px;height:320px';
    document.body.append(host);
    const term = new Terminal({ cols: 40, rows: 12, allowProposedApi: true });
    term.open(host);
    const replies: string[] = [];
    term.onData((data: string) => replies.push(data));
    let result: { status: string; reason?: string; addon?: unknown };
    if (raw) {
      const addon = new ImageAddon({ ...compat.SIXEL_LIMITS, ...overrides });
      term.loadAddon(addon);
      result = { status: 'raw', addon };
    } else {
      result = await compat.attachSixel(term, ImageAddon, overrides, timeoutMs);
    }
    const write = (data: string) => new Promise<void>(resolve => term.write(data, resolve));
    Object.assign(window, { sxQa: { term, host, replies, result, write, compat } });
    return { status: result.status, reason: result.reason ?? '' };
  }, setup);
}

// Writes the sequences, waits two frames, then reports what the addon and the screen hold.
async function observe(page: Page, sequences: string[]) {
  return page.evaluate(async (sequences: string[]) => {
    const { term, host, replies, result, write } = (window as any).sxQa;
    const addon = result.addon;
    for (const sequence of sequences) await write(sequence);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
    const buffer = term.buffer.active;
    const tiles: string[] = [];
    for (let y = 0; y < term.rows; y++) {
      for (let x = 0; x < term.cols; x++) if (addon?.getImageAtBufferCell(x, y)) tiles.push(`${x},${y}`);
    }
    const layer = host.querySelector('.xterm-screen canvas.xterm-image-layer') as HTMLCanvasElement | null;
    let red = 0;
    let blue = 0;
    const context = layer && layer.width && layer.height ? layer.getContext('2d') : null;
    if (layer && context) {
      const data = context.getImageData(0, 0, layer.width, layer.height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 200 && data[i] > 200 && data[i + 2] < 50) red++;
        if (data[i + 3] > 200 && data[i + 2] > 200 && data[i] < 50) blue++;
      }
    }
    return {
      cell: { width: screen.width / term.cols, height: screen.height / term.rows },
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      lines: Array.from({ length: 3 }, (_, y) => buffer.getLine(y).translateToString(true)),
      tiles,
      layer: Boolean(layer), red, blue,
      usage: addon?.storageUsage ?? -1,
      replies: replies.splice(0).join(''),
    };
  }, sequences);
}

async function imageAt(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const image = (window as any).sxQa.result.addon.getImageAtBufferCell(x, y) as HTMLCanvasElement | undefined;
    if (!image) return null;
    const pixel = (px: number, py: number) => Array.from(image.getContext('2d')!.getImageData(px, py, 1, 1).data);
    return { width: image.width, height: image.height, left: pixel(2, 30), right: pixel(9, 3) };
  }, { x, y });
}

function servedWithCsp(page: Page, csp: string) {
  return page.route('**/csp-probe.html', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    headers: { 'content-security-policy': csp },
    body: '<!doctype html><meta charset="utf-8"><title>csp probe</title><body></body>',
  }));
}

test('decodes a SIXEL image into cell tiles and the image layer', async ({ page }) => {
  await page.goto('/');
  expect(await open(page)).toEqual({ status: 'ready', reason: '' });
  const drawn = await observe(page, ['A', SIXEL_12X36]);
  const cols = Math.ceil(12 / drawn.cell.width);
  const rows = Math.ceil(36 / drawn.cell.height);
  const expectedTiles = [];
  for (let y = 0; y < rows; y++) for (let x = 1; x <= cols; x++) expectedTiles.push(`${x},${y}`);
  expect(drawn.tiles).toEqual(expectedTiles);
  // With SIXEL scrolling the cursor ends on the image's last row, at its first column.
  expect(drawn.cursor).toEqual({ x: 1, y: rows - 1 });
  expect(drawn.layer).toBe(true);
  expect(drawn.red).toBeGreaterThan(0);
  expect(drawn.blue).toBeGreaterThan(0);
  expect(drawn.usage).toBeGreaterThan(0);
  expect(await imageAt(page, 1, 0)).toEqual({ width: 12, height: 36, left: [255, 0, 0, 255], right: [0, 0, 255, 255] });
  console.log(`[sixel] cell ${drawn.cell.width.toFixed(2)}x${drawn.cell.height.toFixed(2)} px, tiles ${drawn.tiles.join(' ')}, cursor ${drawn.cursor.x},${drawn.cursor.y}, layer red ${drawn.red} blue ${drawn.blue}, storage ${drawn.usage.toFixed(6)} MB`);

  // Text written over a tile removes only that tile.
  const overwritten = await observe(page, [`${ESC}[1;2HZ`]);
  expect(overwritten.tiles).toEqual(expectedTiles.filter(tile => tile !== '1,0'));
  expect(overwritten.lines[0]).toBe('AZ');

  // The addon answers DA1 itself (VT220 + SIXEL), and XTSMGRAPHICS; size reports stay closed.
  expect((await observe(page, [`${ESC}[c`])).replies).toBe(`${ESC}[?62;4;9;22c`);
  expect((await observe(page, [`${ESC}[?1;1S`])).replies).toBe(`${ESC}[?1;0;256S`);
  expect((await observe(page, [`${ESC}[?2;1S`])).replies).toMatch(/^\x1b\[\?2;0;\d+;\d+S$/);
  expect((await observe(page, [`${ESC}[14t`, `${ESC}[16t`])).replies).toBe('');
});

test('drops SIXEL data over the pixel or byte limit and keeps parsing the stream', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  await page.goto('/');
  expect((await open(page, { overrides: { pixelLimit: 64 * 64, sixelSizeLimit: 2048 } })).status).toBe('ready');

  const overPixels = await observe(page, ['A', SIXEL_OVER_PIXELS, 'B']);
  expect(overPixels.tiles).toEqual([]);
  expect(overPixels.lines[0]).toBe('AB');
  expect(overPixels.cursor).toEqual({ x: 2, y: 0 });

  const overBytes = await observe(page, ['C', sixelPadded(1500), 'D']);
  expect(overBytes.tiles).toEqual([]);
  expect(overBytes.lines[0]).toBe('ABCD');
  expect(overBytes.usage).toBe(0);
  // These are the addon's internal console messages (not public API); they only identify which
  // limit fired and may change when the exact-pinned addon is upgraded.
  expect(warnings.some(text => text.includes('too much data'))).toBe(true);
  expect(warnings.some(text => text.includes('image exceeds memory limit'))).toBe(true);

  // Control: the same padded shape under the byte limit is decoded.
  const underBytes = await observe(page, [sixelPadded(100)]);
  expect(underBytes.tiles).toEqual(['4,0']);
});

test('prototype limits leave the iTerm2 inline image protocol (OSC 1337) unhandled', async ({ page }) => {
  await page.goto('/');
  expect((await open(page)).status).toBe('ready');
  const ignored = await observe(page, ['A', iip(PNG_1X1), 'B']);
  // Negative check: with iipSupport off the addon registers no OSC 1337 handler, so nothing is
  // pending. The fixed wait only covers the browser's async PNG decode, which the control test
  // below shows completes for the same image when the handler is on.
  await page.waitForTimeout(300);
  expect((await observe(page, [])).tiles).toEqual([]);
  expect(ignored.lines[0]).toBe('AB');
});

test('control: with iipSupport the same OSC 1337 PNG is decoded by the browser', async ({ page }) => {
  await page.goto('/');
  expect((await open(page, { raw: true, overrides: { iipSupport: true } })).status).toBe('raw');
  await observe(page, ['A', iip(PNG_1X1)]);
  await expect.poll(async () => (await observe(page, [])).tiles).toEqual(['1,0']);
});

test('a decoder that is not ready in time unloads the addon, so DA1 does not claim SIXEL', async ({ page }) => {
  await page.goto('/');
  // The decoder is instantiated asynchronously, so a zero budget always times out.
  expect(await open(page, { timeoutMs: 0 })).toEqual({ status: 'decoder-timeout', reason: '' });
  const fallback = await observe(page, [`${ESC}[c`, `${ESC}[?1;1S`, 'A', SIXEL_12X36, 'B']);
  expect(fallback.replies).toBe(`${ESC}[?1;2c`);
  expect(fallback.lines[0]).toBe('AB');
});

test('the production CSP blocks the WebAssembly decoder; raw addon still claims SIXEL in DA1', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await servedWithCsp(page, PRODUCTION_CSP);
  await page.goto('/csp-probe.html');

  const guarded = await open(page);
  expect(guarded.status).toBe('wasm-blocked');
  expect(guarded.reason).toContain('WebAssembly');

  await open(page, { raw: true });
  const raw = await observe(page, [`${ESC}[c`, 'A', SIXEL_12X36, 'B']);
  expect(raw.replies).toBe(`${ESC}[?62;4;9;22c`);
  expect(raw.tiles).toEqual([]);
  expect(raw.lines[0]).toBe('AB');
  await expect.poll(() => errors.some(message => message.includes('WebAssembly'))).toBe(true);
  console.log(`[sixel] production CSP: guard reason "${guarded.reason}"; raw addon page error "${errors.find(message => message.includes('WebAssembly'))}"`);
});

test("adding 'wasm-unsafe-eval' to the production CSP lets the decoder run", async ({ page }) => {
  const csp = PRODUCTION_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toBe(PRODUCTION_CSP);
  await servedWithCsp(page, csp);
  await page.goto('/csp-probe.html');
  expect(await open(page)).toEqual({ status: 'ready', reason: '' });
  const drawn = await observe(page, ['A', SIXEL_12X36]);
  expect(drawn.tiles.length).toBeGreaterThan(0);
  expect(await imageAt(page, 1, 0)).toEqual({ width: 12, height: 36, left: [255, 0, 0, 255], right: [0, 0, 255, 255] });
});
