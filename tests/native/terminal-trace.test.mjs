import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { installTerminalTrace } from './terminal-trace.mjs';

function fixture(implementation = () => Promise.resolve({ id: 'fixture-id' })) {
  const calls = [];
  const listeners = new Map();
  const textarea = {};
  const pane = { contains: target => target === textarea };
  const original = function (...args) { calls.push({ receiver: this, args }); return implementation(...args); };
  const internals = { invoke: original };
  const window = { __TAURI_INTERNALS__: internals };
  runInNewContext(`(${installTerminalTrace})('powershell', '/fixture');`, {
    window, TextEncoder, Uint8Array, performance,
    document: {
      querySelector: () => pane,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); },
    },
  });
  const controller = window.__P1_NATIVE_SHELL_TRACE__;
  const channel = handler => {
    // Model the API's prototype getter/setter, not a plain data property.
    let current = handler;
    return Object.create({ get onmessage() { return current; }, set onmessage(value) { current = value; } });
  };
  const open = (onEvent, extra = {}) => {
    controller.arm();
    return internals.invoke('pty_open', { shell: 'powershell', cwd: '/fixture', onEvent, ...extra });
  };
  return { calls, listeners, textarea, internals, original, controller, channel, open, window };
}

test('terminal trace preserves invoke arguments, receivers, promise identity and callback semantics', async () => {
  let resolveOpen;
  const promise = new Promise(resolve => { resolveOpen = resolve; });
  const f = fixture(() => promise);
  let seen;
  const handler = function (...args) { seen = { receiver: this, args }; return 'callback-result'; };
  const channel = f.channel(handler);
  assert.equal(f.open(channel), promise);
  assert.equal(f.calls[0].receiver, f.internals);
  const event = { kind: 'data', id: 'fixture-id', sequence: 1, data: [27, 91, 54, 110] };
  const receiver = {};
  assert.equal(channel.onmessage.call(receiver, event, 42), 'callback-result');
  assert.equal(seen.receiver, receiver);
  assert.deepEqual(seen.args, [event, 42]);
  // ACK before open resolution is scoped through the bound Channel.
  assert.equal(f.internals.invoke('pty_ack', { id: 'fixture-id', sequence: 1 }), promise);
  resolveOpen({ id: 'fixture-id' });
  await promise;
  const trace = f.controller.stop();
  assert.ok(trace.records.some(item => item.event === 'data' && item.hex === '1b5b366e'));
  assert.ok(trace.records.some(item => item.command === 'pty_ack' && item.state === 'fulfilled'));
  assert.equal(f.internals.invoke, f.original);
  assert.equal(channel.onmessage, handler);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.window.__P1_NATIVE_SHELL_TRACE__, undefined);
});

test('terminal trace preserves sync throws, rejection objects and throwing channel handlers without logging messages', async () => {
  const failure = new Error('PRIVATE_REJECTION');
  const rejected = Promise.reject(failure);
  const f = fixture(command => { if (command === 'pty_resize') throw failure; return rejected; });
  const channel = f.channel(() => { throw failure; });
  const result = f.open(channel);
  assert.equal(result, rejected);
  assert.throws(() => channel.onmessage({ id: 'fixture-id', kind: 'error', message: 'PRIVATE_EVENT' }), error => error === failure);
  assert.throws(() => f.internals.invoke('pty_resize', { id: 'fixture-id', cols: 80, rows: 24 }), error => error === failure);
  await assert.rejects(result, error => error === failure);
  const trace = f.controller.stop();
  assert.ok(trace.records.some(item => item.state === 'rejected'));
  assert.ok(trace.records.some(item => item.state === 'threw'));
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE/);
});

