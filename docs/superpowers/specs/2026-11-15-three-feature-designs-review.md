# 三项功能设计评审：对话创建技能 / 任务结果 Artifact / 右侧进度面板

- 日期：2026-11-15
- 评审方：Qoder 独立评审（主 agent，现状断言逐条对代码核实）
- 评审对象：
  - `docs/superpowers/specs/2026-11-15-chat-created-skills-design.md`（下称「技能文档」）
  - `docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md`（下称「Artifact 文档」）
  - `docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`（下称「进度文档」）
- 基线：外层仓库 `ff29debd37`（PR #28 合并提交，已核实）；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`0.2.1-rc.1`，`git submodule status` 已核实）
- 状态：**评审完成，owner 裁定已记录（§4），处置待执行（§5）**
- 方法：设计质量与现状描述准确性分开评分；20+ 处现状断言抽样对代码核实；严重度双向校准（误报/夸大与漏报/低估都找）；owner 裁定选项的可行性做独立反证后再记录

## 1. 总体判决

**三份设计总体质量高，可以作为实施计划的基础，但不能原样开工。**

- 严重（Critical）：0
- 重要（Important）：3（其中 1 项已由 owner 裁定，见 §4；2 项待处置/待裁定）
- 小问题（Minor）：5

方案方向全部正确：技能文档复用智能体创建的授权骨架与技能中心的正式写盘；Artifact 文档采用宿主持久化 + 按需读正文；进度文档采用现有事实源的只读聚合投影。三者的方案取舍表（排除项及理由）经核实均成立。现状断言基本准确，仅 2 处与代码不符（Minor 1、Minor 5）。三份文档的独立性声明一致，基线声明准确。

历史教训吸收良好：结果定稿后解绑（`agent_commit` UNKNOWN_TOOL 教训）、损坏 fail-closed、不按相似度猜锚点、不虚构单步百分比、不建第二套状态机，均已写入约束。

## 2. 逐份评价

### 2.1 技能文档：完整、准确，方案最优

复用边界全部属实：

- `createSkill` 已支持 `whenToUse`、`source=user`、`origin={kind:'created'}`、默认禁用（`skills-host.ts:360-394`，enabled 由 toggles 推导，新技能不在 toggles 即禁用）；
- 同意/取消句规范化（`drafts.ts:65-66,137-142`：可以/确认/同意/就这样/按这个建；取消/先不要）、草稿 tmp+rename 原子写（`drafts.ts:870-874`）、内部技能注入（`creation.ts:86-97`，`skills/create-agent/SKILL.md` 带 `disable-model-invocation: true`）均有现成先例；
- `INTERNAL_BUNDLED_SKILLS`（`huaanwork-guardrails/skills.ts:676`）与客户端 `RESERVED_SKILL_NAMES`（`logic/skillsLogic.ts:97`）是保留名的两个落点，文档 R6 与模块表均覆盖；
- 「技能页借用 `agent/changed` 刷新」属实：`App.tsx:3664` 把 `agentChangeSignal` 传给 `SkillsView.refreshSignal`；全仓无 `skill/changed` 事件，R5 确有必要；
- 成功文案「已保存技能 <name>，请在"我的技能"中启用」与现值一致（`SkillsView.tsx:470`）；
- `whenToUse` 是 skill-format 的受管 frontmatter 键（`packages/huaanwork-skill-format/src/markdown.ts:16`），提案字段可无损映射。

唯一实质缺口：与智能体创建草稿的同会话共存未定义（Important 3）。

### 2.2 Artifact 文档：方向正确，自动化适配一节没写完

现状断言全部属实：

- 两份固定附件「结果.md / 结果.html」（`logic/runResultAttachments.ts:2`），仅整段 JSON 助手结果触发折叠；
- Markdown 预览只显示源码（`App.tsx:4000-4001` 用 `<pre>`）；HTML 禁脚本（`App.tsx:4003-4008` `sandbox=""`）；无全屏；下载走 Blob + `will-download` 接管两个固定名、落下载目录同名覆盖（`App.tsx:3073-3084`、`electron-shell-generation.ts:346-355`、`logic/attachmentDownload.ts:10-12`）。

