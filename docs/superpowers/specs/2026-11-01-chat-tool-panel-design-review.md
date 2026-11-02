# 《会话内工具面板》规格评审意见

- **评审对象**：`docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md`
- **评审日期**：2026-11-01；修订复审 2026-11-02
- **评审方式**：Momus 只读初审，随后对初审的每条结论在源码上重新取证。本文件只记录评审意见，不修改设计稿，也不修改实现
- **评审结论（对第一轮稿）**：**ITERATE（有条件通过）**。聚合投影、扁平消息仍为事实来源、空结果与缺结果分开，这三处和现有代码一致，方向可以做。初审的三处阻断在复核后全部维持，但第 1 条的「三套信号」是夸大，第 2 条的缺口比初审写的窄，第 3 条比初审更窄地漏掉了目标续轮。另有初审未报的 1 条 P2。批准进入实施之前，须先把下面的 P1 写进规格
- **修订复审（2026-11-02）**：规格文首已改为「已按第一轮评审的校准结论修订」。逐条复审见 §七。上一轮 P1×3、P2×6、P3×2 全部消解。新发现 **P1×1**：`goal/state complete` 晚于「相位仍为 active」的 `session/end` 时，`turnFinal` 不会置位。**结论仍是 ITERATE**，补上这一条之前不进入实施

## 一、初审意见的复核处置

| 初审意见 | 处置 | 复核要点 |
| --- | --- | --- |
| 阻断 1：断连时标题仍可能是「执行中」 | **维持**，收窄夸大 | 标题优先级（§5.2）与「断连展示由连接状态派生、不写成终态」（§6.1、§6.4）确实给出两种合法读法。子代理 `connection: "disconnected"` 不是第三套候选信号，规格已把子代理卡排除在面板外 |
| 阻断 2：历史缺结果在五态里没有位置 | **维持**，缺口收窄 | 结果区文案「历史记录未保存结果」规格已经写了（§5.4）。缺的是这条记录的 `status`、单项状态词和面板标题。现恢复路径把它写成 `status: "end"` |
| 阻断 3：正常结束后的默认收起不能从 `ChatItem[]` 算出 | **维持并收紧** | 「取消或失败总能靠 `interrupted` 看出来」只在仍有 `start` 工具时成立。另外，裸 `session/end` 或瞬时 `turnActive === false` 不能当作用户回合结束：目标相位仍为 `active` 时，这次结束只是续轮中间点 |
| 工具类别表未闭合 | **维持** | `ALLOWED_TOOLS` 里还有一批名字，规格的「例如」钉不住分类 |
| 「可见助手正文」未指向现成规则 | **维持**，补一条相邻面 | 只含 think 标签的助手文本今天不算可见正文。同一 `items.map` 还渲染自动化运行对话，JSON 回复会被收成 `attachment` |
| 历史截断后拼回 shell 失败标记 | **维持** | `session-view.ts` 在 `capToolOutput` 之后把没留在正文里的标记拼回 `text`。规格只说 capped 时写 `truncated`，照字面只存 `capped.text` 会丢掉这段 |
| `args` 要改两份 `RpcEvent` | **维持** | `bridge.ts` 与 `rpc-types.ts` 各有一份互不导入的事件联合。规格只点了 bridge |
| 只读历史页未纳入 | **收窄** | 这不是漏做第二套面板。§6.5 的数据路径是「继续此会话」用的 `historyItemsFromRecords`。缺口是 §9.6 没点名入口；`HistoryDetailPane` 仍是逐条日志 |
| §8 / §9 的可执行性 | **维持** | 点名的 bridge 与 `sessionChannel` 用例可以当测试规格。会话结束用例没有文件名；§9.6、§9.7 和断连断言对象不够具体 |

初审「已核实成立」的现状描述，复核后没有发现事实错误。行号与符号见 §四。有一处路径应写全：`capToolOutput` 在 `packages/huaanwork-policy/src/truncate.ts`，不在 guardrails 目录下；默认上限 `32 * 1024` 字节，与规格「约 32 KiB」一致。

