import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import {
  agentPackageDir,
  agentPackageStatePath,
  readAgentPackage,
  readAgentPackageFile,
} from '../../src/huaanwork-host/agent-package/store.ts'

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'seed-agent-packages.mjs')
const SOURCES = join(PACKAGE_ROOT, 'agent-packages')
const SLUGS = ['typo-check', 'code-review', 'task-orch']
const PLACEHOLDER_TIMESTAMP = '2026-11-11T00:00:00.000Z'
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

test('seeds all three packages into an isolated profile with regenerated identity', () => {
  const profileDir = tempRoot('huaanwork-seed-test-')
  const stdout = execFileSync(
    process.execPath,
    ['--experimental-transform-types', SCRIPT, '--profile', profileDir],
    { encoding: 'utf8', cwd: PACKAGE_ROOT },
  )
  const result = JSON.parse(stdout)
  expect(result.seeded).toEqual(SLUGS)

  // 直接解析磁盘 agents-state.json，绕过读取器的默认值清洗，钉住写入的
  // 精确字段与键集合。
  const rawState = JSON.parse(readFileSync(agentPackageStatePath(profileDir), 'utf8'))
  expect(Object.keys(rawState).sort()).toEqual(SLUGS.map((slug) => `local:${slug}`).sort())

  const draftIds: string[] = []
  for (const slug of SLUGS) {
    expect(rawState[`local:${slug}`]).toEqual({
      source: 'local',
      enabled: true,
      installedVersion: '1.0.0',
      publishStatus: 'none',
    })

    const detail = readAgentPackage(profileDir, slug)
    expect(detail?.slug).toBe(slug)
    expect(detail?.version).toBe('1.0.0')
    expect(detail?.source).toBe('local')
    expect(detail?.enabled).toBe(true)

    // manifest 字段经磁盘 agent.json 核对（AgentPackageDetail 无 manifest 字段）。
    const manifest = JSON.parse(readAgentPackageFile(profileDir, slug, 'agent.json')!)
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
    // draftId/createdAt/updatedAt 已重新生成，源文件占位不再出现。
    expect(manifest.draftId).toMatch(UUID_V4_RE)
    draftIds.push(manifest.draftId)
    expect(manifest.createdAt).not.toBe(PLACEHOLDER_TIMESTAMP)
    expect(manifest.updatedAt).not.toBe(PLACEHOLDER_TIMESTAMP)
    expect(manifest.updatedAt).toBe(manifest.createdAt)
    expect(agentPackageDir(profileDir, slug)).toContain(slug)
  }
  expect(new Set(draftIds).size).toBe(SLUGS.length)
})

test('rejects an oversized third source before writing any package', () => {
  // 用临时副本破坏第三包：40 KiB persona 超 MAX_PERSONA_BYTES(32 KiB)，
  // 但整包仍在 MAX_PACKAGE_BYTES 内——失败只能来自单文件上限预检。
  const sourcesCopy = tempRoot('huaanwork-seed-sources-')
  cpSync(SOURCES, sourcesCopy, { recursive: true })
  writeFileSync(join(sourcesCopy, 'task-orch', 'persona.md'), 'x'.repeat(40 * 1024), 'utf8')

  const profileDir = tempRoot('huaanwork-seed-profile-')
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', SCRIPT, '--profile', profileDir, '--sources', sourcesCopy],
    { encoding: 'utf8', cwd: PACKAGE_ROOT },
  )
  expect(result.status).not.toBe(0)

  // P2：全部预检先于任何写入 ⇒ 前两包也不落盘，profile 保持完全为空。
  expect(existsSync(join(profileDir, 'agents'))).toBe(false)
  expect(existsSync(agentPackageStatePath(profileDir))).toBe(false)
  expect(readdirSync(profileDir)).toEqual([])

  // 失败来自第三包的单文件上限预检，而非写入循环内的同项校验。
  expect(result.stderr).toContain('task-orch')
  expect(result.stderr).toContain('persona.md')
})
