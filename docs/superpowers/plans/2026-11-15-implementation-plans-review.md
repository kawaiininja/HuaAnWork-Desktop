# 实施计划评审：对话创建技能 / 右侧进度面板 / 任务结果 Artifact

- 日期：2026-11-15
- 评审方：Qoder 主 agent（独立校准）；初审由三个独立【示例】代码审查员 subagent 完成（Artifact 首轮超时、收窄范围复审成功），主 agent 对全部 Critical/Important 逐条背靠背核实（含上游代码核实与正则实跑），Minor 抽查部分
- 评审对象：
  - `docs/superpowers/plans/2026-11-15-chat-created-skills.md`（773 行，Task 1–6；下称「技能计划」）
  - `docs/superpowers/plans/2026-11-15-progress-sidebar.md`（572 行，Task 1–4；下称「进度计划」）
  - `docs/superpowers/plans/2026-11-15-task-result-artifacts.md`（931 行，Task 1–8；下称「Artifact 计划」）
- 需求权威：对应三份规格（`specs/2026-11-15-*-design.md`）与 `specs/2026-11-15-three-feature-designs-review.md`（裁定 R1/R2/R8 及 §4.2 落地约束、§7.3 两条必补项）
- 基线：master `ff29debd37`；子模组 pin `1600d8a1e14`（0.2.1-rc.1）；计划/规格均为未跟踪新文件
- 当前状态（2026-11-17 §18 复核与 P/S 修订闭环）：**经独立复核 §17「qwen4复审结论」无误报、无夸大，确认 `QR-I1`、`QR-I2`、`QR-M1`、`QR-M2` 成立并同步补齐 6 项运行时/测试接线漏报后，相关修订已全部写入设计规格（S）与实施计划（P）；当前计划层面剩余 Open 阻断为 0 Critical / 0 Important / 0 Minor，可进入 Task 1–5 实施。** 2026-11-17 另按 owner 要求将进度计划（`§14.2` / `Task 5`）与 Artifact 计划（`§12.2` / `Task 9`）的真人/人工验收统一升级为 agent 真机走查自动化测试（CDP + `verify:host` 判据单测）；`§1–17` 完整保留历史评审与复审原文（`#29` 对话创建技能已合入并由 `2026-11-chat-created-skills-acceptance.md` 闭环，本轮未改），XM-A4 维持 owner 裁定（2026-11-16）。计划层面修订闭环不代表功能已实现，亦不替代后续源码实现、`corepack yarn check`、包级类型检查与真实 Electron CDP 走查自动化测试。

## 1. 总体判决

| 计划 | Critical | Important | Minor | 判决 |
| --- | --- | --- | --- | --- |
| 技能创建 | 0 | 5 | 6 | **With fixes**：修完 5 项 Important 可开工 |
| 进度面板 | 2 | 2 | 6 | **With fixes**：两处 Critical 是机制级错误，必须先在计划层面重写，否则 Task 2/3 验收必然失败 |
| Artifact | 0 | 10 | 10 | **With fixes**：方向与承重机制成立，但「协议定了到不了消费方」的载体缺口与弱钉会让核心验收无法按计划达成 |

三份计划的底子都好：承重现状锚点经抽样几乎全部属实，大方向（技能 R8 双向互斥、进度可见性矩阵 + startActivation 纳管、Artifact 双路径互斥 + 截断前适配）正确，TDD 与门禁结构完整，跨计划边界干净。问题集中在「计划内嵌代码/夹具与真实机制不一致」和「验收钉强度不足」，不是方向错误。

## 2. 技能创建计划

### 2.1 Strengths（经核实）

- R8 主干正确且强于推荐：互斥检查放在 continue/取消/update/注入/挂载之前（Task 5 Step 3），**智能体侧同批补低层防护**（Step 4 在 `proposeAgentPackage`/`commitAgentPackage` 写入前查技能草稿磁盘存在），不是只改技能侧。
- 复用而非复制写盘：`createSkillLocked` 抽取 + 同一把 `withSkillStorageLock`，并明确「不得持锁后再调会取同一锁的 createSkill」（plan:306）——该锁非重入（skills-host.ts:255-272），计划正确规避死锁。
- 另存/复制天然干净：skill-duplicate.ts:78-81 写全新条目，计划只列为回归测试而非修改目标，R9「另存不继承键」自动成立。
- 解绑机制忠实沿用先例（huaanworkOnToolResult/pendingDetach/concludeTurn，与 agent-package-tools.ts:204-212 同形）；同意按钮发精确「确认」而非「确认创建」。
- 现状锚点质量高：validateSkillFields 不查换行、updateSkill 与上传两处 RMW 按显式字段重建、INTERNAL_BUNDLED_SKILLS 三个落点、session.send、成功文案、refreshSignal 现状等 35+ 处抽样全部属实。

### 2.2 Important（5 项，全部经主 agent 独立核实）

#### SI-1 夹具与计划自己的正则矛盾，用例不可满足（实跑证实）

- 位置：plan:573 矩阵 `{ existing:'agent', incoming:'帮我创建一个新技能', rejected:true }`；plan:597 `CREATE_SKILL_RE = /^(?:帮我)?(?:新建|创建|建)(?:一个|个)?(?:技能)/`。
- 证据：主 agent 实跑该正则，`'帮我创建一个新技能'` → **false**（「一个」后紧跟「新技能」，「技能」无法匹配「新」）；`'帮我创建一个技能'`/`'新建一个技能'` → true。
- 影响：入口识别判不出该句 → 互斥不触发 → 用例实现后仍红；实施者可能为迁就夹具放宽正则，违背规格 §6.1「保守自然语言入口」与智能体先例。
- 修法：夹具改成能命中的说法（如「帮我创建一个技能」），**不要放宽正则**。矩阵其余句已核实可命中。

#### SI-2 幂等扫描代码与 prose 矛盾：phantom success 无测试钉

- 位置：plan:292-303 `createSkillFromDraft` 扫描命中 `creationDraftId` 即 `return {ok:true,alreadyCommitted:true}`，不校验目录存在；plan:324 prose 明确要求「状态有键但目录已消失时返回字段错误」。`findSkillByCreationDraftId`（plan:311-321）有存在性校验，二者不一致。
- 复现：目录被带外删除、状态条目残留 → commit 重放先经 findSkillByCreationDraftId 返回 undefined → 落入 createSkillFromDraft 扫描命中键 → 报 phantom 成功，违反规格 §8.2 fail-closed。
- 修法：扫描命中后同样确认本地技能仍存在（listUserSkills/findEntry），不存在返回字段错误；补「状态有键、目录已删 → 拒绝且保留草稿」测试。

#### SI-3 异常双草稿态「禁止隐式取消」只有 prose，无实现无测试

- 位置：plan:619 复述规格 §7 第 6 步要求；但互斥 snippet（plan:609-614）在双草稿态会拒绝 `/create-agent` 与 `/create-skill` 两个显式入口，用户无从「显式选择某流程」；裸「取消」轮 requestedAgent=requestedSkill=false → 互斥不触发 → 落入现有智能体 continue 的取消分支（sessions.ts:208-216）→ **隐式删掉智能体草稿**。Step 4 低层防护只挡 propose/commit，不挡 cancel。
- 影响：异常态下取消打错对象——正是 R8 要防的「同意/取消打错实体」的取消版。Step 1 矩阵 7 例全是单草稿。
- 修法：取消分支前加双草稿守卫（两类草稿同时在场的裸取消 → 拒绝并提示须分别显式取消）；定义双草稿态的显式选择/取消路径；补双草稿 propose/commit/cancel 三向测试。

#### SI-4 自然语言识别缺 `!atName && !skillName` 守卫，误拒普通技能轮

- 位置：plan:604-605 `requestedSkill = skillEntry || detectSkillCreationIntent(text) !== undefined` 无条件对 text 跑 NL 正则；现有智能体路由对 NL 识别有守卫（sessions.ts:202-208）。
- 复现：用户显式 `/weekly-report` 调普通技能、正文恰以「创建技能…」开头，且智能体草稿在场 → requestedSkill=true → 被互斥拒绝。行为回归。
- 修法：NL 部分仅在规范化后 `!atName && !skillName` 时计入（显式命令入口不受此限），与 sessions.ts:202-208 对齐；补「普通技能轮 + 创建样正文 + 对方草稿在场 → 不被误拒」回归。

#### SI-5 缺「成功卡 + 前往我的技能」（规格显式验收项）

- 位置：plan:524 成功只发 `skill/notice` 文案；plan:719 「skill/notice 写标签脚注」。全计划无成功卡、无「前往我的技能」导航。
- 证据：规格 §8.3「成功卡提供『前往我的技能』」、§9、§12.2#3「确认后成功卡出现」是显式验收项；智能体先例的 notice 也是脚注，不能直接沿用。
- 修法：Task 6 增成功卡（或带「前往我的技能」动作的成功 notice），点击跳「我的技能」但不强制打断当前会话；补组件/接线测试。

### 2.3 Minor（6 项；M-2 经主 agent 核实，其余为初审结论，修订时一并核对）

- **SM-1** 互斥提示（plan:611）缺规格 §7 第 4 步要求的 `<名称或草稿摘要>`，建议带上对方草稿名/摘要。
- **SM-2（已核实）** Task 6 Step 4 的 mount 重写（plan:726-741）丢掉现有默认参 `= { mine: [LOCAL] }`（skillsView.spec.ts:63），而 :125/:174/:204/:229 有 4 处裸 `mount()`，照抄会使既有测试抛错。重写须保留默认参与既有 rpc mock。
- **SM-3** plan:744 把启动回调（应发 `/create-skill`，Step 1 测试已钉）误写成同意回调（发「确认」）。改为「启动回调发 /create-skill；同意回调发 确认」。
- **SM-4** 上传「带外编辑采纳」用例须预置 creationDraftId 且**保留 stale contentDigest**，使 skill-catalog-upload.ts:85 的 `contentDigest !== uploadDigest` 分支真正执行，否则采纳路径保键断言空转。
- **SM-5** Task 1 删 normalizeUtterance 后 TRAILING_PUNCTUATION（drafts.ts:67）成死代码未列删除；且只钉客户端 RESERVED_SKILL_NAMES，未钉宿主侧 INTERNAL_BUNDLED_SKILLS 含 create-skill（建议补 createSkill({name:'create-skill'}) 失败或技能中心不列出的断言）。
- **SM-6** Task 3 propose prose 未提 Step 1 测试要求的「智能体草稿在场拒绝」交叉检查；Task 5 建议显式写明每轮 `getSkillCreationHost()?.noteUserText(sessionId, text)` 接线（技能同意门禁读 lastUserText，漏接会使 happy-path commit 恒拒，低层测试直传 rawUserText 抓不到此缺口）。

### 2.4 判决

**With fixes.** 先修 SI-1/SI-2（直接卡 red-green 或留正确性洞），再补 SI-3/SI-4/SI-5 三类钉与成功卡；Minor 随修订一并落。修完可按 TDD 开工。

## 3. 进度面板计划

### 3.1 Strengths（经核实）

- **纳管挂点选对了**：system-skill run 创建放在 startActivation 包装（Task 2 Step 4，plan:259-283），与上游 tool-subagent/src/index.ts:330 实际调用一致——这是本设计最易踩错、踩错即 Critical 的点，计划避开了（主 agent 上一轮规格评审曾误写 start 挂点，计划是正确的）。
- 包 lane 未被误伤：Task 1 Step 3 把 subagent 从 ALLOWED_TOOLS 摘除的同时加入 AGENT_PACKAGE_CHILD_TOOLS（plan:83-93），与 agent-attachments.ts:11、runtime.ts:179 对齐；present-as 并集语义保证包儿童仍可见、普通父会话不可见。
- 复用既有 registry，不造第二套状态机；定向取消沿用 confirmCancelSubagent→subagent.cancel。
- lease 用持久 Map + goal-phase 信号（goal/change 非 active 与 agent/status idle，bridge.ts:199-231 真实存在），goal 续轮轮间 idle 因 goalPhase==='active' 不提前解挂。
- 规格评审 §7.3 第 1 条共享包不一致已消解：Global Constraints（plan:18）扩到 packages/huaanwork-policy，Task 1 同步改 filterAgentAllow 与消费点。
- 历史 todo 呈现缺口定位准确（historyToChatItems 无 todo 分支、落 note 兜底）；跨计划边界守住。

### 3.2 Critical（2 项，主 agent 已对上游代码独立核实）

#### PC-1 pre-execute 的 ALS 跨不到分阶段派发的 body，连带回归既有 child-restrict

- 位置：plan:248（spawnKind ALS）、plan:254（pre-execute 内 `return spawnKind.run(kind, () => next())`）、plan:257（「删除模块级单槽写入」）、plan:264（startActivation 内 `spawnKind.getStore()`）。
- 上游事实（deepseek-harness/packages/core/tools/src/index.ts，主 agent 逐段核实）：
  - `execute` = `prepareExecution(exec, prepared => completeScheduledExecution(prepared))`（:1377-1379）；
  - `prepareExecution` 的 `tools/pre-execute` waterfall terminal 只返回 `{kind:'allow'}`（:1513-1516），waterfall 解析完后才 `next({kind:'dispatch',exec})`（:1543）；
  - body 在 `dispatchScheduledExecution` 的 `tools/execute` waterfall terminal `dispatchToolBody` 里执行（:1609-1616 → :1572-1600 → tool.execute :1589）。
  - ⇒ pre-execute 里建立的 ALS 作用域在 body 阶段早已出栈，`spawnKind.getStore()` 必为 undefined。
- 影响：① system-skill begin 分支永不触发，Task 2 验收必失败；② 计划同时删除模块级单槽，而 `consumePendingSpawn` 还被 agent/created（skills.ts:224-226）与 subagent/start（:258）消费——这两处同样在 body 阶段触发，于是 explore/test-fix 的子代 restrict 收窄一起塌掉（skills.spec.ts:242-254、:327-341 既有绿测回归）。机制级错误，不是边界疏漏。
- 修法（二选一，须在计划里重写 Step 3/4）：
  - (a) ALS 建立移到 **around-dispatch 的 `tools/execute` waterfall**（其 next() 确实包住 dispatchToolBody），按 exec.agent 从 pendingByAgent 取 kind 后 `spawnKind.run(kind, () => next())`；body 内 startActivation 与两处监听都能读到。
  - (b) 保留 pre-execute 判定 kind，改用**父会话 keyed 的 Map**（pre-execute 写入、startActivation 经 parentFromCall 读取并消费），不依赖 ALS 跨阶段。
  - 无论哪种，不能删除 pre-execute→监听的桥接载体；计划须显式写明「pre-execute 的 next 不覆盖 body」这一上游事实。

#### PC-2 历史 todo 读的是 200 字符截断摘要，不是原始 JSON；宿主侧字段与文件漏列

- 位置：plan:390 `normalizeTodoEntries(parseJson(record.args))`；Task 3 Files（plan:316-325，主 agent 核实）未列 session-view.ts / rpc-types.ts。
- 证据（主 agent 核实）：session-view.ts:240-254 tool/call 分支 `args = formatToolArguments(data.arguments)`；commandOutcome.ts:63 `TOOL_LABEL_MAX_CHARS=200`、:70-85 stringify→压空白→截断加「…」；rpc-types.ts:432-446 SessionDetailRecord（tool-call）只有 `args?:string`，无 todos。
- 影响：任何 >200 字符的真实历史 todo_write 经截断后 JSON.parse 必抛 → 全落「历史待办无法解析」note；规格 §9.2/R8/R-12 闭环/测试 13「历史与实时快照一致」全部失败。极短列表偶然可解析也是把有损摘要当原始数据，机制本身错误。
- 修法：宿主 detailRecords 为 todo_write 增结构化 todos 提取（镜像实时 bridge startDetail 的 todo 分支，bridge.ts:399-414）；扩 SessionDetailRecord 携带 todos/roundKey；historyItemsFromRecords 读结构化字段而非 parseJson(record.args)。**Task 3 Files 必须补 session-view.ts 与 rpc-types.ts**。

