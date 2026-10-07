/**
 * README 版本字符串一致性守卫(M12 纯脚本档;裁定 R-M7-4)。
 *
 * 为什么需要它:发行链的版本一致性已被 5 道机械门钉住(凭据 env 名单、制品命名、
 * 通道记录、更新端点、provisioning),唯一无守卫的是 README 里硬编码的制品版本串 ——
 * 而 M6 的 Task 4.3 证明它会漂移(漂过一次、人工发现、人工修)。
 *
 * 权威版本源 = **各 workspace 自己的 package.json.version**。root package.json
 * **没有 version 字段**(它是 private 的 workspace 根),故不存在「根版本」可比。
 *
 * 范围:当前只覆盖 dsh-plugin-huaanwork 的两个 README(R-M7-4 说的「4 处」= 2 文件 × 2 行)。
 * stable/beta 的 4 处同名漂移(README 写 2.0.5 / 2.0.5-beta.2,而 package.json 是
 * 2.0.12 / 2.0.12-beta.1)按评估 §6.3 第 23 条归 **M28** —— 那两个 README 是上游所有,
 * 在 fork 侧改它们会扩大上游同步冲突面。范围显式登记在 outOfScopeRegistered 里,
 * 输出的 `out of scope (M28)` 一行就是为了让「守卫绿」不被误读成「全仓 README 都对」。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const README_VERSION_SCOPES = [
  {
    packageDir: 'dsh-plugin-huaanwork',
    readmes: ['README.md', 'README.zh.md'],
    // 制品名的形态:`HuaAnWork-<version>-x64-Setup.exe` 与 `-Portable.zip`。
    // 用「产品名前缀 + 版本 + 平台后缀」的模式匹配,而不是裸版本串 —— 裸串会误伤
    // README 里的 Node 版本(22.23.2)、vendored runtime 版本(0.1.6-alpha.2)等。
    artifactPattern: /HuaAnWork-(\d+\.\d+\.\d+(?:-[\w.]+)?)-x64-(?:Setup\.exe|Portable\.zip)/gu,
    outOfScopeRegistered: [
      'dsh-plugin-desktop/README.md',
      'dsh-plugin-desktop/README.zh.md',
      'dsh-plugin-desktop-beta/README.md',
      'dsh-plugin-desktop-beta/README.zh.md',
    ],
  },
]

export function checkReadmeVersions(root) {
  const violations = []
  let checked = 0
  for (const scope of README_VERSION_SCOPES) {
    const manifestPath = join(root, scope.packageDir, 'package.json')
    if (!existsSync(manifestPath)) {
      violations.push({ file: `${scope.packageDir}/package.json`, reason: 'manifest not found' })
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const expected = manifest.version
    if (typeof expected !== 'string' || expected === '') {
      violations.push({ file: `${scope.packageDir}/package.json`, reason: 'no version field to compare against' })
      continue
    }
    for (const readme of scope.readmes) {
      const path = `${scope.packageDir}/${readme}`
      const fullPath = join(root, path)
      // M7 review fix round: 两个 vacuous-pass 方向的封堵 ——
      // ① 在管 README 不存在 ⇒ 守卫无从谈起,必须红而不是绿;
      // ② README 存在但零命中 ⇒ 守卫对该文件同样什么都没守住(版本串被
      //    连同文案一起删掉的漂移会静默全绿),同样必须红。
      if (!existsSync(fullPath)) {
        violations.push({ file: path, reason: 'in-scope README not found; a version guard may not pass on files it cannot read' })
        continue
      }
      const text = readFileSync(fullPath, 'utf8')
      const lines = text.split('\n')
      let fileMatches = 0
      lines.forEach((line, index) => {
        for (const match of line.matchAll(scope.artifactPattern)) {
          fileMatches += 1
          checked += 1
          if (match[1] !== expected) {
            violations.push({
              file: path,
              line: index + 1,
              reason: `README hardcodes ${match[1]} but ${scope.packageDir}/package.json version is ${expected}`,
            })
          }
        }
      })
      if (fileMatches === 0) {
        violations.push({ file: path, reason: 'no artifact version strings matched the scope pattern; the guard would pass vacuously on this file' })
      }
    }
  }
  return { checked, violations }
}

// Only execute CLI runner if executed directly:
const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectExecution) {
  const root = join(import.meta.dirname, '..')
  const { checked, violations } = checkReadmeVersions(root)
  const outOfScope = README_VERSION_SCOPES.flatMap(scope => scope.outOfScopeRegistered)
  if (violations.length > 0) {
    process.stdout.write(
      `verify-readme-versions: ${String(violations.length)} README version drift(s):\n` +
      `${violations.map(v => `  - ${v.file}${v.line === undefined ? '' : `:${String(v.line)}`} ${v.reason}`).join('\n')}\n`,
    )
    process.exit(1)
  }
  const scopedList = README_VERSION_SCOPES.map(scope => scope.packageDir).join(', ')
  process.stdout.write(
    `verify-readme-versions: ${String(checked)} hardcoded artifact version string(s) in ` +
    `${String(README_VERSION_SCOPES.length)} scoped package(s) (${scopedList}) match their own package.json; ` +
    `${String(outOfScope.length)} README(s) out of scope (M28): ${outOfScope.join(', ')}\n`,
  )
}
