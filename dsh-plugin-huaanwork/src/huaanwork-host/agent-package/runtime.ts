import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { parseSkillMarkdown } from '../../huaanwork-guardrails/skills.ts'
import { resolveInvocableSkill } from '../skill-invoke.ts'

import type { AgentPackageManifest, AgentPackageTurnRuntime } from './types.ts'

/** Fail-closed message shared by every path that would otherwise spawn unconfined. */
export const AGENT_PACKAGE_SANDBOX_UNAVAILABLE = '当前系统无法启动沙箱，智能体未运行'

const MAX_PERSONA_BYTES = 64 * 1024
const MAX_SCRIPT_STDOUT_BYTES = 32 * 1024
const MAX_STDERR_CHARS = 500
/** Cap for the host-side copy of each child stream; output truncation happens later. */
const MAX_CAPTURE_BYTES = 256 * 1024
const HEALTH_TIMEOUT_MS = 5_000
const PORT_RETRIES = 3
const STOP_GRACE_MS = 2_000
/** M1 has no cross-turn script state; a single script call may not outlive this. */
const SCRIPT_HARD_CAP_MS = 150_000
const SCRIPT_START_FAILURE_PREFIX = '脚本启动失败：'
const DEFAULT_HTTP_ENTRY = 'tools/http/server.mjs'
const DEFAULT_MCP_ENTRY = 'tools/mcp/server.mjs'
const ALLOWED_ENV_KEYS = ['PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMPDIR'] as const

/** The subset of `@deepseek-ai/dsh-sandbox` this module consumes. */
export type AgentPackageSandbox = {
  /**
   * Wrap an argv so the child runs under the workspace-write sandbox.
   * @param argv - command and arguments to wrap; `process.execPath` heads it
   * @param policy - workspace-write boundary for the child
   * @param signal - aborts preparation when the turn is cancelled
   * @returns the wrapped argv and the runner's self-reported enforcement level
   */
  confine(
    argv: readonly string[],
    policy: { mode: 'workspace-write'; workspaceRoot: string },
    signal?: AbortSignal,
  ): Promise<{ argv: readonly string[]; enforcement: 'full' | 'partial' }>
}

/** Every session id maps to at most one live runtime; later binds replace earlier ones. */
export type AgentPackageRuntimeRegistry = {
  bind(sessionId: string, runtime: AgentPackageTurnRuntime): void
  get(sessionId: string): AgentPackageTurnRuntime | undefined
  delete(sessionId: string): void
}

export type StartAgentPackageProcessesOptions = {
  manifest: AgentPackageManifest
  packageDir: string
  workspaceRoot: string
  /** Resolved per spawn so the caller can forward `() => ctx.get('sandbox')`. */
  getSandbox: () => AgentPackageSandbox | undefined
  /** When present, the MCP server must yield at least one tool name or the round fails. */
  mountMcp?: (port: number) => readonly string[] | Promise<readonly string[]>
  signal?: AbortSignal
}

type RunningTurn = {
  runtime: AgentPackageTurnRuntime
  stop: () => Promise<void>
}

/** Every live turn; `stopAllAgentPackageProcesses` is the application-level disposal hook. */
const runningTurns = new Set<RunningTurn>()
/** Every live child (server or skill script), including children of failed starts. */
const runningChildren = new Set<ChildProcess>()

/**
 * @param sessionId - session that owns the runtime (parent session or bound child)
 * @param runtime - the turn runtime to expose to tools
 * @returns a registry whose entries live until deleted or replaced
 */
export function createAgentPackageRuntimeRegistry(): AgentPackageRuntimeRegistry {
  const runtimes = new Map<string, AgentPackageTurnRuntime>()
  return {
    bind(sessionId, runtime) {
      runtimes.set(sessionId, runtime)
    },
    get(sessionId) {
      return runtimes.get(sessionId)
    },
    delete(sessionId) {
      runtimes.delete(sessionId)
    },
  }
}

