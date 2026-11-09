# 《会话内工具面板》实施计划评审意见

- **评审对象**：`docs/superpowers/plans/2026-11-02-chat-tool-panel.md`（第一轮 2212 行 / 第二轮 2233 行 / 第三轮 2363 行）
- **对照基准**：`docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md`（含第二轮修订的 `turnFinal` / `outcome` 边沿）；评审校准见 `docs/superpowers/specs/2026-11-01-chat-tool-panel-design-review.md`
- **评审方式**：只读。核对计划的任务顺序、纯函数、测试钉和退出条件是否能按规格直接开工。未改计划、设计或代码
- **评审轮次**：三轮，意见均落在本文档。第一轮阻断项由计划修订 `:136-155` 收口；第二轮 2 Major + 4 Minor 由第三轮核验全部闭环
- **当前总结论（第三轮，2026-11-02）**：**已达到实施标准，可从 Task 1 开工**。第二轮全部 6 项意见闭环核验通过，修订未引入新问题；两点非阻断观察见第三轮末尾

---

## 第一轮（历史记录：阻断项已收口）

> 状态注记（2026-11-02 第二轮复核时补）：本轮评审针对 2212 行版本，当时提及的同内容副本 `plans/2026-11-02-chat-tool-panel.md` 已不存在，现在只有 `docs/superpowers/plans/` 这一份。本轮唯一阻断项（下述 `bridge.spec.ts:683` 用例的期望同步）已由计划修订收录在当前版本 `:136-155`，经第二轮复核确认修复完整。

**当时的评审结论**：差一处即可开工。规格里已经裁定的行为都写进了任务、纯函数和测试。Task 1 第 4 步写的「既有测试不回归、预期 PASS」当时因下述用例未同步而不成立。

### 已经能照着做的部分

11 个任务按契约、投影、接线、组件、门禁、真机验收排开。每个任务都有失败测试、实现片段和单独的命令。局部测试、类型检查、root 门禁和图形走查分开记录。

下列规格裁定在计划里有唯一实现，不需要实现者再选：

- `turnFinal` 一旦为真，就不会被后面相位仍为 `active` 的成功 `session/end` 翻回 false。`reduceTurnFinal` 开头即 `if (current === true) return true`。
- `endFirst` 要求 `observed[3] === true`：`goal/state complete` 的真实 `outcome` 当时就结算，不等第二次 `session/end`。
- 断连只认 `sidecarDead`，不写执行终态。套接字关闭回调里禁止调用 final helper。
- 旧历史只有调用、没有结果时使用 `status="end"`、`hasResult=false`、`resultMissing=true`，标题和单项显示「结果未记录」。

### 当时的阻断项（已修复）

Task 1 把父会话 `tool/start` 加上 `args`，并让 `tool/end` 始终携带 `text`。计划当时只要求改写既有用例 `bridge carries todo_write todos...` 的两个 start 期望，漏了同一文件里的精确对象断言：

`dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts:683`，用例 `bridge keeps an unregistered session unchanged while a registry is present`。该用例在 `:710-716` 执行：

```ts
await execute({ name: "read", callId: "call-parent", arguments: { path: "a.md" }, agent: parentAgent }, async () => ({
  isError: false,
  content: [{ type: "text", text: "ok" }],
}));
assert.deepEqual(emitted, [
  { event: "tool/start", name: "read", callId: "call-parent", sessionId: PARENT_SESSION },
  { event: "tool/end", name: "read", callId: "call-parent", sessionId: PARENT_SESSION },
]);
```

这次调用带了 `arguments: { path: "a.md" }`，结果文本是 `"ok"`。实现后 start 会多出 `args: '{"path":"a.md"}'`，end 会多出 `text: "ok"`。当时 Task 1 第 4 步却写「两条命令均 PASS」。

同文件 `bridge caps tool output...` 的 start 期望可以保持不变：那次调用没有 `arguments`，`formatToolArguments(undefined)` 不会发出 `args`。

