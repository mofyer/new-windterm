/**
 * Shadow of the SGR rendition that xterm.js 6.0.0 keeps privately, so DECRQSS
 * `DCS $ q m ST` can be answered (the built-in reply is always `0m`).
 *
 * It mirrors InputHandler.charAttributes as observed in xterm.js 6.0.0,
 * including its colour-parameter normalisation, and DECSC/DECRC saving only the
 * fg/bg words (underline style and colour are not saved). Known approximation:
 * OSC 8 hyperlinks also toggle xterm's private "extended attributes" bit; the
 * shadow ignores links, so a report always describes the SGR state only.
 */

/** Public xterm parser parameters: a number, optionally followed by an array of its subparameters. */
export type CsiParams = readonly (number | readonly number[])[];
export interface Param {
  readonly value: number;
  readonly subs: readonly number[];
}

export type Color =
  | { readonly mode: "default" }
  | { readonly mode: "p16" | "p256"; readonly index: number }
  | { readonly mode: "rgb"; readonly rgb: number };

/** The part of the rendition that DECSC/DECRC save and restore. */
export interface SavedSgr {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  readonly inverse: boolean;
  readonly invisible: boolean;
  readonly strike: boolean;
  readonly overline: boolean;
  /** xterm's HAS_EXTENDED flag: underline style/colour only apply while it is set. */
  readonly extended: boolean;
  readonly fg: Color;
  readonly bg: Color;
}
export interface SgrState extends SavedSgr {
  readonly underlineStyle: number;
  readonly underlineColor: Color;
}

const DEFAULT_COLOR: Color = Object.freeze({ mode: "default" });
export const DEFAULT_SGR: SgrState = Object.freeze({
  bold: false, dim: false, italic: false, underline: false, blink: false, inverse: false,
  invisible: false, strike: false, overline: false, extended: false,
  fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, underlineStyle: 0, underlineColor: DEFAULT_COLOR,
});
const MAX_UNDERLINE_STYLE = 5;

const NO_SUBS: readonly number[] = Object.freeze([]);

/** Pair each parameter with the subparameter array xterm emits right after it. */
export function normalizeParams(raw: CsiParams): Param[] {
  const out: Param[] = [];
  for (const item of raw) {
    if (typeof item === "number") out.push({ value: item, subs: NO_SUBS });
    else if (Array.isArray(item) && out.length) out[out.length - 1] = { value: out[out.length - 1].value, subs: item };
  }
  return out;
}

/** Working copy for one SGR sequence; the caller's state object is never mutated. */
type Draft = { -readonly [K in keyof SgrState]: SgrState[K] };

// Shared, frozen palette colours: SGR is on the parser's hot path, so avoid allocating them.
const PALETTE16: readonly Color[] = Array.from({ length: 16 }, (_, index) => Object.freeze({ mode: "p16" as const, index }));
const PALETTE256: readonly Color[] = Array.from({ length: 256 }, (_, index) => Object.freeze({ mode: "p256" as const, index }));

/** xterm treats -1 (empty subparameter) and styles above 5 as a single underline. */
function setUnderline(draft: Draft, requested: number): void {
  const style = requested === -1 || requested > MAX_UNDERLINE_STYLE ? 1 : requested;
  draft.underlineStyle = style;
  draft.underline = style !== 0;
  draft.extended = style !== 0;
}

function colorFrom(previous: Color, mode: number, c1: number, c2: number, c3: number): Color {
  if (mode === 2) return { mode: "rgb", rgb: ((c1 & 255) << 16) | ((c2 & 255) << 8) | (c3 & 255) };
  if (mode === 5) return PALETTE256[c1 & 255];
  return previous;
}

/**
 * Port of xterm.js's colour extraction for SGR 38/48/58 (semicolon and colon
 * forms, with or without a colour-space id). Returns the extra parameters consumed.
 */
function applyColor(draft: Draft, params: readonly Param[], pos: number): number {
  const accu = [0, 0, -1, 0, 0, 0];
  let colorSpace = 0;
  let advance = 0;
  do {
    const param = params[pos + advance];
    accu[advance + colorSpace] = param.value;
    if (param.subs.length) {
      let i = 0;
      do {
        if (accu[1] === 5) colorSpace = 1;
        accu[advance + i + 1 + colorSpace] = param.subs[i];
      } while (++i < param.subs.length && i + advance + 1 + colorSpace < accu.length);
      break;
    }
    if ((accu[1] === 5 && advance + colorSpace >= 2) || (accu[1] === 2 && advance + colorSpace >= 5)) break;
    if (accu[1]) colorSpace = 1;
  } while (++advance + pos < params.length && advance + colorSpace < accu.length);
  for (let i = 2; i < accu.length; ++i) if (accu[i] === -1) accu[i] = 0;
  const [target, mode, , c1, c2, c3] = accu;
  if (target === 38) draft.fg = colorFrom(draft.fg, mode, c1, c2, c3);
  else if (target === 48) draft.bg = colorFrom(draft.bg, mode, c1, c2, c3);
  else draft.underlineColor = colorFrom(draft.underlineColor, mode, c1, c2, c3);
  return advance;
}

