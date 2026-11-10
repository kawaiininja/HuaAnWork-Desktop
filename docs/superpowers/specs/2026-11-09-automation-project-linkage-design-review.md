# 自动化项目联动规格与计划：对抗性评审及 double-check 裁定

- 日期：2026-11-09
- 对象：[`2026-11-09-automation-project-linkage-design.md`](./2026-11-09-automation-project-linkage-design.md) 与 [`../plans/2026-11-09-automation-project-linkage.md`](../plans/2026-11-09-automation-project-linkage.md)
- 方法：两路独立对抗评审（原始需求覆盖 / 技术可执行性）→ 主会话逐条反证与严重度校准（本文）
- 基线：master `0a8cd25054`；两份对象文档当时均未跟踪
- 结论：**With fixes**。修 T1/T3/T4/N1 与文档补证后可进入实施；产品语义无需再裁定。
- GLM 审核结论（2026-11-10 复核，见 §8）：四项必修确认已落入计划；文档补证三条与顺手修三条未闭环，补完（小时级）即可开工。
- GLM 复审收口（2026-11-10 第二轮，见 §8.7）：§8.6 六项前置已全部修入并经复验收实（含 M2 钉子有效性验证），规格与计划均达实施标准，可开工。

## 1. 批准链事实（校准产品类意见的依据）

1. 用户问答明确确认两项：项目归属「默认新建，可复用」；运行子任务「仅 agent 建」。
2. 随后助手在聊天中呈现完整设计，并明示批准门：「如果这版设计及五项推荐规则符合预期，下一步再将其落成设计文档并进入实施计划」。五项推荐规则 = 改名不联动 / 存量 null 不迁移 / 旧记录不回填 / prune 同步删 Task / 恢复后允许续聊。
3. 用户下一条指令：「复核预期，落成设计文档并撰写实施计划」——构成对该版设计（含五项推荐规则）的整体批准。

**评审简报缺漏登记**：主会话给产品评审 agent 的简报只列了第 1 条的两项问答确认，未提供第 2-3 条整体批准上下文，并指示「不要替文档自行补产品裁定」。产品类 Critical/Important 由此产生，属简报方责任，不是规格越权。

## 2. 产品类意见裁定

| 原意见 | 原严重度 | double-check  verdict | 证据与理由 |
| --- | --- | --- | --- |
| P1 spec §2「已确认裁定」越权 | Critical | **误报（夸大）**；残留 Minor 文档补证 | 五项规则均经 §1 批准链整体批准。spec §2 标题不构成失实。残留有效点：应在 §2 补一句确认来源（两项问答 + 整体批准），便于后续审计 |
| P2 存量 projectId:null 不建 Task 缩小「每次运行」 | Important | **关闭（已裁定）** | 五项推荐规则第 2 条原文，已批准；且 update 禁止改回 null（routes.ts:1241-1246），影响面仅存量 |
| P3 prune 级联删 Task 未授权 | Important | **关闭（已裁定）**；「仅最近约 20 次可跳」表述夸大 | 五项推荐规则第 4 条原文，已批准；prune 是用户手动确认动作（AutomationsView.tsx:696-711 确认框），非自动删除 |
| P4 改名不联动致名称漂移 | Important | **关闭（已裁定）** | 五项推荐规则第 1 条原文，已批准；且与 2026-11-07 规格 :42 的既有先例一致 |

## 3. 技术 Important 意见裁定

### T1 项目删除期间可新建/改绑入将删项目 —— 成立，维持 Important

- 证据：当前 `project.remove` 是锚点先删（routes.ts:1142 `removeProject` 先于级联）；计划 Task 7 改为锚点最后删，级联全程项目仍在 `projects.json`，`automation.create`（routes.ts:1200-1205）与 `automation.update`（:1254-1257）的存在性检查可通过 → 级联结束后悬空归属。**这是计划引入的新回归窗口，不是既有问题。**
- 漏报子项（并入本条修法）：`task.create`（routes.ts:1386-1395）同窗口可把普通子任务建进将删项目。
- 修法：新增 `deletingProjectIds` 进程内守卫；`automation.create/update` 绑定校验与 `task.create` 在同步段 assert；project.remove 进入 guard、finally 释放。规格 §9.1 与计划 Task 7 同步补。

