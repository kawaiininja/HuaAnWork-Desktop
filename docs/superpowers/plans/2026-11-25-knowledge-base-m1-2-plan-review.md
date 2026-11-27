# 《知识库 M1-2（单槽整理 Agent、双层工具白名单与抢占式调度）》实施计划评审意见（Plan Review）

- **日期：** 2026-11-26
- **审核者标注：** qwen4（§1–§11）；GLM（§12 独立复核、§15 修复确认，2026-11-27）
- **审阅目标：** [2026-11-25-knowledge-base-m1-2-single-slot-organizer.md](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md)（369 行，Task 1–6）
- **对照依据：**
  - 设计规格：[2026-11-24-knowledge-base-design.md](../specs/2026-11-24-knowledge-base-design.md)（v2.5 §0 评审校准、§2.3 NFRs、§4 代码现状、§5.3 只读边界、§8.1–§8.3 整理/调度/事件、§10 生命周期、§11.1 无头测试）
  - 先例：[2026-11-25-knowledge-base-m1-1-plan-review.md](./2026-11-25-knowledge-base-m1-1-plan-review.md)（严重度与反证口径）
- **前置：** M1-1 已合并进 master（merge commit `5fc019eddf`，PR#33，PR + master CI 全绿）。
- **方法：** 两路评审员分工——①Task 1–3 隔离/安全/白名单/整理工具/墓碑；②Task 4–6 调度/抢占/执行器/Host 接线/验收——逐条读实际源码核验计划「代码现状」断言；主审对关键发现独立反证（触发缝、bridge 锚点、index 作用域、release 唤醒、cancelForKb 契约、spec §8.2 字面）。全程只读，未改任何文件。
- **首轮判定：** **ITERATE（修订计划并复审通过后再开工）。0 阻断 / 11 同轮应补 / 9 不阻断；D1 与 D2 均已由 owner 确认并写入规格（见 §6）。**
- **Qoder 轨判定（2026-11-26 §11 最终聚焦复审）：** **GO（计划达到实施准入，可开工）。0 阻断 / 0 同轮应补 / 0 未清 Nit；§8 的 R2 与 §10 的 R3 全部闭环。** GO 只覆盖计划，不代表实现已验收；实现仍须逐 Task 红绿并独立通过 `corepack yarn check`，真机/UI 归属维持 M1-3/发布边界。
- **GLM 轨判定（2026-11-27 §12 独立复核）：** **ITERATE（小幅修订后可开工）。0 阻断 / 1 同轮应补 / 1 Minor / 8 Nit。** §11 的闭环证据经 GLM 轨独立核对未见翻案项；本判定仅因新增 G-I1——按现稿实施，整理主链路在新建库上必然失败，且计划内的测试会保持绿色。G-I1 写入计划并经定向复核后恢复 GO。
- **Qoder 轨背靠背核验（2026-11-27 §13）：** §12 全部条目经独立反证**属实**，ITERATE 判定与严重度校准维持。G-I1 写入计划并定向复核后恢复 GO；G-M1 待 owner 二选一；G-N1～G-N8 同轮顺手清。
- **当前判定（2026-11-27 §14 定向复核）：** **GO（计划准入恢复）。0 阻断 / 0 同轮应补 / 0 未清 Nit。** G-I1 两个落点已写入计划并经定向复核；G-M1 经 owner 裁定方案一（present-as 只消费 `huaanworkSessionToolAllow`）；G-N1～G-N8 全部落入正文。GO 只覆盖计划，实现仍须逐 Task 红绿并独立通过 `corepack yarn check`。
- **GLM 轨修复确认（2026-11-27 §15）：** **同意 GO。** §12 的 G-I1 / G-M1 / G-N1～G-N8 十项在修订稿（748 行）中全部闭环并逐项对过源码，无翻案项。修订稿另留 3 条 Nit（R-1 测试 1 夹具措辞、R-2 `mkdir` 失败的计次口径与规格未同步、R-3 测试 5 拨钟顺序）与 1 条真机观察（R-4 唤醒时序），均不阻断、不改变 GO。

严重度口径（沿用 M1-1 先例）：

- **阻断（B）：** 安全边界 fail-open、整理 Agent 写到 `wiki/` 外或源目录、关键上游契约根本不存在致无法实施、或抢占/释放竞态致名额泄漏/二次扣减。
- **同轮应补（I）：** 规格点名的行为/上限/状态机实现要点/测试缺失或指错对象，实施时会依赖临场发挥。
- **不阻断（Minor / Nit）：** 夹具细节、命令覆盖面或说明口径，顺手收紧。

---

## 1. 已对齐、可保留的部分

1. **安全 fail-closed 方向正确、落点齐全。** 空交集修法对症（`present-as.ts:149-156` 现状确为 `allowed.length===0` 直接 return 的 fail-open；显式白名单 + `schemas()` 非空 + 交集空 → `tools.restrict({allow:[]})`，`schemas()` 空不锁死、待 `tools/change` 再收窄）。双层白名单与 `huaanworkPackageChildAllow` 现有模式同构，可选链降级一致；三个 `kb_org_*` 工具 `attached ? ALLOW : deny` 与 `result_present`/`expert_team_dispatch` 同型，永不 `ask` 成立（6 个 fs 工具在 `decide.ts` 本就纯 ALLOW/deny），无需 `huaanworkUnattended`。
2. **抢占/幂等/单槽设计与源码吻合。** 抢占触发条件（仅全局满额 + 非同根 + 有 kb 写者）、同根不误杀、`release` 幂等 no-op（`turn-scheduler.ts:171-177`）、全局单 kb、队列非空 skip、`soleCapWriterSessionId` 排除（`turn-scheduler.ts:259-264`）、唤醒顺序与源码结构一致；无 kb 写者时新分支不触发，旧 `turn-scheduler.spec.ts` 100% 兼容可行。单槽复用「`dispose` → `removeSessionFilesById` → `create`」时序正确，槽位锁与全局名额解耦、`cancelForKb` 先发取消再 await、`finally` 中 release 先于 inFlight 键删除均无竞态。
3. **M1-1 底座复用成立。** organize 列（`organized_sha256`/`wiki_note_path`/`organize_attempts`/`organize_retry_after`/`last_organize_error`）、`organize_tombstones` 表、原子 mark、`getPendingOrganizeBatch`（带 maxDocs/maxBytes）、≤1s 退场预算均已落地（`storage-db.ts:113-124,1083-1134`；`host.ts:803-828`）。批次 10/80KB、计次 3、退避 60s/300s、256KiB/50MiB 与 M1-1 常量逐字吻合。
4. **上游契约全部存在。** `agents.create({setup})`、`systemPrompt.context({interpolate:false})`、`handle.dispose()`、`SessionAlreadyExistsError` 均核实（`core/agent/src/index.ts:118,160-163,393`；`system-prompt/src/index.ts:86-99`；`session-persistence/errors.ts:22`）。`fs-sandbox` 非内核边界、`workspace-write` 放行 temp 属实（`fs-sandbox/src/index.ts:12-22`），整理额外拒 temp 为纵深加固。
5. **TDD 质量基准已达。** 各 Task 有失败测试 → 实现 → 复跑 → 提交步骤，跨任务常量（`KB_ORG_SESSION_PREFIX` 双端独立声明对齐 AUTO 模式、`KB_ORG_ALLOWED_TOOLS`）有定义；墓碑「先删文件再删行」顺序安全。

## 2. 阻断项

**无。** 安全边界设计正确、fail-closed 落点齐全、上游契约存在、抢占/幂等/单槽无致命竞态。下列 I 项均为「指错对象 / 缺落点 / 缺测试」，修订计划即可闭环，不构成 NO-GO。

## 3. 同轮应补项（修订计划时一并写入正文）

### I-1 阶段 1→阶段 2 触发缝指错且缺调用点（Task 6，主链路）

计划引用的 `onStage1Completed` 全仓不存在；真实缝是 `KnowledgeOrganizerHooks.notifyPending?(kbId)`（`host.ts:110`），但**声明后无任何调用点**，且监听/防抖/周期对账的入库提交都在 sync-engine 内部完成、不经 `host.sync`。Task 6 Files 未列 `sync-engine.ts`。**修法：** 写明引擎侧提交后回调落点（覆盖 watcher/防抖/周期路径）+ 失败测试，否则「放文件自动整理」主链路断。

### I-2 bridge 隔离锚点不存在（Task 1）

计划「与 `AUTO_SESSION_PREFIX` 同一位置」在 `bridge.ts` 无此物（自动化流过滤在客户端 `App.tsx`）；`bridge.ts` 仅 `emitGitDiff`（`:189,:386`）。**修法：** 流事件早退需新增于 `mapTokens`、`tool/start`、`session/end` 等实际位置，扩正所列行号。

### I-3 knowledgeHost 作用域指错（Task 3/6）

`knowledgeHost` 是顶层独立 effect 的局部 const（`index.ts:296-325`，注释「绝不放进 tools effect」），`toolCtx` 在另一 effect（`index.ts:495-513`），不可被「透传」。**修法：** 提升 ref/holder 桥接，并钉死两 effect 退场顺序（先注销 org 工具再 `knowledgeHost.dispose()`）。

### I-4 writable-root 实现落点缺失（Task 1）

Step 3 五条 bullet 漏 `writable-root.ts` 与 `session-sweep.ts`；「有效库注册」校验机制未定义（入参无注册表）。**修法：** 钉死 kbId 解析 + `neutralKnowledgeRootPath/wiki` 的 `existsSync`/`statSync`（或注入注册表）+ 具名错误。

### I-5 cancelForKb 契约不一致（Task 5/6）

计划带 `reason: 'user-stop'|'preempt'|'maintenance'|'dispose'` 四值联合，但 M1-1 锁定的 `KnowledgeOrganizerHooks.cancelForKb(kbId)` 与引擎签名均无 reason（`host.ts:108`、`sync-engine.ts:110`）。**修法：** 写明适配映射（四类均不计次）或同步扩钩子类型。

### I-6 finally 裸 release 漏唤醒（Task 5，活性）

`finally` 只调 `turnScheduler.release`，不走 `releaseAndDrain`/`drainUserQueue`（`sessions.ts:1216,1227`），整理正常结束释放名额后**已排队用户/到期自动化无人唤醒**。**修法：** 走 `releaseAndDrain` 同源顺序；补「整理完成 → 排队用户立即启动」测试。

