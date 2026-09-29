/**
 * Publish-side installer gate (Task 3.3).
 *
 * `validateInstallerShape` mirrors the client's private validateArtifact
 * (dsh-plugin-huaanwork/src/update-download.ts:482): the same magic constants
 * (512-byte `koly` DMG trailer, 64-byte DOS header with `MZ`, the PE offset at
 * 0x3c, `PE\0\0`) and the same size rule (non-empty, at most 1 GiB). Both
 * sides assert against the committed shared fixture in
 * tests/fixtures/installer-shapes, so a drift on either side fails its own
 * spec.
 *
 * `assertMacArtifactIsUniversal` pins the mac channel to universal-only
 * artifacts (2026-09-28 P1-1: the download endpoint has no architecture
 * dimension, so an Intel client handed an arm64-only image would pass the koly
 * check and only fail at mount time). The real artifact is an electron-builder
 * UDIF dmg (`electron-builder --mac dmg --universal`), and its architectures
 * live in the .app packed inside the image: `lipo -info` cannot read a disk
 * image at all (exit 1, "can't figure out the architecture type") and `file`
 * reports only the container ("zlib compressed data"). That opacity is the
 * reason the gate exists, so it works in three steps: the basename must carry
 * the release pipeline's `universal` marker (electron-builder names the
 * artifact `<product>-<version>-universal.dmg`, and a single-arch CI smoke
 * package never carries it); a fat Mach-O is read directly; a disk image is
 * mounted read-only and the executable inside its packed .app carries the
 * report. Mounting needs `hdiutil`, so a host without it refuses - mac
 * artifacts must be published from a macOS host (deployment runbook, Task 3.5).
 *
 * Both functions are publish-side and test-only: scripts/publish-release.mjs
 * refuses to publish a bad artifact before any record is written. The read-only
 * server never validates the bytes it hosts (that would put a per-request file
 * read on the request path), so NOTHING here is reachable from an HTTP route.
 *
 * Only the header, the trailer, and - once a dmg is mounted - the packed
 * executable's Mach-O header are ever read (open + positioned read, the
 * client's own discipline): an installer may reach 1 GiB, and a whole-file
 * buffer would put the process's memory peak at that magnitude (D-M6-12).
 */

import { execFile } from 'node:child_process'
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** Maximum publishable installer size; equals the client's MAX_UPDATE_DOWNLOAD_BYTES. */
export const PUBLISH_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024

const DMG_TRAILER_BYTES = 512
const DMG_TRAILER_MAGIC = Buffer.from('koly', 'ascii')
const DOS_HEADER_BYTES = 64
const PE_OFFSET_POSITION = 0x3c
const PE_MAGIC = Buffer.from([0x50, 0x45, 0x00, 0x00])

/**
 * The artifact cannot be published: it fails the shape, size, or mac-universal
 * gate. The message is operator guidance and never carries file contents.
 */
export class InvalidInstallerError extends Error {
  readonly code = 'invalid-installer'
  readonly platform: 'darwin' | 'win32'

  constructor(platform: 'darwin' | 'win32', reason: string) {
    super(`update-server: refusing to publish this ${platform} artifact: ${reason}`)
    this.name = 'InvalidInstallerError'
    this.platform = platform
  }
}

/**
 * Whether the bytes at `path` are a plausible installer for `platform`.
 *
 * @param platform - `darwin` checks the UDIF trailer, `win32` the PE header.
 * @param path - artifact to inspect; only its stat, first 64 bytes, and last
 *   512 bytes are read.
 * @returns nothing when the artifact may be published.
 * @throws InvalidInstallerError when it may not (including unreadable paths).
 */
