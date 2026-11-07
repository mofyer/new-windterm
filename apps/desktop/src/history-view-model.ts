import type { Terminal } from "@xterm/xterm";
import type { HistoryReader } from "./terminal-compat/history-archive";
import { xtermBufferLines } from "./terminal-core";
import { parseLine, plainText, type ParsedLine } from "./history-sgr";
import { HISTORY_VIEW_CACHE_LINES } from "./history-budget";
import type { SearchSource } from "./history-search";

/**
 * What the read-only history view shows of one session (P1 slice 5, step 7): a snapshot taken
 * when the view opens or is refreshed. Lines are numbered from the first line of the session's
 * history (line 0 is shown as 1), so lines dropped by the budget or cleared by the user keep their
 * numbers' place and the numbering continues without a jump from the archive into the screen.
 *
 * - With an archive, lines `[first, tailFirst)` are read from it on demand (decompressing only
 *   the blocks needed). Every line that has left the screen is archived as it leaves, so this part
 *   already covers xterm's hot scrollback. `tail` are the lines not archived yet (the screen and
 *   anything written since the last capture), copied from the normal buffer through the
 *   terminal-core boundary without moving the archive's position.
 * - Without one (demo session, or capture stopped after an error), every line of the normal
 *   buffer is the tail, numbered from 1.
 *
 * The snapshot never changes: new output is announced, not merged in. Lines the archive drops or
 * clears after the snapshot are reported as no longer held when they are read.
 */

export type ViewMarkKind = "gap" | "clear" | "screen";
export interface ViewMark {
  /** Shown just before this line. */
  readonly line: number;
  readonly kind: ViewMarkKind;
}

export type ViewSource = "archive" | "buffer" | "stopped";

export interface Snapshot {
  readonly source: ViewSource;
  /** First line held when the snapshot was taken. */
  readonly first: number;
  /** Number of `tail[0]`, one past the newest archived line. */
  readonly tailFirst: number;
  readonly tail: readonly string[];
  /** Sorted by line; only within `[first, end]`. */
  readonly marks: readonly ViewMark[];
  /** Lines dropped by the budget and cleared by the user before `first`, at the snapshot. */
  readonly dropped: number;
  readonly cleared: number;
  readonly marksOmitted: number;
}

export type RowItem =
  | { readonly kind: "top" }
  | { readonly kind: "mark"; readonly mark: ViewMark }
  | { readonly kind: "line"; readonly line: number };

/** Takes a snapshot of `reader` (or of the terminal's buffer without one). Never writes to the terminal. */
export function takeSnapshot(reader: HistoryReader | undefined, terminal: Terminal, stopped: boolean): Snapshot {
  const unread = reader?.unread();
  if (!reader || !unread) {
    return Object.freeze({
      source: stopped ? "stopped" : "buffer", first: 0, tailFirst: 0, tail: Object.freeze(xtermBufferLines(terminal)),
      marks: Object.freeze([]), dropped: 0, cleared: 0, marksOmitted: 0,
    });
  }
  const held = reader.held();
  const stats = reader.stats();
  const marks: ViewMark[] = held.marks.map((mark) => ({ line: mark.line, kind: mark.kind }));
  if (!unread.certain) marks.push({ line: held.end, kind: "gap" });
  if (unread.lines.length) marks.push({ line: held.end, kind: "screen" });
  return Object.freeze({
    source: "archive", first: held.first, tailFirst: held.end, tail: Object.freeze(unread.lines.slice()),
    marks: Object.freeze(marks), dropped: stats.droppedLines, cleared: stats.clearedLines, marksOmitted: held.marksOmitted,
  });
}

/** Rows of a snapshot: an optional top row for lines no longer held, then lines with marks before them. */
export class RowMap {
  readonly top: number;
  readonly lineCount: number;
  readonly rowCount: number;
  /** One past the last line number. */
  readonly end: number;

  constructor(private readonly snapshot: Snapshot) {
    this.top = snapshot.first > 0 ? 1 : 0;
    this.end = snapshot.tailFirst + snapshot.tail.length;
    this.lineCount = this.end - snapshot.first;
    this.rowCount = this.top + this.lineCount + snapshot.marks.length;
  }

  private markRow(index: number): number {
    return this.top + (this.snapshot.marks[index].line - this.snapshot.first) + index;
  }

