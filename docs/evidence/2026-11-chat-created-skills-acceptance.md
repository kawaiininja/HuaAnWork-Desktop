# 对话创建技能 — 实施证据（2026-11-16 ~ 2026-11-17）

- 分支：`feat/chat-created-skills`（基线 `ff29debd37d72a92f10d446eafa07867d17befd8`）
- 最终代码提交：`0eb33b5ca9`（Grok §10 复审闭环波：工具互斥卸除、`pendingDetach` 随会话释放清理、确认卡不可用态隔离、`task`/`project`/`automation` 删会话清草稿与 `@agent` 对称断言；后续仅文档提交，不改产品代码，见 §2 提交链）
- 规格：`docs/superpowers/specs/2026-11-15-chat-created-skills-design.md`
- 计划：`docs/superpowers/plans/2026-11-15-chat-created-skills.md`
- 评审：`docs/superpowers/plans/2026-11-15-implementation-plans-review.md`（计划评审）；`docs/superpowers/plans/2026-11-16-chat-created-skills-code-review.md`（Gemini 复核、Kimi 终审、独立复审 Approve、Grok 审核与 §11 闭环）
- 环境：macOS（darwin 27.0.0 / arm64）；Node v24.22.1；根 Yarn 4.18.0（Corepack）

## 0. 状态声明

- 自动化门禁（§1）均**实际执行**并记录真实结果。
- 规格 §12.2 验收方式经 **owner 2026-11-16 裁定**：agent 真机走查（CDP + 真实构建 + 真实模型 + 隔离 profile）替代真人验收，规格 §12.2 与计划（`33f7823f6f` 同步 Task 7 / Completion Criteria）文本已保持一致。五项验收项不变，执行方与证据如实标注（§4）。
- 2026-11-16 先后做了两轮 **agent 辅助真机走查（§4.1）**。首轮因模型长上下文走神、创建工具批准未授予而未能出确认卡，曾误判为“上游丢弃工具调用”（§4.2 旧结论，已纠正）。第二轮在短上下文 + 显式批准下，**五项全部走通**：确认卡、继续修改/取消、成功卡+默认未启用、启停调用、仅 SKILL.md 无脚本/端点/自动上传。
- 2026-11-16 晚完成 Gemini code review 的独立复核与修复波（§7）：Critical 白名单修复入库、路由对称性、事件闸门顺序、字段归一化与 §12.1 缺口补齐；评审停放项 #7c（确认卡锁存）与 #7e（session.remove 清草稿）同波修复入库（`84c80e145c`），并完成全修复构建复走（§4.1.1）；#7f（样式合并）维持停放。
- 2026-11-17 完成 Kimi double-check 评审与修复闭环（§7）：Kimi 评审（`e4f6c0b123`）检出 0 Critical / 2 Important / 1 Minor；代码提交 `33f7823f6f` 闭环 **Kimi-I-1**、**Kimi-I-2** 与 **Kimi-M-1**，并同步计划 §12.2 口径与证据映射；独立只读复审（`ec7ad6fc8d`）给出 **Approve（0 Critical / 0 Important / 1 Minor：`Review-M-1` 经 owner 2026-11-17 裁定停放，见 §5）**，并在 `fa22902cfb` 完成归档对齐。
- 2026-11-17 完成 Grok 独立复审（`0189080386`，评审文档 §10：0 Critical / 0 阻断性 Important，结论「可合入」）与收口修复（`0eb33b5ca9`，评审文档 §11）：闭环 **Grok-S-1**（未落盘草稿切创建流程先卸对侧创建工具）、**Minor 1**（确认卡通过独立 `unavailable` 属性在 `sidecarDead || hostPhase !== "ok"` 时禁用按钮且不误标「已处理」）、**Minor 2**（`releaseSessionRuntime` 同步清理 `pendingDetach`）、**Minor 3**（`task.remove` / `project.remove` / `automation.*` 删会话统一移除两类创建草稿）以及 `@agent` 普通轮回归断言对称化；`Review-M-1` 维持停放。`33f7823f6f` 与 `0eb33b5ca9` 之后未重跑真实模型 CDP 走查，改由新增行为回归、聚焦回归套件与干净树 `corepack yarn check`（`4244 passed | 15 skipped`）验证闭环（见 §1、§4.1.1、§7）。

