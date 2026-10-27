# HuaAnWork `@子代理` 运行可观测性与定向终止设计

- 日期：2026-10-26
- 状态：**待评估，未实施**。本文只记录调研结论和推荐方案，不代表任何界面、RPC 或宿主能力已经落地。
- 范围：HuaAnWork 高级模式中由用户显式发起的 legacy `@agent` 与智能体包 `@slug`。模型自主创建的嵌套子代理不在首轮范围内。
- 基线：外层仓库 HEAD `1895210b749d3af028e3977ea165f5f0a267a68e`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`0.2.1-rc.1`）。
- 约束：不修改 `deepseek-harness/`，不修改 Stable/Beta 源码，不新增变体白名单。行号以本次基线为准，后续实施须同时按符号名重新定位。

## 1. 问题结论

用户反馈属实。当前不是“子代理没有工作”，而是：

1. 上游已经产生子代理启动、活动与结束事实，但 HuaAnWork 没有把这些事实组织成会话页可消费的运行状态。
2. 子代理的 token、reasoning 和工具事件已经到 WebSocket，却因 child session 没有绑定任何会话标签而被前端丢弃。
3. 界面只跟踪父会话的 `turnActive`。父 Agent 先 idle、子代理仍在后台工作时，运行状态和停止入口都会消失。
4. 智能体包已有较完整的在途取消和资源清理；legacy `@agent` 的启动 signal 与 activation 只留在局部闭包中，无法从路由层精确取消。
5. 当前没有统一的“任务总运行超时”。已有的 600000ms 上限是**父会话 idle 后等待 activation 收尾的预算**，现在只写日志并释放 activation，不会向用户呈现“收尾超时”。

因此，最小根治方向不是新增一个 loading 文案，也不是把 child 事件直接塞进父消息流，而是补一个按父会话和运行实例关联的 Host 状态面，再向会话页投影独立卡片。

## 2. 已确认的产品边界

| 编号 | 用户确认 | 本方案行为 |
| --- | --- | --- |
| R1 | 知道子代理是否正在工作 | 每次显式 `@` 调用都有独立运行卡；启动、活动、终态来自 Host 真实事件，不靠父回合猜测 |
| R2 | 知道干到了哪个阶段 | 展示启动中、思考、生成、正在执行哪个工具、等待收尾、停止中及真实终态；不展示模型自报的“分析/开发/测试”等业务阶段 |
| R3 | 知道是否超时或长时间没有活动 | 展示总耗时、最近活动和无新活动提醒；现有 activation 收尾超时单独可见；本轮不新增任务级自动超时时限 |
| R4 | 能终止当前子代理 | 每张运行卡只终止选中的运行实例；不取消父会话，不影响兄弟子代理；受理后先显示“停止中”，确认所需清理完成后才显示“已停止” |

“终止”指结束本次 activation。对智能体包还包括本次回合拥有的 HTTP/MCP/技能脚本运行时清理。它不等于对 `spawn` 执行 OS `kill()`：当前 `spawn` 是同一 Host 进程内的新 Agent 与新 Session，不是独立 OS 进程。

## 3. 已核实的现状

### 3.1 调用链

显式 `@` 的现有链路为：

```text
client-huaanwork/App.tsx send()
  → session.send
  → huaanwork-host/sessions.ts sendToAgent()
  → huaanwork-host/agent-invoke.ts dispatchAt()
  → legacy @agent 或 agent-package/host.ts @slug
  → subagents.startActivation({ provider: 'spawn', delivery: 'parent' })
  → child Agent 在独立 child session 执行
  → activation settlement 交回父 Agent
  → 父 Agent 再生成用户可见回复
```

关键证据：

- `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:1811` `send()` 解析 `invokedAt`，在 `:1901-1924` 写入用户消息并发送 `at.name + remainder`，没有建立子代理运行状态。
- `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:110` `sendToAgent()` 在 `:212-231` 调用 `dispatchAt()`，随后把 `parentText` 交给父 Agent。
- `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts:211` 的 legacy 分支在 `:248-267` 调用 `startActivation()`。
- `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:805-946` 登记包在途回合、启动辅助 runtime，并调用同一 `startActivation()` 入口。
- `deepseek-harness/packages/subagent/subagent-spawn-in-process/src/index.ts:1-5,38-58` 明确 `spawn` 是同一 Cordis context 上的 fresh child Agent。

### 3.2 上游已有生命周期，但 HuaAnWork 没有投影

上游 rc.1 已有：

- `subagent/start`：`runId / provider / id / local`。
- `subagent/end`：上述字段加 `stopReason / lastAssistantMessage`。
- activation：`childId / result / dispose()`。
- 终态原因：`completed / aborted / error / max-tokens / refusal`。

证据位于：

- `deepseek-harness/packages/subagent/subagent/src/types.ts:46-59,76-115,227-278`。
- `deepseek-harness/packages/subagent/subagent/src/manager.ts:1023-1073,1093-1205`。
- `dsh-plugin-huaanwork/src/huaanwork-host/subagents-service.ts:30-54`。

HuaAnWork 当前的消费方式：

- `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:201-215` 只用 start/end 登记和删除 parent→child 关系，不向 UI 发事件。
- `dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts:1-27` 只保存 `Map<parentSessionId, Set<childSessionId>>`，没有 runId、名称、阶段、时间、最近活动或终态。
- `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:359-415` 的 `RpcEvent` 没有任何子代理生命周期或运行投影事件。

### 3.3 子代理活动到了前端，但被路由丢弃

`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts` 已产生：

- `llm/stream` → `token / reasoning`，见 `mapTokens()` 与 `:177-205`。
- `tools/execute` → `tool/start / tool/end`，见 `:84-113`。
- `agent/status idle`、`agent/error` → `session/end`，见 `:156-174`。

这些事件携带事件发起 Agent 的 sessionId；子代理事件因此携带 childId。前端 `dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts:275-294` 的 `eventTargetTab()` 只接受已绑定 tab 的 sessionId，childId 不属于任何 tab 时返回 `undefined`，随后不会写入会话条目。

不能通过“把 childId 直接绑定到父 tab”修复，否则会同时造成：

- child token 被拼进父 assistant 正文；
- child `session/end` 被误判为父回合结束；
- child 工具、diff、goal/compaction 状态污染父会话；
- 多个同名或并发子代理无法区分。

### 3.4 当前停止能力及其边界

现有 `session.cancel` 位于 `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:296-315` `cancelAgent()`：它取消父 Agent、所有已登记 child，并对智能体包调用 `cancelBySessionId()`。它是**会话级**能力，不满足“只停选中的子代理”。

前端 `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:1941-1971` `stopTurn()` 受 `turnActive` 限制；父 Agent 已 idle 时会直接早退。因此父 idle、child 仍运行时，现有停止入口不可用。

智能体包路径已有可复用的精确清理原语：

- `AgentPackageActiveTurnRecord` 保存 `controller / runtime / activation / cancel`，见 `agent-package/host.ts:94-136`。
- `cancelTurn()` 在 `:773-803` 执行 abort、activation dispose、runtime 停止与 cleanup。
- `:921-945` 已处理 activation 晚到和实际 childId 绑定。

legacy 路径不同：

- `agent-invoke.ts:248-267` 使用匿名 `new AbortController().signal`，controller 没有保存。
- activation 只被局部变量和 `afterIdle` 闭包持有，见 `:260,267,276-295`。
- 因而启动发布前没有可触达取消源，发布后也没有供新路由精确调用的 record。

上游 `interruptByParent()` 只中断指定子代理的当前执行，child 可保留 inbox 并被继续唤醒；`accepted` 也不代表已经 quiescent。它不能直接替代本方案的“终止整个 @ 运行实例”。证据见 `deepseek-harness/packages/subagent/subagent/src/index.ts:502-537` 与 `manager.ts:185-227`。

### 3.5 当前各种“超时”不是同一语义

| 现有机制 | 真实含义 | 不能宣称什么 |
| --- | --- | --- |
| `ACTIVATION_CLEANUP_TIMEOUT_MS = 600000` | 父 Agent idle 后，等待 activation result 的收尾预算；到期后 dispose | 不是从子代理启动开始计算的任务 SLA |
| 技能脚本 150 秒 | 包技能脚本单次执行硬上限 | 不是整个子代理的超时 |
| `agent_http` 默认 60 秒、硬上限 150 秒 | 单个 HTTP 工具调用超时 | 不是整个子代理的超时 |
| UI 5 分钟静默提示 | 没有新展示事件的提醒 | 不代表任务已失败或已超时 |
| Host 2 秒探活、15 秒 suspect、60 秒 stoppable | Host 进程健康监督 | 不是子代理心跳或运行期限 |

activation 收尾预算的位置：

- legacy：`agent-invoke.ts:276-295`，超时只 `console.error` 后 dispose。
- 智能体包：`agent-package/host.ts:701-735`，同样只记录日志并继续释放。

## 4. 方案比较

| 方案 | 优点 | 主要缺陷 | 结论 |
| --- | --- | --- | --- |
| A. 仅转发 start/end，前端临时建态 | 修改面最小，能补基础开始/结束 | 启动前身份和取消不完整；重连丢状态；收尾超时仍不可见；无法可靠处理同名并发、旧 end、包 runtime 清理和 accepted/stopped 差异 | 不满足核心需求 |
| B. Host 统一运行状态面 + 独立卡片 + 精确取消 | 单一权威状态；覆盖 legacy 与包路径；支持启动中取消、重连对账、真实清理状态和多 run 隔离 | 需要新增运行 registry 和少量跨层契约 | **推荐** |
| C. 直接接入上游 ui-subagent/projections | 可参考目录、谱系、耗时和部分交互 | 依赖上游 sessions/slots/client 组合，当前自定义 App 不能直接挂载；上游 stop 偏当前轮次 interrupt；仍不覆盖包 runtime 和 HuaAnWork 收尾预算 | 成本高且仍不完整 |

上游 UI 只作为交互参考，不直接引入组件或 projection 运行时。

## 5. 推荐架构

### 5.1 单一权威运行记录

新增 HuaAnWork Host 运行 registry，只服务显式 `@agent` / `@slug`。每次调用在启动前建立 record，至少保存：

| 字段组 | 内容 |
| --- | --- |
| 身份 | Host `runId`、`parentSessionId`、`kind: legacy \| package`、`label`、包版本、`clientMessageId?`（仅本次用户消息锚点）；后续绑定 `childId` 与 `upstreamRunId` |
| 状态 | `phase`、当前工具集合、`stopReason`、停止/清理原因 |
| 时间 | `startedAt`、`endedAt?`、`lastActivity`、父 idle 后收尾等待开始时间、`stopRequestedAt?`（定向停止首次受理时间） |
| 控制 | 精确 cancel 闭包、execution settled 与 owner cleanup 确认状态 |
| 对账 | registry generation、单调递增 revision |

三层身份各自承担不同职责：

1. **Host `runId`**：一次显式 @ 调用的主键。WS、snapshot 和 cancel 都只认它，启动前即存在。
2. **预留 `childId`**：用于最早的 token/tool 活动归因。包路径沿用现有预留机制；legacy 补齐。（评审记录 R4）provider 未沿用预留 id 时，activation 返回后以实际 `activation.childId` 重绑定 run 的活动归因，已挂在预留 id 上的活动随之迁入（包路径既有同型 fallback：`agent-package/host.ts:938-945`）。
3. **上游 `upstreamRunId`**：收到 `subagent/start` 后绑定，严格配对其后的 `subagent/end`，避免旧 end 清掉新 run。

activation spec 继续使用 HuaAnWork 私有 symbol 元数据，经现有 `AsyncLocalStorage` 启动作用域把 Host runId 带到 start 事件。不得按 slug、显示名、最近发送或当前 active tab 猜归属。

registry 不替换 `AgentPackageActiveTurnRegistry`。后者继续负责撤销、更新、移除和父会话取消；新 registry 只持有“这一次 run 的精确 cancel 闭包”和展示状态，不复制包清理逻辑。

### 5.2 状态机

