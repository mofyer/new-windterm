/**
 * Compressed cold history (Q04/Q06). P0 proved the approach in isolation; since P1 slice 5,
 * step 5 every native workspace session captures into one (`history-capture.ts`), which since
 * step 6 also enforces the budget by dropping whole blocks, oldest first (`dropOldest`), and
 * since T32 empties it when the user clears the scrollback (`clear`). Since step 7 the read-only
 * history view (`history-view.ts`) reads it through {@link HistoryReader}: `held` says which lines
 * are still held and where a gap or a reset lies, `read` and `scanBackward` return lines without
 * waiting for queued compression, and `unread` gives the screen that is not archived yet.
 *
 * xterm keeps a bounded "hot" scrollback. Every logical line (wrapped rows joined) that has
 * scrolled off the screen is read, with its SGR attributes, through the terminal-core boundary
 * (`terminal-core.ts`) and appended here, in deflate-compressed blocks, before xterm can trim
 * it. The archive is read-only and append-only: it never sees the byte stream, parses no VT,
 * holds no cursor or mode state and has no input path, so it is not a second terminal. A hole
 * the source reports (rows trimmed before they could be read) is counted, never filled in.
 */
import type { HistorySource, Unread } from "../terminal-core";

export interface HistoryStats {
  /** Logical lines ever archived, dropped ones included; line numbers count from the first. */
  archivedLines: number;
  /** Completed blocks still held. */
  blocks: number;
  /** UTF-8 bytes, before compression, of the sealed blocks still held (queued ones included). */
  rawBytes: number;
  /** Bytes the completed blocks still held occupy, compressed or (if compression failed) not. */
  compressedBytes: number;
  pendingLines: number;
  /** Oldest lines removed by `dropOldest`. The first line still held has number `droppedLines + clearedLines`. */
  droppedLines: number;
  droppedBlocks: number;
  /** Lines removed by `clear` (the user cleared the scrollback), counted separately from budget drops. */
  clearedLines: number;
  /** Times `clear` was called. */
  userClears: number;
  /** Times rows were dropped by the terminal before they could be archived. */
  gaps: number;
  /** Times the terminal was reset or its scrollback erased, by the program or by a user action (T32). */
  clears: number;
  /**
   * Blocks the WebView could not compress, so they were added as is. Cumulative, like `gaps` and
   * `clears`: not reduced when such a block is later dropped or cleared.
   */
  uncompressedBlocks: number;
  /** Time spent compressing, cumulative (blocks later dropped or cleared included). */
  compressMs: number;
}

/** What one capture added. */
export interface CaptureResult {
  readonly lines: number;
  readonly gap: boolean;
  readonly cleared: boolean;
}

/** What one `dropOldest` removed. */
export interface DroppedBlock {
  readonly lines: number;
  readonly bytes: number;
}

/** Where the source reported a hole or a reset: just before line `line` (absolute). */
export interface HistoryMark {
  readonly line: number;
  /** `gap`: rows were trimmed before they could be archived. `clear`: a reset (RIS) or scrollback erase (ED 3). */
  readonly kind: "gap" | "clear";
}

/** The lines still held, `[first, end)`, and the marks within them, oldest first. */
export interface HistoryHeld {
  /** First line still held: `droppedLines + clearedLines`. */
  readonly first: number;
  /** One past the newest archived line (`archivedLines`). */
  readonly end: number;
  readonly marks: readonly HistoryMark[];
  /** Older marks forgotten because more than {@link MAX_HISTORY_MARKS} were seen. */
  readonly marksOmitted: number;
}

/**
 * The read-only part of an archive, for the history view: nothing here captures, drops, clears or
 * otherwise changes what is held.
 */
export interface HistoryReader {
  stats(): HistoryStats;
  held(): HistoryHeld;
  read(from: number, count: number): Promise<string[]>;
  scanBackward(
    before: number, visit: (first: number, lines: readonly string[]) => boolean | Promise<boolean>, signal?: AbortSignal,
  ): Promise<boolean>;
  unread(): Unread | undefined;
}

