# 专家团多智能体协作与 Artifact 交付设计规格

- 日期：2026-11-21
- 状态：交互与技术设计已经用户分段确认；书面规格待用户审阅；尚未实施
- 基线：外层仓库 `3ad0a10af7`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`
- 范围：HuaAnWork 桌面端“专家团”模块、成员与调度配置、会话内 `@专家团`、真实独立成员执行、审查返修、聚合状态，以及默认主 Artifact 交付
- 约束：产品实现只进入 `dsh-plugin-huaanwork/` 与必要的桌面自有共享包；不修改 `deepseek-harness/`，不调整子模块 pin，不改变普通 `@智能体` 的既有语义

## 1. 背景与结论

专家团用于需要多个专业角色协作的复杂任务。用户可以在“智能体”和“知识库”之间管理专家团，把本地创建或已安装的智能体包组成团队，为成员设置职责，并由当前会话主智能体根据任务和中间结果动态派工。

本设计不是单模型多角色扮演，也不是把多个智能体名字注入一段提示词。每个成员都启动真实、独立的子智能体，保留各自的配置、权限、运行状态和结果。主会话担任团长，通过桌面 Host 提供的受控工具调用成员；成员结果通过上游已有的 `delivery: 'caller'` 返回团长工具，而不是逐条自动唤醒父会话。

复杂任务的主要交付物默认是一份主 Artifact。会话消息只承担简短状态说明和入口；Host 以 Artifact 的实际提交结果判定交付是否成功，不能以模型已经写出总结为由显示成功。

核心链路为：

```text
专家团定义与成员引用
        ↓
@team:<slug> + 当前任务
        ↓
Host 预检并冻结团队配置快照
        ↓
主会话团长 ⇄ expert_team_dispatch ⇄ 独立成员（caller 结果）
        ↓                         ↓
        └──── 审查 → 限次返修 ←───┘
        ↓
expert_team_finish：Host 验证结果并提交主 Artifact
        ↓
