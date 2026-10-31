> **历史计划（2026 年 10 月）——不可执行。**
> 本文件写作于三桌面时期：`dsh-plugin-desktop`、`dsh-plugin-desktop-beta`、`dsh-desktop-next` 三棵源码树已于 2026-10-30 删除；文中反复引用的 `scripts/verify-desktop-variants.mjs` / `scripts/verify-desktop-variants.test.mjs` 与 `check:desktop-variants` 命令也已删除。下文（含其中的命令、22 条白名单口径与 TODO 勾选状态）只作为历史记录保留，**不要照此执行**；当前仓库的构建、门禁与上游同步规则以 `AGENTS.md` 与 `docs/upstream-sync.md` 为准。

# 固定 HuaAnWork 窗口模式为增强模式

## TL;DR
> **Summary**: HuaAnWork 在 macOS 与 Windows 上只启动增强模式（`advanced`）。这两边已保存的兼容模式和扩展窗口在下次启动时改写成增强模式，并向导、设置页、托盘不再提供切换。Linux 仍只能是兼容模式，因为设置桥会拒绝其他模式，而该文件本方案不改。
> **Deliverables**: 启动回写、三处界面关闭、契约拒绝非增强模式、对应 vitest 更新。不重打安装包，不新增变体白名单。
> **Effort**: Short
> **Parallel**: YES - 2 waves
> **Critical Path**: Task 1 -> Task 3；Task 2 与 Task 4 可与 Task 1 并行；Task 5 在全部实现之后。

## Context
### Original Request
将窗口模式固定为增强模式。当前 Windows 包在设置向导、设置页和托盘里同时提供兼容模式、扩展窗口、增强模式。

### Interview Summary
未再提问。按下面的默认执行：
- 只改 `dsh-plugin-huaanwork`。stable / beta 保持三种模式。不改 `dsh-plugin-desktop/src` 与 `dsh-plugin-desktop-beta/src`。
- 锁的是 HuaAnWork 在 macOS 与 Windows 上的行为，不是安装器专属开关。Linux 不锁成增强模式。
- 已有 Profile 在 `darwin` 与 `win32` 下次启动改写成 `mode: advanced`、`openBrowser: false`、`networkExposure: loopback`。浏览器访问和局域网访问只在兼容模式合法，必须一起清掉，否则 `assertDesktopSettings` 会因「非兼容模式却开着浏览器」拒绝启动。
- 不删除兼容壳和扩展壳源码。这些模块仍在安装包里，但选不中、也启动不了。
- 不新增 `allowedDifferences`。白名单被 `scripts/verify-desktop-variants.test.mjs` 钉死为恰好 22 条。

### Metis Review (gaps addressed)
- 生效的模式在 Profile 的 `cordis.patch.yml` 里那条 `desktop-shell` 行，不在启动器补丁里。`profile.ts` 约 1714–1734 行明确禁止给这条启动补丁写 `config`，否则设置编辑器报 `Configuration for "desktop-shell" is overridden`。回写必须改 Profile 补丁文件本身。
- `settings-bridge.ts` 缺省模式是 `compatibility`，`setup-wizard-settings.ts` 的 `parseMode(undefined)` 也是 `compatibility`，`safe-mode.ts` 写死 `compatibility`。只改 `parseDesktopShellMode` 的缺省值锁不住。
- `pendingDesktopShellConfig` 若对非增强模式返回 `undefined`，上游导入仍会把旧模式写回去。应改写这三个字段再导入。
- `src/client/DesktopSettingsSection.tsx` 已在白名单。`src/client/desktop-settings.ts` 不在。不要为了传 `windowModes: false` 去改后者；直接在已分叉的设置组件里删掉模式单选和浏览器区。
- `canToggleShellMode` 保持 true 时，托盘项 `enabled: false` 仍会调用 `requestModeChange`。要整段去掉模式子菜单。
- `requestModeChange` / `applySetupSettings` 在 `src/index.ts`，该文件白名单已撤销。本方案不改它。当次会话里若仍有调用，下一次 `prepareDesktopProfile` 会把补丁改回增强模式。
- `check:desktop-variants` 已因 `src/electron-shell-generation.ts` 变红。验收标准是不再出现新的未登记路径，不要求这次把旧红修绿。不要碰那个文件。

