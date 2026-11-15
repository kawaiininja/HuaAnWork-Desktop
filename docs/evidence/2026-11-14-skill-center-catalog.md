# 技能中心双标签与内网共享流转 — 实施证据（2026-11-14）

- 分支/worktree：`feat/skill-center-catalog` / `.worktrees/skill-center-catalog`
- 基线：`9d5a7a0f75`（master merge-base）
- 最终树提交：见本文件落盘提交（表格中 Task 1–10 的提交链 + 计划/规格/证据提交）
- 规格：`docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md`
- 计划：`docs/superpowers/plans/2026-11-14-skill-center-catalog.md`

## 1. 最终工作区门禁（Task 11 Step 1）

命令均在最终代码树上单独执行，记录原始退出码：

| 命令 | 开始/结束（本地时间） | 退出码 | 关键计数 |
| --- | --- | --- | --- |
| `corepack yarn typecheck` | 2026-11-14 23:52 | **0** | 25s |
| `corepack yarn test` | 2026-11-14 23:52 | **1** | 291 passed / 1 failed / 4 skipped（4099 tests；4083 passed / 1 failed / 15 skipped） |
| `corepack yarn check` | 2026-11-14 23:53 | **0** | 187s；`dsh-plugin-huaanwork` vitest 292/292 passed、4 skipped |

### 1.1 `yarn test` 单项失败的分诊（如实记录）

- 失败用例：`tests/huaanwork-host/agent-package-runtime.spec.ts > agent package skill script lifecycle > stopping the runtime during a running script kills it and removes the state dir`
- 现象：`ENOENT … hang-state.txt`。fixture 的 `hang.mjs` 先写 `hang-pid.txt` 再写 `hang-state.txt`；用例在等到 pid 文件后立即读取 state 文件，全量并行负载下存在时序竞争。
- 归因证据：
  1. 同一套件在随后执行的 `corepack yarn check` 中 292/292 全部通过（含该用例）；
  2. 在最终树上单独复跑该用例（`vitest run tests/huaanwork-host/agent-package-runtime.spec.ts -t "stopping the runtime during a running script"`）→ 1 passed / 59 skipped；
  3. 本计划的改动不触及该 fixture 的脚本生命周期路径（仅在同文件的 `makeProfileWithSkill` 测试辅助中启用技能）。
- 结论：既有测试的时序偶发，不是本次功能回归；仍按“最终树实际退出码”记录，不用通过的重跑覆盖第一次失败。

## 2. 自动化覆盖与规格 §14.1 映射

| 规格 §14.1 条目 | 覆盖位置 |
| --- | --- |
| 两标签、默认页、页内搜索、按钮/徽标/空态 | `tests/client-huaanwork/skillsLogic.spec.ts`（标签/按钮/徽标/搜索）+ `tests/client-huaanwork/skillsView.spec.ts`（jsdom：默认页、系统技能无下载、下载/已下载按钮态、共享卡发布者/revision、迁移警告、我的技能徽标/启停/上传入口、空态指路） |
| 启停、删除清理、重启恢复、未启用 `/` 拒绝 | `skills-host.spec.ts`、`skill-local-state.spec.ts`、`routes.spec.ts`、`sessions.spec.ts` |
| `user-invocable:false` 不阻止已启用本地技能；表单无该选项；编辑保留行 | `skills-host.spec.ts` 解析器用例、`skillsLogic.spec.ts` |
| 内置同名副本拒绝首次上传；另存为新技能 | `skill-catalog-upload.spec.ts`、`skill-duplicate.spec.ts`、`routes.spec.ts` |
| 成功文案与刷新联动 | `skillsLogic.spec.ts`、`appWiring.spec.ts`（slash 刷新接线钉） |
| 新共享包进入布局/内联/许可证门禁 | Task 1 提交 + `check:layout`、`yarn check` 全绿 |
| `SkillDetail` 读模型与列表投影分离 | `rpc-types.ts`、`skills-host.spec.ts`、typecheck |
| 外部技能不可自动调用（UI/Host/preset） | `skills-host.spec.ts`、`profile.spec.ts`、`routes.spec.ts` |
| 归档 round-trip/穿越/链接/嵌套压缩/超帽/摘要 | `packages/huaanwork-skill-format/tests/*` |
| 服务端上传即发布/分页/owner/expected/幂等/审计恢复 | `agent-catalog-server/tests/skill-store.spec.ts`、`skills.spec.ts`、`auth-legacy.spec.ts` |
| 下载原子性/冲突/更新/默认禁用 | `skill-catalog-download.spec.ts` |
| 上传权限隔离/首次发布/非 owner/重试/上传中编辑 | `skill-catalog-upload.spec.ts`、`skill-catalog-client.spec.ts` |
| 内网不可用时本地独立与完整缓存 | `skill-center.spec.ts`、`skill-catalog-client.spec.ts` |
| 迁移保留存量与同名本地 | `skill-center-migration.spec.ts` |

