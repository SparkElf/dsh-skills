---
name: dsh-skill-discovery-links
description: DSH 技能中心的技能不显示、想让某个目录（如代码仓库自带的 .agents/skills）的技能被自动发现、或要新增/迁移技能目录时使用。讲清技能中心的 6 类扫描根、为什么仓库自带的技能默认看不见、为什么不该用 customSkillDirs 改 profile、以及幂等同步脚本的用法。
---

# 让 DSH 技能中心发现非工作区目录的技能

这个技能解决：**技能文件明明存在、格式也对，技能中心却看不到。**

## 1. 技能中心只扫 6 类根

来源：`@sparkelf/dsh-client-ui-skill-center` 的 `localSkillRoots()`。

| 分组 key | 路径 | 作用域 |
|---|---|---|
| `bundled` | 随发行版打包 | 全局内置 |
| `project-dsh` | `<工作区根>/.dsh/skills` | 仅该工作区 |
| `project-agents` | `<工作区根>/.agents/skills` | 该工作区，随项目提交 |
| `custom` | `customSkillDirs` 配置项 | 本插件配置 |
| `user-dsh` | `$DSH_HOME/skills` | 本机所有项目 |
| `user-agents` | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） | 本机所有项目 |

**关键点**：`<工作区根>` 取自工作区注册表（`/root/.dsh/storages/workspace.json` 的 `tables.workspaces[*].path`），**不是当前 shell 的 cwd**。所以一个子目录（例如 `/root/projects/deepseek-harness-plus/.agents/skills`）里的技能，**不会**因为它在工作区内就被扫到 —— 只有工作区根那一层的 `.agents/skills` 才算。

这就是「仓库自带技能看不见」的原因。

## 2. 判定一个技能文件是否合规

技能中心对每个条目依次要求：

1. **目录名**（或去掉 `.md` 的文件名）匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` —— 小写字母、数字、单连字符，不满足直接跳过。
2. **存在 `SKILL.md`**（目录布局），或本身是一个 `.md` 文件（扁平布局）。
3. 文件**可读**（`readFile` 失败则静默跳过）。
4. frontmatter 用 `---` 包裹，`description:` 在其中。

自查（无需启动服务）：

```bash
node -e '
const fs=require("fs");
const root="/root/projects/.agents/skills";
for(const e of fs.readdirSync(root,{withFileTypes:true})){
  const name=e.name.replace(/\.md$/u,"");
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)){console.log("✗ 名字不合规",name);continue}
  const p=root+"/"+e.name+"/SKILL.md";
  if(!fs.existsSync(p)){console.log("✗ 缺 SKILL.md",name);continue}
  const src=fs.readFileSync(p,"utf8");
  const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if(!m){console.log("✗ 无 frontmatter",name);continue}
  const d=/^\s*description\s*:\s*(.+?)\s*$/mu.exec(m[1]);
  console.log(d?"✓":"⚠ 无 description",name);
}'
```

注意 `role: "user"` 之类的字段不存在；控制可见性用的是 `invocation: user|model` 与 `disable-model-invocation`。

**权限不是门槛**：扫描用 `existsSync` + `readFile`，以 root 运行时 600 也能读。但把技能文件设成 644、目录 755 与其它技能保持一致，免得将来换成非 root 运行才踩坑。

## 3. 不要用 `customSkillDirs` 改 profile（重要）

`customSkillDirs` 确实是插件支持的配置项，但配置它要写进 profile 的 `cordis.patch.yml`，而那个文件**会被 `dsh-plus` 整文件覆盖**：

```js
// @sparkelf/dsh-plus 的 writeCapabilityPatch()
writeFileSync(path, capabilityPatchLayer(answers))   // 不做合并
```

触发条件是 `created || !exists($DSH_HOME/capabilities.json)`。**只要 `capabilities.json` 不存在，任何人下一次跑 `dsh-plus start`（或任何走到能力引导的路径）都会把 profile 层的手工条目全部冲掉**，只留一份 `.before-capabilities` 备份。

所以：**优先用软链接**。它不碰 profile，`dsh-plus` 升级、能力引导重跑都不影响。

## 4. 同步脚本

脚本：`/root/projects/scripts/sync-harness-skills.sh`

把仓库自带的技能软链到工作区技能目录：

```bash
sync-harness-skills.sh           # 补链，幂等
sync-harness-skills.sh --dry-run # 只报告
sync-harness-skills.sh --prune   # 额外清理失效链接
sync-harness-skills.sh --force   # 用链接替换目标位置的实体目录
```

设计约束：

- **只增不删**：默认只补缺失项，不动的目录/链接一律不碰。
- **只替自己的链接**：目标是指向本仓库同名技能、但路径已变（仓库搬家）时会重建；指向别处的保留并报告为冲突。
- **冲突不静默**：目标位置已有实体目录时只报告，必须显式 `--force` 才替换。
- 源/目标可用 `SKILL_SRC` / `SKILL_DST` 覆盖。

**注意统计口径**：列技能数要用 `find -L`（跟随符号链接），否则链过去的技能不会被计入，报出的数字比技能中心实际看到的少。

## 5. 自动化

crontab 每 10 分钟同步一次（幂等，无变化时只做一次 `readlink` 比较）：

```
*/10 * * * * /root/projects/scripts/sync-harness-skills.sh >> /root/.dsh/skill-sync.log 2>&1
```

**验证时务必用最小环境**，cron 的 PATH 极简，是常见失败点：

```bash
env -i PATH=/usr/bin:/bin HOME=/root /root/projects/scripts/sync-harness-skills.sh
```

## 6. 端到端验证方法

不要只检查文件存在 —— 真正要证的是「技能中心能看到」。造一个临时技能，看它是否出现在技能目录清单里：

```bash
# 1) 在源目录造一个
mkdir -p /root/projects/deepseek-harness-plus/.agents/skills/zz-sync-test
printf -- '---\nname: zz-sync-test\ndescription: 临时测试\n---\n\n# 测试\n' \
  > /root/projects/deepseek-harness-plus/.agents/skills/zz-sync-test/SKILL.md
