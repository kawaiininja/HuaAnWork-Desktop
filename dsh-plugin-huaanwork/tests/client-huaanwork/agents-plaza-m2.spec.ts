// @vitest-environment jsdom
/**
 * 广场签名包与智能体页外壳的 M2 spec（Task 12）：
 * - 广场签名卡（名称/简介/版本/大小/下载、迁移去重）与下载动作；
 * - 下载失败的规格中文（撤销 / 验签 / 网络）；
 * - 发布口令输入与 settings.set 一起保存；
 * - 进入页面与手动刷新的顺序、60 秒撤销轮询、不重叠、卸载清理、失败保留本地卡。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
}));

import { rpcCall } from "../../src/client-huaanwork/api.ts";
import AgentsPlazaPanel from "../../src/client-huaanwork/AgentsPlazaPanel.tsx";
import AgentsView, { PACKAGE_REFRESH_INTERVAL_MS } from "../../src/client-huaanwork/AgentsView.tsx";
import type {
  AgentPackageListItem,
  AgentPackageListResult,
  AgentPackageSummary,
} from "../../src/client-huaanwork/rpc-types.ts";

const LOCAL_PACKAGE: AgentPackageListItem = {
  slug: "weekly-report",
  displayName: "周报助手",
  description: "每周汇总项目进展",
  version: "1.2.0",
  source: "local",
  enabled: false,
};

const SIGNED_SUMMARY: AgentPackageSummary = {
  slug: "signed-pack",
  displayName: "签名广场包",
  description: "管理员签名的广场包",
  version: "2.1.0",
  size: 2048,
  status: "published",
  updatedAt: "2026-10-20T08:00:00.000Z",
};

const MIGRATED_SUMMARY: AgentPackageSummary = {
  slug: "migrated-agent",
  displayName: "迁移后的助手",
  description: "由旧目录迁移",
  version: "1.0.0",
  size: 700,
  status: "published",
  updatedAt: "2026-10-20T08:00:00.000Z",
  migrationFrom: "legacy-agent",
};

const LEGACY_AGENT = {
  name: "legacy-agent",
  displayName: "旧目录助手",
  source: "catalog" as const,
  kind: "agent" as const,
  description: "旧目录里的智能体",
  version: "0.9.0",
  permissions: [],
  enabled: true,
};

function listResult(overrides: Partial<AgentPackageListResult> = {}): AgentPackageListResult {
  return {
    packages: [{ ...LOCAL_PACKAGE }],
    catalogAgents: [{ ...LEGACY_AGENT }],
    catalogPackages: [],
    ...overrides,
  };
}

type Handler = (params?: unknown) => unknown;
let handlers: Record<string, Handler> = {};
let listPayload: AgentPackageListResult = listResult();

const rpcMock = vi.mocked(rpcCall);

function stubRpc() {
  rpcMock.mockImplementation(async (method: string, params?: unknown) => {
    const handler = handlers[method];
    if (handler) return handler(params);
    if (method === "agent.packageList") return listPayload;
    if (method === "agent.packageRefresh") return listPayload;
    if (method === "agent.refresh") return { items: [] };
    if (method === "agent.packageInstall") return { ok: true, version: "2.1.0" };
    if (method === "agent.packageSetEnabled") return { ok: true };
    if (method === "agent.setEnabled") return { ok: true };
    if (method === "settings.get") return {};
    if (method === "settings.set") return { ok: true };
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

function callsOf(method: string): unknown[][] {
  return rpcMock.mock.calls.filter(([name]) => name === method);
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

async function flush(turns = 6): Promise<void> {
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

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

beforeEach(() => {
  handlers = {};
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AgentsPlazaPanel（广场签名包）", () => {
  it("未安装签名卡显示名称/简介/版本/大小与下载；legacy 卡不伪造下载", async () => {
    listPayload = listResult({
      catalogPackages: [SIGNED_SUMMARY, MIGRATED_SUMMARY],
      catalogAgents: [
        { ...LEGACY_AGENT },
        {
          ...LEGACY_AGENT,
          name: "legacy-keep",
          displayName: "未迁移的旧助手",
        },
      ],
    });
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    const signed = cardBySlug(view, "signed-pack");
    expect(signed.textContent).toContain("签名广场包");
    expect(signed.textContent).toContain("管理员签名的广场包");
    expect(signed.textContent).toContain("v2.1.0");
    expect(signed.textContent).toContain("2.0 KB");
    expect(signed.textContent).toContain("来自广场");
    expect(buttonLabels(signed)).toEqual(["查看详情", "下载"]);

    // 迁移包标“签名迁移包”，被覆盖的旧目录条目不再重复显示。
    const migrated = cardBySlug(view, "migrated-agent");
    expect(migrated.textContent).toContain("签名迁移包");
    expect(view.textContent).not.toContain("旧目录助手");
    expect(view.querySelector('[data-slug="legacy-agent"]')).toBeNull();

    // 未被签名包覆盖的 legacy 条目保持启停与详情，没有下载。
    const legacy = cardBySlug(view, "legacy-keep");
    expect(legacy.textContent).toContain("公用机");
    expect(buttonLabels(legacy)).toEqual(["查看详情", "关闭"]);
    expect(buttonIn(legacy, "下载")).toBeUndefined();
  });

  it("点击下载调用 packageInstall（带当前摘要版本），成功后提示并重拉", async () => {
    listPayload = listResult({ catalogPackages: [SIGNED_SUMMARY] });
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    await click(buttonIn(cardBySlug(view, "signed-pack"), "下载")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("agent.packageInstall", { slug: "signed-pack", version: "2.1.0" });
    expect(view.textContent).toContain("已下载「签名广场包」v2.1.0");
    expect(callsOf("agent.packageList").length).toBeGreaterThan(1);
  });

  it("撤销/验签/网络失败显示规格中文，卡片保留", async () => {
    listPayload = listResult({ catalogPackages: [SIGNED_SUMMARY] });
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    handlers["agent.packageInstall"] = () => {
      throw new Error("该版本已被管理员撤销：窃取凭据");
    };
    await click(buttonIn(cardBySlug(view, "signed-pack"), "下载")!);
    await flush();
    expect(view.textContent).toContain("该版本已被管理员撤销：窃取凭据");
    expect(view.textContent).toContain("签名广场包");

    handlers["agent.packageInstall"] = () => {
      throw new Error("包校验失败，未安装或未运行。请联系管理员");
    };
    await click(buttonIn(cardBySlug(view, "signed-pack"), "下载")!);
    await flush();
    expect(view.textContent).toContain("包校验失败，未安装或未运行。请联系管理员");

    handlers["agent.packageInstall"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await click(buttonIn(cardBySlug(view, "signed-pack"), "下载")!);
    await flush();
    expect(view.textContent).toContain("目录不可达，请稍后重试；本地智能体不受影响");
    expect(view.textContent).toContain("签名广场包");
  });

  it("未安装签名卡的详情只读摘要，不调用 packageDetail，也不伪造签名", async () => {
    listPayload = listResult({ catalogPackages: [SIGNED_SUMMARY, MIGRATED_SUMMARY] });
    handlers["agent.packageDetail"] = () => {
      throw new Error("智能体「signed-pack」不存在");
    };
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    await click(buttonIn(cardBySlug(view, "signed-pack"), "查看详情")!);
    await flush();

    // 磁盘上没有未安装的包：详情绝不能落进 packageDetail。
    expect(callsOf("agent.packageDetail")).toHaveLength(0);
    expect(view.textContent).toContain("签名广场包");
    expect(view.textContent).toContain("管理员签名的广场包");
    expect(view.textContent).toContain("v2.1.0");
    expect(view.textContent).toContain("包大小 2.0 KB");
    expect(view.textContent).toContain("更新时间：2026-10-20T08:00:00.000Z");
    expect(view.textContent).toContain("安装后可查看签名与文件清单");
    expect(view.textContent).toContain(
      "脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。",
    );
    // 摘要里没有签名事实，不得编造 keyId / 签名时间 / 验签结果。
    expect(view.textContent).not.toContain("keyId");
    expect(view.textContent).not.toContain("验签结果");

    await click(buttonByText(view, "关闭")!);
    await click(buttonIn(cardBySlug(view, "migrated-agent"), "查看详情")!);
    await flush();

    expect(view.textContent).toContain("迁移来源：legacy-agent");
    expect(view.textContent).toContain("包大小 700 B");
    expect(callsOf("agent.packageDetail")).toHaveLength(0);
  });

  it("已安装的签名摘要不再以“下载”卡出现在广场", async () => {
    listPayload = listResult({
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "管理员签名的广场包",
          version: "2.1.0",
          source: "catalog",
          enabled: true,
          publishStatus: "installed",
        },
      ],
      catalogPackages: [SIGNED_SUMMARY],
    });
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    // 宿主把整份目录缓存塞进 catalogPackages：已安装的 slug 必须被剔除，
    // 否则用户会看到一张点“下载”就报“已安装，无需重复安装”的卡。
    expect(view.querySelector('[data-slug="signed-pack"]')).toBeNull();
    expect(buttonByText(view, "下载")).toBeUndefined();
  });

  it("目录条目全部已安装时显示“都已安装”，不误报为未配置", async () => {
    listPayload = listResult({
      packages: [
        {
          slug: "signed-pack",
          displayName: "签名广场包",
          description: "管理员签名的广场包",
          version: "2.1.0",
          source: "catalog",
          enabled: true,
          publishStatus: "installed",
        },
      ],
      catalogAgents: [],
      catalogPackages: [SIGNED_SUMMARY],
    });
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    // 目录已配置且有条目，只是全部已安装；不能显示“请先配置公用机目录”。
    expect(view.querySelector(".panel-empty")?.textContent).toBe("目录中的智能体都已安装。");
  });

  it("本地同名包不再吞掉远端摘要：摘要卡标冲突，只提供详情", async () => {
    listPayload = listResult({
      packages: [{ ...LOCAL_PACKAGE }],
      catalogPackages: [{ ...SIGNED_SUMMARY, slug: "weekly-report", displayName: "广场周报助手" }],
      catalogAgents: [],
    });
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    // 本地同名只表示不能安装，不是“已安装”：签名卡必须可见并讲清冲突。
    const signed = cardBySlug(view, "weekly-report");
    expect(signed.textContent).toContain("广场周报助手");
    expect(signed.textContent).toContain("与本地包同名，无法安装");
    expect(buttonLabels(signed)).toEqual(["查看详情"]);
    expect(buttonIn(signed, "下载")).toBeUndefined();
    expect(view.querySelector(".panel-empty")).toBeNull();
  });

  it("broken legacy 不渲染启用：已启用仍可关闭，未启用只剩详情", async () => {
    listPayload = listResult({
      packages: [],
      catalogAgents: [
        {
          ...LEGACY_AGENT,
          name: "legacy-broken-on",
          broken: { reason: "manifest 无法解析" },
          enabled: true,
        },
        {
          ...LEGACY_AGENT,
          name: "legacy-broken-off",
          displayName: "损坏未启用",
          broken: { reason: "manifest 无法解析" },
          enabled: false,
        },
      ],
      catalogPackages: [],
    });
    const view = await mount(createElement(AgentsPlazaPanel, { search: "", refreshToken: 0 }));

    expect(buttonLabels(cardBySlug(view, "legacy-broken-on"))).toEqual(["查看详情", "关闭"]);
    expect(buttonLabels(cardBySlug(view, "legacy-broken-off"))).toEqual(["查看详情"]);
    expect(buttonByText(view, "启用")).toBeUndefined();
    expect(view.textContent).toContain("已损坏：manifest 无法解析");
  });
});

describe("AgentsView 发布口令与刷新周期", () => {
  it("settings.get 回填发布口令；保存时与 host/port/读口令一起 settings.set", async () => {
    handlers["settings.get"] = () => ({
      agents_host: "10.0.0.5",
      agents_port: 18080,
      agents_catalog_token: "read-token",
      agents_catalog_publish_token: "publish-token",
    });
    const view = await mount(createElement(AgentsView, {}));
    await flush();

    const publishInput = view.querySelector<HTMLInputElement>('input[aria-label="发布口令"]');
    expect(publishInput).not.toBeNull();
    expect(publishInput!.type).toBe("password");
    expect(publishInput!.placeholder).toBe("发布口令（创建者）");
    expect(publishInput!.value).toBe("publish-token");
    expect(view.querySelector<HTMLInputElement>('input[aria-label="访问口令"]')!.value).toBe("read-token");

    await typeInto(publishInput!, "new-publish-token");
    await click(buttonByText(view, "保存配置")!);
    await flush();

    expect(rpcMock).toHaveBeenCalledWith("settings.set", {
      agents_host: "10.0.0.5",
      agents_port: 18080,
      agents_catalog_token: "read-token",
      agents_catalog_publish_token: "new-publish-token",
    });

    // 本页没有 keyring / 私钥 / admin token / 撤销控件。
    expect(view.querySelector('[aria-label*="keyring" i]')).toBeNull();
    expect(view.textContent).not.toContain("私钥");
    expect(view.textContent).not.toContain("admin");
    const labels = [...view.querySelectorAll("button")].map((item) => item.textContent?.trim() ?? "");
    expect(labels.some((label) => /撤销|keyring|私钥/i.test(label))).toBe(false);
  });

  it("进入页面与手动刷新都是先 packageRefresh 再 agent.refresh", async () => {
    const order: string[] = [];
    handlers["agent.packageRefresh"] = () => {
      order.push("agent.packageRefresh");
      return listPayload;
    };
    handlers["agent.refresh"] = () => {
      order.push("agent.refresh");
      return { items: [] };
    };

    const view = await mount(createElement(AgentsView, {}));
    await flush();
    expect(order).toEqual(["agent.packageRefresh", "agent.refresh"]);

    order.length = 0;
    await click(buttonByText(view, "刷新")!);
    await flush();
    expect(order).toEqual(["agent.packageRefresh", "agent.refresh"]);
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);
    expect(callsOf("agent.refresh")).toHaveLength(2);
  });

  it("挂载期间每 60 秒只调 packageRefresh；卸载后不再调用", async () => {
    vi.useFakeTimers();
    await mount(createElement(AgentsView, {}));
    await flush();
    expect(callsOf("agent.packageRefresh")).toHaveLength(1);
    expect(callsOf("agent.refresh")).toHaveLength(1);

    await advance(PACKAGE_REFRESH_INTERVAL_MS - 1_000);
    expect(callsOf("agent.packageRefresh")).toHaveLength(1);

    await advance(1_000);
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);
    // 周期刷新不触发 agent.refresh（legacy 目录由页面动作刷新）。
    expect(callsOf("agent.refresh")).toHaveLength(1);

    await advance(PACKAGE_REFRESH_INTERVAL_MS);
    expect(callsOf("agent.packageRefresh")).toHaveLength(3);

    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await advance(PACKAGE_REFRESH_INTERVAL_MS * 3);
    expect(callsOf("agent.packageRefresh")).toHaveLength(3);
  });

  it("前一轮未结束时跳过本轮，不重叠", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let call = 0;
    handlers["agent.packageRefresh"] = () => {
      call += 1;
      if (call === 2) {
        return new Promise((resolve) => {
          release = () => resolve(listPayload);
        });
      }
      return listPayload;
    };

    await mount(createElement(AgentsView, {}));
    await flush();
    expect(callsOf("agent.packageRefresh")).toHaveLength(1);

    await advance(PACKAGE_REFRESH_INTERVAL_MS);
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);
    // 第二轮还在飞：再过 60 秒也不发起第三轮。
    await advance(PACKAGE_REFRESH_INTERVAL_MS);
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);

    await act(async () => {
      release?.();
    });
    await flush();
    await advance(PACKAGE_REFRESH_INTERVAL_MS);
    expect(callsOf("agent.packageRefresh")).toHaveLength(3);
  });

  it("轮询失败显示网络文案，本地卡仍可用", async () => {
    vi.useFakeTimers();
    let call = 0;
    handlers["agent.packageRefresh"] = () => {
      call += 1;
      if (call === 1) return listPayload;
      throw new TypeError("Failed to fetch");
    };

    const view = await mount(createElement(AgentsView, {}));
    await flush();

    await click(buttonByText(view, "我的智能体")!);
    await flush();
    expect(view.textContent).toContain("周报助手");

    await advance(PACKAGE_REFRESH_INTERVAL_MS);
    expect(view.textContent).toContain("目录不可达，请稍后重试；本地智能体不受影响");
    expect(view.textContent).toContain("周报助手");
    expect(buttonIn(cardBySlug(view, "weekly-report"), "发布")).toBeDefined();
  });

  it("轮询成功后重拉列表：撤销到达后无需用户操作即可见", async () => {
    vi.useFakeTimers();
    const view = await mount(createElement(AgentsView, {}));
    await flush();

    await click(buttonByText(view, "我的智能体")!);
    await flush();
    expect(view.textContent).toContain("周报助手");
    expect(view.textContent).not.toContain("已撤销");

    // 宿主在下一轮 packageRefresh 里应用撤销；此后 packageList 返回带 revoked 的行。
    handlers["agent.packageRefresh"] = () => {
      listPayload = listResult({
        packages: [
          {
            slug: "signed-pack",
            displayName: "签名广场包",
            description: "管理员签名的广场包",
            version: "2.1.0",
            source: "catalog",
            enabled: false,
            publishStatus: "installed",
            revoked: {
              slug: "signed-pack",
              version: "2.1.0",
              reason: "窃取凭据",
              revokedAt: "2026-10-21T00:00:00.000Z",
            },
          },
        ],
      });
      return listPayload;
    };

    await advance(PACKAGE_REFRESH_INTERVAL_MS);

    expect(view.textContent).toContain("已撤销：窃取凭据");
    expect(callsOf("agent.packageList").length).toBeGreaterThan(1);
    // 周期刷新仍只调 packageRefresh，不调 agent.refresh。
    expect(callsOf("agent.refresh")).toHaveLength(1);
  });

  it("周期刷新在飞时手动刷新共享该请求，完成后仍执行 agent.refresh 并反馈", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let call = 0;
    handlers["agent.packageRefresh"] = () => {
      call += 1;
      if (call === 2) {
        return new Promise((resolve) => {
          release = () => resolve(listPayload);
        });
      }
      return listPayload;
    };

    const view = await mount(createElement(AgentsView, {}));
    await flush();
    expect(callsOf("agent.packageRefresh")).toHaveLength(1);
    expect(callsOf("agent.refresh")).toHaveLength(1);

    // 第二轮周期刷新在飞：此时手动刷新不能被“在飞即跳过”吞掉。
    await advance(PACKAGE_REFRESH_INTERVAL_MS);
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);
    expect(callsOf("agent.refresh")).toHaveLength(1);

    await click(buttonByText(view, "刷新")!);
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);
    expect(callsOf("agent.refresh")).toHaveLength(1);

    await act(async () => {
      release?.();
    });
    await flush();

    // 手动刷新等待在飞请求后继续：agent.refresh 与成功反馈都要发生。
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);
    expect(callsOf("agent.refresh")).toHaveLength(2);
    expect(view.textContent).toContain("已刷新智能体目录");
  });

  it("首次刷新在飞时手动刷新共享同一轮请求，只发一次 agent.refresh", async () => {
    vi.useFakeTimers();
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    handlers["agent.packageRefresh"] = () => pending;

    const view = await mount(createElement(AgentsView, {}));
    await flush();
    expect(callsOf("agent.packageRefresh")).toHaveLength(1);

    await click(buttonByText(view, "刷新")!);
    // 手动刷新等待在飞的首次刷新，不另发一轮 packageRefresh。
    expect(callsOf("agent.packageRefresh")).toHaveLength(1);

    await act(async () => {
      release?.(listPayload);
    });
    await flush();

    // 同一轮刷新只产生一次 agent.refresh，并且手动刷新的反馈照常出现。
    expect(
      rpcMock.mock.calls
        .map(([method]) => method)
        .filter((method) => method === "agent.packageRefresh" || method === "agent.refresh"),
    ).toEqual(["agent.packageRefresh", "agent.refresh"]);
    expect(view.textContent).toContain("已刷新智能体目录");
  });

  it("等待在飞刷新时卸载：请求返回后不再调用 agent.refresh", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let call = 0;
    handlers["agent.packageRefresh"] = () => {
      call += 1;
      if (call === 2) {
        return new Promise((resolve) => {
          release = () => resolve(listPayload);
        });
      }
      return listPayload;
    };

    await mount(createElement(AgentsView, {}));
    await flush();
    await advance(PACKAGE_REFRESH_INTERVAL_MS);
    await click(buttonByText(container!, "刷新")!);

    await act(async () => {
      root!.unmount();
    });
    root = undefined;

    await act(async () => {
      release?.();
    });
    await flush();

    // 卸载后既不完成手动刷新的 agent.refresh，也不写回任何状态。
    expect(callsOf("agent.packageRefresh")).toHaveLength(2);
    expect(callsOf("agent.refresh")).toHaveLength(1);
  });
});
