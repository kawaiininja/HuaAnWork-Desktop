import assert from "node:assert/strict";
import { test } from "vitest";

import {
  catalogItemLabel,
  filterCatalogItems,
  filterInstallable,
  formatMarketSize,
  installableLabel,
  shortSha256,
  type MarketInstallableItem,
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
