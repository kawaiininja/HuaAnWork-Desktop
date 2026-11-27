# 知识库 M1-2（`feat/knowledge-base-m1-2-single-slot-organizer`）Code Review

- **日期：** 2026-11-27
- **审阅目标：** 分支 `feat/knowledge-base-m1-2-single-slot-organizer`
  - 共同基线（`master` / merge-base）：`5fc019eddfc468a4315c5ce04315944d40bb4b96`
  - 评审 `HEAD`：`84f622026f846242a66585c11566c4b11002fe49`
  - 范围：10 个提交（含 docs-only 提交 `2da440fbf1`）、41 个文件，`9990 insertions(+), 91 deletions(-)`
  - 上游子模块 `deepseek-harness/`：本范围无修改
- **对照依据：**
  - 设计规格：[2026-11-24-knowledge-base-design.md](../specs/2026-11-24-knowledge-base-design.md)（v2.5 §§2.3、4、5.3、8.1–8.3、10、11.1）
  - 实施计划：[2026-11-25-knowledge-base-m1-2-single-slot-organizer.md](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md)（Global Constraints、Task 1–6 及 2026-11-26/27 校准落点）
  - 计划评审：[2026-11-25-knowledge-base-m1-2-plan-review.md](./2026-11-25-knowledge-base-m1-2-plan-review.md)（D1/D2、R2/R3、G-I1/G-M1/G-N1–G-N8、R-1–R-4）
- **评审方式：** 按 `superpowers:requesting-code-review` 派发独立 `general-purpose` reviewer；对 HEAD 做只读源码审查、定向测试、typecheck 与完整门禁。本文档由主会话根据 reviewer 最终报告整理，关键问题定位在落档前再次读码复核。
- **范围外：** 真机/GUI、维护页、composer、引用预览与打包应用整理槽观察按计划归 M1-3/发布验收；两个既存未跟踪文件 `2026-11-25-knowledge-base-m1-3-session-mount-ui-citations.md`、`2026-11-25-knowledge-base-m2-0-legacy-office-spike.md` 不属于本次评审。
- **当前判定：** **Ready to merge / Yes（§十，2026-11-27 合并前最终复核 + IMP-1 补修闭环）。** 0 Critical / 0 Important 开放；IMP-1（符号链接 + `..` 物理穿越越界写）经独立反证坐实并红绿修复，修复后完整 `corepack yarn check` 实跑 `GATE_EXIT=0`（Vitest 5788 passed / 0 failed）；MIN-1 与既有延后债务按原定里程碑承接。历史判定（§五 With fixes、§6.5/§7.6/§9.2 Yes）保留原文。
- **GLM 轨校准与修复确认（2026-11-27）：** §三 六项事实全部属实；I-1、M-2 已修复并补 3 条回归测试，修复已提交为 `728c7619e4`，完整 `corepack yarn check` 实跑 `GATE_EXIT=0`；M-1 已裁定为「停止并抑制自动重启」，须在 M1-3 接入取消路由之前落地，代码落地时点与是否现在写入计划 L525 两项待定（§6.6）；M-3/M-4/M-5 按原文留下一轮。逐条校准、验证记录与裁定全文见 §六。

严重度口径：

- **Critical：** 安全边界 fail-open、数据丢失、核心功能不可用或严重并发破坏。
- **Important：** 明确的正确性、鲁棒性或性能缺陷，合并前应修。
- **Minor：** 当前不可达、影响有限或属于后续语义/一致性打磨的问题，不阻塞修完 Important 后的合入。

---

## 一、落档校准与证据边界

1. **只记录 HEAD 仍成立的问题。** 计划评审中的历史发现若已由后续提交修复，不重复计入本轮问题清单；`5b9b5aaa30`、`bf6a6b6fb2`、`84f622026f` 的预启动异常、看门狗重武装、手动触发顺序、失败写入退避及 release 重入抑制均在 HEAD 复核。
2. **M-3 表述收窄。** reviewer 原报告把「peek/open 瞬时失败后相位残留」并列。落档读码确认：`openOrganizeBatch` 位于 `locals.admitted = true` 之后，其异常会进入 `runCandidate` 的 `finally`，并在已准入分支执行 `clearOrganizerPhase`。仍然成立的是：上一轮留下 `waiting-turn-slot` / `blocked-*` 后，下一轮在 `peek` 等**准入前**步骤抛错时，不会清理上一轮整理相位。该校准不改变 Minor 分级。
3. **静态与实跑证据分开记录。** 本文的代码事实来自 HEAD 读码；测试计数与门禁结果来自 reviewer 的实际命令输出。未执行的真机项不声称通过。
4. **本轮只评审与落档，未修复实现。** I-1 与 M-1–M-5 在本文落档时均为开放项；本文档本身是唯一新增产出。

---

## 二、已经对齐的部分

