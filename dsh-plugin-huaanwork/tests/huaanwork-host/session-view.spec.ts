import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { detailRecords, decompressZstdFrames, summarizeSessionLog } from '../../src/huaanwork-host/session-view.ts'
import type { SessionSummary } from '../../src/client-huaanwork/rpc-types.ts'

// —— 用例逐字移植自旧 sidecar session-view.test.ts(纯函数段)——

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function sessionLog(entries: Record<string, unknown>[]): string {
  return `${entries.map(line).join('\n')}\n`
}

const T0 = 1_787_907_111_933

const HEADER = {
  type: 'session',
  version: 0,
  id: 'huaanwork-abc123',
  createdAt: T0,
  cwd: '/repo/demo',
  delegationDepth: 0,
}

function userMessage(text: string, seq: number, time: number, source: Record<string, unknown> = { kind: 'user' }) {
  return {
    type: 'user/message',
    seq,
    time,
    surfaceOp: 'append',
    data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source },
  }
}

function assistantMessage(text: string, seq: number, time: number, toolCalls: Record<string, unknown>[] = []) {
  return {
    type: 'assistant/message',
    seq,
    time,
    surfaceOp: 'append',
    data: {
      turn: 0,
      step: 0,
      message: {
        id: `m${seq}`,
        role: 'assistant',
        content: [
          { type: 'text', text },
          ...toolCalls.map((call) => ({ type: 'tool-call', ...call })),
        ],
      },
    },
  }
}

function toolCall(callId: string, name: string, args: Record<string, unknown>, seq: number, time: number) {
  return { type: 'tool/call', seq, time, data: { turn: 0, step: 0, callId, name, arguments: args } }
}

