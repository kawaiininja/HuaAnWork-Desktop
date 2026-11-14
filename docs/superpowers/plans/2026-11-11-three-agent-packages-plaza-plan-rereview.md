# 三个智能体包与广场接入：修订后复审（Re-review）

- **日期**：2026-11-12
- **复审对象**：
  - 规格 `docs/superpowers/specs/2026-11-11-three-agent-packages-plaza-design.md`
  - 计划 `docs/superpowers/plans/2026-11-11-three-agent-packages-plaza.md`
  - 基线：HEAD `4677899f1c`（已含 R6/R7 订正与首轮评审处置）
- **前序文档**：`2026-11-11-three-agent-packages-plaza-plan-review.md`（首轮评审 + 处置）
- **复审方式**：只读源码核对，未运行测试，未改动任何源码。以下结论中，凡标「待 spike 确认」者为依据源码的推断，尚未实测。

## 1. 结论

**未达到实施标准（有条件：补齐 §2 的两项前置后可进入实施）。**

首轮评审提出的 P0/P1/P2 项及 Qwen4 补出的 3 处代码级错误，已确认修复到位，文档整体质量高。但本次发现一个首轮评审与修订均未覆盖的功能性缺口（递归深度），以及一个高概率的运行阻断项（bash 审批）。两者都不会被 Task 1~4 的单测发现，会在 Task 12 真机走查才暴露。

## 2. 新发现

### N-1（P0）递归深度上限会挡住包子会话派发 lane

证据链：

1. `tool-subagent` 在未显式配置 `maxDepth` 时读取 Host 设置，**默认值 `1`**；设置界面对应文案为「仅允许主 Agent 创建子智能体」。
   - `deepseek-harness/packages/subagent/tool-subagent/src/index.ts:68-77`
   - `deepseek-harness/packages/subagent/subagent/src/index.ts:196`、`:242-248`
2. 包子会话由主会话（深度 0）经 `host.ts:1028` 的 `startActivation` 创建，深度为 1。
3. 包子会话再调用 `subagent` 派 lane，lane 深度为 2 > 1，`resolveChildDepth` 抛 `SubagentDepthError`（`subagent/src/child-agent.ts:49-57`）。
4. 同时，系统提示会在深度达上限时告诉模型「Do not call `subagent` at this depth」（`tool-subagent/src/index.ts:383-393`），模型多半根本不会尝试。
5. `dsh-plugin-huaanwork/src` 内无任何 `maxDepth` 覆盖；规格 §4.2 C4 仅写「深度上限由 maxDepth 配置天然约束」，未核对有效值。

影响：Task 1~4 的单测使用 fake，会全绿；Task 12 的 lane 计数断言（≥2）将得到 0。C1~C5 的投入无法兑现「双盲检测」。

修订要求（Owner 已于 2026-11-12 确认采纳方案 B）：

- **规格新增裁定（R8，方案 B）**：有效递归深度设为恰好 `2`，作为 HuaAnWork 的**产品默认配置**发布（在 profile 初始化或配置层注入默认 `maxDepth: 2`，确保开箱即用，不依赖用户手工设置；且上游 zero-change）。
  - **数值合理性**：深度 `2` 是满足包子会话（深度 1）派发 lane（深度 2）的最小必要值。lane 处在深度 2 时 `2 < 2` 不成立，模型直接执行任务，天然封死无限嵌套；C4 曾孙代路径攻击面被收敛至最小。
  - **全局副作用**：放宽是全局的，主会话自主派发的子代理也可多嵌一层（无血缘会话保持全局基线工具）。
- **SKILL.md 诚实降级条款**：若环境出现深度限制或子代理派发失败，智能体必须向用户如实披露降级（“当前环境递归深度不足，已降级为单会话多轮自审”），严禁伪造“双盲”结果。
- **计划新增 Task 0（Spike，约 10 分钟）**：
  1. 验证默认 depth=1 时包子会话派发确实抛 `SubagentDepthError`；
  2. 验证在 HuaAnWork 配置层/profile 写入 `maxDepth: 2` 的无侵入接入点与生效状态。
- **Task 12 真机走查前置检查**：增加有效深度检测断言（`maxDepth >= 2`，不满足 ⇒ BLOCKED exit 3）。

### N-2（P1，待 spike 确认）`ask` 档下 bash 无人审批

