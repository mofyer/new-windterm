import type { IBufferCell, IBufferLine, IBufferNamespace, IDisposable, IMarker, Terminal } from "@xterm/xterm";

/**
 * Terminal-core boundary (H4 in docs/p0/TERMINAL_CORE_ADR.zh-CN.md), history capabilities only.
 *
 * Features that derive data from the live terminal (the cold history archive now; folding,
 * outline and Free Type later) read it through this boundary instead of reaching into xterm.js
 * themselves. xterm.js is the first and only implementation and stays the single live terminal
 * state: the boundary reads its buffer through public API after xterm has parsed a write, and
 * never writes to the terminal, never sees the byte stream, never parses VT and keeps no cursor,
 * mode, charset or screen state. Its only parser use is two observers that return `false`, so
 * xterm.js still runs its own handlers: they note that a reset or a scrollback erase happened.
 */

/** What one read found since the previous read. */
export interface ScrolledOff {
  /** Complete logical lines (wrapped rows joined) that left the screen, oldest first, as text with SGR. */
  readonly lines: readonly string[];
  /** The terminal dropped rows before they could be read: the history has a hole here. */
  readonly gap: boolean;
  /** The program reset the terminal (RIS) or erased its scrollback (ED 3) since the last read. */
  readonly cleared: boolean;
}

/** Read-only source of the history that has scrolled off a live terminal's screen. */
export interface HistorySource extends IDisposable {
  /**
   * Logical lines that have entirely left the screen since the previous call. Call it from the
   * write callback of every chunk: a chunk that pushes more rows than the scrollback holds loses
   * rows before they can be read, and a logical line longer than the scrollback loses its start.
   * Both are reported as a gap, never filled in.
   */
  read(): ScrolledOff;
}

const DEFAULT_SGR = "\x1b[0m";
const NOTHING: ScrolledOff = Object.freeze({ lines: Object.freeze([]), gap: false, cleared: false });

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

/**
 * One row as text with SGR changes. Cells after the last written character are dropped (so a
 * wide character's wrap padding never becomes a space), except for a coloured erase that reaches
 * the last column of a logical line's last row. Only cells up to that end are visited: the
 * trimmed text comes from `translateToString`, which xterm.js computes without per-cell calls.
 */
function encodeRow(line: IBufferLine, last: boolean, cell: IBufferCell): string {
  const text = line.translateToString(true);
  const width = line.length;
  const colouredTail = last && width > 0 && line.getCell(width - 1, cell)?.isBgDefault() === false;
  let out = "";
  let current = DEFAULT_SGR;
  let consumed = 0;
  for (let x = 0; x < width && (colouredTail || consumed < text.length); x++) {
    const c = line.getCell(x, cell);
    if (!c) break;
    if (c.getWidth() === 0) continue; // second half of a wide character
    const chars = c.getChars() || " ";
    consumed += chars.length;
    const sgr = c.isAttributeDefault() ? DEFAULT_SGR : cellSgr(c);
    if (sgr !== current) {
      out += sgr;
      current = sgr;
    }
    out += chars;
  }
  return current === DEFAULT_SGR ? out : `${out}${DEFAULT_SGR}`;
}

type NormalBuffer = IBufferNamespace["normal"];
interface Resume { readonly row: number; readonly gap: boolean; readonly cleared: boolean; readonly restart: boolean }

function lastRowOf(normal: NormalBuffer, row: number): number {
  let end = row;
  while (end + 1 < normal.length && normal.getLine(end + 1)?.isWrapped) end++;
  return end;
}

