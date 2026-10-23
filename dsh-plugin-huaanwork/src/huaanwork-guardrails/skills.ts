import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_AGENT_ALLOW as EXPLORE_TOOLS } from "@huaanwork/policy/agent-catalog";
import { currentCallerSession, forgetChildSession, registerChildSession } from "../huaanwork-host/child-sessions.ts";
import { attachAgentTools, type AttachmentMaps } from "./agent-attachments.ts";
import { refreshAgentRestrict } from "./present-as.ts";
import type { AgentPackageSubagentRequest } from "../huaanwork-host/agent-package/types.ts";

export const name = "huaanwork-skills";
export const inject = ["skills", "agents", "tools", "subagents"];

export { EXPLORE_TOOLS };
export const TEST_FIX_BASE_TOOLS = [
  "read",
  "read_file",
  "glob",
  "grep",
  "edit",
  "write",
  "str_replace_editor",
] as const;

export type SkillKind = "explore" | "test-fix";

type ToolsService = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:485(ToolRestriction)
  restrict?(filter: { allow: readonly string[] }): () => void;
  schemas?(): readonly { name?: string }[];
  guard?(listener: (execution: { name: string; arguments: unknown }) => string | undefined): () => void;
};

type Agent = {
  ctx?: {
    get?(name: string): ToolsService | undefined;
  };
  session?: { header?: { parentSession?: unknown } };
};

type SkillRegistration = {
  name: string;
  description: string;
  content: string;
  source: "runtime" | "bundled";
  resourceBase?: { kind: "directory"; path: string };
};

type Context = { // 上游未导出;已逐字比对 0.1.6-alpha.2:Cordis ctx 跨 skills/agents/tools/subagents 四服务,无统一类型导出
  skills: {
    register(skill: SkillRegistration): () => void;
  };
  agents?: {
    get?(id: string): Agent | undefined;
    list?(): readonly Agent[];
  };
  subagents?: {
    start(...args: never[]): Promise<{ localAgent?: Agent }>;
    startActivation?(...args: never[]): Promise<unknown>;
  };
  huaanworkAgentRequest?: {
    current?: {
      name: string;
      allow: string[];
      persona: string;
    } | undefined;
  };
  /** `@slug` 包回合请求;dispatch 在 start 之前写入,本包装在 start 之后消费。 */
  huaanworkAgentPackageRequest?: { current?: AgentPackageSubagentRequest | null };
  /** 会话工具附件表;包运行时工具与 MCP 名字按子会话挂载。 */
  huaanworkAttachments?: AttachmentMaps;
  on(
    event: "tools/pre-execute" | "agent/created" | "subagent/start" | "subagent/end" | "tools/change",
    listener: (...args: never[]) => unknown,
    prepend?: boolean,
  ): void;
};

const kinds = new WeakMap<object, SkillKind>();

export function skillKindOf(agent: object | undefined): SkillKind | undefined {
  return agent ? kinds.get(agent) : undefined;
}

export function shellToolName(platform = process.platform): "pwsh" | "bash" {
  return platform === "win32" ? "pwsh" : "bash";
}

export function exploreAllowList(existing: readonly string[]): string[] {
  return EXPLORE_TOOLS.filter((name) => existing.includes(name));
}

export type ExploreTurnEntry = { scope: "child" | "parent"; text: string };

/** 子代理中间步骤留在 child 日志;父会话只拼接 parent 范围的结论。 */
export function parentVisibleExploreTranscript(entries: readonly ExploreTurnEntry[]): string {
  return entries.filter((entry) => entry.scope === "parent").map((entry) => entry.text).join("");
}

export function testFixAllowList(existing: readonly string[], platform = process.platform): string[] {
  return [...TEST_FIX_BASE_TOOLS, shellToolName(platform)].filter((name) => existing.includes(name));
}

export function wantedTools(kind: SkillKind, platform = process.platform): readonly string[] {
  return kind === "explore" ? EXPLORE_TOOLS : [...TEST_FIX_BASE_TOOLS, shellToolName(platform)];
}

let bundledSkillContext: Context | null = null;

export function getBundledSkillRegistrar(): Context | null {
  return bundledSkillContext;
}

export function setBundledSkillRegistrar(ctx: Context | null): void {
  bundledSkillContext = ctx;
}

