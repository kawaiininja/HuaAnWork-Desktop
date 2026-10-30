import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_APP_ID,
  DESKTOP_PACKAGE_NAMES,
  DESKTOP_PRODUCT_IDENTITY,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_RELEASE_CHANNEL,
  DESKTOP_RELEASE_IDENTITIES,
  OTHER_DESKTOP_PRODUCT_IDENTITY,
} from '../src/product-identity.ts'
import { desktopUpdateFilename } from '../src/update-download.ts'

const packageRoot = new URL('../', import.meta.url)
const workspaceRoot = new URL('../', packageRoot)
const ROOT_GATE_SCRIPTS = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../scripts/expected-root-gate-scripts.json'), 'utf8'),
) as { fixtureVersion: number; build: string; typecheck: string; test: string; check: string }
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  name?: unknown
  version?: unknown
  description?: unknown
  bin?: Record<string, unknown>
  exports?: Record<string, unknown>
  files?: unknown
  scripts?: Record<string, unknown>
  dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  build?: {
    productName?: unknown
    appId?: unknown
    asar?: unknown
    afterPack?: unknown
    afterAllArtifactBuild?: unknown
    npmRebuild?: unknown
    electronFuses?: unknown
    toolsets?: Record<string, unknown>
    files?: unknown
    mac?: {
      artifactName?: unknown
      extendInfo?: unknown
      hardenedRuntime?: unknown
      icon?: unknown
      asarUnpack?: unknown
      mergeASARs?: unknown
      notarize?: unknown
      signIgnore?: unknown
      target?: unknown
      x64ArchFiles?: unknown
    }
    win?: { compression?: unknown; icon?: unknown; asarUnpack?: unknown; target?: unknown; artifactName?: unknown }
    nsis?: Record<string, unknown>
    portable?: Record<string, unknown>
    linux?: { icon?: unknown; asarUnpack?: unknown }
  }
  dependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}
const workspaceManifest = JSON.parse(readFileSync(new URL('package.json', workspaceRoot), 'utf8')) as {
  version?: unknown
  workspaces?: string[]
  resolutions?: Record<string, unknown>
  scripts?: Record<string, unknown>
}
const EXPECTED_WORKSPACES = [
  'dsh-plugin-huaanwork',
  'dsh-community-fabric',
  'dsh-community-market',
  'packages/huaanwork-policy',
  'packages/huaanwork-model',
  'packages/huaanwork-git-tools',
  'packages/huaanwork-web-tools',
  'market-server',
  'update-server',
  'packages/catalog-signing',
  'packages/agent-package-format',
  'agent-catalog-server',
  'agent-catalog-admin',
]
const ciWorkflow = readFileSync(new URL('.github/workflows/ci.yml', workspaceRoot), 'utf8')
const productIdentity = readFileSync(new URL('src/product-identity.ts', packageRoot), 'utf8')
const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
// Derived, not hand-written: the HuaAnWork channel's pinned core is the single source
// of truth for every `patch:` selector asserted below, so a core bump does not require
// editing an assertion that was already correct.
const runtimeVersion = String(manifest.dependencies?.['@deepseek-ai/dsh'])
const dshResolution = (name: string): unknown =>
  workspaceManifest.resolutions?.[`${name}@npm:${runtimeVersion}`]

const GUARD_SCRIPT = 'dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs'

/** 按 `jobs:` 下的顶层 job 键切块,使断言能落到单个 job 而非整份文本。 */
function splitWorkflowJobs(workflow: string): Record<string, string> {
  const jobsStart = workflow.search(/^jobs:$/mu)
  assert.notStrictEqual(jobsStart, -1, 'the workflow must have a top-level jobs: key')
  const body = workflow.slice(jobsStart)
  const marks = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gmu)]
  const out: Record<string, string> = {}
  marks.forEach((m, i) => {
    out[m[1]!] = body.slice(m.index, marks[i + 1]?.index ?? body.length)
  })
  return out
}

