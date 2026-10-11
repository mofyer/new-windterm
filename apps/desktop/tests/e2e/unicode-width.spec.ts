import { test, expect, type Page } from '@playwright/test';

async function terminalCells(page: Page, input: string, baseline = false) {
  await page.goto('/');
  return page.evaluate(async ({ input, baseline }) => {
    const modulePath = baseline ? '/node_modules/@xterm/xterm/lib/xterm.mjs' : '/src/terminal.ts';
    const module = await import(/* @vite-ignore */ modulePath);
    const terminal = baseline ? new module.Terminal({ allowProposedApi: true }) : module.createWorkspaceTerminal();
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-10000px;width:800px;height:500px';
    document.body.append(holder);
    terminal.open(holder);
    terminal.resize(80, 24);
    try {
      await new Promise<void>(resolve => terminal.write(input, resolve));
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(0);
      return {
        version: terminal.unicode.activeVersion,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        text: line.translateToString(true),
        cells: Array.from({ length: 20 }, (_, col) => ({ chars: line.getCell(col).getChars(), width: line.getCell(col).getWidth() })),
      };
    } finally { terminal.dispose(); holder.remove(); }
  }, { input, baseline });
}

for (const [text, width] of [['🌏', 2], ['👋', 2], ['中', 2], ['é', 1]] as const) {
  test(`workspace terminal gives ${text} exactly ${width} columns`, async ({ page }) => {
    const result = await terminalCells(page, text);
    expect(result.cells[0]).toEqual({ chars: text, width });
    expect(result.cursorX).toBe(width);
  });
}
test('workspace terminal shell-style cursor redraw preserves emoji and trailing sentinel', async ({ page }) => {
  // zsh/readline assumes 🌏 occupies 2 columns: after A🌏BC, move left 2 and replace B.
  const result = await terminalCells(page, 'A🌏BC\x1b[2DX');
  expect(result.text).toBe('A🌏XC');
  expect(result.cells[1]).toEqual({ chars: '🌏', width: 2 });
  expect(result.cells[3].chars).toBe('X');
  expect(result.cells[4].chars).toBe('C');
  expect(result.cursorX).toBe(4);
});
test('default Unicode6 baseline reproduces old globe width mismatch', async ({ page }, testInfo) => {
  const result = await terminalCells(page, 'A🌏BC\x1b[2DX', true);
  await testInfo.attach('unicode6-width-regression-baseline.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.version).toBe('6');
  expect(result.cells[1].width).toBe(1);
  expect(result.cursorX).toBe(3);
});
