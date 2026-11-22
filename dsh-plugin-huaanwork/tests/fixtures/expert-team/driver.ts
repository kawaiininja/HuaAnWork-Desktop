/**
 * 真实组合 driver:一次真实 Host 启动、真实包 runtime、真实 `session.send` 与
 * `llm/stream` 脚本模型,供专家团端到端场景使用(设计 §18.4)。
 *
 * 约束:
 * - 不使用真实 API key、不访问外网:模型请求由 `llm/stream` 全局瀑布直接产出
 *   流块(不调用 `next()`,因此不会落到任何 provider HTTP 适配器);
 * - Host / RPC / 附件 / Artifact 存储全部真实,成员包是真实包目录 + 真实 runtime;
 * - 所有临时 profile、端口、子进程与 Host disposer 都归本模块释放。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, type ContentBlock, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { updateVolatile, createVolatile } from '@deepseek-ai/cosmokit'

import { installDesktopPnpmRuntime } from '../../../src/desktop-runtime-environment.ts'
import { installProfilePackageResolver } from '../../../src/module-resolution.ts'
import { prepareDesktopProfile } from '../../../src/profile.ts'
import { DesktopProfileService } from '../../../src/profile-service.ts'
import { createDesktopProfileBoot } from '../../../src/profile-context.ts'
import type {} from '../../../src/huaanwork-host/holders.ts'
import { EXPERT_TEAM_DISPATCH_TOOL } from '../../../src/huaanwork-guardrails/expert-team-dispatch.ts'
import { isAgentToolAttached } from '../../../src/huaanwork-guardrails/agent-attachments.ts'
import { listArtifacts, readArtifactContent } from '../../../src/huaanwork-host/artifacts-host.ts'
import type { ExpertTeamRunRegistry } from '../../../src/huaanwork-host/expert-team/runs.ts'
import type { ExpertTeamDispatchInput } from '../../../src/huaanwork-host/expert-team/coordinator.ts'
import { sessionIdFor } from '../../../src/huaanwork-host/session-id.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  ExpertTeam,
  ExpertTeamMember,
  ExpertTeamResult,
  ExpertTeamRun,
} from '../../../src/client-huaanwork/rpc-types.ts'
import { validTeamInput } from './team.ts'
import type {} from '@deepseek-ai/dsh-agent-loop'

const FIXTURE_PACKAGE = fileURLToPath(new URL('../agent-package/', import.meta.url))

/** 单场景等待上限;真实 boot + 多次成员 activation 在 CI 上也应远小于此值。 */
const RUN_TIMEOUT_MS = 180_000
const BOOT_TIMEOUT_MS = 240_000

/** `ctx` → 本次 Host 的启动资源;重启后以新 ctx 重新登记。 */
type CompositionRuntime = {
  base: string
  home: string
  profileDir: string
  settingsPath: string
  workspaceRoot: string
  sessionId: string
  pnpmRuntime: ReturnType<typeof installDesktopPnpmRuntime>
  pnpmBootstrap: Record<string, unknown>
  releaseResolver: () => void
  runtime: DesktopRuntimeStub
  prepared: ReturnType<typeof prepareDesktopProfile>
  released: boolean
}

type DesktopRuntimeStub = {
  platform: string
  locale: string
  updates: Record<string, unknown>
  schedule(spec: unknown): () => Promise<void>
  mountScheduled(): Promise<void>
  setLocalePreference(preference: string): void
  [key: string]: unknown
}

const runtimes = new Map<Context, CompositionRuntime>()
let environmentReleases: Array<() => void> = []

/** 一次真实 Host 组合;测试在 `beforeAll` 里启动并在 `afterAll` 里整体释放。 */
export type CompositionHost = {
  ctx: Context
  profileDir: string
  sessionId: string
  dispose(): Promise<void>
}

/** 当前存活的组合 ctx(重启后指向新一轮 Host)。 */
export function activeCompositionContext(): Context {
  const contexts = [...runtimes.keys()]
  const last = contexts.at(-1)
  if (last === undefined) throw new Error('expert-team composition host is not booted')
  return last
}

function requireRuntime(ctx: Context): CompositionRuntime {
  const runtime = runtimes.get(ctx)
  if (runtime === undefined) throw new Error('expert-team composition host is not booted')
  return runtime
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ────────────────────────── profile / boot ──────────────────────────

function prepareHome(): { base: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), 'expert-team-composition-'))
  const home = join(base, 'dsh')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\nagent-presets:\n  default: minimal\n')
  return { base, home }
}

/** 脚本模型请求的归属:由 `llm/stream` 监听在启动期注册,读当前运行脚本。 */
type ScriptRef = { current: RunScript | undefined }

function createDesktopRuntimeStub(home: string): DesktopRuntimeStub {
  const runtime: DesktopRuntimeStub = {
    platform: 'win32',
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'updates.json'),
      request: async () => undefined,
      confirmDownload: async () => false,
      showManualCheckResult: async () => undefined,
      downloadAndOpen: async () => undefined,
      notify: () => undefined,
    },
    schedule() {
      return async () => undefined
    },
    async mountScheduled() {
      runtime.setLocalePreference('en')
    },
    show() {},
    registerTrayItem() {
      return { refresh() {}, dispose() {} }
    },
    openTerminal() {},
    setLocalePreference() {},
    setThemeSource() {},
    async requestRestart() {},
    async requestConfirmedRestart() {
      return true
    },
    prepareToQuit() {},
  }
  return runtime
}

/**
 * 启动一次真实组合。`script` 是当前场景脚本的容器:启动监听只读它,每个 run 在
 * `session.send` 之前替换为新脚本。
 */