/** The xterm.js implementation of {@link HistorySource}. */
export function xtermHistorySource(terminal: Terminal): HistorySource {
  // Where the next read resumes. `after`: the first row of the last logical line read, so the
  // marker sits in the scrollback where erasing or deleting rows on screen (clear, Ctrl-L, DL)
  // cannot remove it, and widening never removes a logical line's first row. `at`: nothing has
  // been read since the start, a reset or a gap; resume at the marker's row.
  let anchor: { marker: IMarker; after: boolean } | undefined;
  let readSinceRestart = false;
  // Inside a hole: rows were lost and nothing has been read since. Further losses (a logical line
  // longer than the scrollback keeps losing its start until it ends) extend the same hole.
  let inGap = false;
  let started = false;
  let resetSeen = false;
  let erasedSeen = false;
  let disposed = false;
  const normalActive = () => terminal.buffer.active.type === "normal";
  const eraseObserver = (params: (number | number[])[]) => {
    // The alternate screen has no scrollback; ED 3 there erases nothing.
    if (params[0] === 3 && normalActive()) erasedSeen = true;
    return false;
  };
  const hooks: IDisposable[] = [
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      resetSeen = true;
      return false;
    }),
    terminal.parser.registerCsiHandler({ final: "J" }, eraseObserver),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "J" }, eraseObserver),
  ];

  const dropAnchor = () => {
    anchor?.marker.dispose();
    anchor = undefined;
  };
  const placeAnchor = (normal: NormalBuffer, row: number, after: boolean) => {
    dropAnchor();
    // Markers are placed relative to the cursor of the active (here: normal) buffer.
    anchor = { marker: terminal.registerMarker(row - (normal.baseY + normal.cursorY)), after };
  };

  /** First row to read; `restart` means every row from there on is unread again. */
  function resume(normal: NormalBuffer): Resume {
    if (resetSeen) {
      // RIS replaced the buffers; the old marker still looks alive but points into the old one.
      dropAnchor();
      return { row: 0, gap: false, cleared: true, restart: true };
    }
    if (anchor && !anchor.marker.isDisposed) {
      const row = anchor.after ? lastRowOf(normal, anchor.marker.line) + 1 : anchor.marker.line;
      return { row, gap: false, cleared: false, restart: false };
    }
    const lost = started;
    dropAnchor();
    if (!lost) return { row: 0, gap: false, cleared: false, restart: true };
    if (erasedSeen) return { row: 0, gap: false, cleared: true, restart: true };
    // Trimming only happens at capacity; the rows after the marker may be gone as well.
    const full = normal.length >= terminal.rows + (terminal.options.scrollback ?? 0);
    if (full) return { row: 0, gap: !inGap, cleared: false, restart: true };
    // Not trimmed, so it was erased on screen. With nothing read since the last restart every
    // row is still unread; otherwise the screen grew over read rows and the position is unknown:
    // resume at the screen top and report the rows that may be missing.
    if (!readSinceRestart) return { row: 0, gap: false, cleared: false, restart: true };
    return { row: normal.baseY, gap: true, cleared: false, restart: false };
  }

  function read(): ScrolledOff {
    if (disposed || !normalActive()) return NOTHING;
    const normal = terminal.buffer.normal;
    const { gap, cleared, restart, row: first } = resume(normal);
    if (restart) readSinceRestart = false;
    if (gap) inGap = true;
    else if (cleared) inGap = false;
    started = true;
    resetSeen = false;
    erasedSeen = false;
    let row = first;
    const lines: string[] = [];
    const cell = normal.getNullCell();
    let lastStart = -1;
    while (row < normal.baseY) {
      const end = lastRowOf(normal, row);
      // Complete only if every row is off screen and the next row starts a new line.
      if (end >= normal.baseY || end + 1 >= normal.length) break;
      let text = "";
      for (let r = row; r <= end; r++) text += encodeRow(normal.getLine(r)!, r === end, cell);
      lines.push(text);
      lastStart = row;
      row = end + 1;
    }
    if (lastStart >= 0) {
      placeAnchor(normal, lastStart, true);
      readSinceRestart = true;
      inGap = false;
    } else if (!anchor) {
      placeAnchor(normal, row, false);
    }
    return lines.length || gap || cleared ? { lines, gap, cleared } : NOTHING;
  }

  return {
    read,
    dispose() {
      if (disposed) return;
      disposed = true;
      dropAnchor();
      for (const hook of hooks) hook.dispose();
    },
  };
}
