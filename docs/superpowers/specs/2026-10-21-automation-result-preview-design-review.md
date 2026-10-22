# 《自动化结果预览、运行记录删除与停止》规格评审意见

- **评审对象**：`docs/superpowers/specs/2026-10-21-automation-result-preview-design.md`（v1 草案 → 同日 v2 修订稿）
- **评审日期**：2026-10-21
- **评审方式**：第二轮复核稿。第一轮为口头意见；本轮对每条结论在源码上重新取证，标注处置（维持/订正/收窄），并对两个易误报点做了专项排查（见 §一）
- **评审结论（对 v1）**：**有条件通过**——§3「已核实的现状」11 行经逐条复核**无一失实**，R1–R5 覆盖与验收框架成立，范围承诺（只改 `dsh-plugin-huaanwork`、zero-touch）经变体守卫模型核实成立；但存在 **P1×2**（批准前必须裁定）与 **P2×4**、**P3×6**
- **修订复审（对 v2，2026-10-21 同日）**：Cursor 按本文全部 P1/P2/P3 修订设计稿（§3 扩至 17 行、§5 补下载载体、§6 补释放与锁内回写、§8 增设在途表与档位消费、§9/§10 同步）。逐条复审结论见 §六——**P1×2、P2×4、P3×6 全部消解**（P3-3 留一窄残余）；修订新引入的 4 项事实断言逐条核实为真；新发现 **P3×1**（§6 回写基准的残余 TOCTOU）与实施注记×2。**结论：通过，可批准进入实施计划**
- **第三轮复审（对 v3，2026-10-21 同日终审）**：v3 补入回写重读（§6）与在途时序（§8）。逐条复审结论见 §七——**N-P3-1 与实施注记×2 全部消解**，其中 §6 锁内重读方案经交错分析证实**完全闭洞**；v3 新断言 4 项核实为真；新发现仅 1 条理论残余（毫秒级窗口，可不修）与 1 条文档措辞观察（无需修改）。**结论：通过（终审），无阻塞项，可批准进入实施计划**

---

## 一、复核说明（第一轮意见的二次核查处置）

| 第一轮意见 | 处置 | 复核要点 |
|---|---|---|
| P1-1 排队轮停止后复燃 | **维持**，补可达性限定 | `nextRunAt` 唯一推进点确认在 `executeRun` 开头的 `markAutomation`（`automations-host.ts:443` + `automations-store.ts:405-408`）；跳过排队轮不经过该点 ⇒ 残留过去时刻。可达性收窄：仅非 manual 调度、且主要是脚本槽位竞争场景（见 P1-1 正文） |
| P1-2 下载机制无载体 | **维持**，排除一个疑似反例 | `src/file-exporter.ts` 名称疑似文件导出先例，实为 **Cordis 日志导出器**（写 `LogFileSink`，`file-exporter.ts:12`），与用户文件下载无关；`preload.ts` 仅暴露 `getPathForFile`（`:22-24`，File→路径，方向是上传不是保存）；全仓 `setDownloadBehavior` 零命中，`will-download` 仅登录窗 preventDefault（`platform-login-window.ts:192`） |
| P2-1 删除未释放会话运行态 | **维持**，风险描述收窄 | 先例确认：`session.remove` 与 `automation.remove` 均先 `releaseSessionRuntime`（`sessions.ts:369-371`、`routes.ts:624-625`、`stores.ts:367/:389` 的 releaseSession 回调）。但运行会话 id 含 runId（UUID），「同名新会话继承旧状态」的原注释风险不适用；实际风险面见 P2-1 正文 |
| P2-2 停止的取消未命中 | **维持**，窗口实证 | run-start 发出到 agent 建成之间有多个 awaited fs 操作（`markAutomation` → `listProjects` → `mergedRunPrefix` → `sendToAgent`，`automations-host.ts:435-464`），cancel 空窗真实存在 |
| P2-3 「上次」显示取值源 | **维持** | missed 记录不回写 registry 确认（`automation-scheduler.ts:148-173` 只 `appendRun` + `advanceNextRunAt`/`updateAutomation`） |
| P2-4 排队轮 UI 不可见 | **维持**，重新定框 | `runningAutomationIds` 添加/移除点确认（`App.tsx:953`/`:990`）；属规格内部不一致而非回归（脚本排队期重复入队是既有行为） |
| P3「锁序防死锁」 | **订正** | 原表述夸大：既有代码对 append 锁与注册表锁均为**顺序 await、从不嵌套**（`finishAutomation` 先 `appendRun` 后 `markAutomation`），无死锁面。真实问题是 check-then-write 的 TOCTOU，见 P3-3 |
| P3 表格转义 | **维持**，措辞精化 | 规格 4.3 已写「不把字符串里的 `#`、`\|`、反引号再解释成 Markdown」——这只覆盖行内语义，不覆盖表格**结构**破坏，见 P3-1 |
| 「运行中的 runId 拒绝删除」分支 | **新增观察**（第一轮未提） | 该分支在当前数据流下不可达，且实现它需要一座尚不存在的 in-flight 登记簿——这座登记簿同时是 P1-1/P2-2/P2-4 的公共基座，见 P3-6 |

