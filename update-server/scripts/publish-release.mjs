#!/usr/bin/env node
/**
 * Release publisher for the read-only intranet update server (Task 3.3).
 *
 * Runs on the deploy host, next to `<dataDir>`. There is no upload endpoint:
 * the operator copies the artifact into the data directory with scp and then
 * runs this script, which is the only writer of
 * `<dataDir>/channels/<channel>.json` (the server itself only ever reads it).
 *
 * Steps, in order; any failure exits non-zero and writes nothing:
 *
 *   1 installer shape   validateInstallerShape - the same criteria the client
 *                       applies after downloading (koly trailer / PE header)
 *   2 mac universal     assertMacArtifactIsUniversal - the mac channel has no
 *                       architecture dimension, so only universal dmgs may be
 *                       published (2026-09-28 P1-1)
 *   3 artifact size     at most PUBLISH_MAX_ARTIFACT_BYTES, the client's cap
 *   4 version shape     matchesChannelVersionShape for the target channel
 *   5 sha256            streamed (createReadStream + hash.update, never a
 *                       whole-file read: installers reach 1 GiB, D-M6-12) over
 *                       the file the download route will actually serve
 *   6 placement         the artifact must already be at
 *                       <dataDir>/artifacts/<channel>/<platform>/<filename>;
 *                       the check runs before the hash so the recorded digest
 *                       is always the digest of the served bytes
 *   7 record            atomic write (temp file + rename, 0600 / dir 0700)
 *                       merging platforms of the same version
 *
 * Usage:
 *   node scripts/publish-release.mjs --channel huaanwork --version 0.2.0 \
 *     --platform mac|windows --file <dataDir>/artifacts/<channel>/<platform>/<name> \
 *     [--data-dir <dataDir>]
 *
 * --data-dir defaults to the UPDATE_SERVER_DATA_DIR environment variable, the
 * same variable the server reads.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  createReadStream,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { PUBLISH_MAX_ARTIFACT_BYTES, assertMacArtifactIsUniversal, validateInstallerShape } from '../src/artifact/validate.ts'
import { UPDATE_SERVER_CHANNELS, isUpdateServerChannel, matchesChannelVersionShape } from '../src/channels.ts'

/** Which gate each published directory name runs, and where its files live. */
const PLATFORMS = Object.freeze({
  mac: { validateAs: 'darwin' },
  windows: { validateAs: 'win32' },
})

const RECORD_DIRECTORY_MODE = 0o700
const RECORD_FILE_MODE = 0o600
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/** The invocation or the artifact cannot be published; `step` names the failed step. */
class PublishError extends Error {
  constructor(step, message) {
    super(message)
    this.name = 'PublishError'
    this.step = step
  }
}

function refuse(step, message) {
  throw new PublishError(step, message)
}

function parseArguments(argv) {
  const known = new Set(['channel', 'version', 'platform', 'file', 'data-dir'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) refuse('arguments', `unexpected argument ${JSON.stringify(token)}`)
    const separator = token.indexOf('=')
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator)
    if (!known.has(name)) refuse('arguments', `unknown option --${name}; known options are ${[...known].join(', ')}`)
    if (values.has(name)) refuse('arguments', `--${name} was given twice`)
    let value
    if (separator === -1) {
      index += 1
      value = argv[index]
    } else {
      value = token.slice(separator + 1)
    }
    if (value === undefined || value === '') refuse('arguments', `--${name} needs a value`)
    values.set(name, value)
  }
  const required = name => {
    const value = values.get(name)
    if (value === undefined) refuse('arguments', `--${name} is required`)
    return value
  }
  return { channel: required('channel'), version: required('version'), platform: required('platform'), file: required('file'), dataDir: values.get('data-dir') }
}

function resolveDataDir(raw) {
  const value = raw ?? process.env.UPDATE_SERVER_DATA_DIR
  if (value === undefined || value.trim() === '') {
    refuse('arguments', 'no data directory: pass --data-dir or set UPDATE_SERVER_DATA_DIR')
  }
  if (!isAbsolute(value)) refuse('arguments', `the data directory must be an absolute path, got ${JSON.stringify(value)}`)
  return resolve(value)
}

