import { useEffect, useState, type FormEvent } from "react";
import { sidecarStatus } from "./logic/accountStatus.ts";
import { authFormReady } from "./logic/authForm.ts";
import { rpcCall } from "./api.ts";

export type AuthStatus = {
  state: "needs-register" | "logged-out" | "logged-in";
  username?: string;
};

type Props = {
  ready: boolean;
  sidecarDead: boolean;
  mode: "needs-register" | "logged-out";
  /** 尚未拿到 auth.status 时为 false：表单可填，但不能提交。 */
  canSubmit?: boolean;
  /** 启动中：不展示登录表，等 sidecar 读出已有会话。 */
  restoring?: boolean;
  savedUsername?: string;
  onAuthed: (username: string) => void;
};

export default function AuthGate({
  ready,
  sidecarDead,
  mode,
  canSubmit = true,
  restoring = false,
  savedUsername = "",
  onAuthed,
}: Props) {
  const [username, setUsername] = useState(savedUsername);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (savedUsername) setUsername((prev) => prev || savedUsername);
  }, [savedUsername]);
  const status = sidecarStatus(ready, sidecarDead);
  const creating = mode === "needs-register";
  const formReady = authFormReady(creating, username, password, confirm);
  const submitDisabled = !canSubmit || sidecarDead || busy || !formReady;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitDisabled) return;
    if (!ready) {
      setError(status.label);
      return;
    }
    setError("");
    setBusy(true);
    try {
      const method = creating ? "auth.register" : "auth.login";
      const result = await rpcCall<AuthStatus>(method, { username, password });
      onAuthed(result.username ?? username.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (restoring) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <h1>HuaAnWork</h1>
          <p className="auth-sidecar">{ready ? "正在进入…" : status.label}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-gate">
      <form className="auth-card" onSubmit={(event) => void onSubmit(event)}>
        <h1>{creating ? "创建账户" : "登录"}</h1>
        <label>
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          密码
          <input
            type="password"
            autoComplete={creating ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {creating ? (
          <label>
            确认密码
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
        ) : null}
        <button type="submit" disabled={submitDisabled}>
          进入
        </button>
        <p className="auth-sidecar">{status.label}</p>
        {error ? <p className="auth-error">{error}</p> : null}
      </form>
    </div>
  );
}
