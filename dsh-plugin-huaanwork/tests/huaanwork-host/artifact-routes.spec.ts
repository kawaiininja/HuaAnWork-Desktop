import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import type { RpcEvent, TaskArtifactSummary } from '../../src/client-huaanwork/rpc-types.ts'
import { createArtifact, type ArtifactInput } from '../../src/huaanwork-host/artifacts-host.ts'
import { ROUTE_TABLE, RouteError, type RouteContext } from '../../src/huaanwork-host/routes.ts'
import type { ArtifactNativeCapability } from '../../src/runtime.ts'

/** 最小 RouteContext 夹具(与 agent-package-creation.spec.ts 的同名夹具一致)。 */
function makeRouteCtx(
  root: string,
  events: RpcEvent[],
  artifactNative?: ArtifactNativeCapability,
): RouteContext {
  return {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: (event) => events.push(event),
    logger: () => undefined,
    requestRestart: async () => true,
    ...(artifactNative === undefined ? {} : { artifactNative }),
  }
}

function makeArtifactNative() {
  return {
    openArtifactFullscreen: vi.fn<ArtifactNativeCapability['openArtifactFullscreen']>(async () => undefined),
    saveArtifact: vi.fn<ArtifactNativeCapability['saveArtifact']>(async () => ({ saved: false })),
    prepareArtifactFrame: vi.fn<ArtifactNativeCapability['prepareArtifactFrame']>(async () => undefined),
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

/** POST 调用器:body 走 JSON 解析后的对象,与 webserver 装配一致。 */
async function callPost<T>(method: string, routeCtx: RouteContext, body: unknown): Promise<T> {
  const route = ROUTE_TABLE.find((item) => item.method === method)
  if (!route) throw new Error(`missing route ${method}`)
  const result = await route.handler({ params: {}, body, query: new URLSearchParams() }, routeCtx)
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

describe('artifact 原生能力路由', () => {
  const FRAME_NAME = 'huaanwork-artifact-11111111-1111-4111-8111-111111111111'

  test('三条 POST 按固定路径登记', () => {
    const expected: Record<string, string> = {
      'artifact.openFullscreen': '/huaanwork/artifact/openFullscreen',
      'artifact.download': '/huaanwork/artifact/download',
      'artifact.prepareFrame': '/huaanwork/artifact/prepareFrame',
    }
    for (const [method, path] of Object.entries(expected)) {
      const route = ROUTE_TABLE.find((item) => item.method === method)
      expect(route?.http).toBe('POST')
      expect(route?.path).toBe(path)
    }
  })

  test('download 使用宿主 summary.downloadName 与原字节,原生侧保持纯透传', async () => {
    const profileDir = profileDirFixture()
    const native = makeArtifactNative()
    const routeCtx = makeRouteCtx(profileDir, [], native)
    const content = '<h1>结果</h1><p>正文 😀 中文</p>'
    const artifact = await createArtifact(profileDir, {
      sessionId,
      title: '结果',
      format: 'html',
      content,
      downloadName: '结果.txt',
      anchor: { kind: 'turn' },
      idempotency: { kind: 'tool', callId: 'native-download-1' },
    })

    await expect(callPost('artifact.download', routeCtx, {
      sessionId,
      artifactId: artifact.artifactId,
      surface: 'main',
    })).resolves.toEqual({ saved: false })
    expect(native.saveArtifact).toHaveBeenCalledExactlyOnceWith({
      downloadName: '结果.html',
      contentBase64: expect.any(String),
      surface: 'main',
    })
    const saved = native.saveArtifact.mock.calls[0]![0] as { contentBase64: string }
    expect(Buffer.from(saved.contentBase64, 'base64').toString('utf8')).toBe(content)
  })

  test('openFullscreen 校验归属并传递完整 ArtifactRef', async () => {
    const profileDir = profileDirFixture()
    const native = makeArtifactNative()
    const routeCtx = makeRouteCtx(profileDir, [], native)
    const artifact = await createArtifact(profileDir, artifactInput('native-open-1'))

    await expect(callPost('artifact.openFullscreen', routeCtx, {
      sessionId,
      artifactId: artifact.artifactId,
    })).resolves.toEqual({ opened: true })
    expect(native.openArtifactFullscreen).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      artifactId: artifact.artifactId,
    })

    await expect(callPost('artifact.openFullscreen', routeCtx, {
      sessionId: 'other',
      artifactId: artifact.artifactId,
    })).rejects.toThrow('artifact-not-found')
    await expect(callPost('artifact.openFullscreen', routeCtx, { sessionId }))
      .rejects.toThrow('artifact.openFullscreen requires body.artifactId')
  })

  test('prepareFrame 只传 surface/frameName 并返回 prepared', async () => {
    const profileDir = profileDirFixture()
    const native = makeArtifactNative()
    const routeCtx = makeRouteCtx(profileDir, [], native)
    const artifact = await createArtifact(profileDir, artifactInput('native-frame-1'))

    await expect(callPost('artifact.prepareFrame', routeCtx, {
      sessionId,
      artifactId: artifact.artifactId,
      surface: 'artifact',
      frameName: FRAME_NAME,
    })).resolves.toEqual({ prepared: true })
    expect(native.prepareArtifactFrame).toHaveBeenCalledExactlyOnceWith({
      surface: 'artifact',
      frameName: FRAME_NAME,
    })
  })

  test('严格校验 surface 与 frameName', async () => {
    const profileDir = profileDirFixture()
    const routeCtx = makeRouteCtx(profileDir, [], makeArtifactNative())
    const artifact = await createArtifact(profileDir, artifactInput('native-invalid-1'))
    const base = { sessionId, artifactId: artifact.artifactId }

    for (const body of [
      { ...base },
      { ...base, surface: 'window' },
      { ...base, surface: 1 },
    ]) {
      await expect(callPost('artifact.download', routeCtx, body)).rejects.toMatchObject({
        status: 400,
        code: 'bad-request',
      })
      await expect(callPost('artifact.prepareFrame', routeCtx, { ...body, frameName: FRAME_NAME }))
        .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    }
    for (const frameName of [undefined, 'huaanwork-artifact-nope', `${FRAME_NAME}\n`, 7]) {
      await expect(callPost('artifact.prepareFrame', routeCtx, { ...base, surface: 'main', frameName }))
        .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    }
  })

  test('缺少原生能力时三条路由都报 artifact-native-unavailable', async () => {
    const profileDir = profileDirFixture()
    const routeCtx = makeRouteCtx(profileDir, [])
    const artifact = await createArtifact(profileDir, artifactInput('native-missing-1'))
    const base = { sessionId, artifactId: artifact.artifactId }

    for (const [method, body] of [
      ['artifact.openFullscreen', base],
      ['artifact.download', { ...base, surface: 'main' }],
      ['artifact.prepareFrame', { ...base, surface: 'main', frameName: FRAME_NAME }],
    ] as const) {
      const error = await callPost(method, routeCtx, body).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(RouteError)
      expect(error).toMatchObject({ status: 503, code: 'artifact-native-unavailable' })
    }
  })
})
