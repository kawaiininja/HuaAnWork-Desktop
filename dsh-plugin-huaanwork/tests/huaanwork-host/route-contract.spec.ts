import { describe, expect, test } from 'vitest'
import { ROUTES } from '../../src/client-huaanwork/api.ts'
import { ROUTE_TABLE, type RouteTableEntry } from '../../src/huaanwork-host/routes.ts'

/**
 * 路由契约跨端交叉测试 (M3 评审 D6):
 * 验证客户端 ROUTES (src/client-huaanwork/api.ts) 与
 * 宿主侧 ROUTE_TABLE (src/huaanwork-host/routes.ts) 之间的 54 个方法在
 * HTTP Method、Path 与返回载荷键集上的严格双向一致性。
 */

/**
 * 可选响应键白名单。
 * 这些字段在某些分支场景下返回 (如重启中携带 restarting, 认证携带 username, 目录拉取失败携带 catalogError)。
 */
export const OPTIONAL_KEYS_WHITELIST: Record<string, string[]> = {
  'workspace.open': ['restarting'],
  'workspace.close': ['restarting'],
  'project.open': ['restarting'],
  'plugin.add': ['restarting'],
  'plugin.remove': ['restarting'],
  'auth.status': ['username'],
  'auth.register': ['username'],
  'auth.login': ['username'],
  'auth.logout': ['username'],
  'agent.list': ['catalogError'],
  'agent.refresh': ['catalogError'],
}

/**
 * 16 个 501 路由在后续任务实现后的目标业务必选键集合。
 * 按 Task 0 Step 1 与评审 P3-4、旧 host.ts/skills-host.ts 应答行钉死:
 * - plugin.add/remove: ['bundles'] (restarting 列入可选键白名单, bundles 为必含键)
 * - automation.run: ['queued', 'runId'] (旧 host.ts:1114)
 * - automation.pruneSessions: ['removed'] (旧 host.ts:1131)
 * - skill.importPreview: ['targetName', 'nameMismatch', 'kind'] (旧 skills-host.ts:279)
 * - skill.create/update/import: ['skill'] (SkillWriteResult)
 * - agent.addEndpoint: ['agent'] (AgentWriteResult)
 * - agent.setEnabled/removeEndpoint: ['ok']
 * - skill.setEnabled: ['ok']
 * - automation.create/update: ['automation']
 * - automation.remove: ['removed']
 * - skill.remove: ['removed']
 */
export const TARGET_BUSINESS_REQUIRED_KEYS: Record<string, string[]> = {
  'plugin.add': ['bundles'],
  'plugin.remove': ['bundles'],
  'skill.create': ['skill'],
  'skill.update': ['skill'],
  'skill.remove': ['removed'],
  'skill.importPreview': ['targetName', 'nameMismatch', 'kind'],
  'skill.import': ['skill'],
  'skill.setEnabled': ['ok'],
  'agent.setEnabled': ['ok'],
  'agent.addEndpoint': ['agent'],
  'agent.removeEndpoint': ['ok'],
  'automation.create': ['automation'],
  'automation.update': ['automation'],
  'automation.remove': ['removed'],
  'automation.run': ['queued', 'runId'],
  'automation.pruneSessions': ['removed'],
}

/** 54 个方法中 16 个处于 501 notImplemented 状态的方法集合。 */
export const METHODS_501 = new Set([
  'plugin.add',
  'plugin.remove',
  'skill.create',
  'skill.update',
  'skill.remove',
  'skill.importPreview',
  'skill.import',
  'skill.setEnabled',
  'agent.setEnabled',
  'agent.addEndpoint',
  'agent.removeEndpoint',
  'automation.create',
  'automation.update',
  'automation.remove',
  'automation.run',
  'automation.pruneSessions',
])

