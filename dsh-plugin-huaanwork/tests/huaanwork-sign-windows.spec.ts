import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { generate } from 'selfsigned'
import {
  WINDOWS_SIGNING_VARIABLES,
  assertWindowsSigningReady,
  buildSigntoolArgs,
  buildSigntoolVerifyArgs,
  signWindowsRelease,
  withoutWindowsSigningSecrets,
  type WindowsSignReleaseOptions,
} from '../scripts/huaanwork-sign-windows.ts'

const PRODUCT_VERSION = '1.2.3'
const CHECK_POSIX_MODE = process.platform !== 'win32'
const PACKAGE_ROOT = new URL('../', import.meta.url)
const WORKSPACE_ROOT = new URL('../', PACKAGE_ROOT)
const TIMESTAMP_URL = 'http://timestamp.digicert.com'
// Not `mkdtemp`-shaped, so a leaked PIN can never be confused with a temporary path.
const TOKEN_PIN = 'huaanwork-pin'
const NODE_EXECUTABLE = 'C:\\Program Files\\nodejs\\node.exe'
const BUILDER_CLI = 'C:\\repo\\node_modules\\electron-builder\\cli.js'

const temporaryRoots: string[] = []
let credentialRoot = ''
let certificateFile = ''
let signToolPath = ''

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

interface ReleaseFixture {
  readonly desktopRoot: string
  readonly applicationDirectory: string
  readonly applicationPath: string
  readonly installerPath: string
  readonly portablePath: string
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function signingEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: 'C:\\Windows\\System32',
    DSH_DESKTOP_WINDOWS_SIGNTOOL: signToolPath,
    DSH_DESKTOP_WINDOWS_CER_FILE: certificateFile,
    DSH_DESKTOP_WINDOWS_TOKEN_PIN: TOKEN_PIN,
    DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'huaanwork-release',
  }
}

function releaseFixture(): ReleaseFixture {
  const desktopRoot = temporaryRoot('huaanwork-signing-release-')
  const applicationDirectory = join(desktopRoot, 'dist', 'win-unpacked')
  mkdirSync(applicationDirectory, { recursive: true })
  writeFileSync(
    join(desktopRoot, 'package.json'),
    `${JSON.stringify({ name: 'dsh-plugin-huaanwork', version: PRODUCT_VERSION })}\n`,
  )
  const applicationPath = join(applicationDirectory, 'HuaAnWork.exe')
  writeFileSync(applicationPath, 'MZ unpacked application')
  const installerPath = join(desktopRoot, 'dist', `HuaAnWork-${PRODUCT_VERSION}-x64-Setup.exe`)
  writeFileSync(installerPath, 'MZ installer')
  const portablePath = join(desktopRoot, 'dist', `HuaAnWork-${PRODUCT_VERSION}-x64-Portable.zip`)
  const archive = new AdmZip()
  archive.addFile('HuaAnWork.exe', Buffer.from('MZ portable application'))
  archive.addFile('resources/app/package.json', Buffer.from('{}\n'))
  archive.writeZip(portablePath)
  return { desktopRoot, applicationDirectory, applicationPath, installerPath, portablePath }
}

function releaseOptions(
  fixture: ReleaseFixture,
  calls: CommandCall[],
  logs: string[] = [],
): WindowsSignReleaseOptions {
  return {
    env: signingEnvironment(),
    platform: 'win32',
    desktopRoot: fixture.desktopRoot,
    nodeExecutable: NODE_EXECUTABLE,
    builderCli: BUILDER_CLI,
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
  }
}

beforeAll(async () => {
  credentialRoot = mkdtempSync(join(tmpdir(), 'huaanwork-signing-credentials-'))
  const certificatePath = join(credentialRoot, 'publisher.cer')
  const signToolFile = join(credentialRoot, 'signtool.exe')
  writeFileSync(signToolFile, '')
  const leaf = await generate([{ name: 'commonName', value: 'HuaAnWork test publisher' }], {
    algorithm: 'sha256',
    keyType: 'ec',
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', codeSigning: true, critical: true },
    ],
  })
  writeFileSync(certificatePath, leaf.cert)
  // The preflight resolves both inputs like the upstream pipeline does.
  certificateFile = realpathSync(certificatePath)
  signToolPath = realpathSync(signToolFile)
})

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(credentialRoot, { recursive: true, force: true })
})

