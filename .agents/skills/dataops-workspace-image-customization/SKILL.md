---
name: dataops-workspace-image-customization
description: 改 DataOps 工作区镜像（dataops/infra/docker-workspace/）里的 DSH 行为时使用：隐藏弹窗、关闭 onboarding、改插件配置、换 standalone 版本、调 profile 内容。讲清「该改哪一层」（profile 配置 / overlay patch / 官方 Config / 重打包），以及镜像升级时改动不生效的四个真实坑。要改 DSH 在工作区里的任何默认行为前，先读这个。
---

# DataOps 工作区镜像：改 DSH 行为该落在哪一层

这个技能解决一类反复出现的返工：**为了让工作区少一个弹窗、改一个默认值，去改了打包产物，结果要么不生效，要么基线一升级就静默失效。**

核心结论先给：

1. **先查官方 Config，再考虑任何补丁。** DSH 的多数可定制行为都有官方配置字段（`Config = z.object({...})`），通过 profile 的 `config:` 传进去即可。
2. **DataOps 有自己独立的 overlay patch**（`dataops-dsh-embedded.patch.yml`），它是 dataops 专属改动的正确位置，**不要动 `dsh-plus` 正常发行版**。
3. **绝不字符串替换 `lib/*.js`。** 基线升级时锚点失配会静默失效。
4. **改动是否生效，必须看浏览器实际收到的 HTML**，不能只看容器里的文件。

---

## 1. 三层结构：谁决定工作区里 DSH 的行为

```text
dataops-ai-workspace:local                           ← dataops 仓库构建，只服务 DataOps
  /opt/dataops-dsh-install          → /opt/dsh-plus          ← standalone 安装树（launcher 用）
  /opt/dataops-dsh-profile-template                           ← profile 模板（运行时从这里复制）
  /opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml     ← DataOps overlay patch（--patch 传入）

运行时：
  /workspace/.dataops/dsh/profiles/dataops-web                ← profile 副本（持久卷）
```

| 要改什么 | 改哪 |
|---|---|
| DSH 插件的**配置值** | **profile 的 `config:`** —— 写在 `dataops-dsh-embedded.patch.yml` |
| 某个插件**不该被装配** | overlay 里 `disabled: true`（或条件表达式） |
| 插件的**源码行为** | **重打包**（机制 4），不是改产物 |
| standalone **版本** | `workspace-recipe.mjs --version <v>` |
| 后端/工作区服务行为 | dataops 仓库的 `backend/` |

---

## 2. 改动机制：四选一，永远不要叫「打个补丁」

来自 `dsh-plugin-ownership-and-distribution`：

| 机制 | 适用 | 例子 |
|---|---|---|
| **1. Profile configuration** | 官方已提供 Config 字段 | `credentialOnboarding: false`、`welcomeNoticeVersion` |
| **2. 我们自己的插件** | 挂在已发布的扩展点上 | 新建 `@sparkelf/dsh-*` 插件 |
| **3. `patchedDependencies`** | 外部 npm 包需改源码 | 第三方包 |
| **4. `overrides` 重打包** | **官方 `@deepseek-ai/*` 的 `lib/` 表达不了该改动** | `@sparkelf/dsh-client-ui-settings-models` |

**先穷尽机制 1。** 官方插件的 Host half 常已暴露配置：看它的 `lib/index.js` 是否导出 `Config`，以及 `ctx.on('webserver/index-inject')` 注入了什么全局量。

---

## 3. 四个真实坑（都是踩过的）

### 坑 1：改动打错副本

**两处都有前端/插件副本，只有一处被服务。**

| 路径 | 是否被服务 |
|---|---|
| `/opt/dsh-plus/node_modules/...` | 安装树，**launcher 用** |
| `/opt/dataops-dsh-profile-template/node_modules/...` | **运行时从这里复制，浏览器加载的是它** |

**两者是独立物理副本（inode 不同），不是软链。** 只改一处等于没改。

验证方式（唯一可信）：取浏览器实际收到的页面。

```bash
# 登录 → ensure → 带 cookie 取页面
curl -s -o /tmp/served.html "$TARGET/" -H 'Sec-Fetch-Site: same-site' -b /tmp/ck.txt
grep -c '你改的标记' /tmp/served.html
```

### 坑 2：构建期路径还不存在

`/opt/dsh-plus` 是 `COPY --from=dsh-registry-install /opt/dataops-dsh-install /opt/dsh-plus` 的**结果**。
在那一行之前执行 `RUN` 时，`/opt/dsh-plus` **不存在**。要改就改 `/opt/dataops-dsh-install`（它的来源）。