/** 客户端 54 个方法调用期望的真实必选字段集合 (包含 16 个 501 路由的真实业务期望键)。 */
export const CLIENT_REQUIRED_KEYS: Record<string, string[]> = {
  // workspace
  'workspace.open': ['workspaceRoot'],
  'workspace.close': ['workspaceRoot'],

  // session
  'session.send': ['ok'],
  'session.cancel': ['ok'],
  'session.approve': ['ok'],
  'session.reject': ['ok'],
  'session.list': ['sessions'],
  'session.open': ['records'],
  'session.remove': ['removed'],
  'session.new': ['sessionId'],
  'session.resume': ['ok'],

  // settings
  'settings.get': [
    'theme',
    'models',
    'allow_network',
    'guard_mode',
    'automation_timeout_ms',
    'keep_awake',
    'agents_host',
    'agents_port',
    'agents_catalog_token',
    'base_url',
    'model',
    'api_key',
    'active_model_id',
  ],
  'settings.set': [
    'theme',
    'models',
    'allow_network',
    'guard_mode',
    'automation_timeout_ms',
    'keep_awake',
    'agents_host',
    'agents_port',
    'agents_catalog_token',
    'base_url',
    'model',
    'api_key',
    'active_model_id',
  ],

  // auth
  'auth.status': ['loggedIn', 'registered'],
  'auth.register': ['loggedIn', 'registered'],
  'auth.login': ['loggedIn', 'registered'],
  'auth.logout': ['loggedIn', 'registered'],
  'auth.changePassword': ['ok'],

  // plugin
  'plugin.add': ['bundles'], // 501
  'plugin.remove': ['bundles'], // 501
  'plugin.list': ['plugins'],

  // skill
  'skill.list': ['skills'],
  'skill.get': ['skill'],
  'skill.create': ['skill'], // 501
  'skill.update': ['skill'], // 501
  'skill.remove': ['removed'], // 501
  'skill.importPreview': ['targetName', 'nameMismatch', 'kind'], // 501
  'skill.import': ['skill'], // 501
  'skill.setEnabled': ['ok'], // 501

  // agent
  'agent.list': ['items'],
  'agent.get': [], // returns AgentInfo | null
  'agent.refresh': ['items'],
  'agent.setEnabled': ['ok'], // 501
  'agent.addEndpoint': ['agent'], // 501
  'agent.removeEndpoint': ['ok'], // 501

  // status
  'status.get': ['ready'],

  // project
  'project.list': ['projects'],
  'project.create': ['project'],
  'project.open': ['project', 'workspaceRoot'],
  'project.remove': ['removed', 'project'],
  'project.rename': ['project'],

  // automation
  'automation.list': ['automations', 'runs', 'missed'],
  'automation.create': ['automation'], // 501
  'automation.update': ['automation'], // 501
  'automation.remove': ['removed'], // 501
  'automation.run': ['queued', 'runId'], // 501
  'automation.runs': ['runs'],
  'automation.pruneSessions': ['removed'], // 501
  'automation.templates': ['templates'],

  // task
  'task.list': ['tasks'],
  'task.create': ['task'],
  'task.remove': ['removed'],
  'task.bindSession': ['task'],
  'task.rename': ['task'],
}

/**
 * 服务端各方法 handler 真实返回载荷的已知字段集合。
 * 38 条已实现路由为其真实载荷键 (含白名单内的可选字段);
 * 16 条 501 路由在当前 Task 0 阶段期望为 ['error'] 信封。
 */
export const SERVER_EXPECTED_KEYS: Record<string, string[]> = {
  // workspace
  'workspace.open': ['workspaceRoot', 'restarting'],
  'workspace.close': ['workspaceRoot', 'restarting'],

  // session
  'session.send': ['ok'],
  'session.cancel': ['ok'],
  'session.approve': ['ok'],
  'session.reject': ['ok'],
  'session.list': ['sessions'],
  'session.open': ['records'],
  'session.remove': ['removed'],
  'session.new': ['sessionId'],
  'session.resume': ['ok'],

  // settings
  'settings.get': [
    'theme',
    'models',
    'allow_network',
    'guard_mode',
    'automation_timeout_ms',
    'keep_awake',
    'agents_host',
    'agents_port',
    'agents_catalog_token',
    'base_url',
    'model',
    'api_key',
    'active_model_id',
  ],
  'settings.set': [
    'theme',
    'models',
    'allow_network',
    'guard_mode',
    'automation_timeout_ms',
    'keep_awake',
    'agents_host',
    'agents_port',
    'agents_catalog_token',
    'base_url',
    'model',
    'api_key',
    'active_model_id',
  ],

  // auth
  'auth.status': ['loggedIn', 'registered', 'username'],
  'auth.register': ['loggedIn', 'registered', 'username'],
  'auth.login': ['loggedIn', 'registered', 'username'],
  'auth.logout': ['loggedIn', 'registered', 'username'],
  'auth.changePassword': ['ok'],

  // plugin
  'plugin.add': ['error'],
  'plugin.remove': ['error'],
  'plugin.list': ['plugins'],

  // skill
  'skill.list': ['skills'],
  'skill.get': ['skill'],
  'skill.create': ['error'],
  'skill.update': ['error'],
  'skill.remove': ['error'],
  'skill.importPreview': ['error'],
  'skill.import': ['error'],
  'skill.setEnabled': ['error'],

  // agent
  'agent.list': ['items', 'catalogError'],
  'agent.get': [],
  'agent.refresh': ['items', 'catalogError'],
  'agent.setEnabled': ['error'],
  'agent.addEndpoint': ['error'],
  'agent.removeEndpoint': ['error'],

  // status
  'status.get': ['ready'],

  // project
  'project.list': ['projects'],
  'project.create': ['project'],
  'project.open': ['project', 'workspaceRoot', 'restarting'],
  'project.remove': ['removed', 'project'],
  'project.rename': ['project'],

  // automation
  'automation.list': ['automations', 'runs', 'missed'],
  'automation.create': ['error'],
  'automation.update': ['error'],
  'automation.remove': ['error'],
  'automation.run': ['error'],
  'automation.runs': ['runs'],
  'automation.pruneSessions': ['error'],
  'automation.templates': ['templates'],

  // task
  'task.list': ['tasks'],
  'task.create': ['task'],
  'task.remove': ['removed'],
  'task.bindSession': ['task'],
  'task.rename': ['task'],
}

