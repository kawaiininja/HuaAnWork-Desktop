import { useCallback, useEffect, useState } from "react";
import { rpcCall } from "./api.ts";
import {
  atAgents,
  filterAgents,
  isAgentInvocable,
  catalogFormErrors,
  endpointFormErrors,
  AGENT_NAME_RE,
  type AgentListItem,
  type AgentListResult,
  type AgentTab,
  type AgentWriteResult,
  type AgentDetail,
  type AgentFieldError,
} from "./logic/agentsLogic.ts";

export { atAgents, isAgentInvocable };
export type { AgentDetail };

const TABS: { id: AgentTab; label: string }[] = [
  { id: "discover", label: "发现" },
  { id: "enabled", label: "已启用" },
  { id: "local", label: "本地入口" },
];

type Modal =
  | { kind: "confirm-enable"; item: AgentListItem }
  | { kind: "add-endpoint" };

export default function AgentsView() {
  const [items, setItems] = useState<AgentListItem[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [tab, setTab] = useState<AgentTab>("discover");
  const [search, setSearch] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  const [hostFieldErrors, setHostFieldErrors] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const res = await rpcCall<AgentListResult>("agent.list");
      setItems(Array.isArray(res.items) ? res.items : []);
      setCatalogError(res.catalogError ?? "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const s = await rpcCall<{
          agents_host?: string;
          agents_port?: number | "";
          agents_catalog_token?: string;
        }>("settings.get");
        if (active && s) {
          setHost(s.agents_host ?? "");
          setPort(s.agents_port ? String(s.agents_port) : "");
          setToken(s.agents_catalog_token ?? "");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (active) {
        await refreshList();
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshList]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const res = await rpcCall<AgentListResult>("agent.refresh");
      setItems(Array.isArray(res.items) ? res.items : []);
      setCatalogError(res.catalogError ?? "");
      setNote("已刷新智能体目录");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveConfig = async () => {
    const localErrors = catalogFormErrors(host, port);
    if (Object.keys(localErrors).length > 0) {
      setHostFieldErrors(localErrors);
      return;
    }
    setSavingSettings(true);
    setError("");
    try {
      const res = await rpcCall<unknown>("settings.set", {
        agents_host: host.trim(),
        agents_port: port.trim() ? Number(port.trim()) : "",
        agents_catalog_token: token.trim(),
      });
      if (res && typeof res === "object" && "ok" in res && (res as { ok: boolean }).ok === false) {
        const fieldErrors: Record<string, string> = {};
        const rawErrors = (res as { fieldErrors?: { field: string; message: string }[] }).fieldErrors;
        if (Array.isArray(rawErrors)) {
          for (const fe of rawErrors) {
            if (fe.field && fe.message) fieldErrors[fe.field] = fe.message;
          }
        }
        setHostFieldErrors(fieldErrors);
        return;
      }
      setHostFieldErrors({});
      setNote("已保存公用机配置");
      await refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingSettings(false);
    }
  };

  const openEnableConfirm = (item: AgentListItem) => {
    setModal({ kind: "confirm-enable", item });
  };

  const toggleDisable = async (item: AgentListItem) => {
    setError("");
    try {
      await rpcCall("agent.setEnabled", { name: item.name, enabled: false });
      setNote(`已禁用「${item.name}」`);
      await refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeEndpoint = async (item: AgentListItem) => {
    setError("");
    try {
      await rpcCall("agent.removeEndpoint", { name: item.name });
      setNote(`已删除本地入口「${item.name}」`);
      await refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const visible = filterAgents(items, tab, search);

  return (
    <div className="page-view">
      <div className="page-head">
        <h1>智能体</h1>
        <span className="hint-text">在公用机完成质检后，把该机地址和端口填在这里。</span>
      </div>

      <div className="agents-config-bar">
        <div className="agents-config-field">
          <input
            className="agents-config-input"
            value={host}
            placeholder="公用机地址，如 192.168.1.10"
            aria-label="公用机地址"
            onChange={(event) => {
              setHost(event.target.value);
              if (hostFieldErrors.agents_host) {
                setHostFieldErrors((prev) => {
                  const next = { ...prev };
                  delete next.agents_host;
                  return next;
                });
              }
            }}
          />
          {hostFieldErrors.agents_host ? (
            <span className="agents-field-error">{hostFieldErrors.agents_host}</span>
          ) : null}
        </div>
        <div className="agents-config-field">
          <input
            className="agents-config-input"
            style={{ width: 110 }}
            value={port}
            placeholder="端口，如 18080"
            aria-label="端口"
            onChange={(event) => {
              setPort(event.target.value);
              if (hostFieldErrors.agents_port) {
                setHostFieldErrors((prev) => {
                  const next = { ...prev };
                  delete next.agents_port;
                  return next;
                });
              }
            }}
          />
          {hostFieldErrors.agents_port ? (
            <span className="agents-field-error">{hostFieldErrors.agents_port}</span>
          ) : null}
        </div>
        <div className="agents-config-field">
          <input
            className="agents-config-input"
            type="password"
            style={{ width: 140 }}
            value={token}
            placeholder="访问口令（可选）"
            aria-label="访问口令"
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="filter-tab on"
          disabled={savingSettings}
          onClick={() => void handleSaveConfig()}
        >
          {savingSettings ? "保存中…" : "保存配置"}
        </button>
      </div>

      <div className="page-tools">
        <input
          className="search-input"
          value={search}
          placeholder="🔍 搜索智能体"
          aria-label="搜索智能体"
          onChange={(event) => setSearch(event.target.value)}
        />
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "filter-tab on" : "filter-tab"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        <span className="composer-spacer" />
        <button
          type="button"
          className="filter-tab"
          disabled={refreshing}
          onClick={() => void handleRefresh()}
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
        <button
          type="button"
          className="btn-dark"
          onClick={() => setModal({ kind: "add-endpoint" })}
        >
          ＋ 添加入口
        </button>
      </div>

      {note ? (
        <p className="hint" style={{ marginBottom: 12 }}>
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="banner error" style={{ marginBottom: 12 }}>
          {error}
        </p>
      ) : null}
      {catalogError ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          {catalogError}
        </div>
      ) : null}

      {visible.length === 0 ? (
        tab === "discover" && !catalogError && !search.trim() ? (
          <p className="panel-empty">在公用机完成质检后，把该机地址和端口填在这里。</p>
        ) : (
          <p className="panel-empty">
            {search.trim()
              ? "没有匹配的智能体"
              : tab === "enabled"
                ? "暂无已启用的智能体"
                : tab === "local"
                  ? "暂无本地入口"
                  : "暂无智能体"}
          </p>
        )
      ) : (
        <div className="skill-grid">
          {visible.map((item) => (
            <div key={`${item.source}:${item.name}`} className="skill-card">
              <div className="top">
                <span className="av" title={isAgentInvocable(item) ? "可 @ 点名" : undefined}>
                  {item.name.slice(0, 1).toUpperCase()}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="nm">{item.name}</div>
                  <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                    <span className="badge">{item.kind === "agent" ? "智能体" : "小工具"}</span>
                    {item.kind === "tool" ? (
                      <span className="badge">{item.entrypointKind === "mcp" ? "MCP" : "端口"}</span>
                    ) : null}
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
                      onClick={() => void toggleDisable(item)}
                    >
                      已启用
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="filter-tab"
                      onClick={() => openEnableConfirm(item)}
                    >
                      启用
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="filter-tab"
                    onClick={() => void removeEndpoint(item)}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
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
          takenNames={items.map((it) => it.name)}
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

