/**
 * 端到端迁移回归门(Task 2.9):一份完整的旧 Tauri 布局 → 新 profile 布局。
 *
 * 这是 Phase 2「11 类数据只搬一次、旧树不被触碰」的唯一有效回归门:fixture 播种
 * 真实形状的旧树(含三类会话日志、zstd 帧容器、被排除的 legacy 私有文件),
 * 断言逐类目的文件、中性根 id 重铸的全部反引用、marker 的诚实计数与幂等。
 *
 * 失败路由只做纯函数断言(`routeDesktopStartupFailure`):main.ts 的钩子本体是
 * Electron 主进程面,本 spec 无法启动它;「抛错能到达恢复窗口」由该路由断言钉住。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  HUAANWORK_MIGRATION_STEPS,
  describeMigrationForUser,
  parseLegacyPluginBundles,
  runHuaanworkLegacyMigration,
  type HuaanworkMigrationReport,
  type HuaanworkMigrationStep,
} from '../../src/huaanwork-migration/index.ts'
import { resolveLegacySource, type HuaanworkLegacySource, type HuaanworkMigrationTarget } from '../../src/huaanwork-migration/paths.ts'
import { projectKey } from '../../src/huaanwork-migration/sessions.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { decompressZstdFrames, parseSessionHeader } from '../../src/huaanwork-host/session-view.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'
import { routeDesktopStartupFailure } from '../../src/startup-failure-routing.ts'

/** 逐帧压缩、拼接的会话日志:读侧 `decompressZstdFrames` 依赖的真实容器形状。 */
function writeZstdSession(dir: string, sessionId: string, cwd: string): void {
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session', version: 0, id: sessionId, createdAt: 1_700_000_000_000, cwd, delegationDepth: 0,
  })
  const body = [header, JSON.stringify({ type: 'turn', index: 0 }), JSON.stringify({ type: 'turn', index: 1 })]
  writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(body.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))))
}

/** 完整真实的旧 Tauri 布局(计划 Task 2.9 Step 1 的 fixture)。 */
function seedLegacyTree(userData: string): void {
  const dshHome = join(userData, 'dsh')
  // config dir(F2:三个文件在 dirname($DSH_HOME))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    base_url: 'http://127.0.0.1:11434/v1', model: 'llama3', api_key: 'k', theme: 'dark',
    models: [], active_model_id: '', work_allow_network: true, guard_mode: 'smart',
    automation_timeout_ms: 600000, keep_awake: true, agents_host: '192.168.1.5',
    agents_port: 8787, agents_catalog_token: 'tok',
  }), 'utf8')
  writeFileSync(join(userData, 'account.json'), JSON.stringify({
    username: 'u', salt: 's', hash: 'h', kdf: 'scrypt', N: 16384, r: 8, p: 1,
  }), 'utf8')
  writeFileSync(join(userData, 'auth-session.json'), JSON.stringify({ username: 'u' }), 'utf8')
  // $DSH_HOME
  mkdirSync(join(dshHome, 'automations'), { recursive: true })
  writeFileSync(join(dshHome, 'projects.json'), JSON.stringify({
    projects: [
      { id: 'p1', name: 'proj', root: join(userData, 'proj'), createdAt: 1 },
    ],
  }), 'utf8')
  writeFileSync(join(dshHome, 'tasks.json'), JSON.stringify({
    tasks: [
      { id: 't1', projectId: 'p1', name: 'task', createdAt: 1, sessionId: sessionIdFor(join(dshHome, 'workspace')) },
    ],
  }), 'utf8')
  writeFileSync(join(dshHome, 'automations.json'), JSON.stringify({
    automations: [
      {
        id: 'a1', projectId: null, name: 'auto', kind: 'agent', schedule: { kind: 'manual' },
        widget: false, enabled: true, createdAt: 1, channel: 'chat',
      },
    ],
  }), 'utf8')
  writeFileSync(join(dshHome, 'automations', 'a1.runs.jsonl'),
    `${JSON.stringify({ runId: 'r1', startedAt: 1, endedAt: 2, ok: true, output: 'ok', sessionId: sessionIdFor(join(dshHome, 'workspace')) })}\n`, 'utf8')
  writeFileSync(join(dshHome, 'automations', 'a1.audit.jsonl'),
    `${JSON.stringify({ at: 1, runId: 'r1', tool: 'run_code', callId: 'c1', decision: 'ask→allow' })}\n`, 'utf8')
  writeFileSync(join(dshHome, 'agents-enabled.json'), JSON.stringify({ enabled: ['x'] }), 'utf8')
  writeFileSync(join(dshHome, 'agents-endpoints.json'), JSON.stringify({ endpoints: [] }), 'utf8')
  writeFileSync(join(dshHome, 'skill-toggles.json'), JSON.stringify({ explore: true }), 'utf8')
  mkdirSync(join(dshHome, 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(dshHome, 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8')
  mkdirSync(join(dshHome, 'workspace'), { recursive: true })
  writeFileSync(join(dshHome, 'workspace', 'notes.md'), 'notes\n', 'utf8')
  // 四类会话:中性根(需重铸)、项目根、legacy chat、自动化运行会话(均原样搬运)
  const neutral = sessionIdFor(join(dshHome, 'workspace'))
  writeZstdSession(join(dshHome, 'sessions', projectKey(join(dshHome, 'workspace')), neutral), neutral, join(dshHome, 'workspace'))
  const projectRoot = join(userData, 'proj')
  mkdirSync(projectRoot, { recursive: true })
  const projectId = sessionIdFor(projectRoot)
  writeZstdSession(join(dshHome, 'sessions', projectKey(projectRoot), projectId), projectId, projectRoot)
  writeZstdSession(join(dshHome, 'sessions', projectKey(projectRoot), 'huaanwork-chat-9f8e7d6c5b4a3210'), 'huaanwork-chat-9f8e7d6c5b4a3210', projectRoot)
  writeZstdSession(join(dshHome, 'sessions', projectKey(projectRoot), 'huaanwork-auto-a1-r1'), 'huaanwork-auto-a1-r1', projectRoot)
  // 明确不迁移的
  writeFileSync(join(dshHome, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(join(dshHome, 'cordis.patch.yml'), 'patches: []\n', 'utf8')
  mkdirSync(join(dshHome, 'logs'), { recursive: true })
  writeFileSync(join(dshHome, 'logs', 'plugin.log'), 'noise\n', 'utf8')
  mkdirSync(join(dshHome, 'profiles', 'huaanwork'), { recursive: true })
  writeFileSync(join(dshHome, 'profiles', 'huaanwork', 'package.json'),
    JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['legacy-plugin'] } } }), 'utf8')
}

