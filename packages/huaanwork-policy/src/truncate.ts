const DEFAULT_LIMIT = 32 * 1024;
const TRUNCATED_MARK = "…（已截断）";

function takePrefix(text: string, budget: number): string {
  let bytes = 0;
  let out = "";
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > budget) break;
    out += codePoint;
    bytes += size;
  }
  return out;
}

function takeSuffix(text: string, budget: number): string {
  const chars = [...text];
  let bytes = 0;
  let start = chars.length;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(chars[index] ?? "", "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    start = index;
  }
  return chars.slice(start).join("");
}

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
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };

  const markBytes = Buffer.byteLength(TRUNCATED_MARK, "utf8");
  if (limit <= markBytes + 2) return { text: takePrefix(text, limit), truncated: true };
  const budget = limit - markBytes;
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = Math.floor(budget / 2);
  return {
    text: `${takePrefix(text, headBudget)}${TRUNCATED_MARK}${takeSuffix(text, tailBudget)}`,
    truncated: true,
  };
}
