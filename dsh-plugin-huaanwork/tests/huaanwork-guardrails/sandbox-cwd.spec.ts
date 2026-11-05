import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { apply, pinnedCwd } from "../../src/huaanwork-guardrails/sandbox-cwd.ts";
import {
  registerChildSession,
  resetChildSessionRegistry,
} from "../../src/huaanwork-host/child-sessions.ts";

type StubHeader = { id?: string; cwd?: string; parentSession?: string };
type StubOptions = { meta?: { cwd?: string; parentSession?: string } };

function createCtx(opened: string, roots: Map<string, string> = new Map()) {
  const created: unknown[] = [];
  const prepared: unknown[] = [];
  const ctx = {
    huaanworkWorkspaceRoot: { current: opened },
    huaanworkSessionRoots: roots,
    sessions: {
      create(_id?: string, options?: StubOptions) {
        created.push(options);
        return { header: options?.meta };
      },
      prepare(_id?: string, options?: StubOptions) {
        prepared.push(options);
        return { header: options?.meta };
      },
    },
    sandboxPolicy: {
      workspaceRoot: process.cwd(),
      resolve(request?: { session?: { header?: StubHeader } }) {
        return { mode: "workspace-write", workspaceRoot: request?.session?.header?.cwd ?? process.cwd() };
      },
    },
  };
  apply(ctx);
  return { ctx, created, prepared, roots };
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
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: { current: opened } }, nested), nested);
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
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: { current: opened } }, outside), opened);
  } finally {
    rmSync(opened, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("pinnedCwd reads huaanworkWorkspaceRoot.current live (holder contract)", () => {
  const first = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-holder-a-"));
  const second = mkdtempSync(join(tmpdir(), "huaanwork-sandbox-holder-b-"));
  const holder = { current: first };
  try {
    assert.notEqual(resolveSame(first), resolveSame(second));
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: holder }), first);
    holder.current = second;
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: holder }), second);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("a session allowed root rejects the foreground project", () => {
  const allowed = mkdtempSync(join(tmpdir(), "huaanwork-allowed-"));
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-foreground-"));
  const outside = mkdtempSync(join(tmpdir(), "huaanwork-outside-"));
  try {
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: { current: foreground } }, join(allowed, "a.txt"), allowed), join(allowed, "a.txt"));
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: { current: foreground } }, outside, allowed), allowed);
    assert.notEqual(pinnedCwd({ huaanworkWorkspaceRoot: { current: foreground } }, outside, allowed), foreground);
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(foreground, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a registered session root keeps its cwd for create and prepare", () => {
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-roots-foreground-"));
  const project = mkdtempSync(join(tmpdir(), "huaanwork-roots-project-"));
  const outside = mkdtempSync(join(tmpdir(), "huaanwork-roots-outside-"));
  const nested = join(project, "packages", "app");
  try {
    const roots = new Map([["session-a", project]]);
    const { ctx, created, prepared } = createCtx(foreground, roots);
    ctx.sessions.create("session-a", { meta: { cwd: project } });
    ctx.sessions.create("session-a", { meta: { cwd: nested } });
    ctx.sessions.create("session-a", { meta: { cwd: outside } });
    assert.equal((created[0] as { meta: { cwd: string } }).meta.cwd, project);
    assert.equal((created[1] as { meta: { cwd: string } }).meta.cwd, nested);
    assert.equal((created[2] as { meta: { cwd: string } }).meta.cwd, project);
    assert.notEqual((created[0] as { meta: { cwd: string } }).meta.cwd, foreground);
    ctx.sessions.prepare("session-a", { meta: { cwd: nested } });
    assert.equal((prepared[0] as { meta: { cwd: string } }).meta.cwd, nested);
  } finally {
    rmSync(foreground, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a child create inherits the root through meta.parentSession", () => {
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-child-foreground-"));
  const project = mkdtempSync(join(tmpdir(), "huaanwork-child-project-"));
  const outside = mkdtempSync(join(tmpdir(), "huaanwork-child-outside-"));
  const nested = join(project, "src");
  try {
    const roots = new Map([["session-a", project]]);
    const { ctx, created } = createCtx(foreground, roots);
    ctx.sessions.create("child-new", { meta: { cwd: nested, parentSession: "session-a" } });
    ctx.sessions.create("child-new", { meta: { cwd: outside, parentSession: "session-a" } });
    assert.equal((created[0] as { meta: { cwd: string } }).meta.cwd, nested);
    assert.equal((created[1] as { meta: { cwd: string } }).meta.cwd, project);
  } finally {
    rmSync(foreground, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("sandboxPolicy.resolve clamps to the session root table", () => {
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-resolve-foreground-"));
  const project = mkdtempSync(join(tmpdir(), "huaanwork-resolve-project-"));
  const outside = mkdtempSync(join(tmpdir(), "huaanwork-resolve-outside-"));
  const nested = join(project, "src");
  try {
    const roots = new Map([["session-a", project]]);
    const { ctx } = createCtx(foreground, roots);
    assert.equal(
      ctx.sandboxPolicy.resolve({ session: { header: { id: "session-a", cwd: nested } } }).workspaceRoot,
      nested,
    );
    assert.equal(
      ctx.sandboxPolicy.resolve({ session: { header: { id: "session-a", cwd: outside } } }).workspaceRoot,
      project,
    );
    assert.equal(
      ctx.sandboxPolicy.resolve({ session: { header: { id: "session-a" } } }).workspaceRoot,
      project,
    );
  } finally {
    rmSync(foreground, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("sandboxPolicy.resolve follows a registered child to the parent root", () => {
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-child-resolve-foreground-"));
  const project = mkdtempSync(join(tmpdir(), "huaanwork-child-resolve-project-"));
  const nested = join(project, "src");
  resetChildSessionRegistry();
  registerChildSession("session-a", "child-registered");
  try {
    const roots = new Map([["session-a", project]]);
    const { ctx } = createCtx(foreground, roots);
    assert.equal(
      ctx.sandboxPolicy.resolve({ session: { header: { id: "child-registered", cwd: nested } } }).workspaceRoot,
      nested,
    );
  } finally {
    resetChildSessionRegistry();
    rmSync(foreground, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("sandboxPolicy.resolve falls back to header.parentSession", () => {
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-parent-resolve-foreground-"));
  const project = mkdtempSync(join(tmpdir(), "huaanwork-parent-resolve-project-"));
  const nested = join(project, "src");
  try {
    const roots = new Map([["session-b", project]]);
    const { ctx } = createCtx(foreground, roots);
    assert.equal(
      ctx.sandboxPolicy.resolve({
        session: { header: { id: "unregistered-child", parentSession: "session-b", cwd: nested } },
      }).workspaceRoot,
      nested,
    );
  } finally {
    rmSync(foreground, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("an unregistered session without a parent keeps the foreground root", () => {
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-unbound-foreground-"));
  const nested = join(foreground, "src");
  try {
    const { ctx } = createCtx(foreground);
    assert.equal(
      ctx.sandboxPolicy.resolve({ session: { header: { id: "unbound", cwd: nested } } }).workspaceRoot,
      nested,
    );
    assert.equal(ctx.sandboxPolicy.resolve({ session: { header: { id: "unbound" } } }).workspaceRoot, foreground);
    assert.equal(ctx.sandboxPolicy.resolve().workspaceRoot, foreground);
  } finally {
    rmSync(foreground, { recursive: true, force: true });
  }
});

function resolveSame(path: string): string {
  return path;
}
