import { rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDesktopProfile } from '../src/profile.ts'
import { DESKTOP_MARKET_IDENTITIES } from '../src/desktop-market.ts'

// M5 Task 0 组合顺序断言(§13 风险,round3 R5 按层判据):
// provider 层 patches 并入(profile.ts 的 providerPatches 分支)必须先于
// guardrail 锁层 push——应用写锁必须在第三方 market bundle 之后生效
// (spec §6 第 2 条,后层覆盖用户安装 bundle)。market row 的正确落位是 providerPatches
// 分支,塞进 guardrail 锁 insert 块 = 反转分层。
// Task 4 已把真实 `huaanwork-market` row 接入组合:正例对真实组合输出断言
// (provider 层先于锁层);负例继续用注入 fixture 构造「market row 出现在锁层
// 之后/夹进锁层中段」,按设计恒红(守卫函数自身的负例覆盖)。

/** Minimal structural view of one composed patch entry. */
interface CompositionPatch {
  id?: string
  insert?: ReadonlyArray<{ id?: string; name?: string }>
}

/**
 * Guardrail 锁层 patch 的 id'd 行(profile.ts 锁层 push 逐字)——守卫按这份
 * 清单识别锁层;改锁行 id 必须同步这里(守卫会红)。`user-questions` 已重新启用,
 * 不再属于锁层。
 * 锁层 shell 跟随 process.platform,因为 profile 的 shell 补丁读的是它;prepareDesktopProfile 的 'darwin' 参数不改变这一行。
 */
const GUARDRAIL_LOCK_IDS: ReadonlySet<string> = new Set([
  'llm-deepseek',
  'approval',
  'tools',
  'agent-loop',
  'tool-fs',
  'tool-fs-search',
  process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash',
  'plan-mode',
  'tool-todo',
  'hmr',
  'jobs',
  'tool-jobs',
  'web',
  'web-search-deepseek',
  'tool-web',
  'workflow-ptc',
  'tool-workflow',
  'tool-ralph',
  'fs-sandbox',
  'sandbox-policy',
])

/** Task 4 落地的 canonical market row(DESKTOP_MARKET_IDENTITIES 第四成员)。 */
const HUAANWORK_MARKET_ROW = Object.freeze({
  id: DESKTOP_MARKET_IDENTITIES.huaanworkMarket.rowId,
  name: DESKTOP_MARKET_IDENTITIES.huaanworkMarket.packageName,
})

function isGuardrailFinalInsert(patch: CompositionPatch): boolean {
  // 锁层最后的 insert 块(huaanwork-host 行是锁层专有,普通 bundle 不会插它)。
  return Array.isArray(patch.insert)
    && patch.insert.some(row => row.id === 'huaanwork-host')
}

function isGuardrailLockPatch(patch: CompositionPatch): boolean {
  if (typeof patch.id === 'string' && GUARDRAIL_LOCK_IDS.has(patch.id)) return true
  return isGuardrailFinalInsert(patch)
}

function isMarketProviderPatch(patch: CompositionPatch): boolean {
  if (!Array.isArray(patch.insert)) return false
  return patch.insert.some(row =>
    // 现行 community/dshmarket canonical row + Task 4 的 huaanwork-market row。
    row.id === DESKTOP_MARKET_IDENTITIES.community.rowId
    || row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId
    || row.id === HUAANWORK_MARKET_ROW.id
    || row.name === HUAANWORK_MARKET_ROW.name)
}

interface MarketCompositionOrder {
  readonly lockLayerStart: number
  readonly lockLayerSize: number
  readonly marketPatchCount: number
}

