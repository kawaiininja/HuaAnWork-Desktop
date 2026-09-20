import type { AgentListItem } from "./logic/agentsLogic.ts";
import ComposerMentionMenu from "./ComposerMentionMenu.tsx";

export default function AtAgentMenu({
  agents,
  activeIndex,
  onHover,
  onPick,
}: {
  agents: AgentListItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (agent: AgentListItem) => void;
}) {
  return (
    <ComposerMentionMenu
      label="已启用的智能体"
      empty="没有已启用的智能体。到智能体页打开开关或添加入口。"
      items={agents.map((a) => ({
        key: `${a.source}:${a.name}`,
        name: a.name,
        prefix: "@",
        source: a.kind === "agent" ? "智能体" : "小工具",
        description: a.description,
      }))}
      activeIndex={activeIndex}
      onHover={onHover}
      onPick={(index) => {
        const picked = agents[index];
        if (picked) onPick(picked);
      }}
    />
  );
}
