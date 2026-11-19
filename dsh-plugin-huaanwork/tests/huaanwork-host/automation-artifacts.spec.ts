/**
 * 自动化终态封套适配器(设计 §6.2 / 计划 Task 3)。
 *
 * 适配器只准备、不提交：断言直接读真实两阶段存储，prepare 后列表仍为空，
 * 只有调用方冻结并 commit 才出现记录。封套校验、兼容 JSON 与 skipped
 * 三种结局各自钉住，坏标记封套不得降级为兼容路径。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { blocksToMarkdown, jsonToBlocks } from '../../src/client-huaanwork/logic/runResultRender.ts'
import { prepareAutomationResult } from '../../src/huaanwork-host/automation-artifacts.ts'
import {
  beginArtifactWrite,
  commitPreparedArtifact,
  discardPreparedArtifact,
  findArtifactByRun,
  listArtifacts,
  readArtifactContent,
  type ArtifactWriteScope,
} from '../../src/huaanwork-host/artifacts-host.ts'

const roots: string[] = []

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function runScope(): ArtifactWriteScope {
  return {
    sessionId: 'session-1',
    anchor: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
  }
}

function envelopeText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: 'huaanwork.task-result',
    title: '季度报告',
    format: 'html',
    content: '<p>完整正文</p>',
    ...overrides,
  })
}

it('prepares a marked envelope without committing or listing it', async () => {
  const root = makeRoot('automation-artifacts-')
  const write = beginArtifactWrite(root, runScope())
  try {
    // 整体 trim 后才是唯一 JSON 文档：前后空白不影响解析。
    const preparation = await prepareAutomationResult(write, `\n  ${envelopeText()}\n`)
    expect(preparation).toEqual({ outcome: 'prepared', title: '季度报告', format: 'html' })
    // prepared 只暴露已校验的 title/format，不携带 content/downloadName。
    expect(Object.keys(preparation).sort()).toEqual(['format', 'outcome', 'title'])
    // 准备阶段不创建最终目录、不进入列表、不产生查询结果。
    expect(await listArtifacts(root, 'session-1')).toEqual([])
    expect(await findArtifactByRun(root, 'automation-1', 'run-1')).toBeUndefined()

    const committed = await commitPreparedArtifact(write)
    expect(committed.created).toBe(true)
    expect(committed.artifact).toMatchObject({ title: '季度报告', format: 'html' })
    expect((await readArtifactContent(root, 'session-1', committed.artifact.artifactId)).toString('utf8'))
      .toBe('<p>完整正文</p>')
  } finally {
    await discardPreparedArtifact(write)
  }
})

it('passes the optional downloadName through the sanitizer', async () => {
  const root = makeRoot('automation-artifacts-name-')
  const write = beginArtifactWrite(root, runScope())
  try {
    const preparation = await prepareAutomationResult(write, envelopeText({ downloadName: '季度:报告.txt' }))
    expect(preparation).toEqual({ outcome: 'prepared', title: '季度报告', format: 'html' })
    const committed = await commitPreparedArtifact(write)
    expect(committed.artifact.downloadName).toBe('季度-报告.html')
  } finally {
    await discardPreparedArtifact(write)
  }
})

it('keeps a plain answer without an envelope skipped', async () => {
  const root = makeRoot('automation-artifacts-plain-')
  const write = beginArtifactWrite(root, runScope())
  try {
    expect(await prepareAutomationResult(write, '本季度经营分析：收入增长 12%。')).toEqual({ outcome: 'skipped' })
    expect(await listArtifacts(root, 'session-1')).toEqual([])
    expect(await findArtifactByRun(root, 'automation-1', 'run-1')).toBeUndefined()
  } finally {
    await discardPreparedArtifact(write)
  }
})

it('does not extract an envelope from surrounding prose or a code fence', async () => {
  const root = makeRoot('automation-artifacts-prose-')
  const write = beginArtifactWrite(root, runScope())
  try {
    expect(await prepareAutomationResult(write, `结果如下：${envelopeText()}`)).toEqual({ outcome: 'skipped' })
    expect(await prepareAutomationResult(write, `\`\`\`json\n${envelopeText()}\n\`\`\``)).toEqual({ outcome: 'skipped' })
    expect(await listArtifacts(root, 'session-1')).toEqual([])
  } finally {
    await discardPreparedArtifact(write)
  }
})

it.each([
  { label: 'an unsupported format', overrides: { format: 'pdf' } },
  { label: 'a wrong schema version', overrides: { schemaVersion: 2 } },
  { label: 'a mismatched type', overrides: { type: 'huaanwork.other' } },
  { label: 'an empty title', overrides: { title: '  ' } },
  { label: 'a multiline title', overrides: { title: '季度\n报告' } },
  { label: 'a non-string content', overrides: { content: { text: 'x' } } },
  { label: 'a non-string downloadName', overrides: { downloadName: 42 } },
])('rejects a marked envelope with $label without title or format', async ({ overrides }) => {
  const root = makeRoot('automation-artifacts-invalid-')
  const write = beginArtifactWrite(root, runScope())
  try {
    const preparation = await prepareAutomationResult(write, envelopeText(overrides))
    expect(preparation).toEqual({ outcome: 'failed', artifactError: 'invalid-result-envelope' })
    expect(await listArtifacts(root, 'session-1')).toEqual([])
  } finally {
    await discardPreparedArtifact(write)
  }
})

it('reports a storage failure for validated content with title and format', async () => {
  const root = makeRoot('automation-artifacts-large-')
  const write = beginArtifactWrite(root, runScope())
  try {
    const preparation = await prepareAutomationResult(write, envelopeText({ content: 'x'.repeat(5 * 1024 * 1024 + 1) }))
    expect(preparation).toEqual({
      outcome: 'failed',
      artifactError: 'artifact-too-large',
      artifactTitle: '季度报告',
      artifactFormat: 'html',
    })
    expect(await listArtifacts(root, 'session-1')).toEqual([])
  } finally {
    await discardPreparedArtifact(write)
  }
})

it('prepares an unmarked JSON object as a markdown artifact', async () => {
  const root = makeRoot('automation-artifacts-object-')
  const value = { 摘要: '完成', 指标: [{ 名称: '收入', 数值: 12 }] }
  const write = beginArtifactWrite(root, runScope())
  try {
    expect(await prepareAutomationResult(write, JSON.stringify(value)))
      .toEqual({ outcome: 'prepared', title: '任务结果', format: 'markdown' })
    const committed = await commitPreparedArtifact(write)
    expect(committed.artifact.format).toBe('markdown')
    expect((await readArtifactContent(root, 'session-1', committed.artifact.artifactId)).toString('utf8'))
      .toBe(blocksToMarkdown(jsonToBlocks(value)))
  } finally {
    await discardPreparedArtifact(write)
  }
})

it('prepares an unmarked JSON array as a markdown table', async () => {
  const root = makeRoot('automation-artifacts-array-')
  const value = [{ 名称: '收入', 数值: 12 }, { 名称: '成本', 数值: 7 }]
  const write = beginArtifactWrite(root, runScope())
  try {
    expect(await prepareAutomationResult(write, JSON.stringify(value)))
      .toEqual({ outcome: 'prepared', title: '任务结果', format: 'markdown' })
    const committed = await commitPreparedArtifact(write)
    expect((await readArtifactContent(root, 'session-1', committed.artifact.artifactId)).toString('utf8'))
      .toBe(blocksToMarkdown(jsonToBlocks(value)))
  } finally {
    await discardPreparedArtifact(write)
  }
})

it.each([
  { label: 'a JSON string', text: '"纯文本"' },
  { label: 'a JSON number', text: '42' },
  { label: 'JSON null', text: 'null' },
  { label: 'an empty answer', text: '   ' },
])('skips $label instead of building a compatibility document', async ({ text }) => {
  const root = makeRoot('automation-artifacts-scalar-')
  const write = beginArtifactWrite(root, runScope())
  try {
    expect(await prepareAutomationResult(write, text)).toEqual({ outcome: 'skipped' })
    expect(await listArtifacts(root, 'session-1')).toEqual([])
  } finally {
    await discardPreparedArtifact(write)
  }
})
