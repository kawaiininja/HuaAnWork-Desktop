# HuaAnWork 子代理运行可观测性实施计划评审（plan review）

- 日期：2026-10-27（首轮意见同日会话内出具，本文为完整复核后的落档版）
- 轮次：首轮评审（§1–§5，针对计划 1042 行版）→ kimi 按评审修订（1220 行版）→ 第二轮复评（§6，含 F-6 误报撤销；**最新结论以 §6.4 为准**）
- 评审对象：`docs/superpowers/plans/2026-10-26-subagent-run-visibility.md`（实施计划）
- 对照基准：`docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md`（设计，909 行，含 GSTACK 两轮评审记录）；代码锚点全部在当前工作树实测
- 评审方法：完整读取两份文档全文；对计划引用的关键符号、fixture、脚本、断言在代码库逐项核实（ROUTE_TABLE/RouteError/RouteRequest、sendToAgent/dispatchAt、AgentPackageActiveTurnRecord/cancelTurn、skills.ts startParent ALS、bridge mapTokens、App.tsx send/tick/ContentChatItem、holders 注入面、sessions.spec activationSpecs/makeRouteCtx、agent-confirm-card.spec jsdom 先例、route-contract 69 计数断言、gen:styles 脚本、tsconfig ES2024 等，抽查全部命中）
- 边界：仅评审意见。未改动计划、设计或任何代码；本文档经用户明确授权落档

## 1. 复核结论摘要

首轮评审出具 2 Major / 1 Moderate / 5 Minor / 4 观察项。本次复核完整重读两份文档全文并重验全部代码锚点，逐条核对结论：

| 编号 | 首轮结论 | 复核结果 |
| --- | --- | --- |
| F-1 | legacy 定向取消的 confirmCleanup 调用点未闭环，stopping→stopped 无断言 | **成立并加强**：B-03（启动中取消）子路径在任何读法下都无收敛机制（§2.1） |
| F-2 | registry 缺 stopping 吸收态与终态下清理告警规则 | **成立**；补归属澄清：error-after-latch 设计侧同样未枚举（§2.2） |
| F-3 | D2 终态仲裁缺「end 先到」顺序用例 | **成立**；反向顺序还隐藏一处未钉死的语义张力（§2.3） |
| F-4–F-8 | 5 项 Minor（命名漂移 / 69→71 计数断言 / 未启用包用例不可达 / Task 12 定向清单不全 / A-08 真机核对缺失） | 首轮复核判定「全部成立」；**F-6 后经第二轮复评撤销为误报（§6.2）**，其余四项成立（§2.4–§2.5、§2.7–§2.8） |
| 观察 1–4 | WS 断连接线 / mint 会话 sessionId / 轮询形态 / 内部 id 上 wire | 全部成立（§3） |

复核**新增 2 项 Minor**：F-9（Task 4 测试轮询跨不过真实 I/O 宏任务边界）、F-10（lastActivity 的 Host 侧语义未钉、§10 registry 行必测项未落实）。

**未发现误报或夸大**。两处措辞按 §2.1/§2.2 的精确口径校准：F-1 区分「任何读法下都断」与「歧义」两类子路径，并注明 Task 12 真机验收会兜底暴露（风险形态是返工与语义歧义，不是静默带病上线）；F-2 注明设计文档本身也只显式保护 completed-after-latch，缺口应双侧闭环。

> 第二轮更正：上述「未发现误报」只对当时已核验的发现成立；F-6 在第二轮复评中经补核 host.ts:497-519 的 dispatch 入口校验后**撤销为误报**（§6.2）。

## 2. 发现明细

严重度定义：Major = 计划层必须先修订再动工（会造成核心语义返工或不可捕获的错误行为）；Moderate = 设计必测场景在计划中缺失；Minor = 实施对应任务时顺手订正。

### 2.1 F-1（Major）legacy 定向取消的 confirmCleanup 调用点未闭环

证据链：

