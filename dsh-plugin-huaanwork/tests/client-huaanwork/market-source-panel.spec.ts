// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopMarketProvider } from "../../src/client/desktop-settings-api.ts";
import MarketSourcePanel from "../../src/client-huaanwork/MarketSourcePanel.tsx";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
  pickDirectoryDetailed: vi.fn(),
}));

let currentSettings: {
  requested: DesktopMarketProvider;
  effective: DesktopMarketProvider;
} = {
  requested: "disabled",
  effective: "disabled",
};

let lastRestartUrlValue: string | null = null;
const lastRestartUrl = () => lastRestartUrlValue;

function stubSettingsApi(settings: { requested: DesktopMarketProvider; effective: DesktopMarketProvider }) {
  currentSettings = { ...settings };
}

vi.mock("../../src/client/desktop-settings-api.ts", () => ({
  createDesktopSettingsApi: () => ({
    read: vi.fn(async () => ({
      current: "default",
      profiles: [],
      aa: { requested: false, effective: false },
      market: {
        requested: currentSettings.requested,
        effective: currentSettings.effective,
        legacyDefaulted: false,
      },
      web: {
        localUrl: "http://127.0.0.1:53000",
        lanUrls: [],
        lanState: "inactive",
        lanError: null,
        lanCaFingerprint: null,
        lanCaUrls: [],
      },
    })),
    selectMarket: vi.fn(async (provider: DesktopMarketProvider) => {
      currentSettings.requested = provider;
      return { accepted: true, restartRequired: true };
    }),
    restart: vi.fn(async () => {
      lastRestartUrlValue = "/api/desktop/restart";
    }),
  }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function buttonByText(view: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...view.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
}

async function mountSourcePanel(): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(MarketSourcePanel, {
        state: null,
        stateLoad: "ready",
        stateError: null,
      }),
    );
  });
  await act(async () => {});
  return container;
}

beforeEach(() => {
  lastRestartUrlValue = null;
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

const panelSource = () =>
  readFileSync(
    resolve(import.meta.dirname, "../../src/client-huaanwork/MarketSourcePanel.tsx"),
    "utf8",
  );

describe("MarketSourcePanel copy invariants (D4)", () => {
  it("makes no milestone promise for multi-source management", () => {
    expect(panelSource()).not.toMatch(/将在\s*M\d+\s*提供/u);
    expect(panelSource()).not.toContain("多来源管理将在 M6 提供");
  });

  it("keeps the honest single-trusted-source statement", () => {
    expect(panelSource()).toContain("当前版本仅支持内网单一受信任源");
  });

  it("keeps the disabled block non-interactive", () => {
    expect(panelSource()).toContain('<div className="market-source-disabled" aria-disabled="true">');
  });
});

describe("MarketSourcePanel persistent restart entry (M1)", () => {
  it("keeps a restart trigger whenever the selected source differs from the effective one", async () => {
    stubSettingsApi({ requested: "huaanwork-market", effective: "disabled" });
    const view = await mountSourcePanel();

    const banner = view.querySelector('[data-testid="restart-pending-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("重启");
    const button = buttonByText(banner as HTMLElement, "立即重启");
    expect(button).toBeDefined();
  });

  it("hides the restart entry once the selection takes effect", async () => {
    stubSettingsApi({ requested: "huaanwork-market", effective: "huaanwork-market" });
    const view = await mountSourcePanel();
    expect(view.querySelector('[data-testid="restart-pending-banner"]')).toBeNull();
  });

  it("routes the persistent trigger to /api/desktop/restart, not to the market route", async () => {
    stubSettingsApi({ requested: "huaanwork-market", effective: "disabled" });
    const view = await mountSourcePanel();
    const banner = view.querySelector('[data-testid="restart-pending-banner"]') as HTMLElement;
    await act(async () => { buttonByText(banner, "立即重启")!.click(); });
    expect(lastRestartUrl()).toBe("/api/desktop/restart");
  });
});
