import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isOneSided, filterDirOneSided, verifyDesktopVariants } from './verify-desktop-variants.mjs'

test('isOneSided: 支持 Set 和 Array 类型的 oneSidedPaths', () => {
  const path = 'src/client-huaanwork/api.ts'
  // Set
  assert.equal(isOneSided(path, new Set([path]), []), true)
  assert.equal(isOneSided('src/other.ts', new Set([path]), []), false)
  // Array
  assert.equal(isOneSided(path, [path], []), true)
  assert.equal(isOneSided('src/other.ts', [path], []), false)
  // 非 Set 非 Array (如 null, undefined, 对象) 兜底为 false
  assert.equal(isOneSided(path, null, []), false)
  assert.equal(isOneSided(path, undefined, []), false)
  assert.equal(isOneSided(path, {}, []), false)
})

test('isOneSided: 精确路径与前缀匹配及未命中场景 (含负向用例)', () => {
  const oneSidedPaths = ['src/custom.ts']
  const prefixes = ['src/client-huaanwork/', 'scripts/gen-']

  // 精确路径命中 (Set 与 Array)
  assert.equal(isOneSided('src/custom.ts', new Set(oneSidedPaths), prefixes), true)
  assert.equal(isOneSided('src/custom.ts', oneSidedPaths, prefixes), true)

  // 前缀命中 (Array 与 Set)
  assert.equal(isOneSided('src/client-huaanwork/component.tsx', [], prefixes), true)
  assert.equal(isOneSided('scripts/gen-icons.mjs', [], new Set(prefixes)), true)

  // 负向用例: 不以前缀开头或未声明路径
  assert.equal(isOneSided('src/profile.ts', oneSidedPaths, prefixes), false)
  assert.equal(isOneSided('other/src/client-huaanwork/component.tsx', oneSidedPaths, prefixes), false)
  assert.equal(isOneSided('scripts/verify-win-portable.ts', oneSidedPaths, prefixes), false)

  // 边界用例: 空路径或空集合
  assert.equal(isOneSided('', [], []), false)
  assert.equal(isOneSided('src/any.ts', [], []), false)
})

test('filterDirOneSided: 多目录与单目录场景下 oneSidedPaths 过滤与前缀剥离', () => {
  const multiDirs = ['src', 'scripts']
  const paths = ['src/only-huaanwork.ts', 'scripts/gen-spec.mjs', 'src/sub/helper.ts']

  // 多目录: dir = 'src' 仅保留 src/ 前缀并剥离
  const srcFiltered = filterDirOneSided(paths, 'src', multiDirs)
  assert.deepEqual(srcFiltered, ['only-huaanwork.ts', 'sub/helper.ts'])

  // 多目录: dir = 'scripts' 仅保留 scripts/ 前缀并剥离
  const scriptsFiltered = filterDirOneSided(paths, 'scripts', multiDirs)
  assert.deepEqual(scriptsFiltered, ['gen-spec.mjs'])

  // 多目录: 支持 Set 作为输入
  assert.deepEqual(
    filterDirOneSided(new Set(paths), 'src', multiDirs),
    ['only-huaanwork.ts', 'sub/helper.ts']
  )

  // 单目录: 裸文件名保留
  assert.deepEqual(
    filterDirOneSided(['only-huaanwork.ts'], 'src', ['src']),
    ['only-huaanwork.ts']
  )

  // 单目录: 带目录前缀时正确剥离
  assert.deepEqual(
    filterDirOneSided(['src/only-huaanwork.ts'], 'src', ['src']),
    ['only-huaanwork.ts']
  )

  // 边界: 空输入或未匹配项
  assert.deepEqual(filterDirOneSided([], 'src', multiDirs), [])
  assert.deepEqual(filterDirOneSided(['other/file.ts'], 'src', multiDirs), [])
})