### 坑 3：profile 不会因重建镜像而自动更新

`prepare_profile()` 只在 marker 不同时重新复制：

```python
expected = profile_source_marker(TEMPLATE)
if PROFILE_DIR.is_dir() and profile_source_marker(PROFILE_DIR) == expected:
    return          # ← 早退
```

marker 是 `版本+内容摘要`（`0.2.0-rc.34+<sha256>`）。**摘要让「同一版本改了模板」也能触发重新复制** —— 这是必须保留的机制，改 Dockerfile 时别把 marker 退回纯版本号。

运行时 profile 在持久卷里，**重启容器不会清掉它**。手动验证时若怀疑这一点，删掉 `profiles/dataops-web` 强制重新复制。

### 坑 4：配置改在错的 env 文件

**systemd 用 `set -a; source` 注入 `.dataops/backend.remote-development.env`，它的优先级高于 `backend/.env`。**

| 文件 | 是否生效 |
|---|---|
| `dataops/backend/.env` | ❌ 被覆盖 |
| `dataops/.dataops/backend.remote-development.env` | ✅ **实际生效** |

判断当前进程真正用的值：

```bash
PID=$(systemctl show dataops-dev-backend.service -p MainPID --value)
tr '\0' '\n' < /proc/$PID/environ | grep '^DATAOPS_'
```

---

## 4. 官方配置怎么找（不要靠猜）

```bash
# 1) 插件是否有官方 Config
grep -n 'const Config' <pkg>/lib/index.js

# 2) Host half 注入了哪些页面全局量
grep -n 'index-inject' -A 8 <pkg>/lib/index.js

# 3) 客户端如何消费（决定配置的效果）
grep -n 'globalthis\[.*GLOBAL' -A 4 <pkg>/lib/client.js

# 4) 页面里实际注入了什么（最终事实）
grep -oE '__DSH_[A-Z_]+__"\] = \{[^}]*\}' /tmp/served.html
```

**已知的官方开关（截至 0.1.7-rc.2）：**

| 全局量 | 来源插件 | 字段 | 作用 |
|---|---|---|---|
| `__DSH_MODELS_ONBOARDING__` | `dsh-client-ui-settings-models` Host half | `credentialOnboarding` | API Key 首次引导 |

内测声明（`WelcomeNotice`）**没有独立的布尔开关**；它读 `ui-settings-general` 的 `welcomeNoticeVersion`，**预置成当前版本号即视为已确认、不再渲染**。当前版本号见 `WELCOME_NOTICE_VERSION`。

---

## 5. overlay patch 的写法

`dataops/infra/docker-workspace/runtime-daemon/src/dataops-dsh-embedded.patch.yml`，通过 `--patch` 传给 DSH：

```yaml
- id: <profile entry id>          # 必须与 bundle patch 里的 id 一致
  config:
    <field>: <value>
- id: <另一个 id>
  disabled: true                  # 或不装配
```

**entry id 从哪来**：`node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` 的 `- id:` 行。

**注意**：`disabled` 作用于整条 entry（整个插件），不能只禁其中一个 slot 注册。

---

## 6. 改完必须验证的三层

| 层 | 怎么看 |
|---|---|
| 镜像内容 | `docker run --rm --entrypoint sh <image> -c '...'` |
| 运行时 profile | `docker exec dataops-ai-admin grep -c <标记> /workspace/.dataops/dsh/profiles/dataops-web/...` |
| **浏览器实际收到的** | **取页面后的 grep（唯一可信）** |

镜像自带的验证脚本在 `verify-workspace-image.mjs`，**加了断言就要覆盖两份副本** —— 只断言安装树会漏掉真正被服务的那份。

---

## 7. 只改 DataOps，不碰正常发行版

| | |
|---|---|
| `dsh-plus`（正常发行版） | `deepseek-harness-plus` 仓库 |
| DataOps 变体 | **只在 `dataops/infra/docker-workspace/` 和 `dataops-dsh-embedded.patch.yml` 里改** |

harness 侧的 `patches/npm/*` 与 `PATCHED_WORKSPACES` 是 `plus` 家族共享的，**动它们会影响正常发行版**。确实需要改官方包源码时，按机制 4 走，并在改动说明里写清它只服务 DataOps。

---

## 8. 重建镜像

