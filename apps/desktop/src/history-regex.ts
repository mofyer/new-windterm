import { plainText } from "./history-sgr";
import {
  ARCHIVE_BLOCK_LINES, HISTORY_REGEX_BATCH_CHARS, HISTORY_REGEX_BATCH_TIMEOUT_MS, HISTORY_REGEX_START_TIMEOUT_MS,
} from "./history-budget";
import type { RegexReply, RegexRequest } from "./history-regex-protocol";
import type { SearchFailure, SearchMatch, SearchOptions, SearchOutcome, SearchQuery, SearchSource } from "./history-search";

/**
 * Regular-expression search of one session's history (G20; user decision 2026-11-07, second set,
 * item 12). The main thread never compiles or runs the user's pattern: it walks the same lines as
 * the plain-text search (history-search.ts), newest first, removes SGR, and sends the plain text
 * in batches to a dedicated worker (history-regex-worker.ts), which returns where the pattern
 * matched. Matches are kept, limited and ordered exactly as in the plain-text search.
 *
 * Each request waits at most a fixed time (HISTORY_REGEX_BATCH_TIMEOUT_MS per batch,
 * HISTORY_REGEX_START_TIMEOUT_MS to start and compile). Past it, and whenever the search's signal is
 * aborted while it runs (停止, a new query, refreshing, closing the view or the tab), the worker is
 * terminated at once, whatever its engine is doing; the next regex search starts a new one. A
 * search that ends normally leaves the worker idle for the next query, until the view closes.
 */

/** Ends a search early; `failure` undefined means cancelled by the signal. */
class Halt extends Error {
  constructor(readonly failure: SearchFailure | undefined) {
    super(failure ?? "cancelled");
  }
}

interface Waiting {
  readonly resolve: (reply: RegexReply) => void;
  readonly reject: (halt: Halt) => void;
  readonly timer: number;
}

/** The worker of one history view, created when a regex search needs it. */
export class RegexWorker {
  private worker: Worker | undefined;
  private waiting: Waiting | undefined;
  private searches = 0;
  private disposed = false;

  /** A new search number; replies to older searches are not accepted. */
  nextSearch(): number {
    return ++this.searches;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    // Bundled by Vite as a same-origin script (CSP `script-src 'self'` covers it as `worker-src`).
    const worker = new Worker(new URL("./history-regex-worker.ts", import.meta.url), { type: "module", name: "history-regex" });
    worker.onmessage = (event: MessageEvent<RegexReply>) => {
      if (this.worker === worker) this.settle(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker) this.halt("unavailable");
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.halt("failed");
    };
    this.worker = worker;
    return worker;
  }

  /**
   * Posts one request and resolves with its reply. Rejects with a Halt carrying `onTimeout` if no
   * reply comes within `timeout` ms; the worker is terminated then.
   */
  request(message: RegexRequest, timeout: number, onTimeout: SearchFailure): Promise<RegexReply> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Halt(undefined));
        return;
      }
      // One request at a time; a leftover one is cancelled with its worker.
      if (this.waiting) this.halt();
      let worker: Worker;
      try {
        worker = this.start();
      } catch {
        reject(new Halt("unavailable"));
        return;
      }
      this.waiting = { resolve, reject, timer: window.setTimeout(() => this.halt(onTimeout), timeout) };
      worker.postMessage(message);
    });
  }

  private settle(reply: RegexReply) {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    window.clearTimeout(waiting.timer);
    waiting.resolve(reply);
  }

  /**
   * Terminates the worker, if there is one, and rejects the request waiting on it with `failure`
   * (undefined: cancelled). The next request starts a new worker.
   */
  halt(failure?: SearchFailure): void {
    // Forgotten first, so its handlers ignore any event, whatever the order the engine delivers it in.
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
    const waiting = this.waiting;
    this.waiting = undefined;
    if (!waiting) return;
    window.clearTimeout(waiting.timer);
    waiting.reject(new Halt(failure));
  }

  /** Terminates the worker; no request is accepted afterwards. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.halt();
  }
}

/**
 * Checks a reply against the batch it answers (at most `room` matches, each a non-empty range of
 * its line) and converts its hits to matches, newest first.
 */
