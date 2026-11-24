# 专家团多智能体协作（`feat/expert-team-impl`）Code Review（Double-Check 校准版）

- **日期：** 2026-11-23
- **审阅目标：** 分支 `feat/expert-team-impl`
  - 共同基线（`master`）：`3ad0a10af73d92bae28568032f5f2757bb557be0`
  - 设计/计划落定基线（`docs/expert-team-design`）：`e786ae8bd4746fef90b6ecfd04195404964c3b55`
  - 分支 `HEAD`：`6f8182eb3b6bf788a745e2c54977c57cb34c272b`（最终代码提交为 `eca2ceb5b0`；相对 `master` 共 46 个提交、89 个文件，`23289 insertions(+), 190 deletions(-)`；相对 `docs/expert-team-design` 共 43 个提交）
  - 上游子模块 `deepseek-harness`：`1600d8a1e140dcde43a1a0941940a0480712c011`（干净无修改；锁文件零修改）
- **对照依据：**
  - 设计规格：[2026-11-21-expert-team-design.md](../specs/2026-11-21-expert-team-design.md)（§1–§19 + 产品与技术裁定 R1–R16）
  - 规格评审记录：[2026-11-21-expert-team-design-review.md](../specs/2026-11-21-expert-team-design-review.md)
  - 实施计划：[2026-11-22-expert-team.md](./2026-11-22-expert-team.md)（Task 1–Task 18）
  - 计划评审记录：[2026-11-22-expert-team-plan-review.md](./2026-11-22-expert-team-plan-review.md)（§1–§8，含 B-1..B-4、I-1..I-5、S-1..S-11、R-1..R-4）
  - 验收证据：[2026-11-22-expert-team-acceptance.md](../../evidence/2026-11-22-expert-team-acceptance.md)
- **最终判定：** **Approve with comments / Ready to merge with fixes（0 Critical / 2 Important / 5 Minor / 4 Nit）。** 三域（Host 数据与编排 / 包派发隔离与护栏 / Client UI 与投影）实现与规格 §5–§19、计划 Task 1–18 及计划评审全部复审入口经实证闭环；建议在合并或执行真机验收前处置 **I-1**（独立成员运行卡去重后，`ExpertTeamRunCard` 未展示成员 `cleanupWarnings` 清理告警）与 **I-2**（`execute + supersedesResultId` 技术重试在 `sequential` 前序引用校验、已替代目标防重入及星型多重试结算上的 3 处规则缝隙）。

---

## 一、Double-Check 与校准说明

采用三路并行领域审查（Domain A：Host 存储/可用性/路由/运行注册表/文本协议/编排纯函数/协调器/观察器/会话启动与结算；Domain B：包成员派发子会话隔离/团长工具与 Policy/主 Artifact 交付/真实组合与编译产物 Loader Smoke；Domain C：客户端契约/中文与 `@team:` 词法/运行投影 Reducer/管理视图与聚合运行卡）+ 主审逐条读码反证复核（「去误报、消夸大、查漏报、校事实」）：