证据链：

1. 默认 `guard_mode` 为 `ask`（`dsh-plugin-huaanwork/src/huaanwork-host/settings.ts:67`）。
2. `decide.ts` 中普通 bash/pwsh 命令在 `ask` 档返回询问（`packages/huaanwork-policy/src/decide.ts:190-218`）；含元字符的复合命令在非 `full` 档直接 deny；`rm -r`/`rm -f` 属高危命令，`ask`/`smart` 档均需审批。
3. 仓库注释明确「包运行子会话没有审批界面」（`policy.ts:234`、`holders.ts:46`）。

影响：typo-check 的提取步骤（`textutil ...` / pwsh 解压）在默认配置下很可能被自动拒绝；SKILL.md 中「报告完成后清理临时文件」若用递归删除，同样受阻。

修订要求：

- typo-check 的 SKILL.md 明确：每次只发**单条简单命令**（不用 `&&`、管道、重定向）；清理用单文件删除而非递归删除，或改为不清理并说明临时目录位置。
- Task 12 的隔离 profile 显式设定 `guard_mode` 并记录；规格 §5.1 写明对 `guard_mode` 的要求（或明确 `ask` 档下的降级表现）。
- spike 中同时验证：`ask` 档下包子会话执行 `textutil` 的实际结果。

### N-3（P2，探针项）lane 存活期与回合清理

`host.ts:783-870` 的 `cleanup('idle')` 等待包子会话 activation 的 `result`（有超时上限）后即释放绑定与映射。lane 结果回传、主流程仲裁期间，血缘条目是否仍然有效，取决于上游 `result` 是否等待子孙结算。该点沿用首轮的「迟到 activation 清理竞态」探针，建议在 Task 11 评审与 Task 12 真机中一并核实，并在证据中记录实测结论。

## 3. 已核实无误的内容

- 计划引用的 `runtime.ts`、`holders.ts`、`host.ts`、`skills.ts`、`policy.ts` 锚点与现有代码一致；`agent-package-runtime.spec.ts` 的 allow list 测试位置正确。
- `turnAllow` 的赋值先于两处 `bindChild`，引用同一性清理的顺序成立。
- Task 13 路径已纠正为 `~/Downloads/cursor/智能办公平台/…`，三个目录存在且均无 git remote。
- Task 14 引用的 M2 runbook 章节 §4/§6/§7/§8/§13/§14 均存在。
- 三包 description 追加「用 @slug 调用。」后长度分别为 83/76/95，不超过 200 上限；slug 满足命名正则。
- 代码审查 `REVIEW_SPEC` 与原 `代码审查智能体/src/spec.ts` 内容一致（仅标题级别 `#`→`###`）；错别字 7 类规则与原 `review-spec-v2.md` 对应。
- 本机具备 `zstd`、`textutil`。

## 4. 未覆盖/未验证

- Task 9 `bootCatalog` 的修正未对照 M2 先例脚本逐行核对。
- 所有「待 spike 确认」项均未实测。

## 5. 复审后的进入条件

1. 完成 Task 0 spike 并把 N-1（验证深度限制与方案 B 配置生效点）、N-2（验证 ask 档下 bash 行为）的实测结论写入证据文档。
2. 规格登记 R8（递归深度确认采纳方案 B：产品默认深度设为 2 + SKILL.md 诚实降级）；计划补 Task 0、Task 12 前置深度检测（`maxDepth >= 2`）与 SKILL.md 命令约束。
3. 上述完成后，Task 1~14 的其余内容可按现有计划执行。

## 6. 处置（2026-11-12，独立反证核实 + owner 两项确认）

核实方式：只读源码逐条反证（未运行测试）；判决先行、严重度校准。owner 于 2026-11-12 确认：① R8 方案 B 采纳；② N-2 按补强口径处置。