### I-7 状态机实现要点 + 事件流缺失（Task 5，先例 R3-I1 口径）

看门狗超时来源/值（spec §8.2(6) 沿用 `automation_timeout_ms` 默认 10min）、空闲判定（哪些事件 touch）、时钟机制与可注入假时钟（「跳钟 20 分钟」测试须锁真实机制）、`deps` 注入面均未写；§8.3 `organize_started/completed/failed/cancelled` 事件写入与 `organizing/waiting-turn-slot/blocked-no-model/blocked-network` 相位迁移无任何落点（`events.ts` 种类已备）。**修法：** 钉死实现要点 + 事件/相位写入落点与测试；事件归属按 §6 D2 裁定。

### I-8 纯墓碑批清行机制缺失（Task 3）

`processed` 为空（纯墓碑批）时 documents 行已删，现有 `markOrganizedAtomic` 需 docId+sha256，无独立清墓碑 op。**修法：** 钉死机制（复用已有 organize op 或扩 storage 协议），并点名复用的 op。

### I-9 悬空符号链接测试无区分力（Task 2，安全）

目标存在的越界链接已被 `resolveInside` 拒（`paths.ts:25-39` realpath 存量父段）；唯一逃逸是**悬空文件符号链接**（existingParent 爬回 `wiki/` 放行，`write` 会在库外创建目标）。**修法：** 测试必须构造悬空链接，实现须对候选路径 `lstat`（非 `stat`）；计划均须写明。

### I-10 50MiB 总量失败测试缺失（Task 3）

Interfaces 有「全库 `wiki/` 总大小 ≤ 50MiB」上限，Step 1 无对应用例（spec §2.3 点名）。**修法：** 补超限拒绝失败测试。

### I-11 model.ts 注册名测试缺失（Task 2）

`isRegisteredToolName` 漏补三个 `kb_org_*` 会静默丢弃 SSE 调用 → 回合假失败计次（仓内已有同型事故）；Step 1/4 均未含 `model.spec.ts` 断言。**修法：** 补 model 层注册名失败测试。

## 4. 不阻断项（Nit，同轮顺手清）

- **N-1** 测试文件名指错：`present-as.spec.ts` 实为 `present-as.cordis.spec.ts`；policy 单测实为 `src/decide.test.ts`（node:test），Task 2 Step 5 `git add packages/huaanwork-policy/tests/` 会失败。
- **N-2** `TurnAnchor['origin']`（`turn-anchors.ts:16`）需同步扩 `'knowledge'`（tsc 可兜住）。
- **N-3** `withPinnedCwd` 的 `seedSource==='persistence'` 早退（`sandbox-cwd.ts:95`）先于 KB_ORG 检查，写明检查顺序。
- **N-4** `removeSessionFilesById` 实在 `session-sweep.ts:249`、收 `readonly string[]`；Task 5「与 sessions.ts 同源」及单参写法不准。
- **N-5** `index.ts` 行号 455-512 偏移（实 495-513）；Task 5 提示词应显式写入「先改 INDEX/topics 再清墓碑」（§8.1）。
- **N-6** Task 6 `dispose` 并行取消整理已存在（M1-1），应标注为既有接线；退场测试须用**卡死**整理回合并断言取消已发出/回合结算，仅断言 <1s 区分力不足（R3-B3 口径）。
- **N-7** §11.2 真机项未标注延后归属（应具名延至 M1-3/发布验收）。
- **N-8** Task 6 集成测试 1 的 agents/模型测试桩策略未写（无头约束）。
- **N-9** 抢占移除 `rootWriters` 后旧整理 agent 仍在写的窗口内，同 `wiki/` 根用户回合理论上可被 `drainQueue` 准入——极边缘，写明接受或有根锁保护。

## 5. 代码现状断言反证核验表

| 计划断言 | 判定 | 源码证据 |
| --- | --- | --- |
| `present-as.ts:156` 空交集 fail-open | 属实 | `present-as.ts:149-156`（`allowed.length===0` 直接 return） |
| holders 已有 PackageChildAllow/SessionModels/SessionRoots/Attachments，无 SessionToolAllow | 属实 | `holders.ts:39,60,81,83`；PROPS `98-128` |
| sandbox-cwd 缺根回落前台/process.cwd() | 属实 | `sandbox-cwd.ts:80-85,98,132` |
| writable-root 整理前缀回落中立工作区 | 属实 | `writable-root.ts:85-91` |
| decide.ts 纯逻辑零三方 + attached?ALLOW:deny 先例 | 属实 | `decide.ts:1-4,142-148` |
| turnOrigin 只分 auto/advanced，扩 knowledge 调用方兼容 | 属实 | `sessions.ts:1104-1106,579`；`result-artifact-tools.ts:234` |
| **`onStage1Completed` 钩子** | **不符（不存在）** | 真实缝 `notifyPending?` `host.ts:110`，全仓无调用点 |
| **bridge「与 AUTO_SESSION_PREFIX 同位置」** | **不符（bridge 无此物）** | `bridge.ts:189,386` 仅 emitGitDiff；自动化过滤在客户端 App.tsx |
| **index「toolCtx 透传 knowledgeHost」** | **不符（独立 effect 局部 const）** | `index.ts:296-325` vs `495-513` |
| **removeSessionFilesById「与 sessions.ts 同源」** | **不符** | `session-sweep.ts:249`，收 `readonly string[]` |
| **cancelForKb 带 reason** | **不符（M1-1 无 reason）** | `host.ts:108`、`sync-engine.ts:110` |
| release 找不到即 no-op、不二次扣减 | 属实 | `turn-scheduler.ts:171-177` |
| soleCapWriterSessionId 统计全部占名额写者 | 属实 | `turn-scheduler.ts:259-264` |
| drainQueue → reevaluateDueAutomations 顺序 | 属实 | `sessions.ts:1216-1232` |
| agents.create({setup})/interpolate:false/SessionAlreadyExistsError | 属实 | `core/agent/src/index.ts:118,160-163,393`；`system-prompt/src/index.ts:86-99`；`session-persistence/errors.ts:22` |
| M1-1 organize 列/墓碑/原子 mark/退场预算 | 属实 | `storage-db.ts:113-124,1083-1134`；`host.ts:803-828` |
| fs-sandbox workspace-write 放行 temp、非内核边界 | 属实 | `fs-sandbox/src/index.ts:12-22` |

## 6. Owner 裁定（2026-11-26）

### D1 抢占不得越过先排队用户（FIFO 优先）

- **Owner 确认（2026-11-26）：** 采纳。队列为空时，新到者直接 `{kind:'start'}`。队列非空时，新到者入队，并立刻走一次与 `drainQueue()` 相同的出队；名额先给已在队列中、根已空闲、且 `enqueuedAt` 更早的用户。队首根仍忙则跳过，新到者只有在没有更早的可启动者时才在这一轮出队里启动。
- **规格与计划：** 已写入 spec §4 现状表、§8.2(3)(5)、§11.1(6)、决策 D8，以及本计划 Task 4 的 `admitUserTurn` 契约与失败测试第 1、7 条。§8.2(4)「用户队列非空时不启动整理」不变。`sessions.ts` 见到 `{kind:'queued', drain:true}` 后调用一次 `drainUserQueue`，本次发送若被这次排空出队，只走 `startQueuedItem`。

### D2 organize_* 事件落盘归 M1-2、实时推送归 M1-3

- **Owner 确认（2026-11-26）：** 采纳。`organize_started` / `organize_completed` / `organize_failed` / `organize_cancelled` 写入 `events.jsonl`，列表相位 `organizing` / `waiting-turn-slot` / `blocked-no-model` / `blocked-network` 归 M1-2。`knowledge/changed` 与 `knowledge/event` 实时推送归 M1-3。M1-2 不注册这两条路由，`ROUTE_TABLE` 保持 92。
- **规格与计划：** 已写入 spec §8.3，以及本计划 Task 5。相位走 sync-engine 现有 `runtime.phase`；`settlePhase` 不得把上述四个整理相位刷回 `watching`。事件走现有 `appendKnowledgeEvent`。I-7 里看门狗取值、空闲判定、假时钟与 `deps` 仍待补。

## 7. 复审准入清单（ITERATE → GO 的唯一入口）

修订稿须逐项闭环下列入口，复审通过后方可开工：

1. I-1 触发缝：Task 6 列 `sync-engine.ts`，写明引擎侧提交后 `notifyPending` 调用点（覆盖 watcher 路径）+ 失败测试。
2. I-2/I-3/I-4 接线落点：bridge 早退实际位置、knowledgeHost ref/holder 桥接与退场顺序、writable-root 校验机制，均与源码结构吻合。
3. I-5 cancelForKb reason 适配映射或扩钩子类型，跨 Task 契约一致。
4. I-6 finally 走 releaseAndDrain 同源顺序 + 排队用户唤醒测试。
5. I-7 看门狗取值/来源、空闲判定、假时钟、`deps` 仍须补。D2 的事件/相位落点已写入规格 §8.3 与 Task 5，复审只核对是否与该节一致。
6. I-8 纯墓碑清行机制钉死。
7. I-9 悬空符号链接测试 + 候选路径 lstat 实现要点。
8. I-10/I-11 50MiB 总量与 model 注册名失败测试补齐。
9. **D1：** 已由 owner 确认并写入规格与 Task 4。复审只核对正文是否与 §8.2(3) 一致（更早且根已空闲者优先；队首根仍忙则跳过）。
10. N-1～N-9 顺手清；测试文件名/命令路径更正。

**首轮判定：ITERATE。** D1 与 D2 均已由 owner 确认，并写入规格与计划。11 项同轮应补里，除 D2 已覆盖的事件/相位落点外，仍须落入正文后复审。

---

## 8. 复审：修订稿实施准入（Qoder，2026-11-26）

