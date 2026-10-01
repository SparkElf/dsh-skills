// Regression test for the sequence → display-order mapping.
//
// This mapping is the highest-risk piece of the workflow: if it is wrong, every
// answer is written onto the wrong question, and the run still reports success.
// The paper's `sequence` field is scrambled (on the real exam, 单选 occupied
// 3–11 and 20–35, 多选 occupied 1 and 12–36, 判断 occupied 2 and 37–45) while the
// answer sheet simply numbers 1..N grouped by question type.
//
// Run:  node test-mapping.mjs

import { buildMap } from './exam-page.mjs';

// Shape mirrors the real paper: sequence values deliberately scrambled, and
// grouped so that the first 单选 is seq 3, the first 多选 is seq 1, and the
// first 判断 is seq 2 — i.e. sequence order != display order in every group.
const paper = [];
for (let i = 0; i < 25; i += 1) paper.push({ seq: String(i + 3), type: 1, group: '单选', id: `single-${i}`, stem: `s${i}` });
for (let i = 0; i < 10; i += 1) paper.push({ seq: String(i === 0 ? 1 : i + 11), type: 2, group: '多选', id: `multi-${i}`, stem: `m${i}` });
for (let i = 0; i < 10; i += 1) paper.push({ seq: String(i === 0 ? 2 : i + 36), type: 3, group: '判断', id: `judge-${i}`, stem: `j${i}` });

const sheet = [];
for (let i = 1; i <= 45; i += 1) sheet.push({ display: i, id: null, label: String(i) });

const map = buildMap(paper, sheet);
const failures = [];
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
};

check('total mapped', map.length, 45);

// 单选 occupies display 1..25 in paper order
check('first 单选 display', map.find((q) => q.id === 'single-0').display, 1);
check('last 单选 display', map.find((q) => q.id === 'single-24').display, 25);
// 多选 follows at 26..35 even though its sequence starts at 1
check('first 多选 display (seq=1)', map.find((q) => q.id === 'multi-0').display, 26);
check('last 多选 display', map.find((q) => q.id === 'multi-9').display, 35);
// 判断 follows at 36..45 even though its sequence starts at 2
check('first 判断 display (seq=2)', map.find((q) => q.id === 'judge-0').display, 36);
check('last 判断 display', map.find((q) => q.id === 'judge-9').display, 45);

// Every display number is used exactly once.
const displays = map.map((q) => q.display).sort((a, b) => a - b);
check('displays are 1..45 in order', displays.join(','), Array.from({ length: 45 }, (_, i) => i + 1).join(','));

// The specific trap: seq "1" must NOT land on display 1.
const seq1 = map.find((q) => q.seq === '1');
check('seq=1 is not display 1', seq1.display === 1, false);
check('seq=1 is display 26', seq1.display, 26);

if (failures.length) {
  console.error('FAILED:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('mapping tests passed (45 questions, sequence scrambled, grouped order preserved)');
