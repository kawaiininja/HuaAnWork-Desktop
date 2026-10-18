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

// Identity spellings are not behavior. Comparisons run on the normalized text,
// so a file whose only difference is a product name does not need an allowlist slot.
// stable↔beta matches upstream's normalizeIdentity (package name + spaced
// "DSH Desktop Beta") and also rewrites the hyphen slug and the lowercase
// binary name, which upstream's src-only guard never compared.
// beta↔huaanwork rewrites the huaanwork package and the spaced product name
// onto the beta spelling, then rewrites the beta hyphen slug onto that same
// spaced form so artifact-name templates compare equal.
const STABLE_IDENTITY_REPLACEMENTS = [
  ['dsh-plugin-desktop-beta', 'dsh-plugin-desktop'],
  ['DSH-Desktop-Beta', 'DSH-Desktop'],
  ['DSH Desktop Beta', 'DSH Desktop'],
  ['dsh-desktop-beta', 'dsh-desktop'],
]
const HUAANWORK_IDENTITY_REPLACEMENTS = [
  ['dsh-plugin-huaanwork', 'dsh-plugin-desktop-beta'],
  ['HuaAnWork', 'DSH Desktop Beta'],
  ['DSH-Desktop-Beta', 'DSH Desktop Beta'],
]

export function normalizeIdentity(source, pairName = 'stable↔beta') {
  const replacements = pairName === 'beta↔huaanwork'
    ? HUAANWORK_IDENTITY_REPLACEMENTS
    : STABLE_IDENTITY_REPLACEMENTS
  let text = String(source)
  for (const [from, to] of replacements) text = text.replaceAll(from, to)
  return text
}