- **审阅目标：** [2026-11-25-knowledge-base-m1-2-single-slot-organizer.md](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md) 修订稿（411 行，Task 1–6）。
- **对照基线：** M1-1 已合并的 master（`5fc019eddf`）及当前工作树源码；规格 v2.5 的未提交改动已逐段核对，内容与 §6 D1/D2 一致。
- **方法：** 按 §7 十项准入清单逐项定位计划正文，再读真实源码反证；重点核验 Agent 驱动、KnowledgeHost/Storage 门面、scheduler FIFO、bridge 抑制与看门狗心跳、sync/rebuild 触发、整理相位、纯墓碑批和退场。子代理调用未获批准，本轮由主会话顺序完成，**不声称进行了独立子代理评审**。全程只读源码；未运行实现测试（尚无 M1-2 实现），文档 `git diff --check` 通过。
- **复审判定：** **ITERATE。0 阻断 / 5 同轮应补 / 1 不阻断。** 安全 fail-closed、FIFO 抢占、单槽释放与墓碑删除方向成立，但执行器主链路和跨 Task 状态接口仍未闭合，修订并复核后再开工。

### 8.1 §7 准入清单逐项复核

| 入口 | 计划正文与源码证据 | 判定 |
| --- | --- | --- |
| 1. I-1 触发缝 | 计划 L367、L375–376、L392–393 已把 `sync-engine.ts`、统一 `onIndexCommitted`、六种 trigger 与失败/epoch 早退写入；真实汇合点在 `sync-engine.ts:890-1094,1120-1165` | **六种对账路径闭环**；rebuild 不经此汇合点，另列 R2-4 |
| 2. I-2/I-3/I-4 接线 | bridge 实际缝为 `bridge.ts:138-195,260-299,302-347`，host 独立 effect 为 `index.ts:296-328,488-553`，计划 L52、L87、L176–188、L215–216 已对准；但同步注册 id 来源仍缺失 | **I-2/I-3 闭环，I-4 部分闭环**；缺口并入 R2-2 |
| 3. I-5 cancelForKb | 计划 L305、L393 明确保持 M1-1 无 `reason` 签名并做四类映射；`host.ts:107-111`、`sync-engine.ts:110` 契约一致 | **闭环** |
| 4. I-6 释放后唤醒 | 计划 L273、L308、L326、L341 强制 `releaseAndDrain`；真实实现 `sessions.ts:1227-1232` 为 release → drainQueue → 自动化评估 | **闭环** |
| 5. I-7 看门狗与 D2 状态机 | 计划 L309–311、L323–325、L340–344 已补 10 分钟来源、touch 事件集、假时钟、事件/相位与 `settlePhase` 保留集合 | **部分闭环**：心跳来源与相位写 API 见 R2-2/R2-3 |
| 6. I-8 纯墓碑清行 | 计划 L192–193、L201、L217 指明独立 `clearOrganizeTombstones` 及 protocol/client/worker/db 四层；现有 `markOrganizedAtomic` 确实要求 docId+sha256（`storage-db.ts:1125-1138`） | **闭环** |
| 7. I-9 悬空符号链接 | 计划 L127、L136 明确候选路径 `lstat`、悬空链接样本；`paths.ts:25-36,49-56` 的 existingParent 行为支持该反证 | **闭环** |
| 8. I-10/I-11 上限与注册名测试 | 计划 L137、L158、L202 覆盖 50 MiB 注入上限与 model SSE 注册名；三个实际测试文件均存在 | **闭环** |
| 9. D1 FIFO | 计划 L249、L260 与规格 §8.2(3)、D8 字面一致；现有 `turn-scheduler.ts:121-147,216-239` 支持按 enqueuedAt 扫描并跳过忙根 | **行为闭环**，文件清单小修见 R2-N1 |
| 10. N-1～N-9 | 文件名/签名/行号、persistence 顺序、INDEX/topics 提示词、卡死退场、真机延后、无头 agent 桩与同根窗口均已写入 L61–94、L309–310、L338、L372–380 | **全部闭环** |

### 8.2 本轮同轮应补项

#### R2-1（Important）Task 5 没有驱动和等待真实 Agent 回合

- **位置：** 计划 L302–344。
- **问题：** 正文只有 `agents.create({ setup })`、holder 写入、`handle.dispose()` 与看门狗，没有任何 `followup` / `send` / `whenIdle` / `sendToAgent` 落点。上游明确写着 setup “composes, it never drives”（`deepseek-harness/packages/core/agent/src/index.ts:114-118`）；`AgentHandle` 只暴露 `agent` 与 `dispose`（同文件 L160–163），真正驱动与静止等待接口是 `agent.followup()` / `agent.whenIdle()`（`runtime-types.ts:185-191,217-222`）。
- **为什么重要：** 按现稿实施会创建整理 Agent 后直接收尾，模型回合从未运行。Task 6 用脚本 agent 工厂替代真实模型，不能发现这条生产主链路缺口。
- **修法：** 钉死 create 后发送哪条 UserMessage（含稳定消息 id/source）、如何 await 整轮 quiescence、看门狗/取消如何 race、晚到 settle 如何只结算一次，以及失败与未 mark 判定接在哪里；增加能区分“只 create”与“实际 followup 并等待 idle”的失败测试。

#### R2-2（Important）KnowledgeHost / SyncEngine 的整理能力接口未定义，Task 3 无法按清单独立交付

- **位置：** 计划 Task 3 L174–188、Task 1 L83、Task 5 L311/L344、Task 6 L394。
- **源码反证：**
  1. `KnowledgeHost` 当前接口只有 CRUD/检索/事件/钩子（`host.ts:113-135`），没有 `getPendingOrganizeBatch`、`getDocChunks`、`markOrganizedAtomic`、`recordOrganizeFailure`、`resetOrganizeFailures` 或墓碑清理方法；唯一 `storage` 是 `createKnowledgeHost` 闭包私有变量（`host.ts:151`）。Task 3 的 Files 与 git add 均未列 `host.ts`，`org-tools.ts` 经 `getKnowledgeHost()` 无路调用这些存储能力。
  2. `registeredKnowledgeBaseIds()` 需要同步集合，但 Host 仅暴露异步 `list()`（`host.ts:354-364`），`records` 也是私有（`host.ts:154`）；`writableRootForSession` 是同步函数（`writable-root.ts:30-36`）。
  3. 计划要求 organizer 写 `runtime.phase` 并用 `idlePhase` 复原，但 `runtime` 与 `idlePhase` 都在引擎闭包内（`sync-engine.ts:176-195,306-317`），公开 `KnowledgeSyncEngine` 只有 `getState`，没有整理相位 setter/清除接口（`sync-engine.ts:130-166`）。
- **为什么重要：** 这不是行号偏差，而是 Task 3/5/6 共同依赖的 capability seam 缺失。实施者只能临场改公开接口、使用不安全 cast，或错误地另建 Storage Worker；三种结果都破坏逐 Task 可编译、单 Storage Worker 或无头测试契约。
- **修法：** 在计划中显式定义同一 Host 持有的整理存储门面（不得新建第二个 StorageClient）、同步注册 id 只读快照/getter，以及引擎的 `set/clearOrganizerPhase` 窄接口；把 `host.ts` 纳入 Task 3，把接口生产者/消费者和退场所有权写清，并补恢复态、删库和维护期调用的失败测试。

#### R2-3（Important）UI 事件隔离会同时切断看门狗心跳

- **位置：** 计划 L69、L87 对比 L309、L340。
- **源码反证：** 计划要求 bridge 对整理槽的 token/reasoning/tool/diff/session-end 早退，同时又要求这些事件调用看门狗 `touch()`。所沿用的自动化收集器只在 `huaanworkEmit` 包装器里收事件并 touch（`automations-host.ts:145-187,204-214`）。若 bridge 在 emit 前直接返回，收集器收不到任何活动，持续产出 token/工具的整理回合也会被判空闲超时。
- **为什么重要：** 活跃整理会被误杀并错误计次；反之若为保住心跳而不屏蔽事件，又破坏可见性隔离。
- **修法：** 定义 organizer 专属观察缝，或在 bridge 的真实事件源处先 `touch` 再仅抑制 UI emit；明确 `tools/execute` 必须 `await next()` 并返回工具结果、`mapTokens` 必须继续 `yield` 消费流。补“超过 timeout 仍有活动则不超时 + UI 零事件”和“真正卡死才超时”的成对测试。

#### R2-4（Important）重建索引成功后的整理排期仍断裂

- **位置：** 计划 L367、L376、L392；规格 §6.4 L297。
- **源码反证：** `onIndexCommitted` 只放在 `reconcileInner` 成功尾部，但 `rebuildIndex` 走独立的 begin/upsert/commit 流程（`sync-engine.ts:1467-1718`），成功提交点 `storage-db` 后的代码为 `sync-engine.ts:1651-1684`，不会调用 `reconcileInner`。规格明确要求重建恢复运行态时触发整理排期。
- **为什么重要：** 重建会重置 organized 指纹并生成待整理项/墓碑，但成功后可能直到下一次周期对账或用户操作才整理；暂停监听或后续无事件时可长期滞留。
- **修法：** 写明 rebuild 唯一提交点成功、无 `wiki-reset-pending`、已解除维护门闩后调用同一无参 `scheduleEvaluate()` 的落点；失败重建和 pending Wiki reset 不调用。补 rebuild → organize 的端到端无头测试。

#### R2-5（Important）“本批”没有权威快照，纯墓碑无进展会立即反复调用模型

- **位置：** 计划 L198–203、L303–305、L319–326、L341–342。
- **源码反证：** `getPendingOrganizeBatch` 每次实时查库，并总是返回全部墓碑（`storage-db.ts:1145-1186`）。计划没有定义 scheduler 预检、Agent 的 `kb_org_get_delta` 与回合末失败计次如何共享同一个不可变批次。更明确的反例是：纯墓碑批正常结束但 Agent 未 clear，本批没有任何 documents 可执行 `recordOrganizeFailure`；墓碑仍在，L341 的“存在下一个到期批次就安排下一批评估”会立刻再次启动模型，形成无退避循环。
- **为什么重要：** 未 mark 计次可能对着另一批文档结算；纯墓碑无进展会造成持续模型调用与费用，现有测试均未覆盖。
- **修法：** 定义每批不可变快照及唯一归属，让预检、`get_delta` 和回合末未推进结算消费同一批；钉死纯墓碑/零进展批次的有界等待或退避策略，并补“正常结束但未 clear 不立即重入”的失败测试。

### 8.3 不阻断项

