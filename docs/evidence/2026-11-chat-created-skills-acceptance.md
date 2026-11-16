# 对话创建技能 — 实施证据（2026-11-16）

- 分支：`feat/chat-created-skills`（基线 `ff29debd37d72a92f10d446eafa07867d17befd8`）
- 最终代码提交：`1d99d015b8`（本文件落盘提交在其之后）
- 规格：`docs/superpowers/specs/2026-11-15-chat-created-skills-design.md`
- 计划：`docs/superpowers/plans/2026-11-15-chat-created-skills.md`
- 评审：`docs/superpowers/plans/2026-11-15-implementation-plans-review.md`
- 环境：macOS（darwin 27.0.0 / arm64）；Node v24.22.1；根 Yarn 4.18.0（Corepack）

## 0. 状态声明

- 自动化门禁（§1）均**实际执行**并记录真实结果。
- 规格 §12.2 的五项**人类验收（§4）尚未执行**，需 owner 真人完成并回填证据。
- 2026-11-16 已做一次 **agent 辅助真机走查（§4.1）**：第 4 项 PASS；第 1–3 项 FAIL/BLOCKED（模型未调用 `skill_propose`，上游在该步恒空响应）；第 5 项对正式流程未验证。这不是人类验收，不能替代 §4。
- 本文档**不构成**验收通过声明；在 §4 回填与 §4.1 观察 2 解决之前，不满足计划的 Completion Criteria。

## 1. 自动化门禁（实际执行，原始退出码）

