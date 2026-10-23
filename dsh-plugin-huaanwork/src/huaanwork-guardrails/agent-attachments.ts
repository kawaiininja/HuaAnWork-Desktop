export type AttachmentMaps = {
  sessionHostTools: Map<string, Set<string>>;
  sessionAgentTools: Map<string, Set<string>>;
};

/**
 * 智能体包子会话的宿主工具:允许名单启用其中某个名字时才挂到子会话上,MCP 名字由调用方另加。
 * 包回合的两个挂载点(`host.ts` 的预挂载与 `skills.ts` 的 activation 包装)都经
 * `agentPackageChildAttachmentNames` 按允许名单算出名单。
 */
export const AGENT_PACKAGE_CHILD_TOOLS = ["agent_http", "agent_skill_run"] as const;

/**
 * 一次包回合要挂到子会话的工具名:允许名单启用的运行时工具 + 挂载返回的 MCP 名。
 *
 * `host.ts` 在 activation 之前按预留子会话 id 预先挂载,`skills.ts` 的包装在
 * activation 之后按子会话 id 再挂一次;两处必须算出同一份名单,否则安全网要么补上
 * 本回合未开放的工具,要么漏掉首条请求已需要的 MCP 名。
 *
 * @param allow - `composeAgentPackageToolAllowList` 的结果
 * @param mcpNames - MCP 挂载返回的工具名
 * @returns 去重后的挂载名单
 */
export function agentPackageChildAttachmentNames(
  allow: readonly string[],
  mcpNames: readonly string[] = [],
): string[] {
  const enabled = AGENT_PACKAGE_CHILD_TOOLS.filter((name) => allow.includes(name))
  return [...new Set<string>([...enabled, ...mcpNames])]
}

export function emptyAttachments(): AttachmentMaps {
  return {
    sessionHostTools: new Map(),
    sessionAgentTools: new Map(),
  };
}

export function attachHostTool(maps: AttachmentMaps, sessionId: string, name: string): void {
  let set = maps.sessionHostTools.get(sessionId);
  if (!set) {
    set = new Set();
    maps.sessionHostTools.set(sessionId, set);
  }
  set.add(name);
}

export function detachHostTool(maps: AttachmentMaps, sessionId: string, name: string): void {
  const set = maps.sessionHostTools.get(sessionId);
  if (!set) return;
  set.delete(name);
  if (set.size === 0) {
    maps.sessionHostTools.delete(sessionId);
  }
}

export function attachAgentTools(maps: AttachmentMaps, sessionId: string, names: readonly string[]): void {
  let set = maps.sessionAgentTools.get(sessionId);
  if (!set) {
    set = new Set();
    maps.sessionAgentTools.set(sessionId, set);
  }
  for (const name of names) {
    set.add(name);
  }
}

export function detachAgentTools(maps: AttachmentMaps, sessionId: string, names: readonly string[]): void {
  const set = maps.sessionAgentTools.get(sessionId);
  if (!set) return;
  for (const name of names) {
    set.delete(name);
  }
  if (set.size === 0) {
    maps.sessionAgentTools.delete(sessionId);
  }
}

export function isHostAttached(maps: AttachmentMaps | undefined, sessionId: string | undefined, toolName: string): boolean {
  if (!maps || !sessionId || !toolName) return false;
  return maps.sessionHostTools.get(sessionId)?.has(toolName) === true;
}

export function isMcpAttached(maps: AttachmentMaps | undefined, sessionId: string | undefined, executionName: string): boolean {
  if (!maps || !sessionId || !executionName) return false;
  return maps.sessionAgentTools.get(sessionId)?.has(executionName) === true;
}

/**
 * 本地智能体包工具(agent_propose/agent_commit/agent_skill_run/agent_http)是否已挂到
 * 该会话。与 MCP 共用 `sessionAgentTools` 附件表;policy 用它给 default 分支补
 * `attached`。present-as 直接读 `sessionAgentTools`,不走本函数。
 */
export function isAgentToolAttached(maps: AttachmentMaps | undefined, sessionId: string | undefined, toolName: string): boolean {
  return isMcpAttached(maps, sessionId, toolName);
}
