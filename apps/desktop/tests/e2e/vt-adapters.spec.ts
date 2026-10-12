import { test, expect, type Page } from '@playwright/test';
import { ESC, ST, installHarness, run, type Harness } from './support/vt-harness';

// Focused checks of the production VT adapters (src/terminal-compat/vt-adapters.ts) on a real
// @xterm/xterm 6.0.0 in Chrome. They cover parameter validation, shadow-state drift and the OSC 52
// policy; they do not prove WKWebView/WebView2 clipboard access or vttest conformance.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(installHarness);
});

/** Hand test data to page-side bodies, which `run` serialises without closures. */
async function share(page: Page, value: unknown) {
  await page.evaluate(v => { (window as unknown as { vtShared: unknown }).vtShared = v; }, value);
}

test.describe('terminal identity', () => {
  test('every type answers 7-bit identity replies; XTVERSION follows package.json', async ({ page }) => {
    const version = ((await (await page.request.get('/package.json')).json()) as { version: string }).version;
    const replies: Record<string, string[]> = {};
    for (const terminalType of ['xterm-256color', 'vt100', 'vt220', 'vt420', 'vt520']) {
      replies[terminalType] = await run(page, async h => {
        const out: string[] = [];
        for (const q of ['\x1b[c', '\x1b[>c', '\x1b[=c', '\x1b[>0q', `\x1bP$q"p${'\x1b\\'}`]) out.push(await h.query(q));
        return out;
      }, { vt: { terminalType } });
    }
    expect(replies['xterm-256color']).toEqual([
      `${ESC}[?1;2c`, `${ESC}[>0;276;0c`, '', `${ESC}P>|new-windterm(${version})${ST}`, `${ESC}P1$r61;1"p${ST}`,
    ]);
    expect(replies.vt100).toEqual([`${ESC}[?1;2c`, '', '', '', `${ESC}P1$r61;1"p${ST}`]);
    expect(replies.vt220).toEqual([`${ESC}[?62;6;9;22c`, `${ESC}[>1;10;0c`, '', '', `${ESC}P1$r62;1"p${ST}`]);
    expect(replies.vt420).toEqual([`${ESC}[?64;6;9;22c`, `${ESC}[>41;10;0c`, `${ESC}P!|00000000${ST}`, '', `${ESC}P1$r64;1"p${ST}`]);
    expect(replies.vt520).toEqual([`${ESC}[?65;6;9;22c`, `${ESC}[>64;10;0c`, `${ESC}P!|00000000${ST}`, '', `${ESC}P1$r65;1"p${ST}`]);
    expect(Object.values(replies).flat().join('')).toMatch(/^[\x00-\x7f]*$/); // no 8-bit C1 (S8C1T unsupported)
  });

  test('identity requests with a non-zero parameter are swallowed, never answered by the built-ins', async ({ page }) => {
    const observed = await run(page, async h => {
      let out = '';
      for (const q of ['\x1b[1c', '\x1b[>1c', '\x1b[=1c', '\x1b[>1q', '\x1b[2147483647c']) out += await h.query(q);
      return out;
    }, { vt: { terminalType: 'vt520' } });
    expect(observed).toBe('');
  });

  test('unknown terminal types fall back to xterm-256color; switching types resets the level', async ({ page }) => {
    const observed = await run(page, async h => {
      const level = `\x1bP$q"p${'\x1b\\'}`;
      const unknown = { type: h.vt!.terminalType, da1: await h.query('\x1b[c') };
      h.vt!.setTerminalType('vt420');
      await h.write('\x1b[62"p');
      const lowered = await h.query(level);
      h.vt!.setTerminalType('<script>' as string);
      const fallback = { type: h.vt!.terminalType, level: await h.query(level) };
      h.vt!.setTerminalType('vt420');
      return { unknown, lowered, fallback, switched: await h.query(level) };
    }, { vt: { terminalType: 'vt999' } });
    expect(observed).toEqual({
      unknown: { type: 'xterm-256color', da1: `${ESC}[?1;2c` },
      lowered: `${ESC}P1$r62;1"p${ST}`,
      fallback: { type: 'xterm-256color', level: `${ESC}P1$r61;1"p${ST}` },
      switched: `${ESC}P1$r64;1"p${ST}`,
    });
  });

  test('DECSCL accepts only levels 61..ceiling of the type; DECSTR keeps the level, RIS restores it', async ({ page }) => {
    const observed = await run(page, async h => {
      const level = async () => (await h.query(`\x1bP$q"p${'\x1b\\'}`)).slice(5, 7);
      const out: string[] = [];
      for (const q of ['\x1b[60"p', '\x1b[65"p', '\x1b[2147483647"p', '\x1b[0"p', '\x1b["p', '\x1b[;61"p', '\x1b[61"p', '\x1b[!p']) {
        await h.write(q);
        out.push(await level());
      }
      await h.write('\x1bc');
      out.push(await level());
      return out;
    }, { vt: { terminalType: 'vt420' } });
    expect(observed).toEqual(['64', '64', '64', '64', '64', '64', '61', '61', '64']);
  });
});

