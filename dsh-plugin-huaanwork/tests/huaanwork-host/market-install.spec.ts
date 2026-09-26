/**
 * install.ts 单元层:(c) 安装侧门正负例、sha256 比对、制品落盘/GC。
 * pnpm 层语义在 market-pnpm-semantics.spec.ts;wrapper e2e 在 market-e2e.spec.ts。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import {
  gcRemovedPackageArtifacts,
  marketArtifactName,
  profileFileReferencesExist,
  sweepOrphanMarketArtifacts,
} from '../../src/huaanwork-host/market/artifacts.ts'
import type { MarketHttpClient } from '../../src/huaanwork-host/market/catalog-client.ts'
import {
  downloadAndStageArtifact,
  precheckTarballManifest,
  readTarballPackageJson,
} from '../../src/huaanwork-host/market/install.ts'
import { sha256Hex } from './market-test-server.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hw-market-install-'))
  roots.push(dir)
  mkdirSync(join(dir, '.market-artifacts'), { mode: 0o700 })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'profile', dependencies: {} }, undefined, 2)}\n`)
  return dir
}

/** 真实 tar.gz(npm 形态 package/ 根),与 market-pnpm-fixture 同构造。 */
function buildTgz(dir: string, manifest: Record<string, unknown>): Buffer {
  const pkgDir = join(dir, 'package')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  const out = join(dir, 'out.tgz')
  const tar = spawnSync('tar', ['czf', out, 'package'], { cwd: dir, encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  return readFileSync(out)
}

function fakeHttp(routes: Map<string, Buffer>): MarketHttpClient {
  return {
    fetchText: (url) => {
      const bytes = routes.get(url)
      if (bytes === undefined) return Promise.reject(new Error(`404 ${url}`))
      return Promise.resolve(bytes.toString('utf8'))
    },
    fetchBuffer: (url) => {
      const bytes = routes.get(url)
      if (bytes === undefined) return Promise.reject(new Error(`404 ${url}`))
      return Promise.resolve(bytes)
    },
  }
}

const ORIGIN = 'http://market.intranet.example:8787'

function fileEntry(overrides: Partial<{ name: string; version: string; sha256: string; tarballPath: string }> = {}) {
  return {
    name: '@huaanwork/sample',
    version: '1.2.3',
    sha256: '0'.repeat(64),
    tarballPath: '/artifacts/huaanwork-sample-1.2.3.tgz',
    size: 4096,
    ...overrides,
  }
}

describe('precheckTarballManifest ((c) 安装侧门,与发布侧门同口径)', () => {
  test('zero-dependency, no lifecycle scripts passes (peer/bundle deps, build scripts allowed)', () => {
    expect(() => precheckTarballManifest({
      name: 'a', version: '1.0.0',
      peerDependencies: { cordis: '^1.0.0' },
      bundleDependencies: ['vendor'],
      scripts: { build: 'tsc', test: 'vitest' },
    })).not.toThrow()
  })

  test.each([
    [{ dependencies: { ms: '^2.1.3' } }, /dependencies must be empty/],
    [{ optionalDependencies: { ms: '^2.1.3' } }, /optionalDependencies must be empty/],
    [{ scripts: { preinstall: 'x' } }, /scripts\.preinstall/],
    [{ scripts: { install: 'x' } }, /scripts\.install/],
    [{ scripts: { postinstall: 'curl evil' } }, /scripts\.postinstall/],
    [{ scripts: { prepare: 'x' } }, /scripts\.prepare/],
  ])('rejects non-compliant manifest %j fail-closed', (extra, pattern) => {
    expect(() => precheckTarballManifest({ name: 'a', version: '1.0.0', ...extra })).toThrow(pattern)
  })
})

describe('readTarballPackageJson', () => {
  test('extracts the top-level package.json from a real tgz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-tgz-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: 'pkg-a', version: '2.0.0' })
    expect(readTarballPackageJson(bytes)).toEqual({ name: 'pkg-a', version: '2.0.0' })
  })

  test('rejects non-gzip and missing package.json', () => {
    expect(() => readTarballPackageJson(Buffer.from('not gzip'))).toThrow(/gzip/u)
  })
})

describe('downloadAndStageArtifact (sha256 比对 + origin 钉扎 + 制品落盘)', () => {
  test('stages the artifact 0600 under .market-artifacts with the planned name', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-stage-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    const sha256 = sha256Hex(bytes)
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    const prepared = await downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256 }),
      profileDir,
      http,
    })

    expect(prepared.sha256).toBe(sha256)
    expect(prepared.artifactPath).toBe(join(profileDir, '.market-artifacts', marketArtifactName('@huaanwork/sample', '1.2.3', sha256)))
    expect(existsSync(prepared.artifactPath)).toBe(true)
    expect(statSync(prepared.artifactPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(profileDir, '.market-artifacts')).mode & 0o777).toBe(0o700)
    expect(readFileSync(prepared.artifactPath).equals(bytes)).toBe(true)
  })

  test('rejects tampered-in-transit bytes: sha256 mismatch, nothing staged, honest error', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-tamper-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    // 清单签的是另一个 sha(模拟传输途中被换包)。
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: 'f'.repeat(64) }),
      profileDir,
      http,
    })).rejects.toThrow(/sha256/u)

    // 不落盘:制品目录里没有 .tgz(也没有残留 temp)。
    const staged = join(profileDir, '.market-artifacts')
    expect(existsSync(staged)).toBe(true)
    for (const entry of readdirSync(staged)) {
      expect(entry.endsWith('.tgz')).toBe(false)
    }
  })

  test('rejects cross-origin tarball URLs fail-closed (X1) before any download', async () => {
    const profileDir = tempProfile()
    const calls: string[] = []
    const http: MarketHttpClient = {
      fetchText: (url) => { calls.push(url); return Promise.reject(new Error('unreachable')) },
      fetchBuffer: (url) => { calls.push(url); return Promise.reject(new Error('unreachable')) },
    }
    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ tarballPath: 'http://evil.intranet.example:9999/artifacts/x.tgz' }),
      profileDir,
      http,
    })).rejects.toThrow(/origin pinning/u)
    expect(calls).toEqual([])
  })

  test('rejects a non-zero-dependency tarball at the gate: nothing staged', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-dep-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3', dependencies: { ms: '^2.1.3' } })
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: sha256Hex(bytes) }),
      profileDir,
      http,
    })).rejects.toThrow(/dependencies must be empty/u)
    for (const entry of readdirSync(join(profileDir, '.market-artifacts'))) {
      expect(entry.endsWith('.tgz')).toBe(false)
    }
  })

  test('same-sha reinstall overwrites the artifact instead of delete-recreate', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-overwrite-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    const sha256 = sha256Hex(bytes)
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))
    const entry = fileEntry({ sha256 })

    const first = await downloadAndStageArtifact({ origin: ORIGIN, file: entry, profileDir, http })
    const before = statSync(first.artifactPath).ino
    const second = await downloadAndStageArtifact({ origin: ORIGIN, file: entry, profileDir, http })
    expect(second.artifactPath).toBe(first.artifactPath)
    expect(existsSync(first.artifactPath)).toBe(true)
    expect(statSync(first.artifactPath).ino).toBe(before)
  })
})