## 3. 真机端到端矩阵（规格 §14.2，2026-11-15 执行）

环境：macOS 本机；隔离 `DSH_HOME=/tmp/hw-skill-accept-20261115/.huaanwork` + 独立 `--user-data-dir` + CDP 9333 + `HUAANWORK_ACCEPTANCE_HOOKS=1`（固定 Web 43120）；本地目录服务 `agent-catalog-server` 监听 `127.0.0.1:19090`（临时 keyring；read/publish/admin 与 alice/bob 两个技能上传口令全部随机生成、互不相同）。两个客户端 = 同一隔离 Home 下的两个 Profile，通过 profile-selection 顺序切换：A=`desktop`（alice 上传口令），B=`accept-b`（bob 上传口令），共享同一 read token。

| 规格 §14.2 项 | 结果 | 证据 |
| --- | --- | --- |
| A 创建含脚本资源的技能并上传 revision 1 | **PASS** | UI 创建 demo 后写入 `scripts/hello.txt`；点击“上传”提示 `已发布技能 demo（revision 1）`；服务端 `GET /v1/skills` 记录 publisher=alice |
| A/B 中心看到共享条目及 revision 1 | **PASS** | A 中心卡：`共享 · 发布者 alice · revision 1`；B 中心卡同（`下载` 可用） |
| B 下载后“我的技能”未启用，`/` 不展示且手工调用被 Host 拒绝 | **PASS** | 下载提示 `已下载技能 demo，请在“我的技能”中启用`；卡片来源“共享副本”、按钮“启用”；资源 `skills/demo/scripts/hello.txt` 完整；新会话手工发送 `/demo …` 得到 `skill demo is disabled` |
| B 启用后 `/` 可调用且资源目录正确；禁用后两条路径再次关闭 | **PASS** | 启用提示 `已启用技能 demo，可在对话框输入 / 调用`；`/` 菜单出现 `/demo`；会话日志含 `# 已启用技能：demo` 与 `技能目录：<profile>/skills/demo`；禁用后 `/` 菜单移除 demo，手工调用再次 `skill demo is disabled` |
| A 更新为 revision 2；B 看到更新但不自动替换本地副本 | **PASS** | A 编辑后“更新上传”→ `已发布技能 demo（revision 2）`；B 中心卡变 `更新`，而本地 SKILL.md 仍为 v1（未自动覆盖）；点击“更新”后才变 v2（`已下载技能 demo…`） |
| B 用不同上传者身份更新 A 的名称 → `skill-name-conflict`，中心不变 | **PASS** | B 点击上传提示 `该技能由其他发布者所有`；服务端 demo 仍为 alice revision 2 |
| 内置同名副本：上传禁用提示，“另存为新技能”后可上传 | **PASS** | B 下载内置 pdf → 卡片“内置副本”，上传按钮禁用并提示 `与内置技能同名，请另存为新技能后上传`；另存为 pdf-copy（提示 `已另存为技能 pdf-copy，请在“我的技能”中启用`）后上传成功 `revision 1`（publisher=bob） |
| 外部技能导入、原文件保留、启用后才可调用 | **PASS** | 原生选择器导入 `ext-visible`（预览正文正确）→ `已导入技能 ext-visible，请在“我的技能”中启用`；源文件仍存在；启用后 `/` 菜单出现 `/ext-visible` |
| 断网后本地技能、启停和已启用 `/` 调用仍工作；中心展示缓存与警告 | **PASS** | 停掉目录服务并刷新：中心显示 `共享技能库不可用，当前显示内置技能与已缓存内容`，缓存中的 demo/pdf-copy 仍在；`/demo` 离线调用仍产出 `# 已启用技能：demo` + 技能目录 |
| 设置保存后技能中心刷新 | **PASS** | 首次保存“公用机配置”后离线提示消失、中心即时可用（无需重启 Host） |
| `user-invocable: false` 的已启用本地技能仍可 `/` 调用（R7） | **PASS** | B 的 demo SKILL.md 改为 `user-invocable: false` 后，`/demo` 仍成功注入 `# 已启用技能：demo` |
| 三种 preset 不再扫描真实 `~/.agents/skills` | **PASS（隔离）** | 以 `DSH_AGENTS_HOME` 指向含 `ext-visible.md` 的临时外部根重启后，中心/我的/`/` 菜单均无该外部技能；原文件保留 |
| 智能体包 `allowSkills` 不能调用未启用本地技能 | **PASS（2026-11-15 补充）** | 播种本地包 `@weekly-report`（`allowSkills:["demo"]`，tools=none）并启用；demo 禁用时真实派发 `@weekly-report`，界面报“智能体 @weekly-report 引用的技能 demo 不可用：skill demo is disabled”；启用 demo 后同一派发完成真实模型回合，父会话收到“周报助手 @weekly-report 已回复：它的技能是先收集本周工作，再生成周报” |
| 升级 fixture（旧用户技能/旧启用内置/同名冲突/外部文件） | **PASS（2026-11-15 受控 fixture）** | 受控旧目录：`skills/legacy-user` + `skill-toggles.json {pdf:true,xlsx:true}` + 同名本地 `skills/pdf`（内容标记）+ 外部 `ext-only.md`。首启后：legacy-user 来源 created 且启用；pdf 文件未被覆盖（标记仍在）、启用、警告 `内置技能 pdf 未复制：已存在同名本地技能`；xlsx 复制为 bundled 并启用；外部技能未导入且原文件保留；`migration.version=1`。随后在 UI 禁用 xlsx 并重启：`skill-local-state.json` 字节不变（哈希相同）、toggles 只剩 legacy-user/pdf、UI 中 xlsx 仍为“启用”（未被迁移重新启用） |
| Windows 真机矩阵 | **WAIVED（R-ACCEPT-1 式，owner 2026-11-15 裁定）** | 无 Windows 主机；**不得写成 Windows 矩阵通过**。替代证据：分支推送后由 CI `desktop-windows` job 构建安装器并在链内运行 `verify-win-installer`（CI 定义既有；本分支尚未跑 CI）。残余风险：真实 macOS→Windows 机器/OS 边界、Windows UI 矩阵、原生目录选择与对话框均未在真机验证。触发条件：获得 Windows 主机时按本节矩阵补跑并更新证据 |

