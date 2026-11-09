# 逐步工具面板 Task 0 证据：bridge 能否观测 `step/start`（go / no-go）

记录时间：2026-11-09 16:18–16:21（本地 UTC+8）。仓库：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`，分支 `feat/per-step-tool-board`。主机：macOS，arm64，Node `v22.23.2`，Yarn `4.18.0`（Corepack），Electron `44.0.0`。

本文件是计划 `docs/superpowers/plans/2026-11-09-per-step-tool-board.md` Task 0 的 go / no-go 证据：它回答「`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts` 既有的 `session/event` 监听器在运行时是否收到上游 `step/start`」。结论见 §6。

| 字段 | 值 |
|---|---|
| 治理文档提交（Step 0） | **`125a25252a3fc66a3998a792ceaffb3b364a8629`**（`docs: add per-step tool board design, plan and review`） |
| 探针代码 | 仅存在于本次验证的工作树，未随本证据提交；Step 6 已删除（§7） |
| 隔离实例临时根 | `/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T//huaanwork-per-step.jDlBln`（`mktemp -d` 输出，`TMPDIR` 自带尾斜杠故出现 `T//`） |
| 隔离实例 profile | `desktop`（从 `~/Library/Application Support/HuaAnWork/profile-selection/state.json` 的 `active` 取得） |

## 1. Step 0：治理文档纳入版控

```bash
git add docs/superpowers/specs/2026-11-09-per-step-tool-board-design.md \
        docs/superpowers/plans/2026-11-09-per-step-tool-board.md \
        docs/superpowers/plans/2026-11-09-per-step-tool-board-plan-review.md
git commit -m "docs: add per-step tool board design, plan and review"
```

退出码 `0`；提交 `125a25252a3fc66a3998a792ceaffb3b364a8629`，3 个文件、2384 行新增。

## 2. Step 1：阳性对照与探针

在 `export function apply(ctx: Context): void {` 之后插入（`apply` 开头）：

```ts
  ctx.logger?.info?.("huaanwork-round-probe: ready");
```

在既有 `session/event` 监听器内、`const scope = sessionId === undefined ? {} : { sessionId };` 之后插入：

```ts
    if (event?.type === "step/start") {
      const seq = (event as { seq?: number } | undefined)?.seq;
      ctx.logger?.info?.(`huaanwork-round-probe: session=${String(sessionId)} stepSeq=${String(seq)}`);
      return;
    }
```

两处均按 brief 逐字插入。`step/start` 分支位于既有 child 会话早退之后，故子代理的 step 不会进入该日志；`return` 与既有分支结构一致，不改变产品行为。

## 3. Step 2：构建与隔离实例

### 3.1 构建

```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native
```

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `build` | **0** | `[dsh-plugin-huaanwork] Build complete`，`lib/client.js` 1,328.67 kB |
| `prepare:electron-native` | **0** | `Prepared fs-ext 2.1.1 for Electron 44.0.0 (darwin-arm64, ABI 149)` |

### 3.2 隔离根

```bash
REPO="$(pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/huaanwork-per-step.XXXXXX")"
chmod 700 "$TMP_ROOT"
mkdir -p "$TMP_ROOT/.huaanwork" "$TMP_ROOT/userData/profile-selection"
cp -R "$HOME/.huaanwork/." "$TMP_ROOT/.huaanwork/"
cp "$HOME/Library/Application Support/HuaAnWork/profile-selection/state.json" \
   "$TMP_ROOT/userData/profile-selection/state.json"
PROFILE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME + "/Library/Application Support/HuaAnWork/profile-selection/state.json", "utf8")).active)')"
TMP_ROOT="$TMP_ROOT" PROFILE="$PROFILE" corepack yarn workspace dsh-plugin-huaanwork node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const { parseDocument } = require("yaml");
const path = process.env.TMP_ROOT + "/.huaanwork/profiles/" + process.env.PROFILE + "/cordis.patch.yml";
const doc = parseDocument(readFileSync(path, "utf8"));
const row = doc.contents.items.find((item) => item.get("id") === "desktop-shell");
if (!row) throw new Error("desktop-shell row missing");
row.get("config").set("logLevel", "info");
writeFileSync(path, doc.toString());
console.log("logLevel=info");
'
echo "$TMP_ROOT" > /tmp/huaanwork-per-step-tmp-root
```

