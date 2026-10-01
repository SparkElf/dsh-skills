// Drive a whole subject to completion: serial, resumable, crash-tolerant.
//
// Template — copy and adjust SUBJECT_ID for the platform you are working on.
//
// Design notes, each one paid for by a real failure:
//
//   * Serial only. Opening courses in bulk is what platforms flag as abnormal.
//   * Resume from the server every round; never track progress in memory. The
//     host can restart mid-run and kill this process at any moment.
//   * Re-attach and probe the page each round. A stale page reference throws
//     "Target page ... closed" and, left unhandled, kills the whole run.
//   * Poll for <video> and for the chapter list. Fixed-delay single reads
//     classify a video course as a document course and record zero study time
//     while reporting success.
//   * Watch currentTime for stalls. A sleeping/backgrounded browser freezes
//     playback and the page stops reporting.
//
// Run:  node run-subject.mjs <subjectId> [--rate 1.5]

import fs from 'node:fs';
import { attach, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const SUBJECT_ID = positional[0];
const RATE = Number(args[args.indexOf('--rate') + 1]) || 1.5;
const STALL_SECONDS = 120;
const COURSE_URL = '/study/course/detail';

if (!SUBJECT_ID) {
  console.error('usage: node run-subject.mjs <subjectId> [--rate 1.5]');
  process.exit(1);
}

const LOG = `run-${SUBJECT_ID.slice(0, 8)}.log`;
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ` + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
};

let ctx = null;
let subj = null;

async function connect() {
  const { browser, ctx: c } = await attach();
  ctx = c;
  subj = ctx.pages().find((p) => p.url().includes(SUBJECT_ID));
  if (!subj) throw new Error(`subject tab ${SUBJECT_ID} is not open — open it first`);
  return browser;
}

async function alive() {
  try { await subj.evaluate(() => 1); return true; } catch {}
  log('  ! page lost, re-attaching');
  try { await connect(); await sleep(3000); await subj.evaluate(() => 1); return true; } catch { return false; }
}

function closeCourseTabs() {
  for (const p of ctx.pages()) if (/\/study\/(course|errors)/.test(p.url())) p.close().catch(() => {});
}

async function readProgress() {
  return subj.evaluate(async (sid) => {
    const token = JSON.parse(localStorage.getItem('token') || '{}').access_token;
    const r = await fetch(
      `/api/v1/course-study/subject/chapter-progress?courseId=${sid}&knowledgePaymentEnable=false&_=${Date.now()}`,
      { credentials: 'include', headers: { Accept: 'application/json', Version: '12.1.1', Authorization: `Bearer__${token}` } },
    );
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}`); }
    if (!Array.isArray(j)) throw new Error(`HTTP ${r.status} ${text.slice(0, 90)}`);
    const out = [];
    for (const ch of j) for (const s of ch.courseChapterSections || [])
      out.push({ name: s.name, courseId: s.attachmentId, type: s.sectionType,
                 rate: s.progress?.completedRate, finish: s.progress?.finishStatus });
    return out;
  }, SUBJECT_ID);
}

const isDone = (s) => s.finish === 2 || (s.rate ?? 0) >= 100;

async function refreshSubject() {
  await subj.bringToFront().catch(() => {});
  await subj.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(9000);
  for (let i = 0; i < 20; i++) { await subj.evaluate((y) => window.scrollTo(0, y), i * 500); await sleep(200); }
  await subj.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
}

async function openCourse(courseId) {
  closeCourseTabs();
  await sleep(1500);
  const hit = await subj.evaluate((id) => {
    const row = document.querySelector(`[data-resource-id="${id}"]`);
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const b = [...row.querySelectorAll('*')].find((e) => e.children.length === 0 &&
      /开始学习|继续学习|重新学习/.test(e.innerText || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, status: b.innerText.trim() };
  }, courseId);
  if (!hit) return null;
  await sleep(1200);
  await subj.mouse.click(hit.x, hit.y);
  for (let k = 0; k < 30; k++) {
    await sleep(1000);
    // Match by URL shape, not by "is this tab new" — leftover tabs break that.
    const p = ctx.pages().find((p) => p.url().includes(COURSE_URL));
    if (p) return p;
  }
  return null;
}

async function waitVideo(page, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await page.evaluate(() => {
      const el = document.querySelector('video');
      return el ? { cur: el.currentTime, dur: el.duration } : null;
    }).catch(() => null);
    if (v && Number.isFinite(v.dur) && v.dur > 0) return v;
    await sleep(1000);
  }
  return null;
}

