/**
 * huaanwork-market wrapper 验签(M5 Task 5,round3 R10)。
 *
 * **不 import market-server 任何代码**(依赖方向守卫):本模块以 `node:crypto`
 * 自实现 market-server/src/signing.ts 的验签语义,跨侧一致性由共享测试向量
 * `market-server/tests/fixtures/signing-vectors.json` 证明——wrapper 测试逐条
 * 复现该 fixtures 的 13 个向量,每条的 verdict(ok/slot 或 reason)必须一致。
 *
 * 语义镜像(与 signing.ts 逐项对齐,改动须同步两侧):
 * - canonicalJson:对象键递归排序、无空白;签名覆盖 utf8(canonicalJson(manifest))。
 * - 信封防重放:domain/revision/issuedAt/notAfter;revision 单调(lastSeenRevision)、
 *   notAfter 未过期、TTL ≤ 7 天;`notAfter` 含界有效、`retiredAt` 到点即拒(独占)。
 * - 三输入两槽:签名记录 + 声明槽位 + 槽 2 retiredAt;keyId 先对**全部**槽解析
 *   (unknown-key),再比对声明槽(slot-key-mismatch),再过 retiredAt(slot-retired),
 *   最后 Ed25519(invalid-signature)。
 * - 签名记录形状守卫:畸形记录返回 verdict,绝不抛 TypeError(Task 2 同口径)。
 *
 * fail-closed 公钥供给:信任锚来自 config.ts 的两槽钉扎;验签前恒调
 * assertMarketVerificationReady(pins)——PINS_AT_RELEASE 默认为空 = 恒拒
 * (Task 4 决策);测试经 pins 形参注入 throwaway 测试钥。
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import {
  assertMarketVerificationReady,
  HuaanworkMarketConfigError,
  parsePinnedMarketKey,
  type MarketVerificationPins,
} from './config.ts'

// ---------------------------------------------------------------------------
// 常量(与 signing.ts 范数一致;改动须同步 market-server)
// ---------------------------------------------------------------------------

export const ENVELOPE_VERSION = 1 as const
export const SIGNATURE_VERSION = 1 as const
export const SIGNATURE_ALGORITHM = 'Ed25519' as const

/** 信封寿命上限:notAfter - issuedAt <= 7 天(round5 N7)。 */
export const MAX_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type KeySlotNumber = 1 | 2

// ---------------------------------------------------------------------------
// Wire shapes(与 signing.ts 同形;payload 经上游 parseCatalogProviderPage 自校)
// ---------------------------------------------------------------------------

/** 防重放信封头。`domain` = 配置源 origin。 */
export interface MarketEnvelope {
  readonly version: number
  readonly domain: string
  /** 每源单调;整数 >= 1。 */
  readonly revision: number
  /** ISO 8601 UTC。 */
  readonly issuedAt: string
  /** ISO 8601 UTC;须满足 notAfter <= issuedAt + MAX_ENVELOPE_TTL_MS。 */
  readonly notAfter: string
}

/** 目录负载:`catalog` 成员是 provider-page 兼容负载(schemaVersion/items/page),
 *  信封/sidecar 剥离后须过 `parseCatalogProviderPage`(严格体 additionalProperties:false)。 */
export interface MarketCatalogPayload {
  readonly schemaVersion: '1.0.0'
  readonly generatedAt: string
  readonly items: readonly Record<string, unknown>[]
  readonly page: { readonly total: number }
}

/** sha 清单中的一条托管制品。 */
export interface MarketManifestFile {
  readonly name: string
  readonly version: string
  /** 制品字节的小写 hex sha256。 */
  readonly sha256: string
  /** 服务端相对 tarball 路径,如 `/artifacts/<name>-<version>.tgz`。 */
  readonly tarballPath: string
  readonly size: number
}

/** 被签清单:防重放信封 + 目录负载 + sha 清单。分离签名 sidecar 在文档之外。 */
export interface MarketManifest {
  readonly envelope: MarketEnvelope
  readonly catalog: MarketCatalogPayload
  readonly files: readonly MarketManifestFile[]
}

/** 分离签名 sidecar。 */
export interface MarketManifestSignature {
  readonly version: number
  readonly algorithm: typeof SIGNATURE_ALGORITHM
  /** = fingerprintPublicKeyHex(publicKeyHex);把记录绑到钥槽。 */
  readonly keyId: string
  readonly slot: KeySlotNumber
  /** ISO 8601 UTC 签名时刻(运营记账;防重放是信封的职责)。 */
  readonly signedAt: string
  /** utf8(canonicalJson(manifest)) 上 64 字节 Ed25519 签名的 base64。 */
  readonly signature: string
}

/** 配置钥槽(仅公钥材料——wrapper 永不持有私钥)。 */
export interface KeySlotConfig {
  readonly slot: KeySlotNumber
  /** raw 32 字节 Ed25519 公钥的 sha256 hex 指纹。 */
  readonly keyId: string
  /** raw 32 字节 Ed25519 公钥,小写 hex(钉住格式)。 */
  readonly publicKeyHex: string
  /** 仅槽 2:退役时刻(ISO 8601 UTC)。过点即拒。 */
  readonly retiredAt?: string
}