**处置**：在 Task 1 更新既有断言的步骤里加上 `bridge.spec.ts:714-716` 的期望同步。——已由计划修订收录（当前版本 `:136-155`）。

---

## 第二轮（2026-11-02，对 2233 行版本的复核意见）

> 状态注记（2026-11-02 第三轮复核时补）：本轮 6 项意见（M-1/M-2/m-1/m-2/m-3/m-4）已全部由计划修订闭环，逐项核验见第三轮。
> 本轮先对第一份评审草稿做了 double check（逐条重放证据链、对关键断言做运行实测、补查可达性），再落档。复核结论：**两个 Major 均实证成立，无误报或夸大**；Minor 维持；另订正草稿中两处自我失准，并新增一条复核中发现的问题（m-4）。

### 复核方法与自校正

- **M-1 实证**：用计划 Step 3 给出的 `formatToolArguments` 实现逐字复刻后以 node 运行（含 `parseToolArguments` 语义），比对 Step 1 期望值，`equal: false`。
- **M-2 实证**：重读计划 `:866-879` 原文确认括号缺失。
- **m-1 可达性补查**：`send()` 仅以 `turnActive` 为发送闸（`App.tsx:2074`），而 `active` 相位中间 `session/end` 会置 `turnActive=false`（`App.tsx:3578`）、直到下一个 `goal/round` 才恢复（`App.tsx:3574`）——竞态窗口真实存在但窄。
- **草稿自校正 1**：第一份草稿称「Task 1 对 bridge.spec 三个既有用例点名很清楚」——实为**两个**（todo/bash 用例与 unregistered session 用例）；caps 用例本就无需改（其执行体无 `arguments`，第一轮已正确指出）。
- **草稿自校正 2**：「既有 21 个 App 接线契约」计数无法复现：实测 `appWiring.spec.ts` 顶层测试 **22** 个、其中读取 `APP_SOURCE` 的 **17** 个，无论哪种口径都不是 21。该项由「计数漂移风险」升级为「计数与现状不符」。
- **新增 m-4**：见下，第一份草稿遗漏。

### 已核实为准确的部分（复验清单）

- 基线 HEAD `ff897f713c` 与仓库当前 master 一致；第一轮阻断项的修复（计划 `:136-155` ↔ `bridge.spec.ts:714-716`）完整收录。
- `bridge.spec.ts` todo/bash fixture（`:479`）与计划期望的 `args` 值逐字匹配；caps 用例（`:143-146`）不受 Task 1 改动影响。
- 三处历史消费点真实存在且 `items` 变量可用：`selectSubtask`（App.tsx:786）、运行记录回填（App.tsx:1622-1634）、`resumeFromView`（App.tsx:2531，需提取变量，计划已写明）。
- 既有 appWiring 测试 `resuming an existing session tab...` 的 `/items: historyToChatItems\(view\)/` 断言（appWiring.spec.ts:457）与计划预告的修改一致；其 existing-branch 禁词断言（`:443-449`）不受影响。
- `contentItems` 的 attachment→assistant 映射（App.tsx:3674）存在，满足规格 §5.1「附件算可见正文」。
- `reduceTurnFinal` 与 `goalRound.ts` 的 action 语义逐条一致（取消/失败→true；round-limit→`goal-stopped`→true；complete 且真实 `outcome`→true；`active` 成功中间结束→false；paused/blocked/complete/无相位→true；`stopped:true` 的 goal/state→action none→不翻转，由 settleStop 路径结算）。
- `turnStatus` 新分支插入位（runningTool 分支之前）与既有用例兼容；`interruptTurnItems`（thinkingPanel.ts:54-72）只标 thinking/assistant，与 `finalizeTurnTools` 无冲突。
- styles.css 全部所需 token（`--error`/`--border`/`--surface`/`--radius-md`/`--accent`）存在；`.sr-only` 无冲突；`gen:styles`、`styles-generated.spec.ts`、jsdom+React Harness 模式（SubagentRunCard.spec.ts）均有先例。
- 计划的「两份事件联合」源码钉测试成立：`event: "tool/start"`/`event: "tool/end"` 在 bridge.ts（`:21`/`:28`）与 rpc-types.ts（`:421`/`:430`）的首个出现位置都在联合内，tool/end 后 240 字符窗口内 `truncated?: boolean` 恰一次。
- 门禁命令与仓库脚本一致；串行要求呼应已知 `verify:aa` 并发竞态债务。

