/**
 * Isolated P0 experiment for Q04/Q06 (compressed, large scrollback). Not wired
 * into production terminals.
 *
 * xterm keeps a bounded "hot" scrollback. Every logical line (wrapped rows
 * joined) that has scrolled off the screen is copied, with its SGR attributes,
 * into a "cold" archive of deflate-compressed blocks before xterm can trim it.
 * A marker tracks the archive frontier: xterm moves markers through reflow and
 * trimming, and disposes one whose line is trimmed, which is reported as a gap
 * instead of silently losing history.
 */
import type { IBufferCell, IBufferLine, IMarker, Terminal } from "@xterm/xterm";

export interface HistoryStats {
  archivedLines: number;
  blocks: number;
  rawBytes: number;
  compressedBytes: number;
  pendingLines: number;
  /** Times the frontier was trimmed by xterm before it could be archived. */
  gaps: number;
  compressMs: number;
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
  data: Uint8Array;
}

const SGR = /\x1b\[[0-9;]*m/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function colorParams(mode: "fg" | "bg", cell: IBufferCell): number[] {
  const fg = mode === "fg";
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return [];
  const color = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return [fg ? 38 : 48, 2, (color >> 16) & 255, (color >> 8) & 255, color & 255];
  if (color < 8) return [(fg ? 30 : 40) + color];
  if (color < 16) return [(fg ? 90 : 100) + color - 8];
  return [fg ? 38 : 48, 5, color];
}

function cellSgr(cell: IBufferCell): string {
  const params = [0];
  if (cell.isBold()) params.push(1);
  if (cell.isDim()) params.push(2);
  if (cell.isItalic()) params.push(3);
  if (cell.isUnderline()) params.push(4);
  if (cell.isBlink()) params.push(5);
  if (cell.isInverse()) params.push(7);
  if (cell.isInvisible()) params.push(8);
  if (cell.isStrikethrough()) params.push(9);
  if (cell.isOverline()) params.push(53);
  params.push(...colorParams("fg", cell), ...colorParams("bg", cell));
  return `\x1b[${params.join(";")}m`;
}

/** One row as text with SGR changes; trailing blanks trimmed when `last`. */
function encodeRow(line: IBufferLine, cols: number, last: boolean, scratch: IBufferCell): string {
  let end = cols;
  if (last) {
    while (end > 0) {
      const cell = line.getCell(end - 1, scratch);
      if (cell && (cell.getChars() !== "" || cell.getWidth() === 0 || !cell.isBgDefault())) break;
      end--;
    }
  }
  let out = "";
  let current = "\x1b[0m";
  for (let x = 0; x < end; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell || cell.getWidth() === 0) continue; // second half of a wide character
    const sgr = cellSgr(cell);
    if (sgr !== current) {
      out += sgr;
      current = sgr;
    }
    out += cell.getChars() || " ";
  }
  return current === "\x1b[0m" ? out : `${out}\x1b[0m`;
}

export function stripSgr(line: string): string {
  return line.replace(SGR, "");
}

export class HistoryArchive {
  private frontier: IMarker | undefined;
  private started = false;
  private pending: string[] = [];
  private pendingBytes = 0;
  private blocks: Block[] = [];
  private queue: Promise<void> = Promise.resolve();
  private cache = new Map<number, string[]>();
  private archived = 0;
  private gaps = 0;
  private rawBytes = 0;
  private compressMs = 0;

  constructor(private readonly terminal: Terminal, private readonly blockLines = 512) {}

  /**
   * Archives every complete logical line that is entirely off screen. Call
   * after each `write` callback; one write must not add more rows than the
   * hot scrollback holds, or the frontier is trimmed and a gap is reported.
   */
  capture(): void {
    const buffer = this.terminal.buffer;
    if (buffer.active.type !== "normal") return; // alternate screen never scrolls into history
    const normal = buffer.normal;
    let row = 0;
    if (this.started) {
      if (!this.frontier || this.frontier.isDisposed) {
        this.gaps++;
        row = 0;
      } else {
        row = this.frontier.line;
      }
    }
    const scratch = normal.getNullCell();
    const cols = this.terminal.cols;
    while (row < normal.baseY) {
      let end = row;
      while (end + 1 < normal.length && normal.getLine(end + 1)?.isWrapped) end++;
      // Complete only if every row is off screen and the next row starts a new line.
      if (end >= normal.baseY || end + 1 >= normal.length) break;
      let text = "";
      for (let r = row; r <= end; r++) text += encodeRow(normal.getLine(r)!, cols, r === end, scratch);
      this.push(text);
      row = end + 1;
    }
    this.started = true;
    this.frontier?.dispose();
    this.frontier = this.terminal.registerMarker(row - (normal.baseY + normal.cursorY));
  }

  private push(line: string): void {
    this.pending.push(line);
    this.pendingBytes += encoder.encode(line).length + 1;
    this.archived++;
    if (this.pending.length >= this.blockLines) this.seal();
  }

  private seal(): void {
    if (!this.pending.length) return;
    const lines = this.pending;
    const first = this.archived - lines.length;
    const rawBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.rawBytes += rawBytes;
    this.queue = this.queue.then(async () => {
      const started = performance.now();
      const data = await transform(encoder.encode(lines.join("\n")), new CompressionStream("deflate-raw"));
      this.compressMs += performance.now() - started;
      this.blocks.push({ first, count: lines.length, rawBytes, data });
    });
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
      compressedBytes: this.blocks.reduce((total, block) => total + block.data.length, 0),
      pendingLines: this.pending.length,
      gaps: this.gaps,
      compressMs: Math.round(this.compressMs),
    };
  }

  private async block(index: number): Promise<string[]> {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const block = this.blocks[index];
    const lines = decoder.decode(await transform(block.data, new DecompressionStream("deflate-raw"))).split("\n");
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

  dispose(): void {
    this.frontier?.dispose();
    this.frontier = undefined;
    this.cache.clear();
  }
}