// ---------------------------------------------------------------------------
// Verdict 类型(与 signing.ts 的 machine-readable reason 逐字一致)
// ---------------------------------------------------------------------------

export type EnvelopeRejectionReason =
  | 'missing-field'
  | 'unsupported-envelope-version'
  | 'invalid-revision'
  | 'revision-regression'
  | 'invalid-timestamp'
  | 'domain-mismatch'
  | 'not-yet-valid'
  | 'expired'
  | 'ttl-exceeds-cap'

export type SlotRejectionReason =
  | 'unknown-key'
  | 'slot-key-mismatch'
  | 'slot-retired'
  | 'invalid-signature'

export type VerificationReason = EnvelopeRejectionReason | SlotRejectionReason

export type EnvelopeVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: EnvelopeRejectionReason }

export type VerificationVerdict =
  | { readonly ok: true; readonly slot: KeySlotNumber }
  | { readonly ok: false; readonly reason: VerificationReason }

export interface VerificationContext {
  /** 配置源 origin,envelope.domain 必须与之相等。 */
  readonly domain: string
  /** 验签时刻,epoch 毫秒(可注入,测试/确定性)。 */
  readonly now: number
  /** 每源已持久化的最大 revision;回放 <= 此值即拒。 */
  readonly lastSeenRevision?: number
}

// ---------------------------------------------------------------------------
// Canonical JSON(与 signing.ts canonicalize 逐字镜像)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${String(value)}`)
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
    }
    default:
      throw new Error(`canonicalJson: unsupported value type ${typeof value}`)
  }
}

/** 确定性 JSON 序列化;被签名的精确字节。 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value)
}

// ---------------------------------------------------------------------------
// Ed25519 原语(node:crypto,零依赖)
// ---------------------------------------------------------------------------

const ED25519_SPKI_DER_LENGTH = 44
const ED25519_RAW_KEY_LENGTH = 32

/** raw 32 字节 Ed25519 公钥(小写 hex)——钉住格式。 */
export function extractRawPublicKeyHex(publicKey: import('node:crypto').KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  if (spki.length !== ED25519_SPKI_DER_LENGTH) {
    throw new Error(`unexpected Ed25519 SPKI length ${spki.length}`)
  }
  return spki.subarray(ED25519_SPKI_DER_LENGTH - ED25519_RAW_KEY_LENGTH).toString('hex')
}

/** raw 公钥字节的 sha256 hex 指纹;兼作 keyId。 */
export function fingerprintPublicKeyHex(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')
}

/** 从钉住 raw-hex 格式重建 KeyObject(经 JWK,无需 PEM)。 */
export function publicKeyFromHex(publicKeyHex: string): import('node:crypto').KeyObject {
  const raw = Buffer.from(publicKeyHex, 'hex')
  if (raw.length !== ED25519_RAW_KEY_LENGTH) {
    throw new Error(`Ed25519 raw public key must be 32 bytes, got ${raw.length}`)
  }
  return createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
  })
}

/** 用 raw-hex 公钥验 base64 Ed25519 签名(canonical 字节上)。 */
export function verifyCanonical(canonical: string, signatureBase64: string, publicKeyHex: string): boolean {
  return cryptoVerify(null, Buffer.from(canonical, 'utf8'), publicKeyFromHex(publicKeyHex), Buffer.from(signatureBase64, 'base64'))
}

// ---------------------------------------------------------------------------
// 信封防重放:纯字段判定(与 signing.ts checkEnvelope 逐项镜像)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseEpochMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/** 信封纯防重放字段判定。fail-closed:畸形/不符/回退/过期一律带稳定 reason 拒绝。 */
export function checkEnvelope(envelope: unknown, context: VerificationContext): EnvelopeVerdict {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return { ok: false, reason: 'missing-field' }
  }
  const env = envelope as Record<string, unknown>

  if (env.version !== ENVELOPE_VERSION) return { ok: false, reason: 'unsupported-envelope-version' }
  if (!isNonEmptyString(env.domain)) return { ok: false, reason: 'missing-field' }
  if (env.revision === undefined || env.revision === null) return { ok: false, reason: 'missing-field' }
  if (typeof env.revision !== 'number' || !Number.isInteger(env.revision) || env.revision < 1) {
    return { ok: false, reason: 'invalid-revision' }
  }
  if (!isNonEmptyString(env.issuedAt) || !isNonEmptyString(env.notAfter)) {
    return { ok: false, reason: 'missing-field' }
  }

  if (env.domain !== context.domain) return { ok: false, reason: 'domain-mismatch' }

  const issuedAtMs = parseEpochMs(env.issuedAt)
  const notAfterMs = parseEpochMs(env.notAfter)
  if (issuedAtMs === null || notAfterMs === null) return { ok: false, reason: 'invalid-timestamp' }
  if (notAfterMs <= issuedAtMs) return { ok: false, reason: 'invalid-timestamp' }
  if (notAfterMs - issuedAtMs > MAX_ENVELOPE_TTL_MS) return { ok: false, reason: 'ttl-exceeds-cap' }

  if (context.lastSeenRevision !== undefined && env.revision <= context.lastSeenRevision) {
    return { ok: false, reason: 'revision-regression' }
  }

  if (context.now < issuedAtMs) return { ok: false, reason: 'not-yet-valid' }
  if (context.now > notAfterMs) return { ok: false, reason: 'expired' }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// 钉扎 → 钥槽(三输入两槽判定的 wrapper 供给)