/** Marks kept per archive; past this the oldest are forgotten and counted. */
export const MAX_HISTORY_MARKS = 4096;

export interface HistoryMatch {
  /** Absolute logical line number, counted from the first archived line. */
  line: number;
  column: number;
}

interface Block {
  first: number;
  count: number;
  rawBytes: number;
  compressed: boolean;
  data: Uint8Array;
}

/** A sealed block waiting for compression; readable from its raw bytes until it is added. */
interface Sealing {
  first: number;
  count: number;
  raw: Uint8Array;
}

const SGR = /\x1b\[[0-9;]*m/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NONE: CaptureResult = Object.freeze({ lines: 0, gap: false, cleared: false });

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function stripSgr(line: string): string {
  return line.replace(SGR, "");
}

export class HistoryArchive implements HistoryReader {
  /** Undefined once disposed: nothing is captured or kept after that. */
  private source: HistorySource | undefined;
  private pending: string[] = [];
  private blocks: Block[] = [];
  /** Sealed blocks queued for compression, oldest first; always newer than every completed block. */
  private sealing: Sealing[] = [];
  private markList: HistoryMark[] = [];
  private marksOmitted = 0;
  private queue: Promise<void> = Promise.resolve();
  /** Decoded blocks, keyed by their first line number (stable when older blocks are dropped). */
  private cache = new Map<number, string[]>();
  private archived = 0;
  private droppedLines = 0;
  private droppedBlocks = 0;
  private clearedLines = 0;
  private userClears = 0;
  /** Bumped by `clear`: a compression result of an older generation is discarded on arrival. */
  private generation = 0;
  private gaps = 0;
  private clears = 0;
  private rawBytes = 0;
  private compressedBytes = 0;
  private uncompressedBlocks = 0;
  private compressMs = 0;

  /**
   * @param onBlock Called after each block is compressed and added, so a budget can be applied
   *   to the new size. Must not throw: it runs in the compression queue.
   */
  constructor(source: HistorySource, private readonly blockLines = 512, private readonly onBlock?: () => void) {
    this.source = source;
  }

  /** Appends what the source reports since the previous capture; call after each write callback. */
  capture(): CaptureResult {
    if (!this.source) return NONE;
    const { lines, gap, cleared } = this.source.read();
    // The lines of this read come after the hole or the reset.
    if (gap) {
      this.gaps++;
      this.mark("gap");
    }
    if (cleared) {
      this.clears++;
      this.mark("clear");
    }
    for (const line of lines) {
      this.pending.push(line);
      this.archived++;
      if (this.pending.length >= this.blockLines) this.seal();
    }
    return lines.length || gap || cleared ? { lines: lines.length, gap, cleared } : NONE;
  }

  private mark(kind: HistoryMark["kind"]): void {
    const line = this.archived;
    const last = this.markList[this.markList.length - 1];
    if (last?.line === line && last.kind === kind) return;
    if (this.markList.length >= MAX_HISTORY_MARKS) {
      this.markList.shift();
      this.marksOmitted++;
    }
    this.markList.push(Object.freeze({ line, kind }));
  }

  /** Forgets the marks before the first line still held. */
  private pruneMarks(): void {
    const first = this.droppedLines + this.clearedLines;
    let drop = 0;
    while (drop < this.markList.length && this.markList[drop].line < first) drop++;
    if (drop) this.markList = this.markList.slice(drop);
  }

  private seal(): void {
    if (!this.pending.length) return;
    const count = this.pending.length;
    const first = this.archived - count;
    const raw = encoder.encode(this.pending.join("\n"));
    this.pending = [];
    this.rawBytes += raw.length;
    const generation = this.generation;
    const sealing: Sealing = { first, count, raw };
    this.sealing.push(sealing);
    this.queue = this.queue.then(() => this.compress(sealing, generation));
  }

  private async compress(sealing: Sealing, generation: number): Promise<void> {
    const { first, count, raw } = sealing;
    // In every outcome the block leaves `sealing` in the same synchronous step in which it is added
    // to `blocks` (or discarded), so a reader finds it in exactly one of the two.
    const done = () => {
      const at = this.sealing.indexOf(sealing);
      if (at >= 0) this.sealing.splice(at, 1);
    };
    if (!this.source || generation !== this.generation) {
      done();
      return;
    }
    const started = performance.now();
    let data = raw;
    let compressed = false;
    try {
      data = await transform(raw, new CompressionStream("deflate-raw"));
      compressed = true;
    } catch {
      // Counted in stats below; the block is kept as is, so no history is lost.
    }
    this.compressMs += performance.now() - started;
    done();
    // Disposed, or cleared while this block was being compressed: it is no longer held.
    if (!this.source || generation !== this.generation) return;
    if (!compressed) this.uncompressedBlocks++;
    this.blocks.push({ first, count, rawBytes: raw.length, compressed, data });
    this.compressedBytes += data.length;
    this.onBlock?.();
  }

  /**
   * Drops the oldest completed block as a whole and returns what it held; undefined if there is
   * none. Lines still pending or queued for compression are never dropped. Line numbers of the
   * remaining lines do not change.
   */
  dropOldest(): DroppedBlock | undefined {
    const block = this.blocks.shift();
    if (!block) return undefined;
    this.cache.delete(block.first);
    this.compressedBytes -= block.data.length;
    this.rawBytes -= block.rawBytes;
    this.droppedLines += block.count;
    this.droppedBlocks++;
    this.pruneMarks();
    return { lines: block.count, bytes: block.data.length };
  }

  /**
   * Discards every line held, as the user's "clear scrollback" asks (T32): completed blocks,
   * blocks still being compressed (their results are dropped when they arrive) and the pending
   * lines. Returns how many lines that was. Line numbers keep counting, so the next archived line
   * gets number `archivedLines` and no cleared line is ever returned again. The source is kept:
   * capture continues where the terminal is now. Counts of what was observed (gaps, clears,
   * budget drops) are kept as well.
   */
  clear(): number {
    const held = this.archived - this.droppedLines - this.clearedLines;
    this.generation++;
    this.pending = [];
    this.blocks = [];
    this.sealing = [];
    this.markList = [];
    this.marksOmitted = 0;
    this.cache.clear();
    this.rawBytes = 0;
    this.compressedBytes = 0;
    this.clearedLines += held;
    this.userClears++;
    return held;
  }

  /** Waits for queued compression; optionally seals the partial block too. */
  async flush(sealPartial = false): Promise<void> {
    if (sealPartial) this.seal();
    await this.queue;
  }

  stats(): HistoryStats {
    return {
      archivedLines: this.archived,
      blocks: this.blocks.length,
      rawBytes: this.rawBytes,
      compressedBytes: this.compressedBytes,
      pendingLines: this.pending.length,
      droppedLines: this.droppedLines,
      droppedBlocks: this.droppedBlocks,
      clearedLines: this.clearedLines,
      userClears: this.userClears,
      gaps: this.gaps,
      clears: this.clears,
      uncompressedBlocks: this.uncompressedBlocks,
      compressMs: Math.round(this.compressMs),
    };
  }

  private async decodeData(block: Block): Promise<string[]> {
    const bytes = block.compressed ? await transform(block.data, new DecompressionStream("deflate-raw")) : block.data;
    return decoder.decode(bytes).split("\n");
  }

  private async decode(block: Block): Promise<string[]> {
    const cached = this.cache.get(block.first);
    if (cached) return cached;
    const lines = await this.decodeData(block);
    // A block dropped while it was being decoded is not cached again.
    if (!this.blocks.includes(block)) return lines;
    if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(block.first, lines);
    return lines;
  }

  /** The lines still held and the marks within them. */
  held(): HistoryHeld {
    return Object.freeze({
      first: this.droppedLines + this.clearedLines,
      end: this.archived,
      marks: Object.freeze(this.markList.slice()),
      marksOmitted: this.marksOmitted,
    });
  }

  /** What the source has not archived yet (the screen); undefined once disposed. */
  unread(): Unread | undefined {
    return this.source?.unread();
  }

  /**
   * Archived lines `[from, from + count)` with SGR, for rehydration or export, once queued
   * compression is done. Dropped and cleared lines are not returned: the result starts at
   * `max(from, droppedLines + clearedLines)`.
   */
  async lines(from: number, count: number): Promise<string[]> {
    await this.queue;
    return this.read(from, count);
  }

  /**
   * Like `lines`, without waiting for queued compression: a queued block is read from its raw
   * bytes. Only the completed blocks needed are decompressed (the last two are cached). Dropped
   * and cleared lines are not returned: the result starts at `max(from, droppedLines + clearedLines)`.
   */
  async read(from: number, count: number): Promise<string[]> {
    const end = Math.min(from + count, this.archived);
    // Both removals take the oldest lines still held, so the lines held stay one contiguous range.
    from = Math.max(from, this.droppedLines + this.clearedLines);
    if (from >= end) return [];
    // A snapshot: blocks dropped, sealed or added while one is being decoded are read consistently.
    const blocks = this.blocks.slice();
    const sealing = this.sealing.slice();
    const pending = this.pending.slice();
    const pendingFirst = this.archived - pending.length;
    const result: string[] = [];
    const take = (first: number, lines: readonly string[]) => {
      for (let line = Math.max(from, first); line < Math.min(end, first + lines.length); line++) result.push(lines[line - first]);
    };
    for (const block of blocks) {
      if (block.first + block.count > from && block.first < end) take(block.first, await this.decode(block));
    }
    for (const block of sealing) {
      if (block.first + block.count > from && block.first < end) take(block.first, decoder.decode(block.raw).split("\n"));
    }
    take(pendingFirst, pending);
    return result;
  }

  /**
   * Visits the lines held before line `before`, newest first: the pending lines, then queued
   * blocks, then completed blocks, one block per call (decompressed without filling the cache, so
   * a search does not evict what a view is showing). `visit` gets the absolute number of the first
   * line of the batch; returning false stops the walk, as does an aborted `signal`, checked before
   * and after every decompression. Resolves true if it reached the oldest line held at the start.
   */
  async scanBackward(
    before: number, visit: (first: number, lines: readonly string[]) => boolean | Promise<boolean>, signal?: AbortSignal,
  ): Promise<boolean> {
    const pending = this.pending.slice();
    const batches: { first: number; lines: () => Promise<readonly string[]> }[] = [
      ...this.blocks.map((block) => ({
        first: block.first,
        lines: async () => this.cache.get(block.first) ?? this.decodeData(block),
      })),
      ...this.sealing.map((block) => ({ first: block.first, lines: async () => decoder.decode(block.raw).split("\n") })),
      { first: this.archived - pending.length, lines: async () => pending },
    ];
    for (let index = batches.length - 1; index >= 0; index--) {
      if (signal?.aborted) return false;
      const batch = batches[index];
      if (batch.first >= before) continue;
      const lines = await batch.lines();
      if (signal?.aborted) return false;
      const kept = before - batch.first < lines.length ? lines.slice(0, before - batch.first) : lines;
      if (kept.length && !(await visit(batch.first, kept))) return false;
    }
    return true;
  }

  /** Plain-text search over the lines still held, decompressing one block at a time. */
  async search(query: string, limit = 100): Promise<HistoryMatch[]> {
    await this.queue;
    const matches: HistoryMatch[] = [];
    const scan = (line: string, number: number) => {
      const column = stripSgr(line).indexOf(query);
      if (column >= 0) matches.push({ line: number, column });
    };
    for (const block of this.blocks.slice()) {
      if (matches.length >= limit) break;
      (await this.decode(block)).forEach((line, offset) => { if (matches.length < limit) scan(line, block.first + offset); });
    }
    const pendingFirst = this.archived - this.pending.length;
    this.pending.forEach((line, offset) => { if (matches.length < limit) scan(line, pendingFirst + offset); });
    return matches;
  }

  /** Releases the terminal hooks and every archived line; queued compression results are dropped. */
  dispose(): void {
    this.source?.dispose();
    this.source = undefined;
    this.pending = [];
    this.blocks = [];
    this.sealing = [];
    this.markList = [];
    this.cache.clear();
  }
}
