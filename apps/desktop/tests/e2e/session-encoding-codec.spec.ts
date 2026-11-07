import { test, expect, type Page } from '@playwright/test';

// T28/T29/T33 part 1 (docs/p1/SESSION_ENCODING_PLAN.zh-CN.md): the encoder tables derived from
// Chrome's WHATWG TextDecoder and the per-session codec, imported straight from the dev server.
// Environment: Chrome only. WKWebView, WebView2 and WebKitGTK decoders are not exercised here.

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');

async function load(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const encoding = await import(/* @vite-ignore */ '/src/text-encoding.ts');
    const codec = await import(/* @vite-ignore */ '/src/session-encoding.ts');
    (window as any).enc = { ...encoding, ...codec };
  });
}

/** Encodes in the page; bytes as upper-case hex, or the unencodable count. */
const encode = (page: Page, id: string, text: string) => page.evaluate(({ id, text }) => {
  const result = (window as any).enc.encodeText(id, text);
  return result.ok
    ? { hex: Array.from(result.bytes as Uint8Array, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('') }
    : { unencodable: result.unencodable as number };
}, { id, text });

/** Known samples: Unicode text and the bytes the WHATWG encoder produces for it. */
const SAMPLES: [string, string, string][] = [
  ['big5', '中文繁體', 'A4A4A4E5C163C5E9'],
  // Trail bytes inside the ASCII range: 0x5C is "\" when read as ASCII.
  ['big5', '許功', 'B35CA55C'],
  ['big5', '「」　', 'A175A176A140'],
  ['euc-jp', '日本語ア。', 'C6FCCBDCB8ECA5A2A1A3'],
  ['euc-jp', 'ｱｲｳ', '8EB18EB28EB3'],
  ['shift_jis', '日本ソ表', '93FA967B835C955C'],
  ['shift_jis', 'ｱｲ', 'B1B2'],
  ['gbk', '中文€', 'D6D0CEC480'],
  ['gb18030', '中€', 'D6D0A2E3'],
  ['gb18030', '\u0080😀', '813081309439FC36'],
  ['euc-kr', '한국어', 'C7D1B1B9BEEE'],
  // ASCII, controls and escape sequences are sent unchanged in every encoding.
  ['big5', 'ls -l\r\x1b[A\x03', '6C73202D6C0D1B5B4103'],
];

test('known samples encode to the WHATWG bytes and decode back to the same text', async ({ page }) => {
  await load(page);
  for (const [id, text, bytes] of SAMPLES) {
    expect(await encode(page, id, text), `${id} ${text}`).toEqual({ hex: bytes });
    const decoded = await page.evaluate(({ id, bytes }) =>
      new TextDecoder(id).decode(Uint8Array.from(bytes.match(/../g)!.map((h: string) => parseInt(h, 16)))), { id, bytes });
    expect(decoded, `${id} ${bytes}`).toBe(text);
  }
});

test('every encodable character decodes back to itself, and the tables have the expected size', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await load(page);
  const result = await page.evaluate(() => {
    const { ENCODINGS, encodeText, encodableCount } = (window as any).enc;
    const out: Record<string, { size: number; buildMs: number; bmp: number; astral: number; mismatches: string[] }> = {};
    for (const { id } of ENCODINGS) {
      if (id === 'utf-8') continue;
      const started = performance.now();
      const size = encodableCount(id);
      const buildMs = performance.now() - started;
      const decoder = new TextDecoder(id);
      const mismatches: string[] = [];
      let bmp = 0;
      let astral = 0;
      // Planes 0–2 (BMP, SMP, CJK Ext. B–F): each character the encoder accepts must decode to itself.
      for (let cp = 0x80; cp <= 0x2ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const char = String.fromCodePoint(cp);
        const encoded = encodeText(id, char);
        if (!encoded.ok) continue;
        if (cp > 0xffff) astral++;
        else bmp++;
        if (decoder.decode(encoded.bytes) !== char && mismatches.length < 5) mismatches.push(cp.toString(16));
      }
      out[id] = { size, buildMs: Math.round(buildMs * 10) / 10, bmp, astral, mismatches };
    }
    return out;
  });
  console.log(`encoder tables ${JSON.stringify(result)}`);
  await testInfo.attach('encoder-tables', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  for (const [id, entry] of Object.entries(result)) {
    expect(entry.mismatches, id).toEqual([]);
    // Built tables hold planes 0–2 only; GB18030 computes planes 1–16 on demand instead.
    if (id === 'gb18030') expect(entry.bmp, id).toBe(entry.size);
    else expect(entry.bmp + entry.astral, id).toBe(entry.size);
  }
  // Every plane 1–2 character has a GB18030 four-byte sequence.
  expect(result.gb18030.astral).toBe(0x20000);
  // Rough sizes of the WHATWG indexes (non-ASCII characters the encoder can produce).
  expect(result.big5.size).toBeGreaterThan(13_000);
  expect(result['euc-jp'].size).toBeGreaterThan(7_000);
  expect(result.shift_jis.size).toBeGreaterThan(7_000);
  expect(result.gbk.size).toBeGreaterThan(21_000);
  expect(result['euc-kr'].size).toBeGreaterThan(17_000);
  // GB18030 covers the whole BMP except U+FFFD, U+E5E5 and code points its index leaves out.
  expect(result.gb18030.size).toBeGreaterThan(63_000);
});

test('characters without a round-trip sequence are refused as a whole, never approximated', async ({ page }) => {
  await load(page);
  const cases: [string, string, number][] = [
    ['big5', '中😀文', 1],
    ['big5', 'ｱ', 1],
    // The WHATWG encoders' lossy compatibility mappings are left out: ¥ → "\" and ‾ → "~" would
    // reach the shell as different characters, U+2212 would arrive as U+FF0D.
    ['euc-jp', '¥', 1],
    ['euc-jp', '‾', 1],
    ['euc-jp', '−', 1],
    ['shift_jis', '¥1', 1],
    // JIS X 0212 (0x8F) is decoded but never produced, like the WHATWG encoder.
    ['euc-jp', '丂', 1],
    ['gbk', '😀😀', 2],
    ['euc-kr', 'ｱ', 1],
    // A lone surrogate and U+FFFD are not sent in any encoding other than UTF-8.
    ['gb18030', '\ud800', 1],
    ['gb18030', '�', 1],
    // The WHATWG gb18030/GBK encoders refuse U+E5E5 explicitly.
    ['gbk', '', 1],
    ['gb18030', '', 1],
  ];
  for (const [id, text, count] of cases) expect(await encode(page, id, text), `${id} ${JSON.stringify(text)}`).toEqual({ unencodable: count });
  // UTF-8 is TextEncoder unchanged, a lone surrogate included.
  expect(await encode(page, 'utf-8', 'a\ud800中')).toEqual({ hex: '61EFBFBDE4B8AD' });
});

test('encoders never produce the sequences the WHATWG encoders exclude', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(() => {
    const { encodeText } = (window as any).enc;
    /** Characters decoded from `pairs` and what their encoding starts with. */
    const probe = (id: string, pairs: number[][]) => {
      const decoder = new TextDecoder(id);
      let decodable = 0;
      let refused = 0;
      const leaked: string[] = [];
      for (const bytes of pairs) {
        const chars = [...decoder.decode(Uint8Array.from(bytes))];
        if (chars.length !== 1 || chars[0] === '�') continue;
        decodable++;
        const encoded = encodeText(id, chars[0]);
        if (!encoded.ok) refused++;
        else leaked.push(Array.from(encoded.bytes as Uint8Array, (b: number) => b.toString(16)).join(''));
      }
      return { decodable, refused, leaked };
    };
    const big5Hkscs: number[][] = [];
    for (let lead = 0x81; lead <= 0xa0; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) big5Hkscs.push([lead, trail]);
    const jis0212: number[][] = [];
    for (let lead = 0xa1; lead <= 0xfe; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++) jis0212.push([0x8f, lead, trail]);
    return {
      big5: probe('big5', big5Hkscs),
      eucJp: probe('euc-jp', jis0212),
      // Encoded Big5 never starts with an HKSCS lead byte; EUC-JP never with 0x8F.
      big5Leads: big5Hkscs.length,
    };
  });
  expect(result.big5.decodable).toBeGreaterThan(3000);
  expect(result.big5.refused).toBeGreaterThan(0);
  expect(result.big5.leaked.every((bytes) => parseInt(bytes.slice(0, 2), 16) >= 0xa1)).toBe(true);
  expect(result.eucJp.decodable).toBeGreaterThan(5000);
  expect(result.eucJp.refused).toBeGreaterThan(5000);
  expect(result.eucJp.leaked.every((bytes) => !bytes.startsWith('8f'))).toBe(true);
});

