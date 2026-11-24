# 知识库模块多视角设计评审报告与修订方案（方案 A+）

- 日期：2026-11-24
- 评审对象：[`docs/superpowers/specs/2026-11-24-knowledge-base-design.md`](./2026-11-24-knowledge-base-design.md)（v1 初稿）
- 基线：外层仓库 `dd68839faf`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`dsh-v0.2.1-alpha.2-981-g1600d8a1e1`）；本地 Electron `44.0.0`（Node `24.18.1`）
- 评审方法：遵循 `multi-agent-brainstorming` 四角色严格串行评审规程（**Skeptic / Challenger → Constraint Guardian → User Advocate → Integrator / Arbiter**）+ 全量源码级反证 + Electron `ELECTRON_RUN_AS_NODE=1` 活体运行时探针
- 首轮仲裁结论（v1）：**`REVISE`**（须按本文方案 A+ 与 §8 门禁清单修订规格后再进入 `writing-plans`）
- 首轮发现汇总（共 **41 项**，均经源码或活体探针核实）：
  - **严重（Critical）：18**（`SK-1`–`SK-7`、`CG-1`–`CG-6`、`UA-1`–`UA-5`）
  - **重要（Important）：20**（`SK-8`–`SK-16`、`CG-7`–`CG-11`、`UA-6`–`UA-11`）
  - **一般（Minor）：3**（`CG-12`、`UA-12`–`UA-13`）
- 首轮裁决统计：**40 项 ACCEPT**、**1 项 PARTIAL ACCEPT（`SK-16`）**、**0 项 REJECT**
- **第二轮复核与收口结论（2026-11-24，v2 → v2.1，见 §9）：`APPROVED`（通过）**。Grok 修订版 v2 已完整吸收首轮 18 项 Critical 与全部 `D1`–`D16` 并校准源码事实；第二轮源码复核额外发现 **5 项 Important（`R2-I1`–`R2-I5`）与 1 项 Minor（`R2-M1`）**，均已于 v2.1 定向补齐闭环。该结论只覆盖这 6 条点名项。
- **第三轮 Grok 审核结论（2026-11-24，针对 v2.1，见 §10）：`ITERATE`**。第二轮点名项的源码依据成立，但 v2.1 仍有 **2 项阻断（`G3-B1`–`G3-B2`）** 与 **4 项同轮应补（`G3-I1`–`G3-I4`）**，未达到 `superpowers:writing-plans` 的准入。架构与 `D1`–`D16` 不推翻。
- **第三轮校准核实与最终收口（2026-11-24，v2.1 → v2.2，见 §11）：`APPROVED`（通过）**。经逐项源码核验，Grok 第三轮 6 项缺口均属实；同时对其中 3 项做了源码级细化校准（补齐 `kb_read_wiki` 引用类型与失效回落、核实 `resolveSessionModel` 不拦空 `model: ''` 须额外判空、修正 3 次上限下的 2 档退避计时消除不可达第 3 档），已全部落入 v2.2，达到 `superpowers:writing-plans` 准入基线。
- **第四轮 Opus 审核结论（2026-11-24，针对 v2.2，见 §12）：`ITERATE`（有条件通过）**。Opus 独立源码复核与 Electron 44 实测确认整体质量高且核心机制成立，但指出 **4 项写计划前应补缺口（`O4-1`–`O4-4`，其中 `O4-1` 在不改子模块前提下无可用删除接口）** 与 **8 项次要建议**；补齐 `O4-1`–`O4-4` 后即可进入 `writing-plans`。
- **第四轮校准核实与最终收口（2026-11-24，v2.2 → v2.3，见 §13）：`APPROVED`（通过）**。经逐项源码二次复核，确认 `O4-1`–`O4-4` 核心均成立并对 2 处细节做了源码校准（`O4-4` 明确不登记 `huaanworkUnattended`、`§12.4` 打包冒烟维持 `ELECTRON_RUN_AS_NODE=1` 并将 `utilityProcess.fork` 实测归入真机验收）；同时将 `O4-1`–`O4-4` 与全部成立的 7 项次要项一并落入 v2.3，达到 `superpowers:writing-plans` 准入基线。

---

## 1. 总体判决、实测基线与应保留的架构不动产

### 1.1 总体判决

v1 规格的宏观方向（**方案 A**：Host 内嵌 `knowledge/` 域 + `<profileDir>/workspace-knowledge/<kbId>/` 每库物理隔离 + Worker 池只读解析 + SQLite FTS5/可选 Embedding 双层检索 + 受控整理 Agent + 会话级多选挂载）与 HuaAnWork 桌面端现有 `expert-team/`、`agent-package/` 体系高度同构，且完整覆盖用户已锁定的全部需求边界。

但经过三视角源码级压力测试，v1 初稿存在 **18 项会导致生产故障、打包失败、权限失真或核心交互不可用的 Critical 缺陷**（例如：§9.3 REST 路径与 `routes.ts`/`api.ts` 100% 不兼容、对进程内 fs 工具误称存在 OS 沙箱保护、`str_replace_editor` 在 `decide.ts` 必拒且整理 Agent 无删文件工具、Host 主线程同步 SQLite 向量扫描击穿 2 秒活性探针、活体探针发现 `worker_threads` 不继承 `process.noAsar = true`、`sharp` 位于 `devDependencies` 且与 `mac-universal.ts` 硬编码绑定、Host 退出 3 秒强杀崖壁、`session_projcache` 无界膨胀、助手纯文本气泡与 YAML frontmatter 渲染错乱等）。因此仲裁为 **`REVISE`**，不改变已锁定产品目标，修订至 **方案 A+（v2）** 后可进入实施计划。

### 1.2 已核实成立、应保留的底座与活体探针事实

1. **Electron 44 运行时能力（活体探针实证）**：在打包态等效环境 `ELECTRON_RUN_AS_NODE=1` 下实测本地 Electron `44.0.0`（Node `24.18.1`）：`node:sqlite`（`DatabaseSync`）、`FTS5 + bm25()` 与 `node:worker_threads` 均正常加载运行，无需引入 C++ 原生 SQLite/向量扩展。
2. **每库独立物理隔离目录与两阶段解耦（`D1`、`D6`）**：`<profileDir>/workspace-knowledge/<kbId>/` 单库独立落盘、`documents` 拆分索引指纹与整理指纹，使删库清理、阶段 1 秒级可查与阶段 2 断点续跑天然成立。
3. **页面职责分离与会话级多选挂载（`D9`、`D10`）**：左侧边栏「知识库」页专职 CRUD / 知识视图预览 / 事件流、不设问答框，消费统一收敛在对话输入区与 `@智能体`/专家团透传，符合产品心智且不触动智能体包签名 manifest 协议。

---

## 2. 三项关键架构争议点的源码仲裁实证

### 2.1 整理会话与 `session_projcache` 无界膨胀（`SK-2`、`CG-6` → `D13`）

- **源码核实**：
  - 已安装的 `@deepseek-ai/dsh-session-projection-cache@0.2.1-rc.1`（`lib/index.js:89-101`）采用 `layout: "per-record"`，在 `session/created`、`turn/end`、`session/disposed` 为每个唯一 `SessionId` 写独立记录且永不自删；Host 启动时 `DomainFacility.open()`（`deepseek-harness/packages/storage/storage-domain/src/index.ts:119`）调用 `unit.loadAll()` 全量载入内存。若每批铸造 `kb-org-<kbId>-<runId>`，20 库 × 2,000 文件仅首轮即产生 4,000 条永久缓存记录，持续逼近 128 MiB 隔离阈值。
  - `session-projection-cache/src/spec.ts:38-39` 明确规定 `SessionId` 是**可复用槽位（slot）**而非单次生命周期；`JsonlSessionPersistence.create()`（`session-persistence-jsonl/src/index.ts:369`）仅检查 `tracker.hasPending(id)` 与磁盘 `.jsonl`。一旦持有并 `await handle.dispose()`（`agent-loop/src/index.ts:579-586`）后用 `removeSessionFilesById` 删掉旧日志，同槽位 ID 即可开启零历史新回合。
  - `storageDomain.get('session_projcache').table('sessions').delete(key)` 是公开 API（`storage-domain/src/index.ts:182`、`domain.ts:315`），在 `dispose` 后入队于同一 FIFO 写链。
- **仲裁裁定（`D13`）**：每库固定使用**单一确定性可复用槽位 ID** `huaanwork-kb-org-<kbId>`（统一前缀 `KB_ORG_SESSION_PREFIX = 'huaanwork-kb-org-'`）；整理调用方直接调用 `ctx.agents.create()` 并持有 `AgentHandle`，批次结束后 `await handle.dispose()` + `removeSessionFilesById` 清理日志（开跑前同样清扫崩溃遗留日志）；删库时 fail-soft 删除该槽位的 `session_projcache` 记录。20 库下缓存永远 ≤ 20 条，**零修改 `deepseek-harness/`**。

### 2.2 知识库 HTTP 路由归属：表内 `/huaanwork/knowledge/*` vs 表外（`SK-5`、`CG-11` → `D15`）

- **源码核实**：`routes.ts:1817`（`...expertTeamRoutes`）与 `client-huaanwork/api.ts:46-160` 表明全部现代桌面域（`subagent.*`、`artifact.*`、`agent.package*`、`skill.*`、`expertTeam.*`）均采用**表内注册**（`/huaanwork/*`、`GET` query + `POST` JSON body、精确路径匹配），天然享有同源 loopback 防护、1 MiB body 上限、统一 `RouteError` 与双向契约校验；仅 `market/routes.ts` 因替代上游市场壳层走表外。现网仅 4 处测试硬编码 `92`（`routes.spec.ts`、`api.spec.ts`、`route-contract.spec.ts`、`market-routes.spec.ts`）。
- **仲裁裁定（`D15`）**：全部知识库 RPC 纳入**表内注册**，独立拆文件 `src/huaanwork-host/knowledge-routes.ts` 展开进 `ROUTE_TABLE` 并映射至 `client-huaanwork/api.ts`，同步更新 4 处路由契约测试（将 `market-routes.spec.ts:236` 改为断言 `registerMarketRoutes` 不改变 `ROUTE_TABLE.length`）。

### 2.3 `SK-16` 范围裁剪建议 vs 用户已锁定全量需求（`SK-16` → `D16`）

- **仲裁分析**：用户在 Understanding Lock 中已明确锁定旧版 `.doc/.xls/.ppt`、条件多模态扫描 PDF/图片、可选 Embedding 混合检索及知识视图预览，因此**拒绝**将上述能力砍到未排期的 v2；但 **接受** 将实施过程拆分为 2 个顺序工程里程碑（`M1` → `M2`），每阶段独立过 `corepack yarn check` 门禁，最终功能交付验收必须 **M1 + M2 全部完成**。

---

## 3. Skeptic / Challenger 视角发现与仲裁（`SK-1`–`SK-16`）

> 角色边界：假设设计在生产中必然失败，逐条反证代码冲突、边界漏洞与过度设计；不提新需求、不做架构重写。

### 3.1 Critical（7 项）

