# 轮次级工具看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把会话内普通工具看板从「每个用户回合一个」改为「每个 harness step 一个」，并让实时思考面板同批逐轮拆块，使实时与历史恢复在普通工具范围内形态一致；有效 `todo_write` 仍走待办卡。

**Architecture:** 新增可选字段 `roundKey`（= governing `step/start` 事件的日志 `seq`）贯穿宿主事件、历史记录契约与客户端条目；`projectToolPanels` 在既有用户回合分段内部再按 `roundKey` 切子段，每子段最多一个看板；首个 key 之前或整段无 key 时按思考 / 可见正文位置推断降级，分组探测不受 `turnFinal` 影响。终态结算与回合条保持用户回合粒度不变。

**Tech Stack:** TypeScript（strict）、React、Cordis 插件（宿主侧）、vitest、tsdown、Yarn 4.18.0 workspaces、Electron。

**Spec:** `docs/superpowers/specs/2026-11-09-per-step-tool-board-design.md`

**Review:** `docs/superpowers/plans/2026-11-09-per-step-tool-board-plan-review.md`

## Global Constraints

- Node.js `^22.19.0` 或 `>=24.0.0`；根 Yarn `4.18.0` 经 Corepack。
- `deepseek-harness/` 是 pinned 子模组，**禁止修改其中任何文件**。
- 桌面源码只在 `dsh-plugin-huaanwork/`；不存在 beta-first 镜像，无变体对齐门禁。
- 新增契约字段一律可选且**条件展开**：`...(roundKey === undefined ? {} : { roundKey })`，使旧 fixture 形状不变。
- 不引入模块级共享状态；bridge 的轮次 Map 由 `apply(ctx)` 创建、随 fiber 释放；`step/start` 分支并入既有 `session/event` 监听器，另听独立 `session/disposed` 清理。
- 有效 `todo_write` 继续走专用待办卡，不计入普通工具看板；不得在本里程碑暗改历史侧 `todo_write` 映射。
- 展示组件 `ToolPanel.tsx`、六态语义、`STATUS_PRIORITY`、标题文案 `工具 · ${PANEL_TEXT[status]} · ${tools.length} 项调用` 一律不改。
- 默认不写注释；只在 WHY 非显然处写一行。
- 图形应用启动必须显式；构建、typecheck、单测、Loader smoke 保持 headless-safe。
- 真机验收用临时隔离实例（`DSH_HOME` + `--user-data-dir` + `--remote-debugging-port=9333` + `HUAANWORK_ACCEPTANCE_HOOKS=1`），不在共用生产数据的 dev 实例上做；临时目录用 `mktemp -d` 且 `chmod 700`。
- 读会话日志必须用 `zstd` CLI 多帧解压（`/opt/anaconda3/bin/zstd -dc`）；Node `zlib.zstdDecompressSync` 只解首帧。
- 单文件测试命令：`corepack yarn workspace dsh-plugin-huaanwork test <相对 tests/ 的路径>`。
- 每个 Task 结束提交一次；提交信息用 `feat:` / `fix:` / `test:` / `docs:` / `chore:` 前缀。
- 源码行号是编写时快照：同一文件被前序 Task 修改后，后续 Task 先按符号名定位再改，行号只作辅助；文档引用漂移时以 Task/符号为准，禁止按过期行号盲改。

## File Structure

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts` | 宿主↔客户端线上契约唯一定义 | 改：`SessionDetailRecord` 三变体 + `RpcEvent` 三事件加 `roundKey?` |
| `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts` | 日志 → 可读记录投影 | 改：`detailRecords` 折叠 `step/start` 并盖键 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts` | 记录 → 对话条目映射 | 改：`HistoryChatItem` thinking/assistant/tool + 三处透传 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts` | 看板纯逻辑（切段 / 投影 / 结算） | 改：类型加键、新增 `roundKeyOf` / `splitRounds`、重写 `projectToolPanels` 内层 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts` | 思考纯逻辑 | 改：`TurnItem` thinking/assistant 加键、`hasAssistantTextAfter` 按轮次终止 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts` | 宿主事件桥 | 改：轮次 Map + 并入既有 `session/event` + 独立 disposed 清理 + 三处盖键 |
| `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx` | 会话时间线与事件接线 | 改：`ToolCard` / `ChatItem` 加键、`handleEvent` 透传、`appendToken` / `applyReasoning` 逐轮、`historyToChatItems` 透传、`thinkingBefore` 按轮次 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts` | 投影纯逻辑测试 | 改：新增轮次、final 降级、混合键用例 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/thinkingPanel.spec.ts` | 思考纯逻辑测试 | 改：新增轮次终止用例 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts` | App 接线契约测试 | 改：新增逐轮接线、`handleEvent`、`thinkingBefore` 用例 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts` | 宿主记录投影测试 | 改：新增盖键用例 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts` | 历史映射测试 | 改：新增 thinking/assistant/tool 透传用例 |
| `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts` | 宿主事件桥测试 | 改：新增 step 更新、跨会话隔离、dispose 用例 |

---

### Task 0: 纳入版控并验证 bridge 可观测 `step/start`（go / no-go）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:104-110`（`apply` 开头）与 `:163-203`（既有 `session/event` 监听器）
- Create: `docs/evidence/2026-11-09-per-step-tool-board-task0.md`

**Interfaces:**
- Consumes: 上游 `session/event` 派发（`deepseek-harness/packages/core/session/src/index.ts:884-889`），载荷 `step/start` 为 `{turn, step}`，外层带 `seq`。
- Produces: 证据文档记录「bridge 既有监听器是否收到 step/start」；Task 5 依赖该结论选择主路线或备选路线。

- [ ] **Step 0: 先把治理文档纳入版控**

```bash
git add docs/superpowers/specs/2026-11-09-per-step-tool-board-design.md \
        docs/superpowers/plans/2026-11-09-per-step-tool-board.md \
        docs/superpowers/plans/2026-11-09-per-step-tool-board-plan-review.md
git commit -m "docs: add per-step tool board design, plan and review"
```

- [ ] **Step 1: 写入阳性对照与探针**

在 `bridge.ts` 的 `export function apply(ctx: Context): void {` 之后插入：

```ts
  ctx.logger?.info?.("huaanwork-round-probe: ready");
```

在既有 `session/event` 监听器内、`const scope = ...` 之后插入：

```ts
    if (event?.type === "step/start") {
      const seq = (event as { seq?: number } | undefined)?.seq;
      ctx.logger?.info?.(`huaanwork-round-probe: session=${String(sessionId)} stepSeq=${String(seq)}`);
      return;
    }
```

- [ ] **Step 2: 构建并准备隔离实例**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native
```
Expected: 两条命令 exit 0。

Run:
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
Expected: 打印 `logLevel=info`，临时根目录权限为 700。

启动：
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

- [ ] **Step 3: 触发一次真实工具运行**

在隔离实例里新建对话，发送：

```text
请使用 bash 依次执行 pwd、ls、uname -a，并汇总输出。
```

等运行结束。若未产生任何 `step/start`，换一条明确要求执行命令的消息重试一次；仍无则记 BLOCKED（模型未触发工具），不得据此判监听不可达。

- [ ] **Step 4: 取证据并按阳性对照分流**

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

Expected（主路线成立）：`ready>=1`、`session-steps>=1`、`steps>=1`，且 `stepSeq` 随运行递增、`session` 为该会话 id。

分流：

- `ready=0`：日志阈值/链路未生效。先修 `logLevel=info` 或探针落盘方式，不得判 no-go。
- `ready>=1` 且 `session-steps>=1` 且 `steps=0`：既有监听器未观测到 `step/start`，主路线不成立。
- `session-steps=0`：模型未进入任何 step，本次证据无效，重跑或标 BLOCKED。

- [ ] **Step 5: 写证据文档并分叉决策**

创建 `docs/evidence/2026-11-09-per-step-tool-board-task0.md`，记录：命令原文、退出码、`ready`/`steps`/`session-steps` 计数、前 5 行、会话 id、结论（主路线成立 / 不成立 / 证据无效）。

主路线不成立时改用备选路线并回报 owner——`ctx.sessionProjections.stateOf(session, "turnBoundary")?.lastStepStartSeq`。引用口径（四轮复核订正）：`stateOf(session, 'turnBoundary')` 的读法先例是 `deepseek-harness/packages/core/agent-loop/src/agent.ts:134`，但该行读的是 `lastTurn`，不是本字段；`lastStepStartSeq` 定义在 `packages/core/agent/src/types.ts:82`，由 `packages/core/agent-loop/src/index.ts:83` 在 `step/start` 时写为 `event.seq`，字段读先例是 `packages/experimental/tool-session-query/src/operations.ts:129`。其类型 `OptionalSessionSeq = SessionSeq | null`（`packages/core/session/src/types.ts:66`，首个 step 前为 `null`），落地时须把 `null` 归一为 `undefined` 再进 `RoundKeys`；`SessionSeq` 是 `BrandedNumber`，可直接赋给 `number`。该路线需 `Session` 对象，`tool/start` 侧由 `execution.agent.session` 取得，`token` / `reasoning` 侧需从 `llm/stream` options 补透传。当前 pinned 运行时备选路线也失败则标 BLOCKED，不继续 Task 5；旧宿主/旧 fixture 缺 key 才允许走推断降级。

- [ ] **Step 6: 移除探针并提交证据**

删除 Step 1 插入的阳性对照与 `step/start` 分支（Task 5 会写入正式版本）。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork typecheck
TMP_ROOT="$(cat /tmp/huaanwork-per-step-tmp-root)"
kill "$(cat "$TMP_ROOT/electron.pid")" 2>/dev/null || true
rm -rf "$TMP_ROOT" /tmp/huaanwork-per-step-tmp-root
```
Expected: typecheck exit 0；临时实例退出且临时目录清理。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts \
        docs/evidence/2026-11-09-per-step-tool-board-task0.md
git commit -m "docs: record step boundary observability probe for per-step tool boards"
```

---

### Task 1: 契约与类型加 `roundKey`

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:340-354`、`:429-444`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:91-108`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts:7-38`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts:126-134`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:242-263`、`:286-288`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:23-43`
- Verify: `corepack yarn workspace dsh-plugin-huaanwork typecheck`

**Interfaces:**
- Consumes: 无（纯类型任务）。
- Produces: 所有后续任务使用的 `roundKey?: number` 字段；`ToolPanelCard.roundKey`、`ToolPanelItem.roundKey`、`HistoryChatItem` thinking/assistant/tool 的 `roundKey`、`ChatItem` thinking/assistant 的 `roundKey`、`ToolCard.roundKey`、`RpcEvent` token/reasoning/tool-start 的 `roundKey`、`SessionDetailRecord` thinking/assistant/tool-call 的 `roundKey`、`TurnItem` thinking/assistant 的 `roundKey`。

- [ ] **Step 1: 加类型字段**

`logic/toolPanel.ts`：`ToolPanelCard`（`:7`）在 `resultMissing?: boolean;` 后加一行 `roundKey?: number;`；`ToolPanelItem` 非工具变体（`:25-38`）在 `sourceText?: string;` 后加一行 `roundKey?: number;`。

`logic/thinkingPanel.ts`：`TurnItem`（`:126-134`）的 thinking 变体改为 `| { kind: "thinking"; thought: string; roundKey?: number }`，assistant 变体改为 `| { kind: "assistant"; text: string; roundKey?: number }`。

`logic/sessionChannel.ts`：`HistoryChatItem` 的 thinking（`:93`）、assistant（`:94`）、tool（`:95-107`）三个变体各加 `roundKey?: number`。

`rpc-types.ts`：`SessionDetailRecord` 的 thinking（`:342`）、assistant（`:343`）、tool-call（`:344`）三个变体各加 `roundKey?: number`；`RpcEvent` 的 `token`（`:430`）、`reasoning`（`:431`）各加 `roundKey?: number`，`tool/start`（`:433-443`）在 `sessionId?: string;` 后加 `roundKey?: number;`。

`App.tsx`：`ToolCard`（`:242-263`）在 `resultMissing?: boolean;` 后加 `roundKey?: number;`；`ChatItem` 的 assistant（`:286`）与 thinking（`:287`）变体各加 `roundKey?: number`。

`bridge.ts`：本地 `RpcEvent`（`:23-43`）的 `token`（`:24`）、`reasoning`（`:25`）各加 `roundKey?: number`，`tool/start`（`:26-35`）在 `sessionId?: string;`（`:30`）后加 `roundKey?: number;`。

- [ ] **Step 2: 类型检查**

Run: `corepack yarn workspace dsh-plugin-huaanwork typecheck`
Expected: exit 0（五个 tsconfig 全过）。

说明：本任务是纯类型契约，不伪造运行时红灯。类型缺失由 typecheck 证明，行为红灯由 Task 2–7 的测试承担。

- [ ] **Step 3: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts \
        dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts \
        dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts \
        dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts \
        dsh-plugin-huaanwork/src/client-huaanwork/App.tsx \
        dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts
git commit -m "feat: carry step roundKey through tool board contracts"
```

