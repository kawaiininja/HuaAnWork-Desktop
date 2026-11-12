# 三个智能体包与广场接入设计（typo-check / code-review / task-orch）

- 日期：2026-11-11
- 状态：设计已获 owner 批准（2026-11-11），待 spec 审阅后进入实施计划
- 范围：`dsh-plugin-huaanwork` 运行时扩展 + 三个智能体包定义 + 签名广场接入 + 原目录清理
- 上游约束：`deepseek-harness/` 子模块零修改；manifest schema、admin CLI、catalog server 代码、广场卡 schema 均不改

## 1. 背景与目标

`/Users/amonmiao/Downloads/cursor/` 下三个独立项目（错别字检测智能体 TypoGuard、代码审查智能体 code-review-cli、任务编排智能体 orch）均为常驻 HTTP 服务形态，与 HuaAnWork 智能体包的回合制运行时不兼容。owner 裁定将其**完全 LLM 化**为三个自包含智能体包，经 **M2 签名发布流程**进入智能体广场；原服务退役，原目录在备份与再次确认后可删除。

目标：

1. 三个包以中文 displayName 出现在广场，名称/描述/能力披露与页面展示一致。
2. 错别字检测实现「两个子代理背靠背双盲检测 + 主代理仲裁」——需要一次运行时扩展（包允许 subagent 派发 + 孙代工具收窄继承）。
3. 任务编排为「复杂任务拆解 + 可实施执行计划」顾问，只出计划不执行。
4. 全程验证留证据；原目录删除前备份并经 owner 再次确认。

## 2. 裁定记录

| 编号 | 裁定 | 日期 |
| --- | --- | --- |
| R1 | 完全 LLM 化：三包自包含，常驻服务退役；错别字检测降级为宿主模型直检（放弃跨厂商双模型/断点续跑）；任务编排为知识顾问 | 2026-11-11 前 |
| R2 | 智能体包 + 签名发布：中文 displayName，走 M2 签名链路；开发密钥仅验证，正式上架需 owner 真实密钥 | 2026-11-11 前 |
| R3 | 双盲检测本里程碑做运行时扩展：包允许名单加 `subagent` + 孙代收窄继承 + 回归钉（约 2–3 人日，安全敏感文件须独立评审） | 2026-11-11 |
| R4 | task-orch 升级为「任务拆解与执行计划顾问」：输入复杂任务，输出依赖拆解 + 步骤计划 + 验收标准 + 调度建议 | 2026-11-11 |
| R5 | 完整设计批准，写 spec | 2026-11-11 |

## 3. 总体架构

```
用户 @错别字检测 / @代码审查 / @任务编排
        │  agent-invoke.ts（包优先分发，现状不改）
        ▼
包直接子会话（allow = read/read_file/glob/grep/bash|pwsh/subagent [+运行时工具]）
        │  typo-check：主流程提取文本后，经 subagent 工具派两个独立 lane
        ▼
孙代 lane 会话（继承同一份 allow ∩ 自身工具表；不挂包运行时）
        │  两路结果返回主流程
        ▼
主代理仲裁 → 最终报告（对话输出）
```

- 三个包 `tools.mode: "none"`：无 HTTP/MCP 服务器，无回合外进程。
- 运行时扩展只涉及 huaanwork 自有的五个文件（§4.2），不改上游、不改 manifest schema。
- 广场链路：本地播种 → `agent.packagePublish` → catalog server → admin CLI 签名批准 → 广场签名卡 → `packageInstall`。

## 4. 运行时扩展：包子代理派发与孙代收窄继承

### 4.1 现状与证据（已核实）