### T2 活跃检查与删除之间的竞态 —— 成立但降级 Minor（文档诚实化即可关闭）

- 证据：`sessionSend` 准入不查任何删除守卫（sessions.ts:1014）；`releaseSessionRuntime` 会取消 live agent 并收掉等待项（sessions.ts:582-601）。快照检查后多个 await 内准入的续聊会被取消并删目录。
- 校准理由：同类窗口在现有 `deleteAutomationRun`/`session.remove` 已存在（只查 inFlightRuns）；本设计不是引入者。仓库已有 check-then-act 登记先例（routes.ts:1249-1250 注释明示不承诺消除窗口）。
- 修法（二选一）：①规格 §9.1/§10 的「活跃续聊不被清理」收窄为「快照时刻活跃者跳过」，并登记残余窗口（Minor，推荐，与既有先例同形）；②owner 要求强保证时会话级 deleting 守卫接入用户准入（升回 Important）。

### T3 旧 tasks 快照晚到误关新运行标签 —— 成立，维持 Important

- 证据：`refreshTasks` 无请求序号、后到覆盖（App.tsx:1129-1136）；`tasksLoaded` 只挡首次加载。早于 Task 落盘发出的 task.list 晚于 run-task 返回时，`staleAutomationRunTabs` 会关掉刚建的运行标签。
- 加重证据：run-end 处理器只 `refreshAutomations/refreshSessions`（App.tsx:1781-1782），不刷新 tasks，误关后不能靠 run-end 自愈。
- 修法：refreshTasks 加单调请求序号、丢弃过期应答；stale 对账只消费最新应答。计划 Task 5 补步骤与回归钉（旧应答晚到不得关新标签）。

### T4 Task 9 真机验收不可直接执行 —— 成立，维持 Important

- 证据：计划 Task 9 Step 2 只有「按仓库既有 CDP 验收约定」一句，无构建/启动命令；验收 hooks 仅有优雅 `restartHost`（preload.ts:72、acceptance-hooks.ts），无 running→Task / Task→Run / Run→终态的崩溃注入手段。
- 修法：补确切命令（build、prepare:electron-native、mktemp 隔离、清 ELECTRON_RUN_AS_NODE、CDP 端口）；崩溃窗口用 kill -9 时序或新增故障注入 hook；无法落实的项在证据文档标 BLOCKED，不得以优雅重启冒充崩溃窗口。

## 4. Minor 意见裁定

| 原意见 | verdict | 说明 |
| --- | --- | --- |
| M1 改绑只查 inFlight、未对齐 activeAutomationIds | 成立 Minor | 后果有界：enqueue 捕获旧 automation 快照，Task 落旧项目与「旧 Run 回旧项目」一致；可选对齐，不挡实施 |
| M2 appendRun 失败遗留 inFlight 条目 | 成立 Minor（既有缺陷） | automations-host.ts:587-589 先 append 后摘条目，:745 handedOff 不清；新删除/改绑守卫会放大为「重启前无法删除」。建议随计划 Task 2 顺手在失败路径摘条目 |
| M3 run-end.taskId 契约无任务归属；spec §11 漏 automationRunLink.ts | 成立 Minor | 计划 Task 1 Step 3 只加 run-task；Task 2 Files 不含 rpc-types.ts。追加：spec §8「必要时刷新一次 tasks」与计划 Task 5 的 props 快照口径不一致，一并统一 |
| M4 恢复缺逐条隔离 | **部分误报**；有效部分保留 Minor | spec §6.5 明写「后续启动仍可重试」，与现有首 tick flag 行为一致，不存在「承诺落空」；有效部分仅「单条失败阻断同批其余项」，计划 Task 3 补逐条 catch 即可 |

## 5. 漏报（本次 double-check 新增）

