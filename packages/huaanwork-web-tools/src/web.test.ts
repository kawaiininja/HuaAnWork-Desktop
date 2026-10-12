import assert from "node:assert/strict";
import { test } from "node:test";

import { htmlToText, NETWORK_GATE_ERROR, webFetch, type RawFetch } from "./web.ts";

const PUBLIC_URL = "https://example.com/page";
const LAN_URL = "http://192.168.1.10:8080/docs";

function htmlFetch(html: string, status = 200): RawFetch {
  return async () => ({
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    }),
  });
}

test("门控：allow_network=off 时公网被拒、错误指路设置", async () => {
  const result = await webFetch(PUBLIC_URL, { checkNetwork: () => false, rawFetch: htmlFetch("x") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, NETWORK_GATE_ERROR);
  assert.match(NETWORK_GATE_ERROR, /设置 → 权限/);
});

test("门控：allow_network=off 时局域网照常放行", async () => {
  const result = await webFetch(LAN_URL, { checkNetwork: () => false, rawFetch: htmlFetch("<p>内网文档</p>") });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.text, /内网文档/);
});

test("门控：allow_network=on 时公网放行", async () => {
  const result = await webFetch(PUBLIC_URL, { checkNetwork: () => true, rawFetch: htmlFetch("<p>hello</p>") });
  assert.equal(result.ok, true);
});

test("重定向：超过 5 次报错；off 档下重定向到公网同样被门控", async () => {
  let calls = 0;
  const loopFetch: RawFetch = async (url) => {
    calls++;
    return { status: 302, headers: { get: () => url }, body: null };
  };
  const result = await webFetch(LAN_URL, { checkNetwork: () => true, rawFetch: loopFetch });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /重定向/);
  assert.ok(calls <= 6);

  const toPublic: RawFetch = async () => ({
    status: 302, headers: { get: () => PUBLIC_URL }, body: null,
  });
  const gated = await webFetch(LAN_URL, { checkNetwork: () => false, rawFetch: toPublic });
  assert.equal(gated.ok, false);
  if (!gated.ok) assert.equal(gated.error, NETWORK_GATE_ERROR);
});

test("HTML 提取：剥 script/style/标签，折叠空白", () => {
  const text = htmlToText(`<html><head><style>body{color:red}</style><script>evil()</script></head>
    <body><h1>标题</h1><p>正文 &amp; 更多</p></body></html>`);
  assert.match(text, /标题/);
  assert.match(text, /正文 & 更多/);
  assert.doesNotMatch(text, /evil|color:red/);
});

test("抓取失败与非 2xx 返回结构化错误", async () => {
  const boom: RawFetch = async () => { throw new Error("ECONNREFUSED"); };
  const failed = await webFetch(LAN_URL, { checkNetwork: () => true, rawFetch: boom });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /ECONNREFUSED/);

  const notFound: RawFetch = async () => ({ status: 404, headers: { get: () => null }, body: null });
  const res = await webFetch(LAN_URL, { checkNetwork: () => true, rawFetch: notFound });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /404/);
});