| 状态 | 进入依据 | 展示含义 |
| --- | --- | --- |
| `starting` | Host 已建 run，尚未看到 child 执行活动 | 正在校验、准备 runtime 或发布 activation |
| `reasoning` | 选中 child 的 reasoning 活动 | 正在思考；只显示状态，不把 reasoning 正文塞进卡片 |
| `generating` | 选中 child 的 text/token 活动；或无工具仍在运行时工具结束 | 正在生成或等待模型继续 |
| `tool` | 选中 child 的 `tool/start` | 正在执行真实工具名；并发工具按 callId 分开记录 |
| `finalizing` | child Agent idle，尚未收到权威 activation 终态 | 执行接近收尾，但不能提前宣称完成 |
| `stopping` | 非终态 run 的定向停止已受理，或收尾预算到期开始强制释放 | 停止/清理尚未完全确认 |
| `completed` | 无停止意图时，权威 `stopReason === 'completed'` | 子代理执行完成 |
| `failed` | 启动失败，或 `error / max-tokens / refusal / unknown` | 按真实原因显示失败；未知原因不得当成功 |
| `stopped` | 已收到停止意图或权威 `aborted`，且该路径要求的执行终结与资源清理均确认 | 本次 @ 运行已停止 |

补充规则：

- `tool/end` 只清除对应 callId；不能清空另一个仍在运行的工具。
- `stopping` 期间可以更新最近活动，但不能回退到 reasoning/generating/tool。
- 终态后忽略迟到活动，不复活旧 run。
- `activation.result` 与 `subagent/end` 由同一幂等结算入口处理；`activation.result` 仍 pending 时，先到的 `subagent/end` 只保存候选、保持当前非终态且不写 `endedAt`，不先发布 `failed`；resolved result 到达后再定终态，冲突按 D2 以 result 为准、end 的 `error` 记入 `cleanupWarnings`。
- （评审修订 D2）两来源**冲突**时以 `activation.result` 为准：上游 teardown 失败会把 `subagent/end` 的 stopReason 覆写为 `error` 而 `activation.result` 仍携带真实执行结果（`manager.ts:1177-1182`），此时卡片按 result 显示终态，end 的 `error` 记入 `cleanupWarnings`；只有 result 缺席（rejection）时才由 end 或启动错误单独定终态。
- 停止请求先到时，后续原始 stopReason 仍保留用于诊断，但不把卡片改成 `completed`。
- 定向停止闩（以及父会话等其他来源 `aborted` 引发的 `stopping`）存在时，后续 `settleResult`（含 `completed`）、`activation.result` rejection 与启动/外层 `failRun` 都只保留原始 `stopReason`/`failure` 与执行终结事实，不得退出 `stopping`；所需清理确认后才进入 `stopped`。
- （终审修订）清理确认是**持久状态**而不是一次性事件：`confirmCleanup({ok:true})` 早于执行终结到达时只保存「清理已确认」事实，不改相位、不写 `endedAt`；之后进入 `stopping` 且执行已终结时同一拍收敛为 `stopped`，不要求第二次确认。`{ok:false}` 不写入成功，并撤销早先的成功结论（清理快照之后出现的资源不受旧确认保护），只按最新结论决定能否发布 `stopped`；晚到的成功仍可让停止中的 run 收敛。已终态 run（含自然终态）不因任何确认翻转。
- 现有父会话取消等其他路径产生的权威 `aborted` 也必须反映为 `stopped`，不得让卡片一直显示运行中；package 仍须等待 owner cleanup。无法确认具体来源时只记录 `aborted`，不猜测是用户、父会话还是系统停止。
- 父会话自己的 idle 不触发 child `finalizing`；只有 child 的 idle 可以触发。
- child 的工具失败只说明该工具失败，不直接决定整个 run 的终态。

`stopped` 的确认条件因路径而异：

- legacy：activation 已终结；若从未发布 activation，则启动已因取消拒绝且局部清理完成。
- package：除 activation 终结外，还必须确认本 run 的辅助 runtime 已停止并完成 MCP/binding 清理。

仅 RPC 返回、abort 已调用、cancel accepted 或 dispose 已发起，都不满足 `stopped`。

### 5.3 事件与活动投影

新增面向 UI 的单 run 投影事件，而不是原样暴露上游事件：

- 生命周期、工具和清理状态变化立即发布。
- token/reasoning 只更新 phase 与 lastActivity，不转发文本；高频活动可按约 1 秒合并，终态前 flush。
- 终态历史被淘汰时发布带 generation/revision 的移除事件；重连时再由 snapshot 校正缺失项。
- snapshot 使用同一 run 形状，避免 WS 与恢复路径两套语义。

建议字段包括：

```text
runId, parentSessionId, clientMessageId?, childId?, upstreamRunId?, kind, label,
phase, activeTools[], startedAt, endedAt?, lastActivity?, stopRequestedAt?,
stopReason?, stopCause?, cleanupBudgetMs?, cleanupWarnings[{code, severity}], failure?, generation, revision
```

- `clientMessageId` 由客户端在 `session.send` 时以 `at.clientMessageId` 传入本次 `userMsg.id`，Host 仅随 run 投影原样返回，用于把卡片锚定到本次用户消息之后；它不是取消 capability，不参与 runId 生成或权限判断。
- `stopRequestedAt` 在定向停止**首次受理**时由 Host 写入，重复请求不改写；WS 与 snapshot 都携带它。60 秒停止升级提示只能以该权威时间计算，不能使用客户端收到事件的本地时间，否则重连后提示会被重置或提前/延后。
- `cleanupBudgetMs` 只在实际收尾预算到期时由 Host 写入，legacy 使用 `ACTIVATION_CLEANUP_TIMEOUT_MS`，package 使用本回合 `cleanupTimeoutMs`；前端按该值格式化「等待收尾超过 N」文案，缺字段时不得编造数值。
- `cleanupWarnings` 使用结构化 `{ code, severity: 'info' | 'error' }`，不传输任意错误堆栈。UI 按稳定 `code` 映射文案、提醒优先级与 banner 类型；未知 code 使用通用清理提醒并保留 Host 给出的 severity，不得通过解析中文字符串决定样式。

不向全局 WS 增加 prompt、reasoning/token 正文、工具参数/输出、`lastAssistantMessage` 或原始错误堆栈。

bridge 对已知 child 的事件改为更新 registry 并发送 run 投影；不得再把该 child 的 diff、goal、compaction 或 session/end 送入父消息流。未登记的普通会话事件保持原样。

### 5.4 定向取消 RPC

建议新增：

- `subagent.list({ parentSessionId })`：返回该父会话的有限运行 snapshot 与对账信息。
- `subagent.cancel({ parentSessionId, runId })`：只取消匹配的运行实例。

取消流程：

1. 校验 run 存在且 `run.parentSessionId` 与请求完全一致；不匹配按未找到处理，零副作用。
2. 已终态则返回 `already-terminal`，不重新取消。
3. 首次受理时同步记录停止意图并进入 `stopping`，启动后台取消，随后立即返回 accepted；不在 RPC 中等待最长 600000ms 的清理。
4. 只调用该 record 的精确 cancel：legacy 使用保存的 controller + activation dispose；package 复用 `cancelTurn()`。
5. 禁止退化为 `cancelBySessionId`、`cancelBySlug`、父 Agent cancel 或遍历所有 children。
6. 等真实终态与所需清理确认后，registry 才发布 `stopped`。

启动中取消必须覆盖两个晚到分支：

- `startActivation()` 尚未返回：先 latch 停止意图并 abort；activation 晚到后立即 dispose。
- 包 runtime 尚未返回：停止意图先落 record；runtime 晚到后走现有停止和 binding 清理。

### 5.5 耗时、静默与收尾超时

- 总耗时为 `startedAt → endedAt/now`，由客户端共享的 1 秒 tick 驱动（可复用 `App.tsx` 现有 `now`），每个 run 独立计算，与父 `turnActive` 无关；不得为每张卡各建一个 interval。WS 断连时按 D7 冻结显示，重连对账后按最新 run 状态恢复。
- lastActivity 只由选中 child 的 token/reasoning/tool 活动更新；start/end/cancel/snapshot 不算执行活动。
- 没有 child 活动时，从 startedAt 计算静默时长。
- 可沿用现有 5 分钟提醒阈值，文案为“已 N 分钟没有新活动”，不得写“已超时”，也不触发自动停止。
- 600000ms 收尾预算到期时，卡片明确显示“父会话空闲后等待收尾超过 10 分钟，已开始强制释放”，并记录 `stopCause`；不得改写成“任务运行超过 10 分钟”。
- 收尾预算数值来自 Host 配置/常量，不由前端另写一份。

自然完成或失败的执行结果不被后续清理告警篡改；清理告警作为独立字段展示。执行已经终态后才发生的收尾超时只追加告警，不再把卡片切回 `stopping`。定向停止时若 dispose/runtime 停止未确认，则保持 `stopping` 并显示“停止已受理，收尾未确认”，不得伪报已停止。

### 5.6 WebSocket 重连对账

当前 WS 新连接只补 `sidecar/status ready`，不会重放子代理状态。因此需要 snapshot，而不是假设事件永不丢失。

推荐采用 registry generation + revision：

1. Host registry 新一代创建时更换 generation。
2. 每次 run 变化递增 revision；事件和 snapshot 都携带它。
3. generation 不同的 snapshot 替换旧的**活跃/可取消**运行状态，不从旧 Host 代际推导成功或失败；旧非终态卡片按 §6.1 D6 保留为客户端「状态不可恢复」失效视图，而不是被 snapshot 删除，也不得继续参与活跃 run 对账。
4. generation 相同时，旧 snapshot 不得覆盖已经到达的新 WS 事件。
5. snapshot 捕获后新建的 run，即使不在该 snapshot 中，也不得被误删。
6. 活跃和停止未确认的 run 不因历史裁剪而淘汰；终态只保留有界最近项，建议默认每父会话 20 条、全局 200 条，实施评审时核对是否适合实际会话规模。

本轮不持久化 Host 控制面。Host 重启前的活跃 run 不得被猜成 completed/stopped；界面只能说明旧状态已失效或不可恢复。

## 6. 会话页设计

每次显式 `@` 调用在对应父会话中显示一张独立运行卡，位置跟随该次用户消息之后。卡片不是普通工具卡，也不参与父回合的 runningTool/outcome 计算。

卡片内容：

- 标题：`@name`，包路径可附版本。
- 真实状态：启动中、思考中、生成中、执行工具、等待收尾、停止中、完成、失败、已停止。
- 当前工具：显示工具名；多个并发工具显示数量或可展开列表。
- 时间：总耗时，以及最近活动距今时长。
- 提醒：无新活动提醒、收尾预算告警、清理未确认。
- 操作：活跃或启动中的卡片显示“终止”；受理后禁用并显示“停止中”。

交互边界：

- 父 Agent 已 idle 时，子代理卡片仍更新，终止按钮仍可用。
- 停止只提交本卡的 `parentSessionId + runId`，不调用 `session.cancel`，不修改父 `turnActive/stopPendingRef`。
- 停止 RPC 错误落回原卡片，不写进当前激活 tab。
- 同名 run 各自独立；旧 end、旧 tool/end 不影响新 run。
- 卡片更新不抢焦点；终止按钮支持键盘和可访问名称。
- 不显示伪造百分比，不用“心跳存在”推断完成度。

首次事件可能早于 tab 的 sessionId 绑定。实施时须在 `session.send` 应答后按**发起本次发送的 tab**补齐绑定并拉取 snapshot；不能回落到当前 active tab。实时事件的卡片插入优先使用 run 携带的 `clientMessageId` 精确匹配该 tab 的 `userMsg.id`，锚点缺失时不得插入其他 tab；snapshot 对账可在已确认的 parent tab 内回退到最后一条用户消息，避免 renderer 重载后丢卡。

### 6.1 运行卡视觉与交互规范（/plan-design-review，2026-10-26）

本节只记录已逐项裁定的设计决策；未写入的提案仍为待定，不得视为已批准。

