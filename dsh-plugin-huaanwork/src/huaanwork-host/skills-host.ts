import type { Dirent } from 'node:fs'
import { readFileSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { createSkillDigest, readSkillDirectory } from '@huaanwork/skill-format'
import {
  SKILL_NAME_RE,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from '@huaanwork/skill-format/markdown'
import {
  INTERNAL_BUNDLED_SKILLS,
  SYSTEM_SKILLS,
  getBundledSkill,
} from '../huaanwork-guardrails/skills.ts'
import type {
  LocalSkillInfo,
  SkillDetail,
  SkillFieldError,
  SkillImportPreview,
  SkillInfo,
  SkillLocalEntry,
  SkillWriteResult,
} from '../client-huaanwork/rpc-types.ts'
import {
  readSkillLocalState,
  readUserSkillToggles,
  removeSkillLocalEntry,
  setUserSkillToggle,
  writeSkillLocalEntry,
} from './skill-local-state.ts'

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

export function listUserSkills(storageRoot: string): Promise<LocalSkillInfo[]> {
  return listLocalRoot(storageRoot)
}

/**
 * 目录包按整棵技能目录取摘要;扁平 `.md` 只按规范化的 `SKILL.md` 取摘要
 * (上传/下载会在 Task 7/8 统一成 `<name>/SKILL.md`)。读取目录失败(例如手工
 * 放入的符号链接)时回落到 SKILL.md,保证列表仍可读、不把整个技能中心拖垮。
 */
export function skillEntryDigest(entry: DiskEntry): string {
  if (entry.kind === 'flat') {
    return createSkillDigest([{ path: 'SKILL.md', data: readFileSync(entry.path) }])
  }
  try {
    return createSkillDigest(readSkillDirectory(dirname(entry.path)))
  } catch {
    return createSkillDigest([{ path: 'SKILL.md', data: readFileSync(entry.path) }])
  }
}

function publishStateOf(entry: Pick<SkillLocalEntry, 'contentDigest' | 'publishedRevision' | 'publishedDigest'>): LocalSkillInfo['publishState'] {
  if (entry.publishedRevision === undefined) return 'not-published'
  return entry.contentDigest === entry.publishedDigest ? 'published' : 'modified'
}

async function listLocalRoot(root: string): Promise<LocalSkillInfo[]> {
  const toggles = readUserSkillToggles(root)
  const state = readSkillLocalState(root)
  const skills: LocalSkillInfo[] = []
  for (const entry of await scanRoot(userSkillsRoot(root))) {
    try {
      const parsed = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
      if (!parsed.name || !parsed.description) continue
      const local = state.skills[parsed.name]
      const contentDigest = local?.contentDigest ?? skillEntryDigest(entry)
      const origin = local?.origin ?? { kind: 'created' as const }
      skills.push({
        name: parsed.name,
        description: parsed.description,
        source: 'user',
        ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
        enabled: toggles[parsed.name] === true,
        origin,
        contentDigest,
        ...(local?.publishedRevision !== undefined ? { publishedRevision: local.publishedRevision } : {}),
        ...(local?.publishedDigest !== undefined ? { publishedDigest: local.publishedDigest } : {}),
        publishState: publishStateOf({ contentDigest, ...local }),
      })
    } catch {
      // 不可读条目跳过(与 provider 的 warn+skip 语义对齐)
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
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

export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024
export const MAX_SKILL_CONTENT_BYTES = 64 * 1024

export type SkillInput = {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  content: string
}
export type SkillUpdateInput = Omit<SkillInput, 'name' | 'userInvocable'>

/**
 * 已占用名:系统技能 + 内部技能 + 既有用户技能。普通内置名不再阻止本地创建/
 * 导入(它们可以下载/复制为本地副本);首次上传的内置同名检查在 Task 8。
 * 外部技能允许被用户同名遮蔽——这是 dsh rank 的设计行为。
 */
export async function takenNames(storageRoot: string): Promise<Set<string>> {
  const names = new Set<string>(SYSTEM_SKILLS)
  for (const name of INTERNAL_BUNDLED_SKILLS) names.add(name)
  for (const skill of await listUserSkills(storageRoot)) names.add(skill.name)
  return names
}

function validateSkillFields(input: SkillInput, taken: ReadonlySet<string>): SkillFieldError[] {
  const errors: SkillFieldError[] = []
  if (!SKILL_NAME_RE.test(input.name)) {
    errors.push({ field: 'name', message: '名称需为小写字母/数字/连字符（kebab-case）' })
  } else if (input.name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push({ field: 'name', message: `名称不超过 ${MAX_SKILL_NAME_LENGTH} 字符` })
  } else if (taken.has(input.name)) {
    errors.push({ field: 'name', message: '已存在同名技能' })
  }
  if (!input.description?.trim()) {
    errors.push({ field: 'description', message: '描述必填' })
  } else if (input.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    errors.push({ field: 'description', message: `描述不超过 ${MAX_SKILL_DESCRIPTION_LENGTH} 字符` })
  }
  if (!input.content?.trim()) {
    errors.push({ field: 'content', message: '正文必填' })
  } else if (Buffer.byteLength(input.content, 'utf8') > MAX_SKILL_CONTENT_BYTES) {
    errors.push({ field: 'content', message: '正文不超过 64 KiB' })
  }
  return errors
}

/** 同目录 <target>.tmp + rename:对 watch 与 discovery 均不可见。 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmp = `${targetPath}.tmp`
  await fs.mkdir(dirname(targetPath), { recursive: true })
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, targetPath)
}

export async function createSkill(storageRoot: string, input: SkillInput): Promise<SkillWriteResult> {
  const errors = validateSkillFields(input, await takenNames(storageRoot))
  if (errors.length > 0) return { ok: false, fieldErrors: errors }
  // 先读状态:损坏文档必须在落盘前失败,不留下没有来源记录的用户技能。
  readSkillLocalState(storageRoot)
  const serialized = serializeSkillMarkdown({
    name: input.name,
    description: input.description,
    ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
    ...(input.disableModelInvocation ? { disableModelInvocation: true } : {}),
    // R7:创建不写 user-invocable;启用开关是 HuaAnWork 手动调用的唯一产品门。
    content: input.content,
    extraLines: [],
  })
  const skillPath = join(userSkillsRoot(storageRoot), input.name, 'SKILL.md')
  await atomicWrite(skillPath, serialized)
  const contentDigest = createSkillDigest([{ path: 'SKILL.md', data: Buffer.from(serialized, 'utf8') }])
  const localEntry: SkillLocalEntry = { origin: { kind: 'created' }, contentDigest }
  writeSkillLocalEntry(storageRoot, input.name, localEntry)
  return {
    ok: true,
    skill: {
      name: input.name,
      description: input.description,
      source: 'user',
      ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
      enabled: readUserSkillToggles(storageRoot)[input.name] === true,
      origin: localEntry.origin,
      contentDigest,
      publishState: publishStateOf(localEntry),
    },
  }
}

/** 合并式更新:读原文件,只覆盖表单管理字段,metadata 等未知键经 extraLines 原样保留。 */
export async function updateSkill(
  storageRoot: string,
  name: string,
  input: SkillUpdateInput,
): Promise<SkillWriteResult> {
  const state = readSkillLocalState(storageRoot)
  const entry = await findEntry(userSkillsRoot(storageRoot), name)
  if (!entry) {
    return { ok: false, fieldErrors: [{ field: 'name', message: `用户技能 ${name} 不存在（内置与外部技能不可编辑）` }] }
  }
  const errors = validateSkillFields({ ...input, name }, new Set())
  if (errors.length > 0) return { ok: false, fieldErrors: errors }
  const original = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
  await atomicWrite(
    entry.path,
    serializeSkillMarkdown({
      name: original.name,
      description: input.description,
      // 缺省即默认(模型可调用/用户可调用),只在非默认值时落键
      ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
      ...(input.disableModelInvocation ? { disableModelInvocation: true } : {}),
      // R7:表单不再接收 userInvocable,但原文件既有行必须保留。
      ...(original.userInvocable !== undefined ? { userInvocable: original.userInvocable } : {}),
      content: input.content,
      extraLines: original.extraLines,
    }),
  )
  const contentDigest = skillEntryDigest(entry)
  const previous = state.skills[name]
  const localEntry: SkillLocalEntry = {
    origin: previous?.origin ?? { kind: 'created' },
    contentDigest,
    ...(previous?.publishedRevision !== undefined ? { publishedRevision: previous.publishedRevision } : {}),
    ...(previous?.publishedDigest !== undefined ? { publishedDigest: previous.publishedDigest } : {}),
  }
  writeSkillLocalEntry(storageRoot, name, localEntry)
  return {
    ok: true,
    skill: {
      name,
      description: input.description,
      source: 'user',
      ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
      enabled: readUserSkillToggles(storageRoot)[name] === true,
      origin: localEntry.origin,
      contentDigest,
      ...(localEntry.publishedRevision !== undefined ? { publishedRevision: localEntry.publishedRevision } : {}),
      ...(localEntry.publishedDigest !== undefined ? { publishedDigest: localEntry.publishedDigest } : {}),
      publishState: publishStateOf(localEntry),
    },
  }
}

export async function removeSkill(storageRoot: string, name: string): Promise<void> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`)
  const entry = await findEntry(userSkillsRoot(storageRoot), name)
  if (!entry) throw new Error(`用户技能 ${name} 不存在（内置与外部技能不可删除）`)
  // 损坏状态在删除文件前暴露,避免留下无法清理的来源记录。
  readSkillLocalState(storageRoot)
  readUserSkillToggles(storageRoot)
  if (entry.kind === 'bundle') await fs.rm(dirname(entry.path), { recursive: true })
  else await fs.unlink(entry.path)
  removeSkillLocalEntry(storageRoot, name)
  setUserSkillToggle(storageRoot, name, false)
}

const remoteSource = /github:|git\+|https?:\/\//i

async function containsSymlink(dir: string): Promise<boolean> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true
    if (entry.isDirectory() && (await containsSymlink(join(dir, entry.name)))) return true
  }
  return false
}

async function copyDir(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) await copyDir(from, to)
    else if (entry.isFile()) await fs.copyFile(from, to)
    // symlink 已在 preview 拒绝;此处防御性跳过
  }
}

export async function previewSkillImport(
  storageRoot: string,
  params: { path: string } | string,
): Promise<SkillImportPreview> {
  const sourcePath = typeof params === 'string' ? params : params?.path
  const fail = (message: string): SkillImportPreview => ({ ok: false, fieldErrors: [{ field: 'path', message }] })
  if (!sourcePath || typeof sourcePath !== 'string') return fail('路径必填')
  if (remoteSource.test(sourcePath)) return fail('不允许远程来源')
  const stat = await fs.stat(sourcePath).catch(() => undefined)
  if (!stat) return fail('路径不存在')
  let raw: string
  let kind: 'file' | 'directory'
  let sourceName: string
  if (stat.isDirectory()) {
    kind = 'directory'
    sourceName = basename(sourcePath)
    if (await containsSymlink(sourcePath)) return fail('目录包含符号链接，已拒绝导入')
    raw = await fs.readFile(join(sourcePath, 'SKILL.md'), 'utf8').catch(() => '')
    if (!raw) return fail('目录中未找到 SKILL.md')
  } else {
    kind = 'file'
    if (!sourcePath.endsWith('.md')) return fail('仅支持 .md 文件或含 SKILL.md 的目录')
    sourceName = basename(sourcePath).replace(/\.md$/, '')
    raw = await fs.readFile(sourcePath, 'utf8')
  }
  const parsed = parseSkillMarkdown(raw)
  const errors = validateSkillFields(
    { name: parsed.name, description: parsed.description, content: parsed.content },
    await takenNames(storageRoot),
  )
  if (errors.length > 0) return { ok: false, fieldErrors: errors }
  return {
    ok: true,
    preview: {
      name: parsed.name,
      description: parsed.description,
      source: 'user',
      ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      content: parsed.content,
      targetName: parsed.name,
      sourceName,
      nameMismatch: sourceName !== parsed.name,
      kind,
    },
  }
}

export const previewImport = previewSkillImport

export async function importSkill(
  storageRoot: string,
  params: { path: string } | string,
): Promise<SkillWriteResult> {
  const sourcePath = typeof params === 'string' ? params : params?.path
  if (!sourcePath || typeof sourcePath !== 'string') {
    return { ok: false, fieldErrors: [{ field: 'path', message: '路径必填' }] }
  }
  const preview = await previewSkillImport(storageRoot, sourcePath)
  if (!preview.ok) return preview
  // 与 create 对称:损坏状态必须在复制前失败,不留下没有来源记录的副本。
  readSkillLocalState(storageRoot)
  const { targetName, kind } = preview.preview
  const root = userSkillsRoot(storageRoot)
  await fs.mkdir(root, { recursive: true })
  if (kind === 'file') {
    // 原始文件原样落盘(保留未知 frontmatter 键与 user-invocable 行),目录名以 frontmatter name 为准
    await atomicWrite(join(root, targetName, 'SKILL.md'), await fs.readFile(sourcePath, 'utf8'))
  } else {
    const tmp = join(storageRoot, `.skill-import-${targetName}`)
    await fs.rm(tmp, { recursive: true, force: true })
    try {
      await copyDir(sourcePath, tmp)
      await fs.rename(tmp, join(root, targetName))
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }
  const targetEntry: DiskEntry = { path: join(root, targetName, 'SKILL.md'), kind: 'bundle' }
  const contentDigest = skillEntryDigest(targetEntry)
  const localEntry: SkillLocalEntry = { origin: { kind: 'imported' }, contentDigest }
  writeSkillLocalEntry(storageRoot, targetName, localEntry)
  return {
    ok: true,
    skill: {
      name: targetName,
      description: preview.preview.description,
      source: 'user',
      ...(preview.preview.whenToUse ? { whenToUse: preview.preview.whenToUse } : {}),
      enabled: readUserSkillToggles(storageRoot)[targetName] === true,
      origin: localEntry.origin,
      contentDigest,
      publishState: publishStateOf(localEntry),
    },
  }
}

/**
 * 启用/禁用本地用户技能:只接受 `<profileDir>/skills` 中按 frontmatter name
 * 真实存在的技能,写 `user-skill-toggles.json`。普通 bundled 与外部技能没有
 * 启用键——它们必须先创建/导入/下载成本地副本。
 */
export async function setSkillEnabled(
  storageRoot: string,
  name: string,
  enabled: boolean,
): Promise<{ ok: true }> {
  if (!name) throw new Error('skill.setEnabled requires params.name')
  if (SYSTEM_SKILLS.has(name)) throw new Error(`skill ${name} 为系统技能，始终启用`)
  // 内部技能由创建入口直接注入正文,不接受开关,也不注册进全局技能目录。
  if (INTERNAL_BUNDLED_SKILLS.has(name)) throw new Error(`skill ${name} 为内部技能，不能启停`)
  const entry = await findEntry(userSkillsRoot(storageRoot), name)
  if (!entry) throw new Error(`skill ${name} 不是本地用户技能（请先在“我的技能”中创建、导入或下载）`)
  setUserSkillToggle(storageRoot, name, enabled)
  return { ok: true }
}