退出码 `0`；输出 `PROFILE=desktop`、`logLevel=info`；`stat -f '%Sp'` 对临时根返回 `drwx------`（700）。

### 3.3 启动

```bash
REPO="$(pwd)"
TMP_ROOT="$(cat /tmp/huaanwork-per-step-tmp-root)"
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  DSH_HOME="$TMP_ROOT/.huaanwork" \
  HUAANWORK_ACCEPTANCE_HOOKS=1 \
  "$REPO/dsh-plugin-huaanwork/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  "$REPO/dsh-plugin-huaanwork/lib/main.js" \
  --user-data-dir="$TMP_ROOT/userData" --remote-debugging-port=9333 \
  > "$TMP_ROOT/electron.log" 2>&1 &
echo $! > "$TMP_ROOT/electron.pid"
```

PID `92708`。`curl http://127.0.0.1:9333/json/list` 返回单一 `type=page` 目标，URL 为 `http://127.0.0.1:43120/?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-version=0.1.0&dsh-desktop-material=transparent`（webserver 未落默认口以外的占用，43120 可用）。

## 4. Step 3：触发一次真实工具运行

本环境无法点击 GUI，按控制器裁定改用一次性 CDP 驱动（`.superpowers/sdd/2026-11-09-per-step-tool-board/task0-cdp.mjs`，git 忽略的 scratch，不提交）。驱动流程：轮询 `/json/list` 至多 60 s 取唯一 `type=page` 且 URL 匹配 `http://127.0.0.1:<port>/` 的目标 → `Runtime.enable` → 点击 `button.nav-it[title="新建任务"]` → 原生 `HTMLTextAreaElement.prototype.value` setter 写入提示词并派发冒泡 `input` → 等 80 ms → 仅当 `.composer button.send[aria-label="发送"]` 存在且未禁用时点击（外层 30 s 就绪重试）→ 等 `.bubble.user` 计数增加、`.send.stop` 出现后再消失（总超时 300 s）。

发送的提示词（brief 原文）：

```text
请使用 bash 依次执行 pwd、ls、uname -a，并汇总输出。
```

命令与输出：

```bash
node .superpowers/sdd/2026-11-09-per-step-tool-board/task0-cdp.mjs \
  --prompt='请使用 bash 依次执行 pwd、ls、uname -a，并汇总输出。' --timeout=300000
```

| 输出 | 值 |
|---|---|
| 目标 | `AB141BEBE4B3BA371A9C269BE30AB6D5`，`http://127.0.0.1:43120/?dsh-desktop-mode=advanced&…` |
| `baseline` | `{"users":0,"assistants":0,"panels":0}` |
| `sent` | `true` |
| `running` | `true`（`.send.stop` 出现） |
| `final` | `{"users":1,"assistants":1,"panels":1}`（运行结束、`.send.stop` 消失） |
| 退出码 | **0** |

会话日志确认这是真实工具运行：`tool/call` 共 4 条 `bash`（`pwd`、`ls`、`uname -a`、`ls -la`），跨 3 个 `step/start`。

## 5. Step 4：证据

### 5.1 命令原文与输出

```bash
TMP_ROOT="$(cat /tmp/huaanwork-per-step-tmp-root)"
HOST_LOG="$TMP_ROOT/userData/logs/host/dsh-$(date +%F).log"
printf 'ready=%s\n' "$(grep -c 'huaanwork-round-probe: ready' "$HOST_LOG")"
printf 'steps=%s\n' "$(grep -c 'huaanwork-round-probe: session=' "$HOST_LOG")"
grep -m5 'huaanwork-round-probe:' "$HOST_LOG"
LATEST="$(find "$TMP_ROOT/.huaanwork/sessions" -name 'session.v4.jsonl.zstd' -print0 | xargs -0 ls -t | head -1)"
echo "session-log=$LATEST"
echo "session-steps=$(/opt/anaconda3/bin/zstd -dc "$LATEST" | grep -c '"step/start"')"
```

| 计数 | 值 |
|---|---|
| `ready` | **1** |
| `steps` | **3** |
| `session-steps` | **3** |

`HOST_LOG` = `/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T//huaanwork-per-step.jDlBln/userData/logs/host/dsh-2026-11-09.log`（`grep -c` 恰好命中 1 + 3 行）。

前 5 行（探针总共只产生 4 行，全部列出）：