function toolResult(callId: string, text: string, seq: number, time: number, isError = false) {
  return {
    type: 'tool/result',
    seq,
    time,
    surfaceOp: 'append',
    data: {
      turn: 0,
      step: 0,
      message: {
        id: `m${seq}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }],
      },
    },
  }
}

const FULL_LOG = sessionLog([
  HEADER,
  { type: 'turn/start', seq: 1, time: T0 + 3, data: { turn: 0 } },
  userMessage('修复这个仓库里失败的测试', 2, T0 + 4),
  assistantMessage('我先看看测试结构。', 3, T0 + 5, [{ id: 'c1', name: 'bash', arguments: { command: 'npm test' } }]),
  toolCall('c1', 'bash', { command: 'npm test' }, 4, T0 + 6),
  toolResult('c1', '1 failing', 5, T0 + 7, true),
  assistantMessage('修好了，测试全部通过。', 6, T0 + 8),
  { type: 'turn/end', seq: 7, time: T0 + 9, data: { turn: 0, reason: { kind: 'completed' } } },
])

describe('summarizeSessionLog', () => {
  test('derives title from the first user message', () => {
    const summary = summarizeSessionLog(FULL_LOG)
    expect(summary).toBeDefined()
    expect(summary!.id).toBe('huaanwork-abc123')
    expect(summary!.title).toBe('修复这个仓库里失败的测试')
    expect(summary!.cwd).toBe('/repo/demo')
    expect(summary!.createdAt).toBe(HEADER.createdAt)
    expect(summary!.lastTime).toBe(T0 + 9)
    expect(summary!.turnCount).toBe(1)
    // 1 条用户消息 + 2 条有正文的助手消息
    expect(summary!.messageCount).toBe(3)
  })

  test('prefers the last session/title event over the first user message', () => {
    const log = sessionLog([
      HEADER,
      { type: 'turn/start', seq: 1, time: T0 + 3, data: { turn: 0 } },
      userMessage('很长的第一句话', 2, T0 + 4),
      { type: 'session/title', seq: 3, time: T0 + 10, data: { title: '修复失败测试', messageSeqs: [2], source: { kind: 'fallback' } } },
      { type: 'session/title', seq: 4, time: T0 + 11, data: { title: '修复失败测试（更新）', messageSeqs: [2], source: { kind: 'fallback' } } },
    ])
    const summary = summarizeSessionLog(log)
    expect(summary).toBeDefined()
    expect(summary!.title).toBe('修复失败测试（更新）')
    expect(summary!.lastTime).toBe(T0 + 11)
  })

  test('skips plugin/tool injections when picking the title', () => {
    const log = sessionLog([
      HEADER,
      userMessage('[fixture] 上下文注入', 1, T0 + 3, { kind: 'plugin', plugin: 'fixture' }),
      userMessage('真正的任务描述', 2, T0 + 4),
    ])
    const summary = summarizeSessionLog(log)
    expect(summary).toBeDefined()
    expect(summary!.title).toBe('真正的任务描述')
    expect(summary!.messageCount).toBe(1)
  })

  test('falls back to a dated title for header-only logs', () => {
    const summary = summarizeSessionLog(sessionLog([HEADER]))
    expect(summary).toBeDefined()
    const date = new Date(HEADER.createdAt)
    expect(summary!.title).toBe(`未命名 · ${date.getMonth() + 1}月${date.getDate()}日`)
    expect(summary!.messageCount).toBe(0)
    expect(summary!.turnCount).toBe(0)
  })

  test('clips long titles into one line', () => {
    const log = sessionLog([HEADER, userMessage(`${'很长'.repeat(60)}\n第二行`, 1, T0 + 3)])
    const summary = summarizeSessionLog(log)
    expect(summary).toBeDefined()
    expect(summary!.title.length).toBeLessThanOrEqual(81)
    expect(summary!.title.includes('\n')).toBe(false)
    expect(summary!.title.endsWith('…')).toBe(true)
  })

  test('rejects non-session logs and corrupt lines', () => {
    expect(summarizeSessionLog('not json\n')).toBeUndefined()
    expect(summarizeSessionLog(sessionLog([{ type: 'other', id: 'x' }]))).toBeUndefined()
    // 坏行不致命:header 有效即可出摘要
    const summary = summarizeSessionLog(`${line(HEADER)}\n{broken\n`)
    expect(summary).toBeDefined()
    expect(summary!.id).toBe('huaanwork-abc123')
  })

  test('keeps subagent provenance', () => {
    const log = sessionLog([
      { ...HEADER, id: 'child-1', origin: 'subagent', parentSession: 'huaanwork-parent' },
      userMessage('看看这个仓库', 1, T0 + 3),
    ])
    const summary = summarizeSessionLog(log)
    expect(summary).toBeDefined()
    expect(summary!.origin).toBe('subagent')
    expect(summary!.parentSession).toBe('huaanwork-parent')
  })
})

describe('detailRecords', () => {
  test('maps the surface events in log order', () => {
    const records = detailRecords(FULL_LOG)
    expect(records.map((record) => record.kind)).toEqual(['user', 'assistant', 'tool-call', 'tool-result', 'assistant'])
    expect(records[0]).toMatchObject({ kind: 'user', text: '修复这个仓库里失败的测试' })
    expect(records[2]).toMatchObject({ kind: 'tool-call', name: 'bash', callId: 'c1', args: '{"command":"npm test"}' })
    expect(records[3]).toMatchObject({ kind: 'tool-result', callId: 'c1', isError: true, text: '1 failing' })
  })

  test('skips plugin injections and tolerates corrupt lines', () => {
    const log = [
      line(HEADER),
      line(userMessage('[fixture] 注入', 1, T0 + 3, { kind: 'plugin', plugin: 'fixture' })),
      '{corrupt line',
      line(userMessage('正常消息', 2, T0 + 4)),
    ].join('\n')
    const records = detailRecords(log)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'user', text: '正常消息' })
  })

  test('truncates oversized tool results', () => {
    const log = sessionLog([HEADER, toolResult('c1', 'x'.repeat(20_000), 1, T0 + 3)])
    const [record] = detailRecords(log)
    expect(record).toBeDefined()
    expect(record!.kind).toBe('tool-result')
    if (record?.kind !== 'tool-result') throw new Error('expected tool-result record')
    expect(record.text.length).toBeLessThanOrEqual(8_100)
    expect(record.text.endsWith('…（已截断）')).toBe(true)
  })
})

describe('decompressZstdFrames', () => {
  test('decodes concatenated multi-frame logs', () => {
    const frameA = zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'))
    const frameB = zstdCompressSync(Buffer.from('{"type":"user/message","seq":1}\n'))
    const frameC = zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":2}\n'))
    const joined = Buffer.concat([frameA, frameB, frameC])
    const text = decompressZstdFrames(joined)
    expect(text.split('\n').filter(Boolean)).toHaveLength(3)
    expect(text.includes('"user/message"')).toBe(true)
    // 单帧与空缓冲的边界。
    expect(decompressZstdFrames(frameA).includes('"session"')).toBe(true)
    expect(decompressZstdFrames(Buffer.alloc(0))).toBe('')
  })

  test('tolerates a torn trailing frame (log read mid-append)', () => {
    const frameA = zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'))
    const frameB = zstdCompressSync(Buffer.from('{"type":"user/message","seq":1}\n'))
    // 尾帧被截断(写入进行中):只返回完整前缀,不抛错。
    const torn = Buffer.concat([frameA, frameB.subarray(0, Math.max(4, frameB.length - 2))])
    const text = decompressZstdFrames(torn)
    expect(text.includes('"session"')).toBe(true)
    expect(text.includes('user/message')).toBe(false)
  })

  test('rejects non-zstd bytes', () => {
    expect(() => decompressZstdFrames(Buffer.from('not a zstd frame'))).toThrow(/magic/)
  })
})

describe('session.list fixture directory (旧 session-view.test.ts 存储段)', () => {
  let tmpDsh: string

  beforeAll(() => {
    tmpDsh = mkdtempSync(join(tmpdir(), 'huaanwork-view-spec-'))
    mkdirSync(join(tmpDsh, 'sessions', 'repo-a', 'huaanwork-old'), { recursive: true })
    mkdirSync(join(tmpDsh, 'sessions', 'repo-b', 'huaanwork-new'), { recursive: true })
    writeFileSync(
      join(tmpDsh, 'sessions', 'repo-a', 'huaanwork-old', 'session.jsonl'),
      sessionLog([
        { type: 'session', version: 0, id: 'huaanwork-old', createdAt: 1_000, cwd: '/repo/a', delegationDepth: 0 },
        userMessage('旧任务', 1, 1_100),
      ]),
      'utf8',
    )
    writeFileSync(
      join(tmpDsh, 'sessions', 'repo-b', 'huaanwork-new', 'session.jsonl'),
      sessionLog([
        { type: 'session', version: 0, id: 'huaanwork-new', createdAt: 2_000, cwd: '/repo/b', delegationDepth: 0 },
        userMessage('新任务', 1, 2_100),
      ]),
      'utf8',
    )
  })

  afterAll(() => {
    rmSync(tmpDsh, { recursive: true, force: true })
  })

  test('listSessions returns summaries sorted by most recent activity', async () => {
    const { sessionList } = await import('../../src/huaanwork-host/sessions.ts')
    const routeCtx = {
      dshHome: tmpDsh,
      profileDir: tmpDsh,
      workspaceRoot: { current: '/repo' },
      emit: () => undefined,
      logger: () => undefined,
      requestRestart: async () => true,
    }
    const listed = (await sessionList(routeCtx, undefined)) as SessionSummary[]
    expect(listed).toHaveLength(2)
    expect(listed[0]!.id).toBe('huaanwork-new')
    expect(listed[0]!.title).toBe('新任务')
    expect(listed[1]!.id).toBe('huaanwork-old')
    expect(listed[1]!.title).toBe('旧任务')
    // ?root= 过滤(旧 host.ts:981-982 语义)
    const filtered = await sessionList(routeCtx, '/repo/a')
    expect(filtered.map((s) => s.id)).toEqual(['huaanwork-old'])
  })
})