### Momus Review round 1 (gaps addressed)
- `settings-bridge.ts` 的 `assertDesktopSettings`（299–301 行）在 Linux 上对任何非 `compatibility` 模式抛错。该文件禁止修改，`tests/plugin.spec.ts` 887–893 行钉着这个抛错。回写、待导入节和向导契约都只在 `darwin` / `win32` 锁成增强模式。`profile.ts` 509 行的 Linux 拒绝保留。
- `prepareDesktopProfile` 1525–1528 行只把 `pendingDesktopShellConfig` 的返回值当布尔门，真正写入补丁的是原始 `pendingSection`。1542 行解构出的 `openBrowser` / `networkExposure` 已经过 `desktopBrowserAccessEnabled` 收束：模式已是 `advanced` 且磁盘上仍是 `openBrowser: true` 或 `networkExposure: lan` 时，投影值已经是 false / loopback，按投影值判断就不会回写，设置桥仍会抛错。比较和回写都用 `desktopShellConfig` 的原始字段；导入前改的是传给 `importPendingDesktopShellSection` 的那份 section。
- 仓库没有 `tests/setup-wizard-contract.spec.ts`。契约断言在 `tests/setup-wizard-copy.spec.ts` 134–155 行，Linux 拒绝 advanced 的窗口行为在 `tests/setup-wizard-window.spec.ts` 231–238 行。验收命令用这两个已有文件。

## Work Objectives
### Core Objective
HuaAnWork 在 macOS 与 Windows 上的每个 Profile、安全模式和首次向导都只以增强模式运行。用户看不到另外两种模式，磁盘上的旧值会被改掉。Linux 保持兼容模式。

### Deliverables
- Profile 补丁与偏好文件的三字段锁。
- 向导去掉「选择窗口模式」和「设置浏览器访问」。
- 设置页去掉窗口模式单选和浏览器/局域网区块；macOS 窗口材质保留。
- 托盘去掉「模式」子菜单。
- 向导契约只接受增强模式且浏览器访问关闭。

### Definition of Done (verifiable conditions with commands)
- `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/profile.spec.ts tests/profile-preferences.spec.ts tests/setup-wizard-settings.spec.ts tests/setup-wizard-native-ui.spec.ts tests/setup-wizard-copy.spec.ts tests/setup-wizard-window.spec.ts tests/client-desktop-settings.spec.ts tests/electron-runtime.spec.ts tests/safe-mode.spec.ts tests/compatibility-shell.spec.ts tests/window-options.spec.ts tests/host-runtime-bridge.spec.ts tests/plugin.spec.ts` 通过。不要加入 `tests/setup-wizard-contract.spec.ts`，这个文件不存在。
- `node --test scripts/verify-desktop-variants.test.mjs` 仍断言 beta↔huaanwork 白名单恰好 22 条。
- `corepack yarn check:desktop-variants` 的失败列表里没有本次改动的新路径。已有的 `src/electron-shell-generation.ts` 失败可以仍在。

### Must Have
- 在 `darwin` 与 `win32` 回写三元组：`mode: advanced`、`openBrowser: false`、`networkExposure: loopback`。Linux 不回写。
- 非法模式字符串仍然抛错，不把垃圾值当成增强模式。
- 启动器补丁仍然是 `{ id: 'desktop-shell', disabled: false }`，不带 `config`。

### Must NOT Have (guardrails, scope boundaries)
- 不改 stable / beta 源码。
- 不新增、不删除 `scripts/verify-desktop-variants.mjs` 的白名单条目。
- 不改 `src/index.ts`、`src/settings-bridge.ts`、`src/setup-wizard-settings.ts`、`src/electron-platform.ts`、`src/safe-mode.ts`、`src/client/desktop-settings.ts`、`src/electron-shell-generation.ts`、`src/client/index.ts`。
- 不删除兼容壳、扩展壳、窗口选项实现。
- 不在本方案里重打 Windows 安装包。
- 不提交 git，除非用户另外要求。

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: 更新现有 vitest，与实现放在同一任务。仓库没有要求先写失败测试再改实现。
- QA policy: 每个任务含可执行场景。
- Evidence: `plans/evidence/lock-advanced-window-mode/` 下放命令输出摘录。

## Execution Strategy
### Parallel Execution Waves
Wave 1: Task 1、Task 2、Task 3、Task 4（四个文件集互不重叠）
Wave 2: Task 5 汇总验证

