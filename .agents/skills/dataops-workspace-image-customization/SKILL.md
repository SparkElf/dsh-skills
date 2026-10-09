---
name: dataops-workspace-image-customization
description: 改 DataOps 工作区镜像（dataops/infra/docker-workspace/）或工作区里的 DSH 插件时使用：隐藏弹窗、关闭 onboarding、改插件配置、换 standalone 版本、调 profile 内容、排查「插件路由 404 / 设置面板消失 / 重新连接中 / HTML 预览打不开」。讲清「该改哪一层」（profile 配置 / overlay patch / 官方 Config / 重打包）、重启 DSH 的正规命令（`dataops-dsh-service`，不是 kill）、宿主与 companion 各有一个 3080 的判据、插件 apply() 的注册顺序契约、volatile 配置是引用、npm 补丁为什么装了却不生效（`dsh-plus apply` 与 `patchedDependencies`）、插件功能为什么跟着发行版 pin 走（以及版本号被复用的坑），以及一整类静默失效的坑（peer 不满足、发布年龄窗口、carry 顺序、`- id:` 不能创建行、在运行中的 profile 上 install）。另含「工作区 = 3080 减三类插件」的成员关系判据。要改 DSH 在工作区里的任何默认行为前，先读这个。
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

### 插件成员关系：工作区 = 3080 **减去三类**

**这是本技能最容易漏的一条，漏了会让「3080 上有效的改动，工作区完全没有」。**

```
工作区镜像的插件集  ==  3080（dsh-plus 全量）
                      −  computer-use（含 cua-driver-mcp）
                      −  web-search（exa）
                      −  mobile（手机端）
```

**除此之外，3080 有的插件工作区都应该有。** 排除项写在各 standalone manifest 的 `exclude` 里（`packages/standalone/*-standalone/package.json`）。

**推论（重要）**：

> 如果某个插件在 3080 上是通过**手工方式**装上的（`file:` 依赖、直接在 profile 里加），
> 那它**不会自动出现在工作区**。必须走正常分发路径（发 npm → 进 `dsh-plus` bundle → 双 manifest 重生）。

**实测（2026-10-05）**：`dsh-image-hoist` 在 3080 是靠 `file:/root/projects/dsh-image-hoist` 装的，
结果工作区镜像**从未有过它** —— 不是装失败，是根本不在分发路径上。补法是发到 npm 并加进 bundle。

**怎么查两侧差异**：

```bash
ls /root/.dsh/profiles/plus/node_modules/@sparkelf/ | sort > /tmp/a.txt        # 3080
docker exec <ws-container> sh -c 'ls /workspace/.dataops/dsh/profiles/dataops-web/node_modules/@sparkelf/' \
  | sort > /tmp/b.txt                                                          # 工作区
echo '仅 3080 有（工作区缺，需补）:';  comm -23 /tmp/a.txt /tmp/b.txt
echo '仅工作区有（DataOps 专属，正常）:'; comm -13 /tmp/a.txt /tmp/b.txt
```

预期结果：`dsh-dataops-managed`、`dsh-query-result-analysis` 只在工作区（DataOps 专属）；
`dsh-plus-standalone` 只在 3080（发行包装，非插件）；**其余应完全一致**。

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

## 10. 重启 DSH：用 `dataops-dsh-service`，不要 kill

**正规入口只有一条**，就是镜像里那个 CLI，它同时是后端执行白名单里的命令（`ai-workspace-runtime-operations-provider.ts` 与 DTO 的校验正则都认它）：

```bash
C=dataops-ai-admin-dsh-runtime          # DSH 只在这个容器里跑
docker exec $C dataops-dsh-service status
docker exec $C dataops-dsh-service stop
docker exec $C dataops-dsh-service ensure
```

实测语义：

| 命令 | 行为 |
|---|---|
| `status` | 输出 JSON：`state` / `ready` / `pid` / `profile` / `sourceRef` |
| `stop` | 停进程并置 `state:"stopped"` |
| `ensure` | **幂等**：已在跑就不动（实测 pid 不变），停着才拉起 |

**在 `dataops-ai-admin` 里执行会直接报错**，这是设计：

```
ServiceError: Managed DSH must run in the isolated DataOps companion container.
```

**别再用 kill 拼重启。** 三个理由，每个都实测过：

1. `pkill -f 'dsh/lib/bin.js'` 会自匹配，把命令行含该串的 shell 一起杀掉。
2. 靠 PID kill 之后进程**不会自己起来**，必须再 `ensure`；漏了这步就是「改了文件但一直没生效」。
3. `stop` 会走完整的停止流程（置状态、回收），kill 只会留下半死进程 —— 症状是端口还在听、路由却全 404。

**每次改完 overlay / 插件产物，都要走「stop → ensure → `status` 确认 ready → 取页面」这条链**，只改文件不重启等于没改。

### 重启后必须确认路由回来了（别只看端口）

DSH 进程活着 `/` 也会返回 200，**但插件路由可能是 404**。「端口通 = 起来了」是错的判据：

```bash
# 在 companion 里查（不是宿主机，见 §21）
docker exec dataops-ai-admin-dsh-runtime bash -lc '
  for p in managed-auth model-sync skill-plaza workspace-limits; do
    printf "%-16s %s\n" "$p" \
      "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/integrations/dataops/$p)"
  done'
```

期望：`managed-auth` GET=405（它只收 POST，**405 是正常的**）、其余三个 GET=200。任何一个 404 都说明插件没装配上，去 web.log 找原因。

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
| **范围依赖是否被年龄窗口回退** | 见 §16：对比声明版本 vs 实装版本 |
| **patch 层挂载的插件是否真的装了** | 见 §17：逐个 `test -d node_modules/@sparkelf/<name>` |

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

