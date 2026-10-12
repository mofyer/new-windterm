import { test, expect } from '@playwright/test';
import { Term } from './input-harness';

// Multi-byte UTF-8 split across `PtyEvent` data chunks. The backends deliberately forward raw
// 4096-byte blocks without decoding; these probes feed bytes through the stubbed IPC channel into
// the real page. They do not exercise a native PTY, SSH server or WKWebView.

/** Characters whose UTF-8 encoding has a 0x80 continuation byte, plus ordinary controls. */
const SAMPLES: Record<string, string> = {
  'ideographic comma and full stop U+3001 U+3002': '、。',
  'corner brackets U+300C U+300D': '「」',
  'em dash and curly quotes U+2014 U+201C U+201D': '—“”',
  'ZWJ family': '👨‍👩‍👧',
  'private use U+E000': '',
  'U+10000 (F0 90 80 80)': '𐀀',
  'mahjong U+1F004 (third byte 0x80)': '🀄',
  'CJK Ext. B U+20000': '𠀀',
  'plain CJK and emoji': '中文🌏',
};

/** Every way to cut `bytes` into two chunks, plus one byte per chunk. */
function splits(bytes: number[]): number[][][] {
  const out = [bytes.map(b => [b])];
  for (let cut = 1; cut < bytes.length; cut++) out.push([bytes.slice(0, cut), bytes.slice(cut)]);
  for (let a = 1; a < bytes.length - 1; a++) out.push([bytes.slice(0, a), bytes.slice(a, a + 1), bytes.slice(a + 1)]);
  return out;
}

for (const mode of ['pty', 'ssh'] as const) {
  test(`${mode}: characters split at every byte boundary render as if sent whole`, async ({ page }) => {
    test.setTimeout(60_000);
    const t = await Term.open(page, mode);
    const failures: string[] = [];
    for (const [name, sample] of Object.entries(SAMPLES)) {
      const text = `A${sample}Z`;
      const bytes = [...Buffer.from(text, 'utf8')];
      const results = await page.evaluate(async ({ cases }) => {
        const qa = (window as any).qa;
        const ipc = (window as any).qaIpc;
        const out: { row: string; x: number }[] = [];
        for (const chunks of cases as number[][][]) {
          await new Promise<void>(r => qa.terminal.write('\x1b[2J\x1b[H', r));
          for (const data of chunks) ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data });
          await new Promise<void>(r => qa.terminal.write('', r));
          const b = qa.terminal.buffer.active;
          out.push({ row: b.getLine(b.viewportY).translateToString(true), x: b.cursorX });
        }
        return out;
      }, { cases: splits(bytes) });
      const reference = results[results.length - 1];
      for (const [index, result] of results.entries())
        if (result.row !== text || result.x !== reference.x) failures.push(`${name} #${index}: ${JSON.stringify(result)}`);
      expect(reference.row, name).toBe(text);
    }
    expect(failures).toEqual([]);
    // Every chunk is acknowledged once, including chunks that were held back whole.
    await t.drained();
    expect(await page.evaluate(() => {
      const acks = (window as any).qaIpc.acks as number[];
      return acks.every((sequence, index) => sequence === index + 1);
    })).toBe(true);
  });
}

for (const [mode, end] of [['pty', { kind: 'exit', code: 0 }], ['ssh', { kind: 'error', message: 'SSH channel closed' }]] as const) {
  test(`${mode}: output that ends inside a character shows U+FFFD instead of dropping it`, async ({ page }) => {
    const t = await Term.open(page, mode);
    await page.evaluate((end) => {
      const ipc = (window as any).qaIpc;
      ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data: [0x0d, 0x0a, 0x41, 0xe4, 0xb8] });
      ipc.channel.onmessage({ id: ipc.id, ...end });
    }, end);
    await t.output('');
    expect(await t.row()).toBe('A\ufffd');
  });
}