方案取舍核实：上游 `ui-sidebar-documentpreview` 拖着 exceljs/pdfjs/fortune-sheet/xlsx 且深度耦合上游客户端服务（api-gateway、client-resources、ui-sidebar-right 等 inject），排除理由成立。宿主持久化对历史恢复、原始字节下载、全屏安全统一是最小正确解。

缺口集中在自动化适配（Important 2）与 5 个 Minor（全部在本文档）。

### 2.3 进度文档：一期方案最优，需求覆盖有一处需裁定（已裁定）

现状断言全部属实：

- 右侧「进度」是空占位（`App.tsx:4018-4022`）；
- 实时 `todo_write` → `upsertTodoItem`（`App.tsx:4359-4361,4587`）；历史 `historyItemsFromRecords` 无 todo 还原（`logic/sessionChannel.ts:117-201`，todo_write 在历史中是工具卡）——R6 的历史投影统一确有必要，且**顺带关闭 AGENTS.md 登记的 R-12 债**（实时/历史 todo 呈现差异），实施时应同步订正债务表；
- 九相（`logic/subagentRuns.ts:351-361`：starting/reasoning/generating/tool/finalizing/stopping/completed/stopped/failed）、六态（`logic/toolPanel.ts:42`：running/done/failed/interrupted/unconfirmed/resultMissing）、共享 1 秒 tick（`App.tsx:2220`）、`subagent.list` 快照对账（`App.tsx:2396,2439`）、定向取消（`App.tsx:2469`）均与文档一致。

需求 3 的覆盖缺口（Important 1）已由 owner 裁定，见 §4。

## 3. 发现清单

### Important

#### I-1 进度页对「模型自主派生子 agent」的覆盖缺口（已裁定，见 §4）

- 事实：`subagent` 工具在模型可见 allowlist（`huaanwork-guardrails/present-as.ts:26`）且 profile 启用（`profile.ts:1631`）；护栏代码显式处理「模型自主创建的嵌套子代理」分支（`skills.ts:160,231,251`：不绑运行卡、不继承模型/根）。模型拆解复杂任务时可直接用该工具委派，此时进度页只有工具行、无子 agent 执行详情。
- 校准：文档三将其列为显式非目标并给出理由，是诚实的延后而非隐瞒缺陷；但原始需求 3 未区分受管/自主，覆盖取舍必须由 owner 显式裁定。
- 处置：owner 裁定选项 2 + 系统技能条件可见并纳管（§4 R1/R2）。

#### I-2 Artifact 文档 §6.2 自动化适配协议未定义（待处置）

四个必须在定计划前澄清的点：

1. **封套生产者未定义**：结构化结果封套（title/format/content）由谁产生——模型运行中的 `result_present` 调用？运行终态 JSON？脚本 stdout？三类自动化（模型会话、脚本）各走哪条路未写明。
2. **与运行中 `result_present` 的关系未定义**：若模型在自动化运行中已调用 `result_present`，运行结束时的「宿主适配」会不会二次生成？需要显式跳过/合并规则。
3. **`resultRevision` 无定义**：§5.3 的自动化幂等键 `automationId + runId + resultRevision` 中，`resultRevision` 全文未定义来源与语义。
4. **32 KiB 截断与 5 MiB 预算冲突（代码事实）**：脚本输出在 `runScript` resolve 时已被 `clipOutput` 截到 32 KiB（`automations-host.ts:540`、`automations-store.ts:498-502`），`finishAutomation` 入库的 summary 再截一次（`automations-host.ts:614`）。「运行结束时由宿主适配」拿到的不是全文，5 MiB 单 Artifact 预算对自动化形同虚设。适配点必须前移（截断前采集）或另设封套采集通道；模型会话侧同理需确认 collector 文本的完整性。

#### I-3 技能文档未定义两种创建草稿同会话共存（待裁定）

