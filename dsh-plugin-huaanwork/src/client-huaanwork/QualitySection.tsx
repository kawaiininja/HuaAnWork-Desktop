import { useEffect, useRef, useState } from "react";
import { rpcCall } from "./api.ts";
import { catalogFormErrors } from "./logic/agentsLogic.ts";

/**
 * 设置「质检」页的公用机配置(2026-11-10 从智能体页迁入,用户裁定智能体页不再
 * 保留任何配置相关信息)。字段、占位文案、校验与 settings.set 形状与原配置栏一致;
 * 保存成功经 onSaved 通知 App 自增 agentChangeSignal,智能体页沿用既有监听重拉。
 */
export default function QualitySection({ onSaved }: { onSaved?: () => void }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  const [publishToken, setPublishToken] = useState("");
  const [hostFieldErrors, setHostFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  /** 卸载后不再写回任何状态(在飞请求返回时静默丢弃)。 */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const handleSave = async () => {
    const localErrors = catalogFormErrors(host, port);
    if (Object.keys(localErrors).length > 0) {
      setHostFieldErrors(localErrors);
      return;
    }
    setSaving(true);
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
      onSaved?.();
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <>
      <h3>公用机配置</h3>
      <p className="hint">在公用机完成质检后，把该机地址和端口填在这里。</p>
      <label>
        公用机地址
        <input
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
      </label>
      <label>
        端口
        <input
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
      </label>
      <label>
        访问口令（可选）
        <input
          type="password"
          value={token}
          placeholder="访问口令（可选）"
          aria-label="访问口令"
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <label>
        发布口令（创建者）
        <input
          type="password"
          value={publishToken}
          placeholder="发布口令（创建者）"
          aria-label="发布口令"
          onChange={(event) => setPublishToken(event.target.value)}
        />
      </label>
      <div className="row">
        <button type="button" disabled={saving} onClick={() => void handleSave()}>
          {saving ? "保存中…" : "保存配置"}
        </button>
      </div>
      {note ? <p className="hint">{note}</p> : null}
      {error ? <p className="banner error">{error}</p> : null}
    </>
  );
}