# 《会话内工具面板》代码实施评审意见（复核修订版）

- **评审对象**：`de2cd6e378`（`feat: project tool calls into per-turn chat panels`），相对基线 `ff897f713c`；实施提交 `b7aaa5ef5f`（I-1/I-2/I-3）与 `958d1233b1`（whitespace 门禁修复）
- **对照基准**：设计规格 `docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md`；实施计划 `docs/superpowers/plans/2026-11-02-chat-tool-panel.md`。计划 Global Constraints 把规格写成设计真相源。规格评审校准见 `docs/superpowers/specs/2026-11-01-chat-tool-panel-design-review.md`
- **评审方式**：评审阶段只读。逐条重放规格 §4–§8 与计划 Task 1–11 调用链，深入对齐 `deepseek-harness` 中 `agent-loop`、`repair.ts` 与 `session-view.ts` 补写链路。本文件记录经复核修订后的完整评审结论；实施状态与验证见下。
- **评审与复核日期**：2026-11-03
- **本版说明**：本版在原评审（2026-11-03）基础上，按实现代码与既有真机证据复核校正。保留 I-1 与 I-2 的根因；重写 I-2 的「运行中取消」场景与验收标准；新增 I-3；订正行号与措辞。原评审中与本版冲突的表述以本版为准。
- **当前总结论**：**主路径（投影、事件契约、历史配对、turnFinal 状态机）架构健康，可予以保留。** I-1、I-2、I-3 已按 2026-11-03 的裁定实施并提交（`b7aaa5ef5f`）；I-2 合成历史真机 GUI 已通过，headless 门禁在基线 exit 0；设计规格已同步到最终语义。剩余：I-1/I-3/N-1/N-2 的 GUI 场景与推送。**不再使用原评审「复核确认无误报、无夸大」的自评**：本版已纠正其中一处夸大（普通取消被误当作实时/历史不一致的常见路径）。

---

## 实施状态（2026-11-03）

| 项 | 状态 | 实施落点 | 回归 |
| --- | --- | --- | --- |
| I-1 | **已实施** | `parentTurnLine` 增加 `toolsUnconfirmed` 输入（`subagentRuns.ts:325`）；App 在 `parentTurnLine` 调用处传入 `unconfirmedTools`（`App.tsx:674`） | `subagentRuns.spec.ts:1098` 纯逻辑用例；`appWiring.spec.ts` 接线断言 |
| I-2 | **已按裁定实施** | 宿主 `session-view.ts:184` 解析 `data.error.code` 与 `turn/end` reason，`SessionDetailRecord` 增加 `synthetic`；客户端 `sessionChannel.ts:165` 映射 `interrupted`/`resultMissing`，`toolPanel.ts:40` 让 `interrupted` 优先于 `end`；`selectSubtask` 改为 open-before-resume（`App.tsx:814`） | `session-view.spec.ts` 新增 3 组解析用例；`sessionChannel.spec.ts` 新增 2 组历史映射；`toolPanel.spec.ts` 新增 1 组状态优先级；`appWiring.spec.ts` 接线断言 |
| I-3 | **已实施** | `turnFinalWithoutUser` + `run-end` 终态事件（`toolPanel.ts:117/153`）；App 投影与三处历史回填传入；`automation/run-end` 补结算（`App.tsx:1300`） | `toolPanel.spec.ts:384` 无 user 合成回合；`appWiring.spec.ts` 投影与 `run-end` 断言 |
| m-1 | **顺带关闭（历史无 user 片段）** | 三处历史回填置 `turnFinalWithoutUser: true` | `appWiring` 的 3 处历史种子计数断言 + `toolPanel` 无 user 投影用例 |
| N-3 | **顺带清理** | `applyTurnFinalToTabs` 冗余分支已合并 | 既有 `toolPanel` 用例全绿 |
| m-2 | **已修（2026-11-03）** | `App.tsx` ToolCard 的 `unconfirmed`/`resultMissing` 注释按规格修正 | 注释变更，无运行时测试 |
| N-1 | **已修（2026-11-03）** | goal outcome 只封口回合，不把在途工具标 `unconfirmed`；后续真实结束结算（`toolPanel.ts`） | `toolPanel.spec.ts` 新增 goal outcome 用例 |
| N-2 | **已修（2026-11-03）** | `applyFinalForTab` 在调用时同步取样 phase（`App.tsx`） | `appWiring.spec.ts` 源码断言 |

