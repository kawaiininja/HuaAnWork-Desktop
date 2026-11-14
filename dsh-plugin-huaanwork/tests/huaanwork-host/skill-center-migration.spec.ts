import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'vitest'
import { createSkillDigest, readSkillDirectory } from '@huaanwork/skill-format'
import { findBundledEntry } from '../../src/huaanwork-guardrails/skills.ts'
import { ensureSkillCenterMigration } from '../../src/huaanwork-host/skill-center-migration.ts'
import {
  readSkillLocalState,
  readUserSkillToggles,
  setUserSkillToggle,
  skillLocalStatePath,
} from '../../src/huaanwork-host/skill-local-state.ts'

let homes: string[] = []
let prevAgentsHome: string | undefined

function makeProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'hw-skill-migration-'))
  homes.push(profile)
  return profile
}

function writeLocalSkill(profileDir: string, name: string, content: string): string {
  const dir = join(profileDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} 本地描述\n---\n\n${content}\n`, 'utf8')
  return path
}

function writeFlatLocalSkill(profileDir: string, name: string, content: string): string {
  const root = join(profileDir, 'skills')
  mkdirSync(root, { recursive: true })
  const path = join(root, `${name}.md`)
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} 扁平描述\n---\n\n${content}\n`, 'utf8')
  return path
}

