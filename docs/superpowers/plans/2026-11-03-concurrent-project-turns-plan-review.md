# 《多项目并发任务》实施计划评审意见（Plan Review）

- **评审对象**：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（初版 1087 行；历次修订 1261、1282、1425、1476、1485、1522 行）
- **对照基准**：
  - 设计规格：`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`（当前 366 行；§十一评审时为 358 行；§十评审时为 356 行）
  - 规格评审：`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design-review.md`（112 行）
  - 代码基线：`dsh-plugin-huaanwork/` 与上游 `deepseek-harness/` 当前源码及测试套件
- **评审日期**：2026-11-04
- **评审方式**：只读源码与测试核验（含初审结论反向自检与全量锚点复核）。未修改设计稿、实施计划或产品代码
- **首轮总结论（针对 1087 行初版）**：**未达到直接实施标准（NO-GO / ITERATE）**。存在 **14 项 Major（P1）缺陷**与 **3 项 Minor（P2）缺口**（见 §一～§五）。
- **第二轮复评结论（针对 Grok 1261 行修订版，见 §六）**：首轮 **14 项 Major 已闭环 13 项、1 项部分闭环（M-3/M-4/M-6 交界处残留），3 项 P2 全部闭环**；同时在修订新增的出队异步复检逻辑中检出 **1 处新的出队死锁缺陷**。合计还剩 **2 项局部 Major（R2-M1、R2-M2）与 1 项文件路径笔误（R2-P2-1）**。
- **第三轮终审结论（针对 Grok 1282 行修订版，见 §七）**：**已达到实施标准（GO，零阻塞项）**。第二轮余留的 `R2-M1`、`R2-M2`、`R2-P2-1` 已全部准确闭环，可直接按 `subagent-driven-development` 动工实施。
- **第四轮独立复核结论（Kimi 评审，2026-11-04，针对同一 1282 行版本，见 §八）**：**未达到实施标准（NO-GO）**。第三轮 GO 未覆盖宿主 Context 注册、自动化成功占坑、回合释放所有权、catchup 准入、完整队列重放及客户端回合身份等失败链；本节推翻第三轮“零阻塞项”的结论，计划须修订并复审后再开工。
- **第五轮修订复审结论（Kimi 评审，2026-11-04，针对 Grok 1425 行修订版，见 §九）**：**仍未达到实施标准（NO-GO）**。§八大部分问题已闭环，但直接发送的无-followup 正常早退仍会让客户端假运行，排队发送仍可能提前重置前一回合的 goal 状态；另有必填 `tabId` 未迁移测试调用的接线缺口。完成这两项 Major 与一项 Minor 后再做针对性复审。
- **第六轮自审结论（Grok 4.7，2026-11-04，针对第五轮修订后的 1476 行版本，见 §十）**：**仍未达到实施标准（NO-GO）**。§九的宿主未启动结果与 `tabId` 迁移已闭环，目标窗的开窗时点也已写入；发送前导仍会清掉正在执行回合的停止闩锁，排队消息的 `queueItemId` 也没有写回已经插入的用户消息。另有 4 项 Minor。补上这两项开放问题后再复审。
- **第七轮复核结论（Kimi 评审，2026-11-04，针对 Map 规则修订后的 1485 行版本，见 §十一）**：**仍未达到实施标准（NO-GO）**。§十的版本与 Map 论据需勘误，但其 NO-GO 方向成立。当前剩 G-M1 的停止闩锁、goal 中间结束和 stale epoch 三项，G-M2 的 `queueItemId` 写回，以及 4 项 Minor；“应答前设置执行态”已由 Global Constraints 禁止，不再单列为开放项。
- **第八轮复审结论（Grok 4.7，2026-11-05，针对吸收第七轮与竞态修订后的 1522 行版本，见 §十二）**：**仍未达到实施标准（NO-GO）**。§十一的 G-M1、G-M2 与 G-P2-1～G-P2-4 已闭环，应答与 WebSocket 的竞态也已写入规格和计划。还剩 **1 项 Major（R8-M1）**：`session.send` 抛错路径仍会拆掉正在执行的回合，并留下等不到应答的 pending。另有 1 项不挡开工的测试缺口（R8-P2-1）。补上 R8-M1 后再做针对性复审。

---

## 一、Double-Check 自检说明（误报撤销、口径校准与漏报补齐）

在落档本评审前，对初审全部意见逐条对照计划原文、上游 `deepseek-harness` 源码与现有测试套件进行了反向核查：

1. **撤销 1 处初审误报**：
   - 初审 P2-2 称「Task 11 的 `rg` 清单在检索 `huaanworkWorkspaceRoot.current` / `settings.base_url` / `huaanworkUnattended` 时漏检了 `policy.ts` 等文件」。
   - **复核更正**：重读计划 `:861-890` 确认，Task 11 Step 1 的 11 条 `rg -n` 命令是在 `tests/` 下核对**测试名称是否存在**，并非在 `src/` 下做源码符号清零扫描。初审把评审者自己的源码排查动作误记到了 Task 11 名下，予以撤销，并改记为 Task 11 条款表自身缺失的 5 条规格 §6/§7 必测项（见 §四 P2-1）。
2. **校准 2 处初审因果链（消除夸大，保留真实阻断）**：
   - **`policy.ts` 与 `policy-type.spec.ts`（M-7）**：若实施者只改 Task 7 列出的 4 个文件而不碰 `policy.ts`，`policy-type.spec.ts` 不会先报错；**真正当场红掉的是 Task 7 Step 4 自己执行的 `automations-host.spec.ts:476-502`**（因 `policy.ts:134` 读 `ctx.huaanworkUnattended?.current`，传入 `Map` 后恒为 `undefined`，导致无人值守白名单降级彻底失效）。而一旦按规格把 `policy.ts` 改为 `Map`，`policy-type.spec.ts` 与 `policy.cordis.spec.ts` 则必须同步更新。
   - **Task 6 `drainQueue()` 的文字与代码块不一致（M-8）**：Task 6 Step 3 代码块（`:556-559`）丢弃了 `scheduler.drainQueue()` 的返回值，但 `:567` 正文写有一句「`drainQueue` 返回的项由同一模块调用 `sendToAgent`」。复核确认真正致命的是：**宿主与客户端之间没有任何「排队项出队开始执行 / 出队启动失败」的事件通道与状态转换函数**（Task 10 自己的单测 `:802` 证明 `q1` 永远留在 `waitingIds` 且 `running` 变为 `false`），以及自动化结束时未调用 `drainQueue()`。