## 二、事实核查（§3「已核实的现状」11 行逐条）

| # | 规格声称 | 结果 | 出处 |
|---|---|---|---|
| 1 | 运行对话由 run-start 创建，结束只追加状态脚注 | ✅ | `App.tsx:953-976`（建标签）、`:989-1010`（run-end 追加 `runResultNoteText`） |
| 2 | 重启后 `historyToChatItems` 回填再补同一脚注 | ✅ | `App.tsx:1322-1364`（懒加载效果，脚注 `:1342`） |
| 3 | 助手正文按 token 追加到最后一条 assistant | ✅ | `App.tsx:3085-3091`（`appendToken`：尾部 assistant 续写，否则新建） |
| 4 | 入库产出是 token 拼接后去 `<think>` | ✅ | `automations-host.ts:233-237`（`stripModelThinking`）、`:301` |
| 5 | 右侧「预览」只在对话页、空占位 | ✅ | `App.tsx:2097`（`showRightPane = view === "main"`）、`:2633-2638` |
| 6 | 运行记录每任务一个 jsonl、上限 50 | ✅ | `stores.ts:255`（`RUNS_LIMIT = 50`）、`automations-store.ts:425-437` |
| 7 | 清理保留最近 50 条 sessionId + 进行中会话 | ✅ | `automations-store.ts:443-486`、`routes.ts:680-685`（collector keys 并入） |
| 8 | 运行中任务行按钮是禁用的「运行中…」 | ✅ | `AutomationsView.tsx:373-375` |
| 9 | 运行对话禁用发送、无停止入口 | ✅ | `App.tsx:2091`（`runTabLive`）、`:2472`/`:2607`（disabled）；停止按钮只挂在用户回合（`:2602-2605`，`turnActive && activeTab === turnTabRef.current`） |
| 10 | 取消会话有内部函数、无界面 RPC | ✅ | `automations-host.ts:248-251`（模块私有）；`rpc-types.ts:49-61` 方法表无对应项 |
| 11 | `lastStatus` 只有 ok/error/running | ✅ | `rpc-types.ts:165`；`RunSummary.status` 与 run-end 事件已含 `cancelled`（`:188`/`:271`），客户端已有「已取消」文案（`App.tsx:1018`、`runTabsLogic.ts:69`）——规格「不扩枚举、由运行记录显示 cancelled」与现状吻合 |

**附带核实**（支撑后续章节）：

- `runTabsToRebuild` 每任务只重建最新一条带 sessionId 的运行（`runTabsLogic.ts:44-51`）⇒ §6 删除记录后不会复活已关标签（被删记录不在 `automation.list` 返回集内）。
- `automation.run` 路由先 `assertAutomationIdle()`（agent 计数 > 0 即拒，`sessions.ts:87-91`）⇒ agent 任务在任意 agent 自动化排队/运行期间无法再手动入队；脚本任务不走该计数。
- 调度器 tick 对 agent 计数早退（`automation-scheduler.ts:111`），missed-skip 路径只写 runs 不碰 registry（`:148-173`）。
- `gen:styles` 脚本存在（`package.json:191`）；新落点文件均在 `src/client-huaanwork/`、`src/huaanwork-host/` 单侧前缀内，`routes.ts` 已在 M9 后的 64 项 beta↔huaanwork 分叉清单中——**变体守卫零新增成本，范围承诺成立**。
- `ChatItem`（`App.tsx:194-202`）与 `ChatTab`（`:217-234`）均在 App.tsx 内，扩附件种类与预览选择字段不越出 huaanwork。

