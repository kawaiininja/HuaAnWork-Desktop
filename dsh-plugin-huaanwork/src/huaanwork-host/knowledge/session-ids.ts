/**
 * 知识库整理槽的会话 id 前缀(规格 §8.1 / M1-2 Task 1)。
 *
 * 每库固定单槽 `huaanwork-kb-org-<kbId>`,没有每批一个 runId:同一库复用同一
 * SessionId 槽位,批次之间 `dispose` 并删日志后重新 `create`。前缀是本模块唯一来源;
 * 客户端侧 `client-huaanwork/logic/sessionChannel.ts` 按既有 `AUTO_SESSION_PREFIX`
 * 惯例独立声明同一字面量(两端进程隔离,不能互相 import)。
 */
export const KB_ORG_SESSION_PREFIX = 'huaanwork-kb-org-'

/** 整理槽会话 id 的唯一铸造入口。 */
export function kbOrganizeSessionId(kbId: string): string {
  return `${KB_ORG_SESSION_PREFIX}${kbId}`
}

/**
 * 会话 id 是否属于知识库整理槽。
 *
 * 不做成 `id is string` 谓词:调用点常已持有 `string`,谓词会在 else 分支把它收窄成
 * `never`,对 `writableRootForSession` 这类纯字符串参数反而制造假类型。
 */
export function isKbOrganizeSessionId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(KB_ORG_SESSION_PREFIX)
}

/** 从整理槽会话 id 取回 kbId;非整理槽或空 kbId 返回 undefined(调用方 fail closed)。 */
export function kbIdFromOrganizeSessionId(id: string): string | undefined {
  if (!id.startsWith(KB_ORG_SESSION_PREFIX)) return undefined
  const kbId = id.slice(KB_ORG_SESSION_PREFIX.length)
  return kbId.length > 0 ? kbId : undefined
}
