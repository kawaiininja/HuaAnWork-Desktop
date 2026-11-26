# 《知识库 M1-1（注册表、隔离、双 Worker 提取与 SQLite FTS5 索引）》实施计划评审意见（Plan Review）

- **评审对象**：[`docs/superpowers/plans/2026-11-25-knowledge-base-m1-1-registry-indexing.md`](./2026-11-25-knowledge-base-m1-1-registry-indexing.md)（首轮 546 行；第二轮复核全文 **1,805 行**；第三轮仍针对这 1,805 行，未改计划）
- **对照基准**：
  - 设计规格：[`docs/superpowers/specs/2026-11-24-knowledge-base-design.md`](../specs/2026-11-24-knowledge-base-design.md)（v2.5，六轮规格评审 M1 已批准）
  - 规格评审：[`docs/superpowers/specs/2026-11-24-knowledge-base-design-review.md`](../specs/2026-11-24-knowledge-base-design-review.md)（§10–§17）
  - 仓内质量基准：[`docs/superpowers/plans/2026-11-22-expert-team-plan-review.md`](./2026-11-22-expert-team-plan-review.md) 与 `superpowers:writing-plans`（规格全量覆盖、可执行失败测试、跨任务/跨里程碑类型契约一致、源码实证无漂移）
  - 代码基线：外层仓库 `209d9f1835`；上游子模块 `deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`；运行环境 Node `v22.23.2`（`dsh-plugin-huaanwork/node_modules/@types/node@22.20.1` 已自带 `sqlite.d.ts`）
- **评审日期**：2026-11-25
- **评审视角**：三路独立视角交叉核实（① **Skeptic / 源码反证与实现可行性**；② **安全 / 隔离 / 依赖与打包门禁**；③ **规格全量合规与跨里程碑对接**）。
- **首轮结论（针对 546 行初稿）**：**未达到可直接实施的质量基准（NO-GO / ITERATE）**。原始计数：阻断 6，同轮应补 6，不阻断 4；经 §6 反证校准后：**阻断 5，同轮应补 7，不阻断 4**；**0** 项要求推翻总体架构。
- **第二轮复审结论（针对修订后 1,805 行，见 §7）**：**当时判定已达到可直接实施的质量基准（GO）**。校准后的全部 12 项复审入口、2 项反证补抓与第二轮复核新发现的 6 项测试区分力缺口（`R2-1`～`R2-6`）均已闭环落入计划正文。该 GO 只覆盖 §5 入口，不是当前开工门禁。
- **第三轮独立复核结论（针对同一 1,805 行，见 §8，未改计划）**：**未达到可直接实施的质量基准（ITERATE）**。阻断 3，同轮应补 8，另有 1 项 Worker 默认值断言并入补测试、不单列；核对后降级或不成立 4。**0** 项要求推翻总体架构。当前开工门禁以 §8.4 为准。

严重度口径：

- **阻断（Blocker）**：照当前计划正文实施会引入安全绕过、构建/打包期路径失效、死代码或核心契约缺失，导致无法交付可用的 M1-1 或直接破坏 M1-2/M1-3 对接。
- **同轮应补（Important）**：规格已明确点名的行为、上限、打包约束或测试断言尚缺失或指错对象，实施时会依赖临场发挥。
- **不阻断（Minor / Nit）**：夹具细节、类型检查命令覆盖面或说明口径可顺手收紧，不影响主链路正确性。

---

## 1. 已对齐、可保留的部分

总体方案（Scheme A+，Host 内嵌 `knowledge/` + 单长期 Storage Worker + 1–2 并发受限堆 Extraction Worker 池）与仓内现有基线和规格 v2.5 核心架构约束核实成立，无需返工方向：

| 承重前提 | 仓内源码实证 | 结论 |
| --- | --- | --- |
| `writeFileAtomic` 支持 `{ mode: 0o600 }` | `dsh-plugin-huaanwork/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js` 通过 `writeFile(temp, content, { mode: options.mode, flag: 'wx' })` + `rename` 实现原子替换与权限收窄 | 成立 |
| `@types/node` 支持 `node:sqlite` | `dsh-plugin-huaanwork/node_modules/@types/node@22.20.1` 内含 `sqlite.d.ts`（注意：外层根 `node_modules` 不含，须在 `dsh-plugin-huaanwork` workspace 下 typecheck） | 成立 |
| `pdfjs-dist` 许可证（Apache-2.0）在允许名单内 | `dsh-plugin-huaanwork/scripts/verify-licenses.mjs:30-32` 的 `ALLOWED_LICENSES` 含 `'Apache-2.0'` | 成立（安装后仍须复验传递依赖） |
| `disableAsarArchiveView` 可供 Worker 复用 | `dsh-plugin-huaanwork/src/asar-archive-policy.ts:14-35` 零 Electron 运行时耦合，可直接作为 Worker 入口首条语句调用 | 成立 |
| `assertSafePathSegment` 与中立目录模式 | `dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts:52-105` 已导出 `assertSafePathSegment` 及三组 `neutral*BaseDir` | 成立 |
| 打包不启用 ASAR、`afterPack` 跑 `packaged-runtime-smoke.js` | `dsh-plugin-huaanwork/package.json:472,474`（`asar: false`）、`scripts/verify-packaged-runtime.ts:366` | 成立 |
| 路由表零触碰 | M1-1 保持 `ROUTE_TABLE` 为 92 条不变，把 16 条路由集中在 M1-3 一次性落盘并同步 4 处契约测试 | 成立 |

---

## 2. 阻断项（修订计划并复审通过后再开工）

### B-1 `adm-zip@0.6.0` 解压炸弹绕过：伪造 `header.size = 0` 会无上限 `inflateRawSync` 打爆 Worker

- **位置**：计划 Task 5 Step 4（L409）
- **规格**：§2.3（`MAX_ZIP_ENTRIES = 2,000`、`MAX_ZIP_ENTRY_BYTES = 20 MB`、`MAX_ZIP_TOTAL_BYTES = 50 MB`）、§6.2（L253「超限即 `skipped`，不把压缩炸弹展开进堆」）
- **源码反证**：检查仓内实际安装的 `dsh-plugin-huaanwork/node_modules/adm-zip/methods/inflater.js:4`：
  ```js
  const option = version >= 15 && expectedLength > 0 ? { maxOutputLength: expectedLength } : {};
  return zlib.inflateRawSync(inbuf, option);
  ```
- **后果**：计划写「用 `adm-zip` 读取条目清单，先累加 header 声明的 `size` 并在解压每条时实时按实际解压字节计数」。若实施者调用 `entry.getData()`，恶意或损坏 OOXML 只需将 Central Directory 的 `size` 伪造为 `0`（或极小值），`expectedLength > 0` 为 `false`，`adm-zip` 会**不传 `maxOutputLength`** 直接同步调用 `zlib.inflateRawSync`——1 MB 压缩炸弹会在调用方收到 Buffer 计数之前就把 256 MB 堆上限的 Extraction Worker 直接 OOM 打崩。
- **修订要求**：
  1. 明确**禁止**对不可信 OOXML 调用 `entry.getData()` / `getDataAsync()`。
  2. 仅使用 `adm-zip` 解析目录表（校验 `entries.length <= MAX_ZIP_ENTRIES`）；对需要读取的 XML 条目，只放行压缩方式 `0`（stored）和 `8`（deflate），通过 `entry.getCompressedData()` 取原始压缩流：
     - method `0`：直接检查 `raw.byteLength <= Math.min(MAX_ZIP_ENTRY_BYTES, remainingTotalBytes)`；
     - method `8`：调用 `node:zlib` 的 `inflateRawSync(raw, { maxOutputLength: Math.min(MAX_ZIP_ENTRY_BYTES, remainingTotalBytes) })`，捕获 `ERR_BUFFER_TOO_LARGE` 统一返回 `skipped: 'zip-limit-exceeded'`。
  3. 在 Task 5 Step 2 增加**伪造 `header.size = 0`（单条实际展开 > 20 MB）的 ZIP 炸弹**失败测试，断言安全返回 `skipped` 且不 OOM。

---

### B-2 Worker 入口路径解析在 Vitest `.ts` 与 `tsdown` 产物 / `packaged-runtime-smoke.js` 层级错位