## 三、问题清单

### P1-1 排队轮被停止后，同一档触发会在下个 tick「复燃」（§8）

「已入队但尚未发出 `automation/run-start`：跳过执行，不写运行记录」存在漏洞：`nextRunAt` 的唯一推进点是 `executeRun` 开头的 `markAutomation(running, startedAt)`（`automations-host.ts:443`；推进逻辑 `automations-store.ts:405-408`，完成时不再推进）。排队轮在到达 `executeRun` 前被跳过 ⇒ `nextRunAt` 停留在过去时刻 ⇒ 调度器下个 tick（60s）按 due-within-grace 再次入队**同一档触发**；超宽限则转 missed（skip 策略多出一条「已错过」记录）或 run-once 补跑。用户按了停止，60 秒后同一轮自己跑了——直接违反 R5。

- 与已开始路径不对称：已开始轮被取消时，其触发档位已在启动时消费（nextRunAt 已推进）；被跳过的排队轮同样应消费自己的档位。
- **可达性（复核后收窄）**：仅非 manual 调度受影响（manual 无 nextRunAt 语义）。任务行 UI 够不着纯排队轮（见 P2-4），实际触发面 = 脚本任务紧间隔 + 2 槽占满时，同一任务已开始轮 + 排队轮并存、用户停止后者；agent 任务仅同 tick 组入队的窄窗口。但规格 §8 明确设计并测试该分支（§9「尚未 run-start 的排队轮不写记录」），分支本身成立，缺陷随之成立。
- **修法（一句话）**：跳过排队轮时按 `nextFireAfter(schedule, <跳过时刻>)` 推进 `nextRunAt`，与 running 路径的「启动即消费档位」对称。该修法无论产品想把停止语义定为「只停这一轮」还是「档位照常」都必要——残留在过去的 nextRunAt 是**同一档**的复燃，不是新一档的照常触发。

### P1-2 下载机制无载体，「不弹另存框」承诺无实现路径（§5）

「保存到系统下载目录，不打开另存为对话框」在 client-huaanwork **零先例**：

- 无 blob/anchor 下载代码；RPC 方法表（`rpc-types.ts:49-61`）无任何文件保存项；`preload.ts` 仅暴露 `getPathForFile`（`:22-24`，File→磁盘路径，服务上传方向）。
- 主进程无任何下载接线：全仓 `setDownloadBehavior` 零命中；`will-download` 仅登录窗 preventDefault（`platform-login-window.ts:192`）。Electron 默认（未设 savePath / 未配 `setDownloadBehavior('allow', downloadPath)`）下载会弹保存框，承诺无法免费获得。
- **排除的疑似反例**：`src/file-exporter.ts` 是 Cordis 日志导出器（`file-exporter.ts:12`，developer-logging 家族），与用户文件下载无关。

规格需选定载体：(a) renderer blob 下载 + 主窗 `will-download` 处理器直接写 `app.getPath('downloads')/<附件名>`（改动落 huaanwork 侧窗口/会话接线，符合范围承诺）；(b) 新增 host 路由写文件（host 不知下载目录，需经桥传递，更绕）。建议 (a)，并在 §9 落点表补对应主进程文件。

### P2-1 deleteRun 删会话目录前未释放会话运行态（§6）

两条既有先例都要求「删文件前先摘运行态」：`session.remove`（`sessions.ts:369-371`）与 `automation.remove`（`routes.ts:624-625` → `stores.ts:367/:389` 的 releaseSession 回调）。§6 只写了删 jsonl 行 + 删目录，未提 `releaseSessionRuntime`。

风险收窄后的真实面：运行会话 id = `huaanwork-auto-<automationId>-<runId>`（`automation-session-ids.ts:7-8`，runId 为 UUID），「同名新会话继承旧状态」不适用；主要残留是 `ctx.agents` 里可能仍持有该会话的 idle agent 与 `forgetChildSessions`/`clearInvalidRoute`/`releaseRouteInput` 键控状态。**修复廉价（一次函数调用）且与两处先例一致**，建议规格补一句：删目录前对 sessionId 调 `releaseSessionRuntime`。

### P2-2 停止的「取消未命中」语义未定义（§8）

