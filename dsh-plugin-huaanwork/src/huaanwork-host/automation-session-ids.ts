/** 自动化运行会话 id 前缀(级联删除用):`huaanwork-auto-<automationId>-<suffix>`。(旧 automations.ts:30 逐字) */
export const AUTO_SESSION_PREFIX = 'huaanwork-auto-'
/** 旧 chat 通道自动化运行会话前缀(仅清扫用,不再铸造):`huaanwork-chat-auto-<automationId>-<suffix>`。(旧 automations.ts:32 逐字) */
export const LEGACY_CHAT_AUTO_SESSION_PREFIX = 'huaanwork-chat-auto-'

/** 运行会话 id 铸造的唯一入口:一律 `huaanwork-auto-<automationId>-<runId>`。(旧 automations.ts:36 逐字) */
export function automationRunSessionId(automationId: string, runId: string): string {
  return `${AUTO_SESSION_PREFIX}${automationId}-${runId}`
}

/** 会话目录名是否自动化运行会话(`huaanwork-auto-`)。(旧 automations.ts:41 逐字) */
export function isAutomationSessionEntry(entry: string): boolean {
  return entry.startsWith(AUTO_SESSION_PREFIX)
}
