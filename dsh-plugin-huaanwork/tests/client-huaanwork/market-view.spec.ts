// @vitest-environment jsdom
/**
 * MarketView 组件级 jsdom spec（评审 D13 第 3 项）：旁路独立性（§13 单点缓解）
 * 的回归门——「catalog 502 → 错误面板出现 + 本地 tab 仍渲染」，以及在飞安装
 * 经 /state.executing 的跨挂载自恢复（轮询至完成后刷新列表）。
 *
 * 形态承 tests/client-aa-settings.spec.ts 先例（createRoot + act 挂真实组件）；
 * rpcCall/pickDirectoryDetailed/Settings 常量经 vi.mock 拦截以斩断宿主依赖链。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
  pickDirectoryDetailed: vi.fn(),
}));
vi.mock("../../src/client-huaanwork/Settings.tsx", () => ({
  PLUGIN_APPLY_FAIL: "插件应用失败",
  PLUGIN_CONFIRM: "确认安装该插件？",
}));

import { pickDirectoryDetailed, rpcCall } from "../../src/client-huaanwork/api.ts";
import MarketView from "../../src/client-huaanwork/MarketView.tsx";

const ROUTES = {
  state: "/api/huaanwork-market/state",
  catalog: "/api/huaanwork-market/catalog",
  installable: "/api/huaanwork-market/installable",
  installations: "/api/huaanwork-market/installations",
  preview: "/api/huaanwork-market/operations/preview",
  execute: "/api/huaanwork-market/operations/execute",
  // M6 Task 5.3（P28 接线）：表外既有 route 的第 7 条——「立即重启」打这里，不新增 route。
  requestRestart: "/api/huaanwork-market/desktop/request-restart",
  // M6 Task 5.1：provider 开关走 M5 既有的 Desktop settings route（非新增 route）。
  settings: "/api/desktop/settings",
  marketSelect: "/api/desktop/market/select",
  restart: "/api/desktop/restart",
} as const;

/** 最小 Response 形态（不依赖 undici 全局，jsdom 环境自足）。 */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/**
 * 非 JSON 应答：provider 未启用时 market routes 全部未注册，webserver 的
 * `not-found` / frontend-static fallback 都可能回非 JSON 体——marketFetch 的
 * `json().catch(() => undefined)` 吃掉了它，分类只能靠 .status（D10）。
 */
function nonJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

let lastRestartUrl: string | null = null;
const restartRequestUrl = () => lastRestartUrl;

type StubHandlers = Partial<Record<keyof typeof ROUTES, () => Response>> & {
  desktopSettings?: () => Response;
};

/** 按 path 分派的 fetch stub：各 route 的应答由各测试注入（闭包可变）。 */
function stubFetch(handlers: StubHandlers) {
  const calls: Record<string, number> = {};
  const requests: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      calls[path] = (calls[path] ?? 0) + 1;
      requests.push({ path, init });

      if (path === ROUTES.restart || path === ROUTES.requestRestart) {
        lastRestartUrl = path;
      }

      if (path === ROUTES.settings) {
        if (handlers.desktopSettings !== undefined) return handlers.desktopSettings();
        if (handlers.settings !== undefined) return handlers.settings();
        return nonJsonResponse(404);
      }

      if (path === ROUTES.restart) {
        if (handlers.restart !== undefined) return handlers.restart();
        if (handlers.desktopSettings !== undefined) return jsonResponse(200, { accepted: true });
        return nonJsonResponse(404);
      }

      const key = (Object.keys(ROUTES) as Array<keyof typeof ROUTES>).find((name) => ROUTES[name] === path);
      if (key !== undefined && handlers[key] !== undefined) return handlers[key]!();
      throw new Error(`unexpected market fetch: ${path}`);
    }),
  );
  return {
    calls: (path: string) => calls[path] ?? 0,
    requests,
  };
}

/** 市场源地址（Task 5.1 只读展示断言用）。 */
const MARKET_ORIGIN = "http://market.intra.example:8787";

/** GET /api/huaanwork-market/state 的合法应答（wrapper 自有形态）。 */
function marketStateBody(origin: string = MARKET_ORIGIN) {
  return {
    provider: "huaanwork-market",
    origin,
    executing: false,
    verification: { ready: true, currentKeyId: "ab".repeat(32) },
    catalog: { maxAcceptedRevision: 3 },
    desktopActions: { requestRestart: true },
  };
}

/** 市场侧三条取数的正常应答（来源面板测试的公共背景）。 */
function marketSideHandlers() {
  return {
    catalog: () =>
      jsonResponse(200, {
        schemaVersion: "1.0.0",
        source: {
          sourceRecordId: "huaanwork-intranet",
          providerId: "huaanwork-market",
          adapterId: "huaanwork-market",
          registrationKind: "market",
          fetchedAt: "2026-09-27T00:00:00.000Z",
          finalUrl: MARKET_ORIGIN,
        },
        items: [],
        page: { total: 0 },
      }),
    installable: () => jsonResponse(200, { items: [] }),
    installations: () => jsonResponse(200, { bundles: [] }),
  };
}

/** GET /api/desktop/settings 的合法应答（parseDesktopSettingsView 全量校验通过）。 */
function desktopSettingsBody(market: { requested: string; effective: string; legacyDefaulted: boolean }) {
  return {
    current: "default",
    profiles: [{ name: "default", exists: true, webCapable: true, selectable: true, deletable: false }],
    aa: { requested: false, effective: false },
    market,
    web: {
      localUrl: `http://127.0.0.1:53000/?token=${"a".repeat(43)}`,
      lanUrls: [],
      lanState: "inactive",
      lanError: null,
      lanCaFingerprint: null,
      lanCaUrls: [],
    },
  };
}

/** 来源页签内呈现的 provider 选项（值集合断言用）。 */
function providerValues(view: HTMLDivElement): (string | null)[] {
  return [...view.querySelectorAll("[data-market-provider]")].map((el) => el.getAttribute("data-market-provider"));
}

function optionButton(view: HTMLDivElement, provider: string): HTMLButtonElement {
  const button = view.querySelector(`button[data-market-provider="${provider}"]`);
  if (button === null) throw new Error(`provider option not found: ${provider}`);
  return button as HTMLButtonElement;
}

