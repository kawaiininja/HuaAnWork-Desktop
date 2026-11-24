# 专家团多智能体协作与 Artifact 交付设计规格

- 日期：2026-11-21
- 状态：已根据两轮 Gemini 方案评审完成源码核实与修订；书面规格待用户审阅；尚未实施
- 评审记录：[`2026-11-21-expert-team-design-review.md`](./2026-11-21-expert-team-design-review.md)
- 基线：外层仓库 `3ad0a10af7`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`
- 范围：HuaAnWork 桌面端“专家团”模块、成员与调度配置、会话内 `@专家团`、真实独立成员执行、审查返修、聚合状态，以及默认主 Artifact 交付
- 约束：产品实现只进入 `dsh-plugin-huaanwork/` 与必要的桌面自有共享包；不修改 `deepseek-harness/`，不调整子模块 pin，不改变普通 `@智能体` 的既有语义

## 1. 背景与结论

专家团用于需要多个专业角色协作的复杂任务。用户可以在“智能体”和“知识库”之间管理专家团，把本地创建或已安装的智能体包组成团队，为成员设置职责，并由当前会话主智能体根据任务和中间结果动态派工。

本设计不是单模型多角色扮演，也不是把多个智能体名字注入一段提示词。每个成员都启动真实、独立的子智能体，保留各自的配置、权限、运行状态和结果。主会话担任团长，通过桌面 Host 提供的受控工具调用成员；成员结果通过上游已有的 `delivery: 'caller'` 返回团长工具，而不是逐条自动唤醒父会话。

复杂任务的主要交付物默认是一份主 Artifact。会话消息只承担简短状态说明和入口；团长复用现有 `result_present` 提交主 Artifact，Host 以 Artifact 的实际提交结果判定交付是否成功，不能以模型已经写出总结为由显示成功。团队运行不再另设 `expert_team_finish`、模型自报 `outcome` 或 `teamRunId` Artifact 幂等域。

核心链路为：

```text
专家团定义与成员引用
        ↓
@team:<slug> + 当前任务
        ↓
Host 预检并冻结团队配置快照
        ↓
主会话团长 ⇄ expert_team_dispatch ⇄ 独立成员（caller 文本结果）
        ↓                         ↓
        └──── 可选审查 → 限次返修 ←─┘
        ↓
复用 result_present 提交主 Artifact，或直接输出会话汇总
        ↓
父会话回合收尾：Host 校验客观记录并自动结算终态
        ↓