test.describe('DECRQSS SGR shadow', () => {
  // Each case is written, then the DECRQSS report is replayed on raw xterm.js: both cells must
  // carry the same attributes and the DOM renderer must draw the same underline.
  const cases = [
    '', '\x1b[1;31m', '\x1b[2;3;4;5;7;8;9;53m', '\x1b[1;2;22;23m', '\x1b[91;104m', '\x1b[38;5;196;48;5;21m',
    '\x1b[38;2;1;2;3;48;2;250;128;0m', '\x1b[38:2::10:20:30m', '\x1b[38:2:9:40:50:60m', '\x1b[38:2:1:2:3m', '\x1b[38:5:202m',
    '\x1b[4:3;58:2::255:0:0m', '\x1b[4:5;58;5;9m', '\x1b[21m', '\x1b[4:0m', '\x1b[4;24m', '\x1b[58:2::1:2:3m',
    '\x1b[1;31;0;32m', '\x1b[31;39;41;49m', '\x1b[6m', '\x1b[38;5m', '\x1b[38;2;1;2m', '\x1b[38;9;1m',
    '\x1b[4:7m', '\x1b[4:m', '\x1b[100;37m', '\x1b[53;55m', '\x1b[38;5;3m',
    '\x1b[1;31m\x1b7\x1b[0;32m\x1b8', '\x1b[1;31m\x1b[s\x1b[0m\x1b[u', '\x1b[1;31m\x1b[?1048h\x1b[0m\x1b[?1048l',
    '\x1b[1;31m\x1b[?1049h\x1b[0;32m\x1b[?1049l', '\x1b[?1049h\x1b[33m\x1b7\x1b[0m\x1b8', '\x1b[1m\x1b[?1047h\x1b[0m\x1b[?1047l',
    '\x1b[1;31m\x1b[!p', '\x1b[1;31m\x1b7\x1b[!p\x1b8', '\x1b[1;4:3;31m\x1bc', '\x1b[4:3;58:5:2m\x1b7\x1b[4:4m\x1b8',
  ];

  test('reports replay to the same rendition on raw xterm.js', async ({ page }) => {
    await share(page, cases);
    const results = await run(page, async h => {
      const raw = await (window as unknown as { vtHarness(o: unknown): Promise<Harness> }).vtHarness({ vt: false });
      const look = async (target: Harness) => {
        await target.frame();
        const span = target.spans(0)[0];
        return {
          ...target.cell(0, 0), underline: undefined,
          drawn: span?.className.split(' ').filter(c => c.startsWith('xterm-underline')).join() ?? '',
          decoration: span?.decorationColor ?? '',
        };
      };
      const out = [];
      try {
        for (const sequence of (window as unknown as { vtShared: string[] }).vtShared) {
          await h.write(`\x1bc${sequence}X`);
          const original = await look(h);
          const report = await h.query(`\x1bP$qm${'\x1b\\'}`);
          const rendition = report.slice(5, -2); // "0;1;31m" from ESC P 1 $ r … m ESC \\
          await raw.write(`\x1bc\x1b[${rendition}X`);
          out.push({ sequence: JSON.stringify(sequence), report: JSON.stringify(report), original, replayed: await look(raw) });
        }
      } finally {
        raw.dispose();
      }
      return out;
    }, { cols: 10, rows: 3 });
    for (const { sequence, report, original, replayed } of results) {
      expect(report, sequence).toMatch(/^"\\u001bP1\$r0[0-9;:]*m\\u001b\\\\"$/);
      expect(replayed, `${sequence} -> ${report}`).toEqual(original);
    }
  });

  test('edge cases: DECRC over a cleared underline style, and SGR 59 (reported as requested)', async ({ page }) => {
    const observed = await run(page, async h => {
      const request = `\x1bP$qm${'\x1b\\'}`;
      await h.write('\x1b[4:3m\x1b7\x1b[24m\x1b8');
      const restored = await h.query(request);
      await h.write('\x1bc\x1b[4:2;58:5:1;59mX');
      await h.frame();
      return { restored, reset: await h.query(request), drawn: h.spans(0)[0]?.decorationColor };
    });
    // xterm's getUnderlineStyle() ignores the restored flag once the style is 0, so nothing is drawn or reported.
    expect(observed.restored).toBe(`${ESC}P1$r0m${ST}`);
    // Known xterm.js 6.0.0 quirk: SGR 59 stores -1 masked to RGB ffffff, so it draws a white underline;
    // the report keeps the requested default colour (no 58) instead of mirroring that.
    expect(observed).toMatchObject({ reset: `${ESC}P1$r0;21m${ST}`, drawn: 'rgb(255, 255, 255)' });
  });
});