export async function validateInstallerShape(platform: 'darwin' | 'win32', path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    throw new InvalidInstallerError(platform, `the file cannot be read (${path})`)
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new InvalidInstallerError(platform, 'the path is not a regular file')
    if (stats.size <= 0) throw new InvalidInstallerError(platform, 'the file is empty')
    if (stats.size > PUBLISH_MAX_ARTIFACT_BYTES) {
      throw new InvalidInstallerError(
        platform,
        `the file is ${String(stats.size)} bytes, over the ${String(PUBLISH_MAX_ARTIFACT_BYTES)}-byte client download cap`,
      )
    }

    if (platform === 'darwin') {
      if (stats.size < DMG_TRAILER_BYTES) {
        throw new InvalidInstallerError(platform, 'the file is shorter than the 512-byte DMG trailer')
      }
      const magic = Buffer.alloc(DMG_TRAILER_MAGIC.byteLength)
      const result = await handle.read(magic, 0, magic.byteLength, stats.size - DMG_TRAILER_BYTES)
      if (result.bytesRead !== magic.byteLength || !magic.equals(DMG_TRAILER_MAGIC)) {
        throw new InvalidInstallerError(platform, "the final 512 bytes do not start with the 'koly' DMG trailer magic")
      }
      return
    }

    if (stats.size < DOS_HEADER_BYTES) {
      throw new InvalidInstallerError(platform, 'the file is shorter than the 64-byte DOS header')
    }
    const dosHeader = Buffer.alloc(DOS_HEADER_BYTES)
    const dosResult = await handle.read(dosHeader, 0, dosHeader.byteLength, 0)
    if (dosResult.bytesRead !== dosHeader.byteLength || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw new InvalidInstallerError(platform, "the file does not start with the DOS 'MZ' signature")
    }
    const peOffset = dosHeader.readUInt32LE(PE_OFFSET_POSITION)
    if (peOffset > stats.size - PE_MAGIC.byteLength) {
      throw new InvalidInstallerError(platform, `the PE header offset ${String(peOffset)} is past the end of the file`)
    }
    const peMagic = Buffer.alloc(PE_MAGIC.byteLength)
    const peResult = await handle.read(peMagic, 0, peMagic.byteLength, peOffset)
    if (peResult.bytesRead !== peMagic.byteLength || !peMagic.equals(PE_MAGIC)) {
      throw new InvalidInstallerError(platform, `the file has no 'PE\\0\\0' signature at offset ${String(peOffset)}`)
    }
  } finally {
    await handle.close()
  }
}

/** The two slices a universal mac artifact must carry. */
const UNIVERSAL_ARCHITECTURES = ['x86_64', 'arm64'] as const
/** The release pipeline's marker; electron-builder emits `<product>-<version>-universal.dmg`. */
const UNIVERSAL_MARKER = /universal/iu
/** `file(1)` descriptions of a compressed container whose architecture it cannot report. */
const DISK_IMAGE_DESCRIPTION = /disk image|zlib|bzip2|lzfse|compressed data/iu

interface CommandResult {
  /** Process exit status. */
  readonly code: number
  /** Combined stdout and stderr, untrimmed. */
  readonly output: string
}

/**
 * Run an inspection command and capture its combined output.
 *
 * Returns null when the command itself is unavailable (ENOENT), so the caller
 * can tell "the tool is missing" from "the tool ran and could not read the
 * bytes" - the two need different operator guidance.
 */
async function runCommand(command: string, args: readonly string[]): Promise<CommandResult | null> {
  return new Promise(resolvePromise => {
    execFile(command, [...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolvePromise(null)
        return
      }
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolvePromise({ code, output: `${stdout}\n${stderr}` })
    })
  })
}

/** How the architectures of a file were (or could not be) read. */
type ArchitectureReading =
  | { readonly kind: 'universal' }
  | { readonly kind: 'thin'; readonly report: string }
  | { readonly kind: 'disk-image' }
  | { readonly kind: 'unclassified'; readonly report: string | null }

/**
 * Read the architecture report from the file's own bytes where the tooling can
 * see them: `lipo -info` reads Mach-O containers (fat or thin) directly, and
 * `file(1)` is the fallback when lipo is not installed. Anything else is a
 * candidate disk image when `file` describes a compressed container or the
 * `koly` trailer is present - the trailer is the dmgs' own marker, so `file`
 * reporting something unexpected does not hide a genuine image.
 */
async function readArchitecture(path: string): Promise<ArchitectureReading> {
  const lipo = await runCommand('lipo', ['-info', path])
  if (lipo !== null && lipo.code === 0) {
    return namesEveryUniversalArchitecture(lipo.output)
      ? { kind: 'universal' }
      : { kind: 'thin', report: summarizeOutput(lipo.output) }
  }

  const file = await runCommand('file', [path])
  const fileReport = file !== null && file.code === 0 ? file.output : ''
  if (fileReport.includes('Mach-O')) {
    return namesEveryUniversalArchitecture(fileReport)
      ? { kind: 'universal' }
      : { kind: 'thin', report: summarizeOutput(fileReport) }
  }
  if (DISK_IMAGE_DESCRIPTION.test(fileReport) || await endsWithDmgTrailer(path)) return { kind: 'disk-image' }

  const parts: string[] = []
  if (lipo !== null) parts.push(summarizeOutput(lipo.output))
  if (fileReport !== '') parts.push(summarizeOutput(fileReport))
  const report = parts.filter(part => part !== '').join(' / ')
  return { kind: 'unclassified', report: report === '' ? null : report }
}

