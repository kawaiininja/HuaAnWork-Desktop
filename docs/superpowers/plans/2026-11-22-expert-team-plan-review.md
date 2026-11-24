# 《专家团多智能体协作》实施计划评审意见（Plan Review）

- **评审对象**：[`docs/superpowers/plans/2026-11-22-expert-team.md`](./2026-11-22-expert-team.md)（首轮 2039 行；第二轮复核为修订后全文）
- **对照基准**：
  - 设计规格：[`docs/superpowers/specs/2026-11-21-expert-team-design.md`](../specs/2026-11-21-expert-team-design.md)（当前 799 行，第三轮规格评审已通过）
  - 规格评审：[`docs/superpowers/specs/2026-11-21-expert-team-design-review.md`](../specs/2026-11-21-expert-team-design-review.md)
  - 质量基准：`superpowers:writing-plans` 的规格覆盖、可执行断言、跨任务类型一致
  - 代码基线：外层仓库 `ed823cde6614a090ddacac1a4f934d1652ffb332`（与计划所写基线、当前 `HEAD` 一致）；上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`
- **评审日期**：2026-11-22
- **评审方式**：按规格逐节对照计划任务，并抽查当前源码与既有测试。未修改设计规格、实施计划或产品代码
- **首轮结论（2026-11-22，针对修订前 2039 行）**：**未达到可直接实施的质量基准（NO-GO / ITERATE）**。阻断 4，同轮应补 3，不阻断 2
- **第二轮复审结论（2026-11-22，见 §6）**：**已达到实施标准（GO）**。§5 的 7 条复审入口均已落入计划正文。可以按 Task 1–18 实施。实施时按 `reviewVerdicts` 逐条消费，并让 256 KiB 助手按「合计字节」生成 `task`

严重度口径：

- **阻断**：按当前计划文本实施会写出错误产品行为，或让该任务自己列出的测试门禁失败
- **同轮应补**：规格已点名的测试还没有可执行断言，实施时会靠人补判断
- **不阻断**：定位或引用不准确，正文里的行为规则仍然可执行

计数：阻断 4，同轮应补 3，不阻断 2。0 项要求推翻总体架构。

---

## 1. 已对齐、可保留的部分

规格主链路已经落进任务，当前代码事实也与计划基线相符：

- 计划头、Global Constraints、18 个任务的文件、接口、失败测试、运行命令和提交步骤齐全
- 规格里必须守住的决定都有任务承接：忽略 `reasoning`、当前 `turn/end` 同步封闭、24 次预算耗尽后的部分 Artifact 豁免、派工不传 `teamRunId`、不使用 `outputSchema`、`delivery: 'caller'`、纯内存有界运行、`SESSION_ATTACHED_TOOLS` 与 `decide()` 同时放行
- 当前 `ROUTE_TABLE` 确实是 83 条；`ContentBlockMap` 确有 `text`、`reasoning`、`image`、`file`、`tool-call`
- 团队目标 `at: { kind: 'expert-team', name }` 与规格 §11.3 一致。需要改的是旧 `@` 断言，不是这条新目标

---

## 2. 阻断项（修订计划后再开工）

### B-1 Task 15 的旧 `@` 断言与规格、现有回归测试相反

- **位置**：计划 Task 15 Step 1，约 1646–1654 行；通过命令包含 `tests/client-huaanwork/appWiring.spec.ts`
- **规格**：§11.3。旧智能体继续使用 `at.name` 与 `at.clientMessageId`；`kind` 缺省时走旧路径。专家团目标不携带旧卡兼容字段
- **现有测试**：`dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts` 1254–1282 行。`invokedAt` 的结果是 `{ name, clientMessageId: String(userItemId) }`，`userItemId: 7` 时 `clientMessageId` 为 `"7"`
- **计划断言**：`expect(legacyParams.at).toEqual({ name: 'writer' })`，`userItemId` 为 2
- **后果**：按新测试实现会丢掉旧 `@` 卡锚点，并让 `appWiring.spec.ts` 失败。保留现有行为则计划里的新测试失败。两种走法都不能让 Task 15 的通过命令成立
- **修订**：
  1. 旧路径期望改为 `{ name: 'writer', clientMessageId: '2' }`
  2. 把 `SessionSendParams.at` 写成判别联合：旧目标保留 `name` + `clientMessageId` 且无 `kind`；专家团目标为 `{ kind: 'expert-team', name }` 且不带伪造的 `clientMessageId`
  3. 团队目标断言 `{ kind: 'expert-team', name: 'compliance' }` 保持不变

### B-2 Task 11 使用了没有任何任务定义的 `teamSlug`

- **位置**：计划 Task 11 Step 1，约 1238 行：`runs.activeBySession('s1')?.teamSlug`
- **规格与前序任务**：§8.3 的 `ExpertTeamRun` 只有 `teamSnapshot`。Task 3 的 registry 接口同样只产出这份运行对象，没有 `teamSlug`
- **后果**：在 `exactOptionalPropertyTypes` 与现有严格检查下，这行断言无法通过类型检查。实施者若为了让测试编译而给运行对象加字段，会偏离规格 §8.3
- **修订**：断言改为 `runs.activeBySession('s1')?.teamSnapshot.slug === 'compliance-team'`。不要新增 `teamSlug`

### B-3 Task 4 漏了第 4 处写死的路由总数 83

- **位置**：计划 Task 4 Step 1，约 461 行。任务要求把 `route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts` 三处从 83 改为 92
- **源码**：`dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts` 234–236 行仍断言 `ROUTE_TABLE` 长度为 83。该文件不在 Task 4 的 Files、测试命令或 `git add` 清单中
- **后果**：Task 4 自己的命令可以显示通过。完整 `corepack yarn test` 与 Task 18 的 `corepack yarn check` 会在市场路由测试失败
- **修订**：Task 4 的 Files、Step 1、测试命令和提交清单加入 `tests/huaanwork-host/market-routes.spec.ts`，把该断言同步改为 92。新增 9 条路由后的总数仍是 83 + 9 = 92

### B-4 Task 17 的双审查员判决序列对不上期望终态

- **位置**：计划 Task 17 Step 1，约 1842–1850 行
- **冲突**：
  - 默认场景有 2 次 `review`，`reviewVerdicts: ['revise', 'pass']` 可以按派工逐条对应，随后一次返修再通过，终态 `completed` 与默认 `maxRevisionRounds: 1` 一致
  - 双审查员场景的派工序列是 `execute, execute, review, review, revision, review, review`，共 4 次 `review`，仍只给出 `['revise', 'pass']`，并期望 `status === 'completed'` 且 `memberRunIds` 长度为 7
- **后果**：若 driver 按同一数组循环填充 4 次审查，第二轮仍会出现 `revise`。默认返修额度只有 1 轮，终态应为 `completed_with_issues`，与该测试的 `completed` 冲突。实施者必须临时决定判决表，两种合理读法会得到不同终态
- **修订**：写明 4 次审查的判决，并让 driver 按审查派工顺序消费，不循环复用短数组。与「第一轮有人要求返修、返修后全员复审通过」一致的一组是：`revise`、`pass`、`pass`、`pass`。期望派工序列和 `completed` 保持不变

---

## 3. 同轮应补的规格测试

这三项不推翻已写明的运行规则。它们是规格 §18.1 已点名、计划尚未钉成失败测试的行为。应在修订 B-1～B-4 时一并写入对应任务。

### I-1 256 KiB 边界测试没有钉住字节边界

- **规格**：§12.2 与 §18.1。`task`、渲染后的引用结果、成员职责和输出要求合计最多 256 KiB UTF-8；中文和 emoji 按实际字节计；超限在启动成员前拒绝，不静默截断
- **计划**：Task 8 Step 4 已要求 `Buffer.byteLength(..., 'utf8')`。Step 1 唯一的具体测试是 `'汉'.repeat(256 * 1024)`，约 768 KiB，只证明超大输入被拒绝
- **修订**：补两条断言：合计恰好 256 × 1024 字节时允许启动；多 1 字节时拒绝且不启动成员。其中一条使用中文或 emoji，证明按 UTF-8 字节而不是 UTF-16 码元计数。包 `persona` 继续走它自己的 64 KiB 上限，不计入这 256 KiB

### I-2 父会话工具池并发没有测试

- **规格**：§10.2 与 §18.1。实际并行上限取团队 `maxParallel`、父会话 `maxParallelToolCalls` 和上游剩余子智能体容量的最小值。`isConcurrencySafe` 返回 `true` 后，工具池与 Host 信号量都要限制实际并发
- **计划**：Task 9 断言 `isConcurrencySafe?.({}) === true`。Task 8 断言团队信号量把 4 个派工限制为最多 2 路。没有「团队 `maxParallel` 为 4、父会话 `maxParallelToolCalls` 为 1 时只跑 1 路」的测试
- **修订**：在协调器或真实工具执行组合里补这个最小值用例。容量不足仍返回明确错误并计入 24 次预算，不隐藏重试

### I-3 Task 6 的核心规则仍是「另写测试」

- **位置**：计划 Task 6 Step 1，约 660 行。Step 3 约 676–688 行已经写出规则正文
- **尚未成测试的规则**：`sequential` 首轮顺序与前序引用；`execute + supersedesResultId` 只能重试同成员失败或停止的 `execute`；`unified` 首份返修开启周期、同周期多份返修、下一次全员审查关闭周期；`per-member` 按结果链 `revision` 次数计数；`artifactLinkError` 存在时终态为 `partial`；`broadcast` 缺员只在 `dispatchAttempts >= 24` 且无在途、至少一份有效结果时豁免
- **修订**：把上述每一条写成 Task 6 的失败测试和期望错误码，再进入实现。不要留到实施者阅读 Step 3 时自行补断言

---

## 4. 不阻断

### N-1 `assertSafePathSegment` 的归属写错

计划 Task 2 的 Consumes 把它写成 Task 1 的产物。该函数已在 `dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts` 导出。修订时写上这条导入路径，避免实施者在契约模块里再实现一份。

### N-2 Task 13 引用了不存在的规格小节

计划 Task 13 Step 3 写「遵守规格 §16.2/§16.4」。规格 §16 是 11 条编号不变量，没有这两小节。对应规则在 §8.5 与 §13.3。该步下面的 reducer 语义可以保留，把引用改到这两节。

---

## 5. 复审入口

计划修订后只复审本文件 §2 与 §3：

1. Task 15 旧 `@` 断言带 `clientMessageId`，团队 `at` 为 `{ kind: 'expert-team', name }`，且 `appWiring.spec.ts` 仍在该任务的通过命令中
2. Task 11 使用 `teamSnapshot.slug`，`ExpertTeamRun` 没有新增 `teamSlug`
3. Task 4 的文件、命令和提交清单包含 `market-routes.spec.ts`，83 改为 92
4. Task 17 双审查员的 4 次 `review` 各有明确判决，判决表不被短数组循环复用
5. Task 8 有恰好 256 KiB 与多 1 字节的 UTF-8 测试
6. 有 `maxParallel: 4` 且 `maxParallelToolCalls: 1` 时只启动 1 路的测试
7. Task 6 的返修周期、技术重试、`broadcast` 豁免和 `artifactLinkError` 都有失败测试

七项都落在计划正文里之后，本文结论改为 GO，再按任务实施。第二轮复核见 §6。

---

## 6. 第二轮复审（修订稿，GO）

对照 §5 的 7 条入口复核修订后的计划。7 条都已写进对应任务的失败测试或接口说明。

| 入口 | 修订落点 | 结论 |
| --- | --- | --- |
| 旧 `@` 保留 `clientMessageId`，团队 `at` 为 `{ kind: 'expert-team', name }`，`appWiring.spec.ts` 仍在通过命令中 | Task 15 约 1711、1722、1741、1755 行 | **闭环** |
| 使用 `teamSnapshot.slug`，不新增 `teamSlug` | Task 11 约 1306 行 | **闭环** |
| `market-routes.spec.ts` 进入 Task 4 的文件、命令和提交清单，83 改为 92 | Task 4 约 408、462、470、511、520 行 | **闭环** |
| 双审查员 4 次 `review` 的判决为 `revise, pass, pass, pass`，禁止短数组循环 | Task 17 约 1914–1918 行 | **闭环** |
| 恰好 256 KiB 通过、多 1 字节拒绝，并覆盖多字节字符 | Task 8 约 957–966 行，样本含 `审🧪`，且 48 KiB `persona` 不计入 | **闭环** |
| 团队 `maxParallel: 4`、父会话 `maxParallelToolCalls: 1` 时实际并发为 1 | Task 17 约 1921–1926 行 | **闭环** |
| 顺序、技术重试、统一返修周期、逐成员额度、`broadcast` 豁免、`artifactLinkError` 均有失败测试 | Task 6 约 645–714 行 | **闭环** |

N-1、N-2 也已改掉：`assertSafePathSegment` 指向 `workspace-state.ts`；Task 13 的引用改为 §8.5、§13.3、§16。

实施时守住两处读法，不必再改计划：

1. `exactTaskForBytes` 返回的 `task` 与职责、输出要求、引用结果合计为给定字节数。`task` 本身等于 256 KiB 时，加上职责就会被正确实现拒绝。
2. `reviewVerdicts` 按审查派工逐条消费。`['pass', 'pass']` 表示两名审查员首轮都通过，不进入返修。`maxParallelToolCalls` 是上游 AgentLoop 的 volatile 配置，桌面 profile 目前不单独暴露该字段；组合测试要把本场景的 AgentLoop 上限设为 1，并在同一步发出多个 `expert_team_dispatch`，再测量重叠的成员运行数。

---

## 7. 第三轮独立反证复核（规格全量 + 源码核实，2026-11-22）

- **复核方式**：不采信 §6 的 GO。按规格 §1–§19 全量逐节对照计划，并对计划所引现有源码在当前 HEAD `ed823cde66`（上游 pin `1600d8a1e1`）独立核实：三路并行评审（Host 运行时 / 契约纯函数 / 客户端与组合）+ 主审对承重前提与候选阻断逐条反证。未修改规格、计划或产品代码。
- **结论**：**未达“可直接照着写”的干净 GO，需一轮短修订（ITERATE → GO）**。架构与全部承重源码前提核实成立，§5 的 7 条闭环确已落入正文；缺口集中在“把已写明的规则钉成可执行断言 / 接线”，不需推翻设计。
- **计数**：阻断 1，同轮应补 16（接线/兼容/门禁 5 + 规格点名测试覆盖 11），不阻断 8。owner 拍板 1 已下：旧 `@` 菜单**保留任意位置触发**（I-2，2026-11-22）；该条仍属同轮应补，待落进计划正文。

### 7.0 已独立核实成立的承重前提（节选）

| 前提 | 源码证据 | 结论 |
| --- | --- | --- |
| `turn/start` 先于 `agent/inbox/claimed` | `agent-loop/src/agent.ts:307` append `turn/start`；`:271` `inbox.claim` 在 `preStep` 内 | 成立 |
| `turn/end` 先于 idle / goal 续拍 | `agent.ts:387` finally append `turn/end`；`:392` 才判 `hasPending` | 成立 |
| `ROUTE_TABLE` = 83，新增 9 → 92 | `routes.ts` 83 个 `method` 条目；硬编码 83 在 4 文件 7 断言 | 成立（措辞见 N-7） |
| 旧 `@` 兼容锚 + appWiring 正则 | `appWiring.spec.ts:1247-1251` `assert.match`（存在性）；`:1277-1282` `at={name,clientMessageId:"7"}` | 成立 |
| caller 不发父结算 / output 为 `ContentBlock[]` | `subagent/manager.ts:1188` 早返回；`types.ts:259` | 成立 |
| commit 重放返回持久 manifest 锚 | `artifacts-host.ts:468-471` + `toSummary` | 成立 |
| 严格可选属性 / 索引收窄 | `tsconfig.json:18,21`；`tsconfig.tests.json` extends 且含 host tests | 成立 |
| smoke 先 seed desktop-shell | `verify-profile-boot.mjs:98-101` writeFileSync；`:157` `patches=[...patches,...overlays]`（overlays 不含 desktop-shell） | 成立 |
| 客户端参考 reducer 每次 snapshot 恢复 live | `client-huaanwork/logic/subagentRuns.ts:219-224` `connection:"live"` | 成立（见 B-1） |

### 7.1 阻断（修订后再开工）

**B-1 Task 13 同代重连永不解冻 → 团队卡永久禁用**

- **位置**：计划 Task 13 Step 3（1556-1560）、动作联合（1547-1551）；Task 16 Step 4 点 1/3（1869、1871）
- **规格**：§13.3 / §8.5（同一 Host generation 内断连重连按 `runList` 快照对账并恢复操作）
- **源码反证**：参考 reducer `subagentRuns.ts:219-224` 对**每次** snapshot 返回 `connection:"live"`。计划 `ExpertTeamRunsState` 用 `connection:'open'|'closed'` + `frozenAt`，`disconnect` 置 `'closed'`，但 snapshot 规则只在**换代**时“解除 frozenAt”，同代 snapshot 只讲合并/淘汰，且动作联合无 `reconnect`/`open` 动词，`connection` 也无任何复位路径 → 照正文实现，同代重连后 `connection` 仍 `'closed'`、`frozenAt` 仍在，终止/预览按钮永久禁用。
- **测试缺口**：现有只覆盖换代解冻（1503-1511，g1→g2）；Task 16 卡片测试（1832-1839）同样只测换代。同代重连（最常见路径）无断言。
- **反证校准**：计划写“语义与 `subagentRuns.ts` 对齐”，指向正确行为，但显式 bullets + 动作联合 + 测试均遗漏，照正文实施会写出错误行为，故定阻断而非纯措辞。
- **修订**：任何 snapshot（含同代）恢复 `connection='open'` 并清 `frozenAt`；补一条“同代重连后操作重新可用”的失败测试。

### 7.2 同轮应补 A — 接线 / 兼容 / 门禁（5）

- **I-1 `unifiedRevisionRounds` 递增没有写者**。Task 6（738）`validateDispatchRule` 是纯函数，只返回 `opensUnifiedRevisionCycle`；Task 8 Step 3/4（1024-1034）列举协调器 mutation 却从未消费该 flag。规格 §10.4 / §16.6 硬返修上限。若未接线，unified 返修在 24 次预算内可无限循环。Task 6 测试预置 `counter=1` 故通过，无跨派工集成断言。**修订**：Task 8 明确 `flag=true` 时 `registry.update(unifiedRevisionRounds += 1)`，cycle 开/闭由结果链派生（§8.3 无 `cycleOpen` 字段），补跨派工额度耗尽断言。
- **I-2 旧 `@` 菜单触发被悄悄收窄（owner 已拍板：保留任意位置触发）**。源码：`agentsLogic.ts:42-53` `atTokenAt` 匹配草稿**任意位置**的 `@` 词，`App.tsx:1230` 用它驱动菜单。计划 Task 15 `composerAtTokenAt` 仅识别**开头** token（测试 1694 `'正文 @合规'→undefined`），Step 4（1761）“菜单触发改用 `composerAtTokenAt`”整体替换 → 正文中段 `@agent` 不再弹补全，属旧 UX 回归。规格硬约束是 parse/send 不变（已守住），但 R15“保持兼容”与计划自称“旧路径不改”存在张力。**裁定（2026-11-22，owner）**：保留任意位置触发——智能体分组沿用 `atTokenAt` 的任意位置匹配，仅 team 分组 / `parseTeamAtInvoke` 限开头，不得整体替换 `App.tsx:1230` 触发。**修订**：据此改 Task 15 Step 3/4，并补“正文中段 `@agent` 仍弹补全”的回归测试。（`App.tsx:3035` `pickAtAgent` 仍用 `atTokenAt`，插入仍可用。）
- **I-3 Task 17 smoke 重复插入 desktop-shell**。源码：`verify-profile-boot.mjs:98-101` 已 seed 进 patch 文件并折进 `prepared.patches`，overlays 不含 desktop-shell。计划 Step 4（2010）在 `[...prepared.patches,...prepared.overlays]` 后再 append `{insert:[DESKTOP_SHELL_PATCH_ENTRY]}`，又自称“完整复用”（含 seed）→ 重复行，危及 Task 17 自身 smoke 门禁。**修订**：seed 与 overlay-insert 二选一，钉死。
- **I-4 `undefined` 字面量触发最终 tsc 门禁 + fixture 字面量未钉**。`tsconfig.json:18` `exactOptionalPropertyTypes` 开，`tsconfig.tests.json` 含 host tests。计划 Task 6（702）`primaryArtifactId: undefined` 若 overrides 类型为 `Partial<ExpertTeamRun>` 则 tsc 报错（Task 2/4/18 的 `tsc -p tsconfig.tests.json` 会失败）。**修订**：删冗余 `undefined` 键或把 overrides 类型显式允许 `undefined`；并在 Task 1 钉死共享 fixture 字面量（slug `compliance-team`、name 含“合规”、scenarios“条款复核”、成员 `writer`/`reviewer`、每次返回新对象），澄清 Task 6 工厂 `memberId` 覆盖与 `cycleOpen` 由结果链派生。
- **I-5 `attachments.has(...)` 不是真实附件 API**。源码：`agent-attachments.ts:1-4` `AttachmentMaps={sessionHostTools,sessionAgentTools}`，参考用法 `package-subagent-lineage.spec.ts:162` `h.attachments.sessionAgentTools.has(...)`。计划 Task 7（795）/ Task 9（1088、1091、1093）直接 `attachments.has('parent'/'expert_team_dispatch')`，若 fixture 镜像真实约定则 `TypeError`、自身 vitest 门禁失败。**修订**：钉死 fixture 投影（返回 Map/Set，或显式 `sessionAgentTools.has` / `isAgentToolAttached`）。

### 7.3 同轮应补 B — 规格点名测试覆盖（11）

1. **S-1** Task 12 同 `callId` 重放无法区分“持久锚 vs 当前锚”关联（1413-1422；`goalContinuation:true` 非真实 `result_present` 参数，且 goal 续拍保留锚 → 错误实现读 `current()` 也通过）。§12.4.1 / §18.2。修订：重放用例设**不同**当前锚，断言关联落到 replayed summary 的 `artifact.anchor`，且只发一次 `artifact/created`。
2. **S-2** Task 11 只测 `clientMessageId` undefined（1293-1305），缺“顶层 id 存在 → 只算一次、run/anchor/followup 同 id”断言。§17 / §18.2 第 5 条。
3. **S-3** Task 11 缺“团队回合结算 + 附件清理后才放行下一条排队消息”的顺序断言（现有只测 ordinary→team）。§12.4.2 / §18.2 第 2 条。
4. **S-4** Task 6 Expected（753）自称“0/1/2 轮 + 全部终态”，实测只 `round=1` 与 `partial`/`completed_with_issues`。§18.1。补 round 0/2、`failed`（无有效执行）、`completed`、message 模式 `finalSummaryPresent=false→partial`。
5. **S-5** `none` 模式禁 review/revision（734）与 per-member scope 必须单例（731）仅 prose，无拒绝断言。§10.4 / §18.1“三种审查模式”。
6. **S-6** Task 8“per-member concurrency”测试（922-934）派 4 个**不同**成员，未断言同成员两派工串行。§10.2 / §18.1“单成员并发”。
7. **S-7** Task 3 Expected（384）自称覆盖 `cancelAll` + 默认 20/100，实测用 1/2 且从未调 `cancelAll`。§18.1。补默认上限淘汰 + `cancelAll` 收敛断言。
8. **S-8** Task 14 编辑器多项规格行为仅 prose（1643-1649）：启停 toggle + 已停用排除 `@`、配置不完整态、离开未保存确认、message 模式隐藏格式、无 reviewer→none 联动、字段错误保留草稿。§7.2 / §7.3 / §9 / §18.3。补 harness 断言。
9. **S-9** Task 16 只断言 `completed_with_issues ≠ partial`（1823-1830），缺 7 态两两不同文案、成员结果版本/替代/`invalid-verdict` 行展开、关联异常时 Artifact 卡仍可见。§13.2 / §18.3。
10. **S-10** Artifact **写失败**无任务归属：§18.4 样例 6“Artifact 写失败”、§17“prepare/commit 失败后 idle→partial/failed”。Task 12 只测取消 discard + 关联失败，Task 17 未含，Task 18（2112）只列关联失败。补 Task 12/17 写失败结算用例 + Task 18 真机项。
11. **S-11** 缓存团队已停用/删除 → Host 拒绝不回退（§17）、不同 profile 定义隔离/投影不泄漏（§18.2）均无断言。Task 11 prose 出队前复验但未点名 disabled/deleted 拒绝与 no-agent-fallback；Task 2 隔离仅结构性。各补一条。

### 7.4 不阻断（8）

- **N-1** 真正丢 `kind` 的点是 `sessions.ts:1346`（重建 `at:{name,clientMessageId?}`），计划只点 turn-scheduler 透传；排队测试会强制修，补引该行。
- **N-2** `AgentPackageDispatchContext`（`host.ts:72-88`）未列入新 Map 字段（仅 typecheck）；`skills.ts:693` `specChildId` 在 `:685` 读 `pkg` 之后算，Map-first 取需调序。
- **N-3** `ResultPresentClaimedContext`（`result-artifact-tools.ts:132-135`）claim 门控也需 runs holder，不止 `ToolContext`。
- **N-4** 观察器异常被上游收容（`session/index.ts:399-409`），`onTurnEnd` 内 `settleExpertTeamTurn` 抛错会被静默记录；计划只给 claim handler fail-closed `agent.cancel`（1128），结算点缺同等守卫/测试（§16.10）。
- **N-5** `expert-team-terminal` 在 Task 11/17 被断言（1325、1958、2001），Task 8 prose（1024、1031）只说“明确拒绝错误”未命名；枚举拒绝码。
- **N-7** “全部 4 处硬编码 83”实为 4 文件 7 断言（`route-contract.spec.ts:424,425`；`routes.spec.ts:56,222`；`market-routes.spec.ts:236`；`api.spec.ts:165`）；测试会兜住漏改，正措辞。
- **F-7** Task 15（1763）夸大 appWiring 正则：`assert.match` 只断存在非唯一，并不字面禁止第二分支；计划更严的单调用规则兼容且安全，仅 prose。
- **F-8** `ComposerMentionMenu` 内联重声明 item 形状（`:22`）而非复用 `ComposerMentionItem`；实施需同时扩展两处。

### 7.5 与 §6 的关系

§5 的 7 条闭环经独立抽查确已落入正文（旧 `@` 锚、`teamSnapshot.slug`、market-routes 92、双审查员 4 判决、256 KiB 边界、`maxParallel` 最小值、Task 6 规则测试），§6 的 GO 对**那 7 条**成立。本轮在更宽的 §1–§19 全量 + reducer 语义 + 接线 sweep 下另发现 B-1 与 I-1..I-5 等，故整体结论收紧为“短修订后 GO”。两轮不矛盾：§6 范围窄（只复核 7 入口），本轮范围宽（全量规格 + 源码反证）。

### 7.6 复审入口（修订后只复核这些）

1. Task 13 任何 snapshot 恢复 `open`/清 `frozenAt` + 同代重连解冻测试
2. Task 8 命名 `unifiedRevisionRounds` 写者 + 跨派工额度耗尽测试
3. 旧 `@` 按裁定保留任意位置触发（仅 team 分组限开头）+ 中段补全回归测试
4. Task 17 desktop-shell 单次插入
5. Task 6 删 `undefined` 字面量 / 钉 overrides 类型 + Task 1 fixture 字面量
6. `attachments` fixture 投影钉死
7. S-1..S-11 各补可执行断言

七组都落入正文后，本文整体结论改为 GO，再按 Task 1–18 实施。

---

## 8. 第四轮复审（Gemini 修订稿，2026-11-22，GO）

- **复审对象**：Gemini 按 §7 修订后的计划（未跟踪，2133 → **2434 行**，+301）。规格仍为 799 行评审基线（工作树 `M` 是相对更早 committed 版的设计演进，非本轮新改，无移动球门）；无任何产品代码改动。
- **复审方式**：不采信“已修”声明。三路并行复核（Host 运行时 / 契约纯函数与 smoke / 客户端与覆盖）逐条对修订正文验证可执行断言/具名接线/具体规则，承重项对照当前 HEAD 源码反证；主审亲验 B-1、I-1、I-2、S-1、S-10、NEW-A。
- **结论**：**达到实施标准（GO）**。§7 的唯一阻断 B-1 已闭环，5 个接线/兼容/门禁级同轮应补（I-1..I-5）全闭环，11 个覆盖缺口 10 闭环、S-1 接线已修但测试区分力差一步，8 个不阻断全闭环。残留为 4 条实施前顺手钉死的小项 + 几条 nit，不需再一轮全量修订。

### 8.1 §7 发现闭环表

| 发现 |  tier | 闭环 | 修订落点（修订稿行）+ 反证 |
| --- | --- | --- | --- |
| B-1 同代重连永不解冻 | 阻断 | **CLOSED** | Task 13 L1788-1789「任何 snapshot 含同代恢复 open/清 frozenAt」；测试 L1724-1743 断言同代重连 open + Task 16 L2122-2129 按钮重新可用。参考 `subagentRuns.ts:219-224` 每次 live，一致 |
| I-1 返修计数器无写者 | 应补 | **CLOSED** | Task 8 L1183 同一同步 `registry.update` 临界区消费 `opensUnifiedRevisionCycle` 递增；跨派工测试 L1056-1080（启动前拒绝不扣→并行只递增一次→超额拒 `expert-team-revision-limit`） |
| I-2 旧 @ 触发收窄 | 应补 | **CLOSED（裁定落地）** | L1946 逐字记裁定；`resolveComposerMentionState` L2023 开头开两组/非开头回落 `atTokenAt` 仅智能体组；L2033 明禁整体替换；回归 L1957-1961 中段 `@writer` 仍触发。残留见 NEW-B |
| I-3 smoke 重复插 desktop-shell | 应补 | **CLOSED** | L2308-2311 严禁追加 insert、钉 `patches=[...patches,...overlays]`。反证纠正 §7 笔误：`DESKTOP_SHELL_PATCH_ENTRY` 是覆盖行（无 insert），真正 insert 来自 `cordis.patch.yml` 经 `profile.ts:1488,1506` |
| I-4 undefined 字面量 + fixture | 应补 | **CLOSED** | Task 6 已无 `: undefined`（L705/821）；Task 1 L147-150 钉死 slug/name/scenarios/成员/新对象；L825 cycleOpen 仅工厂入参由 results 派生。`tsconfig.json:18` 反证成立 |
| I-5 attachments.has 非真实 API | 应补 | **CLOSED** | Task 7 L901/922 用 `sessionAgentTools.has` + 真实 `emptyAttachments()`；Task 9 L1241-1246 用 `isAgentToolAttached`。`agent-attachments.ts:1-4,42,104` 反证匹配 |
| S-1 重放锚区分力 | 应补 | **PARTIAL** | 接线已修（Task 12 L1677-1680 按持久 `artifact.anchor` 解析 persistedRun，created=false 只恢复持久锚运行）；但测试 L1609-1624 首次 commit 已完整关联，读 `current()` 的错误实现在 m2 查不到运行、什么都不做也全绿，注释 L1611 自认弱读法。见 §8.2 |
| S-2 顶层 id 存在案 | 应补 | **CLOSED** | Task 11 L1459-1466 explicit-uuid-1，spy 恰一次 + run/anchor/followup 同 id |
| S-3 排队放行顺序 | 应补 | **CLOSED** | Task 11 L1489-1500 结算+附件清理后 followups 才 1→2 |
| S-4 0/2 轮 + 全部终态 | 应补 | **CLOSED** | Task 6 L700/701/708/709/751-755/775-784 failed/completed/message-partial/round0/round2。nit：quota-0 终态与 per-member round-0 注释先行 |
| S-5 none/per-member scope | 应补 | **CLOSED** | Task 6 L713-728 `expert-team-review-disabled` + per-member 省略/多选拒、单例 ok |
| S-6 同成员串行 | 应补 | **CLOSED** | Task 8 L1041-1053 同成员两连发 `running===1`/`maxRunning===1` |
| S-7 cancelAll + 默认上限 | 应补 | **CLOSED** | Task 3 L340-375 默认 20/100 淘汰 + `cancelAll` 闭包收敛断言 |
| S-8 编辑器联动 | 应补 | **CLOSED** | Task 14 L1867-1889 启停/排除@/不完整/未保存确认/message 隐藏格式/无 reviewer→none disabled/字段错误保留草稿 |
| S-9 7 态 + 成员链 | 应补 | **CLOSED** | Task 16 L2096-2119 `Set(labels).size===7` + 返修/替代/invalid-verdict 展开 + 关联异常 Artifact 卡可见 |
| S-10 Artifact 写失败 | 应补 | **CLOSED** | Task 12 L1626-1644 真实 5 MiB+1→`artifact-too-large`→pending/partial+同回合重试；Task 17 L2248-2251、Task 18 L2413。`artifacts-host.ts:27,41,340` 反证 |
| S-11 缓存拒绝 + 隔离 | 应补 | **CLOSED** | Task 11 L1479-1487 disabled/deleted+sameSlugAgentExists 拒且不回退；Task 2 L223-232 双 profile 行为级隔离 |
| N-1..N-5/N-7/F-7/F-8 | 不阻断 | **CLOSED** | sessions.ts:1346 透传、dispatch ctx+skills 调序、ClaimedContext holder、结算 fail-closed 三步、拒绝码枚举、6 处计数、存在性匹配措辞、items 复用 ComposerMentionItem |

**修订纠正了 §7 自身两处笔误**（独立反证确认修订稿更准确）：I-3 的 desktop-shell 机制（覆盖行非 insert）、N-7 的硬编码 83 计数（**6 处/4 文件**，§7 误写 7）。

### 8.2 实施前顺手钉死的残留（不阻断开工）

- **R-1（S-1 残留，同轮应补）**：Task 12 重放测试补「首链失败→异锚重放恢复」区分性断言——fixture 令首次 `noteSessionArtifact` 返回 false（首 commit 后 `artifactStatus:'pending'`/`artifactLinkError`），`setCurrentAnchor('m2')` 后重放 call-1，断言持久锚 m1 运行恢复 `created`/`primaryArtifactId` 且无 `artifactLinkError`（或 spy 断言关联以 anchor=m1 的 summary 调用）。现有断言集对读 `current()` 的错误实现仍全绿。
- **R-2（NEW-A，同轮应补）**：Task 11 L1447 `makeSessionFixture({ clientMessageId: undefined })` 重新引入 I-4 同类陷阱——`exactOptionalPropertyTypes` 下若 opts 类型为 `{clientMessageId?:string}` 则 `tsc -p tsconfig.tests.json`（Task 18 门禁）报错。删该键（省略即 undefined 语义）或显式 `string|undefined`。I-4 的修复只清扫了 Task 6。
- **R-3（NEW-B，同轮应补·轻）**：I-2 裁定目前靠 prose（L1946/L2033）+ resolver 纯函数测试守卫；Task 15 无 App 级断言钉 `App.tsx:1230` 消费 `resolveComposerMentionState`。若实施者把触发写成 leading-only，所列测试仍全绿。补一条 appWiring 存在性正则（如 `resolveComposerMentionState\(draft, atCursor\)`）把接线钉死。
- **R-4（NEW-C，同轮应补·轻）**：Task 6/8 工厂用 `memberId:'reviewer'`/`m-exec-2`/`executor-2` 不在 `validTeam()` 两成员名单内；若 `resolveReviewScope`/角色匹配校验成员存在，照字面会拒掉期望 `ok:true` 的用例。一句话钉死「工厂按用例扩展 `teamSnapshot.members`」。
- **nit**：S-4 quota-0 终态与 per-member round-0 各补 1 条断言（现注释先行）；S-10 写失败→`failed`（无有效执行）组合与 commit 阶段写盘错误为 prose，可顺手补变体；N-4 最外层结算 catch 专属测试、S-3 afterIdle 中间窗口断言为可选加固。

### 8.3 判决

**GO — 达到实施标准。** 阻断清零，正确性关键接线全部钉死并经源码反证，规格 §18 点名测试基本落地。R-1..R-4 为窄口径测试区分力/fixture 卫生项，实施时顺手钉死即可，不需再一轮全量修订。按 Task 1–18 实施，实施时逐条消费 R-1..R-4 与 nit。
