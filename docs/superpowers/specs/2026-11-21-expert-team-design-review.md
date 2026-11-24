# 专家团多智能体协作设计规格评审与最优方案（方案 A+）

- 日期：2026-11-21
- 评审对象：[`docs/superpowers/specs/2026-11-21-expert-team-design.md`](./2026-11-21-expert-team-design.md)
- 原始需求基准：
  > 在左侧边栏的“智能体”模块与“知识库”模块之间新增“专家团”模块，用于管理面向特定复杂任务的多智能体协作。用户可以新建专家团，如“合规审查小分队”，设置名称、描述和适用场景；可从“智能体”模块选择已创建的智能体加入专家团，并为专家团配置简单任务分发与调度规则，包括各成员职责、任务分配方式、执行顺序、审查流程及结果汇总方式；用户可在会话中通过“@专家团”检索、加载并调用指定专家团协作完成当前任务。
- 基线：外层仓库 `3ad0a10af7`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`0.2.1-rc.1`）
- 方法：原始需求逐项对齐核查 + 源码级可行性反证（逐条核对 `agent-package`、`huaanwork-guardrails`、`huaanwork-policy`、`artifacts-host` 及上游 `dsh-subagent`）+ YAGNI 与复杂度裁剪评估
- 结论：**Needs revision（采纳本文 §4 最优方案 A+ 修订规格后再进入实施计划）**
  - 严重（Critical）：2（C-1 默认只读剥夺智能体包全部自有工具；C-2 强制 `outputSchema` 触发 `structured_output` 被现有护栏 100% 拦截且转为 `error`）
  - 重要（Important）：3（I-1 同会话并行与包宿主 3 处父会话单槽耦合冲突；I-2 简单调度规则前虚后僵与 `outcome` 握手脆弱；I-3 另建 `expert_team_finish` 与 `teamRunId` 幂等域过度设计且与 `agent/inbox/claimed` 附件同步冲突）
  - 一般（Minor）：2（M-1 新工具未进 `decide.ts` 导致默认档位逐次弹审批；M-2 团队运行过程快照落盘与跨重启反查 Artifact 过度复杂）
- 第二轮复审结论（2026-11-22，见 §7）：**With fixes**。首轮 7 项发现已全部闭环且反向补强 4 处细节；但修订新增条文引入 **1 项 Critical（R2-C1 思考模型 `reasoning` 块误判 `unsupported-output`）**、**2 项 Important（R2-I1 `sessions.ts` `whenIdle`/`afterIdle` 顺序误读；R2-I2 24 次预算耗尽时 `result_present` 提交前守卫死锁）** 及 **3 项高价值优化（R2-O1~R2-O3）**，修正前 3 项并酌情吸收优化项后可进入 `writing-plans`。
- 第三轮复审收口（2026-11-22，见 §8）：**Approved（通过）**。第二轮全部 6 项（R2-C1、R2-I1、R2-I2、R2-O1~R2-O3）已完整闭环且新增源码引用全部属实，0 Critical / 0 Important，规格已达到可直接进入 `superpowers:writing-plans` 的质量基线。

---

## 1. 原始需求对齐与总体判决

**总体判断**：原规格在**宏观执行底座**上的选型是正确的（主会话任团长 + 真实启动独立成员子智能体 + 上游 `delivery: 'caller'` 回收结果），但在**权限模型、结构化输出约束、调度规则表达、结果收口协议、状态持久化**五个方面偏离了原始需求的“简单任务分发与调度规则”定位，引入了大量非必要的重型状态机（违背 YAGNI），且存在 2 处会导致核心功能在现有代码库上直接不可用的 Critical 冲突。

| 原始需求子项 | 原规格（方案 A）设计 | 评审判定 | 最优方案（方案 A+）改进 |
| --- | --- | --- | --- |
| 侧边栏“智能体”与“知识库”之间新增“专家团”模块 | 固定视图顺序：`智能体 → 专家团 → 知识库`，列表+编辑视图切换（§7） | **通过（最优）** | 保持原规格设计 |
| 新建专家团，设置名称、描述和适用场景 | `name`、`description`、`scenarios` + 不可变 `slug`（§8.1、§9.1） | **通过（最优）** | 保持原规格设计 |
| 从“智能体”模块选择已创建的智能体加入专家团 | 选择本地创建及已安装启用的智能体包，按 `source + slug` 引用（§8.2、§9.2） | **部分通过，存在 C-1 缺陷** | 保持引用模型，但**保留成员包固有工具与沙箱能力**，废除阉割包工具的团队 `workspaceAccess` 锁 |
| 配置简单任务分发与调度规则：各成员职责、任务分配方式、执行顺序、审查流程及结果汇总方式 | 分配方式与执行顺序仅为自由文本框；审查强制全员逐项必审；新增 `workspaceAccess` 读写锁（§8.1、§10） | **未达最优（I-2）** | 提供**结构化简单选项 + 可选补充说明**（分配模式、顺序模式、审查模式、汇总模式），既直观易配又具确定性 |
| 会话中通过 `@专家团` 检索、加载并调用指定专家团协作完成当前任务 | `@team:<slug>` + 中文检索 + `expert_team_dispatch` + `expert_team_finish`（§11、§12） | **检索通过；运行与收口存在 C-2 / I-1 / I-3 缺陷** | 保留 `@team:<slug>` 与 `expert_team_dispatch`，**移除 `expert_team_finish` 与强制 `outputSchema`**，直接复用 `result_present` + Turn `afterIdle` 自然收口 |

---

## 2. 原规格已核实成立、应保留的核心底座

以下设计决策经源码核实完全成立，应作为最优方案 A+ 的不动产保留：

1. **真实独立子智能体 + 主会话团长 + `delivery: 'caller'`（R1、R2、R4）**
   - 上游 `SubagentActivationSpec` 原生支持 `delivery: 'parent' | 'caller'`（`deepseek-harness/packages/subagent/subagent/src/types.ts:43`），且 `delivery: 'caller'` 不会向父会话发送 `<subagent-notification>` 结算消息（`manager.ts:1186-1205`），可由团长工具直接 `await activation.result`。
   - 产品默认 `subagent.maxDepth = 2`（`dsh-plugin-huaanwork/src/profile.ts:113-127`），主会话直接作为团长派发成员（深度 1），无需额外插入一层团长子智能体。
2. **智能体包单一事实源与 `subagentRuns` 状态机复用（R3、R12）**
   - 专家团仅存储成员引用 `{ source: 'local' | 'catalog', slug }` 与团内职责，不复制 `persona.md`；成员执行继续登记进 `ctx.huaanworkSubagentRuns`（`dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:66-100`），复用现有的运行阶段、包版本、清理告警与单成员取消能力。
3. **独立的 `@team:<slug>` 命名空间与中文检索（R15）**
   - 输入 `@` 同时检索智能体与专家团（支持匹配中文 `name`、`slug`、`description`、`scenarios`），选中专家团插入 `@team:<slug> `，`session.send` 通过 `at: { kind: 'expert-team', name: slug }` 显式分流，不回退为同名智能体，保持既有 `@<agent-slug>` 零回归。

---

## 3. 发现清单（附源码证据与理由）

### 3.1 Critical（阻塞功能可用性，必修）

#### C-1 默认 `workspaceAccess: 'read-only'` 与审查强制 `access = 'read'` 剥夺了智能体包的全部自有工具（`agent_http` / `agent_skill_run` / `MCP`）

- **规格描述**：
  - §8.1 / §10.3 引入了原始需求未要求的 `workspaceAccess: 'read-only' | 'write'`（默认 `'read-only'`），并规定：**“只读模式下：成员仅保留只读文件与搜索能力，以及继承同一收窄 allow 的 subagent；移除写工具、shell、`agent_http`、`agent_skill_run` 和 MCP。”**
  - §10.3 / §12.3 同时规定：**“审查派工永远只读（`kind = 'review'` 时 `access` 必须为 `'read'`）。”**
- **代码事实**：
  - 在 `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:168-188` 中，智能体包的基础工具清单由 `composeAgentPackageToolAllowList` 生成：
    ```ts
    const allow = new Set<string>([
      'read', 'read_file', 'glob', 'grep',
      process.platform === 'win32' ? 'pwsh' : 'bash',
      'subagent',
    ])
    if (skillScripts.length > 0) allow.add('agent_skill_run')
    if (mode === 'http' || mode === 'both') allow.add('agent_http')
    if (mode === 'mcp' || mode === 'both') { for (const name of mcpNames) allow.add(name) }
    ```
  - 智能体包本来就不包含 `edit` / `write` / `str_replace_editor`；用户在 M1/M2 创建或从广场安装的智能体包，其**核心业务能力全部构建在 `agent_skill_run`（`skill/scripts/**`）、`agent_http`（本地沙箱 HTTP 服务）和 `mcp__*`（本地沙箱 MCP 服务）之上**。
  - 此外，父会话工具收窄由 `present-as.ts:127-160` 在每次 `agent/pre-step` 与 `tools/change` 时按 `ALLOWED_TOOLS ∪ extra` 动态重算覆盖；在父会话搞一套“运行期临时剥夺 `ALLOWED_TOOLS` 基础工具、释放失败还要锁死或取消会话”的租约机制（§10.3），直接与 `present-as.ts` 的重算模型冲突。