1. 包允许名单不含 `subagent`：`composeAgentPackageToolAllowList`（`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:166-185`）基础集为 read/read_file/glob/grep + 平台 shell，另按 manifest 加 agent_skill_run/agent_http/MCP 名。包会话当前派不出子代理。
2. 全局基线宽松：`present-as.ts:15-43` 的 `ALLOWED_TOOLS` 含 edit/write/bash/git_push/web_fetch/call_host_tool/subagent 等；`restrictInternal`（:125-149）对**所有** agent 只施加「ALLOWED_TOOLS ∪ 会话附件」基线。
3. 包收窄只到直接子会话：`skills.ts` 的 start/startActivation 包装按 `pkg.parentSessionId === parentFromCall`（start 路径）与 `pkg.childId === childSessionId`（activation 路径）匹配后 `pkg.allow ∩ schemas → tools.restrict`；注释明示「没有 Host runId 的嵌套子代理不在本检查范围内」。
4. 结论：若只把 `subagent` 加进允许名单而不做继承，包会话派出的孙代将拿到全局基线工具（含 write/call_host_tool）= 沙箱绕过。继承是本扩展的安全前提，不是可选项。
5. 可复用机制：`ctx.huaanworkPackageChildSessions`（`holders.ts:48`，`host.ts:727-737` bindChild 写入、releaseChildBindings 清理）；`child-sessions.ts` 进程级父子登记表；`policy.ts` 已有 `tools/pre-execute` 按会话 id 的判定先例（包链路 mcp__* 放行）。

### 4.2 变更设计（五个文件）

**C1 允许名单**（`agent-package/runtime.ts`）
`composeAgentPackageToolAllowList` 基础集加入 `'subagent'`，对所有包统一开放，不加 manifest 字段（YAGNI；安全性由 C2–C5 保证）。`subagent` 是 harness 原生工具（bundle/base 的 tool-subagent），无需宿主附件。

**C2 血缘允许表 holder**（`huaanwork-host/holders.ts`）
新增 `huaanworkPackageChildAllow: Map<string, readonly string[]>`：会话 id → 该会话所属包回合的 allow 快照。与 `huaanworkPackageChildSessions` 同文件声明、同处初始化（holders.ts:168 的 Set 初始化先例）。

**C3 绑定与清理**（`agent-package/host.ts`）
- `bindChild`：在既有 Set/registry 写入的同批，`huaanworkPackageChildAllow.set(childSessionId, allow)`，allow 为**本回合的数组引用**（dispatch 闭包内的 request.allow）。
- `releaseChildBindings`：按**引用同一性**清理——移除 map 中 value === 本回合 allow 引用的全部条目。由此 skills.ts 为孙代写入的同引用条目（C4）一并清掉，且绝不误清其他并发回合（每回合 `composeAgentPackageToolAllowList` 返回新数组，引用回合唯一）。清理可重复执行的既有语义不变。

**C4 孙代收窄与传递绑定**（`huaanwork-guardrails/skills.ts`）
startActivation 包装在既有 pkg/legacy 分支之外新增血缘分支：本次 activation 未命中包请求、且 `parentFromCall` 在 `huaanworkPackageChildAllow` 中时——
1. activation 解析后，取孙代 `tools.schemas()`，`allow = 继承allow ∩ 现有工具名`，`tools.restrict({ allow })`（与直接子会话同一机制、同一时序：先于返回 handle）。
2. `huaanworkPackageChildAllow.set(孙代id, 继承allow)`（**同一引用**）⇒ 曾孙代沿同样分支继续继承，深度方向传递闭包；深度上限由 harness tool-subagent 的 maxDepth 配置天然约束。
3. **不挂包运行时附件**：孙代不挂 agent_http/agent_skill_run/MCP（v1）。allow ∩ schemas 自然滤掉未挂载的运行时工具名。
4. start 包装路径（旧签名回落）做同形处理，保持两条入口一致。

**C5 执行期强制**（`huaanwork-guardrails/policy.ts`）
`tools/pre-execute` 增加判定：执行会话 id 命中 `huaanworkPackageChildAllow` 且工具名 ∉ 对应 allow ⇒ 拒绝。理由：schema 收窄发生在 activation 之后，与直接子会话一样存在首步时序窗（M1 残余同形）；执行期强制把窗口封死——即使模型短暂看到宽名单，越权调用也执行不了。fail-closed：map 缺席时不改变现状行为。

### 4.3 不变量（回归钉必须全部守住）

- 直接包 child 路径正常时序行为零变化（既有 skills/host/present-as 钉子全绿）；C5 对直接子会话同样生效，属有意的安全收紧——首步时序窗内的越权调用从「可能执行」变为「拒绝」，不改已收窄状态下的任何行为。
- legacy `@agent` 路径零变化；主会话模型自主 subagent 行为零变化（无血缘条目 ⇒ 基线）。
- activation parent-mismatch fail-closed 保留。
- 跨回合隔离：并发回合互不清理对方条目；回合结束后条目清空，复用的会话 id 不继承旧包标志。
- 孙代永远拿不到 call_host_tool/run_code（基线本就排除）；拿不到未挂载的包运行时工具。
- 取消/late-activation 场景清理可重复，不留 stale 条目。

