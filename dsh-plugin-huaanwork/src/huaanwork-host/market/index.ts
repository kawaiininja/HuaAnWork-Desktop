/**
 * huaanwork-market wrapper bundle 入口(M5 Task 4 骨架 → Task 5 消费面)。
 *
 * 消费面本体(catalog-client/verify/routes/install)由 Task 5 落位;本模块固化
 * 注入面与能力守卫,保证 package.json 的 ./huaanwork-market subpath export
 * 与 tsdown entry 有真实可加载产物(build/verify:closure 不空转),且
 * 选中 huaanwork-market provider 时组合出的 canonical row 能被 Loader 加载。
 *
 * 注入面(community-market src/index.ts:66-68 同构先例):
 * `profileDir` 经 `ctx.desktopProfiles.current.dir`、安装执行经
 * `ctx.desktopPnpm.runPlugin`、confirmed restart 经
 * `ctx.desktopRuntime.requestConfirmedRestart`——不依赖 row config 传
 * profileDir(DESKTOP_MARKET_IDENTITIES 无 config 注入机制,评审实证)。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConfirmedRestartRuntime } from '../../host-runtime-bridge.ts'
import type { DesktopPnpm } from '../../pnpm.ts'
import type { DesktopProfiles } from '../../profile-service.ts'
import { sweepOrphanMarketArtifacts } from './artifacts.ts'
import {
  HUAANWORK_MARKET_BUNDLE_NAME,
  resolveMarketOrigin,
} from './config.ts'
import { MARKET_ROUTE_LIST, registerMarketRoutes } from './routes.ts'

export {
  HUAANWORK_MARKET_BUNDLE_NAME,
  HUAANWORK_MARKET_SUBPATH_EXPORT,
  HUAANWORK_MARKET_DEFAULT_ORIGIN,
  HUAANWORK_MARKET_ORIGIN_ENV,
  HuaanworkMarketConfigError,
  resolveMarketOrigin,
  DEFAULT_MARKET_VERIFICATION_PINS,
  PINS_AT_RELEASE,
  assertMarketVerificationReady,
  usableMarketVerificationKeys,
  parsePinnedMarketKey,
  type MarketVerificationPins,
  type PinnedMarketVerificationKey,
  type PreviousMarketVerificationSlot,
} from './config.ts'

export const name = HUAANWORK_MARKET_BUNDLE_NAME
export const inject = ['webServer', 'desktopProfiles', 'desktopPnpm', 'desktopRuntime']

/**
 * 表外 routes 可测枚举清单(round3 R19 / 守则 5):恰 7 条,spec 断言逐一
 * 经 ctx.webServer 注册且总量恰 7。不进 ROUTE_TABLE / NATIVE_ROUTES(54 不破)。
 */
export const HUAANWORK_MARKET_ROUTES: readonly string[] = MARKET_ROUTE_LIST

export function apply(ctx: Context): void {
  // 能力守卫(参照 huaanwork-host/index.ts:51-57):inject 之外再窄化方法面——
  // 非 Electron Host(测试桩/第三方 Host)缺方法时抛具名错误,fail-closed,
  // 而不是裸 TypeError「requestConfirmedRestart is not a function」。
  const runtime = ctx.desktopRuntime as ConfirmedRestartRuntime
  if (typeof runtime?.requestConfirmedRestart !== 'function') {
    throw new Error('huaanwork-market: desktopRuntime 缺少 requestConfirmedRestart()(市场安装后的 confirmed restart 需要原生确认回传能力;请使用 ElectronDesktopRuntime)')
  }
  const profiles = ctx.desktopProfiles as DesktopProfiles | undefined
  if (profiles === null || typeof profiles !== 'object'
    || typeof profiles.current?.dir !== 'string' || profiles.current.dir.length === 0) {
    throw new Error('huaanwork-market: desktopProfiles 缺少 current.dir(市场制品落盘需要当前 profile 目录;请使用 Desktop 提供的 desktopProfiles 能力)')
  }
  const pnpm = ctx.desktopPnpm as DesktopPnpm | undefined
  if (pnpm === null || typeof pnpm !== 'object' || typeof pnpm.runPlugin !== 'function') {
    throw new Error('huaanwork-market: desktopPnpm 缺少 runPlugin()(市场安装执行需要 Desktop pnpm 能力;请使用 Desktop 提供的 desktopPnpm 能力)')
  }
  // 配置解析(非法 origin 具名错误 fail-closed)。
  const origin = resolveMarketOrigin()
  const logger = (message: string) => { ctx.logger?.info(message) }
  ctx.effect(() => {
    // 启动时惰性清扫孤儿制品(N1 GC:只删无 file: 引用者;有引用者删了必坏)。
    sweepOrphanMarketArtifacts(profiles.current.dir, logger)
    // 7 条表外 market routes(守则 5;ROUTE_TABLE 54 不破)。
    const disposeRoutes = registerMarketRoutes(ctx, {
      profileDir: profiles.current.dir,
      origin,
      logger,
    })
    return () => {
      disposeRoutes()
    }
  }, 'huaanwork-market: routes and artifact sweep')
}