- **严重后果**：
  1. 在默认的 `read-only` 专家团中，所有成员智能体包的技能脚本、HTTP 工具、MCP 工具被全部剥夺，所有带工具的智能体包入团即退化为只能读本地文件的空壳。
  2. 即便用户将专家团改为 `write` 模式，所有 `reviewer`（审查成员）因被强制 `access = 'read'`，依然**永远无法调用自身的 `agent_skill_run`、`agent_http` 或 `MCP` 工具**来执行合规校验、脚本检查或外部规则核对。
- **裁定与修法**：
  - **删除团队级 `workspaceAccess` 配置、删除派工级 `access: 'read' | 'write'` 参数及团队读写互斥锁**。
  - **成员权限遵循“包本位”原则**：每个成员子智能体直接沿用其智能体包自身的 `composeAgentPackageToolAllowList` 工具集与 `sandbox.confine` 沙箱边界（既不超出包原有权限，也不额外阉割包声明的自有工具）。

#### C-2 强制子智能体使用上游 `outputSchema` 在现有护栏下 100% 被拦截拒绝，且会导致正常文本完成被判定为 `error`

- **规格描述**：
  - §5（第 105 行）、§6（第 135 行）、§12.3（第 494 行）、§18.2（第 679 行）规定：团队派发成员时向 `startActivation` 传入固定 `outputSchema`，依赖上游在未捕获结构化输出时将自然完成改为 `error`，以此强约束执行和审查输出结构。
- **代码事实（三层拦截链）**：
  1. **上游 `outputSchema` 的实现机制**：在 `deepseek-harness/packages/subagent/subagent/src/manager.ts:897-902` 与 `structured.ts:19,83` 中，传入 `outputSchema` 会在子会话作用域动态注册一个名为 **`structured_output`** 的工具，并注入强制提示词 `When you have your final answer, you MUST report it by calling the structured_output tool... Do not finish with a plain text answer`（`structured.ts:26-29`）。若子智能体未成功调用 `structured_output` 就结束，`captureLocalResult`（`activation.ts:155-160`）会直接将 `stopReason: 'completed'` 改写为 **`stopReason: 'error'`**。
  2. **第一道护栏拦截（`huaanworkPackageChildAllow`）**：在 `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:114-119` 与 `:136-140` 中，代码及注释明确写道：
     ```ts
     // 名字集合判定:上游 schema 层会豁免 scope 自己注册的本地工具(如 structured_output),
     // 本检查不豁免 —— 血缘会话若真的请求 scope 本地工具,这里必须重新审查。
     const lineageAllow = ctx.huaanworkPackageChildAllow?.get(sessionIdOfAgentRef(execution.agent) ?? "");
     if (lineageAllow !== undefined && !lineageAllow.includes(execution.name)) {
       return { kind: "deny", reason: `huaanwork-policy: 智能体包链路会话不允许使用工具 ${execution.name}` };
     }
     ```
     由于 `composeAgentPackageToolAllowList`（`runtime.ts:168-188`）不含 `'structured_output'`，所有包成员调用 `structured_output` 都会在 `tools/pre-execute` 和 `tools.guard` 被直接拒绝！
  3. **第二道策略拦截（`decide.ts`）**：在 `packages/huaanwork-policy/src/decide.ts:92-146` 中，`switch (input.name)` 没有 `case "structured_output":`，落入 `default:` 分支（`:145`）：
     ```ts
     default:
       return input.attached ? (mode === "full" ? ALLOW : askOrDeny(seam)) : deny(reasonToolUnattached(input.name));
     ```
     而 `policy.ts:24-32` 的 `SESSION_ATTACHED_TOOLS` 不含 `structured_output`，导致 `input.attached` 为 `undefined`，在 `ask` / `smart` / `full` **全部三档策略下均被 `decide()` 无条件拒绝**（报错 `未挂载的宿主工具 structured_output`）！
- **严重后果**：
  - 按原规格实施后，任何成员子智能体只要带 `outputSchema` 启动，其调用 `structured_output` 必被护栏拒绝；放弃调用而直接输出文本又会被上游 `captureLocalResult` 强制判为 `stopReason: 'error'`——**所有专家团成员派工 100% 失败**。
  - 更进一步，让 `execute`（执行角色）把长篇分析报告塞进 `structured_output` 的 JSON 字符串参数中，既浪费 Token 做 JSON 转义，又极易因长文本截断导致 JSON 校验失败。
- **裁定与修法**：
  - **不使用上游 `outputSchema` / `structured_output` 工具拦截成员输出**。
  - 成员子智能体正常输出 Markdown/文本结论，Host 直接通过 `activation.result` 的 `output`（`finalAssistantOutput`，`activation.ts:152`）读取成员完整回复。
  - 对于审查成员（`kind = 'review'`），在审查任务提示词中约定首行/末行轻量结论标记（例如 `[VERDICT: PASS]` 或 `[VERDICT: REVISE]`，Host 用轻量解析提取 `pass | revise`，缺省或解析不到时按需提示团长，而不把正常完成Subagent直接炸成 `error`）。

---

### 3.2 Important（架构隐患与过度设计，应重构裁剪）

#### I-1 同会话多成员并行与现有 `AgentPackageHost` 的 3 处父会话单槽耦合直接冲突

- **规格描述**：§5（第 99 行）与 §6（第 137 行）提出“团队并行使用独立的运行键和预算，不伪造用户会话”，但未指出现有 `agent-package/host.ts` 内部除 `pendingTurns.get(sessionId)` 之外的另外 **3 处父会话级单槽竞态**。
- **代码事实**：
  1. **`registry.bind(sessionId, runtime)` 父会话键覆盖与误删**：
     - `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:1089` 执行了 `registry.bind(sessionId, runtime)`（将父会话 ID 绑到当前成员 runtime），并在 `:901` 的 `cleanup` 中执行 `if (registry.get(sessionId) === current) registry.delete(sessionId)`。
     - 实际上，`agent_skill_run` 和 `agent_http` 在执行时（`huaanwork-guardrails/agent-package-tools.ts:255-263`）是通过 `sessionIdOfAgentRef(exec?.agent)` 获取**子会话 ID（`childSessionId`）** 去查 `registry.get(childSessionId)` 的，而 `:778` 的 `bindChild(childSessionId)` 已经执行了 `registry.bind(childSessionId, runtime)`。向父会话 `sessionId` 绑定 runtime 完全是历史冗余，且在同会话并发时会互相覆盖。
  2. **`mountMcp` 先挂父会话再摘除的竞态窗口**：
     - `host.ts:1018-1058` 在 `createRuntime` 的 `mountMcp` 回调中，先把 `sessionId`（父会话 ID）传给 `mountSessionMcp`（`agent-mcp.ts:132` 把 `mcp__*` 挂到父会话 `sessionId` 并 `refreshAgentRestrict`），随后在 `host.ts:1054-1057` 从父会话摘掉，再在 `:1077` 挂到 `reservedChildId`。并且 `:893` 调用 `mcpDispose()` 时，会再次对 `opts.sessionId`（父会话）执行 `detachAgentTools`。
     - 同会话并发启动两个 MCP 成员（甚至同一成员重入）时，父会话附件表与 `mcpDispose` 会发生交叉摘除竞态。
  3. **`ctx.huaanworkAgentPackageRequest.current` 全局单槽**：
     - `host.ts:1093-1095` 将 `request` 写入单槽 `ctx.huaanworkAgentPackageRequest.current = request`，由 `skills.ts:900-933,991-999` 在 `startActivation` 包装器中消费并在 `finally` 清空。并发 `startActivation` 下单槽极易脆弱。
- **裁定与修法**：
  1. 在 `dispatchTeamMember`（或统一改造后的包派发内部路径）中，**在 `createRuntime` 之前预先生成 `reservedChildId`**；
  2. `mountSessionMcp` 直接传入 `sessionId: reservedChildId`，全程不向父会话 `sessionId` 挂载或摘除任何 MCP 工具名；
  3. 只执行 `registry.bind(reservedChildId, runtime)`（及实际 `activation.childId`），**不再对父会话 `sessionId` 调用 `registry.bind(sessionId, runtime)`**；
  4. 新增按 `reservedChildId` 索引的 `Map<string, AgentPackageSubagentRequest>`（或将 `huaanworkAgentPackageRequest` 扩展为支持 `byChildId: Map<string, AgentPackageSubagentRequest>`），`skills.ts` 优先按 `specChildId` 精确取走对应的 `request`，彻底消除并发单槽竞态。