```text
2026-11-09 16:19:40.828 [I] [huaanwork-bridge] huaanwork-round-probe: ready
2026-11-09 16:20:09.612 [I] [huaanwork-bridge] huaanwork-round-probe: session=**** stepSeq=6
2026-11-09 16:20:12.690 [I] [huaanwork-bridge] huaanwork-round-probe: session=**** stepSeq=22
2026-11-09 16:20:13.946 [I] [huaanwork-bridge] huaanwork-round-probe: session=**** stepSeq=27
```

### 5.2 会话 id

```text
session-log=/var/folders/fc/j0sprzg92_926g51qh0pyp9w0000gn/T//huaanwork-per-step.jDlBln/.huaanwork/sessions/--var-folders-fc-j0sprzg92_926g51qh0pyp9w0000gn-T-huaanwork-per-step.jDlBln-.huaanwork-profiles-desktop-workspace-sessions-huaanwork-2a5b07708c46f5a9-75fc4750--/huaanwork-2a5b07708c46f5a9-75fc4750/session.v4.jsonl.zstd
```

会话 id = **`huaanwork-2a5b07708c46f5a9-75fc4750`**（取自会话日志 header 的 `id` 与物理目录名）。

探针行里的 `session=****` 是产品日志脱敏（`mask-secrets.ts` 的 `SECRET_FIELD_NAME` 含 `session(?:id)?`，`session=` 的值被替换为 `****`），不是探针缺失。两处独立对账证明 `****` 就是该会话：

1. 同一 host 日志第 11 行（`16:20:13.148`，夹在 `stepSeq=22` 与 `stepSeq=27` 之间）由 `session-title-service` 明文写出 `session "huaanwork-2a5b07708c46f5a9-75fc4750"`；
2. 探针 `stepSeq` 与磁盘 `step/start` 的 `seq` 逐一相等：6 / 22 / 27（下表）。

### 5.3 探针与磁盘事件对账

| 探针行 | 时间 | `stepSeq` | 磁盘 `step/start` | 磁盘 `data` |
|---|---|---|---|---|
| 1 | 16:20:09.612 | 6 | `seq:6`，`time:1794212409612` | `{"turn":1,"step":1}` |
| 2 | 16:20:12.690 | 22 | `seq:22`，`time:1794212412690` | `{"turn":1,"step":2}` |
| 3 | 16:20:13.946 | 27 | `seq:27`，`time:1794212413946` | `{"turn":1,"step":3}` |

`stepSeq` 随运行递增，`session` 为该会话 id（经 §5.2 对账），与 brief 的「主路线成立」Expected 完全一致。

## 6. 结论

**主路线成立。** `ready=1`、`session-steps=3`、`steps=3`：bridge 既有 `session/event` 监听器在真实 Electron 实例中收到了全部 3 个 `step/start`，外层 `seq` 可直接读取（6 / 22 / 27），会话 id 与该会话日志一致。Task 5 可按主路线（`session/event` + `step/start` 盖 `roundKey`）实施，无需备选路线 `turnBoundary.lastStepStartSeq`。

分流判据对照：非 `ready=0`（阳性对照已落盘）、非 `session-steps=0`（模型进入 3 个 step 并执行 4 次 bash）、非 `ready>=1 且 steps=0`。证据有效。

## 7. Step 6：移除探针与清理

（完成于本文件提交前，命令与结果如下。）

```bash
corepack yarn workspace dsh-plugin-huaanwork typecheck
TMP_ROOT="$(cat /tmp/huaanwork-per-step-tmp-root)"
kill "$(cat "$TMP_ROOT/electron.pid")" 2>/dev/null || true
rm -rf "$TMP_ROOT" /tmp/huaanwork-per-step-tmp-root
```

| 项 | 结果 |
|---|---|
| `typecheck` 退出码 | **0**（无输出） |
| 探针残留 | `git diff -- dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts` 为空；`grep -c 'huaanwork-round-probe' bridge.ts` = **0**（grep 退出码 1），即该文件与 `125a25252a` 逐字节相同 |
| Electron PID 92708 | 已 kill；`pgrep -fl ".../dsh-plugin-huaanwork/node_modules/electron"` 无匹配 |
| 临时根 `/tmp/huaanwork-per-step-tmp-root` 与实例目录 | 已 `rm -rf`；路径均不存在 |
