import type { AgentPackageToolsMode } from '@huaanwork/agent-package-format/manifest'

export {
  AGENT_PACKAGE_SCHEMA_VERSION,
  type AgentPackageManifest,
  type AgentPackageToolsMode,
} from '@huaanwork/agent-package-format/manifest'

export type AgentPackageSource = 'local' | 'catalog'

/** 本地包的发布状态;`installed` 只用于从广场安装的签名包。 */
export type AgentPackagePublishStatus =
  | 'none'
  | 'pending-review'
  | 'published'
  | 'rejected'
  | 'delisted'
  | 'installed'

/**
 * 一条目录撤销记录。与服务端 Revocation 的客户端字段一致:服务端的 `actor`
 * 只用于审计,不进入桌面状态。
 */
export type AgentPackageRevocation = {
  slug: string
  version: string
  reason: string
  revokedAt: string
}

/** `agents-state.json` 的一条。M2 可选字段在 M1 创建的条目上可以缺席。 */
export type AgentPackageStateEntry = {
  source: AgentPackageSource
  enabled: boolean
  installedVersion: string
  publishStatus?: AgentPackagePublishStatus
  publishedVersion?: string
  submissionId?: string
  reviewReason?: string
  delistRequestId?: string
  revoked?: AgentPackageRevocation
}

export type AgentPackageState = Record<string, AgentPackageStateEntry>

export type AgentPackageListItem = {
  slug: string
  displayName: string
  description: string
  version: string
  source: AgentPackageSource
  enabled: boolean
  broken?: { reason: string }
  publishStatus?: AgentPackagePublishStatus
  publishedVersion?: string
  submissionId?: string
  reviewReason?: string
  delistRequestId?: string
  revoked?: AgentPackageRevocation
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
  /**
   * 本回合在统一子代理 run 登记表里的 id(Task 5)。
   *
   * `skills.ts` 的 activation 包装据此把上游 start/end 归属到同一张运行卡
   * (Task 6),不在包装里另建卡或按 slug 猜。
   */
  runId: string
  allow: string[]
  persona: string
  runtime: AgentPackageTurnRuntime
  /** 发起这次回合的用户会话;`skills.ts` 只在这个 parent 的子代理上套用包工具名单。 */
  parentSessionId: string
  /**
   * activation 之前预留的子会话 id。工具与运行时登记都按它预先完成,所以子代理的
   * 首条模型请求就已带上 `agent_http`/`agent_skill_run`/MCP 名;`skills.ts` 的包装
   * 只对同一个 id 再绑一次(幂等)。provider 另分配 id 时包装跳过包分支,由 host 的
   * post-return re-attach 补挂工具与登记(不重放 allow restrict)。
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