- 复现路径：用户先发起智能体创建（草稿 A 在场），再输入 `/create-skill`（技能草稿 B 建立）。现有路由中智能体创建接管条件是「有智能体草稿且本轮无 /name、无 @」（`sessions.ts:208-209`）；用户下一轮回复「同意」时，智能体流程抢先接管并 `commitAgentPackage`——**同意句打错对象，写盘的是智能体而不是技能**。
- 校准：需要不常见的操作序列，但属同意门禁打错实体，与智能体流程「同意必须命中本轮创建上下文」的设计意图直接冲突；技能文档 §7/§11 只约束技能草稿自身，未覆盖跨流程。
- 建议（待 owner 裁定）：**互斥、fail-closed 拒绝**——发起第二种创建流程时若另一种草稿在场，拒绝并提示「请先完成或取消当前的智能体/技能创建」。不擅自取消对方草稿（取消是用户语义）。备选：优先级规则（后发起者接管并显式挂起前者），但挂起态引入额外状态，不推荐。

### Minor

#### M-1 Artifact 文档 §5.2 引用的「既定『对应回合末尾』回退规则」不存在

现有锚定先例只有两条（`logic/subagentRuns.ts:296-313` `insertSubagentRunCard`）：实时按 `clientMessageId` 精确命中用户条目；快照对账（`allowSnapshotFallback`）回退到本 tab 最后一条用户消息。`sessionChannel.ts`/`runTabsLogic.ts` 均无「对应回合末尾」规则。历史 Artifact 锚点规则需要在计划中重新定义（文档「不得按正文相似度猜测」的约束保留），并订正「既定」措辞。

#### M-2 Artifact 级联清理只写了会话删除

单条运行记录删除（`automations-store.ts:668`，规格 §9.2，以 Run 为锚点清理）与自动化删除（`routes.ts:1456` `automation.remove`）均已存在。自动化运行锚定的 Artifact 必须在这两条删除路径上同步清理，否则留下孤儿正文。会话删除侧（`sessions.ts:617-653` `removeSession`）也需新增 artifacts 目录清理接线。

#### M-3 全屏窗口「加载应用内部 Artifact 路由」机制未定

客户端没有 URL 路由（单页 view 状态切换，全仓无 router；`URLSearchParams` 仅用于 API query 拼接）。全屏窗口加载渲染器的方式——独立页面/构建入口、还是启动参数让 App 只渲染 Artifact 视图——需要计划裁定。主窗口经 webserver URL 加载（`electron-shell-generation.ts:687-688`），新窗口走同一 origin 可行；安全参数清单（§8.1）本身无误。

#### M-4 Artifact 文档模块表漏了工具 allowlist 与包儿童会话边界

- `result_present` 必须加入 `present-as.ts` 的 `ALLOWED_TOOLS`，否则被 restrict 遮掉（机制：`restrictInternal` 按 `ALLOWED_TOOLS ∪ 会话附件` 过滤 schemas，`present-as.ts:125-149`）。模块表只列了新工具文件与路由，漏了该接线点。
- 包儿童会话的工具集是 `pkg.allow ∩ schemas`（`skills.ts:346-350`），`result_present` 默认不在其中⇒包回合默认不能产出 Artifact。建议规格显式写明「包儿童会话不产出 Artifact，由父会话统一呈现」；若要开放，须另裁（涉及 C4/C5 血缘收窄与 Artifact 归属）。

#### M-5 「上游自包含 Markdown primitive」措辞偏乐观

上游 `ui-primitives/src/markdown/` 是 19 个文件的 mdast/micromark 管线（parse.ts 依赖 mdast-util-from-markdown/gfm/math、micromark-extension-gfm/math），带 katex CSS 与 CSS modules，另有增量流式解析器。「自包含」仅指不依赖上游宿主服务，不是轻量单文件。复用可行，但计划必须裁定依赖引入方式（npm 包 `@deepseek-ai/dsh-client-ui-primitives` vs 源码引用）与客户端构建兼容（CSS modules、katex 资源）；否则按文档 §7.2 的兜底自写适配层。

## 4. Owner 裁定与可行性核实

### 4.1 裁定记录

| 编号 | 裁定 | 日期 |
| --- | --- | --- |
| R1 | I-1 采选项 2：**在父会话对模型隐藏 `subagent` 工具，只留宿主服务给包 lane 用**，使「所有子 agent 都受管」。 | 2026-11-15 |
| R2 | R1 落地时，`explore` / `test-fix` 两个系统技能采**条件可见 + 纳管**：父会话平时不可见 `subagent`；本轮命中 explore/test-fix 时经现有附件机制临时挂载，技能派生的子运行绑进 run registry——进度页可见、可定向取消。 | 2026-11-15 |

