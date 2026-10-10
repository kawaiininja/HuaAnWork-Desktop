# 2026-10 M8 出口审计（推送前，Task 6.1）

审计时同步分支 `sync/upstream-2.0.x` 的 HEAD 是 `84c4fa24b0`（本文件的父提交）。工作树是 `HuaAnWork-Desktop-sync`。本文件不代替 Task 6.2 的推送、Task 6.3 的 CI 运行、Task 6.4 的交付总结。

格的取值只有三种：`路径 @ 提交`、`scheduled for Task 6.2` / `scheduled for Task 6.3` / `scheduled for Task 6.4`、或缺口。下面没有缺口格。

## 1. R-M8-1 … R-M8-4

| 裁定 | 落地指针 |
|---|---|
| R-M8-1 孤儿提交丢弃，采上游 bridge 2.0.3 | `docs/upstream-sync.md`「镜像重置事件记录」@ `20a6e3fe29`（该节在 `84c4fa24b0` 仍在）。重置后 ref 写的是 `ca52ce2cd9ac872358e9a9464902e3c7ee4d494f`。审计时 `git -C "../DSH Desktop" rev-parse master` 与 `git rev-parse upstream/master` 都是这个提交。`d1d8c81b5a`、`eb56d3a1c1`、`5737bcceb6` 都不是镜像 `master` 的祖先（`merge-base --is-ancestor` 退出码 1）。`vendor/agents-anywhere/provenance.json` 的 `sourceVersion` 是 `2.0.3`，commit `7df5b31f3fe2`；该文件最后一次改动是上游提交 `c3eaddf338`，由合并 `a36953ee24` 带入。处置行是 `docs/evidence/2026-10-m8-merge-decisions.md` §7.1 行 `#30` @ `1743474908`。 |
| R-M8-2 继续 stable/beta，next 只登记观察项 | `AGENTS.md` 债表 R-M8-2 行 @ `84c4fa24b0`。触发句是该行原文：上游为 next 启动 release qualification——签名安装器 / 自动更新 / 数据迁移任一进入实施——即触发，触发后 2–3 人日重估基座。 |
| R-M8-3 白名单改为结构性清单 | `scripts/verify-desktop-variants.mjs` 最后一次改动 `f4403195e8`，自该提交到 `84c4fa24b0` 该文件 0 个提交（`git rev-list --count f4403195e8..84c4fa24b0 -- scripts/verify-desktop-variants.mjs` = 0）。`84c4fa24b0` 上导出的 `PAIRS`：stable↔beta `allowedDifferences` 9、`oneSidedPrefixes` 0；beta↔huaanwork `allowedDifferences` 22、`oneSidedPrefixes` 6。同一提交的债表变体守卫行是 `AGENTS.md` @ `84c4fa24b0`。`docs/upstream-sync.md` §6 第 1 条 @ `84c4fa24b0` 把该文件保持为永久 override，并指向债表这一行。 |
| R-M8-4 里程碑末单次推送；本地先有范围式 whitespace 检查 | 机制：`scripts/check-whitespace.mjs` @ `e8da51c1ef`。`BASE_SHA` 非空且不是全 0 时用它，否则 `git merge-base origin/master HEAD`，再 `git diff --check`。根 `package.json` 的 `check` 以 `yarn check:whitespace` 开头，同一提交接入。推送动作本身：scheduled for Task 6.2。审计时 `git rev-parse --verify origin/sync/upstream-2.0.x` 失败，HEAD 仍是 `84c4fa24b0`。远端没有这条分支，是推送纪律还在生效。 |

## 2. M7 移交项

计划 §5 的预登记表。看板的合并后重跑属于 Task 6.4，推送与 CI 运行分别属于 Task 6.2 与 Task 6.3。