### 3.3 Important（2 项）

#### PI-1 「复用现有 createHarness」不成立，红测会假绿（主 agent 核实）

- 位置：plan:221 Step 1 复用现有 createHarness 写「系统技能当前不产生 Host run」红测。
- 证据：skills.spec.ts:80-225 的 createHarness ctx 不含 subagents 服务；invokeSubagent（:195-204）是「先跑 pre-execute，再 separately emit agent/created + subagent/start」，从不调用 startActivation。
- 影响：Step 1/2 测试无法按现状运行；若临时补 fake activation 但让它在 pre-execute 的 next() 内同步触发（不反映 PC-1 的分阶段派发），会得假绿、掩盖 PC-1。
- 修法：计划显式扩展 createHarness 注入 fake subagents.startActivation，触发时机忠实于「body 阶段、pre-execute 之外」，与 PC-1 修复配套。

#### PI-2 system-skill run 清理/确认生命周期欠定义，可能卡在 stopping

- 位置：plan:279-283 仅「attachCancel 注册 dispose 闭包；清理确认沿用 confirmCleanup」。
- 证据：legacy/package 的 result 观察、cancel、cleanup 预算与确认由宿主统一持有（agent-invoke.ts:254-260 observeResult、:323 attachCancel、:306/315 confirmCleanup）；registry 的 stopped 需 stopping + executionEnded + cleanupOk（subagent-runs.ts:108 注释明示 executionEnded 是 stopped 必要条件）。
- 影响：dispose 后不调 confirmCleanup(ok)，定向取消会受理但永不达 stopped，规格 §6.3 第 5 条/测试 8、14 失败。
- 修法：Step 4 显式定义 attachCancel 闭包 = `await activation.dispose()` → `confirmCleanup(runId,{ok:true})`；executionEnded 由 observeResult 的 settleResult/rejectResult 提供；预算/超时对齐宿主 legacy cleanup。

### 3.4 Minor（6 项；M3①、M6 经主 agent 核实，其余为初审结论，修订时一并核对）

- **PM-1** 矩阵 fixture 是单层 REPLACE（skills.spec.ts:60-78 createTools），不反映真实多层 restrict 交集；包儿童行至少在 intersecting fixture（present-as.cordis.spec.ts:24-63 形态）补一条钉。
- **PM-2** plan:91 「只有 composeAgentPackageToolAllowList 含 subagent 才挂载」与 skills.ts:336 start 包装无条件 attach AGENT_PACKAGE_CHILD_TOOLS 不符（rc.1 下该路径 dormant，无害）；订正措辞。
- **PM-3（①已核实）** ActivationRun（skills.ts:63-68）只有 childId/localAgent/dispose，无 `.result`，observeResult 需扩类型，计划未提；② plan:281 的 Pick 保留清单漏 `settleUpstreamEnd`（skills.ts:93，被 subagent/end 监听 :267 消费），按字面替换会丢它。
- **PM-4** 注释订正范围漏 profile.ts:113-122（maxDepth=2 理由注释）；计划只列 :1627-1631，应显式判定前者是否需补注 R1/R2。
- **PM-5** isLegacyChild（plan:182）基于 parentSessionOf，会把 system-skill child 一并判为 legacy（当前无害：这些 child 无 skill 工具）；命名/注释区分，防后续误用。
- **PM-6（已核实）** normalizeTodoEntries 对任一坏条目 reject-all（plan:336-344/:383），而现行 bridge startDetail 是 flatMap 丢坏条目（bridge.ts:404-409）——实时行为变更；核对既有 bridge todo 测试是否钉了「丢坏条目」语义，避免回归。

### 3.5 判决

**With fixes.** PC-1/PC-2 是「计划现有改动面内无法实现」的硬伤，必须先在计划层面重写桥接/数据机制（并配套 PI-1 测试基建），再补 PI-2 生命周期与类型细节，方可开工。Task 1 可见性/lease 架构与 Task 4 投影设计基本成立。

## 4. 跨计划共同事项

1. **边界干净**：三份计划均未触碰对方领域（技能不碰 registry/Artifact，进度不碰创建路由/Artifact，Artifact 不碰 subagent 可见性），与规格独立性声明一致。
2. **App.tsx 共同修改面**：三份计划都改 App.tsx（事件处理/信号/右栏接线）。建议实施顺序技能→进度→Artifact；技能计划的 skillChangeSignal 与进度侧信号接线在合并时注意互相覆盖，计划里保留显式冲突注记。
3. **`currentTurnAnchor` 跨计划依赖（Artifact AI-2）**：该符号全仓零命中，唯一产出方是进度计划 Task 1（plan:55）。Artifact Task 2 称其为「既有通用回合锚点」是 phantom dependency。必须显式化：模块路径、落地顺序（进度 Task 1 先于 Artifact Task 2）、缺席降级（anchor 缺 clientMessageId → 未定位分组）。并行 worktree 时此依赖是硬顺序约束。
4. **门禁**：包级 check 之外按 AGENTS.md 跑根 `corepack yarn check`；verify:aa 并发竞争如实串行重跑记录（技能计划已正确登记）。
5. **R-12 债联动**：进度计划 Task 3 Step 5 已写明关闭 AGENTS.md R-12 行（plan:413-415），处置正确。
6. **真机验收**：Artifact 规格 §12.2 七项人类验收（沙箱交互、全屏、另存为、刷新后锚点等）必须写进 Task 8 收尾与证据落盘；三份计划的 Completion Criteria 目前都只有自动化门禁，静态断言不能替代安全边界的真机证明。

## 5. 处置建议与复审安排

| 优先级 | 动作 |
| --- | --- |
| P0 | 进度计划重写 PC-1（ALS 挂点或父会话 Map）与 PC-2（宿主结构化 todos + 补文件），配套 PI-1 harness 扩展 |
| P0 | 技能计划修 SI-1（夹具）、SI-2（代码/prose 一致 + phantom 测试） |
| P0 | Artifact 计划补三处「协议到不了消费方」载体：AI-1（run-end 结果字段）、AI-3（历史锚点来源二选一裁定）、AI-6（工具 description）；修 AI-10（native 接线按 requestRestart 先例）与 AI-4（fold 签名/单项语义） |
| P1 | 技能 SI-3/SI-4/SI-5（双草稿守卫、NL 守卫、成功卡）；进度 PI-2（清理生命周期）；Artifact AI-2/AI-5/AI-7/AI-8/AI-9（依赖显式化、唯一展示强钉、沙箱真验证、下载字节钉、保存对话框 parent） |
| P2 | 全部 Minor 随修订落；修订方对「初审结论」标记的 Minor 一并核对 |

修订完成后由主 agent 对修订稿做定向复审（只核处置点 + 新引入断言），通过后方可开工。

## 6. 核实用证据索引（主 agent 本轮独立执行）

- PC-1：上游 core/tools/src/index.ts:1377-1379（execute=prepareExecution+continuation）、:1501-1547（pre-execute waterfall terminal 只返回 allow、:1543 才 dispatch）、:1609-1616（tools/execute waterfall terminal=dispatchToolBody）、:1572-1600（body :1589）；计划 plan:243-283 逐行比对。
- PC-2：session-view.ts:240-254、commandOutcome.ts:63/:70-85、rpc-types.ts:432-446、计划 Task 3 Files plan:316-325 与 Step 4 plan:385-411。
- SI-1：node 实跑 CREATE_SKILL_RE 对 5 个例句（「帮我创建一个新技能」false，其余 true）；plan:573/:597。
- SI-2/SI-3/SI-4/SI-5：plan:280-324、:560-640、:644-766 逐段比对；sessions.ts:197-240 现状路由。
- PI-1：skills.spec.ts:80-225（harness 无 subagents 服务、invokeSubagent 分阶段 emit）。
- 抽查 Minor：skillsView.spec.ts:63/:125/:174/:204/:229（mount 默认参与裸调用）、skills.ts:63-68（ActivationRun 无 result）、bridge.ts:396-414（flatMap 丢坏条目）。
- 初审 subagent 另各自抽样核实 35+/15+ 处锚点（详见其报告要点已并入上文 Strengths）；主 agent 未重复全部锚点，承重断言以本索引为准。

## 7. Artifact 计划评审（复审，2026-11-15 追加）

初审 subagent 首轮达 turn 上限未出报告；收窄范围复审成功（21 次工具调用）。主 agent 对全部 10 项 Important 逐条独立核实，均成立；0 Critical 的校准判断同意（缺口属「验收不可达/钉强度不足」，非设计本身的安全洞或数据丢失）。

### 7.1 Strengths（经核实）

- **封套注入点准确且唯一**：Task 3 Step 3 逐字代码与真实 runAgentTurn 组装式同形（mergedPrefix + automation.prompt → `<automation-fire>`，automations-host.ts:365-368）；manual/schedule/catchup 与有人/无人值守都经 executeRun→runAgentTurn 单点，注入不漏分支。**规格评审 §7.3 第 2 条（注入点未定）已闭环。**
- **截断前适配真的可行**：runAgentTurn 返回完整 stripModelThinking 文本（:416），finishAutomation 才 clipOutput（:614）；适配点在两者之前，5 MiB 预算对 agent 自动化不再形同虚设（I-2 第 4 条闭环）。
- **运行记录扩字段不需要动 store**：RunSummary 定义在共享 rpc-types.ts:385，appendRun 用 `{...run, output: clipOutput(...)}` 透传，新增可选字段不会被吃掉。
- **项目级联继承成立**：removeAutomationsOfProject 逐项 await removeAutomation（automations-store.ts:432-447），「接共享原语即自动继承」不是假设。
- **全屏无业务 preload 可行**：客户端 RPC 是相对路径 fetch（api.ts:174+），不依赖 preload 桥；MarkdownText/MarkdownLabels 确由包根导出（上游 ui-primitives/src/index.ts:109-110），且 @deepseek-ai/dsh-client-ui-primitives 已在桌面包声明（package.json:264）⇒ Task 6 不引入新依赖/lockfile 工作量。
- 原生接线次序有先例：authenticateRendererSession/installRendererAccessHeader 确在 loadURL 之前（electron-shell-generation.ts:675-688）；exec.callId 真实存在（agent-package-tools.ts:55）。

### 7.2 Important（10 项，全部经主 agent 独立核实）

#### AI-1 实时 run-end 没有 artifactOutcome 载体，三态投影实时侧无来源

- 位置：plan:108-112（只加 artifact/created 与 RunSummary 字段）、:598-609（「实时 run-end 与历史回填都调用它」）。
- 证据：rpc-types.ts:583-593 与 automations-host.ts:640-651 的 automation/run-end 只有 automationId/runId/ok/status/sessionId/durationMs/taskId；App.tsx:1788-1795 在 run-end 处直接调 foldRunAssistantItems。
- 影响：`projectAutomationResult(items, run, artifact?)` 的 run 在实时侧无来源，实现者只能即兴（额外拉 runs 或猜事件顺序）；规格 §6.3「运行记录先于 run-end 可查询」「任何事件顺序都不双发」失去协议保障。
- 修法：Task 1 扩 run-end 三个可选字段；Task 3 在 finishAutomation 的 emit 条件展开（与 run 参数同一 artifactFields）；Task 5 明确「实时用 event 构造 run、历史用 RunSummary」；补「run-end 带 created/failed 时不走旧折叠」钉。

#### AI-2 currentTurnAnchor 是 phantom dependency（跨计划）

- 位置：plan:173（「既有通用回合锚点」）、:242。
- 证据：全仓 src/tests 零命中（主 agent grep 核实）；唯一产出方是进度计划 Task 1（progress plan:55）。
- 修法：Consumes 改为「依赖进度计划 Task 1 的 <模块路径> 导出」，写明 import 路径与顺序约束；补「anchor 缺席 → anchor:{kind:'turn'} → 未定位分组」红测。见 §4 第 3 条。

#### AI-3 普通会话历史精确锚定在现有日志下结构性不可达

- 位置：plan:565-579（「session-view.ts 只在 user/message 数据确有字符串 clientMessageId 时透传」）。
- 证据（主 agent 核实）：session-view.ts:203-217 user 记录只有 kind/time/text/goalRound，全文件零 clientMessageId；sessions.ts:296-298 注释明写「Host 只把它随 run 投影原样返回」，:1013-1021 只在有 at.name 时才带 at.clientMessageId。普通（无 @）回合的 clientMessageId 从不进宿主、更不进上游日志。
- 影响：该透传是死代码；刷新/重开后**所有**普通会话 Artifact 都落「未定位的历史结果」分组，规格 §5.2 规则 1、§12.1#7、§12.2#6 措辞失真。
- 修法（二选一写进计划）：(a) 宿主自有 turn→clientMessageId 索引（不改上游日志），由 session-view 或 artifact.list 提供锚点；(b) 显式裁定一期普通会话历史只到未定位分组，同步订正规格与验收文案。不能保留「确有则透传」这种看似兼容实则不可达的条件。

#### AI-4 旧折叠断言与真实 fold 语义不符，签名缺 id 工厂

- 位置：plan:540（`.filter(isLegacyAttachment)).toHaveLength(2)`）、:605（`foldRunAssistantItems(items)` 单参）。
- 证据：runResultAttachments.ts 的 fold 签名是 `(items, createAttachment)`，且**只插入一个** attachment 项（两份固定文件由卡片组件渲染）；App.tsx:1790 传带 allocId() 的工厂。
- 影响：钉按现状必红（正确实现也红），逼实现者扭曲投影；projectAutomationResult 无 id 来源，产不出旧附件项。
- 修法：断言改 toHaveLength(1)；纯函数签名补 createAttachment（或返回描述符由 App 落 id）；legacy 分支显式接收工厂。

#### AI-5 「唯一展示」核心断言缺失：只数卡，不验原文消失与去重

- 位置：plan:537-541、:598-609。
- 证据：fixture 含 assistant 原文 JSON，断言只有卡数；「保留原封套气泡 + 追加一张卡」的实现照样绿。
- 影响：规格 §6.3#1/#4「收起原始封套」、§12.1#3「失败只有紧凑摘要」无钉；「事件丢失补齐不双发」「按 artifactId 去重」只有散文。
- 修法：created/failed 两路加 `expect(JSON.stringify(result)).not.toContain('正文')` 与 assistant 项数为 0；补「created 事件 + list 快照同 artifactId 只一张卡」「事件丢失经 RunSummary.artifactId 补齐后仍只一张卡」两条钉。

#### AI-6 result_present 的模型面指引未定义（功能休眠风险）

- 位置：plan:232-253 只有输入 schema 与执行体，无工具 description；:250 返回值只有标题。
- 证据：规格 §5.1 明列五条面向模型的指引；自动化侧给了逐字 `<task-result-contract>`，普通会话侧没有到达模型的通道。
- 影响：工具注册了但模型不知道何时调用，功能休眠且无钉可红；返回值缺 artifactId 不符规格 §6.1#4。
- 修法：Task 2 写出 description 逐字文案（Markdown 优先／HTML 用于交互可视化／普通答复不调用／同一交付物只提交一次／成功后只给简短说明），加 description 含关键句的钉；返回值带 artifactId。

#### AI-7 HTML 沙箱/CSP 只有静态字符串断言，安全边界未被证明

