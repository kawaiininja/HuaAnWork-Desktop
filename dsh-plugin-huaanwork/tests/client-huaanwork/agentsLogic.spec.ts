import assert from "node:assert/strict";
import { test } from "vitest";

import {
  AGENT_NAME_RE,
  atAgents,
  atTokenAt,
  catalogFormErrors,
  endpointFormErrors,
  filterAgents,
  isAgentInvocable,
  looksLikeLanUrl,
  parseAtInvoke,
  type AgentListItem,
} from "../../src/client-huaanwork/logic/agentsLogic.ts";

// 与 packages/policy/src/network.test.ts 的 LAN_URL_FIXTURES 保持逐字一致
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

test("AGENT_NAME_RE enforces kebab-case", () => {
  assert.equal(AGENT_NAME_RE.test("pdf-extract"), true);
  assert.equal(AGENT_NAME_RE.test("tool1"), true);
  assert.equal(AGENT_NAME_RE.test("a-b-c"), true);
  assert.equal(AGENT_NAME_RE.test("Bad_Name"), false);
  assert.equal(AGENT_NAME_RE.test("-bad"), false);
  assert.equal(AGENT_NAME_RE.test("bad-"), false);
  assert.equal(AGENT_NAME_RE.test("bad--name"), false);
  assert.equal(AGENT_NAME_RE.test(""), false);
});

test("atTokenAt matches @mentions and ignores email / @@", () => {
  assert.equal(atTokenAt("请看 @inv", 6)?.query, "inv");
  assert.equal(atTokenAt("a@b.com", 4), undefined);
  assert.equal(atTokenAt("@@x", 3), undefined);
  assert.equal(atTokenAt("@", 1)?.query, "");
  assert.equal(atTokenAt("hello @world", 8)?.query, "world");
  assert.equal(atTokenAt("@foo-bar", 8)?.query, "foo-bar");
  assert.equal(atTokenAt("@foo_bar", 8), undefined);
  assert.equal(atTokenAt("hello world", 3), undefined);
});

test("parseAtInvoke only accepts a leading @name", () => {
  assert.deepEqual(parseAtInvoke("@pdf-extract 抽文本"), { name: "pdf-extract", remainder: "抽文本" });
  assert.deepEqual(parseAtInvoke("@pdf-extract"), { name: "pdf-extract", remainder: "" });
  assert.deepEqual(parseAtInvoke("  @pdf-extract   多余空格  "), { name: "pdf-extract", remainder: "多余空格" });
  assert.equal(parseAtInvoke("先看 @pdf-extract"), undefined);
  assert.equal(parseAtInvoke("@@pdf-extract"), undefined);
  assert.equal(parseAtInvoke("@-bad"), undefined);
  assert.equal(parseAtInvoke("@"), undefined);
});

test("isAgentInvocable requires enabled and not broken", () => {
  const base: AgentListItem = {
    name: "pdf-extract",
    source: "catalog",
    kind: "tool",
    description: "pdf",
    version: "1",
    permissions: [],
    enabled: true,
  };
  assert.equal(isAgentInvocable(base), true);
  assert.equal(isAgentInvocable({ ...base, enabled: false }), false);
  assert.equal(isAgentInvocable({ ...base, broken: { reason: "重名" } }), false);
  assert.equal(isAgentInvocable({ ...base, enabled: false, broken: { reason: "重名" } }), false);
});

