---
name: dsh-supervisor-restart
description: 重启 DSH/Plus 的 Web 服务（3080）或在部署里改配置、换插件、动环境变量时使用。讲清 supervisor 重启与 systemctl restart 的本质区别、何时才必须重建单元、$DSH_HOME/.env 的原生加载机制、以及会话内重启如何不当场杀死自己。排查「重启后连不上」「改了配置不生效」「端口被占」时优先读它。
---

# DSH / Plus 服务重启与配置生效

这个技能解决一类反复出现的事故：**改了配置、重启了服务，但改动不生效，或者重启把承载会话的进程一起杀了。**

核心结论先给：

1. **默认用 supervisor 重启**（`dsh-3080-restart`，不带 `--unit`）。它只回收 web 子进程，supervisor 常驻，control socket 不断，会话可恢复。
2. **只有在改变了「supervisor 进程自己的环境」或 profile 依赖时，才需要 `--unit`**。判断标准见第 2 节。
3. **`$DSH_HOME/.env` 会被 harness 原生加载**，不需要 systemd 注入。绝大多数「环境变量不生效」的问题，答案在这里而不在 systemd。
4. **会话内重启要脱离目标 cgroup**，否则验证脚本会被自己触发的重启杀掉（第 4 节）。

---

## 1. 先看清架构：谁在管谁

```
systemd unit (deepseek-harness-plus.service)
  └── supervisor 进程  (supervisor/runtime/bin.mjs)   ← 常驻，持有 control socket
        └── web 进程   (apps/cli/lib/bin.js --profile plus --port 3080)  ← 真正监听端口
```

- `dsh-3080-restart` 的 **supervisor 模式**：`sup restart` → 只 kill + 重新 spawn web 子进程。supervisor 的 `process.env` 不变。
- `dsh-3080-restart --unit`：`systemctl restart` → **整单元重建**，supervisor 进程是全新的，`process.env` 重新从 unit 定义加载。

supervisor 给 web 子进程传环境的方式（`supervisor.mjs`）：

```js
environment() {
  return { ...process.env, DSH_HOME: this.manifest.dshHome, DSH_SUPERVISOR: '1' }
}
```

关键：**web 子进程继承的是 supervisor 的 `process.env`**。所以 supervisor 的 env 决定了 web 的 env。

---

## 2. 决策表：该用哪种重启

| 你改了什么 | 该用 | 为什么 |
|---|---|---|
| `cordis.patch.yml`（增删插件、改插件 config） | **supervisor 模式** | patch 在 web 启动时读取，web 重启即生效 |
| `$DSH_HOME/.env` 里的变量 | **supervisor 模式** | harness 自己读（见第 3 节），不依赖进程 env |
| profile 的 `package.json` / 依赖 / 原生二进制 | **`--unit`** | 需要重新走 preflight + accept 指纹 |
| **systemd unit 的 `Environment=` / `EnvironmentFile=`** | **必须先 reload+重启单元** | 只有重建 supervisor 才会进它的 env |
| 换 profile 目录 / 换 release 版本 | **`--unit`** | supervisor 的 `cwd`、`args` 都要重建 |
| 只是想清一次内存/恢复会话 | **supervisor 模式** | 最快，且 socket 不断 |

判断口诀：**问题出在「进程继承链的哪一层」**。
- 只影响 web → supervisor 就够了。
- 影响 supervisor 自己（它的 env、cwd、命令行）→ 必须 `--unit`。

---

## 3. `$DSH_HOME/.env` 是原生加载的（最常被误解的一点）

**不要**为了给插件/工具注入一个变量就去写 systemd drop-in。先确认 harness 是否已经会读。

加载实现在 `packages/boot/app-boot/lib/index.js`：

```js
function loadLayeredEnv(binName, cwd = process.cwd(), warn) {
  const home = resolveDshHome();
  const inherited = { ...process.env };
  const project = readEnvLayer(binName, cwd, warn, home);       // <cwd>/.env
  const user    = readEnvLayer(binName, home, warn, home);      // $DSH_HOME/.env
  // 先全部解析（校验失败就抛错），再合并；已存在的 process.env 不被覆盖
  for (const layer of [project, user]) { ... }
  return createLaunchEnvironmentSnapshot([
    { source: 'process',     values: inherited },
    { source: 'project-env', ... },
    { source: 'user-env',    ... },
  ]);
}
```

要点：

