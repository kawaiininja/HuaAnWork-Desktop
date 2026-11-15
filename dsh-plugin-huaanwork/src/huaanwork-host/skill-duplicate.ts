/**
 * “另存为新技能” (Task 9).
 *
 * Copies the complete local skill (body + resources) under a new name with
 * `origin.kind = 'created'` and no enable toggle. This is the sanctioned way to
 * publish a local copy whose name is already used by a bundled skill.
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { createSkillDigest, readSkillDirectory, type SkillArchiveFile } from '@huaanwork/skill-format'
import { SKILL_NAME_RE, parseSkillMarkdown, serializeSkillMarkdown } from '@huaanwork/skill-format/markdown'

import { INTERNAL_BUNDLED_SKILLS, SYSTEM_SKILLS } from '../huaanwork-guardrails/skills.ts'
import { writeSkillLocalEntry } from './skill-local-state.ts'
import {
  findEntry,
  listUserSkills,
  stageSkillDirectory,
  takenNames,
  userSkillsRoot,
  withSkillStorageLock,
} from './skills-host.ts'

/** Rename the copy's frontmatter; the identity is parsed from SKILL.md. */
function renameSkillFiles(files: readonly SkillArchiveFile[], targetName: string): SkillArchiveFile[] {
  return files.map((file) => {
    if (file.path !== 'SKILL.md') return file
    const parsed = parseSkillMarkdown(file.data.toString('utf8'))
    const serialized = serializeSkillMarkdown({ ...parsed, name: targetName })
    return { path: 'SKILL.md', data: Buffer.from(serialized, 'utf8') }
  })
}
import type { LocalSkillInfo } from '../client-huaanwork/rpc-types.ts'

export class SkillDuplicateError extends Error {
  readonly code: 'invalid-name' | 'skill-not-found' | 'skill-name-taken'

  constructor(code: SkillDuplicateError['code'], message: string) {
    super(message)
    this.name = 'SkillDuplicateError'
    this.code = code
  }
}

async function readSourceFiles(profileDir: string, sourceName: string): Promise<SkillArchiveFile[]> {
  const entry = await findEntry(userSkillsRoot(profileDir), sourceName)
  if (entry === undefined) throw new SkillDuplicateError('skill-not-found', `本地技能 ${sourceName} 不存在`)
  if (entry.kind === 'flat') return [{ path: 'SKILL.md', data: readFileSync(entry.path) }]
  return readSkillDirectory(dirname(entry.path))
}

/**
 * Copy `sourceName` to `targetName`. The caller must pass a fresh, valid
 * kebab-case name; reserved and existing names are refused authoritatively here.
 */
export async function duplicateLocalSkill(
  profileDir: string,
  sourceName: string,
  targetName: string,
): Promise<LocalSkillInfo> {
  if (!SKILL_NAME_RE.test(targetName) || targetName.length > 64) {
    throw new SkillDuplicateError('invalid-name', `技能名 ${JSON.stringify(targetName)} 不合法`)
  }
  if (targetName === sourceName) {
    throw new SkillDuplicateError('invalid-name', '新名称必须与原名不同')
  }
  return withSkillStorageLock(profileDir, async () => {
    const files = renameSkillFiles(await readSourceFiles(profileDir, sourceName), targetName)
    const taken = await takenNames(profileDir)
    for (const reserved of SYSTEM_SKILLS) taken.add(reserved)
    for (const reserved of INTERNAL_BUNDLED_SKILLS) taken.add(reserved)
    if (taken.has(targetName)) {
      throw new SkillDuplicateError('skill-name-taken', `已存在同名技能 ${targetName}`)
    }
    await stageSkillDirectory(profileDir, targetName, files, '.skill-duplicate-')
    writeSkillLocalEntry(profileDir, targetName, {
      origin: { kind: 'created' },
      contentDigest: createSkillDigest(files),
    })
    const written = (await listUserSkills(profileDir)).find(skill => skill.name === targetName)
    if (written === undefined) {
      throw new SkillDuplicateError('skill-not-found', `技能 ${targetName} 复制后不可读`)
    }
    return written
  })
}
