/**
 * huaanwork-market wrapper 配置层(M5 Task 4 骨架)。
 *
 * 单点归属(market-face-spec〈provider 与默认源〉):DESKTOP_MARKET_IDENTITIES 的
 * huaanworkMarket 条目只有 {provider,rowId,packageName} 三字段,**无 config 注入
 * 机制**(评审实证)——内网源 URL 与验签公钥全部固化在本模块,经 env 覆盖的仅
 * 源 origin 一项。
 *
 * 钉住的验签公钥(Task 0.5 供给与轮换,runbook rotation-revocation):
 * **fail-closed 决策**——本仓库不内置任何占位公钥。理由:唯一可用的「占位」公钥
 * 是 market-server/tests/fixtures/signing-vectors.json 的 throwaway 测试钥,其
 * **私钥同库可查**——把它钉成信任根等于把验签机制交还给任何能读仓库的人。
 * 故 DEFAULT_MARKET_VERIFICATION_PINS 为空对象,生产公钥按
 * docs/market-server-deployment.md「公钥分发与指纹核对」在 app 发版时钉进
 * PINS_AT_RELEASE;未配置 ⇒ assertMarketVerificationReady 恒抛,market 验签
 * 永远拒绝(Task 5 verify.ts 消费此 gate)。
 */

export const HUAANWORK_MARKET_BUNDLE_NAME = 'huaanwork-market' as const

/** package.json exports map 的 wrapper subpath(src/profile.ts 的落位校验消费)。 */
export const HUAANWORK_MARKET_SUBPATH_EXPORT = './huaanwork-market' as const

/**
 * 编译入二进制的内网源默认 origin(plain http 内网可用——真实性由离线签名
 * 清单 + 本 wrapper 验签保证,不靠 TLS,market-face-spec〈市场面规范〉)。
 * 与 market-server 的 MARKET_SERVER_PUBLIC_ORIGIN 示例同值。
 */
export const HUAANWORK_MARKET_DEFAULT_ORIGIN = 'http://market.intranet.example:8787'

/** env 覆盖键:部署期重指内网源(唯一允许的 env 配置面;验签公钥不走 env)。 */
export const HUAANWORK_MARKET_ORIGIN_ENV = 'HUAANWORK_MARKET_ORIGIN'

/** 具名配置错误:一切非法配置 fail-closed(抛),不回落、不默认放行。 */
export class HuaanworkMarketConfigError extends Error {
  constructor(message: string) {
    super(`huaanwork-market: ${message}`)
    this.name = 'HuaanworkMarketConfigError'
  }
}

/**
 * 解析并钉扎内网源 origin(scheme://host[:port])。
 * 只接受 http:/https:;拒 userinfo、query、fragment、非空 path——
 * 返回规范化 `URL.origin`,catalog 拉取与制品下载两处同源钉扎共享本值。
 */
export function resolveMarketOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[HUAANWORK_MARKET_ORIGIN_ENV] ?? HUAANWORK_MARKET_DEFAULT_ORIGIN
  const label = env[HUAANWORK_MARKET_ORIGIN_ENV] !== undefined
    ? `HUAANWORK_MARKET_ORIGIN=${JSON.stringify(raw)}`
    : `default market origin ${JSON.stringify(raw)}`
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new HuaanworkMarketConfigError(`invalid ${label}: origin must be a non-empty http(s) URL`)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HuaanworkMarketConfigError(`invalid ${label}: origin is not a URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HuaanworkMarketConfigError(`invalid ${label}: protocol must be http: or https:`)
  }
  if (url.hostname.length === 0 || url.username !== '' || url.password !== '') {
    throw new HuaanworkMarketConfigError(`invalid ${label}: origin must not carry userinfo`)
  }
  if (url.pathname !== '' && url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new HuaanworkMarketConfigError(`invalid ${label}: origin must be exactly scheme://host[:port]`)
  }
  return url.origin
}

