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

---

## 七、qwen4 审核结论（2026-11-18）

### 7.1 审查版本、范围与判决

- **审核标识：qwen4。**
- **审查分支：** `feat/progress-sidebar`。
- **共同基线：** `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`。
- **审查 HEAD：** `755f6029c901d13acaf024aaa1cb667e3aabb19c`；审查开始及结束时工作区均干净。
- **对照依据：** [设计规格](../specs/2026-11-15-task-progress-sidebar-design.md)与[实施计划](2026-11-15-progress-sidebar.md)，覆盖宿主管控及生命周期、回合锚点、实时/历史投影、客户端进度面板和七项真机走查的判据与证据。
- **判决：暂不建议合并。Critical 0 / Important 6 / Minor 1 类。** Important 包含四项产品行为问题、两项验收工装问题；下文单独标明基线继承关系，不把所有发现都算作本分支新引入。

本节是对上述 HEAD 的补充审核。保留 §6 的修复与验收历史，不撤销其已完成修复的事实；但因本节发现尚未收敛，**不再依据 §6.3 的结尾单独认定当前分支已经满足合并条件**。本节登记的是审查结论与建议，不表示问题已修复。

实现的主要优点仍成立：共享 UUID/runId 锚点、实例级有界 store、复用权威 run registry、`tools/execute` ALS、严格停止仲裁和右栏纯投影方向正确；前次评审的总进度条、确认表面及 DOM ID 问题已有修复。本次问题集中于组合时序与验收异常出口。

### 7.2 Important（合入前应解决）

#### Q4-I1：历史恢复后，新的待办快照被旧快照遮蔽