聚合运行卡 + Artifact 卡 + 简短会话说明
```

## 2. 目标与非目标

### 2.1 目标

1. 在指定位置提供专家团列表、新建、编辑、启停和删除能力。
2. 允许从本地创建及已安装的智能体包中选择成员，并配置职责与输出要求。
3. 由当前会话主智能体动态拆解任务、选择成员、安排顺序，并在受控预算内并行。
4. 支持自动审查、必要的限次返修、审查证据和结果版本追踪。
5. 支持在会话输入框检索并调用专家团，提供团队级与成员级状态、取消和错误反馈。
6. 默认生成一份主 Artifact；Artifact 未实际提交时不得把 Artifact 模式运行标为成功。
7. 默认只读，允许为特定团队开启受控写入；任何模式都不扩大成员原有权限。
8. 复用现有智能体包、子智能体、运行投影、Artifact 存储与预览下载能力，不另建通用多智能体框架。

### 2.2 非目标

- 不用单个模型模拟多个角色，不增加独立团长子智能体层。
- 不允许企业目录 legacy 智能体或“小工具”入团。
- 不提供人工终审暂停点；用户可随时终止，但流程不跨回合等待批准。
- 不提供通用 DAG 编辑器、任意条件分支、任意循环或定时触发。
- 不开放自定义 JSON Schema 编辑器；执行、审查和结束使用系统固定结构。
- 不允许成员各自直接创建 Artifact，不新增子智能体 Artifact 锚点。
- 不支持 PDF、Office、图片或其他二进制 Artifact 格式。
- 不做团队共享、发布、导入导出、跨设备同步或知识库关联。
- 不做跨 Host 重启自动续跑，不构建通用嵌套子智能体运行树。
- 不接入上游 experimental `agent-team`，不修改既有取消清理债项和 `subagent.maxDepth = 2` 默认值。

## 3. 已确认的产品与技术裁定

| 编号 | 裁定 |
| --- | --- |
| R1 | 首期即真实启动多个独立智能体，不采用单会话多角色模拟 |
| R2 | 采用主会话团长动态分派，不插入额外团长层，保留“主会话 → 成员 → 成员子智能体”的现有深度模型 |
| R3 | 成员仅允许本地创建及已安装启用的智能体包；排除 legacy 与工具条目 |
| R4 | 采用桌面 Host 编排器和团长受控工具；成员使用 `delivery: 'caller'` 返回结果 |
| R5 | 工作区权限可配置，默认只读；写入必须显式派工并独占执行 |
| R6 | 自动审查由审查角色承担，默认最多返修 1 轮；可配置为 0–2 轮 |
| R7 | 审查角色构成必审名单；技术失败、漏审或非法审查结构均不能算通过 |
| R8 | 默认交付一份主 Artifact；创建者可在团队配置中显式改用仅会话模式，单次调用不临时覆盖 |
| R9 | 主 Artifact 由父会话通过 `expert_team_finish` 统一提交，成员不直接创建 Artifact |
| R10 | Artifact 模式的成功必须由 Host 存储事实确认，不能由模型文字声明替代 |
| R11 | 团队规模为 2–8 名成员；并发上限为 1–4，默认 2；每次运行最多 24 次派工工具调用 |
| R12 | 团队配置按运行启动时冻结；智能体版本按每次实际派工记录，不承诺整次运行成员版本一致 |
| R13 | 动态条件判断交给团长；系统只提供有硬上限的审查返修循环，不做通用工作流引擎 |
| R14 | 专家团定义仅属于当前桌面 profile，不做共享、同步或发布 |
| R15 | 普通 `@智能体` 保持兼容；专家团使用独立的 `@team:<slug>` 命名空间 |

## 4. 方案取舍

| 方案 | 优点 | 主要缺陷 | 结论 |
| --- | --- | --- | --- |
| A. 桌面 Host 编排器 + 团长工具 + caller 结果 | 支持真实成员、有限并行、结构化审查、硬预算、统一取消和 Artifact 收口；不改上游 | 需要改造桌面包派发入口并新增团队状态机 | **采用** |
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
| 智能体包 dispatch 每会话只预留一个 `pendingTurns`，并写死 `delivery: 'parent'`；返回只有文本与 `afterIdle` | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:532-608,1098-1113,1164` | 团队并行与工具结果返回需要新增专用入口，不能伪造 sessionId 绕过 |
| 包运行已经拥有 run 创建、包版本、取消、结果观察和清理状态 | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:543-568,1127-1145`；`dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:21-55,66-80` | 成员继续复用该状态机，团队只增加聚合层 |
| 上游 `SubagentActivationSpec` 原生支持 `parent | caller`，并暴露 `activation.result` | `deepseek-harness/packages/subagent/subagent/src/types.ts:30-59` | 团长工具可以等待结果，不需要新上游投递模式 |
| 上游对 caller 不发送父会话结算消息 | `deepseek-harness/packages/subagent/subagent/src/manager.ts:1186-1205` | 多成员不会各自额外唤醒主会话 |
| 上游仅在工具 `isConcurrencySafe(args)` 返回 `true` 时进入并行池，其他情况及异常均 fail-closed 为 exclusive；并行池另受 `maxParallelToolCalls` 限制 | `deepseek-harness/packages/core/tools/src/index.ts:1304-1320`；`deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:113-133,199-206` | 读派工需显式声明并行安全，写派工必须 exclusive，Host 读写锁仍作为最终执行约束 |
| 上游 `maxActiveSubagents` 默认 8，是共享的子智能体容量配置 | `deepseek-harness/packages/subagent/subagent/src/index.ts:185-198` | 团队配置并发是上限而非保证，实际并行还受父会话工具池与全局剩余容量约束 |
| 上游请求支持 `outputSchema`；请求结构化输出但未有效捕获时，自然完成会改为 error | `deepseek-harness/packages/subagent/subagent/src/types.ts:171-175`；`deepseek-harness/packages/subagent/subagent/src/activation.ts:145-161` | 可强约束成员和审查结果，无合法结构不能算成功 |
| 包基础 allow 含读工具、shell 和 subagent，按声明增加脚本、HTTP 和 MCP | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:153-188` | 只读模式必须实际裁剪工具，不是提示词声明 |
| 包后代按血缘继承收窄后的 allow | `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:945-973` | 只读成员的后代继续只读 |
| 当前 policy 对 shell 没有通用“只读 shell”判定；写工具与外部工具也不能靠路径规则推定只读 | `packages/huaanwork-policy/src/decide.ts:92-145,199-226` | shell、脚本、HTTP/MCP 在只读派工中移除，而非尝试分析参数 |
| 产品默认委派深度为 2 | `dsh-plugin-huaanwork/src/profile.ts:113-127` | 主会话直接派成员，成员仍可有一层后代 |
| Artifact 仅支持 Markdown/HTML；摘要使用 turn 或 automation-run 锚点 | `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:392-417` | 团队仍使用 turn 锚点，不新增子代理锚点 |
| Artifact 写入已有 prepare/commit/discard、字节与 sha256 复核、原子 rename 和幂等裁决 | `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts:377-541` | 团队复用存储协议，finish 成功后发送现有事件 |
| 当前 Artifact 幂等作用域只有 tool 与 automation-run | `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts:46-64,122-141` | `teamRunId` 作用域是明确新增工作，不是现有能力 |
| 单 Artifact 为 5 MiB，每会话最多 100 个；超限拒绝；读侧复核正文与摘要 | `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts:26-29,254-283,321-349,467-473` | 主报告超限需调整重试，不能静默截断 |
| 普通父会话 `result_present` 已提供 Artifact 提交、事件与简短回复模式；包儿童不暴露该工具 | `dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts:38-55,88-115,149-166`；`docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md:43-49,64-68` | 团队保持父会话单一生产者，但团队路径改用 finish 统一收口 |
| 知识库仍为占位视图 | `dsh-plugin-huaanwork/src/client-huaanwork/KnowledgeBaseView.tsx:3-13,19-35` | 首期不存在可复用的知识数据契约 |

明确新增而不存在的能力包括：团队定义存储、团队运行协调器、同会话受控多成员并行、团长工具租约、团队级取消、读写锁、结果版本链、主 Artifact 必填判定，以及 `teamRunId` Artifact 幂等作用域。

