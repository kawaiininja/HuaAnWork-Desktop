# Knowledge Base M1-1: Registry, Isolation, Dual-Worker Extraction & SQLite FTS5 Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HuaAnWork 桌面端落地知识库 M1 底座：多知识库原子注册表与物理隔离目录、安全只读 `FileHandle` 提取管线（文本 / OOXML / 带 CMaps 文字 PDF）、独占 `node:sqlite` 的 Storage Worker 与受限堆 Extraction Worker 池（均惰性启动）、监听/排空暂停/`watch-failed`/休眠跨进程唤醒与错峰对账、重绑（含 `sha256` 短路）与提交点可恢复重建索引、删库完整链路，以及无头打包冒烟。

**Architecture:** 全部知识库核心代码收敛在 `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/`；另外仅对 `host-runtime-bridge.ts` 与 `electron-runtime.ts` 增加极窄的可选扩展 `SystemResumeRuntime`（将 Electron 主进程 `powerMonitor.on('resume')` 桥接到独立子进程 Host）。Host 主线程只协调注册表、Watcher 与 Worker 消息，不在主线程同步执行 `node:sqlite` 或解析用户文档。一个长期 Storage Worker（惰性启动）独占每库独立的 `<profileDir>/workspace-knowledge/<kbId>/index.sqlite`（WAL + FTS5）；1–2 并发 Extraction Worker 池（惰性启动）按 `realpath` → 逐段 `lstat`/`bigint (dev, ino)` → `open(O_RDONLY | O_NOFOLLOW[POSIX])` → `FileHandle.stat` 单句柄只读解析，不引入 `sharp` 或外部二进制。

**Tech Stack:** TypeScript、Node.js `22.19+ / 24+`（`node:sqlite`、`node:worker_threads`、`node:fs/promises`、`node:zlib`）、`@deepseek-ai/dsh-atomic-write`、`adm-zip`（仅解析目录表与原始压缩段，严禁调用 `getData()`）、`koffi`（Windows `kernel32.dll` `GetFileAttributesW` 云占位探针）、`pdfjs-dist`（Apache-2.0，打包 `cmaps/` 与 `standard_fonts/`）、Vitest、tsdown、Electron 44（打包冒烟走 `ELECTRON_RUN_AS_NODE=1`）。

**Spec:** [`docs/superpowers/specs/2026-11-24-knowledge-base-design.md`](../specs/2026-11-24-knowledge-base-design.md)（v2.5）  
**Review:** [`docs/superpowers/specs/2026-11-24-knowledge-base-design-review.md`](../specs/2026-11-24-knowledge-base-design-review.md)（§10–§17）  
**Plan Review:** [`docs/superpowers/plans/2026-11-25-knowledge-base-m1-1-plan-review.md`](./2026-11-25-knowledge-base-m1-1-plan-review.md)  
**Baseline:** 外层仓库 `209d9f1835`（含 v2.5 规格与六轮评审收口）；上游子模块 `deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`。

**Plan Series:**
- **M1-1（本计划）**：注册、隔离、双 Worker 提取、FTS5 增量索引、监听/暂停/休眠唤醒、重绑/重建/删库、打包冒烟
- **M1-2**：[`2026-11-25-knowledge-base-m1-2-single-slot-organizer.md`](./2026-11-25-knowledge-base-m1-2-single-slot-organizer.md)
- **M1-3**：[`2026-11-25-knowledge-base-m1-3-session-mount-ui-citations.md`](./2026-11-25-knowledge-base-m1-3-session-mount-ui-citations.md)
- **M2-0（M2 前置门禁）**：[`2026-11-25-knowledge-base-m2-0-legacy-office-spike.md`](./2026-11-25-knowledge-base-m2-0-legacy-office-spike.md)

---

## Global Constraints

- 全部产品代码只进入 `dsh-plugin-huaanwork/`（M1-1 无需改 `packages/huaanwork-policy/`）；严禁修改 `deepseek-harness/` 子模块。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0` 与 Corepack Yarn `4.18.0`（`dsh-plugin-huaanwork/node_modules/@types/node@22.20.1` 已含 `node:sqlite` 类型定义）。M1-1 新增运行依赖仅限 `pdfjs-dist`（Apache-2.0，已在 `scripts/verify-licenses.mjs` 的 `ALLOWED_LICENSES` 中，安装后须确认未引入 `@napi-rs/canvas` 等原生依赖）；OOXML 的 XML 提取采用零依赖轻量纯 JS 解析器。变更依赖必须同步通过 `corepack yarn workspace dsh-plugin-huaanwork verify:licenses` 与 `verify:notices`。
- 运行时绝不 `import 'sharp'`，绝不在 `worker_threads` 内使用 Electron `nativeImage`。
- 每个 Worker 入口文件首条可执行语句必须调用 `disableAsarArchiveView(import.meta.url)`（防止损坏 `.asar` 触发 `Invalid package` 崩溃）。
- **Node 原生 type-stripping 兼容约束**：Vitest 测试直接以 `.ts` 启动 `Worker`，因此 `storage-worker.ts`、`extraction-worker.ts` 及其全部传递导入模块**禁止使用 `enum`、constructor parameter properties、`namespace`**，且全部相对导入必须显式带 `.ts` 后缀、纯类型导入必须使用 `import type`。
- **目录深度无关的 Worker 路径解析**：`tsdown` 会把共享模块拆成 `lib/<chunk>-<hash>.js`（深度 1）或内联到 `lib/huaanwork-host/index.js`（深度 2）/ `lib/packaged-runtime-smoke.js`（深度 1），而两个 Worker 产物在 `lib/huaanwork-host/knowledge/{storage,extraction}-worker.js`（深度 3）。严禁写 `new URL('./storage-worker.js', import.meta.url)`，必须统一调用 `resolveKnowledgeWorkerUrl()`（锚定 `dsh-plugin-huaanwork/package.json`）。
- Host 严格模式（`tsconfig.json` 与 `tsconfig.tests.json` 均开启 `exactOptionalPropertyTypes: true` 与 `noUncheckedIndexedAccess: true`）：不要向可选字段显式赋 `undefined`，所有数组/索引访问须收窄。每个任务均同时运行 `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json --noEmit`。
- 所有含配置/注册表的持久化 JSON 统一走 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic(..., { mode: 0o600 })`。
- **0 知识库惰性启动**：已注册知识库为空时，`KnowledgeHost` 启动不得拉起 Storage Worker 或 Extraction Worker 线程，保护既有 Host 门禁与无库用户启动速度。
- 本计划完成后必须独立通过 `corepack yarn check`（不得与其他含 `verify:aa` 的命令并发）。本计划**不修改** `ROUTE_TABLE`（仍保持 92 条；16 条表内路由在 M1-3 一次性注册并更新 4 处契约测试）。

---

## Delivery Order

1. 知识库共享类型与硬上限常量、中立目录布局、目录深度无关 Worker 路径解析、`0o600` 原子设置与注册表、源目录路径（含符号链接/祖先/项目重叠）与无副作用大小写探测。
2. 脱敏事件日志（`events.jsonl` 500 行 / 512 KB、完备事件等级与四胶囊筛选）与真实 `createDesktopProfileCheckpoint().captureHealthy()` / `exportDesktopDiagnostics()` 排除回归。
3. 中文单/双字分词、FTS5 安全查询转义、切片器（含文本字节与切片上限）与跨库倒数排名归并纯函数。
4. Storage Worker（独占 `node:sqlite` + 规格 §7.1 完整 DDL + `50,000` 切片限额 + 启动损坏降级 `index-error` + Step 2 提交点原子切换与三文件恢复 + 正常重建核验 `wiki/docs/<docId>.md` + 大小写/重命名契约）。
5. 安全只读 `FileHandle` 校验链、`computeExtractConfigHash` 与纯 JS 文本 / 防炸弹防加密 OOXML（`getCompressedData` + `inflateRawSync({ maxOutputLength })`）/ 带 `workerSrc` 与 `cmaps/` 的文字 PDF 提取器。
6. Extraction Worker 池、`koffi` `GetFileAttributesW` 云占位探针、监听/排空暂停/`watch-failed`/墙钟-单调时钟跳变唤醒、`> 5` 文件折叠与 `2,000` 文件限额、重绑（含 `sha256` 短路）与重建状态机。
7. `KnowledgeHost` 完整门面（含 `remove(kbId)` 全链路、20 库上限、命中 `stale`/`sourceUnavailable` 实时 `stat`、惰性启动、≤ 1 秒并行退场）、`powerMonitor.on('resume')` 主进程→Host 跨进程桥接、`tsdown.config.ts` Worker 入口、`session-sweep` 生产接线、无头打包冒烟与 M1-1 门禁。

---

### Task 1: 知识库共享类型、中立目录、Worker 路径解析、原子设置与注册表校验

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts:84-105`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/settings.ts:1-20,348-355`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/types.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/paths.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/worker-paths.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/registry.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-registry.spec.ts`

**Interfaces:**
- Produces in `workspace-state.ts`: `neutralKnowledgeBaseDir(profileDir)`（`<profileDir>/workspace-knowledge`）、`neutralKnowledgeRootPath(profileDir, kbId)`、`neutralKnowledgeWikiRootPath(profileDir, kbId)`（均过 `assertSafePathSegment(kbId, 'kbId')`）。
- Produces in `knowledge/types.ts`:
  ```ts
  export const MAX_KNOWLEDGE_BASES = 20
  export const MAX_FILES_PER_KB = 2_000
  export const MAX_FILE_BYTES = 50 * 1024 * 1024
  export const MAX_DOC_TEXT_BYTES = 10 * 1024 * 1024
  export const MAX_CHUNKS_PER_DOC = 500
  export const MAX_CHUNKS_PER_KB = 50_000
  export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024
  export const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024
  export const MAX_ZIP_ENTRIES = 2_000
  export const MAX_WIKI_FILE_BYTES = 256 * 1024
  export const MAX_WIKI_TOTAL_BYTES = 50 * 1024 * 1024
  export const MAX_VISION_PDF_PAGES = 50
  export const EXTRACTOR_PIPELINE_VERSION = 'm1-v1'

  export interface KnowledgeBaseRecord {
    readonly id: string
    readonly name: string
    readonly sourceDir: string
    readonly autoOrganize: boolean
    readonly watchPaused: boolean
    readonly createdAt: string
  }

  export type KnowledgePhase =
    | 'watching'
    | 'syncing'
    | 'rebuilding'
    | 'watch-paused'
    | 'watch-failed'
    | 'source-unavailable'
    | 'index-error'
    | 'wiki-reset-pending'
    | 'waiting-turn-slot'
    | 'organizing'
    | 'blocked-no-model'
    | 'blocked-network'
    | 'quarantined-errors'

  export type KnowledgeErrorCode =
    | 'knowledge-base-not-found'
    | 'knowledge-base-busy'
    | 'knowledge-base-deleting'
    | 'knowledge-base-limit-reached'
    | 'source-unavailable'
    | 'wiki-reset-pending'
    | 'index-error'
    | 'invalid-source-dir'

  export type KnowledgeEventLevel = 'info' | 'warn' | 'error'

  export type KnowledgeEventKind =
    | 'sync_started'
    | 'sync_completed'
    | 'file_indexed'
    | 'file_renamed'
    | 'file_deleted'
    | 'file_skipped'
    | 'file_error'
    | 'source_rebound'
    | 'rebuild_completed'
    | 'rebuild_failed'
    | 'wiki_reset_failed'
    | 'organize_started'
    | 'organize_completed'
    | 'organize_failed'
    | 'organize_cancelled'
    | 'source_unavailable'
    | 'source_restored'
    | 'watch_failed'
    | 'cloud_probe_unavailable'

  export interface KnowledgeEventRecord {
    readonly id: string
    readonly at: string
    readonly kind: KnowledgeEventKind
    readonly level: KnowledgeEventLevel
    readonly summary: string
    readonly detail?: string
    readonly relPath?: string
    readonly count?: number
  }

  export type ChunkLocator =
    | { readonly kind: 'line'; readonly startLine: number; readonly endLine: number }
    | { readonly kind: 'section'; readonly section: string }
    | { readonly kind: 'sheet'; readonly sheet: string; readonly rowStart: number; readonly rowEnd: number }
    | { readonly kind: 'slide'; readonly slide: number }
    | { readonly kind: 'page'; readonly page: number; readonly mode: 'text' | 'vision' }
    | { readonly kind: 'image' }
    | { readonly kind: 'file' }

  export interface ExtractedSection {
    readonly headingPath: string
    readonly locator: ChunkLocator
    readonly text: string
    readonly headerRow?: string
  }

  export interface ExtractedDocument {
    readonly format: string
    readonly extractMode: 'text' | 'vision' | 'mixed' | 'none'
    readonly extractConfigHash: string
    readonly status: 'indexed' | 'partial' | 'skipped' | 'error'
    readonly statusReason?: string
    readonly sections: readonly ExtractedSection[]
    readonly totalPages?: number
    readonly parsedPages?: number
  }

  export interface ChunkDraft {
    readonly ordinal: number
    readonly headingPath: string
    readonly locator: ChunkLocator
    readonly content: string
    readonly tokenized: string
    readonly charCount: number
  }

  export interface UpsertDocumentInput {
    readonly relPath: string
    readonly normPath: string
    readonly sha256: string
    readonly size: number
    readonly mtimeMs: number
    readonly format: string
    readonly extractMode: 'text' | 'vision' | 'mixed' | 'none'
    readonly extractConfigHash: string
    readonly status: 'indexed' | 'partial' | 'skipped' | 'error'
    readonly statusReason?: string
    readonly chunks: readonly ChunkDraft[]
  }

  export interface DocumentRecordSummary {
    readonly docId: string
    readonly relPath: string
    readonly normPath: string
    readonly sha256: string
    readonly size: number
    readonly mtimeMs: number
    readonly format: string
    readonly extractMode: 'text' | 'vision' | 'mixed' | 'none'
    readonly extractConfigHash: string
    readonly status: 'indexed' | 'partial' | 'skipped' | 'error'
    readonly statusReason: string | null
    readonly wikiNotePath: string | null
    readonly organizedSha256: string | null
    readonly organizeAttempts: number
    readonly organizeRetryAfter: number | null
    readonly lastOrganizeError: string | null
    readonly updatedAt: number
    readonly chunkCount: number
  }

  export interface ListDocsFilter {
    readonly status?: 'indexed' | 'partial' | 'skipped' | 'error'
    readonly organizeState?: 'pending' | 'organized' | 'failed'
    readonly pathQuery?: string
    /** 默认 50，硬上限 200（规格 §7.2）。 */
    readonly limit?: number
    readonly offset?: number
  }

  export interface ListDocsResult {
    readonly total: number
    readonly docs: readonly DocumentRecordSummary[]
  }

  export interface ChunkWindowItem {
    readonly chunkId: string
    readonly ordinal: number
    readonly headingPath: string
    readonly locator: ChunkLocator
    readonly content: string
  }

  export type GetChunkResult =
    | {
        readonly status: 'ok'
        readonly kbId: string
        readonly kbName: string
        readonly docId: string
        readonly relPath: string
        readonly sha256: string
        readonly extractConfigHash: string
        readonly stale: boolean
        readonly sourceUnavailable: boolean
        readonly targetOrdinal: number
        readonly chunks: readonly ChunkWindowItem[]
      }
    | {
        readonly status: 'kb-removed' | 'chunk-missing' | 'version-mismatch'
        readonly kbId: string
        readonly docId: string
        readonly currentSha256?: string
        readonly currentExtractConfigHash?: string
      }

  export interface KnowledgeBaseStats {
    readonly totalDocs: number
    readonly indexedDocs: number
    readonly partialDocs: number
    readonly skippedDocs: number
    readonly errorDocs: number
    readonly pendingOrganizeDocs: number
    readonly failedOrganizeDocs: number
    readonly totalChunks: number
  }

  export interface KnowledgeBaseSummary extends KnowledgeBaseRecord {
    readonly phase: KnowledgePhase
    readonly stats: KnowledgeBaseStats
    readonly lastSyncedAt?: string
    readonly lastError?: string
    readonly syncingProgress?: { readonly completed: number; readonly total: number }
    readonly organizeProgress?: { readonly currentBatch: number; readonly totalBatches: number }
  }

  export interface OrganizeTombstoneRecord {
    readonly docId: string
    readonly relPath: string
    readonly wikiNotePath: string | null
    readonly deletedAt: number
  }

  export interface PendingOrganizeItem {
    readonly docId: string
    readonly relPath: string
    readonly sha256: string
    readonly wikiNotePath: string | null
    readonly charCount: number
  }

  export interface PendingOrganizeBatch {
    readonly docs: readonly PendingOrganizeItem[]
    readonly tombstones: readonly OrganizeTombstoneRecord[]
  }
  ```
- Produces in `knowledge/worker-paths.ts`: `resolveKnowledgeWorkerUrl(kind: 'storage-worker' | 'extraction-worker', fromUrl?: string): URL`。
- Produces in `knowledge/paths.ts`: `validateSourceDir(input: { sourceDir: string; profileDir: string; existing: readonly KnowledgeBaseRecord[]; ignoreKbId?: string; platform?: NodeJS.Platform })`、`probeCaseSensitiveDir(dirPath: string, platform?: NodeJS.Platform): Promise<boolean>`、`isUncOrDevicePath(rawPath: string): boolean`。
- Produces in `knowledge/registry.ts`: `readKnowledgeBases(profileDir: string): Promise<KnowledgeBaseRecord[]>`、`writeKnowledgeBases(profileDir: string, records: readonly KnowledgeBaseRecord[]): Promise<void>`（`{ knowledgeBases }` 无版本信封，`writeFileAtomic + 0o600`）。

- [ ] **Step 1: 写注册表、路径校验（含符号链接/Windows junction/祖先嵌套/项目重叠）、Worker 路径解析（含无参默认调用）、大小写无副作用探测与 `0o600` 原子写入失败测试**

```ts
import { mkdtempSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  neutralKnowledgeBaseDir,
  neutralKnowledgeRootPath,
  neutralKnowledgeWikiRootPath,
} from '../../src/huaanwork-host/workspace-state.ts'
import { writeHuaanworkSettings } from '../../src/huaanwork-host/settings.ts'
import { isUncOrDevicePath, probeCaseSensitiveDir, validateSourceDir } from '../../src/huaanwork-host/knowledge/paths.ts'
import { resolveKnowledgeWorkerUrl } from '../../src/huaanwork-host/knowledge/worker-paths.ts'
import { readKnowledgeBases, writeKnowledgeBases } from '../../src/huaanwork-host/knowledge/registry.ts'

