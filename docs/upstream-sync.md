# 上游同步准则与基准定义 (Upstream Synchronization Guide)

本文档定义 HuaAnWork-Desktop 单桌面仓对上游项目（`anywhere-labs/dsh-desktop`）的同步模型：**selective review**。仓库不再整仓合并上游，也不再维护 Stable / Beta / Next 三个参考桌面树；同步的唯一基准是 `desktop-upstream.json` 里的 `reviewedCommit`，执行方式是逐提交、逐文件的审阅与处置。

§1–§7 是现行规则；§8 起是整仓合并时代的看板读数快照，**只作历史阅读**。快照里的文件名、§6 条目编号（如「§6 第 1 条」）、Scope A/B/C 口径与结构性计数都是当时的记录，可能已被现行规则取代，不得据此推断当前清单或机制。

## 1. 基准定义：`desktop-upstream.json` 是唯一真相源

仓库根的 `desktop-upstream.json` 是同步基准的唯一真相源，字段固定：

- `schemaVersion`：当前恒为 `1`；其他值一律拒绝加载。
- `repository`：`https://github.com/anywhere-labs/dsh-desktop.git`。看板会把它与 `git remote get-url upstream` 逐字比对。
- `ref`：`upstream/master`。
- `reviewedCommit`：**已完整审阅并处置到的上游提交**，40 位完整小写 SHA。
- `sourcePackage`：历史端口来源标注，当前为 `dsh-plugin-desktop-beta`。参考树退出活跃构建面后，它不再提供任何可机器比对的对照物，也不是完整性或等价性判据（见 §7）。
- `watchedPaths`：看板分诊用的上游路径清单。以 `/` 结尾的条目按前缀匹配（目录型，如 `scripts/`、`vendor/`）；不带 `/` 的条目按整路径精确匹配（文件型，如 `package.json`、`deepseek-harness`）。清单作用于**上游提交里的路径**，不是本地工作树路径，因此可以（也应当）继续命名上游独有、本地已不存在的参考树目录。

### `reviewedCommit` 的语义

- 它表示「这条提交及之前的全部上游提交都已审阅完毕」，**不是**上游最新 tip，**不是** `git merge-base`，**不是** fork 的 `HEAD`，也**不是**某个 tag。
- 它必须是当前抓取的 `upstream/master` 的**祖先**；看板用 `git merge-base --is-ancestor reviewedCommit upstreamSha` 校验，不满足即报错，绝不输出零。
- 它只向前推进，且只在**整批完成**后推进（§4）。推进是人工编辑 JSON 并提交，看板不写回任何状态。
- 初始值 `44084bdae0d44cac56948a223048d9c31541d0d0`（2026-10-17，`chore(ci,test): prune obsolete tests and cache packaging downloads (#1399)`）是最后一次完整合并的上游侧提交。计算规则：在 `git rev-list --merges --parents HEAD`（新→旧）中，取第一个满足「其第二父提交是 `upstream/master` 祖先」（`git merge-base --is-ancestor <parent> upstream/master`）的父提交。该值恰好也是当时的合并点，但**此后不得把 merge-base 重新当作基准**：只认 `reviewedCommit`。若仓库历史变化导致计算结果不同，以实际计算值创建配置，并重新实测首批待审清单。
- 现值 `092e2ecef750d10db43cedbab8e81fd48c8de38e`（2026-10-29，首期 selective shelf 完成后推进；批次登记与证据见 §4）。

### 明确否定三种错误基准

1. ❌ fork 自己的 `origin/master`：落后量恒为 0，会得出「完全无落后」的彻底误判。
2. ❌ 本地镜像的 `upstream-local/master`：镜像可能停在旧提交、携带从未推送的孤儿提交，或干脆不存在（使用纪律见 §2）。
3. ❌ `master...upstream-local/master` 的左/右计数（如 `195  0`）：右侧 0 只是镜像恰好停在历史分支点附近，误读为落后量会得出「已完全跟上上游」的错误结论。

---