## 6. 总体架构与组件边界

实现位于桌面自有源码树，逻辑组件如下：

1. **专家团定义存储**
   - 校验定义、原子读写、启停、删除和可用性计算。
   - 不读取或修改成员包内部配置，不复制 persona 作为团队事实源。
2. **团队运行协调器**
   - 管理 `teamRunId`、配置快照、派工与结束预算、并发和读写锁、结果链、审查状态、终态与 Artifact 关联。
   - 持久化不含 Artifact 正文的运行快照；Host 重启后只恢复只读记录，不恢复执行、工具租约或锁。
   - 不复制成员 run 状态机。
3. **团长工具桥**
   - 挂载和释放本次运行专属工具租约。
   - 校验父会话与团队归属，调用包派发适配层并返回 caller 结果。
4. **智能体包派发适配层**
   - 为团队路径暴露 activation/result、支持 caller 和固定 `outputSchema`。
   - 普通 `@智能体` 继续使用 parent 投递及原每会话限制。
   - 团队并行使用独立的运行键和预算，不伪造用户会话。
5. **RPC 与事件投影**
   - 提供定义 CRUD、可调用列表、运行快照、团队取消和变更事件。
   - 客户端以 `generation + revision` 对账，断连时冻结，重连后以 Host 快照为准。
6. **客户端模块**
   - 列表与编辑器、纯函数校验、中文 `@` 检索、聚合运行卡和 Artifact 入口。
   - 成员行复用现有子智能体摘要，右栏复用同一团队投影。

所有跨模块输入使用稳定 ID，不使用显示名称作为权限或结果归属依据。

## 7. 信息架构与页面设计

### 7.1 侧边栏

顺序固定为：

```text
智能体
专家团
知识库
```

“专家团”使用现有视图切换模式。列表与编辑器通过页面内部选中状态切换，不增加 URL 深链。

### 7.2 专家团列表

顶部包含标题、说明、搜索框和“新建专家团”。卡片展示：

- 名称、描述、适用场景；
- 成员数、只读/可写、是否启用审查；
- 默认 Artifact/仅会话；
- 可用状态及原因。

操作为编辑、停用/启用和删除。状态包括：

- **可调用**：已启用且定义、成员均有效；
- **已停用**：保留定义但不进入可选 `@` 结果；
- **配置不完整**：必填字段、角色或审查配置不满足要求；
- **成员失效**：一个或多个成员已停用、移除、撤销或损坏。

### 7.3 编辑页

使用完整页面，分为基本信息、成员与职责、调度规则、审查与汇总四个区域。新建和编辑复用相同表单；离开时有未保存确认。

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
  members: ExpertTeamMember[]   // 2–8
  orchestration: {
    assignmentInstructions?: string
    orderInstructions?: string
    maxParallel: 1 | 2 | 3 | 4  // 默认 2
    workspaceAccess: 'read-only' | 'write'
  }
  review: {
    enabled: boolean
    criteria?: string
    maxRevisionRounds: 0 | 1 | 2 // 默认 1
  }
  summary: {
    delivery: 'artifact' | 'message' // 默认 artifact
    artifactFormat: 'markdown' | 'html' // 默认 markdown
    mode: 'integrated' | 'by-member' | 'integrated-with-appendix'
    summaryInstructions?: string
  }
  createdAt: string
  updatedAt: string
}
```

`slug` 只要求在专家团命名空间唯一；`@team:` 前缀消除与智能体 slug 的歧义。显示名称可修改，调用名不可修改。

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
- 至少一名执行成员；启用审查时至少一名审查成员。
- 成员显示名和版本是解析时信息，不作为持久引用主键。

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
    | 'partial' | 'failed' | 'stopped' | 'interrupted'
  results: ExpertTeamResult[]
  primaryArtifactId?: string
  artifactStatus: 'not-required' | 'pending' | 'created' | 'failed'
  artifactError?: string
  dispatchAttempts: number
  finishAttempts: number
  finishFingerprint?: string
  startedAt: string
  endedAt?: string
  failure?: string
  generation: number
  revision: number
}
```

`status` 是整体状态；当前“规划中、执行中、审查中、返修中、汇总中”等文案由实际活动派生。动态团队允许执行与审查活动交错，不能把单一显示阶段当成新的顺序约束。

### 8.4 成员结果

```ts
type ExpertTeamResult = {
  resultId: string
  dispatchId: string
  memberId: string
  agentRef: ExpertTeamMember['agentRef']
  packageVersion: string
  memberRunId?: string
  kind: 'execute' | 'review' | 'revision'
  access: 'read' | 'write'
  inputResultIds: string[]
  supersedesResultId?: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped'
  output?: string
  structured?: unknown
  reviewVerdict?: 'pass' | 'revise'
  startedAt: string
  endedAt?: string
  error?: string
}
```

结果通过 `inputResultIds` 与 `supersedesResultId` 构成扁平版本链。被替代结果保留用于追踪，默认不进入最终汇总。Artifact 正文不复制到该对象，只保存 `primaryArtifactId`。