## 1. 自动化门禁（实际执行，原始退出码）

| 命令 | 提交 | 执行方 | 退出码 | 关键计数 |
| --- | --- | --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork check` | `5427147e28` | Task 6 实现者 | 0 | 4201 passed / 15 skipped；`verify:aa` 本轮未出现并发竞争，直接通过 |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | `1d99d015b8` | 终波修复实现者 | 0 | 无输出 |
| 最终修复波聚焦套件（6 spec） | `1d99d015b8` | 终波修复实现者 | 0 | 263 passed |
| `corepack yarn check` | `987b014774` | 控制器 | 0 | 全链通过（最后一个 workspace agent-catalog-admin 15/15）；该次运行早于终波修复提交 |
| `corepack yarn check` | `1d99d015b8` | 控制器 | 0 | 终树复跑全链通过（最后一个 workspace agent-catalog-admin 15/15） |
| `corepack yarn check` | `3b41400ba4` | 控制器（评审修复波） | 0 | 全链通过；桌面包 `4231 passed / 15 skipped (4246)`、`verify:host` 35/0、closure 316 节点、bundled 134 文件/10 内联、licenses 637 包、operations 7/18；最后一个 workspace agent-catalog-admin 15/15。完整日志 `/tmp/hw-root-check-20261116-r2.log` |
| `corepack yarn check` | `c8e044c356` | 控制器（2026-11-16 干净树） | 0 | 全链通过；桌面包 `4236 passed / 15 skipped (4251)`（+5：#7c/#7e 新钉）、closure 316 节点、operations 7/18；最后一个 workspace agent-catalog-admin 15/15。完整日志 `/tmp/hw-root-check-final-r2.log` |
| 最终修复波聚焦套件（7 spec） | `33f7823f6f` | 独立复审方 | 0 | `skills-host` 31/31、`skill-creation-tools` 15/15、`sessions` 98/98、`agent-package-creation` 58/58、`appWiring` 92/92、`skill-confirm-card` 5/5、`test-port-mapping` 1/1，合计 **300/300** 通过 |
| 桌面包聚焦套件（22 spec） | `ec7ad6fc8d` | 合并评审复核 | 0 | `Test Files 22 passed (22)`，`Tests 565 passed (565)`（vitest 实跑） |
| `corepack yarn check` | `ec7ad6fc8d`（代码 `33f7823f6f` 干净树） | 修复验证 & 合并评审复核 | 0 | 全链通过；桌面包 `299 passed \| 4 skipped (303)` 文件、`4238 passed / 15 skipped (4253)`（较 `c8e044c356` 4236 → 4238 passed）、`verify:host` 35/35、closure 316 节点、bundled 134 文件/10 内联/11/11、licenses 637 包、operations 7/18；`dsh-community-market` 13/303、`market-server` 14/244、`update-server` 5/88、`agent-catalog-server` 7/112、`agent-catalog-admin` 15/15。参考日志 `/tmp/hw-chat-created-skills-rereview-20261117.log` |
| Grok 闭环聚焦套件（`typecheck` + 13 spec） | `0eb33b5ca9` 工作树 | Grok 意见修复实现者 | 0 | `typecheck` 退出码 0；13 个 spec 文件、**535/535** 用例通过（含 `test-port-mapping` 1/1） |
| `corepack yarn check` | `0eb33b5ca9`（最终代码干净终树） | Grok 意见修复实现者 | 0 | 全链通过；桌面包 `299 passed \| 4 skipped (303)` 文件、`4244 passed \| 15 skipped (4259)`（较 `ec7ad6fc8d` +6 新回归）、`verify:host` 35/35、closure 316 节点（4/4）、bundled 134 文件/10 内联（11/11）、`verify:profile` 与 `verify:aa` 通过、licenses 637 包、operations 7/18；`dsh-community-market` 13/303、`market-server` 14/244、`update-server` 5/88、`agent-catalog-server` 7/112、`agent-catalog-admin` 15/15 |

说明：计划允许 `verify:aa` 并发竞争时串行重跑并如实记录；上述各轮根门禁均未出现并发竞争。评审修复波首轮根门禁退出码 **2**：typecheck 捕获归一化写法的 `exactOptionalPropertyTypes` 违规（vitest 不做类型检查），修正提交 `3b41400ba4` 后复跑退出码 0（首轮日志 `/tmp/hw-root-check-20261116.log`）。2026-11-16 干净树首轮退出码 **1**：`check-whitespace` 捕获 archive 文件末尾空行，修复提交 `c8e044c356` 后复跑退出码 0（首轮日志 `/tmp/hw-root-check-final.log`）。`33f7823f6f` 修复工作树首轮根门禁曾因 `sessions.spec.ts` 行号位移导致历史证据映射 `test-port-mapping.spec.ts` 失败，已于 `33f7823f6f` 同步校正并复跑退出码 0。后续本文件的归档口径对齐提交仅修订文档文本，不改动产品源码或测试。

## 2. 提交链（ff29debd37..0eb33b5ca9，另含归档收口文档提交）

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
| `9545c218cd` | 评审 Critical：适配器白名单放行 skill_propose/skill_commit + 回归钉 |
| `cc0afed6c8` | 评审 Important #1/#2 + Minor #4/#7d：agentNlAllowed 对称守卫、Step ⑤ 非创建轮豁免、损坏提示点名 cancel、斜杠前缀剥离 |
| `3733a2168d` | 评审 Important #3（复核降 Minor）：skill/changed 与 agent/changed 移出自动化闸门 + 顺序契约钉 |
| `10b1304ff3` | 评审 Minor #1/#2/#3/#5：字段归一化、随机 tmp 后缀、contentPreviewOf 去重与 commit 卡移除、beginUpdate 低层互斥 |
| `0654f565dc` | 评审 Minor #6/#7a/#7b：noteTab(chatId) 脚注、成功卡字段投影、入口禁用 |
| `90dfe0a944` | 评审 Important #4：§12.1 缺口补齐（保留名/预算/换行/卡↔frontmatter/损坏 catch/另存不继承） |
| `3b41400ba4` | 归一化写法满足 exactOptionalPropertyTypes（根门禁 typecheck 捕获后修正） |
| `cdc7dcda8f` | 评审 Minor #7c（owner 裁定修复）：新确认卡/成功卡消费旧卡，历史按钮禁用 |
| `84c80e145c` | 评审 Minor #7e（owner 裁定修复）：session.remove 统一清理两类创建草稿 |
| `5b6f54fce3` | owner 裁定：未跟踪规格/计划/评审文档随分支提交；AGENTS.md 历史记录压缩为活跃债务表 + 完整版移入 archive |
| `c8e044c356` | check-whitespace 门禁捕获：删除 archive 文件末尾空行 |
| `90d4c73284` | 文档更新：追加 5b6f54fce3 与 c8e044c356 到提交链与门禁状态 |
| `5b2ad7ba7b` | 文档引用收口：证据文档更新当时提交链至 90d4c73284 |
| `f26ccefe69` | 文档基线收口：证据文档固定当时代码提交 84c80e145c |
| `dab30cd667` | 文档记录：补录 c8e044c356 干净树根门禁结果（4236 passed，exit 0） |
| `e4f6c0b123` | Kimi double-check 代码评审落档（`dab30cd667` 树：0 Critical / 2 Important / 1 Minor） |
| `33f7823f6f` | Kimi 评审闭环波：闭环 Kimi-I-1 / Kimi-I-2 / Kimi-M-1（生命周期/残留启用态/取消消费），同步计划 §12.2 口径与证据映射 |
| `ec7ad6fc8d` | 独立只读复审落档：**Approve**（0 Critical / 0 Important / 1 Minor：`Review-M-1` 经 owner 2026-11-17 裁定停放） |
| `fa22902cfb` | 文档对齐：更新实施证据提交链与独立复审结果 |
| `0189080386` | Grok 独立复审落档（评审文档 §10：0 Critical / 0 阻断性 Important，结论「可合入」） |
| `0eb33b5ca9` | **最终代码提交**：闭环 Grok-S-1（改口切流程卸对侧工具）、Minor 1–3（确认卡 `unavailable` 隔离、`pendingDetach` 随会话释放清理、任务/项目/自动化删会话清草稿）与 `@agent` 回归断言补齐 |
| （后续仅文档提交） | 归档口径同步：在评审文档 §11 与本验收证据记录 `0eb33b5ca9` 闭环及根门禁实测结果，不改动产品源码或测试 |

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

## 4. 规格 §12.2 验收（agent 真机走查，owner 2026-11-16 裁定替代真人验收）

执行方式：agent 以 CDP 驱动真实应用构建（工作区 Electron `lib/main.js`，分支 `feat/chat-created-skills`），隔离 `DSH_HOME` + `--user-data-dir`，真实模型端点（`deepseek-chat`），逐步操作并截图/日志留证。执行方与证据路径逐项标注。2026-11-16 共两轮走查（§4.1），第二轮在短上下文 + 显式批准下五项全部走通；`84c80e145c` 构建复走一轮（§4.1.1）。后续 `33f7823f6f` 与 `0eb33b5ca9` 修复波未重跑真实模型走查（见 §4.1.1 说明）。

| 项 | 内容 | 执行方 | 结果 | 证据要点 |
| --- | --- | --- | --- | --- |
| 1 | 从“我的技能”点击“对话创建技能”，完成访谈并看到确认卡 | agent（CDP，第二轮 + `84c80e145c` 复走） | **PASS** | `/create-skill` → 访谈 → 模型调用 `skill_propose`（批准）→ 确认卡渲染（名称/描述/触发场景/正文摘要 + 三按钮）。截图 `item1-confirm-card.png` |
| 2 | 选择继续修改时草稿更新；选择取消时没有新技能 | agent（CDP，第二轮 + `84c80e145c` 复走） | **PASS** | 「继续修改」→ 修订 → 重新 propose → 新确认卡；「取消」→ `已取消创建技能，没有写入技能。`，目录与本地状态条目均不存在。截图 `item2-before-revise.png`/`item2-cancelled.png` |
| 3 | 确认后成功卡出现；“我的技能”立即可见且默认未启用；同一 draftId 重放不新增第二张成功卡 | agent（CDP，第二轮 + `84c80e145c` 复走） | **PASS** | 「确认」→ `skill_commit`（批准）→ 成功卡 +「前往我的技能」；列表立即可见、默认未启用。去重另有自动化钉（appWiring）。截图 `item3-success-card.png` |
| 4 | 手动启用后可通过 `/name` 调用；禁用后不可调用 | agent（CDP，两轮均 + `84c80e145c` 复走） | **PASS** | 禁用时 `/daily-summary …` → `skill daily-summary is disabled`；启用后按技能正文输出；再禁用再次拒绝。截图 `item4-disabled-invoke.png` |
| 5 | 全程无脚本、端点或外部接口配置；无自动上传或发布 | agent（CDP，第二轮 + `84c80e145c` 复走） | **PASS** | 技能目录仅 `SKILL.md`；`origin={kind:"created"}`、无 `publishedRevision/Digest`；`agents-endpoints.json` 未被修改；无自动启用 |

证据目录（本机 `/tmp` 临时目录，未入库）：`/tmp/hw-skill-walk3/evidence/`（第二轮历史引用，实机路径为 `/tmp/hw-skill-walk3-evidence`）、`/tmp/hw-skill-walk-final/evidence/`（`84c80e145c` 复走）。走查后关闭实例并删除含密钥临时 profile。

建议的真机验收补充观察点（来自评审残余）：

- 项目标签在场时点击“对话创建技能”应落到普通会话标签，不创建项目子任务。
- 历史面板打开时点击“对话创建技能”应露出会话标签与输入框。
- 双草稿/损坏草稿提示中的 `/create-skill cancel`、`/create-agent cancel` 在客户端实际可恢复。
- `pendingPick` 标签不被复用为技能创建目标（会产生一个新的普通标签，属既定取舍）。

## 4.1 2026-11-16 agent 真机走查记录（CDP，owner 2026-11-16 裁定替代真人验收）

环境：隔离临时 `DSH_HOME` + `--user-data-dir`（复制生产 `desktop` profile，模型 `deepseek-chat`，未打印密钥）；工作区 Electron `lib/main.js`（分支 `feat/chat-created-skills` 构建）；CDP 9333 + `HUAANWORK_ACCEPTANCE_HOOKS=1`。共两轮；第二轮五项全部走通。走查后关闭实例并删除含密钥临时 profile。证据目录（本机临时目录，未入库）：原记录作 `/tmp/hw-skill-walk3/evidence/`，实机目录为 `/tmp/hw-skill-walk3-evidence`。

**构建基线说明**：第二轮走查的工作区构建包含了当时尚未提交的白名单修复（`model.ts`/`model.spec.ts`，后入库为 `9545c218cd`）。该修复是走通的前提——干净提交树在修复入库前主链路确定性不可用（§4.2 已更正）。本波修复已全部入库，规格 §12.2 验收以此走查记录为准。

**第二轮（短上下文 + 显式批准）结果：**

| 项 | 结果 | 证据要点 |
| --- | --- | --- |
| 1 | **PASS** | `/create-skill` → 访谈 → 模型调用 `skill_propose`（需点击“批准”，策略 ask）→ 渲染确认卡（名称/描述/触发场景/正文摘要 + 确认创建/继续修改/取消）。截图 `item1-confirm-card.png`。 |
| 2 | **PASS** | 点“继续修改”→ 发送修订 → 重新 `skill_propose`（批准）→ 新确认卡含“修订版”（草稿更新）；点“取消”→ `已取消创建技能，没有写入技能。`，`meeting-notes` 目录与本地状态条目均不存在。截图 `item2-before-revise.png`/`item2-cancelled.png`。 |
| 3 | **PASS** | 回复“确认”→ `skill_commit`（批准）→ 成功卡“已保存技能 weekly-report-writer，请在‘我的技能’中启用”+“前往我的技能”；“我的技能”立即列出该技能、来源“创建”、默认未启用（启用按钮）。本地状态含 `creationDraftId`+`creationSessionId`（受控幂等）。截图 `item3-success-card.png`。同 draftId 去重另有自动化钉（appWiring）。 |
| 4 | **PASS** | 禁用时 `/weekly-report-writer …` → `skill weekly-report-writer is disabled`；启用后同一调用 → 模型按技能正文输出四节周报；再禁用 → 再次拒绝。截图 `item4-enabled-invoke.png`。 |
| 5 | **PASS** | 技能目录仅 `SKILL.md`（无 scripts/资源）；`origin={kind:"created"}`、无 `publishedRevision/Digest`（未上传/发布）；`agents-endpoints.json` 未被修改；无自动启用。 |

**首轮（失败）与纠正**：首轮在长/多轮上下文下模型走神（读 `skill-creator`、派生子代理带外写盘、口头声称提交），且 `skill_propose`/`skill_commit` 的“批准”请求未获授予，导致确认卡不出现，曾据此误判为“上游丢弃工具调用”。第二轮证明：**创建工具本身可正常执行**（propose/commit 均有 `tool/call` 与受控状态写入），首轮失败主因是模型合规性（长上下文）与批准未授予，而非确定性的上游产品 bug。

### 仍需 owner 关注的观察

1. **创建工具需显式批准**：`skill_propose`/`skill_commit` 走策略 ask，真机需用户点“批准”。这是安全设计，但意味着“确认卡→确认→commit”之外还有一次批准交互；验收与文档应明示。
2. **模型长上下文合规性**：多轮后模型可能弃用 create-skill 改走 skill-creator 带外写盘（首轮出现）。属模型行为风险，可考虑创建回合收紧工具集/提示词（owner 裁定，未实施）。
3. **带外技能可见性**：无本地状态条目的目录技能仍会出现在“我的技能”（既有列表行为）。
4. **密钥泄漏提示（事故记录）**：排查期间一条误写的脱敏命令把临时 copy 的两个 `api_key` 打印到会话输出（仅本机记录，未入库）；建议轮换。临时 profile 已删除。

**结论**：agent 辅助第二轮五项全部 PASS；§12.2 验收方式经 owner 2026-11-16 裁定改为 agent 真机走查。此前“上游硬阻塞、不能验收”的结论已纠正（见 §4.2 根因排查）。

### 4.1.1 复走记录（`84c80e145c` 构建，2026-11-16 晚）

环境：隔离临时 `DSH_HOME` + `--user-data-dir`（复制生产 `desktop` profile，模型 `deepseek-chat`，未打印密钥）；工作区 Electron `lib/main.js`（分支 `feat/chat-created-skills` 提交 `84c80e145c` 构建，含 Gemini 评审修复波与 `#7c`/`#7e` 停放项修复）；CDP 9333 + `HUAANWORK_ACCEPTANCE_HOOKS=1`。走查后关闭实例并删除含密钥临时 profile。证据目录（本机临时目录，未入库）：`/tmp/hw-skill-walk-final/evidence/`。

