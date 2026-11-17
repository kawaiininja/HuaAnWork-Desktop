# 通过对话创建技能设计规格

- 日期：2026-11-15
- 状态：设计已确认；已吸收独立评审、复核意见及实施计划复核修订（2026-11-15）；实施计划已制定，尚未实施
- 基线：外层仓库 `ff29debd37d72a92f10d446eafa07867d17befd8`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`0.2.1-rc.1`）
- 范围：HuaAnWork 高级模式中的对话创建技能、技能草稿、用户确认、正式落盘及“技能中心 → 我的技能”刷新
- 约束：只改 `dsh-plugin-huaanwork/` 及必要的自有共享包；不修改 `deepseek-harness/`

## 1. 背景与结论

“通过对话创建智能体”已经提供入口识别、内部访谈技能、按会话挂载创建工具、草稿、结构化确认卡、同意门禁和原子落盘。技能中心已经具备本地技能创建、读取、启停、状态记录和“我的技能”列表。

因此，本需求应复用智能体创建流程的**交互与授权骨架**，复用技能中心的**正式写盘能力**，而不是复制智能体包的运行时、脚本、HTTP/MCP、发布签名或子代理调度。

当前缺口有两项：

1. 没有 `create-skill` 内部访谈流程和对应草稿/工具。
2. 技能路由没有独立的变更推送事件；现有技能页主要在自身操作后重拉，并复用 `agent/changed` 的刷新信号。

## 2. 目标与非目标

### 2.1 目标

1. 用户可从“我的技能”发起“对话创建技能”，也可在会话中显式输入 `/create-skill`。
2. 模型通过逐项访谈生成技能名称、描述、触发场景和正文，不要求用户手写 Markdown。
3. 正式写入前必须出现结构化确认卡，并得到用户在后续回合的明确同意。
4. 新技能只生成一个合法的 `SKILL.md`，不配置外部接口或运行时。
5. 创建成功后，新技能立即进入“技能中心 → 我的技能”，来源为“创建”，默认未启用。
6. 取消、校验失败或重复提交不得产生重复或半公开的技能。
7. 技能中心的既有表单创建、导入、下载、上传和启停行为保持不变。

### 2.2 非目标

- 一期不支持通过该流程更新或覆盖已有技能。
- 不生成脚本、资源目录、HTTP/MCP 端点、智能体 persona 或子代理配置。
- 不在创建成功后自动启用、自动上传或自动发布技能。
- 不抽象一个同时重写智能体与技能创建流程的通用向导引擎。
- 不让确认按钮绕过模型工具直接写正式文件。
- 不改变技能被调用后的现有工具权限和策略边界。

## 3. 已确认的产品裁定

| 编号 | 裁定 |
| --- | --- |
| R1 | 采用独立的轻量技能创建状态机，复用智能体流程的授权骨架，不重构智能体流程 |
| R2 | 一期只支持新建；更新已有技能仍走技能中心现有编辑能力 |
| R3 | 正式创建必须调用技能中心同一套校验、锁和状态写入逻辑 |
| R4 | 新技能默认禁用，但必须立即出现在“我的技能” |
| R5 | 新增独立 `skill/changed` 事件，不继续借用 `agent/changed` 表示技能变更 |
| R6 | 访谈内部技能名为 `create-skill`，不显示在技能中心，并加入保留名 |
| R7 | 创建产物仅为 `SKILL.md`；创建工具不接受 URL、路径、脚本或端点参数 |
| R8 | 智能体与技能创建流程在同一会话中双向互斥；发现另一类活动草稿时 fail-closed 拒绝，不自动取消或覆盖对方 |
| R9 | `creationDraftId` 是创建幂等键，`creationSessionId` 是配套归属键，后续编辑和上传必须保留二者；另存/复制产生的新技能不得继承这两个键 |
| R10 | `description` 与 `whenToUse` 只接受单行文本，避免 frontmatter 落盘后字段意义改变 |

## 4. 方案取舍

| 方案 | 优点 | 主要缺陷 | 结论 |
| --- | --- | --- | --- |
| A. 轻量平行流程，复用原语与技能正式写盘 | 改造边界清晰；不扰动智能体运行链；授权语义完整 | 需要新增少量同形状态机与确认卡 | **采用** |
| B. 抽象通用“对话创建资源”引擎并改写两类流程 | 长期可减少同形代码 | 一期回归面大；智能体与技能的冲突域、权限和确认字段不同 | 本期排除 |
| C. 模型生成正文后由前端直接调用 `skill.create` | 链路短 | 缺少草稿授权、本轮门禁和幂等；把模型输出直接变成写盘授权 | 排除 |

