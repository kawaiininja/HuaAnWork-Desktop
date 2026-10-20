/** 当前标签还在列表里就留着；不在了就选第一个真实标签，不用预分配、尚未插入的 id。 */
export function resolveActiveTab(activeId: string, tabs: readonly { id: string }[]): string {
  if (tabs.some((tab) => tab.id === activeId)) return activeId;
  return tabs[0]?.id ?? activeId;
}