/**
 * Compose the persona handed to the package subagent.
 *
 * Reads `persona.md`, the `skill/SKILL.md` body (frontmatter stripped), and each
 * `allowSkills` body, then ends with the package's absolute directory. Missing
 * files or unreadable skills throw errors that name the package slug.
 *
 * @param packageDir - package root containing persona.md and skill/
 * @param manifest - parsed agent.json
 * @param profileDir - profile root that owns user skills for `resolveInvocableSkill`
 * @returns the combined persona, at most 64 KiB in UTF-8
 */
export async function composeAgentPackagePersona(
  packageDir: string,
  manifest: AgentPackageManifest,
  profileDir: string,
): Promise<string> {
  const { slug } = manifest
  const sections = [readRequiredText(packageDir, 'persona.md', slug).trim()]

  if (manifest.skill !== null) {
    const markdown = readRequiredText(packageDir, manifest.skill.entry, slug)
    sections.push(`## 技能\n\n${parseSkillMarkdown(markdown).content.trim()}`)
  }

  for (const name of manifest.allowSkills) {
    let content: string
    try {
      content = (await resolveInvocableSkill(profileDir, name)).skill.content
    } catch (error) {
      throw new Error(`智能体 @${slug} 引用的技能 ${name} 不可用：${errorMessage(error)}`, { cause: error })
    }
    sections.push(`## 技能：${name}\n\n${content.trim()}`)
  }

  sections.push(`智能体包目录：${resolve(packageDir)}`)
  const persona = sections.join('\n\n')
  if (Buffer.byteLength(persona, 'utf8') > MAX_PERSONA_BYTES) {
    throw new Error(`智能体 @${slug} 的人设超过 64 KiB 上限`)
  }
  return persona
}

/**
 * Build the tool names the package subagent may use.
 *
 * Base tools are `read`/`read_file`/`glob`/`grep` plus the platform shell.
 * `agent_skill_run` appears only when the package declares skill scripts,
 * `agent_http` only for HTTP packages, and MCP tool names only for MCP packages.
 * `call_host_tool` is never included.
 *
 * @param manifest - parsed agent.json that selects the tool mode
 * @param mcpNames - tool names returned by the MCP mount callback
 * @param skillScripts - enumerated `skill/scripts/**` paths
 * @returns the allow list in stable order
 */
export function composeAgentPackageToolAllowList(
  manifest: AgentPackageManifest,
  mcpNames: readonly string[] = [],
  skillScripts: readonly string[] = [],
): string[] {
  const allow = new Set<string>([
    'read',
    'read_file',
    'glob',
    'grep',
    process.platform === 'win32' ? 'pwsh' : 'bash',
  ])
  if (skillScripts.length > 0) allow.add('agent_skill_run')
  const mode = manifest.tools.mode
  if (mode === 'http' || mode === 'both') allow.add('agent_http')
  if (mode === 'mcp' || mode === 'both') {
    for (const name of mcpNames) allow.add(name)
  }
  return [...allow]
}

/**
 * Start the package's HTTP and/or MCP servers under the injected sandbox and
 * return the turn runtime that owns them.
 *
 * The runtime enumerates `skill/scripts/**` (the package's script declaration),
 * starts every server on a free loopback port, and fails closed when no sandbox
 * is available or `confine` reports `SANDBOX_UNAVAILABLE`.
 *
 * @param options - manifest, package directory, workspace, sandbox resolver, and MCP mount hook
 * @returns the turn runtime; stop it with `stopAgentPackageProcesses`
 */
