import type { Dirent } from 'node:fs'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  INTERNAL_BUNDLED_SKILLS,
  SKILL_NAME_RE,
  SYSTEM_SKILLS,
  getBundledSkill,
  getBundledSkillRegistrar,
  listBundledSkills,
  parseSkillMarkdown,
  readSkillToggles,
  registerBundledSkill,
  serializeSkillMarkdown,
  setSkillToggle,
} from '../huaanwork-guardrails/skills.ts'
import type {
  SkillDetail,
  SkillFieldError,
  SkillImportPreview,
  SkillInfo,
  SkillWriteResult,
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
export type SkillUpdateInput = Omit<SkillInput, 'name'>

/** 已占用名:内置 + 用户技能(外部技能允许被用户同名遮蔽——这是 dsh rank 的设计行为)。 */
export async function takenNames(storageRoot: string): Promise<Set<string>> {
  const names = new Set(listBundledSkills().map((skill) => skill.name))
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
    errors.push({ field: 'name', message: '已存在同名技能（含内置技能）' })
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
  // 与 update 对称:invocation 布尔只在非默认值时落键,不给每个新技能写默认键
  await atomicWrite(
    join(userSkillsRoot(storageRoot), input.name, 'SKILL.md'),
    serializeSkillMarkdown({
      name: input.name,
      description: input.description,
      ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
      ...(input.disableModelInvocation ? { disableModelInvocation: true } : {}),
      ...(input.userInvocable === false ? { userInvocable: false } : {}),
      content: input.content,
      extraLines: [],
    }),
  )
  return {
    ok: true,
    skill: {
      name: input.name,
      description: input.description,
      source: 'user',
      ...(input.whenToUse ? { whenToUse: input.whenToUse } : {}),
    },
  }
}

/** 合并式更新:读原文件,只覆盖表单管理字段,metadata 等未知键经 extraLines 原样保留。 */
export async function updateSkill(
  storageRoot: string,
  name: string,
  input: SkillUpdateInput,
): Promise<SkillWriteResult> {
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
      ...(input.userInvocable === false ? { userInvocable: false } : {}),
      content: input.content,
      extraLines: original.extraLines,
    }),
  )
  return {
    ok: true,
    skill: {
      name,
      description: input.description,
      source: 'user',
      ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
    },
  }
}

export async function removeSkill(storageRoot: string, name: string): Promise<void> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`)
  const entry = await findEntry(userSkillsRoot(storageRoot), name)
  if (!entry) throw new Error(`用户技能 ${name} 不存在（内置与外部技能不可删除）`)
  if (entry.kind === 'bundle') await fs.rm(dirname(entry.path), { recursive: true })
  else await fs.unlink(entry.path)
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
  const { targetName, kind } = preview.preview
  const root = userSkillsRoot(storageRoot)
  await fs.mkdir(root, { recursive: true })
  if (kind === 'file') {
    // 原始文件原样落盘(保留未知 frontmatter 键),目录名以 frontmatter name 为准
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
  return {
    ok: true,
    skill: {
      name: targetName,
      description: preview.preview.description,
      source: 'user',
      ...(preview.preview.whenToUse ? { whenToUse: preview.preview.whenToUse } : {}),
    },
  }
}

const skillHandles = new Map<string, () => void>()

export function getSkillHandlesForTest(): Map<string, () => void> {
  return skillHandles
}

export async function setSkillEnabled(
  storageRoot: string,
  name: string,
  enabled: boolean,
): Promise<{ ok: true }> {
  if (!name) throw new Error('skill.setEnabled requires params.name')
  if (SYSTEM_SKILLS.has(name)) throw new Error(`skill ${name} 为系统技能，始终启用`)
  // 内部技能由创建入口直接注入正文,不接受开关,也不注册进全局技能目录。
  if (INTERNAL_BUNDLED_SKILLS.has(name)) throw new Error(`skill ${name} 为内部技能，不能启停`)
  if (!listBundledSkills().some((skill) => skill.name === name)) {
    throw new Error(`skill ${name} is not a bundled skill`)
  }
  setSkillToggle(storageRoot, name, enabled)

  // 运行时即时生效:dispose-then-register 保证幂等
  const disposeOld = skillHandles.get(name)
  if (disposeOld) {
    disposeOld()
    skillHandles.delete(name)
  }
  if (enabled) {
    const registrar = getBundledSkillRegistrar()
    if (registrar?.skills) {
      const dispose = registerBundledSkill(registrar, name)
      if (!dispose) throw new Error(`skill ${name} failed to register`)
      skillHandles.set(name, dispose)
    }
  }
  return { ok: true }
}

/** registerBundledSkill 的 registrar 参数形状(结构性类型,避免再引 SkillRegistration)。 */
export type BundledSkillRegistrar = Parameters<typeof registerBundledSkill>[0]

/**
 * boot/generation 重启后按 skill-toggles.json 恢复已启用 bundled skills 的运行时注册
 * (M4 评审 D2;legacy host.ts:411-421 同构)。guardrails apply 只注册 explore/test-fix
 * 两个系统技能,用户启用的技能若不在 boot 期重注册,重启后 skill.list 仍显示
 * enabled:true 但模型目录(ctx.skills)取不到。dispose-then-register 与 setSkillEnabled
 * 共用 skillHandles 记账:harness register 同层 first-wins,重复注册拿 no-op
 * disposer——boot 注册不进本表,后续 setEnabled(false) 将无法 dispose、禁用半残。
 * 注册失败(dispose 为 undefined)静默跳过,不让技能恢复拖垮 boot(legacy 容错语义)。
 * 内部技能(`INTERNAL_BUNDLED_SKILLS`)即使出现在旧开关表里也不恢复注册。
 */
export function restoreEnabledBundledSkills(storageRoot: string, registrar: BundledSkillRegistrar): void {
  for (const name of Object.keys(readSkillToggles(storageRoot))) {
    if (SYSTEM_SKILLS.has(name) || INTERNAL_BUNDLED_SKILLS.has(name)) continue
    const disposeOld = skillHandles.get(name)
    if (disposeOld) {
      disposeOld()
      skillHandles.delete(name)
    }
    const dispose = registerBundledSkill(registrar, name)
    if (!dispose) continue
    skillHandles.set(name, dispose)
  }
}