- **层序信任度**：`process` > `project-env`(`<cwd>/.env`) > `user-env`(`$DSH_HOME/.env`)。
- **继承优先**：`if (process.env[name] === void 0)` 才写入 —— 外部已设的变量不会被 `.env` 覆盖。
- **两个 `.env` 都必须能被解析**，否则抛错（不是静默忽略）。
- CLI 的 `--profile` 分支会调用 `loadLayeredEnv('dsh')`（`apps/cli/lib/bin.js`），所以**走 profile 模式的 web 进程天然会读 `$DSH_HOME/.env`**。
- 插件通过 `launchEnvironmentOf(ctx).get('NAME')?.value` 取值，读的是**快照**，不是 `process.env`。

### 由此推出的重要事实

**插件拿到 `.env` 里的变量时，`/proc/<webpid>/environ` 里可能根本没有这个变量。**

不要用「进程 env 里有没有这个变量」来判断配置是否生效 —— 这会得出完全错误的结论。正确的判定是**功能是否真的可用**（例如实际发一次请求/搜索）。

`.env` 里禁止放的变量：`readEnvLayer` 会拒绝 bootstrap-only 名称（决定进程如何启动、代码从哪加载、如何联网的那些），并报错退出。这类只能通过启动环境提供。

---

## 4. 会话内重启：别把自己杀掉

如果重启是在 DSH 自己的会话里发起的，有两个陷阱：

### 陷阱 A：cgroup 连带清理

目标 unit 通常是 `KillMode=control-group`。systemd 会杀掉该 unit **cgroup 内的所有进程**。所以：

- `nohup` / `&` / `setsid` **都不够** —— 它们只脱离进程组/终端，**不脱离 cgroup**。
- 结果：重启瞬间脚本被杀，日志停在前半段，验证根本没跑。

正确做法：用 `systemd-run` 起一个**独立 transient unit**，它有自己的 cgroup：

```bash
SELF=$(readlink -f "$0")   # 必须绝对路径！systemd-run 的 cwd 是 /
systemctl reset-failed my-verify 2>/dev/null || true
systemd-run --collect --unit=my-verify \
  --description="restart and verify" \
  --setenv=MY_DETACHED=1 \
  /bin/bash "$SELF" "$@"
```

### 陷阱 B：用 `systemctl restart` 的退出码判成败

某些 unit 的 `ExecStartPost` 会主动停掉单元（注释里写明「ExecStartPost stops the unit — "active" then means "answering" rather than "forked"」）。于是 `systemctl restart` **返回非零，但服务其实起来了**。

还有 `Restart=on-failure` 会在失败后自动重试，可能几次失败后最终成功。

**判定服务是否健康，不要只看命令退出码。** 用可观测事实：

```bash
systemctl is-active <unit>
curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 5 http://127.0.0.1:3080/
```

需要更稳的话，用 `stop` + `start` 两步替代 `restart`，可以绕开 `ExecStartPost` 的返回码语义。

---

## 5. 端口归属：别被同名进程骗了

同一个 host 上可能跑着**多个 DSH 实例**（例如另一个在 docker 里做别的事，命令行同样含 `--port 3080`）。

`pgrep -f "port 3080"` 会匹配到**所有**这些进程，得出错误结论。要用监听者 PID：

```bash
ss -lptnH 'sport = :3080' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
```

再和 supervisor 记录的 `webPid` 对比：

```bash
python3 -c "import json;print(json.load(open('/root/.dsh/supervisor/runtime.json')).get('webPid'))"
```

两者一致才说明「supervisor 管着的 web 就是端口占用者」。不一致通常意味着有第二个实例在抢端口。

另有 `dsh-3080-restart --status` 可直接看状态（它会打印 unit/supervisor pid/web pid/socket/HTTP）。

---

## 6. 改插件 / 换搜索后端的完整流程

以「把 web_search 从 A 后端换到 B 后端」为例（A 挂 B 本地的常见场景）：

```bash
# 1) 先确认插件是否已安装、是否已被挂载
ls /root/.dsh/profiles/<profile>/node_modules/@scope/ | grep <plugin>
grep -n "id: <plugin-id>" /root/.dsh/profiles/<profile>/cordis.patch.yml

# 2) 改 patch（先备份）。挂载新插件 + 把选择器指向它
cp cordis.patch.yml cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)
#    - insert:
#        - id: <plugin-id>
#          name: '@scope/<plugin>'
#          config: { ... }
#    - id: web            # 覆盖已有行
#      config:
#        searchProvider: <provider-id>

# 3) 校验 YAML 合法（改坏了会导致启动失败）
node -e "const y=require('yaml'),f=require('fs');const d=y.parse(f.readFileSync('<patch>','utf8'));console.log('✓ entries:',d.length)"

# 4) 确认 provider 的 id 与取值来源（读它的 src/index.ts）
#    注意是否 fallback 到 launch environment（即 .env 是否够用）

# 5) 重启（supervisor 模式即可，因为只改了 patch）
dsh-3080-restart

# 6) 端到端验证：真的调用一次，而不是检查进程 env
```

