import { useCallback, useEffect, useRef, useState } from "react";
import { rpcCall } from "./api.ts";
import {
  AGENT_TABS,
  atAgents,
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
 * 智能体页外壳（Task 8 / M2 Task 12）：页面头、搜索、三页签切换与刷新。
 * 公用机配置已于 2026-11-10 迁入设置「质检」页,本页不再保留任何配置相关信息;
 * 设置保存成功经 App 的 agentChangeSignal 通知本页重拉。
 *
 * 刷新分两档：
 * - 进入页面 / 手动刷新：先 `agent.packageRefresh`（目录 + 广场缓存 + 本地发布
 *   状态 + 已安装 metadata + 撤销列表），再 `agent.refresh`（legacy 目录）；
 * - 挂载期间每 60 秒只调 `agent.packageRefresh`，用于接收管理员撤销；周期 tick
 *   在飞时跳过本轮，但手动刷新会**等待/共享**在飞请求，完成后仍执行
 *   `agent.refresh` 并给出反馈。成功的一轮会自增刷新计数，让页签重拉
 *   `agent.packageList`，撤销因此无需用户操作即可见；卸载后的返回不再写状态。
 *
 * `agentChangeSignal` 由 App 在收到 `agent/changed` 时自增，面板据此重拉；
 * 刷新按钮与保存配置走同一个信号，不额外引入第二个全局事件监听。
 */
export default function AgentsView({ agentChangeSignal = 0 }: { agentChangeSignal?: number }) {
  const [tab, setTab] = useState<AgentTab>("plaza");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  /** 卸载后不再写回任何状态（在飞请求返回时静默丢弃）。 */
  const mountedRef = useRef(true);
  /** 在飞的 packageRefresh；手动/首次刷新共享它，周期 tick 只跳过。 */
  const packageRefreshPromise = useRef<Promise<boolean> | null>(null);
  /** 在飞的 agent.refresh；首次与手动刷新若同轮相遇则共享，避免重复请求。 */
  const packageLegacyRefreshPromise = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (agentChangeSignal > 0) setRefreshToken((prev) => prev + 1);
  }, [agentChangeSignal]);

  /**
   * 只刷新目录/撤销缓存，返回是否真正执行了这一轮。
   *
   * `wait` 决定在飞时的语义：周期 tick 传 `false`（在飞即跳过本轮，避免重叠）；
   * 首次进入与手动刷新传 `true`（等待并共享在飞请求，手动刷新因此不会被周期
   * 请求吞掉），调用方在拿到 `true` 后继续 `runLegacyRefresh`。
   */
  const runPackageRefresh = useCallback(async (wait: boolean): Promise<boolean> => {
    if (packageRefreshPromise.current !== null) {
      return wait ? packageRefreshPromise.current : false;
    }
    const run = (async (): Promise<boolean> => {
      try {
        await rpcCall("agent.packageRefresh");
        if (mountedRef.current) setError("");
        return true;
      } catch (cause) {
        if (mountedRef.current) setError(catalogErrorMessage(cause));
        return false;
      }
    })();
    packageRefreshPromise.current = run;
    try {
      return await run;
    } finally {
      if (packageRefreshPromise.current === run) packageRefreshPromise.current = null;
    }
  }, []);

  /**
   * 刷新 legacy 目录（`agent.refresh`）。首次进入与手动刷新可能在同一轮
   * packageRefresh 之后相遇，共享同一个在飞请求即可，不必重复发两次。
   */
  const runLegacyRefresh = useCallback(async (): Promise<boolean> => {
    if (packageLegacyRefreshPromise.current !== null) {
      return packageLegacyRefreshPromise.current;
    }
    const run = (async (): Promise<boolean> => {
      try {
        await rpcCall("agent.refresh");
        return true;
      } catch (cause) {
        if (mountedRef.current) setError(catalogErrorMessage(cause));
        return false;
      }
    })();
    packageLegacyRefreshPromise.current = run;
    try {
      return await run;
    } finally {
      if (packageLegacyRefreshPromise.current === run) packageLegacyRefreshPromise.current = null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const refreshed = await runPackageRefresh(true);
      if (!active || !refreshed) return;
      const legacyRefreshed = await runLegacyRefresh();
      if (active && legacyRefreshed) setRefreshToken((prev) => prev + 1);
    })();
    const timer = window.setInterval(() => {
      void (async () => {
        // 周期 tick 在飞即跳过；手动刷新与首次刷新则共享在飞请求。
        const refreshed = await runPackageRefresh(false);
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
  }, [runPackageRefresh, runLegacyRefresh]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const refreshed = await runPackageRefresh(true);
      if (!refreshed || !mountedRef.current) return;
      const legacyRefreshed = await runLegacyRefresh();
      if (!legacyRefreshed || !mountedRef.current) return;
      setNote("已刷新智能体目录");
      setRefreshToken((prev) => prev + 1);
    } catch (cause) {
      if (mountedRef.current) setError(catalogErrorMessage(cause));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  return (
    <div className="page-view">
      <div className="page-head">
        <h1>智能体</h1>
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