3. **复核新发现 5 处关键漏报（已并入 §三）**：
   - **上游 `Session.header` 被 `deepFreeze` 且字段白名单过滤**（`deepseek-harness/packages/core/session/src/index.ts:134, 1174-1185`），导致 Task 4 Step 3 的 `request.session.header.writableRoot` 方案在运行时物理不可行（见 **M-4**）。
   - **除 `policy.ts` / `question-answerer.ts` / `bridge.ts` 外，`git.ts`、`web.ts`、`agent-package/host.ts` 也在执行期硬编码读取前台根 `ctx.huaanworkWorkspaceRoot?.current`**，后台会话调 `git_commit` / `git_checkout` / `screenshot` / `@slug` 会直接操作前台项目目录（见 **M-5**）。
   - **Task 8 Step 1 新增测试 `an admission skip survives the missed grace window`（`:667-685`）与 Step 3 实现（`:701`）自相矛盾**，落盘必红（见 **M-10**）。
   - **Task 8 在调度层/路由层与 `enqueue*Automation` 内双重调用非幂等的 `admitAutomation` 导致自锁，且 `routes.ts:1181` 漏删 `agentIdle(ctx)`**（见 **M-11**）。
   - **路由契约守卫 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts` 未随路由返回值和新方法同步**（见 **M-14**）。

---

## 二、计划已核实为扎实的部分

1. **规格评审 P1-1 ~ P1-7 的主体吸收**：已将 `max_concurrent_turns` 夹紧（Task 1）、`TurnScheduler` 纯状态机（Task 2）、`writableRootForSession` 四级推导顺序（Task 3）、按会话绑定模型（Task 5）、无人值守改 `Map` 及移除 `huaanworkRouteAgent.current` 回退（Task 7）拆成独立任务。
2. **上游 `GenerateOptions.sessionId` 传递链属实**：核实 `deepseek-harness/packages/llm/llm/src/types.ts:564` 与 `agent.ts:700`，`HuaAnWorkAdapter.stream(options)` 确可直接读取 `options.sessionId`，无需改动子模块。
3. **门禁与分支纪律合乎仓库规范**：开工分支检查、`verify:aa` 串行约束、不在 `parseSettings` 内写盘等要求与 `AGENTS.md` 一致。

---

## 三、阻塞实施的 Major（P1）缺陷明细

### 3.1 网络门禁与模型绑定（对应规格 §4.1、§4.4、§5.2.1）

#### M-1｜漏改第二道全局网络门禁 `net-gate.ts`，跨模型联网判定会被全局 `settings.base_url` 误杀或漏检
- **证据链**：
  1. `dsh-plugin-huaanwork/src/huaanwork-host/index.ts:342` 安装了全局 `llm/stream` 前置监听 `installNetworkGate`（`dsh-plugin-huaanwork/src/huaanwork-host/net-gate.ts:26-34`，带 `{ global: true, prepend: true }`）。
  2. `net-gate.ts:15-18` 的 `assertStreamNetworkAllowed` 直接读取 `settings.base_url`（即全局 `active_model_id` 的地址）调用 `workNetworkGateError`。
  3. 计划 Task 5 只修改了 `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts`，完全未提 `net-gate.ts`。
- **后果**：当 `allow_network === false` 时，若全局当前模型是公网地址、而某项目任务绑定了局域网模型，请求在进入 `model.ts` 之前就会被 `net-gate.ts` 抛错拦截；反之若全局模型是内网地址而某任务绑定了公网模型，`net-gate.ts` 会放行。
- **修法**：在 Task 5 中将 `net-gate.ts` 一并改为按 `options.sessionId` 经 `resolveSessionModel`（或共享解析函数）校验本次实际模型条目的 `base_url`，并同步更新 `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts:1487-1493` 的门禁单测。

#### M-2｜`sendToAgent` 准入网络门禁仍读全局 `settings.base_url`，且 `huaanworkSessionModels` 缺少写入与清理接线
- **证据链**：
  1. 规格 §5.2.1 明文规定：「宿主侧新增 `ctx.huaanworkSessionModels: Map<string, string>`，在 `sendToAgent` 准入通过时写入，会话结束或删除时清除」「网络门禁在 `sendToAgent` 准入时即按本次选定的 `modelId` 对应的 `base_url` 判断，不再读全局 `settings.base_url`」。
  2. 现有 `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:135-137` 在 `sendToAgent` 入口写死 `workNetworkGateError({ allowNetwork: settings.allow_network, baseUrl: settings.base_url })`。
  3. 计划 Task 5 与 Task 6 Step 3（`:545-565`）既没有修改 `sessions.ts:135-137` 的网络门禁，也没有在 `sessionSend` / `sendToAgent` / `sessionRemove` 中写出 `huaanworkSessionModels.set(sessionId, modelId)` 与 `.delete(sessionId)` 的调用点。
- **修法**：在 Task 6 中明确：① `sendToAgent`（或 `sessionSend` 准入时）将 `sessionId → modelId` 写入 `huaanworkSessionModels`，并用 `resolveSessionModel` 校验该 `modelId` 的 `base_url`；② `sessionRemove` 删除会话时清理该键（注意：回合 `whenIdle` 结束时若保留绑定以支持同会话后续辅助调用或续轮，需与规格 §5.2.1 对齐说明）。

#### M-3｜子代理与 Agent 自动化的模型绑定链路断裂
- **证据链**：
  1. **子代理（规格 §4.1、§4.4、§5.2.1）**：「子代理不另占名额，沿用父回合已经占用的名额和模型绑定」。但在上游 `dsh-subagent` 中，子代理拥有独立的 `childSessionId`，其发起 `llm/stream` 时 `options.sessionId` 是 `childSessionId` 而非父会话 `sessionId`。`huaanworkSessionModels.get(options.sessionId)` 查不到子代理 id，在 Task 5 的 `resolveSessionModel`（`:457`）中会当作「无绑定」退回全局 `active` 模型。
  2. **Agent 自动化（规格 §4.4）**：「会调用模型的自动化在开始时绑定当时的全局 `active_model_id`，并在该次运行期间保持这个绑定」。计划 Task 8 在 `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts` 的 `runAgentTurn`（`:604-661`）中未将启动时的 `active_model_id` 写入 `huaanworkSessionModels`。
- **修法**：① 在 `dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts` 增加 `parentSessionOf(childSessionId): string | undefined`（可支持多级回溯到顶层父会话），`resolveSessionModel` 在 `table.get(sessionId)` 未命中时回溯 `parentSessionOf(sessionId)`；同时注意 `child-sessions.ts:43-50` 的 `callerSessionId` 是进程单槽变量，并发 `sendToAgent` 下应避免跨会话串扰；② 在 Task 8 的 `runAgentTurn` 开始时读取当前 `active_model_id` 写入 `huaanworkSessionModels.set(sessionId, activeModelId)`，`finally` 中清理。

---

### 3.2 沙箱、护栏、工具与工作区根隔离（对应规格 §4.3、§4.6、§5.1、§5.1.1、§6）

#### M-4｜Task 4 依赖的 `request.session.header.writableRoot` 与上游 `dsh-session` 冻结及白名单机制冲突，运行时不可行
- **证据链**：
  1. 计划 Task 4 Step 3（`:415`）规定：「`sandboxPolicy.resolve` 从 `request.session.header` 读取可选的 `writableRoot`；有则作为 `allowedRoot` 传入。本任务只让夹紧函数接受这个字段，会话头由 Task 6 写入。」
  2. 首先，Task 6 全文没有任何代码向 `session.header` 写入 `writableRoot`。
  3. 更关键的是，核查上游 `deepseek-harness/packages/core/session/src/index.ts:1174-1185`（`SessionStore.prepare`）与 `:134`（`validateSessionHeader`）：上游构造 `SessionHeader` 时只从 `options.meta` 白名单拷贝 9 个字段（`version`、`id`、`createdAt`、`cwd`、`parentSession`、`isSeeded`、`origin`、`delegationDepth`、`agentPreset`），其它字段一律丢弃；且 `validateSessionHeader` 立即对 `header` 执行 `deepFreeze`（历史恢复的 `validateRestoredSessionHeader` 同理）。在禁止修改 `deepseek-harness/` 的约束下，既无法通过 `meta` 传入 `writableRoot`，也无法在创建后向冻结的 `session.header` 挂载属性。
  4. 此外，`dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts:38-43` 拦截 `ctx.sessions.create` 与 `ctx.sessions.prepare` 时调用的 `withPinnedCwd(ctx, options)` 仍未传 `allowedRoot`，当后台会话在项目 B 创建而前台在项目 A 时，`withPinnedCwd` 会把新会话的 `meta.cwd` 强行夹紧回前台项目 A。
- **修法**：
  1. 在宿主 Context 上维护 `ctx.huaanworkSessionRoots: Map<string, string>`（`sessionId → writableRoot`），在 `ensureChannelAgent` / `sendToAgent` / `runAgentTurn` 激活会话前写入推导好的 `writableRoot`；
  2. `sandbox-cwd.ts` 的 `withPinnedCwd(ctx, id, options)` 与 `sandboxPolicy.resolve(request)` 通过 `id` / `request?.session?.header?.id`（若为子代理则回溯 `request?.session?.header?.parentSession` 或 `parentSessionOf`）从 `ctx.huaanworkSessionRoots`（或回退 `request?.session?.header?.cwd` 推导）获取 `allowedRoot`，传入 `pinnedCwd(ctx, requested, allowedRoot)`。

#### M-5｜护栏、Git 工具、截图工具、智能体包运行时与 Diff 广播共 6 处模块仍硬编码读取前台根 `huaanworkWorkspaceRoot.current`
- **证据链**（以下模块在回合/工具执行期均直接读取 `ctx.huaanworkWorkspaceRoot?.current ?? process.cwd()`，计划 Tasks 1–10 全部遗漏）：
  1. **`dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:198`（`toToolCall`）**：将 `ctx.huaanworkWorkspaceRoot?.current` 作为 `workspaceRoot` 传给 `@huaanwork/policy` 的 `preExecuteExplained` 与 `isGitDirty(workspaceRoot)`。当前台切到项目 A 时，项目 B 的后台会话读写项目 B 自己的文件会被 `@huaanwork/policy` 判定为「工作区外路径」而直接 `deny`！
  2. **`dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts:153`（`confirmInput`）**：智能模式下用 `ctx.huaanworkWorkspaceRoot?.current` 检查计划信号与 `isGitDirty`。
  3. **`dsh-plugin-huaanwork/src/huaanwork-guardrails/git.ts:57, 170-172`**：`git_status`、`git_diff`、`git_branch`、`git_checkout`、`git_commit`、`git_push` 六个工具全部在 `ctx.huaanworkWorkspaceRoot?.current` 下执行 Git。后台项目 B 调用 `git_commit` 或 `git_checkout` 会直接提交或切换前台项目 A 的 Git 仓库！
  4. **`dsh-plugin-huaanwork/src/huaanwork-guardrails/web.ts:80, 127`**：`screenshot` 工具将截图写入 `ctx.huaanworkWorkspaceRoot?.current`（前台项目目录）。
  5. **`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:296-305`（`emitGitDiff`）**：在 `write`/`edit`/`bash` 等工具结束后，对 `ctx.huaanworkWorkspaceRoot?.current`（前台根）跑 `workspaceDiff(root)`，却打上后台会话的 `sessionId` 发出 `{ event: "diff", text, sessionId }`。
  6. **`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:933, 946`**：`@slug` 智能体包 `dispatch` 用 `ctx.huaanworkWorkspaceRoot?.current` 作为 MCP 子进程 `cwd`、`AGENT_WORKSPACE` 和沙箱 `workspaceRoot`。
- **修法**：提供统一的会话根读取辅助函数 `sessionWorkspaceRoot(ctx, sessionId)`（查 `ctx.huaanworkSessionRoots`，支持子代理回溯父会话，未命中时才回退 `ctx.huaanworkWorkspaceRoot?.current ?? process.cwd()`），在 `policy.ts`、`question-answerer.ts`、`git.ts`（从 `defineTool` 的第 2 参 `exec` 取 `sessionIdOfAgentRef(exec?.agent)`）、`web.ts`、`bridge.ts`、`agent-package/host.ts` 中全部改用该辅助函数。

#### M-6｜脚本自动化执行目录、工作区切换门禁与可写根目录存在性检查缺失
- **证据链**：
  1. **脚本自动化 `cwd` 错误**：`dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:577-582` 调用 `runScript(automation.command ?? '', routeCtx.workspaceRoot.current, ...)` 传入的是前台根 `routeCtx.workspaceRoot.current`，而非该自动化所属项目根（或中立根）。计划 Task 8 未修改 `:579`。
  2. **`workspace.ts` 死引用与全局阻塞**：规格 §5.5（`design:306-307`）要求删除 `sessionSendBlockers` 与 `assertAutomationIdle`。但 `dsh-plugin-huaanwork/src/huaanwork-host/workspace.ts:4, 43, 63` 仍在导入并调用 `assertAutomationIdle()`。若在 Task 6 删除 `assertAutomationIdle`，`workspace.ts` 直接编译失败；若保留，则任一项目有自动化运行时用户无法在界面切换到其他项目。且 `workspace.spec.ts:6, 138, 171` 与 `routes.spec.ts:17, 512` 均直接导入了 `sessionSendBlockers`，计划未包含这些文件的同步迁移。
  3. **可写根目录不存在检查缺失**：规格 §6 明文要求「可写根目录已不存在：该次不启动，标签显示原因」，计划 Tasks 2/3/6 均未检查推导出的项目根目录在磁盘上是否存在（`existsSync(root) && statSync(root).isDirectory()`）。
  4. **`ensureChannelAgent` 恢复校验**：`dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:284` 现为 `resolve(cwd) !== resolve(routeCtx.workspaceRoot.current)`，Task 6 Step 3 应明确说明 `ensureChannelAgent` 与 `sessionResume` 共用 `isInside(writableRoot, cwd)` 判断，并以推导出的 `writableRoot`（或落在该根内的持久化 `cwd`）创建/恢复会话。

---

### 3.3 无人值守隔离（对应规格 §5.3.1）

#### M-7｜Task 7 漏改无人值守最核心的消费点 `policy.ts`，导致 Task 7 Step 4 必红且无人值守白名单降级失效
- **证据链**：
  1. 无人值守自动放行白名单工具（`ask → allow`）并写入审计日志 `.audit.jsonl` 的核心逻辑位于 `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:133-155`（`degradeIfUnattended`），当前读取的是 `const unattended = ctx.huaanworkUnattended?.current`。
  2. 计划 Task 7（`:593-637`）只列出了 `holders.ts`、`automations-host.ts`、`route-tool-plugin.ts`、`question-answerer.ts`，**遗漏了 `policy.ts`**。
  3. 在 Task 7 Step 4 运行 `vitest run ... tests/huaanwork-host/automations-host.spec.ts` 时，`automations-host.spec.ts:476-502` 将 `h.runtime.huaanworkUnattended`（已被改为 `Map`）传给 `policy.ts` 的 `apply()`，因 `Map.current` 为 `undefined`，第 496 行 `expect(decision).toEqual({ kind: 'allow' })` 会**当场失败**（返回 `{ kind: 'ask' }`）。
  4. 此外，`dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts:110` 处并无局部变量 `sessionId`（`sessionId` 是在 `:195` 的 `unattendedOwns` 内通过 `sessionIdOfAgentRef(request.agent)` 提取的），Task 7 Step 3（`:625`）写的「改为 `ctx.huaanworkUnattended?.get(sessionId)`」需先提取 `sessionId`（并支持子代理回溯父会话）。
- **修法**：Task 7 补入 `policy.ts`（用 `sessionIdOfAgentRef(execution.agent)` 查 `ctx.huaanworkUnattended?.get(sessionId)`，并支持子代理回溯父会话），同时同步更新 `tests/huaanwork-host/policy-type.spec.ts`、`tests/huaanwork-guardrails/policy.cordis.spec.ts:327-513`、`tests/huaanwork-guardrails/question-answerer.spec.ts:228-261`、`tests/huaanwork-host/automation-scheduler.spec.ts:66`。

---

### 3.4 回合调度器与自动化调度接线（对应规格 §4.2、§4.2.1、§5.5）

#### M-8｜排队项后台出队缺少「宿主事件 → 客户端状态转换」闭环，且异常分支与自动化释放未接通 `drainQueue`
- **证据链**：
  1. **客户端 `waitingIds` 永久残留且 `running` 失真**：
     - 看 Task 10（`:786-805`）定义的 `TabRunState = { running: boolean; waitingIds: string[] }` 与三个纯函数 `noteSendResult`、`noteTurnEnded`、`noteWaitingCancelled`。
     - Task 10 Step 1 自己的测试（`:802`）断言：`expect(noteTurnEnded(both)).toEqual({ running: false, waitingIds: ['q1'] })`。
     - 当同一标签（或跨项目的另一标签）的第 1 个回合结束、宿主在后台通过 `drainQueue()` 启动排队项 `q1` 时：**宿主没有发出任何事件通知客户端 `q1` 已开始执行，客户端也没有任何函数将 `q1` 从 `waitingIds` 移除并将对应标签置为 `running: true`！**
     - 结果：后台已开始跑 `q1` 时，客户端标签显示 `running: false`（停止按钮消失），而消息气泡仍挂着「等待当前任务」和失效的取消等待按钮；甚至在 `q1` 跑完后，`q1` 仍永远留在 `waitingIds` 中。
  2. **后台出队启动失败无错误处理与通知**：
     - 规格 §4.4 / §5.5 / §6 要求：排队期间若绑定的 `modelId` 被删（或网络门禁不通过、根目录被删），轮到该项时失败并在该标签显示原因，同时立即 `release` 并继续扫描队列其余项。
     - 计划 Task 2 的 `drainQueue()`（`:267`）出队时不重验 `modelExists`，Task 6（`:556-567`）也未写出后台 `sendToAgent` 抛错时的 `catch` 块（需 `scheduler.release(item.sessionId)`、通过 `routeCtx.emit` 发送失败事件给客户端对应标签，并继续下一轮 `drainQueue()`）。
  3. **自动化结束未触发 `drainQueue()`，用户队列扫描也未重评估到期自动化**：
     - Task 2（`:179`、`:265`）规定 `release` 不自动调 `drainQueue`。但 Task 8 Step 3（`:703`）在自动化结束时只写 `release`，未调宿主的 `drainQueue` 执行器，导致排在自动化后面的用户回合永远不会被唤醒！
     - 反过来，规格 §4.2（`design:83`）与 §4.2.1（`design:97`）要求「用户队列重新扫描时，顺带让调度器再评估一次已经到期且尚未开始的自动化」，计划 Task 6 / Task 8 均未接线该回调。
- **修法**：
  1. 宿主在 `drainQueue` 启动某队列项时，发出带 `sessionId`、`tabId`、`queueItemId` 的事件（如 `session/queue-start`），在出队启动失败时发出失败事件并释放名额继续扫描；
  2. Task 10 增加 `noteWaitingStarted(state, queueItemId)`（从 `waitingIds` 移除 `queueItemId` 并置 `running: true`）；
  3. 抽出宿主统一的 `releaseAndDrain(sessionId)` 辅助函数：内部依次执行 `scheduler.release(sessionId)` → 后台消费 `scheduler.drainQueue()` → 触发一次到期自动化重评估；用户回合与自动化（agent / script）结束或启动失败时统一调用 `releaseAndDrain`。

#### M-9｜`createTurnScheduler` 的同步 `resolveRoot(sessionId)` 签名与宿主异步存储 I/O 冲突
- **证据链**：
  1. Task 2（`:165`）将 `createTurnScheduler` 的 `resolveRoot: (sessionId: string) => string` 定义为同步函数，由 `admitUserTurn` 内部同步调用。
  2. 但 Task 3 的 `writableRootForSession`（`:298-305`）需要 `projects`（来自异步 `listProjects`）、`tasks`（来自异步 `listTasks`）以及 `headerCwd`（来自异步 `findSessionHeader`，需读取并解压 `.jsonl.zstd` 会话日志）。规格 §5.1.1（`design:178`）也将签名定义为 `writableRootForSession(routeCtx, sessionId): Promise<string>`。
- **修法**：去掉 `createTurnScheduler` 的同步 `resolveRoot` 构造参数，改为由调用方（`sessionSend` 等）先异步调用 `await writableRootForSession(...)` 算出 `root`，再作为参数传给 `scheduler.admitUserTurn({ sessionId, tabId, text, modelId, root })`（与 `admitAutomation` 直接传 `root` 保持一致）。

#### M-10｜Task 8 的 `admissionSkips` 存在「超 10 分钟后永久卡死」漏洞，且 Step 1 新增测试与 Step 3 实现自相矛盾
- **证据链**：
  1. **Step 1 测试与 Step 3 实现自相矛盾（落盘必红）**：
     - Task 8 Step 1 的测试 `an admission skip survives the missed grace window`（`:667-685`）在调用 `start(h)` **之前**直接将 `dueAt` 设为 `Date.now() - MISSED_GRACE_MS - 5_000`（已过期超过 10 分钟）。
     - 当 `start(h)` 跑第一次 tick 时，`dueAutomations(activeList, now)`（`dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:232-238`）只返回 `now - item.nextRunAt <= MISSED_GRACE_MS` 的任务，因此 `due` **根本不会进入 `dueAutomations`**，也就**从来没有调用过 `admitAutomation`**！
     - 于是 `isAdmissionSkipped(due.id)` 为 `false`，第一次 tick 的 `missedAutomations` 循环会照常把 `due` 记为 `status: 'missed'`，导致 `:684` 的断言 `expect(...).toBe(false)` 必然失败！
  2. **超 10 分钟后永久卡死漏洞**：
     - 即便某任务先在 10 分钟窗口内被 tick 评估并因根忙记入 `admissionSkips`，一旦根忙持续超过 10 分钟（`now - nextRunAt > MISSED_GRACE_MS`），当根终于释放后：
     - `missedAutomations` 因 `isAdmissionSkipped(id) === true` 跳过它；
     - `dueAutomations` 因 `now - nextRunAt > MISSED_GRACE_MS` **也不包含它**！
     - 该自动化从此脱离两个列表，永远无法再次准入启动，违反规格 §4.2.1（`design:99`）「跳过项保持可被后续 tick 再次准入，直到成功启动或任务被删除」。
- **修法**：
  1. 在 `automation-scheduler.ts` 中，将满足 `item.enabled && item.schedule.kind !== 'manual' && item.nextRunAt !== undefined && item.nextRunAt <= now && isAdmissionSkipped(item.id)` 的任务并入本次待准入的 `due` 列表（不受 `MISSED_GRACE_MS` 过滤），并在任务被禁用、删除或修改计划时间时清除其 `admissionSkips` 记录；
  2. 修正 Task 8 Step 1 的测试：先将 `dueAt` 设为 `Date.now() - 1_000` 跑一次 tick 让 `admitAutomation` 真实产生 `skip`，再将时间推进（或 `arm`）到 `Date.now() - MISSED_GRACE_MS - 5_000` 验证不记 `missed`，最后释放占用该根的用户回合，验证 `due` 能被后续 tick 成功启动。

#### M-11｜Task 8 对 `admitAutomation` 的调用位置前后矛盾（双重调用必自锁），且漏删 `routes.ts:1181` 的 `agentIdle` 与既有冲突测试
- **证据链**：
  1. **`admitAutomation` 双重调用自锁**：
     - 计划在 `:654` 写「脚本仍先 `acquireScriptSlot`，但之前必须 `admitAutomation({ countsTowardCap: false })`」，在 `:703` 写「`enqueueAgentAutomation` 不再串 `automationTail`。`admitAutomation` 成功后执行」，同时又在 `:701`（`automation-scheduler.ts` 每条到期自动化调用 `admitAutomation`）和 `:705`（`routes.ts` 的 `automation.run` 直接 `admitAutomation`）要求外层调用 `admitAutomation`。
     - `admitAutomation` 是非幂等的占坑函数（调用成功即写 `rootWriters`）。若外层（`automation-scheduler.ts` 或 `routes.ts`）调一次，内层（`enqueueAgentAutomation` / `enqueueScriptAutomation`）再调一次，内层必然看到 `rootWriters` 已有写者而返回 `skip: 'root-busy'`！
  2. **脚本自动化缺少合成 `turnKey`**：
     - `executeRun` 中 `kind === 'script'` 的 `sessionId` 为 `undefined`（`automations-host.ts:535`），而 `admitAutomation` 与 `release` 需要非空字符串键（应明确使用如 `automationRunSessionId(automation.id, runId)` 或 `script:${runId}`）。
  3. **`routes.ts:1181` 漏删 `agentIdle(ctx)`**：
     - `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:1181` 现有 `if (!(await agentIdle(ctx))) throw new Error('当前对话仍在进行，请先完成或停止后再运行任务')`。Task 8 Step 3（`:705`）只写删除 `openWorkspace`、`closeWorkspace` 和 `assertAutomationIdle`，漏掉了 `agentIdle(ctx)`。不删此行，前台项目有对话进行时手动运行另一项目的自动化会直接报错，违反规格 §4.2.1 与 Task 13 Step 4.3。
  4. **`automations-host.spec.ts` 既有冲突测试未点名更新**：
     - Task 8 Step 1 只点名了 `automation-scheduler.spec.ts` 的 3 个旧测试，漏掉了 `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts` 中直接依赖旧全局锁或同根并发的 5 个测试：`:318`（断言 `automation.run` 抛 `/后台自动化任务运行中/`）、`:355`（在**同一个 `project.id`** 上同时跑 3 个脚本测试槽位上限 2——按新规格同根最多 1 个写者，必须改为 3 个不同项目根）、`:380`（断言脚本运行时同根 `session.send` 立即执行不排队）、`:409`（在**同一个 `project.id`** 上并发跑脚本和 agent）、`:713`（断言 `agentIdle` 拒绝手动运行）。
- **修法**：统一规定 `admitAutomation` 只在唯一入口（或外层准入后把凭据传给 `executeRun`）调用一次；为脚本运行指定唯一 `turnKey`；在 `routes.ts:1181` 删除 `agentIdle(ctx)`；在 Task 8 Step 1 点名更新 `automations-host.spec.ts` 的上述 5 个用例。

---

### 3.5 子任务模型 RPC、客户端并发状态与契约门禁（对应规格 §4.2、§4.3、§4.4、§4.6、§5.3、§5.4）

#### M-12｜Task 9 缺少设置子任务模型的 RPC 路由与客户端 API，Task 10 前端无法调用 `setTaskModel`
- **证据链**：
  1. Task 9（`:723-770`）只在服务端 `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts` 新增了 `setTaskModel(storageRoot, input)`，并在 `rpc-types.ts` 给 `TaskInfo` 加了 `modelId?: string`，**没有在 `routes.ts`、`api.ts`、`projects.ts`、`rpc-types.ts`（`RpcRequest`）中注册任何 RPC 路由**。
  2. 但 Task 10 Step 3（`:820`）却要求前端 `App.tsx` 在模型下拉框变更时「调用 `setTaskModel`」——渲染进程无法直接调用 Node 宿主的 `stores.ts` 函数。
  3. 同时，规格 §4.4（`design:113`）「已有 `tasks.json` 没有该字段时，发送时默认取当时的 `active_model_id`，并把这次选择写回任务」在 Task 6 / Task 9 / Task 10 中均无落点。
- **修法**：在 Task 9 补齐 `task.setModel` 路由（`routes.ts`、`rpc-types.ts`、`api.ts`、`projects.ts`），并在 `sessionSend`（或前端首次发送绑定子任务的会话时）将未设置 `modelId` 的子任务写回本次选定的 `modelId`。

#### M-13｜`App.tsx` 存在大量单槽 Ref、自动化全局禁用守卫与发送前切全局工作区副作用，Task 10 未拆除
- **证据链**：
  1. **自动化运行期间侧栏切换项目/子任务仍被全局锁死**：
     - `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:765`（`selectSubtask`）、`:1910`（`createProjectFlow`）、`:1936`（`openProjectById`）均有 `if (automationActiveRef.current) return` 早退；
     - `App.tsx:2888, 2900`（`ProjectsPanel`）写有 `disabled={runningAutomationIds.size > 0 || sidecarDead || selectBusy}`。不拆除这些限制，项目 A 运行自动化时用户根本无法在界面切换到项目 B。
  2. **回合跟踪与停止状态绑在全局单槽 Ref 上**：
     - `App.tsx:494-539` 使用全局单值 `turnTabRef`、`turnSessionRef`、`liveChatRef`、`turnPulse`、`stopPendingRef`、`userStopSessionRef`、`stopping`。
     - 当标签 A 与标签 B 同时执行回合时，后发送的标签 B 会覆盖 `turnTabRef.current` 与 `turnSessionRef.current`：
       - 标签 A 收到 `session/end` 时，`endsTrackedTurn`（`:1360`）为 `false`，不会清理标签 A 的运行态；
       - 切回标签 A 时，进度条（`:671` `showTurnLine`）和停止按钮（`:3223` `turnActive && activeTab === turnTabRef.current`）消失；
       - `bridge.reportTurns((turnActive ? 1 : 0) + runningRuns.size)`（`:660`，被 `appWiring.spec.ts:353` 钉死）和 `:553` 的正则钉也会失准或断裂。
  3. **发送前切全局工作区与 `session.new` 耦合**：
     - `App.tsx:2158-2195` 在发送时若标签尚无 `sessionId`，会先调用 `ensureNeutralWorkspace()` 或 `alignWorkspaceOnly()` 改写宿主全局 `workspaceRoot.current`，再调用无目录参数的 `session.new`（`sessions.ts:610-616`，内部固定取 `routeCtx.workspaceRoot.current`）。应允许 `session.new` 接收显式 `cwd`（或任务项目根），避免发送时篡改前台工作区。
  4. **等待消息气泡展示与单独取消 UI 未定义数据结构**：
     - 规格 §4.2 / §5.4 要求「该条用户消息出现在标签里并显示『等待当前任务』」「等待中的项可以单独取消」。Task 10 只在 `TabRunState` 放了 `waitingIds: string[]`，未在用户 `ChatItem` 上关联 `queueItemId`，导致渲染层无法知道哪条用户消息处于等待态、点击哪条消息的取消按钮传哪个 `queueItemId`。
- **修法**：在 Task 10 中明确列出：① 拆除 `selectSubtask` / `createProjectFlow` / `openProjectById` / `ProjectsPanel` 上的自动化运行锁；② 将 `turnTabRef` / `turnSessionRef` / `stopping` 等单槽状态改为按标签/会话索引（由各标签的 `TabRunState` 驱动 `showTurnLine`、停止按钮和 `reportTurns` 计数），并同步更新 `appWiring.spec.ts:353, 553`；③ `session.new` 支持传入目标 `cwd`；④ 用户消息 `ChatItem` 增加可选 `queueItemId?: string` 与等待状态标记，排队开始后清除等待标记。

#### M-14｜路由契约守卫 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts` 未同步更新
- **证据链**：
  1. `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts` 对全部 71 条路由做双向严格键集合校验（`CLIENT_REQUIRED_KEYS`、`SERVER_EXPECTED_KEYS`、`OPTIONAL_KEYS_WHITELIST`、`TARGET_BUSINESS_REQUIRED_KEYS`），且在 `:380-381` 断言双端方法总数恰好为 `71`（`routes.spec.ts:44` 与 `api.spec.ts` 同理）。
  2. Task 6 改变了 `session.send` 的返回字段（新增 `waiting`、可选 `queueItemId`）；Task 8 Step 3（`:705`）将 `automation.run` 在 `skip` 时的返回改为 `{ queued: false, waiting: true, runId }`（去掉了原必含键 `workspaceRoot`，增加了 `waiting`，而 `route-contract.spec.ts:64, 185, 324, 509` 严格断言 `automation.run` 必含 `['queued', 'runId', 'workspaceRoot']`）；Task 9 若新增 `task.setModel` 还会把方法总数从 71 变为 72。
  3. 计划全文未提及 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts`，到了 Task 11 Step 3 跑全目录测试时必红。
- **修法**：在对应任务（Task 6 / Task 8 / Task 9）中显式列出 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts` 的契约键集与方法计数更新步骤（建议 `automation.run` 仍保留返回 `workspaceRoot: ctx.workspaceRoot.current` 并将 `waiting` 列入 `OPTIONAL_KEYS_WHITELIST`）。

