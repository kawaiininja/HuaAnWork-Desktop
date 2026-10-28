/**
 * Windows GHA acceptance for subagent run visibility and targeted cancellation.
 *
 * Drives the real HuaAnWork renderer over CDP: a local profile registers a
 * local package fixture (`@doc-clerk`) and a loopback legacy catalog fixture
 * (`@legacy-demo`), types explicit `@` messages into the composer, and observes
 * the run card through completion and targeted cancellation for both channels.
 *
 * The model is a loopback stub, not a real model; the legacy catalog is a local
 * fixture, not the intranet catalog. Facts record both boundaries. Screenshots,
 * app logs, the stub request log, the desktop SHA and the Harness pin are
 * written for upload.
 *
 * Usage:
 *   node scripts/huaanwork-subagent-run-windows-acceptance.mjs \
 *     --platform win32 --out windows-subagent-run-acceptance.json \
 *     --screenshots screenshots --logs logs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, scrypt } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { arch as osArch, platform as osPlatform, release as osRelease, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { initProfile } from '@deepseek-ai/dsh-app-boot'

import { startStubLlm } from './huaanwork-stub-llm.mjs'
import { decideSubagentRunAcceptance } from './huaanwork-subagent-run-windows-verdict.mjs'
import { startLegacyCatalogFixture } from '../tests/fixtures/subagent-run-acceptance/legacy-catalog.mjs'

const scryptAsync = promisify(scrypt)
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MAIN_PATH = join(PACKAGE_ROOT, 'lib', 'main.js')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'tests', 'fixtures', 'subagent-run-acceptance')
const TERMINAL_PHASES = new Set(['completed', 'failed', 'stopped'])
const AUTH_USERNAME = 'acceptance'
const AUTH_PASSWORD = 'acceptance-pass-1'

const options = parseArgs(process.argv.slice(2))
const screenshots = []
const driverLog = []
let appLogFile
let legacyLogFile
let appProcess
let appCdp
let stub
let legacyCatalog
let tempRoot
let userDataDir
let facts
let shutdownDone = false

function parseArgs(argv) {
  const parsed = {
    platform: osPlatform(),
    out: join(process.cwd(), 'windows-subagent-run-acceptance.json'),
    screenshots: join(process.cwd(), 'screenshots'),
    logs: join(process.cwd(), 'logs'),
    timeout: 180_000,
    keep: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = argv[index + 1]
    if (token === '--platform' && value !== undefined) { parsed.platform = value; index += 1 }
    else if (token === '--out' && value !== undefined) { parsed.out = resolve(value); index += 1 }
    else if (token === '--screenshots' && value !== undefined) { parsed.screenshots = resolve(value); index += 1 }
    else if (token === '--logs' && value !== undefined) { parsed.logs = resolve(value); index += 1 }
    else if (token === '--timeout' && value !== undefined) { parsed.timeout = Number(value); index += 1 }
    else if (token === '--keep') parsed.keep = true
    else throw new Error(`unknown argument: ${token}`)
  }
  if (!['win32', 'darwin', 'linux'].includes(parsed.platform)) throw new Error(`unsupported --platform ${parsed.platform}`)
  if (!Number.isSafeInteger(parsed.timeout) || parsed.timeout < 30_000) throw new Error('--timeout must be at least 30000ms')
  return parsed
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  driverLog.push(line)
  process.stdout.write(`${line}\n`)
}

function delay(ms) {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function appVersions() {
  const desktop = readJson(join(PACKAGE_ROOT, 'package.json'))?.version
  const require = createRequire(import.meta.url)
  const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
  const dsh = readJson(dshManifest)?.version
  if (typeof desktop !== 'string' || desktop === '') throw new Error('desktop package version is missing')
  if (typeof dsh !== 'string' || dsh === '') throw new Error('dsh package version is missing')
  return { desktop, dsh }
}

async function writeAuthState(profileDir) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(AUTH_PASSWORD, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  writeFileSync(join(profileDir, 'account.json'), `${JSON.stringify({
    username: AUTH_USERNAME,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    kdf: 'scrypt',
    N: 16384,
    r: 8,
    p: 1,
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'auth-session.json'), `${JSON.stringify({ username: AUTH_USERNAME }, null, 2)}\n`)
}

function setupWizardStatePath(userDataDir, profileDir) {
  const profileHash = createHash('sha256').update(resolve(profileDir)).digest('hex')
  return join(userDataDir, 'profile-setup', profileHash, 'state.json')
}

function prepareProfile({ homeDir, userDataDir, workspaceDir, stubUrl, legacy }) {
  const versions = appVersions()
  const profileDir = join(homeDir, 'profiles', 'desktop')
  const parentDir = dirname(homeDir)
  mkdirSync(parentDir, { recursive: true })
  // A profile directory without package.json is treated as interrupted and
  // moved aside on launch; publish the shipped web template before seeding.
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  mkdirSync(workspaceDir, { recursive: true })
  writeFileSync(join(workspaceDir, 'README.md'), '# subagent run acceptance workspace\n')
  runGit(['init', '-q'], workspaceDir)

  const model = { id: 'stub', name: 'stub', base_url: stubUrl, model: 'stub', api_key: '' }
  writeFileSync(join(parentDir, 'settings.json'), `${JSON.stringify({
    base_url: stubUrl,
    model: 'stub',
    api_key: '',
    models: [model],
    active_model_id: 'stub',
    allow_network: false,
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'huaanwork-settings.json'), `${JSON.stringify({
    theme: 'light',
    models: [model],
    active_model_id: 'stub',
    base_url: stubUrl,
    model: 'stub',
    api_key: '',
    allow_network: false,
    guard_mode: 'smart',
    automation_timeout_ms: 600_000,
    keep_awake: false,
    agents_host: legacy.host,
    agents_port: legacy.port,
    agents_catalog_token: 'acceptance-token',
    agents_catalog_publish_token: '',
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'agents-state.json'), `${JSON.stringify({
    'local:doc-clerk': {
      source: 'local',
      enabled: true,
      installedVersion: '1.0.0',
      publishStatus: 'none',
    },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'agents-enabled.json'), `${JSON.stringify({ 'catalog:legacy-demo': true }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'agents-endpoints.json'), `${JSON.stringify({ entries: [] }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'huaanwork-workspace.json'), `${JSON.stringify({
    pendingRoot: workspaceDir,
    writtenAt: new Date().toISOString(),
  })}\n`)
  cpSync(join(FIXTURE_ROOT, 'package'), join(profileDir, 'agents', 'doc-clerk'), { recursive: true })

  const statePath = setupWizardStatePath(userDataDir, profileDir)
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dirname(statePath), 0o700)
  writeFileSync(statePath, `${JSON.stringify({
    version: 2,
    profileHash: createHash('sha256').update(resolve(profileDir)).digest('hex'),
    outcome: 'skipped',
    desktopVersion: versions.desktop,
    dshVersion: versions.dsh,
    setupRevision: 1,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(statePath, 0o600)
  return { profileDir, versions }
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address === null || typeof address === 'string') rejectPort(new Error('free port probe did not bind a TCP port'))
        else resolvePort(address.port)
      })
    })
  })
}

async function launchApp({ homeDir, userDataDir, cdpPort }) {
  const require = createRequire(import.meta.url)
  const electronPath = require('electron')
  if (typeof electronPath !== 'string') throw new Error('electron package did not provide an executable path')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DSH_HOME = homeDir
  env.DSH_TELEMETRY_DISABLED = '1'
  env.ELECTRON_ENABLE_LOGGING = '1'
  log(`launch electron ${electronPath}`)
  const child = spawn(electronPath, [
    mainPathArg(),
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  appLogFile = createWriteStream(join(options.logs, 'app-stdout.log'), { flags: 'a' })
  child.stdout?.on('data', (chunk) => {
    appLogFile.write(chunk)
    process.stdout.write(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    appLogFile.write(chunk)
    process.stderr.write(chunk)
  })
  child.once('exit', (code, signal) => {
    log(`electron exited code=${String(code)} signal=${String(signal)}`)
  })
  return child
}

function mainPathArg() {
  if (!existsSync(MAIN_PATH)) throw new Error(`built main process is missing: ${MAIN_PATH}; run yarn workspace dsh-plugin-huaanwork build first`)
  return MAIN_PATH
}

async function listPageTargets(cdpPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    if (!response.ok) return []
    const targets = await response.json()
    return targets.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  } catch {
    return []
  }
}

async function connectCdp(wsUrl, timeoutMs) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error(`CDP WebSocket did not open in ${timeoutMs}ms`)), timeoutMs)
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('CDP WebSocket failed')) }, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  const rejectPending = (cause) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(cause)
    }
    pending.clear()
  }
  socket.addEventListener('close', () => { rejectPending(new Error('CDP target closed')) })
  socket.addEventListener('error', () => { rejectPending(new Error('CDP WebSocket failed')) })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectCall(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'evaluation failed')
    }
    return response.result?.value
  }
  await call('Runtime.enable')
  await call('Page.enable')
  return {
    call,
    evaluate,
    close() {
      rejectPending(new Error('CDP client closed'))
      try { socket.close() } catch { /* already closed */ }
    },
  }
}

