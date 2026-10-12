# 代码审查技能(code-review skill)设计

日期:2026-10-12
修订:2026-10-12 —— 落点由「profileDir 用户技能」改为「包内内置技能」(方案 E),原方案 D 降为备选。修订依据见〈方案选择〉与〈机制事实〉两节,全部为本次实测。

## 目标

把 `/Users/amonmiao/Downloads/cursor/代码审查智能体`(code-review-cli)的审查能力以 **Markdown 技能** 的形态装进 HuaAnWork:

1. 用户在对话里 `/code-review` 即可对当前工作区做严格代码审查;
2. 用户说「帮我 review 一下 / 看看有没有问题」时,**模型能自己挑到这个技能**。

第 2 条是本次修订的直接原因:原方案 D 结构上做不到(见〈机制事实〉第 1 条)。

## 背景调研结论

- 目标目录自带 `server.mjs`(为 HuaAnWork「智能体 → 本地入口」契约写的 HTTP 包装,默认端口 8765,`server.mjs:27`),方案 A(launchd 常驻 + 本地入口)可行但需常驻进程。
- HuaAnWork「智能体」页的本地入口**仅支持小工具(HTTP/MCP)**,人设由公用机目录下发(`AgentsView.tsx:542`)——Markdown 人设进不了智能体模块。
- 「技能中心」是纯 Markdown 载体:目录包 `<name>/SKILL.md` 或扁平 `<name>.md`。用户技能的存储根是 `join(storageRoot, 'skills')`(`skills-host.ts:36-38` 的 `userSkillsRoot`),内置技能的存储根是包内 `skills/`(`huaanwork-guardrails/skills.ts:334-343` 的 `resolveBundledSkillsRoot`)。技能名规则 `SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`(`huaanwork-guardrails/skills.ts:270`)。
- 解析与跳过发生在 `listRoot`(`skills-host.ts:78`:`if (!parsed.name || !parsed.description) continue`),**不是** `scanRoot`——后者(`:47-71`)只判断「目录里有没有 `SKILL.md`」,从不解析 frontmatter。
- CLI 的审查内核在 `代码审查智能体/src/spec.ts:28` 的 `REVIEW_SPEC`(安全 > 规范 > 性能 > 可维护性 + 三节输出结构)。

## 方案选择

### 第一层:载体形态

| 方案 | 形态 | 结论 |
| --- | --- | --- |
| A:launchd + server.mjs 本地入口 | 智能体页,HTTP 小工具 | 备选。功能全(任意路径、报告落盘、邮件),代价是常驻进程 |
| B:MCP server | 智能体页,MCP 入口 | 否决。新写协议包装,工作量与收益不匹配 |
| C:DSH 插件(市场分发) | profile 插件 | 否决。签名/市场流程对单机自用过重 |
| **D/E:Markdown 技能(选定)** | 技能中心,SKILL.md | 零进程零端口;审查对象限当前工作区;丢邮件与任意路径批量能力 |

### 第二层:Markdown 技能落在哪个根(本次修订新增)

三个根都被 `skill.list` 合并展示(`routes.ts:330-338`),但可达性差别很大:

| 落点 | 读取方 | 技能中心标签 | 模型可自动调用 | 进 git | 工厂重置 |
| --- | --- | --- | --- | --- | --- |
| D1 `<profileDir>/skills/`(用户技能) | fork `listUserSkills` | 「我创建的」 | **否** | 否 | 被 `trashItem` 一并删除 |
| D2 `~/.agents/skills/`(外部技能) | fork `listExternalSkills` | 「外部」 | **否**(见下) | 否 | 保留 |
| **E `dsh-plugin-huaanwork/skills/`(内置技能,选定)** | fork `listBundledSkills` + `registerBundledSkill` → `ctx.skills` | 「内置」,带启用开关 | **是** | **是** | 随包恢复 |

**D2 也拿不到模型可见性**:harness 的磁盘发现提供方 `@deepseek-ai/dsh-skill-filesystem`(其 `user-agents` rank 500 = `<agentsHome>/skills`)在 fork 里**只出现于** `packaged-filesystem-smoke.ts:5`(打包冒烟),不在 profile 装配清单内(`profile.ts:1460-1476`)⇒ 当前组合下没有任何磁盘技能提供方被加载。