test("atAgents only lists enabled non-broken items from cache and filters/sorts correctly", () => {
  const items: AgentListItem[] = [
    { name: "pdf-extract", source: "catalog", kind: "tool", description: "提取 PDF 文本", version: "1", permissions: [], enabled: true },
    { name: "pdf-merge", source: "catalog", kind: "tool", description: "合并 PDF", version: "1", permissions: [], enabled: true },
    { name: "off", source: "catalog", kind: "tool", description: "x", version: "1", permissions: [], enabled: false },
    { name: "bad", source: "catalog", kind: "agent", description: "x", version: "1", permissions: [], enabled: true, broken: { reason: "重名" } },
    { name: "doc-convert", source: "local", kind: "agent", description: "支持 pdf 转换", version: "1", permissions: [], enabled: true },
  ];
  assert.deepEqual(atAgents(items, "").map((item) => item.name), ["doc-convert", "pdf-extract", "pdf-merge"]);
  assert.deepEqual(atAgents(items, "merge").map((item) => item.name), ["pdf-merge"]);
  // 前缀匹配 name 优先于 description 匹配
  assert.deepEqual(atAgents(items, "pdf").map((item) => item.name), ["pdf-extract", "pdf-merge", "doc-convert"]);
});

test("looksLikeLanUrl matches the policy LAN_URL_FIXTURES list", () => {
  // 与 packages/policy/src/network.test.ts 的 LAN_URL_FIXTURES 逐字相同
  for (const [url, ok] of LAN_URL_FIXTURES) {
    assert.equal(looksLikeLanUrl(url), ok, url);
  }
});

test("looksLikeLanUrl handles edge cases (subnets, IPv6, invalid URLs)", () => {
  assert.equal(looksLikeLanUrl("http://172.16.0.1:8080/v1"), true);
  assert.equal(looksLikeLanUrl("http://172.31.255.255/v1"), true);
  assert.equal(looksLikeLanUrl("http://172.15.0.1/v1"), false);
  assert.equal(looksLikeLanUrl("http://172.32.0.1/v1"), false);
  assert.equal(looksLikeLanUrl("http://100.64.0.1/v1"), false);
  assert.equal(looksLikeLanUrl("http://8.8.8.8:443/v1"), false);
  assert.equal(looksLikeLanUrl("http://127.1:11434/v1"), true);
  assert.equal(looksLikeLanUrl("http://127.255.0.9/v1"), true);
  assert.equal(looksLikeLanUrl("http://foo.localhost:3000/v1"), true);
  assert.equal(looksLikeLanUrl("http://[fc00::1]:8080/v1"), true);
  assert.equal(looksLikeLanUrl("http://[febf::1]:8080/v1"), true);
  assert.equal(looksLikeLanUrl("http://[fec0::1]:8080/v1"), false);
  assert.equal(looksLikeLanUrl("http://[2001:db8::1]/v1"), false);
  assert.equal(looksLikeLanUrl("http://[::]/v1"), false);
  assert.equal(looksLikeLanUrl("http://nas.internal:11434/v1"), false);
  assert.equal(looksLikeLanUrl("ftp://127.0.0.1/v1"), false);
  assert.equal(looksLikeLanUrl(""), false);
  assert.equal(looksLikeLanUrl("not a url"), false);
});

test("catalogFormErrors validates host and port", () => {
  assert.ok(catalogFormErrors("api.openai.com", "443").agents_host);
  assert.equal(Object.keys(catalogFormErrors("192.168.1.2", "8080")).length, 0);
  assert.equal(Object.keys(catalogFormErrors("localhost", "3000")).length, 0);
  assert.equal(Object.keys(catalogFormErrors("", "")).length, 0);
  assert.equal(Object.keys(catalogFormErrors("192.168.1.2", "")).length, 0);
  assert.equal(Object.keys(catalogFormErrors("", "8080")).length, 0);

  // 端口范围校验
  assert.equal(catalogFormErrors("192.168.1.2", "0").agents_port, "端口必须是 1–65535 的整数");
  assert.equal(catalogFormErrors("192.168.1.2", "65536").agents_port, "端口必须是 1–65535 的整数");
  const badPortResult = catalogFormErrors("192.168.1.2", "abc");
  assert.equal(badPortResult.agents_port, "端口必须是 1–65535 的整数");
  assert.equal(badPortResult.agents_host, undefined);
  assert.equal(catalogFormErrors("", "99999").agents_port, "端口必须是 1–65535 的整数");
});

