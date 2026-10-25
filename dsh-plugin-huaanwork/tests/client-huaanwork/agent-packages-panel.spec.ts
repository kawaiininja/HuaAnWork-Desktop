// @vitest-environment jsdom
/**
 * 智能体包面板组件级 jsdom spec（Task 8 / M2 Task 12）：两页签的数据来源、
 * 状态动作、确认对话框、错误文案与 per-slug 在飞守卫。
 *
 * 形态承 tests/client-huaanwork/market-view.spec.ts 的 createRoot + act；
 * `rpcCall` 经 vi.mock 拦截，不触真实宿主。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
}));

import { rpcCall } from "../../src/client-huaanwork/api.ts";
import AgentPackagesPanel from "../../src/client-huaanwork/AgentPackagesPanel.tsx";
import AgentsPlazaPanel from "../../src/client-huaanwork/AgentsPlazaPanel.tsx";
import type {
  AgentDetail,
  AgentPackageDetail,
  AgentPackageListItem,
  AgentPackageListResult,
} from "../../src/client-huaanwork/rpc-types.ts";

const LOCAL_PACKAGE: AgentPackageListItem = {
  slug: "weekly-report",
  displayName: "周报助手",
  description: "每周汇总项目进展",
  version: "1.2.0",
  source: "local",
  enabled: false,
};

const PACKAGE_LIST: AgentPackageListResult = {
  packages: [LOCAL_PACKAGE],
  catalogAgents: [
    {
      name: "legacy-agent",
      displayName: "旧目录助手",
      source: "catalog",
      kind: "agent",
      description: "旧目录里的智能体",
      version: "0.9.0",
      permissions: [],
      enabled: true,
    },
    {
      name: "legacy-agent-off",
      source: "catalog",
      kind: "agent",
      description: "尚未启用的旧目录智能体",
      version: "0.9.1",
      permissions: ["读取工作区文件", "访问网络"],
      enabled: false,
    },
    {
      name: "weather",
      source: "catalog",
      kind: "tool",
      entrypointKind: "http",
      description: "查询天气",
      version: "0.1.0",
      permissions: [],
      enabled: true,
    },
  ],
};

const PACKAGE_DETAIL: AgentPackageDetail = {
  slug: "weekly-report",
  displayName: "周报助手",
  description: "每周汇总项目进展",
  version: "1.2.0",
  source: "local",
  enabled: false,
  persona: "你是周报助手，按项目汇总进展。",
  skill: { summary: "汇总本周进展", markdown: "# 周报", scripts: [] },
  tools: "none",
  files: [{ path: "persona.md", size: 128 }],
};

const CATALOG_DETAIL: AgentPackageDetail = {
  slug: "signed-pack",
  displayName: "签名广场包",
  description: "来自广场的签名包",
  version: "2.1.0",
  source: "catalog",
  enabled: true,
  publishStatus: "installed",
  persona: "你是签名广场包。",
  skill: null,
  tools: "none",
  files: [
    { path: "manifest.json", size: 256 },
    { path: "persona.md", size: 64 },
  ],
  signature: {
    keyId: "abc123",
    signedAt: "2026-10-20T08:00:00.000Z",
    slot: 1,
    verification: "valid",
  },
};

const LEGACY_DETAIL: AgentDetail = {
  name: "legacy-agent",
  displayName: "旧目录助手",
  source: "catalog",
  kind: "agent",
  description: "旧目录里的智能体",
  version: "0.9.0",
  permissions: [],
  enabled: true,
  persona: "你是旧目录助手。",
};

function listResult(): AgentPackageListResult {
  return {
    packages: PACKAGE_LIST.packages.map((item) => ({ ...item })),
    catalogAgents: PACKAGE_LIST.catalogAgents.map((item) => ({ ...item })),
    catalogPackages: [],
  };
}

function emptyListResult(): AgentPackageListResult {
  return { packages: [], catalogAgents: [], catalogPackages: [] };
}

let listPayload: AgentPackageListResult = listResult();
type Handler = (params?: unknown) => unknown;
let handlers: Record<string, Handler> = {};

const rpcMock = vi.mocked(rpcCall);

function stubRpc() {
  rpcMock.mockImplementation(async (method: string, params?: unknown) => {
    const handler = handlers[method];
    if (handler) return handler(params);
    if (method === "agent.packageList") return listPayload;
    if (method === "agent.packageDetail") return PACKAGE_DETAIL;
    if (method === "agent.packageSetEnabled") return { ok: true };
    if (method === "agent.setEnabled") return { ok: true };
    if (method === "agent.get") return LEGACY_DETAIL;
    if (method === "agent.packagePublish") return { submissionId: "sub-1" };
    if (method === "agent.packageInstall") return { ok: true, version: "2.1.0" };
    if (method === "agent.packageUpdate") return { ok: true, version: "2.1.0" };
    if (method === "agent.packageRemove") return { ok: true, removed: true };
    if (method === "agent.packageRequestDelist") return { requestId: "req-1" };
    if (method === "agent.packagePublishStatus") {
      return { slug: "weekly-report", publishStatus: "pending-review" };
    }
    throw new Error(`unexpected rpc: ${method}`);
  });
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function buttonByText(view: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...view.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
}

function cardBySlug(view: HTMLElement, slug: string): HTMLElement {
  const card = view.querySelector<HTMLElement>(`[data-slug="${slug}"]`);
  if (!card) throw new Error(`card not found: ${slug}`);
  return card;
}

function buttonIn(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
}

function buttonLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll("button")].map((item) => item.textContent?.trim() ?? "");
}

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  return container;
}

async function flush(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function callsOf(method: string): unknown[][] {
  return rpcMock.mock.calls.filter(([name]) => name === method);
}

beforeEach(() => {
  listPayload = listResult();
  handlers = {};
  rpcMock.mockReset();
  stubRpc();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
});

describe("AgentPackagesPanel（我的智能体）", () => {
  it("本地包出卡显示本地创建与更新提示；legacy 出卡且不伪造下载", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    expect(view.textContent).toContain("周报助手");
    expect(view.textContent).toContain("每周汇总项目进展");
    expect(view.textContent).toContain("weekly-report");
    expect(view.textContent).toContain("本地创建");
    expect(view.textContent).toContain("v1.2.0");
    expect(view.textContent).toContain("/create-agent update weekly-report");

    expect(view.textContent).toContain("旧目录助手");
    expect(view.textContent).toContain("旧目录智能体");
    expect(view.textContent).not.toContain("尚未启用的旧目录智能体");
    expect(view.textContent).not.toContain("查询天气");

    // 未发布的本地包：可发布；legacy 只有启停与详情，没有下载。
    expect(buttonLabels(cardBySlug(view, "weekly-report"))).toEqual(["查看详情", "启用", "发布"]);
    expect(buttonLabels(cardBySlug(view, "legacy-agent"))).toEqual(["查看详情", "关闭"]);
    expect(view.textContent).not.toContain("下载");
  });

  it("损坏且已启用的本地包只能关闭；未启用的损坏包只剩详情", async () => {
    listPayload = {
      packages: [
        {
          slug: "broken-on",
          displayName: "损坏已启用",
          description: "manifest 无法解析",
          version: "1.0.0",
          source: "local",
          enabled: true,
          broken: { reason: "manifest 无法解析" },
        },
        {
          slug: "broken-off",
          displayName: "损坏未启用",
          description: "manifest 无法解析",
          version: "1.0.0",
          source: "local",
          enabled: false,
          broken: { reason: "manifest 无法解析" },
        },
      ],
      catalogAgents: [],
    };

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    expect(buttonLabels(cardBySlug(view, "broken-on"))).toEqual(["查看详情", "关闭"]);
    expect(buttonLabels(cardBySlug(view, "broken-off"))).toEqual(["查看详情"]);
    expect(view.textContent).toContain("已损坏：manifest 无法解析");

    const disable = buttonIn(cardBySlug(view, "broken-on"), "关闭");
    expect(disable).toBeDefined();
    await click(disable!);
    await flush();
    expect(rpcMock).toHaveBeenCalledWith("agent.packageSetEnabled", { slug: "broken-on", enabled: false });
  });

  it("点击启用调用 agent.packageSetEnabled，随后重拉列表", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    const enable = buttonByText(view, "启用");
    expect(enable).toBeDefined();
    await click(enable!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageSetEnabled", {
      slug: "weekly-report",
      enabled: true,
    });
    const listCalls = rpcMock.mock.calls.filter(([method]) => method === "agent.packageList");
    expect(listCalls.length).toBeGreaterThan(1);
  });

  it("空态文案与产品文案逐字一致", async () => {
    listPayload = emptyListResult();
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    expect(view.querySelector(".panel-empty")?.textContent).toBe(
      "还没有智能体。在会话里说「帮我新建一个智能体」即可创建。",
    );
  });

  it("查看详情显示包详情、本地未签名与固定沙箱提示", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    await click(buttonIn(cardBySlug(view, "weekly-report"), "查看详情")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageDetail", { slug: "weekly-report" });
    expect(container!.textContent).toContain("你是周报助手，按项目汇总进展。");
    expect(container!.textContent).toContain("本地创建，未签名");
    expect(container!.textContent).toContain("未发布");
    expect(container!.textContent).toContain("persona.md");
    expect(container!.textContent).toContain("128 字节");
    expect(container!.textContent).toContain("脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。");
  });

  it("目录签名包详情显示 keyId、签名时间、槽位与验签结果", async () => {
    listPayload = {
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "来自广场的签名包",
          version: "2.1.0",
          source: "catalog",
          enabled: true,
          publishStatus: "installed",
        },
      ],
      catalogAgents: [],
    };
    handlers["agent.packageDetail"] = () => CATALOG_DETAIL;

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    await click(buttonIn(cardBySlug(view, "signed-pack"), "查看详情")!);
    await flush();

    expect(container!.textContent).toContain("来自广场");
    expect(container!.textContent).toContain("keyId：abc123");
    expect(container!.textContent).toContain("签名时间：2026-10-20T08:00:00.000Z");
    expect(container!.textContent).toContain("槽位：1");
    expect(container!.textContent).toContain("验签结果：通过");
    expect(container!.textContent).toContain("manifest.json");
    expect(container!.textContent).toContain("256 字节");
  });

  it("验签未通过显示“验签结果：未通过”与原因，不展示 keyId/签名时间", async () => {
    listPayload = {
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "来自广场的签名包",
          version: "2.1.0",
          source: "catalog",
          enabled: true,
          publishStatus: "installed",
        },
      ],
      catalogAgents: [],
    };
    handlers["agent.packageDetail"] = () => ({
      ...CATALOG_DETAIL,
      signature: {
        keyId: "abc123",
        signedAt: "2026-10-20T08:00:00.000Z",
        slot: 1,
        verification: "invalid",
        reason: "摘要与签名不匹配",
      },
    });

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    await click(buttonIn(cardBySlug(view, "signed-pack"), "查看详情")!);
    await flush();

    expect(container!.textContent).toContain("验签结果：未通过");
    expect(container!.textContent).toContain("原因：摘要与签名不匹配");
    expect(container!.textContent).not.toContain("keyId：abc123");
    expect(container!.textContent).not.toContain("验签结果：通过");
  });

  it("目录包 not-applicable 显示未提供签名信息，不冒充本地未签名", async () => {
    listPayload = {
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "来自广场的签名包",
          version: "2.1.0",
          source: "catalog",
          enabled: true,
          publishStatus: "installed",
        },
      ],
      catalogAgents: [],
    };
    handlers["agent.packageDetail"] = () => ({
      ...CATALOG_DETAIL,
      signature: { keyId: "", signedAt: "", slot: 1, verification: "not-applicable" },
    });

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    await click(buttonIn(cardBySlug(view, "signed-pack"), "查看详情")!);
    await flush();

    expect(container!.textContent).toContain("未提供签名信息");
    expect(container!.textContent).not.toContain("本地创建，未签名");
  });

  it("待审查卡只有查看状态与详情；查看到被拒后显示审查文案", async () => {
    listPayload = {
      packages: [{ ...LOCAL_PACKAGE, publishStatus: "pending-review" }],
      catalogAgents: [],
    };
    handlers["agent.packagePublishStatus"] = () => ({
      slug: "weekly-report",
      publishStatus: "rejected",
      reviewReason: "包含越权指令",
    });

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    expect(view.textContent).toContain("待审查");
    expect(buttonLabels(cardBySlug(view, "weekly-report"))).toEqual(["查看详情", "查看状态"]);

    await click(buttonIn(cardBySlug(view, "weekly-report"), "查看状态")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packagePublishStatus", { slug: "weekly-report" });
    expect(view.textContent).toContain("审查未通过：包含越权指令");
  });

  it("被拒卡严格只有重新提交与详情；确认后才调用发布 RPC", async () => {
    listPayload = {
      packages: [{ ...LOCAL_PACKAGE, publishStatus: "rejected", reviewReason: "缺少人设", enabled: true }],
      catalogAgents: [],
    };

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    const card = cardBySlug(view, "weekly-report");
    expect(view.textContent).toContain("审查未通过：缺少人设");
    expect(buttonLabels(card)).toEqual(["查看详情", "重新提交"]);

    await click(buttonIn(card, "重新提交")!);
    expect(view.textContent).toContain("提交后需管理员审查与签名，不会立即上架");
    expect(callsOf("agent.packagePublish")).toHaveLength(0);

    await click(buttonByText(view, "取消")!);
    expect(callsOf("agent.packagePublish")).toHaveLength(0);
    expect(view.textContent).not.toContain("提交后需管理员审查与签名");

    await click(buttonIn(cardBySlug(view, "weekly-report"), "重新提交")!);
    await click(buttonByText(view, "确认提交")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packagePublish", { slug: "weekly-report" });
    expect(callsOf("agent.packagePublish")).toHaveLength(1);
  });

  it("已发布卡可申请下架：确认文案先出现，填写原因后才调用 RPC", async () => {
    listPayload = {
      packages: [
        {
          ...LOCAL_PACKAGE,
          enabled: true,
          publishStatus: "published",
          publishedVersion: "1.2.0",
        },
      ],
      catalogAgents: [],
    };

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    expect(view.textContent).toContain("已发布 v1.2.0");
    expect(buttonLabels(cardBySlug(view, "weekly-report"))).toEqual(["查看详情", "关闭", "申请下架"]);

    await click(buttonIn(cardBySlug(view, "weekly-report"), "申请下架")!);
    expect(view.textContent).toContain(
      "下架后广场不再提供下载，已安装副本仍可使用；安全处置请由管理员撤销。",
    );
    expect(callsOf("agent.packageRequestDelist")).toHaveLength(0);

    await click(buttonByText(view, "取消")!);
    expect(callsOf("agent.packageRequestDelist")).toHaveLength(0);

    await click(buttonIn(cardBySlug(view, "weekly-report"), "申请下架")!);
    const confirm = buttonByText(view, "确认下架");
    expect(confirm?.disabled).toBe(true);
    await typeInto(container!.querySelector<HTMLInputElement>('input[aria-label="下架原因"]')!, "内容过时");
    await click(buttonByText(view, "确认下架")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageRequestDelist", {
      slug: "weekly-report",
      reason: "内容过时",
    });
  });

  it("本地已下架卡不提供重新上架", async () => {
    listPayload = {
      packages: [{ ...LOCAL_PACKAGE, publishStatus: "delisted", publishedVersion: "1.2.0" }],
      catalogAgents: [],
    };
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    expect(view.textContent).toContain("已下架");
    expect(buttonLabels(cardBySlug(view, "weekly-report"))).toEqual(["查看详情", "启用"]);
    expect(view.textContent).not.toContain("发布");
    expect(view.textContent).not.toContain("申请下架");
  });

  it("未发布的本地卡点击发布先出现确认文案，取消不发 RPC", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    await click(buttonIn(cardBySlug(view, "weekly-report"), "发布")!);
    expect(view.textContent).toContain("提交后需管理员审查与签名，不会立即上架");
    expect(callsOf("agent.packagePublish")).toHaveLength(0);

    await click(buttonByText(view, "取消")!);
    expect(callsOf("agent.packagePublish")).toHaveLength(0);

    await click(buttonIn(cardBySlug(view, "weekly-report"), "发布")!);
    await click(buttonByText(view, "确认提交")!);
    await flush();
    expect(rpcMock).toHaveBeenCalledWith("agent.packagePublish", { slug: "weekly-report" });
    expect(view.textContent).toContain("已提交审查");
  });

  it("已安装广场包：显示来自广场，更新调用 packageUpdate", async () => {
    listPayload = {
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "来自广场",
          version: "2.0.0",
          source: "catalog",
          enabled: true,
          publishStatus: "installed",
          latestVersion: "2.1.0",
          updateAvailable: true,
        },
      ],
      catalogAgents: [],
    };

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    expect(view.textContent).toContain("来自广场");
    // 来源徽标与状态行同文案时只渲染一次（不再出现两个“来自广场”）。
    const sourceBadges = [...cardBySlug(view, "signed-pack").querySelectorAll(".badge")].filter(
      (item) => item.textContent?.trim() === "来自广场",
    );
    expect(sourceBadges).toHaveLength(1);
    expect(buttonLabels(cardBySlug(view, "signed-pack"))).toEqual([
      "查看详情",
      "关闭",
      "更新",
      "移除",
    ]);

    await click(buttonIn(cardBySlug(view, "signed-pack"), "更新")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageUpdate", { slug: "signed-pack" });
    expect(view.textContent).toContain("已更新「签名广场包」到 v2.1.0");
  });

  it("已下架的已安装包：不显示更新；移除需确认后调用 packageRemove", async () => {
    listPayload = {
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "来自广场",
          version: "2.0.0",
          source: "catalog",
          enabled: false,
          publishStatus: "delisted",
          updateAvailable: true,
        },
      ],
      catalogAgents: [],
    };

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    expect(view.textContent).toContain("已下架");
    expect(buttonLabels(cardBySlug(view, "signed-pack"))).toEqual(["查看详情", "启用", "移除"]);

    await click(buttonIn(cardBySlug(view, "signed-pack"), "移除")!);
    expect(callsOf("agent.packageRemove")).toHaveLength(0);
    await click(buttonByText(view, "确认移除")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageRemove", { slug: "signed-pack" });
    expect(view.textContent).toContain("已移除「签名广场包」");
  });

  it("已撤销目录包只显示已撤销原因与移除/详情", async () => {
    listPayload = {
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "来自广场",
          version: "2.0.0",
          source: "catalog",
          enabled: false,
          publishStatus: "installed",
          revoked: {
            slug: "signed-pack",
            version: "2.0.0",
            reason: "窃取凭据",
            revokedAt: "2026-10-21T00:00:00.000Z",
          },
        },
      ],
      catalogAgents: [],
    };

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));
    expect(view.textContent).toContain("已撤销：窃取凭据");
    expect(buttonLabels(cardBySlug(view, "signed-pack"))).toEqual(["查看详情", "移除"]);

    await click(buttonIn(cardBySlug(view, "signed-pack"), "移除")!);
    await click(buttonByText(view, "确认移除")!);
    await flush();
    expect(rpcMock).toHaveBeenCalledWith("agent.packageRemove", { slug: "signed-pack" });
  });

  it("catalogError 与 revocationWarning 在顶部显示，本地卡仍可用", async () => {
    listPayload = {
      ...listResult(),
      catalogError: "公用机目录请求失败: offline",
      revocationWarning: "撤销列表刷新失败：offline",
    };
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    expect(view.textContent).toContain("公用机目录请求失败: offline");
    expect(view.textContent).toContain("撤销列表刷新失败：offline");
    expect(view.textContent).toContain("周报助手");
    expect(buttonIn(cardBySlug(view, "weekly-report"), "发布")).toBeDefined();
    // 目录失败不隐藏上次已知的启用条目;关闭入口仍在。
    expect(view.textContent).toContain("旧目录助手");
    expect(buttonIn(cardBySlug(view, "legacy-agent"), "关闭")).toBeDefined();
  });

  it("已启用的旧目录智能体可直接关闭，经 agent.packageSetEnabled 写回旧启用表", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    const disable = buttonIn(cardBySlug(view, "legacy-agent"), "关闭");
    expect(disable).toBeDefined();
    await click(disable!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageSetEnabled", {
      slug: "legacy-agent",
      enabled: false,
    });
    expect(view.textContent).toContain("已关闭「旧目录助手」");
    const listCalls = rpcMock.mock.calls.filter(([method]) => method === "agent.packageList");
    expect(listCalls.length).toBeGreaterThan(1);
  });
});

describe("AgentPackagesPanel per-slug 在飞守卫", () => {
  it("同卡重复点击被忽略，其他卡点击不被静默丢弃", async () => {
    listPayload = {
      packages: [
        { ...LOCAL_PACKAGE, slug: "slow-a", displayName: "慢卡" },
        { ...LOCAL_PACKAGE, slug: "fast-b", displayName: "快卡" },
      ],
      catalogAgents: [],
    };
    let releaseSlow: (() => void) | undefined;
    handlers["agent.packageSetEnabled"] = (params) => {
      const slug = (params as { slug: string }).slug;
      if (slug === "slow-a") {
        return new Promise((resolve) => {
          releaseSlow = () => resolve({ ok: true });
        });
      }
      return Promise.resolve({ ok: true });
    };

    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    const slow = buttonIn(cardBySlug(view, "slow-a"), "启用")!;
    await click(slow);
    await click(slow);
    expect(callsOf("agent.packageSetEnabled")).toHaveLength(1);
    // 在飞期间该卡按钮禁用。
    expect(buttonIn(cardBySlug(view, "slow-a"), "启用")?.disabled).toBe(true);
    // 其他卡仍可点，且不会被静默丢弃。
    await click(buttonIn(cardBySlug(view, "fast-b"), "启用")!);
    await flush();
    const slugs = callsOf("agent.packageSetEnabled").map(([, params]) => (params as { slug: string }).slug);
    expect(slugs).toEqual(["slow-a", "fast-b"]);

    await act(async () => {
      releaseSlow?.();
    });
    await flush();
    expect(buttonIn(cardBySlug(view, "slow-a"), "启用")?.disabled).toBe(false);
  });
});

describe("AgentsPlazaPanel（智能体广场，M1 兼容）", () => {
  it("只展示目录智能体，带“公用机”标识，工具条目不出卡", async () => {
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    expect(view.textContent).toContain("旧目录助手");
    expect(view.textContent).toContain("尚未启用的旧目录智能体");
    expect(view.textContent).toContain("公用机");
    expect(view.textContent).not.toContain("查询天气");
    expect(view.textContent).not.toContain("周报助手");
    expect(view.textContent).not.toContain("下载");
  });

  it("启用先披露声明的权限，确认前不调用 host，确认后带 confirmPermissions 调用", async () => {
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    const enableButtons = [...view.querySelectorAll("button")].filter(
      (item) => item.textContent?.trim() === "启用",
    );
    expect(enableButtons.length).toBe(1);
    await click(enableButtons[0]!);
    await flush();

    // 权限披露：确认框列出目录条目声明的能力，此时宿主尚未收到启用请求。
    expect(view.textContent).toContain("该公用机条目声明了以下能力：");
    expect(view.textContent).toContain("读取工作区文件");
    expect(view.textContent).toContain("访问网络");
    expect(rpcMock.mock.calls.some(([method]) => method === "agent.setEnabled")).toBe(false);

    // 取消不启用。
    const cancel = buttonByText(view, "取消");
    expect(cancel).toBeDefined();
    await click(cancel!);
    await flush();
    expect(rpcMock.mock.calls.some(([method]) => method === "agent.setEnabled")).toBe(false);
    expect(buttonByText(view, "确认启用")).toBeUndefined();

    // 再次打开确认框并确认：以 confirmPermissions: true 启用并重拉列表。
    await click(buttonByText(view, "启用")!);
    await flush();
    const confirm = buttonByText(view, "确认启用");
    expect(confirm).toBeDefined();
    await click(confirm!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.setEnabled", {
      name: "legacy-agent-off",
      enabled: true,
      confirmPermissions: true,
    });
    expect(buttonByText(view, "确认启用")).toBeUndefined();
    const listCalls = rpcMock.mock.calls.filter(([method]) => method === "agent.packageList");
    expect(listCalls.length).toBeGreaterThan(1);
  });

  it("关闭直接生效，不经过权限确认框", async () => {
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    const disable = buttonIn(cardBySlug(view, "legacy-agent"), "关闭");
    expect(disable).toBeDefined();
    await click(disable!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.setEnabled", { name: "legacy-agent", enabled: false });
    expect(buttonByText(view, "确认启用")).toBeUndefined();
  });

  it("空态文案与产品文案逐字一致", async () => {
    listPayload = emptyListResult();
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    expect(view.querySelector(".panel-empty")?.textContent).toBe("暂无可用智能体；请先配置公用机目录。");
  });
});