### 4.2 可行性核实（R1/R2 落地约束，均已对代码验证）

1. **服务与工具面分离，@ 派发不受影响**：`ctx.subagents` 服务由 `subagent` 核心包提供（`deepseek-harness/packages/subagent/subagent/src/index.ts` 服务定义），`tool-subagent` 只是模型面（inject `['tools','subagents','systemPrompt','sessionProjections']`）。`@agent`/`@slug` 走宿主侧 `startActivation`（`agent-invoke.ts:352,393`、`agent-package/host.ts:573-578`），不依赖模型可见工具。
2. **不能全局从 ALLOWED_TOOLS 删除 `subagent`**：包儿童会话有效工具集 = present-as restrict（`ALLOWED_TOOLS ∪ 附件`）∩ skills.ts restrict（`pkg.allow ∩ schemas`）（上游 `tools.restrict` 多层取交集，`core/tools/src/index.ts:758-760,1105+`）；而 `composeAgentPackageToolAllowList` 把 `subagent` 放进**每个包**的基础 allow（`agent-package/runtime.ts:173-180`，注释明示孙代收窄由 C4 血缘分支负责）。包 lane 在深度 2 派发依赖它（`profile.ts:113-122` maxDepth=2 的由来；`profile.ts:1627-1631` 2026-11-13 复挂裁定）。**实现必须按会话类型排除**：父会话/普通会话隐藏，包儿童会话保留。判别信号可用 `huaanworkPackageChildAllow` 血缘表或 registry 子绑定；`refreshAgentRestrict` 已有重算流程（`skills.ts:341-344` 的附件-绑定-重算次序约束继续适用）。
3. **explore/test-fix 依赖父会话 `subagent` 工具（R2 的由来）**：两个系统技能始终启用（`SYSTEM_SKILLS`，`skills.ts:669-670`），SKILL.md 均明文「MUST call the official `subagent` tool」（`skills/explore.md:8`、`skills/test-fix.md:8`）；机制是 `skill(explore/test-fix)` → `pendingByAgent` → 模型调 `subagent` → `rememberSubagentSpawn` → 子代理 restrict（`skills.ts:166-198`）。R2 落地：命中回合经 `attachAgentTools` + `refreshAgentRestrict` 临时挂载、回合结束解绑；子运行在 **`startActivation` 包装**处创建 registry 条目（`startParent`/`startRun` ALS 按调用建作用域、await 前快照父会话，`skills.ts:396-422`），纳入进度页与定向取消。**〔2026-11-15 二轮订正〕** 本条初版误写为「start 包装处」；上游模型面 `subagent` 工具实际调用 `ctx.subagents.startActivation`（`deepseek-harness/packages/subagent/tool-subagent/src/index.ts:330`），修订稿进度规格 §5/§6.3 的挂点正确，见 §7.2。
4. **legacy 角**：legacy `@agent` 儿童 allow 来自 `filterAgentAllow(entry.allow)`（`agent-invoke.ts:367`、`packages/huaanwork-policy/src/agent-catalog.ts:57-67`），默认只读，但条目显式列 `subagent` 时仍会通过。为完全实现「全部受管」，legacy 儿童应同样排除 `subagent`（建议随 R1 同批；若 owner 认为 legacy 条目属用户显式配置可另裁豁免）。
5. **profile 行与注释同步**：`tool-subagent` 行必须保持启用（包儿童与条件可见回合仍需工具面存在）；`profile.ts:1627-1631` 的 2026-11-13 裁定注释需补注 R1/R2，避免未来上游同步误读。`skills.ts:160,231,251` 的「模型自主嵌套」注释语义随 R1/R2 变化（父会话不可达；包 lane 仍走 start 路径但受血缘管辖），同批订正。
6. **既有回归钉（实现前必查）**：
   - 包儿童 allow 含 `subagent` 的钉子必须保持绿：`agent-package-runtime.spec.ts:297,317,321,1009`、`policy.cordis.spec.ts:938-939`、`package-subagent-lineage.spec.ts:75,153,173`。
   - explore/test-fix 机制钉按 R2 改写：`skills.spec.ts:95,112`（父 fixture 含 subagent）、`:235-242`（explore 流程）、`:338`（嵌套 deny）；`present-as.cordis.spec.ts:226+`（explore mask intersection）需核对重算影响。
   - 新增钉：父会话普通回合不可见 `subagent`；explore/test-fix 回合可见且回合后解绑；其子运行进 registry、进度页可见、定向取消只停该实例；包 lane 派发不受影响（headless 探针或真实模型 smoke）。