describe('windows signing preflight', () => {
  it('accepts the SafeNet token credential contract and names the RFC3161 timestamp default', () => {
    const plan = assertWindowsSigningReady({ env: signingEnvironment(), platform: 'win32' })

    expect(plan.signTool).toBe(signToolPath)
    expect(plan.certificateFile).toBe(certificateFile)
    expect(plan.keyContainer).toBe('huaanwork-release')
    expect(plan.tokenPin).toBe(TOKEN_PIN)
    expect(plan.timestampUrl).toBe(TIMESTAMP_URL)
    expect(plan.publisher).toContain('HuaAnWork test publisher')
  })

  it('refuses to sign with a partial credential set', () => {
    expect(() => assertWindowsSigningReady({
      env: { DSH_DESKTOP_WINDOWS_CER_FILE: certificateFile },
      platform: 'win32',
    })).toThrow('DSH_DESKTOP_WINDOWS_SIGNTOOL, DSH_DESKTOP_WINDOWS_TOKEN_PIN, DSH_DESKTOP_WINDOWS_KEY_CONTAINER')
    expect(() => assertWindowsSigningReady({
      env: {
        DSH_DESKTOP_WINDOWS_SIGNTOOL: signToolPath,
        DSH_DESKTOP_WINDOWS_CER_FILE: certificateFile,
        DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'huaanwork-release',
      },
      platform: 'win32',
    })).toThrow('DSH_DESKTOP_WINDOWS_TOKEN_PIN')
    // electron-builder discovery names are stripped by the unsigned packaging pass and never sign anything.
    expect(() => assertWindowsSigningReady({
      env: { CSC_LINK: 'C:\\private\\publisher.pfx', CSC_KEY_PASSWORD: 'p12', WIN_CSC_LINK: 'C:\\private\\publisher.pfx' },
      platform: 'win32',
    })).toThrow('DSH_DESKTOP_WINDOWS_SIGNTOOL')
    expect(() => assertWindowsSigningReady({ env: {}, platform: 'win32' }))
      .toThrow('Windows Authenticode signing credentials are required')
  })

  it('rejects reserved delimiters and non-token hosts before any subprocess starts', () => {
    for (const tokenPin of ['a]b', 'a"b', 'a\nb', 'a\rb']) {
      expect(() => assertWindowsSigningReady({
        env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_TOKEN_PIN: tokenPin },
        platform: 'win32',
      }), tokenPin).toThrow('DSH_DESKTOP_WINDOWS_TOKEN_PIN cannot contain')
    }
    for (const keyContainer of ['a"b', 'a\nb', 'a\rb']) {
      expect(() => assertWindowsSigningReady({
        env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_KEY_CONTAINER: keyContainer },
        platform: 'win32',
      }), keyContainer).toThrow('DSH_DESKTOP_WINDOWS_KEY_CONTAINER cannot contain')
    }
    expect(() => assertWindowsSigningReady({ env: signingEnvironment(), platform: 'darwin' }))
      .toThrow('requires a native Windows host')
    expect(() => assertWindowsSigningReady({
      env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_SIGNTOOL: join(credentialRoot, 'signtool') },
      platform: 'win32',
    })).toThrow('DSH_DESKTOP_WINDOWS_SIGNTOOL')
  })

  it('strips every signing variable from subprocess environments that do not need them', () => {
    const input = {
      PATH: 'C:\\Windows\\System32',
      SAFE_VALUE: 'kept',
      DSH_DESKTOP_WINDOWS_TOKEN_PIN: TOKEN_PIN,
      DSH_DESKTOP_WINDOWS_CER_FILE: certificateFile,
      DSH_DESKTOP_WINDOWS_SIGN_TARGET: 'C:\\repo\\dist\\HuaAnWork.exe',
      DSH_DESKTOP_PACKAGING_RUN_DIR: 'C:\\repo\\.packaging-runs',
      csc_link: 'C:\\private\\publisher.pfx',
      win_csc_key_password: 'private-password',
    }

    const sanitized = withoutWindowsSigningSecrets(input)

    expect(sanitized).toEqual({
      PATH: 'C:\\Windows\\System32',
      SAFE_VALUE: 'kept',
      DSH_DESKTOP_PACKAGING_RUN_DIR: 'C:\\repo\\.packaging-runs',
    })
    expect(input.DSH_DESKTOP_WINDOWS_TOKEN_PIN).toBe(TOKEN_PIN)
    for (const name of WINDOWS_SIGNING_VARIABLES) {
      expect(withoutWindowsSigningSecrets({ [name]: 'placeholder', KEPT: 'kept' }), name).toEqual({ KEPT: 'kept' })
    }
  })

  it('defaults to a real RFC3161 timestamp server and allows an override', () => {
    expect(assertWindowsSigningReady({ env: signingEnvironment(), platform: 'win32' }).timestampUrl)
      .toBe(TIMESTAMP_URL)
    expect(assertWindowsSigningReady({
      env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_TIMESTAMP_URL: 'https://ts.example.test/rfc3161' },
      platform: 'win32',
    }).timestampUrl).toBe('https://ts.example.test/rfc3161')
    expect(() => assertWindowsSigningReady({
      env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_TIMESTAMP_URL: 'timestamp.digicert.com' },
      platform: 'win32',
    })).toThrow('DSH_DESKTOP_WINDOWS_TIMESTAMP_URL must be an http or https URL')
  })

  it('requires a non-CA code-signing leaf certificate', async () => {
    const directory = temporaryRoot('huaanwork-signing-certificates-')
    const authority = await generate([{ name: 'commonName', value: 'HuaAnWork test root' }], {
      algorithm: 'sha256',
      keyType: 'ec',
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, critical: true },
        { name: 'extKeyUsage', codeSigning: true, critical: true },
      ],
    })
    const authorityFile = join(directory, 'authority.cer')
    writeFileSync(authorityFile, authority.cert)
    const tlsLeaf = await generate([{ name: 'commonName', value: 'HuaAnWork test server' }], {
      algorithm: 'sha256',
      keyType: 'ec',
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'extKeyUsage', serverAuth: true, critical: true },
      ],
    })
    const tlsLeafFile = join(directory, 'server.cer')
    writeFileSync(tlsLeafFile, tlsLeaf.cert)

    expect(() => assertWindowsSigningReady({
      env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_CER_FILE: authorityFile },
      platform: 'win32',
    })).toThrow('non-CA Code Signing certificate')
    expect(() => assertWindowsSigningReady({
      env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_CER_FILE: tlsLeafFile },
      platform: 'win32',
    })).toThrow('non-CA Code Signing certificate')
    expect(() => assertWindowsSigningReady({
      env: { ...signingEnvironment(), DSH_DESKTOP_WINDOWS_CER_FILE: join(directory, 'missing.cer') },
      platform: 'win32',
    })).toThrow('missing or invalid')
  })
})

