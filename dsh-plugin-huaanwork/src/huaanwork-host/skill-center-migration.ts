import { readFileSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import { createSkillDigest, readSkillDirectory, writeSkillDirectory } from '@huaanwork/skill-format'
import type { SkillArchiveFile } from '@huaanwork/skill-format'
import { SKILL_NAME_RE, parseSkillMarkdown } from '@huaanwork/skill-format/markdown'
import {
  INTERNAL_BUNDLED_SKILLS,
  SYSTEM_SKILLS,
  findBundledEntry,
  readSkillToggles,
} from '../huaanwork-guardrails/skills.ts'
import {
  findEntry,
  scanRoot,
  skillEntryDigestStrict,
  userSkillsRoot,
} from './skills-host.ts'
import {
  markSkillCenterMigrationComplete,
  readSkillLocalState,
  readUserSkillToggles,
  setUserSkillToggle,
  writeSkillLocalEntry,
} from './skill-local-state.ts'

/**
 * 一次性本地技能迁移（设计 §11.1）。
 *
 * 旧版行为是“用户技能始终可调用、普通内置技能按 `skill-toggles.json` 启用”。
 * 新版把两者统一成“本地副本 + `user-skill-toggles.json`”：
 *
 * 1. 既有用户技能标为 `created` 并启用（保留升级前的可调用性）；
 * 2. 旧开关表中已启用的普通内置技能复制成 `<profileDir>/skills/<name>/`，
 *    来源 `bundled`，并启用；系统/内部技能不复制；
 * 3. 同名本地副本不覆盖文件，只启用本地副本并追加迁移警告；
 * 4. 外部技能不导入；旧文件一个都不删。
 *
 * 完成标记只在所有副本与状态写成功后写入。任何失败都留下无标记的可重入状态：
 * 已写出的条目/副本会在下次启动被识别并继续完成。
 */

function bundledSkillFiles(name: string): SkillArchiveFile[] {
  const entry = findBundledEntry(name)
  if (!entry) throw new Error(`内置技能 ${name} 不存在`)
  return entry.kind === 'bundle'
    ? readSkillDirectory(dirname(entry.path))
    : [{ path: 'SKILL.md', data: readFileSync(entry.path) }]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function copyBundledSkill(
  profileDir: string,
  name: string,
  files: readonly SkillArchiveFile[],
): Promise<void> {
  const root = userSkillsRoot(profileDir)
  await fs.mkdir(root, { recursive: true })
  // staging 放在 skills 根之外:扫描器永远不会把一个未完成的副本当成技能。
  const tmp = join(profileDir, `.skill-migration-${name}`)
  await fs.rm(tmp, { recursive: true, force: true })
  try {
    await writeSkillDirectory(tmp, files)
    await fs.rename(tmp, join(root, name))
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function ensureSkillCenterMigration(profileDir: string): Promise<string[]> {
  const state = readSkillLocalState(profileDir)
  if (state.migration?.version === 1) return []
  // 损坏的启用状态文档必须在任何写盘/复制前暴露，避免迁移只写一半。
  readUserSkillToggles(profileDir)

  const warnings: string[] = []
  const labeled = new Set(Object.keys(state.skills))
  const skippedInvalidLocalNames = new Set<string>()
  const userRoot = userSkillsRoot(profileDir)

  // 先读取旧用户目录与旧开关表，再开始任何复制/写入。
  // 直接扫描 userRoot（保留根目录级 ENOTDIR 抛错），不经过 listUserSkills 的宽松摘要回落。
  const userEntries = await scanRoot(userRoot)
  const legacyToggles = readSkillToggles(profileDir)

  for (const entry of userEntries) {
    let parsed
    try {
      parsed = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
    } catch {
      continue
    }
    if (!parsed.name || !parsed.description) continue
    if (!SKILL_NAME_RE.test(parsed.name)) {
      warnings.push(`跳过非法名称的本地技能 ${parsed.name}`)
      continue
    }
    if (!labeled.has(parsed.name)) {
      let contentDigest: string
      try {
        contentDigest = skillEntryDigestStrict(entry)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warnings.push(`跳过不安全的本地技能 ${parsed.name}：${reason}`)
        skippedInvalidLocalNames.add(parsed.name)
        continue
      }
      writeSkillLocalEntry(profileDir, parsed.name, {
        origin: { kind: 'created' },
        contentDigest,
      })
      labeled.add(parsed.name)
    }
    // 旧版没有用户技能启用门:存量用户技能全部保留可调用。
    setUserSkillToggle(profileDir, parsed.name, true)
  }

  for (const name of Object.keys(legacyToggles)) {
    if (SYSTEM_SKILLS.has(name) || INTERNAL_BUNDLED_SKILLS.has(name)) continue
    // 只有当前仍存在、且不是系统/内部技能的普通内置条目参与复制。
    if (!findBundledEntry(name)) continue

    const existing = await findEntry(userRoot, name)
    if (existing) {
      if (skippedInvalidLocalNames.has(name)) continue
      if (!labeled.has(name)) {
        let contentDigest: string
        try {
          contentDigest = skillEntryDigestStrict(existing)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          warnings.push(`跳过不安全的本地技能 ${name}：${reason}`)
          continue
        }
        writeSkillLocalEntry(profileDir, name, {
          origin: { kind: 'created' },
          contentDigest,
        })
        labeled.add(name)
      }
      setUserSkillToggle(profileDir, name, true)
      // 已由本迁移复制出的副本(重入路径)不是同名冲突,不再追加警告。
      if (readSkillLocalState(profileDir).skills[name]?.origin.kind !== 'bundled') {
        warnings.push(`内置技能 ${name} 未复制：已存在同名本地技能`)
      }
      continue
    }

    const target = join(userRoot, name)
    if (await pathExists(target)) {
      warnings.push(`内置技能 ${name} 未复制：目标路径已存在`)
      continue
    }

    const files = bundledSkillFiles(name)
    const contentDigest = createSkillDigest(files)
    if (!labeled.has(name)) {
      // 先写来源再复制:副本成功而开关未写时崩溃,重入仍保住 bundled 来源。
      writeSkillLocalEntry(profileDir, name, { origin: { kind: 'bundled' }, contentDigest })
      labeled.add(name)
    }
    await copyBundledSkill(profileDir, name, files)
    setUserSkillToggle(profileDir, name, true)
  }

  markSkillCenterMigrationComplete(profileDir, warnings)
  return warnings
}