function writeExternalSkill(name: string, content: string): string {
  const root = join(process.env.DSH_AGENTS_HOME!, 'skills')
  mkdirSync(root, { recursive: true })
  const path = join(root, `${name}.md`)
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} 外部描述\n---\n\n${content}\n`, 'utf8')
  return path
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

beforeEach(() => {
  prevAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = mkdtempSync(join(tmpdir(), 'hw-fake-agents-'))
  homes.push(process.env.DSH_AGENTS_HOME)
})

afterEach(() => {
  if (prevAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = prevAgentsHome
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe('ensureSkillCenterMigration', () => {
  test('migration enables existing user skills without importing external skills', async () => {
    const profile = makeProfile()
    writeLocalSkill(profile, 'legacy', '旧本地技能')
    const externalPath = writeExternalSkill('external-only', '外部技能')
    const externalBefore = readFileSync(externalPath, 'utf8')

    const warnings = await ensureSkillCenterMigration(profile)
    assert.equal(readUserSkillToggles(profile).legacy, true)
    assert.equal(readUserSkillToggles(profile)['external-only'], undefined)
    assert.equal(readSkillLocalState(profile).migration?.version, 1)
    assert.deepEqual(warnings, [])
    assert.equal(existsSync(join(profile, 'skills', 'external-only')), false)
    assert.equal(readFileSync(externalPath, 'utf8'), externalBefore)
  })

  test('copies legacy-enabled ordinary bundled skills and skips system, internal and unknown names', async () => {
    const profile = makeProfile()
    writeFileSync(
      join(profile, 'skill-toggles.json'),
      JSON.stringify({ pdf: true, explore: true, 'create-agent': true, 'missing-skill': true }),
      'utf8',
    )
    const bundled = findBundledEntry('pdf')
    assert.ok(bundled)

    const warnings = await ensureSkillCenterMigration(profile)
    assert.deepEqual(warnings, [])

    const copiedDir = join(profile, 'skills', 'pdf')
    const copiedMarkdown = join(copiedDir, 'SKILL.md')
    assert.equal(existsSync(copiedMarkdown), true)
    assert.equal(readFileSync(copiedMarkdown, 'utf8'), readFileSync(bundled.path, 'utf8'))

    const state = readSkillLocalState(profile)
    assert.equal(state.skills.pdf?.origin.kind, 'bundled')
    assert.equal(state.skills.pdf?.contentDigest, createSkillDigest(readSkillDirectory(copiedDir)))
    assert.equal(readUserSkillToggles(profile).pdf, true)
    assert.equal(readUserSkillToggles(profile).explore, undefined)
    assert.equal(readUserSkillToggles(profile)['create-agent'], undefined)
    assert.equal(readUserSkillToggles(profile)['missing-skill'], undefined)
    assert.equal(existsSync(join(profile, 'skills', 'explore')), false)
    assert.equal(existsSync(join(profile, 'skills', 'create-agent')), false)
    assert.equal(existsSync(join(profile, 'skills', 'missing-skill')), false)
    // 旧开关表只作为迁移输入,保留原文件。
    assert.deepEqual(readJson(join(profile, 'skill-toggles.json')), {
      pdf: true,
      explore: true,
      'create-agent': true,
      'missing-skill': true,
    })
  })

  test('a local same-name copy is enabled without overwriting its files and yields a warning', async () => {
    const profile = makeProfile()
    const localPath = writeLocalSkill(profile, 'pdf', '本地同名正文')
    writeFileSync(join(profile, 'skill-toggles.json'), JSON.stringify({ pdf: true }), 'utf8')

    const warnings = await ensureSkillCenterMigration(profile)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /pdf/)
    assert.ok(readFileSync(localPath, 'utf8').includes('本地同名正文'))
    assert.equal(readUserSkillToggles(profile).pdf, true)
    assert.equal(readSkillLocalState(profile).skills.pdf?.origin.kind, 'created')

    // 完成标记写入后重跑不再复制也不再追加警告,但历史警告留在文档里。
    const again = await ensureSkillCenterMigration(profile)
    assert.deepEqual(again, [])
    assert.deepEqual(readSkillLocalState(profile).migrationWarnings, warnings)
    assert.ok(readFileSync(localPath, 'utf8').includes('本地同名正文'))
  })

  test('does not re-enable a skill disabled after the migration completed', async () => {
    const profile = makeProfile()
    writeLocalSkill(profile, 'legacy', '旧本地技能')
    await ensureSkillCenterMigration(profile)
    setUserSkillToggle(profile, 'legacy', false)
    const completedAt = readSkillLocalState(profile).migration?.completedAt

    const warnings = await ensureSkillCenterMigration(profile)
    assert.deepEqual(warnings, [])
    assert.equal(readUserSkillToggles(profile).legacy, undefined)
    assert.equal(readSkillLocalState(profile).migration?.completedAt, completedAt)
  })

  test('a half-finished document is re-entrant and keeps existing entries', async () => {
    const profile = makeProfile()
    writeLocalSkill(profile, 'legacy', '旧本地技能')
    writeFileSync(
      skillLocalStatePath(profile),
      JSON.stringify({
        schemaVersion: 1,
        skills: {
          legacy: {
            origin: { kind: 'catalog', name: 'legacy', revision: 7, publisher: 'publisher', digest: 'sha256:published' },
            contentDigest: 'sha256:previous',
          },
        },
      }),
      'utf8',
    )

    const warnings = await ensureSkillCenterMigration(profile)
    assert.deepEqual(warnings, [])
    const state = readSkillLocalState(profile)
    assert.equal(state.migration?.version, 1)
    assert.deepEqual(state.skills.legacy, {
      origin: { kind: 'catalog', name: 'legacy', revision: 7, publisher: 'publisher', digest: 'sha256:published' },
      contentDigest: 'sha256:previous',
    })
    assert.equal(readUserSkillToggles(profile).legacy, true)
  })

  test('a failed run writes no completion marker and can be retried', async () => {
    const profile = makeProfile()
    writeFileSync(join(profile, 'skill-toggles.json'), JSON.stringify({ pdf: true }), 'utf8')
    // skills 根被一个普通文件占住:扫描/复制失败,迁移必须留下可重入状态。
    writeFileSync(join(profile, 'skills'), 'blocked', 'utf8')

    await assert.rejects(ensureSkillCenterMigration(profile))
    assert.equal(existsSync(skillLocalStatePath(profile)), false)
    assert.deepEqual(readJson(join(profile, 'skill-toggles.json')), { pdf: true })

    rmSync(join(profile, 'skills'))
    const warnings = await ensureSkillCenterMigration(profile)
    assert.deepEqual(warnings, [])
    assert.equal(readSkillLocalState(profile).migration?.version, 1)
    assert.equal(readUserSkillToggles(profile).pdf, true)
    assert.equal(existsSync(join(profile, 'skills', 'pdf', 'SKILL.md')), true)
  })

  test('labels flat local markdown skills with the SKILL.md digest', async () => {
    const profile = makeProfile()
    const flatPath = writeFlatLocalSkill(profile, 'flat', '扁平旧正文')

    const warnings = await ensureSkillCenterMigration(profile)
    assert.deepEqual(warnings, [])
    assert.equal(readUserSkillToggles(profile).flat, true)
    assert.deepEqual(readSkillLocalState(profile).skills.flat, {
      origin: { kind: 'created' },
      contentDigest: createSkillDigest([{ path: 'SKILL.md', data: readFileSync(flatPath) }]),
    })
  })
})
