
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Translate each skill's routing string and body summary into Chinese, caching by the source
// blob hash so an unchanged SKILL.md is never re-sent. The English description keeps reaching
// the model unchanged; only the rendered copy is replaced.
//
// Every skill keeps its translation in its own skill directory, so a skill and its Chinese
// travel together and the distribution repository ships both in one clone.
const BASE = 'https://www.tokensfree.eu.cc/v1'
const MODEL = 'deepseek-v4.1-flash'
const DSH_SKILLS = '/root/projects/dsh-skills'
const HOSTED = join(DSH_SKILLS, '.agents', 'skills')
const USER_SKILLS = '/root/.agents/skills'
const PLUS = '/root/.dsh/profiles/plus/node_modules'
const PROGRESS = join(DSH_SKILLS, 'i18n', '.progress.json')

// Bundled skills ship inside a plugin package rather than a skill root.
const BUNDLED = {
  'genui': [join(PLUS, '@sparkelf/dsh-genui/SKILL.md'), join('/root/projects/dsh-genui', 'i18n', 'zh.json')],
  'office-government-docs': [
    join(PLUS, '@sparkelf/dsh-office-viewer-fonts/skills/office-government-docs/SKILL.md'),
    join('/root/projects/dsh-plugins-plus/packages/office-viewer-fonts/skills/office-government-docs', 'i18n', 'zh.json'),
  ],
}

const key = (() => {
  const txt = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.+)$/m)
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
})()
if (!key) { console.error('no DEEPSEEK_API_KEY'); process.exit(2) }

const hashOf = (p) => execFileSync('git', ['hash-object', p], { encoding: 'utf8' }).trim()

/** Where a skill's translation and source live, in the panel's resolution order. */
function locate(name) {
  const hosted = join(HOSTED, name, 'SKILL.md')
  if (existsSync(hosted)) {
    return {
      sourcePath: hosted,
      translationPath: join(HOSTED, name, 'i18n', 'zh.json'),
      // The distribution copy is committed, so its hash is the reuse key.
      repo: DSH_SKILLS,
    }
  }
  const user = join(USER_SKILLS, name, 'SKILL.md')
  if (existsSync(user)) {
    return {
      sourcePath: user,
      translationPath: join(USER_SKILLS, name, 'i18n', 'zh.json'),
      repo: null,
    }
  }
  const bundled = BUNDLED[name]
  if (bundled) return { sourcePath: bundled[0], translationPath: bundled[1], repo: null }
  return null
}

const res = await fetch('http://127.0.0.1:3080/api/dsh-skill-center/list')
const payload = await res.json()
const roster = []
for (const group of payload.groups ?? []) {
  for (const skill of group.skills ?? []) {
    const loc = locate(skill.name)
    if (loc === null) { console.error('unresolved: ' + skill.name); continue }
    roster.push({
      name: skill.name,
      level: group.key,
      description: skill.description ?? '',
      whenToUse: skill.whenToUse ?? null,
      ...loc,
      bodyBytes: statSync(loc.sourcePath).size,
    })
  }
}

const args = process.argv.slice(2)
const only = args.filter(a => !a.startsWith('--'))
const force = args.includes('--force')
const targets = only.length ? roster.filter(r => only.includes(r.name)) : roster

const writeProgress = (state) => {
  mkdirSync(dirname(PROGRESS), { recursive: true })
  writeFileSync(PROGRESS, JSON.stringify(state, null, 2) + '\n')
}

// The terminology table is the repository's own authority for how a term is rendered.
const terminology = readFileSync('/root/projects/deepseek-harness-plus/docs/i18n/terminology.md', 'utf8')
const rows = terminology.split('\n').filter(l => /^\|/.test(l)).slice(0, 120).join('\n')

