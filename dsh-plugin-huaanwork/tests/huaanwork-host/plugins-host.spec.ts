import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DesktopPnpmHandle } from '../../src/pnpm.ts'
import { withDesktopPnpmPolicy } from '../../src/pnpm-policy.ts'
import { DesktopProfileCheckpoint, PROFILE_CHECKPOINT_USER_DATA_DIR_ENV } from '../../src/profile-checkpoint.ts'
import {
  addPlugin,
  IMMUTABLE_BUNDLES,
  PluginCommandError,
  removePlugin,
  type AddPluginOptions,
  type PluginMutationContext,
  type PluginMutationResult,
} from '../../src/huaanwork-host/plugins-host.ts'
import {
  gcRemovedPackageArtifacts,
  marketArtifactName,
  profileFileReferencesExist,
  sweepOrphanMarketArtifacts,
} from '../../src/huaanwork-host/market/artifacts.ts'
import { readTarballPackageJson } from '../../src/huaanwork-host/market/install.ts'
import { ROUTE_TABLE, RouteError, type RouteContext } from '../../src/huaanwork-host/routes.ts'
import {
  createMarketSandbox,
  disposeAllMarketSandboxes,
  fileReferenceExists,
  fileReferenceFor,
  type MarketSandbox,
} from './market-pnpm-fixture.ts'
import { sha256Hex } from './market-test-server.ts'

const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 随包分发的生产 pnpm(DesktopPnpmService 用的就是它;11.8.0)。 */
const BUNDLED_PNPM = fileURLToPath(new URL('../../node_modules/pnpm/bin/pnpm.mjs', import.meta.url))

let homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-plugins-host-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
  disposeAllMarketSandboxes()
})

function writeProfile(profileDir: string, bundles: string[]): void {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ dsh: { profile: { bundles } } })}\n`)
}

function writePluginDir(root: string, name = 'demo-plugin', version = '1.0.0'): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    dsh: { bundle: { id: name } },
  }))
  return dir
}

/**
 * 真实 tar.gz(npm 形态 `package/` 根,与 market-install.spec 同构造):本地 `.tgz`
 * 源的身份由包内 package.json 读出(Task 6.2),故不能用假字节。
 */
function writeLocalTgz(root: string, name: string, version: string): string {
  const buildRoot = join(root, `${name.replace(/[@/]/gu, '-')}-${version}-source`)
  const pkgDir = join(buildRoot, 'package')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify({ name, version }, undefined, 2)}\n`)
  const out = join(buildRoot, `${name.replace(/[@/]/gu, '-')}-${version}.tgz`)
  const tar = spawnSync('tar', ['czf', out, 'package'], { cwd: buildRoot, encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`plugins-host fixture: tar failed: ${tar.stderr}`)
  return out
}

function completedHandle(exitCode = 0): DesktopPnpmHandle {
  return {
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    done: Promise.resolve({ exitCode, signal: null }),
    cancel() {},
  }
}

/** makeCtx 的 `run` 桩写进 `--pack-destination` 的字节(= 目录源 pack 产物的替身)。 */
const PACKED_BYTES = Buffer.from('packed-local-plugin-bytes')

/** 目录源 pack 后应落成的制品路径(与落盘实现共用同一命名函数与 sha 口径)。 */
function stagedPathFor(profileDir: string, name: string, version: string, bytes = PACKED_BYTES): string {
  return join(profileDir, '.market-artifacts', marketArtifactName(name, version, sha256Hex(bytes)))
}

/**
 * 本地安装的桩执行器。`runPlugin` 由用例给定;`run`(本地目录源的 `pnpm pack`)
 * 把 {@link PACKED_BYTES} 写进 `--pack-destination` 后成功返回——与生产
 * `DesktopPnpmService.run` 的可观测契约一致(pack 只往目的地写 tarball)。
 */
function makeCtx(
  profileDir: string,
  runPlugin: (argv: readonly string[], invokingDir: string, signal?: AbortSignal) => DesktopPnpmHandle,
  restart = true,
) {
  const run = vi.fn((argv: readonly string[]) => {
    const destination = argv[argv.indexOf('--pack-destination') + 1]
    if (destination !== undefined) writeFileSync(join(destination, 'packed.tgz'), PACKED_BYTES)
    return completedHandle()
  })
  const requestRestart = vi.fn(async () => restart)
  return {
    profileDir,
    logger: vi.fn(),
    requestRestart,
    desktopPnpm: { runPlugin: vi.fn(runPlugin), run },
  }
}

