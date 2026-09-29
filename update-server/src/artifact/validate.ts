/**
 * Publish-side installer gate (Task 3.3).
 *
 * `validateInstallerShape` mirrors the client's private validateArtifact
 * (dsh-plugin-huaanwork/src/update-download.ts:482): the same magic constants
 * (512-byte `koly` DMG trailer, 64-byte DOS header with `MZ`, the PE offset at
 * 0x3c, `PE\0\0`) and the same size rule (non-empty, at most 1 GiB). Both
 * sides assert against the committed shared fixture in
 * tests/fixtures/installer-shapes, so a drift on either side fails its own
 * spec. `assertMacArtifactIsUniversal` additionally pins the mac channel to
 * universal-only artifacts (2026-09-28 P1-1: the download endpoint has no
 * architecture dimension, so an Intel client handed an arm64-only image would
 * pass the koly check and only fail at mount time).
 *
 * Both functions are publish-side and test-only: scripts/publish-release.mjs
 * refuses to publish a bad artifact before any record is written. The read-only
 * server never validates the bytes it hosts (that would put a per-request file
 * read on the request path), so NOTHING here is reachable from an HTTP route.
 *
 * Only the header and the trailer are ever read (open + positioned read, the
 * client's own discipline): an installer may reach 1 GiB, and a whole-file
 * buffer would put the process's memory peak at that magnitude (D-M6-12).
 */

import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'

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

/**
 * Whether a dmg carries both the Intel and the Apple silicon slice.
 *
 * Reads the architecture report from `lipo -info`, falling back to `file` when
 * lipo is not installed. The output must name both `x86_64` and `arm64`:
 * lipo exits 0 for a thin file, so the report text - not the exit code - is the
 * criterion. With neither tool available the artifact is refused (fail closed).
 *
 * @param path - dmg to inspect.
 * @returns nothing when the artifact is universal.
 * @throws InvalidInstallerError when it is not, or cannot be determined.
 */
export async function assertMacArtifactIsUniversal(path: string): Promise<void> {
  let report = await runArchitectureReport('lipo', ['-info', path])
  if (report === null) report = await runArchitectureReport('file', [path])
  if (report === null) {
    throw new InvalidInstallerError(
      'darwin',
      'neither lipo nor file is available to verify that this dmg is universal, and the mac channel is universal-only',
    )
  }
  const missing = ['x86_64', 'arm64'].filter(architecture => !report.includes(architecture))
  if (missing.length > 0) {
    throw new InvalidInstallerError(
      'darwin',
      `the dmg is not a universal binary (missing ${missing.join(' and ')} in the ${JSON.stringify(report.trim())} report);` +
        ' the mac channel is universal-only, and a CI smoke package is not a release artifact',
    )
  }
}

/**
 * Run a report command and return its combined output, or null when the
 * command itself is unavailable (ENOENT). A command that runs but fails still
 * returns its output: a non-zero lipo exit means "no architecture report", and
 * the caller refuses on the missing architecture names rather than on the exit
 * code.
 */
async function runArchitectureReport(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise(resolvePromise => {
    execFile(command, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolvePromise(null)
        return
      }
      resolvePromise(`${stdout}\n${stderr}`)
    })
  })
}