1. **整理根 fail-closed，检查顺序正确。** `sandbox-cwd.ts:100-113` 的缺根检查位于 `seedSource === 'persistence'` 早退之前，不继承父会话根、不回落前台根或 `process.cwd()`；`writable-root.ts:75-84` 的整理前缀分支先于任务绑定和项目根，且不以 `existsSync(wiki)` 代替有效库登记。`knowledge-org-isolation.spec.ts:114-182` 对这些分支有判别性覆盖。
2. **双层白名单与空交集修复符合 G-M1。** `present-as.ts:167-179` 只消费 `huaanworkSessionToolAllow`，显式白名单存在、schemas 非空且交集为空时执行 `tools.restrict({ allow: [] })`；不读取 `huaanworkPackageChildAllow`，保持 `@agent` 路径零改动。`policy.ts` 在 pre-execute 与 guard 两层再次收窄，`knowledge-tool-allow.spec.ts:269-316` 覆盖 packageChildAllow 不影响可见集的对照。
3. **悬空符号链接防御落点正确。** `policy.ts:227-258` 在宿主护栏层使用 `lstat`，`@huaanwork/policy` 继续保持纯逻辑、零三方依赖；`knowledge-tool-allow.spec.ts:461-478` 使用真实 `symlinkSync` 构造悬空链接，而不是已被 `resolveInside` 覆盖的存量越界目标。
4. **冻结批次是唯一权威快照。** `host.ts:795-833` 对 open 批做深拷贝/冻结，重复 open 拒绝，查询期间删库不会复活批次；`kb_org_get_delta` 只返回该快照，回合末结算不另查 pending 替代本批。真实 Storage Worker 黑盒测试证明「墓碑行已删、Wiki 文件仍由 Host 层负责」，且 Worker/DB 层无 `unlink`。
5. **受控墓碑删除与大小上限符合计划。** Host 工具层先 `lstat`，`ENOENT` 允许清行，存在时才经 `resolveInside(..., { forWrite: true })` 和常规文件校验；文件先于数据库行删除，单个 `unlink` 失败只保留对应行。只接受登记的 `docs/<docId>.md`，不接受模型给出的专题路径；50 MiB 全库上限使用 `lstat` 累加、不跟随链接，并由小上限注入测试证明拒绝。
6. **FIFO 抢占与 D1 一致。** 同根用户回合不无谓取消整理，release 幂等不二次扣减；`drain:true` 仅出现在抢占成功且调用前队列非空的分支。`sessions.ts:1231-1239` 保持 `drainQueue → reevaluateDueAutomations → reevaluateKbOrganize`，出队应答为 `waiting:false, started:false, queueItemId`，真实 `sessionSend` 测试覆盖只由 `startQueuedItem` 启动。
7. **R3-1 客户端归属完整。** `App.tsx:3768` 只凭 `queueItemId` 登记 owner，`App.tsx:1071` 与 `sessionChannel.ts:310` 两层 pending-event 守卫一致；queue-start 仍是唯一回合初始化点。start/fail 各自早于/晚于应答的四条时序均覆盖，失败不错误开回合，且能恢复 running、notStarted 与模型选择状态。
8. **真实 Agent 驱动和终止原因处理成立。** `organizer.ts:619-685` 完成 activity 注册、create、一次 followup、`whenIdle`/deadline 竞速与晚到 rejection 消费；create-pending 取消会跳过 followup且不计次。看门狗采用「定时器只唤醒 + 注入时钟与 touch 基准比较」，`noteSystemResume()` 等同 touch；正反拨钟及重武装测试均有覆盖。
9. **纯墓碑 1/5/3 与失败写入退避闭环。** 排序后的 pending 签名只在真实新工作时复位，取消只清计时器不计次；`84f622026f` 将失败计次写失败转化为进程内退避，阻止 `releaseAndDrain → reevaluateKbOrganize` 造成立即重入。测试夹具的 `releaseSlot` 带生产同形钩子，集成测试也覆盖真实接线。
10. **手动触发顺序与 G-I1 均有判别性测试。** `organizer.ts:829-845` 先 `assertOrganizeAllowed`、等待旧槽彻底空闲，再清计数/计时器并排期；维护、删除、recovery、未知库拒绝时无副作用。`organizer.ts:607` 在 open 后、createAgent 前创建 `wiki/`，集成测试在 createAgent 桩内断言根存在，并用真实 `preExecuteExplained` 做已建/未建根的 allow/deny 对照。
11. **相位与自动触发缝收口。** `settlePhase` / `pauseWatch` / `resumeWatch` 均保留整理相位；六种 reconcile trigger 共用 `onIndexCommitted`，epoch 失效和失败不通知。create/rebind/rebuild 的成功补偿通知位于维护锁释放后，失败与 `wiki-reset-pending` 不误触发。
12. **边界未扩张。** 全部实现收敛在桌面源码与 `@huaanwork/policy`；复用同一个 KnowledgeHost/StorageClient，没有第二个 Storage Worker；未注册 `knowledge/changed`、`knowledge/event`，路由契约测试确认 `ROUTE_TABLE` 长度仍为 92。

---

## 三、问题清单

### Critical（必须修复）

无。

### Important（合并前修复）

#### I-1【性能 + 异常安全】看门狗每次心跳同步读设置，`timeoutMs()` 异常可逃出定时器或桥接回调

- **位置：**
  - `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer.ts:269-295`（`timeout()`、`wake()`、`touch()` 与首次 `arm()`）
  - `dsh-plugin-huaanwork/src/huaanwork-host/index.ts:320`（生产 `timeoutMs` 每次调用 `readHuaanworkSettingsSync`）
  - `dsh-plugin-huaanwork/src/huaanwork-host/settings.ts:336-345`（非 ENOENT/SyntaxError 直接抛出）
  - `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:348-355`（每个文本/推理 chunk 发 activity 心跳）
- **问题事实：**
  1. `touch()` 每次都经 `arm(timeout())` 调用生产 `timeoutMs()`，因此每个模型流 chunk 都可能在 Host 主线程执行一次 `readFileSync + JSON.parse`。以 50 chunk/s 连续 10 分钟作数量级估算，可达约 30,000 次同步设置读取；这是风险估算，不是性能实测。既有自动化 `activityDeadline` 先例只在创建时读取一次。
  2. 批次进行中若设置文件因权限变化、fd 耗尽等出现非 ENOENT 读取错误，`readHuaanworkSettingsSync` 会抛错。在 `wake()` 中抛出可成为定时器回调未捕获异常；在 `touch()` 中抛出会沿 activity observer 传回 bridge 的流生成器或工具监听路径，以无关 I/O 错误中断整理回合。
  3. 模型预检对同一个设置读取已有 try/catch（`organizer.ts:312-317`），看门狗路径没有等价保护。完整门禁通过不能覆盖这种运行中文件系统故障。
- **触发场景：** 整理回合正在高频流式输出，同时设置文件变得不可读；下一次 token 心跳或看门狗唤醒即可把设置读取异常带进模型流/工具回调或 Host 定时器。
- **修复建议：** 首选在每个 `IdleDeadline` 创建时快照一次经过合法性钳制的超时值，touch/re-arm 复用该值；若必须让运行期设置修改生效，只在 `wake()` 中受保护地重读并明确异常回落策略，不能让异常逃出回调。补一条 `timeoutMs()` 抛错的回归测试，覆盖首次 arm、touch 和 wake 中实际采用的路径。
- **验收建议：** 修复后重跑 organizer、integration、isolation 相关测试及完整 `corepack yarn check`；若选择快照语义，再断言同一 deadline 生命周期内不会逐心跳重读设置。

### Minor（建议处置，不阻塞）

#### M-1【后续语义】`user-stop` 对自动整理库可能在同一排空链上立即重启

- **位置：** `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer.ts:847-856`、`:751-763`。
- **问题与场景：** `cancelForKb` 结算取消后，`releaseSlot → drainUserQueue → reevaluateKbOrganize → scheduleEvaluate` 会对 `autoOrganize=true` 且仍有待整理文档的库再次准入，事件流可能呈现 `organize_cancelled` 紧跟 `organize_started`。
- **边界：** M1-2 生产尚无 `user-stop` 调用方，`knowledge.organizeCancel` 路由属于 M1-3，因此当前不可由产品入口触发；现有测试也有意用 `autoOrganize=false` 隔离该行为。
- **建议：** M1-3 接线路由前由 owner 明确「停止当前回合」还是「停止并抑制自动重启」；若是后者，要求真实新工作或显式手动触发才重新排期，并补 release 重入测试。

#### M-2【错误契约】整理缺根时 guard 抛异常，而非返回结构化拒绝

- **位置：** `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:227-250`，尤其 `:234`。
- **问题与场景：** `organizerWriteDenial` 直接调用 `sessionWorkspaceRoot`；整理会话根表缺条目时抛出 `knowledge-organize-root-missing`，而不是返回 guard reason。方向仍然 fail-closed，但异常会穿过 `tools/pre-execute` / `tools.guard` 监听层，区别于正常策略拒绝。
- **边界：** 生产 organizer 在 createAgent 前写根、dispose 后才清根，因此正常主链路不可达；属于异常路径一致性，不是当前安全绕过。
- **建议：** 对根推导异常做窄捕获并转换成具名拒绝原因，保留其它意外异常的可诊断性；补缺根调用测试。

