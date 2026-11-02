import { useEffect, useRef, useState } from "react";
import type { PanelToggle, ToolPanelView } from "./logic/toolPanel.ts";

export default function ToolPanel({
  panel,
  onToggle,
}: {
  panel: ToolPanelView;
  onToggle: (anchorId: number, next: PanelToggle) => void;
}) {
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<number>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const previousStatus = useRef(panel.status);
  useEffect(() => {
    if (previousStatus.current === panel.status) return;
    previousStatus.current = panel.status;
    setAnnouncement(panel.title);
  }, [panel.status, panel.title]);

  const toggleTool = (id: number) => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bodyId = `tool-panel-body-${panel.anchorId}`;

  return (
    <section className={`tool-panel tool-panel-${panel.status}`}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      <button
        type="button"
        className="tool-panel-title"
        aria-expanded={panel.expanded}
        aria-controls={panel.expanded ? bodyId : undefined}
        onClick={() => onToggle(panel.anchorId, panel.expanded ? "collapse" : "expand")}
      >
        {panel.title}
      </button>
      {panel.expanded ? (
        <div className="tool-panel-body" id={bodyId}>
          {panel.tools.map((tool) => {
            const expanded = expandedTools.has(tool.id);
            const detailId = `tool-detail-${panel.anchorId}-${tool.id}`;
            return (
              <div className="tool-panel-entry" key={tool.id}>
                <button
                  type="button"
                  className="tool-panel-entry-title"
                  aria-expanded={expanded}
                  aria-controls={expanded ? detailId : undefined}
                  onClick={() => toggleTool(tool.id)}
                >
                  <span>{tool.description}</span>
                  <code>{tool.name}</code>
                  <span className={`tool-entry-status tool-entry-${tool.status}`}>{tool.statusText}</span>
                  {tool.truncated ? <span className="badge">已截断</span> : null}
                </button>
                {expanded ? (
                  <div className="tool-panel-detail" id={detailId}>
                    <h4>参数</h4>
                    <pre>{tool.args?.trim() ? tool.args : "未记录参数"}</pre>
                    <h4>结果</h4>
                    <pre>{tool.result}</pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
