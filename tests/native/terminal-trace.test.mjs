import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { installTerminalTrace } from './terminal-trace.mjs';

// Mirrors the immutable descriptors and callback registration/response contract
// in tauri 2.12.3 scripts/core.js and ipc-protocol.js, not a writable invoke stub.
export function createTraceRuntime(onRequest = () => ({ id: 'fixture-id' })) {
  const callbacks = new Map();
  let next = 0;
  const register = (fn, once = false) => {
    const id = ++next;
    callbacks.set(id, function (...args) { if (once) callbacks.delete(id); return fn.apply(this, args); });
    return id;
  };
  const internals = {};
  const window = {};
  const requests = [];
  const convertFileSrc = command => `http://ipc.localhost/${command}`;
  const deliver = (id, raw) => callbacks.get(id)?.(raw);
  window.fetch = function (url, init) {
    requests.push({ receiver: this, args: [...arguments] });
    return Promise.resolve(onRequest(url.slice(url.lastIndexOf('/') + 1), JSON.parse(init.body), { callbacks, deliver }))
      .then(value => ({ headers: new Headers({ 'Tauri-Response': 'ok', 'content-type': 'application/json' }), json: async () => value }));
  };
  function invoke(command, payload = {}) {
    return new Promise((resolve, reject) => {
      const callback = register(value => { resolve(value); callbacks.delete(error); }, true);
      const error = register(value => { reject(value); callbacks.delete(callback); }, true);
      const init = { method: 'POST', body: JSON.stringify(payload), headers: new Headers({
        'Content-Type': 'application/json', 'Tauri-Callback': String(callback),
        'Tauri-Error': String(error), 'Tauri-Invoke-Key': 'PRIVATE_INVOKE_KEY',
      }) };
      window.fetch(convertFileSrc(command), init)
        .then(response => response.json().then(value => [response.headers.get('Tauri-Response') === 'ok' ? callback : error, value]))
        .then(([id, value]) => deliver(id, value), value => deliver(error, value));
    });
  }
  for (const [name, value] of Object.entries({ callbacks, convertFileSrc, invoke })) Object.defineProperty(internals, name, { value });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals });
  const channel = handler => {
    const result = { onmessage: handler };
    const id = register(function (raw) { if ('end' in raw) { callbacks.delete(id); return; } return result.onmessage.call(this, raw.message); });
    result.toJSON = () => `__CHANNEL__:${id}`;
    return { value: result, id };
  };
  return { window, internals, callbacks, register, deliver, requests, channel };
}

function fixture(onRequest, clock = performance) {
  const runtime = createTraceRuntime(onRequest);
  const listeners = new Map();
  const textarea = {};
  const pane = { contains: target => target === textarea };
  const originalFetch = runtime.window.fetch;
  runInNewContext(`(${installTerminalTrace})('powershell', '/fixture');`, {
    window: runtime.window, TextEncoder, Uint8Array, performance: clock, Map,
    document: {
      querySelector: () => pane,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); },
    },
  });
  const controller = runtime.window.__P1_NATIVE_SHELL_TRACE__;
  const open = (channel, extra = {}) => {
    controller.arm();
    return runtime.internals.invoke('pty_open', { shell: 'powershell', cwd: '/fixture', onEvent: channel.value, ...extra });
  };
  return { ...runtime, listeners, textarea, originalFetch, controller, open };
}

function cprRequest(args, { deliver }) {
  deliver(Number(args.onEvent.slice(12)), { index: 0, message: { kind: 'data', id: 'fixture-id', sequence: 1, data: [27, 91, 54, 110] } });
  return { id: 'fixture-id' };
}

