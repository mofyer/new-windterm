import { test, expect, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';

// Measurement-only P0 baseline. Headless Chrome + Vite dev server + IPC stub:
// this is NOT WKWebView, Tauri IPC, JSON transport, or a Rust PTY. Assertions
// only guard result validity (ACK order, chunk counts, parser state); there are
// no performance thresholds. Results are appended to test-results/perf/*.jsonl.
const RUNS = Number(process.env.PERF_RUNS ?? 3);
const PAYLOAD_BYTES = 10 * 1024 * 1024;
const CHUNK = 4096; // Rust PtyEvent::Data block size
const WINDOW = 16; // 16 x 4096 B = the Rust 64 KiB unacknowledged byte budget
const OUT = fileURLToPath(new URL('../../test-results/perf/', import.meta.url));
const KINDS = ['ascii', 'mixed'] as const;
type Kind = (typeof KINDS)[number];
type Metrics = Record<string, number>;
const STATUS_IDS = ['terminal-state', 'terminal-size', 'session-detail', 'sample-run', 'stress-run'];

function record(group: string, metrics: Metrics, browserVersion: string): void {
  mkdirSync(OUT, { recursive: true });
  const line = { group, metrics: { ...metrics, system_load1: loadavg()[0] }, browserVersion, at: new Date().toISOString() };
  appendFileSync(`${OUT}xterm-perf.jsonl`, `${JSON.stringify(line)}\n`);
}

// Deterministic payloads, generated inside the page outside the timed region.
async function installPayload(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__perfPayload = (kind: string, total: number) => {
      const encoder = new TextEncoder();
      const out = new Uint8Array(total);
      const ascii = Array.from({ length: 95 }, (_, i) =>
        encoder.encode(Array.from({ length: 78 }, (_, c) => String.fromCharCode(0x20 + ((i + c) % 95))).join('') + '\r\n'));
      let offset = 0;
      let lines = 0;
      for (;;) {
        // Mixed: SGR bold/256-color/truecolor, CJK, Hangul, fullwidth Latin,
        // emoji incl. skin tone and ZWJ family, and a combining accent.
        const bytes = kind === 'ascii' ? ascii[lines % 95] : encoder.encode(
          `\x1b[1;31m中文宽字符测试\x1b[0m \x1b[38;5;${lines % 256}memoji 🙂🚀👍🏽👨‍👩‍👧\x1b[0m `
          + `\x1b[48;2;${lines % 256};64;128m真彩色 truecolor\x1b[0m ｆｕｌｌ 한국어 é ${lines}\r\n`);
        if (offset + bytes.length > total) break;
        out.set(bytes, offset);
        offset += bytes.length;
        lines++;
      }
      out.fill(0x78, offset); // pad with ASCII 'x' to the exact size
      return { bytes: out, lines, padding: total - offset };
    };
  });
}

// Same xterm factory as the app (Unicode 11, screenReaderMode, scrollback 5000),
// fed in 4096 B Uint8Array chunks with at most 16 chunks outstanding.
async function runCore(page: Page, kind: Kind, open: boolean) {
  await installPayload(page);
  await page.goto('/');
  await expect(page.locator('#local-open')).toBeVisible();
  return page.evaluate(async ({ kind, total, chunk, maxOutstanding, open }) => {
    const { createWorkspaceTerminal } = await import('/src/terminal.ts');
    const { bytes, lines, padding } = (window as any).__perfPayload(kind, total);
    const terminal = createWorkspaceTerminal();
    let host: HTMLDivElement | undefined;
    if (open) {
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:1100px;height:700px;z-index:2147483647;background:#fff';
      document.body.append(host);
      terminal.open(host);
    }
    terminal.resize(120, 36);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const chunks = Math.ceil(bytes.length / chunk);
    let maxSeen = 0;
    const started = performance.now();
    await new Promise<void>((resolve) => {
      let sent = 0;
      let done = 0;
      const pump = () => {
        while (sent < chunks && sent - done < maxOutstanding) {
          const index = sent++;
          maxSeen = Math.max(maxSeen, sent - done);
          terminal.write(bytes.subarray(index * chunk, Math.min(bytes.length, (index + 1) * chunk)), () => {
            done++;
            if (done === chunks) resolve();
            else pump();
          });
        }
      };
      pump();
    });
    const elapsedMs = performance.now() - started;
    // Validity: the parser is back in ground state and still accepts output.
    await new Promise<void>((resolve) => terminal.write('\x1b[0m\r\nPERF_DONE', resolve));
    const buffer = terminal.buffer.active;
    const tail = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
    terminal.dispose();
    host?.remove();
    return { elapsedMs, chunks, lines, padding, tail, maxSeen };
  }, { kind, total: PAYLOAD_BYTES, chunk: CHUNK, maxOutstanding: WINDOW, open });
}

