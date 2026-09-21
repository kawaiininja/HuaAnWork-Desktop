import assert from "node:assert/strict";
import { test } from "node:test";

import { isLanEndpoint, isLocalEndpoint, workNetworkGateError } from "./network.ts";

test("isLocalEndpoint accepts loopback endpoints", () => {
  assert.equal(isLocalEndpoint("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLocalEndpoint("http://localhost:1234/v1"), true);
  assert.equal(isLocalEndpoint("https://localhost/v1"), true);
  assert.equal(isLocalEndpoint("http://[::1]:8080/v1"), true);
  assert.equal(isLocalEndpoint("http://127.1:11434/v1"), true);
  assert.equal(isLocalEndpoint("http://127.255.0.9/v1"), true);
  assert.equal(isLocalEndpoint("http://foo.localhost:3000/v1"), true);
});

test("isLocalEndpoint rejects LAN, public, or malformed endpoints", () => {
  assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
  assert.equal(isLocalEndpoint("http://192.168.1.10:11434/v1"), false);
  assert.equal(isLocalEndpoint("http://10.0.0.2/v1"), false);
  assert.equal(isLocalEndpoint("http://[::]/v1"), false);
  assert.equal(isLocalEndpoint(""), false);
  assert.equal(isLocalEndpoint("not a url"), false);
});

test("isLanEndpoint accepts loopback, RFC1918, link-local, ULA, and .local", () => {
  assert.equal(isLanEndpoint("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLanEndpoint("http://localhost:1234/v1"), true);
  assert.equal(isLanEndpoint("http://192.168.1.10:11434/v1"), true);
  assert.equal(isLanEndpoint("http://10.0.0.2/v1"), true);
  assert.equal(isLanEndpoint("http://172.16.0.1:8080/v1"), true);
  assert.equal(isLanEndpoint("http://172.31.255.255/v1"), true);
  assert.equal(isLanEndpoint("http://169.254.1.1:11434/v1"), true);
  assert.equal(isLanEndpoint("http://gpu-box.local:11434/v1"), true);
  assert.equal(isLanEndpoint("http://[fd12:3456::1]:11434/v1"), true);
  assert.equal(isLanEndpoint("http://[fe80::1]:11434/v1"), true);
  assert.equal(isLanEndpoint("http://[::ffff:192.168.1.10]:11434/v1"), true);
});

test("isLanEndpoint rejects public IPs, public hostnames, and non-RFC1918 private-looking ranges", () => {
  assert.equal(isLanEndpoint("https://api.openai.com/v1"), false);
  assert.equal(isLanEndpoint("http://8.8.8.8:443/v1"), false);
  assert.equal(isLanEndpoint("http://172.15.0.1/v1"), false);
  assert.equal(isLanEndpoint("http://172.32.0.1/v1"), false);
  assert.equal(isLanEndpoint("http://100.64.0.1/v1"), false);
  assert.equal(isLanEndpoint("http://[2001:db8::1]/v1"), false);
  assert.equal(isLanEndpoint("http://[::]/v1"), false);
  assert.equal(isLanEndpoint("http://nas.internal:11434/v1"), false);
  assert.equal(isLanEndpoint(""), false);
  assert.equal(isLanEndpoint("not a url"), false);
});

test("workNetworkGateError allows LAN by default and blocks public endpoints unless explicitly allowed", () => {
  const remote = workNetworkGateError({ allowNetwork: false, baseUrl: "https://api.openai.com/v1" });
  assert.ok(remote !== null && remote.includes("公网"));
  assert.equal(workNetworkGateError({ allowNetwork: false, baseUrl: "http://127.0.0.1:11434/v1" }), null);
  assert.equal(workNetworkGateError({ allowNetwork: false, baseUrl: "http://192.168.1.10:11434/v1" }), null);
  assert.equal(workNetworkGateError({ allowNetwork: false, baseUrl: "http://10.0.0.8:8080/v1" }), null);
  assert.equal(workNetworkGateError({ allowNetwork: true, baseUrl: "https://api.openai.com/v1" }), null);
});

// 与 apps/desktop/src/agentsLogic.test.ts 的 LAN_URL_FIXTURES 保持逐字一致
export const LAN_URL_FIXTURES = [
  ["http://127.0.0.1:9/invoke", true],
  ["http://localhost:9/invoke", true],
  ["http://192.168.10.20:9101/invoke", true],
  ["http://10.0.0.2/v1", true],
  ["http://172.16.0.1:8080/v1", true],
  ["http://169.254.1.1:11434/v1", true],
  ["http://gpu-box.local:11434/v1", true],
  ["http://[::1]:8080/v1", true],
  ["http://[fd12:3456::1]:11434/v1", true],
  ["http://[fe80::1]:11434/v1", true],
  ["http://[::ffff:192.168.1.10]:11434/v1", true],
  ["https://api.openai.com/mcp", false],
  ["https://example.com/invoke", false],
] as const;

test("isLanEndpoint matches LAN_URL_FIXTURES", () => {
  for (const [url, expected] of LAN_URL_FIXTURES) {
    assert.equal(isLanEndpoint(url), expected, `Failed for ${url}`);
  }
});