/**
 * Whether a report names both slices. Matched as whole tokens so the
 * `arm64e` subtype does not satisfy the `arm64` requirement.
 */
function namesEveryUniversalArchitecture(report: string): boolean {
  const tokens = architectureTokens(report)
  return UNIVERSAL_ARCHITECTURES.every(architecture => tokens.includes(architecture))
}

function architectureTokens(report: string): readonly string[] {
  return report.split(/[^0-9A-Za-z_]+/u).filter(token => token !== '')
}

function summarizeOutput(output: string): string {
  return output.trim().replace(/\s+/gu, ' ')
}

/** The shared refusal text for a file whose report does not name both slices. */
function notUniversalMessage(subject: string, reading: ArchitectureReading): string {
  if (reading.kind === 'thin') {
    return `${subject} is not universal: the architecture report (${reading.report}) does not name both x86_64 and arm64;`
      + ' the mac channel is universal-only, and a single-arch CI smoke package is not a release artifact'
  }
  if (reading.kind === 'unclassified') {
    return `${subject} is not a readable Mach-O binary${reading.report === null ? '' : ` (${reading.report})`}`
  }
  return `${subject} is a disk image, not a Mach-O binary`
}

/**
 * Whether the mac artifact carries both the Intel and the Apple silicon slice.
 *
 * Real mac artifacts are electron-builder UDIF dmgs whose architectures are
 * hidden inside the image, so the gate first requires the release pipeline's
 * `universal` marker in the basename, then reads a fat Mach-O directly, and
 * mounts a disk image read-only to read the executable inside its packed .app
 * (see the module comment for why). A host without `hdiutil` refuses: mac
 * artifacts must be published from a macOS host.
 *
 * @param path - dmg to inspect; its basename must carry `universal`.
 * @returns nothing when the artifact is universal.
 * @throws InvalidInstallerError when it is not, or cannot be determined.
 */
export async function assertMacArtifactIsUniversal(path: string): Promise<void> {
  const name = basename(path)
  if (!UNIVERSAL_MARKER.test(name)) {
    throw new InvalidInstallerError(
      'darwin',
      `the artifact filename ${JSON.stringify(name)} carries no universal marker; the release pipeline names this artifact <product>-<version>-universal.dmg`
        + ' (electron-builder --mac dmg --universal), and a single-arch CI smoke package is not a release artifact',
    )
  }

  const reading = await readArchitecture(path)
  if (reading.kind === 'universal') return
  if (reading.kind === 'disk-image') {
    await assertPackedAppIsUniversal(path)
    return
  }
  if (reading.kind === 'unclassified' && reading.report === null) {
    throw new InvalidInstallerError(
      'darwin',
      'neither lipo nor file is available to determine whether this dmg is universal, and the mac channel is universal-only',
    )
  }
  throw new InvalidInstallerError('darwin', notUniversalMessage(`the mac artifact ${JSON.stringify(name)}`, reading))
}

/**
 * Verify the architectures of the .app packed inside a dmg.
 *
 * `lipo` and `file` read the image's compressed container, not the Mach-O
 * files in it, so the image is mounted read-only and the app's executable is
 * inspected in place. The mount is always released: `hdiutil detach`, then
 * `hdiutil detach -force` if that fails. A cleanup failure never masks the
 * verification result, and is raised only when the artifact itself passed.
 */