export async function startAgentPackageProcesses(
  options: StartAgentPackageProcessesOptions,
): Promise<AgentPackageTurnRuntime> {
  const { manifest, packageDir, workspaceRoot, getSandbox, mountMcp, signal } = options
  const skillScripts = listSkillScripts(packageDir)
  const mode = manifest.tools.mode
  const wantsHttp = mode === 'http' || mode === 'both'
  const wantsMcp = mode === 'mcp' || mode === 'both'

  let http: StartedServer | undefined
  let mcp: StartedServer | undefined
  try {
    if (wantsHttp) {
      http = await startServer({
        getSandbox,
        workspaceRoot,
        scriptPath: join(packageDir, manifest.tools.http?.entry ?? DEFAULT_HTTP_ENTRY),
        hostEnv: 'AGENT_HTTP_HOST',
        portEnv: 'AGENT_HTTP_PORT',
        label: 'HTTP',
        ...(signal === undefined ? {} : { signal }),
      })
    }
    if (wantsMcp) {
      mcp = await startServer({
        getSandbox,
        workspaceRoot,
        scriptPath: join(packageDir, manifest.tools.mcp?.entry ?? DEFAULT_MCP_ENTRY),
        hostEnv: 'AGENT_MCP_HOST',
        portEnv: 'AGENT_MCP_PORT',
        label: 'MCP',
        ...(mountMcp === undefined ? {} : { mount: mountMcp }),
        ...(signal === undefined ? {} : { signal }),
      })
    }
  } catch (error) {
    await teardownServers(http, mcp)
    throw error
  }

  let stateDir: string | undefined
  let stopped = false
  let stopPromise: Promise<void> | undefined
  const scriptChildren = new Set<ChildProcess>()
  /** Spawns still inside `confine`; stop waits for them so no child escapes teardown. */
  const pendingSpawns = new Set<Promise<unknown>>()

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise
    stopped = true
    stopPromise = (async () => {
      // A spawn racing with stop is added to scriptChildren only after this await;
      // the post-spawn `stopped` check in runSkillScript kills that child.
      await Promise.allSettled([...pendingSpawns])
      for (const child of [...scriptChildren]) await stopChild(child)
      if (http !== undefined) await stopChild(http.child.child)
      if (mcp !== undefined) await stopChild(mcp.child.child)
      if (stateDir !== undefined) {
        removeQuietly(stateDir)
        stateDir = undefined
      }
    })()
    return stopPromise
  }

  /**
   * Run one declared skill script.
   *
   * Infrastructure failures (missing sandbox, a sandbox that refuses to confine,
   * a spawn error) throw. Declared-script failures (undeclared path, non-zero
   * exit, cancellation, timeout, stopped runtime) return `isError` text: the
   * script ran or was requested within the declaration, and the model should see
   * the reason instead of a transport-style crash.
   */
  const runSkillScript = async (
    script: string,
    args: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<{ text: string; isError?: boolean }> => {
    if (stopped) return { text: stoppedText(), isError: true }
    if (skillScripts.length === 0) {
      return { text: `智能体 @${manifest.slug} 没有可运行的技能脚本`, isError: true }
    }
    let scriptPath: string
    try {
      scriptPath = resolveSkillScriptPath(packageDir, script, skillScripts)
    } catch (error) {
      return { text: errorMessage(error), isError: true }
    }

    const timeoutSignal = AbortSignal.timeout(SCRIPT_HARD_CAP_MS)
    const runSignal = callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal])
    if (runSignal.aborted) return { text: abortedText(callerSignal, timeoutSignal), isError: true }

    // Resolve before creating the per-turn state dir so a missing sandbox leaves no residue.
    const sandbox = getSandbox()
    if (sandbox === undefined) throw new Error(AGENT_PACKAGE_SANDBOX_UNAVAILABLE)
    if (stateDir === undefined) stateDir = mkdtempSync(join(tmpdir(), 'huaanwork-agent-state-'))
    const dir = stateDir
    const spawn = spawnConfined({
      getSandbox: () => sandbox,
      scriptPath,
      workspaceRoot,
      env: {
        AGENT_SCRIPT_ARGS: JSON.stringify(args),
        AGENT_WORKSPACE: workspaceRoot,
        AGENT_STATE_DIR: dir,
      },
      signal: runSignal,
    })
    pendingSpawns.add(spawn)
    let child: SpawnedProcess
    try {
      child = await spawn
    } finally {
      pendingSpawns.delete(spawn)
    }
    scriptChildren.add(child.child)
    const forgetChild = () => scriptChildren.delete(child.child)
    child.child.once('close', forgetChild)

    if (stopped) {
      await stopChild(child.child)
      if (stateDir !== undefined) {
        removeQuietly(stateDir)
        stateDir = undefined
      }
      return { text: stoppedText(), isError: true }
    }

    const kill = () => {
      void stopChild(child.child)
    }
    runSignal.addEventListener('abort', kill, { once: true })
    if (runSignal.aborted) kill()
    const exit = await child.exit
    runSignal.removeEventListener('abort', kill)
    scriptChildren.delete(child.child)

    if (stopped) return { text: stoppedText(), isError: true }
    if (timeoutSignal.aborted) {
      return { text: `技能脚本超时（${String(SCRIPT_HARD_CAP_MS / 1000)} 秒）`, isError: true }
    }
    if (callerSignal?.aborted === true) {
      return { text: `智能体 @${manifest.slug} 的技能脚本已取消`, isError: true }
    }
    if (exit.code !== 0 || exit.signal !== null) {
      const detail = child.stderr().slice(0, MAX_STDERR_CHARS)
      return {
        text: detail.length > 0 ? detail : `技能脚本退出码 ${String(exit.code ?? exit.signal)}`,
        isError: true,
      }
    }
    return { text: truncateUtf8(child.stdout(), MAX_SCRIPT_STDOUT_BYTES) }
  }

  const stoppedText = (): string => `智能体 @${manifest.slug} 的运行时已停止`

  const runtime: AgentPackageTurnRuntime = {
    slug: manifest.slug,
    packageDir,
    workspaceRoot,
    ...(http === undefined ? {} : { httpPort: http.port }),
    ...(mcp?.names === undefined ? {} : { mcpNames: mcp.names }),
    skillScripts,
    runSkillScript,
  }
  runningTurns.add({ runtime, stop })
  return runtime
}

