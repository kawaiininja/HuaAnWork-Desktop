import type { JSX } from "react";

export type ComposerMentionItem = {
  key: string;
  name: string;
  prefix: "/" | "@";
  source: string;
  description: string;
  /** 第二行副标题（智能体的 `@slug`）；技能条目不需要。 */
  subtitle?: string;
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
  items: { key: string; name: string; prefix: "/" | "@"; source: string; description: string; subtitle?: string }[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}): JSX.Element {
  return (
    <div className="slash-menu" role="listbox" aria-label={label}>
      {items.length === 0 ? (
        <div className="slash-empty">{empty}</div>
      ) : (
        items.map((item, index) => (
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
            <span className="slash-item-name">{item.prefix}{item.name}</span>
            <span className="slash-item-src">{item.source}</span>
            {item.subtitle ? <span className="slash-item-src">{item.subtitle}</span> : null}
            <span className="slash-item-desc">{item.description}</span>
          </button>
        ))
      )}
    </div>
  );
}
