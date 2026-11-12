#!/usr/bin/env node
/**
 * 把 agent-packages/ 三个源包播种到指定隔离 profile。
 * 用法: node --experimental-transform-types scripts/seed-agent-packages.mjs --profile <profileDir>
 * 绝不触碰生产 profile；draftId/createdAt/updatedAt 每次重新生成。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAgentPackageManifest } from '@huaanwork/agent-package-format/manifest'

import {
  agentPackageBytes,
  MAX_PACKAGE_BYTES,
  readAgentPackageState,
  writeAgentPackageAtomically,
  writeAgentPackageState,
} from '../src/huaanwork-host/agent-package/store.ts'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const SOURCES_ROOT = join(SCRIPT_DIR, '..', 'agent-packages')
const SLUGS = ['typo-check', 'code-review', 'task-orch']

function parseArgs(argv) {
  const index = argv.indexOf('--profile')
  if (index < 0 || !argv[index + 1]) {
    console.error('usage: seed-agent-packages.mjs --profile <profileDir>')
    process.exit(2)
  }
  return { profileDir: argv[index + 1] }
}

function readAndValidate(slug) {
  const dir = join(SOURCES_ROOT, slug)
  const rawManifest = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'))
  const now = new Date().toISOString()
  const manifest = { ...rawManifest, draftId: randomUUID(), createdAt: now, updatedAt: now }
  const parsed = parseAgentPackageManifest(manifest)
  if (!parsed.ok) {
    throw new Error(`${slug} manifest 校验失败: ${JSON.stringify(parsed.fieldErrors)}`)
  }
  const persona = readFileSync(join(dir, 'persona.md'), 'utf8')
  const skillMarkdown = readFileSync(join(dir, 'skill', 'SKILL.md'), 'utf8')
  const files = { manifest: parsed.manifest, persona, skill: { markdown: skillMarkdown, scripts: [] } }
  const bytes = agentPackageBytes(files)
  if (bytes > MAX_PACKAGE_BYTES) {
    throw new Error(`${slug} 超过整包预算: ${bytes} > ${MAX_PACKAGE_BYTES}`)
  }
  return { files, bytes }
}

function seedOne(profileDir, slug, prefetched) {
  const { files, bytes } = prefetched
  writeAgentPackageAtomically({ profileDir, ...files, replace: true })
  const state = readAgentPackageState(profileDir)
  state[`local:${slug}`] = {
    source: 'local',
    enabled: true,
    installedVersion: files.manifest.version,
    publishStatus: 'none',
  }
  writeAgentPackageState(profileDir, state)
  return { slug, version: files.manifest.version, bytes }
}

const { profileDir } = parseArgs(process.argv.slice(2))
// 终审 P2：先完成三包 manifest/预算/文件集全量预检，再开始任何写入——
// 避免第三包失败时前两包已写盘（Task 14 会指引生产 creator 使用本脚本）。
const prefetched = new Map(SLUGS.map((slug) => [slug, readAndValidate(slug)]))
const seeded = []
const details = []
for (const slug of SLUGS) {
  details.push(seedOne(profileDir, slug, prefetched.get(slug)))
  seeded.push(slug)
}
console.log(JSON.stringify({ seeded, details }, null, 2))
