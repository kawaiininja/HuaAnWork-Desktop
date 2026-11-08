# 《中立会话独立子根与自动化任务自动绑定项目》实施就绪评审

- **评审日期**：2026-11-07
- **修订**：2026-11-08 独立复核修订版。复核方式 = 对本文每条断言重跑源码/夹具核对 + 实跑本文 §10 的两组基线命令（结果逐字复现）。修订内容：B2 的处置由「已决 D3/A」退回待决（改编号 **D5**，原编号与既有 D3 重名）、经 owner 重裁后定为 **E**（保留立即删 + 收窄与诚实口径）；B2 定性由「阻断 CRITICAL」改为「已接受的受限风险 + 强制诚实口径」；B3 严重度由 CRITICAL 降为 P2；T1 的验证手段经 owner 裁定为 **抽取判定函数 + 行为测试**（落点 `logic/concurrentTurn.ts`，不新建模块；生产文件计数因此再 +1）；§6 原第 6 条的两处「微漂订正」**整条撤回**（计划原值经复核为准确）、原第 5 条行号订正为 `:501`、原第 3 条撤回（计划已覆盖）；新增 **B4**（`noUnusedLocals` 下第二个编译缺口）与 **E5**（孤儿目录无回收路径）；订正生产文件计数（10→12，原写 11）。
- **二次复核**：2026-11-08 对修订计划的复审结论再做逐条 double check，区分「计划中的拟议代码缺陷」与「当前生产缺陷」，并校正 Windows CI、UI 夹具与回滚风险的表述。详见 §13。
- **评审对象**：[`2026-11-07-neutral-subroots-and-automation-projects.md`](./2026-11-07-neutral-subroots-and-automation-projects.md)
- **设计规格**：[`2026-11-07-neutral-subroots-and-automation-projects-design.md`](../specs/2026-11-07-neutral-subroots-and-automation-projects-design.md)
- **既有规格评审**：[`2026-11-07-neutral-subroots-and-automation-projects-design-review.md`](../specs/2026-11-07-neutral-subroots-and-automation-projects-design-review.md)
- **分支**：评审进行时为 `feat/huaanwork-concurrent-project-turns`（历史基线，保留原值）。该分支已于 2026-11-08 fast-forward 合并进 master 并推送（`fdcf80422e` → `e3d62edf68`），本地 `corepack yarn check` 真实退出码 0、CI run `42440172283` 六个 job 全绿（含 desktop-windows / desktop-macos），随后删除。**实施分支改为 `feat/huaanwork-neutral-subroots-and-automation-projects`**；因合并是 fast-forward，树内容逐字节未变，本文所有行号引用继续精确。
- **基线**：HEAD `e3d62edf68`；base branch `master`；`origin/master` 为 `fdcf80422e`（2026-11-08 复核时 HEAD 与分支未变）
- **评审方式**：当前源码静态追踪、现有测试与夹具核对、既有测试实跑。未实施计划中的未来代码。
- **评审结论**：**PASS，第二轮修订后的计划达到实施标准。** double-check 确认并修正了导入/类型/夹具硬错误、回滚 fail-safe、T4/T6 证明、chmod 平台条件及文档口径；随后独立 Momus 复核为 OKAY，原生 Plan 首轮发现 1 个日志断言矛盾与 3 个可执行性小缺口，修复后跟进 Plan 复核为 PASS。所有结论针对计划文本，不预支实施后的 typecheck、Vitest 或 T7 真机验收。详见 §13–§14。

## 1. 结论与处置边界

计划采用的三类平级目录、`TurnScheduler` 按根互斥原语不变、存量中立会话兼容和自动化自动建项目的主方向可以保留。本轮没有发现需要重做总体设计的理由。

但当前计划不能直接交给实施者照抄：

1. Task 7 会因客户端更新类型缺字段而无法通过 typecheck（B1，CRITICAL）。
2. Task 5 会在 `noUnusedLocals: true` 下留下未使用导入，同样无法通过 typecheck（B4，CRITICAL；2026-11-08 复核新增）。
3. Task 3 的物理目录删除与活跃回合/子代理收尾存在竞态（B2）。**竞态本身成立**，但 2026-11-07 记录的处置（D3/A 延迟异步清理）与复核后一度推荐的 A（在途则拒删）**都已被证伪**；owner 于 2026-11-08 裁定 **D5 = E：保留立即删，补 rm 失败日志与诚实口径**。据此 B2 由阻断项降为「已接受的受限风险」，只剩文档与日志两项必做动作（见 B2 与 §4）。
4. Task 6 的递归回滚没有覆盖完整创建阶段（B3，**P2 加固**，非 CRITICAL；严重度经复核下调，理由见该条）。
5. 多条新行为的测试只测预检、或完全没有进入声明要验证的失败分支（T2–T6）。T1 要求的「行为级验证」在本仓没有现成测试缝（`send()` 是 `App()` 内未导出的闭包，全仓无渲染 `App` 的先例）；owner 已裁定 **T1 = F：把判定抽成 `logic/concurrentTurn.ts` 的纯函数后做行为测试**，源码切片断言降为接线钉（见 §5 T1）。
6. 两类新目录（`workspace-automations/`、`workspace-projects/`）在删除自动化或删除项目后**没有任何回收路径**，而启动清扫只遍历已登记项目根（E5，2026-11-08 复核新增；非阻断，但须写进诚实口径或补清理）。

本文只记录评审与修复建议，不表示这些问题已经在产品代码中修复。

## 2. 已核实可保留的部分

| 计划内容 | 核实结果 |
| --- | --- |
| 三类新根与 `<profileDir>/workspace` 平级 | 符合既有 `pinnedCwd` 词法包含规则，可避免默认 workspace 回合直接包含这些新根 |
| `writableRootForSession` 推导阶段不创建独立子根 | 与现有发送、恢复和缺失 cwd 的 fail-closed 边界兼容 |
| D2：`session.new` 失败时中立标签不发送 | 必须保留；现有空 catch 会让无 `sessionId` 的发送落到前台稳定会话。2026-11-08 复核逐环核实：`App.tsx:2689-2691` 空 catch、`:2695-2698` 仅项目标签停发、`setDraft("")` 在 `:2718`（即计划 `return` 点之后 ⇒ 草稿确实留存）、`session.send` 在 `:2729`、服务端缺省 id 在 `sessions.ts:936` |
| D3：workspace 被登记成项目时已铸造目录优先 | 必须保留；否则 fresh 中立 id 会被项目稳定前缀捕获（`writable-root.ts:38-41` 现为「前缀命中即返回项目根」） |
| D4：其他中立前缀会话留在 workspace | 与现有回归测试一致，不应重新按 cwd 改判到其他项目（钉子：`writable-root.spec.ts:148-155`） |
| 存量自动化建目录放入 `executeRun` 内层 try | 与现有失败收口和准入释放顺序一致（内层 `try` 在 `automations-host.ts:604`，`finishAutomation` 在 `:647`，`finally` 释放在 `:654-661`） |
| Task 4 先于 Task 6 | Task 6 依赖 `createProject` 的可选 `id` 参数，顺序正确 |
| `hasInFlightAutomationRun` 覆盖 queued 与 started | `enqueueAutomation` 同步登记在途运行（`automations-host.ts:784-793`，phase 取值见 `automation-inflight.ts:18`），现有夹具可支撑守卫测试（`startInFlightRun` 已在 `automations-store.spec.ts:6` 导入） |
| 根级与包级测试命令 | 均存在（根 `typecheck`/`test` 在 `package.json:755-756`）；本轮实跑命令有效，2026-11-08 重跑逐字复现（见 §10） |

生产文件安排不需要重新拆分模块，但计划的生产文件清单缺三个已存在文件（对全文 grep `rpc-types|logic/projects|concurrentTurn`，计划与设计**零命中**）：

1. `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts` —— Task 7 必须给 `AutomationPatch` 加字段（B1），属实质修改。
2. `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts` —— 只需删除 `:268-269` 的过期注释（§6 第 1 条），属纯注释修改，但同样是计划外的生产文件。
3. `dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts` —— T1 裁定的抽取落点（新增一个纯函数），属实质修改。选它是因为计划 Scope record 写明「不新建模块」，而该文件正是「发送/回合簿记」纯函数的既有归处（108 行、全部为导出纯函数，已有专属 `concurrentTurn.spec.ts` 且被 `appWiring.spec.ts:15` 导入）。

因此计划的生产文件数应由 **10 改为 13**（2026-11-07 原写「改为 11」与本文 §6 第 1 条自相矛盾，2026-11-08 两次订正）。若只计实质修改，则为 12 个实质 + 1 个纯注释。

## 3. 阻断问题、待决处置与修复建议

> 分级说明（2026-11-08 复核后）：**阻断** = B1、B4（两个必然编译缺口）。**已裁定、不阻断但含硬门槛** = B2（D5 = E：rm 失败写日志 + 删除条件收窄并钉住 + 计划写明残留口径）。**P2 加固** = B3（回滚覆盖完整创建阶段）。四条列在同一节只为共用一份证据链，分级以本说明为准。

### B1： `AutomationPatch` 缺少 `projectId`，Task 7 必然无法通过 typecheck

**严重度 / 置信度**：CRITICAL / 10/10

**证据类型**：当前源码静态核实。

**证据：**

