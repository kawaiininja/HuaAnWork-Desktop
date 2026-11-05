import { describe, expect, test } from 'vitest'
import type { UnattendedHolder, UnattendedScope } from '../../src/huaanwork-guardrails/policy.ts'

// 编译期钉：本文件在 tests/huaanwork-host/ 下，由 tsconfig.tests.json 覆盖
// （tests/huaanwork-guardrails/ 整个目录被排除在 typecheck 之外），所以下面几行
// 由 `corepack yarn workspace dsh-plugin-huaanwork typecheck` 真实检查。
//
// 要钉的契约：holders.ts 装的初始值就是一张空 `Map`（既不是 `{ current: null }`
// 也不是 `undefined`），无人值守范围按会话 id 作为键写入。把 `UnattendedHolder`
// 改回单槽容器（`.current`）或收窄键/值类型时，下面的赋值会在 typecheck 里报错——
// 运行时用例（policy.cordis.spec.ts）跑得过不代表类型如实。
const emptySlot: UnattendedHolder = new Map()
const scope: UnattendedScope = { runId: 'run-1', automationId: 'auto-1', allow: new Set(['read']) }
const filledSlot: UnattendedHolder = new Map([['session-1', scope]])

describe('UnattendedHolder 的按会话契约', () => {
  test('空表与按会话写入两种形态都保持可赋值，且其它会话查不到', () => {
    // 运行时只是把上面几个常量用掉（noUnusedLocals），真正的断言发生在 typecheck。
    expect(emptySlot.size).toBe(0)
    expect(filledSlot.get('session-1')).toBe(scope)
    expect(filledSlot.get('session-2')).toBeUndefined()
    filledSlot.delete('session-1')
    expect(filledSlot.size).toBe(0)
  })
})
