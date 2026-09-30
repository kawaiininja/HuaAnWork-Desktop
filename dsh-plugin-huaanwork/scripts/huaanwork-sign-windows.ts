/** Sign the Windows x64 release artifacts with SafeNet-token Authenticode credentials. */

import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

/**
 * Sign the artifacts produced by `scripts/package-win.ts` and `scripts/package-win-portable.ts`.
 *
 * Ruling D-M6-16: this module references the upstream desktop pipeline's credential contract, token
 * flow and artifact order, but imports nothing from `deepseek-harness/`; a submodule pin bump must
 * not silently change the release path. Upstream evidence read for this implementation:
 *
 * 1. Credential contract — union of three sources, in `WINDOWS_SIGNING_VARIABLES`:
 *    - `apps/desktop/scripts/windows-sign.mjs:36-109` resolves four inputs: `DSH_DESKTOP_WINDOWS_KEY_CONTAINER`,
 *      `DSH_DESKTOP_WINDOWS_TOKEN_PIN`, `DSH_DESKTOP_WINDOWS_CER_FILE`, `DSH_DESKTOP_WINDOWS_SIGNTOOL`;
 *      `:146-156` also carries the handoff fields `DSH_DESKTOP_WINDOWS_SIGN_TARGET` and `DSH_DESKTOP_WINDOWS_SIGN_APPEND`
 *      into the signing command.
 *    - `apps/desktop/scripts/windows-signing-preflight.ts:39-44` reads the same four inputs
 *      (`:89` adds `DSH_DESKTOP_PACKAGING_RUN_DIR`, a run-evidence directory rather than a credential).
 *    - `scripts/package-win.ts:10-17` lists the six electron-builder discovery names that the fork's
 *      unsigned packaging strips, so an operator must never expect them to sign anything.
 * 2. Password approach — neither `/f` plus `/p` nor a temporary certificate store. Upstream signs with the
 *    SafeNet private key inside the hardware token: `scripts/windows-sign.cmd:16` invokes
 *    `signtool sign /fd sha256 /f <public leaf .cer> /kc "[{{PIN}}]=container" /csp "eToken Base Cryptographic Provider"
 *    /tr http://timestamp.digicert.com /td sha256 <target>`, and `apps/desktop/README.md:235-237` records that
 *    the PIN is delimited by `]`, quote and line-break rules and that SafeNet still requires the PIN on the
 *    SignTool command line. This module therefore keeps the PIN in one validated argv element, spawns without a
 *    command shell, redacts the PIN from failures, and never writes a credential to disk.
 * 3. Artifact order — electron-builder signs the unpacked application before targets pack it
 *    (`apps/desktop/scripts/electron-builder-config.mjs:59-75` wires the signer into `signtoolOptions.sign`;
 *    `windows-sign.mjs:279-300` signs the temporary NSIS bootstrap executable before it runs). The post-hoc
 *    equivalent, and the reason this module re-packs instead of signing finished artifacts in place, is
 *    `apps/desktop/scripts/test-windows-installer.mjs:80,96`: sign `payload/<ProductName>.exe`, then pack with
 *    `prepackaged: payload`. electron-builder 26.15.7 supports the same path (`electron-builder/out/builder.js:247-250`,
 *    `app-builder-lib/out/platformPackager.js:92,145-147`): `--prepackaged` makes the targets read the given
 *    directory as-is and skips `doPack`. Signing a finished portable ZIP is impossible (a ZIP carries no
 *    Authenticode signature) and signing only the outer Setup.exe would leave the archive member and the NSIS
 *    payload unsigned while the outer verification still passed — the silent defect this order prevents.
 */

const CODE_SIGNING_EKU = '1.3.6.1.5.5.7.3.3'
const SAFENET_CRYPTOGRAPHIC_PROVIDER = 'eToken Base Cryptographic Provider'
const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com'
const APPLICATION_EXECUTABLE = 'HuaAnWork.exe'
const UNPACKED_DIRECTORY = 'win-unpacked'
const PORTABLE_ARCHIVE_ENTRY = 'HuaAnWork.exe'
const PORTABLE_TEMP_PREFIX = 'huaanwork-sign-windows-'
const PRIVATE_FILE_MODE = 0o600
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024

