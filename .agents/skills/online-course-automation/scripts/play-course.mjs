// Drive one course to completion, chapter by chapter.
//
// Two findings from live testing shape this whole script:
//
//   1. The completion line is 80% of the video, BUT the progress report only
//      fires when the video reaches its END. Stopping at 80% records nothing.
//      So every chapter must play to the last second — do not "optimise" this
//      into seeking to 80%, it silently records zero.
//   2. 1.5x is offered by the player's own UI and is credited normally. 4x plus
//      backward seeking trips the platform's "abnormal learning" warning. Stay
//      at or below 1.5x and never seek backwards.
//
// Document-type sections have no <video>; they credit automatically after
// dwelling a few seconds (the page shows "需学 00:05"). This script just dwells.

import { attach, tab, sleep } from './cdp.mjs';
import * as zxy from './zhixueyun.mjs';

const RATE = Number(process.env.RATE || 1.5);
const COURSE_URL = '/study/course/detail';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const videoState = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    return { cur: v.currentTime, dur: v.duration, paused: v.paused, rate: v.playbackRate, ended: v.ended };
  });

const progressText = (page) =>
  page.evaluate(() => (document.body.innerText.match(/课程进度[：:]\s*\d+%/g) || [])[0] || 'n/a');

// Wait for the chapter's video element to appear.
//
// Do NOT sample this once after a fixed delay: the player mounts asynchronously
// and the <video> can show up well after the chapter markup does. A single
// early check misreads a video chapter as a document chapter and silently
// "passes" it without playing anything — which is exactly what happened the
// first time this ran against a new subject.
async function waitForVideo(page, { timeout = 30000, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await videoState(page);
    if (last && Number.isFinite(last.dur) && last.dur > 0) return last;
    await page.waitForTimeout(interval);
  }
  return last; // null (no <video>) or a not-yet-ready player
}

async function playChapterToEnd(page, index, total) {
  const item = page.locator('.chapter-item').nth(index);
  await item.scrollIntoViewIfNeeded().catch(() => {});
  const box = await item.boundingBox().catch(() => null);
  if (!box) return { ok: false, why: 'no-click-target' };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  let s = await waitForVideo(page);
  if (!s || !Number.isFinite(s.dur) || s.dur <= 0) {
    // Genuinely a document section: no player ever loads. These credit after a
    // short dwell, which the page advertises as "需学 00:05".
    log(`  ch${index + 1}/${total}: document section — dwelling`);
    await page.waitForTimeout(12000);
    return { ok: true, why: 'document' };
  }
  if (s.ended || s.cur >= s.dur - 2) return { ok: true, why: 'already-ended' };

  log(`  ch${index + 1}/${total}: playing ${Math.round(s.cur)}→${Math.round(s.dur)} @${RATE}x`);
  await page.evaluate((r) => {
    const v = document.querySelector('video');
    if (v) {
      v.muted = true;
      v.playbackRate = r;
      if (v.paused) v.play().catch(() => {});
    }
  }, RATE);

  for (let tick = 0; tick < 900; tick++) {
    await page.waitForTimeout(8000);
    s = await videoState(page);
    if (!s) return { ok: false, why: 'video-vanished' };

    // The player resets the rate on some chapter transitions; re-assert it.
    if (Math.abs(s.rate - RATE) > 0.01 || (s.paused && s.cur < s.dur - 2)) {
      await page.evaluate((r) => {
        const v = document.querySelector('video');
        if (v) {
          v.playbackRate = r;
          if (v.paused) v.play().catch(() => {});
        }
      }, RATE);
    }
    if (tick % 10 === 0) log(`     ... ${Math.round(s.cur)}/${Math.round(s.dur)}`);
    if (s.ended || s.cur >= s.dur - 1) return { ok: true, why: 'ended' };
  }
  return { ok: false, why: 'timeout' };
}

const [courseId] = process.argv.slice(2);
if (!courseId) {
  console.error('usage: node play-course.mjs <courseId> [--rate 1.5]');
  process.exit(1);
}

const { browser, ctx } = await attach();
let page = tab(ctx, COURSE_URL);
if (!page) {
  console.error(`no open course tab. Open the course first (see open-course.mjs), because`);
  console.error(`the platform warns when courses are opened in bulk.`);
  await browser.close();
  process.exit(1);
}
await page.bringToFront().catch(() => {});

const chapterCount = await page.locator('.chapter-item').count();
log(`course ${courseId}: ${chapterCount} chapter(s), start ${await progressText(page)}`);

for (let i = 0; i < chapterCount; i++) {
  const r = await playChapterToEnd(page, i, chapterCount);
  log(`  ch${i + 1}: ${r.ok ? 'OK' : 'INCOMPLETE'} (${r.why}) — ${await progressText(page)}`);
  if (!r.ok && r.why !== 'document') log('  stopping this course; re-run after inspecting the page');
  if (!r.ok && r.why !== 'document') break;
  await page.waitForTimeout(15000); // let the progress POST land
}

await page.waitForTimeout(30000);
log(`final page state: ${await progressText(page)}`);
log('note: the page often still shows a stale %; trust listSections() for the real value.');

await page.close().catch(() => {});
await browser.close();