---

## 16. 范围声明 + 发布年龄窗口 = **静默降级到旧版本**

**这是「patch 包没装完」「插件功能莫名不生效」最常见的原因，且没有任何报错。**

### 机制

pnpm 有一条 `minimumReleaseAge` 策略：**拒绝刚发布、还在窗口内的包版本**，然后 pnpm 会**为范围声明找一个更旧的、满足范围的版本**装上去 —— 不报错。

```
profile 声明:  "@sparkelf/dsh-plugin-backup": ">=0.2.1-alpha.1"    ← 范围
刚发布的:      alpha.4（42 分钟前）        → 被窗口拒绝
回退到:        alpha.1（21 小时前）        → 满足范围且已过窗口 → 装上
```

### 决定性对照：精确 pin 不会回退

| 声明方式 | pnpm 行为 | 结果 |
|---|---|---|
| `"0.2.1-alpha.4"`（精确） | 无路可退 → 写入豁免列表 | **装到正确版本** |
| `">=0.2.1-alpha.1"`（范围） | 回退到窗口外的旧版 | **静默装旧的** |

实测（2026-10-05，同一镜像、同一构建）：

```
dsh-plus:           "0.2.1-alpha.4"      → 装 0.2.1-alpha.4  ✓
dsh-plugin-backup:  ">=0.2.1-alpha.1"    → 装 0.2.1-alpha.1  ✗
```

**症状组合**（记住这个）：
- profile `package.json` 声明的版本很新
- `node_modules` 里装的是旧版
- **没有任何报错**，构建成功
- patch 层按名字挂载插件 → 模块在但行为是旧的

### 怎么查

```bash
# 1) profile 声明的版本 vs 实际装的版本
CID=$(docker run -d --entrypoint sleep dataops-ai-workspace:local 120)
docker exec "$CID" sh -c '
  P=/opt/dataops-dsh-profile-template
  echo "=== 声明 ==="; grep -E "dsh-(plus|plugin-backup)" $P/package.json
  echo "=== 实装 ==="
  for n in dsh-plus dsh-plugin-backup; do
    node -p "\"  $n: \" + require(\"$P/node_modules/@sparkelf/$n/package.json\").version"; 
  done'
docker rm -f "$CID"
```

```bash
# 2) 构建日志里的豁免写入（pnpm 自己写的，就是它选了什么版本）
grep -E 'Added [0-9]+ entries to minimumReleaseAgeExclude' /tmp/build-*.log
# 看豁免列表里的版本 → 那就是实际装的版本
```

```bash
# 3) 对比发布年龄
curl -s 'https://registry.npmjs.org/@sparkelf/<pkg>' | python3 -c "
import sys,json; d=json.load(sys.stdin); t=d['time']
for v in ['0.2.1-alpha.3','0.2.1-alpha.4']: print(v, t.get(v))")
```

### 修复

**在 profile 的 `pnpm-workspace.yaml` 里关掉窗口**（`assemble-registry-profile.mjs` 已内置）：

```yaml
minimumReleaseAge: 0
```

**为什么可以关**：构建是受控环境 —— 每个版本的取值由正在构建的 release 决定，容器也不与窗口要保护的任何东西共享。窗口在这里只带来「范围悄悄指向另一个版本」这一种后果。

**验证方式**（不要只看构建通过）：
```bash
cd /tmp && rm -rf t && mkdir t && cd t
printf '{"name":"t","version":"1.0.0","dependencies":{"@sparkelf/<pkg>":">=x.y.z"}}\n' > package.json
printf 'packages:\n  - .\nminimumReleaseAge: 0\n' > pnpm-workspace.yaml
pnpm install --lockfile-only
grep -oE '<pkg>@[0-9][^ ]*' pnpm-lock.yaml | sort -u   # 应是最新，不是回退版
```


---

## 17. `carry` 在 `install` 之后 = **手工加的依赖永远不会被安装**

### 症状

- patch 层用 insert 挂载了某个插件，`node_modules` 里没有这个包
- 插件静默不生效，没有任何报错

### 机制

`dsh-plus-mirror create` 的步骤顺序有个缺口：

```
line 151  installing again ...              <- pnpm install（此时 profile 还没有手工依赖）
line 175  carrying the reviewed patch ...   <- carry 把手工依赖写进 package.json
                                              但没人再 install 一次
```

`carry-profile-state.mjs` **自己知道**这个问题，它会打印：

```
the profile needs an install for the added dependencies
```

**但它只打印，不执行安装。**

### 为什么容易漏

手工加的依赖（典型是 file: 指向本地插件）：

```json
"@sparkelf/dsh-image-hoist": "file:/root/projects/dsh-image-hoist"
```

它**不在** harness 的 variant 里，所以 `generate-manifest` 不管它、`verify-plus-governance` 不检查它，只有 `carry-profile-state` 会搬它 —— 而搬完没人装。

### 怎么查

```bash
# patch 层声明了哪些插件，逐个核对是否真的装了
for p in dsh-image-hoist dsh-plugin-backup; do
  test -d /root/.dsh/profiles/plus/node_modules/@sparkelf/$p \
    && echo "  ok       $p" || echo "  MISSING  $p  <- patch 层挂了但没装"
done
```

### 修复

`dsh-plus-mirror` 已在 carry 之后补了一次 install。

### 应急修复（不动 mirror）

在 profile 里手工 install 后，**必须**补三步恢复，否则 profile 变 DEFECTIVE：

