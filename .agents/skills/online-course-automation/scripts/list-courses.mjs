// Report which sections of a subject are still incomplete.
//
// Always trust this over the page's own "课程进度" text: the UI caches state and
// routinely shows 0% for a section the server has already marked complete.
//
// Run:  node list-courses.mjs <subjectId> [--json]

import { attach, tab } from './cdp.mjs';
import * as zxy from './zhixueyun.mjs';

const subjectId = process.argv[2];
const asJson = process.argv.includes('--json');

if (!subjectId) {
  console.error('usage: node list-courses.mjs <subjectId> [--json]');
  console.error('  the subjectId is the UUID in #/study/subject/detail/<subjectId>');
  process.exit(1);
}

const { browser, ctx } = await attach();
const page = tab(ctx, 'kc.zhixueyun.com');
if (!page) {
  console.error('no kc.zhixueyun.com tab open — log in and open the subject page first');
  await browser.close();
  process.exit(1);
}

let sections;
try {
  sections = await zxy.listSections(page, subjectId);
} catch (e) {
  // A 401 here almost always means the session token expired, not a bad request.
  console.error(`failed: ${e.message}`);
  console.error('if this is a 401, reload the page to refresh the session token, then retry.');
  await browser.close();
  process.exit(2);
}

const todo = sections.filter((s) => !zxy.isDone(s));

if (asJson) {
  console.log(JSON.stringify({ subjectId, total: sections.length, done: sections.length - todo.length, todo }, null, 2));
} else {
  console.log(`subject ${subjectId}`);
  console.log(`completed ${sections.length - todo.length}/${sections.length}   remaining ${todo.length}\n`);
  if (todo.length === 0) {
    console.log('nothing left to study.');
  } else {
    for (const s of todo) {
      const req = s.required ? '必修' : '选修';
      console.log(`  [${req}] rate=${String(s.rate).padStart(4)}  ${s.name}`);
      console.log(`         courseId=${s.courseId}`);
    }
    console.log(`\nnext: node open-course.mjs ${todo[0].courseId}   (then node play-course.mjs ${todo[0].courseId})`);
  }
}

await browser.close();
