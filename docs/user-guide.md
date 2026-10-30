# HuaAnWork 用户指南

## 安装与首次启动

从组织提供的 HuaAnWork 分发渠道获取 macOS 或 Windows 安装包。安装包已包含运行所需的 Electron、Node.js 和固定版本的 DSH 依赖，普通用户不需要另行安装 Node.js 或 pnpm。

首次启动时，应用会准备默认 profile，并在本机启动 DSH Web surface；若组织要求登录，请使用组织提供的账户。关闭窗口通常只会隐藏窗口；可以从托盘重新打开，选择 **退出** 才会结束应用和 Host 进程。

## 用文件夹启动

除了在界面里选择目录，还可以在启动时直接指定一个文件夹。该文件夹会被注册为工作区并自动打开；如果它已经是工作区，则直接打开，不会重复创建。

- **Windows 拖放**：把文件夹拖到桌面快捷方式或开始菜单里的 **HuaAnWork** 图标上。应用没运行时会先启动，已经在运行时会抬到前台并打开这个工作区。
- **命令行**：运行 `huaanwork <文件夹>`。相对路径按当前目录解析。安装后的可执行文件也接受一个绝对文件夹路径作为参数。

路径不存在、指向的是文件，或者位于 Windows 上不受支持的存储（例如 exFAT、FAT32、网络盘）时，应用会弹出原生提示并且不注册该工作区。用文件夹启动是一次性的：之后由设置触发的重启不会再次打开它。

已知限制：Windows 任务栏上固定的图标暂不接受拖放；HuaAnWork 只发行 macOS 与 Windows 版本。

## Profile

Profile 是一组 DSH bundle、依赖和 patch 的组合。首次启动会自动创建 `desktop` profile；托盘中的 **Profile** 菜单会列出已存在的 profile，并提供 **新建 Profile…**。

选择 profile 后应用会有序重启。如果新 profile 无法启动，可以从恢复助手切换回可用的 profile 或修复配置。内置 profile 默认共用同一个 DSH home，所以 sessions、settings 和 storage 通常不需要迁移。自定义配置（patch）如果主动改写持久化路径，则以该 profile 自己的设置为准。

切换 profile 不会把旧 profile 的插件复制到新 profile。要管理目标 profile，请在终端中显式写出 profile，或者在切换后使用终端里的默认命令。

## 窗口模式与材质

- **兼容模式**：保留所选 profile 的官方布局，并在其上方提供独立的桌面控制条；兼容性最好。
- **扩展模式**：在官方内容区外提供独立的标题栏和侧栏，可选择玻璃材质。
- **增强模式**：使用调整过的侧栏、内容面板和窗口控件的桌面布局。

macOS 的自定义窗口模式可以选择是否使用玻璃背景。Windows 不提供材质选项，始终使用不透明窗口；旧版 Windows 亚克力和 Mica 偏好都会安全地按关闭处理，其中亚克力还会在设置文件可写时自动迁移。切换模式或材质都会重启应用，不会在正在运行的 renderer 中热替换界面或窗口材质。

## 本地 Web 端口

应用默认从 `43120` 开始为本地 Web 服务选择端口，这个服务只监听 `127.0.0.1`。如果该端口已被占用，应用会在其后的最多 32 个端口内继续尝试；也可以在桌面设置中指定端口，`0` 表示由系统随机分配。修改端口后应用会有序重启。

端口变化会改变页面 origin；依赖浏览器 `localStorage` 的界面插件按 origin 隔离数据，如果需要在重启后继续读取设置，请为它们保留一个固定端口。

如需用普通浏览器打开当前 profile，请在桌面设置中开启浏览器访问；该能力只在兼容模式下可用。选择“局域网”范围后，应用会为同一局域网中的其他设备提供 HTTPS 访问入口，但这些设备需要先安装并信任本机提供的证书；应用会在开启前显示风险确认。

## 插件管理

插件是给 DSH 添加能力的扩展包，例如模型、工具、界面和工作流。HuaAnWork 使用官方 Harness 的插件体系，官方插件可以直接安装使用；多个插件遵循统一的约定，可以一起安装、一起工作。

普通 DSH 插件仍使用官方 CLI 语义：

```sh
dsh plugin --profile desktop add <plugin>
dsh plugin --profile desktop remove <plugin>
dsh plugin --profile desktop update
```

