// Submit a filled exam. Requires explicit confirmation.
//
// A limited-attempt exam cannot be undone once submitted, so this script is
// deliberately hard to run by accident:
//   * it refuses to submit while any question is blank,
//   * it refuses unless --yes is passed,
//   * it verifies the server actually accepted the paper and reports the result.
//
// Usage:  node submit-exam.mjs --yes [--allow-blank]

import { attach, tab } from './cdp.mjs';
import * as ex from './exam-page.mjs';

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const ALLOW_BLANK = args.includes('--allow-blank');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CONFIRMED) {
  console.error('refusing to submit without confirmation.');
  console.error('submitting a limited-attempt exam cannot be undone.');
  console.error('');
  console.error('run verify-exam.mjs first, get the user\'s explicit agreement, then:');
  console.error('  node submit-exam.mjs --yes');
  process.exit(1);
}

const { browser, ctx } = await attach();
const page = await ex.findExamPage(ctx);
if (!page) { console.error('no exam page open'); await browser.close(); process.exit(1); }
await page.bringToFront().catch(() => {});

// Pre-flight: never submit a paper with blanks unless explicitly allowed.
const counters = await ex.readCounters(page);
console.log(`before submit: answered ${counters.answered} / unanswered ${counters.unanswered} / remaining ${counters.timer ?? 'n/a'}`);
if (counters.unanswered !== '0' && !ALLOW_BLANK) {
  console.error(`\nABORT: ${counters.unanswered} question(s) still blank.`);
  console.error('answer them, or pass --allow-blank if a blank is intentional.');
  await browser.close();
  process.exit(2);
}

// Capture the submit response so success is proven, not assumed.
const responses = [];
page.on('response', async (r) => {
  if (!/submitPaper/i.test(r.url())) return;
  try { responses.push({ status: r.status(), body: (await r.text()).slice(0, 500) }); } catch {}
});

const clicked = await ex.clickByText(page, /^我要交卷$/);
if (!clicked) { console.error('could not find the 交卷 button'); await browser.close(); process.exit(3); }
console.log(`clicked "${clicked.replace(/\s+/g, '')}"`);
await sleep(2500);

// Handle the confirmation dialog. Its buttons may be spaced ("确 定"), so match
// on whitespace-stripped text.
let confirmed = false;
for (let round = 0; round < 3 && !confirmed; round += 1) {
  const dialogs = await ex.visibleDialogs(page);
  if (!dialogs.length) break;
  console.log(`dialog: ${dialogs[0].slice(0, 80)}`);
  const hit = await ex.clickByText(page, /^(确定|确认|是|继续交卷)$/);
  if (!hit) { console.log('no confirm button found in the dialog'); break; }
  console.log(`confirmed via "${hit.replace(/\s+/g, '')}"`);
  confirmed = true;
  await sleep(4000);
}

// Wait for the server's verdict rather than trusting the UI.
let verdict = null;
for (let i = 0; i < 20 && !verdict; i += 1) {
  await sleep(1000);
  if (responses.length) {
    for (const r of responses) {
      try {
        const j = JSON.parse(r.body);
        if (j.status === 1 || j.success) verdict = j;
      } catch {}
    }
  }
}

const dialogs = await ex.visibleDialogs(page);
console.log('');
if (verdict) {
  console.log(`SUBMITTED — server said: ${JSON.stringify(verdict).slice(0, 200)}`);
  process.exitCode = 0;
} else if (dialogs.some((d) => /交卷成功|提交成功/.test(d))) {
  console.log('SUBMITTED — success dialog shown (no response body captured)');
  process.exitCode = 0;
} else {
  console.log('NOT CONFIRMED — the page did not report success.');
  console.log(`dialogs: ${JSON.stringify(dialogs).slice(0, 300)}`);
  console.log('check the browser before retrying; the attempt may or may not be used.');
  process.exitCode = 4;
}

await browser.close();