```bash
node /root/.dsh/supervisor/repair-shadowed-scope.mjs --release <mirror>
node /root/.dsh/supervisor/restore-nested-modules.mjs \
     --release <mirror> --backup <mirror> --reference <健康镜像>
node /root/.dsh/supervisor/check-profile-scope.mjs --release <mirror>   # 必须 healthy
```

**实测教训**：在**正在运行**的 profile 上直接 pnpm install，会清掉镜像源码树里 29 个包的嵌套 node_modules。服务不会当场挂（进程已加载），但**下次重启会失败**。

---

## 18. `- id:` **不能创建**行 —— 只会报 `patch: entry "..." not found`

**这是「插件声明了、装了、但完全不生效」最隐蔽的一种。构建通过、包在 node_modules 里、无任何报错。**

### 两种形式的语义

| 写法 | 语义 | 用途 |
|---|---|---|
| `- id: xxx` + `config:` | **修改**已存在的行 | 改官方/上游插件的行为 |
| `- insert:` + `- id:` + **`name:`** | **创建**新行 | 挂载一个新插件 |

**`- id:` 单独出现时，行必须已被某个 bundle 创建过。** 否则 loader 打印：

```
dsh: [@sparkelf/dsh-plus] patch: entry "image-hoist" not found
```

**注意这句是 warning，不是 error** —— 构建成功，插件静默不加载。

### 实测（2026-10-05）

```yaml
# ✗ 错：只改不建
- id: image-hoist
  config:
    providers: []

# ✓ 对：显式创建
- insert:
    - id: image-hoist
      name: '@sparkelf/dsh-image-hoist'
      config:
        providers: []
```

### 为什么容易写错

`config` 那半段两种形式**完全相同** —— 只有 `- insert:` 这一层和 `name:` 字段有区别。凭印象手写时极易漏掉。

### 怎么查

```bash
# 1) dump-config 看 loader 的真实组合（权威）
node <release>/apps/cli/lib/bin.js --profile <name> --dump-config 2>&1 \
  | grep -E '<plugin-id>|not found'

# 2) 出现 'entry "xxx" not found' = 用了 - id: 但没人创建它
```

```bash
# 3) 确认包真的装了（装了 ≠ 挂载了）
test -d <profile>/node_modules/@sparkelf/<name> && echo 已装 || echo 未装
```

**两者都要查**：包在 node_modules 里但 `not found`，就是本节这个问题。


---

## 19. 在已部署的 profile 上跑 `pnpm install` **会静默降级一切范围依赖**

**这条是我自己踩的（2026-10-05），造成 3080 的 Backup 修复失效数小时。**

### 事故经过

为了给 3080 装一个本地插件，我在**正在运行的 profile** 上跑了 `pnpm install`。

```
改前:  dsh-plugin-backup 0.2.1-alpha.4  （含 Backup 修复）
改后:  dsh-plugin-backup 0.2.0-rc.52  （修复没了）
导出:  5 条 → 2 条
```

**原因**：profile 里这些依赖声明是 `^0.2.0-rc.45`。caret 在 prerelease 上**不跨版本元组** —— `^0.2.0-rc.45` 的上界是 `0.2.0`，永远匹配不到 `0.2.1-alpha.x`。所以 pnpm 重新解析时选了它唯一能满足的 `0.2.0-rc.52`。

**我当时没发现**，因为只检查了「包还在不在」，没检查「导出还是不是 5 条」。

### 规则

**不要在已部署的 profile 上直接 `pnpm install`。** 如果必须：

1. **先把范围声明改成精确版本**

```json
"@sparkelf/dsh-plugin-backup": "0.2.1-alpha.4"   // 不是 ^0.2.0-rc.45
```

2. **并在 `pnpm-workspace.yaml` 关掉发布年龄窗口**（见 §16）

3. **装完必须重新验证行为**，不只看文件存在：

```bash
# 例：Backup 修复的判据是导出条数，不是包版本
# 修复前 2 条，修复后 5 条
```

4. **`pnpm install` 会破坏 profile scope**（见 §17），之后要跑：

```bash
node /root/.dsh/supervisor/repair-shadowed-scope.mjs --release <mirror>
node /root/.dsh/supervisor/check-profile-scope.mjs --release <mirror>  # 必须 healthy
```

### 推广到其它场景

同一个模式出现在**任何**用范围声明的依赖上：
- `^0.2.0-rc.45` 匹配不到 `0.2.1-*`
- `>=0.1.7-rc.2` 会满足，但可能被年龄窗口回退（§16）
- 只有**精确版本**是可靠的

---

## 20. 构建速度：**别杀 buildkit 子进程** + 快速迭代路径

### 一、`kill buildkit` 会把层缓存清空（我踩过）

为了「防止缓存挂载被占用」，我写过一个清理：

```bash
# ✗ 错误：这杀的是 buildkit 自己的工作进程 → 层缓存全失效
for q in $(ps -eo pid,cmd | grep -E '[r]unc.*buildkit' | awk '{print $1}'); do
  for c in $(pgrep -P $q); do kill -9 $c; done
  kill -9 $q
done
```

**实测对照**（同一台机器、同一 Dockerfile）：

| 操作 | 结果 | 耗时 |
|---|---|---|
| 不改任何东西直接重跑 | 33 层 CACHED | **1 秒** |
| 先跑上面的清理再构建 | 0 层 CACHED | **820 秒** |

**正确做法**：只清理真正的孤儿构建进程（`build-and-verify.mjs`），**不要动 buildkit**：

```bash
pkill -f 'build-and-verify.mjs'    # 只杀构建脚本本身
# 然后等几秒，让 docker 自己回收
```

### 二、版本 ARG 的位置决定重建代价