const DIR_SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

describe('knowledge registry, sourceDir validation, and worker path resolution', () => {
  it('derives isolated knowledge workspace paths and rejects path traversal ids', () => {
    expect(neutralKnowledgeBaseDir('/p')).toBe(join('/p', 'workspace-knowledge'))
    expect(neutralKnowledgeRootPath('/p', 'kb-1')).toBe(join('/p', 'workspace-knowledge', 'kb-1'))
    expect(neutralKnowledgeWikiRootPath('/p', 'kb-1')).toBe(join('/p', 'workspace-knowledge', 'kb-1', 'wiki'))
    expect(() => neutralKnowledgeRootPath('/p', '../escape')).toThrow()
  })

  it('rejects UNC, Windows device paths, profileDir/child/ancestor, symlinks/junctions to forbidden dirs, and nested/ancestor KBs; allows project overlap', async () => {
    expect(isUncOrDevicePath('\\\\server\\share\\docs')).toBe(true)
    expect(isUncOrDevicePath('//server/share/docs')).toBe(true)
    expect(isUncOrDevicePath('\\\\.\\PhysicalDrive0')).toBe(true)
    expect(isUncOrDevicePath('\\\\?\\C:\\docs')).toBe(true)

    const root = mkdtempSync(join(tmpdir(), 'kb-paths-'))
    const profileDir = join(root, 'profile')
    const profileSub = join(profileDir, 'sub')
    const docsParent = join(root, 'docs-parent')
    const kbA = join(docsParent, 'docs-a')
    const kbASub = join(kbA, 'nested')
    const projectDir = join(root, 'registered-project')
    const linkToProfile = join(root, 'link-profile')
    const linkToKbA = join(root, 'link-kba')
    mkdirSync(profileSub, { recursive: true })
    mkdirSync(kbASub, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    symlinkSync(profileSub, linkToProfile, DIR_SYMLINK_TYPE)
    symlinkSync(kbASub, linkToKbA, DIR_SYMLINK_TYPE)

    await expect(validateSourceDir({ sourceDir: profileDir, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: profileSub, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: root, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: linkToProfile, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })

    const existing = [{
      id: 'kb-a', name: 'A', sourceDir: kbA, autoOrganize: true, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z',
    }]
    await expect(validateSourceDir({ sourceDir: kbA, profileDir, existing })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: kbASub, profileDir, existing })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: docsParent, profileDir, existing })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: linkToKbA, profileDir, existing })).resolves.toMatchObject({ ok: false })

    // Rebinding kb-a succeeds when ignoreKbId is set; overlapping a registered project dir is allowed (spec §5.2(4))
    await expect(validateSourceDir({ sourceDir: kbA, profileDir, existing, ignoreKbId: 'kb-a' })).resolves.toMatchObject({ ok: true })
    await expect(validateSourceDir({ sourceDir: projectDir, profileDir, existing })).resolves.toMatchObject({ ok: true })
  })

  it('writes knowledge-bases.json and settings.json atomically with 0o600 on POSIX', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-reg-'))
    const profileDir = join(root, 'profile')
    const validDocsDir = join(root, 'valid-docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(validDocsDir, { recursive: true })
    await writeHuaanworkSettings(profileDir, { model: 'test-model' })
    await writeKnowledgeBases(profileDir, [{
      id: 'kb-1', name: '法务库', sourceDir: validDocsDir, autoOrganize: true, watchPaused: true, createdAt: '2026-11-25T00:00:00.000Z',
    }])
    const loaded = await readKnowledgeBases(profileDir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.watchPaused).toBe(true)
    expect(loaded[0]?.sourceDir).toBe(validDocsDir)
    if (process.platform !== 'win32') {
      expect(statSync(join(profileDir, 'knowledge-bases.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(profileDir, 'huaanwork-settings.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('probes directory case sensitivity without creating files and handles non-ASCII leaf names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-CaseProbe-'))
    const nonAsciiDir = join(root, '资料库')
    mkdirSync(nonAsciiDir, { recursive: true })
    const beforeRoot = readdirSync(root)
    const beforeLeaf = readdirSync(nonAsciiDir)
    const res1 = await probeCaseSensitiveDir(root)
    const res2 = await probeCaseSensitiveDir(nonAsciiDir)
    expect(typeof res1).toBe('boolean')
    expect(typeof res2).toBe('boolean')
    expect(readdirSync(root)).toEqual(beforeRoot)
    expect(readdirSync(nonAsciiDir)).toEqual(beforeLeaf)
  })

  it('resolves worker URLs independently of caller chunk depth in both src (.ts, including zero-arg call) and lib (.js)', () => {
    const pkgRoot = fileURLToPath(new URL('../../', import.meta.url))
    const fromSrcDepth3 = pathToFileURL(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', 'storage-client.ts')).href
    const fromLibDepth2 = pathToFileURL(join(pkgRoot, 'lib', 'huaanwork-host', 'index.js')).href
    const fromLibDepth1Chunk = pathToFileURL(join(pkgRoot, 'lib', 'packaged-runtime-smoke.js')).href

    // R3-B2 regression: zero-arg call from Vitest source tree MUST resolve to src/.../*.ts, not lib/.../*.js
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('storage-worker')))
      .toBe(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', 'storage-worker.ts'))
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('storage-worker', fromSrcDepth3)))
      .toBe(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', 'storage-worker.ts'))
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('storage-worker', fromLibDepth2)))
      .toBe(join(pkgRoot, 'lib', 'huaanwork-host', 'knowledge', 'storage-worker.js'))
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('extraction-worker', fromLibDepth1Chunk)))
      .toBe(join(pkgRoot, 'lib', 'huaanwork-host', 'knowledge', 'extraction-worker.js'))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-registry.spec.ts
```
Expected: FAIL，模块与导出尚未创建。

- [ ] **Step 3: 实现目录派生、Worker 路径解析、路径校验、`writeHuaanworkSettings` 原子 0o600 与注册表读写**

1. `workspace-state.ts` 新增：
```ts
export function neutralKnowledgeBaseDir(profileDir: string): string {
  return join(profileDir, 'workspace-knowledge')
}

export function neutralKnowledgeRootPath(profileDir: string, kbId: string): string {
  return join(neutralKnowledgeBaseDir(profileDir), assertSafePathSegment(kbId, 'kbId'))
}

