# 轮次级工具看板与思考面板设计

## 1. 背景与实测证据

现行实现把工具调用聚合成「每个用户回合一个面板」，锚点钉在该回合首个工具位置，后续所有模型轮次的调用只往同一个面板里追加。思考面板在历史恢复视图里却是逐轮内联的，两者粒度不一致。

实测取证（2026-11-09，直接调用仓库现有 `projectToolPanels` 跑真实磁盘日志）：

| 会话 | 用户消息 | step | 工具调用 | 工具面板 | 思考面板 |
| --- | --- | --- | --- | --- | --- |
| `huaanwork-21ea5abce4b51784-b6617067` | 1 | 21 | 66 | 1 个（66 项） | 20 |
| `c5fbbe25-3d5f-4e12-a389-25aa648ba7cc` | 1 | 19 | 31 | 1 个（31 项） | 19 |
| `e693fce6-7454-43d9-be93-ee5c079ec20f` | 1 | 17 | 41 | 1 个（41 项） | 17 |
| `fc21d600-79d1-457f-9d13-ae598c549460` | 1 | 15 | 33 | 1 个（33 项） | 12 |
| `huaanwork-21ea5abce4b51784-ad078701` | 2 | 2 | 0 | 0 | 2 |

全量扫描 `~/.huaanwork/sessions` 下 12 份会话：**没有任何一份出现跨用户消息的工具合并**，面板数与用户消息数一致。因此不存在跨回合状态串扰缺陷；被合并的是同一用户消息内的多个模型轮次。

根因位置：`dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts:375` 只按 `kind === "user"` 切段，`:405` 取 `toolIndexes[0]` 作锚，`:438` 吞掉该段其余工具行。这是 `docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md:24` 裁定表「聚合范围｜每个用户回合一个面板」与 `:103`「后续工具只更新同一个回合面板，不新增会话行」的忠实实现。本设计推翻该条裁定。

术语对齐（此前沟通歧义来源）：

- **用户回合**：一条用户消息开启的回合，日志里的 `turn/start` → `turn/end`。
- **模型轮次 / step**：一次模型往返及其工具执行，日志里的 `step/start` → `step/end`。一个用户回合可含多个 step（实测最多 21 个）。
- 本文「轮次」一律指 **step**。

## 2. 裁定表

| 编号 | 决策点 | 裁定 |
| --- | --- | --- |
| R-1 | 聚合粒度 | 每个**产生普通 `tool` 条目**的 harness step 一个工具看板；同一 step 内多次普通调用归入该看板 |
| R-2 | 轮次身份 `roundKey` | 该 step 的 `step/start` 事件日志 `seq`（会话内单调唯一，跨 turn 不碰撞） |
| R-3 | 实时 `roundKey` 来源 | 并入 bridge 既有 `session/event` 监听器处理 `step/start`，按 sessionId 维护；另听独立 `session/disposed` 清理；状态由插件实例拥有，随 fiber 释放 |
| R-4 | 历史 `roundKey` 来源 | `detailRecords` 顺序折叠 `step/start` 的 `seq`，盖到 thinking / assistant / tool-call 记录 |
| R-5 | 无 `roundKey` 时降级 | 按思考 / 可见正文位置推断轮次边界；可见正文探测不受 `turnFinal` 影响；混合键时只在**首个显式 key 之前的无 key 前缀**推断，已有 key 后的无 key 间隙跟随当前轮；推断可能合并轮次，如实登记 |
| R-6 | 回合条与终态结算 | 保持用户回合粒度不变（`session/end`、`goal-action`、`run-end` 都不带轮次号） |
| R-7 | 实时思考面板 | 同批拆成逐轮一块；thinking 与 assistant 都消费 `roundKey`，`thinkingBefore` 不得回落到异键思考 |
| R-8 | 默认展开 | 只有「活动用户回合的最后一轮且该轮无可见正文」才默认展开；其余轮次默认收起；手动选择始终优先 |
| R-9 | 手动展开归属 | `panelToggled` 仍记在该轮首个工具条目上，随标签保留，压过自动规则与终态默认收起 |
| R-10 | 不变面 | `ToolPanel.tsx` 组件、六态语义与优先级、标题文案 `工具 · X · N 项调用`、逐项展开、长内容滚动、读屏状态区全部不变 |
| R-11 | 立项方式 | 新里程碑 M1；11-01 裁定表 §2 聚合范围行订正为「每个模型轮次一个看板」，原裁定保留为历史 |
| R-12 | `todo_write` 边界 | 有效 `todo_write` 继续走专用待办卡，不计入普通工具看板；历史侧现有 `todo_write` 入板差异登记为残余债，不在本里程碑暗改 |
| R-13 | no-go 与降级 | 当前 pinned 运行时两条轮次来源都验证失败则停止实施；旧宿主/旧 fixture 缺 key 是受支持降级，二者不得混写 |

