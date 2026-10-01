# M6 数据迁移真机冒烟记录（R1）— 2026-10-01

Task 7.2。门控驱动器：`dsh-plugin-huaanwork/tests/huaanwork-migration-smoke.spec.ts`
（`HUAANWORK_MIGRATION_SMOKE=1` 门控，默认 skip，不进常规门禁）。本记录逐项标注
**exercised 层级**，未做 UI 驱动的不声称 UI 驱动。所有证据落在
`.superpowers/sdd/2026-09-27-dsh-desktop-integration-m6-migration-release/logs/task-7.2-*`。

## 环境与运行元数据

- 仓库 `HuaAnWork-Desktop`：被测 HEAD `5d3ed143c3`（2026-10-01 03:52:39 +0800，
  「chore: close the M6 Phase 6 final-review fixes」——早于冒烟开始时刻，时序成立）。
- 旧树（真实 Tauri 数据）= `~/Library/Application Support/HuaAnWork`，迁移源面 =
  `settings.json`、`account.json`、`auth-session.json` + `dsh/**` 递归（共 9 个文件；
  含 1 个中性根会话 `dsh/sessions/…/huaanwork-1f7ebce964ccfbf4/session.jsonl.zstd`）。
- 新 home = `~/.huaanwork`（**2026-09-22 既有使用痕迹**；其 `data-directory/state.json`
  记录 `activeHome=~/.huaanwork`、`previousHome=~/.dsh`——真实首启的事实 home 由此记录
  与既有 profile 决定，而非默认推断）。
- 备份（仓库外，先于任何真实启动）：`~/Downloads/huaanwork-m6-smoke-backup-2026-10-01/`
  含 `old-tree/`、`new-home/` 与两份 sha256 manifest；21:35 逐字节核验与现场 IDENTICAL
  （`task-7.2-backup-verify.txt`）。冒烟期间的权威「冒烟前」快照即此备份与
  `task-7.2-{before,after}-*.tsv`。
- 打包路径（R-7.2-0）：根 `corepack yarn package:dir:huaanwork` **失败**——
  `aa:prepare-release` 的 AA vendoring 已过时效门并注入副作用（3 个 package.json +
  yarn.lock + vendor provenance，证据 `task-7.2-aa-injection-evidence.txt`，全部还原、
  树干净，`task-7.2-yarn-immutable-restore.log`）；失败原因 = `afterAllArtifactBuild`
  阶段 `verify-electron-fuses.ts:235` 报 `cannot determine requested Electron
  architecture(s) for mac`，`package-dir.mjs:71` 以 `electron-builder --dir exited
  with 1` 终止（`task-7.2-package-root.log`）。工作区级 `cd dsh-plugin-huaanwork &&
  corepack yarn package:dir` 同样失败（`task-7.2-package-workspace.log`）。**成功路径 =
  工作区级 `corepack yarn dist:mac-smoke`**（`MACSMOKE_EXIT=0` @ 21:45:27，
  `task-7.2-package-macsmoke.log`）。
- 制品（`task-7.2-artifact-hashes.txt`）：`HuaAnWork-0.1.0-universal.dmg`
  sha256 `09adf0e0e0603ea59ff624ef64a2f9bc5134d04aeaf6279210572ae59b85aa8f`；app 二进制
  `mac-universal/HuaAnWork.app/Contents/MacOS/HuaAnWork` sha256
  `e17a003108ec2de4f8e5ad6041c25bd26c1c3c3e3bb8a15ea7a889ed319e8f36`；bundle
  `app.huaanwork.desktop`、0.1.0、archs x86_64+arm64。
- 真机时序：**首启 21:53:19**（真实树，默认 home）；**二启 21:54:17**；隔离失败路径
  A/B 21:57/21:58（后续 22:47+ 有 B 的完整收尾重演，见第 13 项与「偏差与诚实声明」）。
  Node v22.23.2 / Yarn 4.18.0 / arm64（`task-7.2-metadata.txt`）。

## 13 项逐项核对