### 8.5 存储与可用性

- 团队定义存放在当前 profile 的桌面自有 `expert-teams` 数据目录，使用原子写入。
- 单个定义损坏时该团队 fail-closed，不影响其他团队加载，也不自动覆盖原文件。
- 可调用状态不落盘，每次由定义和成员实时状态计算。
- 运行中的配置使用快照；编辑和停用只影响新调用。
- 活动运行期间禁止删除团队，需先终止。
- 删除团队不删除智能体、会话或历史 Artifact。

团队运行快照也按 profile 持久化，保存结果、审查链、预算、终态和 Artifact ID，但不保存 Artifact 正文或任何可恢复执行的工具租约：

- 状态转变以原子方式落盘；高频成员活动可以合并写入，终态与 Artifact 关联不得延迟到进程退出。
- Host 启动时将上一 generation 的 `running`、`stopping` 记录统一改为 `interrupted`，保留结果和审查链供只读查看，不重新启动成员或恢复等待队列。
- 如果 Artifact 已按 `teamRunId` 提交而运行快照尚未登记，启动恢复通过该幂等键补记 `primaryArtifactId` 和 `artifactStatus`，运行本身仍为 `interrupted`。
- 客户端重连后若 Host 快照包含该团队则以快照对账；若上一 generation 的运行已不存在且没有持久记录，只能将旧卡标为 `interrupted`，不得继续等待或伪造结果。

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
- 调度说明、并发和调用预算；
- 工作区权限及只读模式下将被禁用的外部能力；
- 必审名单与返修上限；
- 默认交付格式和 `@team:` 调用名。

停用不删除定义；删除需二次确认，并在有活动运行时拒绝。

## 10. 调度、权限、审查与汇总规则

### 10.1 动态派工不是固定 DAG

`assignmentInstructions` 与 `orderInstructions` 是团长规划规则，例如“先抽取事实，再做法律判断”“高风险时增加法务复核”。主会话可以根据中间结果动态决定是否补派成员。

系统硬约束只有成员名单、角色、工具预算、并发、权限、审查和返工上限。自然语言规则不得被宣称为可静态验证的 DAG。

本设计支持动态条件判断和限次审查返修，但不提供用户自由绘制的节点依赖、通用条件分支或任意循环。

### 10.2 调用预算与并发

- 每次团队运行最多 24 次 `expert_team_dispatch` 工具调用；到达运行协调器的调用无论最终成功、失败或容量不足都计入，防止错误重试形成无限循环。
- 每次团队运行最多 3 次 `expert_team_finish` 调用，入参、完成度、Artifact 校验和冲突错误都计数。第 3 次仍不能成功收口时立即结束：有可用结果为 `partial`，否则为 `failed`；不得继续重试。
- `maxParallel = 1` 表示完全串行；2–4 允许团长并行调用不同成员。实际并行上限取团队 `maxParallel`、父会话 `maxParallelToolCalls` 和上游剩余子智能体容量的最小值，配置值不是并行保证。
- 上游 `maxActiveSubagents` 默认 8，为本机共享容量；其他会话和系统技能也会占用。容量不足返回明确可重试错误并计入派工预算，不做隐藏无限重试。
- 同一成员在同一团队内不能同时执行两个任务。
- 团队内超出并发额的派工等待，尚未创建成员 run，也不占成员并发位；等待中只能通过 `expertTeam.cancel` 取消，不能使用 `subagent.cancel` 定位。
- 同一 `teamRunId` 内写派工与任何其他成员派工互斥。不同会话之间不新增全局工作区写锁，仍沿用现有多会话同时修改同一工作区的风险边界。

### 10.3 只读与写入

只读模式同时约束团长和成员：

- 团长只保留明确只读的工具与团队工具，移除通用 subagent、写工具、shell、外部运行时工具和普通 `result_present`。
- 成员仅保留只读文件与搜索能力，以及继承同一收窄 allow 的 subagent；移除写工具、shell、`agent_http`、`agent_skill_run` 和 MCP。
- 技能正文可以按原包规则加载，但不能突破收窄后的工具面。
- 只读模式下不可用的成员外部能力必须在编辑器披露，不能静默宣称完整能力。
- 主 Artifact 由 Host 写入独立 Artifact 存储，不属于工作区写入。

允许修改模式仍不扩大成员权限：

- 团长自身不直接写工作区。
- 只有 `access = 'write'` 的执行或返修派工可使用该成员原有写能力；审查派工永远只读，返修继承被替代结果的 access。
- 同一团队运行内写派工独占执行；只读派工可按有效并发上限并行。
- 写派工不做自动重试，避免重复副作用。
- 工具租约释放失败时保持收窄或取消会话，不得为恢复原能力而静默放宽。

### 10.4 审查与返修

审查角色构成必审名单：