/** 契约对比核心函数: 严格断言 HTTP 动词、Path 以及双端必含键集合双向严格相等。 */
export function verifyMethodContract(
  method: string,
  clientRoute: { http: string; path: string },
  serverRoute: RouteTableEntry,
  clientKeys: string[],
  serverKeys: string[],
  optionalWhitelist: string[] = [],
): void {
  if (clientRoute.http !== serverRoute.http) {
    throw new Error(
      `[Route Contract] Method ${method} HTTP verb mismatch: client=${clientRoute.http}, server=${serverRoute.http}`,
    )
  }
  if (clientRoute.path !== serverRoute.path) {
    throw new Error(
      `[Route Contract] Method ${method} path mismatch: client=${clientRoute.path}, server=${serverRoute.path}`,
    )
  }

  // 剔除白名单内的可选键后, 两侧必含 key 集合必须严格双向相等 (禁止单向宽松子集检查)
  const serverRequiredKeys = serverKeys.filter((k) => !optionalWhitelist.includes(k))
  const clientKeySet = new Set(clientKeys)
  const serverKeySet = new Set(serverRequiredKeys)

  if (clientKeySet.size !== serverKeySet.size || ![...clientKeySet].every((k) => serverKeySet.has(k))) {
    const missingInServer = [...clientKeySet].filter((k) => !serverKeySet.has(k))
    const missingInClient = [...serverKeySet].filter((k) => !clientKeySet.has(k))
    throw new Error(
      `[Route Contract] Method ${method} required key set bidirectional mismatch:\n` +
      `  Client keys: [${[...clientKeySet].sort().join(', ')}]\n` +
      `  Server required keys (excl. whitelist): [${[...serverKeySet].sort().join(', ')}]\n` +
      (missingInServer.length > 0 ? `  Extra in client / missing in server: [${missingInServer.join(', ')}]\n` : '') +
      (missingInClient.length > 0 ? `  Extra in server / missing in client: [${missingInClient.join(', ')}]\n` : ''),
    )
  }
}