**选 E 的理由**:

1. **唯一能让模型自动调用的落点**——只有经 `ctx.skills.register` 注册的技能才进模型目录,而 fork 只注册内置技能(`skills.ts:431` 的 `registerBundledSkill`、`skills-host.ts:432-444` 的 `restoreEnabledBundledSkills`)。
2. **有仓库内权威副本**——可评审、可回滚、可 diff。D1 的唯一副本在 Application Support 里,`desktop-factory-reset.ts:91-92` 会把整个 homeDir(含 `profiles/huaanwork/skills/`)trash 掉。
3. **打包零改动**——`dsh-plugin-huaanwork/package.json` 的 `files` 已含 `"skills/"`,新目录自动进包。
4. **变体守卫白名单成本 0**——守卫只比较 `dirs: ['src','scripts']`(`scripts/verify-desktop-variants.mjs:65`、`:97`),而 `skills/` 不在其中;且 stable/beta 两包**均无** `skills/` 目录(实测),不存在对侧漂移。(注:守卫在 HEAD 上**本就红**——`f9fd375243` 给 huaanwork 的 `src/electron-shell-generation.ts` 加了 5 行未声明漂移;与本方案无关,归因与处置见计划 Task 3 Step 3。)

**选 E 的代价(必须登记)**:

1. **这是产品行为变更**,不只影响本机——所有内网用户都会在技能中心看到 `code-review`。已由用户 2026-10-12 裁定接受。
2. **内置技能默认禁用**。`skill.list` 的判据是 `enabled: SYSTEM_SKILLS.has(name) || toggles[name] === true`(`routes.ts:333`),而 `SYSTEM_SKILLS` 只有 `explore`/`test-fix`(`skills.ts:383`)⇒ 装完必须在技能中心打开开关,否则既不进斜杠补全(`skillsLogic.ts:58-60`),硬调用也会被拒(`skill-invoke.ts:25-27` 抛 `skill code-review is disabled`)。
3. **撞两处测试硬钉**,须同改(见〈交付物〉的连带改动)。

## 相对 CLI 规范的三处升级

1. **默认审 `git diff` 未提交改动**而非全仓扫;工作区干净时询问是否全量审查。
2. **证据纪律硬化**:每条问题必须附真实读到的代码片段 + 文件:行号;存疑降级 info;宁缺毋滥。CLI 原规范允许「行号无法精确定位可写为『文件』或『文件:约N』」(`spec.ts:45`),本技能**刻意收紧**为「读不到代码的位置不许报」。
3. **严重度给判定锚点**(critical/high/medium/low/info 各一句标准),保证统计口径稳定。

CLI 的 150s/32KiB/串行分块是进程约束,不搬进技能;以「按模块分块、重要文件优先」的软指令替代。

另补一条 CLI 规范里没有、但本载体需要的边界:技能正文注入时,宿主会附加一行「技能目录:`<resourceDir>`」并说明「若技能引用 scripts/ 等相对路径,以技能目录为准」(`skill-invoke.ts:47-48`),而内置技能的 `resourceDir` 就是 `skills/code-review`(`:33`)⇒ 正文必须显式声明**审查对象是会话工作区(cwd),不是技能目录**,否则相对路径有被解释到包目录里的空间。

## 交付物

### 落点

`dsh-plugin-huaanwork/skills/code-review/SKILL.md`(目录包形态,与 21 个既有目录型内置技能同构)。卸载 = 删除该目录 + 回退测试断言。

### 连带改动(不改则 `vitest` 红)

`dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts` 两处:

- `:435` 的测试标题「exactly 23 names」与 `:440-449` 的 `assert.deepEqual` 全量名单——按字母序插入 `"code-review"`(位于 `brainstorming` 与 `darwin-skill` 之间);另补一条 `assert.equal(byName.get("code-review"), "bundle")`。
- `:457` 的 `assert.equal(names.length, 23)` → `24`。

### SKILL.md 最终内容