1. 每个未被后续返修替代的成功 `execute` 或 `revision` 结果，都必须由全部审查成员审查。
2. 审查输出使用固定结构：`pass | revise`、问题列表、依据和建议。
3. 多名审查员可并行，但不做隐式多数投票。
4. 任一审查员要求修改且返修额度未用尽时，必须由原执行成员返修；输入包含原任务、原结果和全部审查意见。
5. 返修产生新结果并标记旧结果已替代，新结果重新进入必审。
6. 返修额度为 0 或已经用尽时，未解决审查意见可进入 `completed_with_issues`。
7. 额度尚未用尽却拒绝执行必要返修、审查技术失败、漏审或审查结构不合法，只能按实际情况进入 `partial`，不能称为“完成但有未解决项”。
8. 审查未启用时，至少一个有效执行结果才可能正常完成。

### 10.5 汇总方式

- `integrated`：综合结论，默认。
- `by-member`：按成员组织结果与审查状态。
- `integrated-with-appendix`：综合结论并附成员结果。

`summaryInstructions` 决定报告重点。无论选择哪种方式，失败、遗漏、未解决分歧和审查未通过项必须显式呈现。

## 11. 会话中的 `@` 交互

### 11.1 检索与选择

输入 `@` 后，菜单增加“专家团”分组，与智能体并列：

- 按中文名称、调用名、描述和适用场景检索；
- 复用现有智能体图标并显示“专家团”文字标签，不新增图形资产；同时展示成员数、权限和审查/Artifact 标识；
- 保留上下键、Enter/Tab 和 Esc 行为，并正确处理中文输入法组合态；
- 只有可调用团队可选，失效原因在管理页查看。

选择后插入以下 token 与一个尾随空格：

```text
@team:<slug>
```

草稿识别到有效 token 后，在输入框附近显示团队名称、成员数、权限、审查和交付方式摘要。

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

顶层 `clientMessageId` 仍是本次用户回合的持久锚。团队运行卡与主 Artifact 都直接使用该顶层锚。

Host 收到后重新校验团队与成员，不信任客户端缓存；typed token 不得回退为同名智能体调用。

## 12. 运行协议

### 12.1 启动

1. Host 校验团队已启用、定义完整、全部成员可运行。
2. 创建 `teamRunId` 和配置快照，将聚合卡锚定到顶层 `clientMessageId`。
3. 为当前父会话挂载团队专属工具租约和收窄后的工具面。
4. 注入用户任务、成员名册、职责、调度规则和交付要求，主会话开始规划。

预检失败时不启动任何成员，也不产生主 Artifact。

### 12.2 成员上下文

团长可读取当前会话上下文。成员只获得：

- 团长填写的任务说明；
- 自身人设、职责和输出要求；
- 显式 `inputResultIds` 对应的上游结果；
- 本次执行或审查所需的固定结构要求。

不自动向每个成员广播完整父会话或全部兄弟结果。团队派工输入采用固定字节预算：`task`、渲染后的引用结果、成员职责和输出要求合计最多 256 KiB（UTF-8，多字节字符按实际字节计），成员包 persona 继续使用其独立上限。超过团队预算时 Host 在启动成员前拒绝并提示减少引用；即使未超字节预算，上游模型上下文拒绝也按成员失败呈现。任何路径都不得静默截断关键审查证据。

### 12.3 `expert_team_dispatch`

逻辑输入：

```ts
type ExpertTeamDispatchInput = {
  teamRunId: string
  memberId: string
  kind: 'execute' | 'review' | 'revision'
  task: string
  inputResultIds: string[]
  access: 'read' | 'write'
  supersedesResultId?: string
}
```

Host 强制校验：

- 租约、父会话和团队运行匹配，运行未停止；
- 成员属于快照且角色匹配；
- 所有输入结果属于同一团队，返修替代关系及原执行成员匹配；
- `kind = 'review'` 时 `access` 必须为 `read`；`kind = 'revision'` 时必须继承被替代结果的 `access`；
- 派工预算、单成员并发、有效团队并发和读写锁；
- `access` 不高于团队权限，工具面不超过成员原权限；
- 固定 `outputSchema` 与当前执行/审查类型匹配。

`expert_team_dispatch` 的工具定义必须实现 `isConcurrencySafe(args)`：只有 `access = 'read'` 才返回 `true`，写派工返回 `false`。因此读派工可进入上游并行池，写派工在上游调度中形成 exclusive 屏障；Host 读写锁仍在执行入口独立强制同一团队内的互斥，不能把工具声明当成唯一防线。

团队专用包派发入口返回 activation/result，使用 `delivery: 'caller'`。工具等待最终结果，将结构化值和必要文本返回团长；成员不自动发送父会话结算消息。成员仍进入现有 run 投影，保留包版本、取消、错误和清理警告。

### 12.4 `expert_team_finish`

逻辑输入：

```ts
type ExpertTeamFinishInput = {
  teamRunId: string
  outcome: 'completed' | 'completed_with_issues' | 'partial' | 'failed'
  includedResultIds: string[]
  unresolvedIssues: Array<{
    resultId?: string
    summary: string
  }>
  delivery:
    | {
        kind: 'artifact'
        title: string
        format: 'markdown' | 'html'
        content: string
        downloadName?: string
      }
    | { kind: 'message' }
}
```