export function neutralKnowledgeWikiRootPath(profileDir: string, kbId: string): string {
  return join(neutralKnowledgeRootPath(profileDir, kbId), 'wiki')
}
```
2. `settings.ts` 改为导入 `writeFileAtomic` from `'@deepseek-ai/dsh-atomic-write'`，在 `writeHuaanworkSettings` 用 `await writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })`。
3. `knowledge/types.ts` 逐字实现上方 Interfaces 中的全部常量与类型。
4. `knowledge/worker-paths.ts`（**R3-B2 修复**）：
   - 统一 `const callerUrl = fromUrl ?? import.meta.url`、`const callerPath = fileURLToPath(callerUrl)`，从 `dirname(callerPath)` 向上查找包含 `package.json` 的包根 `pkgRoot`（最多 8 层）；
   - 通过 `const relFromPkg = relative(pkgRoot, callerPath)` 跨平台（兼容 POSIX `/` 与 Windows `\`）判断 `const isSource = callerPath.endsWith('.ts') && relFromPkg.split(/[/\\]/u)[0] === 'src'`；
   - `isSource ? pathToFileURL(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', `${kind}.ts`)) : pathToFileURL(join(pkgRoot, 'lib', 'huaanwork-host', 'knowledge', `${kind}.js`))`。
5. `knowledge/paths.ts`：
   - `isUncOrDevicePath(raw)`: 匹配 `/^\\\\/`（覆盖 `\\server\share`、`\\.\`、`\\?\`）与 `/^\/\//`。
   - `validateSourceDir`: 先拒空串与 UNC/设备路径 → `realpath` 并校验 `stat().isDirectory()` 与 `access(R_OK)` → `realpath(profileDir)` 后按规范路径（区分大小写按卷/平台收窄）拒绝等于 `profileDir`、为其子目录或其祖先目录 → 逐条对 `existing`（跳过 `ignoreKbId`）做 `realpath`（已不可用时回退 `resolve`）拒绝相同、子目录或祖先目录。允许与已注册项目目录重叠。
   - `probeCaseSensitiveDir(dirPath, platform = process.platform)`: 从 `dirPath` 逐级向上找到首个 `basename` 含 ASCII 字母 `[A-Za-z]` 的已存在目录，翻转其首字母大小写构造变体路径并用 `lstat({ bigint: true })` / `realpath` 对比 `(dev, ino)` 是否相同（相同 → `false`，`ENOENT` 或 `(dev, ino)` 不同 → `true`）；若整条祖先链均无 ASCII 字母（或探测出错），按 `platform === 'linux'` 保守回退。绝不创建任何文件。
6. `knowledge/registry.ts`: `readKnowledgeBases` 读 `<profileDir>/knowledge-bases.json`（缺失返回 `[]`，逐条字段校验）；`writeKnowledgeBases` 按 `profileDir` 串行 Promise 队列 + `writeFileAtomic(path, `${JSON.stringify({ knowledgeBases }, null, 2)}\n`, { mode: 0o600 })`。

- [ ] **Step 4: 运行测试与双套类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-registry.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.json --noEmit && corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts dsh-plugin-huaanwork/src/huaanwork-host/settings.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/ dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-registry.spec.ts
git commit -m "feat(knowledge): add registry, isolated workspace paths, worker path resolver, and atomic 0o600 settings"
```

---

### Task 2: 脱敏事件日志（`events.jsonl`）与 Checkpoint / 诊断包排除验证

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/events.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-events.spec.ts`

**Interfaces:**
- Produces in `knowledge/events.ts`:
  - `EVENT_MAX_LINES = 500`、`EVENT_MAX_BYTES = 512 * 1024`、`EVENT_SUMMARY_MAX_BYTES = 512`、`EVENT_DETAIL_MAX_BYTES = 4 * 1024`；
  - `KnowledgeEventFilter = 'all' | 'alerts' | 'organize' | 'sync'`；
  - `EVENT_FILTER_BY_KIND: Readonly<Record<KnowledgeEventKind, Exclude<KnowledgeEventFilter, 'all'>>>`（编译期完备映射到 3 个具体胶囊）：
    - `'alerts'`：`file_skipped`、`file_error`、`rebuild_failed`、`wiki_reset_failed`、`organize_failed`、`source_unavailable`、`watch_failed`；
    - `'organize'`：`organize_started`、`organize_completed`、`organize_cancelled`（`organize_failed` 归 `'alerts'`，同时 `'organize'` 胶囊也可由 `matchesEventFilter(event, filter)` 兼含全部 `organize_*`）；
    - `'sync'`：`sync_started`、`sync_completed`、`file_indexed`、`file_renamed`、`file_deleted`、`source_rebound`、`rebuild_completed`、`source_restored`、`cloud_probe_unavailable`；
  - `appendKnowledgeEvent(kbDir: string, input: Omit<KnowledgeEventRecord, 'id' | 'at'> & { id?: string; at?: string }): Promise<KnowledgeEventRecord>`；
  - `readKnowledgeEvents(kbDir: string, opts?: { limit?: number; filter?: KnowledgeEventFilter }): Promise<KnowledgeEventRecord[]>`。
- Consumes: `maskSecrets` from `../../mask-secrets.ts`；测试消费 `createDesktopProfileCheckpoint` / `DESKTOP_PROFILE_CHECKPOINT_FILES` from `../../src/profile-checkpoint.ts` 与 `exportDesktopDiagnostics` from `../../src/diagnostic-export.ts`。

- [ ] **Step 1: 写事件脱敏、体积裁剪、四胶囊筛选与真实 checkpoint / 诊断包排除失败测试**

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import {
  appendKnowledgeEvent,
  EVENT_DETAIL_MAX_BYTES,
  EVENT_MAX_BYTES,
  EVENT_MAX_LINES,
  EVENT_SUMMARY_MAX_BYTES,
  readKnowledgeEvents,
} from '../../src/huaanwork-host/knowledge/events.ts'
import {
  createDesktopProfileCheckpoint,
  DESKTOP_PROFILE_CHECKPOINT_FILES,
} from '../../src/profile-checkpoint.ts'
import { exportDesktopDiagnostics } from '../../src/diagnostic-export.ts'

describe('knowledge events log and checkpoint/diagnostics exclusion', () => {
  it('masks secrets before UTF-8 byte truncation and enforces 500 lines / 512 KB bounds', async () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-events-'))
    const longDetail = `Bearer sk-secret-token-1234567890 api_key=abc123456789 ${'中文详情'.repeat(2_000)}`
    const ev = await appendKnowledgeEvent(kbDir, {
      kind: 'file_error',
      level: 'error',
      summary: `失败 sk-1234567890abcdef ${'标题'.repeat(300)}`,
      detail: longDetail,
    })
    expect(ev.summary).not.toContain('sk-1234567890abcdef')
    expect(ev.detail).not.toContain('sk-secret-token-1234567890')
    expect(Buffer.byteLength(ev.summary, 'utf8')).toBeLessThanOrEqual(EVENT_SUMMARY_MAX_BYTES)
    expect(Buffer.byteLength(ev.detail ?? '', 'utf8')).toBeLessThanOrEqual(EVENT_DETAIL_MAX_BYTES)

    for (let i = 0; i < 550; i += 1) {
      await appendKnowledgeEvent(kbDir, {
        kind: 'file_indexed',
        level: 'info',
        summary: `indexed-${i}`,
        detail: 'd'.repeat(1_200),
      })
    }
    const raw = readFileSync(join(kbDir, 'events.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(EVENT_MAX_LINES)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(EVENT_MAX_BYTES)
    if (process.platform !== 'win32') {
      expect(statSync(join(kbDir, 'events.jsonl')).mode & 0o777).toBe(0o600)
    }
  })

  it('filters events cleanly across all / alerts / organize / sync pills', async () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-ev-filter-'))
    await appendKnowledgeEvent(kbDir, { kind: 'sync_completed', level: 'info', summary: 'sync done' })
    await appendKnowledgeEvent(kbDir, { kind: 'watch_failed', level: 'warn', summary: 'watch down' })
    await appendKnowledgeEvent(kbDir, { kind: 'organize_failed', level: 'error', summary: 'org err' })
    await appendKnowledgeEvent(kbDir, { kind: 'organize_completed', level: 'info', summary: 'org ok' })
    await appendKnowledgeEvent(kbDir, { kind: 'cloud_probe_unavailable', level: 'info', summary: 'probe fallback' })

    expect((await readKnowledgeEvents(kbDir, { filter: 'all' })).length).toBe(5)
    expect((await readKnowledgeEvents(kbDir, { filter: 'alerts' })).map(e => e.kind)).toEqual(['watch_failed', 'organize_failed'])
    expect((await readKnowledgeEvents(kbDir, { filter: 'organize' })).map(e => e.kind)).toEqual(['organize_failed', 'organize_completed'])
    expect((await readKnowledgeEvents(kbDir, { filter: 'sync' })).map(e => e.kind)).toEqual(['sync_completed', 'cloud_probe_unavailable'])
  })

  it('excludes all knowledge files and directories from profile checkpoints and diagnostics zips', async () => {
    for (const forbidden of ['knowledge-bases.json', 'session-knowledge.json', 'session-citations', 'workspace-knowledge']) {
      expect(DESKTOP_PROFILE_CHECKPOINT_FILES as readonly string[]).not.toContain(forbidden)
    }

    const root = mkdtempSync(join(tmpdir(), 'kb-excl-'))
    const userDataDir = join(root, 'user-data')
    const profileDir = join(root, 'profiles', 'default')
    const homeDir = join(root, 'home')
    mkdirSync(join(profileDir, 'workspace-knowledge', 'kb-1', 'wiki'), { recursive: true })
    mkdirSync(join(profileDir, 'session-citations'), { recursive: true })
    mkdirSync(join(userDataDir, 'workspace-knowledge', 'kb-1'), { recursive: true })
    mkdirSync(join(userDataDir, 'session-citations'), { recursive: true })
    mkdirSync(join(userDataDir, 'logs'), { recursive: true })
    mkdirSync(homeDir, { recursive: true })

    writeFileSync(join(profileDir, 'package.json'), '{"name":"p","private":true}\n')
    writeFileSync(join(profileDir, 'knowledge-bases.json'), '{"knowledgeBases":[]}\n')
    writeFileSync(join(profileDir, 'session-knowledge.json'), '{}\n')
    writeFileSync(join(profileDir, 'session-citations', 's1.json'), '{"secret":"kb-private"}\n')
    writeFileSync(join(profileDir, 'workspace-knowledge', 'kb-1', 'index.sqlite'), 'sqlite-bytes')
    writeFileSync(join(profileDir, 'workspace-knowledge', 'kb-1', 'wiki', 'INDEX.md'), '# private')

    // 1. Real profile checkpoint capture must exclude all 4 knowledge paths
    const checkpoint = createDesktopProfileCheckpoint({ userDataDir, profileDir, homeDir })
    const captured = checkpoint.captureHealthy()
    expect(captured.status).toBe('captured')
    if (captured.status === 'captured') {
      const snapNames = captured.manifest.files.map(f => f.name as string)
      expect(snapNames).not.toContain('knowledge-bases.json')
      expect(snapNames).not.toContain('session-knowledge.json')
      expect(existsSync(join(captured.snapshotDirectory, 'knowledge-bases.json'))).toBe(false)
      expect(existsSync(join(captured.snapshotDirectory, 'workspace-knowledge'))).toBe(false)
      expect(existsSync(join(captured.snapshotDirectory, 'session-citations'))).toBe(false)
    }

    // 2. Real diagnostics zip must never bundle knowledge files even if placed beside logs/userDataDir
    writeFileSync(join(userDataDir, 'knowledge-bases.json'), '{"secret":true}\n')
    writeFileSync(join(userDataDir, 'session-knowledge.json'), '{"secret":true}\n')
    writeFileSync(join(userDataDir, 'workspace-knowledge', 'kb-1', 'index.sqlite'), 'sqlite-bytes')
    writeFileSync(join(userDataDir, 'session-citations', 's1.json'), '{}')
    writeFileSync(join(userDataDir, 'logs', 'dsh-2026-11-25.log'), 'normal log\n')

    const zipPath = await exportDesktopDiagnostics(userDataDir, { appVersion: '1.0.0-test' })
    const entryNames = new AdmZip(zipPath).getEntries().map(e => e.entryName)
    for (const name of entryNames) {
      expect(name).not.toMatch(/knowledge-bases\.json|session-knowledge\.json|session-citations|workspace-knowledge/u)
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-events.spec.ts
```
Expected: FAIL，`knowledge/events.ts` 不存在。

- [ ] **Step 3: 实现 `knowledge/events.ts`**

- 先走 `maskSecrets()` 再按 UTF-8 字节边界安全截断 `summary`（≤ 512 B）与 `detail`（≤ 4 KB，不得劈裂多字节 UTF-8 字符）。
- 每次追加通过按 `kbDir` 索引的串行 Promise 链读现有行 + 追加新 JSON 行 + 从头部丢弃最旧条目直到 `lines.length <= EVENT_MAX_LINES && Buffer.byteLength(payload, 'utf8') <= EVENT_MAX_BYTES` + `writeFileAtomic(eventsPath, payload, { mode: 0o600 })`。
- `matchesEventFilter(event, filter)`：`'all'` 全命中；`'alerts'` 命中 `file_skipped | file_error | rebuild_failed | wiki_reset_failed | organize_failed | source_unavailable | watch_failed`；`'organize'` 命中全部 `organize_*`；`'sync'` 命中 `sync_started | sync_completed | file_indexed | file_renamed | file_deleted | source_rebound | rebuild_completed | source_restored | cloud_probe_unavailable`。

- [ ] **Step 4: 运行测试与双套类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-events.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.json --noEmit && corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/events.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-events.spec.ts
git commit -m "feat(knowledge): add redacted bounded event log and checkpoint/diagnostics exclusion tests"
```

---

### Task 3: 中文分词、FTS5 安全查询、文档切片器与多库倒数排名归并

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/tokenizer.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/chunker.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/ranker.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-text-search.spec.ts`

**Interfaces:**
- Produces in `tokenizer.ts`:
  - `tokenizeForFts(text: string): string`（说明：对长度 ≥ 2 的连续汉字同时发全部单字 unigram 与相邻 bigram，以同时满足规格 §7.2 双字精度与 §11.1(4)「单字查多字词」召回，如单字「税」命中「税率」；在单库 50,000 切片上限下索引增量可控；英文数字保留小写整词）；
  - `buildSafeFtsQuery(rawQuery: string): string`（去 FTS5 运算符 `- : * ^ ( ) " +` 及独立关键词 `AND / OR / NOT / NEAR`，用 `tokenizeForFts` 分词去重，最多取前 24 词，逐词用双引号包裹并以空格连接）。
- Produces in `chunker.ts`:
  - 复用 `ChunkDraft`（from `./types.ts`，不重复声明）；
  - `chunkExtractedDocument(doc: ExtractedDocument, opts?: { maxChunks?: number; maxTextBytes?: number }): { chunks: ChunkDraft[]; truncated: boolean }`（目标 500–800 字、重叠 ~100 字、默认上限 `MAX_CHUNKS_PER_DOC = 500` 与 `MAX_DOC_TEXT_BYTES = 10 MB`、`sheet` 每片附 `headerRow`）。
- Produces in `ranker.ts`:
  - `SingleKbCandidate { kbId: string; kbName: string; docId: string; relPath: string; sha256: string; extractConfigHash: string; chunkId: string; ordinal: number; headingPath: string; locator: ChunkLocator; content: string; bm25: number }`；
  - `rerankSingleKbCandidates(candidates: readonly SingleKbCandidate[], rawQuery: string, limit?: number): SingleKbCandidate[]`（默认 Top-60 → 原短语与邻近度加分 → 取前 30）；
  - `mergeMultiKbResults(perKbLists: readonly (readonly SingleKbCandidate[])[], rawQuery: string, topK?: number): Array<SingleKbCandidate & { score: number }>`（按 `1 / (60 + rankInKb)` + 精确原短语小权重归并，`topK` 默认 8、硬上限 20）。

- [ ] **Step 1: 写中文单/双字分词、FTS 运算符防护、切片与文本上限、多库倒数排名归并失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { buildSafeFtsQuery, tokenizeForFts } from '../../src/huaanwork-host/knowledge/tokenizer.ts'
import { chunkExtractedDocument } from '../../src/huaanwork-host/knowledge/chunker.ts'
import { mergeMultiKbResults, rerankSingleKbCandidates, type SingleKbCandidate } from '../../src/huaanwork-host/knowledge/ranker.ts'
import type { ExtractedDocument } from '../../src/huaanwork-host/knowledge/types.ts'

describe('knowledge tokenizer, chunker, and ranker', () => {
  it('tokenizes Han runs into unigrams and bigrams while keeping lowercase alphanumeric words', () => {
    const tokens = tokenizeForFts('C类基金税率2026').split(' ')
    expect(tokens).toContain('c')
    expect(tokens).toContain('类')
    expect(tokens).toContain('基')
    expect(tokens).toContain('税')
    expect(tokens).toContain('率')
    expect(tokens).toContain('类基')
    expect(tokens).toContain('基金')
    expect(tokens).toContain('税率')
    expect(tokens).toContain('2026')
  })

  it('strips FTS5 operators and wraps each term in double quotes', () => {
    const q = buildSafeFtsQuery('foo-bar:baz OR AND NOT NEAR * ^ ( ) "税率"')
    expect(q).not.toMatch(/\b(?:OR|AND|NOT|NEAR)\b/u)
    expect(q).toContain('"foo"')
    expect(q).toContain('"bar"')
    expect(q).toContain('"baz"')
    expect(q).toContain('"税率"')
    expect(buildSafeFtsQuery('   --- ::: *** () ""  ')).toBe('')
  })

  it('caps chunks at 500, enforces maxTextBytes, and repeats headerRow on every sheet chunk', () => {
    const hugeSections = Array.from({ length: 600 }, (_, i) => ({
      headingPath: `H${i}`,
      locator: { kind: 'line' as const, startLine: i + 1, endLine: i + 1 },
      text: `第${i}段内容`.repeat(30),
    }))
    const doc: ExtractedDocument = {
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg1',
      status: 'indexed',
      sections: hugeSections,
    }
    const capped = chunkExtractedDocument(doc)
    expect(capped.chunks).toHaveLength(500)
    expect(capped.truncated).toBe(true)

    const byteCapped = chunkExtractedDocument(doc, { maxTextBytes: 2_048 })
    expect(byteCapped.truncated).toBe(true)
    const totalBytes = byteCapped.chunks.reduce((sum, c) => sum + Buffer.byteLength(c.content, 'utf8'), 0)
    expect(totalBytes).toBeLessThanOrEqual(4_096)

    const sheetDoc: ExtractedDocument = {
      format: 'xlsx',
      extractMode: 'text',
      extractConfigHash: 'cfg1',
      status: 'indexed',
      sections: [{
        headingPath: 'Sheet1',
        locator: { kind: 'sheet', sheet: 'Sheet1', rowStart: 2, rowEnd: 200 },
        headerRow: '基金代码 | 税率 | 备注',
        text: Array.from({ length: 80 }, (_, i) => `000${i} | 1.5% | ${'说明'.repeat(12)}`).join('\n'),
      }],
    }
    const sheetRes = chunkExtractedDocument(sheetDoc)
    expect(sheetRes.chunks.length).toBeGreaterThan(1)
    for (const chunk of sheetRes.chunks) {
      expect(chunk.content.startsWith('基金代码 | 税率 | 备注')).toBe(true)
    }
  })

  it('merges disparate-scale KBs fairly by reciprocal rank and enforces topK <= 20', () => {
    const make = (kbId: string, ordinal: number, content: string, bm25: number): SingleKbCandidate => ({
      kbId,
      kbName: kbId,
      docId: `${kbId}-d${ordinal}`,
      relPath: `a-${ordinal}.md`,
      sha256: 'h1',
      extractConfigHash: 'c1',
      chunkId: `${kbId}-c${ordinal}`,
      ordinal,
      headingPath: '',
      locator: { kind: 'line', startLine: 1, endLine: 2 },
      content,
      bm25,
    })
    const kbBig = Array.from({ length: 15 }, (_, i) => make('big', i, i === 0 ? '包含普通基金说明' : `条目${i}`, -100 + i))
    const kbSmall = Array.from({ length: 15 }, (_, i) => make('small', i, i === 0 ? '精准命中 C类基金税率 条款' : `条目${i}`, -0.5 + i * 0.01))

    const merged = mergeMultiKbResults([rerankSingleKbCandidates(kbBig, 'C类基金税率'), rerankSingleKbCandidates(kbSmall, 'C类基金税率')], 'C类基金税率', 99)
    expect(merged).toHaveLength(20)
    expect(merged[0]?.kbId).toBe('small')
    expect(merged[1]?.kbId).toBe('big')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-text-search.spec.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `tokenizer.ts`、`chunker.ts`、`ranker.ts`**

- `tokenizer.ts`：扫描 `/\p{Script=Han}+|[A-Za-z0-9_]+/gu`，对长度 ≥ 2 的汉字串同时输出单字与相邻双字，英文数字小写输出；`buildSafeFtsQuery` 剥离 `- : * ^ ( ) " +` 及独立大写关键词 `AND|OR|NOT|NEAR`，再分词去重、截断 24 词并双引号包裹。
- `chunker.ts`：追踪已消费原始文本 UTF-8 字节数不超过 `maxTextBytes`（默认 `MAX_DOC_TEXT_BYTES`），单 section > 800 字按段落/句号/换行滑窗切 500–800 字、重叠 ~100 字；`locator.kind === 'sheet'` 且含 `headerRow` 时每片头部预置 `${headerRow}\n`；超 `maxChunks`（默认 500）置 `truncated: true`。
- `ranker.ts`：`rerankSingleKbCandidates` 对输入前 60 条计算原短语精确命中与词项邻近加分，稳定输出前 `limit`（默认 30）；`mergeMultiKbResults` 按 `1 / (60 + rankInKb)`（`rankInKb` 从 1 起）加精确原短语小权重（`0.002`），截断至 `Math.max(1, Math.min(topK ?? 8, 20))`。

- [ ] **Step 4: 运行测试与双套类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-text-search.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.json --noEmit && corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/tokenizer.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/chunker.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/ranker.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-text-search.spec.ts
git commit -m "feat(knowledge): add CJK FTS5 tokenizer, document chunker, and multi-KB ranker"
```

---

### Task 4: Storage Worker（独占 `node:sqlite` + 规格 §7.1 完整 Schema + Step 2 提交点重建与崩溃恢复）

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-protocol.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-worker.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-client.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-storage.spec.ts`

**Interfaces:**
- Produces in `storage-protocol.ts`:
  ```ts
  export type StorageWorkerRequest =
    | { readonly id: number; readonly op: 'openKb'; readonly kbId: string; readonly kbDir: string }
    | { readonly id: number; readonly op: 'closeKb'; readonly kbId: string }
    | { readonly id: number; readonly op: 'upsertDocument'; readonly kbId: string; readonly input: UpsertDocumentInput }
    | { readonly id: number; readonly op: 'updateDocumentMetadata'; readonly kbId: string; readonly relPath: string; readonly size: number; readonly mtimeMs: number }
    | { readonly id: number; readonly op: 'renameDocument'; readonly kbId: string; readonly fromRelPath: string; readonly toRelPath: string; readonly toNormPath: string }
    | { readonly id: number; readonly op: 'deleteDocument'; readonly kbId: string; readonly relPath: string }
    | { readonly id: number; readonly op: 'listDocs'; readonly kbId: string; readonly filter?: ListDocsFilter }
    | { readonly id: number; readonly op: 'searchFts'; readonly kbId: string; readonly kbName: string; readonly query: string; readonly limit?: number }
    | { readonly id: number; readonly op: 'getChunk'; readonly kbId: string; readonly docId: string; readonly ordinal: number; readonly window: number; readonly expectedSha256?: string; readonly expectedExtractConfigHash?: string }
    | { readonly id: number; readonly op: 'beginRebuild'; readonly kbId: string; readonly kbDir: string }
    | { readonly id: number; readonly op: 'upsertRebuildDocument'; readonly kbId: string; readonly input: UpsertDocumentInput }
    | { readonly id: number; readonly op: 'commitRebuild'; readonly kbId: string; readonly kbDir: string }
    | { readonly id: number; readonly op: 'abortRebuild'; readonly kbId: string; readonly kbDir: string }
    | { readonly id: number; readonly op: 'retryPendingWikiReset'; readonly kbId: string; readonly kbDir: string }
    | { readonly id: number; readonly op: 'recordOrganizeFailure'; readonly kbId: string; readonly docId: string; readonly sha256: string; readonly error: string; readonly nowMs: number }
    | { readonly id: number; readonly op: 'resetOrganizeFailures'; readonly kbId: string; readonly docId?: string }
    | { readonly id: number; readonly op: 'markOrganizedAtomic'; readonly kbId: string; readonly docId: string; readonly sha256: string; readonly wikiNotePath: string; readonly clearedTombstones?: readonly string[] }
    | { readonly id: number; readonly op: 'getPendingOrganizeBatch'; readonly kbId: string; readonly nowMs: number; readonly maxDocs?: number; readonly maxBytes?: number }
    | { readonly id: number; readonly op: 'getDocChunks'; readonly kbId: string; readonly docId: string; readonly startOrdinal: number; readonly limit: number }
    | { readonly id: number; readonly op: 'getStats'; readonly kbId: string }
    | { readonly id: number; readonly op: 'checkpoint'; readonly kbId: string }
    | { readonly id: number; readonly op: 'putEmbedding'; readonly kbId: string; readonly chunkId: string; readonly modelKey: string; readonly dims: number; readonly vector: Uint8Array }
    | { readonly id: number; readonly op: 'countEmbeddings'; readonly kbId: string; readonly docId: string }
    | { readonly id: number; readonly op: 'shutdown' }

  export interface StorageResultMap {
    readonly openKb: { readonly ok: true; readonly wikiResetPending: boolean } | { readonly ok: false; readonly code: 'index-error'; readonly error: string }
    readonly closeKb: void
    readonly upsertDocument: { readonly docId: string; readonly chunkIds: readonly string[]; readonly chunkCapExceeded: boolean }
    readonly updateDocumentMetadata: void
    readonly renameDocument: { readonly renamed: boolean; readonly docId?: string }
    readonly deleteDocument: { readonly deleted: boolean; readonly tombstoneWritten: boolean }
    readonly listDocs: ListDocsResult
    readonly searchFts: readonly SingleKbCandidate[]
    readonly getChunk: GetChunkResult
    readonly beginRebuild: { readonly corruptRecovery: boolean }
    readonly upsertRebuildDocument: { readonly docId: string; readonly chunkCapExceeded: boolean }
    readonly commitRebuild: { readonly ok: true; readonly corruptRecovery: boolean; readonly wikiResetPending: boolean } | { readonly ok: false; readonly code: 'index-error' | 'rebuild-failed'; readonly error: string }
    readonly abortRebuild: void
    readonly retryPendingWikiReset: { readonly ok: true } | { readonly ok: false; readonly error: string }
    readonly recordOrganizeFailure: { readonly attempts: number; readonly retryAfter: number | null }
    readonly resetOrganizeFailures: void
    readonly markOrganizedAtomic: { readonly updated: boolean }
    readonly getPendingOrganizeBatch: PendingOrganizeBatch
    readonly getDocChunks: readonly ChunkWindowItem[]
    readonly getStats: KnowledgeBaseStats
    readonly checkpoint: void
    readonly putEmbedding: void
    readonly countEmbeddings: number
    readonly shutdown: void
  }

  export type StorageWorkerResponse<K extends keyof StorageResultMap = keyof StorageResultMap> =
    | { readonly id: number; readonly ok: true; readonly result: StorageResultMap[K] }
    | { readonly id: number; readonly ok: false; readonly code?: KnowledgeErrorCode | 'rebuild-failed'; readonly error: string }
  ```
- SQLite Schema DDL（`storage-db.ts` 逐字锁定规格 §7.1，应用 5 个 PRAGMA 与 `user_version = 1`）：
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_size_limit = 33554432;
  PRAGMA wal_autocheckpoint = 1000;

  CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    norm_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    format TEXT NOT NULL,
    extract_mode TEXT NOT NULL,
    extract_config_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    wiki_note_path TEXT,
    organized_sha256 TEXT,
    organize_attempts INTEGER NOT NULL DEFAULT 0,
    organize_retry_after INTEGER,
    last_organize_error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_documents_norm_path ON documents(norm_path);

  CREATE TABLE IF NOT EXISTS organize_tombstones (
    doc_id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL,
    wiki_note_path TEXT,
    deleted_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    heading_path TEXT NOT NULL DEFAULT '',
    locator_json TEXT NOT NULL,
    content TEXT NOT NULL,
    tokenized TEXT NOT NULL,
    char_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_doc_ordinal ON chunks(doc_id, ordinal);

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    rel_path,
    heading_path,
    tokenized,
    tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS chunk_embeddings (
    chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    model_key TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chunk_id, model_key)
  );
  CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(model_key);
  ```
- Produces in `storage-db.ts`: `recoverKnowledgeDbDir(kbDir)`、`openKnowledgeDb(kbDir)`（返回 `{ ok: true, db, wikiResetPending: boolean } | { ok: false, code: 'index-error', error: string }`，绝不因 `SQLITE_CORRUPT` / `quick_check` 失败打崩 Worker）、`upsertDocumentWithChunks(db, input, opts?: { maxChunksPerKb?: number })`、`updateDocumentMetadata`、`renameDocument`、`deleteDocument`、`listDocs(db, filter?)`（`limit` 默认 50、上限 200）、`searchFts`、`getChunkWithWindow`、`beginRebuildStaging(kbDir)`、`commitRebuildStaging(kbDir, staging, opts?: { afterCommitBeforeReopenForTest?: () => void; failWikiResetOnceForTest?: () => void })`、`abortRebuildStaging(kbDir, staging)`、`retryPendingWikiReset(kbDir)`、`recordOrganizeFailure`、`resetOrganizeFailures`、`markOrganizedAtomic`、`getPendingOrganizeBatch`、`getDocChunks`、`getStats`。
- Produces in `storage-client.ts`: `createKnowledgeStorageClient(opts?: { workerUrl?: URL }): KnowledgeStorageClient`（**惰性拉起** Worker），其中 `KnowledgeStorageClient` 暴露与 `StorageResultMap` 一一对应的强类型异步方法：
  ```ts
  export interface KnowledgeStorageClient {
    openKb(kbId: string, kbDir: string): Promise<StorageResultMap['openKb']>
    closeKb(kbId: string): Promise<void>
    upsertDocument(kbId: string, input: UpsertDocumentInput): Promise<StorageResultMap['upsertDocument']>
    updateDocumentMetadata(kbId: string, relPath: string, size: number, mtimeMs: number): Promise<void>
    renameDocument(kbId: string, input: { fromRelPath: string; toRelPath: string; toNormPath: string }): Promise<StorageResultMap['renameDocument']>
    deleteDocument(kbId: string, relPath: string): Promise<StorageResultMap['deleteDocument']>
    listDocs(kbId: string, filter?: ListDocsFilter): Promise<ListDocsResult>
    searchFts(kbId: string, kbName: string, query: string, limit?: number): Promise<readonly SingleKbCandidate[]>
    getChunk(kbId: string, query: { docId: string; ordinal: number; window: number; expectedSha256?: string; expectedExtractConfigHash?: string }): Promise<GetChunkResult>
    beginRebuild(kbId: string, kbDir: string): Promise<StorageResultMap['beginRebuild']>
    upsertRebuildDocument(kbId: string, input: UpsertDocumentInput): Promise<StorageResultMap['upsertRebuildDocument']>
    commitRebuild(kbId: string, kbDir: string, opts?: { afterCommitBeforeReopenForTest?: () => void; failWikiResetOnceForTest?: () => void }): Promise<StorageResultMap['commitRebuild']>
    abortRebuild(kbId: string, kbDir: string): Promise<void>
    retryPendingWikiReset(kbId: string, kbDir: string): Promise<StorageResultMap['retryPendingWikiReset']>
    recordOrganizeFailure(kbId: string, docId: string, sha256: string, error: string, nowMs: number): Promise<StorageResultMap['recordOrganizeFailure']>
    resetOrganizeFailures(kbId: string, docId?: string): Promise<void>
    markOrganizedAtomic(kbId: string, docId: string, sha256: string, wikiNotePath: string, clearedTombstones?: readonly string[]): Promise<StorageResultMap['markOrganizedAtomic']>
    getPendingOrganizeBatch(kbId: string, nowMs: number, opts?: { maxDocs?: number; maxBytes?: number }): Promise<PendingOrganizeBatch>
    getDocChunks(kbId: string, docId: string, startOrdinal: number, limit: number): Promise<readonly ChunkWindowItem[]>
    getStats(kbId: string): Promise<KnowledgeBaseStats>
    checkpoint(kbId: string): Promise<void>
    putEmbedding(kbId: string, chunkId: string, modelKey: string, dims: number, vector: Uint8Array): Promise<void>
    countEmbeddings(kbId: string, docId: string): Promise<number>
    isRunning(): boolean
    dispose(budgetMs?: number): Promise<void>
  }
  ```

- [ ] **Step 1: 写 SQLite Schema、FTS 同步、重命名与大小写、版本指纹、50,000 切片上限、损坏降级与 Step 1/Step 2/Wiki 崩溃恢复失败测试**

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  beginRebuildStaging,
  commitRebuildStaging,
  deleteDocument,
  getChunkWithWindow,
  markOrganizedAtomic,
  openKnowledgeDb,
  renameDocument,
  retryPendingWikiReset,
  searchFts,
  upsertDocumentWithChunks,
} from '../../src/huaanwork-host/knowledge/storage-db.ts'
import { createKnowledgeStorageClient } from '../../src/huaanwork-host/knowledge/storage-client.ts'
import { tokenizeForFts } from '../../src/huaanwork-host/knowledge/tokenizer.ts'

function sampleChunk(ordinal: number, content: string) {
  return {
    ordinal,
    headingPath: '第一章',
    locator: { kind: 'line' as const, startLine: ordinal + 1, endLine: ordinal + 2 },
    content,
    tokenized: tokenizeForFts(content),
    charCount: content.length,
  }
}

describe('knowledge SQLite storage, rebuild commit-point, and Storage Worker', () => {
  it('preserves UUID doc_id across reindex & rename, avoids FTS5 zombie rows, supports non-unique norm_path, and enforces chunk cap', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-db-'))
    const opened = openKnowledgeDb(kbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const { db } = opened

    const first = upsertDocumentWithChunks(db, {
      relPath: 'Readme.md',
      normPath: 'readme.md',
      sha256: 'sha-v1',
      size: 100,
      mtimeMs: 1000,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, '旧内容 赎回费率')],
    })
    expect(first.docId).toMatch(/^[0-9a-f-]{36}$/u)

    // Reindex same relPath keeps doc_id and removes old FTS tokens
    const second = upsertDocumentWithChunks(db, {
      relPath: 'Readme.md',
      normPath: 'readme.md',
      sha256: 'sha-v2',
      size: 120,
      mtimeMs: 2000,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, '新内容 基金税率')],
    })
    expect(second.docId).toBe(first.docId)
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '赎回费率' })).toHaveLength(0)
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '税' })).toHaveLength(1)

    // Case-sensitive volume: two files sharing norm_path coexist (no UNIQUE on norm_path)
    const sibling = upsertDocumentWithChunks(db, {
      relPath: 'README.md',
      normPath: 'readme.md',
      sha256: 'sha-upper',
      size: 80,
      mtimeMs: 2500,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, '大写文件')],
    })
    expect(sibling.docId).not.toBe(first.docId)

    // 1-to-1 rename updates rel_path + FTS path without changing doc_id
    renameDocument(db, { fromRelPath: 'Readme.md', toRelPath: '合规指引.md', toNormPath: '合规指引.md' })
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '合规指引' })).toHaveLength(1)

    // Version fingerprint check on getChunkWithWindow
    expect(getChunkWithWindow(db, { docId: first.docId, ordinal: 0, window: 1, expectedSha256: 'sha-v2', expectedExtractConfigHash: 'cfg-1' }).status).toBe('ok')
    expect(getChunkWithWindow(db, { docId: first.docId, ordinal: 0, window: 1, expectedSha256: 'sha-v1', expectedExtractConfigHash: 'cfg-1' }).status).toBe('version-mismatch')
    expect(getChunkWithWindow(db, { docId: first.docId, ordinal: 0, window: 1, expectedSha256: 'sha-v2', expectedExtractConfigHash: 'cfg-2' }).status).toBe('version-mismatch')

    // Single-KB chunk cap (injectable small limit)
    const overCap = upsertDocumentWithChunks(db, {
      relPath: 'big.md',
      normPath: 'big.md',
      sha256: 'sha-big',
      size: 500,
      mtimeMs: 3000,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, 'a'), sampleChunk(1, 'b'), sampleChunk(2, 'c')],
    }, { maxChunksPerKb: 3 })
    expect(overCap.chunkCapExceeded).toBe(true)

    // Delete doc with wiki_note_path writes organize_tombstones and clears chunks_fts
    markOrganizedAtomic(db, { docId: first.docId, sha256: 'sha-v2', wikiNotePath: `docs/${first.docId}.md` })
    deleteDocument(db, '合规指引.md')
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '基金税率' })).toHaveLength(0)
    const tombs = db.prepare('SELECT doc_id, wiki_note_path FROM organize_tombstones').all() as Array<{ doc_id: string; wiki_note_path: string | null }>
    expect(tombs).toEqual([{ doc_id: first.docId, wiki_note_path: `docs/${first.docId}.md` }])
    db.close()
  })

  it('normal rebuild preserves organized_sha256 only when wiki/docs/<docId>.md is a valid non-empty regular file', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-rebuild-normal-'))
    mkdirSync(join(kbDir, 'wiki', 'docs'), { recursive: true })
    const opened = openKnowledgeDb(kbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    const dKeep = upsertDocumentWithChunks(opened.db, {
      relPath: 'keep.md', normPath: 'keep.md', sha256: 'h-keep', size: 10, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'keep')],
    })
    const dMissingWiki = upsertDocumentWithChunks(opened.db, {
      relPath: 'missing.md', normPath: 'missing.md', sha256: 'h-miss', size: 10, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'miss')],
    })
    const dSymlinkWiki = upsertDocumentWithChunks(opened.db, {
      relPath: 'sym.md', normPath: 'sym.md', sha256: 'h-sym', size: 10, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'sym')],
    })
    markOrganizedAtomic(opened.db, { docId: dKeep.docId, sha256: 'h-keep', wikiNotePath: `docs/${dKeep.docId}.md` })
    markOrganizedAtomic(opened.db, { docId: dMissingWiki.docId, sha256: 'h-miss', wikiNotePath: `docs/${dMissingWiki.docId}.md` })
    markOrganizedAtomic(opened.db, { docId: dSymlinkWiki.docId, sha256: 'h-sym', wikiNotePath: `docs/${dSymlinkWiki.docId}.md` })

    writeFileSync(join(kbDir, 'wiki', 'docs', `${dKeep.docId}.md`), '# valid card')
    // dMissingWiki file intentionally omitted; dSymlinkWiki is a symlink
    symlinkSync(join(kbDir, 'wiki', 'docs', `${dKeep.docId}.md`), join(kbDir, 'wiki', 'docs', `${dSymlinkWiki.docId}.md`))
    opened.db.close()

    const staging = beginRebuildStaging(kbDir)
    expect(staging.corruptRecovery).toBe(false)
    staging.upsert({ relPath: 'keep.md', normPath: 'keep.md', sha256: 'h-keep', size: 10, mtimeMs: 2, format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'keep')] })
    staging.upsert({ relPath: 'missing.md', normPath: 'missing.md', sha256: 'h-miss', size: 10, mtimeMs: 2, format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'miss')] })
    staging.upsert({ relPath: 'sym.md', normPath: 'sym.md', sha256: 'h-sym', size: 10, mtimeMs: 2, format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'sym')] })
    const committed = commitRebuildStaging(kbDir, staging)
    expect(committed.ok).toBe(true)

    const reopened = openKnowledgeDb(kbDir)
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    const rows = reopened.db.prepare('SELECT rel_path, doc_id, organized_sha256 FROM documents ORDER BY rel_path').all() as Array<{ rel_path: string; doc_id: string; organized_sha256: string | null }>
    expect(rows).toEqual([
      { rel_path: 'keep.md', doc_id: dKeep.docId, organized_sha256: 'h-keep' },
      { rel_path: 'missing.md', doc_id: dMissingWiki.docId, organized_sha256: null },
      { rel_path: 'sym.md', doc_id: dSymlinkWiki.docId, organized_sha256: null },
    ])
    reopened.db.close()
  })

  it('degrades corrupt DB to index-error on boot and handles Step 1 / Step 2 / wiki-reset.pending crash recovery', () => {
    // 1. Corrupt DB returns index-error without crashing
    const corruptDir = mkdtempSync(join(tmpdir(), 'kb-corrupt-'))
    writeFileSync(join(corruptDir, 'index.sqlite'), 'NOT A SQLITE DATABASE')
    expect(openKnowledgeDb(corruptDir)).toMatchObject({ ok: false, code: 'index-error' })

    // 2. Step 1 crash recovery (index.sqlite missing + .bak + uncheckpointed .bak-wal + .rebuild + wiki-reset.pending present)
    const step1Dir = mkdtempSync(join(tmpdir(), 'kb-step1-'))
    mkdirSync(join(step1Dir, 'wiki'), { recursive: true })
    writeFileSync(join(step1Dir, 'wiki', 'INDEX.md'), '# old wiki')
    const init1 = openKnowledgeDb(step1Dir)
    expect(init1.ok).toBe(true)
    if (init1.ok) {
      // Disable autocheckpoint so the inserted row lives in index.sqlite-wal before simulated crash
      init1.db.exec('PRAGMA wal_autocheckpoint = 0')
      upsertDocumentWithChunks(init1.db, {
        relPath: 'old.md', normPath: 'old.md', sha256: 'h-old', size: 1, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, '旧数据 WAL')],
      })
      // Snapshot index.sqlite + index.sqlite-wal into .bak / .bak-wal before closing truncates WAL
      writeFileSync(join(step1Dir, 'index.sqlite.bak'), readFileSync(join(step1Dir, 'index.sqlite')))
      expect(existsSync(join(step1Dir, 'index.sqlite-wal'))).toBe(true)
      writeFileSync(join(step1Dir, 'index.sqlite.bak-wal'), readFileSync(join(step1Dir, 'index.sqlite-wal')))
      init1.db.close()
      rmSync(join(step1Dir, 'index.sqlite'), { force: true })
      rmSync(join(step1Dir, 'index.sqlite-wal'), { force: true })
      rmSync(join(step1Dir, 'index.sqlite-shm'), { force: true })
    }
    writeFileSync(join(step1Dir, 'index.sqlite.rebuild'), 'partial-rebuild')
    writeFileSync(join(step1Dir, 'wiki-reset.pending'), '{}')
    const recovered1 = openKnowledgeDb(step1Dir)
    expect(recovered1.ok).toBe(true)
    if (recovered1.ok) {
      expect(searchFts(recovered1.db, { kbId: 'k', kbName: 'K', query: '旧数据' })).toHaveLength(1)
      expect(existsSync(join(step1Dir, 'index.sqlite.rebuild'))).toBe(false)
      expect(existsSync(join(step1Dir, 'index.sqlite.bak-wal'))).toBe(false)
      expect(existsSync(join(step1Dir, 'wiki-reset.pending'))).toBe(false)
      expect(readFileSync(join(step1Dir, 'wiki', 'INDEX.md'), 'utf8')).toBe('# old wiki')
      recovered1.db.close()
    }

    // 3. Step 2 post-commit crash recovery (index.sqlite present + .rebuild absent + .bak + wiki-reset.pending present)
    const step2Dir = mkdtempSync(join(tmpdir(), 'kb-step2-'))
    mkdirSync(join(step2Dir, 'wiki'), { recursive: true })
    writeFileSync(join(step2Dir, 'wiki', 'INDEX.md'), '# stale wiki')
    const init2 = openKnowledgeDb(step2Dir)
    expect(init2.ok).toBe(true)
    if (init2.ok) init2.db.close()
    writeFileSync(join(step2Dir, 'index.sqlite.bak'), 'old-bak')
    writeFileSync(join(step2Dir, 'wiki-reset.pending'), '{}')
    const recovered2 = openKnowledgeDb(step2Dir)
    expect(recovered2.ok).toBe(true)
    if (recovered2.ok) {
      expect(existsSync(join(step2Dir, 'index.sqlite.bak'))).toBe(false)
      expect(existsSync(join(step2Dir, 'wiki-reset.pending'))).toBe(false)
      expect(existsSync(join(step2Dir, 'wiki', 'INDEX.md'))).toBe(false)
      expect(existsSync(join(step2Dir, 'wiki.stale'))).toBe(false)
      recovered2.db.close()
    }

    // 4. Post-commit reopen failure keeps new index.sqlite (NEVER rolls back to .bak) and returns index-error
    const reopenFailDir = mkdtempSync(join(tmpdir(), 'kb-reopen-fail-'))
    const initReopen = openKnowledgeDb(reopenFailDir)
    expect(initReopen.ok).toBe(true)
    if (initReopen.ok) {
      upsertDocumentWithChunks(initReopen.db, {
        relPath: 'v1.md', normPath: 'v1.md', sha256: 'h-v1', size: 1, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, '旧版本')],
      })
      initReopen.db.close()
    }
    const stagingFail = beginRebuildStaging(reopenFailDir)
    stagingFail.upsert({
      relPath: 'v2.md', normPath: 'v2.md', sha256: 'h-v2', size: 1, mtimeMs: 2,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, '新版本')],
    })
    const commitFailRes = commitRebuildStaging(reopenFailDir, stagingFail, {
      afterCommitBeforeReopenForTest: () => {
        // Corrupt the newly committed index.sqlite after Step 2 to force reopen failure
        writeFileSync(join(reopenFailDir, 'index.sqlite'), 'CORRUPT_AFTER_COMMIT')
      },
    })
    expect(commitFailRes).toMatchObject({ ok: false, code: 'index-error' })
    expect(readFileSync(join(reopenFailDir, 'index.sqlite'), 'utf8')).toBe('CORRUPT_AFTER_COMMIT')

    // 5. retryPendingWikiReset idempotently recovers when previous rename failed
    const retryDir = mkdtempSync(join(tmpdir(), 'kb-wiki-retry-'))
    mkdirSync(join(retryDir, 'wiki'), { recursive: true })
    writeFileSync(join(retryDir, 'wiki', 'INDEX.md'), '# mismatched')
    writeFileSync(join(retryDir, 'wiki-reset.pending'), '{}')
    expect(retryPendingWikiReset(retryDir)).toEqual({ ok: true })
    expect(existsSync(join(retryDir, 'wiki-reset.pending'))).toBe(false)
    expect(existsSync(join(retryDir, 'wiki', 'INDEX.md'))).toBe(false)
  })

  it('runs Storage Worker over worker_threads lazily and disposes cleanly within 900 ms', async () => {
    const client = createKnowledgeStorageClient()
    expect(client.isRunning()).toBe(false)
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-worker-'))
    const opened = await client.openKb('kb-1', kbDir)
    expect(opened.ok).toBe(true)
    expect(client.isRunning()).toBe(true)
    await client.closeKb('kb-1')
    const t0 = performance.now()
    await client.dispose(900)
    expect(performance.now() - t0).toBeLessThan(900)
    rmSync(kbDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-storage.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 实现 `storage-protocol.ts`、`storage-db.ts`、`storage-worker.ts`、`storage-client.ts`**

关键实现点：
- `storage-worker.ts` 首条执行语句：`import { disableAsarArchiveView } from '../../asar-archive-policy.ts'; disableAsarArchiveView(import.meta.url)`。遵守 Node 原生 type-stripping 约束。
- `storage-db.ts`：
  - `openKnowledgeDb(kbDir)` 先调用 `recoverKnowledgeDbDir(kbDir)`，再打开 SQLite 并执行 `PRAGMA quick_check`（返回非 `ok` 或打开抛 `SQLITE_CORRUPT`/任意打开异常时捕获关闭，返回 `{ ok: false, code: 'index-error', error }` 绝不崩 Worker）；
  - `chunks_fts` 显式同事务同步：在 `BEGIN IMMEDIATE ... COMMIT` 内，删/替换文档先 `DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)`，再删/插 `chunks` 与 `chunks_fts`（对 `rel_path`、`heading_path`、`tokenized` 写入 `tokenizeForFts` 结果）；
  - `upsertDocumentWithChunks` 在插入前检查 `currentChunkCount - oldDocChunkCount + nextChunks.length <= maxChunksPerKb`（默认 `MAX_CHUNKS_PER_KB = 50_000`），超限时裁剪或标 `skipped`/`partial` 并返回 `chunkCapExceeded: true`，不破坏已有事务；
  - `commitRebuildStaging` 与 `recoverKnowledgeDbDir` 共用三文件联合状态机：Step 1 同时移动 `index.sqlite` + `-wal` + `-shm` → `.bak*`，损坏恢复先写 `wiki-reset.pending`（`0o600`），Step 2 `rename(index.sqlite.rebuild, index.sqlite)` 为唯一提交点；提交前失败回滚 `.bak*`；提交后重开失败绝不回滚旧库，返回 `{ ok: false, code: 'index-error' }`；正常重建用 `lstatSync` 核验盘上 `wiki/docs/<docId>.md` 为非符号链接、非空常规文件后才继承 `organized_sha256`。
- `storage-client.ts`：默认用 `resolveKnowledgeWorkerUrl('storage-worker')` **惰性**拉起 Worker（0 次调用不创建线程）；`dispose(budgetMs = 900)` 若未启动直接返回，已启动则发 `shutdown` 与 `setTimeout(budgetMs)` 竞态，超时直接 `worker.terminate()`。

- [ ] **Step 4: 运行测试与双套类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-storage.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.json --noEmit && corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-*.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-storage.spec.ts
git commit -m "feat(knowledge): add Storage Worker with node:sqlite FTS5, chunk cap, and crash-safe rebuild protocol"
```

---

### Task 5: 安全只读 `FileHandle` 校验链、防炸弹 OOXML 与带 CMaps 文字 PDF 提取器

**Files:**
- Modify: `dsh-plugin-huaanwork/package.json`（添加 `pdfjs-dist` 至 `dependencies`）
- Modify: `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md`（经 `verify:notices` 同步更新）
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/safe-read.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/text.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/ooxml.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/pdf-text.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/index.ts`
- Create: `dsh-plugin-huaanwork/tests/fixtures/knowledge/generators.ts`（最小中文 CID PDF、docx/xlsx/pptx、伪造 `header.size = 0` ZIP 炸弹与加密 ZIP 样本生成器）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-extractors.spec.ts`

**Interfaces:**
- Produces in `safe-read.ts`:
  - `openVerifiedSourceFile(sourceRoot: string, candidatePath: string, opts?: { maxBytes?: number; caseSensitive?: boolean; beforeOpenHook?: () => Promise<void> | void })`（入口内部先 `realpath(sourceRoot)`，避免 macOS `/var` → `/private/var` 差异误拒）→ `{ ok: true; handle: FileHandle; stat: BigIntStats; realPath: string } | { ok: false; reason: 'symlink-outside-source' | 'not-regular-file' | 'file-too-large' | 'inode-replaced' | 'read-error'; error?: string }`；
  - `readAndHashHandle(handle: FileHandle, maxBytes?: number): Promise<{ ok: true; buffer: Buffer; sha256: string } | { ok: false; reason: 'file-too-large' }>`；
  - `walkSourceDirectory(sourceDir: string, opts?: { caseSensitive?: boolean; shouldIgnore?: (relPath: string, name: string, isDir: boolean) => boolean })`（异步 `fs/promises` + 逐段 `lstat({ bigint: true })` + `bigint (dev, ino)` 环检 + `realpath` 归属检查，返回 `{ files, skipped }`）。
- Produces in `extractors/index.ts`:
  - `computeExtractConfigHash(opts?: { pipelineVersion?: string; visionEnabled?: boolean; visionModelId?: string; maxVisionPdfPages?: number }): string`（对规范 JSON `{ pipelineVersion: opts?.pipelineVersion ?? EXTRACTOR_PIPELINE_VERSION, visionEnabled: opts?.visionEnabled ?? false, visionModelId: opts?.visionModelId ?? '', maxVisionPdfPages: opts?.maxVisionPdfPages ?? MAX_VISION_PDF_PAGES }` 取 SHA-256 hex）；
  - `extractFromBuffer(input: { buffer: Buffer; ext: string; extractConfigHash?: string; maxDocTextBytes?: number }): Promise<ExtractedDocument>`；
  - `TEXT_EXTENSIONS: ReadonlySet<string>`（固定包含 `.md`, `.txt`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, `.xml`, `.html`, `.htm`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.c`, `.cpp`, `.h`, `.cs`, `.rb`, `.php`, `.sql`, `.sh`, `.ps1`, `.css`, `.scss`, `.ini`, `.toml`, `.log`）。

- [ ] **Step 1: 安装 `pdfjs-dist` 并核验许可证门禁与无原生传递依赖**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork add pdfjs-dist
corepack yarn workspace dsh-plugin-huaanwork verify:licenses
corepack yarn workspace dsh-plugin-huaanwork verify:notices
```
Expected:
- `pdfjs-dist` 及其传递依赖（若有）均通过 `verify:licenses`（Apache-2.0），未引入 `@napi-rs/canvas` 等原生依赖；
- `verify:notices` 同步更新 `THIRD_PARTY_NOTICES.md` 并 PASS；
- 核对已安装版本的 `pdfjs-dist/legacy/build/pdf.mjs`、`pdfjs-dist/legacy/build/pdf.worker.mjs`、`pdfjs-dist/cmaps/` 与 `pdfjs-dist/standard_fonts/` 路径存在。

- [ ] **Step 2: 写安全只读校验链（含库内合法符号链接/Windows junction）、全 M1 文本矩阵、伪造 `size=0` ZIP 炸弹、加密 ZIP/OLE2、OOXML 与中文 CID PDF 失败测试**

```ts
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openVerifiedSourceFile, readAndHashHandle, walkSourceDirectory } from '../../src/huaanwork-host/knowledge/safe-read.ts'
import { computeExtractConfigHash, extractFromBuffer } from '../../src/huaanwork-host/knowledge/extractors/index.ts'
import {
  buildEncryptedZipBuffer,
  buildForgedZeroSizeZipBombDocx,
  buildMinimalChineseCidPdf,
  buildMinimalDocx,
  buildMinimalPptx,
  buildMinimalXlsx,
  buildOverEntryLimitZipDocx,
} from '../fixtures/knowledge/generators.ts'

const DIR_SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

describe('knowledge safe-read chain and document extractors', () => {
  it('blocks outside symlinks/junctions, loops, inode replacement, and oversized files; allows in-source links via single FileHandle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-safe-'))
    const sourceDir = join(root, 'src')
    const outsideDir = join(root, 'outside')
    mkdirSync(join(sourceDir, 'sub', 'inner'), { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP_SECRET')
    writeFileSync(join(sourceDir, 'ok.txt'), 'hello')
    writeFileSync(join(sourceDir, 'sub', 'inner', 'inside.txt'), 'in-source-target')
    writeFileSync(join(sourceDir, 'big.txt'), 'x'.repeat(2_048))

    symlinkSync(outsideDir, join(sourceDir, 'escape-dir'), DIR_SYMLINK_TYPE)
    symlinkSync(sourceDir, join(sourceDir, 'sub', 'loop'), DIR_SYMLINK_TYPE)
    // In-source valid directory link / Windows junction (R3-I4)
    symlinkSync(join(sourceDir, 'sub', 'inner'), join(sourceDir, 'inside-dir-link'), DIR_SYMLINK_TYPE)

    let hasFileSymlinks = true
    try {
      symlinkSync(join(outsideDir, 'secret.txt'), join(sourceDir, 'escape-file.txt'))
      symlinkSync(join(sourceDir, 'ok.txt'), join(sourceDir, 'inside-file-link.txt'))
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') {
        hasFileSymlinks = false
      } else {
        throw err
      }
    }

    const walked = await walkSourceDirectory(sourceDir)
    expect(walked.skipped.some(s => s.reason === 'symlink-outside-source')).toBe(true)
    expect(walked.skipped.some(s => s.reason === 'symlink-loop')).toBe(true)

    if (hasFileSymlinks) {
      const outsideRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'escape-file.txt'))
      expect(outsideRes).toMatchObject({ ok: false, reason: 'symlink-outside-source' })

      // In-source valid file symlink opens once and reads strictly from the verified FileHandle
      const insideFileRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'inside-file-link.txt'))
      expect(insideFileRes.ok).toBe(true)
      if (insideFileRes.ok) {
        try {
          const read = await readAndHashHandle(insideFileRes.handle, 1_024)
          expect(read.ok).toBe(true)
          if (read.ok) expect(read.buffer.toString('utf8')).toBe('hello')
        } finally {
          await insideFileRes.handle.close()
        }
      }
    }

    // Outside directory junction/symlink target is also blocked at openVerifiedSourceFile
    const outsideDirRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'escape-dir', 'secret.txt'))
    expect(outsideDirRes).toMatchObject({ ok: false, reason: 'symlink-outside-source' })

    // In-source directory junction/symlink target succeeds via single FileHandle
    const insideDirRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'inside-dir-link', 'inside.txt'))
    expect(insideDirRes.ok).toBe(true)
    if (insideDirRes.ok) {
      try {
        const read = await readAndHashHandle(insideDirRes.handle, 1_024)
        expect(read.ok).toBe(true)
        if (read.ok) expect(read.buffer.toString('utf8')).toBe('in-source-target')
      } finally {
        await insideDirRes.handle.close()
      }
    }

    const bigRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'big.txt'), { maxBytes: 1_024 })
    expect(bigRes).toMatchObject({ ok: false, reason: 'file-too-large' })

    // Simulate TOCTOU replacement between pre-lstat and open
    const target = join(sourceDir, 'swap.txt')
    const replacement = join(sourceDir, 'swap-new.txt')
    writeFileSync(target, 'v1')
    writeFileSync(replacement, 'v2')
    const swapped = await openVerifiedSourceFile(sourceDir, target, {
      beforeOpenHook: () => { renameSync(replacement, target) },
    })
    expect(swapped).toMatchObject({ ok: false, reason: 'inode-replaced' })
  })

  it.each([
    ['.md', '# 标题\n正文'],
    ['.txt', '纯文本说明'],
    ['.csv', 'code,rate\n001,1.5%'],
    ['.tsv', 'code\trate\n001\t1.5%'],
    ['.json', '{"fund":"A","rate":0.015}'],
    ['.yaml', 'fund: A\nrate: 0.015'],
    ['.yml', 'fund: B\nrate: 0.02'],
    ['.xml', '<policy><rule>合规</rule></policy>'],
    ['.ts', 'export const rate = 0.015\n'],
    ['.py', 'def calc_rate():\n    return 0.015\n'],
    ['.sql', 'SELECT rate FROM funds;\n'],
  ] as const)('extracts M1 text/code/table format %s with line locator', async (ext, content) => {
    const doc = await extractFromBuffer({ buffer: Buffer.from(content, 'utf8'), ext })
    expect(doc.status).toBe('indexed')
    expect(doc.sections[0]?.locator.kind).toBe('line')
    expect(doc.sections.map(s => s.text).join('\n').length).toBeGreaterThan(0)
  })

  it('extracts GB18030, HTML, DOCX/XLSX/PPTX, Chinese CID PDF, skips audio/video, and blocks forged size=0 zip bombs & encrypted archives', async () => {
    const cfg1 = computeExtractConfigHash()
    const cfg2 = computeExtractConfigHash({ visionEnabled: true, visionModelId: 'vlm-1' })
    expect(cfg1).not.toBe(cfg2)

    // GB18030 Chinese text (bytes for "合规审查" in GB18030: ba cf b9 e6 c9 f3 b2 e9)
    const gbBuf = Buffer.from([0xba, 0xcf, 0xb9, 0xe6, 0xc9, 0xf3, 0xb2, 0xe9])
    const gbDoc = await extractFromBuffer({ buffer: gbBuf, ext: '.txt' })
    expect(gbDoc.status).toBe('indexed')
    expect(gbDoc.sections[0]?.text).toContain('合规审查')

    // HTML strips tags and keeps heading + line locator
    const htmlDoc = await extractFromBuffer({
      buffer: Buffer.from('<html><body><h1>风控规则</h1><p>禁止越权</p></body></html>'),
      ext: '.html',
    })
    expect(htmlDoc.sections.map(s => s.text).join(' ')).toContain('禁止越权')
    expect(htmlDoc.sections[0]?.locator.kind).toBe('line')

    // OOXML normal extraction
    const docx = await extractFromBuffer({ buffer: buildMinimalDocx('产品合规说明书'), ext: '.docx' })
    expect(docx.status).toBe('indexed')
    expect(docx.sections.map(s => s.text).join('\n')).toContain('产品合规说明书')

    const xlsx = await extractFromBuffer({ buffer: buildMinimalXlsx('表1', [['代码', '税率'], ['001', '1.5%']]), ext: '.xlsx' })
    expect(xlsx.status).toBe('indexed')
    expect(xlsx.sections[0]?.headerRow).toContain('代码')
    expect(xlsx.sections[0]?.locator.kind).toBe('sheet')

    const pptx = await extractFromBuffer({ buffer: buildMinimalPptx(['第一页 基金概览']), ext: '.pptx' })
    expect(pptx.status).toBe('indexed')
    expect(pptx.sections[0]?.locator).toEqual({ kind: 'slide', slide: 1 })

    // B-1 regression: forged Central Directory header.size = 0 zip bomb inflating > 20 MB MUST fail-closed without OOM
    const forgedBomb = await extractFromBuffer({ buffer: buildForgedZeroSizeZipBombDocx(25 * 1024 * 1024), ext: '.docx' })
    expect(forgedBomb).toMatchObject({ status: 'skipped', statusReason: 'zip-limit-exceeded' })

    const overEntries = await extractFromBuffer({ buffer: buildOverEntryLimitZipDocx(2_005), ext: '.docx' })
    expect(overEntries).toMatchObject({ status: 'skipped', statusReason: 'zip-limit-exceeded' })

    const encryptedZip = await extractFromBuffer({ buffer: buildEncryptedZipBuffer(), ext: '.docx' })
    expect(encryptedZip).toMatchObject({ status: 'skipped', statusReason: 'encrypted' })

    // Password-protected Office OOXML is wrapped in OLE2 (magic D0 CF 11 E0 A1 B1 1A E1)
    const ole2EncryptedDocx = await extractFromBuffer({ buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]), ext: '.docx' })
    expect(ole2EncryptedDocx).toMatchObject({ status: 'skipped', statusReason: 'encrypted' })

    // Real Chinese CID PDF with CMap
    const pdfDoc = await extractFromBuffer({ buffer: buildMinimalChineseCidPdf(), ext: '.pdf' })
    expect(pdfDoc.status).toBe('indexed')
    expect(pdfDoc.sections[0]?.locator).toEqual({ kind: 'page', page: 1, mode: 'text' })
    expect(pdfDoc.sections.map(s => s.text).join('')).toMatch(/[\u4e00-\u9fff]/u)

    // Audio / video directly skipped
    expect(await extractFromBuffer({ buffer: Buffer.from('000'), ext: '.mp4' })).toMatchObject({ status: 'skipped', statusReason: 'unsupported-media' })
    expect(await extractFromBuffer({ buffer: Buffer.from('000'), ext: '.mp3' })).toMatchObject({ status: 'skipped', statusReason: 'unsupported-media' })
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-extractors.spec.ts
```
Expected: FAIL。

- [ ] **Step 4: 实现 `safe-read.ts` 与全部纯 JS 提取器**

- `safe-read.ts` 严格按 §5.3(1)：入口先 `const realSourceRoot = await realpath(sourceRoot)` → 逐段 `lstat({ bigint: true })` + `${dev}:${ino}` 环检 → `resolvedTarget = await realpath(candidatePath)` 归属核验 → `preInfo = await lstat(resolvedTarget, { bigint: true })` →（测试缝 `await beforeOpenHook?.()`）→ `open(resolvedTarget, constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)))` → `handle.stat({ bigint: true })` 复核 `isFile() && dev === preInfo.dev && ino === preInfo.ino && size <= maxBytes` → `readAndHashHandle` 仅消费该 `FileHandle` 分块读出字节并计算 `sha256`（超 `maxBytes` 立即中止）。
- `extractors/ooxml.ts`（**B-1 防炸弹硬约束**）：
  - 若文件头命中 OLE2 魔数 `D0 CF 11 E0 A1 B1 1A E1`（Office 密码保护 OOXML），直接返回 `{ status: 'skipped', statusReason: 'encrypted' }`；
  - **严禁调用 `entry.getData()` / `entry.getDataAsync()`**；
  - 用 `new AdmZip(buffer).getEntries()` 校验 `entries.length <= MAX_ZIP_ENTRIES`；
  - 对需要提取的目标 XML 条目（`word/document.xml`、`xl/sharedStrings.xml`、`xl/worksheets/sheet*.xml`、`ppt/slides/slide*.xml`）：
    1. 若 `entry.header.encrypted` 为 `true` 或 `entry.header.method === 99`（WinZip AES）→ 返回 `{ status: 'skipped', statusReason: 'encrypted' }`；
    2. 仅允许 `entry.header.method === 0`（stored）与 `8`（deflated），其余返回 `skipped: 'unsupported-compression'`；
    3. 调 `entry.getCompressedData()` 取原始压缩字节；
    4. 计算当前单条上限 `limit = Math.min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES - totalInflated)`，若 `limit <= 0` 返回 `skipped: 'zip-limit-exceeded'`；
    5. method `0` 直接比对 `raw.byteLength <= limit`；method `8` 调用 `node:zlib` `inflateRawSync(raw, { maxOutputLength: limit })`，捕获 `ERR_BUFFER_TOO_LARGE` 返回 `skipped: 'zip-limit-exceeded'`，其余 deflate 损坏抛错返回 `error: 'corrupt-archive'`；
    6. 累加真实解压字节数 `totalInflated += inflated.byteLength`。
  - 零依赖轻量 XML 提取：解析 `<w:p>` / `<w:t>`、`<si><t>` + `<row><c><v>`（附表头行）、`<a:t>` 并反转义 `&amp; &lt; &gt; &quot; &apos; &#...;`。
- `extractors/pdf-text.ts`（**I-2 打包态防踩坑**）：
  - 通过 `const req = createRequire(import.meta.url)` 定位 `pdfPkgRoot = dirname(req.resolve('pdfjs-dist/package.json'))` 与 `workerPath = req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')`；
  - 显式设置 `pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href`；
  - 传入 `cMapUrl`（指向 `join(pdfPkgRoot, 'cmaps') + '/'`，按 Step 1 已装版本确认文件 URL 或本地路径形式）、`cMapPacked: true`、`standardFontDataUrl`（指向 `join(pdfPkgRoot, 'standard_fonts') + '/'`）、`isEvalSupported: false`、`useSystemFonts: false`；
  - 对非空字符 `< 30` 的页在 M1 记为需要视觉的占位跳过/部分（若全篇无文字返回 `status: 'skipped', statusReason: 'needs-vision'`，混合 PDF 返回 `status: 'partial', statusReason: 'partial-needs-vision'` 并记录 `parsedPages`/`totalPages`）。
- `extractors/text.ts`：覆盖 `TEXT_EXTENSIONS` 全部后缀；UTF-8 严格解码（`new TextDecoder('utf-8', { fatal: true })`）失败时自动回退 `new TextDecoder('gb18030')`；HTML 去 `<script>`/`<style>` 与标签并保留标题与行号坐标；超 `maxDocTextBytes`（默认 10 MB）截断并标 `status: 'partial', statusReason: 'text-truncated'`。

- [ ] **Step 5: 运行测试、双套类型检查与许可证门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-extractors.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.json --noEmit && corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
corepack yarn workspace dsh-plugin-huaanwork verify:licenses
```
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/package.json yarn.lock dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md dsh-plugin-huaanwork/src/huaanwork-host/knowledge/safe-read.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extractors/ dsh-plugin-huaanwork/tests/fixtures/knowledge/ dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-extractors.spec.ts
git commit -m "feat(knowledge): add safe FileHandle reader, zip-bomb-safe OOXML, and CMap PDF extractors"
```

---

### Task 6: Extraction Worker 池、`koffi` 云占位探针、监听/排空暂停/休眠跳变与重绑/重建同步引擎

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-worker.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-pool.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/cloud-placeholder.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-sync-engine.spec.ts`

**Interfaces:**
- Produces in `extraction-pool.ts`:
  ```ts
  export const DEFAULT_EXTRACTION_WORKERS = 1
  export const MAX_EXTRACTION_WORKERS = 2
  export const DEFAULT_EXTRACTION_TIMEOUT_MS = 60_000
  export const EXTRACTION_WORKER_MAX_OLD_GEN_MB = 256

  export interface ExtractionFileRequest {
    readonly sourceRoot: string
    readonly filePath: string
    readonly relPath: string
    readonly caseSensitive?: boolean
    readonly maxBytes?: number
    readonly maxDocTextBytes?: number
    /** 测试缝：在 Worker 内延时（毫秒），验证异步超时隔离。 */
    readonly debugDelayMs?: number
    /** 测试缝：在 Worker 内同步占满 CPU（毫秒），验证强制 worker.terminate()。 */
    readonly debugBusyLoopMs?: number
  }

  export type ExtractionFileResult =
    | { readonly ok: true; readonly sha256: string; readonly size: number; readonly mtimeMs: number; readonly doc: ExtractedDocument; readonly chunks: readonly ChunkDraft[]; readonly truncated: boolean }
    | { readonly ok: false; readonly reason: 'extract-timeout' | 'aborted' | 'symlink-outside-source' | 'not-regular-file' | 'file-too-large' | 'inode-replaced' | 'read-error' | 'worker-crashed'; readonly error?: string }

  export interface ExtractionPool {
    readonly config: {
      readonly maxWorkers: 1 | 2
      readonly timeoutMs: number
      readonly maxOldGenerationSizeMb: number
    }
    extractFile(kbId: string, req: ExtractionFileRequest, signal?: AbortSignal): Promise<ExtractionFileResult>
    abortAndDrainKb(kbId: string): Promise<void>
    isRunning(): boolean
    activeWorkerCount(): number
    /** 立即向全部 Extraction Worker 发 terminate() 并等待退出，受 budgetMs（默认 300 ms）竞态兜底。 */
    dispose(budgetMs?: number): Promise<void>
  }
  ```
  - `createExtractionPool(opts?: { workerUrl?: URL; maxWorkers?: number; timeoutMs?: number }): ExtractionPool`（默认 `maxWorkers = 1`、封顶钳制为 `2`、`timeoutMs = 60_000`、`resourceLimits: { maxOldGenerationSizeMb: 256 }`，**惰性拉起**）。
- Produces in `cloud-placeholder.ts`:
  - `WIN32_FILE_ATTRIBUTE_OFFLINE = 0x00001000`、`WIN32_FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000`、`WIN32_FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000`；
  - `detectCloudPlaceholder(filePath: string, opts?: { platform?: NodeJS.Platform; readWin32Attributes?: (filePath: string) => number | undefined }): 'local' | 'dehydrated' | 'probe-unavailable'`（Win32 默认经 `createRequire(import.meta.url)('koffi')` 延迟绑定 `kernel32.dll` 的 `uint32 __stdcall GetFileAttributesW(str16)`，对齐 `src/windows-volume-diagnostics.ts:57-83`；返回 `0xFFFFFFFF`、抛错或非 Win32 返回 `'probe-unavailable'`）。
- Produces in `sync-engine.ts`:
  ```ts
  export const DEFAULT_DEBOUNCE_MS = 3_000
  export const DEFAULT_WRITE_STABLE_MS = 300
  export const DEFAULT_RECONCILE_INTERVAL_MS = 300_000
  export const DEFAULT_CLOCK_JUMP_MS = 30_000

  export interface SyncWatcherHandle {
    on(event: 'change', listener: (eventType: string, filename: string | Buffer | null) => void): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
    close(): void
  }

  export type SyncWatchFactory = (sourceDir: string) => SyncWatcherHandle

  export interface KnowledgeSyncEngineOptions {
    readonly profileDir: string
    readonly storage: KnowledgeStorageClient
    readonly pool: ExtractionPool
    readonly maxFilesPerKb?: number
    readonly debounceMs?: number
    readonly writeStableMs?: number
    readonly reconcileIntervalMs?: number
    readonly clockJumpThresholdMs?: number
    readonly nowWall?: () => number
    readonly nowMono?: () => number
    readonly watchFactory?: SyncWatchFactory
    readonly detectCloudPlaceholder?: (filePath: string) => 'local' | 'dehydrated' | 'probe-unavailable'
    readonly cancelOrganizerForKb?: (kbId: string) => Promise<void>
    readonly afterCommitBeforeReopenForTest?: () => void
    readonly failWikiResetOnceForTest?: () => void
  }

  export interface KnowledgeRuntimeState {
    readonly id: string
    readonly sourceDir: string
    readonly phase: KnowledgePhase
    readonly watchPaused: boolean
    readonly watching: boolean
    readonly lastSyncedAt?: string
    readonly lastError?: string
  }

  export interface SyncEngineMetrics {
    readonly fullRechunkCount: number
    readonly periodicReconcileCount: number
  }
  ```
  - `createKnowledgeSyncEngine(opts: KnowledgeSyncEngineOptions): KnowledgeSyncEngine` 暴露：
    - `startKb(kb)` / `stopKb(kbId)` / `pauseWatch(kbId)` / `resumeWatch(kbId)`（`watchPaused: true → false` 重建 Watcher 并立即补一次自动对账）；
    - `syncNow(kbId)`（若库处于 `wiki-reset-pending` 或 `index-error`，先执行幂等恢复/重开再同步）；
    - `rebindSourceDir(kbId, newSourceDir)`（前置校验零副作用 → 维护门闩 + 停机序列 → 原子写盘 `knowledge-bases.json` → 重探大小写 → 保留 `index.sqlite` 与 `wiki/` → 全量对账禁用跨目录重命名猜配，对 `rel_path` 匹配且 `mtime_ms` 变化的文件先算 `sha256`：**一致时直接元数据短路、零重切零清向量与 `organized_sha256`** → 写 `source_rebound`）；
    - `rebuildIndex(kbId)`（前置校验 `sourceDir` 可读 → 维护门闩 + 停机序列 → 暂存库 `index.sqlite.rebuild` → Step 1 / Step 2 提交点 → 收尾）；
    - `handleSystemResume()` + `onSystemResume(listener: () => void): () => void` + `checkClockJump(): Promise<boolean>`；
    - `acquireLifecycleLock(kbId, mode: 'maintain' | 'delete'): Promise<() => void>`；
    - `getState(kbId)`、`getMetricsForTest(kbId)`、`setCaseSensitiveForTest(kbId, caseSensitive)`、`simulateWatchErrorForTest(kbId, err)`、`dispose()`。

- [ ] **Step 1: 写池默认值、超时/损坏 `.asar`、`dehydrated` 不提取、自动监听/防抖/周期/`watch-failed`/休眠对账、重命名与重绑资产保留（`organized_sha256` + Wiki + 向量）失败测试**

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  detectCloudPlaceholder,
  WIN32_FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
} from '../../src/huaanwork-host/knowledge/cloud-placeholder.ts'
import { createExtractionPool } from '../../src/huaanwork-host/knowledge/extraction-pool.ts'
import { createKnowledgeStorageClient } from '../../src/huaanwork-host/knowledge/storage-client.ts'
import { createKnowledgeSyncEngine, type SyncWatcherHandle } from '../../src/huaanwork-host/knowledge/sync-engine.ts'
import { readKnowledgeEvents } from '../../src/huaanwork-host/knowledge/events.ts'
import { readKnowledgeBases, writeKnowledgeBases } from '../../src/huaanwork-host/knowledge/registry.ts'
import { neutralKnowledgeRootPath, neutralKnowledgeWikiRootPath } from '../../src/huaanwork-host/workspace-state.ts'

function createFakeWatcher(): SyncWatcherHandle & { emitChange: (name: string) => void; emitError: (err: Error) => void; closed: boolean } {
  const ee = new EventEmitter()
  const watcher = {
    closed: false,
    on: (ev: 'change' | 'error', fn: (...args: any[]) => void) => ee.on(ev, fn),
    close: () => { watcher.closed = true; ee.removeAllListeners() },
    emitChange: (name: string) => { if (!watcher.closed) ee.emit('change', 'rename', name) },
    emitError: (err: Error) => { if (!watcher.closed) ee.emit('error', err) },
  }
  return watcher
}

describe('knowledge Extraction Worker pool, cloud probe, and sync engine', () => {
  it('enforces spec defaults (1 worker, capped at 2, 60s timeout, 256 MB heap) and classifies cloud placeholders', () => {
    const defPool = createExtractionPool()
    expect(defPool.config).toEqual({ maxWorkers: 1, timeoutMs: 60_000, maxOldGenerationSizeMb: 256 })
    const clampedPool = createExtractionPool({ maxWorkers: 8 })
    expect(clampedPool.config.maxWorkers).toBe(2)

    expect(detectCloudPlaceholder('C:\\a.txt', { platform: 'win32', readWin32Attributes: () => 0x20 })).toBe('local')
    expect(detectCloudPlaceholder('C:\\a.txt', { platform: 'win32', readWin32Attributes: () => WIN32_FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS })).toBe('dehydrated')
    expect(detectCloudPlaceholder('C:\\a.txt', { platform: 'win32', readWin32Attributes: () => 0xffffffff })).toBe('probe-unavailable')
    expect(detectCloudPlaceholder('/tmp/a.txt', { platform: 'darwin' })).toBe('probe-unavailable')
  })

  it('handles broken .asar files inside Extraction Worker and isolates single-file extraction timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ext-worker-'))
    writeFileSync(join(dir, 'corrupt.asar'), 'NOT_AN_ASAR_ARCHIVE')
    writeFileSync(join(dir, 'ok.md'), '# 标题\n正文内容')

    const pool = createExtractionPool({ maxWorkers: 1, timeoutMs: 150 })
    expect(pool.isRunning()).toBe(false)
    try {
      const okRes = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'ok.md'), relPath: 'ok.md' })
      expect(okRes.ok).toBe(true)
      const asarRes = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'corrupt.asar'), relPath: 'corrupt.asar' })
      expect(asarRes.ok).toBe(true)
      const timedOut = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'ok.md'), relPath: 'ok.md', debugDelayMs: 1_000 })
      expect(timedOut).toMatchObject({ ok: false, reason: 'extract-timeout' })
      const afterRecover = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'ok.md'), relPath: 'ok.md' })
      expect(afterRecover.ok).toBe(true)
    } finally {
      await pool.dispose()
    }
  })

  it('skips dehydrated cloud placeholders without opening or invoking Extraction pool while indexing sibling local files (R3-I6)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cloud-e2e-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'src')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'cloud-only.md'), 'SHOULD_NOT_BE_READ')
    writeFileSync(join(sourceDir, 'local.md'), '本地正常文档')

    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const extractSpy = vi.spyOn(pool, 'extractFile')
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      debounceMs: 30,
      writeStableMs: 10,
      reconcileIntervalMs: 60_000,
      watchFactory: () => createFakeWatcher(),
      detectCloudPlaceholder: (p) => (p.endsWith('cloud-only.md') ? 'dehydrated' : 'local'),
    })
    try {
      await engine.startKb({ id: 'kb-c', name: '云盘', sourceDir, autoOrganize: false, watchPaused: true, createdAt: '2026-11-25T00:00:00.000Z' })
      await engine.syncNow('kb-c')

      expect(extractSpy.mock.calls.some(([, req]) => req.relPath === 'cloud-only.md')).toBe(false)
      expect(extractSpy.mock.calls.some(([, req]) => req.relPath === 'local.md')).toBe(true)
      const { docs } = await storage.listDocs('kb-c')
      expect(docs.find(d => d.relPath === 'cloud-only.md')).toMatchObject({ status: 'skipped', statusReason: 'cloud-placeholder-dehydrated' })
      expect(docs.find(d => d.relPath === 'local.md')).toMatchObject({ status: 'indexed' })
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })

  it('drives automatic startup/debounce/periodic/resume reconcile and keeps periodic reconcile running in watch-failed (R3-I1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-auto-watch-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'src')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'init.md'), '初始文档')

    const watchers: ReturnType<typeof createFakeWatcher>[] = []
    let fakeWall = 1_000_000
    let fakeMono = 1_000
    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      debounceMs: 40,
      writeStableMs: 15,
      reconcileIntervalMs: 120,
      nowWall: () => fakeWall,
      nowMono: () => fakeMono,
      watchFactory: () => {
        const w = createFakeWatcher()
        watchers.push(w)
        return w
      },
      detectCloudPlaceholder: () => 'local',
    })
    try {
      // 1. Startup on non-paused KB triggers automatic initial reconcile without manual syncNow()
      await engine.startKb({ id: 'kb-a', name: '自动库', sourceDir, autoOrganize: false, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z' })
      await vi.waitFor(async () => {
        expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'init.md')).toBe(true)
      }, { timeout: 2_000 })

      // 2. Real-time watcher event -> 40ms debounce + 15ms write-stable -> automatic 1-to-1 rename
      const initId = (await storage.listDocs('kb-a')).docs.find(d => d.relPath === 'init.md')?.docId
      renameSync(join(sourceDir, 'init.md'), join(sourceDir, 'init-rt.md'))
      watchers.at(-1)?.emitChange('init.md')
      watchers.at(-1)?.emitChange('init-rt.md')
      await vi.waitFor(async () => {
        expect((await storage.listDocs('kb-a')).docs.find(d => d.relPath === 'init-rt.md')?.docId).toBe(initId)
      }, { timeout: 2_000 })

      // 3. Watcher error -> watch-failed, yet 120ms periodic reconcile STILL discovers new files automatically
      watchers.at(-1)?.emitError(new Error('EMFILE'))
      expect(engine.getState('kb-a')?.phase).toBe('watch-failed')
      writeFileSync(join(sourceDir, 'periodic.md'), '定时发现')
      const countBefore = engine.getMetricsForTest('kb-a').periodicReconcileCount
      await vi.waitFor(async () => {
        expect(engine.getMetricsForTest('kb-a').periodicReconcileCount).toBeGreaterThan(countBefore)
        expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'periodic.md')).toBe(true)
      }, { timeout: 2_000 })

      // 4. pauseWatch stops periodic & resume reconcile; resumeWatch rebuilds watcher & triggers immediate reconcile
      await engine.pauseWatch('kb-a')
      expect(engine.getState('kb-a')?.phase).toBe('watch-paused')
      const pausedPeriodic = engine.getMetricsForTest('kb-a').periodicReconcileCount
      writeFileSync(join(sourceDir, 'while-paused.md'), '暂停期新增')
      fakeWall += 60_000
      fakeMono += 100
      await engine.checkClockJump()
      await new Promise(r => setTimeout(r, 200))
      expect(engine.getMetricsForTest('kb-a').periodicReconcileCount).toBe(pausedPeriodic)
      expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'while-paused.md')).toBe(false)

      await engine.resumeWatch('kb-a')
      await vi.waitFor(async () => {
        expect(engine.getState('kb-a')?.phase).toBe('watching')
        expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'while-paused.md')).toBe(true)
      }, { timeout: 2_000 })
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })

  it('integrates real fs.watch with debounced auto-indexing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-real-fswatch-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'src')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })

    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      debounceMs: 80,
      writeStableMs: 25,
      reconcileIntervalMs: 300_000,
    })
    try {
      await engine.startKb({ id: 'kb-rw', name: '真实监听', sourceDir, autoOrganize: false, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z' })
      writeFileSync(join(sourceDir, 'live.md'), '真实 fs.watch 命中')
      await vi.waitFor(async () => {
        expect((await storage.listDocs('kb-rw')).docs.some(d => d.relPath === 'live.md')).toBe(true)
      }, { timeout: 3_000 })
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })

  it('supports 1-to-1 & case-only rename without duplicate false positives, >5 batch folding, maxFilesPerKb cap, and rebind preserving doc_id/organized_sha256/wiki/embeddings (R3-I7)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-sync-'))
    const profileDir = join(root, 'profile')
    const sourceA = join(root, 'src-a')
    const sourceAMoved = join(root, 'src-a-moved')
    const sourceUnrelated = join(root, 'src-unrelated')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceA, { recursive: true })
    mkdirSync(sourceAMoved, { recursive: true })
    mkdirSync(sourceUnrelated, { recursive: true })

    writeFileSync(join(sourceA, 'a.md'), '唯一内容 Alpha')
    writeFileSync(join(sourceA, 'dup1.md'), '重复内容 Same')
    writeFileSync(join(sourceA, 'dup2.md'), '重复内容 Same')

    const kb = { id: 'kb-1', name: '测试库', sourceDir: sourceA, autoOrganize: true, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z' }
    await writeKnowledgeBases(profileDir, [kb])

    let fakeWall = 1_000_000
    let fakeMono = 1_000
    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const resumeSpy = vi.fn()
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      maxFilesPerKb: 10,
      debounceMs: 50,
      writeStableMs: 20,
      reconcileIntervalMs: 300_000,
      nowWall: () => fakeWall,
      nowMono: () => fakeMono,
      watchFactory: () => createFakeWatcher(),
      detectCloudPlaceholder: () => 'probe-unavailable',
    })
    engine.onSystemResume(resumeSpy)

    try {
      await engine.startKb(kb)
      await engine.syncNow('kb-1')

      // Probe unavailable logged info event and indexed all 3 files
      const events1 = await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, 'kb-1'))
      expect(events1.some(e => e.kind === 'cloud_probe_unavailable' && e.level === 'info')).toBe(true)

      const { docs: docsBefore } = await storage.listDocs('kb-1')
      const alphaDoc = docsBefore.find(d => d.relPath === 'a.md')
      const alphaId = alphaDoc?.docId
      const dup1Id = docsBefore.find(d => d.relPath === 'dup1.md')?.docId
      const dup2Id = docsBefore.find(d => d.relPath === 'dup2.md')?.docId
      expect(alphaId).toBeTruthy()
      expect(dup1Id).toBeTruthy()
      expect(dup2Id).toBeTruthy()

      // 1-to-1 rename preserves doc_id; duplicate content (many-to-many / shared hash) does NOT false-bind rename
      renameSync(join(sourceA, 'a.md'), join(sourceA, 'a-renamed.md'))
      renameSync(join(sourceA, 'dup1.md'), join(sourceA, 'dup3.md'))
      renameSync(join(sourceA, 'dup2.md'), join(sourceA, 'dup4.md'))
      await engine.syncNow('kb-1')
      const { docs: docsAfterRename } = await storage.listDocs('kb-1')
      expect(docsAfterRename.find(d => d.relPath === 'a-renamed.md')?.docId).toBe(alphaId)
      expect(docsAfterRename.find(d => d.relPath === 'dup3.md')?.docId).not.toBe(dup1Id)
      expect(docsAfterRename.find(d => d.relPath === 'dup3.md')?.docId).not.toBe(dup2Id)
      expect(docsAfterRename.find(d => d.relPath === 'dup4.md')?.docId).not.toBe(dup1Id)
      expect(docsAfterRename.find(d => d.relPath === 'dup4.md')?.docId).not.toBe(dup2Id)

      // Case-only rename on case-insensitive volume reuses doc_id (spec §6.1)
      engine.setCaseSensitiveForTest('kb-1', false)
      renameSync(join(sourceA, 'a-renamed.md'), join(sourceA, 'A-RENAMED.md'))
      await engine.syncNow('kb-1')
      expect((await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'A-RENAMED.md')?.docId).toBe(alphaId)
      renameSync(join(sourceA, 'A-RENAMED.md'), join(sourceA, 'a-renamed.md'))
      await engine.syncNow('kb-1')

      // > 5 files batch folds into single sync_completed summary & enforces maxFilesPerKb (10)
      for (let i = 0; i < 12; i += 1) writeFileSync(join(sourceA, `batch-${i}.md`), `批量文档 ${i}`)
      await engine.syncNow('kb-1')
      const eventsAfterBatch = await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, 'kb-1'))
      expect(eventsAfterBatch.some(e => e.kind === 'sync_completed' && (e.count ?? 0) > 5)).toBe(true)
      expect(eventsAfterBatch.some(e => e.kind === 'file_skipped' && (e.detail ?? '').includes('max-files-exceeded'))).toBe(true)

      // Seed organized_sha256, wiki card, and chunk_embeddings BEFORE rebind (R3-I7)
      const alphaBeforeRebind = (await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'a-renamed.md')!
      const wikiCardPath = join(neutralKnowledgeWikiRootPath(profileDir, 'kb-1'), 'docs', `${alphaId}.md`)
      mkdirSync(join(neutralKnowledgeWikiRootPath(profileDir, 'kb-1'), 'docs'), { recursive: true })
      writeFileSync(wikiCardPath, '# Alpha 卡片正文')
      await storage.markOrganizedAtomic('kb-1', alphaId!, alphaBeforeRebind.sha256, `docs/${alphaId}.md`)
      const alphaChunks = await storage.getDocChunks('kb-1', alphaId!, 0, 10)
      await storage.putEmbedding('kb-1', alphaChunks[0]!.chunkId, 'model-k1', 4, new Uint8Array([1, 2, 3, 4]))
      expect(await storage.countEmbeddings('kb-1', alphaId!)).toBe(1)

      // Rebind to moved copy with changed mtimeMs short-circuits via sha256 (keeps doc_id, organized_sha256, wiki card, embeddings)
      writeFileSync(join(sourceAMoved, 'a-renamed.md'), '唯一内容 Alpha')
      const future = new Date(Date.now() + 120_000)
      utimesSync(join(sourceAMoved, 'a-renamed.md'), future, future)
      const rebindExtractCountBefore = engine.getMetricsForTest('kb-1').fullRechunkCount
      await engine.rebindSourceDir('kb-1', sourceAMoved)
      const alphaAfterRebind = (await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'a-renamed.md')
      expect(alphaAfterRebind?.docId).toBe(alphaId)
      expect(alphaAfterRebind?.organizedSha256).toBe(alphaBeforeRebind.sha256)
      expect(readFileSync(wikiCardPath, 'utf8')).toBe('# Alpha 卡片正文')
      expect(await storage.countEmbeddings('kb-1', alphaId!)).toBe(1)
      expect(engine.getMetricsForTest('kb-1').fullRechunkCount).toBe(rebindExtractCountBefore)
      expect((await readKnowledgeBases(profileDir))[0]?.sourceDir).toBe(sourceAMoved)
      const eventsAfterRebind = await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, 'kb-1'))
      expect(eventsAfterRebind.some(e => e.kind === 'source_rebound')).toBe(true)

      // Rebind to unrelated dir disables cross-dir rename guessing and deletes disappeared docs
      writeFileSync(join(sourceUnrelated, 'other-name.md'), '唯一内容 Alpha')
      await engine.rebindSourceDir('kb-1', sourceUnrelated)
      expect((await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'other-name.md')?.docId).not.toBe(alphaId)

      // Invalid rebind path has zero side-effect
      await expect(engine.rebindSourceDir('kb-1', profileDir)).rejects.toThrow()
      expect(engine.getState('kb-1')?.sourceDir).toBe(sourceUnrelated)
      expect(existsSync(join(neutralKnowledgeRootPath(profileDir, 'kb-1'), 'index.sqlite'))).toBe(true)
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-sync-engine.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 实现 `extraction-worker.ts`、`extraction-pool.ts`、`cloud-placeholder.ts`、`sync-engine.ts`**

关键点：
- `extraction-worker.ts` 首条执行语句：`disableAsarArchiveView(import.meta.url)`；默认经 `resolveKnowledgeWorkerUrl('extraction-worker')` 惰性拉起；遵守 Node 原生 type-stripping 约束；支持测试缝 `debugDelayMs`（异步延迟）与 `debugBusyLoopMs`（同步忙等测试强制 `terminate()`）。
- `extraction-pool.ts`（**R3-B3**）：默认并发 `DEFAULT_EXTRACTION_WORKERS = 1`、封顶 `MAX_EXTRACTION_WORKERS = 2`、超时 `DEFAULT_EXTRACTION_TIMEOUT_MS = 60_000`、`resourceLimits: { maxOldGenerationSizeMb: 256 }`；`dispose(budgetMs = 300)` 立即拒绝新任务、对全部运行中/空闲 Worker 调用 `worker.terminate()` 并等待退出（受 `budgetMs` 兜底竞态），确保绝不遗留空转 CPU 线程。
- `cloud-placeholder.ts`：Win32 惰性加载 `koffi` 绑定 `kernel32.dll` `uint32 __stdcall GetFileAttributesW(str16)`，按位掩码 `0x00400000 | 0x00040000 | 0x00001000` 判 `'dehydrated'`；命中 `'dehydrated'` 时**直接跳过、绝不调用 `openVerifiedSourceFile` 或 `pool.extractFile`** 并记录 `status: 'skipped', statusReason: 'cloud-placeholder-dehydrated'`；单库每次同步周期若探针返回 `'probe-unavailable'`，写最多 1 条 `cloud_probe_unavailable`（`level: 'info'`）事件并按普通文件继续，不刷屏。
- 忽略规则内置常量：`~$*`、`*.tmp`、`*.part`、`*.crdownload`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、`.git/`、`node_modules/`、`__pycache__/`。
- `sync-engine.ts`（**R3-I1 自动监听与对账状态机**）：
  - 默认常量：`DEFAULT_DEBOUNCE_MS = 3_000`、`DEFAULT_WRITE_STABLE_MS = 300`、`DEFAULT_RECONCILE_INTERVAL_MS = 300_000`（5 分钟）、`DEFAULT_CLOCK_JUMP_MS = 30_000`；
  - 自动触发矩阵：
    1. 启动 `startKb(kb)`（且 `!kb.watchPaused`）：建立 `fs.watch(sourceDir, { recursive: true })`（可经 `watchFactory` 注入）并错峰排入一次自动全量对账；若 `sourceDir` 不存在或不可读，置 `phase = 'source-unavailable'`、不建 Watcher、保留 `index.sqlite` 与 `wiki/` 并记 `source_unavailable`；
    2. 实时监听事件：写入该库 `dirtyPaths`，静默 `debounceMs` 后做 `writeStableMs` 写稳复核（不等则重排，最多 5 次），批内同样适用严格 1 对 1 `sha256` 重命名复用；
    3. Watcher `'error'`：立即关闭坏 Watcher、置 `phase = 'watch-failed'`、记 `watch_failed`（`level: 'warn'`），**保留 `reconcileIntervalMs` 周期对账与手动 `syncNow`**；
    4. `pauseWatch(kbId)`：关 Watcher → 清防抖计时与 `dirtyPaths` → 停周期/休眠对账 → `await pool.abortAndDrainKb(kbId)` 后返回；`resumeWatch(kbId)` 重建 Watcher 并立即触发一次自动对账；
    5. 周期对账（仅 `!watchPaused`，含 `watch-failed` 降级库）与休眠唤醒（`handleSystemResume()` + 每 30 秒墙钟 vs 单调时钟跳变检测）：对 `!watchPaused` 活跃库重建 Watcher 并错峰补对账，源目录消失转 `source-unavailable` 并关 Watcher、恢复后转 `watching` 重建 Watcher 并记 `source_restored`；
  - 超出 `maxFilesPerKb`（默认 2,000）的后续有效文件记 `file_skipped`（`max-files-exceeded`）+ 单条超限汇总告警；
  - 单批同步变更 `> 5` 个文件时折叠为 1 条 `sync_completed` 汇总事件（带 `count`），少量变更（≤ 5）与告警/错误仍逐条记；
  - 重绑对账：原子写回 `knowledge-bases.json` 后对 `rel_path` 存在且 `(size, mtimeMs)` 变化的文件先算 `sha256`，若 `sha256` 与 `extractConfigHash` 均一致则调 `storage.updateDocumentMetadata` 直接短路，保留 `doc_id`、切片、向量、`wiki/docs/<docId>.md` 与 `organized_sha256`，并记 `source_rebound`。

- [ ] **Step 4: 运行测试与双套类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-sync-engine.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.json --noEmit && corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/extraction-*.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/cloud-placeholder.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-sync-engine.spec.ts
git commit -m "feat(knowledge): add Extraction Worker pool, koffi cloud probe, clock-jump resume, and rebind/rebuild sync engine"
```

---

### Task 7: `KnowledgeHost` 完整门面（含 `remove` / `stale` 实时 `stat` / 惰性启动）、`powerMonitor` 跨进程桥接、Worker 打包入口、`session-sweep` 接线与 M1-1 完整门禁

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts`
- Modify: `dsh-plugin-huaanwork/src/host-runtime-bridge.ts`（新增窄可选接口 `SystemResumeRuntime`：`subscribeSystemResume?(listener: () => void): () => void` 及 `native:subscribeSystemResume` / `native:unsubscribeSystemResume` RPC 回调桥接，不改 `DesktopRuntime`）
- Modify: `dsh-plugin-huaanwork/src/electron-runtime.ts`（导入 `powerMonitor`，实现 `subscribeSystemResume` 挂载/卸载 `powerMonitor.on('resume')`）
- Modify: `dsh-plugin-huaanwork/tests/electron-runtime.spec.ts`（`vi.mock('electron')` 补充 `powerMonitor` mock 并加 `subscribeSystemResume` 测试）
- Modify: `dsh-plugin-huaanwork/tests/desktop-browser-access.spec.ts`（`vi.mock('electron')` 补充 `powerMonitor` mock）
- Modify: `dsh-plugin-huaanwork/tests/host-runtime-bridge.spec.ts`（补充 `SystemResumeRuntime` 跨进程回调与 `release` 清理测试）
- Modify: `dsh-plugin-huaanwork/tsdown.config.ts:8-58`（新增 `'huaanwork-host/knowledge/storage-worker'` 与 `'huaanwork-host/knowledge/extraction-worker'`）
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts:537-559`（锁定两个新 Worker 入口在 `tsdown.config.ts` 中存在）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts:48-50,266-276,515-531`（① 将 `neutralKnowledgeBaseDir(config.profileDir)` 加入 `sweepProjectLegacySessionsOncePerProcess` `protectedRoots`；② 在顶层独立 `ctx.effect` 挂载 `knowledgeHost`、按窄接口可选订阅 `SystemResumeRuntime` 并同步返回 ≤ 1,000 ms 并行退场 disposer）
- Modify: `dsh-plugin-huaanwork/src/packaged-runtime-smoke.ts`（新增 `smokeKnowledgeWorkers()`）
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/session-sweep.spec.ts`（新增 `bootHuaanworkHost` 生产接线测试验证 `workspace-knowledge/` 受 `protectedRoots` 保护）
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-lifecycle.spec.ts`

**Interfaces:**
- Produces in `knowledge/host.ts`（同时锁定 M1-2 与 M1-3 的消费契约）：
  ```ts
  export interface KnowledgeSearchHit {
    readonly kbId: string
    readonly kbName: string
    readonly docId: string
    readonly relPath: string
    readonly sha256: string
    readonly extractConfigHash: string
    readonly chunkId: string
    readonly ordinal: number
    readonly headingPath: string
    readonly locator: ChunkLocator
    readonly excerpt: string
    readonly score: number
    readonly stale: boolean
    readonly sourceUnavailable: boolean
    readonly searchMode: 'fts' | 'fts-backfilling' | 'fts-fallback' | 'hybrid'
  }

  export interface CreateKnowledgeHostOptions {
    readonly profileDir: string
    readonly maxKnowledgeBases?: number
    readonly disposeBudgetMs?: number
    readonly debounceMs?: number
    readonly writeStableMs?: number
    readonly reconcileIntervalMs?: number
    readonly watchFactory?: SyncWatchFactory
    readonly storageOverrideForTest?: KnowledgeStorageClient
    readonly poolOverrideForTest?: ExtractionPool
    readonly afterCommitBeforeReopenForTest?: () => void
    readonly failWikiResetOnceForTest?: () => void
  }

  export interface KnowledgeHost {
    start(): Promise<void>
    list(): Promise<readonly KnowledgeBaseSummary[]>
    get(kbId: string): KnowledgeBaseSummary | undefined
    create(input: { name: string; sourceDir: string; autoOrganize?: boolean }): Promise<KnowledgeBaseRecord>
    update(kbId: string, patch: { name?: string; sourceDir?: string; autoOrganize?: boolean; watchPaused?: boolean }): Promise<KnowledgeBaseRecord>
    remove(kbId: string): Promise<void>
    sync(kbId: string): Promise<void>
    rebuild(kbId: string): Promise<void>
    listDocs(kbId: string, filter?: ListDocsFilter): Promise<ListDocsResult>
    search(input: { kbIds: readonly string[]; query: string; topK?: number }): Promise<readonly KnowledgeSearchHit[]>
    getChunk(input: { kbId: string; docId: string; ordinal: number; window?: number; expectedSha256?: string; expectedExtractConfigHash?: string }): Promise<GetChunkResult>
    getEvents(kbId: string, opts?: { limit?: number; filter?: KnowledgeEventFilter }): Promise<readonly KnowledgeEventRecord[]>
    handleSystemResume(): Promise<void>
    onSystemResume(listener: () => void): () => void
    /** M1-2 注入：维护/删库/退场时取消该库在途整理并 await 单槽释放。 */
    setOrganizerHooks(hooks: { cancelForKb: (kbId: string) => Promise<void>; cancelAll: () => Promise<void>; notifyPending?: (kbId: string) => void }): void
    /** M1-3 注入：删库完成后清理会话挂载。 */
    setRemovalHook(hook: (kbId: string) => Promise<void>): void
    isWorkersRunning(): boolean
    isWatchingForTest(kbId: string): boolean
    dispose(): Promise<void>
  }
  ```
- `remove(kbId)` 严格执行顺序（规格 §5.2(6)、§6.4、§10、§11.1(1)）：
  1. 校验 `kbId` 存在并获取单库互斥锁（`deletingIds` / `maintainingIds`，并发 `sync`/`rebuild`/`update` 立即拒 `knowledge-base-busy` / `knowledge-base-deleting`）；
  2. 执行停机序列（关 Watcher、清防抖与 `dirtyPaths`、中止并等待 Extraction Worker 释放 `FileHandle`、调用并 `await organizerHooks?.cancelForKb(kbId)`）；
  3. `await storageClient.closeKb(kbId)`（释放 SQLite 文件锁，防 Windows `EBUSY`）；
  4. `await rm(neutralKnowledgeRootPath(profileDir, kbId), { recursive: true, force: true })`（**严禁触碰 `sourceDir`**）；
  5. 原子更新 `knowledge-bases.json` 移除该记录；
  6. `await removalHook?.(kbId)`；
  7. `finally` 释放 `deletingIds` 门闩。

- [ ] **Step 1: 写零库惰性启动、20 库上限、删库全链路、`host.rebuild()` 正常/损坏/故障分支、源目录消失与恢复（Watcher + 历史库 + `source_restored`）、真实卡死 Extraction Worker 1 秒退场，以及 `powerMonitor` 无条件注册桥接与 `session-sweep` 生产接线失败测试**

```ts
// tests/huaanwork-host/knowledge-lifecycle.spec.ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeHost } from '../../src/huaanwork-host/knowledge/host.ts'
import { createExtractionPool } from '../../src/huaanwork-host/knowledge/extraction-pool.ts'
import { MAX_KNOWLEDGE_BASES } from '../../src/huaanwork-host/knowledge/types.ts'
import { neutralKnowledgeRootPath, neutralKnowledgeWikiRootPath } from '../../src/huaanwork-host/workspace-state.ts'

describe('KnowledgeHost lifecycle, remove, rebuild, source recovery, limits, stale stat, and 1s dispose', () => {
  it('stays lazy with zero Workers when no KBs are registered and disposes immediately', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'kb-host-lazy-'))
    const host = createKnowledgeHost({ profileDir })
    await host.start()
    expect(host.isWorkersRunning()).toBe(false)
    const t0 = performance.now()
    await host.dispose()
    expect(performance.now() - t0).toBeLessThan(100)
  })

  it('enforces MAX_KNOWLEDGE_BASES = 20 limit on create', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-cap-'))
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    const host = createKnowledgeHost({ profileDir, maxKnowledgeBases: 2 })
    await host.start()
    try {
      const d1 = join(root, 'd1'); const d2 = join(root, 'd2'); const d3 = join(root, 'd3')
      mkdirSync(d1); mkdirSync(d2); mkdirSync(d3)
      await host.create({ name: 'K1', sourceDir: d1 })
      await host.create({ name: 'K2', sourceDir: d2 })
      await expect(host.create({ name: 'K3', sourceDir: d3 })).rejects.toThrow(/knowledge-base-limit-reached/u)
      expect(MAX_KNOWLEDGE_BASES).toBe(20)
    } finally {
      await host.dispose()
    }
  })

  it('remove(kbId) cancels organizer, closes DB, deletes isolated dir, invokes removal hook, rejects concurrent ops, and never modifies sourceDir bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-remove-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    const filePath = join(sourceDir, 'policy.md')
    writeFileSync(filePath, '重要风控条款 2026')
    const hashBefore = createHash('sha256').update(readFileSync(filePath)).digest('hex')

    let releaseCancel!: () => void
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve })
    const cancelSpy = vi.fn(async () => { await cancelGate })
    const removedHook = vi.fn(async () => {})
    const host = createKnowledgeHost({ profileDir })
    host.setOrganizerHooks({ cancelForKb: cancelSpy, cancelAll: async () => {} })
    host.setRemovalHook(removedHook)
    await host.start()

    try {
      const created = await host.create({ name: '风控', sourceDir })
      await host.sync(created.id)
      const kbRoot = neutralKnowledgeRootPath(profileDir, created.id)
      expect(existsSync(join(kbRoot, 'index.sqlite'))).toBe(true)

      const removing = host.remove(created.id)
      await Promise.resolve()
      await expect(host.sync(created.id)).rejects.toThrow(/knowledge-base-(?:deleting|busy)/u)
      await expect(host.rebuild(created.id)).rejects.toThrow(/knowledge-base-(?:deleting|busy)/u)
      releaseCancel()
      await removing

      expect(cancelSpy).toHaveBeenCalledWith(created.id)
      expect(removedHook).toHaveBeenCalledWith(created.id)
      expect(existsSync(kbRoot)).toBe(false)
      expect((await host.list()).some(k => k.id === created.id)).toBe(false)
      expect(createHash('sha256').update(readFileSync(filePath)).digest('hex')).toBe(hashBefore)
    } finally {
      await host.dispose()
    }
  })

  it('host.rebuild() executes normal rebuild, corrupt-DB rebuild with wiki reset, concurrent busy guard, and fault recovery branches (R3-I2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-rebuild-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'keep.md'), '保留文档内容')
    writeFileSync(join(sourceDir, 'gone.md'), '即将删除文档')

    let releaseCancel!: () => void
    let holdCancel = false
    const cancelSpy = vi.fn(async () => {
      if (holdCancel) await new Promise<void>(resolve => { releaseCancel = resolve })
    })
    const host = createKnowledgeHost({ profileDir })
    host.setOrganizerHooks({ cancelForKb: cancelSpy, cancelAll: async () => {} })
    await host.start()

    try {
      const kb = await host.create({ name: '重建库', sourceDir })
      await host.update(kb.id, { watchPaused: true })
      await host.sync(kb.id)
      const initialDocs = (await host.listDocs(kb.id)).docs
      const keepId = initialDocs.find(d => d.relPath === 'keep.md')!.docId

      const wikiDir = neutralKnowledgeWikiRootPath(profileDir, kb.id)
      mkdirSync(join(wikiDir, 'docs'), { recursive: true })
      writeFileSync(join(wikiDir, 'docs', `${keepId}.md`), '# Keep 卡片')
      rmSync(join(sourceDir, 'gone.md'))

      // 1. Normal rebuild: rejects concurrent sync/rebuild/update(sourceDir), preserves keepId & wiki card, resets organizeAttempts, writes tombstone for gone.md
      holdCancel = true
      const rebuilding = host.rebuild(kb.id)
      await Promise.resolve()
      await expect(host.sync(kb.id)).rejects.toThrow(/knowledge-base-busy/u)
      await expect(host.update(kb.id, { sourceDir })).rejects.toThrow(/knowledge-base-busy/u)
      holdCancel = false
      releaseCancel()
      await rebuilding

      expect(cancelSpy).toHaveBeenCalledWith(kb.id)
      const afterNormal = (await host.listDocs(kb.id)).docs
      expect(afterNormal.find(d => d.relPath === 'keep.md')).toMatchObject({ docId: keepId, organizeAttempts: 0 })
      expect(afterNormal.find(d => d.relPath === 'gone.md')).toBeUndefined()
      expect(existsSync(join(wikiDir, 'docs', `${keepId}.md`))).toBe(true)
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'rebuild_completed')).toBe(true)

      // 2. Pre-commit rebuild failure (sourceDir missing -> refused before commit, old DB & wiki intact)
      const tempMove = `${sourceDir}-moved-aside`
      renameSync(sourceDir, tempMove)
      await expect(host.rebuild(kb.id)).rejects.toThrow(/source-unavailable/u)
      expect((await host.listDocs(kb.id)).docs.find(d => d.relPath === 'keep.md')?.docId).toBe(keepId)
      renameSync(tempMove, sourceDir)

      // 3. Corrupt DB rebuild + wiki reset EBUSY -> wiki-reset-pending -> host.sync() idempotently finishes reset
      await host.dispose()
      writeFileSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'), 'CORRUPT_BYTES')

      let failWikiOnce = true
      const host2 = createKnowledgeHost({
        profileDir,
        failWikiResetOnceForTest: () => {
          if (failWikiOnce) {
            failWikiOnce = false
            throw new Error('simulated-ebusy-wiki-rename')
          }
        },
      })
      await host2.start()
      try {
        expect(host2.get(kb.id)?.phase).toBe('index-error')
        await host2.rebuild(kb.id)
        expect(host2.get(kb.id)?.phase).toBe('wiki-reset-pending')
        expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'wiki-reset.pending'))).toBe(true)
        expect((await host2.getEvents(kb.id)).some(e => e.kind === 'wiki_reset_failed')).toBe(true)

        // Calling host2.sync() idempotently finishes pending wiki reset and recovers
        await host2.sync(kb.id)
        expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'wiki-reset.pending'))).toBe(false)
        expect(existsSync(join(wikiDir, 'docs', `${keepId}.md`))).toBe(false)
        const afterCorrupt = (await host2.listDocs(kb.id)).docs
        expect(afterCorrupt.find(d => d.relPath === 'keep.md')?.docId).not.toBe(keepId)
      } finally {
        await host2.dispose()
      }

      // 4. Post-commit reopen failure keeps new index.sqlite (no rollback) and marks phase index-error
      const host3 = createKnowledgeHost({
        profileDir,
        afterCommitBeforeReopenForTest: () => {
          writeFileSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'), 'CORRUPT_POST_COMMIT')
        },
      })
      await host3.start()
      try {
        await expect(host3.rebuild(kb.id)).rejects.toThrow(/index-error/u)
        expect(host3.get(kb.id)?.phase).toBe('index-error')
        expect(readFileSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'), 'utf8')).toBe('CORRUPT_POST_COMMIT')
      } finally {
        await host3.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  it('sets stale on file mutation, closes Watcher & preserves DB/wiki on sourceDir loss, and emits source_restored on recovery (R3-I8)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-stale-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    const docPath = join(sourceDir, 'rate.md')
    writeFileSync(docPath, 'C类基金税率标准条款')

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    try {
      const kb = await host.create({ name: '税率', sourceDir })
      await host.sync(kb.id)
      const wikiDir = neutralKnowledgeWikiRootPath(profileDir, kb.id)
      mkdirSync(wikiDir, { recursive: true })
      writeFileSync(join(wikiDir, 'INDEX.md'), '# 索引')
      expect(host.isWatchingForTest(kb.id)).toBe(true)

      const fresh = await host.search({ kbIds: [kb.id], query: '基金税率' })
      expect(fresh[0]).toMatchObject({ stale: false, sourceUnavailable: false })
      const docId = fresh[0]!.docId
      expect(await host.getChunk({ kbId: kb.id, docId, ordinal: 0 })).toMatchObject({ status: 'ok', stale: false, sourceUnavailable: false })

      // Mutate file on disk while watchPaused -> both search and getChunk report stale: true
      await host.update(kb.id, { watchPaused: true })
      writeFileSync(docPath, 'C类基金税率标准条款——盘上已修改但未同步')
      expect((await host.search({ kbIds: [kb.id], query: '基金税率' }))[0]).toMatchObject({ stale: true, sourceUnavailable: false })
      expect(await host.getChunk({ kbId: kb.id, docId, ordinal: 0 })).toMatchObject({ status: 'ok', stale: true, sourceUnavailable: false })

      // Re-enable watch, remove sourceDir -> closes watcher, preserves index.sqlite & wiki/, logs source_unavailable
      await host.update(kb.id, { watchPaused: false })
      rmSync(sourceDir, { recursive: true, force: true })
      await host.sync(kb.id)
      expect(host.isWatchingForTest(kb.id)).toBe(false)
      expect(host.get(kb.id)?.phase).toBe('source-unavailable')
      expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'))).toBe(true)
      expect(readFileSync(join(wikiDir, 'INDEX.md'), 'utf8')).toBe('# 索引')
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'source_unavailable')).toBe(true)
      expect((await host.search({ kbIds: [kb.id], query: '基金税率' }))[0]).toMatchObject({ sourceUnavailable: true })
      expect(await host.getChunk({ kbId: kb.id, docId, ordinal: 0 })).toMatchObject({ status: 'ok', sourceUnavailable: true })

      // Restore sourceDir -> sync re-attaches watcher and logs source_restored
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(docPath, 'C类基金税率标准条款')
      await host.sync(kb.id)
      expect(host.isWatchingForTest(kb.id)).toBe(true)
      expect(host.get(kb.id)?.phase).toBe('watching')
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'source_restored')).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('terminates a real CPU-stuck Extraction Worker and finishes host.dispose() within 1,000 ms (R3-B3)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-dispose-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'stuck.md'), '触发忙等')

    const realPool = createExtractionPool({ maxWorkers: 1, timeoutMs: 60_000 })
    const host = createKnowledgeHost({ profileDir, poolOverrideForTest: realPool })
    await host.start()
    // Kick off a genuine CPU-blocking extraction inside the real Extraction Worker
    const inFlight = realPool.extractFile('kb-stuck', {
      sourceRoot: sourceDir,
      filePath: join(sourceDir, 'stuck.md'),
      relPath: 'stuck.md',
      debugBusyLoopMs: 30_000,
    })
    await vi.waitFor(() => { expect(realPool.activeWorkerCount()).toBe(1) }, { timeout: 2_000 })

    const start = performance.now()
    await host.dispose()
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1_000)
    expect(realPool.activeWorkerCount()).toBe(0)
    await expect(inFlight).resolves.toMatchObject({ ok: false })
  })
})
```
同步在：
- `tests/huaanwork-host/session-sweep.spec.ts` 新增一条 `bootHuaanworkHost(config)` 用例，放置 `join(config.profileDir, 'workspace-knowledge', 'kb-1', 'wiki')` 下的游离会话并设项目根为祖先目录，断言 `bootHuaanworkHost` 后该会话文件仍存在；
- `tests/host-runtime-bridge.spec.ts` 与 `tests/electron-runtime.spec.ts` 新增 `subscribeSystemResume` 跨进程回调推送与释放测试，并在 `tests/host-runtime-bridge.spec.ts` 显式断言**不含 `subscribeSystemResume` 的裸 `DesktopRuntime` 测试桩静默 no-op、不抛 `Unknown Host operation`**（保证 `host-process-integration.spec.ts` 与 `host-liveness-win.spec.ts` 零改动通过）；
- `tests/package.spec.ts` 新增断言 `tsdown.config.ts` 含 `'huaanwork-host/knowledge/storage-worker'` 与 `'huaanwork-host/knowledge/extraction-worker'`。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-lifecycle.spec.ts tests/huaanwork-host/session-sweep.spec.ts tests/host-runtime-bridge.spec.ts tests/electron-runtime.spec.ts tests/desktop-browser-access.spec.ts tests/package.spec.ts
```
Expected: FAIL（`knowledge/host.ts`、桥接扩展及新入口尚未落地）。

