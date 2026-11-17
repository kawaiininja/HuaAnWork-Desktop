import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  SkillDuplicateError,
  duplicateLocalSkill,
} from '../../src/huaanwork-host/skill-duplicate.ts'
import { createSkillFromDraft } from '../../src/huaanwork-host/skills-host.ts'
import { readSkillLocalState, readUserSkillToggles } from '../../src/huaanwork-host/skill-local-state.ts'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skill-duplicate-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

function writeLocalSkill(profileDir: string, name: string): void {
  const dir = join(profileDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\n正文\n`, 'utf8')
  writeFileSync(join(dir, 'helper.mjs'), 'console.log("helper")\n', 'utf8')
}

test('copies the complete resources under a new created/disabled name', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'source-skill')
  const copy = await duplicateLocalSkill(profile, 'source-skill', 'copy-skill')
  assert.equal(copy.name, 'copy-skill')
  assert.equal(copy.enabled, false)
  assert.equal(copy.origin.kind, 'created')
  assert.match(readFileSync(join(profile, 'skills', 'copy-skill', 'helper.mjs'), 'utf8'), /helper/)
  // The frontmatter name is rewritten, never left as the source identity.
  assert.match(readFileSync(join(profile, 'skills', 'copy-skill', 'SKILL.md'), 'utf8'), /name: copy-skill/)
  assert.equal(readUserSkillToggles(profile)['copy-skill'], undefined)
  assert.equal(readSkillLocalState(profile).skills['copy-skill']?.origin.kind, 'created')
})

test('refuses taken, reserved, invalid and unchanged target names', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'source-skill')
  writeLocalSkill(profile, 'taken-skill')
  for (const [target, code] of [
    ['taken-skill', 'skill-name-taken'],
    ['explore', 'skill-name-taken'],
    ['create-agent', 'skill-name-taken'],
    ['Bad Name', 'invalid-name'],
    ['source-skill', 'invalid-name'],
  ] as const) {
    await assert.rejects(
      duplicateLocalSkill(profile, 'source-skill', target),
      (cause: unknown) => cause instanceof SkillDuplicateError && cause.code === code,
      target,
    )
  }
})

test('refuses a missing source skill', async () => {
  const profile = makeHome()
  await assert.rejects(
    duplicateLocalSkill(profile, 'missing', 'copy-skill'),
    (cause: unknown) => cause instanceof SkillDuplicateError && cause.code === 'skill-not-found',
  )
})

test('a duplicate does not inherit the creation idempotency keys', async () => {
  const profile = makeHome()
  const created = await createSkillFromDraft(
    profile,
    { name: 'source-skill', description: '源技能', content: '正文' },
    'draft-src',
    'session-src',
  )
  assert.equal(created.ok, true)

  const copy = await duplicateLocalSkill(profile, 'source-skill', 'copy-skill')

  assert.equal(copy.name, 'copy-skill')
  const state = readSkillLocalState(profile)
  assert.equal(state.skills['source-skill']?.creationDraftId, 'draft-src')
  assert.equal(state.skills['source-skill']?.creationSessionId, 'session-src')
  assert.equal(state.skills['copy-skill']?.creationDraftId, undefined)
  assert.equal(state.skills['copy-skill']?.creationSessionId, undefined)
})