- **性质：** 本分支历史 todo 投影与既有实时更新组合产生的缺陷。
- **位置：** [App.tsx:4849–4865](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4849)、[progressPanel.ts:122–129](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts#L122)、[todoProjection.ts:23–27](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/todoProjection.ts#L23)。历史多快照入口为 [sessionChannel.ts:239–250](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts#L239)。
- **触发：** 同一用户回合写过至少两份 todo，renderer 刷新或历史加载后恢复为多条快照；Host 仍存活，该回合继续执行或被 `subagent-settled` 唤醒，再发同 UUID、更高 `roundKey` 的 todo。
- **问题：** `upsertTodoItem` 用 `findIndex` 更新当前回合第一条 todo，但右栏与轮次守卫从后往前读取最后一条；读写目标不一致。
- **内存复现：** 历史快照为 `6/in_progress、10/in_progress`，收到 `20/completed` 后成为 `20/completed、10/in_progress`；右栏仍显示旧未完成项，已终结回合叠加为 `interrupted`，轮次门槛仍为 `10`，后续 `roundKey=15` 也被错误接受。
- **影响与规格：** 最新进度不可见，迟到事件防护失效；不满足规格 §6.5.2、§8.1 与 §10.2。不是要求删除历史快照，而是要求实时更新与当前快照选择一致。
- **建议：** 统一当前回合有效快照的更新、读取和轮次门槛对象；补“历史多快照 → 实时 completed → 较旧轮次拒绝”的组合回归。

#### Q4-I2：系统技能兼容槽跨父会话污染显式 `@agent`

- **性质：** 全局兼容槽的消费弱点基线已有，本次显式系统技能租约入口同样会产生该槽，仍未满足本期并发隔离要求；不是权限扩大。
- **位置：** [skills.ts:296–324](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L296)、[skills.ts:364–371](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L364)、[skills.ts:477–519](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L477)。
- **触发：** 不同工作根的会话 A/B 并发；A 的 `/explore` 派发已在预执行阶段写入 `pendingSpawn`，尚未进入 `tools/execute`，例如下游正在等待 `recorder.settled()`；B 此时通过宿主显式派发允许写入的 legacy `@agent`。
- **问题：** B 的启动不在 A 的 `spawnKind` ALS 中，儿童创建时却无条件消费 A 的 `pendingSpawn.kind`；槽虽然记录了 `agent` 与 token，消费点未检查父会话归属。
- **内存复现：** 使用实际 skills/present-as/lease/registry 代码及带真实 legacy/run 符号标记的 activation spec，B 声明 `allow=['read','write']`，实际只剩 `['read']`，写工具 guard 返回 `huaanwork-explore`。A 后续清槽不会撤销 B 已安装的错误限制。
- **影响与规格：** 合法显式 `@agent` 被另一个会话意外降为只读；不满足规格 §13 的显式派发不误伤约束及 §14.1.6 的并发不互相污染要求。
- **测试缺口：** [skills.spec.ts:1790–1827](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts#L1790)验证清理 A 不误清 B 的槽，以及 B 自己消费该槽，未覆盖他会话先创建显式儿童。
- **建议：** 保留兼容槽和 token 清理，但只有父会话归属匹配时才能消费，不匹配也不得清槽；补“A 预执行待决 → B 显式启动 → A 继续”的交错测试，同时验证 B 可写、A 仍按 explore 收窄。

#### Q4-I3：早到的普通工具活动落入上一回合

- **性质：** 基线继承的行为缺口，不计作本分支新引入；与本期当前回合活动投影直接相关。
- **位置：** [App.tsx:1730–1754](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1730)、[App.tsx:4581–4595](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4581)。
- **触发：** 会话已有回合 A，发送 B 后 HTTP 应答尚未返回，Host 已执行 B 并先发出携带 B UUID 的普通 `tool/start`。
- **问题：** 早到缓冲仅覆盖 todo，普通工具立即按最后一个已启动用户回合插入，排在尚带 `notStarted` 的 B 用户消息之前。
- **内存复现：** 条目顺序为 `[user A, tool B, user B]`；应答把 B 标为已启动后，当前右栏 `activity=[]`。
- **影响与规格：** 主流工具归属错误，当前回合右栏漏活动；不满足规格 §8.2、§10.1。
- **建议：** 普通工具开始及其配对结束也按发送 UUID 暂存、保序重放；旧回合活动仍即时处理。补带新 UUID 的普通工具早到组合测试。

#### Q4-I4：延迟的 waiting 应答丢弃已启动回合的结束事件

- **性质：** 基线继承的过滤缺口，不计作本分支新引入；本次补入 todo 重放后，终态仍未一并保留。
- **位置：** [sessionChannel.ts:191–205](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts#L191)，缓冲入口为 [App.tsx:1752–1769](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1752)。
- **触发：** B 因并发名额排队、标签当前不运行；waiting 应答迟到，其前依次收到并缓冲本次 `queue-start`、todo、`session/end`。
- **问题与内存复现：** `takeEarlyPendingEvents` 只返回 `session/queue-start` 和 `tool/start(todo_write)`，删除结束事件。随后启动重放把 B 置为 running，却没有终态将其结算。
- **影响与规格：** 已结束任务仍显示执行中；未完成 todo 不叠加 interrupted，无 todo 时可能一直显示等待任务拆解。不满足规格 §9 与 §10 的等待/终态语义。
- **建议：** 确认本 `queueItemId` 已启动后，保留该启动区间内同会话的终态/goal 事件并按序重放，继续排除启动前旧回合事件；补“queue-start → todo → end → waiting 应答”的回归。

#### Q4-I5：后续 BLOCKED 覆盖已有明确 FAIL

- **性质：** 验收工装结果仲裁缺陷，不据此认定已记录的最终真机运行发生了该分支。
- **位置：** [验收脚本:1697–1703](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L1697)、[验收脚本:2794–2799](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L2794)、[验收脚本:3128–3139](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L3128)。
- **触发：** 前面场景已由 `checkFact` 记录明确失败，脚本继续；后面的 Host 重启场景因无法构造活跃运行等条件抛 `BlockedError`。
- **问题：** 顶层 catch 无条件写 `outcome='BLOCKED'`、退出码 `3`，未检查已有失败。脚本末尾针对模型技能入口的 FAIL 优先处理并未覆盖这个提前抛出的出口。
- **内存复现：** 以实际入口 Promise 链注入上述组合，得到 `priorCheck.ok=false`、`outcome='BLOCKED'`、`exitCode=3`。
- **影响与规格：** 已确认失败被环境阻塞分类掩盖，不满足规格 §14.2 的 FAIL/BLOCKED 区分要求。
- **建议：** 统一最终结果仲裁，已有明确 FAIL 时始终退出 `1`；补“先 FAIL、后 BLOCKED”的负例。

#### Q4-I6：临时凭据目录清理失败仍返回 PASS

- **性质：** 验收工装安全收尾缺陷；不指称最终已记录运行实际留下了凭据目录。
- **位置：** [验收脚本:3102–3114](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L3102)、[验收脚本:3126](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L3126)。
- **触发：** 正常验收先得到 PASS，随后 `shutdown()` 删除含复制模型凭据的临时根时遇到权限或文件系统错误。
- **问题与内存复现：** 实际清理代码捕获删除异常，仅写 `isolatedCleanup='failed: ...'`；已决定的 `outcome='PASS'` 和退出码 `0` 不变。探针以虚拟文件操作注入 EACCES，无实际凭据读写或目录删除。
- **影响与规格：** 必须完成的凭据副本清理没有成功，整体却宣告验收成功；不满足规格 §14.2 总则和计划 Task 5 Step 7 的清理要求。
- **建议：** 清理完成后再决定最终成功状态；删除失败必须非零退出并明确告知需要处理的残留位置。

### 7.3 Minor：Q4-M1，真机判据的身份及归属覆盖不够精确

这是一类验收覆盖缺口，**不等同于生产代码已存在对应错误，也不否认真机确实执行过**。相较子审查的初始分级，本次将下列仅判据不足的项合并校准为 Minor，不逐项升级为产品阻断缺陷：

- [验收脚本:1813–1823](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L1813)以工具名集合判断活动归属，未逐项核对 `clientMessageId/roundKey/callId`；同名工具跨回合或跨轮次混入时可能仍通过。
- [验收脚本:2028–2048](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L2028)、[2115–2136](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L2115)未逐入口锁定实际 skill 调用、run kind 与锚点；整个执行窗口工具名并集也不能替代各入口 schema 的检查。
- [验收脚本:2454–2496](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L2454)、[2630](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L2630)用两条 ledger/两张同名卡推断逐实例唯一，并从已发出的取消请求反推目标；没有先绑定被点击卡片的 runId，计数窗口也早于目标停止和兄弟完成。
- 普通父会话后的显式派发使用包 `@typo-check`，未独立走查 legacy `@agent` 路径；包 lane 摘要的文本存在性检查也未逐项证明仅来自外层儿童。

建议逐入口、逐 runId、逐锚点对账，并在取消场景收尾后统计完整请求窗口。现有 7/7 PASS 应按已观测判据解释，不延伸成所有时序、身份和归属边界均已验证。

### 7.4 反证、归因与验证边界

**已撤回的候选：输出上限结束后系统技能租约残留。** 直接注入 `turn/end(max-tokens)` 可使 active goal 租约保留，但当前产品使用的 [model.ts:632–649](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L632)将有正文的 length 结束映射为 `stop`，无正文映射为 `error/EMPTY_RESPONSE`，可解析工具调用映射为 `tool-calls`；未证明默认产品能产生该候选所需的 `max-tokens` 路径。因此不列入本次问题计数，也不把上游可表达的终因等同于本产品可达缺陷。

**验证方式：** 分面独立审查后，主审对保留的重要问题复核源码、调用链、既有裁定及严重度。Q4-I1–I4 以生产函数/模块和内存夹具重放确认；Q4-I5–I6 提取实际脚本入口及清理代码，在隔离内存中注入异常确认。上述探针没有修改生产源码或测试文件，**不是 Electron 真机或真实模型复现**。

**本轮实际执行的检查：**

| 检查 | 结果 |
| --- | --- |
| 进度侧栏及宿主接线定向 Vitest：17 文件 | 543 passed，exit 0 |
| 包 lane、策略交集、profile 回归：3 文件 | 161 passed，exit 0 |
| 验收判据 `node --test` | 18 passed，exit 0 |
| `corepack yarn workspace @huaanwork/policy check` | 65 passed / 0 failed / 2 skipped，exit 0；两项 Windows 路径用例在 macOS 跳过 |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | 无错误输出，exit 0 |
| `git diff --check master...HEAD` | exit 0 |
| 审查结束 `git status --short --branch` / `git rev-parse HEAD` | 工作区干净，HEAD 仍为 `755f6029c901d13acaf024aaa1cb667e3aabb19c` |

定向命令如下，均未更新快照或生成生产构建：

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run --no-cache --configLoader runner tests/huaanwork-host/turn-anchors.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/session-view.spec.ts tests/huaanwork-host/system-skill-leases.spec.ts tests/huaanwork-host/subagent-runs.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/ProgressPanelComponent.spec.ts tests/client-huaanwork/ToolPanelComponent.spec.ts tests/client-huaanwork/progressPanel.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/subagentRuns.spec.ts tests/client-huaanwork/todoProjection.spec.ts
corepack yarn workspace dsh-plugin-huaanwork vitest run --no-cache --configLoader runner tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/profile.spec.ts
node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs
corepack yarn workspace @huaanwork/policy check
corepack yarn workspace dsh-plugin-huaanwork typecheck
git diff --check master...HEAD
```

**未执行事项：** 本轮没有重跑完整根 `corepack yarn check`、完整 `verify:host` 或真实 Electron CDP；既有真机记录确有运行依据，未发现足以认定其使用旧生产构建的证据。缺少本轮全量复跑不等于历史命令未执行；同样，定向测试通过不能替代本节组合边界的审核结论。

**变更范围：** 审查阶段未修改任何文件；经 owner 后续要求，仅将本节追加到本 code review 文档，未修改代码、规格、计划或证据文档，未提交 git commit。

---

## 八、qwen4 审核结论复核、修复与全量复跑闭环（2026-11-19）

经逐项源码/调用链复核，§7 `qwen4` 所列 6 项 Important（`Q4-I1`–`Q4-I6`）与 1 项合并 Minor（`Q4-M1` 含 4 子项）**全部属实**；同时确认 1 项撤回候选（`max-tokens` 租约残留）在当前 [model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts) 映射下不可达。按 `Q4-I1 → Q4-I2 → Q4-I3/I4 → Q4-I5/I6 → Q4-M1` 优先级完成全部修复、回归单测与全量门禁/真机复跑，结论均为已闭环：

| 编号 | 级别 | 修复摘要与源码锚点 | 回归测试覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| Q4-I1 | Important | [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4877) 的 `upsertTodoItem` 改为反向扫描当前回合最后一条 `kind === "todo"`，与 `lastTodoSnapshot` / `currentSnapshotRoundKey` 一致 | [appWiring.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts) 新增多快照历史恢复后实时 `todo_write` 覆盖回归 | 已修复并验证 |
| Q4-I2 | Important | [skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L278) 为兼容单槽 `pendingSpawn` 增加 `parentSessionId` 校验，并用 `startHostManaged` `AsyncLocalStorage` 包裹 Host 托管 `startActivation` / `runSubagent`，阻断并发普通 `@agent` 误认领 | [skills.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts) 新增并发不同父会话互斥认领回归 | 已修复并验证 |
| Q4-I3 | Important | [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L815) 的 `pendingSendOfSession` 与 `holdEarlyEvent` 增加按 `clientMessageId` 缓冲早到普通 `tool/start` 及通过 [findPendingForToolEnd](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts#L210) 配对缓冲 `tool/end` | [appWiring.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts) 新增 `queue-start` 前早到普通 `tool/start`/`tool/end` 归并回放回归 | 已修复并验证 |
| Q4-I4 | Important | [takeEarlyPendingEvents](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts#L249) 对 `queue-start` 窗内成对 `tool/start`+`tool/end`、以及同会话 `> startIndex` 的 `session/end` 与 `goal/*` 统一保序回放 | [appWiring.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts) 新增早到 `goal/*` 与 `session/end` 不丢事件回归 | 已修复并验证 |
| Q4-I5 | Important | [resolveBlockedOrFailedOutcome](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L391) 在任何前置 check 已失败时强制裁定 `FAIL`（退出码 `1`），禁止后续 `BlockedError` 掩盖既有失败 | [huaanwork-host-progress-sidebar-acceptance.spec.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs) 新增 Q4-I5 正反用例 | 已修复并验证 |
| Q4-I6 | Important | [cleanupIsolatedRoot](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L426) 与 [resolveFinalExitCode](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L460) 将最终退出码延后到 `shutdown()` 清理完成后计算；清理失败立即将 `PASS` 降为 `FAIL`（退出码 `1`）并记录残留路径 | [huaanwork-host-progress-sidebar-acceptance.spec.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs) 新增 Q4-I6 `EACCES` 降级与非零退出用例 | 已修复并验证 |
| Q4-M1 | Minor | 视图层补全只读身份属性（[ToolPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ToolPanel.tsx#L59) `data-call-id`/`data-round-key`、[ProgressPanel.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx#L56) `data-turn-anchor`/`data-run-id`、[SubagentRunCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx#L344) `data-run-id`）；走查脚本增加 `PSB-DUAL-WARM`/`PSB-MID1`/`PSB-MID2`、per-entry `runKind`/`anchorMatched`/`headerHasSubagent`/`skillToolCalled`、`MutationObserver` 采样限制外层工具摘要不得泄漏 lane-only 工具、本地遗留 `@legacy-reviewer` (`kind="legacy"`) 独立路径、以及点击时预绑定 `data-run-id` + 结算后全窗口 `subagent.cancel` 与逐 `runId` 卡唯一 | [huaanwork-host-progress-sidebar-acceptance.spec.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs) 新增 Q4-M1 全字段负例 + 真实 Electron CDP 7/7 通过 | 已修复并验证 |

### 全量复跑验证记录（全部修改完成并重建产物后实际执行）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 桌面包构建 | `corepack yarn workspace dsh-plugin-huaanwork build` | exit `0` |
| 真实 Electron CDP 验收 | `corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-progress-sidebar.mjs --out /tmp/progress-sidebar-accept-qwen4-r2` | exit `0`，`verdict PASS`，7/7 通过，`isolatedCleanup: "removed"` |
| 验收判据单测 | `node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs` | exit `0`，21/21 pass |
| `@huaanwork/policy` 检查 | `corepack yarn workspace @huaanwork/policy check` | exit `0`，65 pass / 2 skipped |
| 桌面包类型检查 | `corepack yarn workspace dsh-plugin-huaanwork typecheck` | exit `0`，无错误输出 |
| 宿主验收门禁 | `corepack yarn workspace dsh-plugin-huaanwork run verify:host` | exit `0`，56/56 pass |
| 桌面包 Vitest 全量单测 | `corepack yarn workspace dsh-plugin-huaanwork test` | exit `0`，304 passed \| 4 skipped (308) 文件，4371 passed \| 15 skipped (4386) 用例 |
| 根全量无头门禁 | `corepack yarn check` | exit `0` |

> 最终结论：`qwen4` 复审所提 `Q4-I1`–`Q4-I6` 与 `Q4-M1` 已全部修复，全量单元测试、类型检查、策略校验、`verify:host`、`corepack yarn check` 及加强版真实 Electron CDP 走查均已实际通过。

---

## 九、合并前终审校准与收口修复（2026-11-19）

在合并 `feat/progress-sidebar` 前对照规格与计划执行了一轮独立终审与反证校准：

- **确认属实并修复**：
  1. **Critical（Git 工作区未提交）**：§8 `qwen4` 修复波全部 14 个文件连同本节收口修复一并提交至 `feat/progress-sidebar`，确保工作区完全干净。
  2. **Important #1（Host 系统技能租约跨普通回合泄漏）**：[sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L524) 在 `systemSkillKind === undefined` 的普通用户回合中显式调用 `releaseSystemSkillLease(ctx, sessionId)`（不传 `clearGoal`），防止 active goal 在 idle 时保留的系统技能租约、`subagent` 附件与 `pendingByAgent` 泄漏进新普通回合；在 [sessions.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts) 补回归用例，并加强受管儿童拒发时 `pending` 未登记的断言。
  3. **Important #2（`goalIntermediate` 窗内延迟 `waiting` 应答漏缓冲终态/`goal/*`）**：新增 [hasBufferedQueueStartForSession](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts#L239) 并在 [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1790) 的 `holdEarlyEvent` 中按 `!pendingQueuedStarted` 保护 `running`-turn 守卫，确保同会话已缓冲未认领 `session/queue-start` 后的 `goal/*` 与 `session/end` 随 `waiting` 应答按序重放；在 [appWiring.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts) 补源码接线与行为回归。
  4. **Important #3（`switch-history-restart` 场景内前置失败在抛 `BlockedError` 时被降格为 `BLOCKED`）**：[huaanwork-accept-progress-sidebar.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L426) 新增 `recordPartialCheckFailureBeforeBlocked`，在 `restartRunId === undefined` / `restartHost` 不可用抛 `BlockedError` 前先将已累计的场景内 `reasons` 落盘为 `ok: false`，确保仲裁输出 `FAIL`（exit `1`）；在 [huaanwork-host-progress-sidebar-acceptance.spec.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs) 补正反回归（共 22 项）。
  5. **低风险 Minor 收口**：
     - [turn-anchors.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts#L92) 与 [session-view.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts#L228) 对缺失 `id`（或空文本）的普通用户消息统一清空旧回合锚点（fail closed），并在 [turn-anchors.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/turn-anchors.spec.ts) / [session-view.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts) 补单测；
     - [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2372) 在离开主视图或右栏切离进度页/折叠时清理失效的 `confirmingTarget`，并将主流待办卡条目 key 改为 `${index}-${todo.content}`；
     - [skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L588) 休眠 `start` 包装对齐 `pkg.parentSessionId === parentFromCall`；
     - [huaanwork-accept-progress-sidebar.mjs](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs#L469) 清理失败时同步将 `BLOCKED` 降为 `FAIL` 并先 `persistFacts()` 再写 `walkthrough.log`；
     - [实施证据文档](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-15-progress-sidebar-acceptance.md#L1) 修正标题日期至 `2026-11-19` 与 §4.1 场景 7 摘录的 `targetRunId`（`5f3a37b8-3655-488f-bebb-17d32b4cc4c8`，与外置备份 `facts.json` 一致）。
- **经二次核实撤回/保留原契约**：
  - 撤回将 `App.tsx:964`（`discardBufferedStopEnds`）后移的建议（经查 `openTurnForTab` 会递增 `epoch`，`appWiring.spec.ts` 显式钉住该顺序，不存在破坏排队回合 `session/end` 的回归）；
  - 保留 `skills.ts:794–797` 在 `dispose` 失败/超时后仍等待 `settleWithin` 的两段超时契约（已由计划 Task 3 Step 4 与 `skills.spec.ts:2281–2288` 钉住）。
- **验证边界声明**：本节收口修复最初以无头自动化全量门禁验证；随后的 §10 复核修复与最终提交已补跑完整真实 Electron CDP 7/7 走查并全量通过（见 §10 与实施证据 §2.7/§4）。

---

## 十、Grok 复核修复与最终提交真机 CDP 7/7 闭环（2026-11-19）

针对 §9 提交后的 Grok 复核意见（1 Important + 2 Minor）逐项核实源码与上游 `agent-loop` 同步执行顺序后全部闭环：

1. **Important（`sessions.ts:523–545` `followup` 抛错未恢复既有 active goal 系统技能租约 — 属实并修复于 `4f1052cebc`）**：
   - 因上游 `agent.followup()` 同步进入 `wakeDriver() → kick() → turn() → preStep() → systemPrompt.assemble()` 采集 Step 1 工具列表，普通回合仍必须在 `agent.followup()` **之前**释放旧租约；
   - 在 `try` 前快照 `previousLeaseKind = systemSkillLeaseKindOf(ctx, sessionId)`，若 `agent.followup()` 抛错则在 `catch` 中按 `previousLeaseKind` 调用 `acquireExplicitSystemSkillLease` 精确挂回原租约与 `subagent` 附件（否则仅释放本次新建的显式租约），同时覆盖普通回合与显式技能切换两种抛错回滚，并在 [sessions.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts) 补齐两条回归用例。
2. **Minor #1（`session-view.ts:228` 带 `data.id` 的空文本普通用户消息未清锚 — 属实并修复于 `4f1052cebc`）**：
   - 改为 `if (goalRound === undefined) currentOrdinaryUserClientId = messageText ? persistedId : undefined`，消除无对应 `user` 记录的孤儿 `clientMessageId`，并在 [session-view.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts) 为空文本用例补上 `id: 'm-empty'`。
3. **Minor #2（证据文档基线 commit 说明 + 最终提交补跑真机 CDP — 闭环于 `a3a125a893` + `a02bad496e`）**：
   - 补跑真机 CDP 期间同步定位并修复 3 处走查脚本侧判据缺陷（非产品缺陷），均已补判据单测（`24/24 pass`）：`turnFacts` 继承 `user/message` 前紧邻的 `step/start` `roundKey`（`a3a125a893`）；`todoCardTurns` 按真实用户回合计数避免把 `subagent-settled` 内部唤醒算作额外待办卡；`driveDualEntrySystemSkills` 重试保留入口前缀与唯一 marker（`a02bad496e`）。
   - 在干净提交 `a02bad496edf7b74e53fd510cd83332c28167d8f`（产品源码 `4f1052cebc`）上重建 `dsh-plugin-huaanwork` 并完整实跑真实 Electron CDP 走查：**exit `0`（`verdict PASS`，7/7 全通过，`errors: []`，`isolatedCleanup: "removed"`）**，外置备份于 `~/huaanwork-progress-sidebar-accept-evidence-2026-11-19-premerge/`，证据文档 §2.6/§2.7/§4/§4.1/§6 已同步更新。