| 类别 | 初审结论 / 复核对象 | 复核事实与源码依据 | 校准处理 |
| --- | --- | --- | --- |
| **消夸大（降级：Important → Minor M-1）** | Domain A 将 [index.ts:394-398](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/index.ts#L394-L398) 的 `resolveMemberPackage` 调用同步 `agentPackageHost.detail()`（未跑 `decorateCatalogItem` 异步验签）定为 **Important** | 主审核对 [session.ts:202](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts#L202) 与 [agent-package/host.ts:1533,1588](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1533-L1588)：① 团队启动预检 `loadInvocableTeam` 已调用 `host.listWithLegacy()`（对全部 catalog 包执行 `decorateCatalogItem` / `security.verifyInstalled`）；② `dispatchTeamMember` 执行期在 `createRuntime` 前后执行两次 `security.assertRunnable`，**不存在任何安全绕过**。实际影响仅限于「团队启动后、派工/排队中途 catalog 包磁盘文件或签名被篡改」这一极端窗口：此时 `requirePackage` 未在入队/出队重验时抛 `expert-team-member-broken`，而是进入同步临界区建出 `ExpertTeamResult`（若为首份统一返修则递增 `unifiedRevisionRounds`）后再由 `dispatchTeamMember` 失败返回。将 `detail(agentRef.slug)` 改为 `await agentPackageHost.findInvocable(agentRef.slug)`（[agent-package/host.ts:553-560](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L553-L560)）仅 1 行改动 | 由 Important 下调为 **Minor（M-1）** |
| **跨层同源合并（Minor M-2）** | Domain A `[M-2]`（Host `store.ts` / 提示词渲染对 `""` 未按缺省处理）与 Domain C `[M-1]`（Client `ExpertTeamEditor.buildPayload()` 将空白可选字段发为 `""`） | 核实两域发现指向同一跨层链路：[ExpertTeamEditor.tsx:274-305](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamEditor.tsx#L274-L305) 对空白可选字段（`scenarios`、`member.outputInstructions`、`orchestration.instructions`、`review.criteria`、`summary.instructions`）发送 `""`；[store.ts:79,89,98,108,133](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts#L79-L133) 与 [coordinator.ts:205](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts#L205)、[session.ts:156,169,175,190](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts#L156-L190) 均只检查 `!== undefined`，导致落盘空串并在团长/成员提示词中输出空标题行（`输出要求：`、`- 补充说明：` 等），每次成员派工额外消耗 256 KiB 预算中的 16 UTF-8 字节 | 合并为 **Minor（M-2）** |
| **去误报核验（Important I-1 & I-2）** | Domain C `[I-1]`（成员 `cleanupWarnings` 在独立子代理卡被去重后无 UI 出口）与 Domain A `[I-1]`（`execute + supersedesResultId` 重试规则缝隙） | 主审逐行核实 [App.tsx:1921,2995](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1921)、[progressPanel.ts:112](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts#L112)、[ExpertTeamRunCard.tsx:239-259,323-358](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L239-L259) 及 [orchestration.ts:384-424,604-624](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L384-L424)：两项均为真实存在的规格偏差/规则漏洞，触发条件清晰 | 确认为 **Important（I-1、I-2）** |
| **查漏报（主审横切面抽查）** | 主审直接检查 `App.tsx` 计时器、重连对账、取消确认清理、mid-turn claim 过滤、`result_present` 异锚重放 | ① 主审直接检出 [App.tsx:2740-2745](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2740-L2745) 共享 1 秒计时器未包含活跃 `expertTeamRuns`（与 Domain C `[M-2]` 相互印证，归为 **M-3**）；② 核实 [expert-team-dispatch.ts:225-226](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/expert-team-dispatch.ts#L225-L226) 已通过 `isTurnBoundaryMessage` 过滤 `repeat-tool-reminder` 等 mid-turn 注入；③ 核实 [result-artifact-tools.ts:164-184](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts#L164-L184) 与 [result-artifact-tools.spec.ts:627-651](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/result-artifact-tools.spec.ts#L627-L651) 已完整闭环计划评审 §8.2 R-1 | **无新增 Critical/Important 漏报** |

---

## 二、架构与实现亮点（经主审抽查实证）

1. **普通 `@智能体` 路径零修改与团队子会话强隔离（规格 §5 / §6.4 / R5 / R15）**
   - 普通 `dispatch()`（[agent-package/host.ts:563-1214](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L563-L1214)）在 `git diff` 中 **0 行修改**，`pendingTurns`、父会话绑定、单槽 `huaanworkAgentPackageRequest.current`、MCP 工具命名与 `delivery: 'parent'` 保持 100% 原样。
   - 团队专用 `dispatchTeamMember`（[agent-package/host.ts:1216-1720](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1216-L1720)）在首个 `await` 前分配 `reservedChildId`、登记 `activeTurns`（不占 `pendingTurns`）并同步触发 `onRunCreated`；runtime 与 MCP 直接挂载到 `reservedChildId`，父会话零 MCP 附件泄漏；`teamMcpServerName`（[dispatch.ts:27-29](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/dispatch.ts#L27-L29)）恒 ≤ 32 字符并由 `activeTeamMcpServerNames` 做活动冲突检测；[skills.ts:691-694,1000-1016](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L691-L694) 先按 `specChildId` 精确消费 `huaanworkAgentPackageTeamRequests` Map 再回落旧单槽，并在 provider 更换 `actualChildId` 时同时清理两类 ID 的绑定；单个成员结果 settle 后立即清理进程/MCP/绑定，不把 24 次派工的资源留到父回合结束。
   - 约 250 行取消/清理/超时重复逻辑已按工程纪律在 [AGENTS.md:65](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/AGENTS.md#L65) 诚实登记技术债。

2. **协调器同步临界区、24 次硬预算、256 KiB UTF-8 边界与双层可取消信号量（规格 §10.2 / §10.4 / §12.2 / §12.3）**
   - [coordinator.ts:587-688](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts#L587-L688) 在每次到达时即扣减 24 次硬预算，在入口与出队两处用 `Buffer.byteLength(prompt, 'utf8')` 校验 256 KiB 上限（不含包独立 64 KiB `persona`），并在最后一个 `await requirePackage` 之后的**同一同步 `options.runs.update` 临界区**内完成规则复核、`assertReviewScopeCurrent`、结果写入与 `unifiedRevisionRounds += 1`，保证同周期并行返修只递增一次返修轮数（闭环计划评审 §7.2 I-1）。
   - 成员启动失败、执行失败或单成员取消均返回携带 `resultId` 的结构化 `ExpertTeamDispatchResult`，团长可据此显式重试或如实披露；整团取消闭包同步失效租约、取消团长父回合（`cancelParentTurn`）、排空等待队列并定向取消在途成员。

3. **上游事件时序适配与三段式 Fail-Closed 回合结算（规格 §12.1 / §12.4.2 / §16.10）**
   - [observer.ts:220-267](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts#L220-L267) 直接从 `agent/inbox/claimed` 载荷锁定 `activeTurn = payload.turn`（适配上游 `turn/start` 先于 `claimed` 的真实顺序），以 `lastToolResultSeq` 精确识别最后工具结果之后的最终汇总文本并忽略 `reasoning`；`bindExpertTeamObserver` 与 `disposeExpertTeamObservers` / `disposeAllExpertTeamObservers(ctx)` 按会话和 Host 实例精确管理全局监听器生命周期。
   - [session.ts:249-331](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts#L249-L331) `settleExpertTeamTurn` 严格按「① 无条件同步 `invalidateLease` → ② 独立 `try/catch` 摘除 `expert_team_dispatch` 附件并刷新 restrict（失败记 `expert-team-attachment-detach-failed` 且不回滚租约）→ ③ 计算终态 + 最外层 `try/catch` 兜底落地 `partial/failed`」执行，防止上游 `invokeContainedSessionObservers` 吞掉异常导致运行滞留 `running`（闭环计划评审 §7.4 N-4）。
   - [sessions.ts:218,516-652](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L516-L652) 单次计算 `followupId = resolveFollowupClientMessageId(params)` 贯穿运行、`turnAnchors.register` 与 `agent.followup`；`!followupAccepted` 时在 `finally` 统一触发 `teamAbortBeforeSend` 并重置 `afterIdle = undefined`，同时覆盖 `followup` 抛错与 `admission.cancelled()` 早退；`skipPostCleanupIdle: true` 跳过第二次 `whenIdle()`。

4. **三层工具可见性门禁与主 Artifact 持久锚关联（规格 §10.3 / §12.4.1 / §16.8）**
   - `expert_team_dispatch` 同时接入 [model.ts:79](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L79)（`isRegisteredToolName` 放行原生 SSE 与文本协议工具流）、[policy.ts:36](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts#L36)（`SESSION_ATTACHED_TOOLS`）和 [decide.ts:147-148](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/packages/huaanwork-policy/src/decide.ts#L147-L148)（挂载即 allow、未挂载在 `ask/smart/full` 双缝均 deny）；[expert-team-dispatch.ts:225-226](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/expert-team-dispatch.ts#L225-L226) 用 `isTurnBoundaryMessage` 过滤 mid-turn 注入，防止 `repeat-tool-reminder` 误摘在途团队派工工具。
   - [result-artifact-tools.ts:115-184,228-235](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts#L115-L184) 在 `message` 交付模式下于 claim 入口抑制 `result_present`，在 `prepare` 后、`commit` 前复核取消闩、交付封闭与租约并调用 `discardPreparedArtifact`，在 `commit` 后始终按持久化 `artifact.anchor` 封存并关联（含首次关联失败后的同 `callId` 异锚重放恢复，闭环计划评审 §8.2 R-1）。

5. **客户端投影对账、Owner 词法裁定与验收证据诚实度（规格 §8.5 / §11 / §13 / Task 18）**
   - [expertTeamRuns.ts:161-243](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamRuns.ts#L161-L243) 对任何同代或换代 `snapshot` 恢复 `connection: "open"` 并清除 `frozenAt`（闭环计划评审 §7.1 B-1），通过 `shouldRemoveExpertTeamRunCard` 与 `evictedTerminalRunIdsFromSnapshot` 精确移除被淘汰或换代的聚合卡而不误删消息或 Artifact 卡。
   - [expertTeamsLogic.ts:98-104](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts#L98-L104) `resolveComposerMentionState` 严格落实 owner 裁定（开头同时开放两组、`@team:` 草稿抑制中段智能体菜单、普通草稿中段保留旧 `atTokenAt` 任意位置补全）。
   - [2026-11-22-expert-team-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-22-expert-team-acceptance.md) 严格区分自动化门禁通过（`corepack yarn check` EXIT=0，5551 passed / 15 skipped）与 9 项真机人工验收未执行（`BLOCKED — 未执行`）。

---

## 三、问题清单（校准后）

### Critical（必须修复）

无。

---

### Important（建议合并前或真机验收前修复）

#### I-1【规格偏差】独立成员运行卡去重后，`ExpertTeamRunCard` 未渲染成员 `cleanupWarnings` / 子代理清理告警（违反规格 §12.3 / §13.3）

- **位置**：
  - [ExpertTeamRunCard.tsx:239-259,323-358](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L239-L259)
  - [App.tsx:1921,2995](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1921)
  - [progressPanel.ts:112](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts#L112)
- **问题事实**：
  - 为避免同一次成员派工在主聊流和右栏“子代理”区重复渲染独立卡片，[App.tsx:1921,2995](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1921) 与 [progressPanel.ts:112](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts#L112) 过滤掉了所有携带 `teamRunId` 的独立 `SubagentRunCard`，使 `ExpertTeamRunCard` 成为团队成员运行状态的唯一 UI 载体。
  - 然而 [ExpertTeamRunCard.tsx:257-258](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L257-L258) 仅在 `active`（`result.status === "starting" || result.status === "running"`）时调用 `subagentStatusText(memberRun)`，既未调用 [subagentRuns.ts:515](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts#L515) 的 `subagentAlerts(memberRun, now)`，也未渲染 `memberRun.cleanupWarnings`（如 `activation-dispose-failed`、`activation-dispose-timeout`、`runtime-stop-failed`、`runtime-stop-timeout`）。
  - 更进一步：当成员取消或结束时若清理失败，Host 在 [agent-package/host.ts:1441-1444](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1441-L1444) 写入 `confirmCleanup(runId, { ok: false, warnings })`，而 `result.status` 已变为 `'completed'` / `'stopped'` / `'failed'`（`active === false`），此时成员行直接显示 `RESULT_STATUS_TEXT[result.status]`（如“已停止”或“已完成”），清理失败告警在 UI 上完全丢失。
- **为什么重要**：直接违反规格 §12.3（*“成员仍进入现有 run 投影，保留包版本、取消、错误和清理警告”*）与 §13.3（*“清理警告继续展示，不虚报‘已全部清理’”*）。
- **修复建议**：
  - 在 [ExpertTeamRunCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx) 导入 `subagentAlerts`；对关联到 `memberRun` 的成员行计算 `const memberAlerts = memberRun === undefined ? [] : subagentAlerts(memberRun, now)`，在成员行（或展开详情区/行内告警）渲染清理与停止等待提醒，并在 [ExpertTeamRunCard.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/ExpertTeamRunCard.spec.ts) 补一条带 `cleanupWarnings` 的断言。

#### I-2【规则漏洞】`execute + supersedesResultId` 技术重试存在 3 处确定性校验/结算缝隙（跳过 `sequential` 前序引用校验、允许重复替代已解决的失败结果、星型二次重试未消除前次失败记录）

- **位置**：
  - [orchestration.ts:604-624](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L604-L624)
  - [orchestration.ts:384-424](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L384-L424)
- **问题事实**：
  1. **`sequential` 后序成员技术重试跳过了前序引用检查**：[orchestration.ts:605-611](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L605-L611) 将 `sequentialExecuteError` 限定在 `input.supersedesResultId === undefined` 时才执行。若 `sequential` 团队的第 2 名执行成员首次 `execute` 失败（`r2-fail`），团长以 `kind: 'execute', supersedesResultId: 'r2-fail', inputResultIds: []` 重试该成员时，不会触发 `expert-team-sequential-reference`，导致第 2 名成员在无前序有效结果引用的情况下启动（违反规格 §10.1“后序成员必须通过 `inputResultIds` 引用前序有效结果”）。注：对第 1 名执行成员（`index === 0`），`sequentialExecuteError` 首行 `if (index <= 0) return undefined` 本就不会误拦。
  2. **未拒绝针对“已被有效结果替代的旧失败结果”的二次 `execute` 替代**：[orchestration.ts:612-622](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L612-L622) 只检查 `target.status === 'failed' || target.status === 'stopped'`，未检查 `target.resultId` 是否已经被后续结果替代。由于被替代结果的 `.status` 仍保持 `'failed'`，在 `r1-fail` 已被有效重试 `r2-ok` 替代后，团长仍可再次传 `kind: 'execute', supersedesResultId: 'r1-fail'` 绕过 `revision` 规则或重复刷出多份有效结果。
  3. **星型多次 `execute` 重试在 `hasUnsupersededExecutionFailure` 中未像 `revision` 一样豁免同目标的早期失败重试**：[orchestration.ts:415-420](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L415-L420) 仅对 `result.kind === 'revision'` 检查 `latestValidSupersedeIndex`（同成员针对同一 `supersedesResultId` 的后续有效替代）。若 `r1-fail` 的第一次重试 `r2-fail`（`kind: 'execute', supersedesResultId: 'r1-fail'`）再次失败，第二次重试 `r3-ok` 仍指向原 `supersedesResultId: 'r1-fail'` 并成功，则 `r2-fail` 不在 `r3-ok` 的祖先链上且因 `result.kind === 'execute'` 被第 415 行跳过，导致终态被误判为 `partial`。此外第 413 行 `if (result.status !== 'failed' && result.status !== 'stopped') continue` 应为 `if (isValidExecutionResult(result)) continue`。
- **为什么重要**：影响规格 §10.1（`sequential` 前序有效引用硬约束）、§12.3（技术重试不得替代已成功/已解决的执行结果）以及 §12.4.2 终态裁定的准确性。
- **修复建议**：
  - 在 [orchestration.ts:605-623](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L605-L623) 去掉 `&& input.supersedesResultId === undefined`；并在校验 `input.supersedesResultId` 时，若该 `target.resultId` 已被后续有效结果替代（或已被另一条结果指向），返回 `{ ok: false, error: 'expert-team-invalid-supersede' }`。
  - 在 [orchestration.ts:413-420](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L413-L420) 将 `if (result.kind === 'revision' && result.supersedesResultId !== undefined)` 放宽为 `if (result.supersedesResultId !== undefined)`，并将第 413 行改为 `if (isValidExecutionResult(result)) continue`。

---

### Minor（建议处置，不阻塞核心功能）

#### M-1【一致性】`index.ts` 中 `resolveMemberPackage` 调用同步 `agentPackageHost.detail()`，在派工入口/出队重验时未执行 catalog 包异步验签

- **位置**：[index.ts:394-398](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/index.ts#L394-L398)、[agent-package/host.ts:503-507,553-560](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L503-L507)
- **问题事实**：`agentPackageHost.detail(slug)` 只调用 `withRevoked(detail)`，不执行 `decorateCatalogItem`（异步 `security.verifyInstalled`）。虽然团队启动预检（`loadInvocableTeam`）和 `dispatchTeamMember` 执行期（两次 `security.assertRunnable`）均会严格阻断签名损坏的 catalog 包，但若 catalog 包在团队运行中途（或排队等待信号量期间）磁盘文件/签名损坏，协调器 `requirePackage` 在出队重验时不会抛出 `expert-team-member-broken`，而是进入同步临界区创建 `ExpertTeamResult`（若为首份统一返修还会递增 `unifiedRevisionRounds`），直到 `dispatchTeamMember` 才失败。
- **修复建议**：将 [index.ts:396](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/index.ts#L396) 的 `const pkg = agentPackageHost.detail(agentRef.slug)` 改为 `const pkg = await agentPackageHost.findInvocable(agentRef.slug)`（`findInvocable` 已内置 `decorateCatalogItem` 且保留 `broken` 详情供 `expertTeamMemberUnavailableReason` 判定）。

#### M-2【提示词与存储卫生】编辑器 `buildPayload()` 将空白可选文本字段发为 `""`，导致落盘空串并在团长/成员提示词中注入空标题行

- **位置**：
  - [ExpertTeamEditor.tsx:274-306](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamEditor.tsx#L274-L306)
  - [store.ts:79,89,98,108,133](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts#L79-L133)
  - [coordinator.ts:205](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts#L205)、[session.ts:156,169,175,190](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts#L156-L190)
- **问题事实**：用户在编辑器中未填写 `scenarios`、`member.outputInstructions`、`orchestration.instructions`、`review.criteria`、`summary.instructions` 时，`buildPayload()` 会发送 `""`（空字符串）。`store.ts` 与提示词渲染函数均只判断 `!== undefined`，导致 JSON 文件持久化空串，且每次派工提示词多出 `输出要求：` 空行（占用 256 KiB 预算中的 16 字节），团长提示词多出 `- 补充说明：` / `- 审查标准：` / `- 汇总重点：` 空行。
- **修复建议**：在 `store.ts` 的 `normalizeMember` / `normalizeOrchestration` / `normalizeReview` / `normalizeSummary` / `normalizeTeam` 中将 `.trim() === ''` 的可选文本归一化为省略该键（同时支持 `update` 时传 `""` 清空已有可选字段），并在 `coordinator.ts:205` 与 `session.ts:156,169,175,190` 用非空白判断守卫。

#### M-3【UI 状态】共享 1 秒计时器未订阅活跃 `expertTeamRuns`，重开历史标签或 `stopping` 收尾间隙时团队卡耗时不走表

- **位置**：[App.tsx:1163-1166,2740-2745](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2740-L2745)
- **问题事实**：`App.tsx:2742` 的秒表 `useEffect` 仅判断 `if (!anyTabRunning && !hasAnyActiveSubagentRun) return;`。当用户从侧边栏重开一个正在运行专家团的会话标签（此时 `tabRuns[tabId]?.running` 为 `false`）且团队正处于两次成员派工之间或等待队列中（`hasAnyActiveSubagentRun === false`），或父回合 `turn/end: aborted` 已触发而团队处于 `stopping` 等待清理收敛时，`now` 停止更新。
- **修复建议**：增加 `const hasAnyActiveExpertTeamRun = useMemo(() => [...expertTeamRuns.runs.values()].some((run) => !isExpertTeamTerminal(run)), [expertTeamRuns]);` 并并入 `App.tsx:2740-2745` 的秒表条件与依赖数组。

#### M-4【UI 交互】单成员取消进入 `memberRun.phase === "stopping"` 后，成员行“终止成员”按钮重新变为可点，且确认回调存在死分支

- **位置**：[ExpertTeamRunCard.tsx:246-256,278-313](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L246-L256)
- **问题事实**：
  1. `subagent.cancel` 返回 `{ status: "accepted" }` 后，`App.tsx:3291` 在 `finally` 中清除 `expertTeamCancelBusyByKey[key]`。此时成员 `memberRun.phase` 为 `"stopping"`，但 `result.status` 仍为 `"running"`（直到清理完成才变为 `"stopped"`）。由于 `ExpertTeamRunCard.tsx:246` 未像 [ProgressPanel.tsx:218](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx#L218) 那样把 `memberRun?.phase === "stopping"` 计入 `memberBusy`，成员行上的“终止成员”按钮在 `stopping` 期间会重新恢复可点击状态。
  2. [ExpertTeamRunCard.tsx:299-305](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L299-L305) 的“确认终止成员”按钮 `onClick` 含不可达分支 `memberRunId === undefined ? { kind: "team", ... } : { kind: "member", ... }`，不应以整团取消作为成员取消的 fallback。
- **修复建议**：将 `const memberStopping = memberRun?.phase === "stopping"` 纳入 `memberBusy` 并从 `memberConfirmVisible` 排除；确认按钮 `onClick` 改为 `if (memberRunId !== undefined) onConfirmCancel?.({ kind: "member", runId: memberRunId, surface })`。

#### M-5【鲁棒性】`observer.ts` 在 `turn/end` 事件自身 `seq` 异常时提前 `return`，使封闭推迟到 `afterIdle`

- **位置**：[observer.ts:231-241,258-266](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts#L231-L241)
- **问题事实**：当某条事件的 `seq` 缺失或非严格递增时，`observer.event` 调用 `markSeqAnomaly()` 后在第 233/237 行直接 `return`。若发生 `seq` 异常的恰好是当前 `activeTurn` 的 `turn/end` 事件（或此前某条事件带有异常高 `seq` 导致后续合法 `turn/end` 被判为 `seq <= lastSeq`），观察器会跳过第 258 行的 `turn/end` 同步结算，直到 `afterIdle` 才以 `eventMissing: true` 兜底结算。
- **修复建议**：在 `markSeqAnomaly()` 分支返回前，若 `!settled && activeTurn !== undefined && event.type === 'turn/end' && event.data.turn === activeTurn`，仍立即触发 `settle({ turn: activeTurn, finalSummaryPresent: false, eventMissing: false, reason: event.data.reason })`。

---

### Nit（低风险观察与维护建议）

- **N-1**：[agent-package/host.ts:1423-1426,1559-1577](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1423-L1426) — 若在 `createRuntime` 内部 awaiting `mountSessionMcp` 期间触发取消，`cleanup('cancel')` 会在 `mountSessionMcp` 返回并执行 `mounted.dispose()` 之前把 `mcpServerName` 从 `activeTeamMcpServerNames` 删除。生产路径使用 `reservedChildId` UUID 前 8 位后缀，实际不会撞名；可在 `cleanupStarted` 分支 `await mounted.dispose()` 后再删或跟踪 `mountingMcpPromise`。
- **N-2**：[App.tsx:1318-1320](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1318-L1320) — 用户在开头显式输入 `@team:<query>` 时，`atTeamQuery` 剥离了 `"team:"`，但 `atMatches` 仍用 `"team:<query>"` 检索普通智能体列表；可在 `allowTeams && atQuery.startsWith("team:")` 时将 `atMatches` 置为空数组。
- **N-3**：[expert-team-orchestration.spec.ts:585-590,621-629](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-orchestration.spec.ts#L585-L590) — 注释写明“有有效 revise 即可结 `completed_with_issues`”及“per-member 覆盖 0/1/2”，但下方只断言了 `unified` 0 轮派工拒绝和 `per-member` 1/2 轮，可顺手补上 0 轮终态与 `per-member` 0 轮的 2 行断言（计划评审 §8.2 nit）。
- **N-4**：[driver.ts:641-645,713,738,1060-1072,1176-1180](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/fixtures/expert-team/driver.ts#L1060-L1072) — 测试 fixture `createComplianceTeamScenario` 预先持久化了一份未被 `executeScriptedTeamRun` 复用的初始团队定义；`memberStream` 中的 `verdictByMember` 每次推入 1 个元素后立即在下一行 `shift()`，可简化为直接消费 `run.verdictQueue.shift()`。

---

## 四、计划 Task 1–18 与规格全量对照核验表

| 任务 | 规格对应章节 | 核心交付物与计划评审闭环项 | 状态 |
| --- | --- | --- | --- |
| **Task 1**：专家团契约、默认值、校验与中文检索 | §8.1, §8.2, §11.1 | [rpc-types.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts)、[expertTeamsLogic.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts)、[team.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/fixtures/expert-team/team.ts)（Plan Review I-4 闭环） | **PASS** |
| **Task 2**：团队定义的原子持久化 | §6.1, §8.5, §16.10 | [store.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts)、[types.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/types.ts)（复用 `assertSafePathSegment`，Plan Review N-1 / S-11 闭环） | **PASS**（含 M-2） |
| **Task 3**：有界内存团队运行注册表 | §6.2, §8.3–§8.5, §16.11 | [runs.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/runs.ts)（20/父会话、100/全局淘汰、非阻塞 `requestCancel`、`cancelAll`、持久锚匹配，Plan Review B-2 / S-7 闭环） | **PASS** |
| **Task 4**：定义可用性、CRUD 与运行 RPC | §7.2, §8.5, §9.2, §14, R3 | [availability.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/availability.ts)、[expert-team-routes.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team-routes.ts)（83→92 路由全 4 处测试同步，Plan Review B-3 闭环） | **PASS** |
| **Task 5**：成员文本与审查标记协议 | §2.2, §8.4, §10.4, §16.2 | [text-protocol.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/text-protocol.ts)（忽略 `reasoning`、拒绝非文本块、严格末行 `[VERDICT: PASS/REVISE]`） | **PASS** |
| **Task 6**：调度 scope、返修与终态纯函数 | §10.1, §10.4, §12.3, §12.4 | [orchestration.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts)（Plan Review I-3 / S-4 / S-5 / R-4 闭环；存在 **I-2** 与 **N-3**） | **PASS with I-2** |
| **Task 7**：团队包派发的子会话隔离与 caller 结果 | §5, §6.4, §10.3, §12.3, §16.4–§16.5 | [dispatch.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/dispatch.ts)、[agent-package/host.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts)、[skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts)（普通 `dispatch()` 零修改，Plan Review I-5 / N-2 闭环） | **PASS**（含 N-1） |
| **Task 8**：团队运行协调器、团队租约与派工排队 | §10.2–§10.4, §12.2, §12.3 | [coordinator.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts)（24 次预算、256 KiB UTF-8 边界、同步临界区递增 `unifiedRevisionRounds`，Plan Review I-1 / S-6 闭环） | **PASS**（含 M-1, M-2） |
| **Task 9**：团长附件工具、模型流放行与 policy 放行 | §6.3, §10.3, §12.1, §15, §16.1 | [expert-team-dispatch.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/expert-team-dispatch.ts)、[model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts)、[policy.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts)、[decide.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/packages/huaanwork-policy/src/decide.ts)、[index.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/index.ts) | **PASS** |
| **Task 10**：回合事件观察器与 abort 联动 | §12.1, §12.4.2, §13.3, §16.10 | [observer.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts)、[sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts)、[bridge.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts) | **PASS**（含 M-5） |
| **Task 11**：团队会话启动、排队隔离与 turn/end 结算 | §11.2, §11.3, §12.1, §12.4.2, §17 | [session.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts)、[sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts)、[turn-scheduler.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts)（Plan Review S-2 / S-3 / S-11 / N-1 / N-4 / R-2 闭环） | **PASS** |
| **Task 12**：`result_present` 团队交付与预算豁免 | §12.4.1, §16.8, §17 | [result-artifact-tools.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts)（24 次豁免、commit 前复检 discard、持久锚重放恢复，Plan Review S-1 / S-10 / N-3 / R-1 闭环） | **PASS** |
| **Task 13**：客户端团队运行投影与卡片锚定 | §8.5, §13.3, §16.11 | [expertTeamRuns.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamRuns.ts)（同代/换代 snapshot 解冻、20/100 淘汰、防状态回退，Plan Review §7.1 B-1 闭环） | **PASS** |
| **Task 14**：专家团管理页与结构化编辑器 | §7.1–§7.3, §9 | [ExpertTeamsView.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamsView.tsx)、[ExpertTeamListPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamListPanel.tsx)、[ExpertTeamEditor.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamEditor.tsx)（Plan Review S-8 闭环） | **PASS**（含 M-2） |
| **Task 15**：`@team` 检索、键盘交互与发送 | §11.1–§11.3, R15 | [expertTeamsLogic.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts)、[sessionChannel.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts)、[ComposerMentionMenu.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ComposerMentionMenu.tsx)、[AtAgentMenu.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/AtAgentMenu.tsx)、[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx)（Plan Review B-1 / I-2 / F-8 / R-3 闭环） | **PASS**（含 N-2） |
| **Task 16**：聚合运行卡、右栏进度投影、成员取消与重连对账 | §13.1–§13.3 | [ExpertTeamRunCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx)、[ProgressPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx)、[progressPanel.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts)、[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx)（Plan Review S-9 闭环；存在 **I-1**、**M-3**、**M-4**） | **PASS with I-1** |
| **Task 17**：真实组合与 Loader 专家团场景 | §18.2, §18.4 | [driver.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/fixtures/expert-team/driver.ts)、[expert-team-composition.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-composition.spec.ts)、[huaanwork-expert-team-smoke.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-expert-team-smoke.mjs)（Plan Review B-4 / I-2 / I-3 / S-10 闭环） | **PASS**（含 N-4） |
| **Task 18**：完整门禁与真机验收证据 | §18.4, §19 | [2026-11-22-expert-team-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-22-expert-team-acceptance.md)（自动化 `yarn check` PASS；9 项真机人工验收诚实标记 `BLOCKED — 未执行`） | **PASS（自动化）/ 真机待执行** |

---

## 五、验证记录

| 验证项 | 执行方 | 结果 |
| --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork run typecheck` | 主审独立复跑 | **EXIT=0**（5 个 tsconfig 全过） |
| `corepack yarn workspace @huaanwork/policy run check` | 主审独立复跑 | **EXIT=0**（66 passed / 2 skipped Windows-only） |
| 专家团全量单元/契约/集成套件（Host 14 文件 + Guardrails 7 文件 + Client 11 文件，共 32 个 spec 文件） | 主审独立复跑 | **32 files / 752 tests passed**（0 failed） |
| `git diff --check` & `git status --porcelain` | 主审独立复跑 | **EXIT=0**，无 whitespace 错误，审查期间代码树零修改，无 `deepseek-harness/` 或锁文件改动 |
| 全量 `corepack yarn check`（含 `expert-team-composition.spec.ts` 与 `verify:expert-team`） | 采信验收文档 `eca2ceb5b0` 记录（避免并发触发 `verify:aa`） | **EXIT=0**（Vitest 5551 passed / 15 skipped，`verify:expert-team` list=200 / invocable=200） |

---

## 六、处置建议

1. **合并前 / 真机验收前优先修复（2 项 Important）**：
   - **I-1**：在 [ExpertTeamRunCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx) 中接入 `subagentAlerts(memberRun, now)` 渲染成员清理告警与停止等待提示，并补齐单元测试。
   - **I-2**：在 [orchestration.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts) 中收紧 `execute + supersedesResultId` 的三处边界（保留 `sequential` 后序成员前序引用检查、拒绝替代已被有效结果替代的旧失败结果、`hasUnsupersededExecutionFailure` 统一覆盖 `execute` 与 `revision` 的同目标后续有效替代）。
2. **顺手加固（5 项 Minor）**：
   - **M-1**：[index.ts:396](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/index.ts#L396) `resolveMemberPackage` 改用 `await agentPackageHost.findInvocable(agentRef.slug)`。
   - **M-2**：[store.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts) 与提示词渲染函数将空白可选文本字段（`""`）按缺省处理。
   - **M-3**：[App.tsx:2742](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2742) 共享 1 秒计时器加入 `hasAnyActiveExpertTeamRun`。
   - **M-4**：[ExpertTeamRunCard.tsx:246-256,299-305](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L246-L256) 将 `memberRun?.phase === "stopping"` 纳入 `memberBusy` 并移除成员确认回调中的整团取消 fallback。
   - **M-5**：[observer.ts:231-241](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts#L231-L241) 在 `seq` 异常命中 `activeTurn` 的 `turn/end` 时仍同步触发 `settle`。

---

## 七、第二轮评审（2026-11-23，当前 HEAD `1b21b0291e`；四域并行 + 主审逐条反证）

- **审阅目标：** 分支 `feat/expert-team-impl`，BASE（master）`3ad0a10af73d92bae28568032f5f2757bb557be0` → HEAD `1b21b0291ed80dda50c461080bd433aa3c21c632`（46 提交 / 108 文件 / +23866 −193）。相对第一轮 HEAD `6f8182eb3b` 新增 `0a465ed361`（11 项校准修复）、`d173756a61`（真机证据 + 18 截图）、`1b21b0291e`（三列团队列表样式）。
- **方法：** 四路只读领域评审（A：Host 存储/可用性/路由/注册表/文本协议/编排纯函数；B：协调器/观察器/会话结算/Host 接线；C：包派发隔离/护栏/策略/主 Artifact；D：客户端契约/管理页/`@team`/投影/聚合卡）+ 主审对全部关键断言与第一轮 11 项修复逐条读码反证（去误报、消夸大、查漏报、校事实）。
- **最终判定：** **可以合并（代码面）。0 Critical / 0 Important / 9 Minor（M-6..M-14）/ 6 Nit（N-5..N-10）。** Minor 均不阻塞核心功能与安全不变量；建议 M-6、M-7 顺手修复，其余入下一硬化波。合并前另需处置 §七.6 的流程/文档事项（其中 CI 路线待 owner 拍板）。

### 七.1 门禁复跑（主审独立执行 @ HEAD `1b21b0291e`）

| 命令 | 结果 |
| --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **EXIT=0**（5 个 tsconfig） |
| `corepack yarn workspace dsh-plugin-huaanwork test` | **EXIT=0**；329 files passed / 4 skipped；**4810 passed / 15 skipped** |
| `corepack yarn workspace @huaanwork/policy test` | **EXIT=0** |
| `corepack yarn check:whitespace` | **EXIT=0** |
| `corepack yarn check:layout` | **EXIT=0**（bilingual 51 records / 102 documents；layout 与 upstream `1600d8a1e1` 一致） |
| `corepack yarn workspace dsh-plugin-huaanwork run verify:expert-team` | **EXIT=0**；`tool present, list=200 (0 teams), invocable=200 (0 teams)` |
| `corepack yarn workspace dsh-plugin-huaanwork run verify:loader` | **EXIT=0** |

- 完整 `corepack yarn check`（含 build 与 `verify:aa`）采信证据文档 @ `0a465ed361` 的 EXIT=0 记录（5555 passed / 15 skipped），避免并发 `verify:aa`；`0a465ed361` 之后仅 CSS、`styles.generated.ts` 与新增 `styles-generated.spec.ts` 变更，已由上表 typecheck/vitest/smoke 覆盖。
- smoke 输出 `warning: 2 entries did not activate` 为 [huaanwork-dev-launch.md:58](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/huaanwork-dev-launch.md#L58) 登记的**预期行为**（guardrail 锁定 web/jobs），非缺陷。
- 横切面：`deepseek-harness` pin 与锁文件零改动；普通 `dispatch()` 函数体（HEAD 563–1214 行）无任何 diff hunk 落入；master 未前进（可 fast-forward）；46 提交无 WIP；分支未推送、无 PR ⇒ **CI（Windows/macOS job、gitleaks）零覆盖**。

### 七.2 第一轮 11 项修复闭环复核（全部真闭环，未引入回归）

| 项 | 复核结论与证据 |
| --- | --- |
| I-1 | 闭环。[ExpertTeamRunCard.tsx:267](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L267) 全成员行计算 `memberAlertsOf`；[:430-441](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L430-L441) 仅 frozen/stale 抑制 `inactive`，`cleanupWarnings` 终态仍渲染；Host 侧 [host.ts:1446-1449](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1446-L1449) 与 catch 路径均写 `confirmCleanup` |
| I-2 | 闭环。[orchestration.ts:626-629](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L626-L629) sequential 重试无条件过前序引用；[:630-640](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L630-L640) 拒绝替代已解决失败与跨成员 supersede；[:402-431](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts#L402-L431) 星型/链式共享解析集合。主审以 `r1-fail→r2-fail(sup r1)→r3-ok(sup r1)` 与混合链序列推演无误拦、不误判 partial |
| M-1 | 闭环。[index.ts:397](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/index.ts#L397) `await agentPackageHost.findInvocable`；async 化未引入 TOCTOU（mutate 内全量复查） |
| M-2 | 闭环。[store.ts:68-70](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts#L68-L70) `nonBlankOptional` 归一；update 传 `""` 清空 `scenarios` 有真实磁盘断言；编辑器 [ExpertTeamEditor.tsx:274-314](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamEditor.tsx#L274-L314) 空白省略 |
| M-3 | 闭环。[App.tsx:1168-1171](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1168-L1171) 秒表条件并入 `hasAnyActiveExpertTeamRun`，deps 正确 |
| M-4 | 闭环。[ExpertTeamRunCard.tsx:251-264](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L251-L264) `stopping` 计入 busy 并收起确认；[:308-312](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx#L308-L312) 确认回调仅 member、无整团 fallback |
| M-5 | 闭环。[observer.ts:231-245](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts#L231-L245) `seq` 异常命中 `activeTurn` 的 `turn/end` 仍同步 settle，`finalSummaryPresent:false` fail-closed |
| N-1 | 闭环。[host.ts:1405-1409](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1405-L1409)、[:1431](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1431)、[:1589-1590](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1589-L1590) 挂载在途保留服务名、dispose 后释放，成功/抛错均恰好一次 |
| N-2 | 闭环。[App.tsx:1318-1322](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1318-L1322) 显式 `@team:` 清空普通智能体匹配 |
| N-3 | 闭环。orchestration.spec.ts:720-736、768-783 补齐 unified/per-member 0 轮终态断言 |
| N-4 | 闭环。driver.ts 移除未复用初始定义与 `verdictByMember` 冗余推入（残留死三元另记 M-11） |

### 七.3 校准说明（消夸大 / 去误报）

1. **B 域「协调器 states/leases 无界累积」消夸大：** `pruneTerminalStates()` 在每次 `begin()` 同步执行（[coordinator.ts:542](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts#L542)），且 `pruneState` 对已被 registry 淘汰的运行直接删除，故增长**有界**（≤ registry 终态上限 + 活跃数）。残留真问题仅为 `cancelRun` 缺终态早退（M-7）与结算后 linger 到下次 begin 的卫生项。
2. **C 域「commit 前复检陈旧回落可继续 commit」降级为 Nit（N-9）：** [result-artifact-tools.ts:149](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts#L149) 的 `?? teamRun` 回落即使发生，[:158](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts#L158) 的租约复检在结算同步失效后必然拒绝并 discard，实际 fail-closed；且触发需 prepare 窗口内同父 20 条新终态挤掉旧记录，实践不可达。
3. ** teardown 不误杀父回合：** `runs.cancelAll` → `cancelMatching` 仅处理活跃态（[runs.ts:253](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/runs.ts#L253)），Host dispose 不会对本已终态的运行触发 `performCancel`。
4. **截图内容核查：** 18 张真机截图仅含合成夹具（团队/项目/账户名），无 token、无真实用户路径；但列表截图为**旧单列布局**，三列样式提交后无新真机截图（M-14）。

### 七.4 Minor（M-6..M-14，不阻塞合并）

#### M-6【UI 守卫】logout 是唯一未过脏草稿守卫的侧栏出口（主审已反证）
- **位置：** [App.tsx:4522-4526](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4522-L4526)；守卫本体 [:3463-3468](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3463-L3468)，其余出口 1465/3476/3482/4230 均已过守卫。
- **事实与触发：** 专家团编辑器改字段 → 账号菜单退出登录 → `logout()` 不调 `confirmLeaveExpertTeam()`，`setAuthPhase("logged-out")` 使 AuthGate 替换整树，编辑器静默卸载丢未保存草稿。
- **为什么重要：** 与「所有侧栏出口守卫脏草稿」的既定行为不一致；仅影响主动登出且未保存的草稿，故 Minor。
- **修复方向：** `logout()` 开头 `if (!confirmLeaveExpertTeam()) return;`。

#### M-7【潜在 API 隐患】`coordinator.cancelRun` 对终态运行无早退，可误杀团长当前回合（主审已反证）
- **位置：** [coordinator.ts:841-852](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts#L841-L852)；误杀点 [:527-529](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts#L527-L529)。
- **事实与触发：** 运行正常结算后 state 仍在（linger 到下次 `begin()`），此时若调 `cancelRun(已终态 id)`，`run.status !== 'running'` 只跳过 `requestCancel`，仍执行 `performCancel` → `requestParentTurnCancel(parentSessionId)` 取消该会话**当前**回合（可能是新团队或普通回合）。**当前无生产调用方**（路由与 dispose 均走 `runs.requestCancel`/`runs.cancelAll`），故为潜在隐患而非现网缺陷。
- **修复方向：** `cancelRun` 对非活跃态早退；或结算时 `pruneState`。顺带消除 states/leases linger 卫生项。

#### M-8【可观测性】挂载竞态下清理确认先于 MCP dispose，且 MCP dispose 失败无告警码（主审已反证）
- **位置：** [host.ts:1423-1431](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1423-L1431)、[:1446-1449](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1446-L1449)、[:1577-1591](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L1577-L1591)。
- **事实与触发：** 取消落在 `mountSessionMcp` 在途时，`cleanup` 见 `mcpDispose === undefined` 跳过 MCP dispose 并 `confirmCleanup(ok:true)`；随后 `mountMcp` 的 `cleanupStarted` 分支 dispose 失败被 catch 静默吞。run 显示 stopped 且零 `cleanupWarnings`。告警码集仅 activation/runtime 四类。
- **为什么重要：** §13.3「不虚报已全部清理」的可观测性缺口；无资源泄漏（服务名仍释放、dispose 已尝试），故 Minor。是否应新增 `mcp-dispose-failed` 告警码属规格解释，可交 owner 一并裁定。
- **修复方向：** 清理确认前追踪 mounting promise，或为 MCP dispose 失败补告警码；补一条挂载在途取消的回归测试。

#### M-9【存储边缘】损坏定义不参与 slug 查重（主审已反证）
- **位置：** [store.ts:263](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts#L263)；corrupt 投影 [:166-169](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts#L166-L169) 不含 `team`。
- **事实与触发：** 某团队 JSON 可读但字段非法被判 corrupt 后，`record.team?.slug` 恒 undefined，可新建同 slug 团队，命名空间出现两份同 slug 定义。损坏件本不可调用、只能删除，影响低。
- **修复方向：** 查重时对损坏文件尽力提取 slug，或在 corrupt 投影保留 slug。

#### M-10【状态语义】stopping→failed 极小窗口覆盖取消优先语义（主审已反证）
- **位置：** [session.ts:342-357](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts#L342-L357)。
- **事实与触发：** cancel 先闩 `stopping`、随后 `followup` 抛错的窗口内，`markRunFailedBeforeSend` 允许 `stopping→failed`，终态定格 failed 而非 stopped（§12.4.2 取消优先）。失败封闭、不滞留 running，仅语义/文案偏差。
- **修复方向：** mutate 内仅允许 `running→failed`。

#### M-11【测试保真】driver 死三元全平台强制 win32 profile（主审已反证）
- **位置：** [driver.ts:236](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/fixtures/expert-team/driver.ts#L236) `process.platform === 'darwin' ? 'win32' : 'win32'`。
- **事实：** 所有平台强制 win32 profile 覆盖；经核 fs-sandbox 平台无关、团队断言不假绿，但与 macOS 真机构成不一致且意图不明。
- **修复方向：** 写明常量 + 注释，或按平台分支。

#### M-12【测试覆盖】Task 1 校验边界缺拒绝断言（评审员报告，计划层面覆盖不足）
- **位置：** `dsh-plugin-huaanwork/tests/client-huaanwork/expertTeamsLogic.spec.ts` 全文；实现 [expertTeamsLogic.ts:205-329](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts#L205-L329) 逐项核过正确。
- **事实：** 成员数 1/9、slug 非法/超长、name>40、description>200、可选文本>500、maxParallel=5、maxRevisionRounds=3、枚举非法、非对象、memberId 重复均无拒绝断言。
- **修复方向：** 补边界拒绝断言防回归。

#### M-13【UI 可读性】三列媒体查询按视口而非中栏容器宽度（评审员报告）
- **位置：** `dsh-plugin-huaanwork/src/client-huaanwork/styles.css:3648-3656、3771-3795`。
- **事实：** 宽窗口 + 展开双侧栏时中栏很窄仍固定三列，仅靠 `overflow-wrap:anywhere` 兜底。固定三列是 `styles-generated.spec.ts:47-55` 钉死的有意设计，不判缺陷。
- **修复方向：** 后续改用 container query 改善窄中栏可读性。

#### M-14【证据新鲜度】三列样式提交后无真机截图（主审已反证）
- **位置：** 提交 `1b21b0291e`（CSS + 生成文件 + 新鲜度测试）；真机证据与 18 截图均 @ `0a465ed361`，[02-step1-team-list.png](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/assets/expert-team-2026-11-23/02-step1-team-list.png) 为旧单列布局。
- **事实：** 末位提交为 CSS-only 且有生成文件新鲜度测试，风险低，但证据链未覆盖最终 UI 形态。
- **修复方向：** 合并前补一张三列列表真机截图闭合证据链。

### 七.5 Nit（N-5..N-10）

- **N-5**：[expertTeamsLogic.ts:153-158](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts#L153-L158) 组合态下 Esc/上下箭头仍作用于菜单（在 `isComposing` 检查之前）。与旧行为一致、计划仅要求抑制 Enter/Tab，非回归；可顺手统一。
- **N-6**：`expert-team-orchestration.spec.ts:504-511` 注释声称覆盖「running 未收尾」但只断言空白输出；`expert-team-text-protocol.spec.ts:25-32` 缺小写标记/代码块包裹/多标记行绕过用例（实现为全等比较，行为正确）；[availability.ts:51-56](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/availability.ts#L51-L56) 原因优先级 revoked→broken→disabled 无直接单测。
- **N-7**：[coordinator.ts:429-442](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts#L429-L442) `writeResult` 找不到 result 时仍执行空 update，发布一次无变化 revision；可先判存在再 update。
- **N-8**：`result_present` 执行体未复核 `delivery==='message'`（仅 claim 摘除 + policy 附件兜底，纵深防御可补一行）；`teamMcpServerName` 8 位十六进制后缀理论碰撞率 2⁻³²，冲突已 fail-closed，可接受。
- **N-9**：[result-artifact-tools.ts:149](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts#L149) commit 前复检 `?? teamRun` 陈旧回落（由 C 域 Minor 降级）：租约复检 [:158](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts#L158) 兜底 fail-closed，且触发实践不可达；另复检不含 `hasInFlight` 属规格 §12.4.1 取舍，建议规格侧明示并行派工与提交竞态的结算语义。
- **N-10**：[skills.ts:917-923](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L917-L923) provider 改派 childId 时实际子会话短暂无 `tools.restrict`（schema 层过宽），但 policy 血缘双闸 fail-closed 拒绝执行、无扩权，且与普通 `dispatch()` 完全同构，属既有防御路径平价债务，非团队回归。

### 七.6 流程/文档处置与 owner 裁定记录

1. **计划口径同步（owner 2026-11-23 裁定，已执行）：** [计划:15](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-22-expert-team.md#L15) Review status、Task 18 Step 3 与 Self-Review 末项已按证据文档同步：7 项全勾选，第 3、8 项保留未勾选并注明「1 个不可实时注入子项保留单测边界」，与证据文档 §4 口径一致。
2. **评审稿随分支提交（owner 2026-11-23 裁定，已执行）：** 本文件原为未跟踪稿，被已提交证据文档 §3.1 引用而形成悬空引用；按裁定随分支提交消除悬空引用（仓库有跟踪评审稿先例）。
3. **CI 路线（待 owner 拍板）：** 分支未推送、无 PR，Windows/macOS job 与 gitleaks 零覆盖；本地全绿 ≠ CI 全绿。可选推分支开 PR 拿平台 job，或 `workflow_dispatch` 补一次完整门禁。
4. **既有开放项不变：** macOS 签名凭据、Windows 宿主机制品验收仍开放；`dispatchTeamMember` 约 250 行取消/清理重复为 AGENTS.md 已登记债务，本分支镜像一致。

### 七.7 处置建议

- **合并前（流程）：** 完成 §七.6 第 3 项 CI 路线拍板；可选补 M-14 三列真机截图。
- **顺手修复（最值）：** M-6（logout 守卫）、M-7（`cancelRun` 终态早退）。
- **下一硬化波：** M-8..M-13 与 N-5..N-10；M-8 的告警码语义与 N-9 的规格明示可交 owner 一并裁定。
- **结论：** 代码面 0 Critical / 0 Important，规格 §1–§19 与计划 Task 1–18 对齐、门禁与真机证据齐备、第一轮 11 项真闭环，**可以合并**。
