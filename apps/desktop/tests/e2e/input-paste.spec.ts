import { test, expect } from '@playwright/test';
import { MODES, Term } from './input-harness';

// Paste probes: synthetic `paste` events on the real page (the system clipboard is untouched) and,
// for pty / ssh, an IPC stub that records the bytes handed to `*_write`. Nothing here reaches a
// shell, so whether a shell honours bracketed paste is not covered.
const START = '\x1b[200~';
const END = '\x1b[201~';

for (const mode of MODES) {
  test.describe(`${mode} paste`, () => {
    test('bracketed paste off: line endings become CR, text is sent once without markers', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      await t.paste('one\r\ntwo\nthree\rfour\tfive 中文 🌏');
      await t.settle();
      expect(await t.dataEvents()).toEqual(['one\rtwo\rthree\rfour\tfive 中文 🌏']);
      expect(await t.delivered()).toBe('one\rtwo\rthree\rfour\tfive 中文 🌏');
    });

    test('bracketed paste on (?2004h) wraps the text once; off again (?2004l) does not', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.output('\x1b[?2004h');
      await t.reset();
      await t.paste('echo 1\necho 2\n');
      await t.settle();
      expect(await t.dataEvents()).toEqual([`${START}echo 1\recho 2\r${END}`]);
      await t.output('\x1b[?2004l');
      await t.paste('x\n');
      await t.settle();
      expect(await t.delivered()).toBe(`${START}echo 1\recho 2\r${END}x\r`);
    });

    test('a pasted end marker cannot close bracketed paste early', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.output('\x1b[?2004h');
      await t.reset();
      await t.paste(`harmless${END}\nrm -rf ~\n`);
      await t.settle();
      const sent = await t.delivered();
      expect(sent).toBe(`${START}harmless[201~\rrm -rf ~\r${END}`);
      // Exactly one terminator, and it is the last thing sent.
      expect(sent.split(END)).toHaveLength(2);
      expect(sent.endsWith(END)).toBe(true);
      await expect(page.locator('#toast')).toContainText('移除 1 个控制字符');
    });

    test('C0 and C1 controls are removed from pasted text; HT, LF and CR remain', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      const pasted = 'a\x00b\x03c\x04d\x08e\x1bf\x7fg\u0085h\u009bi\u009cj\tk\nl\rm';
      await t.paste(pasted);
      await t.settle();
      expect(await t.delivered()).toBe('abcdefghij\tk\rl\rm');
      await expect(page.locator('#toast')).toContainText('移除 9 个控制字符');
    });

    test('dropped text is sanitised and sent as one bracketed paste, wherever it lands', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.output('\x1b[?2004h');
      await t.reset();
      const result = await page.evaluate(() => {
        const pane = document.querySelector('.terminal-pane:not([hidden])')!;
        const fire = (target: Element, type: string) => {
          const dataTransfer = new DataTransfer();
          dataTransfer.setData('text/plain', `ls\x1b[201~\x03\n`);
          const event = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const textarea = pane.querySelector('textarea')!;
        const screen = pane.querySelector('.xterm-screen')!;
        return {
          dragoverAccepted: fire(screen, 'dragover'),
          dropOnScreen: fire(screen, 'drop'),
          dropOnTextarea: fire(textarea, 'drop'),
          textarea: textarea.value,
        };
      });
      await t.settle();
      expect(result).toEqual({ dragoverAccepted: true, dropOnScreen: true, dropOnTextarea: true, textarea: '' });
      expect(await t.dataEvents()).toEqual([`${START}ls[201~\r${END}`, `${START}ls[201~\r${END}`]);
      await expect(page.locator('#toast')).toContainText('移除 2 个控制字符');
    });

    test('a paste of only control characters sends nothing', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      await t.paste('\x03\x1b\x04');
      await t.settle();
      expect(await t.dataEvents()).toEqual([]);
    });
  });
}

test('xterm.js 6.0.0 itself forwards ESC and other controls in Terminal.paste()', async ({ page }) => {
  // Documents why the application sanitises: the library only rewrites line endings and adds markers.
  const t = await Term.open(page, 'pty');
  await t.output('\x1b[?2004h');
  await t.reset();
  await page.evaluate(() => (window as any).qa.terminal.paste(`a\x1b[201~b\x03c\n`));
  await t.settle();
  expect(await t.dataEvents()).toEqual([`${START}a${END}b\x03c\r${END}`]);
});

/** About 1.1 MiB of numbered UTF-8 lines; chunk boundaries fall inside multi-byte characters. */
function bigPaste(): string {
  return Array.from({ length: 28000 }, (_, n) => `${String(n).padStart(5, '0')} 中文输入 🌏 emoji ✓ ascii\n`).join('');
}