## 5. 现有复用边界

| 能力 | 现有位置 | 本需求用法 |
| --- | --- | --- |
| 创建入口与内部技能注入 | `huaanwork-host/agent-package/creation.ts` 的 `detectCreateAgentCommand`、`injectCreateAgentSkill` | 参照其结构实现技能版，不改智能体入口正则 |
| 按会话挂卸工具 | `agent-attachments.ts`、`present-as.ts` | 只挂 `skill_propose`、`skill_commit`，结果定稿后解绑 |
| 同意/取消句规范化 | `agent-package/drafts.ts` | 抽取共享纯函数或引入同义共享 helper；不得复制出不同语义 |
| 草稿原子写 | `agent-package/drafts.ts` | 复用 tmp+rename 模式，草稿放到独立根目录 |
| 正式创建 | `skills-host.ts` 的 `createSkill`、`validateSkillFields`、`withSkillStorageLock` | 作为唯一正式写盘路径 |
| 格式与预算 | `packages/huaanwork-skill-format` | 复用名称、frontmatter、正文和摘要约束 |
| 我的技能 | `client-huaanwork/SkillsView.tsx`、`skill.mineList` | 创建后通过变更事件刷新 |

智能体包的 `dispatch`、子代理 activation、包发布锁、HTTP/MCP 进程、签名与撤销均不进入本设计。

## 6. 对话与数据协议

### 6.1 内部访谈技能

新增 `dsh-plugin-huaanwork/skills/create-skill/SKILL.md`，其 frontmatter 与 `create-agent` 一样属于内部技能，不参与技能中心展示或启停。

访谈顺序固定为：

1. 用途与典型输入。
2. 名称、显示描述和触发场景。
3. 执行步骤、限制与输出形式。
4. 汇总草稿并调用 `skill_propose`。
5. 原样展示确认卡所表达的信息；明确“尚未创建”。
6. 仅在用户后续明确同意后调用 `skill_commit`。

一次只问一个必要问题；用户已提供的信息不得重复询问。模型不得承诺已创建，直到 `skill_commit` 返回成功。

### 6.2 工具

`skill_propose` 输入只允许：

```ts
type SkillProposalInput = {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
};
```

`skill_commit` 输入只允许 `draftId`。二者都不接受文件路径、URL、脚本、frontmatter 附加行、启用标记或发布参数。

`description` 与可选 `whenToUse` 必须是去除首尾空白后的单行文本，不得包含 `\r` 或 `\n`。该约束在 propose 和 commit 使用同一校验器；不能让多行内容先进入确认卡、再在序列化时变成 frontmatter 的 `extraLines`。

`skill_propose` 成功只写草稿并发出 `skill/confirm`；失败返回可供模型修正的逐字段错误，不产生正式技能。

### 6.3 草稿

建议类型：

```ts
type SkillCreationDraft = {
  schemaVersion: 1;
  draftId: string;
  sessionId: string;
  proposal: SkillProposalInput;
  createdAt: string;
  updatedAt: string;
};
```

草稿放在 `<profileDir>/skill-creation-drafts/<sessionId>.json`，不放在 `<profileDir>/skills/` 内。每个会话最多一个活动草稿；新 propose 明确替换该会话旧草稿，并使旧 `draftId` 失效。

## 7. 状态机与授权门禁

每轮发送消息时，宿主按以下顺序处理，顺序本身是授权约束：