1. Task 4 Step 3 的 attachCancel 闭包（plan:482-486）只做 `controller.abort()` + `activation.dispose()`，不调用 `confirmCleanup`。
2. 全任务唯一提及 confirmCleanup 的句子（plan:489）挂在 afterIdle 语境里：「到期调用 `noteCleanupBudget(...)`，dispose 结束后调用 `confirmCleanup({ok,warnings})`」——该 confirmCleanup 属于超时分支还是一般 afterIdle 流程，文本歧义。
3. **决定性证据（B-03 子路径任何读法下都断）**：`afterIdle` 只在 dispatchAt 成功返回后赋值（sessions.ts:231），finally 里的 `scheduleDetachAfterIdle()` → `cleanup()` → `await afterIdle?.()` 在 dispatchAt 抛错时是空操作（afterIdle === undefined）。启动中取消（activation 从未发布、dispatchAt 按取消收尾抛错）路径上 afterIdle 永不执行——无论第 2 点的句子怎么读，该子路径不存在任何 confirmCleanup 调用点。
4. registry 无「cancel 闭包完成即自动确认」语义：Task 2 测试（plan:234-237）在闭包 resolve 后仍需显式调用 `confirmCleanup` 才转 stopped。
5. 测试无收敛断言：Task 4 Step 1（plan:414-442、445）止步于 accepted / disposeCalls / clientMessageId / 无 unhandled rejection，不验证 phase 收敛到 stopped。

设计依据：§5.2 legacy 的 stopped 确认条件（design:193）、B-01/B-03/B-05（design:473-477）。缓解：Task 12 Step 3 第 2 项（plan:1002）真机核对 accepted→stopping→stopped 会在验收期暴露不收敛——因此风险形态是「核心语义返工 + 歧义」，不是静默上线；但按仓库计划精度标准， Major 成立。

处置：Task 4 明确四种路径（activation 已发布的取消、从未发布 activation 的取消、正常 afterIdle、超时 afterIdle）各自的 confirmCleanup 调用点；补 legacy stopping→stopped 断言（含 B-03 分支）。

### 2.2 F-2（Major）registry 终态交互规则族不完整

Task 1 Step 3 实现要求（plan:192）只规定了「`confirmCleanup({ok:false})` 在 stopping 下保持 stopping」，未规定：

1. **stopRequestedAt 已 latch 时 settleResult(error/max-tokens/refusal) 是否允许退出 stopping**。Task 2 只测了无停止意图的 aborted→stopping（plan:246-250）。
2. **failRun 在 stopping 下的行为**——而 Task 5 把 `activation.result` rejection 无条件接给 failRun（plan:564-567）。用户定向取消 + 底层 rejection 的组合会把「用户主动停止」的卡片显示成「失败」，与 D3/B-05 的预期路径（stopping → confirmCleanup → stopped）冲突；该场景不在 Task 5 Step 1 覆盖清单（plan:515）内，真机也不稳定可复现——**不被任何门禁捕获**，支撑 Major。
3. **confirmCleanup({ok:false}) 落在已终态（completed）run 上的行为**。Task 5 的 cleanup() 在 idle 路径也会调 confirmCleanup（plan:570-577），completed+清理失败真实可达；设计 §5.5/D10 有「清理告警不篡改执行结果」规则（design:254、337），但计划 registry 契约未承载。Task 9 的客户端测试「completed + cleanup warning 不变成 failed」用手工构造的 projection，钉不住 Host 行为。

归属澄清：设计 §5.2 补充规则（design:186）与 B-07（design:479）也只显式保护「completed 不覆盖停止意图」，error-after-latch 属于设计同样未枚举的情形。计划作为实现契约本应钉死（Task 5 自己接了 rejection 路径使其可达），同时建议把该规则反馈一行进设计文档，避免两侧漂移。

处置：Task 1 registry 契约补规则族——stopping 下 failRun/settleResult(非 completed) 不退出 stopping（信息进诊断字段）；终态下 confirmCleanup(ok:false) 只追加 warning 不改 phase。

### 2.3 F-3（Moderate）D2 终态仲裁缺「end 先到」顺序用例，且隐藏未钉死的语义

- 设计 §10 终态仲裁行（design:430）明确要求「result=completed 与 end=error 双到（**两种到达顺序各一**）」，设计 GSTACK T1 Verify（design:752）同样写明。计划 Task 1 样例只有 result 先到（plan:87-88），补充断言段（plan:97-112）与 Task 1 Verify（plan:194-197）均无反向顺序。
- 反向顺序非平凡：end(error) 先到时 registry 是否立即定 failed？设计 §5.2「先到者生效」（design:184）与 D2「只有 result 缺席（rejection）时才由 end…单独定终态」（design:185）在「result 尚未到达但会到达」情形下张力未解。该用例正是强制钉死语义的机制；缺失它，两种相反实现都能过现有测试。