## 二、阻断项

### P1-1 断连期间，标题、单项和回合条没有同一套展示态（§5.2、§6.1、§6.4、§7）

规格同时写了三件事：

- 运行中 = `status === "start"` 且没有中断或未确认标记；`runningToolName` 采用这一定义（§6.1）。
- 断连时的「状态未确认」由连接状态派生，不提前写成执行终态（§6.1、§6.4）。
- 面板标题优先级是：执行中、含失败调用、已中断、状态未确认、已完成（§5.2）。

一种合法读法是：派生展示不改标记，所以未结束工具仍算「执行中」，标题和回合条保持执行中，只有单项正文写成「状态未确认」。另一种读法是：展示态替换「执行中」，标题、单项和 `runningToolName` 一起变成「状态未确认」。两种界面都满足一部分句子，验收无法判定。

现有回合条只看 `status === "start"`（`runningToolName`，`App.tsx:3942-3948`），再交给 `turnStatus` 拼出「正在执行工具 …」（`turnStatus.ts:13-15`）。它今天不读任何断连标记。

信号也不该写成「三套里任选」。和父会话工具面板有关的只有两套：

- `sidecarDead`：事件套接字 `onclose` 通知退出处理（`api.ts:220-225`，`App.tsx:1372-1375`）。`sidecar/status` ready 时清掉（`App.tsx:1149-1153`）。这条和「恢复后迟到事件仍可按 callId 更新」对得上。关闭时还会把全局 `turnActive` 置为 false。
- `hostPhase`：探活相位。非 ok 时横幅是「执行进程无响应」或「执行进程已按你的要求结束」（`hostStop.ts:12-26`）。套接字仍开着时，工具可以继续是 `start`。用户主动停止不是断连。

子代理投影的 `connection: "disconnected"`（`logic/subagentRuns.ts:241-242`）只冻运行卡。规格 §3 已把子代理内部工具和运行卡留在面板外，实现者不该借用这个字段。

规格要补的一句是：断连期间，未结束工具的展示态是「状态未确认」，不计入「执行中」；面板标题、单项状态和 `runningToolName` 使用这同一个展示态。并写明断连指 `sidecarDead`，还是也包含 `hostPhase !== "ok"`（`stopped` 是否除外）。

### P1-2 旧历史只有调用、没有结果时，状态词会写成完成（§5.2、§5.3、§5.4、§6.5）

§5.4 已经规定结果区写「历史记录未保存结果」，§6.5 规定 `hasResult=false`，不得解释为成功且无输出。单项状态却只有运行中、完成、失败、已中断、状态未确认（§5.3）。规格没有说这种记录的 `status` 取哪一个，也没有说面板标题用哪一句。

现恢复把每条历史工具都写成已结束、且不带结果（`historyToChatItems`，`App.tsx:2467-2474`）。`historyItemsFromRecords` 对 `tool-call` 只产出名字和 `callId`（`sessionChannel.ts:110-115`），失败结果另起一条提示（`:116-118`）。按 §5.2，`end` 且非失败会落到标题「已完成」、单项「完成」。这和开篇「不伪造缺失结果或未知终态」冲突。

这和「正常结束但仍是开始态」的未确认不是同一件事：旧日志里调用已经落盘，缺的是结果记录，不是一次还在跑的调用。规格必须规定这一种记录的 `status`、单项用词和面板标题。结果区文案可以维持现状。

### P1-3 「回合结束后默认收起」缺少可计算信号，而且不能用每一次 `session/end`（§4.2、§5.1、§7）

§4.2 让 `toolPanel.ts` 只根据条目计算默认展开。§5.1 又要求：尚无可见正文时展开；正文出现、取消、失败或正常结束后收起；`panelToggled` 优先。

能从条目看出的只有一部分：

