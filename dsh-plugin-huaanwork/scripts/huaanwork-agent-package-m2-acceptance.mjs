#!/usr/bin/env node
/**
 * Cross-profile end-to-end acceptance probe for M2 signed agent packages.
 *
 * What it does, in one process, against throwaway temporary directories:
 *
 *   1. boots the REAL `agent-catalog-server` in-process on an ephemeral
 *      loopback port (real HTTP, real state/audit files),
 *   2. generates an EPHEMERAL Ed25519 test keypair (never committed; the
 *      private key only ever lives in the temp root),
 *   3. builds a local package fixture in a creator profile, publishes it,
 *   4. runs the REAL offline admin CLI as a child process: review + approve
 *      (independent digest, detached signature),
 *   5. installs the signed package into a SECOND profile, verifies the
 *      signature on disk, enables it, and runs a REAL HTTP fixture dispatch
 *      through `createAgentPackageHost` (a real child process, a real
 *      `GET /health` and a real `POST /invoke`),
 *   6. publishes 1.0.1, reviews/approves it, updates the consumer profile and
 *      proves `enabled` survives,
 *   7. delists 1.0.1, refreshes the installed card metadata
 *      (`publishStatus: 'delisted'`) and proves the installed copy still runs,
 *   8. starts a long turn whose activation never settles, revokes 1.0.1,
 *      refreshes the revocation list, and proves the activation was disposed,
 *      the HTTP child stopped and the revoked version cannot be enabled or
 *      dispatched again,
 *   9. scans for residual processes whose command line still references the
 *      temp root and requires zero.
 *
 * Exit codes: 0 PASS, 1 FAIL (a field is false or an assertion failed),
 * 3 BLOCKED (the probe could not start: server/fixture/infrastructure),
 * 2 usage. A blocked or failed step NEVER prints PASS.
 *
 * The `--platform` value must equal `process.platform`: a darwin run can never
 * be labelled win32 (and vice versa). See docs/huaanwork-agent-packages-m2.md
 * for the runbook and docs/evidence/2026-10-24-agent-package-m2-*-acceptance.md
 * for the recorded runs.
 *
 * Usage:
 *   node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
 *     --platform darwin --out /tmp/agent-package-m2-darwin.json
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import {
  arch as osArch,
  hostname,
  platform as osPlatform,
  release as osRelease,
  tmpdir,
} from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyAgentPackageDirectory } from '@huaanwork/agent-package-format/digest'
import { fingerprintPublicKeyHex, generateKeyPair } from '@huaanwork/catalog-signing'

import { loadAgentCatalogConfig } from '../../agent-catalog-server/src/config.ts'
import {
  createAgentCatalogRuntime,
  createAgentCatalogServer,
} from '../../agent-catalog-server/src/server.ts'
import {
  configureAgentCatalog,
  resetAgentCatalogForTests,
} from '../src/huaanwork-host/agent-package/catalog-client.ts'
import {
  installCatalogAgentPackage,
  refreshInstalledCatalogPackageStatuses,
  updateCatalogAgentPackage,
} from '../src/huaanwork-host/agent-package/catalog-install.ts'
import {
  publishLocalAgentPackage,
  refreshLocalAgentPackagePublishStatus,
  requestLocalAgentPackageDelist,
  resetLocalAgentPackagePublication,
} from '../src/huaanwork-host/agent-package/catalog-publish.ts'
import { createAgentCatalogSecurity } from '../src/huaanwork-host/agent-package/catalog-security.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
} from '../src/huaanwork-host/agent-package/host.ts'
import { stopAllAgentPackageProcesses } from '../src/huaanwork-host/agent-package/runtime.ts'
import {
  agentPackageDir,
  readAgentPackageState,
  writeAgentPackageState,
} from '../src/huaanwork-host/agent-package/store.ts'

const LOG = '[agent-package-m2]'
const FIXTURE_DIR = fileURLToPath(new URL('../tests/fixtures/agent-package', import.meta.url))
const FIXTURE_HTTP_ENTRY = join(FIXTURE_DIR, 'tools', 'http', 'server.mjs')
const CLI_PATH = fileURLToPath(new URL('../../agent-catalog-admin/src/cli.ts', import.meta.url))
const SLUG = 'm2-acceptance-agent'
const FIRST_VERSION = '1.0.0'
const SECOND_VERSION = '1.0.1'
const SESSION_PREFIX = 'm2-acceptance'
const RESIDUAL_GRACE_MS = 5_000
const CLI_TIMEOUT_MS = 90_000

/**
 * Obvious throwaway test tokens (>= 32 chars, pairwise distinct). They are
 * generated per run so a committed string can never be mistaken for a secret.
 */
function makeTokens() {
  const nonce = randomUUID().replaceAll('-', '')
  return {
    read: `m2-probe-read-${nonce}-000000000000`,
    publish: `m2-probe-publish-${nonce}-00000000`,
    admin: `m2-probe-admin-${nonce}-000000000000`,
  }
}

const log = (message) => process.stderr.write(`${LOG} ${message}\n`)

function usage(message) {
  log(message)
  log('usage: node scripts/huaanwork-agent-package-m2-acceptance.mjs --platform <darwin|win32> [--out <file>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { platform: undefined, out: undefined }
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
    } else {
      usage(`unknown argument: ${token}`)
    }
  }
  return args
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    const { execFileSync } = process.getBuiltinModule('node:child_process')
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function capture(child, timeoutMs) {
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

// ---------------------------------------------------------------------------
// Real HTTP helpers (server + fixture)
// ---------------------------------------------------------------------------

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
    await delay(200)
    open = await portOpen(port)
  }
  return !open
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  return { status: response.status, body: await response.text() }
}

