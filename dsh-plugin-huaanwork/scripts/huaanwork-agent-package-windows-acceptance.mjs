/**
 * Windows Step 5 acceptance for HuaAnWork agent packages.
 *
 * Hard failures (exit 1):
 *   - sandbox probe facts differ from enforcement=partial, writeDenied,
 *     readOutside, networkOutside, httpReady
 *   - the HTTP fixture is still up after host `afterIdle`
 *   - the MCP fixture is still up after host `afterIdle`
 *   - after `stopAllAgentPackageProcesses` (the plugin dispose hook) and the
 *     child host process exits, `Get-CimInstance Win32_Process` still shows
 *     `agents\<slug>\`, or the fixture port is still accepting
 *
 * Exit 3 is BLOCKED: the sandbox probe was inconclusive, or a server never
 * started. Exit 2 is usage, including `--platform win32` on any other OS.
 *
 * Force-killing a leftover is runner hygiene. Its result is recorded and does
 * not change the exit code.
 *
 * This does not open the GUI, interview a model, or render a confirm card.
 *
 * Usage:
 *   node scripts/huaanwork-agent-package-windows-acceptance.mjs --platform win32 [--out report.json]
 */

import { execFile, spawn } from 'node:child_process'
import { request } from 'node:http'
import { connect } from 'node:net'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, platform as osPlatform, release as osRelease } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decideWindowsAcceptance,
  findResidualProcesses,
  normalizeProcessQuery,
  parseCimProcessList,
  scoreHostExitQuery,
} from './huaanwork-agent-package-windows-acceptance-verdict.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('../tests/fixtures/agent-package', import.meta.url))
const ENTRY_PATH = fileURLToPath(import.meta.url)
const RESIDUAL_GRACE_MS = 3_000
const CHILD_TIMEOUT_MS = 90_000
const PROBE_TIMEOUT_MS = 180_000
const LOG = '[windows-acceptance]'

const log = (message) => process.stderr.write(`${LOG} ${message}\n`)

function usage(message) {
  log(message)
  log('usage: node scripts/huaanwork-agent-package-windows-acceptance.mjs --platform win32 [--out <file>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { platform: undefined, out: undefined, phase: undefined }
  const rest = argv.slice(2)
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--platform') {
      const value = rest[index + 1]
      if (value === undefined) usage('--platform requires a value')
      args.platform = value
      index += 1
    } else if (token === '--out') {
      const value = rest[index + 1]
      if (value === undefined) usage('--out requires a value')
      args.out = value
      index += 1
    } else if (token === '--phase') {
      const value = rest[index + 1]
      if (value !== 'host-exit') usage(`unknown phase: ${String(value)}`)
      args.phase = value
      index += 1
    } else {
      usage(`unknown argument: ${token}`)
    }
  }
  return args
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function capture(child, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, 'SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => finish(null, error.message))
    child.once('close', (code, signal) => finish(code, signal))
  })
}

function portOpen(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) {
      resolve(false)
      return
    }
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPortClosed(port) {
  const deadline = Date.now() + RESIDUAL_GRACE_MS
  let open = await portOpen(port)
  while (open && Date.now() < deadline) {
    await delay(250)
    open = await portOpen(port)
  }
  return !open
}

function getHealth(port) {
  return new Promise((resolve) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    req.setTimeout(2_000, () => {
      req.destroy()
      resolve({ status: 0, body: '' })
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end()
  })
}

function postJson(url, body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.setTimeout(5_000, () => req.destroy(new Error('MCP fixture request timed out')))
    req.on('error', reject)
    req.end(payload)
  })
}

