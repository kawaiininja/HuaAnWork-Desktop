import { TextDecoder } from "node:util";

import { isLanEndpoint } from "@huaanwork/policy/network";
import { readCappedBytes } from "@huaanwork/policy/http-cap";

export type CheckNetwork = () => boolean;

export type RawResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

export type RawFetch = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<RawResponse>;

export type WebFetchResult =
  | { ok: true; url: string; status: number; text: string; truncated: boolean }
  | { ok: false; error: string };

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_CHARS = 50_000;
/** 显式产品标识：不伪装浏览器（与上游 web-fetch-http 的取向一致）。 */
export const USER_AGENT = "huaanwork-desktop/0.1.0 (+local)";

/** 与 huaanwork-host/net-gate.ts 的门控文案同族：指路 设置→权限。 */
export const NETWORK_GATE_ERROR =
  "当前为仅局域网模式，禁止抓取公网地址；请在 设置 → 权限 中开启「允许接入公网」，或改为抓取本机 / 局域网地址。";

const TRUNCATION_NOTE = "\n…[截断]";

const defaultRawFetch: RawFetch = async (url, init) => {
  const res = await fetch(url, {
    redirect: init.redirect,
    signal: init.signal,
    headers: { "user-agent": USER_AGENT },
  });
  return { status: res.status, headers: res.headers, body: res.body };
};

/** 不读的响应体必须取消，避免连接挂到对端关闭。取消失败不影响已经决定的结果。 */
async function cancelUnreadBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // 忽略取消异常。
  }
}

/** content-type 的 charset 参数；缺失或非法回退 utf-8。 */
function resolveDecoder(contentType: string): TextDecoder {
  const match = /charset=["']?([\w-]+)/i.exec(contentType);
  if (!match) return new TextDecoder("utf-8");
  try {
    return new TextDecoder(match[1]!.toLowerCase());
  } catch {
    return new TextDecoder("utf-8");
  }
}

/**
 * HTML → 正文文本：先剥 script/style 整块（含内容）与注释，再去标签，
 * 解码常见命名实体（`&amp;` 必须最后替换，避免 `&amp;lt;` 被双重解码），折叠空白。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function webFetch(
  url: string,
  deps: { checkNetwork: CheckNetwork; rawFetch?: RawFetch; timeoutMs?: number },
): Promise<WebFetchResult> {
  if (!deps.checkNetwork() && !isLanEndpoint(url)) return { ok: false, error: NETWORK_GATE_ERROR };
  const rawFetch = deps.rawFetch ?? defaultRawFetch;
  // 缺省保持 30s。传入值钳到 [1, MAX_TIMEOUT_MS]，避免 0 变成「立即超时」或超长挂起。
  const timeoutMs =
    deps.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : Math.min(Math.max(deps.timeoutMs, 1), MAX_TIMEOUT_MS);

  let current = url;
  for (let hops = 0; ; hops++) {
    // 同一个 AbortController 覆盖本次 rawFetch 和随后的读体。
    // readCappedBytes 不另接 signal；abort 取消的是交给 fetch / 测试流的那份 body。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let consumed = false;
    let res: RawResponse | undefined;
    try {
      try {
        res = await rawFetch(current, { redirect: "manual", signal: controller.signal });
      } catch (error) {
        return { ok: false, error: `抓取失败：${error instanceof Error ? error.message : String(error)}` };
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { ok: false, error: `HTTP ${res.status} 重定向缺少 Location 头` };
        if (hops >= MAX_REDIRECTS) return { ok: false, error: `重定向次数超过上限（${MAX_REDIRECTS}）` };
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return { ok: false, error: `重定向 Location 非法：${location}` };
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return { ok: false, error: `重定向目标协议不受支持：${next.protocol}` };
        }
        // HTTPS → HTTP 降级不跟随（凭据/内容暴露面；内网常见，但应由调用方显式发起）。
        if (new URL(current).protocol === "https:" && next.protocol === "http:") {
          return { ok: false, error: `不跟随 HTTPS → HTTP 降级重定向：${next.toString()}` };
        }
        // 重定向目标同样过门控：内网页 302 到公网在 off 档下必须被拦。
        // 同 host 换端口 / http→https 升级不额外放行，只看目标是否在门控放行范围内。
        if (!deps.checkNetwork() && !isLanEndpoint(next.toString())) return { ok: false, error: NETWORK_GATE_ERROR };
        current = next.toString();
        continue;
      }
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}` };

      const contentType = res.headers.get("content-type") ?? "";
      const decoder = resolveDecoder(contentType); // 读体前解析：不支持的编码标签在此提前失败
      try {
        // 直接把响应体交给 policy 的按额度截断。readCappedBytes 自己 subarray + reader.cancel()。
        // 一旦把 body 交出去，退出时不再 cancel，避免和读体抢同一条流。
        consumed = true;
        const capped = await readCappedBytes(res.body, MAX_RESPONSE_BYTES);
        const decoded = decoder.decode(capped.bytes);
        const overChars = decoded.length > MAX_OUTPUT_CHARS;
        const truncated = capped.truncated || overChars;
        // 字节截断但字符未超限（大标记小正文）也要带标记——接线层 render 不追加第二句，正文是唯一出口。
        const clipped = (overChars ? decoded.slice(0, MAX_OUTPUT_CHARS) : decoded) + (truncated ? TRUNCATION_NOTE : "");
        return {
          ok: true,
          url: current,
          status: res.status,
          text: contentType.includes("html") ? htmlToText(clipped) : clipped,
          truncated,
        };
      } catch (error) {
        return { ok: false, error: `读取响应失败：${error instanceof Error ? error.message : String(error)}` };
      }
    } finally {
      clearTimeout(timer);
      if (!consumed) await cancelUnreadBody(res?.body ?? null);
    }
  }
}