function buttonByText(view: HTMLDivElement, label: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find((item) => item.textContent === label);
  if (button === undefined) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
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

beforeEach(() => {
  lastRestartUrl = null;
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

describe("MarketView 在飞安装轮询的放弃预算（修复轮 N-4）", () => {
  it("连续失败到预算即放弃观察：清进行中标识、诚实告知、控件不再被永久禁用", async () => {
    vi.useFakeTimers();
    let stateFailing = false;
    const fetchLog = stubFetch({
      state: () =>
        stateFailing
          ? jsonResponse(502, { error: { code: "market-unreachable", message: "connect ECONNREFUSED" } })
          : jsonResponse(200, {
              provider: "huaanwork-market",
              origin: "http://127.0.0.1:8787",
              executing: true,
              verification: { ready: true, currentKeyId: "ab".repeat(32) },
              catalog: { maxAcceptedRevision: 1 },
              desktopActions: { requestRestart: true },
            }),
      catalog: () =>
        jsonResponse(200, {
          schemaVersion: "1.0.0",
          source: {
            sourceRecordId: "huaanwork-intranet",
            providerId: "huaanwork-market",
            adapterId: "huaanwork-market",
            registrationKind: "market",
            fetchedAt: "2026-09-27T00:00:00.000Z",
            finalUrl: "http://127.0.0.1:8787",
          },
          items: [{ id: "alpha", name: "alpha", displayName: "Alpha 助手", summary: "目录条目" }],
          page: { total: 1 },
        }),
      installable: () =>
        jsonResponse(200, {
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

    // 飞行中：进行中标识在场，安装按钮被禁用。
    expect(view.querySelector('[role="status"]')?.textContent).toContain("市场安装正在进行中");
    await act(async () => {
      tabButton(view, "可安装").click();
    });
    const installButton = [...view.querySelectorAll("button")].find(
      (item) => item.textContent === "安装中…",
    ) as HTMLButtonElement | undefined;
    expect(installButton).toBeDefined();
    expect(installButton!.disabled).toBe(true);

    // 市场面开始持续不可读（wrapper bundle 卸载 / 宿主异常）。
    stateFailing = true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }

    // 放弃观察：标识清除、诚实告知「无法确认」（不是「已完成」）、控件恢复可用。
    expect(view.querySelector('[role="status"]')).toBeNull();
    const alert = view.querySelector(".banner.error");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("无法确认市场安装状态");
    expect(alert!.textContent).not.toContain("安装完成");
    const retryButton = [...view.querySelectorAll("button")].find(
      (item) => item.textContent === "安装",
    ) as HTMLButtonElement | undefined;
    expect(retryButton).toBeDefined();
    expect(retryButton!.disabled).toBe(false);

    // 放弃后定时器已卸下：再推两个周期不再读 /state。
    const stateCalls = fetchLog.calls(ROUTES.state);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchLog.calls(ROUTES.state)).toBe(stateCalls);
  });
});

describe("MarketView 已安装列表读失败（P27）", () => {
  it("installations 读失败时不说「尚未安装任何插件」，两个页签同口径", async () => {
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
      catalog: () =>
        jsonResponse(200, {
          schemaVersion: "1.0.0",
          source: {
            sourceRecordId: "huaanwork-intranet",
            providerId: "huaanwork-market",
            adapterId: "huaanwork-market",
            registrationKind: "market",
            fetchedAt: "2026-09-27T00:00:00.000Z",
            finalUrl: "http://127.0.0.1:8787",
          },
          items: [],
          page: { total: 0 },
        }),
      installable: () => jsonResponse(200, { items: [] }),
      // 读失败（不是空目录）：旧实现把它静默降级为 bundles = []。
      installations: () => jsonResponse(500, { error: { code: "plugin-error", message: "boom" } }),
    });

    const view = await mountMarket();

    for (const tab of ["已安装", "本地安装"] as const) {
      await act(async () => {
        tabButton(view, tab).click();
      });
      // 肯定式假话不得出现；诚实文案必须出现。
      expect(view.textContent, tab).not.toContain("尚未安装任何插件");
      expect(view.textContent, tab).toContain("无法读取已安装列表");
      expect(view.textContent, tab).toContain("不代表没有已安装的插件");
    }
  });

  it("读到空列表时才说「尚未安装任何插件」（对照组，防上一条把文案改死）", async () => {
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
      catalog: () =>
        jsonResponse(200, {
          schemaVersion: "1.0.0",
          source: {
            sourceRecordId: "huaanwork-intranet",
            providerId: "huaanwork-market",
            adapterId: "huaanwork-market",
            registrationKind: "market",
            fetchedAt: "2026-09-27T00:00:00.000Z",
            finalUrl: "http://127.0.0.1:8787",
          },
          items: [],
          page: { total: 0 },
        }),
      installable: () => jsonResponse(200, { items: [] }),
      installations: () => jsonResponse(200, { bundles: [] }),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "已安装").click();
    });
    expect(view.textContent).toContain("尚未安装任何插件");
    expect(view.textContent).not.toContain("无法读取已安装列表");
  });
});

describe("MarketView provider 未启用态（D10 + M6 Task 5.1 入口落地）", () => {
  it("全部 market route 404 时给出指向本界面真实入口的 not-registered 指引，并可当场切换来源", async () => {
    // 出厂默认 provider = disabled ⇒ wrapper bundle 未加载 ⇒ 四条 route 全部未注册；
    // 但 Desktop settings route（provider 读/写面）仍注册 ⇒ 来源页签内的开关可用。
    stubFetch({
      state: () => nonJsonResponse(404),
      catalog: () => nonJsonResponse(404),
      installable: () => nonJsonResponse(404),
      installations: () => nonJsonResponse(404),
      settings: () =>
        jsonResponse(200, desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false })),
      marketSelect: () => jsonResponse(202, { accepted: true, restartRequired: true }),
      restart: () => jsonResponse(200, { accepted: true }),
    });

    const view = await mountMarket();

    // 发现页：分类为 not-registered（无 code、仅凭 404），标题即真实状态。
    const discoverPanel = view.querySelector(".market-error");
    expect(discoverPanel).not.toBeNull();
    expect(discoverPanel!.textContent).toContain("插件市场未启用");
    // 入口已落地：文案必须指向真实可达路径（来源页签）与 provider 值；
    // 不得再声称「尚未接入」，也不得给走不通的箭头导航与旁路（R23）。
    expect(discoverPanel!.textContent).toContain("来源");
    expect(discoverPanel!.textContent).toContain("huaanwork-market");
    expect(discoverPanel!.textContent).not.toContain("→");
    expect(discoverPanel!.textContent).not.toContain("尚未接入");
    expect(discoverPanel!.textContent).not.toContain("旁路");

    // D10 后半：来源页签复用同一分类文案，不再只显示「无法读取市场状态」。
    await act(async () => {
      tabButton(view, "来源").click();
    });
    const sourcesPanel = view.querySelector(".market-sources .market-error");
    expect(sourcesPanel).not.toBeNull();
    expect(sourcesPanel!.textContent).toContain("插件市场未启用");
    expect(view.querySelector(".market-sources")!.textContent).not.toContain("无法读取市场状态");
    // 单源裁定的 M6 占位仍在（不因错误态丢失且不可交互）。
    expect(view.querySelector(".market-source-disabled[aria-disabled='true']")).not.toBeNull();

    // 入口就位：来源页签内可直接把 disabled 切到 huaanwork-market（未确认前不落盘）。
    expect(providerValues(view)).toEqual(["disabled", "huaanwork-market"]);
    await act(async () => {
      optionButton(view, "huaanwork-market").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="切换市场来源"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("需要重启");
  });
});

