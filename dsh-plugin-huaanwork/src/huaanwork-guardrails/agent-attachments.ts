export type AttachmentMaps = {
  sessionHostTools: Map<string, Set<string>>;
  sessionAgentTools: Map<string, Set<string>>;
};

/**
 * 每个智能体包子会话都会挂上的宿主工具;MCP 名字由调用方另加。
 * `skills.ts` 用这份字面清单挂载,`host.ts` 的回合清理用同一份摘除。
 */
export const AGENT_PACKAGE_CHILD_TOOLS = ["agent_http", "agent_skill_run"] as const;

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