```markdown
---
name: code-review
description: 严格代码审查,产出中文 Markdown 报告(总览/严重度统计/问题清单)。审查维度优先级:安全漏洞 > 代码规范 > 性能 > 可维护性,每条问题必须引用真实读到的代码作证据。当用户用 /code-review,或要求「审查代码/review 一下/看看有没有问题」时使用;默认审查未提交改动,用户明确要求时才全量审查指定目录。不要用于:解释代码、检查错别字、格式检查、用户已指明具体问题只要修复的场景。
argument-hint: "[可选:审查范围,如某个目录名或「全部」]"
---

# 代码审查

你是一名资深代码安全与质量审查专家。

## 第一步:圈定范围(不要跳过)

审查对象是**本轮会话的工作区(cwd)**。本技能所在目录只用于存放这份说明,不是审查对象,不要对它跑 git 命令。

- 用户指定了目录/文件 → 审指定范围。
- 未指定 → 在工作区跑 `git status` + `git diff`(含暂存区),审未提交改动;工作区干净时,告知用户并询问是否全量审查,不要自作主张全仓扫。
- 工作区不是 git 仓库,或没有任何代码 → 直接答「无可审内容」,不要编造问题。

## 第二步:分块阅读

按模块/目录逐块真实阅读代码。范围大时先列文件清单、按变更量排序,重要文件(鉴权、IO、数据处理)优先。不要只读文件名和 diff 摘要就下结论。

## 第三步:按优先级审查

1. 【最高】安全漏洞:命令/SQL/代码注入、XSS、CSRF、鉴权与授权缺陷(越权、未校验身份)、密钥硬编码与泄露、不安全反序列化、路径穿越、弱加密或不安全随机数、日志打印密钥。任何安全类问题都标记较高严重度。
2. 代码规范:命名、结构、重复代码、异常处理、日志规范、可读性。
3. 性能:不必要的循环/IO、N+1 查询、同步阻塞、内存泄漏风险。
4. 可维护性:模块耦合、魔法数字、缺失注释、接口设计、可测试性。

## 证据纪律(硬约束)

- 每条问题必须附:文件:行号 + 你真实读到的代码片段引用。读不到代码的位置不许报。
- 只基于真实读到的内容下结论,禁止凭语言/框架的「常见毛病」臆测,禁止编造文件内容。
- 存疑的降级为 info 并在描述里写明「待人工确认」;拿不准又不是安全相关的,不报。
- 禁止「以防万一」式灌水:宁缺毋滥。

## 严重度锚点

- critical:可直接利用的安全漏洞、数据丢失/损坏、服务必崩。
- high:较可能触发的事故隐患(鉴权绕过、资源泄漏、明显逻辑错误)。
- medium:真实可感的质量/性能问题,不修会累积。
- low:风格、可读性、小改进。
- info:存疑待确认、建议性观察。

## 输出格式

直接输出 Markdown,不要用代码块包裹整体内容,中文:

## 总览
(2-4 句整体结论,先说安全状况;审查范围一句话交代)
## 严重度统计
(critical / high / medium / low / info 各计数,可用表格或列表)
## 问题清单
(表格,列:文件:行号 | 严重度 | 类型 | 描述(含代码引用) | 建议)

建议必须可执行(改什么、怎么改),不写「建议加强」式空话。问题描述要具体、可复现。某严重度无问题写「无」但保留结构。

## 收尾

报告默认只输出到对话;用户要求落盘时才写入工作区文件(如 review-report.md)。
```

## 机制事实(本次实测,勿再凭印象继承)