describe("market source panel（M6 Task 5.1：N-1 + P23/P24）", () => {
  it("shows the configured origin read-only", async () => {
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      settings: () =>
        jsonResponse(200, desktopSettingsBody({ requested: "huaanwork-market", effective: "huaanwork-market", legacyDefaulted: false })),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "来源").click();
    });

    const panel = view.querySelector(".market-sources")!;
    expect(panel.textContent).toContain(MARKET_ORIGIN);
    // 只读：来源地址由部署方配置（spec §7.3），面板内不存在任何编辑控件。
    expect(panel.querySelectorAll("input, textarea")).toHaveLength(0);
  });

  it("offers exactly the two provider states this product ships", async () => {
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      settings: () =>
        jsonResponse(200, desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false })),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "来源").click();
    });

    expect(providerValues(view)).toEqual(["disabled", "huaanwork-market"]);
    // 上游 provider 形态（community-market / dsh-market）在内网部署不可达，不得呈现。
    const panelText = view.querySelector(".market-sources")!.textContent!;
    expect(panelText).not.toContain("community");
    expect(panelText).not.toContain("dsh-market");
  });

  it("does not offer multi-source management", async () => {
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      settings: () =>
        jsonResponse(200, desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false })),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "来源").click();
    });

    const panel = view.querySelector(".market-sources")!;
    // 来源管理不暴露给终端用户（spec §7.3）：面板内无任何增删改来源的控件。
    const labels = [...panel.querySelectorAll("button, input, select, textarea")].map(
      (el) => `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""}`,
    );
    expect(labels.some((label) => /添加|新增|编辑|删除/.test(label))).toBe(false);
    // 多来源占位保留且不可交互（Task 6.11 只落骨架）。
    const placeholder = panel.querySelector(".market-source-disabled[aria-disabled='true']")!;
    expect(placeholder).not.toBeNull();
    expect(placeholder.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("requires a restart and says so honestly", async () => {
    const fetchLog = stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      settings: () =>
        jsonResponse(200, desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false })),
      marketSelect: () => jsonResponse(202, { accepted: true, restartRequired: true }),
      restart: () => jsonResponse(200, { accepted: true }),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "来源").click();
    });

    // 切换动作先出确认框（HuaAnWork 自有 overlay 组件，非 DesktopDialogWindow）。
    await act(async () => {
      optionButton(view, "huaanwork-market").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="切换市场来源"]') as HTMLDivElement;
    expect(dialog).not.toBeNull();
    // 文案含「需要重启」与 spec §14 第 33 条诚实措辞（取消重启≠未生效，下次启动照常生效）。
    expect(dialog.textContent).toContain("需要重启");
    expect(dialog.textContent).toContain("下次启动");

    // 未确认前不落盘：Escape 关闭不产生任何写请求。
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(view.querySelector('[role="dialog"][aria-label="切换市场来源"]')).toBeNull();
    expect(fetchLog.calls(ROUTES.marketSelect)).toBe(0);

    // 确认：调 M5 既有的 select route，保存后应用自行重启（controller.scheduleRestart）。
    await act(async () => {
      optionButton(view, "huaanwork-market").click();
    });
    const confirmedDialog = view.querySelector('[role="dialog"][aria-label="切换市场来源"]') as HTMLDivElement;
    await act(async () => {
      buttonByText(confirmedDialog, "保存并重启").click();
    });
    expect(fetchLog.calls(ROUTES.marketSelect)).toBe(1);
    const selectRequest = fetchLog.requests.find((request) => request.path === ROUTES.marketSelect)!;
    expect(JSON.parse(String(selectRequest.init?.body))).toEqual({ provider: "huaanwork-market" });
    // 既有 restart route（/api/desktop/restart）；不新增 route（P28 的表外 route 留给 Task 5.3）。
    expect(fetchLog.calls(ROUTES.restart)).toBe(1);
    expect(fetchLog.requests.some((request) => request.path === "/api/huaanwork-market/desktop/request-restart")).toBe(false);

    // 保存后的诚实状态：选择已保存，取消重启不回滚。
    const saved = confirmedDialog.querySelector('[role="status"]');
    expect(saved).not.toBeNull();
    expect(saved!.textContent).toContain("选择已保存");
    expect(saved!.textContent).toContain("下次启动");
  });

  it("uses the design system palette rather than ghost tokens (P23)", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../src/client-huaanwork/styles.css"), "utf8");
    // --error-border 不在 DESIGN.md 调色板（幽灵 token，靠 fallback 生效）——不得回潮。
    expect(css).not.toContain("--error-border");
    expect(css).toContain("border: 1px solid var(--error)");
  });

  it("follows the repo tab and dialog a11y conventions (P24)", async () => {
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: true, path: "/tmp/alpha.tgz" });
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      installable: () =>
        jsonResponse(200, {
          items: [
            {
              id: "alpha@1.0.0",
              name: "alpha",
              version: "1.0.0",
              sha256: "a".repeat(64),
              size: 42,
              installed: false,
            },
          ],
        }),
      preview: () =>
        jsonResponse(200, {
          name: "alpha",
          version: "1.0.0",
          sha256: "a".repeat(64),
          size: 42,
          tarballUrl: `${MARKET_ORIGIN}/alpha-1.0.0.tgz`,
        }),
      settings: () =>
        jsonResponse(200, desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false })),
    });

    const view = await mountMarket();

    // tab 栏语义（App.tsx/AutomationsView.tsx/Settings.tsx 同惯例）。
    const tablist = view.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const tabs = [...tablist!.querySelectorAll('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.filter((item) => item.getAttribute("aria-selected") === "true")).toHaveLength(1);

    // 本地安装确认框：初始焦点在对话框内，Escape 关闭。
    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });
    const localDialog = view.querySelector('[role="dialog"][aria-label="本地安装确认"]') as HTMLDivElement;
    expect(localDialog).not.toBeNull();
    expect(localDialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      localDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(view.querySelector('[role="dialog"][aria-label="本地安装确认"]')).toBeNull();

    // 安装确认框（preview）：初始焦点在对话框内，Escape 关闭。
    await act(async () => {
      tabButton(view, "可安装").click();
    });
    await act(async () => {
      buttonByText(view, "安装").click();
    });
    const previewDialog = view.querySelector('[role="dialog"][aria-label="安装确认"]') as HTMLDivElement;
    expect(previewDialog).not.toBeNull();
    expect(previewDialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      previewDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(view.querySelector('[role="dialog"][aria-label="安装确认"]')).toBeNull();
  });
});

