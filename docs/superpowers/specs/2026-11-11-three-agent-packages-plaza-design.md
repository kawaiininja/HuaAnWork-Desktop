# 三个智能体包与广场接入设计（typo-check / code-review / task-orch）

- 日期：2026-11-11（2026-11-12 按计划评审订正：目录位置、@ 唤醒图示、披露口径、删除时序，登记 R6/R7；同日按复审订正：递归深度产品默认与 typo-check 档位依赖，登记 R8/R9；同日按终审订正：用户设置保留语义、最终门禁、lane 验收判据、备份防覆盖门）
- 状态：设计已获 owner 批准（2026-11-11）；实施计划已产出并经两轮评审订正（复审进入条件：Task 0 spike 先行）
- 范围：`dsh-plugin-huaanwork` 运行时扩展 + 三个智能体包定义 + 签名广场接入 + 原目录清理
- 上游约束：`deepseek-harness/` 子模块零修改；manifest schema、admin CLI、catalog server 代码、广场卡 schema 均不改

## 1. 背景与目标

`/Users/amonmiao/Downloads/cursor/智能办公平台/` 下三个独立项目（错别字检测智能体 TypoGuard、代码审查智能体 code-review-cli、任务编排智能体 orch）均为常驻 HTTP 服务形态，与 HuaAnWork 智能体包的回合制运行时不兼容。owner 裁定将其**完全 LLM 化**为三个自包含智能体包，经 **M2 签名发布流程**进入智能体广场；原服务退役，原目录本里程碑只备份，删除延后到生产上架稳定后（R7）。

目标：

1. 三个包以中文 displayName 出现在广场，名称/描述/能力披露与页面展示一致。
2. 错别字检测实现「两个子代理背靠背双盲检测 + 主代理仲裁」——需要一次运行时扩展（包允许 subagent 派发 + 孙代工具收窄继承）。
3. 任务编排为「复杂任务拆解 + 可实施执行计划」顾问，只出计划不执行。
4. 全程验证留证据；原目录本里程碑备份并登记延后删除项，删除须待生产稳定且 owner 再次确认（R7）。

## 2. 裁定记录

| 编号 | 裁定 | 日期 |
| --- | --- | --- |
| R1 | 完全 LLM 化：三包自包含，常驻服务退役；错别字检测降级为宿主模型直检（放弃跨厂商双模型/断点续跑）；任务编排为知识顾问 | 2026-11-11 前 |
| R2 | 智能体包 + 签名发布：中文 displayName，走 M2 签名链路；开发密钥仅验证，正式上架需 owner 真实密钥 | 2026-11-11 前 |
| R3 | 双盲检测本里程碑做运行时扩展：包允许名单加 `subagent` + 孙代收窄继承 + 回归钉（约 2–3 人日，安全敏感文件须独立评审） | 2026-11-11 |
| R4 | task-orch 升级为「任务拆解与执行计划顾问」：输入复杂任务，输出依赖拆解 + 步骤计划 + 验收标准 + 调度建议 | 2026-11-11 |
| R5 | 完整设计批准，写 spec | 2026-11-11 |
| R6 | 生产上架不纳入本里程碑代码范围（维持 R2/§6.2 边界）；补一个 runbook 指引任务，指向 M2 部署与离线签名 runbook 的生产上架步骤 | 2026-11-12 |
| R7 | 原目录删除延后到生产上架完成并稳定运行后；本里程碑只做备份 + 延后项登记，删除仍须 owner 再次明确确认 | 2026-11-12 |
| R8 | 递归深度方案 B（复审 N-1）：有效递归深度设为恰好 `2`，作为 HuaAnWork **产品默认配置**在 profile 初始化或配置层注入（开箱即用，不依赖用户手工设置；上游零修改）。深度 2 是包子会话（深度 1）派发 lane（深度 2）的最小必要值，lane 再派发深度 3 > 2 被拒，天然封死无限嵌套。SKILL.md 诚实降级：深度不足或派发失败必须如实披露「已降级为单会话多轮自审」，严禁伪造双盲结果 | 2026-11-12 |
| R9 | typo-check 档位依赖与诚实降级（复审 N-2，owner 确认补强口径）：提取步骤依赖 guard 档位 smart/full——ask 档（产品默认）下包子会话 bash **必然被拒**（guard 缝 deny，无审批界面、交互运行无无人值守白名单）；验收隔离 profile 显式设 smart 档并记录；SKILL.md 命令约束为单条简单命令（无 `&&`/管道/重定向），被拒时如实告知用户切档，不伪造提取结果；清理用单文件删除或不清理并说明临时目录位置 | 2026-11-12 |
| R10 | 桌面 profile 复挂模型可见的 `tool-subagent` 行（`{ id: 'tool-subagent', disabled: false }`，只翻回该行，不翻回 fork/control/list-agents）：web-app overlay 关闭了宿主平面委派工具，主会话与包子会话的工具表都没有 `subagent`，双盲派发结构性不可达（Task 12 诊断实测）。**后果（显式）**：主会话也获得委派能力，受产品默认 maxDepth 2（R8）约束在同一深度上限；无血缘条目时主会话仍走基线策略，只是工具目录多一行。§4.3 不变量订正为「主会话 subagent 的*工具收窄*行为零变化；工具可见性与委派能力按 R10 放开」；回归钉 `tests/profile.spec.ts`「re-enables the model-facing subagent tool the Web overlay disables」+ 锁行断言（row-assertions / market-composition-order） | 2026-11-13（owner） |