function readPortFile(workspaceRoot, name) {
  const text = readFileSync(join(workspaceRoot, name), 'utf8').trim()
  const port = Number(text)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${name} did not contain a port`)
  return port
}

/**
 * Copy the checked-in agent-package fixture and retarget its slug and tool mode.
 * @param {'http' | 'mcp' | 'both'} mode
 */
function installPackage(profileDir, slug, mode) {
  const packageDir = join(profileDir, 'agents', slug)
  mkdirSync(join(profileDir, 'agents'), { recursive: true })
  cpSync(FIXTURE_DIR, packageDir, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(packageDir, 'agent.json'), 'utf8'))
  manifest.slug = slug
  if (mode === 'http') {
    manifest.tools = { mode: 'http', http: { entry: 'tools/http/server.mjs' } }
    rmSync(join(packageDir, 'tools', 'mcp'), { recursive: true, force: true })
  } else if (mode === 'mcp') {
    manifest.tools = { mode: 'mcp', mcp: { entry: 'tools/mcp/server.mjs' } }
    rmSync(join(packageDir, 'tools', 'http'), { recursive: true, force: true })
  } else {
    manifest.tools = {
      mode: 'both',
      http: { entry: 'tools/http/server.mjs' },
      mcp: { entry: 'tools/mcp/server.mjs' },
    }
  }
  writeFileSync(join(packageDir, 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const skillPath = join(packageDir, 'skill', 'SKILL.md')
  const skill = readFileSync(skillPath, 'utf8').replace(/^name:.*$/m, `name: ${slug}`)
  writeFileSync(skillPath, skill)
  writeFileSync(join(profileDir, 'agents-state.json'), `${JSON.stringify({
    [`local:${slug}`]: { source: 'local', enabled: true, installedVersion: manifest.version },
  })}\n`)
  return packageDir
}

async function bootSandbox(workspaceRoot) {
  const [{ Context }, { LocalSandboxProvider }, { SandboxPolicyService }, sessionModule, subprocessModule] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-sandbox-local'),
    import('@deepseek-ai/dsh-sandbox-policy'),
    import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/dsh-subprocess-local'),
  ])
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  ctx.sandbox.internals = { probeBwrap: () => false, probeLandlock: () => 'unusable' }
  await ctx.plugin(sessionModule.default)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot })
  await ctx.plugin(subprocessModule.default)
  return ctx
}

function queryWin32Processes() {
  const command = "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress -Depth 4"
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Get-CimInstance failed: ${error.message}\n${stderr}`))
        return
      }
      resolve(String(stdout))
    })
  })
}

async function residualsFor(slug) {
  const raw = await queryWin32Processes()
  const processes = parseCimProcessList(raw)
  return {
    scanned: processes.length,
    residuals: findResidualProcesses(processes, slug),
    command: 'Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine',
  }
}

async function waitForResidualsClear(slug) {
  const deadline = Date.now() + RESIDUAL_GRACE_MS
  let query = await residualsFor(slug)
  while ((query.residuals?.length ?? 0) > 0 && Date.now() < deadline) {
    await delay(500)
    query = await residualsFor(slug)
  }
  return query
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({
        pid,
        ok: error === null,
        error: error ? `${error.message} ${stderr}`.trim() : null,
        stdout: String(stdout ?? '').trim(),
      })
    })
  })
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // keep scanning; diagnostics must not hide the facts line
    }
  }
  return null
}

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-win-accept-'))
  const profileDir = join(root, 'profile')
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  return { root, profileDir, workspaceRoot }
}

function removeRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch (error) {
    log(`cleanup failed: ${errorText(error)}`)
  }
}

/**
 * MCP fixture handshake injected as `mcpClientImpl`.
 * `mountSessionMcp` then reads tool names from `tools.schemas()`.
 * The real MCP client plugin is not started: it needs the live tools service.
 */
function fixtureMcpClient(slug, seen) {
  return {
    inject: ['tools'],
    async apply(_ctx, config) {
      const url = new URL(config.url)
      const initialized = await postJson(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'windows-acceptance', version: '0' },
        },
      })
      if (initialized.result === undefined) {
        throw new Error(`MCP initialize failed: ${JSON.stringify(initialized)}`)
      }
      const listed = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      const tools = listed.result?.tools
      if (!Array.isArray(tools) || tools.length === 0) throw new Error('MCP fixture listed no tools')
      seen.tools = tools.map((tool) => tool.name).filter((name) => typeof name === 'string')
      return { async dispose() {} }
    },
    schemas() {
      return seen.tools.map((name) => ({ name: `mcp__${slug}__${name}` }))
    },
  }
}