## 2. Remote 与本地镜像的使用纪律

### 每个 clone 与 worktree 独立配置 remote

`.git/config` 不纳入版本控制，真 `upstream` remote 是每台开发机、每个 worktree 的一次性前置操作：

```bash
git remote add upstream https://github.com/anywhere-labs/dsh-desktop.git
git fetch upstream --tags
```

remote 已存在但 URL 不正确时：

```bash
git remote set-url upstream https://github.com/anywhere-labs/dsh-desktop.git
git fetch upstream --tags
```

看板检测到 `upstream` remote 缺失、URL 与配置不符、或 `ref` 无法解析时，必须**立即报错并指向本文档**，严禁静默降级或吞错输出 0。

### 本地镜像只作离线只读副本

`../DSH Desktop` 这类本地镜像可能不存在、可能漂移，且曾长期处于脏工作树状态（含既有删除项与 submodule 修改）。纪律要求：

1. **禁止直接检查镜像工作树**：不得用 `ls`、`git status` 或读取工作树文件判断「上游是否存在某文件/某改动」。
2. **只允许 ref 层面只读比较**：`git ls-tree <ref> <path>`、`git show <ref>:<path>`、`git cat-file -e <ref>:<path>`。
3. 镜像不是基准：「落后多少」只以 `desktop-upstream.json` 与抓取后的 `upstream/master` 为准。

---

## 3. 看板：只读报告与 as-of / 完整 SHA 的登记口径

```bash
node scripts/upstream-sync-dashboard.mjs          # 文本
node scripts/upstream-sync-dashboard.mjs --json   # 机器可读
```

直接执行时只接受 `--json` 一个可选参数；其他参数一律报 usage 错误。

成功结果字段：

- 顶层：`ok`、`asOf`、`repository`、`ref`、`upstreamSha`、`upstreamCommitDate`、`reviewedCommit`、`sourcePackage`、`pendingCount`、`commits`。
- 每个 commit：`sha`、`date`、`subject`、`files.watched`、`files.unwatched`。

行为约定：

1. **不截断**：文本与 `--json` 都输出全部提交与全部 direct files。文本模式逐行列出 `watched:` / `unwatched:`，零 direct files 的提交显式标注 `(zero direct files)`；旧版「… and N more」式截断已退役。
2. **每个 direct file 恰好归类一次**：命中 `watchedPaths` 进 `watched`，否则进 `unwatched`；两边不重叠、不遗漏。
3. **merge 只算 direct files**：文件枚举用 `git -c core.quotePath=false diff-tree --no-commit-id --name-only -r --root`，不使用 `-m`，因此 merge 容器不重复子提交的文件（通常就是 `(zero direct files)`）。`-c core.quotePath=false` 让非 ASCII 路径按原样字节输出，而不是被 C 引号转义（`"\346\226\207..."`），否则这类路径无法与 `watchedPaths` 的字面前缀/整路径匹配，会被误分类。不使用重命名检测：改名会以「旧路径 + 新路径」两行出现，两行都会被分类。
4. **只读、不是门禁**：脚本只读本地 git ref，从不执行 `git fetch`。本地已有可解析的 `upstream/master` ref 时，它**可以完全离线工作**（实测：把 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 指向关闭端口后运行 `node scripts/upstream-sync-dashboard.mjs --json`，仍返回 `ok: true`、`upstreamSha` 与 `pendingCount`）；只有当本地没有该 ref、remote URL 与 `desktop-upstream.json` 不一致、`reviewedCommit` 不是该 ref 的祖先，或 `watchedPaths` 的某个非目录型条目在 `reviewedCommit` 解析不到文件时才会报错退出。读数时效仍取决于最后一次 `git fetch upstream`：未 fetch 的读数只是本地 ref 的陈旧值（见下节〈as-of 与完整 SHA 的登记口径〉），不是「离线必然失败」。因此【绝对不得接进 `package.json` 的任何 scripts，也不得接进任何 gate】。它的回归测试（`scripts/upstream-sync-dashboard.test.mjs`）是 hermetic 的：只用临时 Git 仓库，不访问网络、不创建也不读取任何参考桌面树。
5. **失败语义**：配置缺失、字段缺失或非法 SHA → `cannot load desktop-upstream.json ...`；remote URL 不符、ref 不可用、或 `reviewedCommit` 不是祖先 → `upstream ref is unavailable, or reviewedCommit is not an ancestor ...`；`watchedPaths` 中有非目录型条目在 `reviewedCommit` 解析不到文件 → `watchedPaths entry "<entry>" in desktop-upstream.json does not resolve to a file at reviewedCommit <sha>; directory entries must end with "/" ...`，脚本返回 `ok:false` 并点名该条目。判定用 `git ls-tree <reviewedCommit> -- <entry>` 的 mode 语义，**不用 `git cat-file -e`**：不带 `/` 的条目必须解析为文件 blob（`100644`/`100755`，symlink 为 `120000`）或 submodule gitlink（`160000`），`040000` 是 directory tree，必须写成 `<path>/`；`cat-file -e` 对 tree 同样成功，gitlink 的目标对象又不在本仓，两者都无法区分。三种错误都指向本文档，且绝不输出零。