test.describe('DECRQSS DECSCUSR shadow', () => {
  test('tracks style, blink-only parameters, DECSTR and RIS; unset falls back to the options', async ({ page }) => {
    const observed = await run(page, async h => {
      const ask = () => h.query(`\x1bP$q q${'\x1b\\'}`);
      const out = [await ask()];
      for (const q of ['\x1b[2 q', '\x1b[4 q', '\x1b[7 q', '\x1b[8 q', '\x1b[2147483647 q', '\x1b[!p', '\x1b[6 q', '\x1bc', '\x1b[3 q', '\x1b[0 q']) {
        await h.write(q);
        out.push(await ask());
      }
      return out.map(r => r.slice(5, -4));
    }, { options: { cursorStyle: 'bar', cursorBlink: true } });
    expect(observed).toEqual(['5', '2', '4', '3', '4', '3', '5', '6', '5', '3', '5']);
  });
});

test.describe('CPR under DECOM', () => {
  test('margins are tracked per buffer and reset by DECSTR, resize and leaving the alternate screen', async ({ page }) => {
    const observed = await run(page, async h => {
      const cpr = () => h.query('\x1b[6n');
      const out: Record<string, string> = {};
      await h.write('\x1b[2;5r\x1b[?1049h\x1b[?6h');
      out.altFull = await cpr();
      await h.write('\x1b[3;6r\x1b[?6h\x1b[2;1H');
      out.altRegion = await cpr();
      await h.write('\x1b[?1049l\x1b[?6h');
      out.normalRegion = await cpr();
      await h.write('\x1b[?1049h\x1b[?6h');
      out.altCleared = await cpr();
      await h.write('\x1b[?1049l\x1b[!p\x1b[?6h\x1b[3;1H');
      out.afterDecstr = await cpr();
      await h.write('\x1b[3;5r\x1b[?6h');
      h.term.resize(20, 8);
      await h.write('\x1b[4;1H');
      out.afterResize = await cpr();
      for (const q of ['\x1b[5;3r', '\x1b[2147483647r', '\x1b[3;99r']) await h.write(q);
      await h.write('\x1b[?6h');
      out.clampedRegion = await cpr() + await h.query('\x1bP$qr\x1b\\');
      return out;
    }, { cols: 20, rows: 6 });
    expect(observed).toEqual({
      altFull: `${ESC}[1;1R`, altRegion: `${ESC}[2;1R`, normalRegion: `${ESC}[1;1R`, altCleared: `${ESC}[1;1R`,
      afterDecstr: `${ESC}[3;1R`, afterResize: `${ESC}[4;1R`, clampedRegion: `${ESC}[1;1R${ESC}P1$r3;8r${ST}`,
    });
  });
});

