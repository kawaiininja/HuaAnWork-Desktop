/**
 * M1.0 feasibility probe: can the DSH sandbox confine a long-running Node
 * HTTP/MCP server process (an agent package runtime) inside a workspace while
 * it keeps serving on 127.0.0.1?
 *
 * The boot assembly mirrors
 * `deepseek-harness/packages/shell/bash-sandbox/tests/seatbelt.e2e.ts`: a real
 * `Context` with `LocalSandboxProvider`, the session projection registry that
 * `SandboxPolicyService` injects, the production `sandbox-policy` row config,
 * and `LocalSubprocessRuntime`. The bash executor is intentionally absent —
 * this probe consumes only `ctx.sandbox.confine()` and `dsh-bash-sandbox` is
 * not a direct dependency of this package.
 *
 * Observed facts (one JSON line on stdout, diagnostics on stderr):
 *   httpReady      the confined server answered GET /health with 200 "ok"
 *   writeDenied    a confined write outside the workspace failed and left no file
 *   readOutside    a confined read of a file outside the workspace succeeded
 *   networkOutside a confined TCP connection to a public address succeeded
 * The last two are isolation holes the caller must price in, so `true` means
 * "outside access was possible", not "the sandbox held".
 *
 * Exit codes:
 *   0  gate passed — every observed fact matched the expectation
 *   1  gate failed — a fact contradicted the expectation (the sandbox is weaker
 *      or stronger than assumed; read the JSON and stderr)
 *   2  usage or host mismatch — e.g. `--platform win32` on a macOS host; a
 *      Windows result must come from a real Windows machine
 *   3  BLOCKED — the confined runtime could not be booted, or an observation
 *      was inconclusive (see the BLOCKED lines on stderr)
 *
 * Usage: node scripts/agent-package-sandbox-probe.mjs --platform darwin
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const POLICY_MODE = 'workspace-write'
/** Public TCP target for the network observation — an IP, so DNS is not the variable. */
const NETWORK_TARGET = '1.1.1.1:443'
const SERVER_READY_TIMEOUT_MS = 15_000
const CHILD_TIMEOUT_MS = 20_000
const HEALTH_DEADLINE_MS = 10_000
const STOP_TIMEOUT_MS = 5_000

/** Generated into the temp workspace; verbatim from the task brief. */
const SERVER_SOURCE = [
  "import { createServer } from 'node:http'",
  'const server = createServer((req, res) => {',
  "  if (req.url === '/health') { res.writeHead(200).end('ok'); return }",
  '  res.writeHead(404).end()',
  '})',
  "server.listen(0, '127.0.0.1', () => console.log(`READY ${server.address().port}`))",
  '',
].join('\n')

/**
 * Generated into the temp workspace: the confined child for the three world
 * observations. Each mode prints one JSON line; a throwing mode exits non-zero
 * with the errno text (e.g. `EPERM`) on stderr.
 */
const CHILD_SOURCE = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  "import { connect } from 'node:net'",
  '',
  'const [mode, target] = process.argv.slice(2)',
  'const reply = (facts) => console.log(JSON.stringify(facts))',
  '',
  "if (mode === 'write') {",
  '  writeFileSync(target, "written-outside-the-workspace")',
  "  reply({ ok: true, target })",
  "} else if (mode === 'read') {",
  "  reply({ ok: true, content: readFileSync(target, 'utf8') })",
  "} else if (mode === 'net') {",
  "  const split = target.lastIndexOf(':')",
  '  const host = target.slice(0, split)',
  '  const port = Number(target.slice(split + 1))',
  '  const socket = connect({ host, port, timeout: 6000 })',
  '  let settled = false',
  '  const finish = (ok, error) => {',
  '    if (settled) return',
  '    settled = true',
  '    reply(error === undefined ? { ok, target } : { ok, target, error })',
  '    socket.destroy()',
  '  }',
  "  socket.on('connect', () => finish(true))",
  "  socket.on('timeout', () => finish(false, 'timeout'))",
  "  socket.on('error', (error) => finish(false, error.code ?? error.message))",
  '} else {',
  "  console.error('unknown probe mode: ' + mode)",
  '  process.exit(2)',
  '}',
  '',
].join('\n')