### as-of 与完整 SHA 的登记口径

任何「落后 N 个提交」「本轮触及 M 个文件」的声称，必须同时给出：

- `asOf`（看板运行时刻，UTC ISO）；
- `reviewedCommit` 与 `upstreamSha` 的**完整 40 位 SHA**（正文可写短 SHA 便于阅读，但落盘证据必须是完整值）；
- `upstreamCommitDate`（上游提交时间）与 `pendingCount`。

新读数**追加**到证据文档，不改写旧快照（§8 的「不得覆盖历史记录」规则继续适用）。看板运行前先 `git fetch upstream`；未 fetch 的读数只是本地 ref 的陈旧值，必须如实注明。

---

## 4. 逐提交、逐文件的处置口径与整批推进

### 枚举范围

待审清单 = `git rev-list --reverse --topo-order reviewedCommit..upstreamSha`，按拓扑序（旧→新）覆盖**全部**提交：不抽样、不跳过 merge 容器、不只审「看起来相关」的提交。`pendingCount` 必须等于 `git rev-list --count reviewedCommit..upstreamSha`。

### 逐文件结论

每个提交的 `watched` 与 `unwatched` 文件都要看：`watchedPaths` 只是默认覆盖面，不是「只看这些就够」的边界（根级文档、workflow、打包脚本都可能是 `unwatched` 却仍与产品相关）。每个 direct file 登记且只登记一个结论：

| 结论 | 含义 | 证据要求 |
| --- | --- | --- |
| `SKIP` | 不适用于本产品，或属于上游自有设施 | 一句话理由，说明为什么与本产品无关 |
| `ALREADY` | fork 已有等价或更新的实现 | 本地路径 + 符号名（必要时附测试名或命令输出） |
| `PORT` | 需要移植进 HuaAnWork | 必须另行立项或裁定，不得在审阅批次里夹带移植 |

`PORT` 只是分诊结论，不等于授权改动；产品行为变化必须走自己的计划与门禁。

### 整批完成才推进

1. 本批**全部**提交与**全部** direct file 都有结论并落盘后，才把 `reviewedCommit` 推进到本批 `upstreamSha`。
2. 不得边审边推：中途推进会让未审提交从 `reviewedCommit..upstreamSha` 区间里静默消失。
3. 推进动作 = 人工编辑 `desktop-upstream.json` + 单独提交 + 在证据里给出推进前后的完整 SHA。
4. 需要补审历史时，只能把 `reviewedCommit` 回退到仍是 `upstreamSha` 祖先的提交，并在证据里说明原因；回退到非祖先提交会被看板拒绝。
5. `watchedPaths` 的增删只改变分诊口径，必须随理由一起提交；不得为了让某一批「看起来更小」而临时删条目。