## 3. 范围与非目标

### 范围内

- 父会话普通工具的看板粒度从用户回合改为 step。
- 实时事件流与磁盘历史恢复两条路径都携带 `roundKey`。
- 实时思考面板按 step 拆块，正文与思考按同轮关联。
- 无 `roundKey` 的旧日志 / 缺席运行时的降级推断。
- 思考面板收尾判定（`hasAssistantTextAfter`）与正文前思考归属（`thinkingBefore`）按轮次收窄。

### 非目标

- 不改工具执行、审批、权限、返回路径。
- 不改回合条、`turnFinal` 结算、goal 续轮语义（R-6）。
- 不改 `ToolPanel.tsx` 展示组件与状态文案（R-10）。
- 不改只读 `HistoryDetailPane`（它逐条显示原始日志，本就不做面板投影）。
- 不改子代理运行卡、审批卡、自由文本输入卡、待办卡的位置与可操作性；有效 `todo_write` 的实时专用映射保持原样（R-12）。
- 不修改 `deepseek-harness/` 子模组任何文件。

## 4. 轮次身份

`roundKey: number | undefined` =  governing `step/start` 事件的日志 `seq`。

选 `seq` 而非 `{turn, step}` 复合键的理由：

- `seq` 在会话内单调唯一，跨 turn 不碰撞（实测 `ad078701` 两个 turn 的 step 号都是 1，复合键必须带 turn，`seq` 不必）。
- 实时侧上游 `TurnBoundaryProjection.lastStepStartSeq`（`deepseek-harness/packages/core/agent/src/types.ts:82`）直接就是这个值，无需 `eventAt` 反查。
- 历史侧 `detailRecords` 顺序迭代时天然可折叠出来。
- 同一会话「历史回填 + 继续实时」时两侧键空间一致，续写不会与历史轮次撞键。

`undefined` 表示轮次身份不可得。**无 key 条目不删除、不隐藏**：在明确 key 建立的当前轮内跟随该轮；在尚未建立 key 的无 key 前缀里按 R-5 推断。

## 5. 三条数据路径

### 5.1 实时

`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts` 的 `apply(ctx)` 内创建 `Map<string, number>`（sessionId → 当前 `step/start` seq）。`step/start` 分支**并入既有 `session/event` 监听器**（`:163-203`），不新增第二个同名监听器，避免打乱既有测试固定取 `[0]` 的监听器顺序。另注册独立 `session/disposed` 监听器删除该会话键；`session/disposed` 不会作为 `session/event` 的 `event.type` 出现（`deepseek-harness/packages/core/session/src/index.ts:63-74`）。

盖键位置（三处，都在父会话分支，子代理分支不盖）：

- `:251` `token` 事件
- `:254` / `:261` `reasoning` 事件（delta 与 `final: true` 两处）
- `:118` `tool/start` 事件

上游依据：`session/event` 由 `deepseek-harness/packages/core/session/src/index.ts:884-889` 派发，`session-projection` 注册表自身就以根级 `ctx.on('session/event', ...)` 消费它（`packages/session/session-projection/src/index.ts:220`）。`step/start` 载荷为 `{turn, step}`（`packages/core/session/src/types.ts:300`），事件外层带 `seq`。