| 项 | 结果 | 证据要点 |
| --- | --- | --- |
| 1 | **PASS** | `/create-skill` → 访谈（用途/名称确认）→ `skill_propose`（批准）→ 确认卡渲染。截图 `item1-confirm-card.png` |
| 2 | **PASS** | 「继续修改」→ 修订 → 重新 propose → 新确认卡（草稿更新）；「取消」→ `已取消创建技能，没有写入技能。`，草稿作废无新技能。截图 `item2-before-revise.png`/`item2-cancel-sent.png` |
| 3 | **PASS** | 「确认创建」→ `skill_commit`（批准）→ 成功卡“已保存技能 daily-summary，请在‘我的技能’中启用”+“前往我的技能”；列表立即可见 `daily-summary`、默认未启用（「启用」按钮）。截图 `item3-success-card.png` |
| 4 | **PASS** | 禁用时 `/daily-summary …` → `skill daily-summary is disabled`；启用后按技能正文输出日报；再禁用再次拒绝。截图 `item4-disabled-invoke.png` |
| 5 | **PASS** | 技能目录仅 `SKILL.md`；`origin={kind:"created"}`、无 `publishedRevision/Digest`；`agents-endpoints.json` 未被修改；本地状态含 `creationDraftId`+`creationSessionId`（受控幂等）；无自动启用 |

