import { sourceLabel, type SkillInfo } from "./logic/skillsLogic.ts";
import ComposerMentionMenu from "./ComposerMentionMenu.tsx";

export default function SlashSkillMenu({
  skills,
  activeIndex,
  onHover,
  onPick,
}: {
  skills: SkillInfo[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (skill: SkillInfo) => void;
}) {
  return (
    <ComposerMentionMenu
      label="已启用的技能"
      empty="没有已启用的技能。到技能中心打开开关。"
      items={skills.map((skill) => ({
        key: `${skill.source}:${skill.name}`,
        name: skill.name,
        prefix: "/",
        source: sourceLabel(skill.source),
        description: skill.description,
      }))}
      activeIndex={activeIndex}
      onHover={onHover}
      onPick={(index) => {
        const picked = skills[index];
        if (picked) onPick(picked);
      }}
    />
  );
}
