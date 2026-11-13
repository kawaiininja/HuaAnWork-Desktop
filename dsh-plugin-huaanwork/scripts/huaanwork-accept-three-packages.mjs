#!/usr/bin/env node
/**
 * Real-app CDP acceptance for the three shipped plaza agent packages.
 *
 * Drives the built HuaAnWork renderer over CDP against an isolated profile and
 * the `--keep-catalog` catalog produced by `verify-agent-packages-plaza.mjs`:
 * the plaza shows the three signed summaries, their pre-install detail only
 * advertises the signature notice, each package downloads and enables, the
 * installed detail verifies the signature and shows `tools.mode = none`, and
 * each `@slug` round completes with a run card.
 *
 * All three dispatches share one fresh 新建任务 session (the only reliable nav
 * back to the chat view from the plaza panel). That session's workspace root is
 * minted on first send (`<profile>/workspace-sessions/<sessionId>`), so the
 * samples are staged before launch and copied INTO that root right after the
 * first send (placeSamplesInDispatchRoot); the prompts address them relatively
 * (`samples/...`). This keeps the samples inside the dispatch session's root so
 * the workspace-bound read/glob/grep policy admits them — the final-review
 * finding was that samples left in the pendingRoot workspace fell outside the
 * fresh task root and reads were denied. Each package child must show a
 * successful `read`/`glob` call on the sample paths
 * (facts.modelOutputs[slug].sampleAccess); bash-only access fails. The dispatch
 * root is verified post-hoc against the parent session header cwd
 * (facts.dispatchRootChecks).
 *
 * Lane observation for `@typo-check` reads the durable session logs under
 * `$DSH_HOME/sessions` with the zstd CLI (multi-frame container) and pins the
 * delegation identity from session headers: parent dispatch text -> package
 * child (`parentSession`, `origin: "subagent"`, depth 1, first user message
 * carries the dispatch remainder) -> two lane sessions (depth 2). A dual-blind
 * PASS needs two distinct non-error `subagent` tool dispatches plus one
 * `subagent-settled` delivery per lane. Call counts alone never pass; a dispatch
 * error or an honest depth degradation fails the assertion.
 *
 * Model credentials are read from the production `huaanwork-settings.json` and
 * copied into the isolated profile; they are never printed. `guard_mode` is
 * always written as `smart` here (R9), never copied from production. The model
 * name defaults to the production active entry and can be overridden with
 * `--model <name>` (the plan pins the walkthrough to `deepseek-chat`; the
 * production settings may only carry another model name on the same provider).
 *
 * The Electron-ABI fs-ext binding must already exist (`prepare:electron-native`);
 * the script refuses to launch without it. App stdout/stderr are redacted before
 * they reach `app-stdout.log` or the console.
 *
 * The catalog connection comes from a Task 9 `--keep-catalog` run. Task 9
 * intentionally leaves that root on SIGTERM, so this script stops the catalog
 * pid it was given and deletes the root afterwards when the path is provably a
 * Task 9 temp root; otherwise it records a manual-delete instruction.
 *
 * Usage:
 *   node scripts/huaanwork-accept-three-packages.mjs \
 *     --connection <catalog-connection.json> --out <dir> [--timeout <ms>] [--model <name>] \
 *     [--keep-root] [--keep-catalog-root]
 *
 * `--keep-root` skips the final isolated-root removal and records its path in
 * `facts.isolatedRoot`; the root keeps the isolated profile copy of the model
 * credential and the per-run catalog token, so only use it for diagnosis and
 * delete it afterwards. `--keep-catalog-root` does the same for the Task 9
 * catalog root (diagnosis only; it holds the dev private key).
 *
 * Exit: 0 PASS / 1 FAIL / 2 usage / 3 BLOCKED (missing precondition).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { arch as osArch, homedir, platform as osPlatform, release as osRelease, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { initProfile } from '@deepseek-ai/dsh-app-boot'

import { redactReport, redactSecrets } from './huaanwork-acceptance-redaction.mjs'

const scryptAsync = promisify(scrypt)
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MAIN_PATH = join(PACKAGE_ROOT, 'lib', 'main.js')
const PRODUCTION_SETTINGS_PATH = join(homedir(), '.huaanwork', 'profiles', 'desktop', 'huaanwork-settings.json')
const AUTH_USERNAME = 'acceptance'
const AUTH_PASSWORD = 'acceptance-pass-1'
const SLUGS = ['typo-check', 'code-review', 'task-orch']
const DISPLAY_NAMES = { 'typo-check': '错别字检测', 'code-review': '代码审查', 'task-orch': '任务编排' }
const INSTALL_DETAIL_NOTICE = '安装后可查看签名与文件清单'
const PACKAGE_SANDBOX_WARNING = '脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。'
const DEFAULT_TIMEOUT_MS = 180_000
const COMPOSER_IDLE_TIMEOUT_MS = 60_000
const PARENT_REPLY_TIMEOUT_MS = 240_000
const HOST_CLEANUP_BUDGET_MS = 600_000
/** Step 6 human review needs the whole plan/report, not a 2 KB teaser. */
const MODEL_OUTPUT_EXCERPT_CHARS = 16_384
const SECRETS = []

/** Precondition the walkthrough cannot work around; reported as BLOCKED (exit 3). */
class BlockedError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'BlockedError'
    this.detail = detail
  }
}

const options = parseArgs(process.argv.slice(2))
const screenshots = []
const driverLog = []
let appLogFile
let appStreamSinks = []
let appProcess
let appCdp
let tempRoot
let userDataDir
let isolated
let catalogPid
let catalogUsed = false
let catalogCleanup
let facts
let shutdownDone = false
/** Partial drive results, kept even when a later step throws. */
const progress = { plaza: [], installs: [], enables: [], details: [], runs: [] }

function parseArgs(argv) {
  const out = { connection: null, outDir: null, timeout: DEFAULT_TIMEOUT_MS, model: null, keepRoot: false, keepCatalogRoot: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--connection') { out.connection = argv[i + 1]; i += 1 }
    else if (argv[i] === '--out') { out.outDir = argv[i + 1]; i += 1 }
    else if (argv[i] === '--timeout') { out.timeout = Number(argv[i + 1]); i += 1 }
    else if (argv[i] === '--model') { out.model = argv[i + 1]; i += 1 }
    else if (argv[i] === '--keep-root') { out.keepRoot = true }
    else if (argv[i] === '--keep-catalog-root') { out.keepCatalogRoot = true }
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2) }
  }
  if (!out.connection || !out.outDir) { console.error('usage: --connection <json> --out <dir> [--timeout <ms>] [--model <name>] [--keep-root] [--keep-catalog-root]'); process.exit(2) }
  if (!Number.isSafeInteger(out.timeout) || out.timeout < 30_000) { console.error('--timeout must be at least 30000ms'); process.exit(2) }
  if (out.model !== null && (typeof out.model !== 'string' || out.model.trim() === '')) { console.error('--model needs a non-empty model name'); process.exit(2) }
  return out
}

function registerSecrets(values) {
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (!SECRETS.includes(value)) SECRETS.push(value)
    const trimmed = value.trim()
    if (trimmed !== value && trimmed.length > 0 && !SECRETS.includes(trimmed)) SECRETS.push(trimmed)
  }
}

function log(message) {
  const line = `${new Date().toISOString()} ${redactSecrets(message, SECRETS)}`
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

/** macOS tmpdir is a symlink (/var → /private/var); compare roots canonically. */
function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
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

/** 生成含已知错别字的样例 docx（textutil，零依赖；不用真实基金报告）。 */
function makeSampleDocx(workDir) {
  const txt = join(workDir, 'sample.txt')
  const docx = join(workDir, 'sample.docx')
  writeFileSync(txt, [
    '本设备按装完毕，运行良好。',
    '银行帐户余额核对无误。',
    '积极应对市市场波动。',
    '我们将我们持续披露信息。',
    'Managment Report 已提交。',
    '截至２０２５年 6 月 30 日。',
    '在次提醒投资者注意风险。',
  ].join('\n'), 'utf8')
  const result = spawnSync('textutil', ['-convert', 'docx', '-output', docx, txt], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') {
    throw new BlockedError('textutil is unavailable; the docx sample cannot be generated', { platform: process.platform })
  }
  if (result.status !== 0) throw new Error(`textutil failed: ${result.stderr ?? ''}`)
  return docx
}

function makeSampleCode(workDir) {
  const file = join(workDir, 'sample-review.js')
  writeFileSync(file, [
    "const apiKey = 'sk-hardcoded-secret-12345';",
    "function run(userInput) {",
    "  return eval(userInput);",
    "}",
    "module.exports = { run, apiKey };",
  ].join('\n'), 'utf8')
  return file
}

/** lane 观测依赖 zstd CLI（多帧解压）；缺失 ⇒ BLOCKED exit 3，不静默降级。 */
function requireZstd() {
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    throw new BlockedError(
      'zstd CLI not found on PATH; session logs are multi-frame zstd and Node zlib only decodes the first frame',
      { status: probe.status, error: probe.error?.code },
    )
  }
}