- `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts:85-97` 的 `AutomationPatch` 字段清单没有 `projectId`（2026-11-08 订正：类型体含收尾花括号为 `:85-97`，字段为 `:86-96`）。
- `dsh-plugin-huaanwork/src/client-huaanwork/projects.ts:59-61` 的 `updateAutomation(id, patch: AutomationPatch)` 使用该类型。
- `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx:1060` 以**对象字面量**调用 `updateAutomation`，因此触发 TypeScript 多余属性检查。
- 计划 Task 7（`:948`）要求在编辑分支向 `updateAutomation` 传入 `{ projectId: bindProjectId }`。

**失败场景：** 实施者按计划加入对象字面量后，TypeScript 多余属性检查失败，Task 8 的 `corepack yarn typecheck` 不能通过。

**修复建议：**

1. 在 `AutomationPatch` 中增加 `projectId?: string`。
2. 把 `logic/projects.ts` 与 `rpc-types.ts` 加入 File Structure、Task 7 Files 和范围记录（生产文件计数见 §2）。
3. 不需要改变 `AutomationDraft.projectId: string | null`；创建路径已经有该字段。
4. **同批清理 `logic/projects.ts:21` 的过期注释**（2026-11-08 复核新增）：`AutomationInfo.projectId` 上的 `null = 中立归属(issue #2),创建后不可改` 在本次改动后**两处都变成假话**——改绑被放开，且新建自动化不再可能是 `null`。该文件正是本条要打开的文件，应与 `rpc-types.ts:268-269`、`AutomationsView.tsx:867` 同批处理，不要留到 §6。

**验收：** 编辑自动化选择新项目后，请求体携带非空 `projectId`，客户端和全仓 typecheck 均通过；三处「创建后不可改」文案全部改写。

### B2：活跃独立会话删除与异步收尾竞态

**严重度 / 置信度**：竞态事实 CRITICAL / 9-10；**危害经爆炸半径分析下调为「已接受的受限风险」（D5 = E，owner 2026-11-08 裁定），不再阻断开工**，但 E 的三项必做内容是硬门槛

**证据类型**：当前源码控制流核实；2026-11-08 复核追加反证。

**证据（竞态本身，复核后维持）：**

- 计划 `removeSession` 片段位于 `docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md:594-614`，在取消和删除日志后立即递归删除独立根（2026-11-08 订正：含函数签名的代码块为 `:594-614`，原写 `:598-614`）。
- `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:576-596` 的 `releaseSessionRuntime` 只发起 `cancel?.({ kind: 'user' })`，不等待活跃回合结束；其 `:584` 注释自己写明「只动队列,不碰活动写者:删除会话不是对执行中回合的提前 release」。
- `sessions.ts:146-159` 的 `cleanup()` 显示完整清理由 `afterIdle()`、子代理清理、父会话 `whenIdle()` 和 `releaseOnce()` 共同构成。
- 现有代码已把「回合进行中 `session.remove`」当真实场景处理：`sessions.ts:253` 的所有权守卫注释与 `:320` 的兜底注释都点名它。
- 客户端 `App.tsx:3247` 先 `await rpcCall("session.cancel")`，`:3260` 紧接着 `session.remove`；cancel 不等于收尾完成。

**失败场景：** 用户删除正在执行工具或 `@` 子代理的独立会话。目录在写者仍活跃时被删除；收尾中的工具可能写失败，或在删除返回后重新创建目录。只等待主 agent 的 `whenIdle` 也不能证明子代理 dispose 已完成。

**处置方案：D5 = E（owner 2026-11-08 裁定）。保留计划原样的立即删，补三项便宜守卫。B2 由此从阻断项降为「已接受的受限风险 + 强制诚实口径」，与设计对「进程崩溃可能留下空项目」的处理同级。**

**E 的三项必做内容：**

1. **`rm` 失败必须写日志**，不得静默吞掉。计划 `:610` 现为 `await rm(...).catch(() => undefined)`；改为 `.catch((error) => routeCtx.logger(...))`（或该文件既有的日志入口），保留不抛出。
2. **删除条件收窄并钉住**：只对通过 `assertSafePathSegment(sessionId, 'sessionId')` **且**带中立稳定前缀（`sessionId.startsWith(`${neutralStable}-`)`）的 id 执行 `rm`。计划 `:602`/`:608-611` 已是这个形状，本条要求把它写成显式不变量并加负例测试（见 T2），防止后续修改把前缀判断放宽。
3. **计划必须诚实写明残留口径**：删除一个仍有在途回合的独立会话时，该轮剩余的工具写可能因目录已删而失败；子代理收尾期间可能重建部分目录，而启动清扫不会回收它（清扫只遍历**已登记**项目根，且 `workspace-sessions` 被列进 `protectedRoots`）——与 E5 同源。不得声称「删除会等收尾完成」，也不得声称「不会留下任何残留」。

**不新增的东西**（E 明确排除）：不新增收尾观测机制、不新增 tombstone、不改 `turn-scheduler.ts`、不改客户端删除流程（`App.tsx:3239-3275` 的「先 cancel 再 remove」原样保留）、不新增启动补扫。

**E 的依据 —— 爆炸半径分析（2026-11-08 复核补做，原评审缺失）：** `workspace-sessions/<sessionId>` 是该会话**专属**的平级兄弟根，设计 §3.1 已证明双向夹紧（`work-1` 与其他会话都写不进去，它也写不出去）。因此在写者仍活跃时删它，受损的只有**用户刚刚亲手删掉的那一轮自己**：工具写 ENOENT、该轮以错误收尾、而这一轮在界面上已经不存在。不波及共享 `workspace`、其他独立会话、任何项目根或自动化目录。原评审把它定为 CRITICAL/9，是按「删掉活跃写者的目录」这一抽象形态定的，没有做归属分析。

**为何不是 A / B / C（保留为决策依据，防止后续重复提案）：**

对原 D3/A（= 下表 C）的三条反证：

1. **本仓对同一问题已有相反先例，原评审未评估。** `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:548` 的 `deleteAutomationRun` 在删会话目录前直接拒绝：`if (inFlightRuns.has(runId)) throw new Error('运行中的记录不能删除')`，`:536-537` 写明理由；`:561-563` 是「先释放运行态,再删目录」的既有次序。
2. **C 要求的观测点在禁改文件里。** `TurnScheduler` 的公开面（`turn-scheduler.ts:35-70`）没有任何按会话或按根的 idle 查询；根写者的释放发生在每回合 `cleanup()` 闭包内的 `releaseOnce?.()`（`sessions.ts:157`），`removeSession` 够不到。要「等根写者释放」，要么给调度器加原语——计划 Global Constraints（`:19`）与 NOT in scope（`:1237`）明禁改 `turn-scheduler.ts`——要么在 `sessions.ts` 新造一套收尾登记机制。
3. **延迟清理会拆掉一个现有的 fail-closed 性质，并新开一个更坏的窗口。** 立即删时，陈旧标签再发该 id：`headerCwd === undefined` 且 `existsSync(mintedRoot)` 为假 ⇒ 推导回落中立根。延迟删时该目录仍在 ⇒ `writableRootForSession` 返回兄弟根 ⇒ `ensureChannelAgent` 在无 header 的情况下**就地复活已删会话**，随后延迟 `rm` 删掉一个**活根**。这正是 `releaseSessionRuntime:582-584` 注释警告的复活形态。堵它需要 tombstone。

对复核后一度推荐的 A（在途则拒删）的**证伪**（2026-11-08，四条，均已核实）：

- **A1**：`sessions.spec.ts:1521` `'releases a waiting request_input, cancels the live agent, and forgets the session'` 注册了 `status: 'running'` 的 live agent（`:1531`）与一个等待中的 `request_input`（`:1554`），断言 `sessionRemove` 返回 `{ removed: true }`（`:1564`）。A 直接打翻它，而这条钉子的用途正是「删除要能清掉一个正在运行的会话」。
- **A2**：`sessions.spec.ts:2869` `'session.remove during the dequeue→followup window stops a persisted session’s text'` 让会话在持有根写者、卡在 `resume` 闸门时被删，同样断言 `{ removed: true }`（`:2898`）。另有 `:2563` `'the send records the session model and writable root until removal'`：agent 已 live、`idle` deferred 未 resolve（回合确实在途）时删除，断言成功且模型/根登记被清掉（`:2581`）。A 会同时打翻这两条。
- **A3**：`cancelAgent`（`sessions.ts:444-465`）立即返回 `{ accepted: true }`，**不等待收尾、也不把 agent 从注册表摘掉**（只调 `agent.cancel?.()` 与 `releaseRouteInput`）。因此 A 要求的「请先停止后再删除」**没有可满足的信号**：用户点了停止之后，`findAgentBySession` 仍会命中，删除可能永远被拒。A 由此塌回 C 最难的那部分（需要收尾完成信号）。
- **A4**：客户端 `App.tsx:3245-3259` 是「先 cancel + 先清本地回合态（含 `stopSessionId: null`，即摘掉停止按钮）→ `:3260` 才 remove」。A 之下 remove 被拒时停止按钮已经没了，正是 `:3249` 注释当初要避免的形态。

**归因（记录以免重犯）**：A 的错误来自把 `deleteAutomationRun` 的先例跨面搬运。那是**自动化运行记录**：界面另有独立停止动作，记录不是用户唯一的抓手。而**聊天会话的「删除即停止并清理」是被四条钉子锁住的既有产品行为**（`sessions.spec.ts:1521`、`:2240`、`:2563`、`:2869`）。提案前必须先查目标面自己的回归钉。

