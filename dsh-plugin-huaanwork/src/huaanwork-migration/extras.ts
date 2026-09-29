/**
 * Migration of the four high-value legacy gaps G1–G4 that live outside the JSON
 * registries (spec §8 的高价值缺口裁定):
 *
 * - G1 `<OLD_DSH>/agents-enabled.json` + `agents-endpoints.json` — the LAN
 *   agent catalog config; without it the user's enabled catalog agents and
 *   hand-typed endpoints reset silently (agents-host.ts reads them from
 *   `storageRoot`, which the Desktop composition sets to the profile directory).
 * - G2 `<OLD_DSH>/skill-toggles.json` — the new reader falls back to `{}` = all
 *   disabled on a missing file, so every skill the user turned on would come
 *   back off.
 * - G3 `<OLD_DSH>/skills/` — the user-authored skill tree (`<name>/SKILL.md`
 *   bundles and flat `<name>.md` files).
 * - G4 `<OLD_DSH>/workspace/` — the neutral root's contents: sessions migrated
 *   from there would otherwise resolve their `cwd` to an empty directory.
 *
 * Every source/destination name is imported from the module that reads it
 * (never re-spelled here): one rename on the read side moves the migration with
 * it instead of silently detaching from it.
 */

import type { Dirent } from 'node:fs'
import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import type { HuaanworkMigrationStep } from './index.ts'
import type { HuaanworkLegacySource, HuaanworkMigrationTarget } from './paths.ts'
import { agentsEnabledPath, agentsEndpointsPath } from '../huaanwork-host/agents-host.ts'
import { userSkillsRoot } from '../huaanwork-host/skills-host.ts'
import { neutralWorkspaceRoot } from '../huaanwork-host/workspace-state.ts'
import { skillTogglesPath } from '../huaanwork-guardrails/skills.ts'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

/** 旧 $DSH_HOME/workspace(F2 的对照面:它是树而不是文档;新侧对应 neutralWorkspaceRoot)。 */
const WORKSPACE_DIR = 'workspace'

/** 技能包的清单名(读侧 skills-host.ts:59 的同一条规则,新侧未导出常量)。 */
const SKILL_MARKDOWN_FILENAME = 'SKILL.md'

/** 技能根下的保留目录名:读侧只跳过技能根这一层(skills-host.ts:57),迁移对齐同一规则。 */
const SYSTEM_SKILLS_DIRNAME = '.system'

const RESERVED_SKILL_ROOT_DIRECTORIES: ReadonlySet<string> = new Set([SYSTEM_SKILLS_DIRNAME])
const NO_RESERVED_DIRECTORIES: ReadonlySet<string> = new Set()

/**
 * 单棵树的累计字节上限:树里可能有用户产物(生成的图片、导出的大文件),迁移以用户权限
 * 整树复制,这是迁移期的磁盘与内存护栏。超出即停止复制,已复制的部分保留(对本项而言
 * 半份树是**可用**的,skipped 如实说明它是部分复制)。
 */
const TREE_SIZE_CAP_BYTES = 256 * 1024 * 1024

/** 迁移期护栏,可注入:默认值即模块级具名常量,负例测试用小预算驱动同一实现。 */
export interface TreeMigrationLimits {
  readonly maxTotalBytes: number
}

const DEFAULT_TREE_LIMITS: TreeMigrationLimits = { maxTotalBytes: TREE_SIZE_CAP_BYTES }

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * `writeFileAtomic` types `content` as string, but its implementation hands the
 * value straight to `fs.writeFile`, which writes a Uint8Array's bytes verbatim;
 * the cast keeps the shared temp-sibling + rename discipline for the byte copy
 * instead of a local re-implementation (the same cast sessions.ts uses).
 */
function writeFileBytes(destination: string, content: Buffer): Promise<void> {
  return writeFileAtomic(destination, content as unknown as string, { mode: FILE_MODE, dirMode: DIRECTORY_MODE })
}

/**
 * Copy one legacy JSON document the new side reads as a plain record.
 *
 * Byte-for-byte, after a record check: both writers emit pretty-printed JSON,
 * and a document the new side would read as `{}` / `[]` (array, scalar) is left
 * in place with a skip instead of being installed as a broken config. A missing
 * source is a silent no-op; a destination that already exists is never
 * overwritten, so a re-run stays idempotent and the new app's own writes win.
 */
