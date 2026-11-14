import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSkillDigest } from '@huaanwork/skill-format'
import {
  createSkill,
  importSkill,
  listUserSkills,
  previewSkillImport,
  removeSkill,
  setSkillEnabled,
  updateSkill,
} from '../../src/huaanwork-host/skills-host.ts'
import {
  CorruptSkillLocalStateError,
  CorruptUserSkillTogglesError,
  markSkillCenterMigrationComplete,
  readSkillLocalState,
  readUserSkillToggles,
  removeSkillLocalEntry,
  setUserSkillToggle,
  skillLocalStatePath,
  userSkillTogglesPath,
  writeSkillLocalEntry,
} from '../../src/huaanwork-host/skill-local-state.ts'

let homes: string[] = []
let prevAgentsHome: string | undefined

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skill-state-'))
  homes.push(home)
  return home
}

function writeLocalSkill(profileDir: string, name: string, content: string): string {
  const dir = join(profileDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${content}\n`, 'utf8')
  return path
}

function writeExternalSkill(name: string, content: string): string {
  const root = join(process.env.DSH_AGENTS_HOME!, 'skills')
  mkdirSync(root, { recursive: true })
  const path = join(root, `${name}.md`)
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} 外部描述\n---\n\n${content}\n`, 'utf8')
  return path
}

function flatDigest(path: string): string {
  return createSkillDigest([{ path: 'SKILL.md', data: readFileSync(path) }])
}

beforeEach(() => {
  prevAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = mkdtempSync(join(tmpdir(), 'hw-fake-agents-'))
  homes.push(process.env.DSH_AGENTS_HOME)
})