`cancelAutomationSession` 对不存在的 agent 是 no-op（`automations-host.ts:248-251`，可选链）。run-start 发出到 agent 建成之间有多个 awaited fs 操作（`automations-host.ts:435-464`），空窗真实存在。该窗口内 stop：接口按「已开始」路径返回成功，取消落空，run 跑完记 `ok`——用户按了停止却看到「成功」。

- 规格「与自然结束或超时竞态时，以先完成的那一次为准」只覆盖**结束竞态**，未覆盖**停止无效**。
- 建议规格写明：stop 先按 runId 标记 cancel-requested（turn settle 后 `executeRun` 依标记写 `cancelled`——这也是「中止这一轮并写 cancelled」的落地机制，规格隐含未写）；接口返回语义定为「已请求」；取消未命中时的最终态归属（跑完记 ok，或拖到超时记 timeout）明示其一。

### P2-3 「上次」显示取值源歧义，missed/timeout 连带改动面未声明（§8/§6）

任务行「上次」现读 registry `lastStatus`（`AutomationsView.tsx:408-413`）。规格「该显示读运行记录的 status」若实现为**通用**取值（读最新记录 status），则：

- missed 记录（不回写 registry，`automation-scheduler.ts:148-173`）成为最新记录时，「上次」会从「<真实执行时刻> · 成功」变成「已错过」，且时刻取 missed 记录的 `startedAt`（= 记录时刻，非执行时刻）——超出规格声定的改动面；
- timeout 会从「失败」（registry error）变成「超时」。

§6 回退规则的「其他终态写 error」亦未说 missed 的映射（missed 记录回填 lastRunAt/lastStatus 会把「从未执行」语义的 missed 记成一次执行）。建议钉死：显示仅在最新记录为 `cancelled` 时覆盖、时刻与其余状态仍读 registry；§6 回退跳过 missed 记录（registry 语义 = 上次真实执行）或明确映射。

### P2-4 排队轮在 UI 上不可见，§8 的排队跳过分支从任务行基本够不着（§8）

`runningAutomationIds` 只在 run-start..run-end 之间为真（`App.tsx:953`/`:990`），排队中的轮对 UI 不存在：任务行显示「立即运行」而非「停止」。后果：

- 纯排队轮无法从任务行停止（规格第一子弹只以「竞态」带过，实为**系统性**不可见）；
- 该分支实际可达面 = 同一任务「已开始轮 + 排队轮」并存时顺带触发（脚本紧间隔 + 槽位竞争；agent 仅同 tick 组入队窄窗口）——恰是 P1-1 的触发面；
- 排队期点「立即运行」会给脚本任务再叠一轮（既有行为，非本规格回归，登记即可）。

建议规格明示其一：排队期不可停止（接受），或把排队态纳入按钮判据（需 host 暴露排队信息，可与 P3-6 的 in-flight 登记簿合并解决）。

### P3 清单

| # | 问题 | 说明 |
|---|---|---|
| P3-1 | 表格单元格结构破坏（§4.3） | 规格「不把 `\|` 再解释成 Markdown」只覆盖行内语义；单元格内 JSON.stringify 或多行字符串含 `\|`/换行会在真实渲染器里破坏表格**结构**。应用内预览显示原文不受影响，仅下载的 .md 受影响。修法：单元格 `\|` 转义 + 换行替换，或声明接受 |
| P3-2 | 下载同名覆盖（§5） | 「结果.md/.html」固定名，多次下载互相覆盖（走 savePath 显式落盘时为静默覆盖）。可接受，建议规格写明或文件名带时间戳 |
| P3-3 | §6 回写的 TOCTOU（订正自第一轮「锁序」） | 既有代码两锁顺序 await、从不嵌套，无死锁面（第一轮表述夸大，订正）。真实问题：deleteRun 的「任务不是 running 才回写」若为锁外 check-then-write，会与新轮启动的 `markAutomation(running)` 竞态——`markAutomation` 无条件写（`automations-store.ts:388-411`），迟到回写会把 running 覆盖成旧值，任务卡在假状态直到下一轮结束。修法：running 判定纳入注册表锁内复查，或给 markAutomation 加条件模式 |
| P3-4 | RunsPanel 详情视图陈旧（§6） | 已打开的 HistoryDetailPane（`AutomationsView.tsx:526-529`）正展示被删运行的会话时应关闭或失效，规格未提 |
| P3-5 | 补一致性测试（§9） | live 折叠（run-end 时）与回填折叠（重启后）须产出一致附件内容——纯函数确定性是验收 #4 的依据，建议测试清单补一条两路径输出一致 |
| P3-6 | 「运行中的 runId 拒绝删除」不可达，且实现需要尚不存在的基础设施（§6，新增观察） | 运行记录只在 `finishAutomation`/missed/残留恢复时写入（`automations-host.ts:397`、`automation-scheduler.ts:83/:156`），执行中的 run **没有记录** ⇒ 该拒绝分支在当前数据流下不可达，属防御性设计（无害）。但要实现它需要一座 runId 键控的 in-flight 登记簿（现有 `automationCollector` 按 sessionId 键控，`automations-host.ts:82`）——**同一座登记簿也是 P1-1 的跳过+推进、P2-2 的 cancel-requested 标记、P2-4 的排队态暴露的公共基座**。建议规格在 §8/§9 把它提名为共享实现基底，避免四散各造 |

