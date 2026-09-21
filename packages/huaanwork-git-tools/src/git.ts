import { spawn } from "node:child_process";

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
};

export type GitRun = (
  argv: readonly string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

export type GitToolsOptions = {
  run?: GitRun;
  env?: NodeJS.ProcessEnv;
};

export type GitCheckoutResult = GitCommandResult & { dirty: boolean };

export type GitTools = {
  status(): Promise<GitCommandResult>;
  diff(path?: string): Promise<GitCommandResult>;
  branchList(): Promise<GitCommandResult>;
  branchCreate(name: string): Promise<GitCommandResult>;
  checkout(ref: string): Promise<GitCheckoutResult>;
  commit(message: string): Promise<GitCommandResult>;
  push(remote?: string, branch?: string): Promise<GitCommandResult>;
  commitAskSummary(message: string): Promise<string>;
  pushAskSummary(): Promise<string>;
};

export function createGitTools(workspaceRoot: string, options: GitToolsOptions = {}): GitTools {
  const run: GitRun =
    options.run ?? ((argv) => spawnGit(argv, { cwd: workspaceRoot, ...(options.env !== undefined ? { env: options.env } : {}) }));

  const git = (argv: readonly string[]) => run(argv, { cwd: workspaceRoot });

  return {
    status: () => git(["status"]),
    diff: (path) => git(path === undefined ? ["diff"] : ["diff", path]),
    branchList: () => git(["branch"]),
    branchCreate: (name) => git(["branch", name]),
    checkout: async (ref) => {
      const porcelain = await git(["status", "--porcelain"]);
      if (porcelain.error) return { ...porcelain, dirty: false };
      const dirty = porcelain.status === 0 && porcelain.stdout.trim().length > 0;
      const result = await git(["checkout", ref]);
      return { ...result, dirty };
    },
    commit: async (message) => {
      const added = await git(["add", "-A"]);
      if (added.error || added.status !== 0) return added;
      return git(["commit", "-m", message]);
    },
    push: (remote, branch) => {
      const argv = ["push"];
      if (remote !== undefined) argv.push(remote);
      if (branch !== undefined) argv.push(branch);
      return git(argv);
    },
    commitAskSummary: async (message) => {
      const stat = commandText(await git(["diff", "--stat", "HEAD"]));
      const unstaged = commandText(await git(["status", "--porcelain", "-uall"]));
      return [message, stat, unstaged].filter((part) => part.length > 0).join("\n");
    },
    pushAskSummary: async () => commandText(await git(["status", "-sb"])),
  };
}

export function spawnGit(
  argv: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", [...argv], { cwd: options.cwd, env: options.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (result: GitCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        stdout: "",
        stderr: err.message,
        status: null,
        error: err.code === "ENOENT" ? "git is not available on PATH" : err.message,
      });
    });
    child.on("close", (status) => {
      finish({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
      });
    });
  });
}

function commandText(result: GitCommandResult): string {
  if (result.error) return result.error;
  const output = `${result.stdout}${result.stderr}`;
  return output.trimEnd();
}
