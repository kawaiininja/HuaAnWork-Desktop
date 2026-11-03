# 会话内工具面板设计

- 日期：2026-11-01
- 状态：已按第一、二轮评审、代码评审复核与 owner 裁定同步（2026-11-03）；实现已落地（`b7aaa5ef5f`），实施后订正见 §11
- 实施边界：仅 HuaAnWork 桌面客户端及其现有工具事件、历史恢复链路

## 1. 背景与目标

当前普通工具调用以独立 `tool` 消息插入会话流，部分输出还会在工具行下方直接展开。连续调用会拉长会话区，削弱用户消息、思考与助手正文之间的可读性。

本设计在不重写工具执行链路的前提下：

- 每个用户回合聚合成一个会话内工具面板。
- 工具执行时显示简短、通用的中文说明。
- 面板内默认只显示工具摘要，用户可逐项展开参数摘要与结果。
- 保留审批、自由文本输入、待办和子代理运行卡的现有入口与可操作性。
- 实时事件与历史恢复使用一致的状态语义，不伪造缺失结果或未知终态。

## 2. 已确认的产品选择

| 决策点 | 已确认方案 |
| --- | --- |
| 面板位置 | 会话内聚合面板，不使用右侧页签或底部抽屉 |
| 聚合范围 | 每个用户回合一个面板 |
| 执行说明 | 按工具名提供通用说明，不使用参数推断任务目的，不增加模型调用 |
| 详情层级 | 工具列表加单项展开，展开后查看参数摘要与结果 |
| 数据组织 | 方案 A：保留扁平工具消息，渲染时按回合聚合 |
| 自动行为 | 执行期间默认展开；正文出现或回合结束后默认收起；手动选择优先 |

## 3. 范围与非目标

### 范围内

- 父会话普通工具的 `tool/start`、`tool/end` 展示。
- 工具参数摘要、经现有上限截断后的结果文本、失败与截断状态。
- 当前会话实时事件与磁盘历史恢复。
- 工具面板的展开状态、单项详情、长内容滚动与读屏状态。
- 取消、回合失败、正常回合结束但缺少结果、Host 断连等异常展示。

### 非目标

- 不改变工具调用的实际执行、审批、权限或返回路径。
- 不由模型额外生成执行说明，不增加模型请求。
- 不承诺展示完整原始 JSON 参数；参数沿用现有摘要格式和长度限制。
- 不把 `todo_write` 待办卡、审批卡、自由文本输入卡或子代理运行卡迁入工具面板。
- 不把子代理内部工具从现有 run 投影改写到父会话工具面板。
- 不新增右侧“工具”页签，不改造现有“进度”页签。
- 不为工具面板建立第二套权威执行状态或持久化存储。

## 4. 架构与组件

### 4.1 扁平消息仍是唯一事实来源

`App.tsx` 继续把每次普通工具调用保存为 `ChatItem` 的 `tool` 条目。以下逻辑继续读取原始 `ChatItem[]`，不读取聚合视图：

- 命令结果核对与回合结论。
- `runningToolName` 等运行状态判断。
- 审批卡的 `callId` 关联与 `insertBeforeToolRow` 定位。
- 思考收尾、待办更新、取消与回合结束处理。

工具面板只是展示投影，不回写一套独立的工具执行副本。

### 4.2 新增纯逻辑模块

新增 `src/client-huaanwork/logic/toolPanel.ts`，负责：

1. 以 `user` 条目划分回合。
2. 收集每个回合内的全部 `tool` 条目。
3. 用位于本回合首个工具位置的虚拟 `tool-panel` 渲染行替换这些工具条目。
4. 保持所有非工具条目的相对顺序不变。
5. 根据条目、按回合提供的 `turnFinal`、`connectionLost` 和可见正文输入，计算面板标题、调用数、执行/完成/失败/中断/未确认/结果未记录状态及默认展开状态。
6. 按工具名生成通用中文说明。

虚拟面板行只存在于最终渲染视图，不加入持久化的 `ChatItem` 联合。`contentItems` 等既有内容视图仍消费扁平数组。纯逻辑模块保持无副作用，但输入不局限于条目数组：`turnFinal` 表示这个用户回合已确定不再继续，`connectionLost` 表示事件套接字已断开，二者由 App 提供。§5.1 的“事件、当前目标相位与 `goalRound` 结算动作 → `turnFinal`”判定也放在本模块的纯函数中；App 只提供事件归属、当前相位、实际 `reduceGoalTurn` 动作并按标签保存结果，不在事件处理器里复制一套判断。

面板是回合级聚合视图，不承担工具与穿插审批卡之间的精确时间排序展示；审批卡仍按扁平数组中的既有位置渲染并保持可操作。

