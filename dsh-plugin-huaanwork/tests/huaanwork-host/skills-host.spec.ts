import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createSkill,
  createSkillFromDraft,
  getSkill,
  importSkill,
  listUserSkills,
  previewSkillImport,
  removeSkill,
  setSkillEnabled,
  updateSkill,
} from '../../src/huaanwork-host/skills-host.ts'
import { readSkillLocalState, readUserSkillToggles, setUserSkillToggle, writeSkillLocalEntry } from '../../src/huaanwork-host/skill-local-state.ts'
import { resolveInvocableSkill } from '../../src/huaanwork-host/skill-invoke.ts'
import { promises as fsp } from 'node:fs'

// 用例移植自旧 sidecar skills-host.test.ts 的 list/get 段(skills-host.test.ts:29-110):
// 遮蔽序 user → bundled、bundled 根为包内 skills/(Task 2/3;外部根已退出)。

const DEMO = '---\nname: demo\ndescription: 演示技能\n---\n\n正文\n'

let homes: string[] = []
let prevAgentsHome: string | undefined

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skills-host-'))
  homes.push(home)
  return home
}

beforeEach(() => {
  // 隔离外部技能根:证明未启用/外部条目不参与解析(不再有扫描回退)。
  prevAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = mkdtempSync(join(tmpdir(), 'hw-fake-agents-'))
  homes.push(process.env.DSH_AGENTS_HOME)
})

afterEach(() => {
  if (prevAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = prevAgentsHome
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe('skills-host 读路径(旧 skills-host.test.ts 用例)', () => {
  test('listUserSkills covers directory bundles and flat markdown, skips .system', async () => {
    const home = makeHome()
    const root = join(home, 'skills')
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'SKILL.md'), DEMO)
    writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: 扁平技能\n---\n\n扁平正文\n')
    mkdirSync(join(root, '.system'), { recursive: true })
    writeFileSync(join(root, '.system', 'hidden.md'), '---\nname: hidden\ndescription: 不应出现\n---\n\nx\n')
    const skills = await listUserSkills(home)
    expect(skills.map((s) => s.name)).toEqual(['demo', 'flat'])
    expect(skills.every((s) => s.source === 'user')).toBe(true)
  })

  test('listUserSkills tolerates missing root and unparseable entries', async () => {
    const home = makeHome()
    expect(await listUserSkills(home)).toEqual([])
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'broken.md'), '没有 frontmatter')
    expect(await listUserSkills(home)).toEqual([])
  })

  test('getSkill searches user then bundled', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(home, 'skills', 'demo', 'SKILL.md'), DEMO)
    const user = await getSkill(home, 'demo')
    expect(user?.source).toBe('user')
    expect(user?.content).toBe('正文')
    // 内置兜底(真实 bundle 内置技能,根为包内 skills/)
    const explore = await getSkill(home, 'explore')
    expect(explore?.source).toBe('bundled')
    expect(explore?.content ?? '').toMatch(/subagent/)
    expect(await getSkill(home, '../etc')).toBeUndefined()
    expect(await getSkill(home, 'missing')).toBeUndefined()
  })

  test('getSkill honors an explicit source to disambiguate shadowed names', async () => {
    const home = makeHome()
    // 手写用户技能,与内置 explore 同名(createSkill 拒绝内置同名,故直接落盘绕过)
    mkdirSync(join(home, 'skills', 'explore'), { recursive: true })
    writeFileSync(join(home, 'skills', 'explore', 'SKILL.md'), '---\nname: explore\ndescription: 用户同名\n---\n\n用户正文\n')
    // 无 source:保持 用户 → 内置 的 rank order(外部根不再参与回退)
    const unscoped = await getSkill(home, 'explore')
    expect(unscoped?.source).toBe('user')
    expect(unscoped?.content).toBe('用户正文')
    // 定向 source:只在该来源的根里找
    expect((await getSkill(home, 'explore', 'user'))?.content).toBe('用户正文')
    const bundledScoped = await getSkill(home, 'explore', 'bundled')
    expect(bundledScoped?.source).toBe('bundled')
    expect(bundledScoped?.content ?? '').toMatch(/subagent/)
    // 该来源下不存在 → undefined(用户 root 没有内置独占名;bundled 没有用户名)
    expect(await getSkill(home, 'test-fix', 'user')).toBeUndefined()
    expect(await getSkill(home, 'missing', 'bundled')).toBeUndefined()
    // SKILL_NAME_RE 守卫对带 source 的查询同样生效
    expect(await getSkill(home, '../etc', 'user')).toBeUndefined()
  })
})