### N1（Important）规格 §9.1 的活跃拒绝过度覆盖普通项目删除

- 规格把「目标 sessionId 活跃即拒绝」扩到 project.remove 的全部目标会话，会把「普通任务对话中删除项目」从既有的「取消并级联删除」改成「拒绝」——超出原始三项需求范围。
- 精确证据：既有钉子 sessions.spec.ts:1735-1810 在 runtimeCtx 无 scheduler 的条件下验证 release-then-delete，不会字面变红；但生产语义改变真实存在，不能以「测试不红」否认。
- 修法：活跃拒绝只覆盖自动化生成的 Task 与运行会话；普通 task/project 级联保持 release-then-delete 既有语义。规格 §9.1/§9.3 与计划 Task 7 同步收窄。

### N2（Minor）prune keep 集遗漏「Task 已建但 Run 未落盘」的会话

- keep = 最近 20 条 Run.sessionId ∪ 活跃集；appendRun 失败（M2 场景）的最新运行无 Run 记录，其 Task/Session 不在 keep，prune 会清掉该次工作的唯一载体。
- 与 M2 联动：M2 修复后触发概率极低；在规格 §9.4 登记该边界即可，不新增机制。

## 6. 校准后行动清单

| 优先级 | 动作 | 落点 |
| --- | --- | --- |
| 实施前必修 | T1 项目级 deleting guard（含 task.create） | spec §9.1；plan Task 7 |
| 实施前必修 | T3 refreshTasks 请求序号 + 过期应答丢弃 | plan Task 5 |
| 实施前必修 | T4 真机命令与崩溃注入具体化，或 BLOCKED 降级 | plan Task 9 |
| 实施前必修 | N1 活跃拒绝收窄到自动化来源 | spec §9.1/§9.3；plan Task 7 |
| 顺手修 | M2 失败路径摘 inFlight；M3 契约归属与文件清单；M4 逐条 catch | plan Task 1/2/3 |
| 文档补证 | §1 批准链来源写入 spec §2；T2 残余窗口诚实化；N2 边界登记 | spec §2/§9/§10 |
| 无需动作 | P2/P3/P4（已裁定）；M1（可选对齐） | — |

## 7. 判决

**With fixes**：完成 §6 四项「实施前必修」与文档补证后，规格与计划可进入实施。产品语义已经 §1 批准链闭合，不再阻塞；本轮 double-check 未修改规格与计划本体。

---

## 8. GLM 审核结论（2026-11-10 复核）

- 复核人：GLM（独立于 §1-§7 两路评审与主会话裁定的第三轮复核）
- 对象：spec（含「已吸收」状态行）与 plan 全文，以及两者对现状代码的全部关键事实引用
- 方法：先按原始需求三项（创建同名项目 / 每次运行建日期子任务 / 自动化页退役看板与采集结果 + 运行记录跳转）核对覆盖度；再逐条 double-check 本轮发现的缺口清单与 §6 行动清单的落实状态；引用逐一对源码验证
- 基线：工作区现状（spec/plan 仍为未跟踪文档）；源码符号 + 行号双引，行号为 2026-11-10 读数

### 8.1 原始需求覆盖判定：通过

三项需求的全部澄清点均有明确裁定、无遗留歧义：需求 1 → spec §4（触发时机 / 命名一致性 / 重复同名 / 失败回滚 / 关联关系）；需求 2 → §2/§3/§5（一一对应 / 日期口径 / 命名 / 会话归属 / 多次运行 / 失败处理，含「一次运行 = 实际 started」边界）；需求 3 → §7/§8（删除与保留范围 / 跳转映射 / 无会话降级）。计划 Tasks 1-9 与验收（spec §12 + 计划 Task 9 Step 4/5）逐项对应。

### 8.2 计划事实基础抽查：全部属实