| # | 核对项 | 结果 | 层级（可核证据） |
| --- | --- | --- | --- |
| 1 | 首启未进恢复窗口；日志含 `describeMigrationForUser` 输出 | **真机已执行**：首启 lifecycle `startup.run.completed`（无 stage failed）；消息原文见 `task-7.2-firstboot.log`：「已从旧版华安工作台迁移:sessions 1、sessionsReminted 1。 跳过 3 项(已存在或不可解析)…」 | 真机（lifecycle + 日志原文） |
| 2 | marker 存在且 counts 与实际相符 | **文件系统已执行**：`~/.huaanwork/profiles/desktop/huaanwork-migration.json`（`task-7.2-firstboot-marker.json`）：sessions 1 / sessionsReminted 1 / sessionsCarried 0 / workspaceFiles 0——与旧树实际（1 个中性根会话、workspace 为空）相符 | 文件系统 |
| 3 | 设置页显示模型端点、主题、`allow_network`、`guard_mode`（Task 2.1 修复使 guard_mode 生效） | **UI 待人类**。机器面：`settings.json` 因目标已存在被跳过（merge 语义，skipped「destination already exists」）⇒ 设置页显示的是 **2026-09-22 既有** `profiles/desktop/huaanwork-settings.json`（theme dark、model `stub-model`、base_url `127.0.0.1:49212`、allow_network true、guard_mode ask），旧树值（light、空 model、`:11434`、allow_network false）**未应用**。待人类核对时请对照上列既有值 | 文件系统 + 待人类 UI |
| 4 | AuthGate 处于 **needs-login**；旧密码可登录 | **UI 待人类**。机器面：`auth-session.json` 被「intentionally expired」跳过、`account.json` 因目标已存在跳过（未覆盖）⇒ 需登录态、密码 = 用户旧华安工作台密码 | 文件系统 + 待人类 UI |
| 5 | 项目列表含迁移项目 | **无此数据、不适用**（R-7.2-1：真实旧树无 `projects.json`） | 实测缺失 |
| 6 | 任务列表 `sessionId` 重铸、可见历史消息 | **无此数据、不适用**（真实旧树无 tasks/任务数据） | 实测缺失 |
| 7 | 中性根会话出现在侧栏「任务」区、`cwd` 指向新中性根、`workspace/` 可访问（G4） | **文件系统已执行 + UI 待人类**：marker `sessionsReminted 1`；新 home 落盘重铸文件（`task-7.2-secondboot-post.txt` sha `f7ca4fcc…`），header.id/cwd = 新中性根（门控 spec :314-316 同断言）；旧 `workspace/` 为空 ⇒ `workspaceFiles 0`，无文件可核对。侧栏展示待人类 | 文件系统 + 待人类 UI |
| 8 | 自动化列表含迁移条目 | **无此数据、不适用**（真实旧树无 `automations.json`/runs） | 实测缺失 |
| 9 | 技能中心启用态/自撰技能（G2/G3） | **无此数据、不适用**（树中无技能数据） | 实测缺失 |
| 10 | 智能体目录（G1） | **无此数据、不适用**（树中无智能体数据） | 实测缺失 |
| 11 | 二启迁移不重跑（performed=false）、数据无变化 | **真机已执行**：`performed:false` 探针（`task-7.2-secondboot-probe.txt`）；marker 与重铸会话 sha 二启前后一致（`task-7.2-secondboot-pre/post.txt`）；二启 lifecycle `startup.run.completed` | 真机 |
| 12 | 旧树未被修改（迁移源面 sha256 快照比对） | **文件系统已执行**：`task-7.2-{before,after}-source.tsv` **SOURCE_IDENTICAL**（9/9 文件含 settings/account/auth-session + `dsh/**`）。全树 diff = 共享 userData 的 Chromium 缓存/日志噪音（R-7.2-3；`task-7.2-item12-full-diff.txt`：旧树 added 22/removed 2/changed 33，均为 Cache/Partitions/logs；新 home 仅 added marker + 重铸会话）。**时序外注记**：22:06（冒烟窗口之后、证据采集之后）旧版 Tauri 应用 `com.huaanwork.desktop` 的一次启动重写了 `dsh/` 中 4 个文件——3 个配置文件逐字节相同、会话文件仅重编码（解压内容与备份逐字节一致）——见「偏差与诚实声明」 | 文件系统 |
| 13 | 迁移失败路径：人为破坏源文件 → 首启进恢复窗口、旧树仍完整 | **真机已执行（隔离环境）**：**A** 损坏 zstd 会话日志 → 迁移硬失败 `legacy HuaAnWork data migration failed: corrupt zstd session log: invalid frame magic at byte 0`，lifecycle `startup.run.failed {finalStage:profile-selection, failureReason:startup-failed}`（恢复窗口路由；`task-7.2-failpath-A-*.log` + lifecycle jsonl）；**B** 损坏 `settings.json` → 设计内**软跳过**（"settings.json: unparseable, left in place"），迁移继续并写 marker（`account 1、sessions 1、sessionsCarried 1，跳过 2 项`）、隔离树源面 IDENTICAL、干净退出（`task-7.2-failpath-B2-{app,marker,skip}.log|json`、`-B2-{before,after}-source.tsv`）。计划示例中的 `projects.json` 不存在于真实树；实测的硬失败触发 = 损坏会话日志，settings 损坏 = 设计内容忍 | 真机（隔离副本 + 真实二进制） |

