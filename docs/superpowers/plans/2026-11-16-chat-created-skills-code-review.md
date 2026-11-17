# 对话创建技能（`feat/chat-created-skills`）Code Review（Double-Check 校准版）

- **日期：** 2026-11-16
- **审阅目标：** 分支 `feat/chat-created-skills`
  - 共同基线：`ff29debd37d72a92f10d446eafa07867d17befd8`
  - 分支 `HEAD`：`734e124022f4ec31f7ad1694dc9fe75816a99a0e`（共 15 个提交；最终代码提交为 `1d99d015b8`，其后为 4 个证据/排查文档提交 `1f3cdbc64b`..`734e124022`）
  - 已跟踪文件变更规模：`41 files changed, 4074 insertions(+), 120 deletions(-)`；上游子模块 `deepseek-harness/` 零修改
- **对照依据：**
  - 规格文档：[2026-11-15-chat-created-skills-design.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-chat-created-skills-design.md)
  - 实施计划：[2026-11-15-chat-created-skills.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-chat-created-skills.md)
  - 验收证据：[2026-11-chat-created-skills-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-chat-created-skills-acceptance.md)
- **评审结论：** **No（需先修复后再合入 / With fixes）**

> [!WARNING]
> **工作区状态声明**：当前工作区存在未提交改动——[model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts)（修改时间 `2026-11-16 17:02:34`）与 [model.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts)（修改时间 `2026-11-16 17:02:04`）未纳入任何分支提交（早于最近一次文档提交 `734e124022` `17:20:55`），另有未提交的 [AGENTS.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/AGENTS.md) 及未跟踪的 `docs/project-memory-archive.md`、`docs/superpowers/*`。本文第四节的测试与门禁结果均是在**包含工作区未提交 `model.ts` / `model.spec.ts` 修复**的状态下实测所得；`feat/chat-created-skills` 当前 `HEAD` 本身不含该修复。

---

## 一、Double-Check 与校准说明

完成初审后，对全部结论按「**查漏报、去误报、消夸大、校行号**」四项准则做了一轮独立复核，调整如下：

| 类别 | 原审情形 / 复核对象 | 复核事实与依据 | 校准处理 |
| --- | --- | --- | --- |
| **漏报补入（Important #3）** | 初审遗漏客户端全局变更事件在自动化运行期间的路径 | [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1837-L1843) 的 `automationActiveRef.current && !isUserSessionId(eventSessionId) && !boundTab` 门控在 [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1904-L1915) 的 `skill/changed` 之前；而 `skill/changed` 载荷无 `sessionId`，会在任意后台自动化运行时被静默丢弃（同层既有 `agent/changed` 亦受同样门控拦截） | 新增为 **Important #3** |
| **漏报补入（Minor #6）** | `startSkillCreationConversation` 建新/切标签后失败脚注落点 | [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2661-L2678) 异步 `setActiveTab` 后同拍调用 `send(..., id)`，若 `session.new` 失败，[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2846) / [L2867](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2867) / [L2874](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2874) 调 `noteActive(...)` 读旧闭包 `activeTab`，把错误脚注写到切换前的旧标签上 | 补入 **Minor #6** |
| **去夸大与证据补全（Critical #1）** | 原称“真机创建流程将 100% 不可用”且未区分非思考/思考两种失败模式 | 精确核对 [model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L33) 与 [L333-L338](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L333-L338)：`isRegisteredToolName` 作用于产品默认配置的 `HuaAnWorkAdapter`（`provider: 'deepseek-official'`）；在缺少白名单的 `HEAD` 上，无正文原生调用在非思考模式退化为 `EMPTY_RESPONSE`，思考模式触发 `needsToolContinuation` 重试后退化为 `NO_ACTION`，混排正文则丢失工具调用。结合 `93421c578b`（15:53 代理抓包仍见上游返回 `skill_propose`/`cs_propose` 但进不了 `tool/call`）与 `17:02` 工作区修改时间戳，`model.ts` 为必需修复 | 收紧作用域描述为 `HuaAnWorkAdapter`（`deepseek-official`）主链路，补充两种具体失败模式及提交时间线 |
| **论据补强（Important #1）** | `sessions.ts:285` 缺对称 `agentNlAllowed` | 不仅 `skillDraft` 在场发 `/create-skill 创建一个智能体...` 会误触 Step ⑥ 互斥；当 `agentDraft` 在场而无 `skillDraft` 时发该输入，还会导致 [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L316-L332) 将 `currentKind` 错判为 `'技能'`、误调 `skillHost?.describeDraft`（回落成字面量“技能草稿”）并发向 `'agent/notice'` | 补充双向失配场景至 **Important #1** |
| **严重度校准（拆出 Minor #1）** | 原将纯空白 `whenToUse` / `description.trim()` 与 `§12.1`/`§12.2` 缺口合并列为 Important | 经核对代码，`whenToUse: "   "` 仅在模型显式传入纯空白字符串时引发确认卡显示空白「触发场景」行而 `SKILL.md` 省略该键，不涉及权限、状态损坏或写盘失败，独立归类为 **Minor** 更符合严重度分级；`§12.1` 明文缺测与 `§12.2` 未真人验收保留为 **Important #4** | 拆出 **Minor #1**，消除严重度混同与夸大 |
| **不准确表述修正（Minor #3 & 行号）** | ① 原称 `commitSkillCreation().card` “在工具与宿主门面中均未被读取”；② 初审 Strengths 误写 `chatTabs.ts#L351-373` | ① [skill-creation-drafts.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation-drafts.spec.ts#L254) 已直接断言 `committed.card`，真正未消费 `.card` 的是生产调用方（`skill-creation-tools.ts`）；② [chatTabs.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/chatTabs.ts#L24-L46) 全文 159 行，`isPlainConversationTab` / `pickPlainConversationTab` 位于 `L24-L46` | 均已按源码实况纠正 |

