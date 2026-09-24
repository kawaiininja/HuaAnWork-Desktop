import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ThemePref } from "./logic/accountStatus.ts";
import { pickDirectory, rpcCall } from "./api.ts";

export const PLUGIN_CONFIRM =
  "该包将在 sidecar 内执行 apply(ctx)，权限与本机用户相同；护栏只约束模型工具调用，不沙箱化插件代码。\n\napply(ctx) runs as the user, not sandboxed.";

export const PLUGIN_APPLY_FAIL = "禁用后装插件并重启";

export type SettingsSection = "model" | "appearance" | "account" | "permissions";

export type ModelEntry = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
};

export type ModelSettingsPayload = {
  base_url?: string;
  model?: string;
  api_key?: string;
  models?: ModelEntry[];
  active_model_id?: string;
  /** 公网开关：缺省 false（本机+局域网）。 */
  allow_network?: boolean;
  /** 存在启用中的非手动任务时阻止系统睡眠：缺省 true。 */
  keep_awake?: boolean;
  /** 护栏策略档位：ask / smart / full；缺省按 ask 处理。 */
  guard_mode?: string;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

export function modelDisplayName(entry: Pick<ModelEntry, "name" | "model"> | undefined, fallback = "未设置模型"): string {
  if (!entry) return fallback;
  return entry.name.trim() || entry.model.trim() || fallback;
}

export function applySettingsModels(settings: ModelSettingsPayload): {
  models: ModelEntry[];
  activeId: string;
  label: string;
} {
  const models = settings.models ?? [];
  const active = models.find((entry) => entry.id === settings.active_model_id) ?? models[0];
  return {
    models,
    activeId: active?.id ?? "",
    label: modelDisplayName(active, settings.model || "未设置模型"),
  };
}

type Draft = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  existing: boolean;
};

type Props = {
  onClose: () => void;
  onPluginApplyFail: (message: string) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  theme: ThemePref;
  onThemeChange: (theme: ThemePref) => Promise<void>;
  username: string;
  onChangePassword: (current: string, next: string) => Promise<void>;
  onModelsChange?: (settings: ModelSettingsPayload) => void;
  /** Task 10：上一次持有系统防睡眠断言的尝试是否失败（或该 OS 不支持）；App 侧根据
   * automation.list 刷新后的判定结果调用 Rust command 后回填，此处只读展示静态提示。 */
  keepAwakeUnavailable: boolean;
};

export function ModelChip({
  label,
  models,
  activeId,
  onSelect,
  onManage,
}: {
  label: string;
  models: ModelEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, placed: false });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function closeMenu() {
    setOpen(false);
    setMenuPos((prev) => ({ ...prev, placed: false }));
  }

  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setOpen(false);
      setMenuPos((prev) => ({ ...prev, placed: false }));
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || btnRef.current?.contains(target))) return;
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const rect = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let top = rect.top - mh - 6;
    let left = rect.left;
    if (top < 8) top = rect.bottom + 6;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    setMenuPos({ top, left, placed: true });
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      btnRef.current?.focus();
    }
  }

  if (!label) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={open ? "chip pick" : "chip"}
        title="切换模型或打开设置"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (models.length === 0) {
            onManage();
            return;
          }
          setOpen((prev) => !prev);
        }}
      >
        {label}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="context-menu model-menu"
          role="menu"
          style={{ top: menuPos.top, left: menuPos.left, visibility: menuPos.placed ? "visible" : "hidden" }}
          onKeyDown={onMenuKeyDown}
        >
          {models.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              className={entry.id === activeId ? "context-menu-item on" : "context-menu-item"}
              onClick={() => {
                closeMenu();
                if (entry.id !== activeId) onSelect(entry.id);
              }}
            >
              <span>{modelDisplayName(entry)}</span>
              {entry.id === activeId ? <span className="kbd">当前</span> : null}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              closeMenu();
              onManage();
            }}
          >
            管理模型…
          </button>
        </div>
      ) : null}
    </>
  );
}

const ICON_PROPS = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function IconModel() {
  return (
    <svg {...ICON_PROPS}>
      <title>模型</title>
      <rect x="3" y="4" width="10" height="8" rx="1.5" />
      <path d="M6 2.5v1.5M10 2.5v1.5M6 12v1.5M10 12v1.5M2.5 7h1.5M2.5 9h1.5M12 7h1.5M12 9h1.5" />
    </svg>
  );
}