### 4.3 新增展示组件

新增 `src/client-huaanwork/ToolPanel.tsx`：

- 外观参考 `ThinkingPanel` 的标题行与折叠方式，但使用独立组件和样式类。
- 面板标题本身是可键盘操作的展开按钮，带 `aria-expanded`。
- 展开体包含工具列表；每个工具行也可独立展开。
- 单项详情使用纯文本 `<pre>` 或等价安全文本节点，不注入 HTML。
- 面板展开体最大高度为 `40vh`，超出后内部滚动。
- 常驻 `role="status"` 的读屏区域只播报状态迁移，不播报计时或重复渲染。

允许同时展开多个工具详情；面板内部滚动约束整体高度。单项展开状态是组件内 UI 状态，不要求跨标签保留。

### 4.4 App 接线

只有最终消息列表渲染从 `items.map` 改为 memoized 的工具面板渲染视图。原始 `items` 继续提供给其他状态派生逻辑。

面板在回合内的标识取首个工具条目的 `id`。用户的面板展开选择记录在该首个工具条目上，新增 `panelToggled?: "expand" | "collapse"`；因此切换会话标签后仍保留。工具执行事实不写入该 UI 字段。

## 5. 界面行为

### 5.1 出现、可见正文与默认展开

- 回合内没有普通工具调用时不渲染面板。
- 首个 `tool/start` 使面板出现在本回合首个工具位置；若本回合尚无可见助手正文，面板默认展开。
- 后续工具只更新同一个回合面板，不新增会话行。
- 助手可见正文出现后，面板默认收起；后续若继续调用工具，仍更新该面板但不强行重新展开。
- `turnFinal=true` 时面板默认收起，包括工具都已结束但没有思考或正文的取消、失败和正常成功回合。
- 历史恢复的面板默认收起。
- `panelToggled` 始终优先于上述自动规则。

可见正文沿用现有内容视图口径：`assistant` 必须经过 `resolveThinking` 取出的 `visible.trim()` 非空才算；只含 think 标签的文本不算。自动化运行回复折叠成的 `attachment` 先经 `contentItems` 映射回助手正文，因此同样算可见产出。不得只检查是否存在 `assistant` 条目。

`turnFinal` 是按标签、按用户回合计算的显式输入。后出现 `user` 可关闭上一回合并把新回合重置为非 final；当前回合由 App 按以下完整规则设置，不能依赖条目中是否还有 `start` 工具：

- `session/end` 为取消、失败或 `userStopped`：设置 `turnFinal=true`，即使工具全部 `end`。
- `goal/round-limit`：设置 `turnFinal=true`。
- `goal/state` 进入 `complete`，且本次实际 `reduceGoalTurn` 返回 `outcome`：立即设置 `turnFinal=true`，不等待下一次 `session/end`。重复 `complete` 或其他未返回 `outcome` 的 `goal/state` 不得重新翻转状态。
- 成功的 `session/end` 且该会话当前目标相位为 `active`：这是官方续轮中间点，保持 `turnFinal=false`。
- 成功的 `session/end` 且目标相位为 `paused`、`blocked`、`complete`，或该会话没有目标相位：设置 `turnFinal=true`。相位读取现有 `goalRound` 状态记录，不另造目标状态机。

`goal/state complete` 产生实际 `outcome` 时只封口回合（立即 `turnFinal=true`），不把仍在途的工具标 `unconfirmed`；这些工具由后续真实 `tool/end` 或 `session/end` 结算。`session/end`/`run-end` 仍按 §7 处理真正缺终态的工具。

没有用户条目的标签（例如实时自动化运行标签）没有 `user` 回合可归属：按标签维护一个合成回合的终态 `turnFinalWithoutUser`。`session/end` 与 `automation/run-end` 都可以结算它；先到者生效，重复事件幂等；`automation/run-end` 的 `ok=false` 或 `status="cancelled"`、`"error"`、`"timeout"` 按回合失败/取消处理。历史恢复的无用户片段同样按该终态默认收起。该合成回合不改变用户回合的 `turnFinalByUserId`。

因此，`completeFirst` 与 `endFirst` 都能结束面板：后者在 `active` 的中间 `session/end` 时保持展开，在后到的 `complete` 产生 `outcome` 时立即结束，不要求第二次 `session/end`；其后的结束事件只保持既有 final 状态。目标 `active` 的中间结束本身不得收起面板或标记未确认，后续 `goal/round` 仍属于同一个用户回合和同一个工具面板。裸 `session/end` 必须经上述规则判定，瞬时全局 `turnActive=false` 不是直接的收起条件；任何结束信号只能作用于其归属标签和回合。