describe('skills-host resolver 启用门与外部退出 (Task 3)', () => {
  function writeLocalSkillFile(profile: string, name: string, extraFrontmatter = ''): void {
    const dir = join(profile, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n${extraFrontmatter}---\n\n正文\n`, 'utf8')
  }

  test('disabled local skill is rejected by the Host resolver', async () => {
    const profile = makeHome()
    writeLocalSkillFile(profile, 'demo')
    setUserSkillToggle(profile, 'demo', false)
    await expect(resolveInvocableSkill(profile, 'demo')).rejects.toThrow('skill demo is disabled')
  })

  test('external skills are not an implicit fallback', async () => {
    const profile = makeHome()
    const agents = process.env.DSH_AGENTS_HOME!
    mkdirSync(join(agents, 'skills'), { recursive: true })
    writeFileSync(join(agents, 'skills', 'external-only.md'), '---\nname: external-only\ndescription: 外部技能\n---\n\n正文\n', 'utf8')
    expect(await getSkill(profile, 'external-only')).toBeUndefined()
    await expect(resolveInvocableSkill(profile, 'external-only')).rejects.toThrow('skill external-only was not found')
  })

  test('user-invocable false does not block an enabled local skill', async () => {
    const profile = makeHome()
    writeLocalSkillFile(profile, 'demo', 'user-invocable: false\n')
    setUserSkillToggle(profile, 'demo', true)
    await expect(resolveInvocableSkill(profile, 'demo')).resolves.toMatchObject({ skill: { name: 'demo' } })
  })
})

describe('skills-host 写路径 (Task 1)', () => {
  test('createSkill 校验矩阵与成功落盘', async () => {
    const home = makeHome()

    // 1. name 格式不合规 (kebab-case)
    const badName = await createSkill(home, { name: 'Bad_Name', description: 'desc', content: 'content' })
    expect(badName.ok).toBe(false)
    if (!badName.ok) expect(badName.fieldErrors.some((e) => e.field === 'name')).toBe(true)

    // 2. name 超长 (>64)
    const longName = await createSkill(home, { name: 'a'.repeat(65), description: 'desc', content: 'content' })
    expect(longName.ok).toBe(false)
    if (!longName.ok) expect(longName.fieldErrors.some((e) => e.field === 'name')).toBe(true)

    // 3. description 必填与超长 (>1024)
    const emptyDesc = await createSkill(home, { name: 'valid-name', description: '   ', content: 'content' })
    expect(emptyDesc.ok).toBe(false)
    if (!emptyDesc.ok) expect(emptyDesc.fieldErrors.some((e) => e.field === 'description')).toBe(true)

    const longDesc = await createSkill(home, { name: 'valid-name', description: 'a'.repeat(1025), content: 'content' })
    expect(longDesc.ok).toBe(false)
    if (!longDesc.ok) expect(longDesc.fieldErrors.some((e) => e.field === 'description')).toBe(true)

    // 4. content 必填与超长 (>64KiB)
    const emptyContent = await createSkill(home, { name: 'valid-name', description: 'desc', content: '   ' })
    expect(emptyContent.ok).toBe(false)
    if (!emptyContent.ok) expect(emptyContent.fieldErrors.some((e) => e.field === 'content')).toBe(true)

    const longContent = await createSkill(home, { name: 'valid-name', description: 'desc', content: 'a'.repeat(64 * 1024 + 1) })
    expect(longContent.ok).toBe(false)
    if (!longContent.ok) expect(longContent.fieldErrors.some((e) => e.field === 'content')).toBe(true)

    // 5. 内置同名拒绝 (如 explore)
    const builtinDup = await createSkill(home, { name: 'explore', description: 'desc', content: 'content' })
    expect(builtinDup.ok).toBe(false)
    if (!builtinDup.ok) expect(builtinDup.fieldErrors.some((e) => e.message.includes('同名'))).toBe(true)

    // 6. 成功创建落盘 (含 whenToUse / disableModelInvocation / userInvocable)
    const created = await createSkill(home, {
      name: 'my-skill',
      description: '我的技能',
      whenToUse: '处理特定任务时',
      disableModelInvocation: true,
      userInvocable: false,
      content: '# 步骤\n1. 执行',
    })
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.skill.name).toBe('my-skill')
      expect(created.skill.source).toBe('user')
      expect(created.skill.whenToUse).toBe('处理特定任务时')
      expect(created.skill.enabled).toBe(false)
      expect(created.skill.origin).toEqual({ kind: 'created' })
      expect(created.skill.publishState).toBe('not-published')
      expect(created.skill.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }

    const fileContent = await fsp.readFile(join(home, 'skills', 'my-skill', 'SKILL.md'), 'utf8')
    expect(fileContent).toContain('name: my-skill')
    expect(fileContent).toContain('description: 我的技能')
    expect(fileContent).toContain('whenToUse: 处理特定任务时')
    expect(fileContent).toContain('disable-model-invocation: true')
    // R7:创建不再写 user-invocable;手动调用由本地启用开关决定。
    expect(fileContent).not.toContain('user-invocable')
    expect(fileContent).toContain('# 步骤\n1. 执行')

    // 7. 用户同名重复创建拒绝
    const userDup = await createSkill(home, { name: 'my-skill', description: '再次创建', content: 'content' })
    expect(userDup.ok).toBe(false)
    if (!userDup.ok) expect(userDup.fieldErrors.some((e) => e.message.includes('同名'))).toBe(true)
  })

  test('updateSkill 字段合并、保留未知 frontmatter 键、拒改内置、就地更新 flat', async () => {
    const home = makeHome()

    // 1. 创建带未知 frontmatter 键的 bundle 技能
    const skillDir = join(home, 'skills', 'custom-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: custom-skill\ndescription: 旧描述\nmetadata:\n  author: tester\nx-custom-tag: preserve-me\n---\n\n旧正文\n',
    )

    // 2. 更新技能
    const updated = await updateSkill(home, 'custom-skill', {
      description: '新描述',
      whenToUse: '新场景',
      content: '新正文',
    })
    expect(updated.ok).toBe(true)
    if (updated.ok) {
      expect(updated.skill.description).toBe('新描述')
      expect(updated.skill.whenToUse).toBe('新场景')
    }

    const raw = await fsp.readFile(join(skillDir, 'SKILL.md'), 'utf8')
    expect(raw).toContain('description: 新描述')
    expect(raw).toContain('whenToUse: 新场景')
    expect(raw).toContain('metadata:\n  author: tester')
    expect(raw).toContain('x-custom-tag: preserve-me')
    expect(raw).toContain('新正文')

    // 3. 不存在技能报错
    const notFound = await updateSkill(home, 'non-existent', { description: 'd', content: 'c' })
    expect(notFound.ok).toBe(false)
    if (!notFound.ok) expect(notFound.fieldErrors.some((e) => e.field === 'name')).toBe(true)

    // 4. 拒绝修改内置技能 (如 explore)
    const updateBuiltin = await updateSkill(home, 'explore', { description: 'd', content: 'c' })
    expect(updateBuiltin.ok).toBe(false)
    if (!updateBuiltin.ok) expect(updateBuiltin.fieldErrors.some((e) => e.message.includes('不存在（内置与外部技能不可编辑）'))).toBe(true)

    // 5. flat .md 技能就地修改
    writeFileSync(join(home, 'skills', 'flat-one.md'), '---\nname: flat-one\ndescription: 旧扁平\n---\n\n旧扁平正文\n')
    const updateFlat = await updateSkill(home, 'flat-one', { description: '新扁平', content: '新扁平正文' })
    expect(updateFlat.ok).toBe(true)
    const rawFlat = await fsp.readFile(join(home, 'skills', 'flat-one.md'), 'utf8')
    expect(rawFlat).toContain('description: 新扁平')
    expect(rawFlat).toContain('新扁平正文')
  })

  test('removeSkill 拒绝内置与外部技能，删除 flat 与 bundle 技能', async () => {
    const home = makeHome()

    // 1. 创建 user bundle 技能与 flat 技能
    await createSkill(home, { name: 'to-remove-bundle', description: '待删包', content: '内容' })
    writeFileSync(join(home, 'skills', 'to-remove-flat.md'), '---\nname: to-remove-flat\ndescription: 待删扁平\n---\n\n内容\n')

    // 2. 拒绝非法名称 (路径穿越)
    await expect(removeSkill(home, '../etc')).rejects.toThrow(/invalid skill name/)

    // 3. 拒绝删除内置技能 (explore)
    await expect(removeSkill(home, 'explore')).rejects.toThrow(/不可删除|不存在/)

    // 4. 拒绝删除外部技能
    const agents = process.env.DSH_AGENTS_HOME!
    mkdirSync(join(agents, 'skills'), { recursive: true })
    writeFileSync(join(agents, 'skills', 'ext-skill.md'), '---\nname: ext-skill\ndescription: 外部\n---\n\nx\n')
    await expect(removeSkill(home, 'ext-skill')).rejects.toThrow(/不可删除|不存在/)

    // 5. 拒绝删除不存在的技能
    await expect(removeSkill(home, 'non-existent')).rejects.toThrow(/不可删除|不存在/)

    // 6. 成功删除 bundle 技能 (整个目录删除)
    await removeSkill(home, 'to-remove-bundle')
    expect(await fsp.stat(join(home, 'skills', 'to-remove-bundle')).catch(() => null)).toBeNull()

    // 7. 成功删除 flat 技能 (文件 unlink)
    await removeSkill(home, 'to-remove-flat')
    expect(await fsp.stat(join(home, 'skills', 'to-remove-flat.md')).catch(() => null)).toBeNull()
  })

  test('previewSkillImport 拒绝远程、缺文件、符号链接，正常预览 file 与 dir', async () => {
    const home = makeHome()

    // 1. 拒绝远程来源
    const remote = await previewSkillImport(home, 'https://github.com/foo/bar.md')
    expect(remote.ok).toBe(false)
    if (!remote.ok) expect(remote.fieldErrors[0]?.message).toContain('远程来源')

    const gitRemote = await previewSkillImport(home, 'git+ssh://git.example.com/skill')
    expect(gitRemote.ok).toBe(false)

    // 2. 拒绝不存在路径
    const notFound = await previewSkillImport(home, join(home, 'not-exists.md'))
    expect(notFound.ok).toBe(false)
    if (!notFound.ok) expect(notFound.fieldErrors[0]?.message).toContain('不存在')

    // 3. 拒绝非 .md 且非目录的文件
    const notMd = join(home, 'invalid.txt')
    writeFileSync(notMd, 'test')
    const badExt = await previewSkillImport(home, notMd)
    expect(badExt.ok).toBe(false)
    if (!badExt.ok) expect(badExt.fieldErrors[0]?.message).toContain('.md')

    // 4. 目录中缺失 SKILL.md
    const emptyDir = join(home, 'no-skill-dir')
    mkdirSync(emptyDir, { recursive: true })
    const missingSkillMd = await previewSkillImport(home, emptyDir)
    expect(missingSkillMd.ok).toBe(false)
    if (!missingSkillMd.ok) expect(missingSkillMd.fieldErrors[0]?.message).toContain('SKILL.md')

    // 5. 目录中包含符号链接 -> 拒绝
    const symlinkDir = join(home, 'symlink-dir')
    mkdirSync(symlinkDir, { recursive: true })
    writeFileSync(join(symlinkDir, 'SKILL.md'), '---\nname: sym-skill\ndescription: sym\n---\n\nx\n')
    const targetFile = join(home, 'target.txt')
    writeFileSync(targetFile, 'target')
    const symlinkPath = join(symlinkDir, 'link')
    await fsp.symlink(targetFile, symlinkPath).catch(() => null)
    const isSym = await fsp.lstat(symlinkPath).then((s) => s.isSymbolicLink()).catch(() => false)
    if (isSym) {
      const symResult = await previewSkillImport(home, symlinkDir)
      expect(symResult.ok).toBe(false)
      if (!symResult.ok) expect(symResult.fieldErrors[0]?.message).toContain('符号链接')
    }

    // 6. 顶层目录本身是符号链接 -> 拒绝
    const realSkillDir = join(home, 'real-skill-dir')
    mkdirSync(realSkillDir, { recursive: true })
    writeFileSync(join(realSkillDir, 'SKILL.md'), '---\nname: real-sym-target\ndescription: sym\n---\n\nx\n')
    const topSymlinkDir = join(home, 'top-symlink-dir')
    await fsp.symlink(realSkillDir, topSymlinkDir).catch(() => null)
    const isTopSym = await fsp.lstat(topSymlinkDir).then((s) => s.isSymbolicLink()).catch(() => false)
    if (isTopSym) {
      const topSymResult = await previewSkillImport(home, topSymlinkDir)
      expect(topSymResult.ok).toBe(false)
      if (!topSymResult.ok) expect(topSymResult.fieldErrors[0]?.message).toContain('目录包含符号链接，已拒绝导入')
    }

    // 6. 正常 file 预览 (校验 targetName, sourceName, nameMismatch, kind)
    const fileSource = join(home, 'original-filename.md')
    writeFileSync(
      fileSource,
      '---\nname: frontmatter-name\ndescription: 文件导入描述\nwhenToUse: 文件场景\n---\n\n导入正文\n',
    )
    const filePreview = await previewSkillImport(home, fileSource)
    expect(filePreview.ok).toBe(true)
    if (filePreview.ok) {
      expect(filePreview.preview.targetName).toBe('frontmatter-name')
      expect(filePreview.preview.sourceName).toBe('original-filename')
      expect(filePreview.preview.nameMismatch).toBe(true)
      expect(filePreview.preview.kind).toBe('file')
      expect(filePreview.preview.description).toBe('文件导入描述')
      expect(filePreview.preview.whenToUse).toBe('文件场景')
      expect(filePreview.preview.content).toBe('导入正文')
    }

    // 7. 正常 dir 预览
    const dirSource = join(home, 'dir-skill')
    mkdirSync(dirSource, { recursive: true })
    writeFileSync(join(dirSource, 'SKILL.md'), '---\nname: dir-skill\ndescription: 目录技能\n---\n\n目录正文\n')
    const dirPreview = await previewSkillImport(home, dirSource)
    expect(dirPreview.ok).toBe(true)
    if (dirPreview.ok) {
      expect(dirPreview.preview.targetName).toBe('dir-skill')
      expect(dirPreview.preview.sourceName).toBe('dir-skill')
      expect(dirPreview.preview.nameMismatch).toBe(false)
      expect(dirPreview.preview.kind).toBe('directory')
    }

    // 8. 重名检测 (与内置同名拒绝)
    const builtinDupSource = join(home, 'explore.md')
    writeFileSync(builtinDupSource, '---\nname: explore\ndescription: 重名\n---\n\nx\n')
    const dupPreview = await previewSkillImport(home, builtinDupSource)
    expect(dupPreview.ok).toBe(false)
  })

  test('importSkill 正常文件与目录导入，目录经 tmp 再 rename', async () => {
    const home = makeHome()

    // 1. file 导入:原样落盘 (保留未知 frontmatter 键), 目录名以 frontmatter name 为准
    const fileSrc = join(home, 'my-file.md')
    writeFileSync(
      fileSrc,
      '---\nname: imported-file\ndescription: 导入文件\nx-custom: keep-this\n---\n\n文件正文\n',
    )
    const fileImportResult = await importSkill(home, fileSrc)
    expect(fileImportResult.ok).toBe(true)
    if (fileImportResult.ok) {
      expect(fileImportResult.skill.name).toBe('imported-file')
      expect(fileImportResult.skill.source).toBe('user')
    }

    const savedFile = await fsp.readFile(join(home, 'skills', 'imported-file', 'SKILL.md'), 'utf8')
    expect(savedFile).toContain('x-custom: keep-this')
    expect(savedFile).toContain('文件正文')

    // 重复导入被重名拦截
    const reimport = await importSkill(home, fileSrc)
    expect(reimport.ok).toBe(false)

    // 2. directory 导入:辅助文件完整保留
    const dirSrc = join(home, 'bundle-src')
    mkdirSync(dirSrc, { recursive: true })
    writeFileSync(join(dirSrc, 'SKILL.md'), '---\nname: imported-bundle\ndescription: 导入目录\n---\n\n目录正文\n')
    writeFileSync(join(dirSrc, 'auxiliary.json'), '{"key":"value"}')

    const dirImportResult = await importSkill(home, dirSrc)
    expect(dirImportResult.ok).toBe(true)
    if (dirImportResult.ok) {
      expect(dirImportResult.skill.name).toBe('imported-bundle')
    }

    const savedSkillMd = await fsp.readFile(join(home, 'skills', 'imported-bundle', 'SKILL.md'), 'utf8')
    expect(savedSkillMd).toContain('name: imported-bundle')
    const savedAux = await fsp.readFile(join(home, 'skills', 'imported-bundle', 'auxiliary.json'), 'utf8')
    expect(savedAux).toBe('{"key":"value"}')
  })

  test('setSkillEnabled 只切换已存在的本地用户技能', async () => {
    const home = makeHome()

    // 1. 参数与目标校验:空名称、不存在的本地技能、系统技能、内部技能。
    await expect(setSkillEnabled(home, '', true)).rejects.toThrow(/params\.name/)
    await expect(setSkillEnabled(home, 'missing', true)).rejects.toThrow(/不是本地用户技能/)
    await expect(setSkillEnabled(home, 'explore', false)).rejects.toThrow(/系统技能，始终启用/)
    await expect(setSkillEnabled(home, 'test-fix', false)).rejects.toThrow(/系统技能，始终启用/)
    await expect(setSkillEnabled(home, 'create-agent', true)).rejects.toThrow(/内部技能，不能启停/)

    // 2. 普通内置同名不再是“内置启停”:先落成本地副本再切换。
    const created = await createSkill(home, { name: 'pdf', description: '本地 PDF', content: '本地正文' })
    expect(created.ok).toBe(true)
    await expect(setSkillEnabled(home, 'pdf', true)).resolves.toEqual({ ok: true })
    expect(readUserSkillToggles(home)['pdf']).toBe(true)

    // 3. 禁用后键被删除(缺省 = 禁用);旧 skill-toggles.json 不再承载新状态。
    await expect(setSkillEnabled(home, 'pdf', false)).resolves.toEqual({ ok: true })
    expect(readUserSkillToggles(home)['pdf']).toBeUndefined()
    expect(await fsp.readFile(join(home, 'skill-toggles.json'), 'utf8').catch(() => null)).toBeNull()
  })
})

describe('内部技能不可全局启用(设计 §6.1)', () => {
  test('create-agent 被 setSkillEnabled 拒绝且不写用户启用键', async () => {
    const home = makeHome()

    await expect(setSkillEnabled(home, 'create-agent', true)).rejects.toThrow(/内部技能，不能启停/)
    expect(readUserSkillToggles(home)['create-agent']).toBeUndefined()
  })
})

describe('对话创建技能的保留名', () => {
  test('rejects user skills named create-skill on the host side', async () => {
    const root = makeHome()
    const result = await createSkill(root, { name: 'create-skill', description: '占用内部名', content: '正文' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.fieldErrors.map((error) => error.field)).toContain('name')
  })
})

describe('对话创建草稿的幂等入口 (Task 2)', () => {
  test('creates from a draft once and preserves identity after editing', async () => {
    const root = makeHome()
    const input = { name: 'weekly-report', description: '生成周报', content: '按步骤生成周报' }
    const first = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
    expect(first).toMatchObject({ ok: true, alreadyCommitted: false, name: 'weekly-report' })
    await expect(resolveInvocableSkill(root, 'weekly-report')).rejects.toThrow('weekly-report is disabled')
    setUserSkillToggle(root, 'weekly-report', true)
    await expect(resolveInvocableSkill(root, 'weekly-report')).resolves.toMatchObject({ skill: { name: 'weekly-report' } })

    const edited = await updateSkill(root, 'weekly-report', { ...input, content: '更新后的正文' })
    expect(edited.ok).toBe(true)

    const replay = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
    expect(replay).toMatchObject({ ok: true, alreadyCommitted: true, name: 'weekly-report' })
    expect(readSkillLocalState(root).skills['weekly-report']!.creationDraftId).toBe('draft-1')
    expect(readSkillLocalState(root).skills['weekly-report']!.creationSessionId).toBe('session-1')
  })

  test('rejects multiline frontmatter fields', async () => {
    const root = makeHome()
    const result = await createSkill(root, {
      name: 'multiline-test', description: '第一行\n第二行', content: '正文',
    })
    expect(result.ok).toBe(false)
  })

  test('rejects a multiline whenToUse', async () => {
    const root = makeHome()
    const result = await createSkill(root, {
      name: 'multiline-when', description: '描述', whenToUse: '第一行\n第二行', content: '正文',
    })
    expect(result.ok).toBe(false)
  })

  test('createSkill trims description and drops whitespace-only whenToUse', async () => {
    const root = makeHome()
    const result = await createSkill(root, {
      name: 'trim-test', description: '  描述  ', whenToUse: '   ', content: '正文',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skill.description).toBe('描述')
    expect(result.skill.whenToUse).toBeUndefined()
    const raw = readFileSync(join(root, 'skills', 'trim-test', 'SKILL.md'), 'utf8')
    expect(raw).toContain('description: 描述')
    expect(raw).not.toContain('whenToUse')
  })

  test('rejects empty or whitespace creation ids without writing state or directory', async () => {
    const root = makeHome()
    const input = { name: 'weekly-report', description: '生成周报', content: '按步骤生成周报' }

    const emptyDraft = await createSkillFromDraft(root, input, '', 'session-1')
    expect(emptyDraft).toMatchObject({ ok: false })
    if (!emptyDraft.ok) expect(emptyDraft.fieldErrors.map((error) => error.field)).toContain('creationDraftId')

    const emptySession = await createSkillFromDraft(root, input, 'draft-1', '')
    expect(emptySession).toMatchObject({ ok: false })
    if (!emptySession.ok) expect(emptySession.fieldErrors.map((error) => error.field)).toContain('creationSessionId')

    const whitespaceDraft = await createSkillFromDraft(root, input, '   ', 'session-1')
    expect(whitespaceDraft.ok).toBe(false)

    // 拒绝必须发生在任何落盘之前:没有技能目录,状态文档仍可读且为空。
    expect(await fsp.stat(join(root, 'skills', 'weekly-report')).catch(() => null)).toBeNull()
    expect(readSkillLocalState(root)).toEqual({ schemaVersion: 1, skills: {} })
    expect((await listUserSkills(root)).map((skill) => skill.name)).toEqual([])
  })

  test('rejects idempotent replay as a field error when the state key remains but the directory is gone', async () => {
    const root = makeHome()
    const input = { name: 'weekly-report', description: '生成周报', content: '按步骤生成周报' }
    const first = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
    expect(first.ok).toBe(true)

    await rm(join(root, 'skills', 'weekly-report'), { recursive: true, force: true })

    const replay = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.fieldErrors.map((error) => error.field)).toContain('name')
    expect(readSkillLocalState(root).skills['weekly-report']!.creationDraftId).toBe('draft-1')
    expect(readSkillLocalState(root).skills['weekly-report']!.creationSessionId).toBe('session-1')
  })
})

describe('导入预览与确认的校验边界一致(评审 Important 4)', () => {
  const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n\n正文\n`

  test('预览阶段即拒绝硬链接并返回 fieldErrors', async () => {
    const home = makeHome()
    const dir = join(home, 'hardlink-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd('hardlink-skill'))
    const target = join(home, 'outside.txt')
    writeFileSync(target, 'outside')
    const linkPath = join(dir, 'hard.txt')
    await fsp.link(target, linkPath).catch(() => null)
    const linked = await fsp.lstat(linkPath).then((s) => s.nlink > 1).catch(() => false)
    if (!linked) return
    const preview = await previewSkillImport(home, dir)
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.fieldErrors[0]?.message).toContain('硬链接')
  })

  test('预览阶段即拒绝保留前缀段', async () => {
    const home = makeHome()
    const dir = join(home, 'reserved-skill')
    mkdirSync(join(dir, '.tmp-cache'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd('reserved-skill'))
    writeFileSync(join(dir, '.tmp-cache', 'x.txt'), 'x')
    const preview = await previewSkillImport(home, dir)
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.fieldErrors[0]?.field).toBe('path')
  })

  test('预览阶段即拒绝超过 256 条目', async () => {
    const home = makeHome()
    const dir = join(home, 'many-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd('many-skill'))
    for (let index = 0; index < 256; index += 1) writeFileSync(join(dir, `f${index}.txt`), 'x')
    const preview = await previewSkillImport(home, dir)
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.fieldErrors[0]?.message).toContain('256')
  })

  test('预览阶段即拒绝超过 5 MiB 内容总量', async () => {
    const home = makeHome()
    const dir = join(home, 'big-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd('big-skill'))
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(6 * 1024 * 1024))
    const preview = await previewSkillImport(home, dir)
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.fieldErrors[0]?.field).toBe('path')
  })

  test('预览阶段即拒绝超过 512 字节的路径', async () => {
    const home = makeHome()
    const dir = join(home, 'deep-skill')
    const segment = 'a'.repeat(200)
    const deep = join(dir, segment, segment, segment)
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd('deep-skill'))
    writeFileSync(join(deep, 'x.txt'), 'x')
    const preview = await previewSkillImport(home, dir)
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.fieldErrors[0]?.message).toContain('512')
  })

  test('含资源文件的合法目录仍正常预览并可确认导入', async () => {
    const home = makeHome()
    const dir = join(home, 'resource-skill')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd('resource-skill'))
    writeFileSync(join(dir, 'scripts', 'run.mjs'), 'console.log("ok")\n')
    const preview = await previewSkillImport(home, dir)
    expect(preview.ok).toBe(true)
    const imported = await importSkill(home, dir)
    expect(imported.ok).toBe(true)
  })
})