| 命令 | 提交 | 执行方 | 退出码 | 关键计数 |
| --- | --- | --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork check` | `5427147e28` | Task 6 实现者 | 0 | 4201 passed / 15 skipped；`verify:aa` 本轮未出现并发竞争，直接通过 |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | `1d99d015b8` | 终波修复实现者 | 0 | 无输出 |
| 最终修复波聚焦套件（6 spec） | `1d99d015b8` | 终波修复实现者 | 0 | 263 passed |
| `corepack yarn check` | `987b014774` | 控制器 | 0 | 全链通过（最后一个 workspace agent-catalog-admin 15/15）；该次运行早于终波修复提交 |
| `corepack yarn check` | `1d99d015b8` | 控制器 | 0 | 终树复跑全链通过（最后一个 workspace agent-catalog-admin 15/15） |

说明：计划允许 `verify:aa` 并发竞争时串行重跑并如实记录；本次两轮根门禁均未出现该竞争，无重跑。

## 2. 提交链（ff29debd37..1d99d015b8）

| 提交 | 内容 |
| --- | --- |
| `f0c9503994` | 共享创建用语 + 内部 `create-skill` 技能与保留名 |
| `7855ff0b39` | 本地状态幂等字段 + `createSkillFromDraft`/`findSkillByCreationDraftId` |
| `f11e54aa20` | 写边界校验：空/未成对创建 ID 拒绝 |
| `0c858ca43f` | 技能草稿、校验与提交原语 |
| `ba9a8c596e` | 草稿损坏时 propose fail-closed |
| `86820df514` | 技能创建 Host 门面、双向工具与事件 |
| `db4d108ca4` | 会话路由双向互斥 + 智能体侧严格读取/低层防护 |
| `a44a932ffe` | 取消失败如实提示，不谎报成功 |
| `5427147e28` | 客户端确认卡/成功卡、事件接线与“我的技能”入口 |
| `987b014774` | 启动对话创建时清除历史面板，真正露出会话标签 |
| `1d99d015b8` | 终审修复波：客户端形态显式取消、项目标签排除、门面重建、显式智能体入口不被技能 NL 劫持、重放清理草稿 |

## 3. 规格 §12.1 自动化覆盖映射（摘要）

| 规格条目 | 覆盖位置 |
| --- | --- |
| §12.1#1 入口识别（命令/自然语言/普通“修改技能”不误判） | `tests/huaanwork-host/skill-creation.spec.ts`、`agent-package-creation.spec.ts` |
| §12.1#2 propose 字段/预算/保留名/换行拒绝/对方草稿拒绝/卡与 frontmatter 一致 | `skill-creation-drafts.spec.ts`、`skills-host.spec.ts`、`skill-creation-tools.spec.ts` |
| §12.1#3 同意/取消/错误 draftId/跨会话/非创建轮/同轮 propose+commit | `skill-creation-drafts.spec.ts` |
| §12.1#4 双向互斥、普通 /name 与 @agent 不误拒、文件与附件不变 | `agent-package-creation.spec.ts`、`skill-creation.spec.ts`、`agent-package-drafts.spec.ts` |
| §12.1#5 取消只清所选流程；双草稿三向拒绝；显式取消恢复 | `agent-package-creation.spec.ts`、`skill-creation.spec.ts`、`skill-creation-drafts.spec.ts` |
| §12.1#6 重放凭证、phantom 目录、崩溃窗口 | `skill-creation-drafts.spec.ts`、`skills-host.spec.ts` |
| §12.1#7 `origin=created` 默认禁用；启用前 /name 拒绝、启用后可用 | `skills-host.spec.ts` |
| §12.1#8 重复 commit 幂等；编辑/上传后保键；另存不继承 | `skills-host.spec.ts`、`skill-catalog-upload.spec.ts`、`skill-duplicate.spec.ts`（回归） |
| §12.1#9 零写入、原子写、损坏 fail-closed | `skill-creation-drafts.spec.ts`、`skill-local-state.spec.ts` |
| §12.1#10 独立 `skill/changed`/`skill/success`、draftId 去重、notice 不插卡 | `appWiring.spec.ts`、`skill-success-card.spec.ts`、`skill-confirm-card.spec.ts` |
| §12.1#11 确认按钮走 `session.send('确认')`；结果定稿后解绑；失败不解绑 | `appWiring.spec.ts`、`skill-creation-tools.spec.ts` |
| §12.1#12 既有表单/导入/下载/上传/智能体创建回归 | `skills-host.spec.ts`、`skill-catalog-upload.spec.ts`、`skill-catalog-download.spec.ts`、`agent-package-creation.spec.ts`、`sessions.spec.ts` |

## 4. 规格 §12.2 人类验收（未执行 — 待 owner）

以下五项必须真人执行；执行后请在各行回填环境、步骤、观察与截图/日志路径。

| 项 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 从“我的技能”点击“对话创建技能”，完成访谈并看到确认卡 | 待执行（agent 辅助走查失败，见 §4.1） |
| 2 | 选择继续修改时草稿更新；选择取消时没有新技能 | 待执行（依赖第 1 项，未到达） |
| 3 | 确认后成功卡出现；“我的技能”立即可见且默认未启用；同一 draftId 重放不新增第二张成功卡 | 待执行（依赖第 1 项，未到达） |
| 4 | 手动启用后可通过 `/name` 调用；禁用后不可调用 | 待执行（agent 辅助走查 PASS，见 §4.1） |
| 5 | 全程无脚本、端点或外部接口配置；无自动上传或发布 | 待执行（正式流程未走到 commit，无法判定） |

建议的真机验收补充观察点（来自评审残余）：

- 项目标签在场时点击“对话创建技能”应落到普通会话标签，不创建项目子任务。
- 历史面板打开时点击“对话创建技能”应露出会话标签与输入框。
- 双草稿/损坏草稿提示中的 `/create-skill cancel`、`/create-agent cancel` 在客户端实际可恢复。
- `pendingPick` 标签不被复用为技能创建目标（会产生一个新的普通标签，属既定取舍）。

## 4.1 2026-11-16 agent 辅助真机走查（CDP，非真人验收，不能替代 §4）

环境：隔离临时 `DSH_HOME` + `--user-data-dir`（复制生产 `desktop` profile，模型 `deepseek-chat`，未打印密钥）；工作区 Electron `lib/main.js`（`1d99d015b8` 构建）；CDP 9333 + `HUAANWORK_ACCEPTANCE_HOOKS=1`。走查后已关闭实例并删除含密钥的临时 profile。证据目录（未入库）：`/tmp/hw-skill-accept-evidence-20261116/`（截图 + summary + 启动日志）。

| 项 | 结果 | 证据要点 |
| --- | --- | --- |
| 1 | **FAIL** | 确认卡从未渲染；全部会话中 `skill_propose` 实际调用数为 **0**（日志里出现的 2 处只是工具定义）。首轮访谈正常，模型先 `bash`/`read` 读技能文件，随后口头声称“已提交”但未调用工具；两次显式纠正（点名 `skill_propose` + 四个字段）均得到 `EMPTY_RESPONSE`（上游 5 次重试全空）。截图 `item1-no-confirm-card.png`。 |
| 2 | **BLOCKED** | 依赖确认卡，未到达；继续修改/取消入口未在真机触发。 |
| 3 | **BLOCKED** | 依赖确认卡，未到达；成功卡/默认未启用/同 draftId 去重均未在真机验证。 |
| 4 | **PASS（借助带外技能）** | 使用模型经子代理写入的 `weekly-report-writer`（见下）：禁用时 `/weekly-report-writer …` → `skill weekly-report-writer is disabled`；在“我的技能”启用后同一调用 → 模型按技能正文生成四节周报（会话日志出现 `# 已启用技能：weekly-report-writer` 包装提示）；再禁用 → 再次拒绝。截图 `item4-enabled-invoke-then-disabled.png`。 |
| 5 | **无法判定（正式流程未 commit）** | 唯一新增技能目录只含 `SKILL.md`（2260 B，无 scripts/资源）；`agents-endpoints.json` 未被修改；无发布/上传状态。但该目录是子代理用 `bash`/`write` 直接写入 `<profile>/skills/` 的带外产物，本地状态中**无**对应条目，不是对话流程的正式 commit。 |

