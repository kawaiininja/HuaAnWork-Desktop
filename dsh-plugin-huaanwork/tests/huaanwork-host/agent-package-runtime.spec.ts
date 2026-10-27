import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentPackageDigest } from '@huaanwork/agent-package-format/digest'
import {
  canonicalJson,
  fingerprintPublicKeyHex,
  generateKeyPair,
  signAgentPackageDigest,
} from '@huaanwork/catalog-signing'

import { createAgentCatalogSecurity } from '../../src/huaanwork-host/agent-package/catalog-security.ts'
import { parseAgentPackageManifest } from '../../src/huaanwork-host/agent-package/manifest.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
  type AgentPackageHost,
} from '../../src/huaanwork-host/agent-package/host.ts'
import { readAgentPackageState } from '../../src/huaanwork-host/agent-package/store.ts'
import {
  AGENT_PACKAGE_CHILD_TOOLS,
  attachAgentTools,
  emptyAttachments,
} from '../../src/huaanwork-guardrails/agent-attachments.ts'
import {
  AGENT_PACKAGE_START_CANCELLED,
  composeAgentPackagePersona,
  composeAgentPackageToolAllowList,
  createAgentPackageRuntimeRegistry,
  listAgentPackageSkillScripts,
  startAgentPackageProcesses,
  stopAgentPackageProcesses,
  stopAllAgentPackageProcesses,
  type AgentPackageSandbox,
  type StartAgentPackageProcessesOptions,
} from '../../src/huaanwork-host/agent-package/runtime.ts'
import type {
  AgentPackageManifest,
  AgentPackageToolsMode,
  AgentPackageTurnRuntime,
} from '../../src/huaanwork-host/agent-package/types.ts'
import type { AgentsHost } from '../../src/huaanwork-host/agents-host.ts'
import {
  createSubagentRunRegistry,
  type SubagentRunRegistry,
} from '../../src/huaanwork-host/subagent-runs.ts'
import type {
  SubagentActivationHandle,
  SubagentActivationSpec,
} from '../../src/huaanwork-host/subagents-service.ts'

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

  test('declares skill scripts and the HTTP arguments schema before the package directory', async () => {
    const manifest: AgentPackageManifest = {
      ...loadManifest(),
      tools: {
        mode: 'http',
        http: {
          entry: 'tools/http/server.mjs',
          argumentsSchema: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
        },
      },
    }
    const persona = await composeAgentPackagePersona(FIXTURE_DIR, manifest, makeRoot('agent-package-profile-'))

    expect(persona).toContain('## 工具')
    expect(persona).toContain(`技能脚本：${listAgentPackageSkillScripts(FIXTURE_DIR).join('、')}`)
    expect(persona).toContain(
      'HTTP 参数 Schema：{"type":"object","properties":{"topic":{"type":"string"}},"required":["topic"]}',
    )
    expect(persona.indexOf('## 工具')).toBeLessThan(persona.lastIndexOf('智能体包目录：'))
  })

  test('marks a package without scripts as 无 and omits an absent schema', async () => {
    const packageDir = copyFixture()
    rmSync(join(packageDir, 'skill', 'scripts'), { recursive: true, force: true })
    const persona = await composeAgentPackagePersona(
      packageDir,
      { ...manifestWithMode('none'), skill: null },
      makeRoot('agent-package-profile-'),
    )

    expect(persona).toContain('技能脚本：无')
    expect(persona).not.toContain('HTTP 参数 Schema：')
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

describe('agent package skill script lifecycle', () => {
  function copyFixtureWithHang(): { packageDir: string; workspaceRoot: string } {
    const packageDir = copyFixture()
    writeFileSync(
      join(packageDir, 'skill', 'scripts', 'hang.mjs'),
      [
        "import { writeFileSync } from 'node:fs'",
        "writeFileSync('hang-pid.txt', String(process.pid))",
        "writeFileSync('hang-state.txt', process.env.AGENT_STATE_DIR ?? '')",
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
    )
    return { packageDir, workspaceRoot: makeRoot('agent-package-ws-') }
  }

  async function readPidFile(workspaceRoot: string, name: string): Promise<number> {
    return Number(await readPortFile(workspaceRoot, name))
  }

  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function waitForProcessExit(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (!processAlive(pid)) return
      await delay(50)
    }
    throw new Error(`process ${pid} is still alive`)
  }

  test('an already-aborted caller signal does not spawn the script', { timeout: 20_000 }, async () => {
    const { packageDir, workspaceRoot } = copyFixtureWithHang()
    const { runtime } = await startFixture({ manifest: manifestWithMode('none'), packageDir, workspaceRoot })
    try {
      const controller = new AbortController()
      controller.abort()
      const result = await runtime.runSkillScript('skill/scripts/hang.mjs', {}, controller.signal)
      expect(result.isError).toBe(true)
      expect(result.text).toContain('已取消')
      // 未 spawn:脚本连自己的 pid 文件都不会写。
      expect(existsSync(join(workspaceRoot, 'hang-pid.txt'))).toBe(false)
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('aborting the caller signal kills the running script', { timeout: 20_000 }, async () => {
    const { packageDir, workspaceRoot } = copyFixtureWithHang()
    const { runtime } = await startFixture({ manifest: manifestWithMode('none'), packageDir, workspaceRoot })
    try {
      const controller = new AbortController()
      const running = runtime.runSkillScript('skill/scripts/hang.mjs', {}, controller.signal)
      const pid = await readPidFile(workspaceRoot, 'hang-pid.txt')
      controller.abort()
      const result = await running
      expect(result.isError).toBe(true)
      expect(result.text).toContain('已取消')
      await waitForProcessExit(pid)
    } finally {
      await stopAgentPackageProcesses(runtime)
    }
  })

  test('stopping the runtime during a running script kills it and removes the state dir', { timeout: 20_000 }, async () => {
    const { packageDir, workspaceRoot } = copyFixtureWithHang()
    const { runtime } = await startFixture({ manifest: manifestWithMode('none'), packageDir, workspaceRoot })
    const running = runtime.runSkillScript('skill/scripts/hang.mjs', {})
    const pid = await readPidFile(workspaceRoot, 'hang-pid.txt')
    const stateDir = readFileSync(join(workspaceRoot, 'hang-state.txt'), 'utf8')
    expect(stateDir.length).toBeGreaterThan(0)
    expect(existsSync(stateDir)).toBe(true)

    await stopAgentPackageProcesses(runtime)
    const result = await running

    expect(result.isError).toBe(true)
    expect(result.text).toContain('已停止')
    await waitForProcessExit(pid)
    expect(existsSync(stateDir)).toBe(false)
  })

  test('fails the round when the MCP mount exceeds the health budget', { timeout: 20_000 }, async () => {
    const workspaceRoot = makeRoot('agent-package-ws-')
    const startedAt = Date.now()
    await expect(
      startAgentPackageProcesses({
        manifest: manifestWithMode('mcp'),
        packageDir: FIXTURE_DIR,
        workspaceRoot,
        getSandbox: () => passthroughSandbox,
        mountMcp: () => new Promise<readonly string[]>(() => {}),
      }),
    ).rejects.toThrow(/脚本启动失败：MCP 服务挂载超时/)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500)
    await waitForPortClosed(await readPortFile(workspaceRoot, 'mcp-port.txt'))
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

describe('agent package turn cleanup', () => {
  /** 把 fixture 装进 profile 的 agents/<slug>/ 并只启用 HTTP 工具模式。 */
  function installHttpPackage(): string {
    const profileDir = makeRoot('agent-package-profile-')
    const packageDir = join(profileDir, 'agents', 'weekly-report')
    mkdirSync(join(profileDir, 'agents'), { recursive: true })
    cpSync(FIXTURE_DIR, packageDir, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(packageDir, 'agent.json'), 'utf8')) as Record<string, unknown>
    manifest.tools = { mode: 'http', http: { entry: 'tools/http/server.mjs' } }
    writeFileSync(join(packageDir, 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    // store 会把「未选择 MCP 但存在 tools/mcp」标成损坏。
    rmSync(join(packageDir, 'tools', 'mcp'), { recursive: true, force: true })
    writeFileSync(
      join(profileDir, 'agents-state.json'),
      JSON.stringify({ 'local:weekly-report': { source: 'local', enabled: true, installedVersion: '1.0.0' } }),
      'utf8',
    )
    return profileDir
  }

  test('afterIdle stops the HTTP process started for a dispatched turn', { timeout: 30_000 }, async () => {
    const profileDir = installHttpPackage()
    const workspaceRoot = makeRoot('agent-package-ws-')
    const host = createAgentPackageHost({ profileDir, takenSlugs: () => [] })
    const pkg = await host.findInvocable('weekly-report')
    expect(pkg?.broken).toBeUndefined()

    const dispatched = await host.dispatch({
      ctx: {
        get: (name: string) => (name === 'sandbox' ? passthroughSandbox : undefined),
        huaanworkWorkspaceRoot: { current: workspaceRoot },
        huaanworkSubagentRuns: createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined }),
        subagents: {
          startActivation: async () => ({
            childId: 'child',
            result: Promise.resolve({}),
            dispose: async () => undefined,
          }),
        },
      } as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写一份周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    const port = await readPortFile(workspaceRoot, 'http-port.txt')
    expect(await portAccepting(port)).toBe(true)

    await dispatched.afterIdle()
    await waitForPortClosed(port)
  })

  test('afterIdle detaches exactly the tools attached to the package child', async () => {
    const profileDir = makeRoot('agent-package-profile-')
    const packageDir = join(profileDir, 'agents', 'weekly-report')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, 'agent.json'),
      JSON.stringify({
        schemaVersion: 1,
        slug: 'weekly-report',
        displayName: '周报助手',
        description: '把一周工作整理成周报',
        version: '1.0.0',
        draftId: 'draft-minimal',
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
        persona: 'persona.md',
        skill: null,
        tools: { mode: 'none' },
        allowSkills: [],
      }),
      'utf8',
    )
    writeFileSync(join(packageDir, 'persona.md'), '你是周报助手。', 'utf8')
    writeFileSync(
      join(profileDir, 'agents-state.json'),
      JSON.stringify({ 'local:weekly-report': { source: 'local', enabled: true, installedVersion: '1.0.0' } }),
      'utf8',
    )

    const attachments = emptyAttachments()
    const ctx = {
      huaanworkAttachments: attachments,
      huaanworkWorkspaceRoot: { current: makeRoot('agent-package-ws-') },
      huaanworkAgentPackageRequest: { current: null },
      huaanworkSubagentRuns: createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined }),
      subagents: {
        startActivation: async () => ({
          childId: 'child',
          result: Promise.resolve({}),
          dispose: async () => undefined,
        }),
      },
    }
    const host = createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      createRuntime: async (options) => ({
        slug: options.manifest.slug,
        packageDir: options.packageDir,
        workspaceRoot: options.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
      }),
    })
    const pkg = await host.findInvocable('weekly-report')
    const dispatched = await host.dispatch({
      ctx: ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })
    // `skills.ts` attaches the package tools before binding the child.
    const request = ctx.huaanworkAgentPackageRequest.current as {
      runtime: { mcpNames?: string[] }
      bindChild(sessionId: string): void
    } | null
    expect(request).not.toBeNull()
    attachAgentTools(attachments, 'child', [...AGENT_PACKAGE_CHILD_TOOLS, ...(request!.runtime.mcpNames ?? [])])
    request!.bindChild('child')
    expect(attachments.sessionAgentTools.get('child')).toEqual(new Set(AGENT_PACKAGE_CHILD_TOOLS))

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await dispatched.afterIdle()
    } finally {
      errorSpy.mockRestore()
    }
    expect(attachments.sessionAgentTools.has('child')).toBe(false)
  })

  test('tracks bound child sessions for the policy and clears them on cleanup', async () => {
    const profileDir = makeRoot('agent-package-profile-')
    const packageDir = join(profileDir, 'agents', 'weekly-report')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, 'agent.json'),
      JSON.stringify({
        schemaVersion: 1,
        slug: 'weekly-report',
        displayName: '周报助手',
        description: '把一周工作整理成周报',
        version: '1.0.0',
        draftId: 'draft-minimal',
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
        persona: 'persona.md',
        skill: null,
        tools: { mode: 'none' },
        allowSkills: [],
      }),
      'utf8',
    )
    writeFileSync(join(packageDir, 'persona.md'), '你是周报助手。', 'utf8')
    writeFileSync(
      join(profileDir, 'agents-state.json'),
      JSON.stringify({ 'local:weekly-report': { source: 'local', enabled: true, installedVersion: '1.0.0' } }),
      'utf8',
    )

    const childSessions = new Set<string>()
    const ctx = {
      huaanworkAttachments: emptyAttachments(),
      huaanworkWorkspaceRoot: { current: makeRoot('agent-package-ws-') },
      huaanworkAgentPackageRequest: { current: null },
      huaanworkPackageChildSessions: childSessions,
      huaanworkSubagentRuns: createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined }),
      subagents: {
        startActivation: async () => ({
          childId: 'child',
          result: Promise.resolve({}),
          dispose: async () => undefined,
        }),
      },
    }
    const host = createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      createRuntime: async (options) => ({
        slug: options.manifest.slug,
        packageDir: options.packageDir,
        workspaceRoot: options.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
      }),
    })
    const pkg = await host.findInvocable('weekly-report')
    const dispatched = await host.dispatch({
      ctx: ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    // 预留 id 与 activation 实际返回的 id 都算本回合的包子会话。
    const request = ctx.huaanworkAgentPackageRequest.current as {
      childId: string
      bindChild(sessionId: string): void
    } | null
    expect(request).not.toBeNull()
    expect(childSessions.has(request!.childId)).toBe(true)
    expect(childSessions.has('child')).toBe(true)

    // provider 另分配 id 时 skills.ts 补绑的路径也要登记。
    request!.bindChild('late-child')
    expect(childSessions.has('late-child')).toBe(true)

    await dispatched.afterIdle()
    expect(childSessions.size).toBe(0)
  })

  test('refuses a package whose declared HTTP entry is missing', async () => {
    const profileDir = installHttpPackage()
    rmSync(join(profileDir, 'agents', 'weekly-report', 'tools', 'http', 'server.mjs'))
    const host = createAgentPackageHost({ profileDir, takenSlugs: () => [] })
    const pkg = await host.findInvocable('weekly-report')

    expect(pkg?.broken?.reason).toContain('tools/http/server.mjs 缺失')
    await expect(
      host.dispatch({
        ctx: {
          huaanworkSubagentRuns: createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined }),
        } as never,
        sessionId: 'parent-session',
        pkg: pkg!,
        remainder: '写周报',
      }),
    ).rejects.toThrow(/已损坏.*tools\/http\/server\.mjs 缺失/)
  })
})