# 2) 同步
/root/projects/scripts/sync-harness-skills.sh
# 3) 验证链接与可读性
ls -l /root/projects/.agents/skills/zz-sync-test
cat /root/projects/.agents/skills/zz-sync-test/SKILL.md
# 4) 清理（链接与源都要删，否则 --prune 会把源当真技能）
rm -f  /root/projects/.agents/skills/zz-sync-test
rm -rf /root/projects/deepseek-harness-plus/.agents/skills/zz-sync-test
```

技能清单刷新后（会话目录会重建）新技能即可用。

## 7. 速查

```bash
# 技能中心会扫哪些根
grep -n "localSkillRoots\|level: \"" \
  /root/.dsh/profiles/plus/node_modules/@sparkelf/dsh-client-ui-skill-center/lib/index.js | head -20

# 当前工作区根
python3 -c "import json;d=json.load(open('/root/.dsh/storages/workspace.json'));\
print([w['path'] for w in d['tables']['workspaces'].values()])"

# 同步与查看
/root/projects/scripts/sync-harness-skills.sh
find -L /root/projects/.agents/skills -maxdepth 2 -name SKILL.md | wc -l
```

## 8. 反面清单

- ❌ 把技能放在工作区**子目录**的 `.agents/skills` 下，然后以为它可见 —— 只扫工作区根那一层。
- ❌ 为让技能可见去改 profile 的 `cordis.patch.yml` —— `writeCapabilityPatch()` 会整文件覆盖它。
- ❌ 用 `find`（不带 `-L`）统计技能数 —— 链接过去的技能不会被计入。
- ❌ 只在交互 shell 里测同步脚本 —— cron 的极简 PATH 是常见失败点。
- ❌ 用 `--prune` 清链接时不区分来源 —— 脚本只清指向本仓库的，别手工 `rm` 掉别人的链接。
- ❌ 造测试技能后只删链接不删源 —— 下次 `--prune` 会把源当失效目标反复处理。
