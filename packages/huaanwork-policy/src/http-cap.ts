export const CATALOG_BODY_LIMIT = 1024 * 1024;

/**
 * 截断末尾未闭合的多字节 UTF-8 序列，避免 TextDecoder 替换字符使 UTF-8 字节长度超出上限。
 */
function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1;
  let back = 0;
  while (back < 4 && i >= 0) {
    const b = bytes[i]!;
    if ((b & 0x80) === 0) {
      return bytes;
    }
    if ((b & 0xc0) === 0xc0) {
      let expectedFollowers = 0;
      if ((b & 0xe0) === 0xc0) expectedFollowers = 1;
      else if ((b & 0xf0) === 0xe0) expectedFollowers = 2;
      else if ((b & 0xf8) === 0xf0) expectedFollowers = 3;

      if (back < expectedFollowers) {
        return bytes.subarray(0, i);
      }
      return bytes;
    }
    back++;
    i--;
  }
  return bytes;
}

export async function readCappedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (stream === null) return { bytes: new Uint8Array(), truncated: false };
  if (maxBytes <= 0) {
    try { await stream.cancel(); } catch { /* 忽略取消异常 */ }
    return { bytes: new Uint8Array(), truncated: true };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (totalBytes + value.byteLength > maxBytes) {
        const needed = maxBytes - totalBytes;
        if (needed > 0) {
          chunks.push(value.subarray(0, needed));
          totalBytes += needed;
        }
        truncated = true;
        try { await reader.cancel(); } catch { /* 忽略取消异常 */ }
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export async function readCappedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const capped = await readCappedBytes(stream, maxBytes);
  const bytes = capped.truncated ? trimIncompleteUtf8(capped.bytes) : capped.bytes;
  return { text: new TextDecoder("utf-8").decode(bytes), truncated: capped.truncated };
}
