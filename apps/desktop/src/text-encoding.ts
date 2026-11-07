/**
 * Session character encodings (T28 Big5, T29 EUC-JP, first part of T33). See
 * docs/p1/SESSION_ENCODING_PLAN.zh-CN.md.
 *
 * Output is decoded by the WebView's own WHATWG `TextDecoder`. `TextEncoder` only produces UTF-8,
 * so input for any other encoding is encoded with an inverse table derived from that same decoder:
 * a character is sent as a byte sequence only if the session's decoder maps exactly that sequence
 * back to exactly that character. Where several sequences decode to the same character, the one the
 * WHATWG encoder chooses is used (first pointer; Big5's six "last pointer" code points; Big5 skips
 * the HKSCS lead bytes 0x81–0xA0; Shift_JIS skips pointers 8272–10715). The WHATWG encoders' lossy
 * compatibility mappings (EUC-JP / Shift_JIS U+00A5 → 0x5C "\" and U+203E → 0x7E "~", U+2212 →
 * U+FF0D) are deliberately left out: they would make the remote side read a different character.
 * Characters without such a sequence (and U+FFFD) are unencodable; nothing is ever guessed.
 *
 * Only ASCII-compatible, stateless encodings are listed: ASCII bytes always mean ASCII in both
 * directions, so terminal control sequences survive decoding and encoded input. ISO-2022-JP (its
 * ESC designations conflict with VT escape sequences) and UTF-16/32 (not ASCII compatible) are
 * excluded.
 */

export type EncodingId = "utf-8" | "big5" | "euc-jp" | "shift_jis" | "gbk" | "gb18030" | "euc-kr";

export interface EncodingInfo {
  readonly id: EncodingId;
  /** Short name for the status bar and notices. */
  readonly label: string;
  /** Text of the choice in an encoding select. */
  readonly description: string;
}

export const DEFAULT_ENCODING: EncodingId = "utf-8";

/** The selectable encodings, in menu order. Labels are fixed strings, never remote data. */
export const ENCODINGS: readonly EncodingInfo[] = Object.freeze(
  [
    { id: "utf-8", label: "UTF-8", description: "UTF-8（默认）" },
    { id: "big5", label: "Big5", description: "Big5 · 繁体中文" },
    { id: "euc-jp", label: "EUC-JP", description: "EUC-JP · 日文" },
    { id: "shift_jis", label: "Shift_JIS", description: "Shift_JIS · 日文（Windows-31J）" },
    { id: "gbk", label: "GBK", description: "GBK · 简体中文" },
    { id: "gb18030", label: "GB18030", description: "GB18030 · 简体中文" },
    { id: "euc-kr", label: "EUC-KR", description: "EUC-KR · 韩文（Windows-949）" },
  ].map((info) => Object.freeze(info as EncodingInfo)),
);

export function isEncodingId(value: unknown): value is EncodingId {
  return ENCODINGS.some((info) => info.id === value);
}

export function encodingLabel(id: EncodingId): string {
  return ENCODINGS.find((info) => info.id === id)?.label ?? id;
}

/** True when this WebView's `TextDecoder` implements the encoding. UTF-8 always is. */
export function encodingSupported(id: EncodingId): boolean {
  if (id === DEFAULT_ENCODING) return true;
  try {
    return new TextDecoder(id).encoding === id;
  } catch {
    return false;
  }
}

/** All input converted, or how many characters could not be (then nothing is converted). */
export type EncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly unencodable: number };

type Range = readonly [number, number];
/** One family of byte sequences: the allowed range(s) of each byte position, in WHATWG pointer order. */
type Family = readonly (readonly Range[])[];

interface TableSpec {
  readonly families: readonly Family[];
  /** Sequences the WHATWG encoder never produces although the decoder accepts them. */
  readonly excluded?: (bytes: readonly number[]) => boolean;
  /** Code points the WHATWG encoder maps to the last matching sequence instead of the first. */
  readonly last?: ReadonlySet<number>;
  /** Code points the WHATWG encoder refuses even if some sequence decodes to them. */
  readonly refused?: ReadonlySet<number>;
}

