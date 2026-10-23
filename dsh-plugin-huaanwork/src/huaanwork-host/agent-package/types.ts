export const AGENT_PACKAGE_SCHEMA_VERSION = 1 as const

export type AgentPackageToolsMode = 'none' | 'http' | 'mcp' | 'both'

export type AgentPackageManifest = {
  schemaVersion: typeof AGENT_PACKAGE_SCHEMA_VERSION
  slug: string
  displayName: string
  description: string
  version: string
  draftId: string
  createdAt: string
  updatedAt: string
  persona: 'persona.md'
  skill: { entry: 'skill/SKILL.md'; summary: string } | null
  tools: {
    mode: AgentPackageToolsMode
    http?: { entry: 'tools/http/server.mjs'; argumentsSchema?: unknown }
    mcp?: { entry: 'tools/mcp/server.mjs' }
  }
  allowSkills: string[]
}

export type AgentPackageState = Record<string, { source: 'local'; enabled: boolean; installedVersion: string }>

export type AgentPackageListItem = {
  slug: string
  displayName: string
  description: string
  version: string
  source: 'local' | 'catalog-legacy'
  enabled: boolean
  broken?: { reason: string }
}

export type AgentPackageDetail = AgentPackageListItem & {
  persona: string
  skill: { summary: string; markdown: string; scripts: string[] } | null
  tools: AgentPackageToolsMode
  files: Array<{ path: string; size: number }>
}

export type AgentPackageTurnRuntime = {
  slug: string
  packageDir: string
  workspaceRoot: string
  httpPort?: number
  mcpNames?: string[]
  skillScripts: string[]
  runSkillScript(
    script: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError?: boolean }>
}

export type AgentPackageSubagentRequest = {
  allow: string[]
  persona: string
  runtime: AgentPackageTurnRuntime
  /** 发起这次回合的用户会话;`skills.ts` 只在这个 parent 的子代理上套用包工具名单。 */
  parentSessionId: string
  /**
   * activation 之前预留的子会话 id。工具与运行时登记都按它预先完成,所以子代理的
   * 首条模型请求就已带上 `agent_http`/`agent_skill_run`/MCP 名;`skills.ts` 的包装
   * 只在 activation 另分配了 id 时补绑,不重复绑定。
   */
  childId: string
  bindChild(sessionId: string): void
}

export type AgentPackageProposalInput = {
  mode: 'create' | 'update'
  displayName?: string
  slug?: string
  description?: string
  persona?: string
  personaSummary?: string
  skillSummary?: string
  skill?: { summary: string; markdown: string; scripts: Array<{ path: string; content: string }> } | null
  allowSkills?: string[]
  tools?: AgentPackageToolsMode
  httpServer?: string
  mcpServer?: string
}

export type AgentPackageConfirmCard = {
  mode: 'create' | 'update'
  displayName: string
  slug: string
  description: string
  personaSummary: string
  skillSummary: string
  tools: AgentPackageToolsMode
  toolLabel: string
  warning: string
  consentHint: string
}