function requireChannel(raw) {
  if (!isUpdateServerChannel(raw)) {
    refuse('arguments', `--channel must be one of ${UPDATE_SERVER_CHANNELS.join(', ')}, got ${JSON.stringify(raw)}`)
  }
  return raw
}

function requirePlatform(raw) {
  if (!Object.hasOwn(PLATFORMS, raw)) {
    refuse('arguments', `--platform must be one of ${Object.keys(PLATFORMS).join(', ')}, got ${JSON.stringify(raw)}`)
  }
  return raw
}

/** Step 1: the artifact must be the shape the client will accept after downloading. */
async function checkInstallerShape(artifactFile, validateAs) {
  try {
    await validateInstallerShape(validateAs, artifactFile)
  } catch (cause) {
    refuse('1 installer shape', cause.message)
  }
}

/** Step 2: the mac channel is universal-only (there is no arch dimension downstream). */
async function checkMacUniversal(artifactFile) {
  try {
    await assertMacArtifactIsUniversal(artifactFile)
  } catch (cause) {
    refuse('2 mac universal', cause.message)
  }
}

/** Step 3: never publish what a client would refuse to download. */
function checkArtifactSize(bytes) {
  if (bytes > PUBLISH_MAX_ARTIFACT_BYTES) {
    refuse('3 artifact size', `the artifact is ${String(bytes)} bytes, over the ${String(PUBLISH_MAX_ARTIFACT_BYTES)}-byte client download cap`)
  }
}

/** Step 4: a version must fit its channel before it can name a record. */
function checkVersionShape(channel, version) {
  if (!matchesChannelVersionShape(channel, version)) {
    refuse('4 version shape', `version ${JSON.stringify(version)} does not fit channel ${channel}`)
  }
}

/**
 * Step 5a: the artifact must already be the file the download route serves.
 *
 * Requiring this (instead of recording a path the server cannot reach) keeps
 * the next step's digest honest: it is always the digest of the served bytes.
 */
function requirePlacement(inputFile, destination) {
  let inputPath
  try {
    inputPath = realpathSync(inputFile)
  } catch {
    refuse('5 placement', `the artifact ${inputFile} cannot be read`)
  }
  let destinationPath
  try {
    destinationPath = realpathSync(destination)
  } catch {
    refuse('5 placement',
      'the artifact is not where this server will serve it from.'
      + `\n  copy it first:  scp <build-artifact> <deploy-host>:${destination}`
      + `\n  then rerun with:  --file ${destination}`)
  }
  if (destinationPath !== inputPath) {
    refuse('5 placement', `--file resolves to ${inputPath}, but this server serves ${destination}`)
  }
  return destinationPath
}

/** Step 5b: stream the artifact and hash it chunk by chunk (D-M6-12). */
async function hashArtifact(path) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  return { sha256: hash.digest('hex'), bytes }
}

function isArtifactEntry(value) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof value.filename === 'string'
    && value.filename !== ''
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256)
    && typeof value.bytes === 'number'
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
}

/**
 * Read the artifacts a rerun must keep: same version keeps its other platform
 * (publishing windows must not drop the mac artifact), a different version
 * starts a fresh record - the record always describes one current release.
 */