- 位置：plan:663-671、:711-716、:726；Completion Criteria :924-931 只有 typecheck/check。
- 证据：现钉不验 ①CSP meta 是否在模型内容**之前**（实现 :711-713 当前正确，但把 meta 移到内容后照样绿，而这是规格 §7.3 承重条件）②srcDoc 而非 src ③脚本真能执行、fetch 真被拒。无真机/webContents 探针，规格 §12.2 人类验收未进计划。
- 修法：加顺序断言（indexOf('Content-Security-Policy') < indexOf(content)）+ srcdoc 非空且 src 为空；补一次真实渲染验证（内联脚本置位成功、fetch 失败、window.parent 不可读）；§12.2 七项人类验收与证据落盘写进 Task 8。

#### AI-8 下载「原字节一致」无钉

- 位置：plan:760-782 只测取消零写入；:820-832 实现 base64→Buffer→写盘。
- 影响：宿主读字节→base64→native 解码→写盘链无等价断言，多字节/BOM/CRLF 或截断损坏不会红；规格 §12.1#11 与 Completion Criteria :929 都把原字节一致列为验收。
- 修法：加「写入文件字节 === readArtifactContent 字节」钉（含中文/emoji/带 BOM 的 HTML）；断言 showSaveDialog 收到的 defaultPath 经 sanitizer、扩展名与 format 一致。

#### AI-9 全屏窗口触发下载时，系统保存对话框挂在主窗口上

- 位置：plan:823 复用 `this.showUpdateSaveDialog(...)`。
- 证据（主 agent 核实）：electron-shell-generation.ts:903-908 `dialog.showSaveDialog(this.window, options)`，this.window 是主窗口。
- 影响：全屏窗口覆盖屏幕时主窗口 sheet 被遮在后面，用户看到「点了下载没反应」——规格 §8.2 主路径功能缺陷。
- 修法：artifact 另存为走带「请求窗口」参数的新路径（或无 parent 的 showSaveDialog）；补「全屏触发时 parent 不是主窗口」钉。

#### AI-10 `routeCtx.runtimeCtx.desktopRuntime` 接线不存在

- 位置：plan:814。
- 证据（主 agent 核实）：routes.ts:142-161 RouteContext 只有 dshHome/profileDir/workspaceRoot/emit/logger/runtimeCtx?/requestRestart/desktopPnpm?；runtimeCtx 是 SessionRuntimeContext（cordis holders），无 desktopRuntime 路径。desktopRuntime 是 cordis 服务（index.ts:50,147），既有先例是窄化成 requestRestart()/desktopPnpm 这类 RouteContext 能力字段。
- 影响：按计划写编译不过或逼实现者即兴改共享面；Task 7 文件清单漏真正提供方 index.ts。
- 修法：按 requestRestart/desktopPnpm 先例在 RouteContext 增 `artifactNative?: ArtifactNativeCapability`，由 index.ts 从 ctx.desktopRuntime 窄化提供（缺席返回 artifact-native-unavailable）；Task 7 Files/commit 补 index.ts 与 makeRouteCtx 夹具。

### 7.3 Minor（10 项；AM-7 经主 agent 核实，其余为初审结论，修订时一并核对）

- **AM-1** 适配点与取消覆盖先后未定（plan:377）：automations-host.ts:815-823 的 cancel 覆盖在 finishAutomation 前改写 output。明确在覆盖之后适配（或按 status 门控），补 cancelled 运行钉。
- **AM-2** created 但 artifact 未取到时 `return items`（plan:603-606）会把原封套气泡留在会话，与 §6.3#2 有张力；返回占位/加载卡（仍不折叠），定义补齐失败终态。
- **AM-3** 5 MiB 预算字节口径未写（plan:69,:119）：写明 Buffer.byteLength(content,'utf8')，补多字节恰好/超限钉。
- **AM-4** 提交清单漏测试文件：plan:731 漏 styles-generated.spec.ts、:281 漏 agent-attachments.spec.ts（均已存在且被对应 Step 运行）。
- **AM-5** `refreshAgentRestrict(ctx as never, sessionId)`（plan:262）与仓库不透明断言口径冲突；用真实参数类型或收窄 helper 签名。
- **AM-6** 按 run/automation 删除的定位策略未定（plan:893-897）：存储在 artifacts/<sessionId>/…，签名只有 automationId+runId；写明优先用 automationRunSessionId 推导、扫描兜底且只认 manifest 锚点。
- **AM-7（已核实）** 「构建无远程运行时资源依赖」（plan:726）失真：shell.ts:20-26 installHuaanworkStyles 注入 Google Fonts 远程 stylesheet，全屏页复用同一函数（plan:794）。把断言收窄到「artifact iframe 与打包产物无远程依赖」，或另立字体本地化任务。
- **AM-8** Markdown 远程资源策略未定（plan:674,:695-697）：Markdown 渲染在特权同源页面而非沙箱，上游 render.tsx:53-70 有 sanitizeUrl/remoteImageUrl；写明远程 img 允许与否并补钉（HTML 侧有 CSP，Markdown 侧没有）。
- **AM-9** 兼容模式/浏览器访问下可见性未界定（plan:255-266，初审标「证据不足」）：附件挂载门只排除自动化会话；compat 模式走上游默认客户端，通用工具卡可能铺开 args。核实可达性后加 advanced 模式门（fail-closed）或写明不可达理由。
- **AM-10** 措辞：plan:462「既有 objectQuery」是客户端 api.ts:33 的 query 编码器，不是宿主 helper；点明免得执行者在 routes.ts 找不存在符号。

### 7.4 判决

**With fixes.** 方案方向、注入点、截断前适配、级联继承与原生先例经核实都成立，TDD 与门禁结构完整；但 AI-1/3/6 三处「协议定了到不了消费方」、AI-4/5 断言与真实语义不符、AI-7/8 安全与字节弱钉、AI-9 对话框挂错窗口、AI-10 接线虚构，会让核心验收（唯一展示、历史可定位、原字节下载、安全边界）无法按计划达成。补完 Important（尤其 1/3/4/6/7/9/10）后可开工。

### 7.5 核实用证据索引（主 agent 本轮独立执行）

- AI-1：automations-host.ts:640-651（run-end emit 无 artifact 字段，主 agent 早前已读）+ plan:598-609。
- AI-2：grep currentTurnAnchor 全仓（src+tests）零命中；进度计划 :55 唯一产出方。
- AI-3：session-view.ts:203-217（user 记录无 clientMessageId）、sessions.ts:290-303/:1008-1023（clientMessageId 只随 at 路径）。
- AI-4/AI-5：runResultAttachments.ts fold 签名与单项插入（主 agent 早前全文已读）+ plan:530-609 逐行。
- AI-6：plan:228-266（无 description、返回值无 artifactId）。
- AI-7：plan:655-726（静态断言 + CSP 实现 + Expected 措辞）。
- AI-8/AI-9/AI-10：plan:755-832；electron-shell-generation.ts:900-908（showSaveDialog parent=主窗口）；routes.ts:142-161（RouteContext 无 desktopRuntime）。
- AM-7：shell.ts:18-32（Google Fonts link + advanced-only throw）。

## 8. 修订稿定向复审（2026-11-15 第三轮）

- 复审方：三个独立【示例】代码审查员 subagent 并行逐条核对处置点；主 agent 对开工门槛项独立核实（PC-1 修法机制、Artifact I1 CI 链、I2 传参、I3 phantom 谓词、进度 startedAt 单位、技能守卫范围、AM-5 偏离）
- 对象：三份修订稿计划（技能 1165 行 / 进度 722 行 / Artifact 1561 行）与三份修订稿规格（23:03–23:29 版本）
- 范围：只核处置点 + 新引入断言（§5 约定）

### 8.1 处置核对总结

| 计划 | 原发现处置 | 复审新发现 | 复审判决 |
| --- | --- | --- | --- |
| 技能 | SI-1…SI-5、SM-1…SM-6 **全部真实处置**（正则未放宽、实跑验证；phantom/双草稿/NL 守卫/成功卡均有可红钉） | 0C / 0I / 4M | **可以开工**（两处一行级对齐先修） |
| 进度 | PC-1/PC-2 两 Critical **机制层修好**、PI-1/PI-2、PM-1…PM-6 全部处置；R1–R8 与七行矩阵无静默改写；点名回归钉抽查保持绿 | 0C / 0I / 6M | **可以开工**（6 Minor 在对应 Task 写代码前订正） |
| Artifact | AI-1/2/3/6/7/9/10 实质闭环（AI-3 选路线 a，跨计划数据流逐段可达、规格同步订正）；AI-4/8 方向对但新测试代码有缺陷；AM-5 有意保留 | 0C / 3I / 5M | **With fixes**：先修 I1/I2/I3 |

主 agent 独立核实要点：

- **PC-1 修法正确**（进度 plan:272-302）：ALS 建在 `tools/execute` around-dispatch 监听、`spawnKind.run(kind, () => next())` 包住 body；模块单槽保留为回落（`getStore() ?? pendingSpawn`）；上游三段派发事实逐字写入计划；防假绿钉 `currentDispatchSkillKind()` 在 body 阶段断言，错挂 pre-execute 必红。与主 agent 首轮核实的上游结构（core/tools index.ts:1377/1513/1543/1609/1589）一致。
- **Artifact I1 属实**：vitest.config.ts include=`tests/**/*.spec.ts` 无 exclude；真实 Electron 探针（plan:1008/1222）会进 workspace `test`→根 `check`→CI check job（ci.yml:64 ubuntu-latest、:113 yarn check），无 DISPLAY 必红，且违反外层 AGENTS.md headless-safe。
- **Artifact I2 属实**：签名 `projectAutomationResult(items, run, artifact?, createAttachment?)`（plan:742/948），测试 :785 把工厂传进第三参 artifact 槽位⇒类型错误 + legacy 分支抛 `legacy-attachment-factory-required`，正确实现也红。
- **Artifact I3 属实**：`isPackageChildSession` 全仓（src+tests+policy 包）零命中，plan:420 使用⇒编译不过。origin 门对包儿童已 fail-closed（子会话不经 register→unknown→detach），该谓词冗余。
- **进度 startedAt 单位矛盾属实**：fixture ISO 字符串（plan:633）vs prose `startedAt?: number`（plan:667）；实现契约是 number，fixture 错，TypeScript/测试会在实施期暴露，非生产静默缺陷，定 Minor。
- **技能守卫范围宽于规格属实**：plan:872-877 双草稿态拒绝所有回合；规格 §7 步 6（spec:140）与 §12.1#5（spec:248）只要求 propose/commit/裸取消三向。fail-closed 方向、态罕见，定 Minor，二选一对齐。
- **AM-5 偏离属实且可辩护**：Artifact plan:30 把 `refreshAgentRestrict(ctx as never)` 升格为全局约束「沿用既有惯用法」；该惯用法在桌面树真实存在（creation.ts:103/110、skills.ts:344/471）。与评审修法（收窄签名）不同，属有意偏离，**交 owner 知悉认可**，不阻断。

### 8.2 复审新发现清单

#### 技能（4 Minor）

