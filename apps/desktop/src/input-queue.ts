import { responsivenessDiagnostics as diagnostics } from "./responsiveness";

/** Largest `*_write` IPC payload the Rust transports accept. */
export const INPUT_CHUNK_BYTES = 4096;
/**
 * Input accepted but not yet confirmed by the backend. A paste larger than this is refused as a
 * whole; anything below it (a 1 MiB paste included) is sent completely, in order, in chunks.
 */
export const INPUT_BACKLOG_BYTES = 16 * 1024 * 1024;
/**
 * How long one chunk may keep meeting a full backend queue (the backends' 15 s ACK and write
 * timeout). The PTY and SSH backends hold at most 16 chunks (64 KiB) and refuse more with
 * "input queue is full" until the shell or the server's window drains them.
 */
export const INPUT_RETRY_LIMIT_MS = 15_000;
const RETRY_FIRST_MS = 2;
const RETRY_MAX_MS = 50;
/** The exact errors `pty.rs` and `ssh_terminal.rs` return for a full queue; any other is final. */
const QUEUE_FULL = /^(PTY|SSH) input queue is full; retry after drain$/;

export interface InputQueueOptions {
  /** Sends one chunk of at most {@link INPUT_CHUNK_BYTES}; resolves once the backend queued it. */
  write(chunk: Uint8Array): Promise<unknown>;
  /** False once the session can no longer take input; everything still queued is then dropped. */
  writable(): boolean;
  /** A write failed. It and everything queued behind it (`discardedBytes`) were not sent. */
  failed(error: unknown, discardedBytes: number): void;
  /** Overrides {@link INPUT_RETRY_LIMIT_MS}, for tests. */
  retryLimitMs?: number;
}

/**
 * What happened to one chunk that asked for its result (see {@link InputQueue.push}):
 * - `written`: the backend accepted it (`*_write` resolved);
 * - `not-sent`: it was dropped before any request for it was outstanding, or the backend's last
 *   answer was an explicit "queue is full" refusal;
 * - `unconfirmed`: the backend rejected it with another error, or the queue was cleared while its
 *   request was still outstanding, so whether the backend took it is unknown.
 */
export type InputOutcome = "written" | "not-sent" | "unconfirmed";

interface Chunk {
  bytes: Uint8Array;
  queuedAt: number;
  /** Called at most once, then removed. */
  settle?: (outcome: InputOutcome) => void;
}