`delivery.kind` 必须与团队配置一致。Host 先根据执行和审查事实独立计算候选完成度：

- `completed`：至少一个有效执行结果，所有必审要求通过，无技术性缺失；Artifact 模式还需提交成功。
- `completed_with_issues`：只有业务审查意见或成员分歧未解决，且允许的返修已按规则完成；Artifact 模式还需提交成功。
- `partial`：有部分可用结果，但存在成员失败、无效结构、必审缺失、必要返修未完成或 Artifact 未交付。
- `failed`：没有可用结果，或团长协议失败导致无法形成有效交付。

模型声明的 `outcome` 必须与 Host 候选值一致。不一致时拒绝 finish，返回 `expert-team-outcome-mismatch`、Host 候选值和具体原因，不进入 Artifact 写入；模型只能在剩余 finish 预算内以正确值重试。Host 不接受一个看似更保守但与事实不符的声明，因为失败与部分完成同样需要准确证据。

仅会话模式的 `artifactStatus` 恒为 `not-required`；Artifact 模式从启动起为 `pending`，直到提交成功或最后一次失败。

Artifact 模式下，finish 是团队路径唯一 Artifact 生产入口：

1. Host 使用当前 `sessionId` 与 `{ kind: 'turn', clientMessageId }`。
2. 新增 `{ kind: 'expert-team', teamRunId }` Artifact 幂等作用域。
3. 复用 begin/prepare/commit/discard、格式和字节校验、原子发布与读侧摘要复核。
4. finish 自身的完成度或归属校验失败发生在 ArtifactHost 之前，`artifactStatus` 不变。进入 ArtifactHost 后，无论是 prepare 的标题、格式、正文、大小校验失败，还是 commit 失败，都记录 `artifactStatus = 'failed'` 和稳定错误码；下一次重试开始先恢复为 `pending`。
5. Artifact 失败后整体 `status` 保持 `running`，当前活动为汇总中，允许在最多 3 次 finish 预算内重试，不立即发布 `partial`。预算耗尽或主会话随后 idle 仍无成功交付时，再按“有可用结果为 `partial`、否则为 `failed`”收口。
6. 只有实际 commit 成功后才写入 `primaryArtifactId`、设置 `artifactStatus = 'created'` 并发送一次 `artifact/created`。
7. 首次成功 finish 保存规范化输入的 `finishFingerprint`。同一 `teamRunId` 的完全相同重放返回原 Artifact 和原完成度，不生成第二份主 Artifact；指纹不同的再次 finish 返回 `expert-team-finish-conflict`，不写入、不覆盖，也不把旧 Artifact 冒充为新内容的成功。已终态运行的重放只读，不增加预算或改变状态。

团队运行期间不暴露普通 `result_present`，避免双生产者和审查前草稿。finish 的 Artifact 正文必须像现有 `result_present` 一样从实时及历史工具卡中抑制，不在会话、运行卡或日志展示中重复铺开。

finish 接受后主会话还需结束当前回合，Host 在 idle 时按已验证事实发布终态并释放工具租约：Artifact 模式只发送简短状态说明，已提交 Artifact 不因缺少这段说明而失效；仅会话模式必须产生非空最终助手文本，否则只能以 `partial` 收口。主会话在 finish 未被接受前 idle，或 finish 预算耗尽时，有可用结果为 `partial`，否则为 `failed`，并显示“未正常结束”或最后一次错误；不能自动视为成功。

## 13. 状态反馈与取消

### 13.1 聚合运行卡

团队卡包含：

- 团队名称、整体状态、当前活动、经过时间和终止按钮；
- 实际派工、进行中、完成、失败、审查和返修数量；
- 默认 Artifact 状态及主 Artifact 入口；
- 按实际派工顺序展开的扁平成员列表。

成员行展示执行/审查/返修、只读/写入、包版本、结果版本和现有子智能体状态，可查看结果、审查意见及替代关系。

动态任务没有预定总步骤，使用不确定进度；不得显示虚假的百分比或预先编造的“2/5”。执行与审查并行时显示混合活动，不强制伪装成线性阶段。

主 Artifact 仍生成现有 Artifact 卡，团队卡只提供同一 ID 的入口，不复制正文或再创建一种预览。

### 13.2 整体状态

| 状态 | 用户含义 |
| --- | --- |
| `stopping` | 已受理终止，正在等待成员和团长终结；暂态连接断开不属于此状态 |
| `completed` | 结果和审查要求满足，配置的交付也已完成 |
| `completed_with_issues` | 交付完成，但存在已披露的业务审查意见或分歧 |
| `partial` | 有部分结果，但技术执行、审查或 Artifact 交付不完整 |
| `failed` | 启动失败、无可用结果或协议失败 |
| `stopped` | 用户终止且运行已经终结 |
| `interrupted` | Host generation 已变化，上一运行不能继续；保留只读记录但不自动恢复 |

业务审查未通过与技术失败使用不同文案。未知成员停止原因不得被折算为成功。

### 13.3 取消