/**
 * Stop one runtime's servers, skill scripts, and per-turn state directory.
 * Unknown or already stopped runtimes are a no-op.
 *
 * @param runtime - runtime returned by `startAgentPackageProcesses`
 */
export async function stopAgentPackageProcesses(runtime: AgentPackageTurnRuntime): Promise<void> {
  const handle = [...runningTurns].find((candidate) => candidate.runtime === runtime)
  if (handle === undefined) return
  await handle.stop()
  runningTurns.delete(handle)
}

/**
 * Stop every live runtime and any child a failed start left behind.
 * Task 6/index calls this when the owning plugin is disposed.
 */
export async function stopAllAgentPackageProcesses(): Promise<void> {
  const handles = [...runningTurns]
  await Promise.all(
    handles.map(async (handle) => {
      await handle.stop()
      runningTurns.delete(handle)
    }),
  )
  const leftovers = [...runningChildren]
  await Promise.all(leftovers.map((child) => stopChild(child)))
}

type StartedServer = {
  child: SpawnedProcess
  port: number
  names?: string[]
}

type StartServerOptions = {
  getSandbox: () => AgentPackageSandbox | undefined
  workspaceRoot: string
  scriptPath: string
  hostEnv: string
  portEnv: string
  label: string
  mount?: (port: number) => readonly string[] | Promise<readonly string[]>
  signal?: AbortSignal
}