**提交**：`958d1233b1`（whitespace 门禁修复）、`b7aaa5ef5f`（I-1/I-2/I-3 实现）。

**验证（I-1/I-2/I-3 基线 `b7aaa5ef5f`；m-2/N-1/N-2 与 GUI 在最终工作树）**：

- `corepack yarn check:whitespace`：7/7 passed，exit 0（基线）。
- `corepack yarn check`：基线 `b7aaa5ef5f` exit 0；本轮提交后复核完整链。
- `corepack yarn test`：exit 0（`dsh-plugin-huaanwork` 3601 passed / 14 skipped；其余 workspace 全绿）。
- `corepack yarn typecheck`：exit 0。
- 定向 15 文件：287 passed。
- **真机 GUI（I-2 合成历史）**：通过。隔离 `DSH_HOME`/userData + Electron 44.0.0 + CDP；6 回合 fixture 的面板标题依次为「已中断 / 结果未记录 / 已完成 / 含失败调用 / 已完成」，跳过调用不计入面板（第 3 回合仅 1 项），`TOOL_NOT_STARTED` 无卡片、`notes=[]`，真实 `ABORTED` 仍为失败。证据：`/tmp/huaanwork-tool-panel-accept-evidence-20261103/`（临时证据，不提交）。
- **未执行 GUI**：I-1 活跃子运行 + 未确认、I-3 自动化运行标签、N-1 goal outcome 闪烁、N-2 相位时序；这些为 UNIT-ONLY。未 push。

**规格同步**：已同步到 `docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md`（头部状态与 §5.1/§5.2/§5.4/§6.1/§6.3/§6.5/§7/§8/§9/§10/§11，2026-11-03）；实现、规格与评审文档一致。

---

## 一、本版修订说明

| 维度 | 原评审结论 | 本版修订 |
| --- | --- | --- |
| **I-1 回合条覆盖** | 有活跃子代理时，回合条不再显示「工具状态未确认」 | **维持**。无活跃子运行时口径符合规格；仅在「未确认工具」与「活跃子运行」同时存在时被 `parentTurnLine` 换成「主会话运行中」。根源是历史子代理设计（D4）未考虑断连态，本次随规格 §6.1 口径统一而浮出。**已实施（`b7aaa5ef5f`）。** |
| **I-2 根因** | 磁盘合成闭合结果被误当成真实工具失败 | **维持**。合成 `tool/result` 会被 `session-view.ts` 按 `message.isError === true` 判为失败；`session.resume` 会把合成 closer 持久化写盘，`selectSubtask` 的 resume-before-open 与 `resumeFromView` 的 resume 都会污染后续读取。 |
| **I-2 运行中取消** | 实时「已中断」在恢复后变为「失败」，且称为更常见的漏报场景 | **纠正 / 缩小范围**。普通取消若工具返回真实 `isError` 终态（如 bash 的 `Error: tool call aborted`，`TOOL_ABORTED`），bridge 会发真实 `tool/end { isError: true }`，实时与历史都显示「失败」；这符合规格 §6.3「迟到的真实终态优先」与 D5 真机裁决（60 ms 采样下「已中断」未出现，最终稳定为「含失败调用」）。**不得要求存在真实终态的历史保持「已中断」**。本缺陷只覆盖没有真实终态、只有合成 closer 的调用。 |
| **I-2 需识别的结果** | `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` | **扩展为三类**：① 崩溃/未闭合尾回合恢复（`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`）；② 取消时尚未 dispatch 的跳过调用（`ABORTED_BEFORE_DISPATCH`）；③ step 失败时未 commit 的已启动调用（`TOOL_OUTCOME_UNKNOWN`）。 |
| **I-2 修复点** | 在 `session-view.ts`（或 `sessionChannel.ts`）识别错误码 | **收窄到 `session-view.ts` + 契约（已落地）**。`sessionChannel.ts` 拿到的 `SessionDetailRecord` 不含 `error.code`，单改该层无法识别；需在 `session-view.ts` 解析 `data.error.code` 与 `turn/end` 的 reason，并扩展 `SessionDetailRecord`。 |
| **I-3 运行标签** | 原评审未覆盖 | **新增（已裁定纳入并实施 `b7aaa5ef5f`）**：实时自动化运行标签没有 `user` 条目，`applyTurnFinalToTabs` 直接早退，运行结束/取消时面板得不到 `turnFinal`、在途工具不会被标 `interrupted`/`unconfirmed`。规格以 user 回合划分面板，运行标签由 owner 裁定纳入并以 `turnFinalWithoutUser` 结算。 |
| **引用行号** | `repair.ts:186-189` 等 | **订正**：错误码构建在 `repair.ts:187-189`；`subagentRuns.ts:240-243`；`App.tsx:667-677`；`App.tsx:3732-3745`；`toolPanel.ts:120-129`。本表为评审时行号；实施后以顶部〈实施状态〉为准。 |
| **措辞** | 「无阻断项」与「应修项（合并前必修）」并用 | **统一**：I-1/I-2/I-3 已闭环；剩余真机验收与推送，不再使用「合并前必修」的未决措辞。 |

