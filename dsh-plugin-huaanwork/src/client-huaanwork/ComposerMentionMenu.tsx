import type { JSX, ReactNode } from "react";

export type ComposerMentionItem = {
  key: string;
  name: string;
  prefix: "/" | "@";
  source: string;
  description: string;
  /** 第二行副标题（智能体的 `@slug`）；技能条目不需要。 */
  subtitle?: string;
  /** 分组标题；存在时按组渲染，缺省保持旧的扁平列表。 */
  group?: string;
  /** 名称前的图标节点；团队条目复用现有团队图标。 */
  icon?: ReactNode;
};

export default function ComposerMentionMenu({
  label,
  empty,
  items,
  activeIndex,
  onHover,
  onPick,
}: {
  label: string;
  empty: string;
  items: ComposerMentionItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="slash-menu" role="listbox" aria-label={label}>
        <div className="slash-empty">{empty}</div>
      </div>
    );
  }

  const rows: JSX.Element[] = [];
  let currentGroup: string | undefined;
  items.forEach((item, index) => {
    if (item.group !== undefined && item.group !== currentGroup) {
      currentGroup = item.group;
      rows.push(
        <div key={`group:${item.group}:${index}`} className="slash-empty" role="presentation">
          {item.group}
        </div>,
      );
    }
    rows.push(
      <button
        key={item.key}
        type="button"
        role="option"
        aria-selected={index === activeIndex}
        className={index === activeIndex ? "slash-item on" : "slash-item"}
        onMouseEnter={() => onHover(index)}
        onMouseDown={(event) => {
          event.preventDefault();
          onPick(index);
        }}
      >
        <span className="slash-item-name">
          {item.icon ? <span className="slash-item-icon">{item.icon}</span> : null}
          {item.prefix}
          {item.name}
        </span>
        <span className="slash-item-src">{item.source}</span>
        {item.subtitle ? <span className="slash-item-src">{item.subtitle}</span> : null}
        <span className="slash-item-desc">{item.description}</span>
      </button>,
    );
  });

  return (
    <div className="slash-menu" role="listbox" aria-label={label}>
      {rows}
    </div>
  );
}
