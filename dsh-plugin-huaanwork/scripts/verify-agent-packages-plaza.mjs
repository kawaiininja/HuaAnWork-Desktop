#!/usr/bin/env node
/**
 * 三个智能体包的广场发布验证（隔离 catalog + 一次性开发密钥）。
 * Phase A: 同名 kind:"tool" legacy 条目 ⇒ publish 必须 409。
 * Phase B: 空 entries ⇒ 播种→发布→CLI 签名批准→广场卡断言（先于安装）→安装→验签→启用。
 * 用法: node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs [--keep-catalog] [--out <report.json>]
 * exit: 0 PASS / 1 FAIL / 2 usage（无 BLOCKED 分支，失败一律 FAIL）
 *
 * 隔离性: 整个流程只写 mkdtemp 下的临时根(entries/data/两个 profile/审查回执/私钥)。
 * 生产 profile、仓库 fixture、admin CLI、catalog server 与两个 schema 均零修改。
 *
 * 密钥: 每次运行现场生成一对 Ed25519 开发密钥; 私钥只落在临时根内(0600),
 * 与三枚 per-run token 一起登记为脱敏目标, stdout 报告与 `--out` 文件都经
 * `huaanwork-acceptance-redaction.mjs` 深度脱敏。
 *
 * `--keep-catalog`: 三类断言与安装/启用全部完成后把 {baseUrl, port, readToken,
 * keyring, pid} 写到临时根下的 catalog-connection.json(0600), 然后等待
 * SIGINT/SIGTERM 再优雅关闭 server 并保留临时根, 供 Task 12 真机走查复用同一
 * catalog。不加该参数时成功路径删除临时根。
 *
 * 与 M2 验收先例(`huaanwork-agent-package-m2-acceptance.mjs`)的形态一致:
 * catalog server 在本进程内运行, 因此 admin CLI 必须用异步 spawn 等待——
 * `spawnSync` 会阻塞本进程事件循环, 使同进程的 server 无法应答 CLI 的请求。
 * 日志走 stderr, stdout 只保留最终 JSON 报告。
 */

import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyAgentPackageDirectory } from '@huaanwork/agent-package-format/digest'
import { fingerprintPublicKeyHex, generateKeyPair } from '@huaanwork/catalog-signing'

import { loadAgentCatalogConfig } from '../../agent-catalog-server/src/config.ts'
import { createAgentCatalogRuntime, createAgentCatalogServer } from '../../agent-catalog-server/src/server.ts'
import { configureAgentCatalog } from '../src/huaanwork-host/agent-package/catalog-client.ts'
import { installCatalogAgentPackage } from '../src/huaanwork-host/agent-package/catalog-install.ts'
import {
  publishLocalAgentPackage,
  refreshLocalAgentPackagePublishStatus,
} from '../src/huaanwork-host/agent-package/catalog-publish.ts'
import { createAgentCatalogSecurity } from '../src/huaanwork-host/agent-package/catalog-security.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
} from '../src/huaanwork-host/agent-package/host.ts'
import { agentPackageDir, readAgentPackageState } from '../src/huaanwork-host/agent-package/store.ts'
import { writeHuaanworkSettings } from '../src/huaanwork-host/settings.ts'
import { plazaCards, packageActions, packageActionLabel } from '../src/client-huaanwork/logic/agentPackagesLogic.ts'
import { containsPrivateKey, redactReport, redactSecrets } from './huaanwork-acceptance-redaction.mjs'

const LOG = '[verify-plaza]'
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..')
const CLI_PATH = join(REPO_ROOT, 'agent-catalog-admin', 'src', 'cli.ts')
const SEED_SCRIPT = join(SCRIPT_DIR, 'seed-agent-packages.mjs')
const FIXTURE_ENTRIES = join(REPO_ROOT, 'agent-catalog-server', 'tests', 'fixtures', 'entries')
const SLUGS = ['typo-check', 'code-review', 'task-orch']
const VERSION = '1.0.0'
const CLI_TIMEOUT_MS = 90_000
const SEED_TIMEOUT_MS = 60_000
const REPORT_TIMEOUT_MS = 5_000
const DISPLAY_NAMES = { 'typo-check': '错别字检测', 'code-review': '代码审查', 'task-orch': '任务编排' }