## 四、与原始需求对照（R1–R5）

| 需求 | 覆盖 | 备注 |
|---|---|---|
| R1 JSON 收起为附件 | 覆盖良好 | 判定与宿主入库规则同源（strip think → parse → 对象/数组才折叠），前后带说明的正文不折叠是诚实取舍；`__proto__` 跳过对 `JSON.parse` 自有属性语义正确 |
| R2 预览 + 下载 | 预览覆盖良好；**下载无载体** | sandbox iframe + 全量转义 + 无脚本外链的安全姿态到位；下载待 P1-2 裁定 |
| R3 删除单条记录 | 基本覆盖 | lastRunAt 回退、删光清字段、运行中拒绝（不可达但防御）齐全；待 P2-1（释放运行态）、P2-3（missed 映射）、P3-3（TOCTOU）补强 |
| R4 清理保留 20 条 | 覆盖良好 | 与 `RUNS_LIMIT` 分列常量、保留集逻辑改动最小、诚实声明「第 21 条点开可无完整会话」 |
| R5 停止运行中任务 | 骨架成立，**排队轮有复燃洞** | started 路径复用 `cancelAutomationSession` + 记 cancelled 与现有机制吻合；待 P1-1（nextRunAt）、P2-2（取消未命中）、P2-4（排队不可见）裁定 |

## 五、结论（对 v1）

事实基础扎实（§3 全部属实），主体设计（折叠判定、块树单一来源、sandbox 预览、复用既有取消/清理机制）方向正确。**批准前须裁定 P1-1（排队轮跳过时推进 nextRunAt）与 P1-2（下载载体选型）**；P2×4 建议随修订一并落文字（均为一段话量级）；P3×6 可登记为实施期开口项，其中 P3-6 的 in-flight 登记簿建议升格为 §8/§9 的显式共享基底。

---

## 六、修订复审（2026-10-21 同日，规格 v2）

### 6.1 原问题处置对账