async function copyRecordDocument(
  report: HuaanworkMigrationReport,
  legacyPath: string,
  destination: string,
  countKey: string,
): Promise<void> {
  const label = basename(destination)
  if (await exists(destination)) {
    recordSkip(report, `${label}: destination already exists`)
    return
  }
  let text: string
  let parsed: unknown
  try {
    text = await readFile(legacyPath, 'utf8')
    parsed = JSON.parse(text) as unknown
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return
    recordSkip(report, `${label}: unparseable, left in place`)
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    recordSkip(report, `${label}: not a JSON record`)
    return
  }
  await writeFileAtomic(destination, text, { mode: FILE_MODE, dirMode: DIRECTORY_MODE })
  bumpCount(report, countKey)
}

/** G1: 两个局域网目录文档,各自独立判定(只有一个存在是合法状态)。 */
const AGENTS_CONFIG_DOCUMENTS = [
  { countKey: 'agentsEnabled', resolve: agentsEnabledPath },
  { countKey: 'agentsEndpoints', resolve: agentsEndpointsPath },
] as const

export const migrateAgentsConfigStep: HuaanworkMigrationStep = {
  name: 'agents-config',
  async run(
    source: HuaanworkLegacySource,
    target: HuaanworkMigrationTarget,
    report: HuaanworkMigrationReport,
  ): Promise<void> {
    for (const document of AGENTS_CONFIG_DOCUMENTS) {
      await copyRecordDocument(
        report,
        document.resolve(source.dshHome),
        document.resolve(target.profileDir),
        document.countKey,
      )
    }
  },
}

export const migrateSkillTogglesStep: HuaanworkMigrationStep = {
  name: 'skill-toggles',
  async run(
    source: HuaanworkLegacySource,
    target: HuaanworkMigrationTarget,
    report: HuaanworkMigrationReport,
  ): Promise<void> {
    await copyRecordDocument(
      report,
      skillTogglesPath(source.dshHome),
      skillTogglesPath(target.profileDir),
      'skillToggles',
    )
  },
}

/**
 * One tree copy in flight: the report, the byte budget and the counters that
 * end up in the marker. `copiedBytes` accumulates the **source** sizes of the
 * files carried (not what a filesystem reports afterwards), so the cap is
 * judged against the same number on every platform.
 */
interface TreeCopyState {
  readonly report: HuaanworkMigrationReport
  /** Root of the tree being copied; skip texts carry the path relative to it. */
  readonly sourceRoot: string
  readonly maxTotalBytes: number
  /**
   * Directory names never carried **at the tree root** (`.system` for the skills
   * tree - the exact rule the read side applies, skills-host.ts:57). Deeper
   * entries are part of the bundle that read side serves as resources.
   */
  readonly skipRootDirectories: ReadonlySet<string>
  copiedBytes: number
  copiedFiles: number
  /** Destination files that were already there and were left in place. */
  existingFiles: number
}

/**
 * Copy one directory tree; returns false when the byte budget stopped the walk.
 *
 * The walk uses `withFileTypes` and refuses every symlink explicitly - the
 * migration recurses with the user's own permissions, so following a link
 * planted in the source tree would lift files (possibly credentials) from
 * outside it into the profile directory. A destination file that is already
 * there is never overwritten: it is left in place and counted, and it consumes
 * none of the byte budget because no bytes are carried.
 */
async function copyTree(
  sourceDir: string,
  destinationDir: string,
  state: TreeCopyState,
  depth = 0,
): Promise<boolean> {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const sourcePath = join(sourceDir, entry.name)
    const destinationPath = join(destinationDir, entry.name)
    if (entry.isSymbolicLink()) {
      recordSkip(state.report, `${relative(state.sourceRoot, sourcePath)}: symlink, not copied`)
      continue
    }
    if (entry.isDirectory()) {
      if (depth === 0 && state.skipRootDirectories.has(entry.name)) continue
      await mkdir(destinationPath, { recursive: true, mode: DIRECTORY_MODE })
      if (!(await copyTree(sourcePath, destinationPath, state, depth + 1))) return false
      continue
    }
    // 非常规文件(命名管道/套接字等)没有可搬运的字节。
    if (!entry.isFile()) continue
    if (await exists(destinationPath)) {
      state.existingFiles += 1
      continue
    }
    const { size } = await stat(sourcePath)
    if (state.copiedBytes + size > state.maxTotalBytes) return false
    await writeFileBytes(destinationPath, await readFile(sourcePath))
    state.copiedBytes += size
    state.copiedFiles += 1
  }
  return true
}