抽查并核实：`automation.create` 同名项目主流程与回滚链（routes.ts:1191-1227）；`automation.update` 禁改回 null（routes.ts:1241-1246）；`project.remove` 锚点先删（routes.ts:1142，T1 窗口系计划改为锚点最后删后**新引入**，guard 修法正确）；`deleteAutomationRun` Run 先删（automations-store.ts:549-580）；`pruneAutomationSessions` 返回 number、keep 集只含 collector（automations-store.ts:492-535）；`refreshTasks` 无请求序号（App.tsx:1129-1136）；run-end 只刷新 automations/sessions 不刷新 tasks（App.tsx:1781-1782）；`RootWriter` 无 automationId 而 `admitAutomation` 入参有（turn-scheduler.ts:30-33/:45-56，增量可行）；`executeRun` 同步段与 Task 创建插入点、`finishAutomation` 顺序（automations-host.ts:558-750）；恢复现状随机 runId（automation-scheduler.ts:235-253）；`sessionSend` 准入不查删除守卫（sessions.ts:1014）；`selectSubtask` 现仅按 taskId 查找（App.tsx:1159）；`acceptanceHooksEnabled`（acceptance-hooks.ts:56）、`automationRunSessionId`、`runTabsToRebuild` 现签名、`closeRunTabsForSession` 现判据；task.create/task.remove/pruneSessions 路由现状；`gen:styles`/`prepare:electron-native` 脚本；计划引用的全部测试文件存在（含计划标注「不存在则创建」的 acceptance-hooks.spec.ts，实际已存在）。未发现失实引用。

### 8.3 §6 行动清单落实状态

| §6 行动 | 状态 | 证据 |
| --- | --- | --- |
| T1 项目 deleting guard（含 task.create） | **已落实** | 计划 Task 7 Step 3（automation.create 显式绑定 / automation.update 改绑 / task.create 三个同步消费点）+ Step 5；spec §9.1 |
| T3 refreshTasks 请求序号 + 过期应答丢弃 | **已落实** | 计划 Task 5 Step 5 + appWiring 接线钉（源码切片边界 App.tsx:1129/:1139 相邻，可用） |
| T4 真机命令与崩溃注入 | **已落实** | 计划 Task 9 Step 2-4；三崩溃点与 spec §5.1 三窗口一一对应 |
| N1 活跃拒绝收窄到自动化来源 | **已落实** | 计划 Task 7 Step 5 + 回归④；spec §9.1/§9.3 |
| M2 失败路径摘 inFlight | **未吸收** | 计划 Task 2 无对应步骤与测试，见 8.4-4 |
| M3 契约归属与文件清单 | **未吸收** | 见 8.4-6 |
| M4 逐条 catch | **未显式化** | 见 8.4-5 |
| 文档补证（§2 来源 / T2 窗口 / N2 边界） | **未落实** | 见 8.4-1/2/3 |

### 8.4 缺口清单 double-check 结果（逐条复核，全部属实）