**构建基线与范围说明**：本次复走构建对应提交 `84c80e145c`，包含 2026-11-16 晚全部评审修复（白名单、路由对称性、事件闸门、字段归一化等）与 `#7c`/`#7e` 停放项修复。其后 2026-11-17 的 `33f7823f6f`（闭环 Kimi-I-1/I-2/M-1）与最终代码提交 `0eb33b5ca9`（闭环 Grok-S-1 与 Minor 1–3）聚焦工具互斥卸除、终止生命周期清理与断连态按钮禁用，**未重新执行真实模型 CDP 走查**，由新增行为回归、聚焦回归套件与干净树 `corepack yarn check`（§1、§7）验证闭环。

## 4.2 根因排查记录与纠正（2026-11-16，systematic-debugging）

曾用本地转发代理抓上游请求/响应、并在 policy/present-as/execute/attach 加临时日志（后全部还原），一度判定“上游 LLM→tool-call 归一化层丢弃创建工具调用”。上游确实正常返回了 `skill_propose`/`cs_propose` 原生调用；**丢弃发生在桌面适配器的静态白名单**：提交树（`1d99d015b8` 及之前）的 `isRegisteredToolName` 未放行 `skill_propose`/`skill_commit`，SSE 与文本协议两条解析路径都会过滤掉它们——无正文回合退化为 `EMPTY_RESPONSE`，带思考回合触发重试后可能 `NO_ACTION`，混排正文则静默丢失调用。

