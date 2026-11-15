import type { Dirent } from 'node:fs'
import { readFileSync, promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  MAX_SKILL_ARCHIVE_CONTENT_BYTES,
  MAX_SKILL_ENTRIES,
  createSkillDigest,
  readSkillDirectory,
  writeSkillDirectory,
} from '@huaanwork/skill-format'
import type { SkillArchiveFile } from '@huaanwork/skill-format'
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
 * userSkillsRoot / findEntry / getSkill。
 * Task 10 在此基础上补齐 list/get 路由与写路径(create/update/remove/import),
 * 本文件的读函数签名与旧 sidecar skills-host.ts 逐字一致。
 *
 * 存储根:旧 sidecar 传 $DSH_HOME;Desktop 组合下技能存于 profileDir
 * (与 projects.json / tasks.json 同目录,计划 Task 10 口径),调用方传 routeCtx.profileDir。
 */

export function userSkillsRoot(storageRoot: string): string {
  return join(storageRoot, 'skills')
}

export type DiskEntry = { path: string; kind: 'bundle' | 'flat' }

/** 扫描一个技能根:目录包(<name>/SKILL.md)与扁平 <name>.md 双形态;跳过 .system。 */
export async function scanRoot(root: string): Promise<DiskEntry[]> {
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

export function listUserSkills(storageRoot: string): Promise<LocalSkillInfo[]> {
  return listLocalRoot(storageRoot)
}

/**
 * 严格摘要:目录包按整棵技能目录取摘要(扁平 `.md` 按规范化的 `SKILL.md`),
 * 违反目录安全规则(符号链接、硬链接、条目/字节预算)时抛错。
 *
 * 所有会把摘要写进 `skill-local-state.json` 的路径(create/update/import/迁移)
 * 都必须用它:部分摘要会让 `publishState` 把未上传的资源当成已发布内容。
 */
export function skillEntryDigestStrict(entry: DiskEntry): string {
  if (entry.kind === 'flat') {
    return createSkillDigest([{ path: 'SKILL.md', data: readFileSync(entry.path) }])
  }
  return createSkillDigest(readSkillDirectory(dirname(entry.path)))
}

/**
 * 列表展示专用的宽松摘要:目录不可读(例如手工放入的符号链接)时回落到
 * SKILL.md,保证列表仍可读、不把整个技能中心拖垮。只用于 `listUserSkills`
 * 投影,绝不能把结果持久化。
 */
function skillEntryDigestLenient(entry: DiskEntry): string {
  try {
    return skillEntryDigestStrict(entry)
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
  const seen = new Set<string>()
  for (const entry of await scanRoot(userSkillsRoot(root))) {
    try {
      const parsed = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
      if (!parsed.name || !parsed.description) continue
      // 与 findEntry 同序取扫描序第一条:同名扁平 .md 与目录包不重复投影。
      if (seen.has(parsed.name)) continue
      seen.add(parsed.name)
      const local = Object.hasOwn(state.skills, parsed.name) ? state.skills[parsed.name] : undefined
      // 投影摘要永远现算磁盘,带外编辑才可见;记录摘要只用于发布快照比较。
      const contentDigest = skillEntryDigestLenient(entry)
      const origin = local?.origin ?? { kind: 'created' as const }
      skills.push({
        name: parsed.name,
        description: parsed.description,
        source: 'user',
        ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
        enabled: Object.hasOwn(toggles, parsed.name) && toggles[parsed.name] === true,
        origin,
        contentDigest,
        ...(local?.publishedRevision !== undefined ? { publishedRevision: local.publishedRevision } : {}),
        ...(local?.publishedDigest !== undefined ? { publishedDigest: local.publishedDigest } : {}),
        publishState: publishStateOf({ ...local, contentDigest }),
      })
    } catch {
      // 不可读条目跳过(与 provider 的 warn+skip 语义对齐)
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
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

export type SkillSourceFilter = 'bundled' | 'user'

/** 按来源读取技能完整内容。未指定 source 时按 用户 → 内置 的 rank order;外部根不再是回退来源。 */
export async function getSkill(
  storageRoot: string,
  name: string,
  source?: SkillSourceFilter,
): Promise<SkillDetail | undefined> {
  if (!SKILL_NAME_RE.test(name)) return undefined
  const readEntry = async (root: string, source: 'user'): Promise<SkillDetail | undefined> => {
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
  const detail = await readEntry(userSkillsRoot(storageRoot), 'user')
  if (detail) return detail
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

const storageWriteLocks = new Map<string, Promise<void>>()

/**
 * 按规范化 `storageRoot` 串行化本地技能写操作（create/update/remove/import/setEnabled/迁移），
 * 避免并发请求在异步 I/O 间隙交错读写 `skill-local-state.json` 与 `user-skill-toggles.json`。
 */
export async function withSkillStorageLock<T>(storageRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(storageRoot)
  const previous = storageWriteLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock
  })
  storageWriteLocks.set(key, current)
  await previous
  try {
    return await fn()
  } finally {
    if (storageWriteLocks.get(key) === current) {
      storageWriteLocks.delete(key)
    }
    release()
  }
}

/** 同目录 <target>.tmp + rename:对 watch 与 discovery 均不可见。 */
async function atomicWrite(targetPath: string, content: string | Buffer): Promise<void> {
  const tmp = `${targetPath}.tmp`
  await fs.mkdir(dirname(targetPath), { recursive: true })
  try {
    await fs.writeFile(tmp, content)
    await fs.rename(tmp, targetPath)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

function countSkillEntries(files: readonly SkillArchiveFile[]): number {
  const entries = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/')
    for (let index = 1; index <= segments.length; index += 1) {
      entries.add(segments.slice(0, index).join('/'))
    }
  }
  return entries.size
}

/** 写前校验总条目数与未压缩字节预算，再计算权威目录摘要。 */
function validatedSkillDigest(files: readonly SkillArchiveFile[]): string {
  if (countSkillEntries(files) > MAX_SKILL_ENTRIES) {
    throw new Error(`技能归档非法：条目数超过${MAX_SKILL_ENTRIES}`)
  }
  const totalBytes = files.reduce((sum, file) => sum + file.data.byteLength, 0)
  if (totalBytes > MAX_SKILL_ARCHIVE_CONTENT_BYTES) {
    throw new Error(`技能归档非法：文件内容超过${MAX_SKILL_ARCHIVE_CONTENT_BYTES}字节上限`)
  }
  return createSkillDigest(files)
}

/**
 * 写路径的目标目录预检:目标已存在时必须是真实目录、整棵树通过严格读取
 * (符号链接、硬链接、条目/字节预算),且不得已有 `SKILL.md` (防止同名目录
 * 覆盖不同 frontmatter `name` 或不可解析的既有技能)。
 */
async function readSafeExistingSkillDir(dir: string): Promise<{ exists: boolean; files: SkillArchiveFile[] }> {
  const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (stat === undefined) return { exists: false, files: [] }
  if (stat.isSymbolicLink()) throw new Error(`技能目录不得是符号链接：${dir}`)
  if (!stat.isDirectory()) throw new Error(`技能路径必须是目录：${dir}`)
  const files = readSkillDirectory(dir)
  const hasSkillMd = await fs.lstat(join(dir, 'SKILL.md')).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
  if (hasSkillMd || files.some((file) => file.path === 'SKILL.md')) {
    throw new Error(`目标技能目录已存在 SKILL.md：${dir}`)
  }
  return { exists: true, files }
}

/**
 * 把完整文件集写入 `skills/` 根外的暂存目录后原子 `rename` 进目标路径；
 * 失败时清理暂存目录，扫描器永远不会看到半成品。
 */
export async function stageSkillDirectory(
  storageRoot: string,
  targetName: string,
  files: readonly SkillArchiveFile[],
  tmpPrefix = '.skill-stage-',
): Promise<void> {
  const root = userSkillsRoot(storageRoot)
  const tmp = join(storageRoot, `${tmpPrefix}${targetName}`)
  await fs.rm(tmp, { recursive: true, force: true })
  try {
    await writeSkillDirectory(tmp, files)
    await fs.mkdir(root, { recursive: true })
    await fs.rename(tmp, join(root, targetName))
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function createSkill(storageRoot: string, input: SkillInput): Promise<SkillWriteResult> {
  return withSkillStorageLock(storageRoot, async () => {
    const errors = validateSkillFields(input, await takenNames(storageRoot))
    if (errors.length > 0) return { ok: false, fieldErrors: errors }
    // 先读两份状态文档并在落盘前预检目标目录与预算:损坏文档、不安全既有目录
    // 与超预算文件集都必须在落盘前失败,不留下没有来源记录或超上限的技能。
    readSkillLocalState(storageRoot)
    const toggles = readUserSkillToggles(storageRoot)
    const skillDir = join(userSkillsRoot(storageRoot), input.name)
    const existing = await readSafeExistingSkillDir(skillDir)
    const serialized = serializeSkillMarkdown({
      name: input.name,
      description: input.description,
      ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
      ...(input.disableModelInvocation ? { disableModelInvocation: true } : {}),
      // R7:创建不写 user-invocable;启用开关是 HuaAnWork 手动调用的唯一产品门。
      content: input.content,
      extraLines: [],
    })
    const skillData = Buffer.from(serialized, 'utf8')
    const contentDigest = validatedSkillDigest([...existing.files, { path: 'SKILL.md', data: skillData }])
    await atomicWrite(join(skillDir, 'SKILL.md'), skillData)
    const localEntry: SkillLocalEntry = { origin: { kind: 'created' }, contentDigest }
    writeSkillLocalEntry(storageRoot, input.name, localEntry)
    return {
      ok: true,
      skill: {
        name: input.name,
        description: input.description,
        source: 'user',
        ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
        enabled: Object.hasOwn(toggles, input.name) && toggles[input.name] === true,
        origin: localEntry.origin,
        contentDigest,
        publishState: publishStateOf(localEntry),
      },
    }
  })
}

/** 合并式更新:读原文件,只覆盖表单管理字段,metadata 等未知键经 extraLines 原样保留。 */
export async function updateSkill(
  storageRoot: string,
  name: string,
  input: SkillUpdateInput,
): Promise<SkillWriteResult> {
  return withSkillStorageLock(storageRoot, async () => {
    // 临界区内先读两份状态文档:损坏文档必须在落盘前失败。
    const state = readSkillLocalState(storageRoot)
    const toggles = readUserSkillToggles(storageRoot)
    const entry = await findEntry(userSkillsRoot(storageRoot), name)
    if (!entry) {
      return { ok: false, fieldErrors: [{ field: 'name', message: `用户技能 ${name} 不存在（内置与外部技能不可编辑）` }] }
    }
    const errors = validateSkillFields({ ...input, name }, new Set())
    if (errors.length > 0) return { ok: false, fieldErrors: errors }
    const original = parseSkillMarkdown(await fs.readFile(entry.path, 'utf8'))
    const serialized = serializeSkillMarkdown({
      name: original.name,
      description: input.description,
      // 缺省即默认(模型可调用/用户可调用),只在非默认值时落键
      ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
      ...(input.disableModelInvocation ? { disableModelInvocation: true } : {}),
      // R7:表单不再接收 userInvocable,但原文件既有行必须保留。
      ...(original.userInvocable !== undefined ? { userInvocable: original.userInvocable } : {}),
      content: input.content,
      extraLines: original.extraLines,
    })
    const skillData = Buffer.from(serialized, 'utf8')
    let contentDigest: string
    if (entry.kind === 'flat') {
      contentDigest = validatedSkillDigest([{ path: 'SKILL.md', data: skillData }])
      await atomicWrite(entry.path, skillData)
    } else {
      // 先严格读取整棵目录并校验替换 SKILL.md 后的总预算:符号链接/硬链接/超预算
      // 在落盘前失败,不会覆盖原文件或写入部分摘要。
      const siblings = readSkillDirectory(dirname(entry.path))
      contentDigest = validatedSkillDigest([
        ...siblings.filter((file) => file.path !== 'SKILL.md'),
        { path: 'SKILL.md', data: skillData },
      ])
      await atomicWrite(entry.path, skillData)
    }
    const previous = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined
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
        enabled: Object.hasOwn(toggles, name) && toggles[name] === true,
        origin: localEntry.origin,
        contentDigest,
        ...(localEntry.publishedRevision !== undefined ? { publishedRevision: localEntry.publishedRevision } : {}),
        ...(localEntry.publishedDigest !== undefined ? { publishedDigest: localEntry.publishedDigest } : {}),
        publishState: publishStateOf(localEntry),
      },
    }
  })
}

export async function removeSkill(storageRoot: string, name: string): Promise<void> {
  return withSkillStorageLock(storageRoot, async () => {
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
  })
}

const remoteSource = /github:|git\+|https?:\/\//i

async function containsSymlink(dir: string): Promise<boolean> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true
    if (entry.isDirectory() && (await containsSymlink(join(dir, entry.name)))) return true
  }
  return false
}

export async function previewSkillImport(
  storageRoot: string,
  params: { path: string } | string,
): Promise<SkillImportPreview> {
  const sourcePath = typeof params === 'string' ? params : params?.path
  const fail = (message: string): SkillImportPreview => ({ ok: false, fieldErrors: [{ field: 'path', message }] })
  if (!sourcePath || typeof sourcePath !== 'string') return fail('路径必填')
  if (remoteSource.test(sourcePath)) return fail('不允许远程来源')
  const stat = await fs.lstat(sourcePath).catch(() => undefined)
  if (!stat) return fail('路径不存在')
  if (stat.isSymbolicLink()) return fail('目录包含符号链接，已拒绝导入')
  let raw: string
  let kind: 'file' | 'directory'
  let sourceName: string
  if (stat.isDirectory()) {
    kind = 'directory'
    sourceName = basename(sourcePath)
    if (await containsSymlink(sourcePath)) return fail('目录包含符号链接，已拒绝导入')
    // 与确认导入同边界:硬链接/非普通文件/保留段/路径字节/条目与体积预算
    // 都在预览阶段以 fieldErrors 拒绝,不把用户引到确认弹窗才报错关窗。
    let files: SkillArchiveFile[]
    try {
      files = readSkillDirectory(sourcePath)
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : String(cause))
    }
    const skillFile = files.find((file) => file.path === 'SKILL.md')
    raw = skillFile ? skillFile.data.toString('utf8') : ''
    if (!raw) return fail('目录中未找到 SKILL.md')
  } else if (stat.isFile()) {
    kind = 'file'
    if (!sourcePath.endsWith('.md')) return fail('仅支持 .md 文件或含 SKILL.md 的目录')
    sourceName = basename(sourcePath).replace(/\.md$/, '')
    raw = await fs.readFile(sourcePath, 'utf8')
  } else {
    return fail('仅支持 .md 文件或含 SKILL.md 的目录')
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
  return withSkillStorageLock(storageRoot, async () => {
    const sourcePath = typeof params === 'string' ? params : params?.path
    if (!sourcePath || typeof sourcePath !== 'string') {
      return { ok: false, fieldErrors: [{ field: 'path', message: '路径必填' }] }
    }
    const preview = await previewSkillImport(storageRoot, sourcePath)
    if (!preview.ok) return preview
    // 与 create 对称:先读两份状态文档并预检目标目录与预算,损坏状态、不安全目录
    // 或超预算内容都必须在落盘前失败,不留下没有来源记录或超上限的副本。
    readSkillLocalState(storageRoot)
    const toggles = readUserSkillToggles(storageRoot)
    const { targetName, kind } = preview.preview
    const root = userSkillsRoot(storageRoot)
    const targetDir = join(root, targetName)
    const existing = await readSafeExistingSkillDir(targetDir)
    let contentDigest: string
    if (kind === 'file') {
      // 原始文件原样落盘(保留未知 frontmatter 键与 user-invocable 行),目录名以 frontmatter name 为准
      const rawData = await fs.readFile(sourcePath)
      contentDigest = validatedSkillDigest([...existing.files, { path: 'SKILL.md', data: rawData }])
      await atomicWrite(join(targetDir, 'SKILL.md'), rawData)
    } else {
      if (existing.exists) {
        throw new Error(`目标技能目录已存在：${targetDir}`)
      }
      // 源目录必须先通过严格安全与预算检查(符号链接/硬链接/非普通文件/预算),
      // 失败时不创建目标目录,也不写入任何状态。
      const files = readSkillDirectory(sourcePath)
      contentDigest = createSkillDigest(files)
      await stageSkillDirectory(storageRoot, targetName, files, '.skill-import-')
    }
    const localEntry: SkillLocalEntry = { origin: { kind: 'imported' }, contentDigest }
    writeSkillLocalEntry(storageRoot, targetName, localEntry)
    return {
      ok: true,
      skill: {
        name: targetName,
        description: preview.preview.description,
        source: 'user',
        ...(preview.preview.whenToUse ? { whenToUse: preview.preview.whenToUse } : {}),
        enabled: Object.hasOwn(toggles, targetName) && toggles[targetName] === true,
        origin: localEntry.origin,
        contentDigest,
        publishState: publishStateOf(localEntry),
      },
    }
  })
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
  return withSkillStorageLock(storageRoot, async () => {
    if (!name) throw new Error('skill.setEnabled requires params.name')
    if (SYSTEM_SKILLS.has(name)) throw new Error(`skill ${name} 为系统技能，始终启用`)
    // 内部技能由创建入口直接注入正文,不接受开关,也不注册进全局技能目录。
    if (INTERNAL_BUNDLED_SKILLS.has(name)) throw new Error(`skill ${name} 为内部技能，不能启停`)
    const entry = await findEntry(userSkillsRoot(storageRoot), name)
    if (!entry) throw new Error(`skill ${name} 不是本地用户技能（请先在“我的技能”中创建、导入或下载）`)
    setUserSkillToggle(storageRoot, name, enabled)
    return { ok: true }
  })
}