- [ ] **Step 3: 实现 `knowledge/host.ts`、`powerMonitor` 桥接、接线 `index.ts` / `tsdown.config.ts` / `packaged-runtime-smoke.ts`**

1. `knowledge/host.ts`：
   - 0 库时 `start()` 仅读注册表，**不创建** Storage Worker 或 Extraction Worker 线程；
   - `search` 与 `getChunk` 返回前对命中的少量源文件执行异步 `stat`：源目录不存在/不可访问则标 `sourceUnavailable: true`（仍返回已索引片段）；否则比对 `(stat.size, Math.trunc(stat.mtimeMs))` 与索引，不一致置 `stale: true`；
   - `dispose()` 严格遵循 §2.3：同步置 `disposing = true`、关闭全部 Watcher 并取消 `SystemResumeRuntime` 订阅 → 并行发起 `organizerHooks?.cancelAll()`、`extractionPool.dispose(300)`（立即 `terminate()` 全部 Extraction Worker）与 `storageClient.dispose(800)`，外层加 950 ms 兜底竞态（留出计时器抖动余量，确保稳定满足 ≤ 1,000 ms）。
2. `host-runtime-bridge.ts` 与 `electron-runtime.ts`（**R3-I3 无条件注册修复**）：
   - 在 `host-runtime-bridge.ts` 新增窄可选接口 `SystemResumeRuntime`（`subscribeSystemResume?(listener: () => void): () => void`），将 `createHostRuntime` 返回类型扩展为 `ConfirmedRestartRuntime & KeepAwakeRuntime & ArtifactNativeCapability & SystemResumeRuntime`；在 `createHostRuntime` 通过已有 `callbacks({ resume })` 通道发起 `native:subscribeSystemResume` / `native:unsubscribeSystemResume`；
   - 在 `bindNativeRuntime` 中**无条件注册** `native:subscribeSystemResume` 与 `native:unsubscribeSystemResume` 两个 handler（绝不条件注册导致 `HostRpc` 抛 `Unknown Host operation`）：若 `typeof (runtime as SystemResumeRuntime).subscribeSystemResume !== 'function'` 则静默 no-op 返回（保证 `tests/host-runtime-bridge.spec.ts`、`tests/host-process-integration.spec.ts`、`tests/host-liveness-win.spec.ts` 的既有桩零改动通过）；存在时将取消函数记入 `resumeSubscriptions: Map<string, () => void>`，并在 `detachHostResources()` 中全部释放；
   - 在 `electron-runtime.ts` 导入 `powerMonitor`，将 `ElectronDesktopRuntime` 的 `implements` 补上 `SystemResumeRuntime` 并实现 `subscribeSystemResume(listener)`：`powerMonitor.on('resume', listener)`，返回 `() => powerMonitor.off('resume', listener)`；
   - 同步在 `tests/electron-runtime.spec.ts` 与 `tests/desktop-browser-access.spec.ts` 的 `vi.mock('electron')` 补充 `powerMonitor: { on, off }` mock。
