# 单桌面改造后续任务验收证据

- 记录时间：2026-10-30（本地 UTC+8）
- 仓库：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`（`kawaiininja/HuaAnWork-Desktop`），分支 `refactor/huaanwork-followups`
- 快照 HEAD（记录时）：`cb48083b51`（`docs: record the dshmarket upgrade acceptance`）
- 性质：`docs/evidence/2026-10-30-single-desktop-followups.md` 登记的 F1–F13 的验收证据汇总。**本文件当前只含 F2 段**；F1 的证据在 `docs/evidence/2026-10-30-dshmarket-1.73.5-upgrade.md`，F3–F13 由 Task 13 在本文件补齐。
- 总则：本文件的每一项都是**只读核验记录**。F2 按用户裁定（2026-10-30）不创建、不修改任何分支保护或 ruleset。

## F2（P0）GitHub required checks 对齐 —— 仅证据核验

对应登记：`docs/evidence/2026-10-30-single-desktop-followups.md` §F2「Github required checks 对齐」（现状：CI 只剩六个 job；分支保护若仍按旧的 `desktop-linux` 或三桌面 cell 名配置，PR 会永久 pending）。

### 1. 核验时间与对象

| 项 | 值 |
|---|---|
| 核验时间（UTC） | `2026-10-30T07:17:43Z` |
| 核验时间（本地） | `2026-10-30 15:17:43 CST`（UTC+8） |
| 仓库全名（API 返回 `full_name`） | `kawaiininja/HuaAnWork-Desktop` |
| 所有者类型 | `owner.type=User`（个人仓库，**无组织层**） |
| 可见性 | `visibility=public` |
| 默认分支 | `master` |
| 认证身份 | `gh auth status` → `Logged in to github.com account kawaiininja (keyring)`；scopes `gist, read:org, repo, workflow` |

GitHub 远端：`origin` = `https://github.com/kawaiininja/HuaAnWork-Desktop.git`，`upstream` = `https://github.com/anywhere-labs/dsh-desktop.git`（上游）。**本段所有 `gh` 命令都显式写全 `repos/kawaiininja/HuaAnWork-Desktop/...`**，不依赖默认仓库解析。

### 2. Step 1：仓库设置（只读）

以下命令与输出为 2026-10-30T07:17Z 本次实跑原文，不是规划期快照。

**命令 A —— master 分支保护**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop/branches/master/protection
{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}
gh: Branch not protected (HTTP 404)
# exit 1
```

补充同一事实的第二种读法（`branches/master` 对象的 `protected` 字段）：

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop/branches/master --jq '"protected=\(.protected)"'
protected=false
# exit 0
```

结论：**master 无经典分支保护规则**（404 `Branch not protected`），`protected=false` 独立复现同一事实。

**命令 B —— 仓库 rulesets**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop/rulesets
[]
# exit 0
```

结论：**仓库无任何 ruleset**（返回空数组，非 404；即 ruleset 功能可用但未配置）。

**命令 C —— 默认分支**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop --jq '.default_branch'
master
# exit 0
```

结论：默认分支为 `master`，与命令 A 查询的分支一致。