function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function readPortFile(workspaceRoot, name) {
  const text = readFileSync(join(workspaceRoot, name), 'utf8').trim()
  const port = Number(text)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${name} did not contain a port`)
  return port
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function manifestFor(version) {
  return {
    schemaVersion: 1,
    slug: SLUG,
    displayName: 'M2 验收助手',
    description: 'M2 双 Profile 验收用的签名智能体包',
    version,
    draftId: '00000000-0000-4000-8000-0000000000a2',
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    persona: 'persona.md',
    skill: { entry: 'skill/SKILL.md', summary: '验收回显' },
    tools: { mode: 'http', http: { entry: 'tools/http/server.mjs' } },
    allowSkills: [],
  }
}

function writePackageFiles(packageDir, version, persona) {
  mkdirSync(join(packageDir, 'skill'), { recursive: true })
  mkdirSync(join(packageDir, 'tools', 'http'), { recursive: true })
  writeFileSync(join(packageDir, 'agent.json'), `${JSON.stringify(manifestFor(version), null, 2)}\n`, 'utf8')
  writeFileSync(join(packageDir, 'persona.md'), `${persona}\n`, 'utf8')
  writeFileSync(
    join(packageDir, 'skill', 'SKILL.md'),
    `---\nname: ${SLUG}\ndescription: 验收回显\n---\n\n先调用 HTTP 工具回显参数,再总结。\n`,
    'utf8',
  )
  cpSync(FIXTURE_HTTP_ENTRY, join(packageDir, 'tools', 'http', 'server.mjs'))
}

/**
 * Write a local package the way an M1 commit leaves it on disk, and record the
 * matching `local:<slug>` state. The probe does not run a model interview; it
 * starts from the same on-disk shape the chat flow produces.
 */
function writeLocalPackage(profileDir, version, persona) {
  const packageDir = agentPackageDir(profileDir, SLUG)
  writePackageFiles(packageDir, version, persona)
  const state = readAgentPackageState(profileDir)
  state[`local:${SLUG}`] = {
    source: 'local',
    enabled: true,
    installedVersion: version,
    publishStatus: 'none',
  }
  writeAgentPackageState(profileDir, state)
}

function installKeyring(profileDir, publicKeyHex, keyId) {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'agent-catalog-keyring.json'),
    `${JSON.stringify({ schemaVersion: 1, keys: [{ keyId, publicKeyHex, slot: 1 }] }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

// ---------------------------------------------------------------------------
// Offline admin CLI (real child process)
// ---------------------------------------------------------------------------

function runCli(args, env) {
  const childEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AGENT_CATALOG_')) continue
    childEnv[key] = value
  }
  Object.assign(childEnv, env)
  const child = spawn(process.execPath, ['--experimental-strip-types', CLI_PATH, ...args], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return capture(child, CLI_TIMEOUT_MS).then((result) => ({
    args,
    exitCode: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  }))
}

function requireCliOk(invocation, secrets) {
  if (invocation.exitCode !== 0) {
    throw new Error(
      `CLI ${invocation.args[0]} exited ${String(invocation.exitCode)}: ` +
        `${invocation.stderr.trim() || invocation.stdout.trim()}`,
    )
  }
  for (const secret of secrets) {
    if (secret.length < 16) continue
    if (invocation.stdout.includes(secret) || invocation.stderr.includes(secret)) {
      throw new Error(`CLI ${invocation.args[0]} printed a secret`)
    }
  }
  return {
    command: `agent-catalog-admin ${invocation.args[0]}`,
    exitCode: invocation.exitCode,
  }
}

// ---------------------------------------------------------------------------
// Process scan
// ---------------------------------------------------------------------------

function listProcesses() {
  if (process.platform === 'win32') {
    const command =
      "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | " +
      'Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress -Depth 4'
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
        resolve(parseWindowsProcessList(String(stdout)))
      })
    })
  }
  return new Promise((resolve, reject) => {
    execFile('ps', ['-ax', '-o', 'pid=,command='], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`ps failed: ${error.message}`))
        return
      }
      resolve(
        String(stdout)
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const match = /^(\d+)\s+(.*)$/u.exec(line)
            return match === null ? null : { pid: Number(match[1]), command: match[2] }
          })
          .filter((entry) => entry !== null),
      )
    })
  })
}

function parseWindowsProcessList(raw) {
  const text = raw.trim()
  if (text === '') return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Get-CimInstance did not return JSON')
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .map((row) => ({
      pid: Number(row?.ProcessId),
      command: `${String(row?.Name ?? '')} ${String(row?.CommandLine ?? '')}`.trim(),
    }))
    .filter((row) => Number.isInteger(row.pid))
}

async function residualProcessesFor(root) {
  const processes = await listProcesses()
  const matches = processes.filter(
    (entry) => entry.command.includes(root) && !entry.command.includes('huaanwork-agent-package-m2-acceptance.mjs'),
  )
  return {
    scanned: processes.length,
    matches: matches.map((entry) => ({ pid: entry.pid, command: entry.command })),
  }
}

async function waitForResidualsClear(root) {
  const deadline = Date.now() + RESIDUAL_GRACE_MS
  let scan = await residualProcessesFor(root)
  while (scan.matches.length > 0 && Date.now() < deadline) {
    await delay(250)
    scan = await residualProcessesFor(root)
  }
  return scan
}

// ---------------------------------------------------------------------------
// Dispatch through the real host with a controllable activation
// ---------------------------------------------------------------------------