| 选项 | 内容 | 状态 |
| --- | --- | --- |
| **E** | 保留立即删 + rm 失败写日志 + 收窄条件并钉住 + 诚实残留口径 | **已裁定（owner，2026-11-08）** |
| A | 在途则拒删 | **已证伪**（A1–A4） |
| B | 有界等待后删 | 未选。需要与 C 同源的收尾观测机制，且删除 RPC 变成可能长阻塞 |
| C | 延迟异步删 + tombstone | 未选（原 D3/A）。反证 1–3；成本最高 |

**必须原样保留的既有回归钉（E 之下四条全部不变，实施后须仍绿）：**

- `sessions.spec.ts:1521` —— live agent（`status: 'running'`）+ 等待中的 `request_input`，删除成功并释放卡片、取消 agent。
- `sessions.spec.ts:2240` —— 仅排队的会话被删后，drain 不得复活它。
- `sessions.spec.ts:2563` —— agent 已 live、回合在途（`idle` deferred 未 resolve）时删除成功，且会话模型/根登记被清掉。
- `sessions.spec.ts:2869` —— dequeue→followup 窗口内删除成功，且该轮文本不得被 followup。

> 复核订正：原评审 T2 称「只测静态会话删除成功」，**不成立**。上述四条中三条（`:1521`、`:2563`、`:2869`）都覆盖在途/活跃 agent 下的删除。真正的缺口窄得多：**没有任何一条断言物理兄弟目录**（该目录今天不存在），也没有覆盖「`@` 子代理仍在写独立根时删除」。这也是 E 优于 A/B/C 的一条独立理由——E 是唯一让这四条钉子全部不改一字的选项。

**验收：** ① 上述四条钉子不改一字仍通过；② 删除旧中立会话或项目会话不得误删共享 `workspace` 或项目根（负例，见 T2）；③ `rm` 失败时留下日志且不抛出（用 `chmodSync` 制造真实失败，先例见 `automations-store.spec.ts:1117`/`:1139`）；④ 计划文本含 E 第 3 条的残留口径，且不含「删除会等收尾完成」一类承诺。

### B3：自动项目回滚覆盖阶段不完整（2026-11-08 复核：严重度由 CRITICAL 下调为 P2）

**严重度 / 置信度**：P2 加固 / 事实 9/10、危害 4/10

**证据类型**：计划中的拟议代码审查；2026-11-08 复核补可达性分析。

**证据（事实成立）：**

- 计划 `:859-874` 先 `mkdir`（`:861`）、`createProject`（`:862-866`），`try` 从 `:867` 才开始，`createAutomation`（`:868`）失败时在 catch 里 `removeProject` + `rm(projectRoot, { recursive: true, force: true })`（`:871-872`）。
- 因此 `mkdir` 成功而 `createProject` 失败的路径没有回滚保护。

**严重度下调理由（复核新增）：**

- **失败场景二危害被高估。** 留下的是一个**空且未登记**的目录：不进侧栏（`projects.json` 无条目）、不被启动清扫触及（清扫只遍历**已登记**项目根）、不占写者锁。属 INFORMATIONAL 级泄漏，不是 CRITICAL。且 `createProject` 在 `mkdir` 成功 + 全新 UUID 根之后，四条抛错路径里三条（空 root、stat 非目录、root 重复）已被前置排除，只剩注册表读写失败。
- **失败场景一可达但概率极低。** 它要求同时成立：`createProject` 已落盘 → 他人发现这个全新 UUID 项目并绑定 → 跑完**一整个会写文件的回合** → 且 `createAutomation` 失败（现实触发只有 `automations-store.ts:286-288` 锁内上限复检，或写盘失败），全部落在一个 `await` 内。
- 结论：修复建议**便宜且应当做**（纵深防御），但不构成阻断开工的 CRITICAL。

**修复建议：**

1. 回滚保护覆盖 `mkdir → createProject → createAutomation` 整段创建流程。
2. 只清理本次创建、仍为空、且仍由本次操作拥有的目录。
3. **非空目录或项目已被其他操作复用时，`projects.json` 条目与目录一并保留**（2026-11-08 订正：原文只写「保留现场，不得递归抢删」，未说明注册表条目去留。若只保留目录而删掉条目，会把有引用的项目文件搁在一个没有注册表条目的目录里，比原缺陷更糟），并写日志说明放弃回滚的原因。
4. 若项目登记已成功、自动化登记失败，回滚前应检查是否出现新的引用（遍历 `listAutomations` 看有无 `projectId === project.id`）；有引用则按第 3 条整体保留。
5. 保留“跨文件不是事务、进程崩溃可能留下空项目”的诚实口径。

**验收：** 覆盖 `createProject` 失败、`createAutomation` 失败、目录非空和并发复用四类场景；任何回滚都不得删除非本次创建的内容；放弃回滚时必须留下日志与完整的注册表条目。

> 可行性备注（复核新增）：`automations-store.spec.ts` 已有真实文件系统故障注入先例（`:1117` `chmodSync(cwdDir, 0o555)`、`:1139` `chmodSync(sessionsRoot, 0o000)`），因此 T3/T4 要求的「强制 `createAutomation` 在项目和目录已创建后失败」不需要新造 mock 缝。

### B4：Task 5 会留下未使用导入，`noUnusedLocals` 下同样通不过 typecheck（2026-11-08 复核新增）

**严重度 / 置信度**：CRITICAL / 8/10

**证据类型**：当前源码 + tsconfig 静态核实。

**证据：**

- `dsh-plugin-huaanwork/tsconfig.json:22` 设 `"noUnusedLocals": true`，`:30-35` 的 include 覆盖 `src/huaanwork-host/**/*.ts`。
- `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:29` 导入 `neutralWorkspaceRoot`，其**唯一**使用点是 `:200`（`automationAdmissionRoot` 的返回语句）。
- 计划 Task 5 Step 3.2 用 `neutralAutomationRootPath` 替换掉 `:200` 那一行，但 Step 3.1 只写「从 `./workspace-state.ts` 导入 `neutralAutomationRoot`、`neutralAutomationRootPath`」，**没有要求删除已失效的旧导入**。

**失败场景：** 实施者照 Step 3 逐字执行后，`neutralWorkspaceRoot` 成为未使用导入，触发 TS6133，Task 8 Step 1 的 `corepack yarn typecheck` 失败。

**缓解事实（为何是 8/10 而非 10/10）：** 计划 Task 5 的 Files 行（`:760`）确实点了 `automations-host.ts:29`，等于给了实施者一个提示；但正文从未说明该行的改法是「删掉旧导入」，而 B1 已经证明本计划存在「照抄即红」的编译缺口，同类风险应显式写出。

**修复建议：** 在 Task 5 Step 3.1 明确写成「把 `:29` 的 `neutralWorkspaceRoot` 导入替换为 `neutralAutomationRoot`、`neutralAutomationRootPath`」，并在 Task 5 Step 4 之后补一句「本任务结束时 `automations-host.ts` 不得残留未使用导入」。

**验收：** `corepack yarn typecheck` 通过；`grep -n neutralWorkspaceRoot dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts` 零命中。

## 4. 决策记录

### 本轮新增决策：活跃会话物理目录删除时序

**D5 / E：保留立即删 + 收窄与诚实口径。（State: approved — owner 裁定，2026-11-08）**

> 编号订正：原评审把这条记作「D3」，与既有决策表里的 **D3（workspace 被登记成项目时已铸造目录优先）重名**，同一段落出现两个含义不同的 D3。本次改为 **D5**（D2/D3/D4 均已占用）。下文引用一律用 D5。

**Accepted scope（E）：**

- 物理 `workspace-sessions/<sessionId>` 清理**保持在 `removeSession` 内立即执行**，与日志删除同一次调用，不延迟、不异步、不等待收尾。
- `rm` 失败改为**写日志**（不抛出），替换计划 `:610` 的 `.catch(() => undefined)`。
- 删除条件收窄为「通过 `assertSafePathSegment` **且**带中立稳定前缀」，写成显式不变量并加负例测试。
- 计划必须写明残留口径：删除在途会话时该轮剩余工具写可能失败；子代理收尾可能重建部分目录且启动清扫不回收（与 E5 同源）。不得承诺「删除会等收尾完成」。
- **明确不做**：不新增收尾观测机制、不新增 tombstone、不改 `turn-scheduler.ts`、不改客户端删除流程（`App.tsx:3239-3275` 原样保留）、不新增启动补扫。
- 四条既有回归钉（`sessions.spec.ts:1521`、`:2240`、`:2563`、`:2869`）必须不改一字仍通过。

**决策依据**：爆炸半径限于该会话专属的平级兄弟根（设计 §3.1 双向夹紧），受损的只有用户刚亲手删掉的那一轮自己。详见 B2。

**决策历史（两次翻转，均留档以防重复提案）：**

1. 2026-11-07 原记 **D3/A（延迟异步清理）** —— **作废**。理由：未评估本仓既有的「在途则拒删」先例；「根写者释放」观测点位于计划明禁修改的 `turn-scheduler.ts`；延迟清理拆掉现有 fail-closed 性质，新开「已删会话被复活、随后删掉活根」的窗口且无 tombstone。
2. 2026-11-08 复核一度推荐 **A（在途则拒删）** —— **证伪**。四条已核实证据：`sessions.spec.ts:1521` 与 `:2869` 两条既有钉子断言在途/窗口内删除必须成功；`cancelAgent`（`sessions.ts:444-465`）不等收尾也不摘 agent，导致「先停止再删除」无可满足信号；客户端先清停止按钮再 remove，被拒后用户无从操作。归因：把 `deleteAutomationRun` 的先例跨面搬到会话面，未先查该面自己的回归钉。
3. 2026-11-08 owner 裁定 **E** —— 生效。B（有界等待）与 C（延迟 + tombstone）均未选，两者都需要与 C 同源的收尾观测机制，成本高于 E 且不改变爆炸半径的结论。