test("endpointFormErrors validates name and url", () => {
  const valid = { name: "my-tool", url: "http://127.0.0.1:8000", kind: "tool" as const, entrypointKind: "http" as const };
  assert.deepEqual(endpointFormErrors(valid, []), {});

  // 名称必填与格式
  assert.equal(endpointFormErrors({ ...valid, name: "" }, []).name, "名称必填");
  assert.equal(endpointFormErrors({ ...valid, name: "Bad_Name" }, []).name, "名称需为小写字母/数字/连字符（kebab-case）");

  // MCP 名称长度限制 32
  const name33 = "a".repeat(33);
  assert.equal(
    endpointFormErrors({ ...valid, name: name33, entrypointKind: "mcp" }, []).name,
    "MCP 名称不超过 32 字符",
  );

  // HTTP 名称长度限制 64
  const name65 = "a".repeat(65);
  assert.equal(
    endpointFormErrors({ ...valid, name: name65, entrypointKind: "http" }, []).name,
    "名称不超过 64 字符",
  );

  // 重名校验
  assert.equal(endpointFormErrors(valid, ["my-tool"]).name, "已存在同名入口或智能体");

  // URL 校验
  assert.equal(endpointFormErrors({ ...valid, url: "" }, []).url, "URL 必填");
  assert.equal(endpointFormErrors({ ...valid, url: "https://example.com/mcp" }, []).url, "URL 必须是本机或局域网（http/https）地址");
  assert.equal(endpointFormErrors({ ...valid, url: "not-a-url" }, []).url, "URL 必须是本机或局域网（http/https）地址");
});

test("endpointFormErrors validates description and argumentsSchema", () => {
  const valid = {
    name: "my-tool",
    url: "http://127.0.0.1:8000",
    kind: "tool" as const,
    entrypointKind: "http" as const,
    description: "",
    argumentsSchema: "",
  };
  // 选填字段留空通过
  assert.deepEqual(endpointFormErrors(valid, []), {});
  // 合法描述 + 合法 schema JSON 对象通过
  assert.deepEqual(
    endpointFormErrors(
      { ...valid, description: "审查目录并产出报告", argumentsSchema: '{"type":"object"}' },
      [],
    ),
    {},
  );
  // 描述超长
  assert.equal(
    endpointFormErrors({ ...valid, description: "x".repeat(201) }, []).description,
    "描述不超过 200 字符",
  );
  // schema 非法 JSON
  assert.equal(
    endpointFormErrors({ ...valid, argumentsSchema: "{not json" }, []).argumentsSchema,
    "参数 schema 必须是合法 JSON",
  );
  // schema 解析结果不是对象
  assert.equal(
    endpointFormErrors({ ...valid, argumentsSchema: "[1,2]" }, []).argumentsSchema,
    "参数 schema 必须是 JSON 对象",
  );
  assert.equal(
    endpointFormErrors({ ...valid, argumentsSchema: '"str"' }, []).argumentsSchema,
    "参数 schema 必须是 JSON 对象",
  );
});

test("filterAgents scopes by tab and query", () => {
  const items: AgentListItem[] = [
    { name: "cat-1", source: "catalog", kind: "tool", description: "目录工具", version: "1", permissions: [], enabled: true },
    { name: "cat-2", source: "catalog", kind: "agent", description: "目录智能体", version: "1", permissions: [], enabled: false },
    { name: "loc-1", source: "local", kind: "tool", description: "本地工具", version: "1", permissions: [], enabled: true },
  ];

  assert.deepEqual(filterAgents(items, "discover", "").map((i) => i.name), ["cat-1", "cat-2"]);
  assert.deepEqual(filterAgents(items, "enabled", "").map((i) => i.name), ["cat-1", "loc-1"]);
  assert.deepEqual(filterAgents(items, "local", "").map((i) => i.name), ["loc-1"]);

  assert.deepEqual(filterAgents(items, "discover", "智能体").map((i) => i.name), ["cat-2"]);
  assert.deepEqual(filterAgents(items, "discover", "loc").map((i) => i.name), []);
});