function createActivationRecorder() {
  const record = {
    calls: 0,
    childId: undefined,
    disposed: false,
    resultSettled: false,
    settle: undefined,
  }
  const result = new Promise((resolve) => {
    record.settle = () => {
      record.resultSettled = true
      resolve({})
    }
  })
  return {
    record,
    async startActivation(spec) {
      record.calls += 1
      record.childId = spec.childId ?? `${SESSION_PREFIX}-child-${String(record.calls)}`
      return {
        childId: record.childId,
        result,
        async dispose() {
          record.disposed = true
        },
      }
    },
  }
}

async function dispatchHttpTurn({ host, workspaceRoot, sessionId, activation }) {
  const pkg = await host.findInvocable(SLUG)
  if (pkg === undefined) throw new Error(`package ${SLUG} was not readable`)
  if (pkg.broken !== undefined) throw new Error(`package ${SLUG} is broken: ${pkg.broken.reason}`)
  if (pkg.enabled !== true) throw new Error(`package ${SLUG} is not enabled`)

  const requestContainer = { current: null }
  const childSessions = new Set()
  // `huaanworkAttachments` is deliberately absent: this probe runs no tool
  // attachment table, and the host's attachment/restrict paths are optional.
  const ctx = {
    get(serviceName) {
      if (serviceName === 'sandbox') return passthroughSandbox
      return undefined
    },
    huaanworkWorkspaceRoot: { current: workspaceRoot },
    huaanworkAgentPackageRequest: requestContainer,
    huaanworkPackageChildSessions: childSessions,
    subagents: { startActivation: activation.startActivation },
  }
  const dispatched = await host.dispatch({
    ctx,
    sessionId,
    pkg,
    remainder: '回显验收参数',
    resolveParent: async () => ({ id: `${SESSION_PREFIX}-parent` }),
  })
  const runtime = requestContainer.current?.runtime
  const httpPort = runtime?.httpPort ?? readPortFile(workspaceRoot, 'http-port.txt')
  const health = await fetchText(`http://127.0.0.1:${String(httpPort)}/health`)
  const invoke = await postJson(`http://127.0.0.1:${String(httpPort)}/invoke`, {
    arguments: { task: 'm2-acceptance', version: pkg.version },
  })
  return { dispatched, pkg, httpPort, health, invoke, childSessions }
}

/** The M2 probe checks signed-package lifecycle; sandbox enforcement is M1's probe. */
const passthroughSandbox = {
  async confine(argv) {
    return { argv, enforcement: 'full' }
  },
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-m2-accept-'))
  const dirs = {
    root,
    entries: join(root, 'entries'),
    data: join(root, 'data'),
    workspace: join(root, 'workspace'),
    creatorProfile: join(root, 'creator-profile'),
    consumerProfile: join(root, 'consumer-profile'),
    thirdProfile: join(root, 'third-profile'),
    reviewA: join(root, 'review-1.0.0'),
    reviewB: join(root, 'review-1.0.1'),
    keyring: join(root, 'keyring.json'),
    privateKey: join(root, 'signing-key.pem'),
  }
  for (const value of [dirs.entries, dirs.data, dirs.workspace, dirs.creatorProfile, dirs.consumerProfile, dirs.thirdProfile]) {
    mkdirSync(value, { recursive: true })
  }
  return dirs
}