async function bootComposition(prepared: ReturnType<typeof prepareDesktopProfile>, resources: CompositionRuntime, script: ScriptRef): Promise<Context> {
  const profileBoot = createDesktopProfileBoot(prepared, resources.pnpmBootstrap as never)
  const runtime = resources.runtime
  const ctx = await boot(
    'huaanwork-expert-team-composition',
    prepared.rootConfig,
    [...prepared.patches],
    async (host: Context) => {
      profileBoot.prepare(host)
      ;(host as unknown as { loader: { internal: undefined } }).loader.internal = undefined
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopBrowserAccess', {
        ordinaryBrowserEnabled: false,
        rendererHeader: { ...RENDERER_HEADER },
        setOrdinaryBrowserEnabled() {},
      })
      host.provide('desktopLanHttps', {
        caCertificate: null,
        attach() {},
        snapshot() {
          return { state: 'inactive' }
        },
        async setEnabled() {
          return { state: 'inactive' }
        },
        async stop() {
          return { state: 'inactive' }
        },
      })
      host.provide('desktopRuntime', runtime)
      host.provide('desktopPnpmBootstrap', resources.pnpmBootstrap)
      await host.plugin(DesktopProfileService, {
        current: { name: 'desktop', dir: prepared.profile.dir },
        list: () => [{ name: 'desktop', dir: prepared.profile.dir, exists: true, bundles: [], webCapable: true }],
        persistSelection: () => undefined,
        requestRestart: () => undefined,
      })
      provideCmdline(host, { args: ['--host', '127.0.0.1', '--port', '0'], exit: () => undefined })
      // 脚本模型:全局瀑布最外层,永不调用 next() —— 不触碰任何 provider HTTP。
      host.on(
        'llm/stream',
        ((options: GenerateOptions) => scriptedStream(script, options)) as never,
        { global: true, prepend: true },
      )
    },
    prepared.bareModuleBaseUrl,
  )
  profileBoot.markReady()
  await runtime.mountScheduled()
  return ctx
}

async function prepareProfileResources(home: string): Promise<{
  prepared: ReturnType<typeof prepareDesktopProfile>
  profileDir: string
  workspaceRoot: string
  settingsPath: string
}> {
  const prepared = prepareDesktopProfile('1', home, process.platform === 'darwin' ? 'win32' : 'win32')
  const profileDir = prepared.profile.dir
  // 中立根由 profile 目录派生,同 profile 重启后仍是同一个根。
  const workspaceRoot = join(profileDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const settingsPath = join(profileDir, 'huaanwork-settings.json')
  const modelEntry = { id: 'local', name: 'Local Stub', base_url: 'http://127.0.0.1:9/v1', model: 'local', api_key: '' }
  writeFileSync(
    settingsPath,
    `${JSON.stringify({
      models: [modelEntry],
      active_model_id: 'local',
      base_url: modelEntry.base_url,
      model: modelEntry.model,
      api_key: modelEntry.api_key,
      allow_network: false,
      max_concurrent_turns: 8,
    }, null, 2)}\n`,
  )
  return { prepared, profileDir, workspaceRoot, settingsPath }
}

/** 启动组合 Host 并等待稳定通道会话的 agent-loop agent 就绪。 */
export async function bootCompositionHost(): Promise<CompositionHost> {
  const { base, home } = prepareHome()
  const resources = await createResources(base, home)
  const script: ScriptRef = { current: undefined }
  const ctx = await withTimeout(bootComposition(resources.prepared, resources, script), BOOT_TIMEOUT_MS, 'expert-team host boot')
  resources.ctx = ctx
  resources.script = script
  runtimes.set(ctx, resources)
  environmentReleases.push(() => releaseEnvironment(resources))
  await waitFor(() => sessionAgent(ctx, resources.sessionId) !== undefined, 'stable channel agent')
  return {
    ctx,
    profileDir: resources.profileDir,
    sessionId: resources.sessionId,
    async dispose() {
      await ctx.fiber.dispose()
      runtimes.delete(ctx)
    },
  }
}

type BootResources = CompositionRuntime & {
  prepared: ReturnType<typeof prepareDesktopProfile>
  ctx?: Context
  script?: ScriptRef
}

async function createResources(base: string, home: string): Promise<BootResources> {
  const { prepared, profileDir, workspaceRoot, settingsPath } = await prepareProfileResources(home)
  const packageRoot = new URL('../../../', import.meta.url)
  const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8')).version as string
  process.env.DSH_HOME = home
  const pnpmRuntime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    stateDir: join(home, 'runtime-commands'),
    environment: process.env,
  })
  const releaseResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = createDesktopRuntimeStub(home)
  const pnpmBootstrap = {
    activeProfileName: 'desktop',
    activeProfileDir: profileDir,
    homeDir: home,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    nodeBinDir: pnpmRuntime.nodeBinDir,
    nodeShimPath: pnpmRuntime.nodeShimPath,
    clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
    dshBootstrapPath: fileURLToPath(new URL('../../../lib/desktop-cli.js', import.meta.url)),
  }
  return {
    base,
    home,
    profileDir,
    settingsPath,
    workspaceRoot,
    sessionId: sessionIdFor(workspaceRoot),
    pnpmRuntime,
    pnpmBootstrap,
    releaseResolver,
    runtime,
    prepared,
    released: false,
  }
}

function releaseEnvironment(resources: CompositionRuntime): void {
  if (resources.released) return
  resources.released = true
  resources.releaseResolver()
  resources.pnpmRuntime.dispose()
  delete process.env.DSH_HOME
  rmSync(resources.base, { recursive: true, force: true })
}

/** 释放全部组合环境(测试文件 `afterAll` 调用;不关心当前 ctx 是否已重启)。 */
export async function disposeCompositionEnvironment(): Promise<void> {
  for (const ctx of [...runtimes.keys()]) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // 已 dispose 的 generation 容忍幂等失败。
    }
    runtimes.delete(ctx)
  }
  for (const release of environmentReleases) release()
  environmentReleases = []
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ────────────────────────── session access ──────────────────────────

type SessionAgentView = {
  id?: string
  session?: { id?: string }
  followup?: (message: unknown) => void
  whenIdle?: () => Promise<void>
}