---

### Task 2: 历史记录盖 `roundKey`

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:184-303`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts`

**Interfaces:**
- Consumes: `SessionDetailRecord` 的 `roundKey?: number`（Task 1）。
- Produces: `detailRecords(text)` 返回的 thinking / assistant / tool-call 记录在该 step 的 `step/start` 存在时带 `roundKey = event.seq`；`tool-result` 不带键。

- [ ] **Step 1: 写失败测试**

该文件已导入 `expect` / `test`（vitest）、`detailRecords`，并已有 `sessionLog(entries)`、`HEADER`、`T0` 三个 helper（`tests/huaanwork-host/session-view.spec.ts:12-29`，`HEADER` 到 `:29` 才闭合）。直接复用，不要引入 `assert`，也不要自己拼 JSON 字符串。在文件末尾追加：

```ts
test('detailRecords stamps roundKey from the governing step/start seq', () => {
  const log = sessionLog([
    HEADER,
    { type: 'turn/start', seq: 1, time: T0 + 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: T0 + 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 3, time: T0 + 3, data: { content: [{ type: 'text', text: '问题' }] } },
    {
      type: 'assistant/message', seq: 4, time: T0 + 4,
      data: { message: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '答' }] }, stream: [] },
    },
    { type: 'tool/call', seq: 5, time: T0 + 5, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'step/start', seq: 6, time: T0 + 6, data: { turn: 1, step: 2 } },
    { type: 'tool/call', seq: 7, time: T0 + 7, data: { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{}' } },
  ])
  const records = detailRecords(log)
  expect(records.find((r) => r.kind === 'thinking')).toMatchObject({ kind: 'thinking', roundKey: 2 })
  expect(records.find((r) => r.kind === 'assistant')).toMatchObject({ kind: 'assistant', roundKey: 2 })
  const calls = records.filter((r) => r.kind === 'tool-call')
  expect(calls[0]).toMatchObject({ kind: 'tool-call', roundKey: 2 })
  expect(calls[1]).toMatchObject({ kind: 'tool-call', roundKey: 6 })
})

test('detailRecords omits roundKey when the log has no step/start', () => {
  const log = sessionLog([
    HEADER,
    { type: 'tool/call', seq: 1, time: T0 + 1, data: { callId: 'c1', name: 'read', arguments: '{}' } },
  ])
  const call = detailRecords(log).find((r) => r.kind === 'tool-call')
  expect(call).toBeDefined()
  expect(Object.hasOwn(call as object, 'roundKey')).toBe(false)
})
```

第二个用例保护既有 `toEqual` 形状钉：不含 `step/start` 的旧 fixture 必须完全不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/session-view.spec.ts`
Expected: FAIL — 第一个用例 `roundKey` 为 undefined；第二个用例可能已通过。

- [ ] **Step 3: 实现盖键**

在 `session-view.ts:189` 的 `const turnEndReasons = new Map<number, string>()` 之后加：

```ts
  let roundKey: number | undefined
```

在 `:198` 开始的 `for (const event of events)` 循环内、`switch (event.type)` 中新增一个 case（放在 `case 'assistant/message'` 之前）：

```ts
      case 'step/start': {
        roundKey = typeof event.seq === 'number' ? event.seq : undefined
        break
      }
```

把 `:231` 改为：
```ts
        if (thought) records.push({ kind: 'thinking', time, text: thought, ...(roundKey === undefined ? {} : { roundKey }) })
```
把 `:232` 改为：
```ts
        if (messageText) records.push({ kind: 'assistant', time, text: messageText, ...(roundKey === undefined ? {} : { roundKey }) })
```
在 `:240-247` 的 `records.push({ kind: 'tool-call', ... })` 对象里，`time,` 之后加一行（`          time,` 字面量在 `:242` 与 `:279`（tool-result）各出现一次，必须带 `kind: 'tool-call'` 上下文定位，不可裸替换）：
```ts
          ...(roundKey === undefined ? {} : { roundKey }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/session-view.spec.ts`
Expected: PASS，既有 `toEqual` 形状钉不回归（旧 fixture 无 `step/start`，字段不出现）。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts \
        dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts
git commit -m "feat: stamp step roundKey on restored session records"
```

---

### Task 3: 历史映射透传 `roundKey`

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts`（`historyItemsFromRecords` 的 thinking/assistant/tool-call 分支，按符号定位；Task 1 类型改动会推移行号）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`historyToChatItems` 及其 tool/thinking/assistant 三个分支，按符号定位）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`

**Interfaces:**
- Consumes: `SessionDetailRecord.roundKey`（Task 2）、`HistoryChatItem.roundKey`（Task 1）。
- Produces: `historyItemsFromRecords` 输出的 thinking / tool 条目带 `roundKey`；`historyToChatItems` 输出的 `ChatItem` thinking / assistant / tool card 带 `roundKey`。Task 4 的投影据此切轮。

- [ ] **Step 1: 写失败测试**

在 `tests/client-huaanwork/sessionChannel.spec.ts` 末尾追加：

```ts
test("historyItemsFromRecords passes roundKey through thinking, assistant and tool items", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "问题" },
    { kind: "thinking", time: 2, text: "想", roundKey: 6 },
    { kind: "assistant", time: 3, text: "答", roundKey: 6 },
    { kind: "tool-call", time: 4, name: "read", callId: "c1", roundKey: 6 },
    { kind: "tool-result", time: 5, callId: "c1", isError: false, text: "ok" },
    { kind: "tool-call", time: 6, name: "bash", callId: "c2", roundKey: 9 },
    { kind: "tool-result", time: 7, callId: "c2", isError: false, text: "ok" },
  ]);
  const thinking = items.find((i) => i.kind === "thinking");
  const assistant = items.find((i) => i.kind === "assistant");
  const tools = items.filter((i) => i.kind === "tool");
  assert.equal(thinking?.kind === "thinking" ? thinking.roundKey : undefined, 6);
  assert.equal(assistant?.kind === "assistant" ? assistant.roundKey : undefined, 6);
  assert.equal(tools[0]?.kind === "tool" ? tools[0].roundKey : undefined, 6);
  assert.equal(tools[1]?.kind === "tool" ? tools[1].roundKey : undefined, 9);
});
```

所需 `historyItemsFromRecords` 与 `assert` 已在该文件既有 import 列表中，无需改动 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/sessionChannel.spec.ts`
Expected: FAIL — `roundKey` 为 undefined。

- [ ] **Step 3: 实现透传**

`sessionChannel.ts` 的 thinking 分支 push 改为：
```ts
      items.push({ kind: "thinking", text: record.text, ...(record.roundKey === undefined ? {} : { roundKey: record.roundKey }) });
```
`sessionChannel.ts` 的 assistant 分支 push 改为：
```ts
      items.push({ kind: "assistant", text: record.text, ...(record.roundKey === undefined ? {} : { roundKey: record.roundKey }) });
```
在 `sessionChannel.ts` 的 tool-call push 对象里，`name: record.name || "tool",` 之后加一行：
```ts
        ...(record.roundKey === undefined ? {} : { roundKey: record.roundKey }),
```
在 `historyToChatItems` 的 tool card 对象里，`name: item.name,` 之后加一行：
```ts
            ...(item.roundKey === undefined ? {} : { roundKey: item.roundKey }),
```
在 `historyToChatItems` 的 thinking 分支返回对象里加入 `roundKey` 条件展开：
```ts
        return { id: allocId(), kind: "thinking", thought: item.text, interrupted: false, historical: true, ...(item.roundKey === undefined ? {} : { roundKey: item.roundKey }) };
```
在 `historyToChatItems` 的 assistant 分支返回对象里加入 `roundKey` 条件展开：
```ts
      if (item.kind === "assistant") return { id: allocId(), kind: "assistant", text: item.text, ...(item.roundKey === undefined ? {} : { roundKey: item.roundKey }) };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/sessionChannel.spec.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `corepack yarn workspace dsh-plugin-huaanwork typecheck`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts \
        dsh-plugin-huaanwork/src/client-huaanwork/App.tsx \
        dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts
git commit -m "feat: pass step roundKey through history item mapping"
```

---

### Task 4: 投影按轮次切段（核心）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`（`projectToolPanels` 及其内层投影循环，按符号定位；Task 1 类型改动会推移行号）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts`

**Interfaces:**
- Consumes: `ToolPanelItem.roundKey` / `ToolPanelCard.roundKey`（Task 1）、历史透传（Task 3）。
- Produces: `export function roundKeyOf(item: ToolPanelItem): number | undefined`；`projectToolPanels` 每轮次子段最多一个面板行，锚点为该子段首个 tool 条目 id。签名与返回类型 `ToolPanelRow<T>[]` 不变，`App.tsx` 中 `toolRows` 的 `projectToolPanels` 调用点无需改动。

- [ ] **Step 1: 写失败测试**

在 `tests/client-huaanwork/toolPanel.spec.ts` 末尾追加。顶部 import 列表加入 `roundKeyOf` 与 `ToolPanelContentItem`。

```ts
function keyedTool(id: number, name: string, roundKey: number): ToolPanelItem {
  return { id, kind: "tool", card: { key: `key-${id}`, name, status: "start", roundKey } };
}

test("roundKeyOf reads the card on tool items and the item elsewhere", () => {
  assert.equal(roundKeyOf(keyedTool(1, "read", 6)), 6);
  assert.equal(roundKeyOf({ id: 2, kind: "thinking", roundKey: 9 }), 9);
  assert.equal(roundKeyOf({ id: 3, kind: "tool", card: { key: "k", name: "read", status: "start" } }), undefined);
  assert.equal(roundKeyOf({ id: 4, kind: "user" }), undefined);
});

test("projection creates one panel per step inside a single user turn", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    { id: 2, kind: "thinking", roundKey: 10 },
    keyedTool(3, "grep", 10),
    { id: 4, kind: "thinking", roundKey: 20 },
    keyedTool(5, "bash", 20),
    keyedTool(6, "web_fetch", 20),
    { id: 7, kind: "thinking", roundKey: 30 },
    keyedTool(8, "read", 30),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.map((row) => row.kind === "panel" ? `panel:${row.id}` : `${row.item.kind}:${row.item.id}`), [
    "user:1", "thinking:2", "panel:3", "thinking:4", "panel:5", "thinking:7", "panel:8",
  ]);
  assert.equal(panelAt(rows, 2).tools.length, 1);
  assert.equal(panelAt(rows, 4).tools.length, 2);
  assert.equal(panelAt(rows, 6).tools.length, 1);
});

test("a step without tools produces no panel and does not merge its neighbours", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    keyedTool(2, "read", 10),
    { id: 3, kind: "thinking", roundKey: 20 },
    { id: 4, kind: "assistant", text: "只有正文", roundKey: 20 },
    keyedTool(5, "bash", 30),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.map((row) => row.kind === "panel" ? `panel:${row.id}` : `${row.item.kind}:${row.item.id}`), [
    "user:1", "panel:2", "thinking:3", "assistant:4", "panel:5",
  ]);
});

test("roundKey never crosses a user turn boundary", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "A" },
    keyedTool(2, "read", 10),
    { id: 3, kind: "user", text: "B" },
    keyedTool(4, "read", 10),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.filter((row) => row.kind === "panel").map((row) => row.id), [2, 4]);
});

test("only the last round of an active turn defaults expanded", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    keyedTool(2, "read", 10),
    keyedTool(3, "bash", 20),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.equal(panelAt(rows, 1).expanded, false, "the superseded round collapses");
  assert.equal(panelAt(rows, 2).expanded, true, "the running round stays open");
  const final = projectToolPanels(items, {
    contentItems: content(items), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(final, 1).expanded, false);
  assert.equal(panelAt(final, 2).expanded, false);
});