#### M-3【相位新鲜度】准入前瞬时失败可保留上一轮整理相位

- **位置：** `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer.ts:560-590`、`:689-699`、`:751-763`。
- **问题与场景：** 上一轮因模型/网络预检留下 `blocked-no-model` / `blocked-network`，或因调度等待留下 `waiting-turn-slot`；下一轮在 `peekPendingOrganizeBatch` 等准入前步骤抛出临时存储错误时，外层 catch/finally 不会进入仅对 `locals.admitted` 执行的相位清理，旧整理相位会保留到后续成功评估。
- **落档校准：** `openOrganizeBatch` 失败不属于此缺口：open 前已经准入，`finally` 的已准入分支会清相位。
- **影响：** 主要是状态展示的新鲜度，不影响批次结算、取消或名额释放。
- **建议：** 为非准入异常出口定义明确相位所有权，只清理当前仍属于 organizer 的相位，不覆盖 recovery、重建或新同步状态；补「先有 blocked/waiting，再让下一次 peek 抛错」的回归测试。

#### M-4【事件语义】结算窗口内到达的取消会把事实完成批次记成 cancelled

- **位置：** `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer.ts:360-371`。
- **问题与场景：** idle 已干净结束且全部文档已 mark 后、`closeOrganizeBatch` 前到达维护取消时，`terminal === undefined` 会使 `settleBatch` 再读 `cancelReasonByKb`，将本批写为 `organize_cancelled`，而非已完成。
- **影响：** 取消方向安全，不会把取消误计为失败；偏差仅在事件对事实结果的表达。可以保留保守语义，也可在 idle 正常完成时锁存回合结果，让晚到取消只负责等待清理、不改写已完成事实。

#### M-5【生命周期一致性】`setReevaluateKbOrganize(undefined)` 没有所有权校验

- **位置：** `dsh-plugin-huaanwork/src/huaanwork-host/index.ts:368-381`。
- **问题与场景：** knowledge disposer 无条件清空全局重评估回调，与 `setKnowledgeHost` / `setRegisteredKnowledgeBaseIdsProvider` 的身份校验 disposer 模式不一致。若未来允许重叠 Host 交接，旧 Host 的晚到退场可能清掉新 Host 回调。
- **边界：** 当前串行 Host 重启生命周期下安全，没有已证明的现行触发路径。
- **建议：** 后续统一为按回调/owner 身份清理，或让 setter 返回带所有权校验的 disposer；不要在本轮单独为假想交接模型扩大改动面。

---

## 四、验证记录

### 4.1 源码审查

reviewer 完整阅读实施计划、计划评审与规格相关 diff；逐行阅读全部新增实现文件及修改文件 diff，包括 Host、SyncEngine、Storage 四层、TurnScheduler、sessions、bridge、policy、present-as、sandbox-cwd、model、holders、writable-root、index、App 与 sessionChannel。通读 `knowledge-organizer.spec.ts`（1857 行）和 `knowledge-organizer-integration.spec.ts`（1449 行），并抽查其余新增测试的关键用例。上游 `followup()` / `whenIdle()`、消息形状与 ID 契约也做了源码核实。

### 4.2 实际执行

| 验证项 | 结果 |
| --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **通过**，5 个工程 |
| 聚焦 Vitest：org-isolation + org-tools + tool-allow | **40 passed** |
| 聚焦 Vitest：organizer + organizer-phase | **52 passed** |
| 聚焦 Vitest：turn-scheduler-kb-organize + turn-scheduler + organizer-integration | **53 passed** |
| 聚焦 Vitest：appWiring + model + present-as.cordis + policy.cordis | **223 passed** |
| 聚焦 Vitest：routes + route-contract | **56 passed**，含 `ROUTE_TABLE=92` |
| `corepack yarn workspace @huaanwork/policy test` | **67 passed / 0 failed / 2 个既有 skipped** |
| 完整 `corepack yarn check` | **真实退出码 `GATE_EXIT=0`**；约 5779 个 Vitest 用例及各 node:test 套件 0 失败 |
| 真机/GUI、维护页、composer、引用预览、打包应用整理槽 | **未执行**，按计划归 M1-3/发布验收 |

聚焦 Vitest 分组共 424 条通过；它们与完整门禁存在包含关系，不应累加成独立测试总数。

**门禁退出码说明：** reviewer 首次以后台管道运行完整门禁，管道末端的 `tail` 不能证明 Yarn 自身退出码；随后改用输出重定向并显式记录 `GATE_EXIT=$?` 重跑，第二次确认 `GATE_EXIT=0`。完整门禁未与其它含 `verify:aa` 的命令并发。

---

## 五、处置建议与合并评估

1. **合并前：修复 I-1。** 收敛看门狗设置读取频率并封住 `timeoutMs()` 抛出路径；补异常回归测试，重跑 organizer/integration 与完整根门禁。
2. **M1-3 前：裁定 M-1。** 在接入 `knowledge.organizeCancel` 前明确 user-stop 是否抑制自动重启，避免 UI「停止」实际立即重开。
3. **可顺手处理：M-2。** 将缺根异常转换为结构化策略拒绝；M-3/M-4/M-5 可进入下一轮状态语义与生命周期打磨，不阻塞本次合并。
4. **保持既有验收边界。** 完整 headless 门禁已通过，但不能据此宣称真机 GUI 或发布验收通过；计划评审 R-4 的休眠/定时器真实先后时序仍应由后续真机项承接。

### Assessment

**Ready to merge：With fixes。**

核心实现与安全边界符合 M1-2 计划、D1/D2、G-M1 及纯墓碑 1/5/3 裁定，最新修复已在 HEAD 形成有效回归覆盖，完整 `corepack yarn check` 真实退出码为 0。唯一 Important 是看门狗逐心跳同步读取设置及其未保护异常路径，修复面局部；完成 I-1 后，其余五项 Minor 可按上述里程碑分别跟进。

---

## 六、GLM 轨校准与处置（2026-11-27）

> 本节由 GLM 轨在 owner 授权下追加；§一～§五 保留 kimi 评审原文。校准对象是本文所评 HEAD（`84f622026f`）的六项发现；修复与新增测试已提交到同一分支（`728c7619e4`）。除 §6.3 列出的实跑项外，本节结论来自读码。

### 6.1 逐条校准

六项的事实陈述与位置引用经 HEAD 读码逐条核对，**全部属实**。需要校准的是两处（I-1 的严重度理由、M-2 的修复落点）：

