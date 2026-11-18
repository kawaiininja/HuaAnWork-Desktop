# 复杂任务与子 agent 右侧进度面板（`feat/progress-sidebar`）Code Review

- **日期：** 2026-11-18
- **审阅目标：** 分支 `feat/progress-sidebar`
  - 共同基线：`master`（`3dd3b182bc8c28671d5f712a7ae2da23dab463bd`，已合入 `#29 feat/chat-created-skills`）
  - 分支 `HEAD`：`a7211859834a7c93b1e695f0ee69938f54f07937`（11 个提交，56 个已跟踪文件变更，`9280 insertions(+), 305 deletions(-)`）
  - 上游子模块 `deepseek-harness`：`1600d8a1e140dcde43a1a0941940a0480712c011`（`dsh-v0.2.1-alpha.2-981-g1600d8a1e1`，干净无修改）
- **对照依据：**
  - 规格文档（工作区当前版本，`0c3a793abb67b8812b5c9546b35d723b95589337`）：[2026-11-15-task-progress-sidebar-design.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md)
  - 实施计划（工作区当前版本，`90f401e29e5b39bbce3f4c3063ebcb0ad19a5e60`）：[2026-11-15-progress-sidebar.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-progress-sidebar.md)
  - 实施计划复核记录：[2026-11-15-implementation-plans-review.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-implementation-plans-review.md#L575-L807)
  - 验收证据文档：[2026-11-15-progress-sidebar-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-15-progress-sidebar-acceptance.md)
- **最终判定：** **No（With fixes / 暂未达到直接 Merge to `master` 标准，需先收敛 Important 项并整理工作区提交）** — 0 Critical / 3 Important / 4 Minor。

> [!WARNING]
> **工作区状态声明**：当前工作区存在 5 份未纳入分支 `HEAD`（`a721185983`）的未提交修改——其中 [2026-11-15-task-progress-sidebar-design.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md)、[2026-11-15-progress-sidebar.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-progress-sidebar.md) 与 [2026-11-15-implementation-plans-review.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-implementation-plans-review.md) 包含 `§16–§18` 复核闭环与 `§14.2` CDP 自动化验收修订（已被分支内 `2026-11-15-progress-sidebar-acceptance.md` 引用），而 `2026-11-15-task-result-artifacts-design.md` 与 `2026-11-15-task-result-artifacts.md` 属于独立的任务结果 Artifact 需求。本次审查的代码/门禁检查基于 `HEAD`（`a721185983`）源码并按工作区最新规格/计划口径对照。

---

## 一、Double-Check 与校准说明

完成初审后，按「**去误报、消夸大、查漏报、校事实**」对初审全部条目与全量代码 diff 做了逐条反证与复核，校准如下：

| 类别 | 初审结论 / 复核对象 | 复核事实与源码/运行时依据 | 校准处理 |
| --- | --- | --- | --- |
| **消夸大（降级：Important → Minor #1）** | 原 Important #3：认为 `present-as.ts` 仅查 `parentSessionOf` 会使 legacy 儿童创建期保留 `skill` 工具 | 实查 `@deepseek-ai/dsh-tools/lib/index.js`（`L2784`、`L3005`）确认 `tools.restrict()` 通过 `ScopedLayers.effect` **同步发射 `tools/change`**。因此：默认 `startActivation` 本地链路中，`agents.create`（`dsh-subagent/lib/index.js:1815`）之后 `observer.start`（`L1865`）触发 `subagent/start` 登记 `registerChildSession`，随后 [skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L909) 立即调用 `tools.restrict({ allow })`，触发 [present-as.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts#L210) `restrictAll()` 在子代理执行任何模型 step 前剔除 `skill`；`system-skill` 亦通过 `restrictKind` 收窄到 `EXPLORE_TOOLS`/`TEST_FIX_BASE_TOOLS`（不含 `skill`）。常规主链路不会泄漏 `skill` 给子代理模型步 | 下调为 **Minor #1**（收敛为：`agent/created` 窗口对后续 `tools/change` 的隐式耦合 + [present-as.cordis.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts#L469) 先于 `apply(ctx)` 登记掩盖真实事件次序） |
| **精准定性与补充来源（Important #1）** | 初审指 [ProgressPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx#L65-L96) 缺 §8.1 总进度条及文案，且验收脚本整栏断言 `progressBarCount === 0` | 复核 [2026-11-15-progress-sidebar.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-progress-sidebar.md#L813-L819) 与 [ProgressPanelComponent.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/ProgressPanelComponent.spec.ts#L193-L205)：Task 5 计划文本与组件单测在实现前即已使用`"等待任务步骤"` / `"当前回合还没有任务步骤"` 并漏列总进度条，进而使 CDP 脚本整栏断言（[#L950](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L950)）与规格 §8.1 / §14.2 产生静默互锁 | 维持 **Important #1**（无误报/无夸大），补充说明偏离同时存在于组件、单测、Task 5 计划与 CDP 断言 |
| **拆清动因与精准聚焦（Important #3）** | 原 Important #4：指出 `ToolPanel` DOM `id` 重复及 `SubagentRunSummary` 双端同时弹确认并抢焦点 | 复核确认：当「进度」右栏开启且存在进行中工具面板（[toolPanel.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts#L505) 默认展开）或活跃子代理时，现象 100% 可复现；同时明确这是遵循 §8.3 复用 `confirmingRunId` 时遗漏"确认发起表面（surface）作用域"和 `idPrefix` 所致，修复无需新建第二套状态机 | 保留 **Important #3**（聚焦可复现的双处确认框/焦点抢占与重复 DOM `id` A11y 缺陷） |
| **查漏报排查与 Minor 补入（Minor #4）** | 全量复核未细查的生产/证据文件 | 逐文件核对 `turn-anchors.ts`、`system-skill-leases.ts`、`subagent-cleanup.ts`、`subagent-runs.ts`、`agent-invoke.ts`、`sessions.ts`、`session-view.ts`、`bridge.ts`、`todoProjection.ts`、`toolPanel.ts`、`progressPanel.ts`、`sessionChannel.ts`、`App.tsx`（排队早到 `todo_write`、`automationRunUserItem`、`sawReady`/`sidecarDead` 三态、历史回放）与 `SubagentRunCard.tsx` 后，**未发现新的阻断性生产代码漏报**；仅发现 [2026-11-15-progress-sidebar-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-15-progress-sidebar-acceptance.md#L31) 将 `huaanwork-host-loop.spec.mjs` 错记为 `huaanwork-stub-llm.mjs` | 新增 **Minor #4**（文档记述偏差）；同时确认分支将测试文件命名为 `ProgressPanelComponent.spec.ts`（规避 macOS 大小写不敏感与 `progressPanel.spec.ts` 冲突）属正确工程取舍，不作问题报出 |
| **去误报核验** | `Important #2`、原 `Minor #1`/`#2` | 未提交文档导致 `HEAD` 与分支内证据文档不一致、`rememberSubagentSpawn` 未向 `pendingAgentsBySession` 登记显式 slash 父代理、`dual-entry` `during` 窗止于 `/explore` 均经源码直接证实 | 全部保留（**无误报**） |

---

## 二、架构与实现亮点（Strengths）

1. **Task 1：实例作用域回合锚点与非人消息严格隔离**
   - [turn-anchors.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts#L35-L184) 采用实例级有界 LRU（上限 256，无模块级全局单槽），仅认真实人类开启消息（`source.kind` 为 `""` 或 `"user"`）与 `goal` 续轮（保持原 `clientMessageId` 与 `startedAt`），在 `turnBoundaryOf` 与 [session-view.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts) 中同步过滤 `subagent-settled`、`runtime-context`、`agent-instructions`、`skill-catalog` 等系统消息；`agent/pre-step` 显式 `return next()` 且跨监听器幂等。
   - [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L517-L541) 与 [automations-host.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L391-L397) 统一使用 Host/Client UUID 与自动化 `runId` 作为持久锚点，保留 `at.clientMessageId` 仅作兼容回落，`followup` 失败精确回滚且 `session/disposed` / `releaseSessionRuntime` 同步清表。

2. **Task 2：系统技能双入口租约、Goal 状态保活与 ALS 派发槽隔离**
   - [present-as.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts#L16-L43) 将 `subagent` 移出全局 `ALLOWED_TOOLS`，配合 [profile.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/profile.ts#L1621-L1644) 保持 `tool-subagent` 服务并显式恢复 `skill-filesystem` / `tool-skill`。
   - [system-skill-leases.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/system-skill-leases.ts#L62-L161) 独立维护 `activeGoalSessions`（支持先 `goal/change('active')` 后取租约及轮间保留，并在 `agent/error`、非活跃/退出、会话释放时传 `{ clearGoal: true }` 无条件清理）；[skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L222-L468) 通过 `tools/execute` `AsyncLocalStorage`（`spawnKind`）、按 `execution` 归属的 `PendingSpawnSlot`（含 `token`）以及 `tools/result` 同步清槽，闭合了 `allow` 后取消/`guard` 拒绝导致的兼容槽污染与顺序/并发切换错乱。

3. **Task 3：`system-skill` 权威运行注册与严格清理仲裁**
   - [subagent-cleanup.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/subagent-cleanup.ts#L1-L98) 统一抽取 `disposeActivationWithTimeout`（参数窄化为 `Pick<SubagentActivationHandle, 'dispose'>`）与 `waitResultWithBudget`，由 [agent-invoke.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts#L284-L293) 与 [skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L675-L862) 共用；`system-skill` 运行在首个 `await` 前建档并提前挂接 `attachCancel`，取消后使用不吃 abort 信号的独立 `settleWithin` 观察窗，且在 `dispose` 失败/超时时保持真实告警与 `stopping`。

4. **Task 4–5：实时/历史 Todo 同源对齐、右栏只读投影与技术债清理**
   - 共享策略包 [todo.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/packages/huaanwork-policy/src/todo.ts#L1-L24) 统一 `normalizeTodoEntries`，结合 `session-view.ts` 先解 JSON 字符串 `parseToolArguments` 再归一化与 [todoProjection.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/todoProjection.ts#L40-L51) 的严格 `clientMessageId` + `roundKey` 守卫（彻底移除旧数值 `String(id)` 回退），以及 [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1743-L1750) + [sessionChannel.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts#L447-L462) 对排队 `waiting` 交错分支的早到 `todo_write` 保序重放，完整闭环 `R-12` 并清理 [AGENTS.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/AGENTS.md#L64-L70) / [project-memory-archive.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/project-memory-archive.md#L87-L93)。
   - [progressPanel.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts#L77-L143) 纯选择器结构清晰，无锚运行在活跃期可见、终态严格 fail-closed，三态 `connection` 与当前回合活动过滤准确。

---

## 三、问题清单（Issues）

### Critical（必须修复 / Must Fix）

无。

---

### Important（合入前应当解决 / Should Fix）

#### 1. 规格 §8.1 总进度条与空/等待文案未按规格落地，且 CDP 验收脚本整栏断言 `progressBarCount === 0` 掩盖该缺失
- **位置：**
  - 规格依据：[2026-11-15-task-progress-sidebar-design.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md#L203-L210)、[#L397](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md#L397)
  - 实现与测试：[ProgressPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx#L65-L96)、[ProgressPanelComponent.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/ProgressPanelComponent.spec.ts#L193-L205)、[2026-11-15-progress-sidebar.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-progress-sidebar.md#L813-L819)
  - 验收脚本：[huaanwork-accept-progress-sidebar.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L298)、[#L950](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L950)、[#L1810](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L1810)、[huaanwork-host-progress-sidebar-acceptance.spec.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs#L69)
- **问题描述：**
  1. 规格 §8.1 明确规定：`Y > 0` 时显示总进度条（数值为 `X/Y`）；无 todo 快照时显示 `暂无任务拆解`（不显示 `0%` 进度条）；新用户回合等待首个 todo 时显示 `正在等待任务拆解`。
  2. 实际 [ProgressPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx#L68-L78) 在 `taskPhase === "ready" && totalCount > 0` 时仅渲染文字 `已完成 X/Y`，没有渲染总进度条；等待/空状态文案也写成了 `等待任务步骤…` 与 `当前回合还没有任务步骤`（`ProgressPanelComponent.spec.ts` 同步按后者断言）。
  3. 规格 §14.2 #2 要求检查的是“**任何单步**均不存在百分比文本/进度条”，但脚本 `PANEL_STATE`（`huaanwork-accept-progress-sidebar.mjs:950`）查询的是整块 `.progress-panel`（`panel.querySelectorAll('progress, meter, [role="progressbar"], .progress-bar').length`）并断言 `progressBarCount === 0`。该检查当前恰因缺少 §8.1 总进度条而通过，形成双向失配。
- **修复建议：**
  - 在 `ProgressPanel.tsx` 补全 `model.taskPhase === "ready" && model.totalCount > 0` 时的 `<progress>` / `[role="progressbar"]` 总进度条（`value={model.completedCount}`、`max={model.totalCount}`）并将等待/空文案对齐 `正在等待任务拆解` / `暂无任务拆解`（或经规格修订确认调整 §8.1）；
  - 同步更新 `ProgressPanelComponent.spec.ts`、`huaanwork-accept-progress-sidebar.mjs`（将禁用进度条检查收窄到 `.progress-task-list` / `.progress-task` 单步级别，并核验顶部总进度条仅在 `totalCount > 0` 时出现）及其判据单测后复跑 CDP 验收。

#### 2. 工作区存在 5 份未提交文档变更，分支 `HEAD` 与证据文档引用版本不一致且工作区混入无关需求文档
- **位置（`git status --short`）：**
  - 本需求相关未提交文档：[2026-11-15-task-progress-sidebar-design.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md)、[2026-11-15-progress-sidebar.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-progress-sidebar.md)、[2026-11-15-implementation-plans-review.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-implementation-plans-review.md)
  - 无关需求未提交文档：`docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md`、`docs/superpowers/plans/2026-11-15-task-result-artifacts.md`
- **问题描述：**
  分支 `HEAD`（`a721185983`）已提交 [2026-11-15-progress-sidebar-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-15-progress-sidebar-acceptance.md#L4-L11)，该证据明确引用了 `§16–§18` 与 `§14.2`，但分支里提交的对应规格/计划/评审文档仍停留在修订前版本，最新修订滞留在未跟踪提交的工作区中；同时工作区混入了独立 Artifact 需求的未提交修改。
- **修复建议：**
  将 progress-sidebar 相关的 3 份文档变更（连同本次 Review 结论修订后的文档）整理提交至 `feat/progress-sidebar`，并将两份 `task-result-artifacts*` 改动移出本工作区（另分支保存），保证合入提交树自洽且工作树干净。

#### 3. 主流与右栏双挂载导致 `SubagentRunSummary` 双端同时弹出确认框并抢夺焦点，以及展开 `ToolPanel` 时 DOM `id` 重复
- **位置：**
  - [SubagentRunCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx#L88-L128)
  - [ToolPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ToolPanel.tsx#L29-L63)
  - [ProgressPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx#L105)、[#L127-L135](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx#L127-L135)
  - [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3938)、[#L4222-L4233](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4222-L4233)、[#L5044](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L5044)
- **问题描述：**
  1. **双处确认框与焦点抢占：** 实施侧遵循 §8.3 复用唯一 `confirmingRunId` 状态未建第二套确认状态，但主流 `<SubagentRunCard>` 与右栏 `<ProgressPanel>` 中的 `<SubagentRunSummary>` 均直接以 `confirming={confirmingRunId === run.runId}` 激活。用户打开右栏「进度」并在主聊天流点击「终止」时，主/右两张卡片会**同时**展开「确认终止 / 取消」行内确认区，且后渲染的 `<ProgressPanel>` 内 `useLayoutEffect`（`SubagentRunCard.tsx:88-92`）会执行 `cancelRef.current?.focus()` 把键盘焦点从主流卡片抢走到右栏「取消」按钮，同时挂载两套 `window` `keydown` (`Escape`) 监听。
  2. **重复 HTML `id`：** 同一 `panel.anchorId` 的 `<ToolPanel>` 同时挂载于主流与右栏；而进行中当前回合的面板默认处于展开态（[toolPanel.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts#L505)），导致两个容器内同时出现相同的 `id="tool-panel-body-${anchorId}"`（及展开条目后的 `tool-detail-${anchorId}-${tool.id}`），破坏文档内 `id` 唯一性与 `aria-controls` 语义解析。
- **修复建议：**
  - 为 `ToolPanel` 增加可选 `idPrefix` prop（主流默认或 `"main"`，右栏传 `"progress"`）消除重复 `id`；
  - 保留单一 `confirmingRunId` 状态机，但记录/传递触发确认的表面标识（例如 `confirmingTarget: { runId, surface: "main" | "progress" } | null`，或按来源决定是否激活确认区/接管焦点），确保同一时刻仅触发侧获得确认区焦点与唯一 `Esc` 监听。

---

### Minor（建议改进 / Nice to Have）

1. **（由原 Important #3 校准下调）子代理隐藏 `skill` 依赖后续 `tools/change` 事件，创建期判定与单测顺序未贴合真实运行时：**
   - [present-as.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts#L136-L139) 判断 `hideSkill` 仅查 `parentSessionOf(sessionId)`，而真实 `dsh-subagent` 中 `agents.create`（`agent/created`）早于 `observer.start`（`subagent/start`，[skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L505) 才调 `registerChildSession`），且 `subagent/start` 后未显式 `refreshAgentRestrict`。默认本地路径随后因 `skills.ts:909` / `restrictKind` 调 `tools.restrict()` 发射 `tools/change` 触发 `restrictAll()` 补救；但 [present-as.cordis.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts#L469) 先于 `apply(ctx)` 登记掩盖了该窗口。建议在 `present-as.ts` 同时识别 `sessionIdOfAgentRef(agent.session?.header?.parentSession)`、在 `subagent/start` 登记后补调 `refreshAgentRestrict`，并补一条按真实顺序触发 `agent/created` → `subagent/start` 的测试。

2. **`skills.ts` `invalidateSessionSpawnState` 对仅走显式 `/explore` `/test-fix` 入口的会话跳过 `slotsByParent` 兜底：**
   - [skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L281-L318)、[#L368-L381](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L368-L381) 仅在 `rememberSkill` 中把父代理写入 `pendingAgentsBySession`，未在 `rememberSubagentSpawn` 写入 `slotsByParent` 时同步登记；虽然正常执行已有同步 `tools/result` 按 `execution` 精确清槽，但注记所言的“并行 `runGroup` 异常跳过 `tools/result`”场景下显式 slash 入口会因 `agents === undefined` 早退。建议在 `rememberSubagentSpawn` 向 `slotsByParent` 入队时一并登记 `pendingAgentsBySession`。

3. **`dual-entry` CDP 验收的 `request/header` `during` 窗口止于 `/explore` 回合结束：**
   - [huaanwork-accept-progress-sidebar.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L2086-L2105) 取 `turn = turnFacts(parent, '${MARKER}-EXPLORE')`，使 `phases.during` 截于 `turn.endSeq`，未覆盖紧接其后的 `/test-fix` 回合（尽管 `/test-fix` 已单独检查了 `system-skill` 运行卡与取消，且 `phases.after` 校验了 `/test-fix` 之后的普通回合回收）。建议将 `during` 上界延长至 `/test-fix` 回合 `endSeq`（不存在则退回 `/explore` `endSeq`）。

4. **验收证据文档中的一处脚本文件名笔误：**
   - [2026-11-15-progress-sidebar-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-15-progress-sidebar-acceptance.md#L31) 记录将“<code>huaanwork-stub-llm.mjs</code> 的 `/ls/` 匹配收紧为 `/\bls\b/`”；实际分支中修改的文件是 [huaanwork-host-loop.spec.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-host-loop.spec.mjs#L117)。重跑验收更新证据文档时顺带更正即可。

---

## 四、本次审查已直接核验的检查范围与结果

### 本次会话在本地直接执行/读取日志确认的无头检查
- `git submodule status`：`1600d8a1e140dcde43a1a0941940a0480712c011 deepseek-harness (dsh-v0.2.1-alpha.2-981-g1600d8a1e1)`，未改动。
- `git diff --check master...feat/progress-sidebar`：退出码 `0`（分支已提交范围内无空白/行尾错误）。
- `corepack yarn workspace @huaanwork/policy check`：退出码 `0`（`tests 67`, `pass 65`, `fail 0`, `skipped 2` —— 两条 Windows 路径测试在 macOS 上跳过）。
- `corepack yarn workspace dsh-plugin-huaanwork typecheck`：退出码 `0`（无报错输出）。
- `corepack yarn check`（在当前零源码修改态下完整执行）：退出码 `0`：
  - 根仓门禁（whitespace、`market:check`、`aa` 检查、`verify-bilingual-docs`、`verify-market-dependency-direction`、`verify-layout`、`verify-readme-versions` 等）：全部 `fail 0 / skipped 0`；
  - `dsh-community-market`：`Test Files 13 passed (13)`，`Tests 303 passed (303)`；
  - `dsh-plugin-huaanwork`：Vitest `Test Files 304 passed | 4 skipped (308)`，`Tests 4362 passed | 15 skipped (4377)`（跳过项为 Windows/跨平台及联网 smoke 用例：`tests/windows-console-host.spec.ts`、`tests/host-liveness-win.spec.ts`、`tests/huaanwork-migration-smoke.spec.ts`、`tests/huaanwork-host/market-smoke-live.spec.ts` 及 6 个测试文件内的平台条件跳过）；`verify:host`（含新增 18 条走查判据单测）`53 pass / 0 fail / 0 skipped`；`verify-runtime-closure` `4 pass`；`verify-bundled-runtime` `11 pass`；`verify-profile-boot`、`verify-licenses`、`verify-operation-reliability` 全部通过；
  - `market-server`：`14 passed (14)`，`244 passed (244)`；
  - `update-server`：`5 passed (5)`，`88 passed (88)`；
  - `agent-catalog-server`：`7 passed (7)`，`112 passed (112)`，另四组 `node --test` 分别为 `13` / `35` / `50` / `15 pass`、`0 fail`、`0 skipped`。

### 真机 Electron CDP 走查与证据边界
- 本次只读代码审查**未重新执行**依赖真实外部模型凭证的 [huaanwork-accept-progress-sidebar.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs)；该自动化走查已由实施侧执行并记录在 [2026-11-15-progress-sidebar-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-15-progress-sidebar-acceptance.md)（7/7 通过）。
- 因 **Important #1** 存在，现已落盘的走查第 2 项仅证明“整栏无进度条”，尚未在具备 §8.1 总进度条与 §8.1 空/等待文案的 UI 上完成复跑验证。

---

## 五、Merge 就绪行动清单

1. **修复 Important #1：** 对齐 `ProgressPanel.tsx` 与设计规格 §8.1（`Y > 0` 总进度条、`正在等待任务拆解` / `暂无任务拆解`），同步修改 `ProgressPanelComponent.spec.ts`、`huaanwork-accept-progress-sidebar.mjs`（收窄单步检查范围到 `.progress-task`）与判据单测，随后重跑 CDP 真机走查并更新 `2026-11-15-progress-sidebar-acceptance.md`（顺便更正 Minor #4 脚本名笔误）。
2. **修复 Important #3：** 为 `ToolPanel` 增加 `idPrefix` 避免主/右栏 `id` 重复；为取消二次确认增加触发表面约束，消除双处弹框与右栏抢焦点问题。
3. **顺手收敛 Minor #1–#3：** 补强 `present-as.ts` + `subagent/start` 隐藏 `skill` 的创建期判定与顺序单测、`rememberSubagentSpawn` 登记 `pendingAgentsBySession`，以及 `dual-entry` 的 `during` 区间覆盖 `/test-fix`。
4. **修复 Important #2 并复跑全量门禁：** 清理无关 `task-result-artifacts*` 改动，将本分支更新的规格/计划/评审/修复/Review 文档规范入库，确保工作区干净后执行 `corepack yarn workspace @huaanwork/policy check`、`corepack yarn workspace dsh-plugin-huaanwork typecheck` 与 `corepack yarn check` 全绿，即可合入 `master`。

---

## 六、复核与修复记录（2026-11-18，实施侧）

### 6.1 对本 Review 的反证复核结论

按「去误报、消夸大、查事实」对本 Review 全部 7 项逐条反证：

| 结论 | 复核依据 |
| --- | --- |
| **7 项全部属实，未发现误报或夸大** | Important #1（`ProgressPanel.tsx:65-96` 无总进度条、文案偏离 §8.1，CDP `progressBarCount===0` 整栏断言与缺失互锁）、Important #3（`App.tsx` 单一 `confirmingRunId` 同时驱动 `SubagentRunCard.tsx:5044` 与 `ProgressPanel.tsx:132`，双确认+`useLayoutEffect` 焦点抢占+`ToolPanel.tsx:29/47` 重复 `id`）、Minor #1–#4（上游 `dsh-subagent/lib/index.js` `agents.create` 先于 `observer.start` 证实创建期窗口；`present-as.cordis.spec.ts:469` 先登记后 `apply` 掩盖窗口；`rememberSubagentSpawn` 未登记 `pendingAgentsBySession`；`dual-entry` `during` 止于 `/explore` `endSeq`；证据文档误记 `huaanwork-stub-llm.mjs`，实际仅 `huaanwork-host-loop.spec.mjs` 1 处变更）均经源码逐行证实 |
| **一处引注细微出入（不影响结论）** | Important #1 校准段称"Task 5 计划文本在实现前即已使用『等待任务步骤』/『当前回合还没有任务步骤』"——实测计划 `2026-11-15-progress-sidebar.md` Task 5 Step 4 未含上述字面文案，仅同样漏列 §8.1 总进度条；组件、组件单测与 CDP 断言的偏离本身完全属实 |

### 6.2 修复清单

- **Important #1**：`ProgressPanel.tsx` 补 `taskPhase==="ready" && totalCount>0` 的 `<progress class="progress-total-bar">`（`value=completedCount`/`max=totalCount`）；文案对齐 §8.1（`正在等待任务拆解`/`暂无任务拆解`）；`styles.css` + `gen:styles` 补样式；`ProgressPanelComponent.spec.ts` 同步并补总进度条/单步无进度条断言；CDP `PANEL_STATE` 将进度条计数拆为 `.progress-task-list` 单步域（`taskProgressBarCount`）与 `.progress-section-head` 头部域（`totalProgressBarCount`），`driveNoFabricatedPercentage`/`requireFacts`/判据 fixture 改为「单步 0 + 总进度条与 X/Y 计数互锁核验」。
- **Important #2**：3 份 progress-sidebar 文档修订、本 Review 文档与修复代码入库本分支；2 份 `task-result-artifacts*` 修订移至 `feat/task-result-artifacts` 分支保存。
- **Important #3**：`ToolPanel` 增加可选 `idPrefix`（主流保持既有 id，右栏传 `progress` → `tool-panel-body-progress-*`/`tool-detail-progress-*`）；App 状态改为 `confirmingTarget: { runId, surface: "main" | "progress" } | null`（单一状态机保留），`SubagentRunCard`/`ProgressPanel` 各自只认本表面触发的确认，双弹框、双 Esc 监听与焦点抢占消除；新增右栏「main 表面不弹确认」与 `idPrefix` 双挂载用例。
- **Minor #1**：`present-as.ts` `hideSkill` 同时识别子会话 `header.parentSession`（上游为父会话 id 字符串），`agent/created` 创建期即隐藏 `skill`；`skills.ts` `subagent/start` 登记后补调 `refreshAgentRestrict`；新增按真实顺序（先 `apply` 再 `agent/created`，登记表为空）的创建期窗口单测。
- **Minor #2**：`rememberSubagentSpawn` 向 `slotsByParent` 入队时同步登记 `pendingAgentsBySession`；新增「显式入口会话租约失效后兼容槽必须被清」单测（对未修复实现实测红，防假绿）。
- **Minor #3**：CDP `dual-entry` `during` 上界延长至 `${MARKER}-TESTFIX` 回合 `endSeq`（缺失时回退 `/explore` `endSeq`）。
- **Minor #4**：证据文档文件名笔误更正为 `huaanwork-host-loop.spec.mjs`；`test-port-mapping.ts` 两处 present-as 证据行号同步新增用例后的真实行号（92→103、134→145）。

### 6.3 验证与遗留

- `@huaanwork/policy check`：65 pass / 0 fail / 2 skipped（Windows 路径在 macOS 跳过）；`typecheck` 0 错误；受影响聚焦套件（`test-port-mapping`、`present-as.cordis`、`skills`、`client-huaanwork/*`）904/904 通过；`corepack yarn check` 全量门禁 GATE_EXIT=0（vitest 304 文件/4367 通过、verify:host 53）。
- **真机复跑（2026-11-18 晚，已完成）**：重建含修复产物后在真机 Electron 复跑 `huaanwork-accept-progress-sidebar.mjs` 全量 7 项——首轮 6/7，唯一失败经查为**脚本侧判据选择器 bug**（总进度条按 `.progress-section-head` 后代查询而组件渲染为兄弟节点，修正为直接查询 `.progress-total-bar`）；修正后完整复跑 **exit 0（PASS）7/7**，`no-fabricated-percentage` 新判据实测 39 采样单步进度条 0、总进度条与 X/Y 计数互锁成立，且 `dual-entry`（延长后 during 窗）与 `single-cancel-isolation`（新确认表面作用域）真机通过。证据更新见 [2026-11-15-progress-sidebar-acceptance.md §2.5](../../evidence/2026-11-15-progress-sidebar-acceptance.md)；分支达合入 `master` 标准。
