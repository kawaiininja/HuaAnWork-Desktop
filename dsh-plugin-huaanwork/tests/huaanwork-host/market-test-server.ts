/**
 * M5 wrapper 测试共用夹具:内网 market mock server + 离线签名 helper。
 *
 * 私钥只来自 market-server/tests/fixtures/signing-vectors.json 的 **throwaway
 * 测试钥**(明示测试材料);签名用 node:crypto 在测试内自实现(不 import
 * market-server 代码,与 wrapper verify.ts 同口径的跨侧证明策略)。
 */

import { createServer, type Server } from 'node:http'
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, fingerprintPublicKeyHex, type MarketManifest, type MarketManifestSignature } from '../../src/huaanwork-host/market/verify.ts'

export interface SigningVectorKeys {
  readonly slot1: { readonly publicKeyHex: string; readonly privateKeyPem: string }
  readonly slot2: { readonly publicKeyHex: string; readonly privateKeyPem: string }
  readonly unknown: { readonly publicKeyHex: string; readonly privateKeyPem: string }
}

/** 共享测试向量(与 market-server 测试同源一份文件,round3 R10)。 */
export function loadSigningVectors(): {
  readonly domain: string
  readonly keys: SigningVectorKeys
} {
  const fixture = JSON.parse(readFileSync(
    join(__dirname, '../../../market-server/tests/fixtures/signing-vectors.json'),
    'utf8',
  )) as { domain: string; keys: SigningVectorKeys }
  return fixture
}

/** 测试内离线签名(throwaway 私钥;keyId 由私钥派生,与 signManifest 同语义)。 */
export function signManifestForTest(
  manifest: MarketManifest,
  privateKeyPem: string,
  slot: 1 | 2,
  signedAt = '2026-09-26T00:00:00Z',
): MarketManifestSignature {
  const publicKeyHex = extractRawHex(privateKeyPem)
  return {
    version: 1,
    algorithm: 'Ed25519',
    keyId: fingerprintPublicKeyHex(publicKeyHex),
    slot,
    signedAt,
    signature: cryptoSign(null, Buffer.from(canonicalJson(manifest), 'utf8'), createPrivateKey(privateKeyPem)).toString('base64'),
  }
}

function extractRawHex(privateKeyPem: string): string {
  // 与 verify.ts extractRawPublicKeyHex 同路径:SPKI DER 末 32 字节。
  const spki = createPublicKey(privateKeyPem).export({ format: 'der', type: 'spki' }) as Buffer
  return spki.subarray(spki.length - 32).toString('hex')
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 一条已签清单 + 制品的 mock 内网源。 */
export interface MarketTestServer {
  readonly origin: string
  /** 记录全部请求 URL(网络层同源断言原料)。 */
  readonly requestedUrls: string[]
  setManifest(manifest: MarketManifest | null, signature: MarketManifestSignature | null): void
  /** path(如 `/artifacts/a-1.0.0.tgz`)→ 字节。 */
  addArtifact(path: string, bytes: Buffer): void
  /** 下一次制品下载返回篡改字节(tampered-in-transit 负例)。 */
  tamperNextArtifact(path: string, bytes: Buffer): void
  close(): Promise<void>
}

export function createMarketTestServer(): Promise<MarketTestServer> {
  return new Promise((resolvePromise) => {
    const requestedUrls: string[] = []
    let manifest: MarketManifest | null = null
    let signature: MarketManifestSignature | null = null
    const artifacts = new Map<string, Buffer>()
    const tampers = new Map<string, Buffer>()
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      requestedUrls.push(url.pathname)
      if (url.pathname === '/v1/manifest') {
        if (manifest === null) { res.statusCode = 404; res.end('not activated'); return }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(manifest))
        return
      }
      if (url.pathname === '/v1/manifest/signature') {
        if (signature === null) { res.statusCode = 404; res.end('not activated'); return }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(signature))
        return
      }
      const tampered = tampers.get(url.pathname)
      if (tampered !== undefined) {
        tampers.delete(url.pathname)
        res.setHeader('content-type', 'application/gzip')
        res.end(tampered)
        return
      }
      const bytes = artifacts.get(url.pathname)
      if (bytes !== undefined) {
        res.setHeader('content-type', 'application/gzip')
        res.end(bytes)
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock market server has no address')
      resolvePromise({
        origin: `http://127.0.0.1:${address.port}`,
        requestedUrls,
        setManifest: (m, s) => { manifest = m; signature = s },
        addArtifact: (path, bytes) => { artifacts.set(path, bytes) },
        tamperNextArtifact: (path, bytes) => { tampers.set(path, bytes) },
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      })
    })
  })
}

/** 内存 revision store(测试注入;断言「验签失败不前进 revision」用)。 */
export function createMemoryRevisionStore(): {
  store: { loadMaxRevision(origin: string): number | undefined; saveMaxRevision(origin: string, revision: number): void }
  map: Map<string, number>
} {
  const map = new Map<string, number>()
  return {
    map,
    store: {
      loadMaxRevision: (origin) => map.get(origin),
      saveMaxRevision: (origin, revision) => { map.set(origin, revision) },
    },
  }
}