说明：

- 2026-11-15 补充两项：受控迁移 fixture 与真机 `allowSkills` 回合均已执行（见上表）。为跑真实模型回合，临时 profile 需把 `huaanwork-settings.json` 的 `models`/`base_url`/`api_key` 置为生产 DeepSeek 配置并把活动模型改为 `deepseek-chat`，同时在临时 profile 的 设置→权限 打开“允许接入公网”（默认仅局域网会拦截 `api.deepseek.com`）；实测回复“模型可用”，包回合完成。
- 两个客户端为顺序切换的两个 Profile（单实例），不是两台机器同时在线；服务端记录的两个 publisher（alice/bob）分别来自两个 Profile 的独立上传口令，身份隔离仍被真实验证。
- 真实模型回合在本地未配置可用端点（应用活动模型指向 `http://127.0.0.1:11434/v1`），回合以模型连接失败结束；技能链路的判据取自 Host 注入的 `# 已启用技能` 与 `技能目录`（服务端/本地文件证据），不把模型失败当作技能失败，也不据此声称模型对话通过。
- 证据原始目录：`/tmp/hw-skill-accept-20261115/`（应用日志、服务端日志、`catalog-data/`、两个 profile 与截图 `accept-slash-menu.png`）；该目录为临时目录，不入库。

## 4. 自审（Task 11 Step 5）

- 活跃源码无 `all`/`external` 技能标签（grep 0 命中）；`skill.list` 无消费者；无外部 resolver 回退；无普通 bundled 启停恢复。
- 文档不把摘要写成签名（`docs/skill-center*.md` 明示“没有签名/keyring 校验”），不把 CI 写成 Windows 真机通过。
- 本文件第 3 节如实登记 BLOCKED。


## 5. 最终整支评审修复波次（2026-11-15）