7. **残余（登记，非阻断）**：包 lane worker（深度 2，包儿童模型经 `subagent` 派发）目前不进 registry——start 包装的血缘分支只收窄工具、不绑 run（`skills.ts:354-371`）⇒ 进度页见包运行卡的工具摘要，无独立 lane 卡。R1/R2 后不存在「不受管」的派发，但「全部受管运行都有独立运行卡」仍差这一层；如需独立 lane 卡，用进度文档 R3 预留的 `parentRunId`/`depth` 另立任务（建议一期保持包运行卡聚合，lane 独立卡后续）。

## 5. 处置状态与后续动作

| 项 | 状态 | 动作 |
| --- | --- | --- |
| I-1 | **已裁定**（R1/R2） | 进度文档修订：§2.2 非目标改写（父会话隐藏工具、系统技能条件可见+纳管、lane 独立卡延后）；§3 增补 R1/R2；§9 预留字段注明 lane 绑定后续；§12 增补工具可见性与纳管测试。实现约束以 §4.2 为准。 |
| I-2 | 待处置 | Artifact 文档 §6.2 重写自动化适配协议（封套生产者、与 result_present 的关系、resultRevision 定义、截断前采集点），定计划前完成。 |
| I-3 | 待裁定 | 技能文档 §7 增补跨流程互斥规则；推荐 fail-closed 拒绝（§3 I-3），owner 确认后写入。 |
| M-1…M-5 | 待处置 | 随 Artifact 文档修订一并落：锚点规则重定义、级联清理扩面、全屏加载机制、ALLOWED_TOOLS 与包儿童边界、Markdown 依赖决策。 |
| R-12 债 | 联动 | 进度文档 R6 实施时同步订正 AGENTS.md R-12 行（历史 todo 投影统一后关闭），并在规格写明历史主流从此显示待办卡。 |

三份规格本身的修订未在本评审中执行（评审与处置分离）；处置波次按上表推进，修订后各规格状态段同步更新。

## 6. 核实用证据索引（本次评审实际执行）

- 基线：`git log -1`（ff29debd37）、`git submodule status deepseek-harness`（1600d8a1e14…）；三份规格为未跟踪新文件。
- 技能面：`creation.ts` 全文、`drafts.ts`（同意/取消/原子写/草稿路径 `agents/.drafts`）、`sessions.ts:150-270,617-653,1066-1075`、`skills-host.ts:220-294,330-394`、`skill-local-state.ts`（严格校验）、`skills.ts:676`、`skillsLogic.ts:97`、`SkillsView.tsx`（refreshSignal/文案）、`App.tsx:1853-1863,3664`、`packages/huaanwork-skill-format/src/markdown.ts`。
- Artifact 面：`runResultAttachments.ts` 全文、`runResultRender.ts:207-211`、`attachmentDownload.ts` 全文、`App.tsx:1055-1066,3062-3084,3987-4023`、`electron-shell-generation.ts:346-355,687-688`、`automations-host.ts:395-443,535-576,591-650`、`automations-store.ts:494-502,668`、`routes.ts:644,1456`、上游 `ui-sidebar-documentpreview/package.json`、`ui-primitives/src/markdown/*`（19 文件、parse.ts 依赖）。
- 进度面：`App.tsx:1014,2220,2396,2439,2469,4359-4361,4587`、`toolPanel.ts:42,61,410`、`subagentRuns.ts:41-55,296-313,351-361`、`sessionChannel.ts:112-201`。
- R1/R2 可行性：`present-as.ts:15-43,108-199`、`profile.ts:113-122,1571,1627-1631`、`agent-package/runtime.ts:153-188`、`agent-attachments.ts` 全文、`skills.ts:110-198,228-290,296-380,669-676`、`skills/explore.md`、`skills/test-fix.md`、`agent-invoke.ts:120-199,340-404`、`agent-package/host.ts:522-578,1046-1065`、`packages/huaanwork-policy/src/agent-catalog.ts:40-67`、上游 `subagent/subagent/src/index.ts`、`tool-subagent/src/index.ts:43`、`core/tools/src/index.ts:708-760,1103-1130`；测试钉位置见 §4.2 第 6 条。