const APP_PROBE = `(() => ({
  readyState: document.readyState,
  url: location.href,
  hasAuth: document.querySelector('.auth-gate') !== null,
  hasComposer: document.querySelector('.composer textarea') !== null,
  hasShell: document.querySelector('.app-shell') !== null,
  body: (document.body?.innerText ?? '').slice(0, 400),
}))()`

const CARDS_EXPRESSION = `(() => [...document.querySelectorAll('.subagent-run-card')].map((card) => {
  const label = (card.querySelector('.subagent-run-label')?.textContent ?? '').trim()
  const statusNode = card.querySelector('.subagent-run-status-text') ?? card.querySelector('.subagent-run-status')
  const terminateButtons = [...card.querySelectorAll('.subagent-run-terminate')]
  const terminate = terminateButtons.find((button) => (button.textContent ?? '').trim() === '终止')
  const confirm = terminateButtons.find((button) => (button.textContent ?? '').trim().startsWith('确认终止'))
  return {
    label,
    phase: card.getAttribute('data-phase'),
    stale: card.getAttribute('data-stale') === 'true',
    status: (statusNode?.textContent ?? '').trim(),
    text: (card.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    terminateDisabled: terminate ? terminate.disabled : null,
    confirmText: confirm ? (confirm.textContent ?? '').trim() : null,
  }
}))()`

