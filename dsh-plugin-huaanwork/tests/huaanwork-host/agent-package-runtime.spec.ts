import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { parseAgentPackageManifest } from '../../src/huaanwork-host/agent-package/manifest.ts'
import {
  composeAgentPackagePersona,
  composeAgentPackageToolAllowList,
  createAgentPackageRuntimeRegistry,
  startAgentPackageProcesses,
  stopAgentPackageProcesses,
  stopAllAgentPackageProcesses,
  type AgentPackageSandbox,
} from '../../src/huaanwork-host/agent-package/runtime.ts'
import type {
  AgentPackageManifest,
  AgentPackageToolsMode,
  AgentPackageTurnRuntime,
} from '../../src/huaanwork-host/agent-package/types.ts'

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'agent-package')
const SANDBOX_UNAVAILABLE_MESSAGE = '当前系统无法启动沙箱，智能体未运行'
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

let roots: string[] = []

afterEach(async () => {
  await stopAllAgentPackageProcesses()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function loadManifest(packageDir: string = FIXTURE_DIR): AgentPackageManifest {
  const parsed = parseAgentPackageManifest(JSON.parse(readFileSync(join(packageDir, 'agent.json'), 'utf8')))
  if (!parsed.ok) {
    throw new Error(`fixture manifest is invalid: ${JSON.stringify(parsed.fieldErrors)}`)
  }
  return parsed.manifest
}

function manifestWithMode(mode: AgentPackageToolsMode): AgentPackageManifest {
  const base = loadManifest()
  const http = { entry: 'tools/http/server.mjs' } as const
  const mcp = { entry: 'tools/mcp/server.mjs' } as const
  const tools: AgentPackageManifest['tools'] =
    mode === 'http'
      ? { mode, http }
      : mode === 'mcp'
        ? { mode, mcp }
        : mode === 'both'
          ? { mode, http, mcp }
          : { mode: 'none' }
  return { ...base, tools }
}

function copyFixture(): string {
  const packageDir = join(makeRoot('agent-package-pkg-'), 'weekly-report')
  cpSync(FIXTURE_DIR, packageDir, { recursive: true })
  return packageDir
}

function makeProfileWithSkill(name: string): string {
  const root = makeRoot('agent-package-profile-')
  mkdirSync(join(root, 'skills', name), { recursive: true })
  writeFileSync(
    join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 周报风格\n---\n\n内置技能正文:使用条目式。\n`,
  )
  return root
}

const passthroughSandbox: AgentPackageSandbox = {
  async confine(argv) {
    return { argv, enforcement: 'full' }
  },
}

type StartFixtureOptions = {
  manifest?: AgentPackageManifest
  packageDir?: string
  workspaceRoot?: string
  getSandbox?: () => AgentPackageSandbox | undefined
  mountMcp?: (port: number) => readonly string[] | Promise<readonly string[]>
}

async function startFixture(options: StartFixtureOptions = {}): Promise<{
  runtime: AgentPackageTurnRuntime
  workspaceRoot: string
}> {
  const workspaceRoot = options.workspaceRoot ?? makeRoot('agent-package-ws-')
  const runtime = await startAgentPackageProcesses({
    manifest: options.manifest ?? loadManifest(),
    packageDir: options.packageDir ?? FIXTURE_DIR,
    workspaceRoot,
    getSandbox: options.getSandbox ?? (() => passthroughSandbox),
    ...(options.mountMcp === undefined ? {} : { mountMcp: options.mountMcp }),
  })
  return { runtime, workspaceRoot }
}

function requirePort(port: number | undefined): number {
  if (port === undefined) throw new Error('expected the runtime to expose a port')
  return port
}

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

function portAccepting(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!(await portAccepting(port))) return
    await delay(50)
  }
  throw new Error(`port ${port} still accepts connections`)
}

async function readPortFile(workspaceRoot: string, name: string): Promise<number> {
  const target = join(workspaceRoot, name)
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (existsSync(target)) return Number(readFileSync(target, 'utf8'))
    await delay(25)
  }
  throw new Error(`${name} was not written into ${workspaceRoot}`)
}

function failureOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject')
    },
    (error: unknown) => {
      if (error instanceof Error) return error
      return new Error(String(error))
    },
  )
}

describe('agent package persona', () => {
  test('composes persona and tool allow list', async () => {
    const manifest = loadManifest()
    const profileDir = makeRoot('agent-package-profile-')
    const persona = await composeAgentPackagePersona(FIXTURE_DIR, manifest, profileDir)
    expect(persona).toContain('你是周报助手')
    expect(persona).toContain('SKILL.md 正文')
    expect(persona).not.toContain('description: 生成周报')
    expect(persona.trimEnd().endsWith(FIXTURE_DIR)).toBe(true)
    expect(composeAgentPackageToolAllowList(manifest, ['mcp__demo__echo'], ['skill/scripts/echo.mjs'])).toEqual(
      expect.arrayContaining(['read', 'read_file', 'glob', 'grep', SHELL, 'agent_skill_run', 'agent_http', 'mcp__demo__echo']),
    )
  })

  test('appends allowSkills bodies before the package directory', async () => {
    const profileDir = makeProfileWithSkill('report-style')
    const persona = await composeAgentPackagePersona(FIXTURE_DIR, { ...loadManifest(), allowSkills: ['report-style'] }, profileDir)
    expect(persona).toContain('内置技能正文:使用条目式。')
    expect(persona.trimEnd().endsWith(FIXTURE_DIR)).toBe(true)
  })

  test('names the slug when an allowed skill is missing', async () => {
    const profileDir = makeRoot('agent-package-profile-')
    await expect(
      composeAgentPackagePersona(FIXTURE_DIR, { ...loadManifest(), allowSkills: ['missing-skill'] }, profileDir),
    ).rejects.toThrow(/weekly-report.*missing-skill/)
  })

  test('rejects a persona above 64 KiB', async () => {
    const packageDir = copyFixture()
    writeFileSync(join(packageDir, 'persona.md'), 'x'.repeat(64 * 1024 + 1))
    await expect(composeAgentPackagePersona(packageDir, loadManifest(), makeRoot('agent-package-profile-'))).rejects.toThrow(
      /weekly-report.*64 KiB/,
    )
  })

  test('names the slug when persona.md is missing', async () => {
    const packageDir = copyFixture()
    rmSync(join(packageDir, 'persona.md'))
    await expect(composeAgentPackagePersona(packageDir, loadManifest(), makeRoot('agent-package-profile-'))).rejects.toThrow(
      /智能体 @weekly-report.*persona\.md/,
    )
  })

  test('names the slug when skill/SKILL.md is missing', async () => {
    const packageDir = copyFixture()
    rmSync(join(packageDir, 'skill', 'SKILL.md'))
    await expect(composeAgentPackagePersona(packageDir, loadManifest(), makeRoot('agent-package-profile-'))).rejects.toThrow(
      /智能体 @weekly-report.*skill\/SKILL\.md/,
    )
  })
})

describe('agent package tool allow list', () => {
  test('follows the declared modes and never exposes host tools', () => {
    expect(composeAgentPackageToolAllowList(manifestWithMode('none'), [], [])).toEqual([
      'read',
      'read_file',
      'glob',
      'grep',
      SHELL,
    ])
    expect(composeAgentPackageToolAllowList(manifestWithMode('http'), [], [])).not.toContain('agent_skill_run')
    expect(composeAgentPackageToolAllowList(manifestWithMode('http'), [], ['skill/scripts/echo.mjs'])).toContain('agent_skill_run')
    expect(composeAgentPackageToolAllowList(manifestWithMode('http'), [], [])).toContain('agent_http')
    expect(composeAgentPackageToolAllowList(manifestWithMode('mcp'), [], [])).not.toContain('agent_http')
    expect(composeAgentPackageToolAllowList(manifestWithMode('mcp'), ['mcp__demo__echo'], [])).toEqual(
      expect.arrayContaining(['mcp__demo__echo']),
    )
    expect(composeAgentPackageToolAllowList(manifestWithMode('none'), ['mcp__demo__echo'], [])).not.toContain('mcp__demo__echo')
    expect(
      composeAgentPackageToolAllowList(manifestWithMode('both'), ['mcp__demo__echo'], ['skill/scripts/echo.mjs']),
    ).not.toContain('call_host_tool')
  })
})

describe('agent package processes', () => {
  test('starts the HTTP server in the sandbox and answers /invoke', { timeout: 20_000 }, async () => {
    const { runtime, workspaceRoot } = await startFixture({ manifest: manifestWithMode('http') })
    try {
      const port = requirePort(runtime.httpPort)
      expect(port).toBe(await readPortFile(workspaceRoot, 'http-port.txt'))
      expect(await portAccepting(port)).toBe(true)
      const response = await fetch(`http://127.0.0.1:${port}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ arguments: { week: 'W43' } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, result: { echo: { week: 'W43' } } })
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('starts the MCP server with TCP health only when no mount callback is given', { timeout: 20_000 }, async () => {
    const { runtime, workspaceRoot } = await startFixture({ manifest: manifestWithMode('mcp') })
    try {
      expect(runtime.mcpNames).toBeUndefined()
      const port = await readPortFile(workspaceRoot, 'mcp-port.txt')
      expect(await portAccepting(port)).toBe(true)
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('reports the MCP tool names returned by the mount callback', { timeout: 20_000 }, async () => {
    const seen: number[] = []
    const { runtime, workspaceRoot } = await startFixture({
      manifest: manifestWithMode('mcp'),
      mountMcp: async (port) => {
        seen.push(port)
        return ['mcp__demo__echo']
      },
    })
    try {
      expect(runtime.mcpNames).toEqual(['mcp__demo__echo'])
      expect(seen).toEqual([await readPortFile(workspaceRoot, 'mcp-port.txt')])
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('fails the round and stops the MCP server when the mount callback returns no tools', { timeout: 20_000 }, async () => {
    const workspaceRoot = makeRoot('agent-package-ws-')
    await expect(
      startAgentPackageProcesses({
        manifest: manifestWithMode('mcp'),
        packageDir: FIXTURE_DIR,
        workspaceRoot,
        getSandbox: () => passthroughSandbox,
        mountMcp: async () => [],
      }),
    ).rejects.toThrow('未提供任何工具')
    await waitForPortClosed(await readPortFile(workspaceRoot, 'mcp-port.txt'))
  })

  test('starts both servers and stops both', { timeout: 20_000 }, async () => {
    const { runtime, workspaceRoot } = await startFixture({
      manifest: manifestWithMode('both'),
      mountMcp: async () => ['mcp__demo__echo'],
    })
    const httpPort = requirePort(runtime.httpPort)
    const mcpPort = await readPortFile(workspaceRoot, 'mcp-port.txt')
    expect(runtime.mcpNames).toEqual(['mcp__demo__echo'])
    await stopAgentPackageProcesses(runtime)
    await waitForPortClosed(httpPort)
    await waitForPortClosed(mcpPort)
  })

  test('stops the HTTP server when the MCP server fails to start', { timeout: 20_000 }, async () => {
    const packageDir = copyFixture()
    writeFileSync(join(packageDir, 'tools', 'mcp', 'server.mjs'), "process.stderr.write('mcp-boom: cannot start\\n')\nprocess.exit(1)\n")
    const workspaceRoot = makeRoot('agent-package-ws-')
    await expect(
      startAgentPackageProcesses({
        manifest: manifestWithMode('both'),
        packageDir,
        workspaceRoot,
        getSandbox: () => passthroughSandbox,
      }),
    ).rejects.toThrow('mcp-boom')
    await waitForPortClosed(await readPortFile(workspaceRoot, 'http-port.txt'))
  })

  test('rejects an early exit with the first 500 stderr characters', { timeout: 20_000 }, async () => {
    const packageDir = copyFixture()
    writeFileSync(
      join(packageDir, 'tools', 'http', 'server.mjs'),
      `process.stderr.write('http-boom: ${'x'.repeat(600)}\\n')\nprocess.exit(1)\n`,
    )
    const error = await failureOf(
      startAgentPackageProcesses({
        manifest: manifestWithMode('http'),
        packageDir,
        workspaceRoot: makeRoot('agent-package-ws-'),
        getSandbox: () => passthroughSandbox,
      }),
    )
    expect(error.message.startsWith('脚本启动失败：')).toBe(true)
    expect(error.message).toContain('http-boom:')
    expect(error.message).toHaveLength('脚本启动失败：'.length + 500)
  })

  test('retries a port collision three times before failing', { timeout: 20_000 }, async () => {
    const packageDir = copyFixture()
    writeFileSync(
      join(packageDir, 'tools', 'mcp', 'server.mjs'),
      [
        "import { appendFileSync } from 'node:fs'",
        "appendFileSync('port-attempts.txt', `${process.env.AGENT_MCP_PORT}\\n`)",
        "process.stderr.write('Error: listen EADDRINUSE: address already in use\\n')",
        'process.exit(1)',
        '',
      ].join('\n'),
    )
    const workspaceRoot = makeRoot('agent-package-ws-')
    await expect(
      startAgentPackageProcesses({
        manifest: manifestWithMode('mcp'),
        packageDir,
        workspaceRoot,
        getSandbox: () => passthroughSandbox,
        mountMcp: async () => ['mcp__demo__echo'],
      }),
    ).rejects.toThrow('EADDRINUSE')
    const attempts = readFileSync(join(workspaceRoot, 'port-attempts.txt'), 'utf8').trim().split('\n')
    expect(attempts).toHaveLength(4)
  })

  test('stops processes idempotently without leaving an orphan', { timeout: 20_000 }, async () => {
    const { runtime } = await startFixture({ manifest: manifestWithMode('http') })
    const port = requirePort(runtime.httpPort)
    await stopAgentPackageProcesses(runtime)
    await stopAgentPackageProcesses(runtime)
    await waitForPortClosed(port)
  })

  test('stopAllAgentPackageProcesses stops every running runtime', { timeout: 20_000 }, async () => {
    const first = await startFixture({ manifest: manifestWithMode('http') })
    const second = await startFixture({ manifest: manifestWithMode('http') })
    const firstPort = requirePort(first.runtime.httpPort)
    const secondPort = requirePort(second.runtime.httpPort)
    await stopAllAgentPackageProcesses()
    await waitForPortClosed(firstPort)
    await waitForPortClosed(secondPort)
  })
})

describe('agent package skill scripts', () => {
  test('runs a declared script with args, workspace, and a per-turn state dir', async () => {
    const { runtime, workspaceRoot } = await startFixture({ manifest: manifestWithMode('none') })
    expect(runtime.skillScripts).toEqual(['skill/scripts/echo.mjs'])
    try {
      const result = await runtime.runSkillScript('skill/scripts/echo.mjs', { hello: '世界' })
      expect(result.isError).toBeUndefined()
      const payload = JSON.parse(result.text) as { args: unknown; stateDir: string; workspace: string; cwd: string }
      expect(payload.args).toEqual({ hello: '世界' })
      expect(payload.workspace).toBe(workspaceRoot)
      // macOS resolves /var through /private/var for the child's cwd.
      expect(payload.cwd).toBe(realpathSync(workspaceRoot))
      expect(existsSync(payload.stateDir)).toBe(true)
      await stopAgentPackageProcesses(runtime)
      expect(existsSync(payload.stateDir)).toBe(false)
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('truncates stdout to 32 KiB', { timeout: 20_000 }, async () => {
    const { runtime } = await startFixture({ manifest: manifestWithMode('none') })
    try {
      const result = await runtime.runSkillScript('skill/scripts/echo.mjs', { bytes: 40_000 })
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(32 * 1024)
      expect(result.text.startsWith('x')).toBe(true)
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('returns the first 500 stderr characters on a non-zero exit', async () => {
    const { runtime } = await startFixture({ manifest: manifestWithMode('none') })
    try {
      const result = await runtime.runSkillScript('skill/scripts/echo.mjs', { fail: true })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('script-boom')
      expect(result.text.length).toBeLessThanOrEqual(500)
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('refuses a script outside the declared skill/scripts set', async () => {
    const { runtime } = await startFixture({ manifest: manifestWithMode('none') })
    try {
      const result = await runtime.runSkillScript('skill/scripts/other.mjs', {})
      expect(result.isError).toBe(true)
      expect(result.text).toContain('未声明')
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('returns an explicit error when the package has no scripts', async () => {
    const packageDir = copyFixture()
    rmSync(join(packageDir, 'skill', 'scripts'), { recursive: true })
    const { runtime } = await startFixture({ manifest: manifestWithMode('none'), packageDir })
    try {
      expect(runtime.skillScripts).toEqual([])
      const result = await runtime.runSkillScript('skill/scripts/echo.mjs', {})
      expect(result.isError).toBe(true)
      expect(result.text).toContain('没有可运行的技能脚本')
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('passes only the allowlisted environment to child processes', async () => {
    process.env.HUAANWORK_SECRET = 'leak-me'
    process.env.DS_MODEL_API_KEY = 'leak-key'
    try {
      const { runtime } = await startFixture({ manifest: manifestWithMode('none') })
      try {
        const result = await runtime.runSkillScript('skill/scripts/echo.mjs', { env: true })
        expect(result.isError).toBeUndefined()
        const keys = (JSON.parse(result.text) as { env: string[] }).env
        expect(keys).not.toContain('HUAANWORK_SECRET')
        expect(keys).not.toContain('DS_MODEL_API_KEY')
        expect(keys).toEqual(expect.arrayContaining(['AGENT_SCRIPT_ARGS', 'AGENT_STATE_DIR', 'AGENT_WORKSPACE']))
        const allowed = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMPDIR', 'ELECTRON_RUN_AS_NODE'])
        // macOS injects this CoreFoundation variable at exec time; it is not taken
        // from the environment the host passed to spawn.
        const osInjected = new Set(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])
        expect(keys.every((key) => key.startsWith('AGENT_') || allowed.has(key) || osInjected.has(key))).toBe(true)
      } finally {
        await stopAgentPackageProcesses(runtime)
      }
    } finally {
      delete process.env.HUAANWORK_SECRET
      delete process.env.DS_MODEL_API_KEY
    }
  })

  test('sets ELECTRON_RUN_AS_NODE when the runtime is Electron', async () => {
    Object.defineProperty(process.versions, 'electron', { value: 'test-electron', configurable: true })
    try {
      const { runtime } = await startFixture({ manifest: manifestWithMode('none') })
      try {
        const result = await runtime.runSkillScript('skill/scripts/echo.mjs', { env: true })
        expect((JSON.parse(result.text) as { env: string[] }).env).toContain('ELECTRON_RUN_AS_NODE')
      } finally {
        await stopAgentPackageProcesses(runtime)
      }
    } finally {
      Reflect.deleteProperty(process.versions, 'electron')
    }
  })
})

describe('agent package runtime registry', () => {
  test('binds, reads, and deletes runtimes per session', () => {
    const registry = createAgentPackageRuntimeRegistry()
    const runtime: AgentPackageTurnRuntime = {
      slug: 'weekly-report',
      packageDir: FIXTURE_DIR,
      workspaceRoot: '/workspace',
      skillScripts: [],
      runSkillScript: async () => ({ text: '' }),
    }
    expect(registry.get('session-1')).toBeUndefined()
    registry.bind('session-1', runtime)
    expect(registry.get('session-1')).toBe(runtime)
    registry.delete('session-1')
    expect(registry.get('session-1')).toBeUndefined()
  })
})

describe('agent package sandbox fail-closed', () => {
  test('refuses to start processes without a sandbox service', async () => {
    await expect(
      startAgentPackageProcesses({
        manifest: manifestWithMode('http'),
        packageDir: FIXTURE_DIR,
        workspaceRoot: makeRoot('agent-package-ws-'),
        getSandbox: () => undefined,
      }),
    ).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE)
  })

  test('refuses to start processes when confine reports SANDBOX_UNAVAILABLE', async () => {
    const unavailable: AgentPackageSandbox = {
      async confine() {
        throw Object.assign(new Error('no runner'), { code: 'SANDBOX_UNAVAILABLE' })
      },
    }
    await expect(
      startAgentPackageProcesses({
        manifest: manifestWithMode('http'),
        packageDir: FIXTURE_DIR,
        workspaceRoot: makeRoot('agent-package-ws-'),
        getSandbox: () => unavailable,
      }),
    ).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE)
  })

  test('refuses to run a skill script without a sandbox service', async () => {
    const { runtime } = await startFixture({ manifest: manifestWithMode('none'), getSandbox: () => undefined })
    await expect(runtime.runSkillScript('skill/scripts/echo.mjs', {})).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE)
    await stopAgentPackageProcesses(runtime)
  })
})