聚合运行卡 + Artifact 卡 + 简短会话说明
```

## 2. 目标与非目标

### 2.1 目标

1. 在指定位置提供专家团列表、新建、编辑、启停和删除能力。
2. 允许从本地创建及已安装的智能体包中选择成员，并配置职责与输出要求。
3. 提供结构化的任务分配、执行顺序、审查与汇总选项，并允许当前会话主智能体在这些规则内根据中间结果动态派工。
4. 支持不审查、统一审查和逐成员审查，以及必要的限次返修、审查证据和结果版本追踪。
5. 支持在会话输入框检索并调用专家团，提供团队级与成员级状态、取消和错误反馈。
6. 默认生成一份主 Artifact；Artifact 未实际提交时不得把 Artifact 模式运行标为成功。
7. 成员沿用其智能体包原生工具集与沙箱边界；团队既不扩大包权限，也不以团队角色或默认只读配置剥夺包声明的脚本、HTTP 或 MCP 能力。
8. 复用现有智能体包、子智能体、运行投影、`result_present`、Artifact 存储与预览下载能力，不另建通用多智能体框架或第二条 Artifact 生产线。

### 2.2 非目标

- 不用单个模型模拟多个角色，不增加独立团长子智能体层。
- 不允许企业目录 legacy 智能体或“小工具”入团。
- 不提供人工终审暂停点；用户可随时终止，但流程不跨回合等待批准。
- 不提供通用 DAG 编辑器、任意条件分支、任意循环或定时触发。
- 不开放自定义 JSON Schema 编辑器，也不使用上游 `outputSchema` / `structured_output` 作为团队成员结果协议。
- 不允许成员各自直接创建 Artifact，不新增子智能体 Artifact 锚点。
- 不支持 PDF、Office、图片或其他二进制 Artifact 格式；成员间结果协议只提取 `type === 'text'` 的 ContentBlock，`reasoning` 仅作为思考元数据忽略，其它非文本负载明确报 `unsupported-output`，不静默拼入结果正文。
- 不做团队共享、发布、导入导出、跨设备同步或知识库关联。
- 不做跨 Host 重启自动续跑或团队运行明细恢复，不构建通用嵌套子智能体运行树。
- 不接入上游 experimental `agent-team`，不修改既有取消清理债项和 `subagent.maxDepth = 2` 默认值。

## 3. 已确认的产品与技术裁定

| 编号 | 裁定 |
| --- | --- |
| R1 | 首期即真实启动多个独立智能体，不采用单会话多角色模拟 |
| R2 | 采用主会话团长动态分派，不插入额外团长层，保留“主会话 → 成员 → 成员子智能体”的现有深度模型 |
| R3 | 成员仅允许本地创建及已安装启用的智能体包；排除 legacy 与工具条目 |
| R4 | 采用桌面 Host 编排器和团长受控工具；成员使用 `delivery: 'caller'` 返回结果 |
| R5 | 成员权限遵循包本位：沿用包原生工具集与沙箱边界，不设置团队级 `workspaceAccess`、派工级读写参数或团队读写锁，也不额外扩权 |
| R6 | 审查支持 `none / unified / per-member`；存在审查成员时默认统一审查，默认最多返修 1 轮，可配置为 0–2 轮 |
| R7 | 启用审查时，审查角色构成必审名单；技术失败、漏审或无法解析的审查结论均不能算通过，也不能折算为业务未解决项 |
| R8 | 默认交付一份主 Artifact；创建者可在团队配置中显式改用仅会话模式，单次调用不临时覆盖 |
| R9 | 主 Artifact 由父会话复用 `result_present` 统一提交并关联当前团队运行；成员不直接创建 Artifact，不另建 `expert_team_finish` |
| R10 | Artifact 模式的成功必须由 Host 存储事实确认，不能由模型文字声明替代 |
| R11 | 团队规模为 2–8 名成员；并发上限为 1–4，默认 2；每次运行最多 24 次派工工具调用 |
| R12 | 团队配置按运行启动时冻结；智能体版本按每次实际派工记录，不承诺整次运行成员版本一致 |
| R13 | 动态条件判断交给团长；系统只提供有硬上限的审查返修循环，不做通用工作流引擎 |
| R14 | 专家团定义仅属于当前桌面 profile，不做共享、同步或发布 |
| R15 | 普通 `@智能体` 保持兼容；专家团使用独立的 `@team:<slug>` 命名空间 |
| R16 | 团队运行采用纯内存权威投影和有界终态淘汰；会话消息与 Artifact 继续持久化，但不承诺 Host 重启后保留团队聚合卡、成员结果链或运行关联 |

## 4. 方案取舍

| 方案 | 优点 | 主要缺陷 | 结论 |
| --- | --- | --- | --- |
| A. 桌面 Host 编排器 + 团长工具 + caller 结果 | 支持真实成员、结构化简单规则、包原生权限、有限并行、轻量审查、硬预算、统一取消和复用 Artifact 收口；不改上游 | 需要改造桌面包派发入口并新增有界内存团队状态机 | **采用** |
| B. 串连现有 `@智能体` | 初期改动较少 | 每成员自动产生父会话结算；同会话只能一个包回合；并行、审查和返工难以强约束 | 仅适合流程验证，不作为正式设计 |
| C. 每成员独立用户会话 | 绕开现有每会话一个包回合限制 | 会话、权限血缘、运行卡、取消和结果归属分散，体验与实现均复杂 | 排除 |
| D. 引入上游 experimental agent-team | 可复用部分实验性概念 | 需要独立 selective review/PORT，桌面未接线，无法满足当前 Artifact 与权限契约 | 本期排除 |

## 5. 已核实现状与可复用契约

以下只描述当前基线；后续章节的新增行为不得倒读为现有能力。

| 现状事实 | 证据 | 对本设计的影响 |
| --- | --- | --- |
| 侧边栏由 React `View` 和固定 JSX 顺序驱动，当前依次包含智能体、知识库、插件市场 | `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:451,4094-4120` | 新模块沿用视图切换，不引入 URL 路由 |
| 当前 `@` 查询和发送只识别 ASCII slug，且只解析开头一个目标 | `dsh-plugin-huaanwork/src/client-huaanwork/logic/agentsLogic.ts:39-61` | 中文检索与 `@team:` 需要扩展词法，旧 token 保持原路径 |
| `session.send` 当前 `at` 只有 `name/clientMessageId`；顶层另有持久回合锚 | `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:136-182` | 需要增加目标类型，团队运行与 Artifact 共用顶层 `clientMessageId` |
| 当前 `followupId` 在 `dispatchAt` 之后才通过 `resolveFollowupClientMessageId(params)` 计算；顶层 ID 缺失时由 Host 生成 UUID | `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:478-527,1020-1028` | 团队分支必须把该计算提前且只执行一次，让运行、turn anchor 与 followup 共用同一非空 ID |
| 智能体包 dispatch 每会话只预留一个 `pendingTurns`，并写死 `delivery: 'parent'`；返回只有文本与 `afterIdle` | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:532-608,1098-1113,1164` | 团队并行与工具结果返回需要新增专用入口，不能伪造 sessionId 绕过；普通路径的签名、预留与返回契约不变 |
| 包运行已经拥有 run 创建、包版本、取消、结果观察和清理状态 | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:543-568,1127-1145`；`dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:21-55,66-80` | 成员继续复用该状态机，团队只增加聚合层 |
| 包 runtime 目前冗余绑定父会话键，MCP 也先挂父会话再移到预留子会话；实际工具执行按子会话查 runtime | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:778,901,1018-1078,1089`；`dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:251-263` | 团队路径必须直接按子会话绑定 runtime 与 MCP，不触碰父会话附件；普通 `@智能体` 不随之改名或改写 |
| 包请求通过进程级 `current` 单槽同步发布和消费，现有正确性依赖写槽与包装器入口之间没有 `await` | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:1093-1098`；`dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:685,901-909,991-999` | 这是脆弱约定而非已复现的活跃竞态；团队路径新增按预留 childId 索引的 Map，普通路径继续使用旧单槽 |
| 上游 MCP `serverName` 允许 1–32 字符，公开工具名最多 64 字符；非法或超长公开名会被规范化并附加哈希，注册冲突会回滚本代注册并可抛出 | `deepseek-harness/packages/mcp/mcp-client/src/index.ts:39-47`；`deepseek-harness/packages/mcp/mcp-client/src/tools.ts:44-54,67-86,145-159` | 团队后缀不能直接使用评审示例的 42 字符名称；必须限长、复用上游公开名规范化与实际 mounted.names、检测冲突，并保留普通路径工具名 |
| 上游 `SubagentActivationSpec` 原生支持 `parent | caller`，并暴露 `activation.result` | `deepseek-harness/packages/subagent/subagent/src/types.ts:30-59` | 团长工具可以等待结果，不需要新上游投递模式 |
| 上游对 caller 不发送父会话结算消息 | `deepseek-harness/packages/subagent/subagent/src/manager.ts:1186-1205` | 多成员不会各自额外唤醒主会话 |
| `SubagentResult.output` 是 `ContentBlock[]`：优先取最后一条非空助手消息，没有时取累计助手文本流，两者都没有时为 `[]`；`stopReason` 与输出分别返回 | `deepseek-harness/packages/subagent/subagent/src/types.ts:250-277` | 团队需要显式渲染文本并校验空输出，不能把上游字段直接当字符串 |
| 最终助手消息可以包含 `reasoning` 块；上游选择输出时不剥离它，但生成父会话文本通知时会只保留 text 块 | `deepseek-harness/packages/llm/llm/src/types.ts:137-150`；`deepseek-harness/packages/subagent/subagent/src/assistant-output.ts:32-58,67-75`；`deepseek-harness/packages/subagent/subagent/src/continuation-messages.ts:143-155` | 团队提取文本时忽略 reasoning，不能把它误判为不支持的内容负载 |
| 上游仅在工具 `isConcurrencySafe(args)` 返回 `true` 时进入并行池，其他情况及异常均 fail-closed 为 exclusive；并行池另受 `maxParallelToolCalls` 限制 | `deepseek-harness/packages/core/tools/src/index.ts:1304-1320`；`deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:113-133,199-206` | 团队派工显式声明并行安全，Host 信号量独立限制实际并发 |
| 上游 `maxActiveSubagents` 默认 8，是共享的子智能体容量配置 | `deepseek-harness/packages/subagent/subagent/src/index.ts:185-198` | 团队配置并发是上限而非保证，实际并行还受父会话工具池与全局剩余容量约束 |
| 上游 `outputSchema` 会注册 `structured_output` 并强制模型调用；未有效捕获时，自然完成会改为 `error` | `deepseek-harness/packages/subagent/subagent/src/manager.ts:897-902`；`structured.ts:19-29,75-107`；`activation.ts:150-161` | 团队不采用该协议，成员直接返回正常文本 |
| 包血缘 allow 对 `structured_output` 不豁免，桌面 policy 的已挂载工具集合与 `decide()` 显式分支也不包含它 | `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:24-32,113-140`；`packages/huaanwork-policy/src/decide.ts:92-146` | 原强制 `outputSchema` 方案会被现有护栏拒绝；不得通过静默放宽包血缘护栏来绕过 |
| 包基础 allow 含读工具、shell 和 subagent，按声明增加脚本、HTTP 和 MCP | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:153-188` | 团队沿用包原生工具集，不按团队或审查角色裁剪 |
| 包后代按血缘继承包 allow | `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:945-973` | 成员后代继续受同一包工具边界约束 |
| 按会话动态挂载的工具需要 `attached` 事实；`result_present` 与包 HTTP/脚本工具有显式放行，未知未挂载工具默认拒绝 | `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:24-32,248-278`；`packages/huaanwork-policy/src/decide.ts:132-146` | `expert_team_dispatch` 必须同时接入 `SESSION_ATTACHED_TOOLS` 与 `decide()`，避免默认档位逐次审批或未挂载调用被放行 |
| 产品默认委派深度为 2 | `dsh-plugin-huaanwork/src/profile.ts:113-127` | 主会话直接派成员，成员仍可有一层后代 |
| Artifact 仅支持 Markdown/HTML；摘要使用 turn 或 automation-run 锚点 | `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:392-417` | 团队仍使用 turn 锚点，不新增子代理锚点 |
| Artifact 写入已有 prepare/commit/discard、字节与 sha256 复核、原子 rename 和幂等裁决 | `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts:377-541` | 团队复用现有 `result_present` 与 ArtifactHost 存储协议 |
| 当前 Artifact 幂等作用域只有 tool 与 automation-run；tool 作用域使用 `callId` | `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts:46-64,122-141,455-495` | 团队直接复用 `{ kind: 'tool', callId }`，不新增 `teamRunId` 幂等作用域 |
| 单 Artifact 为 5 MiB，每会话最多 100 个；超限拒绝；读侧复核正文与摘要 | `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts:26-29,254-283,321-349,467-473` | 主报告超限需调整重试，不能静默截断 |
| 普通父会话 `result_present` 已提供 Artifact 提交、事件与正文抑制，并在高级来源 `agent/inbox/claimed` 时同步挂载 | `dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts:77-117,149-166`；`dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:99,366-373` | 团队复用同一工具；启动后再摘除会被 claim 复活，因此必须在 claim 入口按团队交付模式门控 |
| 完整清理时序是 `scheduleDetachAfterIdle` 先等待第一次 `acceptedAgent.whenIdle()`，再进入 cleanup 执行 `afterIdle`，随后第二次 `whenIdle` 主要为旧 `delivery: 'parent'` 摘要唤醒而等待，最后 `releaseOnce`；`whenIdle` 会在新 activity 出现时继续等待 | `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:195-224,500,568-588`；`deepseek-harness/packages/core/agent-loop/src/agent.ts:225-242,252-263,384-397`；`deepseek-harness/packages/goal/goal-round-driver/src/index.ts:145-180,223-241,274-300` | 第一次 `whenIdle` 已覆盖父回合 caller 工具，但可能包含 goal 续拍；团队必须在当前 `turn/end` 同步封闭并结算，`afterIdle` 只做清理兜底 |
| `session.cancel({ sessionId })` 经 `cancelAgent` 同步取消父 agent 与包 activeTurns；bridge 另观察 `turn/end: aborted` 和 `agent/error: isAbortError` | `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:686-705,1371-1379`；`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:217-224,266-281` | 团队在 cancelAgent 接入 `cancelBySession`，bridge 仅作其它 cancel 来源的幂等兜底；queueItemId 路径不取消活动运行 |
| 会话事件包含带 `seq` 的 `tool/result`，bridge 的 token 流则覆盖整轮文本；`snapshotEvents()` 已禁止新增生产调用 | `deepseek-harness/packages/core/session/src/repair.ts:131-143,157-183`；`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:193-201,305-312`；`deepseek-harness/packages/core/session/README.md:60-64` | 团队通过本轮 `session/event` 追踪最后工具结果后的 text，不用整轮 token 或新增同步快照读取 |
| 现有子智能体运行是纯内存权威状态机，终态按父会话和全局有界淘汰 | `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:51-54,180,232-250` | 团队运行采用同构内存投影，不单独持久化半套运行历史 |
| 知识库仍为占位视图 | `dsh-plugin-huaanwork/src/client-huaanwork/KnowledgeBaseView.tsx:3-13,19-35` | 首期不存在可复用的知识数据契约 |

明确新增而不存在的能力包括：团队定义存储、团队运行协调器、同会话受控多成员并行、团队工具租约、按子会话隔离的包请求与 MCP 挂载、结构化调度规则、结果版本链、轻量审查标记解析、团队级取消、`result_present` 团队交付门控与运行关联，以及有界内存团队运行投影。

## 6. 总体架构与组件边界

实现位于桌面自有源码树，逻辑组件如下：

1. **专家团定义存储**
   - 校验定义、原子读写、启停、删除和可用性计算。
   - 不读取或修改成员包内部配置，不复制 persona 作为团队事实源。
2. **团队运行协调器**
   - 管理 `teamRunId`、配置快照、24 次派工预算、并发信号量、结果链、审查状态、终态、交付封闭与主 Artifact 关联。
   - 采用纯内存权威状态机和有界终态淘汰，不持久化运行快照，不在 Host 启动时反查 Artifact 或恢复执行。
   - 不复制成员 run 状态机。
3. **团长工具桥**
   - 在团队回合 claim、首步工具快照之前挂载 `expert_team_dispatch`，并按交付模式配合 `result_present` 的现有挂载入口。
   - 校验父会话、回合锚与团队租约，调用包派发适配层并返回 caller 文本结果。
   - 在回合结算点失效并摘除团队附件；非团队回合也对称清理遗留团队附件，不能只依赖正常 idle 路径。