| 编号 | 问题摘要与已核实代码证据 | 生产失效模式 | 裁决与强制修法（方案 A+） |
| :--- | :--- | :--- | :--- |
| **SK-1** | **整理 Agent 无删文件工具，且 `str_replace_editor` 被策略拒绝**<br/>`tool-fs/src/index.ts:67-98` 与 `tool-str-replace-editor/src/index.ts:20-32` 均无删除能力；`decide.ts:102-103,167-183` 对 `str_replace_editor` 无条件校验 `old_str` 在已有文件中唯一出现；`limits.ts:107-129` 连续 3 次同类工具报错即中止会话。 | (1) 源文件删除后整理 Agent 无法删掉失效 `wiki/docs/<docId>.md`，留下僵尸卡片；(2) 调用 `str_replace_editor` 的 `view`/`create`/`insert` 全部被拒并触发 3 错强杀。 | **ACCEPT**：从整理工具白名单**移除 `str_replace_editor`**（仅留 `read`/`read_file`/`glob`/`grep`/`write`/`edit`）；由 `kb_org_mark_organized` 在宿主侧执行经过 `resolveInside` + 非符号链接常规文件校验的 `wiki/docs/<docId>.md` 墓碑删除（及可选 `wiki/topics/*.md` 清理）。 |
| **SK-2** | **`kb-org-*` 会话污染侧边栏「任务」、错误挂载 `result_present`、触发同步 git diff 与全量重扫**<br/>`sessions.ts:1480-1484,1104-1106`、`sessionChannel.ts:11-28,65-75`、`App.tsx:2308-2314,4455,5590`、`result-artifact-tools.ts:223-244`、`bridge.ts:177-191,386-430`、`turn-anchors.ts:35`、`session-sweep.ts:51-57`。 | 整理会话直接冒进侧边栏「任务」列表；被 `turnOriginForSession` 判为 `'advanced'` 而误挂 `result_present`；每次写 `wiki/` 触发同步 `spawnSync('git')` 并广播流式 WS 诱发 UI `refreshRecent()` 全量 zstd 扫描；占满 256 个 `turnAnchors` LRU 槽挤掉用户会话。 | **ACCEPT**：确立统一前缀 `KB_ORG_SESSION_PREFIX = 'huaanwork-kb-org-'`（并采用 `D13` 单库单槽），全链路接入 6 处隔离点：`sessionList`/`sessionChannel` 过滤、`turnOriginForSession` 返回 `'knowledge'`（永不挂 `result_present`）、`bridge.ts` 抑制 `emitGitDiff` 与对话 WS 广播、不写 `turnAnchors`、`session-sweep.ts` 保护前缀与 `neutralKnowledgeBaseDir`。 |
| **SK-3** | **深度 2 孙代 `tools.restrict` 永久遮蔽竞态、`agent-attachments` 泄漏与 legacy `@agent` 断链**<br/>`skills.ts:944-982`、`tools/src/index.ts:1206-1209`、`present-as.ts:153,215-218`、`agent-attachments.ts:21`、`agent-package/host.ts:839-851,1103-1110,1380-1392,1610-1616`。 | 深度 2 孙代创建时 `present-as` 先于挂载隐藏 `KB_QUERY_TOOLS`，`skills.ts:976` 立即快照缺失列表并安装不可撤销 `restrict` 交集，导致孙代永久用不了 `kb_*`；`releaseChildBindings()` 漏摘 `KB_QUERY_TOOLS` 持续泄漏 Map 条目；legacy `@agent` 与系统技能旁路 `dispatch()` 静默失效。 | **ACCEPT**：在 `skills.ts` 血缘分支中先执行 `attachAgentTools` + `refreshAgentRestrict` 再快照 `tools.schemas()` 与安装 `restrict`；同步更新 `dispatch()` 与 `dispatchTeamMember()` 两端的 `agentPackageChildAttachmentNames` 与 `releaseChildBindings()`；对 legacy `@agent` 与父会话派生的普通子代理对称实现继承与 `session/disposed` 清理。 |
| **SK-4** | **系统提示词注入未接线、`{{...}}` 模板插值崩溃、动态 `docCount` 毁坏 KV-cache 且对子代理不可见**<br/>`huaanwork-host/index.ts:66` 未 inject `systemPrompt`；`system-prompt/src/index.ts:290-295,330-377` 默认开启 `interpolate`；`thinking-prompt.ts:1-16` 仅为静态全局串。 | 用户库名含 `{{季度}}` 直接在每轮抛未捕获异常毁掉会话；把动态文档数放进系统提示导致每次后台入库都清空 LLM 前缀 KV-cache；若退化为用户消息包装则 `@智能体`/专家团子会话完全看不到已挂载库信息。 | **ACCEPT（`D14`）**：新增独立护栏插件 `huaanwork-guardrails/knowledge-prompt.ts`（`inject = ['systemPrompt']`，接线至 `profile.ts`/`tsdown.config.ts`/`package.json`），使用 `ctx.systemPrompt.context({ required: true, interpolate: false, text })` 沿 `context.agent` + `parentSessionOf` 动态解析，**不注入易变 `docCount`**（动态计数改由 `kb_list_docs` 查）；整理会话提示词在 `agents.create({ setup })` 中以 `interpolate: false` 注册。 |
| **SK-5** | **§9.3 REST 路由契约与 `routes.ts`/`api.ts` 100% 不兼容；级联删会话漏清挂载表**<br/>`routes.ts:1911-1951`（前缀 `/huaanwork`、无 `:id` 参数、仅 `POST`/`PUT` 读 body）、`api.ts:19-32`、`routes.ts:1338-1372,1660-1686`（`project.remove`/`task.remove` 绕过 `sessionRemove`）。 | 13 条路由全线 404 或丢 body；删除项目/任务/清扫会话时 `session-knowledge.json` 持续残留孤立条目。 | **ACCEPT（`D15`）**：全部路由改为表内 `/huaanwork/knowledge/*`（`GET` 走 query、`POST` 走 body，零 `:id`/`PATCH`/`DELETE`）；会话挂载清理挂钩 `releaseSessionRuntime` 及 `project.remove`/`task.remove`/`automation.remove`/`pruneSessions` 全部级联路径。 |
| **SK-6** | **Host 主线程同步 `DatabaseSync` 向量扫描与大事务击穿 2 秒活性探针；换模型迁移期召回失真**<br/>`bridge.ts:410-413`（2s 活性探针红线）；`node:sqlite` 全同步 API；v1 `chunk_embeddings` 单主键 `chunk_id`。 | 多库挂载下同步读数百 MB BLOB + 浮点计算在主线程直接卡死 Host 触发看门狗告警；切换 Embedding 模型期间只对已重算的极少切片跑向量融合，将不相关文档排到前面。 | **ACCEPT**：拆出独立 **Storage/Query Worker** 独占全部 `node:sqlite` 同步读写与流式游标 Top-30 堆点积计算（与提取 Worker 池解耦，防解析崩溃牵连 DB 句柄）；`chunk_embeddings` 主键改为 `(chunk_id, model_key)`，**仅当当前 `model_key` 覆盖率 ≥ 95% 时启用 RRF**，迁移补算期干净降级为纯 FTS5（`searchMode: 'fts-backfilling'`）。 |
| **SK-7** | **整理 Agent 无限重试烧 Token 死循环、空文件误提交与批次中途 TOCTOU 竞争**<br/>§8.1–8.2 缺少单文档重试上限/退避，且 `kb_org_mark_organized` 未校验非空内容与 `sha256` 原子匹配。 | 单份异常文档或模型漏调提交工具即刻触发无限重跑，耗尽 Token 并永久锁死全局上限 1 的整理槽位；模型写 0 字节文件仍推进 `organized_sha256`；整理期间文件更新或删除产生孤立笔记。 | **ACCEPT**：`documents` 新增 `organize_attempts`、`organize_retry_after`、`last_organize_error`（指数退避、单 `(doc_id, sha256)` 最多 3 次即隔离为 `organize-failed` 直至文件变动或手动重试）；`kb_org_mark_organized` 校验目标为 `wiki/` 内非空常规非符号链接文件（≤ 256 KB），并执行原子条件更新 `WHERE doc_id = ? AND sha256 = ?`。 |

### 3.2 Important（9 项）

| 编号 | 问题摘要与证据 | 裁决与强制修法（方案 A+） |
| :--- | :--- | :--- |
| **SK-8** | **`TurnScheduler` 占槽饿死前台用户（`max_concurrent_turns=1`）、抢跑异步自动化与污染 `soleCapWriterSessionId()`**（`turn-scheduler.ts:97,124,259-272`、`sessions.ts:1216-1232`） | **ACCEPT**：`soleCapWriterSessionId()` 排除 `kb-organize`；当 `admitUserTurn` 遇满额且存在活跃 `kb-organize` 时**立即取消/抢占**可续跑的整理批次让路前台对话；`kb-organize` 唤醒严格排在 `drainQueue()` 与异步 `evaluateDueAutomations()` 结算之后。 |
| **SK-9** | **`agent/inbox/claimed` 缺 `isTurnBoundaryMessage` 门控与 fail-closed `agent.cancel`**（`expert-team-dispatch.ts:207-241`） | **ACCEPT**：`KB_QUERY_TOOLS` 挂载监听强制守卫 `isTurnBoundaryMessage(message)`，按回合边界冻结本轮 `kbIds`（回合中改选下一轮生效），异常时 fail-closed 调用 `agent.cancel`。 |
| **SK-10** | **FTS5 CJK bigram 在单字查询（`C类`/`税`）失明、未转义 `-`/`:`/`OR` 必抛语法错、中文文件名/标题未切词、缺邻近度重排** | **ACCEPT**：`rel_path`、`heading_path`、`content` 均写入预处理 FTS 列；单字连续汉字同时发射 unigram、≥ 2 字发射 bigram；查询端逐词加双引号转义并剔除 FTS 运算符；对 Top-60 候选加短语/邻近度加分。 |
| **SK-11** | **`sha256` 重命名在重复副本间误匹配；`norm_path UNIQUE` 在仅改大小写重命名及区分大小写 APFS 上崩库** | **ACCEPT**：仅在单次对账中 `vanishedCount === 1 && addedCount === 1` 的唯一 1 对 1 哈希命中时复用重命名；移除 `norm_path` 的 `UNIQUE`（保留普通索引）；通过零写入的只读大小写探针按库检测源卷大小写敏感性。 |
| **SK-12** | **Windows `fs.watch(recursive)` 锁目录致「Folder In Use」、OneDrive/SMB 丢事件或触发云文件批量回水、Host→Worker 符号链接 TOCTOU 与目录联结死循环** | **ACCEPT**：为所有 `FSWatcher` 挂 `'error'` 处理；提供单库「暂停监听 / 仅手动与周期同步」开关随时释放 Windows 句柄；对云占位文件做属性探测防批量回水；在提取 Worker 内对已打开 fd 执行 `lstat`/`realpath`/`fstat` + `(dev, ino)` 环路检测。 |
| **SK-13** | **纯 JS 旧版 OLE2（FastSave 删文复活/乱码/许可证）、未打包 `pdfjs-dist` CMaps 致中文乱码诱发视觉风暴、`renderPdfPages` 超时与安全缺口** | **ACCEPT**：M2 锁定经 SPDX 审计的纯 JS OLE2 解析器并用 FastSave/UTF-16LE/加密用例兜底（不支持流 fail-closed）；显式打包 `pdfjs-dist` `cmaps/` + `standard_fonts/` 并在打包冒烟中用真实中文 CID PDF 验证；离屏渲染按 `CG-2` 全量加固。 |
| **SK-14** | **Vision/Embedding 直连 `fetch` 绕过 `net-gate.ts`、`isLanEndpoint` 拒内网域名（`network.ts:53-88`）、重定向 SSRF、整理模型绑定缺失** | **ACCEPT**：统一经 `knowledgeHttpFetch` 强制校验 `allow_network`（`isLanEndpoint`）、`http:`/`https:`、`redirect: 'manual'`、超时与 `readCappedBytes`；在设置 UI 如实告知内网 IP / `*.local` 规则；整理会话显式写 `huaanworkSessionModels` 并在准入前走 `resolveSessionModel` 预检。 |
| **SK-15** | **`huaanworkSessionToolAllow` 与 `huaanworkPackageChildAllow` 优先级未定义，且 `present-as.ts:156` 空交集 fail-OPEN** | **ACCEPT**：修复 `present-as.ts:156`——存在显式白名单且交集为空时必须调用 `tools.restrict({ allow: [] })`（绝不提前 return 放开全工具）；在 `present-as.ts` 与 `policy.ts` 统一按集合交集裁决优先级。 |
| **SK-16** | **一期单波次塞入 5 大高风险子系统存在交付膨胀风险** | **PARTIAL ACCEPT（`D16`）**：拒绝删减用户已锁定需求；接受在实施阶段拆为 `M1（核心闭环）→ M2（旧 Office + 视觉 + Embedding 混合检索）` 两里程碑串行落地，均通过 `corepack yarn check` 后统一验收发布。 |