function sessionAgent(ctx: Context, sessionId: string): SessionAgentView | undefined {
  const agents = ctx.agents as unknown as {
    get?: (id: string) => SessionAgentView | undefined
    list?: () => SessionAgentView[]
  }
  const direct = agents.get?.(sessionId)
  if (direct !== undefined) return direct
  return agents.list?.().find((agent) => agent.id === sessionId || agent.session?.id === sessionId)
}

const RENDERER_HEADER = { name: 'x-dsh-desktop-renderer', value: Buffer.alloc(32, 2).toString('base64url') }

function loopbackOrigin(ctx: Context): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}`
}

/**
 * 经真实 HTTP 路由执行 `session.send`:发送链路必须在 Host 自己的模块图内运行
 * (测试导入的 src 与打包产物不共享模块单例),不能跨模块图直接调用 `sessionSend`。
 */
async function postLoopbackRoute(ctx: Context, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const origin = loopbackOrigin(ctx)
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      [RENDERER_HEADER.name]: RENDERER_HEADER.value,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(`POST ${path} -> HTTP ${String(response.status)}: ${text.slice(0, 400)}`)
  }
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>)
}

function sessionMessages(ctx: Context, sessionId: string): Message[] {
  const session = ctx.sessions.get(brandString<SessionId>(sessionId))
  return session === undefined ? [] : session.deriveMessages()
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** §12.4.2 仅会话最终汇总:本轮最后一个 `tool/result` 之后的 assistant text(忽略 reasoning)。 */
function finalSummaryOf(messages: readonly Message[]): string {
  let lastTool = -1
  messages.forEach((message, index) => {
    if (message.role === 'tool') lastTool = index
  })
  const parts: string[] = []
  for (let index = lastTool + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'assistant') continue
    const text = messageText(message)
    if (text.trim().length > 0) parts.push(text)
  }
  return parts.join('\n').trim()
}

/** 父会话中来自系统/子代理的 user 消息(团队回合不得产生任何结算通知)。 */
function parentNotificationsOf(messages: readonly Message[]): Array<{ kind: string; text: string }> {
  const notifications: Array<{ kind: string; text: string }> = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const kind = message.source.kind
    if (kind === 'user') continue
    notifications.push({ kind, text: messageText(message) })
  }
  return notifications
}

// ────────────────────────── agent packages ──────────────────────────

type InstalledPackage = {
  slug: string
  displayName: string
  version: string
  mcp: boolean
}

function writePackageState(profileDir: string, installed: readonly InstalledPackage[]): void {
  const statePath = join(profileDir, 'agents-state.json')
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
  } catch {
    // 首次安装:没有状态文件。
  }
  for (const pkg of installed) {
    existing[`local:${pkg.slug}`] = { source: 'local', enabled: true, installedVersion: pkg.version }
  }
  writeFileSync(statePath, `${JSON.stringify(existing, null, 2)}\n`)
}

/** 复制真实包 fixture 到 `<profileDir>/agents/<slug>/`,改写 manifest 与 persona。 */
function installPackage(profileDir: string, slug: string, displayName: string, persona: string, mcp: boolean): InstalledPackage {
  const packageDir = join(profileDir, 'agents', slug)
  mkdirSync(join(profileDir, 'agents'), { recursive: true })
  cpSync(FIXTURE_PACKAGE, packageDir, { recursive: true })
  const manifestPath = join(packageDir, 'agent.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.slug = slug
  manifest.displayName = displayName
  manifest.description = `${displayName}测试包`
  manifest.version = '1.0.0'
  manifest.tools = mcp
    ? { mode: 'mcp', mcp: { entry: 'tools/mcp/server.mjs' } }
    : { mode: 'none' }
  manifest.draftId = `draft-${slug}`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(packageDir, 'persona.md'), `${persona}\n`)
  if (mcp) rmSync(join(packageDir, 'tools', 'http'), { recursive: true, force: true })
  else rmSync(join(packageDir, 'tools'), { recursive: true, force: true })
  return { slug, displayName, version: '1.0.0', mcp }
}

export type InstalledExpertTeamPackages = {
  /** 无 MCP 的执行成员(默认场景)。 */
  executors: InstalledPackage[]
  /** 带本地 loopback MCP 的执行成员(`dualMcp` 场景)。 */
  mcpExecutors: InstalledPackage[]
  reviewers: InstalledPackage[]
}

/**
 * 在临时 profile 中安装真实包目录:2 个执行成员(普通 + MCP 两套)与 1–2 名审查成员。
 * 团队按 run 选项选择执行成员版本;审查包始终无工具。
 */
export function installExpertTeamPackages(ctx: Context, reviewerCount: 1 | 2 = 1): InstalledExpertTeamPackages {
  const runtime = requireRuntime(ctx)
  const suffix = randomUUID().slice(0, 6).replaceAll('-', '')
  const executors: InstalledPackage[] = []
  const mcpExecutors: InstalledPackage[] = []
  for (const [index, label] of ['甲', '乙'].entries()) {
    const baseSlug = `executor-${index + 1}-${suffix}`
    const plain = installPackage(runtime.profileDir, baseSlug, `执行成员${label}`, `你是执行成员${label},负责提取事实与起草结论。`, false)
    const mcp = installPackage(runtime.profileDir, `${baseSlug}-mcp`, `执行成员${label}MCP`, `你是执行成员${label},负责提取事实与起草结论,可使用包内 MCP 工具。`, true)
    executors.push(plain)
    mcpExecutors.push(mcp)
  }
  const reviewers: InstalledPackage[] = []
  for (let index = 0; index < reviewerCount; index += 1) {
    reviewers.push(
      installPackage(runtime.profileDir, `reviewer-${index + 1}-${suffix}`, `审查成员${index + 1}`, `你是审查成员${index + 1},负责统一合规审查并指出风险项。`, false),
    )
  }
  writePackageState(runtime.profileDir, [...executors, ...mcpExecutors, ...reviewers])
  if (process.env.EXPERT_TEAM_DEBUG === '1') {
    void debugPackageList(ctx)
  }
  return { executors, mcpExecutors, reviewers }
}

// ────────────────────────── team definition ──────────────────────────

export type ComplianceTeamScenario = {
  ctx: Context
  packages: InstalledExpertTeamPackages
  team: ExpertTeam
  run(options: ComplianceTeamSmokeOptions): Promise<ComplianceTeamSmokeResult>
}

export type ComplianceTeamSmokeOptions = {
  executionOrder?: 'parallel' | 'sequential' | 'dynamic'
  maxParallel?: 1 | 2 | 3 | 4
  /** 父会话 `agentLoop.config.maxParallelToolCalls`(volatile)。 */
  parentMaxParallelToolCalls?: number
  /** 审查结论队列,按审查派工顺序逐条消费;禁止短数组循环复用。 */
  reviewVerdicts?: Array<'pass' | 'revise'>
  dualMcp?: boolean
  delivery?: 'artifact' | 'message'
  activeGoal?: boolean
  transitionalTextBeforeDispatch?: string
  failUntilBudgetExhausted?: boolean
  failArtifactWrite?: boolean
}

export type ComplianceTeamDispatchRecord = {
  kind: ExpertTeamResult['kind']
  memberId: string
  resultId: string
  status: ExpertTeamResult['status']
  memberRunId?: string
  reviewVerdict?: 'pass' | 'revise'
}

export type ComplianceTeamSmokeResult = {
  run: ExpertTeamRun
  dispatches: ComplianceTeamDispatchRecord[]
  memberRunIds: string[]
  maxMemberConcurrency: number
  parentMcpAttachments: string[]
  /** 父会话模型面出现的 `mcp__*` 工具名(必须为空)。 */
  parentMcpToolNames: string[]
  /** 成员模型面出现的 MCP 工具名 → 服务名长度(验证挂载与 ≤32 字符)。 */
  memberMcpServers: Array<{ serverName: string; toolName: string }>
  primaryArtifactIds: string[]
  artifact: { title: string; format: string; content: string } | undefined
  parentNotifications: Array<{ kind: string; text: string }>
  finalSummary: string
  dispatchAttachmentDetached: boolean
  goalDispatchError: string | undefined
}

function memberForPackage(pkg: InstalledPackage, memberId: string, role: ExpertTeamMember['role'], responsibility: string): ExpertTeamMember {
  return {
    memberId,
    agentRef: { source: 'local', slug: pkg.slug },
    role,
    responsibility,
    outputInstructions: role === 'reviewer' ? '给出结论与依据。' : '给出结论、依据与未解决项。',
  }
}

/** 建立可在真实 Host 上执行的合规审查团队场景(包已安装、团队定义已持久化)。 */
export async function createComplianceTeamScenario(
  ctx: Context,
  options: { reviewerCount?: 1 | 2 } = {},
): Promise<ComplianceTeamScenario> {
  const reviewerCount = options.reviewerCount ?? 1
  const packages = installExpertTeamPackages(ctx, reviewerCount)
  const team = await createExpertTeamDefinition(ctx, packages, {
    executionOrder: 'parallel',
    maxParallel: 2,
    delivery: 'artifact',
  })
  return {
    ctx,
    packages,
    team,
    run(runOptions: ComplianceTeamSmokeOptions): Promise<ComplianceTeamSmokeResult> {
      return executeScriptedTeamRun(ctx, packages, runOptions)
    },
  }
}

let teamSequence = 0

/** 通过真实 `ExpertTeamStore.create` 创建团队定义(每次运行独立 slug,避免复核复用)。 */
export async function createExpertTeamDefinition(
  ctx: Context,
  packages: InstalledExpertTeamPackages,
  options: Required<Pick<ComplianceTeamSmokeOptions, 'executionOrder' | 'maxParallel' | 'delivery'>>,
): Promise<ExpertTeam> {
  teamSequence += 1
  const executors = packages.executors
  const members: ExpertTeamMember[] = [
    memberForPackage(executors[0]!, 'm-exec-1', 'executor', '提取合同关键条款并起草结论'),
    memberForPackage(executors[1]!, 'm-exec-2', 'executor', '核对发票与付款条件并起草结论'),
  ]
  packages.reviewers.forEach((reviewer, index) => {
    members.push(memberForPackage(reviewer, `m-rev-${index + 1}`, 'reviewer', '统一合规审查并指出风险项'))
  })
  const input = validTeamInput({
    slug: `compliance-team-${teamSequence}`,
    name: '合规审查小分队',
    members,
    orchestration: {
      assignmentMode: 'by-responsibility',
      executionOrder: options.executionOrder,
      maxParallel: options.maxParallel,
    },
    review: { mode: 'unified', maxRevisionRounds: 1 },
    summary: { delivery: options.delivery, artifactFormat: 'markdown', mode: 'integrated' },
  })
  return ctx.huaanworkExpertTeamStore.create(input)
}

// ────────────────────────── scripted model ──────────────────────────

type LeaderDispatch = {
  callId: string
  args: Record<string, unknown>
}

type RunScript = {
  mode: 'artifact' | 'message'
  reviewers: string[]
  executorMemberIds: string[]
  verdictQueue: Array<'pass' | 'revise'>
  verdictByMember: Map<string, Array<'pass' | 'revise'>>
  maxMemberConcurrency: number
  activeMembers: number
  parentMcpToolNames: Set<string>
  memberMcpServers: Map<string, string>
  finalSummary: string
  dispatches: LeaderDispatch[]
  failUntilBudgetExhausted: boolean
  failArtifactWrite: boolean
  transitionalText: string | undefined
  revisionsEmitted: number
  artifactPresented: boolean
}

function newRunScript(reviewers: string[], executorMemberIds: string[], options: ComplianceTeamSmokeOptions): RunScript {
  return {
    mode: options.delivery === 'message' ? 'message' : 'artifact',
    reviewers,
    executorMemberIds,
    verdictQueue: [...(options.reviewVerdicts ?? ['pass'])],
    verdictByMember: new Map(),
    maxMemberConcurrency: 0,
    activeMembers: 0,
    parentMcpToolNames: new Set(),
    memberMcpServers: new Map(),
    finalSummary: '',
    dispatches: [],
    failUntilBudgetExhausted: options.failUntilBudgetExhausted === true,
    failArtifactWrite: options.failArtifactWrite === true,
    transitionalText: options.transitionalTextBeforeDispatch,
    revisionsEmitted: 0,
    artifactPresented: false,
  }
}

/**
 * 脚本模型入口。leader 请求带 `expert_team_dispatch` 工具面;成员请求的派工提示词
 * (`专家团成员：`)可能落在任意角色的消息里(activation 的 system/developer 首条),
 * 因此扫描全部消息文本而不是最后一条 user;其余(标题/压缩)回固定短文本。
 */
async function* scriptedStream(script: ScriptRef, options: GenerateOptions): AsyncGenerator<StreamChunk> {
  const run = script.current
  const tools = options.tools ?? []
  const isLeader = tools.some((tool) => tool.name === EXPERT_TEAM_DISPATCH_TOOL)
  const requestText = allMessagesText(options.messages)
  const lastUser = lastUserText(options.messages)
  if (process.env.EXPERT_TEAM_DEBUG === '1') {
    console.log('STREAM', JSON.stringify({
      hasRun: run !== undefined,
      isLeader,
      tools: tools.map((tool) => tool.name),
      user: lastUser.slice(0, 160),
      prompt: requestText.slice(0, 160),
      messageCount: options.messages.length,
    }))
  }
  if (run !== undefined && isLeader) {
    for (const tool of tools) {
      if (tool.name.startsWith('mcp__')) run.parentMcpToolNames.add(tool.name)
    }
    yield* leaderStream(run, options)
    return
  }
  if (run !== undefined && requestText.includes('专家团成员：')) {
    for (const tool of tools) {
      const match = /^mcp__(.+)__[^_].*$/.exec(tool.name)
      if (match?.[1] !== undefined) run.memberMcpServers.set(match[1], tool.name)
    }
    yield* memberStream(run, requestText)
    return
  }
  // 辅助流(会话标题/压缩)与未知请求:固定文本,绝不触网。
  yield* textStream('辅助请求已完成。')
}

/** 全部消息(任意角色)的文本拼接;成员 activation 提示词不在 user 消息里。 */
function allMessagesText(messages: readonly GenerateOptions['messages'][number][]): string {
  const parts: string[] = []
  for (const message of messages) parts.push(messageText(message as Message))
  return parts.join('\n')
}

function lastUserText(messages: readonly GenerateOptions['messages'][number][]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    return messageText(message as Message)
  }
  return ''
}

function* textStream(text: string, index = 0): Generator<StreamChunk> {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 工具调用流:同一 assistant 消息可含前导文本与多个 tool-call 块。 */
function* toolCallStream(calls: Array<{ name: string; args: Record<string, unknown> }>, leadingText?: string): Generator<StreamChunk> {
  let index = 0
  if (leadingText !== undefined && leadingText.length > 0) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: leadingText }
    yield { type: 'block-end', index, block: { type: 'text', text: leadingText } }
    index += 1
  }
  for (const call of calls) {
    const id = ToolCallId(`call-${randomUUID()}`)
    const args = JSON.stringify(call.args)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id, name: call.name, arguments: args },
    }
    index += 1
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function dispatchCalls(run: RunScript, inputs: Array<{ memberId: string; kind: string; task: string; inputResultIds?: string[]; supersedesResultId?: string }>): Array<{ name: string; args: Record<string, unknown> }> {
  return inputs.map((input) => {
    const callId = `dispatch-${randomUUID()}`
    const args: Record<string, unknown> = {
      memberId: input.memberId,
      kind: input.kind,
      task: input.task,
      ...(input.inputResultIds === undefined ? {} : { inputResultIds: input.inputResultIds }),
      ...(input.supersedesResultId === undefined ? {} : { supersedesResultId: input.supersedesResultId }),
    }
    run.dispatches.push({ callId, args })
    return { name: EXPERT_TEAM_DISPATCH_TOOL, args }
  })
}

type ParsedDispatch = {
  resultId: string
  memberId: string
  kind: ExpertTeamResult['kind']
  status: ExpertTeamResult['status']
  inputResultIds: string[]
  supersedesResultId?: string
  reviewVerdict?: 'pass' | 'revise'
  raw: string
}

function parseDispatchResults(messages: readonly GenerateOptions['messages'][number][]): ParsedDispatch[] {
  const results: ParsedDispatch[] = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const text = messageText(message as Message)
    if (!text.startsWith('派工结果：')) continue
    const resultId = /^派工结果：(\S+)/.exec(text)?.[1]
    const memberId = /^成员：([^（(]+)/.exec(text.split('\n')[1] ?? '')?.[1]
    const kind = /^类型：(execute|review|revision)$/m.exec(text)?.[1]
    const status = /^状态：(completed|failed|stopped|starting|running)$/m.exec(text)?.[1]
    const inputLine = /^引用结果：(.*)$/m.exec(text)?.[1]
    const verdict = /^审查结论：(pass|revise)$/m.exec(text)?.[1]
    if (resultId === undefined || memberId === undefined || kind === undefined || status === undefined) continue
    results.push({
      resultId,
      memberId: memberId.trim(),
      kind: kind as ExpertTeamResult['kind'],
      status: status as ExpertTeamResult['status'],
      inputResultIds: inputLine === undefined || inputLine.trim() === '' ? [] : inputLine.split('、').map((item) => item.trim()),
      ...(verdict === undefined ? {} : { reviewVerdict: verdict as 'pass' | 'revise' }),
      raw: text,
    })
  }
  return results
}

function hasPresentResult(messages: readonly GenerateOptions['messages'][number][]): boolean {
  return messages.some((message) => {
    if (message.role !== 'tool') return false
    const text = messageText(message as Message)
    return text.startsWith('已生成结果页') || text.startsWith('artifact-') || text.includes('artifact-too-large')
  })
}

/** 当前回合的工具结果:上一个 user 消息(团长提示词)之后,排除历史回合的同名派工。 */
function turnMessages(messages: readonly GenerateOptions['messages'][number][]): readonly GenerateOptions['messages'][number][] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages.slice(index + 1)
  }
  return messages
}

/** 团长状态机:只读真实工具结果与场景裁决队列,派工参数使用真实 resultId。 */
function* leaderStream(run: RunScript, options: GenerateOptions): Generator<StreamChunk> {
  const currentTurn = turnMessages(options.messages)
  const dispatches = parseDispatchResults(currentTurn)
  const executes = dispatches.filter((item) => item.kind === 'execute')
  const reviews = dispatches.filter((item) => item.kind === 'review')
  const revisions = dispatches.filter((item) => item.kind === 'revision')
  const executedBoth = executes.length >= run.executorMemberIds.length

  if (run.failUntilBudgetExhausted) {
    if (dispatches.length < 24) {
      const memberId = run.executorMemberIds[dispatches.length % run.executorMemberIds.length]!
      yield* toolCallStream(dispatchCalls(run, [{ memberId, kind: 'execute', task: `第 ${String(dispatches.length + 1)} 次事实核对。` }]))
      return
    }
    if (!hasPresentResult(currentTurn)) {
      run.artifactPresented = true
      yield* toolCallStream([
        {
          name: 'result_present',
          args: {
            title: '合规审查报告(预算耗尽)',
            format: 'markdown',
            content: '# 合规审查报告\n\n## 结论\n执行成员已给出初步结论。\n\n## 失败与遗漏\n派工预算已耗尽,审查未完成。\n\n## 未解决项\n- 统一审查尚未执行。\n',
          },
        },
      ])
      return
    }
    run.finalSummary = '已提交部分报告。'
    yield* textStream(run.finalSummary)
    return
  }

  if (!executedBoth) {
    yield* toolCallStream(
      dispatchCalls(run, run.executorMemberIds.map((memberId) => ({ memberId, kind: 'execute', task: `提取并核对合同事实(${memberId})。` }))),
      run.transitionalText,
    )
    return
  }

  if (reviews.length === 0) {
    yield* toolCallStream(dispatchCalls(run, run.reviewers.map((memberId) => ({ memberId, kind: 'review', task: '统一合规审查。' }))))
    return
  }

  const latestReviews = reviews.filter((item) => item.status === 'completed')
  const needRevision = run.revisionsEmitted === 0 && latestReviews.some((item) => item.reviewVerdict === 'revise')
  if (needRevision) {
    const target = executes[0]
    if (target === undefined) {
      run.finalSummary = '缺少可返修的执行结果。'
      yield* textStream(run.finalSummary)
      return
    }
    run.revisionsEmitted += 1
    yield* toolCallStream(
      dispatchCalls(run, [
        {
          memberId: target.memberId,
          kind: 'revision',
          task: `根据审查意见返修:${reviews.find((item) => item.reviewVerdict === 'revise')?.raw.slice(0, 200) ?? ''}`,
          inputResultIds: [target.resultId],
          supersedesResultId: target.resultId,
        },
      ]),
    )
    return
  }

  if (revisions.length > 0 && reviews.length < run.reviewers.length * 2) {
    yield* toolCallStream(dispatchCalls(run, run.reviewers.map((memberId) => ({ memberId, kind: 'review', task: '返修后统一复审。' }))))
    return
  }

  if (run.mode === 'message') {
    run.finalSummary = '最终合规汇总'
    yield* textStream(run.finalSummary)
    return
  }

  if (!hasPresentResult(currentTurn)) {
    run.artifactPresented = true
    const content = run.failArtifactWrite
      ? `# 合规审查报告\n\n## 结论\n超限报告。\n\n## 失败与遗漏\n正文超出单文件上限。\n\n## 未解决项\n- 无。\n${'超限内容。'.repeat(700_000)}`
      : '# 合规审查报告\n\n## 结论\n两名执行成员已完成事实核对,统一审查通过。\n\n## 依据\n合同条款与付款条件均已核对。\n\n## 失败与遗漏\n无。\n\n## 未解决项\n- 法务复核建议在签署前完成。\n'
    yield* toolCallStream([
      {
        name: 'result_present',
        args: {
          title: '合规审查报告',
          format: 'markdown',
          content,
        },
      },
    ])
    return
  }

  run.finalSummary = run.failArtifactWrite
    ? '主报告提交失败,已在会话中说明。'
    : '已提交主报告。'
  yield* textStream(run.finalSummary)
}