const SIGNTOOL_VARIABLE = 'DSH_DESKTOP_WINDOWS_SIGNTOOL'
const CERTIFICATE_VARIABLE = 'DSH_DESKTOP_WINDOWS_CER_FILE'
const TOKEN_PIN_VARIABLE = 'DSH_DESKTOP_WINDOWS_TOKEN_PIN'
const KEY_CONTAINER_VARIABLE = 'DSH_DESKTOP_WINDOWS_KEY_CONTAINER'
const TIMESTAMP_VARIABLE = 'DSH_DESKTOP_WINDOWS_TIMESTAMP_URL'

/**
 * Every environment name that belongs to Windows release signing.
 *
 * Upstream token inputs, upstream handoff fields, the fork's timestamp override, and the
 * electron-builder discovery names that the unsigned packaging pass strips. The release checklist
 * credential list is generated from this constant and pinned by `tests/huaanwork-sign-windows.spec.ts`.
 */
export const WINDOWS_SIGNING_VARIABLES: readonly string[] = [
  SIGNTOOL_VARIABLE,
  CERTIFICATE_VARIABLE,
  TOKEN_PIN_VARIABLE,
  KEY_CONTAINER_VARIABLE,
  TIMESTAMP_VARIABLE,
  'DSH_DESKTOP_WINDOWS_SIGN_TARGET',
  'DSH_DESKTOP_WINDOWS_SIGN_APPEND',
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_NAME',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
]

/** Validated, non-secret release facts plus the token pairing consumed by SignTool. */
export interface WindowsSigningPlan {
  /** Absolute SignTool executable. */
  readonly signTool: string
  /** Absolute public code-signing leaf certificate. */
  readonly certificateFile: string
  /** SafeNet private-key container name. */
  readonly keyContainer: string
  /** SafeNet token PIN, delimited by the `/kc` syntax. */
  readonly tokenPin: string
  /** RFC 3161 timestamp server. */
  readonly timestampUrl: string
  /** Certificate common name, for non-secret progress output. */
  readonly publisher: string
}

/** Process inputs for the Windows signing preflight. */
export interface WindowsSigningPreflightOptions {
  /** Environment that may carry signing credentials. */
  readonly env: NodeJS.ProcessEnv
  /** Platform that would run SignTool. */
  readonly platform: NodeJS.Platform
}

/** One SignTool `sign` invocation. */
export interface SigntoolSignInput {
  /** Public code-signing leaf certificate file. */
  readonly certificateFile: string
  /** SafeNet private-key container name. */
  readonly keyContainer: string
  /** SafeNet token PIN. */
  readonly tokenPin: string
  /** Artifact to sign. */
  readonly target: string
  /** RFC 3161 timestamp server. */
  readonly timestampUrl: string
  /** Append to an existing signature instead of replacing it. */
  readonly append?: boolean
}

/** Extraction of one archive member that its owner removes. */
export interface MaterializedExecutable {
  /** Extracted member inside the private temporary directory. */
  readonly path: string
  /** Remove the extract this call created. */
  readonly remove: () => void
}

/** Injectable release boundary used by focused tests and by the packaging entries' conventions. */
export interface WindowsSignReleaseOptions {
  /** Environment containing the selected signing credentials. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the release. */
  readonly platform: NodeJS.Platform
  /** Desktop package root containing package.json and dist. */
  readonly desktopRoot: string
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /** Absolute electron-builder CLI module used for the signed-tree re-pack. */
  readonly builderCli: string
  /** Execute one release command with an already scrubbed environment. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void | Promise<void>
  /** Report non-secret release progress. */
  readonly log: (message: string) => void
  /** Materialize the portable archive's application executable for verification. */
  readonly materializePortableExecutable?: (portablePath: string) => MaterializedExecutable
}