const SYSTEM = [
  '你是 DSH（DeepSeek Harness）文档的中英翻译。把给定的技能元数据翻译成简体中文。',
  '',
  '规则：',
  '1. 只输出 JSON，不要 markdown 代码块，不要解释。',
  '2. 字段：title（技能的中文短标题，名词性）、description（技能简介的中文翻译）、summary（正文摘要，中文）。',
  '2a. 字数硬上限：title ≤ 10 字，description ≤ 120 字，summary ≤ 120 字。超限必须压缩，宁可少说也不要超。',
  '3. description 是给模型判断"何时该调用这个技能"的路由信号，翻译要保住触发条件，不要意译成宣传语。',
  '4. summary 概括正文的核心内容：这个技能做什么、覆盖什么场景。不要罗列章节标题。',
  '5. 术语按下方术语表。表里"中文"列为英文的，保留英文不译（如 API、PR）。',
  '',
  '术语表（节选）：',
  rows,
].join('\n')

const results = { ok: [], failed: [], skipped: [] }
writeProgress({ total: targets.length, done: 0, current: null, startedAt: new Date().toISOString(), finishedAt: null })

let index = 0
for (const skill of targets) {
  index += 1
  const sourceHash = hashOf(skill.sourcePath)
  if (!force && existsSync(skill.translationPath)) {
    try {
      const prev = JSON.parse(readFileSync(skill.translationPath, 'utf8'))
      if (prev._meta?.sourceHash === sourceHash) {
        results.skipped.push(skill.name)
        writeProgress({ total: targets.length, done: index, current: skill.name, reused: true, startedAt: null, finishedAt: null })
        continue
      }
    } catch { /* A malformed record is re-translated rather than trusted. */ }
  }
  // The largest skill is 109KB, which would crowd out the instructions, so the head carries
  // the framing and the model summarizes from it.
  const body = readFileSync(skill.sourcePath, 'utf8')
  const head = body.slice(0, 6000)
  const user = [
    '技能名（标识符，不翻译）：' + skill.name,
    '面板显示的英文简介：' + skill.description,
    skill.whenToUse ? 'when-to-use：' + skill.whenToUse : '',
    '',
    'SKILL.md 开头（可能被截断）：',
    '---',
    head,
    '---',
  ].filter(Boolean).join('\n')

  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        temperature: 0.2,
        max_tokens: 1200,
      }),
    })
    if (!res.ok) throw new Error('http ' + res.status + ' ' + (await res.text()).slice(0, 200))
    const data = await res.json()
    let text = data.choices?.[0]?.message?.content ?? ''
    text = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(text)
    mkdirSync(dirname(skill.translationPath), { recursive: true })
    writeFileSync(skill.translationPath, JSON.stringify({
      _meta: {
        sourceHash,
        model: MODEL,
        translatedAt: new Date().toISOString(),
      },
      title: parsed.title,
      description: parsed.description,
      summary: parsed.summary,
    }, null, 2) + '\n')
    results.ok.push(skill.name)
    writeProgress({ total: targets.length, done: index, current: skill.name, startedAt: null, finishedAt: null })
    console.log('OK    ' + skill.name.padEnd(42) + String(parsed.title ?? '').slice(0, 20))
  } catch (error) {
    results.failed.push({ name: skill.name, error: String(error).slice(0, 160) })
    writeProgress({ total: targets.length, done: index, current: skill.name, failed: true, startedAt: null, finishedAt: null })
    console.log('FAIL  ' + skill.name.padEnd(42) + String(error).slice(0, 90))
  }
}

writeProgress({
  total: targets.length,
  done: targets.length,
  current: null,
  ok: results.ok.length,
  skipped: results.skipped.length,
  failed: results.failed.length,
  startedAt: null,
  finishedAt: new Date().toISOString(),
})
console.log()
console.log('ok=' + results.ok.length + ' skipped=' + results.skipped.length + ' failed=' + results.failed.length)
if (results.failed.length) console.log(JSON.stringify(results.failed, null, 2))
