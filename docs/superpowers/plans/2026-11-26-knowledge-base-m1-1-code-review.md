# 知识库 M1-1（`feat/knowledge-base-m1-1-registry-indexing`）Code Review

- **日期：** 2026-11-26
- **审阅目标：** 分支 `feat/knowledge-base-m1-1-registry-indexing`
  - 共同基线（`master`）：`209d9f18353f433a3bca82206d1e7dea3e4c64f8`
  - 分支 `HEAD`：`8e92b6319b7e1e3b66b3ffa35cd82b739cd0b964`（相对 `master` 共 12 个提交、47 个文件，`11576 insertions(+), 10 deletions(-)`）
  - 上游子模块 `deepseek-harness`：`1600d8a1e140dcde43a1a0941940a0480712c011`（本范围无修改）
- **对照依据：**
  - 设计规格：[2026-11-24-knowledge-base-design.md](../specs/2026-11-24-knowledge-base-design.md)（v2.5；本轮只核 M1-1 对应的 §5.2、§5.3、§6.1、§6.2、§6.4、§7.1、§7.2、§10、§11.1 中属于注册/提取/索引/监听/重绑/重建/删库/打包冒烟的条目，以及 D2、D3、D4、D5、D6、D11、D12、D17）
  - 规格评审：[2026-11-24-knowledge-base-design-review.md](../specs/2026-11-24-knowledge-base-design-review.md)（§10–§17）
  - 实施计划：[2026-11-25-knowledge-base-m1-1-registry-indexing.md](./2026-11-25-knowledge-base-m1-1-registry-indexing.md)（Task 1–Task 7 与 Global Constraints）
  - 计划评审：[2026-11-25-knowledge-base-m1-1-plan-review.md](./2026-11-25-knowledge-base-m1-1-plan-review.md)
- **范围外（不记为缺失）：** M1-2 整理槽、M1-3 路由与界面与引用、向量运行时、视觉转写、旧版 Office。`ROUTE_TABLE` 保持不改是 M1-1 的要求。
- **验证边界：** 只读审阅。四路初审分别覆盖注册与事件、提取安全、存储与 FTS、同步与生命周期；主审对全部 Critical 与 Important 按当前工作区源码逐条复核。本轮**没有**重跑 `corepack yarn check`。
- **最终判定：** **Request changes / 不能合并（2 Critical / 13 Important / 10 Minor）。** 注册、隔离、只读提取、FTS、删库、1 秒退场和 `powerMonitor` 桥接与计划和规格一致。重建与周期/休眠对账没有同一把维护锁，提交前回滚失败会拆掉恢复标记并可能新建空库。这两处会在维护过程中丢数据或写乱索引，须先修再合。

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

## 五、结论

**Ready to merge?** 否

注册表、物理隔离、安全只读链、防炸弹 OOXML、FTS5、删库不碰源目录、1 秒并行退场，以及 `powerMonitor` → Host 的窄桥接，都已经按 M1-1 计划和规格 v2.5 落地。当前不能合入，是因为重建可以和周期对账、休眠恢复交错，而提交前回滚的失败路径会拆掉唯一的未提交标记，并可能新建空库。安装包里的 `@napi-rs/canvas` 排除可以保留；开发态还要让 Extraction Worker 解析不到这个原生模块。
