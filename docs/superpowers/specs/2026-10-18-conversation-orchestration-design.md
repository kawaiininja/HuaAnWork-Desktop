# HuaAnWork 对话编排、中文执行说明与长任务恢复规格

- 日期：2026-10-18
- 状态：已被 [2026-10-19-conversation-capabilities-design.md](2026-10-19-conversation-capabilities-design.md) 取代。本文的全量编排账本、动作指纹和 45 条验收不再作为实施依据。
- 范围：HuaAnWork 桌面高级模式的交互式对话；复用现有 DSH 模型、工具与权限链路。
- 调研基线：主仓 `3f2557dd82`，内核子模组 `1600d8a1e1`，HuaAnWork 声明运行时 `0.2.1-rc.1`；同时参考当前工作树。
- 工作区说明：模型适配器、其测试和依赖清单已有未提交修改；本文不覆盖这些修改，也不把它们视为已发布能力。
- 本次交付：规格文档，不包含实现、依赖变更、护栏放宽、提交或发布。

## 1. 目标与完成定义

### 1.1 用户要求

| 编号 | 要求 | 产品行为 |
| --- | --- | --- |
| R1 | 先理解意图，简单请求直接执行，复杂请求拆解、计划、执行并返回最终结果 | 自动分流；复杂请求有版本化计划、逐项执行记录和验收证据；简单请求不强迫用户查看计划 |
| R2 | 用中文直观展示执行过程 | 展示需求理解、计划、当前动作、工具结果摘要、验证结论；不是暴露、翻译或伪造内部 chain of thought |
| R3 | 长任务不因连接超时而丢失，卡住后有明确处置 | 请求与执行解耦；持久化任务；分层超时、进程外监督、取消、事件补读和安全恢复 |

“正确完整”指：原始要求有覆盖关系，要求的产物可访问，约定验收项全部有有效证据，且没有未解决的副作用或仍在运行的子任务；不是宣称任意模型输出都能被程序证明为正确。开放式写作等没有客观判定器的任务必须说明验证范围，必要时等待用户验收。

### 1.2 一次交付的范围

本规格同时覆盖意图分流、计划协议、执行约束、结果验证、中文 UI、持久化、超时取消、恢复与测试，不把恢复或验收作为后续补丁。现有自动化仅接入共享执行互斥与生命周期约束，不更改其 cron、catchup、错过策略和运行历史语义。

不在范围内：云端持续执行、关机后继续计算、多机调度、跨工作区并发写入、新建多智能体框架、市场与发行的无关债务、自动撤销任意外部副作用、展示原始推理链。桌面退出或系统休眠期间不能保证执行；重新打开后恢复检查点，不承诺恢复进程内栈。

## 2. 已核实的现状与设计限制

下列行号是调研时定位，后续以符号名为准；源码存在不等于已完成真实运行验证。