```dockerfile
# Dockerfile 第 86 行
ARG DSH_STANDALONE_VERSION=0.2.1-alpha.6
```

**这个 ARG 一变，它之后的 30+ 层全部失效。** 但真正用到它的只有 5 处：

```
113  npm install ${DSH_STANDALONE_PACKAGE}@${DSH_STANDALONE_VERSION}
212  写 .dataops-source-ref
264  写 profile 的 source-ref
416  ENV DATAOPS_DSH_SOURCE_REF
```

**结论**：换版本 ≈ 13 分钟；只改插件/overlay（版本不变）≈ 1-2 分钟。

### 三、三档速度，选对档次

| 场景 | 方式 | 耗时 |
|---|---|---|
| **开发迭代** | `bundle` → `docker cp` 进容器 → 重启 DSH | **~30 秒** |
| **改 overlay/profile** | 直接改容器内文件 + 重启 DSH | **~30 秒** |
| **改插件源码** | 上面 + `pnpm --filter <pkg> bundle`（实测 5 秒） | **~40 秒** |
| **重建镜像（版本不变）** | `node build-and-verify.mjs` | **1-2 分钟** |
| **重建镜像（换版本）** | 同上，但 ARG 连坐 | **~13 分钟** |
| **正式发布** | `ship.ts --prerelease alpha.N`（PR + CI + 合并） | **~10 分钟** |

**不要每轮都走完整链路。** 迭代用快速路径，最后一次走正式链路。

```bash
# 快速验证插件改动（不碰 npm、不重建镜像）
pnpm --filter @sparkelf/<pkg> bundle                      # 5 秒
docker cp packages/<pkg>/lib/. <容器>:/opt/dsh-plus/node_modules/@sparkelf/<pkg>/lib/
# 或（工作区侧）
docker cp packages/<pkg>/lib/. dataops-ai-admin-dsh-runtime:/workspace/.dataops/dsh/profiles/dataops-web/node_modules/@sparkelf/<pkg>/lib/
# 重启 DSH
```

**注意**：`docker cp` 只适合验证，**产物必须走正式链路才算交付**。

---

## 21. 宿主机也有一个 3080 —— 别在错的服务器上验证

**这是本次最贵的一个坑：我在宿主机上对着自己的 DSH 查了半小时「工作区插件为什么 404」。**

拓扑（实测）：

| 监听 | 归属 | `/` | `/integrations/dataops/*` |
|---|---|---|---|
| `127.0.0.1:3080`（宿主机） | **宿主机自己的 DSH**（`apps/cli/lib/bin.js --profile plus`） | 200 | **404** |
| `127.0.0.1:3080`（companion 容器内） | **工作区 DSH**（`--profile dataops-web`） | 200 | **200** |

两者都返回 200，所以「curl 得通」完全不能区分。工作区的 3080 **没有发布到宿主机**（companion 与 admin 共 netns，admin 只发布了 `43117→127.0.0.1:44620`），因此宿主机根本访问不到它。

**规则：查工作区插件路由，必须在容器里查。**

```bash
# ✗ 错：这是宿主机自己的 DSH，永远 404
curl -s http://127.0.0.1:3080/integrations/dataops/workspace-limits

# ✓ 对
docker exec dataops-ai-admin-dsh-runtime bash -lc \
  'curl -s http://127.0.0.1:3080/integrations/dataops/workspace-limits'
```

**另一个混合坑**：访问插件路由要走**工作区网关**（`localhost:32008`），它会把同源请求转给 companion 的 3080。在宿主机上直接打 `32008` 会得到 `403 Forbidden`（网关只认浏览器带来的会话），**这也不是故障** —— 要在容器里、带会话地打。

**排错时的判据**：`GET /integrations/dataops/<name>` 返回 **404** 才说明路由没注册；`403` 是网关鉴权，`405` 是方法不对（`managed-auth` 正常就返回 405）。三者含义完全不同，别混。

---

## 22. 插件 `apply()` 的注册顺序：启动期失败必须**不能**吃掉路由

**这一类 bug 会让设置面板整个消失，而且没有任何报错。**

症状组合（记住）：

- 前端页面提示「重新连接中」/ 连接失败
- `POST /integrations/dataops/managed-auth` 返回 **405**（方法不允许 = 路由在，但只收 POST）或 **404**（路由根本没注册）
- web.log 里能看到插件那一行报错，但**不会有「插件未装配」之类的醒目告警**

**根因**：`apply()` 里有一段「启动期连接 DataOps」的代码（`ensureMcp()`），它 `await` 了 MCP 连接，而且**写在注册路由之前**。存量 JWT 过期 / DataOps 暂时不可达时它会抛 —— 于是 `apply()` 在注册任何路由之前就中断了，插件的四条路由一条都没挂上。

**这是插件的缺陷，不是环境问题**：一个「DataOps 连不上」的状态，恰恰是设置面板**应该显示**的状态，却因为抛异常让面板自己都起不来。

修法（顺序即契约）：

```ts
export async function apply(ctx, config) {
  // 1) 先把路由全部注册掉
  ctx.effect(() => ctx.webServer.register({ ... }), '...: managed-auth route')
  // ... 其余三条

  // 2) 最后才尝试连接；连接失败只记录，不抛出
  await connectExisting()
}
```

```ts
const connectExisting = async () => {
  if (await ctx.credentials.resolve(accessRef) === undefined) return
  try {
    await ensureMcp()
  } catch (error) {
    ctx.logger.warn('connecting the DataOps MCP server failed; settings routes stay up so a new JWT can be connected')
    ctx.logger.warn(error)
  }
}
```

