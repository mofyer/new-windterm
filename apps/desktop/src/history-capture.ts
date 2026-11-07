import type { Terminal } from "@xterm/xterm";
import { HistoryArchive, type CaptureResult } from "./terminal-compat/history-archive";
import { xtermHistorySource } from "./terminal-core";
import {
  ARCHIVE_BLOCK_LINES, HISTORY_TARGET_LINES, MAX_SESSION_ARCHIVE_BYTES, MAX_TOTAL_ARCHIVE_BYTES,
} from "./history-budget";
import { responsivenessDiagnostics as diagnostics } from "./responsiveness";

/**
 * Cold-history capture of one native workspace session (P1 slice 5, step 5): capture only.
 * There is no history view and no user-visible notice, and the budgets in `history-budget.ts`
 * are only counted, in development diagnostics; nothing is trimmed. The archive is derived from
 * the session's xterm through the terminal-core boundary and lives until the tab is closed
 * (an exited tab keeps it); `dispose` releases it with the tab.
 */
export interface SessionHistory {
  /** Archives what the last write scrolled off. Call from the xterm write callback; never throws. */
  capture(): void;
  /** Releases the archive and its terminal hooks; idempotent. */
  dispose(): void;
}

/** Per-session figures already added to the aggregate diagnostics. */
interface Reported {
  bytes: number;
  uncompressedBlocks: number;
  overBudget: boolean;
}

/** Development diagnostics only: aggregate numbers, never history text, paths or session IDs. */
function report(archive: HistoryArchive, result: CaptureResult, started: number, reported: Reported) {
  const d = diagnostics!;
  const ms = performance.now() - started;
  d.historyCaptureMs += ms;
  d.historyMaxCaptureMs = Math.max(d.historyMaxCaptureMs, ms);
  d.historyArchivedLines += result.lines;
  if (result.gap) d.historyGaps++;
  if (result.cleared) d.historyClears++;
  const stats = archive.stats();
  const before = d.historyCompressedBytes;
  d.historyCompressedBytes += stats.compressedBytes - reported.bytes;
  reported.bytes = stats.compressedBytes;
  if (before <= MAX_TOTAL_ARCHIVE_BYTES && d.historyCompressedBytes > MAX_TOTAL_ARCHIVE_BYTES) d.historyTotalBudgetExceeded++;
  d.historyMaxSessionCompressedBytes = Math.max(d.historyMaxSessionCompressedBytes, stats.compressedBytes);
  const over = stats.compressedBytes > MAX_SESSION_ARCHIVE_BYTES || stats.archivedLines > HISTORY_TARGET_LINES;
  if (over && !reported.overBudget) d.historySessionBudgetExceeded++;
  reported.overBudget = over;
  d.historyUncompressedBlocks += stats.uncompressedBlocks - reported.uncompressedBlocks;
  reported.uncompressedBlocks = stats.uncompressedBlocks;
}

export function createSessionHistory(terminal: Terminal): SessionHistory {
  let archive: HistoryArchive | undefined = new HistoryArchive(xtermHistorySource(terminal), ARCHIVE_BLOCK_LINES);
  const reported: Reported | undefined = diagnostics ? { bytes: 0, uncompressedBlocks: 0, overBudget: false } : undefined;
  if (diagnostics) diagnostics.historyArchives++;
  const release = () => {
    archive?.dispose();
    archive = undefined;
    if (diagnostics) {
      diagnostics.historyArchives--;
      diagnostics.historyCompressedBytes -= reported!.bytes;
    }
  };
  return {
    capture() {
      if (!archive) return;
      const started = diagnostics ? performance.now() : 0;
      try {
        const result = archive.capture();
        if (diagnostics) report(archive, result, started, reported!);
      } catch {
        // Never let capture reach xterm's write loop or the ACK path. Stop archiving this
        // session instead of keeping a history with a hole of unknown size.
        release();
        if (diagnostics) diagnostics.historyCaptureErrors++;
      }
    },
    dispose() {
      if (archive) release();
    },
  };
}