## 冒烟发现（产品级，均未在真实旧树上触发）

真机冒烟（含门控 spec 隔离树）暴露两个独立问题，均**与 R-7.2-6 的 spec 夹具修复无关**。
两项均已按控制器裁决修复（2026-10-01 FIX ROUND 1，R-7.2-7/R-7.2-8，commit
`4709e6ab95`；修复内容与证据见文末「修复跟进」）：

1. **首启 Setup Wizard 阻塞一切全新 profile 的无人值守启动**（`task-7.2-wizard-block-evidence.txt`）。
   `main.ts:1352-1369` 在 profile-composition 阶段 `await setupWizardWindow.run()`
   （`setup-wizard-window.ts:179-221`，仅由 UI 决策/关窗/加载失败 resolve）；门 =
   `desktopSetupWizardRequired && !hasDesktopProfileUsageHistory`，后者按 **profileDir
   绝对路径哈希**在 `~/Library/Application Support/DSH Desktop` 等处查使用记录 ⇒ 隔离树
   的每次全新临时 profile 恒为「无使用记录」⇒ wizard 恒要求、宿主 web server 永不启动。
   实测：固定版 spec 连续两次挂到 `timed out waiting for the host web server`
   （`task-7.2-gated-spec-fixed-run1.log`；run2 22:34 同超时）；6/6 次隔离运行同现象；
   CDP 现场窗口转储含 `{"title":"Set up DSH Desktop","visible":true}`。真实树不受影响
   （`~/.huaanwork/profiles/desktop` 有 09-22 使用记录）。**含义**：Task 2.9 的 spec
   诞生于 wizard 之前，其对「全新隔离树直接起到宿主」的假设在含 wizard 的当前产品上
   不再自洽——需要控制器裁定 spec 侧（如种子内预置 setup 状态）或明确「spec 运行需
   操作者过 wizard」的纪律。**状态：已处置（FIXED，harness 侧）**——R-7.2-8 采纳
   「种子预置 setup 完成态」，见「修复跟进」。
2. **中性根会话重铸产物违反上游首帧契约**（`task-7.2-remint-frame-defect-evidence.txt`）。
   `huaanwork-migration/sessions.ts:254-259` 对重铸会话写
   `zstdCompressSync(重写 header + 其余全部文本)` = **单帧含多行**；上游
   `@deepseek-ai/dsh-session-persistence-jsonl` 的 `assertZstdHeaderFrame` 要求
   「第一帧恰为一行 header」（lib/index.js:2186），否则
   `corrupt Zstandard session log: first frame is not exactly one header line`。
   触发条件 = 旧中性根会话**含任何对话内容**；真实旧树恰为空会话（仅 header）所以真实
   首启/二启未触发。实测（隔离 spec 种子含 turn + wizard 已跳过）：host-boot **致命**
   失败 `plugin tree failed to load … entry workspace (@deepseek-ai/dsh-workspace):
   corrupt Zstandard session log …`，lifecycle `startup.run.failed {finalStage:host-boot}`，
   host 日志三处报错（workspace-registry / agent-loop 会话恢复 / host-resolved-root-include）；
   对照（同种子、会话改为 header-only）：`startup.run.completed`、宿主端口 43120 应答 403、
   一切正常。**含义**：对「用过」的旧中性根会话（真实用户的主工作区会话），迁移后
   host-boot 存在确定性失败面——R1 真机的最大收获。修法在迁移写入侧（header 行单独成帧），
   属产品改动，交控制器裁定。**状态：已修（FIXED，产品侧）**——R-7.2-7 采纳写入侧修复
   （header 行单独成帧 + 回归钉），见「修复跟进」。

## 门控 spec（Task 2.9）修复与 3× 复跑状态

