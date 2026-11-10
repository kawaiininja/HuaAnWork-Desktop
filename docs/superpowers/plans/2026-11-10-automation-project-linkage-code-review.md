# 《自动化任务、项目与运行子任务联动》实现代码评审与 double-check

- **评审对象**：`feat/automation-project-linkage` 分支相对 `master` 的完整实现
  - 基线 `9c70989d53`（= master tip）→ 头部 `441ea653a3`，14 提交，35 文件，+2846/-752
  - 区间内 plugin 外仅两份文档：`docs/evidence/2026-11-09-automation-project-linkage.md` 与 `docs/superpowers/specs/2026-11-09-automation-project-linkage-design-review.md`；`deepseek-harness/` 子模组零修改（`git diff -- deepseek-harness` 为空）
- **对照基准**：
  - 设计规格：[`2026-11-09-automation-project-linkage-design.md`](../specs/2026-11-09-automation-project-linkage-design.md)（§2 裁定、§3 不变量、§7.2 单一路径、§8 跳转、§9 可重试删除）
  - 实施计划：[`2026-11-09-automation-project-linkage.md`](./2026-11-09-automation-project-linkage.md)（Global Constraints、Tasks 1–9）
  - 设计评审：[`2026-11-09-automation-project-linkage-design-review.md`](../specs/2026-11-09-automation-project-linkage-design-review.md)（T1–T4/N1/N2/M1–M4 裁定）
  - 验收证据：[`docs/evidence/2026-11-09-automation-project-linkage.md`](../../evidence/2026-11-09-automation-project-linkage.md)
- **评审日期**：2026-11-10
- **评审方式**：两轮。第一轮由独立评审子代理分四 pass 完成（宿主 / 客户端 / 测试与证据 / 实跑验证），产出 0 Critical / 1 Important / 4 Minor；第二轮为主会话对第一轮全部 5 项发现逐条独立反证（本文），并做漏报扫描。两轮均只读，未改任何产品代码/测试。其后由 GLM 做第三轮独立反证（§F），亦只读。行号为 2026-11-10 实测读数，引用以「符号 + 行号」双引。
- **最新总结论（double-check 校准后）**：**With fixes。0 Critical / 1 Important / 3 Minor；第一轮 Minor #5 经反证前提不可达，降级为「无需动作」。** 唯一 Important（运行跳转标签漏关）成立且维持，建议在合并前修复或经 owner 裁定登记；其余 Minor 为窄窗口残余与健壮性小项，不挡合并。
- **GLM 审核结论（2026-11-10 第三轮复核，见 §F）**：double-check 全部结论经独立反证站得住脚——4 项保留发现无一误报、#5 降级判定本身正确、最终版无夸大残留；净计数 0 Critical / 1 Important / 3 Minor 无异议，处置建议维持 §E。
- **修复记录（2026-11-10 主会话执行，见 §G）**：#1/#4 已按 TDD 修复（RED→GREEN；验证：root `corepack yarn check` **exit 0**、真机走查 A/B **PASS**，见 §G.4/§G.5）；#2/#3 登记残余不改码；#5 无需动作；规格 §7.2 口径已统一。
- **后续产品裁定（2026-11-10，见 §G.6）**：自动化运行对话不再在侧栏「任务」区渲染（owner 裁定「完全不显示」）；运行标签、stamp 与失效对账逻辑不变。

---

## A. double-check 方法

对第一轮 5 项发现，逐条执行：① 重读被引代码确认证据链；② 主动寻找反证（是否误读行号、是否既有代码而非本分支引入、是否规格已裁定的降级、触发前提是否可达）；③ 校准严重度。另对高风险面做独立漏报抽查（§C）。凡推翻或收窄第一轮结论的，在 §B 逐条给出反证证据。

## B. 逐项 double-check 结论

### B.1 Important #1｜运行跳转标签漏关 —— **成立，维持 Important；后果机制订正**

