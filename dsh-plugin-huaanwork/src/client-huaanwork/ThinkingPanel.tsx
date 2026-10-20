import { useState } from "react";
import { thinkingChrome } from "./logic/thinkingPanel.ts";

export function ThinkingPanel({
  thought,
  hasAssistantText,
  interrupted,
  historical = false,
  userToggled = null,
  onToggle,
}: {
  thought: string;
  hasAssistantText: boolean;
  interrupted: boolean;
  historical?: boolean;
  userToggled?: "expand" | "collapse" | null;
  onToggle?: (next: "expand" | "collapse") => void;
}) {
  const [localToggle, setLocalToggle] = useState<"expand" | "collapse" | null>(null);
  const toggle = onToggle ? userToggled : localToggle;
  const chrome = thinkingChrome({ thought, hasAssistantText, userToggled: toggle, interrupted, historical });
  const flip = () => {
    const next = chrome.expanded ? "collapse" : "expand";
    if (onToggle) onToggle(next);
    else setLocalToggle(next);
  };
  return (
    <section className="thinking-panel">
      <button
        type="button"
        aria-expanded={chrome.expanded}
        onClick={flip}
      >
        {chrome.expanded && !hasAssistantText && !interrupted && !historical ? `${chrome.title} · 进行中` : chrome.title}
      </button>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(thought).catch(() => undefined);
        }}
      >
        复制
      </button>
      {chrome.expanded ? (
        <pre className="thinking-body">{thought}</pre>
      ) : null}
    </section>
  );
}