afterEach(() => {
  if (prevAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = prevAgentsHome
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe('user-skill-toggles.json', () => {
  test('a missing document means every local skill is disabled', () => {
    const profile = makeHome()
    assert.deepEqual(readUserSkillToggles(profile), {})
  })

  test('writes only enabled=true names with a same-directory temporary file', () => {
    const profile = makeHome()
    setUserSkillToggle(profile, 'demo', true)
    assert.deepEqual(readUserSkillToggles(profile), { demo: true })
    assert.deepEqual(JSON.parse(readFileSync(userSkillTogglesPath(profile), 'utf8')), { demo: true })
    assert.deepEqual(
      readdirSync(profile).filter((name) => name.endsWith('.tmp')),
      [],
    )

    setUserSkillToggle(profile, 'other', true)
    setUserSkillToggle(profile, 'demo', false)
    assert.deepEqual(readUserSkillToggles(profile), { other: true })
    assert.deepEqual(JSON.parse(readFileSync(userSkillTogglesPath(profile), 'utf8')), { other: true })

    // 禁用缺失键是幂等操作,不会凭空写出 false。
    setUserSkillToggle(profile, 'missing', false)
    assert.deepEqual(readUserSkillToggles(profile), { other: true })
  })

  test('a corrupted document throws a named error instead of meaning all-disabled', () => {
    const profile = makeHome()
    writeFileSync(userSkillTogglesPath(profile), '{not json', 'utf8')
    assert.throws(
      () => readUserSkillToggles(profile),
      (error: unknown) =>
        error instanceof CorruptUserSkillTogglesError && /不是合法 JSON/.test(error.message),
    )

    writeFileSync(userSkillTogglesPath(profile), '["demo"]', 'utf8')
    assert.throws(
      () => readUserSkillToggles(profile),
      (error: unknown) => error instanceof CorruptUserSkillTogglesError && /JSON 对象/.test(error.message),
    )

    writeFileSync(userSkillTogglesPath(profile), '{"demo":false}', 'utf8')
    assert.throws(
      () => readUserSkillToggles(profile),
      (error: unknown) =>
        error instanceof CorruptUserSkillTogglesError && /enabled=true/.test(error.message),
    )

    writeFileSync(userSkillTogglesPath(profile), '{"Bad_Name":true}', 'utf8')
    assert.throws(
      () => readUserSkillToggles(profile),
      (error: unknown) => error instanceof CorruptUserSkillTogglesError && /技能名/.test(error.message),
    )
  })
})

describe('skill-local-state.json', () => {
  test('a missing document starts empty and entries round-trip', () => {
    const profile = makeHome()
    assert.deepEqual(readSkillLocalState(profile), { schemaVersion: 1, skills: {} })

    writeSkillLocalEntry(profile, 'demo', {
      origin: { kind: 'created' },
      contentDigest: 'sha256:one',
    })
    writeSkillLocalEntry(profile, 'imported', {
      origin: { kind: 'imported' },
      contentDigest: 'sha256:two',
      publishedRevision: 2,
      publishedDigest: 'sha256:two',
    })
    const state = readSkillLocalState(profile)
    assert.deepEqual(state.skills.demo, { origin: { kind: 'created' }, contentDigest: 'sha256:one' })
    assert.deepEqual(state.skills.imported, {
      origin: { kind: 'imported' },
      contentDigest: 'sha256:two',
      publishedRevision: 2,
      publishedDigest: 'sha256:two',
    })
    assert.deepEqual(
      readdirSync(profile).filter((name) => name.endsWith('.tmp')),
      [],
    )

    removeSkillLocalEntry(profile, 'demo')
    assert.equal(readSkillLocalState(profile).skills.demo, undefined)
    assert.deepEqual(readSkillLocalState(profile).skills.imported, state.skills.imported)
  })

  test('the migration marker and warnings survive later entry writes', () => {
    const profile = makeHome()
    markSkillCenterMigrationComplete(profile, ['内置技能 pdf 未复制'])
    const completed = readSkillLocalState(profile)
    assert.equal(completed.migration?.version, 1)
    assert.ok(completed.migration?.completedAt)
    assert.deepEqual(completed.migrationWarnings, ['内置技能 pdf 未复制'])

    writeSkillLocalEntry(profile, 'demo', { origin: { kind: 'created' }, contentDigest: 'sha256:x' })
    const state = readSkillLocalState(profile)
    assert.equal(state.migration?.version, 1)
    assert.deepEqual(state.migrationWarnings, ['内置技能 pdf 未复制'])
  })

  test('a corrupted document throws a named error', () => {
    const profile = makeHome()
    writeFileSync(skillLocalStatePath(profile), '{not json', 'utf8')
    assert.throws(
      () => readSkillLocalState(profile),
      (error: unknown) =>
        error instanceof CorruptSkillLocalStateError && /不是合法 JSON/.test(error.message),
    )

    writeFileSync(skillLocalStatePath(profile), '{"schemaVersion":2,"skills":{}}', 'utf8')
    assert.throws(
      () => readSkillLocalState(profile),
      (error: unknown) => error instanceof CorruptSkillLocalStateError && /schemaVersion/.test(error.message),
    )

    writeFileSync(skillLocalStatePath(profile), '{"schemaVersion":1}', 'utf8')
    assert.throws(
      () => readSkillLocalState(profile),
      (error: unknown) => error instanceof CorruptSkillLocalStateError && /skills/.test(error.message),
    )

    writeFileSync(
      skillLocalStatePath(profile),
      '{"schemaVersion":1,"skills":{"demo":{"origin":{"kind":"unknown"},"contentDigest":"sha256:x"}}}',
      'utf8',
    )
    assert.throws(
      () => readSkillLocalState(profile),
      (error: unknown) => error instanceof CorruptSkillLocalStateError && /origin/.test(error.message),
    )

    writeFileSync(
      skillLocalStatePath(profile),
      '{"schemaVersion":1,"skills":{"demo":{"origin":{"kind":"created"},"contentDigest":"sha256:x","publishedRevision":"two"}}}',
      'utf8',
    )
    assert.throws(
      () => readSkillLocalState(profile),
      (error: unknown) =>
        error instanceof CorruptSkillLocalStateError && /publishedRevision/.test(error.message),
    )
  })
})

describe('local skill lifecycle projections', () => {
  test('new imported skills are disabled and state survives removal', async () => {
    const profile = makeHome()
    const fixturePath = writeExternalSkill('demo', '正文')
    const imported = await importSkill(profile, { path: fixturePath })
    assert.equal(imported.ok, true)
    assert.equal(readUserSkillToggles(profile).demo, undefined)
    assert.equal(readSkillLocalState(profile).skills.demo?.origin.kind, 'imported')
    await removeSkill(profile, 'demo')
    assert.equal(readSkillLocalState(profile).skills.demo, undefined)
    assert.equal(readUserSkillToggles(profile).demo, undefined)
  })

  test('createSkill records created origin, computes the digest, and never writes user-invocable', async () => {
    const profile = makeHome()
    const created = await createSkill(profile, {
      name: 'my-skill',
      description: '我的技能',
      whenToUse: '处理特定任务时',
      disableModelInvocation: true,
      userInvocable: false,
      content: '# 步骤\n1. 执行',
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    assert.equal(created.skill.name, 'my-skill')
    assert.equal(created.skill.source, 'user')
    assert.equal(created.skill.whenToUse, '处理特定任务时')
    assert.equal(created.skill.enabled, false)
    assert.deepEqual(created.skill.origin, { kind: 'created' })
    assert.equal(created.skill.publishState, 'not-published')

    const skillPath = join(profile, 'skills', 'my-skill', 'SKILL.md')
    const raw = readFileSync(skillPath, 'utf8')
    assert.equal(raw.includes('user-invocable'), false)
    assert.equal(created.skill.contentDigest, flatDigest(skillPath))
    assert.deepEqual(readSkillLocalState(profile).skills['my-skill'], {
      origin: { kind: 'created' },
      contentDigest: created.skill.contentDigest,
    })
    assert.equal(readUserSkillToggles(profile)['my-skill'], undefined)
  })

  test('importSkill keeps the imported frontmatter verbatim and updateSkill keeps its user-invocable line', async () => {
    const profile = makeHome()
    const source = join(profile, 'manual-file.md')
    const raw = '---\nname: manual-file\ndescription: 手工文件\nuser-invocable: false\nx-custom: keep-me\n---\n\n原始正文\n'
    writeFileSync(source, raw, 'utf8')

    const imported = await importSkill(profile, { path: source })
    assert.equal(imported.ok, true)
    if (!imported.ok) return
    assert.deepEqual(imported.skill.origin, { kind: 'imported' })
    assert.equal(imported.skill.enabled, false)
    assert.equal(imported.skill.publishState, 'not-published')
    const saved = join(profile, 'skills', 'manual-file', 'SKILL.md')
    assert.equal(readFileSync(saved, 'utf8'), raw)

    const updated = await updateSkill(profile, 'manual-file', {
      description: '编辑后的描述',
      content: '编辑后的正文',
    })
    assert.equal(updated.ok, true)
    if (!updated.ok) return
    assert.deepEqual(updated.skill.origin, { kind: 'imported' })
    const edited = readFileSync(saved, 'utf8')
    assert.ok(edited.includes('user-invocable: false'))
    assert.ok(edited.includes('x-custom: keep-me'))
    assert.ok(edited.includes('编辑后的正文'))
    assert.equal(updated.skill.contentDigest, flatDigest(saved))
    assert.notEqual(updated.skill.contentDigest, imported.skill.contentDigest)
  })

  test('updateSkill preserves origin and publish snapshot, then reports modified', async () => {
    const profile = makeHome()
    const created = await createSkill(profile, {
      name: 'published-skill',
      description: '已发布技能',
      content: '第一版正文',
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const firstDigest = created.skill.contentDigest
    writeSkillLocalEntry(profile, 'published-skill', {
      origin: { kind: 'created' },
      contentDigest: firstDigest,
      publishedRevision: 3,
      publishedDigest: firstDigest,
    })

    const before = (await listUserSkills(profile)).find((skill) => skill.name === 'published-skill')
    assert.equal(before?.publishState, 'published')
    assert.equal(before?.publishedRevision, 3)

    const updated = await updateSkill(profile, 'published-skill', {
      description: '已发布技能',
      content: '第二版正文',
    })
    assert.equal(updated.ok, true)
    if (!updated.ok) return
    assert.equal(updated.skill.publishState, 'modified')
    assert.equal(updated.skill.publishedRevision, 3)
    assert.equal(updated.skill.publishedDigest, firstDigest)
    assert.notEqual(updated.skill.contentDigest, firstDigest)
    assert.deepEqual(readSkillLocalState(profile).skills['published-skill'], {
      origin: { kind: 'created' },
      contentDigest: updated.skill.contentDigest,
      publishedRevision: 3,
      publishedDigest: firstDigest,
    })
  })

  test('listUserSkills projects flat markdown skills and their enabled state', async () => {
    const profile = makeHome()
    const flatPath = join(profile, 'skills', 'flat.md')
    mkdirSync(join(profile, 'skills'), { recursive: true })
    writeFileSync(flatPath, '---\nname: flat\ndescription: 扁平技能\n---\n\n扁平正文\n', 'utf8')

    const [skill] = await listUserSkills(profile)
    assert.equal(skill?.name, 'flat')
    assert.equal(skill?.source, 'user')
    assert.equal(skill?.enabled, false)
    assert.deepEqual(skill?.origin, { kind: 'created' })
    assert.equal(skill?.publishState, 'not-published')
    assert.equal(skill?.contentDigest, flatDigest(flatPath))

    setUserSkillToggle(profile, 'flat', true)
    const [enabled] = await listUserSkills(profile)
    assert.equal(enabled?.enabled, true)
  })

  test('removeSkill deletes both the local-state entry and an enabled toggle', async () => {
    const profile = makeHome()
    writeLocalSkill(profile, 'removable', '待删正文')
    await setSkillEnabled(profile, 'removable', true)
    assert.equal(readUserSkillToggles(profile).removable, true)
    await removeSkill(profile, 'removable')
    assert.equal(readUserSkillToggles(profile).removable, undefined)
    assert.equal(readSkillLocalState(profile).skills.removable, undefined)
  })
})

describe('taken names and setSkillEnabled', () => {
  test('ordinary bundled names no longer block local create/import; system and internal names still do', async () => {
    const profile = makeHome()
    const pdfSource = writeExternalSkill('pdf', '本地 PDF 副本')
    const preview = await previewSkillImport(profile, pdfSource)
    assert.equal(preview.ok, true)

    const created = await createSkill(profile, {
      name: 'pdf',
      description: '本地 PDF 副本',
      content: '本地正文',
    })
    assert.equal(created.ok, true)

    const system = await createSkill(profile, { name: 'explore', description: 'd', content: 'c' })
    assert.equal(system.ok, false)
    const internal = await createSkill(profile, { name: 'create-agent', description: 'd', content: 'c' })
    assert.equal(internal.ok, false)
  })

  test('setSkillEnabled only toggles an existing local user skill', async () => {
    const profile = makeHome()
    await expect(setSkillEnabled(profile, '', true)).rejects.toThrow(/params\.name/)
    await expect(setSkillEnabled(profile, 'missing', true)).rejects.toThrow(/不是本地用户技能/)
    await expect(setSkillEnabled(profile, 'explore', false)).rejects.toThrow(/系统技能，始终启用/)
    await expect(setSkillEnabled(profile, 'create-agent', true)).rejects.toThrow(/内部技能，不能启停/)

    const created = await createSkill(profile, { name: 'toggle-me', description: '开关技能', content: '正文' })
    expect(created.ok).toBe(true)

    await expect(setSkillEnabled(profile, 'toggle-me', true)).resolves.toEqual({ ok: true })
    expect(readUserSkillToggles(profile)['toggle-me']).toBe(true)
    await expect(setSkillEnabled(profile, 'toggle-me', false)).resolves.toEqual({ ok: true })
    expect(readUserSkillToggles(profile)['toggle-me']).toBeUndefined()
  })
})
