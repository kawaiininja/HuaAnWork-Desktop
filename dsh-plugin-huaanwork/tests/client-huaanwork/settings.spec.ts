// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({ rpcCall: vi.fn() }));

import { rpcCall } from "../../src/client-huaanwork/api.ts";
import Settings, {
  clampConcurrentTurns,
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

it("keeps a recorded pick after the global active model changes", () => {
  // 发送时记下的 id 就是下一次发送的默认值：全局模型换了也不改这个标签的选择（P-1）。
  const picks = { "work-2": "sent-model" };
  expect(resolveSendModelId(picks, "work-2", undefined, "old-active")).toBe("sent-model");
  expect(resolveSendModelId(picks, "work-2", undefined, "new-active")).toBe("sent-model");
});

it("clamps the concurrent turn limit exactly like the host parser", () => {
  // 与宿主 parseConcurrentTurns 同规则：非整数回落缺省 3，越界夹到 1–8。
  expect(clampConcurrentTurns(0)).toBe(1);
  expect(clampConcurrentTurns(9)).toBe(8);
  expect(clampConcurrentTurns(3.5)).toBe(3);
  // 范围内的小数区分「非整数回落缺省」与「向零截断」：截断会得到 7 / 8，回落缺省才是 3。
  expect(clampConcurrentTurns(7.5)).toBe(3);
  expect(clampConcurrentTurns(8.5)).toBe(3);
  expect(clampConcurrentTurns(4)).toBe(4);
  expect(clampConcurrentTurns(-2)).toBe(1);
  expect(clampConcurrentTurns(1)).toBe(1);
  expect(clampConcurrentTurns(8)).toBe(8);
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

  // 客户端先夹紧再写状态与 RPC：超上限的 12 不会以原值离开输入框，也不会以原值发给宿主。
  await changeNumber(input, "12");
  expect(rpc).toHaveBeenCalledWith("settings.set", { max_concurrent_turns: 8 });
  expect(rpc).not.toHaveBeenCalledWith("settings.set", { max_concurrent_turns: 12 });
  expect(input.value).toBe("8");

  // 非整数与低于下限同样按宿主规则夹紧。
  await changeNumber(input, "3.5");
  expect(rpc).toHaveBeenCalledWith("settings.set", { max_concurrent_turns: 3 });
  await changeNumber(input, "0");
  expect(rpc).toHaveBeenCalledWith("settings.set", { max_concurrent_turns: 1 });
  expect(input.value).toBe("1");
});

it("keeps the host's effective value after the optimistic clamp", async () => {
  // 客户端夹紧只是先行显示；宿主仍是权威，回写的生效值要覆盖本地状态。
  rpc.mockImplementation(async (method) => {
    if (method === "settings.get") return { ...BASE_SETTINGS };
    if (method === "settings.set") return { ...BASE_SETTINGS, max_concurrent_turns: 5 };
    return {};
  });

  const view = await mountSettings();
  const input = concurrencyInput(view);
  await changeNumber(input, "7");
  expect(rpc).toHaveBeenCalledWith("settings.set", { max_concurrent_turns: 7 });
  expect(input.value).toBe("5");
});
