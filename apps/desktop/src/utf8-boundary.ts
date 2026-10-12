/**
 * Keeps UTF-8 sequences whole across terminal output chunks before they reach `xterm.write`.
 *
 * The backends forward raw bytes in 4096-byte blocks without decoding them, so a block can end
 * inside a multi-byte character. xterm.js 6.0.0 stores such a partial sequence and finishes it on
 * the next write, but its decoder mistakes a stored continuation byte of exactly 0x80 for an empty
 * slot and drops the whole character (xtermjs/xterm.js#6003, fixed upstream by #6004 after 6.0.0).
 * Characters with such a byte include `、。「」` (U+3000-U+303F), `— “ ” …` and ZWJ (U+2000-U+203F)
 * and the U+E000-U+E03F private-use glyphs. Holding back the unfinished tail (at most three bytes)
 * and prepending it to the next block means xterm.js never has to store a partial sequence.
 *
 * Bytes are not decoded or validated here: invalid UTF-8 reaches xterm.js unchanged. A tail that is
 * still pending when the stream ends is reported by {@link Utf8Boundary.flush}.
 */
export class Utf8Boundary {
  #tail = new Uint8Array(0);

  /** The bytes that can be parsed now: the pending tail, then `chunk` up to its last whole character. */
  take(chunk: Uint8Array): Uint8Array {
    const bytes = this.#tail.length ? concat(this.#tail, chunk) : chunk;
    const end = completeLength(bytes);
    this.#tail = bytes.slice(end);
    return end === bytes.length ? bytes : bytes.subarray(0, end);
  }

  /** Bytes held back for the next chunk. */
  get pending(): number {
    return this.#tail.length;
  }

  /**
   * Ends the stream. An unfinished sequence left over is returned as one U+FFFD (as a streaming
   * `TextDecoder` reports it at the end) instead of disappearing; otherwise nothing.
   */
  flush(): Uint8Array {
    const unfinished = this.#tail.length > 0;
    this.#tail = new Uint8Array(0);
    return unfinished ? REPLACEMENT : new Uint8Array(0);
  }
}

/** U+FFFD REPLACEMENT CHARACTER in UTF-8. */
const REPLACEMENT = Uint8Array.of(0xef, 0xbf, 0xbd);

/** Length of the longest prefix of `bytes` that does not end inside a multi-byte sequence. */
export function completeLength(bytes: Uint8Array): number {
  // A sequence is at most four bytes, so only the last three can start an unfinished one.
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for its lead byte
    return back < sequenceLength(byte) ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/** Bytes in the sequence this lead byte starts, as xterm.js reads it; 1 for ASCII and invalid bytes. */
function sequenceLength(lead: number): number {
  if (lead >= 0xf8) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}
