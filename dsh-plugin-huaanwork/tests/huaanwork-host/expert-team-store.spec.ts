import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExpertTeamStore } from '../../src/huaanwork-host/expert-team/store.ts'
import { validTeamInput } from '../fixtures/expert-team/team.ts'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** 原子写只允许同目录 `.tmp-<uuid>` 中转；任何残留都说明写路径不干净。 */
function tempResidue(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.tmp-') || name.startsWith('.old-'))
}

describe('expert team store', () => {
  it('persists definitions atomically and preserves slug identity', async () => {
    const root = makeRoot('expert-team-store-')
    let tick = 1
    const store = createExpertTeamStore(root, { now: () => new Date(1_700_000_000_000 + (tick++ * 1000)).toISOString() })
    const created = await store.create(validTeamInput({ slug: 'compliance' }))
    // 调用方输入的 id 不是存储身份：create 必须换成全新的随机 id。
    expect(created.id).not.toBe('00000000-0000-4000-8000-000000000001')
    const teamsRoot = join(root, 'expert-teams')
    expect(readFileSync(join(teamsRoot, `${created.id}.json`), 'utf8')).toContain('"slug": "compliance"')
    await expect(store.create(validTeamInput({ slug: 'compliance' }))).rejects.toThrow('expert-team-slug-exists')
    const updated = await store.update(created.id, { name: '新名称' })
    expect(updated).toMatchObject({ id: created.id, slug: 'compliance', name: '新名称', createdAt: created.createdAt })
    expect(updated.updatedAt).not.toBe(created.updatedAt)
    await store.setEnabled(created.id, false)
    expect((await store.get(created.id)).team?.enabled).toBe(false)
    expect(tempResidue(teamsRoot)).toEqual([])
  })

  it('ignores immutable envelope fields in update patches', async () => {
    const root = makeRoot('expert-team-immutable-')
    let tick = 1
    const store = createExpertTeamStore(root, { now: () => new Date(1_700_000_000_000 + (tick++ * 1000)).toISOString() })
    const created = await store.create(validTeamInput({ slug: 'immutable' }))
    const updated = await store.update(created.id, {
      name: '只改名称',
      id: 'other-id',
      slug: 'hijacked',
      schemaVersion: 2,
      enabled: false,
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
    })
    expect(updated).toMatchObject({
      schemaVersion: 1,
      id: created.id,
      slug: 'immutable',
      createdAt: created.createdAt,
      enabled: true,
      name: '只改名称',
    })
    expect(updated.updatedAt).not.toBe(created.updatedAt)
    expect((await store.get(created.id)).team).toMatchObject({ slug: 'immutable', enabled: true, name: '只改名称' })
    expect(tempResidue(join(root, 'expert-teams'))).toEqual([])
  })

  it('stamps the storage-owned schema version on create', async () => {
    const root = makeRoot('expert-team-version-')
    const store = createExpertTeamStore(root)
    const created = await store.create({ ...validTeamInput({ slug: 'versioned' }), schemaVersion: 99 })
    expect(created.schemaVersion).toBe(1)
    const persisted = JSON.parse(
      readFileSync(join(root, 'expert-teams', `${created.id}.json`), 'utf8'),
    ) as Record<string, unknown>
    expect(persisted.schemaVersion).toBe(1)
  })

  it('persists only contract fields and drops unknown keys on write and read', async () => {
    const root = makeRoot('expert-team-normalize-')
    const store = createExpertTeamStore(root)
    const base = validTeamInput({ slug: 'normalized' })
    const created = await store.create({
      ...base,
      extraTeamField: 'dropped',
      members: base.members.map((member) => ({ ...member, extraMemberField: 'dropped' })),
      orchestration: { ...base.orchestration, extraRuleField: 'dropped' },
    })
    // 契约以外的键（含成员与嵌套规则）既不落盘也不回传。
    expect(Object.keys(created).sort()).toEqual(
      [
        'createdAt',
        'description',
        'enabled',
        'id',
        'members',
        'name',
        'orchestration',
        'review',
        'scenarios',
        'schemaVersion',
        'slug',
        'summary',
        'updatedAt',
      ].sort(),
    )
    const persistedPath = join(root, 'expert-teams', `${created.id}.json`)
    const persisted = JSON.parse(readFileSync(persistedPath, 'utf8')) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('extraTeamField')
    expect(persisted.orchestration).not.toHaveProperty('extraRuleField')
    expect((persisted.members as Record<string, unknown>[])[0]).not.toHaveProperty('extraMemberField')

    // 旧文件里遗留的额外键在读投影中同样不出现。
    writeFileSync(persistedPath, JSON.stringify({ ...created, legacyExtraField: true }), 'utf8')
    const reread = (await store.get(created.id)).team
    expect(reread?.slug).toBe('normalized')
    expect(reread).not.toHaveProperty('legacyExtraField')

    // update 嵌套补丁夹带的额外键也不得进入存储。
    const updated = await store.update(created.id, {
      orchestration: { ...base.orchestration, patchExtraField: 'dropped' },
    })
    expect(updated.orchestration).not.toHaveProperty('patchExtraField')
    expect(tempResidue(join(root, 'expert-teams'))).toEqual([])
  })

  it('exposes stable error codes for invalid input and unknown ids', async () => {
    const root = makeRoot('expert-team-errors-')
    const store = createExpertTeamStore(root)
    await expect(store.create({ ...validTeamInput({ slug: 'x' }), members: [] })).rejects.toMatchObject({
      code: 'expert-team-invalid',
      fieldErrors: { members: expect.any(String) },
    })
    const missingId = '3f6a1bb0-6f1e-4a7c-9c1d-2f5c8e4b7a90'
    await expect(store.update(missingId, { name: '未知团队' })).rejects.toMatchObject({
      code: 'expert-team-not-found',
    })
    await expect(store.remove(missingId)).rejects.toMatchObject({ code: 'expert-team-not-found' })
  })

  it('fails closed for one corrupt file without hiding other teams or losing its id', async () => {
    const root = makeRoot('expert-team-corrupt-')
    const store = createExpertTeamStore(root)
    const good = await store.create(validTeamInput({ slug: 'good' }))
    const corrupt = await store.create(validTeamInput({ slug: 'corrupt' }))
    const teamsRoot = join(root, 'expert-teams')
    const corruptPath = join(teamsRoot, `${corrupt.id}.json`)
    writeFileSync(corruptPath, '{not-json')
    expect(await store.get(corrupt.id)).toEqual({ id: corrupt.id, error: 'expert-team-corrupt' })
    expect((await store.list()).find((record) => record.id === corrupt.id)?.error).toBe('expert-team-corrupt')
    expect((await store.list()).find((record) => record.team?.id === good.id)?.team?.slug).toBe('good')
    expect(readFileSync(corruptPath, 'utf8')).toBe('{not-json')
    await expect(store.update(corrupt.id, { name: '覆盖损坏文件' })).rejects.toThrow('expert-team-corrupt')
    // 更新失败也不得回写或覆盖损坏原文件。
    expect(readFileSync(corruptPath, 'utf8')).toBe('{not-json')
    await expect(store.get('../escape')).rejects.toThrow()

    // 显式删除只移除目标 JSON；同名 profile 下的智能体、会话与 Artifact 目录保持不动。
    mkdirSync(join(root, 'agents'), { recursive: true })
    mkdirSync(join(root, 'workspace-sessions', 's1'), { recursive: true })
    mkdirSync(join(root, 'artifacts', 'a1'), { recursive: true })
    await store.remove(corrupt.id)
    expect(existsSync(corruptPath)).toBe(false)
    expect(existsSync(join(root, 'agents'))).toBe(true)
    expect(existsSync(join(root, 'workspace-sessions', 's1'))).toBe(true)
    expect(existsSync(join(root, 'artifacts', 'a1'))).toBe(true)
    expect((await store.list()).map((record) => record.team?.slug)).toEqual(['good'])
    expect(tempResidue(teamsRoot)).toEqual([])
  })

  it('isolates team definitions across separate profile directories', async () => {
    const profileA = makeRoot('expert-team-prof-a-')
    const profileB = makeRoot('expert-team-prof-b-')
    const storeA = createExpertTeamStore(profileA)
    const storeB = createExpertTeamStore(profileB)
    const created = await storeA.create(validTeamInput({ slug: 'prof-a-only' }))
    expect((await storeA.list()).map((record) => record.team?.slug)).toEqual(['prof-a-only'])
    expect(await storeB.list()).toEqual([])
    await expect(storeB.get(created.id)).rejects.toThrow('expert-team-not-found')
  })
})