- **R2-N1 Task 4 Files 漏列实际 `sessionSend` 分支。** 计划 L241 只列 `sessions.ts:1203-1233`，但 queued 后立刻返回 `waiting: true` 的代码在 `sessions.ts:1448-1450`，必须纳入修改。现有 `drainUserQueue` 返回 void 且一次可启动多项（`sessions.ts:1216-1221`），计划 L249 的“返回本轮出队的 queueItemId”宜明确为 `readonly string[]` / 集合同等物，供 `sessionSend` 判断本次项是否已由 `startQueuedItem` 接管。

### 8.4 已做对、应保留的部分

1. 首轮指错的真实锚点大部分已纠正，尤其是 bridge 事件位置、Host 双 effect、`removeSessionFilesById(sessionsRoot, readonly string[])`、`cancelForKb` 无 reason 适配与 `releaseAndDrain`。
2. D1 的 FIFO 契约和两条失败测试与 owner 裁定一致，没有借抢占让新到用户插队；同根不误杀、幂等 release 和 N-9 已写清。
3. 悬空符号链接、空交集 fail-closed、6+3 工具白名单、model 注册名、50 MiB 上限、纯墓碑四层 op 与卡死退场测试均有可执行落点。
4. M1-2 保持无头门禁、ROUTE_TABLE=92，真机/UI/实时推送明确归 M1-3 或发布验收，没有借验收边界阻断本里程碑。

### 8.5 需 owner 拍板与复审出口

- **需拍板 1 项：** R2-5 的“纯墓碑批正常结束但零进展”策略。可不扩 schema：当批无进展则不立即安排下一批，等待下一次入库或显式手动触发；若要求与文档一致做 1/5/3 次持久退避，则需新增墓碑重试状态并同步规格。D1/D2 无需重裁。
- **复审出口：** R2-1～R2-5 与 R2-N1 落入正文、上述拍板写入计划后，做一次聚焦复核即可；不要求推翻单槽、双层白名单或 FIFO 调度架构。

**本轮结论：ITERATE，暂不开工。** 0 阻断说明安全与总体设计无需返工；5 个 Important 均属主链路/跨任务契约缺口，不能以“实施时再定”带入编码。

---

## 9. Owner 裁定：纯墓碑批零进展采用进程内 1/5/3 退避（2026-11-26）

- **Owner 决定：** 采纳 Qoder 建议，**不扩 SQLite schema**；纯墓碑批零进展使用进程内“1 分钟 → 5 分钟 → 第 3 次后停止”退避，零进展记 `organize_failed`，实际清除至少一个墓碑则清零并继续。
- **精确口径：** 纯墓碑批非取消结束且一个墓碑也未清除才计次；第 1 次 60 秒、第 2 次 300 秒、第 3 次停止自动重试。退避期间释放全局整理槽且不建 Agent；抢占、手动停止、维护与退场只清可取消计时器，不计次。Host 重启自然复位。
- **复位约束：** 真实新待整理工作（新文档或墓碑集合变化）与显式手动整理可取消旧计时器、清零并重新评估；**无变更对账和普通 `scheduleEvaluate` 不得清零**，否则 5 分钟周期对账会让“第 3 次停止”失效。
- **测试口径：** 同步推进 fake timer 与 `deps.now`，区分立即重入与真实退避；覆盖正常结束、模型/回合报错、看门狗超时、三次后无第四次、清墓碑复位、真实新工作/手动复位、无变更对账不复位，以及取消/退场不计次且不留可启动 Agent 的计时器。
- **文档落点：** 已同步写入规格 §8.1、§11.1(6) 与 M1-2 计划 Task 5 Interfaces、Step 1 第 9 条、Step 3。

该裁定只关闭 R2-5 的策略选择；R2-5 的权威批次快照、其余实施文本以及 R2-1～R2-4 / R2-N1 仍须修订和复核，**当前开工判定保持 ITERATE**。

---

## 10. 聚焦复审：§8 修订稿（Qoder，2026-11-26）

- **审阅目标：** [2026-11-25-knowledge-base-m1-2-single-slot-organizer.md](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md) 710 行修订稿。
- **方法：** 逐项反证 R2-1～R2-5 / R2-N1，并针对 D1 出队应答继续读客户端 queue-start/queue-fail 归属与回合初始化代码。子代理调用此前未获批准，本轮仍由主会话顺序完成，不声称独立子代理评审。只读源码，未运行实现测试。
- **判定：** **ITERATE。0 阻断 / 2 同轮应补 / 1 组文字 Nit。** 总体架构和 §8 的五个主缺口已补齐，但 D1 新写法会绕过既有排队归属，另发现手动维护拒绝未落地。修复范围明确，无需再改架构。

### 10.1 §8 条目闭环表

| 条目 | 修订证据 | 判定 |
| --- | --- | --- |
| R2-1 Agent 驱动 | 计划 L446–574 定义 create → followup → whenIdle、取消先于 create、首终止原因、observer 模型错误与可控 idle 测试；上游 `runtime-types.ts:185-191,217-222` 契约一致 | **闭环** |
| R2-2 Host/Engine 能力 | 计划 L235–329 定义同一 Host 的存储/open/get/close 批次与真实结算；L73–99 为同步 id provider；L486/L496 为相位窄接口；不再另建 StorageClient | **闭环**，文字小修见 R3-N1 |
| R2-3 心跳与 UI 隔离 | 计划 L73–129 定义 activity/error observer；bridge 先 note 后 suppress，工具 `next()` 与流 `yield` 均有测试；L639 有生产接线回归 | **闭环** |
| R2-4 重建后排期 | 计划 L627–693 既有 reconcile 统一回调，又有 create/rebind/rebuild 提交后补偿；维护解锁与 Wiki reset pending 均有断言 | **闭环** |
| R2-5 批次与纯墓碑退避 | 计划 L235–329、L488–596 固定 peek/open 分工、唯一 open 快照、实际 organized/cleared 结算、签名变化复位与 1/5/3 假时钟测试，符合 §9 | **闭环** |
| R2-N1 FIFO 文件/返回值 | Files 已含 sessionSend，drainUserQueue 已改返回数组；但出队应答的 `started:true` 引入 R3-1 | **部分闭环** |

### 10.2 R3-1（Important）D1 出队分支不能在启动未受理时返回 `started:true`

- **位置：** 计划 L398–412，尤其 L402。
- **源码反证：**
  1. 客户端把 `started:true` 定义为真正开始，并在应答处直接 `openTurnForTab`（`App.tsx:3797-3814`）；而计划中的 `startQueuedItem` 此时仅是异步启动，followup 可能尚未受理，甚至会在随后失败。
  2. `queueOwnersRef` 只在 `sent.waiting && queueItemId` 时登记（`App.tsx:3762-3771`）。计划返回 `waiting:false`，所以 queue-start/queue-fail 失去既有排队归属。
  3. `clearQueueItem` 找不到 owner/userId 就直接返回（`App.tsx:962-985`）；`failQueuedTurn` 的 `noteWaitingFailed` 又只收等待项、不结束 running（`App.tsx:1021-1030`）。因此早失败会被 started 应答重新开回合，晚失败则可能留下永久 running，模型选择也无法按排队失败回滚。
- **反证校准：** queue-start 在缺 owner 时可能早退，因此不能笼统断言必然双初始化；成立且可复现的主问题是**启动失败失去归属与终态**。
- **修法：** 保持 D1 的 `waiting:false`，但出队未受理前返回 `started:false` 并继续携带 `queueItemId`。Task 4 Files 增加 `client-huaanwork/App.tsx` 与 `tests/client-huaanwork/appWiring.spec.ts`：应答处理在 `queueItemId` 存在时登记 queue owner/消息归属（不再以 waiting 为前提），pending replay 对出队应答也保留 queue-start/queue-fail；让 queue-start 成为唯一回合初始化点。补 start/fail 各自早于/晚于应答四条测试，断言只开一次回合、失败不开回合且 running/model 选择正确结算。

### 10.3 R3-2（Important）手动整理在维护期静默跳过，并可能先清零失败计数

- **位置：** 计划 L488–493。
- **问题：** `triggerManual` 先 reset，再经 `scheduleEvaluate({manualKbIds})`；候选接口会排除维护/删除/recovery，最终 Promise 正常结束但没有整理，也没有 busy 错误。规格 §6.4（规格 L272）明确要求维护中拒绝同库 `organize` 并返回 `knowledge-base-busy`。现有 Host 已有私有 `assertNotMaintaining`（`host.ts:222-226`），但新计划没有复用入口。
- **为什么重要：** 调用方会把“未执行”当成“已受理”，且 reset 发生在拒绝前，改变既有失败/退避证据。
- **修法：** Task 5 给 Host 增加内部 `assertOrganizeAllowed(kbId): void`，依次复用 `requireRecord` / `assertNotDeleting` / `assertNotMaintaining`，并拒绝 `wiki-reset-pending` / `index-error`；`autoOrganize=false` 不得拒绝手动。`triggerManual` 必须在任何 reset/计时器变更之前调用它。补维护、删除、两种 recovery、未知库与自动关闭手动可用的测试，并断言拒绝时 `resetOrganizeFailures` 零调用。

### 10.4 R3-N1 文字与跨 Task 一致性（同轮顺手清）

1. 计划 L578/L582 的裸 `host` 改为 `deps.host`，或在代码块前显式 `const host = deps.host`。
2. 计划 L329 不应把 protocol/worker/db 都写成 `Promise<readonly string[]>`：Host/client 为 Promise，`StorageResultMap`、Worker 返回值与同步 `storage-db.ts` 均为 `readonly string[]`。
3. 计划 L370 仍写“返回本轮出队的 queueItemId”单数，与 L366/L395 的数组矛盾，改为 `queueItemIds` / `readonly string[]`。
4. 计划 L317 的 knowledge disposer“只 dispose host”与 Task 6 新增退订/provider/host-ref 清理矛盾，改为“本 Task 不复制退场；完整清理顺序由 Task 6 接线”。

### 10.5 复审出口

