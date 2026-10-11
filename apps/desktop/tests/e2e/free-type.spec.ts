import { test, expect, type Page } from '@playwright/test';

// Isolated G03 experiment: a local draft editor overlaid at the cursor. The
// stubbed `submit` stands in for the PTY write; no shell is involved.
async function harness(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { Terminal } = await import(/* @vite-ignore */ '/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { FreeTypeDraft } = await import(/* @vite-ignore */ '/src/terminal-compat/free-type.ts');
    document.body.replaceChildren();
    const host = document.createElement('div');
    host.style.cssText = 'width:640px;height:240px;font:14px monospace';
    document.body.append(host);
    const terminal = new Terminal({ cols: 60, rows: 10, allowProposedApi: true });
    terminal.open(host);
    const state = { data: [] as string[], submitted: [] as string[] };
    terminal.onData((data: string) => state.data.push(data));
    const draft = new FreeTypeDraft(terminal, host, { submit: (text: string) => state.submitted.push(text) });
    await new Promise<void>(resolve => terminal.write('P0 $ ', resolve));
    Object.assign(window, { ftQa: { terminal, draft, state } });
  });
}
const state = (page: Page) => page.evaluate(() => (window as any).ftQa.state);

test('drafting sends nothing to the shell until Enter, then sends the edited text once', async ({ page }) => {
  await harness(page);
  await page.evaluate(() => (window as any).ftQa.draft.start());
  await expect(page.locator('.free-type-draft')).toBeFocused();
  await page.keyboard.type('echo hello');
  await page.keyboard.press('Home');
  await page.keyboard.type('X');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('End');
  await page.keyboard.type(' 中文');
  expect(await state(page)).toEqual({ data: [], submitted: [] });
  await page.keyboard.press('Enter');
  expect(await state(page)).toEqual({ data: [], submitted: ['echo hello 中文\r'] });
  await expect(page.locator('.free-type-draft')).toBeHidden();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

test('multi-line paste waits for Enter; Shift+Enter adds a line', async ({ page }) => {
  await harness(page);
  await page.evaluate(() => (window as any).ftQa.draft.start());
  await page.keyboard.insertText('ls -la\nrm -rf /tmp/p0-should-not-run');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('pwd');
  expect((await state(page)).submitted).toEqual([]);
  await page.keyboard.press('Enter');
  expect((await state(page)).submitted).toEqual(['ls -la\rrm -rf /tmp/p0-should-not-run\rpwd\r']);
  expect((await state(page)).data).toEqual([]);
});

test('Escape discards the draft without sending anything', async ({ page }) => {
  await harness(page);
  await page.evaluate(() => (window as any).ftQa.draft.start('git push --force'));
  await page.keyboard.press('Escape');
  expect(await state(page)).toEqual({ data: [], submitted: [] });
  expect(await page.evaluate(() => (window as any).ftQa.draft.isActive())).toBe(false);
});

test('Enter during IME composition does not submit', async ({ page }) => {
  await harness(page);
  await page.evaluate(() => (window as any).ftQa.draft.start('ni'));
  await page.locator('.free-type-draft').dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  expect((await state(page)).submitted).toEqual([]);
  await page.keyboard.press('Enter');
  expect((await state(page)).submitted).toEqual(['ni\r']);
});

test('the overlay starts at the cursor cell and follows resize', async ({ page }) => {
  await harness(page);
  const geometry = await page.evaluate(async () => {
    const { terminal, draft } = (window as any).ftQa;
    draft.start('draft');
    const screen = document.querySelector<HTMLElement>('.xterm-screen')!;
    const cell = screen.clientWidth / terminal.cols;
    const before = { left: parseFloat(draft.editor.style.left), cursorX: terminal.buffer.active.cursorX, cell };
    terminal.resize(40, 10);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const after = { width: parseFloat(draft.editor.style.width), cell: screen.clientWidth / terminal.cols, cursorX: terminal.buffer.active.cursorX };
    return { before, after, offset: screen.offsetLeft };
  });
  expect(geometry.before.cursorX).toBe(5);
  expect(Math.abs(geometry.before.left - (geometry.offset + 5 * geometry.before.cell))).toBeLessThan(1);
  expect(Math.abs(geometry.after.width - (40 - geometry.after.cursorX) * geometry.after.cell)).toBeLessThan(1);
});