describe('带外磁盘编辑的列表投影(评审 Important 1)', () => {
  test('已发布技能被外部修改 SKILL.md 后投影为 modified 且摘要反映磁盘', async () => {
    const home = makeHome()
    const created = await createSkill(home, { name: 'demo', description: '演示技能', content: '第一版' })
    expect(created.ok).toBe(true)
    const recorded = readSkillLocalState(home).skills.demo!
    writeSkillLocalEntry(home, 'demo', { ...recorded, publishedRevision: 1, publishedDigest: recorded.contentDigest })
    expect((await listUserSkills(home))[0]!.publishState).toBe('published')

    writeFileSync(join(home, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n\n外部改过\n')
    const [skill] = await listUserSkills(home)
    expect(skill!.publishState).toBe('modified')
    expect(skill!.contentDigest).not.toBe(recorded.contentDigest)
  })

  test('已发布技能被外部修改附带资源文件后投影为 modified', async () => {
    const home = makeHome()
    const created = await createSkill(home, { name: 'demo', description: '演示技能', content: '第一版' })
    expect(created.ok).toBe(true)
    writeFileSync(join(home, 'skills', 'demo', 'run.mjs'), 'console.log("v1")\n')
    const updated = await updateSkill(home, 'demo', { description: '演示技能', content: '第一版' })
    expect(updated.ok).toBe(true)
    const recorded = readSkillLocalState(home).skills.demo!
    writeSkillLocalEntry(home, 'demo', { ...recorded, publishedRevision: 1, publishedDigest: recorded.contentDigest })
    expect((await listUserSkills(home))[0]!.publishState).toBe('published')

    writeFileSync(join(home, 'skills', 'demo', 'run.mjs'), 'console.log("v2")\n')
    const [skill] = await listUserSkills(home)
    expect(skill!.publishState).toBe('modified')
    expect(skill!.contentDigest).not.toBe(recorded.contentDigest)
  })

  test('同名扁平 .md 与目录包只投影一条(评审 Minor 5)', async () => {
    const home = makeHome()
    const root = join(home, 'skills')
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'SKILL.md'), DEMO)
    writeFileSync(join(root, 'demo.md'), DEMO)
    const skills = await listUserSkills(home)
    expect(skills.map((s) => s.name)).toEqual(['demo'])
  })
})

