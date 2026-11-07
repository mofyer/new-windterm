/**
 * Text and SGR colour runs of one archived line, for the read-only history view (P1 slice 5,
 * step 7). The archive stores each logical line as printed characters with SGR sequences
 * (`terminal-core.ts` `encodeRow`); this splits it into plain text and style runs. Nothing here
 * touches the DOM except {@link paintRun}, which only sets classes and colour properties built from
 * numbers: terminal text is never parsed as markup and reaches the DOM only as `textContent`.
 */

/** Palette index 0–255, or an RGB colour with {@link RGB} set. */
export type Color = number;
/** Flag of an RGB {@link Color}: `RGB | r << 16 | g << 8 | b`. */
export const RGB = 0x1000000;

export interface RunStyle {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
  readonly invisible: boolean;
  readonly strike: boolean;
  readonly overline: boolean;
  readonly fg?: Color;
  readonly bg?: Color;
}

/** `[start, end)` of the plain text drawn with `style`; undefined is the default style. */
export interface StyledRun {
  readonly start: number;
  readonly end: number;
  readonly style: RunStyle | undefined;
}

export interface ParsedLine {
  /** The line without SGR sequences: what search matches and copy returns. */
  readonly text: string;
  /** Non-empty runs covering `text` in order (none for a default-style line). */
  readonly runs: readonly StyledRun[];
}

const SGR = /\x1b\[([0-9;:]*)m/g;
const PLAIN: RunStyle = Object.freeze({
  bold: false, dim: false, italic: false, underline: false, inverse: false, invisible: false, strike: false, overline: false,
});

function isPlain(style: RunStyle): boolean {
  return !style.bold && !style.dim && !style.italic && !style.underline && !style.inverse && !style.invisible
    && !style.strike && !style.overline && style.fg === undefined && style.bg === undefined;
}

/** Extended colour at `params[i]` (`38;5;n` or `38;2;r;g;b`); returns the colour and the next index. */
function extended(params: number[], i: number): [Color | undefined, number] {
  const byte = (n: number | undefined) => Math.min(255, Math.max(0, n ?? 0));
  if (params[i + 1] === 5) return [byte(params[i + 2]), i + 3];
  if (params[i + 1] === 2) return [RGB | (byte(params[i + 2]) << 16) | (byte(params[i + 3]) << 8) | byte(params[i + 4]), i + 5];
  return [undefined, i + 1];
}

/** Applies one SGR parameter list to `style`. */
function apply(style: RunStyle, list: string): RunStyle {
  const params = list === "" ? [0] : list.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  let next: { -readonly [K in keyof RunStyle]: RunStyle[K] } = { ...style };
  for (let i = 0; i < params.length;) {
    const p = params[i];
    if (p === 38 || p === 48) {
      const [color, after] = extended(params, i);
      if (p === 38) next.fg = color;
      else next.bg = color;
      i = after;
      continue;
    }
    if (p === 0) next = { ...PLAIN };
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 8) next.invisible = true;
    else if (p === 9) next.strike = true;
    else if (p === 53) next.overline = true;
    else if (p >= 30 && p <= 37) next.fg = p - 30;
    else if (p >= 40 && p <= 47) next.bg = p - 40;
    else if (p >= 90 && p <= 97) next.fg = p - 90 + 8;
    else if (p >= 100 && p <= 107) next.bg = p - 100 + 8;
    else if (p === 39) next.fg = undefined;
    else if (p === 49) next.bg = undefined;
    i++;
  }
  return Object.freeze(next);
}

/** Splits an archived line into plain text and style runs. */
export function parseLine(line: string): ParsedLine {
  if (!line.includes("\x1b")) return { text: line, runs: [] };
  let text = "";
  let style = PLAIN;
  const runs: StyledRun[] = [];
  let from = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const start = text.length;
    text += chunk;
    if (!isPlain(style)) runs.push({ start, end: text.length, style });
  };
  for (const match of line.matchAll(SGR)) {
    push(line.slice(from, match.index));
    style = apply(style, match[1]);
    from = match.index! + match[0].length;
  }
  push(line.slice(from));
  return { text, runs };
}

/** Plain text of an archived line. */
export function plainText(line: string): string {
  return line.includes("\x1b") ? line.replace(SGR, "") : line;
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** CSS colour of a palette index or RGB value; 0–15 follow the terminal theme (custom properties). */
export function cssColor(color: Color): string {
  if (color >= RGB) return `rgb(${(color >> 16) & 255} ${(color >> 8) & 255} ${color & 255})`;
  if (color < 16) return `var(--history-ansi-${color})`;
  if (color < 232) {
    const n = color - 16;
    return `rgb(${CUBE[Math.floor(n / 36)]} ${CUBE[Math.floor(n / 6) % 6]} ${CUBE[n % 6]})`;
  }
  const grey = 8 + (color - 232) * 10;
  return `rgb(${grey} ${grey} ${grey})`;
}

/**
 * Styles one span of a history row like the terminal draws it: bold text in palette colours 0–7
 * uses the bright colour (xterm.js `drawBoldTextInBrightColors`, on by default), inverse swaps the
 * colours, invisible text is transparent. Only classes and colour properties are set.
 */
export function paintRun(span: HTMLElement, style: RunStyle): void {
  const fgIndex = style.bold && style.fg !== undefined && style.fg < 8 ? style.fg + 8 : style.fg;
  const fg = fgIndex === undefined ? undefined : cssColor(fgIndex);
  const bg = style.bg === undefined ? undefined : cssColor(style.bg);
  const [color, background] = style.inverse ? [bg ?? "var(--history-bg)", fg ?? "var(--history-fg)"] : [fg, bg];
  if (color) span.style.color = color;
  if (background) span.style.backgroundColor = background;
  if (style.invisible) span.style.color = "transparent";
  const lines = [style.underline && "underline", style.strike && "line-through", style.overline && "overline"].filter(Boolean);
  if (lines.length) span.style.textDecorationLine = lines.join(" ");
  if (style.bold) span.classList.add("sgr-bold");
  if (style.dim) span.classList.add("sgr-dim");
  if (style.italic) span.classList.add("sgr-italic");
}

/** Where a match lies in the drawn text, and whether it is the current one. */
export interface MatchRange {
  readonly start: number;
  readonly end: number;
  readonly current: boolean;
}

export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly style: RunStyle | undefined;
  /** 0: no match; 1: a match; 2: the current match. */
  readonly match: 0 | 1 | 2;
}

/**
 * Cuts `[from, to)` of a parsed line at style and match boundaries. Matches must be sorted by
 * `start` and must not overlap.
 */
export function segments(line: ParsedLine, from: number, to: number, matches: readonly MatchRange[]): Segment[] {
  const cuts = new Set<number>([from, to]);
  for (const run of line.runs) cuts.add(run.start).add(run.end);
  for (const m of matches) cuts.add(m.start).add(m.end);
  const points = [...cuts].filter((p) => p >= from && p <= to).sort((a, b) => a - b);
  const result: Segment[] = [];
  let run = 0;
  let hit = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i];
    const end = points[i + 1];
    while (run < line.runs.length && line.runs[run].end <= start) run++;
    while (hit < matches.length && matches[hit].end <= start) hit++;
    const style = run < line.runs.length && line.runs[run].start <= start ? line.runs[run].style : undefined;
    const m = hit < matches.length && matches[hit].start <= start ? matches[hit] : undefined;
    result.push({ start, end, style, match: m ? (m.current ? 2 : 1) : 0 });
  }
  return result;
}