| 项 | 判决 | 处置 |
| --- | --- | --- |
| N-1（P0） | **属实，P0 恰当**；首轮评审与首轮反证均漏。证据链全对上：Config 默认 1（subagent/src/index.ts:196）、bundle 工具配置无 maxDepth、包子会话深度 1（host.ts:1028 锚点正确）、resolveChildDepth 抛错（child-agent.ts:49-57）、提示抑制（tool-subagent:388-393）、huaanwork 零覆盖 | spec 登记 **R8** + 新增 §4.6 + 订正 §4.2 C4；计划新增 **Task 0（spike + 产品默认 maxDepth: 2 注入 + 开箱回归钉）**、Task 12 `requireMaxDepth()` 预检（<2 或读不到 ⇒ BLOCKED exit 3）、typo-check SKILL.md 深度降级条款（单会话多轮自审，严禁伪造双盲） |
| N-2（P1） | **属实，且比复审更确定**：ask 档普通单命令经 `askOrDeny` 在 guard 缝**必然 deny**（decide.ts:233-235、policy.ts:120-125），非「很可能」；包子会话无审批界面、交互运行无无人值守白名单。**修法有洞**：「单条简单命令」约束不能解决 ask 档拦截（ask 档单命令照样被拒，decide.ts:222），只在 smart 档有意义 | spec 登记 **R9**（owner 确认补强口径）：Task 12 隔离 profile **显式写 guard_mode: "smart"**（不从生产复制）并记入 facts；SKILL.md 命令约束（无 &&/管道/重定向）+ 清理约束（单文件删除或不清理并说明位置）+ 档位降级条款（被拒如实告知切档，不伪造提取结果）；Task 0 spike 含 ask 档判定实测。code-review/task-orch 不用 bash，不受影响，P1 恰当 |
| N-3（P2 探针） | **描述准确，探针合理**；源码层面已部分回答：上游结算判定 ownedChildren 非空 ⇒ wait（manager.ts:1081-1091），包子会话 result 等 lane 结算，正常时序血缘条目活得到仲裁。残余边缘 = 10 分钟清理预算超时路径（host.ts:309 ACTIVATION_CLEANUP_TIMEOUT_MS=600_000） | Task 11 评审范围 + Task 12 证据节登记探针与源码证据，实测结论落证据文档 |

**§3 抽查**：description 200 上限（drafts.ts:54 MAX_DESCRIPTION_LENGTH）与 83/76/95 长度重算一致；host.ts:1028 锚点正确。**§4 缺口补核**：bootCatalog 修正已于首轮处置时对 M2 先例（huaanwork-agent-package-m2-acceptance.mjs:608-635）逐行核实，无缺口。

**进入条件状态**：条件 2 的文档订正已完成（spec R8/R9 + §4.6；计划 Task 0 / Task 12 预检 / SKILL.md 约束，见计划 Self-Review §6）。条件 1 的 spike 实测是实施期第一个执行步骤（Task 0），其结论落 `docs/evidence/2026-11-11-three-agent-packages.md` 后方可进入 Task 1–14。

## 7. Claude 审核结论（2026-11-12，第三轮复核）

- **审核人：Claude**。
- **审核对象**：规格 `docs/superpowers/specs/2026-11-11-three-agent-packages-plaza-design.md`（SHA-256 前缀 `6539980f2d6c`）与计划 `docs/superpowers/plans/2026-11-11-three-agent-packages-plaza.md`（SHA-256 前缀 `3b4e618e8c40`），基线 commit `4677899f1c`。
- **复核方式**：对上一轮评审逐条反证，重新读取规格、计划和直接相关源码，并做无文件写入的 bounded probes；另扫描 lane 证据、备份安全和任务顺序中的漏报。
- **分级口径**：P0 = 按计划执行到对应步骤会直接失败或得到无效验收，须先修计划文本；P1 = 可以在修订后开工，但必须在对应合并或验收节点前补齐；P2 = 文档口径、条件项或加固建议。上一轮把多项验收缺口统一标为 CRITICAL，本轮改用上述分级，避免把「阻断整个开工」与「阻断对应验收」混为一谈。
- **总结论**：**未达到直接实施标准**。四个 P0 项均有直接证据；另有 P1 验收闭环缺口。无需推翻 C1–C5 架构或改变 owner 已裁定的 R1–R9，完成下述计划修订后复核即可。
- **边界**：本节是 Claude 的审核结论与处置建议，不表示计划或产品代码已经修复。外部 Codex 未参与；本轮辅助子代理未形成最终报告，其过程中的片段不作为结论依据。

### 7.1 对上一轮结论的逐项校准

