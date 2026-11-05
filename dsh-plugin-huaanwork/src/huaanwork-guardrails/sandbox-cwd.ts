import { isAbsolute, relative, resolve } from "node:path";

import { parentSessionOf } from "../huaanwork-host/child-sessions.ts";

type SessionMeta = {
  cwd?: string;
  parentSession?: string;
  [key: string]: unknown;
};

type SessionOptions = {
  seedSource?: string;
  meta?: SessionMeta;
  [key: string]: unknown;
};

type SessionHeader = {
  id?: string;
  cwd?: string;
  parentSession?: string;
  [key: string]: unknown;
};

type SessionLike = {
  header?: SessionHeader;
};

type Context = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/session/src/index.ts(SessionService 无单独 ctx 类型导出)
  huaanworkWorkspaceRoot?: { current: string };
  /** 会话 id → 本会话可写根。Task 6 在创建/恢复会话前写入;此处只读。 */
  huaanworkSessionRoots?: Map<string, string>;
  sessions: {
    create: (id?: string, options?: SessionOptions) => unknown;
    prepare: (id?: string, options?: SessionOptions) => unknown;
  };
  sandboxPolicy: {
    workspaceRoot?: string;
    resolve: (request?: { session?: SessionLike; mode?: string }) => {
      mode: string;
      workspaceRoot: string;
      sessionId?: string;
    };
  };
};

export const name = "huaanwork-sandbox-cwd";
export const inject = ["sessions", "sandboxPolicy"];

export function apply(ctx: Context): void {
  const create = ctx.sessions.create.bind(ctx.sessions);
  ctx.sessions.create = (id, options) => create(id, withPinnedCwd(ctx, id, options));

  const prepare = ctx.sessions.prepare.bind(ctx.sessions);
  ctx.sessions.prepare = (id, options) => prepare(id, withPinnedCwd(ctx, id, options));

  const resolvePolicy = ctx.sandboxPolicy.resolve.bind(ctx.sandboxPolicy);
  ctx.sandboxPolicy.resolve = (request) => {
    const resolved = resolvePolicy(request);
    const header = request?.session?.header;
    const allowedRoot = sessionRootFromHeader(ctx, header);
    return { ...resolved, workspaceRoot: pinnedCwd(ctx, header?.cwd, allowedRoot) };
  };
  ctx.sandboxPolicy.workspaceRoot = pinnedCwd(ctx);
}

/**
 * 传了 `allowedRoot` 就只相对该根夹紧，不再看前台根；未传时维持前台夹紧。
 * 可写根只来自 `ctx.huaanworkSessionRoots`，不读 `header.writableRoot`：
 * 上游构造 header 时会丢掉该字段，`deepFreeze` 之后也不能再挂。
 */
export function pinnedCwd(
  ctx: { huaanworkWorkspaceRoot?: { current: string } },
  requested?: string,
  allowedRoot?: string,
): string {
  if (allowedRoot) {
    if (!requested) return allowedRoot;
    return isInside(allowedRoot, requested) ? requested : allowedRoot;
  }
  const opened = ctx.huaanworkWorkspaceRoot?.current;
  if (!opened) return requested && requested.length > 0 ? requested : process.cwd();
  if (!requested) return opened;
  if (samePath(requested, process.cwd()) && !samePath(opened, process.cwd())) return opened;
  if (isInside(opened, requested)) return requested;
  return opened;
}

function withPinnedCwd(
  ctx: Context,
  sessionId?: string,
  options?: SessionOptions,
): SessionOptions {
  // Persistence resume already has a durable log keyed by header.cwd. Rewriting
  // cwd here makes jsonl look for a file under the new project directory.
  if (options?.seedSource === "persistence") return options;
  const roots = ctx.huaanworkSessionRoots;
  // 根表没有这个会话时保持前台夹紧，避免尚未接线的调用突然放开。
  const allowedRoot = rootOf(roots, sessionId) ?? rootOf(roots, options?.meta?.parentSession);
  const cwd = pinnedCwd(ctx, options?.meta?.cwd, allowedRoot);
  return { ...options, meta: { ...options?.meta, cwd } };
}

/** 允许根查找顺序：`header.id` → 登记过的父会话 → `header.parentSession`。 */
function sessionRootFromHeader(ctx: Context, header?: SessionHeader): string | undefined {
  const roots = ctx.huaanworkSessionRoots;
  if (!roots) return undefined;
  const direct = rootOf(roots, header?.id);
  if (direct) return direct;
  const registeredParent = header?.id ? parentSessionOf(header.id) : undefined;
  return rootOf(roots, registeredParent) ?? rootOf(roots, header?.parentSession);
}

/**
 * 执行期读取会话可写根：根表直查 → 已登记的父会话 → 前台根。
 *
 * 工具执行、diff 快照等路径用本函数取根，不要读 `huaanworkWorkspaceRoot.current`：
 * 后台会话在执行时前台可能已经切到另一个项目。
 */
export function sessionWorkspaceRoot(
  ctx: {
    huaanworkSessionRoots?: Map<string, string>;
    huaanworkWorkspaceRoot?: { current: string };
  },
  sessionId?: string,
): string {
  const roots = ctx.huaanworkSessionRoots;
  const direct = rootOf(roots, sessionId);
  if (direct) return direct;
  const parent = sessionId ? parentSessionOf(sessionId) : undefined;
  const inherited = rootOf(roots, parent);
  if (inherited) return inherited;
  return ctx.huaanworkWorkspaceRoot?.current ?? process.cwd();
}

function rootOf(roots: Map<string, string> | undefined, sessionId?: string): string | undefined {
  if (!roots || !sessionId) return undefined;
  const root = roots.get(sessionId);
  return root && root.length > 0 ? root : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}