async function playChapter(page, idx, total) {
  const item = page.locator('.chapter-item').nth(idx);
  await item.scrollIntoViewIfNeeded().catch(() => {});
  const box = await item.boundingBox().catch(() => null);
  if (!box) return { ok: false, why: 'no-box' };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const start = await waitVideo(page);
  if (!start) {
    log(`    ch${idx + 1}/${total}: document section — dwelling`);
    await sleep(13000);
    return { ok: true, why: 'document' };
  }
  log(`    ch${idx + 1}/${total}: playing ${Math.round(start.cur)}→${Math.round(start.dur)} @${RATE}x`);
  await page.evaluate((r) => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.playbackRate = r; if (v.paused) v.play().catch(() => {}); }
  }, RATE);

  let lastCur = start.cur, lastMove = Date.now();
  for (let k = 0; k < 900; k++) {
    await sleep(8000);
    const s = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { cur: v.currentTime, dur: v.duration, paused: v.paused, rate: v.playbackRate, ended: v.ended } : null;
    }).catch(() => null);
    if (!s) return { ok: false, why: 'video-gone' };

    if (s.cur > lastCur + 0.5) { lastCur = s.cur; lastMove = Date.now(); }
    else if (Date.now() - lastMove > STALL_SECONDS * 1000) {
      log(`    ! stalled at ${Math.round(s.cur)}/${Math.round(s.dur)} — nudging`);
      await page.bringToFront().catch(() => {});
      await page.evaluate((r) => {
        const v = document.querySelector('video');
        if (v) { v.muted = true; v.playbackRate = r; v.play().catch(() => {}); }
      }, RATE);
      lastMove = Date.now();
    }

    if (Math.abs(s.rate - RATE) > 0.01 || (s.paused && s.cur < s.dur - 2)) {
      await page.evaluate((r) => {
        const v = document.querySelector('video');
        if (v) { v.playbackRate = r; if (v.paused) v.play().catch(() => {}); }
      }, RATE);
    }
    if (k % 12 === 0) log(`       ... ${Math.round(s.cur)}/${Math.round(s.dur)}`);
    if (s.ended || s.cur >= s.dur - 1) return { ok: true, why: 'ended' };
  }
  return { ok: false, why: 'timeout' };
}

await connect();
log(`=== run-subject ${SUBJECT_ID} rate=${RATE} ===`);

for (let round = 1; round <= 8; round++) {
  if (!(await alive())) { log('cannot recover the page, stopping'); break; }

  let all;
  try { all = await readProgress(); }
  catch (e) {
    log(`progress read failed (${e.message.slice(0, 60)}) — reloading to refresh the token`);
    await refreshSubject();
    continue;
  }

  // type 10 = course. Other types (URL, survey, exam) are not playable content.
  const todo = all.filter((s) => s.type === 10 && !isDone(s));
  log(`round ${round}: ${todo.length} to study (${all.filter(isDone).length}/${all.length} done)`);
  if (todo.length === 0) { log('all done'); break; }

  let progressed = false;
  for (const c of todo) {
    if (!(await alive())) break;
    try {
      await refreshSubject();
      const status = await subj.evaluate((id) => {
        const row = document.querySelector(`[data-resource-id="${id}"]`);
        const b = row && [...row.querySelectorAll('*')].find((e) => e.children.length === 0 &&
          /开始学习|继续学习|重新学习/.test(e.innerText || ''));
        return b ? b.innerText.trim() : null;
      }, c.courseId).catch(() => null);
      if (status === '重新学习') { log(`  already complete: ${c.name.slice(0, 38)}`); continue; }
      if (!status) { log(`  row not found: ${c.name.slice(0, 38)}`); continue; }

      log(`--- ${c.name.slice(0, 42)} [${status}]`);
      const page = await openCourse(c.courseId);
      if (!page) { log('    could not open'); continue; }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(4000);

      let n = 0;
      for (let w = 0; w < 30; w++) {
        await sleep(1000);
        n = await page.locator('.chapter-item').count().catch(() => 0);
        if (n > 0) break;
      }
      log(`    chapters: ${n}`);
      if (n === 0) { await page.close().catch(() => {}); continue; }

      for (let i = 0; i < n; i++) {
        const r = await playChapter(page, i, n);
        log(`    ch${i + 1}: ${r.ok ? 'OK' : 'INCOMPLETE'} (${r.why})`);
        if (!r.ok && r.why !== 'document') break;
        await sleep(12000);
      }
      await sleep(30000);           // let the final progress POST land
      await page.close().catch(() => {});
      progressed = true;

      const after = await readProgress().catch(() => null);
      if (after) log(`    total done ${after.filter(isDone).length}/${after.length}`);
    } catch (e) {
      log(`  !!! ${c.name.slice(0, 28)}: ${e.message.slice(0, 90)}`);
      try { await connect(); } catch {}
    }
  }
  if (!progressed) { log('no progress this round, stopping'); break; }
}

if (await alive()) {
  const fin = await readProgress().catch(() => []);
  log('=== final ===');
  for (const s of fin) log(`  ${isDone(s) ? '✓' : ' '} type=${String(s.type).padStart(2)} rate=${String(s.rate).padStart(4)} ${s.name.slice(0, 44)}`);
  log(`done ${fin.filter(isDone).length}/${fin.length}`);
}
process.exit(0);
