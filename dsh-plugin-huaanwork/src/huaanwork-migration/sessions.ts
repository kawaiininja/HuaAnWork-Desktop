/**
 * Migration of the legacy session log tree (`<OLD_DSH>/sessions/**`) into the new
 * $DSH_HOME, re-minting neutral-root session ids inside the compressed header.
 *
 * Layout (upstream-owned, isomorphic on both sides):
 * `<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(sessionId)>/session[.vN].jsonl[.zstd]`.
 * Session identity lives in the log's first line, not in its path
 * (huaanwork-host/sessions.ts:320-330 matches on `header.id`), so a file whose
 * id does not move is carried at its relative path; only a canonical-layout
 * session whose `cwd` is the old neutral root moves, because its id is derived
 * from that root (`sessionIdFor`) and the new side mints the same id from
 * `neutralWorkspaceRoot(profileDir)` at composition time (src/profile.ts:1011-1016).
 *
 * The format version is never touched here (D-M6-9): the rewritten header stays
 * v0 and keeps the `session.jsonl[.zstd]` basename the upstream v0→v3 chain
 * starts from (`session-format-catalog/src/generated.ts:14-19`).
 */

import { access, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import { buildSessionIdRewritePlan, rewriteSessionId, type SessionIdRewritePlan } from './session-id.ts'
import type { HuaanworkMigrationStep } from './index.ts'
import type { HuaanworkLegacySource, HuaanworkMigrationTarget } from './paths.ts'
import { decompressZstdFrames, parseSessionHeader } from '../huaanwork-host/session-view.ts'
import { sessionLogFiles } from '../huaanwork-host/sessions.ts'
import { neutralWorkspaceRoot } from '../huaanwork-host/workspace-state.ts'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const SESSIONS_DIR = 'sessions'
const WORKSPACE_DIR = 'workspace'
const ZSTD_SUFFIX = '.zstd'

/** 会话日志基名(session-format/src/filename.ts:14-17):generation 0 为 `session.jsonl`,`.zstd` 为压缩后缀。 */
const SESSION_LOG_BASENAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u

/**
 * 单文件读取上限(statSync/stat 在读前判定):会话日志可能很大,这是单文件的迁移期内存峰值护栏。
 * 超限文件留在源侧并记 skipped,绝不搬半份。
 */
const SESSION_FILE_SIZE_CAP_BYTES = 256 * 1024 * 1024

/**
 * 迁移 step 的累计解压预算:单文件闸挡不住「每文件 200 MiB × 几十文件」的累计膨胀
 * (zstd 压缩态 256 MiB 解压后可达数 GB)。预算用尽后逐个文件记 skipped 并跳过,
 * 迁移整体不失败。按物化文本的字符数(`String#length`)累计,是解压字节数的保守代理。
 */
const SESSION_TOTAL_DECOMPRESSED_BUDGET_BYTES = 4 * 1024 * 1024 * 1024

/** 迁移期护栏,可注入:默认值即模块级具名常量,负例测试用小预算驱动同一实现。 */
export interface SessionMigrationLimits {
  readonly maxFileBytes: number
  readonly totalDecompressedBudgetBytes: number
}

const DEFAULT_SESSION_LIMITS: SessionMigrationLimits = {
  maxFileBytes: SESSION_FILE_SIZE_CAP_BYTES,
  totalDecompressedBudgetBytes: SESSION_TOTAL_DECOMPRESSED_BUDGET_BYTES,
}

/**
 * Verbatim transcription of the pinned upstream `encodeSegment`
 * (deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts:198-213;
 * read-only reference — the submodule is never modified).
 *
 * The installed `@deepseek-ai/dsh-session-persistence-jsonl` ships only `lib/`, so the
 * upstream source is not importable; the algorithm is transcribed rather than re-derived.
 * `[A-Za-z0-9._-]` passes through, every other code unit becomes `~XXXX`.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * Verbatim transcription of the pinned upstream `projectKey`
 * (deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts:224-244;
 * read-only reference — the submodule is never modified).
 *
 * `/`, `\` and `:` collapse into a single `-`, unsafe code units use the same `~XXXX`
 * escape as {@link encodeSegment}, leading separators are stripped (`|| 'root'`), the
 * slug is truncated to 251 characters and wrapped in `--…--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Rewrite one session log's first line in place.
 *
 * Only the header carries identity: locateSessionFile() matches on header.id
 * (huaanwork-host/sessions.ts:320-330), never on the directory name, so a
 * renamed directory with a stale inner id would be permanently unreachable.
 * The format version is preserved - the upstream v0→v3 chain owns upgrades
 * (session-format-catalog/src/generated.ts:14-19) and must start from the
 * generation the file was actually written at.
 */
export function rewriteSessionHeader(
  line: string,
  plan: SessionIdRewritePlan,
  roots: { readonly oldNeutral: string; readonly newNeutral: string },
): string {
  let header: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return line
    header = parsed as Record<string, unknown>
  } catch {
    return line
  }
  if (header.type !== 'session') return line

  let changed = false
  if (typeof header.id === 'string') {
    const next = rewriteSessionId(header.id, plan)
    if (next !== header.id) { header.id = next; changed = true }
  }
  if (typeof header.parentSession === 'string') {
    const next = rewriteSessionId(header.parentSession, plan)
    if (next !== header.parentSession) { header.parentSession = next; changed = true }
  }
  if (header.cwd === roots.oldNeutral) { header.cwd = roots.newNeutral; changed = true }
  return changed ? JSON.stringify(header) : line
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Canonical three-level layout check: the on-disk project key and session directories
 * must be exactly the names the pinned helpers compute for this header. A two-level
 * legacy `<key>/<sid>.jsonl[.zstd]` file or a stray name is carried instead of re-minted.
 */
function inCanonicalSessionDir(segments: readonly string[], name: string, cwd: string, id: string): boolean {
  if (segments.length !== 3 || id.length === 0) return false
  if (!SESSION_LOG_BASENAME.test(name)) return false
  return segments[0] === projectKey(cwd) && segments[1] === encodeSegment(id)
}

/**
 * Write one destination log. An unchanged header is copied byte for byte — no
 * re-compression, no serialization drift; a rewritten header is re-rendered as a single
 * zstd frame (the readers concatenate independent frames, so one frame is compatible)
 * with the rest of the log text preserved verbatim.
 *
 * `writeFileAtomic` types `content` as string, but its implementation passes the value
 * straight to `fs.writeFile`, which writes a Uint8Array's bytes verbatim; the cast keeps
 * the shared temp-sibling + rename discipline for the binary payload instead of a local
 * re-implementation of it.
 */
function writeLogFile(destination: string, content: Buffer): Promise<void> {
  return writeFileAtomic(destination, content as unknown as string, { mode: FILE_MODE, dirMode: DIRECTORY_MODE })
}

/**
 * Migrate every session log under `<OLD_DSH>/sessions` into `<NEW_HOME>/sessions`.
 *
 * A canonical-layout session whose header `cwd` is the old neutral root is re-minted into
 * the canonical destination for the new root; everything else is carried at its relative
 * path with the header rewritten in place (parentSession back-references). The source tree
 * is never deleted (spec §8), and a destination that already exists is skipped, never
 * overwritten, so a re-run is idempotent.
 */
export function createMigrateSessionsStep(limits: SessionMigrationLimits = DEFAULT_SESSION_LIMITS): HuaanworkMigrationStep {
  return {
    name: 'sessions',
    async run(source: HuaanworkLegacySource, target: HuaanworkMigrationTarget, report: HuaanworkMigrationReport): Promise<void> {
      const sourceRoot = join(source.dshHome, SESSIONS_DIR)
      const destinationRoot = join(target.homeDir, SESSIONS_DIR)
      const oldNeutral = join(source.dshHome, WORKSPACE_DIR)
      // 与新侧 profile.ts:1011-1016 同源:重铸后的 id 必须等于新侧冷启动铸造的 id。
      const newNeutral = neutralWorkspaceRoot(target.profileDir)
      const plan = buildSessionIdRewritePlan(oldNeutral, newNeutral)
      const roots = { oldNeutral, newNeutral }
      const files = [...(await sessionLogFiles(sourceRoot))].sort()
      if (files.length === 0) return
      bumpCount(report, 'sessions', 0)
      bumpCount(report, 'sessionsReminted', 0)
      bumpCount(report, 'sessionsCarried', 0)

      let materializedChars = 0
      for (const file of files) {
        const relativePath = relative(sourceRoot, file)
        if (materializedChars > limits.totalDecompressedBudgetBytes) {
          recordSkip(report, `${relativePath}: exceeds the cumulative decompression budget`)
          continue
        }
        if ((await stat(file)).size > limits.maxFileBytes) {
          recordSkip(report, `${relativePath}: exceeds the migration size cap`)
          continue
        }
        const raw = await readFile(file)
        const compressed = file.endsWith(ZSTD_SUFFIX)
        const text = compressed ? decompressZstdFrames(raw) : raw.toString('utf8')
        materializedChars += text.length
        const firstBreak = text.indexOf('\n')
        const first = firstBreak === -1 ? text : text.slice(0, firstBreak)
        const remainder = firstBreak === -1 ? '' : text.slice(firstBreak)
        const rewritten = rewriteSessionHeader(first, plan, roots)
        const name = basename(file)
        const segments = relativePath.split(sep)
        const header = parseSessionHeader(first)
        const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
        const id = typeof header?.id === 'string' ? header.id : undefined
        const remintId = cwd === oldNeutral && id !== undefined && inCanonicalSessionDir(segments, name, cwd, id)
          ? rewriteSessionId(id, plan)
          : undefined
        const destination = remintId === undefined
          ? join(destinationRoot, relativePath)
          : join(destinationRoot, projectKey(newNeutral), encodeSegment(remintId), name)
        if (await exists(destination)) {
          recordSkip(report, `${relativePath}: destination already exists`)
          continue
        }
        const rewrittenText = `${rewritten}${remainder}`
        const content = rewritten === first
          ? raw
          : compressed
            ? zstdCompressSync(Buffer.from(rewrittenText, 'utf8'))
            : Buffer.from(rewrittenText, 'utf8')
        await writeLogFile(destination, content)
        bumpCount(report, 'sessions')
        bumpCount(report, remintId === undefined ? 'sessionsCarried' : 'sessionsReminted')
      }
    },
  }
}

export const migrateSessionsStep: HuaanworkMigrationStep = createMigrateSessionsStep()