```bash
cd dataops/infra/docker-workspace
node workspace-recipe.mjs --version <standalone 版本>   # 改版本（同时校验镜像源可达）
node workspace-recipe.mjs --check                       # 自检
node build-and-verify.mjs                               # 构建 + 验证，约 30 分钟
```

**必须用 `build-and-verify.mjs`**，裸 `docker build` 缺 `--network host`、两个 build context 和 `--ulimit nofile`。

### 刚发布的版本：用 `--registry` 绕开国内镜像的同步滞后

镜像默认从 `registry.npmmirror.com` 装（`ARG NPM_CONFIG_REGISTRY`）。**它同步上游有延迟**，刚发布的版本会 `ERR_PNPM_NO_MATCHING_VERSION`，而错误里点名的版本**其实存在**：

```
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for
  @deepseek-ai/dsh-api-session-controller@npm:@sparkelf/dsh-api-session-controller@0.2.0-rc.2
```

先确认是滞后而不是真没发：

```bash
for p in dsh-api-session-controller dsh-client-ui-agent-preset; do
  A=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/@sparkelf%2F$p/0.2.0-rc.2")
  B=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmmirror.com/@sparkelf%2F$p/0.2.0-rc.2")
  echo "$p: npmjs=$A npmmirror=$B"   # 200 vs 404 = 滞后
done
```

**两边都 404 才是真的没发布**（那要先去发版，不是改构建）。确认是滞后就换源构建：

```bash
node build-and-verify.mjs --registry https://registry.npmjs.org
```

这个开关就是为这种情况准备的（见脚本里 `registry` 参数的注释）。**只有构建期需要它** —— 产物内容与源无关，镜像仍然自洽。

**别为此改 Dockerfile 默认值**：国内镜像对日常构建更快，滞后只在「刚发版」这一个窗口出现。

### 发布侧的前置：`@sparkelf` 官方重发布包

工作区镜像装的是 `@sparkelf/dsh-dataops-standalone`，它的 `overrides` 把官方包指向 `npm:@sparkelf/dsh-<name>@<official-revision>`。**这套重发布包不属于 `release:ship` 家族**，要单独跑：

```bash
node scripts/release/republish-patched-official.mjs \
  --source <built-checkout> --version <official-revision>
```

漏跑的症状就是上面的 `ERR_PNPM_NO_MATCHING_VERSION` —— 镜像要 rc.2 的重发布包，而 registry 上只有 rc.1。

改 Dockerfile 后先本地验证脚本逻辑（把真实文件拷到 `/tmp` 上跑一遍），再花 30 分钟构建 —— 一次失败的构建成本远高于一次本地试验。

---

## 9. 两个容器：改对容器才算改对（最容易白白耗掉一小时）

工作区由**两个容器**组成，职责不同：

| 容器 | 角色 | `/opt/dataops-runtime/` | `/workspace` |
|---|---|---|---|
| `dataops-ai-admin` | 工作区主容器（helper、daemon、gateway agent、终端） | 独立副本 | **共享卷** |
| `dataops-ai-admin-dsh-runtime` | **DSH companion，`bin.js` 真正在这里跑** | **独立副本** | **共享卷** |

**关键后果**：

- 两侧的 `/opt/dataops-runtime/src/*` 是**镜像里各自的副本，不共享**。
- 改 overlay（`dataops-dsh-embedded.patch.yml`）后，`docker cp` 只进主容器**不生效** —— DSH 读的是 companion 的那份。
- `/workspace/.dataops/dsh/profiles/` 是共享卷，所以在任一容器里看都一样。

确认 DSH 在哪跑、用的哪个 overlay：

```bash
docker exec dataops-ai-admin-dsh-runtime \
  bash -c 'ps -eo pid,cmd | grep "[b]in.js"'
# → node /opt/dsh-plus/.../bin.js --profile dataops-web \
#        --patch /opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml --host 127.0.0.1 --port 3080
```

改完 overlay 的验证顺序：

```bash
# 1) 确认配置进了 companion 容器
docker exec dataops-ai-admin-dsh-runtime \
  grep -c credentialOnboarding /opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml

# 2) 用官方 dump-config 看组合后的实际配置（权威，不靠猜）
docker exec dataops-ai-admin-dsh-runtime bash -c '
  DSH_HOME=/workspace/.dataops/dsh node /opt/dsh-plus/node_modules/@deepseek-ai/dsh/lib/bin.js \
    --profile dataops-web \
    --patch /opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml --dump-config' \
  | grep -A 3 'id: ui-settings-models'
```