第二轮真机走查（§4.1）之所以五项走通，是因为其工作区构建包含了 17:02 写入、当时**尚未提交**的白名单修复（`model.ts`/`model.spec.ts`，修复波已入库为 `9545c218cd`）。本节旧版“同一构建下正常执行，故不存在确定性的上游丢弃”与“产品代码与分支提交一致”的表述不准确：走查构建 ≠ 提交树；提交树在修复入库前，对话创建主链路确定性不可用。该基线错位由 2026-11-16 code review（Critical #1）指出，并经独立复核确认（时间戳：model.ts 17:02:34 / 走查记录提交 734e124022 17:20:55）。

复盘首轮“工具调用消失/EMPTY_RESPONSE”的真实诱因（多因叠加）：
- 白名单丢弃（确定性，已修复入库）；
- 创建工具被策略 ask 挂起等待“批准”，未批准时回合不产生确认卡，表象似“调用被丢”；
- 长上下文下模型合规性下降，改走 read/skill-creator/子代理带外写盘，或返回空内容（DeepSeek thinking 模式偶发）。

因此**不需要上游修复**；需要且已完成的修复是桌面适配器白名单。保留的改进项为观察 1/2（批准交互明示、创建回合模型合规加固），均属 owner 裁定范围。排查期间临时改名/日志已 `git restore` 还原。