**选择器的语义要注意**（以 `web` 服务为例，精确 id 匹配，**无优先级链**）：

- 配了 id + 已注册 + `available()` → 用它
- 配了 id 但未注册 → `WEB_PROVIDER_CONFIGURED_MISSING`
- 配了 id 但不可用 → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`（**最常见：key 没读到**）
- **未配 id** 且多个可用 → `WEB_PROVIDER_AMBIGUOUS`
- 未配 id 且只有一个可用 → 用它

所以「装了两个搜索插件、selector 没配」会直接报 AMBIGUOUS，而不是自动挑一个。

---

## 7. profile 指纹与 preflight

改了 profile 内容（含 `cordis.patch.yml`）后，指纹会变，`profile-guard` 会拒绝启动不符的 profile。

**通常不需要手动 accept**：`dsh-3080-restart` 第 1 步会调用 `preflight-start.mjs`，它按序做四件事，最后一步才是重新 accept：

1. 修 profile scope
2. 证明模块唯一性
3. 导入 profile 的插件（import 失败就 refuse）
4. 重新 accept 指纹

因此直接用 `dsh-3080-restart` 即可。手动 accept 只在你要在**不重启**的前提下更新指纹时才需要。

验证指纹是否漂移：

```bash
node --input-type=module -e "
import {fingerprintProfile} from '/root/.dsh/supervisor/profile-guard.mjs';
import fs from 'fs';
const st=JSON.parse(fs.readFileSync('/root/.dsh/supervisor/accepted-profile.json','utf8'));
console.log(st.profileFingerprint === fingerprintProfile(st.acceptedProfile).fingerprint ? '一致' : '已变更');
"
```

---

## 8. 反转与回滚清单

改配置前先想好怎么退回去：

```bash
# patch：备份后改，回滚就是覆盖回来
cp cordis.patch.yml.bak-<ts> cordis.patch.yml && dsh-3080-restart

# 若加了 systemd drop-in（多数情况不该加）：
rm /etc/systemd/system/<unit>.d/<file>.conf
systemctl daemon-reload
systemctl restart <unit>
```

**保留旧后端配置作为回退**：挂载新插件时不要删掉旧行。已绑定各自 id 的多行不会造成歧义（歧义只发生在**未配置 selector** 时）。

---

## 9. 速查

```bash
# 状态（推荐，一次看全）
dsh-3080-restart --status

# 重启：默认（只回收 web）
dsh-3080-restart

# 重启：整单元（改了 supervisor 的 env / 依赖 / release 时才用）
dsh-3080-restart --unit

# 端口真正的占用者
ss -lptnH 'sport = :3080'

# supervisor 记录的 web pid
python3 -c "import json;print(json.load(open('/root/.dsh/supervisor/runtime.json'))['webPid'])"

# 健康判定（别只看命令退出码）
systemctl is-active deepseek-harness-plus.service &&
  curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' http://127.0.0.1:3080/
```

---

## 10. 反面清单（本技能要防的错误）

- ❌ 为了注入一个变量就加 systemd drop-in —— 先查 `.env` 是否已被原生加载。
- ❌ 用 `--unit` 处理一个只需重载 web 的改动 —— 徒增中断与启动期竞态。
- ❌ 用 `/proc/<pid>/environ` 判断插件是否拿到配置 —— 快照机制下会误判。
- ❌ 用 `pgrep -f "port 3080"` 判断端口归属 —— 多实例下必错。
- ❌ 只凭 `systemctl restart` 退出码断言重启成功 —— `ExecStartPost` + `Restart=on-failure` 会让它不准。
- ❌ 用 `nohup`/`setsid` 让验证脚本活过一次重启 —— 不脱离 cgroup，照样被杀。
- ❌ 用裸 `FAILED` 匹配重启日志 —— supervisor 的 `"failed":0` 会假阳性。
- ❌ 装了两个同类 provider 却没配 selector —— 直接 `AMBIGUOUS`。