该决策只约束删除时序与其诚实口径，不改变既有 D2/D3/D4，也不批准其他范围扩张。

### 本轮新增决策：T1 的测试形态

**D6 / F：抽取判定函数后做行为测试。（State: approved — owner 裁定，2026-11-08）**

- **问题**：D2（`session.new` 失败时中立标签不发送）在计划里只有一条精确匹配 catch 分支的长正则（Task 3 Step 1.3）。语义全在正则里，没有任何生产函数被驱动。
- **约束**：`send()` 是 `App()` 内未导出的闭包，全仓无渲染 `App` 的先例 ⇒ 「mock RPC 后驱动组件」不可实现。
- **Accepted scope**：把「铸造失败显示哪一句」的判定抽成 `logic/concurrentTurn.ts` 的导出纯函数 `sessionMintFailureNote`（**不新建模块**，符合计划 Scope record）；`App.tsx` 的 catch 改为调用它 + `noteActive` + `return`；行为层测试落 `concurrentTurn.spec.ts`，接线层钉子留 `appWiring.spec.ts`（即该文件 `:30-37` 头注释写明的既有两层形态）。计划 Task 3 Step 1.3 的长正则必须重写。
- **明确不做**：不引入渲染整个 `App` 的测试先例。因此「不调用 `session.send`」与「草稿保留」仍只由接线层的顺序断言保证 —— 这条边界必须写在计划里，不得声称做到了渲染级验证。
- **附带收益**：新写法对项目标签是**行为等价**的（原本 `sessionId = undefined` 后落到 `:2695-2698` 守卫，显示同一句「子任务会话尚未就绪…」），且 catch 内不再有分支，比计划原来的写法更简单。`:2695-2698` 守卫保留，它还负责「铸造成功但应答没带 sessionId」这条不抛错的路径。
- **代价**：生产文件计数 +1（`logic/concurrentTurn.ts`），见 §2。

### 继续有效的既有决策

| 既有决策 | 继续执行的内容 |
| --- | --- |
| D2 / A | `session.new` 失败时显示错误、保留草稿、不调用 `session.send` |
| D3 / A（原评审） | workspace 被登记成项目时，已铸造的独立目录优先；`work-1` 仍使用 workspace |
| D4 / B | 其他中立前缀会话留在 workspace，不按 cwd 改判到其他项目或自动化目录 |
| 自动化建目录事实订正 | `neutralAutomationRoot` 位于包住 `runAgentTurn` / `runScript` 的内层 try 中 |

## 5. 测试评审：7 处必须补强（T1 抽取后行为测试 + T2–T6 单测 + T7 真机）

| 编号 | 缺口 | 当前计划为何不能证明行为 | 必须补入的验证 |
| --- | --- | --- | --- |
| T1 | `session.new` 真实拒绝 | D2 只用正则匹配 `App.tsx` 源码，语义全在正则里，没有可驱动的生产函数 | **已裁定 = F：抽取判定函数后做行为测试**（见下方 T1 说明）。语义移进 `logic/concurrentTurn.ts` 的纯函数并由 `concurrentTurn.spec.ts` 行为级验证；`appWiring.spec.ts` 的源码切片断言**降为接线钉**（只钉「catch 调用了该函数并在 `session.send` 之前 return」），不再承载语义 |
| T2 | 独立根删除的边界与失败日志 | 现有四条删除用例（`sessions.spec.ts:1521`、`:2240`、`:2563`、`:2869`）已覆盖 live agent / 在途 / dequeue 窗口下的删除，但**没有一条断言物理兄弟目录**（该目录今天不存在），也没有覆盖「`@` 子代理仍在写独立根时删除」。计划新增的 `sessionRemove deletes the sibling directory…` 只是静态用例 | 按 **D5 = E** 补三件事：① 负例——删除旧中立会话或项目会话时，共享 `workspace` 与项目根**不得**被 `rm`（这是 E 第 2 条不变量的钉子）；② `rm` 失败时写日志且不抛出（`chmodSync` 制造真实失败）；③ 上述四条既有钉子不改一字仍通过 |
| T3 | 实际自动化回滚 | 达到 50 条上限时在预检阶段失败，根本没有创建项目 | 强制 `createAutomation` 在项目和目录已创建后失败，断言回滚路径。**这是设计 §6:343 明写而计划漏掉的一条**，不是评审加严 |
| T4 | 非空目录与登记失败保护 | 没有覆盖递归删除数据或 `createProject` 失败 | 非空目录保留（含注册表条目一并保留，见 B3 建议 3）；`createProject` 失败时按所有权清理；并发复用不被回滚破坏 |
| T5 | 自动化建目录失败 | 只规定把 mkdir 放进 try，没有触发该错误 | 用同路径文件冲突制造真实 mkdir 错误，断言运行记失败且准入释放 |
| T6 | 改绑后的下一次准入 | 只测更新成功和在途拒绝 | 改绑后下一轮使用新项目根；已准入轮次继续使用冻结的旧根。**这是设计 §6:344 明写而计划漏掉的一条** |
| T7 | 真实用户界面 | `started: true` 和源码接线断言不代表真实窗口行为 | 走查两个中立标签并行、铸造失败恢复、自动化创建/编辑改绑和项目列表刷新 |

**T1 说明（裁定 = F，owner 2026-11-08）：抽取判定函数 + 行为测试。**

*为什么必须抽取（原要求「mock RPC 驱动行为级验证」不可实现）*：`send()` 是 `App()`（`App.tsx:508`，全文 4780 行）内部的闭包，**未导出**。全仓没有任何测试渲染 `App`；唯一的 `App.tsx` 渲染先例是导出的子组件 `InputCardView`（`inputCardView.spec.ts:6`）。因此 mock `rpcCall` 到不了闭包内部。抽取是唯一能拿到行为级测试的路。

*落点*：`dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts`（既有文件，**不新建模块**，符合计划 Scope record 的约束）。该文件已是「发送/回合簿记」纯函数的归处，且有专属 `concurrentTurn.spec.ts`。

*抽取的函数*（判定，不含副作用）：

```typescript
/**
 * `session.new` 铸造失败时给用户看哪一句。两种归属都不发送：
 * 中立标签显示真实错误（目录建不出来这件事必须可见），项目标签沿用既有的
 * 「尚未就绪」文案（与 App.tsx:2695-2698 现有守卫同一句，避免同一种失败两种措辞）。
 */
export function sessionMintFailureNote(input: {
  error: unknown;
  tabProjectId: string | null | undefined;
}): string {
  if (input.tabProjectId != null) return "子任务会话尚未就绪，消息未发送。请重试。";
  return input.error instanceof Error ? input.error.message : String(input.error);
}
```

*`App.tsx` 调用点*（替换计划 Task 3 Step 3.3 的分支写法，`:2689-2691`）：

```tsx
        } catch (error) {
          noteActive(sessionMintFailureNote({ error, tabProjectId: sendingTab?.projectId }));
          return;
        }
```

这比计划原来的版本更简单（catch 里不再有分支），且**对项目标签是行为等价的**：原写法是 `sessionId = undefined` 后落到 `:2695-2698` 的既有守卫，显示的正是同一句「子任务会话尚未就绪…」；新写法在 catch 内直接显示同一句并 return。`setDraft("")` 在 `:2718`，两种写法都在它之前 return ⇒ 草稿都留存。`:2695-2698` 的守卫**保留不动**——它还负责「铸造成功但应答没带 sessionId」这条不抛错的路径。

*两层测试*（这正是 `appWiring.spec.ts:30-37` 头注释写明的既有形态：「helper 单测全绿但 App 调用被删仍绿」⇒ 驱动生产函数 + 钉住调用点）：

1. **行为层**（`concurrentTurn.spec.ts`）：中立标签（`tabProjectId: null` 与 `undefined`）返回真实错误文本；非 `Error` 值被 `String()` 化；项目标签返回「子任务会话尚未就绪，消息未发送。请重试。」。
2. **接线层**（`appWiring.spec.ts`，改写计划 Task 3 Step 1.3 的正则）：`send()` 的 catch 调用 `sessionMintFailureNote`、随后 `return`，且该 `return` 在 `await rpcCall<SessionSendResult>("session.send"` 之前；保留 `assert.doesNotMatch(between, /catch \{\s*sessionId = undefined;\s*\}/)` 这条「不得回到空 catch」的钉子。**计划 Task 3 Step 1.3 现有那条长正则必须重写**——它精确匹配的是被本裁定取代的分支写法。

*诚实边界（不得过度声称）*：抽取之后，**「显示哪一句」是行为级验证的**；**「不调用 `session.send`」与「草稿保留」仍然只由接线层的顺序断言保证**，因为要真正驱动它们必须渲染整个 `App`，本仓没有这个先例，本裁定也不引入。`no_claim` 照旧：不证明真实磁盘满。

### 测试价值卡