| 上一轮事项 | 复核判决 | 校准后级别 | 处置建议 |
| --- | --- | --- | --- |
| Task 0 直接导入子模块 TS 源码失败，且 `huaanwork-host/profile.ts` 路径错误 | **成立，非误报**。原始导入在 Node 22.23.2 下重新实测，仍因 `@deepseek-ai/dsh-llm` 无法解析而在断言前退出；真实组合文件是 `dsh-plugin-huaanwork/src/profile.ts`（计划 `:69-99`） | **P0** | 改为经 workspace 安装的运行时包导入 `@deepseek-ai/dsh-subagent`；修正 profile 路径。该修正只改测量接线，不改变 N-1 的深度结论 |
| Task 8 `seeded.push(slug)` 位于循环外 | **成立，非误报**（计划 `:1630-1634`）。最小复现重新得到 `ReferenceError: slug is not defined`；且错误发生在三包写盘之后，会产生「已写入但进程失败」的歧义 | **P0** | 把 `seeded.push(slug)` 移入 `for...of` 循环；保留现有播种自测作为回归钉 |
| Task 9 未写 server keyring | **成立，非误报**。计划把 `AGENT_CATALOG_KEYRING_PATH` 指向 `dirs.root/keyring.json`（`:1792-1801`），但主流程只写私钥；`agent-catalog-server/src/config.ts:148-158` 会读取失败。M2 先例在 `huaanwork-agent-package-m2-acceptance.mjs:1343-1347` 明确写 server keyring | **P0** | 在首次 `bootCatalog` 前写 `{schemaVersion:1, keys:[keyring]}`，权限 `0600`；consumer profile 的 keyring 写入不能替代 server 文件 |
| Task 12 把派生字段用于原始 JSONL | **成立，非误报**。原始 v4 行是 `type:'tool/call'`、`data.name`；`kind:'tool-call'` 与顶层 `name` 是 `session-view.ts:240-252` 的派生视图。计划 `:2339` 未写任何映射步骤 | **P0** | 直接扫描时用 `type === 'tool/call' && data.name === 'subagent'`，或显式经过 `detailRecords` 等价映射；同时按 N-4 补强成功证据 |
| 备份校验使用 `tar -tzf ... \| head -50` | **成立，但上一轮严重度偏宽**。该命令不完整读取归档，也不保证列出三个顶层目录（计划 `:2380-2383`）；它是 Task 13 验收缺陷，不是阻断 Task 0 开工的错误 | **P1** | 完整读取归档并分别核对三个目录成员，再记录 SHA-256；另按 N-5 防止覆盖旧备份 |
| 取消、迟到 activation、重复清理、id 复用未覆盖新血缘 Map | **成立，但需纠正措辞**。仓库已有取消/迟到和幂等场景，例如 `agent-package-runtime.spec.ts:1397-1465`、`agent-package-tools.spec.ts:1429-1436`；缺口是这些既有场景没有接入新增 `huaanworkPackageChildAllow`，计划中的手工 `map.delete` 也不是生命周期驱动 | **P1** | **扩展现有场景**，在取消、迟到 activation、重复 afterIdle、会话 id 复用后断言新 Map 无 stale 条目且不误清新回合；不要重复造一套测试骨架 |
| 缺 fake provider 首步工具表捕获 | **成立**。计划 `:549-571` 只读 activation 后的 `schemas()`；既有 `agent-package-tools.spec.ts:1439-1472` 只捕获附件与 registry，并未捕获模型首步实际工具表；规格 §4.4 第 2 项明确要求该断言 | **P1** | 在真实首步组装缝捕获工具表，分别记录模型可见列表与 C5 执行有效列表，避免用事后 schemas 替代首步证据 |
| 缺 pwsh 提取行为测试 | **成立**。计划 `:24,2085` 承诺该覆盖，实际只有 win32 allow 测试与 `System.IO.Compression` 提示词子串；规格 §7.5 要求 pwsh 提取单测 | **P1** | 用固定 docx 验证段落换行、标签移除、XML 实体和 UTF-8 输出；可交给 Windows CI/真实 pwsh 环境。没有执行环境时记未覆盖或 BLOCKED，不得用子串钉冒充提取通过 |
| 全量门禁不在最终代码树上执行 | **成立**。Task 10（计划 `:2053-2093`）之后，Task 11 可修安全代码，Task 12 还新增脚本，最终只有定向测试 | **P1** | 将 Task 10 标为中间门禁，并在所有代码与评审修复完成后增加最终 `typecheck/test/check`；证据必须对应最终代码树 |
| Task 9 exit 3 不可达、Task 12 接受不存在的 `done`、Self-Review 声称代码全部完整 | **事实成立，但不是功能阻断**。真实终态见 `logic/subagentRuns.ts:41-45`，仅 completed/failed/stopped；Task 12 仍含伪代码和 prose 实现步骤 | **P2** | 删除不可达口径或补真实分支；`done` 可删除；把「完整代码」改成「关键代码 + 明确实现步骤」，或真正补齐代码 |
| 模型输出只有摘录，自动 PASS 不证明语义质量 | **事实成立，但不是规格缺漏**。规格 §7.3 本来就采用真机观测，计划也要求截图和事实摘录；不能据此要求必须新增自动化语义评分 | **P2 / 证据口径** | 在证据中明确人工核对 typo 仲裁、code-review 植入缺陷、task-orch 依赖与验收标准；自动 PASS 只代表流程与机制通过，不宣称内容质量经过自动证明 |
| 产品默认 maxDepth=2 必须保留已有用户设置 | **上一轮表述过绝对，应改为条件项**。R8 是「产品默认」，但 Task 0 候选 3 明列工具级 maxDepth 会直接绕过 Host 设置（计划 `:94-99`），不能对所有候选一律要求同一保留语义 | **P2 / 条件裁定** | 若选 profile/Host 默认值，测试「缺席→2、已有用户值→保留」；若只能选工具级固定覆盖，须把覆盖语义和全局影响报 owner 单独裁定，不得静默当作普通默认值 |

