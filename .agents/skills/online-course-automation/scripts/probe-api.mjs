// Discover how a course platform reports study progress.
//
// Use this first on any platform you have not automated before. Click around
// the course page yourself while it runs; it records every progress-shaped
// request with its body and response, which is how you learn three things:
//
//   * which endpoint carries progress,
//   * what "completed" means (a percentage rule? a seconds threshold?),
//   * what user action actually fires the report.
//
// Run:  node probe-api.mjs [seconds] [url-filter]
// Example: node probe-api.mjs 180 course-study

import { attach } from './cdp.mjs';

const seconds = Number(process.argv[2] || 120);
const filter = new RegExp(process.argv[3] || 'progress|record|score|study', 'i');

const { browser, ctx } = await attach();
const page = ctx.pages().find((p) => /^https?:/.test(p.url()));
if (!page) {
  console.error('no http(s) tab found');
  await browser.close();
  process.exit(1);
}
console.log(`watching ${page.url().slice(0, 100)} for ${seconds}s — drive the page now\n`);

// Hook the page's own network layer so we see the request the framework sends,
// including its auth headers and encoded body.
await page.evaluate(() => {
  window.__probe = [];
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__m = m;
    this.__u = u;
    return open.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    (this.__h = this.__h || {})[k] = v;
    return setHeader.call(this, k, v);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = String(this.__u || '');
    if (/progress|record|score|study|section/i.test(url)) {
      this.addEventListener('load', () =>
        window.__probe.push({
          method: this.__m,
          url,
          headers: this.__h || {},
          body: String(body || ''),
          response: String(this.responseText || '').slice(0, 600),
        }),
      );
    }
    return send.call(this, body);
  };
});

const started = Date.now();
while ((Date.now() - started) / 1000 < seconds) {
  await new Promise((r) => setTimeout(r, 5000));
  const seen = await page.evaluate(() => window.__probe?.length ?? 0).catch(() => 0);
  process.stdout.write(`\r  requests captured: ${seen}   `);
}

const entries = await page.evaluate(() => window.__probe || []);
const hits = entries.filter((e) => filter.test(e.url));
console.log(`\n\ncaptured ${entries.length} progress-shaped request(s), ${hits.length} matching ${filter}\n`);

for (const [i, e] of hits.entries()) {
  console.log(`--- #${i + 1} ${e.method} ${e.url.replace(/^https?:\/\/[^/]+/, '')}`);
  const auth = e.headers.Authorization || e.headers.authorization;
  // Never print the credential itself — this output gets pasted into issues and
  // shared with other people. Only the scheme prefix and separator matter for
  // debugging (this platform uses `Bearer__<token>`, not `Bearer <token>`).
  const authLabel = auth ? auth.replace(/\S*$/, '<redacted>') : '(cookie-based)';
  console.log(`    auth: ${authLabel}`);
  if (e.body) console.log(`    body: ${decodeURIComponent(e.body).slice(0, 300)}`);
  let parsed = e.response;
  try {
    const j = JSON.parse(e.response);
    const o = Array.isArray(j) ? j[0] : j;
    const pick = {};
    for (const k of Object.keys(o || {})) {
      if (/rate|rule|status|location|time|finish|complete/i.test(k)) pick[k] = o[k];
    }
    parsed = JSON.stringify(pick).slice(0, 400);
  } catch {}
  console.log(`    resp: ${parsed}\n`);
}

await browser.close();
