import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isGitMetadataSegment, resolveInside } from "./paths.ts";

test("resolves existing files inside the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-paths-"));
  const file = path.join(root, "file.txt");
  fs.writeFileSync(file, "ok");

  assert.equal(resolveInside(root, "file.txt"), fs.realpathSync(file));
});

test("resolves a missing write target through its existing parent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-paths-"));

  assert.equal(
    resolveInside(root, "new-file.txt", { forWrite: true }),
    path.join(fs.realpathSync(root), "new-file.txt"),
  );
});

test("rejects parent traversal escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-paths-"));

  assert.equal(resolveInside(root, "../escape.txt", { forWrite: true }), null);
});

test("allows git metadata reads but denies git metadata writes", () => {
  const root = path.resolve(import.meta.dirname, "../../..");

  assert.equal(
    resolveInside(root, ".git/config"),
    fs.realpathSync(path.join(root, ".git", "config")),
  );
  assert.equal(resolveInside(root, ".git/hooks/x", { forWrite: true }), null);
});

test("matches Windows git metadata segments case-insensitively", () => {
  assert.equal(isGitMetadataSegment(".GIT", "C:\\work\\repo"), true);
  assert.equal(isGitMetadataSegment(".Git", "\\\\server\\share\\repo"), true);
  assert.equal(isGitMetadataSegment(".GIT", "/work/repo"), process.platform === "win32");
});

test(
  "allows .GIT reads but denies .GIT writes on Windows",
  { skip: process.platform !== "win32" },
  () => {
    const root = path.resolve(import.meta.dirname, "../../..");

    assert.equal(
      resolveInside(root, ".GIT/config"),
      fs.realpathSync(path.join(root, ".GIT", "config")),
    );
    assert.equal(resolveInside(root, ".GIT/config", { forWrite: true }), null);
  },
);

test("rejects symlink escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-paths-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "policy-outside-"));
  fs.symlinkSync(outside, path.join(root, "link"), "dir");

  assert.equal(resolveInside(root, "link", { forWrite: false }), null);
  assert.equal(resolveInside(root, "link/new.txt", { forWrite: true }), null);
});

test("rejects a path on another Windows drive", { skip: process.platform !== "win32" }, () => {
  const root = "C:\\work\\repo";
  assert.equal(resolveInside(root, "D:\\escape.txt", { forWrite: true }), null);
});