### 7.2 本轮新增漏报

#### N-4（P1）lane 验收的会话定位与成功判据不足

计划 `:2339` 同时采用「按日志内容含 `@typo-check` 派发文本定位目标会话」和「统计 tool-call 数 ≥2」：

1. **会话定位不确定**。`agent-invoke.ts:97-106,148` 生成的 `parentText` 含 `@slug`，而 `sessions.ts:302,317-322` 把该文本送回父会话；包子会话则由 `host.ts:993,1033-1038` 接收 persona + remainder，persona 又包含 SKILL 正文（`runtime.ts:120-125`），其中也有调用行。按完整派发文本可能选中父会话，按 slug 又可能同时命中父子会话，计划没有确定性的包 child 身份链。
2. **调用次数不等于成功 lane**。原始 fixture 明确区分 `tool/call` 与带 `message.isError` 的 `tool/result`（`session-view.spec.ts:62-85`）。只数 call，两次被拒绝或失败的派发也能满足 ≥2，随后走诚实降级却仍可能被验收误报为双盲通过。

**处置建议**：通过 activation/run 的父子身份链确定包 child，而不是靠文本搜索；使用两个不同 callId/child 会话，关联非错误结果，并保留两个 lane 的实际输出与主流程仲裁证据。任何派发失败或诚实降级都不得计入双盲 PASS。若这些事实无法从现有日志可靠恢复，应记 BLOCKED 并补观测缝，不得降低为调用计数。

#### N-5（P1）固定备份文件名缺少防覆盖门

Task 13 的 `tar -czf ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz ...`（计划 `:2372-2378`）会在重复执行时覆盖同名旧备份。三个原目录无 git remote，旧备份可能是唯一安全网。本轮只读存在性检查结果为该文件**当前不存在**，因此没有发生现实覆盖；这是计划的可重复执行缺口，不是已发生的数据损失。

**处置建议**：写入前检查目标不存在，存在即停止并报告；或由 owner 选择新的带时间戳文件名。不得未经确认覆盖旧归档。

### 7.3 其他非阻断补强建议（P2）

- **样例位置**：明确 `ctx.sampleDir` 与 `ctx.sampleCode` 位于本次隔离 `workspaceRoot` 内。计划只给出 `workDir` 参数（`:2181-2207,2315-2317`），而 `packages/huaanwork-policy/src/decide.ts:93-99` 会拒绝工作区外 read/glob；不要让验收样例意外落在外部临时目录。
- **播种预检**：Task 8 当前逐包校验并逐包写盘（`:1599-1633`），而 Task 14 会指引生产 creator 使用该脚本。建议先完成三包 manifest/预算/文件集预检，再开始任何写入，避免第三包失败时前两包已更新；这不是本轮 P0，因为脚本会响亮失败且可修复后重跑。
- **独立评审范围**：Task 11 除五个 C1–C5 文件外，建议纳入 Task 0 的 maxDepth 注入 diff 与回归钉，因为 R8 明确具有全局嵌套副作用。该建议不改变规格范围。

