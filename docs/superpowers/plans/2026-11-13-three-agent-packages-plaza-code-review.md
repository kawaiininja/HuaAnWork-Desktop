# 《三个智能体包与广场接入》代码评审意见与修正建议（Code Review）

- **评审对象**：`feat/three-agent-packages-plaza` 分支相对 `master` 的完整实现
  - 基线 `4677899f1cebf9ddf27508baf46559b051086dec`（`merge-base master HEAD`）→ 头部 `4236b19626f8b096ea6cc904c4c484ea19ab3a28`
  - 区间规模：45 提交，41 文件，+6340 / -65 行；`deepseek-harness/` 子模块零修改（`git diff master..HEAD -- deepseek-harness` 为空）
- **对照基准**：
  - 设计规格：[`2026-11-11-three-agent-packages-plaza-design.md`](../specs/2026-11-11-three-agent-packages-plaza-design.md)（R1–R11、§3–§9）
  - 实施计划：[`2026-11-11-three-agent-packages-plaza.md`](./2026-11-11-three-agent-packages-plaza.md)（Global Constraints、Task 0–14）
  - 计划评审：[`2026-11-11-three-agent-packages-plaza-plan-review.md`](./2026-11-11-three-agent-packages-plaza-plan-review.md)
  - 安全加固计划：[`2026-11-13-agent-package-hardening.md`](./2026-11-13-agent-package-hardening.md)
  - 验收与演进证据：[`2026-11-11-three-agent-packages.md`](../../evidence/2026-11-11-three-agent-packages.md)
  - 生产上架指引：[`huaanwork-three-agent-packages-release.md`](../../huaanwork-three-agent-packages-release.md)
- **评审日期**：2026-11-13
- **评审方式**：只读核对源码、测试、验收脚本与规格/计划/证据文档，并在工作树执行非破坏性只读校验；未修改任何源码、测试或既有文档（本文件为唯一新增文档）。
- **评审结论**：**With fixes（带小幅修复后可合并）。0 Critical / 1 Important / 4 Minor。**
  - 核心 C1–C5 血缘收窄安全单元、R8 产品默认 `maxDepth: 2`（含 I3 字段级默认与 editor 校验门控）、N-3 延迟清理与 C4/C2 fail-closed 加固均已完整落地且未改上游子模块；产品运行时不存在阻断性安全漏洞。
- **qwen4 复审（2026-11-13）**：经独立反证与严重度校准，判决为 **0 Critical / 0 Important（Important #1 降为已登记债跟进）/ 4 Minor**，分支本身可合并；原评审全部事实断言核实属实，但 Important #1 定级过高、其修正建议存在编译层内部矛盾，Minor #2 处方有技术错误。逐条证据与需 owner 拍板项见 §6。

---

## 1. 实施亮点与规格/计划对齐（Strengths & Compliance）

