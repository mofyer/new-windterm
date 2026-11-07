import { plainText } from "./history-sgr";

/**
 * Plain-text search of one session's history (G20) for the read-only history view (P1 slice 5,
 * step 7). The query is matched literally: it is escaped into a regular expression with no
 * quantifier, group or alternation, so matching takes time linear in the line length and no input
 * can cause catastrophic backtracking. A regular-expression query (`regex`) never runs here or
 * anywhere on the main thread: history-regex.ts sends it to a dedicated worker.
 *
 * A match never crosses a logical line (soft-wrapped terminal rows are already joined into one
 * line; a hard line break ends the line). Archive blocks hold whole lines, so block boundaries
 * never split a match. Positions are UTF-16 offsets into the line's plain text (SGR removed): a
 * wide or combined character is matched as the text it is, regardless of the cells it takes.
 *
 * The walk goes from the newest line to the oldest: the lines after the archive (the screen when
 * the view was opened), then the archive, one block at a time. It yields to the event loop at
 * least every {@link SLICE_MS} ms so terminal output, its ACKs and input keep flowing, and stops
 * when the signal is aborted or when `limit` matches are found; the newest matches are kept.
 */

export interface SearchQuery {
  readonly text: string;
  readonly caseSensitive: boolean;
  /** `text` is a regular expression, matched in a worker (history-regex.ts); otherwise literal. */
  readonly regex?: boolean;
}

/**
 * Why a regex search ended early: the pattern does not compile, a batch took longer than
 * HISTORY_REGEX_BATCH_TIMEOUT_MS, the worker could not start, or matching threw.
 */
export type SearchFailure = "invalid" | "timeout" | "unavailable" | "failed";

/** One match: `[start, end)` of line `line`'s plain text. */
export interface SearchMatch {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** What a search walks: the lines after the archive, then the archive before them. */
export interface SearchSource {
  /** Absolute number of `tail[0]`; the archive is searched before it. */
  readonly tailFirst: number;
  readonly tail: readonly string[];
  readonly archive?: {
    scanBackward(
      before: number, visit: (first: number, lines: readonly string[]) => boolean | Promise<boolean>, signal?: AbortSignal,
    ): Promise<boolean>;
  };
}

export interface SearchOutcome {
  /** Newest first: descending by line, then by start. */
  readonly matches: readonly SearchMatch[];
  /** Every held line was searched. */
  readonly complete: boolean;
  /** Stopped at the match limit. */
  readonly limited: boolean;
  /** Stopped by the signal. */
  readonly cancelled: boolean;
  readonly scannedLines: number;
  /** Regex search only: why it ended early, other than the signal or the limit. */
  readonly failure?: SearchFailure;
}

export interface SearchOptions {
  readonly limit: number;
  readonly signal: AbortSignal;
  /** Called with the matches so far (newest first; the same array grows) after each batch. */
  readonly progress?: (matches: readonly SearchMatch[], scannedLines: number) => void;
}

/** Longest stretch of synchronous search work before yielding to the event loop. */
export const SLICE_MS = 8;

/** Escapes every regular-expression syntax character, so the pattern only matches `text` itself. */
function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Finds every non-overlapping occurrence of the query in one plain-text line, left to right. */
export function literalMatcher(query: SearchQuery): (text: string) => Array<[number, number]> {
  const flags = query.caseSensitive ? "g" : "gi";
  let pattern: RegExp;
  try {
    // `u`: case folding and offsets by code point rules, so a surrogate pair is never split.
    pattern = new RegExp(literal(query.text), `${flags}u`);
  } catch {
    pattern = new RegExp(literal(query.text), flags);
  }
  return (text) => {
    const found: Array<[number, number]> = [];
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      found.push([m.index, m.index + m[0].length]);
      // A literal non-empty query never matches empty, but never loop forever either.
      if (m[0].length === 0) pattern.lastIndex++;
    }
    return found;
  };
}

/** A macrotask turn, without the 4 ms clamp of nested timers. */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export async function searchHistory(source: SearchSource, query: SearchQuery, options: SearchOptions): Promise<SearchOutcome> {
  const { limit, signal, progress } = options;
  const match = literalMatcher(query);
  const matches: SearchMatch[] = [];
  let scannedLines = 0;
  let limited = false;
  let sliceStart = performance.now();
  /** Scans one batch newest line first; false once the limit is reached. */
  const scan = (first: number, lines: readonly string[]): boolean => {
    for (let index = lines.length - 1; index >= 0; index--) {
      const found = match(plainText(lines[index]));
      scannedLines++;
      for (let k = found.length - 1; k >= 0; k--) {
        matches.push({ line: first + index, start: found[k][0], end: found[k][1] });
        if (matches.length >= limit) {
          limited = true;
          return false;
        }
      }
    }
    return true;
  };
  const visit = async (first: number, lines: readonly string[]): Promise<boolean> => {
    if (signal.aborted) return false;
    const more = scan(first, lines);
    progress?.(matches, scannedLines);
    if (more && performance.now() - sliceStart >= SLICE_MS) {
      await yieldTask();
      sliceStart = performance.now();
    }
    return more && !signal.aborted;
  };
  const outcome = (complete: boolean): SearchOutcome => Object.freeze({
    matches, complete, limited, cancelled: signal.aborted && !limited && !complete, scannedLines,
  });
  if (signal.aborted) return outcome(false);
  if (source.tail.length && !(await visit(source.tailFirst, source.tail))) return outcome(false);
  if (!source.archive) return outcome(!signal.aborted);
  const reached = await source.archive.scanBackward(source.tailFirst, visit, signal);
  return outcome(reached && !signal.aborted && !limited);
}
