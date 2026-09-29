---
name: dsh-repo-release-pr
description: 在 SparkElf/deepseek-harness-plus（自有仓库）里发布 npm、开 PR、合并到 master 时使用。讲清 master 的服务端保护规则、加权批准（weighted approval）机制、为什么 PR 作者不能自己批准、以及 release:ship 的完整步骤顺序。排查「push 被拒」「PR 卡在 REVIEW_REQUIRED」「不知道谁来批准」时优先读它。
---

# DSH Plus 仓库的发布与 PR 流程

这个技能解决一类反复踩的坑：**推代码、发版本、开 PR 时不知道规则，导致被拒或卡住。**

核心结论先给：

1. **禁止直推 master。** 服务端规则强制 PR + 批准 + 状态检查，客户端绕不过。
2. **PR 作者不能批准自己的 PR。** 加权批准明确排除作者。
3. **批准需要 2 分**，且本机通常只有一个 GitHub 身份 —— 所以「机器人提交 + 人审查」需要**两个身份**，或缺一不可。
4. **发布用 `release:ship` 或按它的步骤顺序手动执行**，顺序错了 gate 会失败。

---

## 1. 仓库身份

```
origin   git@github-sparkelf:SparkElf/deepseek-harness-plus.git
```

这是**自有仓库**，不是第三方依赖。改 `packages/bundle/plus` 等代码 = 改自有源码，正确路径是「改源码 → 构建 → 提 PR → 发布」，不是「打补丁」也不是「提 issue 给上游」。

本机 `gh` 登录身份用 `gh auth status` 查。**先查身份，再决定流程**——只有一个身份时，作者不能批准自己的 PR。

---

## 2. master 的服务端保护规则

先用 API 查，不要凭猜：

```bash
gh api repos/SparkElf/deepseek-harness-plus/rules/branches/master
```

当前规则（`GET .../branches/master/protection` 返回 404，因为用的是新版 rulesets，不是旧保护）：

| 规则 | 含义 |
|---|---|
| `pull_request` | 必须走 PR；`required_approving_review_count = 1`；`require_code_owner_review = true`；`required_review_thread_resolution = true` |
| `required_status_checks` | 两个检查必须通过：`Required PR evidence`、`Diff and composition metadata` |
| `non_fast_forward` | 禁止强推 |
| `deletion` | 禁止删分支 |

**直推会被这样拒绝**：

```
remote: error: GH013: Repository rule violations found for refs/heads/master.
remote: - Changes must be made through a pull request.
remote: - 2 of 2 required status checks are expected.
```

这是服务端强制，"跳过 CI" 在客户端做不到。

---

## 3. 加权批准机制（最容易踩的坑）

策略文件：`.github/review-ownership/approval-policy.json`

```json
{
  "requiredPoints": 2,
  "defaultPoints": 1,
  "reviewerPoints": {
    "07akioni": 2, "imccyu": 2, "tianyicui": 2,
    "tianyicui-bot": 2, "turtle1999": 2, "turtle2099": 2
  }
}
```

规则要点（来自 `.github/review-ownership/README.md`）：

- **阈值 2 分。**
- 高权重审查者各 **2 分**（一票即达阈值）；其他有 write 权限者各 1 分。
- **PR 作者不计分** —— 所以作者自己 approve 无效。
- 无 write 权限者不计分；已删除账号不计分。
- `CHANGES_REQUESTED` 是**阻断项**，即使分数够也保持 pending。
- 只有「非 draft + 达阈值 + 无阻断」才返回 `success`。

因此：

- 想自动化，需要 **bot 账号**（如 `tianyicui-bot`）提交、人类账号审查；或反过来。
- **只有一个身份时，无法自行合并** —— 这是设计如此，不是 bug。

查 PR 为何卡住：

```bash
gh pr view <n> --json reviewDecision,mergeStateStatus,statusCheckRollup
```
`REVIEW_REQUIRED` + `BLOCKED` = 等批准，且通常需要**另一个账号**。

---