describe('buildSigntoolArgs', () => {
  it('signs with sha256 for both the file digest and the timestamp', () => {
    const args = buildSigntoolArgs({
      certificateFile: '/tmp/publisher.cer',
      keyContainer: 'huaanwork-release',
      tokenPin: '1234',
      target: '/d/HuaAnWork.exe',
      timestampUrl: TIMESTAMP_URL,
    })

    expect(args).toEqual(expect.arrayContaining([
      'sign', '/v', '/fd', 'sha256', '/td', 'sha256', '/tr', TIMESTAMP_URL,
    ]))
    expect(args).toEqual(expect.arrayContaining([
      '/f', '/tmp/publisher.cer',
      '/kc', '[{{1234}}]=huaanwork-release',
      '/csp', 'eToken Base Cryptographic Provider',
    ]))
    expect(args.at(-1)).toBe('/d/HuaAnWork.exe')
  })

  it('never interpolates the PIN into a shell string', () => {
    const args = buildSigntoolArgs({
      certificateFile: '/tmp/publisher.cer',
      keyContainer: 'huaanwork-release',
      tokenPin: 'p;rm -rf /',
      target: '/d/HuaAnWork.exe',
      timestampUrl: TIMESTAMP_URL,
    })
    const source = readFileSync(new URL('scripts/huaanwork-sign-windows.ts', PACKAGE_ROOT), 'utf8')

    // The PIN stays one argv element: no shell can reinterpret it.
    expect(Array.isArray(args)).toBe(true)
    expect(args.filter(arg => arg.includes('rm -rf'))).toEqual(['[{{p;rm -rf /}}]=huaanwork-release'])
    expect(args.join(' ')).not.toMatch(/&&|\|\|/u)
    expect(source).toContain('execFile')
    expect(source).not.toContain('shell: true')
    expect(source).not.toMatch(/\bexec\(/u)
  })

  it('verifies after signing', () => {
    expect(buildSigntoolVerifyArgs('/d/HuaAnWork.exe')).toEqual([
      'verify', '/pa', '/v', '/d/HuaAnWork.exe',
    ])
  })
})

describe('windows signing order', () => {
  it('signs the unpacked application, re-packs both artifacts from the signed tree, signs the installer, then verifies every shipped executable', async () => {
    const fixture = releaseFixture()
    const calls: CommandCall[] = []
    const logs: string[] = []

    await signWindowsRelease(releaseOptions(fixture, calls, logs))

    const signtool = calls.filter(call => call.command === signToolPath)
    expect(signtool.map(call => call.args[0])).toEqual(['sign', 'sign', 'verify', 'verify', 'verify'])
    // The app directory comes from the fork's own gate-carrying packaging entry point.
    expect(calls[0]?.command).toBe(NODE_EXECUTABLE)
    expect(calls[0]?.args).toEqual(['scripts/package-win.ts'])
    // The unpacked executable is signed in place before anything is packed.
    expect(signtool[0]?.args.at(-1)).toBe(fixture.applicationPath)
    // Both artifacts are re-packed from the signed directory with electron-builder's prepackaged path.
    const repacks = calls.filter(call => call.args[0] === BUILDER_CLI)
    expect(repacks.map(call => call.args.slice(0, 3))).toEqual([
      [BUILDER_CLI, '--win', 'zip'],
      [BUILDER_CLI, '--win', 'nsis'],
    ])
    for (const repack of repacks) {
      expect(repack.command).toBe(NODE_EXECUTABLE)
      expect(repack.args).toEqual(expect.arrayContaining([
        '--x64', '--publish', 'never', '--config.win.signExecutable=false',
        '--prepackaged', fixture.applicationDirectory,
      ]))
      expect(repack.cwd).toBe(fixture.desktopRoot)
    }
    // The installer is signed only after it was re-packed from the signed tree.
    const lastRepack = repacks.at(-1)
    const installerSign = signtool[1]
    expect(lastRepack).toBeDefined()
    expect(calls.indexOf(installerSign!)).toBeGreaterThan(calls.indexOf(lastRepack!))
    expect(installerSign?.args.at(-1)).toBe(fixture.installerPath)
    // Verification covers the shipped installer, the unpacked executable, and the archive member as shipped.
    expect(signtool[2]?.args).toEqual(buildSigntoolVerifyArgs(fixture.applicationPath))
    const portableMember = signtool[3]?.args.at(-1)
    expect(portableMember).toBeDefined()
    expect(portableMember?.startsWith(resolve(tmpdir()))).toBe(true)
    expect(signtool[4]?.args).toEqual(buildSigntoolVerifyArgs(fixture.installerPath))
    // The packaging entries' own artifact verifiers re-check the re-packed files.
    expect(calls.slice(-2).map(call => call.args[0]))
      .toEqual(['scripts/verify-win-portable.ts', 'scripts/verify-win-installer.ts'])
    // No credential value reaches a subprocess environment, and no PIN reaches the log.
    for (const call of calls) {
      for (const name of WINDOWS_SIGNING_VARIABLES) expect(call.env[name], name).toBeUndefined()
    }
    expect(logs.join('\n')).not.toContain(TOKEN_PIN)
    expect(logs.join('\n')).toContain(TIMESTAMP_URL)
  })

  it('materializes the portable executable in a private temporary directory and removes it when verification fails', async () => {
    const fixture = releaseFixture()
    const calls: CommandCall[] = []
    const options = releaseOptions(fixture, calls)
    let temporaryDirectory = ''

    await expect(signWindowsRelease({
      ...options,
      run: (command, args, cwd, env) => {
        options.run(command, args, cwd, env)
        const target = args.at(-1)
        if (args[0] !== 'verify' || target === undefined) return
        if (target === fixture.applicationPath || target === fixture.installerPath) return
        temporaryDirectory = dirname(target)
        expect(target.startsWith(resolve(tmpdir()))).toBe(true)
        if (CHECK_POSIX_MODE) {
          expect(statSync(temporaryDirectory).mode & 0o777).toBe(0o700)
          expect(statSync(target).mode & 0o777).toBe(0o600)
        }
        throw new Error('simulated signtool verification failure')
      },
    })).rejects.toThrow('simulated signtool verification failure')

    // finally semantics: the extracted copy never outlives the run, on the success and failure paths.
    expect(temporaryDirectory).not.toBe('')
    expect(existsSync(temporaryDirectory)).toBe(false)
  })

  it('removes the temporary extraction directory after a successful release too', async () => {
    const fixture = releaseFixture()
    const calls: CommandCall[] = []
    const options = releaseOptions(fixture, calls)
    let temporaryDirectory = ''

    await signWindowsRelease({
      ...options,
      run: (command, args, cwd, env) => {
        options.run(command, args, cwd, env)
        const target = args.at(-1)
        if (args[0] !== 'verify' || target === undefined) return
        if (target === fixture.applicationPath || target === fixture.installerPath) return
        temporaryDirectory = dirname(target)
      },
    })

    expect(temporaryDirectory).not.toBe('')
    expect(existsSync(temporaryDirectory)).toBe(false)
  })
})

describe('windows signing documentation', () => {
  it('keeps the release checklist credential list in sync with the signing variables', () => {
    const checklist = readFileSync(new URL('docs/release-checklist.md', WORKSPACE_ROOT), 'utf8')

    expect(WINDOWS_SIGNING_VARIABLES.length).toBe(13)
    for (const name of WINDOWS_SIGNING_VARIABLES) {
      expect(checklist, name).toContain(name)
    }
    expect(checklist).toContain('signtool verify /pa /v')
    expect(checklist).toContain('--prepackaged')
    expect(checklist).toContain('Get-AuthenticodeSignature')
    expect(checklist).not.toContain('本节由 M6 周期的 Windows Authenticode 签名工作补齐')
  })

  it('registers the signing entry points in the workspace and root manifests', () => {
    const workspaceManifest = JSON.parse(
      readFileSync(new URL('dsh-plugin-huaanwork/package.json', WORKSPACE_ROOT), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const rootManifest = JSON.parse(readFileSync(new URL('package.json', WORKSPACE_ROOT), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(workspaceManifest.scripts?.['dist:win-sign']).toBe('node scripts/huaanwork-sign-windows.ts')
    expect(rootManifest.scripts?.['dist:win-sign:huaanwork'])
      .toBe('yarn market:prepare && yarn aa:prepare-release && yarn workspace dsh-community-market build && yarn workspace dsh-plugin-huaanwork dist:win-sign')
  })
})