- **T1**：`protects=铸造失败时显示正确的那一句、且不发送、草稿留存; fails_when=空 catch 后继续 session.send，或两种归属显示同一句; why_new=现有源码断言把语义藏在正则里、不驱动任何生产函数; seam=抽取到 logic/concurrentTurn.ts 的 sessionMintFailureNote（行为层 concurrentTurn.spec.ts + 接线层 appWiring.spec.ts，即该文件 :30-37 头注释的既有两层形态）; no_claim=不证明真实磁盘满；「不发送」与「草稿留存」仍只由接线层顺序断言保证，不是渲染级验证`
- **T2**：`protects=只删该会话自己的兄弟根、rm 失败可见; fails_when=前缀判断被放宽导致误删共享 workspace/项目根，或 rm 失败被静默吞掉; why_new=现有四条删除用例（:1521/:2240/:2563/:2869）都不断言物理目录; seam=现有回合夹具（makeHarness:1965 / addAgent:1991 / makeDeferred:82）+ chmodSync 故障注入（先例 automations-store.spec.ts:1117/:1139）; no_claim=不证明在途删除不会让该轮工具写失败——那是 D5=E 已接受并须在计划中写明的风险，不是本测试的目标`
- **T3/T4**：`protects=失败回滚不删他人内容; fails_when=递归 rm 非空目录或漏掉登记失败; why_new=上限预检不进入回滚; seam=真实文件系统; no_claim=不证明跨文件事务原子性`
- **T5**：`protects=mkdir 失败进入失败收口并释放准入; fails_when=建目录位于内层 try 外; why_new=成功路径无法覆盖该错误; seam=路径文件冲突; no_claim=不证明所有磁盘错误类型`
- **T6**：`protects=已准入根不变且下一准入用新根; fails_when=在途改根或改绑不生效; why_new=更新成功断言不验证执行根; seam=现有自动化 harness; no_claim=不消除 check-then-act 窗口`
- **T7**：`protects=真实双标签与自动化交互可用; fails_when=单元测试绿但界面接线/状态异常; why_new=当前没有该真实走查; seam=桌面或组件级驱动; no_claim=单元级 mock 不等于真机验收`

### 覆盖示意

```text
CODE PATHS                                           USER FLOWS
[+] writableRootForSession                           [+] 新建中立对话
  ├── [PLAN] 已铸造 / 存量 / 未知 id                   ├── [PLAN] 两会话同时 started
  ├── [PLAN] workspace 项目例外 D3                     ├── [GAP T1] 铸造失败：抽取后行为测试 + 接线钉
  └── [EXISTING] 其他中立前缀留 workspace D4            └── [GAP T7] 真实双标签走查
[+] sessionNew / removeSession                       [+] 删除独立会话
  ├── [PLAN] fresh 建独立根                            ├── [PLAN] 静态会话删除
  ├── [GAP B4] 未使用导入 → typecheck 红                ├── [GAP T2] 误删共享根的负例 + rm 失败日志
  ├── [EXISTING] 在途/活跃删除 4 条钉子                  └── [ACCEPTED D5=E] 在途删除时该轮工具写可能失败
  └── [EXISTING] 立即删保持 fail-closed（D5=E）
[+] automation.create / update                       [+] 自动化创建与编辑
  ├── [PLAN] 自动建项目 / 上限预检 / 在途守卫           ├── [PLAN] 默认创建与运行中禁用
  ├── [GAP T3/T4] 真实回滚与非空保护（B3，P2）          ├── [GAP T6] 改绑后下一准入用新根
  └── [PLAN] 项目列表双刷新                            └── [GAP T7] 真实创建/编辑走查
[+] automationAdmissionRoot / executeRun             [+] 存量与已删项目自动化
  ├── [PLAN] 存量 null 在独立根执行                     ├── [PLAN] 不占共享 workspace
  ├── [PLAN] 已删项目早退且不建目录                     ├── [GAP T5] mkdir 失败收口
  └── [GAP T5] 建目录错误触发                          └── [GAP E5] 删除后孤儿目录无回收路径
```

没有需要退役的测试。既有“`projectId` 创建后不可改”测试（`automations-store.spec.ts:581` `issue #2: updateAutomation ignores projectId — binding is immutable after creation`）应按计划改写为允许合法改绑，而不是删除回归保护。

## 6. 代码质量与文档同步项

以下内容不阻断开工，但应随对应任务完成：

1. `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:268-269`：删除“归属在创建后不可改”的旧说明（该文件是纯注释修改，`AutomationInfo.projectId` 已是 `string | null`，无需改类型）。
2. `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx:867`：删除“仅创建模式可选，编辑不可改”的旧说明。
3. `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts:21`（2026-11-08 复核新增）：`AutomationInfo.projectId` 上的 `null = 中立归属(issue #2),创建后不可改` 在本次改动后**两处都变成假话**——改绑被放开，且新建自动化不再可能是 `null`。该文件正是 B1 要打开的文件，应与第 1、2 条同批处理。
4. ~~`dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:74`：同步新改绑规则。~~ **撤回（2026-11-08 复核）：计划已经覆盖这一条**——Task 4 Step 3.2 明写「把 `AutomationInput.projectId` 上「创建后不可改」的注释（`automations-store.ts:74`）改成……」。原评审把它记成计划外的补充项，属重复记账。
5. 改绑守卫是 check-then-act；文档应准确写成“已准入轮次保持旧根，之后的准入使用新根”，不要承诺不存在并发窗口。（设计 §3.3.3 第 3 点已有此句，计划 Task 6 未复述，补进计划即可。）
6. `automation-scheduler.spec.ts:501` 的测试名 `neutral tasks run when the current root is the neutral root` 包含 neutral root 语义，Task 5 之后未绑定自动化的根变成 `workspace-automations/<id>`，测试名会误导，应改名。（2026-11-08 订正：测试名在 `:501`，原写 `:505` 指向的是该测试体内的 `makeTask` 行。）
7. ~~行号应以实施时源码为准。本轮核实的微漂包括：`automation-scheduler.spec.ts` 待改块约 `:253-256`，`AutomationsView.tsx` 归属字段块约 `:1108-1129`。~~ **整条撤回（2026-11-08 复核）：这两处「订正」都是错的，计划的原始引用才准确。**
   - `automation-scheduler.spec.ts`：计划引 `:248-251`，实测待改的根推导块正是 `:248-251`（`const project = …` / `const root = resolve(project?.root ?? h.neutral)`）；原评审给的 `:253-256` 指向 `sessionId` 与 `admitAutomation` 实参，不是待改块。
   - `AutomationsView.tsx`：计划引 `:1112-1132`，实测归属项目字段块正是 `:1112-1132`；原评审给的 `:1108-1129` 从「任务名称」起、在 `<span>` 中间截断。
   - 复核同时抽查了计划对 `automations-host.spec.ts:288-294`、`:872-901`、`automations-store.spec.ts:643-655`、`routes.ts:1132-1149` 与 `:1151-1168`、`automations-store.ts:302-349`、`sessions.ts:936` 与 `:955`、`automations-host.ts:576`/`:604`/`:654-661`、`package.json:755-756` 的引用，**全部精确**。「行号以实施时源码为准」这句原则保留，但本轮不存在需要订正的计划行号。

直接 `session.remove` 与 task/project 级联删除不是同一条物理目录清理链：`project.remove` 走 `removeSessionFilesById`（`routes.ts:1092`），不经过 `removeSession`；`automation.remove` 走 `removeAutomation`（`routes.ts:1177-1178`），同样不经过它。若计划继续只修改直接删除入口，应准确表述边界，不得宣称所有级联删除都会清理 `workspace-sessions` 根。

## 7. 建议实施任务与顺序

仍建议单线顺序实施，不拆并行 worktree。下列任务是对原计划的修订，不是要求另起一套设计。

| 顺序 | 优先级 | 修订任务 | 主要文件 | 验证 |
| --- | --- | --- | --- | --- |
| 0 | P1 | 按 **T1 = F** 抽取 `sessionMintFailureNote` 到 `logic/concurrentTurn.ts`，并把 `App.tsx:2689-2691` 的空 catch 换成「调用它 + `noteActive` + `return`」（取代计划 Task 3 Step 3.3 的分支写法）；`:2695-2698` 的既有守卫保留不动 | `logic/concurrentTurn.ts`、`App.tsx`、计划文档 | `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/client-huaanwork/concurrentTurn.spec.ts tests/client-huaanwork/appWiring.spec.ts` |
| 1 | P1 | 补 `AutomationPatch.projectId`，同步文件清单和类型文档（含 `logic/projects.ts:21` 注释） | `logic/projects.ts`、`rpc-types.ts`、`AutomationsView.tsx` | `corepack yarn typecheck` |
| 2 | P1 | 修 B4：把 `automations-host.ts:29` 的 `neutralWorkspaceRoot` 导入替换为 `neutralAutomationRoot`/`neutralAutomationRootPath`，不留未使用导入 | `automations-host.ts` | `corepack yarn typecheck`；`grep -n neutralWorkspaceRoot` 该文件零命中 |
| 3 | P1 | 按 **D5 = E** 落地：删除时序保持立即，`rm` 失败改写日志（替换计划 `:610` 的 `.catch(() => undefined)`）、删除条件收窄为「`assertSafePathSegment` 通过 **且** 带中立稳定前缀」并写成显式不变量、计划补残留口径。**不新增**收尾观测/tombstone，不改 `turn-scheduler.ts`，不改 `App.tsx:3239-3275` 的删除流程 | `sessions.ts`、`sessions.spec.ts`、计划文档 | `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts`；四条既有钉子（`:1521`/`:2240`/`:2563`/`:2869`）不改一字仍绿 |
| 4 | P2 | 收窄自动项目回滚，覆盖完整创建阶段、空目录和所有权条件（B3 已降级，不阻断开工） | `routes.ts`、`automations-store.spec.ts` | `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-store.spec.ts` |
| 5 | P1 | 补 T1–T6 的测试：T1 两层（`concurrentTurn.spec.ts` 行为层 + `appWiring.spec.ts` 接线层，并**重写计划 Task 3 Step 1.3 那条长正则**——它匹配的是被步骤 0 取代的写法）；T2–T6 的行为与错误路径 | 计划既有测试文件 + `concurrentTurn.spec.ts` | 对应任务定向 Vitest 命令 |
| 6 | P2 | 更新过期注释与测试名（§6 第 1、2、3、5、6 条；第 4、7 条已撤回） | 本文 §6 所列文件 | 定向测试 + 文本核对 |
| 7 | P2 | 处置 E5：为 `workspace-automations/` 与 `workspace-projects/` 的孤儿目录选定「随 `automation.remove` 清理」或「写进诚实口径并接受累积」 | `routes.ts`、`automations-store.ts` 或计划文档 | 视选择：定向测试或文档核对 |
| 8 | P2 | 完成真实双标签与自动化创建/编辑验收（T7） | 产品界面或验收脚本 | 留存实际步骤、结果和未验证平台 |

