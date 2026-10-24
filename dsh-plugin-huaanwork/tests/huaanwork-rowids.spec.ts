import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { sessionIdFor } from '../src/huaanwork-host/session-id.ts'
import { neutralWorkspaceRoot, readPendingWorkspaceRoot, writePendingWorkspaceRoot, clearPendingWorkspaceRoot } from '../src/huaanwork-host/workspace-state.ts'
import { assertHuaanworkRowIdsHit, assertPtcPresetPresentation, HUAANWORK_ROW_ASSERTIONS, type RowLike } from '../src/huaanwork-host/row-assertions.ts'

describe('sessionIdFor', () => {
  test('格式 huaanwork-<16hex> 且与同根稳定、异根不同', () => {
    const a = mkdtempSync(join(tmpdir(), 'hw-a-'))
    const b = mkdtempSync(join(tmpdir(), 'hw-b-'))
    expect(sessionIdFor(a)).toBe(`huaanwork-${createHash('sha256').update(resolve(a)).digest('hex').slice(0, 16)}`)
    expect(sessionIdFor(a)).toBe(sessionIdFor(a))
    expect(sessionIdFor(a)).not.toBe(sessionIdFor(b))
  })
})

describe('pendingRoot 生命周期', () => {
  test('缺文件 / 坏 JSON / 清除后均回 null;中立根被创建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-prof-'))
    expect(readPendingWorkspaceRoot(dir)).toBeNull()
    writeFileSync(join(dir, 'huaanwork-workspace.json'), '{broken', 'utf8')
    expect(readPendingWorkspaceRoot(dir)).toBeNull()
    writePendingWorkspaceRoot(dir, '/tmp/somewhere')
    expect(readPendingWorkspaceRoot(dir)).toBe('/tmp/somewhere')
    // clearPendingWorkspaceRoot 是 huaanwork-host 首个 effect 用的别名:与写 null 等价。
    clearPendingWorkspaceRoot(dir)
    expect(readPendingWorkspaceRoot(dir)).toBeNull()
    expect(existsSync(join(dir, 'huaanwork-workspace.json'))).toBe(true)
    const neutral = neutralWorkspaceRoot(dir)
    expect(neutral).toBe(join(dir, 'workspace'))
    expect(existsSync(neutral)).toBe(true)
  })
})

describe('row-id 命中断言', () => {
  const composed = new Map<string, RowLike>()
  for (const a of HUAANWORK_ROW_ASSERTIONS) {
    composed.set(a.id, {
      ...(a.intent === 'disable' ? { disabled: true } : {}),
      config: a.id === 'agent-loop'
        ? { agents: [{ id: 'huaanwork', provider: 'deepseek-official', model: 'local' }] }
        : { ...a.expectConfig },
    })
  }

  test('负例 A:上游已改名的 workflow-worker-thread 必须报 miss', () => {
    expect(() => assertHuaanworkRowIdsHit(composed, [{ id: 'workflow-worker-thread', intent: 'disable' }]))
      .toThrow(/workflow-worker-thread/)
  })

  test('负例 B:随机不存在 id 必须抛', () => {
    expect(() => assertHuaanworkRowIdsHit(composed, [{ id: 'definitely-not-a-real-row', intent: 'disable' }]))
      .toThrow(/guardrail row-id drift/)
  })

  test('负例 C:命中但状态不符(应禁未禁)必须抛', () => {
    const tampered = new Map(composed)
    tampered.set('workflow-ptc', { disabled: false, config: {} })
    expect(() => assertHuaanworkRowIdsHit(tampered)).toThrow(/workflow-ptc: expected disabled/)
  })

  test('负例 D:命中但状态不符(应启被禁)必须抛', () => {
    const tampered = new Map(composed)
    tampered.set('sandbox-policy', { disabled: true, config: { mode: 'workspace-write' } })
    expect(() => assertHuaanworkRowIdsHit(tampered)).toThrow(/sandbox-policy: expected enabled with override/)
  })

  test('正例:修正后的 16 条全命中不抛', () => {
    expect(() => assertHuaanworkRowIdsHit(composed)).not.toThrow()
  })

  test('optional row: 缺失时不抛，存在但未禁用时抛', () => {
    const withoutRalph = new Map(composed)
    withoutRalph.delete('tool-ralph')
    expect(() => assertHuaanworkRowIdsHit(withoutRalph)).not.toThrow()

    const unDisabledRalph = new Map(composed)
    unDisabledRalph.set('tool-ralph', { disabled: false })
    expect(() => assertHuaanworkRowIdsHit(unDisabledRalph)).toThrow(/tool-ralph: expected disabled/)
  })

  test('optional row: 上游改名后的 ralph 行必须报错', () => {
    const renamedRalph = new Map(composed)
    renamedRalph.delete('tool-ralph')
    renamedRalph.set('tool-ralph-v2', { disabled: true })
    expect(() => assertHuaanworkRowIdsHit(renamedRalph)).toThrow(/renamed row/)
  })
})

describe('ptc preset presentation assertion', () => {
  function validPresetRows(): Map<string, RowLike> {
    return new Map<string, RowLike>([
      ['preset-ptc', {
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: 'ptc',
          order: 2,
          plugins: [
            { id: 'persona', name: '@deepseek-ai/dsh-persona' },
            {
              id: 'tool-presentation',
              name: '@deepseek-ai/dsh-agent-tool-presentation',
              disabled: true,
              config: { mode: 'ptc' },
            },
          ],
        },
      }],
    ])
  }

  test('disabled nested presentation passes', () => {
    expect(() => assertPtcPresetPresentation(validPresetRows())).not.toThrow()
  })

  test('re-enabled nested presentation throws', () => {
    const rows = validPresetRows()
    const config = (rows.get('preset-ptc')!.config as { plugins: Array<{ disabled?: boolean }> })
    config.plugins[1]!.disabled = false
    expect(() => assertPtcPresetPresentation(rows)).toThrow(/must stay disabled/)
  })

  test('missing nested presentation row throws', () => {
    const rows = validPresetRows()
    const config = (rows.get('preset-ptc')!.config as { plugins: unknown[] })
    config.plugins.splice(1, 1)
    expect(() => assertPtcPresetPresentation(rows)).toThrow(/tool-presentation row is missing/)
  })

  test('disabled preset throws', () => {
    const rows = validPresetRows()
    rows.get('preset-ptc')!.disabled = true
    expect(() => assertPtcPresetPresentation(rows)).toThrow(/expected enabled/)
  })
})