| 项 | 校准结论 | 处置 |
| --- | --- | --- |
| I-1 | 性能部分量级被高估：单次是小文件同步读，绝对开销有限（估算，未实测），且 `readGuardMode` 已有逐工具调用的同步读先例。异常路径被**低估**：`wake()` 抛出在 Host 进程不是普通未捕获异常，而是 fail-loud `exit(1)`（`host-process-entry.ts:49` 的 `installFailLoud` 订阅 `uncaughtException`）；`touch()` 抛出会中断模型流，并让本批全部未 mark 文档各计一次失败。Important 成立 | 已修复，见 §6.2 |
| M-1 | 属实。M1-2 无 `user-stop` 调用方，`knowledge.organizeCancel` 路由属于 M1-3 | 已裁定，见 §6.4；实现未落代码 |
| M-2 | 属实，但修复落点不完整：`organizerWriteDenial`（`policy.ts:234`）只是抛点之一，`toToolCall`（`policy.ts:352`）对**全部**工具都会经 `sessionWorkspaceRoot` 抛缺根（修复前实测 `read` 的异常栈落在 `toToolCall`）。只在 `organizerWriteDenial` 窄捕获，write/edit 得到结构化拒绝而 read/`kb_org_*` 仍抛异常，错误契约被劈成两半。两种形态本都 fail-closed：上游 `prepareExecution` 把监听器异常转成工具错误结果 | 已修复（两层缝入口统一判定），见 §6.2 |
| M-3 | 属实，含 §一.2 的落档校准；只影响相位展示的新鲜度 | 未处置，留下一轮 |
| M-4 | 属实；落库事实正确，仅事件与 `scheduleNext` 取保守值 | 未处置，留下一轮 |
| M-5 | 属实；当前串行 Host 生命周期下无触发路径 | 未处置，留下一轮 |

### 6.2 已修复

- **I-1（快照语义）**：`organizer.ts` 新增 `readIdleTimeoutMs`，每个看门狗创建时读一次并钳制，`touch()` 与唤醒后的重新武装复用这份快照，与自动化 `activityDeadline` 同一语义。因此**运行中修改 `automation_timeout_ms` 从下一批生效**，不再逐心跳同步重读设置；读取抛错回落 `DEFAULT_AUTOMATION_TIMEOUT_MS` 并只告警一次，不再逃出模型流、工具回调或定时器回调。实施计划 Task 5 的看门狗口径（L531）已按此同步。
- **M-2（一致的错误契约）**：`policy.ts` 新增 `organizerRootDenial`，在 `tools/pre-execute` 与 `tools.guard` 两层缝里先于任何根推导执行；整理会话缺登记根时所有工具都得到具名拒绝（原因含稳定代码 `knowledge-organize-root-missing`），其它意外异常照旧抛出、保留可诊断性。主链路仍不可达（执行器在 `createAgent` 前写根、`dispose` 后才清）。

### 6.3 验证记录

三条新回归测试均先看到失败、再随修复转通过：

| 测试 | 修复前（实跑） | 修复后（实跑） |
| --- | --- | --- |
| `knowledge-organizer.spec.ts`「reads the idle timeout once per watchdog…」 | 同一 deadline 内设置被读 9 次 | 1 次 |
| `knowledge-organizer.spec.ts`「falls back to the default idle timeout…」 | 首次 arm 即抛，批次未到 `createAgent` | 回落默认 10 分钟；心跳、休眠恢复、唤醒均不抛，到点超时并计次 |
| `knowledge-tool-allow.spec.ts`「an organizer session without a registered root…」 | `knowledge-organize-root-missing` 异常穿过两层缝 | 两层缝对所有白名单工具返回具名拒绝 |

- `corepack yarn workspace dsh-plugin-huaanwork typecheck`：退出码 0（5 个工程）。
- 完整 `corepack yarn check`：输出重定向并显式记录 **`GATE_EXIT=0`**；Vitest 合计 5782 通过、15 skipped、0 失败（较 §四 的 5779 多出的 3 条即上表新增），15 个 node:test 套件 `# fail 0`。门禁期间未并发其它含 `verify:aa` 的命令。
- 提交前复跑（修复提交为 `728c7619e4`）：`corepack yarn workspace dsh-plugin-huaanwork typecheck` 退出码 0；聚焦 Vitest 6 个文件 118 通过、0 失败（organizer 49、organizer-integration 23、organizer-phase 5、org-isolation 17、org-tools 10、tool-allow 14），退出码 0；提交后 `node scripts/check-whitespace.mjs` 覆盖已提交代码 diff，退出码 0。完整 `corepack yarn check` 未在提交后重跑，沿用上面那次实跑：提交内容与当时的工作区代码相同，期间只改了文档。
- **未执行、不声称通过**：真机 / GUI / 打包应用整理槽观察仍按原计划归 M1-3 / 发布验收；M-1 的抑制逻辑尚无代码（见 §6.4）。

### 6.4 M-1 裁定（2026-11-27 owner 裁定，采纳 GLM 轨建议）

**`user-stop` =「停止并抑制自动重启」。**

- **语义**：`user-stop` 结算后，`autoOrganize=true` 且仍有待整理文档的库**不得**经同一条排空链（`releaseSlot → drainUserQueue → reevaluateKbOrganize → scheduleEvaluate`）立即重新准入；事件流止于 `organize_cancelled`，其后不得紧跟 `organize_started`。
- **复位条件**：只有出现真实新待整理工作（权威待整理签名变化：新文档或墓碑集合变化）或显式 `triggerManual` 才恢复自动准入，与纯墓碑零进展退避的复位条件同构。
- **不变量沿用**：四类取消均不计 `organize_attempts`、不计纯墓碑零进展次数（实施计划 Task 5 原文不变）。
- **范围**：仅 `user-stop`。`preempt`（让位后按名额重评估）、`maintenance`（维护结束由补偿通知重排期）、`dispose`（新 organizer 接手）维持现状。
- **验收**：按 §三 M-1 的建议补「release 重入测试」——测试夹具的 `releaseSlot` 须带生产同形钩子，断言 `user-stop` 之后不出现新的 create / followup，且真实新工作或 `triggerManual` 之后能恢复。
- **落地时点**：M1-3 接入 `knowledge.organizeCancel` 路由之前必须完成。M1-2 现有代码未实现该抑制（无生产调用方，当前不可由产品入口触发）。
- **落地建议（未裁定部分，实现时可调整）**：抑制做成 organizer 进程内的按库锁存，记录 `user-stop` 结算时的待整理签名；Host 重启复位、不扩 Storage schema，与纯墓碑退避同口径。

裁定的后续两个时点（代码落地、写入实施计划）尚未确定，停放见 §6.6。

### 6.5 合并评估更新

§五.1 的合并前事项（修复 I-1）与 §五.3 的可顺手项（M-2）已完成，本文唯一 Important 闭环；M-1 已裁定、尚未落代码（时点待定，见 §6.6）。剩余 M-3/M-4/M-5 按原文不阻塞合并。§6.2 的修复已提交到本分支（`728c7619e4`），合并前提已满足；真机验收边界不变。

### 6.6 待定项（2026-11-27 停放）

§6.4 的裁定本身已定；以下两个时点仍待 owner 决定，决定之前不改代码、不改实施计划 L525：

1. **M-1 抑制逻辑的代码落地时点。** 现在在本分支实现（按 §6.4 的验收补 release 重入测试），还是留到 M1-3。不变约束：落地之前 M1-3 不得接入 `knowledge.organizeCancel` 路由。
2. **M-1 裁定是否现在写入实施计划 Task 5 的取消规则（L525）。** 现在补入，还是随 M1-3 修订计划时一并补入。在此之前 L525 只描述四类取消的现有映射，不含 `user-stop` 的重入抑制。