原 Task 1–8 的依赖顺序可继续使用，但应把上述修订并入对应任务，而不是把所有修正拖到最后一个任务。**两项裁定（D5 = E、T1 = F）均已给出，步骤 0 不再是决策门，本表全部为实现任务。**

## 8. 失败模式与范围边界

| 失败模式 | 计划需要的处理 | 用户可见性 |
| --- | --- | --- |
| 会话目录创建失败 | D2：不发送、保留草稿、显示错误 | 明确错误，可重试 |
| 活跃会话删除 | **D5 = E**：日志、UI 与物理目录都立即删；`rm` 失败写日志不抛出；删除条件收窄为「安全分量 + 中立稳定前缀」 | 删除立即生效。**已接受的可见后果**：该轮剩余工具写可能因目录已删而失败，而这一轮在界面上已不存在 |
| 在途删除的残留 | 子代理收尾期间可能重建部分目录；启动清扫不回收（只遍历已登记项目根，且 `workspace-sessions` 在 `protectedRoots` 内）——与 E5 同源，计划须写明 | 用户不可见；目录可能残留 |
| 已删会话被陈旧标签再次发送 | 立即删 ⇒ `existsSync(mintedRoot)` 为假 ⇒ 推导回落中立根（**fail-closed，E 保留了这个性质**）。这是 E 优于 C 的一条：C 需要 tombstone 才能达到同样效果 | 不得出现「已删会话又开始跑」 |
| 自动项目创建中途失败 | 全阶段、空目录且自有所有权的安全回滚；放弃回滚时注册表条目与目录一并保留并记日志（B3，P2） | 不得静默删除他人内容 |
| 存量自动化建目录失败 | 现有内层 catch 记失败并释放准入 | 运行记录应显示失败 |
| 已删项目自动化 | 执行前记 `MISSING_PROJECT_OUTPUT`，不建空目录 | 明确失败记录 |
| 删除自动化 / 删除项目后的孤儿目录（E5） | **当前无任何回收路径**：`automation.remove` 只删运行会话日志（`routes.ts:1177-1178`），`project.remove` 按设计保留 `workspace-projects/<id>`，而启动清扫只遍历**已登记**项目根。须选定「随删除清理」或「写进诚实口径并接受累积」 | 用户不可见；目录随 profile 生命周期累积 |
| 进程在回滚或延迟清理期间退出 | 诚实记录可能残留，不声称跨文件事务或必然补扫 | 可能留下空项目或目录 |

继续不在本轮范围内：修改 `deepseek-harness/`、改 `TurnScheduler` 核心互斥原语、迁移 `work-1`、把词法沙箱改成 realpath 沙箱、把两个注册表改成跨文件事务、隐式新增启动孤儿目录补扫。

> 与 D5 的关系（2026-11-08 裁定后订正）：B2 反证 2 指出「等根写者释放」的观测点在 `turn-scheduler.ts` 内，而该文件在计划禁改范围里。**选 E 之后这条约束不再产生成本**——E 不等待收尾，因此不需要任何观测点，`turn-scheduler.ts` 与 `sessions.ts` 的回合生命周期代码都不用动，改动面收敛到 `removeSession` 内的 `rm` 一行加日志。这也是 E 相对 A/B/C 的主要优势：A/B/C 三者都要么碰禁改文件、要么在 `sessions.ts` 新造收尾登记机制。

## 9. 性能与发布面

未发现新的性能阻断项：

- 中立前缀推导增加固定路径的 `existsSync` / `statSync`，不是按目录条目数扫描。
- 项目注册表锁沿用现有进程内 Promise 链形状。
- **无延迟删除**（D5 = E）：清理与删除 RPC 同一次调用内完成，不产生后台任务，因此不存在无界积累问题。这是 E 相对 C 的一项附带收益。

**磁盘占用（E5，2026-11-08 复核新增）：** 不是热路径问题，但是无界累积问题。`workspace-automations/<automationId>` 在自动化删除后无人回收，`workspace-projects/<projectId>` 在项目删除后按设计保留，两者都不在启动清扫的遍历范围内（清扫只走已登记项目根，且计划把 `neutralAutomationsBaseDir` 加进 `protectedRoots`）。单条为空目录时开销可忽略，但没有任何 UI 入口或后台任务会让它们消失。处置见 §7 步骤 7。

本计划不新增制品、依赖、发布通道或 CI/CD 分发路径。无需为本次改动新增发布架构。

## 10. 本轮实际验证记录

### 基线 A：会话、沙箱与接线

```bash
corepack yarn --cwd dsh-plugin-huaanwork vitest run \
  tests/huaanwork-guardrails/sandbox-cwd.spec.ts \
  tests/huaanwork-host/writable-root.spec.ts \
  tests/huaanwork-host/sessions.spec.ts \
  tests/huaanwork-host/session-sweep.spec.ts \
  tests/client-huaanwork/appWiring.spec.ts
```

结果：**5 个测试文件、180 条测试通过**，进程退出码 0。

### 基线 B：自动化、路由与组件

```bash
corepack yarn --cwd dsh-plugin-huaanwork vitest run \
  tests/huaanwork-host/stores.spec.ts \
  tests/huaanwork-host/automations-store.spec.ts \
  tests/huaanwork-host/automations-host.spec.ts \
  tests/huaanwork-host/automation-scheduler.spec.ts \
  tests/huaanwork-host/routes.spec.ts \
  tests/huaanwork-host/route-contract.spec.ts \
  tests/client-huaanwork/automations-runs-delete.spec.ts
```

结果：**7 个测试文件、198 条测试通过**，进程退出码 0。

合计：**12 个测试文件、378 条测试通过**。这些结果只证明当前基线和命令有效，不证明计划中的未来实现正确。

### 2026-11-08 复核重跑

两组命令按原样重跑（HEAD 仍为 `e3d62edf68`，分支未变），结果**逐字复现**：基线 A = 5 文件 / 180 通过 / exit 0（duration 2.81s），基线 B = 7 文件 / 198 通过 / exit 0（duration 37.21s）。本文 §10 的数字经独立复核成立。

复核同时把本文其余断言逐条回到源码与夹具核对，结果记录在各条的「2026-11-08」标注里：§2 全表、B1 证据链、B2 竞态证据、B3 事实、§6 第 1/2/5 条与级联边界、T2–T6 的可行性与夹具存在性（含 `startInFlightRun` 已在 `automations-store.spec.ts:6` 导入、`chmodSync` 故障注入先例在 `:1117`/`:1139`）均已核实；被撤回或订正的是 §6 第 4/7 条、B2 的处置、B3 的严重度、T1 的测试缝与文件计数。

本轮没有运行完整 `corepack yarn typecheck`、`corepack yarn test` 或真机 GUI 验收；计划实施后仍须执行原 Task 8 和本文补充的验收。

## 11. 评审覆盖限制

- Reality rows：7/7 发出并通过格式检查，未验证前提计数 0。
- Architecture：2 个问题（B2 竞态、B4 未使用导入；B4 为 2026-11-08 复核新增）。
- Code quality：3 个问题（数量不变，成员经复核调整：原第 3 条 `automations-store.ts:74` **撤回**——计划 Task 4 已覆盖；替补为 `logic/projects.ts:21` 的过期注释。现成员 = §6 第 1、2、3 条）。
- Test：7 个必须补强的覆盖缺口（T1–T7）。原记「7 个覆盖缺口」数量相同，但把 T1 当成可直接落地的一条；经复核 T1 的原始验证手段（mock RPC 驱动组件）在本仓不可实现，已由 D6 裁定为「抽取判定函数 + 两层测试」。T2 的原始前提（「只测静态会话删除成功」）经复核**不成立**，缺口已收窄并改写。
- Performance：0 个阻断项；1 个无界累积项（E5，2026-11-08 复核新增，非阻断）。
- **未解决决策：0。** 两项裁定均已由 owner 于 2026-11-08 给出：**D5 = E**（活跃会话物理目录删除时序）、**D6 = F**（T1 的测试形态）。D5 的两次翻转（原 D3/A 作废 → 复核推荐的 A 被证伪 → 裁定 E）与全部证据留在 §4 决策历史与 B2，D6 的依据与边界留在 §4 与 §5 T1 说明，防止后续重复提案或过度声称。
- 独立第二意见：2026-11-07 轮 **unavailable**（Codex CLI 未安装；原生 Plan 子代理未能在五分钟内形成完整报告，已停止）。2026-11-08 轮由本仓内独立复核补齐：对原文每条断言重跑源码/夹具核对与基线实跑，新增 B4（编译缺口）与 E5（孤儿目录），并订正/撤回 9 处（B2 处置与定性、B3 严重度、T1 测试缝、T2「只测静态删除」的错误前提、生产文件计数、§6 原第 3/5/6 条）。复核过程中我自己推荐的 A 也被同一套方法证伪并记录在案。**这仍是同一仓库内的复核，不得声称获得外部模型的第二意见覆盖。**
- 评审结论基于上述静态证据与现有测试基线；没有发现的问题不等于未来实现已验证。

