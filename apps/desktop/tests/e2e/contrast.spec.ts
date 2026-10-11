import { test, expect, type Page } from '@playwright/test';

async function contrast(page: Page, selector: string) {
  return page.locator(selector).evaluate((element, selector) => {
    type Color = [number, number, number, number];
    const parse = (value: string): Color => {
      const values = value.match(/[\d.]+/g)!.map(Number);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const composite = (front: Color, back: Color): Color => [
      front[0] * front[3] + back[0] * (1 - front[3]),
      front[1] * front[3] + back[1] * (1 - front[3]),
      front[2] * front[3] + back[2] * (1 - front[3]), 1,
    ];
    const ancestors: Element[] = [];
    for (let el: Element | null = element; el; el = el.parentElement) ancestors.unshift(el);
    let background: Color = [255, 255, 255, 1];
    for (const el of ancestors) {
      const style = getComputedStyle(el);
      if (style.backgroundImage !== 'none') throw new Error(`Cannot infer gradient contrast for ${selector}`);
      if (style.opacity !== '1') throw new Error(`Opacity needs explicit treatment for ${selector}`);
      background = composite(parse(style.backgroundColor), background);
    }
    const style = getComputedStyle(element);
    let foreground = composite(parse(style.color), background);
    if (style.filter !== 'none') {
      const match = /^brightness\(([\d.]+)\)$/.exec(style.filter);
      if (!match) throw new Error(`Unsupported CSS filter ${style.filter}`);
      const brightness = Number(match[1]);
      const apply = (color: Color): Color => [Math.min(255, color[0] * brightness), Math.min(255, color[1] * brightness), Math.min(255, color[2] * brightness), 1];
      foreground = apply(foreground); background = apply(background);
    }
    const luminance = (color: Color) => {
      const values = color.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const a = luminance(foreground), b = luminance(background);
    return { selector, foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  }, selector);
}

for (const theme of ['light', 'dark']) {
  test(`${theme} body muted selected and primary text meet 4.5 contrast`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.locator('#theme').selectOption(theme);
    const probes = [];
    for (const selector of ['body', '#runtime-note', '.section-label', '.session-item.selected > span', '#connect-open']) probes.push(await contrast(page, selector));
    await page.locator('#connect-open').click();
    probes.push(await contrast(page, '#connect-dialog .sheet-description'));
    probes.push(await contrast(page, '#connect-dialog button.primary'));
    await page.locator('#connect-dialog button.primary').hover();
    probes.push({ ...(await contrast(page, '#connect-dialog button.primary')), selector: '#connect-dialog button.primary:hover' });
    await testInfo.attach(`contrast-${theme}.json`, { body: JSON.stringify(probes, null, 2), contentType: 'application/json' });
    for (const result of probes) expect.soft(result.ratio, `${theme} ${result.selector}: ${result.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
}