- **无需 owner 新拍板。** R3-1 是在 D1 内修正客户端归属，R3-2 是执行规格已有维护拒绝；§9 的 1/5/3 裁定不变。
- **保留：** 真实 Agent 驱动与错误观察、同一 Host 批次/存储门面、心跳/UI 隔离、维护后排期、纯墓碑进程内退避均已达到计划深度。
- **下一轮只聚焦：** R3-1 的 host/client 应答与四条时序测试、R3-2 的零副作用拒绝、R3-N1 文字清理。通过后即可 GO，不重审已闭环架构。

**本轮结论：ITERATE，暂不开工。** 0 阻断；只剩 2 个明确 Important 和 1 组文字修订，无新增产品裁定。

---

## 11. 最终聚焦复审：GO（Qoder，2026-11-26）

- **审阅目标：** [2026-11-25-knowledge-base-m1-2-single-slot-organizer.md](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md) 740 行最终修订稿。
- **范围：** 只复核 §10 的 R3-1、R3-2、R3-N1 与新增红测命令，不重开 §7–§8 已闭环架构。
- **方法：** 主会话只读反证 Host/App/sessionChannel 的真实事件归属、queue-start/queue-fail 早晚于应答四条时序，以及手动维护拒绝的副作用顺序。子代理调用此前未获批准，本轮不声称独立子代理评审。未运行实现测试（尚无 M1-2 实现）；仅对 Step 2 的命令覆盖遗漏做了一行文档修订。
- **最终判定：** **GO。0 阻断 / 0 同轮应补 / 0 未清 Nit；无需 owner 新拍板。**

### 11.1 R3 闭环证据

| 条目 | 计划与源码证据 | 判定 |
| --- | --- | --- |
| R3-1 出队应答与客户端归属 | 计划 L355–447：出队应答为 `waiting:false, started:false, queueItemId`，只有 `startQueuedItem` 驱动；App 按 queueItemId 登记 owner，App 与 `takeEarlyPendingEvents` 两层守卫均改为 queueItemId；queue-start 经 `beginQueuedTurn` 唯一初始化。对应真实代码为 `App.tsx:962-1013,1060-1074,3762-3814` 与 `sessionChannel.ts:276-298` | **闭环** |
| 四条客户端时序 | 计划 L392–393 明确 start/fail 各自早于/晚于应答：start 恰好 open 一次；fail 不 open、不 running、notStarted、模型回滚且原因可见。既有直接 started/waiting 用例保持 | **闭环** |
| R3-2 手动零副作用拒绝 | 计划 L508–520、L550、L576：`assertOrganizeAllowed` 复用 requireRecord/deleting/maintaining，并拒 recovery；调用早于 reset/计时器/manualKbIds。规格 §6.4 L272 已要求 busy，Host 现有 `host.ts:216-226` 可直接复用；autoOrganize=false 手动仍允许 | **闭环** |
| R3-N1 文字与类型 | `deps.host`、Host/client Promise 与 protocol/worker/db 同步数组、queueItemIds 复数、Task 3/6 disposer 分工均已修正；相关 client 注释/Files/git add 同步 | **闭环** |
| TDD 红测覆盖 | Task 4 Step 2 已同时执行 `turn-scheduler-kb-organize.spec.ts` 与 `appWiring.spec.ts`，Step 4 再跑旧 scheduler + 新 scheduler + appWiring 和双端 tsc | **闭环** |

### 11.2 GO 的边界

1. **这是计划准入 GO，不是实现验收 GO。** 编码必须继续按 Task 1–6 的失败测试 → 实现 → 复跑 → 提交执行，不得以本评审替代红绿证据。
2. M1-2 合并前完整门禁仍为独立 `corepack yarn check`、0 失败、`ROUTE_TABLE=92`；不得与另一路含 `verify:aa` 的门禁并发。
3. 真机 GUI、维护页/composer/引用预览及打包应用整理槽观察仍分别归 M1-3/发布验收；本 GO 不提前宣称这些证据。
4. 不再有待修计划项或新增产品裁定。实施若偏离本轮契约，应回到对应 Task 评审，而不是现场改变安全边界、FIFO 或 1/5/3 口径。

**本轮结论：GO，可以进入实施。** §8 与 §10 的准入问题已全部闭合；后续评审转向真实代码、测试输出与完整门禁证据。

---

## 12. GLM 独立复核（2026-11-27）

- **复审方：** GLM 主 agent（CodeBuddy 会话，模型 glm-5.4；评审轨独立于 §1–§11 的 qwen4 / Qoder 轨）。由主会话逐条读源码完成，未使用评审 subagent。
- **审阅目标：** [2026-11-25-knowledge-base-m1-2-single-slot-organizer.md](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md) 740 行，即 §11 确认的最终修订稿。
- **对照基线：** master `5fc019eddf`（M1-1 已合并，仓内无 M1-2 实现）；计划与本评审文档均为未跟踪文件，规格 v2.5 有未提交改动。
- **范围：** 不重开 §7–§10 已闭环的架构裁定；逐条核对 §11 的闭环证据，并对 Task 1–6 的「代码现状」断言、上游契约与测试可区分力做独立反证。
- **方法与边界：** 全程只读源码与文档；无 M1-2 实现，未运行实现测试。落档只写本节与头部判定行，未改计划、规格或代码。
- **判定：** **ITERATE（小幅修订后可开工）。0 阻断 / 1 同轮应补 / 1 Minor / 8 Nit。** §11 的闭环证据经独立核对未见翻案项；本 ITERATE 仅因新增 G-I1——按现稿实施，整理主链路在新建库上必然失败，且计划内的测试会保持绿色。G-I1 写入计划并经定向复核后恢复 GO。

路径约定：`host.ts` / `sync-engine.ts` / `storage-db.ts` / `registry.ts` 指 `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/`；`present-as.ts` / `policy.ts` / `skills.ts` / `sandbox-cwd.ts` 指 `src/huaanwork-guardrails/`；`paths.ts` / `decide.ts` 指 `packages/huaanwork-policy/src/`；`workspace-state.ts` / `automations-host.ts` / `turn-scheduler.ts` / `agent-package/runtime.ts` 指 `src/huaanwork-host/`。条目编号前缀 `G-` 用于与 §3–§10 的 I / N / R2 / R3 区分。

### 12.1 同轮应补（1 项）

#### G-I1 计划没有保证 `<kbDir>/wiki/` 存在，整理 fs 工具在新建库上全部被拒，且测试夹具会掩盖（Task 5 / Task 6，主链路）

- **位置：** Task 5 Step 3 L577–L591（准入后 `openOrganizeBatch` → create，`meta: { cwd: wikiRoot }`）；Task 1 Step 1 第 2 条 L111；Task 6 Step 1 第 1 条 L665。
- **证据：**
  1. M1-1 只创建 `<kbDir>`：`host.ts:407`、`sync-engine.ts:1188`。`wiki/` 只在 `performWikiReset`（`storage-db.ts:411-434`，`mkdirSync` 在 `:427`）里创建，其调用点 `storage-db.ts:522,568,582,1653` 全在损坏恢复 / 重建提交路径。`neutralKnowledgeWikiRootPath` 是纯路径函数（`workspace-state.ts:99-102`，注释「不创建目录」）。新建库在首次整理之前 `wiki/` 不存在；规格 L531「`wiki/` 还空时」同样以目录存在为前提。
  2. 整理槽的 `workspaceRoot` 就是这个 `wiki/`（`policy.ts:254` → `sessionWorkspaceRoot`）。`decide.ts:93-101` 中 read / read_file / glob / grep / edit / write 全部经 `pathsAreInside`（`decide.ts:154-165`）走 `resolveInside`；根不存在时 `realpathSync(root)` 抛错即返回 `null`（`paths.ts:18-22`），六个 fs 工具一律按 `REASON_PATH_ESCAPE` 拒绝。
  3. HuaAnWork 策略先于上游生效，且不会在 create 阶段暴露：上游 session 只校验 `cwd` 是绝对路径（`deepseek-harness/packages/core/session/src/index.ts:112-115`），`withPinnedCwd` 只做词法夹紧（`sandbox-cwd.ts:71-101`），`agents.create` 不会因目录缺失而失败；上游沙箱 `isPathUnder` 的词法快路径会放行（`deepseek-harness/packages/fs/fs-sandbox/src/containment.ts:63`）。结果是 create 成功、回合正常跑完，只是每一步 fs 调用都被 HuaAnWork 策略拒掉。
  4. 上游 `write` 自己会建父目录（`deepseek-harness/packages/fs/fs-local/src/fsio.ts:597-598`），`wiki/docs/`、`wiki/topics/` 不需要额外处理；缺的只有 `wiki/` 这一层。
  5. 计划全文没有创建 `wiki/` 的步骤（检索 `mkdir` 零命中）；L111 只约束登记，并写明「不得用 `existsSync(wiki)` 代替登记」。
- **为什么重要：** Agent 拿不到可用的 fs 工具，`kb_org_mark_organized` 要求 `wiki/docs/<docId>.md` 已存在（L281），必然校验失败。每个批次都以「回合正常结束但未 mark」结算，按 L540 对本批每份文档 `organize_attempts += 1`，三个批次后全部进入 `organize-failed`：新建库一条笔记都写不出来。失败方向是 fail-closed，不触及 §2 的阻断口径，但「放文件自动整理」这条主链路在全部新建库上不可达。
- **为什么测试是绿的：** Task 6 测试 1（L665）的 fake `followup`「写入笔记」用的是测试自己的 fs 调用，不经策略层，还顺手建出了 `wiki/docs/`；Task 5 的十条测试（L535–L547）用 fake `createAgent`，不经过 fs 策略；Task 1 测试 2（L111）只覆盖登记。三层都碰不到「根目录不存在」这个状态。
- **修法：**
  1. Task 5 Step 3：`openOrganizeBatch` 之后、`deps.createAgent` 之前执行 `await mkdir(wikiRoot, { recursive: true, mode: 0o700 })`（与 `createInner` 同 mode）。失败按批次失败结算并带具名 `terminalError`，不得静默跳过。提前建空目录无副作用：`performWikiReset` 对已存在的空 `wiki/` 幂等（`storage-db.ts:415-427`），`isUsableWikiCard` 对缺失路径已容错（`storage-db.ts:1316-1323`）。
  2. 补判别性测试（放 Task 6 测试 1 或 Task 5）：经真实 `host.create` 建库、不触发任何 wiki reset，fake agent 不创建目录。在 `createAgent` 桩内断言 `existsSync(wikiRoot)`，并用真实的 `preExecuteExplained({ name: 'write', args: { file_path: 'docs/<docId>.md' }, workspaceRoot: wikiRoot }, 'ask')`（`decide.ts:61`）断言 `decision === 'allow'`。同一断言在 mkdir 之前应得到 `deny`，以此证明测试有区分力。