test('trace works with real immutable Tauri descriptors and serialized early Channel envelopes', async () => {
  const f = fixture((command, args, runtime) => command === 'pty_open' ? cprRequest(args, runtime) : null);
  const channel = f.channel(() => 'callback-result');
  const original = f.callbacks.get(channel.id);
  assert.equal(Object.getOwnPropertyDescriptor(f.internals, 'invoke').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(f.window, '__TAURI_INTERNALS__').configurable, false);
  await f.open(channel);
  await f.internals.invoke('pty_ack', { id: 'fixture-id', sequence: 1 });
  await f.internals.invoke('pty_write', { id: 'fixture-id', data: [13] });
  const trace = f.controller.stop();
  assert.ok(trace.records.some(item => item.event === 'data' && item.hex === '1b5b366e' && item.index === 0));
  assert.ok(trace.records.some(item => item.command === 'pty_ack' && item.state === 'fulfilled'));
  assert.equal(f.callbacks.get(channel.id), original);
  assert.equal(f.window.fetch, f.originalFetch);
  assert.equal(f.listeners.size, 0);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_INVOKE_KEY|Tauri-Invoke-Key|\/fixture/);
});

test('fetch wrapper preserves original promise, receiver, parameters and rejection object; marks fallback incomplete', async () => {
  const f = fixture();
  const channel = f.channel(() => {});
  const failure = new Error('PRIVATE_FETCH_ERROR');
  const rejected = Promise.reject(failure);
  // Separate instance installs over an immutable-compatible runtime with a
  // controlled fetch promise, so the exact returned reference can be checked.
  const runtime = createTraceRuntime();
  const args = { shell: 'powershell', cwd: '/fixture', onEvent: runtime.channel(() => {}).value };
  const receiver = {};
  let seen;
  runtime.window.fetch = function (...values) { seen = { receiver: this, values }; return rejected; };
  const listeners = new Map();
  runInNewContext(`(${installTerminalTrace})('powershell', '/fixture')`, { window: runtime.window, Map, TextEncoder, performance,
    document: { querySelector: () => null, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} } });
  runtime.window.__P1_NATIVE_SHELL_TRACE__.arm();
  const init = { body: JSON.stringify(args), headers: new Headers({ 'Tauri-Callback': String(runtime.register(() => {})), 'Tauri-Error': String(runtime.register(() => {})) }) };
  const result = runtime.window.fetch.call(receiver, runtime.internals.convertFileSrc('pty_open'), init);
  assert.equal(result, rejected);
  assert.equal(seen.receiver, receiver);
  assert.equal(seen.values[1], init);
  await assert.rejects(result, error => error === failure);
  const trace = runtime.window.__P1_NATIVE_SHELL_TRACE__.stop();
  assert.ok(trace.incompleteReasons.includes('fetch-rejected-possible-fallback'));
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_FETCH_ERROR/);
  await f.open(channel);
  f.controller.stop();
});

test('callback wrappers preserve this, arguments, return values, throws and deletion without resurrection', async () => {
  const f = fixture();
  const channel = f.channel(() => {});
  let seen;
  const failure = new Error('PRIVATE_CALLBACK_ERROR');
  f.callbacks.set(channel.id, function (...args) { seen = { receiver: this, args }; if (args[1] === 'throw') throw failure; return 'value'; });
  await f.open(channel);
  const wrapper = f.callbacks.get(channel.id);
  const receiver = {};
  const raw = { index: 0, message: { id: 'fixture-id', kind: 'data', sequence: 1, data: [65] } };
  assert.equal(wrapper.call(receiver, raw, 42), 'value');
  assert.equal(seen.receiver, receiver);
  assert.deepEqual(seen.args, [raw, 42]);
  assert.throws(() => wrapper.call(receiver, raw, 'throw'), error => error === failure);
  f.callbacks.delete(channel.id);
  const trace = f.controller.stop();
  assert.equal(f.callbacks.has(channel.id), false);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_CALLBACK_ERROR/);
});

