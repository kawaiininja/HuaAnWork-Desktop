/**
 * Skill catalog HTTP handlers (Task 5).
 *
 * Upload is publish: a validated archive becomes the next revision immediately;
 * there is no submission, review, signature or keyring step on this surface.
 * Reads are metadata/list/exact-revision archive only. Failures are ordinary
 * `HandlerResult`s so the dispatcher audits them before answering.
 *
 * Auditing reuses the agent catalog's coordinates (spec §7.4): `slug` carries
 * the skill name and `version` carries `String(revision)`.
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'

import { MAX_SKILL_ARCHIVE_BYTES, inspectSkillArchive } from '@huaanwork/skill-format'
import { SKILL_NAME_RE } from '@huaanwork/skill-format/markdown'

import { BodyTooLargeError, declaredContentLength, drain, isGzipRequest, readCappedBody } from './http-body.ts'
import { SkillStore, SkillStoreError } from './skill-store.ts'
import { skillRevisionSummary } from './skill-types.ts'
import type { HandlerResult } from './types.ts'

export interface SkillHandlerContext {
  request: IncomingMessage
  store: SkillStore
  publisher: string
  requestId: string
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100
const MAX_SKILL_NAME_LENGTH = 64
const EXPECTED_REVISION_HEADER = 'x-skill-expected-revision'
const REVISION_PATTERN = /^[1-9]\d*$/u

function jsonResult(
  status: number,
  body: unknown,
  audit: HandlerResult['audit'],
): HandlerResult {
  return { status, body, audit }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function invalidSkill(reason: string, slug?: string): HandlerResult {
  return jsonResult(400, { error: '技能归档无效', code: 'invalid-skill' }, {
    action: 'skills.publish',
    outcome: 'error',
    reason,
    ...(slug === undefined ? {} : { slug }),
  })
}

function tooLarge(slug: string): HandlerResult {
  return jsonResult(400, { error: '技能归档超过 5 MiB', code: 'skill-too-large' }, {
    action: 'skills.publish',
    outcome: 'error',
    reason: 'request body exceeded the skill archive cap',
    slug,
  })
}

function parseRevision(raw: string | undefined): number | undefined {
  if (raw === undefined || !REVISION_PATTERN.test(raw)) return undefined
  const revision = Number(raw)
  return Number.isSafeInteger(revision) ? revision : undefined
}

function skillNotFound(name: string, action: string): HandlerResult {
  return jsonResult(404, { error: '技能不存在', code: 'skill-not-found' }, {
    action,
    outcome: 'error',
    reason: `skill ${name} was not found`,
    slug: name,
  })
}

/** `GET /v1/skills?cursor=&limit=` — every name's latest revision. */
export function listSkills(store: SkillStore, url: URL): HandlerResult {
  const limitRaw = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null) {
    if (!/^\d+$/u.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT) {
      return jsonResult(400, { error: '分页参数无效', code: 'invalid-limit' }, {
        action: 'skills.list',
        outcome: 'error',
        reason: `limit ${JSON.stringify(limitRaw)} is outside 1..${String(MAX_LIMIT)}`,
      })
    }
    limit = Number(limitRaw)
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  try {
    const page = store.listAfter(cursor, limit)
    return jsonResult(200, page, { action: 'skills.list', outcome: 'ok' })
  } catch (cause) {
    if (cause instanceof SkillStoreError && cause.code === 'invalid-cursor') {
      return jsonResult(400, { error: '游标无效', code: 'invalid-cursor' }, {
        action: 'skills.list',
        outcome: 'error',
        reason: 'cursor is not a valid skill pagination cursor',
      })
    }
    throw cause
  }
}

/** `GET /v1/skills/{name}/{revision}` — exact revision metadata. */
export function getSkillRevision(store: SkillStore, name: string, revisionRaw: string): HandlerResult {
  const revision = parseRevision(revisionRaw)
  if (!SKILL_NAME_RE.test(name) || name.length > MAX_SKILL_NAME_LENGTH || revision === undefined) {
    return skillNotFound(name, 'skills.get')
  }
  const record = store.get(name, revision)
  if (record === undefined) return skillNotFound(name, 'skills.get')
  return jsonResult(200, { skill: skillRevisionSummary(record) }, {
    action: 'skills.get',
    outcome: 'ok',
    slug: name,
    version: String(revision),
  })
}

