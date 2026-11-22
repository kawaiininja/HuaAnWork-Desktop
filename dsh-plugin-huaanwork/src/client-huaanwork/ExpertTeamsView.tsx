import { useCallback, useEffect, useRef, useState } from "react";
import { rpcCall } from "./api.ts";
import ExpertTeamEditor from "./ExpertTeamEditor.tsx";
import ExpertTeamListPanel, { expertTeamErrorMessage } from "./ExpertTeamListPanel.tsx";
import type { ExpertTeam } from "./rpc-types.ts";

/**
 * 专家团管理页（设计 §7.1–§7.3 / §9）。
 *
 * 列表与编辑器通过页面内部选中态切换，不增加 URL 深链。所有成员可选包只来自
 * `expertTeam.list` 返回的健康包（Host 已过滤启用/损坏/撤销并排除 legacy/tool）；
 * 定义可用性也由 Host 计算，本页只负责展示与触发 CRUD。
 *
 * 列表刷新信号来自 App 的 `expertTeam/changed` 事件计数；本页自己的写操作完成后
 * 也会重拉列表，避免在无 WS 的组件测试里依赖事件广播。编辑器打开期间重拉只更新
 * `packages` 与后台列表，不重建编辑器草稿。
 */

/** 成员包的原生能力摘要；与 Host 可用性投影同形。 */
export type ExpertTeamMemberCapabilities = {
  tools: "none" | "http" | "mcp" | "both";
  skillScripts: string[];
};

/** 定义可用性：Host `resolveExpertTeamAvailability` 的客户端镜像。 */
export type ExpertTeamAvailability = {
  kind: "invocable" | "disabled" | "incomplete" | "member-invalid";
  invocable: boolean;
  reasons: string[];
  members: Array<{
    memberId: string;
    displayName: string;
    version?: string;
    capabilities?: ExpertTeamMemberCapabilities;
    reason?: string;
  }>;
};

/** `expertTeam.list` 的一行：定义、损坏标记与实时可用性。 */
export type ExpertTeamListRow = {
  id: string;
  team?: ExpertTeam;
  error?: "expert-team-corrupt";
  availability: ExpertTeamAvailability;
};

/** 成员选择器的一项：健康智能体包及其原生能力摘要。 */
export type ExpertTeamSelectablePackage = {
  slug: string;
  displayName: string;
  source: "local" | "catalog";
  version: string;
  description: string;
  capabilities?: ExpertTeamMemberCapabilities;
};

export type ExpertTeamListResult = {
  teams: ExpertTeamListRow[];
  packages: ExpertTeamSelectablePackage[];
};

/** 编辑器按字段回显的错误行；与 Host `ExpertTeamFieldError` 同形。 */
export type ExpertTeamFieldError = { field: string; message: string };

/** 写路径结果：成功携带写入后的完整定义，失败按字段回显。 */
export type ExpertTeamWriteResult =
  | { ok: true; team: ExpertTeam }
  | { ok: false; fieldErrors: ExpertTeamFieldError[] };

/** 字段错误合并成一行提示；列表页与编辑器共用。 */
export function expertTeamFieldErrorText(fieldErrors: readonly ExpertTeamFieldError[]): string {
  return fieldErrors.map((error) => error.message).join("；");
}

export default function ExpertTeamsView({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [data, setData] = useState<ExpertTeamListResult | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  /** 打开中的编辑器：`{}` 表示新建，带 `row` 表示编辑该定义。 */
  const [editing, setEditing] = useState<{ row?: ExpertTeamListRow } | null>(null);
  const mountedRef = useRef(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback((): void => {
    const seq = ++requestSeq.current;
    rpcCall<ExpertTeamListResult>("expertTeam.list").then(
      (result) => {
        if (!mountedRef.current || seq !== requestSeq.current) return;
        setData(result);
        setLoading(false);
        setError("");
      },
      (cause: unknown) => {
        if (!mountedRef.current || seq !== requestSeq.current) return;
        setError(expertTeamErrorMessage(cause));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  const handleToggle = async (row: ExpertTeamListRow): Promise<void> => {
    const team = row.team;
    if (team === undefined) return;
    setBusyId(row.id);
    setError("");
    try {
      const result = await rpcCall<ExpertTeamWriteResult>("expertTeam.setEnabled", {
        id: row.id,
        enabled: !team.enabled,
      });
      if (!result.ok) {
        setError(expertTeamFieldErrorText(result.fieldErrors));
        return;
      }
      load();
    } catch (cause) {
      setError(expertTeamErrorMessage(cause));
    } finally {
      if (mountedRef.current) setBusyId(undefined);
    }
  };

  const handleRemove = async (row: ExpertTeamListRow): Promise<void> => {
    setBusyId(row.id);
    setError("");
    try {
      await rpcCall<{ removed: true }>("expertTeam.remove", { id: row.id });
      load();
    } catch (cause) {
      setError(expertTeamErrorMessage(cause));
    } finally {
      if (mountedRef.current) setBusyId(undefined);
    }
  };

  if (editing !== null) {
    return (
      <ExpertTeamEditor
        {...(editing.row === undefined ? {} : { row: editing.row })}
        packages={data?.packages ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    );
  }

  return (
    <ExpertTeamListPanel
      teams={data?.teams ?? []}
      search={search}
      onSearch={setSearch}
      loading={loading}
      {...(error === "" ? {} : { error })}
      {...(busyId === undefined ? {} : { busyId })}
      onNew={() => setEditing({})}
      onEdit={(row) => setEditing({ row })}
      onToggle={(row) => void handleToggle(row)}
      onRemove={(row) => void handleRemove(row)}
    />
  );
}
