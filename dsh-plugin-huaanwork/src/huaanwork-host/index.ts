import './holders.ts'

export const name = 'huaanwork-host'
export const inject = ['webServer']

export interface HuaanworkHostConfig {
  dshHome?: string
  profileDir?: string
  workspaceRoot?: string
}

export function apply(ctx: any, config?: HuaanworkHostConfig) {
  if (config?.workspaceRoot) ctx.huaanworkWorkspaceRoot = config.workspaceRoot
  if (config?.dshHome) ctx.huaanworkDshHome = config.dshHome
  if (config?.profileDir) ctx.huaanworkProfileDir = config.profileDir
  ctx.huaanworkAllowedOnce ??= new Set<string>()
  ctx.huaanworkApprovals ??= new Map()
  ctx.huaanworkUnattended ??= { current: null }
  ctx.huaanworkAttachments ??= { sessionHostTools: new Map(), sessionAgentTools: new Map() }
  ctx.huaanworkAgentRequest ??= { current: null }
  ctx.huaanworkAgentCatalog ??= { current: { items: [] } }
}