test('terminal trace excludes unrelated sessions, open arguments, unarmed and nonempty environment launches', async () => {
  const f = fixture();
  const target = f.channel(() => {});
  await f.open(target);
  const foreign = f.channel(() => {});
  const foreignHandler = foreign.onmessage;
  await f.internals.invoke('pty_open', { onEvent: foreign, env: [{ name: 'SECRET', value: 'PRIVATE_VALUE' }] });
  assert.equal(foreign.onmessage, foreignHandler);
  await f.internals.invoke('pty_write', { id: 'other-session', data: Array.from(new TextEncoder().encode('PRIVATE_WRITE')) });
  target.onmessage({ id: 'other-session', kind: 'data', data: Array.from(new TextEncoder().encode('PRIVATE_DATA')) });
  await f.open(foreign, { env: [{ name: 'SECRET', value: 'PRIVATE_ENV' }] });
  await f.open(foreign, { locale: { mode: 'custom', variables: [] } });
  assert.equal(foreign.onmessage, foreignHandler);
  const trace = f.controller.stop();
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE|SECRET|other-session|fixture-id|\/fixture/);
  assert.equal(trace.records.filter(item => item.command === 'pty_open' && item.state === 'begin').length, 1);
});

test('terminal trace removes provisional bytes when open resolves to another session and rejects subsequent contamination', async () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const f = fixture(() => promise);
  const channel = f.channel(() => {});
  f.open(channel);
  channel.onmessage({ id: 'unexpected', kind: 'data', sequence: 1, data: [65] });
  resolve({ id: 'actual' });
  await promise;
  channel.onmessage({ id: 'actual', kind: 'data', sequence: 2, data: [66] });
  await f.internals.invoke('pty_write', { id: 'actual', data: [67] });
  const trace = f.controller.stop();
  assert.ok(trace.records.some(item => item.event === 'open-session-mismatch'));
  assert.ok(!trace.records.some(item => item.hex));
});

test('terminal trace records only Enter on fixture panes and captures write/ack/resize begin and settle', async () => {
  const f = fixture();
  await f.open(f.channel(() => {}));
  f.listeners.get('keydown')({ key: 'Enter', target: f.textarea });
  f.listeners.get('keydown')({ key: 'PRIVATE_TYPED_CHARACTER', target: f.textarea });
  f.listeners.get('keydown')({ key: 'Enter', target: {} });
  await f.internals.invoke('pty_write', { id: 'fixture-id', data: [13] });
  await f.internals.invoke('pty_ack', { id: 'fixture-id', sequence: 4 });
  await f.internals.invoke('pty_resize', { id: 'fixture-id', cols: 100, rows: 30 });
  const trace = f.controller.stop();
  assert.equal(trace.records.filter(item => item.event === 'keydown-enter').length, 1);
  for (const command of ['pty_write', 'pty_ack', 'pty_resize']) {
    assert.equal(trace.records.filter(item => item.command === command).length, 2);
  }
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE/);
});

test('terminal trace caps serialized output at 64 KiB, marks truncated bytes and restores both channels', async () => {
  let id = 0;
  const f = fixture(() => Promise.resolve({ id: `id-${++id}` }));
  const handler = () => {};
  const first = f.channel(handler);
  const second = f.channel(handler);
  await f.open(first);
  await f.open(second);
  const third = f.channel(handler);
  await f.open(third);
  assert.equal(third.onmessage, handler);
  for (let sequence = 1; sequence <= 100; sequence++) {
    first.onmessage({ kind: 'data', id: 'id-1', sequence, data: Array(8192).fill(65) });
  }
  second.onmessage({ kind: 'exit', id: 'id-2', code: 7 });
  const trace = f.controller.stop();
  assert.ok(trace.truncated);
  assert.ok(trace.droppedRecords > 0);
  assert.ok(trace.records.some(item => item.bytesTruncated));
  assert.ok(Buffer.byteLength(`${JSON.stringify(trace)}\n`) <= 65536);
  assert.equal(first.onmessage, handler);
  assert.equal(second.onmessage, handler);
});

test('terminal trace stop does not overwrite later handlers or record pending settlements', async () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const f = fixture(() => promise);
  const channel = f.channel(() => {});
  f.open(channel);
  const replacement = () => {};
  channel.onmessage = replacement;
  f.internals.invoke = replacement;
  const trace = f.controller.stop();
  const snapshot = JSON.stringify(trace);
  resolve({ id: 'fixture-id' });
  await promise;
  assert.equal(JSON.stringify(trace), snapshot);
  assert.equal(channel.onmessage, replacement);
  assert.equal(f.internals.invoke, replacement);
});