---

## 四、Moderate / Minor（P2）缺口

### P2-1｜Task 11 的规格条款对照表遗漏了规格 §6 / §7 的 5 项必测条款
- 计划 Task 11 Step 1（`:877-890`）列出了 11 条测试名核对项，但对照规格 §6 与 §7（`design:316-342`），以下 5 条明确要求覆盖的场景未进入 Task 11 对照表（其中前 2 条在 Tasks 1–10 中也尚无测试）：
  1. **规格 §7**：「子代理不使执行中的回合数加一」；
  2. **规格 §6**：「可写根目录已不存在：该次不启动，标签显示原因」；
  3. **规格 §7**：「前台从一个项目切到另一个项目后，后台会话的 `cwd` 和后续工具路径不变」；
  4. **规格 §7**：「停止一个标签不影响另一个标签的执行」；
  5. **规格 §7**：「后台会话的 diff 不写入当前正在查看的标签」。

### P2-2｜Task 10 对无 `sessionId` 的 `diff` 事件兜底文案与规格 §4.6 字面口径存在细微偏差
- 规格 §4.6（`design:144`）写的是：「没有 `sessionId` 时，仅当**占名额的执行中回合**恰好一个，记入那个标签；同时有多个时不记入任何标签，并写一条**宿主日志**。」
- 计划 Task 10 Step 3（`:822`）写的是：「没有 `sessionId` 时，仅当 `running === true` 的标签恰好一个才写入它；否则不写入，并 `console.warn` 一次。」
- 建议在 `bridge.ts` 宿主侧发出 `diff` 时确保传入 `sessionId`（或宿主侧判 `activeTurnCount() === 1` 打宿主日志），客户端保持兜底保护即可，并在计划中注明对齐方式。

### P2-3｜Task 11 Step 1 的 `rg` 命令在未注入 Homebrew PATH 的非交互式 shell 下可能报 `command not found`
- 计划 `:861-873` 使用裸 `rg -n` 检索测试名。在 macOS 默认非交互式 `/bin/zsh`（PATH 仅 `/usr/bin:/bin:/usr/sbin:/sbin`）下若未加载 `/opt/homebrew/bin` 会退出 `127`。建议在命令块开头加上 `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` 或允许 `grep -rn` 等价核验。

