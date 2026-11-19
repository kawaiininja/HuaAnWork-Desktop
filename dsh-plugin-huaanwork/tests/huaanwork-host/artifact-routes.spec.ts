import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import type { RpcEvent, TaskArtifactSummary } from '../../src/client-huaanwork/rpc-types.ts'
import { createArtifact, type ArtifactInput } from '../../src/huaanwork-host/artifacts-host.ts'
import { ROUTE_TABLE, type RouteContext } from '../../src/huaanwork-host/routes.ts'

/** 最小 RouteContext 夹具(与 agent-package-creation.spec.ts 的同名夹具一致)。 */
function makeRouteCtx(root: string, events: RpcEvent[]): RouteContext {
  return {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: (event) => events.push(event),
    logger: () => undefined,
    requestRestart: async () => true,
  }
}

const sessionId = 'session-1'

function artifactInput(callId: string): ArtifactInput {
  return {
    sessionId,
    title: '报告',
    format: 'markdown',
    content: '# 正文',
    anchor: { kind: 'turn' },
    idempotency: { kind: 'tool', callId },
  }
}

/** 真实 ROUTE_TABLE 调用器:GET 参数只经 query 传入,与 webserver 装配一致。 */
async function call<T>(method: string, routeCtx: RouteContext, params: Record<string, string>): Promise<T> {
  const route = ROUTE_TABLE.find((item) => item.method === method)
  if (!route) throw new Error(`missing route ${method}`)
  const result = await route.handler({ params: {}, body: undefined, query: new URLSearchParams(params) }, routeCtx)
  return result as T
}

const SUMMARY_KEYS = [
  'anchor',
  'artifactId',
  'createdAt',
  'downloadName',
  'format',
  'sessionId',
  'sha256',
  'sizeBytes',
  'title',
]

function profileDirFixture(): string {
  return mkdtempSync(join(tmpdir(), 'artifact-route-'))
}

describe('artifact 只读路由', () => {
  test('三条 GET 按固定路径登记', () => {
    const expected: Record<string, string> = {
      'artifact.get': '/huaanwork/artifact/get',
      'artifact.content': '/huaanwork/artifact/content',
      'artifact.list': '/huaanwork/artifact/list',
    }
    for (const [method, path] of Object.entries(expected)) {
      const route = ROUTE_TABLE.find((item) => item.method === method)
      expect(route?.http).toBe('GET')
      expect(route?.path).toBe(path)
    }
  })

  test('reads content only for the owning profile and session', async () => {
    const profileDir = profileDirFixture()
    const routeCtx = makeRouteCtx(profileDir, [])
    const artifact = await createArtifact(profileDir, artifactInput('route-call-1'))

    const got = await call<{ artifact: TaskArtifactSummary }>(
      'artifact.get',
      routeCtx,
      { sessionId, artifactId: artifact.artifactId },
    )
    expect(got.artifact.title).toBe('报告')
    expect(got.artifact.artifactId).toBe(artifact.artifactId)

    const read = await call<{ artifact: TaskArtifactSummary; content: string }>(
      'artifact.content',
      routeCtx,
      { sessionId, artifactId: artifact.artifactId },
    )
    expect(read.content).toBe('# 正文')
    expect(read.artifact.sha256).toBe(artifact.sha256)

    await expect(call('artifact.content', routeCtx, { sessionId: 'other', artifactId: artifact.artifactId }))
      .rejects.toThrow('artifact-not-found')

    // 存储根只取 routeCtx.profileDir:换一个 profile 就无法看到这条记录。
    const foreignCtx = makeRouteCtx(profileDirFixture(), [])
    await expect(call('artifact.get', foreignCtx, { sessionId, artifactId: artifact.artifactId }))
      .rejects.toThrow('artifact-not-found')
    await expect(call<{ artifacts: TaskArtifactSummary[] }>('artifact.list', foreignCtx, { sessionId }))
      .resolves.toEqual({ artifacts: [] })
  })

  test('list returns summaries only, ordered by createdAt/artifactId', async () => {
    const profileDir = profileDirFixture()
    const routeCtx = makeRouteCtx(profileDir, [])
    await createArtifact(profileDir, artifactInput('route-call-1'))
    await createArtifact(profileDir, { ...artifactInput('route-call-2'), title: '第二份', content: '# 第二份正文' })

    const listed = await call<{ artifacts: TaskArtifactSummary[] }>('artifact.list', routeCtx, { sessionId })
    expect(listed.artifacts).toHaveLength(2)
    for (const summary of listed.artifacts) {
      expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS)
    }
    expect(JSON.stringify(listed)).not.toContain('正文')

    const sorted = [...listed.artifacts].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
      if (left.artifactId === right.artifactId) return 0
      return left.artifactId < right.artifactId ? -1 : 1
    })
    expect(listed.artifacts).toEqual(sorted)

    // 单条 get 也只是摘要:正文只能经 content 取得。
    const got = await call<{ artifact: TaskArtifactSummary }>(
      'artifact.get',
      routeCtx,
      { sessionId, artifactId: listed.artifacts[0]!.artifactId },
    )
    expect(Object.keys(got.artifact).sort()).toEqual(SUMMARY_KEYS)
  })

  test('rejects missing query fields before touching storage', async () => {
    const routeCtx = makeRouteCtx(profileDirFixture(), [])
    await expect(call('artifact.get', routeCtx, { sessionId }))
      .rejects.toThrow('artifact.get requires params.artifactId')
    await expect(call('artifact.get', routeCtx, { artifactId: 'a-1' }))
      .rejects.toThrow('artifact.get requires params.sessionId')
    await expect(call('artifact.content', routeCtx, { sessionId }))
      .rejects.toThrow('artifact.content requires params.artifactId')
    await expect(call('artifact.content', routeCtx, {}))
      .rejects.toThrow('artifact.content requires params.sessionId')
    await expect(call('artifact.list', routeCtx, {}))
      .rejects.toThrow('artifact.list requires params.sessionId')
  })

  test('rejects traversal segments and unknown ids as artifact-not-found', async () => {
    const profileDir = profileDirFixture()
    const routeCtx = makeRouteCtx(profileDir, [])
    const artifact = await createArtifact(profileDir, artifactInput('route-call-1'))

    const rejected: Array<Record<string, string>> = [
      { sessionId: '..', artifactId: artifact.artifactId },
      { sessionId: '.', artifactId: artifact.artifactId },
      { sessionId, artifactId: '..' },
      { sessionId, artifactId: `../${sessionId}/${artifact.artifactId}` },
      { sessionId: `${sessionId}/../other`, artifactId: artifact.artifactId },
      { sessionId, artifactId: 'not-created' },
      { sessionId, artifactId: `${artifact.artifactId}/content.md` },
    ]
    for (const params of rejected) {
      await expect(call('artifact.get', routeCtx, params)).rejects.toThrow('artifact-not-found')
      await expect(call('artifact.content', routeCtx, params)).rejects.toThrow('artifact-not-found')
    }
  })
})