const COMPOSER_STATE = `(() => {
  const textarea = document.querySelector('.composer textarea')
  const stop = document.querySelector('.composer button.send.stop')
  const send = document.querySelector('.composer button.send[aria-label="发送"]')
  return {
    hasComposer: textarea !== null,
    textareaDisabled: textarea?.disabled ?? null,
    turnActive: stop !== null,
    sendPresent: send !== null,
    sendDisabled: send?.disabled ?? null,
  }
})()`

async function waitFor(label, probe, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last?.ok === true) return last.value
    await delay(intervalMs)
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`)
}

async function connectAppPage(cdpPort, timeoutMs) {
  let sawWizard = false
  try {
    return await waitFor('app page target', async () => {
      const targets = await listPageTargets(cdpPort)
      const candidates = targets.filter((target) => !String(target.url).startsWith('devtools://'))
      for (const target of candidates) {
        if (String(target.url).startsWith('dsh-setup-wizard:')) {
          if (!sawWizard) log(`setup wizard target is present: ${target.url}`)
          sawWizard = true
          continue
        }
        let client
        try {
          client = await connectCdp(target.webSocketDebuggerUrl, 10_000)
          await client.call('Page.bringToFront')
          const state = await client.evaluate(APP_PROBE)
          if (state?.hasAuth === true || state?.hasComposer === true || state?.hasShell === true) {
            return { ok: true, value: client }
          }
          client.close()
        } catch (cause) {
          client?.close()
          log(`page target ${String(target.url)} not ready: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      return { ok: false }
    }, timeoutMs, 1_000)
  } catch (cause) {
    if (sawWizard) throw new Error(`the setup wizard stayed open despite the skipped marker: ${cause instanceof Error ? cause.message : String(cause)}`)
    throw cause
  }
}

