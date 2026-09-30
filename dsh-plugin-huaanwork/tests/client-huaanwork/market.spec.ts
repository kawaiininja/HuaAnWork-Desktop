import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

import {
  catalogItemLabel,
  describeInstalledEmptyMessage,
  describeMarketPanel,
  describeMarketSourceHint,
  filterCatalogItems,
  filterInstallable,
  formatMarketSize,
  IMMUTABLE_REMOVE_REASON,
  immutableRemoveReason,
  installableLabel,
  installButtonState,
  MARKET_TAB_LABELS,
  MARKET_TABS,
  parseImmutableBundles,
  RESTART_CANCELLED_NOTICE,
  shortSha256,
  type MarketInstallableItem,
  type MarketStateView,
} from "../../src/client-huaanwork/logic/market.ts";

const ITEMS: MarketInstallableItem[] = [
  {
    id: "alpha@1.0.0",
    name: "alpha",
    version: "1.0.0",
    displayName: "Alpha 助手",
    summary: "日常办公助手",
    sha256: "a".repeat(64),
    size: 2048,
    installed: false,
  },
  {
    id: "@scope/beta@2.1.0",
    name: "@scope/beta",
    version: "2.1.0",
    summary: "报表导出",
    sha256: "b".repeat(64),
    size: 1_500_000,
    installed: true,
  },
];

test("installableLabel prefers displayName and falls back to package name", () => {
  assert.equal(installableLabel(ITEMS[0]), "Alpha 助手");
  assert.equal(installableLabel(ITEMS[1]), "@scope/beta");
  assert.equal(installableLabel({ name: "gamma", displayName: "  " }), "gamma");
});

test("catalogItemLabel falls back through name and id", () => {
  assert.equal(catalogItemLabel({ displayName: "展示名", name: "pkg" }), "展示名");
  assert.equal(catalogItemLabel({ name: "pkg" }), "pkg");
  assert.equal(catalogItemLabel({ id: "item-1" }), "item-1");
  assert.equal(catalogItemLabel({}), "未命名条目");
});

test("filterInstallable matches name, displayName and summary case-insensitively", () => {
  assert.deepEqual(filterInstallable(ITEMS, ""), ITEMS);
  assert.deepEqual(filterInstallable(ITEMS, "ALPHA").map((item) => item.id), ["alpha@1.0.0"]);
  assert.deepEqual(filterInstallable(ITEMS, "报表").map((item) => item.id), ["@scope/beta@2.1.0"]);
  assert.deepEqual(filterInstallable(ITEMS, "不存在"), []);
});

test("filterCatalogItems matches name and summary", () => {
  const items = [{ name: "alpha" }, { name: "beta", summary: "报表导出" }];
  assert.deepEqual(filterCatalogItems(items, ""), items);
  assert.deepEqual(filterCatalogItems(items, "报表"), [{ name: "beta", summary: "报表导出" }]);
});

test("formatMarketSize renders B/KB/MB/GB", () => {
  assert.equal(formatMarketSize(512), "512 B");
  assert.equal(formatMarketSize(2048), "2.0 KB");
  assert.equal(formatMarketSize(1_500_000), "1.4 MB");
  assert.equal(formatMarketSize(3 * 1024 ** 3), "3.0 GB");
  assert.equal(formatMarketSize(-1), "—");
  assert.equal(formatMarketSize(Number.NaN), "—");
});

test("shortSha256 truncates to 12 chars", () => {
  assert.equal(shortSha256("a".repeat(64)), "a".repeat(12));
  assert.equal(shortSha256("abc"), "abc");
});

test("MARKET_TABS pins the upstream-shaped union plus the M5 'local' offline-bypass tab", () => {
  // Task 7：'local' 为 M5 有意偏离（spec §12 本地安装 tab 合并），落位 installed 与 sources 之间。
  assert.deepEqual([...MARKET_TABS], ["discover", "installable", "installed", "local", "sources"]);
  for (const tab of MARKET_TABS) {
    assert.equal(typeof MARKET_TAB_LABELS[tab], "string");
    assert.ok(MARKET_TAB_LABELS[tab].length > 0, tab);
  }
  assert.equal(MARKET_TAB_LABELS.local, "本地安装");
});

const PRESENTATION = {
  kind: "unreachable",
  title: "无法连接市场",
  body: "内网市场不可达",
  canBypass: true,
} as const;

test("describeMarketPanel orders loading > error > empty > items (D13)", () => {
  // loading 优先，即使已有错误与条目。
  assert.deepEqual(describeMarketPanel("loading", PRESENTATION, 3), { kind: "loading" });
  // error 态需要 presentation 才进错误分支。
  assert.deepEqual(describeMarketPanel("error", PRESENTATION, 0), {
    kind: "error",
    presentation: PRESENTATION,
  });
  // 防御性回落：load=error 但 presentation 缺失（与既有 JSX 行为一致）落入 empty/items。
  assert.deepEqual(describeMarketPanel("error", null, 0), { kind: "empty" });
  assert.deepEqual(describeMarketPanel("error", null, 2), { kind: "items" });
  // ready 态按条目数分空/非空。
  assert.deepEqual(describeMarketPanel("ready", null, 0), { kind: "empty" });
  assert.deepEqual(describeMarketPanel("ready", null, 1), { kind: "items" });
});

