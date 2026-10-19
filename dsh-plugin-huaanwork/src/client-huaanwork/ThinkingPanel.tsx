import { useState } from "react";
import { thinkingChrome } from "./logic/thinkingPanel.ts";

export function ThinkingPanel({
  thought,
  hasAssistantText,
  interrupted,
}: {
  thought: string;
  hasAssistantText: boolean;
  interrupted: boolean;
}) {
  const [userToggled, setUserToggled] = useState<"expand" | "collapse" | null>(null);
  const chrome = thinkingChrome({ thought, hasAssistantText, userToggled, interrupted });
  return (
    <section className="thinking-panel">
      <button
        type="button"
        aria-expanded={chrome.expanded}
        onClick={() => setUserToggled(chrome.expanded ? "collapse" : "expand")}
      >
        {chrome.expanded && !hasAssistantText && !interrupted ? `${chrome.title} · 进行中` : chrome.title}
      </button>
      {chrome.expanded ? (
        <pre className="thinking-body">{thought}</pre>
      ) : null}
    </section>
  );
}