function applyOne(draft: Draft, param: Param): void {
  const p = param.value;
  if (p >= 30 && p <= 37) draft.fg = PALETTE16[p - 30];
  else if (p >= 40 && p <= 47) draft.bg = PALETTE16[p - 40];
  else if (p >= 90 && p <= 97) draft.fg = PALETTE16[p - 90 + 8];
  else if (p >= 100 && p <= 107) draft.bg = PALETTE16[p - 100 + 8];
  else {
    switch (p) {
      case 0: Object.assign(draft, DEFAULT_SGR); break;
      case 1: draft.bold = true; break;
      case 2: draft.dim = true; break;
      case 3: draft.italic = true; break;
      case 4: setUnderline(draft, param.subs.length ? param.subs[0] : 1); break;
      case 5: draft.blink = true; break;
      case 7: draft.inverse = true; break;
      case 8: draft.invisible = true; break;
      case 9: draft.strike = true; break;
      case 21: setUnderline(draft, 2); break;
      case 22: draft.bold = false; draft.dim = false; break;
      case 23: draft.italic = false; break;
      case 24: setUnderline(draft, 0); break;
      case 25: draft.blink = false; break;
      case 27: draft.inverse = false; break;
      case 28: draft.invisible = false; break;
      case 29: draft.strike = false; break;
      case 39: draft.fg = DEFAULT_COLOR; break;
      case 49: draft.bg = DEFAULT_COLOR; break;
      case 53: draft.overline = true; break;
      case 55: draft.overline = false; break;
      case 59: draft.underlineColor = DEFAULT_COLOR; draft.extended = draft.underlineStyle !== 0; break;
      default: break; // 6 (rapid blink) and unknown values are ignored, as in xterm.js
    }
  }
}

/** Apply one SGR sequence (`CSI Pm m`) to the shadow state; returns a new state object. */
export function applySgr(state: SgrState, raw: CsiParams): SgrState {
  // `CSI m` / `CSI 0 m` is the most frequent SGR: no allocation at all.
  if (raw.length === 0 || (raw.length === 1 && raw[0] === 0)) return DEFAULT_SGR;
  const params = normalizeParams(raw);
  const draft: Draft = { ...state };
  for (let i = 0; i < params.length; i++) {
    const p = params[i].value;
    if (p === 38 || p === 48 || p === 58) i += applyColor(draft, params, i);
    else applyOne(draft, params[i]);
  }
  return draft;
}

/** DECSC/SCOSC keep xterm's fg/bg words only; underline style and colour stay current on restore. */
export function saveSgr(state: SgrState): SavedSgr {
  return {
    bold: state.bold, dim: state.dim, italic: state.italic, underline: state.underline, blink: state.blink,
    inverse: state.inverse, invisible: state.invisible, strike: state.strike, overline: state.overline,
    extended: state.extended, fg: state.fg, bg: state.bg,
  };
}

export function restoreSgr(state: SgrState, saved: SavedSgr): SgrState {
  return { ...state, ...saved };
}

function extendedColor(color: Color, introducer: number): string[] {
  if (color.mode === "p256") return [`${introducer};5;${color.index}`];
  if (color.mode === "rgb") return [`${introducer};2;${(color.rgb >> 16) & 255};${(color.rgb >> 8) & 255};${color.rgb & 255}`];
  return [];
}

function colorReport(color: Color, base: number, bright: number, introducer: number): string[] {
  if (color.mode === "p16") return [String(color.index < 8 ? base + color.index : bright + color.index - 8)];
  return extendedColor(color, introducer);
}

/** DECRPSS body for SGR, e.g. "0;1;31": always starts with 0 like xterm, 7-bit only. */
export function reportSgr(state: SgrState): string {
  // Same rule as xterm's getUnderlineStyle(): the extended style applies only while the flag is set,
  // so a DECRC that restores the flag over a cleared style draws (and reports) no underline.
  const style = !state.underline ? 0 : state.extended ? state.underlineStyle : 1;
  const underline = style === 2 ? "21" : style >= 3 ? `4:${style}` : "4";
  const parts = [
    "0",
    ...(state.bold ? ["1"] : []), ...(state.dim ? ["2"] : []), ...(state.italic ? ["3"] : []),
    ...(style !== 0 ? [underline] : []), ...(state.blink ? ["5"] : []), ...(state.inverse ? ["7"] : []),
    ...(state.invisible ? ["8"] : []), ...(state.strike ? ["9"] : []), ...(state.overline ? ["53"] : []),
    ...colorReport(state.fg, 30, 90, 38), ...colorReport(state.bg, 40, 100, 48),
    // xterm.js only draws the underline colour while the extended flag is set.
    ...(state.extended ? extendedColor(state.underlineColor, 58) : []),
  ];
  return parts.join(";");
}