## 5. 残余与裁定（移交 owner）

- **F5 停放**：先前已存在的同名用户技能 `create-skill` 会被内部入口遮蔽且无法启停（与 `create-agent` 先例一致）。任何迁移/重命名裁定属于 owner，本分支未处理。
- **停放（Low）**：`pendingPick` 标签不被复用为创建目标（可能多开一个普通标签，无数据风险）。
- **停放（Low）**：损坏草稿 + 凭证重放窗口下草稿仍保留（与首提交清理同一限制；显式取消现可从客户端触达）。
- **停放（Low）**：`selectSubtask` 与本次修复对称的历史面板问题属应用级导航，超出本计划范围。
- 其余 deferred minors 见 `.superpowers/sdd/2026-11-15-chat-created-skills/progress.md`（SDD 工作区，git-ignored，合入前会随工作区清理；要点已在本节汇总）。
- ~~**停放（Low，评审 Minor #7c）**~~ **已修**（owner 2026-11-16 裁定修复）：同标签出现新确认卡或成功卡时旧卡标记 consumed、按钮禁用，见提交 `cdc7dcda8f`。
- ~~**停放（Low，评审 Minor #7e）**~~ **已修**（owner 2026-11-16 裁定修复，认可「删除会话=放弃未完成草稿」语义）：`session.remove` 统一清理两类草稿文件，见提交 `84c80e145c`。
- **停放（Low，评审 Minor #7f）**：`.skill-confirm-card`/`.skill-success-card` 与 `.agent-confirm-card` 样式规则重复，可合并共用类；涉及 `styles.generated.ts` 再生成与视觉核对，留待 UI 加固波。
- **停放（Low，复审 Minor #Review-M-1，2026-11-17）**：`client-huaanwork/rpc-types.ts:591` 与 `App.tsx:1915` 的 `skill/notice` 中 `terminal:"cancelled"` 与 `sessionId` 在类型上相互独立，缺 `sessionId` 时会回落当前活跃标签；当前全仓仅 `sessions.ts` 两条取消成功路径发射且均显式携带 `sessionId`。经 **owner 2026-11-17 裁定按非阻断项停放**（见 `2026-11-16-chat-created-skills-code-review.md` §9.2），后续可收紧判别联合类型。