处置：Task 1 补反向顺序用例，并写明 end-先到（result 在途）时是否定终态、result 后到是否翻转。

### 2.4 F-4（Minor）符号命名漂移

Task 4 Step 3 定义 `subagentRunIdOf()`（plan:457-458），Task 6 Interfaces 声明消费它（plan:600），但 Task 6 Step 3 正文写 `legacyRunIdOf(args[0]) ?? pkg?.runId`（plan:628）。同一符号两个名字，子代理实施可能新建第二个函数或类型报错。

### 2.5 F-5（Minor）「69→71」不止注释

Task 3 Step 3 只说「将契约注释中的 69 方法更新为 71 方法」（plan:385），但 route-contract.spec.ts 有硬断言：`:368`（`双端方法总数恰好 69 且集合完全一致`）与 `:372-373`（`toBe(69)`）。只改注释则 Task 3 Step 4 必红。计数断言正是该文件的守卫语义，应写明同步更新。

### 2.6 F-6（Minor）「未启用包」用例描述与代码路径不符

> **2026-10-27 第二轮复评撤销：本条为误报，证据见 §6.2**（host.ts:514 的 enabled 校验恰在 `dispatch()` 入口内，直接以禁用包 detail 调用 dispatch() 的 fixture 可达）。以下为首轮原文，仅留档。

Task 5 Step 1「未启用包用例：dispatch() reject 后 phase 为 failed」（plan:529）。未启用（findInvocable miss）在 agent-invoke.ts:123-135 就被分流走 legacy 目录查找，**到不了** package dispatch()；能到达 dispatch 内抛错的是撤销复验（assertRunnable）、persona 组装等校验失败。意图（begin 后失败须 failRun、不留永久 starting）正确，触发面描述会误导用例编写。

### 2.7 F-7（Minor）Task 12 Step 1 定向清单不全

清单（plan:978）缺 `agent-package-runtime.spec.ts` 与 `agent-package-catalog-security.spec.ts`——两者都是 Task 5 修改（plan:507）并运行（plan:583）的文件。Step 2 全量 `corepack yarn test` 兜底，但「定向串行」清单应与修改面一致。

### 2.8 F-8（Minor）A-08 的短预算真机核对未列入 Task 12 Step 3

设计 A-08（design:461）要求「通过注入短预算验证提示」；Task 12 Step 3 六项（plan:1000-1006）无收尾预算超时场景，Task 9 仅有客户端单测（plan:769）。可行性注记：legacy 预算是常量、package 是构造参数，真机注入需要调试钩子，计划未提供注入手段——若判定不可行应显式标 Blocked（E-06 诚实原则），而不是静默省略。

### 2.9 F-9（Minor，复核新增）Task 4 测试轮询跨不过真实 I/O 宏任务边界

Task 4 Step 1 用 20 次 `await Promise.resolve()` 轮询 registry.begin（plan:427-431）。但 sendToAgent 在调用 dispatchAt 之前 `await readHuaanworkSettings(routeCtx.profileDir)`（sessions.ts:131），后者是真实异步文件 I/O（settings.ts:294-297 `await readFile`，ENOENT 也走宏任务）。微任务轮询永远观察不到 begin，测试会稳定死在 `assert.ok(runId)`。建议 `vi.waitFor` 或 setImmediate 轮询。失败响亮、TDD 即刻暴露，故 Minor。

### 2.10 F-10（Minor，复核新增）lastActivity 的 Host 侧语义未钉、必测项未落实

设计 §10 registry 行把 lastActivity 列为必测（design:428），§5.5 规定「start/end/cancel/snapshot 不算执行活动、只由选中 child 的 token/reasoning/tool 活动更新」（design:248）。计划 Task 1 测试（plan:70-112）与实现要求（plan:192）均未承载该规则；Task 9 的无活动提醒只在客户端消费字段值，钉不住 Host 侧写入语义。

## 3. 观察项（不要求修订计划，实施时留意）

1. **WS close → disconnect 接线**：Task 8 有 `'disconnect'` action、Task 10 有 `frozenAt` prop，但 close 事件 dispatch 的接线未在 Task 11 明写（只写了 ready 后对账，plan:944）。
2. **mint 会话的 reconcile sessionId**：`session.send` 未显式传 sessionId 时（App.tsx:1922），reconcile 须用**应答**返回的 sessionId（sendToAgent 恒返回 `{queued, sessionId}`，sessions.ts:114）；当前客户端不捕获应答（App.tsx:1920-1924）。「捕获的 chatId + sessionId」应明确 sessionId 取自应答。
3. **两种轮询形态可用性不同**：Task 5 的 stopped 轮询（plan:522-524）在纯 promise 链上，微任务轮询可用；Task 4 的不可用（见 F-9）。形似而实异，勿复制。
4. **内部 id 上 wire**：`SubagentToolActivity` 携带 registry 内部 `id`（plan:129）用于稳定排序——可接受，属契约面新增暴露，实施时保持字段最小。