async function bootCatalog(dirs, tokens, keyring) {
  const config = {
    ...loadAgentCatalogConfig({
      HOST: '127.0.0.1',
      PORT: '18080',
      AGENT_CATALOG_ENTRIES_DIR: dirs.entries,
      AGENT_CATALOG_DATA_DIR: dirs.data,
      AGENT_CATALOG_TOKEN: tokens.read,
      AGENT_CATALOG_PUBLISH_TOKEN: tokens.publish,
      AGENT_CATALOG_ADMIN_TOKEN: tokens.admin,
      AGENT_CATALOG_KEYRING_PATH: dirs.keyring,
    }),
    port: 0,
  }
  if (config.keyring.length !== 1 || config.keyring[0].keyId !== keyring.keyId) {
    throw new Error('the server parsed an unexpected keyring')
  }
  const runtime = await createAgentCatalogRuntime(config)
  const server = createAgentCatalogServer(config, runtime)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('catalog server has no port')
  return {
    server,
    runtime,
    config,
    port: address.port,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function configureCreator(profileDir, port, tokens) {
  return configureAgentCatalog({
    profileDir,
    readSettings: () => ({
      agents_host: '127.0.0.1',
      agents_port: port,
      agents_catalog_token: tokens.read,
      agents_catalog_publish_token: tokens.publish,
    }),
    logger: (message) => log(`creator: ${message}`),
  })
}

function configureConsumer(profileDir, port, tokens) {
  return configureAgentCatalog({
    profileDir,
    readSettings: () => ({
      agents_host: '127.0.0.1',
      agents_port: port,
      agents_catalog_token: tokens.read,
      agents_catalog_publish_token: '',
    }),
    logger: (message) => log(`consumer: ${message}`),
  })
}

function adminEnv(baseUrl, tokens) {
  return {
    AGENT_CATALOG_URL: baseUrl,
    AGENT_CATALOG_ADMIN_TOKEN: tokens.admin,
    AGENT_CATALOG_TOKEN: tokens.read,
    AGENT_CATALOG_PUBLISH_TOKEN: tokens.publish,
  }
}

async function runProbe({ dirs, catalog, tokens, keyring, fields, steps, negatives, privateKeyPem }) {
  const secrets = [tokens.read, tokens.publish, tokens.admin, privateKeyPem]
  const stateFor = (profileDir) => readAgentPackageState(profileDir)

  // 1. Local fixture -> publish (real upload to the real server).
  writeLocalPackage(dirs.creatorProfile, FIRST_VERSION, '你是 M2 验收助手的第一版。')
  installKeyring(dirs.consumerProfile, keyring.publicKeyHex, keyring.keyId)
  installKeyring(dirs.thirdProfile, keyring.publicKeyHex, keyring.keyId)
  configureCreator(dirs.creatorProfile, catalog.port, tokens)
  const firstSubmission = await publishLocalAgentPackage(SLUG)
  const creatorAfterSubmit = stateFor(dirs.creatorProfile)[`local:${SLUG}`]
  if (creatorAfterSubmit?.publishStatus !== 'pending-review') {
    throw new Error(`publish did not record pending-review: ${JSON.stringify(creatorAfterSubmit)}`)
  }
  if (creatorAfterSubmit.submissionId !== firstSubmission.submissionId) {
    throw new Error('publish did not record the returned submission id')
  }
  fields.submitted = true
  steps.submitted = {
    submissionId: firstSubmission.submissionId,
    slug: SLUG,
    version: FIRST_VERSION,
    publishStatus: creatorAfterSubmit.publishStatus,
    catalogList: (await fetchJson(`${catalog.baseUrl}/v1/agent-packages`, {
      headers: { authorization: `Bearer ${tokens.read}` },
    })).body,
  }

  // 2. Review + sign with the REAL offline CLI.
  const pending = await runCli(['pending'], adminEnv(catalog.baseUrl, tokens))
  const pendingStep = requireCliOk(pending, secrets)
  if (!pending.stdout.includes(firstSubmission.submissionId)) {
    throw new Error('pending did not list the new submission')
  }
  const reviewA = await runCli(
    ['review', firstSubmission.submissionId, '--out', dirs.reviewA],
    adminEnv(catalog.baseUrl, tokens),
  )
  const reviewAStep = requireCliOk(reviewA, secrets)
  const approveA = await runCli(
    [
      'approve',
      firstSubmission.submissionId,
      '--review',
      join(dirs.reviewA, 'review.json'),
      '--private-key',
      dirs.privateKey,
      '--slot',
      '1',
      '--yes',
    ],
    adminEnv(catalog.baseUrl, tokens),
  )
  const approveAStep = requireCliOk(approveA, secrets)
  if (!approveA.stdout.includes(keyring.keyId)) {
    throw new Error('approve did not print the signing keyId')
  }
  const publishedA = await fetchJson(`${catalog.baseUrl}/v1/agent-packages/${SLUG}/${FIRST_VERSION}`, {
    headers: { authorization: `Bearer ${tokens.read}` },
  })
  if (publishedA.status !== 200 || publishedA.body?.status !== 'published') {
    throw new Error(`1.0.0 was not published: ${JSON.stringify(publishedA)}`)
  }
  // The creator's own publication status now reflects the approval.
  configureCreator(dirs.creatorProfile, catalog.port, tokens)
  const creatorPublication = await refreshLocalAgentPackagePublishStatus(SLUG)
  if (creatorPublication.publishStatus !== 'published') {
    throw new Error(`creator publication was ${creatorPublication.publishStatus}`)
  }
  fields.reviewedAndSigned = true
  steps.reviewedAndSigned = {
    cli: [pendingStep, reviewAStep, approveAStep],
    publishedStatus: publishedA.body.status,
    signedKeyId: keyring.keyId,
    receipt: join(dirs.reviewA, 'review.json'),
    creatorPublishStatus: creatorPublication.publishStatus,
  }

  // 3. Install into the second profile.
  configureConsumer(dirs.consumerProfile, catalog.port, tokens)
  const installed = await installCatalogAgentPackage(SLUG, FIRST_VERSION)
  const consumerEntry = stateFor(dirs.consumerProfile)[`catalog:${SLUG}`]
  if (installed.manifest.version !== FIRST_VERSION) {
    throw new Error(`install returned version ${installed.manifest.version}`)
  }
  if (consumerEntry?.source !== 'catalog' || consumerEntry.enabled !== false) {
    throw new Error(`first install must be catalog + disabled: ${JSON.stringify(consumerEntry)}`)
  }
  if (consumerEntry.installedVersion !== FIRST_VERSION || consumerEntry.publishStatus !== 'installed') {
    throw new Error(`install state is wrong: ${JSON.stringify(consumerEntry)}`)
  }
  fields.secondProfileInstalled = true
  steps.secondProfileInstalled = {
    profile: 'consumer-profile',
    version: consumerEntry.installedVersion,
    enabled: consumerEntry.enabled,
    publishStatus: consumerEntry.publishStatus,
    creatorProfileState: stateFor(dirs.creatorProfile)[`local:${SLUG}`]?.publishStatus,
  }

  // 4. Independent on-disk signature verification of the installed copy.
  const packageDir = agentPackageDir(dirs.consumerProfile, SLUG)
  const verified = verifyAgentPackageDirectory(packageDir, [keyring])
  if (verified.signature.keyId !== keyring.keyId) {
    throw new Error(`installed signature keyId ${verified.signature.keyId} != ${keyring.keyId}`)
  }
  if (verified.manifest.version !== FIRST_VERSION) {
    throw new Error('the installed manifest version does not match')
  }
  fields.signatureVerified = true
  steps.signatureVerified = {
    keyId: verified.signature.keyId,
    slot: verified.signature.slot,
    version: verified.manifest.version,
    digestFiles: verified.digest.files.length,
    note: 'verifyAgentPackageDirectory re-reads the installed directory and checks keyId-authoritative Ed25519.',
  }

  // 5. Enable + a REAL HTTP fixture dispatch through the real host.
  const activeTurns = createAgentPackageActiveTurnRegistry()
  const security = createAgentCatalogSecurity({
    profileDir: dirs.consumerProfile,
    registry: activeTurns,
    client: configureConsumer(dirs.consumerProfile, catalog.port, tokens),
  })
  const host = createAgentPackageHost({
    profileDir: dirs.consumerProfile,
    takenSlugs: () => [],
    activeTurns,
    security,
  })
  host.setEnabled(SLUG, true)
  const enabledEntry = stateFor(dirs.consumerProfile)[`catalog:${SLUG}`]
  if (enabledEntry?.enabled !== true) throw new Error('enable did not persist')

  const firstTurnActivation = createActivationRecorder()
  const firstTurn = await dispatchHttpTurn({
    host,
    workspaceRoot: dirs.workspace,
    sessionId: `${SESSION_PREFIX}-session-1`,
    activation: firstTurnActivation,
  })
  if (firstTurn.health.status !== 200 || firstTurn.health.body !== 'ok') {
    throw new Error(`HTTP fixture health was ${JSON.stringify(firstTurn.health)}`)
  }
  const echo = firstTurn.invoke.body?.result?.echo
  if (firstTurn.invoke.status !== 200 || echo?.task !== 'm2-acceptance' || echo?.version !== FIRST_VERSION) {
    throw new Error(`HTTP fixture invoke was ${JSON.stringify(firstTurn.invoke)}`)
  }
  if (!(await portOpen(firstTurn.httpPort))) throw new Error('the HTTP fixture port was not accepting')
  firstTurnActivation.record.settle()
  await firstTurn.dispatched.afterIdle()
  const firstTurnPortClosed = await waitForPortClosed(firstTurn.httpPort)
  if (!firstTurnPortClosed) throw new Error(`HTTP fixture port ${String(firstTurn.httpPort)} stayed open after afterIdle`)
  fields.enabledAndHttpRan = true
  steps.enabledAndHttpRan = {
    version: firstTurn.pkg.version,
    httpPort: firstTurn.httpPort,
    health: firstTurn.health,
    invoke: firstTurn.invoke.body,
    activationDisposed: firstTurnActivation.record.disposed,
    portClosedAfterIdle: firstTurnPortClosed,
    sandbox: 'passthrough (M2 checks signed-package lifecycle; M1 probe owns sandbox enforcement)',
  }

  // 6. Publish 1.0.1 (simulated local commit shape), review, sign, update.
  writePackageFiles(agentPackageDir(dirs.creatorProfile, SLUG), SECOND_VERSION, '你是 M2 验收助手的第二版。')
  const creatorState = stateFor(dirs.creatorProfile)
  creatorState[`local:${SLUG}`] = {
    ...creatorState[`local:${SLUG}`],
    installedVersion: SECOND_VERSION,
  }
  writeAgentPackageState(dirs.creatorProfile, creatorState)
  resetLocalAgentPackagePublication(dirs.creatorProfile, SLUG)
  configureCreator(dirs.creatorProfile, catalog.port, tokens)
  const secondSubmission = await publishLocalAgentPackage(SLUG)
  const reviewB = await runCli(
    ['review', secondSubmission.submissionId, '--out', dirs.reviewB],
    adminEnv(catalog.baseUrl, tokens),
  )
  const reviewBStep = requireCliOk(reviewB, secrets)
  const approveB = await runCli(
    [
      'approve',
      secondSubmission.submissionId,
      '--review',
      join(dirs.reviewB, 'review.json'),
      '--private-key',
      dirs.privateKey,
      '--slot',
      '1',
      '--yes',
    ],
    adminEnv(catalog.baseUrl, tokens),
  )
  const approveBStep = requireCliOk(approveB, secrets)
  configureCreator(dirs.creatorProfile, catalog.port, tokens)
  const secondPublication = await refreshLocalAgentPackagePublishStatus(SLUG)
  if (secondPublication.publishStatus !== 'published' || secondPublication.publishedVersion !== SECOND_VERSION) {
    throw new Error(`1.0.1 publication was ${JSON.stringify(secondPublication)}`)
  }
  configureConsumer(dirs.consumerProfile, catalog.port, tokens)
  const updated = await updateCatalogAgentPackage(SLUG, security.stopAgentPackageTurnsForSlug)
  const enabledAfterUpdate = stateFor(dirs.consumerProfile)[`catalog:${SLUG}`]
  if (updated.manifest.version !== SECOND_VERSION) throw new Error('update returned the wrong version')
  if (enabledAfterUpdate?.enabled !== true) throw new Error('update did not preserve enabled')
  if (enabledAfterUpdate.installedVersion !== SECOND_VERSION) throw new Error('update did not record 1.0.1')
  fields.updatedPreservingEnabled = true
  steps.updatedPreservingEnabled = {
    cli: [reviewBStep, approveBStep],
    from: FIRST_VERSION,
    to: enabledAfterUpdate.installedVersion,
    enabled: enabledAfterUpdate.enabled,
    publishStatus: enabledAfterUpdate.publishStatus,
  }

  // 6b. Security negatives that need the live catalog and installed keyring,
  // while BOTH 1.0.0 and 1.0.1 are still published (so 1.0.0 is a real replay).
  const wrongToken = await fetchJson(`${catalog.baseUrl}/v1/agent-packages`, {
    headers: { authorization: `Bearer ${'wrong-token-'.padEnd(40, 'x')}` },
  })
  negatives.wrongToken = {
    status: wrongToken.status,
    body: wrongToken.body,
    ok: wrongToken.status === 401 && wrongToken.body?.error === '口令错误',
  }
  if (!negatives.wrongToken.ok) throw new Error('a wrong token was not refused with 401')

  const unrelatedPair = generateKeyPair()
  let unknownKeyError = null
  try {
    verifyAgentPackageDirectory(packageDir, [
      {
        keyId: fingerprintPublicKeyHex(unrelatedPair.publicKeyHex),
        publicKeyHex: unrelatedPair.publicKeyHex,
        slot: 1,
      },
    ])
  } catch (error) {
    unknownKeyError = errorText(error)
  }
  negatives.unknownKey = {
    error: unknownKeyError,
    ok: unknownKeyError === '包校验失败，未安装或未运行。请联系管理员',
  }
  if (!negatives.unknownKey.ok) throw new Error('an unknown key was not refused')

  const tamperedProfile = join(dirs.root, 'tampered-profile')
  cpSync(agentPackageDir(dirs.consumerProfile, SLUG), agentPackageDir(tamperedProfile, SLUG), { recursive: true })
  writeFileSync(join(agentPackageDir(tamperedProfile, SLUG), 'persona.md'), '被篡改的人设\n', 'utf8')
  let tamperedError = null
  try {
    verifyAgentPackageDirectory(agentPackageDir(tamperedProfile, SLUG), [keyring])
  } catch (error) {
    tamperedError = errorText(error)
  }
  negatives.tamperedContent = {
    error: tamperedError,
    ok: tamperedError === '包校验失败，未安装或未运行。请联系管理员',
  }
  if (!negatives.tamperedContent.ok) throw new Error('tampered content was not refused')

  configureConsumer(dirs.thirdProfile, catalog.port, tokens)
  let replayError = null
  try {
    await installCatalogAgentPackage(SLUG, FIRST_VERSION)
  } catch (error) {
    replayError = errorText(error)
  }
  negatives.olderVersionReplay = {
    error: replayError,
    ok: replayError !== null && replayError.includes('不是目录中的最新版本'),
  }
  if (!negatives.olderVersionReplay.ok) throw new Error('an older version was not refused as a replay')

  // 7. Delist 1.0.1, approve it offline, refresh the installed card metadata.
  configureCreator(dirs.creatorProfile, catalog.port, tokens)
  const delistRequest = await requestLocalAgentPackageDelist(SLUG, 'M2 验收:演示下架')
  const delistQueue = await runCli(['delist-requests'], adminEnv(catalog.baseUrl, tokens))
  const delistQueueStep = requireCliOk(delistQueue, secrets)
  if (!delistQueue.stdout.includes(delistRequest.requestId)) {
    throw new Error('delist-requests did not list the request')
  }
  const delistApprove = await runCli(
    ['delist-approve', delistRequest.requestId],
    adminEnv(catalog.baseUrl, tokens),
  )
  const delistApproveStep = requireCliOk(delistApprove, secrets)
  configureConsumer(dirs.consumerProfile, catalog.port, tokens)
  const refresh = await refreshInstalledCatalogPackageStatuses()
  if (refresh.changed !== true) throw new Error('status refresh did not report a change')
  const delistedEntry = stateFor(dirs.consumerProfile)[`catalog:${SLUG}`]
  const delistedCard = host.listLocal().find((item) => item.slug === SLUG)
  if (delistedEntry?.publishStatus !== 'delisted') {
    throw new Error(`installed publishStatus was ${delistedEntry?.publishStatus}`)
  }
  if (delistedCard?.publishStatus !== 'delisted' || delistedCard?.enabled !== true || delistedCard?.broken !== undefined) {
    throw new Error(`installed card was ${JSON.stringify(delistedCard)}`)
  }
  fields.delistedStatusVisible = true
  steps.delistedStatusVisible = {
    cli: [delistQueueStep, delistApproveStep],
    requestId: delistRequest.requestId,
    publishStatus: delistedEntry.publishStatus,
    enabled: delistedEntry.enabled,
    card: {
      publishStatus: delistedCard.publishStatus,
      enabled: delistedCard.enabled,
      broken: delistedCard.broken ?? null,
    },
    refreshChanged: refresh.changed,
  }

  // 8. A delisted installed copy still runs (delist is not a security control).
  const delistedTurnActivation = createActivationRecorder()
  const delistedTurn = await dispatchHttpTurn({
    host,
    workspaceRoot: dirs.workspace,
    sessionId: `${SESSION_PREFIX}-session-2`,
    activation: delistedTurnActivation,
  })
  if (delistedTurn.invoke.body?.result?.echo?.version !== SECOND_VERSION) {
    throw new Error(`delisted dispatch returned ${JSON.stringify(delistedTurn.invoke.body)}`)
  }
  delistedTurnActivation.record.settle()
  await delistedTurn.dispatched.afterIdle()
  const delistedTurnPortClosed = await waitForPortClosed(delistedTurn.httpPort)
  if (!delistedTurnPortClosed) throw new Error('the delisted-turn HTTP port stayed open')
  fields.delistedInstalledStillRan = true
  steps.delistedInstalledStillRan = {
    version: delistedTurn.pkg.version,
    invoke: delistedTurn.invoke.body,
    note: 'delisted metadata changes the card, not the runtime; revocation is the security control.',
    portClosedAfterIdle: delistedTurnPortClosed,
  }

  // 9. Long turn + revocation: the activation must be disposed and the child stopped.
  const longTurnActivation = createActivationRecorder()
  const longTurn = await dispatchHttpTurn({
    host,
    workspaceRoot: dirs.workspace,
    sessionId: `${SESSION_PREFIX}-session-3`,
    activation: longTurnActivation,
  })
  const activationLiveBeforeRevoke = !longTurnActivation.record.resultSettled && !longTurnActivation.record.disposed
  if (!activationLiveBeforeRevoke) throw new Error('the long turn activation was not live before revocation')
  const revoke = await runCli(
    ['revoke', SLUG, SECOND_VERSION, '--reason', 'M2 验收:撤销当前版本'],
    adminEnv(catalog.baseUrl, tokens),
  )
  const revokeStep = requireCliOk(revoke, secrets)
  configureConsumer(dirs.consumerProfile, catalog.port, tokens)
  const revocationRefresh = await security.refreshRevocations()
  const revokedEntry = stateFor(dirs.consumerProfile)[`catalog:${SLUG}`]
  if (longTurnActivation.record.disposed !== true) throw new Error('revocation did not dispose the activation')
  if (longTurnActivation.record.resultSettled !== false) {
    throw new Error('the aborted long turn unexpectedly settled')
  }
  const longTurnPortClosed = await waitForPortClosed(longTurn.httpPort)
  if (!longTurnPortClosed) throw new Error('revocation did not stop the HTTP child')
  if (revokedEntry?.enabled !== false || revokedEntry?.revoked?.version !== SECOND_VERSION) {
    throw new Error(`revocation state was ${JSON.stringify(revokedEntry)}`)
  }
  fields.revocationStoppedActiveTurn = true
  steps.revocationStoppedActiveTurn = {
    cli: revokeStep,
    warnings: revocationRefresh.warning ?? null,
    session: `${SESSION_PREFIX}-session-3`,
    httpPort: longTurn.httpPort,
    activationDisposed: longTurnActivation.record.disposed,
    activationResultPending: longTurnActivation.record.resultSettled === false,
    portClosed: longTurnPortClosed,
    state: {
      enabled: revokedEntry.enabled,
      revokedVersion: revokedEntry.revoked?.version,
      revokedReason: revokedEntry.revoked?.reason,
    },
  }

  // 10. A revoked version cannot be enabled or dispatched (stale detail included).
  let enableError = null
  try {
    host.setEnabled(SLUG, true)
  } catch (error) {
    enableError = errorText(error)
  }
  if (enableError === null || !enableError.includes('撤销')) {
    throw new Error(`enabling a revoked package was not rejected: ${String(enableError)}`)
  }
  const stalePkg = longTurn.pkg
  let staleDispatchError = null
  try {
    await host.dispatch({
      ctx: {
        get: () => undefined,
        huaanworkWorkspaceRoot: { current: dirs.workspace },
        subagents: { startActivation: async () => { throw new Error('must not start') } },
      },
      sessionId: `${SESSION_PREFIX}-session-4`,
      pkg: stalePkg,
      remainder: 'must not run',
      resolveParent: async () => ({ id: `${SESSION_PREFIX}-parent` }),
    })
  } catch (error) {
    staleDispatchError = errorText(error)
  }
  if (staleDispatchError === null || !staleDispatchError.includes('撤销')) {
    throw new Error(`a stale revoked detail was not rejected: ${String(staleDispatchError)}`)
  }
  let assertError = null
  try {
    await security.assertRunnable(SLUG, SECOND_VERSION)
  } catch (error) {
    assertError = errorText(error)
  }
  if (assertError === null || !assertError.includes('撤销')) {
    throw new Error(`assertRunnable did not reject the revoked version: ${String(assertError)}`)
  }
  const revokedCard = host.listLocal().find((item) => item.slug === SLUG)
  if (revokedCard?.broken === undefined) throw new Error('the revoked card is not marked broken')
  fields.revokedEnableRejected = true
  steps.revokedEnableRejected = {
    enableError,
    staleDispatchError,
    assertRunnableError: assertError,
    cardBroken: revokedCard.broken.reason,
  }

  // 11. A revoked version is refused at install too (1.0.0 is the latest
  // published version by now, so this specifically exercises the revocation).
  configureConsumer(dirs.thirdProfile, catalog.port, tokens)
  let revokedInstallError = null
  try {
    await installCatalogAgentPackage(SLUG, SECOND_VERSION)
  } catch (error) {
    revokedInstallError = errorText(error)
  }
  negatives.revokedVersionInstall = {
    error: revokedInstallError,
    ok: revokedInstallError !== null && (revokedInstallError.includes('撤销') || revokedInstallError.includes('目录中没有版本')),
  }
  if (!negatives.revokedVersionInstall.ok) throw new Error('a revoked version was not refused at install')

  negatives.coveredByIntegrationTests = {
    unsignedOrSignatureCarryingBundle: 'packages/agent-package-format/tests/bundle.test.ts',
    extraFilesAndMismatchedManifest: 'dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts',
    retiredAndWrongKeys: 'agent-catalog-server/tests/submissions.spec.ts',
    tooManyEntriesAndLongPaths: 'packages/agent-package-format/tests/bundle.test.ts',
    downgradeAndDelistedLatest: 'dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts',
    wrongPublishOrAdminToken: 'agent-catalog-server/tests/auth-legacy.spec.ts',
    revocationAndActiveTurn: 'dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts',
  }

  configureCreator(dirs.creatorProfile, catalog.port, tokens)
  const creatorFinal = stateFor(dirs.creatorProfile)[`local:${SLUG}`]
  const consumerFinal = stateFor(dirs.consumerProfile)[`catalog:${SLUG}`]
  steps.finalState = {
    creator: creatorFinal,
    consumer: consumerFinal,
    auditLines: readFileSync(join(dirs.data, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '').length,
  }

  // Cleanup is part of the probe: nothing may keep running.
  await stopAllAgentPackageProcesses()
  resetAgentCatalogForTests()
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.platform === undefined) usage('missing --platform')
  if (args.platform !== 'darwin' && args.platform !== 'win32') {
    usage(`--platform must be darwin or win32, got ${args.platform}`)
  }
  if (args.platform !== process.platform) {
    usage(`refusing to label a ${process.platform} run as ${args.platform}`)
  }

  const report = {
    submitted: false,
    reviewedAndSigned: false,
    secondProfileInstalled: false,
    signatureVerified: false,
    enabledAndHttpRan: false,
    updatedPreservingEnabled: false,
    delistedInstalledStillRan: false,
    delistedStatusVisible: false,
    revocationStoppedActiveTurn: false,
    revokedEnableRejected: false,
    residualProcesses: -1,
    kind: 'huaanwork-agent-package-m2-acceptance',
    platform: args.platform,
    commit: gitSha(),
    runner: {
      os: process.env.RUNNER_OS ?? osPlatform(),
      osRelease: osRelease(),
      name: process.env.RUNNER_NAME ?? hostname(),
      arch: osArch(),
      node: process.version,
    },
    scope: {
      server: 'agent-catalog-server in-process, real HTTP, ephemeral loopback port',
      adminCli: 'agent-catalog-admin/src/cli.ts spawned as a child process',
      gui: false,
      realModel: false,
      note:
        'No GUI, no model interview and no packaged app. The sandbox is a passthrough seam; ' +
        'sandbox enforcement is covered by the M1 Windows sandbox probe.',
    },
    environment: {
      note:
        'entriesDir, dataDir, keyring, profiles and workspace are throwaway directories under the OS temp dir; ' +
        'the Ed25519 keypair is generated per run and never committed; all three tokens are random per run.',
    },
    tempRoot: null,
    steps: {},
    negatives: {},
    cleanup: {},
    verdict: 'FAIL',
    exitCode: 1,
  }

  const dirs = makeDirs()
  report.tempRoot = dirs.root
  let catalog
  let exitCode = 1
  let blocked = null
  let probeError = null
  try {
    const tokens = makeTokens()
    const pair = generateKeyPair()
    const keyId = fingerprintPublicKeyHex(pair.publicKeyHex)
    const keyring = { keyId, publicKeyHex: pair.publicKeyHex, slot: 1 }
    writeFileSync(
      dirs.keyring,
      `${JSON.stringify({ schemaVersion: 1, keys: [keyring] }, null, 2)}\n`,
      { mode: 0o600 },
    )
    writeFileSync(dirs.privateKey, pair.privateKeyPem, { mode: 0o600 })

    log(`booting the catalog server under ${dirs.root}`)
    catalog = await bootCatalog(dirs, tokens, keyring)
    log(`catalog listening on ${catalog.baseUrl}`)

    await runProbe({
      dirs,
      catalog,
      tokens,
      keyring,
      fields: report,
      steps: report.steps,
      negatives: report.negatives,
      privateKeyPem: pair.privateKeyPem,
    })
  } catch (error) {
    probeError = error
    log(`probe failed: ${errorText(error)}`)
  } finally {
    // Explicit application-level dispose, exactly like the plugin disposer, and
    // only then the residual scan: a child that survived the dispose hook IS
    // the finding, not a reason to skip the scan.
    try {
      await stopAllAgentPackageProcesses()
    } catch (error) {
      log(`stopAllAgentPackageProcesses failed: ${errorText(error)}`)
    }
    resetAgentCatalogForTests()
  }

  try {
    const scan = await waitForResidualsClear(dirs.root)
    report.residualProcesses = scan.matches.length
    report.cleanup = {
      scannedProcesses: scan.scanned,
      matches: scan.matches,
      command: process.platform === 'win32'
        ? 'Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine'
        : 'ps -ax -o pid=,command=',
      note: 'Matches are processes whose command line references the throwaway temp root; the probe itself is excluded.',
    }
    if (scan.matches.length !== 0 && probeError === null) {
      probeError = new Error(`residualProcesses: ${String(scan.matches.length)}`)
    }
  } catch (error) {
    report.residualProcesses = -1
    report.cleanup = { error: errorText(error) }
    probeError ??= new Error(`residual process scan failed: ${errorText(error)}`)
  }

  if (catalog !== undefined) {
    try {
      await catalog.close()
    } catch (error) {
      log(`server close failed: ${errorText(error)}`)
    }
  }
  try {
    rmSync(dirs.root, { recursive: true, force: true })
  } catch (error) {
    log(`temp cleanup failed: ${errorText(error)}`)
  }

  if (probeError !== null) {
    if (catalog === undefined) {
      blocked = errorText(probeError)
      report.verdict = 'BLOCKED'
      report.exitCode = 3
      exitCode = 3
    } else {
      report.verdict = 'FAIL'
      report.exitCode = 1
      exitCode = 1
    }
    report.error = errorText(probeError)
  } else {
    const fieldsWithoutResiduals = [
      'submitted',
      'reviewedAndSigned',
      'secondProfileInstalled',
      'signatureVerified',
      'enabledAndHttpRan',
      'updatedPreservingEnabled',
      'delistedInstalledStillRan',
      'delistedStatusVisible',
      'revocationStoppedActiveTurn',
      'revokedEnableRejected',
    ]
    const failedField = fieldsWithoutResiduals.find((field) => report[field] !== true)
    if (failedField !== undefined || report.residualProcesses !== 0) {
      report.verdict = 'FAIL'
      report.exitCode = 1
      exitCode = 1
      report.error = failedField === undefined
        ? `residualProcesses: ${String(report.residualProcesses)}`
        : `failedField: ${failedField}`
    } else {
      exitCode = 0
      report.verdict = 'PASS'
      report.exitCode = 0
    }
  }

  if (blocked !== null) report.blocked = blocked
  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`)
  writeSummary(report.verdict, report.exitCode)
  process.stdout.write(`${JSON.stringify(report)}\n`, () => {
    process.exit(exitCode)
  })
}

function writeSummary(verdict, exitCode) {
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (!summary) return
  writeFileSync(
    summary,
    `M2 agent-package acceptance (${process.platform}): ${verdict} (exit ${String(exitCode)})\n`,
    { flag: 'a' },
  )
}

await main()