### Dependency Matrix (full, all tasks)
| Task | Blocks | Blocked By |
| --- | --- | --- |
| 1 Profile 补丁锁 | 5 | 无 |
| 2 偏好文件锁 | 5 | 无 |
| 3 向导 | 5 | 无 |
| 4 设置页与托盘 | 5 | 无 |
| 5 汇总验证 | 无 | 1, 2, 3, 4 |

## TODOs

- [ ] 1. 在 Profile 准备阶段把桌面壳锁成增强模式

  **What to do**:
  - 只在 `platform === 'darwin' || platform === 'win32'` 时锁。`platform === 'linux'` 时不改补丁、不改待导入节，保留 `pendingDesktopShellConfig` 第 509 行 `if (mode !== 'compatibility' && platform === 'linux') return undefined`。
  - 在 `prepareDesktopProfile` 里，`pendingDesktopShellSection` 取到 section 之后、第 1525 行的导入门之前：若平台是 `darwin` 或 `win32` 且 `pendingSection !== undefined`，直接改这份对象的 `mode`、`openBrowser`、`networkExposure` 为三元组。不要改 `pendingDesktopShellConfig` 的返回值。第 1527 行只把它当布尔门，第 1528 行写入的是这份 `pendingSection`。
  - 导入早退之后，用 `desktopShellConfig`（`rowConfig(desktopShell)` 的原始对象）判断，不要用第 1542 行解构出来的 `mode` / `openBrowser` / `networkExposure`。那三个投影值已经过 `desktopBrowserAccessEnabled`：原始 `mode: advanced` 加上 `openBrowser: true` 或 `networkExposure: lan` 时，投影已经是 false / loopback，按投影值不会回写，设置桥仍会因原始 `openBrowser: true` 抛错。`tests/profile.spec.ts` 782–800 行就是这个形态。
  - 原始字段需要回写的条件，四个都要成立：平台是 `darwin` 或 `win32`；`hooks.profilePatches === undefined`（与第 1526 行同一道门，编辑器的内存校验不能改磁盘）；`mode` 缺省、或是 `compatibility` / `extended` / `advanced` 之一，`openBrowser` 缺省或是布尔，`networkExposure` 缺省或是 `loopback` / `lan`；并且原始 `mode` 是 `compatibility` 或 `extended`，或原始 `openBrowser === true`，或原始 `networkExposure === 'lan'`。缺省的 `mode` 按现有解析是 `advanced`，不要因为键不存在就回写。`mode` 是其他字符串、或 `openBrowser` / `networkExposure` 类型非法时不要回写，让后面的 `parseDesktopShellMode` 照旧抛错。
  - 回写只改 Profile 补丁文件里最后一条普通 `desktop-shell` 行的这三个字段，保留端口和窗口材质。行定位复制 `importPendingDesktopShellSection` 第 554–572 行。不要调用 `importPendingDesktopShellSection` 本身，它还会删掉设置文档里的节。然后给 `DesktopProfilePreparationHooks` 增加可选字段 `desktopShellLocked?: boolean`，以 `{ ...hooks, desktopShellLocked: true }` 重新进入 `prepareDesktopProfile`。若进入时该标志已是 true 且原始字段仍需要回写，抛错，错误文本包含 `desktop-shell` 与 `advanced`。禁止第三次进入。
  - `parseDesktopShellMode` 继续接受 `'compatibility' | 'extended' | 'advanced'`，缺省仍是 `advanced`，其他值仍抛错。
  - 保持约 1734 行的启动补丁为 `{ id: 'desktop-shell', disabled: false }`，不要加 `config`。
  - 更新 `tests/profile.spec.ts`：在 `darwin` 上写入 `mode: compatibility` 或 `mode: extended` 且 `openBrowser: true` 的补丁后，`prepared.mode` 为 `advanced`，`openBrowser` 为 false，`networkExposure` 为 `loopback`，并且补丁文件原始字段已改写。782 行那种「模式已是 advanced、但原始 openBrowser 为 true、networkExposure 为 lan」的用例，除了投影值仍是 false / loopback，还要断言补丁文件里这两个原始字段已被改掉。另加一条 `platform: 'linux'`：写入 `mode: compatibility` 后 `prepared.mode` 仍是 `compatibility`，补丁不被改成 `advanced`。非法模式字符串的用例保持抛错。

  **Must NOT do**: 不改 `settings-bridge.ts`、`safe-mode.ts`、`index.ts`。不把 `config` 放进启动器补丁。不删除第 509 行。不把 Linux 锁成 `advanced`。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 5 | Blocked By: 无

  **References**:
  - Pattern: `dsh-plugin-huaanwork/src/profile.ts:485-510` `pendingDesktopShellConfig` 只决定导入是否发生；509 行 Linux 拒绝保留。
  - Pattern: `dsh-plugin-huaanwork/src/profile.ts:554-572` 补丁行定位与三个字段的写入方式。不要走 575–579 行对设置文档的删除。
  - Pattern: `dsh-plugin-huaanwork/src/profile.ts:1516-1538` 原始 `desktopShellConfig`、`pendingSection`，以及返回值只作布尔门。
  - Pattern: `dsh-plugin-huaanwork/src/profile.ts:1542-1550` 投影值，不能拿来判断是否回写。
  - Pattern: `dsh-plugin-huaanwork/src/profile.ts:663-686` `DesktopProfilePreparationHooks`，在这里加 `desktopShellLocked?`。
  - Pattern: `dsh-plugin-huaanwork/src/profile.ts:1714-1734` 禁止给启动补丁写 config 的原因。
  - Test: `dsh-plugin-huaanwork/tests/profile.spec.ts:782-800` 原始 openBrowser 仍在、投影已收束。
  - Test: `dsh-plugin-huaanwork/tests/profile.spec.ts:825-840` 现有兼容模式期望，在 darwin 上要改成被改写。

  **Acceptance Criteria**:
  - [ ] `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/profile.spec.ts` 通过。
  - [ ] darwin 上，测试断言补丁文件里的原始 `mode` 已变成 `advanced`，原始 `openBrowser` 为 false，原始 `networkExposure` 为 `loopback`。
  - [ ] linux 上，`mode: compatibility` 的准备结果仍是 `compatibility`。

  **QA Scenarios**:
  ```
  Scenario: 旧 Profile 以兼容模式加浏览器访问在 darwin 启动
    Tool: bash
    Steps: 在 vitest 临时 home 写入 desktop-shell 行 mode=compatibility、openBrowser=true、networkExposure=lan，调用 prepareDesktopProfile(undefined, home, 'darwin')。
    Expected: prepared.mode === 'advanced'；prepared.openBrowser === false；prepared.networkExposure === 'loopback'；补丁 YAML 的原始 mode 为 advanced、openBrowser 为 false、networkExposure 为 loopback。
    Evidence: plans/evidence/lock-advanced-window-mode/task-1-profile.txt

  Scenario: 模式已是 advanced，但原始浏览器访问仍开着
    Tool: bash
    Steps: 写入 mode=advanced、openBrowser=true、networkExposure=lan，调用 prepareDesktopProfile(undefined, home, 'darwin')。
    Expected: prepared.openBrowser === false 且 prepared.networkExposure === 'loopback'；补丁文件里这两项原始字段也变成 false 与 loopback。只断言投影值不算通过。
    Evidence: plans/evidence/lock-advanced-window-mode/task-1-raw.txt

  Scenario: Linux 仍拒绝把壳锁成增强模式
    Tool: bash
    Steps: 写入 mode=compatibility、openBrowser=false、networkExposure=loopback，调用 prepareDesktopProfile(undefined, home, 'linux')。
    Expected: prepared.mode === 'compatibility'；补丁文件的 mode 仍是 compatibility。
    Evidence: plans/evidence/lock-advanced-window-mode/task-1-linux.txt

  Scenario: 模式字段是垃圾字符串
    Tool: bash
    Steps: 调用 parseDesktopShellMode('enhanced')。
    Expected: 抛错，消息仍要求 compatibility、extended 或 advanced。
    Evidence: plans/evidence/lock-advanced-window-mode/task-1-invalid.txt
  ```

  **Commit**: NO | 不提交 | Files: `dsh-plugin-huaanwork/src/profile.ts`, `dsh-plugin-huaanwork/tests/profile.spec.ts`