function IconAppearance() {
  return (
    <svg {...ICON_PROPS}>
      <title>外观</title>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 2.5v1.6M8 11.9v1.6M2.5 8h1.6M11.9 8h1.6M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M4.1 11.9l1.1-1.1M10.8 5.2l1.1-1.1" />
    </svg>
  );
}

function IconAccount() {
  return (
    <svg {...ICON_PROPS}>
      <title>账户</title>
      <circle cx="8" cy="6" r="2.2" />
      <path d="M3.5 13c.6-2.4 2.2-3.6 4.5-3.6s3.9 1.2 4.5 3.6" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg {...ICON_PROPS}>
      <title>权限</title>
      <path d="M8 2.5l4.5 1.6v3.4c0 2.9-1.9 4.9-4.5 6-2.6-1.1-4.5-3.1-4.5-6V4.1z" />
      <path d="M6.1 7.9l1.3 1.3 2.5-2.5" />
    </svg>
  );
}

const NAV: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "account", label: "账户", icon: <IconAccount /> },
  { id: "appearance", label: "外观", icon: <IconAppearance /> },
  { id: "model", label: "模型", icon: <IconModel /> },
  { id: "permissions", label: "权限", icon: <IconShield /> },
];

const THEME_SEGMENTS: { id: ThemePref; label: string }[] = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "system", label: "跟随系统" },
];

function emptyDraft(baseUrl: string): Draft {
  return {
    id: crypto.randomUUID(),
    name: "",
    base_url: baseUrl || DEFAULT_BASE_URL,
    model: "",
    api_key: "",
    existing: false,
  };
}

