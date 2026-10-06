import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_MANIFEST_ENTRIES,
  MAX_MANIFEST_BYTES,
  ManifestPrepareError,
  preparePendingManifest,
  type PreparePendingManifestResult,
} from '../src/manifest-prepare.ts'
import { canonicalJson } from '../src/signing.ts'
import { CatalogStore, type CatalogEntry } from '../src/catalog/store.ts'
import { CatalogService } from '../src/catalog/service.ts'
import { ENV_KEYS, loadConfig, type MarketServerConfig } from '../src/config.ts'

const BUDGET = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../scripts/market-manifest-byte-budget.json'), 'utf8'),
) as {
  readonly fixtureVersion: number
  readonly clientMaxJsonBytes: number
  readonly serverMaxManifestBytes: number
  readonly m18Triggers: {
    readonly entryCount: number
    readonly manifestCanonicalBytes: number
    readonly averageEntryBytes: number
  }
}

function buildEntries(options: { count: number; keywordPadding?: string; paddingBytes?: number }): CatalogEntry[] {
  const padding = options.paddingBytes ?? (options.keywordPadding && options.keywordPadding.length > 0 ? 20000 : 0)
  const list: CatalogEntry[] = []
  for (let i = 0; i < options.count; i++) {
    const id = `plugin-${String(i).padStart(3, '0')}`
    list.push({
      id,
      packageName: `@huaanwork/${id}`,
      version: '1.0.0',
      displayName: `Plugin ${String(i)}`,
      summary: `Summary for ${id}`,
      keywords: ['sample'],
      categories: ['utility'],
      sha256: 'ab'.repeat(32),
      tarball: padding > 0 ? `${id}-${'t'.repeat(padding)}.tgz` : `${id}-1.0.0.tgz`,
    })
  }
  return list
}

async function prepareExpectingFailure(entries: readonly CatalogEntry[]): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-byte-cap-fail-'))
  const store = await CatalogStore.open(dir)
  try {
    await store.replaceEntries(entries)
    const catalog = new CatalogService(store)
    const config: MarketServerConfig = {
      port: 8787,
      dataDir: dir,
      publicOrigin: 'http://market.intranet.example:8787',
      verifyPublicKeyPath: '/nonexistent/key.hex',
      verifyPublicKeyHex: 'a1'.repeat(32),
      adminToken: 'test-admin-token',
      maxCatalogEntries: MAX_MANIFEST_ENTRIES,
      maxManifestBytes: MAX_MANIFEST_BYTES,
      allowedHosts: ['127.0.0.1'],
      maxConcurrentUploads: 4,
      requestTimeoutMs: 300_000,
      headersTimeoutMs: 60_000,
      socketTimeoutMs: 120_000,
    }
    try {
      await preparePendingManifest({
        store,
        catalog,
        config,
        artifactSize: async () => 1024,
      })
      throw new Error('expected preparePendingManifest to fail')
    } catch (cause) {
      return cause
    }
  } finally {
    await store.close()
  }
}

async function prepareSuccessfully(entries: readonly CatalogEntry[]): Promise<PreparePendingManifestResult> {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-byte-cap-succ-'))
  const store = await CatalogStore.open(dir)
  try {
    await store.replaceEntries(entries)
    const catalog = new CatalogService(store)
    const config: MarketServerConfig = {
      port: 8787,
      dataDir: dir,
      publicOrigin: 'http://market.intranet.example:8787',
      verifyPublicKeyPath: '/nonexistent/key.hex',
      verifyPublicKeyHex: 'a1'.repeat(32),
      adminToken: 'test-admin-token',
      maxCatalogEntries: MAX_MANIFEST_ENTRIES,
      maxManifestBytes: MAX_MANIFEST_BYTES,
      allowedHosts: ['127.0.0.1'],
      maxConcurrentUploads: 4,
      requestTimeoutMs: 300_000,
      headersTimeoutMs: 60_000,
      socketTimeoutMs: 120_000,
    }
    return await preparePendingManifest({
      store,
      catalog,
      config,
      artifactSize: async () => 1024,
    })
  } finally {
    await store.close()
  }
}

