// Fill in exam answers. Never submits.
//
// Answer file: { "<display number>": "B", "26": "ABCD", "36": "A" }
//   1-based display numbers, i.e. the numbers on the answer sheet (and the ones
//   a human would read off the screen).
//   Judgement questions use A = 正确, B = 错误 (matching dd[0]/dd[1]).
//
// Usage:
//   node fill-exam.mjs answers.json            # dry run: verify mapping only
//   node fill-exam.mjs answers.json --write    # actually click
//   node fill-exam.mjs answers.json --write --probe 3   # try one question first
//
// Safety posture: a dry run is the default, `--probe` answers a single question
// and stops, and a mismatch on the first real question aborts the whole run.
// The failure this guards against is silently answering 45 questions by the
// wrong mapping — which is exactly what happened the first time, and it reported
// success while recording nothing.

import fs from 'node:fs';
import { attach, tab } from './cdp.mjs';
import * as ex from './exam-page.mjs';

const args = process.argv.slice(2);
const answerFile = args.find((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
const probeIdx = args.indexOf('--probe');
const PROBE = probeIdx >= 0 ? Number(args[probeIdx + 1] || 1) : 0;

if (!answerFile) {
  console.error('usage: node fill-exam.mjs answers.json [--write] [--probe N]');
  process.exit(1);
}

const answers = JSON.parse(fs.readFileSync(answerFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, ctx } = await attach();
const page = (await ex.findExamPage(ctx)) || tab(ctx, 'kc.zhixueyun.com');
if (!page) { console.error('no exam page open'); await browser.close(); process.exit(1); }
await page.bringToFront().catch(() => {});

const paper = await ex.waitFor(() => ex.readPaper(page), { timeout: 20000 });
if (!paper?.length) { console.error('cannot read the paper'); await browser.close(); process.exit(2); }

const sheet = await ex.readSheet(page);
const layout = await ex.detectLayout(page, paper);
const map = ex.buildMap(paper, sheet);

console.log(`layout   : ${layout.singlePage ? 'single long page' : 'one question at a time'}`);
console.log(`questions: ${paper.length}   answers provided: ${Object.keys(answers).length}`);

// Refuse to run if the sheet id and DOM key disagree anywhere: that means the
// display order assumption is wrong and every answer would land on the wrong question.
const mismatch = map.filter((q) => q.sheetId && q.sheetId !== q.id);
if (mismatch.length) {
  console.error(`\nABORT: ${mismatch.length} question(s) have sheet id != DOM key.`);
  console.error('Run inspect-exam.mjs and reconcile the mapping before answering.');
  await browser.close();
  process.exit(3);
}

const missing = map.filter((q) => !answers[String(q.display)]);
if (missing.length) {
  console.log(`\nnote: ${missing.length} question(s) have no answer and will be skipped:`);
  for (const q of missing.slice(0, 8)) console.log(`  #${q.display}  ${q.stem.slice(0, 40)}`);
  if (missing.length > 8) console.log(`  … and ${missing.length - 8} more`);
}

if (!WRITE) {
  console.log('\nDRY RUN — nothing was clicked.');
  console.log('Review the mapping above, then re-run with --write.');
  console.log('For a limited-attempt exam, start with:  --write --probe 1');
  await browser.close();
  process.exit(0);
}

const targets = PROBE ? map.slice(0, PROBE) : map;
console.log(`\nanswering ${targets.length} question(s)${PROBE ? ' (probe mode)' : ''}…\n`);

let ok = 0, fail = 0;
const failures = [];

for (const q of targets) {
  const want = answers[String(q.display)];
  if (!want) continue;

  const idxs = [...want].map((ch) => ex.LETTERS.indexOf(ch)).filter((i) => i >= 0);
  for (const i of idxs) {
    const before = await ex.readChecked(page, q.id);
    if (before?.includes(ex.LETTERS[i])) continue;      // already selected
    const done = await ex.clickOption(page, q.id, i);
    if (!done) console.log(`  #${q.display}: option ${ex.LETTERS[i]} did not register`);
  }
  await sleep(250);

  const got = await ex.readChecked(page, q.id);
  if (got === want) { ok += 1; console.log(`  ok  #${q.display} [${want}]`); }
  else {
    fail += 1;
    failures.push({ display: q.display, want, got });
    console.log(`  FAIL #${q.display} want ${want} got "${got}"`);
    if (PROBE) {
      console.log('\nprobe failed — stopping so you can inspect the page. Nothing else was touched.');
      break;
    }
  }
}

const counters = await ex.readCounters(page);
console.log(`\nanswered ${ok}, failed ${fail}`);
console.log(`answer sheet now: answered ${counters.answered} / unanswered ${counters.unanswered}`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  #${f.display}: want ${f.want}, got "${f.got}"`);
}
console.log('\nNOT submitted. Run verify-exam.mjs, then submit-exam.mjs when the user agrees.');

await browser.close();