---

## 七、修复复核（2026-11-27，Kimi 轨）

> 本节由 Kimi 主会话按 `superpowers:requesting-code-review` 流程，继续委派首轮独立 `general-purpose` reviewer 复用既有上下文完成。复核过程只读，不修改实现、测试、HEAD、index 或已有评审文本；本节为复核结论的追加落档。

### 7.1 范围与判定

- **原评审 HEAD / 复核基线：** `84f622026f846242a66585c11566c4b11002fe49`
- **代码修复：** `728c7619e4`（`fix(knowledge): snapshot idle timeout and name the missing-root denial`）
- **复核 HEAD：** `8018fa417197e9a98447761bb6665a94a7b3adf4`（修复后仅有一个 docs 提交）
- **范围：** `84f622026f..8018fa4171`，聚焦 I-1、M-2、新增测试及其直接回归面，不重开已闭环的全量架构评审。
- **判定：** **修复符合预期；Ready to merge / Yes。** I-1 与 M-2 均闭环，未发现本修复引入新的 Critical、Important 或代码级 Minor。新增记录只有一条文档措辞 Nit（N-1）与一条既存边界观察（N-2），均不阻塞。

### 7.2 I-1 复核：快照、钳制与异常回落均符合首选方案

1. **读取次数已收敛。** `organizer.ts:154-170` 的 `readIdleTimeoutMs` 以 try/catch 包裹 `deps.timeoutMs()`，读取异常回落 `DEFAULT_AUTOMATION_TIMEOUT_MS` 并只告警一次；`Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 默认值` 正确处理 0、负数、NaN、Infinity 与浮点。全文件只剩创建看门狗时的一处 `deps.timeoutMs()` 调用（`organizer.ts:289`），首次 arm、touch、wake 比较及重新武装均复用同一快照。
2. **异常出口已封闭。** deadline promise 仍预挂 catch；timer 的 `wake()` 只使用快照数字与 `deps.now()`；bridge 心跳的 `touch()` 不再执行 I/O。原评审指出的 promise、timer、bridge 三条异常路径均不再暴露 `timeoutMs()` 读取异常。
3. **原看门狗语义不变。** `deps.now() - baseline >= 快照`、`noteSystemResume() = touch()` 与 `recordTerminal` 首因获胜均未改。每批在 `organizer.ts:619` 新建 deadline，因此运行中修改 `automation_timeout_ms` 从下一批生效，与自动化 `activityDeadline` 先例及更新后的实施计划一致。
4. **GLM 的严重度校准经源码核实。** Host 的未捕获异常会经 `host-process-entry.ts:49` 的 `installFailLoud` 进入 fail-loud `exit(1)`；上游 `prepareExecution` 同时会把工具监听器异常转成错误结果。该校准不改变原 Important 分级，也没有把修复前的 fail-closed 方向误写成安全绕过。

### 7.3 M-2 复核：两层缝统一处理，覆盖 read 与 `kb_org_*`

1. `policy.ts:214-232` 新增 `organizerRootDenial`，在 `tools/pre-execute`（`:146-147`）与 `tools.guard`（`:174-175`）两层入口、先于 `organizerWriteDenial` 和 `toToolCall` 执行，因此先于所有 `sessionWorkspaceRoot` 根推导。
2. 根缺失判据与 `sandbox-cwd.ts` 的 `rootOf` 一致；白名单内工具的拒绝原因包含稳定代码 `knowledge-organize-root-missing`。非整理会话经前缀判断短路，有根整理会话经根非空短路，其它意外异常仍按原路径传播。
3. 三条新增测试均具备行为判别力，而非源码文本钉：
   - 「once per watchdog」经生产 activity 注册器驱动真实 deadline，5 次心跳 + resume + 一次唤醒后只读 1 次；旧路径推算为 9 次，与 §6.3 的红测记录一致。
   - 「falls back to default」注入 EACCES，验证仍能到 followup、心跳/resume 不抛、默认 10 分钟边界超时计次且只告警一次；旧实现会在首次 arm 抛错并停在 createAgent 前。
   - 「named denial in both policy seams」使用真实 `applyPolicy` 监听器，对 write/edit/read + 三个 `kb_org_*` 共 6 个工具、3 个策略档验证结构化拒绝，覆盖原建议容易遗漏的 read 与宿主工具。

### 7.4 新增不阻塞观察

#### N-1【文档措辞 Nit】§6.2 的「所有工具」与缺根原因绑定得过宽

当整理会话仍持有 `huaanworkSessionToolAllow` 时，非白名单工具（如 `bash`）会先命中 `sessionToolAllowDenial`，得到白名单拒绝，而不是包含 `knowledge-organize-root-missing` 的缺根拒绝。代码实际保证的是**任何工具都不再因缺根抛异常，均得到结构化拒绝**；白名单内工具才保证具名缺根原因。建议把 §6.2 对应句改为「所有工具均为结构化拒绝；白名单内工具的原因含稳定代码 `knowledge-organize-root-missing`」。这是文档精度问题，不是代码缺陷。

#### N-2【既存边界观察】超大 `automation_timeout_ms` 可造成 setTimeout 截断空转

`settings.ts` 的 `parsePositiveMs` 只要求正有限数，没有上限；Node 对大于 `2^31−1` ms（约 24.8 天）的延迟会截断为约 1 ms，随后 `wake → 未超时 → 按剩余重武装` 可能形成高频空转。旧看门狗与自动化 `activityDeadline` 对同一设置已有该暴露，**不是 `728c7619e4` 引入的回归**，且需要手工设置极端值才能触发。下一轮可在 `readIdleTimeoutMs` 增加合理上限；自动化侧是否同步收口另行评估。

### 7.5 独立验证记录

以下为本轮 reviewer 实际执行，不是转述 GLM 自述：

| 验证项 | 结果 |
| --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **退出码 0**，5 个工程 |
| 六个聚焦 spec：organizer / organizer-integration / organizer-phase / org-isolation / org-tools / tool-allow | **6 files passed；118 passed / 0 failed** |
| 逐文件计数 | organizer 49、integration 23、phase 5、isolation 17、org-tools 10、tool-allow 14，与 §6.3 一致 |

本轮未重跑完整 `corepack yarn check`：原评审在 `84f622026f` 已实跑通过；此后唯一代码增量是 `728c7619e4`，已由上述 118 条聚焦测试和 typecheck 直接覆盖；其后 `8018fa4171` 为 docs-only。§6.3 所记同代码完整门禁 `GATE_EXIT=0` 与本轮证据无矛盾，但应仍归为 GLM 轨的实跑记录，不冒充本轮独立完整门禁证据。

§6.3 的三条修复前失败模式未在旧 revision 重新执行；reviewer 按旧代码路径逐条推算，确认机制与新增测试断言互洽。真机/GUI/打包应用观察仍未执行，边界不变。

### 7.6 最终评估