历史日志中的官方 goal 续轮 `user/message` 必须携带可识别的 `goalRound` 元数据，并在恢复为可聊标签时映射为同一回合的续轮 note，不得生成新的 `user` 条目或额外面板。只读 `HistoryDetailPane` 仍消费原始 `user` 记录并逐条显示原文，不因该恢复规则改变日志形态。

### 5.2 收起标题

标题统一包含调用数 `N`：

- `工具 · 执行中 · N 项调用`
- `工具 · 已完成 · N 项调用`
- `工具 · 含失败调用 · N 项调用`
- `工具 · 已中断 · N 项调用`
- `工具 · 状态未确认 · N 项调用`
- `工具 · 结果未记录 · N 项调用`

状态优先级为：执行中、含失败调用、已中断、状态未确认、结果未记录、已完成。单工具仍保留自身真实状态，标题优先级不改变单项详情。断连时先把受影响的开始态工具从“执行中”集合剔除，再按上述优先级计算；因此没有其他更高优先级状态时，标题必须是“状态未确认”，不能继续显示“执行中”。

历史恢复的合成中断结果以 `status="end"` 落卡时，单项状态仍为「已中断」；`interrupted` 优先于 `status="end"` 的完成/失败判定。真实终态到达时会清除 `interrupted`，不得让推断态盖住真实失败。未启动/跳过调用被宿主隐藏，不进入调用数或状态优先级。

### 5.3 工具列表与通用说明

每个工具默认显示一行：通用说明、原始工具名和状态。当前 `ALLOWED_TOOLS` 的闭合映射如下；未来新增或未识别的名字一律回退为 `正在执行工具`。

| 工具名 | 通用说明 |
| --- | --- |
| `read`、`read_file` | `正在读取文件` |
| `glob`、`grep` | `正在搜索内容` |
| `edit`、`write`、`str_replace_editor` | `正在修改文件` |
| `bash`、`pwsh` | `正在运行命令` |
| `skill` | `正在执行技能` |
| `subagent` | `正在调用子代理` |
| `todo_write` | `正在更新待办` |
| `get_goal`、`create_goal`、`update_goal` | `正在处理目标` |
| `git_status`、`git_diff`、`git_branch`、`git_checkout`、`git_commit`、`git_push` | `正在执行 Git 操作` |
| `web_fetch` | `正在读取网页` |
| `screenshot` | `正在获取截图` |
| `call_host_tool` | `正在调用宿主工具` |
| `propose_plan`、`exit_plan_mode` | `正在处理计划` |
| `request_input` | `正在请求输入` |

说明中不拼接参数、文件路径或命令，不推断“为了完成什么任务”。原始工具名用于准确识别。

单工具状态包括 `运行中`、`完成`、`失败`、`已中断`、`状态未确认`、`结果未记录`；`已截断` 是附加标记，不替代成功、失败或结果缺失状态。

### 5.4 单项详情

点击工具行后显示“参数”和“结果”两节：

- 无参数记录：`未记录参数`。
- 工具仍在执行：`等待执行结果`。
- 已收到结果但文本为空：`无输出`。
- 旧历史只有调用、没有结果：结果区显示 `历史记录未保存结果`，单项状态显示 `结果未记录`；没有其他更高优先级状态时，面板标题也显示 `结果未记录`。
- 已中断或未确认且没有结果：显示对应状态，不显示“无输出”。
- 结果被截断：显示 `已截断` 和现有 capped 文本。
- 历史合成结果：`interrupted` → 结果区显示「已中断」；`resultMissing` → 「历史记录未保存结果」；都不展示合成结果里的模型指令文本，客户端卡片不设置 `isError`。
- 未启动/跳过调用（`TOOL_NOT_STARTED`、`ABORTED_BEFORE_DISPATCH`）：不生成工具卡，也不生成英文失败提示；它们不计入调用数或面板标题。

“结果未记录”只说明日志缺少结果记录，不声称工具成功、失败或仍在运行。参数和结果自动换行；其中的 HTML、脚本样式文本或 Markdown 不执行。

## 6. 数据流

### 6.1 ToolCard 数据与连接输入

在现有字段上补充：

- `args?: string`：与历史记录一致的参数摘要。
- `hasResult?: boolean`：是否实际收到或恢复到结果；收到空结果也为 `true`。
- `interrupted?: boolean`：取消或回合失败时，尚未结束的工具被标记中断。
- `unconfirmed?: boolean`：已确定 `turnFinal` 的正常回合结束时，仍未收到工具终态的标记。
- `resultMissing?: boolean`：历史恢复时只有调用记录、没有可配对结果记录的标记。

