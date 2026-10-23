import { attachHostTool, detachHostTool, type AttachmentMaps } from "../huaanwork-guardrails/agent-attachments.ts";
import { mountSessionMcp } from "../huaanwork-guardrails/agent-mcp.ts";
import { filterAgentAllow } from "@huaanwork/policy/agent-catalog";
import type { AgentPackageDetail, AgentPackageSubagentRequest } from "./agent-package/types.ts";
import {
  ACTIVATION_CLEANUP_TIMEOUT_MS,
  settleWithin,
  type AgentPackageDispatchResult,
} from "./agent-package/host.ts";
import type { AgentsHost } from "./agents-host.ts";
import {
  HUAANWORK_LEGACY_AGENT_REQUEST,
  resolveSubagents,
  type LegacyActivationSpec,
  type LegacyAgentRequest,
  type SubagentActivationHandle,
  type SubagentActivationSpec,
} from "./subagents-service.ts";
import { readHuaanworkSettingsSync } from "./settings.ts";

/**
 * @agent 分发(旧 sidecar agent-invoke.ts 逐字移植)。
 * 定向改动(逐处,禁全局替换):
 * - `@huaanwork/bundle/agent-attachments` → `../huaanwork-guardrails/agent-attachments.ts`
 *   (bundle 已平移为 guardrails 目录,Task 2);
 * - `@huaanwork/bundle/huaanwork-agent-mcp` → `../huaanwork-guardrails/agent-mcp.ts`;
 * - `./host.ts` 的 DshContext → 本文件内联的 AgentInvokeContext(同一字段子集;
 *   huaanwork* holders 的真实声明由 Task 4 的 holders.ts 模块增强提供);
 * - readCatalogToken:旧版读 `join(dirname(dshHome), "settings.json")`;Desktop 设置位于
 *   profileDir 的 `huaanwork-settings.json`(Task 5),改读它(复用 parseSettings 宽松解析,
 *   缺文件/坏 JSON 返回 "",与旧容错语义一致),入参从 dshHome 改为 profileDir。
 */

export type AgentInvokeContext = {
  huaanworkProfileDir?: string;
  huaanworkAttachments?: AttachmentMaps;
  huaanworkAgentCatalog?: { current: { items: unknown[] } };
  huaanworkAgentRequest?: { current: unknown };
  /** `@slug` 包回合请求(由 host dispatch 写入,skills.ts 的 startActivation 包装消费)。 */
  huaanworkAgentPackageRequest?: { current: AgentPackageSubagentRequest | null };
  huaanworkWorkspaceRoot?: { current: string };
  /** 全局服务查找:`sandbox`,以及 `subagents` 在直接属性缺席时的回落路径。 */
  get?: (name: string) => unknown;
  subagents?: {
    /** rc.1 的唯一启动入口,provider 固定 "spawn";旧签名 `start` 已不在运行时上。 */
    startActivation?: (spec: SubagentActivationSpec) => Promise<unknown>;
  };
};

/** `@slug` 分流读取本地包详情的那一半;与 `packageRuntime` 通常是同一宿主实例。 */
export type AgentPackageHostFace = {
  findInvocable(slug: string): Promise<AgentPackageDetail | undefined>;
};

/** `@slug` 分流执行包回合的那一半。 */
export type AgentPackageRuntimeFace = {
  dispatch(input: {
    ctx: AgentInvokeContext;
    sessionId: string;
    pkg: AgentPackageDetail;
    remainder: string;
    resolveParent?: () => Promise<unknown>;
  }): Promise<AgentPackageDispatchResult>;
};

function readCatalogToken(profileDir?: string): string {
  if (!profileDir) return "";
  try {
    return readHuaanworkSettingsSync(profileDir).agents_catalog_token.trim();
  } catch {
    return "";
  }
}

