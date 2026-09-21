import type {
  AgentDetail,
  AgentKind,
  AgentListResult,
  AgentSource,
  AgentWriteResult,
  EntrypointKind,
} from '../client-huaanwork/rpc-types.ts'

/**
 * 智能体目录宿主(Task 7 子集):@agent 分发(agent-invoke.ts)只需要
 * list()/get() 两个读方法。AgentsHost 类型与旧 sidecar agents-host.ts:43-57
 * 逐字一致;真实目录实现(fetch 公用机目录 + 本地 endpoints + 快照同步)
 * 由 Task 10 按旧 agents-host.ts 全量移植并经 agent.list/get/refresh 路由暴露。
 * Task 10 接线时以 createAgentsHost(...) 替换 createUnavailableAgentsDirectory()
 * 并经 setAgentsDirectory() 注入(见 sessions.ts)。
 */

export type AgentCatalogSnapshot = {
  items: Array<{
    name: string
    source: AgentSource
    kind: AgentKind
    entrypointKind?: EntrypointKind
    enabled: boolean
    description: string
    broken?: { reason: string }
    entrypoint?: { kind: EntrypointKind; url: string }
    timeoutMs?: number
    argumentsSchema?: unknown
  }>
}

export type AgentsHost = {
  list(): AgentListResult
  refresh(): Promise<AgentListResult>
  get(name: string, source?: AgentSource): Promise<AgentDetail | undefined>
  setEnabled(name: string, enabled: boolean, confirmPermissions: boolean): void
  addEndpoint(input: {
    name: string
    kind: AgentKind
    entrypoint: { kind: EntrypointKind; url: string }
    description?: string
    argumentsSchema?: unknown
  }): AgentWriteResult
  removeEndpoint(name: string): void
  snapshotForRuntime(): AgentCatalogSnapshot
}

/**
 * M3 占位目录:空 catalog。行为与旧 sidecar「agents_host 未配置/拉取失败」一致——
 * @agent 分发对任意名字抛「智能体「x」未启用或不存在」,不静默假成功。
 * Task 10 用真实 createAgentsHost 替换(sessions.ts 的 setAgentsDirectory 挂点)。
 */
export function createUnavailableAgentsDirectory(): AgentsHost {
  const empty = { items: [] }
  return {
    list: () => empty,
    refresh: async () => empty,
    get: async () => undefined,
    setEnabled: (name) => {
      throw new Error(`智能体「${name}」目录不可用(M4 接入)`)
    },
    addEndpoint: (input) => ({
      ok: false as const,
      fieldErrors: [{ field: 'name', message: `智能体「${input.name}」目录不可用(M4 接入)` }],
    }),
    removeEndpoint: (name) => {
      throw new Error(`智能体「${name}」目录不可用(M4 接入)`)
    },
    snapshotForRuntime: () => ({ items: [] }),
  }
}