function memberIdOf(prompt: string): string | undefined {
  return /^专家团成员：(\S+)/m.exec(prompt)?.[1]
}

async function* memberStream(run: RunScript, prompt: string): AsyncGenerator<StreamChunk> {
  const memberId = memberIdOf(prompt) ?? 'm-exec-1'
  const review = prompt.includes('审查要求：')
  run.activeMembers += 1
  run.maxMemberConcurrency = Math.max(run.maxMemberConcurrency, run.activeMembers)
  try {
    // 两个执行成员并行时让两路流同时在场,使并发上限由真实信号量决定并可见。
    if (!review) {
      const deadline = Date.now() + 150
      while (run.activeMembers < 2 && Date.now() < deadline) await delay(10)
    }
    if (review) {
      const assigned = run.verdictByMember.get(memberId) ?? []
      if (assigned.length === 0) {
        const next = run.verdictQueue.shift() ?? 'pass'
        assigned.push(next)
        run.verdictByMember.set(memberId, assigned)
      }
      const verdict = assigned.shift() ?? 'pass'
      const text = `审查意见(${memberId}):已逐项核对当前有效结果。\n[VERDICT: ${verdict === 'revise' ? 'REVISE' : 'PASS'}]`
      yield* textStream(text)
      return
    }
    const text = `执行结论(${memberId}):合同关键条款与付款条件已核对,未发现阻断性问题。`
    yield* textStream(text)
  } finally {
    run.activeMembers -= 1
  }
}

