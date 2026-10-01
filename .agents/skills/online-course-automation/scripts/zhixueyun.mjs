// Platform adapter: 智学云 / 知识中心 (kc.zhixueyun.com).
//
// Everything here was verified against a live account. The endpoints are
// stable-ish, but if a call starts returning 401 or an unexpected shape, do NOT
// guess — run probe-api.mjs while clicking the page and read the real request
// off the wire. Platforms rotate both endpoints and auth formats.
//
// Auth note: this platform's header is literally `Bearer__<access_token>`
// (two underscores), which reads like a typo but is what the client sends.
// A plain `Bearer <token>` returns 401. Confirm with probe-api.mjs before
// changing this.

export const HOST = 'kc.zhixueyun.com';
export const CLIENT_VERSION = '12.1.1';

export const urls = {
  subject: (subjectId) => `https://${HOST}/#/study/subject/detail/${subjectId}`,
};

/** Read the access token the page itself stores. */
export async function readToken(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('token') || '{}').access_token || null;
    } catch {
      return null;
    }
  });
}

/** Headers the platform's own XHRs carry. Version matters on some endpoints. */
export function apiHeaders(token) {
  return {
    Accept: 'application/json',
    Version: CLIENT_VERSION,
    Authorization: `Bearer__${token}`,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

/**
 * All sections of a subject with their completion state.
 * Returns [{ name, sectionId, courseId, rate, finishStatus, required }]
 * finishStatus: 2 = complete. rate is a percentage (0-100) or null if untouched.
 */
export async function listSections(page, subjectId) {
  return page.evaluate(
    async ({ subjectId, version }) => {
      const token = JSON.parse(localStorage.getItem('token') || '{}').access_token;
      const url =
        `/api/v1/course-study/subject/chapter-progress?courseId=${subjectId}` +
        `&knowledgePaymentEnable=false&_=${Date.now()}`;
      const r = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json', Version: version, Authorization: `Bearer__${token}` },
      });
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`chapter-progress returned non-JSON (HTTP ${r.status}): ${text.slice(0, 120)}`);
      }
      if (!Array.isArray(data)) {
        throw new Error(`chapter-progress not an array (HTTP ${r.status}): ${text.slice(0, 160)}`);
      }
      const out = [];
      for (const chapter of data) {
        for (const s of chapter.courseChapterSections || []) {
          out.push({
            name: s.name,
            sectionId: s.id,
            courseId: s.attachmentId,
            rate: s.progress?.completedRate ?? null,
            finishStatus: s.progress?.finishStatus ?? 0,
            required: s.required,
          });
        }
      }
      return out;
    },
    { subjectId, version: CLIENT_VERSION },
  );
}

export const isDone = (s) => s.finishStatus === 2 || (s.rate ?? 0) >= 100;

/**
 * Per-section progress for one course. Returns [{ rate, finishStatus, location, rule, total }].
 * `location` is the string form of the played intervals, e.g. '[[0,1723]]'.
 */
export async function sectionProgress(page, courseId, resourceIds) {
  return page.evaluate(
    async ({ courseId, resourceIds, version }) => {
      const token = JSON.parse(localStorage.getItem('token') || '{}').access_token;
      const r = await fetch('/api/v1/course-study/course-front/course-section-progress', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          Version: version,
          Authorization: `Bearer__${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: `resourceIds=${encodeURIComponent(resourceIds.join(','))}&courseId=${courseId}`,
      });
      const j = await r.json();
      return j.map((it) => ({
        rate: it.completedRate,
        finishStatus: it.finishStatus,
        location: it.courseChapterSection?.completedLocation ?? null,
        rule: it.completedRule,
        total: it.courseChapterSection?.totalTime ?? null,
      }));
    },
    { courseId, resourceIds, version: CLIENT_VERSION },
  );
}

/**
 * The study page is a virtual list: rows scrolled far off-screen are recycled,
 * so a naive click on a cached locator silently does nothing. Always
 * scrollIntoView first and re-read the box right before clicking.
 */
export async function openCourse(subjectPage, courseId) {
  const row = subjectPage.locator(`[data-resource-id="${courseId}"]`).first();
  if (!(await row.count())) return null;

  await subjectPage.evaluate((id) => {
    document.querySelector(`[data-resource-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  }, courseId);
  await subjectPage.waitForTimeout(1200);

  const geo = await subjectPage.evaluate((id) => {
    const row = document.querySelector(`[data-resource-id="${id}"]`);
    if (!row) return null;
    const btn = [...row.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && /开始学习|继续学习|重新学习/.test(e.innerText || ''),
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, status: btn.innerText.trim() };
  }, courseId);
  if (!geo) return null;

  const before = new Set(subjectPage.context().pages());
  await subjectPage.mouse.click(geo.x, geo.y);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await subjectPage.waitForTimeout(800);
    const opened = subjectPage
      .context()
      .pages()
      .find((p) => !before.has(p) && p.url().includes('/study/course/detail'));
    if (opened) return { page: opened, status: geo.status };
  }
  return null;
}