#### I-2 “简单任务分发与调度规则”前虚后僵：前端缺失结构化简单规则，后端全员必审与 `outcome` 握手过于脆弱

- **规格描述**：
  - §8.1 将“任务分配方式”和“执行顺序”定义为两个可选自由文本框 `assignmentInstructions?: string`、`orderInstructions?: string`；
  - §10.4 将审查定义为“每个未被替代的 `execute`/`revision` 结果都必须由全部审查成员逐一审查”；
  - §12.4 要求模型在 `expert_team_finish` 中传入 `outcome`，若与 Host 独立推导的候选枚举不一致，立即报错 `expert-team-outcome-mismatch` 并扣减 3 次预算。
- **问题理由**：
  1. **未能体现原始需求的“简单任务分发与调度规则”**：用户创建专家团时，面对“任务分配方式”和“执行顺序”两个空白输入框，缺乏开箱即用的结构化选项；
  2. **“逐项全员必审”不符合多数办公场景且浪费 Token**：以原始需求中的“合规审查小分队”为例，常见流程是“成员 A 拟定/提取条款 + 成员 B 核查业务数据 → 审查员 C 对汇总初稿或全部产出做一次整体合规审查”。若强制要求每个执行成员的每次输出都要被所有审查员单独调一次子智能体审查（N 个执行员 × M 个审查员 = N×M 次子智能体调用），耗时与 Token 成本成倍膨胀；
  3. **`outcome` 对暗号极易误杀正常任务**：LLM 对 `completed_with_issues` 与 `partial` 的边界理解稍有偏差，3 次 finish 握手失败就会导致明明已完成的协作任务无法产出报告。
- **裁定与修法**：
  1. **将调度规则升级为“结构化简单枚举 + 可选补充说明”**（详见 §4.3、§4.4）：
     - **任务分配方式 (`assignmentMode`)**：`'by-responsibility'`（按成员职责拆解分配，默认） | `'broadcast'`（各执行成员独立处理同一任务，多视角对比）
     - **执行顺序 (`executionOrder`)**：`'sequential'`（按成员列表顺序依次执行，后序可引用前序结果） | `'parallel'`（无依赖成员并行执行，默认） | `'dynamic'`（团长按中间结果动态决定）
     - **审查流程 (`reviewMode`)**：`'none'`（不启用审查） | `'unified'`（所有执行成员完成后统一送审，默认） | `'per-member'`（每个执行成员结果逐一送审），配合 `maxRevisionRounds: 0 | 1 | 2`（默认 `1`）
     - **结果汇总方式 (`summaryMode`)**：`'integrated'`（综合结论，默认） | `'by-member'`（按成员分列） | `'integrated-with-appendix'`（综合结论+成员明细附录）
  2. **运行终态完全由 Host 根据客观记录自动裁定**，不需要模型自报 `outcome` 与 Host 对暗号。

#### I-3 另建 `expert_team_finish` Artifact 生产线与 `teamRunId` 幂等域过度设计（违背 YAGNI），且与 `makeResultPresentClaimed` 冲突

- **规格描述**：§12.4 禁用现有 `result_present`，专为专家团新建 `expert_team_finish` 工具，并在 `artifacts-host.ts` 新增 `{ kind: 'expert-team', teamRunId }` 幂等域、`finishFingerprint` 冲突比对、3 次重试计数器与跨重启反查补记。
- **代码事实与冲突**：
  1. `dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts:149-165` 中的 `makeResultPresentClaimed` 监听了全局 `agent/inbox/claimed` 事件。在 `sessions.ts:486-547` 中，`dispatchAt` 先执行，随后 `agent.followup` 触发 `agent/inbox/claimed`，此时 `makeResultPresentClaimed` 会因为 `anchor?.origin === 'advanced'` **自动把 `result_present` 重新挂载到父会话并刷新 restrict**！原规格若在启动期摘除 `result_present`，会被紧接着的 `agent/inbox/claimed` 覆盖复活。
  2. 现有 `result_present`（`result-artifact-tools.ts:77-117`）已经完整实现了 `beginArtifactWrite` → `prepareArtifact` → `commitPreparedArtifact` → 发送 `artifact/created` 事件 → `discardPreparedArtifact`，且工具卡正文抑制、预览、全屏、下载全部就绪。
  3. 强制模型在汇总阶段调用 `expert_team_finish`：在 `delivery: 'message'`（仅会话模式）下凭空增加一轮多余的工具调用往返；在模型拿齐成员结果后若直接回复用户而忘调 `expert_team_finish`，原规格会将其强行标为 `partial`（“未正常结束”）。
- **裁定与修法**：
  - **取消 `expert_team_finish` 工具，也不在 `artifacts-host.ts` 新增 `teamRunId` 幂等域**。
  - **直接复用现有 `result_present` 工具**：
    - 当团队配置 `delivery: 'artifact'`（默认）时，父会话正常保留 `result_present`；团长在完成成员派工与审查后，直接调用 `result_present` 提交主报告。
    - `result_present` 执行成功时，若当前父会话存在活跃的 `ExpertTeamRun`，顺手调用 `expertTeamRuns.noteArtifactCreated(sessionId, artifact.artifactId)` 将主 Artifact ID 关联到团队运行卡（一行钩子即可完成关联，幂等仍走 `result_present` 既有的 `{ kind: 'tool', callId }`）。
    - 当团队配置 `delivery: 'message'` 时，`makeResultPresentClaimed` 检查当前回合若为 `delivery === 'message'` 的专家团回合则不挂 `result_present`，团长直接在会话中输出汇总正文。
  - **在父会话本轮 Turn 结束（`afterIdle`）时由 Host 统一自动收口**：根据 `ExpertTeamRun` 已记录的执行结果、审查结果与 `primaryArtifactId`（或会话输出）一次性计算终态。

---

### 3.3 Minor（护栏接线补漏与状态机瘦身）

#### M-1 新团队工具未写入 `packages/huaanwork-policy/src/decide.ts` 与 `SESSION_ATTACHED_TOOLS`

- **证据**：在 `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:24-32` 与 `packages/huaanwork-policy/src/decide.ts:133-146` 中，所有按会话动态挂载且用户在场即视为已授权的工具（如 `result_present`、`agent_http`、`agent_skill_run`），都必须同时登记进 `SESSION_ATTACHED_TOOLS` 并在 `decide.ts` 中配置 `return input.attached ? ALLOW : deny(reasonToolUnattached(input.name))`。
- **后果**：若漏改 `decide.ts`，`expert_team_dispatch` 会落入 `decide.ts:145` 的 `default:` 分支，在默认 `ask` 或 `smart` 护栏档位下，**团长每派发一名成员都会在界面弹出人工审批框阻塞流程**。
- **修法**：将 `expert_team_dispatch` 加入 `policy.ts` 的 `SESSION_ATTACHED_TOOLS`，并在 `packages/huaanwork-policy/src/decide.ts` 增加 `case "expert_team_dispatch": return input.attached ? ALLOW : deny(reasonToolUnattached(input.name));`。

#### M-2 `ExpertTeamRun` 过程快照落盘、高频写合并与跨重启反查 Artifact 过度设计

- **证据**：现有的单智能体运行状态机 `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:21-56` 是纯内存权威状态机（每父会话保留 20 条终态、全局 200 条），因为**用户会话消息与 Artifact 本身已经持久化在磁盘上**。原规格 §8.5 要求为 `ExpertTeamRun` 单独实现磁盘持久化、高频成员活动合并写、重启改为 `interrupted` 以及跨表反查 Artifact 补记，复杂度远超收益。
- **修法**：`ExpertTeamRunRegistry` 与 `SubagentRunRegistry` 保持同构的**纯内存权威状态机 + 有界终态淘汰**（每父会话保留 20 条终态，全局 100 条）；客户端断连重连通过 `expertTeam.runList` 内存快照与 `generation + revision` 对账；Host 重启后历史会话中的 Artifact 卡与助手总结消息依然完整保留。

---

## 4. 最优设计方案（方案 A+ 完整规格）

### 4.1 方案对比与选型结论