---

## 二、已核对、与规格一致的部分

> 以下为评审时（`de2cd6e378`）的行号；实施后的行号以顶部〈实施状态〉为准。

- **数据源唯一性**：持久化 `ChatItem` 联合类型未引入虚拟面板实体（`App.tsx:258-266`）。`projectToolPanels` 仅作为最外层渲染视图投影（`App.tsx:620-626`）。审批、输入、待办和子代理卡片完整保留在扁平数组中。
- **断连状态派生**：`connectionLost` 严格绑定 `sidecarDead`（`App.tsx:622-625`）。`toolEntryStatus` 在断连时把仍在开始态且无中断标记的工具派生显示为 `unconfirmed`，不污染底层的原始 `status`（`toolPanel.ts:40-46`）。
- **终态收敛幂等**：`reduceTurnFinal` 在当前值已为 `true` 时直接短路返回 `true`（`toolPanel.ts:120-129`）。`goal-action` 仅在 `reduceGoalTurn` 的返回动作非 `none` 时置终态；动作联合严格限定为 `none`、`outcome`、`goal-stopped`（`goalRound.ts:44-47`）。目标相位为 `active` 的成功 `session/end` 稳定保持非终态。
- **无标识工具配对**：无 `callId` 的 `applyToolEnd` 从全部扁平条目中取最早一张 `status === "start"` 的同名卡片，并安全清除其中断、未确认和结果缺失标记（`toolPanel.ts:56-100`）。
- **历史结果与 Shell 失败标记**：历史 `tool/result` 严格保持「先从完整文本提取 Shell 失败标记 → 执行 `capToolOutput` → 将未落在截断正文里的标记拼回」的处理顺序（`session-view.ts:250-266`）。
- **v4 历史结果形状**：`session-view.ts` 已兼容真实 v4 的 `message.content` 文本块、消息级 `toolCallId`/`isError` 与旧嵌套 `tool-result` 形状；这是 D1 修复的落点，核对无误。
- **文案与展开行为**：通用说明为工具名的闭合枚举映射；单项详情置于 `<pre>` 文本节点（`ToolPanel.tsx:63-68`），不执行 HTML。用户主动切换标记 `panelToggled` 优先级绝对高于自动折叠/展开（`toolPanel.ts:366-370`）。
- **可见正文判断**：`contentItems` 保持将运行产物 `attachment` 映射回助手正文（`App.tsx:3732-3745`），投影逻辑以此视图准确识别可见产出，避免 think 标签误触发收起。
- **测试命名规范**：组件测试文件名 `ToolPanelComponent.spec.ts` 契合不区分大小写文件系统的裁定，与纯逻辑 `toolPanel.spec.ts` 清晰解耦。

---

## 三、应修项

> 以下保留评审时的调用链、行号与修复前代码；带「修复前」的片段描述修复前行为，实施落点与验证见顶部〈实施状态〉。

### I-1 活跃子运行会盖住「工具状态未确认」

- **实施状态（2026-11-03）**：已实施并提交 `b7aaa5ef5f`；纯逻辑与接线回归见顶部〈实施状态〉。

