import assert from "node:assert/strict";
import { test } from "node:test";

import { CATALOG_BODY_LIMIT, readCappedBytes, readCappedText } from "./http-cap.ts";

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

test("readCappedBytes 按额度截原始字节并取消 reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      controller.enqueue(new Uint8Array([6, 7, 8]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await readCappedBytes(stream, 4);
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test("readCappedText 仍修掉被截断的半个 UTF-8 序列", async () => {
  // "a" + "€"(e2 82 ac)；上限 2 字节会切在欧元的首字节上。
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x61, 0xe2, 0x82, 0xac]));
      controller.close();
    },
  });
  const result = await readCappedText(stream, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "a");
  assert.ok(Buffer.byteLength(result.text) <= 2);
});