| 方案 | 核心机制 | 优点 | 缺陷 / 取舍 | 结论 |
| --- | --- | --- | --- | --- |
| 原规格方案 A | 重型 Host 状态机 + `expert_team_dispatch` + `expert_team_finish` + 团队读写锁 + 强制 `outputSchema` | 试图用强 schema 与双手握死所有状态转换 | 存在 C-1（剥夺包工具）、C-2（`structured_output` 100% 被拒）、I-2/I-3（握手脆弱、过度设计） | **不原样采用，裁剪升级为 A+** |
| **推荐方案 A+（轻量 Host 协同 + 结构化简单规则 + 包原生权限 + 复用 `result_present` 自然收口）** | 主会话任团长 + 单一 `expert_team_dispatch`（`delivery: 'caller'`）+ 结构化简单调度配置 + 复用 `result_present` + Turn `afterIdle` 自动结算 | **100% 覆盖原始需求；保留成员包全部 HTTP/MCP/脚本能力；保留动态补派与审查返修灵活性；删减约 45% 状态机与协议复杂度** | 团长仍需通过 tool-call 派发成员（受 24 次硬预算保护） | **采用（最优方案）** |
| 替代方案 B（Host 确定性流水线） | Host 不经主会话 tool-call，直接按固定拓扑（串行/并行 → 审查 → 返修）启动子智能体，最后交主会话汇总 | 主会话 LLM 往返最少、延迟最低 | 无法支持“团长根据成员 A 的输出动态决定是否补派成员 B”的复杂协作场景 | 不采用（但将方案 B 的结构化预设思想吸收进方案 A+） |

### 4.2 核心运行链路

```text
用户在“专家团”模块创建团队（成员 + 职责 + 结构化简单调度规则）
        ↓
会话输入 @team:<slug> + 任务描述
        ↓
Host 预检团队与全员可用性 → 冻结团队快照 → 创建内存 ExpertTeamRun
        ↓
挂载父会话本轮 expert_team_dispatch 附件 → 注入结构化团长调度指令
        ↓
主会话团长 ⇄ expert_team_dispatch (delivery: 'caller') ⇄ 独立成员子智能体
  │              （按 reservedChildId 隔离绑定 runtime / MCP / 附件）
  │              （保留成员智能体包原生工具集与沙箱边界）
  └──── 若启用审查：执行完成后派发审查成员 → 按需限次返修（0–2 轮）
        ↓
汇总交付：
  - Artifact 模式（默认）：团长调用现有 result_present 生成主 Artifact（自动关联 teamRunId） + 简短会话说明
  - 仅会话模式：团长直接输出结构化汇总回复
        ↓
父会话 Turn afterIdle：卸载 expert_team_dispatch 附件 + Host 根据客观执行/审查/Artifact 记录自动结算终态
```

### 4.3 优化后的核心数据模型

#### 4.3.1 专家团定义（`ExpertTeam`）

将原规格中空洞的自由文本调度字段与破坏包能力的 `workspaceAccess` 替换为**对齐原始需求的结构化简单调度规则**：

```ts
export type ExpertTeamAssignmentMode =
  | 'by-responsibility' // 按成员职责拆解并分配子任务（默认）
  | 'broadcast'         // 各执行成员独立处理同一完整任务（多视角会诊/对比）

export type ExpertTeamExecutionOrder =
  | 'sequential'        // 按成员列表顺序依次执行，后序成员自动获得前序结果
  | 'parallel'          // 无前置依赖的执行成员并行执行（默认）
  | 'dynamic'           // 由团长根据任务与中间结果动态决定先后与补派

export type ExpertTeamReviewMode =
  | 'none'              // 不设独立审查步骤
  | 'unified'           // 各执行成员完成后，由审查成员对产出一并审查（默认，当含 reviewer 成员时）
  | 'per-member'        // 每个执行成员的结果逐一交由审查成员审查

export type ExpertTeamSummaryMode =
  | 'integrated'               // 综合结论报告（默认）
  | 'by-member'                // 按成员分列结论与审查意见
  | 'integrated-with-appendix' // 综合结论 + 各成员明细附录

export type ExpertTeam = {
  schemaVersion: 1
  id: string                    // UUID
  slug: string                  // 专家团命名空间内唯一（小写字母/数字/连字符，1-32 字符），创建后锁定
  name: string                  // 中文/显示名称，1-40 字符
  description: string           // 简介，1-200 字符
  scenarios?: string            // 适用场景，最长 500 字符
  enabled: boolean
  /** 成员列表（2-8 人）；列表顺序即 sequential 模式下的默认执行顺序，UI 支持上下移动排序 */
  members: ExpertTeamMember[]
  orchestration: {
    assignmentMode: ExpertTeamAssignmentMode
    executionOrder: ExpertTeamExecutionOrder
    maxParallel: 1 | 2 | 3 | 4  // 默认 2（sequential 模式下固定按 1 执行）
    instructions?: string       // 可选：补充的自定义分发与顺序要求（最长 500 字符）
  }
  review: {
    mode: ExpertTeamReviewMode
    maxRevisionRounds: 0 | 1 | 2 // 默认 1（mode === 'none' 时忽略）
    criteria?: string            // 可选：审查标准与关注重点（最长 500 字符）
  }
  summary: {
    delivery: 'artifact' | 'message'    // 默认 'artifact'
    artifactFormat: 'markdown' | 'html' // 默认 'markdown'
    mode: ExpertTeamSummaryMode
    instructions?: string               // 可选：汇总重点要求（最长 500 字符）
  }
  createdAt: string
  updatedAt: string
}
```

#### 4.3.2 团队成员（`ExpertTeamMember`）

```ts
export type ExpertTeamMember = {
  memberId: string              // 团队内稳定 UUID
  agentRef: {
    source: 'local' | 'catalog'
    slug: string
  }
  role: 'executor' | 'reviewer'
  responsibility: string        // 必填（1-300 字符）：该成员在团内的职责边界
  outputInstructions?: string   // 可选（最长 300 字符）：该成员的输出格式或侧重点要求
}
```

**成员与审查一致性约束**：
- 同一 `source + slug` 在同一团队只能出现一次，成员总数 `2..8`。
- 至少包含 1 名 `role === 'executor'` 的成员。
- 当 `review.mode !== 'none'` 时，必须至少包含 1 名 `role === 'reviewer'` 的成员；当团队中没有 `reviewer` 成员时，`review.mode` 只能为 `'none'`（编辑器在切换时自动联动提示）。

#### 4.3.3 团队运行与成员结果（`ExpertTeamRun` / `ExpertTeamResult`）

```ts
export type ExpertTeamRunStatus =
  | 'running'
  | 'stopping'
  | 'completed'
  | 'completed_with_issues'
  | 'partial'
  | 'failed'
  | 'stopped'

export type ExpertTeamRun = {
  teamRunId: string
  parentSessionId: string
  clientMessageId: string
  teamId: string
  teamSnapshot: ExpertTeam
  status: ExpertTeamRunStatus
  results: ExpertTeamResult[]
  primaryArtifactId?: string
  artifactStatus: 'not-required' | 'pending' | 'created'
  dispatchAttempts: number
  startedAt: string
  endedAt?: string
  failure?: string
  revision: number
}

export type ExpertTeamResult = {
  resultId: string
  memberId: string
  agentRef: ExpertTeamMember['agentRef']
  displayName: string
  packageVersion: string
  memberRunId: string           // 对应 subagentRuns 中的 runId，用于直接复用成员级进度与取消
  kind: 'execute' | 'review' | 'revision'
  inputResultIds: string[]
  supersedesResultId?: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped'
  output?: string
  reviewVerdict?: 'pass' | 'revise'
  startedAt: string
  endedAt?: string
  error?: string
}
```

### 4.4 结构化简单调度规则的运行时映射契约

当用户发送 `@team:<slug> <任务>` 时，Host 将 `ExpertTeam` 快照中的结构化规则编译为明确的 `<expert-team-orchestration>` 指令块注入父会话本轮消息，同时在 `expert_team_dispatch` 中做硬边界校验：

| 配置维度 | 结构化枚举值 | Host 团长指令与协调器行为 |
| --- | --- | --- |
| **任务分配方式** | `by-responsibility` | 指示团长根据各 `executor` 成员的 `responsibility` 将任务拆解为针对性子任务分别派发 |
| | `broadcast` | 指示团长将当前完整任务同时派发给所有 `executor` 成员，各自从其专业职责视角独立出具意见 |
| **执行顺序** | `sequential` | 强制实际并发上限为 `1`；指示团长按成员列表顺序依次调用 `expert_team_dispatch`，并在调用后序成员时通过 `inputResultIds` 传入前序成员的 `resultId` |
| | `parallel` | 允许团长在同一 step 并行发起多个 `expert_team_dispatch`（`isConcurrencySafe` 返回 `true`，有效并发上限 `min(team.maxParallel, maxParallelToolCalls, 剩余全局子智能体容量)`） |
| | `dynamic` | 允许团长先并行或串行派发初批成员，再根据返回结果动态决定是否补派其他成员 |
| **审查流程** | `none` | 不允许发起 `kind: 'review'` 或 `'revision'` 派工；所有所需 `executor` 完成后直接进入汇总 |
| | `unified` | 所有首轮 `execute` 完成后，团长将所有有效执行结果的 `resultId` 作为 `inputResultIds` 一并传给 `reviewer` 成员审查；若有审查员返回 `revise` 且未超 `maxRevisionRounds`，团长派相关 `executor` 执行 `revision`（带 `supersedesResultId`）并重新送审 |
| | `per-member` | 每个未被替代的 `execute`/`revision` 结果均需交由 `reviewer` 审查；未通过且在额度内则触发对应成员 `revision` |
| **结果汇总方式** | `integrated` / `by-member` / `integrated-with-appendix` | 指示团长按所选结构组织最终报告；若 `delivery === 'artifact'`，必须调用一次 `result_present` 生成指定格式（`markdown` 或 `html`）的主 Artifact，随后在会话中仅输出简短完成说明与未解决项提示 |

