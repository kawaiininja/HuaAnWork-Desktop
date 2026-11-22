import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ExpertTeam,
  ExpertTeamCancelResult,
  ExpertTeamRunSnapshot,
  RpcEvent,
} from '../../src/client-huaanwork/rpc-types.ts'
import type { AgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import type { AgentPackageDetail, AgentPackageListItem } from '../../src/huaanwork-host/agent-package/types.ts'
import { resolveExpertTeamAvailability } from '../../src/huaanwork-host/expert-team/availability.ts'
import { createExpertTeamRunRegistry, type ExpertTeamRunRegistry } from '../../src/huaanwork-host/expert-team/runs.ts'
import { createExpertTeamStore } from '../../src/huaanwork-host/expert-team/store.ts'
import {
  type ExpertTeamGetResult,
  type ExpertTeamListResult,
  type ExpertTeamWriteResult,
} from '../../src/huaanwork-host/expert-team-routes.ts'
import { ROUTE_TABLE, type RouteContext } from '../../src/huaanwork-host/routes.ts'
import { setAgentPackageHost } from '../../src/huaanwork-host/sessions.ts'
import { validTeam, validTeamInput } from '../fixtures/expert-team/team.ts'

/**
 * 专家团定义/运行 RPC 的跨层测试。
 *
 * fixture 使用临时 profile 的真实 store/registry 与 provider 两个健康包的 fake
 * `AgentPackageHost`，并把 `expertTeamRoutes` handler 包装成直接调用器（query 走
 * 真实 `URLSearchParams`）。这保证测试覆盖的是生产路由处理器本身，而不是另一套
 * 平行实现。
 */

type ExpertTeamRouteCaller = {
  list(): Promise<ExpertTeamListResult>
  get(input: { query: URLSearchParams }): Promise<ExpertTeamGetResult>
  create(input: { body: unknown }): Promise<ExpertTeamWriteResult>
  update(input: { body: unknown }): Promise<ExpertTeamWriteResult>
  setEnabled(input: { body: unknown }): Promise<{ ok: true; team: ExpertTeam }>
  remove(input: { body: unknown }): Promise<{ removed: true }>
  invocableList(): Promise<{ teams: ExpertTeam[] }>
  runList(input: { query: URLSearchParams }): Promise<ExpertTeamRunSnapshot>
  cancel(input: { body: unknown }): Promise<ExpertTeamCancelResult>
}

type ExpertTeamRouteFixture = {
  profileDir: string
  packages: AgentPackageListItem[]
  runs: ExpertTeamRunRegistry
  events: RpcEvent[]
  routes: ExpertTeamRouteCaller
}

/** 两个健康包：与 `validTeamInput()` 的成员引用逐字匹配。 */
function healthyPackages(): AgentPackageListItem[] {
  return [
    { slug: 'writer', displayName: '写手', description: '起草合同结论', version: '1.0.0', source: 'local', enabled: true },
    { slug: 'reviewer', displayName: '审查员', description: '统一合规审查', version: '1.2.0', source: 'local', enabled: true },
  ]
}

function detailFor(pkg: AgentPackageListItem): AgentPackageDetail {
  return {
    ...pkg,
    persona: '',
    skill: { summary: '包技能', markdown: '# 技能', scripts: ['scripts/review.ts'] },
    tools: 'http',
    files: [],
  }
}

let fixtureRoots: string[] = []

afterEach(() => {
  setAgentPackageHost(undefined)
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
  fixtureRoots = []
})

async function makeExpertTeamRouteFixture(): Promise<ExpertTeamRouteFixture> {
  const profileDir = mkdtempSync(join(tmpdir(), 'expert-team-routes-'))
  fixtureRoots.push(profileDir)
  const packages = healthyPackages()
  const host = {
    listWithLegacy: async () => ({ packages, catalogAgents: [] }),
    detail: (slug: string) => {
      const pkg = packages.find((item) => item.slug === slug)
      return pkg === undefined ? undefined : detailFor(pkg)
    },
  } as unknown as AgentPackageHost
  setAgentPackageHost(host)

  const events: RpcEvent[] = []
  const store = createExpertTeamStore(profileDir, { now: () => new Date().toISOString() })
  const runs = createExpertTeamRunRegistry({ generation: 'test-generation', emit: (event) => events.push(event) })
  const ctx = {
    dshHome: profileDir,
    profileDir,
    workspaceRoot: { current: profileDir },
    emit: (event: RpcEvent) => { events.push(event) },
    logger: () => undefined,
    runtimeCtx: { huaanworkExpertTeamStore: store, huaanworkExpertTeamRuns: runs },
    requestRestart: async () => false,
  } as unknown as RouteContext

  // 路由条目从共享 ROUTE_TABLE 取，避免测试直接以 expert-team-routes 作为模块入口
  // （它与 routes.ts 的 RouteError 互为运行时依赖）。取到的就是生产 handler。
  const byName = new Map(
    ROUTE_TABLE
      .filter((route) => route.method.startsWith('expertTeam.'))
      .map((route) => [route.method.slice('expertTeam.'.length), route]),
  )
  const invoke = async (
    name: string,
    input: { body?: unknown; query?: URLSearchParams } = {},
  ): Promise<unknown> => {
    const route = byName.get(name)
    if (route === undefined) throw new Error(`missing expertTeam route: ${name}`)
    return route.handler(
      { params: {}, body: input.body, query: input.query ?? new URLSearchParams() },
      ctx,
    )
  }

  return {
    profileDir,
    packages,
    runs,
    events,
    routes: {
      list: () => invoke('list') as Promise<ExpertTeamListResult>,
      get: (input) => invoke('get', input) as Promise<ExpertTeamGetResult>,
      create: (input) => invoke('create', input) as Promise<ExpertTeamWriteResult>,
      update: (input) => invoke('update', input) as Promise<ExpertTeamWriteResult>,
      setEnabled: (input) => invoke('setEnabled', input) as Promise<{ ok: true; team: ExpertTeam }>,
      remove: (input) => invoke('remove', input) as Promise<{ removed: true }>,
      invocableList: () => invoke('invocableList') as Promise<{ teams: ExpertTeam[] }>,
      runList: (input) => invoke('runList', input) as Promise<ExpertTeamRunSnapshot>,
      cancel: (input) => invoke('cancel', input) as Promise<ExpertTeamCancelResult>,
    },
  }
}

describe('expert team availability', () => {
  it('computes availability exclusively from AgentPackageListItem and never accepts legacy agents', () => {
    const record = { id: 't1', team: validTeam() }
    const packages: AgentPackageListItem[] = [
      { slug: 'writer', displayName: '写手', source: 'local', enabled: true, version: '1.0.0', description: '' },
    ]
    const availability = resolveExpertTeamAvailability(record, packages)
    expect(availability).toMatchObject({ invocable: false, kind: 'member-invalid' })
    expect(availability.members.map((member) => member.reason)).toContain('expert-team-member-missing')
  })

  it('reports corrupt, disabled and invocable definitions from the same package input', () => {
    const packages = healthyPackages()
    expect(resolveExpertTeamAvailability({ id: 't1', error: 'expert-team-corrupt' }, packages)).toMatchObject({
      kind: 'incomplete',
      invocable: false,
    })
    expect(resolveExpertTeamAvailability({ id: 't1', team: validTeamInput({ enabled: false }) }, packages)).toMatchObject({
      kind: 'disabled',
      invocable: false,
    })
    expect(resolveExpertTeamAvailability({ id: 't1', team: validTeam() }, packages)).toMatchObject({
      kind: 'invocable',
      invocable: true,
      reasons: [],
    })
  })
})

describe('expert team routes', () => {
  it('rejects creating a team with invalid/missing members, blocks deletion during active or stopping runs, and returns snapshot revision', async () => {
    const { runs, routes } = await makeExpertTeamRouteFixture()
    const missingMember = await routes.create({
      body: validTeamInput({
        members: [
          validTeam().members[0]!,
          { ...validTeam().members[1]!, agentRef: { source: 'catalog', slug: 'legacy-only' } },
        ],
      }),
    })
    expect(missingMember).toMatchObject({
      ok: false,
      fieldErrors: expect.arrayContaining([expect.objectContaining({ field: 'members' })]),
    })
    const created = await routes.create({ body: validTeamInput() })
    expect(created).toMatchObject({ ok: true, team: { slug: 'compliance-team' } })
    if (!created.ok) throw new Error('expected create to succeed')
    const { team } = created
    await expect(routes.remove({ body: { id: randomUUID() } })).rejects.toThrow('expert-team-not-found')
    const run = runs.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: team })
    await expect(routes.remove({ body: { id: team.id } })).rejects.toThrow('expert-team-active')
    expect(await routes.cancel({ body: { parentSessionId: 's1', teamRunId: run.teamRunId } })).toEqual({
      status: 'accepted',
      teamRunId: run.teamRunId,
    })
    // stopping 期间仍禁止删除
    await expect(routes.remove({ body: { id: team.id } })).rejects.toThrow('expert-team-active')
    runs.markStopped(run.teamRunId)
    expect(await routes.runList({ query: new URLSearchParams({ sessionId: 's1' }) })).toMatchObject({
      generation: runs.list({ sessionId: 's1' }).generation,
      revision: expect.any(Number),
    })
    await expect(routes.remove({ body: { id: team.id } })).resolves.toEqual({ removed: true })
  })

  it('validates members against live package state before writing and lists selectable capabilities', async () => {
    const { packages, routes } = await makeExpertTeamRouteFixture()
    const listed = await routes.list()
    expect(listed.packages).toMatchObject([
      { slug: 'writer', capabilities: { tools: 'http', skillScripts: ['scripts/review.ts'] } },
      { slug: 'reviewer', capabilities: { tools: 'http', skillScripts: ['scripts/review.ts'] } },
    ])
    packages[1]!.enabled = false
    const rejected = await routes.create({ body: validTeamInput() })
    expect(rejected).toMatchObject({
      ok: false,
      fieldErrors: [expect.objectContaining({ field: 'members' })],
    })
    // 写入前校验：被拒绝的创建不得留下定义文件。
    expect((await routes.list()).teams).toEqual([])
  })

  it('allows editing other fields with invalid members but keeps corrupt files fail-closed', async () => {
    const { profileDir, routes } = await makeExpertTeamRouteFixture()
    const created = await routes.create({ body: validTeamInput() })
    if (!created.ok) throw new Error('expected create to succeed')
    const updated = await routes.update({
      body: {
        id: created.team.id,
        name: '合规审查二队',
        members: [
          validTeam().members[0]!,
          { ...validTeam().members[1]!, agentRef: { source: 'catalog', slug: 'legacy-only' } },
        ],
      },
    })
    expect(updated).toMatchObject({ ok: true, team: { name: '合规审查二队' } })
    const detail = await routes.get({ query: new URLSearchParams({ id: created.team.id }) })
    expect(detail.availability).toMatchObject({ kind: 'member-invalid', invocable: false })
    writeFileSync(join(profileDir, 'expert-teams', `${created.team.id}.json`), '{broken', 'utf8')
    await expect(routes.update({ body: { id: created.team.id, name: '不应保存' } })).rejects.toThrow(
      'expert-team-corrupt',
    )
    const corrupt = await routes.get({ query: new URLSearchParams({ id: created.team.id }) })
    expect(corrupt).toMatchObject({
      id: created.team.id,
      error: 'expert-team-corrupt',
      availability: { kind: 'incomplete', invocable: false },
    })
    // 损坏定义允许显式删除（不受 fail-closed 读路径影响）。
    await expect(routes.remove({ body: { id: created.team.id } })).resolves.toEqual({ removed: true })
  })

  it('toggles definitions, broadcasts changes and exposes only enabled invocable teams to @ completion', async () => {
    const { events, routes } = await makeExpertTeamRouteFixture()
    const created = await routes.create({ body: validTeamInput() })
    if (!created.ok) throw new Error('expected create to succeed')
    expect(events).toContainEqual({ event: 'expertTeam/changed', teamId: created.team.id })
    expect((await routes.invocableList()).teams.map((team) => team.id)).toEqual([created.team.id])
    const disabled = await routes.setEnabled({ body: { id: created.team.id, enabled: false } })
    expect(disabled.team.enabled).toBe(false)
    expect(events.filter((event) => event.event === 'expertTeam/changed')).toHaveLength(2)
    expect((await routes.invocableList()).teams).toEqual([])
    const detail = await routes.get({ query: new URLSearchParams({ id: created.team.id }) })
    expect(detail.availability).toMatchObject({ kind: 'disabled', invocable: false })
  })

  it('cancels only by parent session and run id, mapping unknown or cross-session runs to 404', async () => {
    const { runs, routes } = await makeExpertTeamRouteFixture()
    const created = await routes.create({ body: validTeamInput() })
    if (!created.ok) throw new Error('expected create to succeed')
    const run = runs.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: created.team })
    await expect(
      routes.cancel({ body: { parentSessionId: 'other', teamRunId: run.teamRunId } }),
    ).rejects.toMatchObject({ status: 404, code: 'expert-team-run-not-found' })
    await expect(
      routes.cancel({ body: { parentSessionId: 's1', teamRunId: randomUUID() } }),
    ).rejects.toMatchObject({ status: 404, code: 'expert-team-run-not-found' })
    await expect(routes.cancel({ body: { teamRunId: run.teamRunId } })).rejects.toMatchObject({ status: 400 })
    expect(await routes.cancel({ body: { parentSessionId: 's1', teamRunId: run.teamRunId } })).toEqual({
      status: 'accepted',
      teamRunId: run.teamRunId,
    })
  })
})

describe('expert team route registry', () => {
  it('registers exactly nine expertTeam routes inside the shared table', () => {
    const registered = ROUTE_TABLE.filter((route) => route.method.startsWith('expertTeam.'))
    expect(registered.map((route) => route.method).sort()).toEqual([
      'expertTeam.cancel',
      'expertTeam.create',
      'expertTeam.get',
      'expertTeam.invocableList',
      'expertTeam.list',
      'expertTeam.remove',
      'expertTeam.runList',
      'expertTeam.setEnabled',
      'expertTeam.update',
    ])
  })
})