- **读屏播报（D20/18A）**：使用单一 `role="status"` + `aria-live="polite"` + `aria-atomic="true"` 区域，仅在相位或在途工具集合变化时更新播报文本；token、秒级耗时与最近活动不自动播报，但计时文本仍可在浏览模式中读取。真实清理失败只用 `role="alert"` 播报一次，避免与状态区域重复；不得把整张卡设为 live region。
- **键盘与焦点（D21/19A）**：终止、确认、取消与展开均使用原生 `button`，提供 `--accent` 的 `:focus-visible` ring；展开按钮带 `aria-expanded`。卡内确认区的初始焦点放在「取消」，Esc 取消后将焦点返还原「终止」按钮；不得使用模态 focus trap。
- **减少动态效果（D22，用户授权采用推荐项）**：尊重 `prefers-reduced-motion: reduce`，命中时停用呼吸脉冲与非必要过渡，以静止状态点和文字表达相同状态；不得因关闭动效隐藏状态差异。
- **点击目标（D23，用户授权采用推荐项）**：运行卡内所有可点控件的命中区域至少为 44×44 CSS px；视觉文字/图标可保持桌面密度，通过 padding 或伪元素扩大命中区，且相邻命中区不得重叠。
- **同名运行区分（D24，用户授权采用推荐项）**：同一父会话存在多张相同 `@名称` 卡片时，在标题辅助位置显示 `startedAt` 的 `HH:MM:SS`（mono + tabular-nums）；卡内确认文案与可访问名称也带上该时间。仅显示 slug 或 runId 不足以作为用户侧区分手段。
- **长名称（D25，用户授权采用推荐项）**：`@名称` 在标题行单行截断为省略号，完整名称保留在 `title` 与可访问名称中；不得用长名称把终止按钮挤出卡片。窄窗口仍按 D19 重排。
- **展开状态（D26，用户授权采用推荐项）**：展开/收起状态按 runId 保留在当前 tab 的**独立 UI Map** 中，不存进会被 WS/snapshot 替换的 run 对象；WS 重连与同代 snapshot 对账不得重置。进入终态时先按 D5 收为单行，用户再次展开后不得被后续事件自动折叠。该 UI 偏好不跨应用重启持久化。
- **窄窗口重排（D19/17A）**：运行卡随 assistant 列收缩，最小内容宽度 280px；空间不足时状态/工具名换行，版本与耗时移到次行，终止及卡内确认始终可见。不得产生横向滚动，也不得通过隐藏状态或操作节省空间；长工具名在单行摘要中截断，完整名称可在展开列表查看。本需求不新增手机页面。
- **并发工具（D18/16A）**：默认显示「正在执行 N 个工具」并列出前 2 个真实工具名，其余显示「+N」；可展开完整在途列表。列表按 `tool/start` 先后排序、以 callId 作稳定次序；`tool/end` 只移除对应项。单个工具直接显示工具名，不显示数量、参数或输出。
- **终止确认（D17/15A）**：首次点击「终止」只在原卡按钮区展开「确认终止 @名称 / 取消」，确认后才调用 `subagent.cancel`；Esc 或切换到其他卡片/标签可取消该确认态，确认前不得发 RPC。确认区存在期间使用 window 级 `keydown` 监听并在卸载时移除（沿用 `MarketSourcePanel.tsx:141-148` 的既有模式），不得只依赖容器 `onKeyDown`；若确认前 run 已终态，则关闭确认区且不再发 RPC。不得使用模态确认框；受理后按 D3/D16 显示「停止中」。
- **终止按钮样式（D16/14A）**：默认使用 `--text-muted` 文本 + hairline 边框的 pill，hover/focus 时转为 `--error` 文本与边框；受理后禁用并显示「停止中」。不使用 composer 的常驻实心红，不用单独的 `×` 图标，避免把定向终止误读成会话级停止或关闭卡片。
- **字体与数据排版（D15/13A）**：`@名称` 与主状态使用 13.5px，名称 600、状态 500；包版本、耗时与工具名使用 `--font-mono`（JetBrains Mono）并开启 `font-variant-numeric: tabular-nums`；最近活动等辅助信息使用 11px。不得另造 12px 等字阶外尺寸；耗时/数字使用 tabular-nums，避免秒级刷新导致行宽抖动。
- **状态色与动效（D14/12A）**：`starting` / `reasoning` / `generating` / `tool` 使用 `--accent` 状态点，并沿用工具 pill 的 1.4s 呼吸脉冲；`finalizing` / `stopping` 使用静止的 `--accent` 状态点，不再脉冲。`completed` 使用 `--success`，`failed` 使用 `--error`，`stopped` 与断连/Host 重启失效视图使用 `--text-muted`；停止不画成失败。无活动、收尾预算与清理未确认等等待/提醒使用 `info`（`--accent-soft`） banner，只有真实清理失败使用 `error`（`--error` / `--error-bg`） banner；**所有运行卡提醒禁用琥珀**，不得侵占「需要批准」语义。正文与状态文字的对比度须达到 4.5:1，浅色与深色 token 均覆盖。
- **容器与位置（D13/11A）**：复用 `.card` 的 `--surface` 底、hairline border 与 `--radius-md`（10px），不加装饰性阴影；运行卡与 assistant 正文列左对齐并占该列可用宽度，不右对齐到用户气泡，也不横跨整个三栏工作区。不得使用 accent 左边条或新渐变容器。
- **信息层级（D3/1A）**：活跃卡采用三行结构。第一行放状态点、`@名称`、包版本（仅 package）与「终止」；第二行放当前状态/工具与总耗时；第三行放最近活动。无活动、收尾预算与清理提醒只在出现时追加，不与三行常态内容争夺注意力。扫描优先级为：当前状态 → 本次 `@` 身份 → 时间与提醒；终态卡片的折叠另由后续决策规定。
- **发起窗口（D8/6A）**：不在 `session.send` 应答或 Host `begin` 之前创建本地乐观运行卡；用户消息与既有发送反馈覆盖这段 RPC 窗口，首个权威 run 投影到达后立即显示「启动中」。发送失败不得留下虚假运行卡，也不得引入第二套本地 runId。
- **WS 断连滞后视图（D7/5A）**：WebSocket 断开到重连 snapshot 对账完成前，运行卡保留最后已知状态并追加「连接中断，状态可能滞后」，停止脉冲与计时、暂时禁用终止；对账成功后按最新 run 状态恢复。不得把断连本身当作 run 失败或结束。
- **Host 重启失效视图（D6/4A）**：发现 registry generation 切换后，旧 Host 代际的活跃/停止未确认卡原位改为「状态不可恢复 · Host 已重启，结果未确认」，冻结计时并禁用终止；保留 `@名称` 和最后已知状态供回看。该「失效」仅是客户端展示状态，不是新的 Host 终态，不得映射为 completed/failed/stopped。
- **终态降噪（D5/3A）**：`completed` / `failed` / `stopped` 后，三行活跃卡立即收为单行历史卡，保留 `@名称`、真实终态与总耗时；有清理告警或失败详情时提供可展开的详情入口。每次显式 `@` 仍各自保留一张卡，不做同名 `×N` 聚合，不合并 runId。
- **父子状态分工（D4/2A）**：当前父会话存在活跃运行卡时，父回合状态行只显示「主会话运行中」，不再重复工具名与静默提醒；子代理的工具与活动详情只出现在各自运行卡。这里的「活跃」指 Host 非终态 run（含 `stopping`）；Host 重启失效卡不算活跃，WS 断连时保留最后已知的非终态归属。没有活跃运行卡时，父回合状态行保持现有 `turnStatus` 行为。该规则只改展示，不改变 `turnActive` 或任何取消语义。

- **停止等待升级（D12/10A）**：定向停止受理后 60 秒仍未完成所需清理确认时，在原卡追加「停止已受理超过 1 分钟，资源释放仍未确认；可离开此卡稍后查看，无需重复点击」。60 秒只从 Host 的 `stopRequestedAt` 计算，重连后不得重新计时；这只是 UI 提醒，不是任务 SLA，不改变 Host 状态，不触发自动重试或强制 kill；首版也不新增手动重试入口。

用户旅程故事板（对已批准决策的汇总）：

| STEP | USER DOES | USER FEELS | PLAN SPECIFIES? |
| --- | --- | --- | --- |
| 1 | 发送一次显式 `@` | 「请求已被受理」 | 用户消息即时出现；Host begin 后立即显示「启动中」，不伪造本地 run（D8） |
| 2 | 扫视子代理工作 | 「它在做什么、属于哪次调用都清楚」 | 三行层级、真实工具名、耗时与最近活动（D3） |
| 3 | 等待结果结算 | 「知道还在等什么」 | 「正在确认执行结果」+ 子代理已空闲的副文案（D11） |
| 4 | 终止选中的运行 | 「只停这一个，操作已受理」 | 原卡进入「停止中」，不影响父/兄弟；严格确认后才显示已停止（D3 工程评审） |
| 5 | 清理等待较久 | 「仍知道发生了什么，可以离开稍后再看」 | 60 秒升级说明，不伪报、不强迫重复点击（D12） |
| 6 | 回顾历史或再次调用 | 「历史安静但每次运行仍可区分」 | 终态单行可展开，不做同名聚合（D5） |
| 7 | 遇到断连或 Host 重启 | 「界面不会骗我」 | 断连标记滞后；重启后原位失效，不猜结果（D6/D7） |

时间尺度：首 5 秒由「启动中」和真实状态建立信任；5 分钟内由定向终止与等待说明维持掌控；长期使用中由不虚构终态、可回看的独立历史卡维持可信赖感。

- **finalizing 文案（D11/9A）**：主状态显示「正在确认执行结果」，副文案为「子代理已空闲，等待运行结果返回」；不得写成「即将完成」。该文案只解释 child idle 后的真实等待，不改变 `finalizing` 的进入条件或终态确认边界。
- **提醒叠加（D10/8A）**：每张卡默认最多直接展示一条提醒，优先级为「清理未确认/清理失败 > 收尾预算 > 无新活动」，其余提醒经展开查看。提醒在条件仍成立时保留；无活动提醒在下一真实活动到来后消失。`completed` 可携带清理告警标记与详情，但不得因此改写为 `failed`。

已裁定的界面状态覆盖如下（对既有决策的汇总，不新增行为）：

| 功能 | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
| --- | --- | --- | --- | --- | --- |
| 运行卡 | Host begin 后显示「启动中」；此前只有既有发送反馈 | 无 run 不插卡 | 按固定原因文案显示；取消 RPC 错误落原卡 | 终态收为单行，可展开 | 活跃三行卡；工具与提醒按真实状态局部呈现 |
| 终止操作 | 受理后「停止中」，清理确认前不显示「已停止」 | 已终态无终止按钮，返回 `already-terminal` | 清理未确认保持「停止中」并显示提醒 | 确认后为单行「已停止」 | 启动中也可受理；晚到 activation/runtime 继续清理 |
| 重连对账 | 断连时冻结并标记「状态可能滞后」 | 无 run 的父会话不生成运行卡 | generation 切换后旧活跃卡显示「状态不可恢复」 | 对账后恢复实时卡片 | 同代按 revision 合并；不误删 snapshot 捕获后新建的 run |

- **终态文案映射（D9/7A）**：不直接显示原始 `stopReason` 或内部堆栈，使用下表固定文案。原始 `aborted` 只有在满足 D3 的执行终结与清理确认后才显示「已停止」；清理未确认时仍按 `stopping` 展示，不得因本映射提前改成终态文案。

| Host 终态/原因 | 卡片文案 |
| --- | --- |
| `completed` | 已完成 |
| `stopped`，或已满足清理确认的 `aborted` | 已停止 |
| `error` | 失败 · 执行出错 |
| `max-tokens` | 未完成 · 达到模型输出上限 |
| `refusal` | 未完成 · 子代理拒绝执行 |
| `unknown` 或未识别原因 | 失败 · 原因未知 |

```text
┌──────────────────────────────────────────────┐
│ ● @代码审查  v1.2.0                    [终止] │
│ 正在执行工具 · read_file               02:34 │
│ 最近活动 12 秒前                              │
│ [仅在出现时显示提醒]                          │
└──────────────────────────────────────────────┘
```

## 7. 关键竞态与失败处理