- [ ] 2. 读写 Profile 偏好时改写同一三元组

  **What to do**:
  - `normalizedPreferences` 没有平台参数，也不要给 `readDesktopProfilePreferences` / `writeDesktopProfilePreferences` 加参数，这样不用改 `main.ts`。在函数内部用 `process.platform`。
  - `assertMode` 仍先拒绝非法字符串。通过之后：若 `process.platform` 是 `darwin` 或 `win32`，固定返回 `mode: 'advanced'`、`openBrowser: false`、`networkExposure: 'loopback'`，不再因「openBrowser 与非兼容模式组合」或「LAN 但没开 openBrowser」抛错，因为这两个字段已被清掉。若 `process.platform` 是 `linux`，保持现有校验和返回值，不要改成 `advanced`。否则偏好会被 `mirrorDesktopProfilePreferences` 写回设置文档，Linux 上的设置桥会在启动时抛错。
  - `readDesktopProfilePreferences` 与 `writeDesktopProfilePreferences` 都走这个函数（约 305 与 347 行）。安全模式仍先把 `DESKTOP_SAFE_MODE_DEFAULTS`（`mode: 'compatibility'`）写进设置文档；`darwin` / `win32` 上由 Task 1 在导入前改待导入节。不要改 `main.ts` 或 `safe-mode.ts`。
  - 更新 `tests/profile-preferences.spec.ts`。断言按运行时平台分支，这样 macOS、Windows、Linux 的 CI 用同一份测试都能过：`const locked = process.platform === 'darwin' || process.platform === 'win32'`。
  - 合法的 Linux 输入是 `mode: 'compatibility'`、`openBrowser: true`、`networkExposure: 'lan'`。`locked` 时读回 `advanced` / false / `loopback`。`process.platform === 'linux'` 时读回仍是这三项，不要改成 `advanced`。
  - `mode: 'extended'` 且 `openBrowser: true` 在 Linux 上不能当成功路径。现有 182–184 行会抛 `openBrowser requires compatibility mode`。这条在 Linux 上断言抛错、消息含这句；在 `darwin` / `win32` 上不抛错，读回是三元组。非法 `mode`（不是三个合法字符串之一）在所有平台仍抛错。
  - `tests/safe-mode.spec.ts` 60–69 行断言的是常量 `DESKTOP_SAFE_MODE_DEFAULTS.settings.mode === 'compatibility'`。不要改这个断言，常量保持不动。

  **Must NOT do**: 不改 `DESKTOP_SAFE_MODE_DEFAULTS`。不改 `main.ts`。不在 Linux 上把偏好改成 `advanced`。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 5 | Blocked By: 无

  **References**:
  - API: `dsh-plugin-huaanwork/src/profile-preferences.ts:171-190` `normalizedPreferences`。
  - API: `dsh-plugin-huaanwork/src/profile-preferences.ts:322-347` 读与写都调用它。
  - Caller: `dsh-plugin-huaanwork/src/main.ts:1377-1440` 安全模式写入与偏好镜像，本任务不改这些调用。

  **Acceptance Criteria**:
  - [ ] `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/profile-preferences.spec.ts tests/safe-mode.spec.ts` 通过。
  - [ ] `safe-mode.spec.ts` 对 `DESKTOP_SAFE_MODE_DEFAULTS.settings.mode` 的期望保持 `compatibility`。

  **QA Scenarios**:
  ```
  Scenario: 偏好文件里是兼容模式且开了局域网
    Tool: bash
    Steps: writeDesktopProfilePreferences 写入 mode=compatibility、openBrowser=true、networkExposure=lan，再 readDesktopProfilePreferences。断言使用 const locked = process.platform === 'darwin' || process.platform === 'win32'。
    Expected: locked 时两次结果都是 mode=advanced、openBrowser=false、networkExposure=loopback。process.platform === 'linux' 时两次结果仍是 mode=compatibility、openBrowser=true、networkExposure=lan。
    Evidence: plans/evidence/lock-advanced-window-mode/task-2-preferences.txt

  Scenario: Linux 上扩展窗口加浏览器访问被现有校验拒绝
    Tool: bash
    Steps: writeDesktopProfilePreferences 写入 mode=extended、openBrowser=true、networkExposure=lan。
    Expected: process.platform === 'linux' 时抛错，消息含 openBrowser requires compatibility mode，不返回 advanced。darwin 或 win32 时不抛错，读回 mode=advanced、openBrowser=false、networkExposure=loopback。
    Evidence: plans/evidence/lock-advanced-window-mode/task-2-linux-extended.txt

  Scenario: 偏好模式不是三个合法字符串之一
    Tool: bash
    Steps: readDesktopProfilePreferences 读取 mode=desktop。
    Expected: 抛错，不返回 advanced。darwin、win32、linux 都一样。
    Evidence: plans/evidence/lock-advanced-window-mode/task-2-invalid.txt
  ```

  **Commit**: NO | 不提交 | Files: `dsh-plugin-huaanwork/src/profile-preferences.ts`, `dsh-plugin-huaanwork/tests/profile-preferences.spec.ts`, `dsh-plugin-huaanwork/tests/safe-mode.spec.ts`（仅当断言需要跟随返回值）