保留现有 `output`、`command`、`truncated`、`isError`、`status` 和 `callId`。实时运行中的有效状态为 `status === "start"` 且没有中断、未确认或结果缺失标记；`runningToolName` 等消费方也采用这一定义。`turnFinal` 的正常结束缺终态与 `resultMissing` 是两种不同语义，不得互相复用。

历史合成结果由宿主归一化为 `SessionDetailRecord.tool-result.synthetic`：`interrupted`、`resultMissing` 或 `hidden`。`hidden` 在 `detailRecords` 返回前过滤；可聊历史与只读历史页都不显示这些从未 dispatch 的调用。客户端映射为 `interrupted`/`resultMissing` 时不设置 `isError`（宿主记录保留原始 `isError` 事实）。

面板的 `connectionLost` 只取 `sidecarDead`。`hostPhase === "suspect" | "stoppable"` 在套接字仍开放时只沿用现有探活横幅，不单独改写工具状态；`hostPhase === "stopped"` 是用户主动停止，本身不算断连，按现有停止与回合事件处理。若套接字同时关闭，`sidecarDead` 仍独立生效。

`connectionLost=true` 时，尚未结束且没有中断/未确认标记的工具统一展示为“状态未确认”，不计入“执行中”，不写入新的执行终态。面板标题、单项状态和回合条共同使用这一展示态：`runningToolName` 不再返回这些工具，回合条另增 `toolsUnconfirmed` 输入并显示 `工具状态未确认`，不得仅清空工具名后回落成“正在思考”或“没有新结果”。`showTurnLine` 也必须包含当前标签的 `toolsUnconfirmed`，因为断连会把 `turnActive` 置为 false；不能沿用只看 `turnActive` 的可见条件而让专用文案消失。已完成工具保留完成或失败事实。

`toolsUnconfirmed` 优先于活跃子运行摘要：即使当前标签存在活跃子代理运行，回合条也必须保留「工具状态未确认」，不得被 `parentTurnLine` 的「主会话运行中」覆写。

### 6.2 实时开始事件

`tool/start` 保留现有字段并增加 `args?: string`，且必须同时修改两份独立的事件联合：`huaanwork-guardrails/bridge.ts` 的宿主 `RpcEvent` 与 `client-huaanwork/rpc-types.ts` 的客户端 `RpcEvent`。运行时多带字段不能替代客户端类型修订。

参数摘要格式化逻辑抽成实时桥与 `session-view.ts` 共用的纯函数，保持现有行为：解析工具参数、单行化、应用既有长度上限和省略标记。序列化失败或没有参数时不发送 `args`。

客户端按 `callId` 创建工具卡；没有 `callId` 时继续使用现有稳定 key 回退。通用说明不进入事件载荷，由客户端逻辑计算。

### 6.3 实时结束事件

`tool/end` 现在始终发送 `text: capped.text`，同时按事实发送 `truncated` 和 `isError`；不再只在上游结果被截断时发送文本。单事件输出仍受现有 `capToolOutput` 上限约束，默认约 32 KiB，面板不引入新的无界输出通道。

客户端更新同一张工具卡：

- `status` 改为 `end`。
- `hasResult` 设为 `true`，即使 `text` 是空串。
- 保存输出、失败和截断标记。
- 清除该工具的中断或未确认标记；迟到的真实终态优先于此前的推断，但不覆盖其他工具状态。

真实终态优先的范围：取消时工具返回的真实 `isError` 结果（例如 `TOOL_ABORTED`）和 `TOOL_TIMEOUT` 属于真实失败，历史恢复仍显示「失败」；只有日志中不存在真实终态、只有合成 closer 时才走 `interrupted`/`resultMissing` 映射（D5 裁定）。

匹配优先使用 `callId`。无 `callId` 时，从当前标签的全部扁平工具条目中按“同名且 `status === "start"`”选择最早一个匹配项，包括之前回合的迟到终态；`interrupted` / `unconfirmed` 是可被真实终态清除的推断标记，不排除匹配。不得因为出现新 `user` 而把旧终态错套到新回合的同名工具。每次结束事件只更新一项，避免同名并发调用同时被套用同一结果。

工具结果返回给既有执行链的路径保持现状；本设计只增加客户端事件中的展示数据，不改变执行结果处理语义。

### 6.4 渲染派生

原始工具条目更新后，memoized 投影重新按回合分组。投影只包含渲染所需引用与 UI 派生值，不复制一份可独立修改的执行状态。`connectionLost` 只改变展示态，不改写 `status`、`interrupted` 或 `unconfirmed`。

套接字 ready 使 `sidecarDead=false` 后，仍为开始态且没有其他终态标记的工具恢复真实执行展示；迟到事件仍可按 `callId` 完成更新。没有真实终态时不得自动改报成功，连接恢复本身也不算工具结果。