- 单成员终止复用现有 `subagent.cancel`，结果返回团长，由团长决定继续或部分结束。
- 团队取消使用精确的 `parentSessionId + teamRunId`，重复调用幂等。
- 团队取消后立即停止接受新派工，取消所有在途成员和团长回合；所有成员终结后团队进入 stopped。
- 清理警告继续展示，不虚报“已全部清理”，不新增强杀协议。
- 会话删除和 Host 退出同时触发团队取消。
- Artifact commit 前取消会丢弃暂存；commit 后取消保留已经可见的 Artifact，并在 stopped 运行中保留入口。
- 临时断连只冻结状态并禁用操作，不直接改成 `interrupted`；重连后按持久快照对账。Host 重启后上一 generation 的运行统一为 `interrupted`，成员结果、审查链和已提交 Artifact 只读保留，不自动续跑。

## 14. RPC 与事件逻辑面

新增桌面自有接口，名称可在实现计划中按现有路由惯例细化：

| 接口 | 用途 |
| --- | --- |
| `expertTeam.list/get` | 列表、详情与实时可用性 |
| `expertTeam.create/update` | 定义写入与字段错误 |
| `expertTeam.setEnabled/remove` | 启停与安全删除 |
| `expertTeam.invocableList` | 可选 `@` 团队及展示摘要 |
| `expertTeam.runList` | 按父会话获取团队运行快照 |
| `expertTeam.cancel` | 幂等终止整个团队 |

事件包括 `expertTeam/changed`、`expertTeam/run`、`expertTeam/run-remove`。现有 `agent.invocableList` 不改变含义，客户端合并专家团目录；现有 `subagent/run` 继续描述成员，团队事件只描述聚合状态。

终态团队卡采用与成员运行相同的有界淘汰思路；淘汰运行卡不删除会话 Artifact。

## 15. 与现有模块的关系

| 模块 | 关系 |
| --- | --- |
| 智能体 | 包仍是成员配置与版本的事实源；专家团只保存引用和职责，不提供第二个智能体编辑器 |
| 插件市场 | 已安装启用且未撤销的包可入团；更新、移除和撤销沿用现有在途取消语义，不增加团队发布 |
| 子智能体与进度面板 | 成员复用现有 run 投影和取消；团队只有聚合层，不建立任意嵌套树 |
| 技能 | 人设和技能正文按包规则加载，实际工具受团队裁剪，技能文本不能提权 |
| 知识库 | 当前为占位，首期不关联知识库，不增加 `@知识库` |
| 自动化 | 仅支持会话手动调用，不增加定时或事件触发 |
| Artifact | 主 Artifact 复用存储、事件、结果卡、预览、全屏和下载；团队新增 finish 生产者与 teamRunId 幂等作用域，成员仍不能产 Artifact |
| Profile | 团队定义与运行按 profile 隔离，历史 Artifact 仍属于原会话 |
| 上游 Harness | 使用现有 caller、outputSchema 与深度契约，不修改子模块，不引入 experimental agent-team |

## 16. 安全与一致性不变量

1. 任何派工都必须同时匹配父会话、团队租约、团队快照成员和结果归属。
2. 自然语言职责、成员输出和审查文本都只是数据，不能授予工具或改变 Host 终态。
3. 只读必须通过实际工具收窄及执行期拒绝完成，不能只在提示词中要求“不要修改”。
4. 团队不扩大成员原有工具、模型、工作区根或委派深度。
5. 写派工独占，普通 `@智能体` 路径不因团队并行改造而放宽。
6. 所有派工、审查和结束都有硬预算；错误重试不能绕过预算。
7. 只有 Host 能写整体状态、结果替代关系和 `primaryArtifactId`。
8. Artifact 成功以实际 commit 与记录复核为准，模型声明不作为依据。
9. Artifact 正文不得进入专家团 WebSocket 事件或 `ExpertTeamRun`；原始模型工具调用按上游会话持久化契约处理，但所有实时/历史 UI 与团队运行摘要只使用 Artifact ID，不额外复制正文。
10. 团队定义损坏、成员状态未知、结果结构未知或清理状态未知均 fail-closed，不猜测成功。

## 17. 关键边界场景

