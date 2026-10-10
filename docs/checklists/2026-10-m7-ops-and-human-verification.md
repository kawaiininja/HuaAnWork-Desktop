# M7 运维工单与人类核对清单（Ops & Human Verification Checklist）

> **文档状态与执行顺序登记（2026-10-07）**：
> 本文档是 M7 稳定化与上游同步准备阶段的运维工单、人类核对与延后项归属清单。
> **执行顺序**：因计划调度，Task 3.4 先于 Task 7.3 执行。由 Task 3.4 率先创建本文档骨架并完整交付**「附录 C：M3 品牌清扫五处目检（R-M7-2，0.5 天）」**。
> **Task 7.3 落地记录**：Task 7.3 已完整编排填充前置主体章节（第 1 节 M2 运维工单 Checklist、第 2 节 M4 人类核对批次化指南与 L2 常驻发版门、第 3 节 M16 IT 端点策略核对、第 4 节 本轮不做 / 延后项归属与触发条件），并保留附录 C。

---

## 1. M2 运维工单 Checklist（6 条卡点，责任人待指派）

### 1.1 背景与执行依据

依据 R-M7-6「M2 按 §3.3 转 checklist，0.5 工程侧 + 运维工单，责任人待组织指派」与评估报告 §8.2。
本项涉及生产内网服务发布基础设施的物理部署面、鉴权面与安全纪律。代码、守卫、测试与 runbook 均已具备，当前卡点在于外部运维基础设施供给与组织审批。

### 1.2 M2 运维卡点清单

| # | 卡点 | 需要什么 | 谁批 | 判据 | 当前状态（实测） |
|---|---|---|---|---|---|
| M2-1 | 内网部署机 | 端口 **8787**（market）/ **8790**（update）、两个**独立** `<dataDir>`；两个服务**可同机**（`market-server-deployment.md:204-218`、`update-server-deployment.md:204`）⇒ 最小物理面 = **1 台部署机 + 1 台离线签名机 = 2 台**（评估 §6.3 第 26 条：「两服务器」的表述易被读成需要 3 台） | IT / 运维基础设施负责人 | 两台机器到位、端口可路由、`<dataDir>` 各自独立 | **未交付**（R2 阻塞位） |
| M2-2 | ssh/scp 通道到部署机 | 部署机与 `<dataDir>` 的访问控制是本服务**唯一的鉴权面**（`update-server-deployment.md:249-251` 明示） | 安全团队 / 运维管理层（⚠️ 审批等级 = 向全内网分发任意可执行代码） | 通道可用 | **未交付** |
| M2-3 | 物理离线签名机 | 气隙、不挂内网共享盘、私钥 **0600**（`market-server-deployment.md:560-562`） | 离线密钥管理员 / 安全团队 | 机器到位、私钥权限实测 0600 | **未交付** |
| M2-4 | 第二信道传递公钥指纹 | 非邮件、非同一 IM 会话（`market-server-deployment.md:534-535`：「与 app 发版流程绑定的内部工单/签名邮件/口头 + 二次确认，**不得**经 market-server 自身通道回读（防自证）」） | 发版执行人与安全复核人（双人审批） | 指纹经两条独立信道到达同一人 | **未交付** |
| M2-5 | 发行分支策略 | `master` 按设计保持**未 provisioning** ⇒ 需要分支策略裁定；而「发行分支」这一概念在仓库里**没有任何实体**（评估 §8.2） | 架构师 / 工程负责人 | 一份裁定 + 分支命名约定 | **未裁定** |
| M2-6 | 双侧 NTP | 签名机与 market-server 都要对时（Task 7.1 已把它补进 `release-checklist.md`） | 运维基础设施与离线签名机管理员 | 两侧 `date -u` 与可信源偏差 < 30 s | **未在发行清单里**（L1 已修） |

### 1.3 第二信道公钥指纹人工比对操作规程

> **安全核心红线**：
> **指纹核对必须逐字符、按设计不可自动化以防自证（防通过脚本自证明）**。
> 任何通过脚本比较两端哈希的行为均构成单点代码执行风险，严禁用脚本比较替代人工核验。

**人工比对标准作业规程（SOP）**：
1. **信道物理隔离**：
   - 第一信道：签名管理员在离线签名机上导出公钥及其 sha256 指纹（64 位十六进制字符），通过安全受控介质（如安全 U 盘）传输至发版环境；
   - 第二信道：公钥指纹经独立第二信道（如经安全审批的独立工单系统、双人保密电话/即时口头核准、或带外专用防篡改通道）传递至发版负责人，严禁经由 market-server 自身或同一邮件/IM 会话传递。
2. **打印或双屏隔离展现**：
   - 将第一信道接收到的守卫输出 `sha256(公钥原始字节)` 与第二信道接收到的带外指纹分别打印在纸质工单上，或在两个物理隔离的屏幕上分别完整全屏展示。
3. **逐字符圈读核对**：
   - 由发版执行人与安全复核人两人在场，针对 64 位字符逐个逐位比对：
     - 4 字符一组（共 16 组），一人逐组报读，另一人逐字符圈阅核对；
     - 确认大小写十六进制字符完全一致，无字符易位或同形字替换。
4. **双人签字留档**：
   - 两人在纸质发版工单或审批记录上分别签署姓名与时间戳（精确至分钟）；
   - 将核对通过的公钥及指纹作为发行基线归档，记录归档编号。

### 1.4 工程侧 0.5 人日配置定位说明

当上述运维前置（M2-1 至 M2-6）全部到位后，工程侧完成发版 provisioning 配置耗时约 0.5 人日，涉及两处配置常量与两处 origin 的填入：
1. **公钥与指纹填入位置**：
   - 目标文件：`dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts`
   - 代码行：
     - `DEFAULT_MARKET_VERIFICATION_PINS = Object.freeze({})` @ `:104`（源码默认未配置形态）
     - `PINS_AT_RELEASE` @ `:113`：在此将 `current` 槽填入两项字符串（一对十六进制）：
       ```typescript
       export const PINS_AT_RELEASE: MarketVerificationPins = Object.freeze({
         current: {
           keyId: '<64位 sha256 公钥指纹小写 hex>',
           publicKeyHex: '<64位 ed25519 原始公钥小写 hex>',
         },
       })
       ```
