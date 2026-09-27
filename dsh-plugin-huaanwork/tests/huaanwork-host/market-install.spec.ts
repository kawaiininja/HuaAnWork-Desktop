/**
 * install.ts 单元层:(c) 安装侧门正负例、sha256 比对、制品落盘/GC。
 * pnpm 层语义在 market-pnpm-semantics.spec.ts;wrapper e2e 在 market-e2e.spec.ts。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DesktopProfileCheckpoint,
  PROFILE_CHECKPOINT_USER_DATA_DIR_ENV,
} from '../../src/profile-checkpoint.ts'
import {
  ensureMarketArtifactsDir,
  gcRemovedPackageArtifacts,
  marketArtifactName,
  profileFileReferencesExist,
  sweepOrphanMarketArtifacts,
} from '../../src/huaanwork-host/market/artifacts.ts'
import { createFileRevisionStore, type MarketHttpClient } from '../../src/huaanwork-host/market/catalog-client.ts'
import {
  downloadAndStageArtifact,
  MarketInstallGateError,
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
  // 评审 D7:不预建 .market-artifacts——目录创建是被测代码(ensureMarketArtifactsDir)
  // 的职责,预建会让 0700 断言测到脚手架而非生产行为。
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

  // 评审 D6:解压上限。gunzipSync 不带 maxOutputLength 时,一个几十 KB 的
  // gzip 炸弹可在 Electron 主进程里膨胀到数十 GiB。回退该选项即红。
  test('caps decompression and says so instead of blaming gzip (review D6)', () => {
    // 65 MiB 均匀字节压到几十 KB,越过 64 MiB 上限(与发布侧同值)。
    const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024, 0x41))
    expect(bomb.length).toBeLessThan(1024 * 1024)

    let caught: unknown
    try {
      readTarballPackageJson(bomb)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(MarketInstallGateError)
    expect((caught as MarketInstallGateError).code).toBe('market-invalid-tarball')
    // 诚实报错:超限与「不是合法 gzip」是两件事,不得混为一谈。
    expect((caught as Error).message).toMatch(/decompresses beyond/u)
    expect((caught as Error).message).not.toMatch(/not a valid gzip/u)
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

    // 不落盘:拒绝路径不产生盘上副作用(目录未被创建,或其中没有任何 .tgz/残留 temp)。
    const staged = join(profileDir, '.market-artifacts')
    if (existsSync(staged)) {
      for (const entry of readdirSync(staged)) {
        expect(entry.endsWith('.tgz')).toBe(false)
      }
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
    // 拒绝路径不落盘(tempProfile 不再预建目录,见 D7):目录可能根本未被创建。
    const staged = join(profileDir, '.market-artifacts')
    if (existsSync(staged)) {
      for (const entry of readdirSync(staged)) {
        expect(entry.endsWith('.tgz')).toBe(false)
      }
    }
  })

  test('rejects manifest-entry-vs-tarball identity mismatch: nothing staged (D4/D5)', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-idmismatch-'))
    roots.push(dir)
    // tarball 自述 name/version 与已验签清单条目不一致(被换包/被篡改)。
    const bytes = buildTgz(dir, { name: '@huaanwork/other', version: '9.9.9' })
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: sha256Hex(bytes) }),
      profileDir,
      http,
    })).rejects.toThrow(/identity/u)

    const staged = join(profileDir, '.market-artifacts')
    if (existsSync(staged)) {
      for (const entry of readdirSync(staged)) {
        expect(entry.endsWith('.tgz')).toBe(false)
      }
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

describe('artifact dir mode (review D7)', () => {
  test('catalog read before install (production timing): revision persistence creates the dir 0700', () => {
    // 用户先浏览目录再安装是生产正常时序:saveMaxRevision 先于任何安装到达时,
    // 制品目录由它创建——必须 0700(修复前是 mkdirSync 无 mode 的 0755)。
    const profileDir = tempProfile()
    const store = createFileRevisionStore(profileDir, () => {})
    store.saveMaxRevision(ORIGIN, 1)
    expect(existsSync(join(profileDir, '.market-artifacts'))).toBe(true)
    expect(statSync(join(profileDir, '.market-artifacts')).mode & 0o777).toBe(0o700)
    expect(store.loadMaxRevision(ORIGIN)).toBe(1)
  })

  test('an existing 0755 artifact dir is forced back to 0700 on the next ensure', () => {
    const profileDir = tempProfile()
    const dir = join(profileDir, '.market-artifacts')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    ensureMarketArtifactsDir(profileDir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('artifact GC (N1)', () => {
  function artifact(profileDir: string, name: string, version: string, sha: string): string {
    // GC 用例不经过安装路径(tempProfile 已不预建目录),本 helper 自备目录。
    mkdirSync(join(profileDir, '.market-artifacts'), { recursive: true })
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

  test('GC prefix collision (N1, review round 1): uninstalling plugin-a never touches plugin-a-extra', () => {
    const profileDir = tempProfile()
    const a = artifact(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))
    // 相邻包:safeName `x/plugin-a` 是 `x/plugin-a-extra` 制品名的裸前缀。
    const extra = artifact(profileDir, '@x/plugin-a-extra', '2.0.0', 'e'.repeat(64))
    // extra 已装,profile 里有指向其制品的 file: 引用(卸载 a 后必须仍可解析)。
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'profile',
      dependencies: { '@x/plugin-a-extra': `file:${extra}` },
    }, undefined, 2)}\n`)
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', (m) => logs.push(m))

    // a 的制品被 GC;extra 的制品与引用全部存活——后续 pnpm 操作不会 ENOENT。
    expect(existsSync(a)).toBe(false)
    expect(existsSync(extra)).toBe(true)
    expect(profileFileReferencesExist(profileDir)).toBe(true)
    expect(logs.some(m => m.includes('x-plugin-a-1.0.0') && m.includes('removed artifact'))).toBe(true)
    expect(logs.some(m => m.includes('x-plugin-a-extra'))).toBe(false)
  })

  test('GC boundary: prerelease versions still match exactly; non-semver lookalikes never match', () => {
    const profileDir = tempProfile()
    const stable = artifact(profileDir, '@x/pkg', '1.0.0', '1'.repeat(64))
    const prerelease = artifact(profileDir, '@x/pkg', '1.0.0-beta.2', '2'.repeat(64))
    // 命名陷阱:裸前缀 `x/pkg-` 命中,但 `notsemver` 不是版本 ⇒ 不得删。
    writeFileSync(join(profileDir, '.market-artifacts', 'x-pkg-notsemver-' + '3'.repeat(12) + '.tgz'), 'x')
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@x/pkg', (m) => logs.push(m))

    expect(existsSync(stable)).toBe(false)
    expect(existsSync(prerelease)).toBe(false)
    expect(existsSync(join(profileDir, '.market-artifacts', 'x-pkg-notsemver-' + '3'.repeat(12) + '.tgz'))).toBe(true)
  })

  test('GC version span: publish gate accepts filename-safe versions, so 1.0/1 two-segment artifacts are GC-able too', () => {
    // gate.ts PACKAGE_VERSION_PATTERN 只要求 filename-safe(`1.0` 合法可发布);
    // GC 版本面必须对齐,否则卸载后制品漏删(只能等下次启动孤儿清扫)。
    const profileDir = tempProfile()
    const one = artifact(profileDir, '@x/pkg', '1.0', '4'.repeat(64))
    const bare = artifact(profileDir, '@x/pkg', '1', '5'.repeat(64))
    const fourSegment = artifact(profileDir, '@x/pkg', '1.0.0.1', '6'.repeat(64))
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@x/pkg', (m) => logs.push(m))

    expect(existsSync(one)).toBe(false)
    expect(existsSync(bare)).toBe(false)
    // 四段 `1.0.0.1` 超出点分 1–3 段面(也非合法发布版本形态)⇒ 保守不删。
    expect(existsSync(fourSegment)).toBe(true)
    expect(logs.some(m => m.includes('x-pkg-1.0-') && m.includes('removed artifact'))).toBe(true)
    expect(logs.some(m => m.includes('x-pkg-1-') && m.includes('removed artifact'))).toBe(true)
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

describe('artifact GC × profile checkpoint (review D9)', () => {
  function artifactFile(profileDir: string, name: string, version: string, sha: string): string {
    mkdirSync(join(profileDir, '.market-artifacts'), { recursive: true })
    const path = join(profileDir, '.market-artifacts', marketArtifactName(name, version, sha))
    writeFileSync(path, 'bytes')
    return path
  }

  function profileManifest(dependencies: Record<string, string>): string {
    return `${JSON.stringify({ name: 'profile', dependencies }, undefined, 2)}\n`
  }

  test('an artifact referenced by a checkpoint slot survives uninstall GC and boot sweep; GC resumes once the checkpoint reference is gone', () => {
    const profileDir = tempProfile()
    const userDataDir = mkdtempSync(join(tmpdir(), 'hw-market-checkpoint-'))
    roots.push(userDataDir)
    const a = artifactFile(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))

    // ① 安装态:profile package.json 引用 A 的制品。
    writeFileSync(join(profileDir, 'package.json'), profileManifest({ '@x/plugin-a': `file:${a}` }))
    // ② 健康启动 captureHealthy:真实写路径产出含该引用的 slot 快照。
    const checkpoint = new DesktopProfileCheckpoint({
      userDataDir,
      profileDir,
      profileName: 'test-profile',
      provider: 'desktop-profile',
    })
    expect(checkpoint.captureHealthy().status).toBe('captured')
    // ③ 卸载结果态:当前 profile 中的引用已消失(只剩 checkpoint slot 持有)。
    writeFileSync(join(profileDir, 'package.json'), profileManifest({}))

    // main 进程注入的 env(生产由 main.ts 赋值;此处直接模拟)。
    process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV] = userDataDir
    try {
      // 卸载 GC 必须保留 A:某个 checkpoint slot 仍引用它,restoreSlot 后物化
      // 依赖要靠它(删了 ⇒ 恢复后 pnpm 确定性 ENOENT,D9 失效模式)。
      gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', () => {})
      expect(existsSync(a)).toBe(true)
      // 启动孤儿清扫同样必须保留 A。
      expect(sweepOrphanMarketArtifacts(profileDir, () => {})).toEqual([])
      expect(existsSync(a)).toBe(true)
      expect(profileFileReferencesExist(profileDir)).toBe(true)

      // ④ checkpoint 引用失效(如该 profile 的 checkpoint 被清空)⇒ GC 恢复收集。
      rmSync(checkpoint.profileRoot, { recursive: true, force: true })
      const logs: string[] = []
      gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', (m) => logs.push(m))
      expect(existsSync(a)).toBe(false)
      expect(logs.some(m => m.includes('x-plugin-a-1.0.0') && m.includes('removed artifact'))).toBe(true)
    } finally {
      delete process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]
    }
  })

  test('env unset (non-Desktop host) keeps the pre-D9 checkpoint-blind behavior', () => {
    const profileDir = tempProfile()
    const a = artifactFile(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))
    delete process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]

    gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', () => {})
    expect(existsSync(a)).toBe(false)
  })

  // 评审 D9 指定而我方修复轮漏掉的最后一环:前一个测试只断言「GC 没删」,
  // 从不真正 restore。此处走完 装 A → 快照 → 卸 A(GC) → restoreSlot → 引用仍可
  // 解析 的完整四步。回退保留判据(退回 profile-only)即红:GC 会在 restore 之前
  // 删掉 A,恢复后的 package.json 便指向不存在的制品,物化依赖确定性 ENOENT。
  test('a checkpoint restore after uninstall GC still resolves the artifact reference (review D9, full cycle)', () => {
    const profileDir = tempProfile()
    const userDataDir = mkdtempSync(join(tmpdir(), 'hw-market-restore-'))
    roots.push(userDataDir)
    const a = artifactFile(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))

    writeFileSync(join(profileDir, 'package.json'), profileManifest({ '@x/plugin-a': `file:${a}` }))
    const checkpoint = new DesktopProfileCheckpoint({
      userDataDir,
      profileDir,
      profileName: 'test-profile',
      provider: 'desktop-profile',
    })
    const captured = checkpoint.captureHealthy()
    expect(captured.status).toBe('captured')
    if (captured.status !== 'captured') return
    // 卸载结果态:当前 profile 的引用消失,只剩 checkpoint slot 持有。
    writeFileSync(join(profileDir, 'package.json'), profileManifest({}))

    process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV] = userDataDir
    try {
      gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', () => {})
      expect(existsSync(a)).toBe(true)

      // 用户在恢复窗口选回该 slot:旧 package.json(含 A 的 file: 引用)被写回。
      const restored = checkpoint.restoreSlot(captured.slotId)
      expect(restored.status).toBe('restored')
      expect(restored.dependencyMaterializationRequired).toBe(true)

      // D9 的承重点:引用回来了,制品也还在盘上 ⇒ 后续物化 pnpm 不会 ENOENT。
      const restoredManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(restoredManifest.dependencies?.['@x/plugin-a']).toBe(`file:${a}`)
      expect(existsSync(a)).toBe(true)
      expect(profileFileReferencesExist(profileDir)).toBe(true)
    } finally {
      delete process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]
    }
  })

  // 上一条的 profileFileReferencesExist 断言只有在「制品缺失时返回 false」的前提下
  // 才有意义——否则它对任何 profile 都真(无 file: 引用时空集恒真)。此处钉住其牙齿。
  test('profileFileReferencesExist is false when a referenced artifact is missing (assertion has teeth)', () => {
    const profileDir = tempProfile()
    const ghost = join(profileDir, '.market-artifacts', 'x-plugin-a-1.0.0-aaaaaaaaaaaa.tgz')
    writeFileSync(join(profileDir, 'package.json'), profileManifest({ '@x/plugin-a': `file:${ghost}` }))
    expect(existsSync(ghost)).toBe(false)
    expect(profileFileReferencesExist(profileDir)).toBe(false)
  })
})