/**
 * 按层判据断言组合顺序(round3 R5):
 * 1. guardrail 锁层必须从 `llm-deepseek` 锚点(自尾向头扫,锁层专有锚点)起
 *    **连续**铺 GUARDRAIL_LOCK_IDS 全量 + 收尾 insert 块——锁层内夹带任何非锁
 *    patch 即分层被插穿(对应「market row 误塞 guardrail 锁 insert 块」的反转);
 * 2. 一切 market provider row(providerPatches 分支产物)必须落在锁层锚点之前。
 * 锁层之后还允许有 Desktop 应用写 config 层(settings/web-runtime/ui-* 行等,
 * profile.ts:1024 起)——那是 M1 既成事实,不属本断言范围;本断言只钉
 * 「provider 层 patches 并入先于 guardrail 锁 push」这条 market 面不变量。
 *
 * 注意:Web 模板 bundle/profile patches 的 insert 行与 patch id 大量复用
 * `tools`/`agent-loop`/`web` 等锁层 id(实测组合前段即出现),故锁层识别必须用
 * 锁层专有锚点(llm-deepseek id'd patch),不能「首个锁 id 命中即锁层起点」。
 */
function assertMarketCompositionOrder(patches: readonly CompositionPatch[]): MarketCompositionOrder {
  const anchor = lockLayerAnchor(patches)
  let lockLayerSize = 0
  for (let index = anchor; index < patches.length; index += 1) {
    if (!isGuardrailLockPatch(patches[index] ?? {})) break
    lockLayerSize += 1
  }
  if (lockLayerSize !== GUARDRAIL_LOCK_IDS.size + 1) {
    throw new Error(
      `guardrail lock layer must be contiguous (${String(GUARDRAIL_LOCK_IDS.size)} lock rows + closing insert block); `
        + `interleaved or truncated at index ${String(anchor + lockLayerSize)}`,
    )
  }
  for (let index = 0; index < patches.length; index += 1) {
    if (isMarketProviderPatch(patches[index] ?? {}) && index >= anchor) {
      // P18:报错文案只描述判据本身——`index >= anchor` 抓的是「market row 落在
      // 锁层锚点之后(锁层内或更晚)」,不宣称它一定**落在锁层内部**(组合尾部
      // 的 insert 块同样命中)。
      throw new Error(
        `market provider row at index ${String(index)} is not before the guardrail lock layer start index ${String(anchor)}; `
          + 'provider-layer patches must merge before the guardrail lock layer',
      )
    }
  }
  let marketPatchCount = 0
  for (const patch of patches) {
    if (isMarketProviderPatch(patch)) marketPatchCount += 1
  }
  return { lockLayerStart: anchor, lockLayerSize, marketPatchCount }
}

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-market-composition-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function lockLayerAnchor(patches: readonly CompositionPatch[]): number {
  for (let index = patches.length - 1; index >= 0; index -= 1) {
    if (patches[index]?.id === 'llm-deepseek') return index
  }
  throw new Error('composition is missing the guardrail lock layer (llm-deepseek anchor)')
}

