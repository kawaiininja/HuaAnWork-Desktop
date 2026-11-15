# 技能中心与共享技能目录设计规格及实施计划评审报告 (Review)

- **日期**：2026-11-14
- **状态**：**Grok 审核（2026-11-14 复核后）：实施计划已达可实施标准，可按 Task 1–11 开工。** 开工前把 Task 6/9 中会被测试钉死的用户文案改回规格原文，并补启用/禁用/上传成功句、来源徽标、空态导入指引、共享卡发布者/revision/更新时间与技能中心「刷新」。revision 头、下载状态判定、卡片 key、技能状态损坏连带退出不构成开工阻断。产品代码未实施。（初版 §1–§4，Qoder §5/§7，Gemini 第二轮 §6，Grok §8）
- **评审对象**：
  - 设计规格：[`docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md)
  - 实施计划：[`docs/superpowers/plans/2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md)
- **基线 Commit**：`9d5a7a0f75` (`HEAD -> master`)

---

## 1. 评审结论综述

### 1.1 总体结论

1. **设计规格（Spec）评估 — 总体完整、准确（仅 3 项细节待补充）**：
   设计规格围绕两项核心需求确立了清晰的架构边界（R1–R6），整体闭环成立：
   - 界面收敛为 `SKILL_TABS = ["center", "mine"]`（默认 `"center"`，“技能中心”与“我的技能”），彻底移除 `"all"` 与 `"external"` 标签；
   - 拆清三套只读/写投影：`CenterSkillInfo` / `LocalSkillInfo` / `InvocableSkillInfo`，不再沿用耦合的 `SkillInfo` 单表；
   - 本地持久化拆分为 `<profileDir>/skill-local-state.json`（来源 `SkillOrigin`、本地内容摘要、已发布版本与摘要、`migration.version === 1`）与 `<profileDir>/user-skill-toggles.json`（仅记录显式启用的本地技能），损坏状态采用 fail-closed；
   - 共享技能目录复用内网 `agent-catalog-server` 基建（`agents_host` / `agents_port` / `agents_catalog_token`），同时用独立的 `AGENT_CATALOG_SKILL_UPLOADERS`、桌面设置 `agents_skill_upload_token` 与请求头 `X-Skill-Expected-Revision` 隔离智能体发布权限与技能上传权限；
   - 通过独立工作区包 `@huaanwork/skill-format` 统一 `.tar.gz` 多文件归档、canonical SHA-256 摘要、安全预算（5 MiB / 256 entries / 512 B path / 拒绝符号链接与嵌套压缩），并给出完整的离线缓存（`<profileDir>/skill-catalog-cache.json`）、全量分页不截断与首次发布同摘要幂等重试机制。
   - 仍需补充澄清 3 项边界：同名内置/下载副本修改后的 `publishState` 展示与“另存为新技能”交互（P1-1）、兼容性 preset 下 `skill-filesystem` 多根扫描边界（P1-2）、以及 `SKILL.md` 的 `user-invocable` / `disable-model-invocation` 与“我的技能”启用开关衔接及双语文档门禁范围（P1-3）。

2. **实施计划（Plan）评估 — 尚未达到直接实施标准（存在 6 项 P0 阻断 + 3 项 P1 缺口）**：
   实施计划拆分为 11 个 Task，TDD 思路与测试设计较充分，**但若按当前清单直接逐任务执行，必然触发仓库结构门禁失败、桌面许可证与内联打包门禁失败、中间提交 TypeScript 编译断裂、服务端审计脱敏漏洞、路由契约断言集体报错以及 UI 状态刷新与旧文案残留**。必须先按第 2 节完成修订后再进入实施。

### 1.2 原始需求对照评估

#### 需求 1：标签页整合及移除 `全部`/`外部` 后对数据展示与筛选的影响

| 评估维度 | Spec 与 Plan 当前设计 | 评估结论 |
| --- | --- | --- |
| 标签页名称与归属 | `SKILL_TABS = ['center', 'mine']`；原“内置”→“技能中心”，原“我创建的”→“我的技能”，移除“全部”和“外部” | **准确完整** |
| 数据展示隔离 | 拆分 `skill.list` 为 `skill.centerList`（内置 + 共享目录，过滤 `INTERNAL_BUNDLED_SKILLS`）、`skill.mineList`（仅 `<profileDir>/skills` 本地技能）、`skill.invocableList`（`SYSTEM_SKILLS` + 已启用本地技能） | **准确**（但 Plan 删除 `skill.list` 时漏改多处测试消费者，见 P0-5） |
| 筛选与搜索 | 移除按来源切换的大类筛选器；两个标签页各自维护独立的页内搜索关键词（`filterCenterSkills` / `filterLocalSkills`） | **准确完整** |
| 移除“外部”的影响 | 不再自动扫描 `~/.agents/skills`，取消本地同名查找时的外部目录隐式回退；磁盘原文件保留不删，改由“我的技能 → 导入技能”显式拷贝导入 | **方向准确**（但 preset 下 `skill-filesystem` 仍扫描 `dshHome/skills` 与项目 `.agents/skills`，见 P1-2） |
| 存量迁移影响 | 首次启动（`migration.version === 1`）将既有 `<profileDir>/skills` 标记为已启用 `created`，将旧 `skill-toggles.json` 中已启用的普通 `bundled` 技能复制为本地已启用 `bundled` 副本 | **准确完整** |

#### 需求 2：技能中心下载与我的技能启用/上传双向流转规则、状态变化及边界处理

| 评估维度 | Spec 与 Plan 当前设计 | 评估结论 |
| --- | --- | --- |
| 技能中心动作与状态 | 去除普通 `bundled` 技能的“启用”按钮；新增下载动作，状态机收敛为 `downloadState`: `available`（下载）/ `downloaded`（已下载）/ `update-available`（更新）/ `local-conflict`（本地有修改）/ `not-applicable`（系统技能，无下载按钮） | **准确完整** |
| 下载规则与状态变化 | 通过 staging 目录校验名称、预算与 canonical digest 后原子落盘到 `<profileDir>/skills/<name>/SKILL.md`（含资源文件）并写 `skill-local-state.json`；**新建副本默认禁用（`enabled: false`，不写 `user-skill-toggles.json`）**；显式点“更新”覆盖未修改副本时保留原 `enabled` 状态 | **准确完整** |
| 我的技能“启用”与 `/` 调用 | 启用按钮沿用本地开关语义；仅启用态本地技能 + `SYSTEM_SKILLS` 进入 `skill.invocableList`（供 `/` 菜单加载）；关闭开关或未下载的普通内置技能由 Host `resolveInvocableSkill` 在 `/` 调用与智能体包 `allowSkills` 入口双重拒绝 | **基本完整**（`SlashSkillMenu` 空态文案/类型漏改见 P0-6；`user-invocable` 组合语义待澄清见 P1-3） |
| 我的技能“上传”与状态变化 | “上传即发布”（无审核与签名）：读取用户技能完整目录打包 `.tar.gz` 发往 `POST /v1/skills`；上传状态 `publishState`（`not-published` / `published` / `modified`）与本地 `enabled` **严格正交**；首次发布不带 `X-Skill-Expected-Revision`，更新携带已记录的 `publishedRevision` | **准确完整** |
| 并发、冲突、离线与权限边界 | 覆盖：首次同作者同摘要 `revision === 1` 重试幂等；同摘要/同版本跳过或防并发锁；非 Owner 覆盖/内置重名/revision 落后冲突；本地有修改时下载拒绝自动覆盖；未配置上传口令仅禁用上传；网络不可达回退只读缓存；上传期间继续编辑使状态停留在 `modified` | **基本完整**（内置重名冲突时 `SkillFormModal` 编辑态锁死 `name`，缺少“另存为新技能”通路见 P1-1） |

---

## 2. 缺陷分级与修复方案

### 2.1 阻断项 P0（实施前必须修正，否则门禁/编译/运行/测试必败）

#### P0-1: Task 1 新增 `@huaanwork/skill-format` 破坏仓库布局门禁、桌面打包内联与许可证门禁

