# HuaAnWork Desktop M4 人类核对记录（2026-10-04 起，2026-10-07 续）

> **文档性质**：M4 人类核对（裁定 R-M7-6 转 checklist）的执行记录。清单本体 = `docs/checklists/2026-10-m7-ops-and-human-verification.md` §2.3（A1–A28）。本记录跨两个会话：2026-10-04 会话执行 A1/A2（当次未落档，本文件按会话记忆回填并标注）；2026-10-07 会话重建 `dist/` 后继续 A3 起各项。
> **诚实纪律**：未做真机/UI 驱动的不声称通过；人为干预（密码重置）如实登记；阻塞项标阻塞不标通过。

---

## 0. 执行基线

| 项 | 值 | as-of |
|---|---|---|
| fork HEAD | `87432e00cf`（含 M7 全量 + 修复轮 + R-M7-12；A14 的 Task 2.2/2.3 移交项与品牌清扫均在此基线上） | 2026-10-07 |
| 制品 | `dist/mac-smoke/`（2026-10-07 重建；此前 dist 已失，见清单 §2.1） | 2026-10-07 |
| userData | `~/.huaanwork/profiles/desktop/`（含 10-04 重置后的 `account.json`、`huaanwork-migration.json`、`projects.json` 等迁移态） | 2026-10-07 |
| update-server 数据 | `~/Downloads/huaanwork-m6-update-server-data/`（507 MB；**已于 2026-10-10 删除**） | 2026-10-07 |
| `/Applications/HuaAnWork.app` | bundle id `com.huaanwork.desktop` = **旧 Tauri 版残迹，与本次核对无关，全程不触碰** | 2026-10-07 |
| 10-04 环境补注 | 第 0 步已全绿（dmg `8dc014a7…` / app `0a5f7fc1…` / 记录 `69705f3e…` / backup cmp IDENTICAL / marker `84924ded…`） | 2026-10-04 |

---

## 1. 已收口项（2026-10-04 会话，2026-10-07 回填）

### A1 设置页配置核对 —— **通过**（2026-10-04）

深色主题 / 模型端点 `stub-model@127.0.0.1:49212` / `allow_network` 开（可接入公网）/ `guard_mode` = 修改前询问，全部符合 09-22 基线既有值。

### A2 登录态与旧密码验证 —— **通过（带偏差，人为干预如实登记）**（2026-10-04）

- needs-login 门可达。
- 旧华安工作台密码登录被拒（「用户名或密码错误」）= **预期行为**：`account.json` 为 merge-skip，目标账户是 09-22 smoke 账户而非旧树 Amon 账户 ⇒ 正向「旧密码可登录」在此环境结构性不可达。
- **人为干预**：经用户授权，将 smoke 账户密码重置（重置值曾存 `/tmp/m4-smoke-password.txt` 0600，`account.json` 备份 `/tmp/m4-account-backup-20261004.json`；机器重启后 /tmp 已失，重置值另存于执行方私有会话记忆，**不写入本档**）。重置后登录成功（密码由用户手动输入——合成键入对 Electron 无效，已实测三种 CGEvent 变体均失败）。
- **观察项（待裁定，非本清单判据）**：应用闲置约 7.5 小时（机器可能睡眠）后，输入框显示「sidecar 已退出」、状态点变红；日志无崩溃痕迹（host 日志尾行是 06:35 的 agent-preset 警告，顺带坐实 A5 中性根会话 id `huaanwork-21ea5abce4b51784`）。是否缺陷待裁定。

---

## 2. 本次会话执行项（2026-10-07）

### 2.0 制品重建

- [ ] `cd dsh-plugin-huaanwork && corepack yarn dist:mac-smoke`（清单 §2.1 重建路径；构建日志 `/tmp/m4-build.log`）

### 2.1 Launch 1（不设 origin）—— A3–A14、A18

启动方式：`nohup env -u HUAANWORK_UPDATE_ORIGIN -u HUAANWORK_MARKET_ORIGIN dist/mac-smoke/mac-universal/HuaAnWork.app/Contents/MacOS/HuaAnWork`（pid 66225，stdout → `/tmp/m4-launch1.log`）。制品 = 2026-10-07 15:55 重建（`dsh-plugin-huaanwork/dist/mac-smoke/`，DMG smoke verification passed，包内二进制 sha256 前缀 `bed8e4d6147278ef`）。启动即直入主界面（10-04 的 `auth-session.json` 仍有效，smoke 账户在线），**未触达登录门**。
工具链：kimi-cu 0.5.11 仍 service unavailable（同 10-04）；点击 = `/tmp/m4click.swift`（CGEvent，逻辑坐标 = 截图像素 ×0.5）；**托盘项用 AXPress 驱动**（见 A10）。

