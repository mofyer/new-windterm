import { test, expect } from '@playwright/test';
import { ESC, ST, installHarness, probe, rawAndAdapted, run, type Harness } from './support/vt-harness';

// VT compatibility matrix for the exact @xterm/xterm 6.0.0 in package-lock.json plus the
// production adapters (src/terminal-compat/vt-adapters.ts), which the harness attaches by
// default exactly as the workspace factory does. Probes whose result the adapters change also
// record the raw xterm.js evidence (`vt: false`) next to the adapted result.
// Every probe drives a real, independent xterm in the page and asserts the behaviour observed
// today, so a dependency bump that changes it fails loudly. Titles carry the matrix status:
//   [supported]   behaves as the cited reference for the probed case;
//   [partial]     works only in part — the gap is named after "known gap:";
//   [unsupported] the sequence is ignored or answered incorrectly — "known gap:".
// A passing gap probe confirms a limitation; it never proves VT parity. vttest was NOT run.
// Results are documented in docs/p0/VT_MATRIX.zh-CN.md.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(installHarness);
});

test.describe('cursor movement and save/restore', () => {
  probe({
    id: 'C01', status: 'supported', title: 'CUP/CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA/HPR/VPR move the cursor and DSR 6 reports it',
    sequence: 'CSI 3;5 H, CSI 2 A, CSI 3 B, CSI 4 C, CSI 2 D, CSI E, CSI 2 F, CSI 7 G, CSI 5 d, CSI 2 a, CSI e, CSI 6 n',
    expected: 'ECMA-48 / VT100 cursor addressing; CPR CSI row;col R', features: ['T07', 'T12', 'T21'],
  }, page => run(page, async h => {
    const steps = ['\x1b[3;5H', '\x1b[2A', '\x1b[3B', '\x1b[4C', '\x1b[2D', '\x1b[E', '\x1b[2F', '\x1b[7G', '\x1b[5d', '\x1b[2a', '\x1b[e'];
    const positions = [];
    for (const step of steps) { await h.write(step); positions.push(h.cursor()); }
    return { positions, cpr: await h.query('\x1b[6n') };
  }), observed => {
    expect(observed.positions).toEqual([
      { x: 4, y: 2 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 8, y: 3 }, { x: 6, y: 3 }, { x: 0, y: 4 },
      { x: 0, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 5 },
    ]);
    expect(observed.cpr).toBe(`${ESC}[6;9R`);
  });

  probe({
    id: 'C02', status: 'supported', title: 'DECSC/DECRC (ESC 7 / ESC 8) restore position, SGR and the G0 charset',
    sequence: 'CSI 2;3 H, SGR 1;31, ESC ( 0, ESC 7, SGR 0, ESC ( B, CSI 5;10 H, ESC 8, "q"',
    expected: 'VT510 DECSC: saves cursor position, SGR attributes and character sets', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b[2;3H\x1b[1;31m\x1b(0\x1b7\x1b[0m\x1b(B\x1b[5;10H\x1b8q');
    return { cell: h.cell(2, 1), cursor: h.cursor() };
  }), observed => {
    expect(observed.cell).toMatchObject({ ch: '─', bold: true, fg: 'p16:1' });
    expect(observed.cursor).toEqual({ x: 3, y: 1 });
  });

  probe({
    id: 'C03', status: 'partial', title: 'DECSC/DECRC do not save origin mode (DECOM) or the autowrap flag',
    sequence: 'CSI 2;4 r, CSI ? 6 h, ESC 7, CSI ? 6 l, ESC 8, DECRQM ?6; CSI ? 7 l, ESC 7, CSI ? 7 h, ESC 8, DECRQM ?7',
    expected: 'VT510 DECSC also saves "State of origin mode (DECOM)" and "Wrap flag": ?6 -> 1 (set), ?7 -> 2 (reset)',
    features: ['T10', 'T11', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b[2;4r\x1b[?6h\x1b7\x1b[?6l\x1b8');
    const origin = await h.query('\x1b[?6$p');
    await h.write('\x1b[r\x1b[?7l\x1b7\x1b[?7h\x1b8');
    return { origin, wrap: await h.query('\x1b[?7$p') };
  }), observed => {
    expect(observed).toEqual({ origin: `${ESC}[?6;2$y`, wrap: `${ESC}[?7;1$y` });
  });

  probe({
    id: 'C04', status: 'supported', title: 'SCOSC/SCORC (CSI s / CSI u) restore the cursor position while DECLRMM is off',
    sequence: 'CSI 3;4 H, CSI s, CSI 1;1 H, "X", CSI u, "Y"',
    expected: 'xterm ctlseqs: CSI s saves cursor when DECLRMM is disabled (SCOSC); CSI u restores', features: ['T12'],
  }, page => run(page, async h => {
    await h.write('\x1b[3;4H\x1b[s\x1b[1;1HX\x1b[uY');
    return { lines: h.lines().slice(0, 3), cursor: h.cursor() };
  }), observed => {
    expect(observed).toEqual({ lines: ['X', '', '   Y'], cursor: { x: 4, y: 2 } });
  });
});

test.describe('scroll regions and origin mode', () => {
  probe({
    id: 'S01', status: 'supported', title: 'DECSTBM confines LF and RI scrolling to the region, homes the cursor and is reported by DECRQSS',
    sequence: 'CSI 2;4 r, LF at bottom margin, RI (ESC M) at top margin, DCS $ q r ST',
    expected: 'VT100 DECSTBM; DECRQSS reply DCS 1 $ r 2;4 r ST', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('1\r\n2\r\n3\r\n4\r\n5\r\n6\x1b[2;4r');
    const home = h.cursor();
    await h.write('\x1b[4;1H\n');
    const afterLf = h.lines();
    await h.write('\x1b[2;1H\x1bM');
    return { home, afterLf, afterRi: h.lines(), report: await h.query(`\x1bP$qr${'\x1b\\'}`) };
  }, { cols: 10, rows: 6 }), observed => {
    expect(observed.home).toEqual({ x: 0, y: 0 });
    expect(observed.afterLf).toEqual(['1', '3', '4', '', '5', '6']);
    expect(observed.afterRi).toEqual(['1', '', '3', '4', '5', '6']);
    expect(observed.report).toBe(`${ESC}P1$r2;4r${ST}`);
  });

  probe({
    id: 'S02', status: 'supported', title: 'DECOM origin mode makes CUP relative to the top margin and clamps it inside the region',
    sequence: 'CSI 3;5 r, CSI ? 6 h, CSI 2;3 H, CSI 9;1 H',
    expected: 'VT100 UG DECOM: origin at the top-left of the margins; cursor cannot leave them', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b[3;5r\x1b[?6h');
    const home = h.cursor();
    await h.write('\x1b[2;3H');
    const relative = h.cursor();
    await h.write('\x1b[9;1H');
    return { home, relative, clamped: h.cursor() };
  }), observed => {
    expect(observed).toEqual({ home: { x: 0, y: 2 }, relative: { x: 2, y: 3 }, clamped: { x: 0, y: 4 } });
  });

  probe({
    id: 'S03', status: 'supported', title: 'CPR and DECXCPR report the row relative to the top margin while DECOM is set (adapter)',
    sequence: 'CSI 3;5 r, CSI ? 6 h, CSI 1;1 H, CSI 6 n, CSI ? 6 n; CSI 2;4 H, CSI 6 n; CSI ? 6 l, CSI 4;2 H, CSI 6 n',
    expected: 'VT100 UG CPR: "The numbering of lines depends on the state of the Origin Mode (DECOM)" -> CSI 1;1 R',
    features: ['T07', 'T21'],
  }, page => rawAndAdapted(page, async (h: Harness) => {
    await h.write('\x1b[3;5r\x1b[?6h\x1b[1;1H');
    const home = await h.query('\x1b[6n');
    const xcpr = await h.query('\x1b[?6n');
    await h.write('\x1b[2;4H');
    const inside = await h.query('\x1b[6n');
    await h.write('\x1b[?6l\x1b[4;2H');
    return { home, xcpr, inside, absolute: await h.query('\x1b[6n') };
  }), observed => {
    // Raw xterm.js 6.0.0 reports the absolute row even under DECOM.
    expect(observed.raw).toEqual({ home: `${ESC}[3;1R`, xcpr: `${ESC}[?3;1R`, inside: `${ESC}[4;4R`, absolute: `${ESC}[4;2R` });
    expect(observed.adapted).toEqual({ home: `${ESC}[1;1R`, xcpr: `${ESC}[?1;1R`, inside: `${ESC}[2;4R`, absolute: `${ESC}[4;2R` });
  });

  probe({
    id: 'S04', status: 'unsupported', title: 'DECLRMM (?69) and DECSLRM left/right margins are not recognised',
    sequence: 'DECRQM ?69; CSI ? 69 h, CSI 3;6 s, CSI 1;3 H, "ABCDEFGH"',
    expected: 'VT420 DECSLRM: text wraps inside columns 3..6 ("ABCD" then "EFGH" on the next row)',
    features: ['T10', 'T11', 'T21'],
  }, page => run(page, async h => {
    const mode = await h.query('\x1b[?69$p');
    await h.write('\x1b[?69h\x1b[3;6s\x1b[1;3HABCDEFGH');
    return { mode, lines: h.lines().slice(0, 2), wrapped: h.wrapped(1) };
  }, { cols: 12, rows: 4 }), observed => {
    expect(observed).toEqual({ mode: `${ESC}[?69;0$y`, lines: ['  ABCDEFGH', ''], wrapped: false });
  });
});

test.describe('autowrap and reverse wrap', () => {
  probe({
    id: 'W01', status: 'supported', title: 'DECAWM wraps at the right edge and marks the continuation row as wrapped',
    sequence: '"0123456789AB" on a 10-column screen', expected: 'VT100 DECAWM set (default)', features: ['T07', 'T18', 'T21'],
  }, page => run(page, async h => {
    await h.write('0123456789AB');
    return { lines: h.lines().slice(0, 2), wrapped: h.wrapped(1), cursor: h.cursor() };
  }, { cols: 10, rows: 4 }), observed => {
    expect(observed).toEqual({ lines: ['0123456789', 'AB'], wrapped: true, cursor: { x: 2, y: 1 } });
  });

  probe({
    id: 'W02', status: 'partial', title: 'in the pending-wrap state the cursor and CPR report column cols+1',
    sequence: '"0123456789" on a 10-column screen, CSI 6 n',
    expected: 'DEC last-column flag: cursor stays on column 10, CPR CSI 1;10 R', features: ['T07', 'T18', 'T21'],
  }, page => run(page, async h => {
    await h.write('0123456789');
    return { cursor: h.cursor(), cpr: await h.query('\x1b[6n') };
  }, { cols: 10, rows: 4 }), observed => {
    expect(observed).toEqual({ cursor: { x: 10, y: 0 }, cpr: `${ESC}[1;11R` });
  });

  probe({
    id: 'W03', status: 'supported', title: 'DECAWM reset (CSI ? 7 l) overwrites the last column instead of wrapping',
    sequence: 'CSI ? 7 l, "0123456789AB" on a 10-column screen, CSI 6 n',
    expected: 'VT100 DECAWM reset: later characters replace the last column', features: ['T07', 'T18'],
  }, page => run(page, async h => {
    await h.write('\x1b[?7l0123456789AB');
    return { lines: h.lines().slice(0, 2), cursor: h.cursor(), cpr: await h.query('\x1b[6n') };
  }, { cols: 10, rows: 4 }), observed => {
    expect(observed.lines).toEqual(['012345678B', '']);
    // Same last-column cursor state as W02: column cols+1 is exposed even without autowrap.
    expect(observed.cursor).toEqual({ x: 10, y: 0 });
    expect(observed.cpr).toBe(`${ESC}[1;11R`);
  });

  probe({
    id: 'W04', status: 'partial', title: 'reverse wraparound (?45) only undoes soft wraps, not hard line ends',
    sequence: 'CSI ? 45 h, "0123456789AB", BS x3; CSI 3;1 H, BS',
    expected: 'xterm XTREVWRAP: BS at the left margin moves to the end of the previous line (xterm.js source states it deviates on purpose)',
    features: ['T12', 'T18', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b[?45h0123456789AB\b\b\b');
    const soft = h.cursor();
    await h.write('\x1b[3;1H\b');
    return { soft, hard: h.cursor() };
  }, { cols: 10, rows: 4 }), observed => {
    expect(observed).toEqual({ soft: { x: 9, y: 0 }, hard: { x: 0, y: 2 } });
  });
});

test.describe('insert / delete / repeat (VT102 and later)', () => {
  probe({
    id: 'E01', status: 'supported', title: 'IL/DL insert and delete lines inside the scroll region',
    sequence: 'CSI 2;5 r, CSI 3;1 H, CSI L, CSI 2 M', expected: 'VT102 IL/DL limited to the scroll region',
    features: ['T26', 'T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('1\r\n2\r\n3\r\n4\r\n5\r\n6\x1b[2;5r\x1b[3;1H\x1b[L');
    const inserted = h.lines();
    await h.write('\x1b[2M');
    return { inserted, deleted: h.lines() };
  }, { cols: 10, rows: 6 }), observed => {
    expect(observed.inserted).toEqual(['1', '2', '', '3', '4', '6']);
    expect(observed.deleted).toEqual(['1', '2', '4', '', '', '6']);
  });

  probe({
    id: 'E02', status: 'supported', title: 'ICH/DCH/ECH insert, delete and erase characters in place',
    sequence: '"ABCDEF", CSI 1;3 H, CSI 2 @, CSI 3 P, CSI 2 X', expected: 'VT102 ICH/DCH, VT220 ECH', features: ['T26', 'T08'],
  }, page => run(page, async h => {
    await h.write('ABCDEF\x1b[1;3H\x1b[2@');
    const ich = h.lines()[0];
    await h.write('\x1b[3P');
    const dch = h.lines()[0];
    await h.write('\x1b[2X');
    return { ich, dch, ech: h.lines()[0], cursor: h.cursor() };
  }), observed => {
    expect(observed).toEqual({ ich: 'AB  CDEF', dch: 'ABDEF', ech: 'AB  F', cursor: { x: 2, y: 0 } });
  });

  probe({
    id: 'E03', status: 'supported', title: 'IRM insert mode (CSI 4 h) shifts text and LNM (CSI 20 h) makes LF return to column 1',
    sequence: '"ABC", CR, CSI 4 h, "XY", CSI 4 l, DECRQM 4; CSI 20 h, LF',
    expected: 'ECMA-48 IRM and LNM', features: ['T26', 'T07'],
  }, page => run(page, async h => {
    await h.write('ABC\r\x1b[4hXY\x1b[4l');
    const irm = { line: h.lines()[0], mode: await h.query('\x1b[4$p') };
    await h.write('\x1b[20hab\ncd');
    return { irm, lnm: { lines: h.lines().slice(0, 2), mode: await h.query('\x1b[20$p') } };
  }), observed => {
    expect(observed.irm).toEqual({ line: 'XYABC', mode: `${ESC}[4;2$y` });
    // The cursor was left after "XY", so "ab" overwrites; LF then returns to column 1.
    expect(observed.lnm).toEqual({ lines: ['XYabC', 'cd'], mode: `${ESC}[20;1$y` });
  });

  probe({
    id: 'E04', status: 'supported', title: 'REP (CSI b) repeats the preceding graphic character',
    sequence: '"A", CSI 3 b', expected: 'ECMA-48 REP (xterm)', features: ['T12'],
  }, page => run(page, async h => {
    await h.write('A\x1b[3b');
    return { line: h.lines()[0], cursor: h.cursor() };
  }), observed => {
    expect(observed).toEqual({ line: 'AAAA', cursor: { x: 4, y: 0 } });
  });

  probe({
    id: 'E05', status: 'supported', title: 'DECSCA protected characters survive DECSEL but not EL (VT220 selective erase)',
    sequence: 'CSI 1 " q, "PP", CSI 0 " q, "xx", CR, CSI ? 2 K, then CSI 2 K',
    expected: 'VT220 DECSCA + DECSEL keep protected cells; EL erases everything', features: ['T08'],
  }, page => run(page, async h => {
    await h.write('\x1b[1"qPP\x1b[0"qxx\r\x1b[?2K');
    const selective = h.lines()[0];
    await h.write('\x1b[2K');
    return { selective, normal: h.lines()[0] };
  }), observed => {
    expect(observed).toEqual({ selective: 'PP', normal: '' });
  });

  probe({
    id: 'E06', status: 'supported', title: 'DECIC/DECDC insert and delete columns (VT420)',
    sequence: '"ABCD" CRLF "EFGH", CSI 1;2 H, CSI \' }, CSI \' ~', expected: 'VT420 DECIC/DECDC across the scroll region',
    features: ['T10'],
  }, page => run(page, async h => {
    await h.write("ABCD\r\nEFGH\x1b[1;2H\x1b['}");
    const inserted = h.lines().slice(0, 2);
    await h.write("\x1b['~");
    return { inserted, deleted: h.lines().slice(0, 2) };
  }, { cols: 10, rows: 3 }), observed => {
    expect(observed).toEqual({ inserted: ['A BCD', 'E FGH'], deleted: ['ABCD', 'EFGH'] });
  });

  probe({
    id: 'E07', status: 'unsupported', title: 'VT420 rectangular operations DECFRA/DECERA/DECCRA are ignored',
    sequence: 'CSI 88;1;1;2;2 $ x (DECFRA), CSI 1;3;2;4 $ z (DECERA), CSI 1;1;1;2;;3;1;1 $ v (DECCRA)',
    expected: 'VT420: fill "XX"/"XX", erase columns 3-4, copy the block', features: ['T10', 'T11', 'T21'],
  }, page => run(page, async h => {
    await h.write('ABCD\r\nEFGH\x1b[88;1;1;2;2$x\x1b[1;3;2;4$z\x1b[1;1;1;2;;3;1;1$v');
    return h.lines().slice(0, 3);
  }, { cols: 10, rows: 3 }), observed => {
    expect(observed).toEqual(['ABCD', 'EFGH', '']);
  });
});

test.describe('tab stops', () => {
  probe({
    id: 'B01', status: 'supported', title: 'default 8-column tabs, HTS/TBC set and clear stops, CHT/CBT move between stops',
    sequence: 'HT; CSI 4 G, ESC H, CR, HT; CSI 3 g; ESC H at 5 and 13, CSI 2 I, CSI Z, CSI g',
    expected: 'VT100 HTS/TBC, ECMA-48 CHT/CBT', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    const x: number[] = [];
    await h.write('\t'); x.push(h.cursor().x);
    await h.write('\r\x1b[4G\x1bH\r\t'); x.push(h.cursor().x);
    await h.write('\x1b[3g\r\t'); x.push(h.cursor().x);
    await h.write('\x1b[1;5H\x1bH\x1b[1;13H\x1bH\r\x1b[2I'); x.push(h.cursor().x);
    await h.write('\x1b[Z'); x.push(h.cursor().x);
    await h.write('\x1b[g\r\t'); x.push(h.cursor().x);
    return x;
  }, { cols: 40, rows: 3 }), observed => {
    expect(observed).toEqual([8, 3, 39, 12, 4, 12]);
  });

  probe({
    id: 'B02', status: 'unsupported', title: 'DECST8C (CSI ? 5 W) does not restore 8-column tab stops',
    sequence: 'CSI 3 g, CSI ? 5 W, CR, HT', expected: 'VT510 DECST8C: stops every 8 columns -> HT lands on column 9',
    features: ['T11'],
  }, page => run(page, async h => {
    await h.write('\x1b[3g\x1b[?5W\r\t');
    return h.cursor().x;
  }, { cols: 40, rows: 3 }), observed => {
    expect(observed).toBe(39);
  });
});

test.describe('character sets', () => {
  probe({
    id: 'G01', status: 'supported', title: 'DEC Special Graphics in G0 (ESC ( 0) draws line characters and ESC ( B restores ASCII',
    sequence: 'ESC ( 0, "lqqk", ESC ( B, "xq"', expected: 'VT100 DEC Special Graphics', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b(0lqqk\x1b(Bxq');
    return h.lines()[0];
  }), observed => {
    expect(observed).toBe('┌──┐xq');
  });

  probe({
    id: 'G02', status: 'supported', title: 'G1 designation with SO/SI (ESC ) 0, SO, SI)',
    sequence: 'ESC ) 0, "a", SO, "ax", SI, "x"', expected: 'VT100 G1 invoked by SO, G0 by SI', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b)0a\x0eax\x0fx');
    return h.lines()[0];
  }), observed => {
    expect(observed).toBe('a▒│x');
  });

  probe({
    id: 'G03', status: 'partial', title: 'NRCS tables apply without DECNRCM, and DECNRCM (?42) is not recognised',
    sequence: 'ESC ( K, "[\\]{|}~", ESC ( B, "["; DECRQM ?42',
    expected: 'VT220 German NRCS maps to ÄÖÜäöüß; DECNRCM should be reportable (set/reset)', features: ['T08', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b(K[\\]{|}~\x1b(B[');
    return { line: h.lines()[0], mode: await h.query('\x1b[?42$p') };
  }), observed => {
    expect(observed).toEqual({ line: 'ÄÖÜäöüß[', mode: `${ESC}[?42;0$y` });
  });

  probe({
    id: 'G04', status: 'unsupported', title: 'single shifts SS2/SS3 (ESC N / ESC O) are ignored',
    sequence: 'ESC * 0, ESC N, "qq"; ESC + 0, ESC O, "qq"',
    expected: 'VT220 SS2/SS3: only the next character comes from G2/G3 -> "─q─q"', features: ['T08', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b*0\x1bNqq\x1b+0\x1bOqq');
    return h.lines()[0];
  }), observed => {
    expect(observed).toBe('qqqq');
  });

  probe({
    id: 'G05', status: 'partial', title: 'LS2 works in GL but LS1R (ESC ~) invokes G1 into GL instead of GR',
    sequence: 'ESC * 0, ESC n, "q", SI, "q", ESC ) 0, ESC ~, "q"',
    expected: 'VT220 LS2 -> "─"; LS1R changes only GR, so 7-bit "q" stays "q": "─qq"', features: ['T08', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b*0\x1bnq\x0fq\x1b)0\x1b~q');
    return h.lines()[0];
  }), observed => {
    expect(observed).toBe('─q─');
  });
});

test.describe('line attributes and alignment', () => {
  probe({
    id: 'L01', status: 'unsupported', title: 'DECDWL/DECDHL line attributes are ignored (cells stay single width)',
    sequence: 'ESC # 6, "ABCDEFG"; ESC # 3, "abcdefg" on a 10-column screen',
    expected: 'VT100 UG DECDWL/DECDHL: a double-width line holds 5 of 10 columns, so "FG"/"fg" wrap',
    features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b#6ABCDEFG\r\n\x1b#3abcdefg');
    return { lines: h.lines().slice(0, 3), width: h.cell(0, 0).width };
  }, { cols: 10, rows: 4 }), observed => {
    expect(observed).toEqual({ lines: ['ABCDEFG', 'abcdefg', ''], width: 1 });
  });

  probe({
    id: 'L02', status: 'partial', title: 'DECALN fills the screen with E but keeps the DECSTBM margins',
    sequence: 'CSI 2;3 r, ESC # 8, DCS $ q r ST',
    expected: 'VT510 DECALN: "sets the margins to the extremes of the page, and moves the cursor to the home position"',
    features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b[2;3r\x1b#8');
    return { lines: h.lines(), cursor: h.cursor(), margins: await h.query(`\x1bP$qr${'\x1b\\'}`) };
  }, { cols: 5, rows: 4 }), observed => {
    expect(observed.lines).toEqual(['EEEEE', 'EEEEE', 'EEEEE', 'EEEEE']);
    expect(observed.cursor).toEqual({ x: 0, y: 0 });
    expect(observed.margins).toBe(`${ESC}P1$r2;3r${ST}`);
  });
});

test.describe('alternate screen and bracketed paste', () => {
  probe({
    id: 'A01', status: 'supported', title: '1049 saves the cursor, switches to a clean alternate buffer and restores both on exit',
    sequence: '"normal", CSI 2;3 H, CSI ? 1049 h, "ALT", DECRQM ?1049, CSI ? 1049 l',
    expected: 'xterm 1049 = DECSC + clear alternate screen; reset restores', features: ['T12'],
  }, page => run(page, async h => {
    await h.write('normal\x1b[2;3H\x1b[?1049h');
    const alt = { type: h.bufferType(), lines: h.lines().slice(0, 2) };
    await h.write('ALT');
    const mode = await h.query('\x1b[?1049$p');
    await h.write('\x1b[?1049l');
    return { alt, mode, type: h.bufferType(), line: h.lines()[0], cursor: h.cursor() };
  }), observed => {
    expect(observed).toEqual({
      alt: { type: 'alternate', lines: ['', ''] }, mode: `${ESC}[?1049;1$y`,
      type: 'normal', line: 'normal', cursor: { x: 2, y: 1 },
    });
  });

  probe({
    id: 'A02', status: 'partial', title: 'alternate content is discarded on every exit, even for mode 47',
    sequence: 'CSI ? 47 h, "KEEP", CSI ? 47 l, CSI ? 47 h; then CSI ? 1047 h/l',
    expected: 'xterm ctlseqs: only 1049 clears on entry and only 1047 clears on exit, so mode 47 keeps "KEEP"',
    features: ['T12'],
  }, page => run(page, async h => {
    await h.write('normal\r\n\x1b[?47hKEEP\x1b[?47l');
    const back = h.lines()[0];
    await h.write('\x1b[?47h');
    const reentered = h.lines().slice(0, 2);
    await h.write('\x1b[?47l\x1b[?1047hB\x1b[?1047l');
    return { back, reentered, final: { type: h.bufferType(), line: h.lines()[0] } };
  }), observed => {
    expect(observed).toEqual({ back: 'normal', reentered: ['', ''], final: { type: 'normal', line: 'normal' } });
  });

  probe({
    id: 'A03', status: 'supported', title: 'bracketed paste (2004) wraps pasted text and is reported by DECRQM',
    sequence: 'CSI ? 2004 h, paste "a\\nb", DECRQM ?2004, CSI ? 2004 l, paste "c"',
    expected: 'xterm 2004: CSI 200 ~ ... CSI 201 ~', features: ['T12', 'G12'],
  }, page => run(page, async h => {
    await h.write('\x1b[?2004h');
    h.take();
    h.term.paste('a\nb');
    const on = h.take();
    const mode = await h.query('\x1b[?2004$p');
    await h.write('\x1b[?2004l');
    h.term.paste('c');
    return { on, mode, off: h.take() };
  }), observed => {
    expect(observed).toEqual({ on: `${ESC}[200~a\rb${ESC}[201~`, mode: `${ESC}[?2004;1$y`, off: 'c' });
  });
});

test.describe('mouse and focus reporting', () => {
  probe({
    id: 'M01', status: 'supported', title: 'VT200 mouse (1000) reports press and release in the default X10-style encoding',
    sequence: 'CSI ? 1000 h, press/release at column 5 row 3', expected: 'xterm 1000: CSI M Cb Cx Cy (onBinary)', features: ['T17'],
  }, page => run(page, async h => {
    await h.write('\x1b[?1000h');
    h.mouse('mousedown', 4, 2, { button: 0, buttons: 1 });
    const press = h.takeBinary();
    h.mouse('mouseup', 4, 2, { button: 0, buttons: 0 });
    return { mode: h.term.modes.mouseTrackingMode, press, release: h.takeBinary(), data: h.take() };
  }), observed => {
    expect(observed).toEqual({ mode: 'vt200', press: `${ESC}[M %#`, release: `${ESC}[M#%#`, data: '' });
  });

  probe({
    id: 'M02', status: 'supported', title: 'button-event tracking (1002) with SGR (1006) reports drags only while a button is held',
    sequence: 'CSI ? 1002 h, CSI ? 1006 h, move, press, drag, release', expected: 'xterm 1002 + 1006: CSI < b;x;y M/m',
    features: ['T17'],
  }, page => run(page, async h => {
    await h.write('\x1b[?1002h\x1b[?1006h');
    h.take();
    h.mouse('mousemove', 1, 1, { buttons: 0 });
    const idle = h.take();
    h.mouse('mousedown', 1, 1, { button: 0, buttons: 1 });
    h.mouse('mousemove', 3, 1, { button: 0, buttons: 1 });
    h.mouse('mouseup', 3, 1, { button: 0, buttons: 0 });
    return { idle, reports: h.take() };
  }), observed => {
    expect(observed).toEqual({ idle: '', reports: `${ESC}[<0;2;2M${ESC}[<32;4;2M${ESC}[<0;4;2m` });
  });

  probe({
    id: 'M03', status: 'supported', title: 'any-event tracking (1003) reports motion without buttons and wheel as 64/65',
    sequence: 'CSI ? 1003 h, CSI ? 1006 h, move, wheel up/down', expected: 'xterm 1003: CSI < 35;x;y M; wheel CSI < 64/65;x;y M',
    features: ['T17'],
  }, page => run(page, async h => {
    await h.write('\x1b[?1003h\x1b[?1006h');
    h.take();
    h.mouse('mousemove', 2, 0, { buttons: 0 });
    const move = h.take();
    h.mouse('wheel', 2, 0, { deltaY: -200, deltaMode: 0 } as WheelEventInit);
    h.mouse('wheel', 2, 0, { deltaY: 200, deltaMode: 0 } as WheelEventInit);
    return { move, wheel: h.take() };
  }), observed => {
    expect(observed.move).toBe(`${ESC}[<35;3;1M`);
    expect(observed.wheel).toMatch(/^(\x1b\[<64;3;1M)+(\x1b\[<65;3;1M)+$/);
  });

  probe({
    id: 'M04', status: 'partial',
    title: 'SGR-pixels (1016) sends 0-based pixel offsets while cell modes are 1-based (xterm origin unverified)',
    sequence: 'CSI ? 1000 h, CSI ? 1016 h, press',
    expected: 'ctlseqs 1016: "same mouse response format as the 1006 control" in pixels; the pixel origin is not stated',
    features: ['T17'],
  }, page => run(page, async h => {
    await h.write('\x1b[?1000h\x1b[?1016h');
    h.take();
    const at = h.mouse('mousedown', 4, 2, { button: 0, buttons: 1 });
    return { report: h.take(), expected: `\x1b[<0;${at.x};${at.y}M`, mode: await h.query('\x1b[?1016$p') };
  }), observed => {
    expect(observed.report).toBe(observed.expected);
    expect(observed.mode).toBe(`${ESC}[?1016;1$y`);
  });

  probe({
    id: 'M05', status: 'unsupported', title: 'urxvt (1015) and UTF-8 (1005) mouse encodings are rejected',
    sequence: 'CSI ? 1000 h, CSI ? 1015 h, press; DECRQM ?1015, ?1005',
    expected: 'urxvt 1015: CSI 32;5;3 M; xterm 1005: UTF-8 coordinates', features: ['T17'],
  }, page => run(page, async h => {
    await h.write('\x1b[?1000h\x1b[?1015h\x1b[?1005h');
    h.mouse('mousedown', 4, 2, { button: 0, buttons: 1 });
    return {
      binary: h.takeBinary(), data: h.take(),
      modes: (await h.query('\x1b[?1015$p')) + (await h.query('\x1b[?1005$p')),
    };
  }), observed => {
    expect(observed).toEqual({ binary: `${ESC}[M %#`, data: '', modes: `${ESC}[?1015;4$y${ESC}[?1005;4$y` });
  });

  probe({
    id: 'M06', status: 'supported', title: 'focus reporting (1004) sends CSI I / CSI O',
    sequence: 'CSI ? 1004 h, focus, blur', expected: 'xterm 1004: CSI I on focus, CSI O on blur', features: ['T12'],
  }, page => run(page, async h => {
    await h.write('\x1b[?1004h');
    const onEnable = h.take();
    h.term.focus();
    const focus = h.take();
    h.term.blur();
    return { onEnable, focus, blur: h.take(), mode: await h.query('\x1b[?1004$p') };
  }), observed => {
    expect(observed).toEqual({ onEnable: `${ESC}[O`, focus: `${ESC}[I`, blur: `${ESC}[O`, mode: `${ESC}[?1004;1$y` });
  });
});

test.describe('cursor style', () => {
  probe({
    id: 'K01', status: 'supported', title: 'DECSCUSR changes the rendered cursor shape and blink',
    sequence: 'CSI 4 SP q; CSI 5 SP q', expected: 'VT520 DECSCUSR (xterm adds bar 5/6)', features: ['T11', 'T12'],
  }, page => run(page, async h => {
    h.term.focus();
    const cursorClass = async () => {
      await h.frame();
      return (h.holder.querySelector('.xterm-rows .xterm-cursor')?.className ?? '').split(' ').filter(c => c.startsWith('xterm-cursor-')).sort();
    };
    await h.write('\x1b[4 q');
    const steadyUnderline = await cursorClass();
    await h.write('\x1b[5 q');
    return { steadyUnderline, blinkingBar: await cursorClass() };
  }), observed => {
    expect(observed).toEqual({
      steadyUnderline: ['xterm-cursor-underline'],
      blinkingBar: ['xterm-cursor-bar', 'xterm-cursor-blink'],
    });
  });

  probe({
    id: 'K02', status: 'supported', title: 'DECRQSS for DECSCUSR reports the DECSCUSR value (adapter); CSI 0 SP q falls back to the option',
    sequence: 'CSI 4 SP q, DCS $ q SP q ST; CSI 5 SP q, DECRQSS; CSI 0 SP q, DECRQSS',
    expected: 'VT520 DECRPSS: DCS 1 $ r 4 SP q ST', features: ['T11'],
  }, page => rawAndAdapted(page, async (h: Harness) => {
    const request = `\x1bP$q q${'\x1b\\'}`;
    await h.write('\x1b[4 q');
    const underline = await h.query(request);
    await h.write('\x1b[5 q');
    const blinkingBar = await h.query(request);
    await h.write('\x1b[0 q');
    return { underline, blinkingBar, option: await h.query(request) };
  }), observed => {
    // Raw xterm.js 6.0.0 always reports the cursorStyle/cursorBlink options (block, steady).
    expect(observed.raw).toEqual({ underline: `${ESC}P1$r2 q${ST}`, blinkingBar: `${ESC}P1$r2 q${ST}`, option: `${ESC}P1$r2 q${ST}` });
    expect(observed.adapted).toEqual({ underline: `${ESC}P1$r4 q${ST}`, blinkingBar: `${ESC}P1$r5 q${ST}`, option: `${ESC}P1$r2 q${ST}` });
  });
});

test.describe('SGR rendition and colour', () => {
  probe({
    id: 'R01', status: 'supported', title: 'SGR 1/2/3/4/7/8/9/53 set cell attributes and 22–29/55 clear them',
    sequence: 'SGR 1, 2, 22;3, 23;4, 24;7, 27;8, 28;9, 29;53, 55', expected: 'ECMA-48 / xterm SGR', features: ['T07', 'T12'],
  }, page => run(page, async h => {
    await h.write('\x1b[1mB\x1b[2mD\x1b[22;3mI\x1b[23;4mU\x1b[24;7mR\x1b[27;8mH\x1b[28;9mS\x1b[29;53mO\x1b[55mN');
    const names = ['bold', 'dim', 'italic', 'underline', 'inverse', 'invisible', 'strike', 'overline'] as const;
    return Array.from({ length: 9 }, (_, x) => {
      const cell = h.cell(x, 0);
      return `${cell.ch}:${names.filter(name => cell[name]).join('+')}`;
    });
  }), observed => {
    expect(observed).toEqual([
      'B:bold', 'D:bold+dim', 'I:italic', 'U:underline', 'R:inverse', 'H:invisible', 'S:strike', 'O:overline', 'N:',
    ]);
  });

  probe({
    id: 'R02', status: 'supported', title: 'underline styles 4:1–4:5, SGR 21 and SGR 58 colour render as styled underlines',
    sequence: 'SGR 4:1 … 4:5, 4:0, 21, 24;4:3;58:2::255:0:0', expected: 'kitty/VTE underline extensions as documented by xterm.js',
    features: ['T12'],
  }, page => run(page, async h => {
    await h.write('\x1b[4:1ma\x1b[4:2mb\x1b[4:3mc\x1b[4:4md\x1b[4:5me\x1b[4:0mf\x1b[21mg\x1b[24;4:3;58:2::255:0:0mh\x1b[0m');
    await h.frame();
    return h.spans(0).filter(s => s.text.trim()).map(s => ({
      text: s.text,
      underline: s.className.split(' ').filter(c => c.startsWith('xterm-underline')).join(),
      color: s.decorationColor,
    }));
  }), observed => {
    expect(observed).toEqual([
      { text: 'a', underline: 'xterm-underline-1', color: '' },
      { text: 'b', underline: 'xterm-underline-2', color: '' },
      { text: 'c', underline: 'xterm-underline-3', color: '' },
      { text: 'd', underline: 'xterm-underline-4', color: '' },
      { text: 'e', underline: 'xterm-underline-5', color: '' },
      { text: 'f', underline: '', color: '' },
      { text: 'g', underline: 'xterm-underline-2', color: '' },
      { text: 'h', underline: 'xterm-underline-3', color: 'rgb(255, 0, 0)' },
    ]);
  });

  probe({
    id: 'R03', status: 'partial', title: 'blink (SGR 5) is stored but not rendered; rapid blink (SGR 6) is ignored',
    sequence: 'SGR 5 "A", SGR 25;6 "B"', expected: 'VT100 blink attribute visibly blinks', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('\x1b[5mA\x1b[25;6mB\x1b[0m');
    await h.frame();
    const spans = h.spans(0).filter(s => s.text === 'A' || s.text === 'B');
    return {
      stored: [h.cell(0, 0).blink, h.cell(1, 0).blink],
      rendered: spans.map(s => ({ text: s.text, blinkClass: /blink/.test(s.className), animation: s.animation })),
    };
  }), observed => {
    expect(observed).toEqual({
      stored: [true, false],
      rendered: [{ text: 'A', blinkClass: false, animation: 'none' }, { text: 'B', blinkClass: false, animation: 'none' }],
    });
  });

  probe({
    id: 'R04', status: 'supported', title: '16/256-colour SGR (31, 91, 38;5, 38:5, 48;5) map to palette indices',
    sequence: 'SGR 31, 91, 38;5;196, 38:5:202, 48;5;21', expected: 'xterm 256-colour SGR, ITU T.416 colon form',
    features: ['T13'],
  }, page => run(page, async h => {
    await h.write('\x1b[31ma\x1b[91mb\x1b[38;5;196mc\x1b[38:5:202md\x1b[0;48;5;21me\x1b[0m');
    return Array.from({ length: 5 }, (_, x) => { const c = h.cell(x, 0); return `${c.ch} ${c.fg} ${c.bg}`; });
  }), observed => {
    expect(observed).toEqual(['a p16:1 default', 'b p16:9 default', 'c p256:196 default', 'd p256:202 default', 'e default p256:21']);
  });

  probe({
    id: 'R05', status: 'supported', title: 'truecolour SGR 38;2 / 48;2 and colon 38:2:Pi:r:g:b set RGB colours',
    sequence: 'SGR 38;2;1;2;3, 48;2;250;128;0, 38:2::10:20:30, 38:2:9:40:50:60, 38:2:1:2:3',
    expected: 'xterm direct colour; T.416 colon form carries a colour-space id (Pi) before r:g:b', features: ['T16'],
  }, page => run(page, async h => {
    await h.write('\x1b[38;2;1;2;3ma\x1b[0;48;2;250;128;0mb\x1b[0;38:2::10:20:30mc\x1b[38:2:9:40:50:60md\x1b[38:2:1:2:3me\x1b[0m');
    return Array.from({ length: 5 }, (_, x) => { const c = h.cell(x, 0); return `${c.ch} ${c.fg} ${c.bg}`; });
  }), observed => {
    expect(observed).toEqual([
      'a rgb:010203 default', 'b default rgb:fa8000', 'c rgb:0a141e default', 'd rgb:28323c default',
      // Without an explicit (empty) Pi the first value is taken as the colour space, per T.416.
      'e rgb:020300 default',
    ]);
  });

  probe({
    id: 'R06', status: 'supported', title: 'DECRQSS for SGR reports the active rendition from the adapter shadow state',
    sequence: 'SGR 1;31, DCS $ q m ST; SGR 0;3;4:3;58:5:9;38;5;196;48;2;1;2;3, DECRQSS; SGR 0, DECRQSS',
    expected: 'VT420 DECRPSS reports the active rendition, e.g. 0;1;31m', features: ['T10', 'T16', 'T21'],
  }, page => rawAndAdapted(page, async (h: Harness) => {
    const request = `\x1bP$qm${'\x1b\\'}`;
    await h.write('\x1b[1;31m');
    const basic = await h.query(request);
    await h.write('\x1b[0;3;4:3;58:5:9;38;5;196;48;2;1;2;3m');
    const extended = await h.query(request);
    await h.write('\x1b[0m');
    return { basic, extended, reset: await h.query(request) };
  }), observed => {
    // Raw xterm.js 6.0.0 always answers 0m.
    expect(observed.raw).toEqual({ basic: `${ESC}P1$r0m${ST}`, extended: `${ESC}P1$r0m${ST}`, reset: `${ESC}P1$r0m${ST}` });
    expect(observed.adapted).toEqual({
      basic: `${ESC}P1$r0;1;31m${ST}`,
      extended: `${ESC}P1$r0;3;4:3;38;5;196;48;2;1;2;3;58;5;9m${ST}`,
      reset: `${ESC}P1$r0m${ST}`,
    });
  });
});

test.describe('identity, conformance and reports', () => {
  probe({
    id: 'D01', status: 'supported', title: 'DA1/DA2 follow the session terminal type; xterm-256color keeps the built-in replies (adapter)',
    sequence: 'CSI c, CSI > c for raw xterm.js and for terminal types xterm-256color, vt100, vt220, vt420, vt520',
    expected: 'VT220+ DA1 is CSI ? 6x ; … c with feature list; DA2 Pp > 0 for VT220+',
    features: ['T07', 'T08', 'T10', 'T11', 'T20'],
  }, async page => {
    const identify = async (h: Harness) => ({ da1: await h.query('\x1b[c'), da2: await h.query('\x1b[>c') });
    const byType: Record<string, unknown> = {};
    for (const terminalType of ['xterm-256color', 'vt100', 'vt220', 'vt420', 'vt520']) {
      byType[terminalType] = await run(page, identify, { vt: { terminalType } });
    }
    return { raw: await run(page, identify, { vt: false }), byType };
  }, observed => {
    expect(observed.raw).toEqual({ da1: `${ESC}[?1;2c`, da2: `${ESC}[>0;276;0c` });
    expect(observed.byType).toEqual({
      'xterm-256color': { da1: `${ESC}[?1;2c`, da2: `${ESC}[>0;276;0c` }, // byte-identical to raw xterm.js
      vt100: { da1: `${ESC}[?1;2c`, da2: '' }, // a VT100 does not answer DA2
      vt220: { da1: `${ESC}[?62;6;9;22c`, da2: `${ESC}[>1;10;0c` },
      vt420: { da1: `${ESC}[?64;6;9;22c`, da2: `${ESC}[>41;10;0c` },
      vt520: { da1: `${ESC}[?65;6;9;22c`, da2: `${ESC}[>64;10;0c` },
    });
  });

  probe({
    id: 'D02', status: 'partial',
    title: 'DECSCL changes only the reported conformance level (adapter): no soft reset, no feature gating, 8-bit request ignored',
    sequence: 'DCS $ q " p ST; CSI 62;1 " p, DECRQSS, CSI c; CSI 65;2 " p, DECRQSS; CSI 62 " p, ESC c, DECRQSS',
    expected: 'VT520 DECSCL: DECRQSS 62;1"p after CSI 62;1"p, with VT200 behaviour; a VT100 ignores DECSCL',
    features: ['T08', 'T10', 'T11', 'T20', 'T21'],
  }, async page => {
    const select = async (h: Harness) => {
      const request = `\x1bP$q"p${'\x1b\\'}`;
      const initial = await h.query(request);
      await h.write('\x1b[62;1"p');
      const lowered = await h.query(request);
      const da1 = await h.query('\x1b[c');
      await h.write('\x1b[65;2"p');
      const raised = await h.query(request);
      await h.write('\x1b[62"p\x1bc');
      return { initial, lowered, da1, raised, afterRis: await h.query(request) };
    };
    return {
      raw: await run(page, select, { vt: false }),
      xterm: await run(page, select),
      vt520: await run(page, select, { vt: { terminalType: 'vt520' } }),
    };
  }, observed => {
    const fixed = { initial: `${ESC}P1$r61;1"p${ST}`, lowered: `${ESC}P1$r61;1"p${ST}`, da1: `${ESC}[?1;2c`, raised: `${ESC}P1$r61;1"p${ST}`, afterRis: `${ESC}P1$r61;1"p${ST}` };
    expect(observed.raw).toEqual(fixed);
    // The default type identifies as VT100-class, so like xterm with decTerminalID < 200 it ignores DECSCL.
    expect(observed.xterm).toEqual(fixed);
    expect(observed.vt520).toEqual({
      initial: `${ESC}P1$r65;1"p${ST}`, lowered: `${ESC}P1$r62;1"p${ST}`, da1: `${ESC}[?65;6;9;22c`,
      raised: `${ESC}P1$r65;1"p${ST}`, afterRis: `${ESC}P1$r65;1"p${ST}`,
    });
  });

  probe({
    id: 'D03', status: 'partial', title: 'DA3 (VT420/VT520 types) and XTVERSION (xterm type) are answered by the adapter; XTGETTCAP is not',
    sequence: 'CSI = c, CSI > 0 q, DCS + q 544e ST for raw xterm.js and terminal types xterm-256color, vt420',
    expected: 'DA3 DECRPTUI DCS ! | … ST; XTVERSION DCS > | … ST; XTGETTCAP DCS 1 + r … ST',
    features: ['T10', 'T12', 'T20'],
  }, async page => {
    const ask = async (h: Harness) => ({
      da3: await h.query('\x1b[=c'), xtversion: await h.query('\x1b[>0q'), xtgettcap: await h.query(`\x1bP+q544e${'\x1b\\'}`),
    });
    return {
      raw: await run(page, ask, { vt: false }),
      xterm: await run(page, ask),
      vt420: await run(page, ask, { vt: { terminalType: 'vt420' } }),
    };
  }, observed => {
    expect(observed.raw).toEqual({ da3: '', xtversion: '', xtgettcap: '' });
    // A VT100-class identity has no unit ID, so DA3 stays unanswered for the default type.
    expect(observed.xterm).toEqual({ da3: '', xtversion: `${ESC}P>|new-windterm(0.0.1)${ST}`, xtgettcap: '' });
    expect(observed.vt420).toEqual({ da3: `${ESC}P!|00000000${ST}`, xtversion: '', xtgettcap: '' });
  });

  probe({
    id: 'D04', status: 'unsupported', title: 'S8C1T (ESC SP G) does not switch replies to 8-bit C1 (adapter replies stay 7-bit by design)',
    sequence: 'ESC SP G, CSI c (raw, xterm-256color and vt220)', expected: 'VT220 S8C1T: replies use C1 CSI (0x9B)', features: ['T08', 'T21'],
  }, async page => {
    const ask = async (h: Harness) => {
      await h.write('\x1b G');
      return h.query('\x1b[c');
    };
    return {
      ...(await rawAndAdapted(page, ask)),
      vt220: await run(page, ask, { vt: { terminalType: 'vt220' } }),
    };
  }, observed => {
    expect(observed).toEqual({ raw: `${ESC}[?1;2c`, adapted: `${ESC}[?1;2c`, vt220: `${ESC}[?62;6;9;22c` });
  });

  probe({
    id: 'D05', status: 'partial', title: 'DSR 5/6 and DECXCPR are answered; printer/keyboard DECDSR requests are silent',
    sequence: 'CSI 5 n, CSI 2;3 H, CSI 6 n, CSI ? 6 n, CSI ? 15 n, CSI ? 26 n',
    expected: 'VT220+ also answer CSI ? 15 n (printer) and CSI ? 26 n (keyboard)', features: ['T08', 'T10', 'T21'],
  }, page => run(page, async h => {
    const status = await h.query('\x1b[5n');
    await h.write('\x1b[2;3H');
    return {
      status, cpr: await h.query('\x1b[6n'), xcpr: await h.query('\x1b[?6n'),
      printer: await h.query('\x1b[?15n'), keyboard: await h.query('\x1b[?26n'),
    };
  }), observed => {
    expect(observed).toEqual({ status: `${ESC}[0n`, cpr: `${ESC}[2;3R`, xcpr: `${ESC}[?2;3R`, printer: '', keyboard: '' });
  });

  probe({
    id: 'D06', status: 'supported', title: 'DECRQM reports recognised ANSI and DEC private modes and tracks changes',
    sequence: 'CSI 4 $ p, CSI 20 $ p, CSI ? 1/7/25/2004/2026/1049 $ p, CSI ? 1 h, CSI ? 2026 h',
    expected: 'VT520 DECRQM -> DECRPM CSI Ps;Pm $ y', features: ['T11', 'T12'],
  }, page => run(page, async h => {
    const before: string[] = [];
    for (const q of ['\x1b[4$p', '\x1b[20$p', '\x1b[?1$p', '\x1b[?7$p', '\x1b[?25$p', '\x1b[?2004$p', '\x1b[?2026$p', '\x1b[?1049$p']) {
      before.push(await h.query(q));
    }
    await h.write('\x1b[?1h\x1b[?2026h');
    return { before, after: (await h.query('\x1b[?1$p')) + (await h.query('\x1b[?2026$p')) };
  }), observed => {
    expect(observed.before).toEqual([
      `${ESC}[4;2$y`, `${ESC}[20;2$y`, `${ESC}[?1;2$y`, `${ESC}[?7;1$y`, `${ESC}[?25;1$y`, `${ESC}[?2004;2$y`,
      `${ESC}[?2026;2$y`, `${ESC}[?1049;2$y`,
    ]);
    expect(observed.after).toBe(`${ESC}[?1;1$y${ESC}[?2026;1$y`);
  });

  probe({
    id: 'D07', status: 'unsupported', title: 'DECSCNM (?5), DECCOLM (?3, default options) and KAM are not implemented',
    sequence: 'DECRQM ?5, ?3, 2; CSI ? 5 h; CSI ? 3 h',
    expected: 'VT100 DECSCNM reverse video and DECCOLM 132 columns; DECRQM 1/2', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    const modes = [await h.query('\x1b[?5$p'), await h.query('\x1b[?3$p'), await h.query('\x1b[2$p')];
    await h.write('\x1b[?5h\x1b[?3h');
    return { modes, afterSet: await h.query('\x1b[?5$p'), cols: h.term.cols };
  }), observed => {
    expect(observed).toEqual({
      modes: [`${ESC}[?5;0$y`, `${ESC}[?3;0$y`, `${ESC}[2;4$y`], afterSet: `${ESC}[?5;0$y`, cols: 20,
    });
  });

  probe({
    id: 'D08', status: 'partial', title: 'DECCOLM and XTWINOPS reports work only after opting in through windowOptions',
    sequence: 'CSI 18 t (default); with windowOptions {setWinLines, getWinSizeChars}: CSI 18 t, CSI ? 3 h',
    expected: 'xterm: CSI 8;rows;cols t and 132-column switch', features: ['T07', 'T12'],
  }, async page => {
    const blocked = await run(page, async h => h.query('\x1b[18t'));
    const allowed = await run(page, async h => {
      const report = await h.query('\x1b[18t');
      await h.write('\x1b[?3h');
      return { report, cols: h.term.cols, mode: await h.query('\x1b[?3$p') };
    }, { options: { windowOptions: { setWinLines: true, getWinSizeChars: true } } });
    return { blocked, allowed };
  }, observed => {
    expect(observed).toEqual({ blocked: '', allowed: { report: `${ESC}[8;6;20t`, cols: 132, mode: `${ESC}[?3;1$y` } });
  });
});

test.describe('soft and hard reset', () => {
  probe({
    id: 'X01', status: 'partial',
    title: 'DECSTR resets DECOM/IRM/DECTCEM, margins, SGR and charsets but turns autowrap back on',
    sequence: '"KEEP", CSI 2;3 r, CSI ? 6 h, CSI 4 h, SGR 1;31, ESC ( 0, CSI ? 25 l, CSI ? 7 l, CSI ! p',
    expected: 'VT510 DECSTR table: screen kept, DECOM absolute, IRM replace, cursor enabled, margins full, "Autowrap: No autowrap"',
    features: ['T08', 'T11', 'T21'],
  }, page => run(page, async h => {
    await h.write('KEEP\x1b[2;3r\x1b[?6h\x1b[4h\x1b[1;31m\x1b(0\x1b[?25l\x1b[?7l\x1b[!p');
    const modes = [];
    for (const q of ['\x1b[?6$p', '\x1b[4$p', '\x1b[?25$p', '\x1b[?7$p']) modes.push(await h.query(q));
    const margins = await h.query(`\x1bP$qr${'\x1b\\'}`);
    await h.write('\x1b[3;1Hq');
    return { line: h.lines()[0], modes, margins, cell: h.cell(0, 2) };
  }), observed => {
    expect(observed.line).toBe('KEEP');
    // ?7 reports set (1): VT510 lists "No autowrap" after DECSTR; xterm's own choice was not cross-checked.
    expect(observed.modes).toEqual([`${ESC}[?6;2$y`, `${ESC}[4;2$y`, `${ESC}[?25;1$y`, `${ESC}[?7;1$y`]);
    expect(observed.margins).toBe(`${ESC}P1$r1;6r${ST}`);
    expect(observed.cell).toMatchObject({ ch: 'q', bold: false, fg: 'default' });
  });

  probe({
    id: 'X02', status: 'supported', title: 'RIS (ESC c) clears the screen, homes the cursor and resets modes and buffers',
    sequence: '"text", CSI ? 2004 h, CSI ? 1000 h, CSI ? 1049 h, CSI 2;3 r, ESC c', expected: 'VT100 RIS',
    features: ['T07', 'T21'],
  }, page => run(page, async h => {
    await h.write('text\x1b[?2004h\x1b[?1000h\x1b[?1049h\x1b[2;3r\x1bc');
    return {
      type: h.bufferType(), lines: h.lines(), cursor: h.cursor(),
      paste: h.term.modes.bracketedPasteMode, mouse: h.term.modes.mouseTrackingMode,
      margins: await h.query(`\x1bP$qr${'\x1b\\'}`),
    };
  }), observed => {
    expect(observed).toEqual({
      type: 'normal', lines: ['', '', '', '', '', ''], cursor: { x: 0, y: 0 }, paste: false, mouse: 'none',
      margins: `${ESC}P1$r1;6r${ST}`,
    });
  });
});

test.describe('OSC', () => {
  probe({
    id: 'O01', status: 'supported', title: 'OSC 0 and OSC 2 set the title through onTitleChange; OSC 1 icon name is not surfaced',
    sequence: 'OSC 0;zero BEL, OSC 1;icon BEL, OSC 2;two ST, CSI 21 t', expected: 'xterm OSC 0/1/2; title report needs windowOptions',
    features: ['T12'],
  }, page => run(page, async h => {
    await h.write(`\x1b]0;zero\x07\x1b]1;icon\x07\x1b]2;two${'\x1b\\'}`);
    return { titles: [...h.titles], report: await h.query('\x1b[21t') };
  }), observed => {
    expect(observed).toEqual({ titles: ['zero', 'two'], report: '' });
  });

  probe({
    id: 'O02', status: 'supported', title: 'OSC 4/10/11/12 colour queries reply with rgb: values and follow OSC set/reset',
    sequence: 'OSC 4;1;? , OSC 10;? , OSC 11;? , OSC 12;? , OSC 4;1;#123456, OSC 104;1',
    expected: 'xterm dynamic colours: OSC Ps;rgb:rrrr/gggg/bbbb ST', features: ['T12', 'T13'],
  }, page => run(page, async h => {
    const replies = [];
    for (const q of ['\x1b]4;1;?\x07', '\x1b]10;?\x07', '\x1b]11;?\x07', '\x1b]12;?\x07']) replies.push(await h.query(q));
    await h.write('\x1b]4;1;#123456\x07');
    const changed = await h.query('\x1b]4;1;?\x07');
    await h.write('\x1b]104;1\x07');
    return { replies, changed, restored: await h.query('\x1b]4;1;?\x07') };
  }), observed => {
    expect(observed.replies).toEqual([
      `${ESC}]4;1;rgb:cccc/0000/0000${ST}`, `${ESC}]10;rgb:ffff/ffff/ffff${ST}`,
      `${ESC}]11;rgb:0000/0000/0000${ST}`, `${ESC}]12;rgb:ffff/ffff/ffff${ST}`,
    ]);
    expect(observed.changed).toBe(`${ESC}]4;1;rgb:1212/3434/5656${ST}`);
    expect(observed.restored).toBe(`${ESC}]4;1;rgb:cccc/0000/0000${ST}`);
  });

  probe({
    id: 'O03', status: 'supported', title: 'OSC 8 hyperlinks reach linkHandler on hover; non-http(s) URIs are dropped by default',
    sequence: 'OSC 8;id=x;https://example.com/a ST "link" OSC 8;; ST, then the same with file:///tmp/x',
    expected: 'OSC 8 hyperlink spec (egmontkob); xterm.js allows only http/https unless allowNonHttpProtocols',
    features: ['T12'],
  }, page => run(page, async h => {
    const hovered: { text: string; start: number; end: number }[] = [];
    h.term.options.linkHandler = {
      activate: () => undefined,
      hover: (_e: MouseEvent, text: string, range: { start: { x: number }; end: { x: number } }) => {
        hovered.push({ text, start: range.start.x, end: range.end.x });
      },
    };
    await h.write(`\x1b]8;id=x;https://example.com/a${'\x1b\\'}link\x1b]8;;${'\x1b\\'} tail\r\n`);
    await h.write(`\x1b]8;;file:///tmp/x${'\x1b\\'}file\x1b]8;;${'\x1b\\'}`);
    await h.frame();
    h.mouse('mousemove', 1, 0);
    await h.frame();
    const http = [...hovered];
    h.mouse('mousemove', 1, 1);
    await h.frame();
    return { http, file: hovered.slice(http.length), line: h.lines()[0] };
  }), observed => {
    expect(observed).toEqual({ http: [{ text: 'https://example.com/a', start: 1, end: 4 }], file: [], line: 'link tail' });
  });

  probe({
    id: 'O04', status: 'partial',
    title: 'OSC 52 writes reach the clipboard only after a per-session opt-in (adapter); reads are always denied by policy',
    sequence: 'OSC 52;c;aGVsbG8= BEL, OSC 52;c;? BEL — raw, adapter default, adapter with clipboardWrite',
    expected: 'xterm OSC 52: set selection; "?" replies with the data', features: ['T12', 'G29'],
  }, async page => {
    const copy = async (h: Harness) => {
      const set = await h.query('\x1b]52;c;aGVsbG8=\x07');
      const query = await h.query('\x1b]52;c;?\x07');
      await h.frame(); // clipboard writes complete asynchronously
      return {
        set, query, line: h.lines()[0], cursor: h.cursor(),
        clipboard: [...h.clipboard], notices: h.notices.map(n => n.kind).sort(),
      };
    };
    return {
      ...(await rawAndAdapted(page, copy)),
      optedIn: await run(page, copy, { vt: { clipboardWrite: true } }),
    };
  }, observed => {
    const quiet = { set: '', query: '', line: '', cursor: { x: 0, y: 0 } };
    expect(observed.raw).toEqual({ ...quiet, clipboard: [], notices: [] }); // the core has no OSC 52 handler
    expect(observed.adapted).toEqual({ ...quiet, clipboard: [], notices: ['clipboard-blocked', 'clipboard-read-denied'] });
    expect(observed.optedIn).toEqual({ ...quiet, clipboard: ['hello'], notices: ['clipboard-read-denied', 'clipboard-written'] });
  });
});

test.describe('graphics', () => {
  probe({
    id: 'P01', status: 'unsupported', title: 'SIXEL DCS is swallowed without drawing and DA1 does not advertise sixel',
    sequence: '"A", DCS q #0;2;0;0;0 #0~~~~ ST, "B", CSI c',
    expected: 'VT340/xterm sixel: image drawn, cursor moves; DA1 contains 4 (needs @xterm/addon-image, not installed)',
    features: ['T09', 'T12'],
  }, page => run(page, async h => {
    await h.write(`A\x1bPq#0;2;0;0;0#0~~~~${'\x1b\\'}B`);
    return { line: h.lines()[0], cursor: h.cursor(), da1: await h.query('\x1b[c') };
  }), observed => {
    expect(observed).toEqual({ line: 'AB', cursor: { x: 2, y: 0 }, da1: `${ESC}[?1;2c` });
  });
});

test.describe('adapter feasibility through public parser hooks (raw xterm.js, vt: false)', () => {
  probe({
    id: 'H01', status: 'supported', title: 'registerEscHandler sees ESC # 6 but cannot widen cells (renderer change needed)',
    sequence: 'registerEscHandler({ intermediates: "#", final: "6" }), ESC # 6, "AB"',
    expected: 'hook fires; cell width stays 1 because IBufferCell has no line-attribute API', features: ['T07', 'T21'],
  }, page => run(page, async h => {
    const seen: string[] = [];
    h.term.parser.registerEscHandler({ intermediates: '#', final: '6' }, () => { seen.push('DECDWL'); return true; });
    await h.write('\x1b#6AB');
    return { seen, width: h.cell(0, 0).width, cursor: h.cursor() };
  }, { vt: false }), observed => {
    expect(observed).toEqual({ seen: ['DECDWL'], width: 1, cursor: { x: 2, y: 0 } });
  });

  probe({
    id: 'H02', status: 'supported', title: 'registerCsiHandler + terminal.input can answer XTVERSION',
    sequence: 'registerCsiHandler({ prefix: ">", final: "q" }), CSI > 0 q', expected: 'DCS > | name ST reply produced by an adapter',
    features: ['T12', 'T20'],
  }, page => run(page, async h => {
    h.term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => {
      h.term.input(`\x1bP>|new-windterm-probe${'\x1b\\'}`, false);
      return true;
    });
    return h.query('\x1b[>0q');
  }, { vt: false }), observed => {
    expect(observed).toBe(`${ESC}P>|new-windterm-probe${ST}`);
  });

  probe({
    id: 'H03', status: 'supported', title: 'registerOscHandler(52) receives clipboard payloads for an adapter',
    sequence: 'registerOscHandler(52), OSC 52;c;aGVsbG8= BEL', expected: 'payload "c;aGVsbG8=" handed to the embedder',
    features: ['T12', 'G29'],
  }, page => run(page, async h => {
    const payloads: string[] = [];
    h.term.parser.registerOscHandler(52, (data: string) => { payloads.push(data); return true; });
    await h.write('\x1b]52;c;aGVsbG8=\x07');
    return payloads;
  }, { vt: false }), observed => {
    expect(observed).toEqual(['c;aGVsbG8=']);
  });
});