4. **智能体包派发适配层**
   - 新增团队专用 `dispatchTeamMember`，暴露 activation/result 并使用 `delivery: 'caller'`，不传 `outputSchema`；普通 `dispatch` 的签名、`pendingTurns`、parent 投递和 `afterIdle` 行为保持不变。
   - 在创建 runtime 前预留 `reservedChildId`，runtime registry 与 MCP 附件直接绑定该子会话，不绑定或临时挂载父会话。
   - 团队 MCP `serverName` 使用团队路径专属的子会话后缀并检测活动名冲突，总长不得超过上游 32 字符；可采用“slug 截断至 22 字符 + `__` + 8 位子会话后缀”。公开工具名继续由上游 `publicToolName(serverName, rawName)` 生成：非法字符或超过 64 字符时沿用其规范化与 12 位哈希，不自行截断 rawName，也不额外拒绝长名。包 allow 与展示必须使用实际 `mounted.names`，不得按原 rawName 手工拼接；真实注册冲突 fail-closed。普通 `@智能体` 的模型可见 MCP 工具名不变。
   - 团队请求写入 boot 注入的 `Map<reservedChildId, AgentPackageSubagentRequest>`；`startActivation` 包装器先按 `specChildId` 精确消费该 Map，再回落普通路径旧单槽，清理使用请求身份守卫。
   - provider 可以忽略预留 id 并返回不同的 `activation.childId`；不得假设二者一致或静默重键请求 Map。请求 Map 只以 reservedChildId 为键，启动失败时删除该未消费键；按现有契约为实际 childId 补挂 runtime、附件和血缘，这三类绑定与附件的清理同时覆盖 reserved 与实际 childId，包装器原有 childId 门控行为不变。
5. **RPC 与事件投影**
   - 提供定义 CRUD、可调用列表、运行快照、团队取消和变更事件。
   - 客户端以 Host `generation + revision` 对账，断连时冻结；同一 Host generation 内重连以内存快照为准，Host 重启后不重建团队运行卡。
6. **客户端模块**
   - 列表与结构化编辑器、纯函数校验、中文 `@` 检索、聚合运行卡和 Artifact 入口。
   - 成员行复用现有子智能体摘要，右栏复用同一团队投影。

所有跨模块输入使用稳定 ID，不使用显示名称作为权限或结果归属依据。

## 7. 信息架构与页面设计

### 7.1 侧边栏

在“智能体”与“知识库”之间插入“专家团”，固定相对顺序为：

```text
智能体 → 专家团 → 知识库
```

其余既有导航项（包括“自动化”和“插件市场”）及其顺序不变。“专家团”使用现有视图切换模式。列表与编辑器通过页面内部选中状态切换，不增加 URL 深链。

### 7.2 专家团列表

顶部包含标题、说明、搜索框和“新建专家团”。卡片展示：

- 名称、描述、适用场景；
- 成员数、任务分配与执行顺序、审查模式；
- 默认 Artifact/仅会话；
- 可用状态及原因。

操作为编辑、停用/启用和删除。状态包括：

- **可调用**：已启用且定义、成员均有效；
- **已停用**：保留定义但不进入可选 `@` 结果；
- **配置不完整**：必填字段、角色或审查配置不满足要求；这是损坏/旧版本定义与编辑草稿的防御性展示，正常新建和编辑保存不得产生该状态的已保存定义；
- **成员失效**：一个或多个成员已停用、移除、撤销或损坏。

### 7.3 编辑页

使用完整页面，分为基本信息、成员与职责、调度规则、审查与汇总四个区域。新建和编辑复用相同表单；离开时有未保存确认。

- 调度规则提供“按职责分配 / 全员独立处理”“顺序执行 / 并行执行 / 动态安排”的结构化选择、1–4 的并发上限和可选补充说明；选择顺序执行时并发控件固定按 1 生效。
- 成员列表支持上下排序；每个成员配置执行/审查角色、职责和可选输出要求。
- 审查区域提供“不审查 / 汇总前统一审查 / 逐成员结果审查”、0–2 轮返修上限和可选审查标准。没有审查成员时只能选择不审查；存在审查成员的新团队默认统一审查。
- 汇总区域提供 Artifact/仅会话、Markdown/HTML 和三种报告组织方式；仅会话模式隐藏 Artifact 格式。

首期不提供“试运行”按钮、复制团队、导入导出或发布入口，统一通过真实会话调用验证。

## 8. 核心数据对象

以下为逻辑字段，具体 TypeScript 声明以实现计划为准。

### 8.1 专家团定义

```ts
type ExpertTeam = {
  schemaVersion: 1
  id: string                    // UUID
  slug: string                  // 团队命名空间内唯一，创建后不可改
  name: string                  // 1–40 字符
  description: string           // 1–200 字符
  scenarios?: string            // 最长 500 字符
  enabled: boolean
  members: ExpertTeamMember[]   // 2–8；列表顺序是 sequential 的执行顺序
  orchestration: {
    assignmentMode: 'by-responsibility' | 'broadcast' // 默认 by-responsibility
    executionOrder: 'sequential' | 'parallel' | 'dynamic' // 默认 parallel
    maxParallel: 1 | 2 | 3 | 4  // 默认 2；sequential 的有效执行并发固定为 1
    instructions?: string       // 可选分发与顺序补充说明，最长 500 字符
  }
  review: {
    mode: 'none' | 'unified' | 'per-member' // 有 reviewer 时默认 unified，否则为 none
    criteria?: string            // 可选审查标准，最长 500 字符
    maxRevisionRounds: 0 | 1 | 2 // 默认 1；mode = none 时忽略
  }
  summary: {
    delivery: 'artifact' | 'message' // 默认 artifact
    artifactFormat: 'markdown' | 'html' // 默认 markdown
    mode: 'integrated' | 'by-member' | 'integrated-with-appendix' // 默认 integrated
    instructions?: string        // 可选汇总重点，最长 500 字符
  }
  createdAt: string
  updatedAt: string
}
```

`slug` 只要求在专家团命名空间唯一；`@team:` 前缀消除与智能体 slug 的歧义。显示名称可修改，调用名不可修改。结构化枚举提供开箱即用的简单规则，`instructions` 只补充任务相关的分配与顺序要求，不能覆盖成员角色、预算、审查或交付硬约束。

### 8.2 成员

```ts
type ExpertTeamMember = {
  memberId: string              // 团队内 UUID
  agentRef: {
    source: 'local' | 'catalog'
    slug: string
  }
  role: 'executor' | 'reviewer'
  responsibility: string        // 必填，说明负责与不负责的范围
  outputInstructions?: string
}
```

约束：

- 同一 `source + slug` 在同一团队只能出现一次。
- 执行与审查角色不重叠，审查员不能审查自己的执行结果。
- 至少一名执行成员；`review.mode !== 'none'` 时至少一名审查成员，没有审查成员时只能使用 `none`。
- 成员显示名和版本是解析时信息，不作为持久引用主键。
- 编辑器支持上下移动成员；该顺序是 `sequential` 模式下执行成员的默认派工顺序，审查员在每轮审查中可按有效并发上限并行。

### 8.3 团队运行

```ts
type ExpertTeamRun = {
  teamRunId: string
  parentSessionId: string
  clientMessageId: string
  teamId: string
  teamSnapshot: ExpertTeam
  status:
    | 'running' | 'stopping'
    | 'completed' | 'completed_with_issues'
    | 'partial' | 'failed' | 'stopped'
  results: ExpertTeamResult[]
  primaryArtifactId?: string
  primaryArtifactCallId?: string // Host 内部识别同一主报告调用的幂等重放
  artifactStatus: 'not-required' | 'pending' | 'created'
  deliverySealed: boolean       // 主 Artifact 首次 commit 成功后封闭新派工与新主报告
  unifiedRevisionRounds: number // unified 已开启的返修周期；per-member 按结果链另算
  dispatchAttempts: number
  startedAt: string
  endedAt?: string
  failure?: string
  revision: number
}
```

`status` 是整体状态；当前“规划中、执行中、审查中、返修中、汇总中”等文案由实际活动派生。动态团队允许执行与审查活动交错，不能把单一显示阶段当成新的顺序约束。

`artifactStatus` 在仅会话模式恒为 `not-required`，Artifact 模式从启动起为 `pending`，仅在 `result_present` commit 成功且运行关联完成后改为 `created`。Artifact 写入失败不新增终态或独立 `failed` 状态；错误通过工具结果和运行事件披露，团长可在当前回合内修正后重试，回合结算时仍未关联主 Artifact 则按不完整交付处理。

`revision` 是单个运行的内存投影版本；Host `generation` 属于 `runList` 快照与事件 envelope，不是持久运行字段。

### 8.4 成员结果

```ts
type ExpertTeamResult = {
  resultId: string
  dispatchId: string            // 产生该结果的 expert_team_dispatch 工具 callId；resultId 另作结果版本身份
  memberId: string
  agentRef: ExpertTeamMember['agentRef']
  packageVersion: string
  memberRunId?: string          // 实际创建成员 run 后填写
  kind: 'execute' | 'review' | 'revision'
  inputResultIds: string[]
  supersedesResultId?: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped'
  output?: string
  reviewVerdict?: 'pass' | 'revise'
  reviewError?: 'invalid-verdict'
  startedAt: string
  endedAt?: string
  error?: string
}
```

结果通过 `inputResultIds` 与 `supersedesResultId` 构成扁平版本链。被替代结果保留用于追踪，默认不进入最终汇总。`output` 是 Host 从 `SubagentResult.output` 的 `ContentBlock[]` 渲染出的成员文本，不是把上游字段直接当成字符串，也不包含 `structured` 值或 Artifact 正文；主 Artifact 只保存 `primaryArtifactId`。

首期文本协议按原顺序以空行拼接 `type === 'text'` 的块，并忽略 `type === 'reasoning'` 的思考元数据：reasoning 不拼入结果正文，也不视为错误，`reasoning + text` 可正常通过。出现既非 `text` 又非 `reasoning` 的块（包括 `image`、`file`、`tool-call` 或未知块）时，即使同时包含文本，也记 `error = 'unsupported-output'`。过滤后文本没有非空白内容时记 `error = 'empty-output'`，因此纯 reasoning 或无文本块也属于空输出。这两种团队成员结果的 `status` 都必须置为 `failed`（不是改写上游 `stopReason`），不能进入必审、主报告或正常完成判定。审查结果同样先通过文本校验，再满足末行标记要求。“有效执行结果”指 `status = 'completed'`、渲染文本含非空白内容且没有结果级 `error` 的 `execute` / `revision`。

### 8.5 存储与可用性