test('pty: 3,000 lines of punctuation-heavy Chinese in 4 KiB chunks arrive intact', async ({ page }) => {
  const t = await Term.open(page, 'pty');
  const lines = Array.from({ length: 3000 }, (_, n) => `${String(n).padStart(4, '0')}「第${n}行」。、—“引号”…完`);
  await t.output(lines.join('\r\n'), 4096);
  await t.drained();
  const rows = await page.evaluate((count) => {
    const b = (window as any).qa.terminal.buffer.active;
    const end = b.baseY + b.cursorY;
    return Array.from({ length: count }, (_, i) => b.getLine(end - count + 1 + i).translateToString(true));
  }, lines.length);
  expect(rows).toEqual(lines);
});

test('xterm.js 6.0.0 alone drops a character whose stored partial bytes end in 0x80 (upstream #6003)', async ({ page }) => {
  // Minimal reproduction without the application's chunk joiner. When this starts failing, the
  // pinned xterm.js has the upstream fix (#6004) and Utf8Boundary can be reconsidered.
  await Term.open(page, 'demo');
  const rows = await page.evaluate(async () => {
    const { terminal } = (window as any).qa;
    const write = (data: number[]) => new Promise<void>(r => terminal.write(Uint8Array.from(data), r));
    const row = () => terminal.buffer.active.getLine(terminal.buffer.active.cursorY).translateToString(true);
    const out: string[] = [];
    for (const chunks of [
      [[0x41, 0xe3, 0x80], [0x82, 0x5a]], // A。Z, split after E3 80
      [[0x41, 0xe3], [0x80, 0x82, 0x5a]], // same bytes, split after E3
      [[0x41, 0xe2], [0x80], [0x94, 0x5a]], // A—Z, one byte per chunk in the middle
    ]) {
      await write([0x1b, 0x5b, 0x32, 0x4b, 0x0d]);
      for (const chunk of chunks) await write(chunk);
      out.push(row());
    }
    return out;
  });
  expect(rows).toEqual(['AZ', 'A。Z', 'AZ']);
});

test('Utf8Boundary: random splits of mixed valid and invalid bytes reach xterm unchanged and in order', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/utf8-boundary.ts';
    const { Utf8Boundary, completeLength } = await import(/* @vite-ignore */ path);
    let seed = 7;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const pieces = ['a', '中', '。', '—', '👨‍👩‍👧', '𐀀', '🀄', '', '\x1b[31m', 'é'];
    const invalid = [[0x80], [0xff], [0xe3, 0x41], [0xf0, 0x9f], [0xc0, 0xaf]];
    let mismatches = 0;
    let unfinished = 0;
    let maxPending = 0;
    for (let round = 0; round < 300; round++) {
      const parts: number[] = [];
      // Every other round mixes in invalid UTF-8, which must pass through unchanged.
      const valid = round % 2 === 0;
      for (let i = 0; i < 40; i++) {
        if (!valid && random(8) === 0) parts.push(...invalid[random(invalid.length)]);
        else parts.push(...new TextEncoder().encode(pieces[random(pieces.length)]));
      }
      parts.push(0x5a);
      const joiner = new Utf8Boundary();
      const out: number[] = [];
      for (let at = 0; at < parts.length;) {
        const size = 1 + random(6);
        const piece = joiner.take(Uint8Array.from(parts.slice(at, at + size)));
        // Valid text never ends inside a sequence that xterm.js would store until the next write.
        if (valid && completeLength(piece) !== piece.length) unfinished++;
        out.push(...piece);
        maxPending = Math.max(maxPending, joiner.pending);
        at += size;
      }
      if (out.length !== parts.length || out.some((b, i) => b !== parts[i])) mismatches++;
    }
    return { mismatches, unfinished, maxPending };
  });
  expect(result.mismatches).toBe(0);
  expect(result.unfinished).toBe(0);
  expect(result.maxPending).toBeLessThanOrEqual(3);
});
