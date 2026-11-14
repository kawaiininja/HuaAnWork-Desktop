/**
 * Skill center projection (Task 6).
 *
 * Merges the bundled skills (system + ordinary) with the intranet catalog into
 * `CenterSkillInfo[]`, computes each card's download state against the local
 * state, and keeps the last COMPLETE catalog listing in
 * `<profileDir>/skill-catalog-cache.json`.
 *
 * Failure policy (spec §5.4/§12): a remote failure never breaks the local
 * lists. The center falls back to bundled skills plus the cache and reports the
 * exact user-facing sentence; an incomplete pagination never overwrites the
 * cache and is never presented as the full catalog.
 */

import { readFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { createSkillDigest, readSkillDirectory } from '@huaanwork/skill-format'

import {
  INTERNAL_BUNDLED_SKILLS,
  SYSTEM_SKILLS,
  bundledSkillDir,
  listBundledSkills,
} from '../huaanwork-guardrails/skills.ts'
import { readSkillLocalState } from './skill-local-state.ts'
import { listUserSkills } from './skills-host.ts'
import {
  getSkillCatalogClient,
  type SkillCatalogClient,
  type SkillRevisionSummary,
} from './skill-catalog-client.ts'
import type {
  CenterSkillInfo,
  InvocableSkillInfo,
  SkillCenterListResult,
  SkillDownloadState,
} from '../client-huaanwork/rpc-types.ts'

export const SKILL_CATALOG_UNAVAILABLE = '共享技能库不可用，当前显示内置技能与已缓存内容'
export const SKILL_CATALOG_CACHE_FILENAME = 'skill-catalog-cache.json'
const CACHE_MODE = 0o600

type SkillCatalogCacheDocument = {
  schemaVersion: 1
  updatedAt: string
  items: SkillRevisionSummary[]
}

export function skillCatalogCachePath(profileDir: string): string {
  return join(profileDir, SKILL_CATALOG_CACHE_FILENAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCache(profileDir: string): SkillRevisionSummary[] | undefined {
  let raw: string
  try {
    // Synchronous read keeps the projection API simple; the file is tiny.
    raw = readFileSync(skillCatalogCachePath(profileDir), 'utf8')
  } catch {
    return undefined
  }
  try {
    const document: unknown = JSON.parse(raw)
    if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.items)) {
      return undefined
    }
    const items: SkillRevisionSummary[] = []
    for (const item of document.items) {
      if (
        !isRecord(item)
        || typeof item.name !== 'string'
        || typeof item.revision !== 'number'
        || typeof item.description !== 'string'
        || typeof item.publisher !== 'string'
        || typeof item.digest !== 'string'
        || typeof item.size !== 'number'
        || typeof item.updatedAt !== 'string'
      ) {
        return undefined
      }
      items.push({
        name: item.name,
        revision: item.revision,
        description: item.description,
        ...(typeof item.whenToUse === 'string' ? { whenToUse: item.whenToUse } : {}),
        publisher: item.publisher,
        digest: item.digest,
        size: item.size,
        updatedAt: item.updatedAt,
      })
    }
    return items
  } catch {
    // A corrupt cache is a miss, not a startup failure.
    return undefined
  }
}

async function writeCache(profileDir: string, items: SkillRevisionSummary[]): Promise<void> {
  const document: SkillCatalogCacheDocument = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    items,
  }
  const path = skillCatalogCachePath(profileDir)
  const temp = `${path}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: CACHE_MODE })
    await rename(temp, path)
  } catch (cause) {
    await unlink(temp).catch(() => undefined)
    throw cause
  }
}

/** Digest of one bundled skill directory; undefined when the tree is unreadable. */
function bundledDigest(name: string): string | undefined {
  const dir = bundledSkillDir(name)
  if (dir === undefined) return undefined
  try {
    return createSkillDigest(readSkillDirectory(dir))
  } catch {
    return undefined
  }
}

type LocalSkillRecord = Awaited<ReturnType<typeof listUserSkills>>[number]

function downloadStateOf(
  item: { source: 'bundled' | 'catalog'; name: string; revision?: number; digest?: string },
  local: LocalSkillRecord | undefined,
  localDigestOfBundled: string | undefined,
): SkillDownloadState {
  if (item.source === 'bundled' && SYSTEM_SKILLS.has(item.name)) return 'not-applicable'
  if (local === undefined) return 'available'
  if (item.source === 'bundled') {
    if (local.origin.kind !== 'bundled') return 'local-conflict'
    if (localDigestOfBundled !== undefined && local.contentDigest === localDigestOfBundled) return 'downloaded'
    return 'local-conflict'
  }
  // catalog
  if (local.origin.kind !== 'catalog' || local.origin.name !== item.name) return 'local-conflict'
  const unmodified = local.contentDigest === local.origin.digest
  if (item.digest !== undefined && item.digest === local.contentDigest) return 'downloaded'
  if (
    unmodified
    && item.revision !== undefined
    && item.revision > local.origin.revision
  ) {
    return 'update-available'
  }
  return 'local-conflict'
}

export type ListSkillCenterOptions = {
  /** Test seam; production uses the configured Host client. */
  client?: SkillCatalogClient
}

/**
 * Build the center projection. Remote failure → bundled + cache + the exact
 * §5.4 sentence. `skill.mineList`/`skill.invocableList` never call the remote.
 */
export async function listSkillCenter(
  profileDir: string,
  options: ListSkillCenterOptions = {},
): Promise<SkillCenterListResult> {
  const client = options.client ?? getSkillCatalogClient()
  let remoteItems: SkillRevisionSummary[] | undefined
  let catalogError: string | undefined
  try {
    remoteItems = await client.listSharedSkills()
    // Only a complete listing is allowed to refresh the cache.
    await writeCache(profileDir, remoteItems)
  } catch {
    remoteItems = readCache(profileDir)
    catalogError = SKILL_CATALOG_UNAVAILABLE
  }

  const localSkills = await listUserSkills(profileDir)
  const localByName = new Map(localSkills.map((skill) => [skill.name, skill]))
  const skills: CenterSkillInfo[] = []

  for (const bundled of listBundledSkills()) {
    if (INTERNAL_BUNDLED_SKILLS.has(bundled.name)) continue
    const digest = SYSTEM_SKILLS.has(bundled.name) ? undefined : bundledDigest(bundled.name)
    const local = localByName.get(bundled.name)
    skills.push({
      name: bundled.name,
      description: bundled.description,
      source: 'bundled',
      ...(digest !== undefined ? { digest } : {}),
      downloadState: downloadStateOf({ source: 'bundled', name: bundled.name }, local, digest),
    })
  }

  for (const item of remoteItems ?? []) {
    const local = localByName.get(item.name)
    skills.push({
      name: item.name,
      description: item.description,
      source: 'catalog',
      ...(item.whenToUse !== undefined ? { whenToUse: item.whenToUse } : {}),
      revision: item.revision,
      publisher: item.publisher,
      digest: item.digest,
      updatedAt: item.updatedAt,
      downloadState: downloadStateOf(
        { source: 'catalog', name: item.name, revision: item.revision, digest: item.digest },
        local,
        undefined,
      ),
    })
  }

  skills.sort((left, right) => left.name.localeCompare(right.name))
  const warnings = readSkillLocalState(profileDir).migrationWarnings ?? []
  return {
    skills,
    ...(catalogError !== undefined ? { catalogError } : {}),
    ...(warnings.length > 0 ? { migrationWarnings: warnings } : {}),
  }
}

/**
 * `/` menu projection: system skills plus ENABLED local skills. `userInvocable`
 * is not consulted (R7); this function never issues a remote request.
 */
export async function listInvocableSkills(profileDir: string): Promise<InvocableSkillInfo[]> {
  const skills: InvocableSkillInfo[] = []
  for (const bundled of listBundledSkills()) {
    if (!SYSTEM_SKILLS.has(bundled.name)) continue
    skills.push({
      name: bundled.name,
      description: bundled.description,
      source: 'bundled',
      enabled: true,
    })
  }
  for (const local of await listUserSkills(profileDir)) {
    if (!local.enabled) continue
    skills.push({
      name: local.name,
      description: local.description,
      source: 'user',
      enabled: true,
      originKind: local.origin.kind,
    })
  }
  skills.sort((left, right) => left.name.localeCompare(right.name))
  return skills
}
