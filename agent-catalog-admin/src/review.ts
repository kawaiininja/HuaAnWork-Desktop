/**
 * Review, signing and legacy migration of the offline administrator CLI.
 *
 * The review gate is independent of the server:
 *
 *   1. download the admin submission detail AND the admin-only bundle,
 *   2. `inspectUnsignedAgentPackageBundle` the bytes locally (unpack limits,
 *      manifest validation, per-file sha256),
 *   3. compare `canonicalJson(localDigest)` with `canonicalJson(serverDigest)`
 *      byte for byte — a mismatch aborts before any receipt is written.
 *
 * The receipt binds the reviewed digest with its own sha256 so a later
 * `approve` can detect a tampered receipt AND a digest that changed on the
 * server between review and signing. `approve` never signs anything the
 * reviewer did not see. Nothing here prints a token or the private key.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { join } from 'node:path'

import {
  buildUnsignedAgentPackageBundle,
  createAgentPackageDigest,
  inspectUnsignedAgentPackageBundle,
  parseAgentPackageManifest,
  type AgentPackageDigest,
  type AgentPackageFile,
  type AgentPackageManifest,
} from '@huaanwork/agent-package-format'
import {
  canonicalJson,
  signAgentPackageDigest,
  type CatalogSignature,
} from '@huaanwork/catalog-signing'

import {
  CatalogCliError,
  MAX_LEGACY_PERSONA_BYTES,
  parseAgentPackageDigest,
  type AgentCatalogAdminClient,
  type SubmissionDetail,
} from './client.ts'

const REVIEW_RECEIPT_FILE_NAME = 'review.json'
const HEX64_RE = /^[0-9a-f]{64}$/u

/** The signed-review receipt written by `review` and required by `approve`. */
export interface ReviewReceipt {
  readonly schemaVersion: 1
  readonly submissionId: string
  readonly digest: AgentPackageDigest
  readonly digestSha256: string
  readonly reviewedAt: string
}

