# 单桌面维护 · 阶段 B 运行期消费方与 market peer 政策(已裁定)

> **性质**:Task 9 实测证据 + 用户裁定记录;§10 追加 Task 11 的删除执行结果。Task 9 本轮只写文档:**未运行** `sync-vendored-runtime.mjs --write`、**未删除**任何 vendor 目录或 patch、**未修改** `upstream.json` 或任何包 manifest、**未运行** `yarn install`。**Task 11 已于 2026-10-30 按 §6 精确删除,见 §10**;§1–§9 保持 Task 9 当时的读数原样,不因删除而回改。
> **状态**:**两个政策字段已于 2026-10-30 由用户明确裁定**(`stableHistorical: "retain"` / `dormantAlpha1: "retire"`,见 §7)。最终 market peer range = `0.2.0-rc.2 || 0.2.1-rc.1`。裁定已落定,Task 10 才可执行 `--write`;Task 11 才删资产。**裁定不等于删除计划变更**(见 §5、§6)。

## 0. 基线

| 字段 | 值 |
| --- | --- |
| 仓库 | `/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop` |
| 分支 | `refactor/huaanwork-single-desktop-maintenance` |
| **实测 HEAD** | **`8fc54c4d8093f11ebf5559e468ceb43ce9e343f7`**(`docs: record phase A single-desktop acceptance`,2026-10-30T00:32:13+08:00) |
| 阶段 A 恢复点(Task 8) | `156e71d0a267e88ab4fe80fbaf59671958992c11`;HEAD 是其直接后代且只含证据 |
| 计划基线(`git merge-base origin/master HEAD`) | `b5ef3e84a7951941480b50a8749fe6714b8c9fc7` |
| As-of | 2026-10-29T16:40:01Z(2026-10-30 00:40 +08) |
| 裁定日期 | **2026-10-30**(用户明确裁定;§7) |
| 主机 / 工具 | macOS 27.0.1 arm64;Node v22.23.2;Yarn 4.18.0(Corepack) |
| 工作区 | 干净,唯一未跟踪项为 `.gstack/`;本证据文件在提交前亦为未跟踪 |

计数复核(2026-10-30,同一 HEAD 重跑 §2 脚本与 `grep -c` 口径):`0.2.0-rc.2` split **0** / 行 **0** / resolutions **636**;`0.2.1-alpha.1` split **0** / 行 **0** / resolutions **642**;`0.2.1-rc.1` split **957** / 行 **638** / resolutions **682**。与 §2/§3 一致。

计划中的「当前实测基线」(计划 `:816-827` 与本任务 brief `:33-44`)是在**计划基线 `b5ef3e84a7`** 上测得的。阶段 A Task 1(`a0ffa551f8`,`refactor(root): make HuaAnWork the only active desktop workspace`)把 `dsh-plugin-desktop` / `dsh-plugin-desktop-beta` / `dsh-desktop-next` 移出根 `workspaces` 并重解了 lockfile,因此本任务在 HEAD 上的实测与计划基线存在两处差异 —— 见 §3。

## 1. market bundle 加载证据(Step 1 第 1 条命令)

`rg` 在本 shell 只是交互别名,以下使用等价 `grep`:

```bash
grep -rnE 'dsh-community-market|dshmarket' \
  dsh-plugin-desktop/src dsh-plugin-desktop-beta/src dsh-desktop-next/src dsh-plugin-huaanwork/src \
  --include='*.ts' --include='*.tsx'
```

实测合计 **55 命中 / 30 文件**:stable 12/7、beta 12/7、next 15/5、huaanwork 16/11。

### 1.1 stable(`dsh-plugin-desktop`)

```
dsh-plugin-desktop/src/desktop-market.ts:32:    packageName: 'dsh-community-market',
dsh-plugin-desktop/src/desktop-market.ts:37:    packageName: 'dshmarket',
dsh-plugin-desktop/src/desktop-plugins.ts:52:  'dsh-community-market',
dsh-plugin-desktop/src/profile.ts:866: * The `dshmarket` bundle is filtered before resolution unless explicitly selected.
dsh-plugin-desktop/src/profile.ts:1186:    throw new Error(`${BIN_NAME}: dshmarket bundle patch must insert exactly the canonical dsh-market row`)
dsh-plugin-desktop/src/profile.ts:1370:      marketFailure = `${BIN_NAME}: selected dshmarket bundle layer is unavailable`
dsh-plugin-desktop/src/setup-wizard-copy.ts:142:    communityMarket: 'dsh-community-market',
dsh-plugin-desktop/src/setup-wizard-copy.ts:222:    communityMarket: 'dsh-community-market',
dsh-plugin-desktop/src/client/desktop-settings.ts:120:    key: 'dshmarket',
dsh-plugin-desktop/src/client/DesktopSettingsSection.tsx:299:const COMMUNITY_MARKET_URL = 'https://github.com/anywhere-labs/deepseek-harness-desktop/tree/master/dsh-community-market'
dsh-plugin-desktop/src/client/desktop-settings-locales.ts:72:  communityMarket: 'dsh-community-market',
dsh-plugin-desktop/src/client/desktop-settings-locales.ts:202:  communityMarket: 'dsh-community-market',
```

### 1.2 beta(`dsh-plugin-desktop-beta`)

与 stable 逐行相同(同为 12 命中 / 7 文件,行号一致:`desktop-market.ts:32/37`、`desktop-plugins.ts:52`、`profile.ts:866/1186/1370`、`setup-wizard-copy.ts:142/222`、`client/desktop-settings.ts:120`、`client/DesktopSettingsSection.tsx:299`、`client/desktop-settings-locales.ts:72/202`)。

### 1.3 huaanwork(`dsh-plugin-huaanwork`)

