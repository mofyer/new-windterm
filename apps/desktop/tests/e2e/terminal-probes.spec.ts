import { test, expect, type Page } from '@playwright/test';

// Independent xterm probes. A passing gap probe confirms a limitation, never full VT parity.
async function probe(page: Page) {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/node_modules/@xterm/xterm/lib/xterm.mjs';
    const { Terminal } = await import(/* @vite-ignore */ modulePath);
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-10000px;width:800px;height:500px';
    document.body.append(holder);
    terminal.open(holder);
    const write = (data: string | Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve));
    const line = () => terminal.buffer.active.getLine(0).translateToString(true);
    try {
      const sample = '中文 日本語 café é 👋 🌏';
      const bytes = new TextEncoder().encode(sample);
      for (let i = 0; i < bytes.length; i += 3) await write(bytes.slice(i, i + 3));
      const utf8 = line();
      terminal.reset();
      await write('\x1b[38;2;145;90;190mX\x1b[0m');
      const color = terminal.buffer.active.getLine(0).getCell(0).getFgColor();
      await write('\x1b[?1049hALTERNATE');
      const alternate = terminal.buffer.active.type;
      await write('\x1b[?1049l');
      const restored = line();
      terminal.reset();
      await write('\x1b[?2l\x1bY!#X'); // VT52 row 2, col 4 cursor addressing.
      const vt52 = { row: terminal.buffer.active.cursorY, col: terminal.buffer.active.cursorX, line: line() };
      terminal.reset();
      let response = '';
      const listener = terminal.onData((data: string) => response += data);
      await write('\x1bP$q"p\x1b\\');
      const before = response;
      response = '';
      await write('\x1b[62;1"p\x1bP$q"p\x1b\\'); // Select VT200, then query conformance.
      const after = response;
      response = '';
      await write('\x1b[c'); // Device identity alone does not establish DECSCL support.
      listener.dispose();
      return { utf8, color, alternate, restored, vt52, decscl: { before, after, primaryDA: response } };
    } finally {
      terminal.dispose(); holder.remove();
    }
  });
  return result;
}

test('independent xterm preserves UTF-8 split inside code points', async ({ page }) => {
  expect((await probe(page)).utf8).toBe('中文 日本語 café é 👋 🌏');
});
test('independent xterm represents ANSI true color as RGB', async ({ page }) => {
  expect((await probe(page)).color).toBe(0x915abe);
});
test('independent xterm returns to normal buffer after alternate screen', async ({ page }) => {
  const result = await probe(page);
  expect(result.alternate).toBe('alternate');
  expect(result.restored).toBe('X');
});
test('known gap: xterm VT52 cursor addressing does not match requested row and column', async ({ page }, testInfo) => {
  const result = await probe(page);
  await testInfo.attach('vt52-gap.json', { body: JSON.stringify({ actual: result.vt52, expected: { row: 1, col: 4 } }, null, 2), contentType: 'application/json' });
  expect(result.vt52).not.toMatchObject({ row: 1, col: 4 });
});
test('known gap: DECSCL selecting VT200 leaves conformance query fixed at VT100', async ({ page }, testInfo) => {
  const result = await probe(page);
  await testInfo.attach('decscl-gap.json', { body: JSON.stringify({ ...result.decscl, requestedConformance: '62;1"p', note: 'xterm 6 InputHandler.requestStatusString hardcodes 61;1"p and documents DECSCL unsupported; DA is identity only.' }, null, 2), contentType: 'application/json' });
  expect(result.decscl.before).toBe('\x1bP1$r61;1"p\x1b\\');
  expect(result.decscl.after).toBe(result.decscl.before);
});