2. **两个服务 Origin 常量位置**：
   - 市场服务默认 Origin：`HUAANWORK_MARKET_DEFAULT_ORIGIN` @ `dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts:31`（注：设计文档早期所引 `:15,103` 经评估 §6.1 第 1 条订正，均为注释行，真实代码实体在 `:31`）。
   - 更新服务默认 Origin：`HUAANWORK_UPDATE_DEFAULT_ORIGIN` @ `dsh-plugin-huaanwork/src/update-checker.ts:17`（注：设计文档早期所引 `:17` 为真实代码实体）。
3. **机械门禁闭环**：
   - 配置完成后，执行：
     ```bash
     node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs
     ```
   - **判据**：退出码由当前的 `EXIT=1`（当前实测明确报告 4 项缺失：`publicKeyHex`、`keyId`、`MARKET_DEFAULT_ORIGIN` 占位符、`UPDATE_DEFAULT_ORIGIN` 占位符）变为 `EXIT=0`，方可进入构建打包。

---

## 2. M4 人类核对批次化指南与常驻发版门

### 2.1 环境现状与哈希复核（as-of 2026-10-07）

依据裁定 R-M7-6、评估报告 M4 行与审查发现 P3-14，人类核对必须严格基于实测环境与真实制品指纹，严禁使用相对日期描述。

**环境逐字节实测记录（as-of 2026-10-07）**：
- `dist/` 状态：**未在树中**（`ls -ld dist` 返回 `No such file or directory`；属于 git-untracked 目录，环境已失）；
- 更新服务数据目录：`~/Downloads/huaanwork-m6-update-server-data/` **在场**（实测占用 507 MB；**该目录已于 2026-10-10 删除**）；
- **五个关键制品与记录指纹复核结果**：
  1. DMG 安装器：`artifacts/huaanwork/mac/HuaAnWork-0.1.1-universal.dmg` sha256 = `8dc014a72fd684db19d89672d214f06446c1ad3751920cd5b0bc8fc456c5d242`（**吻合 MATCH**）；
  2. 通道发布记录：`channels/huaanwork.json` sha256 = `69705f3e0f968f100dd4384cee9ff723995492c2cf8edfd32822868111346549`（**吻合 MATCH**）；
  3. 客户端 App：`dist/mac-smoke/mac-universal/HuaAnWork.app` 二进制（历史记录 sha256 = `0a5f7fc1…`，因 `dist/` 未纳入版本控制已失，当前处于**阻塞，待重建**）；
  4. 迁移 Marker 标记：`data-directory/state.json` / marker（历史记录 sha256 = `84924ded…`，当前因 `dist/` 不在场，处于**待复跑验证**）；
  5. 记录备份比对：`cmp channels/huaanwork.json task-7.3-record-backup.json`（**字节完全一致 IDENTICAL**，已实测验证）。

**诚实状态核定**：
因本地未跟踪的 `dist/` 目录已失，原评估记录中依赖本地冒烟构建产物的项均无法直接执行。
因此，当前状态严格登记为：**as-of 2026-10-07 可执行的 0 项 + 28 项阻塞（环境已失）**。
- **重建路径**：一旦执行 `cd dsh-plugin-huaanwork && corepack yarn dist:mac-smoke` 重新生成本地冒烟制品，A1 至 A19 共 19 项将立即转为「可执行」状态；
- 余下 A20 至 A28 共 9 项因依赖组织外部凭据、Windows 硬件或极端环境，仍处于长期阻塞。

### 2.2 强制执行顺序与前置约束

执行 M4 人类核对时必须严格遵守以下执行顺序与前置条件，严防破坏性操作污染后续步骤：
1. **排期约束**：**必须先于 M8（上游大同步）执行**。
   - 裁定 R-M7-3 明示：上游大同步（M8）将对内核与依赖制品进行全面替换，届时制品指纹与行为必须全部重跑。因此 M4 核对必须在 M8 启动前完成基线验收闭环。
2. **A2 密码前置**：**A2 需用户的旧华安工作台密码**。
   - 这是全流程中**唯一不可自动化的前置条件**（裁定 §5.1 / 评估 §8.3）。核对人员无法通过伪造哈希通过验证，必须由真实用户在场并输入旧华安工作台密码完成登录验证。
3. **A18 启动约束**：**A18 须不设 origin 启动**。
   - 验证无 origin 默认静默行为时，必须确保环境变量 `HUAANWORK_UPDATE_ORIGIN` 未被导出；因此核对全流程中**至少启动两次应用**（一次配置 loopback origin 验证更新下载全链路，另一次不配置 origin 验证静默无网络请求）。
4. **A19 破坏性顺序**：**A19 篡改项必须最后执行，且做完后立即恢复复核**。
   - A19 属于主动修改通道哈希的破坏性负例验证。若提前执行将导致服务端通道记录处于损坏状态，污染其它更新项。必须安排在所有更新与 UI 观察项全部通过后作为最后一项执行，且在触发失败后**立即通过备份文件恢复并复核 sha256**。

### 2.3 M4 28 项人类核对清单明细（A1 至 A28）

下表完整编排 28 项核对项，涵盖 19 项（待本地制品重建后可做）与 9 项（长期依赖阻塞项）：

