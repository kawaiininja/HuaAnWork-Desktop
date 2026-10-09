# 上游同步准则与基准定义 (Upstream Synchronization Guide)

本文档定义 HuaAnWork-Desktop 对上游项目（`anywhere-labs/dsh-desktop`）进行同步时的唯一基准、纪律约束、落后量统计口径与永久 override 清单（裁定 R-M7-3，Task 6.1）。

---

## 1. 基准定义（唯一真相源）

- **唯一有效基准 ref**：`UPSTREAM_REF = upstream/master`
  其中 `upstream` 远端地址恒为 `https://github.com/anywhere-labs/dsh-desktop.git`。
- **唯一动态基准 merge-base**：`MERGE_BASE = git merge-base HEAD upstream/master`
  截至 2026-10-07，当前值为 `a934d988610605078001d7c22bbaa2435cbeb385`（2026-09-18）。
  **严禁在任何脚本或文档中硬编码 `a934d98861`**：M8 处置孤儿提交或进行 rebase 后，该散列值会发生变化，必须通过 `git merge-base` 动态解析。

### 明确否定三种错误基准

在进行同步分析与落后量统计时，必须**明确否定**以下三种错误基准：

1. ❌ **错误基准 1：fork 自己的 `origin/master`**
   - **否定理由**：在当前仓库内，`origin/master` 解析为 fork 自身的远端仓库（`kawaiininja/HuaAnWork-Desktop`）。若拿 `origin/master` 作为基准计算落后量，落后提交数恒为 0，会产生「完全无落后」的彻底误判。
2. ❌ **错误基准 2：本地镜像 master `upstream-local/master`**
   - **否定理由**：`upstream-local/master` 指向本地镜像目录（`../DSH Desktop`）的本地 `master` 分支，该分支携带了 3 个从未推送到上游的孤儿提交（`d1d8c81b5a`、`eb56d3a1c1`、`5737bcceb6`），且停留在 2026-09-19，不能代表上游官方最新状态。
3. ❌ **错误基准 3：`master...upstream-local/master` 的左/右计数（如 `195  0`）**
   - **否定理由**：右侧计数恒为 0，仅仅是因为本地镜像刚好停在 fork 的历史分支点附近，若将右侧 0 误读为落后量，会得出「已完全跟上上游」的致命错误结论（评估 L6）。

---

## 2. 镜像的使用纪律（Ref-Only 比较）

本地镜像目录 `../DSH Desktop` 的工作树**处于脏状态**（实测有 47 个既有 ` D` 删除项与 submodule ` m` 修改，包含 `vendor/dsh-runtime/0.1.5-rc.2/*.tgz`、`0.1.6-alpha.2/*.tgz`、`assets/*.png` 等；目录 mtime 为 09-18/09-23，非任何评估造成）。

### 纪律要求：
1. **禁止直接检查镜像工作树**：严禁使用 `ls`、`git status` 或读取工作树文件来判断「上游是否存在某文件/某改动」。
2. **只允许 ref 层面只读比较**：必须使用 Git 底层对象查询命令对镜像 ref（如 `origin/master`）进行只读比对：
   - `git ls-tree <ref> <path>`
   - `git show <ref>:<path>`
   - `git cat-file -e <ref>:<path>`
3. **关键陷阱警示**：
   在镜像工作树中被删除的文件恰恰包含 `vendor/dsh-runtime/0.1.6-alpha.2/*.tgz`，而「上游是否删除了 fork 硬钉的 runtime」是 M7 评估的关键结论之一。如果误查工作树文件，会把「本地工作树被删」当成「上游删除了该 runtime」，导致**结论碰巧正确但事实依据全错**。
4. **定位说明**：在添加了 `upstream` remote 之后，本地镜像仅作为「离线可用的一份历史副本」保留备查，**不再作为同步基准**。

---

## 3. 每个 Clone 与 Worktree 独立配置 Remote

Git 的 `.git/config` 本地配置文件不纳入版本控制。因此，为当前仓库建立真 `upstream` remote 是**每台开发机、每个独立 worktree 的一次性前置操作**：

```bash
git remote add upstream https://github.com/anywhere-labs/dsh-desktop.git
git fetch upstream --tags
```

若 remote 已存在但 URL 不正确，使用以下命令校正：

```bash
git remote set-url upstream https://github.com/anywhere-labs/dsh-desktop.git
git fetch upstream --tags
```

**看板脚本约束**：Task 6.2 的 `upstream-sync-dashboard.mjs` 脚本在检测到 `upstream` remote 或 `upstream/master` 缺失时，必须**立即明确报错并引导查阅本文档本小节**，严禁静默降级或吞错输出 0。

