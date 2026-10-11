/**
 * Isolated P0 experiment for G16/G17 (text folding and outline). Not wired
 * into production terminals.
 *
 * xterm cannot hide rows of its live buffer through public API, so folding is
 * applied to a read-only history view rendered from logical lines (for
 * example the compressed archive). A folded range is shown as one summary row;
 * every view row maps back to logical lines, so selection, copy and search
 * keep working on the original content.
 */
import type { Terminal } from "@xterm/xterm";
import { stripSgr } from "./history-archive";

export interface Fold { start: number; end: number }
export interface OutlineItem { line: number; title: string; end: number }
type Entry = { kind: "line"; line: number } | { kind: "fold"; start: number; end: number };

export class FoldView {
  private folds: Fold[] = [];
  private entries: Entry[] = [];
  /** First buffer row of each entry, rebuilt after every render or resize. */
  private starts: number[] = [];

  constructor(private readonly view: Terminal, private readonly lines: readonly string[]) {
    view.onResize(() => this.index());
  }

  /** Sections that start at lines matching `prompt` and run to the next one. */
  outline(prompt: RegExp): OutlineItem[] {
    const heads = this.lines.flatMap((line, index) => (prompt.test(stripSgr(line)) ? [index] : []));
    return heads.map((line, i) => ({ line, title: stripSgr(this.lines[line]).trim(), end: (heads[i + 1] ?? this.lines.length) - 1 }));
  }

  fold(start: number, end: number): void {
    if (end <= start || start < 0 || end >= this.lines.length) throw new Error("Invalid fold range");
    if (this.folds.some(f => !(end < f.start || start > f.end))) throw new Error("Folds must not overlap");
    this.folds = [...this.folds, { start, end }].sort((a, b) => a.start - b.start);
  }

  unfold(line: number): boolean {
    const before = this.folds.length;
    this.folds = this.folds.filter(f => line < f.start || line > f.end);
    return this.folds.length !== before;
  }

  foldedRanges(): Fold[] {
    return this.folds.map(f => ({ ...f }));
  }

  /** Rewrites the view; resolves once xterm has parsed it. */
  render(): Promise<void> {
    this.entries = [];
    this.view.reset();
    let text = "";
    for (let line = 0; line < this.lines.length; line++) {
      const fold = this.folds.find(f => f.start === line);
      if (fold) {
        this.entries.push({ kind: "fold", start: fold.start, end: fold.end });
        text += `\x1b[0;2m▸ ${stripSgr(this.lines[line]).trim()} … (${fold.end - fold.start + 1} 行已折叠)\x1b[0m\r\n`;
        line = fold.end;
      } else {
        this.entries.push({ kind: "line", line });
        text += `${this.lines[line]}\r\n`;
      }
    }
    return new Promise(resolve => this.view.write(text, () => { this.index(); resolve(); }));
  }

  /** Entry starts are the rows that are not soft-wrapped continuations. */
  private index(): void {
    const buffer = this.view.buffer.active;
    const starts: number[] = [];
    for (let row = 0; row < buffer.length && starts.length < this.entries.length; row++) {
      if (!buffer.getLine(row)?.isWrapped) starts.push(row);
    }
    this.starts = starts;
  }

  private entryAt(row: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle] <= row) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** Logical lines covered by view rows `[from, to]`, folds expanded. */
  linesForRows(from: number, to: number): number[] {
    const result: number[] = [];
    for (let entry = this.entryAt(from); entry <= this.entryAt(to); entry++) {
      const item = this.entries[entry];
      if (item.kind === "line") result.push(item.line);
      else for (let line = item.start; line <= item.end; line++) result.push(line);
    }
    return result;
  }

  /** Copies the current selection as whole logical lines, expanding folds. */
  copySelection(): string {
    const position = this.view.getSelectionPosition();
    if (!position) return "";
    return this.linesForRows(position.start.y, position.end.y).map(line => stripSgr(this.lines[line])).join("\n");
  }

  /** First view row of a logical line, or of the fold that hides it. */
  rowOf(line: number): number {
    const entry = this.entries.findIndex(item => (item.kind === "line" ? item.line === line : line >= item.start && line <= item.end));
    return entry < 0 ? -1 : this.starts[entry];
  }

  /**
   * Finds the next match from `fromLine`, unfolding a fold that hides it, and
   * selects it in the view. Returns the logical line or -1.
   */
  async find(query: string, fromLine = 0): Promise<number> {
    for (let line = fromLine; line < this.lines.length; line++) {
      const column = stripSgr(this.lines[line]).indexOf(query);
      if (column < 0) continue;
      if (this.unfold(line)) await this.render();
      const start = this.rowOf(line);
      const buffer = this.view.buffer.active;
      // Walk the entry's rows to place the selection on the row holding the match.
      let row = start;
      let offset = column;
      while (row + 1 < buffer.length && buffer.getLine(row + 1)?.isWrapped) {
        const width = buffer.getLine(row)!.translateToString(false).length;
        if (offset < width) break;
        offset -= width;
        row++;
      }
      this.view.select(offset, row, query.length);
      this.view.scrollToLine(Math.max(0, row - 1));
      return line;
    }
    return -1;
  }
}