3. `src/huaanwork-host/index.ts`：
   - 第 270–274 行 `protectedRoots` 新增 `neutralKnowledgeBaseDir(config.profileDir)`；
   - 新增顶层独立 `ctx.effect(() => { ...; return () => knowledgeHost.dispose() }, 'huaanwork: knowledge host')`（绝不放进 `tools` effect 内）；若 `ctx.desktopRuntime` 窄化命中 `subscribeSystemResume` 则订阅触发 `void knowledgeHost.handleSystemResume()`，卸载时先取消订阅再 `return knowledgeHost.dispose()`。
4. `tsdown.config.ts` 新增两条 Worker 入口：
   - `'huaanwork-host/knowledge/storage-worker': 'src/huaanwork-host/knowledge/storage-worker.ts'`
   - `'huaanwork-host/knowledge/extraction-worker': 'src/huaanwork-host/knowledge/extraction-worker.ts'`
5. `packaged-runtime-smoke.ts` 新增 `smokeKnowledgeWorkers()`：
   - 断言打包根内 `node_modules/pdfjs-dist/cmaps/` 与 `node_modules/pdfjs-dist/standard_fonts/` 存在；
   - 构造含损坏 `.asar` + 最小中文 CID PDF 的临时目录，经 `resolveKnowledgeWorkerUrl` 拉起编译产物 `lib/huaanwork-host/knowledge/{storage,extraction}-worker.js` 完成提取、FTS5 入库并检索命中中文字符，最后断言 `dispose()` < 1,000 ms。