`--dump-config` 是 DSH 自己的工具，输出**组合后**的树（bundle 层 + 各 patch 层叠加的结果）。**先看它，再谈页面效果。**

---

## 10. 重启 DSH 的两个坑

**坑 1：`pkill -f 'dsh/lib/bin.js'` 会自匹配。** 命令行里含该字符串的 shell 会被一起杀掉，表现为「重启了但没生效」。用 companion 容器 + 精确 PID：

```bash
PID=$(docker exec dataops-ai-admin-dsh-runtime bash -c 'pgrep -f "bin.js --profile" | head -1')
docker exec dataops-ai-admin-dsh-runtime bash -c "kill $PID"
```

**坑 2：杀掉后 DSH 不会自己起来。** 通过后端的 ensure 拉起（这是唯一正规入口）：

```bash
curl -s -X POST "http://127.0.0.1:3101/api/ai/workbench/dsh/ensure" \
  -H "Authorization: Bearer $TOKEN" -H 'Origin: http://localhost:3000'
```

**每次改完 overlay，都必须走「重启 DSH → 重新 ensure → 取页面」这条链**，只改文件不重启等于没改。

---

## 11. `welcomeNoticeVersion` 是**硬编码版本号**，DSH 升级后必然失效

内测/预览弹窗的开关方式是「预置成它当前要求的版本号」：

```yaml
- id: ui-settings-general
  config:
    welcomeNoticeVersion: '2026-09-28.1'   # ← 必须等于当前 DSH build 的常量
```

**这个常量烧在客户端包里**（`dsh-client-ui-settings-models/lib/client.js`）：

```js
const WELCOME_NOTICE_VERSION = "2026-09-28.1";
```

**后果**：DSH 一升级，常量就变了 → overlay 里的旧值被判定为「未确认」→ **弹窗重新出现**。
而它同时**无法保存**（见第 12 节），所以用户被卡住。

**实测过的事实**：

| DSH 版本 | `WELCOME_NOTICE_VERSION` | 文案 |
|---|---|---|
| 0.1.x | `2026-08-13.1` | 内测声明 |
| 0.2.x | **`2026-09-28.1`** | 预览版说明 |

**不要让这个值被手写两遍。** 正确做法是在构建期断言它等于 build 自己的常量：

```dockerfile
RUN set -eux; \
    client=/opt/dataops-dsh-profile-template/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js; \
    declared="$(sed -n 's/.*WELCOME_NOTICE_VERSION = "\([^"]*\)".*/\1/p' "$client" | head -1)"; \
    configured="$(sed -n "s/^[[:space:]]*welcomeNoticeVersion: '\([^']*\)'/\1/p" /opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml | head -1)"; \
    test -n "$declared" && test "$configured" = "$declared"
```

**验证脚本同理**：不要硬编码期望值（那会和过期的 overlay 一起通过），要**比对两处**。

---

## 12. 这个弹窗为什么「存不了」：Host half 没装配

弹窗把确认状态写进 `ui-settings-general` 这个 settings 命名空间，而命名空间由 **profile entry 提供**。

检查该 entry 的包是否声明了 Host half：

```bash
python3 -c "import json;d=json.load(open('<pkg>/package.json'));print(list((d.get('dsh') or {}).keys()))"
```

- `['client']` → **只有浏览器端**，Host half 不装配 → 命名空间不存在 → 写入失败
- `['bundle']` / `['client','bundle']` → Host half 会装配

**注意**：`lib/index.js` 里有 `Config`/`apply` 并不代表它会被装配 —— 取决于 `dsh` 字段，不是文件存在。

**这解释了为什么「文案出现了但确认不了」**：Client half 渲染了弹窗，而写入目标不存在。

---

## 13. 升级 DSH 大版本时的检查清单

DSH 从 0.1 → 0.2 这类升级，**以下每一处都可能静默失效**：

| 检查项 | 怎么查 |
|---|---|
| `welcomeNoticeVersion` 是否过期 | 见第 11 节 |
| transport 补丁是否还在**两份**副本 | `grep -c __DSH_TRANSPORT__` 两个路径 |
| 各 settings 命名空间的 Host half 是否装配 | 第 12 节 |
| peer 声明的精确版本是否还满足新运行时 | **不是** `verify:published-peers`（它只比对源码与已发布，见第 15 节）——按第 15 节逐 bundle 核算 |
| profile 是否真的重新复制了 | 第 3 节坑 3 |
| 插件 pin 是否指向新版本 | `grep dsh-dataops-managed` 两个 manifest |