- **问题描述**：规格 §6.1 及设计评审 P1-1（`2026-11-01-chat-tool-panel-design-review.md:149` 的复审表）明确要求：断连或未确认状态下，面板标题、单项与回合条必须口径一致，回合条专用文案为「工具状态未确认」。修复前逻辑在无活跃子运行时表现正确，但在「父会话当前存在活跃子运行」且「当前回合存在未确认工具」时，回合条会被覆写为「主会话运行中」。
- **调用链溯源**：
  1. `App.tsx:667-677` 派生 `unconfirmedTools = toolsUnconfirmed(items, sidecarDead)`，并作为 `turnStatus` 的输入。
  2. 但下一层调用被 `parentTurnLine` 包裹：
     ```ts
     // dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts（修复前）
     export function parentTurnLine(input: {
       hasActiveChild: boolean;
       current: { text: string; alert: boolean };
     }): { text: string; alert: boolean } {
       return input.hasActiveChild ? { text: "主会话运行中", alert: false } : input.current;
     }
     ```
     修复后：`parentTurnLine` 增加可选 `toolsUnconfirmed`，为真时返回 `current`；App 调用处传入 `unconfirmedTools`。
  3. 套接字断开时，子运行仅标记 `connection: "disconnected"`，不重置相位也不标记 `stale`（`subagentRuns.ts:240-243`）。`isSubagentRunActive`（`:93-95`）依然判定为活跃。
  4. 最终导致：面板标题与单项已呈现「状态未确认」，但底部回合条却显示「主会话运行中」，与规格 §6.1 违背。
- **历史成因**：计划 Task 6（`:1647-1660`）机械搬运了该片段；其上游子代理 D4 设计未覆盖断连交叠态。问题本质是规格与既有 D4 行为的冲突，应以规格为真相源调整。
- **修复方案（已实施）**：`parentTurnLine` 增加对未确认状态的感知，或在调用处裁决：当 `toolsUnconfirmed` 为真时，强制保留「工具状态未确认」；仅在工具状态完全明确且有活跃子运行时，才回落至「主会话运行中」。
- **验收**：
  - 断连（`sidecarDead`）或回合终态遗留未确认工具时，即使当前会话存在活跃子代理运行，底部回合条仍显示「工具状态未确认」；
  - 工具全部有明确结果且子会话活跃时，回合条正常显示「主会话运行中」；
  - 补一条纯逻辑/接线回归：`parentTurnLine` 的输入同时含 `hasActiveChild=true` 与 `toolsUnconfirmed=true` 时，输出必须是「工具状态未确认」。

---

### I-2 磁盘合成闭合结果被误当成真实工具失败

- **实施状态（2026-11-03）**：已按 owner 裁定（重开 D2/D5、按本版映射、未启动调用不生成卡片）实施并提交 `b7aaa5ef5f`；剩余真机复验见顶部〈实施状态〉。

#### 问题描述

规格 §5.4、§6.5、§7 与 §10 要求：历史恢复时，若调用没有真实结果，应显示「结果未记录」，不把这记成成功或失败；实时与历史对中断、未确认须有一致且诚实的展示。Harness 在恢复未闭合尾回合、取消或 step 失败时会向日志追加合成 `tool/result`；修复前 `session-view.ts` 只按 `message.isError === true` 判失败，历史因此把「结果未知」显示成「失败」/「含失败调用」。

#### 已核实的根因链

> 以下描述修复前的代码行为；最终落地见〈实施状态〉。

1. **磁盘持久化污染**：`resumeFromView` 在打开后调用 `rpcCall("session.resume")`（`App.tsx:2594`）；Harness 的 `agent-loop/src/index.ts:884-892` 在执行 resume 时若遇到未闭合回合，会生成 synthetic closers 并 `await handle.append(closers)` **持久化追加写入磁盘日志**。一旦写盘，后续任意入口读取磁盘日志，都会拿到带 `isError: true` 的合成结果。
2. **首次读取也已被污染（修复前）**：`selectSubtask` 原先先 `session.resume`（`App.tsx:809`）再 `session.open`（`App.tsx:810`），所以侧边栏子任务路径的**第一次**读取就包含合成 closer；`openFreeSession` 是 open-before-resume（`App.tsx:2493-2527`），首次读取干净，但随后的 `resumeFromView` 会把污染写盘，后续重新打开仍会变为「失败」。原评审「调换顺序」的修法只能防御首次读取，不能治本；现已在 `b7aaa5ef5f` 改为 open-before-resume，并由数据层覆盖已污染日志。
3. **历史解析**：`session-view.ts:281` 以 `message.isError === true` 判失败。`repair.ts:168-172` 构建的合成消息带 `isError: true`，错误码在 `repair.ts:187-189`（`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`）。
4. **配对显示**：`sessionChannel.ts:161-191` 成功按 `callId` 配对该调用并带上 `isError: true`；前端 `toolEntryStatus` 将其判为 `failed`，面板标题「含失败调用」。
5. **未启动调用的边缘现象（修复前）**：`TOOL_NOT_STARTED` 的合成失败结果无法匹配任何 `tool/call` 记录（assistant 消息中的 tool-call 块当前不被 `detailRecords` 解析），会在 `sessionChannel.ts` 中回退成一条生硬的英文提示：「工具调用失败：The tool call was interrupted before the Harness recorded it as started...」。

