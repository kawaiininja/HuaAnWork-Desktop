import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { workNetworkGateError } from '@huaanwork/policy/network'
import { readHuaanworkSettingsSync, type AppSettings } from './settings.ts'
import type { RouteContext } from './routes.ts'

/**
 * 模型流层联网门禁(兜底,旧 host.ts:1349 逐字移植):
 * llm/stream 层一律按 settings 门禁,覆盖子代理、标题生成等不经 sendToAgent
 * 前置校验的路径(AGENTS.md 不变式 9 的第二道闸)。
 * 定向改动:settingsPath → profileDir(Task 5 的 readHuaanworkSettingsSync);
 * 门禁判定本体逐字(workNetworkGateError 的 allow_network + base_url 输入)。
 */
export function assertStreamNetworkAllowed(settings: AppSettings): void {
  const blocked = workNetworkGateError({ allowNetwork: settings.allow_network, baseUrl: settings.base_url })
  if (blocked) throw new Error(blocked)
}

/**
 * 统一网络门禁第二层:allow_network=off 时 llm/stream 只允许 LAN 端点。
 * 安装为全局前置监听(global 覆盖子代理/标题生成等 scoped 流;prepend 保证先于
 * adapter 的 stream 监听执行)——旧 host.ts:1748-1768 的 { global: true } 语义
 * 与计划的 prepend 指示合并。
 */
export function installNetworkGate(ctx: Context, routeCtx: RouteContext): void {
  ctx.on(
    'llm/stream',
    ((options: GenerateOptions, next: (options: GenerateOptions) => unknown) => {
      assertStreamNetworkAllowed(readHuaanworkSettingsSync(routeCtx.profileDir))
      return next(options)
    }) as never,
    { global: true, prepend: true },
  )
}
