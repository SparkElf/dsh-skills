// Open exactly one course from the subject page.
//
// Deliberately one at a time: opening many courses in parallel is what the
// platform flags as abnormal learning. The subject list is also a virtual list,
// so this scrolls the target row into view and re-reads its geometry before
// clicking — a cached locator points at a recycled element and clicks nothing.
//
// Run:  node open-course.mjs <courseId> <subjectId>

import { attach, tab } from './cdp.mjs';
import * as zxy from './zhixueyun.mjs';

const [courseId, subjectId] = process.argv.slice(2);
if (!courseId) {
  console.error('usage: node open-course.mjs <courseId> [subjectId]');
  process.exit(1);
}

const { browser, ctx } = await attach();
const page = tab(ctx, subjectId ? `/study/subject/detail/${subjectId}` : '/study/subject/detail');
if (!page) {
  console.error('subject page is not open — open it first so the session is live');
  await browser.close();
  process.exit(1);
}
await page.bringToFront().catch(() => {});

const opened = await zxy.openCourse(page, courseId);
if (!opened) {
  console.error(`could not open ${courseId}: row missing, or no course tab appeared.`);
  console.error('the row may be recycled — retry, or reload the subject page and try again.');
  await browser.close();
  process.exit(1);
}

await opened.page.waitForLoadState('domcontentloaded').catch(() => {});
await opened.page.waitForTimeout(8000);

const info = await opened.page.evaluate(() => {
  const v = document.querySelector('video');
  return {
    chapters: document.querySelectorAll('.chapter-item').length,
    video: v ? Math.round(v.duration || 0) : null,
    progress: (document.body.innerText.match(/课程进度[：:]\s*\d+%/g) || [])[0] || null,
  };
});

console.log(`opened (was "${opened.status}")`);
console.log(`  url:      ${opened.page.url()}`);
console.log(`  chapters: ${info.chapters}`);
console.log(`  video:    ${info.video ? info.video + 's' : 'none (document section)'}`);
console.log(`  progress: ${info.progress}`);
console.log(`\nnext: node play-course.mjs ${courseId}`);

await browser.close();