**是否符合预期：是。Ready to merge：Yes。**

I-1 按原评审首选的快照方案落地并封住异常路径，M-2 在两层政策缝入口统一收口且覆盖 read/`kb_org_*`，三条新增回归测试具有真实判别力。M-1 仍按 §6.4/§6.6 保持「已裁定、未实现」，必须在 M1-3 接入 `knowledge.organizeCancel` 前完成；M-3/M-4/M-5 继续留下一轮。以上事项均不构成当前 M1-2 合并阻塞。

---

## 八、实施期裁定评估与延后债务补记（2026-11-27）

> 本节经 owner 确认后补记实施期（`2da440fbf1`～`84f622026f`）的三项裁定评估结论，将此前仅停留在会话记录中的三条延后债务正式落盘，防止跨里程碑丢失。§一～§七 原文保持不动。

### 8.1 裁定 1 与裁定 2 确认

1. **裁定 1（GLM §15 的 R-1～R-3 落文后开工，`2da440fbf1`）：确认认可。**
   - R-1（fake 不创建 `wiki/` 根、按上游 `write` 行为补建 `docs/`）与 R-3（测试 5 先拨 `deps.now` 再 `noteSystemResume()`、最后推 fake timer）消除了计划正文里的字面不可实现与自相矛盾，避免 Task 5/6 返工。
   - **R-2 规格口径补认**：owner 确认接受将 `knowledge-organize-wiki-root-unwritable`（`mkdir(wikiRoot)` 失败）计入 `organize_attempts`（与未 mark 同口径，已同步至规格 L79、L418），有界且零模型成本，权限恢复后可由 `triggerManual` 清零。
2. **裁定 2（追加 `84f622026f` 闭环 failure-write 跨 `releaseAndDrain` 重入）：确认认可。**
   - 首轮修复 `bf6a6b6fb2` 仅置 `scheduleNext = false`，在生产接线 `releaseAndDrain → drainUserQueue → reevaluateKbOrganize → scheduleEvaluate` 下仍会因 `retry_after` 未落盘而无延迟连续重入、每轮消耗完整模型回合；`84f622026f` 将其落到 `zeroProgressByKb` 的进程内 1/5/3 退避（在 `startClaim` 的 `finally` 内先于 `claim.resolveLifecycle()` 武装计时器）并将单测 `releaseSlot` 夹具对齐生产同形，修复必要且闭环。
   - **微残余观察（有界、不阻塞）**：同一批内若部分文档推进或成功落盘 `retry_after`、仅剩余文档写失败，下一次重评估 `peek` 命中签名变化（`organizer.ts:578` `observePendingSignature` 先于 `isBackoffBlocked`），会清空退避并至多多跑 1 轮直到剩余文档签名稳定；不构成无限循环。

### 8.2 裁定 3 延后债务落盘（不阻塞 M1-2 合并，M1-3 接入路由前关闭）

以下三条在 M1-2 均无产品 HTTP 路由入口（`ROUTE_TABLE` 保持 92），不阻塞 M1-2 合并，统一纳入 M1-3 清债清单（与 §6.4 已裁定的 M-1 一并推进）：

| 编号 | 事项 | 位置 | 校准后的真实边界与 M1-3 处置要求 |
| :--- | :--- | :--- | :--- |
| **D-1** | `triggerManual` 在途批次的退避与状态边界 | `organizer.ts:796-806, 846-862` | `bf6a6b6fb2` 将 `waitForKbSlotIdle` 提前到 `reset` 之前，但仍留两处边界：① 在途批次以 `scheduleNext=true` 在 `resolveLifecycle()` 前同步拉起下一批，或 `releaseSlot` 触发的 `scheduleEvaluate` 先醒来占槽时，`triggerManual` 醒来仍与新批次并发 `reset`/`clearZeroProgress`；② `assertOrganizeAllowed` 仅在 `waitForKbSlotIdle` 前执行，等待期间若库进入维护/删除/recovery，醒来后无参 `triggerManual` 会清退避并静默跳过而非抛 `knowledge-base-busy`。**处置**：M1-3 接入 `knowledge.organize` / `knowledge.organizeCancel` 时，与 M-1（`user-stop` 抑制自动重启）一并收口（等待后复检 + 防止在途结束续跑插队）。 |
| **D-2** | 50 MiB 总量上限会拦截纯墓碑收缩（**待规格侧裁定**） | `org-tools.ts:267-283` | `executeMarkOrganized` 在删墓碑前即按当前磁盘总量判断 `wikiTotalBytes > totalLimit`。整理 Agent 无删文件工具，删旧卡片只能走宿主 `clearedTombstones`；一旦 `wiki/` 越过 50 MiB，连纯墓碑收缩也会被拒、形成逻辑自锁。**处置**：需规格侧拍板——建议按**扣除本次 `deletePlans` 待删卡片字节数后的预期净体积**判定（允许净收缩脱困，同时防止模型借纯墓碑批往 `topics/` 灌水绕过 50 MiB 上限），不宜简单对纯墓碑跳过上限校验。 |
| **D-3** | `autoOrganize` 从 `false → true` 未主动触发整理排期 | `host.ts:547, 640-644`；`sync-engine.ts:408-413, 1833-1852` | `host.update` 的 `finally` 仅在 `rebindSucceeded && updateSucceeded` 时调 `notifyOrganizerPending(kbId)`。**重要纠偏**：`sync-engine.ts` 的周期对账经 `canRunBackgroundSync` 跳过 `watchPaused=true` 的库，而 `watchPaused=true` 不阻断阶段 2 整理（`host.ts:766-779`），因此「靠 ≤300s 周期对账兜底」**仅在 `!watchPaused` 时成立**；暂停监听下打开自动整理无周期兜底，且未暂停监听时用户打开开关干等最多 5 分钟也反直觉。**处置**：M1-3 接入 `knowledge.update` 路由与前端开关时**必须**补齐 `autoOrganize: false → true` 后的 `notifyOrganizerPending(kbId)` 及回归测试。 |

其余代码评审残余沿用 §三、§六、§七 记录：M-1（已裁定，M1-3 接 `knowledge.organizeCancel` 前必落）、M-3/M-4/M-5、N-2（超大 `automation_timeout_ms` 截断上限）及计划评审 R-4（真机休眠唤醒先后时序）。

---

## 九、全面质检校准与补修记录（2026-11-27）

> 本节记录对分支 `feat/knowledge-base-m1-2-single-slot-organizer`（基线 `285d5215ff`）全量源码质检新发现 3 项（Q-M1、Q-N1、Q-N2）的反证校准、补修提交（`34cd621246`）与完整无头门禁复验。§一～§八原文保持不动。

### 9.1 反证校准结论