---

## 4. Constraint Guardian 视角发现与仲裁（`CG-1`–`CG-12`）

> 角色边界：强制审查安全隐私、打包与许可证门禁、资源上限、崩溃恢复、Host 生命周期与仓库铁律；不讨论产品目标。

### 4.1 Critical（6 项）

| 编号 | 约束类别与核实证据 | 约束违背 | 裁决与强制修法（方案 A+） |
| :--- | :--- | :--- | :--- |
| **CG-1** | **Security** — `sandbox.zh.md:5`、`fs-sandbox/src/index.ts:1-24,134-138`、`sandbox-cwd.ts:71-133` | 进程级 OS 沙箱（Seatbelt/Windows ACL）**仅包裹 `bash`/`pwsh` 子进程**；禁 shell 后整理工具全走 Node 进程内 `fs-sandbox`（源码自述非内核边界且允许 OS temp 写入），且 `sandbox-cwd.ts` 缺键时静默回落全局根。v1 宣称「OS 沙箱 + 策略双层阻断」失实。 | **ACCEPT**：撤回对进程内 fs 工具的 OS 沙箱宣称，如实定位并加固真实防线：`sandbox-cwd.ts` 对 `KB_ORG_SESSION_PREFIX` 缺根一律 **fail-closed 拒绝**（绝不回落全局根）；在 `create` 前设根、`dispose` 后清根；为整理会话显式禁止 OS 临时目录写入与 `wiki/` 符号链接目标；单测覆盖上游全部 fs 工具路径参数名。 |
| **CG-2** | **Security** — `artifact-window.ts:40-86`、`electron-runtime.ts:355,834-899,980`、`host-process.ts:222` | `knowledgeNative.renderPdfPages` 处理不可信本地 PDF 却无 Chromium 沙箱、断网、IPC 载荷与退场清理契约，存在 SSRF、PDF JS 逃逸、RPC 拥塞与窗口泄漏风险。 | **ACCEPT**：对齐 `artifact-window.ts` 实施强制加固：`show: false, offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, plugins: false`，禁业务 `preload.ts`，独立非持久 `partition` 挂**无条件零出网 `webRequest.onBeforeRequest` 全拒拦截**（即使 `allow_network=true`），禁导航/重定向/弹窗/权限请求；单次 RPC 限 1–3 页、≤ 30s 超时、限长边 1568px；在 `adoptHostShell()` 与 `prepareToQuit()` 显式销毁窗口与缓存。 |
| **CG-3** | **Packaging/Build** — `package.json:457`、`tsdown.config.ts:5-79`、`mac-universal.ts:58-65,90-97`、`verify-licenses.mjs:56-59` | `sharp@0.35.5` 仅在 `devDependencies`（生产中属传递依赖）、在 `mac-universal.ts` 硬编码精确文件名与 `libvips` dylib、受 LGPL-3.0 声明约束，且在会被 `terminate()` 的 `worker_threads` 中加载 `libvips` 有原生线程池崩溃风险。 | **ACCEPT**：知识库运行时**彻底不直接引入 `sharp`**；图片与扫描页缩放统一在 `knowledgeNative` 中使用 Electron 内置 `nativeImage` / 离屏 Canvas 完成，零原生插件新增与打包耦合。 |
| **CG-4** | **Packaging/Build** — **活体探针实证** + `asar-archive-policy.ts:31-35`、`tsdown.config.ts:21`、`verify-licenses.mjs:30-59`、`verify-packaged-runtime.ts:89-105` | **活体探针发现**：Host 主线程的 `process.noAsar = true` **不继承给 `worker_threads`**，导致扫描用户目录内任意损坏 `.asar` 文件在 Worker 内直接抛 `Invalid package` 崩溃；且缺失 `tsdown` Worker 入口声明与新解析器 SPDX 许可证门禁审计（`ALLOWED_LICENSES` + `THIRD_PARTY_NOTICES.md` + `1,500 files / 128 MiB` 打包上限）。 | **ACCEPT**：所有知识库 Worker 入口第 1 行必须调用 `disableAsarArchiveView(import.meta.url)` 并补损坏 `.asar` 回归单测；在 `tsdown.config.ts` 显式声明 Storage Worker 与 Extraction Worker 入口；在 `packaged-runtime-smoke.ts` 与 `verify-packaged-runtime.ts` 验证 Worker、`node:sqlite`+`FTS5` 与 `pdfjs-dist` CMaps；全部新增解析依赖在实施前过 `verify:licenses`、`verify:notices` 与零原生二进制核查。 |
| **CG-5** | **Reliability/Lifecycle** — `host-process.ts:270-279,349-354`、`startup-generation.ts:6,70-86`、`huaanwork-host/index.ts:135-148,448-513` | Electron 监管进程在退出与 Host 换代时仅给 `host.fiber.dispose()` **硬上限 3,000 ms** 随即 `child.kill()`；且 Cordis `ctx.effect` 须同步返回 disposer 函数、不能放进会重跑的 `tools` effect 内。串行等 60s 解析或 20 库 `TRUNCATE` 会撞死 3 秒崖壁引发 Windows 文件锁。 | **ACCEPT**：在顶层独立 `ctx.effect` 中同步返回收尾函数，实施 **≤ 1,000 ms 并行退出预算**：同步置 `disposing=true` 并 `.close()` 全部 Watcher → 并行发起整理回合取消、Extraction Worker `terminate()` 与 Storage Worker 关闭 SQLite（900 ms 硬超时兜底终止；正常期定期轻量 checkpoint，退出仅 `db.close()`）；补 `< 1,000 ms` 卡死 Worker 退场计时单测。 |
| **CG-6** | **Performance/Scale** — `diagnostic-export.ts:120`、`session-projcache-recovery.ts:10-11`、`adm-zip@0.6.0` | 标称 20 库 × 2,000 文件 × 50 MB 下存在 5 处无界资源炸弹：多库 Float32 向量堆内存 2.4–4.8 GB OOM、Extraction Worker 无 `resourceLimits`、`adm-zip` 压缩炸弹（1 MB 膨胀 > 2 GB）、4,000 次整理会话撑爆 `session_projcache`（128 MiB）、WAL/切片/`wiki/`/`events.jsonl` 无体积上限。 | **ACCEPT**：设全套硬上限——Extraction Worker `resourceLimits: { maxOldGenerationSizeMb: 256 }`；ZIP 解压总量 ≤ 50 MB / 单条目 ≤ 20 MB / 条目数 ≤ 2,000；单文档文本 ≤ 10 MB；单文档 ≤ 500 切片、单库 ≤ 50,000 切片、向量维度 ≤ 4,096 且全走 Storage Worker 流式游标扫描（零跨库常驻内存缓存）；`PRAGMA journal_size_limit = 33554432`（32 MiB）+ `wal_autocheckpoint = 1000`；单库单整理槽（`D13`）；`wiki/` 单文件 ≤ 256 KB / 单库 ≤ 50 MB；`events.jsonl` ≤ 500 行 / ≤ 512 KB（单条 `summary` ≤ 512 B、`detail` ≤ 4 KB）。 |

### 4.2 Important & Minor（6 项）

| 编号 | 类别与关键证据 | 裁决与强制修法（方案 A+） |
| :--- | :--- | :--- |
| **CG-7** | **Security**（Important）— `host-runtime-bridge.ts:270-316`、`loopback.ts:66-80`、`workspace-admission.ts:52-64` | **ACCEPT**：`knowledge.reveal` 仅接受 `(kbId, docId \| relPath?)`，校验 `realpath` 位于已注册 `sourceDir` 内，经 `isSameOriginLoopbackRequest` 保护且**仅调用 `shell.showItemInFolder`**（严禁 `shell.openPath`）；在建库/重绑/定位全链路拒绝 Windows UNC（`\\...`）与设备路径防 NTLM 凭据泄漏；明确只读 `sourceDir` 不需要 Windows 写沙箱 ACL 授权。 |
| **CG-8** | **Security**（Important）— `settings.ts:340-355`、`mask-secrets.ts:43`、`catalog-transport.ts:51,160-161` | **ACCEPT**：将 `writeHuaanworkSettings`、`knowledge-bases.json`、`session-knowledge.json` 全部升级为 `writeFileAtomic` + POSIX `0o600`；`events.jsonl` 与连通性测试输出一律经 `maskSecrets()` 脱敏且禁止回显上游原始 HTTP 错误正文；Vision/Embedding/测试客户端统一走 `knowledgeHttpFetch`（`redirect: 'manual'` + `readCappedBytes` + 超时）。 |
| **CG-9** | **Reliability/Lifecycle**（Important）— `desktop-factory-reset.ts:85-92`、`profile-checkpoint.ts:57-61`、`diagnostic-export-worker.ts`、`sessions.ts:918-960` | **ACCEPT**：在单测中断言 `workspace-knowledge/`、`knowledge-bases.json`、`session-knowledge.json` 被 `profile-checkpoint.ts` 与 `diagnostic-export-worker.ts` 严格排除（防隐私泄漏与备份膨胀）；Profile 删除/重置在 `CG-5` Host 停止后执行保证 Windows 无 `EBUSY` 锁；会话清理统一挂钩 `releaseSessionRuntime`。 |
| **CG-10** | **Performance/Scale**（Important）— `host-process.ts:174-184`、`keepAwake.ts:13-19`、`electron-runtime.ts:786-796` | **ACCEPT**：全部目录遍历与对账走异步 `fs/promises` 且跨库错峰调度（杜绝 40,000 文件同步 `statSync` 阻塞 Host）；不为知识库持有 `prevent-display-sleep`（保电池）；引入 Electron `powerMonitor` `'resume'` / 单调时钟跳变检测，休眠唤醒后重建 `FSWatcher`、补跑对账并豁免整理看门狗的休眠时钟跳变误判。 |
| **CG-11** | **Maintainability**（Important）— `market-routes.spec.ts:234`、`api.spec.ts:173`、`route-contract.spec.ts:447`、`holders.ts:28-128`、`gates.ts:139-240`、`AGENTS.md` | **ACCEPT**：表内路由同步更新 4 处契约测试（`D15`）；所有共享护栏对新增 `ctx.huaanwork*` holder 一律做可选链缺省降级以兼容最小化测试/验收桩；严格保持 `dispatch()` 与 `dispatchTeamMember()` 双路径镜像与未挂载零改动；`packages/huaanwork-policy/` 保持纯逻辑零三方依赖；不新开监听端口满足 `gates.ts`。 |
| **CG-12** | **Security**（Minor）— `ArtifactMarkdownView.tsx:40-74` | **ACCEPT**：扩展 Wiki Markdown 渲染器屏蔽 `https?:`、`//`、`file:`、`data:`、`javascript:` 等全部外部与危险图片/链接协议；`knowledge.wikiFile` 响应硬限 256 KB。 |