async function readPreviousRecord(recordPath, version) {
  let text
  try {
    text = await readFile(recordPath, 'utf8')
  } catch (cause) {
    if (cause.code === 'ENOENT') return { artifacts: {}, publishedAt: null, replaced: false }
    refuse('7 record', `the existing record cannot be read: ${cause.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    refuse('7 record', `the existing record ${recordPath} is not valid JSON; inspect it (or remove it) before republishing`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { artifacts: {}, publishedAt: null, replacedByDifferentVersion: false }
  }
  if (parsed.version !== version) {
    return { artifacts: {}, publishedAt: null, replacedByDifferentVersion: true }
  }
  const artifacts = {}
  for (const name of Object.keys(PLATFORMS)) {
    const entry = parsed.artifacts?.[name]
    if (isArtifactEntry(entry)) artifacts[name] = { filename: entry.filename, sha256: entry.sha256, bytes: entry.bytes }
  }
  return { artifacts, publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : null, replacedByDifferentVersion: false }
}

/**
 * Step 7: write the record atomically.
 *
 * Temp file (0600) in the record directory, fsync, rename over the record - a
 * reader never observes a partial file. `publishedAt` is preserved across
 * reruns of the same version so a rerun is byte-identical.
 */
async function writeRecord({ dataDir, channel, version, platform, filename, sha256, bytes }) {
  const directory = join(dataDir, 'channels')
  const recordPath = join(directory, `${channel}.json`)
  const previous = await readPreviousRecord(recordPath, version)

  const artifacts = {}
  if (platform !== 'mac' && previous.artifacts.mac !== undefined) artifacts.mac = previous.artifacts.mac
  if (platform !== 'windows' && previous.artifacts.windows !== undefined) artifacts.windows = previous.artifacts.windows
  artifacts[platform] = { filename, sha256, bytes }
  const record = {
    version,
    publishedAt: previous.publishedAt ?? new Date().toISOString(),
    artifacts,
  }
  if (previous.replacedByDifferentVersion) {
    console.log(`publish-release: note: channel ${channel} was publishing another version; its record is replaced, and its old artifacts are left on disk`)
  }

  mkdirSync(directory, { recursive: true, mode: RECORD_DIRECTORY_MODE })
  chmodSync(directory, RECORD_DIRECTORY_MODE)
  const temporary = join(directory, `.${channel}.json.${String(process.pid)}-${String(Date.now())}-${randomBytes(4).toString('hex')}.tmp`)
  try {
    const handle = openSync(temporary, 'w', RECORD_FILE_MODE)
    try {
      fchmodSync(handle, RECORD_FILE_MODE)
      writeSync(handle, `${JSON.stringify(record, null, 2)}\n`)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, recordPath)
  } catch (cause) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may never have been created; the original error is what matters.
    }
    refuse('7 record', `the record could not be written: ${cause.message}`)
  }
  return recordPath
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const dataDir = resolveDataDir(options.dataDir)
  const channel = requireChannel(options.channel)
  const platform = requirePlatform(options.platform)
  const version = options.version
  const { validateAs } = PLATFORMS[platform]
  const artifactFile = resolve(options.file)

  await checkInstallerShape(artifactFile, validateAs)
  if (platform === 'mac') await checkMacUniversal(artifactFile)
  const sizeOnDisk = statSync(artifactFile).size
  checkArtifactSize(sizeOnDisk)
  checkVersionShape(channel, version)
  const destination = join(dataDir, 'artifacts', channel, platform, basename(artifactFile))
  const servedPath = requirePlacement(artifactFile, destination)
  const { sha256, bytes } = await hashArtifact(servedPath)
  if (bytes !== sizeOnDisk) {
    refuse('5 sha256', `the artifact changed size while it was being hashed (${String(bytes)} != ${String(sizeOnDisk)})`)
  }

  console.log(`publish-release: 5 sha256     ${sha256}`)
  console.log(`publish-release:   bytes      ${String(bytes)}`)
  console.log(`publish-release: 6 placement  ${servedPath}`)
  console.log(`publish-release:   if it is not on the deploy host yet: scp <build-artifact> <deploy-host>:${destination}`)
  const recordPath = await writeRecord({ dataDir, channel, version, platform, filename: basename(artifactFile), sha256, bytes })
  console.log(`publish-release: 7 record     ${recordPath} (${channel} ${version} ${platform})`)
}

try {
  await main()
} catch (cause) {
  if (cause instanceof PublishError) {
    console.error(`publish-release: step ${cause.step} failed: ${cause.message}`)
    console.error('publish-release: nothing was written; fix the invocation or the artifact and rerun.')
  } else {
    console.error('publish-release: unexpected failure:', cause)
  }
  process.exitCode = 1
}