### 4.5 权限模型与同会话并行无竞态隔离（根治 C-1、C-2、I-1、M-1）

1. **成员权限回归智能体包本位（解决 C-1）**：
   - 每个被派发的成员子智能体，其工具白名单直接由 `composeAgentPackageToolAllowList(manifest, mcpNames, runtime.skillScripts)` 生成（`runtime.ts:168-188`），其 HTTP/MCP/技能脚本子进程继续在 `sandbox.confine(..., { mode: 'workspace-write', workspaceRoot })` 沙箱内运行（`runtime.ts:485-489`）。
   - 成员在编辑器中的可用工具一目了然（展示包自身声明的 HTTP/MCP/脚本能力），不再因“默认只读”或“审查角色”而被暗中剥夺工具。
2. **废除强制 `outputSchema`，采用轻量结论标记解析（解决 C-2）**：
   - `startActivation` 不传 `outputSchema`，子智能体不挂载 `structured_output` 工具，彻底规避 `policy.ts:115` 与 `decide.ts:145` 的护栏拦截及 `activation.ts:159` 的 `completed → error` 误判。
   - 成员执行结果直接取 `SubagentResult.output` 文本。
   - 当 `kind === 'review'` 时，Host 在拼装给审查子智能体的提示词末尾附加固定格式要求：
     > 请在审查结论的最后一行单独输出 `【审查结论：通过】`（或 `[VERDICT: PASS]`）或 `【审查结论：需修改】`（或 `[VERDICT: REVISE]`），并列出具体依据与修改建议。
   - Host 从审查输出文本中解析 `reviewVerdict: 'pass' | 'revise'`（若包含明确需修改标记或未识别出通过标记，则 fail-closed 记为 `'revise'`，确保不会把模糊审查当成通过）。
3. **同会话多成员并行隔离（解决 I-1）**：
   - 在 `agent-package/host.ts` 新增团队成员派发入口 `dispatchTeamMember(input)`（保留原 `dispatch(input)` 给普通单智能体 `@<slug>` 使用，原 `pendingTurns.get(sessionId)` 行为零改动）。
   - `dispatchTeamMember` 内部：
     1. **预先分配 `reservedChildId`**：在调用 `createRuntime` 之前生成 `reservedChildId = brandString<SessionId>(randomUUID())`；
     2. **MCP 直接绑子会话**：`mountMcp` 中调用 `mountSessionMcp({ ctx, sessionId: reservedChildId, serverName: `${pkg.slug}__${reservedChildId.slice(0, 8)}`, url })`——既避免同团队两个成员使用相同 `serverName` 导致 `mcp__<serverName>__*` 全局工具名冲突，又全程不触碰父会话 `sessionId` 的附件表！
     3. **Runtime 只绑子会话**：只调用 `registry.bind(reservedChildId, runtime)`（及 `activation.childId`），绝不调用 `registry.bind(parentSessionId, runtime)`；
     4. **请求传递改为按 `reservedChildId` 索引的 Map**：在 `ctx.huaanworkAgentPackageRequestsByChild`（`Map<string, AgentPackageSubagentRequest>`）中按 `reservedChildId` 存取请求，`skills.ts` 的 `startActivation` 包装器优先按 `specChildId` 从 Map 精确消费并清理，与旧单槽 `huaanworkAgentPackageRequest.current` 完全兼容且并发零竞态。
4. **团长工具策略放行（解决 M-1）**：
   - `expert_team_dispatch` 加入 `huaanwork-guardrails/policy.ts` 的 `SESSION_ATTACHED_TOOLS`；
   - `packages/huaanwork-policy/src/decide.ts` 增加 `case "expert_team_dispatch": return input.attached ? ALLOW : deny(reasonToolUnattached(input.name));`，在用户在场发起的 `@team:<slug>` 回合中无需每次派工弹窗审批。

### 4.6 `expert_team_dispatch` 协议与 Turn `afterIdle` 自然收口（根治 I-3）

#### 4.6.1 唯一新增模型工具：`expert_team_dispatch`

```ts
type ExpertTeamDispatchArgs = {
  memberId: string              // 团队快照中的 memberId（或成员 agent slug，Host 兼容解析）
  kind: 'execute' | 'review' | 'revision'
  task: string                  // 团长给该成员的具体任务指令
  inputResultIds?: string[]     // 显式引用的前置成员 resultId 列表
  supersedesResultId?: string   // kind === 'revision' 时必填：被返修替代的原结果 resultId
}
```

- **并发声明**：`isConcurrencySafe: () => true`（允许上游 `agent-loop` 在同一 step 并行发起多次调用；实际并发度由 Host 团队协调器按 `effectiveMaxParallel` 信号量排队控制，且同一 `memberId` 同一时刻只允许 1 个在途运行）。
- **硬预算与输入边界**：
  - 每次 `ExpertTeamRun` 最多允许 **24 次** `expert_team_dispatch` 调用（到达协调器即计数，防止错误无限重试）。
  - 拼装给成员的提示词（`task` + 成员团内职责与输出要求 + `inputResultIds` 渲染文本）总字节上限为 **256 KiB（UTF-8）**；超限时拒绝本次派工并提示团长精简引用，不静默截断。
- **返回给团长的结构**：
  - 返回 `{ resultId, memberId, agentSlug, kind, status, reviewVerdict?, output }` 渲染文本，团长可据此决定下一步是送审、返修还是汇总。

#### 4.6.2 复用 `result_present` 与 Turn `afterIdle` 自动结算终态

- **不新增 `expert_team_finish` 工具**。
- **Artifact 关联钩子**：
  - 在 `result-artifact-tools.ts:109-111` 的 `commitPreparedArtifact` 成功后，调用可选钩子 `ctx.huaanworkExpertTeamRuns?.noteSessionArtifact(sessionId, artifact.artifactId)`，将本轮生成的 `artifactId` 写入该父会话当前 `running` 的 `ExpertTeamRun.primaryArtifactId`（若同一轮多次调用，保留最新一份或首份有效主报告）。
- **父会话 Turn `afterIdle` 终态自动判定规则**：
  当父会话本轮 `afterIdle` 触发时，先卸载父会话的 `expert_team_dispatch` 附件并取消任何异常滞留的在途成员，随后由 Host 按客观记录一次性计算 `ExpertTeamRun.status`：
  1. 若用户已触发整团取消（`cancelRequested`）：终态为 **`stopped`**。
  2. 若没有任何一个 `kind === 'execute' | 'revision'` 的成员结果达到 `completed`：终态为 **`failed`**。
  3. 检查是否有未完成的技术性缺失：
     - 存在失败/被取消且未被后续成功结果替代的执行或审查派工；
     - `review.mode !== 'none'` 时，最新的有效执行/返修结果尚未经过全部 `reviewer` 成员审查；
     - 审查结论含 `'revise'`，且当前已返修轮数 `< review.maxRevisionRounds`（即额度未用尽却提前停下未返修）；
     - `summary.delivery === 'artifact'` 时，`primaryArtifactId === undefined`（未成功调用 `result_present` 生成主 Artifact）。
     - 若存在上述任一缺失：终态为 **`partial`**。
  4. 若技术流程与交付均完整：
     - 若最新一轮审查中仍有审查员给出 `'revise'`（此时返修额度已用尽）：终态为 **`completed_with_issues`**；
     - 否则（无审查，或最新一轮审查全员 `'pass'`）：终态为 **`completed`**。

### 4.7 状态投影、进度协同与取消（对齐 `subagent-runs.ts`）

- **纯内存权威注册表（解决 M-2）**：
  - `ExpertTeamRunRegistry` 维护内存中活跃与近期终态的 `ExpertTeamRun`（每父会话保留最近 20 条终态，全局最多 100 条），通过 `expertTeam/run` 与 `expertTeam/run-remove` 事件向客户端广播增量，客户端重连时通过 `expertTeam.runList({ sessionId })` 快照对账。
- **与现有子智能体进度面板无缝复用**：
  - 每个成员派工在 `subagentRuns` 中都有真实的 `memberRunId`（label 形如 `@team:<teamSlug>/<memberSlug>`），因此现有的工具/子智能体进度机制天然能追踪每个成员的 token、reasoning、工具调用与清理警告。
  - 会话流中的**专家团聚合运行卡**通过 ` clientMessageId` 锚定在用户消息下方，汇总展示团队状态、已派工/进行中/已完成/审查/返修计数、扁平成员结果列表（可展开查看单成员输入输出与审查意见）以及主 Artifact 快捷入口。