- **问题描述**：
  1. **工作区数组硬编码检查**：[`scripts/verify-layout.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/scripts/verify-layout.mjs#L29-L45) 将根 `package.json` 的 `workspaces` 列表硬编码为精确的 13 项数组；仅修改根 `package.json` 与 [`dsh-plugin-huaanwork/tests/package.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/package.spec.ts#L84-L98) 会导致 `corepack yarn check:layout` 立即失败。
  2. **桌面包依赖协议限制**：[`scripts/verify-layout.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/scripts/verify-layout.mjs#L87-L102) 明确禁止 `root`、`dsh-plugin-huaanwork`、`dsh-community-fabric`、`dsh-community-market` 使用 `workspace:` / `portal:` / `link:` 协议。[`dsh-plugin-huaanwork/package.json`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/package.json#L414-L424) 对自有工作区包（`@huaanwork/agent-package-format`、`@huaanwork/catalog-signing`、`@huaanwork/policy` 等）均声明在 `devDependencies` 中且版本范围写为 `"*"`。Plan Task 1 `Files`（[`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L105)）将其泛称为“workspace dependency”，若写成 `"dependencies"` 或 `"workspace:*"` 将违反布局门禁。
  3. **桌面构建内联与打包产物守卫**：`@huaanwork/skill-format` 导出原始 `.ts` 文件（`"exports": { ".": "./src/index.ts", "./markdown": "./src/markdown.ts" }`）。桌面打包必须通过 [`dsh-plugin-huaanwork/tsdown.config.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tsdown.config.ts#L70-L74) 的 `deps.alwaysBundle` 内联进 `lib/`；否则运行时或 `verify:bundled-runtime` 门禁将失败。同时必须同步更新 [`dsh-plugin-huaanwork/scripts/huaanwork-verify-bundled-runtime.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-verify-bundled-runtime.mjs#L23-L39)（`AGENT_PACKAGE_RUNTIME_PACKAGES` 与 `BUNDLED_MARKERS`）以及 [`dsh-plugin-huaanwork/scripts/huaanwork-bundled-runtime.spec.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-bundled-runtime.spec.mjs#L17-L22)（及 `:134`、`:163`）。
  4. **许可证闭环校验缺字段与缺登记**：Plan Task 1 Step 3（[`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L160-L175)）给出的 `packages/huaanwork-skill-format/package.json` 模板缺少 `"version": "0.1.0"` 与 `"license": "MIT"`（对照 [`packages/agent-package-format/package.json`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/packages/agent-package-format/package.json#L3-L6)），也未同步登记到 [`dsh-plugin-huaanwork/scripts/verify-licenses.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/verify-licenses.mjs#L62-L66) 的 `BUNDLED_FIRST_PARTY_PACKAGES`（[`:173-L195`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/verify-licenses.mjs#L173-L195) 会严格校验第一方内联包的 `version` 与 `license`）。
- **修复方案**：
  1. `packages/huaanwork-skill-format/package.json` 补齐 `"version": "0.1.0"` 与 `"license": "MIT"`；
  2. 在 `dsh-plugin-huaanwork/package.json` 的 `devDependencies` 中添加 `"@huaanwork/skill-format": "*"`（严禁放 `dependencies` 或写 `workspace:*`）；
  3. Task 1 的 `Files`、Step 3 与 Step 5 `git add` 补齐并更新：
     - `scripts/verify-layout.mjs`（13 → 14 个 workspace 精确数组）
     - `dsh-plugin-huaanwork/tsdown.config.ts`（`alwaysBundle` 加入 `'@huaanwork/skill-format'`）
     - `dsh-plugin-huaanwork/scripts/huaanwork-verify-bundled-runtime.mjs` 与 `huaanwork-bundled-runtime.spec.mjs`（加入 `@huaanwork/skill-format` 及其 bundled marker）
     - `dsh-plugin-huaanwork/scripts/verify-licenses.mjs`（`BUNDLED_FIRST_PARTY_PACKAGES` 加入 `@huaanwork/skill-format`）。

---

#### P0-2: Task 1 / Task 5 漏配 `agent-catalog-server/package.json` 对 `@huaanwork/skill-format` 的依赖

- **问题描述**：
  [`agent-catalog-server/package.json`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/package.json#L19-L22) 的 `dependencies` 目前仅列出 `@huaanwork/agent-package-format` 与 `@huaanwork/catalog-signing`。Plan Task 4 / Task 5 在 `agent-catalog-server` 中消费 `@huaanwork/skill-format` 的 `inspectSkillArchive` 等能力，但 Task 1、Task 4、Task 5 均未列出修改 `agent-catalog-server/package.json` 与再次校验 `yarn.lock`。在严格依赖解析环境下，`agent-catalog-server` 将无法解析 `@huaanwork/skill-format`。
- **修复方案**：
  在 Task 1 Step 3（或 Task 4）中同步修改 [`agent-catalog-server/package.json`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/package.json#L19-L22)，在 `dependencies` 加入 `"@huaanwork/skill-format": "workspace:*"` 并更新 `yarn.lock`。

---

#### P0-3: Task 1 与 Task 3 存在中间提交编译/测试断裂（漏改导入方与 `routes.ts` 类型收窄冲突）

- **问题描述**：
  1. **Task 1 漏改消费者导致测试失败**：Plan Task 1 Step 3（[`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L178)）要求“HuaAnWork 四个消费者改为从 `@huaanwork/skill-format/markdown` 导入，不保留转发层”。但 Task 1 `Files`（[`:106-108`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L106-L108)）和 Step 5 `git add`（[`:219`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L219)）只修改了 3 个文件（`huaanwork-guardrails/skills.ts`、`agent-package/drafts.ts`、`agent-package/runtime.ts`），漏掉了仍在从 `skills.ts` 导入 `parseSkillMarkdown` / `serializeSkillMarkdown` 的：
     - 第 4 个生产文件：[`dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts#L6-L18)；
     - 单测文件：[`dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts#L25)（Task 1 Step 4 恰要运行该测试）。
  2. **Task 3 收窄类型未改路由层导致 `typecheck` 断裂**：Plan Task 3（[`:367, :409`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L367)）将 `skills-host.ts` 的 `SkillSourceFilter` 收窄为 `'bundled' | 'user'`，但 Task 3 `Files` 未包含 [`dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L822-L829)。`routes.ts` 第 825–828 行仍检查 `sourceParam !== 'bundled' && sourceParam !== 'user' && sourceParam !== 'external'` 并将 `sourceParam` 赋给 `let source: SkillSourceFilter | undefined`，收窄后将直接触发 TypeScript 类型错误。
- **修复方案**：
  1. Task 1 `Files` 与 Step 5 `git add` 补入 `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts` 和 `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`，与其余 3 个文件一并切换至 `@huaanwork/skill-format/markdown`（若后续迁移期仍需少量导出，应避免删除尚有消费者引用的导出后才改消费者）。
  2. Task 3 `Files` 与 Step 6 `git add` 补入 `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`（及 `tests/huaanwork-host/routes.spec.ts`），同步将 `skill.get` 的 `sourceParam` 校验收窄为 `'bundled' | 'user'`（到 Task 6 再扩展 `'catalog'`）。

---

#### P0-4: Task 4 / Task 5 中 `agent-catalog-server` 审计字段被 `sanitize` 丢弃、上传口令漏脱敏、`route.audit` 分发不完整

- **问题描述**：
  1. **技能审计字段会被 `audit.ts` 白名单剥离**：[`agent-catalog-server/src/audit.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/audit.ts#L65-L100) 中的 `AuditIntent` / `AuditEvent`、[`sanitize()`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/audit.ts#L265-L278)、[`sanitizeIntent()`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/audit.ts#L294-L307)、[`reconcile()`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/audit.ts#L313-L352) 以及 [`agent-catalog-server/src/server.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/server.ts) 的 `routeAuditContext()` 仅接受并保留 `slug`、`version`、`submissionId`、`delistRequestId`。Plan Task 5 `Files` 未修改 `agent-catalog-server/src/audit.ts`，直接实现会导致写入技能审计时 `name` / `revision` / `digest` 无法记录（或产生 TS 编译报错）。
  2. **上传者口令未接入 `secretList(config)` 脱敏列表**：[`agent-catalog-server/src/server.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/server.ts#L370-L372) 的 `secretList(config)` 仅返回 `[config.readToken, config.publishToken, config.adminToken]`（被 [`:108`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/server.ts#L108) 传入 `runtime.audit`，并在 `:404`、`:532`、`:549`、`:695` 用于响应/日志脱敏）。Plan Task 4/5 未说明把 `Object.values(config.skillUploaders)` 并入 `secretList(config)`（及 `skillAudit` 的脱敏器中），存在异常日志或错误回显泄漏新上传者 token 的风险。
  3. **`handleRequest` 中 `runtime.audit` 硬编码分流不全**：[`agent-catalog-server/src/server.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/src/server.ts#L473-L558) 的 `handleRequest` 在 pre-dispatch `403`/`405`（`:473-507`）、`unavailable`（`:514`）、`writeIntent`（`:525`）、`catch`（`:551`）与 `finish`（`:558`）多处直接引用 `runtime.audit`。Plan Task 5 仅提及“根据路由声明 `route.audit` 选择写入 `runtime.skillAudit` 或 `runtime.audit`”，未明确异常/拒签/pre-dispatch 的全路径分流规则与路由未知（`404`/`401`）的落盘归属。
- **修复方案**：
  1. 在 Task 5 `Files` 加入 `agent-catalog-server/src/audit.ts`；在 `AuditIntent` / `AuditEvent` / `sanitize` / `sanitizeIntent` / `reconcile` 与 `routeAuditContext` 中显式支持技能标识字段（`name` / `revision` / `digest`）；
  2. 将 `secretList(config)` 扩展为 `[config.readToken, config.publishToken, config.adminToken, ...Object.values(config.skillUploaders)]`，确保 `runtime.audit`、`runtime.skillAudit` 与 HTTP 异常脱敏共用完整密钥集合；
  3. 在 `handleRequest` 中统一以 `const targetAudit = route.audit === 'skill' ? runtime.skillAudit : runtime.audit` 覆盖 `403`/`405`、`unavailable`、`writeIntent`、`catch` 与 `finish` 全部路径（未匹配到 route 的 `404`/`401` 继续归入 `runtime.audit`），并补充对应单元/集成断言。

---

#### P0-5: Task 6–9 路由总数硬编码、契约必选键与 `skill.list` 遗留测试消费者未闭环

- **问题描述**：
  1. **路由总数与设置键数量硬编码冲突**：
     - [`dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts#L76-L79)（及 `:386-395`）、[`dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts#L32-L46)（及 `:117`、`:142`）、[`dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts#L103-L154) 均硬编码校验 `ROUTE_TABLE` / `ROUTES` 数量为 **`72`**；
     - [`route-contract.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts#L103-L132) 硬编码断言 `settings.get` / `settings.set` 为 `13` 个键；
     - 按 Plan Task 6 → Task 9 的提交序列，路由总数将经历 **`72 → 75 (Task 6) → 76 (Task 7) → 77 (Task 8) → 76 (Task 9)`**，设置键变为 `14`（新增 `agents_skill_upload_token`）。但 Task 6/7/8 的 `Files` 均未列出 `tests/client-huaanwork/api.spec.ts`，会导致这些任务跑测试/提交时直接失败。
  2. **`route-contract.spec.ts` 契约矩阵键集漏写**：
     [`route-contract.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts#L368-L382) 的 `verifyMethodContract` 要求同时定义 `CLIENT_REQUIRED_KEYS` 与 `SERVER_EXPECTED_KEYS` 并满足 `CLIENT_REQUIRED_KEYS == SERVER_EXPECTED_KEYS \ OPTIONAL_KEYS_WHITELIST`。但：
     - Task 6 Step 4（[`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L749)）只提到为 `skill.centerList` 加可选键 `catalogError`、`migrationWarnings`，漏写了必选键 `['skills']`；
     - Task 8 Step 4（[`:908-L911`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L908-L911)）完全未说明 `skill.upload` 对应的 `CLIENT_REQUIRED_KEYS` / `SERVER_EXPECTED_KEYS`（应为 `['skill', 'created']`）。
  3. **Task 9 删除 `skill.list` 漏改 3 个测试文件/用例**：
     - [`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts#L676-L683) 通过 `ROUTE_TABLE.find((route) => route.method === 'skill.list')` 测试 `INTERNAL_BUNDLED_SKILLS` 隐藏，Task 9 `Files` 完全未列该文件；
     - [`dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts#L328) 使用 `rpcCall('skill.list')` 测试 HTTP 405 处理；
     - [`dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts#L1486-L1490) 使用 `skill.list` 测试 `ENOTDIR` 错误传播（且 Task 9 `Files` 与 Step 6 `git add` 均未列出 `routes.spec.ts`，仅在 Step 5 运行命令中出现）。
- **修复方案**：
  1. Task 6/7/8/9 均将 `tests/client-huaanwork/api.spec.ts` 与 `tests/huaanwork-host/routes.spec.ts` 纳入 `Files` 与 `git add`，逐提交维护精确路由数量（`75 → 76 → 77 → 76`）及设置键集合（`+agents_skill_upload_token`）；
  2. 在 `route-contract.spec.ts` 中为 5 个新方法成对登记 `CLIENT_REQUIRED_KEYS`、`SERVER_EXPECTED_KEYS` 与 `OPTIONAL_KEYS_WHITELIST`：
     - `skill.centerList`: 必选 `['skills']`，可选 `['catalogError', 'migrationWarnings']`
     - `skill.mineList`: 必选 `['skills']`
     - `skill.invocableList`: 必选 `['skills']`
     - `skill.download`: 必选 `['skill', 'created', 'updated']`
     - `skill.upload`: 必选 `['skill', 'created']`
  3. Task 9 `Files` 与 `git add` 补入 `tests/huaanwork-host/agent-package-creation.spec.ts` 与 `tests/huaanwork-host/routes.spec.ts`，把 `INTERNAL_BUNDLED_SKILLS` 隐藏测试迁移到 `skill.centerList` / `skill.invocableList`，把 `api.spec.ts:328` 的 405 测试与 `routes.spec.ts:1486-1490` 的 `ENOTDIR` 测试迁移到 `skill.mineList`（及 `skill.centerList`）。

---

#### P0-6: Task 6 / Task 9 缺少设置保存后 `SkillsView` 刷新联动与 `SlashSkillMenu` 旧文案/旧类型清理

- **问题描述**：
  1. **全局设置保存后技能中心不自动刷新**：在全局设置弹窗 [`QualitySection.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/QualitySection.tsx#L82) 保存 `agents_host` / `agents_port` / `agents_catalog_token` / `agents_skill_upload_token` 后，[`App.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4259) 的 `onAgentsConfigSaved` 只自增 `agentChangeSignal`。而 [`App.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3662) 渲染 `<SkillsView />` 未传入任何 props（如 `refreshSignal`），若用户正停留在技能中心页时修改并保存服务地址或上传口令，技能中心不会自动重新拉取 `skill.centerList`。
  2. **`/` 目录实时刷新触发依赖视图切换**：[`App.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1120) 目前仅在 `[view, ready, sidecarDead]` 变化时拉取斜杠技能菜单；而在[`App.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1851-L1861) 中只有 `agent/changed` 事件监听。若后续新增 `skill/changed` 等 SSE 事件或回调来刷新 `slashCatalog`，必须注意 [`dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts#L132-L133) 通过源码字符串切片 `if (event.event === "agent/notice")` 到 `if (event.event === "agent/changed")` 做断言，任何新增分支不可插入这两段之间。
  3. **`SlashSkillMenu.tsx` 旧文案与旧类型遗漏**：Plan Task 9 `Files` 虽然列出了 [`SlashSkillMenu.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SlashSkillMenu.tsx#L10-L23)，但正文未点明具体改动：该文件第 10 行仍使用旧类型 `SkillInfo[]`，第 18 行仍写着过时的提示 **`empty="没有已启用的技能。到技能中心打开开关。"`**（与需求 2“去除技能中心启用开关，只在我的技能启用”直接矛盾），第 23 行仍调用 `sourceLabel(skill.source)`。
- **修复方案**：
  1. Task 9 在 `App.tsx:3662` 为 `<SkillsView refreshSignal={agentChangeSignal} onInvocableChanged={...} />` 接入 `refreshSignal`，使“质检/共享技能库”设置保存后立即刷新技能中心（并同时在 `SkillsView` 完成下载后/启停/删除时即时触发 `slashCatalog` 刷新）；若引入 SSE 事件处理，放置在 `agent/changed` 处理块之后，不破坏 `appWiring.spec.ts#L132-L133` 的切片定位。
  2. Task 9 Step 4 明确修改 `SlashSkillMenu.tsx`：将 `skills` prop 类型改为 `InvocableSkillInfo[]`，并将空态文案更新为 **`"没有已启用的技能。到“我的技能”打开开关。"`**。

---

### 2.2 重要项 P1（设计边界与工程门禁隐患，实施前必须明确）

#### P1-1: 与普通内置同名的本地技能及“修改名称后再上传”的 UI 通路缺失（Spec §5.3/§7.2 & Task 2/8/9）

- **问题描述**：
  1. Spec §7.2 规定：首次上传若 `name` 与当前内置技能重名，服务端/Host 必须返回 `skill-name-conflict` 并提示用户修改名称后再上传。但 [`dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx#L345-L350) 中的 `SkillFormModal` 在编辑态用 `disabled={editing}` 锁死了名称输入框。用户创建/迁移/下载了一个与普通内置同名的本地技能（`origin.kind === 'bundled'` 或 `'created'` / `'imported'`）并在本地修改后，若想上传共享，UI 上没有任何“修改名称”或“另存为新技能”的交互入口。
  2. 当一个从内置下载的副本（`origin.kind === 'bundled'`）在“我的技能”中被编辑修改内容后，其 `publishState` 仍显示 `'not-published'` 且点击上传仍必然撞 `skill-name-conflict`，需明确 UI 提示策略（禁用上传按钮并提示“与内置技能同名，请复制为新名称后再上传”，或允许点击后给出可操作的复制引导）。
- **修复方案**：
  1. 在 Spec §5.3/§9.3 与 Plan Task 9 中明确：在“我的技能”卡片菜单或编辑弹窗中补充 **“另存为新技能（复制为新名称）”** 操作（保留 `SKILL.md` 正文与资源文件并允许输入新 `name`，新副本 `origin: { kind: 'created' }`、`enabled: false`）；
  2. 明确 `origin.kind === 'bundled'` 或与内置重名的本地技能在 `SkillsView` 中的上传交互与提示文案，并补一条单测。

---

#### P1-2: 兼容性 Preset 下 `skill-filesystem` 多根扫描边界澄清（Spec §10.4 & Task 3）

- **问题描述**：
  根据 [`deepseek-harness/packages/skill/skill-filesystem/src/index.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/deepseek-harness/packages/skill/skill-filesystem/src/index.ts#L244-L264) 的 `roots()` 实现，底层 provider 除扫描 `join(this.agentsHome, 'skills')` 外，还会扫描项目工作区 `.dsh/skills`、`.agents/skills` 以及 `join(this.dshHome, 'skills')`（`user-dsh`，第 256 行）。Plan Task 3 Step 4（[`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L411-L422)）仅覆盖了三个 preset 内的 `skill-filesystem.config.agentsHome`，能阻断真实 `~/.agents/skills` 的全局注入，但并不能阻断 `<dshHome>/skills`（旧版 sidecar 遗留目录）或项目工作区内的 `.agents/skills` / `.dsh/skills`。
- **修复方案**：
  1. 在 Spec §10.4 中诚实澄清该隔离边界：`skill-filesystem.config.agentsHome` 隔离的目标是切断用户主目录 `~/.agents/skills`（即原“外部”标签来源）的全局自动注入；若后续或当前需一并控制项目级技能发现或 `<dshHome>/skills` 历史遗留，需单列说明与清理规则；
  2. 实施 Task 3 Step 4 修改 [`dsh-plugin-huaanwork/src/profile.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/profile.ts#L1545-L1680) 时，继续保持 `ptcPresentationOverride`（`assertPtcPresetPresentation`）与 `ConfigEditor` 延迟落盘不变量，不得因抽取 `huaanworkPresetOverrides` 而改变既有 `ptc` 行为。

---

#### P1-3: `SKILL.md` frontmatter `user-invocable` 与启用开关的组合语义，以及 Task 10 双语文档门禁范围

- **问题描述**：
  1. 当前 [`SkillsView.tsx`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx) 与 `SkillDetail` 均保留了 `userInvocable` 与 `disableModelInvocation` 字段，但 Task 3 的 `resolveInvocableSkill` 与 Task 6 的 `listInvocableSkills` 均只校验 `readUserSkillToggles(storageRoot)[name] === true`（或 `SYSTEM_SKILLS.has(skill.name)`），未明确当用户在表单中将 `user-invocable` 设为 `false` 而 `enabled` 为 `true` 时，该技能是否还应出现在 `/` 菜单或被 `resolveInvocableSkill` 允许调用。
  2. Task 10 Step 4 依赖 `corepack yarn check:bilingual-docs` 验证新增的 `docs/skill-center.md` / `docs/skill-center.en.md` 与修改后的 `docs/user-guide.md` / `docs/user-guide.en.md`。但 [`scripts/bilingual-docs.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/scripts/bilingual-docs.mjs#L86-L101) 只校验 `git ls-files '*.i18n.yaml'` 中登记的文档对（当前 `docs/` 根目录下仅有 [`docs/plugin-development.i18n.yaml`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/plugin-development.i18n.yaml)，`docs/user-guide.*` 与未建 `.i18n.yaml` 的 `docs/skill-center.*` 实际上不会被该命令校验）。
- **修复方案**：
  1. 在 Spec §9.2 与 Plan Task 3/6 中明确 `userInvocable === false` 与 `enabled === true` 的组合裁决（建议：若“我的技能”开关唯一控制 `/` 调用能力，明确 `userInvocable === false` 的语义边界，或在 `listInvocableSkills` / `resolveInvocableSkill` 与表单文案中对齐一致规则）；
  2. Task 10 中如需把 `docs/skill-center.md`/`.en.md` 纳入双语门禁闭环，补充生成并提交 `docs/skill-center.i18n.yaml`（并在 Plan 中注明 `docs/user-guide.*` 的历史范围）。

---

## 3. 修订后的实施任务对照表（Task 1–11 修正要点）

在更新 [`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md) 后再启动实施，各任务需补充的修正如下：

| 任务 | 原计划范围 | 必须补充的修正内容 | 对应问题 |
| --- | --- | --- | --- |
| **Task 1** | 新建 `@huaanwork/skill-format` 并迁移 Markdown 实现 | 1. 补齐 `version` + `license: MIT`；`dsh-plugin-huaanwork/package.json` 放 `devDependencies` (`"*"`)；`agent-catalog-server/package.json` 加 `"workspace:*"`<br>2. 同步改 `scripts/verify-layout.mjs`、`tsdown.config.ts`、`huaanwork-verify-bundled-runtime.mjs` / `.spec.mjs`、`verify-licenses.mjs`<br>3. `Files` 与 `git add` 补入 `skills-host.ts` 与 `tests/huaanwork-guardrails/skills.spec.ts` | P0-1, P0-2, P0-3 |
| **Task 2** | 本地状态、用户开关与一次性迁移 | 明确 `origin.kind === 'bundled'` 或与内置重名技能的状态呈现/前置校验规则 | P1-1 |
| **Task 3** | 移除外部自动发现、收敛 `resolveInvocableSkill` 与 preset | 1. `Files` 与 `git add` 补入 `routes.ts`（及 `routes.spec.ts`）收窄 `skill.get` `sourceParam`<br>2. Spec/注释澄清 `agentsHome` 隔离边界与 `userInvocable` 语义 | P0-3, P1-2, P1-3 |
| **Task 4** | 服务端技能存储、revision 与上传者配置 | 无结构缺失（为 Task 5 提供 `skillUploaders` 与审计结构配合） | — |
| **Task 5** | 服务端 `/v1/skills` 路由与独立技能审计 | `Files` 补入 `audit.ts`；扩展审计字段白名单（`name`/`revision`/`digest`）；`secretList` 纳入 `skillUploaders` tokens；`handleRequest` 全路径一致路由 `targetAudit` | P0-4 |
| **Task 6** | 桌面传输抽取、`settings`、三只读 RPC 与离线中心 | 1. 更新 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts`（路由数 `72 → 75`，设置键 `13 → 14`）<br>2. 补齐 `skill.centerList` 必选键 `['skills']`<br>3. 澄清 `listInvocableSkills` 与 `userInvocable` 语义 | P0-5, P1-3 |
| **Task 7** | 中心下载至我的技能 | 同步更新 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts`（路由数 `75 → 76`） | P0-5 |
| **Task 8** | 我的技能上传即发布 | 同步更新 `route-contract.spec.ts`（补 `skill.upload` 必选键 `['skill', 'created']`）、`routes.spec.ts`、`api.spec.ts`（路由数 `76 → 77`） | P0-5 |
| **Task 9** | 两标签 UI、`SlashSkillMenu` 切换与删 `skill.list` | 1. `Files` 与 `git add` 补入 `agent-package-creation.spec.ts`、`routes.spec.ts`，清理所有 `skill.list` 测试并维护路由数 `77 → 76`<br>2. `App.tsx` 给 `<SkillsView />` 接 `refreshSignal={agentChangeSignal}` 及即时刷新 `slashCatalog`（避开 `appWiring.spec.ts` 切片区）<br>3. `SlashSkillMenu.tsx` 改 `InvocableSkillInfo[]` 并更新空态文案为“我的技能”<br>4. 补“另存为新技能”重命名交互 | P0-5, P0-6, P1-1 |
| **Task 10** | 用户与部署文档同步 | 若将 `docs/skill-center.*` 纳入门禁，同步生成 `docs/skill-center.i18n.yaml` | P1-3 |
| **Task 11** | 全量门禁、双客户端真机验收与证据收口 | 在前述修正全部合入后，完整跑通 `typecheck` / `test` / `check`（含布局、打包、许可证与双语门禁）及真机矩阵 | P0-1 ~ P0-6 |

---

## 4. 总结

设计规格 [`docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md) 对两项改造需求的业务规则、状态流转与异常边界定义已基本完备；实施计划 [`docs/superpowers/plans/2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md) 在完成第 2 节的 **6 项 P0 工程门禁/编译/契约/联动修补**与 **3 项 P1 口径校准**后，即可达到直接实施标准。

---

## 5. Qoder 独立复核与处置（2026-11-14）

本节为对 Gemini 评审的独立复核记录。复核对照当前规格、计划与仓库代码逐条反证；规格与计划已按下列结论修订，产品代码未实施。

### 5.1 严重度校准

| 原编号 | 复核结论 | 处置 |
| --- | --- | --- |
| P0-1 | 成立，P0 | 已补共享包 version/license、桌面 devDependencies `"*"`、服务端 `workspace:*`、verify-layout、tsdown alwaysBundle、bundled runtime marker/spec、verify-licenses 第一方登记。 |
| P0-2 | 成立，P0 | 已在 Task 1 同步修改 `agent-catalog-server/package.json` 与 yarn.lock。 |
| P0-3 | 成立，P0 | 已补 Task 1 的 `skills-host.ts` 与 `tests/huaanwork-guardrails/skills.spec.ts`；Task 3 补 `routes.ts/routes.spec.ts` 收窄 sourceParam。 |
| P0-4 | 部分误报，降 P1 | “Plan 未列 audit.ts”不实，计划原已列入。审计字段按裁定复用 `slug=name`、`version=String(revision)`，不新增字段；已明确 `secretList` 纳入全部上传 token，以及 403/405/intent/catch/finish 全路径 `targetAudit` 分流。 |
| P0-5 | 成立，P0；局部夸大 | 路由数、设置键、契约矩阵和旧 `skill.list` 测试消费者真实存在。`api.spec.ts` 不在 Task 6–8 原聚焦命令中，“当时必败”夸大；现已纳入 Task 6–9 文件清单、命令和提交边界。 |
| P0-6 | 成立，降 P1 | 设置保存刷新、`/` 目录即时刷新、SlashSkillMenu 类型与空态文案已补。`appWiring.spec.ts` 切片是条件性约束，不是当前必然失败。 |
| P1-1 | 成立，P1 | 采用“另存为新技能”：新增 `skill.duplicate` 复制完整资源，新副本 created/默认禁用；内置同名上传禁用并给指引。 |
| P1-2 | 成立，降 P2 | 规格与计划已写明本轮只隔离全局 `~/.agents/skills`；项目根与 `$DSH_HOME/skills` 不在本轮范围，保持 ptc/ConfigEditor 不变量。 |
| P1-3 | 成立，P1 | `userInvocable` 已按 R7 收敛：启用即可 `/`，移除禁止手动调用选项，导入/编辑保留 frontmatter。Task 10 新增 `docs/skill-center.i18n.yaml` 纳入双语门禁，并写明 user-guide 历史未纳管范围。 |

### 5.2 Gemini 漏报

1. **漏报 P0：Task 9 类型投影替换打断 Host 读路径。** 原计划把 `SkillDetail` 定义为列表投影联合，要求 `downloadState/publishState`，但 `getSkill`、导入预览和写结果未同步。已改为独立 `SkillDetail` 读模型，并在 Task 2/9 闭合 `listUserSkills/getSkill/previewSkillImport/SkillWriteResult/InvocableSkill`。
2. **漏报 P1：创建/导入成功文案与默认禁用矛盾。** 已把“新会话即可使用”改为“已保存/已导入/已下载，请启用后使用”，并同步表单副标题。

### 5.3 四项拍板点处置

- 同名内置副本上传：新增“另存为新技能”与 `skill.duplicate`；最终路由数因删除 `skill.list`、新增 `skill.duplicate` 保持 **77**。
- preset 隔离覆盖：本轮只覆盖全局 `$DSH_AGENTS_HOME/skills`，项目级与 `$DSH_HOME/skills` 另行裁定。
- 双语门禁纳入：新增 `docs/skill-center.i18n.yaml`；`docs/user-guide.*` 历史范围写明，不顺手扩大。
- 技能审计字段：复用现有 `slug/version`，不新增 `name/revision/digest` 审计字段。

### 5.4 修订后状态

校准后问题计数：**P0 5 项、P1 5 项、P2 1 项**，均已在规格与计划中处置。修订后的实施计划仍需按 Task 1–11 执行 TDD、全量门禁和真机验收；本节不代表产品代码已实施或测试已通过。

---

## 6. Gemini 第二轮审核意见（Double Check，2026-11-14）

本节为基于修订后 [`2026-11-14-skill-center-catalog-design.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md)、[`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md) 与基线仓库代码的 **Gemini 第二轮逐行交叉核验结果**。

### 6.1 第二轮总体判定

- **设计规格（Spec）**：**已完全达到实施标准**。R7（`user-invocable` 边界）、“另存为新技能”重名避让、preset 覆盖边界、独立技能审计坐标复用以及双语门禁纳管范围均已口径一致且无结构性歧义。
- **实施计划（Plan）**：**主架构与第一轮评审（§2、§5）的绝大多数问题均已闭环，但按现有任务清单逐提交实施并在各任务跑全量测试/`typecheck` 仍差 3 处遗漏清单/用例 + 1 处脚本执行前置顺序未修补**。在 Plan 中补齐 §6.3 所列条目后，即可直接按 Task 1–11 启动实施。

### 6.2 第一轮及 Qoder 修订项的复核确认

已对照仓库源码与测试逐项核实以下修订均**有效落地且与代码事实一致**：

1. **Task 1 包拓扑与构建/许可证门禁（原 P0-1 / P0-2）**：`packages/huaanwork-skill-format/package.json` 已补 `"version": "0.1.0"` 与 `"license": "MIT"`；`dsh-plugin-huaanwork/package.json`（`devDependencies` `"*"`）、`agent-catalog-server/package.json`（`dependencies` `"workspace:*"`）、`scripts/expected-root-gate-scripts.json`、`scripts/verify-layout.mjs`、[`package.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/package.spec.ts#L84-L98)、`tsdown.config.ts`、[`huaanwork-verify-bundled-runtime.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-verify-bundled-runtime.mjs#L22-L39)、[`huaanwork-bundled-runtime.spec.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/huaanwork-bundled-runtime.spec.mjs#L17-L22) 与 [`verify-licenses.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/scripts/verify-licenses.mjs#L62-L88) 均已纳入清单（仅漏 1 个导出消费者文件，见 §6.3 #1）。另已实测 `agent-catalog-server` 可在当前 Node 环境下通过 `--experimental-strip-types` 直接解析 workspace `.ts` 依赖包，且全仓不存在服务端 Dockerfile 阻碍。
2. **Task 2 / Task 3 R7 与 Preset 隔离收敛（原 P0-3 / P1-2 / P1-3）**：Spec（`:58, :199, :384, :387, :473`）与 Plan（`:21, :354, :447, :1051, :1081`）已完全统一 `user-invocable` 语义；Spec `:412` 明确 preset 仅将 `skill-filesystem` 的 `agentsHome` 重定向至空目录 `<profileDir>/skill-provider-empty-agents-home`，经核 [`@deepseek-ai/dsh-skill-filesystem/lib/index.js`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js#L34-L77) 与 [`profile.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/profile.ts#L1651-L1667) 字段与 override 边界成立；Task 3 已纳入 `routes.ts`、`routes.spec.ts`、`agent-package-drafts.spec.ts` 与 `agent-package-runtime.spec.ts`。
3. **Task 4 / Task 5 服务端审计与脱敏（原 P0-4）**：复用 `slug=name`、`version=String(revision)`、`secretList` 纳入全部 `config.skillUploaders` token、`handleRequest` 全路径 `targetAudit` 分流及未匹配 `401/404` 归入 `runtime.audit`，与现有 [`auth-legacy.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/agent-catalog-server/tests/auth-legacy.spec.ts#L90-L127) 一致。
4. **Task 6–9 路由演进、投影拆分与 UI 联动（原 P0-5 / P0-6 / P1-1 及 §5.2 漏报）**：路由数量 `72 → 75 → 76 → 77 → 77`、设置必选键 `13 → 14`、`route-contract.spec.ts` 五个新方法契约键、[`settings-quality.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/settings-quality.spec.ts#L153-L158) 联动、`SkillDetail` 与列表投影分离、`SlashSkillMenu` 类型/文案、`App.tsx` 刷新信号及避开 [`appWiring.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts#L132-L133) 切片区间、`skill.duplicate` / “另存为新技能”均已入列（仅漏 1 个路由数测试文件与 1 处旧 `skill.list` 集成用例，见 §6.3 #2）。

### 6.3 本轮新发现的阻断与注意点清单

| 编号 | 级别 | 所属任务 | 冲突位置与仓库事实 | 影响与具体修补方案 |
| --- | --- | --- | --- | --- |
| **G2-1** | **P0** | **Task 1** | Plan（[`:195, :202`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L195-L202)）要求把 `SKILL_NAME_RE` 等移至 `markdown.ts` 且“HuaAnWork 四个消费者改为从 `@huaanwork/skill-format/markdown` 导入，**不保留转发层**”。但第 5 个生产消费者 [`skill-invoke.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts#L3) 第 3 行仍从 `../huaanwork-guardrails/skills.ts` 导入 `SKILL_NAME_RE`，未列入 Task 1 `Files` 与 `git add`（`:119-123, :240`）。 | 若按“不保留转发层”移除 [`skills.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L620) 的 `export const SKILL_NAME_RE`，Task 1 即发生 `typecheck` 断裂。<br>**修补**：在 Task 1 `Files`、Step 3 与 Step 5 `git add` 补入 `dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts`，将 `SKILL_NAME_RE` 改由 `@huaanwork/skill-format/markdown` 导入。 |
| **G2-2** | **P0** | **Task 6–9** | 1. [`market-routes.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts#L234-L237) 硬编码断言 `expect(ROUTE_TABLE).toHaveLength(72)`，Plan Task 6–9 全程未列入该文件。<br>2. [`routes.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts#L1041-L1054) 第 1046 行直接调用 `/huaanwork/skill/list` 并断言 `byName('explore').enabled === true`（`:1051`）；Task 9（[`:1089`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L1089)）仅列举了 `agent-package-creation.spec.ts`、[`api.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts#L328) 与 `routes.spec.ts:1488`（`ENOTDIR`），漏迁了此处集成用例。 | 从 Task 6 起全量 `test`/`check` 必在 `market-routes.spec.ts:236` 失败；Task 9 删除 `skill.list` 后 `routes.spec.ts:1046` 必返回 404 失败。<br>**修补**：Task 6–9 的 `Files`、测试命令与 `git add` 补入 `tests/huaanwork-host/market-routes.spec.ts` 同步更新 `75 → 76 → 77 → 77`；Task 9 第 1089 行补充迁移 `routes.spec.ts:1041-1075` 至 `skill.centerList` / `skill.mineList`。 |
| **G2-3** | **P1** | **Task 2 / 3** | 1. Task 2（[`:348`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L348)）将 `setSkillEnabled` 收敛为只接受用户技能，但 [`routes.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts#L1221-L1228) 第 11 步仍对内置 `pdf` 调用 `/huaanwork/skill/setEnabled` 并期望 HTTP `200 { ok: true }`；Task 2 未含 `routes.spec.ts`，Task 3（[`:449, :466`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L449-L466)）运行完整 `routes.spec.ts` 却只提及更新 `source` 非法值与 `external` 回退用例。<br>2. [`skills-host.spec.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts#L162-L185) 现有用例在 `:168` 传 `userInvocable: false` 且 `:183` 断言包含 `'user-invocable: false'`，与 Task 2（[`:354`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L354)）“创建不写 `user-invocable`”直接冲突。 | Task 2–3 中间提交跑完整 `routes.spec.ts` 及 Task 3 Step 5 执行命令将在 `:1226` 报错；Task 2 跑 `skills-host.spec.ts` 将在 `:183`（或 `:168`）失败。<br>**修补**：将 `routes.spec.ts` 纳入 Task 2，同步改写 `:1221-1228`（改测已存在本地技能开关并补未下载 `pdf` 拒绝断言）；在 Task 2 显式要求改写 `skills-host.spec.ts:162-185` 原断言。 |
| **G2-4** | **P2（执行注意）** | **Task 10** | [`bilingual-docs.mjs`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/scripts/bilingual-docs.mjs#L87) 使用 `git ls-files -z -- *.i18n.yaml` 扫描配对文档。Task 10 将 `check:bilingual-docs`（[`:1147`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L1147)）排在 `git add`（[`:1154`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md#L1154)）之前。 | 新建的 `docs/skill-center.i18n.yaml` 在未暂存前会被 `git ls-files` 跳过，导致 Step 4 门禁假绿。<br>**修补**：在 Step 4 运行前先执行 `git add docs/skill-center.i18n.yaml`（或 `git add -N`）。 |

### 6.4 第二轮最终准入判断

- 以上 **G2-1 ~ G2-4** 均为清单元数据/既有用例对齐问题，不涉及任何架构或规格返工；建议随手补入 [`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md) 后即刻启动 Task 1 实施。

---

## 7. Qoder 第二轮独立复核与处置（2026-11-14）

本节对 Gemini 第二轮意见（§6）逐条反证，对照当前计划与仓库代码核实。结论：**G2-2、G2-4 准确采纳；G2-3 成立但不完整；G2-1 有夸大/误报成分，改述后采纳**。另发现两处 Gemini 未列举的既有用例冲突。均已补入实施计划，产品代码未实施。

### 7.1 逐条校准

| 编号 | 复核结论 | 处置 |
| --- | --- | --- |
| G2-1 | **部分成立，夸大，降 P1** | `skill-invoke.ts:3` 确实从 `skills.ts` 导入 `SKILL_NAME_RE` 且原不在 Task 1 清单。但 `skills.ts:620` 的 `SKILL_NAME_RE` 独立于计划点名移动的 markdown 块（622–682），计划原文只移“parse/serialize/ParsedSkillMarkdown 和相关常量”，未点名移 `SKILL_NAME_RE`，**按字面实施不会断**，“Task 1 即 typecheck 断裂”是条件性推断。真实问题是 `SKILL_NAME_RE` 归属歧义（新包又定义一份）。处置：Task 1 明确 `SKILL_NAME_RE` 以共享包为唯一来源、删除 `skills.ts` 重复定义，并把 `skill-invoke.ts` 纳入 Files/Step 3/git add；`skills.ts` 内部引用与 `skills-host.ts` 一并改源。 |
| G2-2 | **完全成立，P0** | `market-routes.spec.ts:236` 硬编码 `toHaveLength(72)`，计划原全程未列该文件，属真正漏报；`routes.spec.ts:1041-1075` 的 `skill/list` 集成用例也确不在 Task 9 迁移清单。处置：Task 6–9 的 Files/命令/git add 均补 `market-routes.spec.ts`（75→76→77→77），Task 9 补迁 `routes.spec.ts:1041-1075`。口径说明：各任务聚焦命令不跑 market-routes，实际在 Task 11 全量门禁暴露，P0 定级成立。 |
| G2-3 | **成立，但不完整** | `routes.spec.ts:1221-1228` 内置 pdf 期望 200、`skills-host.spec.ts:162-185` 断言 `user-invocable: false` 均与 Task 2 冲突，属实。但漏列同文件更大两块（见 §7.2）。处置：`routes.spec.ts` 纳入 Task 2，并在 Task 2 显式列出全部需改写用例。 |
| G2-4 | **成立，P2** | `bilingual-docs.mjs:87` 用 `git ls-files` 扫描，Task 10 门禁排在 `git add` 前，新 yaml 未暂存被跳过导致假绿。处置：Task 10 Step 4 门禁前先 `git add -N` 新配对文件，并校验 recordCount/documentCount 非零增量。 |

### 7.2 Gemini 第二轮漏报

1. **`skills-host.spec.ts:397-450` 整个 `setSkillEnabled` 测试块**：`:408` 断言拒绝非内置、`:428` 用 mock registrar 启用内置 pdf 并校验 `readSkillToggles`。Task 2 改为只接受用户技能、删除 bundled registrar，整块失效。比 G2-3 列举的 `:162` 更硬。已并入 Task 2 改写清单。
2. **`skills-host.spec.ts:455 起` `restoreEnabledBundledSkills` describe 块**：Task 2 删除该函数，用例（import 于 `:14`）需整块移除/改写。已并入 Task 2 改写清单。

这两处落在 Task 2 已列的 `skills-host.spec.ts` 内，属“冲突枚举不完整”而非“整文件漏列”，实施者跑该文件时会撞上；但既然 G2-3 做精确冲突列举，应一并列全。

### 7.3 夸大 / 误报口径

- **G2-1“必然断裂”**：前提（计划要求移 `SKILL_NAME_RE`）是对计划的过度解读，属误报成分；底层清单缺口真实，保留为 P1 澄清项。
- **G2-2“从 Task 6 起全量必败”**：对全量 `test/check` 成立，但各任务聚焦命令不跑 market-routes，实际 Task 11 全量门禁才暴露；P0 定级本身没错。

### 7.4 修订后状态

第二轮校准后的 4 条意见与 2 处漏报均已补入 [`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md)：Task 1（SKILL_NAME_RE 单一来源 + skill-invoke）、Task 2（routes.spec + setEnabled/restore/userInvocable 用例改写）、Task 6–9（market-routes 计数 + routes:1041 迁移）、Task 10（双语门禁暂存顺序）。规格无需返工。本节不代表产品代码已实施或测试已通过；实施仍按 Task 1–11 执行 TDD、全量门禁与真机验收。

---

## 8. Grok 审核结论（2026-11-14，复核后）

本节是 Grok 对照当前规格 [`2026-11-14-skill-center-catalog-design.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md) 与当前计划 [`2026-11-14-skill-center-catalog.md`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-14-skill-center-catalog.md) 的审核结论。审核对象是 §7 已把 G2-1–G2-4 补入之后的计划，不是 §6 里那一版。初判曾把「还不能直接开工」说重；本节记录复核后的口径。产品代码未实施。

### 8.1 准入判断

**计划已达可实施标准，可以按 Task 1–11 开工。** §7 补入后，工作区、路由计数、`skill.list` 消费者和 `SKILL_NAME_RE` 来源不会再在编译期必红。任务拆分覆盖规格 §2 的九项目标、R1–R7、归档预算、启用门、外部技能退出、迁移、离线缓存和 §14.2 真机矩阵。

开工前只改文案和几处渲染要求，不改任务结构，也不改数据模型。这些改动落在 Task 6 与 Task 9；不改也可以开工，但按计划里的测试原文实施，会把与规格不一致的句子钉进产品。

### 8.2 夸大后降级，不挡开工

| 编号 | 初判 | 复核 | 依据 |
| --- | --- | --- | --- |
| K-1 | 更新上传的 expected revision 与规格相反，必须先改规格 | **夸大。** 计划把容易读歪的半句收紧了，与冲突规则一致 | 规格 §9.3 写「带服务器最新 revision」。§7.2 的判定是送来的值不是当前最新就 409 `skill-revision-conflict`。§12 要求用该值防止两个客户端互相覆盖。计划 Task 8 写带本地 `publishedRevision`，不要先向服务器要最新值再原样送回。先取服务器最新再上传，才会盖掉对方刚发布的内容。计划不需要改。若要消除字面差，把规格 §9.3 那半句改成「带本地已记录的 publishedRevision」 |
| K-2 | 五个下载状态没有写进任务，投影算错也能通过 | **定级夸大。** 行为已有定义，缺的是钉死投影的测试 | 条件在规格 §5.2。计划 Task 7 写了同来源同摘要幂等、同来源旧 revision 且未改才允许更新、其余同名拒绝覆盖。Task 6 要求 `listSkillCenter` 算出 `available/downloaded/update-available/local-conflict/not-applicable`。Task 6 的示例测试只断言 `catalogError` 与来源存在，不断言这五个值。按示例测试，投影算错也能通过。这是测试缺口 |
| K-3 | 卡片 key 若只按名称，同名内置卡与共享卡会叠成一张 | **接近错报。** 计划没有要求改错 key | 规格 §5.1 要求 key 含来源或稳定身份。现有 `SkillsView` 已是 `` `${skill.source}:${skill.name}` ``。计划没有把它改成只按名称。Task 9「busy key 为 `source:name`」指操作忙闲键，不是 React key。重写时可能把现有 key 弄丢，计划本身没有写错 |
| K-4 | 技能状态损坏时「拒绝启动」与规格「拒绝技能服务」冲突，必须先裁定 | **定级夸大。** 事实成立，不挡开工 | 规格 §11.2 要求拒绝服务、给出可诊断错误，不得把损坏文件清空后当空目录。计划 Task 4 写「状态损坏拒绝启动」，与现有 `agent-catalog-server` 一致：`createAgentCatalogRuntime` 里 store 打不开，`index.ts` 对 `StoreCorruptError` 以退出码 1 结束。若把 `SkillStore.open` 放进同一次启动，损坏的技能状态会让智能体目录一起起不来。这是连带后果，补一句确认即可 |

### 8.3 成立，开工前改 Task 6 / Task 9

这些对照原文仍然成立。都是改句子或补渲染要求。

| 编号 | 级别 | 规格 | 计划现状 | 补法 |
| --- | --- | --- | --- | --- |
| G-1 | 开工前改测试原文 | §5.4：`共享技能库不可用，当前显示内置技能与已缓存内容` | Task 6 断言 `共享技能库不可达，请稍后重试` | 把该断言改成规格原文。按现有 TDD 步骤会把错句钉进实现 |
| G-2 | 开工前改文案 | §5.4：创建/导入/下载成功为「请在『我的技能』中启用」 | Task 9 统一写成「请启用后使用」 | 改回规格原文。下载发生在技能中心，短句少了去哪一页启用 |
| G-3 | 开工前改文案 | §5.2：系统技能显示「系统技能·始终启用」，不提供下载 | `centerActionLabel('not-applicable')` 钉成「系统技能」；「不提供下载」已写入 Task 9 覆盖清单 | 状态文案改回「系统技能·始终启用」，并保持不提供下载 |
| G-4 | 开工前补渲染 | §5.2：共享条目显示发布者、revision 和更新时间 | `CenterSkillInfo` 已有 `publisher`、`revision`、`updatedAt`；Task 9 渲染步骤未要求画出 | 在 Task 9 写明共享卡展示这三项 |
| G-5 | 开工前补入口 | §5.1：技能中心显示搜索、刷新和中心卡片 | Task 9 写了保存设置和操作成功后重拉，没有页面上的「刷新」 | 补技能中心「刷新」动作，重拉 `skill.centerList` |

### 8.4 首轮未写入、复核补上

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| M-1 | 启用、禁用的现文案是「新会话生效」（`SkillsView.tsx`）。规格 §5.4 要求「已启用技能 \<name\>，可在对话框输入 / 调用」和「已禁用技能 \<name\>」。计划只禁止「新会话即可使用」，挡不住「新会话生效」。上传成功句「已发布技能 \<name\>（revision \<n\>）」也没有任务承接 | 规格 §5.4；`dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx` 现有 `setNote` |
| M-2 | 来源徽标规格写明「创建、导入、内置副本、共享副本」。计划只给了 `originLabel` 函数名 | 规格 §5.3；计划 Task 9 |
| M-3 | 我的技能无条目且无搜索词时，保留创建入口，并增加导入指引。计划只写了「空态文案」 | 规格 §5.4；计划 Task 9 |
| M-4 | 发布者 id 正则 `^[a-z0-9][a-z0-9._-]{0,63}$` 没有贴进 Task 4。与列表 `limit` 默认 100、合法范围 1–100 同一类：规格 §7.1 / §7.3 已写明，计划未复述，实施时对着规格写 | 规格 §7.1、§7.3 |
| M-5 | 归档落盘要临时文件、fsync、rename；上传者 token 要先 SHA-256 再 `timingSafeEqual`，全部 token 比完再判定。计划没点名，仓库已有样本，不是空白设计 | 规格 §6.3、§7.3；`agent-catalog-server/src/store.ts` 的 `writeState`；`agent-catalog-server/src/auth.ts` 的 `tokenMatches` |

### 8.5 复核后的处置

不改任务拆分，不改类型。建议在开工前把下表写入计划对应任务；规格仅在要消除 K-1 的字面差时改 §9.3 半句。

| 落点 | 写入内容 |
| --- | --- |
| Task 6 | `catalogError` 使用规格 §5.4 原文；可选补一条 `listSkillCenter` 对五个 `downloadState` 的判定测试（K-2） |
| Task 9 | 成功/启用/禁用/上传文案改用 §5.4 原文；系统技能状态文案改用 §5.2；画出发布者、revision、更新时间；增加「刷新」；`originLabel` 钉死四个徽标；空态保留创建入口并给出导入指引；重写卡片时保留 `source:name` key |
| Task 4 | 贴上发布者 id 正则；损坏状态沿用 fail-closed，并写明若在 `createAgentCatalogRuntime` 中打开失败，进程退出码 1，智能体目录一并不可用 |
| 规格 §9.3 | 仅当需要消除字面差时，把「带服务器最新 revision」改为「带本地已记录的 publishedRevision」 |

本节不代表产品代码已实施或测试已通过。

---

## 9. Qoder 对 Grok 的独立复核与处置（2026-11-14）

本节对 Grok 审核结论（§8，已是 Grok 自我复核降级后的口径）逐条对照规格、计划原文与现有代码核实。结论：**Grok 意见基本全部成立，无误报，定级克制；均为低严重度的文案/渲染/测试一致性项，不动任务结构与数据模型。** 已全部采纳并写入规格与计划，产品代码未实施。

### 9.1 逐条核实

| 编号 | 复核结论 | 处置 |
| --- | --- | --- |
| K-1 | **真实歧义，采纳（非可选）** | 规格 §9.3 原写“更新上传带服务器最新 revision”，与计划 Task 8“带本地 publishedRevision”语义相反。计划正确（乐观并发），规格措辞误导。已把规格 §9.3 改为“带本地已记录的 publishedRevision，不得先取服务器最新再原样送回”。 |
| K-2 | **真实测试缺口，采纳** | Task 6 示例测试原只断言 catalogError 与来源存在，未钉五个 downloadState。已补 `listSkillCenter` 投影判定测试，逐一断言 available/downloaded/update-available/local-conflict/not-applicable。 |
| K-3 | **Grok 已正确撤回** | 现有卡片 key 即 `source:name`，计划未要求改成只按名，属接近错报。已在 Task 9 补“重写卡片保留复合 key，不得退化为只按名称”的防御性要求。 |
| K-4 | **事实成立，采纳** | `SkillStore.open` 与智能体 store 同在 `createAgentCatalogRuntime` 打开，技能状态损坏会连带进程退出码 1、智能体目录一并不可用。已在规格 §11.2 与计划 Task 4 写明该连带后果属预期 fail-closed，不做技能单独降级。 |
| G-1 | **属实，采纳** | Task 6 断言原为“共享技能库不可达，请稍后重试”，与规格 §5.4 不一致，TDD 会钉错句。已改为规格原文“共享技能库不可用，当前显示内置技能与已缓存内容”。 |
| G-2 | **属实，采纳** | 计划原写“请启用后使用”，规格为“请在“我的技能”中启用”。已改回规格原文（含引号逐字一致）。 |
| G-3 | **属实，采纳** | `centerActionLabel('not-applicable')` 原钉“系统技能”，规格为“系统技能·始终启用”。已改。 |
| G-4 | **属实，采纳** | `CenterSkillInfo` 有 publisher/revision/updatedAt，Task 9 原未要求渲染。已补共享卡展示三项。 |
| G-5 | **属实，采纳** | 规格 §5.1 要求中心有“刷新”，Task 9 原只有自动重拉。已补页面“刷新”动作重拉 `skill.centerList`。 |
| M-1 | **属实，采纳（最有价值）** | 现有 `SkillsView.tsx:121` 启停文案为“新会话生效”，计划原只禁“新会话即可使用”，挡不住此句；上传成功句也无任务承接。已把启用/禁用/上传文案全部改用规格 §5.4 原文，并明确替换“新会话生效”。 |
| M-2 | **属实，采纳** | `originLabel` 原只给函数名。已钉死四个徽标“创建/导入/内置副本/共享副本”。 |
| M-3 | **属实，采纳** | 我的技能空态原只写“空态文案”。已补“保留创建入口并增加导入指引”。 |
| M-4 | **属实，采纳** | 发布者 id 正则与 limit 规格已有、计划未复述。已把正则 `^[a-z0-9][a-z0-9._-]{0,63}$`、token ≥32 字符、limit 默认 100/范围 1–100 贴进 Task 4。 |
| M-5 | **属实，采纳** | 归档落盘与 token 比较仓库有样本。已在 Task 4 点名 `store.ts writeState` 的临时文件→fsync→rename、`auth.ts tokenMatches` 的先 SHA-256 再 timingSafeEqual、全部 token 比完再判定。 |

### 9.2 夸大 / 漏报判断

- **夸大**：Grok 这版没有。它已把初判“还不能开工”收回，K-3 自认接近错报，口径诚实。
- **漏报**：未发现 Grok 这版漏掉硬伤；前两轮 Gemini 的编译/路由/测试块问题已在 §7 闭环，Grok 聚焦文案层是恰当的。
- **唯一强调**：K-1 不按 Grok 的“可选”处理，规格与计划语义相反，已直接改规格消除歧义。

### 9.3 修订后状态

Grok 的 G-1～G-5、M-1～M-5 与 K-1/K-2/K-4 均已写入：规格 §9.3（expectedRevision）、§11.2（损坏连带后果）；计划 Task 6（catalogError 原文 + downloadState 投影测试）、Task 9（全部反馈文案/系统技能状态/共享卡渲染/刷新/originLabel 四徽标/空态/复合 key）、Task 4（发布者正则/limit/token 比较样本/损坏后果/归档 fsync）。不改任务拆分、不改类型。本节不代表产品代码已实施或测试已通过；实施仍按 Task 1–11 执行 TDD、全量门禁与真机验收。