// ────────────────────────── run execution ──────────────────────────

function terminalStatus(status: ExpertTeamRun['status']): boolean {
  return status === 'completed' || status === 'completed_with_issues' || status === 'partial' || status === 'failed' || status === 'stopped'
}

async function waitForRunTerminal(
  runs: ExpertTeamRunRegistry,
  sessionId: string,
  clientMessageId: string,
): Promise<ExpertTeamRun> {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const run = runs.byTurn(sessionId, clientMessageId)
    if (run !== undefined && terminalStatus(run.status)) return run
    await delay(25)
  }
  const last = runs.byTurn(sessionId, clientMessageId)
  throw new Error(`timed out waiting for expert team run: ${last?.status ?? 'missing'}`)
}

function mcpAttachmentNames(ctx: Context, sessionId: string): string[] {
  const names = new Set<string>()
  for (const map of [ctx.huaanworkAttachments.sessionAgentTools, ctx.huaanworkAttachments.sessionHostTools]) {
    for (const name of map.get(sessionId) ?? []) {
      if (name.startsWith('mcp__')) names.add(name)
    }
  }
  return [...names]
}

function serverNameOfTool(toolName: string): string | undefined {
  return /^mcp__(.+)__[^_].*$/.exec(toolName)?.[1]
}

async function artifactOf(
  profileDir: string,
  sessionId: string,
  artifactId: string | undefined,
): Promise<ComplianceTeamSmokeResult['artifact']> {
  if (artifactId === undefined) return undefined
  const artifacts = await listArtifacts(profileDir, sessionId)
  const summary = artifacts.find((item) => item.artifactId === artifactId)
  if (summary === undefined) return undefined
  const content = await readArtifactContent(profileDir, sessionId, artifactId)
  return { title: summary.title, format: summary.format, content: content.toString('utf8') }
}

