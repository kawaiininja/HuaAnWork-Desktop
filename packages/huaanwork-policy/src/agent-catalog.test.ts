import assert from "node:assert/strict";
import { test } from "node:test";

import {
  catalogRootUrl,
  clampTimeoutMs,
  filterAgentAllow,
  parseCatalogItem,
} from "./agent-catalog.ts";

test("catalogRootUrl wraps IPv6 and rejects empty", () => {
  assert.equal(catalogRootUrl("", 8080), null);
  assert.equal(catalogRootUrl("192.168.10.20", ""), null);
  assert.equal(catalogRootUrl("192.168.10.20", 8080), "http://192.168.10.20:8080");
  assert.equal(catalogRootUrl("::1", 8080), "http://[::1]:8080");
});

test("parseCatalogItem accepts http tool, mcp tool, and agent", () => {
  const http = parseCatalogItem({
    name: "pdf-extract",
    version: "1.0.0",
    kind: "tool",
    description: "把 PDF 抽成纯文本",
    permissions: ["network"],
    entrypoint: { kind: "http", url: "http://192.168.10.20:9101/invoke" },
  });
  assert.equal(http?.broken, undefined);
  assert.equal(http?.entrypoint?.kind, "http");

  const mcp = parseCatalogItem({
    name: "issue-tracker",
    version: "0.3.1",
    kind: "tool",
    description: "内网工单",
    entrypoint: { kind: "mcp", url: "http://192.168.10.20:9102/mcp" },
  });
  assert.equal(mcp?.broken, undefined);

  const agent = parseCatalogItem({
    name: "code-reviewer",
    version: "1.2.0",
    kind: "agent",
    description: "只读审查",
    allow: ["read", "run_code", "call_host_tool", "mcp__x__y", "glob"],
    personaUrl: "http://192.168.10.20:8080/v1/catalog/code-reviewer/persona",
  });
  assert.equal(agent?.broken, undefined);
  assert.deepEqual(agent?.allow, ["read", "glob"]);
  assert.equal(agent?.entrypoint, undefined);
});

test("missing kind, public entry, file url, and mcp name 33 are broken", () => {
  assert.ok(parseCatalogItem({ name: "x", version: "1", description: "d" })?.broken);
  assert.match(
    parseCatalogItem({
      name: "x",
      version: "1",
      kind: "tool",
      description: "d",
      entrypoint: { kind: "http", url: "https://example.com/invoke" },
    })?.broken?.reason ?? "",
    /局域网|LAN|公网/i,
  );
  assert.ok(
    parseCatalogItem({
      name: "x",
      version: "1",
      kind: "tool",
      description: "d",
      entrypoint: { kind: "http", url: "file:///tmp/x" },
    })?.broken,
  );
  const ok32 = parseCatalogItem({
    name: "a".repeat(32),
    version: "1",
    kind: "tool",
    description: "d",
    entrypoint: { kind: "mcp", url: "http://127.0.0.1:9/mcp" },
  });
  assert.equal(ok32?.broken, undefined);
  assert.ok(
    parseCatalogItem({
      name: "a".repeat(33),
      version: "1",
      kind: "tool",
      description: "d",
      entrypoint: { kind: "mcp", url: "http://127.0.0.1:9/mcp" },
    })?.broken,
  );
});

test("duplicate names: later item is broken; illegal argumentsSchema is ignored", () => {
  const seen = new Set<string>();
  const first = parseCatalogItem(
    { name: "dup", version: "1", kind: "agent", description: "a" },
    seen,
  );
  const second = parseCatalogItem(
    { name: "dup", version: "2", kind: "agent", description: "b" },
    seen,
  );
  assert.equal(first?.broken, undefined);
  assert.match(second?.broken?.reason ?? "", /重名/);
  const item = parseCatalogItem({
    name: "s",
    version: "1",
    kind: "tool",
    description: "d",
    argumentsSchema: "nope",
    entrypoint: { kind: "http", url: "http://127.0.0.1:9/invoke" },
  });
  assert.equal(item?.argumentsSchema, undefined);
  assert.equal(item?.broken, undefined);
});

test("clampTimeoutMs and filterAgentAllow defaults", () => {
  assert.equal(clampTimeoutMs(undefined), 60_000);
  assert.equal(clampTimeoutMs(500), 1000);
  assert.equal(clampTimeoutMs(200_000), 150_000);
  assert.deepEqual(filterAgentAllow(undefined), ["read", "read_file", "glob", "grep"]);
});
