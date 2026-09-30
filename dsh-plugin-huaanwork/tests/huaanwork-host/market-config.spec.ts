/**
 * 发行 provisioning(M6 Task 4.8;裁定 D-M6-18:R2 供值、R1 钉入,R3 不生成密钥)。
 *
 * master 按设计**未钉入**真实值:`PINS_AT_RELEASE` 为空 ⇒ 市场验签恒拒(fail-closed),
 * 两个 origin 是 `.example` 占位(按构造不可达)。发行当天 R1 在**发行分支**钉入真实值
 * (docs/release-checklist.md〈发行 provisioning〉)。因此本文件的断言必须在两种状态下
 * 都成立,而不是把「master 现在恰好未钉入」锁死:
 *
 * - 未钉入 ⇒ 拒绝嗓门大、逐项指名缺什么(本文件与守卫脚本两侧);
 * - 已钉入 ⇒ keyId 与公钥配对、两个 origin 成对替换(抄错指纹 / 只换一个是发行事故)。
 *
 * 守卫脚本以**源码文本**为输入(不 import,故在无 yarn install 的最小环境可跑),
 * 其行为用临时 fixture 根逐例验证;脚本自身不生成密钥、不猜测地址。
 */
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertMarketVerificationReady,
  HUAANWORK_MARKET_DEFAULT_ORIGIN,
  PINS_AT_RELEASE,
} from '../../src/huaanwork-host/market/config.ts'
import { HUAANWORK_UPDATE_DEFAULT_ORIGIN } from '../../src/update-checker.ts'

const GUARD_SCRIPT = fileURLToPath(new URL('../../scripts/huaanwork-verify-provisioning.mjs', import.meta.url))
const PLACEHOLDER_ORIGINS = [HUAANWORK_MARKET_DEFAULT_ORIGIN, HUAANWORK_UPDATE_DEFAULT_ORIGIN]
  .filter(origin => origin.includes('.example'))

/** 独立于生产实现的指纹推导(防用被测实现自证)。 */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 一对真实 ed25519 钥(只用公钥侧):测试自己生成,不落盘、不入仓。 */
function ed25519Pin(): { keyId: string; publicKeyHex: string } {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex')
  return { keyId: sha256Hex(Buffer.from(publicKeyHex, 'hex')), publicKeyHex }
}

const CONFIG_SOURCE_PATH = 'dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts'
const UPDATE_SOURCE_PATH = 'dsh-plugin-huaanwork/src/update-checker.ts'

const temporaryRoots: string[] = []

/** 单引号字面量 —— 与真实源码的写法一致(守卫按单引号读源码文本)。 */
function singleQuoted(value: string): string {
  return `'${value}'`
}

/** 最小 fixture 仓:只放守卫要读的两个源文件,放在真实的相对路径下。 */
function writeFixtureRoot(options: {
  readonly pinnedKey: string
  readonly marketOrigin: string
  readonly updateOrigin: string
}): string {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-provisioning-'))
  temporaryRoots.push(root)
  const configPath = join(root, CONFIG_SOURCE_PATH)
  const updatePath = join(root, UPDATE_SOURCE_PATH)
  mkdirSync(dirname(configPath), { recursive: true })
  mkdirSync(dirname(updatePath), { recursive: true })
  writeFileSync(configPath, [
    `export const HUAANWORK_MARKET_DEFAULT_ORIGIN = ${singleQuoted(options.marketOrigin)}`,
    `export const PINS_AT_RELEASE: MarketVerificationPins = ${options.pinnedKey}`,
    // 顶层导出之后的片段不得被读进 pins(this line 也是守卫切片边界的用例)。
    'export function assertMarketVerificationReady() { return PINS_AT_RELEASE }',
    '',
  ].join('\n'))
  writeFileSync(updatePath, `export const HUAANWORK_UPDATE_DEFAULT_ORIGIN = ${singleQuoted(options.updateOrigin)}\n`)
  return root
}

function runGuard(...args: readonly string[]): { readonly status: number | null; readonly output: string } {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, ...args], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

