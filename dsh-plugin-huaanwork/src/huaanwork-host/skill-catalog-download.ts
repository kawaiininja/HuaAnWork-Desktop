/**
 * Center → 我的技能 download transaction (Task 7).
 *
 * Both sources produce a DISABLED local copy by default: the enable toggle
 * (`user-skill-toggles.json`) is never written here. Bundled skills are copied
 * from the app tree; shared skills are fetched by exact revision, validated
 * (name + budget + digest) and written through a staging directory that is
 * renamed into place. Same-name rules live here, never in the UI.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  createSkillDigest,
  inspectSkillArchive,
  readSkillDirectory,
  writeSkillDirectory,
  type SkillArchiveFile,
} from '@huaanwork/skill-format'
import { SKILL_NAME_RE } from '@huaanwork/skill-format/markdown'

import { INTERNAL_BUNDLED_SKILLS, SYSTEM_SKILLS, findBundledEntry } from '../huaanwork-guardrails/skills.ts'
import { getSkillCatalogClient } from './skill-catalog-client.ts'
import { writeSkillLocalEntry } from './skill-local-state.ts'
import { findEntry, listUserSkills, userSkillsRoot, withSkillStorageLock } from './skills-host.ts'
import type { LocalSkillInfo } from '../client-huaanwork/rpc-types.ts'

export type DownloadSkillRequest =
  | { source: 'bundled'; name: string }
  | { source: 'catalog'; name: string; revision: number }

export type SkillDownloadErrorCode =
  | 'local-skill-conflict'
  | 'skill-is-system'
  | 'skill-not-found'
  | 'archive-invalid'

export class SkillDownloadError extends Error {
  readonly code: SkillDownloadErrorCode

  constructor(code: SkillDownloadErrorCode, message: string) {
    super(message)
    this.name = 'SkillDownloadError'
    this.code = code
  }
}

const downloadLocks = new Map<string, Promise<void>>()

function withDownloadLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = downloadLocks.get(key) ?? Promise.resolve()
  const run = previous.then(() => fn(), () => fn())
  const tail = run.then(() => undefined, () => undefined)
  downloadLocks.set(key, tail)
  void tail.finally(() => {
    if (downloadLocks.get(key) === tail) downloadLocks.delete(key)
  })
  return run
}

/** Read one bundled skill as archive files (flat file or directory bundle). */
function bundledSkillFiles(name: string): SkillArchiveFile[] {
  const entry = findBundledEntry(name)
  if (entry === undefined) throw new SkillDownloadError('skill-not-found', `技能 ${name} 不存在`)
  if (entry.kind === 'flat') {
    return [{ path: 'SKILL.md', data: readFileSync(entry.path) }]
  }
  return readSkillDirectory(dirname(entry.path))
}

type PreparedDownload = {
  files: SkillArchiveFile[]
  digest: string
  publisher?: string
}

async function prepareBundled(name: string): Promise<PreparedDownload> {
  if (SYSTEM_SKILLS.has(name) || INTERNAL_BUNDLED_SKILLS.has(name)) {
    throw new SkillDownloadError('skill-is-system', `技能 ${name} 是系统技能，不能下载副本`)
  }
  const files = bundledSkillFiles(name)
  return { files, digest: createSkillDigest(files) }
}