### 关键观察（需 owner 与后续排查）

1. **模型绕过对话流程**：访谈轮中模型读取了用户已启用的 `skill-creator`，随后派生子代理用脚本/`write` 直接把 `weekly-report-writer/SKILL.md` 写进 profile 的 skills 目录（子会话工具集无 `skill_propose`，模型据此声称“工具没有附加”）。注入的 create-skill 指令（“只能调用 skill_propose、不得生成脚本”）没有被遵守；这是产品层健壮性风险（是否在创建回合限制工具集/收紧提示词，需要裁定）。
2. **`skill_propose` 步恒空响应**：A/B 对照——同一构建、同一模型、同一会话环境，`/create-agent` 立即正常调用 `agent_propose`（弹出批准请求）；而所有技能创建尝试在应调用 `skill_propose` 时上游返回空内容（共记录 54 条 `EMPTY_RESPONSE` 重试/错误）。直接用同一 `api_key` 对 `https://api.deepseek.com` 发同 schema 工具请求，非流式与流式都返回合法 `skill_propose` 工具调用（`finish_reason=tool_calls`）⇒ 上游模型/接口本身可用，问题落在应用侧 provider 适配/工具调用处理路径，需 Host/上游侧排查（超出本计划范围，但它是本功能在当前构建可用的硬阻塞）。
3. **带外技能可见性**：无本地状态条目的 `weekly-report-writer` 仍出现在“我的技能”（来源显示“创建”），可启停——属既有列表行为，但说明“目录即技能”的入口存在。
4. **密钥泄漏提示（事故记录）**：走查期间一条错误写的脱敏命令把临时 copy 里的两个 `api_key` 原样打印到了会话输出（仅本机 Qoder 会话记录，未写入仓库）；建议轮换这两个 key。临时 profile 已删除。

**结论**：第 4 项通过；第 1–3 项在当前构建失败/阻塞；第 5 项对正式流程未验证。§12.2 人类验收仍未完成，且在观察 2 解决并用真人流程复走之前，不应把本功能标记为验收通过或合入发布。

