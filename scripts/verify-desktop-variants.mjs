import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

// oneSided 判定:huaanwork-only 的文件必须显式声明——精确路径放 oneSidedPaths,
// 整目录/整前缀放 oneSidedPrefixes(以前缀字符串 endsWith('/') 或子串语义匹配)。
export function isOneSided(path, oneSidedPaths = [], oneSidedPrefixes = []) {
  const hasExact = oneSidedPaths instanceof Set
    ? oneSidedPaths.has(path)
    : Array.isArray(oneSidedPaths)
      ? oneSidedPaths.includes(path)
      : false
  if (hasExact) return true
  const prefixes = Array.isArray(oneSidedPrefixes)
    ? oneSidedPrefixes
    : (oneSidedPrefixes instanceof Set ? [...oneSidedPrefixes] : [])
  return prefixes.some((prefix) => path.startsWith(prefix))
}

export function filterDirOneSided(oneSidedPaths, dir, dirs = [dir]) {
  const paths = oneSidedPaths instanceof Set || Array.isArray(oneSidedPaths)
    ? [...oneSidedPaths]
    : []
  return paths
    .filter((p) => dirs.length === 1 || p.startsWith(`${dir}/`))
    .map((p) => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p))
}

const PAIRS = [
  {
    name: 'stable↔beta',
    left: 'dsh-plugin-desktop',
    right: 'dsh-plugin-desktop-beta',
    dirs: ['src'],
    normalize: s => s
      .replaceAll('dsh-plugin-desktop-beta', 'dsh-plugin-desktop')
      .replaceAll('DSH Desktop Beta', 'DSH Desktop'),
    allowedDifferences: [
      'product-identity.ts',
      // Beta rides dsh 0.1.6-alpha.2, whose runArgv fuses confinement preparation into the
      // execution deadline and returns { result, spawnRequested }; stable stays on
      // 0.1.5-rc.2, whose override takes an argv array and returns ShellRunResult.
      'windows-pwsh-sandbox.ts',
      // dsh 0.1.6-alpha.2 dropped the profile patch-reload policy: `patchReload` is gone from
      // ProfileTemplate, Profile, and the profile manifest, `initProfile` takes two arguments,
      // and reload is owned by the `hmr` entry in a profile's cordis.patch.yml instead. Beta
      // follows that API; stable stays on 0.1.5-rc.2, where the field still exists.
      'profile.ts',
      'profile-manager.ts',
    ],
    oneSidedPaths: [],
    oneSidedPrefixes: [],
  },
  {
    name: 'beta↔huaanwork',
    left: 'dsh-plugin-desktop-beta',
    right: 'dsh-plugin-huaanwork',
    // M2 起覆盖 scripts/(M1 评审 P1:stable 的 scripts/ 漂移对守卫完全隐形)。
    // 注意:beta↔huaanwork 的 scripts/ 在 M1 末态**并非**逐字节对齐——
    // scripts/verify-win-portable.ts 的 portable 制品名是合法差异,已在下方登记。
    dirs: ['src', 'scripts'],
    normalize: s => s
      .replaceAll('dsh-plugin-huaanwork', 'dsh-plugin-desktop-beta')
      .replaceAll('HuaAnWork', 'DSH Desktop Beta'),
    allowedDifferences: [
      // 多目录配对一律带目录前缀(见下方语义说明 1);裸文件名会导致
      // allowedDifferences.has('src/product-identity.ts') 恒为 false。
      'src/product-identity.ts',
      'src/index.ts',
      'src/profile.ts',
      'src/client/index.ts',
      // huaanwork 的 portable 制品名用产品名 HuaAnWork(与其 package.json 的
      // artifactName 一致),beta 用连字符 slug DSH-Desktop-Beta;normalize 的
      // 'HuaAnWork'→'DSH Desktop Beta'(带空格)无法归一这两种形态。
      'scripts/verify-win-portable.ts',
      'scripts/verify-profile-boot.mjs',
    ],
    oneSidedPaths: [],
    oneSidedPrefixes: ['src/client-huaanwork/', 'scripts/gen-'],
  },
]

function files(directory, base = directory) {
  const result = []
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) result.push(...files(path, base))
      else if (entry.isFile()) result.push(relative(base, path).split(sep).join('/'))
    }
  } catch {
    // directory doesn't exist
  }
  return result
}

export function verifyDesktopVariants(pairs = PAIRS, baseRoot = root) {
  const differences = []
  const summary = []

  for (const pair of pairs) {
    const allowedDifferences = new Set(pair.allowedDifferences)
    const oneSidedPaths = new Set(pair.oneSidedPaths)
    for (const dir of pair.dirs) {
      const leftRoot = join(baseRoot, pair.left, dir)
      const rightRoot = join(baseRoot, pair.right, dir)
      const dirOneSided = filterDirOneSided(oneSidedPaths, dir, pair.dirs)
      const sharedPaths = new Set([...files(leftRoot), ...files(rightRoot), ...dirOneSided])
      let excludedCount = 0

      for (const path of [...sharedPaths].sort()) {
        const key = `${dir}/${path}`
        if (allowedDifferences.has(key) || allowedDifferences.has(path)) {
          excludedCount++
          continue
        }
        let left
        let right
        try { left = readFileSync(join(leftRoot, path), 'utf8') } catch { left = undefined }
        try { right = readFileSync(join(rightRoot, path), 'utf8') } catch { right = undefined }
        if (isOneSided(key, oneSidedPaths, pair.oneSidedPrefixes) || isOneSided(path, oneSidedPaths, pair.oneSidedPrefixes)) {
          excludedCount++
          if (left !== undefined || right === undefined) {
            differences.push(`[${pair.name}] ${key} (must exist only in ${pair.right})`)
          }
          continue
        }
        if (left === undefined || right === undefined || pair.normalize(left) !== pair.normalize(right)) {
          differences.push(`[${pair.name}] ${key}`)
        }
      }

      summary.push(`${pair.name} ${dir} (${String(sharedPaths.size - excludedCount)} files)`)
    }
  }

  if (differences.length > 0) {
    throw new Error(`Desktop variant source drift is not declared:\n${differences.map(item => `- ${item}`).join('\n')}`)
  }

  process.stdout.write(`verify-desktop-variants: ${summary.join(', ')} shared source files are aligned; all editions use isolated Host and chrome\n`)
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyDesktopVariants()
}
