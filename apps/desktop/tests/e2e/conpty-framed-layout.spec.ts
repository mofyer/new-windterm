import { test, expect } from '@playwright/test';
import { installHarness, type VtWindow } from './support/vt-harness';

const nonce = '0123456789abcdef0123456789abcdef';
const frame = `~B${nonce}|R|5.1.20348.5622|E${nonce}~`;
const begin = `~B${nonce}|`;
const rest = `R|5.1.20348.5622|E${nonce}~`;

// Fixed synthetic streams only. Rust ready_frame.rs tests the actual protocol
// parser separately: implicit visual wrapping does not insert wire controls;
// actual CR/CSI bytes inside a candidate fail even if some frame text is visible.
const cases = [
  { id: 'wide-first-column', cols: 100, input: frame,
    lines: [frame], cursor: { x: 86, y: 0 }, wrapped: [false] },
  { id: 'wide-near-margin', cols: 100, input: `${' '.repeat(98)}${frame}`,
    lines: [`${' '.repeat(98)}~B`, `${nonce}|${rest}`], cursor: { x: 84, y: 1 }, wrapped: [false, true] },
  { id: 'narrow-near-margin', cols: 40, input: `${' '.repeat(38)}${frame}`,
    lines: [`${' '.repeat(38)}~B`, `${nonce}|R|5.1.2`, '0348.5622|E0123456789abcdef0123456789abc', 'def~'],
    cursor: { x: 4, y: 3 }, wrapped: [false, true, true, true] },
  { id: 'very-narrow-near-margin', cols: 20, input: `${' '.repeat(18)}${frame}`,
    lines: [`${' '.repeat(18)}~B`, '0123456789abcdef0123', '456789abcdef|R|5.1.2', '0348.5622|E012345678', '9abcdef0123456789abc', 'def~'],
    cursor: { x: 4, y: 5 }, wrapped: [false, true, true, true, true, true] },
  { id: 'actual-cr-inside-frame-is-not-implicit-wrap', cols: 100, input: `${begin}\r${rest}`,
    lines: [rest], cursor: { x: 51, y: 0 }, wrapped: [false] },
  { id: 'actual-cup-inside-frame-is-not-implicit-wrap', cols: 100, input: `${begin}\x1b[2;1H${rest}`,
    lines: [begin, rest], cursor: { x: 51, y: 1 }, wrapped: [false, false] },
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(installHarness);
});

for (const fixture of cases) {
  test(`framed READY layout: ${fixture.id}`, async ({ page }) => {
    const observations = await page.evaluate(async fixture => {
      const h = await (window as unknown as VtWindow).vtHarness({ cols: fixture.cols, rows: 8, vt: false });
      try {
        const results = [];
        for (const chunks of [[fixture.input], Array.from(fixture.input)]) {
          h.term.reset();
          for (const chunk of chunks) await h.write(chunk);
          results.push({
            lines: h.lines(), cursor: h.cursor(),
            wrapped: Array.from({ length: 8 }, (_, row) => h.wrapped(row)),
          });
        }
        return results;
      } finally { h.dispose(); }
    }, fixture);
    for (const observed of observations) {
      expect(observed).toEqual({
        lines: [...fixture.lines, ...Array(8 - fixture.lines.length).fill('')],
        cursor: fixture.cursor,
        wrapped: [...fixture.wrapped, ...Array(8 - fixture.wrapped.length).fill(false)],
      });
    }
  });
}