---

## 5. User Advocate 视角发现与仲裁（`UA-1`–`UA-13`）

> 角色边界：代表华安基金 macOS/Windows 办公业务用户，聚焦心智负担、交互连贯性、异常可理解性与预期落差；严守已锁定边界（知识库页不设问答框），不新增范围外功能。

### 5.1 Critical（5 项）

| 编号 | 体验维度与现网锚点 | 用户核心痛点 | 裁决与强制修法（方案 A+） |
| :--- | :--- | :--- | :--- |
| **UA-1** | **Intent-Experience Mismatch**<br/>`App.tsx:6113-6133`（助手气泡纯文本）、`App.tsx:5091-5153`（三栏 `right-pane`） | 行内文本 `[文件名 · 第 3 页]` 在现网纯文本气泡里不可点、同名文件会错指、`@智能体`/专家团子调用不可见、重开历史会话丢失；新开浮层抽屉与现网右侧 `right-pane` 冲突。 | **ACCEPT**：基于真实 `kb_search`/`kb_read_chunk`/`kb_read_wiki` 结构化工具返回（含子会话汇总，随会话持久化/可重建，按 `kbName / relPath` 消歧），在助手回复下方渲染稳定可点击的**「引用来源 (N)」芯片条**；点击后统一复用现网 **`right-pane`（「预览」页签）** 展示切片正文、上下文扩展与定位按钮。 |
| **UA-2** | **Cognitive Load**<br/>`KnowledgeBaseView.tsx:10-51` | 单一状态徽标「已暂停」混淆了「停止监听索引」与「暂停 AI 整理」；100+ 文件首次同步秒级可查但用户误以为要等 15 分钟整理完才敢提问；缺少区分「同步文件」「整理待处理」「全量重建」的操作入口。 | **ACCEPT**：拆分为正交两层状态——**索引监听态**（`监控中` / `同步中 X/Y` / `监听已暂停` / `源目录不可用`）与 **AI 整理态**（`自动整理 开/关`、`整理中 第 2/12 批`、`待整理 N`、`失败 M`）；操作条明确区分**「同步文件」**、**「整理待处理 (N)」**与二级菜单**「重建索引」**（带耗时与模型消耗二次确认）。 |
| **UA-3** | **Usability / Flow**<br/>`ArtifactMarkdownView.tsx:40-89`、`ui-primitives/src/markdown/parse.ts:40-45`、`render.tsx:53-68,542-587` | 知识视图树暴露 `<docId>.md` UUID 文件名；`ArtifactMarkdownView` 不支持 YAML frontmatter（会渲染成超大 Setext H2 且暴露 `sha256`）且未接 `MarkdownDelegateProvider.openFile`（导致 `INDEX.md`→`docs/` 内部链接全断）；阶段 2 未完成时展示空白页易被误认为失败。 | **ACCEPT**：`knowledge.wikiTree` 联合 `documents` 返回人类可读 `displayName` + `relPath`；封装 `WikiMarkdownView` 在渲染前剥离 YAML frontmatter 为简洁顶部元信息栏并接入 `MarkdownDelegateProvider.openFile` 支持原地跳转高亮；`wiki/` 尚空时显示友好空态（「文件已索引可对话检索，可点击立即整理生成知识视图」）。 |
| **UA-4** | **Intent-Experience Mismatch**<br/>`App.tsx:630-632,2540-2551,3385-3417,3481-3495,3661-3710` | 新建任务与切项目时标签尚无 `sessionId`，按 v1 直调 `PUT /api/sessions/:id/knowledge` 会报错或被 `applyOpenedProject` 清空；新建默认态、回合中改选与删库后旧引用行为未定义。 | **ACCEPT**：对齐现网 `modelPickByTab` 新增标签级暂存 `kbPickByTab`（空标签切项目保留已选，首条消息铸造 `sessionId` 后同步绑定）；明确规则：新建任务默认不自动勾选旧库、历史任务重开自动回填、回合运行中改选提示「下一轮消息生效」、中途取消挂载不影响本会话既有消息的只读引用查看。 |
| **UA-5** | **Intent-Experience Mismatch**<br/>`Settings.tsx:531-645` | 设置页漏掉了 `knowledge_vision_model_id` 下拉选择（平时用纯文本模型聊天时勾了另一模型的视觉开关仍无法生效）；且开启视觉或调高 50 页上限后，因 `mtime+size` 未变点「立即同步」不会重提此前跳过的扫描件。 | **ACCEPT**：在设置页「知识库增强」显式提供「扫描件/图片视觉解析模型」下拉框（实时展示生效状态）；在 `documents` 存储 `extract_config_hash`，视觉开关或页数上限变更时在知识库顶部浮现一键**「补全解析此前跳过/截断的扫描件（N 份）」**入口。 |

### 5.2 Important & Minor（8 项）

| 编号 | 关注点 | 裁决与强制修法（方案 A+） |
| :--- | :--- | :--- |
| **UA-6** | 扫描件跳过、50 页截断、`stale` / `sourceUnavailable` / `fts-fallback` 静默漏检风险（Important） | **ACCEPT**：知识库详情顶部增加跳过/截断/错误汇总告警横幅（附精确页码覆盖如 `已解析前 50/182 页` 与快捷跳转）；对话引用条直接由结构化返回字段驱动 UI 标识（不单依赖 LLM 口头转述）。 |
| **UA-7** | 未配模型、`仅局域网` 拦截与礼让排队导致阶段 2 看似卡死且无进度（Important） | **ACCEPT**：在 `knowledge.list`/`knowledge/changed` 暴露显式阶段状态（`waiting-turn-slot`、`organizing (X/N)`、`blocked-no-model`、`blocked-network`、`quarantined-errors`）与设置跳转；建库开启自动整理旁注明后台模型调用说明。 |
| **UA-8** | 缺 `source-unavailable` UI 重绑按钮、报错含技术黑话、Windows 占用无指引（Important） | **ACCEPT**：失效状态顶部提供醒目**「重新选择文件夹」**按钮；全部路径校验与锁错误翻译为人话中文；建库弹窗支持原地重选目录；补充 Windows 移动/卸载源文件夹时使用「暂停监听」释放占用的清晰引导。 |
| **UA-9** | 500 条事件被批量 `file_indexed` / 超限逐条刷爆且无筛选（Important） | **ACCEPT**：> 5 份文件的批量同步折叠为批次汇总 `sync_completed` 与单条超限汇总告警（单文件明细留「文档与索引」），仅小增量与有上限的告警/错误逐条记录；事件页增加筛选胶囊（`全部 / 告警与错误 / AI 整理 / 文件同步`）。 |
| **UA-10** | `composer-bar` 320px 溢出、0 库引导、`@智能体`/专家团共享透明度、`toolPanel.ts` 工具中文名（Important） | **ACCEPT**：`composer-bar` 支持紧凑响应式排布；0 库时弹层引导「前往创建知识库」；弹层与 `@team` 上下文条轻提示只读透传语义；在 `toolPanel.ts` 为 4 个 `kb_*` 工具补充人话中文标签。 |
| **UA-11** | 1280px 四栏挤压、缺文档名搜索、缺格式上限与「去对话中提问」引导（Important） | **ACCEPT**：知识视图内侧文件树支持折叠适应 1280px 窗口；「文档与索引」增加文件名/路径搜索框；建库弹窗写明支持格式与 50 MB / 2,000 份 / 暂不支持音视频说明；首建空态给出「前往对话勾选提问」轻引导。 |
| **UA-12** | OS 本地化目录文案与删库确认框细节（Minor） | **ACCEPT**：按平台显示「在访达中显示」（macOS）/「在资源管理器中显示」（Windows）；删库 `.confirm-modal` 展示源路径、会话解绑保留聊天记录说明及 `删除中…` 禁用态。 |
| **UA-13** | 设置页中文主标签与 `仅局域网` 跨页签冲突提示（Minor） | **ACCEPT**：Embedding 表单采用中文主标签加括号技术名与收益说明；输入或测试非局域网端点且处于 `仅局域网` 时原地提示并提供「前往权限设置」快捷跳转。 |

---

## 6. 修订后推荐架构（方案 A+）核心升级总览

相较于 v1，**方案 A+** 保持宏观拓扑与用户锁定范围不变，重点完成 7 项结构性加固：

1. **双 Worker 分治隔离（`D1`、`D5`、`CG-4`、`CG-6`）**：拆分为 **Storage/Query Worker**（独占全部 `node:sqlite` 同步 I/O、FTS5 与流式游标向量扫描，零阻塞 Host 2 秒活性探针）与 **Extraction Worker Pool**（1–2 并发、256 MB 堆上限、首行 `disableAsarArchiveView(import.meta.url)`、ZIP/文本防炸弹、内置 `lstat`/`realpath`/`(dev,ino)` 校验）。
2. **诚实且闭环的只读边界（`D2`、`D7`、`CG-1`、`SK-1`、`SK-15`）**：撤回对进程内 fs 工具的 OS 沙箱误称；`sandbox-cwd.ts` 对 `KB_ORG_SESSION_PREFIX` 强制 fail-closed + 禁 temp/符号链接写；修复 `present-as.ts:156` 空交集 fail-open 漏洞；移除 `str_replace_editor`，由 `kb_org_mark_organized` 执行受控墓碑删除与原子 `sha256` 校验。
3. **单槽位零膨胀整理会话与抢占式调度（`D8`、`D13`、`SK-2`、`SK-7`、`SK-8`）**：每库固定槽位 `huaanwork-kb-org-<kbId>`（6 点全隔离 + `AgentHandle.dispose()` + 日志清理 + 删库清 `session_projcache`，永不超 20 条）；单 `(doc_id, sha256)` 3 次重试指数退避隔离；用户对话满额时立即抢占取消可续跑整理批次。
4. **安全提示词与完整血缘继承（`D9`、`D14`、`SK-3`、`SK-4`、`SK-9`）**：独立 `knowledge-prompt.ts` 插件以 `interpolate: false` 注入稳定上下文（不含易变 `docCount`）；`agent/inbox/claimed` 守卫 `isTurnBoundaryMessage` 并 fail-closed；先挂附件再 `restrict` 打通深度 2 孙代及 `dispatch`/`dispatchTeamMember`/legacy `@agent` 全链路。
5. **无 `sharp`、零出网离屏视觉与严密出网治理（`D4`、`CG-2`、`CG-3`、`CG-7`、`CG-8`）**：图片缩放改用 Electron `nativeImage`/Canvas；`knowledgeNative.renderPdfPages` 按 `artifact-window` 沙箱与无条件全拒 `webRequest` 加固并在 `adoptHostShell`/`prepareToQuit` 回收；`knowledge.reveal` 仅用 `shell.showItemInFolder` 且拒 UNC 路径；配置与注册表全走 `writeFileAtomic + 0o600`、`events.jsonl` 经 `maskSecrets()` 脱敏、Host 退场严守 `≤ 1,000 ms` 并行预算。
6. **表内契约对齐与中文检索/混合覆盖门禁（`D5`、`D15`、`SK-5`、`SK-6`、`SK-10`）**：全部路由采用表内 `/huaanwork/knowledge/*`（`GET`/`POST`）更新 4 处契约测试；FTS5 全面安全转义并覆盖单字/双字中文与路径/标题；Embedding 向量表主键 `(chunk_id, model_key)` 且需 **≥ 95% 覆盖率**才开启 RRF 融合。
7. **全套业务体验收口与双里程碑交付（`D10`、`D16`、`UA-1`–`UA-13`）**：结构化工具溯源芯片落地现有右侧 `right-pane`「预览」；拆分索引态与整理态；人类可读 Wiki 树 + 剥离 frontmatter 的 `WikiMarkdownView` 内链跳转；标签级 `kbPickByTab` 暂存；补齐视觉模型选择与配置变更一键重提；实现期按 **M1（核心闭环）→ M2（旧 Office + 视觉 + Embedding 混合检索）** 串行推进。

