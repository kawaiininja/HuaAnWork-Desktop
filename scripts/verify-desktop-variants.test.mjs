import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isOneSided, filterDirOneSided, verifyDesktopVariants, normalizeIdentity, PAIRS } from './verify-desktop-variants.mjs'

// A commented-out allowlist entry is a comment line whose payload is only a
// quoted path. A quoted path inside a prose comment is not an entry: the old
// scan matched allowedDifferences.has('src/product-identity.ts') inside the
// semantic note and, after de-duplicating, still reported the live count.
function commentedAllowlistEntries(block) {
  const entries = []
  for (const line of block.split('\n')) {
    const match = /^\s*\/\/\s*'((?:src\/|scripts\/)?[\w.@/*-]+\.(?:ts|tsx|mjs|js|ps1))'\s*,?\s*$/u.exec(line)
    if (match) entries.push(match[1])
  }
  return entries
}

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
  assert.match(out, /stable↔beta allowlist 9 \(oneSidedPrefixes 0\)/)
  assert.match(out, /beta↔huaanwork allowlist 24 \(oneSidedPrefixes 6\)/)
})

test('pins the beta↔huaanwork divergence budget so growth is always explicit', () => {
  const pair = PAIRS.find(candidate => candidate.name === 'beta↔huaanwork')
  assert.ok(pair, 'the beta↔huaanwork pair must exist')

  assert.strictEqual(
    pair.allowedDifferences.length,
    24,
    `beta↔huaanwork allowedDifferences must hold exactly 24 entries, found ${String(pair.allowedDifferences.length)}`,
  )
  assert.strictEqual(
    new Set(pair.allowedDifferences).size,
    24,
    'beta↔huaanwork allowedDifferences must not contain duplicates',
  )
  assert.deepStrictEqual(pair.oneSidedPrefixes, [
    'src/client-huaanwork/',
    'src/huaanwork-host/',
    'src/huaanwork-guardrails/',
    'src/huaanwork-migration/',
    'scripts/gen-',
    'scripts/huaanwork-',
  ])

  // M8 Task 2.4:三条上游新增脚本在 huaanwork 单侧不存在(只在 left/beta)。
  // allowedDifferences 本身**不带方向**,一旦 huaanwork 长出同名文件也会被静默吞掉,
  // 所以在白名单之外补一条方向性强制 —— 与 stable↔beta 的 scriptsOneSided 同一解法
  // (M6 盲区)。若将来 huaanwork 真的接入了 Linux 发行流水线或改用上游图标导出器,
  // 这条断言会红,提示把名额从 allowedDifferences 撤掉,而不是让漂移无声固化。
  const betaOnlyScripts = [
    'scripts/package-linux.ts',
    'scripts/verify-linux-artifacts.ts',
    'scripts/generate-windows-app-icon.mjs',
  ]
  for (const entry of betaOnlyScripts) {
    assert.ok(
      pair.allowedDifferences.includes(entry),
      `${entry} must stay registered as an allowed difference`,
    )
    const relative = entry.slice('scripts/'.length)
    assert.ok(
      existsSync(resolve(import.meta.dirname, '..', pair.left, 'scripts', relative)),
      `${entry} must exist in ${pair.left}/scripts/ (otherwise the slot is a zombie)`,
    )
    assert.ok(
      !existsSync(resolve(import.meta.dirname, '..', pair.right, 'scripts', relative)),
      `${entry} is beta-only; it must not appear in ${pair.right}/scripts/`,
    )
  }

  assert.ok(
    !pair.allowedDifferences.includes('src/profile-channel-admission.ts'),
    'profile-channel-admission.ts must not hold a whitelist slot; the injection design was voided on 2026-09-28',
  )

  for (const entry of pair.allowedDifferences) {
    assert.match(
      entry,
      /^(?:src|scripts)\//u,
      `beta↔huaanwork allowedDifferences entry must be dir-prefixed, found ${entry}`,
    )
  }

  const source = readFileSync(resolve(import.meta.dirname, 'verify-desktop-variants.mjs'), 'utf8')
  const pairStart = source.indexOf("name: 'beta↔huaanwork'")
  assert.notStrictEqual(pairStart, -1, 'the beta↔huaanwork pair must exist in source')
  const block = source.slice(pairStart, source.indexOf('oneSidedPrefixes: [', pairStart))
  assert.deepStrictEqual(
    commentedAllowlistEntries(block),
    [],
    'a prose comment that quotes a path is not an allowlist entry',
  )
})