---

## 4. 落后量的登记口径与时效限定

任何关于「fork 落后上游 N 个提交」或「文件冲突面 M 个」的声称，必须显式附加 **as-of 时间戳** 与 **所使用的完整 ref 及 SHA**，严禁使用孤立的绝对数字。

- **历史评估基准**（不可直接继承为现值）：
  - as-of `2026-10-03 07:26:28 +0900`
  - 引用 ref：镜像内 `origin/master` @ `1030515b4358b39633c80d5857cab6114b9e3ba8`
  - 测得落后量：341 commits
- **Task 6.1 实测基准**：
  - as-of `2026-10-03 17:44:59 +0800`
  - 引用 ref：`upstream/master` @ `a1ff68b2960753ab1f6c90565bf3d9e3f3b7ae91`
  - 测得落后量：`git rev-list --count a934d98861..upstream/master` = **344 commits**
- **失效模式防范**：严禁在后续讨论中不加限定地直接引用历史数字，必须通过只读看板脚本重新刷新并登记当前时刻的 as-of 数据。

---

## 5. 同步的执行纪律

依据裁定 R-M7-3 与架构债表要求，实施上游大同步时必须严格遵守以下执行纪律：

1. **必须在独立分支/Worktree 执行**：阶段 B 的大同步操作严禁在主工作树上直接进行，必须新建隔离分支（如 `sync/upstream-v2`）或全新 worktree。
2. **大文件冲突合并原则**：
   - `yarn.lock`（上游漂移 13,947 行）与根目录 `package.json`（上游 1,811 行）：**严禁手工逐行三方合并**。必须采用「以最新上游版本为基底，在此基础上重放 fork 增量配置并重新执行依赖安装解析」的策略。
   - `upstream.json` 与 vendored runtime：存在 **modify-delete** 结构性冲突，必须按 fork 既有决策保留或受控替换。
3. **Submodule Pin 独立提交**：
   `deepseek-harness` submodule pin 更新（如 `ddefc45fbc → 639ed01539`）必须与 Desktop 业务行为代码修改严格分开，单独生成独立 commit（遵循 `AGENTS.md:37` 规范）。

---

## 6. 永久 Fork-Owned Override 清单

在多次同步迭代中，以下文件属于 fork 自有的永久性守卫或配置，每次同步都必须完整保留 fork 版本，压制上游对应文件的覆盖：

1. **`scripts/verify-desktop-variants.mjs`**：
   - 上游已将该文件缩减至 36 行、`allowedDifferences` 仅剩 1 项并引入 `normalizeIdentity`；
   - fork 维护着三通道完整守卫逻辑、三通道四元组及预算名单（22/6 与 19/0），必须整体保留 fork 版本。
2. **`scripts/expected-root-gate-scripts.json`**：
   - 纯 fork 自有的根门禁脚本逐字锁定 fixture（`fixtureVersion: 2`），上游无此文件。
3. **`scripts/market-manifest-byte-budget.json`**：
   - Task 4.1 引入的跨包清单字节上限配置，作为单源真相维护。
4. **跨边界读取 gate fixture 的 4 处测试与实现文件**：
   - `dsh-plugin-desktop/tests/package.spec.ts`
   - `dsh-plugin-desktop-beta/tests/package.spec.ts`
   - `dsh-plugin-huaanwork/tests/package.spec.ts`
   - `market-server/src/manifest-prepare.ts`
   - `dsh-plugin-huaanwork/tests/huaanwork-host/market-verify.spec.ts`

---

## 7. 阶段 A 与阶段 B 的边界界定

- **阶段 A（Phase 6：当前范围）**：
  - 仅负责机制建设与**不落地的可行性 Spike**（包括：真 `upstream` remote 接入、同步准则文档建立、只读看板脚本、冲突面分类与漂移基线盘点）。
  - 本阶段不落地任何业务代码合并，不修改已有工作树的主功能。
- **阶段 B（另立 M8）**：
  - 一次性大同步至 `0.2.0-rc.2`（估算 15–25 人日），将在独立里程碑 M8 中开展。
  - 以下三个前置裁定**随 M8 计划另行裁决，本阶段严禁预先裁定**：
    1. 3 个孤儿提交（`d1d8c81b5a`/`eb56d3a1c1`/`5737bcceb6`）的丢弃或重写；
    2. 基座跟进 `dsh-desktop-stable`/`beta` 还是迁往 `dsh-desktop-next`；
    3. 白名单预算模型采用「一次性临时预算」还是「长期分级收敛模型」。

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