- **位置**：计划 Task 4（L309）、Task 6（L441）、Task 7（L498、L527–530）
- **源码反证**：
  - 仓内唯一现有 Worker 先例 [`src/diagnostic-export.ts:40-43`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/diagnostic-export.ts#L40-L43) 使用 `new URL('./diagnostic-export-worker.' + ext, import.meta.url)`，之所以有效是因为调用方 `lib/diagnostic-export.js` 与 Worker `lib/diagnostic-export-worker.js` 同处 `lib/` 深度 1。
  - 而在 M1-1 中，`storage-client.ts` 与 `extraction-pool.ts` 位于 `src/huaanwork-host/knowledge/`（深度 3）。经 [`tsdown.config.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tsdown.config.ts) 构建后，它们会被**内联到 `lib/huaanwork-host/index.js`**（深度 2），若被 `packaged-runtime-smoke.ts` 引用还会被**内联到 `lib/packaged-runtime-smoke.js`**（深度 1）；与此同时，两个 Worker 产物分别输出在 `lib/huaanwork-host/knowledge/{storage,extraction}-worker.js`（深度 3）。
  - 若客户端默认按 `new URL('./storage-worker.' + ext, import.meta.url)` 解析，Vitest 源码态下全部绿灯，一进 `corepack yarn build` 后的 `verify:host` / `packaged-runtime-smoke` 立刻 `ERR_MODULE_NOT_FOUND`。
  - 另须显式约束：Vitest 下直接 `new Worker(new URL('...ts'))` 依赖 Node `v22.23.2` 原生 type-stripping，因此两个 Worker 及其传递导入模块**禁止使用 `enum` / parameter properties / `namespace`**，且全部相对 import 须保留 `.ts` 扩展名（遵循现有 `tsconfig.json` `allowImportingTsExtensions`）。
- **修订要求**：
  1. 在 `src/huaanwork-host/knowledge/worker-paths.ts`（或 `paths.ts`）提供唯一的目录深度无关解析函数 `resolveKnowledgeWorkerUrl(kind: 'storage-worker' | 'extraction-worker')`：向上定位 `dsh-plugin-huaanwork/package.json`（或判断 `import.meta.url` 是否以 `.ts` 结尾），源码态解析 `<pkgRoot>/src/huaanwork-host/knowledge/<kind>.ts`，编译/打包态解析 `<pkgRoot>/lib/huaanwork-host/knowledge/<kind>.js`。
  2. 在 Task 7 增加针对编译产物 `lib/` 路径解析与真实拉起双 Worker 的验证，确保 `lib/huaanwork-host/index.js` 与 `lib/packaged-runtime-smoke.js` 两种深度下均可命中。

---

### B-3 Electron 主进程 `powerMonitor.on('resume')` 跨进程桥接与时钟跳变探针完全缺失

- **位置**：计划 Task 6（L448）、Task 7（L494–531）
- **规格**：§6.1（L238「`powerMonitor` 的 `resume` 与单调时钟大跳变用来对 `!watchPaused` 的库重建 Watcher、补对账，并让整理看门狗忽略这段时钟跳变」）、§10（L558）
- **源码反证**：
  - 全仓 `dsh-plugin-huaanwork/src/` 搜索 `powerMonitor` 为 **0 命中**。
  - Host 运行在独立子进程 [`src/host-process-entry.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/host-process-entry.ts)（`utilityProcess.fork`），进程内无法直接访问 Electron `powerMonitor`；仅有主进程 [`src/electron-runtime.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/electron-runtime.ts) 持有主进程 Electron API，并通过 [`src/host-runtime-bridge.ts`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/host-runtime-bridge.ts) 的 `HostRpc` 与窄接口模式（参照 `KeepAwakeRuntime` / `ArtifactNativeCapability`）向 Host 桥接。
- **后果**：Task 6 虽然写了 `syncEngine.handleSystemResume()`，但整个 M1-1（及后续 M1-2/M1-3）没有任何任务把主进程 `powerMonitor.on('resume')` 桥接到 Host，也没有定义 Host 侧墙钟 vs 单调时钟跳变检测器，`handleSystemResume()` 在生产桌面中永不触发，成为死代码。
- **修订要求**：
  1. 在 `host-runtime-bridge.ts` 增加窄可选扩展接口 `SystemResumeRuntime`（如 `onSystemResume?(listener: () => void): () => void`，不污染 `DesktopRuntime`，所有测试桩零改动），在 `electron-runtime.ts` 注册 `powerMonitor.on('resume', ...)` 并经 `HostRpc` 回调推送至 Host（随 `bindNativeRuntime.release` / disposer 释放监听）。
  2. 在 `sync-engine.ts` 同时内置 Host 侧低频墙钟 vs 单调时钟跳变检测（例如检测 `(Date.now() - lastWall) - (performance.now() - lastMono) > 30_000`），并向 M1-2 整理看门狗暴露 `onSystemResume` 回调（供其忽略睡眠时段）。
  3. 补两类测试：① `host-runtime-bridge.spec.ts` / `electron-runtime.spec.ts` 桥接与卸载测试；② `knowledge-sync-engine.spec.ts` 注入可控时钟，断言跳变后跳过 `watchPaused` 库、对活跃库重建 Watcher 并补对账。

---

### B-4 `cloud-placeholder.ts` 未指定 Win32 实现机制（仓内已有 `koffi` 先例）

- **位置**：计划 Task 6（L442）
- **规格**：§6.1（L241「对云盘占位文件先看属性……具体 Win32 / OneDrive 属性常量留待实施计划」）、§11.1(3)
- **源码反证**：
  - Node.js `node:fs` 的 `stat` / `lstat` 不暴露 Win32 `dwFileAttributes`。
  - 仓内已引入 `koffi@3.1.5`（[`package.json:402`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/package.json#L402)）并在 [`src/windows-volume-diagnostics.ts:57-83`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/windows-volume-diagnostics.ts#L57-L83) 通过 `createRequire(import.meta.url)('koffi')` 调用 `kernel32.dll`（且 `koffi` 已在 `scripts/verify-packaged-runtime.ts:84,97` 打包白名单中）。
- **后果**：计划仅列出三个十六进制常量，未写明读取手段。若实施者临场用 `powershell` / `attrib` 逐文件起子进程，2,000 份文件对账会严重超时；若直接恒返回 `'probe-unavailable'`，则 Windows OneDrive 占位保护被架空。
- **修订要求**：
  1. 明确在 Win32 下按 `windows-volume-diagnostics.ts` 同款模式惰性加载 `koffi`，绑定 `kernel32.dll` 的 `uint32 __stdcall GetFileAttributesW(str16)`（带缓存，不重复 `koffi.load`）。
  2. 返回 `0xFFFFFFFF`（`INVALID_FILE_ATTRIBUTES`）、加载异常或非 `win32` 平台统一返回 `'probe-unavailable'`；命中 `(attrs & (0x00400000 | 0x00040000 | 0x00001000)) !== 0` 返回 `'dehydrated'`；否则返回 `'local'`。
  3. 暴露可注入依赖缝 `readWin32Attributes?: (filePath: string) => number | undefined`，在 Task 6 测试中跨平台覆盖 `'local'` / `'dehydrated'`（跳过不读内容）/ `'probe-unavailable'`（按普通文件入库并写一条 `info` 级别事件）三态。

---

### B-5 `knowledgeHost.remove(kbId)`（`deletingIds` 删库全链路）在 M1-1 中彻底缺失

- **位置**：计划 Task 6（L473 仅顺带提及 `deletingIds`）、Task 7（L494–531 全无删库方法与测试）
- **规格**：§5.2(6)（L202）、§6.4（L272）、§10（L550「`deletingIds` 拒绝新工作，停 Watcher，取消整理，等 Storage Worker 交还该库连接，再删目录」）、§11.1(1)（L568「删库后源目录字节不变」）
- **后果**：M1-3 的 `knowledge.remove` 路由与「回合中删库」行为直接调用 `knowledgeHost.remove(kbId)`，且 Windows 上如果未先等 Storage Worker `closeDb(kbId)` 就删目录会直接 `EBUSY` 失败。当前 M1-1 没有定义 `remove(kbId)` 接口、执行序或任何删库回归测试。
- **修订要求**：
  1. 在 Task 7 `knowledge/host.ts` 显式定义 `remove(kbId)` 的精确顺序：
     `加入 deletingIds（与 maintainingIds 互斥）` → `停机序列（停 Watcher、清防抖、中止并等待 Extraction Worker 释放句柄、调用 M1-2 注入的 cancelOrganizerForKb 并 await）` → `await storageClient.closeDb(kbId)` → `rm(neutralKnowledgeRootPath(profileDir, kbId), { recursive: true, force: true })` → `原子更新 knowledge-bases.json 移除该条` → `调用 M1-3 注入的 onKbRemoved(kbId) 清理会话挂载` → `finally 移出 deletingIds`。
  2. 在 `tests/huaanwork-host/knowledge-lifecycle.spec.ts` 补两条失败测试：
     - 删库期间并发 `sync` / `rebuild` 被拒（`knowledge-base-busy` / `knowledge-base-deleting`），完成后 `workspace-knowledge/<kbId>/` 目录彻底消失、注册表已移除且无句柄残留；
     - 删库前后对 `sourceDir` 全量文件做路径与内容哈希快照比对，断言字节完全不变。

---

### B-6 未达到仓内 `writing-plans` 质量基准：Tasks 2–7 缺乏可执行失败测试代码与跨里程碑精确契约

- **位置**：计划 Task 2（L198–205）、Task 3（L250–257）、Task 4（L311–325）、Task 5（L387–397）、Task 6（L450–459）、Task 7（L503–513）
- **基准对照**：对照仓内通过标准 [`2026-11-22-expert-team-plan-review.md`](./2026-11-22-expert-team-plan-review.md) §3 `I-3` 与 `superpowers:writing-plans` 技能要求：核心规格行为必须写成**可直接执行的失败测试代码与精确 TypeScript 契约**，不得以 prose 列表代替。
- **缺口清单**：
  1. Tasks 2–6 的 Step 1 全部是中文要点列表，Task 7 仅有 6 行注释骨架，没有可执行断言和夹具构造；
  2. 缺少跨任务、跨里程碑（M1-2 / M1-3 直接消费）的精确契约定义：
     - `storage-protocol.ts` 完整的 `StorageWorkerRequest` / `StorageWorkerResponse` 判别联合及全部错误码枚举（`knowledge-base-busy`、`knowledge-base-not-found`、`wiki-reset-pending`、`index-error`、`knowledge-base-limit-reached`）；
     - `storage-db.ts` 逐字锁定规格 §7.1（L312–368）的 5 张表（`documents` 17 列、`organize_tombstones`、`chunks`、`chunks_fts`、`chunk_embeddings`）与 3 个索引 DDL；
     - `computeExtractConfigHash` 的精确规范序列化输入与版本常量（须含 `EXTRACTOR_PIPELINE_VERSION`、`visionEnabled: false`、`visionModelId: ''`、`MAX_VISION_PDF_PAGES = 50`）；
     - `KnowledgeHost` 供 M1-2 与 M1-3 消费的完整公开接口（包括 M1-2 需要的 `cancelOrganizerForKb` / `onSystemResume` / `onPendingOrganize` 钩子，以及 M1-3 需要的 `list` / `get` / `create` / `update` / `remove` / `sync` / `rebuild` / `search` / `listDocs` / `getChunk` / `getEvents` / `onKbRemoved` 钩子）。
- **修订要求**：为 Tasks 2–7 全部补全可运行的 Vitest 失败测试代码，并在 Task 1 / Task 4 / Task 7 钉死上述全部 TypeScript 契约与 DDL。

---

## 3. 同轮应补项（修订 B-1～B-6 时一并写入计划正文）

### I-1 Task 2 Checkpoint / 诊断包排除测试参数张冠李戴且缺少 `captureProfileCheckpoint` 行为测试

- **位置**：计划 Task 2 Step 1（L204）
- **源码反证**：
  - [`src/diagnostic-export.ts:95-142`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/diagnostic-export.ts#L95-L142) 的 `exportDiagnosticsZip(logsDir, userDataDir, options)` 接收的是 `logsDir` 与 `userDataDir`，**不接收 `profileDir`**；
  - 真正备份 `profileDir` 的是 [`src/profile-checkpoint.ts:57-61`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/profile-checkpoint.ts#L57-L61) 的 `captureProfileCheckpoint`。
- **修订**：拆为两条真实行为测试：① 在含 `workspace-knowledge/`、`knowledge-bases.json`、`session-knowledge.json`、`session-citations/` 的 `profileDir` 上实际执行 `captureProfileCheckpoint`（外加断言 `DESKTOP_PROFILE_CHECKPOINT_FILES` 白名单不含四者），验证快照落盘目录与 `manifest.json` 零包含四者；② 在含上述四项的 `userDataDir`（以及 `logsDir` 下）执行 `exportDesktopDiagnostics` / `exportDiagnosticsZip`，解压 zip 断言条目零命中。

### I-2 `pdfjs-dist` 打包态 `workerSrc` / `cMapUrl` 陷阱与 `verify-packaged-runtime` / `package.spec.ts` 同步

- **位置**：计划 Task 5（L410）、Task 7（L500、L530）
- **实证与风险**：
  1. `pdfjs-dist/legacy/build/pdf.mjs` 在 Node `worker_threads` + `tsdown` 打包态下，若不显式将 `GlobalWorkerOptions.workerSrc` 设为 `pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href`，容易触发 `Setting up fake worker failed`；`cMapUrl` 与 `standardFontDataUrl` 须基于 `dirname(require.resolve('pdfjs-dist/package.json'))` 构造并带尾部 `/`，且在 Task 5 Step 1 装包后实测确认当前版本的路径格式（本地路径 vs `file://` URL）和零 `@napi-rs/canvas` 传递依赖。
  2. 新增两个 Worker 入口（`lib/huaanwork-host/knowledge/{storage,extraction}-worker.js`）应同步在 [`tests/package.spec.ts:537-559`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/package.spec.ts#L537-L559) 与 [`tests/verify-packaged-runtime.spec.ts:685-711`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/verify-packaged-runtime.spec.ts#L685-L711) 补显式断言锁定（参照 `'diagnostic-export-worker'`）。
  3. `packaged-runtime-smoke.ts` 的 `smokeKnowledgeWorkers()` 须显式断言打包根内存在 `pdfjs-dist/cmaps/` 与 `standard_fonts/`，且对中文 CID PDF 样本提取出预期中文字符（非空且非乱码）。

### I-3 Task 1 `validateSourceDir` 与 `probeCaseSensitiveDir` 缺少关键边界与安全测试

- **位置**：计划 Task 1 Step 1（L87–135）、Step 3（L164–168）
- **规格**：§5.2(2)–(4)、§6.1（L240）、§11.1(1)
- **缺失用例**：
  1. 通过符号链接间接指向 `profileDir/sub` 或已有知识库目录（`symlink -> kbA/nested`）时，`validateSourceDir` 必须按 `realpath` 拒绝；
  2. `sourceDir` 作为已有知识库 `kbA` 的**祖先目录**（反向父子嵌套）时必须拒绝；
  3. `sourceDir` 与已注册项目目录相同或嵌套时必须**允许通过**（规格 §11.1(1) 明确点名）；
  4. `probeCaseSensitiveDir(dirPath)` 在整个路径不含 ASCII 字母（如纯中文目录名）时的退化逻辑（向上查找首个含 ASCII 字母的祖先段，仍无则按 `process.platform === 'linux'` 保守回退），并增加探测前后 `readdirSync(dir)` 对比断言「零写副作用」。

### I-4 规格硬上限（20 库 / 2,000 文件 / 50 MB / 10 MB 文本 / 50,000 切片）与 > 5 文件事件折叠缺少落点与测试

- **位置**：计划 Task 1（L163 仅列常量）、Task 2、Task 4（L302）、Task 5、Task 6
- **规格**：§2.3、§6.1（L242）、§8.3（L440）
- **缺口**：
  1. 创建第 21 个库被拒（`MAX_KNOWLEDGE_BASES = 20`）；
  2. 单库文件超过 `MAX_FILES_PER_KB = 2,000` 时，超出部分标 `skipped`（`max-files-exceeded`）并记一条超限汇总告警，前 2,000 份照常入库；
  3. 单文件 > `MAX_FILE_BYTES`（50 MB）在 `handle.stat` 与流读阶段即中止关闭句柄并标 `skipped`（测试可用可注入 `maxBytes` 覆盖）；
  4. 单文档提取正文超 `MAX_DOC_TEXT_BYTES`（10 MB）截断并标 `partial`（测试可用可注入上限覆盖）；
  5. 单库累计切片超 `MAX_CHUNKS_PER_KB`（50,000）时在 `upsertDocumentWithChunks` 明确返回受限态（不破坏已有事务）；
  6. 单次同步批变更 > 5 个文件时，折叠为 1 条 `sync_completed` 汇总事件而非逐条灌满 500 行 `events.jsonl`（少量变更 ≤ 5 与错误仍逐条记录）。

### I-5 Task 4 遗漏四项规格点名的存储与查询语义

- **位置**：计划 Task 4（L300–325）
- **规格**：§6.1（L240）、§6.4(2)（L287–288）、§7.2（L380）、§11.1(4)
- **缺口**：
  1. **`stale` 与 `sourceUnavailable` 实时 `stat` 判定**：规格 §7.2（L380）要求 `search` / `getChunk` 返回前对命中的少量源文件做 `stat`，`size`/`mtimeMs` 与索引不一致置 `stale: true`；源目录不可用置 `sourceUnavailable: true` 并仍返回已索引片段。须明确落点（如在 `host.ts` 查询门面层对 Storage 返回的少量结果做异步 `stat` 补齐）并补失败测试；
  2. **正常重建核验盘上 `wiki/docs/<docId>.md` 存在且非空常规文件**：规格 §6.4(2)（L287）要求正常重建仅当 `sha256 === snapshot.organized_sha256` **且** `wiki/docs/<docId>.md` 是盘上有效非空常规文件（非符号链接）时才沿用 `organized_sha256`，否则置 `null`。须补「`sha256` 相同但卡片已删/为空/符号链接 → `organized_sha256 = null`」测试；
  3. **启动遇损坏 `index.sqlite` 优雅降级为 `index-error`**：打开旧库报 `SQLITE_CORRUPT` 或 `PRAGMA quick_check` 非 `ok` 时，Storage Worker 与 Host 不得崩溃，须将该库标记为 `index-error` 并保持 `knowledge.rebuild` 可进入损坏恢复重建分支；补测试；
  4. **仅大小写重命名与 `norm_path` 非唯一**：在大小写不敏感卷上 `Readme.md` → `README.md` 走 1 对 1 重命名复用 `doc_id`；在大小写敏感卷上两者作为两个独立文档共存（验证 `norm_path` 无 `UNIQUE` 约束）。补测试。

### I-6 Task 6 重绑 `sha256` 短路 & Task 7 零库惰性启动 Worker + `session-sweep` 生产接线验证

- **位置**：计划 Task 6（L446、L458）、Task 7（L499、L513、L525）
- **规格**：§6.4(1)（L277）、§5.2（L195）
- **缺口**：
  1. **重绑未变内容 `sha256` 短路**：Windows 跨盘移动/复制源目录会改变 `mtime_ms`。规格 §6.4(1)（L277）要求同 `rel_path` 且 `mtime_ms` 变化时，先算 `sha256`，若 `sha256` 与 `extract_config_hash` 均一致则仅更新 `(mtime_ms, size)` 并短路——不重切、不清空向量与 `organized_sha256`。须在 Task 6 写明该分支并补「改 `mtimeMs` 后重绑 → `chunks` 与 `organized_sha256` 零重跑」测试；
  2. **零库启动惰性拉起 Worker**：现有 `verify:profile`、`verify:loader`、`verify:host`、`verify:expert-team` 均会启动 `huaanwork-host` 且 `knowledge-bases.json` 为空。`KnowledgeHost` 须明确 **Storage Worker 与 Extraction Worker 池均为惰性创建**（0 库启动不拉起任何 Worker 线程，`dispose()` 零开销），避免拖慢全部既有 Host 门禁与无库用户启动；
  3. **`session-sweep` 生产接线验证**：Task 7 L513 仅测直接调用 `sweepProjectLegacySessionsOncePerProcess`；由于 [`session-sweep.ts:208`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/session-sweep.ts#L208) 有进程级 `Symbol.for` 门闩，测试应区分两层：① 测 `sweepProjectLegacySessions` 排除 `neutralKnowledgeBaseDir`；② 参照 `tests/huaanwork-host/session-sweep.spec.ts` 测 `huaanwork-host/index.ts` 真实 `apply()` 确实把 `neutralKnowledgeBaseDir(config.profileDir)` 传入了 `protectedRoots`。

---

## 4. 不阻断项（Nit，同轮修订顺手清理）

- **N-1（Task 1 L118–120 夹具不自洽）**：`writeKnowledgeBases` 测试传了 `sourceDir: profileDir`（该路径恰是被 `validateSourceDir` 禁止的路径），建议改为合法独立目录 `join(root, 'valid-docs')`。
- **N-2（Task 3 分词策略相对 §7.2 措辞的显式说明）**：规格 §7.2（L375）写「连续汉字：单字同时发 unigram；两字及以上发 bigram」，计划 Task 3（L253/268）对长度 ≥ 2 的汉字串同时发射全部 unigram 与相邻 bigram。该增强是满足 §11.1(4)「单字查多字词」（如查「税」命中「税率」）的必要条件，建议在计划中显式注明该理由并说明单库 50,000 切片上限下索引膨胀可控。
- **N-3（Tasks 1–6 类型检查命令遗漏 `tsconfig.tests.json`）**：[`dsh-plugin-huaanwork/tsconfig.tests.json`](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tsconfig.tests.json) 继承了 `exactOptionalPropertyTypes: true` 与 `noUncheckedIndexedAccess: true` 且纳入 `tests/huaanwork-host/**/*.ts`。建议 Tasks 1–6 的 Step 4 统一改为 `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json --noEmit`，避免测试类型错误积压到 Task 7 的 `corepack yarn check` 才集中爆发。
- **N-4（Task 2 `events.ts` 17 种事件与 `info` 级别事件完备映射）**：规格 §8.3（L439）列出 17 种事件，§6.1（L229/L241）还涉及 `watch-failed` 与云占位探针不可用的 `info` 事件。建议在 `KnowledgeEventRecord` 增加 `level: 'info' | 'warn' | 'error'` 字段并给出全部事件种类到 `all / alerts / organize / sync` 四枚筛选胶囊的完备映射表（含 `watch_failed`、`cloud_probe_unavailable` 或复用到明确类别），避免有事件掉出筛选或类型收窄报错。

---

## 5. 复审准入清单（M1-1 从 `NO-GO / ITERATE` 转为 `GO` 的唯一入口）

修订 `2026-11-25-knowledge-base-m1-1-registry-indexing.md` 后，仅针对以下 12 项逐条核验：

1. **B-1**：OOXML 禁止调用 `entry.getData()`，改用 `entry.getCompressedData()` + `zlib.inflateRawSync(..., { maxOutputLength })` 强制硬限，并有**伪造 `header.size = 0` 的压缩炸弹**失败测试。
2. **B-2**：定义目录深度无关的 `resolveKnowledgeWorkerUrl`（区分源码 `.ts` 与 `lib/huaanwork-host/knowledge/*.js`），注明 Worker 模块遵守 Node 原生 type-stripping 约束，并有编译产物 `lib/` 启动双 Worker 的验证。
3. **B-3**：补齐 `electron-runtime.ts`（`powerMonitor.on('resume')`）→ `host-runtime-bridge.ts`（窄接口 `SystemResumeRuntime`）→ `knowledgeHost.handleSystemResume()` 跨进程桥接，及 Host 侧墙钟/单调时钟跳变探针与测试。
4. **B-4**：`cloud-placeholder.ts` 明确采用 `koffi` + `kernel32.dll` `GetFileAttributesW`（带可注入探针缝）并覆盖 `'local' | 'dehydrated' | 'probe-unavailable'` 三态测试。
5. **B-5**：Task 7 完整定义 `knowledgeHost.remove(kbId)`（`deletingIds` 互斥 → 停机序列 → `closeDb` → 删隔离目录 → 原子更新注册表 → `onKbRemoved` 钩子）及「删库并发拒绝」与「`sourceDir` 字节不变」失败测试。
6. **B-6**：Tasks 2–7 均补齐可直接运行的 Vitest 失败测试代码；钉死 `StorageWorkerRequest/Response`、SQLite 5 表 DDL、`computeExtractConfigHash` 与 `KnowledgeHost` 供 M1-2/M1-3 消费的完整 TypeScript 接口。
7. **I-1**：Task 2 同时覆盖真实 `captureProfileCheckpoint`（针对 `profileDir`）与 `exportDesktopDiagnostics` / `exportDiagnosticsZip`（针对 `userDataDir` / `logsDir`）两条行为排除测试。
8. **I-2**：Task 5/7 钉死 `pdfjs-dist` 的 `GlobalWorkerOptions.workerSrc`、`cMapUrl`、`standardFontDataUrl` 解析方式、打包根 `cmaps/` 断言，以及 `package.spec.ts` / `verify-packaged-runtime.spec.ts` 新 Worker 入口锁定。
9. **I-3**：Task 1 补齐符号链接绕过 `validateSourceDir`、祖先嵌套拒绝、允许与项目目录重叠、以及无 ASCII 路径下 `probeCaseSensitiveDir` 退化与零写副作用断言。
10. **I-4**：补齐 20 库 / 2,000 文件 / 50 MB 文件 / 10 MB 文本 / 50,000 切片上限与 > 5 文件 `sync_completed` 折叠汇总规则及测试。
11. **I-5**：补齐 `stale`/`sourceUnavailable` 命中文件 `stat`、正常重建核验盘上 `wiki/docs/<docId>.md`、启动损坏 DB 优雅降级 `index-error`，以及仅大小写重命名 + `norm_path` 非唯一测试。
12. **I-6**：补齐重绑 `mtime_ms` 变化但 `sha256` 未变时的短路逻辑与测试、0 库启动惰性创建 Worker 约束，以及 `huaanwork-host/index.ts` 对 `session-sweep` `protectedRoots` 生产接线验证（并顺手清理 N-1～N-4）。

上述 12 项全部闭环后，M1-1 计划结论转为 **GO**，可启动实施（或继续对 M1-2 / M1-3 计划做同等标准的评审）。


---

## 6. 首轮评审项反证校准（排查误报与夸大）

在修订 M1-1 之前，对 §2–§4 的全部 16 条首轮评审项逐一做源码反证，识别出 **1 项定级夸大、1 项函数名笔误、1 项打包红线过度渲染**，同时额外补抓 **2 项源码级硬约束**：

| 原项 | 校准判定 | 校准后口径与源码反证 |
| --- | --- | --- |
| **B-4**（`cloud-placeholder.ts` 未指定 `koffi`） | **定级偏重 → 降级为同轮应补（I-7）** | 规格 §6.1 仅要求计划给出 Win32 常量（初稿已写全三个十六进制常量），初稿未写出错误代码，只是未钉死 Win32 读取手段（留给实施者发挥）。经查 [`windows-volume-diagnostics.ts:59-61`](../../../dsh-plugin-huaanwork/src/windows-volume-diagnostics.ts#L59-L61) 精确 `koffi` 签名为 `kernel32.func('uint32 __stdcall GetFileAttributesW(str16)')`，降级为同轮应补并钉死 |
| **I-1**（Checkpoint 函数名） | **实质成立，评审自身笔误** | 首轮评审误写导出名为 `captureProfileCheckpoint`；实查 [`profile-checkpoint.ts:570,878`](../../../dsh-plugin-huaanwork/src/profile-checkpoint.ts#L878) 真实导出为 `createDesktopProfileCheckpoint(options).captureHealthy()`。`exportDiagnosticsZip` 确不收 `profileDir`，实质问题成立，修正函数名 |
| **I-2**（`pdfjs-dist` 打包红线与 `verify-packaged-runtime`） | **部分夸大 → 收紧口径** | 实查 [`verify-packaged-runtime.ts:824-848`](../../../dsh-plugin-huaanwork/scripts/verify-packaged-runtime.ts#L824-L848)：① 本仓 `asar: false`，`hasAsar === false` 时 `verifySelectiveUnpackedRuntime` 的 `1,500 files / 128 MiB` 门禁并不走硬失败（仅打印 `summarizeUnpackedRuntime`）；② `!hasAsar` 时 `listDesktopRuntimeEntries(lib)` 已自动包含所有 `lib/**/*.js`。真正必须钉死的是 `pdfjs-dist` 的 `GlobalWorkerOptions.workerSrc` / `cMapUrl` / `standardFontDataUrl`、`packaged-runtime-smoke.ts` 的 `cmaps/` + 中文 CID PDF 实测，以及 `tests/package.spec.ts` 显式锁定两个新 Worker 入口 |
| **B-1**（`adm-zip` 炸弹绕过） | **真实成立 + 补抓加密条目** | 实查 [`adm-zip/zipEntry.js:71,102,280`](../../../dsh-plugin-huaanwork/node_modules/adm-zip/zipEntry.js#L280) 与 [`inflater.js:4`](../../../dsh-plugin-huaanwork/node_modules/adm-zip/methods/inflater.js#L4)：`entry.getCompressedData()` 确存在、`expectedLength === 0` 确无上限；额外发现 `entry.header.encrypted` 须显式拦截返回 `skipped: 'encrypted'` |
| **B-2**（Worker 路径深度错位） | **真实成立（实测更强）** | 实查 `dsh-plugin-huaanwork/lib/` 证实 `tsdown` 会把共享模块拆成深度 1 的 `lib/<name>-<hash>.js` chunk，或内联到深度 2 的 `lib/huaanwork-host/index.js`，与深度 3 的 Worker 产物必然错位 |
| **B-3**（`powerMonitor` 桥接缺失） | **真实成立 + 补抓 2 处 Electron mock 单测** | 全仓 `powerMonitor` 为 0 命中，且 M1-2/M1-3 计划均未涉及 `powerMonitor`/`handleSystemResume`。额外实测发现 [`tests/electron-runtime.spec.ts:413`](../../../dsh-plugin-huaanwork/tests/electron-runtime.spec.ts#L413) 与 [`tests/desktop-browser-access.spec.ts:316`](../../../dsh-plugin-huaanwork/tests/desktop-browser-access.spec.ts#L316) 对 `'electron'` 做了显式 `vi.mock`，`electron-runtime.ts` 导入 `powerMonitor` 必须同步更新这两处 mock，否则 `corepack yarn test` 立刻失败 |
| **B-5 / B-6 / I-3～I-6 / N-1～N-4** | **全部真实成立** | 逐项核实无误报、无夸大，全量按校准口径落入修订稿 |

校准后计数：**阻断 5**（`B-1`, `B-2`, `B-3`, `B-5`, `B-6`），**同轮应补 7**（`I-1`–`I-6` + 原 `B-4` 降级 `I-7`），**不阻断 4**（`N-1`–`N-4`）。

---

## 7. 第二轮独立复核（修订稿 1,805 行，GO）

按校准后的全部 12 条入口及 2 项反证补抓，逐行复核修订后的 [`2026-11-25-knowledge-base-m1-1-registry-indexing.md`](./2026-11-25-knowledge-base-m1-1-registry-indexing.md)（546 行 → 1,805 行）。

### 7.1 第二轮复核中额外捕获并已即时修复的 6 项测试区分力缺口（`R2-1`～`R2-6`）

第二轮初读修订稿时，发现 6 处「测试标题/注释宣称已测，但断言代码弱或漏写」的问题（与专家团三轮评审同类），已当轮直接补强入修订稿：

1. **`R2-1`**：Task 7 `remove(kbId)` 测试原用立即 resolve 的 `cancelSpy`，未真正测删库进行中拒绝并发 `sync`/`rebuild` → 已改为 deferred gate 暂停 `cancelSpy`，并发调用 `host.sync`/`host.rebuild` 断言抛 `knowledge-base-(?:deleting|busy)`（L1651–1675）。
2. **`R2-2`**：Task 7 1 秒退场测试原用 250ms/150ms 短延迟 mock → 已改为真实 CPU 死循环 `new Worker('while (true) {}', { eval: true })` + 永不 resolve 的 `pool.dispose`，断言 `workerTerminated === true` 且总耗时 `< 1_000 ms`（同时把生产兜底收紧为 `storageClient.dispose(800)` + 950 ms 外层竞态，避免 CI 计时器抖动假失败）（L1723–1754、L1776）。
3. **`R2-3`**：Task 4 Step 1 崩溃恢复测试原未制造未 checkpoint 的 `.bak-wal` 数据 → 已改为 `PRAGMA wal_autocheckpoint = 0` 写入后快照 `index.sqlite` + `index.sqlite-wal` 到 `.bak` / `.bak-wal` 再删主库，强制验证 WAL 伴随恢复（L951–987）。
4. **`R2-4`**：Task 6 重命名测试原未真正断言重复内容不误认重命名及大小写不敏感卷仅大小写重命名 → 已补 `dup1/dup2 -> dup3/dup4` 不复用旧 `docId` 与 `setCaseSensitiveForTest('kb-1', false)` 下 `a-renamed.md -> A-RENAMED.md` 复用 `docId` 断言（L1411–1440）。
5. **`R2-5`**：Task 7 `stale` / `sourceUnavailable` 测试原仅调用 `host.search` 未断言 `host.getChunk` → 已补全 `host.getChunk` 在修改盘文件与删源目录后的 `stale: true` / `sourceUnavailable: true` 断言（L1697–1720）。
6. **`R2-6`**：Task 4 补齐「Step 2 提交后重开失败绝不回滚 `.bak` 且返回 `index-error`」可执行测试（`afterCommitBeforeReopenForTest` 缝，L1007–1028）。

### 7.2 校准项闭环核验表

| 编号 | 校准后级别 | 闭环状态 | 修订稿落点（精确行号） |
| --- | --- | --- | --- |
| **B-1**（`adm-zip` 炸弹绕过 + 加密条目） | 阻断 | **CLOSED** | Task 5 L1229–1236（伪造 `header.size = 0` 炸弹 + 加密 ZIP 测试）、L1262–1271（禁调 `getData()`，走 `getCompressedData()` + `inflateRawSync({ maxOutputLength })` + `entry.header.encrypted`） |
| **B-2**（Worker 深度无关路径 + type-stripping） | 阻断 | **CLOSED** | Global Constraints L30–31；Task 1 `worker-paths.ts` L175、L278–290（深度 1/2/3 测试）、L320–321；Task 4 L1073；Task 6 L1502；Task 7 L1789 |
| **B-3**（`powerMonitor` 桥接 + 时钟跳变 + 2 处 Electron mock） | 阻断 | **CLOSED** | Task 6 L1284、L1456–1462、L1510（时钟跳变 + `onSystemResume`）；Task 7 L1534–1538（Files 含两处 `vi.mock('electron')` 单测）、L1760、L1778–1783 |
| **B-5**（`knowledgeHost.remove` 全链路） | 阻断 | **CLOSED** | Task 7 L1573、L1590–1597（7 步顺序）、L1640–1679（并发拒绝 + 取消整理 + 关 DB + 删隔离目录 + `sourceDir` 哈希零变动） |
| **B-6**（Tasks 2–7 可执行测试 + 跨里程碑契约） | 阻断 | **CLOSED** | Task 1 `types.ts` L65–174；Task 2 L366–482；Task 3 L538–634；Task 4 `storage-protocol.ts` + 5 表 DDL + 测试 L679–1055；Task 5 `computeExtractConfigHash` + 测试 L1112–1248；Task 6 L1323–1488；Task 7 `KnowledgeHost` + 测试 L1567–1761 |
| **I-1**（真实 checkpoint + diagnostics 排除） | 同轮应补 | **CLOSED** | Task 2 L381–384、L455–480（`createDesktopProfileCheckpoint(...).captureHealthy()` 测 `profileDir` + `exportDesktopDiagnostics` 测 `userDataDir`/`logs`） |
| **I-2**（`pdfjs-dist` `workerSrc`/`cMapUrl` + smoke + `package.spec.ts`） | 同轮应补 | **CLOSED** | Task 5 L1085–1092、L1273–1277；Task 7 L1540、L1761、L1787–1789（断言打包根 `cmaps/` + 中文 CID PDF 检索命中） |
| **I-3**（Task 1 符号链接/祖先/项目重叠/无 ASCII 大小写探测） | 同轮应补 | **CLOSED** | Task 1 L205–242、L264–276、L323–325 |
| **I-4**（20 库 / 2,000 文件 / 50 MB / 10 MB / 50,000 切片 / > 5 折叠） | 同轮应补 | **CLOSED** | Task 1 L66–77；Task 3 L569–590；Task 4 L873–886；Task 5 L1168–1169、L1278；Task 6 L1441–1446、L1506–1507；Task 7 L1622–1638 |
| **I-5**（`stale`/`sourceUnavailable` + 正常重建验 wiki 文件 + 损坏 DB `index-error` + 大小写重命名 & `norm_path` 非唯一） | 同轮应补 | **CLOSED** | Task 4 L849–863、L897–950、L1007–1028；Task 6 L1431–1440；Task 7 L1682–1720、L1775 |
| **I-6**（重绑 `sha256` 短路 + 0 库惰性 Worker + `session-sweep` 生产接线） | 同轮应补 | **CLOSED** | Task 6 L1464–1472、L1508；Task 7 L1612–1620、L1759、L1774、L1782 |
| **I-7**（原 B-4，`koffi` `GetFileAttributesW` + 可注入缝） | 同轮应补 | **CLOSED** | Task 6 L1310–1312、L1339–1344、L1503 |
| **N-1～N-4**（夹具修正、unigram+bigram 说明、`tsconfig.tests.json`、全事件等级与筛选映射） | 不阻断 | **CLOSED** | Task 1 L247–257；Task 2 L114–146、L356–359、L418–430；Task 3 L526；全任务 Step 4 双套 `tsc` |

**§7 当时判定：M1-1 实施计划已达到可直接实施的质量基准（GO）。** 该句只结束第二轮对 §5 入口的复核。当前开工门禁见 §8，结论为 **ITERATE**。

---

## 8. 第三轮独立复核（同一 1,805 行，ITERATE）

本轮不采信 §7 的 GO，也不修改计划正文。三路独立阅读后交叉核对：① 规格全量合规与跨里程碑对接；② 源码反证、安全、隔离、依赖与打包门禁；③ `writing-plans` 可执行性（失败测试、命令、跨任务类型）。只保留对照当前计划正文与当前源码后仍成立的意见。行号均指 [`2026-11-25-knowledge-base-m1-1-registry-indexing.md`](./2026-11-25-knowledge-base-m1-1-registry-indexing.md)。

### 8.1 阻断项（修订计划并复审通过后再开工）

#### R3-B1 跨任务公开类型被引用，全文没有定义

- **位置**：Task 4 `StorageWorkerRequest`（L683 `UpsertDocumentInput`、L687 `ListDocsFilter`）；Task 7 `KnowledgeHost`（L1569–1578 `KnowledgeBaseSummary`、`ListDocsResult`、`GetChunkResult`）。`StorageWorkerResponse.result` 仍是 `unknown`（L704–706）。Task 1 `types.ts`（L62–173）与后续实现步骤都没有这些类型的字段表。
- **规格**：§7.2 已写检索返回字段与 `kb_list_docs` 的默认 50 / 上限 200；§9.4 已写库卡片的阶段与计数。这些字段要由 M1-2 / M1-3 直接消费。
- **后果**：按正文实施，Task 4 / Task 7 的 `tsc` 过不去。为了让类型检查通过而现编字段，会变成后续里程碑的契约。Storage 协议里已有 `getPendingOrganizeBatch`、`getDocChunks`、`markOrganizedAtomic` 等操作，缺的是它们的结果类型，不是「再造一个 Host」。
- **修订要求**：在 Task 1 或 Task 4 的 Interfaces 中定义上述类型的字段、默认值与错误码，并让 Task 7 原样引用。`UpsertDocumentInput.chunks` 明确复用 Task 3 的切片草稿。同时把测试已经调用、Interfaces 却没列出的缝写进契约：`createKnowledgeSyncEngine` 的入参、`getState` / `checkClockJump` / `getMetricsForTest` / `setCaseSensitiveForTest` / `simulateWatchErrorForTest`、`extractFile` 请求里的 `debugDelayMs`、`commitRebuildStaging` 的 `afterCommitBeforeReopenForTest`、storage client 的 `openKb` / `listDocs`。

#### R3-B2 无参 `resolveKnowledgeWorkerUrl` 在源码态会指到还不存在的 `lib/*.js`

- **位置**：Task 1 Step 3（L320–321）；生产调用 Task 4 L1073、Task 6 L1502；测试只覆盖显式 `fromUrl`（L278–289）。
- **原文矛盾**：解析先写从 `dirname(fileURLToPath(fromUrl ?? import.meta.url))` 向上找包根，下一句却「根据 `fromUrl` 是否以 `.ts` 结尾」选择 `src/*.ts` 或 `lib/*.js`。Task 4 / Task 6 调用 `resolveKnowledgeWorkerUrl('storage-worker' | 'extraction-worker')`，不传 `fromUrl`。
- **后果**：`fromUrl` 为 `undefined` 时不以 `.ts` 结尾，拼出 `lib/huaanwork-host/knowledge/*.js`。Task 1 三组测试都传入了 `fromUrl`，会保持绿色；真正拉起 Worker 的任务得到 `ERR_MODULE_NOT_FOUND`。Windows 上若用字面 `'/src/'` 判断路径，分隔符也不匹配。
- **修订要求**：写成 `const callerUrl = fromUrl ?? import.meta.url`，用 `callerUrl` 判断扩展名，并用 `relative(pkgRoot, fileURLToPath(callerUrl))` 判断是否位于 `src` + `sep` 之下。Task 1 增加一条无参 `resolveKnowledgeWorkerUrl('storage-worker')` 断言，期望落在当前源码树的 `storage-worker.ts`。

#### R3-B3 1 秒退场没有终止卡死的 Extraction Worker，测试测的也不是这条路径

- **位置**：Extraction pool 只有无预算的 `dispose()`（L1309）；Host 退场只写外层 950 毫秒竞态（L1776）；测试 L1723–1754。
- **规格**：§2.3、§10、§11.1(10)、D12。退出时并行取消整理、`terminate` Extraction Worker，并关闭 Storage Worker 里的 SQLite；900 毫秒仍未结束则终止 Worker。
- **计划正文**：Storage client 有 `dispose(budgetMs)` 与超时 `worker.terminate()`（L1073）。Extraction pool 没有对应预算。测试把 pool 换成永不结束的 Promise，真正 `terminate()` 的是 Storage mock 里手造的 `new Worker('while (true) {}', { eval: true })`（L1726–1742）。
- **后果**：按这段实现，Host 可以在 1 秒内返回，卡死的 Extraction Worker 继续占 CPU。该测试保持绿色。
- **修订要求**：`createExtractionPool` 的 `dispose(budgetMs)` 在预算耗尽后逐个 `terminate()` 并等待退出。退场测试使用真实卡死的 Extraction Worker，断言 1 秒内 Host 返回且该 Worker 已退出。Storage 的 800 / 900 毫秒兜底保持不变。

### 8.2 同轮应补项（修订 R3-B1～R3-B3 时一并写入计划正文）

#### R3-I1 自动监听 / 防抖 / 周期对账状态机没有实现要点，也没有测试

- **位置**：Task 6 接口 L1314–1318；Step 3 关键点 L1505–1510；测试 L1368–1451。
- **规格**：§6.1、§11.1(3)、D3。`fs.watch(sourceDir, { recursive: true })`、3 秒防抖、300 毫秒写稳、启动 / 新建 / 恢复监听 / 每 5 分钟 / 休眠恢复自动对账；`watch-failed` 后仍做周期对账与手动同步；暂停期间周期与休眠对账不再读源目录；恢复监听立即重建 Watcher 并补一次对账。实时 `dirtyPaths` 批与对账批都适用 1 对 1 重命名。
- **缺口**：Step 3 没有这些常量与触发表。现有测试在 `startKb` 之后一律手调 `syncNow()`，`watch-failed` 靠 `simulateWatchErrorForTest` 直接改相位。可以做成「只有手动同步」并通过当前测试。
- **修订**：在 Task 6 写出默认 `debounceMs = 3_000`、写稳 300 毫秒、周期 `300_000` 毫秒，以及上述触发条件。用可注入 Watcher 与假时钟覆盖这些分支，并保留一条真实 `fs.watch` 集成测试。`watch-failed` 必须断言周期对账仍会运行，而不只是 `syncNow()` 不抛错。

#### R3-I2 `rebuildIndex` 没有产品级测试

- **位置**：Task 6 L1317 只有一句停机、暂存、提交点、收尾。Task 4 L898–1038、L1072 覆盖了文件级 Step 1 / Step 2 与崩溃恢复。Task 6 测试未调用 `rebuildIndex`，Task 7 测试未调用 `host.rebuild()`。
- **规格**：§6.4(2)、§10、§11.1(4)、D6。全量忽略缓存重提取、正常重建继承 `doc_id` 并给消失文件写墓碑、损坏旧库全部换新 UUID、维护门闩拒绝并发且取消整理不计次、提交前失败回滚、Wiki 重置失败后拒读、提交后重开失败保留新库并置 `index-error`。
- **修订**：增加直接调用 `host.rebuild()` 的正常重建、损坏重建与故障注入测试，断言数据库、`wiki/`、事件、门闩和重启后续做的最终状态。Task 4 的文件协议测试保留。

#### R3-I3 `subscribeSystemResume` 的条件注册会打到未注册 RPC

- **位置**：Task 7 L1778–1783。
- **源码**：`createHostRuntime` 的返回值就是 Host 进程里的 `ctx.desktopRuntime`（`src/host-process-entry.ts`）。`HostRpc.receive` 对未注册方法抛 `Unknown Host operation: <method>`（`src/host-rpc.ts`）。`setKeepAwake` 在 `bindNativeRuntime` 中无条件注册，缺能力时在 handler 内失败（`src/host-runtime-bridge.ts`）。`tests/host-runtime-bridge.spec.ts` 的 native 桩没有 `subscribeSystemResume`。`tests/host-process-integration.spec.ts` 与 `tests/host-liveness-win.spec.ts` 同样把测试桩交给 `bindNativeRuntime`。
- **冲突**：计划让 `createHostRuntime` 挂上该方法，又让 `bindNativeRuntime` 仅当运行时真有该方法时才注册 `native:subscribeSystemResume`。Host 侧窄化判断看到的是代理上的函数，于是每次启动都会发出 RPC；父进程桩没有该方法时即未知操作。
- **修订**：handler 无条件注册。运行时没有 `subscribeSystemResume` 时静默 no-op，不抛错。已订阅句柄放进 Map，并在 `detachHostResources()` 里全部释放。`createHostRuntime` 的返回类型与 `ElectronDesktopRuntime` 的 `implements` 补上 `SystemResumeRuntime`。写明上述三处测试桩不必实现该方法也能启动。两处 `vi.mock('electron')` 补 `powerMonitor` 的要求保持不变。

#### R3-I4 规格点名的库内合法符号链接与 Windows junction 没有测试

- **位置**：Task 1 L223–224、Task 5 L1148–1193 与 L1158–1159。实现步骤 L1261 已要求入口 `realpath(sourceDir)`。
- **规格**：§5.3(1)、§11.1(1)。越界符号链接、目录环、打开前后 `(dev, ino)` 替换要拒绝；库内合法符号链接只读一次已打开的 `FileHandle`；Windows junction / reparse point 同样覆盖。
- **已成立、不另开项**：越界链接、环、inode 替换已有可执行断言。L1261 要求先 `realpath(sourceDir)`，因此 macOS 上 `tmpdir()` 的 `/var` → `/private/var` 不会单靠参数名 `realSourceRoot` 误拒合法文件。参数名与实现步骤不一致，修订时把首参改成 `sourceRoot` 即可。
- **缺口**：没有「库内合法符号链接返回 `ok: true` 且字节来自该 `FileHandle`」的用例。目录链接写成 `symlinkSync(..., 'dir')`。仓内既有测试使用 `process.platform === 'win32' ? 'junction' : 'dir'`；普通权限 Windows 上 `'dir'` 会 `EPERM`。主 `yarn check` 不在 Windows 上跑 Vitest，所以这不会先打红现有 CI，但规格点名的 junction 仍然没被测到。
- **修订**：补库内合法链接用例。目录链接改为平台分支；无特权 Windows 上文件符号链接若 `EPERM`，改测 junction，不让整组测试失败。

#### R3-I5 M1 文本格式矩阵没有钉全

- **位置**：Task 5 测试 L1196–1226；`text.ts` 要点 L1278。
- **规格**：§6.2。M1 文本 / 代码 / 表格文本包含 `.md`、`.txt`、`.csv`、`.tsv`、`.json`、`.yaml`、`.yml`、`.xml`、`.html` 与常见源码后缀，UTF-8 / GB18030，HTML 去标签并保留标题与行号。
- **缺口**：测试覆盖了 txt、GB18030、HTML、三种 OOXML 和中文 CID PDF。csv / tsv / json / yaml / xml / 源码后缀没有样本，也没有写进扩展名策略。
- **修订**：用参数化样本钉住这些后缀走文本提取，而不是被当成不支持格式跳过。音视频跳过保持现有断言。

#### R3-I6 `dehydrated` 没有端到端「不打开、不提取」断言

- **位置**：分类测试 L1339–1344；引擎测试把探针固定为 `probe-unavailable`（L1398）。
- **规格**：§6.1、§11.1(3)。未水合占位文件先看属性，不进入全文解析；探针不可用时按普通文件入库并记一条 `info` 事件。
- **已成立**：`detectCloudPlaceholder` 三态、`koffi` 的 `uint32 __stdcall GetFileAttributesW(str16)`，以及掩码 `0x00400000 | 0x00040000 | 0x00001000`，与 `src/windows-volume-diagnostics.ts` 的绑定方式一致。`probe-unavailable` 记一条 info 并继续索引，已有断言。
- **修订**：注入 `dehydrated`，断言 Extraction pool 未被调用，该文件有明确跳过状态，同批其它文件继续。

#### R3-I7 重绑「保留既有资产」只写在注释里

- **位置**：Task 6 L1464–1471。
- **规格**：§6.4(1)、§11.1(4)。同 `rel_path` 且 `sha256` 与 `extract_config_hash` 一致时，保留 `doc_id`、切片、向量、`wiki/docs/<docId>.md` 与 `organized_sha256`，只更新 `mtime_ms` / `size`。
- **缺口**：注释写保留 `organized_sha256`，断言只有 `docId` 与 `fullRechunkCount`。测试前没有写入整理指纹、Wiki 卡片或向量。
- **修订**：重绑前写入这三项，重绑后逐项断言不变，并断言 `source_rebound` 与注册表已落盘新 `sourceDir`。

#### R3-I8 源目录消失只测了查询标记

- **位置**：Task 7 L1686–1719。
- **规格**：§6.1、§10。源目录消失时关 Watcher，阶段为 `source-unavailable`，保留索引和 wiki；目录恢复后记 `source_restored`。
- **缺口**：`search` / `getChunk` 的 `sourceUnavailable: true` 已断言。Watcher 关闭、历史库保留、`source_unavailable` / `source_restored` 事件没有断言。
- **修订**：删源目录后断言 Watcher 已关、`index.sqlite` 与 `wiki/` 仍在、事件与阶段正确；目录恢复并同步后出现 `source_restored`。

Worker 默认值不单列：规格 §6.2 的默认并发 1、上限 2、单文件 60 秒、`maxOldGenerationSizeMb = 256` 只出现在可选参数（L1309）。测试传入的是 `maxWorkers: 1` 与 `timeoutMs: 150`（L1351）。默认值写错，这组测试不会红。与 R3-B3 的 pool 契约一起补一条构造默认值断言。

### 8.3 核对后不成立或不升级的说法

| 原说法 | 核对结果 |
| --- | --- |
| M1-1 没有可被后续里程碑拿到的唯一 Host 实例 | **不成立**。M1-3 自己承担 `knowledge.reveal` 与 16 条路由。M1-2 改同一处 `index.ts`，把已创建的 `knowledgeHost` 传进工具上下文。本轮要补的是 R3-B1 的结果类型，不是再加一个全局单例 |
| 密码保护的 `.docx` / `.xlsx` / `.pptx` 必须在本计划标成 `skipped: encrypted`，否则阻断 | **降为不阻断**。真实打开密码文件是 OLE2（魔数 `D0 CF 11 E0`），不是加密 ZIP。规格 §10 允许 `skipped` 或 `error`。计划把 ZIP 加密位收成 `skipped: encrypted`、把打不开的包收成 `error: corrupt-archive`，没有偏离这句。修订时可顺手识别 OLE2 魔数与 ZIP `method === 99`，不进入 §8.4 门禁 |
| `verify-packaged-runtime.spec.ts` 必须把两个新 Worker 写进显式缺失表，否则打包漏检 | **不升级**。打包检查会扫描整个 `lib/`。`tests/package.spec.ts` 锁定 `tsdown` 入口仍然需要，计划 L1540、L1761 已有 |
| `openVerifiedSourceFile` 在 macOS 上会因 `/var` 与 `/private/var` 误拒全部合法文件 | **不成立为阻断**。L1261 要求入口 `realpath(sourceDir)`。参数名 `realSourceRoot` 容易让人跳过这一步，只在 R3-I4 里改名 |

另外核对后保持成立、不推翻 §1 与 §7 已闭环部分：`adm-zip@0.6.0` 在 `header.size === 0` 时确实不传 `maxOutputLength`，计划禁止 `getData()` 并改走 `getCompressedData()` + `inflateRawSync({ maxOutputLength })`；伪造炸弹测试真实调用了生成器。注册表 `0o600`、20 库上限、删库顺序与源目录字节不变、FTS5 DDL 与 WAL PRAGMA、中文 unigram/bigram、`chunks_fts` 同事务清理、checkpoint / 诊断包的真实 API、路由表维持 92、0 库不拉起 Worker，均仍可保留。

### 8.4 复审准入清单（从 ITERATE 转为 GO 的唯一入口）

修订计划后只核验下列各项。全部落入计划正文后，当前开工结论才可改为 GO。§7 的历史 GO 不自动恢复。

1. **R3-B1**：定义 `UpsertDocumentInput`、`ListDocsFilter`、`ListDocsResult`、`GetChunkResult`、`KnowledgeBaseSummary`，以及 §8.1 列出的测试缝签名。
2. **R3-B2**：无参 `resolveKnowledgeWorkerUrl` 按合并后的 caller URL 判断 `.ts` / `src`，并有无参单测。
3. **R3-B3**：Extraction pool `dispose(budgetMs)` 超时 `terminate`；1 秒退场测试断言的是卡死的 Extraction Worker，并带上默认并发 1、上限 2、60 秒、256 MB 的构造断言。
4. **R3-I1**：`fs.watch`、3 秒防抖、5 分钟周期、启动 / 恢复 / 休眠自动对账、`watch-failed` 仍周期对账，均有实现要点与可执行测试。
5. **R3-I2**：`host.rebuild()` 覆盖正常重建、损坏重建与 §6.4 故障分支。
6. **R3-I3**：`native:subscribeSystemResume` 无条件注册、缺能力时 no-op，现有 Host 测试桩不用补实现。
7. **R3-I4**：库内合法符号链接单句柄读取，以及 Windows junction 平台分支。
8. **R3-I5**：§6.2 的 csv / tsv / json / yaml / xml / 源码后缀有文本提取样本。
9. **R3-I6**：`dehydrated` 文件不打开、不提取，同批其它文件继续。
10. **R3-I7**：重绑后 `organized_sha256`、Wiki 卡片与向量保持不变。
11. **R3-I8**：源目录消失关闭 Watcher 并保留历史库，恢复后记 `source_restored`。

**当前判定：M1-1 实施计划未达到可直接实施的质量基准（ITERATE）。** 计划正文本轮未改。


---

## 9. 第三轮（Grok）复核结论反证校准与修订收口（修订稿 2,451 行）

### 9.1 对 §8 全部 11 项发现的独立源码反证

逐条对照当前仓内源码与 1,805 行计划核实：

- **误报数：0；夸大数：0**。§8 的全部 11 项（`R3-B1`～`R3-B3` + `R3-I1`～`R3-I8`）及 §8.3 排除的 4 项均核实准确。
- **1 处级别校准（上调为阻断）**：`R3-I3` 经实查 [`src/host-rpc.ts:74`](../../../dsh-plugin-huaanwork/src/host-rpc.ts#L74)（未注册方法直接抛 `Unknown Host operation: ${message.method}`）、[`src/electron-runtime.ts:194`](../../../dsh-plugin-huaanwork/src/electron-runtime.ts#L194) 与 [`tests/host-process-integration.spec.ts:69`](../../../dsh-plugin-huaanwork/tests/host-process-integration.spec.ts#L69) / [`tests/host-liveness-win.spec.ts:285`](../../../dsh-plugin-huaanwork/tests/host-liveness-win.spec.ts#L285) / [`tests/host-runtime-bridge.spec.ts:27`](../../../dsh-plugin-huaanwork/tests/host-runtime-bridge.spec.ts#L27)，确认条件注册会在既有 Host 集成测试中**必现启动报错**，实质属阻断级，必须同轮改为无条件注册 + 缺能力静默 no-op。
- **§8.3 顺手采纳项**：在 `extractors/ooxml.ts` 顺手增加 OLE2 魔数 `D0 CF 11 E0 A1 B1 1A E1`（Office 密码保护 OOXML）与 ZIP `method === 99`（WinZip AES）识别返回 `skipped: 'encrypted'` 及单测。
- **实查仓内 Windows junction 惯例**：[`tests/host-directory-picker-browse.spec.ts:70`](../../../dsh-plugin-huaanwork/tests/host-directory-picker-browse.spec.ts#L70)、[`tests/diagnostic-export.spec.ts:199`](../../../dsh-plugin-huaanwork/tests/diagnostic-export.spec.ts#L199) 等 12+ 处测试统一使用 `process.platform === 'win32' ? 'junction' : 'dir'`，`R3-I4` 完全吻合仓内惯例。

### 9.2 §8.4 全部 11 条复审入口闭环表（修订稿 2,451 行）

| 入口 | 校准级别 | 闭环状态 | 修订稿精确落点（[`2026-11-25-knowledge-base-m1-1-registry-indexing.md`](./2026-11-25-knowledge-base-m1-1-registry-indexing.md)） |
| --- | --- | --- | --- |
| **R3-B1**（跨任务公开类型 + 强类型 StorageClient + 全部测试缝签名） | 阻断 | **CLOSED** | Task 1 `types.ts` L175–302（`ChunkDraft` / `UpsertDocumentInput` / `DocumentRecordSummary` / `ListDocsFilter` / `ListDocsResult` / `ChunkWindowItem` / `GetChunkResult` / `KnowledgeBaseStats` / `KnowledgeBaseSummary` / `OrganizeTombstoneRecord` / `PendingOrganizeItem` / `PendingOrganizeBatch`）；Task 3 L663 复用 `ChunkDraft`；Task 4 L841–872（`StorageResultMap` + 泛型 `StorageWorkerResponse<K>`）& L939–970（完整强类型 `KnowledgeStorageClient` + `commitRebuildStaging` 缝）；Task 6 L1570–1657（`ExtractionFileRequest`/`Result`/`Pool` + `KnowledgeSyncEngineOptions`/`RuntimeState`/`Metrics` + 全部测试缝）；Task 7 L2082–2119（`CreateKnowledgeHostOptions` + `KnowledgeHost`） |
| **R3-B2**（无参 `resolveKnowledgeWorkerUrl` 按合并 `callerUrl` + 跨平台 `relative` 判 `src`） | 阻断 | **CLOSED** | Task 1 Step 1 L415（无参 `resolveKnowledgeWorkerUrl('storage-worker')` 单测断言落在 `src/.../storage-worker.ts`）；Step 3 L454–456（`callerUrl = fromUrl ?? import.meta.url` + `relative(pkgRoot, callerPath)` 按 `[/\\]` 切首段判 `'src'`） |
| **R3-B3**（Extraction pool `dispose(budgetMs)` 立即 `terminate()` + 真实 CPU 卡死 Extraction Worker 退场测试 + 构造默认值断言） | 阻断 | **CLOSED** | Task 6 L1565–1601（常量 1/2/60s/256MB、`debugBusyLoopMs`、`dispose(budgetMs = 300)`）、L1695–1700（默认值与上限钳制断言）、L2012；Task 7 L2381–2404（真实 `createExtractionPool` + `debugBusyLoopMs: 30_000` 进 `host.dispose()`，断言 `< 1_000 ms` 且 `activeWorkerCount() === 0`）、L2420（`extractionPool.dispose(300)`） |
| **R3-I3**（校准为阻断：`native:subscribeSystemResume` 无条件注册 + 缺能力静默 no-op） | 阻断（校准升级） | **CLOSED** | Task 7 L2409（`host-runtime-bridge.spec.ts` 裸桩静默 no-op 断言）、L2422–2426（`bindNativeRuntime` 无条件注册 + `resumeSubscriptions` Map 随 `detachHostResources()` 释放 + `createHostRuntime` 返回类型与 `ElectronDesktopRuntime implements` 补 `SystemResumeRuntime` + 既有三处测试桩零改动）与 L2440（定向命令并入 `tests/host-process-integration.spec.ts`） |
| **R3-I1**（自动监听 / 3s 防抖 / 300ms 写稳 / 5min 周期 / 启动+恢复+休眠自动对账 / `watch-failed` 周期对账 + 真实 `fs.watch`） | 同轮应补 | **CLOSED** | Task 6 L1607–1610（默认常量）、L1765–1842（可注入 `watchFactory` 覆盖启动自动对账、实时防抖 1 对 1 重命名、`watch-failed` 仍跑周期对账、`pauseWatch` 停周期与休眠、`resumeWatch` 重建并补对账）、L1844–1870（真实 `fs.watch` 集成测试）、L2015–2023（自动触发表） |
| **R3-I2**（`host.rebuild()` 产品级正常/损坏/故障分支 E2E 测试） | 同轮应补 | **CLOSED** | Task 7 L2214–2316（正常重建保留 `docId`/Wiki/清 `organizeAttempts`/并发 `knowledge-base-busy` 拦截 + 源目录缺失提交前拒绝回滚 + 损坏 DB 重建触发 `wiki-reset-pending` 及 `host.sync()` 幂等续做 + 提交后重开失败保留新库不回滚且置 `index-error`） |
| **R3-I4**（库内合法符号链接单句柄读取 + Windows `junction` 平台分支 + `sourceRoot` 参数改名） | 同轮应补 | **CLOSED** | Task 1 L325、L347–348；Task 5 L1301（参数改名 `sourceRoot`）、L1341（`DIR_SYMLINK_TYPE`）、L1356–1411（库内合法目录 junction/dir + 文件符号链接无特权 Windows `EPERM` 降级，断言 `ok: true` 单 `FileHandle` 读出字节） |
| **R3-I5**（M1 文本/代码/表格格式矩阵全覆盖） | 同轮应补 | **CLOSED** | Task 5 L1307（`TEXT_EXTENSIONS` 全集）、L1424–1442（`it.each` 参数化覆盖 `.md/.txt/.csv/.tsv/.json/.yaml/.yml/.xml/.ts/.py/.sql`）及 L1485–1487 / L1510–1515（顺手补 OLE2 魔数与 ZIP `method === 99` 加密识别） |
| **R3-I6**（`dehydrated` 端到端不打开、不提取断言） | 同轮应补 | **CLOSED** | Task 6 L1727–1763（`vi.spyOn(pool, 'extractFile')` 断言 `cloud-only.md` 零提取且标 `cloud-placeholder-dehydrated`，同批 `local.md` 正常入库）、L2013 |
| **R3-I7**（重绑后 `organized_sha256`、Wiki 卡片、向量、`source_rebound` 与注册表全项断言） | 同轮应补 | **CLOSED** | Task 6 L1956–1981（重绑前写入 `organized_sha256`、`wiki/docs/<docId>.md`、`chunk_embeddings` 向量，重绑后逐项断言原封不动 + `readKnowledgeBases` 落盘新路径 + `source_rebound` 事件） |
| **R3-I8**（源目录消失关 Watcher + 保留 DB/wiki + `source_unavailable`，恢复后记 `source_restored`） | 同轮应补 | **CLOSED** | Task 7 L2320–2379（删源目录后断言 `!isWatchingForTest`、阶段 `'source-unavailable'`、`index.sqlite` 与 `wiki/INDEX.md` 完好、`source_unavailable` 事件；恢复后断言 Watcher 重建、阶段 `'watching'` 与 `source_restored` 事件） |

**当前状态**：§8.4 全部 11 项入口（含校准升级的 `R3-I3`）已逐条落入 2,451 行修订稿，等待第三轮复审方按 §9.2 表抽检确认后即可正式按 Task 1–7 启动实施。