test('trace excludes unarmed, foreign and custom-environment launches without recording payloads', async () => {
  const f = fixture();
  const channel = f.channel(() => {});
  await f.open(channel);
  await f.internals.invoke('pty_write', { id: 'foreign-id', data: [...Buffer.from('PRIVATE_WRITE')] });
  f.deliver(channel.id, { index: 0, message: { id: 'foreign-id', kind: 'data', data: [...Buffer.from('PRIVATE_DATA')] } });
  const other = f.channel(() => {});
  const original = f.callbacks.get(other.id);
  await f.open(other, { env: [{ name: 'SECRET', value: 'PRIVATE_ENV' }] });
  await f.open(other, { locale: { mode: 'custom', variables: [] } });
  await f.internals.invoke('pty_open', { onEvent: other.value });
  assert.equal(f.callbacks.get(other.id), original);
  const trace = f.controller.stop();
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE|SECRET|foreign-id|fixture-id/);
  assert.equal(trace.records.filter(item => item.command === 'pty_open' && item.state === 'begin').length, 1);
});

test('mismatched open IDs purge provisional bytes and prevent later session contamination', async () => {
  const f = fixture((_command, args, runtime) => { cprRequest(args, runtime); return { id: 'another-id' }; });
  const channel = f.channel(() => {});
  await f.open(channel);
  f.deliver(channel.id, { index: 1, message: { id: 'another-id', kind: 'data', sequence: 2, data: [66] } });
  const trace = f.controller.stop();
  assert.ok(trace.incompleteReasons.includes('open-session-mismatch'));
  assert.ok(!trace.records.some(item => item.hex));
});

