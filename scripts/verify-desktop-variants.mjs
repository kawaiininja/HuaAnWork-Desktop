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

export const PAIRS = [
  {
    name: 'stable↔beta',
    left: 'dsh-plugin-desktop',
    right: 'dsh-plugin-desktop-beta',
    dirs: ['src', 'scripts'],
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
      // M7 Task 1.3(M6 盲区):stable↔beta 的 scripts/ 自 M1 起完全无守卫覆盖,
      // 实测 15 条漂移(8 differ + 7 only-in-stable),此前无登记、无审阅记录。
      // 全部登记为 allowedDifferences 而非 oneSidedPrefixes:后者的语义是「只存在于
      // right 侧」(见 verifyDesktopVariants 内 isOneSided 分支的 must exist only in
      // <right> 报错),而本对的 right 是 beta、这批文件只在 stable(left),
      // 用前缀会让守卫立刻变红。「beta 侧不得长出同名文件」这层强制改由
      // verify-desktop-variants.test.mjs 的 scriptsOneSided 断言承担。
      // 口径:多目录配对一律带 scripts/ 前缀(见下方语义说明),裸文件名会同时
      // 命中 src/ 与 scripts/ 两个桶。既有 4 条保持裸文件名不动(它们是 src-only 名,
      // 且 scripts/ 下无同名文件 —— M7 Task 1.3 的 Step 4 已机械核验这一点)。
      //
      // M8 Task 2.4 订正:only-in-stable 由 7 条降为 6 条。上游 350 提交把
      // scripts/generate-windows-app-icon.mjs 也放进了 beta(合并前 fork 侧只有 stable 有),
      // 合并后 stable 与 beta 的该文件**逐字节相同** ⇒ 它的 allowedDifferences 名额已成
      // 僵尸额度,故删除。方向性强制(「stable-only 脚本不得出现在 beta」)随之收窄到
      // 仍然单侧的 6 条,断言本体保留在 verify-desktop-variants.test.mjs,并新增一条
      // 正向钉记录「该文件现存在于两侧且逐字节相同、不占白名单名额」,防止无声回退。
      'scripts/generate-tray-icons.mjs',
      'scripts/mac-universal.ts',
      'scripts/probe-windows-installer-quit.ps1',
      'scripts/verify-loader-boot.mjs',
      'scripts/verify-packaged-runtime.ts',
      'scripts/verify-profile-boot.mjs',
      'scripts/verify-win-installer.ts',
      'scripts/verify-win-portable.ts',
      'scripts/build-windows-nsis-ab.ts',
      'scripts/inspect-windows-installed-app.ts',
      'scripts/probe-windows-packaged-runtime.ts',
      'scripts/run-windows-nsis-ab.ps1',
      'scripts/verify-nsis-ab-prepackaged.ts',
      'scripts/windows-nsis-ab.ts',
      // M8 Task 2.4:上游本次新增的 Linux 制品校验脚本。两个通道**不可能**产出同名
      // 制品,所以差异本身不可消除;但这一格白名单名额是可消除的 —— 它存在只是因为
      // 本对 normalize 的改写规则覆盖不到这里用到的两种身份写法。
      // 差异面(全部三处都是制品/二进制名,别无一字):
      //   AppImage  DSH-Desktop-<v>-x86_64.AppImage  vs  DSH-Desktop-Beta-<v>-…
      //   deb       DSH-Desktop-<v>-amd64.deb        vs  DSH-Desktop-Beta-<v>-…
      //   可执行文件 linux-unpacked/dsh-desktop       vs  linux-unpacked/dsh-desktop-beta
      // 本对 normalize 只改写工作区名与**带空格**的 DSH Desktop Beta;**连字符** slug
      // DSH-Desktop-Beta 与**小写**二进制名 dsh-desktop-beta 都能穿过它 ——
      // 与下方 beta↔huaanwork 的 verify-win-portable.ts、verify-win-installer.ts 同一根因。
      // 旁证:上游自己(ca52ce2cd9)的 stable 与 beta 两份该文件也互不相同,即这条分叉是
      // 「有两个通道」的固有产物,不是 fork 侧漏改。
      // ⇒ **Task 3.1 normalizeIdentity 的吸收候选**:规范化覆盖连字符 slug 与小写二进制名
      //    之后本条应当删除(届时它会变成僵尸额度,Task 3.1 的反向验证会暴露它)。
      'scripts/verify-linux-artifacts.ts',
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
      // Task 3 复盘登记:huaanwork 在 advanced 模式禁用 ui-sidebar 与 ui-conversation,
      // verify-profile-boot.mjs 断言组装后的 advanced Web 图,必须断言这两项不包含,与 beta 产生合法差异。
      'scripts/verify-profile-boot.mjs',
      // M3 实现评审 D2 修复:workspace.open/close 需要原生重启确认框的裁决回传 Host
      // (取消路径清 pendingRoot)。两文件均为纯增量差异——electron-runtime.ts 新增
      // requestConfirmedRestart(既有方法逐字不动),host-runtime-bridge.ts 新增
      // ConfirmedRestartRuntime 接口与 native:requestConfirmedRestart 绑定。
      'src/electron-runtime.ts',
      'src/host-runtime-bridge.ts',
      // M5 Task 0 复盘登记(D2 + round3 R8/R7 + round4 X2 终值):variant 白名单 8→17。
      // 下列 9 个 shared 文件是 round3 R7 裁定的 provider 联合类型全量镜像面(8 文件 13 处
      // 校验点,守则 6)——Task 3 接入 huaanwork-market 第四 provider 时必然产生共享文件
      // 差异,一次性预登记,免得 Task 3 逐文件突破;不含 src/pnpm.ts(解法 A 后零改动,
      // round3 R8)。oneSidedPrefixes 保持恰好 5(wrapper 落 src/huaanwork-host/,不占预算)。
      // desktop-market.ts:DesktopMarketProvider 联合类型第四成员 + DESKTOP_MARKET_IDENTITIES 条目。
      'src/desktop-market.ts',
      // profile-preferences.ts:provider 偏好读写校验镜像(profile-preferences.ts:133-134)。
      'src/profile-preferences.ts',
      // setup-wizard-contract.ts:向导契约 provider 校验镜像(:8,94;向导不加选项,校验器仍同步)。
      'src/setup-wizard-contract.ts',
      // desktop-settings-route.ts:设置 route 的 isMarketProvider 校验镜像(:141-144)。
      'src/desktop-settings-route.ts',
      // setup-wizard-window.ts:向导窗口 provider 联合类型镜像(:73)。
      'src/setup-wizard-window.ts',
      // client/desktop-settings-api.ts:客户端 settings API provider 类型镜像(:32,102)。
      'src/client/desktop-settings-api.ts',
      // native-ui/setup-wizard/App.tsx:向导 UI provider 校验镜像(:355)。
      'src/native-ui/setup-wizard/App.tsx',
      // client/DesktopSettingsSection.tsx:设置面 market provider 选项表入口(:274,285,292)。
      'src/client/DesktopSettingsSection.tsx',
      // client/desktop-settings-locales.ts:设置面 provider 选项标签文案。
      'src/client/desktop-settings-locales.ts',
      // M5 D9 修复复盘(2026-09-27):variant 白名单 17→19。checkpoint 感知的市场制品
      // GC(retention 判据纳入 checkpoint slot 快照)——profile-checkpoint.ts 纯增量导出
      // collector,main.ts 纯增量经 config 注入 checkpointUserDataDir;均为单侧增量,既有内容逐字不动。
      'src/profile-checkpoint.ts',
      'src/main.ts',
      // M6(2026-09-27)release-channel 切换:联合类型 'stable'|'beta' → 三元,
      // 版本形状判定表化,更新 endpoint 由硬编码上游公共服务改为部署期可配置,
      // 并透出每平台制品 sha256(D-M6-23)。
      // 小写 'huaanwork' 字面量不被 normalize 归一,故必然产生差异。
      'src/update-checker.ts',
      'src/update-download.ts',
      // M6 NSIS 制品名 DSH-Desktop-Beta-* → HuaAnWork-*:连字符形式不被
      // normalize 的空格形式归一,与既有 scripts/verify-win-portable.ts 同因。
      'scripts/verify-win-installer.ts',
      // M8 Task 2.4:上游本次新增的三条脚本,huaanwork **单侧不存在**(只在 left/beta)。
      // 一律登记为 allowedDifferences 而非 oneSidedPrefixes:后者语义是「只存在于
      // right 侧」(见上方 stable↔beta 同一说明与 verifyDesktopVariants 内 isOneSided
      // 分支的 must exist only in <right> 报错),本对的 right 是 huaanwork、这三个文件
      // 只在 left,用前缀会让守卫立刻变红 —— 与上方 stable↔beta 的 only-in-stable
      // 处置同形。「huaanwork 侧不得长出同名文件」这层方向性强制由
      // verify-desktop-variants.test.mjs 的 betaOnlyScripts 断言承担(M6 盲区同解法)。
      // 注意:不得把既有前缀 scripts/gen- 放宽成 scripts/generate- 来覆盖第三条 ——
      // 那会双向静默吞掉今后所有 generate-* 脚本。
      //
      // 1) Linux 打包:huaanwork 结构性没有 Linux 发行流水线,且这是**fork 自己的既有
      //    决定**,不是本次合并漏改。实测三项(as-of 827e53fc03):
      //    ① dsh-plugin-huaanwork/package.json 的 build.linux.target 只有 ["dir"],
      //       stable/beta 是 AppImage + deb 两个 x64 target;该 ["dir"] 在合并前的
      //       efde2186be 已是此值;
      //    ② huaanwork 没有 dist:linux、也没有 check:linux-package(两个 script key 都
      //       只在 stable/beta 的 package.json 里);
      //    ③ ci.yml 的三个发行矩阵中,fork 把 dsh-plugin-huaanwork 加进了 desktop-windows
      //       与 desktop-macos 两格(三格矩阵,Task 2.4 matrix-preserve 类要保的就是它),
      //       却**没有**加进 desktop-linux(该 job 沿用上游的两格矩阵)。同一文件内
      //       有选择地不加 ⇒ 有意排除。
      //    ⇒ 「一个版本没有的流水线」,不可同形。
      'scripts/package-linux.ts',
      // 2) Linux 制品校验:校验对象是 huaanwork 从不产出的 AppImage/deb
      //    (DSH-Desktop-Beta-<v>-x86_64.AppImage / -amd64.deb 与 linux-unpacked 内的
      //    dsh-desktop-beta 可执行文件),只被 beta 的 check:linux-package:platform
      //    经 tests/verify-linux-artifacts.spec.ts 调用;huaanwork 的 tests/ 下既没有
      //    verify-linux-artifacts.spec.ts 也没有 package-linux.spec.ts。与第 1 条同一
      //    结构性理由。
      'scripts/verify-linux-artifacts.ts',
      // 3) Windows 图标生成:huaanwork 自带 fork 专有的品牌图标流水线,上游这个生成器
      //    在本版本**没有消费方**。实测:上游图标导出器 scripts/export-app-icons.mjs 的
      //    ICON_PACKAGES 只有 stable/beta/next 三通道(无 huaanwork),而它是仓库内
      //    generateWindowsAppIcon 的唯一代码消费点;huaanwork 的 package.json 没有
      //    icons:export;huaanwork 的 build/app-icon.ico(已跟踪)由 fork 专有的
      //    scripts/gen-windows-ico.mjs 产出(该文件由既有前缀 scripts/gen- 声明单侧),
      //    来源是提交 87804beccb「用 HuaAnWork 品牌资产替换上游美术」。
      //    ⇒ 品牌资产与图标导出流水线是本版本自有的另一条,不可同形。
      //    附注(非守卫事项):上游生成器出 16 档精确 DPI 帧,fork 的 gen-windows-ico.mjs
      //    出 7 档 —— 这是图标保真度差距,不是本条名额的理由,登记在此以免被误读为已对齐。
      'scripts/generate-windows-app-icon.mjs',
    ],
    oneSidedPaths: [],
    oneSidedPrefixes: [
      'src/client-huaanwork/',
      'src/huaanwork-host/',
      'src/huaanwork-guardrails/',
      // M6 一次性数据迁移(旧 Tauri $DSH_HOME → HuaAnWork profile 目录),
      // 主进程侧纯函数模块,单侧存在。
      'src/huaanwork-migration/',
      'scripts/gen-',
      'scripts/huaanwork-',
    ],
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
