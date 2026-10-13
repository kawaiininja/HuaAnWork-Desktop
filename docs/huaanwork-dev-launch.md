# 如何启动 HuaAnWork 桌面应用(开发环境)

本文是运维向启动手册:在开发机上把 HuaAnWork(`dsh-plugin-huaanwork` 变体)跑起来、确认它真的健康、以及识别启动日志里的已知现象。内部启动架构(profile 组装、host/renderer 引导)不在本文范围。

## 前置条件

- Node.js `^22.19.0` 或 `>=24.0.0`,经 Corepack 使用根 Yarn `4.18.0`。
- 已执行 `git submodule update --init --recursive` 与 `corepack yarn install --immutable`。
- 图形启动必须显式发起:构建、typecheck、单测都是 headless-safe 的,只有本节命令会弹出真实窗口(仓库规则:「Keep graphical application launch explicit」)。

## 启动路径(三选一)

### 路径 A:快速启动(日常开发首选)

`lib/` 已是最新(刚构建过、源码未变)时,跳过构建直接起:

```bash
corepack yarn workspace dsh-plugin-huaanwork start
```

等价于 `node lib/bin.js`。源码有改动时不要用这条,它会跑旧构建。

### 路径 B:构建后启动(源码有改动)

```bash
corepack yarn workspace dsh-plugin-huaanwork dev
```

该命令依次执行:

1. `build`:生成 mac/tray/Windows 图标 → `clean` → `tsdown`(主进程与 host 侧)→ `vite build`(client 与 native-ui 两张图)→ `tsc --emitDeclarationOnly` ×2。
2. `prepare:electron-native`:为当前 Electron 重编 `fs-ext` 原生模块(实测产物形如 `fs-ext 2.1.1 for Electron 44.0.0 (darwin-arm64, ABI 149)`)。Electron 版本变化后必须跑,否则启动时原生模块 ABI 不匹配。
3. `node lib/bin.js` 启动 Electron。

### 路径 C:完整根流程(发版前对齐)

```bash
corepack yarn dev:huaanwork
```

在路径 B 之前额外执行 `market:prepare`(从 npm `latest` 刷新 `dshmarket`,**会写 lockfile 与 vendored 产物,需随提交**)、`aa:prepare-release`(构建官方 Agents Anywhere `main`,**会写 artifact/provenance/manifest,需随提交**)、`dsh-community-market build`。日常启动不需要它;这两步有网络依赖且有工作树副作用。

### 其他形态

- `corepack yarn workspace dsh-plugin-huaanwork start:isolated`:`DSH_DESKTOP_ISOLATED_HOST=1`,隔离 host 模式。
- `node lib/bin.js <folder>`:注册并以指定文件夹作为工作区启动。
- `node lib/bin.js --export-diagnostics`:不启动应用,导出日志与崩溃证据。
- Beta/Next 变体对应根命令 `dev:beta` / `dev:next`,本文不展开。

## 启动时会发生什么(可观测序列)

以 2026-10-13 macOS 实测为基准,日志按此顺序出现:

1. `outbound proxy = none (...)` —— 出站代理解析(系统代理解析器全 DIRECT 时为 none)。
2. `已从旧版华安工作台迁移:sessions 1、sessionsReminted 1。 跳过 N 项...需要重新登录一次...` —— 一次性旧数据迁移。**该消息每次启动都打印**,迁移本身幂等(跳过已存在项),「需要重新登录一次」对已完成迁移且 auth-session 有效的用户是误导文案(已知观察项 F-M4-4),实测直入主界面、无需登录。
3. `host outbound proxy policy installed` —— host 代理策略装载。
4. `post-boot gate: agent registry empty at first check; waiting for materialization` —— 正常的首检等待。
5. `warning: 2 entries did not activate` + 两条 pending —— **预期行为**,见下节。

## 已知现象(不要当 bug 报)

| 现象 | 说明 | 登记 |
| ------ | ------ | ------ |
| `web-fetch-http ... pending (waiting for service: web)` 与 `job-controller ... pending (waiting for service: jobs)` | M3 guardrail 锁定禁用 jobs/web/user-questions/hmr,这两个插件等不到对应服务,常驻 pending | 变体冒烟既有断言 |
| 迁移消息每次启动都打印且含「需要重新登录一次」 | 幂等重跑无害,文案误导 | F-M4-4 |
| macOS 26 上托盘图标不可见 | status item 已创建且菜单全功能,但逐像素零渲染;更新提示/Profile 切换/安全模式/退出都在托盘菜单里 | F-M4-1(A10 判不通过,待修) |
| 不可达 origin 下手动「Check for Updates…」偶发静默超时 | tray command 层超时,到不了检查器,无 UI 反馈 | F-M4-3 |

## 验证启动成功

进程起来了不等于界面健康。依次确认:

1. **进程**:`pgrep -f "node lib/bin.js"` 有值,且有若干 `node_modules/electron/dist/Electron` 子进程。
2. **启动生命周期**:`~/Library/Application Support/HuaAnWork/lifecycle-events/startup.jsonl` 最新一条 run 以 `startup.run.completed` 收尾且 `rendererStatus: "healthy"`。
3. **应用日志**:`~/Library/Application Support/HuaAnWork/logs/dsh-YYYY-MM-DD.log` 当天文件出现新的 `--- dsh-plugin-huaanwork HuaAnWork <版本> darwin ... run <id> ---` 头,后续只有上节列出的已知现象;`.error.log` 无新增堆栈。
4. **界面**:主窗口渲染出侧边栏(New Chat / Search / Automations / Customize)、Workspaces 列表与底部输入框。空窗口/白屏视为启动失败。

## 退出与异常判读

- **单实例锁**(`src/main.ts` `requestSingleInstanceLock`):应用已在运行时再次启动,新进程立即退出、无窗口——先 `pgrep -f "node lib/bin.js"` 确认是否已有实例。
- **干净退出**:`dev` 管道以 exit code 0 结束、日志无错误堆栈、无新增 CrashReporter 记录,即为正常退出(用户关窗/Cmd+Q),不是崩溃。
- **崩溃证据**:异常退出会在 `~/Library/Application Support/CrashReporter/` 落 `HuaAnWork_*.plist`,并可用 `node lib/bin.js --export-diagnostics` 打包导出。

## 排障

| 症状 | 处置 |
| ------ | ------ |
| 启动即报原生模块 ABI / `fs_ext` 相关错误 | 跑 `corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native` 后重试 |
| `start` 起的是旧代码 | 改用路径 B(`dev`),它先构建 |
| 第二次启动无窗口、立即返回 | 单实例锁,已有实例在跑;退出旧实例或直接用旧实例 |
| 窗口白屏/空白 | 查 `lifecycle-events/startup.jsonl` 是否卡在某一 stage,查 `.error.log`;渲染层状态非 healthy 即按启动失败处理 |
| 想同时跑多个数据目录的实例 | 用 checkpoint/隔离数据目录机制(`start:isolated` 或测试设施的 user-data-dir 参数),不要直接双开 |

## 相关文档

- 发版前完整流程:`docs/release-checklist.md`
- M4 真机核对(托盘、更新、迁移文案等已知项出处):`docs/huaanwork-m4-human-verification-2026-10-07.md`
- 仓库规则与变体约束:根 `CLAUDE.md` / `AGENTS.md`