### 4.4 测试矩阵（新增 `tests/huaanwork-guardrails/package-subagent-lineage.spec.ts` 等）

1. allow 名单含 subagent（darwin 与 win32 两种平台形态）。
2. 孙代 schemas 收窄为 pkg.allow ∩ schemas；首步有效工具表断言（fake provider 捕获）。
3. 传递性：曾孙代同样收窄。
4. 执行期强制：血缘会话调用 allow 外工具被 policy 拒绝（即使 schemas 尚未收窄）。
5. 跨包隔离：A 包血缘不拿 B 包 allow；并发回合引用清理互不影响。
6. 清理：回合结束/取消后 map 无残留；id 复用不继承。
7. legacy 路径与主会话 subagent：既有钉子零改动全绿。
8. `tools/change` 触发 restrictAll 后，血缘会话收窄保持（与直接子会话同语义；若上游 restrict 组合语义不支持，按真实行为记录并裁定，不静默放宽）。

### 4.5 风险

- skills.ts/policy.ts 为安全敏感文件：实施后必须走独立代码评审（requesting-code-review），评审结论经反证校准。
- 上游 `tools.restrict` 与 present-as 的组合语义未逐字核实到运行时层：以 §4.4 第 8 条实测钉界，不凭推演断言。
- 同模型双 lane 的相关盲区不可消除：属裁定的降级（R1），在包描述与证据中如实写明。

## 5. 三个包定义

### 5.0 共同形态

- 源文件落点：`dsh-plugin-huaanwork/agent-packages/{slug}/`（布局门禁不限制该树内部子目录，已核 `scripts/verify-layout.mjs`），每包 `agent.json` + `persona.md` + `skill/SKILL.md`。
- manifest：schemaVersion 1；version `1.0.0`；persona `"persona.md"`；skill `{ entry: "skill/SKILL.md", summary: ≤200字 }`；`tools: { mode: "none" }`；`allowSkills: []`。draftId/createdAt/updatedAt 由播种脚本生成。
- 预算：persona/SKILL.md 各 ≤32KiB，整包 ≤5MiB（store 既有上限）；检测规则/审查规格/方法论全部内联进 SKILL.md，**不放额外引用文件**（store 写入 API 的文件集不含任意 references）。
- 能力披露：包实际允许名单 = read/read_file/glob/grep/bash（win32 为 pwsh）/subagent；广场签名卡展示 displayName/description/version/size（`catalogPackageCard` 无 capabilities 字段，已核实），能力项在安装/启用对话框按允许名单披露。
- Qoder 侧 `superpowers:dispatching-parallel-agents` 属另一套技能体系，包无法引用；双盲派发模式写进 SKILL.md 文本。

### 5.1 错别字检测（slug: `typo-check`）

- displayName：`错别字检测`
- description：`对指定文件夹中的 Word 文档做错别字与用语规范检测：两个独立子代理背靠背双盲检测，主代理仲裁分歧，输出带行号定位与置信度的报告。`
- persona 要点：中文公文/金融文档校对专家；严谨、只报有据之错；不改动原文。
- SKILL.md 工作流：
  1. **枚举**：按用户给定路径 `glob` 匹配 `*.docx`（单文件亦支持）；逐个处理。
  2. **提取**：macOS `bash` 跑 `textutil -convert txt -output <临时目录>/<名>.txt <docx>`（系统自带，零依赖）；Windows `pwsh` 用 System.IO.Compression 读 `word/document.xml`，`<w:p>` 转换行、去标签、解实体。txt 行号即定位锚点。临时文件落工作区临时目录，报告完成后清理。
  3. **条件分块**：提取文本 ≤30k 字整篇检测；超过则按 ≤30k 字/块、重叠 500 字切块，逐块检测后合并去重（阈值保守值，适配宿主模型上下文）。
  4. **双盲派发**：经 `subagent` 工具派两个独立 lane；每个 lane 的 prompt 只含：检测规则（从 SKILL.md 规则节内联复制）+ 目标 txt 路径 + 输出格式要求；**不含另一 lane 的任何信息**。两 lane 会话互不可见（独立会话即双盲；运行时串行或并行调度不影响独立性）。
  5. **仲裁**：两路返回后主流程逐条比对——双路一致 ⇒ 高置信收录；单路报告 ⇒ 回读原文上下文裁决（成立则收录并标「仲裁」，不成立则丢弃）；两路冲突 ⇒ 回读原文给出裁定。
  6. **报告**：按文件输出发现列表：行号/段落、原文、建议、类别、置信度（双路一致/仲裁）、依据；对话输出为主，用户要求时用 bash 写报告文件。
