/**
 * M5 Task 3:huaanwork-market provider 接入的守门测试。
 *
 * 覆盖 Step 5 四项:
 *  1. provider 选中/解析(select/resolve + identity 三字段);
 *  2. 8 校验器文件镜像一致(向导契约/向导窗口/设置 route/设置面客户端往返,
 *     profile 偏好读写;App.tsx:355 与 DesktopSettingsSection.tsx 的校验器
 *     与上述联合同源,由 typecheck 联合 + 本文件往返共同兜住);
 *  3. fail-safe 默认仍为 disabled;
 *  4. IMMUTABLE_BUNDLES 拒绝卸载 market bundle。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_MARKET_IDENTITIES,
  desktopMarketSnapshotWithEffective,
  parseDesktopMarketState,
  readDesktopMarketStateForUserData,
  selectDesktopMarketProvider,
  type DesktopMarketSnapshot,
} from '../src/desktop-market.ts'
import {
  readDesktopProfilePreferences,
  writeDesktopProfilePreferences,
  type DesktopProfilePreferences,
} from '../src/profile-preferences.ts'
import {
  isDesktopSetupWizardSelection,
  type DesktopSetupWizardSelection,
} from '../src/setup-wizard-contract.ts'
import { parseDesktopSetupWizardAction } from '../src/setup-wizard-window.ts'
import { handleDesktopMarketSelectRequest } from '../src/desktop-settings-route.ts'
import DesktopSettingsController, {
  type DesktopSettingsControllerBootstrap,
} from '../src/desktop-settings-controller.ts'
import { parseDesktopSettingsView } from '../src/client/desktop-settings-api.ts'
import {
  IMMUTABLE_BUNDLES,
  removePlugin,
  type PluginMutationContext,
} from '../src/huaanwork-host/plugins-host.ts'
import type { DesktopPnpmHandle } from '../src/pnpm.ts'

const roots: string[] = []

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('huaanwork-market identity(M5 Task 3 Step 2)', () => {
  it('固化恰好三字段,不含内网 URL(URL 属 wrapper 配置层)', () => {
    expect(DESKTOP_MARKET_IDENTITIES.huaanworkMarket).toEqual({
      provider: 'huaanwork-market',
      rowId: 'huaanwork-market',
      packageName: 'dsh-plugin-huaanwork/huaanwork-market',
    })
    expect(Object.keys(DESKTOP_MARKET_IDENTITIES.huaanworkMarket)).toHaveLength(3)
    expect(JSON.stringify(DESKTOP_MARKET_IDENTITIES.huaanworkMarket)).not.toContain('http')
  })
})

describe('huaanwork-market provider 选中与解析(Step 1/5)', () => {
  it('selectDesktopMarketProvider 持久化并可读回,解析投影 effective', async () => {
    const userData = temporaryRoot('hw-market-provider-')
    const selected = await selectDesktopMarketProvider(userData, 'huaanwork-market')

    expect(selected).toEqual({
      requested: 'huaanwork-market',
      effective: 'huaanwork-market',
      legacyDefaulted: false,
    })
    expect(readDesktopMarketStateForUserData(userData)).toEqual(selected)

    const projected = desktopMarketSnapshotWithEffective(selected, 'huaanwork-market')
    expect(projected).toEqual(selected)
    const disabled = desktopMarketSnapshotWithEffective(selected, 'disabled')
    expect(disabled.requested).toBe('huaanwork-market')
    expect(disabled.effective).toBe('disabled')
  })

  it('parseDesktopMarketState 接受新 provider,拒绝仿冒值', () => {
    expect(parseDesktopMarketState({
      version: 1,
      requested: 'huaanwork-market',
      legacyDefaulted: false,
    }).requested).toBe('huaanwork-market')
    expect(() => parseDesktopMarketState({
      version: 1,
      requested: 'huaanwork_market',
      legacyDefaulted: false,
    })).toThrow('requested provider is invalid')
  })

  it('fail-safe 保持 disabled:缺失状态不迁移、不落盘', () => {
    const userData = temporaryRoot('hw-market-failsafe-')
    expect(readDesktopMarketStateForUserData(userData)).toEqual({
      requested: 'disabled',
      effective: 'disabled',
      legacyDefaulted: true,
    })
  })
})

const PREFERENCES: DesktopProfilePreferences = {
  mode: 'compatibility',
  openBrowser: true,
  networkExposure: 'loopback',
  aaEnabled: false,
  market: 'huaanwork-market',
  notifications: {
    enabled: false,
    notifyOnTurnCompletion: false,
    notifyOnTurnFailure: false,
    notifyOnJobCompletion: false,
    notifyOnJobFailure: false,
  },
}

describe('8 文件校验器镜像一致(Step 1/5)', () => {
  it('profile-preferences 读写往返接受 huaanwork-market', async () => {
    const userData = temporaryRoot('hw-market-prefs-userdata-')
    const profileDir = temporaryRoot('hw-market-prefs-profile-')

    const written = await writeDesktopProfilePreferences(userData, profileDir, PREFERENCES, '2026-09-26T00:00:00.000Z')
    expect(written.market).toBe('huaanwork-market')
    const read = readDesktopProfilePreferences(userData, profileDir)
    expect(read?.market).toBe('huaanwork-market')

    await expect(writeDesktopProfilePreferences(userData, profileDir, {
      ...PREFERENCES,
      market: 'huaanwork_market' as DesktopProfilePreferences['market'],
    })).rejects.toThrow('market must be disabled, community-market, dsh-market, or huaanwork-market')
  })

  it('向导契约 isDesktopSetupWizardSelection 接受新 provider', () => {
    const selection: DesktopSetupWizardSelection = {
      mode: 'compatibility',
      macosMaterial: 'off',
      windowsMaterial: 'off',
      openBrowser: true,
      networkExposure: 'loopback',
      aaEnabled: false,
      market: 'huaanwork-market',
      notifications: {
        enabled: false,
        notifyOnTurnCompletion: false,
        notifyOnTurnFailure: false,
        notifyOnJobCompletion: false,
        notifyOnJobFailure: false,
      },
    }
    expect(isDesktopSetupWizardSelection(selection)).toBe(true)
    expect(isDesktopSetupWizardSelection({ ...selection, market: 'huaanwork_market' })).toBe(false)
  })

  it('向导窗口 parseDesktopSetupWizardAction 往返不吞已选值', () => {
    const url = new URL('dsh-setup-wizard://complete')
    url.searchParams.set('mode', 'compatibility')
    url.searchParams.set('macosMaterial', 'off')
    url.searchParams.set('windowsMaterial', 'off')
    url.searchParams.set('openBrowser', 'true')
    url.searchParams.set('networkExposure', 'loopback')
    url.searchParams.set('market', 'huaanwork-market')
    url.searchParams.set('aaEnabled', 'false')
    url.searchParams.set('notificationsEnabled', 'false')
    url.searchParams.set('notifyOnTurnCompletion', 'false')
    url.searchParams.set('notifyOnTurnFailure', 'false')
    url.searchParams.set('notifyOnJobCompletion', 'false')
    url.searchParams.set('notifyOnJobFailure', 'false')

    const action = parseDesktopSetupWizardAction(url.href)
    expect(action).toEqual({
      action: 'complete',
      selection: expect.objectContaining({ market: 'huaanwork-market' }),
    })

    const forged = new URL(url.href)
    forged.searchParams.set('market', 'huaanwork_market')
    expect(parseDesktopSetupWizardAction(forged.href)).toBeUndefined()
  })

  it('设置 route 接受并透传新 provider,拒绝仿冒值', async () => {
    const persisted: string[] = []
    const controller = new DesktopSettingsController(settingsBootstrap({
      selectMarket: async provider => {
        persisted.push(provider)
        return marketSnapshot(provider)
      },
    }))

    const accepted = settingsResponse()
    await handleDesktopMarketSelectRequest(
      settingsJsonRequest({ provider: 'huaanwork-market' }), accepted, SETTINGS_ORIGIN, controller,
    )
    expect(accepted.statusCode).toBe(202)
    expect(JSON.parse(accepted.body)).toEqual({ accepted: true, restartRequired: true })
    expect(persisted).toEqual(['huaanwork-market'])

    const rejected = settingsResponse()
    await handleDesktopMarketSelectRequest(
      settingsJsonRequest({ provider: 'huaanwork_market' }), rejected, SETTINGS_ORIGIN, controller,
    )
    expect(rejected.statusCode).toBe(400)
    expect(persisted).toEqual(['huaanwork-market'])
  })

  it('设置面客户端 parseDesktopSettingsView 接受新 provider 往返', () => {
    const view = parseDesktopSettingsView({
      current: 'desktop',
      profiles: [{ name: 'desktop', exists: true, webCapable: true, selectable: true, deletable: false }],
      aa: { requested: false, effective: false },
      market: { requested: 'huaanwork-market', effective: 'huaanwork-market', legacyDefaulted: false },
      web: {
        localUrl: 'http://127.0.0.1:43120/?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        lanUrls: [],
        lanState: 'inactive',
        lanError: null,
        lanCaFingerprint: null,
        lanCaUrls: [],
      },
    })
    expect(view.market.requested).toBe('huaanwork-market')
    expect(() => parseDesktopSettingsView({
      current: 'desktop',
      profiles: [],
      market: { requested: 'huaanwork_market', effective: 'huaanwork-market', legacyDefaulted: false },
      web: {
        localUrl: 'http://127.0.0.1:43120/?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        lanUrls: [],
        lanState: 'inactive',
        lanError: null,
        lanCaFingerprint: null,
        lanCaUrls: [],
      },
    })).toThrow('invalid Desktop settings response')
  })
})

describe('IMMUTABLE_BUNDLES 拒绝卸载 market bundle(Step 4/5)', () => {
  it('removePlugin 拒卸 huaanwork-market,不调用 pnpm、不改 profile', async () => {
    const profileDir = temporaryRoot('hw-market-immutable-')
    const manifest = join(profileDir, 'package.json')
    const before = JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
    writeFileSync(manifest, `${before}\n`)

    expect(IMMUTABLE_BUNDLES.has('huaanwork-market')).toBe(true)
    const runPlugin = vi.fn(() => completedPnpmHandle())
    const ctx: PluginMutationContext = {
      profileDir,
      logger: vi.fn(),
      requestRestart: vi.fn(async () => true),
      desktopPnpm: { runPlugin },
    }

    await expect(removePlugin(ctx, 'huaanwork-market'))
      .rejects.toThrow('cannot remove protected package huaanwork-market')
    expect(runPlugin).not.toHaveBeenCalled()
    expect(ctx.requestRestart).not.toHaveBeenCalled()
    expect(readFileSync(manifest, 'utf8')).toBe(`${before}\n`)
  })
})

// ---- settings route 测试的局部 helper(与 tests/desktop-settings-api.spec.ts 同构) ----

const SETTINGS_ORIGIN = 'http://127.0.0.1:43120'

function marketSnapshot(
  requested: DesktopMarketSnapshot['requested'] = 'disabled',
  effective: DesktopMarketSnapshot['effective'] = requested,
  legacyDefaulted = false,
): DesktopMarketSnapshot {
  return { requested, effective, legacyDefaulted }
}

function settingsBootstrap(
  overrides: Partial<DesktopSettingsControllerBootstrap> = {},
): DesktopSettingsControllerBootstrap {
  return {
    profiles: {
      current: { name: 'desktop', dir: '/private/profiles/desktop' },
      list: () => [],
      create: name => ({
        name,
        dir: `/private/profiles/${name}`,
        exists: true,
        bundles: ['@deepseek-ai/dsh-web-app'],
        webCapable: true,
      }),
      prepareSelection: async () => ({ restartRequired: true, restart: async () => {} }),
    },
    readMarket: () => marketSnapshot(),
    readWeb: () => ({
      localUrl: 'http://127.0.0.1:43120/?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      lanUrls: [],
      lanState: 'inactive',
      lanError: null,
      lanCaFingerprint: null,
      lanCaUrls: [],
    }),
    selectMarket: async provider => marketSnapshot(provider),
    scheduleRestart: () => {},
    scheduleRecoveryRestart: () => {},
    openTerminal: () => {},
    reloadRenderer: () => {},
    toggleDeveloperTools: () => {},
    exportDiagnostics: async () => {},
    ...overrides,
  }
}

function settingsRequest(body: string): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage
  req.method = 'POST'
  req.headers = {
    host: '127.0.0.1:43120',
    origin: SETTINGS_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  }
  Object.defineProperty(req, 'socket', {
    configurable: true,
    value: { remoteAddress: '127.0.0.1' },
  })
  return req
}

function settingsJsonRequest(value: unknown): IncomingMessage {
  return settingsRequest(JSON.stringify(value))
}

function settingsResponse(): ServerResponse & { body: string } {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

// ---- plugins-host 测试的局部 helper(与 tests/huaanwork-host/plugins-host.spec.ts 同构) ----

function completedPnpmHandle(): DesktopPnpmHandle {
  return {
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    done: Promise.resolve({ exitCode: 0, signal: null }),
    cancel() {},
  }
}
