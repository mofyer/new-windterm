import { test, expect } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

test('Rust target HTML changes do not reload the Vite workspace', async ({ page }) => {
  const directory = path.resolve(`src-tauri/target/p0-watch-probe-${process.pid}`);
  const probeFile = path.join(directory, 'index.html');
  const reloadMessages: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', event => {
    const payload = String(event.payload);
    if (payload.includes('full-reload') && payload.includes('p0-watch-probe-')) reloadMessages.push(payload);
  }));
  await page.addInitScript(() => {
    sessionStorage.setItem('p0-watch-loads', String(Number(sessionStorage.getItem('p0-watch-loads') ?? 0) + 1));
  });
  await page.goto('/');
  await expect(page.locator('#runtime-note')).toBeVisible();
  const before = await page.evaluate(() => sessionStorage.getItem('p0-watch-loads'));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probeFile, '<!doctype html><title>controlled Cargo output fixture</title>');
    await page.waitForTimeout(400);
    await writeFile(probeFile, '<!doctype html><title>changed controlled Cargo output fixture</title>');
    // A finite observation interval catches the Vite watcher debounce and reload.
    await page.waitForTimeout(1000);
    expect(reloadMessages).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('p0-watch-loads'))).toBe(before);
    await expect(page.locator('#runtime-note')).toBeVisible();
  } finally {
    await rm(probeFile, { force: true });
  }
});
