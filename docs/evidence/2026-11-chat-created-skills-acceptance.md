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
- 本文档**不构成**验收通过声明；在 §4 回填之前，本分支不满足计划的 Completion Criteria。

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
| 1 | 从“我的技能”点击“对话创建技能”，完成访谈并看到确认卡 | 待执行 |
| 2 | 选择继续修改时草稿更新；选择取消时没有新技能 | 待执行 |
| 3 | 确认后成功卡出现；“我的技能”立即可见且默认未启用；同一 draftId 重放不新增第二张成功卡 | 待执行 |
| 4 | 手动启用后可通过 `/name` 调用；禁用后不可调用 | 待执行 |
| 5 | 全程无脚本、端点或外部接口配置；无自动上传或发布 | 待执行 |

建议的真机验收补充观察点（来自评审残余）：

- 项目标签在场时点击“对话创建技能”应落到普通会话标签，不创建项目子任务。
- 历史面板打开时点击“对话创建技能”应露出会话标签与输入框。
- 双草稿/损坏草稿提示中的 `/create-skill cancel`、`/create-agent cancel` 在客户端实际可恢复。
- `pendingPick` 标签不被复用为技能创建目标（会产生一个新的普通标签，属既定取舍）。

## 5. 残余与裁定（移交 owner）

- **F5 停放**：先前已存在的同名用户技能 `create-skill` 会被内部入口遮蔽且无法启停（与 `create-agent` 先例一致）。任何迁移/重命名裁定属于 owner，本分支未处理。
- **停放（Low）**：`pendingPick` 标签不被复用为创建目标（可能多开一个普通标签，无数据风险）。
- **停放（Low）**：损坏草稿 + 凭证重放窗口下草稿仍保留（与首提交清理同一限制；显式取消现可从客户端触达）。
- **停放（Low）**：`selectSubtask` 与本次修复对称的历史面板问题属应用级导航，超出本计划范围。
- 其余 deferred minors 见 `.superpowers/sdd/2026-11-15-chat-created-skills/progress.md`（SDD 工作区，git-ignored，合入前会随工作区清理；要点已在本节汇总）。

## 6. 仓库状态备注

- `docs/superpowers/plans/*`、`docs/superpowers/specs/*`（本计划/规格/评审/另两份计划）为**未跟踪新文件**，本分支的 11 个提交均未包含它们；合入前是否提交由 owner 决定。
- 工作区 `AGENTS.md` 的修改为既有未提交改动，本分支未触碰、未提交。
