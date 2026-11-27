import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { preExecuteExplained, type GuardMode, type ToolCall } from "@huaanwork/policy";
import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

import { isAgentToolAttached, isHostAttached, isMcpAttached, type AttachmentMaps } from "./agent-attachments.ts";
import { GIT_SNAPSHOT_BUDGET_MS } from "./git-budget.ts";
import { sessionWorkspaceRoot } from "./sandbox-cwd.ts";
import { parentSessionOf } from "../huaanwork-host/child-sessions.ts";
import { isKbOrganizeSessionId } from "../huaanwork-host/knowledge/session-ids.ts";

/**
 * 按会话挂载的创建/运行工具:智能体创建挂 agent_propose/agent_commit,`@slug` 运行
 * 链路挂 agent_skill_run/agent_http,对话创建技能挂 skill_propose/skill_commit。
 * 会话挂载的工具名都要在这里补 `attached`:两个创建链路与技能创建在 decide() 的
 * default 分支按档位 ask,智能体运行链路两个在显式分支附加即 allow;未挂载一律
 * deny,与 call_host_tool 同一纵深。
 *
 * `result_present` 是普通父会话的结果页工具:附件由 `agent/inbox/claimed` 按高级
 * 来源同步,decide() 的显式分支挂载即 allow(用户在场,不逐次审批)、未挂载一律
 * deny,自动化与包儿童经同一 `attached` 判定被拒绝。
 *
 * `expert_team_dispatch` 是专家团团长的派工工具:附件只在「进行中的团队回合」按
 * 团队运行、回合锚与租约挂载,与 `result_present` 同一显式分支;它不得进入全局
 * ALLOWED_TOOLS,普通 `@智能体` 会话的既有语义不变。
 *
 * `kb_org_get_delta` / `kb_org_read_doc` / `kb_org_mark_organized` 是知识库整理槽的
 * 三个宿主工具:整理会话没有审批界面、也绝不登记无人值守,所以同样走"挂载即 allow、
 * 未挂载 deny"的显式分支,永不落到 ask。
 */
const SESSION_ATTACHED_TOOLS: ReadonlySet<string> = new Set([
  "agent_propose",
  "agent_commit",
  "agent_skill_run",
  "agent_http",
  "skill_propose",
  "skill_commit",
  "result_present",
  "expert_team_dispatch",
  "kb_org_get_delta",
  "kb_org_read_doc",
  "kb_org_mark_organized",
]);

type ToolExecution = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:376
  name: string;
  arguments: unknown;
  callId?: string;
  agent?: { id?: string; session?: { id?: string } };
};

/**
 * 无人值守授权范围（Phase 2，方案 A）：只在 `runAgentTurn` 执行期间由 automations-host
 * 按本次运行的会话 id 写入共享表，运行结束即删除。
 */
export type UnattendedScope = { runId: string; automationId: string; allow: Set<string>; sessionId?: string };

/**
 * 按会话保存无人值守范围的容器（`holders.ts` 在 boot 时装一张空 Map）。
 *
 * 容器读写的坑（真实 Cordis 踩过，勿改回直接 `ctx.currentUnattended = ...`）：
 * Cordis 的 Context 是按 fiber 建的 Proxy，自定义属性只有在 boot 的 `prepare` 回调里
 * （fiber 尚未 active）赋值一次，才会真正落到所有插件共享的根 target 上，之后从任意插件的
 * 作用域读取都能命中；boot 完成后再对同一个属性重新赋值（如运行期 `ctx.foo = x`），
 * 从其他插件的 ctx 读回来会直接抛 `cannot get property "foo" without inject`——
 * `huaanworkAllowedOnce`/`huaanworkWorkspaceRoot` 之所以能读到，是因为它们只在 `prepare`
 * 里赋值过；per-run 会变的无人值守范围做不到「只赋值一次」，所以只能反过来：
 * boot 时赋值一次一个「容器」（`holders.ts` 装的是 `new Map()`），此后永远只 mutate
 * 容器里的条目——Map 本身是普通 JS 对象，不受 Cordis Proxy 管辖，读写不再受 inject 限制。
 * 容器缺席（旧调用方没装）按「没有无人值守运行」处理。
 *
 * 键是本次运行的会话 id；范围只接管该会话（及其已登记的子会话，见
 * {@link unattendedScopeFor}），并发运行的其它会话各查各的键。
 */
export type UnattendedHolder = Map<string, UnattendedScope>;

