// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({ rpcCall: vi.fn() }));

import { rpcCall } from "../../src/client-huaanwork/api.ts";
import Settings, {
  resolveSendModelId,
  type ModelSettingsPayload,
} from "../../src/client-huaanwork/Settings.tsx";

const BASE_SETTINGS: ModelSettingsPayload = {
  models: [
    {
      id: "local-a",
      name: "本地 A",
      base_url: "http://127.0.0.1:11434/v1",
      model: "a",
      api_key: "",
    },
  ],
  active_model_id: "local-a",
  allow_network: false,
  keep_awake: true,
  max_concurrent_turns: 3,
};

const rpc = vi.mocked(rpcCall);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mountSettings(): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Settings, {
        onClose: () => undefined,
        section: "model",
        onSectionChange: () => undefined,
        theme: "system",
        onThemeChange: async () => undefined,
        username: "tester",
        onChangePassword: async () => undefined,
        keepAwakeUnavailable: false,
      }),
    );
  });
  return container;
}

function concurrencyInput(view: ParentNode): HTMLInputElement {
  const input = view.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error("number input not found");
  return input;
}

/** React 18 的受控输入用实例上的 value setter 记值，必须经原型 setter 才会触发 onChange。 */
async function changeNumber(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("value setter not found");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("accepts max_concurrent_turns on the model settings payload", () => {
  const payload: ModelSettingsPayload = { max_concurrent_turns: 5 };
  expect(payload.max_concurrent_turns).toBe(5);
});

it("resolves the send model from the tab pick, then the task model, then the active model", () => {
  expect(resolveSendModelId({ "work-2": "picked" }, "work-2", "task-model", "active-model")).toBe("picked");
  expect(resolveSendModelId({}, "work-2", "task-model", "active-model")).toBe("task-model");
  expect(resolveSendModelId({}, "work-2", undefined, "active-model")).toBe("active-model");
});

it("writes the concurrent turn limit from the model section and shows the effective value", async () => {
  rpc.mockImplementation(async (method, params) => {
    if (method === "settings.get") return { ...BASE_SETTINGS };
    if (method === "settings.set") {
      const requested = (params as { max_concurrent_turns?: number }).max_concurrent_turns;
      const effective = requested === undefined
        ? BASE_SETTINGS.max_concurrent_turns
        : Math.max(1, Math.min(8, requested));
      return { ...BASE_SETTINGS, max_concurrent_turns: effective };
    }
    return {};
  });

  const view = await mountSettings();
  const input = concurrencyInput(view);
  expect(input.type).toBe("number");
  expect(input.min).toBe("1");
  expect(input.max).toBe("8");
  expect(input.step).toBe("1");
  expect(input.value).toBe("3");
  expect(input.closest("label")?.textContent ?? "").toContain("同时进行的任务数");

  await changeNumber(input, "5");
  expect(rpc).toHaveBeenCalledWith("settings.set", { max_concurrent_turns: 5 });
  expect(input.value).toBe("5");

  // 宿主把 12 夹到上限 8 并回写生效值：输入框显示的是生效值，不是用户敲的字面量。
  await changeNumber(input, "12");
  expect(rpc).toHaveBeenCalledWith("settings.set", { max_concurrent_turns: 12 });
  expect(input.value).toBe("8");
});
