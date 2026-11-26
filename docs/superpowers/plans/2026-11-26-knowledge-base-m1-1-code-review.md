# 知识库 M1-1（`feat/knowledge-base-m1-1-registry-indexing`）Code Review

- **日期：** 2026-11-26
- **审阅目标：** 分支 `feat/knowledge-base-m1-1-registry-indexing`
  - 共同基线（`master`）：`209d9f18353f433a3bca82206d1e7dea3e4c64f8`
  - 首轮 `HEAD`：`8e92b6319b7e1e3b66b3ffa35cd82b739cd0b964`（相对 `master` 共 12 个提交、47 个文件，`11576 insertions(+), 10 deletions(-)`）
  - 复跑 `HEAD`：`619e37329edad7c3cefdea0175d9d345fb81632f`（`fix(knowledge): address M1-1 code review findings and commit M1-1 plan docs`）
  - 上游子模块 `deepseek-harness`：`1600d8a1e140dcde43a1a0941940a0480712c011`（本范围无修改）
- **对照依据：**
  - 设计规格：[2026-11-24-knowledge-base-design.md](../specs/2026-11-24-knowledge-base-design.md)（v2.5；本轮只核 M1-1 对应的 §5.2、§5.3、§6.1、§6.2、§6.4、§7.1、§7.2、§10、§11.1 中属于注册/提取/索引/监听/重绑/重建/删库/打包冒烟的条目，以及 D2、D3、D4、D5、D6、D11、D12、D17）
  - 规格评审：[2026-11-24-knowledge-base-design-review.md](../specs/2026-11-24-knowledge-base-design-review.md)（§10–§17）
  - 实施计划：[2026-11-25-knowledge-base-m1-1-registry-indexing.md](./2026-11-25-knowledge-base-m1-1-registry-indexing.md)（Task 1–Task 7 与 Global Constraints）
  - 计划评审：[2026-11-25-knowledge-base-m1-1-plan-review.md](./2026-11-25-knowledge-base-m1-1-plan-review.md)
- **范围外（不记为缺失）：** M1-2 整理槽、M1-3 路由与界面与引用、向量运行时、视觉转写、旧版 Office。`ROUTE_TABLE` 保持不改是 M1-1 的要求。
- **验证边界：** §一–§五是对 `8e92b6319b` 的只读首轮。四路初审分别覆盖注册与事件、提取安全、存储与 FTS、同步与生命周期；主审对全部 Critical 与 Important 逐条读码。首轮没有重跑 `corepack yarn check`。§六是对 `619e37329e` 的修复复核和沙箱外复跑。
- **首轮判定（§一–§五，已被 §六 取代）：** **Request changes / 不能合并（2 Critical / 13 Important / 10 Minor）。**
- **§六判定（已被 §七 取代）：** **代码面的 Critical 与 Important 已闭环；完整 `corepack yarn check` 仍未通过。** 复跑停在空白检查（计划文档第 11–13 行行尾空格），没有进入各包 typecheck 与 `verify:aa`。其后单独跑通的是华安插件 typecheck、build，以及编译后 Extraction Worker 对无 `/ToUnicode` 中文 PDF 的提取。仍开着的评审项是 **M-4** 与 **M-6**。
- **§七判定（已被 §八 取代）：** **With fixes / 有条件可合并（0 Critical / 1 Important / 6 Minor）。** 完整 `corepack yarn check` 本轮实跑 **EXIT=0**；§三 全部 20 条旧发现与 §六 仍开着的 **M-4 / M-6** 均在 `c1f6a972b3` 闭环。唯一挡路的是 `c1f6a972b3` 新引入的「已提交分支 WAL 嫁接」Important（N-1）；修掉或经 owner waiver 后即可合并。
- **当前判定（§八，qwen4 复核 Gemini 修复）：** **Ready to merge / 可合并（0 Critical / 0 Important / 0 Minor 开着）。** §七 的 N-1 与 6 条 Minor 全部由 Gemini 修复并经独立读码 + 红绿对照 + 完整门禁实跑（EXIT=0，4901 项通过）验证闭环。剩余真机 / 安装包验收与 PR CI 属合并后发布前人工项，非代码阻塞。

严重度口径：

- **Critical：** 会在真实运行中损坏或清空已有索引，或让维护锁失效。
- **Important：** 规格或计划已经写明的行为未实现、只在部分路径实现，或测试锁不住该行为。合并前应修。
- **Minor：** 上限、测试区分力、注释与流程问题。不阻塞把上面两类修完之后的合入判断。

---

## 一、校准说明

四路初审完成后，主审按「去夸大、收窄触发条件、保留真实缺陷」复核。下表只记录改过级别或改过表述的条目；未列出的 Important / Minor 与初审结论一致，并已在所引行读到对应代码。