describe('Route Contract Cross-Test (D6)', () => {
  test('双端方法总数恰好 54 且集合完全一致', () => {
    const clientMethods = Object.keys(ROUTES).sort()
    const serverMethods = ROUTE_TABLE.map((r) => r.method).sort()

    expect(clientMethods.length).toBe(54)
    expect(serverMethods.length).toBe(54)
    expect(clientMethods).toEqual(serverMethods)
  })

  test('38 条已实现路由逐方法比对: HTTP 动词、Path 与必含键集合严格双向相等 (Set 严格相等 + 可选键白名单)', () => {
    const serverRouteMap = new Map(ROUTE_TABLE.map((r) => [r.method, r]))

    for (const [method, clientRoute] of Object.entries(ROUTES)) {
      if (METHODS_501.has(method)) continue // 16 条 501 在专用测试中检验

      const serverRoute = serverRouteMap.get(method)
      expect(serverRoute).toBeDefined()
      if (!serverRoute) continue

      const clientKeys = CLIENT_REQUIRED_KEYS[method] ?? []
      const serverKeys = SERVER_EXPECTED_KEYS[method] ?? []
      const optionalKeys = OPTIONAL_KEYS_WHITELIST[method] ?? []

      // 严格落实 Set(clientRequiredKeys) == Set(serverExpectedKeys \ whitelist) 双向相等断言
      expect(() =>
        verifyMethodContract(
          method,
          clientRoute,
          serverRoute,
          clientKeys,
          serverKeys,
          optionalKeys,
        ),
      ).not.toThrow()
    }
  })

  test('16 条 501 路由契约比对: 服务端返回 error 信封, 客户端真实必含键与 TARGET_BUSINESS_REQUIRED_KEYS 严格双向相等', () => {
    const serverRouteMap = new Map(ROUTE_TABLE.map((r) => [r.method, r]))

    for (const method of METHODS_501) {
      const clientRoute = ROUTES[method]
      const serverRoute = serverRouteMap.get(method)
      expect(clientRoute).toBeDefined()
      expect(serverRoute).toBeDefined()
      if (!clientRoute || !serverRoute) continue

      // 1. HTTP 动词与 Path 严格匹配
      expect(clientRoute.http).toBe(serverRoute.http)
      expect(clientRoute.path).toBe(serverRoute.path)

      // 2. Task 0 状态下服务端当前期望键恒为 ['error']
      expect(SERVER_EXPECTED_KEYS[method]).toEqual(['error'])

      // 3. 客户端真实期望必含键与 TARGET_BUSINESS_REQUIRED_KEYS 严格双向相等 (无缝切换保证)
      const clientKeys = CLIENT_REQUIRED_KEYS[method] ?? []
      const targetKeys = TARGET_BUSINESS_REQUIRED_KEYS[method] ?? []
      expect(new Set(clientKeys)).toEqual(new Set(targetKeys))
    }
  })

  test('16 个 501 路由预留业务键 TARGET_BUSINESS_REQUIRED_KEYS 精确核验 (评审 P3-4 / 旧 host.ts 口径)', () => {
    expect(Object.keys(TARGET_BUSINESS_REQUIRED_KEYS).length).toBe(16)
    expect(METHODS_501.size).toBe(16)

    // 逐项严格断言评审审查要求的真实键名:
    expect(TARGET_BUSINESS_REQUIRED_KEYS['plugin.add']).toEqual(['bundles'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['plugin.remove']).toEqual(['bundles'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['automation.run']).toEqual(['queued', 'runId'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['automation.pruneSessions']).toEqual(['removed'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['skill.importPreview']).toEqual(['targetName', 'nameMismatch', 'kind'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['skill.create']).toEqual(['skill'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['skill.update']).toEqual(['skill'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['skill.import']).toEqual(['skill'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['agent.addEndpoint']).toEqual(['agent'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['skill.setEnabled']).toEqual(['ok'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['agent.setEnabled']).toEqual(['ok'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['agent.removeEndpoint']).toEqual(['ok'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['automation.create']).toEqual(['automation'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['automation.update']).toEqual(['automation'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['automation.remove']).toEqual(['removed'])
    expect(TARGET_BUSINESS_REQUIRED_KEYS['skill.remove']).toEqual(['removed'])
  })

  test('变异自证 (Mutation self-proof): 人为破坏契约必定触发断言失败', () => {
    const validServerRoute = ROUTE_TABLE.find((r) => r.method === 'session.send')!
    const validClientRoute = ROUTES['session.send']!
    const validWorkspaceOpen = ROUTES['workspace.open']!

    // 1. 变异 HTTP 动词 -> 抛错
    expect(() =>
      verifyMethodContract(
        'session.send',
        { http: 'GET', path: validClientRoute.path },
        validServerRoute,
        ['ok'],
        ['ok'],
      ),
    ).toThrow(/HTTP verb mismatch/)

    // 2. 变异 Path -> 抛错
    expect(() =>
      verifyMethodContract(
        'session.send',
        { http: validClientRoute.http, path: '/huaanwork/session/wrong-path' },
        validServerRoute,
        ['ok'],
        ['ok'],
      ),
    ).toThrow(/path mismatch/)

    // 3. 客户端多出依赖键 (单向宽松子集检查遗漏场景) -> 必须抛出双向不匹配错误
    expect(() =>
      verifyMethodContract(
        'session.send',
        validClientRoute,
        validServerRoute,
        ['ok', 'phantomClientKey'],
        ['ok'],
      ),
    ).toThrow(/bidirectional mismatch/)

    // 4. 服务端多出必选键 (客户端未消费/未声明场景) -> 必须抛出双向不匹配错误
    expect(() =>
      verifyMethodContract(
        'session.send',
        validClientRoute,
        validServerRoute,
        ['ok'],
        ['ok', 'phantomServerKey'],
      ),
    ).toThrow(/bidirectional mismatch/)

    // 5. 白名单内可选键不会误报
    expect(() =>
      verifyMethodContract(
        'workspace.open',
        validWorkspaceOpen,
        ROUTE_TABLE.find((r) => r.method === 'workspace.open')!,
        ['workspaceRoot'],
        ['workspaceRoot', 'restarting'],
        ['restarting'],
      ),
    ).not.toThrow()
  })
})