describe('plugin add/remove', () => {
  test('add 拒绝远程来源,且不调用 runPlugin、不改 profile', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const before = readFileSync(join(profileDir, 'package.json'))
    const ctx = makeCtx(profileDir, () => completedHandle())
    for (const source of [
      'github:org/demo',
      'git+https://example.com/demo.git',
      'https://example.com/demo.tgz',
      'http://example.com/demo.tgz',
    ]) {
      await expect(addPlugin(ctx, source)).rejects.toThrow(`remote plugin sources are not allowed: ${source}`)
    }
    expect(ctx.desktopPnpm.runPlugin).not.toHaveBeenCalled()
    expect(ctx.requestRestart).not.toHaveBeenCalled()
    expect(readFileSync(join(profileDir, 'package.json'))).toEqual(before)
  })

  test('add 校验本地目录:缺 package.json、缺 name、缺 version、缺 dsh.bundle 都拒绝,profile 不改', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const before = readFileSync(join(profileDir, 'package.json'))
    const ctx = makeCtx(profileDir, () => completedHandle())

    const missing = join(makeHome(), 'missing')
    mkdirSync(missing)
    await expect(addPlugin(ctx, missing)).rejects.toThrow('plugin source is not a local package')

    const nameless = join(makeHome(), 'nameless')
    mkdirSync(nameless)
    writeFileSync(join(nameless, 'package.json'), JSON.stringify({ dsh: { bundle: { id: 'x' } } }))
    await expect(addPlugin(ctx, nameless)).rejects.toThrow('plugin package.json is missing name')

    const plain = join(makeHome(), 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'plain' }))
    await expect(addPlugin(ctx, plain)).rejects.toThrow('package must declare dsh.bundle')

    // Task 6.2:制品名是 <name>-<version>-<sha12>.tgz,没有版本就无处落盘。
    const versionless = join(makeHome(), 'versionless')
    mkdirSync(versionless)
    writeFileSync(join(versionless, 'package.json'), JSON.stringify({ name: 'versionless', dsh: { bundle: { id: 'x' } } }))
    await expect(addPlugin(ctx, versionless)).rejects.toThrow('plugin package.json is missing version')

    expect(ctx.desktopPnpm.runPlugin).not.toHaveBeenCalled()
    expect(ctx.desktopPnpm.run).not.toHaveBeenCalled()
    expect(ctx.requestRestart).not.toHaveBeenCalled()
    expect(readFileSync(join(profileDir, 'package.json'))).toEqual(before)
  })

  test('add 把本地源**制品化后**的路径透传给 runPlugin(源路径不再进 argv)', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    const tarball = writeLocalTgz(makeHome(), 'demo-tarball', '2.0.0')
    const seen: string[][] = []
    const ctx = makeCtx(profileDir, (argv) => {
      seen.push([...argv])
      return completedHandle()
    })

    await addPlugin(ctx, pluginDir)
    await addPlugin(ctx, tarball)

    // 目录源:pack 产物(PACKED_BYTES)落成制品;.tgz 源:字节原样复制成制品。
    const stagedDir = stagedPathFor(profileDir, 'demo-plugin', '1.0.0')
    const stagedTarball = stagedPathFor(profileDir, 'demo-tarball', '2.0.0', readFileSync(tarball))
    expect(seen).toEqual([
      ['add', stagedDir],
      ['add', stagedTarball],
    ])
    // 源路径不再出现在 argv 里(悬空 file: 引用的根因)。
    expect(seen.some((argv) => argv.includes(resolve(pluginDir)) || argv.includes(resolve(tarball)))).toBe(false)
    expect(ctx.desktopPnpm.runPlugin).toHaveBeenCalledWith(['add', stagedDir], resolve(profileDir))
    expect(ctx.desktopPnpm.runPlugin).toHaveBeenCalledWith(['add', stagedTarball], resolve(profileDir))
  })

  test('add offline:true 追加 --offline --ignore-scripts;不传时 argv 不变(M4 语义不变)', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    const seen: string[][] = []
    const ctx = makeCtx(profileDir, (argv) => {
      seen.push([...argv])
      return completedHandle()
    })

    await addPlugin(ctx, pluginDir, { offline: true })
    await addPlugin(ctx, pluginDir)

    const staged = stagedPathFor(profileDir, 'demo-plugin', '1.0.0')
    expect(seen).toEqual([
      ['add', staged, '--offline', '--ignore-scripts'],
      ['add', staged],
    ])
  })

  test('取消路径应答的 bundles 与安装前一致,不置 restarting,并诚实告知下次启动生效', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome(), 'demo-plugin')
    const ctx = makeCtx(profileDir, () => {
      writeProfile(profileDir, [...BASE_BUNDLES, 'demo-plugin'])
      return completedHandle()
    }, false)

    const result = await addPlugin(ctx, pluginDir)

    expect(result.bundles).toEqual(BASE_BUNDLES)
    expect(result.message).toBe('已取消重启：插件已写入清单，下次启动时生效')
    expect(result).not.toHaveProperty('restarting')
    expect(ctx.requestRestart).toHaveBeenCalledOnce()
  })

  test('确认路径返回安装后清单且 restarting 为 true', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome(), 'demo-plugin')
    const ctx = makeCtx(profileDir, () => {
      writeProfile(profileDir, [...BASE_BUNDLES, 'demo-plugin'])
      return completedHandle()
    }, true)

    const result = await addPlugin(ctx, pluginDir)

    expect(result.bundles.length).toBeGreaterThan(0)
    expect(result).toEqual({ bundles: [...BASE_BUNDLES, 'demo-plugin'], restarting: true })
  })

  test('目录安装推断出新名字时确认体不带 message', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome(), 'demo-plugin')
    const ctx = makeCtx(profileDir, () => {
      writeProfile(profileDir, [])
      return completedHandle()
    }, true)

    const result = await addPlugin(ctx, pluginDir)

    expect(result).toEqual({ bundles: [...BASE_BUNDLES, 'demo-plugin'], restarting: true })
    expect(result).not.toHaveProperty('message')
  })

  test('读不到新清单且无法推断时注明 message,不回空数组', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    // .tgz 源不参与清单推断(沿用 M4,见 stageLocalPluginSource 的 packageName 说明)。
    const tarball = writeLocalTgz(makeHome(), 'demo-tarball', '1.0.0')
    const previous = makeCtx(profileDir, () => {
      writeProfile(profileDir, [])
      return completedHandle()
    }, true)

    const unchanged = await addPlugin(previous, tarball)

    expect(unchanged.restarting).toBe(true)
    expect(unchanged.bundles).toEqual(BASE_BUNDLES)
    expect(unchanged.message).toBe('could not read a non-empty installed bundle list; returning the previous list')

    writeProfile(profileDir, BASE_BUNDLES)
    const alreadyNamed = writePluginDir(makeHome(), '@deepseek-ai/dsh-base')
    const already = makeCtx(profileDir, () => {
      writeProfile(profileDir, [])
      return completedHandle()
    }, true)
    const present = await addPlugin(already, alreadyNamed)

    expect(present.restarting).toBe(true)
    expect(present.bundles).toEqual(BASE_BUNDLES)
    expect(present.message).toBe('could not read a non-empty installed bundle list; returning the previous list')

    writeProfile(profileDir, [])
    const emptyBefore = makeCtx(profileDir, () => {
      writeProfile(profileDir, [])
      return completedHandle()
    }, true)
    const fallback = await addPlugin(emptyBefore, tarball)

    expect(fallback.restarting).toBe(true)
    expect(fallback.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(fallback.message).toBe('could not read a non-empty installed bundle list; returning the profile fallback')
  })

  test('route plugin.add 把单并发冲突映成 409,不排队', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    const route = ROUTE_TABLE.find((entry) => entry.method === 'plugin.add')!
    const ctx = {
      dshHome: profileDir,
      profileDir,
      workspaceRoot: { current: profileDir },
      emit: () => {},
      logger: () => {},
      requestRestart: async () => true,
      desktopPnpm: {
        // 本地目录源先 pack(run)——桩成功写出 pack 产物,冲突由 runPlugin 抛出。
        run: (argv: readonly string[]) => {
          const destination = argv[argv.indexOf('--pack-destination') + 1]
          if (destination !== undefined) writeFileSync(join(destination, 'packed.tgz'), PACKED_BYTES)
          return completedHandle()
        },
        runPlugin: () => {
          throw new Error('dsh-plugin-desktop: another desktop pnpm operation is already running')
        },
      },
    } satisfies RouteContext
    await expect(route.handler({
      params: {},
      body: { source: pluginDir },
      query: new URLSearchParams(),
    }, ctx)).rejects.toBeInstanceOf(RouteError)
    await expect(route.handler({
      params: {},
      body: { source: pluginDir },
      query: new URLSearchParams(),
    }, ctx)).rejects.toMatchObject({ status: 409, code: 'pnpm-busy' })
  })

  test('runPlugin 失败时不重启,profile 不被本函数改写', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const before = readFileSync(join(profileDir, 'package.json'))
    const pluginDir = writePluginDir(makeHome())
    const ctx = makeCtx(profileDir, () => completedHandle(1))

    await expect(addPlugin(ctx, pluginDir)).rejects.toThrow('dsh plugin add failed (exit 1)')
    expect(ctx.requestRestart).not.toHaveBeenCalled()
    expect(readFileSync(join(profileDir, 'package.json'))).toEqual(before)
  })

  test('单并发的第二次 runPlugin 返回 409,不排队', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate
    })
    let calls = 0
    const ctx = makeCtx(profileDir, () => {
      calls += 1
      if (calls > 1) {
        throw new Error('dsh-plugin-desktop: another desktop pnpm operation is already running')
      }
      return {
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: gate.then(() => ({ exitCode: 0, signal: null })),
        cancel() {},
      }
    })

    const first = addPlugin(ctx, pluginDir)
    const second = addPlugin(ctx, pluginDir)
    await expect(second).rejects.toMatchObject({ status: 409, code: 'pnpm-busy' })
    await expect(second).rejects.toBeInstanceOf(PluginCommandError)
    expect(ctx.requestRestart).not.toHaveBeenCalled()
    releaseFirst()
    await expect(first).resolves.toMatchObject({ bundles: BASE_BUNDLES, restarting: true })
  })

  test('没有 desktopPnpm 时诚实 503', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    const ctx: PluginMutationContext = {
      profileDir,
      logger: () => {},
      requestRestart: async () => true,
    }
    await expect(addPlugin(ctx, pluginDir)).rejects.toMatchObject({
      status: 503,
      code: 'pnpm-unavailable',
    })
  })

  test('runtimeCtx.get("desktopPnpm") 可充当执行器', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    const runPlugin = vi.fn(() => completedHandle())
    const run = vi.fn((argv: readonly string[]) => {
      const destination = argv[argv.indexOf('--pack-destination') + 1]
      if (destination !== undefined) writeFileSync(join(destination, 'packed.tgz'), PACKED_BYTES)
      return completedHandle()
    })
    const ctx: PluginMutationContext = {
      profileDir,
      logger: () => {},
      requestRestart: async () => false,
      runtimeCtx: { get: (name: string) => (name === 'desktopPnpm' ? { runPlugin, run } : undefined) },
    }
    await expect(addPlugin(ctx, pluginDir)).resolves.toMatchObject({
      bundles: BASE_BUNDLES,
      message: expect.stringContaining('下次启动时生效'),
    })
    expect(runPlugin).toHaveBeenCalledWith(['add', stagedPathFor(profileDir, 'demo-plugin', '1.0.0')], resolve(profileDir))
  })

  test('目录源缺 run(只有 runPlugin)时诚实 503,不退化成直接安装源路径', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    const ctx = {
      profileDir,
      logger: vi.fn(),
      requestRestart: async () => true,
      desktopPnpm: { runPlugin: vi.fn(() => completedHandle()) },
    } satisfies PluginMutationContext

    // 退回旧行为 = 把源路径交给 pnpm ⇒ 悬空 file: 引用(正是本 Task 修的缺陷),故 fail-closed。
    await expect(addPlugin(ctx, pluginDir)).rejects.toMatchObject({
      status: 503,
      code: 'pnpm-unavailable',
    })
    expect(ctx.desktopPnpm.runPlugin).not.toHaveBeenCalled()
  })

  test('P2: add 后清单不可读(ENOENT)时,不把模板兜底当作安装结果', async () => {
    const profileDir = makeHome()
    // before 含自定义 bundle,与 fallbackProfileBundles() 模板必然可区分。
    const before = ['@deepseek-ai/dsh-base', 'custom-bundle']
    writeProfile(profileDir, before)
    const pluginDir = writePluginDir(makeHome())
    const ctx = makeCtx(profileDir, () => {
      // pnpm add 成功但重读时 <profileDir>/package.json 缺失:ENOENT。
      rmSync(join(profileDir, 'package.json'))
      return completedHandle()
    }, true)

    const result = await addPlugin(ctx, pluginDir)

    // 推断分支:上份清单 + 推断出的新包——模板兜底不得混入。
    expect(result.bundles).toEqual([...before, 'demo-plugin'])
    expect(result.bundles).not.toContain('@deepseek-ai/dsh-web-app')
  })

  test('P2: remove 后清单不可读(ENOENT)时,回过滤后的上份清单而非模板', async () => {
    const profileDir = makeHome()
    const before = ['@deepseek-ai/dsh-base', 'custom-bundle', 'demo-plugin']
    writeProfile(profileDir, before)
    const ctx = makeCtx(profileDir, () => {
      rmSync(join(profileDir, 'package.json'))
      return completedHandle()
    }, true)

    const result = await removePlugin(ctx, 'demo-plugin')

    expect(result.bundles).toEqual(['@deepseek-ai/dsh-base', 'custom-bundle'])
    expect(result.bundles).not.toContain('@deepseek-ai/dsh-web-app')
  })

  test('IMMUTABLE_BUNDLES 拒绝卸载,不调用 runPlugin,profile 不改', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const before = readFileSync(join(profileDir, 'package.json'))
    const ctx = makeCtx(profileDir, () => completedHandle())
    for (const name of [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-desktop-app',
      'dsh-plugin-huaanwork',
      'dsh-community-market',
    ]) {
      expect(IMMUTABLE_BUNDLES.has(name)).toBe(true)
      await expect(removePlugin(ctx, name)).rejects.toThrow(`cannot remove protected package ${name}`)
    }
    expect(ctx.desktopPnpm.runPlugin).not.toHaveBeenCalled()
    expect(ctx.requestRestart).not.toHaveBeenCalled()
    expect(readFileSync(join(profileDir, 'package.json'))).toEqual(before)
  })

  test('remove 透传包名;取消回安装前清单,确认回卸载后清单并 restarting', async () => {
    const profileDir = makeHome()
    const before = [...BASE_BUNDLES, 'demo-plugin']
    writeProfile(profileDir, before)
    const ctx = makeCtx(profileDir, () => {
      writeProfile(profileDir, BASE_BUNDLES)
      return completedHandle()
    }, false)

    const cancelled = await removePlugin(ctx, 'demo-plugin')
    expect(cancelled.bundles).toEqual(before)
    expect(cancelled.message).toBe('已取消重启：插件已从清单移除，下次启动时不再加载')
    expect(cancelled).not.toHaveProperty('restarting')
    expect(ctx.desktopPnpm.runPlugin).toHaveBeenCalledWith(['remove', 'demo-plugin'], resolve(profileDir))

    ctx.requestRestart.mockResolvedValue(true)
    writeProfile(profileDir, before)
    const confirmed = await removePlugin(ctx, 'demo-plugin')
    expect(confirmed).toEqual({ bundles: BASE_BUNDLES, restarting: true })
  })

  test('确认卸载读到空清单时注明推断移除,不回空数组', async () => {
    const profileDir = makeHome()
    const before = [...BASE_BUNDLES, 'demo-plugin']
    writeProfile(profileDir, before)
    const ctx = makeCtx(profileDir, () => {
      writeProfile(profileDir, [])
      return completedHandle()
    }, true)

    const result = await removePlugin(ctx, 'demo-plugin')

    expect(result).toEqual({
      bundles: BASE_BUNDLES,
      restarting: true,
      message: 'could not read a non-empty installed bundle list; inferred the removed package from the previous list',
    })
    expect(result.bundles).not.toContain('demo-plugin')
    expect(result.bundles).not.toEqual([])
  })

  test('确认卸载过滤后为空时仍回上一份清单,不称推断', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, ['demo-plugin'])
    const ctx = makeCtx(profileDir, () => {
      writeProfile(profileDir, [])
      return completedHandle()
    }, true)

    const result = await removePlugin(ctx, 'demo-plugin')

    expect(result).toEqual({
      bundles: ['demo-plugin'],
      restarting: true,
      message: 'could not read a non-empty installed bundle list; returning the previous list',
    })
  })
})

