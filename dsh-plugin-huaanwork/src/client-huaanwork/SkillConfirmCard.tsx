import type { SkillConfirmCard as SkillConfirmCardData } from "./rpc-types.ts";

/**
 * 对话创建技能的确认卡（Task 6）：展示拟写入的名称/描述/触发场景/正文摘要，
 * 三个动作都只是回调——同意句仍由 App 经普通会话发送，卡片不直接调用写入 RPC。
 */
export type SkillConfirmCardProps = {
  card: SkillConfirmCardData;
  /** 同标签已有更新的确认卡或成功卡时置真:历史旧卡不再可操作。 */
  disabled?: boolean;
  /** sidecar 断连或宿主未就绪时临时禁用按钮，不把未处理的卡片标成「已处理」。 */
  unavailable?: boolean;
  onConsent: () => void;
  onRevise: () => void;
  onCancel: () => void;
};

export default function SkillConfirmCard({
  card,
  disabled = false,
  unavailable = false,
  onConsent,
  onRevise,
  onCancel,
}: SkillConfirmCardProps) {
  const buttonsDisabled = disabled || unavailable;
  const hint = disabled
    ? "这张确认卡已处理。"
    : unavailable
      ? "当前执行进程不可用，请等待恢复后再操作。"
      : "点“确认创建”会通过当前会话发送「确认」，由宿主在下一轮写入技能。";
  const rows: Array<{ label: string; value: string }> = [
    { label: "名称", value: card.name },
    { label: "描述", value: card.description },
    ...(card.whenToUse ? [{ label: "触发场景", value: card.whenToUse }] : []),
    { label: "正文摘要", value: card.contentPreview },
  ];

  return (
    <div className="card skill-confirm-card">
      <span className="ttl">请确认是否创建这个技能</span>
      <dl className="skill-confirm-rows">
        {rows.map((row) => (
          <div key={row.label} className="skill-confirm-row">
            <dt>{row.label}</dt>
            <dd>{row.value || "（未填写）"}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">{hint}</p>
      <div className="skill-card-actions">
        <button type="button" className="filter-tab" disabled={buttonsDisabled} onClick={onRevise}>
          继续修改
        </button>
        <button type="button" className="filter-tab" disabled={buttonsDisabled} onClick={onCancel}>
          取消
        </button>
        <span className="composer-spacer" />
        <button type="button" className="btn-dark" disabled={buttonsDisabled} onClick={onConsent}>
          确认创建
        </button>
      </div>
    </div>
  );
}