1. **spec §2 无批准链来源句（属实，Minor）**：§2 为裸裁定表；本文 §1 的批准链（两项问答 + 整体批准）未按 §6 要求写入 spec §2，审计链只存在于本评审文档。
2. **T2 残余窗口未登记（属实，Minor）**：spec §9.1「若目标 sessionId 在权威 activeSessionIds 中，拒绝删除」与 §10「prune 活跃续聊｜跳过，不删除」均为实时语义措辞；实现是快照并集，且 `sessionSend` 准入不查任何删除守卫（sessions.ts:1014）——快照后准入的续聊仍会被 release-then-delete。§6 选项①（收窄为「快照时刻活跃者跳过」并登记残余窗口，与 routes.ts:1249-1250 既有先例同形）未应用。
3. **N2 边界未登记（属实，Minor）**：spec §9.4 keep 集定义不含「Task 已建但 Run 未落盘」（appendRun 失败窗口）的会话；该场景 Task/Session 不在 keep，prune 会清掉该次工作的唯一载体。§6 要求在 §9.4 登记该边界，未落。
4. **M2 未吸收（属实；GLM 建议升格为随 Task 2 必修）**：泄漏形状经源码核实——agent 运行 handedOff=true 时 `executeRun` 的 finally 不摘条目（automations-host.ts:741-748），条目唯一摘除点在 `finishAutomation` 的 appendRun 之后（:587-589），appendRun 抛出即泄漏；`stopAutomation` 对已 started 的泄漏条目只能置 cancelRequested + 空操作取消，无法摘除（:761-796）。放大面核实：`automation.update` 改绑（routes.ts:1251）与计划 Task 7 Step 4 自动化删除、Step 5 项目删除预检均以 inFlight 为拒绝判据 ⇒ 泄漏期间改绑 / 删自动化 / 删项目全部被拒，直到 Host 重启。计划 Task 9 的 `after-run-append` 崩溃注入只覆盖硬崩溃（进程退出 → 重启恢复），不覆盖「appendRun 抛出但进程继续运行」的软失败路径。修法：finishAutomation 失败路径摘条目 + 回归钉（script 路径因 finally 兜底不受影响，钉子应针对 agent）。
5. **M4 逐条 catch 未显式化（属实，Minor）**：计划 Task 3 Step 3 末句「首个 tick 循环调用该函数；失败保留 running/activeRunId 并记录日志」未写明**逐自动化 try/catch**；现状是整批单层 `.catch`（automation-scheduler.ts:262-267），一条失败中断同批其余项恢复。spec §6.5 同样只有语义句、无隔离声明。
6. **M3 三处轻微不同步（属实，Minor）**：① spec §11 文件清单漏 `logic/automationRunLink.ts`（计划 File Structure 已新建该模块）；② 计划 Task 2 Step 4 要求「run-end 同步带 taskId」，但 Task 2 Files 只有 automations-store.ts / automations-host.ts + 两个测试文件，RpcEvent run-end 变体（rpc-types.ts）的一行改动无任务归属（Task 1 加 run-task 事件、Task 4 删 widget 事件，均不含该变体）；③ spec §8.1「必要时刷新一次 tasks」（按需刷新口径）与计划 Task 5 Step 6 的常驻 props 快照 + onChanged 刷新口径不一致，未统一。

### 8.5 复核附注（非缺口）

- **MISSING_PROJECT 测试不冲突确认**：spec §5.2.3 / 计划 Task 2 Step 4 把「绑定项目缺失路径不写 sessionId」从现状（agent 路径写推导 sessionId，automations-host.ts:674）改掉；既有钉子是 script 用例（automations-host.spec.ts:916-928），script 本无 sessionId，不构成冲突。实施时该行为变化应补一条 agent 用例钉住。
- **removeAutomation 锁形态实施提示**：Task 7 锚点最后删要求重排现实现（automations-store.ts:364-373 整个级联持注册表锁且注册项先删）。taskRegistryLock 嵌套在 automationRegistryLock 内是 spec §3.2.6 允许的方向（仅反方向被禁）；计划未钉死该选择，实施者须避免反向嵌套，并注意全局注册表锁跨慢速 fs 级联会暂时阻塞其他自动化的 markAutomation/finishAutomation（与现状同形，非新回归）。

### 8.6 GLM 判定

- **规格：通过**。原始需求全覆盖、无越权裁定、验收标准齐备。
- **计划：实质达到实施标准；按本文 §7 门槛尚差收尾项**——四项必修已确认全部落实且落点正确；未闭环项为 §6「文档补证」三条（8.4-1/2/3）与「顺手修」三条（8.4-4/5/6），全部为句级或小时级改动，不涉及架构调整。
- **开工前置清单（六项）**：① spec §2 补批准链来源句；② spec §9.1/§10 收窄活跃措辞并登记 T2 残余窗口；③ spec §9.4 登记 N2 边界；④ 计划 Task 2 补 M2 失败路径摘条目 + agent 回归钉（升格理由：新守卫使泄漏从内存噪声放大为「重启前无法改绑/删除」）；⑤ 计划 Task 3 写明逐条 catch；⑥ 三处 M3 同步（spec §11 补 automationRunLink.ts、run-end taskId 归入 Task 2 Files 或 Task 1、统一 §8.1 与 Task 5 的刷新口径）。
- 完成前维持 §7「With fixes」；完成后即可按计划开工。本轮 GLM 复核只更新了本评审文档，未修改规格与计划本体。