| 编号 | 分类 | 核对内容 | 操作步骤与期望 | 当前状态（as-of 2026-10-07） |
|---|---|---|---|---|
| A1 | 数据迁移/设置 | 设置页配置核对 | 打开「设置」，核对模型端点/主题/allow_network/guard_mode（期望值符合 09-22 基线：dark / stub-model / allow_network true / guard_mode ask）；切换 guard_mode 生效 | 待制品重建后可做（当前阻塞，待 dist） |
| A2 | 数据迁移/认证 | 登录态与旧密码验证 | **需用户在场并提供旧华安工作台密码**；应用停在 needs-login，使用旧密码成功登录进入主界面 | 待制品重建后可做（当前阻塞，待 dist + 待用户在场） |
| A3 | 数据迁移/数据 | 项目列表空目检 | 打开项目视图；本机旧树无项目，列表为空属预期；无迁移残留脏数据 | 待制品重建后可做（当前阻塞，待 dist） |
| A4 | 数据迁移/数据 | 任务列表空目检 | 打开任务视图；列表为空属预期；无迁移残留脏数据 | 待制品重建后可做（当前阻塞，待 dist） |
| A5 | 数据迁移/会话 | 中性根会话与侧栏呈现 | 侧栏「任务」区显示迁移重铸的中性根会话（前缀 `huaanwork-`，cwd 为 `~/.huaanwork/profiles/desktop/workspace`）；点击打开显示空工作区且无报错横幅 | 待制品重建后可做（当前阻塞，待 dist） |
| A6 | 数据迁移/自动化 | 自动化列表空目检 | 打开自动化列表；无迁移数据，列表为空属预期 | 待制品重建后可做（当前阻塞，待 dist） |
| A7 | 数据迁移/技能 | 技能中心出厂状态 | 打开技能中心；出厂内置技能存在且启用态正常 | 待制品重建后可做（当前阻塞，待 dist） |
| A8 | 数据迁移/目录 | 智能体目录空目检 | 打开智能体目录；无迁移数据，空目录属预期 | 待制品重建后可做（当前阻塞，待 dist） |
| A9 | 图标目检（附录 A） | macOS Dock 图标 | 应用运行时观察 Dock 图标，显示华安品牌图标，严禁出现 Electron 默认图标 | 待制品重建后可做（当前阻塞，待 dist） |
| A10 | 图标目检（附录 A） | 菜单栏托盘/状态区图标 | 观察 macOS 顶部菜单栏托盘图标，随系统深浅主题自适应反色，无彩边或锯齿 | 待制品重建后可做（当前阻塞，待 dist） |
| A11 | 图标目检（附录 A） | 安装器卷与安装卷图标 | `hdiutil attach` DMG 安装包，观察挂载卷图标与卷内 app 图标一致性 | 待制品重建后可做（当前阻塞，待 dist） |
| A12 | 面板目检（附录 B） | 市场来源面板（MarketSourcePanel） | 打开「设置」→「市场来源」；面板可正常打开，当前来源显示正确，切换来源后有保存反馈 | 待制品重建后可做（当前阻塞，待 dist） |
| A13 | 面板目检（附录 B） | macOS 原生目录选择器 | 触发打开项目/工作区入口，系统弹出 macOS 原生目录选择器；选择后工作区切换成功 | 待制品重建后可做（当前阻塞，待 dist） |
| A14 | 交互目检（附录 B） | 「立即重启」按钮与横幅（含 Task 2.2/2.3 移交项） | 执行插件安装/卸载（remove）或切源，在原生重启确认弹窗中选择**取消**；界面出现再触发「立即重启」常备入口；点击后应用成功 relaunch | 待制品重建后可做（当前阻塞，待 dist） |
| A15 | 更新链路 | 托盘「检查更新」提示 | 启动 loopback update-server（端口 8794），带 origin 启动客户端；约 60s 后托盘菜单出现新版本 0.1.1 可用提示 | 待制品重建后可做（当前阻塞，待 dist） |
| A16 | 更新链路 | 确认更新与下载弹窗 | 确认更新并进入下载流程，保存对话框默认文件名为 `HuaAnWork-0.1.1-mac.dmg` | 待制品重建后可做（当前阻塞，待 dist） |
| A17 | 更新链路 | 下载完成与隔离属性检查 | 下载完成后核对真实 userData 的 `updates/pending-installer.json`；执行 `xattr -l` 确认无 `com.apple.quarantine` 属性，sha256 与 DMG 严格吻合 | 待制品重建后可做（当前阻塞，待 dist） |
| A18 | 更新链路负例 | 无 origin 启动静默行为 | **须不设 origin 启动（独立启动一次）**；点击「检查更新」，静默无结果，且抓包确认无任何请求发往 `dshdesktop.cn` | 待制品重建后可做（当前阻塞，待 dist） |
| A19 | 更新链路负例 | D-M6-23 通道记录篡改拒绝 | **必须最后执行**：改动 `channels/huaanwork.json` 的 sha256 一位字符；触发检查更新，下载被拒报 `update-integrity-mismatch` 且无临时文件残留；**做完立即用备份文件恢复并复核 sha256** | 待制品重建后可做（当前阻塞，待 dist） |
| A20 | 发行凭据 | macOS 开发者证书签名验证 | 执行 `codesign --verify --deep --strict <app>`；验证 Developer ID 签名有效性 | **阻塞**（未采购 Apple 凭据，R-6 延后） |
| A21 | 发行凭据 | macOS Gatekeeper 公证验证 | 执行 `spctl -a -vv <app>`，验证 Apple Notarization 公证票据 | **阻塞**（未出网公证，R-6 延后） |
| A22 | Windows 发行 | NSIS 安装器构建与解包校验 | 跑 `verify-win-installer.ts`，验证 Windows NSIS 安装器与解包结构 | **阻塞**（无 Windows 主机 / CI 缺 win-unpacked 产物） |
| A23 | Windows 发行 | Windows Authenticode 签名 | PowerShell `Get-AuthenticodeSignature` 校验 Status=Valid 与时间戳 | **阻塞**（未采购 Windows 签名证书，R-6 延后） |
| A24 | Windows 链路 | Windows 工作区切换链路 | spec §14 第 21 条：验证 Windows 平台下工作区路径选择与切换可达性 | **阻塞**（无 Windows 运行环境） |
| A25 | 迁移边缘数据 | `_no-cwd` 与 subagent 会话呈现 | M24 项：在真实旧数据包含 `_no-cwd` 或 `origin: 'subagent'` 时核验 UI 呈现 | **阻塞**（真实旧树无该类数据，空转） |
| A26 | 自动化运行 | legacy `channel: "chat"` 自动化无人值守运行 | 核验旧工作台 chat 模式自动化在更新后作为无人值守 script 正常执行 | **阻塞**（需旧仓 Tauri 运行环境） |
| A27 | 市场安全 | 7 天信封寿命静默期过期 502 演练 | M11 项：在无发布静默期超过 7 天后，真机核验市场客户端返回 502 fail-closed | **阻塞**（需真机等待 7 天或系统级时钟注入） |
| A28 | 运维环境 | 内网生产部署网络通道与鉴权 | M2 项：在真实内网部署机（8787/8790）与隔离网络环境下进行全链路连通性核验 | **阻塞**（内网部署机与离线机未交付） |