## 4. 已核实为扎实的部分（复核抽查全部命中）

- **执行链现状与计划描述一致**：legacy 匿名 AbortController（agent-invoke.ts:256）、afterIdle 600s（:276-295）、clearLegacyRequest（:303）；包路径 AgentPackageActiveTurnRecord（host.ts:105）、cancelTurn(reason)（:778，`'cancel'` 合法，:95）、pendingTurns/cancelGate/cleanupFailures: Error[]（:335/:563/:601）、预留 childId 与 provider-fallback 重绑（:890-895/:938-945）。Task 5「不得覆盖现有 registry」警告真实必要（dispatch 内确有 `registry.bind`，host.ts:897）。
- **契约面**：ROUTE_TABLE/RouteError(status,code,message)/requireRuntime（routes.ts:476/:137/:168）、`RouteRequest = {params, body, query}`（:108-112）——Task 3 直接调 handler 的测试形状与真实签名一致；api.ts `get(path, objectQuery)`/`post(path)` 惯例（:25-26）成立。
- **guardrails**：startParent ALS 先例（skills.ts:134）与 startActivation 包装同步读 pkg/legacy spec（:306-316）；bridge mapTokens(ctx, sessionId, purpose, …)（:82/:177）、tools/execute、session/event、agent/status|error 分支全部存在。
- **客户端**：App.tsx send 的 `at: { name }`（:1923）、userMsg.id（:1901）、共享 1s tick（:1420）、ContentChatItem Exclude（:3338）、showTurnLine（:565）；eventTargetTab/pendingSessionId（outcomeCheck.ts:280-294）；agent-confirm-card.spec 的 jsdom createRoot+act 先例（:1-35）；gen:styles 脚本、tsconfig ES2024（findLastIndex 可用，profile.ts:554 先例）。
- **对设计的覆盖**：R1–R4、D2/D3 裁定、24 项 §6.1 设计决策、§7 竞态表、§9 安全边界、§11 非目标均映射到具体任务；验收追踪表（plan:1025-1038）逐行对得上。Task 5「result 超时只 noteCleanupBudget、不进 cleanupFailures」与现状一致（host.ts:726-733 注释明言不进），不改变既有语义。
- **仓库纪律**：修改面全部落在 huaanwork 专属前缀内，「不新增 variant 白名单」结构上成立；root 门禁串行约束正确回应 verify:aa 并发 flake 既有债（plan:992 还写了复跑纪律）；提交步骤全部由用户显式触发；Task 12 对真机验收与 Blocked 标注诚实（E-06 对齐）。

## 5. 结论与处置建议

> 本节为首轮时点结论，处置建议已被 §6.4 的第二轮结论取代（F-1/F-2/F-3 已在修订版闭环、F-6 已撤销；剩余设计同步与一条小测试补漏见 §6.3/§6.4）。

计划与设计、代码基线的对齐度在抽查的全部锚点上成立，任务编排（Tasks 1–3 契约 → 4/5 + 8–10 并行 → 6/7 接线 → 11 → 12）与设计评审的 lane 划分一致，可作实施基线。

建议处置顺序：

1. **动工前**在计划层闭环 F-1（legacy confirmCleanup 四路径 + B-03 断言）与 F-2（registry 终态交互规则族），补 F-3 反向顺序用例并钉死 end-先到语义——合计约一页计划文字与三组测试断言。
2. F-2 的 error-after-latch 规则建议同步反馈一行进设计文档 §5.2，避免计划与设计漂移。
3. F-4–F-10 在对应任务实施时顺手订正（F-5 若漏改会在 Task 3 Step 4 响亮失败；F-9 同理）。
4. 完成第 1 项前，不宜宣布计划评审通过。

## 6. 第二轮复评（2026-10-27，kimi 修订后）

