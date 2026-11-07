import { expect, test, type Page } from '@playwright/test';
import { BellPage } from './support/bell-harness';

/**
 * T27 terminal bell, through the production session path with an IPC stub and a counting
 * AudioContext double (see `support/bell-harness.ts`). These are browser contract tests: they do
 * not show that a native WebView plays a sound, nor how WindTerm 2.7.0 behaves.
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('终端响铃（T27）', () => {
  test('默认视觉提示：单次 BEL 在当前标签提示一次，不发声、不标记、照常 ACK', async ({ page }) => {
    const errors = trackErrors(page);
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    await bell.send(a, 'ready\x07');
    expect(await bell.raw(a)).toBe(1);
    expect(await bell.started('flash')).toBe(1);
    expect(await bell.started('steady')).toBe(0);
    await expect.poll(async () => (await bell.cues()).filter((c) => !c.on).length).toBe(1);
    expect(await bell.audio()).toEqual({ contexts: 0, tones: 0, resumes: 0 });
    expect(await bell.marks()).toEqual({ tabs: [], rows: [], notes: [] });
    await expect.poll(() => bell.acks(a)).toEqual([1]);
    expect(await bell.text(a)).toContain('ready');
    expect(errors).toEqual([]);
  });

  test('连续 BEL：同块与逐块的 240 次响铃在默认 2 秒间隔内只提示一次，不弹通知', async ({ page }) => {
    const errors = trackErrors(page);
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    await bell.send(a, '\x07'.repeat(200));
    await bell.send(a, ...Array.from({ length: 20 }, () => '\x07'));
    await bell.send(a, ...Array.from({ length: 20 }, (_, i) => `line ${i}\x07\r\n`));
    expect(await bell.raw(a)).toBe(240);
    expect(await bell.started('flash')).toBe(1);
    expect(await bell.toasts()).toEqual([]);
    const sequence = await bell.sequence(a);
    await expect.poll(() => bell.acks(a)).toEqual(Array.from({ length: sequence }, (_, i) => i + 1));
    expect(errors).toEqual([]);
  });

  test('重复间隔从被接受的那次算起，被忽略的响铃不延长窗口；0 秒仍有 0.4 秒下限', async ({ page }) => {
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    await bell.configure('visual', '1');
    await bell.send(a, '\x07');
    expect(await bell.started()).toBe(1);
    await bell.wait(500);
    await bell.send(a, '\x07');
    expect(await bell.started()).toBe(1);
    // 1.25 s after the accepted bell but only 0.75 s after the ignored one.
    await bell.wait(750);
    await bell.send(a, '\x07');
    expect(await bell.started()).toBe(2);

    await bell.configure('visual', '0');
    await bell.wait(450);
    await bell.send(a, '\x07'.repeat(20));
    expect(await bell.started()).toBe(3);
    await bell.send(a, '\x07');
    expect(await bell.started()).toBe(3);
    await bell.wait(450);
    await bell.send(a, '\x07');
    expect(await bell.started()).toBe(4);
    expect(await bell.raw(a)).toBe(25);
  });

  test('关闭样式：不提示、不发声、不标记；关闭时清除已有标记', async ({ page }) => {
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    const b = await bell.openPty();
    await bell.send(a, '\x07');
    expect((await bell.marks()).tabs).toEqual(['Local 2']);
    await bell.configure('off', '2');
    expect(await bell.marks()).toEqual({ tabs: [], rows: [], notes: [] });
    await bell.wait(450);
    await bell.send(a, '\x07\x07');
    await bell.send(b, '\x07');
    expect(await bell.raw(a)).toBe(3);
    expect(await bell.raw(b)).toBe(1);
    expect(await bell.started('flash')).toBe(0);
    expect(await bell.marks()).toEqual({ tabs: [], rows: [], notes: [] });
    expect(await bell.audio()).toEqual({ contexts: 0, tones: 0, resumes: 0 });
  });

  test('声音样式：替身计数，按会话节流，多个标签共用 0.4 秒发声下限，不做视觉提示', async ({ page }) => {
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    const b = await bell.openPty();
    await bell.configure('sound', '0');
    // Applying the sound style is a user gesture: the context is created and resumed then.
    expect((await bell.audio()).contexts).toBe(1);
    await bell.send(b, '\x07'.repeat(10));
    expect((await bell.audio()).tones).toBe(1);
    await bell.wait(450);
    await bell.send(b, '\x07');
    expect((await bell.audio()).tones).toBe(2);
    await bell.wait(450);
    await bell.send(a, '\x07');
    await bell.send(b, '\x07');
    // Both sessions accepted their bell (the inactive one is marked); one speaker, one tone.
    expect((await bell.audio()).tones).toBe(3);
    expect((await bell.marks()).tabs).toEqual(['Local 2']);
    expect(await bell.started('flash')).toBe(0);
    expect((await bell.audio()).contexts).toBe(1);
  });

  test('声音被 WebView 挂起：不补放、只提示一次；窗口内手势后恢复发声', async ({ page }) => {
    const bell = await BellPage.open(page, { audio: 'suspended' });
    const a = await bell.openPty();
    await bell.configure('sound', '0');
    await bell.send(a, '\x07');
    await expect.poll(() => bell.toasts()).toEqual([expect.stringContaining('WebView 尚未允许播放音频')]);
    await bell.wait(450);
    await bell.send(a, '\x07');
    await bell.wait(350);
    expect(await bell.toasts()).toHaveLength(1);
    expect((await bell.audio()).tones).toBe(0);

    await bell.allowAudio();
    const resumes = (await bell.audio()).resumes;
    await page.locator('.terminal-pane:not([hidden])').click();
    await expect.poll(async () => (await bell.audio()).resumes).toBe(resumes + 1);
    // The dropped bells are not played late.
    await bell.wait(100);
    expect((await bell.audio()).tones).toBe(0);
    await bell.wait(350);
    await bell.send(a, '\x07');
    expect((await bell.audio()).tones).toBe(1);
    expect(await bell.toasts()).toHaveLength(1);
  });

  test('WebView 没有 Web Audio：声音样式提示一次不可用，不影响终端输出', async ({ page }) => {
    const errors = trackErrors(page);
    const bell = await BellPage.open(page, { audio: 'missing' });
    const a = await bell.openPty();
    await bell.configure('sound', '0');
    await bell.send(a, '\x07');
    await bell.wait(450);
    await bell.send(a, 'after\x07');
    expect(await bell.toasts()).toEqual([expect.stringContaining('不支持 Web Audio')]);
    expect(await bell.text(a)).toContain('after');
    await expect.poll(() => bell.acks(a)).toEqual([1, 2]);
    expect(errors).toEqual([]);
  });

  test('非当前标签：标签与侧栏原地加标记，不重建标签栏、不抢焦点，切换后清除', async ({ page }) => {
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    const b = await bell.openPty();
    // Interval 0: every bell below is accepted, so a repaint per accepted bell would show.
    await bell.configure('visual', '0');
    // Closing the sheet returns focus to the terminal first (main.ts), then a keyboard user moves
    // to the active tab: a rebuilt tab strip would drop this focus.
    await expect(page.locator('.terminal-pane:not([hidden]) textarea')).toBeFocused();
    await page.locator('#tabs [role="tab"]', { hasText: 'Local 3' }).focus();
    await page.evaluate(() => {
      const w = window as any;
      w.qaTabRepaints = 0;
      new MutationObserver(() => w.qaTabRepaints++).observe(document.querySelector('#tabs')!, { childList: true });
      w.qaTabA = document.querySelectorAll('#tabs [role="tab"]')[1];
      w.qaFocus = document.activeElement;
    });
    await bell.send(a, '\x07');
    expect(await bell.marks()).toEqual({ tabs: ['Local 2'], rows: ['Local 2'], notes: ['，有新响铃', '，有新响铃'] });
    await expect(page.locator('#tabs [role="tab"]', { hasText: 'Local 2' })).toHaveAccessibleName(/^Local 2\s*，有新响铃$/);
    // The hidden pane gets no flash; the active tab is not marked.
    expect(await bell.started()).toBe(0);
    for (let i = 0; i < 3; i++) {
      await bell.wait(450);
      await bell.send(a, ...Array.from({ length: 10 }, () => '\x07'));
    }
    expect(await page.evaluate(() => {
      const w = window as any;
      return { repaints: w.qaTabRepaints, same: w.qaTabA.isConnected, focus: document.activeElement === w.qaFocus };
    })).toEqual({ repaints: 0, same: true, focus: true });
    await bell.send(b, 'x');
    expect((await bell.marks()).tabs).toEqual(['Local 2']);

    await bell.selectTab('Local 2');
    expect(await bell.marks()).toEqual({ tabs: [], rows: [], notes: [] });
    // Marked again only by a new accepted bell.
    await bell.selectTab('Local 3');
    expect((await bell.marks()).tabs).toEqual([]);
    await bell.wait(450);
    await bell.send(a, '\x07');
    expect((await bell.marks()).tabs).toEqual(['Local 2']);
    await page.locator('#session-list .session-item', { hasText: 'Local 2' }).click();
    expect(await bell.marks()).toEqual({ tabs: [], rows: [], notes: [] });
  });

  test('分屏中可见的非当前窗格：既有视觉提示也加标记；点击窗格后清除', async ({ page }) => {
    const bell = await BellPage.open(page);
    // The split companion is the first other session in order, so the demo tab goes first.
    await page.locator('#tabs .tab', { hasText: 'Getting started' }).locator('.tab-close').click();
    const a = await bell.openPty();
    await bell.openPty();
    await page.locator('#split-toggle').click();
    await expect(page.locator('.terminal-pane:not([hidden])')).toHaveCount(2);
    expect(await page.locator('.terminal-pane:not([hidden])').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))))
      .toEqual(['Local 2 终端', 'Local 3 终端']);
    await bell.send(a, '\x07');
    expect((await bell.cues()).filter((c) => c.on).map((c) => c.pane)).toEqual(['Local 2 终端']);
    expect((await bell.marks()).tabs).toEqual(['Local 2']);
    await page.locator('.terminal-pane[aria-label="Local 2 终端"] textarea').focus();
    expect(await bell.marks()).toEqual({ tabs: [], rows: [], notes: [] });
  });

  test('OSC 以 BEL 结束不响铃；DCS、SOS、PM、APC 内的 BEL 被吞掉；ESC/CSI 中的 BEL 执行（整块、逐切点、逐字节一致）', async ({ page }) => {
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    const samples: [string, number][] = [
      ['\x1b]0;title\x07', 0],
      ['\x1b]2;中文标题\x07', 0],
      ['\x1b]0;a\x07b\x07', 1],
      ['\x1b]0;x\x1b\\\x07', 1],
      ['\x1bP1;2|AB\x07CD\x1b\\', 0],
      ['\x1b_app\x07x\x1b\\', 0],
      ['\x1b^pm\x07\x1b\\', 0],
      ['\x1bXsos\x07\x1b\\', 0],
      ['\x1b[3\x071m', 1],
      ['\x1b\x07[0m', 1],
      ['a\x07\x07b\x07', 3],
      ['中\x07文', 1],
    ];
    for (const [sample, expected] of samples) {
      const runs = await bell.splits(a, sample);
      expect(runs.filter((r) => r.bells !== expected), JSON.stringify(sample)).toEqual([]);
    }
    const sequence = await bell.sequence(a);
    await expect.poll(async () => (await bell.acks(a)).length).toBe(sequence);
    // The OSC title changed but the workbench tab name is not taken from it.
    expect((await bell.marks()).tabs).toEqual([]);
  });

  test('减少动态效果：静态边框不闪烁，连续响铃期间保持，停止后移除一次', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    await bell.configure('visual', '0');
    await bell.send(a, '\x07');
    const pane = page.locator('.terminal-pane:not([hidden])');
    await expect(pane).toHaveClass(/bell-steady/);
    expect(await pane.evaluate((el) => {
      const style = getComputedStyle(el);
      return { animation: style.animationName, shadow: style.boxShadow !== 'none' };
    })).toEqual({ animation: 'none', shadow: true });
    for (let i = 0; i < 3; i++) {
      await bell.wait(450);
      await bell.send(a, '\x07');
    }
    expect(await bell.cues()).toEqual([{ pane: 'Local 2 终端', kind: 'steady', on: true }]);
    await expect.poll(() => bell.cues(), { timeout: 3000 }).toEqual([
      { pane: 'Local 2 终端', kind: 'steady', on: true },
      { pane: 'Local 2 终端', kind: 'steady', on: false },
    ]);
  });

  test('设置面板：命令面板入口、校验、取消、试听、即时生效且只在内存中', async ({ page }) => {
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    await bell.openSettings();
    await expect(page.locator('#bell-style')).toHaveValue('visual');
    await expect(page.locator('#bell-interval')).toHaveValue('2');
    await expect(page.locator('#bell-style-note')).toContainText('短暂高亮');
    for (const value of ['', '-1', '61', '1.5', '100']) {
      await page.locator('#bell-interval').fill(value);
      await page.locator('#bell-apply').click();
      await expect(page.locator('#bell-error')).toHaveText('重复间隔须为 0–60 的整数秒');
      await expect(page.locator('#bell-dialog')).toBeVisible();
    }
    await page.locator('#bell-style').selectOption('off');
    await expect(page.locator('#bell-style-note')).toContainText('不发声');
    await page.locator('#bell-cancel').click();
    await bell.openSettings();
    await expect(page.locator('#bell-style')).toHaveValue('visual');
    await expect(page.locator('#bell-interval')).toHaveValue('2');
    await expect(page.locator('#bell-error')).toHaveText('');
    await page.locator('#bell-preview').click();
    expect((await bell.audio()).tones).toBe(1);
    await page.locator('#bell-close').click();

    await bell.configure('sound', '5');
    await bell.openSettings();
    await expect(page.locator('#bell-style')).toHaveValue('sound');
    await expect(page.locator('#bell-interval')).toHaveValue('5');
    await page.keyboard.press('Escape');
    // Applies to a session opened after the change, too.
    const b = await bell.openPty();
    await bell.wait(450);
    await bell.send(b, '\x07');
    await bell.send(a, '\x07');
    expect((await bell.audio()).tones).toBe(2);
    expect((await bell.marks()).tabs).toEqual(['Local 2']);

    await page.reload();
    await bell.openSettings();
    await expect(page.locator('#bell-style')).toHaveValue('visual');
    await expect(page.locator('#bell-interval')).toHaveValue('2');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /bell/i.test(k)))).toEqual([]);
  });

  test('关闭带标记或正在提示的标签：状态释放，其他标签照常', async ({ page }) => {
    const errors = trackErrors(page);
    const bell = await BellPage.open(page);
    const a = await bell.openPty();
    const b = await bell.openPty();
    await bell.send(a, '\x07');
    expect((await bell.marks()).tabs).toEqual(['Local 2']);
    await page.locator('#tabs .tab', { hasText: 'Local 2' }).locator('.tab-close').click();
    await expect(page.locator('#tabs [role="tab"]', { hasText: 'Local 2' })).toHaveCount(0);
    expect(await bell.marks()).toEqual({ tabs: [], rows: [], notes: [] });
    await bell.send(b, '\x07');
    await page.locator('#tabs .tab', { hasText: 'Local 3' }).locator('.tab-close').click();
    await expect(page.locator('#tabs [role="tab"]')).toHaveCount(1);
    await bell.wait(400);
    expect(errors).toEqual([]);
  });

  test('节流语义（模块，假时钟）：前沿窗口、下限、关闭、标记一次与异常隔离', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const m = await import('/src/terminal-bell.ts');
      let now = 0;
      const plays: number[] = [];
      const marked: number[] = [];
      let listener = () => {};
      let disposed = 0;
      const source = { onBell: (fn: () => void) => { listener = fn; return { dispose: () => { disposed++; } }; } };
      let active = 1;
      let throwOnMark = false;
      const bell = m.createTerminalBell(
        { isActive: (key: number) => key === active, marked: (key: number) => { marked.push(key); if (throwOnMark) throw new Error('host'); }, notify: () => {} },
        { now: () => now, reducedMotion: () => false, sound: { play: () => plays.push(now), unlock: () => {}, locked: false } },
      );
      const pane = document.createElement('section');
      bell.attach(2, source, pane);
      const ring = (at: number) => { now = at; listener(); };
      bell.configure({ style: 'sound', intervalSeconds: 2 });
      for (const at of [0, 1000, 1999, 2000, 2100, 3999, 4000]) ring(at);
      const leading = [...plays];
      plays.length = 0;
      bell.configure({ style: 'sound', intervalSeconds: 0 });
      for (const at of [10000, 10399, 10400, 10401, 10800]) ring(at);
      const floor = [...plays];
      plays.length = 0;
      const marksAfterSound = [...marked];
      bell.seen(2);
      ring(20000);
      ring(21000);
      const marksAgain = [...marked];
      bell.configure({ style: 'off', intervalSeconds: 0 });
      const marksOff = [...marked];
      plays.length = 0;
      ring(30000);
      throwOnMark = true;
      bell.configure({ style: 'visual', intervalSeconds: 0 });
      let threw = false;
      try { ring(40000); } catch { threw = true; }
      const flashed = pane.classList.contains('bell-flash');
      bell.forget(2);
      return {
        leading, floor, marksAfterSound, marksAgain, marksOff, offPlays: plays.length, threw, flashed, disposed,
        pending: bell.pending(2),
        parse: [m.parseBellSettings('sound', ' 7 '), m.parseBellSettings('beep', '2'), m.parseBellSettings('off', '60'), m.parseBellSettings('off', '61')],
      };
    });
    expect(result.leading).toEqual([0, 2000, 4000]);
    expect(result.floor).toEqual([10000, 10400, 10800]);
    expect(result.marksAfterSound).toEqual([2]);
    expect(result.marksAgain).toEqual([2, 2]);
    expect(result.marksOff).toEqual([2, 2, 2]);
    expect(result.offPlays).toBe(0);
    expect(result.threw).toBe(false);
    expect(result.flashed).toBe(true);
    expect(result.disposed).toBe(1);
    expect(result.pending).toBe(false);
    expect(result.parse).toEqual([
      { style: 'sound', intervalSeconds: 7 }, '请选择响铃样式', { style: 'off', intervalSeconds: 60 }, '重复间隔须为 0–60 的整数秒',
    ]);
  });
});