async function ensureLoggedIn(client) {
  const state = await client.evaluate(APP_PROBE)
  if (state?.hasComposer === true) return
  if (state?.hasAuth !== true) {
    await waitFor('composer or auth gate', async () => {
      const probe = await client.evaluate(APP_PROBE)
      return { ok: probe?.hasComposer === true || probe?.hasAuth === true, value: probe }
    }, 120_000, 500)
    return ensureLoggedIn(client)
  }
  log('auth gate is visible; submitting the local acceptance account through the UI')
  const submitted = await client.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.auth-card input')]
    if (inputs.length < 2) return { ok: false, reason: 'auth inputs missing' }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const values = [${JSON.stringify(AUTH_USERNAME)}, ${JSON.stringify(AUTH_PASSWORD)}, ${JSON.stringify(AUTH_PASSWORD)}]
    inputs.forEach((input, index) => {
      setter.call(input, values[index] ?? values[1])
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = document.querySelector('.auth-card button[type="submit"]')
    if (!submit) return { ok: false, reason: 'auth submit missing' }
    if (submit.disabled) return { ok: false, reason: 'auth submit disabled' }
    submit.click()
    return { ok: true }
  })()`)
  if (submitted?.ok !== true) throw new Error(`auth fallback failed: ${JSON.stringify(submitted)}`)
  await waitFor('composer after auth', async () => {
    const probe = await client.evaluate(APP_PROBE)
    return { ok: probe?.hasComposer === true, value: probe }
  }, 60_000, 500)
}

async function cards(client) {
  return client.evaluate(CARDS_EXPRESSION)
}

async function waitForComposerIdle(client, timeoutMs = 60_000) {
  await waitFor('composer idle', async () => {
    const state = await client.evaluate(COMPOSER_STATE)
    return { ok: state?.hasComposer === true && state.turnActive === false && state.textareaDisabled !== true, value: state }
  }, timeoutMs, 250)
}

async function sendText(client, text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await client.evaluate(`(async () => {
      const textarea = document.querySelector('.composer textarea')
      if (!textarea) return { ok: false, reason: 'composer missing' }
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(text)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))
      const send = document.querySelector('.composer button.send[aria-label="发送"]')
      if (!send) return { ok: false, reason: 'send button missing' }
      if (send.disabled) return { ok: false, reason: 'send disabled' }
      send.click()
      return { ok: true }
    })()`)
    if (result?.ok === true) return
    await delay(500)
  }
  throw new Error(`send failed for ${JSON.stringify(text)}`)
}

async function waitForNewCard(client, label, previousCount, timeoutMs = 90_000) {
  return waitFor(`new card ${label}`, async () => {
    const list = await cards(client)
    if (!Array.isArray(list) || list.length <= previousCount) return { ok: false, value: list?.length }
    const matches = list.filter((card) => card.label === label)
    if (matches.length === 0) return { ok: false, value: list.length }
    return { ok: true, value: { list, card: matches[matches.length - 1] } }
  }, timeoutMs, 250)
}

async function waitForTerminal(client, label, timeoutMs = 90_000) {
  const phases = []
  let sawToolActivity = false
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const list = await cards(client)
    const matches = list.filter((card) => card.label === label)
    const card = matches[matches.length - 1]
    if (card !== undefined) {
      if (card.phase !== undefined && !phases.includes(card.phase)) phases.push(card.phase)
      if (card.phase === 'tool' || card.status.includes('正在执行工具') || card.text.includes('pwsh') || card.text.includes('bash')) {
        sawToolActivity = true
      }
      last = { card, phases: [...phases], sawTool: sawToolActivity }
      if (TERMINAL_PHASES.has(card.phase)) {
        return { ...last, terminal: card }
      }
    }
    await delay(250)
  }
  throw new Error(`card ${label} did not reach a terminal phase in ${timeoutMs}ms; last=${JSON.stringify(last)}`)
}

async function waitForActiveCard(client, label, timeoutMs = 90_000) {
  const phases = []
  let sawToolActivity = false
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const list = await cards(client)
    const matches = list.filter((card) => card.label === label)
    const card = matches[matches.length - 1]
    if (card !== undefined) {
      if (card.phase !== undefined && !phases.includes(card.phase)) phases.push(card.phase)
      if (card.phase === 'tool' || card.status.includes('正在执行工具') || card.text.includes('pwsh') || card.text.includes('bash')) {
        sawToolActivity = true
      }
      last = { card, phases: [...phases], sawTool: sawToolActivity }
      if (!TERMINAL_PHASES.has(card.phase) && card.stale !== true && card.terminateDisabled === false) {
        return last
      }
    }
    await delay(250)
  }
  throw new Error(`card ${label} never became actively cancellable in ${timeoutMs}ms; last=${JSON.stringify(last)}`)
}

async function clickTerminate(client, label) {
  const clicked = await client.evaluate(`(() => {
    const matches = [...document.querySelectorAll('.subagent-run-card')]
      .filter((card) => (card.querySelector('.subagent-run-label')?.textContent ?? '').trim() === ${JSON.stringify(label)})
    const card = matches[matches.length - 1]
    if (!card) return { ok: false, reason: 'card missing' }
    const button = [...card.querySelectorAll('.subagent-run-terminate')]
      .find((candidate) => (candidate.textContent ?? '').trim() === '终止')
    if (!button || button.disabled) return { ok: false, reason: 'terminate unavailable' }
    button.click()
    return { ok: true }
  })()`)
  if (clicked?.ok !== true) throw new Error(`could not click terminate on ${label}: ${JSON.stringify(clicked)}`)
  await waitFor('confirm terminate', async () => {
    const list = await cards(client)
    const matches = list.filter((card) => card.label === label)
    const card = matches[matches.length - 1]
    return { ok: card?.confirmText !== null && card?.confirmText !== undefined, value: card?.confirmText }
  }, 10_000, 100)
  const confirmed = await client.evaluate(`(() => {
    const matches = [...document.querySelectorAll('.subagent-run-card')]
      .filter((card) => (card.querySelector('.subagent-run-label')?.textContent ?? '').trim() === ${JSON.stringify(label)})
    const card = matches[matches.length - 1]
    const button = [...card.querySelectorAll('.subagent-run-terminate')]
      .find((candidate) => (candidate.textContent ?? '').trim().startsWith('确认终止'))
    if (!button) return { ok: false, reason: 'confirm button missing' }
    button.click()
    return { ok: true }
  })()`)
  if (confirmed?.ok !== true) throw new Error(`could not confirm terminate on ${label}: ${JSON.stringify(confirmed)}`)
}

async function anchoring(client, text, label) {
  return client.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.bubble.user, .bubble.assistant, .subagent-run-card')]
    const userIndex = nodes.findIndex((node) => node.classList.contains('bubble') && node.classList.contains('user')
      && (node.textContent ?? '').trim() === ${JSON.stringify(text)})
    const cardIndexes = nodes.map((node, index) => ({ node, index }))
      .filter(({ node }) => node.classList.contains('subagent-run-card')
        && (node.querySelector('.subagent-run-label')?.textContent ?? '').trim() === ${JSON.stringify(label)})
      .map(({ index }) => index)
    const cardIndex = cardIndexes[cardIndexes.length - 1] ?? -1
    const userBetween = nodes.slice(userIndex + 1, cardIndex).filter((node) => node.classList.contains('bubble') && node.classList.contains('user')).length
    return { userIndex, cardIndex, anchored: userIndex >= 0 && cardIndex > userIndex && userBetween === 0 }
  })()`)
}