/**
 * Remove every signing variable before starting a subprocess that does not need it.
 * @param environment - Environment that may contain Windows signing credentials.
 * @returns A copy without any recognized signing variable; Windows names compare case-insensitively.
 */
export function withoutWindowsSigningSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment }
  const signing = new Set(WINDOWS_SIGNING_VARIABLES)
  for (const name of Object.keys(sanitized)) {
    if (signing.has(name.toUpperCase())) delete sanitized[name]
  }
  return sanitized
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim()
  return value === '' ? undefined : value
}

function resolveSignTool(candidate: string): string {
  let path: string
  try {
    path = realpathSync(candidate)
    if (!statSync(path).isFile() || !path.toLowerCase().endsWith('.exe')) throw new Error('not an executable file')
  } catch {
    throw new Error(`${SIGNTOOL_VARIABLE} is missing or is not an executable file: ${candidate}`)
  }
  return path
}

function resolveCertificate(candidate: string): { path: string; certificate: X509Certificate } {
  let path: string
  let certificate: X509Certificate
  try {
    path = realpathSync(candidate)
    certificate = new X509Certificate(readFileSync(path))
  } catch {
    throw new Error(`Windows code-signing certificate file is missing or invalid: ${candidate}`)
  }
  if (certificate.ca || !certificate.keyUsage?.includes(CODE_SIGNING_EKU)) {
    throw new Error(`Windows code-signing certificate file must contain a non-CA Code Signing certificate: ${path}`)
  }
  return { path, certificate }
}

function resolveTimestampUrl(environment: NodeJS.ProcessEnv): string {
  const override = environmentValue(environment, TIMESTAMP_VARIABLE)
  if (override === undefined) return DEFAULT_TIMESTAMP_URL
  let url: URL
  try {
    url = new URL(override)
  } catch {
    throw new Error(`${TIMESTAMP_VARIABLE} must be an http or https URL: ${override}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${TIMESTAMP_VARIABLE} must be an http or https URL: ${override}`)
  }
  return override
}

function certificatePublisher(certificate: X509Certificate): string {
  const commonName = certificate.toLegacyObject().subject.CN
  return typeof commonName === 'string' && commonName.trim() !== '' ? commonName : certificate.subject
}

/**
 * Assert that the SafeNet token contract is complete before any signing subprocess starts.
 * @param options - Process inputs for the preflight.
 * @returns Validated release facts; incomplete or malformed credentials never reach SignTool.
 */
