/**
 * Compressed cold history (Q04/Q06). P0 proved the approach in isolation; since P1 slice 5,
 * step 5 every native workspace session captures into one (`history-capture.ts`), which since
 * step 6 also enforces the budget by dropping whole blocks, oldest first (`dropOldest`). There
 * is no history view or search UI yet.
 *
 * xterm keeps a bounded "hot" scrollback. Every logical line (wrapped rows joined) that has
 * scrolled off the screen is read, with its SGR attributes, through the terminal-core boundary
 * (`terminal-core.ts`) and appended here, in deflate-compressed blocks, before xterm can trim
 * it. The archive is read-only and append-only: it never sees the byte stream, parses no VT,
 * holds no cursor or mode state and has no input path, so it is not a second terminal. A hole
 * the source reports (rows trimmed before they could be read) is counted, never filled in.
 */
import type { HistorySource } from "../terminal-core";

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
  /** Oldest lines removed by `dropOldest`; the first line still held has this number. */
  droppedLines: number;
  droppedBlocks: number;
  /** Times rows were dropped by the terminal before they could be archived. */
  gaps: number;
  /** Times the program reset the terminal or erased its scrollback. */
  clears: number;
  /** Blocks kept uncompressed because the WebView could not compress them. */
  uncompressedBlocks: number;
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

export class HistoryArchive {
  /** Undefined once disposed: nothing is captured or kept after that. */
  private source: HistorySource | undefined;
  private pending: string[] = [];
  private blocks: Block[] = [];
  private queue: Promise<void> = Promise.resolve();
  /** Decoded blocks, keyed by their first line number (stable when older blocks are dropped). */
  private cache = new Map<number, string[]>();
  private archived = 0;
  private droppedLines = 0;
  private droppedBlocks = 0;
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
    if (gap) this.gaps++;
    if (cleared) this.clears++;
    for (const line of lines) {
      this.pending.push(line);
      this.archived++;
      if (this.pending.length >= this.blockLines) this.seal();
    }
    return lines.length || gap || cleared ? { lines: lines.length, gap, cleared } : NONE;
  }

  private seal(): void {
    if (!this.pending.length) return;
    const count = this.pending.length;
    const first = this.archived - count;
    const raw = encoder.encode(this.pending.join("\n"));
    this.pending = [];
    this.rawBytes += raw.length;
    this.queue = this.queue.then(() => this.compress(first, count, raw));
  }

  private async compress(first: number, count: number, raw: Uint8Array): Promise<void> {
    if (!this.source) return;
    const started = performance.now();
    let data = raw;
    let compressed = false;
    try {
      data = await transform(raw, new CompressionStream("deflate-raw"));
      compressed = true;
    } catch {
      // Counted in stats; the block is kept as is, so no history is lost.
      this.uncompressedBlocks++;
    }
    this.compressMs += performance.now() - started;
    if (!this.source) return;
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
    return { lines: block.count, bytes: block.data.length };
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
      gaps: this.gaps,
      clears: this.clears,
      uncompressedBlocks: this.uncompressedBlocks,
      compressMs: Math.round(this.compressMs),
    };
  }

  private async decode(block: Block): Promise<string[]> {
    const cached = this.cache.get(block.first);
    if (cached) return cached;
    const bytes = block.compressed ? await transform(block.data, new DecompressionStream("deflate-raw")) : block.data;
    const lines = decoder.decode(bytes).split("\n");
    // A block dropped while it was being decoded is not cached again.
    if (!this.blocks.includes(block)) return lines;
    if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(block.first, lines);
    return lines;
  }

  /**
   * Archived lines `[from, from + count)` with SGR, for rehydration or export. Dropped lines are
   * not returned: the result starts at `max(from, stats().droppedLines)`.
   */
  async lines(from: number, count: number): Promise<string[]> {
    await this.queue;
    const result: string[] = [];
    const end = Math.min(from + count, this.archived);
    from = Math.max(from, this.droppedLines);
    // A snapshot: blocks dropped while one is being decoded are still read consistently.
    const blocks = this.blocks.slice();
    for (const block of blocks) {
      if (result.length >= end - from) break;
      if (block.first + block.count <= from || block.first >= end) continue;
      const lines = await this.decode(block);
      for (let line = Math.max(from, block.first); line < Math.min(end, block.first + block.count); line++) {
        result.push(lines[line - block.first]);
      }
    }
    const pendingFirst = this.archived - this.pending.length;
    for (let line = Math.max(from, pendingFirst); line < end; line++) result.push(this.pending[line - pendingFirst]);
    return result;
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
    this.cache.clear();
  }
}