| 项 | 指针 |
|---|---|
| 三份冲突清单 | `docs/evidence/2026-10-m8-merge-spike-refresh.md` @ `3ecec80f32`。该文 §2：take-upstream 2、replay-fork 22、fork-owned-override 5、modify-delete 0、matrix-preserve 4、needs-ruling 30，加总 63。消解指针在下一节。 |
| 看板基线 | 合并前刷新：`docs/upstream-sync.md`「M8 阶段 B 实施刷新快照（Task 0.1 / 2026-10-09）」@ `c5737e51eb`。Phase 5 追加的本地对齐（没有 fetch、没有推送）：同文件「M8 Phase 5 看板对齐（2026-10-10）」@ `84c4fa24b0`，读数写在父提交 `4ade24c3aa` 上，`HEAD..upstream/master` = 0。合并后的看板重跑：scheduled for Task 6.4。 |
| 孤儿提交 | 与 R-M8-1 同一组指针：`docs/upstream-sync.md` @ `20a6e3fe29`，provenance 与决策行 `#30` @ `1743474908`。 |
| 基座 | 与 R-M8-2 同一行：`AGENTS.md` @ `84c4fa24b0`。 |
| 白名单 | 与 R-M8-3 同一组指针：`scripts/verify-desktop-variants.mjs` @ `f4403195e8`（内容保持到 `84c4fa24b0`），债表行 `AGENTS.md` @ `84c4fa24b0`。 |
| M4 顺序约束 | `docs/huaanwork-m4-human-verification-2026-10-07.md` @ `130da6929a`。该文写明 A1–A19 已执行，其中 A10 不通过（托盘图标，F-M4-1）。计划把 A10 放在本里程碑范围外。该记录提交早于合并 `a36953ee24`。 |
| M23 六条 should-be-identical | `84c4fa24b0` 上这六个文件 stable 与 beta `cmp` 为空：`desktop-copy.spec.ts`、`electron-runtime.spec.ts`、`notifications.spec.ts`、`profile-selection-window.spec.ts`、`startup-recovery-window.spec.ts`、`updates.spec.ts`。前五个的对齐提交是 `cb8208b38a`。`updates.spec.ts` 最后一次改动是合并 `a36953ee24`。债表 M23 行：`AGENTS.md` @ `84c4fa24b0`。`tests/` 守卫没有加。 |
| stable `x64ArchFiles` | 决策行 replay #4：`docs/evidence/2026-10-m8-merge-decisions.md` @ `1743474908`（采上游 11 条 glob）。`84c4fa24b0` 上 desktop、beta、huaanwork 三份 `package.json` 的 `build.mac.x64ArchFiles` 花括号条目集合相同，各 11 条，含 `sherpa-onnx-darwin-*/**`。huaanwork 补上这一条的提交是 `4e1fa83ed0`。 |
| README 版本漂移 | `docs/evidence/2026-10-m8-phase5-readme.md` @ `4ade24c3aa`。守卫命令在父提交 `5c0815d23f` 上退出码 0，打印 4 条硬编码制品串、1 个范围内包、4 个范围外 README。范围外的 stable/beta 制品串仍是 `2.0.5` 与 `2.0.5-beta.2`。这是 Task 5.2 写在该文件里的结果。 |
| 推送纪律 | 机制指针同 R-M8-4（`e8da51c1ef`）。远端 `origin/sync/upstream-2.0.x` 在 `84c4fa24b0` 不存在。推送：scheduled for Task 6.2。 |
| CI 判据 | 判据是合并后 workflow 的全部展开格，见第 4 节，文件 `.github/workflows/ci.yml` @ `a36953ee24`（`a36953ee24..84c4fa24b0` 对该文件的提交数是 0）。一次实际运行：scheduled for Task 6.3。 |
| M26 终审残余 | `5c0815d23f`。该提交改 `dsh-plugin-huaanwork/src/client-huaanwork/MarketView.tsx`、`MarketSourcePanel.tsx`、`logic/market.ts`、`styles.css`、`styles.generated.ts`，并在 `tests/client-huaanwork/market-view.spec.ts` 与 `market.spec.ts` 写入残余用例。 |

## 3. Phase 2 消解决策表

文件：`docs/evidence/2026-10-m8-merge-decisions.md` @ `1743474908`。

该文件自己的收口算术在文末：§9.1 的 33 行 + §9.2 的 30 行 = 63。审计时按行复核：