describe("本地安装的目录选择（D11：darwin 走原生 picker，自由文本兜底保留）", () => {
  /** 受控输入的受信赋值路径：绕过 React 的 value tracker 才能触发 onChange。 */
  function typePath(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("HTMLInputElement value setter unavailable");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function localHandlers() {
    return {
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
    };
  }

  function localDialog(view: HTMLDivElement): HTMLElement | null {
    return view.querySelector('[role="dialog"][aria-label="本地安装确认"]');
  }

  async function openLocalTab(): Promise<HTMLDivElement> {
    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    return view;
  }

  it("picker 可用时优先弹确认框，自由文本兜底不得删除", async () => {
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: true, path: "/tmp/alpha-1.0.0.tgz" });
    stubFetch(localHandlers());

    const view = await openLocalTab();
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });

    const dialog = localDialog(view);
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("/tmp/alpha-1.0.0.tgz");
    expect(view.querySelector('[role="alert"]')).toBeNull();
    // 兜底保留：手输路径输入框始终在场。
    expect(view.querySelector('input[aria-label="本地插件路径"]')).not.toBeNull();
  });

  it("用户取消保持静默；picker 不可用时诚实提示并保留自由文本兜底", async () => {
    stubFetch(localHandlers());
    const view = await openLocalTab();

    // 取消（2xx + path:null）：不弹确认框，也不报错（既有 M4 口径）。
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: true, path: null });
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });
    expect(localDialog(view)).toBeNull();
    expect(view.querySelector('[role="alert"]')).toBeNull();

    // 平台/组合拒绝（非 2xx）：红色提示指路自由文本，且不弹确认框。
    // darwin 已支持 picker（D11），故措辞不再断言「平台不支持」而是「环境未提供」。
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: false, path: null });
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });
    const alert = view.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("当前环境不支持目录选择器");
    expect(alert!.textContent).toContain("路径");
    expect(localDialog(view)).toBeNull();

    // 兜底可用：手输路径仍能进入确认框（picker 失败时的唯一退路）。
    const input = view.querySelector('input[aria-label="本地插件路径"]') as HTMLInputElement;
    await act(async () => {
      typePath(input, "/tmp/beta");
    });
    await act(async () => {
      buttonByText(view, "添加").click();
    });
    const fallbackDialog = localDialog(view);
    expect(fallbackDialog).not.toBeNull();
    expect(fallbackDialog!.textContent).toContain("/tmp/beta");
  });
});

/**
 * M6 Task 5.3（债务 P28）：取消重启后的重启入口。
 *
 * 接线前 `/state` 的 `desktopActions.requestRestart` 与表外
 * `/api/huaanwork-market/desktop/request-restart` 都是客户端死面——用户在重启确认框
 * 点「取消」后，界面没有任何手段再触发重启，只能自己退出应用重开。四条口径：
 * ① 有变更待生效 ⇒ 出现「立即重启」；② 无待生效 ⇒ 不出现；
 * ③ 文案走 spec §14 第 33 条（取消 ≠ 未生效，下次启动照常生效）；
 * ④ 点击打**既有**表外 route（MARKET_ROUTE_PATHS 恒 7 条，不新增 route）。
 */