#### 本版校正：普通取消不是本缺陷

原评审把「运行中取消」称为更常见的漏报场景，并称实时显示「已中断」、恢复后变为「失败」。本版按代码与真机证据校正：

- **有真实终态的取消**：bash 等工具把取消变成真实的 `tool/result`（`Error: tool call aborted`，错误码 `TOOL_ABORTED`，见 `deepseek-harness/packages/shell/tool-bash/src/index.ts:183`），bridge 发出真实 `tool/end { isError: true }`。实时最终状态与历史都是「失败」；这符合规格 §6.3「迟到的真实终态优先」以及 D5 真机裁决（`docs/evidence/2026-11-02-chat-tool-panel-verification.md` D5：`dt=63 ms` 起稳定为「含失败调用」，「已中断」在 45 次采样中未出现；D5 裁定为非缺陷）。**不得要求存在真实终态的历史保持「已中断」**；原评审的验收标准会误伤这一正确行为。
- **只有合成结果的取消/失败**：实时可能先被 `interruptTurnItems` 标为「已中断」；若日志中没有真实终态、只有合成 closer，历史会变成「失败」。这才是本缺陷覆盖的范围。

#### 已识别的三类合成/跳过结果

1. **崩溃/未闭合尾回合恢复**：`TOOL_OUTCOME_UNKNOWN`（已启动）或 `TOOL_NOT_STARTED`（未启动），由 `repair.ts` 生成并持久化。
2. **取消时尚未 dispatch 的跳过调用**：`appendSkippedToolCall` 写入真实的 `tool/call` + `tool/result`，错误码 `ABORTED_BEFORE_DISPATCH`（`deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:238-242`、`:249-260`）。这些调用**实时从未出现过工具卡**（没有 `tool/start`），历史却会出现一张「失败」卡，结果文本为 `Error: tool call aborted before dispatch`。
3. **step 失败时未 commit 的已启动调用**：`agent.ts:344-355` 的 `ToolCallRecovery` 追加 `TOOL_OUTCOME_UNKNOWN`；这不只发生在用户取消，也发生在真实回合失败（`turn/end` reason 为 `error`）。规格 §7 把「取消或回合失败」都归入 `interrupted`。

#### 最终修复方案（已落地）

1. **解析层**：`session-view.ts:184` 解析 `data.error.code`，并预扫描 `turn/end` 的 `reason.kind`（`aborted` / `error` / `interrupted`；见 `deepseek-harness/packages/core/session/src/types.ts:202-230`）。
2. **契约层**：`SessionDetailRecord` 增加 `synthetic?: "interrupted" | "resultMissing" | "hidden"`（`rpc-types.ts:350`）；`sessionChannel.ts:165` 据此映射，`session-view` 在返回记录前过滤 `hidden`。
3. **最终语义（owner 已确认）**：
   - **真实结果**（含 `TOOL_ABORTED`、`TOOL_TIMEOUT`）→ 维持失败/完成事实；这是 §6.3 与 D5 的要求。
   - **合成 + `turn/end` reason 为 `aborted` 或 `error`** → `interrupted: true`（显示「已中断」）。
   - **合成 + `turn/end` reason 为 `interrupted`（崩溃恢复）** → `resultMissing: true`（显示「结果未记录」）。
   - **`ABORTED_BEFORE_DISPATCH`** → `hidden`：不生成卡片（实时本来就没有卡片），同时移除配对的 `tool/call` 记录。
   - **`TOOL_NOT_STARTED`** → `hidden`：不生成卡片，消除无匹配英文 note。