- 团队定义存放在当前 profile 的桌面自有 `expert-teams` 数据目录，使用原子写入。
- 单个定义损坏时该团队 fail-closed，不影响其他团队加载，也不自动覆盖原文件。
- 可调用状态不落盘，每次由定义和成员实时状态计算。
- 运行中的配置使用快照；编辑和停用只影响新调用。
- 活动运行期间禁止删除团队，需先终止。
- 删除团队不删除智能体、会话或历史 Artifact。

团队运行注册表与 `SubagentRunRegistry` 同构，采用纯内存权威状态机：

- 活跃运行与近期终态只存在内存中；每父会话最多保留 20 条终态，全局最多 100 条终态，活跃记录不因容量淘汰。淘汰运行卡不删除会话消息或 Artifact。
- 不写运行快照，不合并高频磁盘写，不在 Host 启动时把旧运行改为 `interrupted`，也不按 `teamRunId` 反查 Artifact 补记关联。
- 同一 Host generation 内，客户端断连重连通过 `expertTeam.runList({ sessionId })` 的 `generation + revision` 快照对账。
- Host generation 变化后，旧运行快照全部失效；客户端丢弃旧聚合卡并禁用其操作，不保留虚假的 `running` 或新增 `interrupted` 墓碑。重开历史会话不重建团队聚合卡、成员结果链或审查链。
- 用户消息、助手汇总消息和已提交 Artifact 卡仍由既有会话与 Artifact 存储持久化。若 Host 在 Artifact commit 后、运行结算前退出，Artifact 卡保留但没有可恢复的团队运行关联，这是本简化明确接受的残态。

## 9. 创建与成员管理流程

### 9.1 基本信息

1. 填写名称、描述和适用场景。
2. 自动生成可修改的调用名，首次保存后锁定。
3. 展示实际 token `@team:<slug>` 及中文显示名称。
4. 选择默认交付方式；Artifact 模式下选择 Markdown 或 HTML。

### 9.2 添加与维护成员

成员选择器只列出当前本地创建或已安装、已启用且健康的智能体包，展示名称、来源、版本和描述。

添加后必须设置角色和职责，可补充输出要求。已入团但后来失效的成员保留原位并显示原因，可重新选择或移除；不得静默替换为同名智能体。

新建时必须配置完整且所有成员有效。编辑已有团队时允许保存其他字段，但只要仍有失效成员，团队就处于不可调用状态。

### 9.3 保存前摘要

保存前集中展示：

- 成员及执行/审查角色；
- 分配模式、执行顺序、并发和调用预算；
- 各成员包原生脚本、HTTP、MCP 等能力及既有沙箱边界；
- 审查模式、必审名单与返修上限；
- 默认交付格式和 `@team:` 调用名。

停用不删除定义；删除需二次确认，并在有活动运行时拒绝。

## 10. 调度、权限、审查与汇总规则

### 10.1 结构化简单规则与动态派工

结构化规则给团长明确的规划约束，但不把流程变成固定 DAG：

- `assignmentMode = 'by-responsibility'`：团长根据执行成员的 `responsibility` 拆解任务，只派发完成当前任务所需的执行成员，不要求全员出场。
- `assignmentMode = 'broadcast'`：团长把同一完整用户任务派给每名执行成员，由各成员从自身职责视角独立处理。进入审查或最终交付前，每名执行成员必须至少有一份有效的首轮 `execute` 结果；缺员时只能按不完整流程收口。
- `executionOrder = 'sequential'`：首轮执行派工按成员列表顺序进行，有效执行并发固定为 1；后序成员必须通过 `inputResultIds` 引用前序有效结果。审查与返修按审查模式触发，不伪装成首轮执行顺序。
- `executionOrder = 'parallel'`：无依赖的执行派工可并行；引用尚未完成的前序结果时不得启动，Host 只接受已归属本运行且已完成的结果引用。
- `executionOrder = 'dynamic'`：团长可先串行或并行派发初批成员，再根据中间结果决定后续顺序与补派，仍受成员、预算和并发硬边界约束。

`orchestration.instructions` 可表达“先抽取事实，再做法律判断”“高风险时增加法务复核”等补充要求。自然语言补充不能放宽结构化规则，也不得被宣称为可静态验证的 DAG。本设计不支持用户自由绘制的节点依赖、通用条件分支或任意循环。

### 10.2 调用预算与并发

- 每次团队运行最多 24 次 `expert_team_dispatch` 工具调用；到达运行协调器的调用无论最终成功、失败、校验拒绝或容量不足都计入，防止错误重试形成无限循环。
- `maxParallel = 1` 表示团队内所有派工完全串行；2–4 允许团长并行调用不同成员。实际并行上限取团队 `maxParallel`、父会话 `maxParallelToolCalls` 和上游剩余子智能体容量的最小值，配置值不是并行保证。
- `expert_team_dispatch` 的 `isConcurrencySafe(args)` 对所有合法派工返回 `true`，由 Host 团队信号量执行实际并发限制；不再按读写派工设置 exclusive 屏障或团队读写锁。
- 上游 `maxActiveSubagents` 默认 8，为本机共享容量；其他会话和系统技能也会占用。团队并发额内的等待由协调器排队，上游容量不足则返回明确可重试错误并计入派工预算，不做隐藏无限重试。
- 同一成员在同一团队内不能同时执行两个任务。团队成员等待队列中的派工尚未创建成员 run，也不占成员并发位；等待中只能通过 `expertTeam.cancel` 取消，不能使用 `subagent.cancel` 定位。就主 Artifact 提交校验而言，“在途派工”同时包括等待队列与已创建但尚未 settle 的成员 run。
- Host 不自动重试失败派工；团长可在剩余预算内决定是否显式补派或重试。不同会话之间不新增工作区写锁，沿用现有多会话风险边界。

### 10.3 包原生权限与父会话工具面

- 成员工具白名单直接沿用 `composeAgentPackageToolAllowList` 的结果，包括包基础读工具、平台 shell、`subagent`，以及按包声明存在的 `agent_skill_run`、`agent_http` 和 MCP 工具。审查角色不再被额外裁剪为只读。
- 成员的 HTTP、MCP 与技能脚本子进程继续使用包现有 `sandbox.confine` 和工作区根；后代按现有血缘规则继承同一包 allow。团队既不增加工具，也不删除包已经声明的能力。
- 不设置团队级 `workspaceAccess`、派工级 `access` 或“只读 shell”参数分析。主 Artifact 写入独立 Artifact 存储，不属于工作区写权限。
- 父会话保留调用前已有的普通工具面，只额外获得本运行专属的 `expert_team_dispatch` 租约；`result_present` 按 §12.4 的团队交付规则挂载和校验。团队调用本身不改变父会话其它工具权限。
- 团队租约释放失败时必须使该租约失效并拒绝后续团队派工，不得为恢复工具面而静默放宽；普通父会话工具不按团队运行做临时全局降级。

### 10.4 审查标记、审查模式与返修

成员结果使用正常 Markdown/文本，不向 `startActivation` 传入 `outputSchema`。审查任务提示词固定要求最后一行单独输出以下之一：

```text
[VERDICT: PASS]
[VERDICT: REVISE]
```

Host 只解析去除空白后的最后一个非空行，且必须与上述标记之一完全一致。缺失、无法识别或同一行包含其它内容的审查结果记 `reviewError = 'invalid-verdict'`，`reviewVerdict` 留空；成员本身仍可正常 `completed`，但该审查不具备通过效力。无效结论属于技术缺失，不得直接折算为 `revise`。团长可在派工预算内重新派发同一审查；对同一审查成员和同一组规范化 `inputResultIds`，最新审查尝试决定该次审查的技术完整性，旧尝试保留用于追踪。

Host 以规范化 scope 判定审查义务：**当前有效结果集**是所有未被后续**有效**结果的 `supersedesResultId` 指向的有效 `execute` / `revision`，按 `resultId` 排序去重。`unified` 审查省略 `inputResultIds` 时，Host 在工具调用入口自动填充该全集；模型显式传入时必须与全集完全相等，不能只送修订子集。全集为空时不得发起 `review`，团长应先取得有效执行结果。Host 将实际解析后的 ID 写入派工提示词、结果记录与工具返回，入口之后不由模型改写。`per-member` 的 scope 必须是当前被审目标的单个 `resultId`，不能省略。成员在审查途中产生新执行或返修结果时，旧 scope 不再代表当前义务，必须按新 scope 重新审查。同一审查成员与同一规范化 scope 的最新审查尝试决定该 scope 的技术完整性，统一返修周期则由 `unifiedRevisionRounds` 与当前 scope 共同识别。

三种审查模式的含义如下：

1. `none`：不启用独立审查，不允许 `kind = 'review'` 或 `'revision'`；至少一个有效执行结果才可能正常完成。
2. `unified`：团长完成本轮计划的执行派工后，把所有当前有效 `execute` / `revision` 结果的 `resultId` 一并交给每名审查成员各审查一次。任一轮全员有效审查中出现 `revise` 且统一返修额度未用尽时，团长必须根据意见选择至少一名相关原执行成员返修，可在同一返修周期返修多名成员；Host 不从自然语言意见猜测责任成员。全部审查成员随后重新审查更新后的完整结果集，形成一个可确定的“统一审查—返修周期”。
3. `per-member`：每个未被替代的有效 `execute` / `revision` 结果分别由全部审查成员审查，每次审查的 `inputResultIds` 只含该目标结果。任一有效审查要求修改且该结果链额度未用尽时，由原执行成员返修；新结果重新交给全部审查成员审查该成员结果。

共同约束为：