### 6.5 历史恢复

`SessionDetailRecord` 的 `tool-result` 增加可选 `truncated`，由 `session-view.ts` 按 `capped.truncated` 写入。该字段属于历史记录契约；宿主与客户端的实时 `tool/end` 联合已经各有 `truncated?: boolean`，不需要重复新增。

历史结果文本不能只保存 `capped.text`。必须保留 `session-view.ts` 的现有顺序：先从完整 shell 结果提取失败标记，再 capped，最后把未留在截断正文里的标记拼回 `text`；`isError` 继续包含这些标记判定。这样既保留截断事实，也不丢失败详情。

`historyItemsFromRecords` 将 `tool-call` 与后续 `tool-result` 配对。`SessionDetailRecord` 的 `user` 变体增加可选 `goalRound?: number`：`session-view.ts` 只对 `source.kind="goal"` 且 `round>0` 的官方续轮消息写入该字段，同时保留原 `kind="user"`、时间和正文，供只读历史页按原样逐条展示。可聊标签恢复时，带 `goalRound` 的记录经现有 `goalRoundLabel(goalRound)` 映射为 note，而不是新的用户回合；续轮前后的工具因此仍聚合到原始用户回合的同一个面板。

配对规则如下：

- 优先按 `callId` 配对。
- 结果缺少 `callId` 时，只在本用户回合内配对到最早一个尚未配对结果的工具调用，不跨回合猜测。
- 恢复参数摘要、命令、输出、`hasResult`、失败和截断状态。
- 已配对的失败结果进入对应工具卡，不再额外生成会话区失败提示。
- 无法配对的失败结果仍生成现有失败提示，避免历史信息丢失。
- 无法配对的成功结果不新增孤立工具调用。
- 旧历史只有调用而没有可配对结果时，保留 `status="end"` 表示它不是在途实时调用，同时设置 `hasResult=false`、`resultMissing=true`；单项与标题按“结果未记录”展示，不得落入“完成”或“成功且无输出”。若 resume 已把未闭合尾回合修补为合成结果，则按 `synthetic` 映射显示「已中断」或「结果未记录」，而不是失败。

`session-view.ts` 同时解析 `tool/result` 的 `data.error.code` 与同一 turn 的 `turn/end` `reason.kind`，在 `SessionDetailRecord.tool-result` 上写入 `synthetic?: "interrupted" | "resultMissing" | "hidden"`：

- 真实结果（含 `TOOL_ABORTED`、`TOOL_TIMEOUT`）→ 不设 `synthetic`，保留失败/完成事实；
- `TOOL_OUTCOME_UNKNOWN` + `reason.kind` 为 `aborted`/`error` → `synthetic="interrupted"`；
- `TOOL_OUTCOME_UNKNOWN` + 其他 reason（含 `interrupted`、无 `turn/end`）→ `synthetic="resultMissing"`；
- `ABORTED_BEFORE_DISPATCH` → `synthetic="hidden"`，并移除配对的 `tool/call`；
- `TOOL_NOT_STARTED` → `synthetic="hidden"`。

`hidden` 在 `detailRecords` 返回前过滤；可聊历史与只读历史页都不显示这些从未 dispatch 的调用。`selectSubtask` 先 `session.open` 再 `session.resume`，避免 resume 的崩溃修补写盘污染首次读取；已污染日志仍由上述映射兜底。

本路径只覆盖只读历史页通过“继续此会话”恢复为可聊标签后的面板。`HistoryDetailPane` 继续保持逐条 `tool-call` / `tool-result` 日志，不改成聚合面板，其空结果展示不属于本次验收对象。

## 7. 异常与边界语义

### 工具失败

`isError` 只标记该工具。一个工具失败后，模型仍可继续调用其他工具或生成正文；不得仅凭工具失败把整个回合标为失败。面板收起标题显示“含失败调用”。

### 输出截断

截断是结果展示事实，不是失败。实时和历史使用同一 capped 规则及截断标记；历史还保留截断后拼回 shell 失败标记的既有行为。

### 取消或回合失败

取消或失败使用户回合进入 `turnFinal`，即使所有工具都已 `end`、没有思考或正文也能据此收起。只将当前回合尚未结束的工具标为 `interrupted`，已完成工具的输出、失败与截断事实不变，不得把之前回合的条目一并改写。

### 合成结果与未启动调用