**Task 0 必须先实跑验证该监听在 bridge 的作用域内可达**。探针必须排除日志过滤假阴性：临时实例显式设 `desktop-shell.logLevel=info`，先写阳性对照标记，再统计 `step/start` 标记；阳性对照缺失时先修日志链路，不得判 no-go。若主路线不可达，改用备选路线：`ctx.sessionProjections.stateOf(session, "turnBoundary")?.lastStepStartSeq`（读法先例 `packages/core/agent-loop/src/agent.ts:134`），该路线需要 `Session` 对象，`tool/start` 侧可由 `execution.agent.session` 取得，`token` / `reasoning` 侧需从 `llm/stream` options 补透传。当前 pinned 运行时两条路线都失败则停止实施并回报；旧宿主/旧 fixture 缺 key 才按 R-5 降级。

### 5.2 历史

`dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:184` 的 `detailRecords` 在 `:198` 的顺序迭代里维护 `roundKey`，遇 `step/start` 更新为 `event.seq`，并盖到三处 push：`:231` thinking、`:232` assistant、`:241` tool-call。`tool-result` 不盖键（按 callId 配对，与轮次无关）。

日志顺序已实测确认：`step/start` → `assistant/message`（含 reasoning / text / tool-call 广告块）→ `tool/call` → `step/end`，因此盖键时当前 step 已就位。

契约扩展：`rpc-types.ts:340` 的 `SessionDetailRecord` 三个变体各加 `roundKey?: number`；`RpcEvent`（`:429`）的 `token` / `reasoning` / `tool/start` 各加 `roundKey?: number`。字段一律**条件展开**（`...(roundKey === undefined ? {} : { roundKey })`），使不含 `step/start` 的旧 fixture 形状不变。

### 5.3 客户端映射

- `sessionChannel.ts:91` `HistoryChatItem` 的 thinking / assistant / tool 变体加 `roundKey?: number`；`:128` / `:132` / `:136` 三处 push 透传。
- `App.tsx:3133` `historyToChatItems`：thinking、assistant 与 tool card 都透传 `roundKey`。
- `App.tsx:242` `ToolCard` 加 `roundKey?: number`；`:286` assistant / `:287` thinking 变体加 `roundKey?: number`。
- `logic/toolPanel.ts:7` `ToolPanelCard` 加 `roundKey?: number`；`:23` `ToolPanelItem` 非工具变体加 `roundKey?: number`。
- `logic/thinkingPanel.ts:126` `TurnItem` 的 thinking / assistant 变体都加 `roundKey?: number`。

## 6. 投影规则

`projectToolPanels` 保持「先按用户回合切段」不变（R-6），在每段内部再按轮次切子段。

### 6.1 轮次切段

新增纯函数 `roundKeyOf(item)`：tool 条目读 `card.roundKey`，其余读 `item.roundKey`。

新增内部函数 `splitRounds(items, start, end, visibleAssistantIds)`：

- 显式 key 是权威边界：key 变化处在该条目开新子段。
- 已有显式 key 建立当前轮后，无 key 条目跟随当前轮，不再用推断拆开它。
- 尚未建立 key 的无 key 前缀按推断切轮：已出现过工具之后，遇到 `thinking` 条目或可见正文 `assistant` 条目即开新轮（该条目归入新轮）。
- 轮次边界只认原始条目里的 `assistant`；`attachment` 即使经 `contentItems` 映射成可见正文，也不单独制造轮次边界，跟随当前轮（M-3 口径）。
- `visibleAssistantIds` **始终**按内容视图计算，不因 `segment.final` 清空；`final` 只影响默认展开，不影响分组。

推断的已知不精确：实测 `b6617067` 的 step 2 既无 reasoning 也无可见正文却执行了 4 次调用，推断会把这 4 次并入 step 1 的看板。R-5 接受该合并并登记，不声称精确还原。

### 6.2 面板锚点与行序

每个轮次子段最多产出一个面板行，锚点 = 该子段首个普通 tool 条目的下标，面板 `id` / `anchorId` = 该条目 id。子段内其余普通 tool 条目不产出行。无普通工具的子段不产出面板。所有非工具条目的相对顺序不变。

### 6.3 状态与标题

不变（R-10）：六态 `running / done / failed / interrupted / unconfirmed / resultMissing`，优先级 `STATUS_PRIORITY`，标题 `工具 · ${PANEL_TEXT[status]} · ${tools.length} 项调用`，`connectionLost` 只取 `sidecarDead`。

### 6.4 默认展开（R-8/R-9）

```
panelToggled === "expand"  → true
panelToggled === "collapse" → false
否则 → !segment.final && 是段内最后一轮 && 该轮无可见正文
```