4. **附带清理（已实施）**：`selectSubtask` 改为先 open 再 resume，作为首次读取的附带清理；数据层修复仍覆盖已污染日志。

#### 裁定结果（2026-11-03）

- **D2**：已确认重开；`selectSubtask` 已改为 open-before-resume，数据层同时覆盖已污染日志。
- **D5**：保持原裁定；真实 `isError` 终态仍显示「失败」，I-2 只处理没有真实终态的合成结果。
- **规格文档**：实现语义已落地；`docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md` 的最终语义已同步（2026-11-03），覆盖头部状态与 §5.1/§5.2/§5.4/§6.1/§6.3/§6.5/§7/§8/§9/§10/§11。

#### 验收

- **有真实终态**：实时与历史都显示真实失败/完成；不得强制「已中断」。
- **无真实终态 + 取消/失败**：历史显示「已中断」，不得出现「失败」或「含失败调用」。
- **无真实终态 + 崩溃恢复**：历史显示「结果未记录」，不得漂移为「失败」。
- **跳过调用**：不得出现「用户从未见过运行、历史却显示失败」的卡片；按裁定不生成卡片，主机解析测试覆盖 `hidden` 过滤。
- **`TOOL_NOT_STARTED`**：无匹配英文 note 已消除；按裁定不生成卡片，主机解析测试覆盖该错误码过滤。
- 四条路径（首次打开、resume 写盘后再次打开、「继续此会话」、运行记录回填）共用同一 `session.open`/`historyItemsFromRecords` 数据层；本轮 UNIT-ONLY 覆盖解析与映射，路径级真机未执行。
- 所有验收项逐项跑或标注 `UNIT-ONLY` / `MOCK` / `BLOCKED`；局部测试通过不得写成全量门禁通过。

---

### I-3 实时自动化运行标签没有 `user` 条目，`turnFinal` 不生效（已裁定纳入）

- **实施状态（2026-11-03）**：已按「视为合成回合」裁定实施并提交 `b7aaa5ef5f`；`run-end` 与 `session/end` 均可结算。

- **现象（修复前）**：实时自动化运行标签由 `automation/run-start` 创建，初始只有一条 `note`（`App.tsx` 的 `automation/run-start` 分支），没有 `user` 条目。`applyTurnFinalToTabs` 找不到最近的 `user` 时直接返回原 tabs，因此运行结束/取消时：
  - `applyFinalForTab` 对该标签是 no-op；
  - 在途工具不会被标 `interrupted` / `unconfirmed`；
  - 面板的 `final` 永远为 `false`，在没有可见助手正文时保持展开；
  - 取消后没有真实 `tool/end` 的工具会一直显示「运行中」。
- **影响范围**：实时运行标签。历史回填路径（`App.tsx:1699`）会补 `historicalTurnFinalByUserId` 与 `turnFinalWithoutUser: true`，所以问题主要在实时运行标签。
- **范围裁定**：owner 已裁定纳入本功能。规格 §4.2/§5.1 以 `user` 条目划分回合，运行标签不是用户回合；规格 §3 的范围内是「父会话普通工具」，自动化运行会话也是父会话，但 §9 的真机清单未覆盖运行标签。
- **最终处置（已落地）**：选择「把运行标签视为一个合成回合」——`turnFinalWithoutUser` + `run-end` 终态事件，使 run-end/cancel 能结算；未采用「运行标签不投影工具面板」与「登记为债务」。
- **验收（已纳入）**：取消/结束时面板按真实终态收起；在途工具不显示「运行中」；不误标「已中断」/「未确认」；与用户回合的面板互不影响。

---

## 四、可稍后处理（Minor & Nit）

### m-1 没有用户条目的历史片段默认展开

- **实施状态（2026-11-03）**：已随 I-3 顺带关闭——三处历史回填置 `turnFinalWithoutUser: true`，无 user 的历史片段默认收起。
- **现象（修复前）**：`historicalTurnFinalByUserId` 仅收集 `kind === "user"` 的条目（`toolPanel.ts:186-188`）。全段历史中若无标准用户条目（例如由自动化/续轮启动，或全为 note）且无可见助手正文，投影尾部片段的 `final` 会为 `false`（`toolPanel.ts:321-326`），导致面板默认展开。
- **影响**：仅发生在极端边缘日志中，且用户手动点击即可折叠。实时运行标签的同类问题已由 I-3 单独覆盖，不重复计入本项。