  /** What row `row` shows. */
  item(row: number): RowItem {
    if (row < this.top) return { kind: "top" };
    const marks = this.snapshot.marks;
    // Largest mark index whose row is at or before `row`.
    let low = 0;
    let high = marks.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.markRow(middle) <= row) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (found >= 0 && this.markRow(found) === row) return { kind: "mark", mark: marks[found] };
    return { kind: "line", line: this.snapshot.first + row - this.top - (found + 1) };
  }

  /** The row of line `line` (after the marks placed before it). */
  rowOf(line: number): number {
    const marks = this.snapshot.marks;
    let low = 0;
    let high = marks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (marks[middle].line <= line) low = middle + 1;
      else high = middle;
    }
    return this.top + (line - this.snapshot.first) + low;
  }

  /** Last line number, or -1 if there is none. */
  get lastLine(): number {
    return this.lineCount ? this.end - 1 : -1;
  }
}

/** A line as the view draws it; `undefined` while loading, `null` once no longer held. */
export type LineState = ParsedLine | null | undefined;

/** Code units of parsed lines kept for redrawing; a line longer than a quarter of it is not kept. */
const CACHE_CHARS = 4 * 1024 * 1024;

/**
 * Parsed lines of one snapshot. Tail lines are always at hand; archive lines are fetched in
 * batches and kept in a bounded cache (by line count and by text size).
 */
export class LineStore {
  private cache = new Map<number, ParsedLine | null>();
  private cachedChars = 0;
  private loading = new Set<number>();
  private disposed = false;

  constructor(private readonly snapshot: Snapshot, private readonly reader: HistoryReader | undefined) {}

  /** The parsed line, if it is at hand. */
  get(line: number): LineState {
    const { tailFirst, tail } = this.snapshot;
    if (line >= tailFirst) return line - tailFirst < tail.length ? parseLine(tail[line - tailFirst]) : null;
    const cached = this.cache.get(line);
    if (cached !== undefined) {
      // Most recently used last.
      this.cache.delete(line);
      this.cache.set(line, cached);
    }
    return cached;
  }

  private keep(line: number, parsed: ParsedLine | null) {
    const size = parsed?.text.length ?? 0;
    if (size > CACHE_CHARS / 4) return;
    this.cache.set(line, parsed);
    this.cachedChars += size;
    for (const [old, value] of this.cache) {
      if (this.cache.size <= HISTORY_VIEW_CACHE_LINES && this.cachedChars <= CACHE_CHARS) break;
      this.cache.delete(old);
      this.cachedChars -= value?.text.length ?? 0;
    }
  }

  /** Fetches the archive lines of `[from, to)` not at hand; resolves true if any arrived. */
  async load(from: number, to: number): Promise<boolean> {
    if (!this.reader || this.disposed) return false;
    const start = Math.max(from, this.snapshot.first);
    const end = Math.min(to, this.snapshot.tailFirst);
    let first = -1;
    for (let line = start; line < end; line++) {
      if (!this.cache.has(line) && !this.loading.has(line)) {
        first = line;
        break;
      }
    }
    if (first < 0) return false;
    for (let line = first; line < end; line++) this.loading.add(line);
    try {
      const lines = await this.reader.read(first, end - first);
      if (this.disposed) return false;
      // `read` starts at the first line still held: the ones before it were dropped or cleared.
      const missing = end - first - lines.length;
      for (let line = first; line < end; line++) {
        this.keep(line, line - first < missing ? null : parseLine(lines[line - first - missing]));
      }
      return true;
    } finally {
      for (let line = first; line < end; line++) this.loading.delete(line);
    }
  }

  /**
   * Plain text of lines `[from, to]` for copying, fetched in batches; `null` for a line no
   * longer held.
   */
  async plain(from: number, to: number): Promise<(string | null)[]> {
    const { tailFirst, tail, first } = this.snapshot;
    const result: (string | null)[] = [];
    for (let start = from; start <= to && start < tailFirst; start += 4096) {
      const end = Math.min(to + 1, tailFirst, start + 4096);
      const lines = this.reader && start >= first ? await this.reader.read(start, end - start) : [];
      const missing = end - start - lines.length;
      for (let i = 0; i < end - start; i++) result.push(i < missing ? null : plainText(lines[i - missing]));
    }
    for (let line = Math.max(from, tailFirst); line <= to; line++) {
      const raw = tail[line - tailFirst];
      result.push(raw === undefined ? null : plainText(raw));
    }
    return result;
  }

  /** What a search walks. */
  searchSource(): SearchSource {
    return { tailFirst: this.snapshot.tailFirst, tail: this.snapshot.tail, archive: this.reader };
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.cachedChars = 0;
    this.loading.clear();
  }
}