```
dsh-plugin-huaanwork/src/desktop-market.ts:32:    packageName: 'dsh-community-market',
dsh-plugin-huaanwork/src/desktop-market.ts:37:    packageName: 'dshmarket',
dsh-plugin-huaanwork/src/desktop-market.ts:41-45:  huaanworkMarket identity (provider 'huaanwork-market', rowId 'huaanwork-market',
                                                   packageName 'dsh-plugin-huaanwork/huaanwork-market')
dsh-plugin-huaanwork/src/desktop-plugins.ts:52:  'dsh-community-market',
dsh-plugin-huaanwork/src/profile.ts:967: * The `dshmarket` bundle is filtered before resolution unless explicitly selected.
dsh-plugin-huaanwork/src/profile.ts:1281:    throw new Error(`${BIN_NAME}: dshmarket bundle patch must insert exactly the canonical dsh-market row`)
dsh-plugin-huaanwork/src/profile.ts:1514:      marketFailure = `${BIN_NAME}: selected dshmarket bundle layer is unavailable`
dsh-plugin-huaanwork/src/setup-wizard-copy.ts:142:    communityMarket: 'dsh-community-market',
dsh-plugin-huaanwork/src/setup-wizard-copy.ts:222:    communityMarket: 'dsh-community-market',
dsh-plugin-huaanwork/src/huaanwork-host/market/routes.ts:21:import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
dsh-plugin-huaanwork/src/huaanwork-host/market/normalize.ts:14:import type { CatalogSnapshot } from 'dsh-community-market/contracts'
dsh-plugin-huaanwork/src/huaanwork-host/plugins-host.ts:53:  'dsh-community-market',
dsh-plugin-huaanwork/src/client/desktop-settings.ts:120:    key: 'dshmarket',
dsh-plugin-huaanwork/src/client/DesktopSettingsSection.tsx:288:const COMMUNITY_MARKET_URL = 'https://github.com/anywhere-labs/deepseek-harness-desktop/tree/master/dsh-community-market'
dsh-plugin-huaanwork/src/client/desktop-settings-locales.ts:68:  communityMarket: 'dsh-community-market',
dsh-plugin-huaanwork/src/client/desktop-settings-locales.ts:197:  communityMarket: 'dsh-community-market',
dsh-plugin-huaanwork/src/client-huaanwork/logic/market.ts:14:/** MarketView 页内 tab 联合（形态参照 dsh-community-market MarketSettingsTab，重写为 renderer 实现）。
```

### 1.4 next(`dsh-desktop-next`,参考树,Task 14 删除)

```
dsh-desktop-next/src/profiles.ts:20:export const COMMUNITY_MARKET_PACKAGE = 'dsh-community-market'
dsh-desktop-next/src/profiles.ts:21:export const DSH_MARKET_PACKAGE = 'dshmarket'
dsh-desktop-next/src/native-ui/onboarding.tsx:90:    { value: 'community', title: 'dsh-community-market', ... }
dsh-desktop-next/src/extensions.ts:31:  // dshmarket installs through the bundled pnpm; Community Market manages
dsh-desktop-next/src/extensions.ts:101:    /** dshmarket uses the official CLI so installs/removals also reconcile Profile bundles. */
dsh-desktop-next/src/client/plugin-controls.tsx:11:import { readMarketState } from '../../../dsh-community-market/src/client/api.ts'
dsh-desktop-next/src/client/plugin-controls.tsx:211:          const response = await fetch('/dshmarket/settings', ...)
dsh-desktop-next/src/client/plugin-controls.tsx:217:          // Fallback to default dshmarket region when unavailable.
dsh-desktop-next/src/client/market-toggle.ts:4:export const COMMUNITY_MARKET = 'dsh-community-market'
dsh-desktop-next/src/client/market-toggle.ts:5:export const DSH_MARKET = 'dshmarket'
dsh-desktop-next/src/client/market-toggle.ts:8:export type BuiltInMarketKey = 'dsh-1024store' | 'dshfind' | 'dshmarket'
dsh-desktop-next/src/client/market-toggle.ts:108:    key: 'dshmarket',
dsh-desktop-next/src/client/market-toggle.ts:227:      marketKey: 'dshmarket',
dsh-desktop-next/src/client/market-toggle.ts:256:  if (marketKey === 'dshmarket') {
dsh-desktop-next/src/client/market-toggle.ts:259:      marketKey: 'dshmarket',
```

### 1.5 这些命中说明什么

- **真实加载路径,不只是文案**:三个出货通道的 `desktop-market.ts` 都把 `community-market` 声明为可选 provider(identity `{rowId: 'community-market', packageName: 'dsh-community-market'}`),`profile.ts` 在选定该 provider 时插入同名 Loader row(stable/beta `:1355,1361-1362`;huaanwork `:1486,1492-1493`),`desktop-plugins.ts:52` / `plugins-host.ts:53` 把它列为不可移除 bundle,`package.json` 把它列为依赖(stable `:316`、beta `:331`、huaanwork `:397`)。
- **huaanwork 有第三面**:除 community / dshmarket 外还有自带内网 wrapper `dsh-plugin-huaanwork/huaanwork-market`(`desktop-market.ts:41-47`,`profile.ts:1338` 三向 identity 解析);wrapper 只从 `dsh-community-market/contracts` 取 schema(`market/routes.ts:21`、`market/normalize.ts:14`),不加载 market 的运行时。
- **stable / beta 的命中是历史安装实例的加载先例**:删除参考树只能删除源码,不能推断历史安装实例里没有选择过 `community-market` provider —— 这是 `stableHistorical: retain` 的证据,见 §7。

## 2. lane 计数(Step 1 第 2 条命令,原样脚本)

```bash
node --input-type=module <<'NODE'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
const root = JSON.parse(readFileSync('package.json', 'utf8'))
const selectors = Object.keys(root.resolutions ?? {})
const lockText = readFileSync('yarn.lock', 'utf8')
const versions = new Set(readdirSync('vendor/dsh-runtime'))
for (const name of readdirSync('patches')) {
  if (name.startsWith('dsh')) versions.add(name.match(/@([^@]+)\.patch$/u)?.[1])
}
for (const version of [...versions].filter(Boolean).sort()) {
  const resolutions = selectors.filter(selector => selector.endsWith(`@npm:${version}`) || selector.endsWith(`@npm:^${version}`)).length
  const lockReferences = lockText.split(`vendor/dsh-runtime/${version}/`).length - 1
  const patches = readdirSync('patches').filter(name => name.endsWith(`@${version}.patch`)).length
  console.log(`${version}\tvendor=${existsSync(`vendor/dsh-runtime/${version}`)}\tresolutions=${resolutions}\tlockReferences=${lockReferences}\tpatches=${patches}`)
}
NODE
```