| 场景 | 必须保持的行为 |
| --- | --- |
| activation 发布前点击终止 | run 已存在；进入 stopping 并 abort；晚到 activation 立即 dispose |
| activation 启动失败且从未发布 start | 无停止意图则 failed；已有停止意图且清理完成则 stopped；不虚构 upstream end |
| start 在 stop 后迟到 | 只补身份和最近活动，保持 stopping |
| end 与 cancel 交错 | 已终态则 cancel 返回 already-terminal；cancel 先受理则停止意图不被 completed 覆盖 |
| end 与收尾超时交错 | 先到结果先生效；超时不被后续 aborted 擦除；自然执行结果与清理告警分开 |
| package end 已到但 runtime 未停 | 定向停止仍保持 stopping，等待 owner cleanup 确认 |
| dispose/runtime stop 拒绝或超时 | 显示收尾未确认，不伪造 stopped；晚到真实确认可继续收敛 |
| 同 slug 并发 | 一律按 Host runId 区分，slug 只作展示 |
| 同 child 的旧 end 与新 run | 只按 upstreamRunId 结算旧 run；不得清新 run 状态或登记 |
| result 与 end 重复 | 幂等结算，不生成两张卡或两次终态 |
| WS 断线 | ready 后 snapshot 对账；revision 防止旧快照覆盖新事件 |
| Host 重启 | 不恢复虚假的可取消活跃态，不猜旧任务成功或失败 |
| 普通模型创建的嵌套子代理 | 首轮不进入显式 @ 卡片；选中 activation 的 descendants 仍由上游 dispose 按所有权处理 |

## 8. 预计修改面（实施时核对）

以下为方案落点，不是本轮已做的修改。

### Host 与共享契约

- 新增 `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts`：运行 record、状态机、幂等结算、snapshot、定向取消与有界历史。
- 修改 `src/huaanwork-host/subagents-service.ts`：增加调用级 run 元数据类型和读取方式。
- 修改 `src/huaanwork-host/holders.ts`、`src/huaanwork-host/index.ts`：注入同一个 registry 与事件发布器；注意 host/guardrails 分打包入口，不能假设普通模块级 Map 天然只有一份。
- 修改 `src/huaanwork-host/routes.ts`、`src/client-huaanwork/rpc-types.ts`、`src/client-huaanwork/api.ts`：增加 list/cancel 契约和 run 投影事件。

### 两条执行链

- 修改 `src/huaanwork-host/agent-invoke.ts`：legacy 预留 childId、保存 controller、启动前建 run、晚到 activation 取消、观察 result、上报收尾预算和清理结果。
- 修改 `src/huaanwork-host/agent-package/host.ts`：把现有 record/cancelTurn/runtime/binding 清理接到统一 run；保留 pendingTurns、cancelGate、late runtime/activation 等既有竞态处理。
- 保留 `src/huaanwork-host/child-sessions.ts` 的父会话级取消用途，不把它扩成第二套 UI run 账本。

### 生命周期与活动桥

- 修改 `src/huaanwork-guardrails/skills.ts`：start 绑定 Host/upstream runId，end 严格配对；保留现有 parent-child 登记和工具护栏。
- 修改 `src/huaanwork-guardrails/bridge.ts`：已知 child 的活动转 run 投影，隔离父消息流与父 diff/goal/session 状态。

### 前端

- 新增 `src/client-huaanwork/logic/subagentRuns.ts`：run reducer、snapshot 对账、状态文案与计时纯函数。
- 新增 `src/client-huaanwork/SubagentRunCard.tsx`：独立运行卡和定向终止入口。
- 修改 `src/client-huaanwork/App.tsx`：按 parentSessionId 归属卡片，发送后绑定对账，独立秒级时钟和停止处理。
- 修改 `src/client-huaanwork/styles.css`，并通过既有生成器更新 `styles.generated.ts`；复用现有视觉 token，不引入上游整套样式。

## 9. 安全与隐私边界

1. 继续复用现有 loopback/same-origin 路由检查。
2. cancel 只接受 registry 中的 runId，并强制匹配 parentSessionId；不能接受任意 childId、slug 或 `clientMessageId` 作为取消 capability。
3. 跨父会话查询或取消按未找到处理，不泄露另一会话的 run 信息。
4. 启动绑定时核对 activation parent、ALS parent 与 registry parent；不一致则 fail closed 并释放本次 activation。
5. UI 投影不包含 prompt、思考正文、工具参数/输出、子代理最终回答或内部错误堆栈。
6. 不因为增加状态面而放宽既有工具 allow、policy、sandbox 或包安全复验。
7. M1 已登记的 legacy 首轮 allow、provider 忽略预留 childId 时 fallback restrict/refresh 等残余属于相邻安全问题；本方案不得宣称顺带修复，实施时也不得扩大这些缺口。

## 10. 后续实施的验证矩阵

| 层 | 必测场景 |
| --- | --- |
| registry | begin、三层 ID 绑定、全部 phase、工具 callId、lastActivity、stopReason 映射、未知原因 fail closed、首次受理写入且重复取消不改写 `stopRequestedAt`、结构化 cleanupWarnings 的 code/severity |
| 乱序与并发 | 同名/跨父会话并发、重复 end、旧 end、旧 tool/end、result/end 双到、终态不复活 |
| 终态仲裁(评审 D2) | result=completed 与 end=error 双到(两种到达顺序各一)、result rejection 时由 end 单独定终态、冲突不覆盖 cleanupWarnings |
| legacy 取消 | 发布前 abort、startActivation pending 时取消、晚到 activation dispose、result rejection 有观察者、afterIdle/cancel 幂等 |
| package 取消 | createRuntime/startActivation 期间取消、晚到 runtime/activation、只停选中的 runtime、MCP/binding/pendingTurns 既有回归不失效 |
| 隔离 | 定向 cancel 不调用 parent.cancel、兄弟 activation.dispose 或其他 runtime stop；不退化为会话级取消 |
| accepted/stopped | deferred dispose/runtime stop 未确认时只显示 stopping；确认后才 stopped；已终态返回 already-terminal |
| 收尾预算 | 注入短预算验证提示可见；父未 idle 时不触发；dispose/runtime 超时不能假报停止 |
| bridge | child 活动转 run；父事件原样通过；child session/end/diff/goal/compaction 不污染父状态 |
| RPC | 参数校验、错误 parent/run 零副作用、跨域仍拒绝、cancel 不等待长清理、路由契约同步 |
| snapshot | 丢事件后恢复、旧 snapshot 不覆盖新事件、snapshot 后新 run 不丢、generation 切换后旧非终态卡保留为失效视图而非删除、活跃 run 不被历史裁剪、`stopRequestedAt` 与展开 UI Map 在重连后不重置 |
| 前端 | 按 parent 插卡、多 tab 不串、同名独立、原卡片错误落点、父 idle 后计时与终止仍可用 |
| 运行卡 UI（设计评审） | 三行层级与父状态摘要、终态单行与展开保持、同名时间戳、长名称、断连/失效视图、确认前零 RPC、提醒优先级与 60 秒提示、reduced-motion 与窄窗口；焦点/读屏按 A-15/A-16 核对 |
| 可访问性 | 终止按钮键盘可达、状态更新不抢焦点、动态文案不过度打断读屏 |
| 真实组合 | 至少一轮真实 spawn 的 legacy 与包路径：启动→工具活动→完成，以及启动中/运行中定向停止 |

建议实施后的验证顺序：registry/bridge/两条执行链定向测试 → 客户端 reducer/card/RPC 契约 → huaanwork typecheck 与 test → `corepack yarn check:desktop-variants` → huaanwork 完整 headless check → 真实 @ 多 tab 手工核对。

### 10.1 功能验收清单

本清单用于实施后的功能验收，不代表当前已经通过。范围仅包括用户显式发起的 legacy `@agent` 和智能体包 `@slug`，不包含模型自主创建的嵌套子代理。

验收记录须填写 Desktop SHA、Harness pin、测试平台、构建类型、测试人和证据链接。测试条件须覆盖两条真实 `@` 路径，并能模拟慢工具、并发工具、延迟 activation/runtime、清理失败和 WS 断连。

#### A. 运行状态与界面

- [ ] **A-01 独立运行卡**：每次显式 `@` 都在发起该调用的用户消息后生成一张独立卡片；legacy 与 package 均覆盖，标题和运行实例对应正确，位置由 `clientMessageId` 精确锚定。
- [ ] **A-02 启动状态可信**：activation 发布前即显示“启动中”，不等待首个 token，也不依赖父回合猜测状态。
- [ ] **A-03 生命周期完整**：通过真实事件覆盖 `starting → reasoning/generating/tool → finalizing → completed/failed`；只有 child idle 才进入 `finalizing`，父 idle 不触发。
- [ ] **A-04 工具状态准确**：显示真实工具名；并发工具按 `callId` 独立记录，一个 `tool/end` 不清除其他仍在执行的工具。
- [ ] **A-05 终态映射诚实**：`completed` 才显示完成；`error / max-tokens / refusal / unknown` 均不得显示成功；单个工具失败不直接决定整个 run 失败。
- [ ] **A-06 父 idle 后仍可用**：父 Agent 已 idle、child 仍运行时，卡片继续更新，计时继续，定向终止仍可操作。
- [ ] **A-07 耗时与静默提示**：总耗时独立于父 `turnActive`；`lastActivity` 只由 child 的 token/reasoning/tool 活动更新；无活动提醒不写成“已超时”，也不自动停止。
- [ ] **A-08 收尾预算语义正确**：通过注入短预算验证提示；预算从父 idle 后起算，显示为“等待收尾超时”，不得写成“任务运行超过 10 分钟”，数值来自 Host。
- [ ] **A-09 父子消息流隔离**：child 的 token、reasoning、工具内容、`session/end`、diff、goal、compaction 不进入父正文或父回合状态；运行卡不参与父 `runningTool/outcome` 计算。
- [ ] **A-10 多标签归属正确**：首次事件早于 tab 绑定时，仍归入发起发送的 tab；不得落入当前 active tab，停止错误也只显示在原卡片。
- [ ] **A-11 可访问性**：终止按钮键盘可达并有可访问名称；卡片更新不抢焦点，动态状态不过度打断读屏，不显示伪造百分比或业务阶段。
- [ ] **A-12 视觉层级与工具展示**：活跃卡符合三行层级；父状态行按 D4 降级为摘要；同名运行显示 `HH:MM:SS` 区分，长名称截断且可读取全名；并发工具默认前 2 个 + `+N`，可展开完整在途列表。
- [ ] **A-13 终态与失效视图**：终态收为单行且每次运行独立，手动展开不被后续事件重置；WS 断连冻结并标记滞后，Host 重启后旧活跃卡原位失效且不猜结果。
- [ ] **A-14 文案与提醒**：finalizing、各 stopReason 使用 §6.1 固定文案；提醒按优先级单条展示且全部可展开；停止受理 60 秒未确认出现升级说明，时间取自 Host `stopRequestedAt` 且重连不重置；运行卡提醒不使用琥珀，样式由结构化 warning code/severity 决定而非解析文案。
- [ ] **A-15 终止确认与焦点**：首次点击不发 RPC，卡内确认后才发送；确认区初始焦点在「取消」，window 级 Esc 取消并返回原「终止」，监听器随确认区卸载；确认前 run 已终态则关闭确认且零 RPC；展开控件有 `aria-expanded`，运行卡内所有可点目标命中区至少 44×44 CSS px。
- [ ] **A-16 动效、窄窗口与读屏**：仅活跃执行相位使用脉冲，`prefers-reduced-motion` 下停用；280px 最小内容宽度无横向滚动且操作可达；相位/工具变化礼貌播报，计时不自动播报，真实清理失败只 alert 一次。

#### B. 定向终止与资源清理