- 后面又出现 `user`，上一回合已经结束。
- 可见正文出现后可以收起。可见正文的口径见 P2-2。
- 取消或失败时，规格准备给当前回合仍为开始态的工具写 `interrupted`。那时可以收起。

看不出的有两处：

- 正常成功、工具都已 `end`、又没有可见正文。`session/end` 只把被跟踪回合的全局 `turnActive` 设为 false（`App.tsx:3577-3578`），这个值不在投影输入里。
- 取消或失败发生时，工具已经全部 `end`，而且本回合没有思考或正文。今天的 `interruptTurnItems` 只给思考和正文打 `interrupted`（`thinkingPanel.ts:54-71`），这种条目数组不会变化。初审说「取消或失败可以靠即将写入的 `interrupted` 看出来」，这句话过宽。

更要紧的是结束信号的选法。`agent/status === idle` 就会发 `session/end`（`bridge.ts:191-199`）。目标相位仍为 `active` 时，这次结束被既有状态机明确当成续轮中间点，不写回合结论（`goalRound.ts:134-135`）。随后 `goal/round` 又把 `turnActive` 设回 true（`App.tsx:3571-3574`）。规格的回合边界是 `user` 条目（§4.2）；目标续轮在实时界面里是 note，不是新的用户消息，所以仍是同一个面板。

若把每一次 `session/end` 或那一下 `turnActive === false` 当成「正常结束」并锁住收起，同一用户回合的后续工具按 §5.1「不重新展开」就会一直收着。§7 若在同一次中间结束上把仍为开始态的工具标成未确认，也会在续轮真正的 `tool/end` 到来之前先报一笔未知终态。

规格必须规定投影的结束输入，并写明：目标相位仍为 `active` 的 `session/end` 不是用户回合结束，不得据此收起，也不得据此把工具标成未确认。`turnActive` 只有在「这个用户回合不再继续」时才能当作收起条件，而且只作用于被跟踪的那一个回合。

## 三、非阻断缺口

### P2-1 通用说明没有闭合的工具名表（§5.3、§8.1）

§5.3 用「例如」给出读取、搜索、写入或编辑、`bash` / `pwsh`，其余走「正在执行工具」。`ALLOWED_TOOLS`（`present-as.ts:15-43`）里还有 `git_*`、`web_fetch`、`skill`、`screenshot`、`get_goal`、`propose_plan`、`exit_plan_mode` 等。§8.1 只要求说明不含参数、未识别工具用回退文案，钉不住「读取 / 搜索 / 修改」各包含哪些名字。实现前要有一张名字到说明的表，未列入的名字用回退文案。

### P2-2 「可见助手正文」要沿用现成口径，并处理附件（§5.1）

`resolveThinking` 把只含 think 标签的助手文本视为不可见（`thinkingPanel.ts:27-32`）。思考收尾用的 `hasAssistantTextAfter`（`:124-136`）也先走这道过滤。面板若直接看「有没有 assistant 条目」，会在只有思考标签时提前收起。

同一条消息列表还画自动化运行对话。运行回填会把整段 JSON 助手收成 `attachment`（`App.tsx:1622-1628`，`runResultAttachments.ts:32-44`）。扁平数组里这时没有 assistant。内容视图把附件映射回助手正文（`App.tsx:3672-3674`）。规格应写明：可见正文沿用这个口径（assistant 经 `resolveThinking` 取出的可见文本，`attachment` 视为正文）。否则运行对话里的面板不会因「正文出现」收起。

### P2-3 历史结果在截断后还会拼回 shell 失败标记（§6.3、§6.5）

`session-view.ts:240-253` 先从完整结果里取 shell 失败标记，再 `capToolOutput`，然后把没出现在截断文本里的标记拼回 `text`。`isError` 也会因此为真。规格只说 capped 时写入 `truncated`，并说实时和历史使用同一 capped 规则。若实现改成只存 `capped.text`，这段标记会从历史结果里消失，失败事实仍可能留在 `isError` 上，两边不再一致。规格应写明保留这段拼回，或明确放弃并让失败只靠 `isError`。