| 原编号 | v2 落点 | 复核结论 |
|---|---|---|
| P1-1 排队轮复燃 | §8 在途表 + 档位消费四规则（once 停用去 nextRunAt / schedule 按跳过时刻推进 / catchup 不再推进 / manual 不改）+ §9 四条测试 + 验收 #7 | **消解**。四规则的既有语义基准逐条核实：schedule 规则与 `markAutomation` running 路径同函数同参照系（`automations-store.ts:405-408`）；once 规则与 `finishAutomation` 的**无条件**按 `schedule.kind` 停用一致（`automations-host.ts:403-405`，不分 trigger——manual 跑 once 任务完成后同样停用，规则 1 是忠实镜像而非新语义）；catchup 不再推进的前提经核实为真（见 6.2 #1） |
| P1-2 下载无载体 | §5 载体 (a)：renderer 发起下载 + `electron-shell-generation.ts` 主窗口会话 `will-download` 接管，仅限两个附件名，其他下载不接管；§9 纯函数抽取 + 测试；§2 声明同名覆盖 | **消解**。落点核实：主窗口确在该文件创建（`:319` `new BrowserWindow`；advanced 模式 renderer 即主窗 webContents，`:341`），同文件已有 `renderer.session.webRequest` 先例（`:144`）；「不新增变体白名单条目」核实为真（该文件 2026-10-15 起已在 beta↔huaanwork `allowedDifferences`，改内容不加条目） |
| P2-1 释放运行态 | §6「先对该 id 调用 releaseSessionRuntime，再…删除该目录」+ §9 断言调用次序的测试 | **消解**。次序与 `session.remove` 先例一致（release → unlink） |
| P2-2 取消未命中 | §8「标记仍然有效…即使用户停止时模型回合后来自己跑完，也不写 ok」+ 记录已落盘则返回未停止 + §9 两条测试 | **消解**。停止边界现在良定义：标记先于落盘 ⇒ `cancelled`，落盘先于停止 ⇒ 未停止；不再有「按了停止却记成功」的窗口 |
| P2-3 「上次」取值源 | §8 末段：仅最新记录为 `cancelled` 时覆盖状态词，时刻与其余状态仍读注册表，明示 missed/timeout 不连带；§6 回写跳过 `missed`、`lastRunAt` 取 `endedAt` | **消解**。`endedAt` 取值与 `finishAutomation` 的 `lastRunAt: endedAt` 语义一致（`automations-host.ts:382/:399-401`）；「删光真实运行去两字段」与 `lastRunLabel` 的 `!lastRunAt → 从未运行`（`AutomationsView.tsx:410`）吻合 |
| P2-4 排队轮不可见 | §2 明示不做排队期停止按钮 + §8「同任务一条 started + 一条 queued，一次停止两处都处理」 | **消解**（按「接受」路线明示） |
| P3-1 表格转义 | §4.3 单元格 `\|` 转义 + 换行写空格，HTML 单元格同压平再转义 + §9 测试 | **消解** |
| P3-2 同名覆盖 | §2/§5/验收 #2 声明覆盖行为 | **消解**（声明接受） |
| P3-3 回写 TOCTOU | §6「回写放在注册表锁内，锁内重新读取任务，读到 running 不改」+ §9 测试 | **大体消解，留窄残余**（见 6.3 N-P3-1） |
| P3-4 详情视图陈旧 | §6「运行记录详情若正打开这一条，关闭详情回到列表」+ 验收 #5 | **消解** |
| P3-5 一致性测试 | §9「运行结束和重启回填调用的是同一个函数」 | **消解**（同一纯函数 ⇒ 同一输出） |
| P3-6 在途表基座 | §8 首段：按 runId 索引、含任务 id/触发方式/阶段/取消标记，供停止、删除拒绝和档位消费共用；§6 诚实写明「执行中的轮次要到结束才写入运行记录，正常界面删不到它」 | **消解**（按建议升格为显式共享基底，不可达的拒绝分支转为诚实防御） |

### 6.2 修订新引入断言的核实

| # | v2 断言 | 结果 | 出处 |
|---|---|---|---|
| 1 | 补跑（catchup）在入队前已经 `advanceNextRunAt` | ✅ | `automation-scheduler.ts:144-145`（先 `await advanceNextRunAt(...)` 再 `void enqueueAutomation(..., { trigger: 'catchup' })`）——档位消费规则 3 的前提成立 |
| 2 | once 跳过停用「与已经开始的一次性任务结束后的注册表结果一致」 | ✅ | `automations-host.ts:403-405` 的停用**不分 trigger**（manual 跑 once 任务也停用并经 `updateAutomation` 重算删去 `nextRunAt`，`automations-store.ts:330-335`）——一致性主张准确 |
| 3 | 主窗口在 `electron-shell-generation.ts` 创建 | ✅ | `:319` `new BrowserWindow`；advanced 模式 `isolated=false` ⇒ renderer = 主窗 webContents（`:341`），huaanwork 客户端恰在 advanced 模式 ⇒ 接线落点正确 |
| 4 | 该文件已是声明差异，不新增白名单条目 | ✅ | 债表「变体守卫既有红」行：2026-10-15 裁定选项①，`allowedDifferences` 22→23 收录 `electron-shell-generation.ts` |

### 6.3 新发现

**N-P3-1（P3）§6 回写基准的残余 TOCTOU（P3-3 的窄残余）**

