// Fetch the result and per-question judging after submitting.
//
// The platform returns one record per question with `isRight` and `score`, which
// makes a targeted review possible — the point of taking an exam, and more
// useful to a learner than the number alone.
//
// Usage:  node exam-result.mjs <examId> [--json]
//   examId is the UUID in #/exam/exam/answer-paper/<examId>

import fs from 'node:fs';
import { attach, tab } from './cdp.mjs';

const args = process.argv.slice(2);
const examId = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const LETTERS = 'ABCDEFGH';

if (!examId) {
  console.error('usage: node exam-result.mjs <examId> [--json]');
  console.error('  examId is the UUID in #/exam/exam/answer-paper/<examId>');
  process.exit(1);
}

const { browser, ctx } = await attach();
const page = tab(ctx, 'kc.zhixueyun.com');
if (!page) { console.error('no kc.zhixueyun.com tab open'); await browser.close(); process.exit(1); }

const data = await page.evaluate(async (eid) => {
  const token = JSON.parse(localStorage.getItem('token') || '{}').access_token;
  const headers = { Accept: 'application/json', Version: '12.1.1', Authorization: `Bearer__${token}` };
  const r = await fetch(`/api/v1/exam/exam/front/answer-record/v2?examId=${eid}&_=${Date.now()}`,
    { credentials: 'include', headers });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  // Fall back to the paper store for question text (the record only has ids).
  let paper = null;
  for (const k of Object.keys(localStorage)) {
    if (/Model\.types\.exam/.test(k)) { try { paper = JSON.parse(localStorage.getItem(k)); } catch {} break; }
  }
  return { status: r.status, body: j, text: text.slice(0, 300), paper };
}, examId);

fs.writeFileSync(`exam-record-${examId.slice(0, 8)}.json`, JSON.stringify(data.body ?? data, null, 2));

if (data.status !== 200 || !data.body) {
  console.error(`could not read the record (HTTP ${data.status}): ${data.text}`);
  console.error('if this is a 401, reload the page to refresh the session token.');
  await browser.close();
  process.exit(2);
}

const records = data.body.answerRecords ?? data.body.data?.answerRecords ?? [];
if (!records.length) { console.error('no answer records returned'); await browser.close(); process.exit(3); }

const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, '').trim();
const qById = {};
if (Array.isArray(data.paper)) {
  for (const g of data.paper) for (const q of g.questions || []) {
    qById[q.id] = {
      stem: clean(q.content),
      group: g.name,
      options: (q.questionAttrCopys || []).slice().sort((a, b) => Number(a.name) - Number(b.name)).map((a) => clean(a.value)),
    };
  }
}

// Score arrives scaled by 100 (88.00 -> 8800) on this platform.
const earned = records.reduce((a, r) => a + (r.score || 0), 0);
const full = records.reduce((a, r) => {
  const type = r.questionCopy?.type;
  return a + (r.questionCopy?.score ?? (type === 2 ? 300 : 200));
}, 0);
const right = records.filter((r) => r.isRight === 1).length;
const wrong = records.filter((r) => r.isRight !== 1);

if (asJson) {
  console.log(JSON.stringify({ earned, full, right, wrong: wrong.length, records }, null, 2));
} else {
  const pct = full ? (earned / full).toFixed(2) : '?';
  console.log(`score : ${pct}  (${right}/${records.length} correct)`);
  console.log(`raw   : earned ${earned} / ${full}`);
  console.log('');
  if (!wrong.length) {
    console.log('no wrong answers.');
  } else {
    console.log(`wrong answers (${wrong.length}):`);
    for (const w of wrong) {
      const q = qById[w.questionId];
      const mine = String(w.answer).split(',').filter((x) => x.trim() !== '')
        .map((x) => (q && /^\d+$/.test(x) ? `${LETTERS[Number(x)]}` : x)).join('');
      console.log('');
      console.log(`  ${q ? `[${q.group}] ` : ''}${q ? q.stem.slice(0, 70) : w.questionId}`);
      console.log(`    my answer: ${mine}    scored 0`);
      if (q) q.options.forEach((o, i) => console.log(`      ${LETTERS[i]}. ${o.slice(0, 56)}`));
    }
  }
}

await browser.close();