test("visible body collapses only its own round", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    keyedTool(2, "read", 10),
    { id: 3, kind: "assistant", text: "第一轮正文", roundKey: 10 },
    keyedTool(4, "bash", 20),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.equal(panelAt(rows, 1).expanded, false);
  assert.equal(panelAt(rows, 3).expanded, true);
});

test("manual toggle stays on its own round anchor", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    keyedTool(2, "read", 10),
    keyedTool(3, "bash", 20),
  ];
  const toggled = withToolPanelToggle(items, 2, "expand");
  const rows = projectToolPanels(toggled, {
    contentItems: content(toggled), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(rows, 1).expanded, true, "manual expand beats the final collapse");
  assert.equal(panelAt(rows, 2).expanded, false);
});

test("missing roundKey falls back to thinking and visible body boundaries", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    { id: 2, kind: "thinking" },
    tool(3, "read"),
    tool(4, "bash"),
    { id: 5, kind: "thinking" },
    tool(6, "web_fetch"),
    { id: 7, kind: "assistant", text: "正文" },
    tool(8, "read"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.filter((row) => row.kind === "panel").map((row) => row.id), [3, 6, 8]);
  assert.equal(panelAt(rows, 2).tools.length, 2, "tools before any boundary stay in one board");
});

test("a round with neither thinking nor visible body merges into the previous one under fallback", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    { id: 2, kind: "thinking" },
    tool(3, "grep"),
    tool(4, "bash"),
    tool(5, "web_fetch"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.filter((row) => row.kind === "panel").map((row) => row.id), [3]);
  assert.equal(panelAt(rows, 2).tools.length, 3);
});

test("final turns still split rounds by visible body when no roundKey exists", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    tool(2, "read"),
    { id: 3, kind: "assistant", text: "第一轮正文" },
    tool(4, "bash"),
  ];
  const rows = projectToolPanels(items, {
    contentItems: content(items), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.deepEqual(rows.filter((row) => row.kind === "panel").map((row) => row.id), [2, 4]);
  assert.equal(panelAt(rows, 1).expanded, false);
  assert.equal(panelAt(rows, 3).expanded, false);
});

test("mixed keys infer the unkeyed prefix and keep explicit keyed rounds exact", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    { id: 2, kind: "thinking" },
    tool(3, "read"),
    { id: 4, kind: "assistant", text: "旧轮正文" },
    tool(5, "bash"),
    { id: 6, kind: "thinking", roundKey: 30 },
    keyedTool(7, "web_fetch", 30),
    tool(10, "grep"),
    { id: 8, kind: "thinking", roundKey: 40 },
    keyedTool(9, "read", 40),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.filter((row) => row.kind === "panel").map((row) => row.id), [3, 5, 7, 9]);
  assert.equal(panelAt(rows, 6).tools.length, 2, "an unkeyed gap after a keyed item stays in that round");
});

test("attachment is visible body but never starts a fallback round", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "问题" },
    tool(2, "read"),
    { id: 3, kind: "attachment", sourceText: "结果附件" },
    tool(4, "bash"),
  ];
  const contentItems: ToolPanelContentItem[] = [
    { id: 1, kind: "user" },
    { id: 2, kind: "tool" },
    { id: 3, kind: "assistant", text: "结果附件" },
    { id: 4, kind: "tool" },
  ];
  const rows = projectToolPanels(items, { contentItems, connectionLost: false });
  assert.deepEqual(rows.filter((row) => row.kind === "panel").map((row) => row.id), [2], "attachment does not split the round");
  assert.equal(panelAt(rows, 1).tools.length, 2);
  assert.equal(panelAt(rows, 1).expanded, false, "attachment still counts as visible body");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/toolPanel.spec.ts`
Expected: FAIL — `roundKeyOf` 未导出；逐轮用例的面板数仍为 1。

- [ ] **Step 3: 实现 `roundKeyOf` 与 `splitRounds`**

在 `logic/toolPanel.ts` 的 `toolPanelCard` 函数之后插入：

```ts
/** 轮次身份 = governing step/start 的日志 seq；tool 条目记在卡上，其余记在条目上。 */
export function roundKeyOf(item: ToolPanelItem): number | undefined {
  if (item.kind === "tool") return toolPanelCard(item)?.roundKey;
  return item.roundKey;
}

type RoundSpan = { start: number; end: number };

/**
 * 用户回合内再按模型轮次切子段。显式 key 是权威边界；已有 key 后的无 key 条目
 * 跟随当前轮；首个显式 key 之前的无 key 前缀按思考 / 可见正文位置推断。
 */
function splitRounds<T extends ToolPanelItem>(
  items: readonly T[],
  start: number,
  end: number,
  visibleAssistantIds: ReadonlySet<number>,
): RoundSpan[] {
  const spans: RoundSpan[] = [];
  let spanStart = start;
  let currentKey: number | undefined;
  let seenTool = false;
  const closeBefore = (index: number): void => {
    if (index > spanStart) {
      spans.push({ start: spanStart, end: index });
      spanStart = index;
    }
  };
  for (let index = start; index < end; index += 1) {
    const item = items[index];
    if (!item) continue;
    const key = roundKeyOf(item);
    if (key !== undefined) {
      if (key !== currentKey) closeBefore(index);
      currentKey = key;
      seenTool = false;
      continue;
    }
    if (currentKey !== undefined) continue;
    if (item.kind === "tool") { seenTool = true; continue; }
    if (seenTool && (item.kind === "thinking" || (item.kind === "assistant" && visibleAssistantIds.has(item.id)))) {
      closeBefore(index);
      seenTool = false;
    }
  }
  spans.push({ start: spanStart, end });
  return spans;
}
```

- [ ] **Step 4: 重写 `projectToolPanels` 的内层循环**

把 `projectToolPanels` 内层从 `const rows: ToolPanelRow<T>[] = [];` 到分段循环结束（`return rows;` 之前）的整段替换为：

```ts
  const rows: ToolPanelRow<T>[] = [];
  for (const segment of segments) {
    const ids = new Set<number>();
    for (let index = segment.start; index < segment.end; index += 1) {
      const item = items[index];
      if (item) ids.add(item.id);
    }
    const visibleAssistantIds = new Set<number>(options.contentItems.flatMap((item) =>
      ids.has(item.id)
      && item.kind === "assistant"
      && resolveThinking({ reasoning: "", assistantText: item.text ?? "" }).visible.trim().length > 0
        ? [item.id]
        : [],
    ));
    const rounds = splitRounds(items, segment.start, segment.end, visibleAssistantIds);
    for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
      const round = rounds[roundIndex];
      if (!round) continue;
      const toolIndexes: number[] = [];
      let roundHasVisibleAssistant = false;
      for (let index = round.start; index < round.end; index += 1) {
        const item = items[index];
        if (!item) continue;
        if (item.kind === "tool") toolIndexes.push(index);
        if (visibleAssistantIds.has(item.id)) roundHasVisibleAssistant = true;
      }
      const anchorIndex = toolIndexes[0];
      const isLastRound = roundIndex === rounds.length - 1;
      for (let index = round.start; index < round.end; index += 1) {
        const item = items[index];
        if (!item) continue;
        if (index === anchorIndex) {
          const anchor = item;
          const tools = toolIndexes.flatMap((toolIndex) => {
            const source = items[toolIndex];
            const card = source ? toolPanelCard(source) : undefined;
            return source && card ? [toolEntryView(source.id, card, options.connectionLost)] : [];
          });
          const statuses = tools.map((tool) => tool.status);
          const status = STATUS_PRIORITY.find((candidate) => statuses.includes(candidate)) ?? "done";
          const panelToggled = anchor.panelToggled ?? null;
          rows.push({
            kind: "panel",
            id: anchor.id,
            panel: {
              anchorId: anchor.id,
              count: tools.length,
              status,
              title: `工具 · ${PANEL_TEXT[status]} · ${tools.length} 项调用`,
              expanded: panelToggled === "expand"
                ? true
                : panelToggled === "collapse"
                  ? false
                  : !segment.final && isLastRound && !roundHasVisibleAssistant,
              panelToggled,
              tools,
            },
          });
          continue;
        }
        if (item.kind === "tool") continue;
        rows.push({ kind: "item", index, item: item as Exclude<T, { kind: "tool" }> });
      }
    }
  }
  return rows;
```

用户回合段切分逻辑保持不变。

- [ ] **Step 5: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/toolPanel.spec.ts`
Expected: PASS，新增 12 个用例全过，既有 21 个用例不回归（它们的 fixture 无 `roundKey` 且工具之间无思考/可见正文，推断切段结果与原行为一致）。

若既有用例变红：逐个核对是否真的与新裁定冲突。冲突则按 R-1 改写断言并在提交信息里说明；不冲突则修实现，不许改断言迁就实现。

- [ ] **Step 6: 跑组件与接线测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/ToolPanelComponent.spec.ts
corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/appWiring.spec.ts
```
Expected: PASS。`ToolPanelComponent.spec.ts:20-34` 的 `panelFor` 取 `rows[1]`，其 fixture 无轮次键，行序不变。`appWiring.spec.ts:665-676` 的源码 regex 钉检查投影 options 与 `withToolPanelToggle`，两者签名未变。

- [ ] **Step 7: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts \
        dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts
git commit -m "feat: project tool boards per model step with inference fallback"
```

---

### Task 5: 实时事件盖 `roundKey`

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`（`apply`、`mapTokens`、`tool/start` 分支与既有 `session/event` 监听器，按符号定位）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts`

**Interfaces:**
- Consumes: Task 0 的 go 结论；`RpcEvent.roundKey`（Task 1）。
- Produces: 父会话的 `token` / `reasoning` / `tool/start` 事件在当前 step 已知时带 `roundKey`；子代理分支与非回合流（compaction / session-title）不盖键。

- [ ] **Step 1: 写失败测试**

该文件已有 `createCtx()`（`tests/huaanwork-guardrails/bridge.spec.ts:74-90`，返回 `{ ctx, listeners, emitted }`）、`Execute` 类型（`:30`）、`StreamChunk` 类型（`:17`）、`PARENT_SESSION`（`:42`）/ `CHILD_SESSION`（`:43`）/ `parentAgent`（`:45`）常量。全部复用，不要自造 ctx。在文件末尾追加：

