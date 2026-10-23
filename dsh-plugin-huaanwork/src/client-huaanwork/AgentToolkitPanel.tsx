import { useCallback, useEffect, useState } from "react";
import { rpcCall } from "./api.ts";
import {
  AGENT_NAME_RE,
  endpointFormErrors,
  type AgentFieldError,
  type AgentListItem,
  type AgentListResult,
  type AgentWriteResult,
} from "./logic/agentsLogic.ts";
import type { AgentPackageListResult } from "./rpc-types.ts";

type Modal =
  | { kind: "confirm-enable"; item: AgentListItem }
  | { kind: "add-endpoint" };

/**
 * 「我的工具包」页签（Task 8）：只列 `agent.list` 里 `kind === 'tool'` 的条目，
 * 按来源分组。本地入口保留添加/删除，公用机工具保留启用/关闭。
 *
 * 添加入口表单的 `takenNames` 并入 `agent.packageList` 的本地包 slug 与目录智能体名，
 * 避免新增工具与智能体包重名。
 */
export default function AgentToolkitPanel({
  search,
  refreshToken,
}: {
  search: string;
  refreshToken: number;
}) {
  const [items, setItems] = useState<AgentListItem[]>([]);
  const [takenNames, setTakenNames] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busyName, setBusyName] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpcCall<AgentListResult>("agent.list");
      const listed = Array.isArray(res.items) ? res.items : [];
      setItems(listed);
      setCatalogError(res.catalogError ?? "");
      setError("");
      // 重名判定同时覆盖本地包与目录智能体；目录不可达时退回工具自身名称。
      let extra: string[] = [];
      try {
        const packages = await rpcCall<AgentPackageListResult>("agent.packageList");
        extra = [
          ...(Array.isArray(packages.packages) ? packages.packages.map((pkg) => pkg.slug) : []),
          ...(Array.isArray(packages.catalogAgents) ? packages.catalogAgents.map((agent) => agent.name) : []),
        ];
      } catch {
        // agent.packageList 不可得时只用 agent.list 的名称去重
      }
      setTakenNames([...new Set([...listed.map((item) => item.name), ...extra])]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList, refreshToken]);

  const toggleDisable = async (item: AgentListItem) => {
    if (busyName) return;
    setBusyName(item.name);
    setError("");
    setNote("");
    try {
      await rpcCall("agent.setEnabled", { name: item.name, enabled: false });
      setNote(`已禁用「${item.name}」`);
      await refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyName("");
    }
  };

  const removeEndpoint = async (item: AgentListItem) => {
    if (busyName) return;
    setBusyName(item.name);
    setError("");
    setNote("");
    try {
      await rpcCall("agent.removeEndpoint", { name: item.name });
      setNote(`已删除本地入口「${item.name}」`);
      await refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyName("");
    }
  };

  const needle = search.trim().toLowerCase();
  const tools = items.filter((item) => item.kind === "tool");
  const visible = needle
    ? tools.filter((item) => `${item.name} ${item.displayName ?? ""} ${item.description}`.toLowerCase().includes(needle))
    : tools;
  const catalogTools = visible.filter((item) => item.source === "catalog");
  const localTools = visible.filter((item) => item.source === "local");

  const renderCard = (item: AgentListItem) => (
    <div key={`${item.source}:${item.name}`} className="skill-card">
      <div className="top">
        <span className="av">{item.name.slice(0, 1).toUpperCase()}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="nm">{item.displayName ?? item.name}</div>
          <div className="agent-card-badges">
            <span className="badge">{item.entrypointKind === "mcp" ? "MCP" : "端口"}</span>
            <span className="badge">{item.source === "catalog" ? "公用机" : "本地入口"}</span>
            <span className="badge">v{item.version}</span>
          </div>
        </div>
      </div>
      {item.broken ? (
        <div className="banner warn" style={{ margin: "6px 0", fontSize: 12 }}>
          已损坏：{item.broken.reason}
        </div>
      ) : null}
      <p>{item.description || "（无描述）"}</p>
      {item.whenToUse ? (
        <p className="hint" style={{ marginTop: 4, fontSize: 12 }}>
          何时使用：{item.whenToUse}
        </p>
      ) : null}
      <div className="page-tools" style={{ marginTop: 8, marginBottom: 0 }}>
        {item.source === "catalog" ? (
          item.enabled ? (
            <button
              type="button"
              className="filter-tab on"
              disabled={busyName === item.name}
              onClick={() => void toggleDisable(item)}
            >
              关闭
            </button>
          ) : (
            <button
              type="button"
              className="filter-tab"
              disabled={busyName === item.name || item.broken !== undefined}
              onClick={() => setModal({ kind: "confirm-enable", item })}
            >
              启用
            </button>
          )
        ) : (
          <button
            type="button"
            className="filter-tab"
            disabled={busyName === item.name}
            onClick={() => void removeEndpoint(item)}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="agent-toolkit-panel">
      {note ? <p className="hint" style={{ marginBottom: 12 }}>{note}</p> : null}
      {error ? <p className="banner error" style={{ marginBottom: 12 }}>{error}</p> : null}
      {catalogError ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          {catalogError}
        </div>
      ) : null}

      <div className="page-tools" style={{ marginTop: 0 }}>
        <span className="composer-spacer" />
        <button type="button" className="btn-dark" onClick={() => setModal({ kind: "add-endpoint" })}>
          ＋ 添加入口
        </button>
      </div>

      {loading && items.length === 0 ? (
        <p className="panel-empty">加载中…</p>
      ) : visible.length === 0 ? (
        <p className="panel-empty">{needle ? "没有匹配的小工具" : "暂无本地入口"}</p>
      ) : (
        <>
          {catalogTools.length > 0 ? (
            <section>
              <h3 className="agent-toolkit-group">公用机小工具</h3>
              <div className="skill-grid">{catalogTools.map(renderCard)}</div>
            </section>
          ) : null}
          {localTools.length > 0 ? (
            <section>
              <h3 className="agent-toolkit-group">本地入口</h3>
              <div className="skill-grid">{localTools.map(renderCard)}</div>
            </section>
          ) : null}
        </>
      )}

      {modal?.kind === "confirm-enable" ? (
        <EnableConfirmModal
          item={modal.item}
          onClose={() => setModal(null)}
          onConfirmed={async () => {
            setModal(null);
            setNote(`已启用「${modal.item.name}」`);
            await refreshList();
          }}
        />
      ) : null}

      {modal?.kind === "add-endpoint" ? (
        <AddEndpointModal
          takenNames={takenNames}
          onClose={() => setModal(null)}
          onSaved={async () => {
            setModal(null);
            setNote("已添加本地入口");
            await refreshList();
          }}
        />
      ) : null}
    </div>
  );
}