1. **只有内置技能对模型可见。** fork 只把内置技能注册进 `ctx.skills`:`skills.ts:115-116` 无条件注册两个系统技能,`registerBundledSkill`(`:418-438`)按开关注册其余内置技能,boot 期由 `restoreEnabledBundledSkills`(`skills-host.ts:432-444`)恢复。profile 装配清单(`profile.ts:1460-1476`)里没有任何磁盘技能提供方。用户/外部技能只经 `resolveInvocableSkill`(`skill-invoke.ts:21-30`)在**用户显式 `/` 点名**时被读取,模型目录里根本不存在它们。
2. **内置技能默认禁用,启用即时生效、无需重启。** `setSkillEnabled`(`skills-host.ts:391-418`)先写 `skill-toggles.json`,再 dispose-then-register 到运行时 ⇒ 在技能中心打开开关当轮即可用,不需要重启进程。
3. **技能列表每次调用都实读磁盘。** `skill.list`(`routes.ts:327-341`)每次都跑 `listUserSkills`/`listExternalSkills` → `scanRoot` → `fs.readdir`;客户端拉取它的 effect 依赖是 `[view, ready, sidecarDead]`(`App.tsx:437`)⇒ **从技能中心切回主界面就会重新拉取**。改技能文件后不需要重启应用。
4. **硬调用不查客户端目录。** `parseSlashInvoke`(`skillsLogic.ts:101-106`)直接解析草稿文本,`session.send` 只带 `skill: <name>`(`App.tsx:1452`),名字解析在服务端 ⇒ 即使斜杠补全目录未刷新,`/code-review` 也能触发。
5. **`argument-hint` 是装饰性字段。** `MANAGED_KEYS` 只有 `name`/`description`/`whenToUse`/`disable-model-invocation`/`user-invocable`(`skills.ts:272`),其余键落进 `extraLines`(`:306`)并在编辑时原样保留(`skills-host.ts:255`)⇒ 不报错、也不生效。上游明写「`arguments` 与 `argument-hint` …注册表、本地提供方和面向模型的工具不解析、不广播、也不强制执行这些字段」(`deepseek-harness/.agents/notes/archived/feature/2026-07-05-skill-system.zh.md:58`)。**保留它的理由是与同目录 `investigate/SKILL.md` 的先例一致**,不要指望它在界面上显示参数提示。
6. **`SkillRegistration` 不承载调用策略。** 其形状是 `{name, description, content, source, resourceBase?}`(`skills.ts:35-41`),`registerBundledSkill` 也只传这五项(`:431-437`)⇒ `disable-model-invocation`/`user-invocable` 仅由 `skill.get` 回给界面展示,**不经这条注册路径强制**。本技能两者都取默认(模型可调用、用户可调用),故不落这两个键。
7. **解析器限额(实测本文件均通过)。** `MAX_SKILL_NAME_LENGTH = 64`、`MAX_SKILL_DESCRIPTION_LENGTH = 1024`、`MAX_SKILL_CONTENT_BYTES = 64 KiB`(`skills-host.ts:154-156`)。本技能:`name` = `code-review`(过 `SKILL_NAME_RE`)、`description` = **204 字符**、正文 = **2827 字节**。与既有 23 个内置技能**无撞名**(`takenNames` 会拒绝同名,`skills-host.ts:169-173`),也不撞 `RESERVED_SLASH = "schedule"`(`skillsLogic.ts:64`)。
8. **description 里的中文触发词只服务模型选择与列表展示。** 斜杠补全虽然同时匹配 name 与 description(`skillsLogic.ts:89`),但 `slashTokenAt` 要求 `/` 后只能跟 `[a-z0-9-]`(`:76`)⇒ 中文查询形不成 token。方案 E 下这段文案的真实消费方是**模型**(经 `ctx.skills`),这正是选 E 的收益。

## 验证

1. `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-host/skills-host.spec.ts tests/client-huaanwork/skillsLogic.spec.ts` 全绿(基线:改断言前 43 passed;改断言未落文件时恰好 2 红)。
2. `corepack yarn workspace dsh-plugin-huaanwork typecheck` 绿。
3. 应用内:技能中心「内置」标签出现 `code-review`,**打开启用开关**(切视图即刷新,无需重启)。
4. 对话内 `/code-review` 冒烟:确认默认走 diff 路径、报告符合三节结构、每条问题带文件:行号与代码引用。
5. **本轮不做**:与 CLI `--mock` 产出对比维度覆盖(原 spec 的可选第 3 步)。需要时另起一轮。

## 边界与错误处理

- **工作区特别大**:正文的分块指令防上下文溢出;模型忽略时下次调用口头补「分块审查」即可。
- **工作区无代码 / 非 git 仓库**:正文第一步已要求直接答「无可审内容」,不得编造问题。
- **技能未触发**:先分清两种情形——(a) 用户没用 `/` 前缀、且技能**未启用** ⇒ 模型目录里没有它,属预期,去技能中心打开开关;(b) 已启用但模型没选它 ⇒ 属模型遵循度问题,记录现象,不改文件。
- **能力缺口**(任意路径批量、报告落盘文件、邮件)出现时,回到方案 A 补 HTTP 入口,二者可共存。