- [ ] **Step 4: 运行定向测试、打包构建与完整 M1-1 门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-lifecycle.spec.ts tests/huaanwork-host/session-sweep.spec.ts tests/host-runtime-bridge.spec.ts tests/host-process-integration.spec.ts tests/electron-runtime.spec.ts tests/desktop-browser-access.spec.ts tests/package.spec.ts
corepack yarn check
```
Expected: 全部 PASS（`build`、`typecheck`、`test`、`verify:closure`、`verify:bundled`、`verify:cli`、`verify:loader`、`verify:profile`、`verify:host`、`verify:expert-team`、`verify:aa`、`verify:licenses`、`verify:operations` 均退出码 0；注意勿与其他含 `verify:aa` 的命令并发）。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts dsh-plugin-huaanwork/src/host-runtime-bridge.ts dsh-plugin-huaanwork/src/electron-runtime.ts dsh-plugin-huaanwork/tsdown.config.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/packaged-runtime-smoke.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-lifecycle.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/session-sweep.spec.ts dsh-plugin-huaanwork/tests/host-runtime-bridge.spec.ts dsh-plugin-huaanwork/tests/electron-runtime.spec.ts dsh-plugin-huaanwork/tests/desktop-browser-access.spec.ts dsh-plugin-huaanwork/tests/package.spec.ts
git commit -m "feat(knowledge): wire M1-1 knowledge host, powerMonitor bridge, worker entries, 1s dispose, and packaged smoke"
```