**命令 D —— 仓库身份字段（补充，用于判定是否存在组织层）**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop --jq '"default_branch=\(.default_branch) visibility=\(.visibility) owner.type=\(.owner.type) owner.login=\(.owner.login) full_name=\(.full_name)"'
default_branch=master visibility=public owner.type=User owner.login=kawaiininja full_name=kawaiininja/HuaAnWork-Desktop
# exit 0
```

由于 `owner.type=User`，本仓库没有可继承规则的组织层：分支保护只能来自仓库级 branch protection 或仓库级 ruleset，而两者经命令 A/B 核实**均为空**。因此当前 **required status checks 集合为空**。

### 3. Step 2：CI job 名单

命令与输出原文：

```console
$ grep -n '^  [a-z0-9-]*:$' .github/workflows/ci.yml
6:  push:
23:  changes:
62:  check:
119:  desktop-windows:
176:  desktop-macos:
229:  gitleaks:
255:  upstream-command-windows:
# exit 0
```

`grep` 命中 7 行，其中 **`:6 push:` 不是 job** 而是 `on:` 触发器（`on:` 块在 `ci.yml:3-8`，`push.branches: [master]` 在 `:6-7`）；`jobs:` 键在 `ci.yml:20`。真正的 job 恰为六个：

| # | job id | 行号 | GitHub 上报的 check 名 | 运行条件（`if`） |
|---|---|---|---|---|
| 1 | `changes` | `:23` | `changes` | 无条件（永远运行，在 run 内分类变更路径） |
| 2 | `check` | `:62` | `check` | 无条件（`needs: changes`，但无 `if`） |
| 3 | `desktop-windows` | `:119` | `desktop-windows (dsh-plugin-huaanwork)` | `needs.changes.outputs.product == 'true'`（`:121`） |
| 4 | `desktop-macos` | `:176` | `desktop-macos (dsh-plugin-huaanwork)` | `needs.changes.outputs.product == 'true'`（`:178`） |
| 5 | `gitleaks` | `:229` | `gitleaks` | 无条件 |
| 6 | `upstream-command-windows` | `:255` | `upstream-command-windows` | `needs.changes.outputs.product == 'true'`（`:257`） |

**check 名的取法**：`ci.yml` 中没有 job 级 `name:` 键（`grep -n '^    name:' .github/workflows/ci.yml` 零命中），因此 check 名 = job id；但 `desktop-windows` / `desktop-macos` 有 `strategy.matrix`（`workspace: [dsh-plugin-huaanwork]`，`:127` / `:184`），矩阵展开的 check 名形如 `<job id> (<matrix 值>)`。这不是推断：见 §4 在 master HEAD 上直接观测到的 `desktop-macos (dsh-plugin-huaanwork)` 与 `desktop-windows (dsh-plugin-huaanwork)`。

本分支 `ci.yml` 已无 `desktop-linux`（`grep -c 'desktop-linux' .github/workflows/ci.yml` = `0`，exit 1），两处矩阵均只剩单 cell `dsh-plugin-huaanwork`。

### 4. 补充核验：GitHub 上实际存在的 check 名（只读）

为确认「required checks 该填哪个字符串」，读取 master HEAD 的 check runs（只读 GET）：

```console
$ SHA=$(gh api repos/kawaiininja/HuaAnWork-Desktop/commits/master --jq '.sha')
$ echo "$SHA"
b5ef3e84a7951941480b50a8749fe6714b8c9fc7
$ gh api "repos/kawaiininja/HuaAnWork-Desktop/commits/$SHA/check-runs?per_page=100" --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion)"' | sort -u
changes	completed	success
check	completed	success
desktop-linux (dsh-plugin-desktop)	completed	success
desktop-linux (dsh-plugin-desktop-beta)	completed	success
desktop-macos (dsh-plugin-desktop)	completed	success
desktop-macos (dsh-plugin-desktop-beta)	completed	success
desktop-macos (dsh-plugin-huaanwork)	completed	success
desktop-windows (dsh-plugin-desktop)	completed	success
desktop-windows (dsh-plugin-desktop-beta)	completed	success
desktop-windows (dsh-plugin-huaanwork)	completed	success
gitleaks	completed	success
upstream-command-windows	completed	success
# exit 0
```

该 commit 的元数据：`b5ef3e84a7`，`2026-10-28T22:10:40Z`（`Merge pull request #20 ...`），check 运行起始 `2026-10-28T22:11:15Z`，`app=github-actions`。

两条必须记录的差异事实：

1. **`origin/master` 的 `ci.yml` 仍是三 workspace 矩阵**：`git show origin/master:.github/workflows/ci.yml` 在 `:178` 与 `:277` 两处为 `workspace: [dsh-plugin-desktop, dsh-plugin-desktop-beta, dsh-plugin-huaanwork]`，并另有 `desktop-linux` job（master 版 `ci.yml:229`）。单桌面收窄（`ci.yml` −100/+7 行）只存在于本分支，`git rev-list --count origin/master..HEAD` = **25**，尚未合并。上面 12 个 check 名里多出的 6 个旧名——`desktop-linux (dsh-plugin-desktop)`、`desktop-linux (dsh-plugin-desktop-beta)`、`desktop-macos (dsh-plugin-desktop)`、`desktop-macos (dsh-plugin-desktop-beta)`、`desktop-windows (dsh-plugin-desktop)`、`desktop-windows (dsh-plugin-desktop-beta)`——正是这批将被删除的三桌面 cell。
2. **六个目标 check 名当前全部可在 master 上直接观测到**：`changes`、`check`、`gitleaks`、`upstream-command-windows`（裸名）+ `desktop-macos (dsh-plugin-huaanwork)`、`desktop-windows (dsh-plugin-huaanwork)`（矩阵后缀名）。即：若在本分支合并前就按这六个名字启用保护，同样能被现有 workflow 产出，旧名只是额外的非必需 check；合并后旧名自然消失，不会留下永不上报的 required 名。反之，若用**裸 job id**（`desktop-windows` / `desktop-macos`）配置 required checks，则永远不会有同名 check 上报，必然永久 pending —— 这是 F2 真正的命名陷阱。