可见正文口径不变：`contentItems` 里 `kind === "assistant"` 且 `resolveThinking({reasoning:"", assistantText}).visible.trim()` 非空；`attachment` 经 `contentItems` 映射回助手正文同样算可见正文（用于默认展开与思考收尾），但不参与 §6.1 的轮次边界判断。探测窗口从「整个用户回合」收窄为「该轮次子段」。

`segment.final` 仍来自用户回合结算（`turnFinalByUserId` / `turnFinalWithoutUser`），因此终态回合内所有轮次看板默认收起；手动展开过的面板保持展开。

## 7. 思考面板逐轮（R-7）

`App.tsx:4511` `applyReasoning` 增加第 5 参 `roundKey?: number`：

- 查找本回合内 `kind === "thinking"` 且 `roundKey` 相同的条目（`undefined === undefined` 视为相同）；命中则按 `nextThinkingSteps` 合并。
- 未命中则新建条目。若本轮已有 assistant 正文，插到**同轮**首个 assistant 之前；否则追加到 `turnAppendIndex(items)`。`roundKey` 缺省时保留旧行为（插到本回合首个 assistant 之前），避免改变旧宿主事件顺序下的位置语义。

`appendToken`（`:4462`）增加第 4 参 `roundKey?: number`：只有相邻 assistant 的 `roundKey` 相同（含双方皆 undefined）才合并；不同 key 新建 assistant，防止无工具 step / max-tokens / steer 续步把正文并进前一轮。

`logic/thinkingPanel.ts:136` `hasAssistantTextAfter`：

- 遇到已启动的下一用户消息仍停止。
- 遇到明确不同 key 的 thinking 或 assistant 停止；无 key 条目跟随当前轮。
- 只有同轮可见正文才把当前思考标记为「已生成」。

`App.tsx:4767` `thinkingBefore` 改为按当前 assistant 的 `roundKey` 找同轮思考；遇到异键思考不得回落使用。其效果是避免当前 assistant 的内联 think 被前一轮 reasoning 抑制，不是把前一轮思考正文直接展示出来。

## 8. 结算与回合条（R-6）

`applyTurnFinalToTabs` / `finalizeTurnTools` / `turnStartFor` / `currentTurnStart` / `runningToolName` / `toolsUnconfirmed` / `historicalTurnFinalByUserId` 全部不改，仍按活动用户消息归属。理由：三类终态事件都不带轮次号，强行按轮次结算需要新造归属信息。

投影侧消费 `final` 的位置保持读用户回合终态；可见正文探测按 §6.4 收窄到轮次，但分组探测不受 final 影响。

goal 续轮仍属同一用户回合：历史侧 goal 源 `user/message` 继续映射为 note（`sessionChannel.ts:120`），实时侧 `goal/round` 继续只加 note。续轮产生新 step，因此自然产生新看板，无需特殊处理。

## 9. 兼容与降级

| 形态 | 行为 |
| --- | --- |
| 新日志（含 `step/start`） | 精确逐轮 |
| 旧日志（无 `step/start`） | 全段均无 key，按思考/可见正文推断，可能合并 |
| 旧历史回填 + 新实时续写 | 旧无 key 前缀推断；新有 key 部分按 key；交界明确开新轮 |
| 旧宿主实时缺 key | 按推断降级；当前 pinned 运行时验证失败不属于此形态，必须停止实施 |
| 无用户条目的自动化运行标签 | 仍是一个合成用户回合，内部按 step 切多个看板；`turnFinalWithoutUser` 结算不变 |
| 排队 / 未启动用户消息 | `isUnstartedUserItem` 语义不变，不切段 |
| 有效 `todo_write` | 实时仍转待办卡；历史侧现有入板差异登记为残余债（R-12） |

契约字段全部可选且条件展开，旧宿主 + 新客户端、新宿主 + 旧客户端都不崩：旧客户端忽略 `roundKey` 继续按用户回合聚合；新客户端收不到 `roundKey` 走推断。

## 10. 验收清单

