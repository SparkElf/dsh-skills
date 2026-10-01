// Determine WHICH click mechanism actually works on an unfamiliar exam page.
//
// Why this exists: on this platform the working target is `label[for]` and only
// a real mouse event registers. Clicking the outer `div.pointer` did nothing,
// and dispatching JS events did nothing either. The first attempt assumed the
// exam page behaved like the course page, reported "45 succeeded", and had in
// fact recorded zero answers.
//
// So: never assume. Run this first, on one question, and read the table.
//
// It tries every plausible mechanism in order and reports which ones change the
// real `checked` state, then restores the question to how it found it.
//
// Usage:
//   node probe-click.mjs                    # probe the first blank question
//   node probe-click.mjs --question 7       # probe display question #7
//   node probe-click.mjs --json

import { attach, tab } from './cdp.mjs';
import * as ex from './exam-page.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const qi = args.indexOf('--question');
const wantDisplay = qi >= 0 ? Number(args[qi + 1]) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Screen coordinates of a sub-element inside one option row. */
function boxFor(page, key, k, sel) {
  return page.evaluate(({ key, k, sel }) => {
    const b = document.querySelector(`.question-type-item[data-dynamic-key="${key}"]`);
    if (!b) return null;
    const dd = b.querySelectorAll('.answer dd')[k];
    if (!dd) return null;
    const t = dd.querySelector(sel);
    if (!t) return null;
    t.scrollIntoView({ block: 'center' });
    const r = t.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { key, k, sel }).catch(() => null);
}

// Ordered from "cheapest if it works" to "most reliable".
const METHODS = [
  {
    id: 'js:input.click',
    kind: 'synthetic',
    note: 'synthetic click on the <input>',
    run: (page, key, k) => page.evaluate(({ key, k }) => {
      const b = document.querySelector(`.question-type-item[data-dynamic-key="${key}"]`);
      const i = b?.querySelectorAll('.answer input')[k];
      if (!i) return false;
      i.click();
      return true;
    }, { key, k }).catch(() => false),
  },
  {
    id: 'js:label.click',
    kind: 'synthetic',
    note: 'synthetic click on label[for]',
    run: (page, key, k) => page.evaluate(({ key, k }) => {
      const b = document.querySelector(`.question-type-item[data-dynamic-key="${key}"]`);
      const dd = b?.querySelectorAll('.answer dd')[k];
      const l = dd?.querySelector('label[for]') || dd?.querySelector('label');
      if (!l) return false;
      l.click();
      return true;
    }, { key, k }).catch(() => false),
  },
  {
    id: 'js:pointer-dispatch',
    kind: 'synthetic',
    note: 'dispatch mousedown/mouseup/click on div.pointer',
    run: (page, key, k) => page.evaluate(({ key, k }) => {
      const b = document.querySelector(`.question-type-item[data-dynamic-key="${key}"]`);
      const dd = b?.querySelectorAll('.answer dd')[k];
      const p = dd?.querySelector('div.pointer, span.pointer') || dd;
      if (!p) return false;
      for (const t of ['mousedown', 'mouseup', 'click']) {
        p.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      }
      return true;
    }, { key, k }).catch(() => false),
  },
  {
    id: 'mouse:pointer',
    kind: 'real',
    note: 'REAL mouse click on div.pointer',
    run: async (page, key, k) => {
      const box = await boxFor(page, key, k, 'div.pointer, span.pointer');
      if (!box) return false;
      await page.mouse.click(box.x, box.y);
      return true;
    },
  },
  {
    id: 'mouse:label[for]',
    kind: 'real',
    note: 'REAL mouse click on label[for]',
    run: async (page, key, k) => {
      const box = await boxFor(page, key, k, 'label[for]');
      if (!box) return false;
      await page.mouse.click(box.x, box.y);
      return true;
    },
  },
  {
    id: 'mouse:input',
    kind: 'real',
    note: 'REAL mouse click on the <input>',
    run: async (page, key, k) => {
      const box = await boxFor(page, key, k, 'input');
      if (!box) return false;
      await page.mouse.click(box.x, box.y);
      return true;
    },
  },
];

const { browser, ctx } = await attach();
const page = (await ex.findExamPage(ctx)) || tab(ctx, 'kc.zhixueyun.com');
if (!page) { console.error('no exam page open'); await browser.close(); process.exit(1); }
await page.bringToFront().catch(() => {});

const paper = await ex.waitFor(() => ex.readPaper(page), { timeout: 20000 });
if (!paper?.length) { console.error('cannot read the paper'); await browser.close(); process.exit(2); }

const sheet = await ex.readSheet(page);
const map = ex.buildMap(paper, sheet);

// Prefer a question with nothing selected: an unambiguous starting state.
let target = null;
if (wantDisplay) {
  target = map.find((q) => q.display === wantDisplay);
} else {
  for (const q of map) {
    const c = await ex.readChecked(page, q.id);
    if (c === '') { target = q; break; }
  }
  target = target || map[0];
}
if (!target) { console.error('question not found'); await browser.close(); process.exit(3); }

const optCount = await page.evaluate((k) =>
  document.querySelectorAll(`.question-type-item[data-dynamic-key="${k}"] .answer dd`).length, target.id);

console.log(`probing question #${target.display} (${optCount} options)`);
console.log(`  ${target.stem.slice(0, 70)}`);
console.log('');
console.log('Each method is tried on an option that is not currently selected, then');
console.log('the real `checked` state is read back. A method "works" only if the');
console.log('target option actually became selected.');
console.log('');

const original = await ex.readChecked(page, target.id);
const results = [];

for (const m of METHODS) {
  // Pick an option we can observe changing.
  const cur = (await ex.readChecked(page, target.id)) ?? '';
  let k = -1;
  for (let i = 0; i < optCount; i += 1) {
    if (!cur.includes(ex.LETTERS[i])) { k = i; break; }
  }
  if (k < 0) break; // everything selected already

  const before = cur;
  let dispatched = false;
  try { dispatched = await m.run(page, target.id, k); } catch { dispatched = false; }
  await sleep(400);
  const after = (await ex.readChecked(page, target.id)) ?? '';

  const selectedTarget = after.includes(ex.LETTERS[k]);
  const changedAtAll = after !== before;
  const worked = dispatched && selectedTarget && before !== after;

  results.push({ id: m.id, kind: m.kind, note: m.note, option: ex.LETTERS[k], dispatched, before, after, worked });
  console.log(`  ${worked ? 'WORKS ' : '  -   '} ${m.id.padEnd(20)} option ${ex.LETTERS[k]}  ${before || '∅'} → ${after || '∅'}`);
}

// Restore the original selection so the probe leaves no stray answer behind
// (a leftover wrong pick would survive a later single-choice fill).
const working = results.filter((r) => r.worked);
if (working.length) {
  const method = METHODS.find((m) => m.id === working[working.length - 1].id);
  const cur = (await ex.readChecked(page, target.id)) ?? '';
  for (let i = 0; i < optCount; i += 1) {
    const shouldBe = original.includes(ex.LETTERS[i]);
    const isNow = cur.includes(ex.LETTERS[i]);
    if (shouldBe !== isNow) {
      await method.run(page, target.id, i);
      await sleep(250);
    }
  }
  const restored = (await ex.readChecked(page, target.id)) ?? '';
  const ok = restored === original;
  console.log('');
  console.log(`restored question #${target.display} to "${original || '∅'}"${ok ? '' : ` (now "${restored}" — check manually)`}`);
}

console.log('');
if (asJson) {
  console.log(JSON.stringify({ display: target.display, stem: target.stem, optCount, original, results }, null, 2));
} else {
  const best = working[working.length - 1];
  if (!best) {
    console.log('NO WORKING CLICK METHOD FOUND.');
    console.log('Nothing registered on this page. Do not run the fill script.');
    console.log('Inspect the option markup and add a candidate to METHODS in this file.');
  } else {
    console.log(`recommended method: ${best.id}`);
    console.log(`  ${best.note}`);
    console.log('');
    if (!working.some((r) => r.kind === 'real')) {
      console.log('(only synthetic events worked here — verify on a second question before bulk running)');
    }
    if (working.length > 1) {
      console.log(`other working methods: ${working.slice(0, -1).map((r) => r.id).join(', ')}`);
    }
  }
}

await browser.close();
