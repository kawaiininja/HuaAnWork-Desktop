import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { apply, pinnedCwd } from "../../src/huaanwork-guardrails/sandbox-cwd.ts";

function createCtx(opened: string) {
  const created: unknown[] = [];
  const prepared: unknown[] = [];
  const ctx = {
    huaanworkWorkspaceRoot: opened,
    sessions: {
      create(_id?: string, options?: { meta?: { cwd?: string } }) {
        created.push(options);
        return { header: options?.meta };
      },
      prepare(_id?: string, options?: { meta?: { cwd?: string } }) {
        prepared.push(options);
        return { header: options?.meta };
      },
    },
    sandboxPolicy: {
      workspaceRoot: process.cwd(),
      resolve(request?: { session?: { header?: { cwd?: string } } }) {
        return { mode: "workspace-write", workspaceRoot: request?.session?.header?.cwd ?? process.cwd() };
      },
    },
  };
  apply(ctx);
  return { ctx, created, prepared };
}

test("new session without cwd uses the opened folder, not process.cwd()", () => {
  const opened = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-open-"));
  try {
    assert.notEqual(resolveSame(opened), resolveSame(process.cwd()));
    const { ctx, prepared } = createCtx(opened);
    ctx.sessions.prepare("huaanwork");
    assert.equal((prepared[0] as { meta: { cwd: string } }).meta.cwd, opened);
    assert.equal(ctx.sandboxPolicy.resolve().workspaceRoot, opened);
    assert.equal(ctx.sandboxPolicy.workspaceRoot, opened);
  } finally {
    rmSync(opened, { recursive: true, force: true });
  }
});

test("persisted session keeps its stored cwd so the jsonl path still matches", () => {
  const opened = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-resume-"));
  const stored = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-stored-"));
  try {
    const { ctx, prepared } = createCtx(opened);
    ctx.sessions.prepare("huaanwork", {
      seedSource: "persistence",
      meta: { cwd: stored },
    });
    assert.equal((prepared[0] as { meta: { cwd: string } }).meta.cwd, stored);
    assert.equal(
      ctx.sandboxPolicy.resolve({ session: { header: { cwd: stored } } }).workspaceRoot,
      opened,
    );
  } finally {
    rmSync(opened, { recursive: true, force: true });
    rmSync(stored, { recursive: true, force: true });
  }
});

test("cwd inside the opened folder is kept for nested work", () => {
  const opened = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-nested-"));
  const nested = join(opened, "packages", "app");
  try {
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: opened }, nested), nested);
    const { ctx, created } = createCtx(opened);
    ctx.sessions.create("child", { meta: { cwd: nested } });
    assert.equal((created[0] as { meta: { cwd: string } }).meta.cwd, nested);
  } finally {
    rmSync(opened, { recursive: true, force: true });
  }
});

test("cwd outside the opened folder is jailed back to the opened folder", () => {
  const opened = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-jail-"));
  const outside = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-out-"));
  try {
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: opened }, outside), opened);
  } finally {
    rmSync(opened, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function resolveSame(path: string): string {
  return path;
}
