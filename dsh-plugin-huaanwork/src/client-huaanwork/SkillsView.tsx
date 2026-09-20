import { useCallback, useEffect, useState } from "react";

import { pickDirectory, rpcCall } from "./api.ts";
import {
  canToggleSkill,
  filterSkills,
  sourceLabel,
  tabLabel,
  validateSkillForm,
  type SkillDetail,
  type SkillFormValues,
  type SkillImportPreview,
  type SkillInfo,
  type SkillTab,
  type SkillWriteResult,
} from "./logic/skillsLogic.ts";

const TABS: SkillTab[] = ["all", "bundled", "user", "external"];

type Modal =
  | { kind: "view"; skill: SkillDetail }
  | { kind: "create" }
  | { kind: "edit"; skill: SkillDetail }
  | { kind: "delete"; skill: SkillInfo }
  | { kind: "import-pick" }
  | { kind: "import-confirm"; path: string; preview: Extract<SkillImportPreview, { ok: true }>["preview"] };

export default function SkillsView() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<SkillTab>("all");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busySkill, setBusySkill] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);

  const refresh = useCallback(async () => {
    try {
      const listed = await rpcCall<{ skills: SkillInfo[] }>("skill.list");
      setSkills(Array.isArray(listed.skills) ? listed.skills : []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openView = async (skill: SkillInfo) => {
    try {
      const detail = await rpcCall<{ skill: SkillDetail }>("skill.get", { name: skill.name, source: skill.source });
      setModal({ kind: "view", skill: detail.skill });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openEdit = async (skill: SkillInfo) => {
    try {
      const detail = await rpcCall<{ skill: SkillDetail }>("skill.get", { name: skill.name, source: skill.source });
      setModal({ kind: "edit", skill: detail.skill });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeSkill = async (skill: SkillInfo) => {
    try {
      await rpcCall("skill.remove", { name: skill.name });
      setModal(null);
      setNote(`已删除技能 ${skill.name}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pickImport = async (_directory: boolean) => {
    const selected = await pickDirectory();
    if (typeof selected !== "string") return; // 用户取消
    try {
      const preview = await rpcCall<SkillImportPreview>("skill.importPreview", { path: selected });
      if (!preview.ok) {
        setError(preview.fieldErrors.map((error) => error.message).join("；"));
        setModal(null);
        return;
      }
      setModal({ kind: "import-confirm", path: selected, preview: preview.preview });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setModal(null);
    }
  };

  const confirmImport = async (path: string, name: string) => {
    try {
      const result = await rpcCall<SkillWriteResult>("skill.import", { path });
      if (!result.ok) {
        setError(result.fieldErrors.map((error) => error.message).join("；"));
        setModal(null);
        return;
      }
      setModal(null);
      setNote(`已导入技能 ${name}，新会话即可使用`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setModal(null);
    }
  };

  const toggleSkill = async (skill: SkillInfo) => {
    if (busySkill) return;
    const enabling = skill.enabled !== true;
    setBusySkill(skill.name);
    setError("");
    try {
      await rpcCall("skill.setEnabled", { name: skill.name, enabled: enabling });
      setNote(enabling ? `已启用技能 ${skill.name}，新会话生效` : `已禁用技能 ${skill.name}，新会话生效`);
      await refresh();
    } catch (cause) {
      setNote("");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySkill(null);
    }
  };

  const visible = filterSkills(skills, tab, search);

  return (
    <div className="page-view">
      <div className="page-head">
        <h1>技能中心</h1>
        <span className="hint-text">把经验、方法和工具封装成技能，相似任务轻松复用</span>
      </div>
      <div className="page-tools">
        <input
          className="search-input"
          value={search}
          placeholder="🔍 搜索技能"
          aria-label="搜索技能"
          onChange={(event) => setSearch(event.target.value)}
        />
        {TABS.map((item) => (
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
        <button type="button" className="filter-tab" onClick={() => setModal({ kind: "import-pick" })}>
          ↑ 上传技能
        </button>
        <button type="button" className="btn-dark" onClick={() => setModal({ kind: "create" })}>
          ＋ 创建技能
        </button>
      </div>
      {note ? (
        <p className="hint" style={{ marginBottom: 12 }}>
          {note}
        </p>
      ) : null}
      {error ? <p className="banner error">{error}</p> : null}
      {!error && visible.length === 0 ? (
        tab === "user" && !search.trim() ? (
          <p className="panel-empty">
            还没有创建过技能。{" "}
            <button type="button" className="filter-tab" onClick={() => setModal({ kind: "create" })}>
              创建第一个技能
            </button>
          </p>
        ) : (
          <p className="panel-empty">{search.trim() || tab !== "all" ? "没有匹配的技能" : "暂无技能"}</p>
        )
      ) : (
        <div className="skill-grid">
          {visible.map((skill) => (
            <div key={`${skill.source}:${skill.name}`} className="skill-card">
              <div className="top">
                <span className="av">{skill.name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <div className="nm">{skill.name}</div>
                  <div className="src">{sourceLabel(skill.source)}</div>
                </div>
              </div>
              <p>{skill.description}</p>
              <div className="page-tools" style={{ marginTop: 8 }}>
                <button type="button" className="filter-tab" onClick={() => void openView(skill)}>
                  查看
                </button>
                {skill.source === "bundled" ? (
                  canToggleSkill(skill) ? (
                    <button
                      type="button"
                      className={skill.enabled === true ? "filter-tab on" : "filter-tab"}
                      aria-pressed={skill.enabled === true}
                      aria-label={`${skill.enabled === true ? "禁用" : "启用"}技能 ${skill.name}`}
                      disabled={busySkill === skill.name}
                      onClick={() => void toggleSkill(skill)}
                    >
                      {skill.enabled === true ? "已启用" : "启用"}
                    </button>
                  ) : (
                    <span className="src" style={{ padding: "4px 0" }}>
                      始终启用
                    </span>
                  )
                ) : null}
                {skill.source === "user" ? (
                  <>
                    <button type="button" className="filter-tab" onClick={() => void openEdit(skill)}>
                      编辑
                    </button>
                    <button type="button" className="filter-tab" onClick={() => setModal({ kind: "delete", skill })}>
                      删除
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {modal?.kind === "view" ? <SkillViewModal skill={modal.skill} onClose={() => setModal(null)} /> : null}
      {modal?.kind === "create" || modal?.kind === "edit" ? (
        <SkillFormModal
          source={modal.kind === "edit" ? modal.skill : null}
          takenNames={skills.filter((skill) => skill.source !== "external").map((skill) => skill.name)}
          onClose={() => setModal(null)}
          onSaved={async (name) => {
            setModal(null);
            setNote(`已保存技能 ${name}，新会话即可使用`);
            await refresh();
          }}
        />
      ) : null}
      {modal?.kind === "delete" ? (
        <SkillDeleteModal skill={modal.skill} onCancel={() => setModal(null)} onConfirm={() => void removeSkill(modal.skill)} />
      ) : null}
      {modal?.kind === "import-pick" ? (
        <ImportPickModal onPick={(directory) => void pickImport(directory)} onClose={() => setModal(null)} />
      ) : null}
      {modal?.kind === "import-confirm" ? (
        <ImportConfirmModal
          preview={modal.preview}
          onCancel={() => setModal(null)}
          onConfirm={() => void confirmImport(modal.path, modal.preview.targetName)}
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
  onSaved: (name: string) => Promise<void>;
}) {
  const editing = source !== null;
  const [values, setValues] = useState<SkillFormValues>({
    name: source?.name ?? "",
    description: source?.description ?? "",
    whenToUse: source?.whenToUse ?? "",
    content: source?.content ?? "",
    // 从 skill.get 回填（评审 P1 修复点）：不得硬编码默认值，否则编辑会静默删掉已落盘的 invocation 键
    disableModelInvocation: source?.disableModelInvocation ?? false,
    userInvocable: source?.userInvocable ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const patch = (part: Partial<SkillFormValues>) => setValues((prev) => ({ ...prev, ...part }));

  const submit = async () => {
    const local = validateSkillForm(values, { editing, takenNames });
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }
    setBusy(true);
    try {
      const params = {
        description: values.description.trim(),
        whenToUse: values.whenToUse.trim() || undefined,
        content: values.content,
        disableModelInvocation: values.disableModelInvocation,
        userInvocable: values.userInvocable,
      };
      const result = await rpcCall<SkillWriteResult>(
        editing ? "skill.update" : "skill.create",
        editing ? { name: source.name, ...params } : { name: values.name, ...params },
      );
      if (!result.ok) {
        setErrors(Object.fromEntries(result.fieldErrors.map((error) => [error.field, error.message])));
        return;
      }
      await onSaved(editing ? source.name : values.name);
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label={editing ? "编辑技能" : "创建技能"}>
      <div className="confirm-modal automation-form">
        <h3>{editing ? "编辑技能" : "创建技能"}</h3>
        <p className="sub">技能 = 一段写给模型的方法说明（Markdown），保存后新会话即可使用</p>
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
          <label className="modal-field">
            <input
              type="checkbox"
              checked={!values.userInvocable}
              onChange={(event) => patch({ userInvocable: !event.target.checked })}
            />{" "}
            禁止用户手动调用
          </label>
        </details>
        </div>
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={() => void submit()} disabled={busy}>
            {editing ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportPickModal({ onPick, onClose }: { onPick: (directory: boolean) => void; onClose: () => void }) {
  return (
    <div className="settings-overlay" role="dialog" aria-label="上传技能">
      <div className="confirm-modal">
        <h3>上传技能</h3>
        <p className="sub">技能文件（.md）或含 SKILL.md 的技能目录。导入即信任其内容。</p>
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
  onCancel,
  onConfirm,
}: {
  preview: Extract<SkillImportPreview, { ok: true }>["preview"];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="settings-overlay" role="dialog" aria-label="确认导入技能">
      <div className="confirm-modal automation-form">
        <h3>导入技能 {preview.targetName}？</h3>
        <p className="sub">{preview.description}</p>
        {preview.nameMismatch ? (
          <p className="hint">源名称「{preview.sourceName}」与 frontmatter 名称不一致，将以「{preview.targetName}」为名落盘。</p>
        ) : null}
        <pre className="diff" style={{ maxHeight: 280, overflow: "auto" }}>{preview.content}</pre>
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={onConfirm}>
            确认导入
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillDeleteModal({ skill, onCancel, onConfirm }: { skill: SkillInfo; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="settings-overlay" role="dialog" aria-label="删除技能确认">
      <div className="confirm-modal">
        <h3>删除技能 {skill.name}？</h3>
        <p className="sub">仅删除技能文件，不影响历史会话。</p>
        <div className="page-tools">
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-dark" onClick={onConfirm}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