- **两级取消**：
  - **单成员取消**：直接复用现有 `subagent.cancel(parentSessionId, memberRunId)`，该成员的 `expert_team_dispatch` 返回已取消状态给团长，由团长决定继续或收尾。
  - **整团取消**：调用 `expertTeam.cancel(parentSessionId, teamRunId)`，协调器立即置 `stopping` 闩、拒绝新派工、并行触发所有在途成员的 `cancelTurn('cancel')` 并调用父会话 `agent.cancel({ kind: 'user' })`，全部成员清理确认后收敛为 `stopped`。

---

## 5. 原规格 [`2026-11-21-expert-team-design.md`](./2026-11-21-expert-team-design.md) 逐节修订清单

在进入 `writing-plans` 之前，按以下清单修订原规格文档即可完成闭环：

| 原规格章节 | 修订动作 | 具体修改内容 |
| --- | --- | --- |
| **§1 背景与结论** | 替换核心链路图 | 将链路图中的 `expert_team_finish：Host 验证结果并提交主 Artifact` 替换为 `汇总交付：复用 result_present 提交主 Artifact（或会话回复） → Turn afterIdle Host 自动验证并结算终态` |
| **§3 已确认裁定** | 修订 R5、R7、R8、R9 | - **R5**：改为“成员继承其智能体包自身声明的工具集与沙箱边界，团队不额外扩权，也不设剥夺包工具的团队级只读锁”<br>- **R7**：改为“支持‘不启用 / 汇总前统一审查（默认）/ 逐成员结果审查’三种模式；启用审查时审查角色构成必审名单”<br>- **R9**：改为“主 Artifact 由父会话复用 `result_present` 统一提交并自动关联当前 `teamRunId`，成员不直接创建 Artifact，不另建 `expert_team_finish`” |
| **§5 已核实现状** | 订正第 99、105、106–108、112、114 行 | - 删除第 105 行“使用上游 `outputSchema` 强约束成员输出”（登记 C-2：`structured_output` 与现有 `policy.ts`/`decide.ts` 冲突）<br>- 删除第 106–108 行“只读派工移除 shell/脚本/HTTP/MCP”<br>- 删除第 112 行“新增 `teamRunId` Artifact 幂等作用域”<br>- 第 99 行补充 `agent-package/host.ts` 中 `registry.bind(sessionId)`、`mountMcp(sessionId)` 与 `huaanworkAgentPackageRequest` 的子会话级隔离改造说明 |
| **§6 总体架构** | 精简组件 2、4 | - 组件 2（团队运行协调器）：改为纯内存权威状态机（与 `subagent-runs.ts` 同构），删除运行快照落盘与跨重启反查 Artifact<br>- 组件 4（智能体包派发适配层）：写明按预留 `reservedChildId` 唯一绑定 runtime、MCP 与 request Map，不绑定父会话 `sessionId` |
| **§8 核心数据对象** | 更新 §8.1–§8.5 | - §8.1 `ExpertTeam`：加入 `assignmentMode`、`executionOrder`、`review.mode` 结构化枚举，删除 `workspaceAccess`<br>- §8.3 `ExpertTeamRun`：删除 `finishAttempts`、`finishFingerprint`、`artifactError`、`interrupted` 状态<br>- §8.4 `ExpertTeamResult`：删除 `access: 'read' | 'write'` 与 `structured`<br>- §8.5：保留团队定义（`expert-teams/*.json`）原子持久化与损坏 fail-closed；删除团队运行快照落盘与启动反查恢复段落 |
| **§10 调度、权限、审查与汇总规则** | 重写 §10.1–§10.4 | - §10.1：写明结构化调度枚举（`by-responsibility` / `broadcast`、`sequential` / `parallel` / `dynamic`）与补充说明的组合方式<br>- §10.2：保留 24 次 `expert_team_dispatch` 预算与并发控制；删除 3 次 `finish` 预算与团队读写互斥锁<br>- §10.3：改为“成员权限回归智能体包本位”，删除只读模式剥夺 `agent_http`/`agent_skill_run`/`MCP` 的规则<br>- §10.4：支持 `unified`（汇总前统一审查，默认）与 `per-member`（逐项审查）两种审查模式 |
| **§12 运行协议** | 精简 §12.3，重写 §12.4 | - §12.3 `expert_team_dispatch`：删除 `access` 参数与 `outputSchema`，写明 `isConcurrencySafe: () => true` 与轻量审查结论标记解析<br>- §12.4：将 `expert_team_finish` 整节替换为“复用 `result_present` 交付主 Artifact + 父会话 Turn `afterIdle` 自动完成度结算” |
| **§15–§18 模块关系、不变量、边界与测试** | 同步清理 | - 增加 `packages/huaanwork-policy/src/decide.ts` 与 `huaanwork-guardrails/policy.ts`（`SESSION_ATTACHED_TOOLS`）对 `expert_team_dispatch` 的放行声明<br>- 删除 `expert-team-outcome-mismatch`、`expert-team-finish-conflict`、`workspaceAccess` 读写锁、`outputSchema` 相关的边界行与测试项，补充同会话双 MCP 成员并行隔离测试与 `result_present` 自动关联 `teamRunId` 测试 |

---

## 6. 核实用源码证据索引

- **智能体包派发、运行时与工具集**：
  - `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:49-95`（`createAgentPackageRuntimeRegistry`）、`:168-188`（`composeAgentPackageToolAllowList`，基础工具与 `agent_skill_run`/`agent_http`/`mcpNames`）、`:478-519`（`spawnConfined` 沙箱边界）
  - `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:532-608`（`dispatch` 与 `pendingTurns`）、`:765-838`（`bindChild` / `releaseChildBindings` / `clearTurnLineage`）、`:851-913`（`cleanup` 中 `:893` `mcpDispose` 与 `:901` `registry.delete(sessionId)`）、`:1012-1095`（`createRuntime`、`mountMcp(sessionId)`、`reservedChildId`、`registry.bind(sessionId, runtime)`、`huaanworkAgentPackageRequest.current`）、`:1098-1164`（`startActivation` 与 `delivery: 'parent'`）
- **护栏、工具可见性、MCP 挂载与策略门禁**：
  - `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:16-43`（`ALLOWED_TOOLS`）、`:127-160`（`restrictInternal` 动态重算）
  - `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:24-32`（`SESSION_ATTACHED_TOOLS`）、`:113-154`（`huaanworkPackageChildAllow` 对 scope 本地工具如 `structured_output` 不豁免）、`:248-278`（`toToolCall` 的 `attached` 计算）
  - `packages/huaanwork-policy/src/decide.ts:92-147`（工具放行 switch 与 `:144-145` `default` 分支未挂载必拒）
  - `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-mcp.ts:94-149`（`mountSessionMcp` 读全局 `tools.schemas()` 并按传入 `opts.sessionId` 挂载/卸载附件）
  - `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:255-299`（`agent_skill_run` 与 `agent_http` 均按执行 agent 的 `childSessionId` 查找 `registry`）
  - `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:900-974,991-1000`（`startActivation` 包装器消费 `huaanworkAgentPackageRequest.current` 与 C4 血缘继承）
- **结果页 Artifact、会话发送与子智能体运行状态机**：
  - `dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts:77-117`（`result_present` 工具实现）、`:149-165`（`makeResultPresentClaimed` 在 `agent/inbox/claimed` 同步挂载 `result_present`）
  - `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts:46-65,122-141,377-541`（Artifact 写入与幂等作用域）
  - `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:21-100`（内存权威状态机与有界淘汰）
  - `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:478-590`（`dispatchAt`、`turnAnchors.register`、`agent.followup` 与 `afterIdle` 时序）
  - `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts:82-147`（`@` 解析与智能体包分流）
  - `dsh-plugin-huaanwork/src/client-huaanwork/logic/agentsLogic.ts:39-83`（客户端 `@` 词法与补全过滤）
- **上游 `deepseek-harness` 子智能体契约**：
  - `deepseek-harness/packages/subagent/subagent/src/types.ts:30-59,135-183`（`SubagentActivationSpec`、`delivery: 'parent' | 'caller'`、`outputSchema`）
  - `deepseek-harness/packages/subagent/subagent/src/structured.ts:19-30,56-100`（`STRUCTURED_OUTPUT_TOOL = 'structured_output'` 及强制调用提示词）
  - `deepseek-harness/packages/subagent/subagent/src/activation.ts:150-162`（`captureLocalResult`：启用 `outputSchema` 但未捕获 `structured_output` 时将 `completed` 强制改为 `error`）
  - `deepseek-harness/packages/subagent/subagent/src/manager.ts:897-902,1186-1205`（`attachStructuredRuntime` 与 `caller` 投递不发父会话通知）

---

## 7. 复审记录（2026-11-22 第二轮：修订稿复核）