### 依赖与打包文件

若某个 `PORT` 触及依赖闭包（`package.json`、`yarn.lock`、`.yarnrc.yml`、`patches/`、`vendor/`、`upstream.json`），以**本地**解析结果为准重新生成，不得把上游的锁文件或补丁整段搬入。移植与其依赖解析必须走独立提交，保持可回滚。

### 已完成的审阅批次（批次登记）

每完成一批，在本表**追加**一行；区间、完整 SHA 与证据文件是唯一可追溯凭据。§8 的历史快照不改写。

| 批次 | 区间（完整 SHA） | 提交数 | 逐文件结论 | 证据 | `reviewedCommit` 推进 |
| --- | --- | --- | --- | --- | --- |
| 首期 selective shelf（2026-10-29，Task 13） | `44084bdae0d44cac56948a223048d9c31541d0d0..092e2ecef750d10db43cedbab8e81fd48c8de38e` | 56（其中 14 个是零 direct file 的 merge 容器） | 2622 条 direct file：`SKIP` 2602、`ALREADY` 20、`PORT` 0（另有 14 条 merge 容器占位行，同为 `SKIP`） | `docs/evidence/2026-10-29-single-desktop-upstream-shelf.md` | `44084bdae0d44cac56948a223048d9c31541d0d0` → `092e2ecef750d10db43cedbab8e81fd48c8de38e` |

读数（**本地 ref，未 fetch**：本次运行环境离线，`git fetch upstream` 连接超时；`upstream/master` 最后一次前移是 2026-10-26 到 `092e2ecef7`）：

```text
upstream-sync-dashboard: as-of 2026-10-29T23:06:56.106Z / upstream commit 2026-10-24T19:10:34+08:00
  ref      = upstream/master @ 092e2ecef750d10db43cedbab8e81fd48c8de38e
  reviewed = 092e2ecef750d10db43cedbab8e81fd48c8de38e
  pending  = 0 commits
```

- 本批**无 `PORT`**：`7b3cddd2fe` 的跨 Profile 默认启用 browser 属产品行为变化，按本计划边界判 `SKIP`，登记到既有「huaanwork 未吸收上游 2.1 功能面」债（`AGENTS.md` 债表），不得作为本批夹带移植。
- 20 条 `ALREADY` 只覆盖已有等价或更新实现的文件（AA artifact/connector、`dshmarket` 1.70.2 patch、meshcall-router 的 `x64ArchFiles`、`package-win` 压缩覆盖等）；同一提交的其余文件继承 commit-default。
- 若 `upstream/master` 在本批之后前进，新提交保持 pending，必须另起一批处置，**不得**随本货架一起标记已审。

---

## 5. DeepSeek Harness pin 与 Desktop selective review 相互独立

`deepseek-harness/` 是 pinned submodule，其 pin 记录在 `upstream.json` 的 active channel（`commit` / `sourceVersion` / `runtimePackageVersion`），并拥有自己的 pnpm workspace。两条线互相独立：

1. 上游 Desktop 提交里的 `deepseek-harness` gitlink 变化，在 selective review 中只是一个 `watched` 文件条目（`watchedPaths` 里的 `deepseek-harness`）；它**不**意味着本仓要升级子模组。
2. Harness 升级是独立动作：必须连同 vendored runtime、`patches/`、根 `resolutions` 与 lockfile 一起验证，并**单独提交**子模组 pin（遵循 AGENTS.md 的 submodule 纪律）。
3. Harness 升级**不推进** `reviewedCommit`；`reviewedCommit` 只跟踪 Desktop 侧 `upstream/master` 的审阅进度。反之，审阅 Desktop 提交也不授权改动 Harness pin。

---

## 6. 永久 Fork-Owned Override 清单

本清单只列**当前仍有活跃消费方**的 fork 自有 fixture 与守卫。上游若出现同名文件，以 fork 版本为准；历史名单（含已退役项）见 §8 起的历史快照，那里出现的旧文件名属于历史，不代表现行清单。

