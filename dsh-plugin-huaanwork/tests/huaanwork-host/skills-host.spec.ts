import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createSkill,
  getSkill,
  getSkillHandlesForTest,
  importSkill,
  listExternalSkills,
  listUserSkills,
  previewSkillImport,
  removeSkill,
  restoreEnabledBundledSkills,
  setSkillEnabled,
  updateSkill,
} from '../../src/huaanwork-host/skills-host.ts'
import {
  readSkillToggles,
  setBundledSkillRegistrar,
} from '../../src/huaanwork-guardrails/skills.ts'
import { promises as fsp } from 'node:fs'

// 用例移植自旧 sidecar skills-host.test.ts 的 list/get 段(skills-host.test.ts:29-110):
// 三源合并、遮蔽序 user → external → bundled、bundled 根为包内 skills/(Task 2)。

const DEMO = '---\nname: demo\ndescription: 演示技能\n---\n\n正文\n'

let homes: string[] = []
let prevAgentsHome: string | undefined

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skills-host-'))
  homes.push(home)
  return home
}

beforeEach(() => {
  // 隔离外部技能根:未设置时 externalSkillsRoot 回落 ~/.agents/skills(机器相关)。
  prevAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = mkdtempSync(join(tmpdir(), 'hw-fake-agents-'))
  homes.push(process.env.DSH_AGENTS_HOME)
})

