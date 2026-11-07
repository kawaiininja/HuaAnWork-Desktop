# 并发项目回合（concurrent project turns）验证证据（Task 11 条款回归 + Task 12 root 门禁）

记录时间：2026-11-05 13:33–13:44（Task 11，本地 UTC+8）、13:45–13:53（Task 12，本地 UTC+8）与 14:05–14:27（Task 12b，本地 UTC+8）。仓库：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`。分支：`feat/huaanwork-concurrent-project-turns`。

本任务**不写新功能**：核对规格 §7 与评审 P1-6、P1-7 的每条验收条款是否各有一条「行为被改坏就会红」的具名测试，再跑会被本功能改动碰到的既有套件。**本文件只记录实际执行过的内容**；未执行的条目见 §7，不得视为通过。Task 12 在同一份文件里补记 root 三条门禁的真实读数（§11），并按 Task 11 复核意见订正了若干计数口径（见各处「Task 12 订正」标注，均为文档准确性问题，不改任何结果）。

本次运行**没有任何 commit / add / stash / restore / clean 操作**（用户未要求提交）；Tasks 1–10 的实现与新增文件全部保持未提交/未跟踪状态。`deepseek-harness/` 未被触碰，未新增依赖。

## 1. 结论摘要

| 步骤 | 命令（摘要） | Exit code | 结果 |
|---|---|---|---|
| Step 1 | 48 条 `rg -n` 条款核对 + 2 条复用测试名 + `tabId` 全量审计 | 48/48 `0` | **48 条条款全部命中具名测试，零缺失**；无需补测试 |
| Step 2 | `vitest run` 24 个条款 spec | **0** | `Test Files 24 passed (24)`；`Tests 517 passed (517)`；0 failed / 0 skipped |
| Step 3 | `vitest run tests/huaanwork-host tests/huaanwork-guardrails tests/client-huaanwork` | **0** | `Test Files 120 passed \| 1 skipped (121)`；`Tests 1876 passed \| 2 skipped (1878)` |
| Step 4a | `corepack yarn workspace dsh-plugin-huaanwork test` | **0** | `Test Files 276 passed \| 4 skipped (280)`；`Tests 3718 passed \| 14 skipped (3732)` |
| Step 4b | `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **0** | 无输出（无诊断） |
| Task 12 Step 1 | root `corepack yarn test` | **0** | 12 个 workspace 全绿，0 失败用例（§11.1） |
| Task 12 Step 2 | root `corepack yarn typecheck` | **0** | 无诊断，仅 `contract-types: 4 generated type files are current`（§11.2） |
| Task 12 Step 3 | root `corepack yarn check` | **1** | **停在 `dsh-plugin-huaanwork` 的 `verify:host`**：35 个用例 28 pass / 7 fail（§11.3）；**不是通过** |
| Task 12b RED | 单跑 `scripts/huaanwork-host-loop.spec.mjs`（修改前） | **1** | 14 个用例 7 pass / 7 fail，与 Task 12 记录的 7 个失败逐项相同（§12.2） |
| Task 12b GREEN | 同上（修改后） | **0** | 14 个用例 14 pass / 0 fail / 0 skipped（§12.2） |
| Task 12b | `corepack yarn workspace dsh-plugin-huaanwork verify:host` | **0** | 35 个用例 35 pass / 0 fail / 0 skipped（§12.3） |
| Task 12b 复跑 | root `corepack yarn check`（严格串行） | **0** | 全链通过：`verify:host` 35/35 → `verify:aa` → `verify:licenses` → `verify:operations` → 六个下游 workspace `check` 全绿（§12.4）。**首次 Task 12 的 exit 1 是历史事实，未改写（§11.3）** |
| 最终修复 RED | 三个聚焦 spec（修改前：`appWiring` / `turn-scheduler` / `sessions`） | **1** | 4 个新回归失败 / 123 通过（§14.2）：跨标签守卫缺失断言红 ×1、`cancelQueuedItemsForSession` 不存在 TypeError ×2、删除会话 drain 复活 `victim` 复现 ×1 |
| 最终修复 GREEN | 同上三 spec（修改后） | **0** | `Test Files 3 passed (3)`；`Tests 127 passed (127)`（§14.2） |
| 最终修复 | `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **0** | 首跑报 1 个 `TS2532`（新方法的 `noUncheckedIndexedAccess`），修复守卫后复跑 exit 0 无诊断（§14.3） |
| 最终修复 | root `corepack yarn check`（单独串行，无并行门禁） | **0** | 全链通过至最末 `agent-catalog-server` 15/15（§14.4） |

零命中条款：**0 条**。因此本任务**没有修改任何源码、测试或断言**，`git add` / `git commit` 未执行（Step 6 条件不成立）。本任务唯一新增的文件就是本证据文档。

## 2. 环境与被验证的代码

| 字段 | 值 |
|---|---|
| 执行日期 | 2026-11-05（本地 UTC+8，13:33–13:44） |
| `node -v` | `v22.23.2`（满足 `^22.19.0 \|\| >=24.0.0`） |
| `corepack yarn -v` | `4.18.0` |
| `git rev-parse HEAD` | `fdcf80422ed2626d89def9c18a769ef465b3d8a5` |
| `git branch --show-current` | `feat/huaanwork-concurrent-project-turns` |
| 测试运行器 | vitest `4.1.8`（`dsh-plugin-huaanwork` workspace） |
| 主机 | darwin arm64（macOS），本地时区 UTC+8 |
| 工作树形态 | Tasks 1–10 的全部实现保持未提交（54 已修改 + 17 未跟踪，见 §8） |

`HEAD` 是分支上的最后一个提交，**不含**本功能改动；被验证的行为全部来自工作树的未提交变更，这与本功能的既定工作方式一致（计划 Global Constraint：提交步骤仅在用户明确要求时执行）。

## 3. Step 1：规格条款 → 测试名对照

在仓库根目录执行。每条 `rg` 均 exit `0`，命中的都是 `test(` 声明行。`rg` 版本 `ripgrep 15.0.0`。

| 条款 | 必须存在的测试名 | 所在文件 | rg 命中（实际测试名字面量） |
| --- | --- | --- | --- |
| 上限缺省 3，小于 1 为 1，大于 8 为 8，非整数为 3 | `clamps max_concurrent_turns` | `settings.spec.ts` | `tests/huaanwork-host/settings.spec.ts:30` — `parseSettings clamps max_concurrent_turns to 1..8 and defaults to 3` |
| 两个项目根同时开始，同根第二条排队 | `two roots start together` | `turn-scheduler.spec.ts` | `tests/huaanwork-host/turn-scheduler.spec.ts:18` — `two roots start together and the same root queues` |
| 队头根忙时，后面的空闲根先开始 | `drain starts a later free root` | `turn-scheduler.spec.ts` | `tests/huaanwork-host/turn-scheduler.spec.ts:35` — `drain starts a later free root before a busy-root head and does not requeue` |
| 任务绑定丢失后仍按 `header.cwd` 留在项目根 | `fresh project session and lost task binding` | `writable-root.spec.ts` | `tests/huaanwork-host/writable-root.spec.ts:20` — `fresh project session and lost task binding stay on that project` |
| 越界路径回到会话自己的根，不回到前台项目 | `session allowed root rejects the foreground` | `sandbox-cwd.spec.ts` | `tests/huaanwork-guardrails/sandbox-cwd.spec.ts:116` — `a session allowed root rejects the foreground project` |
| 两个会话各用各的模型，删掉的模型不回落全局 | `pinned models stay apart` | `session-models.spec.ts` | `tests/huaanwork-host/session-models.spec.ts:8` — `pinned models stay apart from the global active model` |
| 应答在回合结束前返回；取消不提前释放名额 | `session.send returns before the turn is idle` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:1755` — `session.send returns before the turn is idle and queues a second writer on the same root` |
| 名额只剩 1 时，出队复检失败会让下一个根继续启动 | `a failed queued item releases the cap for the next root` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:1846` — `a failed queued item releases the cap for the next root` |
| 出队在名额用尽时停止 | `drain stops when the cap is full` | `turn-scheduler.spec.ts` | `tests/huaanwork-host/turn-scheduler.spec.ts:48` — `drain stops when the cap is full` |
| 调低上限不取消已执行回合，新发送在新上限下等待 | `cancel removes one queued item and cap drop does not cancel a running turn` | `turn-scheduler.spec.ts` | `tests/huaanwork-host/turn-scheduler.spec.ts:62` — `cancel removes one queued item and cap drop does not cancel a running turn` |
| 一条无人值守记录不回答另一条会话 | `one unattended scope does not answer another session` | `tests/huaanwork-guardrails` | `tests/huaanwork-guardrails/route-tool-plugin.spec.ts:129` — `one unattended scope does not answer another session` |
| 跳过的到期自动化越过 10 分钟宽限仍不记 missed、不停用 | `admission skip survives the missed grace` | `automation-scheduler.spec.ts` | `tests/huaanwork-host/automation-scheduler.spec.ts:620` — `an admission skip survives the missed grace window` |
| 正在跑的标签再发一条仍保持执行中，并记下等待项 | `second send on a running tab` | `concurrentTurn.spec.ts` | `tests/client-huaanwork/concurrentTurn.spec.ts:16` — `a second send on a running tab stays running and records the waiting item` |
| 旧任务没有 `modelId` 仍可读，写入后能读回 | `setTaskModel keeps an existing task` | `stores.spec.ts` | `tests/huaanwork-host/stores.spec.ts:200` — `setTaskModel keeps an existing task readable without the field` |
| 子代理不使执行中的回合数加一 | `a child session does not increment the active turn count` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:1895` — `a child session does not increment the active turn count` |
| 可写根目录已不存在时该次不启动 | `a missing writable root does not start` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:1832` — `a missing writable root does not start` |
| 前台切换后后台会话的根不变 | `foreground switch leaves the background session root` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:2208` — `foreground switch leaves the background session root` |
| 停止一个标签不影响另一个标签 | `stopping one tab leaves the other running` | `concurrentTurn.spec.ts` | `tests/client-huaanwork/concurrentTurn.spec.ts:50` — `stopping one tab leaves the other running` |
| 后台会话的 diff 不写入当前正在查看的标签 | `a background diff stays off the visible tab` | `concurrentTurn.spec.ts` | `tests/client-huaanwork/concurrentTurn.spec.ts:71` — `a background diff stays off the visible tab` |
| 自动化成功占根，释放后同根才能再开始 | `automation start occupies the root` | `turn-scheduler.spec.ts` | `tests/huaanwork-host/turn-scheduler.spec.ts:94` — `automation start occupies the root and release frees it` |
| 尾分隔符和 `..` 与用户准入共用一个写者 | `trailing slash and dotdot share one writer` | `turn-scheduler.spec.ts` | `tests/huaanwork-host/turn-scheduler.spec.ts:127` — `trailing slash and dotdot share one writer across user and automation` |
| 零个或两个占名额写者时不猜 diff 会话 | `sole cap writer is absent at zero and at two` | `turn-scheduler.spec.ts` | `tests/huaanwork-host/turn-scheduler.spec.ts:138` — `sole cap writer is absent at zero and at two` |
| 两张 Map 能赋到真实 Cordis Context 并被另一侧读到 | `context maps assign on a cordis context` | `holders-context.spec.ts` | `tests/huaanwork-host/holders-context.spec.ts:9` — `context maps assign on a cordis context` |
| 同一会话上一项的迟到释放不拆掉下一项 | `a late release from the first turn does not drop the next turn` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:1982` — `a late release from the first turn does not drop the next turn` |
| 只取消等待项时，正在执行的回合和子代理不被取消 | `cancelling a queued item leaves the running turn` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:2024` — `cancelling a queued item leaves the running turn` |
| 排队后的技能和 @ 按原字段重放，并回到原标签 | `a queued skill and at replay on dequeue` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:2053` — `a queued skill and at replay on dequeue` |
| run-once catchup 在同根忙时不执行，释放后才执行 | `catchup waits for the root writer` | `automation-scheduler.spec.ts` | `tests/huaanwork-host/automation-scheduler.spec.ts:418` — `catchup waits for the root writer and the concurrent cap`（`{ timeout: 15_000 }`） |
| 等槽时被停止的脚本会放开根 | `a queued script stopped while waiting for a slot releases its root` | `automations-host.spec.ts` | `tests/huaanwork-host/automations-host.spec.ts:1681` — `a queued script stopped while waiting for a slot releases its root`（`{ timeout: 15_000 }`） |
| 终态落到活动用户消息，不落到后面的等待消息 | `turn final settles the active user message` | `toolPanel.spec.ts` | `tests/client-huaanwork/toolPanel.spec.ts:453` — `turn final settles the active user message` |
| 等待中的用户消息不丢掉活动回合的核对结果 | `a waiting user message does not drop the active outcome` | `outcomeCheck.spec.ts` | `tests/client-huaanwork/outcomeCheck.spec.ts:374` — `a waiting user message does not drop the active outcome` |
| 一个标签的停止票据不占用另一个标签 | `stopping one tab does not consume the other stop ticket` | `concurrentTurn.spec.ts` | `tests/client-huaanwork/concurrentTurn.spec.ts:57` — `stopping one tab does not consume the other stop ticket` |
| 有文本但没有标签时拒绝发送 | `session.send without a tab throws 缺少标签` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:2166` — `session.send without a tab throws 缺少标签` |
| 排队中的创建取消不启动回合 | `a queued creation cancel fails without starting` | `agent-package-creation.spec.ts` | `tests/huaanwork-host/agent-package-creation.spec.ts:595` — `a queued creation cancel fails without starting` |
| 排队中的更新失败不启动回合 | `a queued update failure fails without starting` | `agent-package-creation.spec.ts` | `tests/huaanwork-host/agent-package-creation.spec.ts:623` — `a queued update failure fails without starting` |
| 前台在另一项目时，首建会话在 create 前已登记自己的根，受理后才写模型 | `first project creation keeps its root while another is foreground` | `sessions.spec.ts` | `tests/huaanwork-host/sessions.spec.ts:2225` — `first project creation keeps its root while another is foreground` |
| 自动化根在发送前登记，启动时模型在 followup 受理后绑定且不读后来的全局模型 | `automation binds its startup model after followup` | `automations-host.spec.ts` | `tests/huaanwork-host/automations-host.spec.ts:467` — `automation binds its startup model after followup`（`{ timeout: 15_000 }`） |
| 未启动的发送不把标签标成执行中 | `a send that does not start leaves the tab idle` | `concurrentTurn.spec.ts` | `tests/client-huaanwork/concurrentTurn.spec.ts:28` — `a send that does not start leaves the tab idle` |
| 排队发送不提前清掉上一回合的目标暂停 | `a queued send does not clear the running turn goal window` | `goalRound.spec.ts` | `tests/client-huaanwork/goalRound.spec.ts:285` — `a queued send does not clear the running turn goal window` |
| epoch 和 turn-started 发生在回合真正开始之后 | `queued send opens the goal window only when the turn starts` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:908` — `queued send opens the goal window only when the turn starts` |
| 排队或未启动发送保留正在执行回合的停止闩锁与 epoch | `a queued send preserves the running turn stop latch` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:733` — `a queued send preserves the running turn stop latch` |
| goal active 的中间结束不清执行态，续轮只恢复所属标签 | `a goal intermediate end keeps the tab running` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:800` — `a goal intermediate end keeps the tab running` |
| 旧结束只按事件所属标签的 epoch 判定 | `stale idle uses the event tab epoch` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:829` — `stale idle uses the event tab epoch` |
| 应答后把 queueItemId 写回已插入消息，终态不落等待消息 | `a queued response backfills the inserted user message` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:945` — `a queued response backfills the inserted user message` |
| 已发 notice 的 queue-fail 不重复显示同一 reason | `queue fail does not duplicate the emitted notice` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:995` — `queue fail does not duplicate the emitted notice` |
| 直接 started 应答前的早到结束先缓冲，初始化后重放 | `early session end is buffered until the started response` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:1098` — `early session end is buffered until the started response` |
| waiting 应答前的早到出队先缓冲，写回 id 后重放 | `early queue start is buffered until the queued response` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:1130` — `early queue start is buffered until the queued response` |
| pending 发送不延迟上一回合的结束与停止闩锁 | `pending send does not buffer the previous turn events` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:1151` — `pending send does not buffer the previous turn events` |
| 发送抛错保留正在执行回合的闩锁与终态，显示失败原因并清理 pending | `a rejected send leaves the running turn stop latch` | `appWiring.spec.ts` | `tests/client-huaanwork/appWiring.spec.ts:856` — `a rejected send leaves the running turn stop latch` |

统计：48 行条款、48 条独立 `rg` 命令、**48 次 exit `0`、0 次零命中**。每行的命中行都只是测试声明行（`test(` / `it(`），没有命中注释、跳过包装或辅助函数。

### 3.1 评审 P1-6 / P1-7 的落点

| 评审项 | 规格要求 | 对应条款行 | 测试名 |
|---|---|---|---|
| P1-6 | `session.send` 的应答在「已开始」或「已排队」时返回；`whenIdle` 之后的 `release` 不把应答推迟到回合结束 | 第 7 行 | `session.send returns before the turn is idle`（`sessions.spec.ts:1755`） |
| P1-7 | 因根忙或名额满被跳过的到期项，在跳过期间不记 missed、不停用；10 分钟宽限只用于调度器根本没评估到的到期项 | 第 12 行 | `admission skip survives the missed grace`（`automation-scheduler.spec.ts:620`） |

两条都是「行为被改坏就会红」的具名测试：P1-6 的测试断言 `session.send` 在回合仍 `idle=false` 时已 resolve 出 `{ started: true }` 并在同根排队；P1-7 的测试**不推进注入时钟**，而是把同一任务的到期时间重新 arm 成**已经过去**的时间戳——`automation-scheduler.spec.ts:641` 的 `const lateDue = Date.now() - MISSED_GRACE_MS - 5_000` 与 `:642` 的 `await arm(h.profileDir, due.id, lateDue)`——然后断言仍无 `missed`、任务仍启用（`enabled: true`、`nextRunAt` 仍为该过去时间戳），并在 `h.release()` 释放根之后恰好准入一次（`automation/run-start` 长度 1）。（2026-11-05 Task 12 订正：原文写作「把注入时钟推过 `MISSED_GRACE_MS`」，与该测试的实际手法不符——测试里没有假时钟前移，它靠 `useTick(20)`（只设 `HUAANWORK_AUTOMATION_TICK_MS=20`）让调度器真跑 tick，再把到期时间 arm 成过去时间戳来构造「越过宽限」的情景。）

### 3.2 Step 1 附带的三项核对

**(a) 直接取消与更新失败复用既有测试名。** 两条均命中，且都断言 `started: false` 且不 reject（`await sessionSend(...)` 后 `toEqual`，若 reject 用例即红）：

| 测试名 | 位置 | `started: false` 断言 | 不 reject |
|---|---|---|---|
| `cancel discards the draft, emits the fixed notice, and sends nothing to the model` | `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts:433` | `:452` — `expect(result).toEqual({ queued: true, waiting: false, started: false, sessionId })` | `:450` 直接 `await`，无 `.rejects` |
| `/create-agent update <missing> emits a notice instead of failing the send` | `.../agent-package-creation.spec.ts:554` | `:570` — `expect(result).toEqual({ queued: true, waiting: false, started: false, sessionId })` | `:564` 直接 `await`，无 `.rejects` |

**(b) 每个 `sessionSend(` / `session.send` 都带 `tabId`。** 三个文件逐个清点：

| 文件 | 发送点 | 带 `tabId` | 例外 |
|---|---|---|---|
| `tests/huaanwork-host/sessions.spec.ts` | 12 处直接 `sessionSend(` + 27 处 harness `h.send({…})` = 39 | 38 | `:2170` 唯一无 `tabId`，**这是第 32 行条款的反例用例本身**（`session.send without a tab throws 缺少标签`），按设计必须缺 `tabId` |
| `tests/huaanwork-host/agent-package-creation.spec.ts` | 8 处 `sessionSend(` | 8 | 无 |
| `tests/huaanwork-host/automations-host.spec.ts` | 3 处 `sessionSend(` + 4 处 `handler('session.send')(body({…}), …)` | 7 | 无 |

计数口径（2026-11-05 Task 12 订正）：`sessions.spec.ts` 里 `sessionSend(` 的**文本出现次数是 13**，其中第 13 处（`:1749`）是测试 harness 的包装器本身——`send: async (params) => (await sessionSend(ctx, routeCtx, params))`，它把调用方给的 `params` 原样转发，不构成一个独立的发送点，也不自带 `tabId`。因此发送点 = 12 个直接调用 + 27 个 `h.send({…})` = **39**，带显式 `tabId` = **38**，唯一缺省者仍是 `:2170` 的反例。原先把文本出现次数 13 当作发送点，得出了 40/39 的偏大计数，已按此订正。

**(c) 失败文案仍是原来的原因。** `git diff -U0` 显示这三处负例的断言只补了 `tabId`，断言文案一字未改：

- 网络门禁：`rejects.toThrow(/公网/)`（`sessions.spec.ts:229`）
- 缺文本：`rejects.toThrow(/requires params.text/)`（`sessions.spec.ts:253`）
- 技能不存在：`rejects.toThrow(/未启用或不存在/)`（`sessions.spec.ts:346`）

## 4. Step 2：条款测试

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run \
  tests/huaanwork-host/settings.spec.ts \
  tests/huaanwork-host/turn-scheduler.spec.ts \
  tests/huaanwork-host/writable-root.spec.ts \
  tests/huaanwork-guardrails/sandbox-cwd.spec.ts \
  tests/huaanwork-host/session-models.spec.ts \
  tests/huaanwork-host/sessions.spec.ts \
  tests/huaanwork-host/holders-context.spec.ts \
  tests/huaanwork-guardrails/route-tool-plugin.spec.ts \
  tests/huaanwork-host/automation-scheduler.spec.ts \
  tests/huaanwork-host/automations-host.spec.ts \
  tests/huaanwork-host/stores.spec.ts \
  tests/huaanwork-host/route-contract.spec.ts \
  tests/huaanwork-host/routes.spec.ts \
  tests/huaanwork-host/workspace.spec.ts \
  tests/huaanwork-host/policy-type.spec.ts \
  tests/huaanwork-guardrails/policy.cordis.spec.ts \
  tests/huaanwork-guardrails/question-answerer.spec.ts \
  tests/client-huaanwork/api.spec.ts \
  tests/client-huaanwork/concurrentTurn.spec.ts \
  tests/client-huaanwork/toolPanel.spec.ts \
  tests/client-huaanwork/outcomeCheck.spec.ts \
  tests/client-huaanwork/goalRound.spec.ts \
  tests/client-huaanwork/appWiring.spec.ts \
  tests/huaanwork-host/agent-package-creation.spec.ts
```

**Exit code：`0`**。

```text
 Test Files  24 passed (24)
      Tests  517 passed (517)
   Start at  13:34:07
   Duration  36.95s (transform 3.01s, setup 0ms, import 5.63s, tests 45.68s, environment 1ms)
```

无 failed、无 skipped、无 todo。逐文件实测（24 个文件，合计 517 用例）：

| 文件 | 用例 | 文件 | 用例 |
|---|---|---|---|
| `tests/client-huaanwork/api.spec.ts` | 36 | `tests/client-huaanwork/goalRound.spec.ts` | 17 |
| `tests/huaanwork-host/writable-root.spec.ts` | 10 | `tests/huaanwork-host/route-contract.spec.ts` | 6 |
| `tests/huaanwork-host/stores.spec.ts` | 22 | `tests/client-huaanwork/concurrentTurn.spec.ts` | 8 |
| `tests/huaanwork-guardrails/sandbox-cwd.spec.ts` | 12 | `tests/huaanwork-host/holders-context.spec.ts` | 1 |
| `tests/huaanwork-host/settings.spec.ts` | 28 | `tests/huaanwork-host/policy-type.spec.ts` | 1 |
| `tests/huaanwork-guardrails/question-answerer.spec.ts` | 12 | `tests/client-huaanwork/appWiring.spec.ts` | 52 |
| `tests/huaanwork-guardrails/policy.cordis.spec.ts` | 33 | `tests/huaanwork-host/routes.spec.ts` | 40 |
| `tests/huaanwork-guardrails/route-tool-plugin.spec.ts` | 15 | `tests/huaanwork-host/sessions.spec.ts` | 62 |
| `tests/huaanwork-host/workspace.spec.ts` | 17 | `tests/huaanwork-host/automation-scheduler.spec.ts` | 13 |
| `tests/huaanwork-host/session-models.spec.ts` | 3 | `tests/huaanwork-host/automations-host.spec.ts` | 46 |
| `tests/client-huaanwork/outcomeCheck.spec.ts` | 29 | `tests/huaanwork-host/turn-scheduler.spec.ts` | 9 |
| `tests/client-huaanwork/toolPanel.spec.ts` | 21 | `tests/huaanwork-host/agent-package-creation.spec.ts` | 24 |

**未出现失败，因此没有「保存失败名 + 断言差异」的条目；也没有任何断言被删除、文案被放宽、或跨根测试被改回「跨根不执行」。** 旧调度测试中「`automationTail` 串行全部项目」「跨根到期任务保持 due」的旧断言在此前 Task 8 已按新行为改写，本任务未再动它们（`automation-scheduler.spec.ts` 的 13 用例全绿，含 `a busy foreground channel agent does not keep another project root due`、`a due task on another project root runs there` 等跨根用例）。

## 5. Step 3：相邻套件

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host tests/huaanwork-guardrails tests/client-huaanwork
```

**Exit code：`0`**。

```text
 Test Files  120 passed | 1 skipped (121)
      Tests  1876 passed | 2 skipped (1878)
   Start at  13:34:50
   Duration  38.60s (transform 4.65s, setup 0ms, import 15.11s, tests 94.24s, environment 3.86s)
```

三个目录各自的计数（**分别单独运行三次测得**，因为聚合输出不按目录分组）：

| 目录 | 命令 | Exit | Test Files | Tests | Failed |
|---|---|---|---|---|---|
| `tests/huaanwork-host` | `vitest run tests/huaanwork-host` | **0** | `53 passed \| 1 skipped (54)` | `951 passed \| 2 skipped (953)` | **0** |
| `tests/huaanwork-guardrails` | `vitest run tests/huaanwork-guardrails` | **0** | `19 passed (19)` | `296 passed (296)` | **0** |
| `tests/client-huaanwork` | `vitest run tests/client-huaanwork` | **0** | `48 passed (48)` | `629 passed (629)` | **0** |
| 合计 | — | — | 120 passed + 1 skipped = 121 ✓ | 1876 passed + 2 skipped = 1878 ✓ | **0** |

三行的 `Failed` 均为 **0**：每行汇总形如 `X passed \| Y skipped (Z)` 且 `X + Y = Z`，故不存在 failed 段；三次运行都没有 `FAIL` 行。

**`tests/client-huaanwork` 一行的计数口径（2026-11-05 Task 12 订正）**：`48 / 629` 是 vitest 的**路径子串过滤计数**（命令参数是路径片段 `tests/client-huaanwork`），会把根级文件 `dsh-plugin-huaanwork/tests/client-huaanwork-shell.spec.ts` 一并纳入。该文件是 **1 个文件 / 2 个用例**（`test('layout 已被占用时抛配置冲突(所有权不变量)')`、`test('注册 root slot 并提供 layout service')`）。因此**目录本身**的读数是 `47 passed (47)` / `627 passed (627)`，外加上述根级文件的 1 个文件 / 2 个用例，两者相加才是过滤口径的 `48 / 629`。本表保留过滤口径的原始读数（它才是命令实际输出），但不再把它称作「目录计数」。

三个目录之和与聚合命令的读数**逐项相等**（文件 53+19+48 = 120，跳过 1；用例 951+296+629 = 1876，跳过 2），说明聚合运行没有遗漏或重复计入任何文件。

**跳过项归因（保留原始事实，不记为本功能通过）**：2 个跳过用例都在 `tests/huaanwork-host/market-smoke-live.spec.ts`（`(2 tests | 2 skipped)`），该文件由 `const suite = LIVE ? describe : describe.skip`（`:56`）在未设 `LIVE` 时整文件跳过——这是市场 live 冒烟的环境门，**不是**本功能引入。三个目录的跳过数与 Task 10 的既有基线（`dsh-plugin-huaanwork` 14 skipped）同源，无新增跳过。三个目录本次运行**没有环境性失败**。

## 6. Step 4：HuaAnWork 包全量测试与类型检查（串行，一次一条）

### 6.1 `corepack yarn workspace dsh-plugin-huaanwork test`

**Exit code：`0`**（前一条为 0，才启动下一条）。

```text
 Test Files  276 passed | 4 skipped (280)
      Tests  3718 passed | 14 skipped (3732)
   Start at  13:36:35
   Duration  39.35s (transform 10.23s, setup 0ms, import 26.40s, tests 124.20s, environment 6.07s)
```

4 个跳过文件与 14 个跳过用例的归因（全部环境门，且这些文件**不在本功能的改动集内**，`git status --short` 对它们零命中）：

| 跳过文件 | 标记 | 原因 |
|---|---|---|
| `tests/windows-console-host.spec.ts` | `(2 tests \| 2 skipped)` | `describe.runIf(process.platform === 'win32')`（`:61`） |
| `tests/host-liveness-win.spec.ts` | `(1 test \| 1 skipped)` | `it.skipIf(process.platform !== 'win32')`（`:164`） |
| `tests/huaanwork-migration-smoke.spec.ts` | `(1 test \| 1 skipped)` | `const describeLive = LIVE ? describe : describe.skip`（`:51`） |
| `tests/huaanwork-host/market-smoke-live.spec.ts` | `(2 tests \| 2 skipped)` | `const suite = LIVE ? describe : describe.skip`（`:56`） |

（4 个文件合计 6 个跳过用例；其余 8 个来自**通过文件内**的条件跳过声明，全部 8 处逐一列明——`it.runIf(process.platform === 'win32')` / `it.skipIf(process.platform !== 'win32')` / `it.runIf(executable !== undefined)` 三种形态：`tests/package.spec.ts:494`、`tests/desktop-runtime-environment.spec.ts:247`、`:389`、`:434`、`:645`、`tests/safe-mode.spec.ts:250`、`tests/shell-environment.spec.ts:136`、**`tests/windows-volume-diagnostics.spec.ts:15`**；6 + 8 = 14，与汇总行一致。2026-11-05 Task 12 订正：原文写「其余 8 个」但只枚举了 7 处，漏掉 `tests/windows-volume-diagnostics.spec.ts:15` 的 `it.runIf(process.platform === 'win32')('queries the host volume through Windows APIs', …)`——该处 1 个跳过用例，补齐后枚举与计数相符。）14 与既有基线（Task 10/14/15 记录的 `14 skipped`）相同，**无新增跳过**。

### 6.2 `corepack yarn workspace dsh-plugin-huaanwork typecheck`

**Exit code：`0`**，输出为空（无任何诊断行）。`max_concurrent_turns`、`TaskInfo.modelId`、`huaanworkUnattended` 的 Map、`huaanworkSessionModels`、`huaanworkSessionRoots`、`session.send` 的新返回字段**均无类型错误**，因此不存在「已知例外」条目。

## 7. 未执行 / 未验证项与 root 门禁结果（不得视为通过）

| 项 | 状态 |
|---|---|
| root `corepack yarn test` | **已执行（Task 12，2026-11-05）：exit `0`**，12 个 workspace 全绿、0 失败用例（§11.1） |
| root `corepack yarn typecheck` | **已执行（Task 12）：exit `0`**，无诊断（§11.2） |
| root `corepack yarn check` | **已执行（Task 12）：exit `1`**，停在 `dsh-plugin-huaanwork` 的 `verify:host`，35 个用例 7 个失败（§11.3）。**这是红灯，不得记为通过**。Task 12b（2026-11-05 14:05–14:27）对齐测试契约后**复跑 exit `0` 全链通过（§12.4）**；首次 exit 1 的历史记录保留在 §11.3 |
| 图形界面 | **尚未走查**：本任务全程 headless，没有启动应用、没有点击/键盘操作、没有截图 |
| Windows / Linux 平台行为 | 本机 darwin，Windows 用例按 `platform` 门跳过（§6.1）；未在 Windows 机器上验证 |
| 打包与发行制品校验（`dist:mac`、`dist:win` 等） | 未执行（不在本任务范围） |
| CI（GitHub Actions） | 未执行（本轮为本地命令） |
| `market:check` / `aa:check` 远端新鲜度 | 未单独执行。Task 12 的 root `check` 里包含 `verify:aa`（会跑 AA 运行时准备），但 `&&` 链停在 `verify:host`，故该步**没有运行**（§11.3） |
| 提交 | 按用户策略**未提交**，未执行 Step 6 的 `git add` / `git commit`；Task 12 同样未提交 |

**局部文件通过 ≠ workspace 通过 ≠ root 通过。** 本文的 `517` / `1876` / `3718` 三个读数分别只覆盖 Step 2 的 24 个 spec、三个测试目录、以及 `dsh-plugin-huaanwork` 一个 package。Task 12 已补跑 root 三条命令：`test` exit `0`、`typecheck` exit `0`、`check` exit **`1`**（§11.3，停在 `verify:host`）。**图形界面走查仍然是空白**：全程 headless，没有启动应用、没有点击/键盘操作、没有截图。

## 8. 工作树核对（Step 5）

```bash
git status --short   # exit 0；写本文件之前 71 条（54 已修改 + 17 未跟踪），写完之后 72 条
git diff --check     # 无输出，exit 0
```

- 写本文件之前取的基线是 **71 条**（`STATUS_EXIT=0`）：Tasks 1–10 的既有改动与未跟踪新文件，本任务的四条测试命令没有新增或删除任何条目。**本任务未在开始时另取基线**，故不对「与 Task 11 开始前完全一致」作断言——可断言的是：在本任务所有测试命令跑完、写文档之前的那一刻，状态为 71 条。
- 写完之后为 **72 条**，与基线的 `diff` 只多一行：`?? docs/evidence/2026-11-03-concurrent-project-turns-verification.md`。
- 未跟踪条目里 **`.gstack/`、`.qoder/` 是用户既有工具/会话目录，不属于本功能**，不在任何功能提交路径内。其余未跟踪项（2026-11-05 Task 12 订正后的完整清单）：计划/规格 **5 份**——本功能 4 份（`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`、`docs/superpowers/plans/2026-11-03-concurrent-project-turns-plan-review.md`、`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`、`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design-review.md`），外加 **1 份与本功能无关**的既有未跟踪文档 `docs/superpowers/plans/2026-10-31-single-desktop-maintenance-code-review.md`；功能源码 **4 个**（`src/huaanwork-host/{turn-scheduler,writable-root,session-models}.ts`、`src/client-huaanwork/logic/concurrentTurn.ts`）；功能 spec **6 个**（`tests/huaanwork-host/{turn-scheduler,writable-root,session-models,holders-context}.spec.ts`、`tests/client-huaanwork/{concurrentTurn,settings}.spec.ts`）。计数核对：**2（工具目录）+ 5（计划/规格）+ 4（源码）+ 6（spec）= 17**，与写本文档之前的 17 条未跟踪**逐项相符**。（原文写「计划/规格 4 份」并给出 `2+4+4+6 = 16`，与 17 条不符：漏掉的是上面那份与本功能无关的 2026-10-31 计划文档。）本证据文档本身是写了之后才出现的第 18 条未跟踪，见上一条。
- `git diff --check` 为**空输出且 exit 0**（该命令只覆盖已跟踪文件，未跟踪的本证据文档不在其范围内；`check:whitespace` 同口径）。为此对未跟踪的本文件补做了行尾空白/制表符扫描：0 命中。

## 9. 日志指针

完整原始日志（临时目录，重启后可能被清理；命令与摘录足以重放）：

| 文件 | 内容 |
|---|---|
| `/tmp/task11-step2.log` | Step 2 的 24 个条款 spec 完整输出（ANSI 原样） |
| `/tmp/task11-step2.clean.log` | 同上，去除 ANSI 的可读副本 |
| `/tmp/task11-step3.log` | Step 3 聚合命令（三目录）完整输出 |
| `/tmp/task11-step3-host.log` / `-guardrails.log` / `-client.log` | Step 3 三个目录各自的单独运行输出 |
| `/tmp/task11-step4-test.log` | 包全量 `test` 输出 |
| `/tmp/task11-step4-typecheck.log` | 包 `typecheck` 输出（空） |
| `/tmp/task11-status-pre.txt` | 写本文件前的 `git status --short`（71 条） |
| `/tmp/task12-step1-root-test.log` | Task 12 root `test` 完整输出（12 个 workspace 汇总行） |
| `/tmp/task12-step2-root-typecheck.log` | Task 12 root `typecheck` 输出（一行） |
| `/tmp/task12-step3-root-check.log` | Task 12 root `check` 完整输出（停在 `verify:host`，含 7 个失败详情） |
| `/tmp/task12-step3-exit.txt` | 上述 `check` 的 exit code（`EXIT=1`） |
| `/tmp/task12b-red.log` | Task 12b 修改前单跑 host-loop spec 完整输出（7 fail） |
| `/tmp/task12b-green.log` | Task 12b 修改后单跑 host-loop spec 完整输出（14 pass） |
| `/tmp/task12b-verify-host.log` | Task 12b `verify:host` 完整输出（35 pass） |
| `/tmp/task12b-root-check.log` / `/tmp/task12b-root-check.exit` | Task 12b root `check` 完整输出与 exit code（`EXIT=0`） |

**关于 `/tmp/task12-*`（首次执行临时日志，2026-11-05 Task 12b 实测注记）**：Task 12 的这些日志**在 Task 12b 续作时仍存在于 /tmp**（`/tmp/task12-step1-root-test.log` 等 9 个文件，时间戳 13:50–13:53，与 §11 记录时段一致），与 Task 12b  brief 成文时的预期（「续作时已清理」）不符；实测以本注记为准。它们仍是**首次执行的临时日志**，随时可能被系统清理，完整读数以本文 §11 文本为准，不以日志可读取为前提。

## 10. 诚实性说明

- 所有 exit code 都是实际观察值；`Test Files` / `Tests` 汇总行是从日志原文摘录的，没有改写或四舍五入。
- **零命中条款 0 条**，因此本任务没有补写任何测试、没有修改任何断言或产品文案；`git add` / `git commit` 未执行（Step 6 的前置条件「本任务产生了回归修复」不成立）。
- `HEAD` = `fdcf804…` 不含本功能改动；被验证的行为来自未提交的工作树，这与本功能「提交步骤仅在用户明确要求时执行」的约束一致。
- 跳过项按原样保留并逐条归因（§5、§6.1），**没有把任何环境性跳过或未执行项记作通过**。
- Step 3 的「三个目录各自计数」是**额外单独运行三次**得到的；聚合命令本身是 Step 3 规定的那一条，两者的读数互相校验一致（§5）。
- Task 11 未执行 root 门禁。Task 12（2026-11-05，§11）补跑后的真实状态：root `test` exit `0`、root `typecheck` exit `0`、root `check` exit **`1`**（停在 `dsh-plugin-huaanwork` 的 `verify:host`）。**root `check` 是红的**，任何引用本文的地方都不得把本分支写成「root 门禁通过」或「全部通过」。
- **图形界面尚未走查**（Task 11 与 Task 12 全程 headless）：没有启动应用、没有点击/键盘操作、没有截图；该条在任何引用中都不得被改写为「已走查」。Task 12 的 `verify:host` 失败也**不能**被当作图形走查的替代证据。

## 11. Task 12：root 门禁实测（2026-11-05）

三条 root 命令**严格串行、一次一条**：前一条 exit 0 才启动下一条，任何时刻只有一条门禁在跑（`corepack yarn check` 内含 `verify:aa`，与仓库既有并发冲突条款一致）。工作树与 §2 相同：`HEAD` = `fdcf80422ed2626d89def9c18a769ef465b3d8a5`（不含本功能改动），Tasks 1–10 的改动仍未提交；`deepseek-harness/` 未被触碰，未新增依赖；全程无 `git add` / `git commit` / `git stash` / `git restore` / `git clean`。

### 11.1 Step 1：`corepack yarn test`

**Exit code：`0`**。

执行说明（诚实记录）：第一次调用时 exit code 被 shell 管道吞掉（zsh 下 `PIPESTATUS` 为空，打印出 `EXIT=`），因此**原样重跑一次**以取得真实 exit code；两次运行的所有汇总行逐字相同。下表是重跑（即取 exit code 的那一次）的读数。

root `test` 脚本串联 12 个 workspace，逐个汇总行（顺序 = `package.json` 中 `test` 脚本顺序；vitest 与 `node --test` 两种运行器混排）：

| # | workspace | 运行器 | 汇总行 |
|---|---|---|---|
| 1 | `dsh-plugin-huaanwork` | vitest | `Test Files 276 passed \| 4 skipped (280)`；`Tests 3718 passed \| 14 skipped (3732)` |
| 2 | `dsh-community-market` | vitest | `Test Files 13 passed (13)`；`Tests 303 passed (303)` |
| 3 | `@huaanwork/policy` | node:test | `# tests 64`、`# pass 62`、`# fail 0`、`# skipped 2` |
| 4 | `@huaanwork/model` | node:test | `# tests 10`、`# pass 10`、`# fail 0`、`# skipped 0` |
| 5 | `@huaanwork/git-tools` | node:test | `# tests 8`、`# pass 8`、`# fail 0`、`# skipped 0` |
| 6 | `@huaanwork/web-tools` | node:test | `# tests 19`、`# pass 19`、`# fail 0`、`# skipped 0` |
| 7 | `market-server` | vitest | `Test Files 14 passed (14)`；`Tests 244 passed (244)` |
| 8 | `update-server` | vitest | `Test Files 5 passed (5)`；`Tests 88 passed (88)` |
| 9 | `@huaanwork/catalog-signing` | node:test | `# tests 13`、`# pass 13`、`# fail 0`、`# skipped 0` |
| 10 | `@huaanwork/agent-package-format` | node:test | `# tests 35`、`# pass 35`、`# fail 0`、`# skipped 0` |
| 11 | `agent-catalog-server` | vitest | `Test Files 5 passed (5)`；`Tests 80 passed (80)` |
| 12 | `agent-catalog-admin` | node:test | `# tests 15`、`# pass 15`、`# fail 0`、`# skipped 0` |

**没有失败用例**，因此没有「失败用例的完整名称」可记：每个 vitest 汇总行都没有 `failed` 段，每个 `node --test` 汇总块都是 `# fail 0`。

算术合计（本文自行相加，**不是任何一条汇总行**）：vitest 侧 313 个文件通过 + 4 跳过 = 317，4433 个用例通过 + 14 跳过 = 4447；`node --test` 侧 164 个用例，162 pass / 2 skipped / 0 fail；两侧合计 **4595 passed、16 skipped、0 failed**。

交叉校验：第 1 行的 `dsh-plugin-huaanwork` 读数（`276 passed | 4 skipped`、`3718 passed | 14 skipped`）与 Task 11 §6.1 的同一条命令**逐字相同**，说明本功能在 root 串联下没有改变包级读数。

### 11.2 Step 2：`corepack yarn typecheck`

**Exit code：`0`**。root `typecheck` 串联 8 个 workspace 的 `tsc`，全部无诊断；整个命令只有一行输出：

```text
contract-types: 4 generated type files are current
```

没有失败全文可留（无任何诊断行）。

### 11.3 Step 3：`corepack yarn check`

**Exit code：`1`**。

**停止位置：`dsh-plugin-huaanwork` 的 `check` 脚本中的 `verify:host`**（该步命令为 `node --test --test-force-exit scripts/huaanwork-host-*.spec.mjs`）。

在此之前的步骤全部 exit 0（root `check` 是 `&&` 链，能跑到 `verify:host` 即证明前序都通过），可复核的片段：root 的 `check:whitespace`、`check:layout`（`verify-bilingual-docs: 50 records and 100 documents are consistent`、`verify-market-dependency-direction: 443 tracked source files …`、`verify-layout: HuaAnWork and retained workspaces are consistent with upstream 1600d8a1e1`、`verify-readme-versions: 4 hardcoded artifact version string(s) …`）、`test:aa-connector`、`dsh-community-fabric check`（`verify-fabric-docs: 20 Markdown files and 10 bilingual pairs are consistent`）、`dsh-community-market check`（build、`verify-package-exports: 4 type exports exist`、`verify-market-client-loader: … registered one client module`、其 tests 全绿），以及 `dsh-plugin-huaanwork` 的 `build`（`contract-types: 4 generated type files written`）→ `typecheck` → `test`（即 §11.1 第 1 行那一次）→ `verify:closure`（`verify-runtime-closure: 316 first-party nodes form a closed reachable runtime graph.`）→ `verify:bundled`（`verify-bundled-runtime: 134 files checked; 9 bundled packages are inlined; tar is compiled into lib`）→ `verify:cli` → `verify:loader`（这两步在日志里没有可见输出，但 `&&` 链已经越过它们并跑完 `verify:profile`，故两者 exit 均为 0）→ `verify:profile`（`verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`）。

`verify:host` 共 35 个用例（TAP `1..35`），**28 pass / 7 fail / 0 skipped**。7 个失败**全部**在 `scripts/huaanwork-host-loop.spec.mjs`，分两类：

| # | 用例（原文） | 声明行 | 断言错误（原文首行） |
|---|---|---|---|
| 1 | `文本回合:token 帧 + session/end ok + 会话列表标题非空` | `:485` | `POST /huaanwork/session/send -> HTTP 400: {"error":{"code":"session-error","message":"session.send 缺少标签"}}` |
| 2 | `工具审批 approve:approval/asked → approve → tool/start → tool/end → session/end ok` | `:508` | 同上 |
| 3 | `工具审批 reject:拒绝后工具不执行,回合以拒绝收尾(不崩、不挂起)` | `:533` | 同上 |
| 5 | `session.cancel:挂起回合被取消收尾,进程不挂` | `:564` | 同上 |
| 10 | `scheduler:run-once catchup 同根入队,跨根顺延不入队` | `:703` | `cross-root catchup stays pending`（断言 `nextRunAt` 仍等于旧时间戳，实际已被推进） |
| 13 | `scheduler:同根 due 按 projectId 分组,跨根与中立顺延,项目已删除仍执行` | `:831` | `cross-root due stays queued`（断言跨根任务 `runs.length === 0`，实际已执行） |
| 14 | `scheduler:generation 重启补 cancelled,中立根上的中立任务会执行` | `:881` | `project task defers on the neutral root`（断言中立根上的项目任务未执行，实际已执行） |

**这是功能性门禁失败，不是环境失败**（不涉及 npm / 网络 / market / Agents Anywhere 的环境面）。归因可复核：该 spec 文件里 `tabId` 的命中数为 **0**，四处 `session/send` POST（`:487`、`:510`、`:535`、`:566`）都不带 `tabId`，直接命中本功能新增的强制校验；另三处断言（`:754` 的 `cross-root catchup stays pending`、`:861` 的 `cross-root due stays queued`、`:932` 的 `project task defers on the neutral root`）写的是**旧语义**「跨根顺延、不执行、不入队」，与本功能「两个项目根并发执行」的正向行为正好相反。即：**本功能的行为改动没有同步到 `verify:host` 这个既有 smoke 门禁**，它因此成为本分支 root 门禁的红灯。

按 Task 12 的边界，**没有为此修改任何产品代码或测试**（本任务只改本证据文档）；失败原样记录于此，并已向上报告为需要后续任务处置的红灯。

`verify:host` 之后**没有运行**的步骤（均属「未执行」，不得视为通过）：`verify:aa`、`verify:licenses`、`verify:operations`，以及 root 的 `market-server` / `update-server` / `@huaanwork/catalog-signing` / `@huaanwork/agent-package-format` / `agent-catalog-server` / `agent-catalog-admin` 六个 `check`（`&&` 链在 `verify:host` 处中断）。

### 11.4 工作树核对

```bash
git diff --check     # exit 0，无输出
git status --short   # exit 0；72 条 = 54 已修改 + 18 未跟踪
```

Task 12 只改了本证据文档，而它本来就是未跟踪文件，因此条目总数仍是「写本文档之后」的 72 条，未跟踪清单与 §8 记录的 18 条逐项相同（`.gstack/`、`.qoder/`、6 份 `docs/` 文档、4 个功能源码、6 个功能 spec）。没有 `git add` / `git commit` / `git stash` / `git restore` / `git clean`。

## 12. Task 12b：host 冒烟契约对齐 + root 门禁复跑（2026-11-05 14:05–14:27）

Task 12b 处置 §11.3 登记的红灯。第一条 git 命令为 `git branch --show-current`（输出 `feat/huaanwork-concurrent-project-turns`，通过守卫）。全程**只允许**改 `dsh-plugin-huaanwork/scripts/huaanwork-host-loop.spec.mjs` 与本证据文档；未触碰 `deepseek-harness/`，未新增依赖，未启动图形界面，无 `git add` / `git commit` / `git stash` / `git restore` / `git clean`。这是**测试契约对齐，不是放宽验收**：没有删除任何断言、没有改成永真断言、没有跳过测试、没有改产品代码。

### 12.1 根因

`scripts/huaanwork-host-loop.spec.mjs` 是既有 root 冒烟门禁（M3 出口证据），Tasks 1–10 的并发改造**没有同步更新它**（§11.3 已归因）：① 4 处 `session/send` POST 不带 `tabId`，命中本功能新增的强制校验（`sessions.ts:785` 抛 `session.send 缺少标签` → HTTP 400）；② 3 则断言仍写**旧跨根语义**（跨根 catchup 滞留 / 跨根到期排队 / 项目任务在中立根前台上推迟），与本功能「不同已登记项目根并发执行、同根后续写者排队」的正向行为相反。已评审的新契约对照：`tests/huaanwork-host/automation-scheduler.spec.ts`（跨根补跑执行并推进、跨根到期在所属根执行、中立任务不再被前台滞留）、`tests/huaanwork-host/sessions.spec.ts:2166`（无 `tabId` 拒绝）、`tests/huaanwork-host/automation-scheduler.spec.ts:397`（已删项目仍执行并记 `MISSING_PROJECT_OUTPUT` 失败）。产品行为本身已被 Task 11 的 48 条条款测试与 §4/§5/§6 全量测试覆盖，本条目不重复证明。

### 12.2 修改的测试与 RED/GREEN

只改 `scripts/huaanwork-host-loop.spec.mjs` 一个文件（`git diff --stat`：**72 insertions / 42 deletions**），七处：

| # | 用例（新名） | 改动 |
|---|---|---|
| 1 | `文本回合:token 帧 + session/end ok + 会话列表标题非空` | POST 补 `tabId: 'tab-text'`；应答按新契约改断言 `{ queued: true, waiting: false, started: true }` + `sessionId` 为 string（对照 `sessions.ts:836`） |
| 2 | `工具审批 approve:…` | POST 补 `tabId: 'tab-approve'`；`sent` 同样改新契约断言 |
| 3 | `工具审批 reject:…` | POST 补 `tabId: 'tab-reject'`；`sent` 同样改新契约断言 |
| 4 | `session.cancel:挂起回合被取消收尾,进程不挂` | POST 补 `tabId: 'tab-cancel'`；`sent` 同样改新契约断言（hang 剧本在 followup 受理后挂起 SSE，`started: true` 成立） |
| 5 | `scheduler:run-once catchup 同根与跨根各自补跑一次并推进,各自恰好广播一次 missed`（原「同根入队,跨根顺延不入队」） | 跨根脚本命令由 `echo should-not-run` 改为如实命名 `echo catchup-cross-ran`；旧「滞留」断言改为：跨根 catchup 在所属项目根 `run-end ok`、`trigger: 'catchup'`、`nextRunAt` 推进过旧槽、`enabled: true`、`missed` 恰好一次、`run-start` 恰好一次（对照 `automation-scheduler.spec.ts:296-331` 的跨根 remote 用例） |
| 6 | `scheduler:同根 due 按可写根串行,跨根与中立到期并发执行,项目已删除仍执行并记失败`（原「按 projectId 分组,跨根与中立顺延」） | 旧「跨根/中立排队滞留」断言改为：`b-1`（跨根）与 `n-1`（中立）各自执行并推进 `nextRunAt`；`a-1`→`a-2` 同根串行（`firstA1 < firstA2`，由调度器准入保证，不依赖时序睡眠）；`m-1`（已删项目）仍执行且 `ok: false`、输出含「任务所属项目不存在」；事件序断言只取 `run-start` 的确定性先后，不用 sleep 掩盖竞态 |
| 7 | `scheduler:generation 重启补 cancelled,中立任务与项目任务各自在所属根执行`（原「中立根上的中立任务会执行」） | 旧「project-due 在中立根上推迟（runs=0、nextRunAt 不变）」断言改为：前台回到中立根后 `project-due` 仍在**所属项目根**执行，`output` 含 `project-due`、`nextRunAt` 推进、`enabled: true`；`residual-1` cancelled 补录与 `neutral-due` 执行断言保留不变 |

RED（修改前，2026-11-05 14:05 起，单跑该文件）：

```bash
cd dsh-plugin-huaanwork && corepack yarn exec node --test --test-force-exit scripts/huaanwork-host-loop.spec.mjs
# 等价于 verify:host 对该文件的调用形态；完整输出 /tmp/task12b-red.log
```

**Exit code：`1`**。`# tests 14 / # pass 7 / # fail 7 / # skipped 0`，7 个失败与 §11.3 记录的 Task 12 首次失败**逐项相同**（用例 1/2/3/5 的 HTTP 400 `session.send 缺少标签` ×4；用例 10 `cross-root catchup stays pending`；用例 13 `cross-root due stays queued`；用例 14 `project task defers on the neutral root`）。

GREEN（修改后，同一命令）：

**Exit code：`0`**。`# tests 14 / # pass 14 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`（完整输出 `/tmp/task12b-green.log`；修改后第一次运行即通过，无重跑）。

### 12.3 `verify:host`

```bash
corepack yarn workspace dsh-plugin-huaanwork verify:host
```

**Exit code：`0`**。`# tests 35 / # pass 35 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`（`scripts/huaanwork-host-*.spec.mjs` 三个文件合并 TAP：host-loop 14 + restart/windows acceptance 21；完整输出 `/tmp/task12b-verify-host.log`）。

### 12.4 root `corepack yarn check` 复跑（严格串行）

单独运行，任何时刻无其他门禁并行。**Exit code：`0`**（`/tmp/task12b-root-check.exit`；完整输出 `/tmp/task12b-root-check.log`）。

可复核的通过片段（顺序即 `check` 链）：root `check:whitespace` / `check:layout` → `test:aa-connector` → `dsh-community-fabric check` → `dsh-community-market check` → `dsh-plugin-huaanwork` 的 `build`（`contract-types: 4 generated type files written`）→ `typecheck` → `test`（`Test Files 276 passed | 4 skipped (280)`；`Tests 3718 passed | 14 skipped (3732)`，与 §6.1/§11.1 逐字相同）→ `verify:closure`（`316 first-party nodes … closed`）→ `verify:bundled`（`134 files checked`）→ `verify:cli` → `verify:loader` → `verify:profile`（`minimal preset, plugin manager, and disabled hmr lock passed`）→ **`verify:host`（`# tests 35 / # pass 35 / # fail 0`，日志 `:1220` 段）** → `verify:aa` → `verify:licenses`（`636 packages checked (9 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)`）→ `verify:operations`（`7 operations and 18 fault contracts verified`）→ root 的 `market-server`（`Test Files 14 passed`）/ `update-server`（`Test Files 5 passed`）/ `@huaanwork/catalog-signing`（`# tests 35 / # pass 35`）/ `@huaanwork/agent-package-format`（`# tests 15 / # pass 15`）/ `agent-catalog-server`（`Test Files 5 passed`）/ `agent-catalog-admin` 六个 `check` 全绿。**没有 npm / 网络 / market / Agents Anywhere 环境失败。**

Task 12 时因 `&&` 链中断而未运行的 `verify:aa` / `verify:licenses` / `verify:operations` 与六个下游 workspace `check`，本次**全部真实执行并通过**。

### 12.5 工作树核对

```bash
git diff --check     # exit 0，无输出
git status --short   # exit 0；73 条 = 55 已修改 + 18 未跟踪
```

与 Task 12 末态（72 条）相比，唯一增量是 **` M dsh-plugin-huaanwork/scripts/huaanwork-host-loop.spec.mjs`**（在允许范围内）；本证据文档仍属未跟踪，未跟踪清单 18 条逐项不变。`git diff --check` 覆盖的已跟踪文件中只有上述 spec 的改动，无越界改动。

### 12.6 未执行项与诚实性

| 项 | 状态 |
|---|---|
| 图形界面 | **仍未走查**：Task 12b 全程 headless，没有启动应用、没有点击/键盘操作、没有截图 |
| Windows / Linux 平台行为 | 本机 darwin；root `check` 中 win32 用例按 `platform` 门跳过（与 §6.1 同口径） |
| CI（GitHub Actions） | 未执行（本轮为本地命令） |
| 打包与发行制品 | 未执行（不在范围） |
| 提交 | 未提交（用户未要求），无 `git add` / `git commit` |

诚实性：§11.3 的 Task 12 首次 root `check` exit 1 记录**原样保留**，本节是**追加**而非改写；root `check` 的「最新复跑 exit 0」只写在本节与 §1 表格的新增行。跳过项按原样保留，未记为通过。

## 13. Task 13：场景走查（2026-11-05 14:42 起，追加）

Task 13 brief：`.superpowers/sdd/2026-11-03-concurrent-project-turns/task-13-brief.md`。本条目的第一条 git 命令为 `git branch --show-current`（输出 `feat/huaanwork-concurrent-project-turns`，通过守卫）。全程**只允许**改本证据文档（本节的追加）；未触碰 `deepseek-harness/`、产品代码、测试与依赖，未新增或修改任何其他文件；全程无 `git add` / `git commit` / `git stash` / `git restore` / `git clean`。

### 13.1 Step 1 守卫：未启动图形界面

用户**没有明确同意图形启动**，因此：

- **未执行** `corepack yarn dev`，**未启动任何应用**；
- 没有点击、键盘操作、截图，没有任何场景动作被执行；
- 按 Task 13 Step 1，Step 2–4 的全部 12 个子场景一律标为 **`未验收`**，原因统一为「未启动图形界面，未执行场景动作」；
- **未把 Task 11 的 Vitest 结果、Task 12/12b 的 root 门禁通过抄入任何场景格子**——headless 门禁通过不构成任何场景项的验收证据；
- 本任务不声称「真实 UI」验证，也不声称发布就绪；§7 / §12.6 的「图形界面未走查」状态经本节后仍成立，本条目是登记而非消除该状态。

### 13.2 Step 2–4 场景结果

结果标签取值（Task 13 brief 的 `Produces` 口径）：`真实 UI` / `headless 已覆盖` / `未验收`。本节 12 行全部为 `未验收`；「实际看到的文案与文件结果」列均为「无」——没有任何界面文案、标签状态或文件内容被观察到。

| 步骤 | 子场景 | 结果标签 | 未验收原因 | 实际看到的文案与文件结果 |
|---|---|---|---|---|
| Step 2 | 2.1 项目 A 发送「把 a.txt 改成 A」，生成开始后文件树仍停在 A 时打开项目 B | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 2 | 2.2 项目 B 发送「把 b.txt 改成 B」，A 的回合未结束时 B 标签出现自己的执行状态且输入框为空 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 2 | 2.3 回到 A：A 的差异仍是 `a.txt` 而非 `b.txt`，B 的标签不被 A 的差异覆盖 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 2 | 2.4 两边都结束后，`a.txt` 只在 A 的目录变化，`b.txt` 只在 B 的目录变化 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 3 | 3.1 A 的第一条仍在执行时发第二条，第二条显示「等待当前任务」、输入框被清空且可继续打字 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 3 | 3.2 停止第一条：第二条在第一条真正结束后才开始；按下停止的瞬间第二条不得已经开始改文件 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 3 | 3.3 第一条执行中、第二条等待时只取消第二条：第一条继续跑，第二条从列表消失 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 3 | 3.4 把「同时进行的任务数」改成 1：在跑的回合不被取消，此时 B 的发送显示等待；改回 3 后 B 在有空额时开始且不需要重新输入 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 4 | 4.1 A、B 各选一个不同的已保存模型并发送后，把设置里的当前模型改成第三个：A、B 已开始的回合仍用各自选中的模型，记录两侧界面或请求里的模型名 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 4 | 4.2 删掉 A 排队条所绑定的模型：轮到它时 A 的标签显示失败原因；B 若根空闲且名额够，仍能开始 | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 4 | 4.3 A 上有会调用模型的到期自动化且 A 有用户回合：自动化不开始、不在超过 10 分钟后变成错过或被停用；B 在名额允许时仍能手动跑自己的自动化，前台项目名不因此从 A 跳到 B | 未验收 | 未启动图形界面，未执行场景动作 | 无 |
| Step 4 | 4.4 未绑定项目的会话里工具路径指向项目 A 的文件：结果文件出现在中立工作区，不出现在 A | 未验收 | 未启动图形界面，未执行场景动作 | 无 |

以上 12 行的状态在任一后续引用中**不得**被改写为「已通过」；只有当用户明确同意图形启动（`corepack yarn dev`）并逐项实际执行 Step 2–4 后，才可能按观察结果更新对应行。

### 13.3 Step 5：条件式提交

Task 13 brief 的提交条件是「仅当用户明确要求提交」。用户**未要求**，因此未执行 `git add docs/evidence/2026-11-03-concurrent-project-turns-verification.md` / `git commit -m "docs: record concurrent project turn scenario acceptance"`，与全功能一贯的提交策略一致（§7、§10、§11.4、§12.5、§12.6）。

### 13.4 工作树核对

```bash
git diff --check     # exit 0，无输出
git status --short   # exit 0；73 条 = 55 已修改 + 18 未跟踪，与 §12.5 末态相同
```

本节写作前的基线核对（2026-11-05 14:42）：与 Task 12b 末态（§12.5 记录的 73 条 = 55 已修改 + 18 未跟踪）**逐项相同**，`git rev-parse HEAD` = `fdcf80422ed2626d89def9c18a769ef465b3d8a5` 不变；本节只对本证据文档做内容追加（该文档自 Task 11 起即为未跟踪文件，条目数不变），无其他已跟踪文件被修改，无越界改动。`git diff --check` 只覆盖已跟踪文件，本证据文档不在其范围内，故对本节追加段落另行做了行尾空白/制表符扫描：0 命中。

## 14. 最终整支评审修复（2026-11-05 15:10–15:45，追加）

最终评审（评审包 `review-fdcf80422e..577ad75863.diff`）确认两个 Important merge blocker，本节是 brief（`.superpowers/sdd/2026-11-03-concurrent-project-turns/final-fix-brief.md`）规定的唯一集中修复波次。本条目的第一条 git 命令为 `git branch --show-current`（输出 `feat/huaanwork-concurrent-project-turns`，通过守卫）。**全程只允许改** brief 列出的 7 个文件：`src/client-huaanwork/App.tsx`、`tests/client-huaanwork/appWiring.spec.ts`、`src/huaanwork-host/sessions.ts`、`src/huaanwork-host/turn-scheduler.ts`、`tests/huaanwork-host/turn-scheduler.spec.ts`、`tests/huaanwork-host/sessions.spec.ts`（均在 `dsh-plugin-huaanwork/`）与本证据文档；实际改动面与之一致。未触碰 `deepseek-harness/`，未新增依赖，未启动 GUI，无任何 `git add` / `commit` / `push` / `stash` / `restore` / `clean`。最终评审列出的 Minor（cancel/dequeue ghost turn、queueItemId 无 ownership 校验等 8 项）按 brief 维持 follow-up，本波次未展开。

### 14.1 两个 finding 与修复点

**Important 1：跨标签同会话 pending 缓冲吞掉正在执行回合的结束。** `App.tsx` 的 `holdEarlyEvent` 原只对「pending 自己的标签正在运行该 session」跳过缓冲；标签 A 运行会话 S、标签 B 也绑定 S 并发送时，A 的 `session/end` 在 B 的 pending 窗口到达会被缓冲，而 B 的 waiting 应答只重放匹配 `queueItemId` 的队列事件，A 的结束被丢弃、A 永久 running。修复（`App.tsx` `holdEarlyEvent`，goal/session-end 分支）：在既有本标签守卫之后、缓冲 push 之前新增跨标签守卫——`const turnTab = turnTabForSession(sessionId); if (turnTab !== undefined && tabRunOf(turnTab).running && tabTurnOf(turnTab).sessionId === sessionId) return false;`，沿用现有按 session 找回合标签的助手 `turnTabForSession` 与 `tabRunOf`/`tabTurnOf`，未新建任何全局单槽状态。已评审规则不破坏：同标签无执行中同会话上一回合时，直接发送的匹配早到结束仍缓冲并在 started:true 初始化后重放；上一回合仍执行时（本标签或任意标签）事件照常即时处理。

**Important 2：sessionRemove 遗留排队项，出队复活已删除会话。** `sessions.ts` 的 `releaseSessionRuntime` 取消 live agent 并清理 Map，但不收调度器队列里该 session 的等待项；下一次 drain 对已删除会话走 `startQueuedItem` → `sendToAgent` → `ensureChannelAgent`，无 header 后重新 create。修复两处：① `turn-scheduler.ts` 新增语义明确的批量取消 `cancelQueuedItemsForSession(sessionId): number`——只从调度器私有队列移除该 session 的等待项并返回条数，**不碰** `rootWriters`（活动写者不释放、名额不提前让出，删除会话≠对活动回合的提前 release），其他 session 的等待项原样保留；既有 `cancelQueuedItem(queueItemId)` 单项语义与 `releaseOnce` 规则不变。② `sessions.ts` `releaseSessionRuntime` 在取消 live agent 之后调用 `ctx?.huaanworkTurnScheduler?.cancelQueuedItemsForSession(sessionId)`——`session.remove` 与 task/project 级联删除（`routes.ts:1075/1079/1166/1293`）共用此路径，一处接线全覆盖；只收被删 session 自己的队列项，子会话级联保持既有 Map 规则、不误删其他会话的队列。

### 14.2 新回归测试与 RED/GREEN

新增 4 条回归（命令均为 `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/sessions.spec.ts`）：

| 测试 | 文件 | 钉什么 |
|---|---|---|
| `a cross-tab running turn's session end is never buffered into another tab's pending send` | `tests/client-huaanwork/appWiring.spec.ts` | Important 1：holdEarlyEvent 源码序——`turnTabForSession(sessionId)` 任意标签回合查找与 `tabRunOf(turnTab).running` 守卫必须落在本标签守卫之后、缓冲 push 之前；并用生产 reducer 实测 B 的 waiting 应答只写 B 的等待位、A 的结束即时结算（`noteTurnEnded`）、A 的停止闩锁（`finishStop.arm`）与 epoch 不被触碰 |
| `cancelQueuedItemsForSession removes only that session’s queued items` | `tests/huaanwork-host/turn-scheduler.spec.ts` | Important 2：按 session 批量删除只移除该 session 的全部等待项（返回 2/0），活动写者名额与其他 session 等待项原样保留，release 后 drain 只出队存活的 `b` |
| `cancelQueuedItemsForSession does not release an active writer of that session` | `tests/huaanwork-host/turn-scheduler.spec.ts` | Important 2：批量取消不释放同会话的活动写者（`activeTurnCount` 不降、`soleCapWriterSessionId` 不变、drain 为空），删除会话不构成提前 release |
| `session.remove cancels the removed session’s queued items so a drain cannot resurrect it` | `tests/huaanwork-host/sessions.spec.ts` | Important 2 宿主集成：名额 1 下 a 执行、victim 同根排队、b 名额满排队；remove victim 后 a 空闲触发 drain——victim 不得 create/resume/收到 followup/发 queue-start，b 正常接手（queue-start + followup + releaseCalls 顺序） |

**RED（修改前，2026-11-05 15:17，exit 1，`Tests 4 failed | 123 passed (127)`）**，失败机制原样摘录：

- `appWiring.spec.ts`：`AssertionError: an any-tab turn lookup runs after the same-tab guard`（`turnTabForSession(sessionId)` 查找在修复前源码中不存在，`indexOf` 返回 -1）；
- `turn-scheduler.spec.ts` ×2：`TypeError: turns.cancelQueuedItemsForSession is not a function`（方法不存在）；
- `sessions.spec.ts`：`AssertionError: expected [ 'victim' ] to not include 'victim'`——**复活链真实复现**：删除 victim 后 a 空闲触发 drain，宿主对已删除会话 `agents.create` 重建并执行排队文本。

**GREEN（修改后，2026-11-05 15:18 与 15:19 各复跑一致，exit 0）**：`Test Files 3 passed (3)`；`Tests 127 passed (127)`；0 failed / 0 skipped。RED→GREEN 之间仅做 brief 允许的三处源码修复；唯一额外动作是 typecheck 报的 1 个 `TS2532` 守卫修正（§14.3），随后对三 spec 复跑确认仍 127/127。

### 14.3 typecheck

`corepack yarn workspace dsh-plugin-huaanwork typecheck`：首跑报 `src/huaanwork-host/turn-scheduler.ts(142,13): error TS2532: Object is possibly 'undefined'`（新方法在 `noUncheckedIndexedAccess` 下直接索引 `queue[index]`）；改为先取 `const item = queue[index]` 并判 `item === undefined` 后，**复跑 exit 0、无诊断**。

### 14.4 root `corepack yarn check`（单独串行）

严格单独串行执行（期间无其他门禁/构建并行），日志 1668 行，**exit 0 全链通过**：`dsh-plugin-huaanwork`（build + 全量 vitest + `verify:host` + Loader smokes）→ `verify:aa` → `verify:licenses` → `verify:operations` → 下游各 workspace `check`，最末 `agent-catalog-server` 15/15 pass。日志中出现的 `renderer boot failed (-102/-105)` 等行是 Loader 冒烟的负路径期望输出（该门禁 exit 0 通过），非失败。

### 14.5 工作树核对与诚实性

```bash
git diff --check     # exit 0，无输出
git status --short   # 改动面 = §13.4 基线 + 本波次 6 个允许文件（4 源码/测试为既有分支改动文件的增量、2 个测试文件为既有未跟踪文件的增量）+ 本证据文档追加
```

- 未执行 `git add` / `commit` / `push` / `stash` / `restore` / `clean`，所有既有未提交工作保留；
- §1 的 48 行条款表、Task 12 首次红/复跑绿历史（§11.3/§12）、Task 13 的 12 项「未验收」全部原样保留；§1 摘要表**只追加** 4 行本波次结果，未改写任何历史行；
- 图形界面**仍未走查**（§13.1 的守卫与本节一致，未启动 GUI），Task 13 的 12 个场景行依旧为「未验收」；
- LSP 在编辑后报告了若干 `App.tsx` 存量 biome 诊断（a11y/useExhaustiveDependencies，分布于 1027–3953 行等）与 `sessions.spec.ts:95` 的 `noThenProperty`（`manualIdle` 的 thenable fixture），均为**修复前已存在**的代码，不在本波次允许范围内，未处理、原样保留。

## 15. Task 13：真实 GUI 场景验收（2026-11-05 16:00–16:50，追加）

用户在 2026-11-05 明确要求「启动GUI场景验收」，本节因此执行真实 Electron GUI，不再受 §13.1 的 no-GUI 守卫限制。§13 的 12 行「未验收」是此前未启动应用时的历史记录，原样保留；本节按实际观察另行记录，不把 headless 结果抄成 UI 通过。

### 15.1 启动路径、隔离夹具与异常边界

- 首次 `corepack yarn dev` **exit 1，应用未启动**：root 的 `market:prepare` 拉到 npm 最新 `dshmarket@1.73.11`，现有 `.yarn/patches/dshmarket-desktop.patch` 无法应用 hunk #2，按仓库规则 fail-closed 并恢复 manifests/lockfile。未为 GUI 验收修改市场 patch 或产品代码。
- 随后使用 `corepack yarn workspace dsh-plugin-huaanwork dev` 复用当前依赖完成构建并启动真实窗口；为可靠驱动 DOM，再由我退出这一实例，以同一配置运行刚构建的 `lib/main.js` 并附加仅回环的 `--remote-debugging-port=9222`。所有场景动作都发生在真实 HuaAnWork Electron 窗口；不是 Vitest、内部函数 import 或静态页面。
- 隔离目录：A=`/tmp/huaanwork-gui-a.UjegKH`（初始 `a.txt` 为空），B=`/tmp/huaanwork-gui-b.H2na34`（初始 `b.txt` 为空）。经真实 renderer 的既有 RPC 登记为「并发验收A/B」。未改写用户原有项目文件。
- 初始仅有 `deepseek`。通过设置 GUI 新增两个回环模型：验收模型A（请求 `model=stub-a`）与验收模型B（`model=stub-b`），均指向 `http://127.0.0.1:53339/v1`。本地桩记录每次请求的模型、真人文本和尾消息角色；文件写工具经真实 bash 工具、门禁和项目根执行，永不触达真实模型。
- 第一次桩调用漏掉 bash 必需的 `description`，导致工具失败且文件仍为空；这是夹具错误。补齐后重跑并取得下列结果，不把首次夹具失败算作产品结论。

### 15.2 Step 2–4 实际结果

| 子场景 | 结果标签 | 实际 UI、请求与文件观察 |
|---|---|---|
| 2.1 A 写 `a.txt` 后切换 B | 真实 UI（通过） | A 的项目项处于 active，composer 显示「📁 并发验收A / 验收模型A」；发送后输入框清空，随后打开 B。首轮日志：A 用户请求在 `1793867178765` 到达 `stub-a`，B 在 `1793867179363` 到达，A 的工具跟进在 `1793867181830` 才到达——B 确实在 A 未结束时开始。 |
| 2.2 B 自有执行态与空输入框 | 真实 UI（通过） | B 显示「把 b.txt 改成 B」「正在思考」「停止」，模型为「验收模型B」，发送后 textarea 为空；A 的回合仍在等待其延迟工具应答。 |
| 2.3 回到 A 不串 B 的文件/差异 | 真实 UI（通过） | B 的「项目」页显示根 `huaanwork-gui-b.H2na34` 与 `b.txt`；切回 A 后显示根 `huaanwork-gui-a.UjegKH` 与 `a.txt`，composer 恢复「验收模型A」。未出现 B 的 `b.txt` 覆盖 A 文件树。 |
| 2.4 两边文件各自变化 | 真实 UI（通过） | 修正夹具后的最终读取：A/a.txt=`A`，B/b.txt=`B`；工具面板均出现「工具 · 已完成 · 1 项调用」。 |
| 3.1 同根第二条等待且可继续输入 | 真实 UI（通过） | A 第一条 `挂起A1b` 显示「正在思考/停止」时，经运行中表单的提交路径发送第二条；第二条显示「等待当前任务 / 取消」，输入框清空并可继续填写。 |
| 3.2 停止第一条后再启动第二条 | 真实 UI（通过） | 点击「停止」的同一拍第二条仍显示等待；约 150ms 后第一条显示「已停止」、第二条才转为「正在思考」。桩日志中第二条用户请求在 `1793867419453` 到达，工具跟进在 `1793867422514`（延迟 3061ms）到达；最终 a.txt=`A`。 |
| 3.3 只取消等待项 | 真实 UI（通过） | 第一条 `挂起A2` 执行、第二条等待时点击第二条「取消」：等待文案和取消入口消失，第一条仍显示「正在思考/停止」并继续挂起。聊天中的用户消息保留，消失的是等待项状态。 |
| 3.4 上限 1→3 与等待项启动 | 真实 UI（**失败**） | 上限设为 1 时，A 的既有挂起回合未被取消，B 新发送显示「等待当前任务」。改回 3 并等待 800ms 后 B 仍停在同一等待文案，桩日志无 B 新请求，即**恢复名额没有触发自动出队**。之后停止 A，B 才在无需重输的情况下转为「正在思考」。 |
| 4.1 A/B 模型绑定不随全局第三个模型改变 | 真实 UI（通过） | A/B 分别选择验收模型A/B 并运行后，通过设置把当前全局模型改为第三个 `deepseek`。该轮日志仍为用户请求 `stub-a`（`1793867791883`）与 `stub-b`（`1793867792422`），工具跟进也分别保持 `stub-a`/`stub-b`；界面标签仍显示验收模型A/B。 |
| 4.2 删除排队项模型，B 仍可启动 | 真实 UI（通过） | A 执行中排队一条绑定验收模型A的消息，经设置 GUI 删除该模型后停止当前条：A 显示「模型不存在」，等待项未启动。随后 B 使用验收模型B 发送，显示「正在思考/停止」，独立开始。 |
| 4.3 到期自动化隔离与 B 手动运行 | 未验收（部分真实 UI 已观察） | A 用户回合占根期间，A 的 once 到期自动化持续显示「从未运行」；B 手动自动化在 GUI 点「立即运行」后显示「运行中」，随后「上次 今天 16:45 · 成功」，侧栏 active 项目始终为 A，未跳到 B。A 停止后其到期项随后实际运行。**未观察超过 10 分钟后的 missed/停用状态**，所以整个子场景不记通过。 |
| 4.4 未绑定会话的中立根 | 真实 UI（**失败**） | 新未绑定会话的实际 cwd 由 `session.list` 确认为 `/Users/amonmiao/.huaanwork/profiles/desktop/workspace`。让工具向 A 的绝对路径 `/tmp/huaanwork-gui-a.UjegKH/neutral-result.txt` 写入后，文件**实际出现在 A**，内容为 `NEUTRAL`，而非中立工作区。同时该标签的「变更」面板出现与本会话无关的 `.gui-home.html`、`_probe_workspace.py` 等 diff。两项均按实测失败记录。 |

汇总：12 个子场景中 **9 项通过、2 项真实 UI 失败（3.4、4.4）、1 项部分观察但未验收（4.3）**。本节的「真实 UI」只表示实际运行并观察，不表示通过；通过/失败写在每行括号与事实描述中。当前结果**不支持发布就绪结论**。

### 15.3 证据文件与未执行项

- 回环模型请求日志：`/tmp/huaanwork-gui-stub-requests.jsonl`；修正夹具前的首轮日志另存 `/tmp/huaanwork-gui-stub-requests-first.jsonl`。这些是临时文件，系统可随时清理，持久结论以本节文本为准。
- 最终探针文件：A 目录中的 `a.txt` 与误写入的 `neutral-result.txt`；B 目录中的 `b.txt`。它们位于上述 `/tmp` 隔离目录，不属于仓库提交面。
- 未执行 Windows/Linux 真机、CI、打包；未做 4.3 的 10 分钟等待。未执行任何 `git add` / `commit` / `push`。GUI 发现的问题仅登记，未在本验收波次改产品代码。

## 16. GUI 验收后续处置与收口（2026-11-05，追加）

本节是最新处置与复测结果，**不改写 §15 的历史记录**：§15.2 中 3.4 与 4.4 的「真实 UI（失败）」、4.3 的「未验收（部分真实 UI 已观察）」均按首次观察原样保留，本节只在其上追加后续处置与复测结论。各小节明确区分真实 UI、headless 与未执行项。

### 16.1 F1（3.4）：cap 恢复后等待项未自动出队 — 已修复，真实 UI 通过

- 根因：`settings.set` 在持久化上限后不触发 drain；用户队列此前只在 `releaseAndDrain` 时出队，因此纯设置写路径不产生任何调度动作。
- 修复：`huaanwork-host/sessions.ts` 新增导出 `drainUserQueue`（只 drain、不 release），`releaseAndDrain` 复用该函数；`routes.ts` 在设置写成功且请求带自有 `max_concurrent_turns` 时经 `ctx.runtimeCtx` 调用。scheduler 算法未改。
- TDD RED：focused 两个 spec exit 1，唯一失败用例 `a cap raise via settings.set drains the queue without a turn release`，断言 `expected undefined to deeply equal ['queued-b']`，发生在设置已写 3 之后 —— 证明修复前设置写确实无 drain。
- GREEN：focused 两个 spec 106/106；自动化消费方附加回归 59/59；包 `typecheck` exit 0；任务评审 clean。
- 真实 GUI 复测：A 挂起、cap=1 时 B 显示等待；cap 恢复 3 后 **500ms 内** B 自行转为「正在思考/停止」，无需重输；切回 A 时 A 仍显示「停止」，随后才为清理手动停止 A。
- **3.4 最新结果 = 真实 UI 通过**（§15.2 的首次失败已由本修复关闭）。

### 16.2 F2（4.4）：中立根判定 — 首次失败改判为无效夹具，真实 UI 通过（登记后续文档裁定）

- 根因复核**推翻首次产品缺陷判断**：旧探针用 bash 绝对重定向把文件写入位于 `/tmp` 的项目 A；上游 workspace-write 策略本来就允许根（`/`）与平台临时区，且 sandbox 不改写 shell 字符串，因此 bash 重定向路径不受中立根约束。旧结果（文件实际落在 A）是夹具无效，不是产品 bug。
- 旧「无关 diff」（`.gui-home.html`、`_probe_workspace.py` 等）来自共享中立 git 工作区里早于探针存在的未跟踪文件；不是项目 A 跨会话泄漏。
- 新有效夹具：外部项目 C = `/Users/amonmiao/Downloads/huaanwork-gui-outside.cpW51y`（非 `/tmp`/`$TMPDIR`）。
- 相对写入，真实 UI：未绑定会话的「中立相对写入」工具调用完成，`/Users/amonmiao/.huaanwork/profiles/desktop/workspace/neutral-valid.txt` 内容为 `NEUTRAL_OK`；A、C 目录均未出现该文件。UI 变更面板包含 `neutral-valid.txt`，属于会话自己的中立根。
- 绝对路径对照：向 `C/absolute-denied.txt` 写入的工具显示失败，stderr 含 `Operation not permitted` 与 `[sandbox: file access denied under workspace-write mode]`，文件不存在。这是当前 deny-outside 合同，不是「把绝对路径搬进中立根」。
- **4.4 最新结果 = 真实 UI 通过**（cwd 固定 + 越界拒绝）；§15.2 的首次失败改判为无效夹具。规格「越界路径收回根」的措辞与底层实际语义仍有差距，登记为后续文档裁定项，不在本次改产品/设计。

### 16.3 F3（4.3）：到期自动化隔离 — 分层证据，即时部分真实 UI 通过 + headless 长窗口覆盖

按用户批准的分层证据方案，4.3 拆为两层：

1. **真实 UI 即时部分（通过）**：A 用户回合占用根期间，A 的到期自动化不启动；B 手动运行成功；侧栏 active 项目始终为 A。（此部分即 §15.2 4.3 行已观察到的真实 UI 事实。）
2. **headless 长窗口**：用例 `an admission skip survives the missed grace window`；本轮新鲜执行 `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automation-scheduler.spec.ts` exit 0，13/13 passed。**本节没有任何真实 GUI 等待 10 分钟**；该长窗口仅由 headless spec 覆盖。

**4.3 最新结果 = 真实 UI 即时部分通过 + headless 10 分钟覆盖**；不记为完整 GUI 长等待验收。

### 16.4 最终门禁（控制会话串行、新鲜执行）

- `corepack yarn check` exit 0。日志 `/tmp/concurrent-followup-root-check.log`；HuaAnWork 汇总 `276 passed | 4 skipped (280)` 文件、`3725 passed | 14 skipped (3739)` 用例，`verify:host` 35/35，其余下游检查也通过。
- 随后 `corepack yarn test` exit 0。日志 `/tmp/concurrent-followup-root-test.log`；HuaAnWork 同为 3725 passed / 14 skipped / 0 failed，其余 workspace 汇总 fail 0。
- 上述日志为临时文件，以本节文本为持久记录。未执行 CI、Windows/Linux 真机或打包；未提交、未推送。

## 17. 2026-11-07 评审修复波次门禁（含 2026-11-06 评审 Important-1/2、Minor-1/2/3）

本节记录 `docs/superpowers/plans/2026-11-06-concurrent-project-turns-code-review.md` 修复波次（Task 1–4 + 最终整体审查收口）完成后的门禁复跑，**不改写 §16 的历史计数**。

- 命令：`corepack yarn workspace dsh-plugin-huaanwork test`；退出码 `0`。汇总 `Test Files 277 passed | 4 skipped (281)`、`Tests 3784 passed | 14 skipped (3798)`、0 failed。对比基线 `1 failed | 3781 passed | 14 skipped (3796)`：唯一失败是 `test-port-mapping.spec.ts` 指向 `automations-host.spec.ts:662` 的空行，证据行重映射后清零；执行总数 +2、通过数 +3 是新增的 live-agent 根保留回归、最终整体审查的绑定所有权回归，加上该失败转绿。
- 命令：`corepack yarn workspace dsh-plugin-huaanwork typecheck`；退出码 `0`，无输出。
- 命令：`corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/test-port-mapping.spec.ts`；退出码 `0`，`Test Files 1 passed (1)`、`Tests 1 passed (1)`。
- 命令：`BASE_SHA=$(git rev-parse HEAD) corepack yarn check`；退出码 `0`（最终工作树重跑，覆盖插件 `build` / `typecheck` / `test` 与全仓 verify 链；插件汇总同上）。`BASE_SHA` 设为 HEAD 是因为本轮改动未提交，默认的 `merge-base(origin/master, HEAD)..HEAD` 仍会读到提交历史里已存在的 `plan-review.md` 末尾空行（`10b1e35f01` 引入，工作树已修正）；`git diff --check` 对工作树退出 `0`。

已修复项（每条一行）：

- **Important-1**（`sendToAgent` 在 `dispatchAt` 之后才写模型/根表）：模型与根改为 `dispatchAt` 之前临时写入、`followup` 受理后保持、未启动且没有 `afterIdle` 清理时还原；已登记的根不被新准入改写，live agent 与登记根不一致时在 `followup` 之前按未启动失败。回归在 `tests/huaanwork-host/sessions.spec.ts`（准入绑定时点、还原、live-root 不匹配，以及本轮新增 `a cancelled first send keeps the provisional root once resume produced a live agent`）。
- **Important-2**（交付物核对优先扫前台根）：`outcomeWorkspace` 改为会话 `cwd` → 标签项目根 → 仅当标签与前台同上下文才用前台根；回归 `tests/client-huaanwork/outcomeCheck.spec.ts` 33 例。
- **Minor-1**（未真正开始的回合不回滚模型选择）：`started:false`、排队期 `session/queue-fail`、`cancelWaiting` 与 `send()` 的 `catch` 都经 `restoreModelPick` 回滚发送前的选择，且只在当前选择仍等于本次送出的 id 时生效；回归 `tests/client-huaanwork/appWiring.spec.ts` 60 例。
- **Minor-2**（`ensureChannelAgent` 与 `session.remove` 的窄竞态）：在 header 读取之后、写根与 `create` / `resume` 之前补一次 `cancelled` 复查；回归 `tests/huaanwork-host/sessions.spec.ts` 的排队取消用例（该用例本轮同时钉住「还原先于 release」）。
- **Minor-3**（手动运行跳过不区分 `root-busy` 与 `cap-full`）：`automation.run` 的跳过应答透传 `reason`，界面按两种原因给不同文案；回归 `tests/huaanwork-host/automations-host.spec.ts`（同根跳过断言 `reason: 'root-busy'`）、`tests/client-huaanwork/automations-runs-delete.spec.ts` 与 `tests/huaanwork-host/route-contract.spec.ts` 的可选键白名单。
- 同波次 Task 4（测试与文档加固）：`tests/huaanwork-host/test-port-mapping.ts` 重映射 18 条证据行（`sessions.spec.ts` 4 条、`automations-host.spec.ts` 14 条）；`src/huaanwork-host/automations-host.ts` 的模型表注释订正为「dispatch 前临时写入、受理后保持」；计划文档按临时绑定 / 未启动还原 / 登记根复用 / `recordSkip` / 手动运行模型回滚订正。
- 最终整体审查收口（Minor）：未启动还原增加「只撤销本轮自己写入的值」所有权守卫 —— 模型条目在还原时已被删除或改成别的值则不动，根条目在删除前还要求值等于本轮写入的 `admission.root`；新增回归 `a followup that removes or replaces the bindings is not undone by the restore path`（`tests/huaanwork-host/sessions.spec.ts`）。计划文档的“发送前已有模型键”措辞限定到还原路径，规格 §5.2.1 同步该所有权限定。

历史命名注记：本文更早的历史小节（如 §3 条款对照表与 §17 之前各行）可能仍使用改名前的测试名 `automation binds its startup model after followup`，该用例的当前标题是 `automation binds its startup model before dispatch and confirms it at followup`（同一条用例，仅标题变了）。

未执行项：本轮**没有**运行 CI、Windows/macOS 真机或打包；§16.4 的全仓门禁结论只属那一轮，本节的 `check` 结论按上面的 `BASE_SHA=HEAD` 口径记录。未提交、未推送。

## 18. 2026-11-07 Grok 复核残余项修复门禁（§A.2 与 §A.3 第 1–3 条）

本节记录 `docs/superpowers/plans/2026-11-06-concurrent-project-turns-code-review.md` §A（Grok 复核）中列出的 1 条残余项（§A.2）与 3 条 Minor（§A.3 第 1–3 条）按优先级逐条修复后的门禁复跑，**不改写 §17 的历史计数**。

- 命令：`corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/test-port-mapping.spec.ts tests/client-huaanwork/appWiring.spec.ts`；退出码 `0`，`Test Files 4 passed (4)`、`Tests 168 passed (168)`。
- 命令：`corepack yarn workspace dsh-plugin-huaanwork test`；退出码 `0`，汇总 `Test Files 277 passed | 4 skipped (281)`、`Tests 3788 passed | 14 skipped (3802)`、0 failed（较 §17 的 3784 passed +4 条新增回归用例）。
- 命令：`corepack yarn workspace dsh-plugin-huaanwork typecheck`；退出码 `0`，无输出。
- 命令：`git diff --check`；退出码 `0`，无输出。

已修复项（按优先级）：

- **优先级 1 — Grok §A.2**（`@` HTTP/MCP 在 live agent 出现前失败时不还原临时根/模型）：`sendToAgent` 的 `restoreProvisionalBindings` 改为幂等；当 `!followupAccepted && afterIdle !== undefined` 时，若 `findAgentBySession(ctx, sessionId) === undefined`，在 `admission?.deferRelease?.()` 之前立即调用 `restoreProvisionalBindings()`，并在 `cleanup` 的 `finally` 中于 `releaseOnce?.()` 之前兜底调用 `if (!followupAccepted) restoreProvisionalBindings?.()`，确保卸载工具钩子（`afterIdle`）照常跑完、且在释放写者名额前已还原临时写入的根与模型。规格 §5.1.1 / §5.2.1 与实施计划同步更新为「`followup` 未受理且没有留下仍需等待 `afterIdle` 收尾的存活 `agent` 时还原」。新增回归 `an @ HTTP tool that fails before creating a live agent restores the provisional bindings and detaches before release`（`tests/huaanwork-host/sessions.spec.ts:3434-3500`）。
- **优先级 2 — Grok §A.3 #1**（无 live agent 时 `ensureChannelAgent` 仍可能用不同 `admissionRoot` 覆盖已登记根）：`ensureChannelAgent` 抽出 `assertMatchesRegisteredRoot()`，在入口（`findAgentBySession` 之前）以及异步读取 header/project/task 之后、`roots?.set(sessionId, root)` 之前均校验 `ctx.huaanworkSessionRoots?.get(sessionId)`，若已存在且与 `admissionRoot` 不一致则立即抛错拒绝，不覆盖已登记根。规格 §5.1.1 与实施计划同步更新。新增回归 `a session without a live agent rejects an admission root that differs from its registered root without overwriting it`（`tests/huaanwork-host/sessions.spec.ts:3502-3523`）。
- **优先级 3 — Grok §A.3 #2**（立即开始的 `session.send` 未向 `sendToAgent` 传入 `cancelled` 回调）：`sessions.ts` 新增 `directStarts` 集合与 `cancelDirectStarts`，在 `releaseSessionRuntime`（`session.remove`）与 `cancelAgent`（`session.cancel`）中同步标记取消，并在 `sessionSend` 的 `admitted.kind === 'start'` 分支向 `sendToAgent` 传入 `cancelled: () => directStart.cancelled`，使 header 扫描期间并发删除或取消会话能在 `create` / `resume` 之前中止并释放名额。新增回归 `an immediate session.send whose session is removed during the header read stops before resume and releases the slot`（`tests/huaanwork-host/sessions.spec.ts:3525-3551`）。
- **优先级 4 — Grok §A.3 #3**（同标签多条排队发送时，较早一条失败或取消会清掉后续排队项仍需使用的模型选择或丢失队列前基准）：`App.tsx` 新增 `QueuedModelOwner` 与 `restoreQueuedModelPick`，`rollbackQueuedModelPick` 在 `clearQueueItem` 前同步将当前项的 `previousModelPick` 交接给同标签后续紧邻且 `previousModelPick === owner.modelId` 的排队项，且只要同标签后续仍有携带 `modelId` 的排队项就保留 `modelPickByTab[tabId]` 不回退，并为 `setModelPickByTab` 提供独立克隆快照以保证同批多次回滚与 React StrictMode 下的纯度与幂等性。新增回归 `rolling back an earlier queued send keeps a later queued send's pick and hands off the pre-queue baseline`（覆盖同模型空基准、同模型非空基准、异模型 `m1 -> m2` 交接回滚、交替模型 `m1 -> m2 -> m1` 尾项取消回退四种情形，`tests/client-huaanwork/appWiring.spec.ts:845-930`）。