describe('published package surface', () => {
  it('keeps the private workspace version-neutral and versions the HuaAnWork package', () => {
    expect(workspaceManifest.version).toBeUndefined()
    expect(manifest.version).toBe('0.1.0')
  })

  it('runs desktop and community market typechecks from the root command', () => {
    expect(ROOT_GATE_SCRIPTS.fixtureVersion).toBe(3)
    expect(workspaceManifest.scripts?.typecheck).toBe(ROOT_GATE_SCRIPTS.typecheck)
  })

  it('runs desktop and community market tests from the root command', () => {
    expect(ROOT_GATE_SCRIPTS.fixtureVersion).toBe(3)
    expect(workspaceManifest.scripts?.test).toBe(ROOT_GATE_SCRIPTS.test)
  })

  it('declares the unified workspace topology and gate layout', () => {
    expect(workspaceManifest.workspaces).toEqual(EXPECTED_WORKSPACES)
    expect(workspaceManifest.scripts?.['check:layout']).toBe(
      'yarn test:market-release && yarn test:aa-release && yarn check:bilingual-docs && yarn check:architecture && yarn check:vendored-runtime && node scripts/verify-layout.mjs && yarn test:gate-scripts && yarn check:readme-versions',
    )
  })

  it('has one owned desktop source tree and no active reference-workspace dependency', () => {
    for (const directory of ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta', 'dsh-desktop-next']) {
      expect(existsSync(new URL(directory, workspaceRoot)), directory).toBe(false)
    }
    const scripts = Object.values(workspaceManifest.scripts ?? {}).join('\n')
    expect(scripts).not.toMatch(/dsh-plugin-desktop|dsh-desktop-next/u)
    expect(workspaceManifest.workspaces).toEqual(EXPECTED_WORKSPACES)
  })

  it('enforces modern resolutions and aligned dshmarket dependency', () => {
    const resolutionKeys = Object.keys(workspaceManifest.resolutions ?? {})
    const resolutionValues = Object.values(workspaceManifest.resolutions ?? {})
    for (const key of resolutionKeys) {
      expect(key).not.toContain('@npm:0.1.')
    }
    for (const val of resolutionValues) {
      expect(String(val)).not.toContain('0.1.6-alpha.2')
    }
    const dshmarketResolutions = resolutionKeys.filter(k => k.startsWith('dshmarket@npm:'))
    expect(dshmarketResolutions).toHaveLength(1)
    expect(dshmarketResolutions[0]).toBe('dshmarket@npm:1.73.5')

    expect(manifest.dependencies?.dshmarket).toBe('1.73.5')
    expect(workspaceManifest.resolutions?.['dshmarket@npm:1.73.5']).toBe(
      'patch:dshmarket@npm%3A1.73.5#./.yarn/patches/dshmarket-desktop.patch',
    )
  })

  it('registers both npm launcher names', () => {
    expect(manifest.name).toBe('dsh-plugin-huaanwork')
    expect(manifest.description).toBe('HuaAnWork: a local code-agent desktop app composed as a DeepSeek Harness Cordis plugin')
    expect(manifest.bin).toEqual({
      'huaanwork': 'lib/bin.js',
      'dsh-plugin-huaanwork': 'lib/bin.js',
    })
    expect(manifest.bin).not.toHaveProperty('dsh-desktop')
    expect(manifest.bin).not.toHaveProperty('dsh-plugin-desktop')
    expect(manifest.bin).not.toHaveProperty('dsh-desktop-beta')
    expect(manifest.bin).not.toHaveProperty('dsh-plugin-desktop-beta')
  })

  it('sets a distinct process identity before taking the single-instance lock', () => {
    expect(productIdentity).toContain("packageName: 'dsh-plugin-huaanwork'")
    expect(productIdentity).toContain("packageName: 'dsh-plugin-desktop-beta'")
    expect(productIdentity).toContain("packageName: 'dsh-plugin-desktop'")
    expect(productIdentity).toContain("productName: 'HuaAnWork'")
    expect(productIdentity).toContain("productName: 'DSH Desktop Beta'")
    expect(productIdentity).toContain("appId: 'app.huaanwork.desktop'")
    expect(productIdentity).toContain("appId: 'ai.deepseek.dsh.desktop.beta'")
    expect(productIdentity).toContain('DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.huaanwork')
    expect(productIdentity).toContain('OTHER_DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.stable')
    expect(main).toContain('app.setAppUserModelId(DESKTOP_APP_ID)')
    const setName = main.indexOf('app.setName(PRODUCT_NAME)')
    const start = main.indexOf('await start()', setName)
    const lock = main.indexOf('app.requestSingleInstanceLock()')
    expect(setName).toBeGreaterThanOrEqual(0)
    expect(start).toBeGreaterThan(setName)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(setName).toBeGreaterThan(lock)
  })

  it('keeps Beta Safe Mode out of the normal DSH home and Desktop state', () => {
    expect(main).toContain('const profileUserDataDir = safeModePaths?.userDataDir ?? desktopUserDataDir')
    expect(main).toContain('if (safeModePaths !== undefined) {\n      homeDir = safeModePaths.homeDir')
    expect(main).toContain('process.env.DSH_HOME = homeDir')
    expect(main).toContain('const desktopLaunchEnvironment = withDesktopDshHome(environment, homeDir)')
    expect(main).toContain('createDesktopWebProfile(paths.homeDir, DESKTOP_SAFE_MODE_PROFILE_NAME)')
    expect(main).toContain("join(paths.userDataDir, 'profile-selection', 'state.json')")
    expect(main).toContain('selectDesktopProfile(')
    expect(main).toContain('cleanupDesktopSafeModeEnvironment(desktopUserDataDir)')
    expect(main).toContain('if (safeModeRequested) {')
    expect(main).toContain('const inheritedDshHome = process.env.DSH_HOME')
    expect(main).toContain('if (process.env.DSH_HOME === safeModeHomeDir) delete process.env.DSH_HOME')
    expect(main).toContain('if (inheritedDshHome === undefined) delete process.env.DSH_HOME')
    expect(main).toContain('failed to remove the Safe Mode environment')
    expect(main).toContain('desktopSafeModeRelaunchArguments()')
    expect(main).toContain("desktopTrayLabel(runtime.locale, 'exitSafeMode')")
    expect(main).toContain("desktopTrayLabel(runtime.locale, 'enterSafeMode')")
    expect(main).toContain('invoke: () => runtime.requestSafeModeRestart()')
    expect(main).toContain('prepareSafeMode()\n    }\n    restartRequested = true')
    expect(main).toContain('notifyDesktopSafeModeActive(runtime, electronLogger)')
    expect(main).toContain('safeModePaths !== undefined && DESKTOP_SAFE_MODE_DEFAULTS.settings.notifications.enabled')
    expect(main).toContain('const setupWizardState = safeModePaths === undefined')
    expect(main).toContain('let setupPending = safeModePaths === undefined')
    expect(main).toContain('const safeModeDefaults = DESKTOP_SAFE_MODE_DEFAULTS')
    expect(main).toContain('updateDesktopSetupWizardSettings(prepared.settingsDocument, safeModeDefaults.settings)')
    expect(main).toContain('selectDesktopMarketProvider(marketUserDataDir, safeModeDefaults.market)')
    expect(main).toContain('safeModeDefaults.settings.notifications')
  })

  it('exposes the Host plugin and desktop-owned client face', () => {
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./windows-pwsh-sandbox', {
      types: './lib/types/windows-pwsh-sandbox.d.ts',
      default: './lib/windows-pwsh-sandbox.js',
    })
    expect(manifest.exports).not.toHaveProperty('./windows-subprocess')
    expect(manifest.exports).not.toHaveProperty('./windows-agent-presets')
    expect(manifest.exports).toHaveProperty('./terminal', {
      types: './lib/types/terminal.d.ts',
      default: './lib/terminal.js',
    })
    expect(manifest.exports).toHaveProperty('./pnpm', {
      types: './lib/types/pnpm.d.ts',
      default: './lib/pnpm.js',
    })
    expect(manifest.exports).toHaveProperty('./profile-service', {
      types: './lib/types/profile-service.d.ts',
      default: './lib/profile-service.js',
    })
    expect(manifest.exports).toHaveProperty('./profiles', {
      types: './lib/types/profiles.d.ts',
      default: './lib/profiles.js',
    })
    expect(manifest.exports).toHaveProperty('./diagnostics', {
      types: './lib/types/diagnostics.d.ts',
      default: './lib/diagnostics.js',
    })
    expect(manifest.exports).toHaveProperty('./updates', {
      types: './lib/types/updates.d.ts',
      default: './lib/updates.js',
    })
    expect(manifest.exports).toHaveProperty('./notifications', {
      types: './lib/types/notifications.d.ts',
      default: './lib/notifications.js',
    })
    expect(manifest.exports).not.toHaveProperty('./windows-acl-runner')
    expect(manifest.exports).not.toHaveProperty('./desktop-cli')
    expect(manifest.exports).not.toHaveProperty('./desktop-runtime-environment')
    expect(manifest.exports).not.toHaveProperty('./desktop-terminal')
    expect(manifest.exports).not.toHaveProperty('./update-checker')
    expect(manifest.exports).not.toHaveProperty('./update-download')
    expect(manifest.exports).toHaveProperty('./package.json')
    expect(manifest.dsh?.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(manifest.dsh?.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-api-remotes',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    })
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-huaanwork')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).not.toContain('name: dsh-community-market')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-huaanwork/terminal')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-huaanwork/pnpm')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-huaanwork/profiles')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-huaanwork/diagnostics')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-huaanwork/notifications')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-huaanwork/updates')
  })

  it('pins both selectable Market providers in the published runtime', () => {
    expect(manifest.dependencies).toMatchObject({
      'dsh-community-market': '0.1.0-dev.0',
      dshmarket: expect.stringMatching(/^\d+\.\d+\.\d+/),
    })
    expect(manifest.optionalDependencies ?? {}).not.toHaveProperty('dshmarket')
  })

  it('patches the browse panel with the Windows native-picker icon bridge', () => {
    const patchPath = `./patches/dsh-client-ui-directory-picker-browse@${runtimeVersion}.patch`
    expect(dshResolution('@deepseek-ai/dsh-client-ui-directory-picker-browse'))
      .toContain(patchPath)
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const installedClient = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js',
      packageRoot,
    ), 'utf8')
    for (const marker of [
      '__DSH_DESKTOP_PICK_DIRECTORY__',
      '__DSH_DESKTOP_VALIDATE_DIRECTORY__',
      'const openDirectory = (path) => {',
      'if (path !== null) openDirectory(path);',
      'if (targetPath !== null) openDirectory(targetPath);',
      'IconFolderOpenRegular, { size: 16 }',
      'browser.nativePicker',
      'const parentInert = busy || folderDraft !== null || nativePicking || validatingDirectory;',
    ]) {
      expect(patch).toContain(marker)
      expect(installedClient).toContain(marker)
    }
    // A patched reference to a primitive the pinned core no longer exports reads as
    // undefined and crashes the dialog on render, so check the export, not just the text.
    const primitivesEntry = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js',
      packageRoot,
    ), 'utf8')
    const exportList = /^export \{([^}]*)\};$/m.exec(primitivesEntry)?.[1] ?? ''
    const exported = new Set(exportList.split(',').map((name) => name.trim()))
    expect(exported.has('Button')).toBe(true)
    const referenced = new Set(
      [...installedClient.matchAll(/_deepseek_ai_dsh_client_ui_primitives\.(\w+)/g)].map((match) => String(match[1])),
    )
    expect(referenced.size).toBeGreaterThan(0)
    expect([...referenced].filter((name) => !exported.has(name))).toEqual([])
  })

  it('patches the browse backend to skip unreadable directory-looking entries', () => {
    const patchPath = `./patches/dsh-host-directory-picker-browse@${runtimeVersion}.patch`
    expect(dshResolution('@deepseek-ai/dsh-host-directory-picker-browse'))
      .toContain(patchPath)
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const installedHost = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js',
      packageRoot,
    ), 'utf8')
    for (const marker of [
      'Windows reparse/system directories may appear as directories but fail `stat`',
      'let enterable = false;',
      'if (isDirectory || isSymbolicLink) try {',
    ]) {
      expect(patch).toContain(marker)
      expect(installedHost).toContain(marker)
    }
  })

  it('gives the Desktop settings section a dedicated display icon', () => {
    const patchPath = `./patches/dsh-client-ui-settings-general@${runtimeVersion}.patch`
    expect(dshResolution('@deepseek-ai/dsh-client-ui-settings-general'))
      .toContain(patchPath)
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const installedClient = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js',
      packageRoot,
    ), 'utf8')
    for (const marker of [
      'function IconDesktopSettings',
      'if (id === "desktop")',
      'M5 14h6M8 11.5V14',
    ]) {
      expect(patch).toContain(marker)
      expect(installedClient).toContain(marker)
    }
  })

  it('keeps wide Markdown table scrollbars visible without hover', () => {
    const patchPath = `./patches/dsh-client-ui-primitives@${runtimeVersion}.patch`
    expect(dshResolution('@deepseek-ai/dsh-client-ui-primitives')).toContain(patchPath)
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const installedStyles = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/markdown/MarkdownText.module.css',
      packageRoot,
    ), 'utf8')
    for (const styles of [patch, installedStyles]) {
      expect(styles).toContain('overflow-x: auto;')
      expect(styles).toContain('scrollbar-width: thin;')
      expect(styles).toContain('::-webkit-scrollbar-thumb')
      expect(styles).toContain('height: 8px;')
      expect(styles).toContain('background: var(--dsw-alias-label-tertiary, #9098a3);')
    }
    expect(installedStyles).not.toContain('overflow-x: hidden;')
    expect(installedStyles).not.toMatch(
      /\.tableScroll:global\(\.md-table-wide\):hover,[\s\S]*?overflow-x: auto;/u,
    )
  })

  // The `dsh-settings` compatibility patch is not forward-ported to
  // 0.1.7-alpha.1 and its lock test is retired with it. Upstream rewrote the
  // settings package: `installSection` / `parseSettingsNamespace` are gone
  // repository-wide and `SettingsProvider` became `SettingsForms`, so neither
  // `settingsNamespace` nor `installSettingsSection` has a delegate left to
  // forward to. See `patch-forward/DECISIONS.md` for the recorded downgrade.

  it('keeps only the active DSH runtime vendor lane and patch family', () => {
    expect(readdirSync(new URL('vendor/dsh-runtime', workspaceRoot))).toEqual([runtimeVersion])
    const dshPatchVersions = readdirSync(new URL('patches', workspaceRoot))
      .filter(name => name.startsWith('dsh'))
      .map(name => name.match(/@([^@]+)\.patch$/u)?.[1])
    expect(new Set(dshPatchVersions)).toEqual(new Set([runtimeVersion]))
  })

  it('resolves every DSH package only through the active HuaAnWork runtime', () => {
    const dshResolutions = Object.entries(workspaceManifest.resolutions ?? {})
      .filter(([selector]) => /^@deepseek-ai\/dsh(?:@|-)/u.test(selector))
    expect(dshResolutions.length).toBeGreaterThan(0)
    for (const [selector, resolution] of dshResolutions) {
      expect([runtimeVersion, `^${runtimeVersion}`], selector)
        .toContain(selector.split('@npm:')[1])
      expect(String(resolution), selector).toContain(`vendor/dsh-runtime/${runtimeVersion}/`)
    }
  })

  it('includes the Beta projection-cache compatibility recovery', () => {
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const cacheManifestPath = workspaceRequire.resolve(
      '@deepseek-ai/dsh-session-projection-cache/package.json',
    )
    const cacheManifest = JSON.parse(readFileSync(cacheManifestPath, 'utf8')) as {
      version?: unknown
    }
    const cacheRuntime = readFileSync(join(dirname(cacheManifestPath), 'lib/index.js'), 'utf8')

    expect(cacheManifest.version).toBe(runtimeVersion)
    expect(cacheRuntime).toContain('version: 7')
    expect(cacheRuntime).toMatch(/compatibleVersions:\s*\[\s*3,\s*4,\s*5,\s*6\s*\]/u)
    expect(cacheRuntime).toContain('invalidRecords: "backup-and-skip"')
  })

  it('keeps the canonical web profile configurable while Desktop disables browser opening', () => {
    const patchPath = `./patches/dsh-web-app@${runtimeVersion}.patch`
    const openPatchPath = './patches/open@11.0.1.patch'
    const openPatchResolution = `patch:open@npm%3A11.0.1#${openPatchPath}`
    expect(dshResolution('@deepseek-ai/dsh-web-app')).toContain(patchPath)
    expect(workspaceManifest.resolutions).toMatchObject({
      'open@npm:11.0.1': openPatchResolution,
      'open@npm:^11.0.0': openPatchResolution,
    })
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const openPatch = readFileSync(new URL(openPatchPath, workspaceRoot), 'utf8')
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const installedWebApp = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
      packageRoot,
    ), 'utf8')
    const installedOpen = readFileSync(new URL('node_modules/open/index.js', packageRoot), 'utf8')
    const installedWebPatch = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
      packageRoot,
    ), 'utf8')
    const desktopPatch = readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')
    for (const marker of [
      'ELECTRON_RUN_AS_NODE: "1"',
      "name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'",
    ]) {
      expect(patch).toContain(marker)
      expect(installedWebApp).toContain(marker)
    }
    expect(patch).toContain('+\t\twindowsHide: true,')
    expect(installedWebApp).toMatch(
      /function spawnBrowserLauncher\(url\) \{\s+return spawn\(process\.execPath, \[[\s\S]*?\], \{\s+windowsHide: true,\s+env:/u,
    )
    expect(lockfile).toContain('open@patch:open@npm%3A11.0.1#./patches/open@11.0.1.patch')
    expect(openPatch).toContain('+\t\t\tchildProcessOptions.windowsHide = true;')
    expect(installedOpen).toMatch(
      /if \(!isWsl\) \{\s+childProcessOptions\.windowsVerbatimArguments = true;\s+childProcessOptions\.windowsHide = true;\s+\}/u,
    )
    expect(patch).not.toContain('cordis.patch.yml')
    expect(patch).not.toContain('openBrowser: false')
    expect(installedWebPatch).toContain('openBrowser: !!js ctx.webStartup.openBrowser')
    expect(installedWebPatch).not.toContain('openBrowser: false')
    expect(desktopPatch).toMatch(/- id: web-runtime\n  config:\n    openBrowser: false/)
  })

  it.runIf(process.platform === 'win32')(
    'launches the browser opener helper through Electron Node mode',
    () => {
      const require = createRequire(new URL('package.json', packageRoot))
      const electronPath = require('electron') as string
      const webAppEntry = require.resolve('@deepseek-ai/dsh-web-app')
      const root = mkdtempSync(join(tmpdir(), 'dsh-browser-opener-'))
      const fakePowerShellDir = join(root, 'System32', 'WindowsPowerShell', 'v1.0')
      const fakePowerShell = join(fakePowerShellDir, 'powershell.exe')
      const main = join(root, 'main.mjs')
      const environment = { ...process.env }
      for (const name of Object.keys(environment)) {
        if (name.toUpperCase() === 'SYSTEMROOT' || name.toUpperCase() === 'WINDIR') delete environment[name]
      }
      environment.SYSTEMROOT = root

      try {
        mkdirSync(fakePowerShellDir, { recursive: true })
        copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), fakePowerShell)
        writeFileSync(main, [
          `import { internals } from ${JSON.stringify(pathToFileURL(webAppEntry).href)}`,
          `await internals.openBrowser('http://127.0.0.1:9/')`,
          `process.stdout.write('OPEN_OK')`,
          `process.exit(0)`,
          '',
        ].join('\n'))

        const stdout = execFileSync(electronPath, [main], {
          encoding: 'utf8',
          env: environment,
          timeout: 30_000,
          windowsHide: true,
        })
        expect(stdout).toContain('OPEN_OK')
        expect(stdout).not.toContain('Unable to find Electron app')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    45_000,
  )

  it('builds public Host plugins and their private native bootstraps', () => {
    const config = readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')

    expect(config).toContain("'windows-pwsh-sandbox': 'src/windows-pwsh-sandbox.ts'")
    expect(config).not.toContain("'windows-subprocess': 'src/windows-subprocess.ts'")
    expect(config).not.toContain("'windows-agent-presets': 'src/windows-agent-presets.ts'")
    expect(config).toContain("'windows-acl-runner': 'src/windows-acl-runner.ts'")
    expect(config).toContain("'desktop-cli': 'src/desktop-cli.ts'")
    expect(config).toContain("'desktop-runtime-environment': 'src/desktop-runtime-environment.ts'")
    expect(config).toContain("'desktop-terminal': 'src/desktop-terminal.ts'")
    expect(config).toContain("'profile-manager': 'src/profile-manager.ts'")
    expect(config).toContain("'profile-service': 'src/profile-service.ts'")
    expect(config).toContain("pnpm: 'src/pnpm.ts'")
    expect(config).toContain("profiles: 'src/profiles.ts'")
    expect(config).toContain("diagnostics: 'src/diagnostics.ts'")
    expect(config).toContain("notifications: 'src/notifications.ts'")
    expect(config).toContain("'diagnostic-export-worker': 'src/diagnostic-export-worker.ts'")
    expect(config).toContain("preload: 'src/preload.ts', 'compatibility-preload': 'src/compatibility-preload.ts'")
    expect(config).toContain("entryFileNames: '[name].cjs'")
    expect(config).toContain("terminal: 'src/terminal.ts'")
    expect(config).toContain("'update-download': 'src/update-download.ts'")
    expect(config).toContain("updates: 'src/updates.ts'")
  })

  it('builds the browser client without Node process globals', () => {
    const config = readFileSync(new URL('vite.client.config.ts', packageRoot), 'utf8')
    const client = readFileSync(new URL('lib/client.js', packageRoot), 'utf8')

    expect(config).toContain("'process.env.NODE_ENV': JSON.stringify('production')")
    expect(client).not.toMatch(/\bprocess(?:\.|\[)/u)
  })

  it('installs Host command PATHs after the launch snapshot and before profile boot', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const recover = main.indexOf('await resolveDesktopShellEnvironment')
    const applyRecovered = main.indexOf('Object.entries(shellEnvironmentResolution.updates)')
    const snapshot = main.indexOf('const environment = loadLayeredEnv')
    const install = main.indexOf('const pnpmRuntime = installDesktopPnpmRuntime')
    const prepare = main.indexOf('let prepared = prepareDesktopProfile')
    const installDsh = main.indexOf('const dshRuntime = process.platform === \'win32\'')
    const ownPnpm = main.indexOf('const releasePnpmRuntime = generation.own(')
    const ownDsh = main.indexOf('const releaseDshRuntime = generation.own(')
    const materialize = main.indexOf('await materializeProfile({', prepare)
    const reprepare = main.indexOf('prepared = prepareDesktopProfile(', materialize)
    const pnpmBootstrap = main.indexOf('const desktopPnpmBootstrap: DesktopPnpmBootstrap = {')
    const boot = main.indexOf('const ctx = await boot')

    expect(recover).toBeGreaterThanOrEqual(0)
    expect(applyRecovered).toBeGreaterThan(recover)
    expect(snapshot).toBeGreaterThan(applyRecovered)
    expect(install).toBeGreaterThan(snapshot)
    expect(ownPnpm).toBeGreaterThan(install)
    expect(prepare).toBeGreaterThan(install)
    expect(installDsh).toBeGreaterThan(prepare)
    expect(ownDsh).toBeGreaterThan(installDsh)
    expect(materialize).toBeGreaterThan(prepare)
    expect(reprepare).toBeGreaterThan(materialize)
    expect(pnpmBootstrap).toBeGreaterThan(reprepare)
    expect(boot).toBeGreaterThan(prepare)
    expect(boot).toBeGreaterThan(installDsh)
    expect(main).toContain("'dsh-plugin-desktop: packaged pnpm runtime PATH'")
    expect(main).toContain("'dsh-plugin-desktop: packaged dsh runtime PATH'")
    expect(main).toContain('hostCtx.loader.internal = undefined')
    expect(main).toContain('pnpmBinDir: pnpmRuntime.pathDir')
    expect(main).not.toContain("'--host'")
    expect(readFileSync(new URL('src/profile.ts', packageRoot), 'utf8'))
      .toContain('const webserverConfig = { host: desktopWebServerHost(networkExposure), port }')
    expect(main).not.toContain("'--port', '0'")
    expect(main).toContain("import { DesktopStartupGeneration } from './startup-generation.ts'")
    expect(main).toContain('async () => { await generation.release() }')
    expect(main).not.toContain('disposePnpmRuntime')
    expect(main).not.toContain('disposeDshRuntime')
  })

  it('keeps the release-age override in the shared process-local pnpm policy', () => {
    const policy = readFileSync(new URL('src/pnpm-policy.ts', packageRoot), 'utf8')
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')

    expect(policy).toContain("'--config.minimumReleaseAge=0'")
    expect(main).not.toContain('allowYoungLockedDependencies')
  })

  it('injects profile creation into the generation-scoped Host service without selecting it', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const profileImport = main.indexOf('createDesktopWebProfile,')
    const profileService = main.indexOf('await hostCtx.plugin(DesktopProfileService, {')
    const create = main.indexOf('create: name => createFreshDesktopProfile(name),', profileService)
    const list = main.indexOf('list: () => listDesktopProfiles(homeDir),', profileService)
    const persist = main.indexOf('persistSelection: name => { selectDesktopProfile(selectionStatePath, homeDir, name) },', profileService)
    const restart = main.indexOf('requestRestart: () => runtime.requestRestart(),', profileService)

    expect(profileImport).toBeGreaterThanOrEqual(0)
    expect(profileService).toBeGreaterThan(profileImport)
    expect(create).toBeGreaterThan(profileService)
    expect(list).toBeGreaterThan(create)
    expect(persist).toBeGreaterThan(list)
    expect(restart).toBeGreaterThan(persist)
    expect(main).not.toContain('persistProfileSelection')
  })

  it('constructs every local HTML window through the shared security policy', () => {
    for (const filename of [
      'desktop-dialog-window.ts',
      'profile-create-window.ts',
      'profile-selection-window.ts',
      'setup-wizard-window.ts',
      'startup-recovery-window.ts',
    ]) {
      const source = readFileSync(new URL(`src/${filename}`, packageRoot), 'utf8')
      expect(source, filename).toContain('createDesktopLocalWindow({')
      expect(source, filename).not.toContain('new BrowserWindow({')
    }
  })

  it('wires local crash evidence before Electron becomes ready', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const startCrashReporter = main.indexOf('startDesktopCrashReporting(crashReporter')
    const beginRun = main.indexOf('beginDesktopRun(')
    const childLogging = main.indexOf('installDesktopChildProcessLogging(app')
    const exitCoordinator = main.indexOf('createDesktopExitCoordinator(')
    const ready = main.indexOf('await app.whenReady()')
    const markClean = main.indexOf('desktopRun?.markClean()')
    const nativeExit = main.indexOf('app.exit(code)')

    expect(startCrashReporter).toBeGreaterThanOrEqual(0)
    expect(beginRun).toBeGreaterThan(startCrashReporter)
    expect(childLogging).toBeGreaterThan(beginRun)
    expect(exitCoordinator).toBeGreaterThan(childLogging)
    expect(nativeExit).toBeGreaterThan(exitCoordinator)
    expect(markClean).toBeGreaterThan(nativeExit)
    expect(ready).toBeGreaterThan(markClean)
  })

  it('creates unified Profile checkpoints before composition and records only after health', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const beginProfile = main.indexOf('const profileStartup = beginDesktopProfileStartup(')
    const admissionGuard = main.indexOf('if (!recoveryModeRequested)', beginProfile)
    const admission = main.indexOf('inspectDesktopProfileChannelAdmission(', admissionGuard)
    const checkpoint = main.indexOf('profileCheckpoint = new DesktopProfileCheckpoint({', beginProfile)
    const recoveryController = main.indexOf('startupRecoveryController = new DesktopStartupRecoveryController({', checkpoint)
    const prepare = main.indexOf('let prepared = prepareDesktopProfile(')
    const monitor = main.indexOf('const rendererBoot = runtime.beginRendererBootMonitoring({')
    const commitHealthy = main.indexOf('commitHealthy: async () => {', monitor)
    const captureHealthy = main.indexOf('profileCheckpoint?.captureHealthy()', commitHealthy)
    const awaitRenderer = main.indexOf('const [, rendererVerdict] = await Promise.all([')
    const mount = main.indexOf('runtime.mountScheduled(),', awaitRenderer)

    expect(beginProfile).toBeGreaterThanOrEqual(0)
    expect(admissionGuard).toBeGreaterThan(beginProfile)
    expect(admission).toBeGreaterThan(admissionGuard)
    expect(checkpoint).toBeGreaterThan(admission)
    expect(recoveryController).toBeGreaterThan(checkpoint)
    expect(prepare).toBeGreaterThan(recoveryController)
    expect(monitor).toBeGreaterThan(prepare)
    expect(commitHealthy).toBeGreaterThan(monitor)
    expect(captureHealthy).toBeGreaterThan(commitHealthy)
    expect(awaitRenderer).toBeGreaterThan(captureHealthy)
    expect(mount).toBeGreaterThan(awaitRenderer)
    expect(main).not.toContain('DesktopStartupStateCommit')
    expect(main).not.toContain('DesktopInstallRecoveryStore')
    expect(main).not.toContain('lastKnownGood')
    expect(main).toContain('desktopPackageName: DESKTOP_PACKAGE_NAME')
    expect(main).toContain('releaseChannel: DESKTOP_RELEASE_CHANNEL')
    expect(main).toContain('dshVersion: currentDshVersion')
  })

  it('contributes per-Profile setup to the live official client with restart-safe completion', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const prepare = main.indexOf('let prepared = prepareDesktopProfile(')
    const pending = main.indexOf('await beginDesktopSetupWizard(', prepare)
    const bridge = main.indexOf('runtime.setupOnboarding =', pending)
    const persist = main.indexOf('profilePreferences = await writeDesktopProfilePreferences(', bridge)
    const complete = main.indexOf('await completeOrSkipDesktopSetupWizard(', persist)
    const boot = main.indexOf('const ctx = await boot', complete)
    expect(pending).toBeGreaterThan(prepare)
    expect(bridge).toBeGreaterThan(pending)
    expect(persist).toBeGreaterThan(bridge)
    expect(complete).toBeGreaterThan(persist)
    expect(boot).toBeGreaterThan(complete)
    expect(main).not.toContain('new DesktopSetupWizardWindow(')
    expect(main).toContain('desktopSetupWizardPending(marketUserDataDir, prepared.profile.dir)')
    expect(main).toContain('!hasDesktopProfileUsageHistory(releaseUserDataLocations, prepared.profile.dir, activeProfileName)')
    expect(main).toContain("selection === undefined ? 'skipped' : 'completed'")
    expect(main).toContain('profile !== activeProfileName || safeModePaths !== undefined')
    const client = readFileSync(new URL('src/client/onboarding.tsx', packageRoot), 'utf8')
    expect(client).toContain("ctx.slots.inject('onboarding.desktop.before'")
  })

  it('keeps active Profile preferences as the lazy source and serializes runtime mirrors', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const preferencesSource = readFileSync(new URL('src/profile-preferences.ts', packageRoot), 'utf8')
    const projection = preferencesSource.indexOf('function desktopProfilePreferencesFromSettings(')
    const projectionEnd = preferencesSource.indexOf('type ErrorFactory', projection)
    const readPreferences = main.indexOf('readDesktopProfilePreferences(marketUserDataDir, activeProfileDir)')
    const profileMarket = main.indexOf('desktopProfileMarketSnapshot(profilePreferences.market)', readPreferences)
    const firstPrepare = main.indexOf('let prepared = prepareDesktopProfile(', profileMarket)
    const legacyPresetMigration = main.indexOf('migrateLegacyAgentPresetSettings(', firstPrepare)
    const missingState = main.indexOf('if (profilePreferences === undefined)', firstPrepare)
    const browserMigration = main.indexOf('migrateDesktopBrowserAccessSettings(', missingState)
    const materialMigration = main.indexOf('migrateDesktopWindowMaterialSettings(', browserMigration)
    const lazyImport = main.indexOf('profilePreferences = await writeDesktopProfilePreferences(', materialMigration)
    const existingState = main.indexOf('} else {', lazyImport)
    const mirrorSettings = main.indexOf('mirrorDesktopProfilePreferences(prepared.settingsDocument, profilePreferences)', existingState)
    const retryMaterialMigration = main.indexOf('migrateDesktopWindowMaterialSettings(', mirrorSettings)
    const mirrorMarket = main.indexOf('selectDesktopMarketProvider(marketUserDataDir, profilePreferences.market)', retryMaterialMigration)
    const runtimeQueue = main.indexOf('const enqueueProfilePreferencesWrite = (')
    const flushEffect = main.indexOf("'dsh-plugin-desktop: flush Profile preference writes'", runtimeQueue)
    const marketController = main.indexOf('selectMarket: async provider => {', flushEffect)
    const marketStateWrite = main.indexOf('await enqueueProfilePreferencesWrite(', marketController)
    const marketLegacyMirror = main.indexOf('await selectDesktopMarketProvider(marketUserDataDir, provider)', marketStateWrite)
    const deleteProfile = main.indexOf('await deleteDesktopProfile({')
    const clearPreferences = main.indexOf('await clearDesktopProfilePreferences(', deleteProfile)
    const captureObserver = main.indexOf('observeDesktopPreferenceSettings(ctx, fileExporter, enqueueProfilePreferencesWrite)', marketLegacyMirror)
    const settingsBridge = readFileSync(new URL('src/settings-bridge.ts', packageRoot), 'utf8')
    const captureDesktop = settingsBridge.indexOf('namespace !== DESKTOP_SETTINGS_ENTRY_ID')
    const captureNotifications = settingsBridge.indexOf('namespace !== DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID', captureDesktop)
    const captureFailure = settingsBridge.indexOf('failed to capture active Profile settings', captureNotifications)

    const aaController = main.indexOf('selectAa: async enabled => {')
    const aaWrite = main.slice(aaController, main.indexOf('readWeb:', aaController))
    expect(aaWrite).toContain('desktopProfilePreferencesFromSettings(')
    expect(aaWrite).not.toContain('...current')
    expect(projection).toBeGreaterThanOrEqual(0)
    expect(legacyPresetMigration).toBeGreaterThan(firstPrepare)
    expect(legacyPresetMigration).toBeLessThan(missingState)
    const projectionSource = preferencesSource.slice(projection, projectionEnd)
    expect(projectionSource).toContain("Pick<DesktopProfilePreferences, 'mode' | 'openBrowser' | 'networkExposure'>")
    expect(projectionSource).not.toContain('port:')
    expect(projectionSource).not.toContain('macosMaterial')
    expect(projectionSource).not.toContain('windowsMaterial')
    expect(projectionSource).not.toContain('logLevel')
    expect(readPreferences).toBeGreaterThanOrEqual(0)
    expect(profileMarket).toBeGreaterThan(readPreferences)
    expect(firstPrepare).toBeGreaterThan(profileMarket)
    expect(browserMigration).toBeGreaterThan(missingState)
    expect(materialMigration).toBeGreaterThan(browserMigration)
    expect(lazyImport).toBeGreaterThan(materialMigration)
    expect(mirrorSettings).toBeGreaterThan(existingState)
    expect(retryMaterialMigration).toBeGreaterThan(mirrorSettings)
    expect(mirrorMarket).toBeGreaterThan(retryMaterialMigration)
    expect(runtimeQueue).toBeGreaterThan(mirrorMarket)
    expect(flushEffect).toBeGreaterThan(runtimeQueue)
    expect(marketStateWrite).toBeGreaterThan(marketController)
    expect(marketLegacyMirror).toBeGreaterThan(marketStateWrite)
    expect(clearPreferences).toBeGreaterThan(deleteProfile)
    expect(captureObserver).toBeGreaterThan(marketLegacyMirror)
    expect(captureDesktop).toBeGreaterThanOrEqual(0)
    expect(captureNotifications).toBeGreaterThan(captureDesktop)
    expect(captureFailure).toBeGreaterThan(captureNotifications)
    expect(main.slice(deleteProfile, clearPreferences)).toContain('}, name)')
    expect(main.slice(clearPreferences, captureObserver)).toContain('deleted Profile left stale preference state')
  })

  it('wires lifecycle evidence through key startup stages and terminal outcomes', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const createRecorder = main.indexOf('const lifecycleRecorder = createDesktopLifecycleRecorder({')
    const startRun = main.indexOf('lifecycleRecorder.startStartup(startupStage)')
    const finishRenderer = main.indexOf('lifecycleRecorder.finishRendererBoot(')
    const rendererStage = main.indexOf("startupStage = 'renderer-startup'")
    const startRenderer = main.indexOf('lifecycleRecorder.startRendererBoot()')
    const awaitRenderer = main.indexOf('const [, rendererVerdict] = await Promise.all([')
    const healthStage = main.indexOf("startupStage = 'health-commit'")
    const completeStartup = main.indexOf('lifecycleRecorder.completeStartup(startupStage, rendererReport)')
    const catchFailure = main.indexOf('} catch (cause) {')
    const failPendingRenderer = main.indexOf('lifecycleRecorder.failRendererBootIfPending(')
    const catchFailStartup = main.indexOf('lifecycleRecorder.failStartup(', failPendingRenderer)

    expect(main).toContain("import { createDesktopLifecycleRecorder } from './lifecycle-events.ts'")
    expect(createRecorder).toBeGreaterThanOrEqual(0)
    expect(startRun).toBeGreaterThan(createRecorder)
    for (const stage of [
      'shell-environment',
      'runtime-bootstrap',
      'profile-selection',
      'profile-composition',
      'host-boot',
      'renderer-startup',
      'health-commit',
    ]) {
      expect(main).toContain(`startupStage = '${stage}'`)
    }
    expect(main).toContain('lifecycleRecorder.transitionStartupStage(startupStage)')
    expect(finishRenderer).toBeGreaterThan(createRecorder)
    expect(startRenderer).toBeGreaterThan(rendererStage)
    expect(startRenderer).toBeLessThan(awaitRenderer)
    expect(healthStage).toBeGreaterThan(startRenderer)
    expect(healthStage).toBeLessThan(awaitRenderer)
    expect(completeStartup).toBeGreaterThan(awaitRenderer)
    expect(failPendingRenderer).toBeGreaterThan(catchFailure)
    expect(catchFailStartup).toBeGreaterThan(failPendingRenderer)
    expect(main).toContain('lifecycleRendererFailureReason(runtime.rendererBootFailureReason)')
    expect(main).toContain('lifecycleStartupFailureReason(cause, runtime)')
  })

  it('keeps compatibility Profile selection separate from requested and failed recovery', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const recoveryUi = readFileSync(new URL('src/native-ui/recovery/App.tsx', packageRoot), 'utf8')
    const selectorUi = readFileSync(new URL('src/native-ui/profile-selector/App.tsx', packageRoot), 'utf8')
    const windows = [...main.matchAll(/await openStartupRecoveryWindow\(/gu)]
      .map(match => match.index)
    const requested = main.indexOf('if (recoveryModeRequested)')
    const beginProfile = main.indexOf('const profileStartup = beginDesktopProfileStartup(')
    const profileActions = main.indexOf('startupRecoveryProfileActions = {')
    const prepare = main.indexOf('let prepared = prepareDesktopProfile(')
    const quiesce = main.indexOf('const recoveryActionsSafe = await generation.quiesceForRecovery()')
    const configureTerminal = main.indexOf('runtime.configureTerminal({')
    const terminalAvailable = main.indexOf('recoveryTerminalAvailable = true')
    const compatibilitySelector = main.indexOf('await openCompatibilityProfileSelector()')

    expect(windows).toHaveLength(2)
    expect(compatibilitySelector).toBeGreaterThanOrEqual(0)
    expect(compatibilitySelector).toBeLessThan(requested)
    expect(profileActions).toBeGreaterThanOrEqual(0)
    expect(profileActions).toBeLessThan(beginProfile)
    expect(windows[0]).toBeGreaterThan(requested)
    expect(windows[0]).toBeLessThan(prepare)
    expect(configureTerminal).toBeGreaterThanOrEqual(0)
    expect(configureTerminal).toBeLessThan(requested)
    expect(terminalAvailable).toBeGreaterThan(configureTerminal)
    expect(terminalAvailable).toBeLessThan(requested)
    expect(main.match(/runtime\.configureTerminal\(\{/gu)).toHaveLength(1)
    expect(quiesce).toBeGreaterThan(prepare)
    expect(windows[1]).toBeGreaterThan(quiesce)
    expect(main).toContain("buttons: [copy.switchProfile, copy.useProfileAnyway, copy.quit]")
    expect(main).toContain('advisory: copy.profileCompatibilityWarning')
    expect(main).toContain("presentation: 'profile-compatibility'")
    expect(main).not.toContain('profileRecoveryActionUsed')
    expect(main).toContain('let expectedRecoveryProfileName = activeProfileName')
    expect(main.match(/expectedRecoveryProfileName = name/gu)).toHaveLength(2)
    expect(main).toContain('selection.active !== expectedRecoveryProfileName')
    expect(main).not.toContain("'Profile selection was requested from the compatibility warning.'")
    expect(recoveryUi).toContain("from '../shared/ProfileSelector.tsx'")
    expect(selectorUi).toContain("from '../shared/ProfileSelector.tsx'")
    expect(main).not.toContain('installRecovery')
    expect(main).not.toContain('restoreLatest')
    expect(main).not.toContain('restoreLastKnownGood')
    expect(main).toContain('failureStage: startupStage')
    expect(main).toContain("startupStage = 'profile-composition'")
    expect(main).toContain("startupStage = 'host-boot'")
    expect(main).toContain("startupStage = 'renderer-startup'")
    expect(main).toContain("return report.status === 'failed'")
    expect(main).toContain('void run().catch(async (cause: unknown) => { await handleFatalLauncherFailure(cause) })')
  })

  it('uses the upstream child-environment scrub around login-shell recovery', () => {
    const shellEnvironment = readFileSync(new URL('src/shell-environment.ts', packageRoot), 'utf8')

    expect(shellEnvironment).toContain('scrubbedParentEnv')
    expect(shellEnvironment).toContain('SENSITIVE_ENV_PATTERN')
    expect(shellEnvironment).toContain('DSH_ENV_PREFIX')
    expect(shellEnvironment).toContain('DESKTOP_SHELL_ENVIRONMENT_KEYS')
  })

  it('fixes the installed application identity', () => {
    expect(workspaceManifest.version).toBeUndefined()
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.name).toBe('dsh-plugin-huaanwork')
    expect(manifest.bin).toEqual({
      'huaanwork': 'lib/bin.js',
      'dsh-plugin-huaanwork': 'lib/bin.js',
    })
    expect(manifest.bin).not.toHaveProperty('dsh-desktop')
    expect(manifest.bin).not.toHaveProperty('dsh-plugin-desktop')
    expect(manifest.bin).not.toHaveProperty('dsh-desktop-beta')
    expect(manifest.bin).not.toHaveProperty('dsh-plugin-desktop-beta')
    expect(manifest.build?.productName).toBe('HuaAnWork')
    expect(manifest.build?.appId).toBe('app.huaanwork.desktop')
    expect(manifest.build?.asar).toBe(false)
    expect(manifest.build).not.toHaveProperty('asarUnpack')
    for (const platform of ['mac', 'win', 'linux'] as const) {
      expect(manifest.build?.[platform]).toMatchObject({ asar: false })
      expect(manifest.build?.[platform]).not.toHaveProperty('asarUnpack')
    }
    expect(manifest.build?.electronFuses).toEqual({
      enableEmbeddedAsarIntegrityValidation: false,
      onlyLoadAppFromAsar: false,
      resetAdHocDarwinSignature: true,
      runAsNode: true,
    })
    expect(manifest.build?.toolsets).toEqual({ nsis: '1.2.1' })
    expect(manifest.files).toEqual(expect.arrayContaining([
      'build/app-icon.png',
      'build/app-icon-mac.png',
      'build/app-icon.ico',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
      'docs/**',
    ]))
    expect(manifest.build?.files).toEqual([
      'build/app-icon.png',
      'build/app-icon-mac.png',
      'build/app-icon.ico',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
      'cordis.patch.yml',
      'lib/**',
      'package.json',
      'skills/**',
      '!node_modules/node-pty/build/**',
      '!node_modules/fs-ext/build/**',
    ])
    expect(manifest.build?.mac?.icon).toBe('build/app-icon-mac.png')
    expect(manifest.build?.mac?.artifactName).toBe('HuaAnWork-${version}-${arch}.${ext}')
    expect(manifest.build?.mac?.mergeASARs).toBe(false)
    expect(manifest.build?.mac?.signIgnore).toEqual(['\\.(?:pak|dat|wasm)$'])
    expect(manifest.build?.win?.compression).toBe('normal')
    expect(manifest.build?.win?.icon).toBe('build/app-icon.ico')
    expect(manifest.build?.win?.target).toEqual([{
      target: 'nsis',
      arch: ['x64'],
    }])
    expect(manifest.build?.win?.artifactName).toBe('HuaAnWork-${version}-${arch}-Portable.${ext}')
    expect(manifest.build?.nsis).toEqual({
      include: 'installer.nsh',
      license: 'THIRD_PARTY_NOTICES.md',
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      differentialPackage: false,
      shortcutName: 'HuaAnWork',
      useZip: false,
      artifactName: 'HuaAnWork-${version}-${arch}-Setup.${ext}',
    })
    expect(manifest.build?.linux?.icon).toBe('build/app-icon.png')
  })

  it('names the installer, the portable archive and the update artifact consistently', () => {
    expect(manifest.build?.mac?.artifactName).toBe('HuaAnWork-${version}-${arch}.${ext}')
    expect(manifest.build?.win?.artifactName).toBe('HuaAnWork-${version}-${arch}-Portable.${ext}')
    expect(manifest.build?.nsis?.artifactName).toBe('HuaAnWork-${version}-${arch}-Setup.${ext}')
    // desktopUpdateFilename('win32', …) is the native save-dialog default filename
    // ('HuaAnWork-0.1.0-windows.exe'), while the NSIS installer is really named
    // 'HuaAnWork-0.1.0-x64-Setup.exe'. The two names are deliberately different —
    // do not "fix" them into one string: the update link depends on the former,
    // the packaging pipeline emits the latter. This test only pins the shared
    // product-name prefix, never full-name equality.
    expect(desktopUpdateFilename('win32', '0.1.0', 'huaanwork')).toBe('HuaAnWork-0.1.0-windows.exe')
    expect(JSON.stringify(manifest.build)).not.toContain('DSH-Desktop-Beta')
    expect(JSON.stringify(manifest.build)).not.toContain('DSH Desktop Beta')
  })

  it('keeps both intranet servers out of the desktop installer', () => {
    const files = ((manifest.build?.files ?? []) as string[]).join('\n')
    expect(files).not.toContain('market-server')
    expect(files).not.toContain('update-server')
    for (const name of ['market-server', 'update-server']) {
      const serverManifest = JSON.parse(readFileSync(
        new URL(`${name}/package.json`, workspaceRoot), 'utf8')) as { private?: boolean }
      expect(serverManifest.private, name).toBe(true)
    }
  })

  it('separates unsigned smoke packaging from the signed macOS release', () => {
    const packageDir = readFileSync(new URL('scripts/package-dir.mjs', packageRoot), 'utf8')

    expect(manifest.scripts?.build).toContain('node scripts/generate-mac-app-icon.mjs')
    expect(manifest.scripts?.build).toContain('node scripts/gen-windows-ico.mjs')
    expect(manifest.scripts?.['prepare:electron-native']).toBe('node scripts/prepare-fs-ext.ts')
    expect(manifest.scripts?.dev).toContain('yarn run prepare:electron-native')
    expect(manifest.scripts?.['package:dir'])
      .toBe('yarn run build && yarn run prepare:electron-native && node scripts/package-dir.mjs')
    expect(packageDir).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(packageDir).toContain("'--config.forceCodeSigning=false'")
    expect(packageDir).toContain("'--config.mac.identity=null'")
    expect(packageDir).toContain("'--config.mac.notarize=false'")
    expect(packageDir).toContain("'--config.win.signExecutable=false'")
    expect(packageDir).toContain("require.resolve('electron/package.json')")
    expect(packageDir).toContain('--config.electronDist=')
    expect(packageDir).toContain('electronBuilderEnvironment')
    expect(manifest.scripts?.['dist:mac']).toBe('node scripts/release-mac.ts')
    expect(manifest.scripts?.['dist:mac-smoke']).toBe('node scripts/package-mac.ts')
    expect(manifest.scripts?.['dist:win']).toBe('node scripts/package-win.ts')
    expect(manifest.scripts?.['dist:win-portable']).toBe('node scripts/package-win-portable.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('yarn workspace dsh-community-market build')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('yarn run build')
    expect(manifest.scripts?.['check:win-package']).toBe('yarn run check:win-package:platform && yarn run typecheck')
    expect(manifest.scripts?.['check:win-package:platform']).not.toContain('typecheck')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/package-win.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/desktop-installer-quit.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/installer-nsh.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/verify-win-portable.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/update-checker.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/update-download.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/windows-console-host.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/windows-volume-diagnostics.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/host-liveness.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('tests/host-process.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).not.toContain('tests/host-liveness-win.spec.ts')
    expect(manifest.scripts?.['test:host-liveness-win']).toBe('vitest run tests/host-liveness-win.spec.ts')
    expect(manifest.scripts?.['check:win-package:platform']).not.toContain('verify:win-minimal-pty')
    expect(manifest.scripts?.['check:win-package:platform']).toContain('yarn run verify:closure')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('yarn workspace dsh-community-market build')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('yarn run build')
    expect(manifest.scripts?.['check:mac-package']).toBe('yarn run check:mac-package:platform && yarn run typecheck')
    expect(manifest.scripts?.['check:mac-package:platform']).not.toContain('typecheck')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('tests/package-mac.spec.ts')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('tests/verify-mac-smoke.spec.ts')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('tests/verify-mac-release.spec.ts')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('tests/mac-entitlements.spec.ts')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('tests/mac-universal.spec.ts')
    expect(manifest.scripts?.['check:mac-package:platform']).toContain('yarn run verify:closure')
    expect(manifest.scripts?.['check:linux-package']).toBeUndefined()
    expect(manifest.scripts?.['dist:linux']).toBeUndefined()
    expect(manifest.scripts?.['verify:aa']).toBe('node ../scripts/prepare-agents-anywhere-runtime.mjs && DSH_VERIFY_AA=1 node scripts/verify-profile-boot.mjs')
    expect(manifest.scripts?.['verify:cli']).toBe('node scripts/verify-cli-runtime.mjs')
    expect(manifest.scripts?.check).toContain('yarn run verify:cli')
    expect(workspaceManifest.scripts?.['dist:mac:huaanwork'])
      .toBe('yarn market:prepare && yarn aa:prepare-release && node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs && yarn workspace dsh-community-market build && yarn workspace dsh-plugin-huaanwork dist:mac')
    expect(workspaceManifest.scripts?.['dist:mac-smoke:huaanwork'])
      .toBe('yarn market:prepare && yarn aa:prepare-release && node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs --smoke && yarn workspace dsh-community-market build && yarn workspace dsh-plugin-huaanwork dist:mac-smoke')
    expect(manifest.build?.afterPack).toBe('./scripts/verify-packaged-runtime.ts')
    expect(manifest.build?.afterAllArtifactBuild).toBe('./scripts/verify-electron-fuses.ts')
    expect(manifest.build?.mac).toEqual(expect.objectContaining({
      extendInfo: {
        CFBundleAllowMixedLocalizations: true,
        CFBundleDevelopmentRegion: 'en',
        NSMicrophoneUsageDescription: 'HuaAnWork uses the microphone for voice input.',
        CFBundleLocalizations: ['en', 'zh_CN'],
      },
      hardenedRuntime: true,
      mergeASARs: false,
      notarize: true,
      signIgnore: ['\\.(?:pak|dat|wasm)$'],
      target: ['dir'],
      x64ArchFiles: expect.stringContaining('node-pty/prebuilds/darwin-*'),
    }))
    expect(manifest.build?.npmRebuild).toBe(false)
    expect(manifest.build?.mac?.x64ArchFiles).toContain('fs-ext/prebuilds/darwin-*')
    expect(manifest.build?.mac?.x64ArchFiles).toContain('sherpa-onnx-darwin-*')
    // Agents Anywhere depends on meshcall. Both darwin router binaries are identical
    // Mach-O files in the x64 and arm64 trees, so the universal merge must accept them.
    expect(manifest.build?.mac?.x64ArchFiles).toContain('meshcall-router-darwin-*')
    expect(manifest.build?.files).toContain('!node_modules/node-pty/build/**')
    expect(manifest.build?.files).toContain('!node_modules/fs-ext/build/**')
    expect(manifest.devDependencies?.['@electron/asar']).toBe('3.4.1')
    expect(manifest.devDependencies?.['@electron/fuses']).toBe('1.8.0')
    expect(manifest.devDependencies?.['builder-util']).toBe('26.15.3')
  })

  it('maps unsuffixed desktop entry points only to HuaAnWork', () => {
    const scripts = workspaceManifest.scripts ?? {}
    for (const [plain, suffixed] of Object.entries({
      dev: 'dev:huaanwork',
      'package:dir': 'package:dir:huaanwork',
      'dist:mac': 'dist:mac:huaanwork',
      'dist:mac-smoke': 'dist:mac-smoke:huaanwork',
      'dist:win': 'dist:win:huaanwork',
      'dist:win-portable': 'dist:win-portable:huaanwork',
    })) expect(scripts[plain]).toBe(scripts[suffixed])
    expect(scripts.start).toBe('yarn market:prepare && yarn workspace dsh-plugin-huaanwork start')
    expect(scripts['check:vendored-runtime']).toBe('node scripts/sync-vendored-runtime.mjs --check --channel huaanwork')
    for (const name of [
      'dist:linux', 'dev:beta', 'start:beta', 'package:dir:beta', 'dist:mac:beta',
      'dist:mac-smoke:beta', 'dist:win:beta', 'dist:win-portable:beta',
      'dev:next', 'start:next', 'check:next', 'package:dir:next', 'dist:mac:next',
      'dist:mac-smoke:next', 'dist:win:next', 'test:desktop-variants',
      'check:desktop-variants', 'icons:export', 'icons:check', 'test:inspector-compat',
    ]) expect(scripts[name], name).toBeUndefined()
  })

  it('exposes the HuaAnWork distribution entry points', () => {
    const scripts = workspaceManifest.scripts ?? {}
    for (const name of [
      'dev:huaanwork', 'package:dir:huaanwork',
      'dist:mac:huaanwork', 'dist:mac-smoke:huaanwork',
      'dist:win:huaanwork', 'dist:win-portable:huaanwork',
    ]) {
      expect(scripts[name], name).toBeTypeOf('string')
    }
    // 每条都先跑 aa:prepare-release 再构建 community-market
    for (const [name, command] of [
      ['dist:win:huaanwork', 'yarn workspace dsh-plugin-huaanwork dist:win'],
      ['dist:win-portable:huaanwork', 'yarn workspace dsh-plugin-huaanwork dist:win-portable'],
    ] as const) {
      const script = scripts[name] as string
      expect(script.startsWith('yarn market:prepare && yarn aa:prepare-release && ')).toBe(true)
      expect(script).toContain('yarn workspace dsh-community-market build && ')
      // 精确命中结尾:`dist:win` 不得被 `dist:win-portable` 的前缀假通过。
      expect(script.endsWith(command), name).toBe(true)
    }
  })

  // Task 4.8:未完成 provisioning 的构建**不产出制品**。守卫只能挂在真实发行命令上。
  it('runs the provisioning guard before any release packaging command', () => {
    const scripts = workspaceManifest.scripts ?? {}
    for (const name of ['dist:mac:huaanwork', 'dist:win:huaanwork', 'dist:win-portable:huaanwork']) {
      expect(scripts[name], name).toContain('huaanwork-verify-provisioning')
    }
  })

  it('does not gate development or the headless check', () => {
    const scripts = workspaceManifest.scripts ?? {}
    // R-M7-8(2026-10-03)显式变更了 M6 plan :7354 的「smoke 路径刻意不接守卫」设计:
    // smoke 现在也接守卫,但带 --smoke,故可在**显式声明**豁免时放行(CI 的未签名冒烟
    // 依赖它)。check 与 dev:huaanwork 仍然不接 —— 开发态本就不该有生产公钥。
    expect(scripts.check).not.toContain('huaanwork-verify-provisioning')
    expect(scripts['dev:huaanwork']).not.toContain('huaanwork-verify-provisioning')
    expect(scripts['dist:mac-smoke:huaanwork']).toContain('huaanwork-verify-provisioning.mjs --smoke')
  })

  it('runs the HuaAnWork platform package gates before reusing native packaging outputs', () => {
    const jobs = splitWorkflowJobs(ciWorkflow)
    expect(jobs['desktop-windows'], 'ci.yml must define a "desktop-windows" job').toBeDefined()
    expect(jobs['desktop-macos'], 'ci.yml must define a "desktop-macos" job').toBeDefined()
    const windowsJob = jobs['desktop-windows']!
    const macosJob = jobs['desktop-macos']!

    // HuaAnWork has no Linux distribution line: the job set is pinned, so the retired
    // `desktop-linux` job cannot return under its old name or any new one.
    expect(Object.keys(jobs).sort()).toEqual([
      'changes', 'check', 'desktop-macos', 'desktop-windows', 'gitleaks', 'upstream-command-windows',
    ])
    // `check` stays the plain root gate: the Chromium install for the retired Next
    // window regression used to live here, so a browser install must not reappear.
    expect(jobs.check).toContain('run: yarn check')
    expect(jobs.check).not.toMatch(/chromium|playwright install/iu)

    expect(windowsJob).not.toContain('- run: yarn check')
    expect(windowsJob).toContain('workspace: [dsh-plugin-huaanwork]')
    expect(windowsJob).toContain('- run: yarn workspace ${{ matrix.workspace }} check:win-package:platform')
    expect(windowsJob).toContain('timeout-minutes: 60')
    expect(windowsJob).toContain("if: matrix.workspace == 'dsh-plugin-huaanwork'")
    expect(windowsJob).toContain('timeout-minutes: 5')
    expect(windowsJob).toContain('yarn workspace dsh-plugin-huaanwork test:host-liveness-win')
    // 锚定行尾:`dist:win` 不得被 `dist:win-portable` 的前缀假通过。
    expect(windowsJob).toMatch(/^ {8}run: yarn workspace \$\{\{ matrix\.workspace \}\} dist:win$/mu)
    expect(windowsJob).toMatch(/^ {8}run: yarn workspace \$\{\{ matrix\.workspace \}\} dist:win-portable$/mu)
    expect(windowsJob).toContain('DSH_PACKAGE_CHECK_ALREADY_RAN: \'1\'')
    expect(windowsJob.match(/DSH_WINDOWS_PACKAGE_COMPRESSION: store/g)).toHaveLength(2)
    // Matrix-form cache paths keep the single-cell matrix honest instead of hardcoding a name.
    expect(windowsJob).toContain('${{ matrix.workspace }}/.desktop-build/downloads')

    expect(macosJob).not.toContain('- run: yarn check')
    expect(macosJob).toContain('workspace: [dsh-plugin-huaanwork]')
    expect(macosJob).toContain('- run: yarn workspace ${{ matrix.workspace }} check:mac-package:platform')
    expect(macosJob).toContain('run: yarn workspace ${{ matrix.workspace }} dist:mac-smoke')
    expect(macosJob).toContain('DSH_PACKAGE_CHECK_ALREADY_RAN: \'1\'')
    expect(macosJob).toContain("DSH_MAC_SMOKE_ARCH: ${{ github.event_name == 'pull_request' && 'arm64' || 'universal' }}")
    expect(macosJob).toContain("HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: '1'")
    expect(macosJob).toContain('${{ matrix.workspace }}/.desktop-build/downloads')
    expect(macosJob).not.toContain('- run: yarn dist:mac-smoke')

    // The AA-skip step is HuaAnWork-only; the retired Stable pull-request special case is gone.
    expect(ciWorkflow).toContain("for (const workspace of ['dsh-plugin-huaanwork'])")
    expect(ciWorkflow).not.toMatch(/dsh-plugin-desktop(?:-beta)?/u)
    expect(ciWorkflow).not.toContain('dsh-desktop-next')
    expect(ciWorkflow).not.toContain('Verify Next window controls')
  })

  it('ships a release workflow that uploads artifacts and holds no signing secrets', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', workspaceRoot), 'utf8')
    expect(workflow).toContain('workflow_dispatch')
    expect(workflow).toContain('actions/upload-artifact')
    expect(workflow).toContain('dsh-plugin-huaanwork')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).toMatch(/runs-on:\s*macos-/u)
    expect(workflow).toMatch(/runs-on:\s*windows-/u)
  })

  it('publishes a checksum manifest alongside the artifacts', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', workspaceRoot), 'utf8')
    expect(workflow).toMatch(/sha256/u)
  })

  it('fails the release when the dispatched version disagrees with the package version', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', workspaceRoot), 'utf8')
    expect(workflow).toMatch(/package\.json/u)
  })

  // 以下两条是 2026-09-28 发现 1 的**真正**机械护栏。初稿只加了全局
  // expect(workflow).toContain('huaanwork-verify-provisioning') —— 那条会被 windows job
  // 单独满足,于是 macOS job 漏掉守卫、且仍把冒烟包当发行制品上传,测试全绿。
  it('gates every release job on the provisioning guard, not just one of them', () => {
    const jobs = splitWorkflowJobs(
      readFileSync(new URL('.github/workflows/release.yml', workspaceRoot), 'utf8'),
    )
    for (const name of ['macos', 'windows']) {
      expect(jobs[name], `release.yml must define a "${name}" job`).toBeDefined()
      expect(jobs[name], `the "${name}" job must run the provisioning guard`).toContain(GUARD_SCRIPT)
    }
  })

  // 裁定 R-6(2026-09-30):mac 的 CI 发行制品 = 未签名 smoke 路径构建;
  // 强制签名的 mac 发行命令永不进 CI(零 secrets 下必失败,签名属 R1 的 credentialed 机器)。
  // 凭据到位后本断言不回改 —— 变的只是分发语义,不是 CI 产物形态。
  it('builds the mac release artifact unsigned and keeps the signed build out of CI', () => {
    const jobs = splitWorkflowJobs(
      readFileSync(new URL('.github/workflows/release.yml', workspaceRoot), 'utf8'),
    )
    expect(jobs.macos).toContain('dist:mac-smoke:huaanwork')
    expect(jobs.macos).not.toContain('dist:mac:huaanwork')
    expect(jobs.windows).toContain('dist:win:huaanwork')
    expect(jobs.windows).toContain('dist:win-portable:huaanwork')
  })

  it('skips product packaging only for documentation-only changes', () => {
    const classifier = fileURLToPath(new URL('../../scripts/classify-ci-changes.mjs', import.meta.url))
    const classify = (paths: string[]): string => execFileSync(
      process.execPath,
      [classifier],
      { input: Buffer.from(`${paths.join('\0')}\0`), encoding: 'utf8' },
    ).trim()

    expect(classify([
      'docs/architecture.md',
      '.agents/notes/implemented/architecture/decision.md',
      '.agents/notes/implemented/architecture/decision.i18n.yaml',
      'dsh-community-market/docs/schema.json',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
    ])).toBe('false')
    expect(classify(['README.md', 'dsh-plugin-desktop/src/index.ts'])).toBe('true')
    expect(classify(['.github/workflows/ci.yml'])).toBe('true')
    expect(classify(['THIRD_PARTY_NOTICES.md'])).toBe('true')
    expect(classify([])).toBe('true')

    expect(ciWorkflow).toContain('product="$(git diff --name-only -z')
    expect(ciWorkflow).toContain("if: needs.changes.outputs.product == 'true'")
    expect(ciWorkflow).toContain('Documentation-only change; product build and tests are not required.')
  })

  it('keeps one fixed HuaAnWork brand tray source for generated native assets', () => {
    const source = readFileSync(new URL('build/tray-icon.svg', packageRoot), 'utf8')

    // DESIGN.md palette --accent (靛蓝) is the single fill color; the upstream DSH brand blue is gone.
    expect(source.match(/#3A4ED0/gu)).toHaveLength(1)
    expect(source).not.toMatch(/<style\b|prefers-color-scheme/iu)
    for (const filename of [
      'tray-iconTemplate.png',
      'tray-iconTemplate@2x.png',
      'tray-icon-blue.png',
      'tray-icon-blue@1.25x.png',
      'tray-icon-blue@1.5x.png',
      'tray-icon-blue@2x.png',
    ]) {
      expect(readFileSync(new URL(`build/${filename}`, packageRoot)).byteLength).toBeGreaterThan(0)
    }
  })

  it('ships the recorded HuaAnWork-branded icon', () => {
    const ours = readFileSync(new URL('build/app-icon.png', packageRoot))
    expect(createHash('sha256').update(ours).digest('hex'))
      .toBe('532052effd6ad27a3dc3be0b0504d2d6a2e33be98a6c95971153dcb6153c5e47')
  })

  it('generates the mac icon from the branded source at build time', async () => {
    // app-icon-mac.png 必须由 generate-mac-app-icon.mjs 从 app-icon.png 派生:
    // 用 sharp 读元数据,断言 824×824 内容区 + 100px 透明内缩(该脚本的既有产物契约)
    const source = await sharp(readFileSync(new URL('build/app-icon.png', packageRoot))).metadata()
    const icon = sharp(readFileSync(new URL('build/app-icon-mac.png', packageRoot)))
    const metadata = await icon.metadata()
    const { info } = await icon
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
      .toBuffer({ resolveWithObject: true })

    expect(source).toEqual(expect.objectContaining({
      format: 'png',
      width: 1024,
      height: 1024,
      space: 'rgb16',
      depth: 'ushort',
      bitsPerSample: 16,
      channels: 4,
      hasAlpha: true,
      icc: expect.anything(),
    }))
    expect(metadata).toEqual(expect.objectContaining({
      format: 'png',
      width: 1024,
      height: 1024,
      space: 'rgb16',
      depth: 'ushort',
      bitsPerSample: 16,
      channels: 4,
      hasAlpha: true,
    }))
    expect(metadata.icc).toEqual(source.icc)
    expect(info).toEqual(expect.objectContaining({
      width: 824,
      height: 824,
      trimOffsetLeft: -100,
      trimOffsetTop: -100,
    }))
  })

  it('ships a Windows icon and lists it in both file manifests', () => {
    expect(existsSync(new URL('build/app-icon.ico', packageRoot))).toBe(true)
    expect(manifest.build?.win?.icon).toBe('build/app-icon.ico')
    expect((manifest.build?.files ?? []) as string[]).toContain('build/app-icon.ico')
    expect((manifest.files ?? []) as string[]).toContain('build/app-icon.ico')
  })

  it('produces a structurally valid Windows icon container', () => {
    const ico = readFileSync(new URL('build/app-icon.ico', packageRoot))
    expect(ico.readUInt16LE(0)).toBe(0)      // 保留
    expect(ico.readUInt16LE(2)).toBe(1)      // 类型:icon
    const count = ico.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(6)
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16
      const offset = ico.readUInt32LE(entry + 12)
      const size = ico.readUInt32LE(entry + 8)
      expect(offset + size).toBeLessThanOrEqual(ico.length)
      expect(ico.subarray(offset, offset + 8).toString('hex')).toBe('89504e470d0a1a0a')
    }
  })

  it('does not name the upstream product in the installer copy', () => {
    const messages = readFileSync(new URL('build/assistedMessages.yml', packageRoot), 'utf8')
    expect(messages).not.toContain('DSH Desktop')
    expect(messages).toContain('HuaAnWork')
  })

  it('does not use the upstream brand blue in the tray icon', () => {
    expect(readFileSync(new URL('build/tray-icon.svg', packageRoot), 'utf8')).not.toContain('#4D6BFE')
  })

  it('generates a centered macOS icon with a 100-pixel visual inset', async () => {
    const source = await sharp(readFileSync(new URL('build/app-icon.png', packageRoot))).metadata()
    const icon = sharp(readFileSync(new URL('build/app-icon-mac.png', packageRoot)))
    const metadata = await icon.metadata()
    const { info } = await icon
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
      .toBuffer({ resolveWithObject: true })

    expect(metadata).toEqual(expect.objectContaining({
      format: 'png',
      width: 1024,
      height: 1024,
      space: 'rgb16',
      depth: 'ushort',
      bitsPerSample: 16,
      channels: 4,
      hasAlpha: true,
    }))
    expect(metadata.icc).toEqual(source.icc)
    expect(info).toEqual(expect.objectContaining({
      width: 824,
      height: 824,
      trimOffsetLeft: -100,
      trimOffsetTop: -100,
    }))
  })

  it('lists every runtime asset in both the npm and the builder file manifests', () => {
    // spec §14 第 18 条:npm files 有而 build.files 无 ⇒ 打包后 ENOENT。
    // 对 build/ 下每个被 package.json 引用的资产,断言两处都在。
    const npmFiles = (manifest.files ?? []) as string[]
    const builderFiles = (manifest.build?.files ?? []) as string[]
    for (const asset of ['build/app-icon.png', 'build/app-icon-mac.png', 'build/app-icon.ico', 'build/tray-icon.svg']) {
      expect(npmFiles, asset).toContain(asset)
      expect(builderFiles, asset).toContain(asset)
    }
    expect(builderFiles).toContain('skills/**')      // M3 冒烟缺陷 1 的回归门
    expect(npmFiles).toContain('skills/')
  })

  it('keeps Electron out of production dependencies consumed by electron-builder', () => {
    expect(manifest.dependencies).not.toHaveProperty('electron')
    // Beta is pinned to 44.0.0, not to the newest 44.x. `node-addon-require-builtin`
    // 0.1.6 — which alpha.2's dsh-app-boot requires for `internalModules()` — gates on an
    // exact V8 build string compiled into its prebuilt binary, and only ships
    // 15.0.245.13-electron.0 (Electron 43.0.0/43.1.0), 15.2.124.13-electron.0 (44.0.0) and
    // 15.4.80-electron.0 (45.0.0-alpha.6). Every other 43.x/44.x patch release, including
    // 43.3.0 and 44.4.1, fails closed with "unsupported Electron runtime fingerprint" and
    // takes every `dsh` CLI entry point down with it. Do not float this to ^44 or bump it
    // to a newer 44.x until the addon publishes a matching fingerprint.
    expect(manifest.peerDependencies?.electron).toBe('44.0.0')
    expect(manifest.devDependencies?.electron).toBe('44.0.0')
    expect(manifest.dependencies?.pnpm).toBe('11.8.0')
  })

  it('keeps the packaged pnpm manifest, lock entry, and installed runtime on 11.8.0', () => {
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const installedPnpm = JSON.parse(readFileSync(
      workspaceRequire.resolve('pnpm'),
      'utf8',
    )) as { version?: unknown }

    expect(manifest.dependencies?.pnpm).toBe('11.8.0')
    expect(lockfile).toContain('"pnpm@npm:11.8.0":')
    expect(lockfile).toContain('resolution: "pnpm@npm:11.8.0"')
    expect(installedPnpm.version).toBe('11.8.0')
  })

  it('patches packaged pnpm to disable non-positive and invalid release-age policies', () => {
    const patchPath = './patches/pnpm@11.8.0.patch'
    const patchResolution = `patch:pnpm@npm%3A11.8.0#${patchPath}`
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const pnpmManifest = workspaceRequire.resolve('pnpm')
    const installedRuntime = readFileSync(join(dirname(pnpmManifest), 'dist/pnpm.mjs'), 'utf8')

    expect(workspaceManifest.resolutions).toMatchObject({
      'pnpm@npm:11.8.0': patchResolution,
    })
    expect(lockfile).toContain('pnpm@patch:pnpm@npm%3A11.8.0#./patches/pnpm@11.8.0.patch')
    for (const source of [patch, installedRuntime]) {
      expect(source).toContain('const minimumReleaseAge = Number(opts3.minimumReleaseAge);')
      expect(source).toContain('Number.isFinite(minimumReleaseAge) && minimumReleaseAge > 0')
      expect(source).toContain('const configuredMinimumReleaseAge = Number(opts3.minimumReleaseAge);')
      expect(source).toContain('!Number.isFinite(ts) || !Number.isFinite(cutoff)')
    }
    expect(installedRuntime).not.toContain('const ageCheckActive = Boolean(opts3.minimumReleaseAge);')
  })

  it('packages the native-compiled Koffi Windows runtime', () => {
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')

    expect(manifest.dependencies?.koffi).toBe('3.1.5')
    expect(workspaceManifest.resolutions).toMatchObject({
      'koffi@npm:^3.1.0': '3.1.5',
    })
    expect(lockfile).toContain('"koffi@npm:3.1.5":')
    expect(lockfile).toContain('@koromix/koffi-win32-x64@npm:3.1.5')
    expect(lockfile).not.toContain('"koffi@npm:3.1.4":')
    expect(lockfile).not.toContain('@koromix/koffi-win32-x64@npm:3.1.4')
  })

  it('uses upstream native session locks and keeps the desktop fs-ext Windows install guard', () => {
    const patchPath = './patches/fs-ext@2.1.1.patch'
    const patchResolution = `patch:fs-ext@npm%3A2.1.1#${patchPath}`
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const fsExtManifestPath = workspaceRequire.resolve('fs-ext/package.json')
    const installedFsExtManifest = JSON.parse(readFileSync(fsExtManifestPath, 'utf8')) as {
      scripts?: { install?: unknown }
    }
    const installedFsExtInstall = readFileSync(join(dirname(fsExtManifestPath), 'install.js'), 'utf8')
    const sessionManifestPath = workspaceRequire.resolve(
      '@deepseek-ai/dsh-session-persistence-jsonl/package.json',
    )
    const installedSessionRuntime = readFileSync(
      join(dirname(sessionManifestPath), 'lib/index.js'),
      'utf8',
    )

    expect(manifest.dependencies?.['fs-ext']).toBe('2.1.1')
    expect(manifest.devDependencies?.['node-gyp']).toBe('13.0.1')
    expect(workspaceManifest.resolutions).toMatchObject({
      'fs-ext@npm:2.1.1': patchResolution,
    })
    expect(lockfile).toContain('fs-ext@patch:fs-ext@npm%3A2.1.1#./patches/fs-ext@2.1.1.patch')
    expect(patch).toContain("if (process.versions.electron)")
    expect(patch).toContain("'/electron.abi' + process.versions.modules + '.node'")
    expect(patch).toContain('+if (process.platform !== "win32")')
    expect(patch).toContain('+    "install": "node install.js"')
    expect(installedFsExtManifest.scripts?.install).toBe('node install.js')
    expect(installedFsExtInstall).toContain('if (process.platform !== "win32")')
    expect(installedFsExtInstall).toContain('require.resolve("node-gyp/bin/node-gyp.js")')
    let windowsInstallRequiredModule = false
    runInNewContext(installedFsExtInstall, {
      process: { platform: 'win32' },
      require: () => {
        windowsInstallRequiredModule = true
        throw new Error('Windows fs-ext install must not resolve node-gyp')
      },
    })
    expect(windowsInstallRequiredModule).toBe(false)
    expect(installedSessionRuntime).not.toContain('import { flock } from "fs-ext";')
    expect(installedSessionRuntime).toContain('@deepseek-ai/node-addon-system/flock')
  })

  it('starts the private runner in Electron Node mode on every platform without changing target environment', () => {
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const root = dirname(workspaceRequire.resolve('@deepseek-ai/dsh-subprocess-local/package.json'))
    const index = readFileSync(join(root, 'lib/index.js'), 'utf8')
    const entry = /from "(\.\/runner-launch-[^"/]+\.js)"/u.exec(index)?.[1]
    if (entry === undefined) throw new Error('Cannot find the subprocess runner entry')
    const source = readFileSync(join(root, 'lib', entry), 'utf8')
    const body = /function runnerEnvironment\(selection, invocation\) \{[\s\S]*?\n\}/u.exec(source)?.[0]
    if (body === undefined) throw new Error('Cannot find runnerEnvironment')
    const target = { PATH: 'target-path', electron_run_as_node: '0', NODE_OPTIONS: '--trace-warnings' }
    const evaluate = (platform: string, electron?: string, selection = 'windows') => runInNewContext(
      `${body}\nrunnerEnvironment(selection, ['electron', 'runner.js'])`,
      {
        process: { platform, versions: electron === undefined ? {} : { electron } },
        childEnv: () => ({ ...target }),
        RUNNER_CONTROL_ENV_PREFIXES: ['NODE_', 'TSX_'],
        SUBPROCESS_RUNNER_ENV: 'DSH_SUBPROCESS_RUNNER',
        WINDOWS_RUNNER_SELECTION: 'windows',
        selection,
      },
    ) as Record<string, string>

    const runner = evaluate('win32', '43.3.0')
    expect(runner.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(runner).not.toHaveProperty('electron_run_as_node')
    expect(runner).not.toHaveProperty('NODE_OPTIONS')
    expect(runner.PATH).toBe('target-path')
    expect(runner.DSH_SUBPROCESS_RUNNER).toBe('windows')
    expect(target).toEqual({ PATH: 'target-path', electron_run_as_node: '0', NODE_OPTIONS: '--trace-warnings' })
    expect(evaluate('win32')).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(evaluate('darwin', '43.3.0')).toHaveProperty('ELECTRON_RUN_AS_NODE', '1')
    expect(evaluate('linux', '43.3.0', '/request')).toHaveProperty('ELECTRON_RUN_AS_NODE', '1')
    expect(evaluate('linux')).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  // The Host is an Electron utility process whose environment cannot carry
  // ELECTRON_RUN_AS_NODE, and danger-full-access skips the sandbox runner that would
  // otherwise set it. Without the patch the PTC worker is `process.execPath` in GUI mode:
  // it hits the single-instance lock and exits 0 before running any model code.
  it('starts every PTC worker in Electron Node mode through the pinned ptc-runtime-node patch', () => {
    const ptcPatchPath = `./patches/dsh-ptc-runtime-node@${runtimeVersion}.patch`
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    expect(dshResolution('@deepseek-ai/dsh-ptc-runtime-node')).toContain(ptcPatchPath)
    expect(lockfile).toContain(ptcPatchPath)

    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const root = dirname(workspaceRequire.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json'))
    const index = readFileSync(join(root, 'lib/index.js'), 'utf8')
    // dsh 0.2.1-alpha.2 replaced `nodeExecutable` with `launch`; the local default is still this process.
    expect(index).toMatch(/const launch = config \?\? \{\s+kind: "pkg" in process \? "embedded" : "node-script",\s+executable: process\.execPath\s+\};/u)
    expect(index).toContain('confined = policy.mode === "danger-full-access" ? void 0 : await this.ctx.sandbox.confine(')
    const block = /\t+const env = Object\.fromEntries\(Object\.keys\(process\.env\)[^\n]*\n(?:\t+\/\/[^\n]*\n)*\t+if \(process\.versions\.electron !== void 0\) env\.ELECTRON_RUN_AS_NODE = "1";\n\t+if \(packaged\) \{[\s\S]*?\n\t+\}\n(?=\t+handle = this\.ctx\.subprocess\.spawn\()/u.exec(index)?.[0]
    if (block === undefined) throw new Error('Cannot find the PTC worker environment')
    const evaluate = (electron: string | undefined, parent: Record<string, string>, packaged = true) => runInNewContext(
      `${block}\nenv`,
      {
        process: { versions: electron === undefined ? {} : { electron }, env: parent },
        STARTUP_ENVIRONMENT_NAMES: new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']),
        packaged,
        heapFlag: '--max-old-space-size=2048',
      },
    ) as Record<string, string | undefined>

    const worker = evaluate('44.0.0', { PATH: 'p', DSH_SECRET: 's' })
    expect(worker.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(worker).toHaveProperty('DSH_SECRET', undefined)
    expect(worker).not.toHaveProperty('PATH')
    expect(worker.DSH_PTC_RUNTIME_NODE).toBe('1')
    expect(evaluate('44.0.0', { ELECTRON_RUN_AS_NODE: '1' }, false).ELECTRON_RUN_AS_NODE).toBe('1')
    expect(evaluate(undefined, { PATH: 'p' })).not.toHaveProperty('ELECTRON_RUN_AS_NODE')

    // The bootstrap still strips the selector before model code runs.
    const bootstrap = readFileSync(join(root, 'lib/process.js'), 'utf8')
    const names = /const STARTUP_ENVIRONMENT_NAMES = new Set\(\[([\s\S]*?)\]\)/u.exec(bootstrap)?.[1]
    if (names === undefined) throw new Error('Cannot find the PTC bootstrap environment allowlist')
    expect(names).not.toMatch(/ELECTRON_RUN_AS_NODE/iu)
    expect(bootstrap).toContain('if (!STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase())) Reflect.deleteProperty(state.env, key);')
    expect(bootstrap).toContain('clearProgramEnvironment(processState);')
  })

  // A patch whose filename does not match the pinned version degrades silently to the
  // unpatched tarball, so the wiring is asserted, not assumed.
  it('accepts the Electron desktop profile through the pinned dsh patch', () => {
    const dshPatchPath = `./patches/dsh@${runtimeVersion}.patch`
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const dshPatch = readFileSync(new URL(dshPatchPath, workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const dshManifest = workspaceRequire.resolve('@deepseek-ai/dsh/package.json')
    const dshBin = readFileSync(join(dirname(dshManifest), 'lib/bin.js'), 'utf8')

    expect(dshResolution('@deepseek-ai/dsh')).toContain(dshPatchPath)
    expect(lockfile).toContain(dshPatchPath)
    // Upstream only lets the installed carrier manage plugins; the patch also
    // lets it boot the reserved Desktop profile.
    expect(dshPatch).toContain('if (!manageDesktopProfile) rejectElectronProfile(program, profile)')
    expect(dshBin).toMatch(/if \(!manageDesktopProfile\) rejectElectronProfile\(program, profile\)/u)
    expect(dshBin).toMatch(/if \(!manageDesktopProfile\) rejectElectronProfile\(plugin, options\.profile\)/u)
  })

  it('hides official plugin-manager and general subprocess consoles on Windows', () => {
    const subprocessPatchPath = `./patches/dsh-subprocess-local@${runtimeVersion}.patch`
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const dshManifest = workspaceRequire.resolve('@deepseek-ai/dsh/package.json')
    const dshBin = readFileSync(join(dirname(dshManifest), 'lib/bin.js'), 'utf8')
    const pluginEntry = /const \{ runPlugin \} = await import\("(\.\/plugin-[^"/]+\.js)"\)/u.exec(dshBin)?.[1]
    expect(pluginEntry).toBeDefined()
    if (pluginEntry === undefined) throw new Error('Cannot find the CLI plugin command entry')
    const dshPluginRuntime = readFileSync(join(dirname(dshManifest), 'lib', pluginEntry), 'utf8')
    const subprocessManifest = workspaceRequire.resolve('@deepseek-ai/dsh-subprocess-local/package.json')
    const subprocessIndex = readFileSync(join(dirname(subprocessManifest), 'lib/index.js'), 'utf8')
    const runnerEntry = /from "(\.\/runner-launch-[^"/]+\.js)"/u.exec(subprocessIndex)?.[1]
    expect(runnerEntry).toBeDefined()
    if (runnerEntry === undefined) throw new Error('Cannot find the subprocess runner entry')
    const subprocessRuntime = readFileSync(join(dirname(subprocessManifest), 'lib', runnerEntry), 'utf8')

    expect(dshResolution('@deepseek-ai/dsh-subprocess-local')).toContain(subprocessPatchPath)
    expect(lockfile).toContain(subprocessPatchPath)

    // dsh 0.1.6-alpha.2 replaced the patched `spawnSync("pnpm", { shell, windowsHide })`
    // in the CLI plugin command with `runPluginCommand`, so the beta channel no longer
    // patches @deepseek-ai/dsh for this. The console-hiding guarantee now rests on two
    // upstream facts, both asserted here rather than assumed: the pnpm child is spawned
    // through execa with no `shell: true` (no intermediate cmd.exe console), and execa
    // defaults `windowsHide` to true.
    expect(dshPluginRuntime).not.toContain('spawnSync')
    expect(dshPluginRuntime).toContain('runPluginCommand')
    expect(dshPluginRuntime).toContain('@deepseek-ai/dsh-plugin-manager/operations')
    const operationsPath = workspaceRequire.resolve('@deepseek-ai/dsh-plugin-manager/operations')
    const operationsRuntime = readFileSync(operationsPath, 'utf8')
    expect(operationsRuntime).toContain("import { execa } from 'execa'")
    expect(operationsRuntime).not.toMatch(/shell:\s*true/u)
    // execa's exports map does not expose ./package.json, so anchor on its main entry.
    const execaEntry = workspaceRequire.resolve('execa')
    const execaOptions = readFileSync(join(dirname(execaEntry), 'lib/arguments/options.js'), 'utf8')
    expect(execaOptions).toMatch(/windowsHide = true/u)

    expect(subprocessRuntime.match(/windowsHide: true/gu)).toHaveLength(2)
    expect(subprocessRuntime).toContain('windowsHide: platform === "win32"')
  })

  it('resolves electron-builder through the pinned app-builder-lib product patch', () => {
    const patchResolution = 'patch:app-builder-lib@npm%3A26.15.7#./patches/app-builder-lib@26.15.7.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL('patches/app-builder-lib@26.15.7.patch', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const electronBuilderManifest = workspaceRequire.resolve('electron-builder/package.json')
    const electronBuilderRequire = createRequire(electronBuilderManifest)
    const appBuilderManifest = electronBuilderRequire.resolve('app-builder-lib/package.json')
    const installedCodeSign = readFileSync(join(dirname(appBuilderManifest), 'out/codeSign/macCodeSign.js'), 'utf8')
    const installedAppFileCopier = readFileSync(
      join(dirname(appBuilderManifest), 'out/util/appFileCopier.js'),
      'utf8',
    )
    const installedNsisInstaller = readFileSync(join(dirname(appBuilderManifest), 'templates/nsis/installer.nsi'), 'utf8')
    const installedNsisPortable = readFileSync(join(dirname(appBuilderManifest), 'templates/nsis/portable.nsi'), 'utf8')
    const installedNsisSingleInstance = readFileSync(
      join(dirname(appBuilderManifest), 'templates/nsis/include/allowOnlyOneInstallerInstance.nsh'),
      'utf8',
    )
    const installedNsisExtractor = readFileSync(
      join(dirname(appBuilderManifest), 'templates/nsis/include/extractAppPackage.nsh'),
      'utf8',
    )
    const installedNsisInstallUtil = readFileSync(
      join(dirname(appBuilderManifest), 'templates/nsis/include/installUtil.nsh'),
      'utf8',
    )

    expect(workspaceManifest.resolutions).toMatchObject({
      'app-builder-lib@npm:26.15.7': patchResolution,
    })
    expect(manifest.devDependencies?.['electron-builder']).toBe('26.15.7')
    expect(lockfile).toContain('app-builder-lib@patch:app-builder-lib@npm%3A26.15.7#./patches/app-builder-lib@26.15.7.patch')
    expect(patch).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(patch).toContain('"-k", keychainPassword, keychainFile')
    expect(patch).toContain('ManifestLongPathAware true')
    expect(patch).toContain("[System.IO.Path]::GetFileName($$_.Path) -ieq '${_FILE}'")
    expect(patch).toContain('diff --git a/templates/nsis/include/extractAppPackage.nsh')
    expect(patch).toContain('diff --git a/templates/nsis/include/installUtil.nsh')
    expect(patch).toContain('process.env.DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY === "1"')
    expect(manifest.build?.toolsets?.nsis).toBe('1.2.1')
    expect(installedCodeSign).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(installedCodeSign).toContain('"-k", keychainPassword, keychainFile')
    expect(installedAppFileCopier).toContain('process.env.DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY === "1"')
    expect(installedNsisInstaller).toContain('ManifestLongPathAware true')
    expect(installedNsisPortable).toContain('ManifestLongPathAware true')
    expect(installedNsisSingleInstance).toContain("[System.IO.Path]::GetFileName($$_.Path) -ieq '${_FILE}'")
    expect(installedNsisSingleInstance).not.toContain("$$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count")
    expect(installedNsisExtractor).toContain('SetOutPath "$INSTDIR"')
    expect(installedNsisExtractor).not.toContain('$PLUGINSDIR\\7z-out')
    expect(installedNsisExtractor).not.toContain('CopyFiles /SILENT')
    expect(installedNsisInstallUtil).toContain(
      'Old uninstaller returned code 2; continuing with non-atomic in-place replacement.',
    )
    expect(installedNsisInstallUtil).toContain(
      '# Code 2 is handled by the non-atomic in-place replacement path.',
    )
    const legacyCode2Fallback = installedNsisInstallUtil.indexOf(
      '# Code 2 is handled by the non-atomic in-place replacement path.',
    )
    expect(legacyCode2Fallback).toBeGreaterThan(installedNsisInstallUtil.indexOf('CheckResult:'))
    expect(legacyCode2Fallback).toBeLessThan(installedNsisInstallUtil.indexOf('Sleep 1000', legacyCode2Fallback))
    expect(installedNsisInstallUtil).toContain('MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"')
  })

  // dsh 0.1.6-alpha.2 carries the hidden console show state upstream, so the beta
  // channel ships no dsh-win32-process patch. The guarantee still holds and is
  // asserted against the installed runtime; only the mechanism moved upstream.
  it('starts restricted Windows shells with a hidden console show state', () => {
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const sandboxManifest = workspaceRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl/package.json')
    const sandboxRequire = createRequire(sandboxManifest)
    const processManifest = sandboxRequire.resolve('@deepseek-ai/dsh-win32-process/package.json')
    const installedRuntime = readFileSync(join(dirname(processManifest), 'lib/index.js'), 'utf8')

    expect(existsSync(new URL(`patches/dsh-win32-process@${runtimeVersion}.patch`, workspaceRoot))).toBe(false)
    expect(dshResolution('@deepseek-ai/dsh-win32-process')).not.toContain('patch:')
    expect(installedRuntime.match(/dwFlags: 257,/gu)).toHaveLength(2)
    expect(installedRuntime.match(/wShowWindow: 0,/gu)).toHaveLength(2)
    expect(installedRuntime).toContain('createRestrictedProcess(api, options, buildCommandLine(options.command, options.args), 0')
    expect(installedRuntime).toContain('createRestrictedProcess(api, options, commandLine, 4')
  })
})

describe('huaanwork product identity', () => {
  it('runs on its own release channel', () => {
    expect(DESKTOP_RELEASE_IDENTITIES.huaanwork.releaseChannel).toBe('huaanwork')
    expect(DESKTOP_RELEASE_CHANNEL).toBe('huaanwork')
    expect(DESKTOP_PRODUCT_IDENTITY).toBe(DESKTOP_RELEASE_IDENTITIES.huaanwork)
  })

  it('keeps the historical upstream identities intact', () => {
    expect(DESKTOP_RELEASE_IDENTITIES.stable).toEqual({
      releaseChannel: 'stable',
      packageName: 'dsh-plugin-desktop',
      productName: 'DSH Desktop',
      appId: 'ai.deepseek.dsh.desktop',
      homeDirectoryName: '.dsh',
    })
    expect(DESKTOP_RELEASE_IDENTITIES.beta).toEqual({
      releaseChannel: 'beta',
      packageName: 'dsh-plugin-desktop-beta',
      productName: 'DSH Desktop Beta',
      appId: 'ai.deepseek.dsh.desktop.beta',
      homeDirectoryName: '.dsh-beta',
    })
    expect(OTHER_DESKTOP_PRODUCT_IDENTITY).toBe(DESKTOP_RELEASE_IDENTITIES.stable)
  })

  it('still treats all three desktop shells as launcher-owned, never profile plugins', () => {
    expect([...DESKTOP_PACKAGE_NAMES].sort()).toEqual([
      'dsh-plugin-desktop',
      'dsh-plugin-desktop-beta',
      'dsh-plugin-huaanwork',
    ])
  })

  it('keeps the huaanwork identity aligned with electron-builder', () => {
    expect(DESKTOP_PRODUCT_NAME).toBe(manifest.build?.productName)
    expect(DESKTOP_APP_ID).toBe(manifest.build?.appId)
  })

  it('does not describe this package as the upstream beta channel', () => {
    for (const name of ['README.md', 'README.zh.md']) {
      const text = readFileSync(new URL(name, packageRoot), 'utf8')
      expect(text, name).not.toContain('DSH Desktop Beta')
      expect(text, name).not.toContain('dsh-desktop-beta')
      expect(text, name).not.toContain('dshdesktop.cn')
      expect(text, name).not.toContain('DSH-Desktop-Beta')
    }
  })

  it('documents only the launcher names this package actually registers', () => {
    for (const name of ['README.md', 'README.zh.md']) {
      const text = readFileSync(new URL(name, packageRoot), 'utf8')
      for (const bin of Object.keys(manifest.bin ?? {})) expect(text, name).toContain(bin)
    }
  })

  it('documents the configured update origin instead of a hardcoded endpoint', () => {
    for (const name of ['README.md', 'README.zh.md']) {
      const text = readFileSync(new URL(name, packageRoot), 'utf8')
      expect(text, name).toContain('HUAANWORK_UPDATE_ORIGIN')
    }
  })

  it('does not document an install-stable flow this product does not have', () => {
    for (const name of ['README.md', 'README.zh.md']) {
      const text = readFileSync(new URL(name, packageRoot), 'utf8')
      expect(text, name).not.toMatch(/Install Stable Edition/u)
      expect(text, name).not.toContain('安装稳定版')
    }
  })

  it('points at the two intranet servers and the migration guide', () => {
    for (const name of ['README.md', 'README.zh.md']) {
      const text = readFileSync(new URL(name, packageRoot), 'utf8')
      expect(text, name).toContain('update-server-deployment.md')
      expect(text, name).toContain('market-server-deployment.md')
      expect(text, name).toContain('huaanwork-data-migration.md')
    }
  })
})
