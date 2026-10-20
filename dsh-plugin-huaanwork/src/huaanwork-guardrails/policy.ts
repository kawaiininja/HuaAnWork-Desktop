import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { preExecuteExplained, type GuardMode, type ToolCall } from "@huaanwork/policy";
import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

import { isHostAttached, isMcpAttached, type AttachmentMaps } from "./agent-attachments.ts";
import { GIT_SNAPSHOT_BUDGET_MS } from "./git-budget.ts";

type ToolExecution = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:376
  name: string;
  arguments: unknown;
  callId?: string;
  agent?: { id?: string; session?: { id?: string } };
};

/** 无人值守授权范围（Phase 2，方案 A）：只在 `runAgentTurn` 执行期间由 host.ts 设置。 */
type UnattendedScope = { runId: string; automationId: string; allow: Set<string>; sessionId?: string };

/**
 * `.current` 的读写坑（真实 Cordis 踩过，勿改回直接 `ctx.currentUnattended = ...`）：
 * Cordis 的 Context 是按 fiber 建的 Proxy，自定义属性只有在 boot 的 `prepare` 回调里
 * （fiber 尚未 active）赋值一次，才会真正落到所有插件共享的根 target 上，之后从任意插件的
 * 作用域读取都能命中；boot 完成后再对同一个属性重新赋值（如运行期 `ctx.foo = x`），
 * 从其他插件的 ctx 读回来会直接抛 `cannot get property "foo" without inject`——
 * `huaanworkAllowedOnce`/`huaanworkWorkspaceRoot` 之所以能读到，是因为它们只在 `prepare`
 * 里赋值过；per-run 会变的 `currentUnattended` 做不到「只赋值一次」，所以只能反过来：
 * boot 时赋值一次一个「容器」（`{ current: undefined }`），此后永远只 mutate 容器的
 * `.current` 字段——容器本身是普通 JS 对象，不受 Cordis Proxy 管辖，读写不再受 inject 限制。
 */
type UnattendedHolder = { current?: UnattendedScope };

type Context = {
  huaanworkWorkspaceRoot?: { current: string };
  huaanworkAllowedOnce?: Set<string>;
  /** 保留兼容旧调用方；护栏设置与审计已改由 huaanworkProfileDir 权威解析。 */
  huaanworkDshHome?: string;
  huaanworkProfileDir?: string;
  /** boot 时注入一次的容器，`.current` 随每次 `runAgentTurn` 变化（见上方坑注释）。 */
  huaanworkUnattended?: UnattendedHolder;
  huaanworkAttachments?: AttachmentMaps;
  on(
    event: "tools/pre-execute",
    listener: (
      execution: ToolExecution,
      next: () => Promise<{ kind: "allow" }>,
    ) => Promise<{ kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason?: string }>,
  ): void;
  tools: {
    guard(listener: (execution: ToolExecution) => string | undefined): () => void;
  };
};

export const inject = ["tools"];

/**
 * 读取护栏策略档位。存储根是 profile 目录(`huaanwork-settings.json` 由 host 的
 * settings route 写入同一处),不是 DSH_HOME——旧 Tauri 时代 settings.json 住在
 * `dirname($DSH_HOME)`,DSH_HOME 移到 `~/.huaanwork` 后那个表达式会静默指向用户 HOME。
 */
export function readGuardMode(profileDir: string | undefined): GuardMode {
  if (!profileDir) return "ask";
  try {
    const parsed = JSON.parse(readFileSync(join(profileDir, "huaanwork-settings.json"), "utf8")) as Record<string, unknown>;
    return parsed.guard_mode === "smart" || parsed.guard_mode === "full" ? parsed.guard_mode : "ask";
  } catch {
    return "ask";
  }
}

export function apply(ctx: Context): void {
  ctx.on("tools/pre-execute", async (execution, next) => {
    const mode = readGuardMode(ctx.huaanworkProfileDir);
    const { decision, reason } = preExecuteExplained(toToolCall(execution, ctx), mode);
    // reason 面向模型：说明拒绝原因与可行替代（如「去掉管道拆成单条命令」），让模型能自我纠正，
    // 而不是对着一句 huaanwork-policy 脑补出「网络被封」「申请提权」之类的错误应对。
    if (decision === "deny") return { kind: "deny", reason: `huaanwork-policy: ${reason ?? "策略拒绝"}` };
    if (decision === "ask") {
      // Phase 2（方案 A）：命中当前运行的无人值守白名单则降级为 allow；未开启/未命中时
      // 原样返回 ask，行为与关闭时逐字节一致（不变量：unattended 不改变 ask 判定本身）。
      if (degradeIfUnattended(execution, ctx)) return { kind: "allow" };
      return { kind: "ask" };
    }
    return next();
  });

  ctx.tools.guard((execution) => {
    const mode = readGuardMode(ctx.huaanworkProfileDir);
    const call = toToolCall(execution, ctx);
    // guard 的 deny 集合 == pre-execute 的 deny ∪ would-be-ask（guard 不能表达 ask），
    // 故只看 pre-execute 一档判定即可，两档语义与改造前逐字节一致。
    const { decision, reason } = preExecuteExplained(call, mode);
    if (decision === "ask") {
      const callId = execution.callId;
      if (typeof callId === "string" && ctx.huaanworkAllowedOnce?.delete(callId)) {
        return undefined;
      }
      return "huaanwork-guard: 该操作需要人工审批且尚未获得批准";
    }
    return decision === "deny" ? `huaanwork-guard: ${reason ?? "策略拒绝"}` : undefined;
  });
}

