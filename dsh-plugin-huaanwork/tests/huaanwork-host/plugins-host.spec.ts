import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DesktopPnpmHandle } from '../../src/pnpm.ts'
import {
  addPlugin,
  IMMUTABLE_BUNDLES,
  PluginCommandError,
  removePlugin,
  type PluginMutationContext,
} from '../../src/huaanwork-host/plugins-host.ts'
import { ROUTE_TABLE, RouteError, type RouteContext } from '../../src/huaanwork-host/routes.ts'

const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

let homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-plugins-host-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

function writeProfile(profileDir: string, bundles: string[]): void {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ dsh: { profile: { bundles } } })}\n`)
}

function writePluginDir(root: string, name = 'demo-plugin'): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    dsh: { bundle: { id: name } },
  }))
  return dir
}

function completedHandle(exitCode = 0): DesktopPnpmHandle {
  return {
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    done: Promise.resolve({ exitCode, signal: null }),
    cancel() {},
  }
}

function makeCtx(
  profileDir: string,
  runPlugin: (argv: readonly string[], invokingDir: string, signal?: AbortSignal) => DesktopPnpmHandle,
  restart = true,
) {
  const run = vi.fn(runPlugin)
  const requestRestart = vi.fn(async () => restart)
  return {
    profileDir,
    logger: vi.fn(),
    requestRestart,
    desktopPnpm: { runPlugin: run },
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

  test('add 校验本地目录:缺 package.json、缺 name、缺 dsh.bundle 都拒绝,profile 不改', async () => {
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

    expect(ctx.desktopPnpm.runPlugin).not.toHaveBeenCalled()
    expect(readFileSync(join(profileDir, 'package.json'))).toEqual(before)
  })

  test('add 把绝对路径透传给 runPlugin;目录要 dsh.bundle,.tgz 直装', async () => {
    const profileDir = makeHome()
    writeProfile(profileDir, BASE_BUNDLES)
    const pluginDir = writePluginDir(makeHome())
    const tarball = join(makeHome(), 'demo.tgz')
    writeFileSync(tarball, 'not-a-real-tarball')
    const seen: string[][] = []
    const ctx = makeCtx(profileDir, (argv) => {
      seen.push([...argv])
      return completedHandle()
    })

    await addPlugin(ctx, pluginDir)
    await addPlugin(ctx, tarball)

    expect(seen).toEqual([
      ['add', resolve(pluginDir)],
      ['add', resolve(tarball)],
    ])
    expect(ctx.desktopPnpm.runPlugin).toHaveBeenCalledWith(['add', resolve(pluginDir)], resolve(profileDir))
    expect(ctx.desktopPnpm.runPlugin).toHaveBeenCalledWith(['add', resolve(tarball)], resolve(profileDir))
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
    const tarball = join(makeHome(), 'demo.tgz')
    writeFileSync(tarball, 'not-a-real-tarball')
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
    const ctx: PluginMutationContext = {
      profileDir,
      logger: () => {},
      requestRestart: async () => false,
      runtimeCtx: { get: (name: string) => (name === 'desktopPnpm' ? { runPlugin } : undefined) },
    }
    await expect(addPlugin(ctx, pluginDir)).resolves.toMatchObject({
      bundles: BASE_BUNDLES,
      message: expect.stringContaining('下次启动时生效'),
    })
    expect(runPlugin).toHaveBeenCalledWith(['add', resolve(pluginDir)], resolve(profileDir))
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