/**
 * 执行一次真实团队回合:真实 `session.send` → 真实包 activation → 脚本模型 →
 * `turn/end` 同步结算。返回可断言的真实投影与存储事实。
 */
export async function executeScriptedTeamRun(
  ctx: Context,
  packages: InstalledExpertTeamPackages,
  options: ComplianceTeamSmokeOptions,
): Promise<ComplianceTeamSmokeResult> {
  const runtime = requireRuntime(ctx)
  const reviewVerdicts = options.reviewVerdicts ?? ['pass']
  const team = await createExpertTeamDefinition(ctx, packages, {
    executionOrder: options.executionOrder ?? 'parallel',
    maxParallel: options.maxParallel ?? 2,
    delivery: options.delivery ?? 'artifact',
  })
  const executors = options.dualMcp === true ? packages.mcpExecutors : packages.executors
  // 团队定义已按普通包创建;dualMcp 时改写成员引用到 MCP 版本。
  if (options.dualMcp === true) {
    const rewritten = await ctx.huaanworkExpertTeamStore.update(team.id, {
      members: team.members.map((member) => {
        const index = member.memberId === 'm-exec-1' ? 0 : member.memberId === 'm-exec-2' ? 1 : -1
        if (member.role !== 'executor' || index < 0) return member
        return { ...member, agentRef: { source: 'local', slug: executors[index]?.slug ?? member.agentRef.slug } }
      }),
    })
    team.members = rewritten.members
  }
  const reviewerIds = team.members.filter((member) => member.role === 'reviewer').map((member) => member.memberId)
  const executorIds = team.members.filter((member) => member.role === 'executor').map((member) => member.memberId)
  const script = newRunScript(reviewerIds, executorIds, { ...options, reviewVerdicts })
  // `verdictQueue` 已在 newRunScript 中取 options.reviewVerdicts;这里保证恰好使用显式队列。
  script.verdictQueue = [...reviewVerdicts]
  const previousScript = currentScript(runtime)
  setScript(runtime, script)

  const previousParallel = ctx.agentLoop.config.maxParallelToolCalls.get()
  if (options.parentMaxParallelToolCalls !== undefined) {
    updateVolatile(ctx.agentLoop.config.maxParallelToolCalls, createVolatile(options.parentMaxParallelToolCalls))
  }

  const clientMessageId = randomUUID()
  try {
    const sent = await postLoopbackRoute(ctx, '/huaanwork/session/send', {
      text: `@team:${team.slug} 审查本季度合同与付款合规风险。`,
      tabId: `tab-${randomUUID().slice(0, 8)}`,
      clientMessageId,
      at: { kind: 'expert-team', name: team.slug },
    })
    if (sent.started !== true) throw new Error(`session.send did not start: ${JSON.stringify(sent)}`)
    const run = await waitForRunTerminal(ctx.huaanworkExpertTeamRuns, runtime.sessionId, clientMessageId)
    if (process.env.EXPERT_TEAM_DEBUG === '1') {
      console.log('RUN', JSON.stringify({
        status: run.status,
        failure: run.failure,
        toolResults: sessionMessages(ctx, runtime.sessionId)
          .filter((message) => message.role === 'tool')
          .map((message) => messageText(message).slice(0, 300)),
        results: run.results.map((result) => ({
          kind: result.kind,
          status: result.status,
          memberId: result.memberId,
          error: result.error,
          verdict: result.reviewVerdict,
          output: result.output?.slice(0, 60),
        })),
      }, null, 2))
    }
    await waitFor(
      () => !isAgentToolAttached(ctx.huaanworkAttachments, runtime.sessionId, EXPERT_TEAM_DISPATCH_TOOL),
      'team dispatch attachment detach',
      10_000,
    )
    const messages = sessionMessages(ctx, runtime.sessionId)
    const primaryArtifactIds = run.primaryArtifactId === undefined ? [] : [run.primaryArtifactId]
    const artifact = await artifactOf(runtime.profileDir, runtime.sessionId, run.primaryArtifactId)
    const memberMcpServers: ComplianceTeamSmokeResult['memberMcpServers'] = []
    for (const toolName of script.memberMcpServers.values()) {
      const serverName = serverNameOfTool(toolName)
      if (serverName === undefined) continue
      if (memberMcpServers.some((item) => item.serverName === serverName)) continue
      memberMcpServers.push({ serverName, toolName })
    }
    const dispatches: ComplianceTeamDispatchRecord[] = run.results.map((result) => ({
      kind: result.kind,
      memberId: result.memberId,
      resultId: result.resultId,
      status: result.status,
      ...(result.memberRunId === undefined ? {} : { memberRunId: result.memberRunId }),
      ...(result.reviewVerdict === undefined ? {} : { reviewVerdict: result.reviewVerdict }),
    }))
    let goalDispatchError: string | undefined
    try {
      await ctx.huaanworkExpertTeamCoordinator.dispatch({
        callId: `goal-after-settle-${randomUUID()}`,
        parentSessionId: runtime.sessionId,
        clientMessageId,
        memberId: executorIds[0] ?? 'm-exec-1',
        kind: 'execute',
        task: 'goal 续拍不应再派工',
      } satisfies ExpertTeamDispatchInput)
    } catch (error) {
      goalDispatchError = error instanceof Error ? error.message : String(error)
    }
    return {
      run,
      dispatches,
      memberRunIds: run.results.flatMap((result) => (result.memberRunId === undefined ? [] : [result.memberRunId])),
      maxMemberConcurrency: script.maxMemberConcurrency,
      parentMcpAttachments: mcpAttachmentNames(ctx, runtime.sessionId),
      parentMcpToolNames: [...script.parentMcpToolNames],
      memberMcpServers,
      primaryArtifactIds,
      artifact,
      parentNotifications: parentNotificationsOf(messages),
      finalSummary: finalSummaryOf(messages),
      dispatchAttachmentDetached: !isAgentToolAttached(ctx.huaanworkAttachments, runtime.sessionId, EXPERT_TEAM_DISPATCH_TOOL),
      goalDispatchError,
    }
  } finally {
    setScript(runtime, previousScript)
    if (options.parentMaxParallelToolCalls !== undefined) {
      updateVolatile(ctx.agentLoop.config.maxParallelToolCalls, createVolatile(previousParallel))
    }
  }
}