| 编号 | 校准结果 | 源码与上游反证依据 | 补修落点（`34cd621246`） |
| :--- | :--- | :--- | :--- |
| **Q-M1** | **属实（Minor）**；修法落点校准 | 上游 `deepseek-harness/packages/core/agent-loop/src/inbox.ts:112` 在 `followup()` 认领时必发 `agent/inbox/claimed`；`makeResultPresentClaimed`（`result-artifact-tools.ts:228`）与 `makeExpertTeamClaimed`（`expert-team-dispatch.ts:224`）均直接调用 `turnAnchors.notePreStep`，绕过 `installTurnAnchorHooks` 写入 256 条 LRU，且 `session/disposed` 跳过整理槽清理导致常驻占槽。**落点校准**：不能直接在 `createTurnAnchorStore` 内拦整理槽，否则破坏既有 `TurnAnchor['origin'] = 'knowledge'` 契约测试（`knowledge-org-isolation.spec.ts:221-226`）。 | 在 `makeResultPresentClaimed` 与 `makeExpertTeamClaimed` 对 `isKbOrganizeSessionId(sessionId)` 跳过 `notePreStep`，同时保留 `wantAttached = false` 的 fail-closed 附件摘除语义。 |
| **Q-N1** | **属实，且严重度升格（Nit → Minor）** | 上游 `deepseek-harness/packages/core/agent-loop/src/agent.ts:368-374` 证实：`limits.ts:123` 调用 `agent.cancel({ kind: 'parent' })` 命中 `abortedCancelCause` 后直接 `throw error`、**不调用 `this.throwError()`、不发 `agent/error`**，`kick()` 吞掉异常后 `whenIdle()` 正常 resolve。此前以为 `agent/error` 会补回错误并不成立：不仅宿主侧经 `huaanworkEmit` 外泄多余 `session/end`（仅客户端 `App.tsx:2316` 兜底），更会在「本批文档已 mark 完、后续改写索引连续 3 次同参失败被强杀」时因缺失 `firstModelError` 误结算为 `organize_completed`，或丢失真实中止原因。 | `limits.ts` 的 `emitStop` 识别 `isKbOrganizeSessionId(sessionId)` 后不发 `huaanworkEmit`，改为直接调用 `noteKnowledgeOrganizerError(sessionId, reason)`。 |
| **Q-N2** | **属实（Nit · 策略层纵深加固）** | ① `wiki/` 内存在悬空目录符号链接（`wiki/sub -> outside/missing-dir`）时，写入 `sub/escape.md` 在 `policy.ts` 叶 `lstatSync` 得 `ENOENT` 放行，在 `paths.ts` `resolveInside` 因 `existsSync` 越过悬空段退回 `wiki/` 返回 `allow`（尽管 POSIX `fs-local` `mkdir` 随后报 `EEXIST` 不致越界写）；② macOS 下 `tmpdir()` 为 `/var/folders/...` 而 `realpath` 为 `/private/var/folders/...`，访问规范临时路径未命中 `REASON_ORGANIZER_TEMP`（由 `decide.ts` 拒为 `REASON_PATH_ESCAPE`），且规范库根配原始 tmpdir 前缀的库内路径会被误拒为临时目录。 | `policy.ts` 的 `organizerWriteDenial`：① 对 `tmpdir()` 与 `root` 做规范别名对齐（不跟随 `wiki/` 内链接）；② 对库内目标自 `root` 向下逐段 `lstatSync` 拦截中间悬空目录链接与叶链接。 |

### 9.2 回归测试（先红后绿）与门禁复验

四条新增判别性测试均先观察到预期失败，再随 `34cd621246` 全部转绿：

| 新增测试 | 修复前（实跑 RED） | 修复后（实跑 GREEN） |
| :--- | :--- | :--- |
| `knowledge-org-isolation.spec.ts`「agent/inbox/claimed handlers skip turnAnchors LRU writes…」 | `notePreStep` 对 `huaanwork-kb-org-kb1` 被调 2 次，整理槽写入 LRU | `notePreStep` 0 调用、`current(ORG_SESSION) === undefined`，`s1` 不被淘汰，双附件仍 fail-closed 摘除 |
| `knowledge-org-isolation.spec.ts`「limits routes organizer repeated-failure stops…」 | 经 `huaanworkEmit` 发出 `session/end`，`orgErrors` 为空 | `emitted === []`、`orgErrors === ['same tool and key args failed 3 times']`；正对照普通用户仍发 `session/end` |
| `knowledge-tool-allow.spec.ts`「cannot write through a dangling directory symlink…」 | `write ask pre-execute` 返回 `allow` | `ask`/`smart`/`full` 下 `write`/`edit` 在两层缝均返回 `deny`（原因含 `符号链接`） |
| `knowledge-tool-allow.spec.ts`「aligns canonical tmpdir aliases without false-denying…」 | 规范 tmpdir 路径落入 `路径越出当前工作区` 而非 `临时目录` | 规范 tmpdir 库外路径在两层缝命中 `临时目录`；`realWiki` + raw tmpdir 库内路径放行 |

- **聚焦复验：** 8 个相关 spec（`knowledge-org-isolation` 19、`knowledge-tool-allow` 16、`policy.cordis` 36、`limits-goal` 2、`result-artifact-tools` 22、`expert-team-dispatch` 11、`knowledge-organizer` 49、`knowledge-organizer-integration` 23）共 **178 passed / 0 failed**；`corepack yarn workspace dsh-plugin-huaanwork typecheck`（5 工程）退出码 0；`git diff --check` 与 `node scripts/check-whitespace.mjs` 退出码 0。
- **完整门禁：** 独立执行 `corepack yarn check`（输出重定向显式记录退出码）→ **`GATE_EXIT=0`**；全仓 Vitest **5786 passed / 15 skipped / 0 failed**（`dsh-plugin-huaanwork` 5039 passed，较 §6.3 的 5782 正好 +4），全部 15 个 `node:test` 套件 `# fail 0`，`verify-layout` / `verify-runtime-closure`（316 nodes）/ `verify-bundled-runtime`（150 files）/ `verify-profile-boot` ×2 / `verify-licenses` / `verify-operation-reliability` 全部通过。
- **合并评估：** **Ready to merge（Yes）。** Q-M1、Q-N1、Q-N2 全部闭环；剩余 M-1、D-1、D-2、D-3、M-3/M-4/M-5、N-2 及真机项 R-4 均已落盘并按原定里程碑边界承接。

---

## 十、合并前最终复核与 IMP-1 补修（2026-11-27）

> 本节由主会话按 `superpowers:requesting-code-review` 派发独立 `general-purpose` reviewer 对 HEAD `7768438714` 做合并前最终复核后追加；关键发现经主会话独立反证（源码证据链 + 库外物理 demo），IMP-1 按 owner 裁定当场红绿补修。§一～§九原文保持不动。

### 10.1 复核范围与判决

- 范围 `5fc019eddf..7768438714`（16 提交 / 46 文件 / +10663 −94），最后代码提交 `34cd621246`；master 无漂移（仍停在 merge-base）。
- Reviewer 五轮 pass（已闭环边界 / 补修新鲜眼 / 全范围对照计划与规格 / 延后债务边界 / 测试覆盖静态评估），全程只读、未实跑；判决 **With fixes：0 Critical / 1 Important（IMP-1）/ 1 Minor（MIN-1）**。
- 已闭环项 I-1 / M-2 / Q-M1 / Q-N1 / Q-N2 逐条读码复核**维持**；延后债务边界核实：M-1 / D-1 / D-3 产品面不可达成立（ROUTE_TABLE=92、无 organize 路由、无生产 `user-stop` / `triggerManual` 调用方）；**D-2 确认可经自动整理链路到达**（write 工具无全库总量闸，模型可经 `topics/` 灌水越限后连纯墓碑收缩也被拒），其延后依据是「待规格裁定」而非不可达，§八表述诚实；M-3/M-4/M-5、N-2、R-4、§8.1 微残余维持。