*注：Task 3.4 交付的五处品牌清扫目检详见本文档 [附录 C](#附录-c-m3-品牌清扫五处目检r-m7-205-天)；Task 2.2/2.3 移交的重启入口真机项已集成至 A14。*

---

### 2.4 L2 常驻发版核对清单（Standing Release Checklist）

依据 `docs/update-server-deployment.md:319-335`〈与客户端的耦合点（发版前逐条核对）〉及评估报告 L2 建议，以下 5 条客户端与更新服务端的强耦合判据必须作为**常驻发版核对清单（每次发版必跑，严禁作为一次性项跳过）**：

| # | 核对项 | 规范要求与判据 | 执行方式 / 命令 | 判定结果 |
|---|---|---|---|---|
| L2-1 | Origin 完全相等 | 客户端 `HUAANWORK_UPDATE_ORIGIN` 必须**逐字完全等于**服务端 `UPDATE_SERVER_PUBLIC_ORIGIN`（协议 + 主机 + 端口，无多余斜杠、路径或 query；严禁使用占位 `.example`） | 比对构建配置与服务端环境配置 | 待每次发版逐条核验 |
| L2-2 | Channel 严格回显 | 服务端版本端点响应的 `channel` 必须等于请求 channel，且必须属于 `SUPPORTED_RELEASE_CHANNELS` 白名单（`stable` / `beta` / `huaanwork`） | `curl -s <origin>/api/version/huaanwork \| jq .channel`（输出必须为 `"huaanwork"`） | 待每次发版逐条核验 |
| L2-3 | 规范 SemVer 格式 | 版本号必须是无 prerelease 的规范 SemVer（`huaanwork` 与 `stable` 必须为 `x.y.z` 纯数字；`beta` 必须为 `x.y.z-beta.N`），裁定 D-M6-1 双侧强制 | `curl -s <origin>/api/version/huaanwork \| jq .version` | 待每次发版逐条核验 |
| L2-4 | 下载端点路径一致 | 下载端点必须严格为 `/api/downloads/mac` 与 `/api/downloads/windows`，严格匹配客户端双端下载协议 | `curl -I <origin>/api/downloads/mac`（必须返回 200 或带 `X-HuaAnWork-Artifact-Sha256` 头的流） | 待每次发版逐条核验 |
| L2-5 | 制品 Sha256 逐位吻合 | 客户端下载后按 sha256 强校验制品（D-M6-23）；服务端通道记录发布时的 sha256 必须严格等于将被服务的那份制品字节的真实哈希 | `shasum -a 256 <待分发制品>` 与 `curl -s <origin>/api/version/huaanwork \| jq .sha256` 比对一致 | 待每次发版逐条核验 |

---

## 3. M16 IT 端点策略核对 Checklist（0.25，立即做）

### 3.1 背景与核实发现

依据裁定 R-M7-6「M16 R-6 维持延后 + IT 端点策略核对 0.25 立即做」及评估报告 M16 行。
**真实核实结论**：
1. **R-6 现状**：已于 2026-09-30 由用户签署生效（`rulings:48-54` 七项全 `[x]`，`:74`），并不存在「待签署」问题；
2. **触发条件一（外部分发需求）**：未满足。两仓 grep 命中的均为裁定文本自身与复述，无真实外部请求；
3. **触发条件二（IT 端点策略限制）**：**未核对**（非「已核对为否」）。`release-checklist.md:376-382` 已识别出具体失效模式（签名仅覆盖外层安装器与应用 exe，载荷内 `.node`/`.dll` 未逐个签名，按 PE 逐个校验的策略会拦），但在企业内网中从未有一次对真实 IT 策略的正式查询记录。这意味着**即使立即采购凭据，也可能因载荷内二进制未逐个签名而仍被企业安全策略拦截**。因此该 0.25 人日核对动作必须立即启动。

### 3.2 须向 IT / 安全部门核实的问题清单

本清单必须由工程团队通过组织正式通道向 IT 运维与安全团队发起核实，**严禁由工程侧自行推测或代替判定**：

| # | 要问 IT/安全的具体问题 | 为什么要问 | 判据 |
|---|---|---|---|
| M16-1 | 端点是否启用 WDAC / AppLocker 一类 code-integrity 策略？ | `release-checklist.md:376-378` 已登记「可以不经提示直接拦下未签名二进制」 | 有/无 + 具体策略名称与配置基线 |
| M16-2 | 该策略是**按 PE 逐个校验**，还是只校验外层安装器？ | 这是 `release-checklist.md:379-382` 识别的具体失效模式：本管线只签外层安装器与应用可执行文件两个 PE，载荷内 `.node`/`.dll` **不逐个签名**（上游在本仓之外的 runtime 阶段逐个签，本仓没有该阶段） | 逐个 / 只外层 |
| M16-3 | 未签名的内网分发是否有豁免通道？申请流程与周期？ | 决定 R-6 的「内网自用」是否真的可行 | 有/无豁免通道 + 审批流程与周期 |
| M16-4 | 若需逐个签载荷内 PE，工作量与工具链是什么？ | 上游用 `windows-sign.mjs` 的 `preserveSignature`/签钩子；本仓**没有**该阶段 ⇒ 需新建 | 人日评估 + 组织指定工具链/证书硬件依赖 |
| M16-5 | macOS 侧：Gatekeeper 对未签名 + 无 quarantine 的 app 的组织策略？ | 经应用内更新下载的包**不带 quarantine**（冒烟记录 `:174` 实测，正是 R-6 依据①）⇒ Gatekeeper 不评估；组织策略可能另有要求 | 组织管理策略文本（如 MDM 强制限制） |

### 3.3 R-M7-1 风险接受重裁确认

在 R-6 延后维持的同时，必须对当初的「风险接受」前提进行诚实重裁与确认：
- **历史记录偏差**：2026-09-30 签署 R-6 时登记的风险接受前提为「sha256 钉扎防单点篡改、只不防两端同控」。但根据实证，在 D1 缺陷修复前（提交 `246bd2a59d` 之前），客户端应用层完整性校验控制数实际为 0（生产路径未校验 sha256），单点篡改亦无法防范，且 7 天信封寿命属市场链、并不覆盖更新链；
- **现状确认**：当前 D1 活缺陷已被提交 `246bd2a59d` 正式修复，客户端下载后已强制核对 sha256 且有负例回归钉锁住；
- **重裁结论**：完整性控制已重新接线闭环，当前内网未签名发行的风险水平**已真实回到 R-6 签署时所陈述的形状**。维持 R-6 延后采买凭据的有效性。

---

## 4. 本轮不做 / 延后项的归属与触发条件

### 4.1 延后与未实施项归属汇总表

依据裁定 R-M7-7、技术债表（`AGENTS.md:44-57`）与相关任务落地情况，本轮未实施与延后项登记如下。**每项均明确登记其归属或后继触发条件，严禁无归属悬空**：

| 项 | 状态 | 触发条件 / 归属 |
|---|---|---|
| **M18** | 目录分页 / 多页签名 | 延后（维持 R-3，触发条件已改写）：在册条目 ≥ **150**，或清单 canonical 字节 ≥ **3 MiB**，或平均条目元数据 ≥ **15 KB**。三个量现可由 `/healthz` 与 `/v1/admin/state` 直接读取观测（Task 4.1 已落地）。归属：M8 之后，按读数触发。 |
| **M19** | 两条升级路径 | 维持不做（文档态完整）：归属 `docs/market-upgrade-paths.md`；触发条件为换信任根的产品需求。唯一需动的实体为 D4 UI 文案，已由 Task 1.1 处理。 |
| **M20** | 签名轮换非零窗口 | 维持「已接受」（经真实双钥 + 两包真码复跑四组合仍成立）。附带 0.25 人日 runbook 嵌套形态补充已由 **Task 7.2** 落地。消除该窗口需在线吊销（spec §14 第 41 条明裁不存在）或远程可更新 keyring（M19 未决）。 |
| **M22** | P21 Hunk 3 补登记 | **已由 `3aa25d8e52` 完成**（债表 `:48`）。Task 6.3 按 spike 实测**更新**了它（跨边界读取 root scripts 的文件由 2 个更新为 4 个）。 |
| **M23** | 三包 `tests/` 守卫 | 延后；**本轮只批基线分类，已由 Task 6.4 完成**。建守卫前置：先清理 `should-be-identical` 存量（6 条）+ 给守卫增加「仅存在于 left 侧」单侧语义（Task 1.3 发现的限制）。归属：M8 之后。 |
| **M24** | `_no-cwd` 与 subagent 会话分类 | 延后（**数据层已有隔离门覆盖**，`sessions.spec.ts:304`/`:319`，140 passed 实跑，不得声称未验证）。触发条件：任一真实用户旧树被发现含 `_no-cwd` 目录或 `origin: 'subagent'` 会话；或 M4-A5 侧栏发现异常；或 M28 触及目录约定。归属：触发后 1 人日 + 0.5 人日人类核对。 |
| **M25** | market-server 审计日志 | 实现延后（3 人日）；**文档诚实化已由 Task 7.2 落地**。实现档明确排除「审计日志自身的完整性保护」。归属：技术债表 `AGENTS.md:54`。 |
| **M26** | 市场 UI 的 `/plan-design-review` | **已完成（2026-10-08，M26 闭环）**：评审工件见 `HuaAnWork/docs/superpowers/specs/2026-10-08-market-ui-design-review.md`；第一轮 P 级缺陷已由 Task 2/3 修复闭环（搜索空态误报、Esc 焦点解耦、ErrorPanel 重试入口）；GSTACK Design Review 行 Runs 0→1。 |
| **M27** | Windows 面 | 延后；**触发条件已于 2026-10-04 部分成立**（Task 0.4 已重估并订正债表 `:55`）。实质缺口仍存在：`ci.yml:140-148` 的 `desktop-windows` 缺少 `verify-win-installer` 步骤、`release.yml:186-189` 的 upload path 不含 `win-unpacked/`。归属：1.5 人日，且可在 CI 内完成而不需要 Windows 主机。 |
| **M28** | 上游大同步（阶段 B） | **另立里程碑 M8**（裁定 R-M7-3，15–25 人日）。三个前置裁定随 M8 计划再裁。Task 6.3 的 `needs-ruling` / `replay-fork` / `fork-owned-override` 三份清单为直接输入。 |
| **M29** | `verify:aa` 并发竞态 | **本轮不评估**（设计文档明示）。复议触发点：M8 重钉 AA 桥时顺带核实上游是否已修。出处：债表 `AGENTS.md:44` + M6 计划 §5.5 第 6 条（spec §14 对此零命中）。 |
| **L2** | 〈与客户端的耦合点〉常驻门 | **本 Task 已转成常驻发版 checklist**（见第 2.4 节）。归属：本文档常驻门禁，每次发版必跑。 |
| **L3** | 备份节奏无机制 | **本轮只登记，不建机制**。Task 7.1 的监控/HA 节已诚实定性为「无机制、纯人工纪律」。归属：若建机制属运维基础设施，需独立运维裁定。 |
| **E1①** | 4 MiB 与 2 GiB 相差 512 倍无关联说明 | **已由 Task 4.1 处理**。`scripts/market-manifest-byte-budget.json` 的 `note` 字段与 runbook 的〈目录规模上限〉节现已把两个上限的关系写明。 |
| **E2⑤** | `update-download.ts:143` 的 `redirect: 'follow'` | **本轮只登记不实现**。明文下载端点可 302 到任意主机且客户端跟随（版本检查侧为 `redirect: 'error'`），已在 M-D1 登记为放大因子。归属：M8（上游同改）或独立安全裁定。 |
| **E2⑦** | nginx 灾备旁路从未演练 | **本轮只登记**。含 4 条已登记的不等价项；「发行动作与灾备动作不可同时进行」已写进 Task 7.1 事故响应节。归属：M2 交付部署位之后演练。 |

---

## 附录 C：M3 品牌清扫五处目检（R-M7-2，0.5 天）

### C.1 背景与执行纪律

1. **裁定依据**：
   - 依据 R-M7-2「另列 0.5 天五处目检」及技术债表（`AGENTS.md:50`）「+ 0.5 天五处目检」。
   - M3 第一批清扫已在 Task 3.2 落地（涉及 `native-dialog-copy.ts`、`update-lifecycle.ts`、`recovery-copy.ts`、`tray-locale.ts`、`compatibility-chrome/main.tsx`、`notifications.ts`、`setup-wizard-copy.ts` 等 7 个模块），三包同形与编译单测已全绿。
   - 评估 M3 行明确指出，清扫后的五处关键运行时交互必须由人类在桌面宿主环境下进行真机目检：**更新对话框 / 恢复对话框 / 托盘菜单 / 兼容模式标题栏 / 系统通知**。
2. **性质与诚信纪律**：
   - **本项为纯人类核对任务，不可由自动化测试或 subagent 代替**。
   - **严格禁止声称未执行的目检已通过**：未做 UI 驱动的不声称 UI 驱动。自动化单元测试断言通过（例如 `updates.spec.ts`、`notifications.spec.ts`、`startup-recovery-window.spec.ts`）属于代码逻辑覆盖，**绝不得用单测输出替代真机目检**。
   - **阻塞状态诚实登记**：
     - 若依赖的服务环境未就绪（如 C1/C3 依赖的 loopback update-server），一律记为「**阻塞，待环境**」，**不得标通过**。
     - 若依赖系统级特权或用户授权（如 C5 依赖的 macOS 系统通知权限），若环境未授权则记为「**阻塞，待权限**」，**不得标通过**。
     - 若触发路径属于极端异常/未就绪分支（如 C4 兼容模式的 `!state` 降级态），正常启动不易命中，一律如实记录为「**需构造降级态，本轮未触发**」，**不得标通过**。
   - **Beta 侧核对界定**：本里程碑核心义务是 huaanwork 构建的第一批清扫与目检确认。Beta 构建的目检列为对照参考（其中 C3 托盘与 C5 通知已由 R-M7-10(a) 裁定确认在接受范围内）。若本轮仅核验 huaanwork，Beta 侧登记为待对照核对。
   - **交付物性质**：本 Task 交付的是严谨可执行的**目检操作指南**与**待签字核对表**。实际人类目检将在组织指派人员并在环境具备时执行签字。

---

### C.2 五处目检汇总表

| 编号 | 目检项 | 源模块 | 触发路径 | 期望（huaanwork 构建） | 期望（beta 构建） | 实际结果 | 截图与证据文件 | 核对人 / 签字 |
| C1 | 更新对话框 | `native-dialog-copy.ts`（20 处）、`update-lifecycle.ts`（4 处） | update-server 下发更高版本 → 触发检查 → 弹出「有可用更新」；再进入「已下载」与「可安装/已安装」状态 | 弹窗标题与正文产品名显示为 **HuaAnWork**；按钮显示为 `Restart HuaAnWork`（中文：`重启 HuaAnWork`）；严禁出现 `DSH Desktop` | 产品名显示为 **DSH Desktop Beta**（已裁定接受的行为变更，如 `Restart DSH Desktop Beta` / `DSH Desktop Beta 有可用更新`） | 阻塞，待环境（需搭建 loopback update-server 下发更高版本；不得用单测替代；不得标通过） | `logs/task-3.4-C1-update-available.png`<br>`logs/task-3.4-C1-ready-to-install.png` | 待人类核对 / 待签字 |
| C2 | 恢复对话框 | `recovery-copy.ts`（25 处） | 启动进入恢复助手 → 触发出厂重置确认或 Profile 切换生效路径 | 对话框标题、说明正文及按钮产品名均为 **HuaAnWork**（例如：`恢复 HuaAnWork 出厂设置？`、`请重启 HuaAnWork 以使用该 Profile。`）；严禁出现 `DSH Desktop` | 对话框产品名均为 **DSH Desktop Beta**（例如：`恢复 DSH Desktop Beta 出厂设置？`、`请重启 DSH Desktop Beta 以使用该 Profile。`） | 待人类目检（当前客户端构建已具备触发路径，待人类核对操作；不得标通过） | `logs/task-3.4-C2-factory-reset.png`<br>`logs/task-3.4-C2-profile-restore.png` | 待人类核对 / 待签字 |
| C3 | 托盘菜单 | `tray-locale.ts`（14 处） | update-server 推送更高版本更新，在「有可用更新」与「正在下载更新」两态下查看系统托盘（Tray）菜单标签 | 托盘标签显示为 `HuaAnWork <version> 可用`（英文：`HuaAnWork <version> Available`）与 `正在下载 HuaAnWork <version>…`（英文：`Downloading HuaAnWork <version>…`）；严禁出现 `DSH Desktop` | 托盘标签显示为 `DSH Desktop Beta <version> 可用` / `Downloading DSH Desktop Beta <version>…`（R-M7-10(a) 已确认在接受范围内） | 阻塞，待环境（需 loopback update-server 支持更新下载流程；不得用单测替代；不得标通过） | `logs/task-3.4-C3-tray-available.png`<br>`logs/task-3.4-C3-tray-downloading.png` | 待人类核对 / 待签字 |
| C4 | 兼容模式标题栏 | `native-ui/compatibility-chrome/main.tsx`（1 处，JSX 文本） | 切换到兼容模式（Compatibility Mode），在 bridge 初始化阶段或延迟 bridge state 返回，观察降级态（`!state`）的标题栏渲染 | 标题栏文本显示为 **HuaAnWork**；严禁出现字面 `$`（严防 `${DESKTOP_PRODUCT_NAME}` 模板字面量误用导致渲染为 `$HuaAnWork`）；CSS 类 `dshDesktopFrameTitlebar` 样式正常生效（标题栏无塌陷） | 标题栏文本显示为 **DSH Desktop Beta**；无字面 `$`；样式正常生效无塌陷 | 需构造降级态，本轮未触发（`!state` 为 bridge 未就绪分支，正常运行极难截获，需桩代码注入；不得标通过） | `logs/task-3.4-C4-chrome-degraded.png` | 待人类核对 / 待签字 |
| C5 | 系统通知 | `notifications.ts`（4 处） | 构造触发一次后台任务失败（Job Failure）以及一次用户发起的回合失败（User Turn Failure，如超时或中断） | 系统通知正文包含：`一个由你发起的回合未能完成，请打开 HuaAnWork 查看详情。`（英文：`A user-initiated turn could not finish. Open HuaAnWork for details.`）；后台任务失败同理；严禁出现 `DSH Desktop` | 系统通知正文包含：`...请打开 DSH Desktop Beta 查看详情。` / `Open DSH Desktop Beta for details.`（R-M7-10(a) 已确认在接受范围内） | 阻塞，待权限（依赖宿主操作系统授予通知权限与真机回调；不得标通过） | `logs/task-3.4-C5-turn-failed.png`<br>`logs/task-3.4-C5-job-failed.png` | 待人类核对 / 待签字 |

---

### C.3 详细目检操作规程（逐项指南）

#### C1. 更新对话框（Update Dialogs）
- **源文件位置**：`src/native-dialog-copy.ts`、`src/update-lifecycle.ts`
- **前置依赖**：
  - 需要一个可下发高于当前客户端版本的 update-server（可沿用 M6 Task 7.3 的本地 loopback 服务，如发布 0.1.1 版本，并在客户端指定更新源）。
  - 若无 loopback update-server 环境，记录为「**阻塞，待环境**」，**不得标通过**。
- **操作步骤**：
  1. 启动 huaanwork 桌面客户端；
  2. 触发更新检查（通过托盘菜单「检查更新…」或等待后台定时轮询）；
  3. 服务端返回更高版本，观察弹出的「有可用更新」对话框；
  4. 点击「下载」，等待下载完成，观察弹出的「更新已下载 / 可安装」对话框。
- **目检期望（huaanwork 构建）**：
  - 对话框标题与正文中的所有产品名均必须为 **HuaAnWork**（中文态下为 `HuaAnWork 有可用更新`、`HuaAnWork <version> 已可用`、`HuaAnWork 更新已下载`、`HuaAnWork <version> 已可安装`）；
  - Windows 安装/重启按钮文案中包含 `Restart HuaAnWork`（中文：`重启 HuaAnWork`）；
  - macOS 挂载安装提示文案中包含 `请替换“应用程序”中的 HuaAnWork，然后重新打开`；
  - 严禁出现遗留的 `DSH Desktop`。
- **目检期望（Beta 构建）**：
  - 产品名呈现为 **DSH Desktop Beta**。
- **异常回报判据**：
  - 出现 `DSH Desktop` 或 `DSH` 遗留产品名；
  - 出现双重渠道名称（如 `DSH Desktop Beta Beta`）；
  - 按钮文案缺失产品名或截断。
- **证据截图规范**：
  - 有可用更新弹窗：`logs/task-3.4-C1-update-available.png`
  - 更新已下载/准备安装弹窗：`logs/task-3.4-C1-ready-to-install.png`

#### C2. 恢复对话框（Recovery Dialogs）
- **源文件位置**：`src/recovery-copy.ts`
- **前置依赖**：运行中的桌面客户端实例。
- **操作步骤**：
  1. 打开应用，通过托盘菜单或设置进入「恢复模式 / 恢复助手」（Recovery Window）；
  2. 导航至「重置与数据管理」面板，点击「恢复出厂设置」按钮；
  3. 观察弹出的确认重置对话框；
  4. 导航至 Profile 管理，切换到另一个可用 Profile 并确认切换；
  5. 观察提示重启的通知或弹窗文案。
- **目检期望（huaanwork 构建）**：
  - 恢复出厂设置确认框标题为 `恢复 HuaAnWork 出厂设置？`（英文：`Restore HuaAnWork to Factory Defaults?`）；
  - 对话框正文说明包含 `...从 HuaAnWork 中移除...随后 HuaAnWork 会重启并创建干净的默认 Profile`；
  - 切换 Profile 成功后提示包含 `已设为当前 Profile。请重启 HuaAnWork 以使用该 Profile。`（英文：`Set as active profile. Restart HuaAnWork to use this profile.`）；
  - 恢复配置成功提示包含 `...重启后，HuaAnWork 将使用回滚后的配置。`；
  - 严禁出现 `DSH Desktop`。
- **目检期望（Beta 构建）**：
  - 标题与正文中产品名呈现为 **DSH Desktop Beta**。
- **异常回报判据**：
  - 出现遗留的 `DSH Desktop`；
  - 变量未正确插值导致出现 `${...}` 或空字符串。
- **证据截图规范**：
  - 恢复出厂设置确认框：`logs/task-3.4-C2-factory-reset.png`
  - Profile 切换/恢复提示：`logs/task-3.4-C2-profile-restore.png`

#### C3. 托盘菜单（Tray Menu）
- **源文件位置**：`src/tray-locale.ts`
- **前置依赖**：
  - 需要配合 loopback update-server 模拟版本检查与下载过程；
  - 若无 update-server 环境，记录为「**阻塞，待环境**」，**不得标通过**。
- **操作步骤**：
  1. 启动桌面客户端并观察系统状态栏/托盘图标；
  2. 当 update-server 通知有新版本时，点击托盘图标查看菜单；
  3. 点击开始下载更新，在下载传输期间立即查看托盘图标菜单。
- **目检期望（huaanwork 构建）**：
  - 有可用更新时，托盘菜单项标签精确显示为 `HuaAnWork <version> 可用`（英文：`HuaAnWork <version> Available`）；
  - 下载更新过程中，托盘菜单项标签精确显示为 `正在下载 HuaAnWork <version>…`（英文：`Downloading HuaAnWork <version>…`）；
  - 严禁出现遗留的 `DSH Desktop 2.1.0 Available` 或 `Downloading DSH Desktop...`。
- **目检期望（Beta 构建）**：
  - 显示为 `DSH Desktop Beta <version> 可用` / `Downloading DSH Desktop Beta <version>…`（R-M7-10(a) 已确认在接受范围内）。
- **异常回报判据**：
  - 标签依然显示 `DSH Desktop`；
  - 版本号与产品名拼接缺失空格或格式混乱；
  - 出现 `DSH Desktop Beta Beta`。
- **证据截图规范**：
  - 托盘可用更新状态菜单：`logs/task-3.4-C3-tray-available.png`
  - 托盘下载中状态菜单：`logs/task-3.4-C3-tray-downloading.png`

#### C4. 兼容模式标题栏（Compatibility Chrome Titlebar）
- **源文件位置**：`src/native-ui/compatibility-chrome/main.tsx`
- **前置依赖**：
  - 兼容模式运行环境；
  - 需模拟降级态（即 `main.tsx` 中的 `if (!state) return <header className="dshDesktopFrameTitlebar">{DESKTOP_PRODUCT_NAME} ...</header>` 分支）。
  - **诚实说明**：在正常桌面运行环境下，IPC bridge 会迅速返回 `state`，此降级态瞬时消失或不可见。若未专门注入网络/IPC 阻断桩代码，记录为「**需构造降级态，本轮未触发**」，**不得标通过**。
- **操作步骤**：
  1. 配置客户端以兼容模式启动，或在初始化前人为延迟 `window.desktopChrome.invoke('state')` 的解析；
  2. 观察页面顶部标题栏（header）在等待 state 就绪期间的初始渲染。
- **目检期望（huaanwork 构建）**：
  - 标题栏文本显示为 **HuaAnWork**；
  - **特别检查**：严禁出现字面量 `$` 字符（例如 `$HuaAnWork` 或 `${DESKTOP_PRODUCT_NAME}`）。由于 JSX 文本节点与 ES6 模板字符串语法差异，JSX 文本位如果误加 `$` 将直接渲染为可见字符，此处必须核实无 `$` 泄漏；
  - CSS 类 `dshDesktopFrameTitlebar` 样式正常加载，标题栏高度、背景与内边距正常，无布局塌陷或未渲染样式闪烁。
- **目检期望（Beta 构建）**：
  - 标题栏显示为 **DSH Desktop Beta**，无 `$` 符号，样式正常。
- **异常回报判据**：
  - 出现字面 `$` 符号（如 `$HuaAnWork`）；
  - 标题栏高度为 0 或样式未加载（塌陷）；
  - 出现旧名称 `DSH Desktop`。
- **证据截图规范**：
  - 兼容模式降级标题栏：`logs/task-3.4-C4-chrome-degraded.png`

#### C5. 系统通知（System Notifications）
- **源文件位置**：`src/notifications.ts`
- **前置依赖**：
  - 宿主操作系统系统通知权限已开启（macOS 通知中心 / Windows 通知中心已授权该应用发通知）。
  - 若操作系统通知权限未开启或被用户禁用，记录为「**阻塞，待权限**」，**不得标通过**。
- **操作步骤**：
  1. 在桌面客户端中触发一个后台长任务并促使其失败（例如无效的后台指令或依赖报错）；
  2. 在会话窗口中发起一个用户回合（Turn），人为触发回合异常中断或错误退出（如终止关联子进程或网络断开导致回合失败）；
  3. 观察宿主操作系统弹出的通知横幅及通知中心历史。
- **目检期望（huaanwork 构建）**：
  - 用户回合失败通知：正文为 `一个由你发起的回合未能完成，请打开 HuaAnWork 查看详情。`（英文系统：`A user-initiated turn could not finish. Open HuaAnWork for details.`）；
  - 后台任务失败通知：正文为 `一个后台任务未能完成，请打开 HuaAnWork 查看详情。`（英文系统：`A background job could not finish. Open HuaAnWork for details.`）；
  - 严禁出现 `Open DSH Desktop for details.`。
- **目检期望（Beta 构建）**：
  - 正文为 `...请打开 DSH Desktop Beta 查看详情。`（英文：`...Open DSH Desktop Beta for details.`）（R-M7-10(a) 已确认在接受范围内）。
- **异常回报判据**：
  - 提示信息仍包含 `DSH Desktop`；
  - 出现双重 Beta（`DSH Desktop Beta Beta`）；
  - 文案格式破坏或乱码。
- **证据截图规范**：
  - 回合失败系统通知：`logs/task-3.4-C5-turn-failed.png`
  - 后台任务失败通知：`logs/task-3.4-C5-job-failed.png`

---

### C.4 核对结论与签字归档

- **当前核对结论**：
  - 本次交付已完成目检标准定义、触发规程细化与待核对表格编制。
  - **因环境前置卡点（loopback update-server 未部署、macOS 系统通知权限需真机交互授权、C4 降级态需桩代码构造），本 Task 遵守工程诚信纪律，不声称任何目检项已通过**。
  - 状态标记：
    - C1：**阻塞，待环境**（需 loopback update-server）
    - C2：**待人类目检**（客户端已就绪，待人类操作触发并核对）
    - C3：**阻塞，待环境**（需 loopback update-server）
    - C4：**需构造降级态，本轮未触发**（需构造 `!state` 降级条件）
    - C5：**阻塞，待权限**（需真机操作系统通知权限）
- **核对执行人 / 审核人签字区**：
  - 自动化/文档编制：Subagent（Task 3.4 交付）
  - 人类目检核对人：____________________（待签署）
  - 日期：____________________
