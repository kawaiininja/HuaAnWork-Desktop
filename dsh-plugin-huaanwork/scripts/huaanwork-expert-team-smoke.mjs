/**
 * Compiled-artifact smoke for the expert team feature.
 *
 * Boots the published Desktop profile through the real Loader -- the same
 * sequence `verify-profile-boot.mjs` uses, including its patch composition and
 * cleanup order -- then asserts that `expert_team_dispatch` reached the real
 * ToolRegistry and that the expert-team list/invocable routes answer on the
 * live web server. The model is never called: no provider, network, or API key
 * is involved.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { installDesktopPnpmRuntime } from '../lib/desktop-runtime-environment.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'
import { DesktopProfileService } from '../lib/profile-service.js'
import { createDesktopProfileBoot } from '../lib/profile-context.js'

const BIN_NAME = 'dsh-plugin-huaanwork-expert-team-smoke'
/** Loader entry id of the Desktop shell row, which 0.1.7 uses as its settings namespace. */
const DESKTOP_SETTINGS_ENTRY_ID = 'desktop-shell'
/**
 * The Desktop row as the profile's own patch layer carries it. The smoke seeds
 * the advanced-mode row exactly where the one-shot settings import leaves it,
 * because startup mode resolves from that patch layer, not from `settings.yaml`.
 */
const DESKTOP_SHELL_PATCH_ENTRY = Object.freeze({
  id: DESKTOP_SETTINGS_ENTRY_ID,
  name: 'dsh-plugin-huaanwork',
  config: Object.freeze({ mode: 'advanced' }),
})

let ordinaryBrowserEnabled = false
const BROWSER_ACCESS = Object.freeze({
  get ordinaryBrowserEnabled() { return ordinaryBrowserEnabled },
  rendererHeader: Object.freeze({
    name: 'x-dsh-desktop-renderer',
    value: Buffer.alloc(32, 2).toString('base64url'),
  }),
  setOrdinaryBrowserEnabled(enabled) { ordinaryBrowserEnabled = enabled },
})
const LAN_HTTPS_SNAPSHOT = Object.freeze({
  state: 'inactive',
  actualPort: null,
  addresses: Object.freeze([]),
  caFingerprint: null,
  errorCode: null,
})
const LAN_HTTPS = Object.freeze({
  caCertificate: null,
  attach() {},
  snapshot() { return LAN_HTTPS_SNAPSHOT },
  async setEnabled() { return LAN_HTTPS_SNAPSHOT },
  async stop() { return LAN_HTTPS_SNAPSHOT },
})
const home = mkdtempSync(join(tmpdir(), 'dsh-expert-team-smoke-'))
let ctx
let releasePackageResolver
let pnpmRuntime
let mountedSpec

