const DEFAULT_LIMIT = 32 * 1024;

export function capToolOutput(
  stdout: string,
  stderr: string,
  alreadyTruncated = false,
  limit = DEFAULT_LIMIT,
): { text: string; truncated: boolean } {
  if (alreadyTruncated) {
    return { text: stdout, truncated: true };
  }

  const text = stdout + stderr;
  if (Buffer.byteLength(text, "utf8") > limit) {
    const codePoints: string[] = [];
    let bytes = 0;
    for (const codePoint of text) {
      const codePointBytes = Buffer.byteLength(codePoint, "utf8");
      if (bytes + codePointBytes > limit) break;
      codePoints.push(codePoint);
      bytes += codePointBytes;
    }
    return { text: codePoints.join(""), truncated: true };
  }
  return { text, truncated: false };
}