test('pin scan does not treat a quoted path inside a comment as an entry', () => {
  const block = [
    "      // allowedDifferences.has('src/product-identity.ts') 恒为 false。",
    "      // see scripts/verify-win-installer.ts for the absorbed spelling",
    "      // 'src/ghost.ts',",
    "      'src/real.ts',",
  ].join('\n')
  assert.deepStrictEqual(commentedAllowlistEntries(block), ['src/ghost.ts'])

  const source = readFileSync(resolve(import.meta.dirname, 'verify-desktop-variants.mjs'), 'utf8')
  assert.match(source, /allowedDifferences\.has\('src\/product-identity\.ts'\)/)
  assert.deepStrictEqual(commentedAllowlistEntries(source), [])
})

test('zombie slot guard: every registered exemption is an active difference', () => {
  const zombies = []

  for (const pair of PAIRS) {
    for (const [field, entries] of [
      ['allowedDifferences', pair.allowedDifferences ?? []],
      ['oneSidedPrefixes', pair.oneSidedPrefixes ?? []],
    ]) {
      entries.forEach((entry, index) => {
        const mutated = PAIRS.map(candidate => {
          if (candidate.name !== pair.name) return candidate
          const next = { ...candidate }
          next[field] = candidate[field].filter((_, position) => position !== index)
          return next
        })
        let threw = false
        try {
          verifyDesktopVariants(mutated)
        } catch {
          threw = true
        }
        if (!threw) zombies.push(`[${pair.name}] ${field}[${String(index)}] = ${entry}`)
      })
    }
  }

  assert.deepStrictEqual(
    zombies,
    [],
    `zombie whitelist slots detected (removing them keeps the guard green):\n- ${zombies.join('\n- ')}`,
  )
})

test('no allowedDifferences entry is commented out in either pair', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'verify-desktop-variants.mjs'), 'utf8')
  const offenders = []
  for (const pair of PAIRS) {
    const start = source.indexOf(`name: '${pair.name}'`)
    assert.notStrictEqual(start, -1, `pair ${pair.name} must exist in source`)
    const end = source.indexOf('oneSidedPrefixes: [', start)
    const block = source.slice(start, end === -1 ? undefined : end)
    for (const entry of commentedAllowlistEntries(block)) {
      offenders.push(`[${pair.name}] ${entry}`)
    }
  }
  assert.deepStrictEqual(offenders, [], `commented-out whitelist entries found:\n- ${offenders.join('\n- ')}`)
})