| 编号 | 场景 | 判据 | 方式 |
| --- | --- | --- | --- |
| A1 | 连续多轮普通调用 | 实时运行后按磁盘日志实际 step 分布核对：看板数 = 产生普通 `tool` 条目的 step 数，位置随会话流推进；有效 `todo_write` 不计入 | 真机 CDP + 日志对账 |
| A2 | 夹杂无工具轮次 | 无普通工具的 step 不产出看板，前后看板不合并 | 真机 CDP + 单测 |
| A3 | 已有会话回看 | 重开 `b6617067`：20 个看板（step 1–20 有工具，step 21 无工具）+ 20 个思考面板，无顶部聚合；该历史夹具含 `todo_write` 入板，不作实时/历史数量相等断言 | 真机 CDP |
| A4 | 跨用户消息隔离 | 两条消息各自有工具 → 看板按消息归属，互不混用 | 单测 + 真机 |
| A5 | 实时思考逐轮 | 思考面板数 = 有 reasoning 的 step 数；下一轮无 reasoning 有正文时，上一轮思考不误标「已生成」 | 真机 CDP + 单测 |
| A6 | 降级推断 | 去掉 `step/start` 的 fixture → 按思考/正文推断；`final=true` 仍按正文切轮；混合键旧前缀推断、新 key 精确 | 单测 |
| A7 | 手动展开归属 | 展开第 3 轮看板后切标签再回来，仍是第 3 轮展开，其余轮次不受影响；终态不压过手动展开 | 单测 + 真机 |
| A8 | 终态默认收起 | 取消 / 失败 / 正常结束后，**无手动覆盖**的看板默认收起；状态逐项按真实终态判断，仅未结算调用允许「已中断」 | 单测 + 真机 |
| A9 | 断连降级 | `sidecarDead` 时在途工具显示「状态未确认」，不计入运行中 | 单测（既有覆盖不回归） |
| A10 | 全量门禁 | `corepack yarn check` exit 0，完整落盘取退出码 | 命令 |

真机验收使用临时隔离实例（`DSH_HOME` + `--user-data-dir` + `--remote-debugging-port=9333` + `HUAANWORK_ACCEPTANCE_HOOKS=1`），不在共用生产数据的「打开应用」dev 实例上做。临时目录用 `mktemp -d` 创建并限制为当前用户权限；其中可能含账户/API 设置，证据只保留必要日志与截图，完成后清理。实时模型行为不确定，判据以运行后磁盘日志的实际 step/tool 分布为准；未产生所需覆盖时标 BLOCKED/补跑，不声称提示词必然触发。无法实跑的项标 UNIT-ONLY / MOCK / BLOCKED，不以单测冒充真机。

## 11. 债务登记

- 推翻 `2026-11-01-chat-tool-panel-design.md:13` / `:24` / `:103-104` / `:123` 的聚合粒度裁定，订正为 R-1；原文保留为历史并加不可执行标记。
- `2026-11-02-chat-tool-panel-plan-review.md` m-4 的 goal 续轮面板碎裂由 R-1/R-7 关闭；但有效 `todo_write` 的实时待办卡/历史工具卡差异不在本里程碑暗改，登记为残余债，m-4 不得写成「两侧完全一致」。
- R-5 推断降级的不精确性登记为已知行为，触发条件：出现无 `step/start` 的真实旧日志且用户报告轮次合并。
- `2026-11-02-chat-tool-panel-verification.md:243` Step 2.1「同回合多次调用只出一个面板」为旧裁定证据，加历史标记，不改写原始记录。

## 12. Review 吸收

`docs/superpowers/plans/2026-11-09-per-step-tool-board-plan-review.md` 的处置：

- B-1/B-2 → §7 同轮思考/正文关联与 `appendToken` 同 key 合并。
- I-1/I-3 → §6.1 分组探测与 final 解耦、混合键局部推断。
- I-2 → §5.1 并入既有监听器 + 独立 disposed 清理。
- I-4 → R-12、§3、§9、A1/A3、§11 残余债。
- I-5 → §5.1 阳性对照与 logLevel 前置。
- I-6 → R-8/R-9、A7/A8、§10 可执行验收与日志对账。
- M-3（附件口径）→ §6.1/§6.4：attachment 作为可见正文参与收起与思考收尾，但不单独制造轮次边界，跟随当前轮。
- M-1…M-9 → 实施计划 Task 0/1/5/8/9 与 Self-Review 订正。