describe('release provisioning state', () => {
  it('reports unprovisioned pins loudly instead of only failing at runtime', () => {
    if (PINS_AT_RELEASE.current === undefined) {
      // master 的按设计状态:空钉扎 ⇒ 市场面恒拒;同一个入口在构建期就要把话说清。
      expect(() => assertMarketVerificationReady(PINS_AT_RELEASE)).toThrow(/provision/u)
      return
    }
    // 发行分支状态:同一入口放行,且钥匙带着配对指纹(否则 parsePinnedMarketKey 抛)。
    expect(assertMarketVerificationReady(PINS_AT_RELEASE).publicKeyHex).toBe(PINS_AT_RELEASE.current.publicKeyHex)
    expect(PINS_AT_RELEASE.current.keyId).toBe(sha256Hex(Buffer.from(PINS_AT_RELEASE.current.publicKeyHex, 'hex')))
  })

  it('keeps the placeholder origins unreachable by construction', () => {
    for (const origin of [HUAANWORK_MARKET_DEFAULT_ORIGIN, HUAANWORK_UPDATE_DEFAULT_ORIGIN]) {
      expect(new URL(origin).origin, origin).toBe(origin)
    }
    // 未 provisioning 时两个 origin 都是 `.example` 占位(按构造不可达);发行分支上
    // 两个都换成真实内网地址。只换一个是发行事故 —— 守卫与文档都要求成对钉入。
    const placeholderCount = [HUAANWORK_MARKET_DEFAULT_ORIGIN, HUAANWORK_UPDATE_DEFAULT_ORIGIN]
      .filter(origin => origin.includes('.example')).length
    expect([0, 2]).toContain(placeholderCount)
  })

  it('accepts a provisioned pin whose fingerprint matches its public key', () => {
    const pin = ed25519Pin()
    expect(assertMarketVerificationReady({ current: pin }).publicKeyHex).toBe(pin.publicKeyHex)
  })

  it('rejects a pin whose keyId does not match its public key', () => {
    const pin = ed25519Pin()
    const copiedWrong = { ...pin, keyId: `${pin.keyId.slice(0, 63)}${pin.keyId.endsWith('0') ? '1' : '0'}` }
    expect(copiedWrong.keyId).not.toBe(pin.keyId)
    expect(() => assertMarketVerificationReady({ current: copiedWrong })).toThrow(/keyId/u)
    expect(() => assertMarketVerificationReady({ current: copiedWrong })).toThrow(/fingerprint|sha256/u)
  })
})

describe('provisioning guard script', () => {
  it('refuses an unprovisioned tree and names every missing item', () => {
    const root = writeFixtureRoot({
      pinnedKey: 'DEFAULT_MARKET_VERIFICATION_PINS',
      marketOrigin: 'http://market.intranet.example:8787',
      updateOrigin: 'http://update.intranet.example:8790',
    })
    const { status, output } = runGuard('--root', root)

    expect(status).not.toBe(0)
    expect(output).toContain('本构建未完成发行 provisioning')
    expect(output).toContain('PINS_AT_RELEASE.current.publicKeyHex')
    expect(output).toContain('HUAANWORK_MARKET_DEFAULT_ORIGIN')
    expect(output).toContain('HUAANWORK_UPDATE_DEFAULT_ORIGIN')
  })

  it('accepts a provisioned tree and prints each item with its sha256 fingerprint', () => {
    const pin = ed25519Pin()
    const marketOrigin = 'http://market.huaanwork.intranet:8787'
    const updateOrigin = 'http://update.huaanwork.intranet:8790'
    const root = writeFixtureRoot({
      pinnedKey: `{ current: { keyId: '${pin.keyId}', publicKeyHex: '${pin.publicKeyHex}' } }`,
      marketOrigin,
      updateOrigin,
    })
    const { status, output } = runGuard('--root', root)

    expect(status, output).toBe(0)
    expect(output).toContain(pin.keyId)
    expect(output).toContain(pin.publicKeyHex)
    expect(output).toContain(sha256Hex(Buffer.from(marketOrigin, 'utf8')))
    expect(output).toContain(sha256Hex(Buffer.from(updateOrigin, 'utf8')))
    expect(output).not.toContain('本构建未完成发行 provisioning')
  })

  it('refuses a pin whose keyId does not match its public key', () => {
    const pin = ed25519Pin()
    const wrongKeyId = sha256Hex(Buffer.from('not this key', 'utf8'))
    const root = writeFixtureRoot({
      pinnedKey: `{ current: { keyId: '${wrongKeyId}', publicKeyHex: '${pin.publicKeyHex}' } }`,
      marketOrigin: 'http://market.huaanwork.intranet:8787',
      updateOrigin: 'http://update.huaanwork.intranet:8790',
    })
    const { status, output } = runGuard('--root', root)

    expect(status).not.toBe(0)
    expect(output).toContain('本构建未完成发行 provisioning')
    expect(output).toContain(wrongKeyId)
  })

  it('refuses a pin that carries a public key but no fingerprint', () => {
    const pin = ed25519Pin()
    const root = writeFixtureRoot({
      pinnedKey: `{ current: { publicKeyHex: '${pin.publicKeyHex}' } }`,
      marketOrigin: 'http://market.huaanwork.intranet:8787',
      updateOrigin: 'http://update.huaanwork.intranet:8790',
    })
    const { status, output } = runGuard('--root', root)

    expect(status).not.toBe(0)
    expect(output).toContain('本构建未完成发行 provisioning')
    expect(output).toContain('keyId')
  })

  it('reads this repository by default and agrees with the exported provisioning state', () => {
    const { status, output } = runGuard()
    const provisioned = PINS_AT_RELEASE.current !== undefined
      && PLACEHOLDER_ORIGINS.length === 0

    expect(status, output).toBe(provisioned ? 0 : 1)
    if (!provisioned) expect(output).toContain('本构建未完成发行 provisioning')
  })
})
