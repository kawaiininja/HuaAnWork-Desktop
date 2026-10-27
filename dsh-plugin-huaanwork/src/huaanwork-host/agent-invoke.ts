import { randomUUID } from "node:crypto";

import { attachHostTool, detachHostTool, type AttachmentMaps } from "../huaanwork-guardrails/agent-attachments.ts";
import { mountSessionMcp } from "../huaanwork-guardrails/agent-mcp.ts";
import { filterAgentAllow } from "@huaanwork/policy/agent-catalog";
import type { SubagentCleanupWarning } from "../client-huaanwork/rpc-types.ts";
import { acceptanceCleanupTimeoutMs, acceptanceDisposeFailure } from "./acceptance-hooks.ts";
import type { AgentPackageDetail, AgentPackageSubagentRequest } from "./agent-package/types.ts";
import {
  ACTIVATION_CLEANUP_TIMEOUT_MS,
  settleWithin,
  type AgentPackageDispatchResult,
} from "./agent-package/host.ts";
import type { AgentsHost } from "./agents-host.ts";
import {
  HUAANWORK_LEGACY_AGENT_REQUEST,
  HUAANWORK_SUBAGENT_RUN_ID,
  resolveSubagents,
  type LegacyActivationSpec,
  type LegacyAgentRequest,
  type SubagentActivationHandle,
  type SubagentActivationSpec,
} from "./subagents-service.ts";
import { readHuaanworkSettingsSync } from "./settings.ts";
import type { SubagentRunRegistry } from "./subagent-runs.ts";

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
  /** 子代理 run 权威状态机(index.ts 注入);@ 执行链登记与取消闭包绑定读同一实例。 */
  huaanworkSubagentRuns?: SubagentRunRegistry;
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
    /** 发起本次 @ 的用户消息 id;包 dispatch 用它建唯一一张运行卡。 */
    clientMessageId?: string;
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

/**
 * 父会话的 `@` 注入文本：子代理结果由宿主自动送回，父会话不要重做同一任务。
 *
 * 只拼给父会话(`parentText`),子代理自己的首条 prompt 保持用户原样请求。
 */
