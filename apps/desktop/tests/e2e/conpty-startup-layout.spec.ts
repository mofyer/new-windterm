import { test, expect } from '@playwright/test';
import { installHarness, type VtWindow } from './support/vt-harness';
import fixtures from '../../../../tests/fixtures/conpty-startup-layout.json' with { type: 'json' };

// Synthetic ASCII streams only; never captured PowerShell output. The same JSON
// drives the actual Rust Parser::startup tests. Its parser expectations are NOT
// implemented here: this side observes the pinned raw xterm.js 6.0.0 renderer.
// A visible READY row is not authorization to accept a protocol record.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(installHarness);
});

for (const fixture of fixtures.cases) {
  test(`synthetic ConPTY layout: ${fixture.id}`, async ({ page }) => {
    expect(fixtures.version).toBe(1);
    const observations = await page.evaluate(async ({ fixture, cols, rows }) => {
      const h = await (window as unknown as VtWindow).vtHarness({ cols, rows, vt: false });
      const outputs = [];
      try {
        // All fixtures are ASCII, so every string boundary is also a byte boundary.
        // Awaiting each write ensures the split is exercised by xterm's parser.
        const partitions = [[fixture.input], ...Array.from({ length: fixture.input.length + 1 }, (_, cut) => [
          fixture.input.slice(0, cut), fixture.input.slice(cut),
        ]), Array.from(fixture.input)];
        for (const chunks of partitions) {
          h.term.reset();
          for (const chunk of chunks) if (chunk) await h.write(chunk);
          outputs.push({ lines: h.lines(), cursor: h.cursor() });
        }
      } finally {
        h.dispose();
      }
      return outputs;
    }, { fixture, cols: fixtures.cols, rows: fixtures.rows });
    for (const [partition, observed] of observations.entries()) {
      expect(observed, `${fixture.id}, partition ${partition}`).toEqual(fixture.screen);
    }
  });
}
