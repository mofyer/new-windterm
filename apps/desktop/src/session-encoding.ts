import { Utf8Boundary } from "./utf8-boundary";
import { DEFAULT_ENCODING, encodeText, type EncodeResult, type EncodingId } from "./text-encoding";

/** What `xterm.write` receives: raw bytes for a UTF-8 session (unchanged path), decoded text otherwise. */
export type TerminalOutput = Uint8Array | string;

/**
 * The character encoding of one native session, applied at exactly two points: output bytes from
 * the transport channel before `xterm.write`, and terminal input text before the input queue.
 * Rust keeps forwarding and receiving raw bytes; xterm.js stays the only screen state.
 *
 * UTF-8 keeps the previous path byte for byte: `Utf8Boundary` holds back an unfinished sequence and
 * xterm.js decodes the bytes; input is `TextEncoder`. Any other encoding decodes with a streaming
 * WHATWG `TextDecoder` (replacement mode), so a character cut between chunks is joined, and xterm
 * receives text. Decoding happens before VT parsing: these encodings never use C0 bytes as trail
 * bytes, and an invalid sequence followed by an ASCII byte becomes U+FFFD plus that byte, so
 * ESC, CR, LF and every control sequence stay intact.
 */
export class SessionCodec {
  #id: EncodingId;
  #utf8: Utf8Boundary | undefined;
  #decoder: TextDecoder | undefined;

  constructor(id: EncodingId = DEFAULT_ENCODING) {
    this.#id = id;
    this.#start();
  }

  get encoding(): EncodingId {
    return this.#id;
  }

  /** One output chunk; a character it ends inside of is completed by the next chunk. */
  decode(chunk: Uint8Array): TerminalOutput {
    return this.#utf8 ? this.#utf8.take(chunk) : this.#decoder!.decode(chunk, { stream: true });
  }

  /** Output is over: a character left unfinished becomes one U+FFFD; otherwise nothing. */
  end(): TerminalOutput {
    return this.#utf8 ? this.#utf8.flush() : this.#decoder!.decode();
  }

  /** Terminal input text to bytes; never sends part of `text` (see `encodeText`). */
  encode(text: string): EncodeResult {
    return encodeText(this.#id, text);
  }

  /**
   * Uses `id` for output that arrives and input that is produced from now on. Returns the end of
   * the previous decoder (U+FFFD for a character it was in the middle of), to be written before
   * any later output; nothing already shown or queued is converted again.
   */
  switchTo(id: EncodingId): TerminalOutput {
    if (id === this.#id) return "";
    const tail = this.end();
    this.#id = id;
    this.#start();
    return tail;
  }

  #start() {
    const utf8 = this.#id === DEFAULT_ENCODING;
    this.#utf8 = utf8 ? new Utf8Boundary() : undefined;
    this.#decoder = utf8 ? undefined : new TextDecoder(this.#id);
  }
}
