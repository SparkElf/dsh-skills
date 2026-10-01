# DSH Skills

SparkElf 维护的 DeepSeek Harness 技能集合。技能正文位于 `.agents/skills/<skill-name>/SKILL.md`，目录中的辅助脚本和配置与对应技能一起维护。

## 当前内容

仓库收录当前项目维护的 28 个技能。`catalog.json` 是由 `scripts/verify-skills.mjs` 生成并校验的技能索引。

技能来源是工作区级 `.agents/skills`。`deepseek-harness-plus/.agents/skills` 中的同名版本与本仓库收录版本逐项一致，因此这里保留一份权威副本，避免两个仓库分别演进。

全局环境中的 Office 技能没有复制到本仓库。它们属于 `/root/.agents/skills` 的环境级安装，来源和分发授权不同；对应记录见 [`external-skills.json`](external-skills.json)。

## 使用

将本仓库作为工作区根目录打开，DeepSeek Harness 技能中心会按项目级 `.agents/skills` 自动发现这些技能：

```bash
git clone https://github.com/SparkElf/dsh-skills.git
git -C dsh-skills log -1 --oneline
```

如果要在已有工作区中使用，可以把本仓库的 `.agents/skills` 内容复制到该工作区的 `.agents/skills`，或为每个技能建立软链接。技能中心只把工作区根目录下的 `.agents/skills` 视为项目技能目录；不要通过 profile 的 `customSkillDirs` 替代项目目录。

## 维护

每个技能目录必须使用小写字母、数字和单连字符组成的名称，并包含带 YAML frontmatter 的 `SKILL.md`。提交前运行：

```bash
node scripts/verify-skills.mjs
```

该命令会检查技能目录、`SKILL.md`、`name`、`description` 和 frontmatter，并更新 `catalog.json`。技能内容的兼容性、维护、发布和退出由本仓库 owner SparkElf 负责；本仓库不发布 npm 包，也不改变 Harness profile 的默认挂载。

## 所有权与分发

| 维度 | 决定 |
| --- | --- |
| 技能 owner | SparkElf；技能正文与随附资源由本仓库统一维护 |
| 插件边界 | 技能文档本身不是 Cordis 插件，不新增 Host/Client 注册 |
| npm 发布 | 不发布 npm artifact |
| 源码仓库 | `SparkElf/dsh-skills` |
| 自动发现 | 作为工作区根时使用项目级 `.agents/skills` 发现；不修改 profile |

## 许可

当前技能内容未在源文件中声明统一开源许可证。仓库公开展示不改变各文件原有权利状态；如需对外复用，请先确认对应技能的作者和许可。
