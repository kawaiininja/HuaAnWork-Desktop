import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { capToolOutput } from '@huaanwork/policy/truncate'
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
  // 真实日志把 arguments 序列化成 JSON 字符串(@deepseek-ai/dsh-session 的 tool/call 事件)。
  return { type: 'tool/call', seq, time, data: { turn: 0, step: 0, callId, name, arguments: JSON.stringify(args) } }
}

function toolResult(callId: string, text: string, seq: number, time: number, isError = false) {
  // 真实 v4 日志:结果是 role "tool" 的消息,文本在消息自己的 content 里,
  // callId 与 isError 位于消息顶层。
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
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
      },
    },
  }
}

function turnEnd(kind: string, seq: number, time: number) {
  return { type: 'turn/end', seq, time, data: { turn: 0, reason: { kind } } }
}

/** 修复/调度器写入的合成 tool/result:消息 isError 为 true,错误码在 data.error 上。 */
function syntheticToolResult(callId: string, code: string, text: string, seq: number, time: number) {
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
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: true,
      },
      error: { name: 'AbortError', code },
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

  test('still parses the legacy nested tool-result block', () => {
    // 旧日志形状:结果是 role "user" 的消息,文本与 isError 都在内嵌 tool-result 块里,
    // callId 只出现在 source.callId 上(没有消息级 toolCallId)。
    const log = sessionLog([
      HEADER,
      toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
      {
        type: 'tool/result',
        seq: 2,
        time: T0 + 4,
        surfaceOp: 'append',
        data: {
          turn: 0,
          step: 0,
          message: {
            id: 'm2',
            role: 'user',
            source: { kind: 'tool', callId: 'c1' },
            content: [
              { type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: '1 failing' }] },
            ],
          },
        },
      },
    ])
    const record = detailRecords(log).find((entry) => entry.kind === 'tool-result')
    expect(record).toMatchObject({ kind: 'tool-result', callId: 'c1', isError: true, text: '1 failing' })
  })

  test('resolves the callId from the message toolCallId before source.callId', () => {
    // 消息同时带 toolCallId 与 source.callId 时,marker 判定必须用前者键到的工具名:
    // 用 source.callId 会键到 read 而不是 shell,失败标记就丢了。
    const log = sessionLog([
      HEADER,
      toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
      toolCall('c-other', 'read', { path: 'a.md' }, 2, T0 + 4),
      {
        type: 'tool/result',
        seq: 3,
        time: T0 + 5,
        surfaceOp: 'append',
        data: {
          turn: 0,
          step: 0,
          message: {
            id: 'm3',
            role: 'tool',
            source: { kind: 'tool', callId: 'c-other' },
            toolCallId: 'c1',
            content: [{ type: 'text', text: '1 failing\n[exit code: 1]' }],
            isError: false,
          },
        },
      },
    ])
    const record = detailRecords(log).find((entry) => entry.kind === 'tool-result')
    expect(record).toMatchObject({ kind: 'tool-result', callId: 'c1', isError: true })
  })

  test('retains goal continuation metadata without dropping the read-only user record', () => {
    const records = detailRecords(sessionLog([
      HEADER,
      userMessage('原始目标', 1, T0 + 3),
      userMessage('官方续轮提示', 2, T0 + 4, { kind: 'goal', goalId: 'g', round: 2 }),
    ]))
    expect(records).toEqual([
      { kind: 'user', time: T0 + 3, text: '原始目标', clientMessageId: 'm1' },
      // goal 续轮不是新的用户回合:不带 clientMessageId。
      { kind: 'user', time: T0 + 4, text: '官方续轮提示', goalRound: 2 },
    ])
  })

  test('passes the persisted message id through and drops non-human user messages', () => {
    const log = sessionLog([
      HEADER,
      userMessage('真实任务', 1, T0 + 3),
      userMessage('子代理完成', 2, T0 + 4, { kind: 'subagent-settled' }),
      userMessage('运行时上下文', 3, T0 + 5, { kind: 'runtime-context' }),
      userMessage('指令注入', 4, T0 + 6, { kind: 'agent-instructions' }),
      userMessage('技能目录', 5, T0 + 7, { kind: 'skill-catalog' }),
      userMessage('技能调用', 6, T0 + 8, { kind: 'skill-invocation' }),
      userMessage('问题回复', 7, T0 + 9, { kind: 'user-question-reply' }),
      userMessage('审批回执', 8, T0 + 10, { kind: 'user-approval' }),
      userMessage('工作目录', 9, T0 + 11, { kind: 'working-directory' }),
      userMessage('压缩检查点', 10, T0 + 12, { kind: 'compact-checkpoint' }),
      userMessage('插件注入', 11, T0 + 13, { kind: 'plugin', plugin: 'fixture' }),
      userMessage('工具消息', 12, T0 + 14, { kind: 'tool' }),
      // 旧日志:没有 source.kind 的真实用户消息仍按普通用户放行(没有可透传的 data.id)。
      { type: 'user/message', seq: 13, time: T0 + 15, data: { role: 'user', content: [{ type: 'text', text: '旧夹具无 source' }] } },
    ])
    expect(detailRecords(log)).toEqual([
      { kind: 'user', time: T0 + 3, text: '真实任务', clientMessageId: 'm1' },
      { kind: 'user', time: T0 + 15, text: '旧夹具无 source' },
    ])
    const summary = summarizeSessionLog(log)
    expect(summary).toBeDefined()
    expect(summary!.title).toBe('真实任务')
    expect(summary!.messageCount).toBe(2)
  })

  test('drops goal continuations without a positive round', () => {
    const log = sessionLog([
      HEADER,
      userMessage('缺少轮次', 1, T0 + 3, { kind: 'goal' }),
      userMessage('零轮次', 2, T0 + 4, { kind: 'goal', round: 0 }),
    ])
    expect(detailRecords(log)).toEqual([])
  })

  test('clears the current turn anchor when a subsequent ordinary user message lacks an id or text', () => {
    const todoArgs = { todos: [{ content: '步骤一', status: 'in_progress' }] }
    const log = sessionLog([
      HEADER,
      userMessage('回合一', 1, T0 + 3),
      toolCall('c1', 'todo_write', todoArgs, 2, T0 + 4),
      // 普通用户消息缺 id:后续 todo_write 不得继承回合一的 m1 锚点。
      { type: 'user/message', seq: 3, time: T0 + 5, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '回合二无id' }] } },
      toolCall('c2', 'todo_write', todoArgs, 4, T0 + 6),
      userMessage('回合三', 5, T0 + 7),
      // 普通用户消息缺文本:同样开启新回合且清空旧锚点。
      { type: 'user/message', seq: 6, time: T0 + 8, data: { role: 'user', source: { kind: 'user' }, content: [] } },
      toolCall('c3', 'todo_write', todoArgs, 7, T0 + 9),
    ])
    const todos = detailRecords(log).filter(
      (record): record is Extract<typeof record, { kind: 'tool-call' }> =>
        record.kind === 'tool-call' && record.name === 'todo_write',
    )
    expect(todos).toHaveLength(3)
    expect(todos[0]?.clientMessageId).toBe('m1')
    expect(todos[1]?.clientMessageId).toBeUndefined()
    expect(todos[2]?.clientMessageId).toBeUndefined()
  })

  test('keeps the shell command on tool-call records and never invents an exit code', () => {
    const log = sessionLog([
      HEADER,
      toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
      toolCall('c2', 'pwsh', { command: 'Get-ChildItem' }, 2, T0 + 4),
      toolCall('c3', 'write', { command: 'ignored', path: 'a.md' }, 3, T0 + 5),
      toolResult('c1', 'ok', 4, T0 + 6),
    ])
    const records = detailRecords(log)
    expect(records[0]).toMatchObject({ kind: 'tool-call', name: 'bash', command: 'pnpm test' })
    expect(records[1]).toMatchObject({ kind: 'tool-call', name: 'pwsh', command: 'Get-ChildItem' })
    expect(records[2]).not.toHaveProperty('command')
    expect(records[3]).not.toHaveProperty('exitCode')
  })

  test('reads the real JSON-string arguments shape and shows it as JSON once', () => {
    const log = sessionLog([
      HEADER,
      {
        type: 'tool/call',
        seq: 1,
        time: T0 + 3,
        data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"pnpm test"}' },
      },
    ])
    const [record] = detailRecords(log)
    expect(record).toMatchObject({
      kind: 'tool-call',
      name: 'bash',
      callId: 'c1',
      command: 'pnpm test',
      args: '{"command":"pnpm test"}',
    })
  })

  test('does not double-encode a log that stores an already-parsed object', () => {
    const log = sessionLog([
      HEADER,
      {
        type: 'tool/call',
        seq: 1,
        time: T0 + 3,
        data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' } },
      },
    ])
    const [record] = detailRecords(log)
    expect(record).toMatchObject({ kind: 'tool-call', command: 'pnpm test', args: '{"command":"pnpm test"}' })
  })

  test('keeps structured todos from object-shaped todo_write arguments with the ordinary user anchor', () => {
    const log = sessionLog([
      HEADER,
      userMessage('规划实施', 1, T0 + 3),
      {
        type: 'tool/call',
        seq: 2,
        time: T0 + 4,
        data: {
          turn: 0,
          step: 0,
          callId: 't1',
          name: 'todo_write',
          arguments: { todos: [
            { content: '分析', status: 'completed' },
            { content: '实施', status: 'in_progress' },
            { content: '验证', status: 'pending' },
          ] },
        },
      },
    ])
    const records = detailRecords(log)
    expect(records[0]).toEqual({ kind: 'user', time: T0 + 3, text: '规划实施', clientMessageId: 'm1' })
    const call = records[1]
    if (call?.kind !== 'tool-call') throw new Error('expected tool-call record')
    expect(call).toMatchObject({ name: 'todo_write', callId: 't1', clientMessageId: 'm1' })
    expect(call.todos).toEqual([
      { content: '分析', status: 'completed' },
      { content: '实施', status: 'in_progress' },
      { content: '验证', status: 'pending' },
    ])
  })

  test('decodes long JSON-string todo_write arguments instead of the truncated display args', () => {
    // 真实 JSONL 日志把 arguments 存成 JSON 字符串;展示用 args 在 200 字符处截断,
    // 结构化的 todos 必须从原始字符串解码,不能从截断 args 恢复。
    const todos = [
      { content: '分析第一阶段的目标与边界', status: 'completed' },
      { content: '分析第一阶段的验收条件', status: 'completed' },
      { content: '实施第一阶段的改造与回归验证', status: 'in_progress' },
      { content: '验证第一阶段的真实日志、回放与证据', status: 'pending' },
    ]
    const log = sessionLog([
      HEADER,
      userMessage('规划实施', 1, T0 + 3),
      toolCall('t1', 'todo_write', { todos }, 2, T0 + 4),
    ])
    const records = detailRecords(log)
    const call = records[1]
    if (call?.kind !== 'tool-call') throw new Error('expected tool-call record')
    expect(JSON.stringify({ todos }).length).toBeGreaterThan(200)
    expect(call.args?.endsWith('…')).toBe(true)
    expect(call.todos).toEqual(todos)
    expect(call.clientMessageId).toBe('m1')
  })

  test('anchors continued todo_write to the original ordinary user across completion notices', () => {
    const log = sessionLog([
      HEADER,
      userMessage('修好构建', 1, T0 + 3),
      userMessage('子代理完成', 2, T0 + 4, { kind: 'subagent-settled' }),
      userMessage('运行时上下文', 3, T0 + 5, { kind: 'runtime-context' }),
      userMessage('指令注入', 4, T0 + 6, { kind: 'agent-instructions' }),
      userMessage('技能目录', 5, T0 + 7, { kind: 'skill-catalog' }),
      { type: 'step/start', seq: 6, time: T0 + 8, data: { turn: 0, step: 0 } },
      toolCall('t1', 'todo_write', { todos: [{ content: '复现', status: 'completed' }] }, 7, T0 + 9),
      toolResult('t1', 'updated', 8, T0 + 10),
      {
        type: 'user/message',
        seq: 9,
        time: T0 + 11,
        surfaceOp: 'append',
        data: {
          id: 'mg',
          role: 'user',
          content: [{ type: 'text', text: '官方续轮提示' }],
          source: { kind: 'goal', goalId: 'g', round: 1 },
        },
      },
      { type: 'step/start', seq: 10, time: T0 + 12, data: { turn: 1, step: 0 } },
      toolCall('t2', 'todo_write', { todos: [{ content: '复现', status: 'completed' }, { content: '修复', status: 'in_progress' }] }, 11, T0 + 13),
    ])
    const records = detailRecords(log)
    // 完成通知落盘后仍只有 1 条普通用户回合;goal 续轮记录保持 goalRound,不是新用户。
    expect(records.filter((record) => record.kind === 'user' && record.goalRound === undefined)).toEqual([
      { kind: 'user', time: T0 + 3, text: '修好构建', clientMessageId: 'm1' },
    ])
    expect(records.filter((record) => record.kind === 'user').map((record) => (
      record.kind === 'user' ? [record.text, record.goalRound, record.clientMessageId] : []
    ))).toEqual([
      ['修好构建', undefined, 'm1'],
      ['官方续轮提示', 1, undefined],
    ])
    const todoCalls = records.filter((record) => record.kind === 'tool-call' && record.name === 'todo_write')
    expect(todoCalls.map((record) => (record.kind === 'tool-call' ? [record.clientMessageId, record.roundKey] : []))).toEqual([
      ['m1', 6],
      ['m1', 10],
    ])
  })

  test('reads failure markers from the uncapped result so a clipped head cannot hide them', () => {
    const tail = `${'x'.repeat(40_000)}\n[exit code: 1]`
    const log = sessionLog([
      HEADER,
      toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
      toolResult('c1', tail, 2, T0 + 4),
      toolCall('c2', 'read', { path: 'a.md' }, 3, T0 + 5),
      toolResult('c2', 'file mentions\n[exit code: 1]', 4, T0 + 6),
      toolCall('c3', 'bash', { command: 'pnpm lint' }, 5, T0 + 7),
      toolResult('c3', 'fine\n[exit code: 0]', 6, T0 + 8),
    ])
    const results = detailRecords(log).filter((record) => record.kind === 'tool-result')
    expect(results[0]).toMatchObject({ isError: true })
    expect((results[0] as { text: string }).text.endsWith('[exit code: 1]')).toBe(true)
    // 尾部已保留标记时不再重复追加。
    expect((results[0] as { text: string }).text.split('[exit code: 1]')).toHaveLength(2)
    expect(results[1]).toMatchObject({ isError: false })
    expect(results[2]).toMatchObject({ isError: false })
  })

  test('re-attaches a failure marker that truncation dropped from the middle', () => {
    // 标记位于被截掉的中段:头尾都保留,只有未截断解析能看到它,随后补回一次。
    const middleMarker = `${'x'.repeat(20_000)}\n[exit code: 1]\n${'y'.repeat(20_000)}`
    const log = sessionLog([
      HEADER,
      toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
      toolResult('c1', middleMarker, 2, T0 + 4),
    ])
    const record = detailRecords(log).find((entry) => entry.kind === 'tool-result')
    expect(record).toMatchObject({ kind: 'tool-result', truncated: true, isError: true })
    if (record?.kind !== 'tool-result') throw new Error('expected tool-result record')
    expect(record.text.split('[exit code: 1]')).toHaveLength(2)
    expect(record.text.startsWith('x')).toBe(true)
    expect(record.text).toContain('y')
    // 截断标记必须在（只留头尾而没有标记就不是同一种形状）。
    expect(record.text).toContain('…（已截断）')
  })

  test('caps history results in UTF-8 bytes so CJK output is not cut at the old character budget', () => {
    // 9002 个字符 / 27012 字节:旧的 8000 字符与 8000 字节上限都会截断,32 KiB 字节上限完整保留。
    const retained = `开头${'汉'.repeat(9000)}结尾`
    const [kept] = detailRecords(sessionLog([HEADER, toolResult('c1', retained, 1, T0 + 3)]))
    if (kept?.kind !== 'tool-result') throw new Error('expected tool-result record')
    expect(kept).toMatchObject({ truncated: false })
    expect(kept.text).toBe(retained)

    // 12003 个字符 / 36003 字节:按字节判定才截断;中文头部和尾部都保留。
    const oversized = `${'汉'.repeat(12_000)}尾`
    const [cut] = detailRecords(sessionLog([HEADER, toolResult('c1', oversized, 1, T0 + 3)]))
    if (cut?.kind !== 'tool-result') throw new Error('expected tool-result record')
    expect(cut.text.startsWith('汉')).toBe(true)
    expect(cut.text.endsWith('尾')).toBe(true)
    expect(cut.text).toContain('…（已截断）')
    // 上限与形状直接对齐实时桥的 capToolOutput 默认值（历史侧不再另写 32 KiB）。
    expect(cut.text).toBe(capToolOutput(oversized, '').text)
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

  test('places a reasoning block ahead of the assistant text from the same message', () => {
    const log = sessionLog([
      HEADER,
      {
        type: 'assistant/message',
        seq: 1,
        time: T0 + 5,
        surfaceOp: 'append',
        data: {
          turn: 0,
          step: 0,
          message: {
            id: 'm1',
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '先看文件' },
              { type: 'text', text: '好的' },
            ],
          },
        },
      },
    ])
    const records = detailRecords(log)
    expect(records.map((record) => record.kind)).toEqual(['thinking', 'assistant'])
    expect(records[0]).toMatchObject({ kind: 'thinking', time: T0 + 5, text: '先看文件' })
    expect(records[1]).toMatchObject({ kind: 'assistant', time: T0 + 5, text: '好的' })
  })

  test('truncates oversized tool results with the live head+tail shape', () => {
    const log = sessionLog([HEADER, toolResult('c1', `HEAD${'x'.repeat(40_000)}TAIL`, 1, T0 + 3)])
    const [record] = detailRecords(log)
    expect(record).toBeDefined()
    expect(record!.kind).toBe('tool-result')
    if (record?.kind !== 'tool-result') throw new Error('expected tool-result record')
    // 与实时桥一致:保留头、尾和中间的截断标记,而不是只留头。
    expect(record!.text.startsWith('HEAD')).toBe(true)
    expect(record!.text.endsWith('TAIL')).toBe(true)
    expect(record!.text).toContain('…（已截断）')
    expect(record!.text).toBe(capToolOutput(`HEAD${'x'.repeat(40_000)}TAIL`, '').text)
  })

  test('classifies synthetic outcome-unknown by the turn end reason', () => {
    const synthetic = 'The tool call was interrupted after it was recorded, but no result was durably recorded.'
    for (const kind of ['aborted', 'error']) {
      const records = detailRecords(sessionLog([
        HEADER,
        toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
        syntheticToolResult('c1', 'TOOL_OUTCOME_UNKNOWN', synthetic, 2, T0 + 4),
        turnEnd(kind, 3, T0 + 5),
      ]))
      expect(records.find((record) => record.kind === 'tool-result')).toMatchObject({
        synthetic: 'interrupted',
        isError: true,
      })
    }

    const crashed = detailRecords(sessionLog([
      HEADER,
      toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
      syntheticToolResult('c1', 'TOOL_OUTCOME_UNKNOWN', synthetic, 2, T0 + 4),
      turnEnd('interrupted', 3, T0 + 5),
    ]))
    expect(crashed.find((record) => record.kind === 'tool-result')).toMatchObject({
      synthetic: 'resultMissing',
      isError: true,
    })
  })

  test('drops synthetic not-started and aborted-before-dispatch records entirely', () => {
    const notStarted = detailRecords(sessionLog([
      HEADER,
      syntheticToolResult('c1', 'TOOL_NOT_STARTED', 'The tool call was interrupted before the Harness recorded it as started.', 1, T0 + 3),
      turnEnd('interrupted', 2, T0 + 4),
    ]))
    expect(notStarted).toEqual([])

    const skipped = detailRecords(sessionLog([
      HEADER,
      toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
      syntheticToolResult('c1', 'ABORTED_BEFORE_DISPATCH', 'Error: tool call aborted before dispatch', 2, T0 + 4),
      turnEnd('aborted', 3, T0 + 5),
    ]))
    expect(skipped).toEqual([])
  })

  test('keeps real aborted and timeout results as real failures', () => {
    for (const code of ['ABORTED', 'TOOL_TIMEOUT']) {
      const records = detailRecords(sessionLog([
        HEADER,
        toolCall('c1', 'bash', { command: 'pnpm test' }, 1, T0 + 3),
        syntheticToolResult('c1', code, 'Error: tool call aborted', 2, T0 + 4),
        turnEnd('aborted', 3, T0 + 5),
      ]))
      const result = records.find((record) => record.kind === 'tool-result')
      expect(result).toMatchObject({ isError: true })
      expect(result?.synthetic).toBeUndefined()
    }
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

test('detailRecords stamps roundKey from the governing step/start seq', () => {
  const log = sessionLog([
    HEADER,
    { type: 'turn/start', seq: 1, time: T0 + 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: T0 + 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 3, time: T0 + 3, data: { content: [{ type: 'text', text: '问题' }] } },
    {
      type: 'assistant/message', seq: 4, time: T0 + 4,
      data: { message: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '答' }] }, stream: [] },
    },
    { type: 'tool/call', seq: 5, time: T0 + 5, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'step/start', seq: 6, time: T0 + 6, data: { turn: 1, step: 2 } },
    { type: 'tool/call', seq: 7, time: T0 + 7, data: { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{}' } },
  ])
  const records = detailRecords(log)
  expect(records.find((r) => r.kind === 'thinking')).toMatchObject({ kind: 'thinking', roundKey: 2 })
  expect(records.find((r) => r.kind === 'assistant')).toMatchObject({ kind: 'assistant', roundKey: 2 })
  const calls = records.filter((r) => r.kind === 'tool-call')
  expect(calls[0]).toMatchObject({ kind: 'tool-call', roundKey: 2 })
  expect(calls[1]).toMatchObject({ kind: 'tool-call', roundKey: 6 })
})

test('detailRecords omits roundKey when the log has no step/start', () => {
  const log = sessionLog([
    HEADER,
    { type: 'tool/call', seq: 1, time: T0 + 1, data: { callId: 'c1', name: 'read', arguments: '{}' } },
  ])
  const call = detailRecords(log).find((r) => r.kind === 'tool-call')
  expect(call).toBeDefined()
  expect(Object.hasOwn(call as object, 'roundKey')).toBe(false)
})