## 7. 复核记录（2026-11-15 第二轮，修订稿复核）

- 复核方：Qoder 独立复核（主 agent）
- 复核对象：三份规格的修订稿（技能 17:14 / 进度 17:30 / Artifact 17:31 版本）；修订声称为吸收本评审意见所作
- 方法：§3/§5 逐条处置核对 + 修订新增技术断言独立对代码核实 + 修订引入的新问题扫描；本节取代 §5 的状态列

### 7.1 处置核对（8 项发现全部闭环）

| 项 | 修订落点 | 复核结论 |
| --- | --- | --- |
| I-1 | 进度 R1–R5、§6 可见性矩阵/条件可见/registry 纳管/包与 legacy 边界 | **成立**。新增断言全部核实：模型面工具走 `startActivation`（上游 `tool-subagent/src/index.ts:330`）；registry kind 联合现为 `legacy\|package`（`subagent-runs.ts:68`），投影方法 noteReasoning/noteToken/startTool/endTool/childIdle/noteChildError/failRun 均在；无人值守白名单不含 skill/subagent（`automations-store.ts:53-63` + sanitize）；`huaanworkPackageChildSessions/ChildAllow` holder 存在（`holders.ts:48,84`）；startActivation 包装按调用建 ALS 作用域、await 前快照父会话（`skills.ts:396-422`）；lane 血缘分支只收窄不绑 run（`skills.ts:493-514`），R5 延后一致 |
| I-2 | Artifact R6–R8、§6.2 终态封套适配器、§6.3 新旧折叠互斥 | **成立**。双生产路径互斥（自动化不暴露 result_present）消除双写；`executeRun` 存在（`automations-host.ts:659`），collector 文本无上限累加（`:164,178`）、在 finishAutomation 前完整可得（`:416`）；`resultRevision` 已删除，幂等键 `automationId+runId`；脚本一期不参与并写明未来采集点必须在 clipOutput 之前；artifactOutcome 先于 run-end 落运行记录，失败不改任务执行终态 |
| I-3 | 技能 R8、§7 有序路由 7 步、§11、§12.1 测试 4/5 | **成立且强于推荐**：双向互斥（智能体侧同查）、覆盖自然语言与 update、异常双草稿禁止隐式提交/取消、显式入口规范化先于继续创建判断。同意句精确化（§9 发 `确认` 而非按钮标题「确认创建」）正确——后者不在 CONSENT_PHRASES，会被门禁拒绝。**R8 按评审推荐写入，owner 追认后生效（§7.4）** |
| M-1 | Artifact §5.2 历史定位规则 1–4 | **成立**。明言「本协议新增规则，不引用不存在的既定回退」；回合末尾插入、运行脚注前、未定位分组、对账不改挂，规则完整 |
| M-2 | Artifact §9 五路径级联表 | **成立**。五个删除原语全部存在：`removeAutomation:397`、`removeAutomationsOfProject:432`、`pruneAutomationSessions:596`、`deleteAutomationRun:685`、`sessionRemove`（sessions.ts:617）；接共享原语而非路由 handler，清理失败诚实报告 |
| M-3 | Artifact R10、§8.1 启动参数 + 访问头 | **成立**。同源 webserver URL + `artifactWindow=1&artifactId` 启动参数、无 router；renderer access header 机制存在（`electron-shell-generation.ts:78,250`、`electron-runtime.ts:329-332`），新窗口显式覆盖的要求有据 |
| M-4 | Artifact R9、§5.1 附件挂载、§10 跨规格协调行 | **成立且优于原建议**：改走会话附件而非全局 ALLOWED_TOOLS，自动化/包儿童天然排除、不突破血缘收窄；包儿童不产出 Artifact 写入非目标；§10 明示不重复进度规格的 subagent 改造 |
| M-5 | Artifact §7.2 依赖策略 + 兜底子集渲染器 | **成立**。客户端确为 Vite 构建（`vite.client.config.ts`）；上游 markdown 管线确含 Shiki（`highlight.ts:21-26`）与 KaTeX；「只走正式包公开导出、不相对路径引源码」边界清楚 |