- [ ] 3. 向导不再询问模式和浏览器访问

  **What to do**:
  - 在 `dsh-plugin-huaanwork/src/native-ui/setup-wizard/App.tsx`：从 `DESKTOP_SETUP_WIZARD_STEPS` 去掉 `'mode'` 和 `'browser'`。欢迎页 `onStart` 改为 `setStep(nextDesktopSetupWizardStep('welcome'))`，下一步是 `'material'`。
  - `normalizedSelection`：`input.platform === 'linux'` 时保持现在的逻辑（强制 `compatibility`，并且只在兼容模式保留浏览器访问）。`darwin` 与 `win32` 一律返回 `mode: 'advanced'`、`openBrowser: false`、`networkExposure: 'loopback'`。
  - `finish` 继续从 selection 写查询参数。darwin / win32 上 selection 已被归一成三元组。Linux 上 selection 仍是兼容模式。
  - 在 `dsh-plugin-huaanwork/src/setup-wizard-contract.ts` 的 `desktopSetupWizardSelectionIsAvailable`：`platform === 'linux'` 时保留现在的规则，包括最后一行 `capabilities.platform !== 'linux' || selection.mode === 'compatibility'`。`darwin` 与 `win32` 仅当 `mode === 'advanced' && openBrowser === false && networkExposure === 'loopback'` 时返回 true。
  - 不改 `setup-wizard-settings.ts` 的 `parseMode`。
  - 契约测试文件是 `tests/setup-wizard-copy.spec.ts` 134–155 行，不是一份单独的 `setup-wizard-contract.spec.ts`。把其中 win32 上 `openBrowser: true` 且 `networkExposure: 'lan'` 仍返回 true 的断言（147–150 行）改成 false。补一条 win32、`mode: 'advanced'`、`openBrowser: false`、`networkExposure: 'loopback'` 返回 true。Linux 上 `mode: 'extended'` 或 `mode: 'advanced'` 仍返回 false。`tests/setup-wizard-window.spec.ts` 231–238 行保持「Linux 提交 advanced 后窗口关闭、结果是 quit」，不要改成接受 advanced。
  - 更新 `setup-wizard-native-ui.spec.ts`、`setup-wizard-settings.spec.ts`：步骤列表不再含 mode 与 browser。

  **Must NOT do**: 不改市场、手机连接、通知、窗口材质步骤。不删文案常量，避免无谓扩大 `setup-wizard-copy.ts` 的差异；测试若只断言文案字符串仍在，保持那些断言。不让 Linux 上的 `mode: 'advanced'` 通过契约。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 5 | Blocked By: 无

  **References**:
  - Pattern: `dsh-plugin-huaanwork/src/native-ui/setup-wizard/App.tsx:45-64` 步骤表。
  - Pattern: `dsh-plugin-huaanwork/src/native-ui/setup-wizard/App.tsx:122-134` `normalizedSelection`。
  - Pattern: `dsh-plugin-huaanwork/src/native-ui/setup-wizard/App.tsx:802` 欢迎页进入 `'mode'`。
  - API: `dsh-plugin-huaanwork/src/setup-wizard-contract.ts:157-165` 平台可用性。

  **Acceptance Criteria**:
  - [ ] `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/setup-wizard-native-ui.spec.ts tests/setup-wizard-copy.spec.ts tests/setup-wizard-settings.spec.ts tests/setup-wizard-window.spec.ts` 通过。不要跑 `tests/setup-wizard-contract.spec.ts`。
  - [ ] 步骤常量的源码不再包含 `'mode'` 与 `'browser'`。
  - [ ] `desktopSetupWizardSelectionIsAvailable` 在 linux 上对 `mode: 'advanced'` 仍返回 false。

  **QA Scenarios**:
  ```
  Scenario: 欢迎页的下一步不是模式选择
    Tool: bash
    Steps: 对 DESKTOP_SETUP_WIZARD_STEPS 断言 index 与 nextDesktopSetupWizardStep('welcome')。
    Expected: 数组为 welcome, material, market, aa, notifications, success；welcome 的下一步是 material。
    Evidence: plans/evidence/lock-advanced-window-mode/task-3-steps.txt

  Scenario: win32 的旧向导输入是兼容模式加局域网
    Tool: bash
    Steps: 用 platform=win32、mode=compatibility、openBrowser=true、networkExposure=lan 调用归一函数与 desktopSetupWizardSelectionIsAvailable。
    Expected: 归一结果为 advanced / openBrowser false / loopback。把未归一的 compatibility 选择交给契约，返回 false。同一契约对 win32、advanced、openBrowser false、loopback 返回 true。
    Evidence: plans/evidence/lock-advanced-window-mode/task-3-contract.txt

  Scenario: Linux 提交增强模式仍被拒绝
    Tool: bash
    Steps: 跑 setup-wizard-window.spec.ts 里 platform=linux、导航到 mode=advanced 的用例。
    Expected: 结果仍是 action quit，窗口不把 advanced 当成完成。desktopSetupWizardSelectionIsAvailable 对 linux + advanced 返回 false。
    Evidence: plans/evidence/lock-advanced-window-mode/task-3-linux.txt
  ```

  **Commit**: NO | 不提交 | Files: `dsh-plugin-huaanwork/src/native-ui/setup-wizard/App.tsx`, `dsh-plugin-huaanwork/src/setup-wizard-contract.ts`, 上列 tests

