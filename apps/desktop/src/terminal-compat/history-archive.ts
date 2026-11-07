/**
 * Compressed cold history (Q04/Q06). P0 proved the approach in isolation; since P1 slice 5,
 * step 5 every native workspace session captures into one (`history-capture.ts`). There is no
 * history view, search UI or budget enforcement yet.
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
  archivedLines: number;
  blocks: number;
  /** UTF-8 bytes of the sealed blocks before compression. */
  rawBytes: number;
  /** Bytes the sealed blocks occupy, compressed or (if compression failed) not. */
  compressedBytes: number;
  pendingLines: number;
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
  private cache = new Map<number, string[]>();
  private archived = 0;
  private gaps = 0;
  private clears = 0;
  private rawBytes = 0;
  private compressedBytes = 0;
  private uncompressedBlocks = 0;
  private compressMs = 0;

  constructor(source: HistorySource, private readonly blockLines = 512) {
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
      gaps: this.gaps,
      clears: this.clears,
      uncompressedBlocks: this.uncompressedBlocks,
      compressMs: Math.round(this.compressMs),
    };
  }

  private async block(index: number): Promise<string[]> {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const block = this.blocks[index];
    const bytes = block.compressed ? await transform(block.data, new DecompressionStream("deflate-raw")) : block.data;
    const lines = decoder.decode(bytes).split("\n");
    if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(index, lines);
    return lines;
  }

  /** Archived lines `[from, from + count)` with SGR, for rehydration or export. */
  async lines(from: number, count: number): Promise<string[]> {
    await this.queue;
    const result: string[] = [];
    const end = Math.min(from + count, this.archived);
    for (let index = 0; index < this.blocks.length && result.length < end - from; index++) {
      const block = this.blocks[index];
      if (block.first + block.count <= from || block.first >= end) continue;
      const lines = await this.block(index);
      for (let line = Math.max(from, block.first); line < Math.min(end, block.first + block.count); line++) {
        result.push(lines[line - block.first]);
      }
    }
    const pendingFirst = this.archived - this.pending.length;
    for (let line = Math.max(from, pendingFirst); line < end; line++) result.push(this.pending[line - pendingFirst]);
    return result;
  }

  /** Plain-text search over archived lines, decompressing one block at a time. */
  async search(query: string, limit = 100): Promise<HistoryMatch[]> {
    await this.queue;
    const matches: HistoryMatch[] = [];
    const scan = (line: string, number: number) => {
      const column = stripSgr(line).indexOf(query);
      if (column >= 0) matches.push({ line: number, column });
    };
    for (let index = 0; index < this.blocks.length && matches.length < limit; index++) {
      const block = this.blocks[index];
      (await this.block(index)).forEach((line, offset) => { if (matches.length < limit) scan(line, block.first + offset); });
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
