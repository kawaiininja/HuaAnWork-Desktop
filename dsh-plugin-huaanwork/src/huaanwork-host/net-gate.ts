import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { parentSessionOf } from './child-sessions.ts'
import { resolveSessionModel, type SessionModelTable } from './session-models.ts'
import { readHuaanworkSettingsSync, type AppSettings } from './settings.ts'
import type { RouteContext } from './routes.ts'

/** 会话绑定表由宿主登记(Task 6);Context 类型尚未声明时按窄交叉类型读取。 */
type NetworkGateContext = Context & { huaanworkSessionModels?: SessionModelTable }

export type StreamNetworkGateOptions = {
  /** 本次流的会话;缺省时按全局 settings 门禁(与旧行为一致)。 */
  sessionId?: string | undefined
  /** 同一张会话模型绑定表;缺省按无绑定处理。 */
  table?: SessionModelTable | undefined
  parentOf?: ((sessionId: string) => string | undefined) | undefined
}

/**
 * 模型流层联网门禁(兜底,旧 host.ts:1349 逐字移植):
 * llm/stream 层一律按本次会话绑定的端点门禁,覆盖子代理、标题生成等不经 sendToAgent
 * 前置校验的路径(AGENTS.md 不变式 9 的第二道闸)。
 * 绑定在表里时用该条目的 base_url,无绑定才用 settings 的全局端点;
 * `allow_network` 始终来自当前设置。
 */
export function assertStreamNetworkAllowed(
  settings: AppSettings,
  options: StreamNetworkGateOptions = {},
): void {
  const resolved = resolveSessionModel({
    sessionId: options.sessionId,
    table: options.table ?? new Map(),
    models: settings.models,
    active: { base_url: settings.base_url, model: settings.model, api_key: settings.api_key },
    allowNetwork: settings.allow_network,
    parentOf: options.parentOf,
  })
  if (!resolved.ok) throw new Error(resolved.reason)
}

/**
 * 统一网络门禁第二层:allow_network=off 时 llm/stream 只允许会话绑定端点(或全局端点)
 * 落在 LAN。安装为全局前置监听(global 覆盖子代理/标题生成等 scoped 流;prepend 保证
 * 先于 adapter 的 stream 监听执行)——旧 host.ts:1748-1768 的 { global: true } 语义
 * 与计划的 prepend 指示合并。
 */
export function installNetworkGate(ctx: Context, routeCtx: RouteContext): void {
  ctx.on(
    'llm/stream',
    ((options: GenerateOptions, next: (options: GenerateOptions) => unknown) => {
      assertStreamNetworkAllowed(readHuaanworkSettingsSync(routeCtx.profileDir), {
        sessionId: options.sessionId,
        table: (ctx as NetworkGateContext).huaanworkSessionModels,
        parentOf: parentSessionOf,
      })
      return next(options)
    }) as never,
    { global: true, prepend: true },
  )
}
