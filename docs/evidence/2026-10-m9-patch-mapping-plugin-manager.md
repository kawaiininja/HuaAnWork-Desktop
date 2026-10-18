# 2026-10 M9 补丁映射与移植记录 — dsh-client-ui-plugin-manager

> **工件性质**：Task 9 交付物（补丁移植与架构对账证据）<br>
> **目标包**：`@deepseek-ai/dsh-client-ui-plugin-manager@0.2.1-rc.1`<br>
> **补丁产物**：`patches/dsh-client-ui-plugin-manager@0.2.1-rc.1.patch`<br>
> **旧基线补丁**：`patches/dsh-client-ui-plugin-manager@0.2.1-alpha.1.patch`

---

## 1. 目标与口径

- **工作区**：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop-sync-m9`
- **上游 Submodule Pin**：`1600d8a1e14`（`dsh-v0.2.1-rc.1`）
- **Vendor Tarball**：`vendor/dsh-runtime/0.2.1-rc.1/deepseek-ai-dsh-client-ui-plugin-manager-0.2.1-rc.1.tgz`
- **补丁文件**：`patches/dsh-client-ui-plugin-manager@0.2.1-rc.1.patch`
- **补丁目标文件**：
  1. `lib/client.js`（Webpack/Rollup 客户端 bundle，16 个 hunk）
  2. `lib/types/client/PluginManagerPage.d.ts`（页面 Props 类型定义，1 个 hunk）
  3. `lib/types/client/config-ledger.d.ts`（ConfigLedger 状态接口，1 个 hunk）
  4. `lib/types/client/slot-contract.d.ts`（SlotMap 与复合渲染接口，3 个 hunk）
- **合计 Hunk 数**：21 个 hunk（`lib/client.js` 16 个，类型声明 5 个）

---

## 2. 补丁意图与架构作用

在桌面端（特别是 macOS 与定制化 HuaAnWork 变体）中，插件管理器页面需要深度整合宿主功能：
1. **5 个桌面专有 Slot 注入**：
   - `plugins.header.leading`：在 macOS 原生窗口标题栏/侧边栏提供常驻导航与返回控制（`PluginSidebarControl`），独立于可滚动的插件管理页面内容。
   - `plugins.overview`：在已安装面板顶部注入概览区域，允许宿主挂载专属控制组件（如内网市场快捷入口、系统插件状态概览等），并提供 `onOpenBundle` 与 `onOpenItem` 导航回调。
   - `plugins.bundle.hidden`：隐藏特定 Bundle，不展示在常规卡片列表中（转由概览或设置统一纳管），但保持包的深层详情页面可通过 deep-link 或 overview 正常打开。
   - `plugins.item.hidden`：隐藏特定 Item，不展示在基础扩展列表中。
   - `plugins.bundle.actions`：在每个插件 Bundle 卡片的启用开关前注入定制动作槽（如设置按钮、卸载按钮、来源标记等）。
2. **复合组件渲染能力 (`renderComponents`)**：
   - 将主页面原生拥有的组件行列表 (`RowsSection`) 渲染能力封装为 `renderComponents` 函数，穿透传递给 `plugins.item` 详情页，使复合型插件在自定义 ItemDetail 中能够直接复用原生的模块级启用/禁用行控件与状态反馈。
3. **隐藏集合纳入 ConfigLedger 响应式状态**：
   - 在 `ConfigLedger` 维护 `hiddenBundles` 与 `hiddenItems` 响应式集合，联动 Cordis slots 系统的 `keysOf("plugins.bundle.hidden")` 与 `keysOf("plugins.item.hidden")`，动态影响卡片列表过滤。

---

## 3. 0.2.1-alpha.1 到 0.2.1-rc.1 的上游结构性漂移分析

在上游从 `0.2.1-alpha.1` 演进至 `0.2.1-rc.1`（主要发生在 alpha.2 阶段 `60328899e5`/`b227127d62`/`3de3a977e0` 及布局重构 `ee558c82d7`）过程中，`PluginManagerPage.tsx` 发生了大幅重构：

1. **Installed / More 双 Tab 结构确立**：
   - alpha.1 原本为单页面流式列表：`showsCards` 条件下同时平铺官方插件与已安装插件。
   - rc.1 拆分为严格的标签页模式（`INSTALLED_TAB = "installed"` 与 `MORE_TAB = "more"`），并引入 `tab` 路由状态及 `showsMainList`（替代了原 `showsCards`）。
2. **包过滤模型变更 (`optional` → `official`)**：
   - alpha.1 中以 `pkg.optional` 区分官方可选插件与安装插件：`mine = listed.filter(pkg => pkg.installed || !pkg.optional)`，`official = listed.filter(pkg => pkg.optional && !pkg.installed)`。
   - rc.1 中上游统合为 `pkg.official`：`mine = listed.filter(pkg => !pkg.official)`，`official = listed.filter(pkg => pkg.official)`。
3. **卡片分组重构 (`basicCards` / `extensionsCards` / `moreCards`)**：
   - rc.1 对 Installed 面板中的卡片进行两段式呈现：`basicCards`（承载 `ledger.items`）与 `extensionsCards`（承载已安装扩展），而在 More 面板呈现 `moreCards`（承载 `orderOptionalBundles(official)`）。
4. **页面头部与拖拽重排**：
   - 页面头部样式类重构为 `pageHeading` / `pageHead`，引入原生拖拽属性 `data-window-drag`。

---

## 4. 逐 Hunk 移植与对账映射表

| # | 目标文件 | 锚点位置 (rc.1) | alpha.1 原形态 | rc.1 处置方案与对账 |
|---|---|---|---|---|
| 1 | `lib/client.js` | L28: `SLOTS` 数组声明 | 注册 `plugins.bundle.hidden`, `plugins.item.hidden` | **原样移植**。保持向 slot-contract 的槽位名注册对齐。 |
| 2 | `lib/client.js` | L44: `ledger` 初始状态 | 初始化 `hiddenBundles: new Set()`, `hiddenItems: new Set()` | **原样移植**。结构无漂移。 |
| 3 | `lib/client.js` | L63: `ledger` 刷新组装 | 赋值 `keysOf("plugins.bundle.hidden")` 等 | **原样移植**。动态监听 SlotMap 键变动。 |
| 4 | `lib/client.js` | L2588: `DetailTop` 前 | 注入 `PluginSidebarControl` + 给 `DetailTop` 加 `data-plugin-page-header="detail"` | **重定位锚点**。上游在此处新增了 `isUpgradable` 等逻辑，行号从 ~2306 漂移到 ~2588，插在 `DetailTop` 紧邻上方。 |
| 5 | `lib/client.js` | L2629: `PackageCard` 签名 | 参数注入 `renderSlot` | **重定位锚点**。行号从 ~2330 漂移到 ~2629。 |
| 6 | `lib/client.js` | L2664: `PackageCard` 尾部操作 | `end:` 包裹 Fragment，插入 `renderSlot("plugins.bundle.actions", ...)` | **原样移植**。在 `EnableSwitch` 之前渲染动作槽。 |
| 7 | `lib/client.js` | L2721: `ItemDetail` 签名 | 参数注入 `renderComponents` | **重定位锚点**。行号从 ~2406 漂移至 ~2721。 |
| 8 | `lib/client.js` | L2760: `ItemDetail` 槽位渲染 | `renderSlot("plugins.item", { form, renderComponents }, ...)` | **原样移植**。透传复合渲染函数。 |
| 9 | `lib/client.js` | L3890: 包列表过滤 | `available` 与 `listed` 过滤链重构 | **重构过滤逻辑**。改用 rc.1 的 `pkg.official` 判断，先过滤出 `available`，再通过 `!ledger.hiddenBundles?.has(pkg.name)` 产出 `listed`。 |
| 10 | `lib/client.js` | L3900: `openPkg` 定位 | `openPkg = available.find(...)` | **原样移植**。保证被 hidden 的 Bundle 仍可在 detail 视图中通过 deep link 被找到。 |
| 11 | `lib/client.js` | L3932: `renderComponents` 定义 | 构造 `renderComponents` 闭包 + `packageCard` 传 `renderSlot` | **结构更新**。内部 busy 判定与 rc.1 的 `packageBusy(pkg)` 对齐；组件行绑定 `RowsSection`。 |
| 12 | `lib/client.js` | L3967: `basicCards` 过滤 | 过滤 `!ledger.hiddenItems?.has(item.id)` | **适配新分组**。alpha.1 打在 `officialCards`，rc.1 适配打在上游拆分出的 `basicCards`（`ledger.items.filter(...)`）。 |
| 13 | `lib/client.js` | L4012: 根面板子节点头部 | 渲染 `PluginSidebarControl` + Header 加 `data-plugin-page-header="list"` | **适配新变量**。条件由 alpha.1 的 `showsCards` 适配为 rc.1 的 `showsMainList`。 |
| 14 | `lib/client.js` | L4142: Overview 槽位渲染 | 渲染 `plugins.overview` 槽位 | **适配双 Tab 约束**。添加 `onInstalled && showsMainList && loaded` 守卫，确保概览仅在 Installed Tab 显示。 |
| 15 | `lib/client.js` | L4223: ItemDetail 调用点 | 传递 `renderComponents` | **适配调用点**。保持 `form: formFor(openItem.id), renderComponents` 传入。 |
| 16 | `lib/client.js` | L4467: `slots.register` 字典 | 声明 5 个 desktop slot 契约 | **原样移植**。注册到 `plugins.add.actions` 之前。 |
| 17 | `PluginManagerPage.d.ts` | L12 | `PropsRenderSlots` 扩展槽位联合类型 | **适配上游新增类型**。保留 rc.1 新增的 `'plugins.tab'`，并并入 3 个渲染槽位。 |
| 18 | `config-ledger.d.ts` | L19 | `ConfigLedger` 接口增加 `hiddenBundles` / `hiddenItems` | **原样移植**。追加只读 Set 属性。 |
| 19 | `slot-contract.d.ts` | L17 | 导入 `ReactNode` | **原样移植**。类型声明需要。 |
| 20 | `slot-contract.d.ts` | L26 | `PluginConfigViewProps` 增加 `renderComponents` | **原样移植**。复合渲染函数类型声明。 |
| 21 | `slot-contract.d.ts` | L112 | `SlotMap` 模块扩展声明 | **原样移植**。完整声明 5 个新增 slot 的签名、scope 与 owner 接口。 |

---

## 5. 关键重做技术点与验证结果

### 5.1 双 Tab 下 Overview 挂载点与导航闭环
在 rc.1 中，如果未加 `onInstalled` 守卫，切换到「More」Tab 时概览区域会依然停留在头部，造成视觉混乱与重复布局。补丁明确限制为 `onInstalled && showsMainList && loaded`，只有在已安装列表呈现时才挂载 `plugins.overview`。同时，`onOpenBundle` 与 `onOpenItem` 清除 activation 态并切换 view，经测试与 rc.1 的 `setView` 完全兼容。

### 5.2 隐藏集合与官方/扩展分类链的挂接
alpha.1 的 `optional` 分类链在 rc.1 被替换为：
```javascript
const available = state.packages.filter((pkg) => !BUILTIN_PROFILE_BUNDLES.has(pkg.name) && (pkg.installed || pkg.official || pkg.error !== void 0));
const listed = available.filter((pkg) => !ledger.hiddenBundles?.has(pkg.name));
const mine = listed.filter((pkg) => !pkg.official);
const official = listed.filter((pkg) => pkg.official);
```
该链条既保证了被隐藏的 Bundle 彻底脱离 `mine` 与 `official`，又通过保留 `available` 使 deep-link 打开详情时不会退化为 404/未找到包。

### 5.3 自验结论
在 `/tmp/m9p-dsh-client-ui-plugin-manager` 下执行干净解包与 dry-run 验证：
```bash
patch -p1 -d t/package --dry-run < patches/dsh-client-ui-plugin-manager@0.2.1-rc.1.patch
```
输出：
```
checking file lib/client.js
checking file lib/types/client/PluginManagerPage.d.ts
checking file lib/types/client/config-ledger.d.ts
checking file lib/types/client/slot-contract.d.ts
```
所有 4 个目标文件、21 个 hunk 全部 0 偏移、0 fuzz 干净匹配应用。