- 审查员之间可按有效并发上限并行，不做隐式多数投票；所有必审成员都有有效结论后才算完成该次审查。
- 返修只能响应当前有效 `revise`。返修输入包含原任务、原结果和该轮全部有效审查意见，并设置 `supersedesResultId`。被替代结果保留用于追踪，默认不进入后续审查和最终汇总。
- `unified` 以完整审查后出现 `revise` 所开启的返修周期计数，首份返修进入新周期时增加 `unifiedRevisionRounds`，同周期可有多份返修，下一次全员统一审查关闭该周期；`per-member` 按被返修结果链中的 `revision` 次数计数。两种模式分别最多使用 `maxRevisionRounds` 轮，全运行仍受 24 次派工预算约束。
- 额度为 0 或已经用尽时，有效但未解决的 `revise` 可进入 `completed_with_issues`。额度尚未用尽却未执行必要返修、审查技术失败、漏审或审查标记无效，只能进入 `partial`，不能称为“完成但有未解决项”。

### 10.5 汇总方式

- `integrated`：综合结论，默认。
- `by-member`：按成员组织结果与审查状态。
- `integrated-with-appendix`：综合结论并附成员结果。

`summary.instructions` 决定报告重点。无论选择哪种方式，失败、遗漏、未解决分歧和审查未通过项必须显式呈现。Host 校验流程事实与交付事实，不声称能验证报告文字是否忠实覆盖每一项成员输出。

## 11. 会话中的 `@` 交互

### 11.1 检索与选择

输入 `@` 后，菜单增加“专家团”分组，与智能体并列：

- 按中文名称、调用名、描述和适用场景检索；
- 复用现有智能体图标并显示“专家团”文字标签，不新增图形资产；同时展示成员数、分配/顺序、审查和 Artifact 标识；
- 保留上下键、Enter/Tab 和 Esc 行为，并正确处理中文输入法组合态；
- 只有可调用团队可选，失效原因在管理页查看。

选择后插入以下 token 与一个尾随空格：

```text
@team:<slug>
```

草稿识别到有效 token 后，在输入框附近显示团队名称、成员数、分配与执行顺序、审查和交付方式摘要。

### 11.2 调用限制

- `@team:<slug>` 后必须有非空任务正文。
- 一条消息仍只有开头一个调用目标；正文中的其他 `@` 只是普通文本。
- 不支持一个团队与额外智能体混用，也不支持多个团队同时调用。
- 原 `@<agent-slug>` 的解析与发送路径保持不变。
- 同一父会话只能有一个活动团队；第二个团队调用明确拒绝，不静默排队。不同会话可调用同一团队，仍受容量限制。

### 11.3 发送参数

`session.send` 的 `at` 增加目标类别。专家团目标为：

```ts
at = {
  kind: 'expert-team'
  name: string
}
```

旧智能体的 `at.name/clientMessageId` 保持原样，`kind` 缺省时按旧智能体处理。专家团是新能力，不携带伪造的旧卡兼容字段。

顶层 `clientMessageId` 仍是本次用户回合的持久锚。团队运行卡与主 Artifact 都直接使用该顶层锚；非 UI RPC 调用省略它时，Host 使用 `resolveFollowupClientMessageId(params)` 生成一次 UUID，并在团队运行、turn anchor 与 followup 间复用，不分别生成。

Host 收到后重新校验团队与成员，不信任客户端缓存；typed token 不得回退为同名智能体调用。

## 12. 运行协议

### 12.1 启动与附件时序

1. Host 校验团队已启用、定义完整、全部成员可运行。
2. 预检通过后，将现有 `resolveFollowupClientMessageId(params)` 调用提前到团队派发前且只执行一次，得到 `followupId`。创建 `teamRunId` 和配置快照，以 `followupId` 同时写入 `teamRun.clientMessageId`、按现有高级用户回合来源调用的 `turnAnchors.register` 和后续 `agent.followup({ id })`，初始化 `artifactStatus`、`deliverySealed = false` 与 `unifiedRevisionRounds = 0`。运行必须在 `agent.followup` 之前登记，供 claim 处理器识别当前回合。
3. `agent.followup` 触发 `agent/inbox/claimed` 时、首步工具快照之前，为团队回合挂载 `expert_team_dispatch`。Artifact 模式保留并挂接现有 `result_present`；仅会话模式在该同一入口不挂 `result_present`，不能先在启动期挂载再依赖事后摘除。
4. 非团队回合的 claim 必须对称移除遗留团队附件；团队回合结束时还要使租约失效并摘除附件，执行体继续以租约和附件双重校验兜底。
5. 注入用户任务、成员名册、职责、结构化调度规则、审查标记和交付要求。仅会话模式明确指示团长不要调用 `result_present`，直接输出最终汇总。

团队发送分支必须像现有 `@` 分支一样登记自己的 `afterIdle`，用于清理兜底并延迟释放回合名额；当前 cleanup 在 `afterIdle` 缺失时会直接释放，团队不得复用该立即释放路径。当前团队 `turn/end` 负责 §12.4.2 的同步封闭与结算，`afterIdle` 负责成员清理、事件观察器释放和异常兜底，两者不得混为同一个时点。

运行创建时还要登记仅匹配当前 `parentSessionId` 的 `session/event` 观察器，并在 `agent/inbox/claimed` 确认本轮 `followupId` 后激活，记录当前 turn 的边界、工具结果与助手输出，供 §12.4.2 的同步结算和最终助手汇总判定；激活前的旧回合事件一律忽略。观察器在当前 `turn/end` 结算后停止接收新 turn 的派工相关事件，在 `afterIdle`、followup 前异常和 Host teardown 时释放，不新增已弃用的同步 `snapshotEvents()` 生产调用，也不读取兄弟子会话事件。

预检失败时不创建运行、不启动成员，也不产生主 Artifact。运行创建后、`followup` 受理前发生异常时，必须在原地清理团队附件与本轮 pending anchor，并将运行置为 `failed`。同时必须将本轮 `afterIdle` 置回 `undefined`，或以一次性 settled 守卫保证 `finally` 中的 `scheduleDetachAfterIdle()` 不重复结算；`acceptedAgent` 缺失时该调度会以已解决的 Promise 立即进入 cleanup，不能假定异常路径不会触发回调。

`expert_team_dispatch` 同时加入 `huaanwork-guardrails/policy.ts` 的 `SESSION_ATTACHED_TOOLS`，并在 `packages/huaanwork-policy/src/decide.ts` 使用与 `result_present` 相同的“已挂载即放行、未挂载即拒绝”显式分支。不得落入 default 在 `ask` / `smart` 档逐次弹审批，也不得让未挂载调用绕过租约。

### 12.2 成员上下文

团长可读取当前会话上下文。成员只获得：

- 团长填写的任务说明；
- 自身人设、职责和输出要求；
- Host 实际解析后的 `inputResultIds` 对应的已完成上游结果（模型显式提供，或 unified 审查由 Host 自动填充）；
- 审查任务所需的轻量结论标记要求。

不自动向每个成员广播完整父会话或全部兄弟结果。团队派工输入采用固定字节预算：`task`、渲染后的引用结果、成员职责和输出要求合计最多 256 KiB（UTF-8，多字节字符按实际字节计），成员包 persona 继续使用其独立上限。超过团队预算时 Host 在启动成员前拒绝并提示减少引用；即使未超字节预算，上游模型上下文拒绝也按成员失败呈现。任何路径都不得静默截断关键审查证据。

### 12.3 `expert_team_dispatch`

逻辑输入：

```ts
type ExpertTeamDispatchInput = {
  memberId: string
  kind: 'execute' | 'review' | 'revision'
  task: string
  inputResultIds?: string[]
  supersedesResultId?: string
}
```

Host 强制校验：

- 工具 `callId` 存在并记录为 `dispatchId`；Host 从 `exec.agent` 解析 `parentSessionId`，通过团队附件租约与回合锚绑定该父会话唯一活动运行，不要求模型传 `teamRunId`；运行未停止、未终态且 `deliverySealed = false`；
- 成员属于快照且角色匹配；`review` 只能派给 reviewer，`execute` / `revision` 只能派给 executor，`review.mode = 'none'` 时禁止 review 与 revision；
- 所有输入结果属于同一团队且已完成，返修替代关系及原执行成员匹配；`revision` 必须携带 `supersedesResultId`；
- 普通 `execute` 仅在重试同一成员先前失败或停止的 `execute` 时可携带 `supersedesResultId`，不得替代 review 或 revision，也不得把业务返修伪装成技术重试；该重试不消耗返修轮数，成功执行结果的业务修改必须走 `revision`；
- 结构化分配与顺序约束、审查模式及审查 scope：`unified` 省略 `inputResultIds` 时由 Host 在入口填充当前有效结果全集，显式传入必须与全集相等，空全集不允许 review；`per-member` 必须显式提供被审目标结果的单例集合；
- 派工预算、返修上限（`unified` 按 `unifiedRevisionRounds`，`per-member` 按被返修结果链的 `revision` 次数）、单成员并发和有效团队并发；
- 输入总字节与成员包实时可用性；不再校验 `access`、团队写锁或固定 `outputSchema`。

上述归属与参数校验在工具调用入口执行；涉及当前审查 scope、替代关系、顺序依赖、成员可用性、取消与交付封闭状态的校验，在出队启动成员前必须再次执行。`unified` 省略 ID 时也只使用入口已经解析并写入派工记录的 scope，出队发现当前全集已变化则明确失败，不在等待后静默换成另一组结果。等待期间其它状态变化同样按明确失败返回，不启动成员；该调用只在首次到达协调器时计一次预算。

`expert_team_dispatch` 的 `isConcurrencySafe(args)` 对所有参数返回 `true`，使合法调用可进入上游并行池；Host 团队信号量、顺序规则和单成员限制仍在执行入口独立强制，不能把工具声明当成唯一防线。

团队专用包派发入口使用 `delivery: 'caller'` 并等待 `activation.result`。返回团长的逻辑结果为：

```ts
type ExpertTeamDispatchResult = {
  resultId: string
  memberId: string
  agentSlug: string
  kind: 'execute' | 'review' | 'revision'
  inputResultIds: string[]      // Host 实际解析并用于本次派工的 scope
  status: 'completed' | 'failed' | 'stopped'
  output?: string
  reviewVerdict?: 'pass' | 'revise'
  reviewError?: 'invalid-verdict'
  error?: string
}
```

