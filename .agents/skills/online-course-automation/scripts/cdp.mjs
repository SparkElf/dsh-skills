// Shared helpers for driving an already-logged-in browser over CDP.
//
// Why this file exists: driving a *real* profile is the hard part of course
// automation, and three traps cost most of the debugging time.
//
//   1. Chrome 136+ refuses to open --remote-debugging-port when the profile is
//      the default user-data-dir. A daily-use Chrome therefore has no reachable
//      port no matter how it was started. Either launch a second instance with
//      its own --user-data-dir and log in there, or drive the GUI directly.
//   2. Element.click() from script does not fire the framework handlers on
//      these platforms. Only a real mouse event at the element's centre does.
//   3. page.bringToFront() changes what the user sees on their own screen.
//      Prefer background reads and only front a tab when a click needs it.

import { loadPlaywright } from './resolve-playwright.mjs';

const { chromium } = await loadPlaywright();

export const DEFAULT_PORT = Number(process.env.CDP_PORT || 9333);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect to a browser that is already running with a debug port. */
export async function attach({ port = DEFAULT_PORT, timeout = 15000 } = {}) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout });
  const ctx = browser.contexts()[0];
  if (!ctx) {
    await browser.close().catch(() => {});
    throw new Error(
      `no browser context on 127.0.0.1:${port} — is the browser running with --remote-debugging-port=${port}?`,
    );
  }
  // Closing this handle only detaches; the user's browser keeps running.
  return { browser, ctx };
}

export const tabs = (ctx, urlIncludes) => ctx.pages().filter((p) => p.url().includes(urlIncludes));

export const tab = (ctx, urlIncludes) => tabs(ctx, urlIncludes)[0] ?? null;

/** Page objects are identity-stable, so a Set of them detects newly opened tabs. */
export const snapshotPages = (ctx) => new Set(ctx.pages());

export async function waitForNewTab(ctx, before, urlIncludes, { timeout = 30000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = ctx.pages().find((p) => !before.has(p) && p.url().includes(urlIncludes));
    if (found) return found;
    await sleep(interval);
  }
  return null;
}

/**
 * Click with a real mouse event.
 * Synthetic clicks are ignored by the Vue/React handlers these platforms use,
 * which makes the button look "dead" even though the selector matched.
 */
export async function realClick(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

/** Poll until accept() passes; returns the last observed value either way. */
export async function poll(fn, accept, { timeout = 30000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await fn();
    if (accept(last)) return last;
    await sleep(interval);
  } while (Date.now() < deadline);
  return last;
}