const AT_INVOKE_RE = /^@([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/;

/** 用户文本进 <tool-invoke> 信封前转义尖括号，防止 remainder 里的 </tool-invoke> 破坏信封结构 */
function escapeEnvelopeText(text: string): string {
  return text.replace(/</g, "＜").replace(/>/g, "＞");
}

export function parseAtInvoke(text: string): { name: string; remainder: string } | undefined {
  const trimmed = text.trim();
  const match = AT_INVOKE_RE.exec(trimmed);
  const name = match?.[1];
  if (!match || name === undefined) return undefined;
  return {
    name,
    remainder: match[2] ?? "",
  };
}

export async function dispatchAt(opts: {
  host: AgentsHost;
  ctx: AgentInvokeContext;
  sessionId: string;
  name: string;
  remainder: string;
  /** 解析当前会话的 agent，作为 @agent 子代理的 parent。
   *  仅 agent 分支在 startActivation 之前调用；http/mcp 分支不触发。 */
  resolveParent?: () => Promise<unknown>;
  /** 本地智能体包分流;必须在 agentsHost 查找之前,否则目录外的 slug 会直接抛错。 */
  packageHost?: AgentPackageHostFace;
  packageRuntime?: AgentPackageRuntimeFace;
}): Promise<{ text: string; afterIdle: () => Promise<void> }> {
  if (opts.packageHost !== undefined && opts.packageRuntime !== undefined) {
    const pkg = await opts.packageHost.findInvocable(opts.name);
    if (pkg !== undefined) {
      return opts.packageRuntime.dispatch({
        ctx: opts.ctx,
        sessionId: opts.sessionId,
        pkg,
        remainder: opts.remainder,
        ...(opts.resolveParent === undefined ? {} : { resolveParent: opts.resolveParent }),
      });
    }
  }

  const item = opts.host.list().items.find((i) => i.name === opts.name);
  if (!item || !item.enabled) {
    throw new Error(`智能体「${opts.name}」未启用或不存在`);
  }
  if (item.broken) {
    throw new Error(`智能体「${opts.name}」已损坏：${item.broken.reason}`);
  }

  if (item.kind === "tool") {
    const isHttp =
      item.entrypointKind === "http" ||
      (item as { entrypoint?: { kind?: string } }).entrypoint?.kind === "http";
    if (isHttp) {
      if (opts.ctx.huaanworkAttachments) {
        attachHostTool(opts.ctx.huaanworkAttachments, opts.sessionId, opts.name);
      }
      const userRequest = escapeEnvelopeText(opts.remainder.trim() || "按该小工具开始。");
      // 第一动作约束：本地模型容易把信封当普通任务先自行探索（bash 被 policy 拒、上下文膨胀），
      // 明确禁止先探索可显著提高到 call_host_tool 的直达率。
      const text = `<tool-invoke name="${opts.name}">\n用户请求：\n${userRequest}\n</tool-invoke>\n你的第一个动作必须是调用 call_host_tool（name 必须是 ${opts.name}，arguments 按其参数说明组装）。不要先自行探索代码库或调用其他工具；待 call_host_tool 返回结果后再基于结果作答。`;
      return {
        text,
        afterIdle: async () => {
          if (opts.ctx.huaanworkAttachments) {
            detachHostTool(opts.ctx.huaanworkAttachments, opts.sessionId, opts.name);
          }
        },
      };
    }

    const isMcp =
      item.entrypointKind === "mcp" ||
      (item as { entrypoint?: { kind?: string } }).entrypoint?.kind === "mcp";
    if (isMcp) {
      // 优先取条目自身/运行时快照里的 url（快照由 boot/目录回调同步，含 url），
      // 避免每次 @ 多打一次详情请求；都缺失时回落详情接口兜底。
      const snapItem = opts.ctx.huaanworkAgentCatalog?.current?.items?.find((entry) => {
        const item = entry as { name?: string; enabled?: boolean; broken?: unknown };
        return item.name === opts.name && item.enabled && !item.broken;
      }) as { entrypoint?: { url?: string } } | undefined;
      let url: string | undefined =
        (item as { entrypoint?: { url?: string } }).entrypoint?.url ?? snapItem?.entrypoint?.url;
      if (!url) {
        const detail = await opts.host.get(opts.name);
        url = detail?.entrypoint?.url;
      }
      if (!url || typeof url !== "string") {
        throw new Error("智能体「" + opts.name + "」未配置 entrypoint.url");
      }

      const token = readCatalogToken(opts.ctx.huaanworkProfileDir);
      const headers = token ? { Authorization: "Bearer " + token } : undefined;

      const { names, dispose } = await mountSessionMcp({
        ctx: opts.ctx as never,
        sessionId: opts.sessionId,
        serverName: opts.name,
        url,
        ...(headers ? { headers } : {}),
      });

      const userRequest = escapeEnvelopeText(opts.remainder.trim() || "按该 MCP 工具开始。");
      const text = `<tool-invoke name="${opts.name}">\n用户请求：\n${userRequest}\n</tool-invoke>\n已挂载 MCP 工具：${names.join("、")}。`;
      return {
        text,
        afterIdle: async () => {
          await dispose();
        },
      };
    }

    throw new Error(`智能体「${opts.name}」入口类型无效`);
  }

  if (item.kind === "agent") {
    let detail: Awaited<ReturnType<AgentsHost["get"]>>;
    try {
      detail = await opts.host.get(opts.name);
    } catch (err) {
      throw new Error(`无法加载智能体「${opts.name}」的人设`, { cause: err });
    }

    const persona = detail?.persona?.trim();
    if (!persona) {
      throw new Error(`无法加载智能体「${opts.name}」的人设`);
    }

    // rc.1 的 SubagentRuntime 只有 startActivation;legacy `@agent` 与智能体包 `@slug`
    // 走同一入口。persona 无原生字段,由下面的分隔前缀并入子代理首条 prompt。
    const subagents = resolveSubagents(opts.ctx, "startActivation");
    if (subagents === undefined) {
      throw new Error("current dsh runtime does not support subagents");
    }
    const startActivation = subagents.startActivation.bind(subagents);

    const prompt = opts.remainder.trim() || item.description || "开始协助工作。";
    const promptWithPersona = `${persona}\n\n---\n用户请求：\n${prompt}`;
    // startActivation 要求 parent 是 ctx.agents 里的同一个活动 Agent 对象,
    // 缺省时不能猜 list()[0]。先解析父会话:解析失败时不能留下一个可被并发
    // activation 认领的 legacy 请求。
    const parent = opts.resolveParent ? await opts.resolveParent() : undefined;
    if (parent === undefined || parent === null) {
      throw new Error(`智能体「${opts.name}」无法开始：当前会话没有可用的父会话`);
    }
    // 请求对象同时写入全局容器(旧运行时/旧包装的回落)和 activation spec 的符号键;
    // 包装按 spec 的调用级标记归属请求,重叠的 activation 不会互相认领。
    const request: LegacyAgentRequest = {
      name: opts.name,
      allow: filterAgentAllow(detail?.allow),
      persona,
    };
    const spec: LegacyActivationSpec = {
      provider: "spawn",
      label: `@${opts.name}`,
      request: {
        prompt: [{ type: "text", text: promptWithPersona }],
        parent,
      },
      signal: new AbortController().signal,
      delivery: "parent",
      [HUAANWORK_LEGACY_AGENT_REQUEST]: request,
    };
    let activation: SubagentActivationHandle;
    try {
      // 只在调用前一刻发布:包装在第一次 await 之前已从 spec 取到本调用的请求,
      // 全局容器里的值不会决定归属。
      if (opts.ctx.huaanworkAgentRequest) {
        opts.ctx.huaanworkAgentRequest.current = request;
      }
      activation = await startActivation(spec);
    } catch (err) {
      clearLegacyRequest(opts.ctx, request);
      throw err;
    }

    return {
      text: prompt,
      afterIdle: async () => {
        // 子会话可能比父回合的空闲点活得久;等待有上限,结果与释放的失败都不外抛。
        try {
          const settled = await settleWithin(activation.result, ACTIVATION_CLEANUP_TIMEOUT_MS);
          if (!settled) {
            // 与包路径同一上限与文案:超时只记录事实,取消归随后的 dispose()。
            console.error(
              `智能体「${opts.name}」的子代理在 ${String(ACTIVATION_CLEANUP_TIMEOUT_MS / 60_000)} 分钟内未结束，释放 activation`,
            );
          }
        } catch {
          // activation.result 的拒绝已在 settleWithin 内折叠,这里只兜同步抛错的实现。
        }
        try {
          await settleWithin(activation.dispose(), ACTIVATION_CLEANUP_TIMEOUT_MS);
        } catch {
          // 释放是尽力而为:同步抛错的 dispose 不能阻止 holder 清理。
        }
        clearLegacyRequest(opts.ctx, request);
      },
    };
  }

  throw new Error(`未知智能体类型：「${(item as { kind?: string }).kind}」`);
}

/** 只清本次调用发布的请求:重叠的 activation 可能已经写入新的请求。 */
function clearLegacyRequest(ctx: AgentInvokeContext, request: LegacyAgentRequest): void {
  if (ctx.huaanworkAgentRequest?.current === request) {
    ctx.huaanworkAgentRequest.current = undefined;
  }
}
