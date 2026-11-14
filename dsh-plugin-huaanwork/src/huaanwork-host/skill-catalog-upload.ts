/**
 * My-skills → intranet publish (Task 8).
 *
 * Upload is publish: the Host re-reads the complete local directory, rebuilds
 * the archive (never trusting a stored snapshot), sends the local
 * `publishedRevision` as the optimistic expectation and only then records the
 * new publish snapshot. Enable state is never touched. A local skill whose name
 * matches a bundled skill cannot be the FIRST publish of that name — the user
 * must duplicate it to a new name first.
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { buildSkillArchive, createSkillDigest, readSkillDirectory, type SkillArchiveFile } from '@huaanwork/skill-format'

import { listBundledSkills } from '../huaanwork-guardrails/skills.ts'
import {
  SkillCatalogClientError,
  getSkillCatalogBinding,
  type SkillRevisionSummary,
} from './skill-catalog-client.ts'
import { readSkillLocalState, writeSkillLocalEntry } from './skill-local-state.ts'
import { findEntry, listUserSkills, userSkillsRoot, withSkillStorageLock } from './skills-host.ts'
import type { LocalSkillInfo } from '../client-huaanwork/rpc-types.ts'

export type SkillUploadErrorCode =
  | 'upload-token-missing'
  | 'skill-not-found'
  | 'skill-already-exists'
  | 'skill-name-conflict'
  | 'skill-revision-conflict'
  | 'upload-failed'

export class SkillUploadError extends Error {
  readonly code: SkillUploadErrorCode

  constructor(code: SkillUploadErrorCode, message: string) {
    super(message)
    this.name = 'SkillUploadError'
    this.code = code
  }
}

const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'skill-already-exists',
  'skill-name-conflict',
  'skill-revision-conflict',
])

async function readLocalFiles(profileDir: string, name: string): Promise<SkillArchiveFile[]> {
  const entry = await findEntry(userSkillsRoot(profileDir), name)
  if (entry === undefined) throw new SkillUploadError('skill-not-found', `本地技能 ${name} 不存在`)
  if (entry.kind === 'flat') return [{ path: 'SKILL.md', data: readFileSync(entry.path) }]
  return readSkillDirectory(dirname(entry.path))
}

/**
 * Publish one local skill. The archive is always rebuilt from the disk; a
 * concurrent edit during the upload leaves `publishState: 'modified'`.
 */
export async function uploadLocalSkill(
  profileDir: string,
  name: string,
): Promise<{ skill: LocalSkillInfo; created: boolean }> {
  // Token presence is checked before any work; an empty token only disables
  // uploads (browse/download/mine stay fully usable).
  if (getSkillCatalogBinding().readSettings().agents_skill_upload_token.trim() === '') {
    throw new SkillUploadError('upload-token-missing', '技能上传口令未配置，无法上传')
  }

  const local = readSkillLocalState(profileDir).skills[name]
  const files = await readLocalFiles(profileDir, name)
  const uploadDigest = createSkillDigest(files)
  const publishedRevision = local?.publishedRevision
  if (publishedRevision === undefined && listBundledSkills().some(skill => skill.name === name)) {
    throw new SkillUploadError(
      'skill-already-exists',
      `本地技能 ${name} 与内置技能同名，请另存为新技能后上传`,
    )
  }

  // Plan §9.3: an out-of-band edit is adopted BEFORE the publish; the local
  // digest must reflect the bytes the user sees even if the publish fails.
  if (local !== undefined && local.contentDigest !== uploadDigest) {
    await withSkillStorageLock(profileDir, async () => {
      writeSkillLocalEntry(profileDir, name, {
        origin: local.origin,
        contentDigest: uploadDigest,
        ...(local.publishedRevision !== undefined ? { publishedRevision: local.publishedRevision } : {}),
        ...(local.publishedDigest !== undefined ? { publishedDigest: local.publishedDigest } : {}),
      })
    })
  }

  let archive: Buffer
  try {
    archive = await buildSkillArchive(files)
  } catch (cause) {
    throw new SkillUploadError(
      'upload-failed',
      `本地技能 ${name} 的归档无法构建：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  let published: { skill: SkillRevisionSummary; created: boolean }
  try {
    // Network I/O deliberately outside the storage lock: an upload must not
    // block unrelated local writes for the transport timeout.
    published = await getSkillCatalogBinding().client.publishSkill(name, archive, publishedRevision)
  } catch (cause) {
    if (cause instanceof SkillCatalogClientError && CONFLICT_CODES.has(cause.code)) {
      throw new SkillUploadError(cause.code as SkillUploadErrorCode, cause.message)
    }
    throw new SkillUploadError(
      'upload-failed',
      `技能 ${name} 发布失败：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  return withSkillStorageLock(profileDir, async () => {
    // Re-read after the upload: an edit during the round trip must surface as
    // "modified" instead of being reported as published. A vanished or
    // unreadable tree keeps the uploaded snapshot as the recorded baseline.
    let contentDigest = uploadDigest
    try {
      contentDigest = createSkillDigest(await readLocalFiles(profileDir, name))
    } catch {
      // Keep the uploaded digest; a vanished skill is reported by its absence.
    }
    const origin = readSkillLocalState(profileDir).skills[name]?.origin ?? local?.origin ?? { kind: 'created' as const }
    writeSkillLocalEntry(profileDir, name, {
      origin,
      contentDigest,
      publishedRevision: published.skill.revision,
      publishedDigest: uploadDigest,
    })

    const written = (await listUserSkills(profileDir)).find(skill => skill.name === name)
    if (written !== undefined) return { skill: written, created: published.created }
    // The publish succeeded; a concurrent delete must not be reported as an
    // upload failure (there is no local row to return).
    const fallback: LocalSkillInfo = {
      name,
      description: published.skill.description,
      source: 'user',
      enabled: false,
      origin,
      contentDigest,
      publishedRevision: published.skill.revision,
      publishedDigest: uploadDigest,
      publishState: contentDigest === uploadDigest ? 'published' : 'modified',
    }
    return { skill: fallback, created: published.created }
  })
}