async function parentReplyAfter(client, text, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await client.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('.bubble.user, .bubble.assistant')]
      const userIndex = nodes.findIndex((node) => node.classList.contains('user')
        && (node.textContent ?? '').trim() === ${JSON.stringify(text)})
      const reply = userIndex < 0 ? undefined : nodes.slice(userIndex + 1)
        .find((node) => node.classList.contains('assistant') && (node.textContent ?? '').trim() !== '')
      return { userIndex, reply: reply ? (reply.textContent ?? '').trim() : null }
    })()`)
    if (typeof last?.reply === 'string' && last.reply !== '') return last
    await delay(500)
  }
  throw new Error(`no parent reply after ${JSON.stringify(text)}: ${JSON.stringify(last)}`)
}

async function screenshot(client, name) {
  const captured = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (typeof captured?.data !== 'string' || captured.data === '') throw new Error(`screenshot ${name} was empty`)
  const bytes = Buffer.from(captured.data, 'base64')
  const path = join(options.screenshots, name)
  writeFileSync(path, bytes)
  screenshots.push({ name, bytes: bytes.byteLength })
  log(`screenshot ${name} (${String(bytes.byteLength)} bytes)`)
}

async function runScenario(client, definition) {
  const { id, kind, label, text, expected, expectedStatus } = definition
  await waitForComposerIdle(client)
  const before = await cards(client)
  const cardsBefore = before.length
  const startedAt = new Date().toISOString()
  log(`scenario ${id}: sending ${JSON.stringify(text)}`)
  await sendText(client, text)
  await waitForNewCard(client, label, cardsBefore)
  let phases = []
  let sawToolActivity = false
  let terminateClicked = false
  let terminal
  if (expected === 'stopped') {
    const active = await waitForActiveCard(client, label)
    phases = active.phases
    sawToolActivity = active.sawTool
    await clickTerminate(client, label)
    terminateClicked = true
    terminal = await waitForTerminal(client, label)
    phases = [...new Set([...phases, ...terminal.phases])]
    sawToolActivity = sawToolActivity || terminal.sawTool
  } else {
    terminal = await waitForTerminal(client, label)
    phases = terminal.phases
    sawToolActivity = terminal.sawTool
  }
  const anchor = await anchoring(client, text, label)
  const after = await cards(client)
  await waitForComposerIdle(client)
  const scenario = {
    id,
    kind,
    label,
    text,
    expected,
    expectedStatus,
    cardsBefore,
    cardsAfter: after.length,
    anchored: anchor.anchored === true,
    userIndex: anchor.userIndex,
    cardIndex: anchor.cardIndex,
    phases: [...new Set([...phases, ...terminal.phases])],
    sawToolActivity,
    terminateClicked,
    terminalPhase: terminal.card.phase,
    terminalStatus: terminal.card.status,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
  log(`scenario ${id}: phase=${String(scenario.terminalPhase)} status=${JSON.stringify(scenario.terminalStatus)} phases=${scenario.phases.join(',')}`)
  return scenario
}

async function run() {
  mkdirSync(options.screenshots, { recursive: true })
  mkdirSync(options.logs, { recursive: true })
  const startedAt = new Date().toISOString()
  tempRoot = mkdtempSync(join(tmpdir(), 'huaanwork-subagent-acceptance-'))
  log(`isolated root ${tempRoot}`)
  const homeDir = join(tempRoot, 'dsh-home', '.huaanwork')
  userDataDir = join(tempRoot, 'user-data')
  const workspaceDir = join(tempRoot, 'workspace')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  const shell = shellTool(options.platform)
  process.env.STUB_DEBUG_FILE = join(options.logs, 'stub-requests.jsonl')
  stub = await startStubLlm([
    { match: /<host-instruction>/, reply: { content: '已交给子代理，等待结果。' } },
    { match: /HANG/, reply: { hang: true } },
    { match: /TOOL/, reply: { toolCalls: [{ name: shell.name, arguments: shell.arguments }] } },
  ])
  legacyLogFile = createWriteStream(join(options.logs, 'legacy-catalog.log'), { flags: 'a' })
  legacyCatalog = await startLegacyCatalogFixture({ logFile: legacyLogFile })
  log(`stub ${stub.url}; legacy catalog ${legacyCatalog.host}:${String(legacyCatalog.port)}`)

  const prepared = prepareProfile({
    homeDir,
    userDataDir,
    workspaceDir,
    stubUrl: stub.url,
    legacy: legacyCatalog,
  })
  await writeAuthState(prepared.profileDir)

  const cdpPort = await freePort()
  appProcess = await launchApp({ homeDir, userDataDir, cdpPort })
  appCdp = await connectAppPage(cdpPort, options.timeout)
  await ensureLoggedIn(appCdp)
  await screenshot(appCdp, '00-app-ready.png')

  const scenarios = []
  scenarios.push(await runScenario(appCdp, {
    id: 'package-complete',
    kind: 'package',
    label: '@doc-clerk',
    text: '@doc-clerk TOOL package-complete: run the shell tool for two seconds and report done.',
    expected: 'completed',
    expectedStatus: '已完成',
  }))
  await screenshot(appCdp, '10-package-completed.png')
  scenarios.push(await runScenario(appCdp, {
    id: 'package-cancel',
    kind: 'package',
    label: '@doc-clerk',
    text: '@doc-clerk HANG package-cancel: keep running until the card is cancelled.',
    expected: 'stopped',
    expectedStatus: '已停止',
  }))
  await screenshot(appCdp, '11-package-stopped.png')
  scenarios.push(await runScenario(appCdp, {
    id: 'legacy-complete',
    kind: 'legacy',
    label: '@legacy-demo',
    text: '@legacy-demo TOOL legacy-complete: run the shell tool for two seconds and report done.',
    expected: 'completed',
    expectedStatus: '已完成',
  }))
  await screenshot(appCdp, '12-legacy-completed.png')
  scenarios.push(await runScenario(appCdp, {
    id: 'legacy-cancel',
    kind: 'legacy',
    label: '@legacy-demo',
    text: '@legacy-demo HANG legacy-cancel: keep running until the card is cancelled.',
    expected: 'stopped',
    expectedStatus: '已停止',
  }))
  await screenshot(appCdp, '13-legacy-stopped.png')

  await waitForComposerIdle(appCdp)
  const parentText = 'PARENT continue acceptance after the cancelled runs.'
  await sendText(appCdp, parentText)
  const parentUsable = await parentReplyAfter(appCdp, parentText)
  await screenshot(appCdp, '14-parent-usable.png')

  const finalCards = await cards(appCdp)
  facts = {
    schemaVersion: 1,
    platform: options.platform,
    runner: {
      os: process.env.RUNNER_OS ?? osPlatform(),
      arch: process.env.RUNNER_ARCH ?? osArch(),
      image: process.env.ImageOS ?? '',
      runnerName: process.env.RUNNER_NAME ?? '',
      release: osRelease(),
    },
    desktop: {
      headSha: runGit(['rev-parse', 'HEAD'], REPO_ROOT),
      branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT),
      appVersion: prepared.versions.desktop,
      dshVersion: prepared.versions.dsh,
      buildType: 'workspace-electron',
    },
    harness: {
      pin: runGit(['rev-parse', 'HEAD'], join(REPO_ROOT, 'deepseek-harness')),
      upstream: readJson(join(REPO_ROOT, 'upstream.json')),
    },
    model: { kind: 'loopback-stub', url: stub.url, allowNetwork: false },
    legacyCatalog: {
      kind: 'loopback-fixture',
      host: legacyCatalog.host,
      port: legacyCatalog.port,
      entryName: legacyCatalog.entryName,
    },
    packageFixture: { slug: 'doc-clerk', version: '1.0.0', source: 'tests/fixtures/subagent-run-acceptance/package' },
    scenarios,
    parentUsable: {
      text: parentText,
      observed: typeof parentUsable?.reply === 'string' && parentUsable.reply !== '',
      reply: parentUsable?.reply ?? null,
    },
    cardCount: finalCards.length,
    screenshots,
    logs: listFiles(options.logs),
    errors: [],
    startedAt,
    finishedAt: new Date().toISOString(),
  }
  decideSubagentRunAcceptance(facts, options.platform)
  persistFacts()
  log('verdict passed')
}

function persistFacts() {
  if (facts === undefined) return
  facts.screenshots = screenshots
  mkdirSync(dirname(options.out), { recursive: true })
  writeFileSync(options.out, `${JSON.stringify(facts, null, 2)}\n`)
}

function shellTool(platform) {
  // No shell metacharacters: guard_mode=smart rejects `;` before execution.
  return platform === 'win32'
    ? { name: 'pwsh', arguments: { description: 'Wait two seconds for acceptance', command: 'Start-Sleep -Seconds 2' } }
    : { name: 'bash', arguments: { description: 'Wait two seconds for acceptance', command: 'sleep 2' } }
}

function listFiles(root) {
  const entries = []
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const entry of dirents) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) entries.push(...listFiles(path).map((item) => ({ ...item, name: `${entry.name}/${item.name}` })))
    else {
      let bytes = 0
      try { bytes = statSync(path).size } catch { /* vanished */ }
      entries.push({ name: entry.name, bytes })
    }
  }
  return entries
}

async function writeFactsAndExit(error) {
  if (facts === undefined) {
    facts = {
      schemaVersion: 1,
      platform: options.platform,
      runner: { os: process.env.RUNNER_OS ?? osPlatform(), arch: process.env.RUNNER_ARCH ?? osArch(), image: process.env.ImageOS ?? '' },
      desktop: {
        headSha: runGit(['rev-parse', 'HEAD'], REPO_ROOT),
        branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT),
        appVersion: '',
        dshVersion: '',
        buildType: 'workspace-electron',
      },
      harness: { pin: runGit(['rev-parse', 'HEAD'], join(REPO_ROOT, 'deepseek-harness')) },
      model: { kind: 'loopback-stub', allowNetwork: false },
      legacyCatalog: { kind: 'loopback-fixture' },
      packageFixture: { slug: 'doc-clerk' },
      scenarios: [],
      parentUsable: { observed: false },
      cardCount: 0,
      screenshots,
      logs: [],
      errors: [],
    }
  }
  facts.finishedAt = new Date().toISOString()
  if (error !== undefined) {
    facts.errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
    if (appCdp !== undefined) {
      try {
        await screenshot(appCdp, '99-failure.png')
        const body = await appCdp.evaluate('document.body?.innerText ?? ""')
        writeFileSync(join(options.logs, 'page-dom-on-failure.txt'), String(body))
      } catch { /* best effort */ }
    }
  }
  facts.logs = listFiles(options.logs)
  persistFacts()
  log(`facts written to ${options.out}`)
  if (error !== undefined) {
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

async function shutdown() {
  if (shutdownDone) return
  shutdownDone = true
  try { appCdp?.close() } catch { /* best effort */ }
  if (appProcess !== undefined && appProcess.exitCode === null && appProcess.signalCode === null) {
    try {
      if (options.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        appProcess.kill('SIGTERM')
      }
    } catch { /* already gone */ }
    const deadline = Date.now() + 15_000
    while (appProcess.exitCode === null && appProcess.signalCode === null && Date.now() < deadline) await delay(250)
    if (appProcess.exitCode === null && appProcess.signalCode === null) {
      try { appProcess.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
  if (appLogFile !== undefined) {
    await new Promise((resolveEnd) => { appLogFile.end(resolveEnd) })
  }
  try { await stub?.close() } catch { /* best effort */ }
  try { await legacyCatalog?.close() } catch { /* best effort */ }
  if (legacyLogFile !== undefined) {
    await new Promise((resolveEnd) => { legacyLogFile.end(resolveEnd) })
  }
  if (userDataDir !== undefined && existsSync(join(userDataDir, 'logs'))) {
    cpSync(join(userDataDir, 'logs'), join(options.logs, 'app-logs'), { recursive: true })
  }
  writeFileSync(join(options.logs, 'driver.log'), `${driverLog.join('\n')}\n`)
  if (facts !== undefined) {
    facts.logs = listFiles(options.logs)
    persistFacts()
  }
  if (tempRoot !== undefined && !options.keep) {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run()
  .catch(async (error) => { await writeFactsAndExit(error) })
  .finally(async () => { await shutdown() })
