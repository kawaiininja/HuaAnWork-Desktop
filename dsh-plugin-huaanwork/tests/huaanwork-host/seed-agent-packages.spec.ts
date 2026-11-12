import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import {
  agentPackageDir,
  readAgentPackage,
  readAgentPackageFile,
  readAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'seed-agent-packages.mjs')
const SLUGS = ['typo-check', 'code-review', 'task-orch']

let roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

test('seeds all three packages into an isolated profile with regenerated identity', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'huaanwork-seed-test-'))
  roots.push(profileDir)
  const stdout = execFileSync(
    process.execPath,
    ['--experimental-transform-types', SCRIPT, '--profile', profileDir],
    { encoding: 'utf8', cwd: join(import.meta.dirname, '..', '..') },
  )
  const result = JSON.parse(stdout)
  expect(result.seeded).toEqual(SLUGS)

  const state = readAgentPackageState(profileDir)
  for (const slug of SLUGS) {
    const entry = state[`local:${slug}`]
    expect(entry?.source).toBe('local')
    expect(entry?.enabled).toBe(true)
    expect(entry?.installedVersion).toBe('1.0.0')
    expect(entry?.publishStatus).toBe('none')

    const detail = readAgentPackage(profileDir, slug)
    expect(detail?.slug).toBe(slug)
    expect(detail?.version).toBe('1.0.0')
    expect(detail?.source).toBe('local')
    expect(detail?.enabled).toBe(true)

    // manifest 字段经磁盘 agent.json 核对（AgentPackageDetail 无 manifest 字段）。
    const manifest = JSON.parse(readAgentPackageFile(profileDir, slug, 'agent.json')!)
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
    // draftId 已重新生成，不再是源文件占位。
    expect(manifest.draftId).not.toMatch(/^00000000-0000-4000-8000-0000000001/)
    expect(manifest.createdAt).not.toBe('2026-11-11T00:00:00.000Z')
    expect(agentPackageDir(profileDir, slug)).toContain(slug)
  }
})