---

## 7. 最终仲裁 Decision Log（`D1`–`D16`）

| 编号 | 最终决策内容 | 备选方案 | 涉及评审异议 | 仲裁状态与理由 |
| :--- | :--- | :--- | :--- | :--- |
| **D1** | Host 内嵌 `knowledge/` 域 + 每库 `<profileDir>/workspace-knowledge/<kbId>/` + 拆分 **Storage/Query Worker**（独占 SQLite）与 **Extraction Worker 池**（256 MB 堆上限、首行 `disableAsarArchiveView`）；排除出 checkpoint 与诊断包。 | 独立 Sidecar / 复用自动化 / Host 主线程跑 SQLite | `SK-6`, `CG-4`, `CG-6`, `CG-9` | **APPROVED (v2)**：零新增守护进程同时杜绝 2s 探针阻塞、`.asar` 崩溃与 DB 句柄连带损坏。 |
| **D2** | 诚实纵深只读防线：Extraction Worker 内基于已开 fd 做 `lstat`/`realpath`/`(dev,ino)`；整理会话 fail-closed `sandbox-cwd`/`policy` 钉死 `wiki/` + 禁 temp/符号链接写；禁 shell/网络/MCP 且修复 `present-as.ts:156` 空交集 fail-open，按集合交集统一优先级。 | 误称 OS 沙箱保护进程内 fs 工具 / 靠提示词约束只读 | `CG-1`, `SK-12`, `SK-15` | **APPROVED (v2)**：消除虚假安全假设，补齐真实进程内防线的全部漏洞。 |
| **D3** | `fs.watch({ recursive: true })`（挂 `'error'` + 可选单库暂停监听/轮询回退）+ 3s 写稳防抖 + 错峰异步对账 + 休眠唤醒重建（不持 `keep_awake`）+ 严格 1 对 1 `sha256` 重命名 + 非唯一 `norm_path` 配只读大小写探针 + 云占位防护。 | 纯 watch 无退路 / 同步遍历 / 强加 `norm_path UNIQUE` | `SK-11`, `SK-12`, `CG-10` | **APPROVED (v2)**：规避 Windows 锁目录、重名碰撞、区分大小写 APFS 崩溃与电池损耗。 |
| **D4** | Extraction Worker 纯 JS 解析（ZIP ≤ 50 MB / 2,000 项、文本 ≤ 10 MB；打包 `pdfjs-dist` CMaps；M2 经 SPDX 审计的 OLE2）；**移除 `sharp`** 改用 Electron `nativeImage`/Canvas 与全加固零出网 `knowledgeNative.renderPdfPages`（1–3 页/次，换代/退出销毁）；共享 `knowledgeHttpFetch`。 | 直接引 `sharp` / 依赖本机 Python / 无沙箱离屏渲染 | `SK-13`, `SK-14`, `CG-2`, `CG-3`, `CG-4` | **APPROVED (v2)**：彻底摆脱 `sharp` LGPL/打包耦合与 Chromium SSRF 风险。 |
| **D5** | Storage Worker 独占 `node:sqlite`（WAL 32 MiB 上限）+ 全转义 FTS5（覆盖 `rel_path`/`heading_path`/`content`，单字 unigram + 多字 bigram + 邻近度重排）+ 流式游标 Float32 Top-30 堆 + `(chunk_id, model_key)` 主键与 **≥ 95% 覆盖门禁** + 切片/维度硬上限。 | 主线程同步扫描 / 单 `chunk_id` 主键 / 外部向量库 | `SK-6`, `SK-10`, `CG-6` | **APPROVED (v2)**：消除主线程冻结、OOM、FTS 语法崩溃、中文单字漏召回与换模型偏置。 |
| **D6** | `documents` 拆分 `sha256` 与 `organized_sha256`，新增 `extract_config_hash`、`organize_attempts`（≤ 3 次指数退避隔离）、`organize_retry_after`、`last_organize_error`、原子 `WHERE doc_id = ? AND sha256 = ?` 提交守卫与删除墓碑表。 | 无重试上限 / 仅凭 `mtime+size` 判增量 | `SK-7`, `UA-5` | **APPROVED (v2)**：杜绝无限烧 Token 死循环、TOCTOU 损坏与开启视觉后不重提旧扫描件。 |
| **D7** | 整理工具白名单 = `read`/`read_file`/`glob`/`grep`/`write`/`edit`（**移除 `str_replace_editor`**）+ 3 个限定单库工具，由 `kb_org_mark_organized` 执行受控墓碑文件删除与非空 ≤ 256 KB 校验。 | 保留 `str_replace_editor` / 靠不存在的删除工具 | `SK-1`, `SK-7`, `CG-6` | **APPROVED (v2)**：彻底打通删除墓碑清理并消除策略 3 错强杀。 |
| **D8** | `TurnScheduler` 低优先级 `kb-organize`（全局 1、单库串行、10 文档/批），排除出 `soleCapWriterSessionId()`，**满额遇前台用户回合立即抢占取消**，唤醒严格晚于 `drainQueue()` 与 `evaluateDueAutomations()`；显式绑定并预检整理模型。 | 占槽不让路 / 未定义模型绑定 | `SK-8`, `SK-14`, `UA-7` | **APPROVED (v2)**：在 `max_concurrent_turns=1` 下亦确保前台对话零等待。 |
| **D9** | 会话级多选（`kbPickByTab` + 原子 `0o600` `session-knowledge.json`），`isTurnBoundaryMessage` 门控 + 回合冻结 + fail-closed `agent.cancel`；`KB_QUERY_TOOLS` 完整打通 `dispatch()`、`dispatchTeamMember()`、深度 2 孙代（先挂再 `restrict`）、legacy `@agent` 与普通子代理，全路径级联清理。 | 仅主会话直连 / 漏改 `releaseChildBindings` 与孙代顺序 | `SK-3`, `SK-5`, `SK-9`, `CG-11`, `UA-4` | **APPROVED (v2)**：消除孙代永久遮蔽、附件泄漏、新建任务丢选择与删除孤立项。 |
| **D10** | 知识库维护页（无问答框）采用正交状态与三分操作按钮、人类可读 Wiki 树 + 剥离 frontmatter 的安全 `WikiMarkdownView` 内链跳转、批次汇总事件与筛选；对话溯源采用结构化工具芯片并在既有 `right-pane`（「预览」）打开。 | 单一「已暂停」徽标 / 纯文本正则引用 + 新浮层抽屉 | `CG-12`, `UA-1`–`UA-3`, `UA-6`, `UA-9`–`UA-13` | **APPROVED (v2)**：完全贴合现网三栏架构与办公用户心智。 |
| **D11** | 禁止 `profileDir`（自身/子/祖先）、相同或嵌套源目录及 Windows UNC/设备路径；允许与项目目录重叠；人话中文提示；`source-unavailable` 提供重绑按钮；`knowledge.reveal` 仅 `shell.showItemInFolder`。 | 未拦截 UNC / 缺重绑入口 / `openPath` 风险 | `CG-7`, `UA-8` | **APPROVED (v2)**：阻断 Windows NTLM 泄漏与误执行文件风险，补齐恢复体验。 |
| **D12** | `deletingIds` 门闩 + 顶层 `ctx.effect` **≤ 1,000 ms 并行退场预算**；设置与注册表全走 `writeFileAtomic + 0o600`；`events.jsonl` 经 `maskSecrets()` 脱敏且不落原始 HTTP 错误体。 | 串行等待退场 / 非原子写设置 / 裸打错误体 | `CG-5`, `CG-8`, `CG-9` | **APPROVED (v2)**：安全留出 3 秒强杀崖壁余量并守住凭据安全底线。 |
| **D13** | **单库单槽整理会话与 `session_projcache` 治理**：每库复用 `huaanwork-kb-org-<kbId>` + 6 点可见性/桥接/锚点/清扫隔离 + 持有 `AgentHandle.dispose()` 后删日志 + 删库 fail-soft 删 `session_projcache` 记录。 | 每批铸造新 `runId` 会话 | `SK-2`, `CG-6` | **APPROVED (v2)**：零修改上游子模块同时彻底消除侧边栏污染与 128 MiB 缓存膨胀。 |
| **D14** | **安全动态提示词注入**：新增 `huaanwork-guardrails/knowledge-prompt.ts` 注册 `ctx.systemPrompt.context({ required: true, interpolate: false })` 沿 `parentSessionOf` 解析，剔除易变 `docCount`；整理会话提示词通过 `agents.create({ setup })` 以 `interpolate: false` 注入。 | 未接线说明 / 默认插值 / 注入易变 `docCount` | `SK-4` | **APPROVED (v2)**：杜绝 `{{...}}` 崩溃与 KV-cache 失效，并让子代理天然获知引用规范。 |
| **D15** | **表内路由契约治理**：新增 `knowledge-routes.ts` 展开进 `ROUTE_TABLE`（`/huaanwork/knowledge/*`，`GET`/`POST`）与 `api.ts`，同步更新 4 处路由契约测试；新增 holder 全部做可选链降级；`packages/huaanwork-policy/` 保持纯逻辑。 | `/api/*` + `:id` + `PATCH`/`DELETE` / 表外另起协议 | `SK-5`, `CG-11` | **APPROVED (v2)**：100% 对齐 `expertTeam.*` 现网范式与双向契约校验。 |
| **D16** | **锁定全范围下的两阶段工程里程碑**：`M1` 落地核心闭环（隔离工作区 + 双 Worker + 监听/对账 + 文本/OOXML/文字 PDF+CMaps + FTS5 + 单槽整理 Agent + 维护页三标签 + Composer 挂载/全血缘透传/右栏溯源），`M2` 补齐旧版 `.doc/.xls/.ppt`、条件视觉转写与可选 Embedding RRF 混合检索；功能发布须 M1+M2 全部通过。 | 单波次全堆砌 / 砍掉已锁定的旧 Office 与视觉能力 | `SK-16` | **APPROVED (v2)**：在不违背用户锁定范围的前提下大幅降低集成与排障风险。 |

