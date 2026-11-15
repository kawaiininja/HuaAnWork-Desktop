/**
 * Skill catalog types (Task 4).
 *
 * Skills share the agent catalog's process, transport and tokens, but not its
 * package model: one series per skill name, a monotonically increasing integer
 * revision, and no review/signature state. `SkillState` is the entire persisted
 * skill state; archives live beside it under `skills/archives/`.
 */

export type SkillRevisionRecord = {
  name: string
  revision: number
  description: string
  whenToUse?: string
  publisher: string
  digest: string
  archivePath: string
  size: number
  createdAt: string
}

export type SkillSeries = {
  name: string
  owner: string
  latestRevision: number
  revisions: Record<string, SkillRevisionRecord>
}

export type SkillState = {
  schemaVersion: 1
  lastMutation?: { requestId: string; action: string; at: string }
  skills: Record<string, SkillSeries>
}

/** API projection: never exposes the internal archive path. */
export type SkillRevisionSummary = {
  name: string
  revision: number
  description: string
  whenToUse?: string
  publisher: string
  digest: string
  size: number
  updatedAt: string
}

export type SkillPublishInput = {
  name: string
  publisher: string
  digest: string
  description: string
  whenToUse?: string
  archive: Buffer
  expectedRevision: number | undefined
  requestId: string
  createdAt: string
}

export function emptySkillState(): SkillState {
  return { schemaVersion: 1, skills: {} }
}

export function skillRevisionSummary(record: SkillRevisionRecord): SkillRevisionSummary {
  return {
    name: record.name,
    revision: record.revision,
    description: record.description,
    ...(record.whenToUse !== undefined ? { whenToUse: record.whenToUse } : {}),
    publisher: record.publisher,
    digest: record.digest,
    size: record.size,
    updatedAt: record.createdAt,
  }
}