- [ ] **B-01 legacy 运行中终止**：只停止选中的 run；父 Agent、兄弟子代理及其他会话不受影响；RPC 及时返回 `accepted`，不等待长清理。
- [ ] **B-02 package 运行中终止**：复用 `cancelTurn()`，只清理本 run 的 activation、HTTP/MCP runtime 和 binding；确认清理完成后才显示“已停止”。
- [ ] **B-03 legacy 启动中终止**：覆盖 `startActivation()` 尚未返回的场景；停止意图先落记录，晚到 activation 立即 dispose，不继续执行。
- [ ] **B-04 package 启动中终止**：分别覆盖 `createRuntime()` 和 `startActivation()` 在途；晚到 runtime/activation 均按既有所有权完成停止和清理。
- [ ] **B-05 停止过程可见**：受理后先显示“停止中”；仅调用 abort、RPC 返回、cancel accepted 或 dispose 已发起，均不能提前显示“已停止”。
- [ ] **B-06 幂等与终态处理**：重复终止不产生重复清理或二次副作用；已终态 run 返回 `already-terminal`，不重新取消。
- [ ] **B-07 cancel/end 竞态**：cancel 先受理时，后续原始 `completed` 只保留诊断信息，不覆盖停止意图；end 先完成时，后续 cancel 不制造新状态。
- [ ] **B-08 清理失败不伪报**：dispose/runtime stop 拒绝或未确认时，保持“停止中”并显示收尾未确认；晚到真实确认可以收敛为已停止。
- [ ] **B-09 其他取消来源可反映**：父会话取消等路径产生权威 `aborted` 时，卡片不得一直运行；package 仍等待 owner cleanup，无法确认来源时不猜测来源。
- [ ] **B-10 定向取消边界**：错误 `parentSessionId/runId`、跨父会话请求按未找到处理且零副作用；不得接受任意 childId/slug 作为取消 capability，也不得退化为父会话或全儿童取消。

#### C. 并发、乱序与恢复

- [ ] **C-01 同名与同 slug 并发**：每个 Host `runId` 独立建卡、更新和终止，slug/显示名只用于展示。
- [ ] **C-02 旧事件不串扰**：旧 `subagent/end` 只按对应 `upstreamRunId` 结算；旧 end、旧 `tool/end` 不影响新 run。
- [ ] **C-03 重复结算幂等**：`activation.result` 与 `subagent/end` 双到、重复到达时，只生成一张卡和一次终态。
- [ ] **C-04 停止后迟到事件**：start、activity 在 stop 后迟到时，只补允许的信息，卡片保持 `stopping`；终态后迟到活动不得复活 run。
- [ ] **C-05 WS 断线重连**：ready 后通过 snapshot 补齐运行状态；丢事件后能恢复，活跃 run 和停止未确认 run 不丢失。
- [ ] **C-06 snapshot/WS 竞态**：同 generation 下旧 snapshot 不覆盖较新的 WS 事件；snapshot 捕获后新建的 run 不被误删。
- [ ] **C-07 Host 代际切换**：generation 变化后，旧 Host 的活跃状态不得被推导成 completed/stopped，也不恢复虚假的可取消能力。
- [ ] **C-08 历史有界**：终态历史按实施配置有界淘汰；活跃及停止未确认的 run 永不因历史裁剪被移除，淘汰后可通过 snapshot 对账。
- [ ] **C-09 Host 重启**：不持久化控制面，不猜旧任务成功或失败；界面明确旧状态失效或不可恢复。

#### D. 安全、隐私与回归

- [ ] **D-01 投影不泄密**：WS、snapshot 和卡片均不包含 prompt、reasoning/token 正文、工具参数/输出、最终回答或内部错误堆栈。
- [ ] **D-02 启动绑定 fail closed**：activation parent、ALS parent 与 registry parent 不一致时拒绝启动并释放 activation。
- [ ] **D-03 路由安全不放宽**：loopback/same-origin、参数校验和跨父会话隔离保持有效；跨域请求仍被拒绝。
- [ ] **D-04 权限与沙箱不回归**：不放宽既有工具 allow、policy、sandbox 或智能体包安全复验；legacy 首轮 allow、provider fallback 等相邻安全债不得被宣称顺带修复。
- [ ] **D-05 既有取消语义不变**：父会话 `session.cancel` 仍表示“父 + 已登记 children”；定向取消是新增能力，不替换原语义。
- [ ] **D-06 普通会话无回归**：未登记的普通会话事件保持原样；普通对话、父 Agent 回复和 package 既有 pendingTurns/cancelGate/清理流程不受影响。
- [ ] **D-07 非目标未混入**：不新增任务级 SLA 或无活动自动停止；不把 `spawn` 当 OS 进程 kill；不引入控制面持久化、嵌套子代理树或上游整套 UI。
- [ ] **D-08 代码边界**：不修改 `deepseek-harness/`、Stable/Beta 源码，不新增 variant 白名单。

#### E. 工程放行与真实组合

- [ ] **E-01 定向自动化全部通过**：registry、bridge、legacy/package 取消、乱序并发、RPC、snapshot、客户端 reducer/card 和路由契约测试均通过。
- [ ] **E-02 仓库门禁通过**：按当前仓库脚本执行并通过 `corepack yarn typecheck`、`corepack yarn test`、`corepack yarn check:desktop-variants`、`corepack yarn check`。
- [ ] **E-03 真实完成链路**：至少分别执行一次真实 spawn 的 legacy 和 package：启动 → 工具活动 → 完成，不能只用 mock 或单测代替。
- [ ] **E-04 真实取消链路**：legacy 和 package 分别覆盖启动中终止与运行中终止，确认选中 run 停止且父/兄弟运行不受影响。
- [ ] **E-05 真实组合场景**：人工核对多 tab、同名并发、父 idle 后子代理仍运行、WS 重连及清理未确认提示。
- [ ] **E-06 平台证据诚实**：按发布支持矩阵记录 macOS/Windows 结果；未执行项标为“未验证/Blocked”，不得以 CI、单测或另一平台结果冒充真机通过。

#### 验收通过判定

只有 A–D 全部通过、E-01～E-05 通过，且平台证据按实际执行情况如实记录，才能宣布本子代理功能验收完成。

以下任一情况直接判为不通过：定向停止影响父或兄弟 run、accepted 被提前显示为 stopped、child 内容污染父会话、未知终态被显示成功、Host 重启后虚构运行结果，或仅用自动化测试替代真实 `@` 验收。

## 11. 非目标

- 不新增统一任务 SLA、无活动自动停止或新的自动超时时限。
- 不改变现有 600000ms 收尾预算的起算点和语义。
- 不把 `spawn` 当 OS 进程 kill；不引入新的强制进程协议。
- 不用 `interruptByParent` 代替整个 activation 的终止。
- 不改变父会话现有 `session.cancel` 的“父 + children”语义。
- 不展示模型自报业务阶段，不展示伪造百分比。
- 不把 child token、reasoning、工具输出或最终回答直接塞进父消息流。
- 不做嵌套子代理树、child 续聊/恢复、完整 transcript 或所有模型自主子代理的统一面板。
- 不持久化 Host 控制面，不承诺 Host 重启后恢复取消能力。
- 不在清理失败时伪报成功；自动重试和额外强制 kill 不在本轮。
- 不接入上游 ui-subagent、slots、sessions projection 或 Sidebar Chat 整套体系。
- 不修改 `deepseek-harness/`、Stable/Beta 源码或 variant 白名单。

## 12. 后续评估重点

1. **状态确认强度**：**已裁定（评审 D3，2026-10-26）**——接受严格语义：package 必须等 runtime/binding 清理确认后才显示「已停止」，确认前保持「停止中（收尾未确认）」；它比仅看 subagent/end 更慢，但更诚实。
2. **状态面范围**：首轮只覆盖显式 @，避免把模型自主嵌套子代理和部分持久化谱系一起拉进范围。
3. **重连成本**：generation + revision 是为解决 snapshot 与 WS 竞态，不是为了持久化；实施时应保持这套对账尽量小，不另建通用事件溯源系统。
4. **历史保留**：20/父会话与 200/全局是防止内存无界增长的推荐默认值，不是产品承诺；需结合实际会话规模评估。
5. **失败呈现**：清理未确认必须可见，不能为了卡片“好看”而提早写已停止；是否增加手动重试属于后续硬化，不混入首版。
6. **相邻安全债**：legacy 首轮工具 allow 与 provider fallback restrict/refresh 需要独立验证，本功能的状态接线不能掩盖或扩大它们。

---

本文是设计输入，不是实施完成证据。当前会话页仍没有上述运行卡、定向取消 RPC 或重连运行 snapshot。

---

## GSTACK 评审记录(plan-eng-review, 2026-10-26)

评审对象(固定): 本文档《HuaAnWork `@子代理` 运行可观测性与定向终止设计》, 基线外层 HEAD `1895210b74` / harness pin `1600d8a1e1`。

### Scope record(Scope Challenge B 结论)

- feature answers: 未提议任何功能砍除或延后(R1-R4 全部为用户已确认需求;generation/revision 对账为标准小机制, 不裁)。
- structure: **保持原编排**(D1 答案 A;~16 文件 / 3 新模块 + 2 RPC, 贴合仓库『一主题一文件』惯例;不并入 2000+ 行的 App.tsx)。
- accepted scope: 本文档 §2 R1-R4 + §5 推荐方案 B 全量;§11 非目标保持排除;文件编排按 §8 原样。
- pending remedies: F1(`subagent/end` 与 `activation.result` 冲突仲裁规则缺失)、F2(`stopped` 严格语义确认, 即文档 §12.1 自留开放项)。

### 前提表核实(Scope Challenge A)

| premise | 结论 | 证据 |
| --- | --- | --- |
| §3.1 调用链(App.tsx→sessions→dispatchAt→两条 startActivation 路径) | 属实 | App.tsx:1814/1901-1924, sessions.ts:110/220-229, agent-invoke.ts:211/248-267, agent-package/host.ts:805-946 |
| spawn = 同 Host 进程内 fresh child Agent(非 OS 进程) | 属实 | subagent-spawn-in-process/src/index.ts:1-5,38-46 |
| 上游 start/end 载荷与五种终态原因 | 属实 | subagent/types.ts:46-59,80-115,233-244; lifecycle.ts:102-114 |
| skills.ts 只登记 parent→child、不向 UI 发事件 | 属实 | skills.ts:201-215 |
| child 事件携 childId 到 WS 但被前端丢弃 | 属实 | bridge.ts:81-113/156-174; outcomeCheck.ts:280-294 |
| session.cancel 为会话级、stopTurn 受 turnActive 限制 | 属实 | sessions.ts:296-315; App.tsx:1942 |
| legacy 匿名 AbortController、activation 仅闭包持有 | 属实 | agent-invoke.ts:256,260-295 |
| 包路径 record/cancelTurn/晚到 activation 处理可复用 | 属实 | agent-package/host.ts:105-120,778-803,921-945 |
| 600s 是收尾预算而非任务 SLA, 只记日志 | 属实 | host.ts:299; agent-invoke.ts:282-284; host.ts:730-733 |
| 技能脚本 150s、UI 5 分钟静默提醒 | 属实 | runtime.ts:27; turnStatus.ts:1 |
| agent_http 默认 60s/硬上限 150s | **属实**（第二轮评审补核实） | huaanwork-guardrails/agent-package-tools.ts:33-36,295 |
| WS 重连只补 sidecar/status ready | 属实 | api.ts:206-210 |
| host/guardrails 分打包入口、模块级 Map 会成双 | 属实(既有先例) | child-sessions.ts:9-10 |
| 修改面全部落在 huaanwork 专属前缀内, 不占变体白名单 | 属实 | §8 全部路径属 `src/huaanwork-*`/`src/client-huaanwork/` 前缀 |

REALITY: premise-table finding — unverified=0(agent_http 已于第二轮补核实, dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:33-36,295), false=1(end/result 一致性假设, deepseek-harness/packages/subagent/subagent/src/manager.ts:1177-1182)
REALITY: already-done pass — 三个新文件不存在; origin/master 近一周无该特性 (HEAD 1895210b74)
REALITY: surface-check pass — 无新 CLI; subagent.list/cancel 与 session.send/cancel 同惯例 (dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:491-492)
REALITY: binding-decisions pass — 分支无在先裁定; 修改面全在 huaanwork-only 前缀 (dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts:9-10)
REALITY: numbers pass — agent_http 60s/150s [measured: dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:33-36]; activation 600s [measured: dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:299], 技能脚本 150s [measured: dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:27], UI 5min [measured: dsh-plugin-huaanwork/src/client-huaanwork/logic/turnStatus.ts:1]; 20/200 [estimated]
REALITY: deferred-asks pass — 无链接 issue; R1-R4 全覆盖 (docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:23-28)
REALITY: pr-count pass — 无 ship-policy.json, 默认单 PR (.gstack/ship-policy.json 在 HEAD 1895210b74 不存在); 方案未提议拆分

## Decision ledger