- **XM-S1** 双草稿守卫拒绝面宽于规格（plan:872-877 vs spec:248）：收窄到创建/继续/取消类回合，或规格明改「全回合 fail-closed」，二选一对齐。
- **XM-S2** `onStartConversationCreate` 断言 `toHaveBeenCalledWith('/create-skill')`（plan:1032）与 prop 类型 `() => void`（:1084）不齐：prop 定型 `(preset: string) => void` 且组件传参，或断言改调用次数、把发送内容钉在 App 接线层。
- **XM-S3** Task 4 发 skill/* 事件但 RpcEvent 变体 Task 6 才加（plan:591-597 vs :942），中间提交 typecheck 红：事件类型移入 Task 4 提交清单，或显式登记中间态债（原稿即有，非新引入）。
- **XM-S4** `SkillCreationHost.hasDraft` 数据源未写明（plan:648）：补「读磁盘草稿存在性」一句，防 memory-only 实现（测试会逼出正确实现，不构成洞）。

#### 进度（6 Minor，均为计划文本精度，写对应 Task 代码前订正）

- **XM-P1** Task 3 Step 4 片段重复 `const effectiveRunId`（plan:431/:436）、生命周期片段用未定义标识符 `runId`/`activation`（实在变量 `systemRunId`/`run`）、`registry!` 无条件非空断言；**`if (systemRunId !== undefined)` 门控只在 prose 未进片段**——照抄成无条件挂接会覆盖宿主 legacy/package 的取消闭包（subagent-runs.ts:693-699）。删重复、统一标识符、门控写进片段。
- **XM-P2** 实时载体类型落点漏列：`tool/start` 在 client rpc-types.ts:525-536 无 clientMessageId，Task 4 Files 须同批扩；`startQueuedItem` 实在 sessions.ts:859-880（不在 turn-scheduler.ts），Task 1 Files 行段未覆盖。
- **XM-P3** Task 5 锚点 startedAt 单位自相矛盾（fixture ISO vs prose number）：钉死 epoch-ms 数值，fixture 与实现同单位。
- **XM-P4** PM-2 措辞残余（plan:268 括号）：start 路径直接 attach 原始常量未经 allow 过滤（过滤只在 activation 路径），括号删/改。
- **XM-P5** PI-1 harness 注入清单缺 `huaanworkSubagentRuns`/`huaanworkTurnAnchors`（断言依赖），一并列出。
- **XM-P6** PI-2 启动期取消依赖未写明：system-skill 无法向上游工具自建 spec 注入 signal，靠 registry attachCancel 晚绑定补启动（subagent-runs.ts:693-700）；补「activation pending 时受理取消→返回后补清理收敛 stopped」钉。另 `consumePendingSpawn` ALS 命中时无条件清单槽（plan:296）会清掉另一会话在途写入，建议仅 `getStore() === undefined` 时清。

#### Artifact（3 Important + 5 Minor）

- **XI-1（Important）** 真实 Electron 探针打红 headless Linux CI（证据见 §8.1）：探针移出默认 include（独立目录/命名 + vitest exclude + 专用 script，只在 desktop-macos/windows job 或本地执行），Task 6 Files/Step 5 与 CI 说明同步。
- **XI-2（Important）** legacy 钉传参错位（plan:785）：改 `projectAutomationResult(legacyItems, legacyRun, undefined, createAttachment)`。
- **XI-3（Important）** `isPackageChildSession` phantom（plan:420）：指明谓词来源（huaanworkPackageChildAllow holder 或 host 血缘判定）写入 Consumes，或删冗余条件以 origin 门为准并补包儿童钉。
- **XM-A1** sanitizer 链未钉穿：defaultPath 钉由测试自己先调 sanitizer 只证 passthrough；Task 1 补「summary.downloadName 已清理+强制扩展名」钉，download 测试传原始名。
- **XM-A2** 测试引用不存在 helper/缺必填参：`getRunSummary` 全仓不存在（store 只导出 recentRuns，stores.ts:609），声明为 harness 包装或直接用 recentRuns；`deleteAutomationRun` 调用缺 opts.sessionsRoot（automations-store.ts:685-694）。
- **XM-A3** 「复用既有 fs mock」失实（plan:1262）：electron-runtime.spec.ts 只 mock electron.dialog，无 writeFile/rename；措辞改「扩展 Electron mock 并新增 node:fs/promises mock」。
- **XM-A4（已裁定关闭，2026-11-16）** owner 裁定保留既有 `refreshAgentRestrict(ctx as never)` 惯用法（Artifact plan:30 全局约束），不按评审建议收窄签名。偏离经认可：与桌面树既有代码一致（creation.ts:103/110、skills.ts:344/471），复审校准为可辩护偏离。本项闭环，不再阻断。
- **XM-A5** 实时 run 来源欠一句明文 + appWiring 级钉：「实时用 event 构造 run、历史用 RunSummary」只在规格 §6.3:221，Task 5 Step 5 补明文与 run-end 级「带 created/failed 不走旧折叠」钉；顺手补 assistant 项数 0 断言。

### 8.3 复审判决与开工安排

- **技能计划：可以开工。** XM-S1/S2 两处一行级对齐先修，XM-S3/S4 随修订落。
- **进度计划：可以开工。** 6 项 Minor 在对应 Task 写代码前订正（XM-P1 的门控入片段最重要，防取消闭包覆盖）。
- **Artifact 计划：修完 XI-1/2/3 后开工**（三项都是小改：探针挪 lane、一行传参、谓词来源），XM-A1/A2 钉强与 helper 缺口同批补。
- **跨计划顺序**：AI-3 路线 (a) 使 Artifact Task 2 依赖进度计划 Task 1 的 turn-anchors 模块（plan:13 已声明可先独立合并、不要求 ProgressPanel Tasks 2-4）。建议 turn-anchors 先行落地，技能/进度/Artifact 主体可并行 worktree，App.tsx 合并冲突注记保留。
- **owner 裁定（2026-11-16）**：XM-A4 保留 `as never` 惯用法，偏离经认可，闭环（见 §8.2）。其余开工门槛不变：技能 XM-S1/S2 两处一行级对齐、进度 XM-P1（门控入片段）及其余 Minor、Artifact XI-1/2/3 仍待修。
- 修订完成后主 agent 做最终定向确认（只核 XI-1/2/3 + XM-S1/S2 + XM-P1），通过即全面开工。

## 9. 第 8 节意见核验与修订闭环（2026-11-16 第四轮）

- 核验方式：三个只读核验 agent 分计划逐条对照修订稿、规格与真实源码；修订后由同一口径做对抗性回读。主 agent 处理跨项联动与测试分层，不只复制复审结论。
- 总结：**17 项未关闭意见全部确认成立并已修订，无驳回项**。XM-A4 已由 owner 关闭，本轮不重审、不改变 `as never` 决定。
- 复审文本校准：① §8.1 的规格引用已订正为 §7 步 6（spec:140）与 §12.1#5（spec:248）；② XM-S1 不能只删总守卫，必须同步约束双方后续注入与裸取消；③ XM-S4 的测试强制力取决于磁盘 seeding，已把 seeding 一并钉死；④ XM-A1 必须在存储→路由→native 分层验证，不能让 native 单测重复实现 sanitizer。

| 条目 | 核验与实际处置 |
| --- | --- |
| XM-S1 | 成立。按现有规格收窄双草稿总守卫到创建/继续/裸取消；技能侧注入和裸取消增加 `!agentDraft`，智能体继续/注入增加 `!skillDraft`；普通聊天、普通 `/name`、`@agent` 不再被全量拒绝。补普通聊天及两个显式创建入口的双草稿回归。 |
| XM-S2 | 成立。组件断言改为调用次数，`/create-skill` 发送内容保留在 App `appWiring` 接线钉，不把组件 prop 错改成带参。 |
| XM-S3 | 成立。`SkillConfirmCard` 与四个 `skill/*` RPC 变体前移至 Task 4 的 Files/实现/typecheck/commit；Task 5 直接消费，Task 6 不再重复修改事件联合。 |
| XM-S4 | 成立。`hasDraft` 明确调用 `hasSkillCreationDraftOnDisk`；`seedBothDrafts()` 直写合法磁盘草稿，排除 memory-only 假绿。 |
| XM-P1 | 成立。删除重复 `effectiveRunId`，统一 `systemRunId/run`，去掉 `registry!`，生命周期整段置于 `systemRunId !== undefined` 门内；legacy/package 取消闭包不会被覆盖，并补 `run` 显式窄化要求。 |
| XM-P2 | 成立。Task 4 同批扩实时 `tool/start` 与历史 record 类型；Task 1 的 sessions 文件段覆盖真实 `startQueuedItem`。 |
| XM-P3 | 成立。面板锚点 fixture 改 `Date.parse(...)`，与 registry 统一 epoch-ms；Host TurnAnchor 的 ISO 字符串是另一层契约，未误改。 |
| XM-P4 | 成立。订正 start 路径挂原始常量且不过滤，allow 过滤只属于 activation 路径。 |
| XM-P5 | 成立。harness 同批注入 `huaanworkSubagentRuns` 与 `huaanworkTurnAnchors`，并列出 registry fake 所需方法。 |
| XM-P6 | 成立。补 activation pending 取消→晚绑定清理→`stopped` 钉；说明不能向上游自建 spec 注入 signal；`pendingSpawn` 只在 ALS 未命中时清理。 |
| XI-1 | 成立。采用等效且更小的隔离：探针改 `.electron.ts`，独立 Vitest config 与 `test:artifact-sandbox`，只接入 desktop-windows/desktop-macos 或本地图形会话；默认 workspace/root test/check 与 Ubuntu check 不启动它。回读另补显式 `vitest` 导入。 |
| XI-2 | 成立。legacy 调用改第四参传 `createAttachment`，第三参显式 `undefined`。 |
| XI-3 | 成立。删除 phantom `isPackageChildSession`，只认 `origin==='advanced'`；Consumes 明确包儿童“不经 register→unknown→detach”的跨计划契约，并补 pre-step 级钉。 |
| XM-A1 | 成立，按层修订。Task 1 钉 `summary.downloadName` 清理/强制扩展名；Task 7 在 artifact-routes 用原始名钉路由到 native 的接线；native 单测改为纯透传，不重复 sanitize。 |
| XM-A2 | 成立。`getRunSummary` 明确为 spec harness 的 `recentRuns` 包装而非生产 API；Task 8 改用 `recentRuns` 并补两个 `deleteAutomationRun` 的 `sessionsRoot`。 |
| XM-A3 | 成立。措辞改为扩展 Electron dialog mock、新增 `node:fs/promises` 部分 mock；临时文件字节用内存 Map 搬运，避免 mock 后读真实临时文件。 |
| XM-A5 | 成立。Task 5 明文“实时 event 构造 run、历史 RunSummary”，补 run-end created/failed 不走旧折叠的 appWiring 钉、assistant 项数 0 及既有 fold 计数校对。 |
| XM-A4 | 不重审。owner 已裁定保留既有 `refreshAgentRestrict(ctx as never)` 惯用法，本计划未改动该决定。 |

### 9.1 最终边界与开工顺序

- 第 8 节范围内的计划开工门槛已解除；没有把第 8 节之外做新审查，也不声称这些计划已经实施。
- 保持 turn-anchors 共享模块先行；三主体并行时仍须处理 App.tsx 共同修改面。Artifact 不依赖 ProgressPanel Tasks 2-4。
- 本轮只修改 Markdown 计划/评审文档，没有运行生产代码测试或真实 Electron 探针；这些仍是实施 Task 与 Task 9 的验收义务，不得以文档闭环替代。

## 10. 主 agent 最终定向确认（2026-11-16）

- 确认方：Qoder 主 agent（独立核实，不采信 §9 修订方自述）
- 对象：10:00 修订稿（技能 1188 行 / 进度 736 行 / Artifact 1612 行；规格未动，XM-S1 走收窄守卫路线）
- 范围：§8.3 约定的最终门槛项 + 同批 Minor，逐条对计划文本与代码核实

### 10.1 核实结果（全部成立，无新问题）

| 项 | 修订稿证据 | 核实结论 |
| --- | --- | --- |
| XI-1 探针 lane | plan:1022/1084（`.electron.ts` 不匹配默认 `tests/**/*.spec.ts`）、:1157（独立 config 只含探针）、:1163-1168（`test:artifact-sandbox` script + 仅 desktop-windows/macos job step）、:1274（commit 含 ci.yml/config/package.json） | ✓ 默认 workspace/root test/check 与 Ubuntu check 均不启动；公共 vitest 配置不改 |
| XI-2 传参 | plan:793 `projectAutomationResult(legacyItems, legacyRun, undefined, createAttachment)` | ✓ 第三参显式 undefined、工厂第四参 |
| XI-3 phantom 谓词 | 全文无 `isPackageChildSession`；plan:420-441 门控唯一 `anchor?.origin === 'advanced'`，包儿童不经 register→unknown→detach；`agent/pre-step` 注册 `{ global: true }` 有真实先例（bridge.ts:113/118、approval.ts:68） | ✓ 编译可通过，fail-closed 成立 |
| XM-A1 sanitizer 分层 | plan:1382 路由级钉：原始名「结果.txt」→ native 收到「结果.html」+ 字节等价；native 纯透传不重复 sanitize | ✓ 存储→路由→native 分层验证 |
| XM-A2 helper/必填参 | plan:576 `getRunSummary` 声明为 recentRuns 的 harness 包装（非生产 API）；:1494/:1511 deleteAutomationRun 带 sessionsRoot | ✓ |
| XM-A3 fs mock 措辞 | plan:1307 明写现状无 fs mock、新增部分 mock、内存 Map 搬字节 | ✓ |
| XM-A5 实时载体钉 | plan:986 appWiring run-end 接线级钉（created/failed 用 event 构造 run、不走旧折叠、legacy 仍折叠）；:799/:815 assistant 项数 0 | ✓ |
| XM-S1 守卫收窄 | plan:903-908 `agentDraft && skillDraft && (requestedAgent \|\| requestedSkill \|\| bareCreationCancel)`；显式取消先于守卫（:872-890）；技能注入 `!agentDraft`（:930）、智能体侧 `!skillDraft`（§9 声明）；普通聊天//name/@agent 不再全拒 | ✓ 与规格 §7 步 6 一致 |
| XM-S2 断言/类型 | plan:1062 `toHaveBeenCalledTimes(1)`、:1107 prop 保持 `() => void`；发送内容钉在 App appWiring 层 | ✓ |
| XM-S3 事件前移 | plan:605 Task 4 Produces 含 SkillConfirmCard 类型 + 四个 skill/* RpcEvent 变体 | ✓ 中间提交 typecheck 不再红 |
| XM-S4 磁盘事实源 | plan:658 hasDraft 必须调 hasSkillCreationDraftOnDisk；:730 seedBothDrafts 直写合法磁盘草稿 | ✓ 排除 memory-only 假绿 |
| XM-P1 门控入片段 | plan:439 单一 `const effectiveRunId`；:440/:455 生命周期整段在 `if (systemRunId !== undefined)` 内；:450 标识符 systemRunId/run、显式 TS 窄化不用 `run!`、预留 childId 不符 dispose+failRun+throw | ✓ 取消闭包不被覆盖 |
| XM-P2 类型落点 | plan:46 sessions Files 含 :859-883（startQueuedItem）；:174 QueueItem clientMessageId；:586 rpc-types tool/start 变体 + 历史 todos/clientMessageId 同批 | ✓ |
| XM-P3 单位 | plan:647 fixture `Date.parse(...)` → epoch-ms；:681 明写「fixture 与实现不得混用 ISO 字符串」；Host TurnAnchor ISO 是另一层契约（:143）未误改 | ✓ |
| XM-P5 harness 注入 | plan:388 注入 huaanworkTurnAnchors（registry fake 方法清单见 §9） | ✓ |
| XM-P6 单槽竞争 | plan:297 `if (spawnKind.getStore() === undefined) pendingSpawn = undefined`；晚绑定取消钉见 §9 | ✓ 不清另一会话在途写入 |
| XM-P4 措辞 | §9 声明订正（start 路径挂原始常量不过滤） | 文本项，与已核实机制一致 |

### 10.2 最终判决

> 2026-11-17 适用范围更新：以下为当时修订稿的历史判决；进度计划的当前开工判决已由 §16 更新为 With fixes。其余两份计划本轮未重审。

**三份计划达到实施标准，开工门槛解除。**

- 技能计划：可开工（XM-S1…S4 全部落地）。
- 进度计划：可开工（XM-P1…P6 全部落地；两 Critical 修法经主 agent 二轮核实机制正确）。
- Artifact 计划：可开工（XI-1/2/3 + XM-A1/A2/A3/A5 全部落地；XM-A4 owner 已裁定）。
- 本轮未发现新问题；§9 修订方自述与计划文本逐条吻合，无夸大。

### 10.3 开工安排与实施期义务

1. **顺序**：进度计划 Task 1 的 turn-anchors 共享模块先行（Artifact Task 2 消费，已声明可独立先合并、不依赖 ProgressPanel Tasks 2-4）；技能计划按 §9 排序先行亦可；三主体并行 worktree 时 App.tsx 共同修改面保留冲突注记。
2. **实施期义务（文档闭环不替代）**：每 Task TDD red→green→commit；包级 + 根 `corepack yarn check` 全量门禁；Artifact Task 9 真机验收七项 + 证据落盘；真实 Electron 探针只在 desktop job/本地图形会话执行；verify:aa 串行。
3. **回归钉**：进度计划点名的包 allow/血缘/policy/skills 既有钉保持绿（复审已抽查）；实施时任一钉转红按回归处理，不得静默改钉。
4. 实施完成后按惯例走整支代码评审 + 真机验收，再议合并。

## 11. GLM 独立复审与二次复核（2026-11-16 第五轮）

- 复审方：GLM 主 agent（CodeBuddy 会话，评审轨独立于 §1–§10 的 Qoder 主 agent 轨）；初审由独立评审 subagent 完成，GLM 主 agent 随后对全部 Important/Minor 逐条背靠背二次复核（含代码逐行验证）
- 对象：`docs/superpowers/plans/2026-11-15-chat-created-skills.md`（1188 行，即 §10 最终确认稿）对照 `specs/2026-11-15-chat-created-skills-design.md`（267 行）
- 范围：规格覆盖矩阵（R1–R10、§2/§6/§7/§8/§9/§11/§12 逐条）、代码落点核实（15+ 处现状锚点）、计划内部质量（依赖顺序/失败测试先行/提交清单/语义偏离）
- 只读评审：本轮未修改任何计划/代码文件，仅输出意见并落档本文

### 11.1 GLM 审核结论

**0 Critical / 3 Important / 6 Minor；计划达到实施标准。** 规格覆盖完整（除 11.2-I3 的测试草稿缺口外全有落点）、代码落点全部核实属实、任务依赖无前向依赖、失败测试先行成立（含现状"智能体草稿接管 `/create-skill`"确证）、无语义偏离（同意/取消语集合与智能体现状 `drafts.ts:65-66` 逐字一致）。3 Important 均为计划文本修订项，不阻断架构：**建议在对应任务开工前把 3 处 Important 修订进计划文本，修订后即可从 Task 1 开工**；6 Minor 可在对应任务实施中顺手处理。

三项 Important 均为本轮新增发现，Qoder §1–§10 轨未覆盖（部分同域但不同点：XM-S4 已钉技能侧 hasDraft 磁盘事实源，但智能体侧 describeDraft 的严格读取路径仍未在计划中指定；§2.1 曾表彰"计划正确规避死锁"，但 Task 3 Step 4 措辞重新引入死锁读法）。

### 11.2 Important（3 项，全部经 GLM 二次复核确认成立）

#### I-1 Task 3 Step 4「锁内草稿重读」与锁非重入事实矛盾，按字面实现会死锁

- 位置：plan:568「锁内草稿重读 → 字段重校验 → `createSkillFromDraft(...)` → 删除草稿」；`createSkillFromDraft` 自身包 `withSkillStorageLock`（plan:339-357）；Task 2 Step 4 警告（plan:360）只点名 `createSkill`。
- 证据（GLM 逐行验证）：`withSkillStorageLock`（skills-host.ts:255-272）是 promise 链锁、非重入——先 `storageWriteLocks.set(key, current)` 再 `await previous`；外层 `fn()` 内再入同 key 时，内层 `await` 外层的 `current`，而外层 `release()` 要等 `fn()` 完成 → 循环等待，真死锁。
- 修法：修订 Task 3 Step 4 措辞——草稿重读/字段重校验/删草稿在锁外执行，`createSkillFromDraft` 自行取锁（或明示"锁内"仅指 `createSkillFromDraft` 内部锁覆盖的部分）。
- 二次复核修正：「与 Task 2 禁嵌套锁警告**直接矛盾**」措辞偏强——警告字面点名 `createSkill`，Task 3 调用的是 `createSkillFromDraft`；但二者取同一把锁、同一非重入原则完全适用，死锁风险真实。发现本身成立。

#### I-2 智能体侧 `describeDraft`「损坏抛具名错误」无可实现路径，路由代码草稿与散文承诺不符

- 位置：plan:938 散文要求两 Host describeDraft「缺失返回 undefined、损坏抛出具名错误；路由对损坏终止本次创建路由并发出损坏提示」；plan:910-918 路由代码草稿 `skillHost?.describeDraft(sessionId) ?? '技能草稿'` 无 try/catch。
- 证据（GLM 核实）：`loadAgentPackageDraft`（drafts.ts:379-394）把 JSON 解析失败吞成 `undefined`；`parseDraft`（drafts.ts:893-953）任一字段非法返回 `undefined`——现有 API 无法区分缺失与损坏；`describeDraft` 全仓 grep 不存在。按代码草稿写，损坏草稿会把 `sendToAgent` 变成未捕获异常而非提示。改 `loadAgentPackageDraft` 语义会连带破坏 `hasDraft`（host.ts:420-424 直接调用它）。
- 修法：计划补实现指示——为智能体侧新增严格草稿读取（区分 ENOENT 与解析失败、抛具名错误），并在路由代码草稿给 describeDraft 调用补损坏分支（捕获具名错误 → 发 notice、`started:false`、不注入不挂载）。技能侧无此问题（Task 3 的 `loadSkillCreationDraft` 自带 `CorruptSkillCreationDraftError`）。
- 二次复核修正：初审称改 `loadAgentPackageDraft` 语义会连带破坏 `cancelAgentPackage`（drafts.ts:358-370）——**不实**。`cancelAgentPackage` 只用 `existsSync` + `rmSync`，不调用 `loadAgentPackageDraft`；受影响的是 `hasDraft`。核心发现（无可实现路径 + 路由代码无 try/catch 与散文不符）成立。

#### I-3 规格 §12.1 第 2/3 条的五个用例无测试代码草稿

- 位置：Task 3 Step 1（plan:413-516）五个测试用例全部使用 `creationTurn: true` 与正确 `proposed.draftId`；「非创建轮借草稿、错误 draftId、损坏草稿 fail-closed、名称冲突保留草稿」四用例只在 Step 5 Expected（plan:578）点名；「确认卡与最终 frontmatter 字段一致」（spec §12.1 第 2 条）全计划无字段级断言（所有断言只查 `name`）。
- 影响：非创建轮门禁（防技能轮/`@` 轮借旧草稿提交）是本规格核心授权约束；Step 5 Expected 不是写测试的指令，实施者最易静默跳过。
- 修法：把五个用例的测试代码补进 Task 3 Step 1（非创建轮：`commitSkillCreation(..., {proposedThisTurn:false, creationTurn:false})` 断言 `ok:false`；确认卡一致：断言 `committed.card` 的 name/description/whenToUse/contentPreview 与 proposal 同字段一致）。

### 11.3 Minor（6 项，全部经 GLM 二次复核属实）

- **M-1** Task 5 Files（plan:701）与 git add（plan:964）含 `agent-package/creation.ts`，但五个 Step 无一步修改它。
- **M-2** `styles-generated.spec.ts` 只做 styles.css↔generated 新鲜度比对（全文 13 行，无需修改），列入 Task 6 Files（plan:983）误导；Step 6 git add 已正确不含它。
- **M-3** 计划入口规范化无条件 `skillName = undefined`（plan:856-859），现网带 `packageHost !== undefined` 守卫（sessions.ts:200-201）；宿主门面未注入的纯测试组合下 `/create-agent` 从"普通技能解析报错"变为"普通聊天文本"。`index.ts` 恒注入 host，无用户可见影响，应在计划注明该边缘行为变化。
- **M-4** 技能侧对智能体草稿的只读存在性检查硬编码 `<profileDir>/agents/.drafts/<sessionId>.json`（store.ts:78-80、drafts.ts:889-891 双重声明既有；计划为第三处），智能体侧路径变更时会静默失效；建议提取共享最小路径常量或加交叉注释。
- **M-5** `attachSkillCreationTools/detachSkillCreationTools` 应镜像智能体先例的 `refreshAgentRestrict`（creation.ts:99-111 每次挂/卸后刷新），Task 4 Step 4 未提，否则工具集可见性要等下一轮才更新。
- **M-6** Task 6 只钉 `skill-success` 的 ChatItem 变体形状（plan:1097）；`skill/confirm` 插入确认卡所用 ChatItem 变体未钉，实施者需自行设计。

### 11.4 二次复核结论（GLM 主 agent 逐项验证）

- **3 Important / 6 Minor 全部成立，无误报、无 severity 夸大**（Important 定级合理，均不构成 Critical）；「达到实施标准、修订 3 处 Important 后可从 Task 1 开工」的总结论维持。
- 两处细节修正（不影响发现有效性）：I-1「直接矛盾」措辞偏强（见 11.2）；I-2 的 `cancelAgentPackage` 支撑证据错误、受影响方实为 `hasDraft`（见 11.2）。
- 锚点抽查全部属实：同意/取消语集合与 drafts.ts:65-66 逐字一致；`TRAILING_PUNCTUATION` 仅声明+normalizeUtterance 一处使用（删后死代码）；`describeDraft` 全仓不存在；现网确实存在"智能体草稿接管 `/create-skill`"（sessions.ts:197-240 `activeDraft` 分支）——Task 5 失败测试针对真 bug。

### 11.5 处置建议

1. 开工前按 I-1/I-2/I-3 修订计划文本（均为小改：一句锁措辞、一段严格读取实现指示 + 路由损坏分支、五条测试草稿补进 Step 1）。
2. M-1…M-6 在对应任务实施中顺手处理（M-3 需在计划中注明边缘行为变化；M-5 建议随 Task 4 落）。
3. 修订后无需再来一轮全量评审；按 §8 惯例可由修订方自述 + 主 agent 定向确认 I-1/I-2/I-3 三个处置点即可开工。

## 12. Qoder 主 agent 对 §11 的独立核验（2026-11-16）

- 核验方：Qoder 主 agent（对 GLM 全部 3 Important + 6 Minor 逐条对计划文本与代码独立核实，不采信 §11 自述）
- 判决：**§11 结论属实，全部采纳，无驳回项。** 0C/3I/6M 定级合理；GLM 两处自我修正（I-1「直接矛盾」措辞偏强、I-2 受影响方是 hasDraft 而非 cancelAgentPackage）经核实均正确。

### 12.1 逐条核验

| 项 | 核验证据 | 结论 |
| --- | --- | --- |
| I-1 死锁读法 | plan:568「锁内草稿重读→重校验→createSkillFromDraft→删草稿」；createSkillFromDraft 自包 withSkillStorageLock（plan:339-357）；锁非重入（skills-host.ts:255-272 promise 链，内层 await 外层 current、外层 release 等 fn 完成→循环等待）；警告 plan:360 只点名 createSkill | 成立。修法（重读/校验/删草稿在锁外，createSkillFromDraft 自取锁；权威校验本就在 createSkillLocked 锁内）可行 |
| I-2 describeDraft 无路径 | plan:938 散文要求损坏抛具名错误+路由损坏提示；plan:914-915 代码 `?? '技能草稿'` 无 try/catch；loadAgentPackageDraft（drafts.ts:379-394）readFileSync/JSON.parse catch 均吞成 undefined、parseDraft 非法→undefined，无法区分缺失/损坏；hasDraft（host.ts:420-424）直接调用它；cancelAgentPackage（drafts.ts:358-370）仅 existsSync+rmSync（GLM 自我修正正确）；技能侧 loadSkillCreationDraft 有 CorruptSkillCreationDraftError（plan:555）无此问题 | 成立。修法（智能体侧新增严格读取 + 路由损坏分支）可行 |
| I-3 五用例无测试草稿 | Task 3 Step 1 五个 it 全部 creationTurn:true + 正确 draftId（plan:413-516 逐行）；非创建轮/错误 draftId/损坏 fail-closed/名称冲突保留草稿仅在 Step 5 Expected（plan:578）点名；committed.card 字段级断言全计划无（plan:998 是 Task 6 组件 fixture，非 host 断言） | 成立。核心授权门禁测试缺口，修法可行 |
| M-1 creation.ts 空列 | Files plan:701 + git add :964 含 creation.ts；Task 5 各 Step 改 sessions.ts/drafts.ts/host.ts/skill-creation.ts，无一步改 creation.ts | 成立 |
| M-2 styles spec 误列 | styles-generated.spec.ts 实测 13 行新鲜度比对；列 Task 6 Files plan:983，git add 已不含 | 成立 |
| M-3 规范化守卫差异 | plan:856-859 无条件清 skillName；现网 sessions.ts:200-201 带 packageHost!==undefined 守卫；index.ts 恒注入，无用户可见影响 | 成立，计划注明边缘变化即可 |
| M-4 路径第三处 | 测试 seeding plan:508 `join(root,'agents','.drafts')`；生产只读 helper 路径未指定（plan:559/:942）；既有声明 drafts.ts:889-891 + store.ts:78-80 | 成立（「第三处」指测试夹具）；共享常量/交叉注释建议合理 |
| M-5 refresh 未提 | 全计划 grep refreshAgentRestrict 零命中；先例 creation.ts:99-111 每次挂/卸后刷新；attach/detachSkillCreationTools 仅 Produces（plan:603）无函数体 | 成立。**后果校准：比 §11 描述更重**——附件 map 变更不触发 tools/change，不刷新则工具可能直到无关 tools/change 才可见（不是「等下一轮」），访谈轮模型看不到 skill_propose。定级仍 Minor（函数体未写错、属欠指定，计划多处要求沿用先例），但建议随 3 Important 同批修进 Task 4 文本（一句话） |
| M-6 confirm 变体未钉 | plan:1097 只钉 skill-success ChatItem 变体；skill/confirm 插卡的 ChatItem 变体形状未钉 | 成立 |

### 12.2 审计轨迹：一项怀疑经核实撤回

核验过程中曾怀疑 plan:440-452 的同会话重放断言写反（ok:false）。**经逐行重读撤回**：ok:false 断言实属 plan:470-478 的**跨会话**重放拒绝用例（'rejects a committed credential replayed from another session'，行为正确）；同会话重放用例（plan:439-456）正确断言 `{ok:true, alreadyCommitted:true, name:'daily-summary'}`，与 plan:568 散文及规格 §8.2 一致。初判系 sed 分区误读，不构成发现，GLM 此处无漏报。

### 12.3 对 §11 元断言的核实

- 「3 Important 均为 Qoder §1–§10 轨未覆盖」属实：§2.1 表彰的锁规避仅核到 plan:306/360 警告，未核 Task 3 Step 4 措辞；describeDraft 是 XM-S1 修订新增，§10 核了守卫收窄未核其可实现性；I-3 的五用例缺口未被覆盖检查捕获。认领为本轨漏报。
- 「达到实施标准、修订 3 Important 后开工」同意；采纳 §11.5 处置（M-5 建议提前到 Important 同批）。

### 12.4 处置与开工门槛（更新）

1. 开工前修订进计划文本：I-1（锁措辞）、I-2（智能体侧严格读取 + 路由损坏分支）、I-3（五用例测试草稿补进 Task 3 Step 1）、**M-5（attach/detach 镜像 refreshAgentRestrict 一句，随同批）**。
2. M-1/M-2/M-3/M-4/M-6 在对应任务实施中顺手处理（M-3 注明边缘变化）。
3. 修订后主 agent 定向确认 I-1/I-2/I-3/M-5 四处，通过即从 Task 1 开工；无需全量重审。

## 13. 处置记录：九项修入计划文本（2026-11-16，Qoder 主 agent）

- 执行依据：owner 指示「按 §12.4 修 I-1/I-2/I-3/M-5，M-1/M-2/M-3/M-4/M-6 也在开工前修掉（M-3 注明边缘变化）；Task 1 开工等人工确认」
- 对象：`docs/superpowers/plans/2026-11-15-chat-created-skills.md`（1188 → 1321 行）；**未改任何代码文件**
- 自检：grep 计数 + 区域重读 + 测试/导入一致性核对，全部通过

| 项 | 修订内容 | 修订稿位置 |
| --- | --- | --- |
| I-1 | Task 2 警告扩名 `createSkillFromDraft` 并写明非重入死锁机理；Task 3 commit 段改「锁外重读/重校验 → createSkillFromDraft 自取锁 → 成功后删草稿」，明示不得再包一层锁、竞态由 createSkillLocked 锁内校验兜底 | 警告段（grep「非重入」×2）、commit 门禁段 |
| I-2 | ① drafts.ts 新增 `loadAgentPackageDraftStrict` + `CorruptAgentPackageDraftError`（ENOENT→undefined，其余抛），不改宽松 `loadAgentPackageDraft`（hasDraft 依赖）；② host.describeDraft 用严格读取；③ 路由互斥块加 try/catch（两类具名错误→notice+started:false，其余继续抛）；④ **可达性补强**：互斥前加 6a 检测「磁盘在场（hasAgentCreationDraftOnDisk）而宽松 hasDraft 读不出 ⇒ 损坏」→ fail-closed 终止并提示 /create-agent cancel；⑤ Step 1 补损坏路由回归（:840）；⑥ Files drafts.ts 行段扩 :379-394 | 路由片段 6/6a、describeDraft 实现路径段、:840 测试、Files |
| I-3 | Task 3 Step 1 补五条测试草稿：非创建轮拒绝（:517）、错误 draftId（:531）、损坏 fail-closed（:545）、名称冲突保留草稿与既有技能（:558）、成功卡字段一致含 500 字 preview 规则（:578）；导入 prose 补 createSkill/listUserSkills/CorruptSkillCreationDraftError（:599） | :517-599 |
| M-5 | Task 4 Step 4 补 attach/detachSkillCreationTools 完整函数体（镜像 creation.ts:99-111，每次挂/卸后 refreshAgentRestrict）+ 后果说明（不刷新则工具直到无关 tools/change 才可见，流程卡死）+ 函数级断言要求；as never 沿用 XM-A4 裁定 | Step 4 末段（grep refreshAgentRestrict ×4） |
| M-1 | Task 5 Files 与 git add 移除 creation.ts（无步骤修改它） | grep creation.ts 零命中 |
| M-2 | Task 6 Files 的 styles-generated.spec.ts 改「Run-only（不修改）」注明 13 行新鲜度比对、不入提交 | Files 段 |
| M-3 | 规范化片段加注释：与现网 packageHost 守卫的差异、纯测试组合边缘行为变化、index.ts 恒注入无用户可见影响 | 路由片段步 2 |
| M-4 | 只读 helper 定名 `hasAgentCreationDraftOnDisk`（skill-creation-drafts.ts 导出）；路径与 drafts.ts:889-891 draftPath 一致 + 两处交叉注释 + seeding 同路径表达式；路由 6a 复用 | Task 3 propose 段、路由 6a |
| M-6 | ChatItem 增 `skill-confirm` 变体 `{id,kind:'skill-confirm',card:SkillConfirmCard}`，与 skill-success 并列；appWiring 对两变体形状各一条直断言 | Task 6 事件处理段 |

### 13.1 处置中的补强发现（审计轨迹）

I-2 落地时发现 GLM 修法与 §12 核验均未覆盖的可达性问题：智能体侧 `hasDraft` 是宽松读取（损坏吞成 undefined），损坏草稿不会触发互斥分支，仅加 describeDraft try/catch 时损坏提示路径基本不可达。处置补 6a 磁盘存在性检测使 fail-closed 真正可达，try/catch 保留为竞态防御。此补强不改变 GLM 发现的有效性，属处置层完善。

### 13.2 状态

- 技能计划 §11 全部 9 项处置完毕，计划文本达到开工标准；**Task 1 开工待 owner 人工确认**。
- 进度 / Artifact 计划不受本轮影响（本轮只改技能计划）；其开工门槛见 §10.3。
- 实施期义务不变：TDD、全量门禁、真机验收；本轮未运行任何代码测试（纯文档修订）。

## 14. GLM NI-1 复核与处置（2026-11-16，Qoder 主 agent）

- 发现来源：GLM 对 §13 处置稿的新一轮评审，NI-1（Important）——6a 提示的补救入口 `/create-agent cancel` 被 agentCancel 守卫（宽松 hasDraft !== true 即报「没有可取消」）挡死，损坏文件永不清理，补救指引死循环；加重因素：损坏智能体草稿 + 有效技能草稿双在场时 6a 每回合触发，/create-agent 重建逃生口也被先拦，唯一逃生链未提示未测试。
- 独立核实：**属实**。agentCancel 守卫（plan:991 区域）对损坏草稿（宽松读 undefined）直接返回，cancelAgentPackage（existsSync+rmSync，drafts.ts:358-370）到不了；6a 提示（plan:1025 区域）与 :1071 散文承诺的清理路径不可达。与 I-2 同缺陷类（散文承诺 ≠ 代码路径），且是 §13 主 agent 自补 6a 时引入——认领。
- 严重度校准：同意 Important。fail-closed 本身成立（无错误写入/越权），仅补救死循环 + 无测试；状态罕见（原子写下损坏不易）；一行级修复。非 Critical。
- 修法裁定：采纳 GLM 方案①（守卫放宽：宽松 hasDraft 为假**且磁盘不在场**才报「没有可取消」，磁盘在场放行到 cancelAgentPackage）。方案②（改提示文案）保留守卫不一致，不采纳。
- 额外推演（撤回一项初步怀疑）：曾疑 6a 条件 `(requestedSkill || skillDraft)` 过宽拦普通聊天；推演后撤回——技能草稿在场时普通消息按 step 8 即「继续创建」，R8 要求另一类草稿（含损坏文件）在场即拒绝；无技能草稿时 6a 不触发普通聊天。条件与 R8 一致，不收窄。
- 处置（已修入计划文本）：① agentCancel 守卫放宽 + NI-1 注释；② 6a 注释补补救路径保证与 R8 一致性说明；③ I-2 散文段补守卫放宽与双在场逃生链；④ Task 5 Step 1 补两条回归：`/create-agent cancel` 清理损坏文件（断言 cancel 被调、文件删除）、双在场时清理损坏智能体草稿不触碰技能草稿。
- 状态：NI-1 闭环；技能计划开工门槛维持解除，**Task 1 仍待 owner 人工确认**。

## 15. GLM NI-1 修复确认（2026-11-16）

- 确认方：GLM 主 agent（对 §14 处置稿的定向复核；只读，未修改任何文件）
- 对象：`docs/superpowers/plans/2026-11-15-chat-created-skills.md` 1321 → 1344 行（+23 行全部为 NI-1 修复；其余段落经锚点抽查核对无变动）
- 复核方式：§14 四处处置点逐项核验 + 路由逻辑六状态走查 + 新增测试断言核对

### 15.1 修复核验（四处处置全部属实）

| 处置点 | 修订稿证据 | 核验结论 |
| --- | --- | --- |
| ① agentCancel 守卫放宽（§14 方案①） | plan:1008-1022：`packageHost?.hasDraft(sessionId) !== true && !hasAgentCreationDraftOnDisk(routeCtx.profileDir, sessionId)` 才报「没有可取消」；附 NI-1 注释说明放宽理由 | ✓ 损坏草稿（磁盘在场、宽松读不出）放行到 `packageHost.cancel` → `cancelAgentPackage`（existsSync+rmSync）真正清理文件，6a 提示的补救入口不再被自己的守卫挡死 |
| ② 6a 注释闭环 | plan:1045-1046：「补救路径由放宽后的 agentCancel 守卫保证（NI-1）：磁盘在场即可 /create-agent cancel 清理」+「条件与 R8 一致：技能草稿在场时普通消息即『继续创建』，损坏文件算『在场』；无技能草稿时普通聊天不触发」 | ✓ 补救承诺与代码一致；拦截面语义与 step 8/R8 一致（GLM 复核中对 6a 过宽的疑虑经推演撤回，与 §14 推演独立同结论） |
| ③ I-2 散文段同步 | plan:1094：补「agentCancel 守卫同批放宽（NI-1）」+ 双在场逃生链（显式取消在 6a 之前解析，放宽守卫可清理损坏文件） | ✓ 散文与代码草稿不再矛盾 |
| ④ 两条回归测试 | plan:850-857 `lets /create-agent cancel clean a corrupt agent draft (NI-1 recovery path)`：断言 `packageHost.cancel` 以 `('session-1', {explicit:true})` 被调用（正是原先被守卫挡住的路径）+ 文件删除（readFileSync 抛错）；plan:859-866 双在场用例：智能体损坏草稿被清、技能草稿内容原样保留 | ✓ 恰好钉住原先不可达的调用路径与双在场态；断言风格与 harness 既有 `packageHost.cancel` spy 断言一致 |

### 15.2 路由六状态走查（全部正确）

1. 损坏智能体草稿单独在场 + `/create-agent cancel` → 守卫放行（磁盘在场）→ 文件清理——原死循环解除。
2. 损坏智能体草稿 + 有效技能草稿双在场 + `/create-agent cancel` → 显式取消在 step 5/6a 之前解析 → 清理且技能草稿不动。
3. 无任何草稿 + `/create-agent cancel` → 守卫两条件皆真 → 「当前没有可取消的智能体创建」——正常行为保留。
4. 有效智能体草稿 + `/create-agent cancel` → 宽松 hasDraft 为真 → 照常取消——正常行为保留。
5. 损坏智能体草稿 + `/create-skill` → 6a 提示的 `/create-agent cancel` 补救入口现真实可达。
6. 技能侧无对称问题：`skillHost.hasDraft` 本就是磁盘存在性，`/create-skill cancel` 守卫无需放宽（plan:1094 已注明）。

### 15.3 判决

**NI-1 闭环。** §11 的 3 Important + 6 Minor（含 §12.4 提级同批的 M-5）、§13 九项处置、§14 NI-1 处置全部落地并经 GLM 两轮定向复核确认；本轮未发现新引入问题。**技能计划达到可开工标准；Task 1 开工待 owner 人工确认**（维持 §13.2/§14 状态约定）。GLM 评审轨至此完整闭环：发现（§11）→ 审计（§12）→ 处置（§13）→ 新发现 NI-1 → 处置（§14）→ 修复确认（本节）。

## 16. qwen4评审结论（2026-11-17，进度计划双向复核）

> 本节保留 Gemini 修订前稿件的历史意见；修订后的处置核验、剩余项与严重度校准见 §17，不再把本节的 6 Important / 4 Minor 视作当前待办数。

### 16.1 对象、方法与判决

- 依据：owner 要求对本会话上一轮评审 double check 误报、漏报与夸大，再将校准结论落入本文；本轮不实施功能、不修订需求稿。
- 对象：当前工作区的 [进度计划](2026-11-15-progress-sidebar.md)（下称 P）与 [设计规格](../specs/2026-11-15-task-progress-sidebar-design.md)（下称 S）。两份均含 owner 已有的未提交修订，不使用 §10 的旧行号或旧 PASS 代替重新核查。
- 源码基线：`3dd3b182bc8c28671d5f712a7ae2da23dab463bd`；上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`。运行时消息来源另外核对桌面工作区实际安装的 `@deepseek-ai/dsh-subagent@0.2.1-rc.1`，不把子模组源码版本等同于安装产物版本。
- 稿件指纹（`git hash-object`）：P=`4749d7b059037aacc49ca7c157dc1be95cde3047`，S=`646149d75ec05f3907fb4b61e961a43ab545b08a`。以下 P/S 行号均指这两份稿件。
- 方法：两路独立只读审计分别反证既有意见与寻找漏项；主 agent 对新增 Important 逐条读源码、核对实际运行时产物，并运行计划片段、真实 registry、历史映射、缓冲过滤和 TypeScript 内存探针。未采信「全部成立」式汇总结论。