- 检测规则来源：原项目 `错别字检测智能体/review-spec-v2.md`（7 类）与 `src/typoguard/lanes/prompts.py` 蒸馏内联（错别字/标点/用语规范/语法等类别与判据）。
- 降级声明（写进 SKILL.md 与证据）：同模型双 lane ≠ 原 DeepSeek+Kimi 跨厂商交叉验证；无 python-docx 结构化锚定（txt 行号替代）；无断点续跑。

### 5.2 代码审查（slug: `code-review`）

- displayName：`代码审查`
- description：`对指定代码文件或目录做结构化审查：按审查规格逐项检查正确性、安全、性能与可维护性，输出按严重度分级的发现与修复建议。`
- persona 要点：资深代码评审者；先反证再定严重度；只报有证据的问题。
- SKILL.md 工作流：read/glob/grep 读目标代码 → 按 REVIEW_SPEC 逐项审查 → 大文件条件分块（同 5.1 阈值策略）→ 输出按严重度（阻断/重要/建议）分级的发现：位置、问题、证据、修复建议。
- 规格来源：原项目 `代码审查智能体/src/spec.ts` 的 REVIEW_SPEC 逐节移植（保留审查维度/严重度定义/输出格式，剔除服务与 HTTP 相关内容）。
- 无运行时依赖，不需要 subagent（单会话审查；双盲不引入，YAGNI）。

### 5.3 任务编排（slug: `task-orch`）

- displayName：`任务编排`
- description：`把复杂任务拆解为可实施的执行计划：子任务依赖分析、每步输入产出与验收标准、顺序与并行建议、周期任务的 cron/interval 调度建议。只出计划，不执行。`
- persona 要点：任务编排顾问；拆解落在真实工程上；计划可执行、可验收；不承诺自动执行。
- SKILL.md 工作流：
  1. 理解复杂任务；若附项目路径，用 read/glob/grep 读实际代码/文档再拆解。
  2. 输出结构化计划：子任务分解（依赖 DAG、可并行项标注）；每步的输入/动作/产出/验收标准；执行顺序建议；周期性任务给调度建议（cron 5 段或 interval `30s|5m|1h|1d` 形态，借鉴原 orch 调度模型）。
  3. 输出形态：Markdown 计划为主；周期任务可附 tasks.json 风格结构化 JSON 附录（借鉴原 `任务编排智能体/src/types.ts` 的 schedule/retry/alert 字段形态，endpoint 语义泛化为「执行者：人/智能体/脚本」）。
  4. 按用户反馈迭代修订。
- 方法论来源：原项目 `docs/任务编排智能体-系统化说明书.md`、`docs/任务编排智能体-工程实践指南.md` 与 types.ts 调度/重试/监控模型蒸馏。
- 边界（写进 SKILL.md）：只出计划不执行——无定时触发、无运行监控、不自动派发其他智能体；执行由用户或主会话驱动。

## 6. 广场接入

### 6.1 验证链路（本里程碑交付，开发密钥）

1. **播种**：新增 `dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs`，直接 import desktop TS src 的 store API（M2 验收先例 `scripts/huaanwork-agent-package-m2-acceptance.mjs` 形态），把 `agent-packages/` 三包写入**验收实例的 profileDir**（`{profileDir}/agents/{slug}` + `agents-state.json`），写前过 `parseAgentPackageManifest` 与 `agentPackageBytes` 预检。不碰生产 profile。
2. **发布验证**：新增 `scripts/verify-agent-packages-plaza.mjs`——隔离本地 catalog server + 每运行一次性 Ed25519 开发密钥对（绝不提交私钥）：`agent.packagePublish` 提交 → admin CLI `approve --private-key <临时pem> --slot 1 --yes` → 签名摘要出现 → `packageInstall` → `plazaCards()` 断言三张中文 displayName 卡。
3. **旧条目**：仓库内 `agent-catalog-server/tests/fixtures/entries/{typo-check,code-review,task-orch}.json` 三份 kind:"tool" fixture **保留作测试数据**。验证用隔离 catalog 的 entriesDir 不含它们即可。