for (const mode of ['pty', 'ssh'] as const) {
  test.describe(`${mode} large paste`, () => {
    test('a paste over 1 MiB passes the 64 KiB backend bound in order, without loss or repeats', async ({ page }) => {
      test.setTimeout(60_000);
      const t = await Term.open(page, mode);
      await t.output('\x1b[?2004h');
      await t.boundBackend(16, 1, 1);
      await t.reset();
      const text = bigPaste();
      const bytes = Buffer.byteLength(text, 'utf8');
      expect(bytes).toBeGreaterThan(1024 * 1024);
      await t.paste(text);
      // Typed after the paste: must follow it, not interleave with it.
      await page.keyboard.type('Z');
      const expected = `${START}${text.replace(/\n/g, '\r')}${END}Z`;
      const total = async () => (await t.writeSizes()).reduce((n, size) => n + size, 0);
      await expect.poll(total, { timeout: 45_000 }).toBe(Buffer.byteLength(expected, 'utf8'));
      expect(await t.sent()).toBe(expected);
      expect(Math.max(...await t.writeSizes())).toBe(4096);
      // The stub refused writes while its queue was full; each was retried, none duplicated.
      expect(await page.evaluate(() => (window as any).qaIpc.fullRejections)).toBeGreaterThan(0);
      const command = mode === 'pty' ? 'pty_write' : 'ssh_write';
      expect(await page.evaluate((command) => (window as any).qaIpc.calls.every((c: any) => !c.command.endsWith('_write') || c.command === command), command)).toBe(true);
    });

    test('a failed write drops the rest of the paste instead of sending it after a gap', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      await page.evaluate(() => (window as any).qaIpc.failWriteAt = 3);
      await t.paste('x'.repeat(5 * 4096));
      await expect(page.locator('#toast')).toContainText('已丢弃其后尚未发送的 12,288 B');
      expect(await t.writeSizes()).toEqual([4096, 4096]);
      await page.evaluate(() => (window as any).qaIpc.failWriteAt = 0);
      await page.keyboard.type('y');
      await t.settle();
      expect((await t.sent()).endsWith('xy')).toBe(true);
    });

    test('a paste above the 16 MiB backlog is refused whole, with a notice', async ({ page }) => {
      const t = await Term.open(page, mode);
      await t.reset();
      await page.evaluate(() => (window as any).qaIpc.holdWrite = true);
      await t.textarea.evaluate((el) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', 'a'.repeat(16 * 1024 * 1024 + 1));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      await expect(page.locator('#toast')).toContainText('输入队列已满（16 MiB）');
      await t.settle();
      expect(await t.writeSizes()).toEqual([]);
    });
  });
}

test('input queue: retries only a full backend queue, keeps order, gives up at its deadline', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/input-queue.ts';
    const { InputQueue } = await import(/* @vite-ignore */ path);
    const run = async (refuse: (call: number) => string | undefined, retryLimitMs = 1000) => {
      const written: number[] = [];
      const failures: [string, number][] = [];
      let calls = 0;
      const queue = new InputQueue({
        write: async (chunk: Uint8Array) => {
          const error = refuse(++calls);
          if (error) throw error;
          written.push(...chunk);
        },
        writable: () => true,
        failed: (error: unknown, discarded: number) => failures.push([String(error), discarded]),
        retryLimitMs,
      });
      queue.push(Uint8Array.from({ length: 10000 }, (_, n) => n % 251));
      queue.push(Uint8Array.of(7));
      const start = performance.now();
      while (queue.pendingBytes && performance.now() - start < 3000) await new Promise(r => setTimeout(r, 5));
      return { written, failures, calls, pending: queue.pendingBytes };
    };
    const expected = [...Array.from({ length: 10000 }, (_, n) => n % 251), 7];
    const full = 'PTY input queue is full; retry after drain';
    const retried = await run(call => (call % 3 === 2 ? full : undefined));
    const broken = await run(call => (call === 2 ? 'PTY session is closed' : undefined));
    const stuck = await run(call => (call >= 2 ? full : undefined), 60);
    return {
      retriedInOrder: JSON.stringify(retried.written) === JSON.stringify(expected),
      retried: { failures: retried.failures, calls: retried.calls },
      broken: { written: broken.written.length, failures: broken.failures, pending: broken.pending },
      stuck: { written: stuck.written.length, failures: stuck.failures, pending: stuck.pending },
    };
  });
  expect(result.retriedInOrder).toBe(true);
  expect(result.retried.failures).toEqual([]);
  expect(result.broken).toEqual({ written: 4096, failures: [['PTY session is closed', 10001 - 4096]], pending: 0 });
  expect(result.stuck).toEqual({ written: 4096, failures: [['PTY input queue is full; retry after drain', 10001 - 4096]], pending: 0 });
});