## 6. 仓库状态备注

- `docs/superpowers/plans/*`、`docs/superpowers/specs/*`（本计划/规格/评审/另两份计划）为未跟踪新文件；owner 2026-11-16 裁定随分支提交，与本文件同批落库。
- 工作区 `AGENTS.md` 的修改为既有未提交改动；owner 2026-11-16 裁定「如果可行也一并提交」，经内容审查后与本批文档同库。

## 7. 2026-11-16 ~ 2026-11-17 code review 复核、Kimi 终审、Grok 复审与闭环

- 评审文档：`docs/superpowers/plans/2026-11-16-chat-created-skills-code-review.md`（Gemini Double-Check 校准版 §§1–5、Qoder 复核修复 §6、Kimi 复审 §7、修复移交 §8、独立只读复审 Approve §9、Grok 审核 §10、Grok 意见闭环 §11）。
- **2026-11-16 Gemini 评审复核与修复波（`9545c218cd`..`3b41400ba4`）**：1 Critical + 4 Important + 7 Minor 的代码事实全部属实（Important #3 校准为 Minor，按建议照修）；7 个 TDD 修复提交后根 `corepack yarn check` 于 `3b41400ba4` 通过（§1 `3b41400ba4` 行：`4231 passed / 15 skipped`；完整日志 `/tmp/hw-root-check-20261116-r2.log`；首轮 typecheck 捕获 `exactOptionalPropertyTypes` 违规并在 `3b41400ba4` 修复）。评审停放项 `#7c`/`#7e` 随后经 owner 裁定同批修复入库（`cdc7dcda8f`/`84c80e145c`），`84c80e145c` 干净树复走与 `c8e044c356` 根门禁（`4236 passed / 15 skipped`）均通过；`#7f` 维持停放。
- **2026-11-17 Kimi 终审与闭环波（`e4f6c0b123` → `33f7823f6f` → `ec7ad6fc8d` → `fa22902cfb`）**：
  - Kimi 评审（`e4f6c0b123`，`dab30cd667` 树）检出 **0 Critical / 2 Important（Kimi-I-1、Kimi-I-2）/ 1 Minor（Kimi-M-1）**。
  - 修复波提交 `33f7823f6f` 闭环全部三项，并同步 `2026-11-15-chat-created-skills.md` 的 §12.2 验收口径与 `test-port-mapping.ts` 行号映射（未重跑真实模型走查）。
  - 独立只读复审（`ec7ad6fc8d`，覆盖 `e4f6c0b123..33f7823f6f`）实跑 7 个聚焦 spec（**300/300 通过**）并核验干净终树 `corepack yarn check`（**299 files passed / 4 skipped，4238 passed / 15 skipped**），给出 **Approve（0 Critical / 0 Important / 1 Minor：`Review-M-1` 经 owner 2026-11-17 裁定停放，见 §5）**；`fa22902cfb` 完成归档对齐。