/** 钉住格式:raw 32 字节 Ed25519 公钥,小写 hex(64 字符)——docs/market-server-deployment.md。 */
export interface PinnedMarketVerificationKey {
  readonly publicKeyHex: string
}

/** 轮换重叠期的上一把公钥(槽 2);`retiredAt` 退役时刻一到,其签名即拒(round4 C3)。 */
export interface PreviousMarketVerificationSlot {
  readonly key: PinnedMarketVerificationKey
  /** ISO-8601 退役时刻;缺失或不可解析 = 配置事故,fail-closed 抛错。 */
  readonly retiredAt: string
}

/** 两槽钉扎:当前公钥 + 上一把(带 retiredAt)。多源 keyring 延后 M6(不改造清单⑤)。 */
export interface MarketVerificationPins {
  readonly current?: PinnedMarketVerificationKey
  readonly previous?: PreviousMarketVerificationSlot
}

/**
 * 源码默认钉扎:**空(fail-closed)**。app 发版按 deployment doc 把生产公钥
 * (raw hex + 带外核对的指纹)钉进下方 PINS_AT_RELEASE 的 current 槽。
 */
export const DEFAULT_MARKET_VERIFICATION_PINS: MarketVerificationPins = Object.freeze({})

/**
 * app 发版钉扎点(docs/market-server-deployment.md「公钥分发与指纹核对」):
 * 新发版把新公钥放 current、旧公钥退 previous(带 retiredAt = 一个 app 发版窗口)。
 * 当前未钉任何公钥——verify 恒拒,直至发版供给。
 */
export const PINS_AT_RELEASE: MarketVerificationPins = DEFAULT_MARKET_VERIFICATION_PINS

/** 校验一把钉住公钥的格式(raw 32 字节小写 hex);非法即具名错误 fail-closed。 */
export function parsePinnedMarketKey(key: PinnedMarketVerificationKey, label: string): PinnedMarketVerificationKey {
  if (key === null || typeof key !== 'object' || typeof key.publicKeyHex !== 'string'
    || !/^[0-9a-f]{64}$/u.test(key.publicKeyHex)) {
    throw new HuaanworkMarketConfigError(
      `invalid ${label}: pinned public key must be raw 32-byte Ed25519 lowercase hex (64 chars)`,
    )
  }
  return key
}

/**
 * 三输入两槽判定中的「当前可用公钥」解析(签名 + 槽位 + 槽 2 retiredAt):
 * current 恒可用(已配置前提下);previous 仅在 retiredAt 之前可用。
 */
export function usableMarketVerificationKeys(
  pins: MarketVerificationPins,
  now: Date,
): PinnedMarketVerificationKey[] {
  const keys: PinnedMarketVerificationKey[] = []
  if (pins.current !== undefined) {
    keys.push(parsePinnedMarketKey(pins.current, 'current verification key'))
  }
  if (pins.previous !== undefined) {
    const retiredAtMs = Date.parse(pins.previous.retiredAt)
    if (Number.isNaN(retiredAtMs)) {
      throw new HuaanworkMarketConfigError(
        `invalid previous verification slot: retiredAt ${JSON.stringify(pins.previous.retiredAt)} is not an ISO-8601 timestamp`,
      )
    }
    if (retiredAtMs > now.getTime()) {
      keys.push(parsePinnedMarketKey(pins.previous.key, 'previous verification key'))
    }
  }
  return keys
}

/**
 * fail-closed 验签就绪 gate(Task 5 verify.ts 在验签前恒调本函数):
 * 未钉当前公钥 ⇒ 抛具名错误,market 验签永远拒绝——不存在「无公钥放行」路径。
 */
export function assertMarketVerificationReady(
  pins: MarketVerificationPins = PINS_AT_RELEASE,
): PinnedMarketVerificationKey {
  if (pins.current === undefined) {
    throw new HuaanworkMarketConfigError(
      'no pinned verification public key configured: market catalog verification always rejects '
        + 'until the deploy-provisioned key is pinned at app release (docs/market-server-deployment.md)',
    )
  }
  return parsePinnedMarketKey(pins.current, 'current verification key')
}