test('verifyDesktopVariants: 统计计数与差异检测 (单测模拟 fixture)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vtest-'))
  try {
    mkdirSync(join(tmp, 'left', 'src'), { recursive: true })
    mkdirSync(join(tmp, 'right', 'src'), { recursive: true })
    mkdirSync(join(tmp, 'right', 'src', 'client-huaanwork'), { recursive: true })

    // shared aligned file
    writeFileSync(join(tmp, 'left', 'src', 'common.ts'), 'export const x = 1\n')
    writeFileSync(join(tmp, 'right', 'src', 'common.ts'), 'export const x = 1\n')

    // allowed difference
    writeFileSync(join(tmp, 'left', 'src', 'identity.ts'), 'export const id = "beta"\n')
    writeFileSync(join(tmp, 'right', 'src', 'identity.ts'), 'export const id = "huaanwork"\n')

    // one-sided file matching prefix
    writeFileSync(join(tmp, 'right', 'src', 'client-huaanwork', 'api.ts'), 'export const api = {}\n')

    // 验证: 1 个 shared aligned, 1 个 allowed diff, 1 个 oneSidedPrefix; summary 显示 1 files
    const mockPairs = [
      {
        name: 'test-pair',
        left: 'left',
        right: 'right',
        dirs: ['src'],
        normalize: s => s,
        allowedDifferences: ['src/identity.ts'],
        oneSidedPaths: [],
        oneSidedPrefixes: ['src/client-huaanwork/'],
      },
    ]

    const summary = verifyDesktopVariants(mockPairs, tmp)
    assert.deepEqual(summary, ['test-pair src (1 files)'])

    // 负向: 若 oneSided 文件非法出现在 left, 必须报错
    mkdirSync(join(tmp, 'left', 'src', 'client-huaanwork'), { recursive: true })
    writeFileSync(join(tmp, 'left', 'src', 'client-huaanwork', 'api.ts'), 'leak!\n')
    assert.throws(() => verifyDesktopVariants(mockPairs, tmp), /must exist only in right/)

    // 恢复
    rmSync(join(tmp, 'left', 'src', 'client-huaanwork'), { recursive: true })

    // 负向: 若存在未声明的内容差异, 必须报错
    writeFileSync(join(tmp, 'left', 'src', 'common.ts'), 'export const x = 999\n')
    assert.throws(() => verifyDesktopVariants(mockPairs, tmp), /Desktop variant source drift is not declared/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('verify-desktop-variants: 当前仓库实跑全绿,三通道摘要在位', () => {
  const out = execFileSync(process.execPath, ['scripts/verify-desktop-variants.mjs'], {
    // 用 import.meta.dirname 而非 new URL(...).pathname:后者对含非 ASCII 字符的
    // 仓库路径返回百分号编码串,会让 spawnSync 因 cwd 不存在而 ENOENT。
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  })
  assert.match(out, /stable↔beta src \(\d+ files\)/)
  assert.match(out, /beta↔huaanwork src \(\d+ files\)/)
  assert.match(out, /beta↔huaanwork scripts \(\d+ files\)/)
})

test('pins the beta↔huaanwork divergence budget so growth is always explicit', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'verify-desktop-variants.mjs'), 'utf8')
  const pairStart = source.indexOf("name: 'beta↔huaanwork'")
  assert.notStrictEqual(pairStart, -1, 'the beta↔huaanwork pair must exist')
  const pair = source.slice(pairStart)

  // allowedDifferences:恰好 22。正则要求 src/ 或 scripts/ 前缀,故 stable↔beta
  // 那对的裸文件名条目('product-identity.ts' 等)不会被误计——但 pairStart 的
  // 切片本身也已把它们排除在外。
  const allowedStart = pair.indexOf('allowedDifferences: [')
  const allowedEnd = pair.indexOf('oneSidedPrefixes: [')
  assert.ok(allowedStart !== -1 && allowedEnd > allowedStart, 'both budget blocks must exist in order')
  const entries = new Set(
    [...pair.slice(allowedStart, allowedEnd).matchAll(/'(?:src|scripts)\/[^']+'/gu)].map(m => m[0]),
  )
  assert.strictEqual(entries.size, 22, `allowedDifferences must hold exactly 22 entries, found ${String(entries.size)}`)

  // 负向钉扎:profile-channel-admission.ts 不得占额。它的和解已下沉到 profile-checkpoint.ts
  // (已在册 #18),该文件必须保持三包逐字节相同。守卫「允许差异而非要求差异」,故超额
  // 预登记不会报红——只能靠这条负例拦住僵尸额度回潮(Global Constraint 2)。
  assert.ok(
    !entries.has("'src/profile-channel-admission.ts'"),
    'profile-channel-admission.ts must not hold a whitelist slot; the injection design was voided on 2026-09-28',
  )

  // oneSidedPrefixes:恰好 6,且顺序固定(顺序是既有约定,打乱会让 diff 噪音掩盖真实增删)。
  const prefixEnd = pair.indexOf(']', allowedEnd)
  const prefixEntries = [...pair.slice(allowedEnd, prefixEnd).matchAll(/'[^']+'/gu)].map(m => m[0])
  assert.deepStrictEqual(prefixEntries, [
    "'src/client-huaanwork/'",
    "'src/huaanwork-host/'",
    "'src/huaanwork-guardrails/'",
    "'src/huaanwork-migration/'",
    "'scripts/gen-'",
    "'scripts/huaanwork-'",
  ])
})