- [ ] 4. 设置页和托盘不再提供模式切换

  **What to do**:
  - 在 `dsh-plugin-huaanwork/src/client/DesktopSettingsSection.tsx` 删掉三枚模式 `Choice`（约 746–770 行）和整个 `dsh-desktop-web-title` 浏览器/局域网 `<section>`（约 791–853 行）。窗口模式区块只在 `platform === 'darwin'` 时保留，并且只保留材质 `<select>`。Windows 上不再渲染「窗口模式」标题。
  - 不改 `src/client/desktop-settings.ts`，不新增 `capabilities` 字段。
  - 在 `dsh-plugin-huaanwork/src/electron-runtime.ts` 的 `buildTrayTemplate` 去掉模式子菜单及其前后为它而加的 separator（约 1125–1138 行）。不要把 `canToggleShellMode` 设为 false，不要改 `electron-platform.ts`。`changeMode` 若因此无人调用，删掉这个闭包，避免留下死的 `requestModeChange` 调用。
  - 更新 `tests/electron-runtime.spec.ts` 里期望托盘含「兼容模式 / 扩展窗口 / 增强模式」的用例（约 1543、1562、2100 行）：菜单项不再包含这三项。
  - 更新 `tests/client-desktop-settings.spec.ts` 里如果渲染了模式单选或浏览器开关的断言。只断言文案常量仍含「兼容模式」的用例可以保留。

  **Must NOT do**: 不改 `DesktopFrameTitlebarView.tsx`。增强模式不挂载兼容壳标题栏。不改 `electron-platform.ts`。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 5 | Blocked By: 无

  **References**:
  - Pattern: `dsh-plugin-huaanwork/src/client/DesktopSettingsSection.tsx:739-853` 模式单选与浏览器区。
  - Pattern: `dsh-plugin-huaanwork/src/electron-runtime.ts:1097-1140` 托盘模板。
  - Test: `dsh-plugin-huaanwork/tests/electron-runtime.spec.ts:2100` 三种托盘标签。

  **Acceptance Criteria**:
  - [ ] `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/electron-runtime.spec.ts tests/client-desktop-settings.spec.ts` 通过。
  - [ ] `rg -n "mode-compatibility|扩展窗口" dsh-plugin-huaanwork/src/electron-runtime.ts` 无匹配。
  - [ ] `rg -n "setMode\\('compatibility'\\)|setMode\\('extended'\\)" dsh-plugin-huaanwork/src/client/DesktopSettingsSection.tsx` 无匹配。

  **QA Scenarios**:
  ```
  Scenario: Windows 托盘没有模式子菜单
    Tool: bash
    Steps: 跑 electron-runtime.spec.ts 中构造 zh locale 托盘模板的用例。
    Expected: 标签列表不含 兼容模式、扩展窗口、增强模式；仍含打开与退出。
    Evidence: plans/evidence/lock-advanced-window-mode/task-4-tray.txt

  Scenario: 设置页没有模式单选
    Tool: bash
    Steps: rg 上述两条命令。
    Expected: 两条都无匹配，退出码 1。
    Evidence: plans/evidence/lock-advanced-window-mode/task-4-settings.txt
  ```

  **Commit**: NO | 不提交 | Files: `dsh-plugin-huaanwork/src/client/DesktopSettingsSection.tsx`, `dsh-plugin-huaanwork/src/electron-runtime.ts`, `dsh-plugin-huaanwork/tests/electron-runtime.spec.ts`, `dsh-plugin-huaanwork/tests/client-desktop-settings.spec.ts`