HEAD 实测输出(逐字):

```
0.1.5-rc.2	vendor=false	resolutions=0	lockReferences=0	patches=12
0.1.7-alpha.2	vendor=true	resolutions=0	lockReferences=0	patches=18
0.1.7-rc.1	vendor=true	resolutions=0	lockReferences=0	patches=19
0.1.7-rc.2	vendor=true	resolutions=0	lockReferences=0	patches=21
0.2.0-rc.1	vendor=true	resolutions=0	lockReferences=0	patches=21
0.2.0-rc.2	vendor=true	resolutions=636	lockReferences=0	patches=22
0.2.1-alpha.1	vendor=true	resolutions=642	lockReferences=0	patches=21
0.2.1-rc.1	vendor=true	resolutions=682	lockReferences=957	patches=22
```

## 3. 与计划基线的逐项比对

| lane | 计划基线(resolutions / lock / patches) | HEAD 实测 | 结论 |
| --- | --- | --- | --- |
| `0.1.5-rc.2` | 0 / 0 / 12 | 0 / 0 / 12 | 一致(`vendor=false`) |
| `0.1.7-alpha.2` | 0 / 0 / 18 | 0 / 0 / 18 | 一致 |
| `0.1.7-rc.1` | 0 / 0 / 19 | 0 / 0 / 19 | 一致 |
| `0.1.7-rc.2` | 0 / 0 / 21 | 0 / 0 / 21 | 一致 |
| `0.2.0-rc.1` | 0 / 0 / 21 | 0 / 0 / 21 | 一致 |
| `0.2.0-rc.2` | 636 / **900** / 22 | 636 / **0** / 22 | **lock 引用不一致(900 → 0)** |
| `0.2.1-alpha.1` | 642 / 0 / 21 | 642 / 0 / 21 | 一致 |
| `0.2.1-rc.1` | 682 / **966** / 22 | 682 / **957** / 22 | **lock 引用不一致(966 → 957)** |

### 3.1 计划基线在 `b5ef3e84a7` 上可以逐字复现

在计划基线提交上重跑同一脚本(读 `git show b5ef3e84a7:package.json` / `:yarn.lock`,vendor 与 patches 用工作区):

```
0.1.5-rc.2	resolutions=0	lockReferences=0	patches=12
0.1.7-alpha.2	resolutions=0	lockReferences=0	patches=18
0.1.7-rc.1	resolutions=0	lockReferences=0	patches=19
0.1.7-rc.2	resolutions=0	lockReferences=0	patches=21
0.2.0-rc.1	resolutions=0	lockReferences=0	patches=21
0.2.0-rc.2	resolutions=636	lockReferences=900	patches=22
0.2.1-alpha.1	resolutions=642	lockReferences=0	patches=21
0.2.1-rc.1	resolutions=682	lockReferences=966	patches=22
```

即计划/brief 的基线数字本身正确,但它是**阶段 A 之前**的读数。

### 3.2 差异原因(已用 git 核实)

阶段 A Task 1 的 `a0ffa551f8` 从根 `workspaces` 删除了 `dsh-plugin-desktop`、`dsh-plugin-desktop-beta`、`dsh-desktop-next`,并连带重解 `yarn.lock`(该提交 `yarn.lock` **+1762/−9070** 行;复测:`git show --shortstat --format='' a0ffa551f8 -- yarn.lock`)。旧记的 `+1776/−9107` 不是 lock 单文件读数:该值等于本提交 `yarn.lock` 与 `package.json` 之和(`git show --numstat a0ffa551f8` 给出 `package.json` +14/−37、`yarn.lock` +1762/−9070)。后果:

- `git show b5ef3e84a7:yarn.lock | grep -c 'vendor/dsh-runtime/0.2.0-rc.2/'` = **600**;`HEAD` 同命令 = **0**。
- `git diff b5ef3e84a7..HEAD -- yarn.lock` 删除 600 行 rc.2 vendor 引用、新增 **0** 行 ⇒ split 口径 900 → 0。
- rc.1 在该 diff 中 −12/+6 行(被剪掉的是随参考 workspace 消失的重复/未打补丁条目)⇒ split 口径 966 → 957、`grep -c` 行口径 644 → **638**。
- 根 `resolutions` 仍是 1975 个键,其中 rc.2 636、rc.1 682、alpha.1 642 三套**未变**;变化只发生在 lockfile 解析结果。

### 3.3 因此不能写"rc.2 无消费方",但可以写"rc.2 无 lock 解析消费"

HEAD 上 `0.2.0-rc.2` 的真实形状(vs 计划 brief 的断言):

| 消费面 | 位置 | 性质 |
| --- | --- | --- |
| lock 解析 | `yarn.lock` | **0 处**(阶段 A 后已无解析) |
| 声明式 resolutions | 根 `package.json` 636 个 selector(318 包 × 精确/caret 两条) | 仍然存在但**未解析**(悬空映射,`yarn install` 不消费) |
| 通道元数据 | `upstream.json:5-10`(`stable.commit/sourceVersion/runtimePackageVersion/runtimeSource`) | 仍然存在,由 `sync-vendored-runtime` 读取 |
| **政策函数输入** | `scripts/vendored-runtime-policy.mjs:13` 读 `channels.stable.sourceVersion` 拼 market peer | **活的代码消费** |
| 测试钉 | `dsh-plugin-huaanwork/tests/package.spec.ts:104,411-413,422,427-430` | 断言 rc.2 selector 仍存在(Task 10 重写) |
| 测试钉 | `scripts/vendored-runtime-policy.test.mjs`(三通道键) | 阶段 A 断言(Task 10 替换) |
| 资产 | `vendor/dsh-runtime/0.2.0-rc.2/`(318 包,20 MiB)+ 22 个 patch | 存在,无构建期 glob 消费 |