1. **`scripts/expected-root-gate-scripts.json`**
   - 纯 fork 自有的根门禁脚本逐字锁定 fixture（`fixtureVersion: 3`），上游无此文件。
   - 消费方：`scripts/expected-root-gate-scripts.test.mjs`（`test:gate-scripts`）；`dsh-plugin-huaanwork/tests/package.spec.ts` 在运行时用 `readFileSync` 跨边界读取。
2. **`scripts/market-manifest-byte-budget.json`**
   - 清单字节上限的单一真相源（Task 4.1 引入），读写两侧不得互相 import。
   - 消费方：`market-server/src/manifest-prepare.ts`、`market-server/tests/manifest-byte-cap.spec.ts`、`dsh-plugin-huaanwork/tests/huaanwork-host/market-verify.spec.ts`。
3. **`dsh-plugin-huaanwork/tests/package.spec.ts`**
   - fork 专有包（上游无对侧文件）的门禁断言，包含对第 1 条 fixture 的跨边界读取。
4. **已退役（2026-10-30，Task 12）**：变体守卫脚本及其测试、以及两个参考桌面包的 `tests/package.spec.ts` 不再是 override。三个参考树已退出 workspace 并在阶段 B 物理删除，守卫没有活跃消费方，其 `allowedDifferences` / `oneSidedPrefixes` 名额不再有执行者。**不得**为了让「旧冲突面看起来一致」而重新引入三包守卫或等价清单（见 §7）。

---

## 7. 覆盖范围与明确的不声明

- **watchedPaths 只提供覆盖与分诊**：它决定一个上游 direct file 进 `watched` 还是 `unwatched`，不决定是否需要移植，也不验证移植是否正确。
- **三包机器同形核对已经消失**：参考树退出活跃构建面后，不存在「三包逐字节相同」或「变体白名单命中」这类机器核对。`sourcePackage` 只是历史来源标注，不是对照物。
- **显式不声明完整性或等价性**：selective review 的证据（逐提交/逐文件结论表、`ALREADY` 指向的本地符号）只证明「这一批的每个文件都被看过并给了结论」，**不**证明 HuaAnWork 与上游 Beta 在功能、行为或测试覆盖上等价，也**不**证明上游所有能力都已搬入。完整性只能由具体功能面计划单独声明。
- **不得误补三包守卫**：不得用「重建三包 diff 或守卫」来替代逐文件证据；这会重新引入已退役的维护面，并与单桌面拓扑冲突。

---

## 8. 看板首次运行记录

本节记录落后量与冲突面看板脚本（`scripts/upstream-sync-dashboard.mjs`）的**阶段 A 基线快照**，作为后续 M8 规划的基准起点。
后续定期巡检时，新运行输出必须**以追加方式记录在本节之后，不得覆盖历史记录**，以保持历史 as-of 序列的完整可追溯性。

### 首次运行快照（2026-10-06 / 2026-10-07）