**一条命令审计镜像**（比逐个 grep 可靠）：

```bash
CID=$(docker run -d --entrypoint sleep dataops-ai-workspace:local 120)
docker exec "$CID" sh -c '
  P=/opt/dataops-dsh-profile-template/node_modules
  echo "transport(dsh-plus): $(grep -c __DSH_TRANSPORT__ /opt/dsh-plus/.../index.html)"
  echo "transport(profile):  $(grep -c __DSH_TRANSPORT__ $P/@deepseek-ai/dsh-web-frontend/dist/index.html)"
  sed -n "s/.*WELCOME_NOTICE_VERSION = ..\\([^\\\"]*\\).*/notice: \\1/p" $P/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js | head -1
  grep -c skill-center.section $P/@sparkelf/dsh-client-ui-skill-center/lib/client.js
'
docker rm -f "$CID"
```

**再加一条 peer 核算**（第 15 节的核心检查，构建日志之外的第二道）：

```bash
# 列出运行时实际拒绝的插件（这是「UI 缺失但无报错」的第一现场）
CID=$(docker run -d --entrypoint sleep dataops-ai-workspace:local 120)
docker exec "$CID" sh -c '
  grep -ho "@[a-z0-9/-]*@[0-9][^ ]* is incompatible with dsh" \
    /opt/dataops-dsh-profile-template/.plugin-manager/logs/*/pnpm.log 2>/dev/null | sort -u
'
docker rm -f "$CID"
```

**任何一个被拒的插件，它贡献的 UI 都不会出现。**

---

## 14. 镜像源要用官方 registry（淘宝镜像会滞后）

**`registry.npmmirror.com` 对新发布的包有明显滞后**，表现为构建时 `No matching version found for <pkg>@<new version>`。

**判断方法**：

```bash
node -e "fetch('https://registry.npmjs.org/<pkg>/<version>').then(r=>console.log('official:',r.status))"
node -e "fetch('https://registry.npmmirror.com/<pkg>/<version>').then(r=>console.log('mirror:  ',r.status))"
```

**官方有、镜像没有** → 用官方源构建：

```bash
node build-and-verify.mjs --registry https://registry.npmjs.org/
```

这正是「刚发完版，镜像就构建失败」的典型原因，**不是发布错了**。

---

---

## 15. peer 声明不满足运行时 = **整个插件被跳过**（静默，无报错）

**这是最难查的一类失效**：镜像构建成功、DSH 也起来了、没有红色报错，但**某个插件的功能整块消失**。

### 机制

DSH 启动时对每个 bundle 逐个检查 peer：

```js
// packages/boot/app-boot/lib/index.js
const issue = evaluatePluginCompatibility(bundleManifest, exemptions)
if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))
//  ↑ throw 被外层 catch → skippedBundles.push(...)
```

**判定语义**（关键）：

```js
semver.satisfies(runtimeVersion, peerRange, { includePrerelease: true })
```

对照表（运行时 `0.2.1-alpha.1`）：

| plugin peer 写法 | satisfies | 结果 |
|---|---|---|
| `0.2.0-rc.2`（**精确 pin**） | false | **整个 bundle 被跳过** |
| `>=0.2.0-rc.2`（范围） | true | 正常装配 |
| `^0.1.6-alpha.1`（范围，但基数太旧） | false | **整个 bundle 被跳过** |

**两个反直觉点**：

1. **精确 pin 比范围更严格**。`0.2.0-rc.2` 只放行那一个版本；`>=0.2.0-rc.2` 放行它及之后的所有 prerelease。
2. **`^0.1.x` 永远匹配不上 `0.2.x`**。「写了范围但基数太旧」同样让插件消失。

### 症状（记住这个组合）

- 构建日志里有 `Plugin <name>@<ver> is incompatible with dsh <runtime>` —— **但构建仍然成功**
- 插件目录、`node_modules`、源码**都在**，`grep` 也搜得到
- 浏览器**不加载它的 client 模块**（`/plugins/??` 清单里没有）
- 页面**缺失该插件的 UI**，且**没有任何 pageerror**

### 怎么查（从症状到根因）

**第 1 步：确认插件是否被拒**（最快）

```bash
# 构建日志
grep -oE 'Plugin [@a-z0-9/-]+@[0-9][^ ]* is incompatible' /tmp/build-*.log | sort -u

# 或运行中的 profile
docker exec dataops-ai-admin sh -c \
  'grep -h "is incompatible with dsh" /workspace/.dataops/dsh/profiles/dataops-web/.plugin-manager/logs/*/pnpm.log' \
  | grep -oE '@?[a-z@/-]+@[0-9][^ ]* is incompatible' | sort -u
```