- **复评对象**：计划更新版（mtime 2026-10-27 09:17，1042→1220 行，+178）；设计文档未改动（mtime 2026-10-26 22:46）。
- **方法**：全文重读更新版；对全部新增内容做逐段语义核验与内部一致性检查；补核三处此前未读的代码锚点（host.ts:497-519 dispatch 入口校验、api.ts:216-232 `socket.onclose`/`onSidecarExit`、api.ts:13 计数注释）。本节先经用户要求的「复评再 double check」：对复评本身的结论反向验证后，撤销一处复评沿用的首轮误报（§6.2）；后续核对又订正了本节的生产路径、测试覆盖与 teardown 顺序表述，主体闭环结论不变。
- **边界**：仍仅评审意见；本轮未改动计划与设计。
- **后续订正（2026-10-27，kimi）**：修正 §6.2 对禁用包生产分流的解释、§6.3 的遗留清单与动工前顺序、§6.4 的 rejection 测试覆盖声明及 dispose/result 顺序；这些订正不改变 F-6 撤销和核心方案无需返工的结论。

### 6.1 处置核对：§2 的 9 项真实发现全部闭环（多处超出建议）

| 发现 | 复核 | 锚点（更新版行号） |
| --- | --- | --- |
| F-1 legacy confirmCleanup | **闭环，超建议**：新增 `cleanupLegacyRun(mode)` 显式共用四条路径；B-03 子路径专门覆盖「startActivation reject → failRun → 无 activation 清理 → confirmCleanup」，并明写「dispatchAt 抛错时该闭包（afterIdle）根本不会发布」——正是 §2.1 的决定性证据；测试补 `phase === 'stopped'` 断言与「不得仍等待 afterIdle」 | plan:599-604、651-660、592 |
| F-2 registry 终态规则族 | **闭环，超建议**：新增 `rejectResult` API（与 settleResult/failRun 三分，且明确「不得把 result rejection 送进只表示启动/外层失败的 failRun」）；完整规则族含「confirmCleanup(ok:true) 须看到执行已终结」「定向闩吸收 completed/error/max-tokens/refusal/aborted/rejection/failRun」「预算路径收到权威 completed 则按自然结果定 completed」「终态下 ok:false 只追加 warning 不改 phase」；Task 5 补「定向取消后 result rejection 不得提前 failed」用例 | plan:141-193、328-338、649、686、736-742 |
| F-3 D2 双顺序 | **闭环**：end 先到（保持 finalizing、不写 endedAt、不先发布 failed）与 result 先到两用例，另补 rejection 双顺序；语义钉死「end 先到只存候选、resolved result 到达后再定终态」 | plan:97-136、332-333 |
| F-4 命名漂移 | 闭环：统一为 `subagentRunIdOf` | plan:803 |
| F-5 69→71 | 闭环：写明注释、计数测试名与两端 `toBe(69)` 硬断言同步更新，并覆盖首轮评审漏查的 api.ts:13 计数注释 | plan:536 |
| F-7 Task 12 定向清单 | 闭环：补 `agent-package-runtime.spec.ts` 与 `agent-package-catalog-security.spec.ts` | plan:1155 |
| F-8 A-08 | **闭环，超建议**：诚实 Blocked 条款（真机无受控注入通道时明确标 Blocked、不冒充通过）之外，Task 4 加 `vi.useFakeTimers()` 短预算 afterIdle 用例、Task 5 加 `cleanupTimeoutMs: 20` 集成用例 | plan:604、702、1183 |
| F-9 轮询 | 闭环：`vi.waitFor`（vitest 4.1.8 实测支持）；并明记 Task 5 微任务轮询只适用受控 Promise 链、不得复制到 Task 4 的 `readHuaanworkSettings` 启动路径 | plan:579-582、700 |
| F-10 lastActivity | 闭环：专属用例（含 childIdle/绑定/结算/snapshot 不刷新）+ 实现要求完整写入边界 | plan:199-224、337 |
| 观察 1–4 | 全部吸收：WS close 经 `onSidecarExit` 接线（`socket.onclose` 恒以 `{ready:false}` 触发 exitHandlers，api.ts:216-218；handler 参数名即 `state`，api.ts:230——计划措辞 `state.ready === false` 与既有签名逐字一致）；`session.send` 应答捕获与 `sent.sessionId` 规则（含 mint 失败不得拿 undefined/active tab 顶替）；轮询边界注记；内部 id 保持字段最小 | plan:1119-1121 |

### 6.2 本轮纠错：撤销 F-6（首轮误报，复评一度沿用）