```text
upstream-sync-dashboard: as-of 2026-10-06T23:10:07.856Z / upstream commit 2026-10-03T17:44:59+08:00
  ref        = upstream/master @ a1ff68b2960753ab1f6c90565bf3d9e3f3b7ae91
  merge-base = a934d988610605078001d7c22bbaa2435cbeb385 (2026-09-18T09:10:55+08:00)
  behind     = 344 commits   ahead = 222 commits
  overlap (三个口径分别计,不相加):
    whitelist            : 21/36  (beta↔huaanwork 22 + stable↔beta 19, 去重后 36)
      hits (21):
        - scripts/generate-windows-app-icon.mjs
        - scripts/mac-universal.ts
        - scripts/verify-packaged-runtime.ts
        - scripts/verify-profile-boot.mjs
        - src/client/DesktopSettingsSection.tsx
        - src/client/desktop-settings-api.ts
        - src/client/desktop-settings-locales.ts
        - src/client/index.ts
        - src/electron-runtime.ts
        - src/host-runtime-bridge.ts
        - src/index.ts
        - src/main.ts
        - src/native-ui/setup-wizard/App.tsx
        - src/profile-manager.ts
        - src/profile-preferences.ts
        - src/profile.ts
        - src/setup-wizard-contract.ts
        - src/setup-wizard-window.ts
        - src/update-checker.ts
        - src/update-download.ts
        … and 1 more
    threePackageIdentical: 45/162  (三包 src/ 逐字节相同的隐含同步面)
      hits (45):
        - client/DesktopNativeActions.tsx
        - client/assets.d.ts
        - client/contracts.ts
        - client/desktop-settings-styles.ts
        - client/desktop-settings.ts
        - client/environment.ts
        - client/layout-service.ts
        - client/layout-state.ts
        - client/styles.ts
        - client/window-service.ts
        - desktop-cli.ts
        - desktop-logger.ts
        - desktop-plugins.ts
        - diagnostic-export.ts
        - directory-picker-contract.ts
        - electron-platform.ts
        - electron-shell-generation.ts
        - host-bootstrap.ts
        - host-process-entry.ts
        - host-process.ts
        … and 25 more
    permanentOverride    : 3/8  (docs/upstream-sync.md §6 列的 fork-owned 文件)
      hits (3):
        - dsh-plugin-desktop-beta/tests/package.spec.ts
        - dsh-plugin-desktop/tests/package.spec.ts
        - scripts/verify-desktop-variants.mjs
  note: read-only. Not wired into any gate. Re-run after `git fetch upstream` and record the as-of pair.
```

### 快照数据解读与分母对账
1. **落后量与提前量**：落后上游 `upstream/master` 344 个提交，fork 领先 222 个提交（基于动态 `merge-base`：`a934d98861`）。
2. **白名单面（Scope A）**：分母 36（`beta↔huaanwork` 22 条与 `stable↔beta` 19 条差异名单去重后 36 个源码/脚本路径），其中 21 个在上游改动中被触及。
3. **三包同形面（Scope B）**：分母 162（三个包 `src/` 并集 293 个文件，交集 187 个文件，逐字节哈希一致 162 个文件）。Task 3.2 规范化清扫的 7 个死模块本来就在 162 内部且前后均保持逐字节对齐，故分母稳固保持 162（与 `AGENTS.md:51` 债表一致），其中 45 个在上游改动中被触及。
4. **永久 Override 面（Scope C）**：分母 8（本文件 §6 动态声明的 8 个 fork 专有控制文件），其中 3 个在上游改动中存在同名更新（`scripts/verify-desktop-variants.mjs` 以及两个 package.spec.ts），同步时必须坚决压制上游覆盖。

---

### M8 阶段 B 实施刷新快照（Task 0.1 / 2026-10-09）

