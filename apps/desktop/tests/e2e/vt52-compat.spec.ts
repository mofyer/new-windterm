import { test, expect } from '@playwright/test';

test('VT52 PoC translates basic controls and preserves every UTF-8/chunk boundary', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/terminal-compat/vt52-stream.ts';
    const { Vt52Stream } = await import(/* @vite-ignore */ path);
    const encode = (value: string) => new TextEncoder().encode(value);
    const source = encode('ANSI中文\x1b[?2l\x1bH\x1bY!#🌏\x1bA\x1bB\x1bC\x1bD\x1bI\x1bJ\x1bK\x1b<\x1b[31m回');
    const run = (chunks: Uint8Array[]) => {
      const stream = new Vt52Stream();
      const results = chunks.map(chunk => stream.push(chunk));
      results.push(stream.finish());
      return {
        output: results.flatMap(result => Array.from(result.output)),
        inputBytes: results.reduce((total, result) => total + result.inputBytes, 0),
        diagnostics: results.flatMap(result => result.diagnostics),
      };
    };
    const whole = run([source]);
    const cuts = Array.from({ length: source.length + 1 }, (_, cut) => run([source.slice(0, cut), source.slice(cut)]));
    cuts.push(run(Array.from(source, byte => new Uint8Array([byte]))));
    return { whole, cuts, length: source.length, expected: Array.from(encode('ANSI中文\x1b[?2l\x1b[H\x1b[2;4H🌏\x1b[A\x1b[B\x1b[C\x1b[D\x1bM\x1b[J\x1b[K\x1b[31m回')) };
  });
  expect(result.whole.output).toEqual(result.expected);
  expect(result.whole.inputBytes).toBe(result.length);
  expect(result.whole.diagnostics.map(item => item.code)).toEqual(['clean-state-required']);
  for (const cut of result.cuts) expect(cut).toEqual(result.whole);
});

test('VT52 PoC drives actual xterm cursor, erase and reverse scrolling', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const adapterPath = '/src/terminal-compat/vt52-stream.ts';
    const xtermPath = '/node_modules/@xterm/xterm/lib/xterm.mjs';
    const { Vt52Stream } = await import(/* @vite-ignore */ adapterPath);
    const { Terminal } = await import(/* @vite-ignore */ xtermPath);
    const terminal = new Terminal({ cols: 12, rows: 4, allowProposedApi: true });
    const holder = document.createElement('div');
    document.body.append(holder);
    terminal.open(holder);
    const adapter = new Vt52Stream();
    const write = (data: Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve));
    const send = async (value: string) => {
      for (const byte of new TextEncoder().encode(value)) await write(adapter.push(new Uint8Array([byte])).output);
    };
    const snapshot = () => ({
      row: terminal.buffer.active.cursorY,
      col: terminal.buffer.active.cursorX,
      lines: Array.from({ length: 4 }, (_, row) => terminal.buffer.active.getLine(row).translateToString(true)),
    });
    try {
      await send('\x1b[?2l\x1bY!#X\x1bB\x1bC\x1bA\x1bDZ');
      const cursor = snapshot();
      await send('\x1bHfirst\x1bY! second\x1bY\" third\x1bY# fourth\x1bY!#\x1bK');
      const eraseLine = snapshot();
      await send('\x1bY\"!\x1bJ');
      const eraseDisplay = snapshot();
      await send('\x1bH\x1bI');
      const reverseScroll = snapshot();
      await send('\x1bY~~X');
      const clipped = snapshot();
      terminal.reset(); adapter.reset();
      await send('\x1b[2;3r\x1b[?6h\x1b[?2l\x1bH');
      const contaminatedOrigin = snapshot();
      return { cursor, eraseLine, eraseDisplay, reverseScroll, clipped, contaminatedOrigin };
    } finally { terminal.dispose(); holder.remove(); }
  });
  expect(result.cursor).toMatchObject({ row: 1, col: 5, lines: ['', '   XZ', '', ''] });
  expect(result.eraseLine.lines).toEqual(['first', 'sec', 'third', 'fourth']);
  expect(result.eraseDisplay.lines).toEqual(['first', 'sec', 't', '']);
  expect(result.reverseScroll).toMatchObject({ row: 0, col: 0, lines: ['', 'first', 'sec', 't'] });
  expect(result.clipped.row).toBe(3);
  expect(result.clipped.lines[3]).toBe('t          X');
  // Deliberate scope limit: adapter must not silently clear/change inherited ANSI modes.
  expect(result.contaminatedOrigin.row).toBe(1);
});