export function assertWindowsSigningReady(options: WindowsSigningPreflightOptions): WindowsSigningPlan {
  if (options.platform !== 'win32') {
    throw new Error('Windows Authenticode signing requires a native Windows host')
  }
  const names = [SIGNTOOL_VARIABLE, CERTIFICATE_VARIABLE, TOKEN_PIN_VARIABLE, KEY_CONTAINER_VARIABLE] as const
  const present = names.filter(name => environmentValue(options.env, name) !== undefined)
  if (present.length === 0) {
    throw new Error(
      `Windows Authenticode signing credentials are required: set ${names.join(', ')}`
      + ' (electron-builder discovery variables such as CSC_LINK are stripped by the unsigned packaging pass and never sign anything)',
    )
  }
  if (present.length !== names.length) {
    const missing = names.filter(name => !present.includes(name))
    throw new Error(`Incomplete Windows Authenticode signing credentials: missing ${missing.join(', ')}`)
  }

  const keyContainer = environmentValue(options.env, KEY_CONTAINER_VARIABLE)!
  if (/["\r\n]/u.test(keyContainer)) {
    throw new Error(`${KEY_CONTAINER_VARIABLE} cannot contain quotes or line breaks because the SafeNet key-container syntax uses them as delimiters`)
  }
  const tokenPin = environmentValue(options.env, TOKEN_PIN_VARIABLE)!
  if (/[\]"\r\n]/u.test(tokenPin)) {
    throw new Error(`${TOKEN_PIN_VARIABLE} cannot contain "]", quotes, or line breaks because the SafeNet key-container syntax uses them as delimiters`)
  }

  const signTool = resolveSignTool(environmentValue(options.env, SIGNTOOL_VARIABLE)!)
  const { path: certificateFile, certificate } = resolveCertificate(environmentValue(options.env, CERTIFICATE_VARIABLE)!)
  return {
    signTool,
    certificateFile,
    keyContainer,
    tokenPin,
    timestampUrl: resolveTimestampUrl(options.env),
    publisher: certificatePublisher(certificate),
  }
}

/**
 * Build one SignTool `sign` argv array.
 * @param input - Token pairing and target artifact.
 * @returns Arguments for SignTool; the SHA-256 file digest and RFC 3161 timestamp match upstream.
 */
export function buildSigntoolArgs(input: SigntoolSignInput): readonly string[] {
  return [
    'sign',
    '/v',
    '/fd',
    'sha256',
    '/f',
    input.certificateFile,
    '/kc',
    `[{{${input.tokenPin}}}]=${input.keyContainer}`,
    '/csp',
    SAFENET_CRYPTOGRAPHIC_PROVIDER,
    ...(input.append === true ? ['/as'] : []),
    '/tr',
    input.timestampUrl,
    '/td',
    'sha256',
    input.target,
  ]
}

/**
 * Build the SignTool `verify` argv array.
 * @param target - Signed artifact to verify.
 * @returns Arguments for `signtool verify /pa /v`.
 */
export function buildSigntoolVerifyArgs(target: string): readonly string[] {
  return ['verify', '/pa', '/v', target]
}

function readProductVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`desktop package at ${desktopRoot} has no valid version`)
  }
  return manifest.version
}

/**
 * Resolve the artifact layout the packaging entries produce (`scripts/verify-win-installer.ts:86-91`,
 * `scripts/verify-win-portable.ts:39-44`).
 * @param desktopRoot - Desktop package root.
 * @returns Absolute artifact paths for the current product version.
 */
function resolveReleasePaths(desktopRoot: string): {
  applicationDirectory: string
  applicationPath: string
  installerPath: string
  portablePath: string
} {
  const version = readProductVersion(desktopRoot)
  const applicationDirectory = join(desktopRoot, 'dist', UNPACKED_DIRECTORY)
  return {
    applicationDirectory,
    applicationPath: join(applicationDirectory, APPLICATION_EXECUTABLE),
    installerPath: join(desktopRoot, 'dist', `HuaAnWork-${version}-x64-Setup.exe`),
    portablePath: join(desktopRoot, 'dist', `HuaAnWork-${version}-x64-Portable.zip`),
  }
}

