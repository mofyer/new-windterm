import type { RegexReply, RegexRequest } from "./history-regex-protocol";

/**
 * Dedicated worker of the history view's regular-expression search (history-regex.ts). It is the
 * only place a user's pattern is compiled or run: the main thread sends the plain text of a batch
 * of lines and gets back where the pattern matched. A pattern that backtracks without end blocks
 * this worker only, and the main thread terminates it once a batch takes longer than
 * HISTORY_REGEX_BATCH_TIMEOUT_MS.
 *
 * Flags are fixed: `g` and `u` always, `i` when the search ignores case. The user types the pattern
 * only (a `/…/flags` form is not parsed: its slashes are part of the pattern), so `v`, `s`, `m`, `y`
 * and `d` are never set. With `u` the syntax is the strict Unicode one, `.` and classes take whole
 * code points (a match never splits a surrogate pair) and ignoring case uses Unicode simple case
 * folding, as the plain-text search does. Each line is matched on its own, so `^` and `$` are the
 * line's start and end. Lookbehind, named groups and back references are passed to the engine as
 * they are; an engine without lookbehind (WebKit before Safari 16.4) reports the pattern invalid.
 *
 * A match of zero length (`^`, `a*` where there is no `a`) is not reported: it cannot be
 * highlighted. Matches do not overlap, as with `String.prototype.matchAll`.
 */

interface WorkerScope {
  onmessage: ((event: MessageEvent<RegexRequest>) => void) | null;
  postMessage(message: RegexReply): void;
}

const scope = self as unknown as WorkerScope;
let compiled: { readonly search: number; readonly pattern: RegExp } | undefined;

/** Index after the code point at `index`, so a zero-length match never stops the walk or splits a pair. */
function nextIndex(text: string, index: number): number {
  const code = text.charCodeAt(index);
  const pair = code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
  return index + (pair ? 2 : 1);
}

/** `[start, end, …]` of the last `room` non-empty matches in `text`, left to right. */
function lineMatches(pattern: RegExp, text: string, room: number): number[] {
  const found: number[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const end = m.index + m[0].length;
    if (end > m.index) found.push(m.index, end);
    else pattern.lastIndex = nextIndex(text, m.index);
    // Only the newest (rightmost) matches can be kept; drop older ones in bulk.
    if (found.length >= 4 * room) found.splice(0, found.length - 2 * room);
  }
  if (found.length > 2 * room) found.splice(0, found.length - 2 * room);
  return found;
}

/** Matches of a batch, newest first (last line first, each line right to left), at most `limit`. */
function matchLines(pattern: RegExp, lines: readonly string[], limit: number): number[] {
  const hits: number[] = [];
  for (let index = lines.length - 1; index >= 0 && hits.length < 3 * limit; index--) {
    const found = lineMatches(pattern, lines[index], limit - hits.length / 3);
    for (let k = found.length - 2; k >= 0; k -= 2) hits.push(index, found[k], found[k + 1]);
  }
  return hits;
}

scope.onmessage = ({ data }) => {
  if (data.kind === "compile") {
    try {
      if (typeof data.source !== "string") throw new TypeError("pattern");
      compiled = { search: data.search, pattern: new RegExp(data.source, data.caseSensitive ? "gu" : "giu") };
      scope.postMessage({ kind: "compiled", search: data.search });
    } catch {
      compiled = undefined;
      scope.postMessage({ kind: "invalid", search: data.search });
    }
    return;
  }
  if (data.kind !== "match") return;
  const { search, batch } = data;
  try {
    if (!compiled || compiled.search !== search || !Array.isArray(data.lines)) throw new TypeError("request");
    const limit = Math.max(0, Math.floor(data.limit));
    scope.postMessage({ kind: "matched", search, batch, hits: matchLines(compiled.pattern, data.lines, limit) });
  } catch {
    scope.postMessage({ kind: "failed", search, batch });
  }
};