## 4. 发布流程（`release:ship` 的顺序）

一键入口：

```bash
pnpm run release:ship --prerelease rc.36 --family plus [--dry-run]
```

它按**固定顺序**做事，手动执行时必须照抄，否则 gate 会失败：

```
1. bump 版本            npx tsx scripts/release/bump.ts --family plus --prerelease rc.36
2. 重新生成 standalone manifests   ← 必须在 bump 之后
3. pnpm install --lockfile-only    ← 否则 CI 报 ERR_PNPM_OUTDATED_LOCKFILE
4. git commit（一个提交）
5. 跑 gates：verify:plus-governance / verify:standalone-manifest / verify:standalone-variants
6. 必要时加 release-age 豁免（pnpm install --frozen-lockfile 会暴露）
7. 发布：pnpm run release:local --family plus --out <dir>
8. 推分支、开 PR
```

**为什么 2 必须在 1 之后**：standalone manifest 里写着发行版版本号，先生成会让 gate 拿旧版本比对。

**为什么要 3**：根 lockfile 的 importer 入口也记录这两个 standalone 的版本，不同步刷新会让每个 CI job 在 `--frozen-lockfile` 上失败。

**发布是本地全量验证**：`release:local` 会 pack → `verify-packed-install`（装到临时目录）→ publish → `verify-published`（轮询 registry 直到 latest 解析）。`E409 Cannot publish over previously staged version` **不是失败**，是 registry 的暂存窗口，重跑即幂等完成。

手动发布：

```bash
pnpm run release:local --family plus --out /tmp/rc-<ver>   # 去掉 --dry-run 才真正发
```

---

## 5. 发布后的收尾

```bash
# 合并后给 merge commit 打 tag
git tag plus-npm-v0.2.0-rc.36 <merge commit>
git push origin plus-npm-v0.2.0-rc.36
```

bump 脚本自己会打印这一行，注意读它的输出。

---

## 6. 清理分支前必做

删本地分支前先确认它们是否已进 master。**注意工具会误报**：

- `git cherry` 对 **squash 合并**（本仓库的常规做法）**必然误报** —— squash 改变了 SHA，patch-id 认不出，会报「未进 master」而实际已进。
- 可靠判据（按可靠性排序）：
  1. **新增文件是否都在 master**：`git diff --name-only --diff-filter=A <merge-base> <branch>`，逐个查 `git cat-file -e master:<file>`。
  2. **试合并产生的冲突性质**：`git merge --no-commit --no-ff <branch>`，若冲突内容是**版本倒退**（如 `rc.35` vs `rc.25`），说明分支只是落后，不该合并。
  3. `git merge-tree` **不可靠**：它会把冲突标记（`<<<<<<<`）输出成"差异"，造成假阳性。
- **删前先建备份 tag**，并验证可从 tag 恢复：
  ```bash
  git tag backup/pre-cleanup-$(date +%Y%m%d-%H%M%S)/<name> <branch>
  git branch __restore_test <tag> && git branch -D __restore_test   # 证明可恢复
  ```

---

## 7. 工作树（worktree）

`git worktree list` 可能列出**构建缓存**工作树，例如：

```
.cache/plus-web-build-cache/official-source   (detached HEAD)
```

它由 `tests/plus-web/global-setup.mjs` 创建和销毁（`resetBuildCache()` 里 `git worktree remove --force` + `rmSync`），是**派生数据**，`manifest.json` 记录 `officialRevision` 和包哈希。它的「未提交改动」是构建产物改写（如 `/` → `./`），不是人的工作。可以安全清理：

```bash
git worktree remove --force .cache/plus-web-build-cache/official-source
rm -rf .cache/plus-web-build-cache
```

代价：下次 `test:plus-web` 会全量重建（`pnpm install` + 构建）。体积可达数百 MB。

---

## 8. 部署推进工具在这里（不要用 `command -v` 判存在）