## 4.2 空响应根因排查（2026-11-16，systematic-debugging，未改动产品代码）

用本地转发代理抓取应用真实上游请求/响应，并在 policy / present-as / 工具 execute / attach 四个边界加临时日志（排查后已全部还原），复现并逐层定位：

1. **上游正常**：DeepSeek（OpenAI `/chat/completions` 与 Anthropic `/v1/messages` 两种协议）对同一工具 schema 均返回合法 `skill_propose` 工具调用（`finish_reason=tool_calls`，参数完整）。直连探针与代理抓包一致。
2. **注册与可见性正常**：`tools.schemas()` 含创建工具（`schemasHasCs=true`）；attach 后会话附件白名单含创建工具（`extraHasCs=true`），present-as restrict 的 `allowed` 随之包含它。即工具“已注册、已对模型可见、在执行白名单内”。
3. **丢弃发生在 LLM→agent-loop 转换层**：会话日志中创建工具**没有任何 `tool/call`**，policy `toToolCall` 与工具 `execute` 均未被触发；上游返回的 tool-call 块在进入 agent-loop 前被丢弃。content=0 时表现为 `EMPTY_RESPONSE`，有文本时表现为“只有文本、工具调用消失”。
4. **对照**：同一构建/同一模型下 `agent_propose`、`bash`、`read`、`request_input` 均正常执行；把工具改名为 `cs_propose`/`cs_commit`（排除 `skill_` 前缀冲突）**仍被丢弃**。

**根因判定**：丢弃位于上游 harness 的 LLM 流→工具调用归一化层（`@deepseek-ai/dsh-llm` / `@earendil-works/pi-ai`，处于 `node_modules`/`deepseek-harness` 子模组），对“会话附件挂载的创建类工具调用”选择性丢弃。该层不在 `dsh-plugin-huaanwork/` 可编辑面内（AGENTS.md 禁止改子模组），**无法在本分支内修复**。

**可达成的路径（需 owner 裁定）**：
- (a) 立一个独立的上游同步/补丁任务，修复或升级 pinned `deepseek-harness` 的工具调用归一化（按 AGENTS.md 选择性评审流程），再复走真机；
- (b) 若上游有兼容补丁缝（类似 market 的 compatibility patch），经 owner 批准后以补丁方式修正该层；
- (c) 在上游修复前，本功能真机第 1–3 项保持 BLOCKED，不宣称验收通过。

排查期间的临时改名与日志已全部 `git restore` 还原，工作区产品代码与 `d881bde5de` 一致；含密钥的临时 profile 与代理脚本已删除。

## 5. 残余与裁定（移交 owner）

- **F5 停放**：先前已存在的同名用户技能 `create-skill` 会被内部入口遮蔽且无法启停（与 `create-agent` 先例一致）。任何迁移/重命名裁定属于 owner，本分支未处理。
- **停放（Low）**：`pendingPick` 标签不被复用为创建目标（可能多开一个普通标签，无数据风险）。
- **停放（Low）**：损坏草稿 + 凭证重放窗口下草稿仍保留（与首提交清理同一限制；显式取消现可从客户端触达）。
- **停放（Low）**：`selectSubtask` 与本次修复对称的历史面板问题属应用级导航，超出本计划范围。
- 其余 deferred minors 见 `.superpowers/sdd/2026-11-15-chat-created-skills/progress.md`（SDD 工作区，git-ignored，合入前会随工作区清理；要点已在本节汇总）。

## 6. 仓库状态备注

- `docs/superpowers/plans/*`、`docs/superpowers/specs/*`（本计划/规格/评审/另两份计划）为**未跟踪新文件**，本分支的 11 个提交均未包含它们；合入前是否提交由 owner 决定。
- 工作区 `AGENTS.md` 的修改为既有未提交改动，本分支未触碰、未提交。
