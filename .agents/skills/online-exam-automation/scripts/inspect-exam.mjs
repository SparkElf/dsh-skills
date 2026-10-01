// Read-only exam reconnaissance. Writes nothing, clicks nothing.
//
// Run this FIRST, before any fill script. It tells you the things that decide
// whether the rest of the workflow will work at all:
//
//   * how many questions and of which types,
//   * whether the paper is one long page or one question at a time,
//   * the sequence → display-order → DOM key mapping,
//   * the timer and answered counters.
//
// Usage:  node inspect-exam.mjs [--json]

import { loadPlaywright } from './resolve-playwright.mjs';
import { attach, tab } from './cdp.mjs';
import * as ex from './exam-page.mjs';

const asJson = process.argv.includes('--json');

const { browser, ctx } = await attach();
const page = (await ex.findExamPage(ctx)) || tab(ctx, 'kc.zhixueyun.com');
if (!page) {
  console.error('no exam page found.');
  console.error('open the exam in the browser first — this script never navigates on its own,');
  console.error('because entering an exam can start a timed attempt.');
  await browser.close();
  process.exit(1);
}

const paper = await ex.waitFor(() => ex.readPaper(page), { timeout: 20000 });
if (!paper || !paper.length) {
  console.error(`could not read the paper from ${page.url().slice(0, 100)}`);
  console.error('the exam may not have started yet; readPaper() relies on the paper cache in localStorage.');
  await browser.close();
  process.exit(2);
}

const sheet = await ex.readSheet(page);
const layout = await ex.detectLayout(page, paper);
const map = ex.buildMap(paper, sheet);
const counters = await ex.readCounters(page);

const byGroup = {};
for (const q of paper) byGroup[q.group] = (byGroup[q.group] || 0) + 1;

if (asJson) {
  console.log(JSON.stringify({ layout, counters, byGroup, map }, null, 2));
} else {
  console.log(`exam page : ${page.url().slice(0, 100)}`);
  console.log(`timer     : ${counters.timer ?? 'n/a'}   answered ${counters.answered} / unanswered ${counters.unanswered}`);
  console.log(`questions : ${paper.length}  (${Object.entries(byGroup).map(([k, v]) => `${k} ${v}`).join('  ')})`);
  console.log(`answer sheet entries: ${sheet.length}`);
  console.log('');
  console.log(`layout    : ${layout.singlePage ? 'SINGLE LONG PAGE (sidebar only scrolls)' : 'one question at a time (sidebar switches)'}`);
  console.log(`            ${layout.blocks} question blocks rendered`);
  console.log('');
  console.log('mapping (display order → DOM key):');
  for (const q of map) {
    const stem = q.stem.length > 34 ? q.stem.slice(0, 34) + '…' : q.stem;
    console.log(`  #${String(q.display).padStart(3)}  seq=${String(q.seq).padStart(3)}  ${q.sheetId === q.id ? '' : 'KEY-MISMATCH '}${stem}`);
  }
  const mismatch = map.filter((q) => q.sheetId !== q.id).length;
  console.log('');
  if (mismatch) {
    console.log(`WARNING: ${mismatch} question(s) where the sheet id != DOM key.`);
    console.log('The display order may not follow 单选/多选/判断 grouping on this platform.');
    console.log('Do not run the fill script until you reconcile this.');
  } else {
    console.log('sheet id == DOM key for every question — the mapping is safe to use.');
  }
}

await browser.close();