### 12.2 不阻断项（1 Minor + 8 Nit，同轮顺手清）

- **G-M1 present-as 新增与 `huaanworkPackageChildAllow` 取交集，是对 `@agent` 路径的行为改动，计划未说明也未覆盖回归。** 位置 L171、L181、L206。
  - 现状：`present-as.ts` 对该表只做 `.has()` 判 `hideSkill`（`present-as.ts:147`）；包链路的收窄由 `skills.ts:634-638,653-657` 的 `allow ∩ schemas` 完成；`composeAgentPackageToolAllowList`（`runtime.ts:168-188`）不含 `write` / `edit` / `skill`。按代码推断，加上交集后最终可见集不变——**本轮未运行验证**。
  - 缺口 ①：Task 2 Step 4（L206）只跑 4 个 spec，未含 `package-subagent-lineage.spec.ts`、`agent-package-tools.spec.ts`、`skills.spec.ts`、`agent-package-runtime.spec.ts`。
  - 缺口 ②：AGENTS.md 技术债表记有「dormant M6 defensive read-side alignment requires a separate owner ruling」，是否即本改动请 owner 确认。
  - 建议二选一：present-as 只消费 `huaanworkSessionToolAllow`（整理槽只需要它，`@agent` 路径零改动）；或保留交集、把上述 4 个 spec 加进 Step 4，并在计划里记录裁定。
- **G-N1 `systemPrompt.context` 片段缺必填字段。** L585–L589 未传 `name` 与 `order`；`PromptContext` 两者必填（`deepseek-harness/packages/core/system-prompt/src/index.ts:79-90`），非有限 `order` 在 `:513-516` 抛 `TypeError`。tsc 可拦，顺手补上，并让测试 3（L537）断言注册不抛。
- **G-N2 每个 Task 的类型检查漏掉 tests 工程。** L143–L144、L207、L342、L439–L440、L636 只跑 `tsconfig.json` / `tsconfig.client.json`；`dsh-plugin-huaanwork/package.json:188` 的 `typecheck` 共 5 个工程。新 spec 的类型错误会拖到 Task 6 的 `yarn check` 才暴露。改为 `corepack yarn workspace dsh-plugin-huaanwork typecheck`。
- **G-N3 Task 3 测试 9 的 `unlink` spy 不可行。** L296「给 storage worker 模块加 `unlink` spy」：knowledge 系列测试经 `createKnowledgeStorageClient()` 驱动真实 worker 线程（`knowledge-storage.spec.ts:307` 等），主线程 spy 看不到 worker，该系列也无 `vi.mock` 先例。改为黑盒断言：建一条带真实 `wiki/docs/<docId>.md` 的墓碑行，经真实 client 调用 `clearOrganizeTombstones` 后行已删、文件仍在。
- **G-N4 墓碑「文件已不存在」与 `resolveInside` 顺序冲突。** L283「再过 `resolveInside` + `lstat`……文件已不存在则视为可清行」：不带 `forWrite` 的 `resolveInside` 对不存在的文件返回 `null`（`paths.ts:24-31`），按字面顺序会落入「整次调用在副作用前拒绝」，文件已丢的墓碑永远清不掉。写明：先 `lstat`，`ENOENT` 即可清行；否则 `resolveInside(wikiRoot, rel, { forWrite: true })` 加常规文件校验。测试 9 已含「文件已不存在」用例，能兜住。
- **G-N5 看门狗机制口径不一。** L527「沿用自动化收集器」、L624「实现与自动化 `activityDeadline` 同型」与「只用 `deps.now`」、L524「把看门狗基准拨到注入时钟的当前值」并存。`activityDeadline`（`automations-host.ts:283-315`）是纯 `setTimeout` 加 `touch()` 重新起算，没有时钟基准可「拨」。单取任何一种字面实现都只能满足测试 5（L542）的一半：纯定时器下 `noteSystemResume()` 不重新起算就会超时，纯时钟基准下没有人负责唤醒。建议直接钉死组合方式：定时器只负责唤醒，唤醒时用 `deps.now()` 与 `touch()` 维护的基准比较；`noteSystemResume()` 即 `touch()`。
- **G-N6 `pauseWatch` / `resumeWatch` 会覆盖整理相位。** L629 只让 `settlePhase` 保留四个整理相位；`pauseWatch`（`sync-engine.ts:1329,1340`）与 `resumeWatch`（`:1349`）只挡 `needsRecovery`，用户在整理中切换「暂停监听」会把 `organizing` 刷成 `watch-paused` / `watching`。属显示问题，不影响结算。给这三处加 `isOrganizerPhase`，或在计划里写明接受。
- **G-N7 测试 7（L391）与测试 8（L545）的前置状态需特殊构造。** 「甲已入队且根空闲，同时整理占着名额」按计划自己的准入规则，用普通占名额写者构造不出来：`admitKbOrganize` 遇非空队列直接 skip（L378、L388），而普通写者释放后 `drainQueue` 会立刻启动甲（`turn-scheduler.ts:216-239`）。可行构造两种：让甲与整理写者同根（命中「同根排队、不取消整理」，L386）；或让甲的根被不占名额的 `script-automation` 写者（`countsTowardCap=false`，`turn-scheduler.ts:160-166`）占住后释放。建议把构造写进测试描述。
- **G-N8 `organize_retry_after` 到期后的再评估触发源未写明。** 文档失败只记 `retry_after`（L540），没有对应计时器；实际依赖周期对账（`DEFAULT_RECONCILE_INTERVAL_MS = 300_000`，`sync-engine.ts:54`）与排空后的 `reevaluateKbOrganize`。补一句说明，避免实施者另加计时器或误以为 60 秒必然重试。

### 12.3 逐条核对成立的部分

| 核对项 | 证据 | 判定 |
| --- | --- | --- |
| 调度与出队 | `admitUserTurn`（`turn-scheduler.ts:121-147`）；幂等 `release`（`:171-177`）；`drainQueue` 按 `enqueuedAt` 扫描、根忙跳过、满额 break（`:216-239`） | 与 Task 4 的契约描述一致，D1 可在其上实现 |
| R3-1 客户端归属 | `App.tsx` 的 queue owner 登记与 `sessionChannel.ts` 的两层守卫均以 `queueItemId` 为条件 | 与 §11.1 一致 |
| 上游 Agent 驱动 | `followup()` 同步置 running 再返回（`deepseek-harness/packages/core/agent-loop/src/agent.ts:154-165,214-235`）；紧随其后的 `whenIdle()`（`:237-242`）等回合结束，不会立即 resolve；`kick()` 在驱动边界吞掉报错（`:252-265`），取消 / 报错后 `whenIdle()` 仍 resolve | 支持 L594–L601 的 create → followup → whenIdle，以及「首因获胜 + bridge 记 `firstModelError`」 |
| `settlePhase` 守卫 | `reconcileInner` 只对 steady 相位置 `syncing`（`sync-engine.ts:230-236,900`） | L629 可行 |
| M1-1 底座 | `autoOrganize` 已在注册表（`registry.ts:48,61`）；`KnowledgeOrganizerHooks`（`host.ts:107-111`）与批次 / 计次 / 墓碑 storage op 均已存在 | 与 §1.3、§8.1 一致 |

### 12.4 处置建议与复审出口

1. 开工前把 G-I1 写入计划（Task 5 Step 3 一行 `mkdir` 加一条判别性测试），这是恢复 GO 的唯一必要条件。
2. G-M1 需 owner 一句话裁定（收窄到 `huaanworkSessionToolAllow`，或保留交集并补 4 个 spec）。G-N1～G-N8 可在修订计划时顺手清，其中 G-N5、G-N7 建议同轮处理，否则实施者会在测试上反复试错。
3. 修订后只需对 G-I1 的两个落点做一次定向复核，不必重开 §7–§11 已闭环的架构项。本节结论为 GLM 轨单方核验，尚未经 Qoder 轨或 owner 背靠背确认。

**本轮结论：ITERATE，G-I1 写入计划并经定向复核后再开工。**

## 13. Qoder 轨背靠背核验（2026-11-27）

- **核验方：** Qoder 主会话。对 §12 全部条目逐条独立读源码反证，未复用 GLM 的检索结论；全程只读，未运行实现测试（仓内无 M1-2 实现）。路径约定同 §12。
- **判定：** **§12 属实，ITERATE 校准成立。** G-I1 属「缺落点」，与 I-1「主链路断」同类，失败方向 fail-closed，按本文 §2/§3 口径定同轮应补而非阻断，严重度无误。

### 13.1 G-I1 证据链逐环复核（全部成立）