`0.2.1-alpha.1` 同形:0 处 lock 解析、642 个悬空 resolutions、无任何通道指向它、`vendored-runtime-policy.mjs:14` 硬编码、44 个 market DSH peer 全带该腿、`dsh-community-market/tests/contracts.spec.ts:45-51,60` 与 `package.spec.ts:418-424,435-438` 钉住、21 patch + 25 MiB vendor。

## 4. 旧 lane 的禁用面(Step 1 第 3 条命令)

```bash
git grep -l -E 'vendor/dsh-runtime/(0\.1\.7-alpha\.2|0\.1\.7-rc\.1|0\.1\.7-rc\.2|0\.2\.0-rc\.1|0\.2\.0-rc\.2|0\.2\.1-alpha\.1)' \
  -- ':!docs' ':!dsh-plugin-desktop' ':!dsh-plugin-desktop-beta' ':!dsh-desktop-next' \
  ':!vendor' ':!yarn.lock' ':!package.json' ':!AGENTS.md'
```

实测输出(唯一命中):

```
upstream.json
```

- 该命令排除了 `docs/`、三棵参考树、`vendor/`、`yarn.lock`、`package.json`、`AGENTS.md`,因此它回答的是「**阶段 A 之后仍会存活的文件里,谁还硬编码旧 lane 的 vendor 路径**」⇒ 只有 `upstream.json`(stable 通道一条;`0.2.0-rc.1` 等更旧 lane 无任何命中)。
- 补充扫描 `git grep -ln 'vendor/dsh-runtime'`(同样排除 docs/vendor/lock/参考树)命中 4 个文件:`AGENTS.md`、`package.json`、`scripts/sync-vendored-runtime.mjs`、`upstream.json`。**没有任何构建/打包/验证脚本 glob `vendor/dsh-runtime/*`**;`sync-vendored-runtime.mjs` 只按通道的 `sourceVersion` 拼路径。
- 补充扫描 `git grep -n '0\.2\.0-rc\.2'`(活跃文件)的命中全部落在 §3.3 表格内(`upstream.json`、根 `package.json` 的 resolutions、`dsh-community-market/package.json` 的 44 条 peer、`vendored-runtime-policy.mjs`、两个测试文件);`0.2.1-alpha.1` 同形,另加 `scripts/sync-vendored-runtime.mjs:67-68` 的注释(「Remove it when the lane is retired」)。

## 5. 边界:Stable peer 历史腿 ≠ Stable runtime 消费方

1. peer 串是「market bundle 可接受的宿主 DSH 版本」声明,**不安装、不解析、不构建、不打补丁**。`dsh-community-market` 的 44 个 DSH peer 当前全部是 `0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1`。
2. 阶段 A 之后根 lock 对 rc.2 的解析引用为 **0**;三个参考 workspace 已移出根 `workspaces`;`check:vendored-runtime` 只跑 `--channel huaanwork`。
3. 因此 `stableHistorical: "retain"` **只保留 market 串里的一个版本腿**,不要求保留 `vendor/dsh-runtime/0.2.0-rc.2/`、其 22 个 patch,也不要求保留 636 个 resolutions —— Task 10 照常清 resolutions,Task 11 照常删资产。
4. 反向也成立:`stableHistorical: "retire"` 不会改变 rc.2 资产的删除计划(两种裁定下 Task 11 都删六个目录与 134 个 patch)。**两个政策字段与资产删除解耦**,只决定 market peer 串的最终形状。
5. **2026-10-30 裁定落地后**:`stableHistorical: "retain"` 生效 ⇒ market 串保留 `0.2.0-rc.2` 一段文本;**rc.2 的 vendor 目录、22 个 patch、636 条 resolutions 仍全部删除/清理**。这条边界是本次裁定的核心,不能被读成「Stable 仍在被支持运行」。

## 6. 允许删除的资产集合(由 §2/§3 的计数导出,实际删除在 Task 11)

| 删除对象 | 数量 | 规模 | 证据 |
| --- | --- | ---: | --- |
| `vendor/dsh-runtime/0.1.7-alpha.2/` | 1 目录 | 15.7 MiB | resolutions 0 / lock 0 |
| `vendor/dsh-runtime/0.1.7-rc.1/` | 1 目录 | 15.8 MiB | 0 / 0 |
| `vendor/dsh-runtime/0.1.7-rc.2/` | 1 目录 | 20.4 MiB | 0 / 0 |
| `vendor/dsh-runtime/0.2.0-rc.1/` | 1 目录 | 20.4 MiB | 0 / 0 |
| `vendor/dsh-runtime/0.2.0-rc.2/` | 1 目录 | 20.5 MiB | resolutions 636(悬空)/ lock 0 |
| `vendor/dsh-runtime/0.2.1-alpha.1/` | 1 目录 | 25.4 MiB | resolutions 642(悬空)/ lock 0 / 无通道 |
| 上述六目录合计 | 6 目录 | **118.2 MiB** | `vendor/dsh-runtime` 全量 143 MiB,保留 rc.1 25 MiB |
| `patches/*@{0.1.5-rc.2,0.1.7-alpha.2,0.1.7-rc.1,0.1.7-rc.2,0.2.0-rc.1,0.2.0-rc.2,0.2.1-alpha.1}.patch` | **134** 个 | — | 12+18+19+21+21+22+21 |

保留:`vendor/dsh-runtime/0.2.1-rc.1/`(341 包,manifest commit `1600d8a1e14`,25 MiB)、`patches/*@0.2.1-rc.1.patch` 22 个、**非 DSH patch 9 个**(`app-builder-lib@26.15.7`、`fs-ext@2.1.1`、`node-pty@1.2.0-beta.15`、`open@11.0.1`、`open@11.0.4`、`pi-ai@0.87.1`、`pi-ai@1.0.2`、`pnpm@11.8.0`、`vscode-ripgrep@1.18.0`)。`patches/` 合计 165 = 134(删)+ 22(rc.1)+ 9(非 DSH)。