**推广**：任何 `apply()` / `start()` 里「对外部系统的 `await`」都不能排在「注册自己的对外接口」之前。**注册在前，连接在后，连接失败只记不抛。**

**验证**：宿主侧写一个 stub 上下文（`credentials.resolve` 返回 token、`plugin()` 返回一个 `await` 必 reject 的 fiber），断言四条路由**依然注册**、路由在「凭证被拒」时回 503 而不是 404。

---

## 23. `volatile` 配置字段是**引用**，不是值

`Config` 里标了 `.volatile()` 的字段（本插件是 `modelSync` / `settingsSync`），运行时交给插件的是 `Volatile<T>` 引用对象，**不是 T 本身**。直接读字段读到的是那个引用。

```ts
// ✗ 错：读到的是引用对象，config.modelSync.detached 恒为 undefined
const state = config.modelSync

// ✓ 对：DSH 自己的写法（见 packages/llm/llm-deepseek/src/config.ts）
import { isVolatile } from '@deepseek-ai/cosmokit'
const state = isVolatile(config.modelSync) ? config.modelSync.get() : config.modelSync
```

**为什么会突然暴露**：`@deepseek-ai/schemastery` 的 `volatile()` 返回类型在 3.18.4 才收紧成 `Volatile<T>`。

**连带教训 —— peer 范围要跟着能力走**：插件原先声明 `schemastery: ">=3.18.1"`，但 `volatile()` 的引用语义从 **3.18.4** 才有。声明一个不提供该能力的版本下限，等于允许一份**会在运行时静默读错值**的装配。同类正确写法见 `packages/mobile-bridge/package.json`（`">=3.18.4"`）。

**判据**：用到某个 API 的返回值/语义时，peer 下限要盯**该 API 的引入版本**，不是「能装上就行」。

---

## 24. 面板能力清单：重设计前先对账

重写 UI 时把旧版搬空了一半才发现 —— **先列清单再动手**。

设置面板重写前的自查：

```bash
# 旧版暴露了哪些动作？
git show <old>:<section>.tsx | grep -nE "post[A-Za-z]+\(|action:|onClick"
# 新版还剩哪些？
grep -nE "post[A-Za-z]+\(|action:|onClick" <section>.tsx
```

逐条对照「动作 / 字段 / 开关」三类，确认没有静默丢功能。本次差点丢掉「按模型共享」相关的行，是靠这条对账发现的。

**同时记住设计规范在哪**：官方 token 与尺寸以 `packages/client/ui-theme/src/styles/design-platform.css` 为准（字号 `--dsw-font-*`、圆角 `--dsw-radius-*`、卡片 `--dsw-alias-settings-card-fill/-stroke`）；可复用控件从 `@deepseek-ai/dsh-client-ui-primitives` 取（`Switch` / `Button` / `SettingsValueField` / `StateDot` / `fileSizeText` / `Tag` …）。**不要手搓开关，不要自造字号。**

---

## 25. patch 包装了 ≠ patch 生效了（最贵的一条）

**症状**：HTML 预览打不开，宿主把工作区相对路径 `/ielts-trainer/index.html` 当根路径去 stat，回 ENOENT。四个 `dsh-better-sidebar` 补丁**都装了**，但一个都没生效。

**判据**：补丁包装在 `node_modules` 里是「已安装」，**和「已应用」从外面看完全一样** —— 所以构建、启动、所有断言全绿，补丁却没进树。

一个命令看穿：

```bash
docker exec <companion> node -e "
const s=require('node:fs').readFileSync('<profile>/node_modules/dsh-better-sidebar/lib/index.js','utf8');
console.log('patched mark:', (s.match(/htmlCwd/g)||[]).length);   // 0 = 没生效
console.log('pre-patch line:', s.includes('const { sessionId, path } = decoded.ref'));  // true = 没生效
"
```

**根因**：npm 补丁靠 profile 的 `pnpm-workspace.yaml` 里 `patchedDependencies` 条目生效，而写这个条目的是 `dsh-plus apply`。**这条命令要求一个 HEAD 等于发行版 base revision 的官方 DSH git checkout** —— registry 安装根本没有 checkout。

镜像曾经用 git 源码构建，那一版的 Dockerfile 里有：

```dockerfile
node .../bin.js plugin --profile <name> exec dsh-plus apply --dsh-root /opt/dsh-plus
```

**改成 registry 安装时这一步被丢掉了**（commit `5682623`），此后每个镜像都没有补丁。

**修法**：`infra/docker-workspace/materialize-npm-patches.mjs` 替代该命令 —— 读发行版装的补丁包，取 `target.kind === 'npm'` 的变体，把 `patchedDependencies` 块写进 profile；随后的 `plugin install` 就会打上补丁。

三条硬约束，每条都踩过：

