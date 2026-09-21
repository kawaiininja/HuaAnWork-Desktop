import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { createGitTools, type GitCommandResult, type GitRun } from "./git.ts";

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "huaanwork-git-"));
  assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.name", "Test"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root }).status, 0);
  return root;
}

function git(root: string, argv: string[]): string {
  const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeAndStage(root: string, name: string, contents: string): void {
  writeFileSync(join(root, name), contents);
  git(root, ["add", name]);
}

test("commit creates git log -1 with the message", async () => {
  const root = initRepo();
  try {
    writeAndStage(root, "README.md", "hello\n");
    const tools = createGitTools(root);
    const result = await tools.commit("feat: first commit");
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(root, ["log", "-1", "--pretty=%s"]), /feat: first commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit runs git add -A then git commit -m as argv", async () => {
  const recorded: string[][] = [];
  const run: GitRun = async (argv, options) => {
    recorded.push([...argv]);
    assert.equal(options.cwd, "/workspace");
    return { stdout: "", stderr: "", status: 0 };
  };
  const result = await createGitTools("/workspace", { run }).commit("feat: staged");
  assert.equal(result.status, 0);
  assert.deepEqual(recorded, [
    ["add", "-A"],
    ["commit", "-m", "feat: staged"],
  ]);
  assert.ok(!recorded.some((argv) => argv.includes("bash") || argv[0] === "-c"));
});

test("commit stages a new untracked file then records it in git log -1", async () => {
  const root = initRepo();
  try {
    writeFileSync(join(root, "untracked.txt"), "new file\n");
    const tools = createGitTools(root);
    const result = await tools.commit("feat: add untracked");
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(root, ["log", "-1", "--pretty=%s"]), /feat: add untracked/);
    assert.match(git(root, ["show", "--pretty=", "--name-only", "HEAD"]), /untracked\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("push is not called on the network; stub records argv", async () => {
  const root = initRepo();
  const recorded: string[][] = [];
  const run: GitRun = async (argv, options) => {
    recorded.push([...argv]);
    assert.equal(options.cwd, root);
    assert.ok(Array.isArray(argv));
    return { stdout: "stubbed\n", stderr: "", status: 0 };
  };
  try {
    const tools = createGitTools(root, { run });
    const result = await tools.push();
    assert.equal(result.status, 0);
    assert.deepEqual(recorded, [["push"]]);
    assert.ok(!recorded.some((argv) => argv.includes("bash") || argv[0] === "-c"));
    const remotes = spawnSync("git", ["remote"], { cwd: root, encoding: "utf8" });
    assert.equal(remotes.stdout.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkout on a dirty tree returns dirty: true", async () => {
  const root = initRepo();
  try {
    writeAndStage(root, "tracked.txt", "clean\n");
    git(root, ["commit", "-m", "init"]);
    writeFileSync(join(root, "tracked.txt"), "dirty\n");
    const tools = createGitTools(root);
    const result = await tools.checkout("HEAD");
    assert.equal(result.dirty, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit ask summary includes the message and git diff --stat HEAD", async () => {
  const root = initRepo();
  try {
    writeAndStage(root, "tracked.txt", "v1\n");
    git(root, ["commit", "-m", "init"]);
    writeAndStage(root, "tracked.txt", "v2\n");
    writeFileSync(join(root, "untracked.txt"), "new\n");
    const expectedStat = git(root, ["diff", "--stat", "HEAD"]);
    const expectedStatus = git(root, ["status", "--porcelain", "-uall"]);
    const tools = createGitTools(root);
    const summary = await tools.commitAskSummary("feat: update tracked");
    assert.match(summary, /feat: update tracked/);
    assert.ok(expectedStat.trim().length > 0);
    assert.ok(summary.includes(expectedStat.trim()));
    assert.match(expectedStatus, /\?\? untracked\.txt/);
    assert.ok(summary.includes(expectedStatus.trim()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("push ask summary is git status -sb", async () => {
  const root = initRepo();
  try {
    writeAndStage(root, "tracked.txt", "v1\n");
    git(root, ["commit", "-m", "init"]);
    const expected = git(root, ["status", "-sb"]);
    const tools = createGitTools(root);
    const summary = await tools.pushAskSummary();
    assert.equal(summary.trim(), expected.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git helpers fail with an error string when git is missing from PATH", async () => {
  const root = initRepo();
  try {
    const tools = createGitTools(root, { env: { PATH: "/nonexistent-huaanwork-git" } });
    const results: GitCommandResult[] = [
      await tools.status(),
      await tools.diff(),
      await tools.branchList(),
      await tools.branchCreate("topic"),
      await tools.checkout("HEAD"),
      await tools.commit("no git"),
      await tools.push(),
    ];
    for (const result of results) {
      assert.match(result.error ?? "", /git is not available on PATH/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