---

## 五、修订闭环清单（供计划作者直接对照修改）

| 优先级 | 编号 | 涉及计划任务 | 要求修订动作 |
| --- | --- | --- | --- |
| **Major** | **M-1** | Task 5 | 将 `net-gate.ts` 接入 `resolveSessionModel`（按 `options.sessionId` 校验绑定模型的 `base_url`），更新 `sessions.spec.ts:1487` |
| **Major** | **M-2** | Task 5 / Task 6 | 在 `sendToAgent` / `sessionSend` 中写入 `huaanworkSessionModels` 并按绑定模型做准入网络门禁；在 `sessionRemove` 中清理 |
| **Major** | **M-3** | Task 5 / Task 8 | `child-sessions.ts` 增加父会话回溯使子代理继承父会话 `modelId`；`runAgentTurn` 启动时锁定当时的 `active_model_id` |
| **Major** | **M-4** | Task 4 / Task 6 | 放弃不可行的 `request.session.header.writableRoot`（上游 `SessionHeader` 白名单过滤且 `deepFreeze`），改为 `ctx.huaanworkSessionRoots: Map<string, string>`（含子代理回溯），并同步改造 `sandbox-cwd.ts` 的 `withPinnedCwd` 与 `sandboxPolicy.resolve` |
| **Major** | **M-5** | Task 4 / Task 6 | 将 `policy.ts:198`、`question-answerer.ts:153`、`git.ts:57`、`web.ts:80`、`bridge.ts:297`、`agent-package/host.ts:933` 的 `workspaceRoot` 全部改为按会话（含子代理回溯）读取可写根 |
| **Major** | **M-6** | Task 6 / Task 8 | 修复 `automations-host.ts:579` 脚本自动化的 `cwd`；处理 `workspace.ts`（及 `workspace.spec.ts`、`routes.spec.ts`）对已删除 `assertAutomationIdle` / `sessionSendBlockers` 的引用；增加可写根目录存在性检查；`ensureChannelAgent` 改为 `isInside` 校验 |
| **Major** | **M-7** | Task 7 | 补入 `policy.ts` 的 `degradeIfUnattended` 按会话 `Map` 改造（含子代理回溯），同步更新 `policy-type.spec.ts`、`policy.cordis.spec.ts`、`question-answerer.spec.ts`、`automation-scheduler.spec.ts` |
| **Major** | **M-8** | Task 2 / 6 / 8 / 10 | 补齐后台 `drainQueue` 出队启动事件（如 `session/queue-start`）、客户端 `noteWaitingStarted`、后台出队失败的 `release + emit + 继续 drain`、自动化结束调 `drainQueue`、以及用户队列扫描时联动重评估到期自动化 |
| **Major** | **M-9** | Task 2 / Task 6 | 移除 `createTurnScheduler` 的同步 `resolveRoot` 回调，改为由调用方先异步调用 `writableRootForSession` 再将 `root` 传给 `admitUserTurn` |
| **Major** | **M-10** | Task 8 | 让 `isAdmissionSkipped(id)` 为真的到期任务在超过 10 分钟后仍进入待准入列表（不掉进 `missed` 也不丢失）；修正 Task 8 Step 1 测试的 `dueAt` 初始时序 |
| **Major** | **M-11** | Task 8 | 消除外层与 `enqueue*Automation` 内层对 `admitAutomation` 的双重调用自锁；为脚本自动化指定唯一 `turnKey`；删除 `routes.ts:1181` 的 `agentIdle(ctx)`；点名更新 `automations-host.spec.ts` 的 5 个冲突用例 |
| **Major** | **M-12** | Task 9 / Task 10 | 新增 `task.setModel` RPC 路由与客户端封装；闭合旧任务首次发送时默认写回 `active_model_id` 的逻辑 |
| **Major** | **M-13** | Task 10 | 拆除 `App.tsx` 中 `automationActiveRef` / `runningAutomationIds` 对切换项目和子任务的禁用锁；将 `turnTabRef` / `turnSessionRef` / `stopping` 等单槽状态改为按标签/会话索引；`session.new` 支持显式传入目标 `cwd`；在用户 `ChatItem` 上关联 `queueItemId` 以渲染等待态与单独取消 |
| **Major** | **M-14** | Task 6 / 8 / 9 | 同步更新 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts` 的方法计数与必含/可选键集合 |
| **Minor** | **P2-1 ~ P2-3** | Task 10 / Task 11 | 补齐 Task 11 条款表缺失的 5 项测试；对齐无 `sessionId` diff 的日志位置；为 Task 11 的 `rg` 命令补 PATH 说明 |

---

## 六、第二轮复评（2026-11-04，针对 1261 行修订版）

### 6.1 首轮问题闭环核对表

| 编号 | 首轮问题摘要 | 第二轮核对状态 | 1261 行修订版落点与核验说明 |
| :--- | :--- | :--- | :--- |
| **M-1** | `net-gate.ts` 漏按会话解析模型 | **已闭环** | Task 5（`:458, :514, :525`）已将 `net-gate.ts` 接入 `resolveSessionModel`（含 `parentSessionOf` 回溯），并在 `sessions.spec.ts` 补齐双方向用例。 |
| **M-2** | `sendToAgent` 准入网络门禁与 `huaanworkSessionModels` 生命周期 | **已闭环** | Task 6（`:621-635, :653`）已在准入时调 `resolveSessionModel` 算 `entry.baseUrl`，回合开始写 `huaanworkSessionModels`，`sessionRemove` 时清理（不在 `whenIdle` 清理，保护标题生成）。 |
| **M-3** | 子代理与 Agent 自动化回合的模型绑定传递 | **已闭环** | Task 4（`:394, :399`）在 `child-sessions.ts` 新增 `parentSessionOf`；Task 5（`:477, :527`）支持父会话回溯并在 `skills.ts` 的 `subagent/start` 复制父模型绑定；Task 8（`:827`）在 `runAgentTurn` 开始时写入当时的 `active_model_id`、`finally` 删除。 |
| **M-4** | `request.session.header.writableRoot` 因上游 `deepFreeze` 不可行 + `withPinnedCwd` 忽略 `sessionId` | **已闭环** | Task 4（`:398, :433-435`）已完全放弃 `header.writableRoot`，改为 `ctx.huaanworkSessionRoots: Map<string, string>` + `parentSessionOf` / `options.meta.parentSession` 回溯，`withPinnedCwd` 显式传 `id`。 |
| **M-5** | `policy.ts` / `question-answerer.ts` / `git.ts` / `web.ts` / `bridge.ts` / `agent-package/host.ts` 硬编码读前台根 | **已闭环** | Task 6（`:551-559, :661`）导出 `sessionWorkspaceRoot(ctx, sessionId)` 并逐一覆盖全部 6 个调用点。 |
| **M-6** | `runScript` 的 `cwd`、`workspace.ts` 残留引用、目录存在性校验、`ensureChannelAgent` 校验 | **部分闭环（见 R2-M1）** | `runScript` 改用 `cwd`（`:829`）、`workspace.ts` 移除 `assertAutomationIdle`（`:550, :659`）、目录存在性校验（`:619`）与 `ensureChannelAgent` 的 `isInside` 校验（`:655`）均已落实；但 `ensureChannelAgent` 的 `if (persisted)` 分支与 Agent 自动化的会话根写入仍有遗漏（见 **R2-M1**）。 |
| **M-7** | `policy.ts` 无人值守未改 `Map` 及 `question-answerer.ts` 局部变量提取、测试同步 | **已闭环** | Task 7（`:688-702, :723-730`）已补入 `policy.ts`、`agent-package-tools.ts` 及对应全部测试文件。 |
| **M-8** | 后台 `drainQueue` 出队事件、客户端等待态清理、自动化结束调 `drainQueue` | **部分闭环（见 R2-M2）** | 已新增 `session/queue-start`、`session/queue-fail`、`session/queue-cancelled` 与客户端 `noteWaitingStarted`（`:575, :640-653, :947`），自动化结束调 `releaseAutomationAndDrain`（`:825`）；但 `startQueuedItem` 异步复检失败时漏调 `drainQueue()`（见 **R2-M2**）。 |
| **M-9** | `createTurnScheduler` 同步 `resolveRoot` 回调与异步 `writableRootForSession` 签名冲突 | **已闭环** | Task 2（`:152, :179`）已移除构造器 `resolveRoot`，改为由调用方先异步算出 `root` 传给 `admitUserTurn`。 |
| **M-10** | `admissionSkips` 越过 10 分钟宽限掉进 `missed` + Step 1 测试时序矛盾 | **已闭环** | Task 8（`:779-808, :823`）已修正 Step 1 测试时序，并在 `evaluateDueAutomations` 中对 `isAdmissionSkipped(auto.id)` 越过宽限期的任务继续放入 `due` 列表重试准入。 |
| **M-11** | `admitAutomation` 双重调用自锁、脚本缺唯一 `turnKey`、`routes.ts:1181` 残留 `agentIdle`、5 个旧测试冲突 | **已闭环** | Task 8（`:756-777, :825-831`）已规定 `admitAutomation` 只在外层调用一次、脚本用 `script:${runId}`、删 `routes.ts:1181` 的 `agentIdle`，并点名更新 `automations-host.spec.ts` 5 个冲突用例。 |
| **M-12** | 缺少 `task.setModel` RPC 路由及旧任务首次发送模型写回 | **已闭环** | Task 9（`:854-900`）已补齐 `setTaskModel`、`task.setModel` 路由与客户端 `taskSetModel`。 |
| **M-13** | `App.tsx` 自动化锁未拆、单槽 ref 串台、等待消息缺 `queueItemId`、`session.new` 未传 `cwd` | **已闭环** | Task 6（`:560, :657`）与 Task 10（`:934, :969-976`）已全部补齐。 |
| **M-14** | `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts` 契约守卫未同步 | **已闭环** | Task 8（`:831`）与 Task 9（`:856-859, :879, :900`）已同步 71→72 计数与响应键契约。 |
| **P2-1 ~ P2-3** | Task 11 漏列 5 条必测项、无 `sessionId` diff 日志位置、`rg` PATH 说明 | **已闭环** | Task 10（`:979`）与 Task 11（`:1018-1056, :1062`）已全部吸收（条款表已扩充至 16 条）。 |

---

### 6.2 第二轮检出的残留问题（2 项局部 Major + 1 项 Minor）

#### R2-M1｜项目级 Agent 自动化未登记 `huaanworkSessionRoots`，且 `ensureChannelAgent` 漏改 `if (persisted)`（`agents.resume`）分支

- **严重度**：**Major（阻塞项目级 Agent 自动化与已持久化项目会话的跨根恢复）**
- **计划位置**：Task 6 Step 3（`:621-635, :655`）、Task 8 Step 3（`:827`）
- **代码锚点**：
  - `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:272-292`（`ensureChannelAgent`）
  - `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:266-312`（`runAgentTurn`）
  - `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts:985-993`
- **事实核验（两处关联漏洞）**：
  1. **项目级 Agent 自动化的会话根会退化到 `neutralWorkspaceRoot`**：
     - Agent 自动化运行时的会话 ID 是 `automationRunSessionId(automation.id, runId)`（形如 `huaanwork-auto-<automationId>-<runId>`）。
     - 该 ID 既不在 `tasks.json`，也不匹配 `sessionIdFor(project.root)` 前缀（`huaanwork-<16位hex>`），首次运行创建会话前磁盘上也没有 JSONL 头。因此对任何项目的 Agent 自动化，`writableRootForSession(profileDir, dshHome, sessionId)`（Task 3 `:326-341`）**恒回退返回 `neutralWorkspaceRoot(profileDir)`**。
     - Task 8 Step 3（`:827`）在 `runAgentTurn` 开始时只写了 `huaanworkSessionModels.set(sessionId, active_model_id)`，**漏写了把 `runAgentTurn` 已知的目标 `root` 写入 `huaanworkSessionRoots`**，且 Task 6 Step 3（`:621`）写明「自动化 `runAgentTurn` 走默认分支，在 `sendToAgent` 内做一次检查」——导致 `sendToAgent` 与 `ensureChannelAgent` 都会用 `writableRootForSession` 算出的 `neutralWorkspaceRoot(profileDir)` 覆盖该自动化会话的根，项目级 Agent 自动化的 `meta.cwd`、沙箱、护栏与工具全部落错到中立工作区。
  2. **`ensureChannelAgent` 漏改 `if (persisted)`（`agents.resume`）分支**：
     - `sessions.ts:281-292` 中，`ensureChannelAgent` 分两条分支：磁盘已有日志时走 `if (persisted)`（调 `ctx.agents.resume`），无日志时走 `else`（调 `ctx.agents.create`）。
     - 现有代码 `:284-286` 在 `if (persisted)` 分支硬编码了：
       ```ts
       if (cwd && resolve(cwd) !== resolve(routeCtx.workspaceRoot.current)) {
         throw new Error('该会话属于其他工作区，请先打开对应项目后再继续。')
       }
       ```
     - Task 6 Step 3（`:655`）只规定修改 `agents.create` 分支（「`ensureChannelAgent` 在 `agents.create` 之前把推导根写入 `huaanworkSessionRoots`，`meta.cwd` 用这个根」），**漏掉了 `if (persisted)` 分支**。
     - 后果：当项目 B 已有磁盘持久化会话，而当前 `routeCtx.workspaceRoot.current` 指向项目 A（例如排队期间用户切到项目 A 标签，或用户在后台项目 B 标签继续历史会话 / 调 `session.resume`）时，`ensureChannelAgent` 走 `if (persisted)` 分支会因 `resolve(cwd) !== resolve(routeCtx.workspaceRoot.current)` 直接抛 `'该会话属于其他工作区，请先打开对应项目后再继续。'`；即使同根恢复成功，`if (persisted)` 分支也未把会话根写入 `huaanworkSessionRoots`。
- **修订要求**：
  1. **Task 8 Step 3（`:827`）**：`runAgentTurn` 开始时除写入 `huaanworkSessionModels` 外，同步写入 `ctx.huaanworkSessionRoots?.set(sessionId, root)`，并在调用 `sendToAgent` 时显式传入 `{ root }`（在 `finally` 中随 `huaanworkSessionModels.delete(sessionId)` 一起清理 `huaanworkSessionRoots.delete(sessionId)`）。
  2. **Task 6 Step 3（`:655`）**：`ensureChannelAgent` 优先读取 `ctx.huaanworkSessionRoots?.get(sessionId)`，未命中再调 `writableRootForSession`；在 `if (persisted)` 分支中，将 `:284` 的守卫改为「若该会话归属于 `tasks.json` / `projects.json` / `huaanworkSessionRoots` 中的项目根，则与该归属根比对；否则与 `routeCtx.workspaceRoot.current`（或 `neutralWorkspaceRoot`）比对」（既支持已登记项目的历史会话跨工作区并发恢复，又保持 `sessions.spec.ts:985-993` 对未知外部目录会话的拒绝守卫不破），并在 `ctx.agents.resume` 前同样把推导根写入 `ctx.huaanworkSessionRoots`。

#### R2-M2｜`startQueuedItem` 异步复检失败时只调 `scheduler.release(item.sessionId)` 而未重跑 `drainQueue()`，在并发满额时会让后续排队项永久卡死

- **严重度**：**Major（阻塞规格 §4.4 / §5.5 及 Task 6 Step 1 `:588` 自身测试）**
- **计划位置**：Task 6 Step 3（`:640-647`）
- **事实核验**：
  - 计划 `:640-644` 定义：
    ```ts
    function releaseAndDrain(sessionId: string): void {
      scheduler.release(sessionId)
      for (const item of scheduler.drainQueue()) void startQueuedItem(item)
      reevaluateDueAutomations?.()
    }
    ```
  - 计划 `:647` 规定：「`startQueuedItem` 再次检查根目录仍存在、`modelId` 仍在列表里、网络门禁仍通过。失败时 `routeCtx.emit({ event: 'session/queue-fail', sessionId, tabId, queueItemId, reason })`，然后 `scheduler.release(item.sessionId)` 并继续下一项。」
  - **死锁因果链**：`scheduler.drainQueue()`（Task 2 `:230-248`）在占满 `maxConcurrentTurns` 时就会立刻 `break` 停止弹出后续项！例如当剩余并发名额为 1，队列中有 `[Item A（排队期间模型被删）, Item B（另一项目根，模型有效）]` 时：
    1. 前一回合结束调 `releaseAndDrain` → `scheduler.drainQueue()` 只弹出 `Item A` 并将其计入 `activeTurns`（占满上限），此时 **`Item B` 仍留在 `scheduler` 内部队列中，不在本次 `drainQueue()` 返回的数组里**；
    2. 外层 `for` 循环只有 `Item A` 一项，调完 `void startQueuedItem(Item A)` 后同步结束；
    3. `startQueuedItem(Item A)` 异步读盘后发现模型已被删，进入失败分支：若只调 `scheduler.release(item.sessionId)` 而不调 `releaseAndDrain(item.sessionId)`，则名额释放后没有任何代码再次调用 `scheduler.drainQueue()` 或 `reevaluateDueAutomations?.()`，留在 `scheduler` 内部的 `Item B` 将永久卡死在队列中。
- **修订要求**：
  - 将 Task 6 Step 3（`:647`）`startQueuedItem` 失败分支中的 `scheduler.release(item.sessionId)` 改为调用 `releaseAndDrain(item.sessionId)`。

#### R2-P2-1｜Task 6 文件路径笔误（`sessions-host.ts` / `session-host.ts` 应为 `sessions.ts`）及 `sessionOpen` / `sessionRemove` 根映射顺手维护

- **严重度**：**Minor（P2，导致复制执行 `git add` 报错）**
- **计划位置**：改动总览表 `:92`、Task 6 标题 `:545`、文件列表 `:547, :551`、提交命令 `:670`
- **事实核验**：
  1. 仓库中会话宿主源码的真实路径是 `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`（单测为 `tests/huaanwork-host/sessions.spec.ts`），并不存在 `sessions-host.ts` 或 `session-host.ts`。`:670` 的 `git add dsh-plugin-huaanwork/src/huaanwork-host/sessions-host.ts` 会直接报 `pathspec did not match any files`。
  2. 顺手加固建议：在 `sessionOpen` 打开历史会话时顺手把 `writableRootForSession` 推导出的根写入 `ctx.runtimeCtx?.huaanworkSessionRoots?.set(sessionId, root)`，并在 `sessionRemove`（`:653`）中顺手 `ctx.huaanworkSessionRoots?.delete(sessionId)`，可保证前端刚打开历史会话标签、尚未发首条消息前调 `git.status` / `git.diff`（带 `sessionId`）也能直接命中该会话的真实根。

---

### 6.3 第二轮修订动作速查表

| 优先级 | 编号 | 涉及任务与行号 | 修订动作摘要 |
| :--- | :--- | :--- | :--- |
| **Major** | **R2-M1** | Task 6（`:655`）/ Task 8（`:827`） | ① `runAgentTurn` 开始时同步写入 `ctx.huaanworkSessionRoots?.set(sessionId, root)` 并向 `sendToAgent` 传 `{ root }`，`finally` 删除；② `ensureChannelAgent` 优先取 `huaanworkSessionRoots.get(sessionId)`，且在 `if (persisted)`（`agents.resume`）分支按会话归属根（而非硬编码 `routeCtx.workspaceRoot.current`）校验 `persisted.cwd` 并写入 `huaanworkSessionRoots` |
| **Major** | **R2-M2** | Task 6（`:647`） | 将 `startQueuedItem` 异步复检失败分支的 `scheduler.release(item.sessionId)` 改为 `releaseAndDrain(item.sessionId)`，确保释放出的并发名额继续触发 `scheduler.drainQueue()` 与 `reevaluateDueAutomations?.()` |
| **Minor** | **R2-P2-1** | 改动总览（`:92`）/ Task 6（`:545, :547, :551, :653, :670`） | 将 `sessions-host.ts` / `session-host.ts` 路径修正为 `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`；`sessionOpen` / `sessionRemove` 顺手写入/清理 `huaanworkSessionRoots` |

---

## 七、第三轮终审（2026-11-04，针对 1282 行第二轮修订版）—— 全部闭环（GO）

对 Grok 更新后的 1282 行计划进行了第三轮逐项复核，第二轮指出的 3 项残留问题已全部准确闭环，未引入新缺陷：

| 编号 | 第二轮问题摘要 | 第三轮核对状态 | 1282 行修订版落点与核验说明 |
| :--- | :--- | :--- | :--- |
| **R2-M1** | 项目级 Agent 自动化漏写 `huaanworkSessionRoots` + `ensureChannelAgent` 漏改 `persisted` 分支 | **已闭环** | ① Task 8（`:829, :842, :844`）明确禁止对 `automationRunSessionId` 调 `writableRootForSession`，改为在 `runAgentTurn` 开始时把准入已知的项目根写入 `huaanworkSessionRoots.set(sessionId, root)`，`finally` 删除，并新增专项断言；② Task 6（`:670-672, :680`）规定 `ensureChannelAgent` 的 `create` 与 `persisted` 共用同一根（先读 `huaanworkSessionRoots.get(sessionId)`，未命中再 `writableRootForSession`，不覆盖已有项），`persisted` 分支改为 `isInside(root, cwd)` 并在 `agents.resume` 前写入 `huaanworkSessionRoots`（既放行已登记项目的跨根历史会话恢复，又保持 `sessions.spec.ts` 未知外部目录用例继续拒绝）；`skills.ts` 在 `subagent/start` 同步复制父会话的 `huaanworkSessionRoots`。 |
| **R2-M2** | `startQueuedItem` 异步复检失败只调 `scheduler.release` 导致并发满额时后续排队项卡死 | **已闭环** | ① Task 2（`:231-243, :291`）明确 `drainQueue()` 在 `activeTurns >= maxConcurrentTurns()` 时停止弹出；② Task 6 Step 1（`:601`）与 Task 11（`:1043, :1067`）新增必测项 `a failed queued item releases the cap for the next root`（钉住生效上限为 1 时出队失败释放名额并继续出队启动下一根）；③ Task 6 Step 3（`:660`）规定 `startQueuedItem` 复检失败时调用 `releaseAndDrain(item.sessionId)`，且 `release` 对已不在 `rootWriters` 的 id 幂等无副作用。 |
| **R2-P2-1** | `sessions-host.ts` / `session-host.ts` 路径笔误与根表清理 | **已闭环** | File Structure（`:64`）与 Task 6（`:561, :662, :666, :690`）已全部对齐为真实路径 `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`，并在 `sessionRemove` 中同步清理模型表项与根表项。 |

**终审结论**：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（1282 行）已完整达到实施标准（**GO**），可进入实施阶段。

---

## 八、第四轮独立复核（Kimi 评审，2026-11-04）——NO-GO

- **评审者**：**Kimi**
- **评审对象**：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（1282 行，与第三轮相同版本）
- **对照基准**：设计规格、规格评审，以及 `dsh-plugin-huaanwork/` 当前源码与测试
- **评审方式**：只读静态复核，并对调度/自动化与根/模型/客户端两条链路分别交叉检查；未执行测试，复核时未修改设计、计划或产品代码
- **结论**：**未达到实施标准（NO-GO）**。第三轮 §七的 GO 未覆盖下列源码失败链，其“零阻塞项”结论由本轮复核推翻

### 8.1 新增阻塞项（Major）

#### K-M1｜两张会话 Map 未注册进 Cordis holders，生产 Host 会在赋值时启动失败

- **计划位置**：Task 6 `:562, :616` 要求在 `index.ts` 创建并写入 `huaanworkSessionModels` / `huaanworkSessionRoots`；`:536-538, :648, :670, :680` 要求各插件读取同一 Map。
- **源码证据**：`dsh-plugin-huaanwork/src/huaanwork-host/holders.ts:21-77` 的 Context 声明与 `HUAANWORK_CONTEXT_PROPS` 均无这两个属性；`:100-115` 的 mixin 只注册清单内属性，`:89-97` 明示未注册自定义属性会触发 `cannot set property ... without provide`。
- **失败链**：实施者照 Task 6 在真实 Cordis Context 上写新 Map → 属性未进 mixin 清单 → Host 启动抛错；普通对象测试桩覆盖不到这一层。
- **修订要求**：Task 6 Files 增列 `holders.ts`，同步更新 module augmentation 与 `HUAANWORK_CONTEXT_PROPS`，保证 route context、guardrails 与 sessions 读同一引用；补真实 Cordis Context 的赋值及跨插件读取回归。

#### K-M2｜`admitAutomation` 成功分支漏写 `rootWriters`

- **计划位置**：Task 2 `:287` 只规定 skip、`activeTurns += 1` 与 `admissionSkips.delete`，没有规定成功时写入写者；`:260-273` 唯一自动化测试只覆盖 cap-full skip。
- **失败链**：严格照 Step 3 实现时，agent/script 均返回 start 但不占根；后续同根用户或自动化仍可 start，`release` 也没有写者可删，根互斥和计数同时失效。
- **修订要求**：明确成功时写入 `{ kind, sessionId, runId }`，`countsTowardCap` 只决定是否增加 `activeTurns`；补 agent/script 各自成功后同根互斥、释放后可再准入的测试。

#### K-M3｜释放没有回合所有权，且自动化早退路径没有统一释放兜底

- **计划位置**：Task 2 `:181, :289` 的 `release` 只有 `sessionId`；Task 6 `:650-660` 同时要求 idle 两个回调与 followup 前失败路径调用 `releaseAndDrain`；Task 8 `:844-846` 只把自动化释放绑到 whenIdle、followup 前失败、脚本进程结束或启动失败。
- **源码证据**：`sessions.ts:144-160` 已有 idle cleanup，`:254-255` 的 finally 会安排它；`automations-host.ts:528-531` 对 queued + cancelRequested 直接 return，`:545-568` 还有启动前异常/正常返回，`:659-718` 的脚本可等待槽位。
- **失败链 A（误释下一代）**：同会话 T1 占坑、T2 等待；T1 失败触发第一次 `releaseAndDrain` 并出队 T2 后，迟到的 idle/外层失败路径再次按同一 sessionId 释放，看到并删除的是 T2 的写者，而非“无写者”，随后 T3 可与 T2 同根执行。
- **失败链 B（永久锁根）**：已准入脚本等待槽位时被 stop，轮到它后从 `executeRun:528-531` 早退；没有 whenIdle、进程结束或启动异常可触发计划列出的释放钩子，rootWriter 永久残留。
- **修订要求**：每次准入生成 admission/turn id，`release(sessionId, admissionId)` 只释放匹配写者，或用覆盖 idle 与 catch 的共享 `releaseOnce`；所有尚未把所有权交接给 live turn/child process 的 return/throw 统一兜底释放，交接后只能由真实 whenIdle/进程退出释放。补同会话连续两项的迟到释放，以及 queued script 等槽时 stop 的回归。

#### K-M4｜取消等待项会连带取消正在执行的同会话回合

- **计划位置**：Task 6 `:664` 要求 `sessionCancel` 调用现有 `cancelAgent`，带 `queueItemId` 时再 `cancelQueuedItem`；Task 10 `:990` 的等待消息取消也调用同一 `session.cancel`。
- **规格与源码**：规格 `:79` 明确“取消只移除该项，不停止已经在执行的回合”；`sessions.ts:303-322` 的 `cancelAgent` 会取消主代理、子代理、request_input 与 agent-package turn。
- **失败链**：同会话第一项执行、第二项等待；用户只取消第二项 → 第一项及其子代理也被停止。
- **修订要求**：`queueItemId` 存在时走独立分支，只 `cancelQueuedItem`，不得调用 `cancelAgent` 或释放活动写者；无 `queueItemId` 才走执行中取消。补“running + queued 时仅 queued 被取消，primary/child 未收到 cancel”的运行时测试。

#### K-M5｜队列不能忠实重放请求，出队启动结果也未闭环

- **计划位置**：Task 2 `:156-164` 的 QueueItem 不含 `skill` / `at`；Task 6 `:643` 使用未说明来源的 `tabId`，`:660` 在 `sendToAgent` 前先 emit `session/queue-start`；Task 10 `:994` 只新增 `modelId` 参数。
- **源码证据**：`App.tsx:2247-2254` 当前请求不含 `tabId`，`skill` 与 `at` 是独立字段；`sessions.ts:118-130, :216-241` 消费这些字段，`:224-233` 用 `at.clientMessageId` 锚定运行卡；`:185-203` 还有不调用 followup 的正常早退。
- **失败链 A**：宿主没有真实 tabId 可写入 QueueItem；排队后 skill/@ 退化为普通文本，技能不注入、@ 子代理不启动，运行卡丢失用户消息锚点。
- **失败链 B**：预检成功后已发 queue-start，客户端置 running；随后 followup 前抛错没有 queue-fail/运行态回滚，原 HTTP 发送早已返回 waiting。无 followup 的正常早退也可能永远没有对应 session/end。
- **修订要求**：`session.send` 明确携带发送时的 tabId；QueueItem 保存完整、不可变的放行参数（至少含 skill 与 at{name,clientMessageId}），出队原样重放。明确 `followupAccepted/started` 结果，后台启动异常必须 queue-fail + releaseAndDrain，无 followup 的早退也必须发完成/失败事件回滚 running。补排队 skill、排队 @、queue-start 回原 tab、后台启动异常四条回归。

#### K-M6｜run-once catchup 未纳入唯一准入，并漏改两条冲突旧测试

- **计划位置**：Task 8 `:778, :842` 规定 enqueue 不再 admit；`:840` 的待准入列表只有 dueAutomations 与 admissionSkips，没有明确改写 missed run-once 分支。
- **源码证据**：`automation-scheduler.ts:121-146` 对 `missedPolicy='run-once'` 仍先 `advanceNextRunAt`，再 `enqueueAutomation({ trigger: 'catchup' })`。首次进入该分支时既不在 dueAutomations，也尚无 admissionSkips。
- **失败链**：按计划改完 due 列表后，首次 overdue catchup 会经“不再准入”的 enqueue 直接执行，绕过 rootWriter/cap；若实施者直接删掉该调用，又会丢掉 run-once 补跑语义。
- **测试缺口**：`automation-scheduler.spec.ts:296-333` 与 `:335-362` 仍钉住跨根 catchup 不执行，Task 8 Step 1 未点名改写。
- **修订要求**：catchup 也经过同一次 `admitAutomation`；skip 时不 advance、不记失败运行、不执行，start 后再执行/推进。改写上述旧测试，并补“catchup 遇同根 writer/cap-full 不执行，释放后才执行”的断言。

#### K-M7｜用户与自动化的 root 未统一规范化，同一实际目录可占两个写者

- **计划位置**：Task 3 `:353, :383` 的用户根经 `resolve`；Task 8 `:842` 自动化直接传原始 `project.root`；Task 2 `:190, :285-291` 按原字符串作 Map 键。
- **源码证据**：`stores.ts:65-77` 的 `createProject` 只 trim + stat，原样保存 root，接受尾分隔符、相对形式及含 `..` 的现存目录。
- **失败链**：项目 root 为 `/tmp/p/` 或 `/tmp/a/../a` 时，用户准入键为 `/tmp/p` 或 `/tmp/a`，自动化键仍是原始串；两者实际 cwd 相同，却能同时 start。
- **修订要求**：user/automation 两个准入入口统一以 `path.resolve(root)` 生成调度键，QueueItem、RootWriter 与释放共用该 canonical root；补尾分隔符/`..` 形式的跨 user/automation 互斥测试。

#### K-M8｜客户端仍未建立每回合身份，停止、终态与 diff 会串台

- **停止单槽残余**：Task 10 `:988` 只点名 `turnTabRef` / `turnSessionRef` / `liveChatRef`，未处理 `App.tsx:500-503` 的 `stopPendingRef` / `userStopSessionRef`、`:589` 的 `stopping` 及 `:478-482` 的 `turnPulse`。A 停止在飞时，全局 stop ticket 仍会挡住或误记 B 的停止。
- **同标签多等待项终态错归属**：`logic/toolPanel.ts:170-196` 总是找最后一条用户消息；A 执行、B/C 等待时，A 的 session/end 会把仍在等待的 C 标为 final。`logic/outcomeCheck.ts:311-321` 的 latest-user 判据也会丢弃或错接 A 的核对结果。Task 10 的 queueItemId 只关联等待文案，没有关联实际 active turn 的终态。
- **diff 仍缺按标签存储与唯一写者查询**：当前 `App.tsx:1429-1431` 仍写进程级单份 diff；计划 `:996` 要求缺 sessionId 且恰好一个占名额回合时补上该会话 id，但 Task 2 `:173-187` 只有 `activeTurnCount()`，没有唯一活动写者 id 查询，长期保留的两张 Map 也不能用来猜当前写者。
- **修订要求**：停止票据、进度与 active-turn 状态按标签/会话隔离；建立 active turn ↔ 用户 ChatItem.id 的明确对应，session/end、goal/outcome 与工具终态按该 id 结算，不再取最后一条用户消息。diff 改为按标签保存；调度器增加只统计占名额写者的 `soleCapWriterSessionId()`，补缺 id 的 0/1/2 活动回合测试及 A/B 切标签隔离测试。

### 8.2 同期次级缺口（Minor，但均须明确处置）

| 编号 | 缺口与证据 | 修订要求 |
| --- | --- | --- |
| **K-P2-1** | Task 9 `:871, :883` 只改 `rpc-types.ts` 的 TaskInfo；客户端实际从 `client-huaanwork/logic/projects.ts:60-66` 取另一份 TaskInfo，其中没有 `modelId`，Task 10 读 `task.modelId` 会 TS2339。 | 合并为单一类型来源，或至少同步 `modelId?: string`，并让 `setTaskModel` 返回同一类型。 |
| **K-P2-2** | Task 5 `:540` 只在 subagent/end 删除子模型键，Task 6 `:680` 复制子 root 却没有对应正常结束清理；`skills.ts:249-258` 的成对清理点目前只 `forgetChildSession`。 | subagent/end 同时删除 child 的 model/root 键且不动父键；父会话 remove 在 forgetChildSessions 前快照并级联清理后代键。 |
| **K-P2-3** | `automations-host.ts:436-439` 的脚本 timeout 先 kill 后立即 finish/resolve，真实 close 在 `:448-450` 才发生。若把 `await runScript` 当成“进程结束”释放，旧进程树仍可能与下一同根回合重叠。 | 脚本完成 Promise 在 timeout 后也等待实际 close，或另暴露 actualExit；releaseAndDrain 只挂 actualExit，并补延迟关闭脚本时序测试。 |
| **K-P2-4** | Task 6 `:589-592` 只 `await idle.promise` 就立即断言第二次 followup；`startQueuedItem` 还有异步复检，正确实现也可能尚未执行到第二次 followup。 | 用第二次 followup 的 deferred/事件等待代替对同一 idle Promise 的即时断言，避免测试时序失真。 |

### 8.3 重新进入实施的条件

1. 先修 K-M1 / K-M2，保证 Host 可启动且调度器基本写者不变量成立。
2. 再修 K-M3～K-M7，闭合释放所有权、队列取消/重放/启动、catchup 与 canonical root。
3. 随后修 K-M8 与 K-P2-1～K-P2-4，补齐同标签多回合、停止和 diff 的真实接线测试，不能只以纯函数测试代替。
4. 对上述失败链分别新增可红的回归测试后，再进行一轮针对性复审；复审通过前不得从 Task 1 开工，也不得继续引用 §七的 GO 作为当前状态。

---

## 九、第五轮修订复审（Kimi 评审，2026-11-04）——仍需小修，暂不能 GO

- **评审者**：**Kimi**
- **评审对象**：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（Grok 根据 §八修订后的 1425 行版本）
- **对照基准**：设计规格、§八问题清单，以及 `dsh-plugin-huaanwork/` 当前源码与测试
- **评审方式**：只读静态复核；未执行测试，未修改设计、实施计划或产品代码
- **结论**：**仍未达到实施标准（NO-GO）**，但已大幅接近收口。剩 **2 项 Major（R-M1、R-M2）与 1 项 Minor（R-P2-1）**，不需要重新设计

### 9.1 §八问题闭环核对

| 上一轮编号 | 本轮状态 | 1425 行版核验说明 |
| --- | --- | --- |
| **K-M1** Cordis holders 未注册 | **已闭环** | Global Constraints `:25`、Task 6 `:640-642, :701` 已把两张 Map 纳入 module augmentation、`HUAANWORK_CONTEXT_PROPS` 和真实 `new Context()` 测试。 |
| **K-M2** 自动化成功漏占根 | **已闭环** | Task 2 `:291-322, :361-365` 明确成功写 `rootWriters`，并补 agent/script 占根、互斥、释放与 `soleCapWriterSessionId` 测试。 |
| **K-M3** 释放所有权与早退 | **主体已闭环** | Global Constraints `:27` 与 Task 6 `:735-756` 改为每次准入一个 `releaseOnce`，覆盖 idle、followup 前失败和无-followup 返回；Task 8 `:949-951` 补自动化早退及脚本实际 `close`。直接发送的客户端无-followup 终态仍有残留，见 R-M1。 |
| **K-M4** 等待取消误停活动回合 | **已闭环** | Global Constraints `:30`、Task 6 `:760` 与测试 `:685` 明确 queueItemId 分支只移除等待项，不调用 cancelAgent、不释放活动写者。 |
| **K-M5** 队列重放与启动结果 | **部分闭环** | QueueItem 已保存 tabId、skill、at 并原样重放，后台出队异常也有 queue-fail；但直接 `session.send` 的无-followup 正常早退没有客户端终态，见 R-M1。 |
| **K-M6** catchup 绕过准入 | **已闭环** | Task 8 `:938-947` 已把 missed run-once 并入同一 admitAutomation，skip 不推进、不执行，并点名改写两条跨根旧测试、补 `catchup waits for the root writer`。 |
| **K-M7** root 未规范化 | **已闭环** | Global Constraints `:26`、Task 2 `:324-333, :361` 与 Task 8 `:949-951` 统一 `path.resolve`，补尾分隔符与 `..` 的跨 user/automation 互斥测试。 |
| **K-M8** 客户端回合身份 | **部分闭环** | 停止票据、turnPulse、active ChatItem.id、diffByTab 与 soleCapWriterSessionId 均已落计划；但 queued 发送时的 goal 状态初始化时序仍未写清，见 R-M2。 |
| **K-P2-1～K-P2-4** | **已闭环** | TaskInfo 双份类型、子代理 Map 清理、脚本 close、第二次 followup 的事件等待均已纳入对应任务和 Task 11 回归表。 |

### 9.2 剩余 Major

#### R-M1｜直接发送遇到“无 followup 正常早退”时，客户端仍会假运行

- **计划位置**：Task 6 `:754` 已承认 `sendToAgent` 可能不调用 followup 就返回，但只对**后台出队**要求补发 `session/queue-fail`；`:756` 同样只处理后台失败。Task 10 `:1061, :1104-1106` 仍会让 `waiting:false` 的结果进入 running/active turn。
- **源码证据**：`sessions.ts:185-203` 的创建取消、更新失败提示都会 emit notice 后正常 return，未调用 followup；`:257` 仍只返回 `{ queued: true, sessionId }`，没有“未启动回合”的标志，也不会产生对应的 session/end。
- **失败链**：直接 `session.send` → 宿主 releaseOnce 已能释放写者，但路由仍按 waiting:false 成功返回 → 客户端设置 running:true 并登记活动用户消息 → 没有 followup，也没有 session/end → 标签永久假运行，停止按钮只能取消一个并不存在的活动回合。
- **修订要求**：`sendToAgent` 返回明确的 `followupAccepted/started` 结果；直接发送未启动回合时也必须返回终态结果或发终态事件，不能只处理后台出队。客户端对未启动结果不得设置 running/active turn。分别覆盖直接与排队的创建取消、更新失败路径，并同步响应契约。

#### R-M2｜排队发送仍会提前重置前一回合的 goal 状态

- **计划位置**：Task 10 `:1104-1106` 规定了 active ChatItem.id 和等待消息不参与 latest-user 选择，但没有规定 queued 项的 `turn-started`、epoch 等回合初始化必须等到实际 queue-start，也没有把 GoalTurnState 改成按 active turn 隔离。
- **源码证据**：当前 `App.tsx:2232-2239` 在每次发送时立即执行 `turn-started` 并推进 epoch；`logic/goalRound.ts:19-28, :75-83` 的 GoalTurnState 只按 sessionId 保存并清除 `settled` / `suppressed`。
- **失败链**：同会话 A 执行、B 排队 → B 尚未开始就发出 turn-started → A 的 settled/suppressed 被清除 → A 的 goal/session-end 到达时可能重复、丢失或错误抑制验收结论。新增的 outcomeCheck latest-user 测试覆盖不到这个 reducer 时序。
- **修订要求**：queued 项的 turn-started、epoch 等回合初始化延迟到实际 queue-start，或将相关状态改为按 active turn id 隔离；补“A 执行、B 排队，A 的 goal 结束到达后 B 再开始”的回归，不能只测 latest-user 选择。

### 9.3 剩余 Minor（测试接线，仍须处置）

#### R-P2-1｜`tabId` 改为必填后，既有及新增测试调用未迁移

- **计划位置**：Task 6 `:701` 规定缺少 `tabId` 抛出「缺少标签」，但 Task 8 自己的测试 `:905` 调用 `sessionSend` 就没有传 `tabId`。
- **现有测试冲突**：`tests/huaanwork-host/sessions.spec.ts` 与 `tests/huaanwork-host/agent-package-creation.spec.ts` 也有多处无 `tabId` 的 `sessionSend` 调用；其中部分用例原本验证网络门禁、文本校验或创建取消，会先被新的「缺少标签」错误截断。
- **修订要求**：迁移所有既有调用和 Task 8 示例，或明确仅用于旧式非 UI 调用的兼容 fallback；生产客户端仍必须传真实 tabId。更新后运行完整 host/client 套件，不能只跑新增用例。

### 9.4 复审通过条件

1. 为 R-M1 的直接与排队两条无-followup 路径定义统一的 started/终态语义，并证明客户端不会假运行。
2. 为 R-M2 明确 queued 回合初始化时点或 turn 级状态键，并用同会话连续两回合的 goal/outcome 测试钉住。
3. 迁移 R-P2-1 的全部 tabId 测试调用，确保目标测试失败时暴露的是被测行为而非「缺少标签」。
4. 三项修订落盘后再做一次针对性复审；通过前仍不建议从 Task 1 开工。

---

## 十、第六轮自审（Grok 4.7，2026-11-04）——宿主已闭环，客户端前导仍开放

- **评审者**：**Grok 4.7**
- **评审对象**：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（按 §九修订后的 1476 行版本）与同步改过的 `docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`（356 行）
- **对照基准**：§九的 R-M1、R-M2、R-P2-1，以及 `dsh-plugin-huaanwork/` 当前 `App.tsx` 与 `sessionSend` 测试调用
- **评审方式**：只读核对修订后的计划、规格与现有源码。未执行测试，未再改实施计划、设计规格或产品代码
- **结论**：**仍未达到实施标准（NO-GO）**。剩 **2 项开放（G-M1、G-M2）与 4 项 Minor（G-P2-1～G-P2-4）**。宿主契约可以保留，不必重新设计

> **第七轮勘误（Kimi 评审）**：本节 `:510` 把“两张 Map 都在 followup 受理后写入”当作闭环依据，这一判断与 Task 4/Task 6 的 create 前根表登记冲突；当前 1485 行计划与 358 行设计已拆分为 **root 在 create/resume 前、model 在 followup 受理后**。此外，Global Constraints 已明确只有 `started:true` 或 `session/queue-start` 才设置 running，因此 G-M1 中“应答前 `setTurnActive(true)`”已被计划禁止，不再作为开放项；G-M1 仅在停止闩锁、goal 中间结束和 stale epoch 读取三点上继续成立。其余 G-M2 与 G-P2-1～G-P2-4 经复核保留。

### 10.1 §九问题闭环核对

| 上一轮编号 | 本轮状态 | 1476 行版核验说明 |
| --- | --- | --- |
| **R-M1** 直接发送的无-followup 早退让客户端假运行 | **宿主半边已闭环** | Global Constraints `:22-24`、Task 6 `:753-776` 规定创建取消和更新失败返回 `waiting: false, started: false`，只发原来的 `agent/notice`，不抛成路由错误。出队后未受理 `followup` 只发 `session/queue-fail`，不发 `session/queue-start`，且不把仍在执行的上一回合标成结束。两张 Map 只在 `followup` 受理后写入，不删除该会话原有的键。直接与排队的创建取消、更新失败都有测试名。Task 9 把 `started` 列入 `session.send` 的必有返回键。客户端前导里的 `setTurnActive(true)` 仍可能把未启动发送留在执行态，并入 G-M1。 |
| **R-M2** 排队发送提前重置上一回合的 goal 状态 | **部分闭环** | Global Constraints `:24` 与 Task 10 `:1139-1141` 把该标签的 epoch 和 `turn-started` 推迟到 `started: true` 或 `session/queue-start`。`goalRound.spec.ts` 的对照序列能说明提前再开一次窗会放掉暂停结论。发送前导里的停止闩锁清理、以及排队 `queueItemId` 未写回已插入消息，仍开放，见 G-M1、G-M2。 |
| **R-P2-1** 必填 `tabId` 未迁移测试调用 | **已闭环** | Task 6 `:693-694` 点名 `sessions.spec.ts` 的 13 处 `sessionSend`、`agent-package-creation.spec.ts` 的 4 处，以及 `automations-host.spec.ts` 的 2 处 `session.send`。Task 8 示例 `:925` 已带 `tabId`。缺文本的 `{}` 仍先抛 `requires params.text`。直接调用 `sendToAgent` 的用例不加 `tabId` 门槛。Task 11 要求逐处核对，缺一处不算验收。 |

### 10.2 仍开放

#### G-M1｜排队或未启动的发送仍会拆掉正在执行的回合

- **计划位置**：Task 10 `:1139` 只禁止在 `session.send` 返回前增加 epoch 和发出 `turn-started`。`:1137` 把 `stopPendingRef`、`userStopSessionRef`、`stopping`、`turnPulse`、`turnEpochRef` 改成按标签存放，并写 `session/end` 按 `sessionId` 清除该标签的 `running`。没有禁止发送前导清掉上一回合的停止闩锁，也没有改 `goal/round` 对执行态的恢复。`:24` 只点了 `finishStop` 要读该标签自己的 epoch。
- **源码证据**：`App.tsx:2240-2245` 在等待 `session.send` 之前执行 `userStopSessionRef.current = null`、`latchOwnerRef.current = null`、`setTurnPulse(...)`、`setTurnActive(true)`、`stopping.current = false`。`App.tsx:3663` 的 `goal/round` 在 `drivesTrackedTurn` 时 `setTurnActive(true)`，`:3667` 的 `session/end` 在 `endsTrackedTurn` 时 `setTurnActive(false)`。`App.tsx:1220` 的 `consumeStaleIdle` 以及 `:902`、`:2282` 构造停止票据时，读的都是单一 `turnEpochRef.current`。
- **失败链**：同一标签上 A 正在执行、用户已经点了停止，B 只是排队。B 的发送前导清掉 A 的停止闩锁并把 `stopping` 拨回 false，A 的结束会被当成普通验收。目标续轮的中间 `session/end` 若按 `:1137` 无条件清除 `running`，而 `goal/round` 仍只写即将删除的全局 `turnActive`，续轮中的标签会失去停止按钮。epoch 改成按标签存放之后，`consumeStaleIdle` 若仍拿另一个标签的当前 epoch 来比，A 的旧结束会被当成过期结束丢掉。
- **修订要求**：排队和 `started: false` 不得清停止闩锁、不得改该标签的 `stopping`、不得在应答返回前 `setTurnActive(true)`。`goal/round` 按该标签把 `running` 设回 true；目标相位仍是 `active` 的中间 `session/end` 不得清除该标签的 `running`。`consumeStaleIdle`、`stopTurn` 造票据和 `settleStop` 都读事件所属标签自己的 epoch。补「A 的停止已扣闩，B 排队后 A 的结束仍记为用户停止」的回归。

#### G-M2｜排队 id 没有写回已经插入的用户消息

- **计划位置**：Task 10 `:1141` 要求 `waiting: true` 时用户消息带上 `queueItemId`，并说尚未收到 `session/queue-start` 的等待消息不参与「最后一条用户消息」选择。没有规定这条消息是在应答返回前插入的，也没有要求把后来才知道的 `queueItemId` 写回去。
- **源码证据**：`App.tsx:2228-2229` 在 `rpcCall("session.send")` 之前就把 `{ id, kind: "user", text }` 推进标签，此时还没有 `queueItemId`。
- **失败链**：实施者保持现有插入顺序，应答返回后只把 id 放进 `TabRunState.waitingIds`。这条用户消息没有 `queueItemId`，仍会被当成最后一条用户消息。A 的 `session/end` 终态记到 B 上。
- **修订要求**：应答返回后把 `queueItemId` 写回发送前已经插入的那条用户消息。只更新 `waitingIds` 不算完成。`started: false` 的消息不记成活动回合，也不标成等待项。补一条「消息先插入、应答后才补上 queueItemId，终态仍落在 A」的回归。

### 10.3 次要

| 编号 | 缺口与证据 | 修订要求 |
| --- | --- | --- |
| **G-P2-1** | Task 10 `:1131` 仍写「实现上面四个函数」。同任务接口已是六个，含 `sendOpensTurn` 与 `noteWaitingFailed`。 | 改成实现接口里列出的全部函数。 |
| **G-P2-2** | Task 6 `:776` 规定排队的创建取消或更新失败用已经发给用户的那句 notice 作为 `session/queue-fail` 的 `reason`。Task 10 `:1141` 又要求客户端显示这个 `reason`。同一句会先以 `agent/notice` 进入标签，再以失败原因进入一次。 | `queue-fail` 只去掉等待文案。`reason` 与刚发出的 `agent/notice` 相同时不再插第二条脚注。复检失败等没有 notice 的路径仍显示 `reason`。 |
| **G-P2-3** | 计划 `:7` 的 Architecture 仍写「宿主在 `followup` 受理后立刻应答」。`:22` 同时允许 `started: false` 在没有 `followup` 时立刻应答。 | 文首改成：受理了 `followup`、已经排队，或确认未启动，这三种都立刻应答，不等待 `whenIdle`。 |
| **G-P2-4** | Task 10 `:1122` 的 `goalRound` 对照调用的是现有 `reduceGoalTurn`，两条序列在当前 reducer 上都能通过，锁不住 App 的调用时点。`:1139` 的源码顺序测试只切片 `async function send()` 到下一个顶层函数，不包含 `session/queue-start` 分支。 | 源码测试同时钉住 `send()` 与 `session/queue-start` 处理函数：epoch 自增和 `kind: "turn-started"` 只出现在 `sendOpensTurn` 为真的分支里，以及 `queue-start` 已经调用 `noteWaitingStarted` 之后。 |

### 10.4 复审通过条件

1. G-M1：排队和未启动发送不再触碰正在执行回合的停止闩锁、`stopping` 和执行态；目标续轮的中间结束不把仍在续轮的标签清成非执行；epoch 的读取点都使用该标签自己的值。
2. G-M2：`queueItemId` 写回已经插入的那条用户消息，终态测试在「先插入、后补 id」的顺序下仍落在正在执行的那条上。
3. G-P2-1～G-P2-4 按上表改计划正文，避免实施者按过期句数、双写通知或过窄的源码切片做。
4. 上述修订落盘后再做一次只看 G-M1 与 G-M2 的复审。通过前仍不从 Task 1 开工。

---

## 十一、第七轮复核（Kimi 评审，2026-11-04）——结论保留，论据勘误

- **评审者**：**Kimi**
- **评审对象**：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（1485 行）与 `docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`（358 行）
- **对照基准**：§十「第六轮自审」、Map 规则修订，以及当前 `App.tsx`、`goalRound.ts` 与相关测试调用
- **评审方式**：只读静态复核；未执行测试，未修改实施计划、设计规格或产品代码
- **结论**：§十的 **NO-GO 方向属实，但需要按本节勘误后执行**。当前仍有 **G-M1（收窄后的三项）与 G-M2 两项 Major，以及 G-P2-1～G-P2-4 四项 Minor**，暂不建议从 Task 1 开工

### 11.1 已闭环及第六轮勘误

| 项目 | 第七轮状态 | 核验说明 |
| --- | --- | --- |
| §九 R-M1 `started` 结果与客户端 idle | **已闭环** | 直接和排队无-followup 都有 `started:false`、客户端不进入 running/active turn、queue-fail 不结束仍在执行的上一回合，响应契约同步包含 `started`。 |
| §九 R-M2 回合初始化时点 | **已闭环** | 当前 Task 10 `:1144-1146` 明确 epoch、turn-started 只在直接 started:true 或 queue-start 后发生，GoalTurnState 继续保持 sessionId 键，排队不提前清上一回合目标窗。 |
| §九 R-P2-1 tabId 测试迁移 | **已闭环** | Task 6 `:693-706` 覆盖既有调用、缺文本错误顺序与夹具调度器，Task 8 示例 `:925` 也已补 tabId。 |
| Map 生命周期 N-M1 | **已修复并补回归** | 当前 Global Constraints `:25`、设计 `:189, :203` 已拆分为 root 在 create/resume 前、model 在 followup 后；Task 6 `:756, :779` 与 Task 8 `:974` 已一致。回归名为 `first project creation keeps its root while another is foreground` 与 `automation binds its startup model after followup`。 |
| §十 `:510`“两张 Map 都在 followup 后” | **原判断错误，已勘误** | 该说法与 create 前根表登记冲突，不能再作为 R-M1 的闭环依据；闭环应引用上述拆分规则，而不是把两张 Map 一并推迟。 |
| §十 G-M1“应答前 setTurnActive(true)” | **不再单列为开放项** | Global Constraints `:26` 已明确只有 started:true 或 queue-start 才设置 running，排队与 started:false 不做执行态初始化。 |

### 11.2 仍开放的 Major

#### G-M1（收窄）｜停止闩锁、goal 中间结束和 stale epoch 仍未隔离完整

- **停止闩锁**：当前 `App.tsx:2240-2245` 仍在发送前清除 `userStopSessionRef`、`latchOwnerRef` 并把 `stopping` 置 false。计划只推迟 epoch/turn-started/running，没有明确排队和 started:false 不得清除正在执行回合的停止闩锁。
- **goal 中间结束**：`App.tsx:3660-3667` 的 goal/round 仍恢复旧全局执行态，session/end 仍直接清执行态；计划 Task 10 `:1142` 仍写 session/end 按 sessionId 清 running，没有排除 goal 相位仍 active 的中间结束，也没有要求 goal/round 按该标签恢复 running。
- **stale epoch**：计划只把 `turnEpochRef` 改成按标签存放，并点名 `finishStop` 比较本标签 epoch；`consumeStaleIdle`、停止票据构造和其他读取点没有全部明确使用事件所属标签，跨标签旧结束仍可能被错误丢弃或接受。
- **修订要求**：排队和 started:false 不得清停止闩锁或改 stopping；goal/round 按事件所属标签恢复 running，goal 仍 active 的中间 session/end 不得清 running；`consumeStaleIdle`、`stopTurn` 造票据和 `settleStop` 全部读取所属标签的 epoch。
- **必须新增**：「A 的停止已扣闩，B 排队后 A 的结束仍记为用户停止」以及「goal 中间 session/end 不清 running」两条接线回归。

#### G-M2｜`queueItemId` 仍未明确写回已经插入的用户消息

- **源码证据**：`App.tsx:2228-2229` 在 `rpcCall('session.send')` 之前就把 `{ id, kind:'user', text }` 插入标签，此时没有 queueItemId。
- **计划缺口**：Task 10 `:1146` 只说 waiting:true 时用户消息“带上”queueItemId，没有明确在应答返回后更新发送前已经插入的那条消息；只更新 `TabRunState.waitingIds` 不足以让终态/等待文案识别它。
- **失败链**：A 执行、B 排队；B 的消息已在标签里但没有 queueItemId → 它仍被 latest-user 逻辑当成最后一条活动用户消息 → A 的 session/end 可能把终态记到 B 上。
- **修订要求**：应答返回后按本地消息 id 把 queueItemId 写回已经插入的用户消息；started:false 不标等待也不记活动回合。补「先插入消息、应答后补 queueItemId，终态仍落在 A」的 App 接线回归。

### 11.3 保留的 Minor

| 编号 | 第七轮核验 | 修订要求 |
| --- | --- | --- |
| **G-P2-1** | 当前 Task 10 `:1136` 仍写“实现上面四个函数”，接口实际已有 `sendOpensTurn`、`noteSendResult`、`noteTurnEnded`、`noteWaitingStarted`、`noteWaitingCancelled`、`noteWaitingFailed` 六个。 | 改为实现接口列出的全部函数。 |
| **G-P2-2** | Task 6 `:779` 用已发 notice 作为 queue-fail reason，Task 10 `:1146` 又显示 reason，同一提示可能双写。 | queue-fail 只移除等待文案；reason 与刚发 notice 相同则不重复插入，其他复检失败仍显示 reason。 |
| **G-P2-3** | 文首 Architecture `:7` 仍只说“followup 受理后立刻应答”，Global Constraints `:24` 已允许排队和确认未启动也立即应答。 | 文首改为“已受理、已排队或确认未启动均立即应答，不等待 whenIdle”。 |
| **G-P2-4** | goalRound 对照测试只证明 reducer 行为，不能锁 App 调用时点；`:1144` 的源码切片只覆盖 send()，未覆盖 queue-start 分支。 | appWiring 同时钉 send 与 queue-start：epoch/turn-started 只在 sendOpensTurn 为真分支，且在 queue-start 已调用 noteWaitingStarted 之后。 |

### 11.4 后续修订与复审条件

1. 先完成 G-M1 收窄后的三项和 G-M2，不得用“全局 running 已推迟”替代停止闩锁、goal 中间结束和 stale epoch 的具体接线。
2. 同步处理 G-P2-1～G-P2-4，特别是 queue-fail 通知去重和 queue-start 的源码顺序钉。
3. 新增上述停止闩锁、goal 中间结束、queueItemId 写回的 App 接线测试，不能只用纯函数测试替代。
4. 修订后做一次只针对这些开放项的第八轮复审；通过前仍不从 Task 1 开工。

---

## 十二、第八轮复审（Grok 4.7，2026-11-05）——第七轮已闭环，抛错路径仍开放

- **评审者**：**Grok 4.7**
- **评审对象**：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（1522 行）与 `docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`（366 行）
- **对照基准**：§十一「第七轮复核」、计划文首第七轮与第八轮吸收段，以及当前 `App.tsx` 的 `send()`
- **评审方式**：只读对照规格、计划与现有发送失败分支。未执行测试，未修改设计规格、实施计划或产品代码
- **结论**：**仍未达到实施标准（NO-GO）**。§十一列出的两项 Major 与四项 Minor 已经写进计划和规格，不需要重新设计。还剩 **1 项 Major（R8-M1）**。补上抛错路径的收口和对应接线回归后，再做一次只看这一项的复审；通过前仍不从 Task 1 开工

### 12.1 §十一问题闭环核对

| 上一轮编号 | 本轮状态 | 1522 行版核验说明 |
| --- | --- | --- |
| **G-M1** 停止闩锁、goal 中间结束、stale epoch | **已闭环** | Global Constraints `:31` 与 Task 10 `:1159` 写明：排队和 `started: false` 不得清 `userStopSessionRef`、`latchOwnerRef`、`stopping` 或既有 `turnPulse`。`goal/round` 只恢复事件所属标签的 `running`；`GoalTurnState.phases[sessionId] === 'active'` 的中间 `session/end` 不清 running、不撤停止按钮。`consumeStaleIdle`、`stopTurn` 造票据、`settleStop` 与 `finishStop` 都读事件所属标签的 epoch。规格 `:144` 同文。回归名为 `a queued send preserves the running turn stop latch`、`a goal intermediate end keeps the tab running`、`stale idle uses the event tab epoch`。 |
| **G-M2** `queueItemId` 写回已插入消息 | **已闭环** | Task 10 `:1163` 要求应答返回后按本地 `userMsg.id` 把 `queueItemId` 写回已经插入的同一条用户消息，只更新 `waitingIds` 不算完成。`started: false` 不写 id、不标等待、不记活动回合。规格 `:245` 同文。回归名为 `a queued response backfills the inserted user message`。 |
| **G-P2-1** 函数计数 | **已闭环** | Task 10 `:1153` 改为「实现上面接口列出的全部六个函数」。 |
| **G-P2-2** queue-fail 与 notice 双写 | **已闭环** | Task 10 `:1167`：`reason` 与刚收到的 `agent/notice.text` 相同时只保留原来的 notice；没有 notice 的复检失败仍显示 `reason`。回归名为 `queue fail does not duplicate the emitted notice`。 |
| **G-P2-3** Architecture 应答表述 | **已闭环** | 文首 `:7` 改为：宿主在 `followup` 已受理、消息已排队或确认未启动时都立刻应答，不等待 `whenIdle`。 |
| **G-P2-4** 源码顺序只覆盖 `send()` | **已闭环** | Task 10 `:1165` 同时钉 `send()` 与 `session/queue-start`：epoch 自增和 `kind: "turn-started"` 位于 `rpcCall('session.send')` 之后且在 `sendOpensTurn` 为真的分支里；queue-start 分支中二者位于 `noteWaitingStarted` 之后。测试名 `queued send opens the goal window only when the turn starts`。 |
| 第八轮竞态（应答与 WebSocket 不保证先后） | **已写入，不另立开放项** | 规格 `:146` 与计划 `:19`、`:32`、Task 10 `:1161-1167` 一致：RPC 前以 `tabId + 本地 userMsg.id` 建 pending，pending 本身不开目标窗。没有正在执行的同会话回合时，早到的 `session/end` 与 goal 事件进入本次缓冲；上一回合仍在执行时，它的事件即时处理。未知 `queueItemId` 的 `queue-start` / `queue-fail` 暂存，已能匹配其他等待消息的事件不扣住。应答先写回身份，再初始化，再按原顺序重放；`started: false` 只丢弃本次缓冲。`agent/notice` 不缓冲。回归名为 `early session end is buffered until the started response`、`early queue start is buffered until the queued response`、`pending send does not buffer the previous turn events`。 |

调度器、可写根、模型与网络门禁、自动化准入、Cordis 上的两张 Map，仍按 §六至 §十一已闭环的任务执行，本轮没有把它们重新打开。

### 12.2 仍开放的 Major

#### R8-M1｜`session.send` 抛错仍会拆掉正在执行的回合，并留下等不到应答的 pending

- **计划位置**：Global Constraints `:28` 把网络门禁、缺文本、缺 `tabId`、根不存在、模型不在列表中保持为抛错，不走 `started: false`。`:31` 与 Task 10 `:1159` 只禁止排队和 `started: false` 清除停止闩锁、`stopping` 与进度。Task 10 `:1161` 要求保留「先插入用户消息，再建立 pending，再调用 `session.send`」。`:32` 与 `:1163` 只规定 `started: false` 丢弃本次缓冲。全文没有写 `catch` / `finally`。
- **源码证据**：`App.tsx:2228-2229` 在 `rpcCall("session.send")` 之前插入用户消息。`:2260-2270` 的 `catch` 先 `setTurnActive(false)`；若 `stopping.current` 为真，把它拨回 false 并直接返回，错误脚注不会写入。否则把整个标签标成 `sessionFailed` 并追加原因。`:2272` 的 `finally` 只清除 `sendingRef`，没有 pending 可清。
- **失败链**：同一标签上 A 正在执行，用户已经点了停止。B 因模型已删除或可写根不存在，在准入前抛错，拿不到 `started: false`。实施者若把执行态改成按标签存放、又留下这段 `catch`，会依次发生：
  1. B 的消息已经在标签里，没有 `queueItemId`，也不是活动回合。按「最后一条用户消息」选择时，它不被等待项规则排除，A 的终态可能记到 B 上。
  2. `catch` 清掉该标签的 `running` 和 `stopping`。A 随后的结束不再记成用户停止。
  3. 停止闩锁还扣着时，现有 `catch` 在写脚注之前返回。规格 §4.4 与 §6 要求的失败原因不会出现在标签上。
  4. RPC 前建立的 pending 没有应答可结束它。之后的 `session/end` 或 `queue-start` 会进入一个永远等不到写回的缓冲；上一回合的事件因此被拖住。
- **修订要求**：
  1. 抛错不得清除该标签正在执行回合的停止闩锁、`stopping`、epoch 和 `running`，也不得把仍在执行的标签标成 `sessionFailed`。
  2. 错误原因仍然写入该标签。不得因为停止闩锁还扣着就吞掉这条脚注。
  3. 已插入、但这次没有成为活动回合、也没有 `queueItemId` 的用户消息，不参与终态，也不参与「最后一条用户消息」的选择。
  4. `catch` / `finally` 丢掉这一次 pending，规则与 `started: false` 相同。上一回合的事件不得被这次失败拖住。
- **必须新增**：`a rejected send leaves the running turn stop latch`。A 的停止已扣闩，B 因模型不存在或根目录不存在抛错；A 的闩锁、`stopping`、epoch 和 `running` 不变，标签上能看到失败原因，A 的结束仍记为用户停止，这次 pending 不残留。

### 12.3 不挡开工的偏差与测试缺口

这些是计划相对规格 §5.5 接口块的既定改法，行为仍符合 §4 与 §5.1.1。实施时按计划执行，不要改回规格接口块里的同步推导或「`release` 内部出队」。

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| 根由调用方传入 | **接受** | 计划 `:34`：调度器不推导根、不读盘。调用方先 `await writableRootForSession(...)`，再把 `root` 传给 `admitUserTurn`。规格 §5.5 的签名块仍写调度器自己推导根；§5.1.1 已经要求推导结果在准入时算一次并随队列项保存。以计划为准。 |
| 释放与出队分开 | **接受** | 计划 Task 2：`release` 本身不调用 `drainQueue`。同一次 `releaseOnce` 先 `release`，再出队。规格 §5.5 把出队写在 `release` 内部。可观察的时序仍是回合结束后才出队。 |
| 模型表保留到会话删除 | **接受** | 计划 `:36`：不在 `whenIdle` 删除 `huaanworkSessionModels`，`sessionRemove` 时删除，避免回合刚结束的标题生成改读全局模型。这满足规格 §4.4 的续轮与后续生成仍用已绑定模型。规格 §5.2.1「会话结束或删除时清除」不要理解成 `whenIdle`。 |
| **R8-P2-1** 调低上限缺自动条款行 | **不挡开工** | 规格 `:347` 要求：上限从 3 调到 1 时，已经在执行的回合继续，新的发送等待。Task 2 用实时的 `maxConcurrentTurns()`，并在 `activeTurnCount >= max` 时入队，不取消已有写者。Task 13 有对应手工步骤。Task 11 的条款表没有单独一行。行为已经写死，不构成另一条失败链。 |

### 12.4 复审通过条件

1. 为 R8-M1 写明抛错路径的四条收口，不得用「排队和 `started: false` 已经保护执行态」代替 `catch` / `finally`。
2. 增加 `a rejected send leaves the running turn stop latch`，并把它列入 Task 11 的条款表。断言覆盖闩锁、失败原因、终态仍落在 A，以及 pending 不残留。
3. 上述修订落盘后再做一次只看 R8-M1 的复审。通过前仍不从 Task 1 开工。