### 5. 结论

- **master 无经典分支保护（404 `Branch not protected`，`protected=false`），仓库无任何 ruleset（`[]`），默认分支 `master`，所有者为个人账号（`owner.type=User`）⇒ 当前 required status checks 集合为空。**
- 因此**当前不存在**「旧 `desktop-linux` / 三桌面 cell 名导致 PR 永久 pending」的**结构性阻塞**：没有任何 required-check 配置可被满足或悬空。F2 登记的「分支保护若仍按旧 cell 名配置 ⇒ 永久 pending」在本仓库目前是**未触发的条件句**，不是已发生的故障。
- 六个 job 名单经 `grep` 与 `jobs:` 结构核实为 `changes`、`check`、`desktop-windows`、`desktop-macos`、`gitleaks`、`upstream-command-windows`；作为 **required check 名**时应写 `changes`、`check`、`desktop-windows (dsh-plugin-huaanwork)`、`desktop-macos (dsh-plugin-huaanwork)`、`gitleaks`、`upstream-command-windows`（§4 已在 GitHub 侧直接观测到全部六个字符串）。
- 剩余风险不是「配置错误」，而是「**尚未启用任何保护**」：master 可被直接 push、无必需 review、无必需 status check。这是仓库设置的现状事实，按用户裁定不在本项处置。

### 6. 用户裁定（2026-10-30）

- **本项只记录证据，不创建、不修改任何 branch protection 或 ruleset**；不改 workflow。
- 若将来启用分支保护，required status checks 应**恰为上述六个 job**（按 §4 的完整 check 名配置，不用裸矩阵 job id）。
- 该裁定是 F2 的处置边界：本次交付**仓库设置零变更**，差异交给人类在设置面处置。

### 7. 边界（未验证项，不得读作已验证）

- **未验证组织级 / 企业级 ruleset**：`owner.type=User` 表示本仓库无组织层，故组织级 ruleset 不适用于本仓库；企业层（若存在）未查询，属设置面，超出本项。
- **未创建 PR 验证 pending 行为**：`desktop-windows`、`desktop-macos`、`upstream-command-windows` 三个 job 带 `if: needs.changes.outputs.product == 'true'`（`ci.yml:121`/`:178`/`:257`），文档-only 变更下会被 skip。GitHub 对「skipped 的 required check 是否视为满足」的行为**未实测**（无 PR、无保护配置可供测试）；`ci.yml:21-22` 的注释表明设计取向是在 run 内分类（`changes` job 永远运行）而非用 workflow path filter，但该设计是否足以让 required checks 结论性收敛，仍需在启用保护后用一条真实 PR 验证。
- **未验证第三方 / GitHub App 检查**（如安全扫描类外部集成）能否作为 required check；§4 只列出 `app=github-actions` 的 check。
- **未验证仓库其他分支**的保护状态；本项只查 `master`（默认分支）。
- **未验证**规则集 API 的其他子资源（如 `rulesets/{id}`、bypass 列表）；`rulesets` 返回 `[]` 已足以判定「无 ruleset」。

### 8. 仓库设置零变更声明

- 本项执行的全部 GitHub 交互都是 `gh api` 的 **GET**：`branches/master/protection`、`branches/master`、`rulesets`、仓库元数据、`commits/master`、`commits/{sha}/check-runs`。没有使用 `-X` / `--method` / `-f` / `--input`，没有任何 PUT/POST/PATCH/DELETE。
- 未执行 `gh repo edit`、`gh api -X PUT .../protection`、`gh ruleset`（写子命令）等任何设置变更命令。
- 本地只做了只读 git 读取与一次 `git fetch origin master`（仅更新本地 remote-tracking ref，不改远端）。
- 工作树在核验前后均为「仅 `?? .gstack/`（未跟踪，不提交）」，本任务只提交本文件。
