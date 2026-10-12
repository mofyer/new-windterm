/**
 * Terminal identities answered by the VT adapters (see vt-adapters.ts).
 *
 * Every reply is 7-bit: S8C1T / 8-bit C1 controls are not supported, so the
 * DECSCL "8-bit controls" parameter is ignored and only the level changes.
 * Feature lists name only what this terminal actually does today; they never
 * claim 132 columns (DECCOLM is off), printer ports, UDKs, rectangular editing
 * or SIXEL. This only changes replies: TERM, the SSH pty-req and Telnet TTYPE
 * still say xterm-256color. See docs/p0/VT_MATRIX.zh-CN.md.
 */
export type TerminalType = "xterm-256color" | "vt100" | "vt220" | "vt420" | "vt520";

export const TERMINAL_TYPES: readonly TerminalType[] = ["xterm-256color", "vt100", "vt220", "vt420", "vt520"];
export const DEFAULT_TERMINAL_TYPE: TerminalType = "xterm-256color";

/** XTVERSION name and version; vt-adapters.spec.ts keeps the version in step with package.json. */
export const EMULATOR_NAME = "new-windterm";
export const EMULATOR_VERSION = "0.0.1";

/** DECSCL operating levels: 61 = VT100 … 65 = VT500. */
export const MIN_CONFORMANCE_LEVEL = 61;

export interface TerminalProfile {
  readonly type: TerminalType;
  /** DA1 reply after CSI, e.g. "?1;2c". */
  readonly primary: string;
  /** DA2 reply after CSI, or null when the real terminal ignores DA2. */
  readonly secondary: string | null;
  /** Whether DA3 (DECRPTUI) is answered (VT400 and up); the unit ID is always zero. */
  readonly tertiary: boolean;
  /** Whether XTVERSION (an xterm extension) is answered. */
  readonly xtversion: boolean;
  /**
   * Highest DECSCL level, which is also the level after reset. A VT100-class
   * identity (level 61) cannot be raised, as in xterm with decTerminalID < 200.
   */
  readonly level: number;
}

// VT220+ features actually provided: 6 selective erase, 9 NRCS (tables only,
// DECNRCM is not implemented), 22 ANSI colour — the list xterm uses minus the
// features this terminal lacks.
const VT_FEATURES = "6;9;22";
// DEC firmware version field; no hardware reference was measured, 10 = "1.0".
const FIRMWARE = 10;

const PROFILES: Readonly<Record<TerminalType, TerminalProfile>> = {
  // DA1/DA2 and the DECSCL report are byte-identical to xterm.js 6.0.0's built-ins.
  // DA3 stays unanswered as before (a VT100-class identity has no unit ID);
  // XTVERSION is answered because this type claims to be an xterm.
  "xterm-256color": { type: "xterm-256color", primary: "?1;2c", secondary: ">0;276;0c", tertiary: false, xtversion: true, level: 61 },
  vt100: { type: "vt100", primary: "?1;2c", secondary: null, tertiary: false, xtversion: false, level: 61 },
  vt220: { type: "vt220", primary: `?62;${VT_FEATURES}c`, secondary: `>1;${FIRMWARE};0c`, tertiary: false, xtversion: false, level: 62 },
  vt420: { type: "vt420", primary: `?64;${VT_FEATURES}c`, secondary: `>41;${FIRMWARE};0c`, tertiary: true, xtversion: false, level: 64 },
  vt520: { type: "vt520", primary: `?65;${VT_FEATURES}c`, secondary: `>64;${FIRMWARE};0c`, tertiary: true, xtversion: false, level: 65 },
};

export function isTerminalType(value: unknown): value is TerminalType {
  return typeof value === "string" && (TERMINAL_TYPES as readonly string[]).includes(value);
}

/** Unknown values fall back to the default instead of trusting the caller. */
export function terminalProfile(type: unknown): TerminalProfile {
  return PROFILES[isTerminalType(type) ? type : DEFAULT_TERMINAL_TYPE];
}