const r = (from: number, to = from): Range => [from, to];
const DOUBLE_GB: Family = [[r(0x81, 0xfe)], [r(0x40, 0x7e), r(0x80, 0xfe)]];
/** The gb18030 encoder's explicit error for U+E5E5. */
const GB_REFUSED: ReadonlySet<number> = new Set([0xe5e5]);

/** Shift_JIS pointer of a double-byte sequence (WHATWG Encoding Standard). */
function shiftJisPointer(lead: number, trail: number): number {
  return (lead - (lead < 0xa0 ? 0x81 : 0xc1)) * 188 + trail - (trail < 0x7f ? 0x40 : 0x41);
}

const SPECS: Readonly<Record<Exclude<EncodingId, "utf-8">, TableSpec>> = {
  // Lead bytes below 0xA1 are HKSCS extensions; the WHATWG encoder never emits them.
  big5: {
    families: [[[r(0xa1, 0xfe)], [r(0x40, 0x7e), r(0xa1, 0xfe)]]],
    last: new Set([0x2550, 0x255e, 0x2561, 0x256a, 0x5341, 0x5345]),
  },
  // Half-width katakana (0x8E + byte) and JIS X 0208. JIS X 0212 (0x8F) is decoded only.
  "euc-jp": {
    families: [[[r(0x8e)], [r(0xa1, 0xdf)]], [[r(0xa1, 0xfe)], [r(0xa1, 0xfe)]]],
  },
  // U+0080, single-byte half-width katakana, then double bytes without the NEC-selected IBM
  // extension rows (pointers 8272–8835) and the user-defined area (8836–10715).
  shift_jis: {
    families: [[[r(0x80)]], [[r(0xa1, 0xdf)]], [[r(0x81, 0x9f), r(0xe0, 0xfc)], [r(0x40, 0x7e), r(0x80, 0xfc)]]],
    excluded: (bytes) => bytes.length === 2 && shiftJisPointer(bytes[0], bytes[1]) >= 8272 && shiftJisPointer(bytes[0], bytes[1]) <= 10715,
  },
  // GBK's encoder sends U+20AC as the single byte 0x80 before consulting the two-byte index.
  gbk: { families: [[[r(0x80)]], DOUBLE_GB], refused: GB_REFUSED },
  // Two bytes first; the four-byte BMP sequences fill in the rest. Planes 1–16 are computed.
  gb18030: { families: [DOUBLE_GB, [[r(0x81, 0x84)], [r(0x30, 0x39)], [r(0x81, 0xfe)], [r(0x30, 0x39)]]], refused: GB_REFUSED },
  "euc-kr": { families: [[[r(0x81, 0xfe)], [r(0x41, 0xfe)]]] },
};

/** Code point → byte sequence packed big-endian into one number (1, 2 or 4 bytes). */
type Table = Map<number, number>;
const tables = new Map<EncodingId, Table>();

const LF = 0x0a;

/** Every sequence of `family` whose first byte is `first`, in pointer order. */
function sequences(family: Family, first: number): number[][] {
  let out: number[][] = [[first]];
  for (const ranges of family.slice(1)) {
    const next: number[][] = [];
    for (const prefix of out)
      for (const [from, to] of ranges) for (let byte = from; byte <= to; byte++) next.push([...prefix, byte]);
    out = next;
  }
  return out;
}

const pack = (bytes: readonly number[]) => bytes.reduce((value, byte) => value * 256 + byte, 0);

/**
 * Decodes every listed sequence once, each followed by LF. LF is never a trail byte of these
 * encodings, so an invalid sequence (U+FFFD, possibly followed by a restored ASCII byte) can
 * never swallow the separator, and the n-th line is exactly what the n-th sequence decodes to.
 */