```text
upstream-sync-dashboard: as-of 2026-10-09T00:56:21.062Z / upstream commit 2026-10-08T12:44:38+08:00
  ref        = upstream/master @ ca52ce2cd9ac872358e9a9464902e3c7ee4d494f
  merge-base = a934d988610605078001d7c22bbaa2435cbeb385 (2026-09-18T09:10:55+08:00)
  behind     = 350 commits   ahead = 242 commits
  overlap (三个口径分别计,不相加):
    whitelist            : 21/36  (beta↔huaanwork 22 + stable↔beta 19, 去重后 36)
      hits (21):
        - scripts/generate-windows-app-icon.mjs
        - scripts/mac-universal.ts
        - scripts/verify-packaged-runtime.ts
        - scripts/verify-profile-boot.mjs
        - src/client/DesktopSettingsSection.tsx
        - src/client/desktop-settings-api.ts
        - src/client/desktop-settings-locales.ts
        - src/client/index.ts
        - src/electron-runtime.ts
        - src/host-runtime-bridge.ts
        - src/index.ts
        - src/main.ts
        - src/native-ui/setup-wizard/App.tsx
        - src/profile-manager.ts
        - src/profile-preferences.ts
        - src/profile.ts
        - src/setup-wizard-contract.ts
        - src/setup-wizard-window.ts
        - src/update-checker.ts
        - src/update-download.ts
        … and 1 more
    threePackageIdentical: 47/162  (三包 src/ 逐字节相同的隐含同步面)
      hits (47):
        - client/DesktopNativeActions.tsx
        - client/assets.d.ts
        - client/contracts.ts
        - client/desktop-settings-styles.ts
        - client/desktop-settings.ts
        - client/environment.ts
        - client/layout-service.ts
        - client/layout-state.ts
        - client/styles.ts
        - client/window-service.ts
        - desktop-cli.ts
        - desktop-logger.ts
        - desktop-plugins.ts
        - diagnostic-export.ts
        - directory-picker-contract.ts
        - electron-platform.ts
        - electron-shell-generation.ts
        - host-bootstrap.ts
        - host-process-entry.ts
        - host-process.ts
        … and 27 more
    permanentOverride    : 3/8  (docs/upstream-sync.md §6 列的 fork-owned 文件)
      hits (3):
        - dsh-plugin-desktop-beta/tests/package.spec.ts
        - dsh-plugin-desktop/tests/package.spec.ts
        - scripts/verify-desktop-variants.mjs
  note: read-only. Not wired into any gate. Re-run after `git fetch upstream` and record the as-of pair.
```

### M8 Phase 0 快照数据解读与双向复核
1. **基准与双向复核**：
   - `merge-base`：`git merge-base HEAD upstream/master` 输出为 `a934d988610605078001d7c22bbaa2435cbeb385`（2026-09-18T09:10:55+08:00），与历史 merge-base 保持一致，上游未重写历史。
   - `behind`：`git rev-list --count a934d98861..upstream/master` = 350（与看板输出一致；较首次快照 344 增加 6 个提交）。
   - `ahead`：`git rev-list --count upstream/master..HEAD` = 242，且 `git rev-list --count a934d98861..HEAD` = 242（与看板输出一致；较首次快照 222 增加 20 个提交）。
2. **白名单面（Scope A）**：分母 36（`beta↔huaanwork` 22 + `stable↔beta` 19 去重后 36 项），触及 21 项（与首次快照 21 项一致）。
3. **三包同形面（Scope B）**：分母 162，触及 47 项（较首次快照 45 项净增 2 项：上游新改动额外触及了同形面文件）。
4. **永久 Override 面（Scope C）**：分母 8，触及 3 项（与首次快照一致，仍为两个 `package.spec.ts` 与 `scripts/verify-desktop-variants.mjs`）。

### M8 Phase 5 看板对齐（2026-10-10）

本注追加在既有 as-of 快照之后，不改写上文任何数字。首次快照的 behind 344，以及 Phase 0 快照的 behind 350 / ahead 242、merge-base `a934d98861`、白名单分母 36，都仍是合并前的历史读数。

对齐读数用的是本地 ref，没有 `git fetch`，也没有推送。命令在 HEAD `4ade24c3aa` 上执行：

- `git merge-base HEAD upstream/master` = `ca52ce2cd9ac872358e9a9464902e3c7ee4d494f`（Phase 2 合并点，等于当时本地 `upstream/master`，提交时间 2026-10-08 12:44:38 +0800）。
- `git rev-list --count HEAD..upstream/master` = 0。
- `git rev-list --count upstream/master..HEAD` = 283。

Phase 3 重塑之后，变体守卫 `scripts/verify-desktop-variants.mjs` 仍是 §6 第 1 条永久 override。Phase 0 快照的 permanentOverride 命中里已经有这个文件，和「仍是第 1 条」一致。重塑后的结构性计数（stable↔beta 7、beta↔huaanwork 64、前缀 6;M9 后以 AGENTS 债表为准）写在 §6 第 1 条，不要把上文的 22+19 分母当成当前清单规模。

本地实施至 Phase 5 在本分支完成。推送与 CI 对账是 Phase 6，尚未进行。本注不声明上游同步已推送。