// Real main.ts pipeline (Channel callback -> xterm.write -> ordered pty_ack ->
// coalesced status) with a bounded IPC stub, as in tests/e2e/responsiveness.spec.ts.
async function installAppStub(page: Page): Promise<void> {
  await page.addInitScript(({ maxOutstanding }) => {
    const state: any = {
      channel: null, chunks: [], sent: 0, acknowledged: 0, running: false, ackOrder: true,
      maxOutstanding: 0, start: 0, elapsed: 0, onDone: null,
    };
    state.pump = () => {
      while (state.running && state.sent < state.chunks.length && state.sent - state.acknowledged < maxOutstanding) {
        const sequence = ++state.sent;
        state.maxOutstanding = Math.max(state.maxOutstanding, state.sent - state.acknowledged);
        state.channel.onmessage({ kind: 'data', id: 'perf-pty', sequence, data: state.chunks[sequence - 1] });
      }
    };
    Object.assign(window, {
      isTauri: true,
      perfStub: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (command: string, args: any) => {
          if (command === 'pty_open') {
            state.channel = args.onEvent;
            return Promise.resolve({ id: 'perf-pty' });
          }
          if (command === 'pty_ack') {
            state.ackOrder &&= args.sequence === state.acknowledged + 1;
            state.acknowledged = args.sequence;
            if (state.running && state.acknowledged === state.chunks.length) {
              state.running = false;
              state.elapsed = performance.now() - state.start;
              state.onDone?.();
            } else queueMicrotask(state.pump);
          }
          return Promise.resolve(null);
        },
      },
    });
  }, { maxOutstanding: WINDOW });
}

type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
};

// Inclusive sampled time (ms) of named functions, plus busy (non-idle) time.
function profileTimes(profile: CpuProfile, names: string[]) {
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const nameOf = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const totals: Metrics = Object.fromEntries(names.map((name) => [name, 0]));
  let busy = 0;
  profile.samples.forEach((id, index) => {
    const duration = (profile.timeDeltas[index + 1] ?? 0) / 1000;
    if (nameOf.get(id) === '(idle)') return;
    busy += duration;
    const seen = new Set<string>();
    for (let node: number | undefined = id; node !== undefined; node = parent.get(node)) {
      const name = nameOf.get(node) ?? '';
      if (totals[name] !== undefined && !seen.has(name)) {
        seen.add(name);
        totals[name] += duration;
      }
    }
  });
  return { busy, totals, wall: (profile.endTime - profile.startTime) / 1000 };
}