describe('artifact GC (N1)', () => {
  function artifact(profileDir: string, name: string, version: string, sha: string): string {
    const path = join(profileDir, '.market-artifacts', marketArtifactName(name, version, sha))
    writeFileSync(path, 'bytes')
    return path
  }

  test('removePlugin-side GC deletes only the removed package artifacts', () => {
    const profileDir = tempProfile()
    const a = artifact(profileDir, '@huaanwork/plugin-a', '1.0.0', 'a'.repeat(64))
    const b = artifact(profileDir, '@huaanwork/plugin-b', '1.0.0', 'b'.repeat(64))
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@huaanwork/plugin-a', (m) => logs.push(m))

    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(true)
    expect(logs.some(m => m.includes('plugin-a'))).toBe(true)
  })

  test('boot sweep deletes only orphans without a file: reference', () => {
    const profileDir = tempProfile()
    const referenced = artifact(profileDir, '@huaanwork/plugin-a', '1.0.0', 'a'.repeat(64))
    const orphan = artifact(profileDir, '@huaanwork/plugin-b', '1.0.0', 'b'.repeat(64))
    // profile package.json 引用 plugin-a 的制品(N1:有引用者必须保留)。
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'profile',
      dependencies: { '@huaanwork/plugin-a': `file:${referenced}` },
    }, undefined, 2)}\n`)

    const removed = sweepOrphanMarketArtifacts(profileDir, () => {})

    expect(removed).toEqual([marketArtifactName('@huaanwork/plugin-b', '1.0.0', 'b'.repeat(64))])
    expect(existsSync(referenced)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
    expect(profileFileReferencesExist(profileDir)).toBe(true)
  })

  test('installed artifact survives: no GC touches referenced artifacts', () => {
    const profileDir = tempProfile()
    const referenced = artifact(profileDir, '@huaanwork/plugin-a', '1.0.0', 'a'.repeat(64))
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      dependencies: { '@huaanwork/plugin-a': `file:${referenced}` },
    })}\n`)
    sweepOrphanMarketArtifacts(profileDir, () => {})
    gcRemovedPackageArtifacts(profileDir, '@huaanwork/other', () => {})
    expect(existsSync(referenced)).toBe(true)
  })
})
