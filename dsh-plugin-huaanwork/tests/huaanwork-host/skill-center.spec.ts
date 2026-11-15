/**
 * Task 6: skill center projection.
 *
 * Real temp profiles and real bundled skill trees; only the remote client is a
 * fake (the HTTP client has its own loopback suite). Pins the five
 * `downloadState` outcomes, the offline cache fallback, the exact §5.4 error
 * sentence, and the `/` invocation projection.
 */

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createSkillDigest, readSkillDirectory } from '@huaanwork/skill-format'

import { SYSTEM_SKILLS, bundledSkillDir, listBundledSkills } from '../../src/huaanwork-guardrails/skills.ts'
import { setUserSkillToggle, writeSkillLocalEntry } from '../../src/huaanwork-host/skill-local-state.ts'
import {
  SKILL_CATALOG_UNAVAILABLE,
  listInvocableSkills,
  listSkillCenter,
  skillCatalogCachePath,
} from '../../src/huaanwork-host/skill-center.ts'
import type { SkillCatalogClient, SkillRevisionSummary } from '../../src/huaanwork-host/skill-catalog-client.ts'
import { SkillCatalogClientError } from '../../src/huaanwork-host/skill-catalog-client.ts'
import type { SkillDownloadState } from '../../src/client-huaanwork/rpc-types.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`

let homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skill-center-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
  homes = []
})