按 R-7.2-6 采纳诊断补丁两处实质 hunks（`task-7.2-gated-spec-diagnostic.patch`）并保持
最小 diff：① `seedSmokeTree` 的临时根 `realpathSync`（macOS `/var`→`/private/var`，remint
路径断言的前提）；② 种子 settings 改为真实旧形状（`models:[{id:'default',…,model:'llama3'}]`、
`active_model_id:'default'`；原 `models:[]`/`active_model_id:''` 是不可发生的旧状态，读侧
`model` 由 `models[active_model_id]` 派生）。诊断补丁的 `SMOKE_ROOT`/`KEEP` 逃逸未使用、不保留。

- 红因复盘：原 spec 在 `:268` 失败（`settings.model` `''≠'llama3'`），修后 `:268` 及之后
  全部文件级断言通过（validation/controlled 两轮均跑到 host 等待一步）。
- **3 次连续干净全绿：未达成（阻塞，如实记录，不伪造）**。run1（22:17:49，canonical 命令，
  `task-7.2-gated-spec-fixed-run1.log`）与 run2（22:34:54，同命令 122.66s）均在
  `:296` `timed out waiting for the host web server` 超时；根因 = 上述发现 1（wizard）；
  经 operator-assist 过 wizard 后暴露发现 2（含 turn 的种子 ⇒ host-boot 致命）；
  将种子会话改为 header-only（真实旧树形状）则全绿。即：**修复本身成立（`:268` 红转绿、
  文件级断言全绿），但 3× 复跑在当前产品+机器状态下不可达，属产品级发现而非 spec 缺陷**，
  按裁决 STOP+上报（见 `task-7.2-report.md`）。**2026-10-01 修复跟进：两项阻塞已按
  R-7.2-7/R-7.2-8 解除，3× 无人值守全绿已达成（见文末「修复跟进」）。**
- operator-assist 方法与脚本留档：`task-7.2-wizard-skip-wrapper.sh`（`--remote-debugging-port`
  包装真实二进制）与 `task-7.2-wizard-skipper.mjs`（在 wizard 页执行与 UI「跳过」同源的
  `window.location.assign('dsh-setup-wizard://skip')`，`App.tsx:708`）。仅用于诊断与失败路径
  重演；任何结论未依赖被改动的产品行为。

## 偏差与诚实声明

- **merge-skip 语义（机制）**：真实首启不是干净家迁移——`~/.huaanwork/profiles/desktop`
  为 09-22 既有，`settings.json`/`account.json` 以「destination already exists」跳过、
  `auth-session.json` 以「intentionally expired」跳过。设置/账号的展示值以既有文档为准
  （见第 3/4 项）。干净家全量迁移（settings/account/projects/automations/runs/workspaceFiles
  全计数）在门控 spec 的隔离树中被验证（`task-7.2-diagnostic3-marker.json`）。
- **clean-home replay 注记**：真实树**未做**干净家重放（首启已消费、marker 不得动）；
  若未来需要重放，用 `~/Downloads/huaanwork-m6-smoke-backup-2026-10-01/` 的备份在离线环境
  演练，真实树不就地重置。
- **时序外注记（22:06，冒烟窗口与证据采集之后）**：旧版 Tauri 应用（bundle
  `com.huaanwork.desktop`，TMPDIR 证据 22:06）的一次启动重写了旧树
  `dsh/{cordis.yml,cordis.patch.yml,profiles/huaanwork/package.json,sessions/…/session.jsonl.zstd}`：
  前三个逐字节与备份一致（mtime 更新），会话文件仅 **re-encode**（zstd 帧结构变化、解压内容
  与备份逐字节一致，header 相同）。零数据变更；第 12 项对冒烟窗口（21:35→21:53）的
  SOURCE_IDENTICAL 断言不受影响；权威冒烟前快照 = 备份。
- **B 路径 attempt-1 事故（已完全披露）**：B 的首次重演（22:47）因种子副本携带
  `data-directory/state.json`（`activeHome=~/.huaanwork`）被应用**合法采用**，实际以真实
  home 运行（`performed:false`，打印既有 marker 摘要）。对真实新 home 的影响仅 mtime
  级重写（`huaanwork-workspace.json`/`cordis.yml`/proj-cache/session.lock，内容逐字节
  不变，与 `task-7.2-before-newhome.tsv` 比对核验）、marker 未动；旧树零触碰。重演已按
  隔离纪律修正（重写种子副本的 `activeHome` 指向隔离新 home——与前实现者 failA/failB
  种子处理同法）后重跑，即上文 B2 结果。**教训**：任何以真实 userData 副本为种子的隔离
  运行必须先改写/移除 `data-directory/state.json`，否则 `DSH_HOME` 会被记录值覆盖。
