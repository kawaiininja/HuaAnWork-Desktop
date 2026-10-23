import type { AgentPackageConfirmCard } from "./rpc-types.ts";

/** 确认卡标题按草稿模式区分：更新保留启用态，不能沿用「创建」文案。 */
export const AGENT_CONFIRM_TITLES: Record<AgentPackageConfirmCard["mode"], string> = {
  create: "请确认是否创建这名智能体",
  update: "请确认是否更新这名智能体",
};

/**
 * 结构化创建/更新确认卡（Task 8）：展示草稿的名称/slug/简介/人设/技能/工具，
 * 底部固定 warning 与 consentHint。没有可点击的确认按钮——同意句必须由用户
 * 在会话里回复，客户端不直接调用写入 RPC。
 */
export default function AgentConfirmCard({ card }: { card: AgentPackageConfirmCard }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "名称", value: card.displayName },
    { label: "slug", value: card.slug },
    { label: "简介", value: card.description },
    { label: "人设", value: card.personaSummary },
    { label: "技能", value: card.skillSummary },
    { label: "工具", value: card.toolLabel },
  ];

  return (
    <div className="card agent-confirm-card">
      <span className="ttl">{AGENT_CONFIRM_TITLES[card.mode]}</span>
      <dl className="agent-confirm-rows">
        {rows.map((row) => (
          <div key={row.label} className="agent-confirm-row">
            <dt>{row.label}</dt>
            <dd>{row.value || "（未填写）"}</dd>
          </div>
        ))}
      </dl>
      <p className="banner warn" style={{ margin: 0 }}>
        {card.warning}
      </p>
      <p className="hint">{card.consentHint}</p>
    </div>
  );
}
