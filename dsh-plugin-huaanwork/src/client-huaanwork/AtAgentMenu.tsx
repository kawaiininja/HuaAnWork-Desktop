import type { JSX } from "react";
import type { AgentListItem } from "./logic/agentsLogic.ts";
import { expertTeamMentionSummary } from "./logic/expertTeamsLogic.ts";
import type { ExpertTeam } from "./rpc-types.ts";
import ComposerMentionMenu, { type ComposerMentionItem } from "./ComposerMentionMenu.tsx";

const MENTION_ICON_PROPS = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** 复用侧边栏“专家团”图标，不新增图形资产。 */
function TeamMentionIcon(): JSX.Element {
  return (
    <svg {...MENTION_ICON_PROPS}>
      <circle cx="5.4" cy="6.2" r="1.8" />
      <circle cx="10.6" cy="6.2" r="1.8" />
      <path d="M2.8 12.6c.3-1.8 1.3-2.8 2.6-2.8s2.3 1 2.6 2.8M8 12.6c.3-1.8 1.3-2.8 2.6-2.8s2.3 1 2.6 2.8" />
    </svg>
  );
}

export default function AtAgentMenu({
  agents,
  teams,
  allowTeams,
  activeIndex,
  onHover,
  onPickAgent,
  onPickTeam,
}: {
  agents: AgentListItem[];
  /** 已由 App 按当前查询过滤，且只来自 Host `expertTeam.invocableList`。 */
  teams: ExpertTeam[];
  /** 输入开头为真：智能体与专家团并列；正文中段只展示智能体分组。 */
  allowTeams: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onPickAgent: (agent: AgentListItem) => void;
  onPickTeam: (team: ExpertTeam) => void;
}) {
  const items: ComposerMentionItem[] = [
    ...agents.map((agent) => ({
      key: `${agent.source}:${agent.name}`,
      name: agent.displayName ?? agent.name,
      prefix: "@" as const,
      source: agent.kind === "agent" ? "智能体" : "小工具",
      description: agent.description,
      subtitle: `@${agent.name}`,
      ...(allowTeams ? { group: "智能体" } : {}),
    })),
    ...(allowTeams
      ? teams.map((team) => ({
          key: `team:${team.id}`,
          name: team.name,
          prefix: "@" as const,
          source: "专家团",
          description: expertTeamMentionSummary(team),
          subtitle: `@team:${team.slug}`,
          group: "专家团",
          icon: <TeamMentionIcon />,
        }))
      : []),
  ];
  return (
    <ComposerMentionMenu
      label={allowTeams ? "已启用的智能体与专家团" : "已启用的智能体"}
      empty={allowTeams ? "没有匹配的智能体或专家团。" : "没有已启用的智能体。到智能体页打开开关或添加入口。"}
      items={items}
      activeIndex={activeIndex}
      onHover={onHover}
      onPick={(index) => {
        const agent = agents[index];
        if (agent) {
          onPickAgent(agent);
          return;
        }
        const team = teams[index - agents.length];
        if (team) onPickTeam(team);
      }}
    />
  );
}
