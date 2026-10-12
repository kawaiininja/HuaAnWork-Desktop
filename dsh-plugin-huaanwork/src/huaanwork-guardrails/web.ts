import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";
import { webFetch } from "@huaanwork/web-tools";
import { screenshot } from "@huaanwork/web-tools/screenshot";

type AttachmentStore = {
  saveImages(
    inputs: readonly { data: Uint8Array; mediaType: "image/png"; name?: string }[],
  ): Promise<readonly unknown[]>;
};

type Context = {
  huaanworkProfileDir?: string;
  huaanworkWorkspaceRoot?: { current: string };
  /** Cordis：未 inject 的服务不会挂在 ctx 上。attachments 用 inject 回调记下。 */
  inject?(names: readonly string[], callback: (inner: { get?(name: string): AttachmentStore | undefined; attachments?: AttachmentStore }) => void): void;
  tools: {
    register(definition: unknown): () => void;
  };
};

const fetchOutput = {
  schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" as const, required: true as const },
      url: { type: "string" as const },
      status: { type: "integer" as const },
      text: { type: "string" as const },
      truncated: { type: "boolean" as const },
      error: { type: "string" as const },
    },
  },
  render(_args: unknown, value: { ok: boolean; text?: string; error?: string; url?: string }) {
    if (!value.ok) return [{ type: "text" as const, text: value.error ?? "web_fetch failed" }];
    // 截断提示已在 webFetch 的 text 里（…[截断]），这里不要再加一句。
    return [{ type: "text" as const, text: (value.text ?? "").trimEnd() }];
  },
};

const shotOutput = {
  schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" as const, required: true as const },
      path: { type: "string" as const },
      bytes: { type: "integer" as const },
      imageRef: { type: "object" as const, additionalProperties: true as const },
      error: { type: "string" as const },
    },
  },
  render(_args: unknown, value: { ok: boolean; path?: string; error?: string; imageRef?: unknown }) {
    if (!value.ok) return [{ type: "text" as const, text: value.error ?? "screenshot failed" }];
    const blocks = [{ type: "text" as const, text: `截图已保存：${value.path}` }];
    if (value.imageRef !== undefined) blocks.push({ type: "image", attachment: value.imageRef } as never);
    return blocks;
  },
};

/** 每次调用直读 settings（与 guardrails/policy.ts 的 readGuardMode 同模式），fail-closed。 */
function readAllowNetwork(profileDir: string | undefined): boolean {
  if (!profileDir) return false;
  try {
    const parsed = JSON.parse(readFileSync(join(profileDir, "huaanwork-settings.json"), "utf8")) as Record<string, unknown>;
    if (typeof parsed.allow_network === "boolean") return parsed.allow_network;
    return parsed.work_allow_network === true; // 旧 key 一次性兼容，与 huaanwork-host/settings.ts 的 parse 一致
  } catch {
    return false;
  }
}

export const inject = ["tools"];

export function apply(ctx: Context): void {
  const checkNetwork = () => readAllowNetwork(ctx.huaanworkProfileDir);
  const workspaceRoot = () => ctx.huaanworkWorkspaceRoot?.current ?? process.cwd();
  // tool-fs 用 ctx.inject(['attachments']) 才拿得到 store（deepseek-harness/.../tool-fs/src/index.ts）。
  // 直接读 ctx.attachments 在只 inject 了 tools 的插件上是空的，图片块永远不会出现。
  // 工具本身始终注册：服务未挂载时 saveImage 留空，只走路径兜底。
  let attachments: AttachmentStore | undefined;
  ctx.inject?.(["attachments"], (inner) => {
    attachments = inner.get?.("attachments") ?? inner.attachments;
  });

  ctx.tools.register(
    defineTool({
      name: "web_fetch",
      description: "Fetch a URL and return its text content. LAN addresses always work; public internet requires 设置→权限 的公网开关。",
      parameters: {
        url: { type: "string", required: true, description: "The URL to fetch." },
        timeoutMs: { type: "number", description: "Request timeout in ms (default 30000)." },
      },
      output: fetchOutput,
      isConcurrencySafe: () => true,
      async execute(args) {
        return webFetch(args.url, {
          checkNetwork,
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "screenshot",
      description: "Render a URL in headless system Chrome and save a PNG screenshot into the workspace.",
      parameters: {
        url: { type: "string", required: true, description: "The URL to render (typically a local dev server)." },
        width: { type: "number", description: "Viewport width (default 1280)." },
        height: { type: "number", description: "Viewport height (default 800)." },
        fullPage: { type: "boolean", description: "Capture the full scrollable page (default false)." },
        waitMs: { type: "number", description: "Extra wait after load, max 10000." },
      },
      output: shotOutput,
      async execute(args) {
        const saveImage = attachments
          ? async (png: Uint8Array, name: string) =>
              (await attachments!.saveImages([{ data: png, mediaType: "image/png", name }]))[0]
          : undefined;
        return screenshot(args, {
          checkNetwork,
          workspaceRoot: workspaceRoot(),
          ...(saveImage ? { saveImage } : {}),
        }) as never;
      },
    }),
  );
}
