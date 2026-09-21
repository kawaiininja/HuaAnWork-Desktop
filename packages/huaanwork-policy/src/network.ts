/**
 * 联网门禁（纯函数，供 sidecar 与 bundle 共用）。
 *
 * 所有会话统一：未开公网时仅允许本机与局域网模型端点。
 * 仅当管理员在设置中开启 `allow_network` 后才放行公网端点。
 * 「本地优先」指不接公网，不是仅本机回环。
 */

import { BlockList, isIP } from "node:net";

const LAN_BLOCKS = new BlockList();
LAN_BLOCKS.addSubnet("10.0.0.0", 8, "ipv4");
LAN_BLOCKS.addSubnet("172.16.0.0", 12, "ipv4");
LAN_BLOCKS.addSubnet("192.168.0.0", 16, "ipv4");
LAN_BLOCKS.addSubnet("127.0.0.0", 8, "ipv4");
LAN_BLOCKS.addSubnet("169.254.0.0", 16, "ipv4");
LAN_BLOCKS.addAddress("::1", "ipv6");
LAN_BLOCKS.addSubnet("fc00::", 7, "ipv6");
LAN_BLOCKS.addSubnet("fe80::", 10, "ipv6");

/** 从 OpenAI 兼容 base_url 取出主机名；解析失败返回 null。 */
function endpointHostname(baseUrl: string): string | null {
  const text = baseUrl.trim();
  if (!text) return null;
  let hostname: string;
  try {
    hostname = new URL(text).hostname.toLowerCase();
  } catch {
    return null;
  }
  // WHATWG URL 对 IPv6 保留方括号（"[::1]"）。
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  return hostname;
}

/** IPv4-mapped IPv6（::ffff:a.b.c.d）还原为 IPv4，便于走同一套网段表。 */
function mappedIpv4(hostname: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(hostname);
  return match ? match[1] : null;
}

/** 判定 OpenAI 兼容端点是否指向本机回环地址（localhost / 127.0.0.0/8 / ::1）。 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const hostname = endpointHostname(baseUrl);
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1") return true;
  // 127.0.0.0/8 均为回环；URL 解析器已把数字主机名规范化（如 127.1 → 127.0.0.1）。
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}

/**
 * 判定端点是否落在本机或局域网网段（默认门禁放行范围）。
 * 含回环、RFC1918、链路本地、IPv6 ULA，以及 mDNS `.local`。
 * 不做 DNS 解析：普通主机名按公网拒绝。
 */
export function isLanEndpoint(baseUrl: string): boolean {
  if (isLocalEndpoint(baseUrl)) return true;
  const hostname = endpointHostname(baseUrl);
  if (!hostname) return false;
  if (hostname.endsWith(".local")) return true;
  const ip = mappedIpv4(hostname) ?? hostname;
  const version = isIP(ip);
  if (version === 4) return LAN_BLOCKS.check(ip, "ipv4");
  if (version === 6) return LAN_BLOCKS.check(ip, "ipv6");
  return false;
}

export type WorkNetworkGateInput = {
  /** settings.json 中的 `allow_network`（缺省 false = 仅本机+局域网）。 */
  allowNetwork: boolean;
  /** 当前激活模型的 base_url。 */
  baseUrl: string;
};

/**
 * 发送前的联网校验。
 * 返回 null 表示放行；否则返回面向用户的错误文案（同时用于 RPC 报错与模型流层报错）。
 */
export function workNetworkGateError({ allowNetwork, baseUrl }: WorkNetworkGateInput): string | null {
  if (allowNetwork) return null;
  if (isLanEndpoint(baseUrl)) return null;
  return (
    `当前为仅局域网模式，仅允许本机与局域网模型端点，禁止接入公网；` +
    `当前端点为公网地址（${baseUrl}）。请在 设置 → 权限 中开启「允许接入公网」，或将模型端点改为本机 / 局域网服务。`
  );
}