- 共享 userData（旧树目录 = 新旧产品共用的 config dir）在真实启动期间出现 Chromium
  缓存/日志/健康快照写入，属 R-7.2-3 已裁定的预期噪音；迁移源面无变化。
- 打包面 AA 副作用与失败原因见「环境」节；未使用根命令产物，冒烟制品 = 工作区级
  `dist:mac-smoke`（含与根路径的差异面：AA 桥接未注入）。

## 待人类核对指南（R-7.2-2）

启动（用冒烟同一制品；真实树上迁移不会重跑，performed=false）：

```bash
open "/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/dist/mac-smoke/mac-universal/HuaAnWork.app"
# 或安装制品： dsh-plugin-huaanwork/dist/mac-smoke/HuaAnWork-0.1.0-universal.dmg（未签名，首次需右键打开）
```

逐项步骤（与上表编号对应）：

- **3 设置页**：打开设置，核对模型端点/主题/allow_network/guard_mode。**注意**：本次为
  merge-skip，期望值 = 既有 09-22 文档（dark / `stub-model` / `:49212` / allow_network true /
  guard_mode ask），而**不是**旧树值；另核对 guard_mode 切换真实生效（Task 2.1 修复面）。
- **4 登录**：应停在 needs-login（account 已迁移、session 故意过期）。用**旧华安工作台密码**
  登录成功即过；失败如提示密码错，记录界面文案与时间。
- **5/6 项目/任务**：本机真实旧树无项目/任务数据——列表为空属**预期**；若有任何「迁移
  残留」条目即为异常，记录截图。
- **7 中性根会话**：侧栏「任务」区应出现迁移重铸的中性根会话（id 前缀
  `huaanwork-`，cwd = `~/.huaanwork/profiles/desktop/workspace`）；打开会话可见空
  工作区（旧 workspace 为空）且无错误横幅。
- **8 自动化**：无迁移数据，列表为空属预期。
- **9 技能中心**：无迁移数据；若出厂技能存在且启用态正常即记录通过。
- **10 智能体目录**：无迁移数据；空目录属预期。
- 完成后正常退出应用（菜单退出亦可）。

## 附录 A — Phase 4 图标目检（Dock / 托盘 / 安装器）

- 图标母版与接触表：`logs/task-4.2-tray-contact-sheet.png`（Phase 4 既有证据）。
- 目检步骤：① `open` 上述 .app 后看 **Dock** 图标为华安品牌图（非 Electron 默认）；
  ② 看菜单栏 **托盘/状态区** 图标（模板图随亮暗主题反色、无彩边）；③ `hdiutil attach`
  dmg 看 **安装器卷** 图标与卷内 app 图标一致。三处任一不符即截图记录。

## 附录 B — Phase 5 三项 UI 核对

1. **市场来源面板**：设置 → 市场来源（MarketSourcePanel）可打开、当前来源正确；切换
   来源后有保存反馈（Task 5.x 面板面）。
2. **macOS 目录选择器**：打开项目/工作区入口应弹**原生**目录选择器（Task 5.2 落地；
   取代 M5 记录 §14-21 的「macOS 不可达」状态），选择目录后工作区切换成功。
3. **「立即重启」按钮**：走一次安装/切换流程并在确认弹窗**取消**重启 → 界面出现
   「立即重启」入口（Task 5.3 模式）；点击后应用重新拉起。历史残余见 AGENTS.md
   「取消重启后的界面入口残余」（remove/切源两流的入口缺口为已登记债）。

## 复跑

```bash
cd dsh-plugin-huaanwork
HUAANWORK_MIGRATION_SMOKE=1 \
HUAANWORK_MIGRATION_SMOKE_APP="$PWD/dist/mac-smoke/mac-universal/HuaAnWork.app/Contents/MacOS/HuaAnWork" \
corepack yarn vitest run tests/huaanwork-migration-smoke.spec.ts
```

注意：**发现 1、发现 2 均已修复并闭环（见文末「修复跟进」）**。首启 Setup Wizard 对全新
profile 仍是真实产品行为，但门控 spec 的夹具已预置完成标记（与默认 profile 目录一并预置，
否则会被启动期的使用记录清理抹掉），**无人值守复跑不再被阻塞**；含 turn 的种子会话此前
触发的 host-boot 失败已随重铸帧修复消除。历史背景请读 `task-7.2-report.md` 与两份发现
证据文件（其结论均已在「修复跟进」中收口）。