---

## 8. 进入 `writing-plans` 前的强制修订门禁清单（Gating Checklist）

以下 5 组首轮强制要求均已在 [`2026-11-24-knowledge-base-design.md`](./2026-11-24-knowledge-base-design.md)（v2.1）逐项闭环：

1. **只读边界与策略门禁（`D2`、`D7`、`SK-1`、`SK-15`、`CG-1`）**
   - [x] 撤回对整理 Agent 进程内 fs 工具的 OS 沙箱宣称，改写为真实纵深边界并强制 `sandbox-cwd.ts` 对 `KB_ORG_SESSION_PREFIX` fail-closed + 禁 OS 临时目录与符号链接写。
   - [x] 从整理白名单移除 `str_replace_editor`；明确 `kb_org_mark_organized` 的受控墓碑删除、非空 ≤ 256 KB 校验与原子 `WHERE doc_id = ? AND sha256 = ?` 提交守卫。
   - [x] 明确 `present-as.ts:156` 空交集 fail-closed 修法及 `huaanworkSessionToolAllow` / `huaanworkPackageChildAllow` 集合交集优先级。
2. **整理会话、调度器与提示词（`D6`、`D8`、`D13`、`D14`、`SK-2`、`SK-4`、`SK-7`、`SK-8`、`CG-6`）**
   - [x] 将 `kb-org-<kbId>-<runId>` 替换为单库复用槽 `huaanwork-kb-org-<kbId>`（`D13`）并写全 6 处隔离点 + `AgentHandle.dispose()` + `session_projcache` 删库清理。
   - [x] 在 SQLite `documents` 表补齐 `organize_attempts`（≤ 3）、`organize_retry_after`、`last_organize_error` 与 `extract_config_hash`。
   - [x] 明确 `TurnScheduler` 抢占式让路前台对话（并经 `inFlightOrganizeByKb` 解耦槽位 `dispose` 生命周期）、排除 `soleCapWriterSessionId()`、异步自动化后置唤醒与整理模型预检绑定。
   - [x] 明确 `huaanwork-guardrails/knowledge-prompt.ts`（`interpolate: false`、无 `docCount`）及整理会话 `agents.create({ setup })` 提示词接线。
3. **子代理血缘与回合并发门控（`D9`、`SK-3`、`SK-9`、`CG-11`）**
   - [x] 明确 `agent/inbox/claimed` 的 `isTurnBoundaryMessage` 守卫、回合冻结 `kbIds` 与 fail-closed `agent.cancel({ kind: 'hook', reason: 'knowledge-attachment-sync-failed' })`。
   - [x] 明确深度 2 孙代在 `skills.ts` 中「先挂载刷新、再快照 `restrict`」的时序、`dispatch()`/`dispatchTeamMember()` 双路径 `releaseChildBindings()` 镜像，以及 legacy `@agent` 与普通子代理的对称继承清理。
4. **双 Worker、提取、视觉、索引与安全生命周期（`D1`、`D3`–`D5`、`D12`、`SK-6`、`SK-10`–`SK-14`、`CG-2`–`CG-10`）**
   - [x] 明确拆出 Storage/Query Worker 与 Extraction Worker Pool（256 MB 堆上限、首行 `disableAsarArchiveView`、in-Worker `lstat`/`realpath`/`(dev,ino)`、ZIP/文本/切片/WAL 全量硬上限与 `(chunk_id, model_key)` ≥ 95% 覆盖门禁）。
   - [x] 移除全部 `sharp` 运行时依赖；补全 `knowledgeNative` 沙箱/零出网/分页限流/换代退出回收契约、`pdfjs-dist` CMap 打包冒烟与 M2 OLE2 许可证审计门禁。
   - [x] 补全 FTS5 安全转义与单字/路径/标题索引、1 对 1 `sha256` 重命名、非唯一 `norm_path` + 只读大小写探针、Windows UNC 拒绝、`FSWatcher` 容错与暂停开关、休眠唤醒恢复（无 `keep_awake`）。
   - [x] 补全 `knowledgeHttpFetch`、`writeFileAtomic + 0o600`、`maskSecrets()`、checkpoint/诊断包排除（含 `session-citations/`）与 `≤ 1,000 ms` 并行 Host 退场契约。
5. **表内路由、前端 UX 与双里程碑（`D10`、`D11`、`D15`、`D16`、`SK-5`、`SK-16`、`CG-11`、`CG-12`、`UA-1`–`UA-13`）**
   - [x] 重写 §9.3 为表内 `/huaanwork/knowledge/*`（`GET`/`POST`，含 `session.knowledge.get` 与 M1/M2 列）+ 4 处契约测试更新 + 全量会话删除级联清理（含 `session-sweep` 剪枝）。
   - [x] 重写 §9.4 吸收全部 `UA-1`–`UA-13` 与 `CG-12`（结构化引用芯片 → `right-pane`、正交状态与三分按钮、可读 Wiki 树 + 剥离 frontmatter + 内链相对路径规范化 + 全图片拦截 + 256 KB 上限、`kbPickByTab`、视觉模型下拉 + 一键补全扫描件、批次事件汇总与筛选、人话报错与重绑按钮、`composer-bar` 折行/紧凑缩略与中文工具标签）。
   - [x] 在规格中补充 **M1 / M2 工程里程碑表**（`D16`），并将 §13 Decision Log 更新至最终 `D1`–`D16`。

---

## 9. 第二轮复核与收口（2026-11-24 — `APPROVED`）

### 9.1 对 Grok 修订版 v2 的校准核实

Grok 在 v2 的 `§0 评审校准` 中对照源码进一步收紧了多处表述（包括：`host-process.ts` 2 秒 `status` 超时不会立即强杀、15s 为 `suspect`/60s 才为 `stoppable`；`limits.ts` `MAX_CONSECUTIVE_SAME_FAILURES = 3` 仅统计同工具同关键参数；`isLanEndpoint` 放行 `*.local` 并拒绝其它主机名；`project.remove`/`task.remove`/`automation.remove` 均经 `releaseAndDiscardSession` 进入 `releaseSessionRuntime`），经逐行源码核验均属实，予以认可保留。

### 9.2 第二轮源码复核发现与 v2.1 闭环记录

| 编号 | 严重度 | 复核发现与源码证据 | v2.1 闭环修订 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **R2-I1** | Important | v2 要求重开历史会话回填 `kbIds` 并复现父/子会话溯源引用，但 `sessions.ts:851-863`（`session.open`）仅读父会话 `.jsonl`，且 §9.3 缺少读接口与跨子会话引用落盘位置 | 新增 `<profileDir>/session-citations/<sessionId>.json`（`writeFileAtomic + 0o600`，排除出 checkpoint 与诊断包）按父会话归集父/子回合结构化引用；§9.3 新增 `session.knowledge.get`（`GET /huaanwork/session/knowledge/get`）统一回填 `kbIds` 与 `citations` | **已闭环** |
| **R2-I2** | Important | `TurnScheduler.admitUserTurn` 为同步方法；若抢占取消 `kb-organize` 后立刻清空根锁而旧 `handle.dispose()` + `removeSessionFilesById()` 尚未完成，同库复用单槽 `create()` 会抛 `SessionAlreadyExistsError` | 在 §8.2 与 `D8` 显式解耦「全局并发名额释放」与「单库槽位生命周期锁 `inFlightOrganizeByKb: Map<kbId, Promise<void>>`」，同库下一次 `create()` 或删库必须 `await` 旧 `handle.dispose()` 彻底结算，且旧整理 `finally` 幂等跳过二次扣减名额 | **已闭环** |
| **R2-I3** | Important | `sessions.ts:918` 的 `releaseSessionRuntime(ctx, sessionId): void` 为同步无 `profileDir` 函数，且 `session-sweep.ts:154-165` 直接删存量日志不经过它 | 在 §0、§9.1 与 `D9` 明确 `releaseSessionRuntime` 同步清理内存态与附件、经注入串行持久化队列异步删盘（缺 `profileDir` 降级 no-op），并在启动加载或 `session-sweep` 后对已删会话做孤立剪枝 | **已闭环** |
| **R2-I4** | Important | v2 §9.1 `agent.cancel({ kind: 'hook' })` 缺少上游 `AgentCancelCause`（`session/src/types.ts:190-194`）必填的 `reason: string` | 修正为 `agent.cancel({ kind: 'hook', reason: 'knowledge-attachment-sync-failed' })` | **已闭环** |
| **R2-I5** | Important | §9.3 `knowledge.organize` 缺少单文档重试参数，无法清零 `organize-failed` 计数；上游 `file-link.ts:10-32` 的 `parseFileLink` 不接受非行号 `#锚点`，且 `openFile` 需相对当前文件目录解析并防越界 | §9.3 明确 `knowledge.organize` 支持 `{ id, docId?, retryFailed? }` 清零计数重试；§8.3 与 §9.4 明确整理提示词使用 `wiki/` 根相对路径且不带非行号 `#锚点`，`WikiMarkdownView` 的 `openFile` 做相对路径规范化并拒绝越出 `wiki/` | **已闭环** |
| **R2-M1** | Minor | `styles.css:1208-1213` 的 `.composer-bar` 无折行，320px 强求单行易挤出按钮；§9.3 未标注 `knowledge.retrySkipped` 的 M2 归属 | §9.4 改为允许窄宽折行（`flex-wrap: wrap`）或高优先级紧凑缩略；§9.3 路由表补齐 `M1 / M2` 里程碑列 | **已闭环** |

### 9.3 最终放行结论（Final Disposition）

- **结论：`APPROVED`（通过第二轮点名项）**
- 统计：`R2-I1`–`R2-I5` 与 `R2-M1` 均已写入 v2.1。这不等于整份规格已经可以写实施计划。是否准入以 §10 的 Grok 第三轮结论为准。

---

## 10. 第三轮 Grok 审核（2026-11-24 — v2.1 是否可写实施计划）

### 10.1 审核范围与结论

审核对象是 v2.1 全文，对照 `superpowers:writing-plans` 的准入：计划作者不另做用户可见的产品决定，跨任务共用的持久化记录有字段，规格里的行为不能靠两种实现同时成立。

本轮先复核上一轮对话里提出的 6 条，再按源码收紧。6 条各自对应规格里没写死的缺口，没有一条是误报。说宽的是三处：整理模型并不是激活模型、标签模型和每库模型三选一；注册表不需要单独的 schema 版本号；`chunk_id` 的拼法不必锁死。

**Grok 审核结论：`ITERATE`。** 维持阻断 2 项（`G3-B1`、`G3-B2`）。同轮应补 4 项（`G3-I1`–`G3-I4`）。`D1`–`D16` 与第二轮已闭环的 `R2-*` 继续有效。这 6 条补进规格之前，不写实施计划。

### 10.2 复核后仍阻断

