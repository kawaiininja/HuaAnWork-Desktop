import { useState } from "react";

import {
  createProject,
  openProject,
  removeProject,
  renameProject,
  projectRootName,
  type ProjectInfo,
  type TaskInfo,
} from "./projects.ts";

type Props = {
  projects: ProjectInfo[];
  activeProjectId: string | null;
  /** 全部子任务（由 App 拉取）：面板内按项目归属分流到各自卡片，不要求项目处于激活态。 */
  subtasks: TaskInfo[];
  /** 侧边栏当前选中的子任务 id（高亮驱动）。 */
  selectedTaskId: string | null;
  /** 后台任务运行中禁止切工作区。 */
  disabled?: boolean;
  /** 项目被打开后通知 App 刷新工作区与列表。 */
  onOpened: (project: ProjectInfo, workspaceRoot: string) => void;
  /** 增删改后通知 App 重新拉取项目列表。 */
  onChanged: () => void;
  /** 在指定项目下新建子任务（非自动化任务），成功后由 App 刷新任务列表。 */
  onCreateSubtask: (project: ProjectInfo) => Promise<unknown>;
  /** 点击子任务条目：通知 App 切换对话与选中状态。 */
  onSelectSubtask: (task: TaskInfo) => void;
  /** 重命名子任务（模态确认后调用，与项目重命名同款——评审 P3-8 裁决统一为模态）。 */
  onRenameSubtask: (taskId: string, name: string) => Promise<unknown>;
  /** 删除子任务（级联删其对话历史，确认弹窗后调用）。 */
  onRemoveSubtask: (task: TaskInfo) => Promise<unknown>;
};

type Menu = { projectId: string; x: number; y: number };
type Renaming = { projectId: string; name: string };
type ConfirmRemove = { project: ProjectInfo };

