# 2026-10 M9 补丁映射与移植记录 — dsh-client-ui-settings-account

> **工件性质**：Task 9 交付物（补丁移植与架构对账证据）  
> **目标包**：`@deepseek-ai/dsh-client-ui-settings-account@0.2.1-rc.1`  
> **补丁产物**：`patches/dsh-client-ui-settings-account@0.2.1-rc.1.patch`  
> **旧基线补丁**：`patches/dsh-client-ui-settings-account@0.2.1-alpha.1.patch`

---

## 1. 目标与口径

- **工作区**：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop-sync-m9`
- **上游 Submodule Pin**：`1600d8a1e14`（`dsh-v0.2.1-rc.1`）
- **Vendor Tarball**：`vendor/dsh-runtime/0.2.1-rc.1/deepseek-ai-dsh-client-ui-settings-account-0.2.1-rc.1.tgz`
- **补丁文件**：`patches/dsh-client-ui-settings-account@0.2.1-rc.1.patch`
- **补丁目标文件**：
  1. `lib/client.js`（Webpack/Rollup 客户端 bundle，6 个 hunk）
  2. `lib/types/client/index.d.ts`（SlotMap 扩展类型声明，1 个 hunk）
- **合计 Hunk 数**：7 个 hunk（`lib/client.js` 6 个，类型声明 1 个）

---

## 2. 补丁意图与架构作用

在桌面端（及 HuaAnWork 定制安装引导）中，账户与凭据设置包承载着关键的入职流（Onboarding）扩展与离线/内网凭据检查：
1. **桌面扩展引导插槽 (`onboarding.desktop.before`)**：
   - 允许桌面应用（如 HuaAnWork 首次启动向导或设置页）在官方 Onboarding 步进前插入企业自定义向导或认证页面。
   - 提取并暴露通用组件：
     - `DesktopOnboardingNavigation`：具备 `flow` 布局适配的通用前进/后退/跳过导航栏。
     - `DesktopOnboardingContinuationPage`：管理 `globalThis.dshOnboarding.setActive(true/false)` 原生窗口状态的扩展页容器。
     - 透传控制句柄：`openLogin`（调起官方桌面登录弹窗）、`renderNext`（步入官方后续流程）、`renderLoading`、`accountStatus` 等。
2. **`readOnboardingApiKeyPresence` 无 Bridge 降级支持**：
   - 上游原生逻辑仅调用 `globalThis.dshOnboarding?.hasApiKey()`，若在无 Electron Bridge 的测试环境、内网特定通道或 `globalThis.dshDesktopSetup` 模式下运行，会直接抛错导致引导挂起。
   - 补丁引入自愈降级：当缺失 Bridge 时，若检测到 `globalThis.dshDesktopSetup`，直接通过 `ctx.remote.settings.describe()` 与 `ctx.remote.llm.listConfigurableProviders()` 枚举官方（`llm-deepseek`）及第三方配置提供方，分批调用 `ctx.remote.credentials.describe()` 查询凭据元数据，判断是否存在已配置的 API Key。
3. **`openDesktopLogin` 动作注入**：
   - 在 `shell.overlay` 注册的 `desktop-onboarding` 槽中，暴露 `openDesktopLogin: () => operations.showLogin(true)`，使用户在扩展步骤中可一键激活原生账号登录对话框。

---

## 3. 0.2.1-alpha.1 到 0.2.1-rc.1 的上游结构性漂移分析

在上游从 `0.2.1-alpha.1` 演进至 `0.2.1-rc.1`（涉及 55 个文件重构、引入 Web 账号登录 `8ee22c3668` 及凭据刷新失效机制 `credentials/reference-updated`）过程中，代码结构发生了如下显著变化：

1. **`DesktopOnboardingEntry` 组件签名扩展**：
   - alpha.1 签名：`function DesktopOnboardingEntry({ useOnboarding, useAccount, ...props })`
   - rc.1 签名：`function DesktopOnboardingEntry({ useOnboarding, useAccount, setVisible, ...props })`。上游新增了 `setVisible` 显式受控回调以及内部状态同步逻辑。
2. **全包锚点行号深度漂移**：
   - `OnboardingSurface` 从 ~3338 漂移至 ~3480（+142 行）。
   - 导航底栏提取点从 ~4035 漂移至 ~4177（+142 行）。
   - `DesktopOnboardingEntry` 从 ~4099 漂移至 ~4241（+142 行）。
   - `readOnboardingApiKeyPresence` 从 ~4156 漂移至 ~4302（+146 行）。
   - `apply(ctx)` 控制器实例化点从 ~4432 漂移至 ~4698（+266 行）。
3. **控制器运行环境判定统一 (`"dshDesktop" in globalThis` → `desktop`)**：
   - rc.1 统一使用顶层解析出的布尔值 `desktop`（支持桌面多环境检测），替代了原本粗粒度的 `"dshDesktop" in globalThis` 检测。

---

## 4. 逐 Hunk 移植与对账映射表

| # | 目标文件 | 锚点位置 (rc.1) | alpha.1 原形态 | rc.1 处置方案与对账 |
|---|---|---|---|---|
| 1 | `lib/client.js` | L3480: `OnboardingSurface` | 注入 `"data-desktop-onboarding-surface": ""` | **原样移植**。测试与样式选择器标记。 |
| 2 | `lib/client.js` | L4177: `step !== "welcome"` 底部 | 替换为 `<DesktopOnboardingNavigation ... />` | **原样移植**。提取出可重用底栏组件。 |
| 3 | `lib/client.js` | L4229: `DesktopOnboardingEntry` | 抽取组件并注入 `onboarding.desktop.before` 槽位代理 | **关键重做适配**。将原函数重命名为 `OfficialDesktopOnboardingEntry({ useOnboarding, useAccount, setVisible, ...props })`，显式保留 rc.1 新增的 `setVisible` 属性并全量透传给官方实现；包装层通过 `props.renderSlot("onboarding.desktop.before", ...)` 拦截并提供 fallback。 |
| 4 | `lib/client.js` | L4329: `readOnboardingApiKeyPresence` | 支持 `(ctx)` 参数与 `dshDesktopSetup` 凭据探测 | **原样移植**。兼容 Bridge 与内网无 Bridge 凭据查询路径。 |
| 5 | `lib/client.js` | L4753: `apply(ctx)` 控制器构造 | 传入 `() => readOnboardingApiKeyPresence(ctx)` 闭包 | **适配新变量**。判定条件遵循 rc.1 的 `if (desktop)`，以零参箭头函数向 `DesktopOnboardingController` 注入带有 `ctx` 闭包的探测函数。 |
| 6 | `lib/client.js` | L4773: `shell.overlay` 注册 | 注册 `children: { "onboarding.desktop.before": { kind: "single", scope: "root" } }` + 注入 `openDesktopLogin` | **原样移植**。声明插槽与操作句柄。 |
| 7 | `lib/types/client/index.d.ts` | L174: 尾部追加 | `SlotMap` 声明 `onboarding.desktop.before` 结构 | **原样移植**。声明 owner 的 6 个控制与渲染方法。 |

---

## 5. 关键重做技术点与调用闭包设计

### 5.1 控制器零参注入与上下文闭包
在 `DesktopOnboardingController` 内部，其构造器第四入参要求类型为 `() => Promise<boolean>`（无参异步函数）：
```typescript
// 构造器签名示意
constructor(
  onboardingForm: ConfigForm,
  chatForm: ConfigForm,
  setDevTools: (enabled: boolean) => void,
  accountHooks: AccountHooks,
  readApiKeyPresence: () => Promise<boolean>,
  initialForms: ConfigFormsSnapshot
)
```
由于 `readOnboardingApiKeyPresence(ctx)` 需要引用 `ctx.remote` 来与配置及凭据后端通信，不能直接以裸函数传入。必须在 `apply(ctx)` 阶段：
```javascript
const controller = new DesktopOnboardingController(
  ctx.configForms.get(DESKTOP_ONBOARDING_NAMESPACE),
  ctx.configForms.get("ui-chat"),
  (enabled) => ctx.configForms.developerTools.setEnabled(enabled),
  operations.hooks.account,
  () => readOnboardingApiKeyPresence(ctx),
  ctx.configForms.describe()
);
```
通过 `() => readOnboardingApiKeyPresence(ctx)` 闭包封装着当前的 `ctx` 实例，既满足了控制器的零参调用约定，又确保凭据查询时拥有完整的 Cordis client 远程访问通道。

### 5.2 官方入口属性全量透明代理
rc.1 中官方 `DesktopOnboardingEntry` 增加了 `setVisible` 属性（用于桌面窗口在向导结束时的可见性动画控制）。补丁构造的代理层：
```javascript
function DesktopOnboardingEntry(props) {
  const account = props.useAccount((value) => value);
  const renderNext = () => (0, react_jsx_runtime.jsx)(OfficialDesktopOnboardingEntry, props);
  ...
}
```
将包括 `setVisible`、`useOnboarding`、`useAccount` 等在内的全部 `props` 完整原样传递给 `OfficialDesktopOnboardingEntry`，避免了由于组件抽象层遗漏上游新属性而引发的功能退化。

### 5.3 自验结论
在 `/tmp/m9p-dsh-client-ui-settings-account` 下执行干净解包与 dry-run 验证：
```bash
patch -p1 -d t/package --dry-run < patches/dsh-client-ui-settings-account@0.2.1-rc.1.patch
```
输出：
```
checking file lib/client.js
checking file lib/types/client/index.d.ts
```
所有 2 个目标文件、7 个 hunk 全部 0 偏移、0 fuzz 干净匹配应用。
