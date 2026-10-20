import { describe, expect, test } from 'vitest'
import type { UnattendedHolder, UnattendedScope } from '../../src/huaanwork-guardrails/policy.ts'

// 编译期钉：本文件在 tests/huaanwork-host/ 下，由 tsconfig.tests.json 覆盖
// （tests/huaanwork-guardrails/ 整个目录被排除在 typecheck 之外），所以下面四个赋值
// 由 `corepack yarn workspace dsh-plugin-huaanwork typecheck` 真实检查。
//
// 要钉的契约：holders.ts 装容器的初始值就是 `{ current: null }`（既不是 undefined
// 也不是缺席），旧调用方还可以根本不写 `current`。把 policy.ts 的
// `current?: UnattendedScope | null` 收窄回非 nullable（或删掉 `?`）时，对应的赋值
// 会在 typecheck 里报错——运行时用例（policy.cordis.spec.ts）跑得过不代表类型如实。
const bootSlot: UnattendedHolder = { current: null }
const absentSlot: UnattendedHolder = {}
const scope: UnattendedScope = { runId: 'run-1', automationId: 'auto-1', allow: new Set(['read']) }
const filledSlot: UnattendedHolder = { current: scope }

describe('UnattendedHolder 的类型契约', () => {
  test('boot 空槽、缺席 current 与已填槽三种形态都保持可赋值且语义不变', () => {
    // 运行时只是把上面几个常量用掉（noUnusedLocals），真正的断言发生在 typecheck。
    expect(bootSlot.current).toBeNull()
    expect(absentSlot).toEqual({})
    expect(filledSlot.current).toBe(scope)
  })
})