技能规格另两处新增加固亦经核实：R9 幂等键生命周期对应的 read-modify-write 路径真实存在且按显式字段列表重建条目（`updateSkill` skills-host.ts:443-450；上传带外采纳与发布回写 skill-catalog-upload.ts:85-96,123-141），不显式保留即丢键；R10 单行约束的理据成立（serializeSkillMarkdown 原样写值，多行会破坏 frontmatter 结构）。进度规格 R8 历史 todo 统一与 R-12 债联动、坏 args 安全 note、迟到 todo fail-closed、goal 续轮不提前解挂，均与现有机制兼容（tool/start 带可选 roundKey，rpc-types.ts:529；historyToChatItems 存在，App.tsx:3211）。

### 7.2 对本评审初版的订正（审计轨迹）

1. **挂点订正**：§4.2 第 3 条初版写「子运行在 start 包装处创建 registry 条目」有误。上游模型面 `subagent` 工具调用的是 `ctx.subagents.startActivation`（`tool-subagent/src/index.ts:330`），不是 `start`；修订稿进度规格 §5「系统技能纳管挂在 startActivation 包装，不误挂到仅处理 start 的分支」正确。§4.2 第 3 条已就地订正。初版关于 lane 不绑 run 的结论不受影响（startActivation 的血缘分支同样只收窄不绑 run）。
2. **漏报认领**：初版未发现 `result_present` 的完整 content 会经普通工具卡参数展示重新铺进会话（与「正文不进消息状态」目标冲突）。修订稿 Artifact §1 第 1 条、§6.1 第 5/6 项、§12.1 测试 3 已覆盖（实时/历史均不进 ToolPanel、失败只显示紧凑摘要）。此为修订方新增的正确加固。

### 7.3 复核新发现（2 项 Minor，不阻断计划）

1. **进度规格约束行与模块表不一致**：头部约束「只改 `dsh-plugin-huaanwork/`」，但 §11 模块表列了 `packages/huaanwork-policy/src/agent-catalog.ts`（自有共享包，在目录之外）。二选一订正：约束行改为「及必要的自有共享包」（与另两份规格同形），或把 legacy allow 的 subagent 过滤放在 `agent-invoke.ts` 内完成、不动共享包。计划开工前顺手修。
2. **自动化封套提示契约的注入点未定**（Artifact §6.2 规则 1）：现状自动化 prompt 只有 `<automation-fire>` 信封 + 上次产出前缀 + 用户 prompt（`automations-host.ts:365-368`），没有任何输出格式指引；「整段最终输出只含一个封套 JSON」的契约靠什么到达模型，规格未写明。计划必须定义注入点（如 automation-fire 信封内追加指引段或自动化会话 system prompt section）。不阻断：无标记 JSON 走兼容路径，行为与现状一致；但若不定注入点，新封套协议永远不会被模型使用。

### 7.4 裁定追认状态

- 进度 R1/R2：owner 已裁定（2026-11-15，选项 2 + 条件可见并纳管），修订稿忠实落地。
- 技能 R8：按本评审 I-3 推荐（fail-closed 拒绝）写入「已确认的产品裁定」，owner 尚未显式追认；用户已指示「按评审意见修订」，**随本轮复核结论一并追认即闭环**。R9/R10 属设计加固，无需产品裁定。
- Artifact R6–R10：设计层裁定，与 owner 选项 2 无冲突（R9 的附件挂载与进度规格共用同一机制、互不覆盖）。

### 7.5 复核判决

**三份修订稿可以进入实施计划阶段。** 0 Critical / 0 Important / 2 Minor（§7.3，计划开工前顺手修）+ 1 追认项（§7.4 R8）。初版 8 项发现全部闭环，修订新增断言经独立核实无误，且修订方纠正了初版评审的 1 处挂点错误、补上了 1 处漏报。三份规格独立性保持；建议实施顺序：技能（面最小、骨架最熟）→ 进度（护栏 + registry + 前端）→ Artifact（新协议 + 存储 + 原生接线，面最大）；三者亦可分 worktree 并行，App.tsx 为共同修改面，合并时注意。