1. **新建库无 `wiki/`：** `host.ts:407` 与 `sync-engine.ts:1188` 只 `mkdir(kbDir)`；全 knowledge 目录 `mkdir` 检索确认 `wiki/` 唯一创建点是 `performWikiReset`（`storage-db.ts:427`），四个调用点（`:522` 重试重置、`:568`/`:582` 崩溃恢复、`:1653` 重建提交）全部以 pending 标记或恢复路径为前提，新建库不经过。`neutralKnowledgeWikiRootPath` 纯路径（`workspace-state.ts:99-102`）。
2. **策略层必拒：** 整理槽 `workspaceRoot` 经 `policy.ts:254` → `sessionWorkspaceRoot` 直查根表命中 `wiki/`（`sandbox-cwd.ts:126-128`）；`decide.ts:93-101` 六个 fs 工具走 `pathsAreInside` → `resolveInside`，根不存在时 `realpathSync(root)` 抛错返回 `null`（`paths.ts:18-22`）→ `REASON_PATH_ESCAPE`。
3. **create 不暴露：** 上游 session 只校验 cwd 为绝对路径（`core/session/src/index.ts:112-115`）；`withPinnedCwd`/`isInside` 纯词法（`sandbox-cwd.ts:71-101,141-144`）；上游沙箱 `resolve` 对最深存在祖先做 canonicalize，`isPathUnder` 词法快路径放行（`fs-sandbox/src/containment.ts:63`）。上游 `write` 自建父目录（`fs-local/src/fsio.ts:597-598`）但根本到不了——HuaAnWork 策略先拒。
4. **计划无 mkdir 落点：** 全文检索确认；Task 5 Step 3（L577–591）open 后直接 create。后果链成立：write 被拒 → 无 `wiki/docs/<docId>.md` → mark 校验（L281）必败 → 每批未 mark 文档计次（L606–620）→ 三批后 `organize-failed`（L540）。
5. **测试 masking 成立：** Task 6 测试 1 的 fake followup 用测试侧 fs「写入笔记」，为让 mark 通过必须自建 `wiki/docs/`；Task 5 十条测试 fake `createAgent`；Task 1 测试 2 只覆盖登记。三层都碰不到「根不存在」。
6. **修法可落地：** `mkdir(wikiRoot, {recursive:true, mode:0o700})` 与 `createInner` 同 mode；`performWikiReset` 对已存在空 `wiki/` 幂等（`storage-db.ts:415-427`）；`isUsableWikiCard` 缺失容错（`:1316-1323`）。判别性测试走真实 `preExecuteExplained`（`decide.ts:61`）：mkdir 前 deny、mkdir 后 allow，区分力成立。

### 13.2 G-M1 复核成立，补充两点

- 现状断言全部核实：`present-as.ts:147` 对 `huaanworkPackageChildAllow` 只做 `.has()` 判 `hideSkill`；`ALLOWED_TOOLS` 含 `write`/`edit`/`str_replace_editor`/`skill`（`present-as.ts:16-28`）；包链路收窄在 `skills.ts:637-638,656-657`；`composeAgentPackageToolAllowList` 不含 `write`/`edit`/`skill`（`runtime.ts:173-187`）。因此 L171 的交集会关闭包儿童在 skills.ts 收窄前 `write`/`edit` 短暂可见的窗口——确属 `@agent` 路径行为改动，计划未声明、Task 2 Step 4（L206）未含 4 个包链路 spec，缺口属实。
- 补充 ①：AGENTS.md 债务表「dormant M6 defensive read-side alignment」指 `skills.ts` 休眠读侧对齐，与本改动（present-as 可见集计算）**不是同一项**；但行为改动本身仍需 owner 裁定，GLM 提请确认的方向正确。
- 补充 ②：倾向方案一（present-as 只消费 `huaanworkSessionToolAllow`）：整理槽只需要它，`@agent` 路径零改动，符合 YAGNI；方案二（保留交集 + 补 4 spec）也可行但扩大评审面。

### 13.3 G-N1～G-N8 逐条复核（全部属实）

| 条目 | 独立反证关键证据 | 判定 |
| --- | --- | --- |
| G-N1 | `PromptContext` 的 `name`/`order` 必填（`system-prompt/src/index.ts:79-90`），非有限 `order` 抛 `TypeError`（`:513-516`）；计划 L585–589 两者均未传 | 属实，Nit 恰当（tsc 可拦） |
| G-N2 | `package.json:188` typecheck 共 5 工程（含 `tsconfig.tests.json`/`tsconfig.tests.client.json`）；计划 L143-144/L207/L342/L439-440/L636 只跑 1–2 个 | 属实 |
| G-N3 | `createKnowledgeStorageClient` 经真实 `worker_threads`（`storage-client.ts:12,122`；`knowledge-storage.spec.ts:307`）；knowledge 系列 spec 无 `vi.mock` 先例，主线程 spy 看不到 worker 模块；黑盒替代（行删、文件仍在）可断言同一不变量 | 属实 |
| G-N4 | 不带 `forWrite` 的 `resolveInside` 对不存在文件返回 `null`（`paths.ts:24-31`）；L283 字面顺序会把「文件已丢」墓碑落入整次拒绝，永远清不掉；先 `lstat` ENOENT 即可清行的修法正确 | 属实 |
| G-N5 | `activityDeadline` 纯 `setTimeout` + `touch()` 重新起算（`automations-host.ts:283-315`），无时钟基准；计划 L524/L527/L624 三种口径并存，单取其一只能满足测试 5 的一半；「定时器只唤醒、`deps.now()` 对比 `touch()` 基准、`noteSystemResume()` 即 `touch()`」组合可实施且满足测试 5 正反两向 | 属实，同意同轮钉死 |
| G-N6 | `pauseWatch`（`sync-engine.ts:1329,1340`）与 `resumeWatch`（`:1349`）只挡 `needsRecovery`；计划 L629 只让 `settlePhase` 保留整理相位，未覆盖这三处 | 属实，显示层 Nit |
| G-N7 | `admitKbOrganize` 队列非空 skip（L378）；`drainQueue` 按 `enqueuedAt` 扫描、根忙跳过、满额 break（`turn-scheduler.ts:216-239`）；`script-automation` 不占名额（`:160-166`）。逐步推演确认普通占名额写者构造不出「甲入队且根空闲、整理占名额」；GLM 两种构造均成立（同根排队不抢占；script 占根→甲入队→script 释放后 drain 被整理满额挡住） | 属实，同意构造写进测试描述 |
| G-N8 | `DEFAULT_RECONCILE_INTERVAL_MS = 300_000`（`sync-engine.ts:54`）；文档级 `retry_after` 无计时器，实际触发源是周期对账与排空后 `reevaluateKbOrganize`，计划未写明 | 属实 |

### 13.4 精度补注（不改判定）

- G-I1「六个 fs 工具一律按 `REASON_PATH_ESCAPE` 拒绝」对**不带 path 参数**的 `glob`/`grep` 不严格成立：`allowMissing=true` 时策略层放行（`decide.ts:98,159`）。但整理提示词使用 `wiki/` 相对路径、write/edit/read 必带路径，主链路结论不受影响。
- §12.3 五行（调度契约、R3-1 客户端归属、上游 followup/whenIdle/kick、`settlePhase` 守卫、M1-1 底座）与头部基线声明（HEAD `5fc019eddf`、计划/评审未跟踪、规格 v2.5 有未提交改动）均独立核对无误。

### 13.5 复审出口

同意 §12.4：G-I1 写入计划（Task 5 Step 3 一行 `mkdir` + 一条判别性测试）并经定向复核后恢复 GO，不重开 §7–§11 已闭环架构项；G-M1 待 owner 二选一；G-N1～G-N8 修订时顺手清，G-N5/G-N7 同轮钉死。本节为 Qoder 轨对 GLM 轨的背靠背确认，两轨结论一致。

## 14. Owner 裁定与定向复核：恢复 GO（2026-11-27）

### 14.1 Owner 裁定：G-M1 方案一

2026-11-27 owner 拍板：**present-as 只消费 `huaanworkSessionToolAllow`，不读 `huaanworkPackageChildAllow`**。整理槽只需要它，`@agent` 路径零改动、零回归面，不补 4 个包链路 spec。已写入计划 Task 2 Interfaces 与测试 2（改为断言 packageChildAllow 不影响可见集）。

### 14.2 G-I1 两个落点定向复核（Qoder 轨）

- **落点 1（计划 Task 5 Step 3 与驱动片段）：** 准入后 `openOrganizeBatch` → `await mkdir(wikiRoot, { recursive: true, mode: 0o700 })` → 注册 activity touch → `createAgent`。mkdir 失败按批次失败结算，具名 `terminalError = knowledge-organize-wiki-root-unwritable` 已进入 terminalError 枚举；Task 5 测试 4 补 mkdir 失败结算用例（同名 regular file 占位构造）。与 §13.1 核实的代码事实一致：`createInner` 同 mode（`host.ts:407`）、`performWikiReset` 对空 `wiki/` 幂等（`storage-db.ts:415-427`）、`isUsableWikiCard` 缺失容错（`:1316-1323`）。
- **落点 2（Task 6 测试 1）：** 真实 `host.create` 建库、不触发 wiki reset、fake agent 不自建目录；`createAgent` 桩内断言 `existsSync(wikiRoot)`，并以真实 `preExecuteExplained`（`decide.ts:61`）断言 write `allow`；同一调用对未建 `wiki/` 的对照库根得 `deny`。allow/deny 对照使「夹具自建目录掩盖缺陷」不再可能，区分力成立。
- **G-N1～N8 落点抽查：** `name`/`order` 已入 setup 片段与测试 3；5 处 per-task 类型检查统一为 `corepack yarn workspace dsh-plugin-huaanwork typecheck`（全文不再残留 `tsc -p` 单工程命令）；测试 9 改黑盒断言；墓碑校验先 `lstat`（ENOENT 可清行）再 `resolveInside(forWrite)`；看门狗三处口径统一为「定时器只唤醒 + `deps.now()` 与 `touch()` 基准比较，`noteSystemResume()` 即 `touch()`」；`pauseWatch`/`resumeWatch` 三处加 `isOrganizerPhase` 守卫并由测试 12 断言；测试 7/8 前置构造（script-automation 占根释放 / 同根排队）已写进描述；文档级 `retry_after` 触发源（周期对账 + 排空后再评估，不另设计时器）已写明。

### 14.3 判定

**GO（计划准入恢复）。0 阻断 / 0 同轮应补 / 0 未清 Nit。** 边界同 §11.2：本 GO 只覆盖计划，不代表实现已验收；实现仍须逐 Task 红绿并独立通过 `corepack yarn check`（0 失败、`ROUTE_TABLE=92`，不与另一路含 `verify:aa` 的门禁并发）；真机 GUI、维护页/composer/引用预览与打包应用整理槽观察维持 M1-3/发布边界。实施若偏离本轮契约，回到对应 Task 评审，不得现场改变安全边界、FIFO 或 1/5/3 口径。

---

## 15. GLM 修复确认：§12 十项闭环，同意 GO（2026-11-27）