interface Fixture {
  readonly userData: string
  readonly dshHome: string
  readonly homeDir: string
  readonly profileDir: string
  readonly source: HuaanworkLegacySource
  readonly target: HuaanworkMigrationTarget
}

function fixture(): Fixture {
  const userData = mkdtempSync(join(tmpdir(), 'mig-e2e-userdata-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'mig-e2e-home-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  seedLegacyTree(userData)
  return {
    userData,
    dshHome: join(userData, 'dsh'),
    homeDir,
    profileDir,
    source: resolveLegacySource(userData),
    target: { homeDir, profileDir },
  }
}

function migrate(f: Fixture): Promise<HuaanworkMigrationReport> {
  return runHuaanworkLegacyMigration({ source: f.source, target: f.target, steps: HUAANWORK_MIGRATION_STEPS })
}

/** 读回一份日志的首行(与读侧同源:zstd 走逐帧解压)。 */
function firstLine(path: string): string {
  const bytes = readFileSync(path)
  const text = path.endsWith('.zstd') ? decompressZstdFrames(bytes) : bytes.toString('utf8')
  return text.split('\n', 1)[0] ?? ''
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** 递归快照:目录记 `dir`,`path → sha256` 逐文件;用于「旧树逐字节不变」与幂等断言。 */
function snapshotTree(root: string): string[] {
  const entries: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        entries.push(`${key}/ dir`)
        walk(path, key)
      } else if (entry.isFile()) {
        entries.push(`${key} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
      }
    }
  }
  walk(root, '')
  return entries.sort()
}

const carriedSessionPath = (f: Fixture, sessionId: string): string =>
  join(f.homeDir, 'sessions', projectKey(join(f.userData, 'proj')), sessionId, 'session.jsonl.zstd')

describe('full legacy migration', () => {
  it('migrates every documented class into the new layout', async () => {
    const f = fixture()
    const report = await migrate(f)
    expect(report.performed).toBe(true)
    // 注册顺序即执行顺序(sessions 必须先于 tasks/runs,skill-toggles 先于 user-skills)。
    expect(HUAANWORK_MIGRATION_STEPS.map(step => step.name)).toEqual([
      'settings', 'auth', 'sessions', 'projects', 'tasks', 'automations', 'automation-runs',
      'agents-config', 'skill-toggles', 'user-skills', 'neutral-workspace',
    ])

    expect(readJson(join(f.profileDir, 'huaanwork-settings.json'))).toMatchObject({
      base_url: 'http://127.0.0.1:11434/v1', model: 'llama3', api_key: 'k', theme: 'dark',
      models: [], active_model_id: '', guard_mode: 'smart', automation_timeout_ms: 600000,
      keep_awake: true, agents_host: '192.168.1.5', agents_port: 8787, agents_catalog_token: 'tok',
    })
    expect(readJson(join(f.profileDir, 'account.json'))).toEqual({
      username: 'u', salt: 's', hash: 'h', kdf: 'scrypt', N: 16384, r: 8, p: 1,
    })
    expect(readJson(join(f.profileDir, 'projects.json'))).toEqual({
      projects: [{ id: 'p1', name: 'proj', root: join(f.userData, 'proj'), createdAt: 1 }],
    })
    expect(readJson(join(f.profileDir, 'tasks.json'))).toMatchObject({
      tasks: [{ id: 't1', projectId: 'p1', name: 'task', createdAt: 1 }],
    })
    expect(readJson(join(f.profileDir, 'automations.json'))).toMatchObject({
      automations: [{
        id: 'a1', projectId: null, name: 'auto', kind: 'agent', schedule: { kind: 'manual' },
        widget: false, enabled: true, createdAt: 1,
      }],
    })
    expect(JSON.parse(firstLine(join(f.profileDir, 'automations', 'a1.runs.jsonl')))).toMatchObject({
      runId: 'r1', startedAt: 1, endedAt: 2, ok: true, output: 'ok',
    })
    expect(JSON.parse(firstLine(join(f.profileDir, 'automations', 'a1.audit.jsonl')))).toMatchObject({
      at: 1, runId: 'r1', tool: 'run_code', callId: 'c1', decision: 'ask→allow',
    })
    expect(readJson(join(f.profileDir, 'agents-enabled.json'))).toEqual({ enabled: ['x'] })
    expect(readJson(join(f.profileDir, 'agents-endpoints.json'))).toEqual({ endpoints: [] })
    expect(readJson(join(f.profileDir, 'skill-toggles.json'))).toEqual({ explore: true })
    expect(readFileSync(join(f.profileDir, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n')
    expect(readFileSync(join(f.profileDir, 'workspace', 'notes.md'), 'utf8')).toBe('notes\n')
  })

  it('re-mints the neutral-root session and rebinds every back-reference to it', async () => {
    const f = fixture()
    await migrate(f)
    const oldRoot = join(f.dshHome, 'workspace')
    const oldId = sessionIdFor(oldRoot)
    const newRoot = neutralWorkspaceRoot(f.profileDir)
    const newId = sessionIdFor(newRoot)
    expect(newId).not.toBe(oldId)

    expect((readJson(join(f.profileDir, 'tasks.json')).tasks as Array<{ sessionId: string }>)[0]?.sessionId).toBe(newId)
    expect(JSON.parse(firstLine(join(f.profileDir, 'automations', 'a1.runs.jsonl')))).toMatchObject({ sessionId: newId })

    const reminted = join(f.homeDir, 'sessions', projectKey(newRoot), newId, 'session.jsonl.zstd')
    expect(existsSync(reminted)).toBe(true)
    const header = JSON.parse(firstLine(reminted)) as { id: string; cwd: string; version: number }
    expect(header.id).toBe(newId)
    expect(header.cwd).toBe(newRoot)
    expect(header.version).toBe(0)
    // 旧中性 id 的目录在目的树中不存在(旧 id 已被重铸,不能留下不可达的副本)。
    expect(existsSync(join(f.homeDir, 'sessions', projectKey(oldRoot), oldId))).toBe(false)
  })

  it('carries project-rooted, legacy-chat and automation sessions verbatim', async () => {
    const f = fixture()
    await migrate(f)
    const projectRoot = join(f.userData, 'proj')
    const carried = [sessionIdFor(projectRoot), 'huaanwork-chat-9f8e7d6c5b4a3210', 'huaanwork-auto-a1-r1']
    for (const id of carried) {
      const path = carriedSessionPath(f, id)
      expect(existsSync(path)).toBe(true)
      const header = parseSessionHeader(firstLine(path))
      expect(header?.id).toBe(id)
      expect(header?.cwd).toBe(projectRoot)
    }
  })

  it('applies the one-shot work_allow_network fallback', async () => {
    const f = fixture()
    await migrate(f)
    const settings = readJson(join(f.profileDir, 'huaanwork-settings.json'))
    expect(settings.allow_network).toBe(true)
    expect(settings).not.toHaveProperty('work_allow_network')
  })

  it('expires the auth session', async () => {
    const f = fixture()
    await migrate(f)
    expect(existsSync(join(f.profileDir, 'account.json'))).toBe(true)
    expect(existsSync(join(f.profileDir, 'auth-session.json'))).toBe(false)
  })

  it('strips the legacy automation channel field', async () => {
    const f = fixture()
    await migrate(f)
    const automations = readJson(join(f.profileDir, 'automations.json')).automations as Array<Record<string, unknown>>
    expect(automations).toHaveLength(1)
    expect(automations[0]).not.toHaveProperty('channel')
    expect(Object.keys(automations[0] ?? {}).sort()).toEqual([
      'createdAt', 'enabled', 'id', 'kind', 'name', 'projectId', 'schedule', 'widget',
    ])
  })

  it('copies the audit trail next to the runs (G5)', async () => {
    const f = fixture()
    await migrate(f)
    const auditPath = join(f.profileDir, 'automations', 'a1.audit.jsonl')
    expect(existsSync(auditPath)).toBe(true)
    expect(JSON.parse(firstLine(auditPath))).toMatchObject({ runId: 'r1', decision: 'ask→allow' })
  })

  it('migrates the four high-value gaps G1-G4', async () => {
    const f = fixture()
    await migrate(f)
    expect(existsSync(join(f.profileDir, 'agents-enabled.json'))).toBe(true)
    expect(existsSync(join(f.profileDir, 'agents-endpoints.json'))).toBe(true)
    expect(existsSync(join(f.profileDir, 'skill-toggles.json'))).toBe(true)
    expect(existsSync(join(f.profileDir, 'skills', 'alpha', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(f.profileDir, 'workspace', 'notes.md'))).toBe(true)
  })

  it('does not migrate the explicitly excluded set', async () => {
    const f = fixture()
    const report = await migrate(f)
    // 迁移本身从不写这几项(目的树内若出现,只能来自 prepareDesktopProfile —— 本 spec 不运行它)。
    expect(existsSync(join(f.profileDir, 'cordis.yml'))).toBe(false)
    expect(existsSync(join(f.profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(f.profileDir, 'logs'))).toBe(false)
    expect(existsSync(join(f.profileDir, 'profiles', 'huaanwork'))).toBe(false)
    expect(report.marker?.notMigrated).toEqual(expect.arrayContaining([
      'cordis.yml', 'cordis.patch.yml', 'logs/plugin.log', 'logs/sidecar.log',
      'auth-session.json', 'profiles/huaanwork',
    ]))
  })

  it('records the not-migrated legacy plugins so the user can reinstall them', async () => {
    const f = fixture()
    const report = await migrate(f)
    expect(report.marker?.notMigrated).toContain('legacy-plugin')
    expect(describeMigrationForUser(report.marker!)).toContain('legacy-plugin')
    expect(describeMigrationForUser(report.marker!)).toContain('插件市场')
  })

  it('writes the marker with honest counts', async () => {
    const f = fixture()
    const report = await migrate(f)
    expect(report.marker?.version).toBe(1)
    expect(report.marker?.source).toEqual({ configDir: f.userData, dshHome: f.dshHome })
    expect(report.marker?.counts).toEqual({
      settings: 1, account: 1,
      sessions: 4, sessionsReminted: 1, sessionsCarried: 3,
      projects: 1, tasks: 1, tasksRebound: 1,
      automations: 1, automationsChannelStripped: 1,
      runs: 1, runsRebound: 1, audit: 1,
      agentsEnabled: 1, agentsEndpoints: 1, skillToggles: 1, skills: 1, workspaceFiles: 1,
    })
    expect(report.marker?.skipped).toEqual(['auth-session.json: intentionally expired'])
  })

  it('is a no-op on the second launch', async () => {
    const f = fixture()
    const first = await migrate(f)
    const destinationBefore = snapshotTree(f.homeDir)
    const second = await migrate(f)
    expect(second.performed).toBe(false)
    expect(second.marker).toEqual(first.marker)
    expect(snapshotTree(f.homeDir)).toEqual(destinationBefore)
  })

  it('is a no-op when no legacy source exists', async () => {
    // 干净安装:config dir 与旧 `$DSH_HOME` 都不存在(用户从未装过旧版)——
    // 迁移必须原地退出,不写任何目的文件,更不留 marker。
    const userData = mkdtempSync(join(tmpdir(), 'mig-e2e-clean-userdata-'))
    const homeDir = mkdtempSync(join(tmpdir(), 'mig-e2e-clean-home-'))
    const profileDir = join(homeDir, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    const report = await runHuaanworkLegacyMigration({
      source: resolveLegacySource(userData),
      target: { homeDir, profileDir },
      steps: HUAANWORK_MIGRATION_STEPS,
    })
    expect(report.performed).toBe(false)
    expect(report.marker).toBeNull()
    expect(existsSync(join(profileDir, 'huaanwork-migration.json'))).toBe(false)
  })

  it('leaves the legacy tree completely untouched', async () => {
    const f = fixture()
    const before = snapshotTree(f.userData)
    await migrate(f)
    expect(snapshotTree(f.userData)).toEqual(before)
  })

  it('rethrows and writes no marker when a step fails', async () => {
    const f = fixture()
    const failing: HuaanworkMigrationStep = {
      name: 'failing',
      async run() { throw new Error('disk on fire') },
    }
    await expect(runHuaanworkLegacyMigration({
      source: f.source,
      target: f.target,
      steps: [...HUAANWORK_MIGRATION_STEPS.slice(0, 3), failing],
    })).rejects.toThrow('disk on fire')
    expect(existsSync(join(f.profileDir, 'huaanwork-migration.json'))).toBe(false)
    // 已写入的目的文件保留:重跑由 per-file skip 承接,marker 缺席即「未迁移完成」。
    expect(existsSync(join(f.profileDir, 'huaanwork-settings.json'))).toBe(true)
  })

  it('routes a migration throw at startupStage=profile-selection to startup-recovery', () => {
    // 恢复窗口在 profile 物化前的可达性:main.ts 钩子位于 startupStage='profile-selection',
    // app.isReady() 为真 ⇒ 抛错必须落进恢复窗口(spec §8「报错并进恢复窗口」)。
    expect(routeDesktopStartupFailure({ appReady: true, stage: 'profile-selection' })).toBe('startup-recovery')
    // 阴性对照:进程尚未 ready 时只写 stderr,不尝试打开窗口。
    expect(routeDesktopStartupFailure({ appReady: false, stage: 'profile-selection' })).toBe('stderr-only')
  })
})

describe('legacy plugin bundles (D-M6-6)', () => {
  it('reads dsh.profile.bundles, dedupes, and keeps only non-empty strings', () => {
    expect(parseLegacyPluginBundles(JSON.stringify({ dsh: { profile: { bundles: ['a', 'a', '', 'b'] } } }))).toEqual(['a', 'b'])
  })

  it('returns nothing for a missing or malformed manifest', () => {
    expect(parseLegacyPluginBundles(null)).toEqual([])
    expect(parseLegacyPluginBundles('not json')).toEqual([])
    expect(parseLegacyPluginBundles('[]')).toEqual([])
    expect(parseLegacyPluginBundles(JSON.stringify({ dsh: { profile: { bundles: 'legacy-plugin' } } }))).toEqual([])
    expect(parseLegacyPluginBundles(JSON.stringify({ name: 'p' }))).toEqual([])
  })

  it('omits plugin names from the marker when the old manifest file is absent', async () => {
    const f = fixture()
    rmSync(join(f.dshHome, 'profiles', 'huaanwork', 'package.json'))
    const report = await migrate(f)
    expect(report.marker?.notMigrated).toEqual([
      'cordis.yml', 'cordis.patch.yml', 'logs/plugin.log', 'logs/sidecar.log', 'auth-session.json', 'profiles/huaanwork',
    ])
  })
})

describe('describeMigrationForUser', () => {
  it('states what was not found and that a re-login is required', () => {
    const text = describeMigrationForUser({
      version: 1, migratedAt: '2026-09-29T00:00:00.000Z',
      source: { configDir: '/u', dshHome: '/u/dsh' },
      counts: {}, skipped: [], notMigrated: [],
    })
    expect(text).toContain('未找到可迁移的旧版数据。')
    expect(text).toContain('需要重新登录一次。')
    expect(text).not.toContain('未迁移:')
  })

  it('names the migrated classes, the skipped count and the not-migrated plugins', () => {
    const text = describeMigrationForUser({
      version: 1, migratedAt: '2026-09-29T00:00:00.000Z',
      source: { configDir: '/u', dshHome: '/u/dsh' },
      counts: { settings: 1, sessions: 4, audit: 0 },
      skipped: ['auth-session.json: intentionally expired'],
      notMigrated: ['cordis.yml', 'legacy-plugin'],
    })
    expect(text).toContain('已从旧版华安工作台迁移:settings 1、sessions 4。')
    expect(text).toContain('跳过 1 项')
    expect(text).toContain('未迁移:cordis.yml、legacy-plugin。旧版安装的插件需在插件市场重新安装。')
  })
})