**第 2 步：浏览器实际加载了哪些插件**（决定 UI 有没有）

```js
// 在 DSH iframe 里
page.on('response', r => { if (r.url().includes('/plugins/??')) urls.push(r.url()) })
// 解析 /plugins/??a/client.js,b/client.js 得到加载清单
```

**第 3 步：对比「已加载」与「被拒」两份清单** —— 差集就是缺失的功能。

**注意区分 `dsh.client` 是否为 `null`**：`dsh-client-ui-primitives`、`dsh-client-ui-slots` 是 *service* 包，本来就没有 client 入口，`/plugins/??` 里没有它们是正常的。**只有 `dsh.client` 非 null 却没加载，才是被拒**。

### 修复

**改 peer 为范围**，然后**升版本 + 重新发布**（peer 变了必须发新版本，不能原地改）。

```bash
# 1) 先确认全仓库约定：应当没有任何精确 pin
python3 -c "
import json,glob
exact=ranges=0
for f in glob.glob('packages/*/package.json'):
    d=json.load(open(f))
    for k,v in (d.get('peerDependencies') or {}).items():
        if not k.startswith('@deepseek-ai/dsh'): continue
        if v.startswith(('>=','^','~','work')): ranges+=1
        else: exact+=1
print('exact', exact, 'ranges', ranges)"
# 期望 exact=0

# 2) 只改 peerDependencies（devDependencies 保持精确 pin 是对的）
# 3) 升版本 → 构建 → 发布
pnpm --filter @sparkelf/<pkg> build
npm publish --access public --registry https://registry.npmjs.org
```

**必须显式 `--registry`**：本机 `.npmrc` 默认指向 npmmirror，而 `_authToken` 只配在 npmjs 名下，不指定会 `ENEEDAUTH`。

### 为什么容易漏

**`pnpm verify:published-peers` 查不出这个。** 它比对的是「源码 manifest」vs「registry 上已发布的那份」，用来抓「源码改了但忘了重发」。它**不知道运行时版本**，所以一个与任何运行时都不匹配的 peer 在它看来完全正常。

**升级 DSH 后必须另外核算**：拿新运行时版本，逐个 bundle 算一遍 peer 是否满足。

### 真实案例（2026-10-04）

升级到 `0.2.1-alpha.1` 后，技能中心的**「技能广场」整块消失**：

- `@sparkelf/dsh-dataops-managed@0.3.10` 的 16 个 peer 里，**只有 `@deepseek-ai/dsh-skill` 是精确 pin**（`0.2.0-rc.2`），其余 15 个都是 `>=`
- 全仓库 69 个 DSH peer **没有一个精确 pin** —— 它是唯一的 outlier
- 该 pin 是 `0.3.7` 引入的（当时从 `0.1.7-rc.2` 改成 `0.2.0-rc.2`，顺手写成了精确值）
- 后果：**从 0.3.7 起广场就没工作过**，直到跨大版本才暴露
- 修复：改成 `>=0.2.0-rc.2` → 发 `0.3.11` → 广场恢复

**排查耗时最久的不是修复，是两次误判**：

1. 以为是 `dsh.client.inject` 依赖缺失（看到 `primitives`/`slots` 不在加载清单里）—— **错**，它们是 service 包，本来就没有 client 入口
2. 以为是插件没装配 —— **错**，它在 `package.json` 的 `bundles` 里好好写着，是**运行时被拒**

**教训**：症状是「UI 缺失但无报错」时，**先搜构建日志里的 `is incompatible`**，不要从源码结构猜。

### 顺带：同一版本号的四处副本

这次升级同时暴露了另一类问题 —— **同一个版本号散落多处、没有单一来源**：

| 位置 | 问题 |
|---|---|
| `dshPlus.compatibility.dsh` | 忘了随 base 更新；且 prerelease floor 只放行同 major.minor.patch |
| `scripts/release/bump-plus.mjs` | `MANIFEST_RUNTIME` 硬编码 |
| `package.json` 的两个 verify 脚本 | `--runtime-version` 硬编码 |
| 各 patch 包的 `target.baseRevision` | 由 gate 强制等于 `sourceBase.revision` |

**修法不是改值，是改成派生**：能从 `dshPlus.compatibility.dsh` 读的就不要写死，并加 gate 强制「floor 必须涵盖 overrides 里的 pin」。