/**
 * pre-execute 判定为 ask 时的无人值守降级（Phase 2，方案 A）。命中白名单时把
 * `execution.callId` 写进 `ctx.huaanworkAllowedOnce`——这正是 approval.ts 拿到
 * `allowed-once` 结果时做的事，`guard()` 已有的 `huaanworkAllowedOnce.delete` 分支据此
 * 自然放行，**guard 一行不改**。不变量 4 完整保留：若 pre-execute 被 boot-overlay 篡改
 * 剥离，没人往 allowedOnce 里写，guard 依旧对 would-be-ask 调用返回 deny。
 * 没有 callId 的调用无法安全降级（guard 无法按 callId 精确核销一次性放行），原样走 ask。
 */
function degradeIfUnattended(execution: ToolExecution, ctx: Context): boolean {
  const unattended = ctx.huaanworkUnattended?.current;
  const callId = execution.callId;
  if (!unattended || typeof callId !== "string" || !unattended.allow.has(execution.name)) return false;
  ctx.huaanworkAllowedOnce ??= new Set();
  ctx.huaanworkAllowedOnce.add(callId);
  writeUnattendedAudit(ctx, unattended, execution.name, callId);
  return true;
}

/**
 * 审计文件保留的最大行数：与运行历史 `RUNS_LIMIT`（sidecar 的 automations.ts）同一量级，
 * 防止长期启用无人值守的任务把审计文件无限撑大（review finding 4）。超过时丢弃最旧的行，
 * 语义上对齐 `appendRun` 对运行历史的裁剪方式。
 */
const AUDIT_LINES_LIMIT = 50;

/**
 * 降级审计行：`<profileDir>/automations/<automationId>.audit.jsonl`，一次降级一行，超过
 * {@link AUDIT_LINES_LIMIT} 时裁掉最旧的行（整文件重写，与 appendRun 对运行历史的处理一致）。
 * 不含工具参数正文（参数可能带路径与内容，对齐「自动化本身不另存凭证」的克制）。
 * `huaanworkProfileDir` 未注入或读写失败都静默跳过——审计是事后可追溯性，不是工具执行的前置条件。
 */
export function writeUnattendedAudit(
  ctx: Pick<Context, "huaanworkProfileDir">,
  unattended: Pick<UnattendedScope, "runId" | "automationId" | "sessionId">,
  tool: string,
  callId: string,
): void {
  const profileDir = ctx.huaanworkProfileDir;
  if (!profileDir) return;
  try {
    // 与 huaanwork-host/stores.ts 的 auditPath 同源:级联删除按 profileDir 找,
    // 写侧必须落同一处,否则审计文件永不被清理(G5)。
    const dir = join(profileDir, "automations");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${unattended.automationId}.audit.jsonl`);
    const line = {
      at: Date.now(),
      runId: unattended.runId,
      ...(unattended.sessionId === undefined ? {} : { sessionId: unattended.sessionId }),
      tool,
      callId,
      decision: "ask→allow",
    };
    const existing = readExistingAuditLines(path);
    const trimmed = [...existing, JSON.stringify(line)].slice(-AUDIT_LINES_LIMIT);
    writeFileSync(path, `${trimmed.join("\n")}\n`, "utf8");
  } catch {
    // 静默降级：磁盘错误等不得反过来影响工具执行路径。
  }
}

/** 读已有审计行（去掉空行）；文件不存在或损坏都返回空数组，绝不让审计路径反过来炸掉工具执行。 */
function readExistingAuditLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function toToolCall(execution: ToolExecution, ctx: Context): ToolCall {
  const workspaceRoot = ctx.huaanworkWorkspaceRoot?.current ?? process.cwd();
  const args = objectArgs(execution.arguments);
  let attached: boolean | undefined = undefined;
  if (execution.name === "call_host_tool") {
    const sessionId = sessionIdOfAgentRef(execution.agent);
    const toolName = typeof args.name === "string" ? args.name : "";
    attached = isHostAttached(ctx.huaanworkAttachments, sessionId, toolName);
  } else if (execution.name.startsWith("mcp__")) {
    const sessionId = sessionIdOfAgentRef(execution.agent);
    attached = isMcpAttached(ctx.huaanworkAttachments, sessionId, execution.name);
  }
  return {
    name: execution.name,
    args,
    workspaceRoot,
    // gitDirty 只有 decide() 的 git_checkout 分支读取(packages/huaanwork-policy/
    // src/decide.ts 的 case "git_checkout"),其余工具一律不读。原版对每次工具调用
    // 都同步 spawn 一个 `git status`,是热路径纯开销;2026-10-16 复核 F-2 裁定保留
    // 本收窄——所有可达判定与原版逐字等价,probe 回归钉在 policy.cordis.spec.ts。
    gitDirty: execution.name === "git_checkout" ? isGitDirty(workspaceRoot) : false,
    ...(attached !== undefined ? { attached } : {}),
  };
}

export function isGitDirty(workspaceRoot: string): boolean {
  try {
    const result = spawnSync("git", ["status", "--porcelain"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      // Same liveness budget as the bridge snapshot: an untimed status on a huge
      // tree would hold the Host loop past the 2 s probe and look like a hang.
      timeout: GIT_SNAPSHOT_BUDGET_MS,
    });
    return result.status === 0 && (result.stdout ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
