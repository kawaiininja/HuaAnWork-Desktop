/**
 * Task 7: download a center skill into 我的技能.
 *
 * Real temp profiles + real archives; the remote is a fake client bound through
 * the production binding. Downloads are snapshots: new copies stay disabled,
 * explicit updates keep the enable toggle, conflicts never overwrite.
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { buildSkillArchive, inspectSkillArchive } from '@huaanwork/skill-format'
import { SYSTEM_SKILLS, listBundledSkills } from '../../src/huaanwork-guardrails/skills.ts'
import {
  SkillDownloadError,
  downloadSkillToMine,
} from '../../src/huaanwork-host/skill-catalog-download.ts'
import {
  configureSkillCatalog,
  resetSkillCatalogForTests,
  type SkillCatalogClient,
} from '../../src/huaanwork-host/skill-catalog-client.ts'
import { readUserSkillToggles, readSkillLocalState, setUserSkillToggle } from '../../src/huaanwork-host/skill-local-state.ts'
import { updateSkill } from '../../src/huaanwork-host/skills-host.ts'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skill-download-'))
  homes.push(home)
  return home
}

afterEach(() => {
  resetSkillCatalogForTests()
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

function archiveFor(name: string, body: string, script = 'console.log("demo")\n') {
  return buildSkillArchive([
    { path: 'SKILL.md', data: Buffer.from(`---\nname: ${name}\ndescription: ${name} 演示\n---\n\n${body}\n`, 'utf8') },
    { path: 'scripts/run.mjs', data: Buffer.from(script, 'utf8') },
  ])
}

function bindFakeClient(options: {
  name: string
  revision: number
  archive: Buffer
  digest?: string
  publisher?: string
}): SkillCatalogClient {
  const client: SkillCatalogClient = {
    listSharedSkills: async () => [],
    getSkillRevision: async (name, revision) => ({
      name,
      revision,
      description: `${name} 演示`,
      publisher: options.publisher ?? 'alice',
      digest: options.digest ?? '',
      size: options.archive.byteLength,
      updatedAt: '2026-11-14T00:00:00.000Z',
    }),
    downloadSkillArchive: async () => options.archive,
  }
  configureSkillCatalog({
    readSettings: () => ({
      agents_host: '127.0.0.1',
      agents_port: 18080,
      agents_catalog_token: '',
      agents_skill_upload_token: '',
    }),
    client,
  })
  return client
}

async function bindCatalog(name: string, revision: number, body: string, digestOverride?: string): Promise<void> {
  const archive = await archiveFor(name, body)
  const inspected = await inspectSkillArchive(archive)
  bindFakeClient({
    name,
    revision,
    archive,
    digest: digestOverride ?? inspected.digest,
  })
}

function stagingLeftovers(profileDir: string): string[] {
  return readdirSync(profileDir).filter(entry => entry.startsWith('.skill-staging-') || entry.startsWith('.skill-backup-'))
}

test('downloads a shared skill as a disabled local catalog copy', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '正文')
  const result = await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 })
  assert.equal(result.created, true)
  assert.equal(result.updated, false)
  assert.equal(result.skill.enabled, false)
  assert.deepEqual(result.skill.origin, {
    kind: 'catalog',
    name: 'demo',
    revision: 1,
    publisher: 'alice',
    digest: result.skill.contentDigest,
  })
  assert.equal(readUserSkillToggles(profile).demo, undefined)
  assert.equal(readSkillLocalState(profile).skills.demo?.origin.kind, 'catalog')
})

test('copies the complete resource set', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '正文')
  await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 })
  const script = readFileSync(join(profile, 'skills', 'demo', 'scripts', 'run.mjs'), 'utf8')
  assert.equal(script, 'console.log("demo")\n')
  assert.deepEqual(stagingLeftovers(profile), [])
})

test('downloads a bundled skill offline and refuses system skills', async () => {
  const profile = makeHome()
  const bundled = listBundledSkills().find(skill => !SYSTEM_SKILLS.has(skill.name) && skill.name !== 'create-agent')
  assert.ok(bundled)
  const result = await downloadSkillToMine(profile, { source: 'bundled', name: bundled.name })
  assert.equal(result.created, true)
  assert.equal(result.skill.enabled, false)
  assert.equal(result.skill.origin.kind, 'bundled')

  await assert.rejects(
    downloadSkillToMine(profile, { source: 'bundled', name: 'explore' }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'skill-is-system',
  )
})

test('same digest is idempotent', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '正文')
  await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 })
  const replay = await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 })
  assert.equal(replay.created, false)
  assert.equal(replay.updated, false)
})

test('an explicit update keeps the enable toggle and advances the origin revision', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '第一版')
  await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 })
  setUserSkillToggle(profile, 'demo', true)
  await bindCatalog('demo', 2, '第二版')
  const updated = await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 2 })
  assert.equal(updated.created, false)
  assert.equal(updated.updated, true)
  assert.equal(updated.skill.enabled, true)
  assert.equal(updated.skill.origin.kind, 'catalog')
  if (updated.skill.origin.kind === 'catalog') assert.equal(updated.skill.origin.revision, 2)
  assert.match(readFileSync(join(profile, 'skills', 'demo', 'SKILL.md'), 'utf8'), /第二版/)
})

test('refuses to overwrite a locally created skill', async () => {
  const profile = makeHome()
  mkdirSync(join(profile, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(profile, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 本地\n---\n\n本地正文\n')
  await bindCatalog('demo', 1, '正文')
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'local-skill-conflict',
  )
})

test('refuses to overwrite a downloaded copy that has local edits', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '第一版')
  await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 })
  // In-app edits go through updateSkill, which refreshes the stored digest.
  const updated = await updateSkill(profile, 'demo', { description: '改过', content: '本地改过' })
  assert.equal(updated.ok, true)
  await bindCatalog('demo', 2, '第二版')
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 2 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'local-skill-conflict',
  )
})

test('refuses to overwrite an out-of-band edit of a downloaded copy', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '第一版')
  await downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 })
  // Direct file edit outside the app: stored state still claims the old digest.
  writeFileSync(
    join(profile, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: 手改\n---\n\n手改正文\n',
    'utf8',
  )
  await bindCatalog('demo', 2, '第二版')
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 2 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'local-skill-conflict',
  )
})

test('refuses to overwrite a modified bundled copy', async () => {
  const profile = makeHome()
  const bundled = listBundledSkills().find(skill => !SYSTEM_SKILLS.has(skill.name) && skill.name !== 'create-agent')
  assert.ok(bundled)
  await downloadSkillToMine(profile, { source: 'bundled', name: bundled.name })
  const updated = await updateSkill(profile, bundled.name, { description: '改过', content: '本地改过' })
  assert.equal(updated.ok, true)
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'bundled', name: bundled.name }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'local-skill-conflict',
  )
})

test('refuses a catalog entry that uses a reserved name', async () => {
  const profile = makeHome()
  await bindCatalog('explore', 1, '正文')
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'explore', revision: 1 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'skill-is-system',
  )
})

test('restores an interrupted replace instead of deleting the only copy', async () => {
  const profile = makeHome()
  // Simulate a crash between "artifact moved aside" and "staging renamed in":
  // only the backup exists, and it carries user edits.
  const backup = join(profile, '.skill-backup-demo')
  mkdirSync(backup, { recursive: true })
  writeFileSync(join(backup, 'SKILL.md'), '---\nname: demo\ndescription: 手改\n---\n\n手改正文\n', 'utf8')
  await bindCatalog('demo', 1, '正文')
  // The restored copy is a same-name local skill → the download must conflict,
  // not delete the recovered bytes.
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'local-skill-conflict',
  )
  assert.match(readFileSync(join(profile, 'skills', 'demo', 'SKILL.md'), 'utf8'), /手改正文/)
  assert.equal(existsSync(backup), false)
})

test('restores a flat backup to its .md shape', async () => {
  const profile = makeHome()
  mkdirSync(join(profile, 'skills'), { recursive: true })
  writeFileSync(
    join(profile, '.skill-backup-demo'),
    '---\nname: demo\ndescription: 手改\n---\n\n扁平手改正文\n',
    'utf8',
  )
  await bindCatalog('demo', 1, '正文')
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'local-skill-conflict',
  )
  // The recovered flat file is a real local skill again.
  assert.match(readFileSync(join(profile, 'skills', 'demo.md'), 'utf8'), /扁平手改正文/)
  assert.equal(existsSync(join(profile, 'skills', 'demo')), false)
})

test('sweeps its staging sibling when the final rename fails', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '正文')
  const skillsRoot = join(profile, 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  chmodSync(skillsRoot, 0o500)
  try {
    await assert.rejects(downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }))
  } finally {
    chmodSync(skillsRoot, 0o700)
  }
  assert.deepEqual(stagingLeftovers(profile), [])
  assert.throws(() => readdirSync(join(skillsRoot, 'demo')))
})

test('rejects a digest mismatch without touching the local tree', async () => {
  const profile = makeHome()
  const archive = await archiveFor('demo', '正文')
  bindFakeClient({ name: 'demo', revision: 1, archive, digest: `sha256:${'f'.repeat(64)}` })
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'archive-invalid',
  )
  assert.deepEqual(readSkillLocalState(profile).skills, {})
  assert.throws(() => readdirSync(join(profile, 'skills', 'demo')))
})

test('leaves no staging artifacts behind when the transfer fails', async () => {
  const profile = makeHome()
  const failing: SkillCatalogClient = {
    listSharedSkills: async () => [],
    getSkillRevision: async (name, revision) => ({
      name,
      revision,
      description: 'x',
      publisher: 'alice',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1,
      updatedAt: '2026-11-14T00:00:00.000Z',
    }),
    downloadSkillArchive: async () => {
      throw new Error('network down')
    },
  }
  configureSkillCatalog({
    readSettings: () => ({
      agents_host: '127.0.0.1',
      agents_port: 18080,
      agents_catalog_token: '',
      agents_skill_upload_token: '',
    }),
    client: failing,
  })
  await assert.rejects(downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }))
  assert.deepEqual(stagingLeftovers(profile), [])
  assert.deepEqual(readSkillLocalState(profile).skills, {})
})

test('serializes concurrent downloads of the same skill', async () => {
  const profile = makeHome()
  await bindCatalog('demo', 1, '正文')
  const results = await Promise.all([
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }),
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }),
  ])
  assert.equal(results.filter(result => result.created).length, 1)
  assert.equal(results.filter(result => !result.created && !result.updated).length, 1)
})

test('rejects an archive whose name does not match the request', async () => {
  const profile = makeHome()
  const archive = await archiveFor('other', '正文')
  bindFakeClient({ name: 'demo', revision: 1, archive })
  await assert.rejects(
    downloadSkillToMine(profile, { source: 'catalog', name: 'demo', revision: 1 }),
    (cause: unknown) => cause instanceof SkillDownloadError && cause.code === 'archive-invalid',
  )
})