- §9.1 数据行是 L276–L308：take-upstream #1–#2、replay #1–#22、fork-owned #1–#5、matrix #1–#4，共 33。L274 是表头，不是 hunk。
- §9.2 是 L318–L347，30 条指针。每一条都写了已有处置行（§3、§6.2 或 §7.1）。§6.2 含指针点名的 `beta #5`、`beta #7`、`stable #16`、`stable #18`。
- L310：spike 的 modify-delete 是 0；同一对父提交没有额外的删除/修改路径。句中「没有待登记的 hunk」是这一句的结论。
- L349：§8 的六条传播不计入这 63。
- 全文「未处置」命中 0，「未验证」命中 0。

§3 的 14 行与 §6.2 的 10 行是 §9.2 指向的正文，不另加进 63。

## 4. CI 展开格

展开格从 `.github/workflows/ci.yml` @ `a36953ee24` 读出。`check` 里的四步 next 验证是这一个 job 的步骤（`:117–127`），不是另外的矩阵格。`desktop-linux` 的矩阵只有 desktop 与 beta（`:186`）。下表每一行是一个展开后的 job 格。运行登记：scheduled for Task 6.3。

| 展开格 | workflow 位置 |
|---|---|
| `changes` | job `changes`，`:23` |
| `check` | job `check`，`:62`；其中 next 四步是 `verify:window-controls`、`verify:onboarding`、`verify:protocol`、`verify:sidebar-browser`，`:117–127` |
| `desktop-windows` / `dsh-plugin-desktop` | 矩阵 `:139` |
| `desktop-windows` / `dsh-plugin-desktop-beta` | 矩阵 `:139` |
| `desktop-windows` / `dsh-plugin-huaanwork` | 矩阵 `:139` |
| `desktop-linux` / `dsh-plugin-desktop` | 矩阵 `:186` |
| `desktop-linux` / `dsh-plugin-desktop-beta` | 矩阵 `:186` |
| `desktop-macos` / `dsh-plugin-desktop` | 矩阵 `:219` |
| `desktop-macos` / `dsh-plugin-desktop-beta` | 矩阵 `:219` |
| `desktop-macos` / `dsh-plugin-huaanwork` | 矩阵 `:219` |
| `upstream-command-windows` | job `:254` |

决策表里对这个 workflow 的描述是 `docs/evidence/2026-10-m8-merge-decisions.md` §7.1 行 `ci.yml #1` @ `1743474908`：Windows 矩阵三格、macOS 矩阵三格、`desktop-linux` 两格、`check` 仍含 next 四步。

## 5. 本审计引用的本地记录

| 记录 | 指针 |
|---|---|
| 推送前的 root `corepack yarn check` | 叙述：`docs/evidence/2026-10-m8-phase4-gates.md` @ `f36e5ae3ad`（`BASE_SHA` 未设置，退出码 0，日志 `yarn-check-rerun-2.log`）。该日志文件最后一次改动是 `7ddac76f36`（去掉尾部空白）。 |
| 根命令 mac 冒烟 | `docs/evidence/2026-10-m8-phase4-logs/dist-mac-smoke-root.log` @ `0e4dd17b0d`。日志末行是 `EXIT 0`，前一行是 `macOS DMG smoke verification passed`，结束时间 `2026-10-10T05:32:36Z`。叙述：`docs/evidence/2026-10-m8-phase4-smoke.md` @ `19c661087a`。 |
| `verify:protocol` 与 `verify:sidebar-browser` | 在 Darwin 上没有记为通过。`docs/evidence/2026-10-m8-phase4-logs/verify-protocol.log` 与 `verify-sidebar-browser.log` @ `f36e5ae3ad`，两份日志的 `exit_code` 都是 1，脚本要求 Linux 与 xvfb。同一事实写在 `docs/evidence/2026-10-m8-phase4-gates.md` @ `f36e5ae3ad`。计划 §7.8：本机没有 xvfb 或显示时停表，不记通过。 |
| 主工作树隔离 | 审计时 `HuaAnWork-Desktop` 的 `git status --porcelain` 行数是 0。该工作树 HEAD 是 `e8da51c1ef`，`master` 比 `origin/master` 超前 6。本任务没有改那个工作树。 |

## 6. 仍在后面的任务

| 任务 | 本审计的格子 |
|---|---|
| Task 6.2 单次推送 | scheduled for Task 6.2 |
| Task 6.3 按第 4 节每一格对账一次运行 | scheduled for Task 6.3 |
| Task 6.4 交付总结，以及合并后的看板重跑 | scheduled for Task 6.4 |
