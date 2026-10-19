import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import AccountFooter from "./AccountFooter.tsx";
import AgentsView from "./AgentsView.tsx";
import AuthGate, { type AuthStatus } from "./AuthGate.tsx";
import AutomationsView from "./AutomationsView.tsx";
import HistoryDetailPane, {
  formatSessionTime,
  type SessionDetailRecord,
  type SessionLogView,
} from "./HistoryDetailPane.tsx";
import KnowledgeBaseView from "./KnowledgeBaseView.tsx";
import MarketView from "./MarketView.tsx";
import ProjectsPanel, { ProjectCreateModal, createAndOpen } from "./ProjectsPanel.tsx";
import Settings, {
  PLUGIN_APPLY_FAIL,
  ModelChip,
  applySettingsModels,
  type ModelEntry,
  type ModelSettingsPayload,
  type SettingsSection,
} from "./Settings.tsx";
import {
  GUARD_MODE_LABELS,
  commitGuardMode,
  nextGuardMode,
  parseGuardMode,
  shouldConfirmFull,
  type GuardMode,
} from "./logic/guardMode.ts";
import AtAgentMenu from "./AtAgentMenu.tsx";
import SlashSkillMenu from "./SlashSkillMenu.tsx";
import SkillsView from "./SkillsView.tsx";
import {
  isReservedSlash,
  parseSlashInvoke,
  slashSkills,
  slashTokenAt,
  type SkillInfo,
} from "./logic/skillsLogic.ts";
import {
  atAgents,
  atTokenAt,
  parseAtInvoke,
  type AgentListItem,
  type AgentListResult,
} from "./logic/agentsLogic.ts";
import {
  applyHtmlTheme,
  parseTheme,
  persistThemeMirror,
  resolveTheme,
  type ThemePref,
} from "./logic/accountStatus.ts";
import { AUTO_CONTINUE_LABEL, PLAN_CARD_NOTE, PLAN_EXITED_NOTE, planExitNote } from "./logic/planConfirm.ts";
import logoUrl from "./assets/huaan-mark.png";
import {
  bindTaskSession,
  createTask,
  listAutomations,
  listProjects,
  listTasks,
  openProject as openProjectRpc,
  projectRootName,
  renameTask,
  removeTask,
  type AutomationInfo,
  type AutomationSchedule,
  type ProjectInfo,
  type RunSummary,
  type TaskInfo,
} from "./projects.ts";
import {
  hasGit,
  listTree,
  notifyRunFailed,
  onSidecarEvent,
  onSidecarExit,
  pickDirectory,
  rpcCall,
  setKeepAwake as invokeSetKeepAwake,
  type RpcEvent,
  type TreeNode,
} from "./api.ts";
import { createKeepAwakeDriver, shouldHoldKeepAwake } from "./logic/keepAwake.ts";
import { missedBannerView, nextMissedCount } from "./logic/missedBanner.ts";
import { parseSchedulePhrase } from "./logic/schedulePhrase.ts";
import {
  chatTabHasConversation,
  cwdWithinRoot,
  historyItemsFromRecords,
  isAutomationSessionId,
  unscopedSessions,
} from "./logic/sessionChannel.ts";
import { needsSubtaskOnSend, subtaskNameFromMessage, subtaskRenamesFromTitles } from "./logic/subtaskLogic.ts";
import { hasAssistantTextAfter, resolveThinking, shouldRenderThinking } from "./logic/thinkingPanel.ts";
import { turnStatus } from "./logic/turnStatus.ts";
import { todoLabel, turnChecks, turnOutcomeNotes, type TodoEntry } from "./logic/outcomeCheck.ts";
import { runResultNoteText, runTabsToRebuild } from "./logic/runTabsLogic.ts";
import { ThinkingPanel } from "./ThinkingPanel.tsx";

/**
 * 用户对话会话 id（事件路由用）：huaanwork-chat- 旧会话与 huaanwork-<16hex digest> 新会话。
 * 注意：huaanwork-chat(-|$) 分支必须保留——它是统一前旧 chat 用户会话被识别为
 * 用户会话的唯一依据（评审 A2）；旧 huaanwork-chat-auto- 运行会话日志由 sidecar
 * 启动清扫删除，残留（清扫失败）也被下方 isAutomationSessionId 先行排除。
 * 子代理会话不匹配正则，运行期间由事件闸门抑制。
 */
function isUserSessionId(sessionId: string | undefined): boolean {
  if (typeof sessionId !== "string") return false;
  // chat 运行会话前缀 huaanwork-chat-auto- 会命中下方 huaanwork-chat(-|$) 分支，
  // 必须先按 isAutomationSessionId 排除，否则会把自动化运行会话误判为用户会话。
  if (isAutomationSessionId(sessionId)) return false;
  return /^(huaanwork-chat(-|$)|huaanwork-[0-9a-f]{16})/.test(sessionId);
}

type ToolCard = {
  key: string;
  name: string;
  callId?: string;
  status: "start" | "end";
  truncated?: boolean;
  /** bash / pwsh 的 command 参数与结果是否出错：回合结束核对「要求的命令」用。 */
  command?: string;
  isError?: boolean;
};

type AskCard = {
  approvalRequestId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  summary?: string;
  autoContinue?: boolean;
  answered?: "approve" | "reject";
};

type ChatItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; interrupted?: boolean }
  | { id: number; kind: "thinking"; thought: string; interrupted: boolean }
  | { id: number; kind: "tool"; card: ToolCard }
  | { id: number; kind: "todo"; todos: TodoEntry[] }
  | { id: number; kind: "ask"; card: AskCard }
  | { id: number; kind: "note"; text: string };

type SessionRow = {
  id?: string;
  title?: string;
  createdAt?: number;
  lastTime?: number;
  cwd?: string;
  origin?: string;
  parentSession?: string;
  messageCount?: number;
  turnCount?: number;
  [key: string]: unknown;
};

type ChatTab = {
  id: string;
  label: string;
  items: ChatItem[];
  sessionFailed: boolean;
  /** 该对话绑定的项目；新建对话未选择项目时为 null。 */
  projectId: string | null;
  /** 新建对话等待选择项目：composer chip 显示「选择项目」。 */
  pendingPick: boolean;
  /** 绑定的 sidecar 会话 id；未绑定（尚未发送过消息）时由发送流程懒绑定。 */
  sessionId?: string;
  /** 绑定的子任务 id（Work 模式下侧边栏选中驱动）。 */
  taskId?: string;
  /** 自动化运行对话：由 automation/run-start 创建，渲染在对应通道分区（不进最近对话）。 */
  automationId?: string;
  /** 重启后重建的运行对话骨架：首启懒加载运行日志前为 true，加载（或失败降级）后清除。 */
  runPlaceholder?: boolean;
};

type SessionMenu = { sessionId: string; x: number; y: number };

type View = "main" | "skills" | "automations" | "agents" | "knowledge" | "market";
export type RightTab = "preview" | "progress" | "files" | "diff";
type AuthPhase = "unknown" | "needs-register" | "logged-out" | "logged-in";

const SUGGESTIONS = ["修掉这个仓库里失败的测试", "解释这个仓库的整体结构", "把最近的改动整理成一次 commit"];

const ICON_PROPS = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  "aria-hidden": true,
} as const;

function IconNew() {
  return (
    <svg {...ICON_PROPS}>
      <title>新建</title>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 5.4v5.2M5.4 8h5.2" />
    </svg>
  );
}

function IconSkills() {
  return (
    <svg {...ICON_PROPS} strokeLinejoin="round">
      <title>技能中心</title>
      <path d="M8 2.2l1.5 4.1 4.1 1.5-4.1 1.5L8 13.4l-1.5-4.1-4.1-1.5 4.1-1.5z" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg {...ICON_PROPS}>
      <title>自动化</title>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.8V8l2.4 1.4" />
    </svg>
  );
}

function IconAgent() {
  return (
    <svg {...ICON_PROPS} strokeLinejoin="round">
      <title>智能体</title>
      <rect x="3.2" y="5.6" width="9.6" height="7" rx="1.8" />
      <path d="M8 2.8v2.8M6.4 8.6v.8M9.6 8.6v.8" />
    </svg>
  );
}

function IconMarket() {
  return (
    <svg {...ICON_PROPS} strokeLinejoin="round">
      <title>插件市场</title>
      <path d="M2.6 6.4L4 3.2h8l1.4 3.2" />
      <path d="M2.8 6.4h10.4v5.4a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V6.4z" />
      <path d="M6.2 9.4v2M5.2 10.4h2" />
    </svg>
  );
}

function IconKnowledge() {
  return (
    <svg {...ICON_PROPS} strokeLinejoin="round">
      <title>知识库</title>
      <path d="M8 4.4C7 3.6 5.6 3.2 3.2 3.2v9.2c2.4 0 3.8.4 4.8 1.2 1-.8 2.4-1.2 4.8-1.2V3.2c-2.4 0-3.8.4-4.8 1.2z" />
      <path d="M8 4.4v9.2" />
    </svg>
  );
}

function IconSidebar() {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden>
      <title>收起导航</title>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

type HostLivenessPhase = "ok" | "suspect" | "stoppable";

type HostLivenessBridge = {
  read(): Promise<{ phase: HostLivenessPhase; turns: number }>;
  onChange(listener: (state: { phase: HostLivenessPhase; turns: number }) => void): () => void;
  reportTurns(turns: number): void;
  requestStop(): Promise<boolean>;
};

function hostLivenessBridge(): HostLivenessBridge | undefined {
  return (window as unknown as { huaanworkHostLiveness?: HostLivenessBridge }).huaanworkHostLiveness;
}

function IconRightPane() {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden>
      <title>收起面板</title>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M10 2.5v11" />
    </svg>
  );
}