### 10.2 IMP-1：符号链接 + `..` 物理穿越越界写（Important，已修复）

**形态：** `wiki/` 内一条**已存在**、指向平台临时区已存在目录的目录符号链接 `sub`，模型发 `write`/`edit` `{file_path:"sub/../evil.md"}` → 两层策略缝放行 → 文件真实写进临时区。read/glob/grep 同形条件性越界读/列目录（折叠后库内路径存在时）。

**主会话独立反证（源码 7 环 + 2 个库外 scratch demo，全部坐实）：**

1. 桌面词法折叠：`policy.ts:268` 与 `paths.ts:24` 均 `path.resolve`，`sub/..` 折成库内 `evil.md`；`hasSymlinkSegment` 在折叠后路径上逐段 lstat，永远看不到 `sub`（ENOENT → 放行）；decide 的 `resolveInside(forWrite)` 同折 → allow。
2. 上游原始拼写直传：`tool-fs/write.ts:118` 把原始 `file_path` 交 `ctx.fs.resolve`；`fs-local/index.ts:135` 交 `resolveLocalTarget`。
3. `fsio.ts:148`：POSIX 下含 `..` 段保留物理拼写（不折叠）。
4. `fsio.ts:18`：`realpath = promisify(realpathCallback.native)` —— **native** realpath 物理穿越（特意核实非会词法折叠的 JS 版；`roots.ts:32-35` 注释同证）。
5. Demo ①：纯拼接原始拼写 `wiki/sub/../evil.md` 内核写入 → **库外落点存在、折叠落点不存在**；Demo ②：`realpathSync.native(wiki/sub/..)` = 库外目录 → 目标缺失时祖先回退分支 targetKey 落库外。（首轮 demo 误用 `path.join` 先折叠得出相反结论，改纯拼接后坐实——反证本身经两次校准。）
6. `fs-local/index.ts:236`：`writeFileAtomic(target.targetKey)` 按物理落点写。
7. `roots.ts:54`：workspace-write 可写根 = workspaceRoot + `/tmp` + `tmpdir()`（canonical）；`fs-sandbox/index.ts:132-143` `checkedTarget` 按 canonical targetKey 判包含 → 临时区落点放行，**写真实成功**。

**与 Q-N2 的区别：** 悬空链接形态被上游 `FsError`（`missing.includes('..')`）/mkdir 挡住，未产生真实越界写（Nit）；本形态写实际成功，且恰好绕过 `34cd621246` 新增的逐段 lstat 防线本身。

**严重度校准：** Important（合并前修）。前置链接整理 Agent 自身造不出（白名单无 symlink 能力，write/edit 只产常规文件，宿主只 mkdir/删登记文档），需用户/外部进程预先植入；落点被上游沙箱限制在临时区而非任意用户目录——与计划评审 I-9 同级。按字面「安全边界 fail-open」口径可升 Critical，修复动作相同且立即。

### 10.3 补修（红绿闭环）与 MIN-1

**修法（`policy.ts` +34/-3）：** 新增 `organizerParentTraversalDenial`——整理槽 fs 路径参数键（`path/file/file_path/root`，与 `pathsAreInside` 同集合；`WRITE_PATH_KEYS` 更名 `FS_PATH_KEYS`）的**原始拼写**含 `..` 段（`/[\\/]/` 两种分隔符）直接具名拒绝 `REASON_ORGANIZER_PARENT_TRAVERSAL`；两层缝（pre-execute + guard）先于 `organizerWriteDenial` 执行。整理提示词只要求 wiki 根相对下行路径，`..` 无合法用途；普通会话与 `kb_org_*`（无路径字符串参数）零影响。

**新增 2 条判别测试（先红后绿，`knowledge-tool-allow.spec.ts` +51）：**

| 测试 | 修复前（实跑 RED） | 修复后（实跑 GREEN） |
| --- | --- | --- |
| 已存在目录链接 + `sub/../evil.md`（含反斜杠拼写）write/edit 三档两层缝 + 库内合法写正对照 | `allow` | deny（原因含「下行路径」），正对照 allow |
| read/read_file/glob/grep `..` 段（折叠后库内路径真实存在）三档两层缝 | `allow` | deny（原因含「下行路径」） |

**MIN-1（Minor，不阻塞，留下一轮硬化波）：** `isSymlinkOrUnreadable` / `hasSymlinkSegment` 对非 ENOENT 的 lstat 错误（ENOTDIR/EACCES）也返回「符号链接」拒绝文案；方向 fail-closed 正确，仅模型-facing 原因失真。已登记 AGENTS.md 债务表。

### 10.4 验证记录（主会话实跑，退出码显式落盘）

| 验证项 | 结果 |
| --- | --- |
| 修复前 HEAD `7768438714` 完整 `corepack yarn check` | **GATE_EXIT=0**；Vitest 5786 passed / 15 skipped / 0 failed；15 node:test 套件 `# fail 0`（`/tmp/huaanwork-m1-2-merge-gate-7768438714.log`） |
| 修复后聚焦 6 spec（tool-allow / org-isolation / policy.cordis / organizer / integration / org-tools） | **155 passed / 0 failed**（tool-allow 18 含 2 新） |
| 修复后 `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **退出码 0**（5 工程） |
| 修复后完整 `corepack yarn check` | **GATE_EXIT=0**；Vitest **5788 passed / 15 skipped / 0 failed**（dsh-plugin-huaanwork 5041 = 5039+2）；15 node:test 套件 `# fail 0`（`/tmp/huaanwork-m1-2-imp1-gate.log`） |
| 真机 / GUI / 打包应用整理槽观察 | **未执行**，边界不变（M1-3 / 发布验收） |

**门禁通知异常记录：** 修复后门禁的首个后台完成通知为误报（当时日志 1761 行、无 `GATE_EXIT`、进程存活且日志增长）；以落盘标记 + 进程状态为准，Monitor 独立捕获 `GATE_EXIT=0` 后方采信。两次门禁均未与其它含 `verify:aa` 的命令并发。

### 10.5 合并评估更新

**Ready to merge：Yes。** IMP-1 闭环后 0 Critical / 0 Important 开放；MIN-1 与既有延后债务（M-1 / D-1 / D-2 / D-3、M-3/M-4/M-5、N-2、R-4）按原定里程碑承接：M1-3 接 `knowledge.organize*` / `knowledge.update` 路由前关闭 M-1 / D-1 / D-3，D-2 待规格裁定（建议净体积判定），R-4 归真机。真机验收边界不变，不以无头门禁替代。