## 3. 总体架构

```
用户 @typo-check / @code-review / @task-orch
（唤醒词 = slug；中文 displayName 仅展示，dispatch 正则不认中文）
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
2. `huaanworkPackageChildAllow.set(孙代id, 继承allow)`（**同一引用**）⇒ 曾孙代沿同样分支继续继承，深度方向传递闭包；深度上限由**有效 maxDepth** 约束——上游默认 `1` 会挡住包子会话派发 lane（复审 N-1，证据见 §4.6），按 R8 注入产品默认 `maxDepth: 2` 后，曾孙代（深度 3 > 2）被上游天然拒绝，传递闭包收敛到 lane 一层。
3. **不挂包运行时附件**：孙代不挂 agent_http/agent_skill_run/MCP（v1）。allow ∩ schemas 自然滤掉未挂载的运行时工具名。
4. start 包装路径（旧签名回落）做同形处理，保持两条入口一致。

**C5 执行期强制**（`huaanwork-guardrails/policy.ts`）
`tools/pre-execute` 增加判定：执行会话 id 命中 `huaanworkPackageChildAllow` 且工具名 ∉ 对应 allow ⇒ 拒绝。理由：schema 收窄发生在 activation 之后，与直接子会话一样存在首步时序窗（M1 残余同形）；执行期强制把窗口封死——即使模型短暂看到宽名单，越权调用也执行不了。fail-closed：map 缺席时不改变现状行为。

### 4.3 不变量（回归钉必须全部守住）

- 直接包 child 路径正常时序行为零变化（既有 skills/host/present-as 钉子全绿）；C5 对直接子会话同样生效，属有意的安全收紧——首步时序窗内的越权调用从「可能执行」变为「拒绝」，不改已收窄状态下的任何行为。
- legacy `@agent` 路径零变化；主会话 subagent 的*工具收窄*行为零变化（无血缘条目 ⇒ 基线策略）；工具可见性与委派能力按 R10 放开（主会话也获得 `subagent`，受产品默认 maxDepth 2 约束）。原表述「主会话模型自主 subagent 行为零变化」由 R10（2026-11-13，owner）取代，不再是有效不变量。
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

### 4.6 产品默认递归深度（R8，2026-11-12 复审 N-1）

**现状（源码已核实）**：上游 `SubagentRuntime.Config.maxDepth` 默认 `1`（volatile 用户设置，`deepseek-harness/packages/subagent/subagent/src/index.ts:196`）；tool-subagent 未显式配置 maxDepth 时经 `resolveMaxDepth` 读该 Host 设置（`tool-subagent/src/index.ts:320`、`subagent/src/index.ts:242-248`），bundle 的 tool-subagent 挂载配置不含 maxDepth。包子会话由主会话（深度 0）经 `host.ts:1028` 的 `startActivation` 创建为深度 1；其再派 lane 时 `resolveChildDepth` 算出深度 2 > 1，抛 `SubagentDepthError`（`subagent/src/child-agent.ts:49-57`）；且深度达上限时系统提示明示「Do not call subagent at this depth」（`tool-subagent/src/index.ts:388-393`），模型多半不会尝试。**默认配置下双盲派发结构性不可达**；Task 1–4 的 fake 单测发现不了，只有真机走查暴露。`dsh-plugin-huaanwork` 内无任何 maxDepth 覆盖。

**要求**：有效递归深度恰好 `2`，作为产品默认在 profile 初始化或配置层注入，开箱即用，不依赖用户手工设置；上游子模块零修改。注入点由实施计划 **Task 0 spike** 实测确认（候选：profile 组合中 subagents 插件条目 config、tool-subagent 工具级 maxDepth、Host 设置存储 `subagent.maxDepth` 默认值），必须是 huaanwork 自有面；无论选哪个点，补回归钉断开箱有效值 = 2。若不存在无侵入接入点 ⇒ BLOCKED 报 owner，绝不改上游。**用户设置保留语义（2026-11-12 终审条件项）**：R8 是「产品默认」——profile/Host 默认值路线必须保留已有用户值（缺席 → 2、已有用户值 → 保留）；工具级固定覆盖会绕过 Host 设置（用户无法改），不得静默当作普通默认值，须把覆盖语义与全局影响报 owner 单独裁定。

**全局副作用（如实披露）**：放宽是全局的——主会话自主派发的子代理也可多嵌一层（无血缘会话保持全局基线工具，安全边界不变）。深度 2 下 lane（深度 2）再派发被拒，C4 曾孙代路径攻击面收敛至最小。工具可见性后果按 R10（§2）登记：主会话工具目录也复挂 `subagent` 一行。

**诚实降级（写进 SKILL.md）**：环境深度不足或 subagent 派发失败时，智能体必须向用户如实披露「当前环境递归深度不足，已降级为单会话多轮自审」，严禁伪造「双盲」结果。

**lane 存活期（复审 N-3 探针，源码层面已部分回答）**：上游 manager 的自然结算判定在 `ownedChildren` 非空时返回 wait（`subagent/src/manager.ts:1081-1091`），包子会话的 `result` 会等 lane 结算，正常时序下血缘条目活得到仲裁。残余边缘：`host.ts` 清理预算 `ACTIVATION_CLEANUP_TIMEOUT_MS = 600_000`（10 分钟，`host.ts:309`），lane+仲裁超预算会提前释放绑定。留 Task 11 评审与 Task 12 真机实测核实并记录结论。

## 5. 三个包定义

### 5.0 共同形态

- 源文件落点：`dsh-plugin-huaanwork/agent-packages/{slug}/`（布局门禁不限制该树内部子目录，已核 `scripts/verify-layout.mjs`），每包 `agent.json` + `persona.md` + `skill/SKILL.md`。
- manifest：schemaVersion 1；version `1.0.0`；persona `"persona.md"`；skill `{ entry: "skill/SKILL.md", summary: ≤200字 }`；`tools: { mode: "none" }`；`allowSkills: []`。draftId/createdAt/updatedAt 由播种脚本生成。
- 预算：persona/SKILL.md 各 ≤32KiB，整包 ≤5MiB（store 既有上限）；检测规则/审查规格/方法论全部内联进 SKILL.md，**不放额外引用文件**（store 写入 API 的文件集不含任意 references）。
- 能力披露：包实际允许名单 = read/read_file/glob/grep/bash（win32 为 pwsh）/subagent；广场签名卡展示 displayName/description/version/size（`catalogPackageCard` 无 capabilities 字段，已核实）。**披露面是详情对话框，不是安装/启用对话框**（2026-11-12 订正：签名包没有安装/启用确认对话框——安装=直接「下载」按钮，启用=直接开关）：未安装详情显示包信息 + 「安装后可查看签名与文件清单」；已安装详情显示验签结果、工具模式（`tools.mode:"none"` ⇒ 「无」）与沙箱警告。允许名单本身不在 UI 逐项展示，能力边界如实写进 description 与 SKILL.md。
- Qoder 侧 `superpowers:dispatching-parallel-agents` 属另一套技能体系，包无法引用；双盲派发模式写进 SKILL.md 文本。
- 调用提示（2026-11-12 评审 P2-1 处置）：@ 派发只认 slug，中文 displayName 不能作唤醒词；每包 description 末尾带「用 @slug 调用。」，SKILL.md 开头带调用行（`@slug <参数形态>`），让用户在广场卡与详情里都能看到真实调用词。
- 运行环境依赖（2026-11-12 复审处置，R8/R9）：typo-check 的双盲派发依赖有效 `maxDepth ≥ 2`（产品默认注入，§4.6），提取步骤依赖 guard 档位 smart/full（ask 档诚实降级，§5.1）；code-review 与 task-orch 只用 read/glob/grep，不依赖这两项。环境不满足时 SKILL.md 必须如实披露降级，严禁伪造双盲或提取结果。

### 5.1 错别字检测（slug: `typo-check`）

- displayName：`错别字检测`
- description：`对指定文件夹中的 Word 文档做错别字与用语规范检测：两个独立子代理背靠背双盲检测，主代理仲裁分歧，输出带行号定位与置信度的报告。用 @typo-check 调用。`
- persona 要点：中文公文/金融文档校对专家；严谨、只报有据之错；不改动原文。
- SKILL.md 工作流：
  1. **枚举**：按用户给定路径 `glob` 匹配 `*.docx`（单文件亦支持）；逐个处理。
  2. **提取**：macOS `bash` 跑 `textutil -convert txt -output <临时目录>/<名>.txt <docx>`（系统自带，零依赖）；Windows `pwsh` 用 System.IO.Compression 读 `word/document.xml`，`<w:p>` 转换行、去标签、解实体。txt 行号即定位锚点。临时文件落工作区临时目录；清理用单文件删除（`rm <file>`，不用递归删除），或不清理并告知临时目录位置。**命令与档位约束（R9）**：每次只发单条简单命令（不用 `&&`、管道、重定向——含元字符的复合命令在非 full 档直接 deny）；ask 档（产品默认）下包子会话 bash 无审批界面、必然被拒，被拒时如实告知用户「提取被安全档位拦截，请在设置切换 smart 档后重试」，不伪造提取结果、不尝试绕过。
  3. **条件分块**：提取文本 ≤30k 字整篇检测；超过则按 ≤30k 字/块、重叠 500 字切块，逐块检测后合并去重（阈值保守值，适配宿主模型上下文）。
  4. **双盲派发**：经 `subagent` 工具派两个独立 lane；每个 lane 的 prompt 只含：检测规则（从 SKILL.md 规则节内联复制）+ 目标 txt 路径 + 输出格式要求；**不含另一 lane 的任何信息**。两 lane 会话互不可见（独立会话即双盲；运行时串行或并行调度不影响独立性）。**深度依赖（R8）**：派发要求有效 `maxDepth ≥ 2`（产品默认，§4.6）；深度不足或派发失败 ⇒ 如实披露「当前环境递归深度不足，已降级为单会话多轮自审」，严禁伪造双盲结果。
  5. **仲裁**：两路返回后主流程逐条比对——双路一致 ⇒ 高置信收录；单路报告 ⇒ 回读原文上下文裁决（成立则收录并标「仲裁」，不成立则丢弃）；两路冲突 ⇒ 回读原文给出裁定。
  6. **报告**：按文件输出发现列表：行号/段落、原文、建议、类别、置信度（双路一致/仲裁）、依据；对话输出为主，用户要求时用 bash 写报告文件。
- 检测规则来源：原项目 `错别字检测智能体/review-spec-v2.md`（7 类）与 `src/typoguard/lanes/prompts.py` 蒸馏内联（错别字/标点/用语规范/语法等类别与判据）。
- 降级声明（写进 SKILL.md 与证据）：同模型双 lane ≠ 原 DeepSeek+Kimi 跨厂商交叉验证；无 python-docx 结构化锚定（txt 行号替代）；无断点续跑；深度不足 ⇒ 单会话多轮自审（R8，如实披露不伪造双盲）；ask 档提取被拒 ⇒ 如实告知切 smart 档（R9，不伪造提取结果）。

### 5.2 代码审查（slug: `code-review`）

- displayName：`代码审查`
- description：`对指定代码文件或目录做结构化审查：按审查规格逐项检查正确性、安全、性能与可维护性，输出按严重度分级的发现与修复建议。用 @code-review 调用。`
- persona 要点：资深代码评审者；先反证再定严重度；只报有证据的问题。
- SKILL.md 工作流：read/glob/grep 读目标代码 → 按 REVIEW_SPEC 逐项审查 → 大文件条件分块（同 5.1 阈值策略）→ 输出按严重度（阻断/重要/建议）分级的发现：位置、问题、证据、修复建议。
- 规格来源：原项目 `代码审查智能体/src/spec.ts` 的 REVIEW_SPEC 逐节移植（保留审查维度/严重度定义/输出格式，剔除服务与 HTTP 相关内容）。
- 无运行时依赖，不需要 subagent（单会话审查；双盲不引入，YAGNI）。

### 5.3 任务编排（slug: `task-orch`）

- displayName：`任务编排`
- description：`把复杂任务拆解为可实施的执行计划：子任务依赖分析、每步输入产出与验收标准、顺序与并行建议、周期任务的 cron/interval 调度建议。只出计划，不执行。用 @task-orch 调用。`
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
- 按 R6（2026-11-12），本里程碑补一个 **runbook 指引任务**（实施计划 Task 14）：产出 `docs/huaanwork-three-agent-packages-release.md`，把上述生产上架步骤逐条指向 `docs/huaanwork-agent-packages-m2.md` §6（发布→离线审查→签名）、§7（安装/更新/启用）、§13（legacy 迁移仍需审查）；生产上架动作本身仍由 owner 执行。

## 7. 验证计划

0. **Spike 先行（Task 0，复审进入条件）**：实测验证 N-1（默认 depth=1 抛 `SubagentDepthError` + 产品默认 `maxDepth: 2` 的无侵入接入点与生效状态）与 N-2（ask 档包子会话 `textutil` 的实际判定），结论写入证据文档后才进入 Task 1–14。
1. **单元测试**：§4.4 全矩阵 + 三包 manifest 校验/预算断言 + 播种/发布脚本自测 + **产品默认深度回归钉（开箱有效 maxDepth = 2，R8）** + **R10 复挂钉（`tool-subagent` 组合行 `disabled: false`，主会话获得委派、maxDepth 2 约束；锁行断言同步）**。§4.4 第 7 项「主会话 subagent」钉的是*工具收窄*行为（无血缘条目 ⇒ 基线），工具可见性按 R10 放开，两者不矛盾。
2. **门禁**：`corepack yarn typecheck`、`corepack yarn test`、`corepack yarn check` 全量；**最终门禁必须在最终代码树上执行**（独立评审修复与真机脚本落盘后重跑，中间门禁不能替代；2026-11-12 终审订正）；`verify:aa` 并发竞态为已登记既有 flaky，失败时隔离重跑并如实记录。
3. **真机走查（CDP）**：用 open-latest-huaanwork 最新构建——**前置检查：有效 maxDepth ≥ 2（不满足 ⇒ BLOCKED exit 3）；隔离 profile 显式设定 guard_mode = smart 并记录（R9）；验收样例落隔离 workspaceRoot 内（工作区外 read/glob 被策略拒绝）**；广场出现三张中文名卡；详情对话框披露正确（未安装=包信息+「安装后可查看签名与文件清单」；已安装=验签结果：通过+工具「无」+沙箱警告；签名包无安装/启用确认对话框，2026-11-12 订正）；用**验收专用样例 docx**（脚本生成，含已知错别字；不用真实基金报告）跑通 typo-check，**双盲验收判据（2026-11-12 终审 N-4）：经会话头身份链（parentSession/origin/delegationDepth）定位包 child 与两个 lane，2 个不同 callId 关联非错误结果 + 两 lane 交付证据；禁文本搜索与调用计数，任何派发失败或诚实降级不得计为双盲 PASS，不可恢复 ⇒ BLOCKED 补观测缝**；顺带实测 N-3 探针（lane 存活期与清理时序）；code-review 审一段样例代码；task-orch 拆解一个样例复杂任务（如「为市场模块增加离线缓存」）并产出含依赖与验收标准的计划。**模型输出为人工核对事实（自动 PASS 只代表流程与机制通过，不宣称内容质量经过自动证明）**。
4. **独立评审**：运行时扩展（skills/policy/host/runtime/holders）走 requesting-code-review，结论经反证与严重度校准。
5. **Windows**：pwsh 提取与 win32 allow 形态做单元测试；无第二台 Windows 真机 ⇒ 真机项记 BLOCKED（R-ACCEPT-1 豁免先例），不声称跨机器通过。
6. 证据落 `docs/evidence/2026-11-11-three-agent-packages.md`（逐项命令/退出码/截图指针；CI 绿 ≠ 真机，区分 PR CI 与 master run）。

## 8. 原目录备份与延后删除（R7，2026-11-12）

1. **备份（本里程碑执行）**：`tar -czf ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz -C ~/Downloads/cursor/智能办公平台 错别字检测智能体 代码审查智能体 任务编排智能体` 打包三个原目录（含 typo `data/` 真实基金报告与 orch.db 248MB 历史），备份落仓库外。**防覆盖门（2026-11-12 终审 N-5）**：写入前检查目标不存在，存在即停止并报 owner（旧备份可能是唯一安全网，不得未经确认覆盖；owner 可另选带时间戳文件名）。**完整校验**：`tar -tzf` 完整读取归档（不截断）并逐目录核对三个顶层目录成员，记录 sha256；损坏归档应使校验非零退出。三个目录实际位于 `~/Downloads/cursor/智能办公平台/` 下（2026-11-12 订正：原稿漏了「智能办公平台」这一层，会导致 tar 失败、删除空转）。
2. **前置**：§7 验证全部通过（或如实记录 BLOCKED 项并经 owner 接受）。
3. **删除延后（本里程碑不执行）**：触发条件 = 生产上架完成（按 Task 14 runbook 指引）并稳定运行，且 owner 再次明确确认删除范围。三个目录均无 git remote，备份是唯一安全网；未经再次确认绝不删除。本里程碑只在证据文档登记备份位置/sha256/删除范围/触发条件，作为后续触发项。

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
| 产品默认深度（R8） | 注入点由 Task 0 spike 确认（huaanwork 自有 profile/配置面，上游零修改）+ 开箱 maxDepth=2 回归钉 |
| 包源文件 | 新增 `dsh-plugin-huaanwork/agent-packages/{typo-check,code-review,task-orch}/{agent.json,persona.md,skill/SKILL.md}` |
| 脚本 | 新增 `dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs`、`scripts/verify-agent-packages-plaza.mjs` |
| 测试 | 新增 `tests/huaanwork-guardrails/package-subagent-lineage.spec.ts` 等；runtime allow 既有单测扩展 |
| 文档 | 本 spec；实施证据 `docs/evidence/2026-11-11-three-agent-packages.md`；生产上架 runbook 指引 `docs/huaanwork-three-agent-packages-release.md`（R6，Task 14） |
| 不改 | `deepseek-harness/`、manifest schema、admin CLI、catalog server、广场卡 schema、测试 fixtures |