| 约束 | 违反后的症状 |
|---|---|
| **必须在 profile 自己的 install 之前跑** | 装完再写：lockfile 与条目不符，pnpm 的 `--frozen-lockfile` 报 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` = 构建失败 |
| **必须零依赖（不 import yaml/semver）** | 此刻 profile 还没有 `node_modules`，`ERR_MODULE_NOT_FOUND: yaml` = 构建失败 |
| **落在 install 根目录，不在 profile 里** | 放 profile 里则解析不到发行版；放 install 根（`$DSH_INSTALL_DIR`）才对 |

**只管 npm 变体**：`dsh-source` 变体改的是官方包，而 standalone 的 `overrides` 已经把官方包换成「已打过补丁的重发布包」，没有 checkout 可打，也不该打。

**构建里必须有一条断言**，否则下次重构又会静默丢掉（这次就是）：

```dockerfile
grep -q 'htmlCwd' "${profile}/node_modules/dsh-better-sidebar/lib/index.js"
```

---

## 26. 发行版 pin 的是插件版本 —— 面板功能跟着 pin 走

**症状**：设置面板里文件大小那一块整体 404，而同插件的其他路由 200。

**判据**：不要怀疑插件代码，先看**发行版 pin 了哪个插件版本**：

```bash
# 运行中的 profile 实际装的是哪个版本
docker exec <companion> node -e "console.log(require('<profile>/node_modules/@sparkelf/dsh-dataops-managed/package.json').version)"
# 它注册了哪些路由（路由是版本的函数）
docker exec <companion> grep -o 'integrations/dataops/[a-z-]*' <profile>/node_modules/@sparkelf/dsh-dataops-managed/lib/index.js | sort -u
```

本次：镜像装的是 `0.3.13`（**没有** `workspace-limits` 路由），而带该路由的是 `0.3.14`、带面板重设计的是 `0.3.15`。pin 在 `packages/bundle/plus/package.json` 的 `dshPlus.profile.standaloneVariants.dataops.includePackages`。

**最坑的一点：版本号可能被复用。** 我先查到「0.3.14 已发布且有 limits 路由」，就把 pin 改成 0.3.14 —— 但**已发布的 0.3.14 是旧构建**，没有我后来加的注册顺序修复和面板重设计（对比 md5 才看出来）。**发新内容必须发新版本号**，改完源码要 bump：

```bash
# 发布前先确认 registry 上那个版本里到底有什么
cd /tmp && npm pack @sparkelf/<pkg>@<version> >/dev/null && tar xzf *.tgz
grep -c '<你刚加的标记>' package/lib/index.js   # 0 = 那个版本里没有
```

**改 pin 的完整链路**（少一步 gate 就红）：

```bash
# 1. 改两个 manifest 里的 pin（bundle + standalone）
# 2. 重新生成 standalone manifest（它写着 pin）
npx tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus \
  --out packages/standalone/dataops-standalone/package.json --runtime-version <dsh 版本> --variant dataops
# 3. 刷新 lockfile
pnpm install --lockfile-only
# 4. 三个 gate
pnpm run verify:plus-governance && pnpm run verify:standalone-manifest && pnpm run verify:standalone-variants
```

最后走 `release:ship` 发版，再把 `infra/docker-workspace/Dockerfile` 的 `DSH_STANDALONE_VERSION` 提到新版本重建 —— **pin 改了但没发版，工作区拿到的还是旧插件。**

---

## 27. 官方包的修复进不了工作区 —— 除非重新发一个上游版本

**症状**：权限选择器里「完全权限」是中文，「Auto review」是英文（中文环境），图标也缺一个。

**判据**：先确认是**键缺失**而不是翻译没加载 —— 打开下拉框看渲染出来的字：

```bash
# 出现在页面上的是「Auto review」，说明走的是 fallback，不是字典
docker exec <companion> grep -o 'access\\.preset\\.[a-zA-Z]*' <profile>/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js | sort -u
```

修复在源码里（`ui-conversation/src/client/locales.ts` 加 `access.preset.auto`、`PermissionSelect.tsx` 加盾牌图标；`ui-permission-presets/src/client/presentation.ts` 加 `preset.auto`），**但装到工作区的是官方 npm 包，不是源码。**

要让它生效有两条路，理解这两条才知道为什么这类改动特别贵：

| 路径 | 做法 | 代价 |
|---|---|---|
| **重新发布官方包** | 打补丁 → 加进 `PATCHED_WORKSPACES` → 加 override → `release:republish-patched` | 必须先把补丁 rebase 到要发的那个版本上 |
| **换上游版本** | 上游把修复发进新版本，bundle 的 override 提到新版本 | 等上游 |

第二条路卡在一个**刻意设计的门禁**上（`package-patched-official.mjs` 的 `requireSourceVersion`）：

```
Error: --version 0.2.1-alpha.2 but the source declares 0.1.6-alpha.1 at
packages/bundle/web-app; rebase the patches onto the 0.2.1-alpha.2 tree first
```

**这不是可以绕过的报错，是这个命令的正确行为**：重发布是把某个 checkout 的构建产物按一个新版本号发出去，如果那个 checkout 不是这个版本，就发出一个「声称自己来自某次发布、实际不是」的包。所以 `--version` 只允许等于 `packages/bundle/web-app/package.json` 里已经写的版本。

本次实测的结论：`dsh-v0.2.1-alpha.1` 这个 tag 的 web-app 正好是 `0.2.1-alpha.1`（也就是 override 需要的版本），但 **tag 时间 2026-10-03 早于修复 2026-10-08**，所以那个 tag 的树里没有修复 —— 两个条件无法同时满足。

**所以动手前先算这道题**：

```bash
git log -1 --format='%ad' --date=short <修复 commit>        # 修复何时发生
git rev-parse <目标版本 tag>                                 # 版本对应哪个 checkout
git merge-base --is-ancestor <修复 commit> <tag> && echo YES || echo NO   # 能否共存
```

**YES 才继续**；NO 就只有等上游发版，或者先 rebase 全部 23 个补丁到新版本树上（那是另一个量级的工程）。

### 还有第三条路：**给已发布的包打 npm 补丁**（本次实测走通）

重发布被门禁挡住 ≠ 没法修。**npm-target 的补丁包不经过重发布**，它和 better-sidebar 那四个补丁是同一条路：镜像里的 `materialize-npm-patches.mjs` 把 `patchedDependencies` 写进 profile，pnpm 在 install 时把补丁打上去。

**关键：key 必须用「拥有字节的那个名字」，也就是 alias，不是 profile 里声明的名字。**

profile 的 override 是 `npm:@sparkelf/dsh-client-ui-permission-presets@0.2.1-alpha.1`，目录名却是 `@deepseek-ai/dsh-client-ui-permission-presets`。四种写法实测：

| key | 结果 |
|---|---|
| `@deepseek-ai/...@0.2.1-alpha.1` | `ERR_PNPM_UNUSED_PATCH` — 没有包叫这个名字 |
| `@sparkelf/...@0.2.1-alpha.1` | **通过**，patch 打上了 |
| `@sparkelf/...@0.2.1-alpha.1` + 无 `diff --git` 头 | `ERR_PNPM_INVALID_PATCH: no valid patches found` |
| `@deepseek-ai/...@npm:@sparkelf/...` | `ERR_PNPM_PATCH_NON_SEMVER_RANGE` |

**补丁文件格式**（少一样就 INVALID_PATCH）：必须有 `diff --git a/... b/...` 头行，`---`/`+++ ` 后**不能带时间戳**：

```
diff --git a/lib/client.js b/lib/client.js
--- a/lib/client.js
+++ b/lib/client.js
@@ -164,6 +164,7 @@
```

用 `diff -u` 生成后要补第一行、并 `sed` 掉时间戳，否则 pnpm 直接拒收。

**三条配套改动**（缺一个 gate 就红）：

1. 补丁包的 `target.range` **必须有上界** —— `verify:plus-governance` 要 `exact or upper-bounded`，`>=0.1.7-rc.2` 会被拒，写 `>=0.1.7-rc.2 <0.3.0`。
2. 目标包必须**被发行版拥有**（`ownsRuntimePackage`）：要么在 `dependencies`，要么在 `dshPlus.profile.dependencies`。放到 `profile.dependencies` 时**顺序也要对** —— 那个 gate 用 `JSON.stringify` 比较，是顺序敏感的，新条目要加在**期望列表的同一位置**。
3. `.agents/plugins/curated.yaml` 要给它一条 entry + `localPatches`（带 `retireWhen`），否则 `curation must own upstream retirement` 失败。

**不要用「改小 `PACKAGED_FILES`」「跳过校验」之类的办法硬发** —— 那正是这类静默失效的来源。

---

## 28. 换镜像后所有插件路由 404 —— **先等，再查**（`ready:true` 不代表插件已挂载）

**症状**：刚换完镜像，五个路由全 404，连 `_dataops/session` 也 404 —— 但 `dataops-dsh-service status` 已经报 `ready:true`。

**根因**：`web_ready()` 只 `GET /` 看是否返回 2xx/3xx：

```python
# DSH先监听socket再挂载Web路由；仅根页面成功才报告Web ready。   ← 源码里的注释就写了这件事
def web_ready():
    connection.request("GET", "/", ...)
    return 200 <= response.status < 400
