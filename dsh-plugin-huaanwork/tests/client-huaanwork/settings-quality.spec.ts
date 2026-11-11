// @vitest-environment jsdom
/**
 * 设置「质检」页(2026-11-10 UI 调整):公用机配置从智能体页迁入设置,
 * 导航位于「模型」与「权限」之间;字段、校验与 settings.set 形状与原配置栏一致。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({ rpcCall: vi.fn() }));

import { rpcCall } from "../../src/client-huaanwork/api.ts";
import Settings, { type SettingsSection } from "../../src/client-huaanwork/Settings.tsx";

const rpc = vi.mocked(rpcCall);

const QUALITY_SETTINGS = {
  models: [],
  active_model_id: "",
  allow_network: false,
  keep_awake: true,
  max_concurrent_turns: 3,
  agents_host: "10.0.0.5",
  agents_port: 18080,
  agents_catalog_token: "read-token",
  agents_catalog_publish_token: "publish-token",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mountSettings(
  section: SettingsSection,
  onAgentsConfigSaved?: () => void,
): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Settings, {
        onClose: () => undefined,
        section,
        onSectionChange: () => undefined,
        theme: "system",
        onThemeChange: async () => undefined,
        username: "tester",
        onChangePassword: async () => undefined,
        keepAwakeUnavailable: false,
        onAgentsConfigSaved,
      }),
    );
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

function inputByLabel(view: ParentNode, label: string): HTMLInputElement {
  const input = view.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`input not found: ${label}`);
  return input;
}

function buttonByText(view: ParentNode, label: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
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

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (method: string) => {
    if (method === "settings.get") return { ...QUALITY_SETTINGS };
    if (method === "settings.set") return { ok: true };
    return {};
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

describe("设置导航", () => {
  it("「质检」位于「模型」与「权限」之间,既有分组全部保留", async () => {
    const view = await mountSettings("model");
    const navButtons = [...view.querySelectorAll(".settings-nav button")];
    const labels = navButtons.map((button) => button.textContent ?? "");
    expect(navButtons).toHaveLength(5);
    const index = (label: string) => labels.findIndex((text) => text.includes(label));
    expect(index("账户")).toBeGreaterThanOrEqual(0);
    expect(index("外观")).toBeGreaterThan(index("账户"));
    expect(index("模型")).toBeGreaterThan(index("外观"));
    expect(index("质检")).toBeGreaterThan(index("模型"));
    expect(index("权限")).toBeGreaterThan(index("质检"));
  });
});

describe("设置「质检」页公用机配置", () => {
  it("settings.get 回填地址/端口/访问口令/发布口令四字段", async () => {
    const view = await mountSettings("quality");
    await flush();

    expect(inputByLabel(view, "公用机地址").value).toBe("10.0.0.5");
    expect(inputByLabel(view, "公用机地址").placeholder).toBe("公用机地址，如 192.168.1.10");
    expect(inputByLabel(view, "端口").value).toBe("18080");
    expect(inputByLabel(view, "端口").placeholder).toBe("端口，如 18080");
    const readToken = inputByLabel(view, "访问口令");
    expect(readToken.type).toBe("password");
    expect(readToken.value).toBe("read-token");
    const publishToken = inputByLabel(view, "发布口令");
    expect(publishToken.type).toBe("password");
    expect(publishToken.placeholder).toBe("发布口令（创建者）");
    expect(publishToken.value).toBe("publish-token");
  });

  it("保存时四字段一起 settings.set,给出反馈并通知 App 刷新智能体页", async () => {
    const onSaved = vi.fn();
    const view = await mountSettings("quality", onSaved);
    await flush();

    await typeInto(inputByLabel(view, "发布口令"), "new-publish-token");
    await click(buttonByText(view, "保存配置"));
    await flush();

    expect(rpc).toHaveBeenCalledWith("settings.set", {
      agents_host: "10.0.0.5",
      agents_port: 18080,
      agents_catalog_token: "read-token",
      agents_catalog_publish_token: "new-publish-token",
    });
    expect(view.textContent).toContain("已保存公用机配置");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("本地校验失败(端口非法)时不发 settings.set,逐字段展示错误", async () => {
    const onSaved = vi.fn();
    const view = await mountSettings("quality", onSaved);
    await flush();

    await typeInto(inputByLabel(view, "端口"), "abc");
    await click(buttonByText(view, "保存配置"));
    await flush();

    expect(view.textContent).toContain("端口必须是 1–65535 的整数");
    expect(rpc.mock.calls.some(([method]) => method === "settings.set")).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("宿主返回 ok:false + fieldErrors 时按字段展示,不通知 App", async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === "settings.get") return { ...QUALITY_SETTINGS };
      if (method === "settings.set") {
        return { ok: false, fieldErrors: [{ field: "agents_host", message: "公用机地址必须是本机或局域网" }] };
      }
      return {};
    });
    const onSaved = vi.fn();
    const view = await mountSettings("quality", onSaved);
    await flush();

    await click(buttonByText(view, "保存配置"));
    await flush();

    expect(view.textContent).toContain("公用机地址必须是本机或局域网");
    expect(view.textContent).not.toContain("已保存公用机配置");
    expect(onSaved).not.toHaveBeenCalled();
  });
});