describe("取消重启后的重启入口（M6 Task 5.3，P28 接线）", () => {
  /** 表外既有 route 的字面路径（routes.ts:59；断言不引用被测常量，避免自证）。 */
  const REQUEST_RESTART_PATH = "/api/huaanwork-market/desktop/request-restart";
  /** addPlugin 取消分支的诚实应答（plugins-host.ts:163）。 */
  const CANCEL_MESSAGE = "已取消重启：插件已写入清单，下次启动时生效";

  const ALPHA_ITEM = {
    id: "alpha@1.0.0",
    name: "alpha",
    version: "1.0.0",
    sha256: "a".repeat(64),
    size: 42,
    installed: false,
  };

  /** 市场侧点击链的背景应答；execute 与其余 route 由各测试注入。 */
  function installHandlers(
    execute: () => Response,
    extra: Partial<Record<keyof typeof ROUTES, () => Response>> = {},
  ) {
    return {
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      installable: () => jsonResponse(200, { items: [ALPHA_ITEM] }),
      preview: () =>
        jsonResponse(200, {
          name: "alpha",
          version: "1.0.0",
          sha256: ALPHA_ITEM.sha256,
          size: ALPHA_ITEM.size,
          tarballUrl: `${MARKET_ORIGIN}/alpha-1.0.0.tgz`,
        }),
      execute,
      ...extra,
    };
  }

  /** 「可安装」页签 → 预览确认 → execute 的完整点击链（取消重启发生在 execute 应答里）。 */
  async function installAlpha(view: HTMLDivElement): Promise<void> {
    await act(async () => {
      tabButton(view, "可安装").click();
    });
    await act(async () => {
      buttonByText(view, "安装").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="安装确认"]') as HTMLDivElement;
    await act(async () => {
      buttonByText(dialog, "安装").click();
    });
  }

  function pendingBanner(view: HTMLElement): HTMLElement {
    const banner = view.querySelector(".market-pending");
    if (banner === null) throw new Error("待生效变更条未出现");
    return banner as HTMLElement;
  }

  function restartButton(view: HTMLElement): HTMLButtonElement | undefined {
    return [...view.querySelectorAll("button")].find((item) => item.textContent === "立即重启") as
      | HTMLButtonElement
      | undefined;
  }

  /**
   * 表外 market route 表（Global Constraint 5：恒 7 条）逐条读出。
   *
   * 直接 import `huaanwork-host/market/routes.ts` 在此 jsdom 环境下不可用：它会
   * 连带加载 `dsh-community-market/contracts`，其 schema 经 `new URL(..., import.meta.url)`
   * 读取，vite 的 `/@fs` 前缀会让该路径落空（实测 ENOENT）⇒ 读源码字面量。
   * 运行时枚举本身由 node 环境的 `tests/huaanwork-host/market-routes.spec.ts` 钉住。
   */
  function marketRoutePaths(): string[] {
    const source = readFileSync(resolve(import.meta.dirname, "../../src/huaanwork-host/market/routes.ts"), "utf8");
    const literal = source.match(/export const MARKET_ROUTE_PATHS = \{([\s\S]*?)\} as const/u);
    if (literal === null) throw new Error("MARKET_ROUTE_PATHS 字面量未找到");
    return [...literal[1]!.matchAll(/:\s*'([^']+)'/gu)].map((match) => match[1]!);
  }

  it("offers an explicit restart action once a change is pending", async () => {
    stubFetch(
      installHandlers(() =>
        jsonResponse(200, { bundles: ["alpha"], restarting: false, message: CANCEL_MESSAGE }),
      ),
    );

    const view = await mountMarket();
    await installAlpha(view);

    // 取消重启 ⇒ 清单已写入、应用未重启：界面必须给出可点的重启入口。
    const banner = pendingBanner(view);
    const button = restartButton(banner);
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
  });

  it("does not offer restart when nothing is pending", async () => {
    const log = stubFetch(installHandlers(() => jsonResponse(200, { bundles: ["alpha"], restarting: true })));

    const view = await mountMarket();
    // 尚未安装任何东西：没有待生效变更 ⇒ 入口不存在。
    expect(view.querySelector(".market-pending")).toBeNull();
    expect(restartButton(view)).toBeUndefined();

    await installAlpha(view);

    // 接受重启的安装（应用随即 relaunch）不留待生效 ⇒ 仍无入口。
    expect(log.calls(ROUTES.execute)).toBe(1);
    expect(view.querySelector(".market-pending")).toBeNull();
    expect(restartButton(view)).toBeUndefined();
  });

  it("states honestly that a cancelled restart still takes effect next launch", async () => {
    stubFetch(
      installHandlers(() =>
        jsonResponse(200, { bundles: ["alpha"], restarting: false, message: CANCEL_MESSAGE }),
      ),
    );

    const view = await mountMarket();
    await installAlpha(view);

    const text = pendingBanner(view).textContent ?? "";
    // spec §14 第 33 条口径（与 plugins-host.ts:163 同句）：取消 ≠ 未生效。
    expect(text).toContain("已取消重启");
    expect(text).toContain("已写入清单，下次启动时生效");
    expect(text).not.toContain("未生效");
    expect(text).not.toContain("已回滚");
  });

  it("calls the existing off-table route rather than a new one", async () => {
    const confirmed = { accepted: false };
    const log = stubFetch(
      installHandlers(
        () => jsonResponse(200, { bundles: ["alpha"], restarting: false, message: CANCEL_MESSAGE }),
        {
          // 表外 route 的取消分支（P3 修复后）回的是无增/删语境的中立句——
          // 它不带安装语境，不得覆盖本横幅的「插件已写入清单」文案。
          requestRestart: () =>
            confirmed.accepted
              ? jsonResponse(200, { restarting: true })
              : jsonResponse(200, { restarting: false, message: "已取消重启：变更已保存，下次启动时生效" }),
        },
      ),
    );

    const view = await mountMarket();
    await installAlpha(view);

    // 第一次点击：用户又取消了 ⇒ 变更仍在待生效，入口与诚实文案原样保留
    //（route 的裸 message 不得把用户看到的话变旧）。
    await act(async () => {
      restartButton(pendingBanner(view))!.click();
    });
    expect(pendingBanner(view).textContent).toContain("已写入清单，下次启动时生效");
    expect(restartButton(view)).toBeDefined();

    // 第二次点击：接受 ⇒ controller 随即 relaunch（jsdom 里只剩中性告知）。
    confirmed.accepted = true;
    await act(async () => {
      restartButton(pendingBanner(view))!.click();
    });
    expect(view.textContent).toContain("正在重启");

    // 只打既有的第 7 条表外 route，且不新增 route（Global Constraint 5）。
    const calls = log.requests.filter((request) => request.path === REQUEST_RESTART_PATH);
    expect(calls).toHaveLength(2);
    expect(calls.every((request) => request.init?.method === "POST")).toBe(true);
    expect(marketRoutePaths()).toHaveLength(7);
    expect(marketRoutePaths()).toContain(REQUEST_RESTART_PATH);
    // 与「来源」页签的 provider 切换流（/api/desktop/restart）互不串线。
    expect(log.calls(ROUTES.restart)).toBe(0);
  });

  it("offers the same affordance for a cancelled local install", async () => {
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: true, path: "/tmp/alpha.tgz" });
    vi.mocked(rpcCall).mockResolvedValue({ bundles: ["alpha"], message: CANCEL_MESSAGE });
    const log = stubFetch({ state: () => jsonResponse(200, marketStateBody()), ...marketSideHandlers() });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="本地安装确认"]') as HTMLDivElement;
    await act(async () => {
      buttonByText(dialog, "安装").click();
    });

    // 同一条判定（addPlugin 的取消应答）同时服务本地路径：入口与诚实文案一致。
    expect(log.calls(ROUTES.installations)).toBeGreaterThan(0);
    expect(pendingBanner(view).textContent).toContain("已写入清单，下次启动时生效");
    expect(restartButton(view)).toBeDefined();
  });

  it("falls back to the desktop restart route when the market bundle is not registered (D5)", async () => {
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: true, path: "/tmp/alpha.tgz" });
    vi.mocked(rpcCall).mockResolvedValue({ bundles: ["alpha"], message: CANCEL_MESSAGE });
    stubFetch({
      state: () => nonJsonResponse(404),
      catalog: () => nonJsonResponse(404),
      installable: () => nonJsonResponse(404),
      installations: () => nonJsonResponse(404),
      desktopSettings: () =>
        jsonResponse(200, desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false })),
      restart: () => jsonResponse(200, { accepted: true }),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="本地安装确认"]') as HTMLDivElement;
    await act(async () => {
      buttonByText(dialog, "安装").click();
    });

    const banner = pendingBanner(view);
    expect(banner.textContent).toContain("已写入清单，下次启动时生效");
    const button = restartButton(banner);
    expect(button).toBeDefined();

    await act(async () => {
      button!.click();
    });
    expect(restartRequestUrl()).toBe(ROUTES.restart);
  });

  it("gives honest manual-restart copy only when both restart channels are gone", async () => {
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: true, path: "/tmp/alpha.tgz" });
    vi.mocked(rpcCall).mockResolvedValue({ bundles: ["alpha"], message: CANCEL_MESSAGE });
    stubFetch({
      state: () => nonJsonResponse(404),
      catalog: () => nonJsonResponse(404),
      installable: () => nonJsonResponse(404),
      installations: () => nonJsonResponse(404),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="本地安装确认"]') as HTMLDivElement;
    await act(async () => {
      buttonByText(dialog, "安装").click();
    });

    const banner = pendingBanner(view);
    expect(banner.textContent).toContain("已写入清单，下次启动时生效");
    expect(restartButton(banner)).toBeUndefined();
    expect(banner.textContent).toContain("本次会话未提供应用内重启入口；请手动退出并重新打开应用以生效。");
  });

  it("contextualises the banner notice for a cancelled remove flow (M1)", async () => {
    vi.mocked(rpcCall).mockResolvedValue({
      bundles: ["@deepseek-ai/dsh-base"],
      message: "已取消重启：插件已从清单移除，下次启动时不再加载",
      restarting: false,
    });
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      installations: () => jsonResponse(200, { bundles: ["alpha"], immutable: [] }),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "已安装").click();
    });
    const removeBtn = buttonByText(view, "移除");
    await act(async () => {
      removeBtn.click();
    });

    const banner = pendingBanner(view);
    expect(banner.textContent).toContain("已取消重启：插件已从清单移除，下次启动时不再加载");
    expect(restartButton(banner)).toBeDefined();
  });
});

/**
 * M26 Task 2（评审 P1-1 / 裁定 N5）：搜索空态文案失实修复。
 *
 * 修复前 `describeMarketPanel` 消费的是**过滤后**长度：原列表非空、搜索无匹配时
 * filtered.length === 0 ⇒ 落入 empty 分支，把「搜索无结果」误报成「目录为空」/
 * 「暂无可安装插件」两句肯定式假话（D4 同款），且误报文案下用户没有任何清空
 * 搜索的出口。修复后须分流「原列表真空」（保留诚实文案）与「过滤后为空」
 * （专属空态 + 清空搜索动作）；空态复用既有 `.panel-empty`（裁定 C2，`market-
 * search-empty` 仅为布局增量修饰类）。
 */