test('pins the stable↔beta baseline and enforces its one-sided scripts (M6 blindspot)', () => {
  const pair = PAIRS.find(candidate => candidate.name === 'stable↔beta')
  assert.ok(pair, 'the stable↔beta pair must exist')
  assert.deepStrictEqual(pair.dirs, ['src', 'scripts'])

  assert.deepStrictEqual(pair.oneSidedPrefixes, [])
  assert.strictEqual(
    pair.allowedDifferences.length,
    9,
    `stable↔beta allowedDifferences must hold exactly 9 entries, found ${String(pair.allowedDifferences.length)}`,
  )

  // M8 Task 2.4:此前 7 条(as-of 827e53fc03),现 6 条(as-of a50a8c4f70,即下方
  // scriptsOneSided 的长度)。上游 350 提交把 generate-windows-app-icon.mjs 也放进了
  // beta(合并前 fork 侧只有 stable 有),合并后两侧逐字节相同 ⇒ 该条既不再单侧、也不再
  // 是差异,已从 allowedDifferences 撤除(见下方正向钉)。方向性强制对其余 6 条仍然生效。
  const scriptsOneSided = [
    'scripts/build-windows-nsis-ab.ts',
    'scripts/inspect-windows-installed-app.ts',
    'scripts/probe-windows-packaged-runtime.ts',
    'scripts/run-windows-nsis-ab.ps1',
    'scripts/verify-nsis-ab-prepackaged.ts',
    'scripts/windows-nsis-ab.ts',
  ]
  for (const entry of scriptsOneSided) {
    assert.ok(
      pair.allowedDifferences.includes(entry),
      `${entry} must stay registered as an allowed difference`,
    )
  }

  for (const entry of scriptsOneSided) {
    const relative = entry.slice('scripts/'.length)
    assert.ok(
      !existsSync(resolve(import.meta.dirname, '..', pair.right, 'scripts', relative)),
      `${entry} is a stable-only script; it must not appear in ${pair.right}/scripts/`,
    )
    assert.ok(
      existsSync(resolve(import.meta.dirname, '..', pair.left, 'scripts', relative)),
      `${entry} must exist in ${pair.left}/scripts/ (otherwise the slot is a zombie)`,
    )
  }

  // M8 Task 2.4 正向钉:记录被上游推翻的那条前提的**新**事实,防止无声回退。
  // generate-windows-app-icon.mjs 现在两侧都在、逐字节相同,因此既不占 allowedDifferences
  // 名额,也不受单侧强制约束。任一半边变化(一侧被删,或两侧开始分叉)都必须让本钉变红,
  // 由人来决定是重新登记名额还是把分叉消掉。
  const sharedIconScript = 'generate-windows-app-icon.mjs'
  const stableIcon = resolve(import.meta.dirname, '..', pair.left, 'scripts', sharedIconScript)
  const betaIcon = resolve(import.meta.dirname, '..', pair.right, 'scripts', sharedIconScript)
  assert.ok(existsSync(stableIcon), `${sharedIconScript} must exist in ${pair.left}/scripts/`)
  assert.ok(existsSync(betaIcon), `${sharedIconScript} must exist in ${pair.right}/scripts/ (upstream layout since the M8 merge)`)
  assert.strictEqual(
    readFileSync(stableIcon, 'utf8'),
    readFileSync(betaIcon, 'utf8'),
    `${sharedIconScript} is byte-identical across stable and beta; if it ever diverges, register the difference explicitly instead of leaving it undeclared`,
  )
  assert.ok(
    !pair.allowedDifferences.includes(`scripts/${sharedIconScript}`),
    `scripts/${sharedIconScript} must not hold a whitelist slot while the two sides are identical (zombie budget)`,
  )

  for (const file of ['generate-tray-icons.mjs', 'verify-packaged-runtime.ts']) {
    const left = readFileSync(resolve(import.meta.dirname, '..', pair.left, 'scripts', file), 'utf8')
    const right = readFileSync(resolve(import.meta.dirname, '..', pair.right, 'scripts', file), 'utf8')
    assert.strictEqual(left, right, `${file} is shared behavior and must stay byte-identical`)
    assert.ok(
      !pair.allowedDifferences.includes(`scripts/${file}`),
      `scripts/${file} must not hold a whitelist slot while the two sides are identical`,
    )
  }

  for (const file of ['verify-linux-artifacts.ts', 'verify-win-installer.ts', 'verify-win-portable.ts']) {
    const left = readFileSync(resolve(import.meta.dirname, '..', pair.left, 'scripts', file), 'utf8')
    const right = readFileSync(resolve(import.meta.dirname, '..', pair.right, 'scripts', file), 'utf8')
    assert.notStrictEqual(left, right, `${file} still spells the edition name differently`)
    assert.strictEqual(
      normalizeIdentity(left, 'stable↔beta'),
      normalizeIdentity(right, 'stable↔beta'),
      `${file} differs only by identity and must not return to the allowlist`,
    )
    assert.ok(!pair.allowedDifferences.includes(`scripts/${file}`))
  }
})

test('beta↔huaanwork artifact-name templates are identity, not allowlist entries', () => {
  const pair = PAIRS.find(candidate => candidate.name === 'beta↔huaanwork')
  assert.ok(pair)
  for (const file of ['verify-win-installer.ts', 'verify-win-portable.ts']) {
    const left = readFileSync(resolve(import.meta.dirname, '..', pair.left, 'scripts', file), 'utf8')
    const right = readFileSync(resolve(import.meta.dirname, '..', pair.right, 'scripts', file), 'utf8')
    assert.notStrictEqual(left, right)
    assert.strictEqual(normalizeIdentity(left, 'beta↔huaanwork'), normalizeIdentity(right, 'beta↔huaanwork'))
    assert.ok(
      !pair.allowedDifferences.includes(`scripts/${file}`),
      `scripts/${file} is an identity spelling and must not hold a slot`,
    )
  }
})