// ---------------------------------------------------------------------------

/**
 * 把 config.ts 的两槽钉扎展开为验签钥槽(fail-closed):
 * - 恒先过 assertMarketVerificationReady(pins)——未钉 current 即抛,验签永不放行。
 * - previous 槽带 retiredAt;缺失/坏值 = 配置事故抛具名错误(与 config.ts 同口径)。
 */
export function marketKeySlotsFromPins(pins: MarketVerificationPins): KeySlotConfig[] {
  const current = assertMarketVerificationReady(pins)
  const slots: KeySlotConfig[] = [{
    slot: 1,
    keyId: fingerprintPublicKeyHex(parsePinnedMarketKey(current, 'current verification key').publicKeyHex),
    publicKeyHex: current.publicKeyHex,
  }]
  if (pins.previous !== undefined) {
    const previous = parsePinnedMarketKey(pins.previous.key, 'previous verification key')
    const retiredAtMs = Date.parse(pins.previous.retiredAt)
    if (Number.isNaN(retiredAtMs)) {
      throw new HuaanworkMarketConfigError(
        `invalid previous verification slot: retiredAt ${JSON.stringify(pins.previous.retiredAt)} is not an ISO-8601 timestamp`,
      )
    }
    slots.push({
      slot: 2,
      keyId: fingerprintPublicKeyHex(previous.publicKeyHex),
      publicKeyHex: previous.publicKeyHex,
      retiredAt: pins.previous.retiredAt,
    })
  }
  return slots
}

function findSlotByKeyId(slots: readonly KeySlotConfig[], keyId: string): KeySlotConfig | undefined {
  return slots.find((slot) => slot.keyId === keyId)
}

/**
 * 三输入两槽验签:(1) 分离签名,(2) 声明钥槽,(3) 槽 2 的 retiredAt 退役时刻
 * —— 外加信封防重放判定。逐步 fail-closed;仅当返回 ok 时才可信任清单中的 sha256。
 */
export function verifyWithKeySlots(
  manifest: MarketManifest,
  signatureRecord: MarketManifestSignature,
  slots: readonly KeySlotConfig[],
  context: VerificationContext,
): VerificationVerdict {
  const envelope = checkEnvelope(manifest.envelope, context)
  if (!envelope.ok) return envelope

  // 形状守卫优先:畸形记录返回 verdict,绝不抛 TypeError(与 Task 2  defense-in-depth 同层)。
  if (typeof signatureRecord !== 'object' || signatureRecord === null) {
    return { ok: false, reason: 'invalid-signature' }
  }
  if (
    signatureRecord.version !== SIGNATURE_VERSION
    || signatureRecord.algorithm !== SIGNATURE_ALGORITHM
    || typeof signatureRecord.keyId !== 'string'
    || (signatureRecord.slot !== 1 && signatureRecord.slot !== 2)
    || typeof signatureRecord.signature !== 'string'
  ) {
    return { ok: false, reason: 'invalid-signature' }
  }

  // keyId 先对**全部**配置槽解析:钉住无处可循的签名者即 unknown-key,
  // 无论记录声明哪个槽(与 signing.ts 语义一致)。
  const slot = findSlotByKeyId(slots, signatureRecord.keyId)
  if (slot === undefined) return { ok: false, reason: 'unknown-key' }
  if (slot.slot !== signatureRecord.slot) return { ok: false, reason: 'slot-key-mismatch' }

  if (slot.slot === 2 && slot.retiredAt !== undefined) {
    const retiredAtMs = parseEpochMs(slot.retiredAt)
    if (retiredAtMs === null) return { ok: false, reason: 'invalid-timestamp' }
    if (context.now >= retiredAtMs) return { ok: false, reason: 'slot-retired' }
  }

  const canonical = canonicalJson(manifest)
  if (!verifyCanonical(canonical, signatureRecord.signature, slot.publicKeyHex)) {
    return { ok: false, reason: 'invalid-signature' }
  }

  return { ok: true, slot: slot.slot }
}

/**
 * wrapper 侧一次性验签入口(routes/install 消费):钉扎 → 钥槽 → 三输入两槽。
 * pins 默认 PINS_AT_RELEASE(空 = 恒拒);测试经 pins 注入 throwaway 钥。
 */
export function verifyMarketManifest(
  manifest: MarketManifest,
  signatureRecord: MarketManifestSignature,
  pins: MarketVerificationPins,
  context: VerificationContext,
): VerificationVerdict {
  return verifyWithKeySlots(manifest, signatureRecord, marketKeySlotsFromPins(pins), context)
}