afterEach(() => {
  setBundledSkillRegistrar(null)
  getSkillHandlesForTest().clear()
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

  test('listExternalSkills reads the agents-home skills root read-only', async () => {
    const agents = process.env.DSH_AGENTS_HOME!
    mkdirSync(join(agents, 'skills'), { recursive: true })
    writeFileSync(join(agents, 'skills', 'ext.md'), '---\nname: ext\ndescription: 外部技能\n---\n\nx\n')
    const skills = await listExternalSkills()
    expect(skills.map((s) => [s.name, s.source])).toEqual([['ext', 'external']])
  })

  test('getSkill searches user then external then bundled', async () => {
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
    const agents = process.env.DSH_AGENTS_HOME!
    mkdirSync(join(agents, 'skills'), { recursive: true })
    writeFileSync(join(agents, 'skills', 'explore.md'), '---\nname: explore\ndescription: 外部同名\n---\n\n外部正文\n')
    // 无 source:保持 用户 → 外部 → 内置 的 rank order
    const unscoped = await getSkill(home, 'explore')
    expect(unscoped?.source).toBe('user')
    expect(unscoped?.content).toBe('用户正文')
    // 定向 source:只在该来源的根里找
    expect((await getSkill(home, 'explore', 'user'))?.content).toBe('用户正文')
    expect((await getSkill(home, 'explore', 'external'))?.content).toBe('外部正文')
    const bundledScoped = await getSkill(home, 'explore', 'bundled')
    expect(bundledScoped?.source).toBe('bundled')
    expect(bundledScoped?.content ?? '').toMatch(/subagent/)
    // 该来源下不存在 → undefined(外部/用户 root 没有内置独占名;bundled 没有用户/外部名)
    expect(await getSkill(home, 'test-fix', 'external')).toBeUndefined()
    expect(await getSkill(home, 'test-fix', 'user')).toBeUndefined()
    expect(await getSkill(home, 'missing', 'bundled')).toBeUndefined()
    // SKILL_NAME_RE 守卫对带 source 的查询同样生效
    expect(await getSkill(home, '../etc', 'user')).toBeUndefined()
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
    }

    const fileContent = await fsp.readFile(join(home, 'skills', 'my-skill', 'SKILL.md'), 'utf8')
    expect(fileContent).toContain('name: my-skill')
    expect(fileContent).toContain('description: 我的技能')
    expect(fileContent).toContain('whenToUse: 处理特定任务时')
    expect(fileContent).toContain('disable-model-invocation: true')
    expect(fileContent).toContain('user-invocable: false')
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

  test('setSkillEnabled 校验、落盘与即时生效机制', async () => {
    const home = makeHome()

    // 1. 参数校验:空名称
    await expect(setSkillEnabled(home, '', true)).rejects.toThrow(/params\.name/)

    // 2. 拒绝系统技能 (SYSTEM_SKILLS: explore, test-fix)
    await expect(setSkillEnabled(home, 'explore', false)).rejects.toThrow(/系统技能，始终启用/)
    await expect(setSkillEnabled(home, 'test-fix', false)).rejects.toThrow(/系统技能，始终启用/)

    // 3. 拒绝非内置技能
    await expect(setSkillEnabled(home, 'not-a-bundled-skill', true)).rejects.toThrow(/not a bundled skill/)

    // 4. 落盘校验与即时生效 (带 mock registrar)
    let registeredSkillName: string | undefined
    let disposed = false
    const mockDispose = () => {
      disposed = true
    }
    const mockRegistrar = {
      skills: {
        register: (skill: { name: string }) => {
          registeredSkillName = skill.name
          return mockDispose
        },
      },
    }

    setBundledSkillRegistrar(mockRegistrar as any)
    try {
      // 启用 pdf
      const enableRes = await setSkillEnabled(home, 'pdf', true)
      expect(enableRes).toEqual({ ok: true })
      expect(registeredSkillName).toBe('pdf')

      // 落盘验证
      const togglesOn = readSkillToggles(home)
      expect(togglesOn['pdf']).toBe(true)

      // 禁用 pdf -> 触发 dispose
      const disableRes = await setSkillEnabled(home, 'pdf', false)
      expect(disableRes).toEqual({ ok: true })
      expect(disposed).toBe(true)

      // 落盘验证 (禁用后 key 被 delete)
      const togglesOff = readSkillToggles(home)
      expect(togglesOff['pdf']).toBeUndefined()

      // registrar 为 null 时安全跳过重注不抛错
      setBundledSkillRegistrar(null)
      await expect(setSkillEnabled(home, 'pdf', true)).resolves.toEqual({ ok: true })
      expect(readSkillToggles(home)['pdf']).toBe(true)
    } finally {
      setBundledSkillRegistrar(null)
    }
  })
})

describe('restoreEnabledBundledSkills boot 恢复(M4 评审 D2)', () => {
  test('按 toggles 恢复已启用技能:跳过系统技能、未知名容错、handles 记账', () => {
    const home = makeHome()
    // pdf 真实存在于 bundled 目录;explore 是系统技能(由 guardrails 注册,恢复须跳过);
    // not-a-bundled-skill 不存在——registerBundledSkill 返回 undefined,静默跳过不抛。
    writeFileSync(
      join(home, 'skill-toggles.json'),
      JSON.stringify({ pdf: true, explore: true, 'not-a-bundled-skill': true }),
    )
    const registered: string[] = []
    const mockRegistrar = {
      skills: {
        register: (skill: { name: string }) => {
          registered.push(skill.name)
          return () => {}
        },
      },
    }

    restoreEnabledBundledSkills(home, mockRegistrar)

    expect(registered).toEqual(['pdf'])
    expect(getSkillHandlesForTest().has('pdf')).toBe(true)
  })

  test('启用 → 重启(新 registrar)→ 仍注册,且之后 disable 仍生效', async () => {
    const home = makeHome()
    const registeredA: string[] = []
    const registrarA = {
      skills: {
        register: (skill: { name: string }) => {
          registeredA.push(skill.name)
          return () => {}
        },
      },
    }

    // 第一代:用户启用 pdf(即时注册 + 落盘)。
    setBundledSkillRegistrar(registrarA as any)
    try {
      await setSkillEnabled(home, 'pdf', true)
      expect(registeredA).toEqual(['pdf'])
    } finally {
      setBundledSkillRegistrar(null)
    }

    // 模拟 generation 重启:模块态(handles)随新进程归零,boot 恢复用新 registrar 重放
    // (等价 index.ts 内联 skills 插件在 skills 服务就绪后执行的行为)。
    getSkillHandlesForTest().clear()
    const registeredB: string[] = []
    let disposedB = false
    const registrarB = {
      skills: {
        register: (skill: { name: string }) => {
          registeredB.push(skill.name)
          return () => {
            disposedB = true
          }
        },
      },
    }

    restoreEnabledBundledSkills(home, registrarB)

    // D2 修复目标:重启后模型目录里仍能发现该技能(收到注册)。
    expect(registeredB).toEqual(['pdf'])
    expect(getSkillHandlesForTest().has('pdf')).toBe(true)

    // 回归断言:恢复进了 skillHandles 记账,后续 disable 才能真正 dispose——
    // harness register 同层 first-wins,不记账则 disable 半残。
    await setSkillEnabled(home, 'pdf', false)
    expect(disposedB).toBe(true)
    expect(readSkillToggles(home)['pdf']).toBeUndefined()
  })

  test('同进程重复 restore 幂等:dispose-then-register,handles 不膨胀', () => {
    const home = makeHome()
    writeFileSync(join(home, 'skill-toggles.json'), JSON.stringify({ pdf: true }))
    const registered: string[] = []
    const disposed: string[] = []
    const mockRegistrar = {
      skills: {
        register: (skill: { name: string }) => {
          registered.push(skill.name)
          return () => disposed.push(skill.name)
        },
      },
    }

    restoreEnabledBundledSkills(home, mockRegistrar)
    restoreEnabledBundledSkills(home, mockRegistrar)

    expect(registered).toEqual(['pdf', 'pdf'])
    expect(disposed).toEqual(['pdf'])
    expect(getSkillHandlesForTest().size).toBe(1)
  })
})