export function apply(ctx: Context): void {
  bundledSkillContext = ctx;
  const pendingByAgent = new WeakMap<object, SkillKind>();
  const tracked = new Set<Agent>();
  const lifted = new WeakMap<Agent, () => void>();
  let pendingSpawn: SkillKind | undefined;
  let restricting = false;
  // subagent/start 在 start 的异步链内同步派发且载荷不带 parent；按调用隔离，重叠的 start 不会互相覆盖。
  const startParent = new AsyncLocalStorage<string | undefined>();

  ctx.skills.register(loadSkill("explore.md"));
  ctx.skills.register(loadSkill("test-fix.md"));

  const rememberSkill = (execution: { name: string; arguments: unknown; agent?: object }) => {
    if (execution.name !== "skill" || !execution.agent) return;
    const skillName = stringArg(execution.arguments, "name");
    if (skillName === "explore" || skillName === "test-fix") {
      pendingByAgent.set(execution.agent, skillName);
    }
  };

  const rememberSubagentSpawn = (execution: { name: string; arguments: unknown; agent?: object }) => {
    if (execution.name !== "subagent" || !execution.agent) return;
    const kind = pendingByAgent.get(execution.agent);
    if (kind) pendingSpawn = kind;
  };

  const restrictKind = (agent: Agent, kind: SkillKind) => {
    const tools = agent.ctx?.get?.("tools");
    if (!tools) return;
    lifted.get(agent)?.();
    const existing = (tools.schemas?.() ?? []).flatMap((schema) => (schema.name ? [schema.name] : []));
    const allow = kind === "explore" ? exploreAllowList(existing) : testFixAllowList(existing);
    if (allow.length === 0) return;
    lifted.set(agent, tools.restrict?.({ allow }) ?? (() => undefined));
  };

  const applyKind = (agent: Agent, kind: SkillKind) => {
    if (kinds.has(agent)) return;
    kinds.set(agent, kind);
    tracked.add(agent);
    restrictKind(agent, kind);
    const tools = agent.ctx?.get?.("tools");
    const allowed = new Set(wantedTools(kind));
    tools?.guard?.((execution) => (allowed.has(execution.name) ? undefined : `huaanwork-${kind}`));
  };

  const consumePendingSpawn = (agent: Agent) => {
    if (!pendingSpawn) return;
    if (pendingByAgent.has(agent)) return;
    applyKind(agent, pendingSpawn);
    pendingSpawn = undefined;
  };

  ctx.on(
    "tools/pre-execute",
    (async (
      execution: { name: string; arguments: unknown; agent?: object },
      next: () => Promise<{ kind: string; reason?: string }>,
    ) => {
      rememberSkill(execution);
      rememberSubagentSpawn(execution);
      const kind = skillKindOf(execution.agent);
      if (kind && !wantedTools(kind).includes(execution.name)) {
        return { kind: "deny", reason: `huaanwork-${kind}` };
      }
      return next();
    }) as never,
    true,
  );

  ctx.on("agent/created", (({ agent }: { agent: Agent }) => {
    consumePendingSpawn(agent);
  }) as never);

  ctx.on("subagent/start", ((info: { id?: string }) => {
    if (!info.id) return;
    const child = ctx.agents?.get?.(info.id);
    // 事件载荷只有 { runId, provider, id, local },没有 parent;父会话取自子会话 header,
    // 冷恢复路径靠它,start 包装路径靠下面的 AsyncLocalStorage。
    const parentId = sessionIdOf(child?.session?.header?.parentSession) ?? startParent.getStore();
    if (parentId && parentId !== info.id) registerChildSession(parentId, info.id);
    if (child) consumePendingSpawn(child);
  }) as never);

  // 与 subagent/start 成对的结束事件(载荷 id 即子会话 id):子会话结束后从登记表摘掉,
  // 否则取消父会话时会对已经退出的会话重复发起取消,登记表也无界增长。
  ctx.on("subagent/end", ((info: { id?: string }) => {
    if (typeof info.id === "string" && info.id.length > 0) forgetChildSession(info.id);
  }) as never);

  ctx.on("tools/change", (() => {
    if (restricting) return;
    restricting = true;
    try {
      for (const agent of tracked) {
        const kind = kinds.get(agent);
        if (kind) restrictKind(agent, kind);
      }
    } finally {
      restricting = false;
    }
  }) as never);

  const start = ctx.subagents?.start;
  if (start && ctx.subagents) {
    const original = start.bind(ctx.subagents);
    ctx.subagents.start = async (...args: never[]) => {
      // 在 await 之前取快照:dispatch 的 finally 会在 run 结束后清空容器。
      const pkg = ctx.huaanworkAgentPackageRequest?.current;
      try {
        const current = ctx.huaanworkAgentRequest?.current;
        if (current) {
          if (!current.persona || current.persona.trim() === "") {
            throw new Error("智能体人设为空");
          }
        }
        // 调用形态以探针 3 核实的 (name, request) 签名为准（dispatchAt 显式传 parent/signal），直通不改写。
        // 事件载荷没有 parent；父会话 id 取这次 start 的 parent，缺省用发起调用的用户会话。
        const parentFromCall = sessionIdOf(parentFromStartArgs(args)) ?? currentCallerSession();
        const run: any = await startParent.run(parentFromCall, () => original(...args));
        if (current && run?.localAgent) {
          const tools = run.localAgent.ctx?.get?.("tools");
          const schemas = tools?.schemas?.() ?? [];
          const existing = schemas.flatMap((s: { name?: string }) => (s.name ? [s.name] : []));
          const allow = current.allow.filter((name) => existing.includes(name));
          tools?.restrict?.({ allow });
        }
        if (pkg && run?.localAgent) {
          // header.id 是真实子会话 id;某些 provider 只填 agent/session id,故再回落一次。
          const childSessionId =
            sessionIdOf(run.localAgent.session?.header ?? run.localAgent) ?? sessionIdOf(run.localAgent);
          if (childSessionId) {
            if (ctx.huaanworkAttachments) {
              attachAgentTools(ctx.huaanworkAttachments, childSessionId, ["agent_http", "agent_skill_run"]);
            }
            // bindChild 同时把 MCP 工具名挂到子会话。必须先于 refreshAgentRestrict:
            // present-as 只在附件里找非 ALLOWED_TOOLS 的名字,晚挂会让它先前算出的
            // restrict 继续遮住 mcp__*。
            pkg.bindChild(childSessionId);
            refreshAgentRestrict(ctx as never, childSessionId);
          }
          const tools = run.localAgent.ctx?.get?.("tools");
          const schemas = tools?.schemas?.() ?? [];
          const existing = schemas.flatMap((s: { name?: string }) => (s.name ? [s.name] : []));
          const allow = pkg.allow.filter((name) => existing.includes(name));
          tools?.restrict?.({ allow });
        }
        if (run?.localAgent) {
          consumePendingSpawn(run.localAgent);
        }
        if (run && typeof run.result?.then === "function") {
          await run.result;
        }
        return run;
      } finally {
        if (ctx.huaanworkAgentRequest) {
          ctx.huaanworkAgentRequest.current = undefined;
        }
        if (ctx.huaanworkAgentPackageRequest) {
          ctx.huaanworkAgentPackageRequest.current = null;
        }
      }
    };
  }

  const activation = ctx.subagents?.startActivation;
  if (activation && ctx.subagents) {
    const originalActivation = activation.bind(ctx.subagents);
    ctx.subagents.startActivation = async (...args: never[]) => {
      const parentFromCall = sessionIdOf(parentFromStartArgs(args)) ?? currentCallerSession();
      return startParent.run(parentFromCall, () => originalActivation(...args));
    };
  }
}

function sessionIdOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; session?: { id?: unknown } };
  if (typeof record.session?.id === "string" && record.session.id.length > 0) return record.session.id;
  if (typeof record.id === "string" && record.id.length > 0 && record.id !== "huaanwork") return record.id;
  return undefined;
}

function parentFromStartArgs(args: readonly unknown[]): unknown {
  const second = args[1];
  if (second && typeof second === "object" && "parent" in second) return (second as { parent?: unknown }).parent;
  const first = args[0];
  if (!first || typeof first !== "object") return undefined;
  const spec = first as { parent?: unknown; request?: { parent?: unknown } };
  return spec.request?.parent ?? spec.parent;
}

export type BundledSkillInfo = { name: string; description: string };

/** List bundled skills (name + description from frontmatter) for the 技能中心 UI. */
export function listBundledSkills(): BundledSkillInfo[] {
  const skills: BundledSkillInfo[] = [];
  for (const entry of scanBundledSkillEntries()) {
    try {
      const parsed = parseSkillMarkdown(readFileSync(entry.path, "utf8"));
      if (!parsed.name || !parsed.description) continue;
      skills.push({ name: parsed.name, description: parsed.description });
    } catch {
      // 不可读条目跳过（与 skills-host 的 warn+skip 语义对齐）
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function loadSkill(fileName: string): SkillRegistration {
  const raw = readFileSync(join(BUNDLED_SKILLS_ROOT, fileName), "utf8");
  const parsed = parseSkillMarkdown(raw);
  return {
    name: parsed.name || fileName.replace(/\.md$/, ""),
    description: parsed.description,
    content: parsed.content,
    source: "runtime",
  };
}

function stringArg(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

/** dsh 的技能名语法（与 @deepseek-ai/dsh-skill 的 SKILL_NAME 一致）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MANAGED_KEYS = new Set(["name", "description", "whenToUse", "disable-model-invocation", "user-invocable"]);

export type ParsedSkillMarkdown = {
  name: string;
  description: string;
  whenToUse?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  content: string;
  /** 非管理字段的 frontmatter 原始行（含 metadata 等多行块），按原顺序保留，编辑时不得丢弃。 */
  extraLines: string[];
};

function parseFrontmatterBool(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "true": case "1": case "yes": case "on": return true;
    case "false": case "0": case "no": case "off": return false;
    default: return undefined;
  }
}

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const body = (match?.[2] ?? raw).trim();
  const known = new Map<string, string>();
  const extraLines: string[] = [];
  for (const line of (match?.[1] ?? "").split("\n")) {
    // 缩进行是多行值（如 metadata 块）的延续，原样保留
    if (/^[ \t]/.test(line)) { extraLines.push(line); continue; }
    const index = line.indexOf(":");
    if (index === -1) { if (line.trim()) extraLines.push(line); continue; }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (MANAGED_KEYS.has(key)) known.set(key, value);
    else extraLines.push(line);
  }
  const disableModelInvocation = known.has("disable-model-invocation")
    ? parseFrontmatterBool(known.get("disable-model-invocation")!)
    : undefined;
  const userInvocable = known.has("user-invocable")
    ? parseFrontmatterBool(known.get("user-invocable")!)
    : undefined;
  return {
    name: known.get("name") ?? "",
    description: known.get("description") ?? "",
    ...(known.get("whenToUse") ? { whenToUse: known.get("whenToUse")! } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    content: body,
    extraLines,
  };
}

export function serializeSkillMarkdown(skill: ParsedSkillMarkdown): string {
  const lines = [`name: ${skill.name}`, `description: ${skill.description}`];
  if (skill.whenToUse) lines.push(`whenToUse: ${skill.whenToUse}`);
  if (skill.disableModelInvocation !== undefined) lines.push(`disable-model-invocation: ${String(skill.disableModelInvocation)}`);
  if (skill.userInvocable !== undefined) lines.push(`user-invocable: ${String(skill.userInvocable)}`);
  lines.push(...skill.extraLines);
  return `---\n${lines.join("\n")}\n---\n\n${skill.content.trim()}\n`;
}

function resolveBundledSkillsRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const oneUp = join(dir, "..", "skills");
  if (existsSync(oneUp)) return oneUp;
  const twoUp = join(dir, "..", "..", "skills");
  if (existsSync(twoUp)) return twoUp;
  return oneUp;
}

const BUNDLED_SKILLS_ROOT = resolveBundledSkillsRoot();

export type BundledSkillEntry = { path: string; kind: "bundle" | "flat" };

/** 扫描内置技能根：目录包（<dir>/SKILL.md）与扁平 <name>.md 双形态；跳过点开头条目。 */
export function scanBundledSkillEntries(): BundledSkillEntry[] {
  const found: BundledSkillEntry[] = [];
  for (const entry of readdirSync(BUNDLED_SKILLS_ROOT, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const skillFile = join(BUNDLED_SKILLS_ROOT, entry.name, "SKILL.md");
      if (existsSync(skillFile)) found.push({ path: skillFile, kind: "bundle" });
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push({ path: join(BUNDLED_SKILLS_ROOT, entry.name), kind: "flat" });
    }
  }
  return found;
}

/** 按 frontmatter name 找内置条目（name 是唯一事实来源，与文件/目录名无关）。 */
export function findBundledEntry(name: string): BundledSkillEntry | undefined {
  if (!SKILL_NAME_RE.test(name)) return undefined;
  for (const entry of scanBundledSkillEntries()) {
    try {
      if (parseSkillMarkdown(readFileSync(entry.path, "utf8")).name === name) return entry;
    } catch {
      // 跳过不可读条目
    }
  }
  return undefined;
}

/** 技能的 resourceBase 目录：目录形态为技能目录，扁平形态为内置技能根。 */
export function bundledSkillDir(name: string): string | undefined {
  const entry = findBundledEntry(name);
  if (!entry) return undefined;
  return entry.kind === "bundle" ? dirname(entry.path) : BUNDLED_SKILLS_ROOT;
}

/** 系统技能：始终启用，不参与开关（承载 explore/test-fix 的 restrict/guard 机制）。 */
export const SYSTEM_SKILLS: ReadonlySet<string> = new Set(["explore", "test-fix"]);

/**
 * 宿主内部技能:正文由创建入口直接注入,不注册进全局技能目录,也不在技能中心列出。
 * `listBundledSkills` 仍返回它们,供新增/导入技能的重名检查。
 */
export const INTERNAL_BUNDLED_SKILLS: ReadonlySet<string> = new Set(["create-agent"]);

/** 开关表落点(dshHome = $DSH_HOME/旧, Desktop 组合下是 profileDir);导出给迁移侧同源引用。 */
export function skillTogglesPath(dshHome: string): string {
  return join(dshHome, "skill-toggles.json");
}

export function readSkillToggles(dshHome: string): Record<string, boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(skillTogglesPath(dshHome), "utf8"));
  } catch {
    return {}; // 缺失/损坏：全部禁用
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const toggles: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (SKILL_NAME_RE.test(key) && value === true) toggles[key] = true;
  }
  return toggles;
}