- [ ] 5. 确认没有新的变体漂移，并跑关联测试

  **What to do**:
  - 跑 Definition of Done 里的 vitest 文件列表。列表里没有 `tests/setup-wizard-contract.spec.ts`。`compatibility-shell.spec.ts`、`window-options.spec.ts`、`host-runtime-bridge.spec.ts`、`plugin.spec.ts` 应保持通过，因为壳实现和 `requestModeChange` 都还在，Linux 拒绝非兼容模式的断言也还在。
  - 跑 `node --test scripts/verify-desktop-variants.test.mjs`。
  - 跑 `corepack yarn check:desktop-variants`。记录失败路径。允许且仅允许已存在的 `src/electron-shell-generation.ts`。若多出本次编辑过的文件，把该文件已有的行为差收回去，或确认它本来就在 22 条白名单里；禁止新增白名单条目。
  - 把命令的最后 40 行写入 `plans/evidence/lock-advanced-window-mode/task-5-verify.txt`。

  **Must NOT do**: 不重打 Windows 安装包。不改白名单。不修 `electron-shell-generation.ts` 的既有缩放差异。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 无 | Blocked By: 1, 2, 3, 4

  **References**:
  - Guard: `scripts/verify-desktop-variants.test.mjs:155-170` 白名单恰好 22 条且无重复。
  - Guard: `scripts/verify-desktop-variants.mjs:142-143` `DesktopSettingsSection.tsx` 已在名单内。

  **Acceptance Criteria**:
  - [ ] 上面的 vitest 命令退出码 0。
  - [ ] 变体测试仍打印 `beta↔huaanwork allowlist 22`。
  - [ ] `check:desktop-variants` 的未登记路径只有 `src/electron-shell-generation.ts`，或该命令退出码 0。

  **QA Scenarios**:
  ```
  Scenario: 白名单条数不变
    Tool: bash
    Steps: node --test scripts/verify-desktop-variants.test.mjs
    Expected: 退出码 0，输出含 beta↔huaanwork allowlist 22。
    Evidence: plans/evidence/lock-advanced-window-mode/task-5-allowlist.txt

  Scenario: 没有新的未登记源码差
    Tool: bash
    Steps: corepack yarn check:desktop-variants
    Expected: 失败信息里不出现 profile.ts、profile-preferences.ts、App.tsx、setup-wizard-contract.ts、DesktopSettingsSection.tsx、electron-runtime.ts。profile.ts 与 setup-wizard-contract.ts 本来就在 22 条白名单里，允许它们的内容变化，不允许名单变长。
    Evidence: plans/evidence/lock-advanced-window-mode/task-5-variants.txt
  ```

  **Commit**: NO | 不提交 | Files: `plans/evidence/lock-advanced-window-mode/*`

## Final Verification Wave (MANDATORY - after ALL implementation tasks)
- [ ] F1. Plan Compliance Audit：对照 Must Have / Must NOT Have，确认补丁回写、三处 UI、契约、以及未改的文件列表。
- [ ] F2. Code Quality Review：确认没有给 `desktop-shell` 启动补丁写 `config`，没有新增白名单，非法模式仍抛错。
- [ ] F3. Real Manual QA：由 Task 5 的 vitest 与变体命令充当。不启动图形界面。
- [ ] F4. Scope Fidelity Check：diff 只触及本方案列出的 huaanwork 文件与测试。没有 Windows 重打包，没有 stable/beta 改动。

## Commit Strategy
不提交。实现完成后把 diff 留给用户决定。

## Success Criteria
- 在 macOS 与 Windows 上，新安装、旧的兼容/扩展 Profile、安全模式，下次启动都是增强模式，且浏览器访问和局域网访问为关。Linux 仍是兼容模式。
- 向导、设置页、托盘都没有模式切换。
- stable 与 beta 的源码不变，变体白名单仍是 22 条。