`output` 由 Host 将 `SubagentResult.output` 的 `ContentBlock[]` 渲染为首期文本协议，忽略 reasoning 元数据，不传 `outputSchema`，不挂载 `structured_output`，也不把缺少 JSON 的正常完成改判为 `error`。空输出与其它非文本负载按 §8.4 记技术失败；审查结果按 §10.4 解析最后一行标记。成员仍进入现有 run 投影，保留包版本、取消、错误和清理警告；成员不会自动发送父会话结算消息。

### 12.4 复用 `result_present` 与回合收尾自动结算

#### 12.4.1 主 Artifact 提交与封闭

Artifact 模式直接使用现有 `result_present` 工具、turn 锚、参数正文抑制、ArtifactHost begin/prepare/commit/discard、格式与字节校验、原子发布、读侧复核和 `artifact/created` 事件，不新增 `expert_team_finish` 或另一种 Artifact 卡。

团队在 `beginArtifactWrite` 之前对**新的主 Artifact 提交**增加以下校验；已登记 `primaryArtifactCallId` 的同一 `callId` 重放只进入现有幂等裁决与关联恢复路径，不按新提交拒绝：

- 当前调用匹配本父会话、本 `clientMessageId` 和本运行，状态为 `running`，未取消且尚未封闭；
- 至少一份有效执行结果，且没有仍在途的成员派工（包括等待队列）；
- `format` 与团队快照一致，尚无 `primaryArtifactId`；
- `broadcast` 团队不存在从未派工的执行成员；每项已经产生的必审义务都必须有有效结论或明确的失败、停止、无效标记记录，不能因一名审查员已失败就跳过其它从未派工的必审员；当前 `unified` 审查轮 / `per-member` 结果链仍有返修额度却未执行必要返修时，同样拒绝提交并返回可操作的团队流程错误；
- 上述技术失败证据不阻止团长提交如实披露问题的部分报告；最终仍由回合结算判为 `partial`，不能伪装成 `completed`。
- 当 `dispatchAttempts >= 24` 时，若已有至少一份有效执行结果、当前无在途派工（包括等待队列），豁免 `broadcast` 缺执行员、必审缺失与额度内必要返修这三类提交前拒绝，允许提交如实披露问题的部分 Artifact；运行归属、格式、取消与交付封闭校验不豁免，回合结算仍必须判为 `partial`。预算未耗尽时不得提前使用该豁免。

提交前拒绝发生在 ArtifactHost 之前，不改变 `artifactStatus`；团长可在剩余派工预算和当前运行状态允许时继续派工、审查或返修，也可修正交付参数。调用 `result_present` 表示团长选择最终交付；首次 commit 成功后立即设置 `deliverySealed = true`，后续新派工和不同 `callId` 的主 Artifact 提交均被拒绝，避免主报告生成后继续改变其输入事实。

prepare 完成后、进入 commit 前必须再次检查取消闩与团队租约：此时已取消则不再 commit，直接走现有 discard 清理暂存；一旦进入 commit，则按实际 commit 结果处理取消竞态，不把已提交 Artifact 删除或伪报为未创建。

成功路径的顺序固定为：

1. `commitPreparedArtifact` 实际提交成功；
2. 同步封闭团队交付并记录 `primaryArtifactCallId = callId`；
3. 调用幂等的 `noteSessionArtifact(sessionId, callId, artifact)`，以 commit 返回 `artifact.anchor` 的持久 turn `clientMessageId` 匹配本运行，再设置 `primaryArtifactId = artifact.artifactId` 与 `artifactStatus = 'created'`；
4. 按现有契约发送 `artifact/created`；`created: false` 重放不重复发送。

关联必须同时匹配父会话与 **Artifact 已提交 manifest 的 turn 锚**；首次提交和相同 `callId` 重放都以 commit 返回的持久锚为准，不能用 goal 续拍时的当前锚改挂到另一回合。锚不属于本运行时必须拒绝关联。取消与 commit 竞态下，已提交 Artifact 也要关联到尚未淘汰的对应运行，不能只接受 `running` 而丢失入口。关联失败不得回滚或伪报 Artifact 未创建：保留实际 Artifact 与事件，记录关联失败，运行最终只能按不完整交付处理。`created: false` 的同一工具调用重放也按同一持久锚执行关联，以覆盖“commit 已成功、关联尚未完成”的恢复路径。

Artifact 幂等继续只使用现有 `{ kind: 'tool', callId }`。同一 `callId` 重放由 ArtifactHost 返回原结果，不生成第二份；交付封闭后不同 `callId` 不得创建第二份团队主 Artifact。不新增 `teamRunId` 幂等域、`finishFingerprint`、`outcome` 握手或 3 次 finish 预算。Artifact 校验失败后，团长可在当前父会话回合的既有步数与工具限制内修正重试，不静默截断。

仅会话模式在 claim 时不挂 `result_present`，`artifactStatus` 恒为 `not-required`、`primaryArtifactId` 恒为空。团长直接输出符合 `summary.mode` 的非空最终助手文本；没有非空汇总时只能按不完整交付处理。

#### 12.4.2 回合结算点与终态

本规格所称**回合结算点**，是当前团队 turn 的 `session/event: turn/end`。该事件在 agent-loop 检查后续 inbox、进入 idle 和 goal 续拍之前写入，此时本 turn 的 caller 派工、`result_present` 与最终助手输出均已 settle。`scheduleDetachAfterIdle()` 的第一次 `whenIdle` 与 cleanup 的第二次 `whenIdle` 都只用于后续清理等待，不得把派工封闭推迟到其中任何一个之后；`afterIdle` 只承担成员清理和异常兜底。

收到当前 turn 的 `turn/end` 后，Host 必须同步使团队租约失效、摘除团队附件并封闭派工，再依据客观结果、审查、交付和取消记录结算；`reason.kind = 'aborted'` 视同父会话 abort，立即置取消闩。非取消路径同步计算一次终态；取消路径先同步置 `stopping` 并发起成员取消，再按既有清理预算在 `afterIdle` 中等待成员收敛后发布 `stopped`。终态或 `stopping` 运行拒绝 goal 续拍及其它迟到派工，结算完成后才允许下一条排队消息进入同一父会话。成员 runtime 的 dispose/清理确认可继续按既有子智能体预算完成，不把清理警告伪报为成功。

若已启动 turn 却未观察到其 `turn/end`，`afterIdle` 必须按事件缺失 fail-closed：立即封闭派工；取消路径仍按 `stopping → stopped` 处理，其它路径按现有记录结算为 `partial` 或 `failed`，不得继续等待第二次 `whenIdle`，也不得把后续 goal turn 当成本团队回合。followup 前异常仍按 §12.1 的原地失败与防重入规则处理。

仅会话模式的“非空最终助手汇总”由本轮事件观察器判定，不统计整轮 `token` 流：每收到一个 `tool/result` 就以该事件 `seq` 更新最后工具边界，只按顺序拼接其后 `assistant/message` 中的 `text` 块，忽略 reasoning；边界之前的过渡语、工具参数和工具结果都不算最终汇总。多条后续助手消息合并判断，任一有非空白文本即满足文本存在性。有效执行至少需要一次 dispatch，因此必有工具结果边界，不以整个最后 `step/start` 代替精确边界。缺少工具边界、事件 `seq` 或观察器事件不完整时 fail-closed，不从 token 流猜测成功；父会话 abort 则直接走 `stopped` 优先级。该判定只确认最终文本存在，不声称验证其语义质量。

终态按以下优先级裁定，不需要模型自报 `outcome`：

1. 已请求整团取消或父会话 abort：置 `stopping` 闩、拒绝新派工、取消在途成员，并在既有清理预算内等待收敛后为 `stopped`；不得因尚无成功结果而误判为 `failed`。
2. 没有任何有效执行结果：`failed`。
3. 存在以下任一技术性缺失：`partial`。
   - 仍有未被后续有效执行结果替代的执行/返修失败或停止，或同一审查 scope 的最新审查尝试失败、停止、缺失或标记无效；
   - `broadcast` 仍缺少执行成员的有效首轮结果；
   - 必审名单不完整，或当前 `unified` 审查轮 / `per-member` 结果链仍有返修额度却未执行必要返修；
   - Artifact 模式没有已关联的 `primaryArtifactId`，包括 Artifact 未提交或 commit 后关联失败；
   - 仅会话模式没有非空最终助手汇总；
   - 其它导致交付无法完整确认的协议错误。
4. 技术流程与交付均完整，但最新有效审查仍有 `revise` 且当前统一审查轮或对应结果链的返修额度已用尽：`completed_with_issues`。
5. 其余情况：`completed`。

Host 只根据流程与存储事实裁定状态，不验证报告正文的语义质量。主 Artifact 已提交后，缺少简短会话说明不影响 Artifact 本身的存在与可用性；但团队仍按上述规则决定整体状态。

## 13. 状态反馈与取消

### 13.1 聚合运行卡

团队卡包含：

- 团队名称、整体状态、当前活动、经过时间和终止按钮；
- 实际派工、进行中、完成、失败、审查和返修数量；
- 默认 Artifact 状态及主 Artifact 入口；
- 按实际派工顺序展开的扁平成员列表。

成员行展示执行/审查/返修、包版本、结果版本和现有子智能体状态，可查看文本结果、审查结论、无效标记错误及替代关系，不再展示团队只读/写入标签。

动态任务没有预定总步骤，使用不确定进度；不得显示虚假的百分比或预先编造的“2/5”。执行与审查并行时显示混合活动，不强制伪装成线性阶段。

主 Artifact 仍生成现有 Artifact 卡，团队卡只提供同一 ID 的入口，不复制正文或再创建一种预览。commit 已成功但运行关联失败时，Artifact 卡仍然可见，团队卡的 `artifactStatus` 保持 `pending` 并显示“主报告关联异常”；不得隐藏 Artifact 或把它展示为已完成团队交付。

### 13.2 整体状态