### 顺序(不可交换)

**Task 10 先清 resolutions/lock,Task 11 才删资产**;完整理由与失败模式见 §8.2。

## 7. 政策裁定(用户裁定,2026-10-30)

### 7.1 精确值

| 字段 | 精确位置 | 用户裁定 | 裁定日期 |
| --- | --- | --- | --- |
| `stableHistorical` | `upstream.json.marketPeerPolicy.stableHistorical` | **`"retain"`** | **2026-10-30** |
| `dormantAlpha1` | `upstream.json.marketPeerPolicy.dormantAlpha1` | **`"retire"`** | **2026-10-30** |

Task 10 要写入 `upstream.json` 的精确 JSON 片段:

```json
"marketPeerPolicy": {
  "stableHistorical": "retain",
  "dormantAlpha1": "retire"
}
```

由此得到的最终 market peer range:

```
0.2.0-rc.2 || 0.2.1-rc.1
```

(与计划 Task 10 的默认值一致;`0.2.1-alpha.1` 腿消失,`0.2.1-rc.1` 仍是活跃 HuaAnWork / Beta lane。)

### 7.2 `stableHistorical: "retain"` —— 裁定与证据

**裁定:保留 Stable 历史腿。**

证据链:

1. **stable / beta / huaanwork 都有真实的 Community Market 加载路径**,不是文案残留(§1.5):`desktop-market.ts` 把 `community-market` 声明为可选 provider identity;`profile.ts` 在选定该 provider 时插入同名 Loader row(stable/beta `:1355,1361-1362`;huaanwork `:1486,1492-1493`);`desktop-plugins.ts:52` / `plugins-host.ts:53` 列为不可移除 bundle;各包 `package.json` 把它列为依赖。命中密度 stable 12/7 文件、beta 12/7、huaanwork 16/11(§1)。
2. **删除源码无法证明历史安装实例从未选择该 provider**:本里程碑只删三棵参考树(Task 14),删除的是**今天可读的源码**,不是**过去用户 profile 里写下的选择**。已安装的 Stable 实例若在 profile 中留过 `community-market` row,其运行期仍需 market bundle 接受宿主版本 `0.2.0-rc.2`;把该腿从 peer 串删掉会让这类实例在 peer 校验上失败。
3. **代价只有一个 peer 字符串分支**:`stableHistorical: "retain"` 只让 `marketPeerRange()` 拼出 `0.2.0-rc.2` 一段文本,不安装、不解析、不构建、不打补丁;它**不要求保留** `vendor/dsh-runtime/0.2.0-rc.2/`、其 22 个 patch 或 636 条 resolutions(§5)。

### 7.3 `dormantAlpha1: "retire"` —— 裁定与证据

**裁定:退役 alpha.1 休眠腿。**

证据链:

1. **Next 已迁到 rc.1**:`dsh-desktop-next/package.json` 的全部 `@deepseek-ai/dsh*` 依赖均为 **`0.2.1-rc.1`**(无一条 alpha.1);R-M9-R1(2026-10-18)即已把 Next 升到 rc.1,alpha.1 lane 自此休眠。
2. **没有任何通道指向 alpha.1**:`upstream.json.channels` 三条分别是 stable `0.2.0-rc.2`、beta `0.2.1-rc.1`、huaanwork `0.2.1-rc.1`;`grep -c '0.2.1-alpha.1' upstream.json` = **0**。
3. **lock 引用为 0**:§2/§3 的 split 口径与行口径都是 0(2026-10-30 复核仍为 0);只有 642 条**悬空** resolutions,没有一个 workspace/通道在解析它。
4. **脚本自身写明了退役动作**:`scripts/sync-vendored-runtime.mjs:67-68` 的注释 ——「The third leg is the dormant alpha.1 lane retained in the frozen market peer string; Next has consumed rc.1 since R-M9-R1. **Remove it when the lane is retired.**」本裁定即触发该分支。
5. **与删除无消费方资产一致**:alpha.1 的 vendor 目录(25.4 MiB、21 patch)本就在 §6 的删除集合里;退役 peer 腿与删资产同向,不留下「资产已删、peer 串还宣称支持」的失实声明。

### 7.4 四种组合矩阵(供 Task 10 测试预期核对)

| stableHistorical | dormantAlpha1 | `marketPeerRange` |
| --- | --- | --- |
| retain | retain | `0.2.0-rc.2 \|\| 0.2.1-rc.1 \|\| 0.2.1-alpha.1` |
| **retain** | **retire** | **`0.2.0-rc.2 \|\| 0.2.1-rc.1`(本次裁定 / 计划默认)** |
| retire | retain | `0.2.1-rc.1 \|\| 0.2.1-alpha.1` |
| retire | retire | `0.2.1-rc.1` |

### 7.5 裁定的消费面(哪些代码必须随裁定更新)

裁定的唯一落地点是 market peer 串。它被下列各处读取/钉住,Task 10 与 Task 15 必须按上表精确更新:

| 消费点 | 现值 | 裁定后 |
| --- | --- | --- |
| `upstream.json` | 无 `marketPeerPolicy` 字段;三通道 | 加 `marketPeerPolicy` 两字段;只留 huaanwork 通道(计划 Task 10 Step 3) |
| `scripts/vendored-runtime-policy.mjs:11-16` | 硬编码 stable+beta+`0.2.1-alpha.1`;注释(`:10`)称「frozen for Phase A」 | 只从 active HuaAnWork + 显式政策构造(计划 `:951-971`) |
| `scripts/vendored-runtime-policy.test.mjs` | 三腿固定断言 | 四种政策组合 + 真实文件断言(计划 `:871-896`) |
| `dsh-community-market/package.json` | **44 条** `@deepseek-ai/dsh*` peer 全为 `0.2.0-rc.2 \|\| 0.2.1-rc.1 \|\| 0.2.1-alpha.1` | `0.2.0-rc.2 \|\| 0.2.1-rc.1` |
| `dsh-community-market/tests/contracts.spec.ts` | 硬编码三腿 | 从 `upstream.json` 读政策构造 `expectedPeerRange` |
| `dsh-plugin-huaanwork/tests/package.spec.ts` | 断言 rc.2 selector 存在、stable/beta/alpha.1 分区 | 只断言 rc.1 解析(计划 `:924-937`) |
| 计划 Task 15 结构验收 | `range === '0.2.0-rc.2 \|\| 0.2.1-rc.1'` | 不变(与裁定一致) |