### R1: `subagent/end` 与 `activation.result` 的 stopReason 冲突仲裁规则
Finding: SC-2, CRITICAL, confidence 9/10, `deepseek-harness/packages/subagent/subagent/src/manager.ts:1177-1182` + `lifecycle.ts:30-36`, reviewer: plan-eng-review
Plan baseline: 文档 §5.2 原文「`activation.result` 与 `subagent/end` 经同一幂等结算入口，先到者生效，后到者只补缺失信息」——只覆盖『后到者补缺失』，未规定两来源**冲突**时的仲裁。
Runtime evidence: `manager.ts:1177` `const terminal = failure === undefined ? result : { output: [], stopReason: 'error' }`;`:1180` `activation.observer.settle(terminal)`;`:1181-1182` `activation.result.resolve(result)` —— teardown 失败时 `subagent/end` 的 stopReason 被覆写为 `error`，而 `activation.result` 仍 resolve 真实执行结果(可能为 `completed`)。`lifecycle.ts:30-36` 确认 end 在 disposal 结果已知之后才发布，故『end 晚到且与 result 冲突』是真实可达形态。
Comparison grid:

| Choice | Current(文档 §5.2) | A | B | C |
| --- | --- | --- | --- | --- |
| 冲突仲裁 | 未规定 | result 优先;end=error 且 result 非 error 时记 cleanupWarning | end 优先,一律 failed | 维持未规定 |
| §5.5『清理告警不篡改执行结果』 | 已规定 | 保持一致 | 被破坏 | 不闭环 |
| §10 测试矩阵 | 无分歧用例 | 随选项补一条(必要验证,同批) | 随选项补一条 | 不补 |

Question D2:
D2 — 终态冲突仲裁:`subagent/end` 与 `activation.result` 不一致时卡片听谁的
Project/branch/task: HuaAnWork 子代理运行可观测性设计评审(branch refactor/huaanwork-single-desktop)
ELI10: 上游源码证实,子代理『执行结果』和『结束事件』可能给出不同结论:执行成功但清理(释放资源)失败时,结果通道说 completed,结束事件说 error。文档现在只写了『谁先到听谁的、晚到的补缺』，没说两者打架怎么办——不写清楚,卡片显示什么取决于事件到达顺序。
Stakes if we pick wrong: 同一次运行两次实现可能显示相反终态;验收条款 A-05(终态映射诚实)无法判定通过。
Recommendation: A,因为它与文档 §5.5 已写的『清理告警不篡改执行结果』原则同构。
Completeness: A=10/10, B=6/10, C=2/10
Header: 终态仲裁
Options:
A) result 优先 + cleanupWarning (recommended)
✅ 与 §5.5 既有原则同构,设计内部自洽,实施者无需猜测,验收 A-05/B-08 可直接判定
✅ 用户看到真实执行结果,清理失败作为独立告警仍然可见,不丢诊断信息
❌ 结算入口需识别『分歧』这一情形,比单一来源优先级多一条分支与一条测试
B) end 优先,一律显示 failed
✅ 规则最简单,end 永远覆盖,实现与测试量最少
✅ 清理失败最显眼,运营上不会漏看 teardown 问题
❌ 把『执行成功但清理失败』显示成 failed 同样是误报,与 §5.5 明文冲突,且会把可用结果藏掉
C) 不写仲裁规则
✅ 文档零改动,本轮评审不再占用决策
✅ 保留实施者按现场情况选择的自由度
❌ 同一冲突两次实现可得出相反行为,终态随事件到达顺序漂移,A-05/B-08 无法判定通过
Net: 选 A 把冲突收敛到 §5.5 已有原则;选 B 用误报换简单;选 C 把不确定性留给实施现场。

State: approved
Actual answer: A(result 优先 + cleanupWarning), D2, 2026-10-26
Accepted scope: 文档 §5.2 补冲突仲裁规则(result 优先;end 的 error 与 result 不一致时记入 cleanupWarnings;result 缺席时由 end 或启动错误单独定终态);§10 测试矩阵补一条分歧用例(与规则同批, 属必要验证)。
History: none

### R2: §3.5 agent_http 超时的数值订正(事实订正, 无需裁决)
Finding: SC-1, INFORMATIONAL, confidence 10/10, `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:603-607`, reviewer: plan-eng-review
Record: 第一轮未定位到数值；第二轮已在 `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:33-36` 核实 `DEFAULT_HTTP_TIMEOUT_MS = 60_000` 与 `HARD_TOOL_TIMEOUT_MS = 150_000`，并在 `:295` 核实默认值的实际使用。文档 §3.5 数值属实，无需订正。
State: closed(第二轮评审补核实, 2026-10-26)

### R3: `stopped` 的确认强度(文档 §12.1 自留开放项)
Finding: A-F2, INFORMATIONAL(语义确认), confidence 8/10, 文档 §5.2 `stopped` 行 + §5.4 第 6 步 + §12.1; 上游佐证 `manager.ts:183-227`(accepted≠quiescent), reviewer: plan-eng-review
Plan baseline: 文档 §5.2/§5.4 已写严格语义(执行终结 + owner cleanup 确认后才 `stopped`), §12.1 把「是否接受」留作评估开放项——需要用户裁定,不是文档缺陷。
Runtime evidence: 包路径 `cancelTurn`/`cleanup` 的确认链路存在(host.ts:701-803);上游 interrupt 的 accepted 明确不代表 quiescent(manager.ts:217-227)。
Comparison grid:

| Choice | Current(文档 §5.2/§5.4) | A | B |
| --- | --- | --- | --- |
| stopped 确认 | 严格(清理确认后) | 确认严格语义 | dispose 发起即 stopped, 清理失败转告警 |
| B-05/B-08 验收条款 | 与严格语义一致 | 保持一致 | 须改写,否则自相矛盾 |
| 资源泄漏可见性 | 可见(stopping 不收敛) | 可见 | 被『已停止』掩盖 |

Question D3:
D3 — 「已停止」的确认强度:清理确认前卡片显示什么
Project/branch/task: HuaAnWork 子代理运行可观测性设计评审(branch refactor/huaanwork-single-desktop)
ELI10: 用户点「终止」后,子代理的 HTTP/MCP 运行时可能要几秒到几分钟才真正释放完。文档目前写的是严格语义:确认清理完成前只显示「停止中(收尾未确认)」,确认后才显示「已停止」。文档 §12.1 把这个留给你拍板:慢一点但诚实,还是快一点但可能伪报。
Stakes if we pick wrong: 选宽松语义,清理卡住时用户以为已停止,残留运行时继续占资源且无人知晓;选严格语义,清理慢时卡片长时间停在「停止中」,但这是真实状态。
Recommendation: A,与文档 §5.2/§5.4 及验收 B-05/B-08 已写语义一致,不伪报。
Completeness: A=10/10, B=5/10
Header: 停止语义
Options:
A) 严格:清理确认前只显示「停止中」 (recommended)
✅ 与 B-05/B-08 验收条款一致,不伪报停止,资源泄漏(清理未确认)对用户可见
✅ 与包路径既有 cancelTurn/cleanup 确认链路同构,实现无需两套标准
❌ 清理卡住时卡片长时间停在「停止中」,观感上像没停掉(但那是事实)
B) 宽松:dispose 发起即显示「已停止」
✅ 用户点停止后立刻看到「已停止」,反馈更轻快
✅ 实现略简单,少一个「收尾未确认」中间态的展示分支
❌ dispose 发起≠资源释放,MCP/HTTP runtime 可能仍活着;伪报停止掩盖泄漏,直接撞 B-08
Net: 选 A 用观感换诚实;选 B 用伪报换轻快。文档主体已按 A 写好,本问是把 §12.1 的开放项正式关闭。

State: approved
Actual answer: A(严格:清理确认前只显示「停止中」), D3, 2026-10-26
Accepted scope: 维持文档 §5.2/§5.4 已写的严格 stopped 语义;§12.1 开放项关闭为已裁定;验收 B-05/B-08 不变。
History: none

### R4: legacy 预留 childId 的 provider-fallback(必要实现记录, 无需裁决)
Finding: A-F4, INFORMATIONAL, confidence 8/10, `agent-invoke.ts:248-259`(legacy spec 无 childId) + `subagents-service.ts:34-38` + `agent-package/host.ts:938-945`(包路径既有 fallback 先例), reviewer: plan-eng-review
Record: §5.1 的『预留 childId』依赖 provider 沿用;provider 忽略预留 id 时 activation.childId 与预留不一致,最早活动归因会落空。这属于已批准契约(§5.1『预留 childId 用于最早活动归因』)的必要实现:activation 返回时 childId ≠ 预留则以实际 childId 重绑定并迁入已归因活动。已在 §5.1 第 2 条补记,随实施同批,不单独裁决。
State: recorded(必要实现, 并入已批准范围)

Approval readiness: PASS(R1←D2 已批准; R3←D3 已批准; R2/R4 为记录项, 无 pending remedy; 检查时间 2026-10-26)

## 评审正文(plan-eng-review)

### Section 1 架构 — 2 issues
- A-F2(stopped 确认强度)→ 经 D3 裁定严格语义, §12.1 已关闭。
- A-F4(legacy 预留 childId 的 provider-fallback)→ 记录为已批准契约的必要实现, §5.1 已补记。
- 其余评估: registry 单权威、bridge/skills 只投影不复制状态、cancel 双校验 + fail-closed 绑定、§7 竞态表覆盖上游真实形态(residency 前失败无事件、interrupt 非终止、accepted≠quiescent)。分打包入口的单例风险由 holders 注入解决, 与 child-sessions.ts:9-10 的 Symbol.for 先例一致。

### Section 2 代码质量 — 1 issue
- Q-F5(automation run 先例, App.tsx:472 / rpc-types.ts:403-415)→ 记录: 不抽取共享(状态机与取消语义不同), 实施时引用其 runId 键控与计时模式为先例。

### Section 3 测试 — 0 剩余缺口
- 框架 vitest(dsh-plugin-huaanwork/tests/)。覆盖图与 Test Plan Artifact 已产出:~/.gstack/projects/kawaiininja-HuaAnWork-Desktop/amonmiao-refactor-huaanwork-single-desktop-eng-review-test-plan-20261026-193315.md。
- 评审期间补强两行: D2 终态仲裁分歧用例(§10)、R4 预留 id 重绑定用例(§10 registry 行已含三层 ID 绑定)。
- 回归契约: D-05(父会话 cancel 语义不变)/D-06(普通会话与包既有清理不回归)由文档验收条款承载。

### Section 4 性能 — 0 issues
- token 路径 O(1) 查表 + 约 1s 合并投影; 历史 20/200 有界; snapshot 每重连一次; 无循环查询与无界缓存。

### NOT in scope(评审层面追加)
- 上游 ui-subagent/projections 接入(方案 C, 文档 §4 已否)。
- 嵌套子代理树、控制面持久化、任务级 SLA/自动超时(文档 §11)。
- Outside voice 覆盖: 本轮 unavailable, 不构成通过。

### What already exists
- `AgentPackageActiveTurnRegistry` + `cancelTurn`(agent-package/host.ts:105-136,778-803): 包路径精确清理原语, 方案复用而不替换(§5.1 末段)。
- `child-sessions.ts`: 父会话级取消登记表, 保留单一职责(§8)。
- automation run 跟踪(App.tsx:472 `runningRuns`, rpc-types.ts:403-415): 同形不同语义的先例; runId 键控/计时模式可参照, 不抽取共享。
- `eventTargetTab` 的 `pendingSessionId` 回退(outcomeCheck.ts:280-294): §6 多 tab 归属规则照搬此模式。
- `startParent` AsyncLocalStorage(skills.ts:206,246,316): Host runId 携带机制的既有载体。
- 上游 lifecycle 事件(types.ts:80-115, lifecycle.ts:96-116): start/end 事实源, 经幂等结算入口消费。

### Diagram

```text
用户 @name                Host registry(单权威)                 上游 spawn
   │ send()                     │ begin(runId, 预留 childId)         │
   ▼                            ▼                                  │
sessions.ts → dispatchAt ──► startActivation(ALS 带 runId) ──────►│ child Agent
                                │◄──── subagent/start(upstreamRunId) │
                                │ phase: starting→reasoning/tool/…   │ activity
   UI 卡片 ◄── run 投影(WS) ◄── │        (bridge 改路由, 1s 合并)      │
                                ▼                                  │
                    result / subagent/end ──► 幂等结算(D2: 冲突 result 优先)
                                ▼
                    stopped 仅当: 终态 + owner cleanup 确认(D3)
取消: UI ──► subagent.cancel(parentSessionId+runId) ──► 精确闭包(legacy controller / package cancelTurn)
           禁止退化为会话级取消; stopping 闩先行, 不等 600s 清理
```

