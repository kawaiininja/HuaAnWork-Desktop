import { useEffect, useState } from "react";
import { rpcCall } from "./api.ts";
import {
  AGENT_TABS,
  atAgents,
  catalogFormErrors,
  isAgentInvocable,
  type AgentDetail,
  type AgentTab,
} from "./logic/agentsLogic.ts";
import AgentPackagesPanel from "./AgentPackagesPanel.tsx";
import AgentsPlazaPanel from "./AgentsPlazaPanel.tsx";
import AgentToolkitPanel from "./AgentToolkitPanel.tsx";

export { atAgents, isAgentInvocable };
export type { AgentDetail };

/**
 * 智能体页外壳（Task 8）：页面头、公用机配置栏、搜索、三页签切换与刷新。
 * 三页签的数据与动作各自在面板内（广场 / 我的智能体 / 我的工具包）。
 *
 * `agentChangeSignal` 由 App 在收到 `agent/changed` 时自增，面板据此重拉；
 * 刷新按钮与保存配置走同一个信号，不额外引入第二个全局事件监听。
 */
export default function AgentsView({ agentChangeSignal = 0 }: { agentChangeSignal?: number }) {
  const [tab, setTab] = useState<AgentTab>("plaza");
  const [search, setSearch] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  const [hostFieldErrors, setHostFieldErrors] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

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
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (agentChangeSignal > 0) setRefreshToken((prev) => prev + 1);
  }, [agentChangeSignal]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      await rpcCall("agent.refresh");
      setNote("已刷新智能体目录");
      setRefreshToken((prev) => prev + 1);
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
      setRefreshToken((prev) => prev + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingSettings(false);
    }
  };

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
        {AGENT_TABS.map((item) => (
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

      {tab === "plaza" ? (
        <AgentsPlazaPanel search={search} refreshToken={refreshToken} />
      ) : tab === "mine" ? (
        <AgentPackagesPanel search={search} refreshToken={refreshToken} />
      ) : (
        <AgentToolkitPanel search={search} refreshToken={refreshToken} />
      )}
    </div>
  );
}