计划默认值与本裁定一致,故 **Task 15 的结构断言、四政策测试、44 条 peer 断言的目标值都不需要改写** —— 只需按计划把它们从硬编码改成读政策。

### 7.6 不得写「rc.2 无消费方」

裁定保留 rc.2 的 peer 腿,但 rc.2 的**资产**照常删除。两个事实必须分开陈述,不得合并成一句「rc.2 无消费方」:

| rc.2 的消费面(HEAD 实测) | 值 |
| --- | --- |
| lock 解析引用 | **0**(阶段 A Task 1 后;计划基线上是 900) |
| 悬空 resolutions | **636**(仍指向 `file:vendor/dsh-runtime/0.2.0-rc.2/...`,未解析) |
| 通道 | `upstream.json.channels.stable`(`sourceVersion` / `runtimePackageVersion` / `runtimeSource`) |
| 政策输入 | `scripts/vendored-runtime-policy.mjs:13` 读 `channels.stable.sourceVersion` 拼 peer |
| 测试钉 | `dsh-plugin-huaanwork/tests/package.spec.ts` 断言 rc.2 selector 仍存在 |
| 资产 | `vendor/dsh-runtime/0.2.0-rc.2/`(318 包,20.5 MiB)+ 22 patch |

准确表述:**rc.2 有 0 处 lock 解析消费,但仍有 636 条悬空 resolutions、Stable 通道元数据、活的政策函数输入和一个测试钉。**「保留历史 peer 腿」是政策选择,不是「rc.2 还在运行」。

## 8. 本轮范围、顺序与后续

### 8.1 本轮做了什么 / 没做什么

做了:实测 market 加载面(§1)、八个 lane 的计数(§2)、与计划基线的逐项比对(§3)、旧 lane 的禁用面(§4)、边界与删除集合(§5/§6)、记录用户 2026-10-30 的两个政策裁定(§7)。

**没做**(全部留给后续任务,本轮只写文档):

- 未运行 `node scripts/sync-vendored-runtime.mjs --write`(任何 channel)
- 未 `git rm` 任何 `vendor/dsh-runtime/<lane>/` 目录或 `patches/*.patch`
- 未修改 `upstream.json`(`marketPeerPolicy` 尚不存在;三通道仍在)
- 未修改任何包 manifest(`dsh-community-market` 的 44 条 peer 仍是三腿)
- 未运行 `yarn install`、未改 `yarn.lock`、未改 `scripts/`

### 8.2 顺序(不可交换)

1. **Task 10 先**:把 §7.1 的 JSON 写进 `upstream.json.marketPeerPolicy`,然后 `node scripts/sync-vendored-runtime.mjs --write --channel huaanwork` + `corepack yarn install`。这一步清掉 **636(rc.2)+ 642(alpha.1)= 1278** 条悬空 resolutions 并把 market peer 写成 `0.2.0-rc.2 || 0.2.1-rc.1`。
2. **Task 11 后**:`git rm -r` §6 的六个 vendor 目录 + 134 个 patch。
3. 理由:这些 resolutions 现在仍指向 `file:vendor/dsh-runtime/<lane>/...`;先删资产会让 1278 条映射悬空,`yarn install` / 打包 / 门禁会在 Task 10 完成前就失败。Task 11 的失败测试(`package.spec.ts`「keeps only the active DSH runtime vendor lane」)也要求 Task 10 的 resolutions 已收敛。

### 8.3 交付边界

本证据是 Task 9 的唯一产物;**它不授权任何删除或 `--write`**,只记录裁定与消费方事实。裁定与计划的默认值一致,因此 Task 10 / 15 的目标值无需改写,只需把硬编码三腿改成读 `upstream.json.marketPeerPolicy`(§7.5)。

## 9. 复现命令

```bash
# §1(等价 rg;--include 代替 --glob)
grep -rnE 'dsh-community-market|dshmarket' \
  dsh-plugin-desktop/src dsh-plugin-desktop-beta/src dsh-desktop-next/src dsh-plugin-huaanwork/src \
  --include='*.ts' --include='*.tsx'

# §2 见上方原样 Node 脚本

# §4
git grep -l -E 'vendor/dsh-runtime/(0\.1\.7-alpha\.2|0\.1\.7-rc\.1|0\.1\.7-rc\.2|0\.2\.0-rc\.1|0\.2\.0-rc\.2|0\.2\.1-alpha\.1)' \
  -- ':!docs' ':!dsh-plugin-desktop' ':!dsh-plugin-desktop-beta' ':!dsh-desktop-next' \
  ':!vendor' ':!yarn.lock' ':!package.json' ':!AGENTS.md'
git grep -ln 'vendor/dsh-runtime' -- ':!docs' ':!vendor' ':!yarn.lock' \
  ':!dsh-plugin-desktop' ':!dsh-plugin-desktop-beta' ':!dsh-desktop-next'

# §3.2 交叉核对
git show b5ef3e84a7:yarn.lock | grep -c 'vendor/dsh-runtime/0.2.0-rc.2/'
grep -c 'vendor/dsh-runtime/0.2.0-rc.2/' yarn.lock
grep -c 'vendor/dsh-runtime/0.2.1-rc.1/' yarn.lock

# §7.1 / §7.3 裁定前提复核
grep -c '0.2.1-alpha.1' upstream.json                     # 期望 0(无通道指向 alpha.1)
node -e "const p=require('./dsh-desktop-next/package.json'); \
  const d=Object.entries({...p.dependencies,...p.devDependencies}) \
    .filter(([k])=>/^@deepseek-ai\/dsh($|-)/u.test(k)); \
  console.log(d.filter(([,v])=>v!=='0.2.1-rc.1'))"      # 期望 []
node -e "const p=require('./dsh-community-market/package.json'); \
  const r=new Set(Object.entries(p.peerDependencies) \
    .filter(([k])=>/^@deepseek-ai\/dsh($|-)/u.test(k)).map(([,v])=>v)); \
  console.log(Object.keys(p.peerDependencies).length, [...r])"  # 期望 47 / 三腿单串
```