| 编号 | 原判断 | 复核 | 规格必须补上的句子 |
| :--- | :--- | :--- | :--- |
| **G3-B1** | 引用文件没有记录格式 | **属实。** §5.2 与 §9.1 只写了 `session-citations/<sessionId>.json` 的路径、权限和「归集溯源条目」。§9.3 的 `session.knowledge.get` 只写「返回 citations」。没有字段、条数、字节上限、去重键和写入时机。`knowledge.chunk` 的查询键是 `id + docId + ordinal`（§9.3）。§7.1 规定单文档在一个事务里替换 `chunks`，因此 `chunk_id` 不能当作重开历史后的定位键。原判断里「若只存 chunkId 就会坏」是计划作者可能走错的后果，不是规格已经选定只存 `chunkId`。 | 单条引用固定为 `{ clientMessageId, childSessionId?, kbId, kbName, docId, relPath, ordinal, locator, excerpt, searchMode, stale, sourceUnavailable }`。按父会话归集。同一 `clientMessageId + kbId + docId + ordinal` 只留最后一条。单文件最多 200 条、256 KB，超出丢最旧的。只在检索工具成功返回时追加；写盘失败记日志，不取消本回合。预览一律再调 `knowledge.chunk`，不把 `chunkId` 当历史主键。 |
| **G3-B2** | `doc_id` 的生成与重命名冲突 | **属实，范围收在生成规则。** §6.1 写明 1 对 1 重命名「只更新 `rel_path`」，切片、向量和整理结果继续用。卡片路径是 `wiki/docs/<docId>.md`（§8.3）。正文没有写 `doc_id` 如何生成。按 `rel_path` 哈希生成会在改名时换主键，并让卡片路径跟着变，与「只更新 `rel_path`」不能同时成立。`chunk_id` 的具体拼法不必在规格里锁死；锁死的是它不承担历史定位。 | `doc_id` 在该文件首次入库时用 `randomUUID()` 生成，此后不变，不从路径派生。重命名只改 `rel_path` / `norm_path`。整篇重索引可以重写 `chunks` 行。 |

### 10.3 复核后改为同轮应补

| 编号 | 原判断 | 复核 | 规格应补的句子 |
| :--- | :--- | :--- | :--- |
| **G3-I1** | 整理模型有三种读法：激活模型、`modelPickByTab`、每库单独配置 | **缺口属实，三种读法不属实。** 规格只写「写入 `huaanworkSessionModels`」和建库文案「当前模型」（§8.2、§9.4），没有写出条目 id。`resolveSessionModel` 的 `active` 参数只有端点、没有 `id`（`session-models.ts`）。但仓库里自动化已经有唯一先例：每轮启动读取 `settings.active_model_id`，放进只含该会话的表，再调用 `resolveSessionModel`（`automations-host.ts` 约 359–368 行）；本轮快照之后改设置不影响这一轮。`modelPickByTab` 只参与对话发送（`resolveSendModelId`），整理槽不是对话标签。注册表也没有每库模型字段。 | 每批整理开始时读取 `settings.active_model_id` 写入该整理槽，再 `resolveSessionModel`。条目不存在或门禁失败则 `blocked-no-model` / `blocked-network`，不回落前台标签，不为知识库另存模型 id。下一批再读一次激活模型。 |
| **G3-I2** | `knowledge-bases.json` 与 `session-knowledge.json` 缺字段和版本号 | **字段缺口属实，版本号不属实。** `session-knowledge.json` 已写明 `sessionId -> kbIds[]`。`knowledge-bases.json` 只有文件名。创建/更新参数能推出 `name`、`sourceDir`、`autoOrganize`、暂停监听，但没有登记记录，也没写暂停在重启后是否还在。现有 `projects.json` 是 `{ projects: ProjectInfo[] }`，`id` 用 `randomUUID()`，没有 schema 版本字段（`stores.ts`、`rpc-types.ts` 的 `ProjectInfo`）。不要为知识库单独引入版本信封。 | 注册表为 `{ knowledgeBases: KnowledgeBaseRecord[] }`。记录字段：`id`（`randomUUID()`，并过 `assertSafePathSegment`）、`name`、`sourceDir`、`autoOrganize`、`watchPaused`、`createdAt`。`watchPaused` 落盘，重启后仍暂停监听。源卷是否区分大小写每次启动重探，不写入记录。挂载文件保持 `sessionId -> kbIds[]`，不另加版本号。 |
| **G3-I3** | 只写了指数退避和最多 3 次，没有间隔 | **属实。** `organize_retry_after` 是毫秒时间戳列（§7.1），§2.3 与 §8.1 没有三次分别等多久。这是内部时钟，不改变对外状态名。计划里若各写各的间隔，测试无法共有一个期望值。 | 同一 `(doc_id, sha256)` 失败后，`organize_retry_after` 依次为现在起 1 分钟、5 分钟、15 分钟。第三次后进入 `organize-failed`，不再自动排期，直到 `sha256` 变化或 `knowledge.organize` 按 `docId` 清零。 |
| **G3-I4** | 50 页是常量而不是设置；云占位文件没有失败回退 | **两部分都属实，都不是新功能。** §2.3 写「默认前 50 页」。§9.4 的 M2 设置只有视觉模型、Embedding 和连通性测试，没有页数输入。`extract_config_hash` 仍包含「页数上限」，§11.1 又把「页数上限」和视觉开关写在一起，计划可能据此做一个设置项。云盘一句只要求「先看属性」并在 Windows / OneDrive 真机验证（§6.1），没有属性读不到时的行为。 | 50 页是代码常量，不是设置项。它进入 `extract_config_hash`，只为了以后改常量时能走「补全跳过的扫描件」。M2 不增加页数控件。云占位属性读不到或当前平台没有该项时，按普通文件进入阶段 1，并记一条 info 事件；不要因为判断不了就跳过整批。具体 Win32 / OneDrive 属性名留在实施计划。 |

### 10.4 不纳入这 6 条的计划写法

Worker 消息协议、源码文件如何拆开、1280px 断点，仍由实施计划决定。计划按 `writing-plans` 拆开写：M1 分成注册与索引、单槽整理、会话挂载与引用预览三份，每份都能单独通过 `corepack yarn check`；M2 单独一份。这是计划的范围检查，不是上面 6 条里的规格缺口。

---

## 11. 第三轮校准核实与最终收口（2026-11-24 — v2.2 `APPROVED`）

### 11.1 逐项核实与细化校准

经对照 v2.1 原文及 `automations-host.ts:359-368`、`session-models.ts:55-65`、`settings.ts:53-59`、`stores.ts:29-59` 逐项复核，**Grok 第三轮提出的 6 项缺口全部属实（0 误报）**，并在落地 v2.2 前补充了 **3 处细化校准**：

| 编号 | 核实结论 | 细化校准与源码依据 | v2.2 落点 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **G3-B1** | **属实（细化校准）** | Grok 提出的切片引用字段、200 条/256 KB 上限、写错不取消回合与 `chunkId` 非历史主键均成立；**补充校准**：§9.1/§9.4 同步持久化来自 `kb_read_wiki` 的 Wiki 引用（无 `ordinal`，如 `INDEX.md`/`topics/*.md`），需区分 `kind: 'chunk'`（预览走 `knowledge.chunk`）与 `kind: 'wiki'`（预览走 `knowledge.wikiFile`）两种联合体记录，并明确原库已删或切片变更时优雅回落展示已存 `excerpt` | §2.3、§9.1、§9.4、§11.1(7)、`D9` | **已闭环** |
| **G3-B2** | **属实** | 确认 v2.1 漏写 `doc_id` 生成规则；明确首次入库用 `randomUUID()` 生成、永久不变且不从路径派生，1 对 1 重命名仅改 `rel_path`/`norm_path`，整篇重索引可重写 `chunks` | §7.1、§11.1(4)、`D6` | **已闭环** |
| **G3-I1** | **属实（细化校准）** | 核实 `automations-host.ts:360-368` 确实快照 `settings.active_model_id`；**补充校准**：核查 `session-models.ts:55-65` 发现 `resolveSessionModel` 只校验条目存在与 `workNetworkGateError`，**并不拒绝 `settings.ts:56` 首次安装的缺省空 `model: ''`**。因此明确整理预检须同时校验 `resolved.ok && resolved.model.trim().length > 0`（缺失或空 `model` 走 `blocked-no-model`，网络门禁走 `blocked-network`），并在 `handle.dispose()` 后删掉该槽模型绑定以便下一批重读激活模型 | §8.1(2)(4)、§8.2(7)、§11.1(6)、`D8` | **已闭环** |
| **G3-I2** | **属实** | 核实 `stores.ts:29-59` 的 `projects.json` 为无版本信封的 `{ projects }` 包装；明确 `knowledge-bases.json` 为 `{ knowledgeBases: KnowledgeBaseRecord[] }`（`id`/`name`/`sourceDir`/`autoOrganize`/`watchPaused`/`createdAt`，`watchPaused` 重启保留、大小写每次只读重探），`session-knowledge.json` 保持 `Record<string, string[]>` | §5.2、`D9` | **已闭环** |
| **G3-I3** | **属实（细化校准）** | 确认 v2.1 缺少具体退避间隔；**补充校准**：在「同一 `(doc_id, sha256)` 最多尝试 3 次、第 3 次失败即入 `organize-failed` 不再自动排期」下，仅实际触发 2 段自动退避（第 1 次失败 → `now + 60_000` 1 分钟，第 2 次失败 → `now + 300_000` 5 分钟，第 3 次失败 → `organize-failed` 且 `organize_retry_after = null`），去掉不会生效的第 3 段 15 分钟死常量 | §2.3、§8.1、§11.1(6)、`D6` | **已闭环** |
| **G3-I4** | **属实** | 确认 v2.1 对 50 页是常量还是设置项存在措辞歧义、且缺云占位属性读取失败的回退规则；明确 `MAX_VISION_PDF_PAGES = 50` 为代码常量（非 M2 设置控件，留于 `extract_config_hash` 便于未来改常量触发补全），云占位属性不可读/平台无此项时按普通文件进入阶段 1 并记一条 `info` 事件 | §2.3、§6.1、§6.3、§11.1(3)、`D6` | **已闭环** |

### 11.2 最终准入结论（Final Disposition）

- **结论：`APPROVED`（满足 `superpowers:writing-plans` 准入）**
- 统计：三轮评审累计发现（首轮 41 项 + 二轮 6 项 + 三轮 6 项）均已在 [`2026-11-24-knowledge-base-design.md`](./2026-11-24-knowledge-base-design.md)（v2.2）闭环（0 Critical / 0 Blocker / 0 Important / 0 Minor 遗留）；后续实施计划按 §10.4 拆为 **M1-1 注册与索引 / M1-2 单槽整理 / M1-3 会话挂载与引用预览 / M2 全格式与混合增强** 四份，每份独立通过 `corepack yarn check`。

---

## 12. 第四轮 Opus 审核（2026-11-24 — v2.2 是否可写实施计划）

> 审核方：**Opus**。对象：[`2026-11-24-knowledge-base-design.md`](./2026-11-24-knowledge-base-design.md) v2.2。标准：`superpowers:writing-plans` 准入——计划作者不另做用户可见的产品/安全决定；同一句话不得有两种都说得通的实现；规格步骤必须有现成接口可用。

### 12.1 总体结论

**Opus 结论：`ITERATE`（有条件通过）。** 整体质量高，抽查的源码事实基本成立；但存在 4 项应在写计划前补入规格的缺口（其中 1 项在「不改子模块」前提下无法按原文实现）。补齐后可写实施计划。本节不推翻 §11 对前三轮 13 项闭环的结论，只指出 v2.2 仍遗留的问题。

### 12.2 已核实成立

