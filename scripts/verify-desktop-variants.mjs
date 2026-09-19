import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

// oneSided 判定:huaanwork-only 的文件必须显式声明——精确路径放 oneSidedPaths,
// 整目录/整前缀放 oneSidedPrefixes(以前缀字符串 endsWith('/') 或子串语义匹配)。
export function isOneSided(path, oneSidedPaths, oneSidedPrefixes) {
  if (oneSidedPaths.has(path)) return true
  return oneSidedPrefixes.some((prefix) => path.startsWith(prefix))
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
      // huaanwork 的 portable 制品名用产品名 HuaAnWork(与其 package.json 的
      // artifactName 一致),beta 用连字符 slug DSH-Desktop-Beta;normalize 的
      // 'HuaAnWork'→'DSH Desktop Beta'(带空格)无法归一这两种形态。
      'scripts/verify-win-portable.ts',
    ],
    oneSidedPaths: [],
    oneSidedPrefixes: ['src/client-huaanwork/', 'scripts/gen-'],
  },
]

function files(directory, base = directory) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...files(path, base))
    else if (entry.isFile()) result.push(relative(base, path).split(sep).join('/'))
  }
  return result
}

export function verifyDesktopVariants() {
  const differences = []
  const summary = []

  for (const pair of PAIRS) {
    const allowedDifferences = new Set(pair.allowedDifferences)
    const oneSidedPaths = new Set(pair.oneSidedPaths)
    for (const dir of pair.dirs) {
      const leftRoot = join(root, pair.left, dir)
      const rightRoot = join(root, pair.right, dir)
      const sharedPaths = new Set([...files(leftRoot), ...files(rightRoot), ...oneSidedPaths])

      for (const path of [...sharedPaths].sort()) {
        const key = `${dir}/${path}`
        // 单目录配对(stable↔beta)保持裸文件名键;多目录配对一律用带目录前缀的键。
        const keyed = pair.dirs.length === 1 ? path : key
        if (allowedDifferences.has(keyed)) continue
        let left
        let right
        try { left = readFileSync(join(leftRoot, path), 'utf8') } catch { left = undefined }
        try { right = readFileSync(join(rightRoot, path), 'utf8') } catch { right = undefined }
        if (isOneSided(keyed, oneSidedPaths, pair.oneSidedPrefixes)) {
          if (left !== undefined || right === undefined) {
            differences.push(`[${pair.name}] ${key} (must exist only in ${pair.right})`)
          }
          continue
        }
        if (left === undefined || right === undefined || pair.normalize(left) !== pair.normalize(right)) {
          differences.push(`[${pair.name}] ${key}`)
        }
      }

      const declared = pair.dirs.length === 1
        ? allowedDifferences.size + oneSidedPaths.size
        : [...allowedDifferences, ...oneSidedPaths].filter((entry) => entry.startsWith(`${dir}/`)).length
      summary.push(`${pair.name} ${dir} (${String(sharedPaths.size - declared)} files)`)
    }
  }

  if (differences.length > 0) {
    throw new Error(`Desktop variant source drift is not declared:\n${differences.map(item => `- ${item}`).join('\n')}`)
  }

  process.stdout.write(`verify-desktop-variants: ${summary.join(', ')} shared source files are aligned; all editions use isolated Host and chrome\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyDesktopVariants()
}