## 10. Task 11 执行结果:六个 retired lane 与七组 patch 已删除(2026-10-30)

> **本节点改写 §8.1 的「没做」清单**:§1–§9 是 Task 9 的实测与裁定记录,保持原样;§10 是 Task 11 执行后的实际状态。
> **前置**:Task 10 已完成于 `881681b4fd`(`refactor(runtime): make market peer history an explicit policy`)—— `upstream.json` 只剩 `huaanwork` 通道 + `marketPeerPolicy`,market peer 为 `0.2.0-rc.2 || 0.2.1-rc.1`,根 `resolutions` 收敛为 **697** 条(682 rc.1 + 15 非 DSH),lock 对 rc.2 / alpha.1 的 vendor 解析引用均为 **0**(§8.2 的不可交换顺序已满足)。

### 10.1 先写失败测试(RED)

`dsh-plugin-huaanwork/tests/package.spec.ts` 新增守卫(从 `node:fs` 增 import `readdirSync`),断言 `vendor/dsh-runtime/` 与 `patches/` 的 DSH 版本族**只有**当前 runtime lane:

```ts
it('keeps only the active DSH runtime vendor lane and patch family', () => {
  expect(readdirSync(new URL('vendor/dsh-runtime', workspaceRoot))).toEqual([runtimeVersion])
  const dshPatchVersions = readdirSync(new URL('patches', workspaceRoot))
    .filter(name => name.startsWith('dsh'))
    .map(name => name.match(/@([^@]+)\.patch$/u)?.[1])
  expect(new Set(dshPatchVersions)).toEqual(new Set([runtimeVersion]))
})
```

`corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts` 删除前实测(RED,逐字截取):

```
 FAIL  tests/package.spec.ts > published package surface > keeps only the active DSH runtime vendor lane and patch family
AssertionError: expected [ '0.1.7-alpha.2', '0.1.7-rc.1', …(5) ] to deeply equal [ '0.2.1-rc.1' ]

- Expected
+ Received

  [
+   "0.1.7-alpha.2",
+   "0.1.7-rc.1",
+   "0.1.7-rc.2",
+   "0.2.0-rc.1",
+   "0.2.0-rc.2",
+   "0.2.1-alpha.1",
    "0.2.1-rc.1",
  ]

 Test Files  1 failed (1)
      Tests  1 failed | 74 passed | 1 skipped (76)
```

### 10.2 实际删除

`git rm` 只按 §6 的已记录版本精确执行;命令与 brief Step 2 逐字一致。

| 删除的 vendor 目录 | 删除前跟踪文件数 |
| --- | ---: |
| `vendor/dsh-runtime/0.1.7-alpha.2/` | 310 |
| `vendor/dsh-runtime/0.1.7-rc.1/` | 310 |
| `vendor/dsh-runtime/0.1.7-rc.2/` | 318 |
| `vendor/dsh-runtime/0.2.0-rc.1/` | 319 |
| `vendor/dsh-runtime/0.2.0-rc.2/` | 319 |
| `vendor/dsh-runtime/0.2.1-alpha.1/` | 322 |
| **合计** | **6 目录 / 1898 个跟踪文件** |

| 删除的 patch 族 | 个数 |
| --- | ---: |
| `patches/*@0.1.5-rc.2.patch` | 12 |
| `patches/*@0.1.7-alpha.2.patch` | 18 |
| `patches/*@0.1.7-rc.1.patch` | 19 |
| `patches/*@0.1.7-rc.2.patch` | 21 |
| `patches/*@0.2.0-rc.1.patch` | 21 |
| `patches/*@0.2.0-rc.2.patch` | 22 |
| `patches/*@0.2.1-alpha.1.patch` | 21 |
| **合计** | **134** |

- 该提交合计:**`2034 files changed, 127 insertions(+), 20422 deletions(-)`**(复测:`git show --shortstat --format='' 96dc22189c`;构成 = 1898 vendor 文件 + 134 patch + 本文件 `+118/−1` 与 `dsh-plugin-huaanwork/tests/package.spec.ts` `+9`,逐文件读数见 `git show --numstat --format='' 96dc22189c`。原记的 `2032 files changed, 20421 deletions(-)` 在 HEAD 复测差 2 文件 / 1 行,属记录误差)。行数口径:**`manifest.json` 计入**——1898 个 vendor 文件中有 6 个是该 lane 的 `manifest.json`(合计 13 298 行删除),其余 1892 个为二进制 tarball、不计行(复测:`git show --numstat --format='' 96dc22189c -- vendor/`,字段 1 为 `-` 的行数 = 1892;6 个 `manifest.json` 的 `numstat` 第二个字段之和 = 13 298)。
- `patches/` 从 **165** → **31** 个文件。
- 未删除(硬排除项全部保持):`vendor/dsh-runtime/0.2.1-rc.1/`(342 个跟踪文件 = 341 tarball + `manifest.json`)、`patches/*@0.2.1-rc.1.patch`(22)、`.yarn/patches/dshmarket-desktop.patch`、9 个非 DSH patch(`app-builder-lib@26.15.7`、`fs-ext@2.1.1`、`node-pty@1.2.0-beta.15`、`open@11.0.1`、`open@11.0.4`、`pi-ai@0.87.1`、`pi-ai@1.0.2`、`pnpm@11.8.0`、`vscode-ripgrep@1.18.0`)、`vendor/agents-anywhere/`(17 MiB,provenance commit `64c3f67`)。三棵参考树无任何暂存文件(暂存删除里 `dsh-plugin-desktop*`/`dsh-desktop-next/` 命中 = 0)。