v2 把 running 复查放进了注册表锁内，但回写**基准**（「剩下的记录里 startedAt 最新的真实运行」）是在此之前的运行记录锁里读的。若一轮在两次锁之间完整走完 start→finish（appendRun 已写入、`lastStatus` 已是终态），锁内复查读到的是**终态而非 running**，回写按旧基准执行，会把这轮刚写入的 `lastRunAt`/`lastStatus` 覆盖成旧值。可达性：仅亚秒级脚本任务在删除操作的毫秒级窗口内恰好完成一轮；后果自愈于下一轮结束。修法（一句话量级）：回写基准的计算移入注册表锁内重读（或 deleteRun 内双锁嵌套，append→registry 顺序与既有顺序一致、无反向持锁者，无死锁面）。

**实施注记（不阻塞批准，建议带入实施计划）**

1. **runId 生成前移**：在途表「入队时写入 `queued`」且以 `runId` 索引 ⇒ 定时/脚本轮的 runId 生成须从 `runBound` 的 `meta.runId ?? randomUUID()`（`automations-host.ts:512`）前移到入队点，否则表里没有键。机械改动，v2 设计隐含。
2. **同步段约束**：§8「执行体进入 `executeRun` 之前看到标记就返回」与 run-start 发射 + 阶段翻转（queued→started）必须落在同一同步段（中间无 await）——事件循环单线程即按构造关死相位竞态；日后若有人在检查与发射之间插入 await（哪怕一行日志），窗口重新打开。建议实现处留一行注释钉住。

### 6.4 复审结论（对 v2）

**通过，可批准进入实施计划。**P1×2、P2×4、P3×6 全部消解且消解方式与既有代码语义对齐（非补丁式特判）；修订新断言 4 项全部核实为真；新发现仅 N-P3-1（窄残余 TOCTOU，一句话修法）与两条实施注记，均可登记为实施期开口项，无需再修规格。

---

## 七、第三轮复审（2026-10-21 同日终审，规格 v3）

v3 改动精确对应 §6.3 的三项：§6 回写重读（N-P3-1）、§3+§8 的 runId 前移与在途时序（注记 1）、§8 同步段不变量（注记 2）。其余章节与 v2 逐字一致（§1/§2/§4/§5/§7/§10 未动，§3 仅增一行、§9 仅扩两条测试）。

### 7.1 处置对账

| 原编号 | v3 落点 | 复核结论 |
|---|---|---|
| N-P3-1 回写基准残余 TOCTOU | §6「进入注册表锁之后**重新读取运行记录文件**，用这份新内容计算基准，不用删行当时留下的快照」+ 显式要求「删行之后、回写之前若已有新的真实运行落盘，回写必须看见它」+ §9 对应测试 | **消解；删行后新运行落盘方向闭洞；被删运行自身收尾的残余见补记**。论证：并发轮的 `finishAutomation` 是顺序持锁（先 `appendRun` 后 `markAutomation`，`automations-host.ts:397-402`）。设 deleteRun 持注册表锁重读——(a) 若并发轮的 `markAutomation` 先于 deleteRun 拿锁完成，则其 `appendRun` 更早完成 ⇒ 重读**必看见**该记录，基准含它；(b) 若并发轮的 `markAutomation` 排在 deleteRun 之后，则 deleteRun 即使按缺它的旧基准回写，该轮自己的 `markAutomation` 随后覆盖为正确值。该方向下两种交错终态均正确，坏交错（记录不可见且自家回写后无覆盖）**结构性不存在** |
| 注记 1 runId 生成前移 | §3 新行 + §8「`dispatchEnqueue` 在调用 `enqueueAgentAutomation` 或 `enqueueScriptAutomation` 的同步段里…没有传入才生成，并立刻写入在途表…`runBound` 只使用这份已经确定的 `runId`」 | **消解**。新断言核实见 7.2 #1/#2；「跨根放弃入队时不建条目」与两条入队路径的实际控制流吻合（见 7.2 #3） |
| 注记 2 同步段约束 | §8「执行体从排队里醒来后的第一段是同步代码，中间不能 await，实现处用注释钉住…要么看见取消标记并返回，要么把阶段改成 `started` 并发出 run-start」+ 档位消费所有权归属停止侧（「同步声明…只消费一次…后到的停止看见已声明就不再消费…执行体不再写第二遍」） | **消解，且优于建议**。v3 不只钉住同步段，还把 v2 隐含未定的「谁消费档位」竞态一并归位：消费声明由停止侧在任何 await 之前同步写入、单次所有权、执行体跳过路径不再消费——v2 此处存在双消费窗口（停止侧与执行体跳过路径都可能消费），v3 关闭。同步段可行性核实：两条排队链（agent 的 `automationTail.then`、script 的槽位 waiter）醒来后的续段到 `executeRun` 的 run-start 发射之间无 await（`runBound` 无前置 await；`executeRun` 首个 await 在发射之后的 `markAutomation`，`automations-host.ts:435-443`），不变量可按构造成立 |