整支评审（merge gate）提出 3 项 Important，已在本波次闭环：

1. `THIRD_PARTY_NOTICES.md` 缺少新内置包：运行 `corepack yarn workspace dsh-plugin-huaanwork verify:notices` 重新生成，新增 `| @huaanwork/skill-format | 0.1.0 | MIT | bundled |` 一行（exit 0）。
2. 迁移警告未在界面展示（规格 §11.1.4/§11.1.6）：`SkillsView` 的 `refreshCenter` 读取 `migrationWarnings` 并在技能中心渲染；jsdom 用例断言警告可见。
3. 两标签页缺少可执行 UI 覆盖：新增 `tests/client-huaanwork/skillsView.spec.ts`（3 个 jsdom 用例），补齐 §14.1 的默认页/按钮可见性/系统技能/空态断言；上文 §14.1 映射已更新。

修复波次后的最终门禁（第三条表，均在修复后的最终树执行）：

| 命令 | 退出码 | 关键计数 |
| --- | --- | --- |
| `corepack yarn typecheck` | **0** | 25s |
| `corepack yarn test` | **0** | 103s；全仓 4102 tests（4087 passed / 15 skipped），本次运行无失败 |
| `corepack yarn check` | **0** | 182s；含 `dsh-plugin-huaanwork` 293 files passed / 4 skipped（共 4102 tests：4087 passed / 15 skipped）、双语门禁 51 records / 102 documents |


### 5.1 评审处置与残余波次终态（2026-11-15，HEAD `5a77d0e5f2`）

上表第三条为初审修复波次（`e95980f517`）计数。其后按整支评审校准清单处置 8 提交（`5856463048`..`93351296d3`），再按 owner 裁定处置终检残余：Residual 2（busy 按 key 隔离，`5a77d0e5f2`）、Residual 3（即本小节计数同步）；Residual 1（正则贪婪）经节点实测仅影响非法空 frontmatter 文档、合法技能不受影响，无真实场景，裁定不修（YAGNI）。终态门禁在 `5a77d0e5f2` 顺序实跑：

| 命令 | 退出码 | 关键计数 |
| --- | --- | --- |
| `corepack yarn typecheck` | **0** | 9 个 TS 项目全过；contract-types 4 文件 current |
| `corepack yarn test` | **0** | huaanwork 293 files \| 4 skipped、4110 passed \| 15 skipped（4125）；skill-format 50；agent-catalog-server 112；market-server 244；update-server 88；dsh-community-market 303；其余 workspace 全绿，0 fail |
| `corepack yarn check` | **0** | 含 build / verify:bundled（134 files、10 bundled inlined）/ verify:aa / verify:licenses（637 packages、2 notice-required）/ verify:operations（7 operations、18 fault contracts）/ 双语 51 records、102 documents 完整闭环 |

相对初审波次净增 23 条桌面测试（4087→4110）与 3 条格式包测试（47→50）。Windows 真机矩阵仍按 §6 `R-ACCEPT-1` waiver；本分支未推送、未跑 CI。


## 6. Windows waiver（owner 裁定 2026-11-15，R-ACCEPT-1 式）

- **裁定**：按 `R-ACCEPT-1` 先例，Windows 真机矩阵记为 **complete with waiver**，不得表述为“Windows 矩阵通过”或“跨机器验收实际通过”。
- **替代证据**：本仓库既有 Windows CI 链（`.github/workflows/ci.yml` 的 `desktop-windows` job：`check:win-package:platform` → `Build Windows installer`（`dist:win`，内部执行 `verify-win-installer.ts`）→ portable）。该链需要分支推送后才会针对本分支运行；截至本文件更新时间，本分支**未推送、未跑 CI**，因此替代证据是“已定义且待运行”，不是已获得的运行结果。
- **残余风险**：① 真实 macOS→Windows 机器/OS 边界未验证；② Windows 上的技能中心 UI、下载/上传、`/` 调用、启用门与迁移未在真机执行；③ 原生目录选择器/对话框的 Windows 行为未验证。
- **补跑触发**：获得 Windows 主机后，按本文件 §3 同一矩阵（两 Profile/alice-bob、下载→启用→`/`、更新与冲突、内置同名另存为、外部导入、离线、迁移 fixture）在 Windows 上重跑，并把结果写回 §3，届时移除 waiver 标注。
