import type { Dirent } from 'node:fs'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  SKILL_NAME_RE,
  getBundledSkill,
  parseSkillMarkdown,
} from '../huaanwork-guardrails/skills.ts'
import type {
  SkillDetail,
  SkillInfo,
} from '../client-huaanwork/rpc-types.ts'

/**
 * 技能宿主读路径(Task 7 子集):skill-invoke 的 @skill 分发只依赖
 * userSkillsRoot / externalSkillsRoot / findEntry / getSkill。
 * Task 10 在此基础上补齐 list/get 路由与写路径(create/update/remove/import),
 * 本文件的读函数签名与旧 sidecar skills-host.ts 逐字一致。
 *
 * 存储根:旧 sidecar 传 $DSH_HOME;Desktop 组合下技能存于 profileDir
 * (与 projects.json / tasks.json 同目录,计划 Task 10 口径),调用方传 routeCtx.profileDir。
 */

export function userSkillsRoot(storageRoot: string): string {
  return join(storageRoot, 'skills')
}

export function externalSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills')
}

export type DiskEntry = { path: string; kind: 'bundle' | 'flat' }

/** 扫描一个技能根:目录包(<name>/SKILL.md)与扁平 <name>.md 双形态;跳过 .system。 */
async function scanRoot(root: string): Promise<DiskEntry[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const found: DiskEntry[] = []
  for (const entry of entries) {
    if (entry.name === '.system') continue
    if (entry.isDirectory()) {
      const skillFile = join(root, entry.name, 'SKILL.md')
      try {
        await fs.access(skillFile)
        found.push({ path: skillFile, kind: 'bundle' })
      } catch {
        // 无 SKILL.md 的目录不是技能
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push({ path: join(root, entry.name), kind: 'flat' })
    }
  }
  return found
}

async function listRoot(root: string, source: 'user' | 'external'): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  for (const entry of await scanRoot(root)) {
    try {
      const parsed = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
      if (!parsed.name || !parsed.description) continue
      skills.push({
        name: parsed.name,
        description: parsed.description,
        source,
        ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      })
    } catch {
      // 不可读条目跳过(与 provider 的 warn+skip 语义对齐)
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export function listUserSkills(storageRoot: string): Promise<SkillInfo[]> {
  return listRoot(userSkillsRoot(storageRoot), 'user')
}

export function listExternalSkills(env: NodeJS.ProcessEnv = process.env): Promise<SkillInfo[]> {
  return listRoot(externalSkillsRoot(env), 'external')
}

/** 按 frontmatter name 在指定 root 找条目(name 是运行时唯一事实来源,与文件/目录名无关)。 */
export async function findEntry(root: string, name: string): Promise<DiskEntry | undefined> {
  if (!SKILL_NAME_RE.test(name)) return undefined
  for (const entry of await scanRoot(root)) {
    try {
      const parsed = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
      if (parsed.name === name) return entry
    } catch {
      // 跳过不可读条目
    }
  }
  return undefined
}

export type SkillSourceFilter = 'bundled' | 'user' | 'external'

/** 按来源读取技能完整内容。未指定 source 时按 用户 → 外部 → 内置 的 rank order;指定时只在该来源的根里找。 */
export async function getSkill(
  storageRoot: string,
  name: string,
  source?: SkillSourceFilter,
): Promise<SkillDetail | undefined> {
  if (!SKILL_NAME_RE.test(name)) return undefined
  const readEntry = async (root: string, source: 'user' | 'external'): Promise<SkillDetail | undefined> => {
    const entry = await findEntry(root, name)
    if (!entry) return undefined
    const parsed = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
    return {
      name: parsed.name,
      description: parsed.description,
      source,
      ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      ...(parsed.disableModelInvocation !== undefined ? { disableModelInvocation: parsed.disableModelInvocation } : {}),
      ...(parsed.userInvocable !== undefined ? { userInvocable: parsed.userInvocable } : {}),
      content: parsed.content,
    }
  }
  if (source === 'bundled') {
    const bundled = getBundledSkill(name)
    return bundled ? { ...bundled, source: 'bundled' as const } : undefined
  }
  if (source === 'user') return readEntry(userSkillsRoot(storageRoot), 'user')
  if (source === 'external') return readEntry(externalSkillsRoot(), 'external')
  for (const [root, ranked] of [
    [userSkillsRoot(storageRoot), 'user'],
    [externalSkillsRoot(), 'external'],
  ] as const) {
    const detail = await readEntry(root, ranked)
    if (detail) return detail
  }
  const bundled = getBundledSkill(name)
  return bundled ? { ...bundled, source: 'bundled' as const } : undefined
}