type Context = {
  huaanworkWorkspaceRoot?: { current: string };
  /** 会话 id → 本会话可写根;整理槽缺根由 `sessionWorkspaceRoot` fail closed。 */
  huaanworkSessionRoots?: Map<string, string>;
  huaanworkAllowedOnce?: Set<string>;
  /** 保留兼容旧调用方；护栏设置与审计已改由 huaanworkProfileDir 权威解析。 */
  huaanworkDshHome?: string;
  huaanworkProfileDir?: string;
  /** boot 时注入一次的空 Map，条目随每次 `runAgentTurn` 按会话写入/删除（见上方坑注释）。 */
  huaanworkUnattended?: UnattendedHolder;
  huaanworkAttachments?: AttachmentMaps;
  /** 智能体包回合绑定的子会话 id;policy 据此放行包自己挂载的 `mcp__*`。 */
  huaanworkPackageChildSessions?: Set<string>;
  /**
   * 按会话保存的链路工具白名单（Task 2 的 `ctx.huaanworkPackageChildAllow`）。
   * 有条目即限制集：条目外的工具在执行期直接拒绝，不受 schemas 收窄时序影响。
   * 只读限制集，不是存活性信号——条目缺席即无限制，现有判定不变。
   */
  huaanworkPackageChildAllow?: Map<string, readonly string[]>;
  /**
   * 按会话的显式工具白名单(知识库整理槽等;`holders.ts` 在 boot 时装一张空 Map)。
   * 有条目即限制集:条目外的工具在执行期直接拒绝,与 `present-as.ts` 的可见性
   * 收窄互相独立。只读限制集,不是存活性信号——条目缺席即无限制,现有判定不变。
   */
  huaanworkSessionToolAllow?: Map<string, readonly string[]>;
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
    // 名字集合判定:上游 schema 层会豁免 scope 自己注册的本地工具(如 structured_output),
    // 本检查不豁免 —— 血缘会话若真的请求 scope 本地工具,这里必须重新审查。
    const lineageAllow = ctx.huaanworkPackageChildAllow?.get(sessionIdOfAgentRef(execution.agent) ?? "");
    if (lineageAllow !== undefined && !lineageAllow.includes(execution.name)) {
      return { kind: "deny", reason: `huaanwork-policy: 智能体包链路会话不允许使用工具 ${execution.name}` };
    }
    // 会话级显式白名单与整理槽写目标附加检查:任一命中都直接拒绝,不看档位、不降级
    // 为无人值守,也不依赖 present-as 是否已经把工具从模型面收窄掉。
    const sessionDenial = sessionToolAllowDenial(ctx, execution);
    if (sessionDenial !== undefined) return { kind: "deny", reason: `huaanwork-policy: ${sessionDenial}` };
    const rootDenial = organizerRootDenial(ctx, execution);
    if (rootDenial !== undefined) return { kind: "deny", reason: `huaanwork-policy: ${rootDenial}` };
    const organizerDenial = organizerWriteDenial(ctx, execution);
    if (organizerDenial !== undefined) return { kind: "deny", reason: `huaanwork-policy: ${organizerDenial}` };
    const mode = readGuardMode(ctx.huaanworkProfileDir);
    const { decision, reason } = preExecuteExplained(toToolCall(execution, ctx), mode);
    // reason 面向模型：说明拒绝原因与可行替代（如「去掉管道拆成单条命令」），让模型能自我纠正，
    // 而不是对着一句 huaanwork-policy 脑补出「网络被封」「申请提权」之类的错误应对。
    if (decision === "deny") return { kind: "deny", reason: `huaanwork-policy: ${reason ?? "策略拒绝"}` };
    if (decision === "ask") {
      // Phase 2（方案 A）：命中本次执行所属会话的无人值守白名单则降级为 allow；未开启/未命中时
      // 原样返回 ask，行为与关闭时逐字节一致（不变量：unattended 不改变 ask 判定本身）。
      if (degradeIfUnattended(execution, ctx)) return { kind: "allow" };
      return { kind: "ask" };
    }
    return next();
  });

  ctx.tools.guard((execution) => {
    // 名字集合判定(与 pre-execute 同一语义):上游 schema 层豁免 scope 自己注册的本地工具,
    // 本检查不豁免 —— 血缘会话若真的请求 scope 本地工具,这里必须重新审查。
    const lineageAllow = ctx.huaanworkPackageChildAllow?.get(sessionIdOfAgentRef(execution.agent) ?? "");
    if (lineageAllow !== undefined && !lineageAllow.includes(execution.name)) {
      return `huaanwork-guard: 智能体包链路会话不允许使用工具 ${execution.name}`;
    }
    // 与 pre-execute 同一层判定:pre-execute 被 boot-overlay 剥离时,guard 仍独立拒绝。
    const sessionDenial = sessionToolAllowDenial(ctx, execution);
    if (sessionDenial !== undefined) return `huaanwork-guard: ${sessionDenial}`;
    const rootDenial = organizerRootDenial(ctx, execution);
    if (rootDenial !== undefined) return `huaanwork-guard: ${rootDenial}`;
    const organizerDenial = organizerWriteDenial(ctx, execution);
    if (organizerDenial !== undefined) return `huaanwork-guard: ${organizerDenial}`;
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
 * 会话级显式白名单的执行期判定(知识库整理槽等)。`present-as.ts` 收窄模型面只是
 * 第一层:附件/上游 scope 都可能把工具重新挂回来,执行侧必须读同一份名单再判一次。
 * 没有本会话条目即不限制,既有会话判定逐字节不变。
 */
function sessionToolAllowDenial(ctx: Pick<Context, "huaanworkSessionToolAllow">, execution: ToolExecution): string | undefined {
  const sessionAllow = ctx.huaanworkSessionToolAllow?.get(sessionIdOfAgentRef(execution.agent) ?? "");
  if (sessionAllow === undefined) return undefined;
  if (sessionAllow.includes(execution.name)) return undefined;
  return `工具 ${execution.name} 不在当前会话的工具白名单内：请改用白名单内的工具`;
}

/** 整理会话向平台临时目录写入的拒绝原因(面向模型的整改建议)。 */
export const REASON_ORGANIZER_TEMP =
  "知识库整理会话不允许写入操作系统临时目录：请改为写入知识库 wiki/ 目录内的路径";

/** 整理会话向符号链接(含指向库外的悬空链接)写入的拒绝原因。 */
export const REASON_ORGANIZER_SYMLINK =
  "知识库整理会话只允许写入库内普通文件路径：符号链接（含指向库外的悬空链接）一律拒绝";

/** 整理会话缺少登记可写根时的拒绝原因(宿主侧不变量失败:只陈述事实,模型无从整改)。 */
export const REASON_ORGANIZER_ROOT_MISSING =
  "knowledge-organize-root-missing：知识库整理会话缺少登记的可写根，无法判定路径边界，本次调用拒绝";

/**
 * 整理槽缺登记根的具名拒绝,在两层策略缝里先于任何根推导执行。
 *
 * 不这样做的话 `organizerWriteDenial`(write/edit)与 `toToolCall`(全部工具)都会经
 * `sessionWorkspaceRoot` 抛 `knowledge-organize-root-missing` 穿过监听层;只在其中一处
 * 窄捕获会把错误契约劈成两半。判据与 `sessionWorkspaceRoot` 的整理分支一致:只认本
 * 会话的非空登记根。主链路不可达(执行器在 createAgent 前写根、dispose 后才清)。
 */
function organizerRootDenial(
  ctx: Pick<Context, "huaanworkSessionRoots">,
  execution: ToolExecution,
): string | undefined {
  const sessionId = sessionIdOfAgentRef(execution.agent) ?? "";
  if (!isKbOrganizeSessionId(sessionId)) return undefined;
  const root = ctx.huaanworkSessionRoots?.get(sessionId);
  return root !== undefined && root.length > 0 ? undefined : REASON_ORGANIZER_ROOT_MISSING;
}

/** 写工具落盘前要核对的路径参数键(与 `@huaanwork/policy` 的 `pathsAreInside` 同集合)。 */
const WRITE_PATH_KEYS = ["path", "file", "file_path", "root"] as const;

/**
 * 知识库整理槽的写目标附加检查(规格 §5.3 第 2 条):OS 临时目录与符号链接。
 *
 * 为什么不放进 `@huaanwork/policy`:`decide.ts` 保持纯判定、零平台依赖;临时目录
 * 与 `lstat` 需要真实文件系统,放在宿主护栏层。
 *
 * 为什么必须有:`resolveInside` 已经拒绝目标仍存在的越界链接,但 `forWrite` 分支对
 * 不存在的目标会退到父目录做 `realpath`,`wiki/` 内一条**悬空**符号链接因此能被解析
 * 成"库内路径"而放行——写下去就等于在库外建文件。`lstat` 不跟随链接,能看见它;
 * 也不能用 `stat`,悬空链接的 `stat` 同样是 ENOENT。
 *
 * 临时目录判定只覆盖"库根之外"的目标:便携安装或测试会把库根放在平台临时目录下,
 * 库内写入仍由 `resolveInside(wikiRoot)` 收口。
 */
export function organizerWriteDenial(
  ctx: Pick<Context, "huaanworkSessionRoots" | "huaanworkWorkspaceRoot">,
  execution: ToolExecution,
): string | undefined {
  if (execution.name !== "write" && execution.name !== "edit") return undefined;
  const sessionId = sessionIdOfAgentRef(execution.agent);
  if (!isKbOrganizeSessionId(sessionId)) return undefined;
  const root = sessionWorkspaceRoot(ctx, sessionId);
  const args = objectArgs(execution.arguments);
  for (const key of WRITE_PATH_KEYS) {
    const candidate = args[key];
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const target = resolve(root, candidate);
    if (isInsidePath(tmpdir(), target) && !isInsidePath(root, target)) return REASON_ORGANIZER_TEMP;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(target);
    } catch (error) {
      // ENOENT 表示"链接本身不存在"的新文件:继续走 decide.ts 的路径判定。
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
      // 其余错误无法证明目标不是链接:fail closed。
      return REASON_ORGANIZER_SYMLINK;
    }
    if (stats.isSymbolicLink()) return REASON_ORGANIZER_SYMLINK;
  }
  return undefined;
}

function isInsidePath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 取本次执行所属会话的无人值守范围。会话自己没有条目时沿 `registerChildSession`
 * 的登记表回退一层到父会话：自动化运行派生的子代理沿用父会话的范围，其它会话不受影响。
 *
 * @param scopes boot 时注入的按会话容器；缺席即没有无人值守运行
 * @param sessionId 本次执行所属会话；缺席（执行上下文没有 agent）时不可命中
 * @returns 该会话（或已登记的父会话）的运行范围，未命中时为 `undefined`
 */
export function unattendedScopeFor(
  scopes: UnattendedHolder | undefined,
  sessionId: string | undefined,
): UnattendedScope | undefined {
  if (!scopes || sessionId === undefined) return undefined;
  const direct = scopes.get(sessionId);
  if (direct) return direct;
  const parent = parentSessionOf(sessionId);
  return parent === undefined ? undefined : scopes.get(parent);
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
  const unattended = unattendedScopeFor(ctx.huaanworkUnattended, sessionIdOfAgentRef(execution.agent));
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
  const workspaceRoot = sessionWorkspaceRoot(ctx, sessionIdOfAgentRef(execution.agent));
  const args = objectArgs(execution.arguments);
  let attached: boolean | undefined = undefined;
  let packageRuntime: boolean | undefined = undefined;
  if (execution.name === "call_host_tool") {
    const sessionId = sessionIdOfAgentRef(execution.agent);
    const toolName = typeof args.name === "string" ? args.name : "";
    attached = isHostAttached(ctx.huaanworkAttachments, sessionId, toolName);
  } else if (execution.name.startsWith("mcp__")) {
    const sessionId = sessionIdOfAgentRef(execution.agent);
    attached = isMcpAttached(ctx.huaanworkAttachments, sessionId, execution.name);
    // 包运行子会话没有审批界面:标记出来让 decide() 放行它自己挂载的 MCP 工具。
    packageRuntime = sessionId !== undefined && ctx.huaanworkPackageChildSessions?.has(sessionId) === true;
  } else if (SESSION_ATTACHED_TOOLS.has(execution.name)) {
    const sessionId = sessionIdOfAgentRef(execution.agent);
    attached = isAgentToolAttached(ctx.huaanworkAttachments, sessionId, execution.name);
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
    ...(packageRuntime !== undefined ? { packageRuntime } : {}),
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
    // Not a repository (git exits 128) and git-not-installed (ENOENT) are the
    // pre-existing "nothing to lose" cases: they stay clean, not dirty.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
    // No exit status at all means the probe timed out or was killed before git
    // could answer. We do not know whether the tree is clean, so fail closed:
    // a dirty `git_checkout` must still reach the ask path.
    if (result.status === null) return true;
    return result.status === 0 && (result.stdout ?? "").trim().length > 0;
  } catch {
    // An exception means the probe itself is unknown: fail closed like a timeout.
    return true;
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