#### A3 项目列表 —— **通过（带事实订正）**
清单原文期望值「列表为空属预期」。实测侧栏「项目」区有 **1 个项目 `m4-scratch-ws`**（10月4日创建）—— 是 10-04 核对会话的测试产物，**不是迁移残留**；旧树迁移带入的项目数 = 0。磁盘证据：`~/.huaanwork/sessions/` 下另见 `--Users-amonmiao-Downloads-m4-scratch-ws--` 目录（同为 10-04 产物）。无迁移残留脏数据。

#### A4 任务列表 —— **通过（带事实订正）**
清单原文期望值「列表为空属预期」。实测侧栏「任务」区有 **3 条会话**：`你好`（9月22日 11:17 · workspace，迁移自 09-22 smoke 旧树，合法）、`你好` 与 `你好，请自我介绍`（均 10月4日 · workspace，10-04 核对会话产生）。全部来源可解释，无迁移残留脏数据。

#### A5 中性根会话与侧栏呈现 —— **通过**
- 磁盘证据：会话目录 `~/.huaanwork/sessions/--Users-amonmiao-.huaanwork-profiles-desktop-workspace--/huaanwork-21ea5abce4b51784`（含两个子会话）—— id 前缀 `huaanwork-` ✓，cwd 逐字 = `~/.huaanwork/profiles/desktop/workspace` ✓；
- UI 证据：点击 9月22日「你好」会话 → 打开为**空工作区**欢迎页，**无任何报错横幅** ✓。截图 `docs/evidence/assets/m4-2026-10-07/a5-neutral-session.png`。

#### A6 自动化列表 —— **通过**
「自动化」视图显示「还没有自动化任务」（任务/运行记录/看板三页签均空）✓。截图 `…/a6-automations.png`。

#### A7 技能中心出厂状态 —— **通过**
内置技能齐备（brainstorming / darwin-skill / deep-research / dispatching-parallel-agents / explore（始终启用）/ find-skills / frontend-design / frontend-dev / graph / grill-me / humanizer / investigate …），均标「内置」，启用态正常 ✓。截图 `…/a7-skills.png`。

#### A8 智能体目录 —— **通过**
「智能体」目录为空（发现/已启用/本地入口均无条目）✓。截图 `…/a8-agents.png`。

#### A9 macOS Dock 图标 —— **通过**
Dock 图标 = 华安品牌蓝底白字「华」标（运行指示点正常），**非 Electron 默认图标** ✓。截图裁片（dock 区）：记录于本文件同目录证据包 `…/a9-dock-crop.png`。

#### A10 菜单栏托盘图标 —— **不通过（缺陷，真实复现）**
- **现象**：托盘 status item **已创建但渲染完全不可见**。AX 层实测：进程存在第二条菜单栏（`count of menu bars` = 2），item 位置 `(852,4)` 尺寸 `34×24`；该矩形区域截图为纯菜单栏背景，逐像素无任何渲染（放大 3 倍复核）。
- **排除项**：图标资产**正常** —— `build/tray-iconTemplate.png` 16×16 RGBA，alpha>16 的像素 166/256、max_alpha=255（字形存在）；`loadTrayIcon` 在 `image.isEmpty()` 时会 throw ⇒ 资产若损坏启动即崩，而应用正常启动；`prepareTrayIcon` 对 darwin 走 `setTemplateImage(true)`。
- **功能仍可用**：对同一 item 执行 **AXPress 可直接呼出托盘菜单**（菜单项：打开 HuaAnWork / 重新加载界面 / Open DSH Terminal / Export Diagnostics… / 进入安全模式… / Profile: desktop / Check for Updates… / 模式：增强模式 / 退出）⇒ 是**渲染层**缺陷，不是逻辑层。
- **环境**：macOS 26（Darwin 27.0.0）+ Electron 44；本机为刘海屏（3024×1964），菜单栏右侧另有 12 个第三方图标。10-04 会话（M6 构建）从未核过本项 ⇒ **无法归因是否 M7 回归**；本机构建基线 HEAD `87432e00cf`。
- **影响**：A10 判定不通过；A15/A18 的托盘交互改经 AXPress 完成（功能路径不受影响）。
- 证据：托盘菜单截图（AXPress 呼出，`…/a10-tray-menu-axpress.png`）；空白矩形放大图（/tmp 过程图，未入档）。

