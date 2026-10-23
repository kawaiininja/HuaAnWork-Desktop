// @vitest-environment jsdom
/**
 * 智能体包面板组件级 jsdom spec（Task 8）：两页签的数据来源、动作与空态。
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
  AgentPackageListResult,
} from "../../src/client-huaanwork/rpc-types.ts";

const PACKAGE_LIST: AgentPackageListResult = {
  packages: [
    {
      slug: "weekly-report",
      displayName: "周报助手",
      description: "每周汇总项目进展",
      version: "1.2.0",
      source: "local",
      enabled: false,
    },
  ],
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
  };
}

function emptyListResult(): AgentPackageListResult {
  return { packages: [], catalogAgents: [] };
}

let listPayload: AgentPackageListResult = listResult();

const rpcMock = vi.mocked(rpcCall);

function stubRpc() {
  rpcMock.mockImplementation(async (method: string) => {
    if (method === "agent.packageList") return listPayload;
    if (method === "agent.packageDetail") return PACKAGE_DETAIL;
    if (method === "agent.packageSetEnabled") return { ok: true };
    if (method === "agent.setEnabled") return { ok: true };
    if (method === "agent.get") return LEGACY_DETAIL;
    throw new Error(`unexpected rpc: ${method}`);
  });
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function buttonByText(view: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...view.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  listPayload = listResult();
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
  it("本地包与已启用的旧目录智能体都出卡，工具与未启用旧条目不出卡", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    expect(view.textContent).toContain("周报助手");
    expect(view.textContent).toContain("每周汇总项目进展");
    expect(view.textContent).toContain("weekly-report");
    expect(view.textContent).toContain("本地创建");
    expect(view.textContent).toContain("v1.2.0");

    expect(view.textContent).toContain("旧目录助手");
    expect(view.textContent).toContain("旧目录智能体");

    expect(view.textContent).not.toContain("尚未启用的旧目录智能体");
    expect(view.textContent).not.toContain("查询天气");

    // 更新提示带包 slug。
    expect(view.textContent).toContain("/create-agent update weekly-report");

    // M2 动作不在本页签：没有发布/下载/移除按钮。
    const labels = [...view.querySelectorAll("button")].map((item) => item.textContent?.trim() ?? "");
    expect(labels.some((label) => /发布|下载|移除|卸载/.test(label))).toBe(false);
  });

  it("点击启用调用 agent.packageSetEnabled，随后重拉列表", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    const enable = buttonByText(view, "启用");
    expect(enable).toBeDefined();
    await act(async () => {
      enable!.click();
    });
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

  it("查看详情显示包详情与本机沙箱固定提示", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    const detailButtons = [...view.querySelectorAll("button")].filter(
      (item) => item.textContent?.trim() === "查看详情",
    );
    expect(detailButtons.length).toBeGreaterThan(0);
    await act(async () => {
      detailButtons[0]!.click();
    });
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageDetail", { slug: "weekly-report" });
    expect(container!.textContent).toContain("你是周报助手，按项目汇总进展。");
    expect(container!.textContent).toContain("脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。");
  });

  it("已启用的旧目录智能体可直接关闭，经 agent.packageSetEnabled 写回旧启用表", async () => {
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    const disable = buttonByText(view, "关闭");
    expect(disable).toBeDefined();
    await act(async () => {
      disable!.click();
    });
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageSetEnabled", {
      slug: "legacy-agent",
      enabled: false,
    });
    expect(view.textContent).toContain("已关闭「旧目录助手」");
    const listCalls = rpcMock.mock.calls.filter(([method]) => method === "agent.packageList");
    expect(listCalls.length).toBeGreaterThan(1);
  });

  it("目录不可达时显示 catalogError，已启用的旧条目仍出卡", async () => {
    listPayload = {
      ...listResult(),
      catalogError: "公用机目录请求失败: offline",
    };
    const view = await mount(createElement(AgentPackagesPanel, { search: "", refreshToken: 0 }));

    expect(view.textContent).toContain("公用机目录请求失败: offline");
    // 目录失败不隐藏上次已知的启用条目;关闭入口仍在。
    expect(view.textContent).toContain("旧目录助手");
    expect(buttonByText(view, "关闭")).toBeDefined();
  });
});

describe("AgentsPlazaPanel（智能体广场）", () => {
  it("只展示目录智能体，带“公用机”标识，工具条目不出卡", async () => {
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    expect(view.textContent).toContain("旧目录助手");
    expect(view.textContent).toContain("尚未启用的旧目录智能体");
    expect(view.textContent).toContain("公用机");
    expect(view.textContent).not.toContain("查询天气");
    expect(view.textContent).not.toContain("周报助手");
  });

  it("启用先披露声明的权限，确认前不调用 host，确认后带 confirmPermissions 调用", async () => {
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    const enableButtons = [...view.querySelectorAll("button")].filter(
      (item) => item.textContent?.trim() === "启用",
    );
    expect(enableButtons.length).toBe(1);
    await act(async () => {
      enableButtons[0]!.click();
    });
    await flush();

    // 权限披露：确认框列出目录条目声明的能力，此时宿主尚未收到启用请求。
    expect(view.textContent).toContain("该公用机条目声明了以下能力：");
    expect(view.textContent).toContain("读取工作区文件");
    expect(view.textContent).toContain("访问网络");
    expect(rpcMock.mock.calls.some(([method]) => method === "agent.setEnabled")).toBe(false);

    // 取消不启用。
    const cancel = buttonByText(view, "取消");
    expect(cancel).toBeDefined();
    await act(async () => {
      cancel!.click();
    });
    await flush();
    expect(rpcMock.mock.calls.some(([method]) => method === "agent.setEnabled")).toBe(false);
    expect(buttonByText(view, "确认启用")).toBeUndefined();

    // 再次打开确认框并确认：以 confirmPermissions: true 启用并重拉列表。
    await act(async () => {
      buttonByText(view, "启用")!.click();
    });
    await flush();
    const confirm = buttonByText(view, "确认启用");
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.click();
    });
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

    const disable = buttonByText(view, "关闭");
    expect(disable).toBeDefined();
    await act(async () => {
      disable!.click();
    });
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