function newestSourceMtime() {
  let newest = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  walk(join(PACKAGE_ROOT, 'src'))
  return newest
}

/**
 * A stale `lib/` would run pre-Task-11 code, so the walkthrough refuses it.
 * Build first: `corepack yarn workspace dsh-plugin-huaanwork build`.
 */
function requireFreshBuild() {
  if (!existsSync(MAIN_PATH)) {
    throw new BlockedError(`built main process is missing: ${MAIN_PATH}; run yarn workspace dsh-plugin-huaanwork build first`)
  }
  const libMtime = statSync(MAIN_PATH).mtimeMs
  const sourceMtime = newestSourceMtime()
  if (libMtime < sourceMtime) {
    throw new BlockedError(
      `built lib is older than src (lib ${new Date(libMtime).toISOString()} < src ${new Date(sourceMtime).toISOString()}); rebuild the package`,
    )
  }
  return { libMainMtime: new Date(libMtime).toISOString(), newestSourceMtime: new Date(sourceMtime).toISOString() }
}

/**
 * The launcher loads the Electron-ABI fs-ext binding produced by
 * `prepare:electron-native` (the same step `dev`/`package:dir` run). A stale or
 * missing binding fails deep inside the session backend, so refuse up front
 * with the exact command instead of launching a half-working app.
 */
function requireElectronNative() {
  const require = createRequire(import.meta.url)
  let fsExtRoot
  try {
    fsExtRoot = dirname(require.resolve('fs-ext/package.json'))
  } catch (cause) {
    throw new BlockedError(`fs-ext is not installed for the desktop package: ${cause instanceof Error ? cause.message : String(cause)}`, {
      remediation: 'corepack yarn install --immutable',
    })
  }
  const dir = join(fsExtRoot, 'prebuilds', `${osPlatform()}-${osArch()}`)
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => /^electron\.abi\d+\.node$/u.test(name)).sort()
    : []
  if (files.length === 0) {
    throw new BlockedError(
      `Electron-ABI fs-ext binding is missing under ${dir}; the app cannot lock sessions under Electron`,
      {
        remediation: 'corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native',
        directory: dir,
      },
    )
  }
  return {
    path: join(dir, files[0]),
    files,
    preparedBy: 'corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native (also run by dev/package:dir)',
  }
}