- 真实结果优先：取消时工具返回的真实 `isError`（例如 `TOOL_ABORTED`）与 `TOOL_TIMEOUT` 仍显示失败；不得把真实终态改写成「已中断」或「结果未记录」。
- 只有合成 closer：`turn/end` reason 为 `aborted`/`error` 时显示「已中断」；其他 reason（含 `interrupted`、无 `turn/end`）显示「结果未记录」；客户端卡片不设置 `isError`，不展示模型指令文本。
- 未启动/跳过调用：`TOOL_NOT_STARTED` 与 `ABORTED_BEFORE_DISPATCH` 不生成工具卡、不生成英文失败提示，也不进入调用数或面板标题；`hidden` 记录在宿主返回前过滤。

### 正常回合结束但工具终态缺失

只有已确定 `turnFinal` 的正常回合结束时，仍为开始态的工具才标为 `unconfirmed`，显示“状态未确认”，不按成功处理，也不误标为用户中断。目标仍为 `active` 的续轮中间 `session/end` 不得设置该标记。goal outcome 边沿只封口回合，不在此列；真实回合结束（`session/end`/`run-end`）仍按本节处理。

### Host 断连

`connectionLost` 期间保留最后已知事实，受影响的开始态工具在面板标题、单项和回合条中统一展示“状态未确认”，不计入执行中。不凭空补结果，不把断连直接等同工具失败；现有全局 Host 连接提示继续负责连接级诊断。

### 回合核对的并列语义

`turnChecks` 继续读取扁平数组，已开始但未验证为成功结束的工具仍使对应必需命令得到“命令未通过”。这里的“未通过”表示没有验证为通过，不等于进程已失败；它可以与面板更具体的“已中断”或“状态未确认”同时出现。不得为了消除这两句并列而跳过中断或未确认命令的既有核对。

### 特殊卡片

携带 `event.todos` 的 `todo_write` 继续进入待办卡，包括空数组；未携带 `event.todos` 时仍按普通工具进入工具面板。审批、自由文本输入和子代理运行卡留在会话区，不被折叠到工具面板内。

## 8. 测试设计

### 8.1 纯逻辑测试

新增 `tests/client-huaanwork/toolPanel.spec.ts`：

- 无工具回合不产生面板；每回合仅一个面板，多回合互不混组。
- 面板锚定本回合首个工具位置，非工具条目相对顺序不变。
- 携带 `todos` 的 `todo_write`、审批、输入和子代理卡不被吞入面板；未携带 `todos` 的 `todo_write` 进入面板。
- 标题状态及优先级、调用数、历史默认收起。
- 只含 think 标签的 assistant 不算可见正文，普通可见正文与 attachment 算正文。
- `turnFinal` 能收起无正文且工具全部结束的回合，手动选择优先。
- 目标 `active` 的中间 `session/end` 不设置 `turnFinal`、不收起、不标未确认，后续 `goal/round` 复用同一面板。
- 无目标及 `paused` / `blocked` / `complete` 相位的成功结束，以及取消、失败和 `goal/round-limit`，按规则设置 `turnFinal`。
- `completeFirst` 与 `endFirst` 都在实际 `outcome` 边沿设置 `turnFinal`；`endFirst` 不需要第二次 `session/end`，重复 `complete` 和后续结束保持幂等。
- 断连时标题和单项不计执行中；历史 `resultMissing` 显示结果未记录而不是完成。
- 当前 `ALLOWED_TOOLS` 的名称映射逐项有断言，说明不含参数，未识别工具使用回退文案。
- 无 `callId` 的同名并发调用每次只结束最早一个开始态项；旧回合的迟到终态仍可跨回合命中最早匹配项，不得错套新回合的同名工具。
- 无用户条目的合成回合：`turnFinalWithoutUser` 能结算，`session/end` 与 `run-end` 都收起面板；历史合成中断卡片的 `interrupted` 优先于 `status="end"`。
- goal outcome 只封口回合，不把在途工具标 `unconfirmed`；后续真实 `tool/end` 或 `session/end` 才结算。
- `TOOL_NOT_STARTED`/`ABORTED_BEFORE_DISPATCH` 的 `hidden` 记录不生成卡片，也不生成英文 note。

### 8.2 组件测试

新增 `tests/client-huaanwork/ToolPanelComponent.spec.ts`，使用现有 jsdom + React Harness 模式：

> 文件名订正（ledger Task 7 裁定）：计划原写的 `ToolPanel.spec.ts` 在本仓库的大小写不敏感 APFS 卷上与纯逻辑 spec `toolPanel.spec.ts` 是同一文件（`core.ignorecase=true`），故组件 spec 改用 `ToolPanelComponent.spec.ts`，逻辑 spec 沿用既有名字。

- 面板与工具详情的点击、键盘和 `aria-expanded`。
- 参数、结果、空输出、结果未记录、失败、截断、中断与未确认展示，包括对应单项状态词和面板标题。
- 长内容由内部滚动容器承载。
- HTML 字符串只作为文本出现，不生成对应元素。
- 状态区域只随状态迁移播报。