const log = (message) => process.stderr.write(`[sandbox-probe] ${message}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function usage(message) {
  log(message)
  log('usage: node scripts/agent-package-sandbox-probe.mjs --platform <darwin|win32>')
  process.exit(2)
}

function parsePlatform(argv) {
  const rest = argv.slice(2)
  let requested = process.platform
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--platform') usage(`unknown argument: ${rest[index]}`)
    const value = rest[index + 1]
    if (value === undefined) usage('--platform requires a value')
    requested = value
    index += 1
  }
  if (requested !== 'darwin' && requested !== 'win32') usage(`unsupported platform: ${requested}`)
  if (requested !== process.platform) {
    usage(`refusing to label a ${process.platform} run as ${requested}: the ${requested} probe must run on a real ${requested} machine`)
  }
  return requested
}

/**
 * Boot the sandbox seam exactly as the reference e2e does, minus the bash
 * executor the probe does not consume.
 * @param workspaceRoot - the workspace-write boundary for this run.
 * @returns the booted Cordis root context.
 */
async function bootSandbox(workspaceRoot) {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  // On darwin the runner chain is Seatbelt-only; pinning the Linux rungs off
  // keeps the reference-test assembly identical on hosts with a stray `bwrap`.
  ctx.sandbox.internals = { probeBwrap: () => false, probeLandlock: () => 'unusable' }
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: POLICY_MODE, workspaceRoot })
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

/** Child environment: Electron's execPath needs this flag to run as Node; plain Node ignores it. */
function childEnv() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
}

/**
 * Run one child to completion under the sandbox.
 * @param ctx - the booted context owning `ctx.sandbox`.
 * @param policy - the policy handed to `confine`.
 * @param args - argv after `process.execPath`.
 * @param options - working directory and deadline.
 * @returns the exit facts and captured streams.
 */
async function runConfined(ctx, policy, args, { cwd, timeoutMs = CHILD_TIMEOUT_MS }) {
  const wrapped = await ctx.sandbox.confine([process.execPath, ...args], policy)
  const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, spawnError: error, stdout, stderr })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, spawnError: null, stdout, stderr })
    })
  })
  return result
}

/**
 * Start the long-running confined server and resolve once it prints `READY <port>`.
 * @param ctx - the booted context owning `ctx.sandbox`.
 * @param policy - the policy handed to `confine`.
 * @param script - absolute path of the generated server script.
 * @param cwd - the workspace root the server runs in.
 * @returns the child handle, its port or startup error, captured streams, and
 *   the runner's enforcement level.
 */
async function startConfinedServer(ctx, policy, script, cwd) {
  const wrapped = await ctx.sandbox.confine([process.execPath, script], policy)
  const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `no READY line within ${SERVER_READY_TIMEOUT_MS}ms` }), SERVER_READY_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const match = /^READY (\d+)$/m.exec(stdout)
      if (match !== null) {
        clearTimeout(timer)
        resolve({ ok: true, port: Number(match[1]) })
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `spawn failed: ${error.message}` })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `server exited before READY (code=${code} signal=${signal})` })
    })
  })
  return {
    child,
    port: ready.ok ? ready.port : null,
    error: ready.ok ? null : ready.error,
    stdout: () => stdout,
    stderr: () => stderr,
    enforcement: wrapped.enforcement,
    argv: wrapped.argv,
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolve) => {
    child.once('close', resolve)
    child.once('exit', resolve)
  })
  child.kill('SIGKILL')
  await Promise.race([closed, sleep(STOP_TIMEOUT_MS)])
}

/** Poll GET /health until the deadline, so the listen callback and the request cannot race. */
async function checkHealth(port) {
  const deadline = Date.now() + HEALTH_DEADLINE_MS
  let lastError = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      const body = await response.text()
      if (response.status === 200 && body === 'ok') return { ok: true, status: response.status, body }
      lastError = `status=${response.status} body=${JSON.stringify(body)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  return { ok: false, error: lastError }
}

/** Parse the last JSON line a probe child printed. */
function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // Not this line: keep looking upward for the child's reply.
    }
  }
  return null
}