## 12. 进入实施的门槛

只有以下条件全部满足，才应把计划状态改为“可实施”：

- [x] **D5 已由 owner 裁定 = E**（2026-11-08，保留立即删 + 收窄与诚实口径），裁定结果、依据与两次翻转历史已回写本文 §4 与 B2。
- [x] **T1 的测试形态已由 owner 裁定 = F**（2026-11-08，抽取判定函数 + 两层测试），裁定结果、落点、函数签名与诚实边界已回写本文 §4（D6）与 §5 T1 说明。**本文无未决裁定。**
- [x] B1 类型缺口已写入 Task 7，`logic/projects.ts`、`rpc-types.ts`、`logic/concurrentTurn.ts` 均已进文件清单，生产文件计数为 **13**。
- [x] B4 已写入 Task 5：旧导入明确替换而非并存。
- [x] D6 已落地为计划片段：纯函数、App catch、两层测试与诚实边界均已写明。
- [x] B2 已按 **D5 = E** 落地到计划：立即删、失败日志、收窄条件、残留口径与禁改边界完整。
- [ ] **实施后验证**：`sessions.spec.ts:1521`、`:2240`、`:2563`、`:2869` 四条既有删除钉子不改一字仍通过。文档评审不能预先勾选运行结果。
- [x] B3 已覆盖完整创建阶段；第二轮进一步改为非递归 `rmdir`、读取失败 keep、登记删除失败恢复空根，并补真实路由测试。
- [x] T1–T6 已落入具体测试文件、真实 helper、输入、断言和验证命令；T4 含路由级 keep/补偿，T6 含当前轮与下一轮。
- [x] E5 已选择「诚实口径并接受累积」，且不再声称另有回收路径。
- [x] T7 已列为 Task 8 的完成标准。
- [x] 过期注释、测试名、级联删除与撤回条目口径已同步。
- [ ] **实施后验证**：定向测试、全仓 typecheck/test 和真实界面验收全部留有结果。

**第一轮门槛的文档部分已完成；运行结果保留为实施后门禁。第二轮 double-check、对抗性复核与最终 PASS 见 §13–§14。不得把基线测试全绿写成计划已实施验证，也不得把接线层断言声称为渲染级验证。**

## 13. 第二轮 double check：对修订计划复审结论的再核验（2026-11-08）

### 13.1 复核口径与纠偏

这一轮不是把上一轮结论直接并入计划，而是逐条回到当前源码、测试和设计。复核对象仍是 HEAD `e3d62edf68`；产品源码没有工作树改动，计划中的函数与测试均未实施。

- **没有证据把任何一项写成当前生产故障。** 回滚、imports 与测试片段都是计划中的未来改动。下文使用「P1 = 阻断计划原样实施」与「P2 = 同批必须完成的加固/证明」，不把计划缺陷等同于线上 CRITICAL。
- **回滚风险保持 B3 的 P2 分级。** 「空检查后 recursive `rm`」和注册表失败处理确实是拟议代码缺陷，但发生在自动建项目失败的窄窗口；不得写成当前用户数据已经受损。
- **chmod 是测试可移植性缺口，不是现有 Windows CI 必红。** `.github/workflows/ci.yml:119-176` 的 Windows job 只跑平台打包检查与 liveness，不跑完整 Vitest；但开发者在 Windows 本地运行这些测试时，POSIX mode bits 不会产生预期失败，所以仍须按既有先例补 `test.skipIf(process.platform === 'win32')`。
- **UI `projects: []` 是夹具待扩展，不是生产缺陷。** `automations-runs-delete.spec.ts:90-118` 已有 jsdom + `createRoot` 的真实组件渲染，只需让 `mount` 接收项目列表。
- **T6 的缺口是缺少原评审要求的证明，不表示现有冻结根代码已出错。** `automations-host.ts:750-765` 确实按值构造 `admission.root`；计划不能自行用这句结构性分析替代原评审明确要求的回归测试。

核心事实没有发现需要撤回为「误报」的条目；需要纠正的是上一轮的严重度、Windows CI 含义与「纯函数测试没有价值」这类过宽读法。纯函数测试对判定逻辑有效，缺的是路由副作用证明。

### 13.2 逐条确认、降级与修复要求

| 复审项 | double-check 结论 | 当前证据与准确处置 |
| --- | --- | --- |
| B1 / B4 | **已关闭（计划文本）** | `AutomationPatch.projectId`、13 文件清单与旧导入替换均已落计划；实施后仍须 typecheck 验证 |
| D5=E / D6=F | **已关闭（计划文本）** | 立即删除、日志、残留口径、纯函数与两层测试均已落计划；不重开 A/C 或渲染整个 App |
| Task 2 重复导入 | **确认，P1** | 计划新 import 块含 `neutralWorkspaceRoot`，而 `writable-root.spec.ts:12` 已有同名绑定；必须合并到既有 import |
| Task 6 `ProjectInfo` 来源 | **确认，P1** | `stores.ts:5-11` 只 import 不 export；`routes.ts` 应从 `../client-huaanwork/rpc-types.ts` 补类型 |
| Task 4 `assert` | **确认，P1** | `stores.spec.ts:4` 使用 Vitest `expect`，无 `assert`；测试也受 `tsconfig.tests.json` 类型门禁覆盖。优先改用既有 `expect`，不新增导入风格 |
| T5/T6 helpers | **确认，P1；名称部分已有逃生句** | 计划已允许替换 helper 名，但仍须明确：`startAutomation` 返回 `{ runId, root, done }`；`scriptTask(profileDir, command, patch)`；没有 `makeProject`/`h.root`；项目根用临时目录 + `mkdirSync` 建立 |
| 回滚空检查后 recursive `rm` | **确认，B3=P2；非当前生产缺陷** | 计划 `:1178-1190` 的真实文件系统顺序可删除检查后到达的文件。最终删除改为非递归 `rmdir`；`ENOTEMPTY` 时登记与目录都保留并写日志 |
| `listAutomations` / `removeProject` 失败 | **确认，B3=P2** | `catch(() => [])` 把未知引用当无引用；吞掉 `removeProject` 失败后继续删根会破坏登记/目录一致性。读取失败直接 keep + log；若空目录已删而登记删除失败，立即尝试 `mkdir` 恢复空根并保留登记，恢复失败也写日志 |
| T4 路由 keep 覆盖 | **确认，证明缺口** | 纯函数用例保留，但不能证明路由采集输入和副作用。用既有 `withAutomationRegistryLock` 暂停 `createAutomation`，`vi.waitFor` 等 `projects.json` 落盘，分别注入非空文件与另一自动化引用，再释放锁并强制原创建失败；无需生产 mock 缝 |
| T6 当前轮 + 下一轮 | **确认，证明缺口** | 用既有 `startAutomation` + `holdCommand` 让首轮停在 p1，首轮在途时直接调用 store `updateAutomation` 模拟 check-then-act 窗口；相对 marker 只许落在 p1。释放后第二轮用 p2，并断言 `recentRuns` 输出 |
| chmod 平台条件 | **确认，P2；不是现有 CI 阻断** | 两条既有先例分别在 `automations-store.spec.ts:1107/:1131` skip Windows；新增 T2/T4 同样处理。保留既有「root 下权限注入可能失效」环境限制，不声称全平台覆盖 |
| UI mount 项目列表 | **确认，P2 夹具补全** | `mount(options)` 增加可选 `projects?: ProjectInfo[]`，渲染时 `projects: options.projects ?? []`；现有调用方保持缺省 |
| E5 / 级联 / 修订记录 | **确认，文档修正** | 「残留由其他路径回收」与 E5 不回收矛盾；补 direct `session.remove` 不覆盖 project/automation 级联的边界；§6 撤回的是原第 4/7 条，第 6 条测试改名仍须执行 |
| 旧签名与夹具描述 | **确认，文字修正** | 当前 `removeSession` 只有 3 参，是新增 opts 第 4 参而非替换既有 profileDir 参数；sweep 夹具的项目根是 profile 的祖先而非 profile 本身；Task 6 红色命令须包含新增 T6 所在的 automations-host spec |

### 13.3 回滚修正的既定合同

不引入跨文件事务或新锁。`rollbackAutoProject` 按以下顺序才算满足 B3：