### 8.3 事件、历史与回合状态测试

扩展 `tests/huaanwork-guardrails/bridge.spec.ts`：

- 普通非截断结果也发送文本，空结果仍能被区分为“已收到结果”。
- 参数摘要与历史格式一致，序列化失败不阻断执行。
- 长结果继续 capped，失败标记保持事实，既有执行链返回行为不变。
- 宿主与客户端两份 `tool/start` 联合都包含 `args`；实时 `tool/end` 不重复新增已有的 `truncated`。

扩展 `tests/client-huaanwork/sessionChannel.spec.ts`：

- 成功、失败、空输出与截断结果配对恢复。
- 多工具及结果缺少 `callId` 时只在同一回合内按顺序配对。
- 无法配对的失败仍保留会话提示。
- 历史截断文本保留未落入 capped 正文的 shell 失败标记。
- 旧历史缺结果写入 `status="end"`、`hasResult=false`、`resultMissing=true`，显示结果未记录而不是完成或空输出。
- 合成 `interrupted`/`resultMissing` 配对恢复为对应状态，且不设置 `isError`；`hidden` 不生成卡片；无匹配合成结果不生成英文 note。
- `session-view.spec.ts` 解析 `data.error.code` 与 `turn/end` reason：`TOOL_OUTCOME_UNKNOWN` + `aborted`/`error` → `interrupted`，+ 其他 reason（含 `interrupted`/无 reason）→ `resultMissing`；`TOOL_NOT_STARTED`/`ABORTED_BEFORE_DISPATCH` 过滤；真实 `ABORTED`/`TOOL_TIMEOUT` 保持失败。
- `session-view.spec.ts` 钉住 goal 续轮记录保留原用户正文并携带 `goalRound`；`sessionChannel.spec.ts` 钉住该记录恢复为续轮 note、不产生新 `user` 条目，配合投影测试保证续轮前后只有一个面板。

会话结束测试明确落在两处：`toolPanel.spec.ts` 覆盖纯状态迁移，`tests/client-huaanwork/appWiring.spec.ts` 钉住 App 对 `turnFinal`、`connectionLost` 和归属标签的实际接线。覆盖取消/失败只中断当前回合未结束工具、正常 `turnFinal` 缺终态显示未确认、目标 `active` 的中间结束不误结算、`goal/state complete` 的实际 `outcome` 动作立即设置 final，以及迟到的真实工具终态覆盖此前的中断或未确认标记。`appWiring.spec.ts` 必须使用 `reduceGoalTurn` 的真实返回动作，不以“看到 complete”代替边沿判定。另需钉住 `turnFinalWithoutUser`/`run-end`、`selectSubtask` 的 open-before-resume，以及 `parentTurnLine` 收到 `toolsUnconfirmed` 后仍保留「工具状态未确认」。

扩展 `tests/client-huaanwork/turnStatus.spec.ts`：`toolsUnconfirmed` 显示“工具状态未确认”，不显示“正在执行工具”，也不回落为“正在思考”；`runningToolName` 不再把断连、中断或未确认工具算作运行中。`appWiring.spec.ts` 还要钉住 `showTurnLine` 在 `turnActive=false` 但当前标签 `toolsUnconfirmed=true` 时仍可见。扩展 `tests/client-huaanwork/outcomeCheck.spec.ts`：中断或未确认的必要命令仍按既有规则记为“命令未通过”，与面板状态并存。

运行现有 `goalRound.spec.ts`、思考、审批和子代理测试，验证目标续轮与扁平消息消费方无回归。

### 8.4 完整门禁

实现后运行并记录实际结果：

```bash
corepack yarn test
corepack yarn typecheck
corepack yarn check
```

任何网络、环境或平台阻塞都如实记录；局部测试通过不得写成全量门禁通过。

实施后（2026-11-03，HEAD `b7aaa5ef5f`）三条命令均 exit 0；实际执行结果记录在 `docs/superpowers/plans/2026-11-03-chat-tool-panel-code-review.md` 的〈实施状态〉。§9 真机项未执行，不得写成通过。

## 9. 真实界面验收

图形应用启动需单独明确执行。开发版中至少走查：