| 对齐维度 | 核验结论 | 代码与文档锚点 |
| --- | --- | --- |
| C1 允许名单加 `subagent` | `composeAgentPackageToolAllowList` 在基础集 `['read', 'read_file', 'glob', 'grep', SHELL, 'subagent']` 统一纳入 `'subagent'`，并按条件追加 `agent_skill_run`、`agent_http`、`mcpNames` | [`runtime.ts:168-188`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts#L168-L188) |
| C2/C3 血缘持有者、引用清理与 N-3 延迟释放 | `holders.ts` 声明并初始化 `huaanworkPackageChildAllow`；`host.ts` 入口校验必填 holder（`:526-528`），在两次 `bindChild` 前将 `turnAllow` 赋为 `allow` 同引用（`:1046-1048`）；`clearTurnLineage` 按 `bound === turnAllow` 引用同一性清理（`:774-781`），消除 `childId` 复用误清；非取消场景在 `activation.result` 结算前延迟清理（`:819-823`、`:1115-1131`），`cancelRequested = true` 恒先于 `controller.abort`（`:947`、`:963`） | [`holders.ts:50,85,172`](../../../dsh-plugin-huaanwork/src/huaanwork-host/holders.ts#L50)、[`host.ts:79,526-528,774-824,1046-1048,1115-1131`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L774-L824) |
| C4 孙代/曾孙代收窄与传递绑定 | `skills.ts` 同步包装 `start`（`:293-391`）与 `startActivation`（`:397-536`）并保留 `subagent/start`、`subagent/end`；`childSessionId` 不可解析时先 `await run?.dispose?.()` 再 fail-closed 抛 `"subagent lineage child id missing"`；`startActivation` 用 `inherited.filter((name) => existing.includes(name))` 收窄后交 `tools.restrict`，避免上游 [`core/tools/src/index.ts:1125`](../../../deepseek-harness/packages/core/tools/src/index.ts#L1125) 因已剥离 `mcp__*`/`agent_http` 报 `unknown global tool`；包请求分支优先于血缘继承分支，保证跨包隔离 | [`skills.ts:226-275,293-391,397-536`](../../../dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts#L293-L536) |
| C5 执行期强制兜底 | `policy.ts` 在 `tools/pre-execute`（`:108-111`）与 `tools.guard`（`:129-132`）双缝查 `ctx.huaanworkPackageChildAllow`，不在继承列表即返回 deny | [`policy.ts:108-111,129-132`](../../../dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts#L108-L132) |
| R8 `maxDepth: 2` 产品默认与 I3 字段级合并 | `profile.ts` 注入 `DESKTOP_SUBAGENT_MAX_DEPTH = 2`（`:1540`）并启用 `{ id: 'tool-subagent', disabled: false }`（`:1600`，`row-assertions.ts:29` 同步断言）；组合后在 `hooks.profilePatches === undefined` 门控下按字段补齐缺失的 `maxDepth: 2`（`:1666-1672`），保留用户同族字段且不破坏 `ConfigEditor` 校验 | [`profile.ts:1540,1600,1666-1672`](../../../dsh-plugin-huaanwork/src/profile.ts#L1540)、[`row-assertions.ts:29`](../../../dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts#L29) |
| 三包源文件与流程交付 | `typo-check` / `code-review` / `task-orch` 均按 `tools.mode: "none"` 与 `allowSkills: []` 内联规则落盘；Task 8–14 播种脚本、离线签名广场验证、CDP 真机走查及降级检测模块、原目录备份与 R7 延后删除登记、R6 上架 runbook 指引均已齐全 | [`dsh-plugin-huaanwork/agent-packages/`](../../../dsh-plugin-huaanwork/agent-packages/)、[`2026-11-11-three-agent-packages.md`](../../evidence/2026-11-11-three-agent-packages.md) |

---

## 2. 问题清单与修正建议（Issues & Recommendations）

### Critical

- **无**。

### Important

#### Important #1｜`@slug` 派发接缝存在编译期类型空洞，且两个既有 `.mjs` 验收脚本缺新必填 holder 会入口 fail-closed 拒跑

- **位置**：
  - [`agent-invoke.ts:40-74`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts#L40-L74)（`AgentInvokeContext`、`AgentPackageRuntimeFace`）
  - [`sessions.ts:63-98, 289-301`](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L63-L98)（`SessionRuntimeContext`、`dispatchAt`）
  - [`host.ts:79, 259, 526-528`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L79)（`AgentPackageDispatchContext`、`AgentPackageHost.dispatch`）
  - [`huaanwork-agent-package-m2-acceptance.mjs:550-566`](../../../dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs#L550-L566)（`dispatchHttpTurn` `ctx`）
  - [`huaanwork-agent-package-windows-acceptance.mjs:384-408`](../../../dsh-plugin-huaanwork/scripts/huaanwork-agent-package-windows-acceptance.mjs#L384-L408)（`dispatch` `ctx`）
- **问题说明**：
  1. [`AgentPackageDispatchContext`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L79) 已将 `huaanworkPackageChildAllow: Map<string, readonly string[]>` 设为必填并在入口 `:526-528` fail-closed 断言，但上层接缝 [`AgentInvokeContext`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts#L40-L56) 与 [`SessionRuntimeContext`](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L63-L98) 均未声明该属性（仅依赖启动期 `holders.ts` 动态写入）。更关键的是，[`AgentPackageRuntimeFace.dispatch`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts#L65) 与 [`AgentPackageHost.dispatch`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L259) 使用 TypeScript **方法简写（method syntax）**，其参数在严格模式下呈双向协变（bivariant），导致 [`sessions.ts:289-301`](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L289-L301) 将 `packageHost` 传给 `packageRuntime` 时跳过 `ctx` 字段完整性检查，`typecheck` 无法拦下遗漏 holder 的接线回归。（[`AGENTS.md:93`](../../../AGENTS.md#L93) 已登记 `AgentInvokeContext/Face` 缺类型，未指出 `SessionRuntimeContext` 与方法简写双向协变根因。）
  2. 两个不受 TS 检查的既有 `.mjs` 验收脚本——`huaanwork-agent-package-m2-acceptance.mjs` 与 `huaanwork-agent-package-windows-acceptance.mjs`（[`AGENTS.md:95`](../../../AGENTS.md#L95) 已登记）均未注入 `huaanworkPackageChildAllow`（连同既有缺口 `huaanworkSubagentRuns`），直接运行将在 [`host.ts:523-528`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L523-L528) 入口抛错失败。
- **影响**：正式应用因 [`holders.ts:172`](../../../dsh-plugin-huaanwork/src/huaanwork-host/holders.ts#L172) 装配全量 holder 不受影响；但后续重构 `sessions.ts` 失去编译期静态约束，且 M2 / Windows 回归验收脚本在补全 holder 前无法运行。
- **修正建议**：
  1. 在 [`AgentInvokeContext`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts#L40-L56) 与 [`SessionRuntimeContext`](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L63-L98) 中补全 `huaanworkPackageChildAllow?: Map<string, readonly string[]>`（条件允许时收敛为必填以与 `AgentPackageDispatchContext` 对齐）。
  2. 将 [`AgentPackageRuntimeFace.dispatch`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts#L65) 与 [`AgentPackageHost.dispatch`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L259) 改为函数属性签名：
     `dispatch: (input: ...) => Promise<AgentPackageDispatchResult>`，消除参数双向协变。
  3. 同步在 [`huaanwork-agent-package-m2-acceptance.mjs`](../../../dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs#L550-L566) 与 [`huaanwork-agent-package-windows-acceptance.mjs`](../../../dsh-plugin-huaanwork/scripts/huaanwork-agent-package-windows-acceptance.mjs#L384-L408) 的 `ctx` 夹具中注入 `huaanworkSubagentRuns` 与 `huaanworkPackageChildAllow: new Map()`（或明确纳入后续回归补丁）。

---

### Minor

#### Minor #1｜发布手册 [`docs/huaanwork-three-agent-packages-release.md:16`](../../huaanwork-three-agent-packages-release.md#L16) 残留加固波次前的过时 I3 债务表述

- **位置**：[`docs/huaanwork-three-agent-packages-release.md:16`](../../huaanwork-three-agent-packages-release.md#L16)
- **问题说明**：第 16 行仍写着「用户先存过同族字段（如 maxActiveSubagents）再清除/重置 maxDepth，落盘行整条替换 ⇒ 有效值回落 schema 默认 1（证据文档 §0.3 C 登记债，产品侧无提示）」。而安全加固波次 Task 5 已在 [`profile.ts:1666-1672`](../../../dsh-plugin-huaanwork/src/profile.ts#L1666-L1672) 实施字段级补齐产品默认 `2`，[`AGENTS.md:91`](../../../AGENTS.md#L91) 亦将现状收敛为仅在未重新组合前的瞬态内存窗口暂时为 `1`。
- **影响**：运维/发布人员按 runbook 排查设置清空表现时，会得到与现行代码不符的过期结论。
- **修正建议**：将第 16 行改为：
  > 已知边界：用户先存过同族字段（如 `maxActiveSubagents`）再通过设置面板清除/重置 `maxDepth` 后，仅在尚未触发下次配置重组的**瞬态内存窗口**内有效值暂时为 1（fail-closed）；待下次加载 / HMR / 包操作重新组合配置后即恢复产品默认 `2`（见 `AGENTS.md` 与证据文档「安全加固波次」I3 说明，真机瞬态行为待集成环境验证）。

#### Minor #2｜[`typo-check/skill/SKILL.md:54,64`](../../../dsh-plugin-huaanwork/agent-packages/typo-check/skill/SKILL.md#L54) 的报告输出指令存在跨平台与自约束张力

- **位置**：[`dsh-plugin-huaanwork/agent-packages/typo-check/skill/SKILL.md:54`](../../../dsh-plugin-huaanwork/agent-packages/typo-check/skill/SKILL.md#L54) 与 [`L64`](../../../dsh-plugin-huaanwork/agent-packages/typo-check/skill/SKILL.md#L64)
- **问题说明**：
  1. 第 64 行规定「对话输出为主；用户要求时用 bash 写报告文件」，未区分 Windows 环境（[`decideShell`](../../../packages/huaanwork-policy/src/decide.ts#L195-L223) 在 `win32` 平台仅允许 `pwsh`、直接拒绝 `bash`）。
  2. 第 54 行要求「每次只发**单条简单命令**——不用 `&&`、管道、重定向」，而该包在 `tools.mode: "none"` 下不具备 `write` 文件工具，若按第 64 行写报告文件又不准用重定向，模型执行口径会产生冲突（实际 [`classifyShell`](../../../packages/huaanwork-policy/src/shell.ts#L40) 当前拦截 `/[\|&;`$]/` 与 `.git` 重定向，并未将普通单文件 `>` 判为元字符拒绝，但显式脚本参数更稳妥）。
- **修正建议**：将第 64 行改写为平台无关且无歧义的单命令写法：
  > 对话输出为主；用户明确要求落盘报告文件时，按当前系统允许的 shell（macOS/Linux 用 `bash`，Windows 用 `pwsh`）执行单条简单命令（例如通过 `python3 -c` / `pwsh` 显式写文件，不使用 `&&`、管道或复合元字符）将报告写入工作区内目标路径。

#### Minor #3｜[`host.ts:751-765`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L751-L765) `bindChild` 的 `turnAllow` 守卫位于集合写操作之后

- **位置**：[`host.ts:751-765`](../../../dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L751-L765)
- **问题说明**：`bindChild` 先执行 `ctx.huaanworkPackageChildSessions?.add(childSessionId)` 与 `packageChildSessions.add(childSessionId)`（`:754-755`），之后才判定 `if (turnAllow === undefined) { throw new Error('智能体包回合 allow 未就绪即绑定子会话') }`（`:758`）。虽然当前两处调用前均已有 `turnAllow = allow`（`:1048`），运行时不可达，但前置不变式检查应先于任何状态修改。
- **修正建议**：将 `:758` 的 `if (turnAllow === undefined)` 检查上移至 `:754` 之前，确保异常分支保持原子无副作用。

#### Minor #4｜[`profile.ts:1652-1672`](../../../dsh-plugin-huaanwork/src/profile.ts#L1652-L1672) 组合后 `patches.push` 与注释行号锚点维护性偏弱

- **位置**：[`profile.ts:1652-1672`](../../../dsh-plugin-huaanwork/src/profile.ts#L1652-L1672)
- **问题说明**：
  1. `:1670` 在 `composedRows` 与局部 `rows` 映射（`:1652-1658`）构造完毕后才向 `patches` 追加 `{ id: 'subagent', config: { ...subagentConfig, maxDepth: DESKTOP_SUBAGENT_MAX_DEPTH } }`，导致 `rows.get('subagent')` 保持补丁前对象。当前 `:1672` 之后无代码再读 `rows.get('subagent')`，尚无运行时影响，但后续维护容易踩坑。
  2. `:1664` 的注释引 `dsh-config-editor:122` 为编译产物行号，与上游源码 [`deepseek-harness/packages/boot/config-editor/src/index.ts:138-140`](../../../deepseek-harness/packages/boot/config-editor/src/index.ts#L138-L140) 行号不一致。
- **修正建议**：若后续在 `:1672` 后消费 `rows`，建议同步更新 `rows` 或把字段默认合并放到 `rows` 汇总前；并将 `:1664` 注释改为引用符号/语义（如 `ConfigEditor` schema validation）而非 `.js` 行号。

---

## 3. 既定残余与风险账目核对（Tracked Residuals）

经核对 [`AGENTS.md:91-95`](../../../AGENTS.md#L91-L95) 与 [`2026-11-11-three-agent-packages.md`](../../evidence/2026-11-11-three-agent-packages.md#L872-L879)，以下既定取舍与边缘残余已如实登记且口径与代码一致：
- **N-3 永久卡死子会话**：`activation.result` 永不结算时血缘条目常驻至 Host 退出，数量受真实存活子会话上限约束，安全方向优先。
- **N-3 `cancel + dispose-timeout` 边缘角**：保留取消回合按既有契约立即清绑定。
- **I3 瞬态窗口**：`ConfigEditor` 清除同族行中的 `maxDepth` 到下次重组前有效值暂时为 `1`（fail-closed，`BLOCKED` 待集成环境验证）。
- **M6 dormant 表征**：上游 `Session.id` getter 与 `Agents.enter` 强制写读 `id` 恒等，特性化测试在位。
- **除 Minor #1（`release.md:16` 未随波次刷新）与 Minor #2（`SKILL.md:64`）外，未发现新的未登记安全隐患。**

---

## 4. 验证范围与未闭环边界（Verification Scope）

### 4.1 本次评审实跑的只读校验（执行于 `HEAD = 4236b19626f8b096ea6cc904c4c484ea19ab3a28`）

| 命令 | 退出码 | 实测结果摘要 |
| --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **0** | 通过 |
| `corepack yarn workspace @huaanwork/policy check` | **0** | `tests 64, pass 62, fail 0, skipped 2`（2 项跳过为 macOS 下 Windows `.GIT` / 盘符用例） |
| `BASE_SHA="$(git merge-base master HEAD)" node scripts/check-whitespace.mjs` | **0** | 无行尾空白或缺失换行问题 |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run`（13 个本次新增/修改 `.spec.ts`） | **0** | `Test Files 13 passed (13)`，`Tests 293 passed \| 1 skipped (294)`（唯一 skipped 为 [`typo-check-pwsh-extract.spec.ts`](../../../dsh-plugin-huaanwork/tests/huaanwork-host/typo-check-pwsh-extract.spec.ts) 因 macOS 无 `pwsh` 跳过） |

### 4.2 本轮未重跑项与跨环境边界

- 本次只读评审会话**未重跑**全量 `corepack yarn test`、`corepack yarn check`、`verify:aa` 以及实机 CDP 走查（提交 `01a402cbbd` 在文档收敛前的全量门禁结果已记录于 [`2026-11-11-three-agent-packages.md:852-860`](../../evidence/2026-11-11-three-agent-packages.md#L852-L860)）。
- **受环境阻塞的待补验项**（合并前后需在对应环境闭环）：
  1. Windows CI（如 `check:win-package:platform`）上实跑 `typo-check-pwsh-extract.spec.ts`，确认 `pwsh -EncodedCommand` 提取用例由 skipped 转为 PASS。
  2. 在真实桌面宿主 / `ConfigEditor` 集成环境补充 I3 清除 `maxDepth` 后的瞬态行为核验（当前 `BLOCKED`）。

---

## 5. 合并判决与执行顺序（Assessment & Next Steps）

- **Ready to merge?**：**With fixes（完成小幅修复与全量门禁复跑后可合并）**
- **推荐收尾顺序**：
  1. 先修复 Important #1（至少补齐 `AgentInvokeContext` / `SessionRuntimeContext` / `AgentPackageRuntimeFace` 强类型与函数签名，以及 M2/Windows 两个验收脚本的 holder 注入，或经 owner 明确排期延后验收脚本）。
  2. 合入 Minor #1–#4 的文档与防御式编码微调（其中 [`docs/huaanwork-three-agent-packages-release.md:16`](../../huaanwork-three-agent-packages-release.md#L16) 与 [`typo-check/skill/SKILL.md:64`](../../../dsh-plugin-huaanwork/agent-packages/typo-check/skill/SKILL.md#L64) 建议本分支随手清掉）。
  3. 最后在最终代码树上重跑 `corepack yarn typecheck`、`corepack yarn test`、`corepack yarn check` 与 `node scripts/check-whitespace.mjs`，确认全部退出码为 0 后合入 `master`。

---

## 6. qwen4 复审结论（2026-11-13，独立反证与严重度校准）

- **复审方式**：对 worktree 源码（`HEAD = 4236b19626`）逐条独立反证；独立重跑 §4.1 的全部四条只读校验；用 worktree 自带 tsc 以最小探针实证 bivariance 论断与修正建议的编译行为。未修改任何源码、测试或既有评审正文（本节与头部指引行为唯一新增）。
- **校准判决**：**0 Critical / 0 Important（Important #1 降为已登记债跟进）/ 4 Minor**。原评审事实质量高——全部事实断言（行号锚点、区间统计、实跑校验）经反证属实；但唯一的 Important 定级过高，其两个半项均为 `AGENTS.md:93/:95` 已登记的延后债，非本分支引入的回归。**分支本身可合并**；Minor #1 建议本分支随手修，Minor #2 处方需返工并同步订正 spec，Minor #3/#4 为可选抛光。

### 6.1 Important #1｜事实全真，定级过高，处方内部矛盾

**核实属实的部分**：
- `AgentInvokeContext`（`agent-invoke.ts:40-56`）与 `SessionRuntimeContext`（`sessions.ts:63-98`）确实均未声明 `huaanworkPackageChildAllow`；`sessions.ts:300` 确实把 `packageHost` 直接传作 `packageRuntime`；两处 `dispatch` 均为方法简写。
- 两个 `.mjs` 验收脚本的 ctx 夹具确实缺 `huaanworkSubagentRuns` 与 `huaanworkPackageChildAllow`（m2 `dispatchHttpTurn` ctx `:550-559`；windows dispatch ctx `:385-403`），直接运行会在 `host.ts:523` registry 门即被拒。
- **bivariance 根因是原评审的新贡献且技术正确**（AGENTS.md:93 的登记未指出 `SessionRuntimeContext` 与方法简写根因）。最小探针实证（tsc `--strict --exactOptionalPropertyTypes`）：方法简写下 host→face 赋值放行；改函数属性签名后 optional holder 立即报 **TS2322**（`Property 'holder' is optional in type 'InvokeCtx' but required in type 'DispatchCtx'`）；函数属性 + required 才通过。

**定级过高的三个理由**：
1. **两个半项均已登记为延后债**：`AGENTS.md:93`（加固波次行）把接缝类型列为「下一波候选」，`AGENTS.md:95` 把脚本缺 holder 列为「重跑前置」，均带明确触发条件。原评审自己也承认已登记，却仍升为合并阻断项——与仓库债务裁定纪律冲突，除非 owner 重新裁定。
2. **脚本不是本分支弄红的**：registry 门在 master 基线即存在（`4677899f1c` 的 `host.ts:521` 已含 `"subagent run registry is not initialized"`），两个脚本在分支之前就无法运行；本分支只是加了第二道门（holder 门）。
3. **生产无影响且有运行时兜底，类型化收益有限**：`holders.ts:172` 装配全量 holder，dispatch 入口 fail-closed（`host.ts:523/:526-528`）。更关键的是生产装配点 `holders.ts:193` 是 `ctx as unknown as SessionRuntimeContext` **双重 cast**——即使按建议改了类型，真实装配点也不受编译期约束，收益只覆盖测试夹具等字面量构造点；运行时入口断言仍是真正的兜底（与 AGENTS.md:93 登记口径一致）。

**修正建议的内部矛盾（实证）**：建议 1（补 `huaanworkPackageChildAllow?:` optional）与建议 2（改函数属性签名）按字面组合在 `strict` + `exactOptionalPropertyTypes` 下**编译不过**（探针 TS2322：optional 不可赋给 required，参数逆变要求 face 入参可赋给 host 入参）。要编译通过只剩一条路：接缝上 holder **必填**，涟漪到 sessions/agent-package 各测试夹具——「条件允许时收敛为必填」不是可选项而是必然结果，「小幅修复」低估了成本。

**处置建议**：维持登记债轨道（接缝类型随下一波加固；脚本 holder 注入按登记触发条件在下次 M2/Windows 重跑前做，注入本身仅几行）。若 owner 决定提前拉进本分支，处方必须改为「required + 夹具涟漪」，并接受收益有限的事实。

### 6.2 Minor #1｜准确，建议照修

`docs/huaanwork-three-agent-packages-release.md:16` 确实仍是加固波次前的「整条替换 ⇒ 回落 schema 默认 1」口径，与 `profile.ts:1666-1672` 的字段级合并和 `AGENTS.md:91` 的「瞬态内存窗口」收敛不符。原评审给出的替换文本与现行登记一致，合理。发布 runbook 误导运维，本分支随手修掉。

### 6.3 Minor #2｜诊断准确，处方有技术错误

诊断三项全部核实：`typo-check/skill/SKILL.md:64` 只写 bash；`decide.ts:196-197` win32 只认 pwsh、拒绝 bash；`shell.ts:40` 的元字符拒绝集 `/[|&;`$]/` 确实不含普通单文件 `>`（smart/full 档放行）。张力真实存在，Minor 定级恰当。

**处方两个问题**：
1. 建议的 `python3 -c` 写文件**违反零依赖裁定**——spec §9 明写「服务依赖（Python/node:sqlite 等）全部不引入」，§5.1 选 textutil 正是因为「系统自带零依赖」；macOS 亦不自带 python3。
2. **张力根源在 spec 自身**：§5.1 第 6 步「用 bash 写报告文件」与 R9「不用重定向」均为 owner 批准的 spec 原文，SKILL 是忠实实现。只改 SKILL 会使实现与 spec 漂移，须同批订正 spec 措辞。

**修法选型（需 owner 拍板）**：要么放宽为「报告落盘允许单条 `>` 重定向」（运行时 smart/full 档本就放行，改动最小），要么给平台化写文件处方（Windows 沿用本包既有的 `pwsh -EncodedCommand` 形态，macOS 另选零依赖方案）。

### 6.4 Minor #3｜准确，纯防御性抛光，可选

`host.ts:754-758` 确实是先写两个 Set 再查 `turnAllow === undefined`。运行时不可达已核实：`host.ts:1048` 在两处 `bindChild` 之前赋值 `turnAllow = allow`，且 `:756-757` 注释已明示该不变式。上移守卫是零风险小抛光，做不做均不影响合并。

### 6.5 Minor #4｜半准确，价值低

- claim 1 属实：`rows.get('subagent')` 全文件仅 `profile.ts:1667` 门控块内一处，`:1672` 之后无消费点，无运行时影响。
- claim 2 事实成立但**口径不完整**：注释所引 `dsh-config-editor:122` 是**编译产物**锚点——`node_modules/@deepseek-ai/dsh-config-editor/lib/index.js:122` 确为那条 fail-closed 检查，且加固波次证据（`docs/evidence/2026-11-11-three-agent-packages.md:846`）明写「editor 门控在 `dsh-config-editor:122` 核实」，系刻意对运行时产物核验过的锚点，并非随手写错；上游源码对应行确为 `config-editor/src/index.ts:138-140`。改引符号/语义的建议合理但价值低。

### 6.6 其余抽查结果

- **§1 对齐表**：C1–C5、R8、N-3 的锚点行号与语义全部核实无误（含 `cancelRequested = true` 先于 `controller.abort`（`host.ts:947/:963`）、`clearTurnLineage` 引用同一性清理（`:774-781`）、result 观察者延迟清理（`:1115-1131`）、`turnAllow = allow` 先于两次 bindChild（`:1046-1048`））。**唯一瑕疵**：row-assertions 链接路径错误——写作 `src/row-assertions.ts`，实际位于 `src/huaanwork-host/row-assertions.ts`（`:29` 的 `tool-subagent` 断言内容本身正确）。
- **区间统计**：merge-base `4677899f1c`、45 提交、41 文件、+6340/−65、`deepseek-harness` 零 diff，全部精确。
- **§4.1 四条校验独立重跑（worktree，HEAD 4236b19626）**：`typecheck` EXIT=0；`@huaanwork/policy check` 62 pass / 0 fail / 2 skipped；`check-whitespace.mjs`（BASE_SHA=merge-base）EXIT=0；13 个变更 spec 文件 **293 passed | 1 skipped (294)**——与原评审声称逐项一致。
- **§3 残余账目**：与 `AGENTS.md:91-95` 及证据文档〈残余与边界〉1–6 条逐条吻合。

### 6.7 需 owner 拍板项与收尾要求

1. **Important #1 降级是否接受**：维持登记延后轨道（复审建议），或提前拉进本分支（处方须返工为 required + 夹具涟漪，收益受 `holders.ts:193` 双重 cast 限制）。
2. **Minor #2 修法选型**：放宽单条 `>` 重定向 vs 平台化写文件处方；两者均须同批订正 spec §5.1 第 6 步 / R9 措辞，`python3 -c` 不可接受（零依赖裁定）。
3. **Minor #3/#4 是否随手做**：纯防御/维护性，无运行时影响。
4. **收尾门禁**：按 spec §7.2，无论采纳哪些修复，最终 `typecheck`/`test`/`check` 必须在最终代码树上重跑；仅落文档修改亦不豁免。