1. 记录该会话本轮用户原句，清除“本轮已 propose”等瞬时标记。
2. 在任何“已有草稿继续创建”判断之前，先识别并规范化显式 `/create-skill`、`/create-agent`（含 update）、技能中心预置命令和 `skillName=create-skill/create-agent`。内部创建入口不得再作为普通 `/name` 参与后续分流。`/create-skill cancel` 与 `/create-agent cancel` 两个显式取消入口也在此处、互斥检查之前解析：只清理指定流程的草稿并点名被取消的对象，保留另一类草稿。
3. 识别本轮请求的流程类型 `agent | skill | none`。保守自然语言入口只在规范化后既无显式 `/name` 也无 `@agent` 时参与识别；显式命令入口不受此限制。同时读取两类活动草稿。
4. **双向互斥**：发起或继续一种流程时，若另一类草稿在场，拒绝本次入口并提示 `请先完成或取消当前的智能体/技能创建：<名称或草稿摘要>`，其中 `<...>` 取对方草稿的名称，名称不可得时取草稿正文摘要。不得注入新访谈、挂载工具、覆盖草稿或自动取消对方。该规则同样覆盖自然语言入口和智能体 update 模式。
5. 只有本轮没有显式 `/name` 或 `@agent`，且活动草稿与本轮创建类型一致时，才允许继续该流程。智能体草稿不能再接管 `/create-skill`，技能草稿也不能被智能体新建/update 静默覆盖；反之亦然。普通技能轮（显式 `/name` 或 `@agent`）即使正文以创建样说法开头，也不得被互斥检查误拒。
6. 取消只作用于当前明确选择的创建流程，并点名被取消的对象；不得因取消一个流程而留下另一个不可达草稿。若因异常或历史原因同时检测到两类草稿，禁止 propose/commit 和任何隐式取消：裸“取消”句在该态被 fail-closed 拒绝并提示须用 `/create-skill cancel` 或 `/create-agent cancel` 分别清理；清理到只剩一个草稿后，剩余的创建流程恢复正常访谈与继续创建。
7. 命中创建/继续创建后，才注入对应内部技能并挂载该流程的两个创建工具；不得同时挂载智能体与技能创建工具。

`skill_commit` 的门禁按下述顺序执行，顺序本身是授权约束：

1. `sessionId` 与已提交凭证或当前活动草稿的归属一致；
2. 本轮命中技能创建或继续创建上下文，且不存在另一类活动草稿；
3. 本轮没有重新 propose；
4. 最近一条用户原句是完整同意句，而不是包含“同意”的长文本；
5. **先按 `sessionId + draftId` 查已提交凭证**：本地状态存在同时匹配 `creationSessionId` 与该 `creationDraftId` 且技能目录仍在的技能时，直接返回 `alreadyCommitted` 与原技能摘要，不再要求活动草稿在场——正常成功重放不得被“活动 draftId”检查先挡住，其他会话也不得凭 draftId 重放；
6. 凭证未命中时，才要求 `draftId` 对应当前活动技能草稿且内容匹配，随后正式校验与名称冲突检查再次通过。

本地幂等扫描命中 `creationDraftId` 状态键时，必须同时确认对应技能目录仍存在；状态有键但目录已被带外删除时按字段错误处理并保留草稿，不得报告 phantom 成功，也不得用同名覆盖“修复”。

路由或工具调用方不得覆盖这些门禁结果。技能轮、`@agent` 轮或普通聊天轮不得借旧草稿提交。智能体流程继续执行同等的跨流程互斥检查，不能只把防护写在技能入口一侧；低层 `proposeAgentPackage`/`commitAgentPackage`/`proposeSkillCreation`/`commitSkillCreation` 与取消分支都自带对方草稿检查，不得只依赖路由单点。

## 8. 正式写入、幂等与刷新

### 8.1 正式写入

提交层只负责草稿和授权，正式写入复用技能中心的存储锁、字段校验、原子文件写和本地状态记录。不得在对话模块另写一份 `SKILL.md` 落盘实现。

新技能固定：

- `source=user`；
- `origin={ kind: "created" }`；
- `enabled=false`；
- 目录及 frontmatter 名称一致；
- 正文只含访谈确定的技能内容。

### 8.2 幂等

草稿 ID 是本次创建的幂等键，会话 ID 是配套归属键。宿主在本地技能状态中保存内部可选字段 `creationDraftId` 与 `creationSessionId`，重复提交同一会话的同一草稿返回 `alreadyCommitted` 和原技能摘要，不重复创建、不覆盖后续编辑；其他会话即使拿到 draftId 也不得重放成功。

这两个字段只能由对话提交服务写入，表单和 RPC 不接受调用方伪造。其生命周期必须满足：

- `skill-local-state` 的类型、解析和序列化显式保留 `creationDraftId` 与 `creationSessionId`，不能依赖“未知字段原样保留”；两键必须成对出现，只有其一视为损坏并 fail-closed；
- `updateSkill`、上传/发布回写、带外编辑采纳等所有 read-modify-write 路径逐项保留这两个字段；
- “另存为新技能”、导入、下载和表单普通创建不得复制或伪造这两个字段；
- 删除技能时随本地状态条目一并删除；
- 后续内容编辑或发布不改变幂等身份，旧草稿重试仍只返回 `alreadyCommitted`，不得以新内容再次创建或覆盖。