- **2026-11-17 Grok 独立复审与闭环波（`0189080386` → `0eb33b5ca9`）**：
  - Grok 评审（`0189080386`，`fa22902cfb` 树）经源码反证校准给出 **可合入（Yes，0 Critical / 0 阻断性 Important）**，检出 1 条不阻断规格偏离（`Grok-S-1`：未落盘草稿切创建类型时两套创建工具同时挂载）与 3 条不阻断 Minor（确认卡在宿主不可用时静默可点、`pendingDetach` 不随会话释放清理、`task.remove`/`project.remove`/自动化删除未清创建草稿），并维持 `Review-M-1` 停放。
  - 最终代码提交 `0eb33b5ca9` 将 **Grok-S-1**、**Minor 1–3** 及 `@agent` 普通轮对称断言一并闭环，同时避免确认卡在不可用态误报「已处理」；聚焦 `typecheck` + 13 项套件 **535/535 通过**，干净代码树 `corepack yarn check` 退出码 **0**（**299 files passed | 4 skipped，4244 passed | 15 skipped**，未重跑真实模型走查）。
- §12.2 验收方式经 **owner 2026-11-16 裁定**：agent 真机走查替代真人验收，规格与计划文本已同步；五项验收结果见 §4（第二轮 + `84c80e145c` 复走全 PASS），走查构建基线已在 §4.1.1 / §4.2 如实标注。