---

## 二、架构亮点（Strengths）

- **平行轻状态机与写盘单一事实源：** [skill-creation-drafts.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-creation-drafts.ts#L227-L359) 独立维护 `{profileDir}/skill-creation-drafts/{sessionId}.json`（原子写、读取损坏抛 `CorruptSkillCreationDraftError` fail-closed）；`commitSkillCreation` 按规格 §7 固定门禁顺序校验后仅委托 [skills-host.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts#L440-L477) 的 `createSkillFromDraft` -> `createSkillLocked` 在 `withSkillStorageLock` 内落盘，无第二套 `SKILL.md` 写入实现，也避免非重入锁死锁。
- **幂等键生命周期受控：** [skill-local-state.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-local-state.ts#L167-L176) 显式解析并强制 `creationDraftId` 与 `creationSessionId` 成对出现；`createSkillFromDraft` 加锁前拒空/空白 ID，并在命中凭证时复核目录真实存在防 phantom 成功。`updateSkill`（[skills-host.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts#L543-L552)）与 `uploadLocalSkill`（[skill-catalog-upload.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-upload.ts#L88-L96) / [L136-L147](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-upload.ts#L136-L147)）保留双键；`duplicateLocalSkill`（[skill-duplicate.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-duplicate.ts#L78-L81)）、导入、下载与普通创建均不继承或伪造双键。
- **按会话挂载、纵深权限与延迟解绑：** [skill-creation-tools.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skill-creation-tools.ts#L119-L231) 仅暴露 4 个提案字段与 `draftId`；[policy.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts#L20-L27) 与 [skill-creation.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-creation.ts#L115-L126) 配合 `refreshAgentRestrict` 完成会话级可见性与执行前门禁；`skill_commit` 经 `pendingDetach` + `huaanworkOnToolResult`（[index.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/index.ts#L363-L365)）在工具结果定稿后解绑，失败与 `alreadyCommitted` 重放均不误解绑。
- **客户端卡片隔离与重放去重：** [SkillConfirmCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillConfirmCard.tsx#L14-L48) 与 [SkillSuccessCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillSuccessCard.tsx#L11-L24) 分别走普通对话 `"确认"` / `"取消"` 与显式点击跳转；`startSkillCreationConversation`（[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2655-L2678)）重置历史/任务视图并经 [chatTabs.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/chatTabs.ts#L24-L46) 避开项目绑定与 `pendingPick` 标签；`upsertSkillSuccess`（[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4662-L4669)）按 `draftId` 幂等去重。

---

## 三、问题清单（Issues）

### Critical（必须修复 / Must Fix）

1. **分支 `HEAD`（`734e124022`）未提交 `isRegisteredToolName` 对 `skill_propose` / `skill_commit` 的放行，导致主适配器链路下工具调用被静默丢弃**
   - **位置：** [model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L60-L78), [model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L114-L167), [model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L194-L207), [model.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts#L333-L338), [model.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts), [2026-11-chat-created-skills-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-chat-created-skills-acceptance.md#L3-L15)
   - **问题描述：** 产品预设主模型适配器 `HuaAnWorkAdapter`（`PROVIDER = "deepseek-official"`，由 [profile.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/profile.ts#L1619) 与 [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L553) 配置使用）在 `readModelStream` 遇到原生工具调用时置位 `sawNativeToolCall` 并抑制文本流，随后由 `hasToolCall` 与 `finishModelStream` 调用 `isRegisteredToolName` 过滤 SSE 与文本协议工具调用。在干净 `HEAD`（`734e124022`）上，`isRegisteredToolName` 只放行至 `agent_http` 与 `mcp__*`，不含 `skill_propose` / `skill_commit`：无正文无思考时 `emitText` 报 `EMPTY_RESPONSE`（`L632-L644`），带思考无正文时触发 `needsToolContinuation` 重试并可能死于 `NO_ACTION`（`L307-L329`），混排正文则静默丢失工具调用。
   - **证据与工作区状态：** 工作区 `model.ts` 与 `model.spec.ts` 中已存在修复代码及单测（mtime `17:02`），早于文档提交 `734e124022`（`17:20`），但**未提交进分支**；此前提交 `93421c578b`（`15:53`）记录代理抓包显示 DeepSeek 返回 `skill_propose`（乃至改名 `cs_propose`）却无法进入 `tool/call` 均符合这一缺失行为，而现行证据文档 §0/§2/§4.1 仍记最终代码提交为 `1d99d015b8`，与实际可跑通的工作区构建不一致。
   - **修复方式：** 将工作区 `model.ts` 与 `model.spec.ts` 改动正式提交到 `feat/chat-created-skills`，并同步更新 [2026-11-chat-created-skills-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-chat-created-skills-acceptance.md) 中的最终代码提交号、提交链与根因说明。

### Important（应当修复 / Should Fix）

1. **`sessions.ts` 缺少对称的 `agentNlAllowed` 守卫：`/create-skill` 正文命中智能体自然语言时双向互斥判定失真**
   - **位置：** [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L284-L290), [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L315-L333)
   - **问题描述：** 提交 `1d99d015b8` 为技能分支增加了 `skillNlAllowed = nlAllowed && !createAgentEntry && agentSlash === null`（避免 `/create-agent 创建一个技能...` 被劫持），但第 285 行 `detectedAgentIntent = nlAllowed ? detectAgentCreationIntent(text) : undefined` 未加对称的 `!createSkillEntry && skillSlash === null`。当输入 `/create-skill 创建一个智能体...`（或客户端拆包 `{ skill: 'create-skill', text: '创建一个智能体...' }`）时，步骤 ① 清空了 `skillName`，导致 `requestedAgent` 与 `requestedSkill` 同时为 `true`：
     - 若会话已有 `skillDraft`，`L315` 的 `(requestedAgent && skillDraft)` 误触发，以“请先完成或取消当前的技能创建”拒绝用户续建自己的技能草稿；
     - 若会话已有 `agentDraft` 且无 `skillDraft`，`L315` 的 `(requestedSkill && agentDraft)` 命中后，第 316 行 `currentKind = requestedAgent ? '技能' : '智能体'` 会错写成 `'技能'`，第 322 行误调 `skillHost?.describeDraft`（回落成字面量 `'技能草稿'`），并向 `'agent/notice'` 发错文案。
   - **修复方式：** 增加 `const agentNlAllowed = nlAllowed && !createSkillEntry && skillSlash === null` 后再计算 `detectedAgentIntent`，并在 [agent-package-creation.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts) 补充 `skillDraft` 与 `agentDraft` 两种场景的对称回归测试。

2. **`sessions.ts` Step ⑤ `skillDraft` 未受 `nlAllowed` 约束：损坏智能体草稿与技能草稿共存时误拒普通 `/name` 与 `@agent`**
   - **位置：** [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L308-L312)
   - **问题描述：** Step ⑤ 条件为 `if ((requestedSkill || skillDraft) && hasAgentCreationDraftOnDisk(routeCtx.profileDir, sessionId) && !agentDraft)`。当 `skillDraft === true` 且磁盘存在损坏智能体草稿时，用户发送显式 `/weekly-report` 或 `@legacy-agent`（此时 `nlAllowed === false`、`requestedSkill === false`）仍会命中 `skillDraft` 并被拦截拒绝，与 Step ④（[L297-L298](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L297-L298)）和 Step ⑧（[L353](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L353)）以及规格 §7 第 5 步的非创建轮豁免语义不一致。
   - **修复方式：** 将第 308 行收窄为 `(requestedSkill || (nlAllowed && skillDraft)) && hasAgentCreationDraftOnDisk(routeCtx.profileDir, sessionId) && !agentDraft`，并补充 `/name` 与 `@agent` 豁免回归用例。

3. **自动化运行期间，[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1843) 的事件闸门会静默丢弃无 `sessionId` 的 `skill/changed` 事件**
   - **位置：** [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1837-L1843), [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1904-L1915), [rpc-types.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts#L593), [skill-creation-tools.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skill-creation-tools.ts#L188)
   - **问题描述：** `skill/changed` 载荷为 `{ event: "skill/changed", name, origin }`，不含 `sessionId`。当任意自动化运行处于激活期（[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1731) 置位 `automationActiveRef.current = true`）时，`eventSessionId` 为 `undefined`，`isUserSessionId(undefined)` 返回 `false`（[L244](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L244)），`boundTabFor(undefined)` 返回 `undefined`（[L1520](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1520)），`L1843` 直接 `return`。[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1879) 有意把所有技能事件统一放在 `L1843` 之后，因此用户此时在普通会话创建技能虽能收到带 `sessionId` 的 `skill/success` 成功卡，但全局 `skill/changed` 被吞掉（与既有的 `agent/changed` 在 `L1867` 受同样影响）。
   - **实际影响：** 若此时 `SkillsView` 尚未挂载，后续用户点击「前往我的技能」重新挂载 [SkillsView.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx#L99-L104) 仍会自拉 `skill.mineList`；但停留在 `view === "main"` 时 `/` 补全目录 `slashCatalog` 不刷新，且若已有监听 `refreshSignal` 的 `SkillsView` 视图也收不到变更信号。
   - **修复方式：** 将全局目录变更事件 `skill/changed`（及同类的 `agent/changed`）移到 `L1843` 会话级自动化泄漏门之前，并在 [appWiring.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts) 增加与 `sidecar/status` 同款的顺序契约测试（参照 `appWiring.spec.ts:609-619`）。

4. **规格 `§12.1` 明文自动化断言缺口与 `§12.2` 人类验收尚未执行**
   - **位置：** [skill-duplicate.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skill-duplicate.spec.ts#L1-L71), [skill-creation-drafts.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation-drafts.spec.ts#L149-L163), [skills-host.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts#L488-L494), [agent-package-creation.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts#L980-L1230), [2026-11-chat-created-skills-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-chat-created-skills-acceptance.md#L12-L15)
   - **问题描述：**
     1. **§12.1 自动化缺项：**
        - `§12.1#8`：“另存/复制的新技能不继承 `creationDraftId`”在 [skill-duplicate.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skill-duplicate.spec.ts#L25-L44)（全仓唯一调用 `duplicateLocalSkill` 的测试）中未写入带 `creationDraftId`/`creationSessionId` 的源技能状态，实际未测；
        - `§12.1#2`：未直接测试 `whenToUse` 含 `\r` / `\n` 的拒绝（[skills-host.spec.ts:488-494](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts#L488-L494) 仅测 `description` 多行），`proposeSkillCreation` 侧未直接断言保留名（`create-skill`/`explore`）与预算（1024 字符 / 64 KiB），也未在集成单测里核对确认卡字段与最终落盘 `SKILL.md` 的 parsed frontmatter 一致；
        - [sessions.ts:323-329](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L323-L329) Step ⑥ 捕获 `CorruptSkillCreationDraftError` / `CorruptAgentPackageDraftError` 的分支在 `agent-package-creation.spec.ts` 中尚未覆盖。
     2. **§12.2 真人验收待执行：** 证据文档已如实说明目前仅有 agent 辅助 CDP 走查，计划 `Completion Criteria` 要求的 owner 真人五项验收及仓库根 `corepack yarn check`（在提交 `model.ts` 修复后的终树上）尚待完成并回填。
   - **修复方式：** 补齐上述 4 类 §12.1 缺口单测；提交代码修复后，由 owner 按 §12.2 执行真人验收并重跑仓库根 `corepack yarn check`。

### Minor（建议改进 / Nice to Have）

1. **纯空白 `whenToUse` 导致确认卡与落盘 frontmatter 轻微不一致，且草稿/Host 路径未对 `description` 做 `.trim()`：**
   - 规格 §6.2 要求“`description` 与可选 `whenToUse` 必须是去除首尾空白后的单行文本”。目前 [skill-creation-drafts.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-creation-drafts.ts#L144-L150) 与 [skills-host.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts#L236-L253) 未拒绝纯空白 `whenToUse`（如 `"   "`）也未在提案/写盘前 `.trim()`；当模型传入 `whenToUse: "   "` 时，[SkillConfirmCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillConfirmCard.tsx#L18) 因 `"   "` 为真值渲染空白的「触发场景」行，而 [skills-host.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts#L390-L391) 落盘时经 `input.whenToUse?.trim()` 将其丢弃，`description` 也未同步 `.trim()`（与表单端 [SkillsView.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx#L565-L566) 略有差异）。建议在 `parseProposal` 或 `validateSkillFields`/`createSkillLocked` 按 `trimmed || undefined` 统一归一化。
2. **草稿原子写临时文件名未加随机后缀：** [skill-creation-drafts.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-creation-drafts.ts#L210-L221) 使用固定 `${target}.tmp` 配合异步 `fs.writeFile`/`fs.rename`，同会话若并发调用 `proposeSkillCreation` 存在临时文件互相覆盖或 `ENOENT` 风险（可参照 [skill-center.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-center.ts#L124) 使用 `${target}.tmp-${process.pid}-${randomBytes(...)}`）。
3. **`contentPreviewOf` 重复实现且 `commitSkillCreation().card` 未在生产路径消费：** [skill-creation-drafts.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-creation-drafts.ts#L264-L266) 与 [skill-creation-tools.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skill-creation-tools.ts#L85-L87) 存在完全相同的 500 字符截断函数；`commitSkillCreation` 构造并返回的 `card` 目前仅在单测 [skill-creation-drafts.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation-drafts.spec.ts#L254) 中断言，生产路径并未读取。
4. **Step ⑥ 损坏草稿提示未直接给出对应 `cancel` 命令：** [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L323-L329) 已分别捕获 `CorruptSkillCreationDraftError` 与 `CorruptAgentPackageDraftError`，但提示统一写成“请用对应流程的 cancel 入口”，不如 Step ⑤（`L309`）明确给出 `/create-skill cancel` 或 `/create-agent cancel`。
5. **`beginAgentPackageUpdate` 底层未独立拦截技能草稿：** [drafts.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts#L468-L483) 在路由层已被 `sessions.ts:362` 的 `!skillDraft` 挡住，但底层 `beginAgentPackageUpdate` 未像 `proposeAgentPackage`/`commitAgentPackage` 那样主动检查 `hasSkillCreationDraftOnDisk`。
6. **`startSkillCreationConversation` 建新/切标签后若 `session.new` 失败，脚注会落在切换前的旧标签：** [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2661-L2678) 调用 `setActiveTab(id)` 后同步进入 `send(SKILL_CREATION_COMMAND, id)`，此时 `send` 内 `chatTabs` 与 `activeTab` 仍为上一帧闭包；若 `session.new` 失败，[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2867)（以及 `L2846`/`L2874`）调用 `noteActive(...)`（内部读取 `activeTab`），会把失败提示写到切换前的旧标签而非目标 `chatId`（建议改为 `noteTab(chatId, ...)`）。
7. **其他客户端与会话低风险边角：**
   - `upsertSkillSuccess`（[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4662-L4669)）使用 `...event` 展开入参，运行期收到完整事件对象时会把多余的 `event`、`sessionId` 属性写入 `ChatItem`；
   - [SkillsView.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx#L313-L315) 的“对话创建技能”按钮在 `sidecarDead` 时未禁用，点击会切换并可能新建空白标签后在 `send`（[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2819)）静默返回；
   - [SkillConfirmCard.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillConfirmCard.tsx#L34-L45) 按钮点击后无锁存/禁用态，回看历史卡片再点“确认创建”会把 `"确认"` 当普通消息发给模型；
   - [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L355) 对原始文本 `/create-skill <内容>` 未用 `initialText` 剥离斜杠前缀（仅在单测中被断言）；
   - [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L770-L806) `session.remove` 不清理草稿文件（与智能体 `.drafts` 既有行为一致）；若删除的是稳定通道会话，遗留草稿会在重建同 `sessionId` 会话时重新激活；
   - [styles.css](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/styles.css#L1692-L1780) 中 `.skill-confirm-card` / `.skill-success-card` 重复了 `.agent-confirm-card` 样式规则，后续可合并共用类。

---

## 四、实测验证记录（含工作区未提交 `model.ts` 修复）

> [!NOTE]
> 以下两次运行均执行于 `HEAD 734e124022` **叠加工作区未提交 `model.ts` 与 `model.spec.ts`** 的状态；仓库根 `corepack yarn check` 本轮未执行（且应在提交所有代码修复后以干净工作树复跑）。

1. **聚焦测试套件（23 个相关 spec 文件）：**
   - 命令：`corepack yarn workspace dsh-plugin-huaanwork vitest run ...`（覆盖 `creation-utterances`、`skill-creation*`、`skills*`、`model`、`skill-local-state`、`skill-catalog-*`、`skill-duplicate`、`skill-center`、`agent-package-*`、`agent-tool-wiring`、`sessions`、`skill-confirm-card`、`skill-success-card`、`skillsLogic`、`skillsView`、`appWiring`、`chatTabs`、`toolPanel`）
   - 结果：**`Test Files 23 passed (23)`，`Tests 567 passed (567)`**，退出码 `0`。
2. **桌面包完整门禁：**
   - 命令：`corepack yarn workspace dsh-plugin-huaanwork check`
   - 结果：退出码 **`0`**：
     - `build`（`tsdown` + Vite client/native-ui + `.d.ts`）通过；
     - `typecheck`（5 份 `tsconfig*.json`）通过；
     - `vitest run`：**`Test Files 299 passed | 4 skipped (303)`，`Tests 4209 passed | 15 skipped (4224)`**；
       - 整文件跳过 4 项为既有平台/实时环境门控：`tests/windows-console-host.spec.ts`（2 skipped）、`tests/host-liveness-win.spec.ts`（1 skipped）、`tests/huaanwork-migration-smoke.spec.ts`（1 skipped）、`tests/huaanwork-host/market-smoke-live.spec.ts`（2 skipped），其余跳过为平台条件用例（如 `shell-environment.spec.ts` 1 skipped 等）；
     - `verify:closure`：`316 first-party nodes form a closed reachable runtime graph.`；
     - `verify:bundled`：`134 files checked; 10 bundled packages are inlined; tar is compiled into lib`（`pass 11, fail 0`）；
     - `verify:cli`、`verify:loader`、`verify:profile`（`minimal preset, plugin manager, and disabled hmr lock passed`）、`verify:aa` 全部通过；
     - `verify:host`：`pass 35, fail 0`；
     - `verify:licenses`：`637 packages checked (10 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)`；
     - `verify:operations`：`7 operations and 18 fault contracts verified.`。

---

## 五、合入前修改建议与准入结论（Recommendations & Assessment）

1. **优先修复并入库（Critical + Important #1–#3）：**
   - 提交工作区中的 `model.ts` 与 `model.spec.ts` 修复，并更新 [2026-11-chat-created-skills-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-chat-created-skills-acceptance.md) 的代码基线与排查说明；
   - 修补 [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts) 两处路由守卫对称性问题（`agentNlAllowed` 与 Step ⑤ 的 `nlAllowed && skillDraft`）；
   - 将 [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx) 的 `skill/changed`（建议顺带同治 `agent/changed`）移出 `automationActiveRef.current` 会话门控之外并补契约单测。
2. **补齐规范性与测试覆盖（Important #4 + Minor 精选）：**
   - 补齐 `§12.1` 4 项缺口单测（`duplicateLocalSkill` 不继承 `creationDraftId`、`whenToUse` 换行拒绝、`proposeSkillCreation` 约束及确认卡与落盘 `SKILL.md` frontmatter 一致、`sessions.ts:323-329` 捕获损坏草稿）；
   - 统一 `whenToUse` 空串/纯空白与 `description.trim()` 口径，修复 `send()` 失败脚注使用 `noteTab(chatId, ...)`；
   - 确认以上提交全部落库后，在干净分支树执行仓库根 `corepack yarn check`，并由 owner 真人完成规格 `§12.2` 五项人类验收回填证据。

**Ready to merge?** **No（需先修复后再合入 / With fixes）**

分支的创建状态机、幂等写盘、跨流程互斥与 UI 分流整体结构扎实且有大量回归钉保护；但 `HEAD`（`734e124022`）缺少已写在工作区中的 `model.ts` 工具放行补丁，且存在 `sessions.ts` 两处路由对称性缺陷、`App.tsx` 自动化运行期间丢弃 `skill/changed`、部分 `§12.1` 明文测例缺失及 `§12.2` 真人验收未闭环等问题，需按上述清单收口并复跑根门禁后再合入。

---

## 六、独立复核与修复记录（Qoder 复核，2026-11-16）

> 本段为对上文 Gemini 评审的独立反证复核与后续修复记录，按「先反证、校准严重度、再修复」顺序执行；修复均 TDD（先红后绿）。

### 6.1 复核判决

**评审结论基本真实准确，同意「No / With fixes」。** 逐条对照源码反证、复跑测试、独立扫描 `ff29debd37..734e124022` 全量 41 文件 diff：

- **Critical #1 属实，Critical 恰当**：HEAD 白名单确缺 `skill_propose`/`skill_commit`（静态 `KNOWN_TOOL_NAMES` 亦不含）；三种失败模式在 `model.ts` 代码层面推演成立；适配器为产品唯一默认链路（`deepseek-official`）。时间戳吻合（model.ts 17:02:34 / HEAD 17:20:55）。关键反证：走查观察到 `tool/call` 与批准框 ⇒ 构建必然含放行补丁 ⇒ 证据文档 §4.2「同一构建/产品代码与分支提交一致」确与可跑通的工作区构建不一致。
- **Important #1 属实且触发输入现实**：智能体 NL 检测器前缀匹配「创建/新建/建 (一个) 智能体|数字员工|助手」，`/create-skill 创建一个助手技能` 即双触发；客户端确将斜杠命令拆包为 `{skill, text}`。
- **Important #2 属实**：与 ④/⑧ 及规格 §7 第 5 步豁免语义不一致。补充背景：先前计划评审「条件与 R8 一致，不收窄」针对**普通聊天**场景，本项指**显式调用轮**，不推翻旧裁定；收窄写法保留普通聊天行为。
- **Important #3 机制属实，严重度偏高，校准为 Minor**：漏写两个缓解因素——① 新技能默认禁用，创建时 slashCatalog 刷新本就不增内容；② 启用/禁用经 `onInvocableChanged` 独立刷新。真实影响仅「commit 时已挂载的 SkillsView 错过一次自动刷新」（切视图重挂载自愈）。修复建议正确，照修。
- **Important #4 属实**：四类缺口与 §12.2 待验收均核实。一处措辞不精确：「全仓唯一调用 duplicateLocalSkill 的测试」——`routes.spec.ts:1349` 亦经 HTTP 路由 exercising 同一函数（但同样未播种双键，缺口结论不受影响）。
- **Minor #1–#7 全部属实，严重度恰当**；Strengths 抽查属实。
- **实测记录可信**：复跑桌面包完整 vitest 得 `299 passed | 4 skipped (303)` / `4209 passed | 15 skipped (4224)`，与 §4 逐项一致。
- **漏报扫描**：未发现新的实质问题。考虑并排除的候选：确认卡「确认」发往 activeTab（点卡必在该标签）、SkillsView initialTab 只取初值（真实流程重挂载）、门面 LRU 256 淘汰（有界设计）、双模块草稿路径耦合（有注释与测试钉）。

### 6.2 修复提交（基线 ff29debd37 之后，TDD）

| 提交 | 处置 |
| --- | --- |
| `9545c218cd` | Critical #1：白名单放行 + 回归钉入库 |
| `cc0afed6c8` | Important #1/#2 + Minor #4/#7d：agentNlAllowed、Step ⑤ 非创建轮豁免、损坏提示点名 cancel、斜杠前缀剥离（8 个新回归钉） |
| `3733a2168d` | Important #3（降 Minor）：skill/changed 与 agent/changed 移出自动化闸门 + 顺序契约钉 |
| `10b1304ff3` | Minor #1/#2/#3/#5：字段归一化（卡↔盘一致）、随机 tmp 后缀（并发钉）、contentPreviewOf 去重 + commit 未消费卡移除（截断钉移至 propose 路径）、beginUpdate 低层互斥 |
| `0654f565dc` | Minor #6/#7a/#7b：noteTab(chatId) 脚注、成功卡字段投影、入口 sidecarDead 禁用 |
| `90dfe0a944` | Important #4：§12.1 缺口补齐（propose 保留名/预算、whenToUse 换行、卡↔frontmatter、损坏 catch 双分支、另存不继承双键） |
| `3b41400ba4` | 归一化写法满足 exactOptionalPropertyTypes（根门禁 typecheck 捕获后修正） |

### 6.3 停放项（具名移交 owner，与智能体先例一致或需视觉核对）

- **Minor #7c**（确认卡无锁存）：成功后点旧卡发 stray「确认」；有更新草稿时点旧卡实际确认最新草稿。更正：智能体确认卡没有按钮（同意句须手打），技能卡按钮是规格 §9 要求，不存在「与智能体先例一致」。是否给旧卡加已消费标记属 owner。
- **Minor #7e**（session.remove 不清草稿）：与智能体 `.drafts` 既有行为一致；统一清理策略属 owner。
- **Minor #7f**（样式重复）：涉及 styles.generated.ts 再生成与视觉核对，留待 UI 加固波。

### 6.4 门禁与验收状态

- 修复后仓库根 `corepack yarn check` 退出码 **0**：桌面包 `4231 passed / 15 skipped (4246)`（较评审时 +22 新钉），`verify:host` 35/0，closure/bundled/licenses/operations 全过，最后一个 workspace agent-catalog-admin 15/15。首轮退出码 2（typecheck 捕获 `exactOptionalPropertyTypes` 违规），修正提交 `3b41400ba4` 后复跑通过。完整日志 `/tmp/hw-root-check-20261116-r2.log`，证据文档 §1 已回填。
- 证据文档基线与根因已更正（§4.2：白名单缺失确为确定性丢弃路径，走查构建含未提交修复）。
- **§12.2 五项真人验收仍待 owner**；本波不替代。合入前还需 owner 裁定未跟踪规格/计划/评审文档是否随分支提交。

---

## 七、Kimi 审核（2026-11-16，终树 Double-Check）

> **审核人：Kimi。** 本节是对当前终树的独立审查与二次反证记录，覆盖前文的当前合并判断；前六节保留为历史评审及修复上下文。复核遵循「查漏报、去误报、消夸大、校行号」，并另由只读 subagent 对下列两项 Important、一项 Minor 和验收口径逐项反证，结论一致。

### 7.1 评审对象、依据与方法

- **分支 / 基线 / HEAD：** `feat/chat-created-skills`；共同基线与当前 `master` 均为 `ff29debd37d72a92f10d446eafa07867d17befd8`；评审 HEAD 为 `dab30cd66722eef21c665c5e9cad99475f35b418`。
- **权威依据：** `docs/superpowers/specs/2026-11-15-chat-created-skills-design.md` 与 `docs/superpowers/plans/2026-11-15-chat-created-skills.md`；验收证据仅作待核验材料，不以自述替代源码和实测。
- **方法：** 当前源码逐路径反证、临时 profile / 内存附件最小复现、当前 HEAD 根门禁复跑、真机证据抽查、独立只读反证。除本节落档外，不修改实现、测试、计划或验收证据。
- **终树结论：** **0 Critical / 2 Important / 1 Minor，No（With fixes）**。两项 Important 均为真实规格违背，但均有明确触发条件；不得扩大成“所有创建都会自动启用”或“可直接绕过同意门禁正式写盘”。

### 7.2 Double-Check 校准表

| 结论 | 复核事实与缓解条件 | 校准判决 |
| --- | --- | --- |
| 残留同名启用键使对话新建技能自动启用 | 源码与两条实测路径均成立；正常 `removeSkill` 会清键，触发条件是正常的带外删除或异常残留，而非每次新建。`alreadyCommitted` 重放不改变内容/状态的既定语义不是反证 | **属实，Important 合理**；首次创建直接获得可调用能力，违反 R4、§8.1 与 §12.1#7；非 Critical |
| 崩溃后的首个 `alreadyCommitted` 重放不解绑 | 重启产生新的空 `pendingDetach`；磁盘草稿驱动重新 attach，而 `!result.alreadyCommitted` 守卫排除重放解绑。计划的“不设置第二个 pendingDetach”及现有测试只覆盖同进程已有首次 pending 的情形，不覆盖新进程首个重放 | **属实，Important**；是终止生命周期缺口，不是首次主链路不可用 |
| `session.remove` 后创建附件残留 | `releaseSessionRuntime` 无 detach，`removeSession` 只清草稿；`src` 中未见其他 `sessionAgentTools` 会话清理路径。直接调用释放函数后两个技能工具仍 attached，同 ID 重建可继承 | **属实，与上项合记一个 Important**；但 commit 仍有 consent / creationTurn / draft / credential 门禁，不能夸大为“可无条件正式创建” |
| 取消后旧确认卡仍可点击 | `consumeSkillConfirmCards` 仅由新 confirm / success 调用，取消 notice 只写脚注；未见其他消费路径 | **属实，Minor**；后果是 stray 普通消息和误导性 UI，不会仅凭旧卡直接写盘 |
| 计划“真人验收”与规格 agent 走查裁定冲突 | 规格 §12.2:259 已记录 owner 2026-11-16 允许 agent 真机走查；计划 :29、:1313、:1344 仍是旧“人类/真人”口径 | **属实，非代码阻断**；以更新后的 owner 裁定为准时不应再声称“缺真人验收所以必须 No”，但计划应同步 |

### 7.3 当前问题与修改建议

#### Kimi-I-1（Important）：首次对话创建必须清除同名残留启用态，重放不得撤销后续手动启用

- **位置：** `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts:375-429`、`:448-485`；实际调用闸门为 `skill-invoke.ts` 的 `resolveInvocableSkill`。
- **根因：** `createSkillLocked` 在 :393 读取既有 toggles，并在 :423 直接以同名键计算新技能的 `enabled`；对话首次创建没有消除“目录已不存在但启用键仍在”的历史状态。
- **已复现：** ① 表单创建并启用 `daily-summary`；② 带外删除其目录；③ 正常对话 propose + 后续确认 commit 同名技能。结果为 `enabledAfterConversationCreate=true`；另一条最小复现同时确认 `resolveInvocableSkill` 立即成功。
- **修改建议：** 只在**首次非凭证命中创建**的存储锁临界区内，于正式技能文件可见之前清除同名残留启用键，保证崩溃窗口也 fail-closed；凭证命中 / `alreadyCommitted` 重放不得重写 toggles，以免撤销用户创建后的手动启用。不要为修此问题嵌套获取非重入 `withSkillStorageLock`。
- **回归测试：** 覆盖“旧技能启用 → 带外删目录 → 对话同名新建”，断言 `mineList.enabled=false`、toggle 键不存在、`/name` 拒绝；再手动启用并重放原 draftId，断言仍启用、内容不被重写且返回 `alreadyCommitted`。

#### Kimi-I-2（Important）：创建工具附件在崩溃重放与删除会话两条终止路径未完整释放

- **位置：** `huaanwork-guardrails/skill-creation-tools.ts:186-219`、`huaanwork-host/skill-creation-drafts.ts:293-350`、`huaanwork-host/skill-creation.ts:175-179`、`huaanwork-host/sessions.ts:354-362`、`:740-760`、`:790-810`。
- **路径 A——崩溃后重放：** 正式技能和幂等状态已写入但草稿未删时进程退出；重启后 pending map 为空，磁盘草稿使路由重新 attach，凭证命中返回 `alreadyCommitted=true`，而 :187 跳过本次解绑。空 pending 注册实例的实测结果为 `proposeStillAttached=true`、`commitStillAttached=true`，即使对应 tools/result 已到达。
- **路径 B——删除会话：** `session.remove` 已清两类草稿，但运行态释放只清模型/根等状态，未卸创建附件。直接实测释放后两个技能工具仍 attached；同 `sessionId` 重建可继承。
- **影响边界：** 残留工具会继续暴露，`skill_propose` 低层又没有 `creationTurn` 检查，普通轮可因此写新草稿；但正式 commit 仍有完整授权门禁，因此本项不定 Critical，也不声称可无条件正式落盘。
- **修改建议：** 重放时只在同会话已有在途首次成功 detach 的情况下跳过“第二个”登记；若没有，则当前重放必须拥有自己的结果后解绑。会话删除路径同时清理技能与智能体创建附件，保持与草稿终止语义一致，并避免在工具结果定稿前破坏仍在归一化的调用。
- **回归测试：** 分别模拟新进程空 pending 的首个重放、同进程首次成功与重放结果乱序、删除/重建同 sessionId；断言终态无技能/智能体创建附件，且正常在途结果不会被提前改写成 `UNKNOWN_TOOL`。

#### Kimi-M-1（Minor）：取消成功未消费活动确认卡

- **位置：** `client-huaanwork/App.tsx:1895-1917`；卡片禁用渲染位于 `SkillConfirmCard.tsx:35-48`。
- **问题：** 新确认卡和成功卡会消费旧卡，取消成功 notice 不会。草稿已经删除后，旧卡三个按钮仍可点击并发送普通“确认/取消”等文本。
- **修改建议：** 让取消成功携带明确的结构化终态信号，并在同标签消费活动确认卡；不要把所有错误/一般 notice 都当成已处理，也不建议依赖易漂移的文案模糊匹配。补“取消后按钮禁用、点击不再发送”的回归。

### 7.4 实测与证据边界

1. **当前 HEAD 根门禁实测：** `corepack yarn check` 退出码 **0**；桌面包 `299 passed | 4 skipped (303)`，`4236 passed / 15 skipped (4251)`；`verify:host` 35/0，closure 316 节点，bundled / cli / loader / profile / aa / licenses / operations 均通过。门禁绿不能覆盖上述未测状态与生命周期边界。
2. **最小复现：** 两项 Important 及删除附件残留均用临时目录或内存对象实际执行并观察输出；未在仓库新增复现脚本，未改产品代码。
3. **真机证据：** `/tmp/hw-skill-walk-final/evidence/` 当前存在，抽查确认卡、成功卡、“我的技能”和禁用调用截图与记录相符；本次未重新运行真实模型走查。历史 `/tmp/hw-skill-walk3/evidence/` 当前已不存在，且证据均为本机 `/tmp` 引用，长期审计建议持久归档关键截图/日志。此项不改变代码缺陷分级。
4. **范围与清洁度：** `deepseek-harness` 无差异；落档前工作区干净。本节由 owner 明确要求追加，不代表已执行任何修复或 git 提交。

### 7.5 合并结论与收口条件

**Kimi 审核结论：当前仍不达合并 `master` 标准（No / With fixes），但不是测试失败或主流程普遍不可用，而是两个有边界的授权/生命周期缺口尚未闭环。**

合入前必须：

1. 修复 Kimi-I-1 与 Kimi-I-2，并落入 §7.3 所列回归；保留现有正常重放、用户后续手动启用和工具结果定稿语义。
2. 在包含修复的干净终树复跑 `corepack yarn check`，保持退出码 0。
3. 同步计划与规格的验收口径；以 owner 2026-11-16 裁定为准时，不再把“真人未验收”列为额外阻断。

Kimi-M-1 可随修复波一并处理或由 owner 明确停放；停放不改变上述两项 Important 必须闭环的准入条件。