### P2-4 `args` 必须同时进入客户端事件类型（§6.2）

bridge 自有一份 `RpcEvent`（`bridge.ts:17-28`），客户端另有一份（`rpc-types.ts:417-430`），二者互不导入。规格只要求 bridge 的 `tool/start` 增加 `args`。运行时 JSON 可以多带字段，但 `App.tsx` 按客户端联合读 `event.args` 时，类型上今天没有这个字段。两份 `tool/start` 都要加 `args?: string`。`tool-result` 增加可选 `truncated` 时同样要改 `rpc-types.ts:342`，这一点规格已经点到了记录类型，没有点到 bridge 与客户端的重复联合。

### P2-5 回合结论仍会把未结束工具写成「命令未通过」（§4.1、§7）

这是初审未报的一项。`turnChecks` 把 `status === "start"` 的工具算作未通过（`outcomeCheck.ts:141`，注释是「没结束的工具卡不算通过」），缺口句是「命令未通过：…」。规格让中断和未确认保持 `status === "start"`，只加标记，并说命令核对继续读扁平数组、不改执行语义。

按「不改核对」实现，面板可以写「已中断」或「状态未确认」，回合脚注仍写「命令未通过」。今天对真正还在 `start` 的工具已经如此，所以不是新算法。新的是两种诚实用词会同时出现。规格用一句话接受这个并列，或写明核对跳过已标记中断或未确认的命令。不写的话，§9 的失败与取消走查会和脚注打架。

### P2-6 §9.6 没有点名恢复入口（§6.5、§9）

「恢复旧历史」在规格的数据流里是 `historyItemsFromRecords` 再经 `historyToChatItems` 进会话标签，也就是继续此会话。只读 `HistoryDetailPane` 仍逐条画 tool-call 和 tool-result，空文本显示「（无输出）」（`HistoryDetailPane.tsx:143-164`）。那一页不是本设计要替换的聚合面板。规格应写明验收走继续此会话，详情页保持逐条日志。否则「诚实空态」可以指两个表面。

### P3-1 `todo_write` 没有 `todos` 时仍会变成普通工具行（§7）

只有 `event.name === "todo_write" && event.todos` 才进入待办卡（`App.tsx:3501-3504`）。没有合法待办列表时，同一次 `tool/start` 会落下普通工具行（`:3506` 起）。规格写「`todo_write` 继续进入待办卡，因此不形成普通工具面板条目」，没有覆盖这个分支。建议写明：无 `todos` 的 `todo_write` 仍按普通工具进面板，或在开始事件上直接不建工具行。

### P3-2 会话结束测试没有落点文件（§8.3）

「扩展会话结束相关测试」没有文件名。对应行为今天散落在 `thinkingPanel.spec.ts` 的 `interruptTurnItems` 和 `App.tsx` 的 `session/end`，没有现成的工具终态测试。补上文件名即可，不改变产品语义。

## 四、复核后仍然成立的现状

这些是规格所依赖的事实，初审写过，本轮对过源码，没有发现说错：

