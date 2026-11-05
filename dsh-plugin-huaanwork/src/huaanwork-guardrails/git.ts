import { defineTool } from "@deepseek-ai/dsh-tools";
import { createGitTools, type GitCommandResult } from "@huaanwork/git-tools";
import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

import { sessionWorkspaceRoot } from "./sandbox-cwd.ts";

type ToolExecution = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:376
  name: string;
  arguments: unknown;
  /** 上游执行对象携带的 agent 引用;宿主据此取会话可写根。 */
  agent?: { id?: string; session?: { id?: string } };
};

type PreExecuteDecision = // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:426(PreToolDecision)
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason?: string };

type GitOutput = {
  stdout: string;
  stderr: string;
  status: number;
  dirty?: boolean;
};

type Context = {
  huaanworkWorkspaceRoot?: { current: string };
  huaanworkSessionRoots?: Map<string, string>;
  on(
    event: "tools/pre-execute",
    listener: (execution: ToolExecution, next: () => Promise<PreExecuteDecision>) => Promise<PreExecuteDecision>,
    prepend?: boolean,
  ): void;
  tools: {
    register(definition: unknown): () => void;
  };
};

const output = {
  schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      stdout: { type: "string" as const, required: true as const },
      stderr: { type: "string" as const, required: true as const },
      status: { type: "integer" as const, required: true as const },
      dirty: { type: "boolean" as const },
    },
  },
  render(_args: unknown, value: GitOutput) {
    const parts = [
      value.dirty ? "dirty: true" : "",
      value.stdout,
      value.stderr,
    ].filter((part) => part.trim().length > 0);
    return [{ type: "text" as const, text: parts.join("\n").trimEnd() || `git exited ${value.status}` }];
  },
};

export const inject = ["tools"];

export function apply(ctx: Context): void {
  const git = (sessionId?: string) => createGitTools(workspaceRoot(ctx, sessionId));

  ctx.on(
    "tools/pre-execute",
    async (execution, next) => {
      const decision = await next();
      if (decision.kind !== "ask") return decision;
      const sessionId = sessionIdOfAgentRef(execution.agent as never);
      if (execution.name === "git_commit") {
        const message = stringArg(execution.arguments, "message");
        return { kind: "ask", reason: await git(sessionId).commitAskSummary(message) };
      }
      if (execution.name === "git_push") {
        return { kind: "ask", reason: await git(sessionId).pushAskSummary() };
      }
      return decision;
    },
    true,
  );

  ctx.tools.register(
    defineTool({
      name: "git_status",
      description: "Show the working tree status.",
      parameters: {},
      output,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        return toOutput(await git(sessionIdOfAgentRef(exec.agent)).status());
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "git_diff",
      description: "Show unstaged changes in the workspace.",
      parameters: {
        path: { type: "string", description: "Optional path to diff." },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return toOutput(await git(sessionIdOfAgentRef(exec.agent)).diff(args.path));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "git_branch",
      description: "List branches, or create a branch without switching to it.",
      parameters: {
        name: { type: "string", description: "Create this branch. Omit to list branches." },
      },
      output,
      async execute(args, exec) {
        if (args.name === undefined) return toOutput(await git(sessionIdOfAgentRef(exec.agent)).branchList());
        return toOutput(await git(sessionIdOfAgentRef(exec.agent)).branchCreate(args.name));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "git_checkout",
      description: "Check out a branch or commit.",
      parameters: {
        ref: { type: "string", required: true, description: "Branch or commit to check out." },
      },
      output,
      async execute(args, exec) {
        const result = await git(sessionIdOfAgentRef(exec.agent)).checkout(args.ref);
        if (result.error) throw new Error(result.error);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          status: result.status ?? 1,
          dirty: result.dirty,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "git_commit",
      description: "Stage all workspace changes and create a commit.",
      parameters: {
        message: { type: "string", required: true, description: "Commit message." },
      },
      output,
      async execute(args, exec) {
        return toOutput(await git(sessionIdOfAgentRef(exec.agent)).commit(args.message));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "git_push",
      description: "Push the current branch to a remote.",
      parameters: {
        remote: { type: "string", description: "Remote name. Defaults to the upstream remote." },
        branch: { type: "string", description: "Remote branch name." },
      },
      output,
      async execute(args, exec) {
        return toOutput(await git(sessionIdOfAgentRef(exec.agent)).push(args.remote, args.branch));
      },
    }),
  );
}

function workspaceRoot(ctx: Context, sessionId?: string): string {
  return sessionWorkspaceRoot(ctx, sessionId);
}

function toOutput(result: GitCommandResult): GitOutput {
  if (result.error) throw new Error(result.error);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1,
  };
}

function stringArg(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}