### m-2 `ToolCard` 两字段注释与规格对调

- **实施状态（2026-11-03）**：已修，`unconfirmed` / `resultMissing` 注释按规格修正。
- **现象**：`App.tsx:243-246` 中字段注释与设计规格 §6.1/§6.5 颠倒：`unconfirmed` 的注释举了断连例子，`resultMissing` 的注释写成了「回合已终结但该工具始终没有结果」。
- **影响**：纯代码注释偏差，运行时逻辑已在 `toolPanel.ts` 中得到测试锁死。代码重构或整理时顺手修正即可。

### N-1 `goal/state complete` 边沿在途工具短暂闪烁「状态未确认」

- **实施状态（2026-11-03）**：已修。goal outcome 只封口回合，不把在途工具标 `unconfirmed`；后续真实 `tool/end` 或 `session/end` 才结算。
- **现象**：在目标续轮中，`update_goal` 触发目标完成时，会话事件 `goal/change`（携带 `complete`）会先于 `update_goal` 自身的 `tool/end` 到达（`bridge.ts:176-196`）。此时 App 的 `applyFinalForTab` 判定为 `outcome` 边沿并立即将当前回合封口，导致当前在途的 `update_goal`（及并发命令）被短暂标记为 `unconfirmed`，回合条闪烁「工具状态未确认」。片刻后真实的 `tool/end` 到达并清除该标记。
- **定性**：规格 §5.1 要求目标完成时「立即设置 final」带来的固有并发时序副作用。虽然能自我修正，但存在短暂的状态误报。建议后续优化或在规格中记录为已知现象。

### N-2 `applyFinalForTab` 在 setState updater 延后读取目标相位

- **实施状态（2026-11-03）**：已修，相位在 `applyFinalForTab` 调用时同步取样后显式传入 updater。
- **现象**：`App.tsx` 的 `applyFinalForTab` 中，`goalTurnRef.current.phases[...]` 原先是在 `setChatTabs` 的函数式 updater 内部读取的。React 的 updater 在队列 flush 时才会执行，如果同一批微任务中目标相位发生再次跳变，updater 内读取到的相位可能不是事件触发瞬间的相位快照。
- **定性**：现有单线程消息循环与逐条 WS 回调（`api.ts:216-219`）下极难触发实际错乱，风险极低。建议在调用 `applyFinalForTab` 时在外部同步取样相位并显式传参。

### N-3 `applyTurnFinalToTabs` 的冗余分支

- **实施状态（2026-11-03）**：已随 I-3 顺带清理，`wasFinal` 的重复计算与早退已合并。
- **现象（修复前）**：`toolPanel.ts:170-176` 先按 `wasFinal` 计算 `items`，随后又用 `if (wasFinal) return tabs` 早退；`wasFinal` 为真时 `finalizeTurnTools` 不会执行，`items` 也无消费者。
- **定性**：行为正确，纯可读性债务，顺手清理即可。

---

## 五、复审后确认不列为缺陷的点

1. **取消后迟到的真实失败终态优先**：取消发生后，若 Host 随后传回真实的 `tool/end { isError: true }`（包括 bash 取消产生的 `TOOL_ABORTED`），该工具将显示「失败」。这完全符合规格 §6.3「迟到的真实终态优先」原则，真实客观结果优先于中断推断；D5 真机证据与裁决与此一致。I-2 的验收不得要求存在真实终态时历史保持「已中断」。
2. **`goal/round-limit` 标记未确认**：目标达到轮次上限时，仍在开始态的工具被标记为 `unconfirmed`。规格 §7 明确将「已中断」严格限定于用户取消与回合明确失败，因此此处记为未确认语义正确。
3. **空结果显示「无输出」**：工具返回文本为空字符串时，单项详情显示「无输出」（`toolPanel.ts:285-288` 将空字符串落入兜底）。符合规格 §5.4 对已收到空结果的定义。
4. **Task 6 的 `parentTurnLine` 代码结构**：代码完全忠实于计划 Task 6 的既定设计，不是笔误或漏写，问题本质是规格冲突（I-1），应以规格为真相源调整；已按 I-1 修复。
5. **历史里的真实 `ABORTED` 结果显示失败**：这是真实工具终态，不是合成 closer；历史显示「失败」与实时一致，不属于 I-2。