/** The backend refused a chunk only because its bounded queue is full; the chunk was not taken. */
export function isQueueFull(error: unknown): boolean {
  return QUEUE_FULL.test(String(error));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ordered terminal input. Keystrokes and pastes share one FIFO, so text typed during a large paste
 * follows it. One IPC write is outstanding at a time and each chunk is written once: a chunk the
 * backend refused because its queue was full is sent again after a short wait, and after any other
 * failed write the rest is dropped rather than sent after a gap.
 */
export class InputQueue {
  #chunks: Chunk[] = [];
  #head = 0;
  #queuedBytes = 0;
  #writingBytes = 0;
  #pumping = false;
  /** The chunk taken from the FIFO and being sent, including while it waits out a full queue. */
  #current: Chunk | undefined;
  /** True only while a `write` request for {@link #current} is outstanding. */
  #requesting = false;
  /** Bumped by {@link clear}; a write that fails after a clear belongs to a finished session. */
  #generation = 0;

  constructor(private readonly options: InputQueueOptions) {}

  /** Bytes accepted but not yet confirmed by the backend. */
  get pendingBytes(): number {
    return this.#queuedBytes + this.#writingBytes;
  }

  /** True while a backend write request is outstanding. */
  get requesting(): boolean {
    return this.#requesting;
  }

  /**
   * Queues `bytes` as a whole, or returns false (and queues nothing, calling nothing) when over the
   * backlog bound. `settle` asks for the one chunk's {@link InputOutcome}, reported exactly once
   * (already during this call if the session is no longer writable); only input of
   * 1..{@link INPUT_CHUNK_BYTES} bytes may ask. Ordinary input passes no callback and keeps the
   * retry and discard rules unchanged.
   */
  push(bytes: Uint8Array, settle?: (outcome: InputOutcome) => void): boolean {
    if (settle && (!bytes.length || bytes.length > INPUT_CHUNK_BYTES))
      throw new RangeError("A settled input must fit in one chunk");
    if (!bytes.length) return true;
    if (this.pendingBytes + bytes.length > INPUT_BACKLOG_BYTES) return false;
    const queuedAt = diagnostics ? performance.now() : 0;
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES)
      this.#chunks.push({ bytes: bytes.subarray(offset, offset + INPUT_CHUNK_BYTES), queuedAt, settle });
    this.#queuedBytes += bytes.length;
    if (diagnostics) {
      diagnostics.inputEvents++;
      diagnostics.pendingInputBytes += bytes.length;
      diagnostics.maxPendingInputBytes = Math.max(diagnostics.maxPendingInputBytes, diagnostics.pendingInputBytes);
    }
    if (!this.#pumping) void this.#pump();
    return true;
  }

  /** Drops everything not yet handed to the backend; returns the number of bytes dropped. */
  clear(): number {
    const dropped = this.#queuedBytes;
    if (diagnostics) diagnostics.pendingInputBytes -= dropped;
    const queued = this.#chunks.slice(this.#head);
    const current = this.#current;
    const requesting = this.#requesting;
    this.#chunks = [];
    this.#head = 0;
    this.#queuedBytes = 0;
    this.#generation++;
    // Results are reported after the queue is consistent, so a callback may push or clear again.
    if (current) InputQueue.#settle(current, requesting ? "unconfirmed" : "not-sent");
    for (const chunk of queued) InputQueue.#settle(chunk, "not-sent");
    return dropped;
  }

  static #settle(chunk: Chunk, outcome: InputOutcome) {
    const settle = chunk.settle;
    if (!settle) return;
    chunk.settle = undefined;
    settle(outcome);
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (this.#head < this.#chunks.length) {
        if (!this.options.writable()) {
          this.clear();
          break;
        }
        const chunk = this.#chunks[this.#head++];
        const { bytes, queuedAt } = chunk;
        this.#current = chunk;
        this.#queuedBytes -= bytes.length;
        this.#writingBytes = bytes.length;
        this.#compact();
        const generation = this.#generation;
        if (diagnostics) {
          diagnostics.maxInputWaitMs = Math.max(diagnostics.maxInputWaitMs, performance.now() - queuedAt);
          diagnostics.inputCalls++;
        }
        try {
          const written = await this.#send(bytes, generation);
          InputQueue.#settle(chunk, written ? "written" : "not-sent");
        } catch (error) {
          InputQueue.#settle(chunk, isQueueFull(error) ? "not-sent" : "unconfirmed");
          // After a clear the session already ended or closed; that change reports itself.
          if (generation === this.#generation) this.options.failed(error, bytes.length + this.clear());
        } finally {
          this.#current = undefined;
          this.#writingBytes = 0;
          if (diagnostics) diagnostics.pendingInputBytes -= bytes.length;
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /**
   * Writes one chunk, waiting out a full backend queue; true once the backend accepted it. Stops
   * quietly (false) when the session ends or the queue is cleared while waiting; the chunk is then
   * dropped with everything behind it, and the backend's last answer was "queue is full".
   */
  async #send(bytes: Uint8Array, generation: number): Promise<boolean> {
    const deadline = performance.now() + (this.options.retryLimitMs ?? INPUT_RETRY_LIMIT_MS);
    for (let delay = RETRY_FIRST_MS; ; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
      this.#requesting = true;
      try {
        await this.options.write(bytes);
        return true;
      } catch (error) {
        if (!isQueueFull(error) || performance.now() + delay > deadline) throw error;
      } finally {
        this.#requesting = false;
      }
      await wait(delay);
      if (generation !== this.#generation || !this.options.writable()) return false;
    }
  }

  /** Releases sent chunks without shifting the array on every write. */
  #compact() {
    if (this.#head === this.#chunks.length) {
      this.#chunks = [];
      this.#head = 0;
    } else if (this.#head >= 1024 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }
}
