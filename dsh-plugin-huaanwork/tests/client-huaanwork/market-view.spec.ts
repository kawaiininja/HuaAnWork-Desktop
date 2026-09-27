// @vitest-environment jsdom
/**
 * MarketView 组件级 jsdom spec（评审 D13 第 3 项）：旁路独立性（§13 单点缓解）
 * 的回归门——「catalog 502 → 错误面板出现 + 本地 tab 仍渲染」，以及在飞安装
 * 经 /state.executing 的跨挂载自恢复（轮询至完成后刷新列表）。
 *
 * 形态承 tests/client-aa-settings.spec.ts 先例（createRoot + act 挂真实组件）；
 * rpcCall/pickDirectoryDetailed/Settings 常量经 vi.mock 拦截以斩断宿主依赖链。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
  pickDirectoryDetailed: vi.fn(),
}));
vi.mock("../../src/client-huaanwork/Settings.tsx", () => ({
  PLUGIN_APPLY_FAIL: "插件应用失败",
  PLUGIN_CONFIRM: "确认安装该插件？",
}));

import MarketView from "../../src/client-huaanwork/MarketView.tsx";

const ROUTES = {
  state: "/api/huaanwork-market/state",
  catalog: "/api/huaanwork-market/catalog",
  installable: "/api/huaanwork-market/installable",
  installations: "/api/huaanwork-market/installations",
} as const;

/** 最小 Response 形态（不依赖 undici 全局，jsdom 环境自足）。 */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** 按 path 分派的 fetch stub：各 route 的应答由各测试注入（闭包可变）。 */
function stubFetch(handlers: Partial<Record<keyof typeof ROUTES, () => Response>>) {
  const calls: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      const key = (Object.keys(ROUTES) as Array<keyof typeof ROUTES>).find((name) => ROUTES[name] === path);
      calls[path] = (calls[path] ?? 0) + 1;
      if (key !== undefined && handlers[key] !== undefined) return handlers[key]!();
      throw new Error(`unexpected market fetch: ${path}`);
    }),
  );
  return {
    calls: (path: string) => calls[path] ?? 0,
  };
}

async function mountMarket(): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(MarketView));
  });
  return container;
}

