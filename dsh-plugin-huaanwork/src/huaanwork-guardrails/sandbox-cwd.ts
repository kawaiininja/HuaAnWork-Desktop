import { isAbsolute, relative, resolve } from "node:path";

type SessionMeta = {
  cwd?: string;
  [key: string]: unknown;
};

type SessionOptions = {
  seedSource?: string;
  meta?: SessionMeta;
  [key: string]: unknown;
};

type SessionLike = {
  header?: { cwd?: string };
};

type Context = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/session/src/index.ts(SessionService 无单独 ctx 类型导出)
  huaanworkWorkspaceRoot?: { current: string };
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
  ctx.sessions.create = (id, options) => create(id, withPinnedCwd(ctx, options));

  const prepare = ctx.sessions.prepare.bind(ctx.sessions);
  ctx.sessions.prepare = (id, options) => prepare(id, withPinnedCwd(ctx, options));

  const resolvePolicy = ctx.sandboxPolicy.resolve.bind(ctx.sandboxPolicy);
  ctx.sandboxPolicy.resolve = (request) => {
    const resolved = resolvePolicy(request);
    return { ...resolved, workspaceRoot: pinnedCwd(ctx, request?.session?.header?.cwd) };
  };
  ctx.sandboxPolicy.workspaceRoot = pinnedCwd(ctx);
}

export function pinnedCwd(ctx: { huaanworkWorkspaceRoot?: { current: string } }, requested?: string): string {
  const opened = ctx.huaanworkWorkspaceRoot?.current;
  if (!opened) return requested && requested.length > 0 ? requested : process.cwd();
  if (!requested) return opened;
  if (samePath(requested, process.cwd()) && !samePath(opened, process.cwd())) return opened;
  if (isInside(opened, requested)) return requested;
  return opened;
}

function withPinnedCwd(ctx: { huaanworkWorkspaceRoot?: { current: string } }, options?: SessionOptions): SessionOptions {
  // Persistence resume already has a durable log keyed by header.cwd. Rewriting
  // cwd here makes jsonl look for a file under the new project directory.
  if (options?.seedSource === "persistence") return options;
  const cwd = pinnedCwd(ctx, options?.meta?.cwd);
  return { ...options, meta: { ...options?.meta, cwd } };
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}