- 复审日期：2026-11-22
- 复审对象：Claude 根据本文 §1–§5 修订后的 [`2026-11-21-expert-team-design.md`](./2026-11-21-expert-team-design.md) 全文（780 行）
- 方法：逐项核对首轮 7 项发现的吸收闭环度 + 逐条对源码反证修订稿所有新增技术断言与边界规则 + 评估 LLM 实际执行稳定性与实现计划接线清晰度
- 复审判决：**With fixes**。首轮全部 7 项发现已闭环，且修订稿反向补强了 4 处真实边界；但新增条文引入 **1 项 Critical（R2-C1）**、**2 项 Important（R2-I1、R2-I2）**，另识别出 **3 项高价值优化（R2-O1~R2-O3）**。修正 R2-C1、R2-I1、R2-I2 后，规格即达可直接进入 `superpowers:writing-plans` 的高质量基线。

### 7.1 首轮发现闭环核对与修订稿反向加分项

| 首轮项 | 修订落点 | 复审结论 |
| --- | --- | --- |
| C-1 包原生权限（废除团队只读锁） | §2.1、§3 R5、§8.1/§8.4、§10.3、§18.2 | **已闭环** |
| C-2 废除强制 `outputSchema` / `structured_output` | §2.2、§5（第 113–114 行）、§10.4、§12.3、§18.2 | **已闭环** |
| I-1 同会话并行按子会话隔离 | §5（第 105–107 行）、§6 组件 4、§17、§18.2 | **已闭环**（且反向补强了 MCP `serverName` 32 字符上限与 `provider` 忽略 `reservedChildId` 的回退边界） |
| I-2 结构化简单调度规则 + 取消 `outcome` 握手 | §7.3、§8.1、§10.1、§10.4、§12.4.2 | **已闭环** |
| I-3 废除 `expert_team_finish`，复用 `result_present` + 自然收口 | §1、§3 R9、§5（第 120–123 行）、§12.1、§12.4 | **已闭环**（且反向补强了 `deliverySealed` 封闭与 `primaryArtifactCallId` 幂等重放） |
| M-1 `expert_team_dispatch` 接入 `SESSION_ATTACHED_TOOLS` 与 `decide()` | §5（第 117 行）、§12.1（第 491 行）、§15、§18.2 | **已闭环** |
| M-2 纯内存有界团队运行状态机 | §3 R16、§6 组件 2、§8.5、§13.3、§14 | **已闭环** |

**修订稿反向优于首轮评审稿的 4 处细节（应予保留）**：
1. **MCP `serverName` 32 字符约束与公开名规范化**：核实 `deepseek-harness/packages/mcp/mcp-client/src/index.ts:40`（`SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/`）与 `tools.ts:48-54,81-87`（64 字符上限 + 12 位 SHA-256 哈希），修正了首轮评审示例可能超 32 字符的问题（`slug.slice(0, 22) + '__' + 8 位子会话后缀`，总长 `<= 32`，且 `mcp__<32 chars>__` = 39 字符 `<= 51`，兼容 `agent-mcp.ts:118-124` 的前缀扫描）。
2. **无效审查标记与业务 `revise` 分离**：将缺失或非法末行标记记为 `reviewError = 'invalid-verdict'`（技术缺失 → `partial`），而非默认折算为 `revise`，防止 `maxRevisionRounds = 0` 时把格式异常误算为 `completed_with_issues`。
3. **显式处理 `SubagentResult.output` 为 `readonly ContentBlock[]`**：纠正了将其视为裸字符串的假设（但文本提取过滤规则引入了下方 R2-C1，需收窄修复）。
4. **主 Artifact 交付封闭与持久锚重放**：引入 `deliverySealed`、`primaryArtifactCallId` 与 `artifact.anchor` 校验，堵住了主报告 commit 后继续派工或产生第二份主报告的漏洞。

### 7.2 第二轮发现清单（必修问题）

#### R2-C1（Critical）混合 `ContentBlock[]` 出现任意非 `text` 块即判 `unsupported-output` 失败，会导致所有思考模型 100% 不可用

- **规格位置**：§2.2（第 59 行）、§8.4（第 320 行）、§17（第 708 行）、§18.1（第 737 行）：
  > “首期文本协议只接受 `type === 'text'` 的块，按原顺序以空行拼接。出现任何非文本块时，即使同时包含文本，也记 `error = 'unsupported-output'`……这两种团队成员结果的 `status` 都必须置为 `failed`。”
- **源码反证**：
  1. `deepseek-harness/packages/llm/llm/src/types.ts:137-145` 定义 `ContentBlockMap` 包含 `'reasoning': ReasoningBlock`；
  2. `deepseek-harness/packages/llm/llm/src/assembler.ts:108-112,135-140` 会把思考模型的推理过程直接组装为 `{ type: 'reasoning', text: partial.text }` 并放入 `assistant/message` 的 `content` 数组；
  3. `deepseek-harness/packages/subagent/subagent/src/assistant-output.ts:32-36,56` 的 `finalAssistantOutput()` 直接返回 `event.data.message.content`，**不会剥离 `reasoning` 块**；
  4. 因此上游自身在 `deepseek-harness/packages/subagent/subagent/src/continuation-messages.ts:147-149` 渲染子代理结果时显式采用 `terminal.output.flatMap(block => block.type === 'text' && block.text.length > 0 ? [block] : [])`，主动忽略 `reasoning` 块。
- **后果**：在 DeepSeek Reasoner / 开启思考模式的模型下，正常成员的 `SubagentResult.output` 几乎恒为 `[{ type: 'reasoning', ... }, { type: 'text', ... }]`。按当前规格实现将把所有思考模型成员的正常结果 **100% 判为 `unsupported-output` 失败**。
- **修法**：明确区分**思考元数据块**与**非文本内容负载**——提取成员文本时**忽略 `type === 'reasoning'`**（不作为错误也不拼入结果正文）；仅当 `ContentBlock[]` 中出现既非 `text` 又非 `reasoning` 的块（如 `image`、`file`、`tool-call` 或未知块）时，才记 `error = 'unsupported-output'` 且 `status = 'failed'`；同步更新 §2.2、§8.4、§17 与 §18.1 单元测试用例（增加“`reasoning + text` 正常通过、纯 `reasoning` 报 `empty-output`、`text + image/file` 报 `unsupported-output`”）。

#### R2-I1（Important）§5 第 124 行与 §12.4.2 第 584 行把 `sessions.ts` 的 `whenIdle()` 与 `afterIdle()` 执行顺序写反

- **规格位置**：§5（第 124 行）与 §12.4.2（第 584 行）：
  > “会话 cleanup 先等待 `afterIdle`，再等待 `acceptedAgent.whenIdle()`……不能只在较早的 `afterIdle` 回调中读取成员结果。”
- **源码反证**：
  - `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:200-224` 中，`scheduleDetachAfterIdle()`（`:219-224`）**先在 `:222` 等待第一次 `acceptedAgent.whenIdle()`**，resolve 后才调用 `cleanup()`；`cleanup()` 内 `:207` 才执行 `await afterIdle()`，`:208` 的第二次 `whenIdle()` 仅服务于旧 `delivery: 'parent'` 摘要消息唤醒父会话的场景；
  - `deepseek-harness/packages/core/agent-loop/src/agent.ts:225-242` 证实 `agent.followup()` 同步切换 `phase = 'running'` 并替换 `activityDone`，因此 `:222` 的第一次 `whenIdle()` 已经完整等待了父会话主回合及其全部 `caller` 派工和 `result_present` 调用 settle。
- **修法**：
  1. 订正 §5 第 124 行与 §12.4.2 第 584 行的现状描述与结算点定义：团队终态结算直接放在 `sessions.ts` 的 `afterIdle` 回调内即可（它天然位于父会话首次 `whenIdle()` 之后、`releaseOnce()` 释放回合名额之前），无需在 `:208` 之后另设第二套回调。
  2. 同步补齐 `followup` 受理前异常的防重入约定：若 `resolveAgent()` 或 `agent.followup()` 抛错（`followupAccepted === false`），原地同步将团队运行置为 `failed`、清理团队附件与 pending anchor，并将 `afterIdle` 置回 `undefined`（或由幂等守卫保证 `finally` 中的 `scheduleDetachAfterIdle()` 不重复结算）。

#### R2-I2（Important）24 次派工预算耗尽时，§12.4.1 的 `result_present` 提交前守卫会阻断“部分报告”交付形成死锁

- **规格位置**：§12.4.1（第 562 行）：
  > “`broadcast` 团队不存在从未派工的执行成员；每项已经产生的必审义务都必须有有效结论或明确的失败、停止、无效标记记录……当前 `unified` 审查轮 / `per-member` 结果链仍有返修额度却未执行必要返修时，同样拒绝提交并返回可操作的团队流程错误。”
