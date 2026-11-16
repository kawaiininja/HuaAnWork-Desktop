import { useCallback, useEffect, useState } from "react";

import { pickDirectory, rpcCall } from "./api.ts";
import {
  RESERVED_SKILL_NAMES,
  SKILL_TABS,
  busyKeyFor,
  centerActionLabel,
  filterCenterSkills,
  filterLocalSkills,
  isBuiltinNameConflict,
  isUploadDisabled,
  originLabel,
  sourceLabel,
  tabLabel,
  uploadActionLabel,
  validateDuplicateName,
  validateSkillForm,
  type CenterSkillInfo,
  type LocalSkillInfo,
  type SkillDetail,
  type SkillFormValues,
  type SkillImportPreview,
  type SkillTab,
  type SkillWriteResult,
} from "./logic/skillsLogic.ts";

type Modal =
  | { kind: "view"; skill: SkillDetail }
  | { kind: "create" }
  | { kind: "edit"; skill: SkillDetail }
  | { kind: "delete"; skill: LocalSkillInfo }
  | { kind: "import-pick" }
  | { kind: "import-confirm"; path: string; preview: Extract<SkillImportPreview, { ok: true }>["preview"] }
  | { kind: "duplicate"; skill: LocalSkillInfo };

export default function SkillsView({
  refreshSignal = 0,
  initialTab = "center",
  onInvocableChanged,
  onStartConversationCreate,
}: {
  refreshSignal?: number;
  /** 挂载时打开的标签；“前往我的技能”用它直达“我的技能”而不是技能中心。 */
  initialTab?: SkillTab;
  onInvocableChanged?: () => void;
  onStartConversationCreate?: () => void;
}) {
  const [tab, setTab] = useState<SkillTab>(initialTab);
  const [centerSkills, setCenterSkills] = useState<CenterSkillInfo[]>([]);
  const [localSkills, setLocalSkills] = useState<LocalSkillInfo[]>([]);
  const [centerSearch, setCenterSearch] = useState("");
  const [localSearch, setLocalSearch] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [migrationWarnings, setMigrationWarnings] = useState<string[]>([]);
  const [centerError, setCenterError] = useState("");
  const [mineError, setMineError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);

  const closeModal = () => {
    setModalError("");
    setModal(null);
  };

  const reportError = (cause: unknown, where: "center" | "mine") => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (where === "center") setCenterError(message);
    else setMineError(message);
  };

  const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  const refreshMine = useCallback(async () => {
    try {
      const listed = await rpcCall<{ skills: LocalSkillInfo[] }>("skill.mineList");
      setLocalSkills(Array.isArray(listed.skills) ? listed.skills : []);
      setMineError("");
    } catch (cause) {
      reportError(cause, "mine");
    }
  }, []);

  const refreshCenter = useCallback(async () => {
    try {
      const listed = await rpcCall<{ skills: CenterSkillInfo[]; catalogError?: string; migrationWarnings?: string[] }>("skill.centerList");
      setCenterSkills(Array.isArray(listed.skills) ? listed.skills : []);
      setCatalogError(listed.catalogError ?? "");
      setMigrationWarnings(Array.isArray(listed.migrationWarnings) ? listed.migrationWarnings : []);
      setCenterError("");
    } catch (cause) {
      reportError(cause, "center");
    }
  }, []);

  useEffect(() => {
    // The center list also supplies the bundled-name set for my-skills cards,
    // so load it on mount even while 我的技能 is active.
    void refreshCenter();
    if (tab === "mine") void refreshMine();
  }, [tab, refreshSignal, refreshCenter, refreshMine]);

  const openView = async (name: string, source: "bundled" | "catalog" | "user", revision?: number) => {
    try {
      const params = source === "catalog" ? { name, source, revision } : { name, source };
      const detail = await rpcCall<{ skill: SkillDetail }>("skill.get", params);
      setModal({ kind: "view", skill: detail.skill });
    } catch (cause) {
      reportError(cause, source === "user" ? "mine" : "center");
    }
  };

  const openEdit = async (skill: LocalSkillInfo) => {
    try {
      const detail = await rpcCall<{ skill: SkillDetail }>("skill.get", { name: skill.name, source: "user" });
      setModal({ kind: "edit", skill: detail.skill });
    } catch (cause) {
      reportError(cause, "mine");
    }
  };

  const downloadSkill = async (skill: CenterSkillInfo) => {
    const key = busyKeyFor(skill.source, skill.name);
    if (busy.has(key)) return;
    setBusy((prev) => new Set(prev).add(key));
    setCenterError("");
    try {
      await rpcCall("skill.download", {
        source: skill.source,
        name: skill.name,
        ...(skill.revision !== undefined ? { revision: skill.revision } : {}),
      });
      setNote(`已下载技能 ${skill.name}，请在“我的技能”中启用`);
      await Promise.all([refreshCenter(), refreshMine()]);
      onInvocableChanged?.();
    } catch (cause) {
      setNote("");
      reportError(cause, "center");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const uploadSkill = async (skill: LocalSkillInfo) => {
    const key = busyKeyFor("user", skill.name);
    if (busy.has(key)) return;
    setBusy((prev) => new Set(prev).add(key));
    setMineError("");
    try {
      const result = await rpcCall<{ skill: LocalSkillInfo; created: boolean }>("skill.upload", { name: skill.name });
      const revision = result.skill.publishedRevision;
      setNote(
        revision === undefined
          ? `已发布技能 ${skill.name}`
          : `已发布技能 ${skill.name}（revision ${revision}）`,
      );
      await Promise.all([refreshMine(), refreshCenter()]);
    } catch (cause) {
      setNote("");
      reportError(cause, "mine");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const toggleSkill = async (skill: LocalSkillInfo) => {
    const key = busyKeyFor("user", skill.name);
    if (busy.has(key)) return;
    const enabling = !skill.enabled;
    setBusy((prev) => new Set(prev).add(key));
    setMineError("");
    try {
      await rpcCall("skill.setEnabled", { name: skill.name, enabled: enabling });
      setNote(
        enabling
          ? `已启用技能 ${skill.name}，可在对话框输入 / 调用`
          : `已禁用技能 ${skill.name}`,
      );
      await refreshMine();
      onInvocableChanged?.();
    } catch (cause) {
      setNote("");
      reportError(cause, "mine");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const removeSkill = async (skill: LocalSkillInfo) => {
    setModalBusy(true);
    setModalError("");
    setMineError("");
    try {
      await rpcCall("skill.remove", { name: skill.name });
      setModal(null);
      setNote(`已删除技能 ${skill.name}`);
      await Promise.all([refreshMine(), refreshCenter()]);
      onInvocableChanged?.();
    } catch (cause) {
      setModalError(errorMessage(cause));
    } finally {
      setModalBusy(false);
    }
  };

  const duplicateSkill = async (skill: LocalSkillInfo, target: string) => {
    setModalBusy(true);
    setModalError("");
    setMineError("");
    try {
      await rpcCall("skill.duplicate", { source: skill.name, name: target });
      setModal(null);
      setNote(`已另存为技能 ${target}，请在“我的技能”中启用`);
      await refreshMine();
      onInvocableChanged?.();
    } catch (cause) {
      setModalError(errorMessage(cause));
    } finally {
      setModalBusy(false);
    }
  };

  const pickImport = async (_directory: boolean) => {
    const selected = await pickDirectory();
    if (typeof selected !== "string") return; // 用户取消
    try {
      const preview = await rpcCall<SkillImportPreview>("skill.importPreview", { path: selected });
      if (!preview.ok) {
        setMineError(preview.fieldErrors.map((error) => error.message).join("；"));
        setModal(null);
        return;
      }
      setModal({ kind: "import-confirm", path: selected, preview: preview.preview });
    } catch (cause) {
      reportError(cause, "mine");
      setModal(null);
    }
  };

  const confirmImport = async (path: string, name: string) => {
    setModalBusy(true);
    setModalError("");
    try {
      const result = await rpcCall<SkillWriteResult>("skill.import", { path });
      if (!result.ok) {
        setModalError(result.fieldErrors.map((error) => error.message).join("；"));
        return;
      }
      setModal(null);
      setNote(`已导入技能 ${name}，请在“我的技能”中启用`);
      await refreshMine();
    } catch (cause) {
      setModalError(errorMessage(cause));
    } finally {
      setModalBusy(false);
    }
  };

  const centerVisible = filterCenterSkills(centerSkills, centerSearch);
  const localVisible = filterLocalSkills(localSkills, localSearch);
  const bundledNames = new Set(centerSkills.filter((skill) => skill.source === "bundled").map((skill) => skill.name));
  const takenLocalNames = localSkills.map((skill) => skill.name);

  return (
    <div className="page-view">
      <div className="page-head">
        <h1>{tabLabel(tab)}</h1>
        <span className="hint-text">把经验、方法和工具封装成技能，相似任务轻松复用</span>
      </div>
      <div className="page-tools">
        <input
          className="search-input"
          value={tab === "center" ? centerSearch : localSearch}
          placeholder={tab === "center" ? "🔍 搜索技能中心" : "🔍 搜索我的技能"}
          aria-label={tab === "center" ? "搜索技能中心" : "搜索我的技能"}
          onChange={(event) => {
            if (tab === "center") setCenterSearch(event.target.value);
            else setLocalSearch(event.target.value);
          }}
        />
        {SKILL_TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? "filter-tab on" : "filter-tab"}
            onClick={() => setTab(item)}
          >
            {tabLabel(item)}
          </button>
        ))}
        <span className="composer-spacer" />
        {tab === "center" ? (
          <button type="button" className="filter-tab" onClick={() => void refreshCenter()}>
            刷新
          </button>
        ) : (
          <>
            <button type="button" className="filter-tab" onClick={() => onStartConversationCreate?.()}>
              对话创建技能
            </button>
            <button type="button" className="filter-tab" onClick={() => setModal({ kind: "import-pick" })}>
              导入技能
            </button>
            <button type="button" className="btn-dark" onClick={() => setModal({ kind: "create" })}>
              ＋ 创建技能
            </button>
          </>
        )}
      </div>
      {tab === "center" && catalogError ? <p className="banner">{catalogError}</p> : null}
      {tab === "center" && migrationWarnings.length > 0 ? (
        <p className="hint">{migrationWarnings.join("；")}</p>
      ) : null}
      {tab === "center" && centerError ? <p className="banner error">{centerError}</p> : null}
      {tab === "mine" && mineError ? <p className="banner error">{mineError}</p> : null}
      {note ? (
        <p className="hint" style={{ marginBottom: 12 }}>
          {note}
        </p>
      ) : null}
      {tab === "center" ? (
        centerVisible.length === 0 ? (
          <p className="panel-empty">{centerSearch.trim() ? "没有匹配的技能" : "暂无技能"}</p>
        ) : (
          <div className="skill-grid">
            {centerVisible.map((skill) => {
              const key = busyKeyFor(skill.source, skill.name);
              const actionable = skill.downloadState === "available" || skill.downloadState === "update-available";
              return (
                <div key={key} className="skill-card">
                  <div className="top">
                    <span className="av">{skill.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <div className="nm">{skill.name}</div>
                      <div className="src">{sourceLabel(skill.source)}</div>
                    </div>
                  </div>
                  <p>{skill.description}</p>
                  {skill.source === "catalog" ? (
                    <p className="hint">
                      发布者 {skill.publisher ?? "未知"} · revision {skill.revision ?? "?"} · {skill.updatedAt ?? ""}
                    </p>
                  ) : null}
                  <div className="page-tools" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="filter-tab"
                      onClick={() =>
                        void openView(
                          skill.name,
                          skill.source,
                          skill.source === "catalog" ? skill.revision : undefined,
                        )
                      }
                    >
                      查看
                    </button>
                    {skill.downloadState === "not-applicable" ? (
                      <span className="src" style={{ padding: "4px 0" }}>
                        {centerActionLabel(skill.downloadState)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="filter-tab"
                        disabled={!actionable || busy.has(key)}
                        aria-label={`${centerActionLabel(skill.downloadState)}技能 ${skill.name}`}
                        onClick={() => void downloadSkill(skill)}
                      >
                        {centerActionLabel(skill.downloadState)}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : localVisible.length === 0 ? (
        localSearch.trim() ? (
          <p className="panel-empty">没有匹配的技能</p>
        ) : (
          <p className="panel-empty">
            还没有创建过技能。{" "}
            <button type="button" className="filter-tab" onClick={() => setModal({ kind: "create" })}>
              创建第一个技能
            </button>{" "}
            或点“导入技能”从文件导入。
          </p>
        )
      ) : (
        <div className="skill-grid">
          {localVisible.map((skill) => {
            const key = busyKeyFor("user", skill.name);
            const builtinSameName = isBuiltinNameConflict(skill, bundledNames);
            const uploadDisabled = busy.has(key) || isUploadDisabled(skill, bundledNames);
            return (
              <div key={key} className="skill-card">
                <div className="top">
                  <span className="av">{skill.name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <div className="nm">{skill.name}</div>
                    <div className="src">{originLabel(skill.origin)}</div>
                  </div>
                </div>
                <p>{skill.description}</p>
                <div className="page-tools" style={{ marginTop: 8 }}>
                  <button type="button" className="filter-tab" onClick={() => void openView(skill.name, "user")}>
                    查看
                  </button>
                  <button type="button" className="filter-tab" onClick={() => void openEdit(skill)}>
                    编辑
                  </button>
                  <button type="button" className="filter-tab" onClick={() => setModal({ kind: "delete", skill })}>
                    删除
                  </button>
                  <button
                    type="button"
                    className={skill.enabled ? "filter-tab on" : "filter-tab"}
                    aria-pressed={skill.enabled}
                    aria-label={`${skill.enabled ? "禁用" : "启用"}技能 ${skill.name}`}
                    disabled={busy.has(key)}
                    onClick={() => void toggleSkill(skill)}
                  >
                    {skill.enabled ? "已启用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="filter-tab"
                    disabled={uploadDisabled}
                    aria-label={`上传技能 ${skill.name}`}
                    onClick={() => void uploadSkill(skill)}
                  >
                    {uploadActionLabel(skill.publishState)}
                  </button>
                  {builtinSameName ? (
                    <button
                      type="button"
                      className="filter-tab"
                      onClick={() => setModal({ kind: "duplicate", skill })}
                    >
                      另存为新技能
                    </button>
                  ) : null}
                </div>
                {builtinSameName ? (
                  <p className="hint">与内置技能同名，请另存为新技能后上传</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {modal?.kind === "view" ? <SkillViewModal skill={modal.skill} onClose={() => setModal(null)} /> : null}
      {modal?.kind === "create" || modal?.kind === "edit" ? (
        <SkillFormModal
          source={modal.kind === "edit" ? modal.skill : null}
          takenNames={[...takenLocalNames, ...RESERVED_SKILL_NAMES]}
          onClose={() => setModal(null)}
          onSaved={async (name, editing) => {
            setModal(null);
            setNote(editing ? `已保存技能 ${name}` : `已保存技能 ${name}，请在“我的技能”中启用`);
            await refreshMine();
            onInvocableChanged?.();
          }}
        />
      ) : null}
      {modal?.kind === "delete" ? (
        <SkillDeleteModal skill={modal.skill} busy={modalBusy} error={modalError} onCancel={closeModal} onConfirm={() => void removeSkill(modal.skill)} />
      ) : null}
      {modal?.kind === "import-pick" ? (
        <ImportPickModal onPick={(directory) => void pickImport(directory)} onClose={() => setModal(null)} />
      ) : null}
      {modal?.kind === "import-confirm" ? (
        <ImportConfirmModal
          preview={modal.preview}
          busy={modalBusy}
          error={modalError}
          onCancel={closeModal}
          onConfirm={() => void confirmImport(modal.path, modal.preview.targetName)}
        />
      ) : null}
      {modal?.kind === "duplicate" ? (
        <SkillDuplicateModal
          skill={modal.skill}
          busy={modalBusy}
          error={modalError}
          takenNames={[...takenLocalNames, ...RESERVED_SKILL_NAMES, ...bundledNames]}
          onCancel={closeModal}
          onConfirm={(target) => void duplicateSkill(modal.skill, target)}
        />
      ) : null}
    </div>
  );
}

function SkillViewModal({ skill, onClose }: { skill: SkillDetail; onClose: () => void }) {
  return (
    <div className="settings-overlay" role="dialog" aria-label={`查看技能 ${skill.name}`}>
      <div className="confirm-modal automation-form">
        <h3>{skill.name}</h3>
        <p className="sub">{skill.description}</p>
        {skill.whenToUse ? <p className="hint">何时使用：{skill.whenToUse}</p> : null}
        <pre className="diff" style={{ maxHeight: 320, overflow: "auto" }}>{skill.content}</pre>
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillFormModal({
  source,
  takenNames,
  onClose,
  onSaved,
}: {
  source: SkillDetail | null;
  takenNames: readonly string[];
  onClose: () => void;
  onSaved: (name: string, editing: boolean) => Promise<void>;
}) {
  const editing = source !== null;
  const [values, setValues] = useState<SkillFormValues>({
    name: source?.name ?? "",
    description: source?.description ?? "",
    whenToUse: source?.whenToUse ?? "",
    content: source?.content ?? "",
    disableModelInvocation: source?.disableModelInvocation ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyState, setBusyState] = useState(false);

  const patch = (part: Partial<SkillFormValues>) => setValues((prev) => ({ ...prev, ...part }));

  const submit = async () => {
    const local = validateSkillForm(values, { editing, takenNames });
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }
    setBusyState(true);
    try {
      const params = {
        description: values.description.trim(),
        whenToUse: values.whenToUse.trim() || undefined,
        content: values.content,
        disableModelInvocation: values.disableModelInvocation,
      };
      const result = await rpcCall<SkillWriteResult>(
        editing ? "skill.update" : "skill.create",
        editing ? { name: source.name, ...params } : { name: values.name, ...params },
      );
      if (!result.ok) {
        setErrors(Object.fromEntries(result.fieldErrors.map((error) => [error.field, error.message])));
        return;
      }
      await onSaved(editing ? source.name : values.name, editing);
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusyState(false);
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label={editing ? "编辑技能" : "创建技能"}>
      <div className="confirm-modal automation-form">
        <h3>{editing ? "编辑技能" : "创建技能"}</h3>
        <p className="sub">技能 = 一段写给模型的方法说明（Markdown），保存后在“我的技能”中启用即可使用</p>
        {errors.form ? <p className="banner error">{errors.form}</p> : null}
        <div className="automation-form-body">
        <label className="modal-field">
          名称（kebab-case，保存后不可改）
          <input
            className="modal-input"
            value={values.name}
            autoFocus={!editing}
            disabled={editing}
            placeholder="如：daily-report"
            onChange={(event) => patch({ name: event.target.value })}
          />
          {errors.name ? <span className="hint">{errors.name}</span> : null}
        </label>
        <label className="modal-field">
          描述
          <input
            className="modal-input"
            value={values.description}
            placeholder="一句话说明这个技能做什么"
            onChange={(event) => patch({ description: event.target.value })}
          />
          {errors.description ? <span className="hint">{errors.description}</span> : null}
        </label>
        <label className="modal-field">
          何时使用（可选）
          <input
            className="modal-input"
            value={values.whenToUse}
            placeholder="什么场景下模型应该调用它"
            onChange={(event) => patch({ whenToUse: event.target.value })}
          />
        </label>
        <label className="modal-field">
          正文（Markdown）
          <textarea
            className="modal-textarea"
            rows={10}
            value={values.content}
            placeholder="描述步骤、约束、示例……"
            onChange={(event) => patch({ content: event.target.value })}
          />
          {errors.content ? <span className="hint">{errors.content}</span> : null}
        </label>
        <details>
          <summary className="hint">高级选项</summary>
          <label className="modal-field">
            <input
              type="checkbox"
              checked={values.disableModelInvocation}
              onChange={(event) => patch({ disableModelInvocation: event.target.checked })}
            />{" "}
            禁止模型自动调用（仅手动）
          </label>
        </details>
        </div>
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onClose} disabled={busyState}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={() => void submit()} disabled={busyState}>
            {editing ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportPickModal({ onPick, onClose }: { onPick: (directory: boolean) => void; onClose: () => void }) {
  return (
    <div className="settings-overlay" role="dialog" aria-label="导入技能">
      <div className="confirm-modal">
        <h3>导入技能</h3>
        <p className="sub">技能文件（.md）或含 SKILL.md 的技能目录。导入即信任其内容；导入后默认未启用。</p>
        <div className="page-tools">
          <button type="button" className="filter-tab" onClick={() => onPick(false)}>
            选择 .md 文件
          </button>
          <button type="button" className="filter-tab" onClick={() => onPick(true)}>
            选择目录
          </button>
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportConfirmModal({
  preview,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  preview: Extract<SkillImportPreview, { ok: true }>["preview"];
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="settings-overlay" role="dialog" aria-label="确认导入技能">
      <div className="confirm-modal automation-form">
        <h3>导入技能 {preview.targetName}？</h3>
        <p className="sub">{preview.description}</p>
        {error ? <p className="banner error">{error}</p> : null}
        {preview.nameMismatch ? (
          <p className="hint">源名称「{preview.sourceName}」与 frontmatter 名称不一致，将以「{preview.targetName}」为名落盘。</p>
        ) : null}
        <pre className="diff" style={{ maxHeight: 280, overflow: "auto" }}>{preview.content}</pre>
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={onConfirm} disabled={busy}>
            确认导入
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillDeleteModal({
  skill,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  skill: LocalSkillInfo;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="settings-overlay" role="dialog" aria-label="删除技能确认">
      <div className="confirm-modal">
        <h3>删除技能 {skill.name}？</h3>
        <p className="sub">仅删除本机技能文件，不影响已发布到技能中心的内容与历史会话。</p>
        {error ? <p className="banner error">{error}</p> : null}
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={onConfirm} disabled={busy}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillDuplicateModal({
  skill,
  busy,
  error,
  takenNames,
  onCancel,
  onConfirm,
}: {
  skill: LocalSkillInfo;
  busy: boolean;
  error: string;
  takenNames: readonly string[];
  onCancel: () => void;
  onConfirm: (target: string) => void;
}) {
  const [target, setTarget] = useState("");
  const [nameError, setNameError] = useState("");
  const submit = () => {
    const problem = validateDuplicateName(target, { sourceName: skill.name, takenNames });
    if (problem) {
      setNameError(problem);
      return;
    }
    onConfirm(target);
  };
  return (
    <div className="settings-overlay" role="dialog" aria-label="另存为新技能">
      <div className="confirm-modal automation-form">
        <h3>另存为新技能</h3>
        <p className="sub">复制 {skill.name} 的正文与资源为新名称；新副本默认未启用。</p>
        {error ? <p className="banner error">{error}</p> : null}
        <label className="modal-field">
          新名称（kebab-case）
          <input
            className="modal-input"
            value={target}
            autoFocus
            placeholder="如：my-daily-report"
            onChange={(event) => {
              setTarget(event.target.value);
              setNameError("");
            }}
          />
          {nameError ? <span className="hint">{nameError}</span> : null}
        </label>
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={submit} disabled={busy}>
            复制
          </button>
        </div>
      </div>
    </div>
  );
}