### Failure modes
- 清理确认永不到达 → 卡片长期「停止中(收尾未确认)」, 可见不静默; 有测试(§10 accepted/stopped 行)。
- Host 重启 → 旧 run 状态明示失效, 不虚构终态; 有测试(C-07/C-09)。
- WS 断线丢事件 → snapshot + generation/revision 对账; 有测试(C-05/C-06)。
- critical gaps flagged: 0(每个失败形态都有处理与可见性)。

### Worktree parallelization strategy

| Step | Modules touched | Depends on |
|------|----------------|------------|
| A. registry + RPC 契约 | huaanwork-host(subagent-runs, routes), client-huaanwork(rpc-types, api) | — |
| B. 执行链接线 | huaanwork-host(agent-invoke, agent-package), huaanwork-guardrails(skills, bridge) | A |
| C. 前端运行卡 | client-huaanwork(logic, SubagentRunCard, App, styles) | A |
| D. 真机组合验收(E-03..E-05) | 全部 | B + C |

Parallel lanes: A 先落地契约; 之后 Lane B 与 Lane C 并行(模块不相交); 汇合后 D。
Conflict flags: rpc-types/api 只在 A;App.tsx 只在 C;bridge/skills 只在 B —— 无跨 lane 共享文件。

## Implementation Tasks

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — huaanwork-host/subagent-runs.ts — 结算入口实现 D2 仲裁: result 优先, 冲突时 end 的 error 记 cleanupWarnings; result rejection 时由 end/启动错误定终态
  - Surfaced by: Scope Challenge SC-2(manager.ts:1177-1182 证实 end/result 可分歧)
  - Files: dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts(新增), dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts(新增)
  - Verify: §10 终态仲裁行两种到达顺序用例 + `corepack yarn test`
- [ ] **T2 (P1, human: ~2h / CC: ~15min)** — agent-invoke.ts — legacy 预留 childId + 保存 controller + provider 未沿用时按 activation.childId 重绑定归因
  - Surfaced by: Section 1 A-F4(agent-invoke.ts:256 匿名 signal; host.ts:938-945 为包路径先例)
  - Files: dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts, dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts
  - Verify: 预留/重绑定单测 + §10 legacy 取消行
- [x] **T3 (P3, 已于第二轮评审核实)** — 设计文档 §3.5 — agent_http 60 秒默认值与 150 秒硬上限已定位并回写证据(R2)
  - Surfaced by: Scope Challenge SC-1(数值未在 runtime.ts 定位)
  - Files: docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md
  - Verify: 数值与代码符号互相引用
- [ ] **T4 (P1, human: ~3h / CC: ~20min)** — SubagentRunCard / App.tsx — 实现三行活跃卡、终态单行、父子状态分工、共享秒针及断连/Host 重启失效视图（旧卡不被 generation snapshot 删除）
  - Surfaced by: Design Pass 1/2 — D3/D4/D5/D6/D7/D8
  - Files: dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx, dsh-plugin-huaanwork/src/client-huaanwork/App.tsx, dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts
  - Verify: §10 运行卡 UI 行 + A-01/A-06/A-12/A-13
- [ ] **T5 (P1, human: ~2h / CC: ~15min)** — 运行卡样式 — 落地容器、状态色、mono 数据字体、禁用琥珀、窄窗口与 reduced-motion
  - Surfaced by: Design Pass 5/6 — D13/D14/D15/D19/D22
  - Files: dsh-plugin-huaanwork/src/client-huaanwork/styles.css, dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts(由既有生成器产出)
  - Verify: 浅色/深色目检 + 280px 窄窗口 + reduced-motion；A-14/A-16
- [ ] **T6 (P1, human: ~2h / CC: ~15min)** — 运行卡交互 — 实现卡内二次确认、window 级 Esc 与焦点返回、独立 UI Map 展开状态、44×44 命中区与读屏播报
  - Surfaced by: Design Pass 2/6/7 — D17/D20/D21/D23/D26
  - Files: dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx, dsh-plugin-huaanwork/src/client-huaanwork/App.tsx
  - Verify: 确认前零 RPC、Esc 焦点返回、展开不被 snapshot 重置、键盘路径；A-15/A-16
- [ ] **T7 (P2, human: ~1.5h / CC: ~10min)** — 运行卡纯逻辑 — 实现终态文案映射、提醒优先级、基于 Host `stopRequestedAt` 的 60 秒停止提示、同名时间戳与并发工具摘要
  - Surfaced by: Design Pass 2/3/5/7 — D9/D10/D11/D12/D18/D24/D25
  - Files: dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts, dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts(按现有测试目录惯例落位)
  - Verify: 固定文案表、优先级、60 秒边界、同名/长名称/工具列表用例 + `corepack yarn test`
- [ ] **T8 (P2, human: ~1h / CC: ~10min)** — 设计验收 — 补齐运行卡 UI 自动化与真机视觉/键盘/读屏核对
  - Surfaced by: Design Required Outputs — A-12…A-16 的已批准行为需要可执行证据
  - Files: dsh-plugin-huaanwork/tests/client-huaanwork/(既有测试布局), docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md(验收记录)
  - Verify: `corepack yarn test` + E-05 真机记录；未执行平台明确标 Blocked，不冒充通过
- [ ] **T9 (P1, human: ~1.5h / CC: ~10min)** — Host 投影契约 — 增加首次受理 `stopRequestedAt`、`clientMessageId`、实际 `cleanupBudgetMs` 与结构化 `cleanupWarnings[{code,severity}]`，并让 WS/snapshot 使用同一形状
  - Surfaced by: 第二轮工程评审 F1/F3 — 60 秒提醒需要权威时间；banner 不能靠解析中文文案决定优先级与颜色
  - Files: dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts, dsh-plugin-huaanwork/src/huaanwork-host/routes.ts, dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts, dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts
  - Verify: 首次/重复取消时间不变、重连保持 60 秒语义、warning code/severity 契约与未知 code 回退用例 + `corepack yarn test`

### Suppressed findings(附录, 低置信 3-4/10)
- (conf 3) `startActivation()` resolve 与 `subagent/start` 发布的先后未核实;若 resolve 先于 start 发布,『starting』停留形态略异。§5.2 starting + A-02 + 静默提醒已兜底, 实施时以实测为准。

## 第二轮工程评审记录（2026-10-26，设计评审后复核）

目标：只复核设计评审新增的 24 项 UI/交互决策及其工程影响；第一轮 D1 文件编排、D2 终态仲裁、D3 严格停止语义保持不变。

### Scope Challenge

- scope accepted as-is；未提出功能砍除。复杂度仍约 16 个既有/新增文件、3 个新模块、2 个 RPC，无新增文件或服务；结构门由第一轮 D1 的「保持原编排」精确覆盖。
- 用户已授权后续待确认项采用推荐项；本轮只在已批准行为下补必要契约与实现约束，不重开产品/视觉决策。

REALITY: premise-table pass — unverified=0；stopRequestedAt 缺口见 docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:151,211-216,318；generation 冲突见 docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:262,314；共享 tick 见 dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:426,1420；window Esc 见 dsh-plugin-huaanwork/src/client-huaanwork/MarketSourcePanel.tsx:141-148；agent_http 见 dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:33-36,295
REALITY: already-done pass — 本轮开始前仅有设计文档变更，无该功能实现；origin/master 核对基线 692f12f507
REALITY: surface-check pass — 未新增 CLI 或 RPC 名称；styles 生成器存在 dsh-plugin-huaanwork/scripts/gen-huaanwork-styles.ts:1,9,17；client 测试目录存在 dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts:1
REALITY: binding-decisions pass — 遵循第一轮 D2/D3 与 24 项设计裁定（docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:185-186,294-318）；strict stopped 与卡内二次确认未被改写
REALITY: numbers pass — 60s 为已批准 UI 阈值 [approved: docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:318]；44px [approved: docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:300]；280px [approved: docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:304]；共享 tick=1000ms [measured: dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:1420]；agent_http 60s/150s [measured: dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:33-36]
REALITY: deferred-asks pass — 用户要求本轮重跑 eng，视觉 QA 明确留到实现后；无链接 issue，无其他被省略请求
REALITY: pr-count pass — 无 .gstack/ship-policy.json，默认单 PR；本轮未提议拆分（基线 692f12f507）

### Architecture — 3 findings

- **[CRITICAL] (confidence: 9/10) 本文:151,211-216,318 — F1：60 秒停止提醒缺少权威受理时间。** 仅用客户端收到 WS 的时间会在重连后重置或漂移。处置：按用户推荐授权，Host 在首次定向受理写入 `stopRequestedAt`，重复取消不改写，WS/snapshot 同形携带；T9 + registry/snapshot 测试已补。
- **[CRITICAL] (confidence: 9/10) 本文:262,314 — F2：generation「替换」与失效卡保留冲突。** 若直接删除旧临时状态，D6 的失效视图无法存在。处置：snapshot 只替换活跃/可取消状态；旧非终态卡转为独立客户端失效视图，不再参与活跃对账；T4 + snapshot 测试已补。
- **[INFORMATIONAL] (confidence: 8/10) 本文:211-216,309,335 — F3：cleanupWarnings 形状不足。** UI 若解析中文文案决定优先级/颜色会脆弱且耦合。处置：采用 `{code,severity}`，UI 按 code 映射文案，未知 code 用通用提醒并保留 severity；不传输堆栈；T9 + 契约测试已补。

### Code Quality — 2 findings

- **[INFORMATIONAL] (confidence: 9/10) 本文:306；MarketSourcePanel.tsx:141-148 — F4：Esc 不能重蹈元素级焦点依赖。** 处置：确认区存活期间使用 window 级 keydown，卸载移除；确认前 run 已终态则关闭确认区且零 RPC；A-15 与 T6 已补。
- **[INFORMATIONAL] (confidence: 8/10) 本文:303 — F5：展开偏好不能存进会被 snapshot 替换的 run 对象。** 处置：当前 tab 内按 runId 建独立 UI Map，与同代对账分离；T6 与 snapshot 测试已补。
- 事实性澄清（不计新 issue）：D4 的「活跃」定义为 Host 非终态（含 stopping）；D23 的 44×44 命中区明确只针对运行卡内控件。

### Performance — 1 finding

- **[INFORMATIONAL] (confidence: 8/10) 本文:245；App.tsx:426,1420 — F6：每卡独立 interval 是不必要的计时器 fan-out。** 处置：复用客户端共享 1 秒 tick，每个 run 独立计算耗时，仍不依赖父 turnActive；断连冻结、对账恢复；不为每卡创建 interval。

### Test — 1 gap（已补）

- **[INFORMATIONAL] (confidence: 9/10) §10 registry/snapshot/运行卡 UI 行 — F7：新增交互需要对应的重连与竞态证据。** 已补：stopRequestedAt 首次/重复/重连、generation 后失效卡保留、展开 UI Map 不重置、确认前终态零 RPC、结构化 warning 未知 code 回退。共享 tick 与 window Esc 纳入 T4/T6 验证；A-14/A-15 同步更新。无新增测试框架。

### 新增数据流图

```text
Host cancel 首次受理 ──► stopRequestedAt ──► WS / snapshot ──► 60 秒 UI 提醒
                                  重复受理不改写        重连不重置

同代 snapshot ──► run 状态对账；独立 UI Map 保留展开偏好
新 generation ──► 替换活跃/可取消状态
                 └─► 旧非终态卡 → 客户端失效视图（冻结、不可取消、可回看）
```

### Approval readiness / dispositions

PASS。F1/F3 的推荐机制由用户持续推荐授权覆盖；F2/F4/F5/F6 是已批准 D6/D17/D26 与计时行为的必要实现；F7 是这些行为的必要回归证据。全部已写回计划，0 未决，0 critical failure-mode gaps。