| 项 | 核实结果 |
| :--- | :--- |
| 路由表长度 | `ROUTE_TABLE` 为 92 条；写死该数的测试恰好 4 处（`routes.spec`、`api.spec`、`route-contract.spec`、`market-routes.spec`） |
| 空交集 | `present-as.ts` 在 `allowed.length === 0` 时直接 return；上游 `tools.restrict({ allow: [] })` 合法，仅 `{}` 被拒 |
| `releaseSessionRuntime` | 确为同步 `void` 函数，不接收 `profileDir` |
| 提示词插值 | `systemPrompt` 支持 `interpolate: false` |
| 运行时可行性（实测） | Electron 44 内置 Node 24.18.1；`node:sqlite`、FTS5（SQLite 3.53.4）及 `worker_threads` 内开 SQLite 均可用（补上了 §0 所述「未重跑 Electron 活体探针」的缺口） |

### 12.3 写计划前应补（4 项）

| 编号 | 级别 | 问题与源码证据 | 规格应补的句子 |
| :--- | :--- | :--- | :--- |
| **O4-1** | Important（不可实现） | §8.1 第 4 步 / §5.2 第 6 条 / D13 要求删库时删除 `session_projcache` 记录。`SessionProjectionCache` 无公开删除方法，`table` 为私有；插件自行再开同名存储域会被 `storageDomain.open` 以 `already-open` 拒绝。不改子模块无法实现；现有 `session.remove` 也不删该缓存 | 删去该步，接受每个已删库最多残留 1 条记录；或明确改为在 `main.ts` 的 `session-projcache-recovery` 阶段离线剪枝 |
| **O4-2** | Important | 失败计数口径未定义：被用户回合抢占取消、用户停止、看门狗超时、`blocked-*`、回合正常结束但有文档未 mark，是否 `organize_attempts += 1`。并发设为 1 且用户持续使用时，3 次抢占即可把文档打进 `organize-failed`，用户可见且测试无统一期望 | 明确各类终止的计数口径：建议取消（抢占/用户停止）与 `blocked-*` 不计数；回合正常结束但未 mark 或模型报错（及看门狗超时）对本批所有未 mark 文档各 +1 |
| **O4-3** | Important | §9.1 只写「铸出会话后再写入 `session-knowledge.json`」。现有 `modelPickByTab` 是作为 `modelId` 随 `session.send` 参数一并送出（`App.tsx` 约 3745 行）。若发送前不等 `session.knowledge.set`，「新建任务即勾选知识库」路径的首回合会在边界冻结为未挂载 | `session.send` 增加可选请求参数 `kbIds`（`buildSessionSendParams` / `sessionSend`），与 `modelId` 同样处理，宿主在首回合边界前落盘；若影响返回载荷则同步 `route-contract.spec` 可选响应键 |
| **O4-4** | Important（安全边界） | §5.3(3)/§8.1 只写「显式白名单」，未指定载体。`present-as` 现算法为 `schemas ∩ (ALLOWED_TOOLS ∪ 附件)`，全局 `ALLOWED_TOOLS` 含 `bash`、`pwsh`、`str_replace_editor`、`git_*`、`web_fetch`、`call_host_tool`、`skill` 等。评审稿 §8 提到的 `huaanworkSessionToolAllow` 在代码中不存在。`huaanworkPackageChildAllow` 仅被 `policy.ts` 用于拒绝，`present-as` 不据此收窄。另未说明整理槽是否登记 `huaanworkUnattended`，否则遇审批操作无人可批，回合挂到看门狗超时 | 指定持有整理白名单的字段（复用 `huaanworkPackageChildAllow` 并令 `present-as` 按其收窄，或新建专用 map）；明确整理槽对 `huaanworkUnattended` 的登记策略 |

### 12.4 次要项（可由计划决定，规格补一句更好）

- **连通性测试路由缺失**：M2 设置页有「连通性测试」，§9.3 无对应路由，影响契约计数。
- **`autoOrganize` 建库默认值未写**：决定后台是否默认调用模型、产生费用。
- **跨库检索排序**：各库独立 SQLite，BM25 分数不可直接比较，多库合并策略、`topK` 默认值与上限均未写。
- **抢占条件偏宽**：应限定为「因全局满额而排队」才取消整理；若排队原因是同根已有写者，取消整理无益。
- **监听路径下的重命名**：防抖批内是否同样适用「1 对 1 `sha256`」规则未写。
- **FTS 级联删除**：`chunks_fts` 为独立 FTS5 表，`ON DELETE CASCADE` 不覆盖；删文档需显式删行或建触发器。
- **打包冒烟环境**：§7.1 写 `ELECTRON_RUN_AS_NODE=1`，而 Host 实际由 `utilityProcess.fork` 启动，冒烟应在该环境运行。
- **回合进行中的边界**：子会话引用如何实时推送客户端未写；本回合冻结的 `kbIds` 中库被删时工具调用的报错语义未写。

### 12.5 工程流程提示

规格与本评审稿目前均未纳入版本控制（`git status` 为 `??`）。依 AGENTS.md「方向性变更前先提交」，建议补完 O4-1–O4-4 后先提交，再开始写实施计划。

### 12.6 准入结论（Opus）

- **结论：`ITERATE`。** 阻断实施计划的为 O4-1–O4-4；§12.4 为非阻断建议。
- 与 §11.2 的关系：§11.2 对三轮既有发现的「已闭环」结论保持有效；其中「0 遗留」的统计不涵盖本轮新增项，以本节为准。

---

## 13. 第四轮校准核实与最终收口（2026-11-24 — v2.3 `APPROVED`）

### 13.1 逐项源码复核与校准闭环

经对照 `session-projection-cache/src/{index,spec}.ts`、`storage-json/src/{index,per-record-unit}.ts`、`session-projcache-recovery.ts`、`present-as.ts`、`policy.ts`、`packages/huaanwork-policy/src/decide.ts`、`approval.ts`、`holders.ts`、`turn-scheduler.ts`、`sessions.ts`、`routes.ts`、`App.tsx`、`verify-packaged-runtime.ts` 与 `host-liveness-win.spec.ts` 逐项复核，确认 **Opus 第四轮 4 项阻断（`O4-1`–`O4-4`）核心均成立**、**§12.4 中 7 项次要建议成立**，并对 **2 处源码细节做了收紧校准**，已全部写入 [`2026-11-24-knowledge-base-design.md`](./2026-11-24-knowledge-base-design.md)（v2.3）：

| 编号 | 核实结论 | 源码校准与 v2.3 落点 | 状态 |
| :--- | :--- | :--- | :--- |
| **O4-1** | **完全成立** | 核实 `SessionProjectionCache` 无公开删除 API、`storageDomain.open` 禁止重开同名域、现有 `session.remove` 亦不删该缓存；另核实当前 `per-record` 落盘位于 `storages/session_projcache/sessions/<sessionId>.json`（而 `session-projcache-recovery.ts` 仅检查旧单文件）。v2.3 采纳方案一：**删去删库时操作 `session_projcache` 的步骤**（单库固定单槽已根治膨胀，与 `session.remove` 一致、不改子模块）。落点：§0、§5.2(6)、§8.1(4)、`D13`。 | **已闭环** |
| **O4-2** | **完全成立** | 明确整理失败计次口径：抢占取消、手动停止（`knowledge.organizeCancel`）、`blocked-no-model` / `blocked-network` 与 Host 退出/换代中止**不计数**；模型/回合报错、看门狗超时或回合正常结束但未 mark 对本批未 mark 文档各 `organize_attempts += 1`。落点：§2.3、§8.1、§8.2(3)、§11.1(6)、`D6`。 | **已闭环** |
| **O4-3** | **完全成立** | `session.send`（`buildSessionSendParams` / `SessionSendParams` / `sessionSend`）新增可选请求参数 `kbIds?: string[]`，与 `modelId` 同样随空标签首条消息一并送出，宿主在 `admitUserTurn` 之前同步校验并落盘（覆盖立即启动与排队场景）；已有 `sessionId` 的后续改选仍走 `session.knowledge.set`。落点：§9.1、§9.3、§11.1(7)、`D9`。 | **已闭环** |
| **O4-4** | **核心成立（后半句校准）** | **前半句完全成立**：新增登记在 `HUAANWORK_CONTEXT_PROPS`（`holders.ts`）的 `ctx.huaanworkSessionToolAllow: Map<string, readonly string[]>`，由 `present-as.ts` 与 `policy.ts` 双层收敛并处理空交集（`tools.restrict({ allow: [] })`）。<br>**后半句校准**：整理白名单内 6 个 fs 工具（`decide.ts:93-101`）与 3 个 `kb_org_*` 均为纯 `ALLOW`/`DENY` 永不返回 `ask`，且 `approval.ts` 自身超时 2 分钟、`huaanworkUnattended` 强绑定 `automationId` 并写 `automations/<id>.audit.jsonl`；故 v2.3 明确整理槽**不登记** `huaanworkUnattended`。落点：§0、§4、§5.3(3)、§8.1(2)(4)、§11.1(2)、`D2`。 | **已闭环** |
| **§12.4（7 项成立）** | **一并补齐** | ① M2 路由表新增 `knowledge.testEmbedding`（`POST /huaanwork/knowledge/testEmbedding`，M1 16 条至 108、M2 2 条至 110）；② `knowledge.create` 的 `autoOrganize` 默认 `true`；③ 多库联合检索按单库名次倒数排名归并，`kb_search.topK` 默认 8 上限 20（`kb_list_docs.limit` 默认 50 上限 200）；④ 抢占条件收紧为 `!rootWriters.has(root) && activeTurns >= maxConcurrentTurns()`；⑤ 实时监听防抖批同样适用 1 对 1 `sha256` 重命名复用；⑥ `chunks_fts` 同事务显式删除/同步更新；⑦ 新增 `knowledge/citation` 实时推送事件，回合途中某库被删时 `kb_search` 跳过、定向读返回 `{ error: 'knowledge-base-removed', kbId }`。落点：§4、§5.2、§6.1、§7.1–§7.2、§8.2–§8.3、§9.1–§9.4、§10、§11.1、`D3`/`D5`/`D8`/`D9`/`D15`。 | **已闭环** |
| **§12.4（打包冒烟）** | **反向校准** | `utilityProcess.fork` 仅存在于 Electron 主进程（`host-liveness-win.spec.ts:7`），全仓无头打包冒烟（`verify-packaged-runtime.ts`）均走 `ELECTRON_RUN_AS_NODE=1` 以遵守无头安全约束。v2.3 保持 §7.1 / §11.1(10) 无头冒烟为 `ELECTRON_RUN_AS_NODE=1`，并将完整打包应用 `utilityProcess.fork` Host 实测显式写入 §11.2 真机验收。 | **已闭环** |

### 13.2 最终准入结论（Final Disposition）

- **结论：`APPROVED`（满足 `superpowers:writing-plans` 准入）**
- 统计：四轮评审累计发现（首轮 41 项 + 二轮 6 项 + 三轮 6 项 + 四轮 4 项阻断与 8 项次要建议）均已在 [`2026-11-24-knowledge-base-design.md`](./2026-11-24-knowledge-base-design.md)（v2.3）闭环（0 Critical / 0 Blocker / 0 Important / 0 Minor 遗留）。
- 下一步建议：按 `AGENTS.md`「方向性变更前先提交」，先将 v2.3 规格与本评审稿纳入版本控制，再按 §10.4 拆分为 **M1-1 注册与索引 / M1-2 单槽整理 / M1-3 会话挂载与引用预览 / M2 全格式与混合增强** 四份实施计划。