正常重试与事件重发必须幂等。若进程在正式文件写入后、幂等状态完成前崩溃，后续提交应按名称冲突失败并保留草稿，绝不能通过覆盖同名技能“修复”。幂等扫描命中 `creationDraftId` 状态键时必须确认对应技能目录仍存在；状态有键但目录已被带外删除（残留条目）时返回字段错误并保留草稿，绝不报告 phantom 成功。commit 重放命中已提交凭证时返回 `alreadyCommitted`，可重发 `skill/success` 与 `skill/changed` 补偿丢失事件；客户端按 `draftId` 去重成功卡，重放不得产生第二张成功卡或第二个目录。

### 8.3 变更事件

成功后按顺序完成：

1. 正式技能和本地状态可读；
2. 删除活动草稿；
3. 发出独立的 `skill/success` 事件，载荷含成功文案、`draftId` 与 `name`，客户端用独立的 `SkillSuccessCard` 渲染，并提供“前往我的技能”动作；`skill/notice` 只承载错误与一般提示，不再承载成功卡；
4. 发出 `skill/changed`，载荷至少包含 `name` 和 `origin`；
5. 在工具结果定稿后解绑创建工具并结束创建回合。

客户端按 `draftId` 对成功卡去重：同一 `draftId` 的 `skill/success` 重复到达只保留一张成功卡。commit 重放可重发 `skill/success` 与 `skill/changed` 以补偿丢失事件，但不得产生第二张成功卡或第二个技能目录。客户端维护独立 `skillChangeSignal`，使“我的技能”和 `/` 补全数据刷新。成功卡的“前往我的技能”只在用户点击时跳转“我的技能”，不自动打断当前会话；`skill/changed` 的刷新语义不受点击影响。

成功文案沿用现有口径：`已保存技能 <name>，请在“我的技能”中启用`。

## 9. 页面交互

“我的技能”页新增“对话创建技能”按钮，与现有“创建技能”表单入口并存。点击后打开或创建一个普通会话标签，并发送 `/create-skill` 预置命令；返回技能页时不丢失该会话。

确认卡展示名称、描述、触发场景和正文摘要，并提供：

- 确认创建：通过普通 `session.send` 发送固定同意语 `确认`（不是发送按钮标题“确认创建”），仍需经过下一轮 `skill_commit`；
- 继续修改：保留草稿并继续访谈；
- 取消：发送既有规范中的固定取消语，由宿主删除当前技能草稿并点名对象；双草稿异常态下裸取消句被拒绝，须改用对应流程的显式取消入口。

卡片上的“确认”不是写盘权限本身。创建成功后，客户端在同一会话消息流插入 `SkillSuccessCard` 成功卡，展示成功文案并提供“前往我的技能”动作；点击才跳转“我的技能”标签，不自动打断会话。即使用户停留在会话页，下一次进入“我的技能”也必须能看到新技能。

## 10. 涉及模块

| 类型 | 建议模块 |
| --- | --- |
| 新增 | `skills/create-skill/SKILL.md` |
| 新增 | `huaanwork-host/skill-creation.ts`：入口、注入和会话生命周期 |
| 新增 | `huaanwork-host/skill-creation-drafts.ts`：草稿、校验和幂等协调 |
| 新增 | `huaanwork-guardrails/skill-creation-tools.ts`：两个模型工具 |
| 修改 | `huaanwork-host/sessions.ts`：创建/继续/取消路由 |
| 最小修改 | `skills-host.ts`、`skill-local-state.ts`：内部创建幂等支持，保持表单语义不变 |
| 修改 | `skill-catalog-upload.ts` 及所有本地状态重写路径：保留 `creationDraftId`；另存/复制路径必须清除该键 |
| 修改 | `client-huaanwork/rpc-types.ts`：确认卡、成功卡、通知和变更事件 |
| 新增 | `client-huaanwork/SkillConfirmCard.tsx` |
| 新增 | `client-huaanwork/SkillSuccessCard.tsx` |
| 修改 | `App.tsx`、`SkillsView.tsx`、`logic/skillsLogic.ts`：入口、刷新和保留名 |

样式只改 `styles.css` 源文件，并按仓库命令重新生成 `styles.generated.ts`。

## 11. 异常与安全约束

