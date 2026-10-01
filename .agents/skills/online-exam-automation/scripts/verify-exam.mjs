// Independently re-read every answer from the page and compare with the file.
//
// Deliberately a separate process from fill-exam.mjs: if the two shared state,
// a bug in the fill step would be copied verbatim by the check and reported as
// "verified". Reading it back from the DOM is what makes this a real check.
//
// Usage:  node verify-exam.mjs answers.json [--json]

import fs from 'node:fs';
import { attach, tab } from './cdp.mjs';
import * as ex from './exam-page.mjs';

const args = process.argv.slice(2);
const answerFile = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
if (!answerFile) { console.error('usage: node verify-exam.mjs answers.json [--json]'); process.exit(1); }

const answers = JSON.parse(fs.readFileSync(answerFile, 'utf8'));

const { browser, ctx } = await attach();
const page = (await ex.findExamPage(ctx)) || tab(ctx, 'kc.zhixueyun.com');
if (!page) { console.error('no exam page open'); await browser.close(); process.exit(1); }

const paper = await ex.waitFor(() => ex.readPaper(page), { timeout: 20000 });
if (!paper?.length) { console.error('cannot read the paper'); await browser.close(); process.exit(2); }

const sheet = await ex.readSheet(page);
const map = ex.buildMap(paper, sheet);

const rows = [];
for (const q of map) {
  const want = answers[String(q.display)] ?? null;
  // Re-read straight from the DOM rather than trusting anything cached.
  const got = await ex.readChecked(page, q.id);
  rows.push({ display: q.display, stem: q.stem.slice(0, 40), want, got, ok: want === null ? null : got === want });
}

const checked = rows.filter((r) => r.ok !== null);
const mismatched = checked.filter((r) => !r.ok);
const unanswered = rows.filter((r) => r.got === '' || r.got === null);
const counters = await ex.readCounters(page);

if (asJson) {
  console.log(JSON.stringify({ counters, total: rows.length, mismatched, unanswered, rows }, null, 2));
} else {
  console.log(`verified ${checked.length} answered question(s) out of ${rows.length}`);
  console.log(`mismatches : ${mismatched.length}`);
  console.log(`blank      : ${unanswered.length}`);
  console.log(`sheet      : answered ${counters.answered} / unanswered ${counters.unanswered}`);
  if (mismatched.length) {
    console.log('\nmismatches:');
    for (const m of mismatched) console.log(`  #${m.display}  want ${m.want}  got "${m.got}"  ${m.stem}`);
  }
  if (unanswered.length) {
    console.log('\nblank questions:');
    for (const u of unanswered) console.log(`  #${u.display}  ${u.stem}`);
  }
  console.log('');
  console.log(mismatched.length === 0 && unanswered.length === 0
    ? 'all answers match the file — safe to submit'
    : 'NOT ready to submit');
}

await browser.close();
process.exit(mismatched.length === 0 && unanswered.length === 0 ? 0 : 1);