export default function Settings({
  onClose,
  onPluginApplyFail,
  section,
  onSectionChange,
  theme,
  onThemeChange,
  username,
  onChangePassword,
  onModelsChange,
  keepAwakeUnavailable,
}: Props) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [bundles, setBundles] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [workAllowNetwork, setWorkAllowNetwork] = useState(false);
  const [keepAwake, setKeepAwakeSetting] = useState(true);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  function applyPayload(payload: ModelSettingsPayload) {
    const next = applySettingsModels(payload);
    setModels(next.models);
    setActiveId(next.activeId);
    onModelsChange?.(payload);
  }

  useEffect(() => {
    void (async () => {
      try {
        const payload = await rpcCall<ModelSettingsPayload>("settings.get");
        const next = applySettingsModels(payload);
        setModels(next.models);
        setActiveId(next.activeId);
        setWorkAllowNetwork(payload.allow_network === true);
        setKeepAwakeSetting(payload.keep_awake !== false);
        const listed = await rpcCall<{ bundles: string[] }>("plugin.list");
        setBundles(listed.bundles ?? []);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  /** 公网开关：持久化到 settings.json，并同步 App 侧 composer 的局域网指示。 */
  async function toggleWorkNetwork(next: boolean) {
    try {
      const payload = await rpcCall<ModelSettingsPayload>("settings.set", { allow_network: next });
      setWorkAllowNetwork(payload.allow_network === true);
      onModelsChange?.(payload);
      setStatus(next ? "已允许接入公网：可使用公网模型端点" : "已恢复仅局域网：禁止接入公网");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  /** 保持系统唤醒开关：持久化到 settings.json；实际的断言持有/释放由 App 在
   * automation.list 刷新后根据 shouldHoldKeepAwake 调用 Rust command（sidecar 无法 invoke）。 */
  async function toggleKeepAwake(next: boolean) {
    try {
      const payload = await rpcCall<ModelSettingsPayload>("settings.set", { keep_awake: next });
      setKeepAwakeSetting(payload.keep_awake !== false);
      onModelsChange?.(payload);
      setStatus(next ? "已开启保持系统唤醒" : "已关闭保持系统唤醒");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function persist(nextModels: ModelEntry[], nextActive: string) {
    const payload = await rpcCall<ModelSettingsPayload>("settings.set", {
      models: nextModels,
      active_model_id: nextActive,
    });
    applyPayload(payload);
    return payload;
  }

  async function saveDraft() {
    if (!draft) return;
    const entry: ModelEntry = {
      id: draft.id,
      name: draft.name.trim() || draft.model.trim() || "未命名",
      base_url: draft.base_url.trim() || DEFAULT_BASE_URL,
      model: draft.model.trim(),
      api_key: draft.api_key,
    };
    const nextModels = draft.existing
      ? models.map((item) => (item.id === entry.id ? entry : item))
      : [...models, entry];
    const nextActive = nextModels.some((item) => item.id === activeId) ? activeId : entry.id;
    try {
      await persist(nextModels, nextModels.length === 1 ? entry.id : nextActive);
      setDraft(null);
      setStatus("已保存（空 api_key 有效）");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function activate(id: string) {
    try {
      await persist(models, id);
      setStatus("已切换当前模型");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeModel(id: string) {
    const nextModels = models.filter((item) => item.id !== id);
    const nextActive = id === activeId ? (nextModels[0]?.id ?? "") : activeId;
    try {
      await persist(nextModels, nextActive);
      if (draft?.id === id) setDraft(null);
      setStatus(nextModels.length === 0 ? "已删除，请添加模型" : "已删除");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function pickPlugin(_kind: "dir" | "tgz") {
    const selected = await pickDirectory();
    if (!selected) return;
    setConfirming(selected);
  }

  async function confirmAdd() {
    if (!confirming) return;
    const source = confirming;
    setConfirming(null);
    try {
      // 取消重启时 message 诚实告知「已写入清单,下次启动生效」(M4 评审 D3);
      // 确认路径应用随即 relaunch,应答常不可达,保持原「插件已安装」缺省。
      const listed = await rpcCall<{ bundles: string[]; message?: string }>("plugin.add", { source });
      setBundles(listed.bundles ?? []);
      setStatus(listed.message ?? "插件已安装");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onPluginApplyFail(PLUGIN_APPLY_FAIL);
      setStatus(`${PLUGIN_APPLY_FAIL}：${message}`);
    }
  }

  async function remove(name: string) {
    try {
      const listed = await rpcCall<{ bundles: string[]; message?: string }>("plugin.remove", { name });
      setBundles(listed.bundles ?? []);
      if (listed.message) setStatus(listed.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onPluginApplyFail(PLUGIN_APPLY_FAIL);
      setStatus(`${PLUGIN_APPLY_FAIL}：${message}`);
    }
  }

  async function changeTheme(next: ThemePref) {
    try {
      await onThemeChange(next);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitPassword() {
    if (nextPassword !== confirmPassword) {
      setStatus("两次输入的新密码不一致");
      return;
    }
    if ([...nextPassword].length < 8) {
      setStatus("密码至少 8 位");
      return;
    }
    try {
      await onChangePassword(currentPassword, nextPassword);
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setStatus("密码已更新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="settings-overlay" role="dialog" aria-label="设置">
      <div className="settings-panel settings-wide">
        <header className="pane-header">
          <h2>设置</h2>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分组">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={section === item.id ? "on" : ""}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => onSectionChange(item.id)}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {section === "model" ? (
              <>
                <ul className="model-list">
                  {models.map((entry) => (
                    <li key={entry.id} className={entry.id === activeId ? "model-card on" : "model-card"}>
                      <div className="model-card-head">
                        <div>
                          <div className="model-card-name">{modelDisplayName(entry)}</div>
                          <div className="model-card-meta">
                            {entry.model || "未填 model"}
                            {entry.base_url ? ` · ${entry.base_url}` : ""}
                          </div>
                        </div>
                        {entry.id === activeId ? <span className="model-badge">当前</span> : null}
                      </div>
                      <div className="row">
                        {entry.id === activeId ? null : (
                          <button type="button" onClick={() => void activate(entry.id)}>
                            使用
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setDraft({
                              id: entry.id,
                              name: entry.name,
                              base_url: entry.base_url,
                              model: entry.model,
                              api_key: entry.api_key,
                              existing: true,
                            })
                          }
                        >
                          编辑
                        </button>
                        <button type="button" onClick={() => void removeModel(entry.id)}>
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                {models.length === 0 && !draft ? <p className="hint">还没有模型。添加一条 OpenAI 兼容配置。</p> : null}
                {draft ? (
                  <form
                    className="model-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveDraft();
                    }}
                  >
                    <label>
                      名称
                      <input
                        value={draft.name}
                        placeholder="显示名，可空"
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      />
                    </label>
                    <label>
                      base_url
                      <input
                        value={draft.base_url}
                        onChange={(event) => setDraft({ ...draft, base_url: event.target.value })}
                      />
                    </label>
                    <label>
                      model
                      <input
                        value={draft.model}
                        onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                      />
                    </label>
                    <label>
                      api_key（可空）
                      <input
                        value={draft.api_key}
                        onChange={(event) => setDraft({ ...draft, api_key: event.target.value })}
                      />
                    </label>
                    <div className="row">
                      <button type="submit">保存</button>
                      <button type="button" onClick={() => setDraft(null)}>
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDraft(emptyDraft(models[0]?.base_url ?? DEFAULT_BASE_URL))}
                  >
                    添加模型
                  </button>
                )}
                <h3>插件</h3>
                <p className="hint">仅本地目录或 .tgz。拒绝 GitHub / URL。</p>
                <div className="row">
                  <button type="button" onClick={() => void pickPlugin("dir")}>
                    添加目录
                  </button>
                  <button type="button" onClick={() => void pickPlugin("tgz")}>
                    添加 .tgz
                  </button>
                </div>
                <ul className="plugin-list">
                  {bundles.map((name) => (
                    <li key={name}>
                      <span>{name}</span>
                      <button type="button" onClick={() => void remove(name)}>
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {section === "appearance" ? (
              <div className="theme-seg" role="tablist" aria-label="外观">
                {THEME_SEGMENTS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={theme === item.id}
                    className={theme === item.id ? "on" : ""}
                    onClick={() => void changeTheme(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            {section === "permissions" ? (
              <div className="perm-pane">
                <h3>网络权限</h3>
                <p className="hint">
                  默认允许连接本机与局域网模型端点（localhost、10/8、172.16/12、192.168/16 等），禁止接入公网。
                </p>
                <label className="perm-row">
                  <input
                    type="checkbox"
                    checked={workAllowNetwork}
                    onChange={(event) => void toggleWorkNetwork(event.target.checked)}
                  />
                  <span className="perm-check" aria-hidden="true" />
                  <span className="perm-text">
                    <span className="perm-title">允许接入公网</span>
                    <span className="perm-desc">
                      开启后，可使用公网 OpenAI 兼容端点。开启前请确认会话内容允许发往该端点。
                    </span>
                  </span>
                </label>
                <p className="hint">
                  当前状态：{workAllowNetwork ? "可接入公网" : "仅局域网（禁止公网）"}
                </p>
              </div>
            ) : null}
            {section === "account" ? (
              <>
                <p className="account-username">
                  <span>用户名</span>
                  {username}
                </p>
                <div className="perm-pane" style={{ marginBottom: 20 }}>
                  <label className="perm-row">
                    <input
                      type="checkbox"
                      checked={keepAwake}
                      onChange={(event) => void toggleKeepAwake(event.target.checked)}
                    />
                    <span className="perm-check" aria-hidden="true" />
                    <span className="perm-text">
                      <span className="perm-title">保持系统唤醒</span>
                      <span className="perm-desc">
                        存在启用中的定时任务时阻止系统进入睡眠（屏幕仍可正常熄屏）。任务中心右上角也有同一开关的快捷入口。
                      </span>
                    </span>
                  </label>
                  {keepAwakeUnavailable ? <p className="hint">系统阻止睡眠不可用</p> : null}
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitPassword();
                  }}
                >
                  <label>
                    当前
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                  </label>
                  <label>
                    新
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={nextPassword}
                      onChange={(event) => setNextPassword(event.target.value)}
                    />
                  </label>
                  <label>
                    确认
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                    />
                  </label>
                  <button type="submit">更改密码</button>
                </form>
              </>
            ) : null}
          </div>
        </div>
        {status ? <p className="status">{status}</p> : null}
      </div>
      {confirming ? (
        <div className="confirm-modal">
          <p>{PLUGIN_CONFIRM}</p>
          <p className="hint">{confirming}</p>
          <div className="row">
            <button type="button" onClick={() => void confirmAdd()}>
              安装
            </button>
            <button type="button" onClick={() => setConfirming(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