---

## 六、最终合并建议与验收标准

**合并建议**：

- **I-1、I-2、I-3**：**已实施并提交 `b7aaa5ef5f`**。owner 已确认重开 D2/D5、按本版合成语义映射、未启动调用不生成卡片、I-3 纳入本功能；设计规格已同步到最终语义；I-2 合成历史真机 GUI 已通过。剩余：I-1/I-3/N-1/N-2 的 GUI 场景与推送。
- **m-1**：已随 I-3 顺带关闭；**N-3** 已顺带清理；**m-2、N-1、N-2** 已修（2026-11-03）。

**修复验收闭环清单**（以下为验收标准；已在 HEAD `b7aaa5ef5f` 的定向/全量门禁验证，真机项除外）：

1. **I-1 验收**：
   - 断连（`sidecarDead`）或回合终态遗留未确认工具时，即使当前会话存在活跃的子代理运行，底部回合条仍坚决显示「工具状态未确认」；
   - 工具全部有明确结果且子会话活跃时，回合条正常显示「主会话运行中」；
   - 新增「`hasActiveChild=true` + `toolsUnconfirmed=true`」的纯逻辑/接线测试。
2. **I-2 验收**：
   - **真实终态**：正在执行工具时点击停止（取消），实时与历史都显示真实终态（失败或完成）；不得强制「已中断」；
   - **合成 + 取消/失败**：日志没有真实终态时，历史显示「已中断」，严禁漂移为「失败」或「含失败调用」；
   - **合成 + 崩溃恢复**：对未闭合且缺结果的异常日志，无论首次打开、被 `session.resume` 补写写盘后再次打开、还是经「继续此会话」与「运行记录回填」，面板必须稳定显示「结果未记录」，不得漂移为「失败」；
   - **跳过调用**（`ABORTED_BEFORE_DISPATCH`）：不得出现用户从未见过运行、历史却显示失败的卡片；按裁定不生成卡片，主机解析测试覆盖 `hidden` 过滤；
   - **`TOOL_NOT_STARTED`**：无匹配英文 note 已消除；按裁定不生成卡片，主机解析测试覆盖该错误码过滤。
3. **I-3 验收**：运行结束/取消后，运行标签的面板按真实终态收起；在途工具不显示「运行中」；不误标「已中断」/「未确认」；不影响用户回合。
4. **m-1** 已顺带关闭、**N-3** 已顺带清理、**m-2/N-1/N-2** 已修；不卡合并。

---

## 七、核对依据与验证结果

- **核对依据**：本版结论来自对 `de2cd6e378` 实现代码、`deepseek-harness` 的 `agent-loop`/`session`/`tool-bash` 调用链，以及 `docs/evidence/2026-11-02-chat-tool-panel-verification.md` 中 D2/D5 的真机记录与裁决。
- **实施后验证（HEAD `b7aaa5ef5f`）**：`corepack yarn check:whitespace` 7/7、`corepack yarn check` exit 0、`corepack yarn test` exit 0、`corepack yarn typecheck` exit 0；定向 15 文件 286 passed。详见顶部〈实施状态〉。
- **验收范围**：本轮为 **UNIT-ONLY**（宿主解析、客户端映射、投影与 App 接线）；真机 GUI 项未执行，不得写成通过。
- **未执行项**：I-2 合成历史真机 GUI 已通过；I-1 活跃子运行 + 未确认、I-3 自动化运行标签、N-1 goal outcome 闪烁、N-2 相位时序的 GUI 未执行；未 push。未执行项不得写成通过。
- **剩余文档项**：无。设计规格 `2026-11-01-chat-tool-panel-design.md` 已同步到最终语义（2026-11-03），实现、规格与评审文档一致。
- **裁定状态**：D2/D5 重开、合成结果的语义映射、`TOOL_NOT_STARTED`/`ABORTED_BEFORE_DISPATCH` 不生成卡片、I-3 纳入，均已由 owner 确认并落地；规格文本已同步，无剩余待裁定项。