async function assertPackedAppIsUniversal(artifactPath: string): Promise<void> {
  if (process.platform !== 'darwin') throw missingHdiutilError(process.platform)

  const mountPoint = await mkdtemp(join(tmpdir(), 'update-server-dmg-'))
  let verified = false
  let detachFailure: string | null = null
  try {
    const attach = await runCommand('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, artifactPath])
    if (attach === null) throw missingHdiutilError(process.platform)
    if (attach.code !== 0) {
      throw new InvalidInstallerError(
        'darwin',
        `the dmg could not be mounted read-only to inspect the app inside it: hdiutil attach exited ${String(attach.code)}`
          + ` (${summarizeOutput(attach.output)})`,
      )
    }

    const executable = await findPackedAppExecutable(mountPoint)
    const reading = await readArchitecture(executable)
    if (reading.kind !== 'universal') {
      throw new InvalidInstallerError(
        'darwin',
        notUniversalMessage(`the executable ${basename(executable)} inside the dmg`, reading),
      )
    }
    verified = true
  } finally {
    detachFailure = await detachDiskImage(mountPoint)
    try {
      await rm(mountPoint, { recursive: true, force: true })
    } catch {
      // A volume that could not be detached keeps its mount point busy; the
      // detach result below (or the verification error) is what matters.
    }
  }

  if (verified && detachFailure !== null) {
    throw new InvalidInstallerError(
      'darwin',
      `the dmg was verified universal but the image could not be detached again (${detachFailure});`
        + ` unmount ${mountPoint} before publishing again`,
    )
  }
}

/**
 * The executable of the .app bundle at the volume root
 * (`<app>.app/Contents/MacOS/<name>`): the file whose Mach-O header carries
 * the architectures. The bundle's own executable name is preferred when
 * several files are executable.
 *
 * @param mountPoint - root of the read-only mounted image.
 * @returns absolute path of the executable inside the mounted image.
 * @throws InvalidInstallerError when no app bundle or no executable is found.
 */
async function findPackedAppExecutable(mountPoint: string): Promise<string> {
  const entries = await readdir(mountPoint, { withFileTypes: true })
  const appName = entries
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'))
    .map(entry => entry.name)
    .sort()
    .at(0)
  if (appName === undefined) {
    const found = entries.map(entry => entry.name).sort().join(', ')
    throw new InvalidInstallerError('darwin', `the dmg has no .app bundle at its volume root (found: ${found === '' ? 'nothing' : found})`)
  }

  const macosDirectory = join(mountPoint, appName, 'Contents', 'MacOS')
  const names = await readdir(macosDirectory).catch(() => null)
  if (names === null) {
    throw new InvalidInstallerError('darwin', `the .app bundle ${appName} inside the dmg has no Contents/MacOS directory`)
  }

  const executables: string[] = []
  for (const name of [...names].sort()) {
    const stats = await stat(join(macosDirectory, name)).catch(() => null)
    if (stats !== null && stats.isFile() && (stats.mode & 0o111) !== 0) executables.push(name)
  }
  const preferred = appName.slice(0, -'.app'.length)
  const executableName = executables.includes(preferred) ? preferred : executables[0]
  if (executableName === undefined) {
    throw new InvalidInstallerError(
      'darwin',
      `the .app bundle ${appName} inside the dmg has no executable in Contents/MacOS (found: ${names.sort().join(', ')})`,
    )
  }
  return join(macosDirectory, executableName)
}

/**
 * Eject a mounted image, forcing when the plain detach fails.
 *
 * Returns a description of the failure when even the forced detach fails, and
 * never throws, so a cleanup problem cannot mask the verification result
 * inside a `finally`.
 */
async function detachDiskImage(mountPoint: string): Promise<string | null> {
  const detach = await runCommand('hdiutil', ['detach', mountPoint])
  if (detach !== null && detach.code === 0) return null
  const forced = await runCommand('hdiutil', ['detach', '-force', mountPoint])
  if (forced !== null && forced.code === 0) return null
  const attempts = [detach, forced].filter((attempt): attempt is CommandResult => attempt !== null)
  if (attempts.length === 0) return 'hdiutil is no longer available'
  return attempts.map(attempt => `exit ${String(attempt.code)}: ${summarizeOutput(attempt.output)}`).join('; ')
}

/** The image cannot be inspected without hdiutil, which only macOS hosts have. */
function missingHdiutilError(platform: string): InvalidInstallerError {
  return new InvalidInstallerError(
    'darwin',
    `hdiutil is not available on this host (${platform}), so the app packed inside the dmg cannot be inspected and`
      + ' universality cannot be verified here; mac artifacts must be published from a macOS host',
  )
}

/** Whether the file ends with the 512-byte UDIF `koly` trailer. */
async function endsWithDmgTrailer(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    return false
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size < DMG_TRAILER_BYTES) return false
    const magic = Buffer.alloc(DMG_TRAILER_MAGIC.byteLength)
    const result = await handle.read(magic, 0, magic.byteLength, stats.size - DMG_TRAILER_BYTES)
    return result.bytesRead === magic.byteLength && magic.equals(DMG_TRAILER_MAGIC)
  } finally {
    await handle.close()
  }
}