describe("搜索空态（M26 Task 2：P1-1/N5 文案失实修复）", () => {
  const QUERY = "nonexistent-plugin-xyz";

  const CATALOG_ITEM = { id: "alpha", name: "alpha", displayName: "Alpha 助手", summary: "示例摘要" };
  const INSTALLABLE_ITEM = {
    id: "alpha@1.0.0",
    name: "alpha",
    version: "1.0.0",
    displayName: "Alpha 助手",
    summary: "desc",
    sha256: "a".repeat(64),
    size: 42,
    installed: false,
  };

  /** 目录与可安装列表各含一条目的背景应答（原列表非空，过滤后可为空）。 */
  function searchHandlers() {
    return {
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      catalog: () =>
        jsonResponse(200, {
          schemaVersion: "1.0.0",
          source: {
            sourceRecordId: "huaanwork-intranet",
            providerId: "huaanwork-market",
            adapterId: "huaanwork-market",
            registrationKind: "market",
            fetchedAt: "2026-09-27T00:00:00.000Z",
            finalUrl: MARKET_ORIGIN,
          },
          items: [CATALOG_ITEM],
          page: { total: 1 },
        }),
      installable: () => jsonResponse(200, { items: [INSTALLABLE_ITEM] }),
      installations: () => jsonResponse(200, { bundles: [] }),
    };
  }

  /** 受控搜索输入的受信赋值路径（同「本地安装」describe 内 typePath 的口径）。 */
  function typeSearch(view: HTMLDivElement, value: string): void {
    const input = view.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement;
    if (input === null) throw new Error("search input not found");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("HTMLInputElement value setter unavailable");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("发现页：过滤后为空时不再误报「目录为空」，给出专属空态与清空搜索", async () => {
    stubFetch(searchHandlers());
    const view = await mountMarket();
    // 对照：无搜索词时列表正常渲染（原列表非空）。
    expect(view.textContent).toContain("Alpha 助手");

    await act(async () => {
      typeSearch(view, QUERY);
    });

    // N5 负向断言：误报的肯定式假话不得出现。
    expect(view.textContent).not.toContain("目录为空");
    // 专属搜索空态（C2：复用 .panel-empty，market-search-empty 仅为增量修饰类）。
    const empty = view.querySelector(".panel-empty.market-search-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain(`未找到匹配「${QUERY}」的插件`);
    // 清空搜索：清空输入框并恢复完整列表。
    await act(async () => {
      buttonByText(view, "清空搜索").click();
    });
    expect((view.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement).value).toBe("");
    expect(view.textContent).toContain("Alpha 助手");
  });

  it("可安装页：过滤后为空时不再误报「暂无可安装插件」，清空后恢复列表", async () => {
    stubFetch(searchHandlers());
    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "可安装").click();
    });
    expect(view.textContent).toContain("Alpha 助手");

    await act(async () => {
      typeSearch(view, QUERY);
    });

    expect(view.textContent).not.toContain("暂无可安装插件");
    const empty = view.querySelector(".panel-empty.market-search-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain(`未找到匹配「${QUERY}」的插件`);

    await act(async () => {
      buttonByText(view, "清空搜索").click();
    });
    expect(view.textContent).toContain("Alpha 助手");
  });

  it("搜索命中时不触发的空态（对照组：空态只在过滤后为空时出现）", async () => {
    stubFetch(searchHandlers());
    const view = await mountMarket();

    await act(async () => {
      typeSearch(view, "alpha");
    });

    expect(view.querySelector(".panel-empty.market-search-empty")).toBeNull();
    expect(view.textContent).toContain("Alpha 助手");
    expect(view.textContent).not.toContain("目录为空");
  });
});

describe("弹层 window 级 Esc（M26 Task 3，裁定 C1）", () => {
  /** 焦点脱离对话框后向 window 派发 Escape——P24 元素级 onKeyDown 的失效场景。
   * 注：jsdom 下 document.body.focus() 不移动 activeElement（规范把 body 焦点
   * 委派给文档），故 blur 掉当前焦点元素达到同等脱焦效果。 */
  function escapeFromBlurredFocus(): void {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  }

  it("本地安装确认：焦点脱离对话框时 window 派发的 Escape 关闭弹层", async () => {
    vi.mocked(pickDirectoryDetailed).mockResolvedValue({ available: true, path: "/tmp/alpha.tgz" });
    stubFetch({ state: () => jsonResponse(200, marketStateBody()), ...marketSideHandlers() });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    await act(async () => {
      buttonByText(view, "浏览目录…").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="本地安装确认"]');
    expect(dialog).not.toBeNull();

    await act(async () => {
      escapeFromBlurredFocus();
    });
    expect(view.querySelector('[role="dialog"][aria-label="本地安装确认"]')).toBeNull();
  });

  it("安装确认（preview）：焦点脱离对话框时 window 派发的 Escape 关闭弹层", async () => {
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      installable: () =>
        jsonResponse(200, {
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
      preview: () =>
        jsonResponse(200, {
          name: "alpha",
          version: "1.0.0",
          sha256: "a".repeat(64),
          size: 42,
          tarballUrl: `${MARKET_ORIGIN}/alpha-1.0.0.tgz`,
        }),
    });

    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "可安装").click();
    });
    await act(async () => {
      buttonByText(view, "安装").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="安装确认"]');
    expect(dialog).not.toBeNull();

    await act(async () => {
      escapeFromBlurredFocus();
    });
    expect(view.querySelector('[role="dialog"][aria-label="安装确认"]')).toBeNull();
  });
});

describe("错误面板重试入口（M26 Task 3，评审 N1）", () => {
  /** 目录/可安装 502（内网宕机口径）+ 其余 route 正常的背景应答。 */
  function failingCatalogHandlers() {
    return {
      state: () => jsonResponse(200, marketStateBody()),
      catalog: () => jsonResponse(502, { error: { code: "market-unreachable", message: "connect ECONNREFUSED" } }),
      installable: () => jsonResponse(502, { error: { code: "market-unreachable", message: "connect ECONNREFUSED" } }),
      installations: () => jsonResponse(200, { bundles: [] }),
    };
  }

  it("目录拉取失败时错误面板渲染重试按钮，点击重新发起底层拉取", async () => {
    const log = stubFetch(failingCatalogHandlers());
    const view = await mountMarket();

    // 错误面板内必须存在重试按钮（评审前 ErrorPanel 零重试入口）。
    const panel = view.querySelector(".market-error") as HTMLDivElement;
    expect(panel).not.toBeNull();
    const retryButton = buttonByText(panel, "重试");
    const callsBefore = log.calls(ROUTES.catalog);

    await act(async () => {
      retryButton.click();
    });
    // 断言落在底层 fetch 计数上：点击必须真正重新发起目录拉取。
    expect(log.calls(ROUTES.catalog)).toBe(callsBefore + 1);
  });

  it("300ms 内连点两次重试只发起一次底层拉取（500ms 防抖）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    const log = stubFetch(failingCatalogHandlers());
    const view = await mountMarket();

    const retryButton = buttonByText(view.querySelector(".market-error") as HTMLDivElement, "重试");
    const callsBefore = log.calls(ROUTES.catalog);

    await act(async () => {
      retryButton.click();
    });
    // 第一次点击的拉取在假时钟下同步落定（fetch stub 立即 resolve），
    // 按钮恢复可点——第二次点击必须靠防抖（而非 disabled）被吞掉。
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      retryButton.click();
    });
    await act(async () => {});
    expect(log.calls(ROUTES.catalog)).toBe(callsBefore + 1);
  });
});

/**
 * M6 Task 6.10（债务 P26）：IMMUTABLE bundle 的移除按钮灰化。
 *
 * 「已安装」与「本地安装」两个页签渲染的是同一份 host profile 清单，卸载也都走
 * 同一条 `plugin.remove` RPC；而 host 的 IMMUTABLE_BUNDLES（plugins-host.ts:42-48）
 * 对随应用/市场分发的 bundle（`@deepseek-ai/dsh-base`、`dsh-web-app`、
 * `dsh-desktop-app`、`dsh-community-market`、`huaanwork-market`）恒拒绝——失败
 * 信息诚实，但按钮本应灰化并说明原因。
 *
 * 名单**不得**在客户端复制（第二真相源会随 host 增删漂移）：不可移除信息随
 * installations 应答的 `immutable` 字段下发，客户端只渲染 host 的判定。
 */