describe('market composition order (provider layer before guardrail lock layer)', () => {
  it('keeps the guardrail lock layer contiguous in the real composition', () => {
    const home = temporaryHome()

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const patches = prepared.patches as CompositionPatch[]
    const order = assertMarketCompositionOrder(patches)

    expect(prepared.market.effective).toBe('disabled')
    // 默认 disabled:无 market row;锁层连续 19 项(18 个 id'd 行 + 1 个 insert 块),
    // 其后是 Desktop 应用写 config 层(settings 等,profile.ts:1024 起)——非本断言范围。
    expect(order.marketPatchCount).toBe(0)
    expect(order.lockLayerSize).toBe(GUARDRAIL_LOCK_IDS.size + 1)
    expect(order.lockLayerStart + order.lockLayerSize).toBeLessThan(patches.length)
    expect(patches[order.lockLayerStart + order.lockLayerSize]?.id).not.toBe('huaanwork-host')
  })

  it('merges the community provider row before the guardrail lock layer', () => {
    const home = temporaryHome()

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: DESKTOP_MARKET_IDENTITIES.community.provider,
      effective: DESKTOP_MARKET_IDENTITIES.community.provider,
      legacyDefaulted: false,
    })
    expect(prepared.market.effective).toBe(DESKTOP_MARKET_IDENTITIES.community.provider)

    const patches = prepared.patches as CompositionPatch[]
    const providerInsertIndex = patches.findIndex(patch => Array.isArray(patch.insert)
      && patch.insert.some(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId))
    expect(providerInsertIndex).not.toBe(-1)

    const order = assertMarketCompositionOrder(patches)
    expect(order.marketPatchCount).toBe(1)
    expect(providerInsertIndex).toBeLessThan(order.lockLayerStart)
  })

  it('merges the huaanwork-market provider row before the guardrail lock layer', () => {
    const home = temporaryHome()

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: DESKTOP_MARKET_IDENTITIES.huaanworkMarket.provider,
      effective: DESKTOP_MARKET_IDENTITIES.huaanworkMarket.provider,
      legacyDefaulted: false,
    })
    expect(prepared.market.effective).toBe(DESKTOP_MARKET_IDENTITIES.huaanworkMarket.provider)
    expect(prepared.marketFailure).toBeUndefined()

    const patches = prepared.patches as CompositionPatch[]
    const providerInsertIndex = patches.findIndex(patch => Array.isArray(patch.insert)
      && patch.insert.some(row => row.id === DESKTOP_MARKET_IDENTITIES.huaanworkMarket.rowId))

    const order = assertMarketCompositionOrder(patches)
    expect(providerInsertIndex).not.toBe(-1)
    expect(order.marketPatchCount).toBe(1)
    expect(providerInsertIndex).toBeLessThan(order.lockLayerStart)
  })

  it('rejects an injected fixture whose market row is spliced into the lock layer, truncating it', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const realPatches = prepared.patches as CompositionPatch[]
    const anchor = lockLayerAnchor(realPatches)

    // 注入 fixture:`slice(0, anchor + 2)` 只切到**锁层第 2 行**为止(锁层前段的
    // llm-deepseek + approval),随后直接追加 market row insert 块——该块因此落在
    // 锁层**内部**(锁层第 3 项位置),其后 15 个锁行全部缺失 ⇒ 命中的是
    // 「锁层必须连续」判据,不是尾置 insert 块、也不是「塞进锁层之后的落位」。
    const fixture = [
      ...realPatches.slice(0, anchor + 2),
      { insert: [{ id: HUAANWORK_MARKET_ROW.id, name: HUAANWORK_MARKET_ROW.name }] },
    ]

    expect(() => assertMarketCompositionOrder(fixture)).toThrow(/guardrail lock layer/u)
  })

  it('rejects an injected fixture whose market row is appended at the composition tail, after the lock layer', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const realPatches = prepared.patches as CompositionPatch[]
    const anchor = lockLayerAnchor(realPatches)
    const finalInsertIndex = realPatches.length - 1
    expect(anchor).toBeLessThan(finalInsertIndex)

    // 注入 fixture:market row 作为独立 insert 块插在**组合末位之前**(finalInsertIndex
    // = 真实组合最后一项的下标)——此时锁层与桌面写 config 层都已铺完、锁层本身仍连续,
    // 命中的是「market row 未落在锁层锚点之前」的分层反转判据(round3 R5),不是锁层中段。
    const fixture = [
      ...realPatches.slice(0, finalInsertIndex),
      { insert: [{ id: HUAANWORK_MARKET_ROW.id, name: HUAANWORK_MARKET_ROW.name }] },
      realPatches[finalInsertIndex] ?? {},
    ]

    expect(() => assertMarketCompositionOrder(fixture)).toThrow(/guardrail lock layer/u)
  })

  /**
   * P18(Task 6.9):上面两根负例的注释/标题与报错文案曾写 `landed in the guardrail
   * lock layer`,与其 fixture 构造(① 锁层被截断;② 落在组合尾部的 insert 块)不符。
   * 断言逻辑不动,只钉措辞:被测字符串在测试内以分片拼接,故断言只对被测源码生效。
   */
  it('P18: the negative-case comments and error copy match the fixtures they describe', () => {
    const source = readFileSync(join(import.meta.dirname, 'market-composition-order.spec.ts'), 'utf8')
    expect(source).not.toContain(['landed in the', 'guardrail lock layer'].join(' '))
    expect(source).toContain(['is not before the', 'guardrail lock layer start index'].join(' '))
    expect(source).toContain(['spliced into the', 'lock layer'].join(' '))
    expect(source).toContain(['appended at the composition', 'tail'].join(' '))
  })
})