export function parentSubagentText(name: string, text: string): string {
  return [
    text,
    "",
    "<host-instruction>",
    `这个请求已交给子代理 @${name}；子代理的结果会在完成后自动回到本会话。`,
    "等待期间不要用 call_host_tool、终端命令(bash/curl)或 MCP 工具重复执行同一任务，也不要再次 @ 同一个智能体。",
    "收到子代理结果后，直接整理并呈现结论；只有结果缺失或失败时才说明情况。",
    "</host-instruction>",
  ].join("\n");
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
  /** 发起本次 @ 的用户消息 id;只随 legacy run 投影原样返回,不参与身份或权限判断。 */
  clientMessageId?: string;
  /** 解析当前会话的 agent，作为 @agent 子代理的 parent。
   *  仅 agent 分支在 startActivation 之前调用；http/mcp 分支不触发。 */
  resolveParent?: () => Promise<unknown>;
  /** 本地智能体包分流;必须在 agentsHost 查找之前,否则目录外的 slug 会直接抛错。 */
  packageHost?: AgentPackageHostFace;
  packageRuntime?: AgentPackageRuntimeFace;
}): Promise<{ text: string; parentText?: string; afterIdle: () => Promise<void> }> {
  if (opts.packageHost !== undefined && opts.packageRuntime !== undefined) {
    const pkg = await opts.packageHost.findInvocable(opts.name);
    if (pkg !== undefined) {
      const dispatched = await opts.packageRuntime.dispatch({
        ctx: opts.ctx,
        sessionId: opts.sessionId,
        pkg,
        remainder: opts.remainder,
        // run 由包 dispatch 在启动校验前创建:这里只透传锚定用的消息 id,
        // 保证一次显式 @ 只有一张卡。
        ...(opts.clientMessageId === undefined ? {} : { clientMessageId: opts.clientMessageId }),
        ...(opts.resolveParent === undefined ? {} : { resolveParent: opts.resolveParent }),
      });
      return { ...dispatched, parentText: parentSubagentText(opts.name, dispatched.text) };
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
    // 运行记录必须在任何 await 之前建立:客户端要能在启动中就看到并定向取消这次 @。
    const subagentRuns = opts.ctx.huaanworkSubagentRuns;
    if (subagentRuns === undefined) {
      // 装配错误要响亮。缺席时 @ 仍能跑完,但运行不可见、不可取消、清理无人确认。
      throw new Error("subagent run registry is not initialized");
    }
    const runId = subagentRuns.begin({
      parentSessionId: opts.sessionId,
      kind: "legacy",
      label: `@${opts.name}`,
      ...(opts.clientMessageId === undefined ? {} : { clientMessageId: opts.clientMessageId }),
    });

    // 以下状态属于「这一次 dispatch」:启动、cancel 闭包、afterIdle 与失败出口读同一份,
    // 靠 cleanupPromise 汇合到唯一的清理实现。
    const controller = new AbortController();
    const reservedChildId = randomUUID();
    let activation: SubagentActivationHandle | undefined;
    let legacyRequest: LegacyAgentRequest | undefined;
    /** 定向取消已受理:启动视为被取消,不再继续执行。 */
    let cancelRequested = false;
    let cleanupPromise: Promise<void> | undefined;
    let resultObserved: Promise<void> | undefined;
    /** 验收注入缝:主开关关闭时恒等于 ACTIVATION_CLEANUP_TIMEOUT_MS。 */
    const cleanupTimeoutMs = acceptanceCleanupTimeoutMs(ACTIVATION_CLEANUP_TIMEOUT_MS);

    /** 观察权威 result:resolve → settleResult,reject → rejectResult(绝不走只表示启动失败的 failRun)。 */
    const observeResult = (handle: SubagentActivationHandle): Promise<void> => {
      resultObserved ??= handle.result.then(
        (value) => {
          subagentRuns.settleResult(runId, { stopReason: stopReasonOf(value) });
        },
        (error) => {
          subagentRuns.rejectResult(runId, errorText(error));
        },
      );
      return resultObserved;
    };

    /**
     * 本次 dispatch 唯一的清理实现。四条路径共用它,实际清理 promise 只创建一个:
     * 已发布 activation 的取消、未发布 activation 的取消、正常 afterIdle、超预算 afterIdle。
     *
     * - idle:按 cleanupTimeoutMs(默认 ACTIVATION_CLEANUP_TIMEOUT_MS)等真实 result,
     *   到期才记收尾预算;等待带
     *   取消 gate,定向取消接管后立即放行,不再等满预算,也不误记 `cleanup-budget-exceeded`。
     * - cancel:不等 graceful result,直接 dispose;result 由 observeResult 另行观察。
     * - 从未发布 activation:没有 activation 资源要释放,局部请求清理即全部清理。
     * - 只有 dispose fulfilled 才算清理确认;reject/超时记 error 告警且不确认,失败绝不外抛。
     */
    const cleanupLegacyRun = (mode: "idle" | "cancel"): Promise<void> =>
      (cleanupPromise ??= (async () => {
        const warnings: SubagentCleanupWarning[] = [];
        let ok = false;
        try {
          if (activation === undefined) {
            ok = true;
            return;
          }
          if (mode === "idle" && !cancelRequested) {
            const waited = await waitForLegacyResult(observeResult(activation), controller.signal, cleanupTimeoutMs);
            if (waited === "timeout") {
              // 与包路径同一上限与文案:超时只记录事实,取消归随后的 dispose()。
              subagentRuns.noteCleanupBudget(runId, cleanupTimeoutMs);
              console.error(
                `智能体「${opts.name}」的子代理在 ${String(cleanupTimeoutMs / 60_000)} 分钟内未结束，释放 activation`,
              );
            }
          }
          const disposal = await disposeLegacyActivation(activation, cleanupTimeoutMs);
          if (disposal === "fulfilled") {
            ok = true;
          } else if (disposal === "rejected") {
            warnings.push({ code: "activation-dispose-failed", severity: "error" });
          } else {
            warnings.push({ code: "activation-dispose-timeout", severity: "error" });
          }
        } finally {
          try {
            subagentRuns.confirmCleanup(runId, { ok, warnings });
          } finally {
            clearLegacyRequest(opts.ctx, legacyRequest);
          }
          // dispose 已成功而权威 result 还没结算时,执行终结后补一次确认:stopped 只在
          // 「执行终结 + 清理确认」同时成立时发布,registry 的确认与告警都幂等。
          if (ok) {
            void resultObserved
              ?.then(() => {
                subagentRuns.confirmCleanup(runId, { ok: true, warnings: [] });
              })
              .catch(() => undefined);
          }
        }
      })());

    subagentRuns.reserveChild(runId, reservedChildId);
    subagentRuns.attachCancel(runId, async () => {
      cancelRequested = true;
      controller.abort();
      // 未发布 activation 时只 latch + abort:startActivation 因取消拒绝后由启动 catch
      // 完成局部清理并确认;晚到 activation 由启动分支立即 dispose。
      if (activation !== undefined) await cleanupLegacyRun("cancel");
    });

    /** 取消在启动中受理、activation 晚到:这不是启动失败,不能再走 failRun。 */
    let cancelledAfterPublish = false;
    try {
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
      legacyRequest = request;
      const spec: LegacyActivationSpec = {
        provider: "spawn",
        label: `@${opts.name}`,
        // 预留子会话 id:provider 沿用则最早的活动直接归因到本 run;返回别的 childId
        // 时,activation 返回后立即按实际 id 重绑定。
        childId: reservedChildId,
        request: {
          prompt: [{ type: "text", text: promptWithPersona }],
          parent,
        },
        // 发布前取消走这个 signal(controller 由 cancel 闭包持有);发布后的取消归 dispose()。
        signal: controller.signal,
        delivery: "parent",
        [HUAANWORK_LEGACY_AGENT_REQUEST]: request,
        // 上游 start/end 与活动事件按它归属本 run(Task 6)。
        [HUAANWORK_SUBAGENT_RUN_ID]: runId,
      };
      // 只在调用前一刻发布:包装在第一次 await 之前已从 spec 取到本调用的请求,
      // 全局容器里的值不会决定归属。
      if (opts.ctx.huaanworkAgentRequest) {
        opts.ctx.huaanworkAgentRequest.current = request;
      }
      const handle = await startActivation(spec);
      activation = handle;
      subagentRuns.bindActivation(runId, { childId: handle.childId });
      observeResult(handle);
      if (cancelRequested) {
        // 晚到 activation:绑定并观察 result 后立即释放,不再继续执行。取消已在启动中
        // 受理,afterIdle 还没发布,不能依赖它收尾。
        cancelledAfterPublish = true;
        await cleanupLegacyRun("cancel");
        throw new Error(`智能体「${opts.name}」的回合已取消`);
      }
      return {
        text: prompt,
        parentText: parentSubagentText(opts.name, prompt),
        afterIdle: () => cleanupLegacyRun("idle"),
      };
    } catch (error) {
      if (!cancelledAfterPublish) {
        // 启动/外层失败:记录「启动已终结」,再完成局部清理并确认。result rejection
        // 不走这里(它在 observeResult 里按 rejectResult 上报)。
        subagentRuns.failRun(runId, errorText(error));
        await cleanupLegacyRun(cancelRequested ? "cancel" : "idle");
      }
      throw error;
    }
  }

  throw new Error(`未知智能体类型：「${(item as { kind?: string }).kind}」`);
}

/** 只清本次调用发布的请求:重叠的 activation 可能已经写入新的请求。 */
function clearLegacyRequest(ctx: AgentInvokeContext, request: LegacyAgentRequest | undefined): void {
  if (request !== undefined && ctx.huaanworkAgentRequest?.current === request) {
    ctx.huaanworkAgentRequest.current = undefined;
  }
}

/**
 * 有界 dispose,并区分三种结局:只有 fulfilled 才算清理确认。同步抛错与 rejection
 * 同归 `rejected`;超时不当成功,也不把失败抛给调用方。
 *
 * 验收注入缝(A-08/B-05):`acceptanceDisposeFailure()` 非 `none` 时直接返回对应
 * 结局,不触碰真实 activation;主开关关闭时该函数恒为 `none`。
 *
 * @param timeoutMs dispose 等待上限(默认生产常量)
 */
async function disposeLegacyActivation(
  activation: SubagentActivationHandle,
  timeoutMs = ACTIVATION_CLEANUP_TIMEOUT_MS,
): Promise<"fulfilled" | "rejected" | "timeout"> {
  const failure = acceptanceDisposeFailure();
  if (failure === "reject") return "rejected";
  if (failure === "hang") {
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    return "timeout";
  }
  let rejected = false;
  let disposal: Promise<void>;
  try {
    disposal = Promise.resolve(activation.dispose());
  } catch {
    return "rejected";
  }
  const observed = disposal.catch(() => {
    rejected = true;
  });
  const settled = await settleWithin(observed, timeoutMs);
  if (!settled) return "timeout";
  return rejected ? "rejected" : "fulfilled";
}

/**
 * 等权威 result 结算。定向取消先到返回 `cancelled`(已开始的 graceful 等待必须能被
 * 唤醒),收尾预算到期返回 `timeout`。
 *
 * @param observed — 已挂上 settleResult/rejectResult 的观察 promise
 * @param signal — 本次调用保存的 controller signal
 * @param timeoutMs — 收尾预算(默认生产常量)
 */
function waitForLegacyResult(
  observed: Promise<void>,
  signal: AbortSignal,
  timeoutMs = ACTIVATION_CLEANUP_TIMEOUT_MS,
): Promise<"settled" | "timeout" | "cancelled"> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: "settled" | "timeout" | "cancelled"): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish("cancelled");
    if (signal.aborted) {
      finish("cancelled");
      return;
    }
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    void observed.then(
      () => finish("settled"),
      () => finish("settled"),
    );
  });
}

/** activation.result 的 stopReason;provider 没给字符串时交给 registry 归为 `unknown`。 */
function stopReasonOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const reason = (result as { stopReason?: unknown }).stopReason;
  return typeof reason === "string" ? reason : "";
}

/** 启动/外层失败与 result rejection 的 failure 文案:只留消息,不留堆栈。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