```

**socket 先监听、插件树后挂载**，所以根页面能出 HTML 时，插件路由还没注册。实测轮询：

```
+0s  ready=true  route=404
+4s  ready=true  route=200
```

**`ready:true` 与「路由可用」之间有几秒到十几秒的窗口。** 换镜像后立刻探路由，几乎必然拿到全 404。

**正确做法**：轮询到 200，而不是探一次就下结论：

```bash
C=dataops-ai-admin-dsh-runtime
for i in $(seq 1 30); do
  code=$(docker exec $C bash -lc "curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    http://127.0.0.1:3080/integrations/dataops/tool-timeout")
  [ "$code" = "200" ] && { echo "routes up"; break; }
  sleep 5
done
```

**这次差点写成错的结论**：我先把原因归给持久卷里的 `.dsh-market` 残留（因为挪走它之后路由就好了）。**反向验证推翻了它** —— 把那个目录原样放回去再重启，路由**照样 200**。真正的变量只是「多等了一会儿」。

**还看到过一条真的能让整个插件树停住的错误**（与本节症状相同、原因不同）：

```
Error: command "export" is already registered
  at .../@deepseek-ai/dsh-session-log-export/lib/index.js
dsh: warning: 1 entry did not activate
```

**一条 entry 没激活，后续路由就都不注册。** 这行在几万行日志的中间，`tail` 看不到 —— 所以插件路由异常时，要按「启动」分段去 grep：

```bash
C=dataops-ai-admin-dsh-runtime
L=$(docker exec $C bash -lc 'grep -n "starting node" /workspace/.dataops/dsh/logs/web.log | tail -1 | cut -d: -f1')
docker exec $C bash -lc "sed -n '$L,\$p' /workspace/.dataops/dsh/logs/web.log | grep -E 'did not activate|already registered|Error'"
```

**排查顺序**：先轮询 30 秒确认不是等待窗口 → 再按启动分段 grep 服务端日志 → 最后才是怀疑镜像。


## 29. 设置面板「保存」永远失败：CLI overlay 把该键钉死了（附一堆诊断坑）

**症状**：面板里改任何值 → 保存 → 报错（前端可能只显示泛化错误）。改回原值也一样失败。实测报的是：

```
Configuration for "dataops-managed" is overridden by a home patch or command-line overlay
```

**根因**：镜像用 `--patch /opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml` 启动 DSH。overlay 在 `cordis.patch.yml` **之后**参与组合，冲突时**它赢**。设置编辑器（`@deepseek-ai/dsh-config-editor`）的写法是：写 profile 的 `cordis.patch.yml` → 重新组合 → 比对刚写入的 config 与组合结果；只要 overlay 里还写着同一个键，比对必然不等，于是**拒写**。

所以 **overlay 里的键 = 只读钉死**。判断方法：

```bash
# overlay 里有没有这个键
grep -n 'toolCallTimeoutMs' /opt/dataops-runtime/src/dataops-dsh-embedded.patch.yml
```

**修法**：可编辑的值**不要**写进 CLI overlay，靠插件 schema 的 `default()` 给初值；overlay 只留运维必须钉死的键（本例：`baseUrl` / `serverName` / `credentialRef` —— 它们决定插件连哪个后端、用谁的凭证）。

要留初值又不钉死，放进 **profile 自己的 `cordis.patch.yml`** —— 那正是编辑器写入的那一层，而且 `prepare_profile()` 会在模板刷新时把它**原样保留**：

```python
user_patch = PROFILE_DIR / "cordis.patch.yml"
if user_patch.is_file():
    shutil.copy2(user_patch, staging / user_patch.name)