async function debugPackageList(ctx: Context): Promise<void> {
  const origin = loopbackOrigin(ctx)
  const response = await fetch(`${origin}/huaanwork/agent/package/list`, {
    headers: { origin, [RENDERER_HEADER.name]: RENDERER_HEADER.value },
  })
  console.log('PACKAGES', await response.text())
}

function currentScript(runtime: CompositionRuntime): RunScript | undefined {
  return (runtime as CompositionRuntime & { script?: ScriptRef }).script?.current
}

function setScript(runtime: CompositionRuntime, script: RunScript | undefined): void {
  const ref = (runtime as CompositionRuntime & { script?: ScriptRef }).script
  if (ref !== undefined) ref.current = script
}

/** 便捷入口:与 spec 同名的单次运行调用。 */
export function runComplianceTeamSmoke(
  scenario: ComplianceTeamScenario,
  options: ComplianceTeamSmokeOptions,
): Promise<ComplianceTeamSmokeResult> {
  return scenario.run(options)
}

// ────────────────────────── restart ──────────────────────────

export type RestartedComposition = {
  ctx: Context
  expertTeamRuns: ExpertTeamRun[]
  artifactIds: string[]
  messages: Array<{ role: string; text: string }>
}

/** 新 Host 从同一 profile 磁盘恢复的会话消息(重启后不依赖旧 generation 内存)。 */
function retainedMessages(ctx: Context, sessionId: string): Array<{ role: string; text: string }> {
  return sessionMessages(ctx, sessionId)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, text: messageText(message) }))
    .filter((message) => message.text.trim() !== '')
}