- **第一轮结论**：`selectSubtask` 建的 work 标签不带 automationId，delete-automation/prune 后的失效对账只认 automationId 标签，故漏关；「发送即出错」。
- **反证核验（成立）**：
  - 重启重建只取每自动化**最新一条**有效运行：`runTabsToRebuild` 的 `const latest = candidates[0]`（[runTabsLogic.ts:70](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/runTabsLogic.ts#L70)）。更早的运行记录点击走 `onOpenRunTask → selectSubtask`（[App.tsx:3627](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3627)）。
  - `selectSubtask` 有会话分支建的标签只写 `taskId/sessionId/projectId`，**不写 automationId**（[App.tsx:1228-1242](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1228-L1242)）；automationId 仅在恢复失败分支被读取（:1248）。
  - 失效对账判据 `tab.automationId && tab.taskId && !alive.has(tab.taskId)`（[automationRunLink.ts:52](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/automationRunLink.ts#L52)）→ 缺 automationId 的 work 标签被漏过。
  - 关闭路径不对称：deleteRun 经 `handleRunDeleted → closeRunTabsForSession` 按 sessionId 关（[App.tsx:1450](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1450)、[chatTabs.ts:23](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/chatTabs.ts#L23)），覆盖 work 标签；delete-automation/prune 只走 `onChanged → refreshTasks`（[App.tsx:3621-3626](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3621-L3626)）再触发 automationId 对账，不覆盖。
  - 规格依据真实存在：§8 第 8 条「按 taskId 或 sessionId 关闭所有受影响标签，不只关闭 automationId 标签」（design.md:181）；§7.2 措辞较窄（「关闭…自动化标签」，design.md:166）。两处张力属实，实现跟了窄的一条。测试 `automationRunLink.spec.ts:98-107` 把「work 标签带 taskId 也不关」钉成预期。
- **后果机制订正（比第一轮更收敛，无数据丢失）**：漏关标签发送时并非「向已删会话写消息」。实测链路：标签有 taskId 而权威快照已无该 task → `needsSubtaskOnSend` 的 `tab.taskId != null && !boundTaskSessionId` 命中（[subtaskLogic.ts:33](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/subtaskLogic.ts#L33)）→ `ensureSubtaskSession` 复用旧 taskId 调 `bindTaskSession`（[App.tsx:2692-2694](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2692-L2694)）→ 宿主抛 `task … was not found`（[stores.ts:274](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/stores.ts#L274)）→ send 捕获后 noteActive + return，**消息留在输入框、未发送、不写已删会话**。故后果是「残留指向已删 task/session 的幽灵标签 + 发送被 task-not-found 拒绝」，不是数据损坏。
- **校准**：Important 适当（规格 §8.8 字面覆盖缺口，用户可见幽灵标签）。无 Critical 资格（无数据丢失、发送有守卫兜底）。
- **修法**：推荐①——`selectSubtask` 对 `task.automationId` 存在的标签补 stamp `automationId`（使其参与对账）。**副作用提示**：stamp 后该标签会被 `runTabs = chatTabs.filter(tab => tab.automationId)`（[App.tsx:3353](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3353)）归入自动化通道分区，语义上自洽（它本就是运行会话），但需同步放宽 `automationRunLink.spec.ts:98-107` 的钉子。备选②（对账按 taskId/sessionId 关）牵连普通任务标签语义，面更大。若 owner 裁定接受，则至少统一规格 §7.2/§8.8 措辞并登记。

### B.2 Minor #2｜准入与「删除已完成」之间的 check-then-act 孤儿 Task —— **成立，维持 Minor；后果补全**

- **反证核验（成立）**：手动准入 `findAutomation`（await）→ `automationAdmissionRoot`（await）→ 同步段 `assertAutomationNotDeleting + admitAutomation`（[routes.ts:1405-1420](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1405-L1420)）；调度准入同形（[automation-scheduler.ts:183-199](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts#L183-L199)）。guard 只挡「删除进行中」；若删除在两个 await 间**完成**（guard 释放），assert 放行，执行体拿旧快照继续。
  - `markAutomation` 对已删自动化静默 no-op（`if (!automation) return`，[automations-store.ts:529](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts#L529)）。
  - 删除自动化保留项目（spec §9.3），故 `executeRun` 的 `project` 仍命中 → `createAutomationRunTask` 建绑定已删 automationId 的孤儿 Task（[automations-host.ts:733-742](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L733-L742)）→ `runAgentTurn` 执行模型。
- **后果补全（第一轮仅提孤儿 Task）**：`finishAutomation → appendRun` 会写 `runsPath(automationId)`，**重建已删的 runs 文件**（与 B.3 同形），故后果 = 孤儿 Task + 孤儿 runs 文件 + 一次模型执行。仍无注册项污染（markAutomation no-op）。
- **「既有形状」声称核验属实**：base `9c70989d53` 的 `removeAutomation` 注册项先删（`git show` 确认 :368-369 splice+write 先于 rm runs/sessions），且无 deleting guard，窗口更宽。本分支新增 guard 收窄了「删除进行中」段，但 findAutomation-在-guard-之前的 check-then-act 仍在；孤儿 Task 是本分支新后果（createAutomationRunTask 新增）。
- **校准**：Minor 适当。触发需删除级联恰好完成于 `automationAdmissionRoot` 的一次 await 内，窗口窄；与已登记 T2 同族但非同一窗口。建议登记残余，或准入后复检注册项存在性。

### B.3 Minor #3｜恢复与删除并发孤儿 runs 文件 —— **成立，维持 Minor**

- **反证核验（成立）**：`recoverInterruptedAutomation` 的 `appendRun` 只取 `withAppendRunLock`（每自动化运行记录锁），**不取注册表锁、不查 deleting guard、不查注册项存在**（[automations-store.ts:561-572](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts#L561-L572)、[automation-scheduler.ts:264-270](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts#L264-L270)）。`removeAutomation` 的 `rm(runsPath)`（:417）先于注册项删除（:420），整个级联持注册表锁但 appendRun 不进该锁 → 恢复的 appendRun 可在 rm 之后 `mkdir + writeFile` 重建 `<id>.runs.jsonl`。
- **校准**：Minor 适当。仅磁盘残留（注册项已删，`listAutomations` 不枚举，不影响 list/运行）；触发需首 tick 恢复窗口内用户删除同一 running 残留自动化。建议恢复前查 guard/注册项存在，或登记接受。

### B.4 Minor #4｜withValidTaskOrigin 校验用 trim、保留原值 —— **成立，维持 Minor；影响面收窄**

- **反证核验（成立）**：`if (automationId && runId) return task` 用 trim 值判定却返回未 trim 的原任务（[stores.ts:210-217](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/stores.ts#L210-L217)）；带空白来源字段会通过校验但漏掉 `removeTasksOfAutomation`/幂等查找的精确匹配。
- **影响面收窄（反证补强）**：生产写入**恒 trim**——`createAutomationRunTask` 对五字段全部 trim（[stores.ts:306-310](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/stores.ts#L306-L310)）；`task.create` 路由只接受 projectId/name，**不接受 automationId/runId**（[routes.ts:1473-1484](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1473-L1484)）。故带空白来源字段只能来自外部手写/损坏的 tasks.json，生产路径不可达。
- **校准**：Minor 适当，影响面极小。建议保留时一并归一为 trim 值（防御外部异常数据）。

### B.5 Minor #5｜新关闭路径可关空 chatTabs —— **夸大（前提不可达），降级为「无需动作」**

- **第一轮结论**：失效对账（App.tsx:2148）与回填失败（:2281）直接 `setChatTabs(result.tabs)` 无非空兜底，「若所有标签都是被 prune 的运行标签，可能关空」。
- **反证（推翻「关空」前提）**：chatTabs 初始化恒含种子标签 `work-1`（[App.tsx:518-519](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L518-L519)），且 work-1 **永不被自动化关闭路径命中**：
  - 失效对账经 `staleAutomationRunTabs` 要求 `automationId && taskId`；work-1 两者皆无 → 不关。
  - `closeRunTabsForSession` 按 sessionId 精确匹配；work-1 懒绑定的是中立工作区稳定会话（`sessionIdFor(root)`，非 `huaanwork-auto-` 前缀），与任何自动化运行会话不相等 → handleRunDeleted/回填失败都不关 work-1。
  - 唯一 filter 型删除 `removeSubtask` 自带种子兜底 `filtered.length > 0 ? filtered : [seed]`（[App.tsx:1334-1337](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1334-L1337)）。
  - 故「所有标签都是运行标签」的状态**不可达**——work-1 恒在且非运行标签，chatTabs 恒非空。
- **校准**：第一轮「沿用既有形状」的观察属实（新调用点确无显式兜底），但「可能关空」的后果不可达，属夸大。降级为**无需动作**；若求防御一致性可统一补兜底，但非缺陷、不挡合并。

## C. 漏报扫描（double-check 新增抽查）

对第一轮未单列的高风险面独立核验，均成立、无新增 Critical/Important：

| 面 | 结论 | 证据 |
| --- | --- | --- |
| refreshTasks 单调序号（T3） | 成立：`seq !== taskRequestSeq.current` 丢弃过期应答；失败保留旧数据且不置 tasksLoaded | [App.tsx:1141-1151](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1141-L1151) |
| 崩溃点 gate | 成立：`acceptanceHooksEnabled(env) && env[CRASH_POINT] === point`，主开关须恰为 `1`，生产惰性；谓词自身不 exit | [acceptance-hooks.ts:66-81](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/acceptance-hooks.ts#L66-L81) |
| 项目级 guard（T1） | 成立：先 `beginProjectDeletion` 再读 doomed；三个同步消费点 assert；finally 逆序释放 | [routes.ts:1196-1219](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1196-L1219)、[:1483](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1483) |
| 锁序 | 成立：removeAutomation 持注册表锁内嵌 task 锁（合法方向），无反向调用 appendRun/markAutomation | [automations-store.ts:393-422](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts#L393-L422) |
| prune keep 集（N2） | 成立：activeSessionIds ∪ 每自动化最近 20 条 Run.sessionId；N2 边界已登记 | [automations-store.ts:602-611](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts#L602-L611) |
| M2 失败路径摘 inFlight | 成立：appendRun 软失败也在 finally 摘条目 | [automations-host.ts:627-631](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L627-L631) |
| 契约镜像一致 | 成立：rpc-types 与 logic/projects 的 activeRunId/taskId/automationId/runId 逐一对齐 | [rpc-types.ts:288,313,330-331](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts#L288)、[logic/projects.ts:37,52,72-73](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts#L37) |
| TurnScheduler 只读快照 | 成立：activeSessionIds/activeAutomationIds 纯读 rootWriters/starting/queue，不改互斥原语 | [turn-scheduler.ts:224-238](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts#L224-L238) |
| 看板退役零死引用 | 成立：src 内 `BoardView`/`automation/widget`/`run-output` grep 零命中 | grep 实测 |

## D. 校准汇总

| 项 | 第一轮 | double-check verdict | 净结论 |
| --- | --- | --- | --- |
| #1 运行跳转标签漏关 | Important | **成立**；后果机制订正为 bindTaskSession task-not-found（消息不丢） | Important，合并前处置 |
| #2 准入 check-then-act 孤儿 Task | Minor | **成立**；补全孤儿 runs 文件后果；「既有形状」属实 | Minor，登记残余 |
| #3 恢复×删除孤儿 runs 文件 | Minor | **成立** | Minor，登记残余 |
| #4 trim 校验保留原值 | Minor | **成立**；影响面收窄至外部异常数据 | Minor，可选修 |
| #5 关空 chatTabs | Minor | **夸大**：work-1 恒在且不被命中，前提不可达 | 降级，无需动作 |

净计数：**0 Critical / 1 Important / 3 Minor**（+#5 降级）。无误报 Critical/Important；唯一显著校准是 #5 由 Minor 降为无需动作，#1 后果描述订正（不改变严重度）。

## E. 判决与建议

**可以合并吗？With fixes。**

- **合并前**：处置 Important #1——推荐修法①（selectSubtask 补 stamp automationId + 放宽对应钉子），或经 owner 明确裁定接受并登记；无论哪种，统一规格 §7.2 与 §8.8 关于「关闭哪些标签」的措辞。
- **可登记后续**：Minor #2/#3（窄窗口残余，与已登记 T2 同族）、#4（防御外部异常数据）。#5 无需动作。
- **验证边界（诚实声明）**：第一轮实跑 13 个改动测试文件 402 用例全绿 + workspace typecheck exit 0；double-check 为只读反证，未重跑门禁。证据文档声称的完整 `corepack yarn check` exit 0 未由本评审复验；T1 实机时序在证据中已标 BLOCKED（以路由测试为证），截图不可独立复核——均如实保留，不冒充真机通过。

**理由**：实现完整覆盖计划 9 个 Task 与规格四项行为，权威键/零迁移/锁序/锚点重试/崩溃点 gate/实施边界经两轮核实成立；唯一 Important 是规格 §8.8 的标签关闭覆盖缺口（无数据丢失、发送有守卫），修复或裁定后即可合并。

---

## F. GLM 审核结论（2026-11-10 第三轮复核）

- 复核人：GLM（独立于第一轮评审子代理与第二轮主会话 double-check）
- 对象：本文 §B–§E 全部结论及其引用的代码证据链；复核基线 = 分支现状 `441ea653a3`（相对 `9c70989d53`）
- 方法：对 §B 五项发现逐条独立反证（重读被引代码 + 主动找反证，包括 double-check 未做的验证点）；§C 漏报扫描抽查 8/9 行；评审口径经 `git diff --stat` / `git show` / `rev-list --count` 核实
- 修订记录：仅新增本节与头部指针行（含评审方式行补句），未改动 §A–§E 任何原文；行号为 2026-11-10 GLM 读数

### F.1 总判定

**double-check 的全部结论站得住脚：4 项保留发现无一误报；#5 的「夸大降级」判定本身正确；最终版无夸大残留。** 净计数 0 Critical / 1 Important / 3 Minor 经独立复核后无异议；§E 的处置建议（合并前处置 Important #1 或经 owner 裁定登记；#2/#3/#4 登记残余；#5 无需动作）维持。GLM 复核未发现需要升级或降级任何一项的新证据。

### F.2 逐项复核（与 §D 对照）

| 项 | double-check 结论 | GLM 独立复核 |
| --- | --- | --- |
| #1 运行跳转标签漏关 | 成立，Important | **成立，证据链每环实测吻合**：`runTabsLogic.ts:70` 只取每自动化最新一条；`selectSubtask` 会话分支（App.tsx:1228-1242）不写 automationId、:1248 仅恢复失败分支读取；stale 判据（automationRunLink.ts:52）要求 `automationId && taskId` 双字段；AutomationsView 删除自动化（:221-223）与 prune（:651-660）只走 onChanged，deleteRun（:634）才走 onRunDeleted 按 session 关；design.md:181（§8 第 8 条「不只关闭 automationId 标签」）与 :166（§7.2 窄措辞）张力属实，实现跟了窄的一条；automationRunLink.spec.ts:98-107 确把窄行为钉成预期 |
| #2 准入 check-then-act | 成立，Minor | 成立。两条准入路径（routes.ts:1405-1420 / automation-scheduler.ts:183-199）确为「两个 await 后才同步 assert+admit」；markAutomation 对已删项 no-op（automations-store.ts:528-529）；执行体不复查注册表；孤儿 runs 文件后果（appendRun 的 mkdir+writeFile）属实。「既有形状」经 `git show 9c70989d53` 亲自核实：基线注册项先删、rm 错误全吞、无 guard——窗口比现在更宽 |
| #3 恢复×删除孤儿 runs | 成立，Minor | 成立。appendRun 只走 per-automation promise 链（automations-store.ts:561-572），不进注册表锁、不查 guard/存在性；rm runs（:417）先于注册项删除（:420）。「仅磁盘残留」校准准确：prune keep 集只枚举在册自动化的 runs，孤儿文件不被任何路径消费 |
| #4 trim 保留原值 | 成立，影响面收窄 | 成立且收窄准确。withValidTaskOrigin（stores.ts:210-217）trim 判定返回原值属实；createAutomationRunTask 五字段恒 trim（:306-310）；task.create 只收 projectId/name（routes.ts:1473-1484）——带空白来源字段只能来自外部手写/损坏数据 |
| #5 关空 chatTabs | 夸大，降级无需动作 | **降级判定正确**。work-1 种子恒在（App.tsx:518-519）；stale 判据要求双字段，work-1 皆无；closeRunTabsForSession 精确匹配 sessionId（chatTabs.ts:23），work-1 稳定会话是 root 派生 id（`huaanwork-<digest>` 形状），与 `huaanwork-auto-` 前缀运行会话结构性不可能相等；removeSubtask 另有种子兜底（App.tsx:1334-1337）。「关空」前提确实不可达 |

### F.3 GLM 补充验证（double-check 未做的关键细节）

1. **#1 后果订正（消息不丢）亲自复核**：`setDraft("")` 在 App.tsx:2780，而 ensureSubtaskSession 失败的 catch 在 :2729-2731 提前 return——draft 确实不清空、消息留在输入框；宿主 stores.ts:274 确抛 `task … was not found`。B.1 对第一轮后果的收敛订正比原文更准确，不是避重就轻。
2. **#1 修法①副作用预警属实**：App.tsx:3353 `runTabs = chatTabs.filter((tab) => tab.automationId)` 确在，stamp automationId 后该标签会归入自动化通道分区，连带放宽 automationRunLink.spec.ts:98-107 钉子的提示成立。
3. **#2 基线对照**：`git show 9c70989d53:…/automations-store.ts` 确认基线 removeAutomation 注册项先删（:368-369 splice+write）、rm 全部 `.catch(() => undefined)` 吞错、无 deleting guard——「窗口更宽」的历史对照准确。
4. **#5 会话 id 形状论证**：`sessionIdFor` 为宿主侧函数（huaanwork-host/session-id.ts:5），work-1 经 `session.new fresh:false`（App.tsx:2511）间接触达同一 root 派生 id；自动化运行会话恒为 `huaanwork-auto-` 前缀——两类 id 结构性不相等，closeRunTabsForSession 永不误关 work-1。

### F.4 §C 漏报扫描抽查

8/9 行经独立核实吻合：refreshTasks 序号（App.tsx:1141-1151）、崩溃点 gate（acceptance-hooks.ts:66-81，主开关须恰为 `'1'`）、项目级 guard（routes.ts:1196-1219，先 guard 后读 doomed、finally 逆序释放）、锁序（注册表锁外层 + 内嵌 task 锁，无反向调用）、prune keep 集（retain limit=20，automations-store.ts:47）、M2 finally 摘条目（automations-host.ts:627-631）、TurnScheduler 只读快照（turn-scheduler.ts:224-238）、BoardView/widget/run-output 零死引用（grep 零命中）。「契约镜像」行仅抽查字段在双侧存在，未逐字段全对。

### F.5 微瑕（不改变任何结论）

1. B.1 引 App.tsx:2281 处实际 `setChatTabs` 在 :2282（1 行漂移）。
2. B.5 的「sessionIdFor(root)」是宿主侧函数名，客户端经 `session.new fresh:false` 间接触达——实质判断正确，仅表述略跳步（见 F.3 第 4 条）。

### F.6 评审口径核验

`git diff --stat 9c70989d53..441ea653a3` = 35 文件 +2846/-752、`rev-list --count` = 14 提交、`git diff -- deepseek-harness` 零输出——与本文头部口径逐项一致。

### F.7 净结论

**维持 §E 判决：With fixes。** 合并前处置 Important #1——推荐修法①（`selectSubtask` 对 `task.automationId` 存在的标签补 stamp automationId + 放宽 automationRunLink.spec.ts:98-107 钉子，注意 F.3 第 2 条的分区副作用），或经 owner 明确裁定接受并统一 spec §7.2 与 §8.8 措辞；#2/#3/#4 登记为后续残余；#5 无需动作。

---

## G. 修复记录（2026-11-10 主会话执行）

- 处置裁定：修 **#1**（挡合并项，修法①）与 **#4**（一行防御归一）；**#2/#3 登记残余、不改码**；**#5 无需动作**。两项修复均按 TDD（先写失败测试、确认预期失败、再最小修复）。本节不改 §A–§F 原文；F.5 两个微瑕已知悉（行号漂移与表述跳步均不影响结论）。
- 修法①落地后**无需放宽** automationRunLink.spec.ts:98-107 钉子：该钉子的 work-1 无 automationId，代表普通任务标签，语义仍正确；纯函数判据未变，变的是 App 接线。§E/F.7 的「放宽钉子」提示对应的是改判据的备选②，本轮未采用。

### G.1 #1 修复（Important）

- **生产改动**：`selectSubtask` 有会话分支条件展开 `...(task.automationId ? { automationId: task.automationId } : {})`（[App.tsx:1238-1240](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1238-L1240)，含 2 行 WHY 注释）。空会话预铸分支与恢复失败分支不 stamp（自动化 Task 恒有会话；恢复失败不建标签）。
- **测试**：appWiring 新钉「selectSubtask stamps automation origin on tabs opened from run records」——RED 确认（缺条件展开而红）→ GREEN；automationRunLink 伴随用例「a work-style tab stamped with automation origin joins stale reconciliation」钉住 work-* id 带双字段即参与对账。
- **副作用复验（GLM F.3.2 预警逐条核实）**：① 分区归入 `runTabs`（App.tsx:3356）语义自洽；② `stopRunTab` 仅在 `runTabLive`（`isRunTabLive` 按 run-* id）为真时可达，work-* 恒非 live → 不会误停最新一轮；③ 回填 effect 要求 `runPlaceholder`（App.tsx:2245），work 标签无该字段 → 不被误回填；④ run-task 去重按 tabId/taskId/sessionId 命中后只对账字段，不产生第二标签。
- **规格对齐**：§7.2 新增一条 bullet（design.md:169），明示运行记录打开的标签携带 automationId 参与对账，与 §8 第 8 条口径统一。

### G.2 #4 修复（Minor）

- **生产改动**：`withValidTaskOrigin` 合法分支保留校验用的 trim 值（[stores.ts:213-218](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/stores.ts#L213-L218)）；读路径归一后 `removeTasksOfAutomation`/`createAutomationRunTask` 幂等查找的精确匹配可命中外部手写的空白来源。
- **测试**：stores.spec 新用例「whitespace-padded origin is normalized to the validated trim value so cascade matches」——RED 确认（`' auto-1 '` 未归一而红）→ GREEN；同用例断言归一后级联删除命中。

### G.3 #2/#3 残余登记（不改码）

- **理由**：与规格 §9.1 已裁定的 T2 残余窗口同族——设计承诺「快照时刻活跃者跳过」，不承诺消除 check-then-act 窗口。修 #2 需在准入后复检注册项存在性（触碰「guard 与 admit 同一同步段」不变量与执行体早退路径）；修 #3 需把恢复 appendRun 纳入注册表锁或写后复检（改锁设计）。两者超出本轮「严禁引入新问题」的边界，登记残余。
- **#2 触发条件**：删除级联恰好完成于手动/调度准入的 `automationAdmissionRoot` await 内（guard 已释放）。后果：孤儿 Task + 孤儿 runs 文件 + 一次模型执行，无注册项污染。触发后（真实用户出现孤儿 Task，或 owner 要求强保证）再评估准入后复检，约 0.5–1 人日。
- **#3 触发条件**：重启后首 tick 恢复窗口内用户删除同一 running 残留自动化。后果：仅磁盘孤儿 runs 文件，不被任何路径消费（prune keep 集只枚举在册自动化）。触发后（发现磁盘残留或 prune 枚举到孤儿文件）再评估恢复查 guard/存在性，约 0.5 人日。

### G.4 验证记录

- **定向**：客户端 5 文件 138 用例全绿（appWiring/automationRunLink/runTabsLogic/chatTabs/automations-runs-delete）；stores + automations-store 109 用例全绿。
- **全量**：`corepack yarn workspace dsh-plugin-huaanwork test` → **278 文件 passed / 4 skipped，3924 用例 passed / 14 skipped**；`corepack yarn workspace dsh-plugin-huaanwork typecheck` → **exit 0**（5 个 tsconfig，零输出，退出码不经管道直取）。
- **root 完整门禁**：`corepack yarn check` → **exit 0**（完整日志 `/tmp/hw-root-check-20261110.log`，末行 `ROOT_CHECK_EXIT=0`；未跳过任何步骤）。
- **真机 UI 复验**：走查 A/B 均 PASS（§G.5）。
- **边界（诚实声明）**：Windows 未验证（超本轮范围）；截图未入库（public 仓库不提交截图）；未提交任何 commit（改动在工作区，待 owner 验收后提交）。

### G.5 真机 UI 复验（2026-11-10 执行）

- **环境**：同一源码树（root check 已构建 + `prepare:electron-native` exit 0）；`mktemp -d` 隔离根（复制 `~/.huaanwork` 与 `profile-selection/state.json`），`DSH_HOME=<tmp>/.huaanwork`、`--user-data-dir=<tmp>/userData`、CDP `9333`、`HUAANWORK_ACCEPTANCE_HOOKS=1`（固定 Web 43120；崩溃注入未使用，门禁惰性）；真实模型 `deepseek-flash`。
- **走查 A（旧运行记录 → 删除自动化 → 标签关闭）PASS**：创建 agent 自动化「联动走查A」并自动建同名项目；「立即运行」两次均 ok，每次 Run 各带独立 Task（17:28:39→Task `850d9e4f`、17:28:46→Task `0bc9ca3e`）；重启应用后「任务」区只剩最新一条重建标签（重建只覆盖最新有效运行）；进入运行记录点击较早 Run（`8ebf6d3c…`，标题「打开子任务：…17:28:39」）→ 打开的工作标签出现在「任务」区并标「自动化运行」——automationId stamp 的可观测证据（修复前该标签不会出现在此分区）；删除自动化并确认 → **两条自动化标签（重建的最新 + 从旧记录打开的）同时从「任务」区消失**；磁盘：`automations.json` 空、0 残留 Task、runs 文件删除、0 残留会话目录、项目保留（规格 §9.3）。
- **走查 B（旧运行记录 → prune → 标签关闭）PASS**：创建「联动走查B」并真实运行一次（Run `e77e9cbf…`→Task `3b7adae5…`）；停实例后播种 21 条更新的合成 Run（伪 sessionId、无 Task），使真实运行落在最近 20 条保留窗口之外（共 22 条）；重启后 B **无**重建标签（预期：最新 5 条无 Task 可解析、真实运行在窗口外）；运行记录（22 行）点击真实旧 Run → stamped 标签出现在「任务」区；「清理历史运行会话 → 确认清理」→ 提示「已清理 1 个历史运行会话、1 个运行子任务」，**stamped 标签自动关闭**，该 Run 行变为不可点并显示「对应子任务或会话已删除/清理」；磁盘：自动化保留、0 残留 Task、0 残留会话目录、runs.jsonl 仍 22 行（Run 不删）——全部符合规格 §9.4。
- **证据**：截图 01–10 存于 `/tmp/hw-linkage-accept-evidence/`（未入库），DOM/磁盘事实已内联本节；含 api_key 的临时 profile 已随临时根删除。

### G.6 后续产品裁定：运行对话移出侧栏「任务」区（2026-11-10）

- **裁定**：owner 明确「每次自动化运行在侧栏『任务』区留一条会话记录没有必要」，选定「完全不显示」——运行标签不再在侧栏渲染；实时进度与历史以自动化页为准（任务行停止按钮、运行记录点开）。
- **背景**：该侧栏条目是 2026-11-08 里程碑的既有设计（每次运行一个 live 对话，便于实时观察/停止/续聊），但运行结束后条目不消失且侧栏无单条关闭入口，会持续累积成历史噪音；运行历史本就已由运行记录承载。
- **实现（TDD）**：
  - 删除侧栏运行分区渲染与 `runTabs` 派生、空态只按游离 Work 会话判定（App.tsx）；`ChatTab.automationId` 注释改写为「不进侧栏」并保留其对账职责。
  - 删除仅供该分区使用的 `.recent-item.live-dot` 死样式并 `gen:styles` 重新生成产物。
  - 新钉 `automation run tabs never enter the sidebar task list`（RED→GREEN）；旧钉「侧栏条目 live 判据」按新口径收窄（保留激活标签停止按钮判据与任务行 taskId 集合判据）。
- **不变项**：run-task / 重启重建 / `selectSubtask` 仍创建并 stamp 运行标签（实时观察、续聊、§G.1 失效对账依赖不变）；规格 §7.2 同步新增裁定 bullet。
- **验证**：客户端 48 文件 **710 用例全绿**；全量 workspace **278 文件 passed / 4 skipped、3925 用例 passed / 14 skipped**，typecheck **exit 0**；root `corepack yarn check` **exit 0**（日志 `/tmp/hw-root-check-sidebar.log`）。