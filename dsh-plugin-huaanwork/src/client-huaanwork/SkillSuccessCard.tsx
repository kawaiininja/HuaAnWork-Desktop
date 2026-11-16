/**
 * 技能创建成功卡（Task 6）：展示成功文案与“前往我的技能”动作。
 * 渲染本身不导航、不打断会话；只有点击动作才切到技能页的“我的技能”标签。
 */
export type SkillSuccessCardProps = {
  name: string;
  draftId: string;
  onGoToMine: () => void;
};

export default function SkillSuccessCard({ name, draftId, onGoToMine }: SkillSuccessCardProps) {
  return (
    <div className="card skill-success-card" data-draft-id={draftId}>
      <span className="ttl">技能已创建</span>
      <p className="skill-success-text">已保存技能 {name}，请在“我的技能”中启用</p>
      <div className="skill-card-actions">
        <span className="composer-spacer" />
        <button type="button" className="filter-tab" onClick={onGoToMine}>
          前往我的技能
        </button>
      </div>
    </div>
  );
}