async function startServer(options: StartServerOptions): Promise<StartedServer> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= PORT_RETRIES; attempt += 1) {
    const port = await findFreeLoopbackPort()
    const child = await spawnConfined({
      getSandbox: options.getSandbox,
      scriptPath: options.scriptPath,
      workspaceRoot: options.workspaceRoot,
      env: { [options.hostEnv]: '127.0.0.1', [options.portEnv]: String(port) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    try {
      // One health budget covers both TCP readiness and the MCP tool handshake.
      const deadline = Date.now() + HEALTH_TIMEOUT_MS
      await waitForTcp(child, port, deadline, options.signal)
      const remainingMs = deadline - Date.now()
      if (options.mount !== undefined && remainingMs <= 0) {
        throw new Error(`${SCRIPT_START_FAILURE_PREFIX}MCP 服务挂载超时`)
      }
      const names =
        options.mount === undefined
          ? undefined
          : [...await withDeadline(Promise.resolve(options.mount(port)), remainingMs, 'MCP 服务挂载超时')]
      if (names !== undefined && names.length === 0) {
        throw new Error(`MCP 服务未提供任何工具`)
      }
      return { child, port, ...(names === undefined ? {} : { names }) }
    } catch (error) {
      await stopChild(child.child)
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < PORT_RETRIES && isPortCollision(child.stderr())) continue
      throw lastError
    }
  }
  throw lastError ?? new Error(`${SCRIPT_START_FAILURE_PREFIX}${options.label} 服务启动失败`)
}

type SpawnedProcess = {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  hasExited: () => boolean
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

type SpawnConfinedOptions = {
  getSandbox: () => AgentPackageSandbox | undefined
  scriptPath: string
  workspaceRoot: string
  env: Record<string, string>
  signal?: AbortSignal
}

async function spawnConfined(options: SpawnConfinedOptions): Promise<SpawnedProcess> {
  const sandbox = options.getSandbox()
  if (sandbox === undefined) throw new Error(AGENT_PACKAGE_SANDBOX_UNAVAILABLE)

  let prepared: { argv: readonly string[]; enforcement: 'full' | 'partial' }
  try {
    prepared = await sandbox.confine(
      [process.execPath, options.scriptPath],
      { mode: 'workspace-write', workspaceRoot: options.workspaceRoot },
      options.signal,
    )
  } catch (error) {
    if (isSandboxUnavailable(error)) {
      throw new Error(AGENT_PACKAGE_SANDBOX_UNAVAILABLE, { cause: error })
    }
    throw error
  }

  const [command, ...args] = prepared.argv
  if (command === undefined) {
    throw new Error(`${SCRIPT_START_FAILURE_PREFIX}沙箱未返回可执行的命令`)
  }

  const child = spawn(command, args, {
    cwd: options.workspaceRoot,
    env: buildChildEnv(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    // A dedicated process group lets POSIX stop the wrapped runner and its descendant.
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  runningChildren.add(child)

  const stdout = createCapture(MAX_CAPTURE_BYTES)
  const stderr = createCapture(MAX_CAPTURE_BYTES)
  let exited = false
  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
    resolveExit = resolvePromise
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { stdout.append(chunk) })
  child.stderr?.on('data', (chunk: string) => { stderr.append(chunk) })
  child.once('error', (error) => {
    exited = true
    runningChildren.delete(child)
    stderr.append(errorMessage(error))
    resolveExit({ code: null, signal: null })
  })
  child.once('close', (code, signal) => {
    exited = true
    runningChildren.delete(child)
    resolveExit({ code, signal })
  })

  return {
    child,
    stdout: () => stdout.text(),
    stderr: () => stderr.text(),
    hasExited: () => exited || child.exitCode !== null || child.signalCode !== null,
    exit,
  }
}

type Capture = {
  append(chunk: string): void
  text(): string
}

/** Keep at most `limitBytes` of a stream so a chatty child cannot grow host memory. */
function createCapture(limitBytes: number): Capture {
  let text = ''
  let bytes = 0
  return {
    append(chunk) {
      if (bytes >= limitBytes) return
      const piece = truncateUtf8(chunk, limitBytes - bytes)
      text += piece
      bytes += Buffer.byteLength(piece, 'utf8')
    },
    text() {
      return text
    },
  }
}

function buildChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith('AGENT_')) env[key] = value
  }
  // Verified in the M1 sandbox probe: Electron's binary runs as Node with this flag.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

async function waitForTcp(child: SpawnedProcess, port: number, deadline: number, signal?: AbortSignal): Promise<void> {
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new Error('智能体启动已取消')
    if (child.hasExited()) throw startupFailure(child)
    if (await canConnect(port)) {
      if (child.hasExited()) throw startupFailure(child)
      return
    }
    await delay(50)
  }
  throw startupFailure(child, `5 秒内无法连接 127.0.0.1:${port}`)
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${SCRIPT_START_FAILURE_PREFIX}${message}`))
    }, Math.max(0, timeoutMs))
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    )
  })
}

function startupFailure(child: SpawnedProcess, fallback?: string): Error {
  const detail = child.stderr().slice(0, MAX_STDERR_CHARS)
  return new Error(`${SCRIPT_START_FAILURE_PREFIX}${detail.length > 0 ? detail : (fallback ?? '进程提前退出')}`)
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(open)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPromise(new Error('无法分配回环端口'))
        return
      }
      const { port } = address
      server.close(() => resolvePromise(port))
    })
  })
}

function listSkillScripts(packageDir: string): string[] {
  const scriptsRoot = join(packageDir, 'skill', 'scripts')
  const scripts: string[] = []
  const walk = (relativeDir: string): void => {
    let entries
    try {
      entries = readdirSync(join(scriptsRoot, relativeDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.signature') continue
      const next = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(next)
      } else if (entry.isFile()) {
        scripts.push(`skill/scripts/${next}`)
      }
    }
  }
  walk('')
  return scripts.sort()
}

function resolveSkillScriptPath(packageDir: string, script: string, declared: readonly string[]): string {
  if (!declared.includes(script)) throw new Error(`未声明的技能脚本：${script}`)
  const scriptsRoot = realpathSync(join(packageDir, 'skill', 'scripts'))
  const target = realpathSync(join(packageDir, script))
  const pathWithinRoot = relative(scriptsRoot, target)
  if (pathWithinRoot === '' || pathWithinRoot.startsWith('..') || isAbsolute(pathWithinRoot)) {
    throw new Error(`技能脚本越界：${script}`)
  }
  return target
}

async function teardownServers(http: StartedServer | undefined, mcp: StartedServer | undefined): Promise<void> {
  if (http !== undefined) await stopChild(http.child.child)
  if (mcp !== undefined) await stopChild(mcp.child.child)
}

async function stopChild(child: ChildProcess): Promise<void> {
  runningChildren.delete(child)
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (pid === undefined) return

  const closed = new Promise<void>((resolvePromise) => {
    // `close` fires after stdio closes, so a stopped child is fully settled here.
    child.once('close', () => resolvePromise())
    child.once('error', () => resolvePromise())
  })

  if (process.platform === 'win32') {
    await runTaskkill(pid)
    await Promise.race([closed, delay(STOP_GRACE_MS)])
    return
  }

  signalProcessGroup(child, pid, 'SIGTERM')
  const exited = await Promise.race([closed.then(() => true), delay(STOP_GRACE_MS).then(() => false)])
  if (exited) return
  signalProcessGroup(child, pid, 'SIGKILL')
  await Promise.race([closed, delay(1_000)])
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The child already exited between the liveness check and the signal.
    }
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolvePromise) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolvePromise())
  })
}

function readRequiredText(packageDir: string, relativePath: string, slug: string): string {
  try {
    return readFileSync(join(packageDir, relativePath), 'utf8')
  } catch (error) {
    throw new Error(`智能体 @${slug} 的 ${relativePath} 不可读`, { cause: error })
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

function isSandboxUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return error.name === 'SandboxUnavailableError' || code === 'SANDBOX_UNAVAILABLE'
}

function isPortCollision(stderr: string): boolean {
  return /EADDRINUSE|address already in use/i.test(stderr)
}

function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // Best effort: a leaked per-turn state dir must not fail the stop path.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortedText(callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): string {
  if (callerSignal?.aborted === true) return '技能脚本已取消'
  if (timeoutSignal.aborted) return `技能脚本超时（${String(SCRIPT_HARD_CAP_MS / 1000)} 秒）`
  return '技能脚本已取消'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}
