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
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
  pickDirectoryDetailed: vi.fn(),
}));
vi.mock("../../src/client-huaanwork/Settings.tsx", () => ({
  PLUGIN_APPLY_FAIL: "插件应用失败",
  PLUGIN_CONFIRM: "确认安装该插件？",
}));

import { pickDirectoryDetailed } from "../../src/client-huaanwork/api.ts";
import MarketView from "../../src/client-huaanwork/MarketView.tsx";

const ROUTES = {
  state: "/api/huaanwork-market/state",
  catalog: "/api/huaanwork-market/catalog",
  installable: "/api/huaanwork-market/installable",
  installations: "/api/huaanwork-market/installations",
  preview: "/api/huaanwork-market/operations/preview",
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

/** 按 path 分派的 fetch stub：各 route 的应答由各测试注入（闭包可变）。 */
function stubFetch(handlers: Partial<Record<keyof typeof ROUTES, () => Response>>) {
  const calls: Record<string, number> = {};
  const requests: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      const key = (Object.keys(ROUTES) as Array<keyof typeof ROUTES>).find((name) => ROUTES[name] === path);
      calls[path] = (calls[path] ?? 0) + 1;
      requests.push({ path, init });
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
