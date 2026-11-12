import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { parseAgentPackageManifest } from '@huaanwork/agent-package-format/manifest'

import {
  agentPackageBytes,
  MAX_PACKAGE_BYTES,
  MAX_PERSONA_BYTES,
  MAX_SKILL_BYTES,
} from '../../src/huaanwork-host/agent-package/store.ts'

const SOURCES_ROOT = join(import.meta.dirname, '..', '..', 'agent-packages')

function readSource(slug: string, relativePath: string): string {
  return readFileSync(join(SOURCES_ROOT, slug, relativePath), 'utf8')
}

function loadSourceManifest(slug: string) {
  const parsed = parseAgentPackageManifest(JSON.parse(readSource(slug, 'agent.json')))
  if (!parsed.ok) throw new Error(`${slug} manifest invalid: ${JSON.stringify(parsed.fieldErrors)}`)
  return parsed.manifest
}

function fileSet(slug: string) {
  const manifest = loadSourceManifest(slug)
  return {
    manifest,
    persona: readSource(slug, 'persona.md'),
    skill: { markdown: readSource(slug, 'skill/SKILL.md'), scripts: [] },
  }
}

describe('typo-check package source', () => {
  test('manifest matches the approved spec fields', () => {
    const manifest = loadSourceManifest('typo-check')
    expect(manifest.slug).toBe('typo-check')
    expect(manifest.displayName).toBe('错别字检测')
    expect(manifest.description).toBe(
      '对指定文件夹中的 Word 文档做错别字与用语规范检测：两个独立子代理背靠背双盲检测，主代理仲裁分歧，输出带行号定位与置信度的报告。用 @typo-check 调用。',
    )
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.persona).toBe('persona.md')
    expect(manifest.skill?.entry).toBe('skill/SKILL.md')
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
  })

  test('stays within store budgets', () => {
    const files = fileSet('typo-check')
    expect(Buffer.byteLength(files.persona, 'utf8')).toBeLessThanOrEqual(MAX_PERSONA_BYTES)
    expect(Buffer.byteLength(files.skill.markdown, 'utf8')).toBeLessThanOrEqual(MAX_SKILL_BYTES)
    expect(agentPackageBytes(files)).toBeLessThanOrEqual(MAX_PACKAGE_BYTES)
  })

  test('SKILL.md pins the dual-blind workflow and honest degradation', () => {
    const skill = readSource('typo-check', 'skill/SKILL.md')
    for (const pin of ['subagent', '双盲', '仲裁', '同一宿主模型', 'textutil', 'System.IO.Compression', '30000', '500', '@typo-check', '递归深度不足', '单会话多轮自审', '单条简单命令', 'smart']) {
      expect(skill).toContain(pin)
    }
    // 7 类 canonical 标签齐全
    for (const label of ['别字', '高频易混字', '多字漏字倒字', '字词重复', '专名前后不一致', '全角半角混用', '英文拼写错误']) {
      expect(skill).toContain(label)
    }
    // 明确不报与两可词
    expect(skill).toContain('其他/其它')
    expect(skill).toContain('唯一/惟一')
    expect(skill).toContain('帐')
  })
})

describe('code-review package source', () => {
  test('manifest matches the approved spec fields', () => {
    const manifest = loadSourceManifest('code-review')
    expect(manifest.slug).toBe('code-review')
    expect(manifest.displayName).toBe('代码审查')
    expect(manifest.description).toBe(
      '对指定代码文件或目录做结构化审查：按审查规格逐项检查正确性、安全、性能与可维护性，输出按严重度分级的发现与修复建议。用 @code-review 调用。',
    )
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
  })

  test('stays within store budgets', () => {
    const files = fileSet('code-review')
    expect(Buffer.byteLength(files.persona, 'utf8')).toBeLessThanOrEqual(MAX_PERSONA_BYTES)
    expect(Buffer.byteLength(files.skill.markdown, 'utf8')).toBeLessThanOrEqual(MAX_SKILL_BYTES)
    expect(agentPackageBytes(files)).toBeLessThanOrEqual(MAX_PACKAGE_BYTES)
  })

  test('SKILL.md pins the review spec structure and severity discipline', () => {
    const skill = readSource('code-review', 'skill/SKILL.md')
    for (const pin of ['严重度统计', '问题清单', 'critical', 'high', 'medium', 'low', 'info', '先反证', '安全漏洞', '@code-review']) {
      expect(skill).toContain(pin)
    }
    expect(skill).toContain('文件:行号')
  })
})
