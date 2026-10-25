import { useCallback, useEffect, useRef, useState } from "react";
import { rpcCall } from "./api.ts";
import {
  AGENT_TABS,
  atAgents,
  catalogFormErrors,
  isAgentInvocable,
  type AgentDetail,
  type AgentTab,
} from "./logic/agentsLogic.ts";
import { catalogErrorMessage } from "./logic/agentPackagesLogic.ts";
import AgentPackagesPanel from "./AgentPackagesPanel.tsx";
import AgentsPlazaPanel from "./AgentsPlazaPanel.tsx";
import AgentToolkitPanel from "./AgentToolkitPanel.tsx";

export { atAgents, isAgentInvocable };
export type { AgentDetail };

/** 撤销列表的周期刷新间隔：规格要求进入智能体页后每 60 秒刷新一次。 */
export const PACKAGE_REFRESH_INTERVAL_MS = 60_000;

/**
 * 智能体页外壳（Task 8 / M2 Task 12）：页面头、公用机配置栏（含发布口令）、
 * 搜索、三页签切换与刷新。
 *
 * 刷新分两档：
 * - 进入页面 / 手动刷新：先 `agent.packageRefresh`（目录 + 广场缓存 + 本地发布
 *   状态 + 已安装 metadata + 撤销列表），再 `agent.refresh`（legacy 目录）；
 * - 挂载期间每 60 秒只调 `agent.packageRefresh`，用于接收管理员撤销；前后两次
 *   调用不重叠（在飞时跳过本轮），卸载即 `clearInterval`。成功的一轮会自增
 *   刷新计数，让页签重拉 `agent.packageList`，撤销因此无需用户操作即可见。
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
  const [publishToken, setPublishToken] = useState("");
  const [hostFieldErrors, setHostFieldErrors] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  /** 周期刷新与手动刷新的互斥闸：同一时刻只有一个 packageRefresh 在飞。 */
  const packageRefreshInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const s = await rpcCall<{
          agents_host?: string;
          agents_port?: number | "";
          agents_catalog_token?: string;
          agents_catalog_publish_token?: string;
        }>("settings.get");
        if (active && s) {
          setHost(s.agents_host ?? "");
          setPort(s.agents_port ? String(s.agents_port) : "");
          setToken(s.agents_catalog_token ?? "");
          setPublishToken(s.agents_catalog_publish_token ?? "");
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

  /** 只刷新目录/撤销缓存；在飞时跳过，返回是否真正执行了这一轮。 */
  const runPackageRefresh = useCallback(async (): Promise<boolean> => {
    if (packageRefreshInFlight.current) return false;
    packageRefreshInFlight.current = true;
    try {
      await rpcCall("agent.packageRefresh");
      setError("");
      return true;
    } catch (cause) {
      setError(catalogErrorMessage(cause));
      return false;
    } finally {
      packageRefreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const refreshed = await runPackageRefresh();
      if (!active || !refreshed) return;
      try {
        await rpcCall("agent.refresh");
        if (active) setRefreshToken((prev) => prev + 1);
      } catch (cause) {
        if (active) setError(catalogErrorMessage(cause));
      }
    })();
    const timer = window.setInterval(() => {
      void (async () => {
        const refreshed = await runPackageRefresh();
        // 撤销在宿主侧应用后只落进撤销缓存/包状态，`agent/changed` 不为纯撤销
        // 发射；成功后自增刷新计数，让两页签重拉 packageList，撤销无需用户操作
        // 即可见。本回调仍不调 agent.refresh。
        if (active && refreshed) setRefreshToken((prev) => prev + 1);
      })();
    }, PACKAGE_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runPackageRefresh]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const refreshed = await runPackageRefresh();
      if (!refreshed) return;
      await rpcCall("agent.refresh");
      setNote("已刷新智能体目录");
      setRefreshToken((prev) => prev + 1);
    } catch (cause) {
      setError(catalogErrorMessage(cause));
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
        agents_catalog_publish_token: publishToken.trim(),
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
        <div className="agents-config-field">
          <input
            className="agents-config-input"
            type="password"
            style={{ width: 140 }}
            value={publishToken}
            placeholder="发布口令（创建者）"
            aria-label="发布口令"
            onChange={(event) => setPublishToken(event.target.value)}
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
