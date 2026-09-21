import assert from "node:assert/strict";
import { test } from "node:test";

import { KNOWN_TOOL_NAMES, parseSseToolCalls, parseTextProtocol, sseFinishReason } from "./parse.ts";

const registeredToolName = (name: string): boolean =>
  KNOWN_TOOL_NAMES.has(name) || name === "call_host_tool" || name.startsWith("mcp__");

const sseReadDeltas = [
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_read",
              type: "function",
              function: { name: "read", arguments: "" },
            },
          ],
        },
      },
    ],
  })}`,
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
        },
      },
    ],
  })}`,
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"src/main.rs"}' } }],
        },
      },
    ],
  })}`,
  "data: [DONE]",
];

test("parseSseToolCalls concatenates streaming tool_call deltas", () => {
  assert.deepEqual(parseSseToolCalls(sseReadDeltas), [
    { name: "read", args: { path: "src/main.rs" } },
  ]);
});

test("parseSseToolCalls concatenates multiple indexed tool calls", () => {
  const chunks = [
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: "glob", arguments: '{"pattern":"*.ts"}' } },
              { index: 1, function: { name: "grep", arguments: "" } },
            ],
          },
        },
      ],
    }),
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 1, function: { arguments: '{"pattern":"apply"}' } }],
          },
        },
      ],
    }),
  ];

  assert.deepEqual(parseSseToolCalls(chunks), [
    { name: "glob", args: { pattern: "*.ts" } },
    { name: "grep", args: { pattern: "apply" } },
  ]);
});

test("parseSseToolCalls skips unknown tool names", () => {
  const chunks = [
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: "web_search", arguments: "{}" } },
              { index: 1, function: { name: "read", arguments: '{"path":"a.ts"}' } },
            ],
          },
        },
      ],
    }),
  ];

  assert.deepEqual(parseSseToolCalls(chunks), [{ name: "read", args: { path: "a.ts" } }]);
});

test("parseTextProtocol parses XML tool_call", () => {
  const xml = `<tool_call name="read">
<arg name="path">src/main.rs</arg>
</tool_call>`;

  assert.deepEqual(parseTextProtocol(xml), { name: "read", args: { path: "src/main.rs" } });
});

test("parseTextProtocol parses a whole-line JSON tool call", () => {
  const text = `Sure.
{"tool":"read","args":{"path":"src/main.rs"}}`;

  assert.deepEqual(parseTextProtocol(text), { name: "read", args: { path: "src/main.rs" } });
});

test("parseTextProtocol returns null for unknown names", () => {
  assert.equal(parseTextProtocol(`{"tool":"web_search","args":{"q":"x"}}`), null);
  assert.equal(
    parseTextProtocol(`<tool_call name="run_code"><arg name="code">1</arg></tool_call>`),
    null,
  );
});

test("parseTextProtocol returns null for garbage", () => {
  assert.equal(parseTextProtocol("I'll look at the file and summarize it."), null);
  assert.equal(parseTextProtocol(""), null);
  assert.equal(parseTextProtocol("{not json"), null);
});

test("parseSseToolCalls honors a custom filter for runtime-registered tools", () => {
  const chunks = [
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: "call_host_tool", arguments: '{"name":"code-review","arguments":{}}' } },
              { index: 1, function: { name: "mcp__calc__add", arguments: '{"a":1}' } },
              { index: 2, function: { name: "run_code", arguments: '{}' } },
            ],
          },
        },
      ],
    }),
  ];

  // 默认过滤：运行时注册名字一律丢弃（回归：这正是 @code-review 「回合结束任务没做」的根因）
  assert.deepEqual(parseSseToolCalls(chunks), []);
  // 自定义过滤：call_host_tool 与 mcp__* 放行，run_code 仍被拦（不变量 5）
  assert.deepEqual(parseSseToolCalls(chunks, registeredToolName), [
    { name: "call_host_tool", args: { name: "code-review", arguments: {} } },
    { name: "mcp__calc__add", args: { a: 1 } },
  ]);
});

test("parseTextProtocol honors a custom filter for runtime-registered tools", () => {
  const xml = `<tool_call name="call_host_tool">\n<arg name="name">code-review</arg>\n</tool_call>`;
  assert.equal(parseTextProtocol(xml), null);
  assert.deepEqual(parseTextProtocol(xml, registeredToolName), {
    name: "call_host_tool",
    args: { name: "code-review" },
  });
  assert.equal(parseTextProtocol(`{"tool":"mcp__calc__add","args":{"a":1}}`, registeredToolName) !== null, true);
  assert.equal(
    parseTextProtocol(`<tool_call name="run_code"><arg name="code">1</arg></tool_call>`, registeredToolName),
    null,
  );
});

test("sseFinishReason returns the last non-empty finish_reason", () => {
  assert.equal(sseFinishReason(sseReadDeltas), undefined);
  assert.equal(
    sseFinishReason([
      JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
    ]),
    "length",
  );
});
