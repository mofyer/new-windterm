import { test, expect } from '@playwright/test';
import { MODES, Term } from './input-harness';

// Cell widths are xterm.js 6.0.0 + Unicode 11 addon facts on the real page, written as raw UTF-8
// through each mode's output path. They are not checked against a shell's wcwidth or macOS fonts.
// `cells` lists the columns after the leading "A" up to and including the trailing "Z".
const WIDTHS = [
  { name: 'CJK ideograph', text: '中', cells: [['中', 2], ['', 0], ['Z', 1]] },
  { name: 'katakana', text: 'ア', cells: [['ア', 2], ['', 0], ['Z', 1]] },
  { name: 'Hangul syllable', text: '한', cells: [['한', 2], ['', 0], ['Z', 1]] },
  { name: 'fullwidth Latin', text: 'Ａ', cells: [['Ａ', 2], ['', 0], ['Z', 1]] },
  { name: 'halfwidth katakana', text: 'ｱ', cells: [['ｱ', 1], ['Z', 1]] },
  { name: 'emoji', text: '🌏', cells: [['🌏', 2], ['', 0], ['Z', 1]] },
  // Known gaps: no grapheme clustering, so these do not occupy one 2-column glyph.
  { name: 'ZWJ family (3 cells, 6 columns)', text: '👨‍👩‍👧', cells: [['👨‍', 2], ['', 0], ['👩‍', 2], ['', 0], ['👧', 2], ['', 0], ['Z', 1]] },
  { name: 'flag (two narrow regional indicators)', text: '🇨🇳', cells: [['🇨', 1], ['🇳', 1], ['Z', 1]] },
  { name: 'skin tone (4 columns)', text: '👍🏽', cells: [['👍', 2], ['', 0], ['🏽', 2], ['', 0], ['Z', 1]] },
  { name: 'VS16 heart stays 1 column', text: '❤️', cells: [['❤️', 1], ['Z', 1]] },
  { name: 'keycap stays 1 column', text: '1️⃣', cells: [['1️⃣', 1], ['Z', 1]] },
  { name: 'combining acute joins its base', text: 'é', cells: [['é', 1], ['Z', 1]] },
  { name: 'conjoining jamo join', text: '가', cells: [['가', 2], ['', 0], ['Z', 1]] },
] as const;

for (const mode of MODES) {
  test.describe(`${mode} wide characters`, () => {
    test('Unicode 11 cell widths and cursor advance, with output split inside code points', async ({ page }) => {
      const t = await Term.open(page, mode);
      expect(await page.evaluate(() => (window as any).qa.terminal.unicode.activeVersion)).toBe('11');
      for (const sample of WIDTHS) {
        await t.output('\x1b[2J\x1b[H');
        // 1-byte chunks for pty / ssh: every multi-byte sequence arrives split.
        await t.output(`A${sample.text}Z`, 1);
        const cells = (await t.cells(0, sample.cells.length + 1)).slice(1).map(c => [c.chars, c.width]);
        expect(cells, sample.name).toEqual(sample.cells);
        const columns = sample.cells.reduce((n, [, width]) => n + width, 0);
        expect(await t.cursor(), sample.name).toEqual({ x: 1 + columns, y: 0 });
      }
    });

    test('cursor movement and shell-style erase across wide cells', async ({ page }) => {
      const t = await Term.open(page, mode);
      // Readline/zsh erase a 2-column character with two BS, two spaces, two BS.
      await t.output('\x1b[2J\x1b[HA中B\b\b\b  \b\b');
      expect(await t.row(0)).toBe('A  B');
      expect(await t.cursor()).toEqual({ x: 1, y: 0 });
      // One CUB from after a wide char lands on its second half; writing there splits it.
      await t.output('\x1b[2J\x1b[HA中\x1b[DX');
      expect((await t.cells(0, 3)).map(c => [c.chars, c.width])).toEqual([['A', 1], ['', 1], ['X', 1]]);
      // CUP addresses columns, so a 6-column ZWJ family needs 6 columns of movement.
      await t.output('\x1b[2J\x1b[HA👨‍👩‍👧Z\x1b[1;8HY');
      expect(await t.row(0)).toBe('A👨‍👩‍👧Y');
    });

    test('typed wide characters reach the transport byte for byte, unnormalised', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      const text = '中ア한Ａ🌏👨‍👩‍👧🇨🇳👍🏽❤️1️⃣é가';
      await t.insertText(text);
      await t.settle();
      expect(await t.delivered()).toBe(text);
      if (mode !== 'demo') {
        const bytes = await page.evaluate(() => (window as any).qaIpc.writes.flatMap((w: Uint8Array) => [...w]));
        expect(bytes).toEqual([...Buffer.from(text, 'utf8')]);
      }
    });
  });
}

for (const mode of ['pty', 'ssh'] as const) {
  test(`${mode}: Backspace sends one DEL whatever precedes the cursor; the shell decides what to erase`, async ({ page }) => {
    const t = await Term.open(page, mode);
    await t.insertText('👨‍👩‍👧é中');
    await t.reset();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+Backspace');
    await t.settle();
    expect(await t.sent()).toBe('\x7f\x7f\x7f\x08');
  });
}

test.describe('demo line editor', () => {
  const PROMPT = 'demo ~/workspace % ';
  for (const sample of [...WIDTHS.map(w => w.text), 'क्ष', 'a‍b']) {
    test(`one Backspace erases one user-perceived character: ${JSON.stringify(sample)}`, async ({ page }) => {
      const t = await Term.open(page, 'demo');
      await t.insertText(`x${sample}`);
      await t.settle();
      expect(await t.row()).toBe(`${PROMPT}x${sample}`);
      const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sample)].length;
      for (let i = 0; i < graphemes; i++) await page.keyboard.press('Backspace');
      await t.settle();
      expect(await t.row()).toBe(`${PROMPT}x`);
      expect(await t.cursor()).toMatchObject({ x: PROMPT.length + 1 });
    });
  }

  test('Backspace on a wrapped line of wide characters redraws both rows', async ({ page }) => {
    const t = await Term.open(page, 'demo');
    const cols = await page.evaluate(() => (window as any).qa.terminal.cols);
    const count = Math.ceil((cols - PROMPT.length) / 2) + 2;
    await t.insertText('中'.repeat(count));
    await t.settle();
    const { y } = await t.cursor();
    const above = await t.row(y - 2);
    await page.keyboard.press('Backspace');
    await t.settle();
    const after = await t.cursor();
    expect(after.y).toBe(y);
    expect(await t.row(y - 2)).toBe(above);
    expect((await t.row(y - 1)) + (await t.row(y))).toBe(PROMPT + '中'.repeat(count - 1));
    await page.keyboard.press('Enter');
    await t.settle();
    expect(await t.row(y + 1)).toContain('演示模式');
  });
});