### Major（阻塞实施，均实证成立）

**M-1｜Task 1 Step 1 测试期望与 Step 3 实现自相矛盾（多行参数用例）。**
计划 `:73` 期望 `formatToolArguments({ path: "a.md", note: "一  行\n换行" })` 产出 `'{"path":"a.md","note":"一 行 换行"}'`。但 `JSON.stringify` 会把真实换行转义为字面 `\`+`n` 两字符，随后的 `replace(/\s+/g, " ")` 不再命中——用计划自己的实现（`:188-203`，与历史 `formatArgs`（session-view.ts:297-312）逐字等价）实测，实际产出是 `{"path":"a.md","note":"一 行\n换行"}`（保留字面 `\n`），**不相等**。Step 3 的实现符合规格 §6.2「保持现有行为」，错的是 Step 1 的期望值。后果：Task 1 Step 4 声称的「Expected: PASS」无法达成，而 Task 9 Step 1 又明文禁止「通过删除断言或放宽文案绕过」，实现者被迫在改测试与改实现之间自行裁定，后者会偏离规格硬约束。修法：按历史行为订正期望值（保留字面 `\n`），或删除该子断言；不得改实现去凑测试。

**M-2｜Task 4 Step 1 测试代码语法错误。**
`an active goal round note and later tools reuse the same expanded panel` 用例（计划 `:866-878`）缺少收尾 `});`，`:879` 直接嵌套下一个 `test(`。逐字落盘即解析失败，Task 4 Step 2 的「Expected: FAIL（因 `projectToolPanels`/`toolDescription` 未导出）」会被语法错误劫持，失去 TDD 判定意义。该计划风格承诺测试代码可逐字执行，此类缺陷说明计划文档缺少一次落盘自校验。

### Minor（建议裁定后修正或登记）

**m-1｜无 callId 的 `tool/end` 匹配被限定在当前回合内，偏离规格 §6.3 字面规则。**
规格：「无 `callId` 时按『同名且仍在运行』选择最早一个匹配项」（无回合限定；「运行中」已由 §6.1 定义为 `status === "start"` 且无中断/未确认/结果缺失标记）。计划的 `applyToolEnd` 把无 callId 搜索起点设为 `currentTurnStart(items)`（计划 `:673`）。可达性复核：`send()` 仅以 `turnActive` 为闸（App.tsx:2074），而 `active` 相位中间 `session/end` 会瞬断 `turnActive`（:3578）直到下一个 `goal/round` 恢复（:3574）——在该窗口内发出新消息后，迟到的旧回合无 callId 终态在计划实现下会错过旧回合工具、可能错误套到新回合的同名运行工具（规格字面规则会命中旧回合那把）。窗口窄且叠加「无 callId 工具」这一罕见前提，维持 Minor：要么对齐规格，要么在计划中显式登记偏差与理由。

**m-2｜appWiring.spec.ts 未按规格 §8.3 使用 `reduceGoalTurn` 真实返回动作。**
规格明文「`appWiring.spec.ts` 必须使用 `reduceGoalTurn` 的真实返回动作，不以『看到 complete』代替边沿判定」；计划的 appWiring 新增（Task 6 `:1415-1439`、Task 8 `:1939-1949`）全部是源码 regex 钉，真实动作行为测试放在 toolPanel.spec.ts（Task 5 `:1172-1210`，确以真实 `reduceGoalTurn` 输出驱动 completeFirst/endFirst，规格警告的反模式未被踩中）。组合语义等价（接线由 regex 钉住、行为由纯函数测试钉住），但落点与规格明文不一致：登记偏差，或把该行为用例落进 appWiring.spec.ts。

**m-3｜精确性小项。**
① Task 2 对既有 sessionChannel 测试的处置只写「替换/扩展」，未点名 `historyItemsFromRecords maps roles, tool calls and failed results` 用例——其旧断言（成功结果不进卡、失败变 note）与新配对语义必然冲突；对比 Task 1 逐个点名两个 bridge 用例的明确度，应对齐。② Task 2 所称「新增」的 `record.text.split("[exit code: 1]")` 断言在 session-view.spec.ts:265 已存在，真正新的只有 `truncated: true`。③ Task 6 声称「既有 21 个 App 接线契约不回归」，实测 22 个顶层测试、17 个读 APP_SOURCE，均非 21，需订正或注明口径。④ 新样式段头 `/* ---- 工具面板 */` 与文件既有 `/* ---- X ---- */` 惯例不一致（计划内部自洽，仅观感）。

**m-4｜目标续轮会话的历史恢复面板碎裂（复核新增，规格与计划均未处理）。**
证据链：goal 驱动的 `user/message`（`source.kind=goal`，round>0，即 `goal/round` 的日志来源，bridge.ts:161-166）不被 session-view.ts:188-192 的 plugin/tool 过滤 → 落为 `kind:'user'` 记录 → `historyItemsFromRecords` 产 user 条目 → 计划投影按 user 分段：**每个 goal round 一个面板**，且 `historicalTurnFinalByUserId` 把每轮都标 final。live 路径则相反：`goal/round` 只加 note（App.tsx:3571-3575），同一用户回合单面板。同一会话 live 1 面板 vs 恢复 N 面板，与规格 §5.1「后续 `goal/round` 仍属于同一个用户回合和同一个工具面板」在恢复视图的成立性、以及 §1「实时事件与历史恢复使用一致的状态语义」存在张力。需要裁定：在历史配对/投影层合并 goal 源 user 记录，或显式接受差异并登记为已知行为（注意：goal 驱动消息在今天的历史恢复里本就显示为 user 气泡，属既有形态，本项只登记其新引入的面板碎裂后果）。

**处置（2026-11-09）**：`2026-11-09-per-step-tool-board-design.md` R-1 / R-7 关闭 goal 续轮导致的历史面板碎裂。工具看板在普通工具范围内两侧逐轮；有效 `todo_write` 实时转待办卡、历史仍入工具卡，两侧数量可能不同，已登记为残余债，不能写成「完全一致」。

### 处置建议

1. M-1、M-2 为低成本文档修复（订正一处期望值、补一个 `});`），修完即消除阻塞。
2. m-1、m-2、m-4 需逐条裁定：对齐规格，或在计划中登记偏差/接受理由；m-3 随手订正。
3. 第一轮已证明计划作者对评审意见响应良好（`:136-155` 一轮收口）；建议将本轮意见回给计划作者修订后再进实施，不宜带病开工——两个 Major 恰好都落在「计划自身可执行性」上，是 subagent 逐字执行时无法自愈的类型。

---

## 第三轮（2026-11-02，对 2363 行版本的闭环核验）

计划由 2233 行修订至 2363 行（+130）。本轮只做一件事：逐项核验第二轮 6 项意见是否闭环，并检查修订是否引入新问题。

**本轮结论：6 项全部闭环，修订未引入新问题，计划达到实施标准，可从 Task 1 开工。**

### 逐项闭环核验

| 项 | 闭环方式 | 核验证据 |
| --- | --- | --- |
| **M-1** 期望值矛盾 | 期望订正为 `'{"path":"a.md","note":"一 行\\n换行"}'`（TS 源码 `\\n` = 运行时字面 `\n`，计划 `:73`） | 用计划实现逐字复刻后 node 实测 `equal: true`；与历史 `formatArgs` 行为一致，实现侧未动 |
| **M-2** 缺 `});` | 已补（现 `:963`） | 重读原文确认；修订区全部新测试块（`:614-685`、`:951-978`、`:307-334`、`:1516-1568`）括号逐块配平核验 |
| **m-1** 无 callId 回合限定 | **对齐规格**而非登记偏差：`applyToolEnd` 无 callId 路径改为从全部条目选最早同名开始态（`:754-798`，附注释）；新增跨回合无 callId 测试（`:658-668`）钉住「迟到终态不错套新回合的工具」 | 与规格 §6.3 字面规则一致；既有三组测试（同回合并发、callId 跨回合、同回合无 callId unconfirmed）全部相容 |
| **m-2** appWiring 未用真实 action | **落进 appWiring** 而非仅登记：新增 `reduceGoalTurn` 导入与真实 endFirst 序列（`:1513-1543`），行为断言 `deepEqual(observed, [false, false, false, true])`，再加既有 regex 钉 | 四步推导逐一手验正确（turn-started→none；active 边沿→none；active 中间 end→false；complete 且真实 outcome→true），满足规格 §8.3 明文 |
| **m-3** 四个精确性小项 | 全修：① 点名既有用例 `historyItemsFromRecords maps roles, tool calls and failed results`（`:30-52`）及「替换」处置，保留空记录/孤立成功覆盖（`:337`）；② 断言措辞改为「扩展既有断言；保留其后的既有 split 断言，不重复添加」（`:296`）；③ 计数订正为「22 个顶层（17 个读 `APP_SOURCE`）」（`:1679`），与第二轮实测一致；④ 样式段头改 `/* ---- 工具面板 ---- */`（`:1980`），测试同步（`:1874`） | 逐条比对修订原文 |
| **m-4** goal 续轮历史碎裂 | 按「合并 goal 源记录」路线**三层落实**：契约层 `SessionDetailRecord` user 变体增加 `goalRound?: number`（`:405-410`），`detailRecords` 只增元数据、记录仍 `kind="user"`、只读历史页继续显示原文（`:412-433`）；恢复层 `historyItemsFromRecords` 把 goalRound 记录转为与实时同文案的 note、不切分用户回合（`:473-477`）；测试层三层钉——session-view 元数据测试（`:307-317`，`userMessage` helper 兼容已核实 session-view.spec.ts:31）、sessionChannel note 化测试（`:323-334`）、投影单面板默认收起测试（`:965-978`）；Task 11 Step 5.4 验收项同步（`:2345`） | `historicalTurnFinalByUserId` 只计真实 user（note 不入），final map 语义随之正确；与第二轮建议的「合并」路线一致 |

### 新引入内容检查（无新问题）

- `goalRound` 契约不破坏任何现有断言：session-view.spec.ts 现存零 goal fixture（实测 grep 零命中），条件展开只在 goal 消息上新增键。
- `sessionChannel.ts` 导入 `goalRoundLabel`（goalRound.ts 零导入）无环。
- File Structure（`:30`/`:33`/`:34`）、Task 2 标题与 Interfaces（`:280`/`:292`）、Task 2 Step 2/4 的预期描述（`:401`/`:561`）均同步 goal 续轮口径，无残留旧表述。
- Task 4 投影实现、Task 7 组件与 CSS、Task 8 接线与既有正向锚点清单经抽查未回退。

### 两点非阻断观察（仅记录，不需要处理）

1. Task 6 Step 2 的 outcomeCheck 新测试钉的是既有行为（`status === "start"` → 命令未通过），Step 2 时即可能通过——但整条命令仍因 turnStatus/appWiring 新断言而 FAIL，「Expected: FAIL」对命令整体成立。
2. goal 恢复视图的驱动消息原文从「user 气泡」变为标准续轮 note——这正是与 live 对齐的意图（live 从不显示驱动消息原文，只显示 note），原文仍可在只读 `HistoryDetailPane` 逐条查看；属规格 §1 一致性目标的正向收敛。

### 收口

三轮评审全部收口。计划可按其自身约定（superpowers:subagent-driven-development）从 Task 1 开工；实施期的回归与门禁证据按计划 Task 9–11 落 `docs/evidence/2026-11-02-chat-tool-panel-verification.md`，与本评审文档互不替代。