function tabButton(view: HTMLDivElement, label: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find((item) => item.textContent === label);
  if (button === undefined) throw new Error(`tab button not found: ${label}`);
  return button as HTMLButtonElement;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MarketView 内网宕机降级（D13，spec §13 单点缓解）", () => {
  it("catalog 502 时发现面板显示错误面板，本地 tab 仍完整渲染（旁路独立）", async () => {
    // wrapper /state 是本地事实（不触网）：宕机时仍 200——与 routes.ts handleState 行为一致。
    stubFetch({
      state: () =>
        jsonResponse(200, {
          provider: "huaanwork-market",
          origin: "http://127.0.0.1:8787",
          executing: false,
          verification: { ready: true, currentKeyId: "ab".repeat(32) },
          catalog: { maxAcceptedRevision: 1 },
          desktopActions: { requestRestart: true },
        }),
      catalog: () => jsonResponse(502, { error: { code: "market-unreachable", message: "connect ECONNREFUSED" } }),
      installable: () => jsonResponse(502, { error: { code: "market-unreachable", message: "connect ECONNREFUSED" } }),
      installations: () => jsonResponse(200, { bundles: ["@deepseek-ai/dsh-base"] }),
    });

    const view = await mountMarket();

    // 三条取数互不阻塞：catalog/installable 双双 error，错误面板出现且给本地安装旁路指引。
    const errorPanel = view.querySelector(".market-error");
    expect(errorPanel).not.toBeNull();
    expect(errorPanel!.getAttribute("role")).toBe("alert");
    expect(errorPanel!.textContent).toContain("内网市场不可达");
    expect(errorPanel!.textContent).toContain("本地安装");

    // 切到本地 tab：面板完整渲染（.market-local），已装列表来自 installations 取数，
    // 旁路面板不依赖 catalogLoad（tab === "local" 分支完全不读目录态）。
    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    expect(view.querySelector(".market-local")).not.toBeNull();
    expect(view.querySelector('input[aria-label="本地插件路径"]')).not.toBeNull();
    expect(view.textContent).toContain("@deepseek-ai/dsh-base");
    // 同一时刻仅当前 tab 渲染：local tab 下远程错误面板不在场。
    expect(view.querySelector(".market-error")).toBeNull();

    // 切回发现 tab：错误面板仍在（错误态不被 tab 切换吞掉）。
    await act(async () => {
      tabButton(view, "发现").click();
    });
    expect(view.querySelector(".market-error")).not.toBeNull();
  });

  it("挂载读到 executing=true 时显示进行中标识，轮询至 false 后自动清并刷新目录", async () => {
    vi.useFakeTimers();
    const inFlight = { executing: true };
    const fetchLog = stubFetch({
      // 恢复前目录侧 502（飞行中目录暂不可读），完成后 200——恢复路径的完整闭环。
      state: () =>
        jsonResponse(200, {
          provider: "huaanwork-market",
          origin: "http://127.0.0.1:8787",
          executing: inFlight.executing,
          verification: { ready: true, currentKeyId: "ab".repeat(32) },
          catalog: { maxAcceptedRevision: 1 },
          desktopActions: { requestRestart: true },
        }),
      catalog: () =>
        inFlight.executing
          ? jsonResponse(502, { error: { code: "market-unreachable", message: "in-flight" } })
          : jsonResponse(200, {
              schemaVersion: "1.0.0",
              source: {
                sourceRecordId: "huaanwork-intranet",
                providerId: "huaanwork-market",
                adapterId: "huaanwork-market",
                registrationKind: "market",
                fetchedAt: "2026-09-27T00:00:00.000Z",
                finalUrl: "http://127.0.0.1:8787",
              },
              items: [{ id: "alpha", name: "alpha", displayName: "Alpha 助手", summary: "降级恢复后的目录条目" }],
              page: { total: 1 },
            }),
      installable: () =>
        inFlight.executing
          ? jsonResponse(502, { error: { code: "market-unreachable", message: "in-flight" } })
          : jsonResponse(200, {
              items: [
                {
                  id: "alpha@1.0.0",
                  name: "alpha",
                  version: "1.0.0",
                  displayName: "Alpha 助手",
                  summary: "desc",
                  sha256: "a".repeat(64),
                  size: 42,
                  installed: false,
                },
              ],
            }),
      installations: () => jsonResponse(200, { bundles: [] }),
    });

    const view = await mountMarket();

    // 挂载发现飞行中（D13：切 view 卸载后回来仍可见）：进行中标识 + 错误面板并存，
    // 目录侧仅初次拉取（轮询不重复打 catalog）。
    expect(view.querySelector('[role="status"]')?.textContent).toContain("市场安装正在进行中");
    expect(view.querySelector(".market-error")).not.toBeNull();
    expect(fetchLog.calls(ROUTES.catalog)).toBe(1);

    // 服务端飞行结束 → 2s 轮询发现 false → 标识清除 + 目录/已装列表刷新 + 错误面板消失。
    inFlight.executing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(view.querySelector('[role="status"]')).toBeNull();
    expect(fetchLog.calls(ROUTES.state)).toBeGreaterThanOrEqual(2);
    expect(fetchLog.calls(ROUTES.catalog)).toBe(2);
    expect(view.querySelector(".market-error")).toBeNull();
    expect(view.textContent).toContain("降级恢复后的目录条目");

    // 轮询停稳：再推两个周期，state 不再被读（定时器已随 remoteExecuting=false 卸下）。
    const settledStateCalls = fetchLog.calls(ROUTES.state);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchLog.calls(ROUTES.state)).toBe(settledStateCalls);
  });
});