- 普通工具是 `ChatItem` 的 `kind: "tool"`（`App.tsx:241`）。会话列表是 `items.map`（`App.tsx:2911-2928`）。`contentItems`（`App.tsx:3663-3669`）、`insertBeforeToolRow`（`App.tsx:3613-3627`）和 `runningToolName` 都读扁平数组。
- 带 `todos` 的 `todo_write` 不建工具行（`App.tsx:3501-3504`）。子代理工具不向父会话发 `tool/start` 和 `tool/end`（`bridge.ts:122-128`）。
- `tool/end` 只在 `capped.truncated` 时带 `text`（`bridge.ts:134`）。无 `callId` 时，结束事件会更新每一个同名且仍为 `start` 的工具（`App.tsx:3525-3527`），不是最早一个。规格要求改成最早一个，这是待实现的行为，不是规格看错了现状。
- 参数摘要已在 `session-view.ts` 的私有 `formatArgs`（`:297-312`）：`parseToolArguments`、单行化、`TOOL_LABEL_MAX_CHARS`（200）和省略号。bridge 的 `startDetail`（`bridge.ts:351-365`）还没有通用 `args`。`tool-result` 记录没有 `truncated`（`rpc-types.ts:342`）。
- 历史失败结果不配进工具卡，成功结果不占位（`sessionChannel.ts:116-119`）。这正是 §6.5 要改的行为。
- 思考面板的折叠按钮带 `aria-expanded`（`ThinkingPanel.tsx:28-33`）。`userToggled` 记在条目上，标签的 `items` 留在 `chatTabs` 里，切换标签不会丢。组件测试的 jsdom 与有状态 Harness 在 `SubagentRunCard.spec.ts` 开头。`tests/huaanwork-guardrails/bridge.spec.ts` 和 `tests/client-huaanwork/sessionChannel.spec.ts` 都在。
- `toolPanel.ts`、`ToolPanel.tsx` 以及两份新测试是规格声明的新文件，当前不存在。

## 五、验收

§8.1 和 §8.2 的断言可以写成测试。§8.3 里点名的 bridge 与 `sessionChannel` 用例也有文件和期望。§8.3 末段的会话结束用例见 P3-2。§8.4 的三条命令明确，且禁止把局部通过写成全量通过。

§9 的 1–5 和 8 能在界面上观察。第 6 条在 P1-2 写死状态词、并按 P2-6 点明「继续此会话」之前，不能判定通过。第 7 条要求审批、自由文本、待办和子代理卡仍可操作，但没有触发步骤。断连允许模拟，但在 P1-1 写死之前，没有规定断言对象是标题、单项，还是回合条。

## 六、结论

维持 **ITERATE**。这不是架构推倒：事实来源、投影位置和空结果 / 缺结果的区分都可以沿用。开工前规格要写死三句话：

1. 断连展示态覆盖「执行中」，标题、单项和 `runningToolName` 共用它，并点名 `sidecarDead` 与 `hostPhase` 的关系。
2. 旧历史只有调用、没有结果时的 `status`、单项用词和面板标题。
3. 用户回合结束的判定输入；目标仍在续轮时的 `session/end` 不得收起面板，也不得把工具标成未确认。

P2、P3 可以在同一轮文字修订里一起补上。补完之前不进入实施。

## 七、修订复审（2026-11-02）

对照对象是同日修订后的设计稿。上一轮列出的条目都已有唯一读法；复审只核对这些读法是否闭合，以及修订有没有引入新的两读。