**保留 lane** = `vendor/dsh-runtime/0.2.1-rc.1/`(341 包,manifest commit `1600d8a1e14`)+ `patches/*@0.2.1-rc.1.patch` 22 个。`vendor/dsh-runtime` 体积 **143 MiB → 25 MiB**。

### 10.3 `git grep` 复核(删除后)

```bash
# a) §4 的原命令(排除 docs / 三棵参考树 / vendor / lock / 根 manifest / AGENTS.md)
git grep -l -E 'vendor/dsh-runtime/(0\.1\.7-alpha\.2|0\.1\.7-rc\.1|0\.1\.7-rc\.2|0\.2\.0-rc\.1|0\.2\.0-rc\.2|0\.2\.1-alpha\.1)' \
  -- ':!docs' ':!dsh-plugin-desktop' ':!dsh-plugin-desktop-beta' ':!dsh-desktop-next' \
  ':!vendor' ':!yarn.lock' ':!package.json' ':!AGENTS.md'
# 结果:无任何命中(删除前唯一命中 upstream.json,Task 10 已收敛为单通道 rc.1)

# b) 全仓(含 docs)指向已删 lane 的 vendor 路径
git grep -c -E 'vendor/dsh-runtime/(0\.1\.5-rc\.2|0\.1\.7-alpha\.2|0\.1\.7-rc\.1|0\.1\.7-rc\.2|0\.2\.0-rc\.1|0\.2\.0-rc\.2|0\.2\.1-alpha\.1)' -- docs
# 结果(HEAD):docs 9 文件 / 47 个匹配行(计划、M9 epic 等,其中本文件 21 行含上方代码块与本节自引),有意不回改
git grep -l -E 'vendor/dsh-runtime/(0\.1\.5-rc\.2|0\.1\.7-alpha\.2|0\.1\.7-rc\.1|0\.1\.7-rc\.2|0\.2\.0-rc\.1|0\.2\.0-rc\.2|0\.2\.1-alpha\.1)' -- ':!docs'
# 结果:无非文档命中

# c) `vendor/dsh-runtime` 的存活引用(排除 docs / vendor / lock / 参考树)
git grep -ln 'vendor/dsh-runtime'
# AGENTS.md / package.json(全部 rc.1 解析)/ scripts/sync-vendored-runtime.mjs(按通道拼路径)
# / upstream.json(单通道 rc.1)/ dsh-plugin-huaanwork/tests/package.spec.ts(新守卫)
```

b) 的 docs 计数有四个可复现读数(同一 `git grep -c` 表达式,逐文件求和):`96dc22189c^`(本小节写入前)= **10 文件 / 41 行**;`96dc22189c`(本小节写入后)= **10 文件 / 47 行**;`fe5fc0a73d`(feat(upstream): report the selective review backlog)之后 = **9 文件 / 46 行**;HEAD = **9 文件 / 47 行**。差额构成:`fe5fc0a73d` 重写 `docs/upstream-sync.md`,该文件原有的 1 行旧 lane vendor 路径(`vendor/dsh-runtime/0.1.5-rc.2/*.tgz`)随重写消失,故文件数 `10 → 9`、行数 `47 → 46`;随后 `912e7ef238`(F5 订正)在上文段落里引用同一路径字面量,令本文件命中 `20 → 21`,行数 `46 → 47`、文件数不变。即 HEAD 的 47 = `fe5fc0a73d` 之后的 46 + 本节自引 1。复测:`git grep -c -E '<上式>' -- docs | awk -F: '{s+=$NF} END{print s}'` 与 `git grep -c -E '<上式>' 96dc22189c -- docs | awk -F: '{s+=$NF} END{print s}'`;若排除本文件的解释性自引(`':!docs/evidence/2026-10-29-single-desktop-runtime-consumers.md'`)则为 **8 文件 / 26 行**。

补充核对:lock 里已删 lane 的 vendor 路径命中 **0**;`grep -c 'vendor/dsh-runtime/0.2.1-rc.1/' yarn.lock` = **638**;根 `resolutions` 697 条中 rc.1 占 682。仍出现旧版本**字符串**(非路径)的活跃文件均为注释 / 政策串 / 任意 fixture(如 `vendored-runtime-policy.mjs` 的 `0.2.0-rc.2` 保留腿、`vendored-runtime-policy.test.mjs` 的四政策断言、`verify-profile-boot.mjs:109` 的伪造 peer、`platform-login.ts:10` 的历史注释),与资产是否存在无关。

### 10.4 Step 3 门禁(串行执行,全部 PASS)

| 命令 | 结果 |
| --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts` | `Test Files 1 passed (1)` / `Tests 75 passed, 1 skipped (76)`(GREEN) |
| `corepack yarn check:vendored-runtime` | `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified` |
| `corepack yarn aa:check` | exit 0;`Selected AA main at 64c3f67ee3b270c1740da4da9dfae56d6217c8e4` / `AA release verified: HuaAnWork uses 64c3f67ee3b2…`(AA `main` 仍为 provenance 记录的 `64c3f67`,未前进 ⇒ 未运行 `aa:prepare-release`) |
| `corepack yarn install --immutable` | exit 0;`Done with warnings in 1s 408ms`(仅既有 `YN0002`/`YN0086` peer 提示;lockfile 未变) |
| `find vendor/dsh-runtime -mindepth 1 -maxdepth 1 -type d -print` | 见下 |

```
$ find vendor/dsh-runtime -mindepth 1 -maxdepth 1 -type d -print
vendor/dsh-runtime/0.2.1-rc.1
```

### 10.5 边界

- 删除的是**资产**,不是政策:market peer 仍为 `0.2.0-rc.2 || 0.2.1-rc.1`(§7.2 的 `stableHistorical: retain` 只保留字符串腿,§5 已声明它不要求保留 rc.2 的 vendor 目录 / 22 个 patch / resolutions)。
- 新增的 `package.spec.ts` 守卫让「资产消失」可回归:任何旧 lane 目录或旧 DSH patch 族被重新引入都会变红。
- `git grep` 的 docs 命中是历史计划与 M9 epic 的原文,**不是**活的消费方;后续若要统一口径,属于文档整理而非本任务的删除范围。