export const PAIRS = [
  {
    name: 'stable↔beta',
    left: 'dsh-plugin-desktop',
    right: 'dsh-plugin-desktop-beta',
    dirs: ['src', 'scripts'],
    normalize: source => normalizeIdentity(source, 'stable↔beta'),
    allowedDifferences: [
      // Core: which DESKTOP_RELEASE_IDENTITIES entry this edition exports.
      // Bare name is safe: no scripts/product-identity.ts exists, so it cannot
      // also exempt a script. Every other entry is dir-prefixed.
      'product-identity.ts',
      // Upstream stable fail-closes the installer quit probe after 15s; beta
      // waits for the process. Both sides match upstream, so the behaviors stay.
      'scripts/probe-windows-installer-quit.ps1',
      // Upstream stable boot smoke exposes authenticatedUrl and a distinct
      // renderer token; beta does not. Both sides match upstream.
      'scripts/verify-loader-boot.mjs',
      // Upstream 0.2.1 runtime preparation and smoke divergence between Stable (0.2.0-rc.2)
      // and Beta (0.2.1-rc.1).
      'scripts/prepare-runtime.ts',
      'scripts/primary-runtime.ts',
      'scripts/sign-runtime.ts',
      'scripts/verify-profile-boot.mjs',
    ],
    oneSidedPaths: [],
    oneSidedPrefixes: [],
  },
  {
    name: 'beta↔huaanwork',
    left: 'dsh-plugin-desktop-beta',
    right: 'dsh-plugin-huaanwork',
    // M2 起覆盖 scripts/(M1 评审 P1:stable 的 scripts/ 漂移对守卫完全隐形)。
    // Portable 与 NSIS 制品名模板只是产品名的两种拼法,normalizeIdentity 吸收后不再占额。
    dirs: ['src', 'scripts'],
    normalize: source => normalizeIdentity(source, 'beta↔huaanwork'),
    allowedDifferences: [
      // 多目录配对一律带目录前缀(见下方语义说明 1);裸文件名会导致
      // allowedDifferences.has('src/product-identity.ts') 恒为 false。
      'src/product-identity.ts',
      // huaanwork-only: macOS native directory picking (D11 route (b)). The
      // picker route registers on win32 || darwin and resolves through the
      // composed upstream `directoryPicker` seam (osascript); beta registers
      // it on win32 only. History: added by bd71df0beb (2026-09-30), silently
      // dropped by the unreviewed M8 propagation checkpoint 827e53fc03
      // (2026-10-09), restored 2026-10-15 with the deleted darwin tests.
      'src/index.ts',
      'src/profile.ts',
      // Advanced mode installs the HuaAnWork shell. Onboarding, the launch-folder
      // bridge, and the settings-forms inject match beta.
      'src/client/index.ts',
      // The advanced web graph omits ui-sidebar, ui-conversation, and the
      // conversation-row dependents that cannot stay enabled without that row.
      // The runtime stub also implements requestConfirmedRestart: huaanwork-host
      // throws on boot if desktopRuntime lacks it, and beta's shell never calls it.
      // The M3 guardrail lock disables jobs, web, user-questions, and hmr, so
      // cordis cannot mount and live HMR cannot apply. This smoke mounts the
      // selected default minimal preset and asserts the hmr disable. Beta's
      // copy still mounts cordis and two live HMR generations.
      'scripts/verify-profile-boot.mjs',
      // M3 实现评审 D2 修复:workspace.open/close 需要原生重启确认框的裁决回传 Host
      // (取消路径清 pendingRoot)。两文件均为纯增量差异——electron-runtime.ts 新增
      // requestConfirmedRestart(既有方法逐字不动),host-runtime-bridge.ts 新增
      // ConfirmedRestartRuntime 接口与 native:requestConfirmedRestart 绑定。
      'src/electron-runtime.ts',
      'src/host-runtime-bridge.ts',
      // 裁定(2026-10-15):f9fd375243 给 huaanwork 侧新增 5 行
      // renderer.setZoomLevel(0) —— Chromium 按 host 记忆缩放档位,本 shell 恒从
      // 127.0.0.1 加载,残留档位(冒烟会话曾落在 -2,约 69%)会把整个 HuaAnWork
      // 布局缩离 100% 的 Tauri 应用。这是 huaanwork 变体专属诉求(beta 没有
      // 「对齐 Tauri 应用」的基线),不同步进 beta,占 1 个白名单名额。
      'src/electron-shell-generation.ts',
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
      // Checkpoint-aware market artifact GC: the collector exists only on huaanwork.
      'src/profile-checkpoint.ts',
      // One-shot legacy migration before profile preparation, profileUserDataDir
      // threaded into prepareDesktopProfile, and a log line when an expired
      // pendingRoot is dropped.
      'src/main.ts',
      // M6(2026-09-27)release-channel 切换:联合类型 'stable'|'beta' → 三元,
      // 版本形状判定表化,更新 endpoint 由硬编码上游公共服务改为部署期可配置,
      // 并透出每平台制品 sha256(D-M6-23)。
      // 小写 'huaanwork' 字面量不被 normalize 归一,故必然产生差异。
      'src/update-checker.ts',
      'src/update-download.ts',
      // M8 Task 2.4:上游本次新增的三条脚本,huaanwork 单侧不存在
      // (只在 left/beta)。
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
      //    附注(非守卫事项,as-of 827e53fc03):上游生成器出 16 档精确 DPI 帧,fork 的
      //    gen-windows-ico.mjs 出 7 档 —— 这是图标保真度差距,不是本条名额的理由,
      //    登记在此以免被误读为已对齐。
      'scripts/generate-windows-app-icon.mjs',
      // M9: Upstream 2.1 features (Context menu, Developer logging, Plugin packages, Office runtime)
      // active in desktop-beta but not incorporated into huaanwork.
      // The dark-theme <select> option fill is an upstream 2.1 UI fix parked out of M9
      // (see .superpowers/sdd/2026-10-17-m9-upstream-sync/parked-desktop-settings-select.patch),
      // so this file stays divergent until a UI wave ports it.
      'src/client/desktop-settings-styles.ts',
      'src/client/ui-diagnostics.ts',
      'src/compatibility-shell.ts',
      'src/context-menu.ts',
      'src/desktop-office.ts',
      'src/developer-logging.ts',
      'src/diagnostic-record.ts',
      'src/file-exporter.ts',
      'src/file-path-bridge-contract.ts',
      'src/host-bootstrap.ts',
      'src/host-developer-logging.ts',
      'src/host-process.ts',
      'src/host-rpc.ts',
      'src/jobs-bridge.ts',
      'src/local-window-policy.ts',
      'src/log-files.ts',
      'src/module-resolution.ts',
      'src/official-diagnostics.ts',
      'src/plugin-packages.ts',
      'src/preload.ts',
      'src/process-output-logging.ts',
      'src/profile-create-window.ts',
      'src/profile-selection-window.ts',
      'src/renderer-logging.ts',
      'src/runtime.ts',
      'src/settings-bridge.ts',
      'src/startup-recovery-window.ts',
      'src/webserver.ts',
      // M9: Upstream 2.1 primary runtime packaging and platform scripts active in
      // desktop-beta but not incorporated into huaanwork (which does not carry Python runtime).
      'scripts/mac-universal.ts',
      'scripts/package-mac.ts',
      'scripts/package-win-portable.ts',
      'scripts/package-win.ts',
      'scripts/prepare-runtime.ts',
      'scripts/primary-runtime.ts',
      'scripts/prune-python-tests.ts',
      'scripts/release-mac.ts',
      'scripts/sign-runtime.ts',
      'scripts/verify-electron-fuses.ts',
      'scripts/verify-mac-release.ts',
      'scripts/verify-mac-runtime.ts',
      'scripts/verify-mac-smoke.ts',
      'scripts/verify-packaged-runtime.ts',
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

  const allowlist = pairs
    .map(pair => `${pair.name} allowlist ${String(pair.allowedDifferences.length)} (oneSidedPrefixes ${String(pair.oneSidedPrefixes?.length ?? 0)})`)
    .join(', ')
  process.stdout.write(`verify-desktop-variants: ${summary.join(', ')} shared source files are aligned; all editions use isolated Host and chrome; ${allowlist}\n`)
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyDesktopVariants()
}