```ts
test("bridge stamps roundKey from observed step/start onto parent session events", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);

  const sessionEvent = listeners["session/event"]?.[0] as unknown as (
    session: { id: string },
    event: { type: string; seq: number },
  ) => void;
  assert.ok(sessionEvent, "the bridge observes session/event");
  sessionEvent({ id: PARENT_SESSION }, { type: "step/start", seq: 42 });

  const execute = listeners["tools/execute"]?.[0] as Execute;
  await execute(
    { name: "read", callId: "c1", arguments: {}, agent: parentAgent },
    async () => ({ isError: false, content: [{ type: "text", text: "ok" }] }),
  );
  const start = emitted.find((e) => (e as { event?: string }).event === "tool/start") as { roundKey?: number };
  assert.equal(start?.roundKey, 42);

  const wrap = listeners["llm/stream"]?.[0] as (
    options: unknown,
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>;
  async function* next() {
    yield { type: "reasoning-delta" as const, index: 0, text: "想" };
    yield { type: "text-delta" as const, index: 0, text: "答" };
    yield { type: "finish" as const, reason: { kind: "stop" } };
  }
  const chunks: StreamChunk[] = [];
  for await (const chunk of wrap({ sessionId: PARENT_SESSION }, next)) chunks.push(chunk);
  const reasoning = emitted.find((e) => (e as { event?: string }).event === "reasoning") as { roundKey?: number };
  const token = emitted.find((e) => (e as { event?: string }).event === "token") as { roundKey?: number };
  assert.equal(reasoning?.roundKey, 42);
  assert.equal(token?.roundKey, 42);
  assert.equal(chunks.length, 3, "stamping must not consume or alter chunks");
});

test("bridge updates roundKey per step, isolates sessions, and drops it on dispose", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const sessionEvent = listeners["session/event"]?.[0] as unknown as (
    session: { id: string },
    event: { type: string; seq: number },
  ) => void;
  const disposed = listeners["session/disposed"]?.[0] as unknown as (session: { id: string }) => void;
  const execute = listeners["tools/execute"]?.[0] as Execute;
  const stamp = async (callId: string, sessionId = PARENT_SESSION): Promise<number | undefined> => {
    await execute(
      { name: "read", callId, arguments: {}, agent: sessionId === PARENT_SESSION ? parentAgent : { session: { id: sessionId } } },
      async () => ({ isError: false, content: [{ type: "text", text: "ok" }] }),
    );
    const event = emitted.findLast((e) => (e as { event?: string }).event === "tool/start") as { roundKey?: number };
    return event.roundKey;
  };

  sessionEvent({ id: PARENT_SESSION }, { type: "step/start", seq: 42 });
  assert.equal(await stamp("c1"), 42);
  sessionEvent({ id: PARENT_SESSION }, { type: "step/start", seq: 43 });
  assert.equal(await stamp("c2"), 43);

  sessionEvent({ id: CHILD_SESSION }, { type: "step/start", seq: 99 });
  assert.equal(await stamp("c3", CHILD_SESSION), 99, "a second session keeps its own key");
  assert.equal(await stamp("c4"), 43, "the first session is unaffected");

  disposed({ id: PARENT_SESSION });
  assert.equal(await stamp("c5"), undefined, "dispose drops the session key");
});

test("bridge leaves roundKey absent before any step/start and on non-turn streams", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const execute = listeners["tools/execute"]?.[0] as Execute;
  await execute(
    { name: "read", callId: "c1", arguments: {}, agent: parentAgent },
    async () => ({ isError: false, content: [{ type: "text", text: "ok" }] }),
  );
  const start = emitted.find((e) => (e as { event?: string }).event === "tool/start") as { roundKey?: number };
  assert.equal(start?.roundKey, undefined);
  assert.equal(Object.hasOwn(start as object, "roundKey"), false);

  const wrap = listeners["llm/stream"]?.[0] as (
    options: unknown,
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>;
  async function* next() {
    yield { type: "text-delta" as const, index: 0, text: "标题" };
    yield { type: "finish" as const, reason: { kind: "stop" } };
  }
  for await (const chunk of wrap({ sessionId: PARENT_SESSION, purpose: "session-title" }, next)) void chunk;
  assert.equal(emitted.filter((e) => (e as { event?: string }).event === "token").length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-guardrails/bridge.spec.ts`
Expected: FAIL — 事件尚未盖 `roundKey`，`session/disposed` 清理监听器尚未注册；既有 `session/event` 监听器本身仍存在，失败原因不是“未注册监听器”。

- [ ] **Step 3: 实现轮次 Map、并入既有监听器与 disposed 清理**

在 `Context` 类型之前插入：

```ts
/** 插件实例拥有的轮次表：sessionId → 最近一条 step/start 的日志 seq。 */
type RoundKeys = Map<string, number>;
```

在 `apply(ctx)` 函数体开头（`ctx.on("llm/stream", ...)` 之前）插入：

```ts
  const roundKeys: RoundKeys = new Map();
  ctx.on("session/disposed", ((session: { id?: string }) => {
    const id = session?.id;
    if (typeof id === "string" && id) roundKeys.delete(id);
  }) as never, { global: true });
```

在既有 `session/event` 监听器内、`const scope = ...` 之后插入：

```ts
    if (event?.type === "step/start") {
      const seq = (event as { seq?: number } | undefined)?.seq;
      if (sessionId !== undefined && typeof seq === "number") roundKeys.set(sessionId, seq);
      return;
    }
```

不新增第二个 `session/event` 监听器；既有监听器仍是 `listeners["session/event"][0]`。

在 `sessionIdOfOptions` 函数之后插入：

```ts
/** 当前轮次身份；会话尚未进入 step 或监听不可达时不盖键，客户端走推断降级。 */
function roundKeyFor(roundKeys: RoundKeys, sessionId: string | undefined): number | undefined {
  return sessionId === undefined ? undefined : roundKeys.get(sessionId);
}
```

- [ ] **Step 4: 三处盖键**

`tool/start` 的父会话分支（`child === undefined`）：在 `const tool = {...}` 之前取键，并加进 emit 对象。把该块改为：

```ts
      if (child === undefined) {
        const roundKey = roundKeyFor(roundKeys, sessionId);
        emit(ctx, {
          event: "tool/start",
          name: execution.name,
          ...(execution.callId === undefined ? {} : { callId: execution.callId }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(roundKey === undefined ? {} : { roundKey }),
          ...startDetail(execution),
        });
      } else {
```

`mapTokens` 函数签名加第 5 参：

```ts
async function* mapTokens(
  ctx: Context,
  sessionId: string | undefined,
  purpose: string | undefined,
  stream: AsyncIterable<StreamChunk>,
  roundKeys: RoundKeys,
): AsyncIterable<StreamChunk> {
```

在 `mapTokens` 体内 `const child = ...` 之前加：
```ts
  const roundKey = roundKeyFor(roundKeys, sessionId);
  const roundField = roundKey === undefined ? {} : { roundKey };
```

把 `mapTokens` 内 `token` delta 的 emit 改为：
```ts
          emit(ctx, { event: "token", text: chunk.text, ...(sessionId === undefined ? {} : { sessionId }), ...roundField });
```
把 `mapTokens` 内 `reasoning-delta` 的 emit 改为：
```ts
          emit(ctx, { event: "reasoning", text: chunk.text, ...(sessionId === undefined ? {} : { sessionId }), ...roundField });
```
把 `mapTokens` 内 `block-end` reasoning 的 `final: true` emit 改为：
```ts
          emit(ctx, {
            event: "reasoning",
            text: chunk.block.text,
            final: true,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...roundField,
          });
```

把 `apply` 内调用 `mapTokens` 的地方改为传第 5 参：
```ts
    mapTokens(ctx, sessionIdOfOptions(options), purposeOfOptions(options), next(), roundKeys)) as never, { global: true });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-guardrails/bridge.spec.ts`
Expected: PASS，既有用例不回归。

- [ ] **Step 6: 类型检查与全量单测**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork typecheck
corepack yarn workspace dsh-plugin-huaanwork test
```
Expected: 两条 exit 0。

- [ ] **Step 7: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts \
        dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts
git commit -m "feat: stamp step roundKey on live parent session events"
```

---

### Task 6: 实时接线与思考逐轮

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`appendToken`、`applyReasoning`、`handleEvent` 的 `token`/`reasoning`/`tool/start` 分支，按符号定位）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`

**Interfaces:**
- Consumes: `RpcEvent.roundKey`（Task 5）、`ChatItem.roundKey` / `ToolCard.roundKey`（Task 1）。
- Produces: `appendToken(items, text, allocId, roundKey?)`，只合并同 key 相邻 assistant；`applyReasoning(items, text, final, allocId, roundKey?)`，同 key 合并，新块插到同轮正文前，缺省 key 保留旧插入位置语义。

- [ ] **Step 1: 写失败测试**

在 `tests/client-huaanwork/appWiring.spec.ts` 末尾追加：

```ts
test("reasoning events of different steps create separate thinking blocks in order", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const first = AppModule.applyReasoning(items, "第一轮想", false, () => 2, 10);
  const streamed = AppModule.appendToken(first, "第一轮正文", () => 3, 10);
  const tooled = AppModule.insertTurnItem(streamed, {
    id: 4, kind: "tool", card: { key: "k4", name: "read", status: "start", roundKey: 10 },
  });
  const second = AppModule.applyReasoning(tooled, "第二轮想", false, () => 5, 20);
  assert.equal(second.filter((item) => item.kind === "thinking").length, 2);
  assert.deepEqual(second.map((item) => item.kind), ["user", "thinking", "assistant", "tool", "thinking"]);
  assert.equal(second[1]?.kind === "thinking" ? second[1].roundKey : undefined, 10);
  assert.equal(second[4]?.kind === "thinking" ? second[4].roundKey : undefined, 20);
  const more = AppModule.applyReasoning(second, "第二轮续", false, () => 6, 20);
  assert.equal(more.filter((item) => item.kind === "thinking").length, 2, "same step keeps extending its own block");
  assert.equal(more[4]?.kind === "thinking" ? more[4].thought : "", "第二轮想第二轮续");
});

test("assistant text does not merge across steps", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const first = AppModule.appendToken(items, "A", () => 2, 10);
  const second = AppModule.appendToken(first, "B", () => 3, 20);
  assert.deepEqual(second.map((item) => item.kind), ["user", "assistant", "assistant"]);
  assert.equal(second[1]?.kind === "assistant" ? second[1].roundKey : undefined, 10);
  assert.equal(second[2]?.kind === "assistant" ? second[2].roundKey : undefined, 20);
  const more = AppModule.appendToken(second, "B2", () => 4, 20);
  assert.equal(more.length, 3, "the same step keeps extending its own assistant item");
  assert.equal(more[2]?.kind === "assistant" ? more[2].text : "", "BB2");
});

test("reasoning arriving after its own round's body still inserts before that body", () => {
  const items = [
    { id: 1, kind: "user" as const, text: "问题" },
    { id: 2, kind: "assistant" as const, text: "第一轮正文", roundKey: 10 },
  ];
  const next = AppModule.applyReasoning(items, "想", false, () => 3, 10);
  assert.deepEqual(next.map((item) => item.kind), ["user", "thinking", "assistant"]);
  assert.equal(next[1]?.kind === "thinking" ? next[1].roundKey : undefined, 10);
});

test("handleEvent passes roundKey from tool/start into the card", () => {
  const updates: ReturnType<typeof AppModule.insertTurnItem>[] = [];
  const setItems = (updater: (prev: Parameters<typeof AppModule.insertTurnItem>[0]) => Parameters<typeof AppModule.insertTurnItem>[0]) => {
    updates.push(updater([]));
  };
  AppModule.handleEvent(
    { event: "tool/start", name: "read", callId: "c1", roundKey: 42 } as never,
    () => 2,
    () => undefined,
    setItems,
    () => undefined,
    () => undefined,
    async () => undefined,
    { current: false },
    false,
    false,
    false,
  );
  const card = updates[0]?.[0]?.kind === "tool" ? updates[0][0].card : undefined;
  assert.equal(card?.roundKey, 42);
});

test("reasoning without roundKey keeps the single block behaviour", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const first = AppModule.applyReasoning(items, "想", false, () => 2);
  const second = AppModule.applyReasoning(first, "再想", false, () => 3);
  assert.equal(second.filter((item) => item.kind === "thinking").length, 1);
});