### 7.4 建议处置顺序

| 顺序 | 必须落实的计划修订 | 通过条件 |
| --- | --- | --- |
| 1. 开工前 | 修 Task 0 导入和 profile 路径、Task 8 循环作用域、Task 9 server keyring、Task 12 原始日志字段 | 四个 P0 均有对应可执行命令或回归钉，不再保留原错误文本 |
| 2. C1–C5 合并前 | 扩展现有取消/迟到/幂等/id 复用场景；补 fake provider 首步捕获；将 Task 0 diff 纳入独立评审 | 新 Map 的安全不变量由真实生命周期驱动，独立评审覆盖全部安全改动 |
| 3. Task 12 验收前 | 落实 N-4 的身份与成功证据、pwsh 行为测试、样例 workspace 位置、人工输出核对口径 | 双盲不得凭调用次数或降级结果假通过；Windows 与模型输出的证据边界清楚 |
| 4. 最终验收前 | 在最终代码树上重跑 typecheck/test/check | 三条命令的退出码和证据对应最后一次代码变更 |
| 5. Task 13 执行前 | 完整校验归档、核对三目录、增加防覆盖门 | 正常归档与损坏归档负例可区分；既有备份不会被静默覆盖 |
| 6. 文档同步 | 清理 exit 3、`done`、「代码全部完整」等口径，并按 Task 0 实际接入点记录默认值或覆盖语义 | 文档声明与脚本分支、真实 UI 和 owner 裁定一致 |

**复审准入**：P0 与 P1 项全部写回计划并做链接/命令复核后，可进行一次聚焦复审；无需重开 R1–R9 或重新设计 C1–C5。生产上架、生产私钥和原目录删除仍严格维持 R6/R7 边界，不在本审核建议中扩大范围。

### 7.5 本轮验证证据与限制

- 原始 Task 0 源码导入探针：**FAIL**，`ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm`，尚未运行到深度断言。
- 修正后的 workspace 探针：`corepack yarn workspace dsh-plugin-huaanwork exec node --input-type=module ...` 从 `@deepseek-ai/dsh-subagent` 导入，**PASS**；实测 cap=1 拒绝深度 2，cap=2 放行深度 2 并拒绝深度 3。
- `for (const slug ...) ... console.log(slug)` 最小复现：**FAIL**，`ReferenceError: slug is not defined`。
- 其余结论来自指定文件与直接源码的静态核对；没有运行全量 `typecheck/test/check`，没有启动 GUI，没有执行生产发布、备份、删除或任何产品代码修改。

## 8. 处置（2026-11-12，独立反证核实 + 计划修订完成）

核实方式：只读源码逐条反证 + 关键项实跑探针（深度导入探针复现 FAIL、workspace 修正形态复现 PASS、真实会话日志解压核对原始字段与会话头）；判决先行、严重度校准。

### 8.1 逐项判决

