import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { apply, type HuaanworkHostConfig } from '../../src/huaanwork-host/index.ts'
import { getAgentsDirectory } from '../../src/huaanwork-host/sessions.ts'
import { hostConfig } from './startup-sweep-fixture.ts'

/**
 * P1 修复回归钉(2026-10-14,A4-1 证据 §二):`registerCallHostTool` 必须有生产
 * 调用点——host `apply()` 组合后 call_host_tool 真实注册进 tools 服务,目录变更
 * 时描述经重注册刷新,fiber 卸载后不留悬挂工具行。旧桌面移植曾把这一环遗失,
 * 导致 @点名 HTTP 小工具链路整体断裂(模型会话内无该工具)。
 */

type RegisteredTool = { name: string; description: string }

let tmpRoots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-agent-tool-wiring-'))
  tmpRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
  tmpRoots = []
})

/** 与 startup-sweep-fixture 同形,但额外提供 tools 服务桩以激活注册子插件。 */
async function bootWithTools(config: HuaanworkHostConfig): Promise<{
  ctx: Context
  registered: RegisteredTool[]
}> {
  mkdirSync(config.profileDir, { recursive: true })
  mkdirSync(config.dshHome, { recursive: true })
  const registered: RegisteredTool[] = []
  const ctx = new Context()
  ctx.provide('webServer', {
    port: 1,
    register: () => () => {},
    registerUpgrade: () => () => {},
  } as never)
  ctx.provide('desktopRuntime', { requestConfirmedRestart: async () => true } as never)
  ctx.provide('tools', {
    register(def: RegisteredTool) {
      registered.push(def)
      return () => {
        const idx = registered.indexOf(def)
        if (idx >= 0) registered.splice(idx, 1)
      }
    },
  } as never)
  await apply(ctx, config)
  // 子插件在 fiber 中激活:有界等待注册落地(正常 <50ms,给足 CI 余量)。
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !registered.some((t) => t.name === 'call_host_tool')) {
    await new Promise((done) => setTimeout(done, 10))
  }
  return { ctx, registered }
}

/** 在 profile 的本地端点表追加一条 http 小工具端点(落盘形状 { entries: [...] },与 writeEndpoints 同构)。 */
function writeEndpoint(profileDir: string, name: string): void {
  const file = join(profileDir, 'agents-endpoints.json')
  const existing = existsSync(file)
    ? ((JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown[] }).entries ?? [])
    : []
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        entries: [
          ...existing,
          { name, kind: 'tool', entrypoint: { kind: 'http', url: `http://127.0.0.1:9/${name}/invoke` }, description: `${name} 描述` },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
}

describe('call_host_tool registration wiring (P1)', () => {
  test('host apply() 后注册 call_host_tool,描述含已启用的本地入口', async () => {
    const config = hostConfig(freshRoot())
    writeEndpoint(config.profileDir, 'wired-probe')
    const booted = await bootWithTools(config)

    const tool = booted.registered.find((t) => t.name === 'call_host_tool')
    expect(tool).toBeTruthy()
    expect(tool!.description).toContain('wired-probe')
    await booted.ctx.fiber.dispose()
  })

  test('addEndpoint → onCatalogChange:描述经重注册刷新,且任一时刻仅一个实例', async () => {
    const config = hostConfig(freshRoot())
    const booted = await bootWithTools(config)

    const result = getAgentsDirectory().addEndpoint({
      name: 'second-probe',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9/second-probe/invoke' },
      description: '第二个探针',
    })
    expect(result.ok).toBe(true)

    const hostTools = booted.registered.filter((t) => t.name === 'call_host_tool')
    expect(hostTools).toHaveLength(1) // 重注册先 unregister,不产生重复行
    expect(hostTools[0]!.description).toContain('second-probe')
    await booted.ctx.fiber.dispose()
  })

  test('空目录注册不抛,描述为空清单文案', async () => {
    const config = hostConfig(freshRoot())
    const booted = await bootWithTools(config)

    const tool = booted.registered.find((t) => t.name === 'call_host_tool')
    expect(tool).toBeTruthy()
    expect(tool!.description).toContain('当前无已启用的公用机小工具')
    await booted.ctx.fiber.dispose()
  })

  test('fiber dispose 后注销,不留悬挂工具行', async () => {
    const config = hostConfig(freshRoot())
    const booted = await bootWithTools(config)
    expect(booted.registered.some((t) => t.name === 'call_host_tool')).toBe(true)

    await booted.ctx.fiber.dispose()
    expect(booted.registered.some((t) => t.name === 'call_host_tool')).toBe(false)
  })
})
