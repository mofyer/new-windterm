import { test, expect } from '@playwright/test';
import { MODES, Term } from './input-harness';

// Composition probes driven by CDP `Input.imeSetComposition` / `Input.insertText`. This is
// Chromium's simulated IME on the real page, not the macOS input method, WKWebView or VoiceOver.
const LANGUAGES = [
  { name: 'Chinese pinyin', steps: ['n', 'ni', 'ni h', 'ni hao', '你好'], commit: '你好' },
  { name: 'Japanese romaji to kanji', steps: ['k', 'か', 'かn', 'かんj', 'かんじ', '漢字'], commit: '漢字' },
] as const;

async function expectViewAtCursor(t: Term, text: string) {
  const view = await t.compositionView();
  expect(view).toMatchObject({ text, active: true });
  expect(Math.abs(view.left - view.cellLeft)).toBeLessThan(1);
  expect(Math.abs(view.top - view.cellTop)).toBeLessThan(1);
}

for (const mode of MODES) {
  test.describe(`${mode} composition`, () => {
    for (const language of LANGUAGES) {
      test(`${language.name}: nothing is sent while composing; the commit is sent once as UTF-8`, async ({ page }) => {
        const t = await Term.open(page, mode);
        await t.output('\r\nhost 中文 % ');
        await t.reset();
        const start = await t.cursor();
        for (const step of language.steps) {
          await t.compose(step);
          await t.settle();
          expect(await t.dataEvents()).toEqual([]);
          await expectViewAtCursor(t, step);
          // The preedit is an overlay: the buffer and cursor do not move until the commit.
          expect(await t.cursor()).toEqual(start);
        }
        await t.insertText(language.commit);
        await t.settle();
        expect(await t.dataEvents()).toEqual([language.commit]);
        expect(await t.delivered()).toBe(language.commit);
        if (mode !== 'demo') {
          const bytes = await page.evaluate(() => (window as any).qaIpc.writes.flatMap((w: Uint8Array) => [...w]));
          expect(bytes).toEqual([...Buffer.from(language.commit, 'utf8')]);
        } else {
          expect(await t.row()).toContain(`% ${language.commit}`);
        }
        expect((await t.compositionView()).active).toBe(false);
      });
    }

    test('cancelled composition sends nothing, not even the Escape that cancelled it', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      await t.compose('r');
      await t.compose('り');
      await t.imeKey('Escape');
      await t.compose('');
      await t.settle();
      expect(await t.dataEvents()).toEqual([]);
      expect((await t.compositionView()).active).toBe(false);
      await page.keyboard.type('x');
      await t.settle();
      expect(await t.delivered()).toBe('x');
    });

    test('Enter that picks a candidate is not sent; the next Enter is', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      await t.compose('zhong');
      await t.imeKey('Enter');
      await t.insertText('中');
      await t.settle();
      expect(await t.dataEvents()).toEqual(['中']);
      await page.keyboard.press('Enter');
      await t.settle();
      expect(await t.dataEvents()).toEqual(['中', '\r']);
    });

    test('back-to-back compositions commit in order without loss or repeats', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      for (const [preedit, commit] of [['zhong', '中'], ['wen', '文'], ['にほんご', '日本語'], ['😀', '😀']]) {
        await t.compose(preedit);
        await t.insertText(commit);
      }
      await page.keyboard.type('ok');
      await t.settle();
      expect(await t.delivered()).toBe('中文日本語😀ok');
    });

    test('text inserted without a key press (emoji viewer, dictation) is sent once', async ({ page }) => {
      const t = await Term.open(page, mode);
      expect(await page.evaluate(() => (window as any).qa.terminal.options.screenReaderMode)).toBe(true);
      await t.reset();
      await t.insertText('👍🏽');
      await t.insertText('🇨🇳');
      await page.keyboard.type('ab');
      await t.settle();
      expect(await t.dataEvents()).toEqual(['👍🏽', '🇨🇳', 'a', 'b']);
      expect(await t.delivered()).toBe('👍🏽🇨🇳ab');
    });

    test('the composition view follows the cursor after output moves it', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.output('\r\n\r\n宽字符 wide 🌏 % ');
      await t.compose('pin');
      await t.settle();
      await expectViewAtCursor(t, 'pin');
      await t.output('\r\nmore output 输出\r\n$ ');
      await t.compose('pinyin');
      await t.settle();
      await expectViewAtCursor(t, 'pinyin');
      await t.insertText('拼音');
      await t.settle();
      expect(await t.data()).toBe('拼音');
    });
  });
}

for (const mode of ['pty', 'ssh'] as const) {
  test(`${mode}: composing during heavy output loses neither output nor the commit`, async ({ page }) => {
    const t = await Term.open(page, mode);
    await t.reset();
    await t.startStream(30000);
    await t.compose('z');
    await t.compose('zhong');
    await page.waitForTimeout(50);
    await t.compose('zhong guo');
    expect(await t.dataEvents()).toEqual([]);
    await t.insertText('中国');
    await page.waitForTimeout(50);
    await t.compose('ren');
    await t.streamFinished();
    await t.settle();
    await expectViewAtCursor(t, 'ren');
    await t.insertText('人');
    await t.settle();
    expect(await t.dataEvents()).toEqual(['中国', '人']);
    expect(await t.sent()).toBe('中国人');
    // Every numbered line arrived in order: the tail of the scrollback ends at the last number.
    const tail = await page.evaluate(() => {
      const b = (window as any).qa.terminal.buffer.active;
      return Array.from({ length: 4 }, (_, i) => b.getLine(b.baseY + b.cursorY - 3 + i).translateToString(true));
    });
    expect(tail).toEqual([
      'line 029997 输出 🌏 output',
      'line 029998 输出 🌏 output',
      'line 029999 输出 🌏 output',
      'STREAM-END',
    ]);
  });
}

test('demo: composing while the stress sample streams sends the commit once', async ({ page }) => {
  const t = await Term.open(page, 'demo');
  await page.keyboard.type('stress');
  await page.keyboard.press('Enter');
  await expect(page.locator('#terminal-state')).toContainText('持续输出中');
  await t.reset();
  await t.compose('zhong');
  await page.waitForTimeout(100);
  await t.compose('zhong guo');
  expect(await t.dataEvents()).toEqual([]);
  await t.insertText('中国');
  await t.settle();
  expect(await t.dataEvents()).toEqual(['中国']);
  await page.keyboard.press('Control+c');
  await expect(page.locator('#terminal-state')).toContainText('演示就绪');
});