/**
 * The number of skills the migrated tree exposes: `<name>/SKILL.md` bundles plus
 * flat `<name>.md` files - the layout predicate the read side scans for
 * (skills-host.ts:46-71). Counting skills rather than files keeps the marker
 * honest for bundles that carry scripts of their own.
 */
async function countMigratedSkills(destinationRoot: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(destinationRoot, { withFileTypes: true })
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return 0
    throw cause
  }
  let skills = 0
  for (const entry of entries) {
    if (entry.name === SYSTEM_SKILLS_DIRNAME) continue
    if (entry.isDirectory()) {
      if (await exists(join(destinationRoot, entry.name, SKILL_MARKDOWN_FILENAME))) skills += 1
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      skills += 1
    }
  }
  return skills
}

/**
 * G3: carry the user-authored skill tree into `<profileDir>/skills`, the root
 * the read side scans (`userSkillsRoot`).
 *
 * A destination tree the new app already wrote is left completely alone: the
 * read side merges its roots by name, so a partial merge could silently shadow
 * or duplicate a skill the user has since edited. The reserved `.system`
 * directory at the skills root is the one entry never carried (the read side
 * skips it, skills-host.ts:57); `.system` deeper inside a bundle is that
 * bundle's own resource and travels with it.
 */
export function createMigrateUserSkillsStep(limits: TreeMigrationLimits = DEFAULT_TREE_LIMITS): HuaanworkMigrationStep {
  return {
    name: 'user-skills',
    async run(
      source: HuaanworkLegacySource,
      target: HuaanworkMigrationTarget,
      report: HuaanworkMigrationReport,
    ): Promise<void> {
      const sourceRoot = userSkillsRoot(source.dshHome)
      if (!(await exists(sourceRoot))) return
      const destinationRoot = userSkillsRoot(target.profileDir)
      if (await exists(destinationRoot)) {
        recordSkip(report, 'skills: destination already exists')
        return
      }
      const state: TreeCopyState = {
        report,
        sourceRoot,
        maxTotalBytes: limits.maxTotalBytes,
        skipRootDirectories: RESERVED_SKILL_ROOT_DIRECTORIES,
        copiedBytes: 0,
        copiedFiles: 0,
        existingFiles: 0,
      }
      if (!(await copyTree(sourceRoot, destinationRoot, state))) {
        recordSkip(report, 'skills: exceeds the migration size cap, the copied tree is partial')
      }
      bumpCount(report, 'skills', await countMigratedSkills(destinationRoot))
    },
  }
}

export const migrateUserSkillsStep: HuaanworkMigrationStep = createMigrateUserSkillsStep()

/**
 * G4: merge the neutral root's contents into `neutralWorkspaceRoot(profileDir)`.
 *
 * Unlike G3 this merges: the workspace root is created at composition time and
 * the new app may already have written there, so an existing destination file
 * stays and only the conflict count is recorded. The partial copy a size-cap
 * stop leaves behind is kept - sessions pointing into a half-filled root still
 * resolve the artifacts that made it across.
 */
export function createMigrateNeutralWorkspaceStep(
  limits: TreeMigrationLimits = DEFAULT_TREE_LIMITS,
): HuaanworkMigrationStep {
  return {
    name: 'neutral-workspace',
    async run(
      source: HuaanworkLegacySource,
      target: HuaanworkMigrationTarget,
      report: HuaanworkMigrationReport,
    ): Promise<void> {
      const sourceRoot = join(source.dshHome, WORKSPACE_DIR)
      if (!(await exists(sourceRoot))) return
      const destinationRoot = neutralWorkspaceRoot(target.profileDir)
      const state: TreeCopyState = {
        report,
        sourceRoot,
        maxTotalBytes: limits.maxTotalBytes,
        skipRootDirectories: NO_RESERVED_DIRECTORIES,
        copiedBytes: 0,
        copiedFiles: 0,
        existingFiles: 0,
      }
      const completed = await copyTree(sourceRoot, destinationRoot, state)
      if (state.existingFiles > 0) {
        recordSkip(
          report,
          `${WORKSPACE_DIR}: ${state.existingFiles} destination file(s) already existed and were left in place`,
        )
      }
      if (!completed) {
        recordSkip(report, `${WORKSPACE_DIR}: exceeds the migration size cap, the copied tree is partial`)
      }
      bumpCount(report, 'workspaceFiles', state.copiedFiles)
    },
  }
}

export const migrateNeutralWorkspaceStep: HuaanworkMigrationStep = createMigrateNeutralWorkspaceStep()
