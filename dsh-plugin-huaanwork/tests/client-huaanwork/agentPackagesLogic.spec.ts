import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";

import type {
  AgentDetail,
  AgentListItem,
  AgentPackageDetail,
  AgentPackageListItem,
  AgentPackageListResult,
} from "../../src/client-huaanwork/rpc-types.ts";
import {
  filterPackageTab,
  isAgentPackageDetail,
  MINE_EMPTY_TEXT,
  mineCards,
  PACKAGE_SANDBOX_WARNING,
  packageSourceLabel,
  PLAZA_EMPTY_TEXT,
  plazaCards,
  updateHintFor,
} from "../../src/client-huaanwork/logic/agentPackagesLogic.ts";

const localPackage: AgentPackageListItem = {
  slug: "weekly-report",
  displayName: "周报助手",
  description: "每周汇总项目进展",
  version: "1.2.0",
  source: "local",
  enabled: false,
};

const enabledCatalogAgent: AgentListItem = {
  name: "legacy-agent",
  displayName: "旧目录助手",
  source: "catalog",
  kind: "agent",
  description: "旧目录里的智能体",
  version: "0.9.0",
  permissions: [],
  enabled: true,
};

const disabledCatalogAgent: AgentListItem = {
  ...enabledCatalogAgent,
  name: "legacy-agent-off",
  displayName: undefined,
  enabled: false,
};

const catalogTool: AgentListItem = {
  name: "weather",
  source: "catalog",
  kind: "tool",
  entrypointKind: "http",
  description: "查询天气",
  version: "0.1.0",
  permissions: [],
  enabled: true,
};

function listResult(overrides: Partial<AgentPackageListResult> = {}): AgentPackageListResult {
  return {
    packages: [localPackage],
    catalogAgents: [enabledCatalogAgent, disabledCatalogAgent, catalogTool],
    ...overrides,
  };
}

test("package source labels", () => {
  expect(packageSourceLabel("local")).toBe("本地创建");
  expect(packageSourceLabel("catalog-legacy")).toBe("旧目录智能体");
});

test("update hint uses the slug", () => {
  expect(updateHintFor("weekly-report")).toContain("/create-agent update weekly-report");
});

test("empty states and sandbox warning match the product copy", () => {
  assert.equal(PLAZA_EMPTY_TEXT, "暂无可用智能体；请先配置公用机目录。");
  assert.equal(MINE_EMPTY_TEXT, "还没有智能体。在会话里说「帮我新建一个智能体」即可创建。");
  assert.equal(PACKAGE_SANDBOX_WARNING, "脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。");
});

describe("plaza cards", () => {
  test("only catalog agents are shown; tools stay out of the plaza tab", () => {
    const cards = plazaCards(listResult());
    assert.deepEqual(cards.map((card) => card.slug), ["legacy-agent", "legacy-agent-off"]);
    assert.equal(cards[0]?.displayName, "旧目录助手");
    // 目录条目没有 displayName 时回落 name。
    assert.equal(cards[1]?.displayName, "legacy-agent-off");
    assert.equal(cards[0]?.source, "catalog-legacy");
  });
});

describe("mine cards", () => {
  test("local packages plus enabled catalog agents are shown", () => {
    const cards = mineCards(listResult());
    assert.deepEqual(cards.map((card) => card.slug), ["weekly-report", "legacy-agent"]);
    assert.equal(cards[0]?.displayName, "周报助手");
    assert.equal(cards[0]?.source, "local");
    assert.equal(cards[1]?.source, "catalog-legacy");
  });

  test("disabled catalog agents and tools are excluded", () => {
    const cards = mineCards(listResult());
    assert.equal(cards.some((card) => card.slug === "legacy-agent-off"), false);
    assert.equal(cards.some((card) => card.slug === "weather"), false);
  });
});

describe("filterPackageTab", () => {
  const cards = mineCards(listResult());

  test("blank query returns every card", () => {
    assert.deepEqual(filterPackageTab(cards, "  ").map((card) => card.slug), ["weekly-report", "legacy-agent"]);
  });

  test("matches displayName, slug and description case-insensitively", () => {
    assert.deepEqual(filterPackageTab(cards, "周报").map((card) => card.slug), ["weekly-report"]);
    assert.deepEqual(filterPackageTab(cards, "LEGACY").map((card) => card.slug), ["legacy-agent"]);
    assert.deepEqual(filterPackageTab(cards, "汇总").map((card) => card.slug), ["weekly-report"]);
    assert.deepEqual(filterPackageTab(cards, "不存在"), []);
  });
});

describe("isAgentPackageDetail", () => {
  test("narrows package details by slug, not by source", () => {
    const pkg: AgentPackageDetail = {
      slug: "weekly-report",
      displayName: "周报助手",
      description: "",
      version: "1.2.0",
      source: "local",
      enabled: true,
      persona: "你是周报助手",
      skill: null,
      tools: "none",
      files: [],
    };
    assert.equal(isAgentPackageDetail(pkg), true);
  });

  test("legacy local tool rows may also carry source 'local' and are not package details", () => {
    const legacy: AgentDetail = {
      name: "weather",
      source: "local",
      kind: "tool",
      description: "",
      version: "0.1.0",
      permissions: [],
      enabled: true,
      entrypoint: { kind: "http", url: "http://127.0.0.1:9000" },
    };
    assert.equal(isAgentPackageDetail(legacy), false);
  });
});