// ---------------------------------------------------------------------------
// 本地安装的制品化(Task 6.2,裁定 R-2;spec §14 第 42/48/50 条)。
//
// 门形与市场路径同款:真 profile(initProfile 产物)+ 真 pnpm(**随包分发的
// 11.8.0**,生产用的就是它;`--store-dir`/`--cache-dir` 密封)+「装 A → 装 B →
// 卸 A → 卸 B」四步 + 每步 `file:` 目标存在断言。经 addPlugin/removePlugin
// 真实代码路径(桩只负责把 argv 转成真 pnpm 子进程,与 market-e2e 同构)。
// ---------------------------------------------------------------------------

interface LocalPnpmStub {
  readonly calls: string[][]
  readonly output: string[]
  readonly pnpm: {
    runPlugin(argv: readonly string[], invokingDir: string): DesktopPnpmHandle
    run(argv: readonly string[]): DesktopPnpmHandle
  }
}

function localCtx(sandbox: MarketSandbox, stub: LocalPnpmStub, confirmed = true) {
  return {
    profileDir: sandbox.profileDir,
    logger: () => {},
    desktopPnpm: stub.pnpm,
    requestRestart: () => Promise.resolve(confirmed),
  }
}

/**
 * 真 pnpm 桩(随包 11.8.0):
 * - `runPlugin` 等价生产 `dsh plugin --profile X <argv>`(harness CLI 直通 pnpm),
 *   追加密封 store/cache(安装/卸载必须与机器缓存状态无关);
 * - `run` 等价生产 `DesktopPnpmService.run`(argv 先过 Desktop 策略前缀,cwd 恒为
 *   profileDir——故本地目录源用 `-C` 指向源目录);pack 不吃 store/cache 选项,
 *   故不追加(生产 run 也不加)。
 * 每次调用的输出留存,供失败断言展示根因(pnpm 的运行时错误在非 TTY 下写 stdout)。
 */
