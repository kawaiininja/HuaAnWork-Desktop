import fs from "node:fs";
import path from "node:path";

export function isGitMetadataSegment(segment: string, root: string): boolean {
  const caseInsensitive =
    process.platform === "win32" || /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  return caseInsensitive
    ? segment.toLowerCase() === ".git"
    : segment === ".git";
}

export function resolveInside(
  root: string,
  candidate: string,
  opts: { forWrite?: boolean } = {},
): string | null {
  let absRoot: string;
  try {
    absRoot = fs.realpathSync(root);
  } catch {
    return null;
  }

  const abs = path.resolve(absRoot, candidate);
  const existing = opts.forWrite ? existingParent(abs) : abs;
  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    return null;
  }

  if (opts.forWrite) {
    const rest = path.relative(existing, abs);
    real = path.resolve(real, rest);
  }

  const rel = path.relative(absRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (
    opts.forWrite &&
    rel.split(path.sep).some((segment) => isGitMetadataSegment(segment, root))
  ) {
    return null;
  }
  return real;
}

function existingParent(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