/** `GET /v1/skills/{name}/{revision}/archive` — the exact revision bytes. */
export async function downloadSkillArchive(
  store: SkillStore,
  name: string,
  revisionRaw: string,
): Promise<HandlerResult> {
  const revision = parseRevision(revisionRaw)
  if (!SKILL_NAME_RE.test(name) || name.length > MAX_SKILL_NAME_LENGTH || revision === undefined) {
    return skillNotFound(name, 'skills.archive')
  }
  const record = store.get(name, revision)
  if (record === undefined) return skillNotFound(name, 'skills.archive')
  const data = await readFile(record.archivePath)
  return {
    status: 200,
    raw: { contentType: 'application/gzip', data },
    audit: { action: 'skills.archive', outcome: 'ok', slug: name, version: String(revision) },
  }
}

/** `POST /v1/skills/{name}` — validate the archive and publish it immediately. */
export async function publishSkill(ctx: SkillHandlerContext, name: string): Promise<HandlerResult> {
  if (!SKILL_NAME_RE.test(name) || name.length > MAX_SKILL_NAME_LENGTH) {
    drain(ctx.request)
    return invalidSkill(`skill name ${JSON.stringify(name)} is not kebab-case or exceeds ${String(MAX_SKILL_NAME_LENGTH)} characters`)
  }
  if (!isGzipRequest(ctx.request)) {
    drain(ctx.request)
    return invalidSkill('content-type must be application/gzip', name)
  }
  const declared = declaredContentLength(ctx.request)
  if (declared !== null && declared > MAX_SKILL_ARCHIVE_BYTES) {
    drain(ctx.request)
    return tooLarge(name)
  }

  let body: Buffer
  try {
    body = await readCappedBody(ctx.request, MAX_SKILL_ARCHIVE_BYTES + 1)
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) return tooLarge(name)
    return invalidSkill(`request body could not be read: ${errorMessage(cause)}`, name)
  }

  let inspected: Awaited<ReturnType<typeof inspectSkillArchive>>
  try {
    inspected = await inspectSkillArchive(body)
  } catch (cause) {
    return invalidSkill(`archive rejected: ${errorMessage(cause)}`, name)
  }
  if (inspected.name !== name) {
    return invalidSkill(
      `URL name ${JSON.stringify(name)} does not match SKILL.md name ${JSON.stringify(inspected.name)}`,
      name,
    )
  }

  const expectedHeader = ctx.request.headers[EXPECTED_REVISION_HEADER]
  let expectedRevision: number | undefined
  if (expectedHeader !== undefined) {
    const parsed = typeof expectedHeader === 'string' ? parseRevision(expectedHeader.trim()) : undefined
    if (parsed === undefined) {
      return invalidSkill(`${EXPECTED_REVISION_HEADER} must be a positive integer`, name)
    }
    expectedRevision = parsed
  }

  try {
    const published = await ctx.store.publish({
      name,
      publisher: ctx.publisher,
      digest: inspected.digest,
      description: inspected.description,
      ...(inspected.whenToUse !== undefined ? { whenToUse: inspected.whenToUse } : {}),
      archive: body,
      expectedRevision,
      requestId: ctx.requestId,
      createdAt: new Date().toISOString(),
    })
    return jsonResult(published.created ? 201 : 200, {
      skill: published.skill,
      created: published.created,
    }, {
      action: 'skills.publish',
      outcome: 'ok',
      slug: name,
      version: String(published.skill.revision),
    })
  } catch (cause) {
    if (!(cause instanceof SkillStoreError)) throw cause
    const conflictMessages: Record<string, string> = {
      'skill-already-exists': '同名技能已存在，首次上传不能覆盖',
      'skill-name-conflict': '该技能由其他发布者所有',
      'skill-revision-conflict': '技能版本冲突，请刷新后重试',
    }
    if (cause.code === 'invalid-skill') {
      return invalidSkill(cause.message, name)
    }
    const status = 409
    return jsonResult(status, {
      error: conflictMessages[cause.code] ?? '技能冲突',
      code: cause.code,
    }, {
      action: 'skills.publish',
      // A 409 is a state conflict, not a credential denial: `denied` stays the
      // 401/403 vocabulary across both journals.
      outcome: 'error',
      reason: cause.message,
      slug: name,
    })
  }
}