- 名称、单行描述、单行 `whenToUse` 和正文必须在 propose 与 commit 两次通过同一套约束；propose 不得放行 commit 必然拒绝的内容。
- 本地名称与内部/系统保留名冲突时失败；普通内置技能的既有同名规则不得被对话入口偷偷收紧或放宽。
- 技能正文是模型指令，不是权限声明；它不能新增工具、网络或文件系统权限。
- 草稿和状态文件损坏时 fail-closed，不得当作空草稿或全空技能状态继续覆盖。
- 工具执行体内不得立即解绑当前工具；沿用结果定稿后的解绑约束。
- 一个会话最多只能有一个活动创建流程，而不是仅仅“一个技能草稿”；智能体/技能草稿的双向互斥必须先于任何继续创建和提交分支。
- 本需求不调用外部 HTTP/MCP 接口，也不生成此类配置。

## 12. 测试与验收

### 12.1 自动化测试

至少覆盖：

1. `/create-skill`、技能中心预置入口和保守自然语言入口；入口 fixture 必须是入口正则实际可命中的说法（如“帮我创建一个技能”），不得为用例放宽正则；普通“修改技能”不误判为新建。
2. propose 字段、预算、保留名、本地冲突及 description/whenToUse 换行拒绝；propose 在对方智能体草稿在场时拒绝；确认卡与最终 frontmatter 字段一致。
3. 同意句、取消句、错误 draftId、跨会话提交、非创建轮借草稿、同轮 propose+commit 均被正确处理。
4. 智能体草稿存在时 `/create-skill`、自然语言创建技能和技能中心入口均被 fail-closed 拒绝；技能草稿存在时智能体新建和 update 同样被拒绝；普通技能轮（显式 `/name`）与 `@agent` 轮即使正文以创建样说法开头且对方草稿在场，也不被互斥误拒；双方文件与工具附件均不被改写。
5. 取消只清理当前明确选择的流程并点名被取消的对象；技能草稿在场时继续修改与裸取消走技能流程，智能体草稿不被误清；异常双草稿状态下 propose、commit、裸取消三向均被 fail-closed 拒绝，`/create-skill cancel` 与 `/create-agent cancel` 分别只清理指定流程，清理到单草稿后剩余流程恢复访谈与继续创建。
6. 正常 commit 重放（草稿已删、按 `draftId` 命中已提交凭证）返回 `alreadyCommitted` 与原摘要，不被“活动 draftId”检查先挡住；状态有键但目录已被带外删除时返回字段错误并保留草稿，不报 phantom 成功。
7. 成功后 `skill.mineList` 返回 `origin=created` 且默认禁用；启用前 `/name` 不可调用，启用后按现有规则可用。
8. 重复 commit 返回同一结果，不产生第二个目录；编辑、上传/发布和带外编辑采纳后仍保留幂等身份；另存/复制的新技能不继承 `creationDraftId`。
9. 取消和校验失败零正式写入；草稿原子写与损坏 fail-closed；崩溃窗口不得通过覆盖同名技能恢复。
10. `skill/changed` 只驱动技能刷新，不再伪装为智能体变更；`skill/success` 渲染 `SkillSuccessCard`（载荷含 `draftId`），同一 `draftId` 重复到达只保留一张成功卡，“前往我的技能”点击才跳转、不自动打断会话，`skill/notice` 不出现成功卡。
11. 确认按钮通过 `session.send` 发送精确同意语 `确认`，不直接调用写入 RPC；工具结果定稿前不解绑，成功后正常解绑；commit 失败只发错误通知并抛错，不设置 pendingDetach、不解绑工具。
12. 既有技能表单、导入、下载、上传和智能体创建回归不受影响。

### 12.2 用户验收

**验收执行方式（owner 2026-11-16 裁定）**：以下五项可由 agent 以真机走查方式执行——在包含分支最新源码的工作区 Electron 构建上，隔离 `DSH_HOME` + `--user-data-dir`，CDP 驱动真实应用与真实模型端点，逐步操作并截图/日志留证。agent 走查必须逐项记录环境、步骤、观察与证据路径，不得以「CI 绿」或单测通过替代。执行方（agent 或真人）与证据在验收文档中如实标注。

1. 从“我的技能”点击“对话创建技能”，完成访谈并看到确认卡。
2. 选择继续修改时草稿更新；选择取消时没有新技能。
3. 确认后成功卡出现，“我的技能”立即可见该技能且默认未启用。
4. 手动启用后可通过 `/name` 调用；禁用后不可调用。
5. 全程没有生成脚本、端点或外部接口配置，没有自动上传或发布。

## 13. 独立性

本需求不依赖任务结果 Artifact 或右侧进度面板。确认卡与成功卡沿用会话消息体系即可；结果页和进度需求无论是否实施，都不改变本规格的创建授权与落盘语义。