在 HuaAnWork 托盘打开的终端中，裸 `dsh` 和不带 `--profile` 的 plugin 命令默认使用当前激活 profile：

```sh
dsh plugin add <plugin>
dsh plugin remove <plugin>
dsh plugin update
```

显式 `--profile <name>` 始终优先。插件变更后需要重启 HuaAnWork，才能让新的 bundle 进入 Loader 组合。

## 打开终端

可以从托盘、桌面设置或窗口控制条选择 **打开 DSH 终端**；设置中的旁边提供重启下拉菜单，可以普通重启或 **重启到恢复模式**，两种操作都必须确认。macOS 会打开 Terminal，Windows 会优先使用 Windows Terminal，找不到时回退到 PowerShell 或命令提示符。

欢迎信息会显示：应用版本、当前 profile、profile 目录和 DSH home。HuaAnWork 会在自己的 user-data 目录生成 `dsh`、`pnpm` 和 `node` 私有 shim，只对这个终端进程设置 PATH，不会修改系统 PATH 或用户 shell 配置。

## 更新

HuaAnWork 只有一个分发通道。打包后的 macOS/Windows 应用会在后台检查部署配置的更新服务；未覆盖时默认使用内网地址 `http://update.intranet.lan:8790`，检查路径为 `/api/desktop/version`。后台检查不阻塞启动；网络错误、非 200、非法版本或服务端版本不新时保持静默。发现新版本时，应用会更新托盘，并且每个版本只发送一次非阻塞系统通知，不会自动弹出下载确认；点击通知会显示应用。

托盘中的 **检查更新…** 是对该分发通道的手动检查。即使已经是当前版本，也会显示结果；检查失败会提示稍后重试。发现新版本时会先询问是否下载。

确认下载后，应用会先打开原生的“保存更新安装包”对话框，默认建议保存到 Downloads；你可以改用其他目录和文件名，取消对话框则不会开始下载。保存后应用才会向更新服务请求当前平台的安装包，并记录安装包位置。macOS 会打开 DMG，由用户把应用替换到 Applications；Windows 会准备 NSIS 安装器，再询问是否重启并运行安装程序。升级完成并重新启动后，应用会询问是否删除安装包以释放磁盘空间，也可以选择保留。下载和安装失败不会破坏当前版本，托盘仍可重试。

## 排查

HuaAnWork 的确认、警告与操作结果会打开独立的桌面级模态窗口，而不是侵入官方页面的 overlay。恢复助手会先展示进入原因，再提供快速恢复、插件管理、回滚、切换 Profile、重置与数据管理、诊断等入口。

- **应用能够进入托盘**：右键托盘图标，选择 **导出诊断信息…**。确认隐私提示后，应用会生成 `diagnostics-*.zip` 并在文件管理器中显示它。
- **应用持续闪退，无法进入托盘**：在 PowerShell 中直接运行安装后的程序并加上恢复参数。下面是安装向导默认位置下的命令；如果安装时修改过目录，请替换为实际的 EXE 路径。

  ```powershell
  & "$env:LOCALAPPDATA\Programs\HuaAnWork\HuaAnWork.exe" --export-diagnostics
  ```

  通过 npm 安装时，运行 `huaanwork --export-diagnostics`。这个命令不会启动 Host、profile、插件或窗口；完成后会在终端输出诊断 ZIP 的绝对路径。
- **诊断包内容**：包含最近的应用日志、本地 Crashpad `.dmp`、当前运行标记和 `system-info.txt`。系统信息会记录 HuaAnWork、Electron、Node、平台和架构版本。日志会对可识别的认证凭据脱敏，但本地路径、工作区 ID、会话 ID 和崩溃时的内存片段仍可能存在。分享前必须检查；不适合公开的 dump 应通过可信渠道提供。
- **窗口消失了**：先检查系统托盘，关闭窗口不是退出。
- **插件没有出现**：确认命令作用于目标 profile，并重启应用。
- **终端命令找不到**：从托盘重新打开 HuaAnWork 终端；系统 shell 的全局 PATH 不会被 HuaAnWork 修改。
- **更新没有提示**：后台错误会静默；使用托盘手动检查查看结果。

更底层的生命周期、打包和平台限制属于开发者文档，见[文档索引](README.md)。
