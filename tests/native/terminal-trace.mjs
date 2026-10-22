// Serialized into the fixture WebView; keep this function self-contained.
// Tauri 2's invoke/global properties are immutable. Observe its custom-protocol
// transport and only the callback IDs belonging to two explicitly armed shells.
export function installTerminalTrace(shell, cwd, options) {
  'use strict';
  options = options || {};
  const key = '__P1_NATIVE_SHELL_TRACE__';
  if (window[key]) throw new Error('shell trace already installed');
  const internals = window.__TAURI_INTERNALS__;
  const callbacks = internals?.callbacks;
  if (!(callbacks instanceof Map) || typeof internals.convertFileSrc !== 'function'
    || typeof window.fetch !== 'function') throw new Error('Tauri trace transport unavailable');
  const originalFetch = window.fetch;
  const urls = new Map(['pty_open', 'pty_write', 'pty_ack', 'pty_resize']
    .map(command => [internals.convertFileSrc(command, 'ipc'), command]));
  const ipcPrefix = internals.convertFileSrc('', 'ipc');
  const records = [];
  const targets = [];
  const installed = new Map();
  const reasons = new Set();
  const encoder = new TextEncoder();
  // Two 135-key shells with per-key echo and ACK records exceed 64 KiB.
  // Keep a fixed 256 KiB cap; truncation still invalidates successful capture.
  const limit = 256 * 1024;
  let used = 1024; // Reserve the bounded metadata envelope.
  let dropped = 0;
  let armed = false;
  let stopped = false;
  let call = 0;
  const start = performance.now();
  const safe = fn => { try { return fn(); } catch { if (!stopped) reasons.add('observer-error'); } };
  const record = (target, detail) => safe(() => {
    if (stopped) return;
    const item = { slot: target.slot, ms: performance.now() - start, ...detail };
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (used + size > limit) { dropped = Math.min(dropped + 1, Number.MAX_SAFE_INTEGER); return; }
    records.push(item);
    used += size;
  });
  const bytes = data => {
    if (!Array.isArray(data) && !(data instanceof Uint8Array)) return {};
    const count = Math.min(data.length, 4096);
    let hex = '';
    for (let i = 0; i < count; i++) {
      if (!Number.isInteger(data[i]) || data[i] < 0 || data[i] > 255) return {};
      hex += data[i].toString(16).padStart(2, '0');
    }
    if (data.length > count) dropped = Math.min(dropped + 1, Number.MAX_SAFE_INTEGER);
    return { byteLength: data.length, hex, bytesTruncated: data.length > count };
  };
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 128;
  const callbackId = value => typeof value === 'string' && /^\d{1,10}$/.test(value)
    && Number(value) <= 4294967295 ? Number(value) : null;
  const stageNames = new Set(['webdriver-input-return', 'pty-write-enter', 'first-data-after-enter']);
  const stageTiming = options?.stageTiming === true;
  function wrap(id, observe) {
    const original = callbacks.get(id);
    if (id === null || typeof original !== 'function' || installed.has(id)) {
      reasons.add('callback-unavailable');
      return false;
    }
    function wrapper(...args) {
      if (!stopped) safe(() => observe(...args));
      try { return original.apply(this, args); }
      finally { if (callbacks.get(id) !== wrapper) installed.delete(id); }
    }
    callbacks.set(id, wrapper);
    if (callbacks.get(id) !== wrapper) { reasons.add('callback-install-failed'); return false; }
    installed.set(id, { original, wrapper });
    return true;
  }
  function capture(command, init) {
    // Read only callback routing IDs. Never retain headers, invoke keys or whole
    // payloads. An armed request must still match the fixed fixture exactly.
    if (typeof init?.body !== 'string' || init.body.length > 131072) return null;
    const args = JSON.parse(init.body);
    let target;
    if (armed && command === 'pty_open') {
      armed = false;
      if (targets.length >= 2 || args?.shell !== shell || args.cwd !== cwd
        || (args.env && (!Array.isArray(args.env) || args.env.length !== 0))
        || (args.locale && (args.locale.mode !== 'default' || args.locale.variables?.length !== 0))
        || typeof args.onEvent !== 'string' || !/^__CHANNEL__:\d{1,10}$/.test(args.onEvent)) {
        reasons.add('fixture-open-not-matched');
        return null;
      }
      target = { slot: targets.length + 1, id: null, rejected: false,
        pane: document.querySelector('.terminal-pane.focused-pane:not([hidden])'), pendingDataStage: false };
      targets.push(target);
      wrap(callbackId(args.onEvent.slice('__CHANNEL__:'.length)), raw => {
        const event = raw?.message;
        if (target.rejected || !validId(event?.id)) return;
        if (target.id === null) target.id = event.id;
        if (target.id !== event.id) { record(target, { event: 'foreign-session-rejected' }); return; }
        const index = Number.isSafeInteger(raw.index) ? raw.index : null;
        if (event.kind === 'data') {
          if (stageTiming && target.pendingDataStage) {
            target.pendingDataStage = false;
            record(target, { event: 'stage', stage: 'first-data-after-enter' });
          }
          record(target, { event: 'data', index,
            sequence: Number.isSafeInteger(event.sequence) ? event.sequence : null, ...bytes(event.data) });
        }
        else if (event.kind === 'exit') record(target, { event: 'exit', index, code: Number.isSafeInteger(event.code) ? event.code : null });
        else if (event.kind === 'error') record(target, { event: 'error', index });
      });
    } else if (command !== 'pty_open') target = targets.find(item => !item.rejected && item.id !== null && item.id === args?.id);
    if (!target) return null;
    const detail = { command, call: ++call };
    if (command === 'pty_write') {
      Object.assign(detail, bytes(args.data));
      if (stageTiming && Array.isArray(args.data) && args.data.some(byte => byte === 13 || byte === 10)) {
        target.pendingDataStage = true;
        record(target, { event: 'stage', stage: 'pty-write-enter' });
      }
    }
    if (command === 'pty_ack') detail.sequence = Number.isSafeInteger(args.sequence) ? args.sequence : null;
    if (command === 'pty_resize') {
      detail.cols = Number.isSafeInteger(args.cols) ? args.cols : null;
      detail.rows = Number.isSafeInteger(args.rows) ? args.rows : null;
    }
    record(target, { ...detail, state: 'begin' });
    wrap(callbackId(init.headers?.get('Tauri-Callback')), value => {
      if (command === 'pty_open') {
        if (!validId(value?.id) || (target.id !== null && target.id !== value.id)) {
          for (let i = records.length - 1; i >= 0; i--) if (records[i].slot === target.slot) records.splice(i, 1);
          target.id = null;
          target.rejected = true;
          reasons.add('open-session-mismatch');
          record(target, { event: 'open-session-mismatch' });
        } else target.id = value.id;
      }
      record(target, { command, call: detail.call, state: 'fulfilled' });
    });
    wrap(callbackId(init.headers?.get('Tauri-Error')), () => record(target, { command, call: detail.call, state: 'rejected' }));
    return target;
  }
  function fetch(input, init) {
    const command = urls.get(input);
    if (command) safe(() => capture(command, init));
    const isIpc = typeof input === 'string' && input.startsWith(ipcPrefix);
    try {
      const result = originalFetch.apply(this, arguments);
      // Keep the original fetch Promise; no response cloning/consumption.
      // Any IPC transport failure can switch Tauri globally to postMessage,
      // including a non-target command. Record only that fact, never its data.
      if (isIpc) safe(() => result.then(undefined, () => {
        if (!stopped) reasons.add('fetch-rejected-possible-fallback');
      }));
      return result;
    } catch (error) {
      if (isIpc && !stopped) reasons.add('fetch-threw');
      throw error;
    }
  }
  const enter = event => {
    if (event.key !== 'Enter') return;
    const target = targets.find(item => item.pane?.contains(event.target));
    if (target) record(target, { event: 'keydown-enter', ...(stageTiming ? { stage: 'webview-keydown-enter' } : {}), repeat: !!event.repeat,
      ctrl: !!event.ctrlKey, alt: !!event.altKey, shift: !!event.shiftKey, meta: !!event.metaKey });
  };
  window.fetch = fetch;
  if (window.fetch !== fetch) throw new Error('shell trace fetch installation failed');
  document.addEventListener('keydown', enter, true);
  window[key] = {
    arm() { if (!stopped && targets.length < 2) armed = true; },
    mark(stage) {
      if (!stageTiming) return false;
      if (!stageNames.has(stage)) { reasons.add('invalid-stage'); return false; }
      const target = [...targets].reverse().find(item => !item.rejected && item.id !== null);
      if (!target) { reasons.add('stage-without-session'); return false; }
      record(target, { event: 'stage', stage });
      return true;
    },
    stop() {
      stopped = true;
      if (window.fetch === fetch) window.fetch = originalFetch;
      for (const [id, { original, wrapper }] of installed) {
        if (callbacks.has(id) && callbacks.get(id) === wrapper) callbacks.set(id, original);
      }
      document.removeEventListener('keydown', enter, true);
      delete window[key];
      for (const target of targets) {
        if (!records.some(item => item.slot === target.slot && item.event === 'data')) reasons.add('missing-slot-data');
        if (!records.some(item => item.slot === target.slot && item.command === 'pty_open' && item.state === 'fulfilled')) reasons.add('missing-open-settlement');
      }
      if (targets.length !== 2) reasons.add('missing-two-fixture-slots');
      return { schema: 1, transport: 'custom-protocol-callback', limitBytes: limit,
        truncated: dropped > 0, droppedRecords: dropped, incomplete: reasons.size > 0,
        incompleteReasons: [...reasons], records };
    },
  };
}