发布 npm 之后，**运行中的部署不会自动更新**。升级部署由一组脚本负责，它们住在 **`/root/.dsh/`**，而该目录**不在 PATH 上**。因此 `command -v dsh-plus-build` 会报"找不到"，但工具其实就在那儿：

```bash
# 错误做法：只查 PATH
command -v dsh-plus-build        # ✗ 找不到 —— 结论是错的

# 正确做法
ls -la /root/.dsh/dsh-plus-*     # ✓ dsh-plus-build / dsh-plus-switch / dsh-plus-refresh
```

| 工具 | 位置 | 职责 |
|---|---|---|
| `dsh-plus-build <mirror>` | `/root/.dsh/` | 两次 `pnpm install` + `pnpm run build --profile official` + 校验品牌记录 |
| `dsh-plus-switch <mirror>` | `/root/.dsh/` | 切换 3080 服务的 mirror，按阶段推进 |
| `dsh-plus-refresh rebuild\|accept\|restart\|all` | `/root/.dsh/` | 重建 / 记录 accept / 重启，按此顺序 |
| `dsh-3080-restart` | `/usr/local/bin`（软链到 `/root/.dsh/`） | 唯一在 PATH 上的那个 |

**call them rather than写一份自己的实现** —— 手写一份部分实现会「报成功、HTTP 200、却在跑旧版本」，因为运行时解析的是 mirror 里的源码，而手写步骤往往只改了 profile 里的发行版号。

另外官方还有一份**强制 runbook**：`scripts/PLUS_PROFILE_PROMOTION.md`（仓库内）。以及对应的门禁：

```bash
pnpm run verify:plus-profile-upgrade -- --baseline <旧>/profile --candidate <新>/profile --report
pnpm run verify:plus-profile-upgrade -- --baseline <旧>/profile --candidate <新>/profile \
  --policy packages/bundle/plus/production-profile-policy.json     # 阻断性
```

**注意**：升级部署是**独立于 npm 发布**的一步，且比发布更重（要过闭包门禁、桌面/移动端验收、Session 恢复）。npm 发出去不等于部署会更新。

---

## 9. 速查

```bash
# 身份与规则（先查这两个）
gh auth status
gh api repos/SparkElf/deepseek-harness-plus/rules/branches/master

# PR 卡在哪
gh pr view <n> --json reviewDecision,mergeStateStatus,statusCheckRollup

# CI 实际耗时（别把 ship.ts 的 45 分钟超时当成预期耗时）
gh run view <run-id>
```

---

## 10. 反面清单

- ❌ 直推 master —— 服务端规则必拒。
- ❌ 用自己的账号提交后又想自己 approve —— **作者不计分**，权重为 0；用 `gh pr merge --admin`（`ship.ts` 就是这么做的）。
- ❌ 把 `ship.ts` 的 `CHECKS_TIMEOUT_MILLISECONDS = 45 * 60_000` 当成 CI 预期耗时 —— 那是超时上限，实测多数 job 3–4 分钟就完成。
- ❌ 用 `command -v dsh-plus-build` 判断部署工具是否存在 —— 它们在 `/root/.dsh/`，不在 PATH 上，会误判为"工具不存在"。
- ❌ 以为 npm 发布后部署会自动更新 —— 升级部署是独立、更重的一步，要过闭包门禁与浏览器验收。
- ❌ 自己写一份部署推进步骤 —— 这正是 `dsh-promote-deployment` 技能要防的错误；调用现成脚本。
- ❌ 用 `git cherry` 判断分支是否已合并 —— squash 合并下必然误报。
- ❌ 用 `git merge-tree` 判断分支独有改动 —— 冲突标记会被当成真差异。
- ❌ 先跑 `generate-manifest` 再 bump —— gate 会拿旧版本比对而失败。
- ❌ bump 后不跑 `pnpm install --lockfile-only` —— CI 每个 job 都在 `--lockfile-only` 上红。
- ❌ 把 `E409` 当成发布失败 —— 那是暂存窗口，重跑即完成。
- ❌ 删分支不先建备份 tag —— 本仓库分支常常只存在于本地，删了就没了。