test.describe('OSC 52 policy', () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const b64 = (text: string) => btoa(String.fromCharCode(...utf8(text)));

  test('without opt-in writes (even malformed ones) are swallowed with one notice and nothing reaches the clipboard', async ({ page }) => {
    const observed = await run(page, async h => {
      const replies = await h.query('\x1b]52;c;aGVsbG8=\x07\x1b]52;c;aGVsbG8=\x1b\\\x1b]52;x;!!\x07\x1b]52;p;?\x07');
      await h.frame();
      return { replies, clipboard: h.clipboard, notices: h.notices, line: h.lines()[0], cursor: h.cursor() };
    });
    expect(observed).toEqual({
      replies: '', clipboard: [], notices: [{ kind: 'clipboard-blocked' }, { kind: 'clipboard-read-denied' }],
      line: '', cursor: { x: 0, y: 0 },
    });
  });

  test('opted-in writes decode UTF-8, never log or expose the content, and reads stay denied', async ({ page }) => {
    const secret = '机密 ✓\tline\r\nend';
    await share(page, b64(secret));
    const observed = await run(page, async h => {
      const logged: string[] = [];
      const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
      const originals = methods.map(m => console[m]);
      methods.forEach(m => { console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); }; });
      try {
        const payload = (window as unknown as { vtShared: string }).vtShared;
        const replies = await h.query(`\x1b]52;c;${payload}\x07\x1b]52;c;?\x07`);
        await h.frame();
        return { replies, clipboard: h.clipboard, notices: h.notices, logged };
      } finally {
        methods.forEach((m, i) => { console[m] = originals[i]; });
      }
    }, { vt: { clipboardWrite: true } });
    expect(observed.replies).toBe('');
    expect(observed.clipboard).toEqual([secret]);
    expect([...observed.notices].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: 'clipboard-read-denied' }, { kind: 'clipboard-written', bytes: utf8(secret).length },
    ]);
    expect(JSON.stringify(observed.notices) + observed.logged.join('\n')).not.toContain('机密');
  });

  test('malformed, unsafe and oversized payloads are rejected; exactly 1 MiB of base64 is accepted', async ({ page }) => {
    const exact = 'YWFh'.repeat(256 * 1024); // 1 MiB of base64, 768 KiB of "a"
    const rejected = [
      'c;!!!!', 'c;aGVsbG8', 'x;aGVsbG8=', 'aGVsbG8=', 'c;', `c;${b64('\x1b[1m')}`, `c;${b64('a\u009bb')}`, `c;${b64('a\x7f')}`,
      'c;/w==', 'c;aGVs=G8=', `${'c'.repeat(17)};aGVsbG8=`, `c;${exact}YWFh`,
    ];
    await share(page, [exact, rejected]);
    const observed = await run(page, async h => {
      const [exactPayload, bad] = (window as unknown as { vtShared: [string, string[]] }).vtShared;
      const kinds: string[] = [];
      for (const data of bad) {
        h.vt!.setClipboardWrite(true); // re-arms the once-per-state notices
        await h.write(`\x1b]52;${data}\x07`);
        await h.frame();
        kinds.push(h.notices.splice(0).map(n => JSON.stringify(n)).join());
      }
      await h.write(`\x1b]52;c;${exactPayload}\x07`);
      await h.frame();
      return { kinds, clipboard: h.clipboard.map(t => t.length), notices: h.notices };
    }, { vt: { clipboardWrite: true } });
    expect(observed.kinds).toEqual([
      ...Array(11).fill('{"kind":"clipboard-rejected","reason":"invalid"}'),
      '{"kind":"clipboard-rejected","reason":"too-large"}',
    ]);
    expect(observed.clipboard).toEqual([768 * 1024]);
    expect(observed.notices).toEqual([{ kind: 'clipboard-written', bytes: 768 * 1024 }]);
  });

  test('writes in one chunk keep at most one waiting write; withdrawing the opt-in drops it', async ({ page }) => {
    const observed = await run(page, async h => {
      h.term.parser.registerOscHandler(7777, () => { h.vt!.setClipboardWrite(false); return true; });
      const one = (t: string) => `\x1b]52;c;${btoa(t)}\x07`;
      await h.write(one('aaa') + one('bbb') + one('ccc'));
      await h.frame();
      const coalesced = [...h.clipboard];
      h.vt!.setClipboardWrite(true);
      await h.write(one('ddd') + one('eee') + '\x1b]7777;x\x07');
      await h.frame();
      return { coalesced, after: h.clipboard.slice(coalesced.length), enabled: h.vt!.clipboardWrite };
    }, { vt: { clipboardWrite: true } });
    expect(observed).toEqual({ coalesced: ['aaa', 'ccc'], after: [], enabled: false });
  });
});

test('dispose removes every adapter hook and restores the raw xterm.js replies', async ({ page }) => {
  const observed = await run(page, async h => {
    await h.write('\x1b[1;31m\x1b[3;5r\x1b[?6h');
    h.vt!.dispose();
    h.vt!.dispose(); // idempotent
    let out = '';
    for (const q of ['\x1b[=c', '\x1b[c', `\x1bP$qm${'\x1b\\'}`, '\x1b[6n']) out += await h.query(q);
    await h.write('\x1b]52;c;aGVsbG8=\x07');
    await h.frame();
    return { out, clipboard: h.clipboard, notices: h.notices };
  }, { vt: { terminalType: 'vt420', clipboardWrite: true } });
  expect(observed).toEqual({ out: `${ESC}[?1;2c${ESC}P1$r0m${ST}${ESC}[3;1R`, clipboard: [], notices: [] });
});