| 现状 | 证据 | 对设计的约束 |
| --- | --- | --- |
| `sendToAgent` 调用 `followup` 后等待 `whenIdle` 才返回 `queued` | [sessions.ts:92–170](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L92) | 新提交接口必须在持久化受理后返回，不能继续等待整次任务 |
| 前端普通 RPC 为 180 秒，send/resume 为 30 分钟 | [api.ts:6–9、148–180](../../../dsh-plugin-huaanwork/src/client-huaanwork/api.ts#L6) | 调大请求超时不等于执行可靠性；连接超时不得直接标任务失败 |
| WS 有退避重连，但服务端只广播即时事件和 ready，没有任务事件补读 | [api.ts:183–205](../../../dsh-plugin-huaanwork/src/client-huaanwork/api.ts#L183)、[events.ts:19–38](../../../dsh-plugin-huaanwork/src/huaanwork-host/events.ts#L19) | 需要持久事件序号、快照和补读协议 |
| bridge 将 idle 发为 `session/end: ok=true`；`tool/end` 未包含最终成功判定 | [bridge.ts:58–105](../../../dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts#L58) | 两者不能作为业务步骤或任务成功证据 |
| 上游 `whenIdle` 等待活动结束，driver 可捕获异常后回到 idle | [agent.ts:237–264](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L237) | 需消费结构化回合原因、最终工具结果及验收，不用 Promise resolve 代替成功 |
| 当前工作树模型适配器有 600 秒请求期限，并单独产出 reasoning chunks；UI 会过滤 think 标签 | [model.ts:30–31、159–173](../../../dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L30)、[App.tsx:2582–2597](../../../dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2582) | 中文说明另建面向用户的事件；不改变供应商所需的 reasoning 协议，也不直接转发 reasoning |
| 自动化有取消与最长额外 120 秒 drain；重启残留只补 cancelled | [automations-host.ts:249–311](../../../dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L249)、[automation-scheduler.ts:76–94](../../../dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts#L76) | 可借鉴机制，但不能宣称已有通用断点续跑 |
| 会话取消会遍历取消其他 agent；无人值守授权使用共享 holder | [sessions.ts:216–224](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L216)、[policy.ts:112–119](../../../dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts#L112) | 新 run 取消必须精确归属；交互任务不得继承自动化授权或绕过互斥 |
| native 工具呈现与白名单在位；jobs、PTC workflow、ralph、user-questions 等被禁用 | [present-as.ts:10–32、93–105](../../../dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts#L10)、[profile.ts:1516–1559](../../../dsh-plugin-huaanwork/src/profile.ts#L1516) | 不借此功能启用被禁能力；`todo_write` 不是持久执行引擎；澄清走产品自有输入 |
| 默认使用独立 Host，也有 `DSH_DESKTOP_ISOLATED_HOST=0` 同进程分支 | [main.ts:1652–1715](../../../dsh-plugin-huaanwork/src/main.ts#L1652)、[host-process.ts:46–108](../../../dsh-plugin-huaanwork/src/host-process.ts#L46) | 真正的 Host 卡死检测必须由 Electron 主进程监督，且不能在同进程模式宣称同样保证 |
| 上游提供 pre-step 和工具 pre/guard/execute/result 扩展点 | [agent.ts:267–287](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L267)、[tools/index.ts:1363–1378](../../../deepseek-harness/packages/core/tools/src/index.ts#L1363) | 优先通过插件约束现有循环；必须再用实际安装/打包的 rc.1 验证，不修改子模组来迁就方案 |
| 上游沙箱有按会话切换的模式覆盖：`setSandboxMode` 向会话追加 `sandbox/mode` 事件，模式为 `read-only` / `workspace-write` / `danger-full-access`，由内核级 provider（Seatbelt/Landlock/bwrap/Windows ACL）执行；HuaAnWork 部署默认 `workspace-write`。**上游没有“只读命令”分类器**，`ToolDefinition` 元数据只有 `isConcurrencySafe` 与 `timeoutMs` | [session-mode.ts:42–55](../../../deepseek-harness/packages/sandbox/sandbox-policy/src/session-mode.ts#L42)、[cordis.patch.yml:240–247](../../../deepseek-harness/packages/bundle/base/cordis.patch.yml#L240)、[profile.ts:1543](../../../dsh-plugin-huaanwork/src/profile.ts#L1543) | 只读步骤可在派发前把执行会话切到 `read-only` 并拒绝提权，让“只读”成为内核执行的事实而非命令文本分类；该事件只写入执行会话，不改部署默认，不改 `row-assertions` 钉住的 `workspace-write` |
| shell 工具允许模型按调用传 `timeoutMs`，执行器用配置行的 `timeoutMs`/`maxTimeoutMs` 夹取：bash 由基座 `bash-sandbox` 行设为 60 秒、pwsh 默认 120 秒，`maxTimeoutMs` 两者默认 600 秒；HuaAnWork 已关 `enableRunInBackground`，到期即终止而非升格后台；子进程终止走进程组信号与 Windows `taskkill /T /F` | [tool-bash/index.ts:206、380](../../../deepseek-harness/packages/shell/tool-bash/src/index.ts#L206)、[bash-local/index.ts:102–103](../../../deepseek-harness/packages/shell/bash-local/src/index.ts#L102)、[pwsh-local/index.ts:128–129](../../../deepseek-harness/packages/shell/pwsh-local/src/index.ts#L128)、[cordis.patch.yml:249–253](../../../deepseek-harness/packages/bundle/base/cordis.patch.yml#L249)、[spawn.ts:102、115–120](../../../deepseek-harness/packages/subprocess/subprocess-local/src/spawn.ts#L102)、[profile.ts:1528–1530](../../../dsh-plugin-huaanwork/src/profile.ts#L1528) | 单步/长操作期限用现有执行器配置行与模型侧 `timeoutMs` 表达，不另造一层超时；§8.3 的进程树终止复用上游并在 rc.1 真机核实，不另写 kill 逻辑；Windows 走 `desktop-windows-pwsh-sandbox`，其 Config 继承 `pwsh-local`，同一配置键有效 |
| 现有护栏档位 `guard_mode`（`ask` / `smart` / `full`）与 shell 分类（硬拒绝 / 元字符 / 高危清单 / 普通）已是用户可见的风险开关：`smart` 放行普通命令与 `git_commit`，对高危 shell、`git_push`、脏树 `git_checkout`、附加的 host/MCP 工具询问；`full` 除硬拒绝外全部放行 | [policy.ts:61–69、72](../../../dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts#L61)、[decide.ts:14、76–116、168–196](../../../packages/huaanwork-policy/src/decide.ts#L14)、[shell.ts:1、37](../../../packages/huaanwork-policy/src/shell.ts#L1) | 计划“低风险”判定复用这一档位与分类，不新造第二套风险标签；计划级确认只覆盖工具级审批覆盖不到的目标/收件人/预算变更 |
| 当前多标签可并行执行：`sendToAgent` 不检查其他 live agent，`assertSessionSendable` 只阻塞工作区位移与自动化运行 | [sessions.ts:87–90、92](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L87) | §5.3 的“profile 内单一执行 run”是对现状的收紧，须登记为行为变更并给第二标签可见的 `run-busy`/排队反馈 |
| `host-process.ts` 没有心跳或主动探活；子进程退出只触发 `onFailure`，不自动重启；HostRpc 期限 120 秒 | [host-process.ts:59–99](../../../dsh-plugin-huaanwork/src/host-process.ts#L59)、[host-rpc.ts:16](../../../dsh-plugin-huaanwork/src/host-rpc.ts#L16) | §8.2 的监督是全新接线，不是对既有 watchdog 的参数调整；同进程分支 `=0` 在文档中是 A/B 对照与开发期未验证模式，拒绝它的爆炸半径接近零 |

## 3. 方案选择与总体结构

| 方案 | 优点 | 不采纳原因或代价 |
| --- | --- | --- |
| 只改系统提示词，加 `todo_write` 和更长超时 | 改动小 | 计划没有可靠提交点、任务成功不受程序约束，无法解决掉线或卡死 |
| **HuaAnWork 本地编排层＋现有 DSH 执行链** | 保留工具、模型、沙箱与许可；增加明确执行账本和恢复协议 | 本规格选定；需要产品级状态、事件与宿主监督接线 |
| 引入独立云工作流或新的多智能体框架 | 可跨机器执行 | 与内网、本地文件及现有 DSH 组合边界不符；增加并非当前要求的基础设施 |

```text
对话 UI ──提交/查询/输入/取消──> HuaAnWork Run Coordinator
   ↑                             ├─ 意图判定 / 计划生成（无副作用）
   └────快照＋持久事件─────────────┤
                                 ├─ Run Store（状态、计划、动作、证据）
                                 ├─ Step Runner → DSH agent → 原工具/权限/沙箱
                                 └─ Verifier → 结果摘要 / 明确未完成项

Electron 主进程 ──心跳/期限/生命周期──> 独立 Host
```

职责边界：模型提出意图、计划、工具调用和解释；Coordinator 决定状态转换、预算和派发；原 policy 决定权限；Verifier 核对证据；主进程负责 Host 存活与终止确认。模型不直接写 run 状态，不持有审批凭证，不决定自己的成功。

持久数据写入与调度只有一个 profile 级 Host owner。不在 renderer 保管运行真相，不新增无归属的全局 `currentRun`。Cordis effect 卸载须先停止接单、停止派发、收敛执行，再释放监听与资源。

## 4. 意图路由与计划生成

### 4.1 路由协议

每个用户请求先得到结构化 `IntentDecision`：`mode`、中文 `summary`、`requirements`、`missingInputs`、`needsConfirmation`；`mode` 为 `answer | direct | planned | clarify`。输出通过 schema 校验，风险最终由宿主工具策略判断，不接受模型自报“安全”。

| mode | 条件 | 行为 |
| --- | --- | --- |
| answer | 无须操作环境即可回答 | 直接给答案，不展示计划卡；禁止执行工具 |
| direct | 目标、参数明确，单一有界操作或短只读查询 | 立即执行，保留简洁工具状态；内部仍有 run 和验收记录 |
| planned | 多个依赖步骤、多份产物、探索后决策、长时执行或显式要求制定计划 | 先持久化并展示计划，再执行 |
| clarify | 缺失影响正确性或权限的输入 | 提一个可回答的问题，等待用户，不猜测目标目录、收件人或授权 |

不能用 prompt 长度或预估秒数单独判断复杂度。简单请求也可能需要审批，例如删除文件；复杂只读请求不必逐步审批。显式 `@工具`、`@agent`、`/skill` 保留路由优先级，不被分类器替换为无关探索。

分类与直接答案/首个动作建议可以共用一次受约束生成，避免所有简单请求额外串行两轮模型调用；分类阶段不派发工具。格式错误只允许一次格式修复，仍失败则明确报 `intent-invalid`，不退回无限制工具循环。直接执行发现额外依赖时可升级 planned：记录已发生动作，展示剩余计划，不能从头重放。

实现可用原生函数调用承载分流，与 schema 化 `IntentDecision` 等价、择一实现：分类回合只暴露两个无副作用的控制工具 `propose_plan`（= planned，参数即 §4.2 的 Plan）与 `request_input`（= clarify，参数即待答问题），模型输出纯文本即 answer，调用普通工具即 direct——该调用在 `tools/pre-execute` 处先登记为 direct run 的首个动作并写持久记录，再按原 policy 派发，分类回合本身仍不派发工具。这样 answer 不必被包进结构化外壳、direct 的首个动作不必先翻译再派发；控制工具由 Coordinator 消费，不进入工具账本，也不受 `guard_mode` 影响。

### 4.2 计划数据

`Plan` 包含 `version`、`objective`、`requirements[]`、`steps[]`、`acceptance[]`、`budget`。每个 requirement 有稳定 ID，并映射到至少一个 step 和验收项。

每个 `Step` 包含：稳定 `stepId`、中文标题、目标、依赖 ID、输入引用、允许的工具能力、预期产物、验收项、deadline、重试上限、状态、attempt 和证据引用。只读/写入/外部副作用以及重放策略由宿主能力描述确定，不能相信模型分类。

计划提交前验证：ID 唯一、依赖存在且无环、所有需求被覆盖、工具实际可用、路径在许可范围、预算有限、每一步有验收条件。任一失败不得进入执行。默认按依赖拓扑顺序串行执行；依赖图用于正确排序，不自动承诺并行提速。

计划展示后是否自动执行，由用户已经选定的护栏档位 `guard_mode` 与现有 shell 分类决定，不新造一套“低风险”标签，也不接受模型自评：

| `guard_mode` | 计划卡行为 |
| --- | --- |
| `ask` | 所有 planned 计划先等待确认；确认后每个 would-be-ask 工具调用仍逐次审批 |
| `smart` | 默认展示后自动执行；若任一步骤声明的能力落在 `smart` 档的 would-be-ask 集合（高危 shell 清单、`git_push`、脏树 `git_checkout`、附加的 host/MCP 工具）或涉及外发/删除，则先等待计划确认 |
| `full` | 展示后自动执行；计划级确认只保留给目标、收件人、写入范围、预算这类工具级审批覆盖不到的变更 |

判定输入是步骤声明的工具能力与参数范围（Step 的“允许的工具能力”字段），用现有 policy 的同一判定函数对声明能力做干跑（不派发）；步骤执行时模型若调用了未声明的能力，按 §6.1 拒绝或触发计划变更，不能借“计划已确认”放行。确认计划不等于批准全部工具调用，不能覆盖 deny 或一次性审批。

计划变更产生新版本，记录变更原因、需求覆盖差异及证据失效集合；已验证且输入未改变的步骤可复用，受影响的后继必须重验。删掉困难步骤或偷偷降低验收标准不能让任务变绿。新增目标、收件人、写入范围或提高预算须再确认；默认最多两次自动重规划，随后等待用户。

## 5. 执行对象、上下文与状态机

### 5.1 身份与对象

`Run` 至少包含：`schemaVersion`、`runId`、`clientRequestId`、`profileId`、`conversationSessionId`、`projectId`、冻结的规范化 `workspaceRoot`、输入及其摘要哈希、mode、planVersion、revision、lastSeq、state、stage、budget/usage、ownerEpoch、关联执行会话、timestamps、result/error。

`runId` 是本次请求的执行 ID，不复用现有项目 `taskId` 或 `automationId`。所有新持久事件带 `runId/seq/revision/ownerEpoch`；执行事件另带 `stepId/attempt/executionSessionId/callId/actionId`。派生 agent 必须登记父 run、实际 session 与取消链，禁止用 `agents.list()[0]`、当前标签或默认会话回落猜归属。

用户对话会话继续表示完整对话。控制生成与步骤执行可使用关联的内部执行会话，但必须满足：

- 接受的新用户输入只记录一次；控制提示、计划及恢复摘要不伪装成用户新要求。
- 模型上下文来源为既有对话、已接受输入、当前计划和核实过的动作/产物；每次模型可见输入可由会话记录及 run 记录重建。
- `session.open` 与前端历史合并 run 投影，并以稳定消息 ID 去重；下一轮模型也能读到上一轮结果，不能出现“UI 有结果，模型不知道”。
- 内部执行会话不额外变成用户侧栏的游离任务；会话清扫与删除必须识别活跃及待恢复 run 的引用，不能删掉恢复证据。
- 不自动 resume 带未决工具调用的执行会话；先对账，必要时用已核实上下文创建新的执行会话，禁止因上游恢复回合而重发未知写入。

### 5.2 Run 状态

| 状态 | 意义与允许出口 |
| --- | --- |
| queued | 已持久化受理，尚未占用执行槽；可进入 running、cancelled、failed |
| running | stage 为 classifying/planning/executing；可转 verifying、waiting_input、paused、cancelling、interrupted、failed |
| verifying | 核对步骤或最终产物；可回 running 做有预算的补救，或进入 succeeded、waiting_input、cancelling、interrupted、failed |
| waiting_input | 等待澄清、计划确认、操作审批、预算续期或副作用对账；有 reason 和 resumeTarget；不持续消耗模型 |
| paused | 用户请求的安全边界暂停；没有在飞动作；可恢复或取消 |
| cancelling | 已记录取消意图，禁止新动作，正在确认在飞动作停止；转 cancelled 或 interrupted |
| interrupted | Host/应用退出、失联或停止未确认；先核对 owner 和动作结果，再进入 queued/waiting_input，或取消 |
| succeeded / failed / cancelled | 终态，不再直接变回 running；重新尝试创建有前驱引用的新 run，复用证据必须重新校验 |

`pauseRequested` 是请求标记，只有执行到安全边界才转 paused；暂停不声称回滚。`waiting_input` 保存等待前的目标阶段及租约状态：仍持租约的在飞审批，裁决落盘后唤醒原调用；已经释放租约的澄清、预算等等待，答案落盘后进入 queued，重新取得租约并核对工作区、权限、预算后才进入 resumeTarget。过期审批必须重新申请，不能沿用旧许可。queued 的取消直接终止，其他活动态先进入 cancelling；已经没有在飞动作的 waiting_input/paused/interrupted 可直接 cancelled。

执行中的失败先记录 failureRequested，冻结新派发并有界 drain 本地工具与后代；只有确认收敛且所有已派发动作均有结果或已登记 unknown 隔离记录，才能提交 failed。无法确认停止则 interrupted，保留租约或资源隔离，不能因执行 Promise settle 就释放。失败报告与取消一样列出已发生及未知效果。

Step 状态为 `pending/running/verifying/succeeded/failed/blocked/cancelled`；因依赖失败而 blocked 不算成功。取消或故障时，未启动步骤不得仍显示 running。Run 成功只能由 Verifier 提交：所有当前版本必需步骤成功、验收有效、无未决动作和子任务、最终结果已持久化。

### 5.3 调度与既有自动化

默认 profile 内只有一个可能执行工具的交互 run；同一会话只允许一个未结束请求，重复请求返回原 run，不同请求冲突返回 `run-busy`。其他会话可以浏览历史与提交排队请求；计划内默认串行，不增加共享 holder 下的并行 agent 执行。

执行租约的键是 `(profileId, 规范化 workspaceRoot)`；由于活跃租约下拒绝切换工作区（下文），同一时刻 profile 内仍最多一个执行 run，键带工作区根是为了恢复准入与资源隔离记录按根归属，不是承诺跨项目并发。只有可能派发工具的阶段（direct 的首个动作、planned 的 executing/verifying 补救）取租约。`answer`、`clarify`、分类与计划生成本身不取租约，因此长任务运行期间其他标签的纯问答与澄清不被阻塞，提交 direct/planned 请求则进入 queued 并在 UI 显示“等待当前任务（runId）完成”，不是静默排队也不是报错丢弃。

这是对现状的收紧：当前 `sendToAgent` 不检查其他 live agent，多标签可以并行执行工具（§2）。实施时须登记为行为变更，并在验收 A41 核对第二标签的可见反馈。

交互 run 与现有自动化共享明确的执行租约，自动化的现有串行/脚本槽位约束继续有效；脚本自动化与交互写入也不能绕过工作区互斥。等待批准的在飞调用仍持有租约；真正 quiescent 的 waiting_input/paused 才释放。调度不抢占已开始的自动化，不静默取消别人的任务。

工作区或 profile 切换先检查活跃租约与未决副作用：默认拒绝并提供“暂停/取消后切换”；暂停时冻结原根，恢复必须在同一 profile 和同一规范化根重新准入。后台任务不偷偷改全局 cwd、sandbox holder 或用户当前项目。结果不明的写入形成持久化资源隔离记录，在对账前阻止相关工作区的后续写入。

## 6. 工具、验证与中文执行说明

### 6.1 工具执行约束

Step Runner 复用 DSH native 工具链；在 `agent/pre-step`、`tools/pre-execute`/guard、最终工具结果处校验 run 生命周期、step 范围、预算、ownerEpoch 与取消信号，并在 `tools/pre-execute` 额外校验 shell 调用的 `timeoutMs` 上界（§8.1）与只读步骤内的 `sandbox_permissions` 提权请求（§8.4.1）。工具派发前写持久动作记录，结果落账后才更新步骤；不能绕开现有 policy 直接调用 shell、HTTP 或 MCP handler。

计划生成和结果解释没有副作用权限。执行阶段每次只激活一个 step；模型产生超出当前步骤能力或参数范围的调用必须拒绝或触发计划变更，不能事后将它补进已完成清单。工具成功、模型 stop、agent idle 分别记录，互不等价。

`todo_write` 可保留为模型辅助记录，但只生成建议/展示，不是 run 状态真相。`@agent` 及内部子代理的工具调用同样归属于当前 step、权限与预算；不能为了绕过上限新建 agent。无法核实内部副作用的第三方能力按不透明外部动作处理。

必须补齐所有直接消费的事件归属，包括现有 limits/present-as 的无 session 错误事件；无法归属的事件进入诊断，不污染当前标签或别的 run。辅助模型调用的 token、旧 epoch 事件以及后台自动化的 token 不计入交互 run 产出。

### 6.2 验收与最终结果

验收证据至少包括：验证器类型、要求 ID、输入/产物版本或哈希、执行时间、结果、证据引用、验证范围。支持以下验证方式：

| 任务 | 最低验收 |
| --- | --- |
| 查询/总结 | 请求范围覆盖、来源可追溯、必需字段齐全；模型语义检查只提供辅助结论 |
| 文件/报告生成 | 实际存在、可打开、格式校验、数量/内容要求满足；不能只检查路径字符串 |
| 修改代码 | 用户要求对应测试或可复现检查、相关门禁；UI 行为须真实浏览器验证 |
| 外部操作 | 服务端可核实回执及目标状态；“HTTP 请求已发出”不是完成 |
| 开放式创作 | 格式/长度/必需元素等可检项＋明确的人工验收项；无客观验证时不标为已客观证明 |

验证失败只允许针对失败原因的有界补救，成功证据可复用；无法自动判断则 waiting_input，不能把模型自评当唯一成功判据。第三方工具未提供必要回执时，保持未核实状态。

最终结果包含：完成状态、中文摘要、交付物入口、需求覆盖与验证摘要、未完成/未知影响、用户下一步。失败和取消也返回已完成的可用部分，不吞掉产物；最终文字生成失败时由程序用已验证事实生成中文模板，不重新执行已完成工具。

### 6.3 中文说明协议与 UI

公开说明来自以下材料：用户要求摘要、已接受计划、真实生命周期事件、已记录的工具结果、验收结论。事实型状态由程序中文模板生成；必要的自然语言摘要由模型基于这些事实生成并关联证据，不读取内部 chain of thought 来“翻译”。

说明分三层来源，各有固定的生成时机，不为每次状态变化额外调用模型：

| 层 | 来源 | 时机 |
| --- | --- | --- |
| 模型自述 | 模型在工具调用之间输出的 assistant 正文，按现有流式协议原样展示并标为草稿 | 随回合产生，零额外成本 |
| 程序模板 | 生命周期、步数、等待时长、连接状态、工具结果摘要 | 事件落盘即刻渲染 |
| 模型摘要 | 基于已核实事实的中文摘要，引用证据 ID | 仅在步骤结束与 run 结束各一次；失败时回退到模板 |

模型自述与 reasoning 字段是两类内容：前者是面向用户的正文，后者按 §2 的协议只走供应商通道，不进入说明层。

界面名称使用“执行过程”或“执行说明”，不声称“完整思考过程”。控制说明和状态用中文，标识符、命令、路径保留原文；最终交付物语言遵循用户要求。供应商 reasoning 字段继续仅按现有模型协议处理，本功能不新增其日志复制、展示或对外导出。

复杂任务展示可折叠卡片：需求理解、当前版本计划、各步骤状态、已用时间、当前动作、工具结果摘要、验证及产物；简单任务只显示动作与结果，不弹出完整计划。更新计划时显示“计划已调整”及受影响步骤，不倒退伪装进度。

文案示例：

- “已识别为资料汇总任务，准备读取文件并生成报告。”
- “共 4 步，已完成 2 步；正在核对第三份材料。”
- “执行进程在线，当前操作已等待 45 秒，尚无新的结果。”
- “连接已断开，正在重新连接；任务是否完成待同步确认。”
- “已停止派发新动作；外部请求的最终结果尚未确认，请先核对。”

只展示有分母依据的步数，不显示时间估算伪装的百分比；心跳与 reasoning token 只能说明存活/传输活动，不能让业务完成度增长。流式中间文字标为草稿，最后摘要引用持久结果。

提供取消、安全边界暂停、继续、回答澄清/确认、重试失败任务、查看证据。按钮状态来自服务端 revision；键盘可达，更新用非打断式读屏提示，不在每个 token 抢焦点。普通工具输出作为文本/安全 Markdown 渲染，拒绝脚本、原始 HTML 注入及任意本地文件跳转。

## 7. 受理、事件与持久化协议

### 7.1 产品 API

新增 `run.*` 语义，接在现有同源、本机和桌面鉴权边界内；不得开放新的无鉴权监听端口。路径采用 `/huaanwork/run/...`，方法必须同时进入前后端路由表与契约测试。以下为新增协议，不表示接口已经存在。

| 方法 | 输入 | 返回与约束 |
| --- | --- | --- |
| `run.start` / POST start | clientRequestId、conversationSessionId、text、可选显式 skill/at | 持久化受理后 HTTP 202，返回 runId、revision、state；不等待分类或执行 |
| `run.get` / GET get | runId | 权威快照、lastSeq、当前预算和可用动作 |
| `run.list` / GET list | conversationSessionId、cursor、limit | 所属对话的分页运行记录 |
| `run.events` / GET events | runId、afterSeq、limit | 有序持久事件、nextSeq、hasMore；cursor 必须合法 |
| `run.pause` / POST pause | runId、expectedRevision、commandId | 记录暂停意图；仅安全边界完成后显示 paused |
| `run.cancel` / POST cancel | runId、commandId | 幂等接受取消；不因陈旧 UI revision 拒绝停止请求；已终态返回当前快照 |
| `run.respond` / POST respond | runId、expectedRevision、commandId、inputId、answer | 只作用于当前待答问题；过期或内容变化返回 409；释放过租约的运行须重新排队 |
| `run.resume` / POST resume | runId、expectedRevision、commandId | 先对账/准入，再排队；不能跳过 unknown effect 或消耗完的预算 |
| `run.reconcile` / POST reconcile | runId、actionId、expectedActionRevision、commandId、resolution、证据引用或显式风险确认 | 对未知动作进行核实或记录风险处置；终态 run 也可调用；不重开原运行、不重发动作 |

对已鉴权主体校验 profile/session/run 归属，runId 不是访问凭证。查询不能读取其他 profile 的记录。正文、字段长度、分页和路径参数均在入口校验。UI 不允许传入任意存储路径或自行指定 ownerEpoch。

`run.reconcile` 的 resolution 为 `verify | accept-risk`：verify 由受约束的只读适配器核实证据，不接受用户或模型仅报“已完成”；accept-risk 需要有权限的用户在独立确认界面明确接受重复/未知效果风险，不能由模型调用或泛化的“继续”代替。裁决先写入动作账本，再解除对应资源隔离；accept-risk 标为“风险已接受、原结果仍未知”，不制造成功验收证据。此操作追加处置记录，不改写原终态结果，后续执行仍须新动作与正常审批。

同一 profile 内 `clientRequestId` 唯一：同 ID 且内容摘要一致返回原 run；同 ID 内容不同返回 409 `request-conflict`。按钮双击、请求回包丢失或重连均复用同 ID，禁止因网络失败自动生成新 ID重发。命令 commandId 同样去重并校验 payload。

受理顺序为：权限/输入校验 → 去重/并发校验 → 持久化 accepted → 更新索引 → 返回 202 并唤醒调度。持久化失败返回 `run-storage-unavailable`，绝不启动工具。原 HTTP 连接关闭不取消已受理任务。

交互 UI 全部切到 run.start；`session.send` 保留现有自动化等实际内部消费者语义，不让两条路径重复执行同一请求。既有会话管理接口继续用于历史/归属，不作为恢复任务的替代入口；对受管会话的其他发送入口必须遵守租约。

旧 `session.cancel/approve/reject/resume` 若目标属于受管 run，一律拒绝并返回 `managed-run-required` 与对应 runId，要求客户端使用带完整命令身份的 run API；不得先执行原 handler 再补记录。从未受管会话发起的旧取消必须精确限定其自身及已登记后代，不得遍历取消其他 run。run.respond 的操作审批先提交绑定 inputId、actionId、参数摘要及 revision 的裁决，再唤醒原权限等待者；无持久裁决不能消费一次性放行。既有自动化审批维持原入口，但不能跨入交互 run。

### 7.2 事件和重连

持久事件类型至少包括 accepted、intent、plan、state、step、tool、approval、artifact、verification、result；均有递增 seq。工具事件包含明确 outcome，不再以旧 `tool/end` 代表成功。当前 `RpcEvent` 的普通聊天/自动化消费者保持明确区分，新 run UI 不使用 `session/end` 来关闭运行卡。

状态事件先落盘再广播。WS 仅作低延迟通知；token 可为非持久草稿事件，但必须携带 run/ownerEpoch/streamRevision，不能推进持久 cursor。工具完成和最终结果绝不能只存在 WS 帧里。

重连先注册监听并缓冲事件，再取 run 快照和 lastSeq，应用快照后补读更大 seq、合并缓冲并去重；或者使用语义等价的服务器订阅屏障。检测序号缺口立即补读，不跳过。事件被合法压缩后服务端明确返回 `snapshot-required` 和新基线；不能静默丢失。反复断线不重放工具，只重放展示数据。

慢客户端不能阻塞执行；发送队列有字节上限，超限断开该连接并提示重新同步。重连失败时 UI 保留最后已知状态及“尚未同步”，不能把 ready 当作所有 run 已恢复。

### 7.3 本地账本与提交点

存储位于 profile 私有目录的 `conversation-runs/<runId>/`，不写入用户工作区，也不复用自动化仅保留最近 50 条的历史。采用单写者追加事件日志与可重建快照，不引入云依赖；该日志是运行状态的权威来源，快照、请求索引、UI 均为投影。

事件有 schemaVersion、seq、上一条摘要和当前记录摘要；摘要用于发现截断/损坏，不声称能抵御有本机写权限的攻击者。accepted、计划确认、动作派发前、动作结果、审批裁决、取消/暂停意图及终态须完成文件同步后才对外确认。新建/替换文件须使用同目录原子操作和平台支持的目录同步，验证 macOS/Windows 的实际行为；不能将 rename 单独等同断电持久性。

runId 为宿主生成的合法 ID；索引在启动时由已提交日志重建。重复受理在 profile 单写者锁内处理，避免跨文件索引更新中断导致重复执行。Host 接管以主进程 generation/退出确认以及独占 profile owner 为条件，不只看一个过期时间或可复用 PID。

恢复只接受连续完整记录；尾部未完成记录可隔离并恢复到最后有效提交点，中段损坏或不支持的 schema 必须标记 `run-store-corrupt`/`run-version-unsupported`，停止对应 run 并保留原文件，不能当成空日志重新执行。若派发记录已提交但结果记录不完整，动作按未知结果处理。

产物先写完并同步，再落引用记录；恢复时验证引用存在和摘要，丢失则使相关验收失效。大输出只保留有界摘要和受管证据引用，不把完整输出塞入每个模型回合。默认每个 run 的附加日志/证据上限 64 MiB、profile 总上限 1 GiB，用户产物原文件不计入但只保存引用；超预算停止新动作并提示管理历史，绝不自动删除活跃或待对账记录。预留 4 MiB 控制记录额度，超额度时不再追加可选输出。

磁盘满或 I/O 卡住时独立监督仍须停止派发并发出可见错误；控制记录无法落盘时只报告“请求尚未可靠保存”，不能谎称已持久化取消或已完成。恢复从最后提交点重新对账。记录不得存密钥、授权头或凭证；必要用户内容沿用本地会话数据隐私边界，不额外复制 reasoning。

## 8. 超时、取消、监督与恢复

### 8.1 分层预算

任务总预算可按需续期，单步期限按操作配置，所有执行仍有有限上限。以下为待评审的初始默认值，运行时通过经校验的 HuaAnWork 设置解析成每个 run 的预算快照；不是写死在 prompt 里，也不是本次修改配置。30 分钟仅为初始活跃计算预算，不是任务不可突破的总时长上限；单步或单次操作不统一设为 20 或 30 分钟。用户显式续期须生成新预算版本和事件，保留累计用量且每次只授予有限增量，不能自动无限续期或通过新建 run 绕限额。

| 层级 | 默认值 | 处置 |
| --- | --- | --- |
| 受理/控制请求 | 10 秒；本机无负载受理目标 p95 < 1 秒 | UI 查去重键或复用同请求 ID重试，不推断任务失败 |
| 模型连接/首个协议活动 | 120 秒 | 可安全取消的失败进入有限重试；不把无正文但有 reasoning 活动误判为断流 |
| 模型流无协议活动 | 120 秒 | 中止本次请求并记录 idle timeout |
| 单次模型请求总时长 | 600 秒 | 即使持续吐 token 也受总上限约束；超时记录区分“无协议活动”与“输出过长”两种原因，后者不对同一 prompt 自动重试，由 Coordinator 决定是否缩小上下文后重发 |
| 普通工具一次执行 | 120 秒，落在 shell 执行器行（`bash-sandbox` / Windows `desktop-windows-pwsh-sandbox`）的 `timeoutMs`；当前基座 bash 为 60 秒、pwsh 为 120 秒，统一到 120 秒是本次待批的配置变更 | 动作 owner 触发取消并确认收敛 |
| 明确的长工具 | 模型按调用传上游已有的 `timeoutMs` 参数；HuaAnWork profile 把执行器 `maxTimeoutMs` 设为允许的单步最大期限（待批默认 1800 秒）；不统一封顶 20 分钟 | `tools/pre-execute` 校验 `timeoutMs ≤ min(当前步剩余期限, 任务剩余预算, maxTimeoutMs)`，超出则 deny 并给模型可自纠的原因（缩短期限、拆步或请求续期）；到期由执行器终止并确认收敛，时间延长不能免除监督 |
| 单步期限 | 按步骤所含操作、有限重试及验证所需时间配置，派发前冻结本次 attempt 的有限 deadline | 到期停止新派发并有界收敛；心跳、进展或任务预算续期不能自动延长当前期限 |
| 任务总预算 | 初始活跃计算 30 分钟；初始最多 32 步、80 次模型请求、160 次工具派发。计划 `budget` 超过初始值时在计划确认卡中列出，**确认计划即确认该预算**；续期是执行中超出已确认预算的例外路径 | 达到当前已授权上限停止派发，安全边界进入 waiting_input(budget)；显式续期后从已核实检查点继续，不清零累计用量 |
| 无业务进展 | 5 分钟告警 | 无工具结果、产物或步骤推进时提示；不因正常长工具一律杀进程，硬期限仍生效 |
| Host 心跳 | 2 秒一跳，连续 15 秒缺失进入 suspect | suspect：冻结新派发、UI 显示“执行进程无响应”；主进程主动 ping。升级到停止 Host 只在两种情况：连续 60 秒无响应且该 Host 承载活跃 run，或用户已请求取消而取消在 §8.3 的期限内无法收敛。没有活跃 run 时只报告不终止 |
| 普通协作取消/drain | 10 秒 | 超时交主进程执行隔离处置；不把放弃 await 当作已停止 |
| 操作审批 | 保留现有 120 秒一次性许可期限 | 到期结束本次待批调用，安全收敛后显示等待重新确认，不自动批准或循环申请 |
| 澄清/计划确认、暂停 | 不占用模型/工具执行预算 | 持久显示等待，24 小时后转 paused；恢复重新核对上下文与权限 |

可拆的长任务应分步执行，在各安全边界持久保存检查点（已完成动作、产物及验证证据、剩余计划和累计用量）；暂停或预算用尽后按 §8.4–§8.5 核对并接续，不从头重放已完成步骤。不可拆的超长操作由模型在调用时声明 `timeoutMs`，由 `tools/pre-execute` 用上表的三重上界校验：期限不被当前步剩余期限、任务剩余预算或 `maxTimeoutMs` 覆盖时拒绝派发并说明原因，模型可缩短期限、拆步或向用户申请续期；不先启动再等待超时切断。计划中不需要为每个长操作预先写死秒数，但 `Step.deadline` 仍是该步所有操作期限之和的上界。

派发前核对模型适配器、工具、传输与宿主监督各层的实际执行期限：模型适配器 600 秒、执行器 `maxTimeoutMs`、HostRpc 120 秒以及 §7.1 的受理期限都是已知硬限制；若所需期限超过其中任何一层，明确报告约束并停止派发，不能只修改计划里的数字就声称支持。预算续期不自动延长在飞操作的 deadline，也不绕过权限、取消、监督或 §7.3 的存储上限。

活跃时间包含模型/工具工作和自动重试等待，不包含真实无在飞动作的人工等待。进程内用单调时钟计时，持久化累计使用量；跨进程保守估计未知区间，不因重启清零。预算包括分类、计划、子代理、模型适配器 continuation、provider retry 与最终验证，不能在多层各重试三次形成乘法放大；原有更严护栏仍优先。

心跳由执行 Host 主事件循环响应，携带 epoch、阶段和最近真实进展时间；不能由另一个空闲线程代发来证明被卡住的执行循环健康。reasoning/SSE keepalive 只能延长流空闲期限，不能刷新业务进展或请求总期限。

### 8.2 进程外监督与运行前提

选择复用当前独立 Host，不为每一步另起整套 DSH。Electron 主进程监督 Host，而非 renderer 或 Host 自己监督自己；监控采用独立的短期限 IPC，不复用 120 秒 HostRpc 默认期限。主进程不执行同步文件扫描或工具代码。当前 `host-process.ts` 没有任何心跳或探活（§2），本节的心跳、suspect 判定与升级终止都是新接线，不是对既有 watchdog 的参数调整。

HuaAnWork 高级模式要提供本规格完整保证，必须使用独立 Host；`prepared.mode === 'advanced'` 且显式 `DSH_DESKTOP_ISOLATED_HOST=0` 时，在 `main.ts` 的进程模式分叉点（[main.ts:1652](../../../dsh-plugin-huaanwork/src/main.ts#L1652)，此处 `prepared.mode` 已确定）给出可操作错误并拒绝启动，不静默忽略环境设置，也不先启动同进程 Host 再在进入高级界面时报错。兼容模式不改变。同进程分支代码保留，继续服务兼容模式与测试 harness；测试中的同进程 harness 仅验证纯逻辑，不作为卡死恢复验收。该限制是本文待批准的产品决定；`=0` 在仓库文档中只是 A/B 对照与开发期未验证模式，拒绝它不影响任何已发布路径。

Host 在线但任务超时：先仅取消该 run 及已登记后代，禁止调用当前“取消所有其他 agent”的函数。只有任务不能收敛或 Host 心跳失效，才升级到停止该 Host；必须先告知影响范围并冻结它承载的其他工作，记录为 interrupted 而非逐个伪称取消成功。

确认 Host 退出前不启动新 owner，不因租约时间到期就发放新租约。失败或退出未确认时保持隔离、显示恢复入口；自动重启最多一次，重复失败交用户处理，禁止重启风暴。没有完成旧执行者隔离时禁止自动续跑。

主进程/应用自身退出无法由自身保证存活；在下次启动处理残留。关闭窗口沿用现有退出/驻留设置，不擅自改成常驻后台。休眠唤醒先刷新 generation、探测存活并核对在飞动作，再恢复心跳判断，不能用睡眠造成的心跳间隔直接判为 Host 死锁。

### 8.3 取消与副作用

取消顺序：持久化 stop 意图 → 冻结新派发 → 向精确的 agent/工具/子进程传播取消 → 等待收敛或升级终止 → 对账在飞动作 → 提交 cancelled 或 interrupted。最终完成与取消竞态由同一 reducer 序列化：先持久化终态则返回该终态；先接受取消则不能随后因迟到 idle 变成功。

取消只承诺停止继续调度并尽力终止当前计算，不自动撤销已修改文件、已发送消息或远端提交。退出码/ABORTED 不等于副作用未发生。需要回滚时必须作为新的显式、受权限约束的动作，不能无声执行清理脚本覆盖用户工作。

对子进程须有实际 owner 和终止确认，覆盖 macOS 的后代进程及 Windows 进程树；只杀 Host PID 不足以证明命令停止。终止机制复用上游 `subprocess-local`：工具的 AbortSignal 触发对分离进程组的信号与 SIGKILL 升级，Windows 走 `taskkill /PID <pid> /T /F`（§2）；本功能不另写 kill 逻辑，只负责把取消信号精确传到当前 run 的工具调用，并在结果落账前等待执行器报告进程已退出。A34 因此是对上游机制在打包 rc.1 上的真机核实，不是新实现的验收。对无法控制的远端操作只停止本地等待，状态进入结果未知并阻塞相关后续写入。

### 8.4 动作账本与重放规则

每个动作记录：`actionId`、step/attempt、callId、工具名称及版本、参数摘要、目标资源、所需许可、`effectClass`、幂等键/远端请求 ID（若有）、派发与结果状态、证据。逻辑 actionId 跨网络重试保持不变；新业务动作另分配 ID，不能仅按同名工具/相同参数去重用户有意重复的操作。

派发边界为：prepared → dispatch-intent（已同步）→ 调用工具 → result（已同步）。dispatch-intent 与真实外部提交之间没有通用原子性，因此任何缺 result 的在飞动作都先视为 unknown；不能以“可能还没发送”推断安全重试。

| 动作类别 | 中断后的处理 |
| --- | --- |
| 已完成并已验证 | 校验输入/产物版本后跳过，不重新运行 |
| 未派发 | 重新准入后可执行 |
| 经注册适配器确认的只读动作 | 丢弃不完整结果，可在总预算内重试 |
| 在 `read-only` 沙箱会话中派发的动作（§8.4.1） | 等同只读动作：内核已拒绝一切工作区外写入，网络由 `allow_network` 总闸控制；丢弃不完整结果后可重试 |
| 外部服务支持幂等键和结果查询 | 先查询；已提交则接收原结果，未提交才用同一个 key 重试 |
| 本地受管文件写入 | 比对前置版本、目标哈希与产物；已达到目标则补证据，冲突等待用户 |
| `workspace-write` 步骤中的 shell 等不透明本地写入（§8.4.2） | 用派发前记录的工作区指纹与当前状态比对：无差异则视为未发生、可重试；差异全部落在步骤声明的目标路径内则按“本地受管文件写入”对账；有声明外差异或指纹不可用则 unknown |
| 网络开启且可能外发的 shell、不可核实的第三方 MCP/HTTP 或其他非幂等远端动作 | 默认 unknown，不自动重发，等待人工/专用查询对账 |

工具宣称只读或模型说“可重试”不足以改变类别；沙箱模式由宿主在派发前写入执行会话并由内核执行，是可信的只读证明，命令文本分类不是。幂等键不等于服务端支持幂等，必须验证服务端协议。权限批准不是“操作未发生”的证据，用户同意继续也不能直接清掉 unknown 标记；若选择承担重复风险，须显式创建新的动作并保留前次未知记录及风险提示。

恢复到步骤不是重跑整个步骤：先处理已完成/未知动作，仅在当前步骤没有已派发的写入或全部效果已经对账且有明确续点时继续。无法从动作级安全接续时停止要求用户处理，禁止靠恢复长对话让模型自行猜测哪些动作做过。

#### 8.4.1 只读步骤的沙箱收窄

计划中声明为只读的步骤（能力只含读取、搜索、`git_status`/`git_diff` 等以及不改文件的 shell），派发前由 Step Runner 向该步的执行会话追加 `sandbox/mode: read-only` 事件，并在 `tools/pre-execute` 拒绝该步内的 `sandbox_permissions` 提权请求；步骤结束或 run 终止时追加回 `workspace-write`。这是会话级事件，不改 profile 的部署默认 `workspace-write`，不动 `row-assertions` 的钉。只读步骤因此不进入 unknown：中断后直接重试，最多消耗预算。模型在只读步骤里尝试写入会被内核拒绝并以工具错误返回，Runner 据此触发计划变更而不是放行。

#### 8.4.2 写入步骤的工作区指纹

`workspace-write` 步骤派发前，Runner 记录一次工作区指纹并随 dispatch-intent 落盘：git 工作区取 `git status --porcelain` 输出与其中每个变更文件的内容哈希；非 git 工作区取步骤声明目标路径下受管文件的清单与哈希。指纹有数量与字节上限（待批默认 2000 文件 / 64 MiB 读取量），超限时不做指纹、该步的不透明写入直接按 unknown 处理并在计划卡提示。恢复时用同一算法重算并按上表对账；“已核实变更范围”写入证据链，恢复摘要据此告诉用户哪些文件被改过。

经 8.4.1 与 8.4.2 收窄后，真正落入 unknown 的只剩：网络开启且可能外发的 shell、第三方 MCP/HTTP、指纹不可用的大工作区写入。这些类别保持本节的等待对账规则。

### 8.5 恢复准入

启动/手动恢复依次检查：存储 schema 与完整性 → 旧 owner 确认失效 → profile/工作区仍存在且归属一致 → 凭证、工具、网络与沙箱当前可用 → 未决动作对账 → 输入和产物版本 → 当前计划有效性 → 剩余预算及审批。

renderer 刷新或断线不暂停健康任务，重新连接只读状态；Host/应用重启后先展示 interrupted 与恢复摘要，默认由用户点击继续。不会自动执行新的写入或沿用一次性审批。对过时工具版本/缺失文件/已删除项目给出原因和下一步，保留结果而不是从空任务开始。

一种受限的自动续跑作为可选项：仅当应用仍在前台、中断原因是 Host 崩溃（不是应用重启或休眠）、§8.2 的一次自动重启已成功、准入链全部通过、当前步骤没有任何已派发但缺 result 的写入动作、且继续不需要新的审批时，可不等用户点击直接从检查点继续，并在运行卡显示“执行进程已重启，已自动继续”的持久横幅与撤销入口。任一条件不满足则回到默认路径，“继续”按钮取得焦点但不自动触发。该可选项默认关闭，开关属于 HuaAnWork 设置，不是模型或计划可改的字段。

未知副作用未清除时可继续只读对账，但相关工作区写入仍被冻结。用户取消或归档任务不自动解除这一隔离；必须记录已核实结果或显式风险处置决定。

## 9. 错误归属与报告

| 错误类型 | 处理 owner | 保持的保证 / 安全下一步 |
| --- | --- | --- |
| intent-invalid / plan-invalid | Coordinator | 未执行工具；修正输入或计划 |
| permission-denied / approval-expired | 原 policy + Run 输入控制 | 未获批准的动作不派发；重新确认不继承旧许可 |
| model-timeout / tool-timeout | 当前请求/动作 owner | 取消并记录 outcome；只有安全动作可有限重试 |
| verification-failed | Verifier | 不提交成功；有限补救或报告缺项 |
| outcome-unknown | 动作账本 owner | 停止依赖动作、隔离资源，查询或人工核对 |
| host-unresponsive / termination-unconfirmed | 主进程 Supervisor | 停止调度、不启动第二 owner；明确列出受影响运行 |
| run-storage-unavailable / run-store-corrupt | Store + Supervisor | 不声称持久成功；停止写操作，保留证据并提示恢复 |
| event-disconnected | UI | 只改变连接状态，不推断业务结果，重连补读 |

错误码是稳定判别字段，中文消息只负责解释；不得靠解析错误字符串决定重试。所有最终报告给出影响、已知/未知结果、系统当前处置及下一步。WS 或 Host 无法报告时，主进程使用原生恢复提示和默认可访问日志兜底；报告失败不能使状态变成成功。

## 10. 安全与仓库边界

1. 不改 `deepseek-harness/`，不改 Stable/Beta 源码；不借本功能升级运行时、启用 jobs/PTC/run_code/user-questions 或降低现有 guardrails。
2. 计划是待校验数据，工具输出和检索资料是不可信内容，不得成为新权限或系统指令。模型阶段角色通过真实执行限制隔离，不只靠提示词。
3. 原网络门禁、工作区沙箱、工具附件和审批链在执行及恢复时都适用；每个具体调用保持权限不扩大。`@` 附件只绑定执行会话和实际 run 生命周期，终止/暂停/恢复时正确卸载、重建。
4. 不扩展现有自动化无人值守白名单。共享 holder 必须在 run 归属检查和互斥保护下使用；交互 run 绝不消费自动化的降级授权。
5. 工具结果、中文摘要和证据链接均脱敏并校验；renderer 不能通过结果链接读取 profile 中凭证或任意文件。
6. 本次仅写规格；若实施需要新的变体差异或修改已锁定的运行模式，须以本文已批准设计为依据显式登记，不能偷偷扩白名单、改配置或编辑已有用户改动。
7. 本文用到的上游机制都是收窄或显式配置，不是放宽：会话级 `sandbox/mode: read-only` 只能比部署默认更严，且不动 `row-assertions` 钉住的 `workspace-write`；执行器 `timeoutMs`（60→120 秒）与 `maxTimeoutMs`（600→1800 秒）是 profile 配置行的显式变更，随 §13 第 7 条一起批准，`enableRunInBackground: false` 与 jobs 锁不变。

## 11. 预计实现落点与验证前置

本节描述职责落点，不是已实施的文件清单，也不授权当前会话改代码。

| 区域 | 预期职责 |
| --- | --- |
| `src/huaanwork-host/` 新编排模块 | run 类型/schema、单写者存储、状态 reducer、意图/计划、runner、verifier、恢复 |
| `huaanwork-host/{routes,events,holders,index,sessions}.ts` | 受理、查询、事件、生命周期、对话历史及自动化执行互斥 |
| `huaanwork-host/{automations-host,automation-scheduler}.ts` | 仅共享租约/停止和恢复隔离，不改变定时语义 |
| `huaanwork-host/agent-invoke.ts`、会话清扫与删除逻辑 | 精确 run 后代/附件生命周期、引用保护 |
| `huaanwork-guardrails/{bridge,model,approval,limits,present-as,policy}.ts` | 关联身份、最终结果、分层预算、审批范围、子代理约束、`timeoutMs` 上界与只读步骤提权拒绝；保持原 deny 集合 |
| `profile.ts` 的 shell 执行器行与 Step Runner 的会话级 `sandbox/mode` 写入 | 执行器 `timeoutMs`/`maxTimeoutMs` 配置（`profile.ts` 已在变体白名单内，不新增名额）；只读步骤的 `read-only` 事件追加与回切 |
| `client-huaanwork/{api,rpc-types,App}.ts(x)` 与独立运行卡组件 | run API、状态投影、中文计划和进度、输入/取消/恢复、历史重建 |
| HuaAnWork `main.ts`、`host-process.ts` 及必要的 Host IPC 接线 | 监督、退出确认、模式前提和独立报告路径 |
| HuaAnWork tests/scripts 与 root 变体守卫（仅确需时） | 状态/故障注入/真实组合/浏览器/打包验证；如实登记实际变体差异 |

实施的第一个验证门是运行时接缝核对：用当前实际 vendored/安装/打包 rc.1 确认 agent 事件、工具结果、scope 限制和取消传播，并用真实 Loader 组合验证新 hook 与原 policy 不互相绕过。源码 API 与包内 API 不一致时先修订适配设计或本 spec，不能凭源码推断通过，更不能改子模组来补缺口。

主干实现顺序为：协议/状态/存储 → 受理与互斥 → 意图/计划/步骤执行/验证 → 中文 UI/重连 → 监督与故障恢复 → 全链路验收；顺序不是拆分交付，全部验收项通过才可宣布本功能完成。

## 12. 验收矩阵

以下全部为未来实施验收，当前未执行、未勾通过。自动测试不能替代真实 UI 与平台进程核对。

| ID | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| A01 | 简单问答、单次查询 | 正确选择 answer/direct；没有多余计划卡；只调用必要工具 |
| A02 | 短但危险的请求 | 简单分流不免审批；deny 无法被模型或计划覆盖 |
| A03 | 多文件汇总并生成产物 | 所有要求映射到计划、执行和验收；产物实际可打开 |
| A04 | 分类/计划格式损坏、循环依赖、工具不存在 | 有界修复后明确失败；未执行任何不合法动作 |
| A05 | 缺少收件人/目标目录 | 中文澄清并等待；不会猜测后执行 |
| A06 | direct 执行后升级计划 | 保留已完成动作，剩余步骤才执行，不重放副作用 |
| A07 | 计划变更删要求或扩大范围 | 覆盖校验拒绝/请求确认；旧证据按依赖失效 |
| A08 | agent 报错后 idle、工具 isError 后正常结束 | run 不误标成功；中文结果保留失败原因 |
| A09 | 模型声称产物存在但文件不存在/格式损坏 | 验证失败，不能只凭正文或 tool/end 收口 |
| A10 | 只产生 reasoning/非中文状态/think 标签跨 chunk | 不泄露推理；显示真实中文阶段，不伪造进度 |
| A11 | 模型修复/子代理/continuation 多层重试 | 总预算统一扣减；不能靠换 agent 绕上限 |
| A12 | 重复点击、202 回包丢失、相同 ID不同内容 | 单一 run 和单次业务效果；冲突返回 409 |
| A13 | WS 断线、乱序/重复、快照与事件竞态 | 补读后与服务端一致；不重复工具和最终消息 |
| A14 | 前端请求超时或刷新 | 健康任务继续；UI 可查回真实状态而非直接失败 |
| A15 | 模型无活动、持续 token 超硬期限、模型以 `timeoutMs` 声明超过 20/30 分钟的不可拆长操作 | 分层有限期限各自生效；`timeoutMs` 被三重上界（步剩余期限、任务剩余预算、`maxTimeoutMs`）覆盖时不在 20/30 分钟被统一截断，也不因无正文被误杀；超出任一上界时 `tools/pre-execute` 拒绝派发并给出模型可自纠的原因；达到配置期限仍由执行器终止并收敛 |
| A16 | Host 主循环阻塞/事件监听抛错/IPC 不返回 | 主进程在有界时间报告并隔离；不依赖被阻塞循环的 timer |
| A17 | Host 退出未确认、迟到旧 epoch 结果 | 不启动第二 owner；旧结果不覆盖现状态，仅用于对账 |
| A18 | 取消发生在派发前/派发后/验证完成竞态 | 无新动作、准确终态、已发生效果有说明；不误称回滚 |
| A19 | 取消一个 run，另有自动化/其他会话 | 不调用全量取消；权限不串用，升级杀 Host 时完整报告影响 |
| A20 | prepared/dispatch-intent/外部提交/result 各点进程崩溃 | 分别按日志对账；不把未知结果当成安全重试 |
| A21 | 远端收到请求但回包丢失 | 支持幂等服务只产生一个效果；不支持者阻塞等对账 |
| A22 | 写文件后崩溃、人工改文件、产物被删除 | 已完成不重写；冲突/缺失使证据失效而非覆盖用户内容 |
| A23 | 步骤内部完成一次写入后中断 | 不从头执行整个步骤；按动作续点或等待处理 |
| A24 | 重启、休眠唤醒、窗口关闭 | 恢复入口与当前真实运行边界一致；没有后台永续承诺 |
| A25 | 同进程模式配置 | 高级模式启动前明确拒绝并说明；不能宣称 watchdog 已覆盖 |
| A26 | 日志尾截断、中段损坏、未来 schema、磁盘满 | 无静默重建或重复执行；可见错误并保留数据 |
| A27 | 切换工作区/profile、删除关联项目/会话 | 有租约/引用保护；不会跨根执行或丢恢复证据 |
| A28 | 审批到期、重启后批准旧请求、输入 revision 过期 | 过期许可失效；明确返回冲突或重新确认 |
| A29 | 无法自动验证的创作/第三方动作 | 等待人工验收或报告验证范围，不伪称客观正确 |
| A30 | 最终摘要模型失败 | 从事实生成中文结果；不重跑已成功操作 |
| A31 | 输出注入、路径越界、越权 run 查询、伪造 epoch | 权限与存储入口拒绝，UI 不执行内容，不扩大工具权限 |
| A32 | 慢 WS 客户端、长输出、token 风暴 | 执行不阻塞；背压/字节预算生效，最终结果可补读 |
| A33 | `@` HTTP/MCP/agent、`/skill` 与普通聊天回归 | 路由、附件、沙箱、一次性审批及上下文延续保持正确 |
| A34 | Windows 与 macOS 真实派生进程取消（打包 rc.1 真机） | 上游进程组信号 / `taskkill /T /F` 在 Electron Host 内确实终止整棵进程树，执行器报告退出后账本才落 result；无法确认时如实标 unknown，不是仅断开 await |
| A35 | 可拆任务超过初始 30 分钟预算、显式续期、长期失败与重复恢复 | 分步保存检查点，预算耗尽时安全等待；每次续期有限且留有版本与事件，累计用量不清零，恢复不重放已完成动作、不自动延长在飞期限；无自动无限续期、无限重试或重启风暴，历史证据连续 |
| A36 | 新记录与既有历史/自动化并存 | UI 无重复消息、下一轮模型上下文完整、清扫不删活动记录 |
| A37 | 执行失败但后代/工具仍在工作 | 不提前提交 failed 或释放执行租约；无法收敛进入 interrupted |
| A38 | 等待输入释放租约，另一任务占用后再回答 | 答案先落盘、重新排队，不与已有 owner 并行执行 |
| A39 | 旧 cancel/approve/reject/resume 调用命中受管 run | 明确拒绝，不执行旧 handler；无持久裁决不能批准工具 |
| A40 | 终态 run 留有 unknown，用户完成核实或风险处置 | 对账接口可达且幂等；隔离按裁决解除，不重开 run、不伪造成功、不重发动作 |
| A41 | 长任务运行中，第二个标签分别发起 answer、clarify、direct、planned 请求 | answer/clarify 不被阻塞；direct/planned 进入 queued 并在该标签显示“等待当前任务（runId）完成”；原任务无干扰，无静默排队或报错丢弃 |
| A42 | 只读步骤内模型尝试写文件或请求 `sandbox_permissions` 提权 | 执行会话已切 `read-only`，内核拒绝写入并以工具错误返回；提权请求被 pre-execute 拒绝；步骤结束后会话回到 `workspace-write`；该步中断后按只读重试、不进 unknown |
| A43 | `workspace-write` 步骤的 shell 写入后 Host 崩溃，恢复时分别构造：无差异 / 差异全在声明路径内 / 有声明外差异 / 工作区超过指纹上限 | 四种情形分别判为未发生可重试 / 按受管写入对账 / unknown / unknown，恢复摘要列出“已核实变更范围”，不自动重发 |
| A44 | `guard_mode` 分别为 `ask`/`smart`/`full` 时提交同一份含 `git push` 步骤的计划，以及一份只含读取与 `pnpm test` 的计划 | `ask` 两份都先等确认；`smart` 含 push 的先等确认、只读的自动执行；`full` 两份都自动执行；三档下 `git push` 调用本身的工具级审批行为与现状逐字节一致 |
| A45 | 没有活跃 run 时 Host 心跳缺失 60 秒以上；有活跃 run 时分别缺失 15 秒与 60 秒 | 无活跃 run 只报告不终止；15 秒进入 suspect 并冻结派发、UI 可见；60 秒且承载活跃 run 才升级停止并确认退出，受影响 run 记为 interrupted |

验证层次：纯 reducer/schema 单测、真实磁盘与重启故障注入、真实 DSH Loader 组合、浏览器完整任务流、独立 Host 与平台进程测试。使用可控模型/外部服务 fixture 做确定性测试，再对配置的真实模型做有限端到端核验；不得为测试外发真实文件或使用生产收件人。

实现完成后至少执行 HuaAnWork 的 typecheck/test/check、根 `check:desktop-variants` 与受影响的 headless gate，命令通过根 Yarn 4.18.0；需要桌面交互时显式启动 dev 并在浏览器/桌面验证 A01/A03/A13/A18/A24/A41。全根门禁涉及 AA 时按既有已知并发边界调度，不靠删校验或假通过解决。Windows 真机/CI 未具备则相关验收保持未验证，不宣布全平台完成。

## 13. 评审需确认的具体产品决定

本文给出一组完整、可实现的默认选择；以下需要随 spec 审批一起确认，而非留给执行者静默决定。

1. 中文展示的是可验证的执行说明，不新增原始 chain of thought 展示。说明来源固定为 §6.3 的三层（模型回合内自述、程序模板、步骤/run 结束各一次的模型摘要），不为每次状态变化额外调用模型；供应商 reasoning 字段不进入说明层。
2. 计划展示后是否自动执行由用户已选的护栏档位 `guard_mode` 与现有 shell 分类决定（§4.2 表）：`ask` 全部先确认；`smart` 默认自动执行，任一步骤声明能力落在 would-be-ask 集合（高危 shell、`git_push`、脏树 `git_checkout`、附加 host/MCP 工具）或涉及外发/删除时先确认；`full` 自动执行。不新造第二套“低风险”标签，不接受模型自评；敏感操作保持原工具级审批，变更目标/收件人/写入范围/预算须再确认。
3. 本地优先，默认串行执行；“后台”不等于退出或关机后仍执行，也不承诺跨项目并发。执行租约键为 `(profileId, 规范化 workspaceRoot)`，只有可能派发工具的阶段取租约，`answer`/`clarify`/分类/计划生成不取；长任务期间第二标签的 direct/planned 请求排队并有可见反馈（A41）。这是对当前多标签可并行执行工具的收紧，实施时登记为行为变更。
4. HuaAnWork 高级模式要求独立 Host；`prepared.mode === 'advanced'` 且显式 `DSH_DESKTOP_ISOLATED_HOST=0` 时在 `main.ts` 进程模式分叉点拒绝启动并给出可操作错误，不先启动同进程 Host 再降低保证继续运行；兼容模式与同进程代码分支不变。§8.2 的心跳与监督是全新接线（当前 `host-process.ts` 没有探活）。
5. Host/应用重启后默认先展示恢复摘要，由用户确认继续；网络重连无需用户确认且不触发重执行。§8.5 的受限自动续跑（前台 ∧ Host 崩溃而非应用重启 ∧ 一次自动重启成功 ∧ 准入全过 ∧ 无缺 result 的写入 ∧ 不需新审批）作为默认关闭的 HuaAnWork 设置项提供，开启后仍有持久横幅与撤销入口。
6. 外部副作用未知时宁可等待核对，不盲目重试；取消不自动回滚。unknown 的范围按 §8.4 收窄：只读步骤派发前把执行会话切到内核执行的 `read-only` 沙箱并拒绝提权，中断后直接重试；`workspace-write` 步骤派发前记录工作区指纹，恢复时据此判定未发生/可按受管写入对账/unknown；真正保持 unknown 的只剩网络开启且可能外发的 shell、第三方 MCP/HTTP、指纹不可用的大工作区写入。沙箱模式是宿主写入、内核执行的事实，命令文本分类不是只读证明（上游没有只读命令分类器，§2）。
7. **任务总预算可按需续期，单步期限按操作配置，所有执行仍有有限上限**：可拆任务分步保存检查点；不可拆的超长操作由模型在调用时用上游已有的 `timeoutMs` 参数声明，HuaAnWork profile 把执行器 `maxTimeoutMs` 设为单步最大期限（待批 1800 秒），`tools/pre-execute` 校验 `timeoutMs ≤ min(当前步剩余期限, 任务剩余预算, maxTimeoutMs)`，超出则拒绝并给模型可自纠的原因，不统一卡在 20 或 30 分钟。计划 `budget` 超过初始 30 分钟时列入确认卡，**确认计划即确认预算**，续期是例外路径。Host 心跳 15 秒进入 suspect 只冻结派发并提示，升级终止仅在 60 秒无响应且承载活跃 run、或用户取消无法收敛时发生，无活跃 run 不终止。600 秒模型上限区分“无活动”与“输出过长”，后者不对同一 prompt 自动重试。保留预算版本、累计用量、监督及取消约束；§7.3 的存储上限仍独立生效。普通工具期限统一为 120 秒是对基座 bash 60 秒的配置变更，需随本条一起批准。

批准本 spec 后再编写带依赖和逐项验收映射的实施计划；本规格文件存在不代表功能已实现或验收已通过。
