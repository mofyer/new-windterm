/**
 * Messages between the history view's regex search (history-regex.ts, main thread) and its
 * dedicated worker (history-regex-worker.ts). Types only: nothing here runs, so importing it does
 * not bring the worker's matching code into the main bundle.
 *
 * The main thread sends the pattern once per search, then batches of plain text (SGR already
 * removed; no colours, line numbers or other data). One request is in flight at a time, and every
 * reply names the search (and batch) it answers.
 */

export type RegexRequest =
  /** Compile `source` for search `search`; flags are fixed by the worker (`gu`, plus `i` without `caseSensitive`). */
  | { readonly kind: "compile"; readonly search: number; readonly source: string; readonly caseSensitive: boolean }
  /** Match the compiled pattern against `lines`; return at most `limit` matches, newest first. */
  | { readonly kind: "match"; readonly search: number; readonly batch: number; readonly lines: readonly string[]; readonly limit: number };

export type RegexReply =
  | { readonly kind: "compiled"; readonly search: number }
  /** The pattern does not compile. The engine's message is not passed on. */
  | { readonly kind: "invalid"; readonly search: number }
  /**
   * `hits` is flat `[index, start, end, …]`: line `index` of the batch, UTF-16 `[start, end)` of its
   * text. Ordered newest first: from the last line of the batch to the first, each line right to left.
   */
  | { readonly kind: "matched"; readonly search: number; readonly batch: number; readonly hits: readonly number[] }
  /** Matching threw (for example the engine ran out of stack); the search stops. */
  | { readonly kind: "failed"; readonly search: number; readonly batch: number };