describe("IMMUTABLE bundle 的移除按钮灰化（M6 Task 6.10，P26）", () => {
  /**
   * brief/AGENTS.md 的名单把两个包写成 `dsh-web-app` / `dsh-desktop-app`，而
   * profile 清单与 host 集合里的真实条目是带 scope 的 `@deepseek-ai/dsh-web-app`
   * （app-boot `profile.ts:140` 的 web 模板）与 `@deepseek-ai/dsh-desktop-app`
   * （plugins-host.ts:49-55）。此处按**真实应答形态**注入（测试输入，模拟 host），
   * 不是被测代码的名单——客户端源码里出现这些名字由下面的源码扫描用例钉死。
   */
  const IMMUTABLE_NAMES = [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@deepseek-ai/dsh-desktop-app",
    "dsh-community-market",
    "huaanwork-market",
  ];
  /** 源码扫描的禁用字面量：真实名 + brief 简写（硬编码者可能用任一写法）。 */
  const FORBIDDEN_LITERALS = [...IMMUTABLE_NAMES, "dsh-web-app", "dsh-desktop-app"];
  const USER_BUNDLE = "@huaanwork/sample";
  const REASON_PATTERN = /随应用分发/;

  /** 市场侧背景应答 + 带 `immutable` 字段的 installations 应答（P26 的下发通道）。 */
  function immutableHandlers(bundles: string[], immutable: string[] = IMMUTABLE_NAMES) {
    return {
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      installations: () => jsonResponse(200, { bundles, immutable }),
    };
  }

  /** 按包名定位列表项内的移除控件（installed 与 local 两个页签列表同构）。 */
  function removeButtonFor(view: HTMLDivElement, name: string): HTMLButtonElement {
    const item = [...view.querySelectorAll(".market-item")].find(
      (el) => el.querySelector(".recent-title")?.textContent === name,
    );
    if (item === undefined) throw new Error(`bundle item not found: ${name}`);
    const button = item.querySelector("button");
    if (button === null) throw new Error(`remove control not found: ${name}`);
    return button as HTMLButtonElement;
  }

  /** 可访问说明：`title` 与 `aria-describedby` 指向文本的并集（两者任一可承载）。 */
  function removeExplanation(view: HTMLDivElement, button: HTMLButtonElement): string {
    const ids = (button.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter((id) => id !== "");
    const described = ids.map((id) => view.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
    return `${button.getAttribute("title") ?? ""} ${described}`.trim();
  }

  async function openTab(label: "已安装" | "本地安装"): Promise<HTMLDivElement> {
    const view = await mountMarket();
    await act(async () => {
      tabButton(view, label).click();
    });
    return view;
  }

  it.each(IMMUTABLE_NAMES)("disables the remove control for %s with an accessible explanation", async (name) => {
    stubFetch(immutableHandlers([name]));

    const view = await openTab("已安装");
    const button = removeButtonFor(view, name);

    // 灰化：按钮不可点，而不是点了必然失败。
    expect(button.disabled).toBe(true);
    // 说明必须可访问且说真话（为何不可移除：随应用分发的载体）。
    const explanation = removeExplanation(view, button);
    expect(explanation).toMatch(REASON_PATTERN);
    expect(explanation).toContain("不能移除");
  });

  it("keeps remove enabled for a user-installed bundle", async () => {
    stubFetch(immutableHandlers([...IMMUTABLE_NAMES, USER_BUNDLE]));

    const view = await openTab("已安装");
    const userButton = removeButtonFor(view, USER_BUNDLE);
    expect(userButton.disabled).toBe(false);
    expect(removeExplanation(view, userButton)).not.toMatch(REASON_PATTERN);
    // 同一条列表里，hybrid 名单只灰化 host 标注的那些。
    expect(removeButtonFor(view, IMMUTABLE_NAMES[0]!).disabled).toBe(true);
  });

  it("greys out the same bundles in the local tab (same list, same remove path)", async () => {
    stubFetch(immutableHandlers([...IMMUTABLE_NAMES, USER_BUNDLE]));

    const view = await openTab("本地安装");
    for (const name of IMMUTABLE_NAMES) {
      const button = removeButtonFor(view, name);
      expect(button.disabled, name).toBe(true);
      expect(removeExplanation(view, button), name).toContain("不能移除");
    }
    expect(removeButtonFor(view, USER_BUNDLE).disabled).toBe(false);
  });

  it("reads the immutable set from the host rather than duplicating it", async () => {
    // ① host 标注的、客户端无从知晓的将来 carrier 同样灰化；
    // ② host 未标注时不擅自套用任何内置名单（旧 wrapper 应答的诚实降级：
    //    与修复前一致——按钮可点、host 拒绝时给诚实的失败信息）。
    const futureCarrier = "@deepseek-ai/dsh-future-carrier";
    stubFetch(immutableHandlers([futureCarrier, IMMUTABLE_NAMES[0]!], [futureCarrier]));

    const view = await openTab("已安装");
    expect(removeButtonFor(view, futureCarrier).disabled).toBe(true);
    expect(removeButtonFor(view, IMMUTABLE_NAMES[0]!).disabled).toBe(false);
  });

  it("does not liter-copy the immutable names into the client sources", () => {
    // 唯一真相源 = host 的 IMMUTABLE_BUNDLES（plugins-host.ts:42-48）；客户端把
    // 整份名单抄进来即第二真相源，host 加一个 bundle 客户端就漂移。
    // 只查引号紧邻名字的字面量：route 路径（`/api/...`）与注释里的提及不是名单。
    for (const file of ["MarketView.tsx", "logic/market.ts"]) {
      const source = readFileSync(resolve(import.meta.dirname, `../../src/client-huaanwork/${file}`), "utf8");
      for (const name of FORBIDDEN_LITERALS) {
        expect(source, `${file} 不得出现名单字面量 ${name}`).not.toContain(`"${name}"`);
        expect(source, `${file} 不得出现名单字面量 ${name}`).not.toContain(`'${name}'`);
        expect(source, `${file} 不得出现名单字面量 ${name}`).not.toContain(`\`${name}\``);
      }
    }
    // 正向钉（防止上一条因「两边都没提」而空过）：渲染读的是应答字段。
    const market = readFileSync(resolve(import.meta.dirname, "../../src/client-huaanwork/MarketView.tsx"), "utf8");
    expect(market).toContain("immutable");
  });
});

/** P3-1：两处列表空态（不是搜索空态）补上的指路句。 */
const INSTALLED_LIST_EMPTY = "尚未安装任何插件。请到「本地安装」页签，从本地目录或 .tgz 安装。";
const INSTALLABLE_LIST_EMPTY = "暂无可安装插件。请到「本地安装」页签，从本地目录或 .tgz 安装。";

describe("M26 residual P2-3 removeBundle 在飞守卫", () => {
  it("双发 plugin.remove 仅一次生效，不靠按钮 disabled", async () => {
    let releaseRemove = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const removed: unknown[] = [];
    vi.mocked(rpcCall).mockImplementation(async (method, params) => {
      if (method !== "plugin.remove") return {};
      removed.push(params);
      await gate;
      return { bundles: ["@huaanwork/sample"] };
    });

    try {
      stubFetch({
        state: () => jsonResponse(200, marketStateBody()),
        ...marketSideHandlers(),
        installations: () => jsonResponse(200, { bundles: ["@huaanwork/sample"], immutable: [] }),
      });
      const view = await mountMarket();
      await act(async () => {
        tabButton(view, "已安装").click();
      });
      const button = buttonByText(view, "移除");
      expect(button.disabled).toBe(false);

      // 两次点击落在同一次 act 里：重渲染前按钮 disabled 还挡不住第二次。
      await act(async () => {
        button.click();
        button.click();
      });
      expect(removed, "重渲染前的双击").toHaveLength(1);

      // 即使把 disabled 点亮，函数体仍须自己早退。
      button.disabled = false;
      await act(async () => {
        button.click();
      });
      expect(removed, "点亮按钮后的再次点击").toHaveLength(1);

      releaseRemove();
      await act(async () => {});
      const again = buttonByText(view, "移除");
      expect(again.disabled).toBe(false);
      await act(async () => {
        again.click();
      });
      expect(removed, "在飞结束后可以再次移除").toHaveLength(2);
    } finally {
      releaseRemove();
      vi.mocked(rpcCall).mockReset();
    }
  });
});

describe("M26 residual P3-1 列表空态指路", () => {
  it("可安装列表真空时指路「本地安装」页签，且不是搜索空态", async () => {
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
    });
    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "可安装").click();
    });
    const empty = view.querySelector(".panel-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe(INSTALLABLE_LIST_EMPTY);
    expect(view.querySelector(".market-search-empty")).toBeNull();
    expect(view.textContent).not.toContain("清空搜索");
  });

  it("已安装列表真空时指路「本地安装」页签，本地页签同句", async () => {
    stubFetch({
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
    });
    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "已安装").click();
    });
    const installed = view.querySelector(".panel-empty");
    expect(installed).not.toBeNull();
    expect(installed!.textContent).toBe(INSTALLED_LIST_EMPTY);

    await act(async () => {
      tabButton(view, "本地安装").click();
    });
    const local = view.querySelector(".market-local .panel-empty");
    expect(local).not.toBeNull();
    expect(local!.textContent).toBe(INSTALLED_LIST_EMPTY);
  });
});