/** enable 写 true、disable 删键（与"缺省=禁用"严格单态）；同目录 .tmp + rename 原子写。 */
export function setSkillToggle(dshHome: string, name: string, enabled: boolean): void {
  const toggles = readSkillToggles(dshHome);
  if (enabled) toggles[name] = true;
  else delete toggles[name];
  const target = skillTogglesPath(dshHome);
  const tmp = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(toggles, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

/** 注册一个内置技能到运行时（带目录 resourceBase，模型可解析 scripts/ 相对路径）。 */
export function registerBundledSkill(
  ctx: { skills?: { register(skill: SkillRegistration): () => void } },
  name: string,
): (() => void) | undefined {
  const entry = findBundledEntry(name); // SKILL_NAME_RE 校验已内含
  if (!entry) return undefined;
  let parsed: ParsedSkillMarkdown;
  try {
    parsed = parseSkillMarkdown(readFileSync(entry.path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed.name || !parsed.description) return undefined;
  return ctx.skills?.register({
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    source: "bundled",
    resourceBase: { kind: "directory", path: entry.kind === "bundle" ? dirname(entry.path) : BUNDLED_SKILLS_ROOT },
  });
}

/** 读取内置技能完整内容（供 skill.get）。name 不合规直接返回 undefined，防路径穿越。 */
export function getBundledSkill(
  name: string,
): { name: string; description: string; content: string; disableModelInvocation?: boolean; userInvocable?: boolean } | undefined {
  const entry = findBundledEntry(name);
  if (!entry) return undefined;
  let raw: string;
  try {
    raw = readFileSync(entry.path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseSkillMarkdown(raw);
  return {
    name: parsed.name || name,
    description: parsed.description,
    content: parsed.content,
    ...(parsed.disableModelInvocation !== undefined ? { disableModelInvocation: parsed.disableModelInvocation } : {}),
    ...(parsed.userInvocable !== undefined ? { userInvocable: parsed.userInvocable } : {}),
  };
}