| 上一轮条目 | 处置 | 修订稿落点 |
| --- | --- | --- |
| P1-1 断连展示态 | **消解** | `connectionLost` 只取 `sidecarDead`。`hostPhase` 为 `suspect` / `stoppable` 时不改工具状态，`stopped` 本身不算断连（§6.1）。断连中的开始态工具不计入执行中；标题、单项与回合条共用「状态未确认」。回合条新增 `toolsUnconfirmed`，文案是「工具状态未确认」，并要求 `showTurnLine` 在 `turnActive=false` 时仍可见 |
| P1-2 历史缺结果的状态词 | **消解** | 保留 `status="end"`，另设 `hasResult=false`、`resultMissing=true`。单项与标题用新状态「结果未记录」，优先级低于失败、中断和未确认，高于「已完成」（§5.2–§5.4、§6.5） |
| P1-3 回合结束信号 | **部分消解** | `turnFinal` 按标签、按用户回合输入。取消、失败、`userStopped`、`goal/round-limit`，以及非 `active` 相位上的成功 `session/end` 会置位；相位仍为 `active` 的 `session/end` 保持 false，不得收起或标未确认。裸 `turnActive=false` 不是收起条件。残余见下方 N-P1 |
| P2-1 工具名表 | **消解** | §5.3 给出与 `present-as.ts:15-43` 一致的 27 个名字；未列入的名字回退为「正在执行工具」。§8.1 要求逐项断言 |
| P2-2 可见正文 | **消解** | 可见正文取 `resolveThinking` 的 `visible.trim()`；只含 think 标签不算。`attachment` 先经 `contentItems` 映射回助手正文（§5.1） |
| P2-3 shell 失败标记 | **消解** | 历史文本保留「先提取标记、再 capped、再把未落入正文的标记拼回」的现有顺序（§6.5） |
| P2-4 两份 `RpcEvent` | **消解** | `args?: string` 必须同时进入 bridge 与 `rpc-types.ts` 的 `tool/start`。`tool/end` 的 `truncated` 已存在，只给 `tool-result` 记录补可选字段（§6.2、§6.5） |
| P2-5 回合核对并列 | **消解** | 明确接受「命令未通过」与「已中断」或「状态未确认」并列，不为此跳过既有核对（§7） |
| P2-6 历史入口 | **消解** | 面板只覆盖「继续此会话」。`HistoryDetailPane` 保持逐条日志，空结果展示不在本次验收内（§6.5、§9.6） |
| P3-1 无 `todos` 的 `todo_write` | **消解** | 携带 `event.todos`（含空数组）进待办卡；未携带时按普通工具进面板（§7） |
| P3-2 会话结束测试落点 | **消解** | 纯迁移在 `toolPanel.spec.ts`，App 接线在已存在的 `appWiring.spec.ts`。回合条文案落在已存在的 `turnStatus.spec.ts`，核对并列落在已存在的 `outcomeCheck.spec.ts`（§8.3） |

`paused` / `blocked` 不另加规则。现有测试里这两条都是相位先变、成功的 `session/end` 后到（`goalRound.spec.ts:208-215` 及同文件相邻用例）。按修订稿 §5.1 的第四条，这次 `session/end` 会置 `turnFinal`。

### N-P1 `goal/state complete` 后到时，`turnFinal` 仍为 false（§5.1）

修订稿把 `turnFinal` 只绑在 `session/end` 和 `goal/round-limit` 上，并在 `session/end` 当时读取目标相位。`complete` 先到、`session/end` 后到时，这次结束读到的相位已经是 `complete`，规则能置位。

另一顺序是既有契约，不是边缘猜测。`goalRound.spec.ts:87-103`（“whichever event lands first”）的 `endFirst` 序列是：相位仍为 `active` 时先来成功的 `session/end`，随后才是 `goal/state complete`。前一条按 `reduceGoalTurn` 是续轮中间点，不写结论（`goalRound.ts:134-135`）；后一条才给出 `outcome`（`goalRound.ts:112-119`）。测试里 complete 之后再补的 `session/end` 被断言为不再产生结论，不能当成 `turnFinal` 的必达信号。

按 §5.1 的四条字面实现，这一顺序里第一次 `session/end` 保持 `turnFinal=false`，后到的 `complete` 不改它。工具都已结束、又没有可见正文时，面板继续展开；若当时还有开始态工具，也不会标成未确认。面板要一直开到下一条用户消息。这就是上一轮要求 `turnFinal` 补上的那种回合。

规格应补一条：`goal/state` 进入 `complete`，且这次边沿结算本回合（`reduceGoalTurn` 给出 `outcome`）时，置 `turnFinal=true`，不要再等一次 `session/end`。§8.1 要有对应顺序的断言，不能只测「`session/end` 发生时相位已经是 `complete`」。

### 复审结论

上一轮的三句话已经写进规格，修订没有把断连、历史缺结果或续轮中间点重新打开。维持 **ITERATE**。进入实施之前，只再补 N-P1 这一条。