function bundledLocalPnpmStub(sandbox: MarketSandbox): LocalPnpmStub {
  const calls: string[][] = []
  const output: string[] = []
  const sealed = ['--store-dir', sandbox.storeDir, '--cache-dir', sandbox.cacheDir]
  const spawnHandle = (argv: readonly string[], cwd: string, withSealedStore: boolean): DesktopPnpmHandle => {
    calls.push([...argv])
    const fullArgv = withSealedStore ? [...argv, ...sealed] : [...argv]
    const run = spawnSync(process.execPath, [BUNDLED_PNPM, ...fullArgv], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      maxBuffer: 16 * 1024 * 1024,
    })
    output.push(`${run.stdout ?? ''}\n${run.stderr ?? ''}`)
    return completedHandle(run.status ?? -1)
  }
  return {
    calls,
    output,
    pnpm: {
      runPlugin: (argv, invokingDir) => spawnHandle(argv, invokingDir, true),
      run: (argv) => spawnHandle(withDesktopPnpmPolicy(argv), sandbox.profileDir, false),
    },
  }
}

/**
 * 装一个本地源,失败时把 pnpm 输出(`ENOENT` 等根因写在 stdout)一并交出——
 * 缺陷的活体证明要看得见,而不只是一个 exit code。
 */
async function localAdd(
  ctx: PluginMutationContext,
  source: string,
  stub: LocalPnpmStub,
  opts?: AddPluginOptions,
): Promise<{ result?: PluginMutationResult; failure?: string }> {
  try {
    return { result: await addPlugin(ctx, source, opts) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { failure: `${message}\n--- pnpm output ---\n${stub.output.join('\n')}` }
  }
}

/** 本地目录源(带 dsh.bundle 声明的工程目录)。 */
function localPluginDir(sandbox: MarketSandbox, name: string, version: string): string {
  const dir = join(sandbox.root, `local-source-${name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version, dsh: { bundle: { id: name } } }, undefined, 2)}\n`)
  return dir
}

function countTarballs(dir: string): number {
  return readdirSync(dir).filter((entry) => entry.endsWith('.tgz')).length
}

describe('local plugin installs survive their source disappearing', () => {
  test('stages a local tarball into .market-artifacts before installing', async () => {
    const sandbox = createMarketSandbox()
    const source = sandbox.buildTarball({ name: 'local-stage-a', version: '1.0.0' })
    const stub = bundledLocalPnpmStub(sandbox)

    const added = await localAdd(localCtx(sandbox, stub), source.path, stub)

    expect(added.failure).toBeUndefined()
    expect(added.result?.restarting).toBe(true)
    // 引用指向 <profileDir>/.market-artifacts/<name>-<version>-<sha12>.tgz,**不是**源路径。
    const staged = stagedPathFor(sandbox.profileDir, 'local-stage-a', '1.0.0', readFileSync(source.path))
    const dependencies = sandbox.readProfileDependencies()
    expect(dependencies['local-stage-a']).toBe(`file:${staged}`)
    expect(dependencies['local-stage-a']).not.toContain(source.path)
    expect(fileReferenceExists(sandbox.profileDir, dependencies)).toBe(true)
    // 落盘字节 = 源字节;0600 且目录 0700(与市场制品同布局)。
    expect(readFileSync(staged).equals(readFileSync(source.path))).toBe(true)
    expect(statSync(staged).mode & 0o777).toBe(0o600)
    expect(statSync(sandbox.artifactsDir).mode & 0o777).toBe(0o700)
    // argv:装的是制品,且本地路径不带 market 的两 flag。
    const addCalls = stub.calls.filter((call) => call[0] === 'add')
    expect(addCalls).toHaveLength(1)
    expect(addCalls[0]?.[1]).toBe(staged)
    expect(addCalls[0]).not.toContain('--offline')
    expect(addCalls[0]).not.toContain('--ignore-scripts')
  }, 120_000)

  test('keeps working after the user deletes the original tarball', async () => {
    const sandbox = createMarketSandbox()
    const first = sandbox.buildTarball({ name: 'local-survives-a', version: '1.0.0' })
    const second = sandbox.buildTarball({ name: 'local-survives-b', version: '1.0.0' })
    const stub = bundledLocalPnpmStub(sandbox)
    const ctx = localCtx(sandbox, stub)

    expect((await localAdd(ctx, first.path, stub)).failure).toBeUndefined()
    // 用户删掉了源 .tgz(移动/清理/换机都会发生)。
    rmSync(first.path)

    // 修之前:pnpm 重解析 A 的悬空 file: 引用 ⇒ ENOENT / EXIT=254,第二次安装确定性失败。
    const afterSourceGone = await localAdd(ctx, second.path, stub)
    expect(afterSourceGone.failure).toBeUndefined()
    expect(afterSourceGone.result?.restarting).toBe(true)

    const dependencies = sandbox.readProfileDependencies()
    expect(Object.keys(dependencies).sort()).toEqual(['local-survives-a', 'local-survives-b'])
    expect(fileReferenceExists(sandbox.profileDir, dependencies)).toBe(true)
    expect(countTarballs(sandbox.artifactsDir)).toBe(2)
  }, 120_000)

  test('survives the four-step install/uninstall cycle with file: references intact', async () => {
    const sandbox = createMarketSandbox()
    const first = sandbox.buildTarball({ name: 'local-cycle-a', version: '1.0.0' })
    const second = sandbox.buildTarball({ name: 'local-cycle-b', version: '2.0.0' })
    const stub = bundledLocalPnpmStub(sandbox)
    const ctx = localCtx(sandbox, stub)
    const artifactsPrefix = `${join(sandbox.profileDir, '.market-artifacts')}${sep}`

    /** 每一步都断言:剩余条目的 `file:` 目标在盘上,且都指向制品目录。 */
    const assertReferencesIntact = (expected: number): void => {
      const dependencies = sandbox.readProfileDependencies()
      expect(Object.keys(dependencies)).toHaveLength(expected)
      expect(fileReferenceExists(sandbox.profileDir, dependencies)).toBe(true)
      for (const reference of Object.values(dependencies)) {
        expect(reference.startsWith(`file:${artifactsPrefix}`)).toBe(true)
      }
    }

    // 装 A
    expect((await localAdd(ctx, first.path, stub)).failure).toBeUndefined()
    assertReferencesIntact(1)
    // 装 B(源 A 仍在盘;此时旧实现的悬空引用尚未出现——四步门要抓的是源消失后的那一步)
    expect((await localAdd(ctx, second.path, stub)).failure).toBeUndefined()
    assertReferencesIntact(2)
    // 卸 A(remove argv 永不带 flag;A 的制品被 GC,B 不受影响)
    const removedA = await removePlugin(ctx, 'local-cycle-a')
    expect(removedA.restarting).toBe(true)
    assertReferencesIntact(1)
    expect(fileReferenceFor(sandbox.readProfileDependencies(), 'local-cycle-b')).toBeDefined()
    expect(countTarballs(sandbox.artifactsDir)).toBe(1)
    // 卸 B(回归空态:引用与制品都清空)
    const removedB = await removePlugin(ctx, 'local-cycle-b')
    expect(removedB.restarting).toBe(true)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(0)
    expect(countTarballs(sandbox.artifactsDir)).toBe(0)
  }, 180_000)

  test('stages a local directory install too', async () => {
    const sandbox = createMarketSandbox()
    const source = localPluginDir(sandbox, 'local-directory-plugin', '1.0.0')
    const stub = bundledLocalPnpmStub(sandbox)
    const ctx = localCtx(sandbox, stub)

    expect((await localAdd(ctx, source, stub)).failure).toBeUndefined()

    const reference = fileReferenceFor(sandbox.readProfileDependencies(), 'local-directory-plugin')
    expect(reference).toBeDefined()
    const artifactPath = reference!.slice('file:'.length)
    // 目录**不能**被 pnpm 以 file: 引用后删源 ⇒ 先 pack 成 .tgz 再落 .market-artifacts/。
    expect(artifactPath.startsWith(`${join(sandbox.profileDir, '.market-artifacts')}${sep}`)).toBe(true)
    expect(artifactPath.endsWith('.tgz')).toBe(true)
    expect(existsSync(artifactPath)).toBe(true)
    // 落盘的是 pack 出来的真制品:包内自述身份与源目录一致。
    expect(readTarballPackageJson(readFileSync(artifactPath))).toMatchObject({ name: 'local-directory-plugin', version: '1.0.0' })

    // 源目录整棵删掉:引用仍可解析,后续本地安装照常(不再 brick pnpm)。
    rmSync(source, { recursive: true, force: true })
    expect(profileFileReferencesExist(sandbox.profileDir)).toBe(true)
    const other = localPluginDir(sandbox, 'local-directory-plugin-two', '1.0.0')
    expect((await localAdd(ctx, other, stub)).failure).toBeUndefined()
    expect(fileReferenceExists(sandbox.profileDir, sandbox.readProfileDependencies())).toBe(true)
  }, 120_000)

  test('keeps the artifact referenced by a checkpoint even after uninstall (spec §14 第 50 条)', async () => {
    const sandbox = createMarketSandbox()
    const userDataDir = mkdtempSync(join(tmpdir(), 'hw-local-checkpoint-'))
    homes.push(userDataDir)
    const source = sandbox.buildTarball({ name: 'local-checkpoint-plugin', version: '1.0.0' })
    const stub = bundledLocalPnpmStub(sandbox)
    const ctx = localCtx(sandbox, stub)

    expect((await localAdd(ctx, source.path, stub)).failure).toBeUndefined()
    const reference = fileReferenceFor(sandbox.readProfileDependencies(), 'local-checkpoint-plugin')
    expect(reference).toBeDefined()
    const artifactPath = reference!.slice('file:'.length)

    // 健康启动快照(生产由 captureHealthy 在成功启动时写入,见 profile-checkpoint.ts)。
    const checkpoint = new DesktopProfileCheckpoint({
      userDataDir,
      profileDir: sandbox.profileDir,
      profileName: 'test-profile',
      provider: 'desktop-profile',
    })
    expect(checkpoint.captureHealthy().status).toBe('captured')

    process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV] = userDataDir
    try {
      // 卸载(引用从当前 profile 消失,只剩 checkpoint slot 持有)——本地制品必须
      // 与市场制品同受 checkpoint-aware 保留判据保护,否则 restoreSlot 后物化 ENOENT。
      const removed = await removePlugin(ctx, 'local-checkpoint-plugin')
      expect(removed.restarting).toBe(true)
      expect(sandbox.readProfileDependencies()['local-checkpoint-plugin']).toBeUndefined()
      expect(existsSync(artifactPath)).toBe(true)
      // 启动孤儿清扫同口径:有 checkpoint 引用者不是孤儿。
      expect(sweepOrphanMarketArtifacts(sandbox.profileDir, () => {})).toEqual([])
      expect(existsSync(artifactPath)).toBe(true)
      // 牙齿:checkpoint 引用消失后 GC 恢复回收——证明确实是 checkpoint 把它保下来的。
      rmSync(checkpoint.profileRoot, { recursive: true, force: true })
      gcRemovedPackageArtifacts(sandbox.profileDir, 'local-checkpoint-plugin', () => {})
      expect(existsSync(artifactPath)).toBe(false)
    } finally {
      delete process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]
    }
  }, 120_000)

  test('reports an honest error when the local source cannot be read', async () => {
    const sandbox = createMarketSandbox()
    const stub = bundledLocalPnpmStub(sandbox)
    const ctx = localCtx(sandbox, stub)

    // ① 源不存在(从未存在,或在选择后被删除)。
    const gone = join(sandbox.root, 'vanished-plugin.tgz')
    await expect(addPlugin(ctx, gone)).rejects.toThrow('plugin source is not a local package')

    // ② 源存在但不是可用的 .tgz 包档案。
    const garbage = join(sandbox.root, 'garbage.tgz')
    writeFileSync(garbage, 'not-a-real-tarball')
    await expect(addPlugin(ctx, garbage)).rejects.toThrow(/not a usable \.tgz package archive/u)

    // 不落半份制品:没有任何 .tgz / 残留 temp,也没有启动过 pnpm。
    expect(countTarballs(sandbox.artifactsDir)).toBe(0)
    expect(readdirSync(sandbox.artifactsDir).filter((entry) => entry.includes('.tmp-'))).toEqual([])
    expect(stub.calls).toEqual([])
  }, 120_000)

  test('refuses a local source whose version is outside the GC naming boundary (Step 4)', async () => {
    const sandbox = createMarketSandbox()
    const stub = bundledLocalPnpmStub(sandbox)
    const ctx = localCtx(sandbox, stub)

    // 点分 4 段:制品名与 gcRemovedPackageArtifacts 的候选正则失配(卸载漏删)⇒ 拒绝安装。
    const outsideBoundary = sandbox.buildTarball({ name: 'local-bad-version', version: '1.0.0.1' })
    await expect(addPlugin(ctx, outsideBoundary.path)).rejects.toThrow(/cannot be staged as a plugin artifact/u)
    expect(countTarballs(sandbox.artifactsDir)).toBe(0)
    expect(stub.calls).toEqual([])

    // 第 49 条的放宽面:prerelease 后缀合法(GC 正则同样接受),照常落盘并装成。
    const prerelease = sandbox.buildTarball({ name: 'local-prerelease', version: '1.0.0-beta.1' })
    expect((await localAdd(ctx, prerelease.path, stub)).failure).toBeUndefined()
    expect(fileReferenceFor(sandbox.readProfileDependencies(), 'local-prerelease'))
      .toBe(`file:${stagedPathFor(sandbox.profileDir, 'local-prerelease', '1.0.0-beta.1', readFileSync(prerelease.path))}`)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 修复轮 1(Important 1):**已在 `.market-artifacts/` 落位的制品直通**——市场安装
// 路径执行的版本门/二次落盘必须与本 Task 之前逐字一致。
//
// 发布侧门(market-server/src/tarball/gate.ts)只要求 filename-safe 版本,
// `2026.09.27.1`(点分 4 段)、`1.0.0.1`、`abc`、`V1.0` 都是可发布版本;本地命名
// 边界(点分 1–3 段)比它窄,不能反过来把市场已发布制品拒之门外(否则今天是
// 「下载成功 → 确定性拒绝」,还留下孤儿制品)。判据是**内禀位置**:解析后的路径
// 在本 profile 的 `.market-artifacts/` 内 ⇒ 直通(不再二次落盘、不判身份/版本)。
// ---------------------------------------------------------------------------

describe('artifacts already staged under .market-artifacts pass through the local gate (fix round 1)', () => {
  /** 发布侧门放行、本地命名边界**外**的版本(点分 4 段)——两条门的分歧样本。 */
  const OUTSIDE_BOUNDARY = '2026.09.27.1'

  test('an offline install of an already-staged artifact with a not-1–3-segment version succeeds and stays byte-identical', async () => {
    const sandbox = createMarketSandbox()
    const built = sandbox.buildTarball({ name: 'market-passthrough', version: OUTSIDE_BOUNDARY })
    // 市场安装链落的制品形态:`.market-artifacts/<name>-<version>-<sha12>.tgz`(0600)。
    const artifactPath = sandbox.promoteToArtifact(built)
    const stub = bundledLocalPnpmStub(sandbox)
    const before = statSync(artifactPath)
    const beforeBytes = readFileSync(artifactPath)

    const added = await localAdd(localCtx(sandbox, stub), artifactPath, stub, { offline: true })

    // 修前:本地版本门把该制品拒之门外(exit: cannot be staged as a plugin artifact)。
    expect(added.failure).toBeUndefined()
    expect(added.result?.restarting).toBe(true)
    // argv 与本 Task 之前逐字一致:装的就是制品路径 + 市场两 flag。
    const addCalls = stub.calls.filter((call) => call[0] === 'add')
    expect(addCalls).toEqual([['add', artifactPath, '--offline', '--ignore-scripts']])
    // `file:` 引用指向制品本身,制品在盘。
    expect(fileReferenceFor(sandbox.readProfileDependencies(), 'market-passthrough')).toBe(`file:${artifactPath}`)
    expect(fileReferenceExists(sandbox.profileDir, sandbox.readProfileDependencies())).toBe(true)
    // 未被二次落盘:字节、inode、mtime 均未动(旧实现会以同名原地覆盖写 ⇒ mtime 变)。
    const after = statSync(artifactPath)
    expect(readFileSync(artifactPath).equals(beforeBytes)).toBe(true)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(countTarballs(sandbox.artifactsDir)).toBe(1)
  }, 120_000)

  test('the discriminator is the artifact-dir location: the same version outside it is still refused (Step 4 intact)', async () => {
    const sandbox = createMarketSandbox()
    const stub = bundledLocalPnpmStub(sandbox)
    const ctx = localCtx(sandbox, stub)
    const built = sandbox.buildTarball({ name: 'local-outside-boundary', version: OUTSIDE_BOUNDARY })

    // 同一份字节放在制品目录**外** ⇒ 本地源 ⇒ Step 4 的拒绝照旧(不落盘、不跑 pnpm)。
    await expect(addPlugin(ctx, built.path)).rejects.toThrow(/cannot be staged as a plugin artifact/u)
    expect(countTarballs(sandbox.artifactsDir)).toBe(0)
    expect(stub.calls).toEqual([])

    // 落进制品目录(市场安装的形态)⇒ 直通装成:两种命运只由位置决定,不由字节。
    const artifactPath = sandbox.promoteToArtifact(built)
    expect((await localAdd(ctx, artifactPath, stub, { offline: true })).failure).toBeUndefined()
    expect(fileReferenceFor(sandbox.readProfileDependencies(), 'local-outside-boundary')).toBe(`file:${artifactPath}`)
  }, 120_000)
})
