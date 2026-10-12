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

interface Chunk {
  bytes: Uint8Array;
  queuedAt: number;
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
  /** Bumped by {@link clear}; a write that fails after a clear belongs to a finished session. */
  #generation = 0;

  constructor(private readonly options: InputQueueOptions) {}

  /** Bytes accepted but not yet confirmed by the backend. */
  get pendingBytes(): number {
    return this.#queuedBytes + this.#writingBytes;
  }

  /** Queues `bytes` as a whole, or returns false (and queues nothing) when over the backlog bound. */
  push(bytes: Uint8Array): boolean {
    if (!bytes.length) return true;
    if (this.pendingBytes + bytes.length > INPUT_BACKLOG_BYTES) return false;
    const queuedAt = diagnostics ? performance.now() : 0;
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES)
      this.#chunks.push({ bytes: bytes.subarray(offset, offset + INPUT_CHUNK_BYTES), queuedAt });
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
    this.#chunks = [];
    this.#head = 0;
    this.#queuedBytes = 0;
    this.#generation++;
    return dropped;
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (this.#head < this.#chunks.length) {
        if (!this.options.writable()) {
          this.clear();
          break;
        }
        const { bytes, queuedAt } = this.#chunks[this.#head++];
        this.#queuedBytes -= bytes.length;
        this.#writingBytes = bytes.length;
        this.#compact();
        const generation = this.#generation;
        if (diagnostics) {
          diagnostics.maxInputWaitMs = Math.max(diagnostics.maxInputWaitMs, performance.now() - queuedAt);
          diagnostics.inputCalls++;
        }
        try {
          await this.#send(bytes, generation);
        } catch (error) {
          // After a clear the session already ended or closed; that change reports itself.
          if (generation === this.#generation) this.options.failed(error, bytes.length + this.clear());
        } finally {
          this.#writingBytes = 0;
          if (diagnostics) diagnostics.pendingInputBytes -= bytes.length;
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /**
   * Writes one chunk, waiting out a full backend queue. Stops quietly when the session ends or the
   * queue is cleared meanwhile; the chunk is then dropped with everything behind it.
   */
  async #send(bytes: Uint8Array, generation: number): Promise<void> {
    const deadline = performance.now() + (this.options.retryLimitMs ?? INPUT_RETRY_LIMIT_MS);
    for (let delay = RETRY_FIRST_MS; ; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
      try {
        await this.options.write(bytes);
        return;
      } catch (error) {
        if (!isQueueFull(error) || performance.now() + delay > deadline) throw error;
      }
      await wait(delay);
      if (generation !== this.#generation || !this.options.writable()) return;
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