/** 只读复制生产模型设置；只取六个字段，api_key 永不打印。 */
function readProductionModelSettings(modelOverride) {
  if (!existsSync(PRODUCTION_SETTINGS_PATH)) {
    throw new BlockedError(`production model settings are missing: ${PRODUCTION_SETTINGS_PATH}`)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(PRODUCTION_SETTINGS_PATH, 'utf8'))
  } catch (cause) {
    throw new BlockedError(`production model settings are unreadable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BlockedError('production model settings are not a JSON object')
  }
  const models = Array.isArray(raw.models)
    ? raw.models
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : '',
        base_url: typeof entry.base_url === 'string' ? entry.base_url : '',
        model: typeof entry.model === 'string' ? entry.model : '',
        api_key: typeof entry.api_key === 'string' ? entry.api_key : '',
      }))
    : []
  const picked = {
    base_url: typeof raw.base_url === 'string' ? raw.base_url : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    api_key: typeof raw.api_key === 'string' ? raw.api_key : '',
    models,
    active_model_id: typeof raw.active_model_id === 'string' ? raw.active_model_id : '',
    allow_network: raw.allow_network !== false,
  }
  const active = models.find((entry) => entry.id === picked.active_model_id) ?? models[0]
  const credential = active?.api_key || picked.api_key
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new BlockedError('production model settings carry no api_key for the active model')
  }
  const productionModel = active?.model ?? picked.model
  const override = typeof modelOverride === 'string' && modelOverride !== '' ? modelOverride.trim() : null
  if (override !== null && override !== productionModel) {
    // The plan pins the walkthrough to `deepseek-chat`, which the production
    // settings may not list by id. Only the model *name* of the active entry is
    // changed; base_url and api_key stay untouched and are never printed.
    const baseUrl = active?.base_url || picked.base_url
    if (!baseUrl.startsWith('https://')) {
      throw new BlockedError(`--model ${override} needs an https provider base_url on the active entry`, { baseUrl })
    }
    if (models.length === 0) {
      throw new BlockedError(`--model ${override} needs a models[] entry to carry the override`)
    }
    const targetId = active?.id ?? picked.active_model_id
    for (const entry of models) {
      if (entry.id === targetId) entry.model = override
    }
    picked.model = override
  }
  registerSecrets([picked.api_key, ...models.map((entry) => entry.api_key)])
  return {
    settings: picked,
    summary: {
      activeModelId: active?.id ?? picked.active_model_id,
      providerName: active?.name ?? '',
      model: active?.model ?? picked.model,
      productionModel,
      modelOverride: override,
      modelSource: override === null
        ? 'copied from the production active entry'
        : `--model ${override} applied to the production active entry (base_url/api_key unchanged)`,
      baseUrl: active?.base_url ?? picked.base_url,
      apiKeyPresent: true,
      allowNetwork: picked.allow_network,
      modelCount: models.length,
    },
  }
}

function readConnection(path) {
  const connection = readJson(path)
  if (connection === undefined) throw new BlockedError(`catalog connection is missing or unreadable: ${path}`)
  if (typeof connection.baseUrl !== 'string' || !connection.baseUrl.startsWith('http://127.0.0.1:')) {
    throw new BlockedError('catalog connection baseUrl is not a loopback http URL', { baseUrl: String(connection.baseUrl) })
  }
  if (!Number.isSafeInteger(connection.port) || connection.port <= 0) throw new BlockedError('catalog connection port is invalid')
  if (typeof connection.readToken !== 'string' || connection.readToken.length === 0) throw new BlockedError('catalog connection readToken is missing')
  const keyring = connection.keyring
  if (keyring === null || typeof keyring !== 'object'
    || typeof keyring.keyId !== 'string' || typeof keyring.publicKeyHex !== 'string'
    || !Number.isSafeInteger(keyring.slot)) {
    throw new BlockedError('catalog connection keyring is invalid')
  }
  if (!Number.isSafeInteger(connection.pid) || connection.pid <= 0) throw new BlockedError('catalog connection pid is invalid')
  registerSecrets([connection.readToken])
  return connection
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

function prepareProfile({ homeDir, userDataDir, workspaceDir, sampleDir, models, connection }) {
  const versions = appVersions()
  const profileDir = join(homeDir, 'profiles', 'desktop')
  const parentDir = dirname(homeDir)
  mkdirSync(parentDir, { recursive: true })
  // A profile directory without package.json is treated as interrupted and
  // moved aside on launch; publish the shipped web template before seeding.
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(sampleDir, { recursive: true })
  writeFileSync(join(workspaceDir, 'README.md'), '# three agent packages acceptance workspace\n')
  runGit(['init', '-q'], workspaceDir)

  const flat = {
    base_url: models.base_url,
    model: models.model,
    api_key: models.api_key,
    models: models.models,
    active_model_id: models.active_model_id,
    allow_network: models.allow_network,
  }
  writeFileSync(join(parentDir, 'settings.json'), `${JSON.stringify(flat, null, 2)}\n`)
  writeFileSync(join(profileDir, 'huaanwork-settings.json'), `${JSON.stringify({
    theme: 'light',
    ...flat,
    // R9: never copy the production guard mode. The package child has no approval
    // UI, so ask-tier bash is denied by construction; the walkthrough pins smart.
    guard_mode: 'smart',
    automation_timeout_ms: 600_000,
    keep_awake: false,
    agents_host: '127.0.0.1',
    agents_port: connection.port,
    agents_catalog_token: connection.readToken,
    agents_catalog_publish_token: '',
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'agent-catalog-keyring.json'), `${JSON.stringify({
    schemaVersion: 1,
    keys: [{ keyId: connection.keyring.keyId, publicKeyHex: connection.keyring.publicKeyHex, slot: connection.keyring.slot }],
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // Empty state: the plaza cards must walk the real 未安装 → 下载 path.
  writeFileSync(join(profileDir, 'agents-state.json'), '{}\n')
  writeFileSync(join(profileDir, 'huaanwork-workspace.json'), `${JSON.stringify({
    pendingRoot: workspaceDir,
    writtenAt: new Date().toISOString(),
  })}\n`)

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

/**
 * R8 depth precheck on the same composition path the launcher uses:
 * `prepareDesktopProfile` -> `composeEntries` -> `SubagentRuntime.Config`.
 * Never reads `profileDir/settings.json` or the home settings document.
 * Requires the built `lib/profile.js` (parameter properties make a plain
 * import of `src/profile.ts` fail without `--experimental-transform-types`).
 */
async function requireMaxDepth(profileDir) {
  const { prepareDesktopProfile } = await import('../lib/profile.js')
  const { composeEntries } = await import('@deepseek-ai/dsh-app-boot')
  const { SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
  const home = dirname(dirname(profileDir))
  let prepared
  try {
    prepared = prepareDesktopProfile(undefined, home)
  } catch (cause) {
    throw new BlockedError(`prepareDesktopProfile failed for the isolated home: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const rows = composeEntries([prepared.patches])
  const row = rows.find((entry) => entry.id === 'subagent')
  if (row === undefined) throw new BlockedError('composed profile has no subagent row')
  let maxDepth
  try {
    maxDepth = SubagentRuntime.Config(row.config ?? {}).maxDepth.get()
  } catch (cause) {
    throw new BlockedError(`SubagentRuntime.Config rejected the composed subagent row: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!(typeof maxDepth === 'number' && maxDepth >= 2)) {
    throw new BlockedError(`effective subagent.maxDepth is ${String(maxDepth)}, below the two-level cap the lane dispatch needs`, {
      maxDepth,
      rowConfig: row.config ?? null,
      readPath: 'prepareDesktopProfile -> composeEntries([patches]) -> subagent row -> SubagentRuntime.Config(...).maxDepth.get()',
    })
  }
  return {
    maxDepth,
    readPath: 'prepareDesktopProfile -> composeEntries([patches]) -> subagent row -> SubagentRuntime.Config(...).maxDepth.get()',
    rowConfig: row.config ?? null,
  }
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

/**
 * Line-buffered redaction in front of `app-stdout.log` and the console: a secret
 * can straddle two chunks, so complete lines are redacted before they leave the
 * process (the brief's no-secret rule covers app logs too).
 */
function createRedactingSink(file, target) {
  let buffer = ''
  const emit = (text) => {
    const redacted = redactSecrets(text, SECRETS)
    file.write(redacted)
    target.write(redacted)
  }
  return {
    push(chunk) {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        emit(buffer.slice(0, index + 1))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    },
    end() {
      if (buffer !== '') { emit(buffer); buffer = '' }
    },
  }
}

async function launchApp({ homeDir, userDataDir, cdpPort, outDir }) {
  const require = createRequire(import.meta.url)
  const electronPath = require('electron')
  if (typeof electronPath !== 'string') throw new Error('electron package did not provide an executable path')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.DSH_HOME = homeDir
  env.DSH_TELEMETRY_DISABLED = '1'
  env.ELECTRON_ENABLE_LOGGING = '1'
  log(`launch electron ${electronPath} main=${MAIN_PATH}`)
  const child = spawn(electronPath, [
    MAIN_PATH,
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
  appLogFile = createWriteStream(join(outDir, 'app-stdout.log'), { flags: 'a' })
  const stdoutSink = createRedactingSink(appLogFile, process.stdout)
  const stderrSink = createRedactingSink(appLogFile, process.stderr)
  appStreamSinks = [stdoutSink, stderrSink]
  child.stdout?.on('data', (chunk) => stdoutSink.push(chunk))
  child.stderr?.on('data', (chunk) => stderrSink.push(chunk))
  child.once('exit', (code, signal) => {
    log(`electron exited code=${String(code)} signal=${String(signal)}`)
  })
  return child
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
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${clip(JSON.stringify(last), 1200)}`)
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

async function waitForComposerIdle(client, timeoutMs = COMPOSER_IDLE_TIMEOUT_MS) {
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

function clip(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

async function screenshot(client, name) {
  const captured = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (typeof captured?.data !== 'string' || captured.data === '') throw new Error(`screenshot ${name} was empty`)
  const bytes = Buffer.from(captured.data, 'base64')
  const path = join(options.outDir, name)
  writeFileSync(path, bytes)
  screenshots.push({ name, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
  log(`screenshot ${name} (${String(bytes.byteLength)} bytes)`)
}

/** Click a button matched by its exact trimmed text under a CSS root. */
async function clickButton(client, root, text) {
  const result = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(`${root} button`)})]
      .find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)})
    if (!button) return { ok: false, reason: 'button missing' }
    if (button.disabled) return { ok: false, reason: 'button disabled' }
    button.click()
    return { ok: true }
  })()`)
  return result
}

async function clickButtonOrThrow(client, root, text, label) {
  const result = await clickButton(client, root, text)
  if (result?.ok !== true) throw new Error(`${label}: could not click ${JSON.stringify(text)} (${result?.reason ?? 'unknown'})`)
}

async function dialogText(client) {
  return client.evaluate(`document.querySelector('.settings-overlay[role="dialog"]')?.textContent ?? ''`)
}

async function closeDetailDialog(client) {
  await clickButtonOrThrow(client, '.settings-overlay', '关闭', 'close detail')
  await waitFor('detail dialog closed', async () => {
    const open = await client.evaluate(`document.querySelector('.settings-overlay[role="dialog"]') !== null`)
    return { ok: open === false, value: open }
  }, 10_000, 100)
}

const CARDS_EXPRESSION = `(() => [...document.querySelectorAll('.subagent-run-card')].map((card) => ({
  label: (card.querySelector('.subagent-run-label')?.textContent ?? '').trim(),
  phase: card.getAttribute('data-phase'),
  status: (card.querySelector('.subagent-run-status')?.textContent ?? '').trim(),
  text: (card.textContent ?? '').replace(/\\s+/g, ' ').trim(),
})))()`

async function parentReplyAfter(client, text, timeoutMs = PARENT_REPLY_TIMEOUT_MS) {
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
    if (typeof last?.reply === 'string' && last.reply !== '') return { observed: true, text: last.reply }
    await delay(500)
  }
  return { observed: false, text: null }
}

/**
 * The dispatch session is a fresh 新建任务 tab whose workspace root is minted on
 * first send (`<profile>/workspace-sessions/<sessionId>`). The samples must live
 * INSIDE that root for the workspace-bound read/glob/grep policy to admit them.
 * The root id is only known after the first send, so the prompts reference the
 * samples by the relative folder `samples`; right after the first send we discover
 * the minted root and copy the staged samples into `<root>/samples`. The host mints
 * the directory in session.new before it processes the message, and the model's
 * first tool call comes a full LLM round-trip later, so the copy lands well before
 * any read/glob. `ctx.sessionRoot` records the discovered root for the post-hoc
 * header-cwd check; a lost race would surface as a denied read and FAIL honestly.
 */
async function placeSamplesInDispatchRoot(ctx) {
  const before = new Set(ctx.sessionDirsBefore)
  const deadline = Date.now() + 15_000
  let root
  while (Date.now() < deadline) {
    let entries = []
    try {
      entries = readdirSync(ctx.sessionsBaseDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    const fresh = entries.filter((entry) => entry.isDirectory() && !before.has(entry.name))
    if (fresh.length === 1) {
      root = join(ctx.sessionsBaseDir, fresh[0].name)
      break
    }
    if (fresh.length > 1) throw new Error(`expected one new dispatch session root, found ${String(fresh.length)}`)
    await delay(50)
  }
  if (root === undefined) throw new Error(`no new dispatch session root appeared under ${ctx.sessionsBaseDir} within 15s`)
  ctx.sessionRoot = root
  ctx.sessionSampleDir = join(root, 'samples')
  cpSync(ctx.stagingSampleDir, ctx.sessionSampleDir, { recursive: true })
  log(`samples placed in dispatch session root ${root}`)
}

async function runPackage(client, ctx, slug) {
  const prompt = ctx.prompts[slug]
  await waitForComposerIdle(client)
  log(`dispatch ${slug}: ${clip(prompt, 200)}`)
  await sendText(client, prompt)
  if (ctx.sessionRoot === undefined) await placeSamplesInDispatchRoot(ctx)
  const completedAt = await waitFor(`run card ${slug}`, async () => {
    const cards = await client.evaluate(CARDS_EXPRESSION)
    const match = cards.filter((card) => card.label.includes(`@${slug}`))
    const dead = match.find((card) => card.phase === 'failed' || card.phase === 'stopped')
    if (dead) throw new Error(`run card ${slug} 进入终态 ${dead.phase}: ${clip(dead.text, 400)}`)
    const done = match.find((card) => card.phase === 'completed')
    return { ok: !!done, value: done === undefined ? null : { ...done, at: Date.now() } }
  }, ctx.timeout, 1000)
  const reply = await parentReplyAfter(client, prompt, ctx.replyTimeout)
  await waitForComposerIdle(client, 120_000)
  await screenshot(client, `06-run-${slug}.png`)
  return {
    slug,
    label: `@${slug}`,
    terminalPhase: 'completed',
    terminalStatus: completedAt.status,
    completedAtWallMs: completedAt.at,
    replyObserved: reply.observed,
    replyExcerpt: clip(reply.text ?? '', 1500),
  }
}

async function drive(client, ctx) {
  const facts = progress
  const shot = (name) => screenshot(client, name)

  // 1. 进入智能体广场：先捕获三张卡（slug + displayName）并落 facts，再开始任何安装；
  //    缺卡或名称不符即 FAIL。
  await client.evaluate(`document.querySelector('button[title="智能体"]').click()`)
  const PLAZA_CARDS = `[...document.querySelectorAll('.agent-plaza-panel .skill-card[data-slug]')]
    .map((element) => ({ slug: element.dataset.slug, name: (element.querySelector('.nm')?.textContent ?? '').trim() }))`
  await waitFor('plaza cards', async () => {
    const cards = await client.evaluate(PLAZA_CARDS)
    const missing = SLUGS.filter((slug) => !Array.isArray(cards) || !cards.some((card) => card.slug === slug))
    return { ok: missing.length === 0, value: cards }
  }, ctx.timeout, 500)
  const plazaCards = await client.evaluate(PLAZA_CARDS)
  for (const slug of SLUGS) {
    const matches = plazaCards.filter((candidate) => candidate.slug === slug)
    if (matches.length !== 1) throw new Error(`广场卡 ${slug} 命中 ${String(matches.length)} 张（期望 1）`)
    if (matches[0].name !== DISPLAY_NAMES[slug]) {
      throw new Error(`广场 ${slug} displayName 不符: ${JSON.stringify(matches[0].name)}（期望 ${JSON.stringify(DISPLAY_NAMES[slug])}）`)
    }
  }
  // `facts.plaza` is the same array instance main pre-published; mutate in place so
  // the later report keeps the cards (replacing the reference leaves it empty).
  progress.plaza.splice(0, progress.plaza.length, ...plazaCards)
  await shot('01-plaza.png')

  // 2. 未安装详情：只有包信息 + INSTALL_DETAIL_NOTICE（无签名/文件清单）。
  // 按钮按文案匹配：DOM 顺序是 [查看详情, spacer, 下载]，位置选择器（:last-child 等）会点错。
  for (const slug of SLUGS) {
    await clickButtonOrThrow(
      client,
      `.agent-plaza-panel .skill-card[data-slug="${slug}"] .agent-package-actions`,
      '查看详情',
      `detail ${slug}`,
    )
    const text = await waitFor(`detail ${slug}`, async () => {
      const current = await dialogText(client)
      return { ok: current.includes(INSTALL_DETAIL_NOTICE), value: current }
    }, 30_000, 300)
    if (text.includes('验签结果')) throw new Error(`未安装详情 ${slug} 伪造了验签结果`)
    await shot(`02-detail-pre-${slug}.png`)
    await closeDetailDialog(client)
  }

  // 3. 下载 ×3（直接按钮，无确认对话框）。
  for (const slug of SLUGS) {
    await clickButtonOrThrow(
      client,
      `.agent-plaza-panel .skill-card[data-slug="${slug}"] .agent-package-actions`,
      '下载',
      `install ${slug}`,
    )
    await waitFor(`install note ${slug}`, async () => {
      const text = await client.evaluate(`document.body.textContent`)
      return { ok: text.includes(`已下载「${DISPLAY_NAMES[slug]}」`), value: true }
    }, 60_000, 500)
    facts.installs.push(slug)
  }
  await shot('03-after-install.png')

  // 4. 我的智能体 → 启用 ×3。
  await client.evaluate(`[...document.querySelectorAll('.filter-tab')].find((button) => button.textContent.includes('我的智能体'))?.click()`)
  for (const slug of SLUGS) {
    await waitFor(`enable button ${slug}`, async () => {
      const ok = await client.evaluate(`!![...document.querySelectorAll('.agent-packages-panel .skill-card[data-slug="${slug}"] button')].find((button) => (button.textContent ?? '').trim() === '启用')`)
      return { ok, value: ok }
    }, 30_000, 300)
    await clickButtonOrThrow(client, `.agent-packages-panel .skill-card[data-slug="${slug}"]`, '启用', `enable ${slug}`)
    await waitFor(`enable note ${slug}`, async () => {
      const text = await client.evaluate(`document.body.textContent`)
      return { ok: text.includes(`已启用「${DISPLAY_NAMES[slug]}」`), value: true }
    }, 30_000, 500)
    facts.enables.push(slug)
  }
  await shot('04-enabled.png')

  // 5. 已安装详情：验签结果：通过 + 工具「无」+ 沙箱警告。
  for (const slug of SLUGS) {
    await clickButtonOrThrow(
      client,
      `.agent-packages-panel .skill-card[data-slug="${slug}"] .agent-package-actions`,
      '查看详情',
      `installed detail ${slug}`,
    )
    await waitFor(`installed detail ${slug}`, async () => {
      const text = await dialogText(client)
      return { ok: text.includes('验签结果：通过') && text.includes(PACKAGE_SANDBOX_WARNING), value: text }
    }, 30_000, 300)
    const detail = await client.evaluate(`(() => {
      const overlay = document.querySelector('.settings-overlay[role="dialog"]')
      const title = overlay?.getAttribute('aria-label') ?? ''
      const sections = [...document.querySelectorAll('.settings-overlay .agent-detail-section')].map((section) => ({
        label: section.querySelector('strong')?.textContent ?? '',
        text: section.textContent ?? '',
        tools: section.querySelector('p')?.textContent?.trim() ?? '',
        files: section.querySelectorAll('li').length,
      }))
      const tools = sections.find((section) => section.label === '工具')
      const files = sections.find((section) => section.label.startsWith('文件'))
      return { title, tools: tools?.tools ?? null, toolSectionText: tools?.text ?? '', fileCount: files?.files ?? 0 }
    })()`)
    if (detail.tools !== '无') throw new Error(`${slug} 详情工具行不是「无」: ${JSON.stringify(detail.tools)}`)
    if (!(detail.fileCount > 0)) throw new Error(`${slug} 详情文件清单为空`)
    if (!detail.title.includes(`智能体详情：${DISPLAY_NAMES[slug]}`)) throw new Error(`${slug} 详情标题不符: ${detail.title}`)
    facts.details.push({
      slug,
      verified: true,
      sandboxWarning: true,
      tools: detail.tools,
      fileCount: detail.fileCount,
      dialogTitle: detail.title,
    })
    await shot(`05-detail-post-${slug}.png`)
    await closeDetailDialog(client)
  }

  // 6. 回到聊天：新建任务一次（导航回主视图并铸造派发会话），三包共用该会话。
  //    样例在该会话首次发送后放入其新根（见 placeSamplesInDispatchRoot）。
  let sessionDirsBefore = []
  try {
    sessionDirsBefore = readdirSync(ctx.sessionsBaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    sessionDirsBefore = []
  }
  ctx.sessionDirsBefore = sessionDirsBefore
  await client.evaluate(`document.querySelector('button[title="新建任务"]').click()`)
  await waitForComposerIdle(client)
  for (const slug of SLUGS) {
    facts.runs.push(await runPackage(client, ctx, slug))
  }
  return facts
}

/* ------------------------------------------------------------------------- *
 * Lane observation (deterministic session identity; no text search, no counts)
 * ------------------------------------------------------------------------- */

function walkFiles(dir, name, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, name, out)
    else if (entry.name === name) out.push(path)
  }
  return out
}

/** zstd CLI multi-frame decode; a truncated trailing frame keeps the complete prefix. */
function decodeZstdFile(path) {
  const result = spawnSync('zstd', ['-dc', path], { maxBuffer: 256 * 1024 * 1024 })
  if (result.error !== undefined) throw new Error(`zstd failed for ${path}: ${result.error.message}`)
  const text = result.stdout?.toString('utf8') ?? ''
  if (text.length === 0 && result.status !== 0) {
    throw new Error(`zstd produced no output for ${path}: ${result.stderr?.toString('utf8') ?? ''}`)
  }
  return { text, warning: result.status === 0 ? undefined : `zstd exited ${String(result.status)} (truncated tail tolerated)` }
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function isSubagentHeader(header) {
  return header.origin === 'subagent'
}

function loadSessions(homeDir) {
  const root = join(homeDir, 'sessions')
  const files = walkFiles(root, 'session.v4.jsonl.zstd').sort()
  const sessions = []
  for (const file of files) {
    const decoded = decodeZstdFile(file)
    const lines = decoded.text.split('\n').filter((line) => line.trim() !== '')
    let header
    const events = []
    for (const [index, line] of lines.entries()) {
      let value
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (index === 0 && value?.type === 'session') {
        header = value
        continue
      }
      if (value !== null && typeof value === 'object') events.push(value)
    }
    if (header === undefined) continue
    sessions.push({ file, header, events, warning: decoded.warning })
  }
  return sessions
}

function lastAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = messageText(event.data?.message)
    if (text.trim() !== '') return { text, time: event.time }
  }
  return undefined
}

/** The provider/model the app actually requested, from the session's first header. */
function requestHeaderConfig(session) {
  for (const event of session.events) {
    if (event?.type !== 'request/header') continue
    const config = event.data?.header?.config
    if (config === null || typeof config !== 'object') continue
    return {
      provider: typeof config.provider === 'string' ? config.provider : null,
      model: typeof config.model === 'string' ? config.model : null,
      reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
    }
  }
  return null
}

/**
 * The parent session's user message is the remainder plus the host instruction
 * (the launcher strips the `@slug` prefix before appending, verified against a
 * real log). The remainder contains the unique sample path, so this prefix match
 * is deterministic and cannot hit the package child (its message starts with the
 * persona and `用户请求：`).
 */
function findParentSessions(sessions, remainder) {
  const needle = `${remainder}\n\n<host-instruction>`
  return sessions.filter((session) => !isSubagentHeader(session.header)
    && session.events.some((event) => event?.type === 'user/message' && messageText(event.data).startsWith(needle)))
}

/**
 * All three packages dispatch in the SAME session, so the depth-1 children
 * under one parent must be attributed by dispatch content: the package child
 * carries `persona + 用户请求：\n + remainder` (host.ts dispatch) in one of its
 * user messages. The FIRST user message is a synthetic cwd-change notice, so the
 * match scans ALL user messages, not just the first. The remainder carries the
 * unique sample path / planning text per slug.
 */
function packageChildSessions(sessions, parentId, remainder) {
  const needle = remainder.trim()
  return sessions.filter((session) => {
    if (session.header.parentSession !== parentId || session.header.origin !== 'subagent' || session.header.delegationDepth !== 1) return false
    return session.events.some((event) => {
      if (event?.type !== 'user/message') return false
      const text = messageText(event.data)
      return text.includes('用户请求：') && text.includes(needle)
    })
  })
}

const SAMPLE_ACCESS_TOOLS = new Set(['read', 'read_file', 'glob', 'grep'])

/**
 * Workspace-bound sample access: the child must reach the samples through
 * read/glob/grep (non-error result), not only through bash. A bash-only child
 * means the samples were outside the session workspace (the final-review
 * finding) or the model ignored the SKILL enumeration step.
 */
function sampleAccessFacts(child, samplePaths) {
  const results = new Map()
  for (const event of child.events) {
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.toolCallId
    if (typeof callId === 'string') results.set(callId, event)
  }
  const calls = []
  for (const event of child.events) {
    if (event?.type !== 'tool/call' || !SAMPLE_ACCESS_TOOLS.has(event.data?.name)) continue
    const args = typeof event.data?.arguments === 'string' ? event.data.arguments : ''
    if (!samplePaths.some((path) => args.includes(path))) continue
    const callId = event.data?.callId
    const result = typeof callId === 'string' ? results.get(callId) : undefined
    calls.push({
      name: event.data.name,
      callId: typeof callId === 'string' ? callId : null,
      argumentsExcerpt: clip(args, 400),
      resultFound: result !== undefined,
      isError: result === undefined ? null : result.data?.message?.isError === true,
      resultExcerpt: clip(messageText(result?.data?.message), 300),
    })
  }
  const successful = calls.filter((call) => call.resultFound === true && call.isError === false)
  return { calls, successfulCount: successful.length, ok: successful.length > 0 }
}

function settlementDeliveries(session) {
  const deliveries = []
  for (const event of session.events) {
    let messages = null
    if (event?.type === 'user/message') messages = [event.data]
    else if (event?.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) messages = event.data.inserted
    if (messages === null) continue
    for (const message of messages) {
      if (message?.source?.kind !== 'subagent-settled') continue
      deliveries.push({
        at: event.time,
        via: event.type,
        laneId: message.source.senderSessionId,
        text: messageText(message),
      })
    }
  }
  return deliveries
}

function subagentCallFacts(session) {
  const results = new Map()
  for (const event of session.events) {
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.toolCallId
    if (typeof callId === 'string') results.set(callId, event)
  }
  const calls = []
  for (const event of session.events) {
    if (event?.type !== 'tool/call' || event.data?.name !== 'subagent') continue
    const callId = event.data?.callId
    const result = typeof callId === 'string' ? results.get(callId) : undefined
    const content = messageText(result?.data?.message)
    const started = /started subagent ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(content)
    calls.push({
      callId: typeof callId === 'string' ? callId : null,
      at: event.time,
      argumentsExcerpt: clip(typeof event.data?.arguments === 'string' ? event.data.arguments : '', 600),
      resultFound: result !== undefined,
      isError: result === undefined ? null : result.data?.message?.isError === true,
      resultAt: result?.time,
      resultExcerpt: clip(content, 600),
      dispatchedLaneId: started?.[1] ?? null,
    })
  }
  return calls
}

/**
 * Cleanup-budget evidence is only valid when the host actually wrote logs. The
 * trip line (`host.ts` console.error 「分钟内未结束」) travels over Electron
 * stderr into `<out>/app-stdout.log`, NOT into `<userData>/logs`; scanning only
 * the latter is vacuous (final-review finding). Both channels are scanned and
 * per-file match counts are recorded. Zero scanned files fails the run instead
 * of reporting a silent zero.
 */
function scanAppLogs(roots) {
  const result = { roots, files: 0, scannedFiles: [], cleanupBudgetScan: 'no-log-files', cleanupBudgetTrips: 0, cleanupBudgetLines: [], packageErrors: 0, catalogErrors: 0 }
  const scanFile = (path) => {
    let text = ''
    try {
      const stat = statSync(path)
      if (stat.size > 40 * 1024 * 1024) return
      text = readFileSync(path, 'utf8')
    } catch {
      return
    }
    const counts = { path, cleanupBudgetTrips: 0, packageErrors: 0, catalogErrors: 0 }
    result.files += 1
    for (const line of text.split('\n')) {
      if (line.includes('分钟内未结束')) {
        counts.cleanupBudgetTrips += 1
        result.cleanupBudgetTrips += 1
        if (result.cleanupBudgetLines.length < 5) result.cleanupBudgetLines.push(clip(redactSecrets(line, SECRETS), 500))
      }
      if (line.includes('智能体「') && line.includes('失败')) {
        counts.packageErrors += 1
        result.packageErrors += 1
      }
      if (line.includes('[agent-catalog]') && line.includes('失败')) {
        counts.catalogErrors += 1
        result.catalogErrors += 1
      }
    }
    result.scannedFiles.push(counts)
  }
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!/\.(log|jsonl|txt)$/u.test(entry.name)) continue
      scanFile(path)
    }
  }
  for (const root of roots) {
    let stat
    try {
      stat = statSync(root)
    } catch {
      continue
    }
    if (stat.isDirectory()) visit(root)
    else scanFile(root)
  }
  result.cleanupBudgetScan = result.files > 0 ? 'scanned' : 'no-log-files'
  return result
}

/**
 * Affirmative depth-degradation claims only. A model that reports "未降级为单会话
 * 多轮自审" / "未触发深度降级" is describing the healthy path, and the typo-check
 * package always discloses the R1 same-model cross-validation downgrade
 * ("交叉验证已降级") — neither is a depth degradation. The affirmative set
 * therefore requires an explicit depth/lane phrase, not a bare `降级` or a bare
 * `maxDepth` mention.
 */
function reportsDepthDegradation(text) {
  const stripped = text
    .replace(/(?:未|并未|没有|不会|不能|无|不)(?:发生|出现|进行|被|触发|涉及|采用)?\s*[*_]{0,4}(?:递归)?(?:深度)?降级/gu, '')
    .replace(/(?:未|并未|没有|不会|不能|无|不)[^。；\n]{0,10}深度不足/gu, '')
    .replace(/(?:并非|不是|非)\s*[*_]{0,4}单会话多轮自审/gu, '')
  return /(?:递归)?深度不足|单会话多轮自审|非双盲|SubagentDepthError|降级为单会话|已降级为单会话|深度降级/u.test(stripped)
}

function observeLanes({ homeDir, remainder, slug, runCardCompletedAt, appLogs }) {
  const sessions = loadSessions(homeDir)
  const parents = findParentSessions(sessions, remainder)
  if (parents.length !== 1) {
    throw new BlockedError(
      `identity chain: expected exactly one parent session carrying the ${slug} dispatch remainder, found ${String(parents.length)}`,
      { candidates: parents.map((session) => session.header.id) },
    )
  }
  const parent = parents[0]
  const parentId = parent.header.id
  const children = packageChildSessions(sessions, parentId, remainder)
  if (children.length !== 1) {
    const allDepth1 = sessions.filter((session) => session.header.parentSession === parentId
      && session.header.origin === 'subagent' && session.header.delegationDepth === 1)
    throw new BlockedError(
      `identity chain: expected exactly one package child (depth 1) carrying the ${slug} dispatch remainder under ${String(parentId)}, found ${String(children.length)}`,
      {
        children: children.map((session) => session.header.id),
        needle: remainder.trim(),
        depth1Candidates: allDepth1.map((session) => {
          const userTexts = session.events.filter((event) => event?.type === 'user/message').map((event) => messageText(event.data))
          const dispatch = userTexts.find((text) => text.includes('用户请求：')) ?? ''
          return { id: session.header.id, origin: session.header.origin, depth: session.header.delegationDepth, dispatchExcerpt: clip(dispatch, 300), hasMarker: dispatch.includes('用户请求：'), hasNeedle: userTexts.some((text) => text.includes(remainder.trim())) }
        }),
      },
    )
  }
  const child = children[0]
  const childId = child.header.id
  const laneSessions = sessions.filter((session) => session.header.parentSession === childId
    && session.header.origin === 'subagent'
    && session.header.delegationDepth === 2)
  const laneIds = laneSessions.map((session) => session.header.id)
  const laneIdSet = new Set(laneIds)

  const calls = subagentCallFacts(child)
  const distinctCallIds = new Set(calls.map((call) => call.callId).filter((id) => id !== null))
  const goodCalls = calls.filter((call) => call.resultFound === true && call.isError === false)
  const errorCalls = calls.filter((call) => call.resultFound === true && call.isError === true)
  const missingCalls = calls.filter((call) => call.resultFound !== true)
  const deliveries = settlementDeliveries(child)
  const laneDeliveries = deliveries.filter((delivery) => laneIdSet.has(delivery.laneId))
  const deliveredLaneIds = new Set(laneDeliveries.map((delivery) => delivery.laneId))

  const laneFacts = laneSessions.map((session) => {
    const final = lastAssistantText(session.events)
    const delivery = laneDeliveries.find((item) => item.laneId === session.header.id)
    const times = session.events.map((event) => (typeof event.time === 'number' ? event.time : 0))
    const lastEventAt = Math.max(session.header.createdAt ?? 0, ...times)
    return {
      id: session.header.id,
      createdAt: session.header.createdAt,
      delegationDepth: session.header.delegationDepth,
      origin: session.header.origin,
      eventCount: session.events.length,
      lastEventAt,
      durationMs: lastEventAt - (session.header.createdAt ?? lastEventAt),
      finalTextExcerpt: clip(final?.text ?? '', 1200),
      finalTextLength: final?.text.length ?? 0,
      settlementDelivered: delivery !== undefined,
      settlementAt: delivery?.at,
      settlementVia: delivery?.via,
      settlementLeftNoClosingMessage: /left no closing message/iu.test(delivery?.text ?? ''),
      settlementExcerpt: clip(delivery?.text ?? '', 1500),
    }
  })

  const childFinal = lastAssistantText(child.events)
  const childTimes = child.events.map((event) => (typeof event.time === 'number' ? event.time : 0))
  const childLastEventAt = Math.max(child.header.createdAt ?? 0, ...childTimes)
  const deliveryTimes = laneDeliveries.map((delivery) => delivery.at ?? 0)
  const lastDeliveryAt = deliveryTimes.length > 0 ? Math.max(...deliveryTimes) : undefined
  const arbitrationText = [childFinal?.text ?? '', lastAssistantText(parent.events)?.text ?? ''].join('\n')
  const honestDegradation = reportsDepthDegradation(arbitrationText)

  const lanesDelivered = laneFacts.length === 2
    && deliveredLaneIds.size === 2
    && laneFacts.every((lane) => lane.settlementDelivered && !lane.settlementLeftNoClosingMessage && lane.finalTextLength > 0)
  const ok = lanesDelivered
    && goodCalls.length >= 2
    && distinctCallIds.size >= 2
    && errorCalls.length === 0
    && missingCalls.length === 0
    && !honestDegradation
  const reasons = []
  if (laneFacts.length !== 2) reasons.push(`lane sessions = ${String(laneFacts.length)} (expected 2)`)
  if (deliveredLaneIds.size !== 2) reasons.push(`lanes with a settlement delivery = ${String(deliveredLaneIds.size)} (expected 2)`)
  if (!laneFacts.every((lane) => lane.finalTextLength > 0)) reasons.push('at least one lane produced no closing text')
  if (laneFacts.some((lane) => lane.settlementLeftNoClosingMessage)) reasons.push('a settlement reported no closing message')
  if (goodCalls.length < 2) reasons.push(`non-error subagent dispatches = ${String(goodCalls.length)} (expected >= 2)`)
  if (distinctCallIds.size < 2) reasons.push(`distinct subagent callIds = ${String(distinctCallIds.size)} (expected >= 2)`)
  if (errorCalls.length > 0) reasons.push(`subagent dispatch error results = ${String(errorCalls.length)}`)
  if (missingCalls.length > 0) reasons.push(`subagent calls without a result = ${String(missingCalls.length)}`)
  if (honestDegradation) reasons.push('the model text reports an honest depth degradation')

  return {
    parentSessionId: parentId,
    childId,
    childCreatedAt: child.header.createdAt,
    childLastEventAt,
    parentRequestHeader: requestHeaderConfig(parent),
    childRequestHeader: requestHeaderConfig(child),
    childFinalTextExcerpt: clip(childFinal?.text ?? '', 4096),
    calls,
    distinctCallIdCount: distinctCallIds.size,
    goodCallCount: goodCalls.length,
    errorCallCount: errorCalls.length,
    missingCallCount: missingCalls.length,
    laneSessions: laneFacts,
    deliveries,
    arbitrationAfterLastDelivery: lastDeliveryAt !== undefined && (childFinal?.time ?? 0) > lastDeliveryAt,
    lastDeliveryAt,
    runCardCompletedAtWallMs: runCardCompletedAt,
    childAliveMsAtCardCompletion: runCardCompletedAt - (child.header.createdAt ?? runCardCompletedAt),
    cleanupBudgetMs: HOST_CLEANUP_BUDGET_MS,
    cleanupBudgetScan: appLogs?.cleanupBudgetScan ?? 'no-log-files',
    cleanupBudgetFiles: appLogs?.files ?? 0,
    cleanupBudgetRoots: appLogs?.roots ?? [],
    cleanupBudgetScannedFiles: appLogs?.scannedFiles ?? [],
    cleanupBudgetTrippedInAppLogs: (appLogs?.cleanupBudgetTrips ?? 0) > 0,
    cleanupBudgetLines: appLogs?.cleanupBudgetLines ?? [],
    honestDegradation,
    dualBlindOk: ok,
    dualBlindReasons: reasons,
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

async function run() {
  mkdirSync(options.outDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const versions = appVersions()
  const build = requireFreshBuild()
  const nativeBinding = requireElectronNative()
  requireZstd()
  const connection = readConnection(resolve(options.connection))
  catalogPid = connection.pid
  const models = readProductionModelSettings(options.model)
  if (process.platform !== 'darwin') {
    throw new BlockedError('the docx sample and this walkthrough are macOS-only (textutil)', { platform: process.platform })
  }

  tempRoot = mkdtempSync(join(tmpdir(), 'huaanwork-three-packages-'))
  const homeDir = join(tempRoot, 'dsh-home', '.huaanwork')
  userDataDir = join(tempRoot, 'user-data')
  const workspaceDir = join(tempRoot, 'workspace')
  const sampleDir = join(workspaceDir, 'samples')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  log(`isolated root ${tempRoot}`)

  const prepared = prepareProfile({ homeDir, userDataDir, workspaceDir, sampleDir, models: models.settings, connection })
  catalogUsed = true
  await writeAuthState(prepared.profileDir)
  const precheck = await requireMaxDepth(prepared.profileDir)
  log(`precheck: subagent.maxDepth=${String(precheck.maxDepth)} guard_mode=smart model=${models.summary.model}`)

  const sampleDocx = makeSampleDocx(sampleDir)
  const sampleCode = makeSampleCode(sampleDir)
  isolated = {
    homeDir,
    profileDir: prepared.profileDir,
    workspaceDir,
    sampleDir,
    sampleDocx,
    sampleCode,
    userDataDir,
  }

  // Relative sample references: the dispatch session root is minted on first
  // send, so the samples are addressed relative to that root (`samples/...`)
  // and copied into it right after the first send (placeSamplesInDispatchRoot).
  const prompts = {
    'typo-check': '@typo-check 检测这个文件夹里的 Word 文档：samples',
    'code-review': '@code-review 审查这个文件：samples/sample-review.js',
    'task-orch': '@task-orch 把「为市场模块增加离线缓存」拆解为可实施的执行计划，给出依赖、每步验收标准与调度建议。工作区样例目录：samples（先用 glob/read 查看工作区内容；样例文件不是市场模块代码，计划中的代码事实仍须标注待核实，不得编造项目事实）。',
  }

  // Published before launch so a later failure still leaves a usable report.
  facts = {
    schemaVersion: 1,
    outcome: 'PENDING',
    startedAt,
    environment: {
      platform: process.platform,
      arch: osArch(),
      release: osRelease(),
      node: process.version,
      desktopVersion: versions.desktop,
      dshVersion: versions.dsh,
      headSha: runGit(['rev-parse', 'HEAD'], REPO_ROOT),
      branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT),
      harnessPin: runGit(['rev-parse', 'HEAD'], join(REPO_ROOT, 'deepseek-harness')),
      electronVersion: readJson(join(PACKAGE_ROOT, 'node_modules', 'electron', 'package.json'))?.version ?? '',
    },
    appEntry: {
      launched: 'electron lib/main.js (the same entry bin.js spawns) with CDP flags; bin.js forwards no extra flags',
      mainPath: MAIN_PATH,
      build,
      nativeBinding,
    },
    connection: {
      path: resolve(options.connection),
      baseUrl: connection.baseUrl,
      port: connection.port,
      pid: connection.pid,
      keyringKeyId: connection.keyring.keyId,
    },
    precheck: {
      maxDepth: precheck.maxDepth,
      guardMode: 'smart',
      guardModeSource: 'explicitly written by this script (R9); production value not copied',
      model: models.summary,
      readPath: precheck.readPath,
      rowConfig: precheck.rowConfig,
    },
    isolated,
    isolatedRoot: tempRoot,
    keepRoot: options.keepRoot,
    keepCatalogRoot: options.keepCatalogRoot,
    plaza: progress.plaza,
    installs: progress.installs,
    enables: progress.enables,
    details: progress.details,
    runs: progress.runs,
    lane: null,
    modelOutputs: null,
    dispatchRootChecks: null,
    appLogs: null,
    screenshotDir: options.outDir,
    screenshots,
    errors: [],
    blocked: null,
  }

  const cdpPort = await freePort()
  const appStartedAt = Date.now()
  appProcess = await launchApp({ homeDir, userDataDir, cdpPort, outDir: options.outDir })
  appCdp = await connectAppPage(cdpPort, options.timeout)
  await ensureLoggedIn(appCdp)
  await screenshot(appCdp, '00-app-ready.png')
  log(`app ready after ${String(Date.now() - appStartedAt)}ms (cdp ${String(cdpPort)})`)

  const driveCtx = {
    timeout: options.timeout,
    replyTimeout: Math.min(PARENT_REPLY_TIMEOUT_MS, options.timeout),
    prompts,
    sessionsBaseDir: join(prepared.profileDir, 'workspace-sessions'),
    stagingSampleDir: sampleDir,
    sessionRoot: undefined,
    sessionSampleDir: undefined,
    sessionDirsBefore: [],
  }
  const driven = await drive(appCdp, driveCtx)

  const typoRun = driven.runs.find((item) => item.slug === 'typo-check')
  // Two channels: the host file logs AND the Electron stdout/stderr capture
  // (the cleanup-budget trip line is a console.error → app-stdout.log).
  const appLogs = scanAppLogs([join(userDataDir, 'logs'), join(options.outDir, 'app-stdout.log')])
  const lane = observeLanes({
    homeDir,
    remainder: prompts['typo-check'].replace(/^@typo-check\s+/u, ''),
    slug: 'typo-check',
    runCardCompletedAt: typoRun?.completedAtWallMs ?? Date.now(),
    appLogs,
  })
  log(`lane chain: child=${lane.childId} lanes=${lane.laneSessions.map((item) => item.id).join(',')} dualBlindOk=${String(lane.dualBlindOk)}`)

  // Final model text per package, captured from the session logs for the Step 6
  // human review. `finalTextExcerpt` prefers the package child (depth 1) because
  // the parent may answer "waiting for the child" before the child settles.
  // All three packages share the dispatch session, so children are attributed by
  // dispatch remainder (packageChildSessions), and each child must show a
  // successful workspace-bound read/glob on the sample paths.
  const sessions = loadSessions(homeDir)
  // The prompts reference the samples relatively (`samples/...`); match that
  // marker plus the absolute discovered path so either form counts.
  const samplePaths = ['samples', driveCtx.sessionSampleDir].filter((path) => typeof path === 'string')
  const dispatchRoot = driveCtx.sessionRoot
  const modelOutputs = {}
  const dispatchRootChecks = []
  const sampleAccessFailures = []
  for (const slug of SLUGS) {
    const remainder = prompts[slug].replace(new RegExp(`^@${slug}\\s+`, 'u'), '')
    const parents = findParentSessions(sessions, remainder)
    const parent = parents.length === 1 ? parents[0] : undefined
    const childCandidates = parent === undefined ? [] : packageChildSessions(sessions, parent.header.id, remainder)
    const child = childCandidates.length === 1 ? childCandidates[0] : undefined
    const parentFinal = parent === undefined ? undefined : lastAssistantText(parent.events)
    const childFinal = child === undefined ? undefined : lastAssistantText(child.events)
    const final = childFinal ?? parentFinal
    const sampleAccess = child === undefined
      ? { calls: [], successfulCount: 0, ok: false }
      : sampleAccessFacts(child, samplePaths)
    if (!sampleAccess.ok) sampleAccessFailures.push(slug)
    const headerCwd = typeof parent?.header?.cwd === 'string' ? parent.header.cwd : null
    dispatchRootChecks.push({ slug, parentSessionId: parent?.header.id ?? null, headerCwd, expectedRoot: dispatchRoot ?? null, ok: headerCwd !== null && dispatchRoot !== undefined && canonicalPath(headerCwd) === canonicalPath(dispatchRoot) })
    modelOutputs[slug] = {
      parentSessionId: parent?.header.id ?? null,
      parentCandidates: parents.length,
      packageChildId: child?.header.id ?? null,
      packageChildCandidates: childCandidates.length,
      parentRequestHeader: parent === undefined ? null : requestHeaderConfig(parent),
      packageChildRequestHeader: child === undefined ? null : requestHeaderConfig(child),
      finalTextSource: childFinal === undefined ? (parentFinal === undefined ? 'none' : 'parent-final') : 'package-child-final',
      finalTextLength: final?.text.length ?? 0,
      finalTextExcerpt: clip(final?.text ?? '', MODEL_OUTPUT_EXCERPT_CHARS),
      parentFinalTextLength: parentFinal?.text.length ?? 0,
      parentFinalTextExcerpt: clip(parentFinal?.text ?? '', MODEL_OUTPUT_EXCERPT_CHARS),
      sampleAccess,
    }
  }

  const failures = []
  for (const run of driven.runs) {
    if (run.terminalPhase !== 'completed') failures.push(`run ${run.slug} ended ${run.terminalPhase}`)
  }
  if (!lane.dualBlindOk) failures.push(`dual-blind lane criteria not met: ${lane.dualBlindReasons.join('; ')}`)
  for (const check of dispatchRootChecks) {
    if (!check.ok) failures.push(`dispatch root ${check.slug}: parent header cwd ${String(check.headerCwd)} is not the sample workspace ${check.expectedRoot}`)
  }
  if (sampleAccessFailures.length > 0) {
    failures.push(`no successful workspace-bound read/glob on the sample paths for: ${sampleAccessFailures.join(', ')} (bash-only access does not count)`)
  }
  if (appLogs.files === 0) {
    failures.push(`app log scan is invalid: no log files under ${appLogs.roots.join(' | ')}; the cleanup-budget evidence needs a real scan`)
  }

  facts.outcome = failures.length === 0 ? 'PASS' : 'FAIL'
  facts.finishedAt = new Date().toISOString()
  facts.lane = lane
  facts.modelOutputs = modelOutputs
  facts.dispatchRootChecks = dispatchRootChecks
  facts.appLogs = appLogs
  facts.errors = failures
  if (failures.length === 0) log('verdict PASS')
  else log(`verdict FAIL: ${failures.join(' | ')}`)
}

function persistFacts() {
  if (facts === undefined) return
  facts.screenshots = screenshots
  if (catalogCleanup !== undefined) facts.catalogRootCleanup = catalogCleanup
  mkdirSync(dirname(join(options.outDir, 'facts.json')), { recursive: true })
  writeFileSync(join(options.outDir, 'facts.json'), `${JSON.stringify(redactReport(facts, SECRETS), null, 2)}\n`)
}

function blockedFacts(error) {
  return {
    schemaVersion: 1,
    outcome: 'BLOCKED',
    startedAt: facts?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: osArch(),
      release: osRelease(),
      node: process.version,
      headSha: runGit(['rev-parse', 'HEAD'], REPO_ROOT),
      branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT),
    },
    blocked: {
      cause: error.message,
      detail: error.detail ?? {},
    },
    errors: [error.message],
    screenshots,
    catalogRootCleanup: catalogCleanup ?? null,
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Task 9 intentionally leaves the `--keep-catalog` root on SIGTERM (the
 * connection file is its hand-off), so removing this run's root is the
 * acceptance script's job. Deletion requires all of: the connection was used to
 * configure the app, SIGTERM reached its pid and the process exited, the root
 * lives directly under the OS temp dir, and its name carries the Task 9 prefix.
 * Anything else becomes an explicit manual-delete instruction in facts.
 */
async function stopAndCleanCatalog(connection) {
  const fact = {
    root: connection?.path === undefined ? null : dirname(resolve(connection.path)),
    pid: connection?.pid ?? null,
    usedByThisRun: catalogUsed,
    signalled: false,
    exited: false,
    deleted: false,
    status: 'pending',
  }
  if (connection?.path === undefined) {
    fact.status = 'manual-delete-required'
    fact.reason = 'no catalog connection was read (the catalog root is unknown)'
    return fact
  }
  if (!Number.isSafeInteger(connection.pid) || connection.pid <= 0) {
    fact.status = 'manual-delete-required'
    fact.reason = 'connection pid is invalid'
    fact.command = `rm -rf '${fact.root}'`
    return fact
  }
  if (!catalogUsed && !options.keepCatalogRoot) {
    fact.status = 'manual-delete-required'
    fact.reason = 'the catalog was not used by this run; refusing to delete a root it did not use'
    fact.command = `rm -rf '${fact.root}'`
    return fact
  }
  try {
    process.kill(connection.pid, 'SIGTERM')
    fact.signalled = true
  } catch (error) {
    fact.signalError = error?.code ?? String(error)
  }
  if (fact.signalled) {
    const deadline = Date.now() + 15_000
    while (isProcessAlive(connection.pid) && Date.now() < deadline) await delay(200)
    fact.exited = !isProcessAlive(connection.pid)
  }
  if (options.keepCatalogRoot) {
    fact.status = 'kept (--keep-catalog-root)'
    fact.command = `rm -rf '${fact.root}'`
    return fact
  }
  const root = resolve(fact.root)
  const tempDir = resolve(tmpdir())
  const underTemp = root.startsWith(`${tempDir}${sep}`)
  const taskNineName = /^huaanwork-plaza-verify-/u.test(basename(root))
  if (!fact.signalled || !fact.exited) {
    fact.status = 'manual-delete-required'
    fact.reason = fact.signalled ? 'the catalog pid did not exit within 15s' : `SIGTERM failed (${fact.signalError ?? 'unknown'})`
    fact.command = `rm -rf '${root}'`
    return fact
  }
  if (!underTemp || !taskNineName) {
    fact.status = 'manual-delete-required'
    fact.reason = 'the root is not a Task 9 temp root (OS temp dir + huaanwork-plaza-verify- prefix)'
    fact.command = `rm -rf '${root}'`
    return fact
  }
  if (!existsSync(root)) {
    fact.status = 'already-absent'
    return fact
  }
  try {
    rmSync(root, { recursive: true, force: true })
    fact.deleted = true
    fact.status = existsSync(root) ? 'delete-failed' : 'deleted'
    if (fact.status === 'delete-failed') fact.command = `rm -rf '${root}'`
  } catch (error) {
    fact.status = 'delete-failed'
    fact.reason = error instanceof Error ? error.message : String(error)
    fact.command = `rm -rf '${root}'`
  }
  return fact
}

async function shutdown() {
  if (shutdownDone) return
  shutdownDone = true
  try { appCdp?.close() } catch { /* best effort */ }
  if (appProcess !== undefined && appProcess.exitCode === null && appProcess.signalCode === null) {
    try {
      if (process.platform === 'win32') {
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
  // Only the catalog process this walkthrough was pointed at (started by the
  // caller for this task); never an unrelated process.
  const connection = catalogPid === undefined
    ? undefined
    : { pid: catalogPid, path: facts?.connection?.path ?? resolve(options.connection) }
  if (connection !== undefined) {
    catalogCleanup = await stopAndCleanCatalog(connection)
    log(`catalog cleanup: ${catalogCleanup.status} root=${String(catalogCleanup.root)}`)
  }
  for (const sink of appStreamSinks) sink.end()
  appStreamSinks = []
  if (appLogFile !== undefined) {
    await new Promise((resolveEnd) => { appLogFile.end(resolveEnd) })
  }
  // The isolated profile carries a copy of the production model credential and
  // the per-run catalog token; the temporary root never survives the run unless
  // `--keep-root` asks for it explicitly (diagnosis/evidence only).
  if (tempRoot !== undefined && options.keepRoot) {
    if (facts !== undefined) facts.isolatedCleanup = 'kept (--keep-root)'
    log(`isolated root kept at ${tempRoot}`)
  } else if (tempRoot !== undefined) {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
      if (facts !== undefined) facts.isolatedCleanup = 'removed'
    } catch (error) {
      if (facts !== undefined) facts.isolatedCleanup = `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  writeFileSync(join(options.outDir, 'walkthrough.log'), `${redactSecrets(driverLog.join('\n'), SECRETS)}\n`)
  persistFacts()
  log(`facts written to ${join(options.outDir, 'facts.json')}`)
}

run()
  .then(() => {
    process.exitCode = facts?.outcome === 'PASS' ? 0 : 1
  })
  .catch(async (error) => {
    if (error instanceof BlockedError) {
      if (facts === undefined) {
        facts = blockedFacts(error)
      } else {
        facts.outcome = 'BLOCKED'
        facts.finishedAt = new Date().toISOString()
        facts.blocked = { cause: error.message, detail: error.detail ?? {} }
        facts.errors = [...(facts.errors ?? []), error.message]
      }
      log(`BLOCKED: ${error.message}`)
      persistFacts()
      process.exitCode = 3
      return
    }
    if (facts === undefined) {
      facts = {
        schemaVersion: 1,
        outcome: 'FAIL',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        environment: {},
        errors: [],
        screenshots,
      }
    }
    facts.outcome = 'FAIL'
    facts.finishedAt = new Date().toISOString()
    facts.errors = [...(facts.errors ?? []), redactSecrets(String(error?.stack ?? error), SECRETS)]
    if (appCdp !== undefined) {
      try {
        await screenshot(appCdp, '99-failure.png')
        const body = await appCdp.evaluate('document.body?.innerText ?? ""')
        writeFileSync(join(options.outDir, 'page-dom-on-failure.txt'), redactSecrets(String(body), SECRETS))
      } catch { /* best effort */ }
    }
    persistFacts()
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(async () => { await shutdown() })