test('the session codec decodes a stream the same way at every cut and reports an unfinished character', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(() => {
    const { SessionCodec } = (window as any).enc;
    const run = (id: string, bytes: number[], cuts: number[]) => {
      const codec = new SessionCodec(id);
      let text = '';
      let at = 0;
      for (const cut of [...cuts, bytes.length]) {
        text += codec.decode(Uint8Array.from(bytes.slice(at, cut)));
        at = cut;
      }
      return text + codec.end();
    };
    const out: Record<string, { whole: string; differ: number }> = {};
    const streams: Record<string, number[]> = {
      // 許功 (0x5C trails), SGR around 中, a lone lead byte before ESC, then 文.
      big5: [0xb3, 0x5c, 0xa5, 0x5c, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xa4, 0xa4, 0x1b, 0x5b, 0x30, 0x6d, 0xa4, 0x1b, 0x5b, 0x4b, 0xa4, 0xe5],
      // 日本, half-width ｱ, JIS X 0212 丂, a lone 0x8E before LF.
      'euc-jp': [0xc6, 0xfc, 0xcb, 0xdc, 0x8e, 0xb1, 0x8f, 0xb0, 0xa1, 0x8e, 0x0a, 0x41],
      gb18030: [0x94, 0x39, 0xfc, 0x36, 0xd6, 0xd0, 0x81, 0x30, 0x0d],
    };
    for (const [id, bytes] of Object.entries(streams)) {
      const whole = run(id, bytes, []);
      let differ = 0;
      for (let cut = 1; cut < bytes.length; cut++) if (run(id, bytes, [cut]) !== whole) differ++;
      if (run(id, bytes, Array.from({ length: bytes.length - 1 }, (_, i) => i + 1)) !== whole) differ++;
      out[id] = { whole, differ };
    }
    const tail = new SessionCodec('big5');
    const pending = tail.decode(Uint8Array.of(0x41, 0xa4));
    const switched = tail.switchTo('euc-jp');
    const after = tail.decode(Uint8Array.of(0xc6, 0xfc));
    const utf8 = new SessionCodec();
    const utf8Pending = Array.from(utf8.decode(Uint8Array.of(0x41, 0xe4, 0xb8)) as Uint8Array);
    const utf8Tail = Array.from(utf8.switchTo('big5') as Uint8Array);
    return { out, pending, switched, after, encoding: tail.encoding, utf8Pending, utf8Tail, same: utf8.switchTo('big5') };
  });
  expect(result.out.big5).toEqual({ whole: '許功\x1b[31m中\x1b[0m�\x1b[K文', differ: 0 });
  expect(result.out['euc-jp']).toEqual({ whole: '日本ｱ丂�\nA', differ: 0 });
  // An unfinished four-byte prefix 0x81 0x30 before CR: U+FFFD, then the restored ASCII "0" and CR.
  expect(result.out.gb18030).toEqual({ whole: '😀中�0\r', differ: 0 });
  // Switching ends the old decoder: its unfinished character becomes U+FFFD, later bytes use the new one.
  expect(result).toMatchObject({ pending: 'A', switched: '�', after: '日', encoding: 'euc-jp', same: '' });
  // UTF-8 keeps Utf8Boundary: bytes pass through, the held-back tail ends as U+FFFD.
  expect(result.utf8Pending).toEqual([0x41]);
  expect(hex(result.utf8Tail)).toBe('EFBFBD');
});