test("tool/start roundKey lands on the card", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const next = AppModule.insertTurnItem(items, {
    id: 2, kind: "tool", card: { key: "k2", name: "bash", status: "start", roundKey: 42 },
  });
  assert.equal(next[1]?.kind === "tool" ? next[1].card.roundKey : undefined, 42);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/appWiring.spec.ts`
Expected: FAIL — `applyReasoning` 只接受 4 参，第二次调用合并进同一块；且 `handleEvent` 此时尚未导出（Step 5 才改），`AppModule.handleEvent` 为 undefined，接线用例同批红。红灯原因不止 arity 一条。

- [ ] **Step 3: 改 `appendToken`**

把 `appendToken` 函数替换为：

```ts
export function appendToken(items: ChatItem[], text: string, allocId: () => number, roundKey?: number): ChatItem[] {
  const insertAt = turnAppendIndex(items);
  const last = insertAt > 0 ? items[insertAt - 1] : undefined;
  if (last?.kind === "assistant" && last.roundKey === roundKey) {
    return [...items.slice(0, insertAt - 1), { ...last, text: last.text + text }, ...items.slice(insertAt)];
  }
  return [...items.slice(0, insertAt), { id: allocId(), kind: "assistant", text, ...(roundKey === undefined ? {} : { roundKey }) }, ...items.slice(insertAt)];
}
```

- [ ] **Step 4: 改 `applyReasoning`**

把 `applyReasoning` 函数替换为：

```ts
/** 同一轮次只保留一块思考：非 final 追加当前步骤，final 只替换当前步骤；换轮次新建一块并插到同轮正文前。 */
export function applyReasoning(items: ChatItem[], text: string, final: boolean, allocId: () => number, roundKey?: number): ChatItem[] {
  const turnStart = currentTurnStart(items);
  const existing = items.findIndex((item, index) =>
    index >= turnStart && item.kind === "thinking" && item.roundKey === roundKey,
  );
  if (existing >= 0) {
    const current = items[existing];
    if (current?.kind !== "thinking") return items;
    const steps = nextThinkingSteps(current.steps ?? { settled: current.thought, draft: "" }, text, final);
    const next = items.slice();
    next[existing] = { ...current, thought: thinkingStepsText(steps), steps };
    return next;
  }
  const steps = nextThinkingSteps({ settled: "", draft: "" }, text, final);
  const created: ChatItem = {
    id: allocId(), kind: "thinking", thought: thinkingStepsText(steps), interrupted: false, steps,
    ...(roundKey === undefined ? {} : { roundKey }),
  };
  const assistantAt = items.findIndex((item, index) =>
    index >= turnStart
    && item.kind === "assistant"
    && (roundKey === undefined || item.roundKey === roundKey),
  );
  const insertAt = assistantAt >= 0 ? assistantAt : turnAppendIndex(items);
  return [...items.slice(0, insertAt), created, ...items.slice(insertAt)];
}
```

- [ ] **Step 5: 事件接线透传**

把 `handleEvent` 函数声明改为 `export function handleEvent(`，供接线测试直接驱动。

把 `handleEvent` 的 `token` 分支改为：
```ts
    case "token":
      setItems((prev) => appendToken(prev, event.text, allocId, event.roundKey), event.sessionId);
      break;
```
把 `handleEvent` 的 `reasoning` 分支改为：
```ts
    case "reasoning":
      setItems((prev) => applyReasoning(prev, event.text, event.final === true, allocId, event.roundKey), event.sessionId);
      break;
```
在 `handleEvent` 的 `tool/start` card 对象里，`status: "start",` 之后加一行：
```ts
            ...(event.roundKey === undefined ? {} : { roundKey: event.roundKey }),
```

- [ ] **Step 6: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/appWiring.spec.ts`
Expected: PASS。既有 `:1634-1642` 与 `:1691-1693` 不传 `roundKey`，`undefined === undefined` 命中合并分支，且 fixture 无 assistant 条目，插入下标仍为 2，断言不变。

- [ ] **Step 7: 类型检查与全量单测**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork typecheck
corepack yarn workspace dsh-plugin-huaanwork test
```
Expected: 两条 exit 0。

- [ ] **Step 8: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/App.tsx \
        dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "feat: split live thinking blocks per model step"
```

---

### Task 7: 思考收尾判定按轮次收窄

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts:136-149`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`thinkingBefore`，按符号定位）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/thinkingPanel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`

**Interfaces:**
- Consumes: `TurnItem` thinking/assistant 的 `roundKey`（Task 1）、`ChatItem.roundKey`（Task 6）。
- Produces: `hasAssistantTextAfter` 在明确异键 thinking/assistant 处停止；`thinkingBefore(items, index)` 只返回同轮思考，签名不变。

- [ ] **Step 1: 写失败测试**

在 `tests/client-huaanwork/thinkingPanel.spec.ts` 末尾追加：

```ts
test("hasAssistantTextAfter stops at the next round's thinking block", () => {
  const items = [
    { kind: "thinking" as const, thought: "第一轮想", roundKey: 10 },
    { kind: "tool" as const },
    { kind: "thinking" as const, thought: "第二轮想", roundKey: 20 },
    { kind: "assistant" as const, text: "第二轮正文", roundKey: 20 },
  ];
  assert.equal(hasAssistantTextAfter(items, 0), false, "round 1 produced no visible body of its own");
  assert.equal(hasAssistantTextAfter(items, 2), true);
});

test("hasAssistantTextAfter does not adopt a next-round body without its own thinking", () => {
  const items = [
    { kind: "thinking" as const, thought: "第一轮想", roundKey: 10 },
    { kind: "tool" as const },
    { kind: "assistant" as const, text: "第二轮正文", roundKey: 20 },
  ];
  assert.equal(hasAssistantTextAfter(items, 0), false);
});

test("hasAssistantTextAfter keeps scanning past an unkeyed thinking item", () => {
  const items = [
    { kind: "thinking" as const, thought: "第一轮想", roundKey: 10 },
    { kind: "tool" as const },
    { kind: "thinking" as const, thought: "无 key 续想" },
    { kind: "assistant" as const, text: "正文" },
  ];
  assert.equal(hasAssistantTextAfter(items, 0), true);
});

test("hasAssistantTextAfter still sees its own round's body", () => {
  const items = [
    { kind: "thinking" as const, thought: "想", roundKey: 10 },
    { kind: "assistant" as const, text: "正文" },
    { kind: "thinking" as const, thought: "下一轮", roundKey: 20 },
  ];
  assert.equal(hasAssistantTextAfter(items, 0), true);
});

test("hasAssistantTextAfter without roundKeys keeps scanning to the next user", () => {
  const items = [
    { kind: "thinking" as const, thought: "想" },
    { kind: "tool" as const },
    { kind: "assistant" as const, text: "正文" },
  ];
  assert.equal(hasAssistantTextAfter(items, 0), true);
});
```

所需 `hasAssistantTextAfter` 与 `assert` 已在该文件既有 import 列表中，无需改动 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/thinkingPanel.spec.ts`
Expected: FAIL — 第一个用例返回 true。

- [ ] **Step 3: 实现终止条件**

把 `logic/thinkingPanel.ts:136-149` 替换为：

```ts
export function hasAssistantTextAfter(items: readonly TurnItem[], index: number): boolean {
  const current = items[index];
  if (current?.kind !== "thinking") return false;
  for (let i = index + 1; i < items.length; i += 1) {
    const item = items[i];
    // 排队中、刚插入（应答未回）或已抛错的用户消息没有开启下一回合，不结束这里的扫描。
    if (item.kind === "user" && !isUnstartedUserItem(item)) return false;
    if (item.kind === "thinking" && item.roundKey !== undefined && item.roundKey !== current.roundKey) return false;
    if (item.kind === "assistant" && item.roundKey !== undefined && item.roundKey !== current.roundKey) return false;
    if (item.kind === "assistant") {
      const visible = resolveThinking({ reasoning: current.thought, assistantText: item.text }).visible.trim();
      if (visible.length > 0) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: 修正 `thinkingBefore` 并补接线测试**

把 `thinkingBefore` 函数改为导出并按轮次匹配：

```ts
export function thinkingBefore(items: readonly ChatItem[], index: number): Extract<ChatItem, { kind: "thinking" }> | undefined {
  const target = items[index];
  const roundKey = target?.kind === "assistant" ? target.roundKey : undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "user") return undefined;
    if (item.kind !== "thinking") continue;
    if (roundKey === undefined || item.roundKey === undefined || item.roundKey === roundKey) return item;
    return undefined;
  }
  return undefined;
}
```

在 `tests/client-huaanwork/appWiring.spec.ts` 末尾追加：

```ts
test("thinkingBefore never borrows another round's reasoning", () => {
  const items = [
    { id: 1, kind: "user" as const, text: "问题" },
    { id: 2, kind: "thinking" as const, thought: "第一轮想", interrupted: false, roundKey: 10 },
    { id: 3, kind: "assistant" as const, text: "第二轮正文", roundKey: 20 },
  ];
  assert.equal(AppModule.thinkingBefore(items, 2), undefined);
  const sameRound = [...items.slice(0, 2), { id: 4, kind: "assistant" as const, text: "第一轮正文", roundKey: 10 }];
  assert.equal(AppModule.thinkingBefore(sameRound, 2)?.id, 2);
});
```

`ChatRow` 渲染处对 `hasAssistantTextAfter(contentView, ...)` 的调用无需改签名；`contentView` 由 `contentItems(items)` 原样透传，`roundKey` 已在条目上。

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/thinkingPanel.spec.ts
corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/appWiring.spec.ts
```
Expected: 两条 PASS。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts \
        dsh-plugin-huaanwork/src/client-huaanwork/App.tsx \
        dsh-plugin-huaanwork/tests/client-huaanwork/thinkingPanel.spec.ts \
        dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "fix: scope thinking settlement and lookup to its own model step"
```

---

### Task 8: 文档订正、债务登记与全量门禁

**Files:**
- Modify: `docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md:13`、`:24`、`:103-104`、`:123`
- Modify: `docs/superpowers/plans/2026-11-02-chat-tool-panel-plan-review.md`（m-4 项）
- Modify: `docs/evidence/2026-11-02-chat-tool-panel-verification.md:243`
- Modify: `AGENTS.md`（Known tech debt 表）
- Create: `docs/evidence/2026-11-09-per-step-tool-board-gates.md`

**Interfaces:**
- Consumes: Task 1–7 的全部实现与测试结果。
- Produces: 订正后的裁定记录、关闭的 m-4 债项、全量门禁证据。

- [ ] **Step 1: 订正旧裁定表**

在 `2026-11-01-chat-tool-panel-design.md:24` 的表格行后追加一行（保留原行作为历史）：

```markdown
| 聚合范围（2026-11-09 重裁） | 每个产生普通 `tool` 条目的模型轮次（harness step）一个看板；有效 `todo_write` 仍走待办卡。原「每个用户回合一个面板」由 `2026-11-09-per-step-tool-board-design.md` R-1/R-12 取代 |
```

在 `:103-104` 的「后续工具只更新同一个回合面板，不新增会话行」及 `:13`、`:123` 的同类回合级表述后追加历史标记：

```markdown
> 2026-11-09 重裁：本段的「每用户回合一个面板 / 后续工具只更新同一回合面板」语义已失效，改为同一 step 内更新该 step 的看板、跨 step 新建看板。见 `2026-11-09-per-step-tool-board-design.md` R-1 / §6。
```

- [ ] **Step 2: 关闭 m-4 的 goal 续轮部分并登记 todo 残余**

在 `2026-11-02-chat-tool-panel-plan-review.md` 的 m-4 段落末尾追加：

```markdown
**处置（2026-11-09）**：`2026-11-09-per-step-tool-board-design.md` R-1 / R-7 关闭 goal 续轮导致的历史面板碎裂。工具看板在普通工具范围内两侧逐轮；有效 `todo_write` 实时转待办卡、历史仍入工具卡，两侧数量可能不同，已登记为残余债，不能写成「完全一致」。
```

- [ ] **Step 3: 标记旧验收证据**

在 `docs/evidence/2026-11-02-chat-tool-panel-verification.md:243` 的 Step 2.1 标题后追加一行（不改写原始记录）：

```markdown
> 历史标记（2026-11-09）：本步骤验证的是「每用户回合一个面板」旧裁定，已被 R-1 取代；原始结果保留不改。
```

- [ ] **Step 4: 登记新债务**

在 `AGENTS.md` 的 Known tech debt 表末尾追加一行：

```markdown
| 轮次推断降级的不精确性（2026-11-09 R-5 登记）：无 `step/start` 的旧日志或宿主监听不可达时，客户端按思考 / 可见正文位置推断轮次边界；既无思考也无可见正文的 step 会被并入前一轮看板（实测 `b6617067` 的 step 2 即此形态，4 次调用合并）。这是经裁定的降级而非缺陷。触发条件：出现无 `step/start` 的真实旧日志且用户报告轮次合并；触发后评估是否补宿主侧键来源。 | `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`（`splitRounds`） | 后续（R-5，非阻断） |
| `todo_write` 实时/历史呈现差异（2026-11-09 R-12 登记）：实时侧有效 `todo_write` 转待办卡、不生成普通工具看板；历史侧仍把它映射为工具卡。同一份运行实时与历史看板数可能不同。触发条件：owner 要求两路径统一，或用户在回看时报告数量差异；触发后另行裁定历史侧待办映射，不在轮次看板里程碑暗改。 | `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`tool/start` 分支）、`logic/sessionChannel.ts`（`tool-call` 映射） | 后续（R-12，非阻断） |
```

- [ ] **Step 5: 跑全量门禁并落盘退出码**

Run:
```bash
corepack yarn check > /tmp/per-step-tool-board-check.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`。若 `verify:aa` 因已知并发 race 变红（AGENTS.md 债表首行），单独重跑 `corepack yarn workspace dsh-plugin-huaanwork verify:aa` 取证，并在证据文档里如实记录两次结果，不声称一次全绿。

- [ ] **Step 6: 写门禁证据文档**

创建 `docs/evidence/2026-11-09-per-step-tool-board-gates.md`，记录：每条命令原文、退出码、测试总数与新增数、`verify:aa` 是否重跑及原因、未跑的项（Windows 打包 / 真机）明确标注。

- [ ] **Step 7: 提交**

```bash
git add docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md \
        docs/superpowers/specs/2026-11-09-per-step-tool-board-design.md \
        docs/superpowers/plans/2026-11-02-chat-tool-panel-plan-review.md \
        docs/superpowers/plans/2026-11-09-per-step-tool-board.md \
        docs/superpowers/plans/2026-11-09-per-step-tool-board-plan-review.md \
        docs/evidence/2026-11-02-chat-tool-panel-verification.md \
        AGENTS.md docs/evidence/2026-11-09-per-step-tool-board-gates.md
git commit -m "docs: re-rule tool board granularity to model steps and register residuals"
```

---

### Task 9: 真机验收

**Files:**
- Create: `docs/evidence/2026-11-09-per-step-tool-board-acceptance.md`
- Create: `dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs`
- Create: `dsh-plugin-huaanwork/scripts/huaanwork-localize-session-fixture.mjs`

**Interfaces:**
- Consumes: Task 1–8 的实现；Task 0 的隔离实例流程；夹具本地化须与 `huaanwork-host/writable-root.ts` / `session-id.ts` 的根推导、上游 `session-persistence-jsonl` 的 `projectKey` / `encodeSegment` / `assertStoredIdentity`（物理路径必须等于由 header `cwd`/`id` 派生的路径）保持同形。
- Produces: 设计文档 §10 的 A1–A10 逐项结论与证据指针；本地化夹具的会话 id（`$TMP_ROOT/fixture.json`）。

- [ ] **Step 1: 准备隔离实例并本地化历史夹具**

为什么必须本地化（二轮评审 I-A）：整树复制来的 `b6617067` 其持久化 `cwd` 与 id 稳定前缀都绑定真实 home（`21ea5abce4b51784` 即真实 workspace 路径 sha256 的前 16 位，已实测核实）。临时实例里 `writableRootForSession`（`huaanwork-host/writable-root.ts:45-47`）按**临时** workspace 哈希判中立前缀不命中，回落临时中立根；`ensureChannelAgent` 的 persisted 分支守卫 `isInside(root, cwd)` 随之拒绝恢复（报「该会话属于其他工作区」），界面只落只读错误视图（`HistoryDetailPane` 只有 `detail-*` 类，无 `.tool-panel`/`.thinking-panel`），A3/A7 必超时。上游 `session-persistence-jsonl` 的 `assertStoredIdentity` 又要求物理路径恰等于由 header `cwd`/`id` 派生的 `projectKey`/`encodeSegment` 路径。因此解锁方式 = 按宿主同一套派生算法把夹具改写为「临时实例原生」会话：新 id = 临时 workspace 稳定前缀 + 原 `b6617067` 后缀（可溯源），header `cwd` 指向临时铸造根，物理存储路径与 header 同源派生；事件行逐字保留，A3 判据数字不变。本地化后 `neutralPrefixed` 为真、`mintedRoot` 与 header `cwd` 相等，守卫与 `assertStoredIdentity` 都通过。

先创建 `dsh-plugin-huaanwork/scripts/huaanwork-localize-session-fixture.mjs`：

```js
// 把整树复制进临时 DSH_HOME 的真实会话日志改写为「临时实例原生」会话：
// 新 id 携带临时 workspace 的稳定前缀（huaanwork-host/session-id.ts 同算法），
// header cwd 指向临时铸造根（workspace-state.ts 的 neutralSessionRootPath 同算法），
// 物理路径与 header 同源派生（上游 session-persistence-jsonl 的 projectKey/encodeSegment 同算法，
// 其 assertStoredIdentity 强制两者一致）。事件行逐字保留。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function parseArgs(argv) {
  const options = { home: undefined, state: undefined, src: undefined, suffix: undefined, zstd: '/opt/anaconda3/bin/zstd' }
  for (const arg of argv) {
    if (arg.startsWith('--home=')) options.home = arg.slice(7)
    else if (arg.startsWith('--state=')) options.state = arg.slice(8)
    else if (arg.startsWith('--src=')) options.src = arg.slice(6)
    else if (arg.startsWith('--suffix=')) options.suffix = arg.slice(9)
    else if (arg.startsWith('--zstd=')) options.zstd = arg.slice(7)
    else throw new Error(`unknown argument: ${arg}`)
  }
  for (const key of ['home', 'state', 'src', 'suffix']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) throw new Error(`--${key} required`)
  }
  return options
}

/** 与上游 projectKey 同形：分隔符（/ 与反斜杠与 :）折叠为 -、安全字符保留、其余 ~XXXX 大写十六进制，前导 - 去除后包 --…--。 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 与上游 encodeSegment 同形：安全字符保留，其余（含 ~）转 ~XXXX；`.`/`..` 全转义防穿越。 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

const options = parseArgs(process.argv.slice(2))
const realHome = process.env.HOME === undefined ? undefined : resolve(join(process.env.HOME, '.huaanwork'))
if (realHome !== undefined && resolve(options.home) === realHome) {
  throw new Error('--home points at the real ~/.huaanwork; refusing to write into the production home')
}
const state = JSON.parse(readFileSync(options.state, 'utf8'))
if (typeof state.active !== 'string' || state.active.length === 0) throw new Error('state.json has no active profile')
const profileDir = resolve(join(options.home, 'profiles', state.active))
const workspaceRoot = resolve(join(profileDir, 'workspace'))
const stable = `huaanwork-${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)}`
const sessionId = `${stable}-${options.suffix}`
const mintedRoot = join(profileDir, 'workspace-sessions', sessionId)

const sourceText = (() => {
  const dec = spawnSync(options.zstd, ['-dc', options.src], { maxBuffer: 64 * 1024 * 1024 })
  if (dec.error !== undefined || dec.status !== 0) throw new Error(`zstd -dc failed: ${String(dec.stderr)}`)
  return dec.stdout.toString('utf8')
})()
const firstNewline = sourceText.indexOf('\n')
if (firstNewline < 0) throw new Error('fixture log has no header line')
const header = JSON.parse(sourceText.slice(0, firstNewline))
if (header.type !== 'session' || typeof header.version !== 'number') throw new Error('fixture header is not a session header')
header.id = sessionId
header.cwd = mintedRoot
const rewritten = `${JSON.stringify(header)}${sourceText.slice(firstNewline)}`

const storageDir = join(options.home, 'sessions', projectKey(mintedRoot), encodeSegment(sessionId))
const dst = join(storageDir, 'session.v4.jsonl.zstd')
mkdirSync(storageDir, { recursive: true })
mkdirSync(mintedRoot, { recursive: true })
const staging = `${dst}.staging`
writeFileSync(staging, rewritten)
const compressed = spawnSync(options.zstd, ['-f', '-q', staging, '-o', dst])
if (compressed.error !== undefined || compressed.status !== 0) {
  throw new Error(`zstd compress failed: ${String(compressed.stderr)}`)
}
rmSync(staging, { force: true })

// 回读校验：行数一致、header 为改写值、事件行逐字不变。
const verifyText = (() => {
  const dec = spawnSync(options.zstd, ['-dc', dst], { maxBuffer: 64 * 1024 * 1024 })
  if (dec.error !== undefined || dec.status !== 0) throw new Error(`zstd -dc verify failed: ${String(dec.stderr)}`)
  return dec.stdout.toString('utf8')
})()
const sourceLines = sourceText.split('\n').filter(Boolean)
const verifyLines = verifyText.split('\n').filter(Boolean)
if (verifyLines.length !== sourceLines.length) throw new Error('line count changed')
const verifyHeader = JSON.parse(verifyLines[0] ?? 'null')
if (verifyHeader?.id !== sessionId || verifyHeader?.cwd !== mintedRoot) throw new Error('header rewrite lost')
for (let i = 1; i < verifyLines.length; i++) {
  if (verifyLines[i] !== sourceLines[i]) throw new Error(`event line ${i} changed`)
}
console.log(JSON.stringify({ sessionId, storagePath: dst, mintedRoot, eventLines: sourceLines.length - 1 }))
```

再准备临时实例（复制后清掉其他真实会话，只放入本地化夹具）：

```bash
REPO="$(pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/huaanwork-per-step-accept.XXXXXX")"
chmod 700 "$TMP_ROOT"
mkdir -p "$TMP_ROOT/.huaanwork" "$TMP_ROOT/userData/profile-selection"
cp -R "$HOME/.huaanwork/." "$TMP_ROOT/.huaanwork/"
cp "$HOME/Library/Application Support/HuaAnWork/profile-selection/state.json" \
   "$TMP_ROOT/userData/profile-selection/state.json"
SRC="$(find "$HOME/.huaanwork/sessions" -type d -name 'huaanwork-21ea5abce4b51784-b6617067' | head -1)"
# 清空整树复制来的其他真实会话：它们的持久化 cwd 都绑定真实 home，在临时实例一律不可恢复
# （点击只落只读错误视图），保留只会给最近列表添不可点项并扩大真实数据复制面。
find "$TMP_ROOT/.huaanwork/sessions" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
node "$REPO/dsh-plugin-huaanwork/scripts/huaanwork-localize-session-fixture.mjs" \
  --home="$TMP_ROOT/.huaanwork" \
  --state="$TMP_ROOT/userData/profile-selection/state.json" \
  --src="$SRC/session.v4.jsonl.zstd" \
  --suffix=b6617067 \
  > "$TMP_ROOT/fixture.json"
cat "$TMP_ROOT/fixture.json"
echo "$TMP_ROOT" > /tmp/huaanwork-per-step-accept-root
```
Expected: 本地化脚本 exit 0（内含逐行回读自校验，任何行变化都会抛错），`fixture.json` 打印 `sessionId`（`huaanwork-<临时workspace哈希>-b6617067`）、`storagePath`、`mintedRoot`、`eventLines`；sessions 树下只有该夹具一份日志；临时根目录权限 700。设计 §1 取证时（2026-11-09）该夹具为 21 step / 66 调用 / 20 有工具 / 20 有思考；若源会话此后被续写，A3 的 20/66/20 以 Step 1 时刻的源日志重算并在验收文档注明。

启动：
```bash
REPO="$(pwd)"
TMP_ROOT="$(cat /tmp/huaanwork-per-step-accept-root)"
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  DSH_HOME="$TMP_ROOT/.huaanwork" \
  HUAANWORK_ACCEPTANCE_HOOKS=1 \
  "$REPO/dsh-plugin-huaanwork/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  "$REPO/dsh-plugin-huaanwork/lib/main.js" \
  --user-data-dir="$TMP_ROOT/userData" --remote-debugging-port=9333 \
  > "$TMP_ROOT/electron.log" 2>&1 &
echo $! > "$TMP_ROOT/electron.pid"
```

- [ ] **Step 2: 写完整 CDP 驱动脚本**

创建 `dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs`：

```js
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FACTS = `(() => {
  const log = document.querySelector('.chat-log')
  if (!log) return null
  const rows = [...log.children]
  const panels = [...document.querySelectorAll('.tool-panel')]
  return {
    panelCount: panels.length,
    thinkingCount: document.querySelectorAll('.thinking-panel').length,
    titles: panels.map((p) => p.querySelector('.tool-panel-title')?.textContent ?? ''),
    counts: panels.map((p) => Number((p.querySelector('.tool-panel-title')?.textContent ?? '').match(/(\\d+) 项调用/)?.[1] ?? 0)),
    panelRowIndexes: panels.map((p) => rows.indexOf(p)),
    expanded: panels.map((p) => p.querySelector('.tool-panel-title')?.getAttribute('aria-expanded')),
  }
})()`

const STOPPED = `document.querySelector('.send.stop') === null`

// 三轮 T9-1：requestSubmit() 绕过 composer 就绪门（hostPhase/sidecar/pendingInput/运行中），会静默 no-op 或把提示误投成输入卡回答/运行中续写；改为等草稿写回后点可点的发送按钮，同 huaanwork-subagent-run-windows-acceptance.mjs 的 sendText。
function sendExpression(text) {
  return `(async () => {
    const box = document.querySelector('.composer textarea')
    if (!box) return { ok: false, reason: 'composer missing' }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, ${JSON.stringify(text)})
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const send = document.querySelector('.composer button.send[aria-label="发送"]')
    if (!send) return { ok: false, reason: 'send button missing' }
    if (send.disabled) return { ok: false, reason: 'send disabled' }
    send.click()
    return { ok: true }
  })()`
}

// 会话行的 title 属性是 `${label}\n${sessionId}`（App.tsx 的 recent-item 渲染），按 id 后缀精确匹配；
// 项目行 title 以路径结尾、自动化运行标签行无 id 后缀，都不会误命中；也不依赖可能重名的显示标题。
function openHistoryExpression(sessionId) {
  return `(() => {
    const row = [...document.querySelectorAll('.recent-item')].find((item) => (item.getAttribute('title') ?? '').endsWith('\\n' + ${JSON.stringify(sessionId)}))
    if (!row) return false
    row.click()
    return true
  })()`
}

function toggleExpression(index) {
  return `(() => {
    const titles = [...document.querySelectorAll('.tool-panel .tool-panel-title')]
    if (!titles[${index}]) return false
    titles[${index}].click()
    return true
  })()`
}

function parseArgs(argv) {
  const options = { cdp: '9333', origin: undefined, timeout: 300_000, action: 'facts', out: undefined, prompt: undefined, sessionId: undefined, index: 0, newTask: true }
  for (const arg of argv) {
    if (arg.startsWith('--cdp=')) options.cdp = arg.slice(6)
    else if (arg.startsWith('--origin=')) options.origin = arg.slice(9)
    else if (arg.startsWith('--timeout=')) options.timeout = Number(arg.slice(10))
    else if (arg.startsWith('--action=')) options.action = arg.slice(9)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg.startsWith('--prompt=')) options.prompt = arg.slice(9)
    else if (arg.startsWith('--session-id=')) options.sessionId = arg.slice(13)
    else if (arg.startsWith('--index=')) options.index = Number(arg.slice(8))
    else if (arg.startsWith('--new=')) options.newTask = arg.slice(6) !== '0'
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['facts', 'new-task', 'send', 'stop', 'toggle', 'open-history'].includes(options.action)) throw new Error('bad --action')
  if (options.action === 'send' || options.action === 'stop') {
    if (typeof options.prompt !== 'string' || options.prompt.length === 0) throw new Error('--prompt required')
  }
  if (options.action === 'open-history' && typeof options.sessionId !== 'string') throw new Error('--session-id required')
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 1) throw new Error('bad --timeout')
  return options
}

async function pageTarget(port, origin) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`CDP list HTTP ${response.status}`)
  let pages = (await response.json()).filter((t) => t.type === 'page' && typeof t.url === 'string' && t.webSocketDebuggerUrl)
  if (origin !== undefined) {
    pages = pages.filter((t) => t.url.startsWith(origin))
  } else {
    // 二轮 M-5：webserver 在默认口 43120 被占时顺延（desktop-port.ts 重试上限 32），不假设默认口；
    // 客户端 origin 直接取本调试端口自己的页面清单，--origin 仅作歧义时的逃生门。
    pages = pages.filter((t) => /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url))
  }
  if (pages.length !== 1) {
    throw new Error(origin === undefined
      ? `expected one 127.0.0.1 page on the debugging port, found ${pages.length}; pass --origin=... to disambiguate`
      : `expected one ${origin} page, found ${pages.length}`)
  }
  return pages[0]
}

async function connect(target, timeout) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP WebSocket failed')), { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.fail(new Error(JSON.stringify(message.error)))
    else entry.ok(message.result)
  })
  const call = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timeout`)) }, timeout)
    pending.set(id, { ok, fail, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await call('Runtime.enable')
  await call('Page.enable')
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  return { socket, call, evaluate }
}

async function waitFor(evaluate, expression, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${expression}`)
}

const SEND_READY_TIMEOUT = 30_000

async function submitPrompt(evaluate, text, timeout) {
  const deadline = Date.now() + Math.min(timeout, SEND_READY_TIMEOUT)
  let reason = 'composer missing'
  while (Date.now() < deadline) {
    const result = await evaluate(sendExpression(text))
    if (result?.ok === true) return
    reason = result?.reason ?? 'unknown'
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`composer not ready: ${reason}`)
}

async function run(options) {
  const { socket, call, evaluate } = await connect(await pageTarget(options.cdp, options.origin), options.timeout)
  try {
    await waitFor(evaluate, `document.querySelector('.chat-log') !== null`, options.timeout)
    if (options.action === 'new-task') {
      await evaluate(`document.querySelector('button.nav-it[title="新建任务"]')?.click()`)
      await waitFor(evaluate, `document.querySelector('.composer textarea') !== null`, options.timeout)
    } else if (options.action === 'send' || options.action === 'stop') {
      if (options.newTask) {
        await evaluate(`document.querySelector('button.nav-it[title="新建任务"]')?.click()`)
        await waitFor(evaluate, `document.querySelector('.composer textarea') !== null`, options.timeout)
      }
      const baseline = await evaluate(`(() => ({
        users: document.querySelectorAll('.bubble.user').length,
        assistants: document.querySelectorAll('.bubble.assistant').length,
        panels: document.querySelectorAll('.tool-panel').length,
        notes: document.querySelectorAll('.note, .banner').length,
      }))()`)
      await submitPrompt(evaluate, options.prompt, options.timeout)
      await waitFor(evaluate, `document.querySelectorAll('.bubble.user').length > ${baseline.users}`, options.timeout)
      if (options.action === 'stop') {
        await waitFor(evaluate, `document.querySelector('.send.stop') !== null`, options.timeout)
        await evaluate(`document.querySelector('.send.stop').click()`)
      } else {
        await waitFor(evaluate, `document.querySelector('.send.stop') !== null
          || document.querySelectorAll('.bubble.assistant').length > ${baseline.assistants}
          || document.querySelectorAll('.tool-panel').length > ${baseline.panels}
          || document.querySelectorAll('.note, .banner').length > ${baseline.notes}`, options.timeout)
      }
      await waitFor(evaluate, STOPPED, options.timeout)
    } else if (options.action === 'toggle') {
      await waitFor(evaluate, `document.querySelectorAll('.tool-panel .tool-panel-title').length > ${options.index}`, options.timeout)
      if (!(await evaluate(toggleExpression(options.index)))) throw new Error('panel index not found')
    } else if (options.action === 'open-history') {
      await waitFor(evaluate, `[...document.querySelectorAll('.recent-item')].some((item) => (item.getAttribute('title') ?? '').endsWith('\\n' + ${JSON.stringify(options.sessionId)}))`, options.timeout)
      if (!(await evaluate(openHistoryExpression(options.sessionId)))) throw new Error('history row not found')
      await waitFor(evaluate, `document.querySelectorAll('.tool-panel, .thinking-panel').length > 0`, options.timeout)
    }
    const facts = await evaluate(FACTS)
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    if (options.out !== undefined) {
      await mkdir(dirname(resolve(options.out)), { recursive: true })
      await writeFile(resolve(options.out), Buffer.from(shot.data, 'base64'))
    }
    return { action: options.action, facts, screenshot: options.out ?? null }
  } finally {
    socket.close()
  }
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invoked === import.meta.url) {
  try {
    console.log(JSON.stringify(await run(parseArgs(process.argv.slice(2))), null, 2))
  } catch (cause) {
    console.error(JSON.stringify({ status: 'FAIL', message: cause instanceof Error ? cause.message : String(cause) }, null, 2))
    process.exitCode = 1
  }
}
```

- [ ] **Step 3: A3 历史夹具**

```bash
TMP_ROOT="$(cat /tmp/huaanwork-per-step-accept-root)"
FIXTURE_ID="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).sessionId)' "$TMP_ROOT/fixture.json")"
mkdir -p "$TMP_ROOT/evidence"
node dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs \
  --action=open-history --session-id="$FIXTURE_ID" \
  --out="$TMP_ROOT/evidence/a3.png" > "$TMP_ROOT/evidence/a3.json"
```
A3 判据：`facts.panelCount === 20`、`facts.thinkingCount === 20`、`facts.counts` 之和 === 66、`facts.panelRowIndexes` 严格递增，且不存在单个面板 `count === 66`。若 open-history 超时且界面停在只读错误视图（`.detail-*` 类、无 `.tool-panel`），是夹具本地化失败（cwd 守卫拒绝恢复）而非投影缺陷：回 Step 1 核对 `fixture.json` 的 `sessionId`/`storagePath` 与最近列表实际条目。

- [ ] **Step 4: A1/A5 实时运行与日志对账**

```bash
TMP_ROOT="$(cat /tmp/huaanwork-per-step-accept-root)"
node dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs \
  --action=send --prompt='请使用 bash 依次执行 pwd、ls、uname -a，并汇总输出。' \
  --out="$TMP_ROOT/evidence/a1.png" > "$TMP_ROOT/evidence/a1.json"
LATEST="$(find "$TMP_ROOT/.huaanwork/sessions" -name 'session.v4.jsonl.zstd' -print0 | xargs -0 ls -t | head -1)"
/opt/anaconda3/bin/zstd -dc "$LATEST" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows=s.split("\n").filter(Boolean).map(JSON.parse);
  const steps=[]; const byKey=new Map(); let current=null;
  for(const row of rows){
    if(row.type==="turn/start") current=null;
    if(row.type==="step/start"){
      current={seq:row.seq,turn:row.data?.turn,step:row.data?.step,normalTools:0,reasoning:0};
      steps.push(current); byKey.set(`${current.turn}:${current.step}`,current);
    }
    if(row.type==="tool/call"){
      const owner=byKey.get(`${row.data?.turn}:${row.data?.step}`) ?? current;
      // 二轮 M-1：todo_write「有效」判据镜像 bridge startDetail——日志里 arguments 是 JSON 字符串，
      // 解析后 todos 为数组即走待办卡（App 侧 event.todos 连空数组都判真），非数组才是普通工具条目。
      let args=row.data?.arguments; if(typeof args==="string"){try{args=JSON.parse(args)}catch{args=undefined}}
      const todoCard=row.data?.name==="todo_write" && Array.isArray(args?.todos);
      if(owner && !todoCard) owner.normalTools++;
    }
    if(row.type==="assistant/message"){
      const blocks=row.data?.message?.content??[];
      // 二轮 M-1：空白 reasoning 实时侧不渲染思考面板（shouldRenderThinking 按 trim 判空），日志侧同口径。
      if(current && blocks.some((b)=>b.type==="reasoning" && typeof b.text==="string" && b.text.trim().length>0)) current.reasoning++;
    }
  }
  console.log(JSON.stringify(steps));
});'
```
Expected：实时 facts 的 `panelCount` 等于磁盘日志中 `normalTools > 0` 的 step 数（`todo_write` 且解析后 `arguments.todos` 为数组的调用走待办卡、不计入；无效 `todo_write` 计入），`thinkingCount` 等于 `reasoning > 0`（reasoning 文本 trim 非空口径，与 `shouldRenderThinking` 一致）的 step 数。若模型未产生多 step 或未调用普通工具，标 BLOCKED 并换提示重跑，不改写判据。

- [ ] **Step 5: 其余真机项**

- A2：发送 `先读取 package.json，然后只回答“收到”，再读取 tsconfig.json。`，用 Step 4 的日志对账确认无工具 step 不产出看板；若模型未形成该形态，标 BLOCKED。
- A4：第一条消息用默认 `--action=send`（新任务）；结束后第二条执行 `--action=send --new=0 --prompt='再读取 tsconfig.json 并汇总。'`，核对看板按用户消息归属。
- A7：`FIXTURE_ID` 取法同 Step 3；先 `--action=open-history --session-id="$FIXTURE_ID"`，再 `--action=toggle --index=2` 记录 `expanded[2]`，然后 `--action=new-task`，最后再次 `--action=open-history --session-id="$FIXTURE_ID"`，核对 `expanded[2]` 仍为 `true` 且其余不变（重复 open-history 走宿主幂等 resume + 客户端既有标签激活，`panelToggled` 不重建）。
- A8：`--action=stop --prompt='请使用 bash 连续执行 sleep 30 与 uname -a。'`，核对无手动覆盖的看板收起；状态按真实终态判断，仅未结算调用允许「已中断」。
- A6/A9：UNIT-ONLY，由 Task 4 的 final/混合键用例和既有断连用例覆盖，真机不重复。

每项记录：命令原文、facts JSON、日志派生结果、截图路径、结论（PASS / FAIL / UNIT-ONLY / BLOCKED）。

- [ ] **Step 6: A10 全量门禁复核**

引用 Task 8 Step 5 的退出码与日志路径，不重跑（除非 Task 8 之后又有代码改动）。

- [ ] **Step 7: 归档证据、退出实例并清理临时副本**

设计 §10 要求「完成后清理临时副本」，review I-6 第 4 条同口径：临时根里是整份生产 home 复制（含账户/API 设置），实例还占着 9333 调试端口，不清理则重跑会连到旧实例。本仓 `origin` 是 public 仓库，截图不进提交——先把证据移出临时根到本地备份，验收文档只带文字证据与备份路径。

```bash
TMP_ROOT="$(cat /tmp/huaanwork-per-step-accept-root)"
# 按 basename 判形态，不拼 $TMPDIR：Step 1 与 Step 7 可能在不同 shell 里跑，TMPDIR 未设或尾斜杠
# 不一致都会让拼接式 pattern 与 mktemp 实际输出失配而误拒绝；basename 判据与 TMPDIR 无关。
case "$(basename "$TMP_ROOT")" in
  huaanwork-per-step-accept.?*) ;;
  *) printf 'refusing to clean unexpected TMP_ROOT=%s\n' "$TMP_ROOT" >&2; exit 1 ;;
esac
BACKUP="$HOME/huaanwork-per-step-accept-evidence-$(date +%F)"
mkdir -p "$BACKUP/evidence"
# src/. 形态而非 cp -R src dst：同日重跑时后者会嵌套成 evidence/evidence/。
cp -R "$TMP_ROOT/evidence/." "$BACKUP/evidence/"
cp "$TMP_ROOT/fixture.json" "$BACKUP/fixture.json"
kill "$(cat "$TMP_ROOT/electron.pid")" 2>/dev/null || true
rm -rf "$TMP_ROOT" /tmp/huaanwork-per-step-accept-root
printf 'evidence-backup=%s\n' "$BACKUP"
```
Expected: 打印 `evidence-backup=…`；Electron 进程退出，临时根与指针文件都已删除；`$BACKUP/evidence` 内有各验收项的 png 与 facts JSON。`rm -rf` 前的 basename 守卫拒绝任何非本次 `mktemp` 形态的路径（空值、`/`、真实 home、Task 0 的 `huaanwork-per-step.*` 根均拒绝）。

- [ ] **Step 8: 写验收文档**

创建 `docs/evidence/2026-11-09-per-step-tool-board-acceptance.md`：A1–A10 逐项表格（判据 / 方式 / 结果 / 证据指针）、隔离实例参数、夹具来源与本地化（`b6617067` 事件逐字保留；id/cwd 按宿主派生算法改写为临时实例原生，`fixture.json` 的 `sessionId`/`storagePath`/`eventLines` 一并记录）、Step 7 打印的 `evidence-backup` 路径（截图与 facts JSON 的本地留存处，不进提交）、未跑项与原因。任何 FAIL 都如实记录，不以单测冒充真机。

- [ ] **Step 9: 提交**

```bash
git add dsh-plugin-huaanwork/scripts/huaanwork-accept-per-step-board.mjs \
        dsh-plugin-huaanwork/scripts/huaanwork-localize-session-fixture.mjs \
        docs/evidence/2026-11-09-per-step-tool-board-acceptance.md
git commit -m "test: accept per-step tool boards on an isolated real instance"
```
只提交脚本与文字证据；`$BACKUP` 下的截图、`fixture.json` 与任何临时根副本都不 `git add`（public 仓库约定）。

---

## Self-Review

**Spec coverage：** R-1/R-12→Task 4 + 验收口径；R-2→Task 1/2/5；R-3/R-13→Task 0/5；R-4→Task 2；R-5→Task 4（final、混合键、全缺键用例）；R-6→Task 4 保留用户段切分与 `segment.final`、Task 8 不改结算；R-7→Task 6/7；R-8/R-9→Task 4（`isLastRound`、manual toggle）与 A7/A8；R-10→Global Constraints；R-11→Task 8。设计 §10 的 A1–A10→Task 9。无缺口。

**Review 覆盖：** B-1→Task 6/7；B-2→Task 6；I-1/I-3→Task 4；I-2→Task 5；I-4→R-12、Task 8、Task 9 判据；I-5→Task 0；I-6→Task 9；M-1→Task 1 改为 typecheck；M-2→Task 5 预期失败原因；M-3→设计 A3；M-4→Task 8；M-5→设计 R-13；M-6→Task 6 同轮 assistant 插入；M-7→Task 5/6/7 新增回归；M-8→Task 0 Step 0 与 Task 8；M-9→下方工作量。二轮复核：I-A（夹具持久化 cwd 绑定真实 home，被临时实例 cwd 守卫拒绝恢复）→Task 9 Step 1 本地化脚本；二轮 M-1（A1/A5 日志派生计数口径：todo_write 有效性、空白 reasoning）→Task 9 Step 4；二轮 M-5（默认口 43120 被占导致 origin 失配）→Task 9 Step 2 origin 自动发现；二轮 M-2（无 key thinking 跟随口径）→Task 7 条件与回归用例；二轮 M-6/A4 竞态→Task 9 `send` 基线计数等待；二轮 M-3（attachment 降级不对称）→设计 §6.1/§6.4 与 Task 4 attachment 专项用例；二轮 M-4（引用漂移）→Global Constraints 的符号定位规则与后续任务行号清理。三轮 T9-1（Task 9 实时发送）→**修法采纳、归因订正**：`sendExpression` 改 async（原生 setter + `input` + 80ms + `.composer button.send[aria-label="发送"]` 存在且未禁用才 `click()`，删除同拍 `form.requestSubmit()`），新增 `submitPrompt` 外层重试（就绪上限 `min(timeout, 30s)`、500ms 间隔、超时抛最后 reason），`send` 与 `stop` 首发共用，停止按钮顺序不变。**实测反证**：评审断言的「同拍 `requestSubmit()` 提交空草稿」在 React 18.3.1 不成立——用仓库同版 UMD + `createRoot` 搭最小 composer mimic（`value={draft}`、`onChange→setDraft`、`disabled={!draft.trim()}`、`onSubmit` 记录 handler 所见 draft），经 CDP 同拍执行原表达式：handler 读到完整提示文本、按钮提交时已解禁，20/20 次重复零失败（离散 `input` 更新在 `dispatchEvent` 返回前同步 flush）。真实缺陷是 `requestSubmit()` **绕过 composer 就绪门**，同一 mimic 五场景实测：① `hostPhase!=='ok'` / `sidecarDead` → `submitComposer`（`App.tsx:3080`）静默早退、无用户气泡，驱动空等至超时；② `pendingInput` → `dispatchComposerSubmission`（`logic/inputCard.ts:70-78`）把验收提示当**输入卡回答**投出（按钮 aria-label 是「提交回答」）；③ 运行中 → 只渲染 `.send.stop`，`requestSubmit()` 仍会 `send()` 续写进正在跑的回合。三种形态下按钮门分别返回 `send disabled` / `send button missing`，由外层重试或诚实失败。严重度维持「重要」（验收可执行性），影响面收窄为条件性就绪/误投，非「所有发送必失败」；A3/A6/A7/A9 不走此路径的判断不变。四轮复核（实施就绪度审计，2026-11-09；独立核验宿主/客户端/测试三组锚点 + Task 9 全链取证）：5 项候选发现处置如下——① **成立（重要）**：Task 9 缺清理步骤（Task 0 Step 6 清理的是另一个临时根，覆盖不到），新增 Step 7 归档证据 / 退出实例 / 清理临时副本，原 Step 7/8 顺延为 8/9；截图按 public 仓库约定留本地备份不进提交，`rm -rf` 前加 basename 形态守卫（不拼 `$TMPDIR`：Step 1/7 跨 shell 时 TMPDIR 未设或尾斜杠不一致会让拼接式 pattern 误拒绝；已用真实 `mktemp` 输出 dry-run 验证接受、并用真实 home 与 Task 0 根形态验证拒绝 exit 1）。② **部分成立、归因收窄（次要）**：`agent.ts:134` 确实是 `stateOf(session,'turnBoundary')` 的读法先例（只是读 `lastTurn`），原「引错先例」表述过重；Task 0 Step 5 已补字段定义 / 写入点 / 字段读先例三处精确引用，并写明 `OptionalSessionSeq = SessionSeq | null` 须把 `null` 归一为 `undefined`。③ **误报，撤销**：「Task 0 Step 2 写 cordis `logLevel=info` 是 no-op、阈值不读 cordis 行」不成立——`settings-bridge.ts:57-63` 明写 `desktop-shell` Loader entry id 就是 settings namespace、「settings form 与 pre-Host startup read 现在寻址同一份文档」，`readEntryValue`（`:404-407`）按该 ns 取 value ⇒ 计划写入位置正确；默认阈值已是 info（`file-exporter.ts:21`）只说明当前 profile 下该写入幂等，而临时实例是复制来的 profile，显式断言前置条件正是正确做法，**不改**。④ **成立（次要）**：`handleEvent`（`App.tsx:4184`）与 `thinkingBefore`（`:4767`）在 HEAD 均未导出，Task 6 Step 2 的 Expected 已补这条红灯原因。⑤ **成立（次要，Global Constraints 的符号定位规则已覆盖）**：行号漂移已订正——`RpcEvent` :23-43、`tool/start` 变体 :26-35（`sessionId?: string;` 在 :30）、`detailRecords` :184-303、`session-view.spec.ts` helper :12-29、`bridge.spec.ts` 的 Execute :30 / StreamChunk :17 / PARENT_SESSION :42 / CHILD_SESSION :43 / parentAgent :45；`session-view.ts` 的 `time,` 在 :242/:279 不唯一，已加上下文定位警告。同批独立取证（绿灯，不改计划）：A3 夹具数字从磁盘重算 = 21 step / 66 调用 / 20 有工具 / 20 有思考 / step 21 无工具，与判据一致；夹具本地化的 `projectKey`/`encodeSegment` 与上游 `format.ts:199-245` 逐字同形且真实磁盘布局吻合；CDP 驱动全部 DOM 选择器存在；根 `check` → huaanwork `check` 首步即 `build`，故 Task 9 的 `lib/` 含 Task 1–7 改动。门槛判定：review §7 六条至此全部闭合。

**Placeholder scan：** 无 TBD / TODO。Task 0/9 的临时路径由 `mktemp` 生成并落盘变量；CDP 脚本为完整可执行文件；日志日期用 `$(date +%F)`，不存在未填写的路径占位。

**Type consistency：** `roundKeyOf` / `splitRounds` / `RoundSpan` / `RoundKeys` / `roundKeyFor` 在 Task 4/5 定义并在同任务消费；`appendToken` 第 4 参、`applyReasoning` 第 5 参在 Task 6 定义并接线；`thinkingBefore` 在 Task 7 导出并测试；`HistoryChatItem` 三变体在 Task 1 一次补齐。Task 5 的 `session/disposed` 监听器与 `session/event` 既有监听器分开，既有 `[0]` 顺序不变。

**Fixture 与断言核对：** `toolPanel.spec.ts:41` 的 `content()` 与 `:43` 的 `panelAt(rows, index)` 按行下标取面板；新增混合键用例的面板行号为 `[3,5,7,9]`，对应行下标 `panelAt(rows,2/4/6/8)`，已按算法逐行推演。`bridge.spec.ts` 的 `createCtx()`、`Execute`、`StreamChunk`、`parentAgent` 与 `session-view.spec.ts` 的 `sessionLog` / `HEADER` / `T0` 均复用既有 helper。`handleEvent` 改为导出后才由 Task 6 测试调用。

**校验口径：** Task 1 是纯类型任务，以 typecheck 验证，不伪造运行时红灯；行为红灯由 Task 2–7 承担。真机模型行为不作为确定条件，A1/A5 以运行后磁盘日志对账，未覆盖时标 BLOCKED。

**工作量重估：** 修正后的范围约 **5.5–7 人日**：Task 0 0.5（含阳性对照与清理）、Task 1–3 0.75、Task 4 1.25（含 final/混合键测试）、Task 5 0.75、Task 6–7 1.25、Task 8 0.5、Task 9 1.5–2（完整 CDP 驱动、夹具本地化脚本与逐项对账）。最大不确定项仍是 Task 0 的监听可达性。