/** 侧边栏「项目」区：项目列表 + 右键管理；每张卡片标题行右侧提供新建子任务入口。 */
export default function ProjectsPanel({
  projects,
  activeProjectId,
  subtasks,
  selectedTaskId,
  disabled,
  onOpened,
  onChanged,
  onCreateSubtask,
  onSelectSubtask,
  onRenameSubtask,
  onRemoveSubtask,
}: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRemove | null>(null);
  const [subtaskMenu, setSubtaskMenu] = useState<{ task: TaskInfo; x: number; y: number } | null>(null);
  const [renamingTask, setRenamingTask] = useState<{ task: TaskInfo; name: string } | null>(null);
  const [confirmingTask, setConfirmingTask] = useState<TaskInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function open(projectId: string) {
    if (disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      const opened = await openProject(projectId);
      onOpened(opened.project, opened.workspaceRoot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    if (!renaming || !renaming.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await renameProject(renaming.projectId, renaming.name.trim());
      setRenaming(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRemove() {
    if (!confirming) return;
    setBusy(true);
    setError("");
    try {
      await removeProject(confirming.project.id);
      setConfirming(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** 标题行「+」：在该项目下新建子任务（任意项目卡片均可触发）。 */
  async function createSubtask(project: ProjectInfo) {
    if (disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreateSubtask(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRenameSubtask() {
    if (!renamingTask || !renamingTask.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onRenameSubtask(renamingTask.task.id, renamingTask.name.trim());
      setRenamingTask(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRemoveSubtask() {
    if (!confirmingTask) return;
    setBusy(true);
    setError("");
    try {
      await onRemoveSubtask(confirmingTask);
      setConfirmingTask(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {projects.length === 0 ? (
        <p className="side-muted">还没有项目。点「＋ 新建」把一个目录登记为项目。</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => {
            const isActive = project.id === activeProjectId;
            // 每张卡片展示归属自己的子任务：新建后立即可见，无需先打开/激活项目。
            const ownSubtasks = subtasks.filter((task) => task.projectId === project.id);
            return (
              <li key={project.id}>
                <div className={isActive ? "project-card selected" : "project-card"}>
                  <div className="project-row">
                    <button
                      type="button"
                      className={isActive ? "recent-item project-item active" : "recent-item project-item"}
                      title={`${project.name}\n${project.root}`}
                      disabled={disabled || (busy && menu?.projectId === project.id)}
                      onClick={() => void open(project.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({ projectId: project.id, x: event.clientX, y: event.clientY });
                      }}
                    >
                      <span className="recent-title">{project.name}</span>
                      <span className="recent-meta">
                        {projectRootName(project.root)}
                        {project.lastOpenedAt ? ` · ${formatOpenedAt(project.lastOpenedAt)}` : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="project-add-subtask"
                      title="新建子任务"
                      aria-label={`在「${project.name}」下新建子任务`}
                      disabled={disabled || busy}
                      onClick={() => void createSubtask(project)}
                    >
                      <IconAdd />
                    </button>
                  </div>
                  {ownSubtasks.length > 0 ? (
                    <ul className="subtask-list">
                      {ownSubtasks.map((task) => {
                        const isTaskActive = selectedTaskId === task.id;
                        return (
                          <li key={task.id}>
                            <button
                              type="button"
                              className={isTaskActive ? "subtask-item active" : "subtask-item"}
                              title={task.name}
                              disabled={disabled}
                              onClick={() => onSelectSubtask(task)}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                setSubtaskMenu({ task, x: event.clientX, y: event.clientY });
                              }}
                            >
                              {task.name}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="side-muted">发送第一条消息即可创建子任务</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error ? <p className="side-error">{error}</p> : null}

      {menu ? (
        <div
          className="context-overlay"
          onClick={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="context-menu"
            role="menu"
            aria-label="项目操作"
            style={{ left: Math.min(menu.x, window.innerWidth - 160), top: Math.min(menu.y, window.innerHeight - 130) }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              disabled={disabled}
              onClick={() => {
                const id = menu.projectId;
                setMenu(null);
                void open(id);
              }}
            >
              打开
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              onClick={() => {
                const project = projects.find((item) => item.id === menu.projectId);
                setMenu(null);
                if (project) setRenaming({ projectId: project.id, name: project.name });
              }}
            >
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-item danger"
              onClick={() => {
                const project = projects.find((item) => item.id === menu.projectId);
                setMenu(null);
                if (project) setConfirming({ project });
              }}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}

      {renaming ? (
        <div className="settings-overlay" role="dialog" aria-label="重命名项目">
          <div className="confirm-modal">
            <h3>重命名项目</h3>
            <input
              className="modal-input"
              value={renaming.name}
              autoFocus
              onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void submitRename();
              }}
            />
            {error ? <p className="banner error" style={{ borderRadius: 8 }}>{error}</p> : null}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setRenaming(null)}>
                取消
              </button>
              <button type="button" className="btn primary" disabled={busy || !renaming.name.trim()} onClick={() => void submitRename()}>
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div className="settings-overlay" role="dialog" aria-label="删除项目确认">
          <div className="confirm-modal">
            <h3>删除项目</h3>
            <p className="hint" style={{ margin: 0, fontWeight: 600, wordBreak: "break-all" }}>
              {confirming.project.name}
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              仅移除项目记录与该项目下的任务，不会删除磁盘上的任何文件。此操作无法撤销。
            </p>
            {error ? <p className="banner error" style={{ borderRadius: 8 }}>{error}</p> : null}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(null)}>
                取消
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void submitRemove()}>
                {busy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {subtaskMenu ? (
        <div
          className="context-overlay"
          onClick={() => setSubtaskMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setSubtaskMenu(null);
          }}
        >
          <div
            className="context-menu"
            role="menu"
            aria-label="子任务操作"
            style={{ left: Math.min(subtaskMenu.x, window.innerWidth - 160), top: Math.min(subtaskMenu.y, window.innerHeight - 130) }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              onClick={() => {
                const task = subtaskMenu.task;
                setSubtaskMenu(null);
                setRenamingTask({ task, name: task.name });
              }}
            >
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-item danger"
              onClick={() => {
                const task = subtaskMenu.task;
                setSubtaskMenu(null);
                setConfirmingTask(task);
              }}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}

      {renamingTask ? (
        <div className="settings-overlay" role="dialog" aria-label="重命名子任务">
          <div className="confirm-modal">
            <h3>重命名子任务</h3>
            <input
              className="modal-input"
              value={renamingTask.name}
              autoFocus
              onChange={(event) => setRenamingTask({ ...renamingTask, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void submitRenameSubtask();
              }}
            />
            {error ? <p className="banner error" style={{ borderRadius: 8 }}>{error}</p> : null}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setRenamingTask(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !renamingTask.name.trim()}
                onClick={() => void submitRenameSubtask()}
              >
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmingTask ? (
        <div className="settings-overlay" role="dialog" aria-label="删除子任务确认">
          <div className="confirm-modal">
            <h3>删除子任务</h3>
            <p className="hint" style={{ margin: 0, fontWeight: 600, wordBreak: "break-all" }}>
              {confirmingTask.name}
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              将一并删除该子任务的对话历史，此操作无法撤销。
            </p>
            {error ? <p className="banner error" style={{ borderRadius: 8 }}>{error}</p> : null}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirmingTask(null)}>
                取消
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void submitRemoveSubtask()}>
                {busy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 线性「+」图标：项目卡片标题行的新建子任务入口（14px / stroke 1.4，遵循设计系统图标规范）。 */
function IconAdd() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden>
      <path d="M8 3.6v8.8M3.6 8h8.8" />
    </svg>
  );
}

function formatOpenedAt(ts: number): string {
  const date = new Date(ts);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** App 级「选文件夹 + 命名」新建项目模态（ProjectsPanel 与项目选择弹层共用）。 */
export function ProjectCreateModal({
  root,
  defaultName,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  root: string;
  defaultName: string;
  busy: boolean;
  error: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  return (
    <div className="settings-overlay" role="dialog" aria-label="新建项目">
      <div className="confirm-modal">
        <h3>新建项目</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12.5, wordBreak: "break-all" }}>
          {root}
        </p>
        <label className="modal-field">
          项目名称
          <input
            className="modal-input"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && name.trim()) onConfirm(name.trim());
            }}
          />
        </label>
        {error ? <p className="banner error" style={{ borderRadius: 8 }}>{error}</p> : null}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => onConfirm(name.trim())}>
            {busy ? "创建中…" : "创建并打开"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 供 App 使用的「创建并打开」动作（命名模态确认后调用）。 */
export async function createAndOpen(root: string, name: string): Promise<{ project: ProjectInfo; workspaceRoot: string }> {
  const created = await createProject({ root, name });
  const opened = await openProject(created.project.id);
  return { project: opened.project, workspaceRoot: opened.workspaceRoot };
}