async function prepareCatalog(name: string, revision: number): Promise<PreparedDownload> {
  const client = getSkillCatalogClient()
  const summary = await client.getSkillRevision(name, revision)
  const archive = await client.downloadSkillArchive(name, revision)
  let inspected
  try {
    inspected = await inspectSkillArchive(archive)
  } catch (cause) {
    throw new SkillDownloadError(
      'archive-invalid',
      `技能 ${name} 的归档无效：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (inspected.name !== name) {
    throw new SkillDownloadError('archive-invalid', `技能 ${name} 的归档名称与目录记录不一致`)
  }
  if (inspected.digest !== summary.digest) {
    throw new SkillDownloadError('archive-invalid', `技能 ${name} 的归档摘要与目录记录不一致`)
  }
  return { files: inspected.files, digest: inspected.digest, publisher: summary.publisher }
}

/**
 * Replace the local skill artifact atomically. A flat legacy file is moved
 * aside like a directory, so a name can never resolve to two artifacts.
 */
async function replaceLocalSkill(profileDir: string, name: string, files: SkillArchiveFile[]): Promise<void> {
  const root = userSkillsRoot(profileDir)
  await mkdir(root, { recursive: true })
  const target = join(root, name)
  const staging = join(profileDir, `.skill-staging-${String(process.pid)}-${randomBytes(8).toString('hex')}`)
  const backup = join(profileDir, `.skill-backup-${String(process.pid)}-${randomBytes(8).toString('hex')}`)
  await writeSkillDirectory(staging, files)

  const existing = await findEntry(root, name)
  const flatPath = join(root, `${name}.md`)
  // Move the ARTIFACT aside: the whole directory for a bundle, the single
  // file for a flat skill. Renaming only SKILL.md would leave the directory.
  const existingPath = existing === undefined
    ? (existsSync(flatPath) ? flatPath : undefined)
    : existing.kind === 'bundle' ? dirname(existing.path) : existing.path
  let movedAside = false
  try {
    if (existingPath !== undefined) {
      await rename(existingPath, backup)
      movedAside = true
    }
    await rename(staging, target)
  } catch (cause) {
    if (movedAside) await rename(backup, existingPath!).catch(() => undefined)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw cause
  }
  if (movedAside) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
}

function sameSource(local: LocalSkillInfo, request: DownloadSkillRequest, digest: string): 'same' | 'update' | 'conflict' {
  if (request.source === 'bundled') {
    if (local.origin.kind !== 'bundled') return 'conflict'
    return local.contentDigest === digest ? 'same' : 'update'
  }
  if (local.origin.kind !== 'catalog' || local.origin.name !== request.name) return 'conflict'
  if (local.contentDigest === digest) return 'same'
  // Unmodified download copy, newer revision → explicit update.
  if (local.contentDigest === local.origin.digest && request.revision > local.origin.revision) return 'update'
  return 'conflict'
}

/**
 * Download one skill into the current profile. New copies stay DISABLED; an
 * explicit update keeps the existing enable toggle untouched.
 */
export async function downloadSkillToMine(
  profileDir: string,
  request: DownloadSkillRequest,
): Promise<{ skill: LocalSkillInfo; created: boolean; updated: boolean }> {
  if (!SKILL_NAME_RE.test(request.name)) {
    throw new SkillDownloadError('skill-not-found', `技能名 ${JSON.stringify(request.name)} 不合法`)
  }
  const key = `${request.source}:${request.name}`
  return withDownloadLock(key, async () => {
    const prepared = request.source === 'bundled'
      ? await prepareBundled(request.name)
      : await prepareCatalog(request.name, request.revision)

    return withSkillStorageLock(profileDir, async () => {
      const local = (await listUserSkills(profileDir)).find((skill) => skill.name === request.name)
      if (local !== undefined) {
        const verdict = sameSource(local, request, prepared.digest)
        if (verdict === 'same') return { skill: local, created: false, updated: false }
        if (verdict === 'conflict') {
          throw new SkillDownloadError(
            'local-skill-conflict',
            `本地已存在同名技能 ${request.name}，且来源或修改状态不允许自动覆盖`,
          )
        }
      }

      await replaceLocalSkill(profileDir, request.name, prepared.files)
      const origin = request.source === 'bundled'
        ? { kind: 'bundled' as const }
        : {
            kind: 'catalog' as const,
            name: request.name,
            revision: request.revision,
            publisher: prepared.publisher ?? '',
            digest: prepared.digest,
          }
      writeSkillLocalEntry(profileDir, request.name, { origin, contentDigest: prepared.digest })

      const written = (await listUserSkills(profileDir)).find((skill) => skill.name === request.name)
      if (written === undefined) {
        throw new SkillDownloadError('archive-invalid', `技能 ${request.name} 写入后不可读`)
      }
      return { skill: written, created: local === undefined, updated: local !== undefined }
    })
  })
}