function EnableConfirmModal({
  item,
  onClose,
  onConfirmed,
}: {
  item: AgentListItem;
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await rpcCall("agent.setEnabled", {
        name: item.name,
        enabled: true,
        confirmPermissions: true,
      });
      await onConfirmed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label={`启用「${item.name}」`}>
      <div className="confirm-modal">
        <h3>启用「{item.name}」</h3>
        <p className="sub">该公用机条目声明了以下能力：</p>
        {item.permissions && item.permissions.length > 0 ? (
          <ul style={{ margin: "4px 0 8px 18px", fontSize: 13, color: "var(--text)" }}>
            {item.permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className="hint">未声明能力，按远程入口处理</p>
        )}
        {error ? <p className="banner error">{error}</p> : null}
        <div className="page-tools" style={{ margin: "10px 0 0" }}>
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={() => void confirm()} disabled={busy}>
            {busy ? "启用中…" : "确认启用"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddEndpointModal({
  takenNames,
  onClose,
  onSaved,
}: {
  takenNames: readonly string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<{
    name: string;
    kind: "tool" | "agent";
    entrypointKind: "http" | "mcp";
    url: string;
    description: string;
    argumentsSchema: string;
  }>({
    name: "",
    kind: "tool",
    entrypointKind: "http",
    url: "",
    description: "",
    argumentsSchema: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const patch = (part: Partial<typeof values>) => setValues((prev) => ({ ...prev, ...part }));

  const submit = async () => {
    const local = endpointFormErrors(values, takenNames);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      // endpointFormErrors 已保证 schema 文本非空时是合法 JSON 对象
      const schemaText = values.argumentsSchema.trim();
      const result = await rpcCall<AgentWriteResult>("agent.addEndpoint", {
        name: values.name.trim(),
        kind: values.kind,
        entrypoint: {
          kind: values.entrypointKind,
          url: values.url.trim(),
        },
        ...(values.description.trim() ? { description: values.description.trim() } : {}),
        ...(schemaText ? { argumentsSchema: JSON.parse(schemaText) } : {}),
      });
      if (!result.ok) {
        const fieldErrors: Record<string, string> = {};
        // 防御 RPC 返回意外 shape：fieldErrors 非数组时给出中文兜底而不是抛 TypeError
        const list: AgentFieldError[] = Array.isArray(result.fieldErrors)
          ? result.fieldErrors
          : [{ field: "form", message: "添加失败，请重试" }];
        for (const fe of list) {
          fieldErrors[fe.field] = fe.message;
        }
        setErrors(fieldErrors);
        return;
      }
      await onSaved();
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label="添加入口">
      <div className="confirm-modal automation-form">
        <h3>添加入口</h3>
        <p className="sub">登记本机或局域网已部署的工具或智能体入口</p>
        {errors.form ? <p className="banner error">{errors.form}</p> : null}
        <div className="automation-form-body">
        <label className="modal-field">
          名称
          <input
            className="modal-input"
            value={values.name}
            pattern={AGENT_NAME_RE.source}
            placeholder="如：weather-query"
            onChange={(event) => patch({ name: event.target.value })}
          />
          {errors.name ? <span className="hint" style={{ color: "var(--error)" }}>{errors.name}</span> : null}
        </label>
        <label className="modal-field">
          类型
          <select className="modal-input" value={values.kind} disabled>
            <option value="tool">小工具</option>
          </select>
          <span className="hint">本地入口仅支持小工具；「智能体」的人设由公用机目录下发</span>
          {errors.kind ? <span className="hint" style={{ color: "var(--error)" }}>{errors.kind}</span> : null}
        </label>
        <label className="modal-field">
          入口类型
          <select
            className="modal-input"
            value={values.entrypointKind}
            onChange={(event) => patch({ entrypointKind: event.target.value as "http" | "mcp" })}
          >
            <option value="http">HTTP</option>
            <option value="mcp">MCP</option>
          </select>
          {errors.entrypointKind ? (
            <span className="hint" style={{ color: "var(--error)" }}>{errors.entrypointKind}</span>
          ) : null}
        </label>
        <label className="modal-field">
          地址
          <input
            className="modal-input"
            value={values.url}
            placeholder="如：http://127.0.0.1:8000/mcp"
            onChange={(event) => patch({ url: event.target.value })}
          />
          {errors.url ? <span className="hint" style={{ color: "var(--error)" }}>{errors.url}</span> : null}
        </label>
        <label className="modal-field">
          描述（选填）
          <input
            className="modal-input"
            value={values.description}
            placeholder="如：审查指定目录下的子文件夹，产出 Markdown 报告"
            onChange={(event) => patch({ description: event.target.value })}
          />
          <span className="hint">告诉模型这个小工具做什么、什么时候用</span>
          {errors.description ? (
            <span className="hint" style={{ color: "var(--error)" }}>{errors.description}</span>
          ) : null}
        </label>
        {values.entrypointKind === "http" ? (
          <label className="modal-field">
            参数 schema（选填，JSON）
            <textarea
              className="modal-textarea"
              rows={4}
              value={values.argumentsSchema}
              placeholder='如：{"type":"object","properties":{"root":{"type":"string","description":"待审查父目录绝对路径"}},"required":["root"]}'
              onChange={(event) => patch({ argumentsSchema: event.target.value })}
            />
            <span className="hint">提示模型怎么组装调用参数；仅作提示，不做运行时校验</span>
            {errors.argumentsSchema ? (
              <span className="hint" style={{ color: "var(--error)" }}>{errors.argumentsSchema}</span>
            ) : null}
          </label>
        ) : null}
        </div>
        <div className="page-tools" style={{ margin: "12px 0 0" }}>
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={() => void submit()} disabled={busy}>
            {busy ? "添加中…" : "添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