function writeLocalSkill(profileDir: string, name: string, extraFrontmatter = '', body = '正文'): string {
  const dir = join(profileDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n${extraFrontmatter}---\n\n${body}\n`, 'utf8')
  return file
}

function skillDigest(file: string): string {
  return createSkillDigest([{ path: 'SKILL.md', data: readFileSync(file) }])
}

function catalogItem(name: string, revision: number, digest: string): SkillRevisionSummary {
  return {
    name,
    revision,
    description: `${name} 共享描述`,
    publisher: 'alice',
    digest,
    size: 100,
    updatedAt: '2026-11-14T00:00:00.000Z',
  }
}

function fakeClient(items: SkillRevisionSummary[] | (() => Promise<SkillRevisionSummary[]>)): SkillCatalogClient {
  return {
    listSharedSkills: typeof items === 'function' ? items : async () => items,
    getSkillRevision: async (name, revision) => catalogItem(name, revision, digestA),
    downloadSkillArchive: async () => Buffer.alloc(0),
    publishSkill: async () => { throw new Error('publishSkill is not used in this test') },
  }
}

async function stateOf(
  profileDir: string,
  client: SkillCatalogClient,
  name: string,
): Promise<SkillDownloadState | undefined> {
  const result = await listSkillCenter(profileDir, { client })
  return result.skills.find(skill => skill.name === name)?.downloadState
}

test('computes all five download states against the local state', async () => {
  const bundled = listBundledSkills().find(skill => !SYSTEM_SKILLS.has(skill.name) && skill.name !== 'create-agent')
  assert.ok(bundled)

  // 1) system skill → not-applicable
  {
    const profile = makeHome()
    assert.equal(await stateOf(profile, fakeClient([]), 'explore'), 'not-applicable')
  }

  // 2) bundled ordinary, no local copy → available
  {
    const profile = makeHome()
    assert.equal(await stateOf(profile, fakeClient([]), bundled.name), 'available')
  }

  // 3) bundled local copy with the bundled digest → downloaded
  {
    const profile = makeHome()
    const source = bundledSkillDir(bundled.name)!
    cpSync(source, join(profile, 'skills', bundled.name), { recursive: true })
    const digest = createSkillDigest(readSkillDirectory(join(profile, 'skills', bundled.name)))
    writeSkillLocalEntry(profile, bundled.name, { origin: { kind: 'bundled' }, contentDigest: digest })
    assert.equal(await stateOf(profile, fakeClient([]), bundled.name), 'downloaded')
  }

  // 4) catalog, no local copy → available
  {
    const profile = makeHome()
    assert.equal(
      await stateOf(profile, fakeClient([catalogItem('shared', 1, digestA)]), 'shared'),
      'available',
    )
  }

  // 5) catalog same revision + same digest → downloaded
  {
    const profile = makeHome()
    const file = writeLocalSkill(profile, 'shared')
    const digest = skillDigest(file)
    writeSkillLocalEntry(profile, 'shared', {
      origin: { kind: 'catalog', name: 'shared', revision: 1, publisher: 'alice', digest },
      contentDigest: digest,
    })
    assert.equal(
      await stateOf(profile, fakeClient([catalogItem('shared', 1, digest)]), 'shared'),
      'downloaded',
    )
  }

  // 6) catalog newer revision, local unmodified → update-available
  {
    const profile = makeHome()
    const file = writeLocalSkill(profile, 'shared')
    const digest = skillDigest(file)
    writeSkillLocalEntry(profile, 'shared', {
      origin: { kind: 'catalog', name: 'shared', revision: 1, publisher: 'alice', digest },
      contentDigest: digest,
    })
    assert.equal(
      await stateOf(profile, fakeClient([catalogItem('shared', 2, digestB)]), 'shared'),
      'update-available',
    )
  }

  // 7) catalog same name but a locally created copy → local-conflict
  {
    const profile = makeHome()
    const file = writeLocalSkill(profile, 'shared')
    const digest = skillDigest(file)
    writeSkillLocalEntry(profile, 'shared', { origin: { kind: 'created' }, contentDigest: digest })
    assert.equal(
      await stateOf(profile, fakeClient([catalogItem('shared', 1, digest)]), 'shared'),
      'local-conflict',
    )
  }

  // 8) catalog copy with unpushed local edits → local-conflict
  {
    const profile = makeHome()
    writeLocalSkill(profile, 'shared', '', '本地改过')
    writeSkillLocalEntry(profile, 'shared', {
      origin: { kind: 'catalog', name: 'shared', revision: 1, publisher: 'alice', digest: digestA },
      contentDigest: digestC,
    })
    assert.equal(
      await stateOf(profile, fakeClient([catalogItem('shared', 2, digestB)]), 'shared'),
      'local-conflict',
    )
  }
})

test('pins the exact catalog-unavailable sentence from spec §5.4', () => {
  assert.equal(SKILL_CATALOG_UNAVAILABLE, '共享技能库不可用，当前显示内置技能与已缓存内容')
})

test('projects an out-of-band edited catalog copy as local-conflict (评审 Important 1)', async () => {
  const profile = makeHome()
  const file = writeLocalSkill(profile, 'shared', '', '第一版')
  const digest = skillDigest(file)
  writeSkillLocalEntry(profile, 'shared', {
    origin: { kind: 'catalog', name: 'shared', revision: 1, publisher: 'alice', digest },
    contentDigest: digest,
  })
  // 远端仍是同一 digest/revision;磁盘被应用外修改,记录摘要过期。
  writeFileSync(file, '---\nname: shared\ndescription: shared\n---\n\n外部改过\n', 'utf8')
  assert.equal(
    await stateOf(profile, fakeClient([catalogItem('shared', 1, digest)]), 'shared'),
    'local-conflict',
  )
})

test('same digest at a higher revision still surfaces update-available (评审 Important 2)', async () => {
  const profile = makeHome()
  const file = writeLocalSkill(profile, 'shared', '', '正文')
  const digest = skillDigest(file)
  writeSkillLocalEntry(profile, 'shared', {
    origin: { kind: 'catalog', name: 'shared', revision: 1, publisher: 'alice', digest },
    contentDigest: digest,
  })
  // 发布者回滚到旧内容:摘要相同但 revision 更高,仍应提示更新以同步修订号。
  assert.equal(
    await stateOf(profile, fakeClient([catalogItem('shared', 3, digest)]), 'shared'),
    'update-available',
  )
})

test('keeps the live listing when the cache write fails', async () => {
  const profile = makeHome()
  // A directory at the cache path makes the atomic rename fail.
  mkdirSync(skillCatalogCachePath(profile), { recursive: true })
  const result = await listSkillCenter(profile, {
    client: fakeClient([catalogItem('shared', 1, digestA)]),
  })
  assert.equal(result.catalogError, undefined)
  assert.ok(result.skills.some(skill => skill.source === 'catalog' && skill.name === 'shared'))
})

test('leaves the previous cache untouched when a refresh fails', async () => {
  const profile = makeHome()
  await listSkillCenter(profile, { client: fakeClient([catalogItem('shared', 1, digestA)]) })
  const before = readFileSync(skillCatalogCachePath(profile), 'utf8')
  const failing = fakeClient(async () => {
    throw new Error('offline')
  })
  const result = await listSkillCenter(profile, { client: failing })
  assert.equal(result.catalogError, SKILL_CATALOG_UNAVAILABLE)
  assert.equal(readFileSync(skillCatalogCachePath(profile), 'utf8'), before)
})

test('falls back to the complete cache with the exact error sentence', async () => {
  const profile = makeHome()
  const items = [catalogItem('shared', 1, digestA)]
  const first = await listSkillCenter(profile, { client: fakeClient(items) })
  assert.equal(first.catalogError, undefined)
  assert.ok(first.skills.some(skill => skill.source === 'catalog' && skill.name === 'shared'))

  const failing = fakeClient(async () => {
    throw new Error('offline')
  })
  const second = await listSkillCenter(profile, { client: failing })
  assert.equal(second.catalogError, SKILL_CATALOG_UNAVAILABLE)
  assert.ok(second.skills.some(skill => skill.source === 'catalog' && skill.name === 'shared'))
  assert.ok(second.skills.some(skill => skill.source === 'bundled'))
})

test('never fabricates a catalog when no cache exists', async () => {
  const profile = makeHome()
  const failing = fakeClient(async () => {
    throw new Error('offline')
  })
  const result = await listSkillCenter(profile, { client: failing })
  assert.equal(result.catalogError, SKILL_CATALOG_UNAVAILABLE)
  assert.equal(result.skills.some(skill => skill.source === 'catalog'), false)
  assert.ok(result.skills.some(skill => skill.source === 'bundled'))
})

test('treats a corrupt cache as a miss', async () => {
  const profile = makeHome()
  writeFileSync(skillCatalogCachePath(profile), '{ not json', 'utf8')
  const failing = fakeClient(async () => {
    throw new Error('offline')
  })
  const result = await listSkillCenter(profile, { client: failing })
  assert.equal(result.catalogError, SKILL_CATALOG_UNAVAILABLE)
  assert.equal(result.skills.some(skill => skill.source === 'catalog'), false)
})

test('surfaces a distinct message for auth failures (评审 Minor 1)', async () => {
  const profile = makeHome()
  const failing = fakeClient(async () => {
    throw new SkillCatalogClientError('技能上传口令错误或权限不足', 'auth', 401)
  })
  const result = await listSkillCenter(profile, { client: failing })
  assert.equal(result.catalogError, '技能上传口令错误或权限不足')
  assert.ok(result.skills.some(skill => skill.source === 'bundled'))
})

test('surfaces a distinct message for page-limit failures (评审 Minor 1)', async () => {
  const profile = makeHome()
  const failing = fakeClient(async () => {
    throw new SkillCatalogClientError('技能目录分页超过 1000 页上限', 'page-limit')
  })
  const result = await listSkillCenter(profile, { client: failing })
  assert.equal(result.catalogError, '技能目录分页超过 1000 页上限')
})

test('projects the slash menu to system plus enabled local skills without remote calls', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'alpha')
  setUserSkillToggle(profile, 'alpha', true)
  writeLocalSkill(profile, 'beta', 'user-invocable: false\n')
  setUserSkillToggle(profile, 'beta', true)
  writeLocalSkill(profile, 'gamma')
  setUserSkillToggle(profile, 'gamma', false)

  const skills = await listInvocableSkills(profile)
  const names = skills.map(skill => skill.name)
  assert.ok(names.includes('explore'))
  assert.ok(names.includes('test-fix'))
  assert.ok(names.includes('alpha'))
  // R7: user-invocable stays metadata; the enable toggle is the gate.
  assert.ok(names.includes('beta'))
  assert.equal(names.includes('gamma'), false)
  assert.equal(names.includes('create-agent'), false)
  const alpha = skills.find(skill => skill.name === 'alpha')
  assert.deepEqual(alpha, {
    name: 'alpha',
    description: 'alpha',
    source: 'user',
    enabled: true,
    originKind: 'created',
  })
})

test('surfaces migration warnings from the local state', async () => {
  const profile = makeHome()
  writeFileSync(join(profile, 'skill-local-state.json'), JSON.stringify({
    schemaVersion: 1,
    migration: { version: 1, completedAt: '2026-11-14T00:00:00.000Z' },
    skills: {},
    migrationWarnings: ['内置技能 pdf 的同名本地副本已启用'],
  }), 'utf8')
  const result = await listSkillCenter(profile, { client: fakeClient([]) })
  assert.deepEqual(result.migrationWarnings, ['内置技能 pdf 的同名本地副本已启用'])
})