### 第二轮 Completion summary

- Step 0: scope accepted as-is；Reality rows 7/7，unverified premises = 0。
- Architecture: 3 issues；Code Quality: 2 issues；Test: 1 gap（已补矩阵）；Performance: 1 issue。
- NOT in scope / What already exists: 沿用第一轮清单，并新增复用 `App.tsx:1420` 共享秒针与 `MarketSourcePanel.tsx:141-148` window Esc 先例。
- TODOS.md updates: 0；Failure modes: 0 critical gaps；Unresolved decisions: 0。
- Outside voice: codex unavailable（CLI 未安装）；原生 fallback 5 分钟未产出完整报告，缺失覆盖不计通过。
- Parallelization: 沿用 A(registry/RPC) → B(执行链) + C(前端) → D(真机验收)；T9 属 A，T4/T6/T7 属 C。

## Design Review Completion Summary

```text
+====================================================================+
|         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| System Audit         | DESIGN.md found (HuaAnWork sibling repo);   |
|                      | UI scope = chat subagent run card            |
| Step 0               | initial impression 5/10; all 7 passes       |
| Pass 1  (Info Arch)  | 4/10 → 9/10 after fixes                     |
| Pass 2  (States)     | 5/10 → 9/10 after fixes                     |
| Pass 3  (Journey)    | 6/10 → 9/10 after fixes                     |
| Pass 4  (AI Slop)    | 8/10 → 8/10 (no findings)                   |
| Pass 5  (Design Sys) | 4/10 → 9/10 after fixes                     |
| Pass 6  (Responsive) | 5/10 → 9/10 after fixes                     |
| Pass 7  (Decisions)  | 3 resolved, 0 deferred                      |
+--------------------------------------------------------------------+
| NOT in scope         | written (5 items)                            |
| What already exists  | written                                     |
| TODOS.md updates     | 0 items proposed                            |
| Approved Mockups     | 0 generated, 0 approved                     |
| Decisions made       | 24 added to plan                            |
| Decisions deferred   | 0                                           |
| Overall design score | 4/10 → 8/10 (lowest rated pass)             |
+====================================================================+
```

### NOT in scope（设计评审）
- 可视化 mockup 生成与审批：designer 首次生成即因缺少 OpenAI API key 失败；本轮为文本与既有组件证据评审，未伪造图像证据。
- 手机页面：本需求只覆盖 macOS/Windows 桌面会话列与窄窗口，不新增移动端信息架构（D19）。
- 手动/自动重试与额外强制 kill：保持工程非目标；D12 只增加停止等待说明。
- 嵌套子代理树、续聊/恢复、完整 transcript 与统一子代理面板：沿用 §11 非目标。
- 上游 ui-subagent 整套组件或新视觉体系：复用 HuaAnWork 既有组件与 token，不另建设计系统。

### What already exists（设计复用）
- `HuaAnWork/DESIGN.md`：纸面工作台、字阶、mono 数据字体、琥珀审批语义、工具 pill 脉冲与 Banner 三色体系。
- `AgentConfirmCard.tsx:25-38`：消息流内 `.card` / `.ttl` / `banner` / `hint` 的组件先例。
- `styles.css:3-47`：完整浅色/深色 token；运行卡不新增裸 hex。
- composer 会话级停止与工具 pill：用于区分定向终止样式及复用活跃脉冲，不复制其会话级语义。
- M26 市场 UI 评审：mono 数字、字阶、focus ring、防连点与诚实文案的复发缺陷清单，已由 A-12…A-16 预防。
- `logic/turnStatus.ts` 与 `App.tsx:565-569`：父回合状态行现状，D4 只在有活跃运行卡时调整其展示分工。

### Unresolved Decisions
无。D21 由用户明确选择 19A；D22-D26 由用户授权按推荐项确认。Mockup 未生成是环境阻塞，不是待定的产品/设计决策。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex plan/design voices + native fallback | Independent 2nd opinion | 3 | unavailable | codex CLI 未安装；两次 eng 原生 fallback 均超时；design 原生声音完成并发现视觉缺口（已闭环） |
| Eng Review | `/plan-eng-review`（含设计后重跑） | Architecture & tests (required) | 2 | issues_open | 第二轮 7 issues, 0 critical gaps；全部已写回计划，0 未决 |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 4/10 → 8/10, 24 decisions, 0 unresolved |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex 在两次 plan-review 与一次 design 阶段均 unavailable（CLI 未安装）。两次 eng 原生 Plan 子代理均在 5 分钟内未产出完整报告；design 原生 Claude 子代理已完成。原生结果不构成外部覆盖。
- **VERDICT:** Design Review CLEAR；第二轮 Eng Review 为 issues_open（7 条发现均已闭环并写入 §5/§6.1/§10 与 T4/T6/T7/T9），按日志规则仍保留 eng review required；实施证据产生后再重跑。

NO UNRESOLVED DECISIONS

## 实施验收记录（2026-10-27，自动化门禁）

本节只记录 2026-10-27 实际执行的自动化门禁与未执行项；**不勾选 §10.1 复选框**，不改变已批准行为，也不改写既有评审记录。

| 门禁 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 定向测试 | `corepack yarn workspace dsh-plugin-huaanwork test`（brief Step 1 的 10 个目标） | 0 | 52 文件 / 737 用例全部 PASS |
| 类型检查 | `corepack yarn typecheck` | 0 | PASS（11 个 workspace） |
| 单元测试 | `corepack yarn test` | 0 | PASS（vitest 8493 passed / 37 skipped；node:test 166 passed / 2 skipped） |
| 变体守卫 | `corepack yarn check:desktop-variants` | 0 | PASS（11/11；allowlist 7/0、65/6 未变） |
| headless 全量 | `corepack yarn check` | 0 | PASS（含 desktop/beta/huaanwork 的 `verify:aa`，无并发 flake） |

**Blocked（真机未执行，等待用户明确同意图形启动）**：真实 legacy `@agent` 与 package `@slug` 的启动→工具→完成、启动中/运行中定向终止、父 idle 后子代理仍运行、多 tab/同名并发/断连重连/Host 重启、清理未确认与 60 秒提醒、A-08 真机短预算子项（无受控注入通道）、键盘/焦点/44×44/读屏/280px/reduced-motion/浅色深色、`/design-review` 视觉 QA；Windows 未验证。

自动化通过不等于功能验收完成：A/B/C/D 中依赖真机的条目与 E-03～E-05 仍未执行。完整命令、计数、逐条需求矩阵与日志指针见 `docs/evidence/2026-10-26-subagent-run-visibility-verification.md`。

### 真机验收补充（2026-10-27）

同日在隔离环境中（临时 `DSH_HOME` 与 `--user-data-dir` 副本 `/tmp/huaanwork-accept-20261027-142256`，用户真实 profile 未改）用 Electron 44.0.0 + `deepseek-flash` 跑了一次真实应用验收，被测对象是未提交工作树，外层 HEAD `692f12f507`、Harness pin `1600d8a1e1`。事实来源与逐条 A–E 判定见 `docs/evidence/2026-10-26-subagent-run-visibility-verification.md`〈真机验收（2026-10-27，Electron 44 + deepseek-flash）〉。

- **package 路径 PASS 的子项**：卡锚定（每条显式 `@` 一张卡、紧贴该用户消息）、启动即显「启动中」、真实工具名（`正在执行工具 · bash`）、`已完成`/`已停止` 终态、终态单行、父流无子内容、卡内确认 + 初始焦点「取消」+ Escape 归还焦点 + 44 px 命中高、同名卡带 `HH:MM:SS`、深色主题、380 px 无横向滚动、`prefers-reduced-motion` 下无脉冲。定向取消在「启动中」与「正在执行工具」两处均收敛为「已停止」，父会话随后仍可用；父级停止也正确反映为「已停止」（`aborted` → `stopped`）。
- **Blocked / 未验证**：legacy `@agent` 全链路（legacy 目录 host `10.130.209.76:18080` 超时、本地无 `kind: agent` 条目）、父 idle 后子代理继续运行（A-06/A-07 真机子项）、A-08 真实短预算（无注入通道）、WS 断连重连与 Host 重启失效视图（C-05…C-09）、停止过程/幂等/竞态/清理失败/取消边界（B-05…B-08、B-10）、多 tab 与同名并发（A-10、C-01）、真实读屏播报（A-11/A-16）、60 秒提醒与预算横幅/failed 终态文案（A-14）、`finalizing` 与并发工具的目视（A-03/A-04）、Windows 未验证。
- **真机缺陷与修复**：活跃圆点在 `prefers-reduced-motion: reduce` 下仍脉冲（`animationName` 仍为 `tool-pulse`）。根因是级联权重——reduce 块的复位选择器 `.subagent-run-card .subagent-run-dot` `(0,2,0)` 低于相位规则 `(0,3,0)`。已改为 `.subagent-run-card[data-phase] .subagent-run-dot { animation: none; }`（`styles.css:3745`，同权重且源序在后），重新生成 `styles.generated.ts`，并在 `tests/client-huaanwork/SubagentRunCard.spec.ts:643` 加契约钉（改回旧选择器即红）。活应用中复验 `reduce: true` → `animation-name: none`。该修复使最终树定向用例 +1（741 → 742）。
- **最终树门禁复跑（CSS 修复后，严格串行）**：定向 52 文件 / **742** 用例 PASS；`typecheck` PASS；`yarn test` vitest **8498** / 37 skipped、node:test 166 / 2 skipped；变体守卫 11/11（allowlist 7/0、65/6 未变）；`yarn check` 第 1 次因 `update-server` 的 `hdiutil create` 环境失败在 87/88 中断（此后 4 个 workspace 未跑），整条重跑 15 步全绿（huaanwork **3508** / 14 skipped），两份日志都保留。
- **结论不变**：按设计 §10.1 的验收通过判定，功能**仍未完全验收**——E-03/E-04 只覆盖 package 路径、E-05 整条 Blocked、legacy 与 Windows 无真机证据。本节不勾选 §10.1 复选框。

### E-05 真实组合补充（2026-10-27）

在隔离的临时 profile 副本（`/tmp/huaanwork-accept-20261027-142256`，用户真实 profile 未改）中补跑 E-05 真实组合；legacy 通道通过本地夹具目录（`127.0.0.1:18080`，一条 spec-valid `kind: "agent"` 条目 `legacy-demo`）打通，真实内网目录 `10.130.209.76:18080` 仍不可达。

- **legacy PASS（夹具）**：真实 spawn 的完成链路（`启动中 → 思考中 → 正在执行工具 · bash → 生成中 → 已完成`）与启动中/工具相位两处定向取消均被观察，父流无子内容。
- **多标签 PASS + 缺陷/修复**：标签间切换各自保留运行卡、无跨标签泄漏；期间发现「点开已开标签时用历史覆盖活 `items`、运行卡归零」，修复为已有标签只激活、历史标签与自动化回填后调用 `reconcileSubagentRuns(tabId, sessionId)`，修复后切换与 renderer reload 恢复均复验（legacy 活会话 reload 后无法经 UI 重开属既有 resume 行为，记为 Blocked）。
- **同名并发 + 兄弟隔离 PASS**：父 idle 时同一标签两条同名 legacy 卡各自独立计时/活动/工具，取消其一不影响另一。
- **父 idle PASS**：composer 回到「发送」后子运行卡继续更新（耗时、最近活动），终止入口可用；5 分钟无活动提醒未观察。
- **WS 冻结/重连 PASS**：断连期间冻结标记 + 终止禁用 + 耗时冻结，约 1 s 自动重连后由快照对账恢复；应用级 `sidecarDead`/「会话已失败」闩锁是既有相邻行为，不是运行卡。
- **仍 Blocked**：Host 重启后的失效视图、清理未确认横幅、60 秒提醒与预算/失败文案；Windows 未验证。门禁复跑中 `corepack yarn check` 因提交 `6c1f139e44` 带入的结尾空行在 `check:whitespace` 红，其余步骤隔离复跑全绿。

本条只记录真机事实与判定，不勾选 §10.1 复选框，也不改动已批准行为；逐条判定与日志指针见 `docs/evidence/2026-10-26-subagent-run-visibility-verification.md`〈E-05 真实组合补充（2026-10-27）〉。