| 状态 | 用户含义 |
| --- | --- |
| `stopping` | 已受理终止，正在等待成员和团长终结；暂态连接断开不属于此状态 |
| `completed` | 结果和审查要求满足，配置的交付也已完成 |
| `completed_with_issues` | 交付完成，但存在已披露且返修额度已用尽的业务审查意见 |
| `partial` | 有部分结果，但技术执行、审查、最终文本或主 Artifact 关联不完整 |
| `failed` | 启动失败、无可用结果或协议失败 |
| `stopped` | 用户终止或父会话 abort，且运行已经终结 |

业务审查未通过与技术失败使用不同文案。未知成员停止原因、未知审查标记和未知 Artifact 关联结果不得被折算为成功。

### 13.3 取消与重连

- 单成员终止复用现有 `subagent.cancel`，结果返回团长，由团长决定补派、以 `execute + supersedesResultId` 重试失败的 `execute` 或部分结束。
- 团队取消使用精确的 `parentSessionId + teamRunId`，重复调用幂等。
- 团队取消或父会话 abort 后立即停止接受新派工，取消所有在途成员和团长回合；在既有清理预算内等待成员收敛后进入 `stopped`。清理警告继续展示，不虚报“已全部清理”，不新增强杀协议。
- `session.cancel({ sessionId })` 在现有 `cancelAgent` 入口先同步调用 `expertTeamRuns.cancelBySession(sessionId)` 置团队取消闩，再取消父 agent 与包 activeTurns。bridge 的 `turn/end: aborted` 与 `agent/error: isAbortError` 作为 hook/parent 等其它 `agent.cancel` 来源的兜底；两处调用必须幂等，不能重复清理或重复发布终态。
- `session.cancel({ queueItemId })` 只移除调度器中的用户排队消息，不取消当前活动团队。非 abort 的普通 agent error 不伪装成用户停止，仍按技术失败结算。
- 会话删除和 Host 正常退出同时触发团队取消；异常退出不承诺完成清理或写入终态。
- Artifact commit 前取消会丢弃暂存；commit 后取消保留已经可见的 Artifact，并在 `stopped` 运行中保留入口。
- 临时断连只冻结状态并禁用操作。同一 Host generation 内重连按 `runList` 内存快照对账；快照已淘汰的运行按 `run-remove` 语义移除，不删除持久 Artifact。
- Host 重启后不恢复团队运行，也不生成 `interrupted` 记录；旧聚合卡随失效快照移除，历史会话只保留既有的用户/助手消息和 Artifact 卡。

## 14. RPC 与事件逻辑面

新增桌面自有接口，名称可在实现计划中按现有路由惯例细化：

| 接口 | 用途 |
| --- | --- |
| `expertTeam.list/get` | 列表、详情与实时可用性 |
| `expertTeam.create/update` | 定义写入与字段错误 |
| `expertTeam.setEnabled/remove` | 启停与安全删除 |
| `expertTeam.invocableList` | 可选 `@` 团队及展示摘要 |
| `expertTeam.runList` | 按父会话获取同一 Host generation 的内存运行快照与 revision |
| `expertTeam.cancel` | 幂等终止整个团队 |

事件包括 `expertTeam/changed`、`expertTeam/run`、`expertTeam/run-remove`。现有 `agent.invocableList` 不改变含义，客户端合并专家团目录；现有 `subagent/run` 继续描述成员，团队事件只描述聚合状态。

终态团队卡采用与成员运行相同的有界淘汰思路；淘汰运行卡不删除会话 Artifact。

## 15. 与现有模块的关系

| 模块 | 关系 |
| --- | --- |
| 智能体 | 包仍是成员配置与版本的事实源；专家团只保存引用和职责，不提供第二个智能体编辑器 |
| 插件市场 | 已安装启用且未撤销的包可入团；更新、移除和撤销沿用现有在途取消语义，不增加团队发布 |
| 子智能体与进度面板 | 成员复用现有 run 投影和取消；团队只有聚合层，不建立任意嵌套树 |
| 技能 | 人设和技能正文按包规则加载，实际工具沿用包原生 allow 与沙箱，技能文本不能提权 |
| 知识库 | 当前为占位，首期不关联知识库，不增加 `@知识库` |
| 自动化 | 仅支持会话手动调用，不增加定时或事件触发 |
| Artifact | 主 Artifact 复用 `result_present`、tool-call 幂等、存储、事件、结果卡、预览、全屏和下载；团队只增加提交前校验、交付封闭与运行关联，成员仍不能产 Artifact |
| Profile | 团队定义按 profile 隔离，团队运行仅存在于对应 Host 内存，历史 Artifact 仍属于原会话 |
| 上游 Harness | 使用现有 caller 与深度契约，不使用 `outputSchema`，不修改子模块，不引入 experimental agent-team |
| HuaAnWork policy | `expert_team_dispatch` 同时登记 `SESSION_ATTACHED_TOOLS` 与 `decide()` 显式分支；包血缘 allow 与未挂载拒绝保持不变 |

## 16. 安全与一致性不变量

1. 任何派工都必须同时匹配父会话、回合锚、团队租约、团队快照成员和结果归属；终态或已封闭运行拒绝迟到派工。
2. 自然语言职责、成员输出和审查文本都只是数据，不能授予工具。审查标记只有经 Host 按固定位置解析并验证归属后才成为审查事实，模型不能自报整体终态。
3. 成员工具边界由包原生 allow、执行期血缘检查和沙箱实际强制，不能只在提示词中声明，也不因团队角色额外扩权或裁剪。
4. 团队不扩大成员或父会话原有工具、模型、工作区根或委派深度；普通 `@智能体` 的派发、工具名与单会话行为不因团队改造而放宽。
5. 团队并行的 runtime registry、MCP 附件和包请求必须按子会话隔离，不经过父会话单槽；reserved 与实际 childId 的清理都不能误删其它运行的绑定。
6. 所有派工与返修都有硬预算；错误重试不能绕过 24 次派工上限、当前审查模式的返修上限或有效并发限制。
7. 只有 Host 能写整体状态、结果替代关系、交付封闭和 `primaryArtifactId`。
8. Artifact 成功以实际 commit 为准，团队交付成功还必须有当前运行关联；模型声明不作为存储依据。commit 后必须封闭新派工和新的主报告提交。
9. Artifact 正文不得进入专家团 WebSocket 事件或 `ExpertTeamRun`；原始模型工具调用按上游会话持久化契约处理，但所有实时/历史 UI 与团队运行摘要只使用 Artifact ID，不额外复制正文。
10. 团队定义损坏、成员状态未知、审查标记未知、Artifact 关联未知或清理状态未知均 fail-closed，不猜测成功；无效审查标记属于技术缺失而非业务 `revise`。
11. 团队运行只以当前 Host 内存为权威；Host generation 变化后不得展示旧 `running`、伪造 `interrupted` 记录或反查 Artifact 重建结果链。

## 17. 关键边界场景

| 场景 | 设计结果 |
| --- | --- |
| 空调用 | 没有任务正文时禁止发送并提示补充 |
| 缓存中的团队已停用或删除 | Host 拒绝，不回退成智能体调用 |
| 非 UI RPC 省略顶层 `clientMessageId` | `resolveFollowupClientMessageId(params)` 只计算一次，团队运行、turn anchor 与 followup 共用生成的 UUID，不发生锚点错位 |
| 启动前任一成员失效 | 整团不启动，列出全部原因，不静默跳过 |
| 运行已创建但 `followup` 尚未受理即失败 | 原地清理并置 `failed`；清除 `afterIdle` 或以一次性守卫防止 finally 立即调度造成重复结算 |
| 启动后派工前成员失效 | 本次派工失败并计预算；团长可调整，最终按完整度结束 |
| 在途成员更新、移除或撤销 | 沿用现有取消原因，团队记录部分结果或失败 |
| 团队运行中编辑或停用 | 当前运行使用旧快照，新调用使用新状态 |
| 活动运行中删除团队 | 拒绝，需先终止 |
| 同名团队或同名智能体 | 显示名可重复；typed slug 决定身份，不回退 |
| 同会话第二次团队调用 | 明确拒绝；不同会话可独立运行但共享全局容量 |
| 团队成员或并发额已满 | 协调器排队，等待派工不占成员 run；整团取消同时清理等待队列 |
| 上游全局容量满 | 明确返回并计派工预算，不隐藏无限重试 |
| 不同会话同时写同一工作区 | 不提供跨会话全局写锁，沿用现有多会话风险；团队不新增读写互斥承诺 |
| 成员执行失败或停止 | Host 不自动重试；团长可用同成员 `execute + supersedesResultId` 显式重试失败的 `execute`，不得以技术重试替代 revision；未解决时最终为 `partial` |
| 空输出或包含非文本负载 | `reasoning + text` 正常提取文本；纯 reasoning 或无有效文本记 `empty-output`，`image` / `file` / `tool-call` / 未知块记 `unsupported-output`；上述两类错误均使团队结果 `status = 'failed'`，不进入必审或有效结果集 |
| 同会话双 MCP 成员并行 | runtime、请求与附件按子会话隔离，不挂父会话；团队 serverName 唯一且 ≤32 字符，公开名复用上游 64 字符规范化与哈希，allow 使用实际 mounted.names，注册冲突明确失败 |
| provider 返回不同实际 childId | 不假设等于 reservedChildId，不静默重键请求 Map；按现有契约补绑实际 id，并同时清理两类绑定 |
| 审查缺少或包含无法识别的末行标记 | 成员可正常完成，但审查记 `invalid-verdict`；可在预算内重审，不能直接算作 `revise` 或通过 |
| 审查失败或有效意见冲突 | 不算通过；可重试失败审查，多名审查员不做隐式投票 |
| 返修后再次不通过 | `unified` 按完整返修周期、`per-member` 按结果链在额度内继续；用尽后可为 `completed_with_issues`，存在其它技术缺失则为 `partial` |
| 引用结果超过 256 KiB | 启动成员前拒绝并提示减少引用，不静默截断证据 |
| 主 Artifact 提交时仍有未尝试必审或额度内必要返修 | 在 ArtifactHost 前拒绝，可继续派工；不得先写草稿再冒充主报告 |
| 24 次派工预算耗尽且仍缺执行员、必审或必要返修 | 至少一份有效结果且无在途时，允许提交如实披露的部分 Artifact，其它提交校验不豁免，最终为 `partial`，不再形成派工与交付双向阻断 |
| 已有技术失败证据时提交部分报告 | 允许提交并如实披露，commit 后封闭派工，最终按客观记录为 `partial` |
| Artifact 超过 5 MiB | prepare 返回 `artifact-too-large`，不截断；可在当前回合内修正重试 |
| Artifact prepare/commit 失败后主会话 idle | 有可用结果为 `partial`，否则为 `failed`；不设置额外 3 次 finish 预算 |
| 主报告响应丢失后以相同 `callId` 重试 | 复用 ArtifactHost tool 幂等返回原 Artifact，并再次尝试运行关联，不重复生成 |
| 主报告 commit 后以不同 `callId` 再次提交或继续派工 | 交付已封闭，拒绝第二份主 Artifact 和后续派工 |
| Artifact commit 成功但运行关联失败 | 不删除或伪报 Artifact 未创建；保留 Artifact 卡，运行最终为 `partial`，相同 `callId` 可重放关联 |
| commit 后取消 | 已提交 Artifact 保留并关联到对应 `stopped` 运行；commit 前取消丢弃暂存 |
| 父会话 abort 或 goal 续拍迟到派工 | 当前团队 `turn/end` 在 idle 与 goal 续拍前同步封闭派工并结算，`afterIdle` 只做清理；abort 进入取消收敛，不以无成功结果误判 `failed`，终态或 stopping 运行拒绝迟到派工 |
| 仅会话模式没有最终助手汇总 | 只统计本轮最后 `tool/result` 之后的非空助手 text，派工前过渡语和 reasoning 不算；缺失时有可用结果为 `partial`，否则为 `failed`，该回合不挂 `result_present` |
| 单个团队文件损坏 | 该团队 fail-closed，其他团队不受影响 |
| Host 重启 | 团队运行与聚合卡不恢复；消息和已提交 Artifact 卡保留，不反查补记团队运行 |
| Host 在 commit 后、结算前退出 | Artifact 卡保留，团队运行关联与聚合卡丢失，属于纯内存方案的明确残态 |