### 6.2 正式上架（owner 运维动作，不在本里程碑代码范围）

- 生产 catalog 的 entriesDir 中三条同名 kind:"tool" 条目必须先退役：同名 legacy 条目一律 409 `legacy-conflict`（`agent-catalog-server/src/submissions.ts:428-446`），迁移例外仅限 kind:"agent"，tool 条目无迁移路径。
- 签名用 owner 真实密钥；本设计不生成、不持有、不提交任何生产私钥。

## 7. 验证计划

1. **单元测试**：§4.4 全矩阵 + 三包 manifest 校验/预算断言 + 播种/发布脚本自测。
2. **门禁**：`corepack yarn typecheck`、`corepack yarn test`、`corepack yarn check` 全量；`verify:aa` 并发竞态为已登记既有 flaky，失败时隔离重跑并如实记录。
3. **真机走查（CDP）**：用 open-latest-huaanwork 最新构建——广场出现三张中文名卡；安装/启用对话框能力披露正确；用**验收专用样例 docx**（脚本生成，含已知错别字；不用真实基金报告）跑通 typo-check，观测两个 lane 子代理与仲裁结果；code-review 审一段样例代码；task-orch 拆解一个样例复杂任务（如「为市场模块增加离线缓存」）并产出含依赖与验收标准的计划。
4. **独立评审**：运行时扩展（skills/policy/host/runtime/holders）走 requesting-code-review，结论经反证与严重度校准。
5. **Windows**：pwsh 提取与 win32 allow 形态做单元测试；无第二台 Windows 真机 ⇒ 真机项记 BLOCKED（R-ACCEPT-1 豁免先例），不声称跨机器通过。
6. 证据落 `docs/evidence/2026-11-11-three-agent-packages.md`（逐项命令/退出码/截图指针；CI 绿 ≠ 真机，区分 PR CI 与 master run）。

## 8. 原目录清理

1. **备份**：`tar -czf ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz` 打包三个原目录（含 typo `data/` 真实基金报告与 orch.db 248MB 历史），备份落仓库外；`tar -tzf` 校验完整性。
2. **前置**：§7 验证全部通过（或如实记录 BLOCKED 项并经 owner 接受）。
3. **再次确认**：向 owner 明示备份位置与删除范围，获明确同意后才执行删除。三个目录均无 git remote，备份是唯一安全网；未经再次确认绝不删除。

## 9. 边界与非目标

- 不做跨厂商双模型；不做常驻服务/定时执行/监控告警；不做自动派发执行。
- 不改 manifest schema、admin CLI、catalog server 代码、广场卡 schema、上游子模块。
- 不加 manifest 级 subagent 开关（统一开放 + 继承保证安全）。
- 孙代不挂包运行时（agent_http/agent_skill_run/MCP）；后续如需另立裁定。
- 生产签名与生产目录退役为 owner 运维动作。
- 原三个项目的代码不移植（仅蒸馏提示词/规格/方法论）；服务依赖（Python/node:sqlite 等）全部不引入。

## 10. 文件改动清单（预估）

| 类别 | 文件 |
| --- | --- |
| 运行时扩展 | `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts`（C1）、`huaanwork-host/holders.ts`（C2，声明+初始化）、`huaanwork-host/agent-package/host.ts`（C3）、`huaanwork-guardrails/skills.ts`（C4）、`huaanwork-guardrails/policy.ts`（C5） |
| 包源文件 | 新增 `dsh-plugin-huaanwork/agent-packages/{typo-check,code-review,task-orch}/{agent.json,persona.md,skill/SKILL.md}` |
| 脚本 | 新增 `dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs`、`scripts/verify-agent-packages-plaza.mjs` |
| 测试 | 新增 `tests/huaanwork-guardrails/package-subagent-lineage.spec.ts` 等；runtime allow 既有单测扩展 |
| 文档 | 本 spec；实施证据 `docs/evidence/2026-11-11-three-agent-packages.md` |
| 不改 | `deepseek-harness/`、manifest schema、admin CLI、catalog server、广场卡 schema、测试 fixtures |