- **复核方：** GLM 主 agent（CodeBuddy 会话，模型 glm-5.4），即 §12 的提出方。由主会话逐条读源码完成，未使用评审 subagent。
- **审阅目标：** [2026-11-25-knowledge-base-m1-2-single-slot-organizer.md](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md) 修订稿 748 行（qwen4 按 §12–§14 修订，由 740 行增至 748 行），即 §14 确认恢复 GO 的版本。
- **对照基线：** 同 §12：master `5fc019eddf`，仓内无 M1-2 实现；计划与本评审文档仍为未跟踪文件，规格有未提交改动。
- **范围：** 只回答两个问题——§12 的十项是否在修订稿里真正闭环（对源码，不只看修订说明）；修订是否引入新问题。不重开 §7–§14 已闭环的架构裁定与 owner 裁定。
- **方法与边界：** 把修订稿与修订前副本逐 hunk 比对，17 个 hunk 全部对应 §12 的处置，无夹带改动；再逐项回到源码核对修订稿新写入的断言。全程只读，无 M1-2 实现，未运行实现测试。落档只写本节与头部判定行，未改计划、规格或代码。
- **判定：** **同意 §14 的 GO。0 阻断 / 0 同轮应补。** §12 十项全部闭环、逐项对过源码，无翻案项。修订稿另留 3 条 Nit（R-1～R-3）与 1 条真机观察（R-4），均不阻断、不改变 GO。

路径约定同 §12。残留项编号前缀 `R-`。

### 15.1 §12 十项逐项确认

| 条目 | 修订稿落点 | 独立核对 | 判定 |
| --- | --- | --- | --- |
| G-I1 | L582、L585：准入并 `openOrganizeBatch` 后、`createAgent` 前 `await mkdir(wikiRoot, { recursive: true, mode: 0o700 })`；L546、L614：失败按批次结算，`terminalError = knowledge-organize-wiki-root-unwritable`；L673：Task 6 测试 1 判别性断言 | `preExecuteExplained({ name: 'write', args: { file_path: 'docs/<docId>.md' }, workspaceRoot: wikiRoot }, 'ask')`（`decide.ts:61`）：`write` 走 `pathsAreInside(input, true, false)`（`decide.ts:100-101`）→ `resolveInside`。根已建时 `existingParent` 落到 `wiki/`，返回库内路径 → `allow`；根未建时 `realpathSync(root)` 抛错返回 `null`（`paths.ts:17-22`）→ `deny` + `REASON_PATH_ESCAPE`。计划写死的对照结果与源码一致，测试有区分力 | 闭环 |
| G-M1 | L176、L186：present-as 只读 `huaanworkSessionToolAllow`，不消费 `huaanworkPackageChildAllow`；测试 2 改为断言 packageChildAllow 不影响可见集 | 与 §14.1 owner 裁定方案一逐字一致，全文再无第二处取交集的表述 | 闭环 |
| G-N1 | L541（测试 3）、L591–L597（setup 片段）：`name`、`order: 40`、`required`、`interpolate` | 四个字段均为 `PromptContext` 真实字段（`deepseek-harness/packages/core/system-prompt/src/index.ts:79-90`）；上游具名 `CONTEXT_ORDERS` 为 100–210（`:170-179`），`order: 40` 合法且不与任何具名槽位相撞 | 闭环 |
| G-N2 | L149、L212、L347、L444、L644 | 五处均为 `corepack yarn workspace dsh-plugin-huaanwork typecheck`，全文 `tsc -p` 零命中 | 闭环 |
| G-N3 | L301（测试 9） | 改为经真实 `createKnowledgeStorageClient()` 的黑盒断言（行已删、文件仍在）。夹具可构造：`upsertDocument` → `markOrganizedAtomic`（写入 `wiki_note_path`）→ 测试侧落一个真实 `wiki/docs/<docId>.md` → `deleteDocument`（`wiki_note_path` 非空即写 `organize_tombstones`，`storage-db.ts:654-671`） | 闭环 |
| G-N4 | L288 | 先 `lstat`，`ENOENT` 即可清行；存在才过 `resolveInside(wikiRoot, rel, { forWrite: true })` 加非常规文件/符号链接校验。悬空符号链接经 `lstat` 报告为符号链接，仍被拒，调换顺序没有削弱检查 | 闭环 |
| G-N5 | L528、L531、L632 | 三处统一为「定时器只唤醒 + `deps.now()` 对 `touch()` 基准，`noteSystemResume()` 即 `touch()`」，该机制能同时满足测试 5 正反两向。L531 的拨钟措辞仍与机制相左，见 R-3 | 闭环（措辞见 R-3） |
| G-N6 | L554（测试 12）、L637 | `isOrganizerPhase` 守卫明确加到 `settlePhase`、`pauseWatch`、`resumeWatch` 三处 | 闭环 |
| G-N7 | L396（测试 7）、L550（测试 8） | 两种构造（`script-automation` 占根后释放 / 甲与整理同根）已写进测试描述 | 闭环 |
| G-N8 | L544 | 写明不另设计时器，由周期对账（300 秒）与 `reevaluateKbOrganize` 触发，60 秒不是精确重试时刻 | 闭环 |

### 15.2 残留项（3 Nit + 1 真机观察，均不阻断）

#### R-1 Task 6 测试 1「fake agent 自己不创建目录」字面不可实现（Nit）

- **位置：** L673；§14.2 落点 2 沿用了同一表述。
- **问题：** organizer 的 `mkdir(wikiRoot, { recursive: true })` 只建出 `wiki/` 这一层；而同一测试里 fake `followup` 要「写入笔记」到 `wiki/docs/<docId>.md`，真实的 `kb_org_mark_organized` 又要求该路径已是常规文件（L286）。`wiki/docs/` 与笔记文件只能由 fake 侧补建（上游真实 `write` 本来就会自建父目录，`deepseek-harness/packages/fs/fs-local/src/fsio.ts:597-598`），「不创建目录」按字面做不到。
- **判别力不受影响：** 区分力来自 `createAgent` 桩内、fake `followup` 运行之前断言的 `existsSync(wikiRoot) === true`，以及未建 `wiki/` 的对照库根得 `deny`。fake 事后补建 `docs/` 不参与这两个断言。
- **建议改法：** L673 的「fake agent 自己不创建目录」改为「fake 不创建 `wiki/` 根；`docs/` 与笔记文件按上游 `write` 的行为由 fake 补建」，其余不动。

#### R-2 `mkdir(wikiRoot)` 失败是否计入 `organize_attempts` 未写明，规格未同步（Nit）

- **位置：** 计划 L546；规格 [2026-11-24-knowledge-base-design.md](../specs/2026-11-24-knowledge-base-design.md) L79、L418。
- **问题：** L546 只写「按批次失败结算」。按计划可推出计入：`openOrganizeBatch` 先于 mkdir（L582），`finally` 对已 open 的批次统一走 `closeOrganizeBatch` 并完成唯一一次事件/失败计次（L633），「非取消批次按实际结算计次」（L614）→ 本批全部文档各 `organize_attempts += 1`，三批后 `organize-failed`；纯墓碑批则落入 L532 的 1/5/3 零进展退避。但 L546 没有明说，规格的计次清单（L79、L418）也没有「wiki 根不可写」这一条。
- **口径意见：** GLM 认为计入是正确选择——有界（不建 Agent、零模型成本），修好文件系统后 `triggerManual` 清零（L545）；若按 `blocked-*` 不计次，会每个对账周期重试一次并持续写 `organize_failed`。
- **建议改法：** L546 补「计入 `organize_attempts`，与未 mark 同口径」；规格 L79 与 L418 各补一句。

#### R-3 L531 的拨钟说法与钉死机制相左（Nit）

- **位置：** L531；L547（测试 5）顺序正确，只需补一句限定。
- **问题：** L531 写「测试同时推进 fake timer 与 `deps.now`……`noteSystemResume()` 之后，向前跳 20 分钟不算超时」。在 L531 / L632 钉死的机制下，两个时钟一起前进 20 分钟会让定时器唤醒，此时 `deps.now() - 基准` 已超过 `timeoutMs()`，无论是否调用过 `noteSystemResume()` 都判超时。按字面写测试，合规实现过不了；实施者最省事的「修法」恰恰是让 `noteSystemResume()` 吞掉下一次唤醒，即 L531 明令禁止的那一半。
- **建议改法：** L531 末两句改为「测试 5 的拨钟顺序钉死为：只把 `deps.now` 向前拨 20 分钟（不推进 fake timer）→ `noteSystemResume()` → 再推进 fake timer（不足 `timeoutMs()`）→ 不超时、不计次；反例省掉 `noteSystemResume()`，推进 fake timer 到唤醒 → 超时并计次。『同时推进 fake timer 与 `deps.now`』只适用于纯墓碑退避计时器（测试 9）」。L547 加「拨钟期间不推进 fake timer」。

#### R-4 真机唤醒时序无头测试覆盖不到（观察）

- **位置：** L717–L718（`knowledgeHost.onSystemResume(organizer.noteSystemResume)`）；L678（测试 6）。
- **问题：** 休眠唤醒后，看门狗定时器回调与 `powerMonitor` 的 resume 事件谁先到取决于平台时序；fake timer 测试只能证明「`noteSystemResume()` 先到」这一种顺序。若定时器先到，一次超过 `automation_timeout_ms` 的休眠会被记成 `knowledge-organize-idle-timeout` 失败。有 3 次上限与 `triggerManual` 清零兜底，所以不阻断。
- **建议：** 列入真机验收（M1-3 或发布清单）：整理批次进行中休眠超过 `automation_timeout_ms` 后唤醒，预期批次不以 `knowledge-organize-idle-timeout` 结算、相位与名额最终释放；若出现 adverse 顺序，回到设计补「唤醒后先让 resume 事件落地再比较基准」。

### 15.3 判定与出口

**同意 §14 的 GO。** §12 十项在修订稿中全部闭环，G-I1 的两个落点经源码确认有区分力，不再有「测试保持绿色但主链路必败」的缺口。

1. R-1～R-3 是修订稿引入或遗留的措辞与口径问题，建议开工前顺手清：三处合计约五行改动，不涉及安全边界、FIFO 或 1/5/3 口径。按 15.2 的改法落地后不需要再做一轮复核；不清也可开工，代价是 R-1、R-3 各在 Task 5 / Task 6 写测试时造成一次返工，R-2 留下规格与计划的口径差。
2. R-4 由 M1-3 / 发布真机验收承接，不占实施轮次。
3. 本节为 GLM 轨对修订稿的单方确认，尚未经 Qoder 轨背靠背；残留项均为 Nit，不需要 owner 裁定。
