import { test, expect, type Page } from '@playwright/test';

// Tall sheets keep their form actions reachable. Linux WebKitGTK's WebDriver does not scroll a
// sheet to reach a button below its fold (CI 42352720999: `element not interactable` on the SSH
// sheet once the keyboard section was added), and a user would have to scroll to the primary
// action. The form's action row now sticks to the sheet's bottom edge. Chrome only, with a stub
// desktop IPC so the sheets render their desktop fields; nothing here is a native WebView result.

async function desktopStub(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (command: string) => Promise.resolve(command === 'pty_shells' ? [] : null),
      },
    });
  });
}

/** The element under the button's centre is the button itself (or inside it): visible and clickable. */
const reachable = (page: Page, selector: string) => page.locator(selector).evaluate((button) => {
  const box = button.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {
    inViewport: box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth,
    hitsButton: !!hit && (hit === button || button.contains(hit)),
  };
});

/** Opens every collapsed section inside the open sheet, so it is as tall as it gets. */
const expandAll = (page: Page, dialog: string) => page.locator(`${dialog} details`).evaluateAll((all) => {
  for (const details of all as HTMLDetailsElement[]) details.open = true;
});

const SHEETS = [
  {
    name: 'SSH terminal', dialog: '#ssh-verification-dialog', primary: '#ssh-probe',
    open: async (page: Page) => {
      await page.locator('#connect-open').click();
      await page.locator('#ssh-terminal-open').click();
    },
  },
  { name: 'local launch options', dialog: '#local-dialog', primary: '#local-start', open: (page: Page) => page.locator('#local-options-open').click() },
  {
    name: 'Telnet / Raw TCP', dialog: '#net-terminal-dialog', primary: '#net-open',
    open: async (page: Page) => {
      await page.locator('#connect-open').click();
      await page.locator('#net-terminal-open').click();
    },
  },
];

for (const size of [{ width: 1400, height: 900 }, { width: 1280, height: 720 }]) {
  for (const sheet of SHEETS) {
    test(`${size.width}×${size.height}: the ${sheet.name} sheet keeps its primary action visible and clickable`, async ({ page }) => {
      await page.setViewportSize(size);
      await desktopStub(page);
      await page.goto('/');
      await sheet.open(page);
      await expect(page.locator(sheet.dialog)).toBeVisible();
      await expandAll(page, sheet.dialog);
      // The sheet starts scrolled to the top, as a freshly opened one does.
      await page.locator(sheet.dialog).evaluate((dialog) => { dialog.scrollTop = 0; });
      expect(await reachable(page, sheet.primary)).toEqual({ inViewport: true, hitsButton: true });
    });
  }
}