test("installButtonState disables on installed and in-flight execute (D13)", () => {
  assert.deepEqual(installButtonState({ installed: true }, false), { disabled: true, label: "已安装" });
  // installed 优先：已安装条目不显示「安装中…」。
  assert.deepEqual(installButtonState({ installed: true }, true), { disabled: true, label: "已安装" });
  assert.deepEqual(installButtonState({ installed: false }, true), { disabled: true, label: "安装中…" });
  assert.deepEqual(installButtonState({ installed: false }, false), { disabled: false, label: "安装" });
});

test("describeMarketSourceHint stays silent until state is ready (D13)", () => {
  const state = (ready: boolean): MarketStateView => ({
    provider: "huaanwork-market",
    origin: "http://127.0.0.1:8787",
    verification: { ready, ...(ready ? { currentKeyId: "ab".repeat(32) } : {}) },
    catalog: { maxAcceptedRevision: null },
    desktopActions: { requestRestart: true },
  });
  assert.equal(describeMarketSourceHint(null, "ready"), null);
  assert.equal(describeMarketSourceHint(state(true), "loading"), null);
  assert.equal(describeMarketSourceHint(state(true), "error"), null);
  assert.equal(describeMarketSourceHint(state(true), "ready"), "源：http://127.0.0.1:8787");
  assert.equal(describeMarketSourceHint(state(false), "ready"), "信任锚未配置：目录验签恒拒，请联系市场管理员");
});

// P27：读失败不得被呈现成「尚未安装任何插件」——那是肯定式假话。三态分开。
test("describeInstalledEmptyMessage separates unreadable from genuinely empty (P27)", () => {
  assert.equal(describeInstalledEmptyMessage("loading", 0), "读取已安装列表中…");
  // 读失败：即使 count 为 0 也**不得**说「尚未安装任何插件」。
  const unreadable = describeInstalledEmptyMessage("error", 0);
  assert.match(unreadable ?? "", /无法读取已安装列表/);
  assert.doesNotMatch(unreadable ?? "", /尚未安装任何插件/);
  assert.match(unreadable ?? "", /不代表没有已安装的插件/);
  // 确实为空（读成功且 0 条）才允许这么说。
  assert.equal(describeInstalledEmptyMessage("ready", 0), "尚未安装任何插件");
  // 有内容 ⇒ 渲染列表本身。
  assert.equal(describeInstalledEmptyMessage("ready", 2), null);
  // 有内容时读取态不再覆盖列表（ready 之前若已有缓存条目也应展示）。
  assert.equal(describeInstalledEmptyMessage("loading", 2), null);
  assert.equal(describeInstalledEmptyMessage("error", 2), null);
});

// P28（评审修复波）：客户端诚实文案是从宿主源码抄来的同一句——此处把「同句」钉成
// 断言；宿主改词而客户端未同步时本门立即变红。P3（Task 6.9）起宿主把三处取消文案
// 收进共享常量 RESTART_CANCELLED_MESSAGES，故改读其 installed 条目（仍是字面量，
// 且是唯一真相源）。
test("RESTART_CANCELLED_NOTICE stays word-for-word equal to the host cancel notice (P28)", () => {
  // 读源码（同 market-view.spec.ts 读 styles.css 的既有跨文件姿态）。锚定共享常量
  // 的 installed 条目——removePlugin 的取消文案不同，路由的中立句也不同，不得误取。
  // 任一环节找不到即抛错，绝不静默跳过或与空串比较。
  const source = readFileSync(resolve(import.meta.dirname, "../../src/huaanwork-host/plugins-host.ts"), "utf8");
  const installed = source.match(/export const RESTART_CANCELLED_MESSAGES = \{[\s\S]*?installed: '([^']+)'/);
  assert.ok(installed, "plugins-host.ts 的 RESTART_CANCELLED_MESSAGES 中未找到 installed 取消文案字面量");
  assert.equal(installed[1], RESTART_CANCELLED_NOTICE);
});

// P26（M6 Task 6.10）：不可移除判定是纯函数。名单的唯一真相源是 host
// （installations 应答的 `immutable` 字段，源头 plugins-host.ts 的 IMMUTABLE_BUNDLES），
// 客户端只读不抄——因此这里同时钉「读应答字段」与「形状守卫」两件事。
test("parseImmutableBundles reads the host payload and guards its shape (P26)", () => {
  assert.deepEqual(parseImmutableBundles({ immutable: ["alpha", "beta"] }), ["alpha", "beta"]);
  // 旧 wrapper 应答（无该字段）⇒ 空集合：不灰化、不假装知道（行为与修复前一致）。
  assert.deepEqual(parseImmutableBundles({ bundles: ["alpha"] }), []);
  // 形状守卫：非数组、非对象、非字符串条目一律剔除，不得把畸形应答当名单用。
  assert.deepEqual(parseImmutableBundles({ immutable: "alpha" }), []);
  assert.deepEqual(parseImmutableBundles({ immutable: [1, "alpha", null] }), ["alpha"]);
  assert.deepEqual(parseImmutableBundles(null), []);
  assert.deepEqual(parseImmutableBundles(undefined), []);
});

test("immutableRemoveReason explains why a carrier bundle cannot be removed (P26)", () => {
  const reason = immutableRemoveReason(["alpha", "beta"], "beta");
  assert.equal(reason, IMMUTABLE_REMOVE_REASON);
  // 说明必须说真话：为何不可移除（随应用分发）且结论明确（不能移除）。
  assert.match(reason ?? "", /随应用分发/);
  assert.match(reason ?? "", /不能移除/);
  // 不在 host 名单里的 bundle 返回 null ⇒ 移除按钮保持可用。
  assert.equal(immutableRemoveReason(["alpha"], "beta"), null);
  assert.equal(immutableRemoveReason([], "beta"), null);
});