| 类别 | 初审结论 | 复核事实 | 校准处理 |
| --- | --- | --- | --- |
| **消夸大（Critical → Important）** | 提取路将「`pdf.mjs` 在 import 时 `require("@napi-rs/canvas")`」定为 Critical | [pdf.mjs:14239-14247](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/node_modules/pdfjs-dist/legacy/build/pdf.mjs#L14239-L14247) 在 Node 下确实于 `getDocument` 之前加载 canvas，且 `dsh-plugin-huaanwork/node_modules/@napi-rs/canvas` 已安装。安装包侧已有排除：[package.json:502-503](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/package.json#L502-L503)，打包冒烟会检查泄漏。pdfjs 在 `require` 失败时会接住并继续做文字提取。生产安装包因此不会把该原生模块打进去 | 降为 **I-1**。开发态与 Vitest 仍违反「安装后不得引入 canvas、可 `terminate()` 的 Worker 不加载原生模块」 |
| **消夸大（Critical → Important）** | 注册路将「符号链接 / junction 指向 UNC 仍被接受」定为 Critical | [paths.ts:130-132](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L130-L132) 对原始字符串拒绝 `\\` 与 `//` 开头，直接 UNC / 设备路径不会绑定。缺口是 `realpath` 成功后不再检查规范化结果（[paths.ts:165](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L165)）。用户必须把该 junction 选成源目录 | 降为 **I-5**。D11 仍被绕过，`realpath` 本身就可能先访问共享 |
| **收窄触发条件（维持 Critical）** | 存储路称「Step 2 失败就会删掉恢复标记并在下次打开时清掉 `.bak`」 | Step 1 与 Step 2 之间的进程崩溃仍然安全：`.rebuild` 还在时 [recoverKnowledgeDbDir](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L467-L482) 会先还原 `.bak`。数据丢失需要同一次调用里 Step 2 抛错**并且** `restoreOldIndex` 也抛错。此后 [discardStagingAfterFailure](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1318-L1336) 仍删除 `.rebuild`，[storage-worker.ts:238-244](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-worker.ts#L238-L244) 的 `openCommittedKnowledgeDb` 不跑恢复，`DatabaseSync` 会在主文件缺失时新建空库；下次 `openKnowledgeDb` 看到没有 `.rebuild` 就删除 `.bak`（[storage-db.ts:485-487](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L485-L487)） | 维持 **C-2**，触发条件按双失败写明 |
| **表述收窄（维持 Important）** | 同步路称休眠恢复回调会立刻 `mkdir` 出已删除的知识库目录 | [handleSystemResume](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1426-L1448) 的延迟回调不检查运行态是否仍在 Map 中，会立刻对源目录重新 `fs.watch`。`listDocs` 失败时只把 phase 标成 `index-error` 并返回（[sync-engine.ts:795-805](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L795-L805)）。`mkdir` 发生在下一次对账：`ensureStorageReady` 见到 `index-error` 才 `openKb`（[sync-engine.ts:464-465](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L464-L465)），而 `openKnowledgeDb` 会 `mkdirSync` | 维持 **I-4**。监听泄漏是即时的，目录复活晚一轮 |

---

## 二、已经对齐的部分

1. **注册与隔离。** 注册表形状是 `{ knowledgeBases }`，经 `writeFileAtomic(..., { mode: 0o600 })` 按 profile 串行写入。`kbId` 走 `assertSafePathSegment`。`..hidden` 这类真实目录名不会被当成 `..` 前缀。缺文件返回 `[]`。`resolveKnowledgeWorkerUrl` 锚定 `dsh-plugin-huaanwork/package.json`，源码态走 `src/*.ts`，编译态走 `lib/*.js`。
2. **事件与诊断排除。** `events.jsonl` 先 `maskSecrets`，按库串行追加，从头部丢弃旧行，模式 `0o600`。Checkpoint 白名单与诊断包打包范围不包含 `workspace-knowledge/`、`knowledge-bases.json`、`session-knowledge.json`、`session-citations/`。
3. **只读提取与 ZIP 炸弹。** `openVerifiedSourceFile` 做 `realpath` 根归属、逐段 `lstat({ bigint: true })`、POSIX `O_RDONLY | O_NOFOLLOW`，再对已打开的 `FileHandle` 做 `stat` 复核。OOXML 只调用 `entry.getCompressedData()`；method 8 使用 `inflateRawSync(raw, { maxOutputLength })`。测试夹具里的伪造 `header.size = 0` 炸弹是真实 deflate 数据。加密、method 99 与 OLE2 返回 `skipped`。
4. **存储契约。** `storage-db.ts` 只被 Storage Worker 与其测试导入，Host 主线程不 `import 'node:sqlite'`。Worker 入口第一条语句是 `disableAsarArchiveView`。`documents`、`organize_tombstones`、`chunks`、`chunks_fts`、`chunk_embeddings` 与规格 §7.1 的列和主键一致。`chunks_fts` 与 `chunks` 在同一 `BEGIN IMMEDIATE` 事务里删除和重插。`doc_id` 首次 `randomUUID()`，同一 `rel_path` 重索引、1:1 重命名和正常重建保持不变。Step 2 `rename(index.sqlite.rebuild, index.sqlite)` 成功之后的失败不会把 `.bak` 搬回去。
5. **生命周期与桥接。** 0 库时 `KnowledgeHost.start()` 不创建 Worker 线程。`remove` 先进入 `deletingIds`，停 Watcher、排空提取、`closeKb`，再只删除 `neutralKnowledgeRootPath`；`rm` 失败不改注册表。`dispose` 同步关 Watcher 并清定时器，然后与 `extractionPool.dispose(300)`、`storage.dispose(800)` 和约 950 ms 兜底竞速。`native:subscribeSystemResume` / `native:unsubscribeSystemResume` 无条件注册，运行时没有该方法时静默 no-op。知识库宿主是独立 `ctx.effect`，`protectedRoots` 含 `neutralKnowledgeBaseDir`。打包冒烟经 `resolveKnowledgeWorkerUrl` 拉起两个编译产物。

---

## 三、问题清单（校准后）

### Critical（必须修复）

#### C-1【维护锁】重建挡不住引擎自己的周期对账和休眠恢复

- **位置：**
  - [sync-engine.ts:1115-1120](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1115-L1120)（`syncNow` 认 `locks` / `runtime.maintaining`）
  - [sync-engine.ts:1231-1287](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1231-L1287)（`rebuildIndex` 停机后直接 `await extractFile`，不进 `runtime.chain`）
  - [sync-engine.ts:1412-1448](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1412-L1448)（`handleSystemResume`）
  - [sync-engine.ts:1474-1486](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1474-L1486)（周期定时器）
  - [host.ts:497-507](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L497-L507)（只挡住 Host API）
- **问题事实：** `host.rebuild` 让并发的 `host.sync` / `host.update` 抛 `knowledge-base-busy`。周期回调和 `handleSystemResume` 只跳过 `watchPaused`。`stopSequence` 会等掉已经排在 `runtime.chain` 上的任务，但重建主体随后不在这条链上。提取过程中的 `await` 让周期对账或休眠恢复可以并行跑起来，向活库连接发送 `listDocs` / `upsertDocument` / `deleteDocument`。Storage Worker 一次处理一条消息。对账若在 Step 2 之后才执行，计划来自提交前的快照，写入的却是新库，会把刚清空的整理状态写回去，或删掉重建行。`handleSystemResume` 在 `maintaining === true` 时还会 `ensureWatcher`，把 `stopSequence` 刚关掉的监听重新打开。
- **为什么重要：** 规格 §6.4 / D17 要求维护期间拒绝同库并发同步与重建。默认对账间隔 5 分钟，库一大就会重叠；休眠恢复是规格点名的路径。生命周期测试只在让出一次后断言 `host.sync` 抛错，没有在 `extractFile` 卡住时调用 `handleSystemResume` 或周期回调。
- **修复建议：** 周期回调、`handleSystemResume` 和防抖任务都要认 `locks` / `runtime.maintaining`。拿到维护锁之后、`access()` 之前就设 `runtime.maintaining = true`。重建主体放进 `runtime.chain`。补一条测试：提取卡住时触发恢复，断言 `commitRebuild` 返回前活库连接上没有 `upsertDocument` / `deleteDocument`。

#### C-2【数据丢失】提交前回滚失败会删掉恢复标记，随后打开可能建成空库

- **位置：**
  - [storage-db.ts:1285-1296](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1285-L1296)（`restoreOldIndex`）
  - [storage-db.ts:1318-1336](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1318-L1336)（`discardStagingAfterFailure`）
  - [storage-db.ts:1371-1383](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1371-L1383)（Step 2 失败路径）
  - [storage-db.ts:461-490](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L461-L490)（`recoverKnowledgeDbDir`）
  - [storage-db.ts:493-507](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L493-L507)（`openVerifiedConnection`）
  - [storage-worker.ts:238-244](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-worker.ts#L238-L244)
- **问题事实：** Step 1 已把 `index.sqlite` 及 `-wal` / `-shm` 移成 `.bak*`。Step 2 的 `rename` 若抛错，代码会调用 `restoreOldIndex`，并吞掉它的异常，然后无条件删除 `index.sqlite.rebuild*` 和未提交的 `wiki-reset.pending`。`restoreOldIndex` 只有在 `renameSync(.bak → index.sqlite)` 成功时才算还原；它一抛错，`.bak` 还在，主文件却不在，`.rebuild` 也被删了。启动恢复只有在 `.rebuild` 存在时才走未提交分支。标记没了就进入已提交分支，无条件 `removeIfExists(.bak*)`。Worker 在返回 `rebuild-failed` 且该库曾经打开时调用 `openCommittedKnowledgeDb`。这条路径不跑恢复，`new DatabaseSync(path)` 会在主文件缺失时创建新文件。空的 `index.sqlite` 因此先出现，下次打开再把 `.bak` 删掉。
- **为什么重要：** 规格 §6.4 / D17 要求提交前失败回滚旧库，旧库与旧 `wiki/` 保持完好。进程在 Step 1 和 Step 2 之间崩溃的路径是安全的。不安全的是同一次调用里的双失败：Step 2 失败，并且把 `.bak` 搬回也失败。注释写着残留 `.rebuild` 留给启动恢复，实现却把这个标记删掉。
- **修复建议：** 只有确认 `index.sqlite` 已经是还原后的主库，才删除 `.rebuild*` 和未提交的 `wiki-reset.pending`。还原失败就留下 `.bak*` 与 `.rebuild`，返回 `rebuild-failed`，不要调用 `openCommittedKnowledgeDb`。主文件缺失且 `.bak` 还在时，即使 `.rebuild` 已经没了，也要先还原 `.bak`。`openVerifiedConnection` 在主文件不存在时不要建新库。补一条不 mock 文件系统的回归：Step 1 之后让 `.bak → index.sqlite` 抛错，断言 `.bak` 与 `.rebuild` 都还在，且没有新建空的 `index.sqlite`。

---

### Important（合并前修复）

#### I-1【依赖】开发态和测试仍会在 Extraction Worker 里加载 `@napi-rs/canvas`

- **位置：**
  - [pdf-text.ts:77-87](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/pdf-text.ts#L77-L87)
  - [pdf.mjs:14239-14247](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/node_modules/pdfjs-dist/legacy/build/pdf.mjs#L14239-L14247)
  - [package.json:409](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/package.json#L409)、[package.json:502-503](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/package.json#L502-L503)
- **问题事实：** `pdfjs-dist@6.5.438` 把 `@napi-rs/canvas@^1.0.13` 列为 optionalDependency，锁文件解析到 `1.2.1`，包已装在 `dsh-plugin-huaanwork/node_modules/@napi-rs/canvas`。第一份 PDF 执行 `import('pdfjs-dist/legacy/build/pdf.mjs')` 时，pdfjs 在 Node 分支无条件 `require("@napi-rs/canvas")`，发生在 `getDocument({ isOffscreenCanvasSupported: false })` 之前。安装包用 `files` 排除了 `node_modules/@napi-rs/canvas/**` 与 `node_modules/@napi-rs/canvas-*/**`，打包冒烟会数泄漏文件。`yarn dev` 和 Vitest 使用工作区 `node_modules`，Worker 里的 `require` 会成功并加载原生模块。
- **为什么重要：** 计划 Global Constraints 要求安装后确认没有引入 `@napi-rs/canvas`。D4 禁止在会被 `terminate()` 的 Worker 里加载这类原生插件。安装包路径已经挡住；开发态和单测没有挡住。
- **修复建议：** 让 `@napi-rs/canvas` 从 `pdfjs-dist` 解析失败（Yarn resolution 到会抛错的桩，或不要安装这个 optionalDependency），并保留安装包排除。pdfjs 已经接住失败的 `require`。补一条测试：从 Worker 导入 `pdfjs-dist/legacy/build/pdf.mjs` 时解析不到 canvas，中文文字 PDF 仍能抽出预期字符。

#### I-2【云占位】1:1 重命名在探针之前读取文件

- **位置：**
  - [sync-engine.ts:708-720](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L708-L720)
  - [sync-engine.ts:546-557](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L546-L557)
  - [sync-engine.ts:1269-1281](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1269-L1281)
- **问题事实：** `prepareFile` 和 `rebuildIndex` 先 `probeCloud`，`dehydrated` 不调用 `extractFile`。`planReconcile` 在恰好一个删除、一个新增时，对新增路径调用 `pool.extractFile(..., { hashOnly: true })`，这一步会打开并读取文件。在线未水合的 OneDrive 文件被重命名时，`RECALL_ON_DATA_ACCESS` 会在探针之前触发下载。
- **为什么重要：** 规格 §6.1 要求云占位文件先看属性，脱水文件不读内容。重命名是对账的正常路径，不是异常路径。
- **修复建议：** 对这一对路径先探针。`dehydrated` 时不要 `extractFile`，按删除加 `cloud-placeholder-dehydrated` 处理。

#### I-3【暂停】写稳等待期间暂停，仍会做一次全量对账

- **位置：**
  - [sync-engine.ts:395-404](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L395-L404)
  - [sync-engine.ts:434-446](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L434-L446)
  - [sync-engine.ts:1090-1101](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1090-L1101)
- **问题事实：** 防抖任务只在 `waitForWriteStable` 之前检查 `watchPaused`。`pauseWatch` 先把 `watchPaused` 设为 true、把 `epoch` 加一，再等待 `runtime.chain`。等待函数看到暂停标志就返回，调用方接着 `enqueueReconcileNow`。这次对账读到的是暂停之后的新 epoch，不会被取消。`pauseWatch` 要等这次遍历和提取结束才返回。`disposed === true` 时同样缺少这次检查。
- **为什么重要：** 规格 §6.1 / D3 要求暂停排空在途读句柄、清空 `dirtyPaths`，并停掉周期与休眠自动对账后再返回。Windows 上暂停的目的就是放开源目录锁。现有测试在空闲时暂停，没有覆盖写稳等待中的暂停。
- **修复建议：** `waitForWriteStable` 返回后，若 `watchPaused` 或 `disposed` 已置位，直接返回，不要调用 `enqueueReconcileNow`。补一条测试：监听事件进入写稳等待后调用 `pauseWatch`，断言等待期间写入的文件没有进入 `listDocs`。

#### I-4【删库】休眠恢复的延迟定时器会在运行态移除后重新监听源目录

- **位置：**
  - [sync-engine.ts:1048-1058](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1048-L1058)
  - [sync-engine.ts:1412-1448](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1412-L1448)
  - [sync-engine.ts:460-471](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L460-L471)
  - [storage-db.ts:515-517](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L515-L517)
- **问题事实：** `handleSystemResume` 按库错峰 `setTimeout`，回调闭包持有 `Runtime`。`haltRuntime`（`remove` / `stopKb` 使用）把 Map 项删掉并关掉当前 Watcher，不取消这些定时器，也不把该对象标成已死。回调只检查 `watchPaused` 和引擎级 `disposed`。定时器触发后 `ensureWatcher` 对 `sourceDir` 再次 `fs.watch`，句柄留在已经脱离 Map 的对象上。随后对账的 `listDocs` 失败会把 phase 标成 `index-error`。再下一次对账里，`ensureStorageReady` 对 `index-error` 调用 `openKb`，`openKnowledgeDb` 对知识库目录 `mkdirSync`，把已经删掉的 `workspace-knowledge/<kbId>` 建回来。窗口是错峰延迟：最多约 20 个库、每库 25 ms。`dispose()` 会清掉尚未触发的定时器；`remove` 不会把引擎标成 disposed。
- **为什么重要：** 删库之后源目录上仍留着监听，Windows 上移动目录会再遇到文件锁。空目录复活后，下次启动若注册表已无该条，这个目录成为孤儿；若注册表写失败与 I-10 叠加，启动会把它当成空库打开。
- **修复建议：** `run` 开头要求 `runtimes.get(runtime.record.id) === runtime`。`haltRuntime` 清掉该库的错峰定时器，或让定时器捕获一个代际号。`dispose` 也要关掉已经不在 Map 里、但仍被回调持有的 Watcher。

#### I-5【路径】`realpath` 之后不再拒绝 UNC

- **位置：** [paths.ts:32-34](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L32-L34)、[paths.ts:130-165](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L130-L165)
- **问题事实：** `isUncOrDevicePath` 只匹配原始字符串的 `\\` 或 `//` 前缀。`validateSourceDirInner` 在这个检查之后调用 `realpath`，成功则返回 `{ ok: true, realSourceDir }`，不再检查规范化路径。本地 junction 指向 `\\server\share\docs` 时，校验会绑定该目录。`realpath` / `stat` 在到达拒绝逻辑之前就可能访问该共享。注册表测试只断言辅助函数，没有把 UNC 字符串交给 `validateSourceDir`。
- **为什么重要：** D11 拒绝 UNC 和设备路径，是为了避免协商凭据。直接输入 UNC 已经被拒绝；绕过方式是本地 junction 或符号链接。
- **修复建议：** 先 `lstat`。若是符号链接或 junction，`readlink` 到 UNC / 设备目标就拒绝，不要先 `realpath`。`realpath` 成功后再拒绝 `\\server\...`、`//server/...`、`\\?\UNC\...`、`\\.\...`。libuv 返回的本地 `\\?\C:\...` 前缀只剥这一层，普通 Windows 目录仍可绑定。补一条目录链接指向 UNC 目标时 `{ ok: false }` 的测试，以及 `validateSourceDir({ sourceDir: '\\\\server\\share\\docs' })` 的直接用例。

#### I-6【路径】注册表保存的是调用方路径，重叠检查在符号链接消失后失效

- **位置：**
  - [paths.ts:108-114](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L108-L114)
  - [host.ts:341-348](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L341-L348)
  - [host.ts:384-396](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L384-L396)
- **问题事实：** `validateSourceDir` 返回 `realSourceDir`，重叠判断在源路径仍存在时使用 `realpath`。`createInner` 把 `input.sourceDir` 写入记录，重绑同样持久化调用方传入的 `newSourceDir`。`canonicalizePath` 在 `realpath` 抛错时退回 `resolve()`。`/tmp/link` → `/data/docs` 这个链接被删除后，登记路径不再指向旧目标，`/data/docs/nested` 不会再被判为重叠。
- **为什么重要：** 规格 §5.2 拒绝嵌套知识库源目录。这条规则依赖登记路径在链接消失后仍然指向同一目录。
- **修复建议：** 创建和重绑都持久化 `validation.realSourceDir`。补一条测试：先经符号链接绑定，删除链接，再拒绝旧目标的子目录。

#### I-7【文件上限】对账保留超限已入库文件，重建把它们丢掉

- **位置：**
  - [sync-engine.ts:657-668](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L657-L668)
  - [sync-engine.ts:1244-1245](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1244-L1245)
  - [storage-db.ts:1261-1273](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1261-L1273)
- **问题事实：** 接受循环 `accepted.length < maxFilesPerKb` 保留 2000 个文件，本身没有 off-by-one。已入库但落在本轮窗口之外的文件进入 `retained`，不进入 `deletes`。这是 `06e128db31` 的行为。`rebuildIndex` 只把 `walked.files.slice(0, maxFilesPerKb)` 送进空的暂存库。快照里有、这次没有 upsert、且仍有 Wiki 卡片的路径会被写成 `organize_tombstones`，文档本身不在新库里。遍历顺序是目录内排序加广度优先，掉出窗口的是稳定树里排序靠后的文件，不是「磁盘上已消失的文件」。
- **为什么重要：** 一次重建会撤销「超限但仍保留已入库文档」的修复，并给仍在磁盘上的文件写墓碑。
- **修复建议：** 把仍在磁盘上、只是超出上限的路径以保留行写入暂存库，或让提交方区分「跳过」和「删除」。继续写 `file_skipped` / `max-files-exceeded` 事件。

#### I-8【切片读取】请求的 ordinal 不在窗口内时仍返回 `ok`

- **位置：** [storage-db.ts:883-891](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L883-L891)
- **问题事实：** 查询是 `ordinal >= start LIMIT window`。零行才返回 `chunk-missing`。只要有任意一行就返回 `status: 'ok'`，不检查 `targetOrdinal` 是否在结果里。窗口为 3 时，请求 `last + 1` 的起点是最后一个真实切片，于是把邻居当成成功结果。指纹在 `sha256` 未变、或调用方没传指纹时发现不了这件事。
- **为什么重要：** 规格 §9.1 规定缺失切片是 `chunk-missing`，不能用相邻切片顶上。`KnowledgeHost.getChunk` 已是 M1-1 对 M1-3 的公开契约。
- **修复建议：** 选出的行里没有 `ordinal === targetOrdinal` 时返回 `chunk-missing`。目标存在时，邻居仍可留在 `chunks` 里。

#### I-9【Wiki 重置】先删 pending，再清 `wiki.stale`；两棵目录都在时不挪走现有 `wiki/`

- **位置：**
  - [storage-db.ts:396-407](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L396-L407)
  - [storage-db.ts:485-489](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L485-L489)
- **问题事实：** `performWikiReset` 仅在 `wiki/` 存在且 `wiki.stale` 不存在时才 `rename`。然后创建空 `wiki/`、删除 `wiki-reset.pending`，最后才 `clearWikiStale`。若上次重置留下了 `wiki.stale`，这次又看到一个仍有内容的 `wiki/`，函数会跳过 rename、删掉 pending，再只删除旧的 stale 树。有内容的 `wiki/` 留下，新索引已经换了 `doc_id`，`wiki-reset-pending` 门闩却没了。`clearWikiStale` 若在 pending 已删之后抛错，函数返回 false，调用方仍报告 `wikiResetPending: true`，磁盘上的 pending 已经不在。`recoverKnowledgeDbDir` 在已提交分支于 `performWikiReset` 之后再调 `clearWikiStale`；这里的抛错会让 `openKnowledgeDb` 返回 `index-error`，健康的 `index.sqlite` 因此打不开。
- **为什么重要：** D17 要求损坏重建在 Wiki 重置完成前禁止读写失配旧卡片，并允许启动续做。pending 比目录挪动先消失时，这个门闩失效。Windows 上锁住的 `wiki.stale` 还会把好库标成 `index-error`。
- **修复建议：** `wiki/` 非空时，即使 `wiki.stale` 已存在，也先挪走或替换残留 stale，再把 `wiki/` 挪到 stale。空的 `wiki/` 落盘之后才删除 `wiki-reset.pending`。此后删除 `wiki.stale` 的失败只记日志，不要再报 pending，也不要因此把打开结果改成 `index-error`。

#### I-10【删库】注册表写失败后无法重试，下次启动会建出空库

- **位置：** [host.ts:458-486](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L458-L486)
- **问题事实：** 顺序本身符合计划：先 `rm` 中立目录，再从内存删除记录，然后 `persistRegistry()`。原子写若抛错，中立目录已经没了，内存记录也已经删了，`finally` 会清掉 `deletingIds`。再次 `remove` 在 `requireRecord` 得到 `knowledge-base-not-found`。磁盘上的 `knowledge-bases.json` 仍有该条。下次 `start()` 经 `startKb` → `openKb` 为它创建一个空库。`update` 的写失败会把内存记录放回去，`remove` 没有对应恢复。
- **为什么重要：** 调用方看到的是一次失败的删除，索引已经丢了，注册表条目还会以空库回来。
- **修复建议：** 写注册表之前保留记录快照。`persistRegistry` 失败时把记录放回内存再抛错，让 `rm`（`force`）加持久化可以重试。只在持久化成功后清除 `deletingIds`，或在这条失败路径上恢复门闩与记录。

#### I-11【提取失败】Worker 崩溃被当成可重试，超时才会落成错误行

- **位置：**
  - [extraction-pool.ts:294](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-pool.ts#L294)
  - [sync-engine.ts:536-543](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L536-L543)
- **问题事实：** 超时会 `terminate()` 并返回 `extract-timeout`，下一个任务可以新建 Worker，池不会死。`'error'` / `'exit'` 把在途任务收成 `worker-crashed`，之后也允许新 Worker。`classifyFailure` 把 `worker-crashed` 标成 `retryable`，不写错误行；`extract-timeout` 走 `record-error`，size 与 mtime 不变时不再重试。一个每次都把 Worker 打崩的文件（堆上限、canvas 加载后的原生故障）会在每次对账里再抽一次。
- **为什么重要：** 规格 §10 要求 Worker 超时或崩溃后该文件记 `extract-timeout`，SQLite 不受影响。现在崩溃路径既不记这个结果，也不会停。
- **修复建议：** 在途任务因 Worker 崩溃而结束时，与 `extract-timeout` 使用同一落库策略：写入错误行，并在 size / mtime 不变时不要每轮重试。池本身继续为下一个文件新建 Worker。

#### I-12【重建快照】正常重建不复制已有、且文档行已不在的墓碑

- **位置：** [storage-db.ts:1110-1119](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1110-L1119)、[storage-db.ts:1261-1273](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1261-L1273)
- **问题事实：** `readRebuildSnapshot` 只读 `documents`。`insertVanishedTombstones` 只为「快照里有、新源里没有 upsert、且带 Wiki 卡片」的路径插入墓碑。删除时已经写入、对应文档行已经不在的 `organize_tombstones` 不会进暂存库。
- **为什么重要：** 规格 §6.4 要求正常重建保留 `wiki/`。D7 只允许按墓碑删除 `docs/<docId>.md`。这些卡片在重建后失去墓碑，M1-2 整理无法删掉它们。
- **修复建议：** 把现有 `organize_tombstones` 抄进暂存库，除非该 `doc_id` 这次又被插入。仍在 `documents` 里、新源中消失的行继续走现有插入逻辑。

#### I-13【事件】`probe-unavailable` 的 info 在大批同步里被折叠掉，重建路径不写

- **位置：**
  - [sync-engine.ts:559-567](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L559-L567)
  - [sync-engine.ts:919-934](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L919-L934)
  - [sync-engine.ts:1269-1281](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts#L1269-L1281)
- **问题事实：** 探针模块只返回状态。`prepareFile` 在 `probe-unavailable` 时向 `report.infoEvents` 推一条 `cloud_probe_unavailable` / `info`。`flushReport` 在 `changeCount > 5` 时只写一条汇总，不写 `infoEvents`。macOS 上每次探针都是 `probe-unavailable`，6 个以上文件的启动同步会丢掉这条例规要求的 info。现有测试索引 3 个文件，所以仍会写到。`rebuildIndex` 对 `probe-unavailable` 按普通文件入库，只特殊处理 `dehydrated`，不写这条事件。
- **为什么重要：** 规格 §11.1(3) 要求云占位属性不可读时按普通文件入库，并记一条 info。折叠阈值把库级通知和逐文件 info 放在了同一个数组里。
- **修复建议：** 这一条 info 始终追加，包括重建，并且不受 `> 5` 折叠影响。逐文件变更仍按现有规则折叠。

---

### Minor（建议处置，不阻塞）

#### M-1【事件上限】只剩一条时不再按 512 KB 截断

[events.ts:115](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/events.ts#L115) 对 `relPath` 只做 `maskSecrets`。[events.ts:192-206](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/events.ts#L192-L206) 在只剩一行时停止丢弃，即使 `totalBytes > EVENT_MAX_BYTES`。注释假定单条记录必然低于文件上限。普通文件系统路径低于 512 KB；调用方若把很长的字符串放进 `relPath`，文件会超过上限。对 `relPath` 使用同一套 UTF-8 截断，或在单行仍超限时继续截断。

#### M-2【测试】脱敏只断言返回值

[knowledge-events.spec.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-events.spec.ts) 检查 `appendKnowledgeEvent` 的返回对象，文件侧检查行数、字节和模式。今天写入的就是这个对象。应再断言 `events.jsonl` 不含密钥原文，并把 token 放在截断边界上，迫使测试覆盖「先脱敏再按 UTF-8 截断」。

#### M-3【测试】注册表失败路径和大小写探测没有被锁住

[registry.ts:83-118](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/registry.ts#L83-L118) 实现了缺文件返回 `[]`、丢掉坏 `kbId`、畸形记录旁仍保留合法记录。这些分支没有断言。Darwin / Windows 上 `probeCaseSensitiveDir` 的测试只要求 `typeof === 'boolean'`，一个按 `process.platform === 'linux'` 返回的桩也能通过无副作用检查。

#### M-4【路径比较】`toLowerCase()` 跟随进程 locale

[paths.ts:146](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L146) 在大小写不敏感卷上用 `toLowerCase()`。土耳其语等 locale 里 `I` / `i` 的折叠与 ASCII 不同。路径比较用 ASCII 折叠即可。

#### M-5【PDF 夹具】自带 ToUnicode，CMap 路径配错时中文断言仍能过

[pdf-fixture.ts:93-103](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/pdf-fixture.ts#L93-L103) 的字体声明了 `/Encoding /UniGB-UCS2-H`，同时嵌入了对象 7 的 ToUnicode CMap。pdfjs 抽文字可以使用这条流，于是 `cMapUrl` 错误、`UniGB-UCS2-H.bcmap` 从未被读时，中文断言仍可能通过。补一份 Unicode 映射只存在于预定义 CMap 的样本。

#### M-6【测试】`activeWorkerCount()` 在线程退出前就变成 0

[extraction-pool.ts:467](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-pool.ts#L467) 把 `activeWorkerCount` 定义成 `slots.size`。[extraction-pool.ts:256-259](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-pool.ts#L256-L259) 的 `killSlot` 在 `terminate()` 时就从 `slots` 删除，退出 Promise 尚未完成。忙等退场测试里 `activeWorkerCount() === 0` 不能证明 CPU 线程已经退出。`abortAndDrainKb` 会等待 terminate Promise；忙等测试应断言这次等待。

#### M-7【检索上限】单库 FTS 候选池的上限用了列表上限 200

[storage-db.ts:820](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L820) 的缺省值是 `SEARCH_FTS_DEFAULT_LIMIT`（60），钳制上限却是 `LIST_DOCS_MAX_LIMIT`（200，定义在 [storage-db.ts:71-73](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L71-L73)）。规格 §7.2 的单库池是进入重排前的 Top 60。把最大值钳在 60。

#### M-8【退场预算】`dispose` 在预算耗尽后仍等待 `terminate()`

[storage-client.ts:274-294](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-client.ts#L274-L294) 先让 shutdown 与定时器竞速，然后无条件 `await current.terminate()`。调用可以长于 `budgetMs`。计划里的存储退场测试期望小于 900 ms，现有断言放宽到 1000 ms。应在截止点让 shutdown 与 `terminate()` 竞速，并按 900 ms 预算断言。

#### M-9【重绑】校验完成前就占用 `maintainingIds`

[host.ts:377-396](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L377-L396) 在 `validateSourceDir` 返回失败时不关旧 Watcher、不写注册表、不动索引。并发 `sync` 仍会在这次 `stat` 结束前得到 `knowledge-base-busy`。校验成功后再设维护闩。

#### M-10【过程】实施计划还不在这个分支的提交里

Task 1–7 的计划与计划评审目前是工作区未跟踪文件：`docs/superpowers/plans/2026-11-25-knowledge-base-m1-1-registry-indexing.md` 与 `docs/superpowers/plans/2026-11-25-knowledge-base-m1-1-plan-review.md`。本轮对照的就是这两份工作区文本。它们不在 `209d9f1835..8e92b6319b` 里，后续读者无法只从分支提交复现对照基准。应与修复一起提交，或单独作为文档提交。

---

## 四、修复顺序

1. **C-1、C-2。** 先让维护锁覆盖引擎内部对账，并让提交前失败在还原未完成时保留 `.bak` 与 `.rebuild`。这两条不修，其余索引契约在长重建、休眠和磁盘重命名失败时不成立。
2. **I-1。** 让 canvas 在开发态也解析失败，保留安装包排除和中文 PDF 提取测试。
3. **I-2、I-3、I-4、I-7、I-13。** 都在 `sync-engine.ts`，适合一次改完监听、暂停、探针和上限。
4. **I-5、I-6、I-8、I-9、I-10、I-11、I-12。** 路径、切片窗口、Wiki 门闩、删库重试、崩溃落库和墓碑复制。每条都要有一条会在旧实现上失败的测试。
5. Minor 可跟在对应文件的修复里顺手做。M-10 不要拖到分支合入之后。

---

## 五、首轮结论（`8e92b6319b`）

**Ready to merge?** 否

注册表、物理隔离、安全只读链、防炸弹 OOXML、FTS5、删库不碰源目录、1 秒并行退场，以及 `powerMonitor` → Host 的窄桥接，都已经按 M1-1 计划和规格 v2.5 落地。当时不能合入，是因为重建可以和周期对账、休眠恢复交错，而提交前回滚的失败路径会拆掉唯一的未提交标记，并可能新建空库。安装包里的 `@napi-rs/canvas` 排除可以保留；开发态还要让 Extraction Worker 解析不到这个原生模块。

当前判定以 §六 为准。

---

## 六、修复复核与复跑（2026-11-26，`619e37329e`）

修复提交相对首轮 `HEAD` 改了知识库实现、对应测试，以及 M1-1 计划、计划评审和本文档。主审按 §三 的条目读了修复后的源码，并在沙箱外复跑门禁。完整 `corepack yarn check` 没有与其他 `verify:aa` 同时跑。

### 六.1 首轮条目闭环

| 项 | 结论 |
| --- | --- |
| C-1 | 闭环。拿到维护锁后立刻 `runtime.maintaining = true`，重建主体进入 `runtime.chain`。周期对账、休眠恢复和防抖都看 `canRunBackgroundSync`。`knowledge-sync-engine.spec.ts` 在提取卡住时调用周期定时器与 `handleSystemResume`，断言活库上没有 `upsertDocument` / `deleteDocument`。 |
| C-2 | 闭环。Step 2 与 `.bak` 还原双失败时保留 `.bak` 和 `.rebuild`。主文件缺失时 `openCommittedKnowledgeDb` 不新建空库。下次 `openKnowledgeDb` 先还原 `.bak`。`knowledge-storage.spec.ts` 用真实文件覆盖这条路径，并断言旧切片仍能检索。 |
| I-1 | 闭环。`blockOptionalCanvasAddon()` 用 `module.registerHooks` 让 `@napi-rs/canvas` 解析失败。编译后的 `extraction-worker.js` 在加载时调用它。pdf.js 接住失败并继续抽文字。安装包排除保留。 |
| I-2 | 闭环。1:1 重命名在 `extractFile({ hashOnly: true })` 之前先 `probeCloud`，`dehydrated` 不打开文件。 |
| I-3 | 闭环。写稳等待返回后若已暂停、维护、删库或退场，不再 `enqueueReconcileNow`。 |
| I-4 | 闭环。`haltRuntime` 置 `stopped`、移出 Map，并取消该库的错峰定时器。回调再检查 `canRunBackgroundSync`。 |
| I-5 | 闭环。`readlink` 在 `realpath` 之前拒绝 UNC / 设备目标；规范化结果再查一次。直接 UNC 字符串仍拒绝。 |
| I-6 | 闭环。创建和重绑持久化 `validation.realSourceDir`。删除原符号链接后，旧目标的子目录仍被判重叠。 |
| I-7 | 闭环。重建把已入库且仍在磁盘上、但排在 2000 之外的文件写入暂存库，不把它们当成消失文件写墓碑。 |
| I-8 | 闭环。窗口里没有目标 `ordinal` 时返回 `chunk-missing`。 |
| I-9 | 闭环。非空 `wiki/` 在 `wiki.stale` 已存在时仍先挪走；空 `wiki/` 落盘后才删 `wiki-reset.pending`。`clearWikiStale` 的删除失败不再把健康索引报成 `index-error`。 |
| I-10 | 闭环。`persistRegistry` 失败时把内存中的库记录放回，再次 `remove` 可以重试。 |
| I-11 | 闭环。`worker-crashed` 与 `extract-timeout` 一样落成错误行，size / mtime 不变时不每轮重试。`inode-replaced` 仍可重试。 |
| I-12 | 闭环。正常重建把旧库已有、且本次没有重新插入的 `organize_tombstones` 抄进暂存库。损坏恢复不抄旧墓碑。 |
| I-13 | 闭环。`cloud_probe_unavailable` 走 `systemEvents`，不受 `> 5` 折叠影响。重建也写这一条 info。 |
| M-1、M-2 | 闭环。`relPath` 与 `summary` / `detail` 一样先 `maskSecrets` 再按 UTF-8 截断。测试断言 `events.jsonl` 不含密钥原文，并覆盖截断边界。 |
| M-3 | 闭环。损坏注册表会隔离后再返回；大小写探测与真实卷语义对照，不再只断言 `typeof === 'boolean'`。 |
| M-5 | 闭环。样本不再内联 `/ToUnicode`。编译后的 `packaged-runtime-smoke.js` 字体对象只有 `/Encoding /UniGB-UCS2-H`。 |
| M-7 | 闭环。单库 FTS 上限钳在 60。 |
| M-8 | 闭环。`dispose` 在剩余预算内等待 `terminate()`，预算耗尽后不再阻塞。 |
| M-9 | 闭环。重绑的 `validateSourceDir` 在占 `maintainingIds` 之前执行。校验期间注册表有变时，加锁后重查一次。 |
| M-10 | 闭环。计划与计划评审已随 `619e37329e` 提交。 |

仍开着：

- **M-4** 大小写不敏感路径比较仍用 `toLowerCase()`，跟随进程 locale（[paths.ts:206](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L206)）。
- **M-6** `activeWorkerCount()` 仍是 `slots.size`。`terminate()` 时槽位先被删掉，忙等测试还不能证明线程已经退出（[extraction-pool.ts:467](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-pool.ts#L467)）。

符号链接链超过 16 跳时，`realpath` 之前的 UNC 预检会停下来。规范化结果仍拒绝 UNC，所以直接绑定共享这条路还是关着的。这只影响「预检本身不要去碰共享」。

### 六.2 测试与 `fs.watch`

知识库 6 个测试文件共 67 项。在命令沙箱里 65 项通过，2 项生命周期断言 `isWatchingForTest === true` 失败。脱离沙箱后这两项通过。

失败原因不是产品把监听关掉。沙箱里 `ulimit -n` 为 1048575，普通 `open` 可以连续打开 64 个描述符，但 `fs.watch`（含非递归）立刻收到 `EMFILE: too many open files, watch`。`ensureWatcher` 先拿到 Watcher，`'error'` 到来后 `onWatcherError` 关掉句柄，测试因此看到「没在监听」。同一调用在沙箱外可以建立监听。

桌面进程不走这层命令沙箱。若用户机器上的 `fs.watch` 真的失败，现有降级是关掉 Watcher、阶段记为 `watch-failed`，实时防抖停止，周期对账和手动同步继续。

### 六.3 门禁复跑

| 命令 | 结果 |
| --- | --- |
| `corepack yarn check` | **EXIT=1**，约 1.7 秒。停在 `scripts/check-whitespace.mjs`。`git diff --check` 指向 [2026-11-25-knowledge-base-m1-1-registry-indexing.md:11-13](./2026-11-25-knowledge-base-m1-1-registry-indexing.md) 的行尾空格（Markdown 硬换行）。各包 typecheck、测试和 `verify:aa` 都没有开始。 |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **EXIT=0**。五个 tsconfig，含 `registerHooks` 的导入。根上 `yarn check` 里其他包的 typecheck 没有跑到。 |
| `corepack yarn workspace dsh-plugin-huaanwork build` | **EXIT=0**。产物时间是 2026-11-26 10:24。 |

Electron `afterPack` 的打包冒烟不在 `yarn check` 里，它要求从带 `app/` 或 `app.asar` 的安装包根启动。复跑改为直接拉起这次 build 写出的 `lib/huaanwork-host/knowledge/extraction-worker.js`，提取无 `/ToUnicode` 的中文 CID PDF：

- Worker 握手 `{ ready: true }`。
- 结果 `ok: true`，`status: indexed`。
- 抽出「产品合规说明书：本产品遵循基金销售适当性管理办法与信息披露要求。」
- Worker 标准错误为：`Cannot load "@napi-rs/canvas" package: "Error: @napi-rs/canvas is disabled in knowledge extraction (@napi-rs/canvas)"`。pdf.js 接住后继续做文字提取。

这证明编译进安装包的那份 Worker 里，`registerHooks` 仍然生效，而且预定义 CMap 能解码这份没有内联 ToUnicode 的 PDF。它不是一次完整的安装包打包。

### 六.4 当前结论

**Ready to merge?** 代码评审里的 Critical 与 Important 可以合入。完整 `corepack yarn check` 还要先去掉计划文档第 11–13 行的行尾空格，再单独重跑。M-4 与 M-6 不阻塞这条门禁。

---

## 七、qwen4 审核（2026-11-26，`c1f6a972b3`）

- **审核者标注：** qwen4。
- **审阅目标：** `HEAD = c1f6a972b37409046eccff55c39c3d0ce6e3533c`（`fix(knowledge): resolve all M1-1 pre-merge review findings (C-1..C-5, I-1..I-11, M-1..M-6)`），共同基线仍为 `master` `209d9f1835`。这是分支最后一个提交，`+3627 / -879`、几乎改了所有核心文件，**此前从未被独立复核**；§六 只复核到 `619e37329e`。本轮首要任务就是验证这轮大改是否真正闭环、是否引入新问题。
- **方法：** 两路 general-purpose 评审子代理分工读码——①存储 / 同步 / 生命周期 / 注册 / 桥接面，②提取 / 检索 / 打包 / 依赖面——逐条核对 §三 全部 20 条旧发现；主审对两个 Important 候选独立读码反证，并对标题正则实测计时。全程只读，未改任何源码。
- **编号说明：** `c1f6a972b3` 提交信息里的编号（C-1..C-5 / I-1..I-11 / M-1..M-6）与本文档 §三 编号（C-1..C-2 / I-1..I-13 / M-1..M-10）不一致，说明修复方参照过另一份未落盘评审。**本轮以当前 HEAD 代码实际状态为准**，不依赖任何文档结论。

### 七.1 旧发现闭环（20 / 20，含 §六 仍开着的 M-4 / M-6）

两路评审在 `c1f6a972b3` 逐条读码 + 核对测试，§三 的 C-1、C-2、I-1..I-13、M-1..M-10 **全部闭环**，绝大多数有真实文件系统 / 并发测试锁住。相对 §六 的状态变化：

| 项 | §六 状态 | 本轮 | 关键证据 |
| --- | --- | --- | --- |
| M-4 大小写折叠 locale | 仍开着 | **闭环** | [paths.ts:33-35](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts#L33-L35) `foldAsciiPath` 只折叠 ASCII、长度保持；`knowledge-registry.spec.ts` 含 `İ` 反例 |
| M-6 `activeWorkerCount` 语义 | 仍开着 | **闭环** | [extraction-pool.ts:552](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-pool.ts#L552) 改用 `liveWorkers.size`，[:347](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-pool.ts#L347) 仅 `exit` 删除，`killSlot` 等 `exit` + `terminate` 双 Promise；`knowledge-lifecycle.spec.ts` 断言 `terminateSettled === true` |
| C-1 维护锁 / C-2 双失败回滚 | 闭环 | **仍闭环** | 重建主体进 `runtime.chain`、周期 / 休眠 / 防抖都认 `canRunBackgroundSync`；C-2 回归走真实 WAL 字节快照，双失败 / 半还原 / 提交后损坏矩阵覆盖扎实 |

### 七.2 门禁复跑（本轮实跑，非转贴旧结论）

| 命令 | 结果 |
| --- | --- |
| `corepack yarn check`（沙箱外，未与其他 `verify:aa` 并发） | **EXIT=0**，全链跑完：空白检查（§六 卡住的行尾空格已修）、各包 typecheck、华安插件 build / test / `verify:*`（含 `verify:aa`）、其余各包 check |
| 华安插件 Vitest | **336 个测试文件通过 / 4 跳过（340）**；4 跳过均为 Windows / live-market 既有平台门控，非知识库 |
| `knowledge-lifecycle.spec.ts` | **15 项全过**；§六 记录的沙箱 `fs.watch` EMFILE 导致的 2 项失败本轮未复现 |

**边界（诚实记录）：** 这是本地无头门禁。`afterPack` 安装包冒烟不在 `yarn check` 里，本轮**没有重打真实安装包**；分支**无 PR，也就没有 PR CI 证据**。按仓库口径，真机 / 安装包验收仍是合并后发布前的人工项，CI 绿 ≠ 真机。

### 七.3 新发现（`c1f6a972b3` 引入或残留）

#### Important（合并前修，改动很小）

**N-1【数据丢失】已提交分支可能把旧库 WAL 嫁接到新主库，静默回滚刚提交的重建。**

- **位置：**
  - [storage-db.ts:567](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L567)（已提交分支无条件调 `restoreBackupToMain`）
  - [storage-db.ts:495-498](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L495-L498)（「主库在、主库无 `-wal`、`.bak-wal` 在」时把旧 WAL 搬成 `index.sqlite-wal`）
  - [storage-worker.ts:237-241](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-worker.ts#L237-L241)（旧连接 `checkpoint` 失败被吞）
  - [storage-db.ts:1594](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1594)（Step 2 提交点）、[:1635](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1635)（提交后 `removeBackups`）
- **问题事实（触发链已逐环读码证实）：** 旧 live 连接 `checkpoint` 失败被吞（损坏 / 被锁旧库恰是重建的常见入口）→ Step 1 留下 `.bak-wal` → Step 2 `rename` 提交成功后、`removeBackups` 之前崩溃（或清扫失败残留后再崩溃）→ 重启时新库尚未建 `-wal`，`recoverKnowledgeDbDir` 走已提交分支仍调 `restoreBackupToMain`，命中 495-498 把旧 WAL 嫁接到新主库。SQLite 按文件名认 WAL、只校页大小与帧校验和，旧帧会回放到新库上，**违反 D17「提交后绝不回滚」**。C-2 的回归（`knowledge-storage.spec.ts`）只锁了带 `.rebuild` 的未提交分支，这条已提交路径无测试。
- **为什么重要：** 规格 §6.4 / D17 要求提交点之后绝不回滚新库。这条路径会在窄崩溃矩阵下把刚提交的重建静默回滚成旧索引。
- **修复建议：** 半还原 WAL 分支只在 `.rebuild` 存在（未提交）时执行；已提交分支对 `.bak*` 只清扫不嫁接。补一条「已提交 + 残留 `.bak-wal`」的真实文件回归。一行门控 + 一条测试的量级。
- **严重度校准：** 后果够 Critical 档（损坏已提交索引），但触发需「`checkpoint` 失败 + 提交后特定窗口崩溃」双重巧合，比 §三 C-2 窄得多，按本文档口径定 **Important**。**若 owner 对「提交后回滚」零容忍，可升格为必须修复的 Critical——由 owner 拍板。**

#### Minor（6 条，不阻塞，可顺手修或登记债务）

1. **【ReDoS 残留】标题正则二次回溯。** [text.ts:423](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/text.ts#L423) 的 `/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u` 对 `"# " + "#"×N + "a"` 为 O(N²)。主审实测 10k / 20k / 40k 个 `#` 耗时 **105 / 422 / 1654 ms**，确为二次。影响被 60s Worker 超时兜住，只落 `extract-timeout` 错误行，不挂宿主、不损坏数据。改 `/^\s{0,3}(#{1,6})\s+(.*)$/u` 后代码线性剥尾部 `#` / 空白，并补该形状回归。（降级理由见 §七.4）
2. **【删库】create 双失败孤儿注册项。** [host.ts:392-401](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L392-L401)：首次 `persistRegistry` 成功、`startKb` 失败、回滚 `persistRegistry` 再失败被吞时，磁盘留记录而内存 / 中立目录已删，下次启动建出同名空库。需两次写盘失败夹一次启动失败，极窄；建议回滚写失败时告警或留待启动对账。
3. **【删库】remove 提交后 `removalHook` 抛错语义。** [host.ts:574-576](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L574-L576)：删库已落盘成功后 hook 抛错使 `remove()` 整体 reject，重试却得 `not-found`。M1-3 注入前无实际触发；建议 hook 失败降级为事件告警，或在契约注明「提交后错误」。
4. **【PDF】预算检查顺序。** [pdf-text.ts:230-237](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/pdf-text.ts#L230-L237)：needs-vision 页 `continue` 先于预算检查，预算耗尽后仍解析剩余空白 / 扫描页，只靠 60s 超时兜底，也不置 `truncated`。建议预算检查移到 `continue` 之前。
5. **【诊断】safe-read 跳过原因失真。** [safe-read.ts:525-526](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/safe-read.ts#L525-L526)（及 548-549）：目录数上限 `MAX_WALKED_DIRS` 跳过被标成 `symlink-loop`，诊断误导，建议独立 reason。
6. **【测试判别力】canvas require-throw 断言位置。** I-1 的 `require` 抛错断言在测试进程而非 Worker 线程内执行；打包路径已由冒烟泄漏扫描 + 编译 Worker 中文断言间接覆盖，可接受，建议后续在 Worker 内直接断言一次。

### 七.4 校准说明（独立反证）

- **标题正则：Important → Minor。** 子代理②原报 Important，称违反计划「线性扫描消除 ReDoS」契约。主审反证：`grep` 计划 / 规格 / 计划评审均无此明文契约，现有 ReDoS 回归（`knowledge-extractors.spec.ts:298-310`）只锁 HTML 未闭合标签形状，不覆盖 Markdown 标题；且影响被 Worker 超时兜住，无宿主挂起 / 数据损坏。按本文档「Important = 规格 / 计划写明行为未实现」口径，契约依据不成立，降为 **Minor**（实测二次确凿，修复量级一行，建议随 N-1 顺手修）。
- **N-1 维持 Important 而非 Critical。** 见 §七.3 严重度校准：后果重但触发窄，保留 owner 升格选项。
- 其余 Minor 与子代理结论一致，主审已在所引行读到对应代码。

### 七.5 当前结论

**Ready to merge?** **With fixes / 有条件可合并。**

修掉 N-1（或经 owner 明确 waiver 登记债务）后即可合并。完整 `corepack yarn check` 本轮实跑 EXIT=0，20 条旧发现 + M-4 / M-6 全部实证闭环，代码面质量高。

**需 owner 拍板：**

1. **N-1 WAL 嫁接：** 合并前修（推荐，一行门控 + 一条回归），还是按窄触发接受 waiver 登记债务？是否升格 Critical？
2. **Minor 1（正则）与 4（PDF 预算）** 都是一行级改动，建议随 N-1 一起修；其余 4 条可登记债务表。
3. **工作区提交卫生：** 本评审稿有未提交修改（含本 §七），另有 M1-2 / M1-3 / M2-0 三份未跟踪计划文档属后续里程碑材料；合并时按提交卫生口径分诊，不擅自纳入。

---

## 八、qwen4 复核 Gemini 修复（2026-11-26，基于 `4678d57210` 的工作区改动）

- **审核者标注：** qwen4。
- **审阅目标：** Gemini 按 §七 意见做的修复，目前是**未提交工作区改动**（HEAD 仍为 §七 评审提交 `4678d57210`），共 9 个文件：5 源文件（`storage-db.ts` / `text.ts` / `host.ts` / `pdf-text.ts` / `safe-read.ts`）+ 4 测试（`generators.ts` / `knowledge-extractors.spec.ts` / `knowledge-lifecycle.spec.ts` / `knowledge-storage.spec.ts`），`+343 / -32`。覆盖 §七 全部 7 条（N-1 + Minor 1–6）。
- **方法：** 逐条独立读码反证（不只看提交说明）；对头条 N-1 做**非破坏性红绿对照**——在 `/tmp` 建指向修复前提交 `4678d57210` 的临时 worktree、拷入新回归运行；并在主工作区实跑 typecheck、知识库测试与完整门禁。临时 worktree 已清理，Gemini 的工作区改动全程未触碰。

### 八.1 逐条闭环（7 / 7）

| 项 | 结论 | 修法与证据 |
| --- | --- | --- |
| **N-1**（Important）WAL 嫁接 | **闭环** | `restoreBackupToMain` 加 `allowHalfRestoredWal` 门控（[storage-db.ts:487](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L487)、[:501](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L501)）：已提交分支不传该标志→禁用嫁接，未提交分支（[:562](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L562)）与提交前回滚（[:1528](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1528)）仍允许；Step 1（[:1519](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1519)）与 `beginRebuildStaging`（[:1396](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts#L1396)）加过期 `.bak*` 清扫。回归用真实 WAL 字节断言新数据在 / 旧数据零 / `.bak*` 清扫（`knowledge-storage.spec.ts` N-1 段）。**红绿对照见 §八.2。** |
| **Minor 1** 标题正则二次 | **闭环** | 改线性 `parseMarkdownHeading`（[text.ts:344](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/text.ts#L344)、[:445](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/text.ts#L445)），按 CommonMark 剥闭合 `#`、保留 `# C#`。回归断言 `#`×40000 耗时 <500ms（[knowledge-extractors.spec.ts:388](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-extractors.spec.ts#L388)）；旧正则实测 ≈1654ms 必失败。 |
| **Minor 2** create 孤儿注册项 | **闭环** | 重排为「先 `startKb` 再在串行写槽内原子登记 + 落盘，失败仅回滚内存」（`commitRegistryChange`，[host.ts:242](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L242)），消除二次写盘回滚失败面。真实 `chmod` 落盘失败回归断言磁盘零孤儿（`knowledge-lifecycle.spec.ts`）。比 §七 建议更彻底。 |
| **Minor 3** removalHook 提交后抛错 | **闭环** | 降为提交后 best-effort 告警（[host.ts:604](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts#L604)），`remove()` 不再伪失败。hook 抛错回归断言 resolves + 告警 + 库已删（`knowledge-lifecycle.spec.ts`）。 |
| **Minor 4** PDF 预算检查顺序 | **闭环** | 预算检查提到循环顶部早停（[pdf-text.ts:223](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/pdf-text.ts#L223)）。多页 PDF 回归断言精确用尽后 `parsedPages:1` / `text-truncated`，不误标 `partial-needs-vision`（[knowledge-extractors.spec.ts:403](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-extractors.spec.ts#L403)）。 |
| **Minor 5** skip 原因失真 | **闭环** | 拆出独立 `max-dirs-exceeded`（[safe-read.ts:85](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/safe-read.ts#L85)、[:537](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/knowledge/safe-read.ts#L537)），并加 `maxWalkedDirs` 测试注入。目录上限回归断言报 `max-dirs-exceeded` 而非 `symlink-loop`（[knowledge-extractors.spec.ts:511](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-extractors.spec.ts#L511)）。 |
| **Minor 6** canvas 断言位置 | **闭环** | 在真实 Extraction Worker 线程内断言 canvas 拦截 + 中文提取（[knowledge-extractors.spec.ts:268](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-extractors.spec.ts#L268)），不再只在 Vitest 主进程。 |

### 八.2 红绿对照与门禁实跑

| 验证 | 结果 |
| --- | --- |
| **N-1 红**（修复前 worktree `4678d57210` + 新回归） | **RED_EXIT=1**，1 failed / 13 passed。失败断言：`searchFts('新提交权威')` 期望 1 条得 **0**——旧代码嫁接旧 WAL 把已提交新库回滚，正是 N-1 现象。证明回归有区分力。 |
| **N-1 绿 / 知识库测试**（主工作区修复后） | **EXIT=0**，7 文件 / **85 项全过**（含 7 条新回归）。 |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **EXIT=0**（5 个 tsconfig）。 |
| `corepack yarn check`（完整门禁，沙箱外、未与其他 `verify:aa` 并发） | **EXIT=0**，全链跑完；华安插件 **336 文件 / 4901 项通过**（4 文件 / 15 项跳过为既有 Windows / live-market 平台门控），无真实失败。 |

### 八.3 当前结论

**Ready to merge?** **是 / 可合并。**

§七 的 N-1（Important）与 6 条 Minor 全部闭环，红绿对照 + 完整门禁实证，修复未引入新问题（Minor 2/3 的修法比原建议更彻底）。代码面 0 Critical / 0 Important / 0 Minor 开着。

**剩余边界（非代码阻塞，合并后发布前人工项）：** 真机 / 真实安装包验收（`afterPack` 冒烟不在 `yarn check` 内，本轮未重打安装包）；分支无 PR、无 PR CI 证据。按仓库口径 CI 绿 ≠ 真机。

**提交卫生：** Gemini 的 9 个修复文件目前未提交；本 §八 亦为未提交修改。M1-2 / M1-3 / M2-0 三份未跟踪计划文档仍排除在外。需要提交 / 推送 / 开 PR 时按显式范围执行。