**判决：With fixes，0 Critical / 6 Important / 4 Minor。现稿尚不能直接实施，但无需推倒重写。** UUID/runId 发送、around-dispatch ALS 挂点、registry 复用、历史结构化 todos、当前回合活动裁剪和二次确认的总体方向成立；阻塞集中在来源分类、遗漏入口、事件重放与生命周期承诺。以下条目均是待修订意见，不是已经完成的修复。

### 16.2 对上一轮结论的校准

| 上一轮意见 | double check 后 | 校准说明 |
| --- | --- | --- |
| ALS 兼容槽污染后续显式 @，Important | 保留，QP-I1 | 顺序执行即可触发，不依赖并发；此前 XM-P6 只避免误清另一调用，未避免本次值残留。 |
| 取消失败收敛与既有 registry 不符，Important | 保留，QP-I2 | 是计划承诺与既有严格停止语义冲突，不是新发现的 registry 生产缺陷；若保留既有语义，先订正承诺，不必强行增加终态。 |
| 客户端时间代替权威锚点时间，Important | **降为 Minor，QP-M1** | 差异成立，但只影响无锚终态的降级筛选；常规 UUID 精确命中与活跃项不依赖此比较。没有真实应用常规错挂证据，上一轮定级偏高。 |
| 工具隐藏与回收的真人验收证据不足，Important | 保留，QP-I3 | 模型自述不是 schema 证据；不是指控计划已经伪造验收，P:711 明确尚未执行。 |
| todo 数值 ID 回退，Minor | 保留，QP-M2 | 违反无锚拒绝契约，但不能把正常 UUID/runId 路径说成已证实错挂。 |
| 包 lane 聚合粒度待明确 | 归入非阻断澄清，QP-M3 | 外层派发摘要确实存在；旧规格评审已把 lane 无独立 registry 卡登记为非阻断。不能据此直接要求新增内部工具聚合。 |