## 18. 测试与验收

### 18.1 单元测试

- 定义校验、结构化调度默认值、成员来源与可用性、审查模式与 reviewer 一致性、slug 和中文检索、typed token 解析。
- 24 次派工预算、单成员与有效团队并发、顺序执行、broadcast 全员要求、取消闩。
- `isConcurrencySafe` 对派工返回 `true`，以及 `maxParallelToolCalls` 与 Host 信号量对实际并发的约束。
- 结果引用、失败执行重试替代、业务返修替代、失败 revision 不替代原有效结果、三种审查模式、`unified` 省略 ID 时入口自动填充全集/空全集拒绝/显式子集拒绝/出队 scope 变化失败、实际 scope 写入提示词与返回、统一返修周期与逐成员结果链额度、派工入口超额拒绝、整体终态。
- `expert_team_dispatch` 无 `teamRunId` 入参，Host 能从父会话与租约解析唯一活动运行；失效租约、错误回合锚和迟到调用不能改挂其它运行。
- 审查末行 `PASS` / `REVISE` 解析；缺失、额外文本、空输出、`reasoning + text` 正常通过、纯 reasoning 记 `empty-output`、text+image/file/tool-call/未知块记 `unsupported-output`、技术失败和重审后的技术完整性，确认输出校验失败时 `status = 'failed'`，无效标记不会折算为业务 `revise`。
- 256 KiB 派工输入边界及中文/emoji 多字节计量。
- `result_present` 提交前校验（含等待队列阻塞）、24 次预算耗尽时缺执行员/缺必审/缺返修的部分交付豁免及其前提、Artifact 格式匹配、artifactStatus 组合、commit 后交付封闭、相同 `callId` 按持久 manifest 锚重放与不同 `callId` 拒绝、关联失败后的 `pending` 展示与 `partial`。
- 运行事件乱序、同 generation 断连对账、终态每会话 20/全局 100 淘汰，以及 generation 变化后的旧卡移除。

### 18.2 集成与安全测试

- caller 文本结果只返回团长工具，不产生额外父会话结算；不传 `outputSchema` 时不注册 `structured_output`，正常文本完成不会被改判为 `error`。
- 当前团队 `turn/end` 在 idle 和 goal 续拍前同步封闭派工并结算；非取消路径计算终态、取消路径先 `stopping` 再在 `afterIdle` 等待清理，第一次/第二次 `whenIdle` 均不延后封闭；goal 续拍不能插入迟到派工，下一条排队消息在终态与附件清理后放行。
- 已启动 turn 缺失 `turn/end` 时，`afterIdle` 按事件缺失 fail-closed 并立即封闭，取消与其它异常分别收敛，不把后续 goal turn 归入本运行。
- `resolveAgent` / `followup` 在受理前抛错时，运行原地 `failed`、pending anchor 回滚，`afterIdle` 清除或一次性守卫保证 finally 不重复结算。
- 顶层 `clientMessageId` 存在与缺失两种情况下，`resolveFollowupClientMessageId(params)` 均只计算一次，团队运行、turn anchor、Artifact 与 followup 使用同一 ID。
- 同团队有限并行生效，普通 `@智能体` 的 `pendingTurns`、parent 投递、MCP 工具名和单会话行为不回归。
- 同会话两个 MCP 成员并行时，父会话不出现成员 MCP 附件，runtime/registry/request 不串单；团队 serverName 满足 32 字符限制，长名与非法字符沿用上游 64 字符规范化+哈希，allow 使用实际 mounted.names，真实注册冲突 fail-closed。
- provider 忽略 reservedChildId 时，实际 childId 的补绑、请求 Map 不静默重键及两类 id 清理均正确。
- 包基础 shell、按声明提供的脚本、HTTP、MCP 和后代 allow 在 execute、review、revision 中均保持包原生边界，不发生团队角色裁剪或扩权。
- `expert_team_dispatch` 已挂载时在 `ask` / `smart` / `full` 档均不逐次审批，未挂载时均拒绝；跨会话、跨团队、跨结果引用和非名单成员派工全部 fail-closed。
- 成员停用、更新、移除、撤销、单成员取消、整团取消和父会话 abort；`session.cancel({ sessionId })` 立即联动 `cancelBySession`，bridge abort 兜底幂等，`queueItemId` 只取消排队消息，非 abort 错误不伪装成用户停止。
- 团队与非团队 claim 的附件对称挂载/摘除；仅会话模式不挂 `result_present`，Artifact 模式不会被 claim 处理器意外重复挂载或摘除。
- `result_present` 正文不进入实时/历史工具卡；Artifact 事件只含摘要；prepare 后 commit 前二次取消检查、commit→封闭→关联→事件顺序、相同调用重放、关联失败、commit 与取消竞态均符合协议。
- 主 Artifact 提交后继续派工、goal 续拍迟到派工和不同 `callId` 二次提交均被拒绝；相同 `callId` 重放只能使用已提交 manifest 的原 turn 锚，不能改挂 goal 续拍锚。
- 仅会话模式通过本轮 `session/event` 判定最终汇总：claim 前的旧事件与最后 `tool/result` 前的过渡语、reasoning 不算，之后多条 assistant/message 的 text 合并判断；空文本、事件缺口和 abort 分支正确，且不新增 `snapshotEvents()` 调用。
- Host 重启后不恢复团队运行或反查 Artifact；会话消息与已提交 Artifact 卡仍存在，旧聚合卡按失效内存快照移除。
- 不同 profile 的团队定义隔离，运行投影不跨 Host/profile 泄漏。

### 18.3 客户端测试

- 列表、创建、编辑、启停、删除和各种失效状态；结构化分配、顺序、审查和汇总控件及其联动默认值。
- 成员排序、职责与输出要求、包原生能力披露；不再出现团队只读/写入配置。
- 中文输入法、键盘选择、旧智能体 `@` 兼容和空任务提示。
- 动态不确定进度、混合活动、成员结果链、审查标记错误、未解决项与 Artifact 入口。
- 单成员和整团取消、断连冻结、同 generation 重连对账、Host 重启后移除旧聚合卡及终态文案。

### 18.4 端到端验收样例

1. 创建“合规审查小分队”：两名执行成员、一名审查成员，默认统一审查和 Markdown 主 Artifact，确认成员包原生脚本/HTTP/MCP 能力没有因入团或审查角色被裁剪。
2. 通过中文搜索选择专家团，确认三个成员按实际派工拥有独立运行和包版本。
3. 验证最多两路并行、动态补派、统一审查不通过触发一次返修、返修后全员重新审查。
4. 验证团长复用 `result_present` 只生成一份主 Artifact，普通会话只有简短说明，预览与下载可用；主报告提交后派工封闭。
5. 验证 Artifact 内容包含结论、依据和未解决项，运行卡可追溯成员输入、文本结果、审查标记和结果版本。
6. 分别验证成员中途失效、无效审查标记、整团取消、父会话 abort、Host 重启、同会话双 MCP 成员并行和 Artifact 写失败。

实现完成后运行仓库完整 headless gate `corepack yarn check`。中文输入法、真实取消清理、Host 重启、Artifact 预览下载和包原生沙箱体验另做真机验收，不以单元测试冒充真机结论。

## 19. 实施边界

本规格只确定产品与技术设计，不包含代码实施。书面规格经用户审阅后，下一步通过 `superpowers:writing-plans` 拆分实现计划。实现计划必须将普通包派发兼容、团队并行与子会话隔离、包原生权限、结构化调度与审查、`result_present` 团队门控和运行关联、纯内存投影、客户端体验及真机验收分别列为可验证工作项，不得把上游修改或现有技术债修复混入本需求。
