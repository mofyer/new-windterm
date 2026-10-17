// This function is serialized into the fixture WebView. Keep it self-contained.
// It observes only the two explicitly armed, empty-environment shell fixtures.
export function installTerminalTrace(shell, cwd) {
  const key = '__P1_NATIVE_SHELL_TRACE__';
  if (window[key]) throw new Error('shell trace already installed');
  const internals = window.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') throw new Error('Tauri invoke unavailable');
  const original = internals.invoke;
  const records = [];
  const targets = [];
  const encoder = new TextEncoder();
  const limit = 64 * 1024;
  // Reserve space for the bounded envelope and final truncation counters.
  let used = 512;
  let dropped = 0;
  let armed = false;
  let stopped = false;
  let call = 0;
  const start = performance.now();
  const safe = fn => { try { return fn(); } catch { /* Observation must not affect IPC. */ } };
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
    // Do not allocate an unbounded copy even if an unexpected event is received.
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
  const observe = (result, target, detail, resolved) => {
    // Return the original promise unchanged. Neither rejection values nor open
    // parameters enter the trace. Both observer handlers are non-throwing.
    safe(() => result.then(
      value => safe(() => { if (stopped) return; resolved?.(value); record(target, { ...detail, state: 'fulfilled' }); }),
      () => record(target, { ...detail, state: 'rejected' }),
    ));
    return result;
  };
  function invoke(command, args) {
    let target;
    if (armed && command === 'pty_open') {
      armed = false;
      if (targets.length < 2 && args?.shell === shell && args.cwd === cwd
        && (!args.env || (Array.isArray(args.env) && args.env.length === 0))
        && (!args.locale || (args.locale.mode === 'default' && args.locale.variables?.length === 0))
        && typeof args.onEvent?.onmessage === 'function') {
        const channel = args.onEvent;
        target = { slot: targets.length + 1, channel, handler: channel.onmessage,
          pane: document.querySelector('.terminal-pane.focused-pane:not([hidden])'), id: null };
        target.wrapper = function (event) {
          safe(() => {
            if (!target.rejected && validId(event?.id)) {
              // Channel provenance scopes early events before pty_open resolves.
              if (target.id === null) target.id = event.id;
              if (target.id !== event.id) { record(target, { event: 'foreign-session-rejected' }); return; }
              if (event.kind === 'data') record(target, { event: 'data',
                sequence: Number.isSafeInteger(event.sequence) ? event.sequence : null, ...bytes(event.data) });
              else if (event.kind === 'exit') record(target, { event: 'exit', code: Number.isSafeInteger(event.code) ? event.code : null });
              else if (event.kind === 'error') record(target, { event: 'error' });
            }
          });
          return target.handler.apply(this, arguments);
        };
        channel.onmessage = target.wrapper;
        targets.push(target);
      }
    } else if (['pty_write', 'pty_ack', 'pty_resize'].includes(command)) {
      target = targets.find(item => !item.rejected && item.id !== null && item.id === args?.id);
    }
    if (!target) return original.apply(this, arguments);
    const detail = { command, call: ++call };
    if (command === 'pty_write') Object.assign(detail, bytes(args.data));
    if (command === 'pty_ack') detail.sequence = Number.isSafeInteger(args.sequence) ? args.sequence : null;
    if (command === 'pty_resize') {
      detail.cols = Number.isSafeInteger(args.cols) ? args.cols : null;
      detail.rows = Number.isSafeInteger(args.rows) ? args.rows : null;
    }
    record(target, { ...detail, state: 'begin' });
    try {
      return observe(original.apply(this, arguments), target, { command, call: detail.call },
        command === 'pty_open' ? value => {
          if (!validId(value?.id) || (target.id !== null && target.id !== value.id)) {
            // Do not retain provisional bytes if the open result disproves their
            // ownership. Do not expose either unexpected session identifier.
            for (let i = records.length - 1; i >= 0; i--) if (records[i].slot === target.slot) records.splice(i, 1);
            target.id = null;
            target.rejected = true;
            record(target, { event: 'open-session-mismatch' });
          } else target.id = value.id;
        } : undefined);
    } catch (error) {
      record(target, { command, call: detail.call, state: 'threw' });
      throw error;
    }
  }
  const enter = event => {
    if (event.key !== 'Enter') return;
    const target = targets.find(item => item.pane?.contains(event.target));
    if (target) record(target, { event: 'keydown-enter', repeat: !!event.repeat,
      ctrl: !!event.ctrlKey, alt: !!event.altKey, shift: !!event.shiftKey, meta: !!event.metaKey });
  };
  internals.invoke = invoke;
  document.addEventListener('keydown', enter, true);
  window[key] = {
    arm() { if (!stopped && targets.length < 2) armed = true; },
    stop() {
      stopped = true;
      if (internals.invoke === invoke) internals.invoke = original;
      for (const target of targets) if (target.channel.onmessage === target.wrapper) target.channel.onmessage = target.handler;
      document.removeEventListener('keydown', enter, true);
      delete window[key];
      return { schema: 1, limitBytes: limit, truncated: dropped > 0, droppedRecords: dropped, records };
    },
  };
}