/**
 * 本进程内所有活密钥/token;一产生就登记,之后每条日志、每条 CLI 失败引文与
 * 整份 JSON 报告都按这份清单脱敏(与 M2 先例同一机制)。
 */
const activeSecrets = []

function log(message) {
  process.stderr.write(`${LOG} ${redactSecrets(message, activeSecrets)}\n`)
}

function registerSecrets(values) {
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (!activeSecrets.includes(value)) activeSecrets.push(value)
    const trimmed = value.trim()
    if (trimmed !== value && trimmed.length > 0 && !activeSecrets.includes(trimmed)) activeSecrets.push(trimmed)
  }
}

function usage(message) {
  log(message)
  log('usage: node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs [--keep-catalog] [--out <report.json>]')
  process.exit(2)
}

function parseArgs(argv) {
  const out = { keepCatalog: false, outPath: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep-catalog') out.keepCatalog = true
    else if (argv[i] === '--out') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) usage('--out requires a value')
      out.outPath = value
      i += 1
    } else usage(`unknown argument: ${argv[i]}`)
  }
  return out
}

/**
 * 明显的 throwaway token(>= 32 字符且两两不同),每次运行随机生成,
 * 避免任何已提交字符串被误当成密钥。
 */
function makeTokens() {
  const nonce = randomUUID().replaceAll('-', '')
  return {
    read: `plaza-probe-read-${nonce}-000000000000`,
    publish: `plaza-probe-publish-${nonce}-000000000000`,
    admin: `plaza-probe-admin-${nonce}-000000000000`,
  }
}

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-plaza-verify-'))
  const dirs = {
    root,
    entriesA: join(root, 'entries-a'),
    entriesB: join(root, 'entries-b'),
    data: join(root, 'data'),
    creatorProfile: join(root, 'creator-profile'),
    consumerProfile: join(root, 'consumer-profile'),
    review: join(root, 'review'),
    privateKey: join(root, 'private-key.pem'),
  }
  for (const dir of [
    dirs.entriesA,
    dirs.entriesB,
    dirs.data,
    dirs.creatorProfile,
    dirs.consumerProfile,
    dirs.review,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dirs
}

/**
 * consumer profile 的信任根 `{profileDir}/agent-catalog-keyring.json`。
 * 与 server 侧的 `AGENT_CATALOG_KEYRING_PATH` 是两份独立文件。
 */
function installKeyring(profileDir, publicKeyHex, keyId) {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'agent-catalog-keyring.json'),
    `${JSON.stringify({ schemaVersion: 1, keys: [{ keyId, publicKeyHex, slot: 1 }] }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

function adminEnv(baseUrl, tokens) {
  return {
    AGENT_CATALOG_URL: baseUrl,
    AGENT_CATALOG_ADMIN_TOKEN: tokens.admin,
    AGENT_CATALOG_TOKEN: tokens.read,
    AGENT_CATALOG_PUBLISH_TOKEN: tokens.publish,
  }
}

/** M2 先例的 capture:子进程输出 + 超时 SIGKILL。 */
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

/**
 * 真实 admin CLI(child process)。继承环境里的 AGENT_CATALOG_* 一律剔除,
 * 只注入本次隔离 catalog 的四个变量。
 *
 * 必须是异步 spawn:catalog server 就在本进程里,同步等待会让 server 永远
 * 收不到 CLI 的请求(见文件头)。
 */
async function runCli(args, env) {
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
  const result = await capture(child, CLI_TIMEOUT_MS)
  return {
    args,
    exitCode: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/**
 * 断言一次 CLI 调用成功且输出不含任何密钥(M2 先例 Task 7 / I-8):
 * 失败引文先扫描再引用;已含密钥时只说“含密钥”而不引用原始字节。
 * 成功时返回脱敏后的 stdout/stderr 供后续断言使用。
 */
function requireCliOk(invocation, secrets) {
  if (invocation.exitCode !== 0) {
    const combined = `${invocation.stderr}\n${invocation.stdout}`
    const leaked = secrets.some((secret) => secret.length >= 16 && combined.includes(secret))
    if (leaked || containsPrivateKey(combined)) {
      throw new Error(
        `CLI ${invocation.args[0]} failed and its output contained a secret (redacted)`,
      )
    }
    throw new Error(
      `CLI ${invocation.args[0]} exited ${String(invocation.exitCode)}: ` +
        redactSecrets(combined.trim(), secrets),
    )
  }
  for (const secret of secrets) {
    if (secret.length < 16) continue
    if (invocation.stdout.includes(secret) || invocation.stderr.includes(secret)) {
      throw new Error(`CLI ${invocation.args[0]} printed a secret`)
    }
  }
  if (containsPrivateKey(invocation.stdout) || containsPrivateKey(invocation.stderr)) {
    throw new Error(`CLI ${invocation.args[0]} printed a private key`)
  }
  return {
    stdout: redactSecrets(invocation.stdout, secrets),
    stderr: redactSecrets(invocation.stderr, secrets),
  }
}

/**
 * 与 M2 先例 bootCatalog 逐字同形: runtime 是 async 必须 await;
 * createAgentCatalogServer 签名是 (config, runtime?), 顺序不可颠倒。
 * config.port 显式覆盖为 0, 实际端口以 listen 后的 address() 为准。
 */
async function bootCatalog(entriesDir, dirs, tokens, keyring) {
  const config = {
    ...loadAgentCatalogConfig({
      HOST: '127.0.0.1',
      PORT: '18080',
      AGENT_CATALOG_ENTRIES_DIR: entriesDir,
      AGENT_CATALOG_DATA_DIR: dirs.data,
      AGENT_CATALOG_TOKEN: tokens.read,
      AGENT_CATALOG_PUBLISH_TOKEN: tokens.publish,
      AGENT_CATALOG_ADMIN_TOKEN: tokens.admin,
      AGENT_CATALOG_KEYRING_PATH: join(dirs.root, 'keyring.json'),
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

/**
 * consumer 配置 = 目录客户端绑定 + `huaanwork-settings.json` 落盘(与 M2
 * 先例 configureConsumerProfile 同形):设置面与客户端指向同一个隔离 catalog。
 */
async function configureConsumerProfile(profileDir, port, tokens) {
  await writeHuaanworkSettings(profileDir, {
    agents_host: '127.0.0.1',
    agents_port: port,
    agents_catalog_token: tokens.read,
  })
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

/** Task 8 播种脚本:纯文件系统操作,不访问 catalog,可以用 spawnSync。 */
function seedCreator(profileDir) {
  const result = spawnSync(process.execPath, ['--experimental-transform-types', SEED_SCRIPT, '--profile', profileDir], {
    encoding: 'utf8', cwd: PACKAGE_ROOT, timeout: SEED_TIMEOUT_MS,
  })
  if (result.status !== 0) {
    throw new Error(`seed failed (${String(result.status)}): ${redactSecrets(result.stderr ?? '', activeSecrets)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(`seed stdout is not JSON: ${String(cause)}`)
  }
  if (!Array.isArray(parsed?.seeded) || parsed.seeded.length !== SLUGS.length) {
    throw new Error(`seed 结果不符: ${redactSecrets(result.stdout, activeSecrets)}`)
  }
  for (const slug of SLUGS) {
    if (!parsed.seeded.includes(slug)) throw new Error(`seed 未播种 ${slug}`)
  }
  return parsed
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

/**
 * Phase A: 隔离 entries 里放三份与包同名的 legacy `kind:"tool"` 条目
 * (仓库 fixture 原样拷贝), publish 必须在 legacy 冲突处被拒绝。
 *
 * 客户端不回显服务端错误正文(catalog-client.ts:183-185),409 只暴露为
 * `AgentCatalogClientError('目录请求失败（HTTP 409）', 'http', 409)`;
 * 因此这里只断言 status/code,不断言任何服务端中文文案。
 */
async function phaseA(dirs, tokens, keyring) {
  for (const slug of SLUGS) {
    cpSync(join(FIXTURE_ENTRIES, `${slug}.json`), join(dirs.entriesA, `${slug}.json`))
  }
  const catalog = await bootCatalog(dirs.entriesA, dirs, tokens, keyring)
  try {
    seedCreator(dirs.creatorProfile)
    configureCreator(dirs.creatorProfile, catalog.port, tokens)
    for (const slug of SLUGS) {
      let rejected = false
      try {
        await publishLocalAgentPackage(slug)
      } catch (error) {
        if (error?.status === 409 && error?.code === 'http') rejected = true
        else throw error
      }
      if (!rejected) throw new Error(`Phase A: ${slug} publish 未被同名 tool 条目拒绝（期望 409）`)
      const entry = readAgentPackageState(dirs.creatorProfile)[`local:${slug}`]
      if (entry?.publishStatus !== 'none') {
        throw new Error(`Phase A: ${slug} 被拒后本地状态不是 none: ${JSON.stringify(entry)}`)
      }
      log(`Phase A OK: ${slug} ⇒ 409 legacy-conflict`)
    }
  } finally {
    await catalog.close()
  }
}

/**
 * Phase B: 空 entries 下走完整签名发布链路。
 *
 * 顺序不可交换: plazaCards 会把已安装的 catalog slug 从摘要卡中排除
 * (agentPackagesLogic.ts:362-374), 所以广场断言必须在安装之前。
 */
async function phaseB(dirs, tokens, keyring) {
  const catalog = await bootCatalog(dirs.entriesB, dirs, tokens, keyring)
  const steps = {}
  try {
    // creator 已在 Phase A 播种;此时 catalog 的 entries 是空的。
    configureCreator(dirs.creatorProfile, catalog.port, tokens)
    installKeyring(dirs.consumerProfile, keyring.publicKeyHex, keyring.keyId)

    const submissions = {}
    for (const slug of SLUGS) {
      const submission = await publishLocalAgentPackage(slug)
      if (typeof submission?.submissionId !== 'string' || submission.submissionId.length === 0) {
        throw new Error(`${slug} publish 未返回 submissionId`)
      }
      const entry = readAgentPackageState(dirs.creatorProfile)[`local:${slug}`]
      if (entry?.publishStatus !== 'pending-review') throw new Error(`${slug} publish 未记录 pending-review`)
      if (entry.submissionId !== submission.submissionId) throw new Error(`${slug} 未记录返回的 submissionId`)
      submissions[slug] = submission.submissionId
    }
    steps.submitted = submissions

    // admin CLI: pending → review → approve(真实离线签名)。
    const pending = requireCliOk(await runCli(['pending'], adminEnv(catalog.baseUrl, tokens)), activeSecrets)
    for (const slug of SLUGS) {
      if (!pending.stdout.includes(submissions[slug])) throw new Error(`pending 未列出 ${slug}`)
      const reviewDir = join(dirs.review, slug)
      mkdirSync(reviewDir, { recursive: true })
      requireCliOk(
        await runCli(['review', submissions[slug], '--out', reviewDir], adminEnv(catalog.baseUrl, tokens)),
        activeSecrets,
      )
      const approve = requireCliOk(
        await runCli(
          ['approve', submissions[slug], '--review', join(reviewDir, 'review.json'), '--private-key', dirs.privateKey, '--slot', '1', '--yes'],
          adminEnv(catalog.baseUrl, tokens),
        ),
        activeSecrets,
      )
      if (!approve.stdout.includes(keyring.keyId)) throw new Error(`approve 未打印 ${slug} 的 keyId`)
      const published = await fetchJson(`${catalog.baseUrl}/v1/agent-packages/${slug}/${VERSION}`, {
        headers: { authorization: `Bearer ${tokens.read}` },
      })
      if (published.status !== 200 || published.body?.status !== 'published') {
        throw new Error(`${slug} 未 published (HTTP ${String(published.status)})`)
      }
      if (published.body?.version !== VERSION) throw new Error(`${slug} 发布版本不符: ${String(published.body?.version)}`)
    }
    steps.reviewedAndSigned = { keyId: keyring.keyId, slugs: SLUGS }

    configureCreator(dirs.creatorProfile, catalog.port, tokens)
    for (const slug of SLUGS) {
      const publication = await refreshLocalAgentPackagePublishStatus(slug)
      if (publication.publishStatus !== 'published') throw new Error(`${slug} creator 状态 ${publication.publishStatus}`)
    }

    // 广场断言必须先于安装(plazaCards 排除已安装 catalog slug)。
    const consumerClient = await configureConsumerProfile(dirs.consumerProfile, catalog.port, tokens)
    const summaries = await consumerClient.listPackages()
    if (summaries.length !== SLUGS.length) throw new Error(`目录摘要数不符: ${String(summaries.length)}`)
    const cardsBefore = plazaCards({ packages: [], catalogAgents: [], catalogPackages: summaries })
    if (cardsBefore.length !== SLUGS.length) throw new Error(`广场卡数不符: ${String(cardsBefore.length)}`)
    for (const slug of SLUGS) {
      const card = cardsBefore.find((item) => item.slug === slug)
      if (!card) throw new Error(`广场未出现 ${slug} 卡`)
      if (card.source !== 'catalog' || card.installed !== false || card.enabled !== false) {
        throw new Error(`${slug} 卡不是未安装签名卡`)
      }
      if (card.version !== VERSION) throw new Error(`${slug} 卡版本不符: ${card.version}`)
      if (card.displayName !== DISPLAY_NAMES[slug]) throw new Error(`${slug} displayName 不符: ${card.displayName}`)
      const actions = packageActions(card)
      if (JSON.stringify(actions) !== JSON.stringify(['install', 'detail'])) {
        throw new Error(`${slug} 动作不符: ${actions}`)
      }
      if (packageActionLabel('install', card) !== '下载') throw new Error(`${slug} install 文案不是「下载」`)
    }
    steps.plazaBeforeInstall = cardsBefore.map((card) => ({
      slug: card.slug,
      displayName: card.displayName,
      installed: card.installed,
    }))

    // 安装 + 状态 + 独立验签(与发布链路无关的第二条验签路径)。
    for (const slug of SLUGS) {
      const installed = await installCatalogAgentPackage(slug, VERSION)
      if (installed.manifest.slug !== slug) throw new Error(`${slug} 安装 slug 不符`)
      if (installed.manifest.version !== VERSION) throw new Error(`${slug} 安装版本不符`)
      if (installed.signature.keyId !== keyring.keyId) throw new Error(`${slug} 安装回执 keyId 不符`)
      const entry = readAgentPackageState(dirs.consumerProfile)[`catalog:${slug}`]
      if (entry?.source !== 'catalog' || entry.enabled !== false) throw new Error(`${slug} 首装必须 catalog+disabled`)
      if (entry.installedVersion !== VERSION || entry.publishStatus !== 'installed') {
        throw new Error(`${slug} 安装状态不符: ${JSON.stringify(entry)}`)
      }
      const verified = verifyAgentPackageDirectory(agentPackageDir(dirs.consumerProfile, slug), [keyring])
      if (verified.signature.keyId !== keyring.keyId) throw new Error(`${slug} 验签 keyId 不符`)
      if (verified.digest.slug !== slug || verified.digest.version !== VERSION) {
        throw new Error(`${slug} 验签 digest 身份不符`)
      }
    }
    steps.installedAndVerified = SLUGS

    // 安装后广场不再显示这三张摘要卡;目录仍列出三条摘要,排除发生在客户端。
    const summariesAfter = await consumerClient.listPackages()
    if (summariesAfter.length !== SLUGS.length) throw new Error(`安装后目录摘要数不符: ${String(summariesAfter.length)}`)
    const installedState = readAgentPackageState(dirs.consumerProfile)
    const packagesAfter = SLUGS.map((slug) => ({ slug, source: 'catalog', ...installedState[`catalog:${slug}`] }))
    const cardsAfter = plazaCards({ packages: packagesAfter, catalogAgents: [], catalogPackages: summariesAfter })
    for (const slug of SLUGS) {
      if (cardsAfter.some((card) => card.slug === slug)) throw new Error(`${slug} 安装后仍在广场摘要卡中`)
    }
    steps.plazaAfterInstall = 'installed slugs excluded'

    // 宿主接线 + 启用(与 index.ts boot 同形;启用门内部会再同步验签)。
    const activeTurns = createAgentPackageActiveTurnRegistry()
    const security = createAgentCatalogSecurity({
      profileDir: dirs.consumerProfile,
      registry: activeTurns,
      client: consumerClient,
    })
    const host = createAgentPackageHost({
      profileDir: dirs.consumerProfile,
      takenSlugs: () => [],
      activeTurns,
      security,
    })
    for (const slug of SLUGS) {
      await host.setEnabled(slug, true)
      const entry = readAgentPackageState(dirs.consumerProfile)[`catalog:${slug}`]
      if (entry?.enabled !== true) throw new Error(`${slug} 启用失败`)
    }
    steps.enabled = SLUGS

    return { catalog, steps }
  } catch (error) {
    await catalog.close()
    throw error
  }
}

function waitForSignal() {
  return new Promise((resolve) => {
    const onSignal = (signal) => {
      log(`received ${String(signal)}; shutting down catalog`)
      resolve()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dirs = makeDirs()
  const tokens = makeTokens()
  const keyPair = generateKeyPair()
  const keyId = fingerprintPublicKeyHex(keyPair.publicKeyHex)
  const keyring = { keyId, publicKeyHex: keyPair.publicKeyHex, slot: 1 }
  writeFileSync(dirs.privateKey, keyPair.privateKeyPem, { encoding: 'utf8', mode: 0o600 })
  // server keyring:bootCatalog 的 AGENT_CATALOG_KEYRING_PATH 指向这份文件,
  // config.ts parseKeyring 要求首次启动前可读(M2 先例同形)。
  // consumer profile 的 agent-catalog-keyring.json 是另一份文件,不能替代它。
  writeFileSync(
    join(dirs.root, 'keyring.json'),
    `${JSON.stringify({ schemaVersion: 1, keys: [keyring] }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  registerSecrets([tokens.read, tokens.publish, tokens.admin, keyPair.privateKeyPem])

  const report = { outcome: 'PASS', phases: {}, startedAt: new Date().toISOString() }
  let catalogHandle = null
  let connectionWritten = false
  try {
    await phaseA(dirs, tokens, keyring)
    report.phases.legacyConflict = 'PASS (409 for all three slugs)'

    const { catalog, steps } = await phaseB(dirs, tokens, keyring)
    catalogHandle = catalog
    report.phases = { ...report.phases, ...steps }

    if (args.keepCatalog) {
      const connection = {
        baseUrl: catalog.baseUrl,
        port: catalog.port,
        readToken: tokens.read,
        keyring: { keyId, publicKeyHex: keyPair.publicKeyHex, slot: 1 },
        pid: process.pid,
      }
      const connectionPath = join(dirs.root, 'catalog-connection.json')
      writeFileSync(connectionPath, `${JSON.stringify(connection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      connectionWritten = true
      log(`--keep-catalog: connection written to ${connectionPath}; waiting for SIGINT/SIGTERM`)
      report.connectionPath = connectionPath
      await waitForSignal()
    }
    await catalog.close()
    catalogHandle = null
  } catch (error) {
    report.outcome = 'FAIL'
    report.error = redactSecrets(String(error?.stack ?? error), activeSecrets)
    process.exitCode = 1
  } finally {
    if (catalogHandle !== null) {
      try {
        await catalogHandle.close()
      } catch (error) {
        report.outcome = 'FAIL'
        report.cleanupError = redactSecrets(String(error?.stack ?? error), activeSecrets)
        process.exitCode = 1
      }
    }
    // 只有显式 --keep-catalog 且连接文件真的写出时才保留临时根;
    // 失败路径一律删除(私钥/token 不落在无人认领的临时目录里)。
    if (!args.keepCatalog || !connectionWritten) rmSync(dirs.root, { recursive: true, force: true })
    report.finishedAt = new Date().toISOString()
    const safe = redactReport(report, activeSecrets)
    const text = JSON.stringify(safe, null, 2)
    if (args.outPath) writeFileSync(args.outPath, `${text}\n`, 'utf8')
    console.log(text)
  }
}

main().catch((error) => {
  process.stderr.write(`${LOG} ${redactSecrets(String(error?.stack ?? error), activeSecrets)}\n`)
  process.exit(1)
})