#### A11 安装器卷与安装卷图标 —— **通过**
`hdiutil attach HuaAnWork-0.1.0-universal.dmg`：卷窗口内 app 图标 = 华安品牌图标（与 Dock 一致）；机械证据：`.VolumeIcon.icns` 与 `HuaAnWork.app/Contents/Resources/icon.icns` **sha256 逐字节一致**（前缀 `f5969529679e99ca`，均 1024×1024）⇒ 卷图标与卷内 app 图标一致性成立。截图 `…/a11-dmg-volume.png`。

#### A12 市场来源面板（MarketSourcePanel）—— **通过**
面板位于「插件市场 → 来源」页签（设置对话框只有 账户/外观/模型/权限 四节，无「市场来源」节——清单的路径表述以本记录为准）。渲染齐备：内网市场源（信任锚未配置，地址 `http://market.intranet.example:8787`，revision 尚无）/ 禁用插件市场 / 华安内网市场（当前）/「添加更多市场源」的 R-4 收窄文案（M7 Task 1.1/D4 的产出物在真机 UI 可见 ✓）。切换来源后有明确保存反馈（「选择已保存。应用会提示重启以生效；若取消重启，选择不会回滚…」）✓。截图 `…/a12-source-panel.png`。

#### A13 macOS 原生目录选择器 —— **通过**
- 侧栏「项目 → + 新建」触发**系统原生 NSOpenPanel**（「Select Workspace Directory」，Favorites/Locations/Tags 齐全）✓，截图 `…/a13-native-picker.png`；
- 选择 `/Users/amonmiao/Downloads/m4-fixture-plugin/` → 新建项目对话框 → 「创建并打开」→ 原生重启确认 → relaunch 后项目 `m4-fixture-plugin` 出现在「项目」区并成为当前工作区 ✓，截图 `…/a13-workspace-switched.png`；
- **基线已还原**：点开 9月22日 中性根会话即回到中性 workspace 视图（`m4-fixture-plugin` 项目留在侧栏，登记为本次核对测试产物，与 10-04 的 `m4-scratch-ws` 同类）。
- 过程发现（与本项无关，记工具链）：CGEvent 键盘事件对**原生 NSOpenPanel 同样无效**（cmd+shift+g 与路径键入均未到达），与 10-04「合成键入对 Electron 无效」一致且范围更广；A13 全程用点击完成。

#### A14 「立即重启」按钮与横幅（含 Task 2.2/2.3 移交项）—— **通过（M7 移交项真机验收）**
完整链路真机跑通：**切源（华安内网市场 → 禁用插件市场）→ 保存反馈 → 原生重启确认「现在重启 HuaAnWork?」→ 取消 → 常备「立即重启」入口在 `requested ≠ effective` 期间常驻**（横幅「已选择『禁用插件市场』…重启应用后生效；取消重启不会撤销该选择…」）**→ 点「立即重启」→ 再次原生确认 → 「重启应用」→ 进程更换（pid 66225 → 67136）relaunch 成功** ✓。
- 重启后禁用态横幅同样诚实可用：「插件市场未启用…可在本页『来源』页签选择『华安内网市场』(huaanwork-market)，确认并重启应用后启用」✓，截图 `…/a14-market-disabled-banner.png`；
- **基线已还原**：切回 华安内网市场 → 保存并重启 → relaunch（pid → 67365）→ 市场恢复正常（`…/a14-market-restored.png`）；
- 证据：原生确认+常备横幅同屏 `…/a14-persistent-restart-banner.png`。
- 附带观察：两次手动「Check for Updates…」期间宿主日志出现 2 行 `tray command failed: DSH Host call cancelled or timed out`（其中一次最终弹出失败框，另一次超时无框）——手动更新检查在不可达 origin 下的超时路径**偶发静默**，与 A18 的诚实反馈设计有张力，登记为观察项。