```

**实测（只把该键从 overlay 移除，其余不动）**：

| 步骤 | 结果 |
|---|---|
| `GET tool-timeout` | `{"toolCallTimeoutMs":300000}`（插件默认值生效） |
| 配置行仍然生效 | `managed-auth: 405`（MCP 客户端照样挂载） |
| `POST 90000` | `{"toolCallTimeoutMs":90000}` |
| `GET` 回读 | `{"toolCallTimeoutMs":90000}` |
| 落到哪 | profile `cordis.patch.yml` → `config: {toolCallTimeoutMs: 90000}` |

**这条 100% 会误导你的四件事**（我都踩了）：

1. **先查 overlay，别先查代码**。先怀疑 `apply()` 路由、schema、volatile —— 全不是。是组合顺序。
2. **只删那一行没用**。我以为删掉 `toolCallTimeoutMs` 就解锁了 —— 没用，还是同样的报错。**必须整行从 overlay 移除**（我是把整个 `- id: dataops-managed` 删掉才验证通的）。原因：只要 overlay 里还有该 `id` 的 `config:` 块，组合结果与写入内容就仍不等。
3. **往 profile 里补一个 `cordis.patch.yml` 也没用**，只要 overlay 还压着同一个键。
4. **改 overlay 文件后必须重启** `dataops-dsh-service`，而且**要等** —— 路由会先 404 或 500，约 10–60s 后才 200（见 §28）。我一开始把 500 当成新 bug，其实是后端 `http://host.docker.internal:3101` 当时整个不可达（宿主上也是 000）。

### 29.1 顺手挖出的两个独立故障

**(a) 孤儿锁文件把设置写入全堵死。** 编辑器写入前会取 `<profile>/package.json.lock`（`wx` 创建，内容为 pid）。若持锁进程变成**僵尸**，文件没人删：

```
atomic-write: timed out waiting for the writer lock at .../package.json.lock
```

诊断（照抄）：

```bash
C=dataops-ai-admin-dsh-runtime
docker exec $C bash -lc "cat /workspace/.dataops/dsh/profiles/dataops-web/package.json.lock; awk '{print \$3}' /proc/<pid>/stat"   # Z = 僵尸
docker exec $C bash -lc "for p in \$(ls /proc | grep -E '^[0-9]+$'); do ls -l /proc/\$p/fd 2>/dev/null | grep -q 'package.json.lock' && echo \$p; done"   # 空 = 没人持有
docker exec $C bash -lc "rm -f /workspace/.dataops/dsh/profiles/dataops-web/package.json.lock"   # 运维动作
```

DSH 的契约**故意不自动清理**：「file age cannot prove that its owner stopped; orphan recovery is an operator action」。所以**看到这行报错，先 `rm` 锁**，再谈别的。

**(b) `-32001 Request timed out` = DSH 侧 MCP 客户端超时，不是 DataOps 超时。** 报错来自 MCP SDK `protocol.js`：

```js
const timeoutHandler = () => cancel(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout }));
```

`ErrorCode.RequestTimeout = -32001`。`timeout` 由 `packages/plus/mcp-credentials/src/tools.ts` 传入：

```js
client.request({ method: 'tools/call', ... }, schema, { signal: exec.signal, timeout: opts.toolCallTimeoutMs })
```

即 **`toolCallTimeoutMs`**。链路上的默认值：

| 位置 | 值 |
|---|---|
| 插件最初默认（`01ed3cf`） | **120_000 = 2 分钟** |
| 镜像 overlay（改之前） | 120000 → 300000 |
| `@sparkelf/dsh-dataops-managed` 现默认 | 300_000 |
| DSH MCP 客户端未设时 | 60_000 |
| MCP SDK 兜底 | 60_000 |

**这个旋钮只管 DataOps 的 8 个 MCP 工具**（`McpClient` 全插件只挂载一次，端点 `/api/ai/data-query/mcp`）：`search_resources` / `list_resources` / `describe_resource` / `search_query_guidance` / `execute_sql` / `call_data_api` / `read_query_result` / `export_query_result`。**不是「所有工具」** —— 面板标签若写成「工具调用超时」会误导，应为「DataOps 查询超时」。

DataOps 后端在 MCP 查询路径上**没有 2 分钟常量**（`ai-data-query-mcp.service.ts` / `ai-dsh-embedded-data-query.service.ts` / `ai-mcp.service.ts` 里 `120000` 计数均为 0）。服务端真实上限是另一组：PostgreSQL 客户端默认 `statement_timeout` **12000（12 秒！）**（`execute_sql` 调用时**不传** `queryTimeoutMs`，走的就是它）、SQL 数据源 5 分钟、API 资源 40 分钟、Workspace guidance 默认 60 秒。**「查一会儿就失败」优先怀疑那个 12 秒，而不是 2 分钟。**