async function runApp(page: Page, kind: Kind, profiled: boolean) {
  await installPayload(page);
  await installAppStub(page);
  await page.goto('/?p0Diagnostics');
  await page.locator('#local-open').click();
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  const before = await page.evaluate(({ kind, total, chunk, ids }) => {
    const state = (window as any).perfStub;
    const { bytes } = (window as any).__perfPayload(kind, total);
    // number[] chunks mirror the deserialized Channel payload the app receives.
    for (let offset = 0; offset < bytes.length; offset += chunk) state.chunks.push(Array.from(bytes.subarray(offset, offset + chunk)));
    state.mutations = Object.fromEntries(ids.map((id: string) => [id, 0]));
    const observer = new MutationObserver((records) => {
      for (const item of records) {
        const target = item.target instanceof Element ? item.target : item.target.parentElement;
        const id = ids.find((candidate: string) => target?.closest(`#${candidate}`));
        if (id) state.mutations[id]++;
      }
    });
    for (const id of ids) {
      observer.observe(document.getElementById(id)!, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    }
    return (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot();
  }, { kind, total: PAYLOAD_BYTES, chunk: CHUNK, ids: STATUS_IDS });
  const cdp = profiled ? await page.context().newCDPSession(page) : undefined;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }
  await page.evaluate(() => new Promise<void>((resolve) => {
    const state = (window as any).perfStub;
    state.onDone = resolve;
    state.start = performance.now();
    state.running = true;
    state.pump();
  }));
  const profile = cdp ? ((await cdp.send('Profiler.stop')) as { profile: CpuProfile }).profile : undefined;
  // Let the at-most-one pending 100 ms status refresh land before counting.
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => {
    const state = (window as any).perfStub;
    return {
      elapsedMs: state.elapsed, chunks: state.chunks.length, acknowledged: state.acknowledged,
      ackOrder: state.ackOrder, maxOutstanding: state.maxOutstanding, mutations: state.mutations,
      after: (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot(),
      sizeText: document.getElementById('terminal-size')?.textContent ?? '',
    };
  });
  expect(result.ackOrder).toBe(true);
  expect(result.acknowledged).toBe(result.chunks);
  expect(result.maxOutstanding).toBeLessThanOrEqual(WINDOW);
  expect(result.after.parsedChunks - before.parsedChunks).toBe(result.chunks);
  expect(result.sizeText).toContain(`${PAYLOAD_BYTES.toLocaleString('en-US')} B`);
  return { ...result, before, profile };
}

test.describe.configure({ mode: 'serial' });

for (let run = 1; run <= RUNS; run++) {
  for (const kind of KINDS) {
    for (const open of [false, true]) {
      const mode = open ? 'opened' : 'no-renderer';
      test(`xterm core ${mode} ${kind} 10 MiB run ${run}`, async ({ page, browser }) => {
        const result = await runCore(page, kind, open);
        expect(result.tail).toContain('PERF_DONE');
        expect(result.maxSeen).toBeLessThanOrEqual(WINDOW);
        record(`xterm-core ${mode} ${kind}`, {
          elapsed_ms: result.elapsedMs,
          mib_s: PAYLOAD_BYTES / 1024 / 1024 / (result.elapsedMs / 1000),
          chunks: result.chunks,
        }, browser.version());
      });
    }
    test(`app stub pipeline ${kind} 10 MiB run ${run}`, async ({ page, browser }) => {
      const result = await runApp(page, kind, false);
      record(`app-stub ${kind}`, {
        elapsed_ms: result.elapsedMs,
        mib_s: PAYLOAD_BYTES / 1024 / 1024 / (result.elapsedMs / 1000),
        status_flushes: result.after.statusFlushes - result.before.statusFlushes,
        status_dom_mutations: Object.values(result.mutations as Record<string, number>).reduce((a, b) => a + b, 0),
        max_parse_wait_ms: result.after.maxParseWaitMs,
        max_ack_queue_wait_ms: result.after.maxAckQueueWaitMs,
      }, browser.version());
    });
    test(`app stub pipeline profiled ${kind} 10 MiB run ${run}`, async ({ page, browser }) => {
      const result = await runApp(page, kind, true);
      const times = profileTimes(result.profile!, ['updateStatus', 'scheduleStatusUpdate']);
      record(`app-stub-profiled ${kind}`, {
        elapsed_ms_with_profiler: result.elapsedMs,
        profile_busy_ms: times.busy,
        update_status_ms: times.totals.updateStatus,
        schedule_status_ms: times.totals.scheduleStatusUpdate,
        update_status_pct_of_busy: (100 * times.totals.updateStatus) / times.busy,
        status_flushes: result.after.statusFlushes - result.before.statusFlushes,
      }, browser.version());
    });
  }
}
