/** Aggregate counters only: never retain terminal contents, input, paths or session IDs. */
function createDiagnostics() {
  const counters = {
    receivedChunks: 0,
    receivedBytes: 0,
    parsedChunks: 0,
    ackSubmitted: 0,
    ackCompleted: 0,
    inputEvents: 0,
    inputCalls: 0,
    pendingInputBytes: 0,
    maxPendingInputBytes: 0,
    maxInputWaitMs: 0,
    maxParseWaitMs: 0,
    maxAckQueueWaitMs: 0,
    statusFlushes: 0,
    // Cold history capture (history-capture.ts): counts, sizes and time only, never history text.
    historyArchives: 0,
    historyArchivedLines: 0,
    historyGaps: 0,
    historyClears: 0,
    historyCompressedBytes: 0,
    historyMaxSessionCompressedBytes: 0,
    historySessionBudgetExceeded: 0,
    historyTotalBudgetExceeded: 0,
    historyUncompressedBlocks: 0,
    historyCaptureErrors: 0,
    historyCaptureMs: 0,
    historyMaxCaptureMs: 0,
    // Budget enforcement (P1 slice 5, step 6): what was dropped, in blocks, lines and bytes.
    historyLineTargetExceeded: 0,
    historyMaxTotalCompressedBytes: 0,
    historyTrimmedBlocks: 0,
    historyTrimmedLines: 0,
    historyTrimmedBytes: 0,
    historyTrimmedEndedBlocks: 0,
    historyTrimmedRunningBlocks: 0,
    // User clears of the scrollback (T32): how often, and how many archived lines they discarded.
    historyUserClears: 0,
    historyUserClearedLines: 0,
  };
  Object.defineProperty(window, "__WINDTERM_P0_DIAGNOSTICS__", {
    value: Object.freeze({ snapshot: () => Object.freeze({ ...counters }) }),
    configurable: false,
    writable: false,
  });
  return counters;
}

// The build replaces DEV with false; no diagnostic surface is installed in release assets.
export const responsivenessDiagnostics =
  import.meta.env.DEV && new URLSearchParams(location.search).has("p0Diagnostics")
    ? createDiagnostics()
    : undefined;