describe("M26 residual P3-2 确认条圆角 token", () => {
  function sourceHandlers(extra: StubHandlers): StubHandlers {
    return {
      state: () => jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      settings: () =>
        jsonResponse(
          200,
          desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false }),
        ),
      ...extra,
    };
  }

  async function saveSwitch(): Promise<HTMLDivElement> {
    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "来源").click();
    });
    await act(async () => {
      optionButton(view, "huaanwork-market").click();
    });
    const dialog = view.querySelector('[role="dialog"][aria-label="切换市场来源"]') as HTMLDivElement;
    expect(dialog).not.toBeNull();
    await act(async () => {
      buttonByText(dialog, "保存并重启").click();
    });
    return dialog;
  }

  function expectRadiusToken(banner: Element | null) {
    expect(banner).not.toBeNull();
    expect((banner as HTMLElement).style.borderRadius).toBe("var(--radius-md)");
  }

  it("保存成功条使用圆角 token，不再写死 8", async () => {
    stubFetch(sourceHandlers({
      marketSelect: () => jsonResponse(202, { accepted: true, restartRequired: true }),
      restart: () => jsonResponse(200, { accepted: true }),
    }));
    const dialog = await saveSwitch();
    const banner = dialog.querySelector('[role="status"]');
    expect(banner?.textContent).toContain("选择已保存");
    expectRadiusToken(banner);
  });

  it("保存后重启失败条使用圆角 token，不再写死 8", async () => {
    stubFetch(sourceHandlers({
      marketSelect: () => jsonResponse(202, { accepted: true, restartRequired: true }),
      restart: () => jsonResponse(500, { accepted: false }),
    }));
    const dialog = await saveSwitch();
    const banner = dialog.querySelector('[role="alert"]');
    expect(banner?.textContent).toContain("重启请求未成功");
    expectRadiusToken(banner);
  });

  it("切换未保存条使用圆角 token，不再写死 8", async () => {
    stubFetch(sourceHandlers({
      marketSelect: () => jsonResponse(500, { accepted: false }),
    }));
    const dialog = await saveSwitch();
    const banner = dialog.querySelector('[role="alert"]');
    expect(banner?.textContent).toContain("切换未保存");
    expectRadiusToken(banner);
  });
});

function cssBlock(css: string, header: string): string | null {
  const start = css.indexOf(header);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

describe("M26 residual P3-3 字阶", () => {
  it("market-state-hint 与 market-version 离开 12px，对齐字阶", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../src/client-huaanwork/styles.css"), "utf8");
    const hint = cssBlock(css, ".market-state-hint {");
    const version = cssBlock(css, ".market-version {");
    expect(hint).not.toBeNull();
    expect(version).not.toBeNull();
    expect(hint).toContain("font-size: 11px;");
    expect(version).toContain("font-size: 12.5px;");
    expect(hint).not.toContain("font-size: 12px;");
    expect(version).not.toContain("font-size: 12px;");
  });
});

describe("M26 residual P3-4 provider focus ring", () => {
  it("market-provider-option 有显式 focus-visible ring", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../src/client-huaanwork/styles.css"), "utf8");
    const block = cssBlock(css, ".market-provider-option:focus-visible {");
    expect(block).not.toBeNull();
    expect(block).toContain("border-color: var(--accent);");
    expect(block).toContain("box-shadow: 0 0 0 3px var(--accent-soft);");
  });
});

describe("M26 residual onRetry 来源状态错误面板", () => {
  it("来源页 stateError 的错误面板有重试，点击会重新读取市场状态", async () => {
    let stateFails = true;
    const log = stubFetch({
      state: () =>
        stateFails
          ? jsonResponse(502, { error: { code: "market-unreachable", message: "down" } })
          : jsonResponse(200, marketStateBody()),
      ...marketSideHandlers(),
      settings: () =>
        jsonResponse(
          200,
          desktopSettingsBody({ requested: "disabled", effective: "disabled", legacyDefaulted: false }),
        ),
    });
    const view = await mountMarket();
    await act(async () => {
      tabButton(view, "来源").click();
    });

    const panel = view.querySelector(".market-sources .market-error");
    expect(panel).not.toBeNull();
    const labels = [...panel!.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toContain("重试");

    const before = log.calls(ROUTES.state);
    stateFails = false;
    const retry = [...panel!.querySelectorAll("button")].find((button) => button.textContent === "重试");
    await act(async () => {
      retry!.click();
    });
    expect(log.calls(ROUTES.state)).toBe(before + 1);
    expect(view.querySelector(".market-sources .market-error")).toBeNull();
    expect(view.textContent).toContain(MARKET_ORIGIN);
  });
});