function denialEvidence(text) {
  return /(EPERM|operation not permitted|Sandbox:)/i.test(text)
}

async function main() {
  const platform = parsePlatform(process.argv)
  const facts = {
    platform,
    enforcement: null,
    httpReady: false,
    writeDenied: false,
    readOutside: false,
    networkOutside: false,
  }
  const blockers = []
  const contradictions = []

  let workspace
  let outside
  let ctx
  let server
  try {
    workspace = await mkdtemp(join(homedir(), '.huaanwork-sandbox-probe-ws-'))
    outside = await mkdtemp(join(homedir(), '.huaanwork-sandbox-probe-out-'))
    // Both dirs sit under $HOME on purpose: workspace-write grants /tmp and the
    // per-user temp dir wholesale, so only a path outside both proves the boundary.
    log(`workspace=${workspace}`)
    log(`outside=${outside}`)
    if (outside.startsWith(`${workspace}${sep}`)) blockers.push('outside dir nested in workspace')

    const serverScript = join(workspace, 'server.mjs')
    const childScript = join(workspace, 'probe-child.mjs')
    const secret = `outside-secret-${Date.now()}`
    const secretPath = join(outside, 'secret.txt')
    await writeFile(serverScript, SERVER_SOURCE)
    await writeFile(childScript, CHILD_SOURCE)
    await writeFile(secretPath, `${secret}\n`)

    ctx = await bootSandbox(workspace)
    const policy = ctx.sandboxPolicy.resolve({ mode: POLICY_MODE })
    log(`policy=${JSON.stringify(policy)}`)
    if (policy.mode !== POLICY_MODE || policy.workspaceRoot !== workspace) {
      throw new Error(`unexpected policy resolution: ${JSON.stringify(policy)}`)
    }

    // 1. The long-running server must start through `confine` and answer HTTP.
    server = await startConfinedServer(ctx, policy, serverScript, workspace)
    facts.enforcement = server.enforcement
    log(`server.runner=${server.argv[0]} enforcement=${server.enforcement}`)
    if (server.port === null) {
      blockers.push(`server-not-ready: ${server.error}`)
      if (server.stderr().trim().length > 0) log(`server.stderr=${server.stderr().trim()}`)
      await stopChild(server.child)
      server = undefined
    } else {
      log(`server.port=${server.port}`)
      const health = await checkHealth(server.port)
      facts.httpReady = health.ok
      log(`health=${JSON.stringify(health)}`)
      if (!health.ok) blockers.push(`health-not-ok: ${JSON.stringify(health)}`)
    }

    // 2. Control: a write INSIDE the workspace must land, or `writeDenied`
    // proves nothing.
    const insidePath = join(workspace, 'inside-write.txt')
    const inside = await runConfined(ctx, policy, [childScript, 'write', insidePath], { cwd: workspace })
    const insideLanded = existsSync(insidePath)
    log(`insideWrite.code=${inside.code} landed=${insideLanded}`)
    if (!insideLanded) {
      log(`insideWrite.stderr=${inside.stderr.trim()}`)
      blockers.push('workspace-write control failed: a write inside the workspace did not land')
    }

    // 3. Write outside the workspace must be denied and leave no file.
    const deniedPath = join(outside, 'denied.txt')
    const denied = await runConfined(ctx, policy, [childScript, 'write', deniedPath], { cwd: workspace })
    const deniedLanded = existsSync(deniedPath)
    facts.writeDenied = denied.code !== 0 && !deniedLanded
    log(`outsideWrite.code=${denied.code} landed=${deniedLanded} denialEvidence=${denialEvidence(denied.stderr)}`)
    if (denied.stderr.trim().length > 0) log(`outsideWrite.stderr=${denied.stderr.trim()}`)
    if (deniedLanded) contradictions.push('outside write landed: the workspace boundary does not hold')
    else if (denied.code === 0) contradictions.push('outside write exited 0 without landing: inconclusive')

    // 4. Read outside the workspace: expected to SUCCEED (Seatbelt allows
    // reads by default), which is the isolation hole this fact records.
    const read = await runConfined(ctx, policy, [childScript, 'read', secretPath], { cwd: workspace })
    const readReply = lastJsonLine(read.stdout)
    facts.readOutside = read.code === 0 && readReply?.ok === true && readReply.content.trim() === secret
    log(`outsideRead.code=${read.code} contentMatch=${readReply?.content?.trim() === secret} denialEvidence=${denialEvidence(read.stderr)}`)
    if (read.stderr.trim().length > 0) log(`outsideRead.stderr=${read.stderr.trim()}`)
    if (read.code !== 0 && denialEvidence(read.stderr)) {
      contradictions.push('outside read was denied: stricter than the assumed profile')
    } else if (!facts.readOutside) {
      contradictions.push(`outside read did not succeed (code=${read.code})`)
    }

    // 5. Network outside the workspace: expected to SUCCEED. A failure is only
    // attributable to the sandbox when an unconfined control reaches the same
    // target; otherwise the host itself has no route.
    const confinedNet = await runConfined(ctx, policy, [childScript, 'net', NETWORK_TARGET], { cwd: workspace })
    const confinedReply = lastJsonLine(confinedNet.stdout)
    facts.networkOutside = confinedNet.code === 0 && confinedReply?.ok === true
    log(`confinedNet.code=${confinedNet.code} reply=${JSON.stringify(confinedReply)} denialEvidence=${denialEvidence(confinedNet.stderr)}`)
    if (!facts.networkOutside) {
      const control = await runUnconfined([childScript, 'net', NETWORK_TARGET], workspace)
      const controlReply = lastJsonLine(control.stdout)
      log(`unconfinedNet.code=${control.code} reply=${JSON.stringify(controlReply)}`)
      if (control.code === 0 && controlReply?.ok === true) {
        contradictions.push(`network denied under the sandbox but reachable unconfined (${NETWORK_TARGET})`)
      } else {
        blockers.push(`network-inconclusive: neither the confined nor the unconfined control reached ${NETWORK_TARGET}`)
      }
    }

    // 6. Liveness after the sibling confined runs: the server must still serve.
    if (server !== undefined && facts.httpReady) {
      const after = await checkHealth(server.port)
      log(`healthAfterProbes=${after.ok}`)
    }
  } catch (error) {
    blockers.push(`probe-error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (server !== undefined) await stopChild(server.child)
    if (ctx !== undefined) await ctx.fiber.dispose()
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
    if (outside !== undefined) await rm(outside, { recursive: true, force: true })
  }

  for (const blocker of blockers) log(`BLOCKED: ${blocker}`)
  for (const contradiction of contradictions) log(`FAIL: ${contradiction}`)

  process.stdout.write(`${JSON.stringify(facts)}\n`)
  if (blockers.length > 0) {
    process.exitCode = 3
    log('verdict=BLOCKED')
    return
  }
  if (contradictions.length > 0) {
    process.exitCode = 1
    log('verdict=FAIL')
    return
  }
  if (!facts.httpReady || !facts.writeDenied || !facts.readOutside || !facts.networkOutside) {
    process.exitCode = 1
    log('verdict=FAIL (an expectation did not hold)')
    return
  }
  log('verdict=PASS')
}

/** Unconfined control run for the network observation. */
async function runUnconfined(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr, spawnError: error })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, spawnError: null })
    })
  })
}

await main()