## 修复跟进（2026-10-01 FIX ROUND 1）

控制器对 R1 两发现给出裁决（R-7.2-7 产品侧修重铸帧；R-7.2-8 harness 侧预置 wizard 完成态），
本记录闭环如下（证据同目录 `task-7.2-fix-*`）：

- **产品修复（发现 2，R-7.2-7）**：commit `4709e6ab95`。重铸写入侧改为「重写后的 header
  单独成一帧（`header + '\n'`），其余内容另帧追加」（`remainder` 去掉被 header 帧消费的
  首换行；header-only 会话不产生空尾帧），与上游 writer 的帧布局逐字对齐
  （`deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts:1206-1221`
  的 `encodeMaterialization`），满足读取侧 `assertZstdHeaderFrame`（同文件 `:74-79`）：
  独立可解码的第一帧恰为一行 header。携搬路径（header 未变 → 原字节复制）与未压缩路径
  不变。回归钉 = `tests/huaanwork-migration/sessions.spec.ts`「re-minted session frame
  layout」两条（内容会话：第一帧恰一行且以 `\n` 结尾 + 拼接明文无数据丢失；header-only：
  单帧无空尾帧）；RED（`task-7.2-fix-red-pin.log`，未修树在 `assertZstdHeaderFrame` 镜像
  判据处红）→ GREEN（`task-7.2-fix-green-pin.log`，迁移目录 137/137）。全迁移模块扫描
  （`src/huaanwork-migration/*.ts`）：唯一 zstd 重编站点即本处（`sessions.ts`）；
  `extras.ts`/`runs.ts` 为逐字节复制或纯文本行改写，无同类问题。
- **harness 预置（发现 1，R-7.2-8）**：commit `4709e6ab95`。门控 spec 的 `seedSmokeTree`
  预置两个状态：默认 profile 目录（产品自身 `createDesktopWebProfile`，即应用冷启动
  `materializeDefaultDesktopProfile` 的同一路径）与该 profile 的 Setup Wizard 完成标记
  （产品自身 `completeOrSkipDesktopSetupWizard` 写出的同一 v2 状态，版本字段与应用
  `setupWizardVersions` 同源）。**披露**：全新 profile 的首启 wizard 是真实产品行为，
  与迁移正交；夹具预标记完成态使 spec 无人值守可跑，未改任何产品行为。两者必须同在：
  profile 目录若本次启动才出现，`main.ts` 会先 `clearDesktopProfileUsageHistory` 清掉
  单独预置的标记。离线核验（`task-7.2-fix-seed-check.log`）：预置后
  `desktopSetupWizardRequired === false` 且 `hasDesktopProfileUsageHistory === true`，
  main.ts 的 wizard 门为 false（不阻塞）。
- **制品重打包（R-7.2-9）**：`corepack yarn dist:mac-smoke` @ 23:12，MACSMOKE_EXIT=0
  （`task-7.2-fix-rebuild.log`；打包产物 `lib/main.js` 中已核到修复函数与逻辑）。
  新制品（`task-7.2-fix-artifact-hashes.txt`）：dmg
  `4e03117c210fe7ab5895294f9017edd6ce3d7eafe2b5dd0ae1f4dcb26298095b`；app 二进制
  `4f7513861419dc713ec1ec7f408b972ae59e4f9e7eb84bbd6ed68fe12fc2eb89`——均不同于
  21:45 修复前制品（`09adf0e0…`/`e17a0031…`）。
- **3× 无人值守全绿（R-7.2-10）**：canonical 命令（内容种子），run1/2/3 均 PASS
  @ 23:15:13/23:15:39/23:15:44（`task-7.2-fix-gated-run{1,2,3}.log`，
  GATED_RUN*_EXIT=0，测试体 2.6s/2.1s/2.1s；无 wizard 阻塞、宿主端口在窗口内如常应答；
  每轮后 `pgrep` 无残留进程）。**即 Step 2 门「3 次连续干净全绿」达成**。
- **门禁**：`corepack yarn check:desktop-variants` 绿（VARIANTS_EXIT=0，
  `task-7.2-fix-gate-desktop-variants.log`）；根 `corepack yarn check` 绿
  （ROOT_CHECK_EXIT=0，`task-7.2-fix-gate-root-check.log`）。