function defaultMaterializePortableExecutable(portablePath: string): MaterializedExecutable {
  const entry = new AdmZip(portablePath).getEntry(PORTABLE_ARCHIVE_ENTRY)
  if (entry === null || entry === undefined) {
    throw new Error(`Windows portable archive is missing ${PORTABLE_ARCHIVE_ENTRY}: ${portablePath}`)
  }
  const directory = mkdtempSync(join(tmpdir(), PORTABLE_TEMP_PREFIX))
  // `mkdtemp` creates the directory with mode 0700 on POSIX; the extracted copy stays private too.
  try {
    const path = join(directory, PORTABLE_ARCHIVE_ENTRY)
    writeFileSync(path, entry.getData(), { mode: PRIVATE_FILE_MODE })
    return { path, remove: () => { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((settle, fail) => {
    const child = execFile(command, [...args], {
      cwd,
      env,
      windowsHide: true,
      maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
    })
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
    child.on('error', fail)
    child.on('close', (code, signal) => {
      if (code === 0) settle()
      else fail(new Error(`${basename(command)} exited with ${code ?? `signal ${signal ?? 'unknown'}`}`))
    })
  })
}

function defaultReleaseOptions(): WindowsSignReleaseOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const require = createRequire(import.meta.url)
  return {
    env: process.env,
    platform: process.platform,
    desktopRoot,
    nodeExecutable: process.execPath,
    builderCli: require.resolve('electron-builder/cli.js'),
    run: runCommand,
    log: message => console.log(message),
  }
}

function redactedFailure(cause: unknown, target: string, tokenPin: string, action: string): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(`Windows Authenticode ${action} failed for ${target}: ${message.replaceAll(tokenPin, '<redacted>')}`)
}

/**
 * Sign, re-pack and verify the Windows x64 release artifacts.
 *
 * Order: the unsigned packaging entry point materializes the application directory, the unpacked
 * executable is signed in place, both distributable artifacts are re-packed from that signed
 * directory, the installer is signed, and every shipped executable is verified.
 * @param options - Injectable process and command boundaries.
 */
export async function signWindowsRelease(
  options: WindowsSignReleaseOptions = defaultReleaseOptions(),
): Promise<void> {
  const plan = assertWindowsSigningReady({ env: options.env, platform: options.platform })
  const environment = withoutWindowsSigningSecrets(options.env)
  const paths = resolveReleasePaths(options.desktopRoot)
  options.log(
    `Windows Authenticode signing preflight passed: ${plan.publisher}; token key container ${plan.keyContainer};`
    + ` RFC3161 timestamp ${plan.timestampUrl}; certificate ${plan.certificateFile}`,
  )

  // The packaging entry point owns the headless gates and the unsigned artifacts; the signed
  // artifacts below are re-packed from the directory it produces.
  options.log('Building the unsigned Windows x64 installer to materialize the application directory.')
  await options.run(options.nodeExecutable, ['scripts/package-win.ts'], options.desktopRoot, environment)

  const sign = async (target: string): Promise<void> => {
    try {
      await options.run(plan.signTool, buildSigntoolArgs({
        certificateFile: plan.certificateFile,
        keyContainer: plan.keyContainer,
        tokenPin: plan.tokenPin,
        target,
        timestampUrl: plan.timestampUrl,
      }), options.desktopRoot, environment)
    } catch (cause) {
      throw redactedFailure(cause, target, plan.tokenPin, 'signing')
    }
  }
  const verify = async (target: string): Promise<void> => {
    try {
      await options.run(plan.signTool, buildSigntoolVerifyArgs(target), options.desktopRoot, environment)
    } catch (cause) {
      throw redactedFailure(cause, target, plan.tokenPin, 'verification')
    }
  }

  options.log(`Signing the unpacked application executable: ${paths.applicationPath}`)
  await sign(paths.applicationPath)

  // Both distributables are packed from the signed directory: the NSIS payload and the portable
  // archive would otherwise ship an unsigned application executable behind a valid outer signature.
  for (const target of ['zip', 'nsis'] as const) {
    options.log(`Re-packing the Windows ${target} artifact from the signed application directory.`)
    await options.run(options.nodeExecutable, [
      options.builderCli,
      '--win',
      target,
      '--x64',
      '--publish',
      'never',
      '--config.win.signExecutable=false',
      '--prepackaged',
      paths.applicationDirectory,
    ], options.desktopRoot, environment)
  }

  options.log(`Signing the NSIS installer: ${paths.installerPath}`)
  await sign(paths.installerPath)

  const portable = (options.materializePortableExecutable ?? defaultMaterializePortableExecutable)(
    paths.portablePath,
  )
  try {
    options.log(`Verifying the shipped executables with ${basename(plan.signTool)} verify /pa /v.`)
    await verify(paths.applicationPath)
    await verify(portable.path)
    await verify(paths.installerPath)
  } finally {
    portable.remove()
  }

  // Re-run the packaging entry points' artifact verifiers over the re-packed files.
  await options.run(options.nodeExecutable, ['scripts/verify-win-portable.ts'], options.desktopRoot, environment)
  await options.run(options.nodeExecutable, ['scripts/verify-win-installer.ts'], options.desktopRoot, environment)
  options.log(`Windows Authenticode release signed and verified: ${paths.installerPath}, ${paths.portablePath}`)
}

async function main(): Promise<void> {
  try {
    await signWindowsRelease()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) void main()