function parseConfig(options: { env: Record<string, string> }): MarketServerConfig {
  const dir = mkdtempSync(join(tmpdir(), 'market-cfg-'))
  const keyPath = join(dir, 'key.hex')
  writeFileSync(keyPath, 'a1'.repeat(32) + '\n', { mode: 0o600 })
  return loadConfig({
    [ENV_KEYS.port]: '8787',
    [ENV_KEYS.dataDir]: dir,
    [ENV_KEYS.publicOrigin]: 'http://market.intranet.example:8787',
    [ENV_KEYS.verifyPublicKeyPath]: keyPath,
    [ENV_KEYS.adminToken]: 'test-admin-token',
    ...options.env,
  })
}

describe('signed manifest byte cap (M8)', () => {
  it('pins the server cap to the cross-package budget fixture', () => {
    // 服务端与客户端互相不得 import(依赖方向红线),故对账只能经这个 root fixture。
    expect(BUDGET.fixtureVersion).toBe(1)
    expect(MAX_MANIFEST_BYTES).toBe(BUDGET.serverMaxManifestBytes)
    expect(MAX_MANIFEST_BYTES).toBeLessThan(BUDGET.clientMaxJsonBytes)
  })

  it('refuses to prepare a manifest whose canonical bytes exceed the cap', async () => {
    // 契约合法的条目数(<= MAX_MANIFEST_ENTRIES)但元数据偏大 ⇒ 条目数守卫放行、
    // 字节守卫必须拦下。这就是 M8 的缺口形状:先撞的是未登记的那个上限。
    const entries = buildEntries({ count: MAX_MANIFEST_ENTRIES, keywordPadding: 'k'.repeat(64) })
    const error = await prepareExpectingFailure(entries)
    expect(error).toBeInstanceOf(ManifestPrepareError)
    expect((error as ManifestPrepareError).code).toBe('manifest-too-large')
    // 归因必须可用:错误信息要给出实测字节数、帽值、以及「拆源」这个唯一出路
    // (分页/多页签名是 M18,按 R-3 与 R-M7-7 延后)。
    expect((error as ManifestPrepareError).message).toContain(String(BUDGET.serverMaxManifestBytes))
    expect((error as ManifestPrepareError).message).toMatch(/canonical bytes/u)
  })

  it('accepts a realistic-size catalog and reports the three M18 observables', async () => {
    // 真实规模(评估实测约 1.6 KB/条目)下 200 条远低于帽 ⇒ 必须放行,且不得因为
    // 新增守卫而改变既有的 prepare 结果形状。
    const result = await prepareSuccessfully(buildEntries({ count: MAX_MANIFEST_ENTRIES, keywordPadding: '' }))
    expect(result.manifestCanonicalBytes).toBe(Buffer.byteLength(canonicalJson(result.manifest), 'utf8'))
    expect(result.entryCount).toBe(MAX_MANIFEST_ENTRIES)
    expect(result.averageEntryBytes).toBe(Math.round(result.manifestCanonicalBytes / result.entryCount))
    expect(result.manifestCanonicalBytes).toBeLessThan(BUDGET.m18Triggers.manifestCanonicalBytes)
  })

  it('rejects a configured cap above the client download limit at startup', () => {
    // 与既有 MARKET_SERVER_MAX_CATALOG_ENTRIES 的同形防护(config.ts:270 的硬上限校验):
    // 配置得比客户端能拉的上限还高 = 配置事故,启动即拒,而不是等激活后全体客户端失败。
    expect(() => parseConfig({ env: { MARKET_SERVER_MAX_MANIFEST_BYTES: String(BUDGET.clientMaxJsonBytes) } }))
      .toThrow(/must not exceed/u)
  })
})
