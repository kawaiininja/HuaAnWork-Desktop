#!/usr/bin/env node
/**
 * 把 agent-packages/ 三个源包播种到指定 profile。
 * 用法: node --experimental-transform-types scripts/seed-agent-packages.mjs \
 *         --profile <profileDir> [--sources <dir>]
 * 隔离规则只约束验收运行：验收/CI 一律指向隔离 profile，绝不触碰生产 profile。
 * 生产 creator profile 的播种是 owner 运维动作（见 docs/huaanwork-three-agent-packages-release.md §3.1）。
 * 警告：写入用 replace:true 并把本地状态重置为 {enabled:true, publishStatus:'none'}——
 * 发布后不要再重跑本脚本，否则会替换源并重置本地发布状态。
 * draftId/createdAt/updatedAt 每次重新生成。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAgentPackageManifest } from '@huaanwork/agent-package-format/manifest'

import {
  agentPackageBytes,
  MAX_PACKAGE_BYTES,
  MAX_PERSONA_BYTES,
  MAX_SKILL_BYTES,
  readAgentPackageState,
  writeAgentPackageAtomically,
  writeAgentPackageState,
} from '../src/huaanwork-host/agent-package/store.ts'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_SOURCES_ROOT = join(SCRIPT_DIR, '..', 'agent-packages')
const SLUGS = ['typo-check', 'code-review', 'task-orch']

function usage() {
  console.error('usage: seed-agent-packages.mjs --profile <profileDir> [--sources <dir>]')
  process.exit(2)
}

function parseArgs(argv) {
  const options = { profileDir: undefined, sourcesRoot: DEFAULT_SOURCES_ROOT }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) usage()
    if (flag === '--profile') options.profileDir = value
    else if (flag === '--sources') options.sourcesRoot = value
    else usage()
  }
  if (options.profileDir === undefined) usage()
  return options
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

function readAndValidate(sourcesRoot, slug) {
  const dir = join(sourcesRoot, slug)
  const rawManifest = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'))
  const now = new Date().toISOString()
  const manifest = { ...rawManifest, draftId: randomUUID(), createdAt: now, updatedAt: now }
  const parsed = parseAgentPackageManifest(manifest)
  if (!parsed.ok) {
    throw new Error(`${slug} manifest 校验失败: ${JSON.stringify(parsed.fieldErrors)}`)
  }
  // 预检必须覆盖 writeAgentPackageAtomically 在写入循环内才会触发的每一项校验
  // （manifest 已含 slug 形状）：否则第三包失败时前两包已落盘，P2 的
  // 「先全量预检、再写入」保证不成立。
  if (parsed.manifest.skill === null) {
    throw new Error(`${slug} 未声明 skill；播种源必须带 skill/SKILL.md`)
  }
  if (parsed.manifest.tools.mode !== 'none') {
    throw new Error(`${slug} 的 tools.mode=${parsed.manifest.tools.mode} 需要入口文件，播种脚本不支持`)
  }
  const persona = readFileSync(join(dir, 'persona.md'), 'utf8')
  if (!persona.trim()) {
    throw new Error(`${slug} persona.md 不能为空`)
  }
  const personaBytes = utf8Bytes(persona)
  if (personaBytes > MAX_PERSONA_BYTES) {
    throw new Error(`${slug} persona.md 超过单文件上限: ${personaBytes} > ${MAX_PERSONA_BYTES}`)
  }
  const skillMarkdown = readFileSync(join(dir, 'skill', 'SKILL.md'), 'utf8')
  if (!skillMarkdown.trim()) {
    throw new Error(`${slug} skill/SKILL.md 不能为空`)
  }
  const skillBytes = utf8Bytes(skillMarkdown)
  if (skillBytes > MAX_SKILL_BYTES) {
    throw new Error(`${slug} skill/SKILL.md 超过单文件上限: ${skillBytes} > ${MAX_SKILL_BYTES}`)
  }
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

const { profileDir, sourcesRoot } = parseArgs(process.argv.slice(2))
// 终审 P2：先完成三包 manifest/预算/文件集全量预检，再开始任何写入——
// 避免第三包失败时前两包已写盘（Task 14 会指引生产 creator 使用本脚本）。
const prefetched = new Map(SLUGS.map((slug) => [slug, readAndValidate(sourcesRoot, slug)]))
const seeded = []
const details = []
for (const slug of SLUGS) {
  details.push(seedOne(profileDir, slug, prefetched.get(slug)))
  seeded.push(slug)
}
console.log(JSON.stringify({ seeded, details }, null, 2))
