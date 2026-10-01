// Resolve Playwright from wherever it happens to be installed.
//
// A skill directory has no node_modules of its own, and it is usually symlinked
// into a workspace from somewhere else, so a bare `import 'playwright'` fails.
// Resolution order:
//
//   1. normal resolution (works when run from a project that has it)
//   2. $PLAYWRIGHT_MODULE — explicit escape hatch
//   3. node_modules next to the current working directory, then walking up
//   4. the same walk for any sibling project that already has Playwright
//
// Step 4 matters in practice: automation runs tend to live in a scratch project
// beside the skill, and requiring a fresh install for every skill is noise.

import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const PACKAGE = 'playwright';

function dirsUpwards(from, levels = 6) {
  const out = [];
  let dir = resolve(from);
  for (let i = 0; i < levels; i++) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function siblingProjects(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name, 'node_modules', PACKAGE));
  } catch {
    return [];
  }
}

function* candidateDirs() {
  if (process.env.PLAYWRIGHT_MODULE) yield process.env.PLAYWRIGHT_MODULE;

  for (const dir of dirsUpwards(process.cwd())) yield join(dir, 'node_modules', PACKAGE);

  const home = homedir();
  yield join(home, 'node_modules', PACKAGE);
  for (const base of [join(home, 'projects'), join(home, 'src'), home]) {
    yield* siblingProjects(base);
  }
}

export async function loadPlaywright() {
  const tried = [];

  try {
    return await import(PACKAGE);
  } catch {
    tried.push('(normal resolution)');
  }

  for (const dir of candidateDirs()) {
    if (!dir || !existsSync(dir)) continue;
    for (const entry of ['index.mjs', 'index.js']) {
      const file = join(dir, entry);
      if (!existsSync(file)) continue;
      try {
        return await import(pathToFileURL(file).href);
      } catch (e) {
        tried.push(`${file}: ${e.message.slice(0, 70)}`);
      }
    }
  }

  throw new Error(
    'cannot load playwright.\n' +
      'Fix it either way:\n' +
      '  npm i playwright && npx playwright install chromium\n' +
      '  PLAYWRIGHT_MODULE=/abs/path/node_modules/playwright node scripts/list-courses.mjs <subjectId>\n' +
      `tried:\n${tried.map((t) => '  - ' + t).join('\n')}`,
  );
}