**漏报补充：QP-I4、QP-I5、QP-I6 三项 Important，以及 QP-M4 一项 Minor。** 既有意见没有整项事实撤回，但有一项严重度下调、边界收窄和三项核心链路漏报；不能保留「无漏报、无夸大」的元结论。

### 16.3 Important（6 项）

#### QP-I1：ALS 路径留下陈旧 pendingSpawn，后续显式 @ 被错误收窄

- 位置：P:291–301；`dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:166–205,224–258,520–523`。
- 路径：系统技能 pre-execute 写 `pendingSpawn` → around-dispatch ALS 消费技能类型但不清槽 → 另一已存在父会话显式 @ 创建新 child → 无 ALS 的消费点读到旧技能类型。`applyKind` 不只是写标签，还安装工具 restrict 与持续 guard；例如合法的写工具会被误按 explore 只读策略拒绝。
- 验证：从当前 P 直接提取 `consumePendingSpawn` 片段执行，系统技能 child 与之后的显式 @ child 均得到 `explore`。这是计划片段探针，不是尚未实现功能的真机复现；调用链由当前源码独立核实。
- 修订要求：保留规格要求的兼容桥接，但增加调用归属并精确消费/释放本次拥有的槽；不能只比较技能名，也不能恢复并发下的无条件清槽。补成功、失败清理后跨会话 @ 不串用，以及重叠派发不误清的测试。
- 历史订正：§9 的 XM-P6 处置与 §10.1 的确认，只证明「不清另一在途值」，不证明完整槽生命周期正确；其开工支持结论在此收窄。

#### QP-I2：清理失败时的终态承诺与既有严格停止仲裁矛盾

- 位置：P:468–476,735；S:174,352；`dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:349–353,588–606,639–690`。
- 已核实行为：定向取消后，执行 error/aborted/rejection 与成功清理可以收敛 `stopped`；`cleanupOk=false` 时仍保持 `stopping`。P:476 的「stopReason 为 error/aborted 或清理失败按既有仲裁归 failed」不成立；P:471 又明确 dispose reject/timeout 必须报 `ok:false`，因此不能同时无条件承诺不永停。
- 边界：P:410–413 已覆盖晚到 activation、启动失败清理确认及不吃 abort 信号的结果观察窗，这些不是本轮新缺口。现有 registry 的固定语义与回归测试也不是应当被本任务顺手推翻的缺陷。
- 修订要求：优先保留严格 stopped，把有界收敛承诺限定到清理已获确认的路径；失败/超时保留真实告警，不伪装已停，并同步订正 S/P。若 owner 仍要求清理失败也必须终态化，则先裁定失败/未知状态与资源责任，再定义实现，不能直接在包装层手动置终态。补真实 registry 的 dispose reject/timeout 组合测试，而非只测成功清理。

#### QP-I3：工具隐藏、租约回收与失效状态的验收判据不足

- 位置：P:711–723,741；S:139–163,389–397。
- 模型回答“没有 subagent”或日志中未发生调用，都不能证明模型请求未包含该工具；P:718 的执行步骤只要求 explore，不能覆盖 test-fix。P:720 的失效截图“如可构造”也不能成为七项全部完成的隐式豁免。
- 修订要求：分别记录普通回合、explore/test-fix 执行期、下一普通回合的实际模型请求工具 schema（如 request/header 中的有效工具），模型回答仅作辅助；给出可重复的 Host 重启失效步骤，无法执行就记未完成/BLOCKED，只有明确 owner waiver 才能记替代验收。
- 不扩张严重度：P:673 已安排二次确认组件测试。补一次点击对应的取消 RPC 数量及兄弟运行不受影响的记录有价值，但“截图不能证明无双重更新”不再拆成另一个 Important，也不声称当前验收已经造假。

#### QP-I4（新增漏报）：subagent-settled 通知被当成新用户消息，打断共享锚点

- 位置：P:158,582,684；S:126,132–135。实际载荷证据在 `dsh-plugin-huaanwork/node_modules/@deepseek-ai/dsh-subagent/lib/index.js:508–539,2048–2058`：完成通知由 `createUserMessage` 创建，`source.kind='subagent-settled'`，向父 agent queue/steer。
- 路径：真实用户产生 todo → 子代理完成并通知父会话 → 父会话下一 step 继续执行。P:158 只特判 goal，其余最近 `role='user'` 均换锚，故锚点被改成通知消息 ID。实时客户端没有追加相同 ID 的用户条目（`huaanwork-guardrails/bridge.ts:192–197` 只转述 goal 用户消息），后续 todo 会被精确 ID 守卫拒绝，新运行卡也失去原用户落点。
- 历史侧同样存在接缝：`huaanwork-host/session-view.ts:203–217` 只排除 plugin/tool，完成通知仍被映射成 user；P:582 又仅用 goalRound 排除续轮，因此会更新 ordinary-user ID 并使当前回合边界错误前移。真实 `detailRecords → historyItemsFromRecords` 内存夹具确认：一条真实用户消息加一条完成通知得到两条 user。
- 修订要求：在共享锚点与历史映射中统一“真实用户开启回合”和“系统通知继续原上下文”的判定，至少明确 subagent-settled 不换锚、不切成新的用户回合，并保留旧普通用户消息的 unknown 降级。同步细化 S §6 的来源语义，补完成通知后再次 todo、继续派生、历史回放与回合终态的联动用例；不能只在右栏选择器里绕过精确匹配。

