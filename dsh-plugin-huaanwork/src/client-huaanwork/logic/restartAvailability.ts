/**
 * 重启可用性的共享判定与 fallback 顺序(M1/D5;债表 AGENTS.md:46 的正解形状)。
 *
 * 存在两条互相独立的重启通道,可用性判据完全不同:
 * - 市场通道 /api/huaanwork-market/desktop/request-restart 由 market provider 的
 *   apply() 注册(src/huaanwork-host/market/index.ts:53-86,7 条 route 之一),故
 *   provider disabled 时整组未注册;
 * - 桌面通道 /api/desktop/restart 的唯一注册门是 desktopSettingsController 在位
 *   (src/index.ts:326-327),而它在 src/main.ts:1695 的 start() 内无条件 provide,
 *   与市场状态无关。
 * D5 的缺陷正是把前者的判据当成了后者的判据,于是在 provider disabled 时声称
 * 「应用内重启当前不可用」,而那条路其实是通的。
 *
 * 本模块**只**判定「有没有可用的入口、走哪条」。横幅文案与 JSX 由各调用方自己持有
 * (债表:「横幅 JSX 各自保留」—— transport、可用性判据、既有测试钉界三个维度皆异,
 * 抽共享组件的成本高于两处各自实现)。
 *
 * 另注:重启**结果**不可观测 —— /api/desktop/restart 恒回 202 {accepted:true} 后才
 * setImmediate 触发,且 confirmAndRestart 在用户取消时静默 resolve void
 * (src/electron-runtime.ts:570-572)。故本模块不承诺「已重启」,只承诺「有入口」;
 * 界面对此的唯一正确形态是常备再触发入口(见 Task 2.3)。
 */
export interface RestartAvailabilityInput {
  readonly marketRestartAction: boolean
  readonly desktopRestartRoute: boolean
}

export type RestartRoute = 'market-action' | 'desktop-route' | 'none'

export interface RestartAvailability {
  readonly canRestart: boolean
  readonly route: RestartRoute
}

export function resolveRestartAvailability(input: RestartAvailabilityInput): RestartAvailability {
  if (input.marketRestartAction) return { canRestart: true, route: 'market-action' }
  if (input.desktopRestartRoute) return { canRestart: true, route: 'desktop-route' }
  return { canRestart: false, route: 'none' }
}
