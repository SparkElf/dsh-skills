// Exam-page primitives for 智学云 / 知识中心 style exam pages.
//
// Each function here encodes a behaviour that was established by testing against
// a live exam page. Where something looks odd, the comment says why — the
// obvious implementation was usually wrong first.
//
// Platform quirks, all verified:
//   * All questions can live in ONE long page; the sidebar then only scrolls.
//     Detect with countBlocks() vs the reported question count.
//   * Options respond only to a real mouse click on `label[for]`. Clicking the
//     outer `div.pointer`, or dispatching JS events on the label, does nothing.
//   * Question `sequence` in the paper data is NOT the display order used by the
//     answer sheet. The sheet is grouped 单选 → 多选 → 判断 and numbered 1..N.

export const HOST = 'kc.zhixueyun.com';
export const CLIENT_VERSION = '12.1.1';
export const LETTERS = 'ABCDEFGH';

/** Exam pages are hash-routed; this matches both the paper and result views. */
export const EXAM_URL = '/exam/exam/answer-paper';

const norm = (s) => (s || '').replace(/\s+/g, '');

export async function findExamPage(ctx, { timeout = 15000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = ctx.pages().find((p) => p.url().includes(EXAM_URL));
    if (page) return page;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

/** Poll a page-side reader until it returns something truthy. */
export async function waitFor(read, { timeout = 30000, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await read().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}

/**
 * Read the paper structure from the page's own store.
 *
 * Returns null unless the page really is the exam we care about: the paper is
 * cached in localStorage under a key that survives navigating away, so a stale
 * tab can otherwise "read" a paper from a previous exam and produce a confident
 * but completely wrong report.
 */
export async function readPaper(page) {
  const onExam = page.url().includes(EXAM_URL);
  const hasBlocks = (await page.evaluate(
    () => document.querySelectorAll('.question-type-item[data-dynamic-key]').length,
  )) > 0;
  if (!onExam && !hasBlocks) return null;

  return page.evaluate(() => {
    let raw = null;
    for (const k of Object.keys(localStorage)) {
      if (/Model\.types\.exam/.test(k)) { raw = localStorage.getItem(k); break; }
    }
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch { return null; }
    const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    const out = [];
    for (const g of data) {
      for (const q of g.questions || []) {
        out.push({
          seq: String(q.sequence),
          type: q.type,
          group: g.name,
          id: q.id,
          stem: clean(q.content),
          options: (q.questionAttrCopys || [])
            .slice()
            .sort((a, b) => Number(a.name) - Number(b.name))
            .map((a) => clean(a.value)),
        });
      }
    }
    return out.length ? out : null;
  });
}

/** The answer-sheet entries, in display order. */
export async function readSheet(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('a.list-item[data-id]')].map((e, i) => ({
      display: i + 1,
      id: e.getAttribute('data-id'),
      label: (e.innerText || '').trim(),
    })),
  );
}

export const countBlocks = (page) =>
  page.evaluate(() => document.querySelectorAll('.question-type-item[data-dynamic-key]').length);

/**
 * Map each question to its answer-sheet position and its DOM key.
 *
 * `sequence` is scrambled in the paper data, so the sheet position is derived
 * from the group order instead. Getting this wrong silently answers the wrong
 * questions, which is the single most expensive mistake in this workflow.
 */
export function buildMap(paper, sheet) {
  const ORDER = ['单选', '多选', '判断'];
  const seen = new Set();
  const order = [...new Set(paper.map((q) => q.group))].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const byGroup = {};
  for (const g of order) byGroup[g] = paper.filter((q) => q.group === g);

  const map = [];
  let display = 0;
  for (const g of order) {
    for (const q of byGroup[g]) {
      display += 1;
      const entry = sheet[display - 1];
      map.push({
        ...q,
        display,
        sheetId: entry?.id ?? null,
        sheetLabel: entry?.label ?? null,
      });
      seen.add(q.id);
    }
  }
  return map;
}

/** Layout report: are all questions on one page, or one at a time? */
export async function detectLayout(page, paper) {
  const blocks = await countBlocks(page);
  return {
    blocks,
    questions: paper.length,
    singlePage: blocks >= paper.length && paper.length > 0,
  };
}

/** A question's currently selected letters, e.g. 'AB'. */
export function readChecked(page, domKey) {
  return page.evaluate((k) => {
    const b = document.querySelector(`.question-type-item[data-dynamic-key="${k}"]`);
    if (!b) return null;
    return [...b.querySelectorAll('.answer input')]
      .map((x, i) => (x.checked ? String.fromCharCode(65 + i) : ''))
      .join('');
  }, domKey);
}

/**
 * Click one option with a real mouse event.
 * Returns true when the option ended up selected.
 */
export async function clickOption(page, domKey, index) {
  const box = await page.evaluate(({ k, n }) => {
    const b = document.querySelector(`.question-type-item[data-dynamic-key="${k}"]`);
    if (!b) return null;
    const dd = b.querySelectorAll('.answer dd')[n];
    if (!dd) return null;
    // label[for] is the only reliable hit target; div.pointer does nothing.
    const target = dd.querySelector('label[for]') || dd.querySelector('label');
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { k: domKey, n: index }).catch(() => null);
  if (!box) return false;

  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(300);
  const after = await readChecked(page, domKey);
  return Boolean(after && after.includes(LETTERS[index]));
}

/** Answer-sheet counters as shown in the UI. */
export function readCounters(page) {
  return page.evaluate(() => {
    // Defined inside the callback: page.evaluate runs in the browser, so a
    // module-scope helper would not be visible here.
    const norm = (s) => (s || '').replace(/\s+/g, '');
    return {
      answered: norm(document.querySelector('.text-answerd')?.innerText ?? ''),
      unanswered: norm(document.querySelector('.text-no-mark')?.innerText ?? ''),
      pending: norm(document.querySelector('.text-no-evaluate')?.innerText ?? ''),
      timer: (document.body.innerText.match(/\d{2}:\d{2}:\d{2}/) || [])[0] || null,
    };
  });
}

/** Click a visible button whose text matches, ignoring internal whitespace. */
export async function clickByText(page, pattern) {
  const box = await page.evaluate((src) => {
    const re = new RegExp(src);
    const byText = (e) => re.test((e.innerText || '').replace(/\s+/g, ''));
    const inDialog = (e) => Boolean(e.closest('[class*=dialog],[class*=modal],[class*=popup],[class*=confirm]'));
    const cands = [...document.querySelectorAll('button,.el-button,[class*=btn],div,span')]
      .filter((e) => e.offsetParent !== null && e.children.length === 0 && byText(e));
    if (!cands.length) return null;
    // Prefer the one inside a dialog so we never hit a background control.
    const el = cands.find(inDialog) || cands[0];
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.innerText };
  }, pattern.source).catch(() => null);
  if (!box) return null;
  await page.mouse.click(box.x, box.y);
  return box.text;
}

/** Visible dialog text, for detecting confirmations and result popups. */
export function visibleDialogs(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[class*=dialog],[class*=modal],[class*=popup],[class*=confirm]')]
      .filter((d) => d.offsetParent !== null)
      .map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  );
}

/** Exam metadata from the subject section (score, attempt status). */
export async function readExamSection(page, subjectId) {
  return page.evaluate(async (sid) => {
    const token = JSON.parse(localStorage.getItem('token') || '{}').access_token;
    const r = await fetch(
      `/api/v1/course-study/subject/chapter-progress?courseId=${sid}&knowledgePaymentEnable=false&_=${Date.now()}`,
      { credentials: 'include', headers: { Accept: 'application/json', Version: '12.1.1', Authorization: `Bearer__${token}` } },
    );
    const j = await r.json();
    const out = [];
    for (const ch of j) for (const s of ch.courseChapterSections || []) {
      out.push({
        name: s.name,
        type: s.sectionType,
        rate: s.progress?.completedRate ?? null,
        finish: s.progress?.finishStatus ?? 0,
        score: s.progress?.score ?? null,
        examStatus: s.progress?.examStatus ?? null,
      });
    }
    return out;
  }, subjectId);
}