try {
  writeFileSync(join(home, 'settings.yaml'), [
    'dsh-desktop:',
    '  mode: advanced',
    'agent-presets:',
    '  default: minimal',
    '',
  ].join('\n'))
  writeFileSync(
    prepareDesktopProfile('1', home, 'win32').profile.patchPath,
    JSON.stringify([DESKTOP_SHELL_PATCH_ENTRY]),
  )
  const prepared = prepareDesktopProfile('1', home, 'win32')
  prepared.overlays = [
    // The smoke's explicit Profile home must also own account credentials.
    { id: 'credentials', config: { dshHome: home } },
  ]
  // `cordis.patch.yml` already inserts `desktop-shell` through `prepared.patches`.
  // Appending `{ insert: [DESKTOP_SHELL_PATCH_ENTRY] }` here would duplicate the
  // row and break boot; keep the composition identical to verify-profile-boot.
  const patches = [...prepared.patches, ...prepared.overlays]
  process.env.DSH_HOME = home
  const packageRoot = new URL('../', import.meta.url)
  const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(
    readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8'),
  ).version
  pnpmRuntime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    stateDir: join(home, 'runtime-commands'),
    environment: process.env,
  })
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = {
    platform: 'win32',
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('expert-team smoke must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
      runtime.setLocalePreference(mountedSpec.readLocalePreference())
    },
    show() {},
    registerTrayItem() {
      return { refresh() {}, dispose() {} }
    },
    openTerminal() {},
    setLocalePreference(preference) { runtime.locale = preference ?? 'en' },
    setThemeSource() {},
    async requestRestart() {},
    // huaanwork-host refuses to boot unless desktopRuntime can return a
    // confirmed-restart verdict. Beta's shell does not call that method.
    async requestConfirmedRestart() { return true },
    prepareToQuit() {},
  }
  const pnpmBootstrap = {
    activeProfileName: 'desktop',
    activeProfileDir: prepared.profile.dir,
    homeDir: prepared.homeDir,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    nodeBinDir: pnpmRuntime.nodeBinDir,
    nodeShimPath: pnpmRuntime.nodeShimPath,
    clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
    dshBootstrapPath: fileURLToPath(new URL('../lib/desktop-cli.js', import.meta.url)),
  }
  const profileBoot = createDesktopProfileBoot(prepared, pnpmBootstrap)
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    patches,
    async (host) => {
      profileBoot.prepare(host)
      // Match the public resolver path used by packaged Electron.
      host.loader.internal = undefined
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopBrowserAccess', BROWSER_ACCESS)
      host.provide('desktopLanHttps', LAN_HTTPS)
      host.provide('desktopRuntime', runtime)
      host.provide('desktopPnpmBootstrap', pnpmBootstrap)
      await host.plugin(DesktopProfileService, {
        current: {
          name: 'desktop',
          dir: prepared.profile.dir,
        },
        list: () => [{
          name: 'desktop',
          dir: prepared.profile.dir,
          exists: true,
          bundles: prepared.profile.layers.map(layer => layer.packageName),
          webCapable: true,
        }],
        persistSelection: () => {},
        requestRestart: () => {},
      })
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    prepared.bareModuleBaseUrl,
  )
  profileBoot.markReady()
  await runtime.mountScheduled()

  // 1. The dispatch tool must be in the real Loader ToolRegistry, not merely in
  //    the static definition table.
  const toolNames = (ctx.get('tools')?.schemas() ?? []).map(schema => schema.name)
  if (!toolNames.includes('expert_team_dispatch')) {
    throw new Error('expert-team-loader-tool-missing')
  }

  // 2. Exchange the renderer header for a session cookie exactly like
  //    verify-profile-boot, then probe the live expert-team routes. Loopback
  //    same-origin verification requires the exact Origin even for GETs.
  if (typeof mountedSpec?.authenticationUrl !== 'string') {
    throw new Error('desktop plugin did not provide an authentication URL')
  }
  const exchange = await fetch(mountedSpec.authenticationUrl, {
    headers: {
      [BROWSER_ACCESS.rendererHeader.name]: BROWSER_ACCESS.rendererHeader.value,
    },
    redirect: 'manual',
  })
  await exchange.body?.cancel()
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  if (exchange.status !== 303 || cookie === undefined || cookie.length === 0) {
    throw new Error(
      `browser authentication exchange returned HTTP ${String(exchange.status)} without a cookie`,
    )
  }
  const loopbackOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const huaanworkHeaders = {
    [BROWSER_ACCESS.rendererHeader.name]: BROWSER_ACCESS.rendererHeader.value,
    Cookie: cookie,
    Origin: loopbackOrigin,
  }
  const listRes = await fetch(`${loopbackOrigin}/huaanwork/expert-team/list`, { headers: huaanworkHeaders })
  const invocableRes = await fetch(`${loopbackOrigin}/huaanwork/expert-team/invocable`, { headers: huaanworkHeaders })
  if (listRes.status !== 200 || invocableRes.status !== 200) {
    throw new Error(`expert-team-loader-http-failed: list=${listRes.status}, invocable=${invocableRes.status}`)
  }
  const listBody = await listRes.json()
  const invocableBody = await invocableRes.json()
  if (!Array.isArray(listBody.teams) || !Array.isArray(invocableBody.teams)) {
    throw new Error('expert-team-loader-http-payload-invalid')
  }
  process.stdout.write(
    `expert-team smoke: tool present, list=200 (${String(listBody.teams.length)} teams), `
    + `invocable=200 (${String(invocableBody.teams.length)} teams)\n`,
  )
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  pnpmRuntime?.dispose()
  rmSync(home, { recursive: true, force: true })
}