| 场景 | 设计结果 |
| --- | --- |
| 空调用 | 没有任务正文时禁止发送并提示补充 |
| 缓存中的团队已停用或删除 | Host 拒绝，不回退成智能体调用 |
| 启动前任一成员失效 | 整团不启动，列出全部原因，不静默跳过 |
| 启动后派工前成员失效 | 本次派工失败；团长可在预算内调整，最终按完整度结束 |
| 在途成员更新、移除或撤销 | 沿用现有取消原因，团队记录部分结果或失败 |
| 团队运行中编辑或停用 | 当前运行使用旧快照，新调用使用新状态 |
| 活动运行中删除团队 | 拒绝，需先终止 |
| 同名团队或同名智能体 | 显示名可重复；typed slug 决定身份，不回退 |
| 成员并发或全局容量满 | 团队内等待；上游默认共享容量为 8，错误明确返回并计预算，不无限重试 |
| 不同会话同时写同一工作区 | 不提供跨会话全局写锁，沿用现有多会话风险；互斥承诺只限同一 teamRunId |
| 写派工失败 | 不自动重试，避免重复副作用 |
| 审查失败或意见冲突 | 不算通过；允许多元意见进入未解决项，但不隐式投票 |
| 返修后再次不通过 | 在额度内继续；用尽后只能是 completed_with_issues 或按技术缺失为 partial |
| 引用结果超过 256 KiB | 启动成员前拒绝并提示减少引用，不静默截断证据 |
| 主会话未 finish 就结束 | 有可用结果为 partial，否则为 failed；保留结果并显示未正常结束 |
| Artifact 超过 5 MiB | prepare 返回 artifact-too-large，artifactStatus=failed，运行保持 running 供有限重试，不截断 |
| Artifact prepare/commit 连续失败 | 每次计入 finish 预算；第 3 次仍失败时有可用结果为 partial，否则为 failed |
| finish 响应丢失后以相同输入重试 | teamRunId 与 finishFingerprint 幂等返回原 Artifact，不重复生成 |
| Artifact 已创建后以不同输入再次 finish | 返回 expert-team-finish-conflict，不写第二份、不覆盖原结果、不伪装新内容成功 |
| commit 后取消或 Host 重启 | 已提交 Artifact 保留；运行分别显示 stopped 或 interrupted，不自动续跑 |
| Host 重启时 Artifact 已提交但快照未登记 | 启动按 teamRunId 幂等键补记关联，运行仍为 interrupted，结果只读保留 |
| 单个团队文件损坏 | 该团队 fail-closed，其他团队不受影响 |
| 同会话第二次团队调用 | 明确拒绝；不同会话可独立运行但共享全局容量 |

## 18. 测试与验收

### 18.1 单元测试

- 定义校验、成员来源与可用性、slug 和中文检索、typed token 解析。
- 派工预算、finish 3 次预算、单成员与有效团队并发、读写互斥、取消闩。
- `isConcurrencySafe` 对读派工为 true、写派工为 false，以及 `maxParallelToolCalls` 对实际并发的约束。
- 结果引用、返修 access 继承、审查强制只读、必审验证、返修额度和整体终态。
- 256 KiB 派工输入边界及中文/emoji 多字节计量。
- Artifact 必填、完成度与 artifactStatus 组合、teamRunId 幂等、finishFingerprint 相同重放与不同输入冲突。
- 运行事件乱序、断连对账、Host 重启恢复只读快照和终态淘汰。

### 18.2 集成与安全测试

- caller 结果只返回团长工具，不产生额外父会话结算。
- 同团队有限并行生效，普通 `@智能体` 的单会话行为不回归。
- 固定 outputSchema 缺失或非法时成员为失败，不能进入通过审查。
- 只读模式下团长、成员及后代的写工具、shell、HTTP/MCP 和脚本路径均被拒绝。
- 写模式不扩大原权限，写派工与任何其他派工不重叠。
- 跨会话、跨团队、跨结果引用和非名单成员派工全部 fail-closed。
- 成员停用、更新、移除、撤销、单成员取消、整团取消和 Host 重启。
- finish 正文不进入实时/历史工具卡；Artifact 事件只含摘要。
- Artifact 写失败、3 次 finish 后强制收口、相同输入响应丢失重试、不同输入冲突、commit 与取消竞态、会话删除级联。
- 仅会话模式在 finish 后没有非空最终助手文本时只能为 partial。
- Host 重启时将活动运行改为 interrupted，保留结果与审查链，并对账 commit 先于快照的 Artifact。
- 不同 profile 的定义与运行隔离。

### 18.3 客户端测试

- 列表、创建、编辑、启停、删除和各种失效状态。
- 中文输入法、键盘选择、旧智能体 `@` 兼容和空任务提示。
- 动态不确定进度、混合活动、成员结果链、未解决项与 Artifact 入口。
- 单成员和整团取消、断连冻结、重连对账及终态文案。

### 18.4 端到端验收样例

1. 创建“合规审查小分队”：两名执行成员、一名审查成员，默认只读和 Markdown 主 Artifact。
2. 通过中文搜索选择专家团，确认三个成员按实际派工拥有独立运行和包版本。
3. 验证最多两路并行、动态补派、审查不通过触发一次返修、返修后重新审查。
4. 验证 finish 只生成一份主 Artifact，普通会话只有简短说明，预览与下载可用。
5. 验证 Artifact 内容包含结论、依据和未解决项，运行卡可追溯成员输入、结果和审查版本。
6. 分别验证成员中途失效、整团取消、Host 重启、写派工互斥和 Artifact 写失败。

实现完成后运行仓库完整 headless gate `corepack yarn check`。中文输入法、真实取消清理、Host 重启、Artifact 预览下载和写权限体验另做真机验收，不以单元测试冒充真机结论。

## 19. 实施边界

本规格只确定产品与技术设计，不包含代码实施。书面规格经用户审阅后，下一步通过 `superpowers:writing-plans` 拆分实现计划。实现计划必须将普通包派发兼容、团队并行与权限、Artifact 幂等扩展、客户端体验和真机验收分别列为可验证工作项，不得把上游修改或现有技术债修复混入本需求。
