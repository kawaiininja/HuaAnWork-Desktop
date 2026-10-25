import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";

import type {
  AgentDetail,
  AgentListItem,
  AgentPackageDetail,
  AgentPackageListItem,
  AgentPackageListResult,
  AgentPackageSummary,
} from "../../src/client-huaanwork/rpc-types.ts";
import {
  catalogErrorMessage,
  CATALOG_UNREACHABLE_TEXT,
  DELIST_CONFIRM_TEXT,
  DELISTED_NOTICE,
  filterPackageTab,
  formatPackageSize,
  INSTALL_DETAIL_NOTICE,
  isAgentPackageDetail,
  LOCAL_UNSIGNED_LABEL,
  MIGRATION_PACKAGE_LABEL,
  MINE_EMPTY_TEXT,
  MISSING_SIGNATURE_LABEL,
  mineCards,
  PACKAGE_SANDBOX_WARNING,
  packageActionLabel,
  packageActions,
  packageDetailPublishStatus,
  packagePublishStatusLabel,
  packageSourceLabel,
  packageStatusLabel,
  PLAZA_EMPTY_TEXT,
  plazaCards,
  publicationNotice,
  PUBLISH_CONFIRM_TEXT,
  reviewRejectedText,
  revokedText,
  updateHintFor,
  VERIFY_FAILURE_TEXT,
  type AgentPackageCard,
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

// ---------------------------------------------------------------------------
// M2 Task 12：动作清单、状态文案、广场/我的合并
// ---------------------------------------------------------------------------

function card(overrides: Partial<AgentPackageCard> = {}): AgentPackageCard {
  return {
    slug: "demo",
    displayName: "演示助手",
    description: "",
    version: "1.0.0",
    source: "local",
    enabled: false,
    ...overrides,
  };
}

describe("packageActions", () => {
  test("revoked catalog only allows remove and detail", () => {
    assert.deepEqual(
      packageActions(card({
        source: "catalog",
        enabled: true,
        publishStatus: "installed",
        revoked: { slug: "demo", version: "1.0.0", reason: "后门", revokedAt: "2026-10-01T00:00:00.000Z" },
      })),
      ["remove", "detail"],
    );
  });

  test("broken catalog only allows remove and detail", () => {
    assert.deepEqual(
      packageActions(card({ source: "catalog", enabled: true, broken: { reason: "验签失败" } })),
      ["remove", "detail"],
    );
  });

  test("legacy entries keep enable/disable plus detail and never fake a download", () => {
    assert.deepEqual(packageActions(card({ source: "catalog-legacy", enabled: true })), ["disable", "detail"]);
    assert.deepEqual(packageActions(card({ source: "catalog-legacy", enabled: false })), ["enable", "detail"]);
  });

  test("broken local packages can only be disabled when enabled, never published", () => {
    assert.deepEqual(
      packageActions(card({ enabled: true, broken: { reason: "manifest 无法解析" } })),
      ["disable", "detail"],
    );
    assert.deepEqual(
      packageActions(card({ enabled: false, broken: { reason: "manifest 无法解析" } })),
      ["detail"],
    );
  });

  test("uninstalled plaza cards strictly allow install and detail", () => {
    // 即使 enabled/updateAvailable 等字段异常，也只认 installed === false。
    assert.deepEqual(
      packageActions(card({
        source: "catalog",
        enabled: true,
        installed: false,
        publishStatus: "delisted",
        updateAvailable: true,
      })),
      ["install", "detail"],
    );
  });

  test("installed catalog delisted keeps enable/disable, remove and detail but no update", () => {
    assert.deepEqual(
      packageActions(card({
        source: "catalog",
        enabled: true,
        publishStatus: "delisted",
        updateAvailable: true,
      })),
      ["disable", "remove", "detail"],
    );
    assert.deepEqual(
      packageActions(card({ source: "catalog", enabled: false, publishStatus: "delisted" })),
      ["enable", "remove", "detail"],
    );
  });

  test("installed catalog has update only when updateAvailable is true", () => {
    assert.deepEqual(
      packageActions(card({ source: "catalog", enabled: true, publishStatus: "installed", updateAvailable: true })),
      ["disable", "update", "remove", "detail"],
    );
    assert.deepEqual(
      packageActions(card({ source: "catalog", enabled: false, publishStatus: "installed" })),
      ["enable", "remove", "detail"],
    );
  });

  test("local publish states map to the plan's exact action lists", () => {
    assert.deepEqual(packageActions(card({ publishStatus: "pending-review" })), ["publish-status", "detail"]);
    assert.deepEqual(packageActions(card({ publishStatus: "rejected", enabled: true })), ["publish", "detail"]);
    assert.deepEqual(packageActions(card({ publishStatus: "published", enabled: true })), [
      "disable",
      "request-delist",
      "detail",
    ]);
    assert.deepEqual(packageActions(card({ publishStatus: "delisted", enabled: false })), ["enable", "detail"]);
    assert.deepEqual(packageActions(card({ publishStatus: "none", enabled: false })), [
      "enable",
      "publish",
      "detail",
    ]);
    // 缺省 publishStatus 等价未发布。
    assert.deepEqual(packageActions(card({ enabled: false })), ["enable", "publish", "detail"]);
  });

  test("action labels: rejected publishes as 重新提交, everything else per spec", () => {
    assert.equal(packageActionLabel("publish", card({ publishStatus: "rejected" })), "重新提交");
    assert.equal(packageActionLabel("publish", card({ publishStatus: "none" })), "发布");
    assert.equal(packageActionLabel("publish-status", card()), "查看状态");
    assert.equal(packageActionLabel("request-delist", card()), "申请下架");
    assert.equal(packageActionLabel("install", card()), "下载");
    assert.equal(packageActionLabel("update", card()), "更新");
    assert.equal(packageActionLabel("remove", card()), "移除");
    assert.equal(packageActionLabel("enable", card()), "启用");
    assert.equal(packageActionLabel("disable", card()), "关闭");
    assert.equal(packageActionLabel("detail", card()), "查看详情");
  });
});

describe("M2 product copy", () => {
  test("confirmation and error copy match the spec verbatim", () => {
    assert.equal(PUBLISH_CONFIRM_TEXT, "提交后需管理员审查与签名，不会立即上架");
    assert.equal(DELIST_CONFIRM_TEXT, "下架后广场不再提供下载，已安装副本仍可使用；安全处置请由管理员撤销。");
    assert.equal(DELISTED_NOTICE, "已下架，不再提供下载；已安装副本仍可使用");
    assert.equal(CATALOG_UNREACHABLE_TEXT, "目录不可达，请稍后重试；本地智能体不受影响");
    assert.equal(VERIFY_FAILURE_TEXT, "包校验失败，未安装或未运行。请联系管理员");
    assert.equal(MIGRATION_PACKAGE_LABEL, "签名迁移包");
    assert.equal(LOCAL_UNSIGNED_LABEL, "本地创建，未签名");
    assert.equal(MISSING_SIGNATURE_LABEL, "未提供签名信息");
    assert.equal(INSTALL_DETAIL_NOTICE, "安装后可查看签名与文件清单");
    assert.equal(reviewRejectedText("包含越权指令"), "审查未通过：包含越权指令");
    assert.equal(revokedText({ reason: "窃取凭据" }), "该版本已被管理员撤销：窃取凭据");
  });
});

describe("catalogErrorMessage", () => {
  test("normalizes fetch/timeout failures to the honest catalog copy", () => {
    assert.equal(catalogErrorMessage(new TypeError("Failed to fetch")), CATALOG_UNREACHABLE_TEXT);
    assert.equal(catalogErrorMessage(new Error("connect ECONNREFUSED 10.0.0.1:18080")), CATALOG_UNREACHABLE_TEXT);
    assert.equal(catalogErrorMessage(new Error("请求超时(180s)")), CATALOG_UNREACHABLE_TEXT);
    assert.equal(catalogErrorMessage(undefined), CATALOG_UNREACHABLE_TEXT);
    assert.equal(catalogErrorMessage(new Error(CATALOG_UNREACHABLE_TEXT)), CATALOG_UNREACHABLE_TEXT);
  });

  test("keeps business errors verbatim", () => {
    assert.equal(
      catalogErrorMessage(new Error("该版本已被管理员撤销：后门")),
      "该版本已被管理员撤销：后门",
    );
    assert.equal(
      catalogErrorMessage(new Error(VERIFY_FAILURE_TEXT)),
      VERIFY_FAILURE_TEXT,
    );
    assert.equal(catalogErrorMessage(new Error("版本低于已安装版本，已拒绝更新")), "版本低于已安装版本，已拒绝更新");
  });
});

describe("packageStatusLabel", () => {
  test("catalog installed / delisted / revoked / broken labels", () => {
    assert.equal(packageStatusLabel(card({ source: "catalog", publishStatus: "installed" })), "来自广场");
    assert.equal(packageStatusLabel(card({ source: "catalog", publishStatus: "delisted" })), "已下架");
    assert.equal(
      packageStatusLabel(card({
        source: "catalog",
        revoked: { slug: "demo", version: "1.0.0", reason: "后门", revokedAt: "2026-10-01T00:00:00.000Z" },
      })),
      "已撤销：后门",
    );
    assert.equal(
      packageStatusLabel(card({ source: "catalog", broken: { reason: "验签失败" } })),
      "已损坏：验签失败",
    );
    // 未安装的广场签名卡不显示状态行（动作只有下载）。
    assert.equal(packageStatusLabel(card({ source: "catalog", installed: false })), undefined);
  });

  test("local publish states render the spec labels", () => {
    assert.equal(packageStatusLabel(card({ publishStatus: "pending-review" })), "待审查");
    assert.equal(
      packageStatusLabel(card({ publishStatus: "published", publishedVersion: "1.2.1" })),
      "已发布 v1.2.1",
    );
    assert.equal(
      packageStatusLabel(card({ publishStatus: "rejected", reviewReason: "缺少人设" })),
      "审查未通过：缺少人设",
    );
    assert.equal(packageStatusLabel(card({ publishStatus: "delisted" })), "已下架");
    assert.equal(packageStatusLabel(card({ publishStatus: "none" })), undefined);
    assert.equal(packageStatusLabel(card({})), undefined);
  });
});

describe("packagePublishStatusLabel / packageDetailPublishStatus", () => {
  test("maps statuses and defaults by source", () => {
    assert.equal(packagePublishStatusLabel("pending-review"), "待审查");
    assert.equal(packagePublishStatusLabel("published", { publishedVersion: "2.0.0" }), "已发布 v2.0.0");
    assert.equal(packagePublishStatusLabel("rejected", { reviewReason: "原因" }), "审查未通过：原因");
    assert.equal(packagePublishStatusLabel("delisted"), "已下架");
    assert.equal(packagePublishStatusLabel(undefined), "未发布");
    assert.equal(
      packageDetailPublishStatus({ source: "catalog", publishStatus: undefined }),
      "已安装",
    );
    assert.equal(packageDetailPublishStatus({ source: "catalog", publishStatus: "delisted" }), "已下架");
    assert.equal(packageDetailPublishStatus({ source: "local", publishStatus: undefined }), "未发布");
  });
});

describe("formatPackageSize", () => {
  test("human readable sizes and safe invalid input", () => {
    assert.equal(formatPackageSize(512), "512 B");
    assert.equal(formatPackageSize(1536), "1.5 KB");
    assert.equal(formatPackageSize(2 * 1024 * 1024), "2.0 MB");
    assert.equal(formatPackageSize(undefined), "");
    assert.equal(formatPackageSize(Number.NaN), "");
  });
});

describe("publicationNotice", () => {
  test("rejected / delisted / published / pending notices", () => {
    assert.deepEqual(publicationNotice({ publishStatus: "rejected", reviewReason: "越权" }), {
      tone: "error",
      text: "审查未通过：越权",
    });
    assert.deepEqual(publicationNotice({ publishStatus: "delisted" }), {
      tone: "warn",
      text: DELISTED_NOTICE,
    });
    assert.deepEqual(publicationNotice({ publishStatus: "published", publishedVersion: "1.1.0" }), {
      tone: "note",
      text: "已发布 v1.1.0",
    });
    assert.deepEqual(publicationNotice({ publishStatus: "pending-review" }), {
      tone: "note",
      text: "仍在审查中",
    });
  });
});

describe("plazaCards with signed summaries", () => {
  const summaries: AgentPackageSummary[] = [
    {
      slug: "migrated-agent",
      displayName: "迁移后的助手",
      description: "迁移自旧目录",
      version: "2.0.0",
      size: 2048,
      status: "published",
      updatedAt: "2026-10-01T00:00:00.000Z",
      migrationFrom: "legacy-agent",
    },
    {
      slug: "fresh-package",
      displayName: "全新签名包",
      description: "签名广场新包",
      version: "1.0.0",
      size: 512,
      status: "published",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
  ];

  test("signed cards win over the migrated legacy entry and are labelled", () => {
    const cards = plazaCards({
      packages: [],
      catalogPackages: summaries,
      catalogAgents: [enabledCatalogAgent],
    });
    assert.deepEqual(cards.map((item) => item.slug), ["migrated-agent", "fresh-package"]);
    assert.equal(cards[0]?.source, "catalog");
    assert.equal(cards[0]?.installed, false);
    assert.equal(cards[0]?.migrationFrom, "legacy-agent");
    assert.equal(cards[0]?.size, 2048);
    assert.equal(cards[0]?.updatedAt, "2026-10-01T00:00:00.000Z");
    assert.equal(cards[0]?.displayName, "迁移后的助手");
    assert.equal(cards[1]?.migrationFrom, undefined);
  });

  test("a signed summary with the same slug also suppresses the legacy duplicate", () => {
    const sameSlug: AgentPackageSummary = { ...summaries[1]!, slug: "legacy-agent" };
    const cards = plazaCards({
      packages: [],
      catalogPackages: [sameSlug],
      catalogAgents: [enabledCatalogAgent],
    });
    assert.deepEqual(cards.map((item) => item.slug), ["legacy-agent"]);
    assert.equal(cards[0]?.source, "catalog");
  });

  test("without signed summaries the legacy cards stay unchanged", () => {
    const cards = plazaCards({
      packages: [],
      catalogAgents: [enabledCatalogAgent, disabledCatalogAgent, catalogTool],
    });
    assert.deepEqual(cards.map((item) => item.slug), ["legacy-agent", "legacy-agent-off"]);
    assert.equal(cards[0]?.installed, undefined);
    assert.equal(cards[0]?.size, undefined);
  });

  test("already-installed summaries never render as an uninstalled download card", () => {
    const installed: AgentPackageListItem = {
      slug: "fresh-package",
      displayName: "全新签名包",
      description: "签名广场新包",
      version: "1.0.0",
      source: "catalog",
      enabled: true,
      publishStatus: "installed",
    };
    const cards = plazaCards({
      packages: [installed],
      catalogPackages: [summaries[1]!],
      // 同名 legacy 条目也不得借尸还魂：被签名摘要（已安装）覆盖。
      catalogAgents: [{ ...enabledCatalogAgent, name: "fresh-package" }],
    });
    assert.deepEqual(cards, []);
  });
});

describe("mineCards with installed catalog packages", () => {
  const installedCatalog: AgentPackageListItem = {
    slug: "installed-pack",
    displayName: "已安装包",
    description: "来自广场",
    version: "1.0.0",
    source: "catalog",
    enabled: true,
    publishStatus: "installed",
    updateAvailable: true,
  };

  test("local + installed catalog + enabled legacy, with legacy duplicates suppressed", () => {
    const cards = mineCards({
      packages: [localPackage, installedCatalog],
      catalogAgents: [enabledCatalogAgent, disabledCatalogAgent, catalogTool],
    });
    assert.deepEqual(cards.map((item) => item.slug), ["weekly-report", "installed-pack", "legacy-agent"]);
    assert.equal(cards[1]?.source, "catalog");
    assert.equal(cards[1]?.updateAvailable, true);
    assert.equal(cards[2]?.source, "catalog-legacy");

    const deduped = mineCards({
      packages: [installedCatalog],
      catalogAgents: [{ ...enabledCatalogAgent, name: "installed-pack" }],
    });
    assert.deepEqual(deduped.map((item) => item.slug), ["installed-pack"]);
  });

  test("revoked / delisted / rejected fields reach the card", () => {
    const cards = mineCards({
      packages: [
        {
          ...localPackage,
          publishStatus: "rejected",
          reviewReason: "缺少人设",
        },
        {
          ...installedCatalog,
          publishStatus: "delisted",
        },
        {
          ...installedCatalog,
          slug: "revoked-pack",
          revoked: { slug: "revoked-pack", version: "1.0.0", reason: "后门", revokedAt: "2026-10-03T00:00:00.000Z" },
        },
      ],
      catalogAgents: [],
    });
    assert.equal(cards[0]?.reviewReason, "缺少人设");
    assert.equal(cards[1]?.publishStatus, "delisted");
    assert.equal(cards[2]?.revoked?.reason, "后门");
  });
});
