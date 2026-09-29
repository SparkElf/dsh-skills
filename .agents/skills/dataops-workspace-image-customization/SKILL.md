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
