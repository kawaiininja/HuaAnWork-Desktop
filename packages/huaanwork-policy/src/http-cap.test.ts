import assert from "node:assert/strict";
import { test } from "node:test";

import { CATALOG_BODY_LIMIT, readCappedText } from "./http-cap.ts";

function createStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

test("readCappedText handles null stream", async () => {
  const result = await readCappedText(null, 16);
  assert.deepEqual(result, { text: "", truncated: false });
});

test("readCappedText handles stream within limit", async () => {
  const encoder = new TextEncoder();
  const stream = createStream([encoder.encode("hello "), encoder.encode("world")]);
  const result = await readCappedText(stream, 16);
  assert.deepEqual(result, { text: "hello world", truncated: false });
  assert.equal(Buffer.byteLength(result.text), 11);
});

test("readCappedText caps stream exceeding maxBytes and sets truncated: true", async () => {
  const encoder = new TextEncoder();
  const rawString = "0123456789abcdefghijklmnopqrstuvwxyz";
  const stream = createStream([encoder.encode(rawString)]);
  const result = await readCappedText(stream, 16);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 16);
  assert.equal(result.text, rawString.slice(0, 16));
});

test("CATALOG_BODY_LIMIT is 1 MiB", () => {
  assert.equal(CATALOG_BODY_LIMIT, 1024 * 1024);
});
