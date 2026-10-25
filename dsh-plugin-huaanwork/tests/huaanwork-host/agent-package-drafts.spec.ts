import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { listBundledSkills, setSkillToggle } from '../../src/huaanwork-guardrails/skills.ts'
import {
  cancelAgentPackage,
  commitAgentPackage,
  isAgentCancelText,
  isAgentConsentText,
  loadAgentPackageDraft,
  proposeAgentPackage,
} from '../../src/huaanwork-host/agent-package/drafts.ts'
import { createAgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import { parseAgentPackageManifest } from '../../src/huaanwork-host/agent-package/manifest.ts'
import {
  agentPackageDir,
  agentPackageStatePath,
  agentPackagesRoot,
  listLocalAgentPackages,
  readAgentPackageState,
  setAgentPackageEnabled,
  writeAgentPackageAtomically,
  writeAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type { AgentPackageManifest, AgentPackageProposalInput } from '../../src/huaanwork-host/agent-package/types.ts'

const proposal = {
  displayName: '周报小助手',
  slug: 'weekly-report',
  description: '把一周工作整理成周报',
  persona: '你是周报助手。',
  personaSummary: '写周报',
  skillSummary: '整理本周工作',
  skill: { summary: '整理本周工作', markdown: '---\nname: weekly-report\ndescription: x\n---\n正文', scripts: [] },
  allowSkills: [],
  tools: 'none' as const,
}

let roots: string[] = []
let previousAgentsHome: string | undefined

beforeEach(() => {
  // 隔离外部技能根:未设置时 resolveInvocableSkill 会读到 ~/.agents/skills(机器相关)。
  previousAgentsHome = process.env.DSH_AGENTS_HOME
  const isolatedHome = mkdtempSync(join(tmpdir(), 'hw-drafts-agents-home-'))
  process.env.DSH_AGENTS_HOME = isolatedHome
  roots.push(isolatedHome)
})

afterEach(() => {
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgentsHome
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-drafts-'))
  roots.push(root)
  return root
}

function draftPath(root: string, sessionId: string): string {
  return join(agentPackagesRoot(root), '.drafts', `${sessionId}.json`)
}

function readManifest(root: string, slug: string) {
  const raw: unknown = JSON.parse(readFileSync(join(agentPackageDir(root, slug), 'agent.json'), 'utf8'))
  const parsed = parseAgentPackageManifest(raw)
  if (!parsed.ok) throw new Error(`manifest 无法解析:${JSON.stringify(parsed.fieldErrors)}`)
  return parsed.manifest
}

function createProposal(overrides: Partial<AgentPackageProposalInput> = {}): AgentPackageProposalInput {
  return { mode: 'create', ...proposal, ...overrides }
}

function writeUserSkill(root: string, name: string, body = '正文'): void {
  mkdirSync(join(root, 'skills', name), { recursive: true })
  writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: 演示\n---\n${body}\n`, 'utf8')
}

/**
 * 写入「包已落盘、publish reset 尚未执行」的中间态:manifest 带同一 draftId,
 * 草稿文件保持原样,供幂等 commit 重试走到 `alreadyCommitted` 分支。
 */
function writeInterruptedCommitPackage(root: string, draftId: string): void {
  const manifest: AgentPackageManifest = {
    schemaVersion: 1,
    slug: proposal.slug,
    displayName: proposal.displayName,
    description: proposal.description,
    version: '1.0.0',
    draftId,
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    persona: 'persona.md',
    skill: null,
    tools: { mode: 'none' },
    allowSkills: [],
  }
  writeAgentPackageAtomically({ profileDir: root, manifest, persona: proposal.persona, skill: null, replace: false })
}

describe('consent and cancel phrases', () => {
  test('consent is exact after trimming one trailing punctuation', () => {
    expect(isAgentConsentText(' 可以。 ')).toBe(true)
    expect(isAgentConsentText('可以，但名字改成周报')).toBe(false)
    expect(isAgentCancelText('先不要！')).toBe(true)
  })

  test('accepts exactly the documented phrases and no partial matches', () => {
    for (const text of ['可以', '确认', '同意', '就这样', '按这个建', '确认？', '同意!']) {
      expect(isAgentConsentText(text), text).toBe(true)
    }
    for (const text of ['可以。。', '好啊', '', '可以 好', '可以。，']) {
      expect(isAgentConsentText(text), text).toBe(false)
    }
    for (const text of ['取消', '先不要', '取消。', '先不要？']) {
      expect(isAgentCancelText(text), text).toBe(true)
    }
    for (const text of ['不要', '取消吧', '']) {
      expect(isAgentCancelText(text), text).toBe(false)
    }
  })
})

describe('propose and commit', () => {
  test('propose then commit writes a disabled package and deletes the draft', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-1', createProposal(), [])
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return

    expect(proposed.cardText).toBe(
      [
        '请确认是否创建这名智能体：',
        '显示名：周报小助手',
        '@标识：weekly-report',
        '能力简介：把一周工作整理成周报',
        '人设要点：写周报',
        '技能包：整理本周工作',
        '工具：不要',
        '脚本将在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。',
        '回复「可以」创建（默认关闭）；回复「取消」放弃。',
      ].join('\n'),
    )
    expect(proposed.card.toolLabel).toBe('不要')
    expect(proposed.card.tools).toBe('none')
    expect(proposed.card.mode).toBe('create')
    expect(existsSync(draftPath(root, 'session-1'))).toBe(true)
    // 草稿目录以点开头,不得出现在包列表里。
    expect(listLocalAgentPackages(root)).toEqual([])

    const committed = await commitAgentPackage(root, 'session-1', proposed.draftId, '可以', [])
    expect(committed.ok).toBe(true)
    if (!committed.ok) return
    expect(committed.packagePath).toContain('agents/weekly-report')
    expect(committed.alreadyCommitted).toBe(false)
    expect(existsSync(draftPath(root, 'session-1'))).toBe(false)

    const manifest = readManifest(root, 'weekly-report')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.draftId).toBe(proposed.draftId)
    expect(manifest.displayName).toBe('周报小助手')
    expect(manifest.skill?.summary).toBe('整理本周工作')
    expect(readAgentPackageState(root)['local:weekly-report']).toEqual({
      source: 'local',
      enabled: false,
      installedVersion: '1.0.0',
      publishStatus: 'none',
    })
    expect(readFileSync(join(agentPackageDir(root, 'weekly-report'), 'skill', 'SKILL.md'), 'utf8')).toBe(
      proposal.skill.markdown,
    )
    expect(listLocalAgentPackages(root)).toHaveLength(1)
  })

  test('same turn propose then commit is rejected', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-2', createProposal(), [])
    if (!proposed.ok) throw new Error('propose failed')
    const committed = await commitAgentPackage(root, 'session-2', proposed.draftId, '可以', [], {
      proposedThisTurn: true,
    })
    expect(committed.ok).toBe(false)
    if (committed.ok) return
    expect(committed.error).toMatch(/同一轮/)
    // 拒绝后草稿仍在,下一轮还能确认。
    expect(loadAgentPackageDraft(root, 'session-2')?.draftId).toBe(proposed.draftId)
  })

  test('a non-consent sentence or a mismatched draftId keeps the draft', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-3', createProposal(), [])
    if (!proposed.ok) throw new Error('propose failed')

    const notConsent = await commitAgentPackage(root, 'session-3', proposed.draftId, '可以，但名字改成周报', [])
    expect(notConsent.ok).toBe(false)
    if (!notConsent.ok) expect(notConsent.error).toMatch(/同意/)

    const mismatched = await commitAgentPackage(root, 'session-3', 'another-draft', '可以', [])
    expect(mismatched.ok).toBe(false)

    expect(loadAgentPackageDraft(root, 'session-3')?.draftId).toBe(proposed.draftId)
    expect(listLocalAgentPackages(root)).toEqual([])
  })

  test('a failed commit keeps the draft and leaves no package behind', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-4', createProposal(), [])
    if (!proposed.ok) throw new Error('propose failed')

    // 提出草稿后目标目录被占用:落盘必须失败,草稿保留。
    mkdirSync(join(agentPackagesRoot(root), 'weekly-report'), { recursive: true })
    const failed = await commitAgentPackage(root, 'session-4', proposed.draftId, '可以', [])
    expect(failed.ok).toBe(false)
    expect(loadAgentPackageDraft(root, 'session-4')?.draftId).toBe(proposed.draftId)
    expect(existsSync(join(agentPackagesRoot(root), 'weekly-report', 'agent.json'))).toBe(false)
  })

  test('repeat commit with the same draftId returns the existing package without overwriting', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-5', createProposal(), [])
    if (!proposed.ok) throw new Error('propose failed')
    const first = await commitAgentPackage(root, 'session-5', proposed.draftId, '可以', [])
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const personaPath = join(agentPackageDir(root, 'weekly-report'), 'persona.md')
    writeFileSync(personaPath, '人工改过的人设', 'utf8')

    const second = await commitAgentPackage(root, 'session-5', proposed.draftId, '可以', [])
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.alreadyCommitted).toBe(true)
    expect(second.packagePath).toBe(first.packagePath)
    expect(readFileSync(personaPath, 'utf8')).toBe('人工改过的人设')
  })

  test('an idempotent commit retry resets publication before deleting the draft', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-retry', createProposal(), [])
    if (!proposed.ok) throw new Error('propose failed')

    // 模拟「包已写入、reset 未跑、草稿仍在」的中断态。
    writeInterruptedCommitPackage(root, proposed.draftId)
    writeAgentPackageState(root, {
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
        submissionId: 'submission-1',
        reviewReason: '旧说明',
        delistRequestId: 'delist-1',
      },
    })

    const retried = await commitAgentPackage(root, 'session-retry', proposed.draftId, '可以', [])
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect(retried.alreadyCommitted).toBe(true)
    expect(existsSync(draftPath(root, 'session-retry'))).toBe(false)

    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.publishStatus).toBe('none')
    expect(state?.submissionId).toBeUndefined()
    expect(state?.reviewReason).toBeUndefined()
    expect(state?.delistRequestId).toBeUndefined()
    expect(state?.publishedVersion).toBe('1.0.0')
    expect(state?.enabled).toBe(true)
  })

  test('keeps the draft when the publication reset fails', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-reset-fail', createProposal(), [])
    if (!proposed.ok) throw new Error('propose failed')
    writeInterruptedCommitPackage(root, proposed.draftId)
    writeAgentPackageState(root, {
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
        submissionId: 'submission-1',
      },
    })

    // 让 reset 的状态写入失败:tmp 路径被目录占住。
    const blocker = `${agentPackageStatePath(root)}.tmp`
    mkdirSync(blocker)

    const retried = await commitAgentPackage(root, 'session-reset-fail', proposed.draftId, '可以', [])
    expect(retried.ok).toBe(false)
    if (retried.ok) return
    expect(retried.error).toContain('发布状态复位失败')
    expect(loadAgentPackageDraft(root, 'session-reset-fail')?.draftId).toBe(proposed.draftId)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('published')
    rmSync(blocker, { recursive: true, force: true })
  })

  test('commit without a draft reports that nothing is pending', async () => {
    const root = makeRoot()
    const committed = await commitAgentPackage(root, 'session-empty', 'missing-draft', '可以', [])
    expect(committed.ok).toBe(false)
    if (committed.ok) return
    expect(committed.error).toMatch(/没有待确认的草稿/)
  })
})

describe('session id guard', () => {
  test('rejects session ids that are not a single path segment', async () => {
    const root = makeRoot()
    for (const sessionId of ['', '..', '../evil', 'nested/session', 'nested\\session', 'dotted..session']) {
      const proposed = await proposeAgentPackage(root, sessionId, createProposal(), [])
      expect(proposed.ok, sessionId).toBe(false)
      if (proposed.ok) continue
      expect(proposed.fieldErrors[0]?.field).toBe('sessionId')
      expect(loadAgentPackageDraft(root, sessionId)).toBeUndefined()
      expect(await cancelAgentPackage(root, sessionId)).toBe(false)
    }
    expect(existsSync(join(agentPackagesRoot(root), '.drafts', '.json'))).toBe(false)
    expect(existsSync(join(root, 'evil.json'))).toBe(false)
  })
})

describe('propose validation', () => {
  test('a proposal without a skill still renders a complete card and writes no skill files', async () => {
    const root = makeRoot()
    const input: AgentPackageProposalInput = {
      mode: 'create',
      displayName: '轻量助手',
      slug: 'plain-helper',
      description: '只做人设',
      persona: '你是轻量助手。',
      tools: 'none',
      skill: null,
    }
    const proposed = await proposeAgentPackage(root, 'session-noskill', input, [])
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    expect(proposed.card.personaSummary).toBe('你是轻量助手。')
    expect(proposed.card.skillSummary).toBe('无专属技能包')
    expect(proposed.cardText).toContain('技能包：无专属技能包')

    const committed = await commitAgentPackage(root, 'session-noskill', proposed.draftId, '可以', [])
    expect(committed.ok).toBe(true)
    const manifest = readManifest(root, 'plain-helper')
    expect(manifest.skill).toBeNull()
    expect(existsSync(join(agentPackageDir(root, 'plain-helper'), 'skill'))).toBe(false)
  })

  test('rejects a SKILL.md frontmatter name that differs from the slug', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(
      root,
      'session-name',
      createProposal({
        skill: { summary: '整理', markdown: '---\nname: other-name\ndescription: x\n---\n正文', scripts: [] },
      }),
      [],
    )
    expect(proposed.ok).toBe(false)
    if (proposed.ok) return
    expect(proposed.fieldErrors.map((error) => error.field)).toContain('skill.name')
  })

  test('rejects a taken slug and a slug that already has a package directory', async () => {
    const root = makeRoot()
    writeUserSkill(root, 'weekly-helper')
    mkdirSync(join(agentPackagesRoot(root), 'existing-agent'), { recursive: true })

    const taken = await proposeAgentPackage(root, 'session-slug-1', createProposal(), ['weekly-report'])
    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.fieldErrors.map((error) => error.field)).toContain('slug')

    const existingDir = await proposeAgentPackage(
      root,
      'session-slug-2',
      createProposal({ slug: 'existing-agent' }),
      [],
    )
    expect(existingDir.ok).toBe(false)
    if (!existingDir.ok) expect(existingDir.fieldErrors.map((error) => error.field)).toContain('slug')
  })

  test('resolves allowSkills and rejects missing, bundled-disabled, and create-agent entries', async () => {
    const root = makeRoot()
    writeUserSkill(root, 'weekly-helper')

    const ok = await proposeAgentPackage(
      root,
      'session-allow-1',
      createProposal({ allowSkills: ['weekly-helper'] }),
      [],
    )
    expect(ok.ok).toBe(true)

    const missing = await proposeAgentPackage(
      root,
      'session-allow-2',
      createProposal({ allowSkills: ['no-such-skill'] }),
      [],
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.fieldErrors.map((error) => error.field)).toContain('allowSkills[0]')

    const forbidden = await proposeAgentPackage(
      root,
      'session-allow-3',
      createProposal({ allowSkills: ['create-agent'] }),
      [],
    )
    expect(forbidden.ok).toBe(false)
    if (!forbidden.ok) {
      expect(forbidden.fieldErrors.map((error) => error.field)).toContain('allowSkills[0]')
      expect(JSON.stringify(forbidden.fieldErrors)).toContain('create-agent')
    }

    const bundled = listBundledSkills().find((skill) => skill.name !== 'explore' && skill.name !== 'test-fix')
    expect(bundled).toBeDefined()
    if (bundled === undefined) return

    // 内置技能缺省关闭:未启用时必须拒绝,启用后才通过。
    const disabled = await proposeAgentPackage(
      root,
      'session-allow-4',
      createProposal({ allowSkills: [bundled.name] }),
      [],
    )
    expect(disabled.ok).toBe(false)
    if (!disabled.ok) expect(JSON.stringify(disabled.fieldErrors)).toContain('disabled')

    setSkillToggle(root, bundled.name, true)
    const enabled = await proposeAgentPackage(
      root,
      'session-allow-5',
      createProposal({ allowSkills: [bundled.name] }),
      [],
    )
    expect(enabled.ok).toBe(true)
  })

  test('rejects a payload whose persona and skill bodies exceed the 64 KiB combined cap', async () => {
    const root = makeRoot()
    writeUserSkill(root, 'big-helper', 'c'.repeat(2048))

    const front = '---\nname: weekly-report\ndescription: 大\n---\n'
    const markdown = `${front}${'b'.repeat(32 * 1024 - Buffer.byteLength(front, 'utf8'))}`
    const persona = 'x'.repeat(32 * 1024)
    const skill = { summary: '大技能', markdown, scripts: [] }

    const tooBig = await proposeAgentPackage(
      root,
      'session-cap-1',
      createProposal({ persona, skill, allowSkills: ['big-helper'] }),
      [],
    )
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) {
      const capError = tooBig.fieldErrors.find((error) => error.field === 'skill')
      expect(capError?.message).toMatch(/64 KiB/)
    }

    const fits = await proposeAgentPackage(
      root,
      'session-cap-2',
      createProposal({ persona, skill, allowSkills: [] }),
      [],
    )
    expect(fits.ok).toBe(true)
  })

  test('counts the whole SKILL.md markdown toward the 64 KiB combined cap', async () => {
    const root = makeRoot()
    writeUserSkill(root, 'tiny-helper', 'c'.repeat(32))

    const front = '---\nname: weekly-report\ndescription: 大\n---\n'
    const markdown = `${front}${'b'.repeat(32 * 1024 - Buffer.byteLength(front, 'utf8'))}`
    const persona = 'x'.repeat(32 * 1024)
    // 只计正文时 frontmatter 的字节余量足以容纳这 32 字节;计整份 SKILL.md 时才超限。
    const proposed = await proposeAgentPackage(
      root,
      'session-skill-full',
      createProposal({
        persona,
        skill: { summary: '大技能', markdown, scripts: [] },
        allowSkills: ['tiny-helper'],
      }),
      [],
    )
    expect(proposed.ok).toBe(false)
    if (proposed.ok) return
    const capError = proposed.fieldErrors.find((error) => error.field === 'skill')
    expect(capError?.message).toMatch(/64 KiB/)
  })

  test('rejects a draft whose files would exceed the 5 MiB whole-package cap', async () => {
    const root = makeRoot()
    const script = 'x'.repeat(256 * 1024)
    const scripts = Array.from({ length: 20 }, (_, index) => ({
      path: `skill/scripts/part-${index}.mjs`,
      content: script,
    }))
    const proposed = await proposeAgentPackage(
      root,
      'session-package-cap',
      createProposal({ skill: { summary: '大脚本', markdown: proposal.skill.markdown, scripts } }),
      [],
    )
    expect(proposed.ok).toBe(false)
    if (proposed.ok) return
    // 逐脚本上限都合法,只有整包字节超限:错误必须落在 package,而不是留给 commit 的写失败。
    expect(proposed.fieldErrors.map((error) => error.field)).not.toContain('skill.scripts')
    const capError = proposed.fieldErrors.find((error) => error.field === 'package')
    expect(capError?.message).toMatch(/5 MiB/)
    expect(loadAgentPackageDraft(root, 'session-package-cap')).toBeUndefined()
  })

  test('a rejected proposal leaves an existing draft byte-identical', async () => {
    const root = makeRoot()
    const first = await proposeAgentPackage(root, 'session-stable-draft', createProposal(), [])
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const before = readFileSync(draftPath(root, 'session-stable-draft'))

    const rejected = await proposeAgentPackage(
      root,
      'session-stable-draft',
      createProposal({ displayName: '   ', description: '' }),
      [],
    )
    expect(rejected.ok).toBe(false)
    expect(readFileSync(draftPath(root, 'session-stable-draft')).equals(before)).toBe(true)
    expect(loadAgentPackageDraft(root, 'session-stable-draft')?.draftId).toBe(first.draftId)
  })

  test('rejects oversized or malformed tool payloads', async () => {
    const root = makeRoot()
    const oversized = await proposeAgentPackage(
      root,
      'session-tools-1',
      createProposal({ tools: 'http', httpServer: 'x'.repeat(256 * 1024 + 1) }),
      [],
    )
    expect(oversized.ok).toBe(false)
    if (!oversized.ok) expect(oversized.fieldErrors.map((error) => error.field)).toContain('httpServer')

    const missing = await proposeAgentPackage(root, 'session-tools-2', createProposal({ tools: 'mcp' }), [])
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.fieldErrors.map((error) => error.field)).toContain('mcpServer')

    const unexpected = await proposeAgentPackage(
      root,
      'session-tools-3',
      createProposal({ httpServer: 'export {}\n' }),
      [],
    )
    expect(unexpected.ok).toBe(false)
    if (!unexpected.ok) expect(unexpected.fieldErrors.map((error) => error.field)).toContain('httpServer')
  })

  test('rejects skill scripts outside skill/scripts or with dot segments', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(
      root,
      'session-scripts',
      createProposal({
        skill: {
          summary: '整理本周工作',
          markdown: proposal.skill.markdown,
          scripts: [{ path: 'skill/scripts/../escape.mjs', content: 'x' }],
        },
      }),
      [],
    )
    expect(proposed.ok).toBe(false)
    if (proposed.ok) return
    expect(proposed.fieldErrors.map((error) => error.field)).toContain('skill.scripts[0]')
  })
})

describe('cancel', () => {
  test('deletes the draft and reports whether one existed', async () => {
    const root = makeRoot()
    const proposed = await proposeAgentPackage(root, 'session-cancel', createProposal(), [])
    expect(proposed.ok).toBe(true)
    expect(existsSync(draftPath(root, 'session-cancel'))).toBe(true)

    expect(await cancelAgentPackage(root, 'session-cancel')).toBe(true)
    expect(existsSync(draftPath(root, 'session-cancel'))).toBe(false)
    expect(loadAgentPackageDraft(root, 'session-cancel')).toBeUndefined()
    expect(await cancelAgentPackage(root, 'session-cancel')).toBe(false)
    expect(listLocalAgentPackages(root)).toEqual([])
  })
})

describe('update mode', () => {
  test('bumps the patch version, merges only provided fields, and preserves enabled', async () => {
    const root = makeRoot()
    const created = await proposeAgentPackage(root, 'session-create', createProposal(), [])
    if (!created.ok) throw new Error('propose failed')
    const committed = await commitAgentPackage(root, 'session-create', created.draftId, '可以', [])
    expect(committed.ok).toBe(true)
    setAgentPackageEnabled(root, 'weekly-report', true)
    const before = readManifest(root, 'weekly-report')

    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    await host.beginUpdate('session-update', 'weekly-report')
    expect(host.hasDraft('session-update')).toBe(true)
    const baseDraft = loadAgentPackageDraft(root, 'session-update')
    expect(baseDraft?.mode).toBe('update')
    expect(baseDraft?.slug).toBe('weekly-report')
    expect(baseDraft?.personaSummary).toBe('你是周报助手。')
    expect(baseDraft?.skillSummary).toBe('整理本周工作')

    const proposed = await proposeAgentPackage(
      root,
      'session-update',
      { mode: 'update', description: '把一周工作整理成一页周报' },
      [],
    )
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    expect(proposed.card.description).toBe('把一周工作整理成一页周报')

    const updated = await commitAgentPackage(root, 'session-update', proposed.draftId, '确认', [])
    expect(updated.ok).toBe(true)

    const manifest = readManifest(root, 'weekly-report')
    expect(manifest.version).toBe('1.0.1')
    expect(manifest.description).toBe('把一周工作整理成一页周报')
    expect(manifest.displayName).toBe('周报小助手')
    expect(manifest.persona).toBe('persona.md')
    expect(manifest.draftId).toBe(proposed.draftId)
    expect(manifest.createdAt).toBe(before.createdAt)
    expect(readFileSync(join(agentPackageDir(root, 'weekly-report'), 'persona.md'), 'utf8')).toBe(
      '你是周报助手。',
    )
    expect(readFileSync(join(agentPackageDir(root, 'weekly-report'), 'skill', 'SKILL.md'), 'utf8')).toBe(
      proposal.skill.markdown,
    )
    expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBe(true)
    expect(existsSync(draftPath(root, 'session-update'))).toBe(false)
  })

  test('an update renders the update title and keeps the enabled-state hint', async () => {
    const root = makeRoot()
    const created = await proposeAgentPackage(root, 'session-update-card-create', createProposal(), [])
    if (!created.ok) throw new Error('propose failed')
    const committed = await commitAgentPackage(root, 'session-update-card-create', created.draftId, '可以', [])
    expect(committed.ok).toBe(true)

    const proposed = await proposeAgentPackage(
      root,
      'session-update-card',
      { mode: 'update', slug: 'weekly-report', description: '把一周工作整理成一页周报' },
      [],
    )
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return

    expect(proposed.card.mode).toBe('update')
    expect(proposed.cardText.split('\n')[0]).toBe('请确认是否更新这名智能体：')
    expect(proposed.cardText).toContain('回复「可以」更新（启用状态保持不变，版本号 patch+1）；回复「取消」放弃。')
    expect(proposed.cardText).not.toContain('请确认是否创建这名智能体')
    expect(proposed.cardText).not.toContain('（默认关闭）')
  })

  test('an update rewrites a script body byte-for-byte', async () => {
    const root = makeRoot()
    const scriptBody = '#!/usr/bin/env node\r\nconsole.log("周报")\r\n// 末尾无换行'
    const created = await proposeAgentPackage(
      root,
      'session-script-create',
      createProposal({
        skill: {
          summary: proposal.skill.summary,
          markdown: proposal.skill.markdown,
          scripts: [{ path: 'skill/scripts/report.mjs', content: scriptBody }],
        },
      }),
      [],
    )
    if (!created.ok) throw new Error('propose failed')
    const committed = await commitAgentPackage(root, 'session-script-create', created.draftId, '可以', [])
    expect(committed.ok).toBe(true)

    const scriptPath = join(agentPackageDir(root, 'weekly-report'), 'skill', 'scripts', 'report.mjs')
    expect(readFileSync(scriptPath, 'utf8')).toBe(scriptBody)

    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    await host.beginUpdate('session-script-update', 'weekly-report')
    const proposed = await proposeAgentPackage(
      root,
      'session-script-update',
      { mode: 'update', description: '把一周工作整理成一页周报' },
      [],
    )
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    const updated = await commitAgentPackage(root, 'session-script-update', proposed.draftId, '确认', [])
    expect(updated.ok).toBe(true)
    expect(readFileSync(scriptPath, 'utf8')).toBe(scriptBody)
  })

  test('refuses to rename a package through an update proposal', async () => {
    const root = makeRoot()
    const created = await proposeAgentPackage(root, 'session-rename-create', createProposal(), [])
    if (!created.ok) throw new Error('propose failed')
    const committed = await commitAgentPackage(root, 'session-rename-create', created.draftId, '可以', [])
    expect(committed.ok).toBe(true)

    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    await host.beginUpdate('session-rename', 'weekly-report')
    const proposed = await proposeAgentPackage(root, 'session-rename', { mode: 'update', slug: 'renamed' }, [])
    expect(proposed.ok).toBe(false)
    if (proposed.ok) return
    expect(proposed.fieldErrors.map((error) => error.field)).toContain('slug')
    expect(listLocalAgentPackages(root).map((item) => item.slug)).toEqual(['weekly-report'])
  })

  test('beginUpdate refuses a missing or broken package', async () => {
    const root = makeRoot()
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    await expect(host.beginUpdate('session-missing', 'no-such-agent')).rejects.toThrow(/不存在/)

    mkdirSync(join(agentPackagesRoot(root), 'broken-agent'), { recursive: true })
    writeFileSync(join(agentPackagesRoot(root), 'broken-agent', 'agent.json'), '{not json', 'utf8')
    await expect(host.beginUpdate('session-broken', 'broken-agent')).rejects.toThrow(/损坏/)
  })
})

describe('host facade', () => {
  test('a broken package can be disabled but not enabled', () => {
    const root = makeRoot()
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    mkdirSync(join(agentPackagesRoot(root), 'broken-agent'), { recursive: true })
    writeFileSync(join(agentPackagesRoot(root), 'broken-agent', 'agent.json'), '{not json', 'utf8')

    host.setEnabled('broken-agent', false)
    expect(host.detail('broken-agent')?.enabled).toBe(false)
    expect(() => host.setEnabled('broken-agent', true)).toThrow(/损坏/)
  })

  test('owns turn text, gates same-turn commits, and exposes the local package surface', async () => {
    const root = makeRoot()
    let taken: readonly string[] = []
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => taken })

    expect(host.lastUserText('session-host')).toBeUndefined()
    host.noteUserText('session-host', '帮我新建一个智能体')
    expect(host.lastUserText('session-host')).toBe('帮我新建一个智能体')
    expect(host.hasDraft('session-host')).toBe(false)
    expect(host.hasDraft('..')).toBe(false)

    const proposed = await host.propose('session-host', createProposal())
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    expect(host.hasDraft('session-host')).toBe(true)

    const sameTurn = await host.commit('session-host', proposed.draftId, '可以')
    expect(sameTurn.ok).toBe(false)
    if (!sameTurn.ok) expect(sameTurn.error).toMatch(/同一轮/)

    host.noteUserText('session-host', '可以')
    expect(host.lastUserText('session-host')).toBe('可以')
    // 生产路径在同一轮还会命中创建/继续创建入口,这里补上标记。
    host.noteCreationTurn('session-host', '可以')
    const committed = await host.commit('session-host', proposed.draftId, '可以')
    expect(committed.ok).toBe(true)
    expect(host.hasDraft('session-host')).toBe(false)
    expect(host.lastUserText('session-host')).toBe('可以')

    expect(host.listLocal().map((item) => item.slug)).toEqual(['weekly-report'])
    expect(host.detail('weekly-report')?.enabled).toBe(false)
    host.setEnabled('weekly-report', true)
    expect(host.detail('weekly-report')?.enabled).toBe(true)
    expect(() => host.setEnabled('no-such-agent', true)).toThrow(/不存在/)

    // takenSlugs 是提供方,每次调用都读当前值。
    const takenLater = createProposal({
      slug: 'taken-later',
      skill: {
        summary: proposal.skill.summary,
        markdown: '---\nname: taken-later\ndescription: x\n---\n正文',
        scripts: [],
      },
    })
    taken = ['taken-later']
    const conflict = await host.propose('session-host-2', takenLater)
    expect(conflict.ok).toBe(false)
    taken = []
    const free = await host.propose('session-host-3', takenLater)
    expect(free.ok).toBe(true)

    expect(await host.cancel('session-host-3')).toBe(true)
    expect(host.hasDraft('session-host-3')).toBe(false)
  })

  test('uses the optional lastUserText callback only as a fallback', async () => {
    const root = makeRoot()
    const host = createAgentPackageHost({
      profileDir: root,
      takenSlugs: () => [],
      lastUserText: (sessionId) => `callback:${sessionId}`,
    })
    expect(host.lastUserText('session-fallback')).toBe('callback:session-fallback')
    host.noteUserText('session-fallback', '可以')
    expect(host.lastUserText('session-fallback')).toBe('可以')
    host.noteUserText('session-fallback', '')
    expect(host.lastUserText('session-fallback')).toBe('')
  })

  test('bounds per-session turn text', () => {
    const root = makeRoot()
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    for (let index = 0; index < 300; index += 1) {
      host.noteUserText(`session-bound-${index}`, `text-${index}`)
    }
    // 上限 256:最早写入的会话被淘汰,较新的仍在;重复写入会把会话移到队尾。
    expect(host.lastUserText('session-bound-43')).toBeUndefined()
    expect(host.lastUserText('session-bound-44')).toBe('text-44')
    expect(host.lastUserText('session-bound-299')).toBe('text-299')
  })
})