/**
 * 用同一 profile 重启 Host:dispose 旧 generation,重新 prepare + boot,读取磁盘上的
 * 留存事实。团队运行不持久化,新 registry 必须为空;消息与 Artifact 保留。
 */
export async function restartHostWithSameProfile(ctx: Context): Promise<RestartedComposition> {
  const runtime = requireRuntime(ctx)
  const { profileDir, home } = runtime
  const settingsBefore = readFileSync(runtime.settingsPath, 'utf8')
  await ctx.fiber.dispose()
  runtimes.delete(ctx)
  // 重启前重写 settings(旧 Host dispose 不会删除它,这里保证同一 profile 内容不变)。
  if (readFileSync(runtime.settingsPath, 'utf8') !== settingsBefore) {
    writeFileSync(runtime.settingsPath, settingsBefore)
  }
  const { prepared } = await prepareProfileResources(home)
  runtime.prepared = prepared
  const script: ScriptRef = { current: undefined }
  const nextCtx = await withTimeout(bootComposition(prepared, runtime, script), BOOT_TIMEOUT_MS, 'expert-team host restart')
  ;(runtime as CompositionRuntime & { ctx?: Context; script?: ScriptRef }).ctx = nextCtx
  ;(runtime as CompositionRuntime & { ctx?: Context; script?: ScriptRef }).script = script
  runtimes.set(nextCtx, runtime)
  await waitFor(() => sessionAgent(nextCtx, runtime.sessionId) !== undefined, 'restarted stable channel agent')
  const artifactIds = (await listArtifacts(profileDir, runtime.sessionId)).map((item) => item.artifactId)
  return {
    ctx: nextCtx,
    expertTeamRuns: nextCtx.huaanworkExpertTeamRuns.list({ sessionId: runtime.sessionId }).runs,
    artifactIds,
    messages: retainedMessages(nextCtx, runtime.sessionId),
  }
}

/** 场景定义所用团队(供 spec 读取;不是运行时快照)。 */
export function scenarioTeam(scenario: ComplianceTeamScenario): ExpertTeam {
  return scenario.team
}