test('ANSI OSC/DCS content stays byte-exact; an ESC interrupts strings as in xterm', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/terminal-compat/vt52-stream.ts';
    const { Vt52Stream } = await import(/* @vite-ignore */ path);
    const values = [
      '\x1b]0;title[?2l\x07\x1bY!#',
      '\x1bPqdata[?2l\x1b\\\x1bY!#',
      '\x1b]0;title\x1b[?2l\x1bY!#',
      '\x1bPqdata\x1b[?2l\x1bY!#',
      '\x1b]0;title\x18\x1b[?2l\x1bY!#',
      '\x1bPqdata\x1a\x1b[?2l\x1bY!#',
      '\x1b[?2;7l\x1bY!#\x1b[?02l\x1bY!#\x1b[?2\x07l\x1bY!#',
      '\x1b [ ?2l\x1bY!#',
    ];
    return values.map(value => {
      const input = new TextEncoder().encode(value);
      const run = (chunks: Uint8Array[]) => {
        const stream = new Vt52Stream();
        const results = chunks.map(chunk => stream.push(chunk));
        results.push(stream.finish());
        return { output: results.flatMap(result => Array.from(result.output)), diagnostics: results.flatMap(result => result.diagnostics) };
      };
      const whole = run([input]);
      return { input: Array.from(input), whole, everyByte: run(Array.from(input, byte => new Uint8Array([byte]))) };
    });
  });
  for (const item of result) expect(item.everyByte).toEqual(item.whole);
  for (const index of [0, 1, 6, 7]) {
    expect(result[index].whole.output).toEqual(result[index].input);
    expect(result[index].whole.diagnostics).toEqual([]);
  }
  for (const index of [2, 3, 4, 5]) {
    expect(new TextDecoder().decode(new Uint8Array(result[index].whole.output))).toContain('\x1b[2;4H');
    expect(result[index].whole.diagnostics.map(item => item.code)).toEqual(['clean-state-required']);
  }
});

test('cancelled, unsupported and truncated VT52 controls are explicit and bounded', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/terminal-compat/vt52-stream.ts';
    const { Vt52Stream } = await import(/* @vite-ignore */ path);
    const values = ['\x1bY!\x18OK', '\x1bY!\x1aOK', '\x1bY!\x1bHOK', '\x1bF\x1bG\x1b=\x1b>\x1bZOK', '\x1bY中文', '\x1b', '\x1bY', '\x1bY!'];
    return values.map(value => {
      const input = new TextEncoder().encode('\x1b[?2l' + value);
      const run = (chunks: Uint8Array[]) => {
        const stream = new Vt52Stream();
        const results = chunks.map(chunk => stream.push(chunk));
        results.push(stream.finish());
        const again = stream.finish();
        return {
          output: results.flatMap(result => Array.from(result.output)),
          inputBytes: results.reduce((sum, result) => sum + result.inputBytes, 0),
          diagnostics: results.flatMap(result => result.diagnostics),
          again: { output: Array.from(again.output), inputBytes: again.inputBytes, diagnostics: again.diagnostics },
        };
      };
      const whole = run([input]);
      return { value, length: input.length, whole, cuts: Array.from({ length: input.length + 1 }, (_, cut) => run([input.slice(0, cut), input.slice(cut)])) };
    });
  });
  for (const item of result) {
    for (const cut of item.cuts) expect(cut).toEqual(item.whole);
    expect(item.whole.inputBytes).toBe(item.length);
    expect(item.whole.again).toEqual({ output: [], inputBytes: 0, diagnostics: [] });
  }
  for (const index of [0, 1, 2]) expect(result[index].whole.diagnostics.map(item => item.code)).toEqual(['clean-state-required', 'cancelled']);
  expect(result[3].whole.diagnostics.filter(item => item.code === 'unsupported')).toHaveLength(5);
  expect(new TextDecoder().decode(new Uint8Array(result[3].whole.output))).toBe('\x1b[?2lOK');
  expect(result[4].whole.diagnostics.map(item => item.code)).toEqual(['clean-state-required', 'invalid-coordinate']);
  expect(new TextDecoder().decode(new Uint8Array(result[4].whole.output))).toBe('\x1b[?2l\x1bY中文');
  for (const index of [5, 6, 7]) {
    expect(result[index].whole.diagnostics.map(item => item.code)).toEqual(['clean-state-required', 'truncated']);
    expect(new TextDecoder().decode(new Uint8Array(result[index].whole.output))).toBe('\x1b[?2l' + result[index].value);
  }
});