- **死锁路径**：若团队在运行中途（如成员多次失败重试或审查多次输出 `invalid-verdict`）耗尽了 24 次 `expert_team_dispatch` 预算，此时团长已无法继续派工补齐缺失执行员、缺失必审员或必要返修；当团长试图调用 `result_present` 交付一份如实披露问题的部分报告（`partial`）时，又被 §12.4.1 第 562 行拦截拒绝——导致派工与交付双向锁死，用户拿不到部分报告 Artifact。
- **修法**：在 §12.4.1 增加明确豁免——**当 `dispatchAttempts >= 24`（派工预算已耗尽）、当前无在途派工（含等待队列）且至少有 1 份有效执行结果时，豁免“缺执行员 / 缺必审 / 缺返修”的提交前拒绝，放行 `result_present` 提交如实披露问题的部分报告**，并由回合结算按 §12.4.2 诚实判定为 `partial`；在 §17 和 §18.1 补充对应边界与单元测试。

### 7.3 高价值优化建议（强烈建议一并吸收）

#### R2-O1 精简 `expert_team_dispatch` 必填参数，消除 LLM 抄错 UUID 白扣预算
1. **去掉必传 `teamRunId`（§12.3 第 510 行）**：同一父会话同时最多只有 1 个活动团队（§11.2），应与 `result_present`、`agent_http`、`agent_skill_run` 保持一致——由 Host 根据 `exec.agent` 解析 `parentSessionId` 并绑定该父会话当前唯一活跃的 `teamRunId`（移除该入参，或改为可选一致性校验参数），既避免模型抄错 UUID 白扣 24 次预算，又消除跨运行入参伪造面。
2. **`unified` 审查允许省略 `inputResultIds`（§10.4 第 410 行、§12.3 第 514/525 行）**：既然 `unified` 每次送审的 `inputResultIds` 必须与 Host 独立算出的“当前有效结果全集”严格相等，要求 LLM 每次手工拼写一组 UUID 极易漏传或误传被替代的旧 ID 而白扣预算。改为 **`unified` 审查省略 `inputResultIds` 时由 Host 自动填充当前有效结果全集**（模型显式传入时仍执行全集相等校验），显著降低协议失败率。

#### R2-O2 补齐 2 个父会话观测信号的明确接线点（避免 `writing-plans` 歧义）
1. **仅会话模式“非空最终助手汇总”的精确判定口径（§12.4.2 第 597 行）**：现有代码库不缓存父会话本轮最终文本，且不能直接统计 `bridge.ts:308` 的整轮 `token` 流（团长在首次派工前输出的过渡语如“我先安排两位专家分析”会导致假阳性）。规格应在 §12.4.2 写明：结算时仅检查**本轮最后一次工具结果（或最后一步 `step/start`）之后**父会话产出的非空助手 `text` 块（同样忽略 `reasoning` 块，可从 `acceptedAgent.session` 读取或按本轮末步追踪）。
2. **父会话 `abort` 联动整团取消的明确挂点（§12.4.2 第 590 行、§13.3 第 638 行）**：用户点击会话输入框的“停止生成”走的是 `session.cancel` / `agent.cancel`，不经过 `expertTeam.cancel`。建议在 §12.1 / §13.3 明确写出：由 `session.cancel` 路由（及 `bridge.ts:219-225,279-282` 的 `turn/end: aborted` / `agent/error: isAbortError`）联动触发 `expertTeamRuns.cancelBySession(sessionId)`，保证等待队列与在途成员即时收尾。

#### R2-O3 明确 `teamRun.clientMessageId` 提前复用 `resolveFollowupClientMessageId(params)`
- **证据**：`dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:523,1026-1028` 中，`resolveFollowupClientMessageId(params)`（`objectTopLevelClientMessageId(params) ?? randomUUID()`）才保证返回非空 UUID，且目前计算位置在 `dispatchAt`（`:486`）之后。
- **建议**：在 §12.1 写明团队发送分支提前计算 `followupId = resolveFollowupClientMessageId(params)`，使 `teamRun.clientMessageId`、`turnAnchors.register` 与 `agent.followup({ id: followupId })` 共享同一非空锚点，避免非 UI RPC 调用省略 `clientMessageId` 时锚点错位。

### 7.4 第二轮核实用新增源码证据索引

- `deepseek-harness/packages/llm/llm/src/types.ts:137-150`（`ContentBlockMap` 含 `'reasoning': ReasoningBlock`）
- `deepseek-harness/packages/llm/llm/src/assembler.ts:108-140`（思考块 `{ type: 'reasoning', text }` 拼入 `assistant/message` 的 `content`）
- `deepseek-harness/packages/subagent/subagent/src/assistant-output.ts:32-59`（`finalAssistantOutput` 原样返回 `event.data.message.content`，不剥离 `reasoning`）
- `deepseek-harness/packages/subagent/subagent/src/continuation-messages.ts:147-149`（上游对 `terminal.output` 显式过滤 `block.type === 'text'`）
- `deepseek-harness/packages/mcp/mcp-client/src/index.ts:39-60,154-177`（`SERVER_NAME_PATTERN` 32 字符限制与 `activeServerNames` 冲突检测）
- `deepseek-harness/packages/mcp/mcp-client/src/tools.ts:44-87,113-162`（`publicToolName` 64 字符上限 + 12 位哈希与注册回滚）
- `deepseek-harness/packages/core/agent-loop/src/agent.ts:215-242`（`ensureDriver` 同步建立 `activityDone`、`whenIdle()` 语义）
- `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:195-224,523-589,1026-1033`（`scheduleDetachAfterIdle` 先等 `whenIdle()` 再跑 `cleanup() → afterIdle()`；`resolveFollowupClientMessageId`）
- `dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts:73-110`（`register` 与 `notePreStep` 锚点匹配）
- `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:193-290,305-312`（`turn/end: aborted`、`agent/error: isAbortError` 与 `token` 流）

---

## 8. 复审收口（2026-11-22 第三轮：通过）

- 复审日期：2026-11-22
- 复审对象：二轮修订后的 [`2026-11-21-expert-team-design.md`](./2026-11-21-expert-team-design.md) 全文（799 行）
- 复审判决：**Approved（通过）**。0 Critical / 0 Important / 0 待闭环项；规格已达可直接进入 `superpowers:writing-plans` 的质量基线。

| 第二轮项 | 修订落点 | 收口复验结论 |
| --- | --- | --- |
| **R2-C1** `reasoning` 块处理 | §2.2、§5（:112）、§8.4（:324）、§12.3、§17、§18.1 | **已闭环**：`reasoning + text` 正常提取文本，纯 `reasoning` 记 `empty-output`，`image`/`file`/`tool-call`/未知块记 `unsupported-output` |
| **R2-I1** 清理时序与结算点 | §5（:126）、§12.1（:491,:495）、§12.4.2（:591-595）、§18.2 | **已闭环（且更优）**：准确订正 `whenIdle`/`afterIdle` 顺序，以当前 `turn/end` 同步封闭隔离 `goal-round-driver` 续拍窗口，`afterIdle` 仅作清理与缺失 `turn/end` 的 fail-closed 兜底，并补齐 followup 前异常防重入 |
| **R2-I2** 24 次预算耗尽豁免 | §12.4.1（:570）、§17（:730）、§18.1（:755） | **已闭环**：预算耗尽且至少一份有效结果、无在途派工时放行部分 Artifact 提交并诚实结算为 `partial`，解除双向死锁 |
| **R2-O1** 精简 `expert_team_dispatch` 入参 | §10.4（:414）、§12.2、§12.3（:515-546）、§18.1 | **已闭环**：移除 `teamRunId` 入参改由 Host 按 `exec.agent` 绑定；`unified` 省略 `inputResultIds` 时入口自动填全集且出队重验不变 |
| **R2-O2** 父会话终轮文本与 `abort` 挂点 | §5（:127-128）、§12.1（:493）、§12.4.2（:597）、§13.3（:650-651）、§18.2 | **已闭环**：`session.cancel({ sessionId })` 在 `cancelAgent`（`sessions.ts:686-705`）联动 `cancelBySession` + `bridge` 兜底；仅会话模式用本轮 `session/event` 追踪最后 `tool/result` 后的 `assistant/message` 文本，遵守 `session/README.md:60-64` 禁止新增 `snapshotEvents()` 生产调用的红线 |
| **R2-O3** `resolveFollowupClientMessageId` 共享 | §5（:103）、§11.3、§12.1（:486）、§17、§18.2 | **已闭环**：提前且只计算一次，团队运行、turn anchor、Artifact 与 followup 共用同一非空 ID |

本轮补充核实源码：`deepseek-harness/packages/core/agent-loop/src/agent.ts:297-398`、`deepseek-harness/packages/goal/goal-round-driver/src/index.ts:223-310`、`deepseek-harness/packages/core/session/src/repair.ts:125-190`、`deepseek-harness/packages/core/session/README.md:60-64`、`dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:686-707,1371-1379`，所有引用均核实准确。