1. 一个回合连续执行读取、搜索和命令工具，会话区只有一个面板，没有散落工具行或长输出。
2. 展开多个单项详情，参数与结果正确，长输出在面板内部滚动。
3. 正文出现后默认收起；手动展开后切换标签再返回，面板仍按手动选择展开。自动化运行回复折叠为附件时也能收起。
4. 工具失败但回合继续时，仅该工具和面板摘要显示失败事实；若涉及用户要求的命令，“命令未通过”脚注可与具体工具状态并存。
5. 运行中取消后，未结束工具显示中断，已完成工具结果不变；全部工具已结束且无正文时也能凭 `turnFinal` 收起。
6. 从只读历史页选择“继续此会话”：新历史可查看结果，旧历史缺结果时单项与标题显示结果未记录；含目标续轮的历史恢复为续轮 note 且仍只有一个回合面板。返回只读 `HistoryDetailPane`，确认它仍是逐条日志，goal 续轮原始用户消息仍逐条可见，不是聚合面板。
7. 分别触发并操作特殊卡片：① 发起需要审批的命令并批准或拒绝；② 触发 `request_input`，从底部输入框提交答案，另一次取消；③ 执行携带 `todos` 的 `todo_write`，确认待办卡更新；④ 显式调用一个子代理，确认运行卡出现、状态更新且活跃时可按既有流程终止。
8. 连续两个回合各自保留独立工具面板，后台标签的结束事件不改变当前标签面板。
9. 实时自动化运行标签：运行结束与取消后，工具面板按真实终态收起；在途工具不显示「运行中」，不影响用户回合的面板。
10. 历史恢复的合成结果：取消/失败合成显示「已中断」，崩溃恢复显示「结果未记录」；未启动/跳过调用不出现卡片或英文 note。

以下场景可用自动化或受控模拟覆盖，并在验收记录中明确标为模拟：

- Host 断连：面板标题和受影响单项显示状态未确认，回合条显示“工具状态未确认”，不得再显示“正在执行工具”或“正在思考”；ready 后按真实事件恢复。
- `hostPhase` 为 `suspect` / `stoppable` 且套接字未断时，不单独改写工具状态；`stopped` 本身不算断连。
- 目标 `active` 的中间 `session/end` 不收起、不标未确认，后续 `goal/round` 仍使用同一面板。
- `active` 的中间 `session/end` 后，由 `goal/state complete` 产生实际 `outcome`：即使没有第二次 `session/end` 也立即 final；重复 `complete` 不改变状态。

未在真实图形环境执行的项目不得声称真机验收通过。

## 10. 完成标准

- 会话区不再逐条展示普通工具调用，每个回合至多一个工具面板。
- 工具说明、状态、参数摘要和结果符合已确认交互。
- 工具执行与审批语义不变，特殊卡片无回归。
- 实时与历史对空结果、结果未记录、失败、截断、中断和未确认有一致且诚实的展示。
- 合成 closer 不显示为真实失败：取消/失败合成 → 已中断；崩溃恢复 → 结果未记录；未启动/跳过调用不生成卡片或英文 note。
- 断连时面板标题、单项与回合条口径一致；目标续轮中间结束不误收起、不误标未确认。
- 无用户条目的运行标签在 run-end/cancel 后正确收起；活跃子运行与未确认工具并存时，回合条仍显示「工具状态未确认」。
- 新增与既有自动化测试通过，完整门禁实际执行结果已记录。
- 真实界面走查完成，或未执行部分被明确标注，不以类型检查代替界面验收。

## 11. 实施后订正（2026-11-03）

本节记录规格与实现的最终同步点；代码提交 `b7aaa5ef5f`，评审与验证见 `docs/superpowers/plans/2026-11-03-chat-tool-panel-code-review.md` 的〈实施状态〉。

- **回合条优先级**：`toolsUnconfirmed` 为真时，即使存在活跃子运行，也保留「工具状态未确认」，不被「主会话运行中」覆写（§5.1、§6.1）。
- **合成结果**：宿主按 `data.error.code` 与 `turn/end` reason 归一化 `SessionDetailRecord.tool-result.synthetic`；真实 `ABORTED`/`TOOL_TIMEOUT` 保持失败；取消/失败合成 → `interrupted`；崩溃恢复 → `resultMissing`；`TOOL_NOT_STARTED`/`ABORTED_BEFORE_DISPATCH` → `hidden`（§5.4、§6.3、§6.5、§7）。
- **历史读取顺序**：`selectSubtask` 先 `session.open` 再 `session.resume`，避免 resume 修补写盘污染首次读取（§6.5）。
- **无用户运行标签**：`turnFinalWithoutUser` + `run-end` 结算合成回合；历史无用户片段同样默认收起（§5.1、§6.5）。
- **goal outcome**：只封口回合，不把在途工具标 `unconfirmed`；后续真实 `tool/end` 或 `session/end` 结算（§5.1、§7）。
- **验证范围**：headless 门禁通过；I-2 合成历史真机 GUI 已通过；I-1/I-3/N-1/N-2 的 GUI 未执行，留待 §9 验收。