test('CSI recognition has a 128-byte ceiling and resets after long or incomplete input', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/terminal-compat/vt52-stream.ts';
    const { Vt52Stream } = await import(/* @vite-ignore */ path);
    const encoder = new TextEncoder();
    const source = '\x1b[' + '1'.repeat(100_000) + 'mDONE\x1b[?2l\x1bH';
    const stream = new Vt52Stream();
    const pieces = [];
    const input = encoder.encode(source);
    for (let offset = 0; offset < input.length; offset += 127) pieces.push(stream.push(input.slice(offset, offset + 127)));
    pieces.push(stream.finish());
    const incomplete = stream.push(encoder.encode('\x1b[?2'));
    const finished = stream.finish();
    const reuse = stream.push(encoder.encode('\x1bY!#'));
    stream.push(encoder.encode('\x1b[?2l\x1bY!'));
    stream.reset();
    const reset = stream.push(encoder.encode('SAFE\x1bY!#'));
    const limits = [127, 128].map(count => new Vt52Stream().push(encoder.encode('\x1b[' + '1'.repeat(count) + 'm')).diagnostics);
    return {
      output: new TextDecoder().decode(Uint8Array.from(pieces.flatMap(piece => Array.from(piece.output)))),
      expected: source.slice(0, -2) + '\x1b[H',
      diagnostics: pieces.flatMap(piece => piece.diagnostics),
      total: pieces.reduce((sum, piece) => sum + piece.inputBytes, 0), length: input.length,
      incomplete: Array.from(incomplete.output), finished: { output: Array.from(finished.output), diagnostics: finished.diagnostics },
      reuse: Array.from(reuse.output), reset: Array.from(reset.output), limits,
    };
  });
  expect(result.output).toBe(result.expected);
  expect(result.total).toBe(result.length);
  expect(result.diagnostics.map(item => item.code)).toEqual(['csi-limit', 'clean-state-required']);
  expect(result.incomplete).toEqual(Array.from(new TextEncoder().encode('\x1b[?2')));
  expect(result.finished.output).toEqual([]);
  expect(result.finished.diagnostics.map(item => item.code)).toEqual(['truncated']);
  expect(new TextDecoder().decode(new Uint8Array(result.reuse))).toBe('\x1bY!#');
  expect(new TextDecoder().decode(new Uint8Array(result.reset))).toBe('SAFE\x1bY!#');
  expect(result.limits[0]).toEqual([]);
  expect(result.limits[1].map(item => item.code)).toEqual(['csi-limit']);
});

test('unsupported identity request never fabricates a device response in real xterm', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const adapterPath = '/src/terminal-compat/vt52-stream.ts';
    const xtermPath = '/node_modules/@xterm/xterm/lib/xterm.mjs';
    const { Vt52Stream } = await import(/* @vite-ignore */ adapterPath);
    const { Terminal } = await import(/* @vite-ignore */ xtermPath);
    const terminal = new Terminal();
    let response = '';
    const listener = terminal.onData((data: string) => response += data);
    const result = new Vt52Stream().push(new TextEncoder().encode('\x1b[?2l\x1bZ'));
    await new Promise<void>(resolve => terminal.write(result.output, resolve));
    listener.dispose(); terminal.dispose();
    return { response, diagnostics: result.diagnostics };
  });
  expect(result.response).toBe('');
  expect(result.diagnostics.map(item => item.code)).toEqual(['clean-state-required', 'unsupported']);
});