**补记（2026-10-22，实施期）**：上表 N-P3-1 的交错证明覆盖的是「删行后新运行落盘」；被删运行自身的收尾 `markAutomation` 若晚于回写拿锁，仍可能短暂把已删运行的上次状态写回。该窄残余已登记在设计 §6，并按「下一次运行/删除以权威记录自愈」处理，不再宣称完全闭洞。

### 7.2 v3 新断言核实

| # | v3 断言 | 结果 | 出处 |
|---|---|---|---|
| 1 | 未传入的 `runId` 在 `runBound` 里才生成 | ✅ | `automations-host.ts:512`（`meta.runId ?? randomUUID()`）——前移动作确有必要 |
| 2 | 手动运行的 `automation.run` 已传入 `runId` | ✅ | `routes.ts:650-651`（路由生成 `runId` 并随 meta 传入）——手动路径零改动，只有定时/脚本路径需要生成点前移 |
| 3 | 条目写入发生在跨根判断放弃入队之后 | ✅ | 非 manual：跨根检查在 `enqueueGate.then` 内、`dispatchEnqueue` 之前（`automations-host.ts:562-566`）；manual：路由在入队前已拒 cross（`routes.ts:648-649`）——两条路径 `dispatchEnqueue` 都只在真正入队时到达，不留孤儿条目 |
| 4 | §6「`finishAutomation` 先拿运行记录锁、再等注册表锁」 | ⚠️ **顺序持锁、非嵌套**（措辞观察，见 7.3 #2） | `automations-host.ts:397-402`：`await appendRun`（锁随 resolve 释放）后才 `await markAutomation`——顺序而非持 A 等 B |

### 7.3 新发现（均不阻塞）

1. **N2-O1（理论残余，可不修）**：停止侧的档位消费「声明在任何 await 之前写入条目，**声明之后的注册表写入可以异步**」（§8）。声明（内存标记）与注册表写入落地之间存在毫秒级窗口，调度 tick（60s 周期）恰好落入该窗口会按残留的过去 `nextRunAt` 重新入队该档——P1-1 的极窄残余形态。概率约为 写入延迟/60s，后果为被停档位多跑一次。若要闭窗：`automation.stop` 在返回前 `await` 档位写入完成。登记即可，不要求修改。
2. **N2-O2（文档措辞观察，无需修改）**：§6「`finishAutomation` 先拿运行记录锁、再等注册表锁，反过来嵌套会死锁」——现状是**顺序**持锁（append 锁随 `appendRun` resolve 即释放），并无「持 append 等 registry」的嵌套存在，反嵌套死锁在今天不会实际发生，描述的是假想嵌套下的未来风险。所立规则（注册表锁内不再获取运行记录锁）**正确且方向保守**，正是防未来有人嵌套时踩雷；仅记录措辞与现状的出入，不需改规格。

### 7.4 终审结论

**通过。**三项开口全部消解，消解质量高：§6 重读方案不是「把窗口缩小」而是经交错分析证明坏交错结构性不存在；§8 不只落实同步段建议，还顺手关闭了 v2 遗留的档位双消费归属竞态。新发现仅一条理论残余（N2-O1，登记可不修）与一条措辞观察（N2-O2，无需修改）。**规格可批准进入实施计划。**

**后续（同日）**：实施计划已落盘 `docs/superpowers/plans/2026-10-21-automation-result-preview.md`。N2-O2 无需动作，锁规则已编入计划 Global Constraints。N2-O1 曾建议用 `stopAutomation` 返回前的等待闭窗；计划评审 `docs/superpowers/plans/2026-10-21-automation-result-preview-review.md` 第 1 条核实这次等待关不掉窗口（调度读注册表不拿锁）。规格终审结论不变，N2-O1 维持为接受的窄窗口。