#### QP-I5（新增漏报）：显式 /explore、/test-fix 入口没有租约与派生类型接线

- 位置：P:269,335；S:157。`client-huaanwork/App.tsx:2912–2921` 将显式技能作为 `session.send.skill` 发送；`huaanwork-host/sessions.ts:471–489` 经 `invokeSkillText` 把正文编进用户消息后直接 followup；`huaanwork-host/skill-invoke.ts:69–77` 是文本封装，不执行 skill 工具。
- 路径：新会话显式 `/explore` 或 `/test-fix` → 按 P 默认隐藏 subagent → 没有 `tools/pre-execute(name='skill')`，故 P:335 的 acquire 从未发生，`pendingByAgent` 也没有本次技能类型。依赖模型再调用一次 skill 不是确定的产品接线；只补附件又会漏掉 system-skill registry 分类。
- 修订要求：复用已有的 skill 发送/排队字段，把受理的系统技能身份与本次 UUID 绑定，在真实 pre-step 锚点建立后取得租约，并接通 around-dispatch 使用的技能类型来源。`turn-scheduler.ts:114` 与 `sessions.ts:1116` 已透传 skill，不应误报为缺少这个既有字段。补显式直发、排队出队、模型调用 skill 三入口的同一矩阵，并继续守住无人值守和子会话限制。
- 测试边界：`tests/huaanwork-guardrails/skills.spec.ts:192–194` 的 invokeSkill 直接模拟 pre-execute，不能证明上述显式入口可用。

#### QP-I6（新增漏报）：waiting 应答分支仍会丢弃已缓冲的首条 todo

- 位置：P:575–576；`client-huaanwork/App.tsx:938–951,2929–2988`。
- 路径：A 占用并发名额，B 发送后排队；B 的 waiting 应答尚未被客户端处理时，A 结束，B 的 queue-start 与首条 todo 已先经 WS 到达。P 新增的 holdEarlyEvent 会缓冲 todo，但 `takePendingBuffer` 在 waiting 分支只保留匹配 queueItemId 的 queue-start/queue-fail；重放开启回合时 todo 已被丢弃。
- 验证：提取当前 `takePendingBuffer` 实际函数体，以 `[queue-start(q-b), tool/start(todo_write, message-b)]` 为缓冲、waiting(q-b) 为应答执行，重放结果只有 queue-start。直接 `started:true` 分支全量重放并不能反证此路径。
- 修订要求：等待应答对账确认本次排队项已启动后，按本次 clientMessageId 保留对应 todo，并保证回合初始化后再应用；继续拒绝旧回合与其他队列项事件。补完整交错顺序、未启动/失败项丢弃、旧回合不被新发送吞掉的行为测试。
- 既有钉校准：`tests/client-huaanwork/appWiring.spec.ts:1646–1658` 只钉 queueItemId 过滤结构，不证明新 todo 会保留；不能靠源码正则存在就判该新场景通过，也不应为此删除旧隔离钉。

### 16.4 Minor（4 项）

#### QP-M1：无锚终态的时间回退来源不一致（由 Important 降级）

P:195,686 的 user.sentAt 是客户端发送、出队通知处理或自动化标签建立时刻，S:126,249–253 指定的则是 Host pre-step 起点。统一 epoch-ms 只解决单位，不解决来源；此处不是撤回 §9/§10 的单位修订。无锚路径也不必然不可达：租约取得后 anchor 可被 LRU 淘汰，goal 续轮无锚时不补造，而 P:445–450 允许无锚 system-skill run。客户端通知晚处理可能影响这类终态的时间筛选。

但精确 UUID 命中的终态与全部活跃 run 不受该比较影响，尚无常规真机误挂证据，故降为 Minor。修订应补权威起点的消费接线；若选择缺权威时间就不回退，应同步修改规格的降级承诺，而非把客户端时间冒充同一锚点。测试限定在无锚、淘汰及延迟通知组合，不泛化到所有发送。

#### QP-M2：todo 错用了仅授予旧运行卡的数值 ID 回退

P:520,569 的 `(clientMessageId ?? String(id))` 与 S:132,361 的无锚拒绝不符；S:134 的兼容特许针对运行卡。删除 todo 的数值回退，补“用户条目无锚、事件 ID 恰好等于 String(id) 仍拒绝”钉。正常新版本 UUID/runId 不碰数值 ID，因此本项是契约偏差，不作已证实生产错挂表述。

#### QP-M3：包 lane 聚合粒度需澄清，但不新增阻塞或独立运行树

`huaanwork-guardrails/bridge.ts:305–312` 与 `huaanwork-host/subagent-runs.ts:310–329,495–496` 只归因直接 child；lane 内部工具没有祖先映射，但父包自己调用 subagent 的外层活动会进入其摘要。“父包卡完全不更新”不成立，不能据此推断正文泄漏。