describe('agent package start cancellation', () => {
  test('refuses to spawn any process when the start signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let confineCalls = 0
    const sandbox: AgentPackageSandbox = {
      async confine(argv) {
        confineCalls += 1
        return { argv, enforcement: 'full' }
      },
    }
    const workspaceRoot = makeRoot('agent-package-ws-')
    await expect(
      startAgentPackageProcesses({
        manifest: manifestWithMode('http'),
        packageDir: FIXTURE_DIR,
        workspaceRoot,
        getSandbox: () => sandbox,
        signal: controller.signal,
      }),
    ).rejects.toThrow(AGENT_PACKAGE_START_CANCELLED)
    expect(confineCalls).toBe(0)
    expect(existsSync(join(workspaceRoot, 'http-port.txt'))).toBe(false)
  })

  test('aborting while the sandbox prepares the spawn prevents the child process', { timeout: 20_000 }, async () => {
    const controller = new AbortController()
    let confineStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      confineStarted = resolve
    })
    let releaseConfine = (): void => undefined
    const confined = new Promise<void>((resolve) => {
      releaseConfine = resolve
    })
    const sandbox: AgentPackageSandbox = {
      async confine(argv) {
        confineStarted()
        await confined
        return { argv, enforcement: 'full' }
      },
    }
    const workspaceRoot = makeRoot('agent-package-ws-')
    const starting = startAgentPackageProcesses({
      manifest: manifestWithMode('http'),
      packageDir: FIXTURE_DIR,
      workspaceRoot,
      getSandbox: () => sandbox,
      signal: controller.signal,
    })
    await started
    controller.abort()
    releaseConfine()
    await expect(starting).rejects.toThrow(AGENT_PACKAGE_START_CANCELLED)
    expect(existsSync(join(workspaceRoot, 'http-port.txt'))).toBe(false)
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

describe('agent package catalog damage', () => {
  const CATALOG_NOW = '2026-10-25T00:00:00.000Z'
  const CATALOG_SLUG = 'weekly-report'

  /**
   * 一个结构完好、签名有效的 catalog 包(真实 keyring + Ed25519 签名)。
   *
   * 落盘形态与 catalog-install 一致:内容文件 + `.signature/` 两份文档;
   * state 标记 `enabled:true`,模拟「升级/修改前本来是可用的」。
   */
  function writeCatalogPackage(): { profileDir: string; packageDir: string; host: ReturnType<typeof createAgentPackageHost> } {
    const profileDir = makeRoot('agent-package-profile-')
    const keyPair = generateKeyPair()
    writeFileSync(
      join(profileDir, 'agent-catalog-keyring.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          keys: [{ keyId: fingerprintPublicKeyHex(keyPair.publicKeyHex), publicKeyHex: keyPair.publicKeyHex, slot: 1 }],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const packageDir = join(profileDir, 'agents', CATALOG_SLUG)
    mkdirSync(packageDir, { recursive: true })
    const manifest: AgentPackageManifest = {
      schemaVersion: 1,
      slug: CATALOG_SLUG,
      displayName: '周报助手',
      description: '把一周工作整理成周报',
      version: '1.0.0',
      draftId: 'draft-signed',
      createdAt: CATALOG_NOW,
      updatedAt: CATALOG_NOW,
      persona: 'persona.md',
      skill: null,
      tools: { mode: 'none' },
      allowSkills: [],
    }
    const files = [
      { path: 'agent.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
      { path: 'persona.md', data: Buffer.from('你是周报助手。\n', 'utf8') },
    ]
    for (const file of files) writeFileSync(join(packageDir, file.path), file.data)
    const digest = createAgentPackageDigest(manifest, files)
    const signature = signAgentPackageDigest(digest, {
      privateKeyPem: keyPair.privateKeyPem,
      slot: 1,
      signedAt: CATALOG_NOW,
    })
    mkdirSync(join(packageDir, '.signature'), { recursive: true })
    writeFileSync(join(packageDir, '.signature', 'package-digest.json'), canonicalJson(digest), 'utf8')
    writeFileSync(join(packageDir, '.signature', 'signature.json'), JSON.stringify(signature), 'utf8')
    writeFileSync(
      join(profileDir, 'agents-state.json'),
      JSON.stringify({
        [`catalog:${CATALOG_SLUG}`]: {
          source: 'catalog',
          enabled: true,
          installedVersion: '1.0.0',
          publishStatus: 'installed',
        },
      }),
      'utf8',
    )

    const security = createAgentCatalogSecurity({
      profileDir,
      registry: createAgentPackageActiveTurnRegistry(),
    })
    // 空 legacy 目录:`invocableWithLegacy` 的装配要求,不影响本地包断言。
    const legacy = { list: () => ({ items: [] }) } as unknown as AgentsHost
    const host = createAgentPackageHost({ profileDir, takenSlugs: () => [], security, legacy: () => legacy })
    return { profileDir, packageDir, host }
  }

  test('does not enable, dispatch, or list a signature-invalid catalog package', async () => {
    const { profileDir, packageDir, host } = writeCatalogPackage()
    // 签名之后篡改人设:结构仍然完好(store 不报 broken),但目录验签必然失败。
    writeFileSync(join(packageDir, 'persona.md'), '被篡改的人设\n', 'utf8')

    // 已启用状态下的启用操作同样要过验签,不能靠「本来就是开的」绕过。
    expect(() => host.setEnabled(CATALOG_SLUG, true)).toThrow(/包校验失败/)

    // 同步列表仍展示启用态(界面要能给出移除入口),但 @ 补全不再列出它。
    const listed = host.listLocal().find((item) => item.slug === CATALOG_SLUG)
    expect(listed?.enabled).toBe(true)
    const invocable = await host.invocableWithLegacy()
    expect(invocable.items.some((item) => item.name === CATALOG_SLUG)).toBe(false)

    // 运行门与补全同源:dispatch 仍然 fail closed。
    const detail = host.detail(CATALOG_SLUG)
    expect(detail).toBeDefined()
    await expect(
      host.dispatch({
        ctx: {
          huaanworkWorkspaceRoot: { current: makeRoot('agent-package-ws-') },
          huaanworkSubagentRuns: createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined }),
          subagents: {
            startActivation: async () => ({
              childId: 'child',
              result: Promise.resolve({}),
              dispose: async () => undefined,
            }),
          },
        } as never,
        sessionId: 'parent-session',
        pkg: detail!,
        remainder: '写一份周报',
        resolveParent: async () => ({ id: 'parent-agent' }),
      }),
    ).rejects.toThrow(/包校验失败/)

    // 损坏包仍允许关闭(移除/重装才是出路)。
    host.setEnabled(CATALOG_SLUG, false)
    expect(readAgentPackageState(profileDir)[`catalog:${CATALOG_SLUG}`]?.enabled).toBe(false)
  })
})

describe('agent package subagent run projection', () => {
  const MINIMAL_MANIFEST = {
    schemaVersion: 1,
    slug: 'weekly-report',
    displayName: '周报助手',
    description: '把一周工作整理成周报',
    version: '1.0.0',
    draftId: 'draft-run',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    persona: 'persona.md',
    skill: null,
    tools: { mode: 'none' },
    allowSkills: [],
  } as const

  /** 最小可运行本地包:无工具/无技能,运行链只走 persona 与子代理。 */
  function installRunPackage(enabled = true): string {
    const profileDir = makeRoot('agent-package-profile-')
    const packageDir = join(profileDir, 'agents', 'weekly-report')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'agent.json'), `${JSON.stringify(MINIMAL_MANIFEST, null, 2)}\n`, 'utf8')
    writeFileSync(join(packageDir, 'persona.md'), '你是周报助手。', 'utf8')
    writeFileSync(
      join(profileDir, 'agents-state.json'),
      JSON.stringify({ 'local:weekly-report': { source: 'local', enabled, installedVersion: '1.0.0' } }),
      'utf8',
    )
    return profileDir
  }

  type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
  }

  function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined
    let reject: (error: unknown) => void = () => undefined
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  /** 跨受控 Promise 链的宏任务等待(真实 timers,无文件 I/O)。 */
  async function waitForCondition(condition: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
      await delay(5)
    }
  }

  /** 只跨受控 fixture 的 Promise 链:微任务轮询即可。 */
  async function flushMicrotasks(condition: () => boolean, attempts = 100): Promise<void> {
    for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) await Promise.resolve()
  }

  type RunHarnessOptions = {
    enabled?: boolean
    cleanupTimeoutMs?: number
    createRuntime?: (start: StartAgentPackageProcessesOptions) => Promise<AgentPackageTurnRuntime>
    stopRuntime?: (runtime: AgentPackageTurnRuntime) => Promise<void>
    startActivation?: (spec: SubagentActivationSpec) => Promise<SubagentActivationHandle>
  }

  type RunHarness = {
    profileDir: string
    runs: SubagentRunRegistry
    ctx: Record<string, unknown>
    host: ReturnType<typeof createAgentPackageHost>
    dispatch: (
      sessionId: string,
      extra?: { clientMessageId?: string },
    ) => Promise<Awaited<ReturnType<AgentPackageHost['dispatch']>>>
  }

  function runHarness(options: RunHarnessOptions = {}): RunHarness {
    const profileDir = installRunPackage(options.enabled ?? true)
    const runs = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
    const ctx: Record<string, unknown> = {
      get: () => undefined,
      huaanworkWorkspaceRoot: { current: join(profileDir, 'workspace') },
      huaanworkAgentPackageRequest: { current: null },
      huaanworkSubagentRuns: runs,
      subagents: {
        startActivation:
          options.startActivation ??
          (async (spec: SubagentActivationSpec) => ({
            childId: spec.childId ?? 'child',
            result: Promise.resolve({ stopReason: 'completed' }),
            dispose: async () => undefined,
          })),
      },
    }
    const host = createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      ...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
      createRuntime:
        options.createRuntime ??
        (async (start) => ({
          slug: start.manifest.slug,
          packageDir: start.packageDir,
          workspaceRoot: start.workspaceRoot,
          skillScripts: [],
          runSkillScript: async () => ({ text: '' }),
        })),
      stopRuntime: options.stopRuntime ?? (async () => undefined),
    })
    const dispatch = async (sessionId: string, extra: { clientMessageId?: string } = {}) => {
      const pkg = await host.findInvocable('weekly-report')
      if (pkg === undefined) throw new Error('fixture package missing')
      return host.dispatch({
        ctx: ctx as never,
        sessionId,
        pkg,
        remainder: '写一份周报',
        resolveParent: async () => ({ id: 'parent-agent' }),
        ...extra,
      })
    }
    return { profileDir, runs, ctx, host, dispatch }
  }

  async function firstRunId(runs: SubagentRunRegistry, sessionId: string): Promise<string> {
    let runId = ''
    await waitForCondition(() => {
      runId = runs.snapshot(sessionId).runs[0]?.runId ?? ''
      return runId !== ''
    }, `run for ${sessionId}`)
    return runId
  }

  function runtimeFor(start: StartAgentPackageProcessesOptions, label: string): AgentPackageTurnRuntime {
    return {
      slug: start.manifest.slug,
      packageDir: start.packageDir,
      workspaceRoot: label,
      skillScripts: [],
      runSkillScript: async () => ({ text: '' }),
    }
  }

  test('one package dispatch projects exactly one run with version, message id, and request run id', async () => {
    const harness = runHarness()
    const dispatched = await harness.dispatch('parent-session', { clientMessageId: 'msg-1' })

    const runs = harness.runs.snapshot('parent-session').runs
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.kind).toBe('package')
    expect(run.label).toBe('@weekly-report')
    expect(run.packageVersion).toBe('1.0.0')
    expect(run.clientMessageId).toBe('msg-1')
    const request = harness.ctx.huaanworkAgentPackageRequest as {
      current: { runId: string; childId: string } | null
    }
    expect(request.current?.runId).toBe(run.runId)
    expect(run.childId).toBe(request.current?.childId)

    await dispatched.afterIdle()
    const settled = harness.runs.get(run.runId)!
    expect(settled.phase).toBe('completed')
    expect(settled.cleanupWarnings).toEqual([])
    expect(settled.cleanupBudgetMs).toBeUndefined()
  })

  test('a disabled package fails the run instead of leaving it starting', async () => {
    const harness = runHarness({ enabled: false })
    await expect(harness.dispatch('parent-session')).rejects.toThrow('智能体「weekly-report」未启用或不存在')

    const runs = harness.runs.snapshot('parent-session').runs
    expect(runs).toHaveLength(1)
    expect(runs[0]!.phase).toBe('failed')
    expect(runs[0]!.failure).toContain('未启用或不存在')
  })

  test('dispatch fails loudly when the run registry was not injected', async () => {
    const harness = runHarness()
    const ctx = { ...harness.ctx }
    delete ctx.huaanworkSubagentRuns
    const pkg = await harness.host.findInvocable('weekly-report')
    await expect(
      harness.host.dispatch({
        ctx: ctx as never,
        sessionId: 'parent-session',
        pkg: pkg!,
        remainder: '写一份周报',
        resolveParent: async () => ({ id: 'parent-agent' }),
      }),
    ).rejects.toThrow(/subagent run registry is not initialized/)
  })

  test('cancelling during createRuntime stops the selected late runtime only', async () => {
    const gateA = deferred<AgentPackageTurnRuntime>()
    const gateB = deferred<AgentPackageTurnRuntime>()
    const createStartedA = deferred<void>()
    const createStartedB = deferred<void>()
    const stopsA: string[] = []
    const stopsB: string[] = []
    const first = runHarness({
      createRuntime: (start) => {
        createStartedA.resolve()
        return gateA.promise.then((runtime) => runtime ?? runtimeFor(start, 'runtime-a'))
      },
      stopRuntime: async (runtime) => {
        stopsA.push(runtime.workspaceRoot)
      },
    })
    const second = runHarness({
      createRuntime: (start) => {
        createStartedB.resolve()
        return gateB.promise.then((runtime) => runtime ?? runtimeFor(start, 'runtime-b'))
      },
      stopRuntime: async (runtime) => {
        stopsB.push(runtime.workspaceRoot)
      },
    })

    const dispatchA = first.dispatch('session-a')
    void dispatchA.catch(() => undefined)
    const runA = await firstRunId(first.runs, 'session-a')
    await createStartedA.promise
    const dispatchB = second.dispatch('session-b')
    const runB = await firstRunId(second.runs, 'session-b')
    await createStartedB.promise

    // createRuntime 仍在途时取消:晚到的 runtime 必须被停,回合以取消结束。
    expect((await first.runs.requestCancel('session-a', runA)).status).toBe('accepted')
    expect(first.runs.get(runA)?.phase).toBe('stopping')
    gateA.resolve(undefined as never)
    await expect(dispatchA).rejects.toThrow(/回合已取消/)
    expect(stopsA).toHaveLength(1)
    expect(first.runs.get(runA)?.phase).toBe('stopped')

    // 兄弟 run 完全不受影响:它仍在启动中,进程从未被停。
    expect(second.runs.get(runB)?.phase).toBe('starting')
    expect(stopsB).toHaveLength(0)

    gateB.resolve(undefined as never)
    const dispatchedB = await dispatchB
    await dispatchedB.afterIdle()
    expect(second.runs.get(runB)?.phase).toBe('completed')
    expect(stopsB).toHaveLength(1)
  })

  test('cancelling during startActivation disposes the selected late activation only', async () => {
    const activationA = deferred<SubagentActivationHandle>()
    const activationB = deferred<SubagentActivationHandle>()
    const activationStartedA = deferred<void>()
    const activationStartedB = deferred<void>()
    const disposalsA: string[] = []
    const disposalsB: string[] = []
    const stopsA: string[] = []
    const stopsB: string[] = []
    const first = runHarness({
      createRuntime: async (start) => runtimeFor(start, 'runtime-a'),
      stopRuntime: async (runtime) => {
        stopsA.push(runtime.workspaceRoot)
      },
      startActivation: () => {
        activationStartedA.resolve()
        return activationA.promise
      },
    })
    const second = runHarness({
      createRuntime: async (start) => runtimeFor(start, 'runtime-b'),
      stopRuntime: async (runtime) => {
        stopsB.push(runtime.workspaceRoot)
      },
      startActivation: () => {
        activationStartedB.resolve()
        return activationB.promise
      },
    })

    const dispatchA = first.dispatch('session-a')
    void dispatchA.catch(() => undefined)
    const runA = await firstRunId(first.runs, 'session-a')
    await activationStartedA.promise
    const dispatchB = second.dispatch('session-b')
    const runB = await firstRunId(second.runs, 'session-b')
    await activationStartedB.promise

    // startActivation 仍在途时取消:晚到的 activation 必须 dispose,不得继续运行。
    expect((await first.runs.requestCancel('session-a', runA)).status).toBe('accepted')
    expect(first.runs.get(runA)?.phase).toBe('stopping')
    activationA.resolve({
      childId: 'child-a',
      result: new Promise(() => undefined),
      dispose: async () => {
        disposalsA.push('child-a')
      },
    })
    await expect(dispatchA).rejects.toThrow(/回合已取消/)
    expect(disposalsA).toEqual(['child-a'])
    expect(stopsA).toHaveLength(1)
    expect(first.runs.get(runA)?.phase).toBe('stopped')

    expect(second.runs.get(runB)?.phase).toBe('starting')
    expect(disposalsB).toHaveLength(0)
    expect(stopsB).toHaveLength(0)

    activationB.resolve({
      childId: 'child-b',
      result: Promise.resolve({ stopReason: 'completed' }),
      dispose: async () => {
        disposalsB.push('child-b')
      },
    })
    const dispatchedB = await dispatchB
    await dispatchedB.afterIdle()
    expect(disposalsB).toEqual(['child-b'])
    expect(second.runs.get(runB)?.phase).toBe('completed')
  })

  test('a deferred runtime stop keeps the selected run stopping until cleanup is confirmed', async () => {
    const stopGate = deferred<void>()
    const stoppedA: string[] = []
    const stoppedB: string[] = []
    const first = runHarness({
      createRuntime: async (start) => runtimeFor(start, 'runtime-a'),
      stopRuntime: async (runtime) => {
        stoppedA.push(runtime.workspaceRoot)
        await stopGate.promise
      },
      startActivation: async (spec) => ({
        childId: spec.childId ?? 'child-a',
        // 权威结果已到(aborted),但停止闩接管后仍要等清理确认才 stopped。
        result: Promise.resolve({ stopReason: 'aborted' }),
        dispose: async () => undefined,
      }),
    })
    const second = runHarness({
      createRuntime: async (start) => runtimeFor(start, 'runtime-b'),
      stopRuntime: async (runtime) => {
        stoppedB.push(runtime.workspaceRoot)
      },
    })

    const dispatchA = await first.dispatch('session-a')
    const runA = await firstRunId(first.runs, 'session-a')
    const dispatchB = await second.dispatch('session-b')
    const runB = await firstRunId(second.runs, 'session-b')

    const accepted = await first.runs.requestCancel('session-a', runA)
    expect(accepted.status).toBe('accepted')
    expect(first.runs.get(runA)?.phase).toBe('stopping')
    await flushMicrotasks(() => stoppedA.length === 1)
    expect(stoppedA).toEqual(['runtime-a'])
    // runtime stop 尚未确认:不得提前报 stopped。
    expect(first.runs.get(runA)?.phase).toBe('stopping')

    stopGate.resolve()
    await flushMicrotasks(() => first.runs.get(runA)?.phase === 'stopped')
    expect(first.runs.get(runA)?.phase).toBe('stopped')
    // 定向取消只停选中的 run,兄弟 runtime 的 stop 调用次数为零。
    expect(stoppedA).toEqual(['runtime-a'])
    expect(stoppedB).toHaveLength(0)
    expect(second.runs.get(runB)?.phase).toBe('completed')

    await dispatchA.afterIdle()
    await dispatchB.afterIdle()
  })

  test('a rejected activation result after a targeted cancel keeps stopping until cleanup confirms', async () => {
    const result = deferred<unknown>()
    const disposeGate = deferred<void>()
    let disposeCalls = 0
    const harness = runHarness({
      startActivation: async (spec) => ({
        childId: spec.childId ?? 'child',
        result: result.promise,
        dispose: async () => {
          disposeCalls += 1
          await disposeGate.promise
        },
      }),
    })

    const dispatched = await harness.dispatch('parent-session')
    const runId = await firstRunId(harness.runs, 'parent-session')
    expect((await harness.runs.requestCancel('parent-session', runId)).status).toBe('accepted')
    expect(harness.runs.get(runId)?.phase).toBe('stopping')
    await flushMicrotasks(() => disposeCalls === 1)
    expect(disposeCalls).toBe(1)

    result.reject(new Error('子代理结果失败'))
    await flushMicrotasks(() => harness.runs.get(runId)?.failure !== undefined)
    // 停止闩已接管:rejection 只保留 failure,不得提前发布 failed。
    expect(harness.runs.get(runId)?.phase).toBe('stopping')
    expect(harness.runs.get(runId)?.failure).toContain('子代理结果失败')

    disposeGate.resolve()
    await flushMicrotasks(() => harness.runs.get(runId)?.phase === 'stopped')
    expect(harness.runs.get(runId)?.phase).toBe('stopped')
    expect(harness.runs.get(runId)?.failure).toContain('子代理结果失败')
    expect(disposeCalls).toBe(1)
    await dispatched.afterIdle()
  })

  test('a short cleanup budget marks the run stopping and only converges after dispose (A-08)', async () => {
    const result = deferred<unknown>()
    const disposeGate = deferred<void>()
    let disposeCalls = 0
    const harness = runHarness({
      cleanupTimeoutMs: 20,
      startActivation: async (spec) => ({
        childId: spec.childId ?? 'child',
        result: result.promise,
        dispose: async () => {
          disposeCalls += 1
          await disposeGate.promise
          // 真实 dispose 会终止子代理:result 以 rejection 结算。
          result.reject(new Error('子代理已停止'))
        },
      }),
    })
    const dispatched = await harness.dispatch('parent-session')
    const runId = await firstRunId(harness.runs, 'parent-session')

    // 父未 idle:还没有任何清理等待,时间流逝不得写 cleanupBudgetMs。
    await delay(40)
    expect(harness.runs.get(runId)?.cleanupBudgetMs).toBeUndefined()
    expect(harness.runs.get(runId)?.phase).toBe('starting')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cleanup = dispatched.afterIdle()
      await waitForCondition(() => harness.runs.get(runId)?.cleanupBudgetMs === 20, 'cleanup budget recorded')
      await waitForCondition(() => disposeCalls === 1, 'dispose starts after the budget')
      // registry 契约(W10):未终态的预算到期只写 cleanupBudgetMs + stopCause,
      // 不追加 cleanup-budget-exceeded;客户端由这两个字段派生横幅。
      expect(harness.runs.get(runId)?.stopCause).toBe('cleanup-budget')
      expect(harness.runs.get(runId)?.phase).toBe('stopping')
      expect(harness.runs.get(runId)?.cleanupWarnings).toEqual([])
      // dispose 未确认前不得伪报 stopped。
      expect(harness.runs.get(runId)?.phase).toBe('stopping')

      disposeGate.resolve()
      await cleanup
    } finally {
      errorSpy.mockRestore()
    }

    const run = harness.runs.get(runId)!
    expect(run.phase).toBe('stopped')
    expect(run.cleanupBudgetMs).toBe(20)
    expect(run.stopCause).toBe('cleanup-budget')
    expect(run.cleanupWarnings).toEqual([])
    expect(disposeCalls).toBe(1)
  })

  test('a deferred late-activation dispose keeps the cancelled run stopping until dispose settles', async () => {
    const activation = deferred<SubagentActivationHandle>()
    const activationStarted = deferred<void>()
    const disposeGate = deferred<void>()
    let disposeCalls = 0
    const harness = runHarness({
      startActivation: () => {
        activationStarted.resolve()
        return activation.promise
      },
    })

    const dispatched = harness.dispatch('parent-session')
    void dispatched.catch(() => undefined)
    const runId = await firstRunId(harness.runs, 'parent-session')
    await activationStarted.promise

    // activation 尚未发布:取消路径的清理确认覆盖不到即将晚到的 activation。
    expect((await harness.runs.requestCancel('parent-session', runId)).status).toBe('accepted')
    await flushMicrotasks(() => false, 50)
    expect(harness.runs.get(runId)?.phase).toBe('stopping')

    activation.resolve({
      childId: 'child-late',
      // 权威结果已结算(aborted):观察者会立刻上报执行终结。
      result: Promise.resolve({ stopReason: 'aborted' }),
      dispose: async () => {
        disposeCalls += 1
        await disposeGate.promise
      },
    })
    await flushMicrotasks(() => disposeCalls === 1)
    await flushMicrotasks(() => false, 20)
    // 执行终结 + 早先「零失败」的确认不得拼出 stopped:dispose 仍在途。
    expect(disposeCalls).toBe(1)
    expect(harness.runs.get(runId)?.phase).toBe('stopping')
    expect(harness.runs.get(runId)?.cleanupWarnings).toEqual([])

    disposeGate.resolve()
    await flushMicrotasks(() => harness.runs.get(runId)?.phase === 'stopped')
    expect(harness.runs.get(runId)?.phase).toBe('stopped')
    expect(harness.runs.get(runId)?.cleanupWarnings).toEqual([])
    await expect(dispatched).rejects.toThrow(/回合已取消/)
  })

  test('a rejected late-activation dispose never publishes stopped', async () => {
    const activation = deferred<SubagentActivationHandle>()
    const activationStarted = deferred<void>()
    const disposeGate = deferred<void>()
    let disposeCalls = 0
    const harness = runHarness({
      startActivation: () => {
        activationStarted.resolve()
        return activation.promise
      },
    })

    const dispatched = harness.dispatch('parent-session')
    void dispatched.catch(() => undefined)
    const runId = await firstRunId(harness.runs, 'parent-session')
    await activationStarted.promise
    expect((await harness.runs.requestCancel('parent-session', runId)).status).toBe('accepted')
    await flushMicrotasks(() => false, 50)

    activation.resolve({
      childId: 'child-late',
      result: Promise.resolve({ stopReason: 'aborted' }),
      dispose: async () => {
        disposeCalls += 1
        await disposeGate.promise
        throw new Error('dispose failed')
      },
    })
    await flushMicrotasks(() => disposeCalls === 1)
    await flushMicrotasks(() => false, 20)
    expect(harness.runs.get(runId)?.phase).toBe('stopping')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      disposeGate.resolve()
      await expect(dispatched).rejects.toThrow(/回合已取消/)
    } finally {
      errorSpy.mockRestore()
    }

    const run = harness.runs.get(runId)!
    expect(run.phase).toBe('stopping')
    expect(run.cleanupWarnings).toEqual([{ code: 'activation-dispose-failed', severity: 'error' }])
    await delay(20)
    expect(harness.runs.get(runId)?.phase).toBe('stopping')
  })

  test('a late-activation dispose timeout leaves the run stopping with an error warning', async () => {
    const activation = deferred<SubagentActivationHandle>()
    const activationStarted = deferred<void>()
    let disposeCalls = 0
    const harness = runHarness({
      cleanupTimeoutMs: 20,
      startActivation: () => {
        activationStarted.resolve()
        return activation.promise
      },
    })

    const dispatched = harness.dispatch('parent-session')
    void dispatched.catch(() => undefined)
    const runId = await firstRunId(harness.runs, 'parent-session')
    await activationStarted.promise
    expect((await harness.runs.requestCancel('parent-session', runId)).status).toBe('accepted')
    await flushMicrotasks(() => false, 50)

    activation.resolve({
      childId: 'child-late',
      result: Promise.resolve({ stopReason: 'aborted' }),
      dispose: () => {
        disposeCalls += 1
        return new Promise(() => undefined)
      },
    })
    await flushMicrotasks(() => disposeCalls === 1)
    await flushMicrotasks(() => false, 20)
    expect(harness.runs.get(runId)?.phase).toBe('stopping')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(dispatched).rejects.toThrow(/回合已取消/)
    } finally {
      errorSpy.mockRestore()
    }

    const run = harness.runs.get(runId)!
    expect(run.phase).toBe('stopping')
    expect(run.cleanupWarnings).toEqual([{ code: 'activation-dispose-timeout', severity: 'error' }])
    await delay(20)
    expect(harness.runs.get(runId)?.phase).toBe('stopping')
  })

  test('a failed runtime stop on the cancel path never publishes stopped', async () => {
    const runtimeGate = deferred<AgentPackageTurnRuntime>()
    const createStarted = deferred<void>()
    const harness = runHarness({
      createRuntime: (start) => {
        createStarted.resolve()
        return runtimeGate.promise.then((runtime) => runtime ?? runtimeFor(start, 'runtime-a'))
      },
      stopRuntime: async () => {
        throw new Error('stop failed')
      },
    })

    const dispatched = harness.dispatch('parent-session')
    void dispatched.catch(() => undefined)
    const runId = await firstRunId(harness.runs, 'parent-session')
    await createStarted.promise
    expect((await harness.runs.requestCancel('parent-session', runId)).status).toBe('accepted')
    expect(harness.runs.get(runId)?.phase).toBe('stopping')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      runtimeGate.resolve(undefined as never)
      await expect(dispatched).rejects.toThrow(/回合已取消/)
    } finally {
      errorSpy.mockRestore()
    }

    const run = harness.runs.get(runId)!
    expect(run.phase).toBe('stopping')
    expect(run.cleanupWarnings).toEqual([{ code: 'runtime-stop-failed', severity: 'error' }])
    await delay(20)
    expect(harness.runs.get(runId)?.phase).toBe('stopping')
  })

  test('cleanup failures are projected as coded error warnings', async () => {
    const harness = runHarness({
      cleanupTimeoutMs: 20,
      startActivation: async (spec) => ({
        childId: spec.childId ?? 'child',
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose: () => new Promise(() => undefined),
      }),
      stopRuntime: async () => {
        throw new Error('stop failed')
      },
    })
    const dispatched = await harness.dispatch('parent-session')
    const runId = await firstRunId(harness.runs, 'parent-session')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await dispatched.afterIdle()
    } finally {
      errorSpy.mockRestore()
    }

    const run = harness.runs.get(runId)!
    // 执行结果自然完成:清理失败只追加结构化告警,不改相位。
    expect(run.phase).toBe('completed')
    expect(run.cleanupWarnings).toEqual([
      { code: 'activation-dispose-timeout', severity: 'error' },
      { code: 'runtime-stop-failed', severity: 'error' },
    ])
    expect(run.cleanupBudgetMs).toBeUndefined()
  })
})
