import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isLanEndpoint } from "@huaanwork/policy/network";

import { NETWORK_GATE_ERROR, type CheckNetwork } from "./web.ts";

export type RouteLike = {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
};

export type PageLike = {
  setViewportSize(viewport: { width: number; height: number }): Promise<unknown>;
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  screenshot(options: { type: "png"; fullPage: boolean }): Promise<Uint8Array>;
  route?(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
};

export type BrowserLike = {
  newPage(): Promise<PageLike>;
  close(): Promise<unknown>;
};

export type LaunchLike = () => Promise<BrowserLike>;

export type SaveImage = (png: Uint8Array, name: string) => Promise<unknown | undefined>;

export type ScreenshotArgs = {
  url: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
  waitMs?: number;
};

export type ScreenshotDeps = {
  checkNetwork: CheckNetwork;
  workspaceRoot: string;
  launch?: LaunchLike;
  saveImage?: SaveImage;
  now?: () => number;
};

export type ScreenshotResult =
  | { ok: true; path: string; bytes: number; imageRef?: unknown }
  | { ok: false; error: string };

export const MAX_WAIT_MS = 10_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const GOTO_TIMEOUT_MS = 30_000;

export const CHROME_MISSING_ERROR =
  "截图失败：未找到可用的系统 Chrome/Chromium（playwright channel: chrome）。请在本机安装 Chrome 后重试；或改用 web_fetch 抓取文本。";

/** 动态 import：测试注入 launch 时不加载 playwright-core。 */
const defaultLaunch: LaunchLike = async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  // playwright-core 1.63 的 page.route 返回 Promise<Disposable>，与 PageLike 的 Promise<void> 不结构兼容。
  return {
    newPage: () => browser.newPage(),
    close: () => browser.close(),
  } as unknown as BrowserLike;
};

function unsupportedPageUrl(url: string): string | null {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return `截图目标地址无法解析：${url}`;
  }
  if (protocol === "http:" || protocol === "https:") return null;
  return `截图目标协议不受支持：${protocol}`;
}

/** data: / blob: 是文档内嵌资源，不是出网请求。 */
function isInlineUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "data:" || protocol === "blob:";
  } catch {
    return false;
  }
}

export async function screenshot(args: ScreenshotArgs, deps: ScreenshotDeps): Promise<ScreenshotResult> {
  // 首跳先看协议：公网开关打开也不能用 file: 等协议读本地文件。Chrome 内部的 302 仍由浏览器自己跟。
  const schemeError = unsupportedPageUrl(args.url);
  if (schemeError !== null) return { ok: false, error: schemeError };
  if (!deps.checkNetwork() && !isLanEndpoint(args.url)) return { ok: false, error: NETWORK_GATE_ERROR };

  const launch = deps.launch ?? defaultLaunch;
  let browser: BrowserLike;
  try {
    browser = await launch();
  } catch (error) {
    // 启动失败按消息分流：只有"找不到可执行文件 / chrome 发行版"才是缺 Chrome 的指路文案；
    // 其他启动错误（权限、profile 锁、协议不支持）按原样报出，避免误导排查方向。
    const message = error instanceof Error ? error.message : String(error);
    if (/executable|doesn't exist|ENOENT|channel|distribution 'chrome' is not found/i.test(message)) {
      return { ok: false, error: CHROME_MISSING_ERROR };
    }
    return { ok: false, error: `截图失败：${message}` };
  }

  let blockedPublic = false;
  try {
    const page = await browser.newPage();
    await page.setViewportSize({
      width: args.width ?? DEFAULT_VIEWPORT.width,
      height: args.height ?? DEFAULT_VIEWPORT.height,
    });
    // 首跳已在函数入口检查。Playwright goto 会自己跟随 302，子资源也会打到公网。
    // 公网开关关闭时，data: / blob: 继续；其余非局域网请求中止，避免局域网地址跳到公网仍被画进 PNG。
    if (!deps.checkNetwork() && page.route) {
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (isInlineUrl(url) || isLanEndpoint(url)) {
          await route.continue();
          return;
        }
        blockedPublic = true;
        await route.abort();
      });
    }
    await page.goto(args.url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
    if (blockedPublic) return { ok: false, error: NETWORK_GATE_ERROR };
    const waitMs = Math.min(Math.max(args.waitMs ?? 0, 0), MAX_WAIT_MS);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const png = await page.screenshot({ type: "png", fullPage: args.fullPage ?? false });

    const now = deps.now ?? Date.now;
    const dir = join(deps.workspaceRoot, ".huaanwork", "screenshots");
    await mkdir(dir, { recursive: true });
    const name = `${now()}-${slugHost(args.url)}.png`;
    const path = join(dir, name);
    // PNG 落盘不经 policy 的 forWrite：workspaceRoot 由 sandbox 钉死，风险低。
    await writeFile(path, png);

    const imageRef = deps.saveImage ? await deps.saveImage(png, name) : undefined;
    return { ok: true, path, bytes: png.byteLength, ...(imageRef === undefined ? {} : { imageRef }) };
  } catch (error) {
    if (blockedPublic) return { ok: false, error: NETWORK_GATE_ERROR };
    return { ok: false, error: `截图失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await browser.close();
  }
}

function slugHost(url: string): string {
  try {
    return new URL(url).host.replace(/[^a-zA-Z0-9.-]/g, "_") || "page";
  } catch {
    return "page";
  }
}