[原规格评审 §4.2 第 7 条](../specs/2026-11-15-three-feature-designs-review.md#42-可行性核实r1r2-落地约束均已对代码验证)（该文:129）已把 lane 不进 registry 登记为非阻断，并建议一期保留父包摘要。它不是明确的“内部工具必须聚合”裁定。建议 S:185,222,378 与 P:719 明说一期摘要粒度并加钉；沿用外层派发摘要时无需新产品裁定，只有 owner 要求内部工具聚合才追加归因范围。不得把既有非阻断项无声升级，亦不得增加独立 lane 卡。

#### QP-M4（新增漏报）：原样抽取清理 helper 与可选 ActivationRun 类型不相容

P:425 要求原样搬出 dispose helper，P:432 却仍把 result 定为可选。当前 `skills.ts:63–68` 的 childId 是 unknown、dispose 可选；`agent-invoke.ts:439–452` 的 helper 参数是完整 `SubagentActivationHandle`，该类型在 `subagents-service.ts:50–54` 要求 childId/result/dispose。仅解析出字符串 childSessionId，并不能把原 run 窄化为整个必填 handle。

在内存 TypeScript 探针中按上述类型直连，得到 TS2345（unknown childId）与 TS18048（result 可能 undefined）。最小处方也已编译验证：保留 childId 的边界解析，把运行时恒有的 result/dispose 声明为必填，清理 helper 入参收窄到实际消费的 `Pick<SubagentActivationHandle, 'dispose'>`。这是 Task 3 的类型接缝订正，不是已发生的运行崩溃；需要同批调整相关 fixture，不应靠非空断言或可选链静默跳过结果观察。

### 16.5 实际执行的验证与证据边界

| 验证 | 结果 | 能证明 / 不能证明 |
| --- | --- | --- |
| HEAD / submodule / 工作树核对 | 源码基线与上列一致；原有两份需求稿未被本轮修改 | 本轮仅编辑本文，不代表未提交需求稿已进入 HEAD。 |
| 当前 P 的 consumePendingSpawn 片段探针 | 系统技能 child=`explore`；随后无 ALS 的显式 @ child 也=`explore` | 证明槽生命周期问题；不是完整应用验收。 |
| 真实 registry 取消组合探针 | error+清理失败、completed+清理超时均为 stopping；error/aborted/缺结果+清理成功均为 stopped | 证明 P 对既有仲裁的描述错误，不代表需要修改既有仲裁。 |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/subagent-runs.spec.ts` | exit 0；1 个文件、20 条测试通过 | 当前 registry 回归基线通过，不代表计划的新 system-skill 生命周期已实现。 |
| 真实 detailRecords → historyItemsFromRecords 合成消息夹具 | 一条真实用户消息加一条 subagent-settled 通知被还原成两条 user | 证明历史来源分类接缝；运行时通知结构另由已安装 rc.1 产物核对。 |
| 当前 takePendingBuffer 源码提取探针 | waiting 应答只重放 queue-start，todoPreserved=false | 证明新缓冲入口必须配套重放出口；事件交错为受控夹具。 |
| TypeScript 内存探针（工作区编译器） | 原直连接口报 TS2345/TS18048；最小窄接口方案 0 diagnostics | 未创建源码文件；不是全工程 typecheck。 |

本轮没有运行完整 check/build/typecheck、真实模型调用、Electron 或七项真人验收；没有修改产品实现、规格或实施计划，也没有提交。显式技能入口遗漏经当前 App → sessions → skill-invoke 源码核实，未冒称已做真实模型复现。

### 16.6 后续处置与历史结论适用范围

1. 开工前修订 QP-I1…QP-I6，特别是通用锚点的系统通知分类、显式技能入口和 waiting 重放；QP-M1…QP-M4 随对应任务文本一并订正。修订必须落实到文件清单、接口、测试场景与验收步骤，不能只在 Completion Criteria 补一句承诺。
2. QP-I2 优先遵守现有严格 stopped；只有要求清理失败也终态化时才需要新的 owner 裁定。QP-M3 沿用一期父包外层摘要时只需澄清，不再默认要求 owner 扩大聚合范围。
3. QP-I4 细化共享锚点来源规则、QP-I2/QP-M1 修改承诺时须同步对齐设计规格；Artifact 消费同一通用锚点，修订共享契约后应核对其消费假设，但本轮没有重审整个 Artifact 计划。
4. §10 的 around-dispatch ALS 挂点、结构化 todos 以及其余已核实处置不被整体推翻；被更新的是进度计划的完整实施就绪判决，尤其 XM-P6 的生命周期完整性和本轮新增漏项。历史 PASS 保留为审计记录，不再作为现稿可直接开工的依据。
5. 修订完成后定向复核本节条目及其联动，仍需按计划实际运行门禁与真人验收；本文档落盘只完成评审归档，不意味着上述问题已修复。

## 17. qwen4复审结论（2026-11-17，Gemini 修订稿及剩余意见校准）

### 17.1 范围与最终判决

- 对象：Gemini 按 §16 修订后的 [进度计划](2026-11-15-progress-sidebar.md)（P，826 行）与 [设计规格](../specs/2026-11-15-task-progress-sidebar-design.md)（S，408 行）。稿件指纹：P=`e69d6ada2f05b3dbf869e69d240a1abc94a9dd0e`，S=`663df9075acecef78d69ec3a2aadc37d58a88153`；以下 P/S 行号均指这两份稿件。
- 源码基线仍为 `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`，上游 pin 未变。除源码外，核查了桌面工作区安装的 rc.1 运行时产物及实际 bundle 配置。
- 过程：先对 Gemini 修订做定向复审，得到会话中的「3 Important / 1 Minor」初判；owner 随后要求逐条反证准确性。本节保存反证后的结论，替代该初判，不把事实推导与产品裁定混为一谈。

**最终判决：With fixes，0 Critical / 2 Important / 2 Minor，其中一项 Minor 仅为非阻断语义澄清。开工前必修只保留 QR-I1、QR-I2。** Gemini 的主要整改方向成立；本轮没有要求重写整份计划，也不要求为了被撤回的阻断意见新增功能。

### 17.2 §16 原意见的处置核验

| 原项 | 当前修订稿证据 | 处置结论（仅计划层面） |
| --- | --- | --- |
| QP-I1 单槽残留 | P:296–358 增加调用 token、两张归属表及精确释放 | 正常 dispatch、pre-execute 直接非 allow/抛错已覆盖；allow 后不派发的出口仍缺，收敛为 QR-I1。 |
| QP-I2 严格停止仲裁 | P:478–482,545–553；S:179,357 | 已对齐既有仲裁：清理成功且执行结束才 stopped，失败/超时保持告警与 stopping；不再要求擅改 registry。 |
| QP-I3 验收判据 | P:802–806 | 已改为实际 request/header 工具 schema、双技能/双入口、Host 重启失效及单次取消隔离；无法执行记 BLOCKED，不再依赖模型自述。 |
| QP-I4 系统通知换锚 | P:174,193,201,636,666–668；S:126–136 | 真实用户白名单与历史归属已补齐。通知是否重开已终结的逻辑回合是另一个未裁定问题，不能据此继续认定本项未修，见 QR-M1。 |
| QP-I5 显式技能入口 | P:378–403,411 | 显式直发/出队已接入 followup 前预挂载与失败回滚，核心入口缺失已修；与旧 pendingByAgent 的身份同步仍缺，见 QR-I2。 |
| QP-I6 waiting 丢 todo | P:638,655–661 | 已同时安排缓冲入口、waiting 重放出口、queue-start 优先及错锚/失败隔离的行为测试。 |
| QP-M1 客户端时钟回退 | P:754,771；S:258,367 | 已删除时间回退，缺锚终态 fail-closed，规格同步。 |
| QP-M2 todo 数字 ID 回退 | P:631–632,650 | 已删除并增加数字碰撞仍拒绝的测试。 |
| QP-M3 lane 粒度 | P:24,804；S:190,227 | 已明确仅外层包儿童自身摘要，不新增 lane 内部聚合或独立卡。 |
| QP-M4 清理类型接缝 | P:450,494,501–504 | 已改必填 result/dispose 与窄化 helper 入参；内存 TypeScript 探针通过。 |

对 §16 QP-I5 修法的补充订正：该节曾建议在 pre-step 锚点建立后取得显式租约，但安装版 `dsh-agent-loop/lib/index.js:902–919` 显示 systemPrompt.assemble 先于 agent/pre-step。Gemini 改为先 register pending、followup 前挂载，并在 followup 抛错时回滚，有真实次序依据；不能要求退回原建议或重新加入 current 锚点硬门。

### 17.3 Important（2 项，保留但限定影响范围）

#### QR-I1：预检 allow 后取消、未实际派发，兼容槽仍未清理

- 位置：P:328–358,407。计划在 pre-execute 非 allow/抛错及进入 tools/execute 时清理，但没有覆盖预检允许后由运行时直接转入最终结果的出口；释放租约时只提清 pendingByAgent，不会同时清掉 pendingSpawn 与归属队列。
- 可达性：产品 web-app bundle 的 `cordis.patch.yml:357–358` 启用 workspace-changes；安装版 `@deepseek-ai/dsh-workspace-changes/lib/index.js:1086–1093` 会在 tools/pre-execute 等待 recorder.settled，基线快照包含异步 Git/文件操作（:631–652）。用户取消可发生在等待期间；recorder 的 chain 使用自身 lifetime 并收容操作异常（:764–774），其 hook 随后仍可返回 allow。安装版 `@deepseek-ai/dsh-tools/lib/index.js:3354–3358` 检测原 signal 已取消后直接返回 post-result，不进入 tools/execute。
- 结果：本次槽仍在，后来无 ALS 的显式 @ 新 child 可消费旧 explore 类型并被错误收窄。当前计划片段与真实 prepareExecution 控制流的内存探针已复现；普通 dispatch 与直接 deny 是干净对照。
- 严重度边界：保留 Important。不是“所有 token 清理都无效”；正常派发及直接拒绝/抛错已修好。allow 后 guard 拒绝也是应覆盖的运行时出口，但普通父默认策略允许 subagent，注入 guard 的探针不算默认生产场景实机复现。
- 修订要求：为不派发的最终结果路径增加按稳定调用身份的精确、幂等清理（例如同步 tools/result 监听），同步清理两张归属表与仍属于该调用的兼容槽；不能用 FIFO 取走其他调用的槽。补等待中取消后返回 allow、allow 后 guard 拒绝、同/异父后续 @ 不受污染，以及 A 收尾不清 B 的测试。

#### QR-I2：active goal 保留的旧技能缓存优先于显式新租约

- 位置：P:334–337,342,384–410。rememberSubagentSpawn 与 execute 两处均优先 pendingByAgent；显式入口只更新 lease，active goal 正常轮间 idle 则保留旧缓存。
- 可达性：`client-huaanwork/App.tsx:3925–3997` 的普通交互输入框不会仅因该标签正在执行就禁用，仍能按 Enter 提交；scheduler 按写根/并发名额决定直发或排队，不按 goal active 拒绝，出队复用现有 live Agent。安装版 goal-round-driver 的 :108–134 会等待子运行，:249–255 的人类竞争输入只登记竞争状态或使预约失效，不保证先 pause/清缓存。上游 `goal-round-driver.spec.ts:969–983` 亦有等待子运行时优先执行人类输入的测试，本轮只核对该测试源码，未执行它。
- 精确触发条件：先前模型调用 test-fix 已留下缓存，active goal 保留它；用户显式 /explore 被同一父 agent 受理，新 lease 是 explore，而旧缓存尚未清理；模型随后直接派发、未再次调用新 skill 覆盖缓存。按计划取值仍为 test-fix，子代允许列表可错误保留写工具；反方向则误禁写。双向取值探针已确认。
- 严重度边界：保留 Important，但不是每次切换必错，也没有证据称已经写入文件或绕过通用审批/沙箱。不能把允许列表错用扩大成不受约束的系统级权限提升。
- 修订要求：显式入口同步或失效旧父缓存，统一两入口的有效技能身份；同时覆盖 pre-execute slot 和 execute 取值，不能只改一个 fallback。补 active goal 条件下两种方向、直发/排队入口的 ALS 类型、运行标签与子代工具允许列表一致性测试。

### 17.4 Minor（2 项；第一项为非阻断语义澄清）

#### QR-M1：完成通知是否重开逻辑用户回合——撤回原 Important 与强制修法

- 事实部分成立：无 active goal 的父会话先 idle、随后被 parent-delivery 的 subagent-settled 通知唤醒时，安装版 subagent 的 :2048–2058 支持 queue/steer；bridge 不转发通用 turn/start/running，App :1998–2006 已结算原用户终态，`logic/toolPanel.ts:197–207` 保持 final 单调。因此若后续 todo 继续归原 user，P:769 可将其 in_progress 叠加为 interrupted。active goal 正常中间 idle 不属于这一情景。
- 原判决过强：S:256 明确要求回合正常/历史结束后仍未完成的项显示 interrupted；规格要求保留通知归属、继续显示活跃子运行，却没有规定通知必须重开已终结的逻辑用户回合。保留 clientMessageId 与重新打开逻辑回合不是同一要求。现有 `toolPanel.spec.ts:286–294,332–333` 也钉住终态单调，没有 settlement 重开例外。
- **撤回“此处必然违反规格”的 Important 判断，并撤回“必须新增权威续执行信号”的强制处方。** 保留显示现象与语义澄清记录，不作为开工阻断；只有 owner 明确选择通知续作重开逻辑回合后，才定义相应开始/结束信号和测试。未裁定前不扩大实现范围，更不能用任意迟到 token 复活终态。

#### QR-M2：显式入口凭 pending 预挂载的守卫例外欠一句说明

S:168 仍笼统写“缺当前回合锚点即拒绝”，与同节 S:162 及 P:378–403 的显式入口预挂载次序不一致。补明：current 锚点要求适用于模型 skill 入口；显式入口须已为本次发送 register pending，在 followup 前预挂载，followup 抛错回滚。维持 Minor；不是显式入口核心接线缺失，也不应为了消除文字矛盾重新加 current 硬门。

### 17.5 验证记录、局限与当前处置边界

- Gemini 稿定向复审阶段实际运行了现有 toolPanel 33 条，以及 subagent-runs 20 条、session-view 29 条回归，共 82 条通过；它们验证基线与既有规则，不证明尚未实现的计划功能完成。随后四项反证阶段未重跑这些套件。
- 控制流探针提取了当前计划 token/消费片段与安装版 tools.prepareExecution 方法体，验证 allow 后取消、正常 dispatch 与直接 deny。最终有效对照结果依次为：`post-result / 不派发 / 后续 @ 得 explore`、`dispatch / 派发 / 无污染`、`post-result / 不派发 / 无污染`。探针初版 deny 桩遗漏必填 reason，已修为完整 deny 载荷并重跑；初版的 dispatch 输出不作为拒绝路径证据。
- 旧技能缓存/新显式 lease 的双向取值、父 idle 后通知续作的状态叠加，以及修订后的清理 helper 类型接缝均有内存探针；真实可达性另外核对 UI 准入、调度器、goal-driver、workspace-changes 与运行时终结路径，不把孤立变量赋值当作整条产品链路的证明。
- 没有运行真实模型、Electron/GUI、完整 check/build/typecheck，也没有修改产品实现、设计规格或实施计划。本次写入仅归档复审与校准，不意味着剩余意见已经修复。
- **当前开工前必修仅 QR-I1、QR-I2；QR-M1/QR-M2 不升级为阻断。** 修订后定向复核两项生命周期/身份接线及其测试即可；此前会话的「3 Important / 1 Minor」汇总结论由本节的「2 Important / 2 Minor」替代，不能继续要求按已撤回的第三项 Important 扩面实施。

---

## 18. 复核校准与修订闭环（2026-11-17，对 §17 核验与 P/S 闭环修订）

> 说明：本节记录独立复核 `§17「qwen4复审结论」` 的核验结果，以及依据复核结论对设计规格（S）与实施计划（P）完成的修订闭环。`§17` 原文完整保留作为历史复审记录；除 S、P 与本评审文档外，本轮未修改任何产品源码、测试代码或 `deepseek-harness` 子模块。

### 18.1 复核基线与专项核验

- 复核仓基线：`HEAD` = `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`，`deepseek-harness` 子模块 = `1600d8a1e140dcde43a1a0941940a0480712c011`。
- 既有相关基线单测复跑：`corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/toolPanel.spec.ts tests/huaanwork-host/subagent-runs.spec.ts tests/huaanwork-host/session-view.spec.ts` → **82/82 通过**（`33 + 20 + 29`）。
- 对 §17 的独立判定：**0 误报、0 夸大**。`QR-I1`、`QR-I2`、`QR-M1`、`QR-M2` 均经宿主/客户端真实接线核验成立；同时在实施计划与既有源码约束之间识别出 6 项需同步补齐的运行时边界与测试约束漏报。

### 18.2 §17 条目核验与 P/S 修订闭环

| 编号 | 核验判定 | 修订内容与落点 |
| --- | --- | --- |
| `QR-I1` | 成立（无误报/无夸大） | **S §7.2、§7.3 #8、§14.1；P 全局约束、Task 2（接口与 Step 4）、Completion Criteria**：`PendingSpawnSlot` 绑定执行槽 `agent` 归属与调用 token，新增 `clearExecutionSlot`；在 `skills.ts` `Context.on` 补入 `'tools/result'`，并于 `tools/result` 同步路径按执行槽/token 精确清零，同时以租约释放 `onInvalidate` 兜底（覆盖 `allow` → `post-result`/`final-result`、连续多轮 `skill → ordinary → skill` 及并行 `runGroup` 抛错），不污染顺序 `@` 或误清并发在途槽。 |
| `QR-I2` | 成立（无误报/无夸大） | **S §7.2、§14.1；P 全局约束、Task 2（Step 5）、Completion Criteria**：明确双入口路径在 `turn-anchors` 与 `system-skill-leases` 上的职责边界——显式 `/explore`、`/test-fix` 在 `followup` 前先调用 `acquireExplicit`（触发旧 `pendingByAgent` 失效清理，并注册/绑定显式租约），`followup` 抛错时精确释放本轮租约；`acquireSystemSkillLease` 仅在返回真值后才写 `pendingByAgent`。 |
| `QR-M1` | 成立（Minor 语义澄清） | **S §9；P Completion Criteria**：明确 `subagent-settled` 等非人类来源通知必须保持 `turnFinal` 单调，不重开已结案回合。 |
| `QR-M2` | 成立（Minor 规则澄清） | **S §7.2；P Completion Criteria**：显式拆分守卫语义——模型 `skill` 工具路径受 `turnAnchors.current` 约束，显式 `/explore`、`/test-fix` 路径则在 `followup` 前完成 `turnAnchors.register` 与 `acquireExplicit`，避免将显式入口的前置建锚误判为缺失守卫。 |

### 18.3 复核补充的 6 项漏报与同步修订

1. **先于租约激活的 `goal/change('active')` 与错误回滚隔离**：若 `goalPhase: 'active'` 仅存于 `leases` 内部，当 `goal/change('active')` 先于 `acquire`/`acquireExplicit` 到达（如连续跨轮）或 `followup` 抛错触发 `release` 时会丢失或误清活跃目标状态。已在 **S §7.2、§14.1** 与 **P 全局约束、Task 2 Step 5、Completion Criteria** 修订为在 `system-skill-leases.ts` 维护独立 `activeGoalSessions` 集合；`release(ctx, sessionId, { clearGoal?: boolean })` 默认不清除既有 `activeGoalSessions`，仅 `agent/error`、中止/异常 `turn/end`、`goal/change` 非活跃/`clear`、`session/disposed` 与 `releaseSessionRuntime` 传入 `{ clearGoal: true }`。
2. **`acquireSystemSkillLease` 返回 `false` 时防止遗留脏 `pendingByAgent`**：已在 **S §7.2、§14.1** 与 **P Task 2 Step 4/5、Completion Criteria** 修订为先通过 `acquireSystemSkillLease` 真值门控再写入 `pendingByAgent`，同时 `release` 在无活跃租约时仍触发 `onInvalidate` 通知以防残留。
3. **`skills.ts` `'tools/result'` 订阅与并行失败兜底**：为确保 `QR-I1` `tools/result` 清理可达且不漏并行 `runGroup` 的 `throwSchedulerFailure`，已在 **P Task 2 Step 4** 明确将 `'tools/result'` 加入 `skills.ts` `Context.on`，并配 `onInvalidate` 释放兜底与对应 6 项单测场景。
4. **Task 4 `holdEarlyEvent` 与 `appWiring.spec.ts` 源码正则钉兼容**：原计划若把 `tool/start(todo_write)` 放在 `running-turn` 守卫之后，会在 `goalIntermediate === true` 保持前端 `running === true` 期间误丢新排队回合早到的 `todo_write`；且抽取 `takeEarlyPendingEvents` 若将 `sent.waiting && sent.queueItemId !== undefined` 与 `(event.event === "session/queue-start" || event.event === "session/queue-fail") && event.queueItemId === queueItemId` 字面量移出 `takePendingBuffer`，将破坏 `tests/client-huaanwork/appWiring.spec.ts:1646-1658` 的正则断言（以及 `:1710-1711` 的 `lastPushAt > crossTabGuardAt`）。已在 **P Task 4 Step 1/3、Completion Criteria** 修正为：在 `running-turn` 守卫之前按 `incoming.clientMessageId === pending.clientMessageId` 缓冲早到 `todo_write`，保留尾部 `isGoalEvent` `pending.buffered.push(incoming)` 在 `crossTabGuard` 之后，并在 `takePendingBuffer` 中保留字面量 `sent.waiting && sent.queueItemId !== undefined` 与 `isQueueControl` 谓词传入 `takeEarlyPendingEvents`。
5. **非白名单显式 `sendToAgent` 的注册顺序防泄漏**：若 `isUnmanagedChildSession` 校验在 `turnAnchors.register` 之后执行并抛错，会在 `turnAnchors` 遗留未清理条目。已在 **P Task 1、Completion Criteria** 修正为先校验 `isUnmanagedChildSession` 再执行 `turnAnchors.register`（或 `try/catch` 回滚）。
6. **`session-view.spec.ts` 普通 `user` 记录 `.toEqual` 契约同步**：普通 `user`（`goalRound === undefined`）历史记录补带 `clientMessageId` 后，需同步更新 `tests/huaanwork-host/session-view.spec.ts:275-285` 的严格相等断言。已在 **P Task 1、Completion Criteria** 显式列出该测试更新项。

### 18.4 修订后目标文档状态（已写入磁盘）

- `docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`：410 行，`git hash-object` = `0c3a793abb67b8812b5c9546b35d723b95589337`
- `docs/superpowers/plans/2026-11-15-progress-sidebar.md`：890 行，`git hash-object` = `90f401e29e5b39bbce3f4c3063ebcb0ad19a5e60`
- `docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md`：396 行，`git hash-object` = `c292fddc486c68168292868531a868dd06874fcf`
- `docs/superpowers/plans/2026-11-15-task-result-artifacts.md`：1637 行，`git hash-object` = `bdb108f43252de1684365676215df6d22df1b815`
- 计划层面遗留状态：**0 Critical / 0 Important / 0 Minor**，可进入实施阶段。
- 验证边界声明：本轮仅完成评审复核与规格/计划/评审文档闭环修订；源码与新增单测尚未实施，`corepack yarn check`、包级 `typecheck`、`dsh-plugin-huaanwork` 构建及进度 `§14.2` / Artifact `§12.2` agent 真机走查自动化测试均未执行，待代码实施阶段逐项落地验证。

### 18.5 验收方式更新（2026-11-17：真人/人工验收 → agent 真机走查自动化测试）

- 依据用户指令，对尚未实施的两组 `2026-11-15` 规格与计划完成验收口径统一升级（`#29` 对话创建技能已合入 `master` 并由 `docs/evidence/2026-11-chat-created-skills-acceptance.md` 完成真机走查闭环，本轮保持不动；`§1–§17` 历史评审原文亦保持不动）：
  - **进度面板（`2026-11-15-task-progress-sidebar-design.md` `§14.2` / `2026-11-15-progress-sidebar.md` `Task 5`）**：取消人工真人验收，改为新增可执行脚本 `dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs`（exit `0`/`1`/`3`）及其 `verify:host` 判据单测 `dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs`，在隔离 `DSH_HOME` + `--user-data-dir` + `--remote-debugging-port` + `HUAANWORK_ACCEPTANCE_HOOKS=1` 的工作区构建 Electron 上自动覆盖七项走查断言（含 `session.v4.jsonl.zstd` 内 `request/header.tools` schema 提取、双技能双入口、包 lane 深度 2 身份链、`window.huaanworkAcceptance.restartHost()` 接力校验与单次 `subagent.cancel` RPC 隔离），截图与含密钥临时目录退避至仓库外本地备份后清理，仅提交脚本、单测与脱敏文本证据。
  - **任务结果 Artifact（`2026-11-15-task-result-artifacts-design.md` `§8.2` & `§12.2` / `2026-11-15-task-result-artifacts.md` `Task 7` & `Task 9`）**：取消人工用户验收，改为新增 `dsh-plugin-huaanwork/scripts/huaanwork-accept-task-artifacts.mjs` 及 `verify:host` 判据单测 `dsh-plugin-huaanwork/scripts/huaanwork-host-artifacts-acceptance.spec.mjs`，覆盖全屏 `/json/list` 第二 page target 检验、preview/fullscreen `iframe` 实时交互与沙箱隔离、重载/重启历史定位及三类自动化并存；同时在 `Task 7` 增设仅受 `HUAANWORK_ACCEPTANCE_HOOKS=1` 门控的 `HUAANWORK_ACCEPTANCE_SAVE_DIALOG_QUEUE_FILE` 队列接缝（生产默认完全惰性），确保保存与取消另存为在校验 `ownerSurface`/`defaultPath` 后走完真实原子写盘/取消零写入闭环而不阻塞于系统模态框。