export default function App() {
  const [view, setView] = useState<View>("main");
  const [collapsed, setCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [gitWarning, setGitWarning] = useState("");
  const [chatTabs, setChatTabs] = useState<ChatTab[]>(() => [
    { id: "work-1", label: "对话", items: [], sessionFailed: false, projectId: null, pendingPick: false },
  ]);
  const [draft, setDraft] = useState("");
  const [slashCatalog, setSlashCatalog] = useState<SkillInfo[]>([]);
  const [slashCursor, setSlashCursor] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [atCatalog, setAtCatalog] = useState<AgentListItem[]>([]);
  const [atCursor, setAtCursor] = useState(0);
  const [atIndex, setAtIndex] = useState(0);
  const [atClosed, setAtClosed] = useState(false);
  const [diff, setDiff] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("model");
  const [theme, setTheme] = useState<ThemePref>("system");
  const [username, setUsername] = useState("");
  const [authPhase, setAuthPhase] = useState<AuthPhase>("unknown");
  const [ready, setReady] = useState(false);
  const [sidecarDead, setSidecarDead] = useState(false);
  const [pluginFail, setPluginFail] = useState("");
  /** 历史会话（磁盘持久化的全部日志）：项目卡片归属分组与「任务」区未归属列表共用。 */
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  /** 设置「权限」页的 Work 公网开关镜像（composer「仅局域网」chip 用）；缺省仅局域网。 */
  const [workAllowNetwork, setWorkAllowNetwork] = useState(false);
  const [guardMode, setGuardMode] = useState<GuardMode>("ask");
  const [guardModeConfirm, setGuardModeConfirm] = useState<GuardMode | null>(null);
  const [guardModeError, setGuardModeError] = useState("");
  /** persistGuardMode 重入保护：写入进行中时忽略再次点击，避免并发 set 把 chip 回滚到旧档。 */
  const guardPersistBusy = useRef(false);
  /** Task 10：保持系统唤醒设置镜像（缺省开，与 sidecar defaultSettings 一致）。 */
  const [keepAwake, setKeepAwake] = useState(true);
  /** 上一次持有系统防睡眠断言的尝试是否失败（或该 OS 不支持）；驱动设置页静态提示。 */
  const [keepAwakeUnavailable, setKeepAwakeUnavailable] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [turnActive, setTurnActive] = useState(false);
  const [hostPhase, setHostPhase] = useState<HostLivenessPhase>("ok");
  /** 当前未结束回合的最近一次 reasoning 增量、正文增量或工具结果。句子只由 turnStatus 算出。 */
  const [turnPulse, setTurnPulse] = useState<{
    tabId: string;
    latest: "reasoning" | "text" | "tool" | "quiet";
    at: number;
  }>({ tabId: "", latest: "quiet", at: 0 });
  const [now, setNow] = useState(() => Date.now());
  const turnTabRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("work-1");
  const [historyView, setHistoryView] = useState<SessionLogView | null>(null);
  const [sessionMenu, setSessionMenu] = useState<SessionMenu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [modelLabel, setModelLabel] = useState("");
  const [savedModels, setSavedModels] = useState<ModelEntry[]>([]);
  const [activeModelId, setActiveModelId] = useState("");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  /** Work 侧边栏当前选中的子任务 id（驱动高亮与主区域对话切换）。 */
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  /** 子任务载入进行态：重入保护 + 侧栏条目占位（评审 P3-5）。 */
  const [selectBusy, setSelectBusy] = useState(false);
  /** 「恢复失败」标签去重表 taskId → tabId（二轮复审 N-F）：失败标签不写 taskId，
   *  existing 判据匹配不到，没有这张表连点同一损坏子任务会堆积空标签。 */
  const failedSubtaskTabs = useRef(new Map<string, string>());
  const [automations, setAutomations] = useState<AutomationInfo[]>([]);
  const [automationRuns, setAutomationRuns] = useState<Record<string, RunSummary[]>>({});
  /** 全部项目下的子任务快照（侧栏任务区与选中项目卡片共用）。 */
  const [projectTasks, setProjectTasks] = useState<TaskInfo[]>([]);
  const [runningAutomationIds, setRunningAutomationIds] = useState<ReadonlySet<string>>(new Set());
  /** Task 11：missed 启动横幅状态——count 只在未 dismiss 时随 automation/missed 事件累积。 */
  const [missedBanner, setMissedBanner] = useState<{ count: number; dismissed: boolean }>({ count: 0, dismissed: false });
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  /** 由侧栏触发的自动化页一次性入口意图：focus=选中项目并停在「任务」tab。 */
  const [automationEnter, setAutomationEnter] = useState<{
    mode: "create" | "focus";
    /** issue #2：可空——create 入口一律传 null(表单内项目下拉默认「不绑定」);focus 允许无归属任务。 */
    projectId: string | null;
    /** Task 13：composer 命中自然语言调度短语时的预填（一次性赋值，人工在表单里确认）。 */
    schedule?: AutomationSchedule;
    prompt?: string;
  } | null>(null);
  /** Work 右侧面板「项目」页签：当前工作区的文件树（懒加载，切工作区失效）。 */
  const [projectTree, setProjectTree] = useState<TreeNode[] | null>(null);
  const [treeError, setTreeError] = useState("");
  const treeRootRef = useRef<string | null>(null);
  const [creatingProject, setCreatingProject] = useState<{ root: string; defaultName: string } | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [creatingError, setCreatingError] = useState("");
  const sawReady = useRef(false);
  const automationActiveRef = useRef(false);
  /** Task 11：run-end 通知要拼任务名，事件监听 effect 依赖数组是 []，用 ref 避免闭包读到旧 automations。 */
  const automationsRef = useRef<AutomationInfo[]>([]);
  /** Task 10：keep-awake 断言驱动（M4 评审 D4）。成功才提交 confirmed、失败不提交，
   * 期望比较替代 cancelled 标志；懒初始化一次，refresh 由下方 effect 驱动。 */
  const keepAwakeDriverRef = useRef<ReturnType<typeof createKeepAwakeDriver> | null>(null);
  if (keepAwakeDriverRef.current === null) {
    keepAwakeDriverRef.current = createKeepAwakeDriver(invokeSetKeepAwake, setKeepAwakeUnavailable);
  }
  const keepAwakeDriver = keepAwakeDriverRef.current;
  const activeProjectIdRef = useRef<string | null>(null);
  const workspaceRef = useRef<string | null>(null);
  const nextId = useRef(1);
  const stopping = useRef(false);
  const sendingRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** 拥有当前 sidecar 流的对话标签（token/tool/approval 事件写入它）。 */
  const liveChatRef = useRef("work-1");
  const nextChatSeq = useRef(2);
  const newTaskRef = useRef<() => void>(() => undefined);
  const authPhaseRef = useRef(authPhase);
  const pullAuthStatusRef = useRef<() => void>(() => undefined);
  /** chatTabs 的稳定引用：事件回调（挂载期注册，deps 为 []）按 sessionId 查找目标标签用。 */
  const chatTabsRef = useRef<ChatTab[]>([]);

  useEffect(() => {
    authPhaseRef.current = authPhase;
  }, [authPhase]);

  const activeChat = chatTabs.find((tab) => tab.id === activeTab) ?? chatTabs[0];
  const items = activeChat.items;
  const sessionFailed = activeChat.sessionFailed;
  const showTurnLine = turnActive && turnPulse.tabId === activeChat.id;
  const turnLine = turnStatus({
    latest: turnPulse.latest,
    runningTool: runningToolName(items),
    quietMs: Math.max(0, now - turnPulse.at),
  });
  const slashToken = slashTokenAt(draft, slashCursor);
  const slashOpen = Boolean(slashToken && !isReservedSlash(slashToken.query) && !slashClosed);
  const slashMatches = slashOpen ? slashSkills(slashCatalog, slashToken?.query ?? "").slice(0, 8) : [];

  const slashTokenKey = `${slashToken?.start ?? ""}:${slashToken?.query ?? ""}`;
  useEffect(() => {
    setSlashClosed(false);
    setSlashIndex(0);
  }, [slashTokenKey]);

  const atToken = atTokenAt(draft, atCursor);
  const atOpen = Boolean(atToken && !atClosed);
  const atMatches = atOpen ? atAgents(atCatalog, atToken?.query ?? "").slice(0, 8) : [];

  const atTokenKey = `${atToken?.start ?? ""}:${atToken?.query ?? ""}`;
  useEffect(() => {
    setAtClosed(false);
    setAtIndex(0);
  }, [atTokenKey]);

  // 目录异步回写/启禁用变化导致 atMatches 收缩时，索引钳回有效范围
  useEffect(() => {
    if (atIndex > 0 && atIndex >= atMatches.length) {
      setAtIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atIndex]);

  useEffect(() => {
    if (view !== "main" || sidecarDead || !ready) return;
    let cancelled = false;
    void rpcCall<{ skills: SkillInfo[] }>("skill.list")
      .then((listed) => {
        if (!cancelled) setSlashCatalog(Array.isArray(listed.skills) ? listed.skills : []);
      })
      .catch(() => {
        if (!cancelled) setSlashCatalog([]);
      });
    void rpcCall<AgentListResult>("agent.list")
      .then((res) => {
        if (!cancelled) setAtCatalog(Array.isArray(res.items) ? res.items : []);
      })
      .catch(() => {
        if (!cancelled) setAtCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [view, ready, sidecarDead]);

  /** 流事件只写当前回合所属的对话标签（事件回调在挂载期注册，需稳定引用）。 */
  const setLiveItems = useCallback((updater: (prev: ChatItem[]) => ChatItem[]) => {
    setChatTabs((prev) => prev.map((tab) => (tab.id === liveChatRef.current ? { ...tab, items: updater(tab.items) } : tab)));
  }, []);

  /** 向最近激活的对话标签追加一条提示。 */
  function noteActive(text: string) {
    const note: ChatItem = { id: allocId(), kind: "note", text };
    const target = activeTab;
    setChatTabs((prev) => prev.map((tab) => (tab.id === target ? { ...tab, items: [...tab.items, note] } : tab)));
  }

  /** 子任务列表：拉取全部项目下的普通任务（非自动化），供侧栏任务区与选中项目卡片共用。 */
  async function refreshTasks() {
    try {
      const listed = await listTasks();
      setProjectTasks(Array.isArray(listed.tasks) ? listed.tasks : []);
    } catch {
      // 任务数据不可得时保留旧数据
    }
  }

  /** 在指定项目下新建子任务（普通任务，非自动化任务），成功后刷新任务列表并返回所建任务。 */
  async function createSubtask(project: ProjectInfo): Promise<TaskInfo> {
    const existing = projectTasks.filter((task) => task.projectId === project.id);
    const created = await createTask({ projectId: project.id, name: nextSubtaskName(existing) });
    await refreshTasks();
    return created.task;
  }

  /**
   * 侧边栏点击子任务：三分支统一先 alignWorkspaceOnly（不碰任何标签），再按分支激活/新建/载入。
   * 有会话的子任务直接恢复为可聊标签（无「继续此会话」跳转）；预铸必须排在对齐完成之后（复审 N1）。
   */
  async function selectSubtask(task: TaskInfo): Promise<void> {
    if (automationActiveRef.current) {
      noteActive("后台任务运行中，请稍候再切换任务。");
      return;
    }
    if (selectBusy) return;
    setSelectBusy(true);
    setView("main");
    setSelectedTaskId(task.id);
    try {
      if (task.projectId && task.projectId !== activeProjectIdRef.current) {
        await alignWorkspaceOnly(task.projectId);
      }
      const existing = chatTabs.find((tab) => tab.taskId === task.id);
      if (existing) {
        setActiveTab(existing.id);
        return;
      }
      // N-F：该任务已有「恢复失败」标签则复用，不重复新建。
      const failedTabId = failedSubtaskTabs.current.get(task.id);
      const failedTab = failedTabId ? chatTabs.find((tab) => tab.id === failedTabId) : undefined;
      if (failedTab) {
        setActiveTab(failedTab.id);
        return;
      }
      const id = `work-${nextChatSeq.current}`;
      nextChatSeq.current += 1;
      if (!task.sessionId) {
        // 空子任务：建标签后预铸独立会话（此时工作区已对齐，session.new 按新根铸造）。
        setChatTabs((prev) => [
          ...prev,
          { id, label: task.name, items: [], sessionFailed: false, projectId: task.projectId, pendingPick: false, taskId: task.id },
        ]);
        setActiveTab(id);
        void rpcCall<{ sessionId?: string }>("session.new", { fresh: true })
          .then((minted) => {
            if (typeof minted.sessionId === "string" && minted.sessionId) {
              setChatTabs((prev) =>
                prev.map((tab) => (tab.id === id && !tab.sessionId ? { ...tab, sessionId: minted.sessionId } : tab)),
              );
            }
          })
          .catch(() => undefined);
        return;
      }
      // 有会话：resume 恢复完整上下文 + 载入历史，直接可聊。
      const sessionId = task.sessionId;
      try {
        await rpcCall("session.resume", { sessionId });
        const opened = await rpcCall<{ records?: SessionDetailRecord[] }>("session.open", { sessionId });
        const view: SessionLogView = {
          sessionId,
          title: task.name,
          log: "",
          records: Array.isArray(opened.records) ? opened.records : [],
        };
        const items = historyToChatItems(view);
        setChatTabs((prev) => [
          ...prev,
          { id, label: task.name, items, sessionFailed: false, projectId: task.projectId, pendingPick: false, taskId: task.id, sessionId },
        ]);
      } catch (error) {
        // resume/open 失败：退化为项目上下文空标签 + 错误提示。
        // 不绑旧 sessionId（避免向损坏会话写消息），也不写 taskId（计划评审 P2-2）：
        // 若写 taskId，任务的持久 sessionId 仍在，后续发送两子态守卫都不命中，
        // 会走通用懒绑定 mint 一个无引用的游离项目会话——下次启动被清扫删除，消息丢失。
        // 不写 taskId 则该标签下条消息经子态一懒创建新子任务承载；旧子任务仍指向损坏会话，
        // 用户可通过右键菜单删除（级联清掉坏日志）。标签记入 N-F 去重表防连点堆积。
        failedSubtaskTabs.current.set(task.id, id);
        const note: ChatItem = {
          id: allocId(),
          kind: "note",
          text: `历史会话恢复失败（${error instanceof Error ? error.message : String(error)}），发送消息将创建新子任务；也可右键删除该子任务`,
        };
        setChatTabs((prev) => [
          ...prev,
          { id, label: task.name, items: [note], sessionFailed: false, projectId: task.projectId, pendingPick: false },
        ]);
      }
      setActiveTab(id);
    } catch (error) {
      // alignWorkspaceOnly 等工作区对齐失败（二轮复审 N-B）：旧 openProjectById 本有
      // try/catch→noteActive（App.tsx:1028-1033），抽 alignWorkspaceOnly 不能丢这层。
      // 失败时复位选中态，避免侧栏高亮悬空。
      noteActive(error instanceof Error ? error.message : String(error));
      setSelectedTaskId(null);
    } finally {
      setSelectBusy(false);
    }
  }

  /** 子任务重命名：RPC + 绑定标签 label 同步。 */
  async function renameSubtask(taskId: string, name: string) {
    await renameTask({ taskId, name });
    setChatTabs((prev) => prev.map((tab) => (tab.taskId === taskId ? { ...tab, label: name } : tab)));
    await refreshTasks();
  }

  /**
   * 自动命名（方案 B）：仍是默认名「子任务 N」且绑定会话已有真实标题的子任务，一次性落盘改名。
   * 守卫链保证：用户手改过的名字不匹配默认模式永不覆盖；改名后不再匹配默认模式不会反复写；
   * fired ref 防 RPC 在飞期间（projectTasks 还是旧快照）重复触发，失败则放行下次重试。
   */
  const autoRenameFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const { taskId, name } of subtaskRenamesFromTitles(projectTasks, sessions)) {
      if (autoRenameFiredRef.current.has(taskId)) continue;
      autoRenameFiredRef.current.add(taskId);
      void renameSubtask(taskId, name).catch(() => {
        autoRenameFiredRef.current.delete(taskId);
      });
    }
  }, [projectTasks, sessions]);

  /** 子任务删除：级联删会话历史（sidecar 侧）；关闭绑定标签并清选中；维护「chatTabs 非空」不变量。 */
  async function removeSubtask(task: TaskInfo) {
    await removeTask(task.id);
    if (selectedTaskId === task.id) setSelectedTaskId(null);
    const remaining = chatTabs.filter((tab) => tab.taskId !== task.id);
    const needSeed = remaining.length === 0;
    const removingActive = remaining.length !== chatTabs.length && !remaining.some((tab) => tab.id === activeTab);
    // 不变量：chatTabs 恒非空——activeChat = chatTabs.find(...) ?? chatTabs[0] 依赖它，
    // 空数组会让 activeChat 变 undefined 并在渲染时无守护地解引用。过滤后为空必须补种子标签。
    // 种子标签用中立形态（projectId:null）：绝不用 task.projectId，避免跨工作区 cwd 守卫拒绝首发。
    const seedId = `work-${nextChatSeq.current}`;
    nextChatSeq.current += 1;
    setChatTabs((prev) => {
      const filtered = prev.filter((tab) => tab.taskId !== task.id);
      return filtered.length > 0
        ? filtered
        : [{ id: seedId, label: "对话", items: [], sessionFailed: false, projectId: null, pendingPick: false }];
    });
    if (needSeed) setActiveTab(seedId);
    else if (removingActive) setActiveTab(remaining[0]?.id ?? "work-1");
    await refreshTasks();
    // sidecar 已级联删除该子任务的会话日志：同步刷新会话快照，
    // 否则残留行会被 unscopedSessions 判成游离会话出现在「任务」区，删除时报 session was not found。
    await refreshSessions();
  }

  /** 刷新历史会话列表。游离会话过滤在渲染处做（unscopedSessions）。 */
  async function refreshSessions() {
    try {
      const listed = await rpcCall<SessionRow[]>("session.list", {});
      setSessions(Array.isArray(listed) ? listed : []);
    } catch {
      setSessions([]);
    }
  }

  /**
   * 把工作区切回中立根（未归属项目的「任务」会话的工作目录）。
   * 宿主进程内热切换，不重启应用。已在中立根时短路；切走则清掉项目激活态。
   * 真实切换后默认标签 work-1 重新绑定中立根的稳定会话（它恒为「当前工作区的主对话」）。
   */
  async function ensureNeutralWorkspace(): Promise<void> {
    const closed = await rpcCall<{ workspaceRoot?: string }>("workspace.close");
    const root = typeof closed.workspaceRoot === "string" ? closed.workspaceRoot : "";
    if (!root || workspaceRef.current === root) return;
    setWorkspace(root);
    workspaceRef.current = root;
    setActiveProjectId(null);
    activeProjectIdRef.current = null;
    setGitWarning("");
    await rebindTabSession("work-1");
  }

  /** 启动后为默认对话标签绑定稳定会话（跨重启延续上下文）。 */
  async function bindDefaultTabSessions() {
    try {
      const minted = await rpcCall<{ sessionId?: string }>("session.new", {});
      if (typeof minted.sessionId === "string" && minted.sessionId) {
        setChatTabs((prev) =>
          prev.map((tab) => (tab.id === "work-1" && !tab.sessionId ? { ...tab, sessionId: minted.sessionId } : tab)),
        );
      }
    } catch {
      // sidecar 未就绪时保持未绑定，发送流程会懒绑定
    }
  }

  async function refreshProjects() {
    try {
      const listed = await listProjects();
      setProjects(Array.isArray(listed.projects) ? listed.projects : []);
    } catch {
      // sidecar 未就绪时保持现状
    }
  }

  /** 自动化数据：拉取全部自动化与运行历史（各视图自行按展示范围过滤，避免 Chat/Work 入口受当前项目限制）。 */
  async function refreshAutomations() {
    try {
      const listed = await listAutomations();
      const nextAutomations = Array.isArray(listed.automations) ? listed.automations : [];
      setAutomations(nextAutomations);
      automationsRef.current = nextAutomations;
      setAutomationRuns(listed.runs ?? {});
      // 重启重建（规格 L544 修订）：run tab 只由实时 run-start 事件创建进内存，重启即消失；
      // 这里按「每任务最近一次带会话的运行」补出骨架标签，内容首开时懒加载（见 runBackfill effect）。
      // 去重键 run-<runId> 与实时创建相同，幂等；只 append 不重置，chatTabs 恒非空不变量不破。
      const rebuild = runTabsToRebuild(
        nextAutomations,
        listed.runs ?? {},
        new Set(chatTabsRef.current.map((tab) => tab.id)),
      );
      if (rebuild.length > 0) {
        setChatTabs((prev) => {
          const have = new Set(prev.map((tab) => tab.id));
          const additions = rebuild
            .filter((descriptor) => !have.has(descriptor.tabId))
            .map((descriptor): ChatTab => ({
              id: descriptor.tabId,
              label: descriptor.label,
              items: [{ id: allocId(), kind: "note" as const, text: "自动化运行记录（打开时加载）" }],
              sessionFailed: false,
              projectId: descriptor.projectId,
              pendingPick: false,
              sessionId: descriptor.sessionId,
              automationId: descriptor.automationId,
              runPlaceholder: true,
            }));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
      }
    } catch {
      // 任务数据不可得时保留旧数据
    }
  }

  /** Task 10：判定驱动在前端——automation.list 每次刷新后重算期望的 hold 并交给驱动。
   * sidecar 无法 invoke Tauri command，只能由这里发起。断言/重试/过期结果丢弃的
   * 状态机在 logic/keepAwake.ts（M4 评审 D4：失败不提交、同值刷新不丢成功回调）。 */
  useEffect(() => {
    keepAwakeDriver.refresh(shouldHoldKeepAwake(keepAwake, automations));
  }, [keepAwake, automations, keepAwakeDriver]);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const allocId = () => {
      const id = nextId.current;
      nextId.current += 1;
      return id;
    };
    /** 事件的来源会话已绑定标签时返回该标签 id（自动化运行对话 / 多标签精确路由）。 */
    const boundTabFor = (sessionId?: string): string | undefined => {
      if (typeof sessionId !== "string" || !sessionId) return undefined;
      return chatTabsRef.current.find((tab) => tab.sessionId === sessionId)?.id;
    };
    /** sessionId 命中的绑定标签优先，缺省回退 liveChatRef。 */
    const targetTabFor = (sessionId?: string): string => {
      const bound = boundTabFor(sessionId);
      if (bound) return bound;
      return liveChatRef.current;
    };
    const setChannelItems = (updater: (prev: ChatItem[]) => ChatItem[], sessionId?: string) => {
      const target = targetTabFor(sessionId);
      setChatTabs((prev) => prev.map((tab) => (tab.id === target ? { ...tab, items: updater(tab.items) } : tab)));
    };
    /** 回合正常结束：读侧核对用户写明的文件与命令，把结果写进对话；不重跑任何命令。 */
    const appendTurnOutcome = async (sessionId?: string) => {
      const tabId = targetTabFor(sessionId);
      const tab = chatTabsRef.current.find((candidate) => candidate.id === tabId);
      if (!tab || tab.automationId || !tab.items.some((item) => item.kind === "user")) return;
      const checks = turnChecks(tab.items);
      const root = workspaceRef.current;
      let tree: TreeNode[] = [];
      if (checks.requiredFiles.length > 0 && root) {
        try {
          tree = await listTree(root, 6);
        } catch {
          tree = [];
        }
      }
      if (cancelled) return;
      const notes = turnOutcomeNotes(checks, tree);
      setChatTabs((prev) =>
        prev.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, items: [...candidate.items, ...notes.map((text) => ({ id: allocId(), kind: "note" as const, text }))] }
            : candidate,
        ),
      );
    };
    const setChannelSessionFailed = (failed: boolean, sessionId?: string) => {
      const target = targetTabFor(sessionId);
      setChatTabs((prev) => prev.map((tab) => (tab.id === target ? { ...tab, sessionFailed: failed } : tab)));
    };
    void (async () => {
      unlisten.push(
        await onSidecarEvent((event) => {
          if (cancelled) return;
          // 后台任务事件：更新任务运行角标并刷新数据；agent 运行另建运行对话标签承载过程与结果。
          if (event.event === "automation/run-start") {
            automationActiveRef.current = true;
            setRunningAutomationIds((prev) => new Set(prev).add(event.automationId));
            if (event.sessionId) {
              const automation = automationsRef.current.find((item) => item.id === event.automationId);
              const tabId = `run-${event.runId}`;
              setChatTabs((prev) =>
                prev.some((tab) => tab.id === tabId)
                  ? prev
                  : [
                      ...prev,
                      {
                        id: tabId,
                        label: automation?.name ?? "自动化运行",
                        items: [{ id: allocId(), kind: "note" as const, text: "自动化运行中…" }],
                        sessionFailed: false,
                        projectId: automation?.projectId ?? null,
                        pendingPick: false,
                        sessionId: event.sessionId,
                        automationId: event.automationId,
                      },
                    ],
              );
              // 仅手动触发时聚焦；调度运行只在分区出现，不抢上下文。
              if (event.trigger === "manual") setActiveTab(tabId);
            }
            return;
          }
          if (event.event === "automation/widget") {
            void refreshAutomations();
            return;
          }
          if (event.event === "automation/missed") {
            // 错过补跑被跳过：刷新任务列表 + 累积本次会话的 missed 横幅计数（Task 11，dismiss 后不再累积）。
            void refreshAutomations();
            setMissedBanner((prev) => ({ ...prev, count: nextMissedCount(prev.count, prev.dismissed) }));
            return;
          }
          if (event.event === "automation/run-end") {
            setRunningAutomationIds((prev) => {
              const next = new Set(prev);
              next.delete(event.automationId);
              return next;
            });
            automationActiveRef.current = false;
            // 运行对话标签追加结果脚注（过程 token 已由 sessionId 路由进同一标签）。
            if (event.sessionId) {
              const target = boundTabFor(event.sessionId);
              if (target) {
                // 文案单一来源在 runTabsLogic（重启重建的回填脚注复用同一映射）。
                const resultLabel = runResultNoteText(event.status);
                setChatTabs((prev) =>
                  prev.map((tab) =>
                    tab.id === target
                      ? { ...tab, items: [...tab.items, { id: allocId(), kind: "note" as const, text: resultLabel }] }
                      : tab,
                  ),
                );
              }
            }
            void refreshAutomations();
            void refreshSessions();
            // Task 11：非 ok 运行（error/timeout/cancelled）发系统通知；missed 不走这条路径
            // （missed 从未经过 run-end，见 automation/missed 分支），应用内横幅是它的兜底。
            if (event.status && event.status !== "ok") {
              const name = automationsRef.current.find((item) => item.id === event.automationId)?.name ?? "任务";
              const statusLabel =
                event.status === "timeout" ? "超时" : event.status === "cancelled" ? "已取消" : "失败";
              void notifyRunFailed(`「${name}」运行${statusLabel}`, "点击 HuaAnWork 查看运行详情");
            }
            return;
          }
          // 事件路由（review A4）：自动化运行会话（huaanwork-auto- / huaanwork-chat-auto- 前缀）
          // 自身的 token/tool/approval/diff/session-end 只在绑定了运行对话标签时渲染（路由进该标签），
          // 否则永不写入用户对话流——即便并发多运行、run-end 角标时序滞后也不泄漏
          // （布尔角标只在下方作兜底）。
          const eventSessionId = "sessionId" in event ? event.sessionId : undefined;
          const boundTab = boundTabFor(eventSessionId);
          if (typeof eventSessionId === "string" && isAutomationSessionId(eventSessionId) && !boundTab) return;
          // 运行期间其余非用户会话事件（子代理、旧 sidecar 无归因事件）维持抑制；
          // 用户自身会话（huaanwork-chat- / huaanwork-<digest>）与绑定运行标签的事件照常渲染，
          // 并发 Chat 回合不再被全局布尔误伤（「运行中看直播」的路由前提）。
          if (automationActiveRef.current && !isUserSessionId(eventSessionId) && !boundTab) return;
          handleEvent(event, allocId, setReady, setChannelItems, setDiff, setTurnActive, setChannelSessionFailed, async () => {
            await refreshSessions();
          }, sawReady);
          const kind = activityKind(event);
          const turnTab = turnTabRef.current;
          if (kind && turnTab && targetTabFor(eventSessionId) === turnTab) {
            const at = Date.now();
            setTurnPulse({ tabId: turnTab, latest: kind, at });
            setNow(at);
          }
          if (event.event === "session/end" && event.ok && event.cancelled !== true) {
            void appendTurnOutcome(eventSessionId);
          }
          if (event.event === "sidecar/status" && event.ready && authPhaseRef.current !== "logged-in") {
            pullAuthStatusRef.current();
          }
          if (event.event === "diff") {
            setDiff(event.text);
            setRightTab("diff");
          }
        }),
      );
      unlisten.push(
        await onSidecarExit((payload) => {
          if (cancelled) return;
          setSidecarDead(true);
          setTurnActive(false);
          if (!payload.ready && !sawReady.current) setPluginFail(PLUGIN_APPLY_FAIL);
          // sidecar 崩溃影响全部通道：所有有对话内容的标签均标记失败。
          setChatTabs((prev) =>
            prev.map((tab) =>
              tab.items.length > 0
                ? { ...tab, sessionFailed: true, items: [...tab.items, { id: allocId(), kind: "note" as const, text: "Sidecar 已退出。会话失败。" }] }
                : tab,
            ),
          );
        }),
      );
    })();
    return () => {
      cancelled = true;
      for (const fn of unlisten) fn();
    };
  }, []);

  const hydrateModels = useCallback((settings: ModelSettingsPayload) => {
    const next = applySettingsModels(settings);
    setSavedModels(next.models);
    setActiveModelId(next.activeId);
    setModelLabel(next.label);
    setWorkAllowNetwork(settings.allow_network === true);
    setKeepAwake(settings.keep_awake !== false);
    setGuardMode(parseGuardMode(settings.guard_mode));
  }, []);

  const refreshModelLabel = useCallback(async () => {
    try {
      hydrateModels(await rpcCall<ModelSettingsPayload>("settings.get"));
    } catch {
      setModelLabel("");
    }
  }, [hydrateModels]);

  async function selectModel(id: string) {
    try {
      hydrateModels(await rpcCall<ModelSettingsPayload>("settings.set", { active_model_id: id }));
    } catch {
      await refreshModelLabel();
    }
  }

  async function applyThemePref(next: ThemePref) {
    setTheme(next);
    applyHtmlTheme(resolveTheme(next, window.matchMedia("(prefers-color-scheme: dark)").matches));
    await rpcCall("settings.set", { theme: next });
    persistThemeMirror(next);
  }

  /** 自动化页右上角快捷开关：与设置「账户」页的保持系统唤醒开关共用同一持久化字段。 */
  async function toggleKeepAwake(next: boolean) {
    try {
      hydrateModels(await rpcCall<ModelSettingsPayload>("settings.set", { keep_awake: next }));
    } catch {
      // 忽略：下次 automation.list 刷新触发的效果会按当前（未更新）值重试
    }
  }

  /** 持久化护栏档位；失败回滚 chip 显示并提示（磁盘实际值不变）。 */
  async function persistGuardMode(requested: GuardMode) {
    if (guardPersistBusy.current) return;
    guardPersistBusy.current = true;
    try {
      setGuardModeError("");
      const result = await commitGuardMode(guardMode, requested, (mode) =>
        rpcCall("settings.set", { guard_mode: mode }),
      );
      setGuardMode(result.mode);
      if (result.error) setGuardModeError("保存失败，请重试");
    } finally {
      guardPersistBusy.current = false;
    }
  }

  /** chip 点击：先算下一档；切入 full 需确认，其余直接持久化。 */
  function requestGuardMode() {
    const requested = nextGuardMode(guardMode);
    if (shouldConfirmFull(requested)) {
      setGuardModeConfirm(requested);
      return;
    }
    void persistGuardMode(requested);
  }

  const markSidecarReady = useCallback(() => {
    sawReady.current = true;
    setReady(true);
  }, []);

  const refreshAfterLogin = useCallback(() => {
    void rpcCall<{ ready?: boolean }>("status.get")
      .then((status) => {
        if (status.ready) {
          markSidecarReady();
          void refreshProjects();
          void refreshAutomations();
          void refreshTasks();
          void refreshSessions();
          void bindDefaultTabSessions();
        }
      })
      .catch(() => undefined);
  }, [markSidecarReady]);

  const applyAuthStatus = useCallback((status: AuthStatus) => {
    if (status.state === "logged-in") {
      setUsername(status.username ?? "");
      setAuthPhase("logged-in");
      refreshAfterLogin();
      return;
    }
    if (status.state === "needs-register" || status.state === "logged-out") {
      setAuthPhase(status.state);
      if (status.username) setUsername(status.username);
    }
  }, [refreshAfterLogin]);

  const pullAuthStatus = useCallback(() => {
    void rpcCall<AuthStatus>("auth.status")
      .then((status) => {
        markSidecarReady();
        applyAuthStatus(status);
      })
      .catch(() => {
        /* 保持 unknown，等 sidecar/status 再拉一次 */
      });
  }, [applyAuthStatus, markSidecarReady]);
  pullAuthStatusRef.current = pullAuthStatus;

  useEffect(() => {
    void (async () => {
      const settingsP = rpcCall<ModelSettingsPayload & { theme?: unknown }>("settings.get")
        .then((settings) => {
          markSidecarReady();
          const pref = parseTheme(settings.theme);
          setTheme(pref);
          applyHtmlTheme(resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches));
          persistThemeMirror(pref);
          hydrateModels(settings);
        })
        .catch(() => {
          /* 启动 settings.get 失败：不改首帧镜像，不写 localStorage */
        });
      const authP = Promise.resolve().then(() => pullAuthStatus());
      await Promise.allSettled([settingsP, authP]);
    })();
  }, [hydrateModels, markSidecarReady, pullAuthStatus]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme !== "system") return;
      applyHtmlTheme(resolveTheme("system", media.matches));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    chatTabsRef.current = chatTabs;
  }, [chatTabs]);

  useEffect(() => {
    if (!turnActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turnActive]);

  useEffect(() => {
    const bridge = hostLivenessBridge();
    if (!bridge) return;
    let alive = true;
    const report = () => bridge.reportTurns((turnActive ? 1 : 0) + runningAutomationIds.size);
    report();
    void bridge.read().then((state) => {
      if (!alive) return;
      setHostPhase(state.phase);
      report();
    }).catch(() => {});
    const stop = bridge.onChange((state) => {
      setHostPhase(state.phase);
      report();
    });
    return () => {
      alive = false;
      stop();
    };
  }, [turnActive, runningAutomationIds]);

  /**
   * 重启重建的运行对话骨架：首次打开时懒加载运行日志回填内容（不调 session.resume、
   * 不切工作区——激活不抢上下文，工作区对齐推迟到发送时由 send() 做）。
   * busy ref 防 RPC 在飞期间（chatTabs 还是旧快照）重复触发与 StrictMode 双调；
   * 失败降级为错误脚注，骨架与 sessionId 保留（续聊仍可用，发送路径自行对齐/报错）。
   */
  const runBackfillBusyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const tab = chatTabs.find((item) => item.id === activeTab);
    if (!tab?.automationId || !tab.runPlaceholder || !tab.sessionId) return;
    if (runBackfillBusyRef.current.has(tab.id)) return;
    runBackfillBusyRef.current.add(tab.id);
    const tabId = tab.id;
    const sessionId = tab.sessionId;
    const automationId = tab.automationId;
    void (async () => {
      try {
        const opened = await rpcCall<{ records?: SessionDetailRecord[] }>("session.open", { sessionId });
        const view: SessionLogView = {
          sessionId,
          title: tab.label,
          log: "",
          records: Array.isArray(opened.records) ? opened.records : [],
        };
        const items = historyToChatItems(view);
        // 按 sessionId 匹配所属 run 取结果脚注：重建后同一任务又跑了新 run 也不会拿错。
        const run = (automationRuns[automationId] ?? []).find((item) => item.sessionId === sessionId);
        if (run) items.push({ id: allocId(), kind: "note", text: runResultNoteText(run.status) });
        setChatTabs((prev) =>
          prev.map((item) => (item.id === tabId ? { ...item, items, runPlaceholder: false } : item)),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setChatTabs((prev) =>
          prev.map((item) =>
            item.id === tabId
              ? {
                  ...item,
                  runPlaceholder: false,
                  items: [
                    ...item.items,
                    { id: allocId(), kind: "note" as const, text: `运行记录加载失败（${message}）` },
                  ],
                }
              : item,
          ),
        );
      }
    })();
  }, [activeTab, chatTabs, automationRuns]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // 进入自动化页面时拉取数据（页面为跨项目全局视图，无需聚焦项目）
  useEffect(() => {
    if (view !== "automations") return;
    void refreshAutomations();
  }, [view]);
  
  // 右侧面板「项目」页签：懒加载当前工作区文件树；首次可见时拉取，切换工作区后重新拉取。
  useEffect(() => {
    if (rightTab !== "files" || !workspace) return;
    if (treeRootRef.current === workspace && projectTree !== null) return;
    let cancelled = false;
    treeRootRef.current = workspace;
    setTreeError("");
    setProjectTree(null);
    void listTree(workspace, 4)
      .then((nodes) => {
        if (!cancelled) setProjectTree(Array.isArray(nodes) ? nodes : []);
      })
      .catch((error) => {
        if (cancelled) return;
        setTreeError(error instanceof Error ? error.message : String(error));
        setProjectTree([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rightTab, workspace, projectTree]);

  // ⌘B 收起 / 展开导航；⌘K 新建任务；⌘, 打开设置
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (authPhaseRef.current !== "logged-in") return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        setCollapsed((prev) => !prev);
      } else if (key === "k") {
        event.preventDefault();
        newTaskRef.current();
      } else if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌘K 监听在挂载期注册，通过 ref 调用最新渲染的 newTask
  useEffect(() => {
    newTaskRef.current = newTask;
  });

  useEffect(() => {
    if (items.length > 0) {
      chatEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [items, activeTab]);

  function allocId() {
    const id = nextId.current;
    nextId.current += 1;
    return id;
  }

  /** 新建项目流程：Tauri 选文件夹 → 命名模态 → 创建并打开。 */
  async function createProjectFlow() {
    if (automationActiveRef.current) {
      noteActive("后台任务运行中，请稍候再切换项目。");
      return;
    }
    const selected = await pickDirectory();
    if (!selected) return;
    setCreatingError("");
    setCreatingProject({ root: selected, defaultName: workspaceName(selected) });
  }

  async function confirmCreateProject(name: string) {
    if (!creatingProject) return;
    setCreatingBusy(true);
    setCreatingError("");
    try {
      const created = await createAndOpen(creatingProject.root, name);
      setCreatingProject(null);
      await applyOpenedProject(created.project, created.workspaceRoot);
    } catch (error) {
      setCreatingError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingBusy(false);
    }
  }

  async function openProjectById(projectId: string) {
    if (automationActiveRef.current) {
      noteActive("后台任务运行中，请稍候再切换项目。");
      return;
    }
    try {
      const opened = await openProjectRpc(projectId);
      await applyOpenedProject(opened.project, opened.workspaceRoot);
    } catch (error) {
      noteActive(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 按当前工作区重新铸造某个对话标签的会话 id（仅中立根场景使用）。
   * 默认标签走通道稳定会话（跨重启延续），其余标签走独立会话，与发送流程的懒绑定规则一致。
   */
  async function rebindTabSession(chatId: string): Promise<void> {
    try {
      const minted = await rpcCall<{ sessionId?: string }>("session.new", {
        fresh: chatId !== "work-1",
      });
      if (typeof minted.sessionId !== "string" || !minted.sessionId) return;
      setChatTabs((prev) => prev.map((tab) => (tab.id === chatId ? { ...tab, sessionId: minted.sessionId } : tab)));
    } catch {
      // sidecar 未就绪时保持旧绑定，发送流程会懒绑定
    }
  }

  /** 项目打开后的状态刷新：工作区、激活项目、git 提示与各列表 refresh。不写任何标签。 */
  async function postOpenState(project: ProjectInfo, root: string): Promise<void> {
    setWorkspace(root);
    setActiveProjectId(project.id);
    activeProjectIdRef.current = project.id;
    workspaceRef.current = root;
    const git = await hasGit(root);
    setGitWarning(git ? "" : "该项目目录没有 .git。仍将打开。");
    void refreshTasks();
    void refreshSessions();
    void refreshProjects();
    void refreshAutomations();
  }

  /**
   * 只做工作区对齐（sidecar re-boot），绝不触碰 chatTabs/selectedTaskId。
   * selectSubtask 专用：applyOpenedProject 会对活跃标签做破坏性写入（闭包捕获旧 activeTab），
   * 跨项目点子任务时绝不能走它（评审 P1-1 + 复审 N1）。
   */
  async function alignWorkspaceOnly(projectId: string): Promise<void> {
    const opened = await openProjectRpc(projectId);
    await postOpenState(opened.project, opened.workspaceRoot);
  }

  /** 项目打开后的统一刷新：工作区 + 标签绑定。 */
  async function applyOpenedProject(project: ProjectInfo, root: string) {
    await postOpenState(project, root);
    // 打开项目时清空子任务选中（项目级选中取代任务级选中）
    setSelectedTaskId(null);
    const note: ChatItem = { id: allocId(), kind: "note", text: `已打开项目 ${project.name}` };
    const target = activeTab;
    const targetTab = chatTabs.find((tab) => tab.id === target);
    if (targetTab && (chatTabHasConversation(targetTab) || targetTab.taskId != null)) {
      // 活跃标签已有对话（如 work-1 的中立历史）、或已绑子任务（含 selectSubtask 预铸的空任务标签）：
      // 新建标签承接项目绑定，原标签不动（评审 P2-4；二轮复审 N-A——空任务标签被改绑 projectId 后，
      // 首发会把旧项目任务绑到新项目 cwd 的会话，重启 resume 被 cwd 守卫拒、对话永久不可达）。
      const id = `work-${nextChatSeq.current}`;
      nextChatSeq.current += 1;
      setChatTabs((prev) => [
        ...prev,
        { id, label: "对话", items: [note], sessionFailed: false, projectId: project.id, pendingPick: false },
      ]);
      setActiveTab(id);
      return;
    }
    // 当前对话绑定到该项目，结束「选择项目」等待态。
    // sessionId 一并清掉：标签可能残留旧工作区绑定（如 work-1 登录时绑的中立稳定会话，
    // bindDefaultTabSessions App.tsx:569-580），不清则首发懒创建会复用旧根会话被 cwd 守卫拒发
    // （计划评审 P1-2 防御层；主修复在 Task 7 的 ensureSubtaskSession 子态一强制 fresh）。
    setChatTabs((prev) =>
      prev.map((tab) =>
        tab.id === target
          ? { ...tab, pendingPick: false, projectId: project.id, sessionId: undefined, items: [...tab.items, note] }
          : tab,
      ),
    );
    // 不再 rebindTabSession：项目根稳定会话退役（规格 §1.5），项目内首条消息走懒创建建子任务。
  }

  function newTask() {
    setDraft("");
    setSelectedTaskId(null);
    setView("main");
    const id = `work-${nextChatSeq.current}`;
    nextChatSeq.current += 1;
    const workSeq = chatTabs.length + 1;
    setChatTabs((prev) => [
      ...prev,
      { id, label: `任务 ${workSeq}`, items: [], sessionFailed: false, projectId: null, pendingPick: true },
    ]);
    setActiveTab(id);
  }

  function pickSlashSkill(skill: SkillInfo) {
    const token = slashTokenAt(draft, slashCursor);
    const next = token
      ? `${draft.slice(0, token.start)}/${skill.name} ${draft.slice(token.end)}`
      : `${draft}${draft && !/\s$/.test(draft) ? " " : ""}/${skill.name} `;
    const caret = token ? token.start + skill.name.length + 2 : next.length;
    setDraft(next);
    setSlashCursor(caret);
    setSlashClosed(true);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function pickAtAgent(agent: AgentListItem) {
    const token = atTokenAt(draft, atCursor);
    const next = token
      ? `${draft.slice(0, token.start)}@${agent.name} ${draft.slice(token.end)}`
      : `${draft}${draft && !/\s$/.test(draft) ? " " : ""}@${agent.name} `;
    const caret = token ? token.start + agent.name.length + 2 : next.length;
    setDraft(next);
    setAtCursor(caret);
    setAtClosed(true);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function tryOpenAutomationFromDraft(text: string): boolean {
    const parsed = parseSchedulePhrase(text);
    if (!parsed) return false;
    // issue #2：不再隐式绑定活跃项目或 projects[0]——以 null 进表单,归属由用户在下拉里显式选择。
    setAutomationEnter({
      mode: "create",
      projectId: null,
      schedule: parsed.schedule,
      ...(parsed.remainder ? { prompt: parsed.remainder } : {}),
    });
    setView("automations");
    return true;
  }

  /**
   * 发送前的子任务收编（规格 §2.5 统一不变式）：
   * 子态一 taskId==null → 建任务（名取首条消息摘要）+ 铸会话 + 绑定；
   * 子态二 taskId 有而 task.sessionId 空（上次中途失败）→ 复用已建任务，只铸会话 + 绑定。
   * 返回绑定好的 sessionId；任何一步失败 throw，由 send 捕获后不发送（消息留在输入框）。
   */
  async function ensureSubtaskSession(tab: ChatTab, firstText: string): Promise<string | undefined> {
    // createdNow 区分子态（计划评审 P1-2）：子态一（本次新建任务）必须 fresh 铸造，
    // 绝不复用 tab.sessionId——它可能是旧工作区残留（work-1 的中立稳定会话），
    // 复用会被 sidecar 跨工作区 cwd 守卫拒发（规格 §2.1 step 2「必须 fresh:true」）。
    const createdNow = !tab.taskId;
    let task = tab.taskId ? projectTasks.find((item) => item.id === tab.taskId) : undefined;
    if (createdNow) {
      const created = await createTask({ projectId: tab.projectId as string, name: subtaskNameFromMessage(firstText) });
      task = created.task;
      // taskId 提前写回（评审 P2-1）：后续步骤失败时重试走子态二，不会重复建任务。
      setChatTabs((prev) =>
        prev.map((item) => (item.id === tab.id ? { ...item, taskId: task!.id, label: task!.name } : item)),
      );
      // N-F 清理：该标签若曾是某损坏任务的「恢复失败」标签，它现在有了新归属，删掉旧映射。
      for (const [key, value] of failedSubtaskTabs.current) {
        if (value === tab.id) failedSubtaskTabs.current.delete(key);
      }
      setSelectedTaskId(task.id);
      void refreshTasks();
    }
    if (task?.sessionId) {
      // 防御：任务已有绑定会话而标签没绑（如预铸竞态），回填。
      const bound = task.sessionId;
      setChatTabs((prev) =>
        prev.map((item) => (item.id === tab.id && item.sessionId !== bound ? { ...item, sessionId: bound } : item)),
      );
      return bound;
    }
    // 子态二复用标签的预铸会话（规格 §2.4）；子态一强制 mint fresh。
    let sessionId = createdNow ? undefined : tab.sessionId;
    if (!sessionId) {
      const minted = await rpcCall<{ sessionId?: string }>("session.new", { fresh: true });
      sessionId = typeof minted.sessionId === "string" && minted.sessionId ? minted.sessionId : undefined;
      if (!sessionId) throw new Error("session.new 未返回会话 id");
      // 铸造成功即覆盖写回（子态一可能残留旧根会话 id，必须覆盖而非仅在空缺时回填）。
      setChatTabs((prev) => prev.map((item) => (item.id === tab.id ? { ...item, sessionId } : item)));
    }
    const taskId = tab.taskId ?? task?.id;
    if (!taskId) throw new Error("子任务创建失败");
    await bindTaskSession({ taskId, sessionId });
    void refreshTasks();
    return sessionId;
  }

  async function send() {
    const text = draft.trim();
    const invokedSkill = parseSlashInvoke(text);
    const invokedAt = parseAtInvoke(text);
    if ((!text && !invokedAt) || sidecarDead || turnActive || hostPhase !== "ok") return;
    if (tryOpenAutomationFromDraft(text)) return;
    if (automationActiveRef.current) {
      noteActive("后台任务运行中，请稍候再发送消息。");
      return;
    }
    // 同步重入护栏（R3-1）：覆盖到 setTurnActive(true) 之前的整段异步前奏。
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      const chatId = activeTab;
      liveChatRef.current = chatId;
      // 未归属项目的 work 标签（新建未选项目的任务、从历史恢复的未归属会话）发送前先把工作区
      // 对齐中立根：否则会话会以「最近打开的项目」目录为 cwd 落盘/被拒发。对齐失败（如后台任务
      // 运行中）不发送。默认标签 work-1 跟随当前工作区，不在此列。
      const sendingTab = chatTabs.find((tab) => tab.id === chatId);
      if (sendingTab && sendingTab.projectId == null && chatId !== "work-1") {
        try {
          await ensureNeutralWorkspace();
        } catch (error) {
          noteActive(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      // 运行对话标签续聊（规格 L544 修订）：sidecar cwd 守卫要求工作区 == 运行会话目录，
      // 项目 run tab 发送前先对齐到运行所属项目（中立 run tab 已被上方 ensureNeutralWorkspace
      // 覆盖；run tab 必有 sessionId，下方懒绑定块自动跳过）。用 alignWorkspaceOnly 而非
      // openProjectById：后者经 applyOpenedProject 会改写标签绑定。已在该项目时跳过，
      // 避免重复 re-boot。对齐失败不发送，draft 保留（同上方中立对齐的降级模式）。
      if (
        sendingTab?.automationId &&
        sendingTab.projectId != null &&
        sendingTab.projectId !== activeProjectIdRef.current
      ) {
        try {
          await alignWorkspaceOnly(sendingTab.projectId);
        } catch (error) {
          noteActive(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      // 子任务收编守卫（规格 §2.5）：项目上下文标签发送前必须有绑定的子任务会话。
      let sessionId = sendingTab?.sessionId;
      const needsSubtask =
        sendingTab &&
        needsSubtaskOnSend(
          {
            projectId: sendingTab.projectId,
            taskId: sendingTab.taskId,
            pendingPick: sendingTab.pendingPick,
            hasConversation: chatTabHasConversation(sendingTab),
          },
          sendingTab.taskId ? projectTasks.find((item) => item.id === sendingTab.taskId)?.sessionId : undefined,
        );
      if (needsSubtask && sendingTab) {
        try {
          sessionId = await ensureSubtaskSession(sendingTab, text);
        } catch (error) {
          noteActive(error instanceof Error ? error.message : String(error));
          return; // 不发送：draft 未清空，用户可重试
        }
      }

      // 懒绑定会话：默认标签绑定通道稳定会话（跨重启延续），其余中立标签铸造独立会话。
      if (!sessionId) {
        try {
          const minted = await rpcCall<{ sessionId?: string }>("session.new", {
            fresh: chatId !== "work-1",
          });
          if (typeof minted.sessionId === "string" && minted.sessionId) {
            sessionId = minted.sessionId;
            setChatTabs((prev) => prev.map((tab) => (tab.id === chatId && !tab.sessionId ? { ...tab, sessionId } : tab)));
          }
        } catch {
          sessionId = undefined;
        }
      }
      // 项目上下文不允许无 sessionId 回退（规格 §1.5）：静默回退会把消息写进项目根稳定会话，
      // 下次启动被清扫删除——宁可不发送。
      if (sendingTab && sendingTab.projectId != null && !sessionId) {
        noteActive("子任务会话尚未就绪，消息未发送。请重试。");
        return;
      }
      // 注意：pendingPick 标签在此不再绑定 activeProjectId——项目归属只来自用户在 chip 里的显式选择
      // （applyOpenedProject），未选择的会话留在中立根，按 cwd 分组落入侧栏「任务」区。
      const userMsg: ChatItem = { id: allocId(), kind: "user", text };
      setChatTabs((prev) => prev.map((tab) => (tab.id === chatId ? { ...tab, items: [...tab.items, userMsg] } : tab)));
      setDraft("");
      const started = Date.now();
      turnTabRef.current = chatId;
      setTurnPulse({ tabId: chatId, latest: "quiet", at: started });
      setNow(started);
      setTurnActive(true);
      stopping.current = false;
      try {
        await rpcCall("session.send", {
          text: invokedAt ? invokedAt.remainder : invokedSkill ? invokedSkill.remainder : text,
          ...(sessionId ? { sessionId } : {}),
          ...(invokedAt ? { at: { name: invokedAt.name } } : invokedSkill ? { skill: invokedSkill.name } : {}),
        });
      } catch (error) {
        setTurnActive(false);
        if (stopping.current) {
          stopping.current = false;
          return;
        }
        const note: ChatItem = { id: allocId(), kind: "note", text: error instanceof Error ? error.message : String(error) };
        setChatTabs((prev) =>
          prev.map((tab) => (tab.id === chatId ? { ...tab, sessionFailed: true, items: [...tab.items, note] } : tab)),
        );
      }
    } finally {
      sendingRef.current = false;
    }
  }

  async function stopTurn() {
    if (sidecarDead || !turnActive) return;
    stopping.current = true;
    const sessionId = chatTabs.find((tab) => tab.id === activeTab)?.sessionId;
    try {
      await rpcCall("session.cancel", { ...(sessionId ? { sessionId } : {}) });
      setLiveItems((prev) => [...prev, { id: allocId(), kind: "note", text: "已停止" }]);
    } catch (error) {
      stopping.current = false;
      setLiveItems((prev) => [
        ...prev,
        { id: allocId(), kind: "note", text: error instanceof Error ? error.message : String(error) },
      ]);
    }
  }

  /** 宿主先把未回答的计划评审以取消结算，再退出计划模式；评审卡不在屏上时也能用。 */
  async function exitPlanMode() {
    if (sidecarDead) return;
    const target = activeTab;
    const sessionId = chatTabs.find((tab) => tab.id === target)?.sessionId;
    try {
      const result = await rpcCall("session.exitPlanMode", { ...(sessionId ? { sessionId } : {}) });
      const text = planExitNote(result);
      if (!text) {
        const note: ChatItem = { id: allocId(), kind: "note", text: "未能退出计划模式" };
        setChatTabs((prev) => prev.map((tab) => (tab.id === target ? { ...tab, items: [...tab.items, note] } : tab)));
        return;
      }
      const note: ChatItem = { id: allocId(), kind: "note", text };
      setChatTabs((prev) =>
        prev.map((tab) =>
          tab.id === target
            ? {
                ...tab,
                items: [
                  ...tab.items.map((item) =>
                    item.kind === "ask" && item.card.toolName === "plan-review" && !item.card.answered && !item.card.autoContinue
                      ? { ...item, card: { ...item.card, answered: "reject" as const } }
                      : item,
                  ),
                  note,
                ],
              }
            : tab,
        ),
      );
    } catch (error) {
      noteActive(error instanceof Error ? error.message : String(error));
    }
  }

  async function answer(card: AskCard, decision: "approve" | "reject") {
    if (sidecarDead) return;
    const method = decision === "approve" ? "session.approve" : "session.reject";
    await rpcCall(method, { approvalRequestId: card.approvalRequestId });
    setLiveItems((prev) =>
      prev.map((item) =>
        item.kind === "ask" && item.card.approvalRequestId === card.approvalRequestId
          ? { ...item, card: { ...item.card, answered: decision } }
          : item,
      ),
    );
  }

  /**
   * 「任务」区游离会话：点击即恢复为可聊标签（对齐子任务的 selectSubtask 体验，无「继续此会话」跳转）。
   * 读历史失败或恢复失败时退化为只读历史视图 + 错误提示（面板内可经「继续此会话」重试）。
   */
  async function openFreeSession(sessionId: string) {
    if (resumeBusy) return;
    setView("main");
    setResumeBusy(true);
    let view: SessionLogView;
    try {
      const opened = await rpcCall<{
        records?: SessionDetailRecord[];
        summary?: SessionRow;
      }>("session.open", { sessionId });
      const summary = opened.summary ?? {};
      view = {
        sessionId,
        title: typeof summary.title === "string" && summary.title ? summary.title : sessionId,
        log: "",
        records: Array.isArray(opened.records) ? opened.records : [],
        createdAt: typeof summary.createdAt === "number" ? summary.createdAt : undefined,
        lastTime: typeof summary.lastTime === "number" ? summary.lastTime : undefined,
        cwd: typeof summary.cwd === "string" ? summary.cwd : undefined,
        messageCount: typeof summary.messageCount === "number" ? summary.messageCount : undefined,
        turnCount: typeof summary.turnCount === "number" ? summary.turnCount : undefined,
      };
    } catch (error) {
      setHistoryView({
        sessionId,
        title: sessionId,
        log: "",
        records: [],
        error: error instanceof Error ? error.message : String(error),
      });
      setResumeBusy(false);
      return;
    }
    setResumeBusy(false);
    await resumeFromView(view);
  }

  /** 历史记录映射为对话流条目（继续会话时回填标签内容）。 */
  function historyToChatItems(view: SessionLogView): ChatItem[] {
    return historyItemsFromRecords(view.records).map((item): ChatItem => {
      if (item.kind === "tool") {
        const callId = item.callId;
        return {
          id: allocId(),
          kind: "tool",
          card: { key: callId ?? `tool-${allocId()}`, name: item.name, ...(callId ? { callId } : {}), status: "end" },
        };
      }
      if (item.kind === "user") return { id: allocId(), kind: "user", text: item.text };
      if (item.kind === "thinking") {
        return { id: allocId(), kind: "thinking", thought: item.text, interrupted: false };
      }
      if (item.kind === "assistant") return { id: allocId(), kind: "assistant", text: item.text };
      return { id: allocId(), kind: "note", text: item.text };
    });
  }

  /**
   * 恢复历史会话为可聊标签：sidecar 恢复 agent（含完整上下文），前端回填标签内容。
   * 失败时落到只读历史视图并带上错误（面板内可经「继续此会话」重试）。
   */
  async function resumeFromView(view: SessionLogView) {
    if (resumeBusy || view.error) return;
    const sessionId = view.sessionId;
    // 会话的 cwd 守卫要求当前工作区与会话目录一致：先对齐再恢复。
    // cwd 归属某个已登记项目则打开该项目；否则回中立根。
    const owner =
      view.cwd ? projects.find((project) => cwdWithinRoot(view.cwd, project.root)) : undefined;
    setResumeBusy(true);
    try {
      if (view.cwd) {
        if (owner) {
          if (owner.id !== activeProjectIdRef.current) await openProjectById(owner.id);
        } else {
          await ensureNeutralWorkspace();
        }
      }
      await rpcCall("session.resume", { sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 从历史面板进来就原位标错；直接点击进来（无面板）则补出带错的历史视图，给出重试入口。
      setHistoryView((prev) =>
        prev?.sessionId === sessionId ? { ...prev, error: message } : { ...view, error: message },
      );
      setResumeBusy(false);
      return;
    }
    setResumeBusy(false);
    const items = historyToChatItems(view);
    const existing = chatTabs.find((tab) => tab.sessionId === sessionId);
    if (existing) {
      setChatTabs((prev) =>
        prev.map((tab) => (tab.id === existing.id ? { ...tab, items, sessionFailed: false } : tab)),
      );
      setActiveTab(existing.id);
    } else {
      const id = `work-${nextChatSeq.current}`;
      nextChatSeq.current += 1;
      const label = view.title && view.title !== sessionId ? view.title.slice(0, 24) : `任务 ${nextChatSeq.current - 1}`;
      // 防御：恢复的标签一律不绑项目（评审 P2-4），杜绝『有历史却命中懒创建』
      setChatTabs((prev) => [
        ...prev,
        { id, label, items, sessionFailed: false, projectId: null, pendingPick: false, sessionId },
      ]);
      setActiveTab(id);
    }
    setHistoryView(null);
    setView("main");
  }

  /** 「继续此会话」按钮：从历史详情视图恢复（resumeFromView 的历史面板入口）。 */
  async function resumeHistorySession() {
    const view = historyView;
    if (view) await resumeFromView(view);
  }

  async function removeSession(sessionId: string) {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await rpcCall("session.remove", { sessionId });
      setSessions((prev) => prev.filter((session, index) => String(session.id ?? `session-${index}`) !== sessionId));
      if (historyView?.sessionId === sessionId) setHistoryView(null);
      setConfirmDelete(null);
      setDeleteError("");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  const blocked = sidecarDead;
  /**
   * 运行对话标签仅在「该自动化运行进行中」锁输入；运行结束后可继续对话（规格 L544 修订，
   * 发送路径会自动对齐工作区到运行会话目录）。已知过锁：runningAutomationIds 按 automationId
   * 计，同一自动化 run N 进行中时其 run N-1 标签也锁——反正 send() 的 automationActiveRef
   * 全局块与 sidecar assertSessionSendable 都会拒，语义一致。
   */
  const runTabLive = activeChat.automationId !== undefined && runningAutomationIds.has(activeChat.automationId);
  const chatEmpty = items.length === 0;
  /** 自动化运行对话（live tab）：不进最近对话/历史列表。 */
  const runTabs = chatTabs.filter((tab) => tab.automationId);
  /** 「任务」区的游离会话：中立工作区对话（项目分组已退役，项目会话收编进子任务）。 */
  const unscopedWorkSessions = unscopedSessions(sessions, projects);
  const showRightPane = view === "main";
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const pendingAsk = chatTabs.some((tab) =>
    tab.items.some((item) => item.kind === "ask" && !item.card.answered),
  );
  const logoutDisabled = turnActive || pendingAsk;

  function openSettings(section?: SettingsSection) {
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  }

  async function logout() {
    await rpcCall("auth.logout");
    setSettingsOpen(false);
    setAuthPhase("logged-out");
  }

  if (authPhase !== "logged-in") {
    return (
      <AuthGate
        ready={ready}
        sidecarDead={sidecarDead}
        mode={authPhase === "needs-register" ? "needs-register" : "logged-out"}
        restoring={authPhase === "unknown"}
        savedUsername={username}
        canSubmit={authPhase !== "unknown"}
        onAuthed={(name) => {
          setUsername(name);
          setAuthPhase("logged-in");
          void refreshAfterLogin();
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <button
          type="button"
          className="nav-toggle"
          aria-label={collapsed ? "展开导航" : "收起导航"}
          title={`${collapsed ? "展开导航" : "收起导航"} ⌘B`}
          onClick={() => setCollapsed((prev) => !prev)}
        >
          <IconSidebar />
        </button>
        <span className="titlebar-title">
          {view === "skills"
            ? "技能中心"
            : view === "automations"
              ? "自动化"
              : view === "agents"
                ? "智能体"
                : view === "knowledge"
                  ? "知识库"
                  : view === "market"
                    ? "插件市场"
                    : ""}
        </span>
        {showRightPane ? (
          <button
            type="button"
            className="right-toggle"
            aria-label={rightCollapsed ? "展开面板" : "收起面板"}
            title={rightCollapsed ? "展开面板" : "收起面板"}
            onClick={() => setRightCollapsed((prev) => !prev)}
          >
            <IconRightPane />
          </button>
        ) : null}
      </header>

      <div
        className={`shell${collapsed ? " collapsed" : ""}${showRightPane ? "" : " no-right"}${rightCollapsed ? " right-collapsed" : ""}`}
      >
        <aside className="sidebar" aria-label="导航">
          <div className="brand">
            <img src={logoUrl} alt="华安基金" />
            <span>HuaAnWork</span>
          </div>
          <button type="button" className="nav-it" onClick={newTask} title="新建任务">
            <IconNew />
            <span className="lbl">新建任务</span>
            <span className="kbd">⌘K</span>
          </button>
          <button
            type="button"
            className={view === "skills" ? "nav-it on" : "nav-it"}
            onClick={() => setView("skills")}
            title="技能中心"
          >
            <IconSkills />
            <span className="lbl">技能中心</span>
          </button>
          <button
            type="button"
            className={view === "automations" ? "nav-it on" : "nav-it"}
            onClick={() => setView("automations")}
            title="自动化"
          >
            <IconClock />
            <span className="lbl">自动化</span>
          </button>
          <button
            type="button"
            className={view === "agents" ? "nav-it on" : "nav-it"}
            onClick={() => setView("agents")}
            title="智能体"
          >
            <IconAgent />
            <span className="lbl">智能体</span>
          </button>
          <button
            type="button"
            className={view === "knowledge" ? "nav-it on" : "nav-it"}
            onClick={() => setView("knowledge")}
            title="知识库"
          >
            <IconKnowledge />
            <span className="lbl">知识库</span>
          </button>
          <button
            type="button"
            className={view === "market" ? "nav-it on" : "nav-it"}
            onClick={() => setView("market")}
            title="插件市场"
          >
            <IconMarket />
            <span className="lbl">插件市场</span>
          </button>

          <section className="side-section recent-section">
            <header className="side-header">
              <span>任务</span>
            </header>
            {hostPhase !== "ok" ? <p className="side-muted">执行进程无响应</p> : null}
            {unscopedWorkSessions.length === 0 && runTabs.length === 0 ? (
              <p className="side-muted">暂无任务</p>
            ) : (
              <ul className="recent-list">
                {/* 进行中的自动化运行对话：每次运行在「任务」区新建一个对话。 */}
                {runTabs.map((tab) => {
                  const running = tab.automationId ? runningAutomationIds.has(tab.automationId) : false;
                  return (
                    <li key={tab.id}>
                      <button
                        type="button"
                        className={running ? "recent-item live-dot" : "recent-item"}
                        title={tab.label}
                        onClick={() => {
                          setView("main");
                          setActiveTab(tab.id);
                        }}
                      >
                        <span className="recent-title">{tab.label}</span>
                        <span className="recent-meta">自动化运行{running ? " · 运行中" : ""}{hostPhase !== "ok" ? " · 执行进程无响应" : ""}</span>
                      </button>
                    </li>
                  );
                })}
                {/* 未归属任何项目的 Work 会话（中立工作区里的任务对话），点击即恢复为可聊标签。 */}
                {unscopedWorkSessions.map((session, index) => {
                  const id = String(session.id ?? `work-session-${index}`);
                  const title = sessionTitleOf(session, id);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="recent-item"
                        title={`${title}\n${id}`}
                        onClick={() => void openFreeSession(id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setSessionMenu({ sessionId: id, x: event.clientX, y: event.clientY });
                        }}
                      >
                        <span className="recent-title">{title}</span>
                        <span className="recent-meta">{sessionMetaOf(session)}{hostPhase !== "ok" ? " · 执行进程无响应" : ""}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="side-section workspace-section">
            <header className="side-header">
              <span>项目</span>
              <button
                type="button"
                className="side-action"
                disabled={runningAutomationIds.size > 0 || sidecarDead}
                onClick={() => void createProjectFlow()}
              >
                ＋ 新建
              </button>
            </header>
            {hostPhase !== "ok" ? <p className="side-muted">执行进程无响应</p> : null}
            <ProjectsPanel
              projects={projects}
              activeProjectId={activeProjectId}
              subtasks={projectTasks}
              selectedTaskId={selectedTaskId}
              disabled={runningAutomationIds.size > 0 || sidecarDead || selectBusy}
              onOpened={(project, root) => void applyOpenedProject(project, root)}
              onChanged={() => {
                void refreshProjects();
                // 项目删除会级联清理其子任务与会话日志，同步刷新任务/会话快照，
                // 避免「任务」区残留幽灵条目（残留条目删除时会报 session was not found）。
                void refreshTasks();
                void refreshSessions();
              }}
              onCreateSubtask={(project) => createSubtask(project)}
              onSelectSubtask={(task) => void selectSubtask(task)}
              onRenameSubtask={(taskId, name) => renameSubtask(taskId, name)}
              onRemoveSubtask={(task) => removeSubtask(task)}
            />
          </section>

          <AccountFooter
            username={username}
            collapsed={collapsed}
            ready={ready}
            sidecarDead={sidecarDead}
            logoutDisabled={logoutDisabled}
            onOpenSettings={() => openSettings()}
            onLogout={() => void logout()}
          />
        </aside>

        <main className="main" aria-label="对话">
          {gitWarning ? <div className="banner warn">{gitWarning}</div> : null}
          {pluginFail ? <div className="banner error">{pluginFail}</div> : null}
          {guardModeError ? <div className="banner error">{guardModeError}</div> : null}
          {sessionFailed ? <div className="banner error">会话已失败。上次 diff 保留在右侧，本轮不再继续。</div> : null}
          {hostPhase !== "ok" ? (
            <div className="banner warn" role="status">
              执行进程无响应
              {hostPhase === "stoppable" ? (
                <button type="button" className="chip" onClick={() => void hostLivenessBridge()?.requestStop()}>
                  结束进程
                </button>
              ) : null}
            </div>
          ) : null}

          {view === "skills" ? (
            <SkillsView />
          ) : view === "automations" ? (
            <AutomationsView
              projects={projects}
              activeProjectId={activeProjectId}
              automations={automations}
              runs={automationRuns}
              runningIds={runningAutomationIds}
              enterIntent={automationEnter}
              onEnterIntentConsumed={() => setAutomationEnter(null)}
              onChanged={() => void refreshAutomations()}
              onAutomationCreated={() => setDraft("")}
              onWorkspaceAligned={(root) => {
                if (!root || workspaceRef.current === root) return;
                setWorkspace(root);
                workspaceRef.current = root;
                const owner = projects.find((project) => project.root === root);
                setActiveProjectId(owner?.id ?? null);
                activeProjectIdRef.current = owner?.id ?? null;
                if (!owner) setGitWarning("");
              }}
              keepAwake={keepAwake}
              onToggleKeepAwake={(next) => void toggleKeepAwake(next)}
              missedBanner={missedBannerView(missedBanner.count, missedBanner.dismissed)}
              onDismissMissedBanner={() => setMissedBanner((prev) => ({ ...prev, dismissed: true }))}
            />
          ) : view === "agents" ? (
            <AgentsView />
          ) : view === "knowledge" ? (
            <KnowledgeBaseView />
          ) : view === "market" ? (
            <MarketView />
          ) : historyView ? (
            <HistoryDetailPane
              view={historyView}
              busy={resumeBusy}
              onResume={() => void resumeHistorySession()}
              onClose={() => setHistoryView(null)}
            />
          ) : (
            <>
              <div className="chat-log">
                {chatEmpty ? (
                  <div className="hero">
                    <h1>
                      Coding <em>拯救世界</em>
                    </h1>
                    <p>本地模型驱动，一切都在你的机器上发生</p>
                    <div className="hero-suggestions">
                      {SUGGESTIONS.map((text) => (
                        <button
                          key={text}
                          type="button"
                          className="chip"
                          onClick={() => {
                            setDraft(text);
                            setSlashCursor(text.length);
                            setAtCursor(text.length);
                          }}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {items.map((item, index) => (
                  <ChatRow
                    key={item.id}
                    item={item}
                    blocked={blocked}
                    onAnswer={answer}
                    reasoning={item.kind === "assistant" ? (thinkingBefore(items, index)?.thought ?? "") : ""}
                    hasAssistantText={item.kind === "thinking" ? hasAssistantTextAfter(items, index) : false}
                  />
                ))}
                {showTurnLine ? (
                  <div className={turnLine.alert ? "banner warn" : "note"}>{turnLine.text}</div>
                ) : null}
                <div ref={chatEndRef} />
              </div>
            </>
          )}

          {view === "main" && !historyView ? (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {slashOpen ? (
                <SlashSkillMenu
                  skills={slashMatches}
                  activeIndex={slashIndex}
                  onHover={setSlashIndex}
                  onPick={pickSlashSkill}
                />
              ) : atOpen ? (
                <AtAgentMenu
                  agents={atMatches}
                  activeIndex={atIndex}
                  onHover={setAtIndex}
                  onPick={pickAtAgent}
                />
              ) : null}
              <textarea
                ref={composerRef}
                value={draft}
                rows={3}
                placeholder={
                  runTabLive
                    ? "后台任务运行中，请稍候再发送消息。"
                    : blocked
                      ? "sidecar 已退出"
                      : workspace
                        ? "描述你的任务… 输入 / 调用技能，输入 @ 点名智能体"
                        : "尽管问，或派个任务… 输入 / 调用技能，输入 @ 点名智能体"
                }
                disabled={blocked || runTabLive}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setSlashCursor(event.target.selectionStart);
                  setAtCursor(event.target.selectionStart);
                }}
                onClick={(event) => {
                  setSlashCursor(event.currentTarget.selectionStart);
                  setAtCursor(event.currentTarget.selectionStart);
                }}
                onKeyUp={(event) => {
                  setSlashCursor(event.currentTarget.selectionStart);
                  setAtCursor(event.currentTarget.selectionStart);
                }}
                onKeyDown={(event) => {
                  if (slashOpen) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setSlashIndex((index) => (slashMatches.length ? (index + 1) % slashMatches.length : 0));
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setSlashIndex((index) =>
                        slashMatches.length ? (index - 1 + slashMatches.length) % slashMatches.length : 0,
                      );
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSlashClosed(true);
                      return;
                    }
                    if (
                      (event.key === "Enter" || event.key === "Tab") &&
                      !event.nativeEvent.isComposing &&
                      slashMatches[slashIndex]
                    ) {
                      event.preventDefault();
                      pickSlashSkill(slashMatches[slashIndex]);
                      return;
                    }
                  } else if (atOpen) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setAtIndex((index) => (atMatches.length ? (index + 1) % atMatches.length : 0));
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setAtIndex((index) =>
                        atMatches.length ? (index - 1 + atMatches.length) % atMatches.length : 0,
                      );
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setAtClosed(true);
                      return;
                    }
                    if (
                      (event.key === "Enter" || event.key === "Tab") &&
                      !event.nativeEvent.isComposing &&
                      atMatches[atIndex]
                    ) {
                      event.preventDefault();
                      pickAtAgent(atMatches[atIndex]);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-bar">
                <button
                  type="button"
                  className="chip"
                  title={GUARD_MODE_LABELS[guardMode].tooltip}
                  onClick={() => requestGuardMode()}
                >
                  {GUARD_MODE_LABELS[guardMode].label}
                </button>
                {!workAllowNetwork ? (
                  <button
                    type="button"
                    className="chip static chip-offline"
                    title="Work 默认仅允许本机与局域网模型端点，禁止接入公网。可在 设置 → 权限 开启公网。"
                    onClick={() => openSettings("permissions")}
                  >
                    仅局域网
                  </button>
                ) : null}
                <button
                  type="button"
                  className={activeChat.pendingPick ? "chip pick" : "chip"}
                  title={
                    activeChat.pendingPick
                      ? "为新对话选择或新建项目"
                      : activeProject
                        ? `${activeProject.name}\n${activeProject.root}`
                        : workspace ?? "选择或新建项目"
                  }
                  onClick={() => setProjectPickerOpen(true)}
                >
                  {activeChat.pendingPick
                    ? "📁 选择项目"
                    : activeProject
                      ? `📁 ${activeProject.name}`
                      : workspace
                        ? `📁 ${workspaceName(workspace)}`
                        : "📁 选择项目"}
                </button>
                {modelLabel ? (
                  <ModelChip
                    label={modelLabel}
                    models={savedModels}
                    activeId={activeModelId}
                    onSelect={(id) => void selectModel(id)}
                    onManage={() => openSettings("model")}
                  />
                ) : null}
                {planModeActive(items) ? (
                  <button type="button" className="chip" disabled={blocked} onClick={() => void exitPlanMode()}>
                    退出计划模式
                  </button>
                ) : null}
                <span className="composer-spacer" />
                {turnActive ? (
                  <button type="button" className="send stop" disabled={blocked} onClick={() => void stopTurn()}>
                    停止
                  </button>
                ) : (
                  <button type="submit" className="send" aria-label="发送" disabled={blocked || runTabLive || !draft.trim() || hostPhase !== "ok"}>
                    ↑
                  </button>
                )}
              </div>
            </form>
          ) : null}
        </main>

        {showRightPane ? (
          <aside className="right-pane" aria-label="任务状态">
            <div className="right-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={rightTab === "preview"} className={rightTab === "preview" ? "on" : ""} onClick={() => setRightTab("preview")}>
                预览
              </button>
              <button type="button" role="tab" aria-selected={rightTab === "progress"} className={rightTab === "progress" ? "on" : ""} onClick={() => setRightTab("progress")}>
                进度
              </button>
              <button type="button" role="tab" aria-selected={rightTab === "files"} className={rightTab === "files" ? "on" : ""} onClick={() => setRightTab("files")} title="项目">
                项目
              </button>
              <button type="button" role="tab" aria-selected={rightTab === "diff"} className={rightTab === "diff" ? "on" : ""} onClick={() => setRightTab("diff")}>
                变更
              </button>
            </div>
            <div className="right-body">
              {rightTab === "preview" ? (
                <div className="panel-card">
                  <p className="h">预览</p>
                  <p className="panel-empty">AI 生成的摘要、代码片段等预览内容会显示在这里</p>
                </div>
              ) : null}
              {rightTab === "progress" ? (
                <div className="panel-card">
                  <p className="h">任务进度</p>
                  <p className="panel-empty">任务进度将显示在这里</p>
                </div>
              ) : null}
              {rightTab === "files" ? (
                <div className="panel-card project-tree-card">
                  <p className="h">项目</p>
                  {!workspace ? (
                    <p className="panel-empty">打开项目后，目录结构会显示在这里</p>
                  ) : projectTree === null ? (
                    <p className="panel-empty">正在读取目录…</p>
                  ) : projectTree.length === 0 ? (
                    <p className="panel-empty">{treeError || "目录为空"}</p>
                  ) : (
                    <div className="side-tree">
                      <div className="tree-root">
                        <span className="tree-root-name" title={workspace}>{workspaceName(workspace)}</span>
                      </div>
                      <ul className="tree">
                        {projectTree.map((node) => (
                          <TreeNodeItem key={node.path} node={node} />
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : null}
              {rightTab === "diff" ? (
                <>
                  <div className="panel-card" style={{ flex: "0 0 auto" }}>
                    <p className="h">变更 · Git diff</p>
                  </div>
                  <pre className="diff">{diff || "尚无 diff。最后一次 diff 事件会留在这里。"}</pre>
                </>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {sessionMenu ? (
        <div className="context-overlay" onClick={() => setSessionMenu(null)} onContextMenu={(event) => { event.preventDefault(); setSessionMenu(null); }}>
          <div
            className="context-menu"
            role="menu"
            aria-label="会话操作"
            style={{ left: Math.min(sessionMenu.x, window.innerWidth - 160), top: Math.min(sessionMenu.y, window.innerHeight - 130) }}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" className="context-menu-item" disabled title="即将上线">
              归档
            </button>
            <button type="button" role="menuitem" className="context-menu-item" disabled title="即将上线">
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-item danger"
              onClick={() => {
                setConfirmDelete(sessionMenu.sessionId);
                setDeleteError("");
                setSessionMenu(null);
              }}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}

      {guardModeConfirm ? (
        <div className="settings-overlay" role="dialog" aria-label="切换到完全访问确认">
          <div className="confirm-modal">
            <h3>切换到 完全访问</h3>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              所有操作将不再询问，仅保留硬性拒绝：工作区外读写、切换分支、未注册工具、灾难性命令。确定切换吗？
            </p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setGuardModeConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  const requested = guardModeConfirm;
                  setGuardModeConfirm(null);
                  void persistGuardMode(requested);
                }}
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="settings-overlay" role="dialog" aria-label="删除会话确认">
          <div className="confirm-modal">
            <h3>删除会话</h3>
            <p className="hint" style={{ margin: 0, fontWeight: 600, wordBreak: "break-all" }}>
              {(() => {
                const row = sessions.find(
                  (session, index) => String(session.id ?? `session-${index}`) === confirmDelete,
                );
                return row && typeof row.title === "string" && row.title ? row.title : confirmDelete;
              })()}
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 12, wordBreak: "break-all" }}>
              ID：{confirmDelete}
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              会话日志将从本机移除，此操作无法撤销。确定删除吗？
            </p>
            {deleteError ? <p className="banner error" style={{ borderRadius: 8 }}>{deleteError}</p> : null}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn"
                disabled={deleteBusy}
                onClick={() => {
                  setConfirmDelete(null);
                  setDeleteError("");
                }}
              >
                取消
              </button>
              <button type="button" className="btn danger" disabled={deleteBusy} onClick={() => void removeSession(confirmDelete)}>
                {deleteBusy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {projectPickerOpen ? (
        <div
          className="settings-overlay"
          role="dialog"
          aria-label="切换项目"
          onClick={() => setProjectPickerOpen(false)}
        >
          <div className="confirm-modal project-picker" onClick={(event) => event.stopPropagation()}>
            <h3>切换项目</h3>
            {projects.length === 0 ? (
              <p className="hint">还没有项目。选择一个文件夹创建新项目。</p>
            ) : (
              <ul className="project-picker-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={project.id === activeProjectId ? "picker-item active" : "picker-item"}
                      title={project.root}
                      onClick={() => {
                        setProjectPickerOpen(false);
                        void openProjectById(project.id);
                      }}
                    >
                      <span className="recent-title">{project.name}</span>
                      <span className="recent-meta">{projectRootName(project.root)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setProjectPickerOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setProjectPickerOpen(false);
                  void createProjectFlow();
                }}
              >
                ＋ 选择文件夹新建
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {creatingProject ? (
        <ProjectCreateModal
          root={creatingProject.root}
          defaultName={creatingProject.defaultName}
          busy={creatingBusy}
          error={creatingError}
          onCancel={() => {
            setCreatingProject(null);
            setCreatingError("");
          }}
          onConfirm={(name) => void confirmCreateProject(name)}
        />
      ) : null}

      {settingsOpen ? (
        <Settings
          onClose={() => { setSettingsOpen(false); void refreshModelLabel(); }}
          onModelsChange={hydrateModels}
          section={settingsSection}
          onSectionChange={setSettingsSection}
          theme={theme}
          onThemeChange={applyThemePref}
          username={username}
          onChangePassword={async (current, next) => {
            await rpcCall("auth.changePassword", { current, next });
          }}
          keepAwakeUnavailable={keepAwakeUnavailable}
        />
      ) : null}
    </div>
  );
}

function workspaceName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, "");
  const name = normalized.split(/[/\\]/).pop();
  return name || path;
}

/** 右侧面板「项目」页签的文件树节点：目录用 details/summary 展开/折叠，文件仅展示（样式与左侧边栏树一致）。 */
function TreeNodeItem({ node }: { node: TreeNode }) {
  if (node.isDir) {
    const children = node.children ?? [];
    if (children.length === 0) {
      return (
        <li>
          <span className="tree-dir-empty" title={node.path}>{node.name}</span>
        </li>
      );
    }
    return (
      <li>
        <details>
          <summary title={node.path}>{node.name}</summary>
          <ul>
            {children.map((child) => (
              <TreeNodeItem key={child.path} node={child} />
            ))}
          </ul>
        </details>
      </li>
    );
  }
  return (
    <li>
      <span className="tree-file" title={node.path}>{node.name}</span>
    </li>
  );
}

/** 子任务默认名：「子任务 N」，N 取首个与已有名字不冲突的编号。 */
function nextSubtaskName(existing: TaskInfo[]): string {
  const names = new Set(existing.map((task) => task.name));
  let seq = existing.length + 1;
  while (names.has(`子任务 ${seq}`)) seq += 1;
  return `子任务 ${seq}`;
}

/** 列表标题：优先摘要标题，老 sidecar 无摘要时回退会话 ID。 */
function sessionTitleOf(session: SessionRow, fallback: string): string {
  if (typeof session.title === "string" && session.title.trim()) return session.title;
  return fallback;
}

/** 列表副行：最近活动时间 · 工作区目录 · 子代理标记。 */
function sessionMetaOf(session: SessionRow): string {
  const parts: string[] = [];
  const time = typeof session.lastTime === "number" ? session.lastTime : session.createdAt;
  if (typeof time === "number" && Number.isFinite(time)) parts.push(formatSessionTime(time));
  if (typeof session.cwd === "string" && session.cwd) parts.push(workspaceName(session.cwd));
  if (session.origin === "subagent") parts.push("子代理");
  return parts.join(" · ");
}

function handleEvent(
  event: RpcEvent,
  allocId: () => number,
  setReady: (ready: boolean) => void,
  setItems: (updater: (prev: ChatItem[]) => ChatItem[], sessionId?: string) => void,
  setDiff: (text: string) => void,
  setTurnActive: (active: boolean) => void,
  setSessionFailed: (failed: boolean, sessionId?: string) => void,
  refreshRecent: () => Promise<void>,
  sawReady: MutableRefObject<boolean>,
) {
  switch (event.event) {
    case "sidecar/status":
      setReady(event.ready);
      if (event.ready) {
        sawReady.current = true;
        void refreshRecent();
      }
      break;
    case "token":
      setItems((prev) => appendToken(prev, event.text), event.sessionId);
      break;
    case "reasoning":
      setItems((prev) => applyReasoning(prev, event.text, event.final === true, allocId), event.sessionId);
      break;
    case "tool/start":
      if (event.name === "todo_write" && event.todos) {
        const todos = event.todos;
        setItems((prev) => upsertTodoItem(prev, todos, allocId), event.sessionId);
        break;
      }
      setItems((prev) => [
        ...prev,
        {
          id: allocId(),
          kind: "tool",
          card: {
            key: event.callId ?? `${event.name}-${prev.length}`,
            name: event.name,
            callId: event.callId,
            status: "start",
            ...(event.command === undefined ? {} : { command: event.command }),
          },
        },
      ], event.sessionId);
      break;
    case "tool/end":
      setItems((prev) =>
        prev.map((item) => {
          if (item.kind !== "tool") return item;
          const match = event.callId
            ? item.card.callId === event.callId
            : item.card.name === event.name && item.card.status === "start";
          return match
            ? { ...item, card: { ...item.card, status: "end", truncated: event.truncated, ...(event.isError ? { isError: true } : {}) } }
            : item;
        }),
        event.sessionId,
      );
      break;
    case "approval/asked": {
      const ask: ChatItem = {
        id: allocId(),
        kind: "ask",
        card: {
          approvalRequestId: event.approvalRequestId,
          toolName: event.toolName,
          callId: event.callId,
          reason: event.reason,
          summary: event.summary,
          autoContinue: event.autoContinue,
        },
      };
      setItems((prev) => (event.toolName === "plan-review" ? insertBeforeToolRow(prev, ask, event.callId) : [...prev, ask]), event.sessionId);
      break;
    }
    case "diff":
      setDiff(event.text);
      break;
    case "session/end":
      setTurnActive(false);
      // 回合结束刷新会话列表（任务区/最近对话）。日志写回是 ~200ms 批处理，
      // 等一拍再拉，避免新会话因 messageCount 仍为 0 被空壳过滤漏掉。
      setTimeout(() => void refreshRecent(), 600);
      if (event.cancelled || !event.ok) {
        setItems((prev) => interruptCurrentTurn(prev), event.sessionId);
      }
      if (event.cancelled) break;
      if (!event.ok) {
        setSessionFailed(true, event.sessionId);
        setItems((prev) => [
          ...prev,
          { id: allocId(), kind: "note", text: event.error ?? "会话失败（保留 diff，不回滚）" },
        ], event.sessionId);
      }
      break;
  }
}

/** 本回合只保留最新一份待办列表（todo_write 每次发送完整替换列表）。 */
function upsertTodoItem(items: ChatItem[], todos: TodoEntry[], allocId: () => number): ChatItem[] {
  let turnStart = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === "user") {
      turnStart = i + 1;
      break;
    }
  }
  const at = items.findIndex((item, index) => index >= turnStart && item.kind === "todo");
  if (at < 0) return [...items, { id: allocId(), kind: "todo", todos }];
  return items.map((item, index) => (index === at ? { ...item, todos } : item));
}

/** 取消或失败时，本回合已出现的思考面板标题改为「思考 · 已中断」。成功结束保持「已生成」。 */
function interruptCurrentTurn(items: ChatItem[]): ChatItem[] {
  let turnStart = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === "user") {
      turnStart = i + 1;
      break;
    }
  }
  let changed = false;
  const next = items.map((item, index) => {
    if (index < turnStart) return item;
    if (item.kind === "thinking" && !item.interrupted) {
      changed = true;
      return { ...item, interrupted: true };
    }
    if (item.kind === "assistant" && item.interrupted !== true) {
      changed = true;
      return { ...item, interrupted: true };
    }
    return item;
  });
  return changed ? next : items;
}

/** 计划卡画在本回合 `exit_plan_mode` 那一行工具之前；找不到那一行就追加在末尾。 */
function insertBeforeToolRow(items: ChatItem[], card: ChatItem, callId: string | undefined): ChatItem[] {
  let turnStart = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === "user") {
      turnStart = i + 1;
      break;
    }
  }
  const at = items.findIndex(
    (item, index) =>
      index >= turnStart &&
      item.kind === "tool" &&
      (callId ? item.card.callId === callId : item.card.name === "exit_plan_mode"),
  );
  return at >= 0 ? [...items.slice(0, at), card, ...items.slice(at)] : [...items, card];
}

/** 进入计划模式由 `propose_plan` 完成；计划被同意或用户点了「退出计划模式」后离开。 */
function planModeActive(items: readonly ChatItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "note" && item.text === PLAN_EXITED_NOTE) return false;
    if (item.kind === "ask" && item.card.toolName === "plan-review") {
      return !(item.card.autoContinue || item.card.answered === "approve");
    }
    if (item.kind === "tool" && item.card.name === "propose_plan") return true;
  }
  return false;
}

function appendToken(items: ChatItem[], text: string): ChatItem[] {
  const last = items.at(-1);
  if (last?.kind === "assistant") {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { id: (last?.id ?? 0) + 1, kind: "assistant", text }];
}

/** 同一回合只保留一块思考：非 final 追加草稿，final 用全文覆盖，不另起一块。 */
function applyReasoning(items: ChatItem[], text: string, final: boolean, allocId: () => number): ChatItem[] {
  let turnStart = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === "user") {
      turnStart = i + 1;
      break;
    }
  }
  const existing = items.findIndex((item, index) => index >= turnStart && item.kind === "thinking");
  if (existing >= 0) {
    const current = items[existing];
    if (current?.kind !== "thinking") return items;
    const next = items.slice();
    next[existing] = { ...current, thought: final ? text : current.thought + text };
    return next;
  }
  const created: ChatItem = { id: allocId(), kind: "thinking", thought: text, interrupted: false };
  const assistantAt = items.findIndex((item, index) => index >= turnStart && item.kind === "assistant");
  if (assistantAt >= 0) return [...items.slice(0, assistantAt), created, ...items.slice(assistantAt)];
  return [...items, created];
}

function ChatRow({
  item,
  blocked,
  onAnswer,
  reasoning = "",
  hasAssistantText = false,
}: {
  item: ChatItem;
  blocked: boolean;
  onAnswer: (card: AskCard, decision: "approve" | "reject") => void;
  reasoning?: string;
  hasAssistantText?: boolean;
}) {
  if (item.kind === "user") return <div className="bubble user">{item.text}</div>;
  if (item.kind === "thinking") {
    if (!shouldRenderThinking(item.thought)) return null;
    return (
      <ThinkingPanel
        thought={item.thought}
        hasAssistantText={hasAssistantText}
        interrupted={item.interrupted}
      />
    );
  }
  if (item.kind === "assistant") {
    const resolved = resolveThinking({ reasoning, assistantText: item.text });
    const visible = resolved.visible;
    const answerReady = visible.trim().length > 0;
    const panelThought = reasoning.trim().length > 0 ? "" : resolved.thought;
    if (!shouldRenderThinking(panelThought) && !answerReady) return null;
    return (
      <>
        {shouldRenderThinking(panelThought) ? (
          <ThinkingPanel thought={panelThought} hasAssistantText={answerReady} interrupted={item.interrupted === true} />
        ) : null}
        {answerReady ? <div className="bubble assistant">{visible}</div> : null}
      </>
    );
  }
  if (item.kind === "note") return <div className="note">{item.text}</div>;
  if (item.kind === "todo") {
    return (
      <div className="card todo-card">
        <span className="ttl">待办</span>
        {item.todos.map((todo) => (
          <div key={todo.content} className={todo.status === "completed" ? "muted" : undefined}>
            <span className="badge">{todoLabel(todo.status)}</span> {todo.content}
          </div>
        ))}
      </div>
    );
  }
  if (item.kind === "tool") {
    return (
      <div className={item.card.status === "start" ? "tool-row running" : "tool-row"}>
        <span className="tool-icon">{item.card.status === "start" ? "●" : "✓"}</span>
        <strong>{item.card.name}</strong>
        <span className="muted">{item.card.status === "start" ? "运行中" : "结束"}</span>
        {item.card.truncated ? <span className="badge">truncated</span> : null}
      </div>
    );
  }
  if (item.card.toolName === "plan-review") return <PlanCard card={item.card} blocked={blocked} onAnswer={onAnswer} />;
  return (
    <div className="card ask-card">
      <span className="ttl">✋ 批准请求 · {item.card.toolName}</span>
      {item.card.summary ? <pre>{item.card.summary}</pre> : null}
      {item.card.reason ? <p style={{ margin: 0 }}>{item.card.reason}</p> : null}
      <p className="muted" style={{ margin: 0 }}>
        {item.card.approvalRequestId}
      </p>
      {item.card.answered ? (
        <p style={{ margin: 0 }}>{item.card.answered === "approve" ? "已批准" : "已拒绝"}</p>
      ) : (
        <div className="row">
          <button type="button" className="btn approve" disabled={blocked} onClick={() => onAnswer(item.card, "approve")}>
            批准
          </button>
          <button type="button" className="btn reject" disabled={blocked} onClick={() => onAnswer(item.card, "reject")}>
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

/** 「按这个计划执行」「继续改计划」走同一张审批卡的批准 / 拒绝，宿主把它们答成官方 plan-review 的同意与继续计划。 */
function PlanCard({
  card,
  blocked,
  onAnswer,
}: {
  card: AskCard;
  blocked: boolean;
  onAnswer: (card: AskCard, decision: "approve" | "reject") => void;
}) {
  return (
    <div className="card ask-card">
      <span className="ttl">计划</span>
      {card.summary ? <pre>{card.summary}</pre> : null}
      <p style={{ margin: 0 }}>{PLAN_CARD_NOTE}</p>
      {card.autoContinue ? (
        <p style={{ margin: 0 }}>{AUTO_CONTINUE_LABEL}</p>
      ) : card.answered ? (
        <p style={{ margin: 0 }}>{card.answered === "approve" ? "已按这个计划执行" : "继续改计划"}</p>
      ) : (
        <div className="row">
          <button type="button" className="btn approve" disabled={blocked} onClick={() => onAnswer(card, "approve")}>
            按这个计划执行
          </button>
          <button type="button" className="btn reject" disabled={blocked} onClick={() => onAnswer(card, "reject")}>
            继续改计划
          </button>
        </div>
      )}
    </div>
  );
}

function thinkingBefore(items: readonly ChatItem[], index: number): Extract<ChatItem, { kind: "thinking" }> | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "user") return undefined;
    if (item.kind === "thinking") return item;
  }
  return undefined;
}

function runningToolName(items: readonly ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || item.kind === "user") return null;
    if (item.kind === "tool" && item.card.status === "start") return item.card.name;
  }
  return null;
}

function activityKind(event: RpcEvent): "reasoning" | "text" | "tool" | null {
  if (event.event === "reasoning") return "reasoning";
  if (event.event === "token") return "text";
  if (event.event === "tool/end") return "tool";
  return null;
}