function buildTable(id: Exclude<EncodingId, "utf-8">): Table {
  const spec = SPECS[id];
  const decoder = new TextDecoder(id);
  const table: Table = new Map();
  for (const family of spec.families) {
    for (const [from, to] of family[0]) {
      for (let first = from; first <= to; first++) {
        const list = sequences(family, first).filter((bytes) => !spec.excluded?.(bytes));
        const buffer = new Uint8Array(list.reduce((size, bytes) => size + bytes.length + 1, 0));
        let at = 0;
        for (const bytes of list) {
          buffer.set(bytes, at);
          at += bytes.length;
          buffer[at++] = LF;
        }
        const lines = decoder.decode(buffer).split("\n");
        list.forEach((bytes, index) => {
          const chars = [...lines[index]];
          if (chars.length !== 1) return;
          const cp = chars[0].codePointAt(0)!;
          // ASCII is sent as itself; U+FFFD is the decoder's error output; surrogates are not characters.
          if (cp < 0x80 || cp === 0xfffd || (cp >= 0xd800 && cp <= 0xdfff) || spec.refused?.has(cp)) return;
          if (!table.has(cp) || spec.last?.has(cp)) table.set(cp, pack(bytes));
        });
      }
    }
  }
  return table;
}

function tableFor(id: Exclude<EncodingId, "utf-8">): Table {
  let table = tables.get(id);
  if (!table) {
    table = buildTable(id);
    tables.set(id, table);
  }
  return table;
}

let gb18030Decoder: TextDecoder | undefined;

/** GB18030 four-byte sequence for a code point in planes 1–16, if the decoder maps it back. */
function gb18030Supplementary(table: Table, cp: number): number | undefined {
  if (table.has(cp)) return table.get(cp);
  let pointer = 189000 + cp - 0x10000;
  const bytes = [0x81 + Math.floor(pointer / 12600), 0, 0, 0];
  pointer %= 12600;
  bytes[1] = 0x30 + Math.floor(pointer / 1260);
  pointer %= 1260;
  bytes[2] = 0x81 + Math.floor(pointer / 10);
  bytes[3] = 0x30 + (pointer % 10);
  gb18030Decoder ??= new TextDecoder("gb18030");
  const decoded = gb18030Decoder.decode(Uint8Array.from(bytes));
  const packed = decoded.codePointAt(0) === cp && decoded.length === 2 ? pack(bytes) : undefined;
  if (packed !== undefined) table.set(cp, packed);
  return packed;
}

const utf8 = new TextEncoder();

/**
 * Encodes `text` for a session. UTF-8 is `TextEncoder` exactly as before (a lone surrogate becomes
 * U+FFFD). Any other encoding either converts every character or reports how many it cannot, and
 * then converts nothing, so a keystroke, paste or IME commit is never sent in part.
 */
export function encodeText(id: EncodingId, text: string): EncodeResult {
  if (id === "utf-8") return { ok: true, bytes: utf8.encode(text) };
  const table = tableFor(id);
  // Per UTF-16 unit at most four bytes in GB18030 (a four-byte BMP sequence), two in the others.
  const out = new Uint8Array(text.length * (id === "gb18030" ? 4 : 2));
  let length = 0;
  let unencodable = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x80) {
      out[length++] = cp;
      continue;
    }
    const packed = id === "gb18030" && cp >= 0x10000 ? gb18030Supplementary(table, cp) : table.get(cp);
    if (packed === undefined) {
      unencodable++;
      continue;
    }
    const size = packed < 0x100 ? 1 : packed < 0x10000 ? 2 : 4;
    for (let shift = size - 1; shift >= 0; shift--) out[length++] = Math.floor(packed / 256 ** shift) % 256;
  }
  return unencodable ? { ok: false, unencodable } : { ok: true, bytes: out.slice(0, length) };
}

/** Number of non-ASCII characters an encoding can send; builds its table. For tests and diagnostics. */
export function encodableCount(id: Exclude<EncodingId, "utf-8">): number {
  return tableFor(id).size;
}