async function runIdlePhase({ name, slug, mode }) {
  const dirs = makeDirs()
  let sandbox
  let started = false
  let port = null
  let dispatched
  let idleFinished = false
  const detail = { slug, mode, packageDir: null, port: null, health: null, mcpTools: [] }
  try {
    detail.packageDir = installPackage(dirs.profileDir, slug, mode)
    sandbox = await bootSandbox(dirs.workspaceRoot)
    const { createAgentPackageHost } = await import('../src/huaanwork-host/agent-package/host.ts')
    const host = createAgentPackageHost({ profileDir: dirs.profileDir, takenSlugs: () => [] })
    const pkg = await host.findInvocable(slug)
    if (pkg === undefined) throw new Error(`package ${slug} was not readable`)
    if (pkg.broken !== undefined) throw new Error(`package ${slug} is broken: ${pkg.broken.reason}`)
    if (pkg.enabled !== true) throw new Error(`package ${slug} is not enabled`)

    const seen = { tools: [] }
    const mcp = mode === 'mcp' ? fixtureMcpClient(slug, seen) : undefined
    dispatched = await host.dispatch({
      ctx: {
        get(serviceName) {
          if (serviceName === 'sandbox') return sandbox.sandbox
          if (serviceName === 'mcpClientImpl') return mcp
          if (serviceName === 'tools' && mcp !== undefined) return mcp
          return undefined
        },
        ...(mcp === undefined ? {} : { tools: mcp }),
        huaanworkWorkspaceRoot: { current: dirs.workspaceRoot },
        subagents: {
          async startActivation() {
            return {
              childId: 'windows-acceptance-child',
              result: Promise.resolve({}),
              async dispose() {},
            }
          },
        },
      },
      sessionId: 'windows-acceptance',
      pkg,
      remainder: 'probe',
      resolveParent: async () => ({ id: 'windows-acceptance-parent' }),
    })
    started = true
    port = readPortFile(dirs.workspaceRoot, mode === 'mcp' ? 'mcp-port.txt' : 'http-port.txt')
    detail.port = port
    if (mode === 'http') {
      detail.health = await getHealth(port)
      if (detail.health.status !== 200 || detail.health.body !== 'ok') {
        throw new Error(`HTTP fixture health was ${JSON.stringify(detail.health)}`)
      }
    } else {
      detail.mcpTools = [...seen.tools]
      if (seen.tools.length === 0) throw new Error('MCP fixture handshake did not record a tool')
    }
    if (!(await portOpen(port))) throw new Error(`${mode} port ${String(port)} was not accepting before afterIdle`)

    await dispatched.afterIdle()
    idleFinished = true
    const portClosed = await waitForPortClosed(port)
    const query = await waitForResidualsClear(slug)
    return {
      phase: {
        name,
        started: true,
        stopped: portClosed && (query.residuals?.length ?? 0) === 0,
        residuals: query.residuals ?? [],
        ...(portClosed ? {} : { error: `port ${String(port)} still open` }),
      },
      detail: { ...detail, portClosed, processQuery: normalizeProcessQuery(query) },
    }
  } catch (error) {
    if (dispatched !== undefined && !idleFinished) {
      try {
        await dispatched.afterIdle()
      } catch (stopError) {
        log(`afterIdle during failure cleanup failed: ${errorText(stopError)}`)
      }
    }
    let residuals = []
    let processQuery = null
    try {
      const query = await residualsFor(slug)
      residuals = query.residuals ?? []
      processQuery = normalizeProcessQuery(query)
    } catch (queryError) {
      processQuery = { error: errorText(queryError) }
    }
    const portClosed = port === null ? residuals.length === 0 : await waitForPortClosed(port)
    const leaked = residuals.length > 0 || (started && !portClosed)
    if (!leaked && (!started || !idleFinished || processQuery?.error)) {
      return {
        phase: {
          name,
          started: false,
          stopped: false,
          residuals: [],
          error: processQuery?.error ?? errorText(error),
        },
        detail: { ...detail, processQuery },
      }
    }
    return {
      phase: {
        name,
        started: true,
        stopped: !leaked && idleFinished,
        residuals,
        error: errorText(error),
      },
      detail: { ...detail, processQuery },
    }
  } finally {
    if (sandbox !== undefined) {
      try {
        await sandbox.fiber.dispose()
      } catch (error) {
        log(`sandbox dispose failed: ${errorText(error)}`)
      }
    }
    removeRoot(dirs.root)
  }
}