test('complete two-shell workload retains per-key writes, output, ACKs, startup and exit without truncation', async (t) => {
  const commands = ['[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "'P1_SHELL=' + $PSVersionTable.PSVersion.ToString()", '(Get-Location).Path', 'exit 7'];
  const text = commands.map(command => `${command}\r`).join('');
  assert.equal(text.length, 135, 'the unchanged native scenario has 135 input bytes per shell');
  const sessions = new Map();
  const acknowledgements = [];
  let totalData = 0;
  let ticks = 0;
  const f = fixture((command, args, { deliver }) => {
    const emit = (session, data) => {
      totalData++;
      deliver(session.channel, { index: session.index++, message: {
        kind: 'data', id: session.id, sequence: ++session.sequence, data: [...Buffer.from(data)],
      } });
    };
    if (command === 'pty_open') {
      const id = `fixture-${sessions.size + 1}`;
      const session = { id, channel: Number(args.onEvent.slice(12)), index: 0, sequence: 0, line: '' };
      sessions.set(id, session);
      emit(session, '\x1b[6nWindows PowerShell\r\nCopyright Microsoft Corporation.\r\nPS /fixture> ');
      return { id };
    }
    if (command === 'pty_write' && args.data[0] !== 27) {
      const session = sessions.get(args.id);
      const char = Buffer.from(args.data).toString('utf8');
      // Per-keystroke terminal redraw, followed by the corresponding ACK,
      // exercises the trace interface instead of estimating JSON string sizes.
      emit(session, `\r\x1b[2KPS /fixture> ${char}`);
      if (char === '\r') {
        if (session.line.startsWith("'P1_SHELL='")) emit(session, '\r\nP1_SHELL=5.1.20348.1\r\n');
        if (session.line === '(Get-Location).Path') emit(session, '\r\n/fixture\r\n');
        if (session.line === 'exit 7') deliver(session.channel, { index: session.index++, message: { kind: 'exit', id: session.id, code: 7 } });
        session.line = '';
      } else session.line += char;
    }
    return null;
  }, { now: () => 12345.100000000093 + ticks++ * 17.333333333333 });
  for (let slot = 1; slot <= 2; slot++) {
    const channel = f.channel(event => {
      if (event.kind === 'data') acknowledgements.push(f.internals.invoke('pty_ack', { id: event.id, sequence: event.sequence }));
    });
    const { id } = await f.open(channel);
    await f.internals.invoke('pty_resize', { id, cols: 100, rows: 30 });
    await f.internals.invoke('pty_write', { id, data: [...Buffer.from('\x1b[1;1R')] });
    for (const char of text) {
      if (char === '\r') f.listeners.get('keydown')({ key: 'Enter', target: f.textarea });
      await f.internals.invoke('pty_write', { id, data: [...Buffer.from(char)] });
    }
    f.deliver(channel.id, { index: sessions.get(id).index, end: true });
  }
  await Promise.all(acknowledgements);
  const trace = f.controller.stop();
  assert.equal(trace.truncated, false, `lost ${trace.droppedRecords} records at ${trace.limitBytes} bytes`);
  assert.equal(trace.incomplete, false);
  assert.equal(trace.records.filter(item => item.command === 'pty_write' && item.state === 'begin').length, 272);
  assert.equal(trace.records.filter(item => item.command === 'pty_write' && item.state === 'fulfilled').length, 272);
  assert.equal(trace.records.filter(item => item.event === 'data').length, totalData);
  assert.equal(trace.records.filter(item => item.command === 'pty_ack' && item.state === 'fulfilled').length, totalData);
  assert.equal(trace.records.filter(item => item.event === 'exit' && item.code === 7).length, 2);
  assert.equal(trace.records.filter(item => item.event === 'keydown-enter').length, 8);
  const capturedBytes = Buffer.byteLength(`${JSON.stringify(trace)}\n`);
  assert.ok(capturedBytes <= trace.limitBytes);
  t.diagnostic(`two-shell workload: ${trace.records.length} records, ${capturedBytes}/${trace.limitBytes} bytes, no truncation`);
});

test('two fixture slots capture Enter only, enforce 256 KiB and flag truncation', async () => {
  let id = 0;
  const f = fixture(() => ({ id: `id-${++id}` }));
  const first = f.channel(() => {});
  const second = f.channel(() => {});
  await f.open(first);
  await f.open(second);
  f.listeners.get('keydown')({ key: 'Enter', target: f.textarea });
  f.listeners.get('keydown')({ key: 'PRIVATE_CHARACTER', target: f.textarea });
  f.listeners.get('keydown')({ key: 'Enter', target: {} });
  for (let index = 0; index < 100; index++) f.deliver(first.id, {
    index, message: { id: 'id-1', kind: 'data', sequence: index + 1, data: Array(8192).fill(65) },
  });
  f.deliver(second.id, { index: 0, message: { id: 'id-2', kind: 'data', sequence: 1, data: [66] } });
  const trace = f.controller.stop();
  assert.equal(trace.records.filter(item => item.event === 'keydown-enter').length, 1);
  assert.ok(trace.truncated);
  assert.equal(trace.limitBytes, 256 * 1024);
  assert.ok(Buffer.byteLength(`${JSON.stringify(trace)}\n`) <= 256 * 1024);
});

test('unreplaceable fetch fails installation immediately; empty trace is explicitly incomplete', () => {
  const runtime = createTraceRuntime();
  Object.defineProperty(runtime.window, 'fetch', { writable: false });
  assert.throws(() => runInNewContext(`(${installTerminalTrace})('powershell', '/fixture')`, {
    window: runtime.window, TextEncoder, performance, Map,
  }), /read only|installation failed/);
  const f = fixture();
  const trace = f.controller.stop();
  assert.equal(trace.incomplete, true);
  assert.ok(trace.incompleteReasons.includes('missing-two-fixture-slots'));
});

test('unrelated IPC transport rejection flags global fallback without capturing its payload or error', async () => {
  const f = fixture(command => command === 'private-command' ? Promise.reject(new Error('PRIVATE_ERROR')) : ({ id: 'fixture-id' }));
  await f.open(f.channel(() => {}));
  await assert.rejects(f.internals.invoke('private-command', { password: 'PRIVATE_VALUE' }), /PRIVATE_ERROR/);
  const trace = f.controller.stop();
  assert.ok(trace.incompleteReasons.includes('fetch-rejected-possible-fallback'));
  assert.doesNotMatch(JSON.stringify(trace), /private-command|PRIVATE|password/);
});
