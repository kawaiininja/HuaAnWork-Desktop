/** agent 引用的会话身份：session.id 优先，回落 agent.id（含裸 agent id）。 */
export function sessionIdOfAgentRef(ref: { id?: string; session?: { id?: string } } | undefined): string | undefined {
  const session = ref?.session?.id;
  if (typeof session === "string" && session) return session;
  const id = ref?.id;
  return typeof id === "string" && id ? id : undefined;
}