#### A18 无 origin 启动静默行为 —— **通过（带判据措辞偏差登记，待裁定）**
- 操作：AXPress 呼出托盘菜单 → 点击「Check for Updates…」。
- 实测：弹出警示对话框「**未能获取更新信息。请稍后重试。**」（确定按钮）—— 这是**手动检查失败的设计内反馈**：`electron-runtime.ts:706` `showManualUpdateCheckResult(null)` 对 `result === null` 显式弹该框（「Report one user-triggered check without exposing network or response details」）；M6 冒烟记录 `:184`「无 origin 负例：`null`（24 ms）」与此一致。
- 判据核对：① 未开始任何更新流程（无下载、无 pending-installer）✓；② 请求目标 = 编译期占位 `http://update.intranet.example:8790`（按构造不可达）✓；③ `grep -rn "dshdesktop" src/update-{checker,download,lifecycle}.ts src/updates.ts` = **0 命中**（更新链无任何指向上游公网的代码路径）✓；nettop 采样未捕获出站连接。
- **偏差登记**：清单写「静默无结果」，实测为**可见的失败警示框**。两者冲突；按代码注释这是刻意的诚实反馈（手动触发⇒告知失败；后台轮询失败才静默）。**措辞偏差待裁定**：A18 判据应订正为「不启动更新流程 + 无请求发往 dshdesktop.cn + （手动检查时）失败警示框」，或裁定代码应对手动检查也静默。
- 证据：对话框截图 `…/a18-update-failed-dialog.png`。

### 2.2 Launch 2（loopback update-server + origin）—— A15–A17

环境：update-server `UPDATE_SERVER_PORT=8794 UPDATE_SERVER_DATA_DIR=$HOME/Downloads/huaanwork-m6-update-server-data UPDATE_SERVER_PUBLIC_ORIGIN=http://127.0.0.1:8794`（pid 68296，A19 后已停）；客户端 `HUAANWORK_UPDATE_ORIGIN=http://127.0.0.1:8794` 直跑（pid 68318）。端点预检：`/api/desktop/version` 回 `{"version":"0.1.1","channel":"huaanwork","sha256":{"mac":"8dc014a7…5242"}}` —— channel 回显 ✓（L2-2）、sha256 与 §2.1 DMG 指纹一致 ✓（L2-5）。

#### A15 托盘「检查更新」提示 —— **通过**
启动后约 60s 后台检查触发，托盘菜单出现「**HuaAnWork 0.1.1 Available**」（英文locale；HuaAnWork 品牌名 ✓，M7 Task 3.2 tray-locale 清扫的真机呈现——同时也是附录 C3「有可用更新」态的首次真机证据）。截图 `…/a15-tray-update-available.png`。

#### A16 确认更新与下载弹窗 —— **通过**
点「HuaAnWork 0.1.1 Available」→ 确认框「**HuaAnWork 0.1.1 已可用。现在下载此更新？**」（下载/稍后，品牌名 ✓）→「下载」→ 保存对话框默认文件名 **`HuaAnWork-0.1.1-mac.dmg`**（位置：下载）✓。截图 `…/a16-save-dialog.png`。

#### A17 下载完成与隔离属性检查 —— **通过**
- `~/Library/Application Support/HuaAnWork/updates/pending-installer.json` = `{"stateVersion":1,"platform":"darwin","version":"0.1.1","path":"/Users/amonmiao/Downloads/HuaAnWork-0.1.1-mac.dmg"}` ✓；
- `xattr -l` 输出**不含 `com.apple.quarantine`**（仅 lastuseddate/macl/provenance）✓；
- 下载件 sha256 = `8dc014a72fd684db19d89672d214f06446c1ad3751920cd5b0bc8fc456c5d242`，**逐字符等于**通道记录与 §2.1 的 DMG 指纹 ✓ —— D-M6-23 的 sha256 钉扎在**生产下载路径**上端到端生效（D1 hotfix 的真机证明）。

### 2.3 A19（最后执行，篡改负例）—— **通过（含恢复复核）**

**前置状态手术（如实登记）**：quit 客户端 → 将 A17 下载的完好 dmg 移存 `/tmp/m4-a19-good-dmg.dmg` → 删除 `updates/pending-installer.json`（重置为「未下载」态以触发重下）→ 通道记录另存 `/tmp/m4-a19-record-backup.json` 双备份。

**篡改**：`channels/huaanwork.json` 的 `artifacts.mac.sha256` 首字符 `8→9`（单字符，`8dc0…` → `9dc0…`），服务端即刻按篡改值服务。

**触发与实测**：
1. 客户端托盘「HuaAnWork 0.1.1 Available」→ 下载 → 保存并下载；
2. 服务端日志：`download request: channel=huaanwork platform=mac target=0.1.1`（字节确实被服务）；
3. **客户端零落盘**：`~/Downloads` 无 dmg、`updates/` 无 pending-installer.json、无临时文件残留 ✓（UI 静默 = 设计内行为，`update-lifecycle.ts:265` 对下载失败刻意静默）；
4. **代码层确证**（与 UI 流同一服务端、同一篡改记录、同一份 shipped 源码直跑）：`downloadDesktopUpdate` 抛 `UpdateDownloadError`，**code = `update-integrity-mismatch`**，message = `The downloaded installer sha256 (8dc014a7…) does not match expected (9dc014a7…)`，目标目录残留 = `[]` ✓。