### 8.7 GLM 复审收口（2026-11-10 第二轮：六项前置闭环复验）

- 复核性质：对 §8.6 开工前置清单修复结果的逐条复验收实——核对修复的**有效性**而非仅存在性；新读数均为 2026-11-10。
- 本节收口后，§8.3 表中 M2/M3/M4/文档补证的「未吸收 / 未落实」与 §8.4 各条均视为**第一轮时点状态**，以本节结论为准。

**六项前置闭环对照**

| # | 前置项（§8.6） | 状态 | 复验证据 |
| --- | --- | --- | --- |
| ① | spec §2 批准链来源句 | **已闭环** | §2 新增来源段：两项问答（2026-11-09）+ 整体批准 + 指向本文 §1 |
| ② | T2 快照语义 + 残余窗口登记 | **已闭环** | spec §9.1 措辞收窄为「权威 activeSessionIds **快照**」+ 新增残余窗口登记段（sessionSend 不查守卫、快照后准入仍会被 release-then-delete、与 routes.ts 改绑守卫先例同形）；§10 表行与 §12 验收第 9 条同步改写 |
| ③ | N2 边界登记 | **已闭环** | spec §9.4 新增「边界登记（N2）」段，含与 M2 修复的联动说明与「登记接受、不新增机制」裁定 |
| ④ | 计划 Task 2 补 M2 | **已闭环** | Step 1 新增 agent 软失败回归钉（runs.jsonl 占位为目录 → appendRun 抛 EISDIR）；Step 4 新增 try/finally 摘条目修复；Files 补 rpc-types.ts:480-489（run-end 变体，M3 归属） |
| ⑤ | Task 3 逐条 catch | **已闭环** | Step 3 显式写出逐自动化 try/catch 循环代码并标注 M4 语义（保留 running/activeRunId、下次启动重试），与 spec §6.5 一致 |
| ⑥ | M3 三处同步 | **已闭环** | spec §11 补 `logic/automationRunLink.ts` 条目；run-end taskId 归入 Task 2 Files（rpc-types.ts:480-489，行号范围经核实准确）；spec §8.1 改为常驻快照口径（「点击时不单独按需刷新」），与计划 Task 5 Step 5/6 一致 |

**新增内容有效性验证（超出存在性核对）**

- **M2 回归钉非空转**：真实 `runAgentTurn` 在 turn 体内调用 `onHandoff()`（automations-host.ts:367），harness 以假 agent runtime 跑真 `executeRun`——agent 路径确实 handedOff=true、executeRun 的 finally 不摘条目；无修复时 `inFlightRuns.has(runId)` 为 true，钉子必红，修复后过。`started.done` 契约经 harness `startAutomation`（automations-host.spec.ts:300-324，done = enqueueAutomation 返回的执行体 promise）核实成立；`inFlightRuns` 确从 `automation-inflight.ts:23` 导出。
- **M2 修复语义自洽**：摘条目移入 finally 后，appendRun 软失败时注册表仍留 running + activeRunId，Host 重启后走 spec §6.3 恢复路径；prune 侧该窗口已由 N2 登记（③）覆盖。代价（后续 stop 见无条目而误判「已落盘 ⇒ 未停止」）远轻于泄漏后果（改绑 / 删自动化 / 删项目被阻断直到重启），裁定合理。
- 计划 Self-Review 已补「GLM §8.6 六项收尾已落」行，与实际改动一致。

**复审判定**

- §7 门槛（四项必修 + 文档补证）已全部满足；四项必修落实见 §8.3，六项前置闭环见本节。
- **规格与计划均达实施标准，可从计划 Task 1 开工。**
- 本轮复审只更新了本评审文档；规格与计划的六项修复由文档所有者另行修入，本节仅作复验收实记录。