export interface DigestDiff {
  readonly previousVersion: string
  readonly added: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
  readonly removed: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
  readonly changed: ReadonlyArray<{
    readonly path: string
    readonly before: string
    readonly after: string
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function packageError(action: string, cause: unknown): CatalogCliError {
  if (cause instanceof CatalogCliError) return cause
  return new CatalogCliError(`${action}：${messageOf(cause)}`)
}

/** `sha256(canonicalJson(digest))` — the receipt's integrity hash. */
export function digestSha256(digest: unknown): string {
  return createHash('sha256').update(canonicalJson(digest), 'utf8').digest('hex')
}

/** Strict receipt parser: a receipt is a trust input, not a convenience file. */
export function parseReviewReceipt(raw: unknown): ReviewReceipt {
  if (!isRecord(raw)) throw new CatalogCliError('审查回执格式错误：必须是 JSON 对象')
  if (raw.schemaVersion !== 1) throw new CatalogCliError('审查回执格式错误：schemaVersion 必须为 1')
  if (typeof raw.submissionId !== 'string' || raw.submissionId.trim() === '') {
    throw new CatalogCliError('审查回执格式错误：submissionId 必须是非空字符串')
  }
  if (typeof raw.digestSha256 !== 'string' || !HEX64_RE.test(raw.digestSha256)) {
    throw new CatalogCliError('审查回执格式错误：digestSha256 必须是 64 位十六进制 sha256')
  }
  if (typeof raw.reviewedAt !== 'string' || Number.isNaN(Date.parse(raw.reviewedAt))) {
    throw new CatalogCliError('审查回执格式错误：reviewedAt 必须是 ISO 时间')
  }
  return {
    schemaVersion: 1,
    submissionId: raw.submissionId,
    digest: parseAgentPackageDigest(raw.digest, 'review.digest'),
    digestSha256: raw.digestSha256,
    reviewedAt: raw.reviewedAt,
  }
}

export async function readReviewReceipt(path: string): Promise<ReviewReceipt> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    throw new CatalogCliError(`无法读取审查回执 ${path}：${messageOf(cause)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CatalogCliError(`审查回执不是合法 JSON：${path}`)
  }
  return parseReviewReceipt(parsed)
}

/** Path-level diff between the previously signed version and the candidate. */
export function diffDigests(
  submission: Pick<SubmissionDetail, 'previousVersion' | 'previousDigest'>,
  current: AgentPackageDigest,
): DigestDiff | null {
  if (submission.previousVersion === undefined || submission.previousDigest === undefined) return null
  const previous = submission.previousDigest
  const before = new Map(previous.files.map((file) => [file.path, file.sha256]))
  const after = new Map(current.files.map((file) => [file.path, file.sha256]))

  const added: Array<{ path: string; sha256: string }> = []
  for (const [path, sha256] of after) {
    if (!before.has(path)) added.push({ path, sha256 })
  }
  const removed: Array<{ path: string; sha256: string }> = []
  for (const [path, sha256] of before) {
    if (!after.has(path)) removed.push({ path, sha256 })
  }
  const changed: Array<{ path: string; before: string; after: string }> = []
  for (const [path, sha256] of after) {
    const previousSha = before.get(path)
    if (previousSha !== undefined && previousSha !== sha256) {
      changed.push({ path, before: previousSha, after: sha256 })
    }
  }
  const byPath = (left: { path: string }, right: { path: string }): number =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  added.sort(byPath)
  removed.sort(byPath)
  changed.sort(byPath)
  return { previousVersion: submission.previousVersion, added, removed, changed }
}

export interface ReviewOutcome {
  readonly submission: SubmissionDetail
  readonly manifest: AgentPackageManifest
  readonly receipt: ReviewReceipt
  readonly receiptPath: string
  readonly report: string
}

export interface ReviewOptions {
  readonly client: AgentCatalogAdminClient
  readonly submissionId: string
  readonly outDir: string
  readonly now?: () => Date
}

/**
 * Review one pending submission.
 *
 * Nothing is written when the locally recomputed digest and the server digest
 * disagree: an unverified receipt must never exist.
 */
export async function reviewSubmission(options: ReviewOptions): Promise<ReviewOutcome> {
  const { client, submissionId, outDir } = options
  const now = options.now ?? (() => new Date())

  const submission = await client.getSubmission(submissionId)
  const bundle = await client.downloadSubmissionBundle(submissionId)

  let inspected: Awaited<ReturnType<typeof inspectUnsignedAgentPackageBundle>>
  try {
    inspected = await inspectUnsignedAgentPackageBundle(bundle)
  } catch (cause) {
    throw packageError('提交包未通过独立校验', cause)
  }

  if (
    inspected.manifest.slug !== submission.slug
    || inspected.manifest.version !== submission.version
  ) {
    throw new CatalogCliError(
      `复核失败：包内 slug/version（${inspected.manifest.slug}/${inspected.manifest.version}）` +
        `与服务端提交（${submission.slug}/${submission.version}）不一致`,
    )
  }
  if (canonicalJson(inspected.digest) !== canonicalJson(submission.digest)) {
    throw new CatalogCliError('复核失败：本地重算 digest 与服务端 digest 不一致，禁止签名')
  }

  const receipt: ReviewReceipt = {
    schemaVersion: 1,
    submissionId: submission.submissionId,
    digest: inspected.digest,
    digestSha256: digestSha256(inspected.digest),
    reviewedAt: now().toISOString(),
  }

  await mkdir(outDir, { recursive: true })
  const receiptPath = join(outDir, REVIEW_RECEIPT_FILE_NAME)
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })

  return {
    submission,
    manifest: inspected.manifest,
    receipt,
    receiptPath,
    report: formatReviewReport(submission, inspected.manifest, inspected.digest, receipt),
  }
}

/** The human report printed to stdout (never carries a token or key). */
export function formatReviewReport(
  submission: SubmissionDetail,
  manifest: AgentPackageManifest,
  digest: AgentPackageDigest,
  receipt: ReviewReceipt,
): string {
  const diff = diffDigests(submission, digest)
  const lines: string[] = [
    `提交ID：${submission.submissionId}`,
    `状态：${submission.status}`,
    `slug：${submission.slug}`,
    `版本：${submission.version}`,
    `提交时间：${submission.submittedAt}`,
    `摘要 sha256：${receipt.digestSha256}`,
    '摘要复核：与服务端 digest 一致',
    '',
    'manifest：',
    JSON.stringify(manifest, null, 2),
    '',
    `文件（${String(digest.files.length)}）：`,
    ...digest.files.map(
      (file) => `  ${file.path}\t${String(file.size)}\t${file.sha256}`,
    ),
    '',
  ]

  if (diff === null) {
    lines.push('上一版本：无')
  } else {
    lines.push(`上一版本：${diff.previousVersion}`)
    lines.push(...formatDiff(diff))
  }
  return lines.join('\n')
}

function formatDiff(diff: DigestDiff): string[] {
  const lines: string[] = []
  for (const file of diff.added) lines.push(`added: ${file.path}  sha256=${file.sha256}`)
  for (const file of diff.removed) lines.push(`removed: ${file.path}  sha256=${file.sha256}`)
  for (const file of diff.changed) {
    lines.push(`changed: ${file.path}`)
    lines.push(`  之前: ${file.before}`)
    lines.push(`  之后: ${file.after}`)
  }
  if (lines.length === 0) lines.push('  文件内容与上一版本一致')
  return lines
}

export interface ApprovalOptions {
  readonly client: AgentCatalogAdminClient
  readonly submissionId: string
  readonly receiptPath: string
  readonly privateKeyPath: string
  readonly slot: 1 | 2
  readonly now?: () => Date
}

export interface ApprovalOutcome {
  readonly signature: CatalogSignature
  readonly submission: SubmissionDetail
}

/**
 * Sign the reviewed digest and publish it.
 *
 * `--yes` is checked by the caller BEFORE this function runs (and therefore
 * before the private key is read). Fail-closed order:
 *
 *   receipt integrity → live submission digest → private key → sign → approve.
 */
export async function approveSubmissionFromReceipt(
  options: ApprovalOptions,
): Promise<ApprovalOutcome> {
  const { client, submissionId, receiptPath, privateKeyPath, slot } = options
  const now = options.now ?? (() => new Date())

  const receipt = await readReviewReceipt(receiptPath)
  if (receipt.submissionId !== submissionId) {
    throw new CatalogCliError(
      `审查回执属于提交 ${receipt.submissionId}，不是 ${submissionId}；请重新 review`,
    )
  }
  if (digestSha256(receipt.digest) !== receipt.digestSha256) {
    throw new CatalogCliError('审查回执已损坏：digestSha256 与 digest 不匹配，请重新 review')
  }

  const submission = await client.getSubmission(submissionId)
  if (submission.status !== 'pending-review') {
    throw new CatalogCliError(
      `提交 ${submissionId} 当前状态为 ${submission.status}，无法批准（仅 pending-review 可批准）`,
    )
  }
  if (canonicalJson(submission.digest) !== canonicalJson(receipt.digest)) {
    throw new CatalogCliError('服务端 digest 与审查回执不一致（审查后内容已变化），请重新 review')
  }

  let privateKeyPem: string
  try {
    privateKeyPem = await readFile(privateKeyPath, 'utf8')
  } catch (cause) {
    throw new CatalogCliError(`无法读取私钥文件 ${privateKeyPath}：${messageOf(cause)}`)
  }
  if (privateKeyPem.trim() === '') {
    throw new CatalogCliError(`私钥文件为空：${privateKeyPath}`)
  }

  let signature: CatalogSignature
  try {
    signature = signAgentPackageDigest(receipt.digest, {
      privateKeyPem,
      slot,
      signedAt: now().toISOString(),
    })
  } catch {
    // The underlying parser message is not echoed: it must never risk quoting
    // key material into stderr.
    throw new CatalogCliError('签名失败：私钥无法读取或不是有效的 Ed25519 PKCS#8 私钥')
  }

  const approved = await client.approveSubmission(submissionId, signature)
  return { signature, submission: approved }
}

// ---------------------------------------------------------------------------
// Legacy M-A0 persona migration
// ---------------------------------------------------------------------------

/** 32 KiB persona budget comes from the shared format; mirrored here for errors. */
const MIGRATION_VERSION = '1.0.0'

const LAN_BLOCKS = new BlockList()
LAN_BLOCKS.addSubnet('10.0.0.0', 8, 'ipv4')
LAN_BLOCKS.addSubnet('172.16.0.0', 12, 'ipv4')
LAN_BLOCKS.addSubnet('192.168.0.0', 16, 'ipv4')
LAN_BLOCKS.addSubnet('127.0.0.0', 8, 'ipv4')
LAN_BLOCKS.addSubnet('169.254.0.0', 16, 'ipv4')
LAN_BLOCKS.addAddress('::1', 'ipv6')
LAN_BLOCKS.addSubnet('fc00::', 7, 'ipv6')
LAN_BLOCKS.addSubnet('fe80::', 10, 'ipv6')

/**
 * LAN-only endpoint check for `personaUrl`.
 *
 * Mirrors `@huaanwork/policy/network` (the admin workspace must stay
 * dependency-free beyond the two shared packages): loopback, RFC1918,
 * link-local, IPv6 ULA/link-local and mDNS `.local` are allowed; a plain
 * hostname is treated as public unless it ends in `.local`. No DNS resolution.
 */
export function isLanEndpoint(url: string): boolean {
  const text = url.trim()
  if (text === '') return false
  let hostname: string
  try {
    hostname = new URL(text).hostname.toLowerCase()
  } catch {
    return false
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)) return true
  if (hostname.endsWith('.local')) return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(hostname)
  const ip = mapped?.[1] ?? hostname
  const version = isIP(ip)
  if (version === 4) return LAN_BLOCKS.check(ip, 'ipv4')
  if (version === 6) return LAN_BLOCKS.check(ip, 'ipv6')
  return false
}

export interface LegacyMigrationOptions {
  readonly client: AgentCatalogAdminClient
  readonly slug: string
  readonly submit: boolean
  readonly now?: () => Date
}

export interface LegacyMigrationOutcome {
  readonly manifest: AgentPackageManifest
  readonly digest: AgentPackageDigest
  readonly digestSha256: string
  readonly bundleBytes: number
  readonly personaSource: 'inline' | 'personaUrl'
  readonly submission?: SubmissionDetail
}

function requireStringField(entry: Record<string, unknown>, field: string): string {
  const value = entry[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogCliError(`旧条目缺少 ${field}，无法迁移`)
  }
  return value.trim()
}

/**
 * Convert one M-A0 persona entry into a minimal `1.0.0` agent package.
 *
 * Tools are refused. The manifest is re-validated by the shared validator, so
 * legacy data problems (over-long description, bad name, ...) fail loudly and
 * are never truncated. With `submit` the SAME unsigned bundle is posted with
 * `X-Agent-Catalog-Migration: <slug>`; approval always stays manual.
 */
export async function migrateLegacyEntry(
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationOutcome> {
  const { client, slug, submit } = options
  const now = options.now ?? (() => new Date())

  const entry = await client.getLegacyEntry(slug)
  if (entry.kind !== 'agent') {
    throw new CatalogCliError(
      entry.kind === 'tool'
        ? `工具条目不能迁移为智能体包：${slug}（kind=tool）`
        : `只支持迁移 kind=agent 的 persona 条目：${slug}`,
    )
  }
  const name = requireStringField(entry, 'name')
  if (name !== slug) {
    throw new CatalogCliError(`旧条目名称（${name}）与请求的 slug（${slug}）不一致`)
  }
  const description = requireStringField(entry, 'description')
  const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() !== ''
    ? entry.displayName.trim()
    : name

  let personaSource: 'inline' | 'personaUrl'
  let persona: string
  if (typeof entry.persona === 'string' && entry.persona.trim() !== '') {
    personaSource = 'inline'
    persona = entry.persona
  } else if (typeof entry.personaUrl === 'string' && entry.personaUrl.trim() !== '') {
    const personaUrl = entry.personaUrl.trim()
    let parsedUrl: URL
    try {
      parsedUrl = new URL(personaUrl)
    } catch {
      throw new CatalogCliError(`personaUrl 不是合法 URL，拒绝迁移：${personaUrl}`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new CatalogCliError(`personaUrl 必须是 http(s) 地址，拒绝迁移：${personaUrl}`)
    }
    if (parsedUrl.username !== '' || parsedUrl.password !== '') {
      throw new CatalogCliError('personaUrl 不得内嵌用户名或口令')
    }
    if (!isLanEndpoint(personaUrl)) {
      throw new CatalogCliError(`personaUrl 不是局域网地址，拒绝迁移：${personaUrl}`)
    }
    personaSource = 'personaUrl'
    persona = await client.fetchLegacyPersona(personaUrl)
  } else {
    throw new CatalogCliError(`旧条目缺少 persona 或 personaUrl，无法迁移：${slug}`)
  }

  const trimmedPersona = persona.trim()
  if (trimmedPersona === '') {
    throw new CatalogCliError(`旧条目人设为空，拒绝迁移：${slug}`)
  }
  const personaBytes = Buffer.byteLength(trimmedPersona, 'utf8')
  if (personaBytes > MAX_LEGACY_PERSONA_BYTES) {
    throw new CatalogCliError(
      `旧条目人设超过 ${String(MAX_LEGACY_PERSONA_BYTES)} 字节上限` +
        `（实际 ${String(personaBytes)} 字节），拒绝迁移`,
    )
  }

  const timestamp = now().toISOString()
  const parsedManifest = parseAgentPackageManifest({
    schemaVersion: 1,
    slug: name,
    displayName,
    description,
    version: MIGRATION_VERSION,
    draftId: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
    persona: 'persona.md',
    skill: null,
    tools: { mode: 'none' },
    allowSkills: [],
  })
  if (!parsedManifest.ok) {
    const detail = parsedManifest.fieldErrors
      .map((error) => `${error.field}: ${error.message}`)
      .join('；')
    throw new CatalogCliError(`旧条目无法转换为智能体包（${detail}）；请先修好旧数据，不截断字段`)
  }
  const manifest = parsedManifest.manifest

  const files: AgentPackageFile[] = [
    { path: 'agent.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { path: 'persona.md', data: Buffer.from(trimmedPersona, 'utf8') },
  ]

  let bundle: Buffer
  let inspected: Awaited<ReturnType<typeof inspectUnsignedAgentPackageBundle>>
  try {
    bundle = await buildUnsignedAgentPackageBundle(files)
    inspected = await inspectUnsignedAgentPackageBundle(bundle)
  } catch (cause) {
    throw packageError('生成迁移包失败', cause)
  }

  const expectedDigest = createAgentPackageDigest(manifest, files)
  if (
    canonicalJson(inspected.digest) !== canonicalJson(expectedDigest)
    || inspected.manifest.slug !== slug
    || inspected.manifest.version !== MIGRATION_VERSION
    || inspected.manifest.tools.mode !== 'none'
  ) {
    throw new CatalogCliError('迁移包自检失败：打包后的内容与生成的 manifest 不一致')
  }

  if (!submit) {
    return {
      manifest,
      digest: inspected.digest,
      digestSha256: digestSha256(inspected.digest),
      bundleBytes: bundle.byteLength,
      personaSource,
    }
  }

  const submission = await client.submitMigration(slug, bundle)
  return {
    manifest,
    digest: inspected.digest,
    digestSha256: digestSha256(inspected.digest),
    bundleBytes: bundle.byteLength,
    personaSource,
    submission,
  }
}