| 终审项 | 判决 | 依据与处置 |
| --- | --- | --- |
| P0-1 Task 0 导入失败 + profile 路径错 | **属实**（探针实跑复现 ERR_MODULE_NOT_FOUND；workspace 修正形态实跑 PASS；`src/profile.ts` 存在、`huaanwork-host/profile.ts` 不存在） | Task 0 Step 1 改 workspace 包导入 + 运行命令；Interfaces 注明禁直接 import 子模块源码；候选 1 路径订正 |
| P0-2 `seeded.push(slug)` 循环外 | **误报，不改** | 计划文件 SHA-256 = `3b4e618e8c40…` 与终审审计基线一致（审的就是当前版本），而当前文本该语句在 `for...of` 循环**内**（`for (const slug of SLUGS) { details.push(seedOne(...)); seeded.push(slug) }`）。终审的最小复现系其自身转录错误；计划无此缺陷 |
| P0-3 Task 9 未写 server keyring | **属实** | main() 原只写私钥；`config.ts:148-158` parseKeyring 要求文件可读；M2 先例 :1343-1347 写 server keyring。已在 main() 首次 bootCatalog 前补写 `dirs.root/keyring.json`（0600，M2 同形） |
| P0-4 Task 12 派生字段用于原始 JSONL | **属实**（真实日志解压核实：原始 `type:'tool/call'`+`data.name`，`kind:"tool-call"` 命中恒 0；上一轮反证自称「已核实日志字段」核的是派生视图，系自身错误） | Task 12 Step 3 改原始 v4 字段谓词，并按 N-4 重写验收 |
| P1 tar \| head -50 | **属实** | Task 13 Step 2 改完整读取 + 逐目录成员核对 + 损坏归档负例口径 |
| P1 生命周期场景未接新 Map | **属实**（既有取消/迟到 :1397-1465、幂等 :1429-1436 均未断言新 Map） | Task 2 新增 Step 6：就地扩展既有场景（取消/迟到/幂等/id 复用），禁手工 delete 冒充生命周期；Task 4 手工 delete 注明仅读侧语义 |
| P1 首步工具表捕获缺失 | **属实**（矩阵 2 只读 activation 后 schemas；既有 :1439-1472 捕获附件/registry 非模型首步） | Task 3 新增矩阵 2b：fake provider 首步请求捕获模型可见列表 + C5 执行有效列表互证 |
| P1 pwsh 提取行为测试缺失 | **属实**（本机无 pwsh 已核实） | Task 5 新增 Step 5：fixture docx 行为测试，pwsh 门控，无环境记 BLOCKED，子串钉不冒充 |
| P1 门禁不在最终代码树 | **属实** | Task 10 标中间门禁；Task 12 新增 Step 5 最终门禁（typecheck/test/check 对应最后一次代码变更） |
| P2 exit 3 不可达 / done 伪终态 / 完整代码口径 | **属实**（TERMINAL_RUN_PHASES = completed/failed/stopped；Task 9 无 exit 3 分支） | Task 9 契约删 3；Task 12 删 done、failed/stopped 立即 FAIL；Self-Review 改「关键代码 + 明确实现步骤」 |
| P2 模型输出证据口径 | **属实（口径澄清，非规格缺漏）** | Task 12 Step 6 + spec §7.3：人工核对 typo 仲裁/植入缺陷命中/依赖与验收标准；自动 PASS ≠ 内容质量证明 |
| P2 maxDepth 用户设置保留 | **合理条件项** | Task 0 决策门 + Step 5 保留钉（缺席→2、已有用户值→保留）；工具级覆盖须 owner 单独裁定，不得静默当普通默认。spec §4.6 同步 |
| N-4 lane 定位与成功判据 | **属实**（parentText 含 @slug 送回父会话 agent-invoke.ts:97-107/sessions.ts:302；persona 内联 SKILL 调用行 runtime.ts:120-125；tool/result isError fixture 核实；会话头 parentSession/origin/delegationDepth 真实日志核实） | Task 12 Step 3 重写：确定性身份链 + 2 个不同 callId 非错误结果 + 两 lane 交付证据；禁文本搜索/调用计数；降级不 PASS；不可恢复 ⇒ BLOCKED 补观测缝。spec §7.3 同步 |
| N-5 备份防覆盖门 | **属实**（目标文件当前不存在，未发生现实覆盖） | Task 13 Step 1 存在即停止报 owner；spec §8.1 同步 |
| P2 样例位置 / 播种预检 / 评审范围 | **合理** | 样例落隔离 workspaceRoot 内（decide.ts:93-98 路径越界拒绝）；Task 8 先全量预检后写盘；Task 11 评审纳 Task 0 注入 diff |

### 8.2 修订状态

- 计划：上述全部属实项已写回（Task 0/2/3/4/5/8/9/10/11/12/13 + Global Constraints + File Structure + Self-Review §7）；P0-2 误报不改，仅登记。
- 规格：§4.6 用户设置保留语义、§7.2 最终门禁、§7.3 lane 验收判据与人工核对口径、§8.1 备份防覆盖门与完整校验同步订正。
- 分级口径采纳：P0 = 对应步骤直接失败，P1 = 对应合并/验收节点前补齐，P2 = 口径/条件/加固；不推翻 C1–C5 与 R1–R9。
- 待实施期验证：Task 0 spike 实测（含注入点与用户设置保留语义）、Task 12 双盲判据的真实日志记录形态钉住、pwsh 环境（无则 BLOCKED）、最终门禁。生产上架/生产私钥/原目录删除维持 R6/R7 边界不变。
