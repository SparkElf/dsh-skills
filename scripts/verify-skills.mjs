#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const skillsRoot = join(repoRoot, '.agents', 'skills');
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const fieldPattern = /^\s*(name|description)\s*:\s*(.*?)\s*$/gmu;

const errors = [];
const skills = [];

for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const skillName = entry.name;
  const skillPath = join(skillsRoot, skillName);
  if (!statSync(skillPath).isDirectory()) continue;
  const skillFile = join(skillPath, 'SKILL.md');
  if (!namePattern.test(skillName)) {
    errors.push(`${skillName}: directory name is not kebab-case`);
    continue;
  }
  try {
    statSync(skillFile);
  } catch {
    errors.push(`${skillName}: missing SKILL.md`);
    continue;
  }
  const source = readFileSync(skillFile, 'utf8');
  const frontmatter = source.match(frontmatterPattern);
  if (!frontmatter) {
    errors.push(`${skillName}: missing YAML frontmatter`);
    continue;
  }
  const fields = Object.fromEntries([...frontmatter[1].matchAll(fieldPattern)].map((match) => [match[1], match[2].replace(/^['"]|['"]$/gu, '')]));
  if (!fields.name) errors.push(`${skillName}: missing frontmatter name`);
  if (!fields.description) errors.push(`${skillName}: missing frontmatter description`);
  if (fields.name && fields.name !== skillName) errors.push(`${skillName}: frontmatter name is ${fields.name}`);
  skills.push({
    name: skillName,
    description: fields.description ?? '',
    path: relative(repoRoot, skillFile),
  });
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  const catalog = {
    schemaVersion: 1,
    repository: 'SparkElf/dsh-skills',
    source: '.agents/skills',
    skillCount: skills.length,
    skills,
  };
  writeFileSync(join(repoRoot, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Validated ${skills.length} skills and wrote catalog.json`);
}
