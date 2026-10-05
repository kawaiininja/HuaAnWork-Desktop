# M7 运维工单与人类核对清单（Ops & Human Verification Checklist）

> **文档状态与执行顺序登记（2026-10-06）**：
> 本文档是 M7 稳定化与上游同步准备阶段的运维工单、人类核对与延后项归属清单。
> **执行顺序**：因计划调度，Task 3.4 先于 Task 7.3 执行。由 Task 3.4 率先创建本文档骨架并完整交付**「附录 C：M3 品牌清扫五处目检（R-M7-2，0.5 天）」**。
> 本文档的前置主体章节（第 1 节 M2 运维工单 Checklist、第 2 节 M4 人类核对批次化指南与 L2 常驻发版门、第 3 节 M16 IT 端点策略核对、第 4 节 本轮不做 / 延后项归属与触发条件）将在后继的 Task 7.3 中补充完整。

---

## 1. M2 运维工单 Checklist（待 Task 7.3 补充）

*(本节待 Task 7.3 编排：包含内网部署机、ssh/scp 通道、物理离线签名机、第二信道公钥指纹人工比对、发行分支策略、双侧 NTP 等 6 条运维工单卡点及工程侧 0.5 人日配置说明)*

---

## 2. M4 人类核对批次化指南与常驻发版门（待 Task 7.3 补充）

*(本节待 Task 7.3 编排：包含基于五个环境 sha 复核的 as-of 批次化指南、A19 篡改项/A18/A2 顺序约束、以及 L2 与客户端耦合点的 5 条常驻发版门)*

---

## 3. M16 IT 端点策略核对 Checklist（待 Task 7.3 补充）

*(本节待 Task 7.3 编排：包含端点策略查询 5 项问题、组织审批流程及 R-6 风险接受重裁记录)*

---

## 4. 本轮不做 / 延后项的归属与触发条件（待 Task 7.3 补充）

*(本节待 Task 7.3 编排：包含 M18/M19/M20/M22/M23/M24/M25/M26/M27/M28/M29/L3/E1①/E2⑤/E2⑦ 等延后项的状态、归属与触发条件登记)*

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
