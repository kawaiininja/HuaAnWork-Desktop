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

/**
 * 从可读流边读边计字节数，超过 maxBytes 时取消 reader 并截断，返回已读解码文本及截断标志。
 * stream 为 null 时直接返回空文本且未截断。
 */
export async function readCappedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) {
    return { text: "", truncated: false };
  }
  if (maxBytes <= 0) {
    try {
      await stream.cancel();
    } catch {
      // 忽略取消异常
    }
    return { text: "", truncated: true };
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
        try {
          await reader.cancel();
        } catch {
          // 忽略取消异常
        }
        break;
      } else {
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  let merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (truncated) {
    merged = trimIncompleteUtf8(merged) as Uint8Array<ArrayBuffer>;
  }

  const text = new TextDecoder("utf-8").decode(merged);
  return { text, truncated };
}