**恢复与复核（必做步骤）**：
- 通道记录从官方备份 `.superpowers/sdd/2026-09-27-*/logs/task-7.3-record-backup.json` 恢复；`cmp` 对官方备份与双备份**均 IDENTICAL** ✓；
- 端点复验：服务端重新服务 `8dc0…` 原值 ✓；
- 客户端态还原：完好 dmg 移回 `~/Downloads/HuaAnWork-0.1.1-mac.dmg`（sha256 `8dc014a72fd684db19d8…` 复核 ✓）、`pending-installer.json` 按 A17 实测内容逐字重写 ✓；
- update-server 已停、客户端已退出。

---

## 3. 长期阻塞项登记（A20–A28，照录清单 §2.3）

A20/A21（Apple 凭据，R-6）、A22–A24（Windows 面）、A25（旧树无该类数据）、A26（旧仓 Tauri 环境）、A27（7 天真机等待）、A28（内网部署机未交付）—— 均为组织/环境级长期阻塞，本轮不执行，不标通过。

---

## 4. 本轮新发现与观察项登记

| # | 发现 | 定性 | 归属建议 |
|---|---|---|---|
| F-M4-1 | **托盘图标渲染不可见**（A10）：status item 已创建（AX 层存在、位置 (852,4) 34×24、AXPress 可呼出全功能菜单），但逐像素零渲染。图标资产正常（166/256 有效 alpha 像素）。macOS 26（Darwin 27）+ Electron 44 环境；10-04（M6 构建）未核过本项，无法归因是否 M7 回归 | **缺陷（渲染层）** | 登记 fork 债表；修法方向：确认 macOS 26 的 NSStatusItem/模板图渲染行为，必要时换非模板图或显性 `setImage` 尺寸；真机复核对内网 mac 版本有依赖 |
| F-M4-2 | **A18 判据措辞偏差**：清单写「静默无结果」，实测为设计内的手动检查失败警示框（`showManualUpdateCheckResult(null)`，「未能获取更新信息。请稍后重试。」）。无更新流程启动、无 dshdesktop.cn 代码路径（grep=0） | **判据措辞待裁定** | 订正清单措辞为「不启动更新流程 + 无请求发往 dshdesktop.cn + 手动检查弹失败框」，或裁定手动检查也应静默 |
| F-M4-3 | 手动「Check for Updates…」在不可达 origin 下**偶发静默超时**（宿主日志 `tray command failed: DSH Host call cancelled or timed out`，两次中一次无弹框）——与「手动检查必弹失败框」的诚实设计有张力 | 观察项（健壮性） | 登记债表；调查 tray command 超时的静默路径 |
| F-M4-4 | 每次启动日志都打印迁移信息「已从旧版华安工作台迁移：sessions 1、sessionsReminted 1。跳过 3 项…需要重新登录一次。」（幂等重跑，但「需要重新登录一次」对已完成迁移的用户是误导性文案） | 观察项（文案） | 登记债表；已完成迁移的启动不应再提示重新登录 |
| F-M4-5 | `guard_mode` 现值 = `smart`（高危才询问），非 09-22 基线的「修改前询问」——系 10-04 A1 的「切换 guard_mode 生效」测试动作留置（经用户授权的测试行为），非缺陷 | 状态登记 | 如需回基线，设置页切回即可；本记录不回改 |
| F-M4-6 | 焦点争用：核对期间用户其他工作（cbc 终端 / Kimi / WPS）三次抢走前台，点击误落（均即时发现并止损，未造成实质影响）——**本环境的人类核对应在被核 app 独占前台时进行**；工具纪律「每次点击前查 frontmost」已验证有效 | 流程经验 | 记入债表/工具链说明；后续人类核对批次照此执行 |

## 5. 结论

- **A1–A19 全部执行完毕**：17 项通过（A3/A4/A18 带事实订正或判据措辞登记，A2 带已授权人为干预），**A10 不通过（F-M4-1 托盘图标渲染缺陷）**，A19 负例通过且现场已恢复复核。
- **A20–A28 长期阻塞**（见第 3 节），不标通过。
- **M4 的 M8 前置约束（R-M7-3「M4 先于 M8」）的 19 项可执行项已闭环**；A10 缺陷建议登记债表后由 R5 裁定是否阻塞 M8 立项。
- 证据包：`docs/evidence/assets/m4-2026-10-07/`（14 张截图）+ 本文件正文引用的磁盘/日志实测。