function hitsOf(
  reply: RegexReply, search: number, batch: number, first: number, lines: readonly string[], room: number,
): SearchMatch[] {
  if (reply.kind !== "matched" || reply.search !== search || reply.batch !== batch) throw new Halt("failed");
  const { hits } = reply;
  if (!Array.isArray(hits) || hits.length % 3 || hits.length > 3 * room) throw new Halt("failed");
  const matches: SearchMatch[] = [];
  for (let k = 0; k < hits.length; k += 3) {
    const index = hits[k];
    const start = hits[k + 1];
    const end = hits[k + 2];
    const valid = Number.isInteger(index) && index >= 0 && index < lines.length
      && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= lines[index].length;
    if (!valid) throw new Halt("failed");
    matches.push({ line: first + index, start, end });
  }
  return matches;
}

/** `[start, end)` batches of `lines`, last batch first: at most ARCHIVE_BLOCK_LINES lines and HISTORY_REGEX_BATCH_CHARS units. */
function batchesOf(lines: readonly string[]): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let end = lines.length;
  while (end > 0) {
    let start = end - 1;
    let chars = lines[start].length;
    while (start > 0 && end - start < ARCHIVE_BLOCK_LINES && chars + lines[start - 1].length <= HISTORY_REGEX_BATCH_CHARS) {
      chars += lines[--start].length;
    }
    result.push([start, end]);
    end = start;
  }
  return result;
}

export async function searchHistoryRegex(
  source: SearchSource, query: SearchQuery, options: SearchOptions, worker: RegexWorker,
): Promise<SearchOutcome> {
  const { limit, signal, progress } = options;
  const matches: SearchMatch[] = [];
  let scannedLines = 0;
  let limited = false;
  let failure: SearchFailure | undefined;
  const outcome = (complete: boolean): SearchOutcome => Object.freeze({
    matches, complete, limited, cancelled: signal.aborted && !limited && !complete && !failure, scannedLines, failure,
  });
  if (signal.aborted) return outcome(false);
  const search = worker.nextSearch();
  let batch = 0;
  // Every early end of a running search terminates the worker, even while it is matching.
  const onAbort = () => worker.halt();
  signal.addEventListener("abort", onAbort, { once: true });
  const visit = async (first: number, raw: readonly string[]): Promise<boolean> => {
    if (signal.aborted) return false;
    // Only the text goes to the worker: no SGR, colours or line numbers.
    const lines = raw.map(plainText);
    for (const [start, end] of batchesOf(lines)) {
      const text = lines.slice(start, end);
      const id = ++batch;
      const room = limit - matches.length;
      const reply = await worker.request(
        { kind: "match", search, batch: id, lines: text, limit: room }, HISTORY_REGEX_BATCH_TIMEOUT_MS, "timeout",
      );
      matches.push(...hitsOf(reply, search, id, first + start, text, room));
      scannedLines += end - start;
      progress?.(matches, scannedLines);
      if (matches.length >= limit) {
        limited = true;
        return false;
      }
      if (signal.aborted) return false;
    }
    return true;
  };
  try {
    const compiled = await worker.request(
      { kind: "compile", search, source: query.text, caseSensitive: query.caseSensitive }, HISTORY_REGEX_START_TIMEOUT_MS, "unavailable",
    );
    if (compiled.kind === "invalid" && compiled.search === search) {
      failure = "invalid";
      return outcome(false);
    }
    if (compiled.kind !== "compiled" || compiled.search !== search) throw new Halt("failed");
    if (source.tail.length && !(await visit(source.tailFirst, source.tail))) return outcome(false);
    if (!source.archive) return outcome(!signal.aborted);
    const reached = await source.archive.scanBackward(source.tailFirst, visit, signal);
    return outcome(reached && !signal.aborted && !limited);
  } catch (error) {
    if (!(error instanceof Halt)) throw error;
    // A worker that failed or answered out of turn is not reused.
    if (error.failure === "failed") worker.halt();
    failure = error.failure;
    return outcome(false);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