首轮 F-6 称「未启用包到不了 `dispatch()`、用例描述不可达」——**误报，予以撤销**。决定性证据同时覆盖生产路径与直接调用路径：`findInvocable` 对**已停用/已损坏的本地包也返回详情**，其 miss 判据是 `detail === undefined`，不是 `!pkg.enabled`（host.ts:487-495）；`dispatchAt` 在详情存在时随即调用 package dispatch（agent-invoke.ts:123-132）；`dispatch()` 入口再以 `if (!pkg.enabled) throw new Error('智能体「${pkg.slug}」未启用或不存在')` 拒绝（host.ts:497、:514）。因此生产分流与计划中直接以禁用包 detail 调用 `dispatch()` 的测试都能到达该校验，用例按计划字面可写、无需改道。

误报根因（留档防复发）：首轮把 `findInvocable` 误读成会过滤禁用包，并从错误的过滤假设外推「dispatch 无 enabled 校验」；首次复评沿用该判断时仍未完整阅读 dispatch 入口。此前写下的「生产路径确实不把禁用包送进 dispatch」同样是错误表述，本次一并订正。教训：断言「某路径不可达」前必须同时核实分流函数与目标函数自身的入口校验。kimi 不采纳 F-6 是正确的处置。

### 6.3 遗留：设计同步与一条 rejection 测试补漏

设计文档未随计划修订。计划新钉死的「`settleUpstreamEnd` 在 result 仍 pending 时只保存候选 end、不定终态」（plan:332）与设计 §5.2 原文「**先到者生效**，后到者只补缺失信息」（design:184）字面相反；F-2 的 stopping 吸收规则族也只存在于计划侧。计划的解法本身正确（按 D2「只有 result 缺席时才由 end 单独定终态」消解设计两句间的张力），但 Global Constraints 声明设计为真相源，两文现对同一场景给出相反字面规则。Task 12 Step 5 把设计 doc 限定为「只填实际验收记录，不改已批准行为」（plan:1146），当前没有任何任务承载这处订正。

处置：直接给设计 §5.2 补两条订正，把「end 先到只存候选、以 resolved result 为准」与「停止闩吸收后续执行结果、rejection 和启动失败」写回设计。这是澄清已批准的 D2/D3，不是新增行为；改动虽小，仍应在 Task 1 动工前完成，不应留到 Task 12。

另有一项 **Minor 测试补漏**：计划已规定「未绑定 upstreamRunId 时 rejection 单独定为 `failed`」（plan:333），但现有 rejection 用例都先绑定 upstreamRunId 或处于停止闩下（plan:115-136、:156），没有该分支的终态断言。应在 Task 1 增加一个不调用 `bindUpstreamStart` 的用例，断言 `rejectResult` 后 `phase === 'failed'` 且保留 `failure`。这不改变核心语义，但使 §6.4 初稿「三种形态均有用例」的表述过满；补测试比仅删除该表述更能防止回归。

### 6.4 第二轮结论

- **核心语义自洽，未发现需要返工的新缺陷**：定向闩、预算路径、无闩 aborted 三种 stopping 入口各有测试钉住。rejection 与 end 的三种协作形态均已写明强制实现规则，其中有候选 end、已绑定待 end 有用例，未绑定单独 failed 尚缺 §6.3 所述的一条测试，不能再表述为「三种均有用例」。
- **晚到 activation 的计划顺序成立，但机理须精确表述**：计划先 attach result 观察者，再调用 dispose，并要求 result 与 dispose 均结束后才确认清理。上游实际顺序是底层 `activation.handle.dispose()` / `activation.run.dispose()` 先执行（manager.ts:1153-1162），`activation.result` 在 teardown 尾部 resolve/reject（:1180-1182），外层 `activation.dispose()` Promise 随后完成（:775-780）；即使外层 dispose reject，result 也在其 throw 前结算（:1183）。因此观察者微任务先于清理 continuation 入队。不能把这简化成「底层 dispose 尚未执行就先 resolve result」。`result` 永不结算时保持当前非终态，定向取消下持续 `stopping`，符合 D3 严格语义。
- **完成最小补漏后可动工**：§2 的 9 项真实发现全部闭环，F-6 已撤销（kimi 的不采纳正确）；Task 1 动工前先完成 §6.3 的设计同步，并同批补上未绑定 rejection 的终态测试。除此之外无需核心方案返工。本节结论取代 §5 的处置建议。