1. `readdir` 或 `listAutomations` 任一读不到 ⇒ 不删，写日志。
2. 非空或已有引用 ⇒ 项目登记与目录都保留，写日志。
3. 确认可撤时，先对项目根调用非递归 `rmdir`。若迟到文件使它变成非空，`rmdir` 失败，登记仍未动，保留现场并写日志。
4. `rmdir` 成功后才删除项目登记。若 `removeProject` 失败，尝试用 `mkdir(projectRoot, { recursive: true })` 恢复刚删的空根，保留登记并写日志；恢复本身失败也只能记录，不得伪称事务已回滚。
5. 向外抛出的仍是原始 `createAutomation` / `createProject` 错误。

这仍不消除两个注册表之间的全部并发窗口；它保证的是「不因回滚递归删除用户内容，且已知失败路径不静默破坏登记/目录一致性」。

### 13.4 第二轮进入实施的门槛

- [x] 四项 P1 导入/类型/helper 硬错误已在计划片段中修正，且生产与测试导入均明确要求替换/合并而非重复追加。
- [x] 回滚片段符合 §13.3 五步顺序，不再使用 recursive `rm`，不再把读取失败当无引用。
- [x] T3、T4 路由测试包含成功回滚、非空保留、并发引用保留、引用读取失败与登记删除失败恢复；纯函数用例保留但不冒充路由覆盖。
- [x] T5/T6 使用真实 `scriptTask` / `startAutomation` / `holdCommand` 接口；T6 同时证明当前轮旧根与下一轮新根。
- [x] T2/T4 及登记删除失败的 chmod 用例按既有先例 skip Windows；UI mount 可注入项目且既有调用不变。
- [x] E5、级联删除、§6 撤回项、函数签名、夹具说明与各红色测试命令一致。
- [x] 独立对抗性文档审查及修复后复核完成，结果见 §14；没有剩余的照抄即红、未裁定行为变化或自相矛盾。

**第二轮结论：计划文本修订已完成；对抗性复核结果为 PASS（§14）。实施后的 typecheck、Vitest 与 T7 真机验收仍是独立完成门，不因文档通过而预先视为通过。**

## 14. 对抗性复核与最终判定（2026-11-08）

### 14.1 独立审查结果

1. **Momus 全量计划复核：OKAY。** 逐项核对 §13.4、真实接口、任务顺序和 D2–D6，没有发现计划阻断项。它另指出生产 `writable-root.ts` 的旧导入需要明确整体替换，该说明已补入 Task 2。
2. **原生 Plan 片段复核：首轮发现 4 项，均已修正。**
   - `remove-fails` 用例原断言日志含 `project.root`，而成功补偿路径只记录 `project.id`；断言已改为 `project.id`，与实现一致。
   - Task 5 现明确补 `automationAdmissionRoot`、`neutralAutomationRootPath`、`dirname`，并给 `automation-scheduler.spec.ts` 补 `automationAdmissionRoot`；Task 6 明确不得重复导入。
   - `startInFlightRun` 用例现按 `automations-store.spec.ts:982-997` 的先例用 `finally` 删除 `update-in-flight`。
   - `writable-root.ts:1-4` 的生产导入现明确要求整体替换，避免追加重复绑定。
3. **跟进原生 Plan 复核：PASS。** 它逐项验证上述修复及相邻代码，确认锁门不会死锁、四种回滚模式的故障注入可达、原始错误不被补偿错误替换、T6 冻结旧根与下一轮新根的夹具链成立，且没有重复导入。

### 14.2 覆盖与证据边界

- 本轮证据是**静态源码/夹具核对、计划文本追踪和独立原生评审**。没有实施计划中的未来代码，也没有把任何新测试写成已运行通过。
- Codex CLI 未安装。最终限时原生 Plan fallback 在五分钟内没有形成完整报告，已停止并记为 unavailable；它不构成外部模型覆盖，也没有推翻上述已完成的 Momus/Plan 同步评审。
- 无未决产品或架构决策。D2、D3、D4、D5=E、D6=F 全部保持；回滚修正属于 B3 的既定安全合同。
- 进入实施后，仍须执行任务自身的红→绿验证、Task 8 的 typecheck/全量 Vitest，以及 T7 真机验收。Windows chmod 用例是显式跳过，不是 Windows 权限失败覆盖。

**最终判定：PASS。计划已达到可实施标准；剩余未勾选项仅是实施后的运行验收，不是计划文本阻断项。**

> **2026-11-08 第三轮订正**：上面这句 PASS 被第三轮复核推翻了一项——T6 存在一处「照抄即红」的断言缺陷，与 §13.4 最后一条和 §14.1 第 3 点的表述矛盾。详见 §15。两处缺陷已修入计划，修订后结论见 §15.3。

## 15. 第三轮复核：两处幸存的测试断言缺陷（2026-11-08）

### 15.1 复核口径

第二轮（§13/§14）确实修掉了第一轮修订引入的多处真缺陷，逐条核实成立：`ProjectInfo` 在 `stores.ts:5-11` 只是 `import type` 而非导出、`stores.spec.ts:4` 用 Vitest `expect` 无 `assert`、`scriptTask` 第 2 参是命令字符串、`startAutomation` 返回 `{ runId, root, done }`、不存在 `runOnce`/`makeProject`/`h.root`、`.catch(() => [])` 会把「引用读不到」误判成「无引用」、E5 与 Failure modes 的自相矛盾。回滚改为非递归 `rmdir` + 登记失败补偿也是实质改进。**这些不撤回。**

但 §14 的 PASS 声称「没有剩余的照抄即红」，第三轮对**测试断言本身**（而不只是 helper 名与导入）逐条推演后，找到两处幸存缺陷。两者都不在 §14.1 记录的三轮评审发现清单里。

### 15.2 两处缺陷与证据

**F1（P1，照抄即红）：T6 取错了运行记录的索引。**

- 计划原文：`expect((await recentRuns(h.profileDir, task.id))[0]?.output).toBe(await realpath(p2.root))`，位于第二轮修订后的 T6 用例末尾，此时该自动化已跑过**两轮**。
- `appendRun`（`automations-store.ts`）写的是 `const lines = [...existing, clipped].slice(-RUNS_LIMIT)` ⇒ **追加，时间顺序**。
- `recentRuns`（`stores.ts`）按文件行序 `runs.push(...)` 后 `return runs.slice(-limit)` ⇒ **`[0]` 是最旧的一轮**。
- 既有顺序证据：`automations-store.spec.ts:1179` 在 `[r1, r2]` 删掉 r2 之后断言 `['r1']`。
- T6 首轮命令是 `holdCommand('first-cwd.txt', release)`，其脚本只 `fs.writeFileSync` + `Atomics.wait`，**没有任何 stdout**；第二轮才是 `nodeEval('process.stdout.write(process.cwd())')`。
- ⇒ `[0]` 是首轮（空输出/runner 脚注），断言它等于 p2 的 realpath **必然失败**，即使实现完全正确。实施者会在 Task 6 Step 4 看到红，进而误以为是实现有问题。
- **已修**：改为 `[1]`，并在计划里写明排序依据与既有证据行。

**F2（P2，空断言 / 过度声称）：T5 用 `activeTurnCount()` 证明「准入已释放」。**

- 计划原文：`expect(h.scheduler.activeTurnCount()).toBe(0)`，注释写「准入已释放：同一根上的下一次运行不再被 root-busy 挡住」。
- `turn-scheduler.ts:72`：`const countsTowardCap = (kind) => kind !== 'script-automation'`。
- `:131`：脚本写入的 writer kind 是 `'script-automation'`；`:135`：`if (input.countsTowardCap) activeTurns += 1`；`:144`：释放时同样只在 `countsTowardCap` 时 `-1`；`:206-208`：`activeTurnCount()` 直接返回 `activeTurns`。
- `startAutomation`（`automations-host.spec.ts:300-320`）传的是 `countsTowardCap: automation.kind === 'agent'`，而 T5 用 `scriptTask` ⇒ `false`。
- ⇒ 本用例全程 `activeTurns` 恒为 0，**无论 `admission.release()` 是否被调用，该断言都通过**。它证明不了注释声称的东西，而 T5 的价值卡写的正是 `protects=mkdir 失败进入失败收口并释放准入`。
- **已修**：改为用 `startAutomation` 返回的同一个 `root` 键再准入一次，断言 `{ kind: 'start', root }`（而非 `{ kind: 'skip', reason: 'root-busy' }`），直接探测 `rootWriters` 是否清空，随后 `release` 掉探针；并在计划注释里写明为什么不能用 `activeTurnCount()`。

### 15.3 修订后结论

- 两处均已修入计划（`docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md`）。同类缺陷全仓扫描：`activeTurnCount()` 仅剩解释性注释、无其他 `recentRuns(...)[0]` 多轮误用、无占位式逃生句残留。
- **F1 使 §14 的「已达到可实施标准」在修订前不成立**（一条测试对正确实现必红）。修订后该阻断消除。
- F2 不阻断执行，但属于本轮评审流程本应拦下的过度声称；记录在此以免同类断言再次被当成覆盖证据。
- 证据边界不变：本轮仍是**静态源码/夹具核对与计划文本推演**，没有实施未来代码，没有把任何新测试写成已运行通过。Task 8 的 typecheck、全量 Vitest 与 T7 真机验收仍是独立完成门。

**第三轮最终判定：修订后 PASS。计划文本无已知阻断项；但「无阻断」的结论只对当前文本成立，实施时仍须按各任务的红色命令实跑验证——F1 正是只靠读文本推演才发现、而三轮评审都漏掉的那一类。**
