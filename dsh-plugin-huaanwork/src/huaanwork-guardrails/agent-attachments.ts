export type AttachmentMaps = {
  sessionHostTools: Map<string, Set<string>>;
  sessionAgentTools: Map<string, Set<string>>;
};

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