async function runSandboxProbe() {
  const script = fileURLToPath(new URL('./huaanwork-agent-package-sandbox-probe.mjs', import.meta.url))
  log('starting sandbox probe')
  const child = spawn(process.execPath, [script, '--platform', 'win32'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await capture(child, PROBE_TIMEOUT_MS)
  const facts = lastJsonLine(result.stdout)
  log(`sandbox probe exit=${String(result.code)}`)
  return {
    exitCode: result.code ?? 1,
    facts,
    stderrTail: result.stderr.slice(-8_000),
    timedOut: result.signal === 'SIGKILL',
  }
}

async function runHostExitPhase() {
  const slug = 'win-exit-probe'
  const dirs = makeDirs()
  installPackage(dirs.profileDir, slug, 'both')
  log(`host-exit child slug=${slug}`)
  const child = spawn(process.execPath, [ENTRY_PATH, '--phase', 'host-exit'], {
    env: {
      ...process.env,
      HUAANWORK_ACCEPT_PROFILE: dirs.profileDir,
      HUAANWORK_ACCEPT_WORKSPACE: dirs.workspaceRoot,
      HUAANWORK_ACCEPT_SLUG: slug,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await capture(child, CHILD_TIMEOUT_MS)
  const events = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith('{'))
  const parsed = events.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter((event) => event !== null)
  const ready = parsed.find((event) => event.event === 'ready')
  let query = normalizeProcessQuery({ command: 'Get-CimInstance Win32_Process', scanned: 0, residuals: [] })
  try {
    query = normalizeProcessQuery(await waitForResidualsClear(slug))
  } catch (error) {
    query = normalizeProcessQuery({ ...query, error: errorText(error) })
  }
  const httpClosed = ready ? await waitForPortClosed(ready.httpPort) : true
  const mcpClosed = ready ? await waitForPortClosed(ready.mcpPort) : true
  const scored = scoreHostExitQuery(query)
  const dirty = scored.dirty || !httpClosed || !mcpClosed
  const childOk = result.code === 0 && ready !== undefined && result.signal !== 'SIGKILL'
  removeRoot(dirs.root)
  if (query.error && !dirty) {
    return {
      phase: {
        name: 'hostExit',
        started: false,
        stopped: false,
        residuals: [],
        error: query.error,
      },
      detail: {
        slug,
        childExitCode: result.code,
        stderrTail: result.stderr.slice(-4_000),
        events: parsed,
        processQuery: query,
        portsClosed: { http: httpClosed, mcp: mcpClosed },
        note: 'Get-CimInstance did not return a process list, so the residual check is inconclusive.',
      },
    }
  }
  if (!childOk && !dirty) {
    return {
      phase: {
        name: 'hostExit',
        started: false,
        stopped: false,
        residuals: [],
        error: `host-exit child exit ${String(result.code)} signal ${String(result.signal)}`,
      },
      detail: {
        slug,
        childExitCode: result.code,
        stderrTail: result.stderr.slice(-4_000),
        events: parsed,
        processQuery: query,
        portsClosed: { http: httpClosed, mcp: mcpClosed },
        note: 'The child calls stopAllAgentPackageProcesses, the same function the plugin disposer starts on unload, then exits. This is not an Electron GUI quit.',
      },
    }
  }
  return {
    phase: {
      name: 'hostExit',
      started: true,
      stopped: childOk && !dirty,
      residuals: scored.residuals,
      ...(!dirty && childOk ? {} : { error: `exit ${String(result.code)}; httpClosed=${String(httpClosed)}; mcpClosed=${String(mcpClosed)}` }),
    },
    detail: {
      slug,
      childExitCode: result.code,
      stderrTail: result.stderr.slice(-4_000),
      events: parsed,
      processQuery: query,
      portsClosed: { http: httpClosed, mcp: mcpClosed },
      note: 'The child calls stopAllAgentPackageProcesses, the same function the plugin disposer starts on unload, then exits. This is not an Electron GUI quit. The product disposer does not await that call; this probe waits so the stop can finish before the process query.',
    },
  }
}

async function runHostExitChild() {
  const profileDir = process.env.HUAANWORK_ACCEPT_PROFILE
  const workspaceRoot = process.env.HUAANWORK_ACCEPT_WORKSPACE
  const slug = process.env.HUAANWORK_ACCEPT_SLUG
  if (!profileDir || !workspaceRoot || !slug) {
    process.stdout.write(`${JSON.stringify({ event: 'error', message: 'host-exit child is missing profile paths' })}\n`)
    process.exit(1)
  }
  let sandbox
  try {
    sandbox = await bootSandbox(workspaceRoot)
    const seen = { tools: [] }
    const mcp = fixtureMcpClient(slug, seen)
    const { startAgentPackageProcesses, stopAllAgentPackageProcesses } = await import('../src/huaanwork-host/agent-package/runtime.ts')
    const manifest = JSON.parse(readFileSync(join(profileDir, 'agents', slug, 'agent.json'), 'utf8'))
    await startAgentPackageProcesses({
      manifest,
      packageDir: join(profileDir, 'agents', slug),
      workspaceRoot,
      getSandbox: () => sandbox.sandbox,
      mountMcp: async (port) => {
        await mcp.apply(null, { url: `http://127.0.0.1:${String(port)}/mcp` })
        if (seen.tools.length === 0) throw new Error('MCP fixture listed no tools')
        return seen.tools
      },
    })
    const httpPort = readPortFile(workspaceRoot, 'http-port.txt')
    const mcpPort = readPortFile(workspaceRoot, 'mcp-port.txt')
    process.stdout.write(`${JSON.stringify({ event: 'ready', httpPort, mcpPort, mcpTools: seen.tools })}\n`)
    await stopAllAgentPackageProcesses()
    process.stdout.write(`${JSON.stringify({ event: 'stopped' })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ event: 'error', message: errorText(error) })}\n`)
    process.exitCode = 1
  } finally {
    if (sandbox !== undefined) {
      try {
        await sandbox.fiber.dispose()
      } catch (error) {
        log(`child sandbox dispose failed: ${errorText(error)}`)
      }
    }
  }
  process.exit(process.exitCode ?? 0)
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return execFileSyncGit()
  } catch {
    return null
  }
}

function execFileSyncGit() {
  // Imported lazily so a missing git binary cannot break argument parsing.
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function writeSummary(verdict, exitCode) {
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (!summary) return
  writeFileSync(summary, `Windows agent-package acceptance: ${verdict} (exit ${String(exitCode)})\n`, { flag: 'a' })
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.phase === 'host-exit') {
    if (process.platform !== 'win32') usage('host-exit must run on a real win32 machine')
    await runHostExitChild()
    return
  }
  if (args.platform === undefined) usage('missing --platform win32')
  if (args.platform !== 'win32') usage(`acceptance probe only runs on win32; refusing --platform ${args.platform}`)
  if (process.platform !== 'win32') {
    usage(`refusing to label a ${process.platform} run as win32: the win32 probe must run on a real win32 machine`)
  }

  const report = {
    kind: 'huaanwork-agent-package-windows-acceptance',
    platform: 'win32',
    commit: gitSha(),
    runner: {
      os: process.env.RUNNER_OS ?? osPlatform(),
      osRelease: osRelease(),
      name: process.env.RUNNER_NAME ?? null,
      arch: process.arch,
    },
    scope: {
      gui: false,
      realModel: false,
      note: 'Chat interview, confirm card, and @slug with a real model are not part of this probe.',
    },
    sandboxProbe: null,
    phases: [],
    details: {},
    forceKill: { countsAsHardFail: false, attempted: false, results: [] },
  }
  const phases = []
  let sandboxExitCode = 3
  let sandboxFacts = null
  try {
    const sandbox = await runSandboxProbe()
    sandboxExitCode = sandbox.timedOut ? 3 : sandbox.exitCode
    sandboxFacts = sandbox.facts
    report.sandboxProbe = sandbox
    const http = await runIdlePhase({ name: 'httpAfterIdle', slug: 'win-http-probe', mode: 'http' })
    phases.push(http.phase)
    report.details.httpAfterIdle = http.detail
    const mcp = await runIdlePhase({ name: 'mcpAfterIdle', slug: 'win-mcp-probe', mode: 'mcp' })
    phases.push(mcp.phase)
    report.details.mcpAfterIdle = {
      ...mcp.detail,
      handshake: 'fixture-jsonrpc',
      note: 'afterIdle is createAgentPackageHost().dispatch().afterIdle(). The MCP fixture is mounted through an injected client that performs initialize and tools/list. The packaged MCP client is not started.',
    }
    const hostExit = await runHostExitPhase()
    phases.push(hostExit.phase)
    report.details.hostExit = hostExit.detail
  } catch (error) {
    report.fatal = errorText(error)
    log(`fatal: ${report.fatal}`)
  }
  for (const name of ['httpAfterIdle', 'mcpAfterIdle', 'hostExit']) {
    if (!phases.some((phase) => phase.name === name)) {
      phases.push({
        name,
        started: false,
        stopped: false,
        residuals: [],
        error: report.fatal ?? 'phase did not run',
      })
    }
  }
  report.phases = phases

  const leftoverPids = [...new Set(phases.flatMap((phase) => (phase.residuals ?? []).map((row) => row.processId)).filter((pid) => Number.isInteger(pid)))]
  if (leftoverPids.length > 0) {
    report.forceKill.attempted = true
    report.forceKill.results = await Promise.all(leftoverPids.map((pid) => taskkill(pid)))
  }
  const decision = decideWindowsAcceptance({
    sandboxExitCode,
    sandboxFacts,
    phases,
    forceKillErrors: report.forceKill.results.filter((result) => !result.ok).map((result) => result.error ?? `taskkill ${String(result.pid)} failed`),
  })
  report.decision = decision
  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`)
  writeSummary(decision.verdict, report.fatal && decision.exitCode === 0 ? 1 : decision.exitCode)
  const exitCode = report.fatal && decision.exitCode === 0 ? 1 : decision.exitCode
  process.stdout.write(`${JSON.stringify(report)}\n`, () => {
    process.exit(exitCode)
  })
}

await main()
