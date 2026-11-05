import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import AccountFooter from "./AccountFooter.tsx";
import AgentConfirmCard from "./AgentConfirmCard.tsx";
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
  modelDisplayName,
  resolveSendModelId,
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
import SubagentRunCard from "./SubagentRunCard.tsx";
import {
  isReservedSlash,
  parseSlashInvoke,
  slashSkills,
  slashTokenAt,
  type SkillInfo,
} from "./logic/skillsLogic.ts";
import type {
  AgentPackageConfirmCard,
  SubagentCancelResult,
  SubagentRunProjection,
  SubagentRunSnapshot,
} from "./rpc-types.ts";
import {
  insertSubagentRunCard,
  isSubagentRunActive,
  parentTurnLine,
  reduceSubagentRuns,
  subagentNeedsStartTime,
  type SubagentRunEvent,
  type SubagentRunsState,
  type SubagentRunView,
} from "./logic/subagentRuns.ts";
import {
  atAgents,
  atTokenAt,
  parseAtInvoke,
  type AgentListItem,
} from "./logic/agentsLogic.ts";
import {
  applyHtmlTheme,
  parseTheme,
  persistThemeMirror,
  resolveTheme,
  type ThemePref,
} from "./logic/accountStatus.ts";
import { AUTO_CONTINUE_LABEL, PLAN_CARD_NOTE, planExitNote, planModeActive } from "./logic/planConfirm.ts";
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
  setTaskModel,
  stopAutomation,
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
import {
  hasAssistantTextAfter,
  interruptTurnItems,
  nextThinkingSteps,
  resolveThinking,
  shouldRenderThinking,
  thinkingStepsText,
  withThinkingToggle,
  type ThinkingSteps,
} from "./logic/thinkingPanel.ts";
import {
  appendOpenInput,
  closeOpenInputs,
  dispatchComposerSubmission,
  inputCardStatus,
  latestOpenInput,
  settleInputCard,
  type InputCard,
} from "./logic/inputCard.ts";
import {
  applyToolEnd,
  applyTurnFinalToTabs,
  currentTurnStart,
  historicalTurnFinalByUserId,
  projectToolPanels,
  runningToolName,
  toolsUnconfirmed,
  withToolPanelToggle,
  type PanelToggle,
  type TurnFinalEvent,
} from "./logic/toolPanel.ts";
import {
  answerApprovalInTabs,
  askCardWaitsForClick,
  closeRunTabsForSession,
  hasPendingAsk,
  resolveActiveTab,
  type ApprovalCardView,
} from "./logic/chatTabs.ts";
import { canStartStop, consumeStaleIdle, finishStop, isStopPending, rememberStale, sessionStopRequested, takeHeldEnds, type StopTicket, type StaleIdle } from "./logic/stopGate.ts";
import {
  isUnstartedUserItem,
  noteDiffForTab,
  noteSendResult,
  noteTurnEnded,
  noteWaitingCancelled,
  noteWaitingFailed,
  noteWaitingStarted,
  releaseWaitingItem,
  sendOpensTurn,
  type TabRunState,
} from "./logic/concurrentTurn.ts";
import {
  HOST_UNRESPONSIVE_TEXT,
  clearFailuresInTabs,
  hostExitNotice,
  hostLivenessNotice,
  type HostLivenessPhase,
} from "./logic/hostStop.ts";
import { resolveStopSession, turnStatus } from "./logic/turnStatus.ts";
import {
  WORKSPACE_SCAN_DEPTH,
  appendOutcomeNotes,
  eventTargetTab,
  latestUserItemId,
  lookupSessionCwd,
  outcomeTargetTab,
  outcomeWorkspace,
  shouldCheckTurnOutcome,
  todoLabel,
  turnChecks,
  turnGaps,
  turnOutcomeNotes,
  type TodoEntry,
} from "./logic/outcomeCheck.ts";
import {
  INITIAL_GOAL_TURN_STATE,
  goalRoundLabel,
  goalRoundStopped,
  reduceGoalTurn,
  type GoalTurnAction,
  type GoalTurnEvent,
  type GoalTurnState,
} from "./logic/goalRound.ts";
import {
  dropRunningRunIds,
  isRunTabLive,
  runEndNeedsFailureNotice,
  runResultNoteText,
  runTabsToRebuild,
  sessionsToSuppressAfterDelete,
  settleRunningRuns,
} from "./logic/runTabsLogic.ts";
import {
  RESULT_ATTACHMENT_FILES,
  attachmentAsAssistant,
  foldRunAssistantItems,
  type ResultAttachmentFile,
} from "./logic/runResultAttachments.ts";
import { renderResultHtml, renderResultMarkdown } from "./logic/runResultRender.ts";
import { ThinkingPanel } from "./ThinkingPanel.tsx";
import ToolPanel from "./ToolPanel.tsx";

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
  /** 超长工具输出裁成头尾之后的正文，对话里直接显示。 */
  output?: string;
  /** 参数摘要（单行、限长）；实时事件与会话历史共用同一格式化规则。 */
  args?: string;
  /** bash / pwsh 的 command 参数与结果是否出错：回合结束核对「要求的命令」用。 */
  command?: string;
  isError?: boolean;
  /** 该工具已收到结果（成功或失败），面板据此区分「结果缺失」。 */
  hasResult?: boolean;
  /** 回合在工具结束前中断：不当作失败，单独标记。 */
  interrupted?: boolean;
  /** 已确定 turnFinal 的正常回合结束时仍未收到终态：面板不宣称成功或失败。 */
  unconfirmed?: boolean;
  /** 历史恢复时只有调用记录、没有可配对结果记录。 */
  resultMissing?: boolean;
};

/** 审批卡 = 逻辑层展示形状（answered/autoContinue/actionable）+ App 侧的原因、摘要与调用标识。 */
type AskCard = ApprovalCardView & {
  approvalRequestId: string;
  toolName: string;
  reason?: string;
  callId?: string;
  summary?: string;
};

type ChatItem =
  | {
      id: number;
      kind: "user";
      text: string;
      /** 排队中、尚未开始执行的本次发送；由 `session.send` 的应答写回。 */
      queueItemId?: string;
      /** 本次 `session.send` 已抛错且未启动；只在本标签内标记。 */
      sendRejected?: boolean;
      /** 宿主应答 `started: false`，或排队项出队失败/被取消：这条消息没有开启回合。 */
      notStarted?: boolean;
    }
  | { id: number; kind: "assistant"; text: string; interrupted?: boolean; userToggled?: "expand" | "collapse" }
  | { id: number; kind: "thinking"; thought: string; interrupted: boolean; historical?: boolean; steps?: ThinkingSteps; userToggled?: "expand" | "collapse" }
  | { id: number; kind: "tool"; card: ToolCard; panelToggled?: "expand" | "collapse" }
  | { id: number; kind: "todo"; todos: TodoEntry[] }
  | { id: number; kind: "ask"; card: AskCard }
  | { id: number; kind: "input"; card: InputCard }
  | { id: number; kind: "attachment"; sourceText: string }
  | { id: number; kind: "agent-confirm"; card: AgentPackageConfirmCard }
  | { id: number; kind: "subagent-run"; runId: string }
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
  /** 右侧「预览」打开的结果附件（规格 §5）：选择记在标签上，换标签再回来沿用该标签上次的选择。 */
  previewFile?: ResultAttachmentFile;
  /** 每个用户消息回合是否已终结（按用户消息条目 id 归因）；面板据此区分「进行中」与「中断」。 */
  turnFinalByUserId?: Readonly<Record<number, boolean>>;
  /** 没有用户消息条目的标签（自动化运行记录等）用同一个合成回合结算。 */
  turnFinalWithoutUser?: boolean;
};

type SessionMenu = { sessionId: string; x: number; y: number };

/** 回合进度的最近一次活动种类：思考、正文、工具结果或静默。 */
type PulseKind = "reasoning" | "text" | "tool" | "quiet";

/**
 * 一条标签自己的回合身份与停止票据。另一个标签开始回合不会改动这份记录，
 * 因此 A 的停止请求在飞时 B 仍可独立发起停止。
 */
type TabTurn = {
  /** 本标签正在跟踪的会话；没有回合或回合被取消后为 null。 */
  sessionId: string | null;
  /** 本标签的回合代际：只有本标签真正开始新回合才 +1。 */
  epoch: number;
  /** 本标签活动回合的用户消息 id；终态结算落到它。 */
  activeUserId: number | null;
  /** 取消请求尚未返回。这期间的 session/end 先搁下，返回后才决定算不算用户停止。 */
  pending: StopTicket | null;
  /** 用户已停止、闩锁仍扣着的会话。 */
  stopSessionId: string | null;
  latchOwner: number | null;
  stopping: boolean;
};

const IDLE_TAB_TURN: TabTurn = {
  sessionId: null,
  epoch: 0,
  activeUserId: null,
  pending: null,
  stopSessionId: null,
  latchOwner: null,
  stopping: false,
};

/** 没有回合记录的标签按空闲处理；`waitingIds` 只在事件闭包里由发送应答追加。 */
const IDLE_TAB_RUN: TabRunState = { running: false, waitingIds: [] };

/** `session.send` 的应答：排队只占位，`started: true` 才真正开始执行。 */
type SessionSendResult = {
  queued?: boolean;
  waiting: boolean;
  started: boolean;
  sessionId?: string;
  queueItemId?: string;
};

/**
 * 一次 `session.send` 在应答回来之前的身份与早到事件。fetch 应答与 WebSocket 事件
 * 不保证先后，所以发送前先记下标签与本地消息 id，把还不能结算的事件按到达顺序暂存。
 */
type PendingSend = {
  tabId: string;
  /** 本次插入的用户消息 id；等待项与回合身份都按它回写。 */
  userId: number;
  /** 发送前已知道的会话 id；没有它的发送无法匹配早到事件。 */
  sessionId?: string;
  /** 应答回来之前到达、尚不能结算的事件，按到达顺序。 */
  buffered: RpcEvent[];
};

type View = "main" | "skills" | "automations" | "agents" | "knowledge" | "market";
export type RightTab = "preview" | "progress" | "files" | "diff";
type AuthPhase = "unknown" | "needs-register" | "logged-out" | "logged-in";

const SUGGESTIONS = ["修掉这个仓库里失败的测试", "解释这个仓库的整体结构", "把最近的改动整理成一次 commit"];

/** 子代理 run 的初始客户端状态;reducer 只读入参,可安全共享。 */
const INITIAL_SUBAGENT_RUNS: SubagentRunsState = { revision: 0, runs: new Map(), connection: "live" };

/** snapshot 对账失败后只重试一次(设计 D6),间隔与 WS 重连首档退避同量级。 */
const SUBAGENT_RECONCILE_RETRY_MS = 1_000;

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
  /** 智能体包/目录写入事件计数：智能体页据此重拉各面板数据。 */
  const [agentChangeSignal, setAgentChangeSignal] = useState(0);
  const [atCursor, setAtCursor] = useState(0);
  const [atIndex, setAtIndex] = useState(0);
  const [atClosed, setAtClosed] = useState(false);
  /** 差异按标签保存：有会话 id 时只写它绑定的标签，当前标签读到的是自己的那份。 */
  const [diffsByTab, setDiffsByTab] = useState<Readonly<Record<string, string>>>({});
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
  /**
   * 每个标签的回合执行状态（`running` + 等待项）。界面读 state；事件闭包读镜像 ref，
   * 由 `writeTabRun` 同步写两处，避免同一批事件里读到上一次渲染的快照。
   */
  const [tabRuns, setTabRuns] = useState<Readonly<Record<string, TabRunState>>>({});
  const tabRunsRef = useRef<Record<string, TabRunState>>({});
  const [inputReplyPending, setInputReplyPending] = useState(false);
  const [hostPhase, setHostPhase] = useState<HostLivenessPhase>("ok");
  /**
   * 套接字关闭回调只挂载一次，读不到最新的 hostPhase；用户主动停止的标记放在
   * ref 里，close 时据此给中性脚注而不是把标签标成失败。
   */
  const hostStoppedByUserRef = useRef(false);
  /** 每个标签最近一次 reasoning 增量、正文增量或工具结果的时间。句子只由 turnStatus 算出。 */
  const [turnPulseByTab, setTurnPulseByTab] = useState<
    Readonly<Record<string, { latest: PulseKind; at: number }>>
  >({});
  const [now, setNow] = useState(() => Date.now());
  /** 子代理 run 的权威客户端投影(设计 D6–D8);UI 展开/确认态留在下方独立 state。 */
  const [subagentRuns, setSubagentRuns] = useState<SubagentRunsState>(INITIAL_SUBAGENT_RUNS);
  /** reducer 状态镜像:挂载期注册的事件闭包据此读取最新 run(取消确认、对账)。 */
  const subagentRunsRef = useRef<SubagentRunsState>(INITIAL_SUBAGENT_RUNS);
  /** 对账代际:断连与 ready 都推进它,迟到的 snapshot 应答据此丢弃(设计 D6)。 */
  const reconcileEpochRef = useRef(0);
  const [expandedByRunId, setExpandedByRunId] = useState<Record<string, boolean>>({});
  const [confirmingRunId, setConfirmingRunId] = useState<string | null>(null);
  const [cancelBusyByRunId, setCancelBusyByRunId] = useState<Record<string, boolean>>({});
  const [cancelErrorByRunId, setCancelErrorByRunId] = useState<Record<string, string>>({});
  /**
   * 每条标签自己的回合身份与停止票据；进程里不再有唯一的回合槽。
   * 界面只看 `tabRuns`（执行态）与 `turnPulseByTab`（进度），事件闭包读这份 ref。
   */
  const tabTurnsRef = useRef<Record<string, TabTurn>>({});
  /**
   * 在飞的发送：按标签各存一份（同一标签在飞时不会二次发送）。应答回来前到达的
   * 早到事件暂存在这里，等身份写回后按原顺序重放。
   */
  const pendingSendsRef = useRef<Map<string, PendingSend>>(new Map());
  /** 每个标签最近一条 `agent/notice` 的原文：queue-fail 与它同因时不再插第二条脚注。 */
  const lastAgentNoticeRef = useRef<Record<string, string>>({});
  /**
   * 等待项与它挂的那条用户消息的对应关系。应答写回 `queueItemId` 与随后的重放
   * 在同一批同步更新里，`chatTabsRef` 这时还看不到新状态，故用这张表做权威索引。
   */
  const queueOwnersRef = useRef<Map<string, { tabId: string; userId: number }>>(new Map());
  /** 目标相位 + 每回合结论闸门；状态机本身在 logic/goalRound.ts，便于脱离界面单测。 */
  const goalTurnRef = useRef<GoalTurnState>(INITIAL_GOAL_TURN_STATE);
  /** 停止票据编号：跨标签唯一，用来区分先后两次取消。 */
  const stopSeqRef = useRef(0);
  /** 停止对应的那条空闲结束。用户已经发出更新的一轮时，这条结束不能写进新消息。 */
  const staleIdleRef = useRef<StaleIdle[]>([]);
  const heldEndsRef = useRef<RpcEvent[]>([]);
  const applySidecarEventRef = useRef<(event: RpcEvent) => void>(() => {});
  const [activeTab, setActiveTab] = useState<string>("work-1");
  /** 当前标签的稳定引用：挂载期注册的事件闭包用它判断改动是否落在可见标签上。 */
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    const next = resolveActiveTab(activeTab, chatTabs);
    if (next !== activeTab) setActiveTab(next);
  }, [activeTab, chatTabs]);
  const [historyView, setHistoryView] = useState<SessionLogView | null>(null);
  const [sessionMenu, setSessionMenu] = useState<SessionMenu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [savedModels, setSavedModels] = useState<ModelEntry[]>([]);
  const [activeModelId, setActiveModelId] = useState("");
  /** 发送区按标签记录的模型选择；未选择的标签回落到子任务模型或全局当前模型。 */
  const [modelPickByTab, setModelPickByTab] = useState<Readonly<Record<string, string>>>({});
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
  /**
   * 在途运行按 runId 记账（run-start 加入 / run-end 只删自己的 runId）。
   * 任务级「运行中」集合由它派生：同一任务的两条并发脚本运行，任意一条结束
   * 都不会提前摘掉任务行的「停止」。
   */
  const [runningRuns, setRunningRuns] = useState<ReadonlyMap<string, { automationId: string }>>(new Map());
  /**
   * 删过运行记录后要抑制重建的会话 id（规格 §6；只在本次会话有效，重启清空）。
   * 刷新任务列表时传给 runTabsToRebuild，避免刚删掉的运行又以骨架标签回来。
   */
  const suppressedRunSessionIdsRef = useRef<Set<string>>(new Set());
  /** Task 11：运行对话停止请求在飞——state 管按钮禁用，ref 挡同一批事件里的第二次点击。 */
  const [stopRunPending, setStopRunPending] = useState(false);
  const stopRunInFlight = useRef(false);
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
  /** 中立根（未归属项目的「任务」会话目录）。宿主没有只读查询，经 workspace.close 取到后缓存。 */
  const neutralRootRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionRow[]>([]);
  /** session.new 返回的目录。列表刷新晚于回合结束，核对先用这份。 */
  const sessionCwdRef = useRef(new Map<string, string>());
  function rememberMinted(minted: { sessionId?: string; cwd?: string }) {
    if (typeof minted.sessionId === "string" && minted.sessionId && typeof minted.cwd === "string" && minted.cwd) {
      sessionCwdRef.current.set(minted.sessionId, minted.cwd);
    }
  }
  const nextId = useRef(1);
  /** 在途发送按标签 id 记录：只挡同一标签的重入，不挡另一个标签。 */
  const sendingRef = useRef<Set<string>>(new Set());
  const inputReplyPendingRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * 最近一次发送或新建的标签：只用于「事件没有会话 id」时的回落标签。
   * 回合身份按标签各存一份（`tabTurnsRef`），这里不再代表唯一的回合槽。
   */
  const liveChatRef = useRef("work-1");
  const nextChatSeq = useRef(2);
  const newTaskRef = useRef<() => void>(() => undefined);
  const authPhaseRef = useRef(authPhase);
  const pullAuthStatusRef = useRef<() => void>(() => undefined);
  /** chatTabs 的稳定引用：事件回调（挂载期注册，deps 为 []）按 sessionId 查找目标标签用。 */
  const chatTabsRef = useRef<ChatTab[]>([]);

  function tabRunOf(tabId: string): TabRunState {
    return tabRunsRef.current[tabId] ?? IDLE_TAB_RUN;
  }

  /**
   * 写一个标签的回合执行状态：ref 立即生效（同一批事件读到最新值），state 触发渲染。
   * 状态没变时返回入参本身，不制造无谓的重渲染。
   */
  function writeTabRun(tabId: string, update: (prev: TabRunState) => TabRunState): void {
    const prev = tabRunOf(tabId);
    const next = update(prev);
    if (next === prev) return;
    const runs = { ...tabRunsRef.current, [tabId]: next };
    tabRunsRef.current = runs;
    setTabRuns(runs);
  }

  function tabTurnOf(tabId: string | null | undefined): TabTurn {
    const own = tabId === null || tabId === undefined ? undefined : tabTurnsRef.current[tabId];
    return own ?? IDLE_TAB_TURN;
  }

  function patchTabTurn(tabId: string, patch: Partial<TabTurn>): void {
    tabTurnsRef.current = { ...tabTurnsRef.current, [tabId]: { ...tabTurnOf(tabId), ...patch } };
  }

  /** 持有该等待项的用户消息所在标签；找不到时返回 undefined。 */
  function queueItemTab(queueItemId: string): string | undefined {
    if (!queueItemId) return undefined;
    const owner = queueOwnersRef.current.get(queueItemId);
    if (owner !== undefined) return owner.tabId;
    return chatTabsRef.current.find((tab) =>
      tab.items.some((item) => item.kind === "user" && item.queueItemId === queueItemId),
    )?.id;
  }

  /**
   * 标签被删除、子任务或会话被清理时，一并丢掉它的在途发送与排队归属。
   * 留下这些记录会让迟到的 queue-start 命中一个已不存在的标签，把执行态卡成 `running`。
   */
  function pruneTabBookkeeping(tabId: string): void {
    pendingSendsRef.current.delete(tabId);
    for (const [queueItemId, owner] of queueOwnersRef.current) {
      if (owner.tabId === tabId) queueOwnersRef.current.delete(queueItemId);
    }
  }

  function pendingSendOfTab(tabId: string): PendingSend | undefined {
    return pendingSendsRef.current.get(tabId);
  }

  function pendingSendOfSession(sessionId: string | undefined): PendingSend | undefined {
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    for (const pending of pendingSendsRef.current.values()) {
      if (pending.sessionId === sessionId) return pending;
    }
    return undefined;
  }

  /**
   * 回合真正开始的唯一初始化点：直接 `started: true` 的应答与 `session/queue-start`
   * 都走这里。只推进本标签自己的 epoch，并记下这次的活动用户消息。
   */
  function openTurnForTab(tabId: string, sessionId: string | null, userId: number): void {
    patchTabTurn(tabId, {
      epoch: tabTurnOf(tabId).epoch + 1,
      sessionId,
      activeUserId: userId,
      stopping: false,
      stopSessionId: null,
      latchOwner: null,
    });
    // 新用户回合重新开结算窗口：上一回合的「结论已写」不能挡住这一回合。
    goalTurnRef.current = reduceGoalTurn(goalTurnRef.current, {
      kind: "turn-started",
      ...(sessionId === null ? {} : { sessionId }),
    }).state;
    const at = Date.now();
    setTurnPulseByTab((prev) => ({ ...prev, [tabId]: { latest: "quiet", at } }));
    setNow(at);
  }

  /**
   * 撤掉该等待项的等待文案；返回它挂的那条用户消息 id。
   * `outcome` 说明等待项的结局：`"started"` 是出队开始执行，消息成为活动回合；
   * `"unstarted"` 是出队失败或被用户取消，消息留在列表里但仍算未启动，
   * 不会去抢上一回合的终态与 outcome。
   */
  function clearQueueItem(
    tabId: string,
    queueItemId: string,
    outcome: "started" | "unstarted" = "started",
  ): number | undefined {
    const owner = queueOwnersRef.current.get(queueItemId);
    const scan = chatTabsRef.current
      .find((item) => item.id === tabId)
      ?.items.find((item) => item.kind === "user" && item.queueItemId === queueItemId);
    const userId = owner?.userId ?? (scan?.kind === "user" ? scan.id : undefined);
    queueOwnersRef.current.delete(queueItemId);
    if (userId === undefined) return undefined;
    setChatTabs((prev) => prev.map((candidate) => (
      candidate.id === tabId
        ? {
            ...candidate,
            items: candidate.items.map((item) => (
              item.kind === "user" && item.queueItemId === queueItemId
                ? (outcome === "started" ? startUserItem(item) : releaseWaitingItem(item, false))
                : item
            )),
          }
        : candidate
    )));
    return userId;
  }

  /**
   * 排队项出队并真正开始：先定位它挂的用户消息，找不到就只收等待项、不碰该标签的执行态，
   * 否则标签会带着 `running` 却没有可结算的会话（`session/end` 再也命不中，标签永久转圈）。
   * 找得到时才走与直接应答相同的回合初始化。
   * 该标签上别的发送的 pending 由它自己的应答清理，这里不按标签删除。
   */
  function beginQueuedTurn(tabId: string, sessionId: string, queueItemId: string): void {
    const userId = clearQueueItem(tabId, queueItemId);
    writeTabRun(tabId, (state) => queuedTurnRunState(state, queueItemId, userId !== undefined));
    if (userId === undefined) return;
    openTurnForTab(tabId, sessionId, userId);
  }

  /**
   * 排队项出队后复检失败：只去掉这条等待，不把执行中的回合改成结束。
   * 失败的那条用户消息留在列表里，但标成未启动——它没有成为回合，不能劫持上一回合的终态。
   * 宿主已经用 `agent/notice` 说过同一个原因时，只保留原来那条。
   */
  function failQueuedTurn(tabId: string, queueItemId: string, reason: string): void {
    writeTabRun(tabId, (state) => noteWaitingFailed(state, queueItemId));
    clearQueueItem(tabId, queueItemId, "unstarted");
    if (lastAgentNoticeRef.current[tabId] === reason) {
      delete lastAgentNoticeRef.current[tabId];
      return;
    }
    noteTab(tabId, reason);
  }

  /**
   * 取出本次发送暂存的早到事件并清掉它的 pending：直接开始的回合按原顺序全部重放；
   * 排队应答只重放 `queueItemId` 与它一致的那几条；没启动的应答只丢弃本次缓冲。
   * 清理只针对本次记录，别的发送的 pending 不受影响。
   */
  function takePendingBuffer(pending: PendingSend, sent: SessionSendResult): RpcEvent[] {
    const buffered = pending.buffered;
    pending.buffered = [];
    if (pendingSendsRef.current.get(pending.tabId) === pending) pendingSendsRef.current.delete(pending.tabId);
    if (sendOpensTurn(sent)) return buffered;
    if (sent.waiting && sent.queueItemId !== undefined) {
      const queueItemId = sent.queueItemId;
      return buffered.filter((event) => (
        (event.event === "session/queue-start" || event.event === "session/queue-fail")
        && event.queueItemId === queueItemId
      ));
    }
    return [];
  }

  /** 本次发送失败：只丢弃它自己的 pending 与缓冲，别的发送的事件不进这份失败缓冲。 */
  function dropPending(pending: PendingSend): void {
    pending.buffered = [];
    if (pendingSendsRef.current.get(pending.tabId) === pending) pendingSendsRef.current.delete(pending.tabId);
  }

  /** 会话绑定的标签；事件归属按它计算，不存在时返回 undefined。 */
  function tabIdForSession(sessionId: string | undefined): string | undefined {
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    return chatTabsRef.current.find((tab) => tab.sessionId === sessionId)?.id;
  }

  /**
   * 拥有该会话回合的标签：先按绑定找，再按标签自己的回合记录找
   * （刚铸造的会话在 chatTabsRef 提交前还看不到绑定）。
   */
  function turnTabForSession(sessionId: string | undefined): string | undefined {
    const bound = tabIdForSession(sessionId);
    if (bound !== undefined) return bound;
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    for (const [tabId, turn] of Object.entries(tabTurnsRef.current)) {
      if (turn.sessionId === sessionId) return tabId;
    }
    return undefined;
  }

  /** 该会话的停止票据/闩锁归属：取消在飞的标签，或已扣闩锁的标签。 */
  function stopOwnerForSession(sessionId: string | undefined): { tabId: string; turn: TabTurn } | undefined {
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    for (const [tabId, turn] of Object.entries(tabTurnsRef.current)) {
      if (turn.pending?.sessionId === sessionId || turn.stopSessionId === sessionId) return { tabId, turn };
    }
    return undefined;
  }

  /** 该会话上用户已发起停止：取消在飞，或取消成功、闩锁仍扣着。 */
  function stopRequestedForSession(sessionId: string | undefined): boolean {
    const owner = stopOwnerForSession(sessionId);
    return owner !== undefined && sessionStopRequested(owner.turn.pending, owner.turn.stopSessionId, sessionId);
  }

  /** 事件把某个标签置为执行中/已结束：按会话找标签，找不到就不动任何标签。 */
  function setTurnRunningForSession(active: boolean, sessionId?: string): void {
    const tabId = turnTabForSession(sessionId);
    if (tabId === undefined) return;
    writeTabRun(tabId, (state) => {
      if (!active) return noteTurnEnded(state);
      return state.running ? state : { running: true, waitingIds: state.waitingIds };
    });
  }

  useEffect(() => {
    authPhaseRef.current = authPhase;
  }, [authPhase]);

  const activeChat = chatTabs.find((tab) => tab.id === activeTab) ?? chatTabs[0];
  /** 当前标签发送时使用的模型：本标签选择 > 子任务记住的模型 > 全局当前模型。 */
  const activeTabTask = activeChat.taskId
    ? projectTasks.find((task) => task.id === activeChat.taskId)
    : undefined;
  const sendModelId = resolveSendModelId(modelPickByTab, activeChat.id, activeTabTask?.modelId, activeModelId);
  const sendModelLabel = modelDisplayName(savedModels.find((entry) => entry.id === sendModelId), "");
  /** 当前标签自己的 diff：另一个标签的 diff 留在它自己那份里，不会被这里读到。 */
  const diff = diffsByTab[activeChat.id] ?? "";
  /** 任务级「运行中」：任一在途运行属于该任务即算（任务行停止按钮与各类禁用的判据）。 */
  const runningAutomationIds = useMemo(
    () => new Set([...runningRuns.values()].map((entry) => entry.automationId)),
    [runningRuns],
  );
  /** 运行对话标签的 live 判据按 runId（同一任务的旧标签不显示「停止」）。 */
  const runningRunIds = useMemo(() => new Set(runningRuns.keys()), [runningRuns]);
  /** 任一父会话仍有非终态、非失效的 run 时共享 1 秒 tick 继续走(设计 D4/D6)。 */
  const hasAnyActiveSubagentRun = useMemo(
    () => [...subagentRuns.runs.values()].some(isSubagentRunActive),
    [subagentRuns],
  );
  /** 占名额的执行中标签数：排队的标签不算，另一个标签开始回合也不改这一份。 */
  const runningTurnCount = useMemo(
    () => Object.values(tabRuns).filter((state) => state.running).length,
    [tabRuns],
  );
  const anyTabRunning = runningTurnCount > 0;
  const items = activeChat.items;
  const pendingInput = latestOpenInput(items);
  const contentView = useMemo(() => contentItems(items), [items]);
  /** 最终消息区把平铺工具行投影成每回合一个面板；扁平 `items` 仍是执行与核对的唯一来源。 */
  const toolRows = useMemo(() => projectToolPanels(items, {
    contentItems: contentView,
    turnFinalByUserId: activeChat.turnFinalByUserId,
    turnFinalWithoutUser: activeChat.turnFinalWithoutUser,
    connectionLost: sidecarDead,
  }), [items, contentView, activeChat.turnFinalByUserId, activeChat.turnFinalWithoutUser, sidecarDead]);
  /** 运行卡不进入内容视图,下标会与 `items` 错位;思考收尾判断按 id 取内容视图下标。 */
  const contentIndexById = useMemo(
    () => new Map(contentView.map((entry, index) => [entry.id, index] as const)),
    [contentView],
  );
  /** 运行卡的渲染输入:共享 now 驱动全部卡片,UI 展开/确认/错误按 runId 另存。 */
  const subagentChat: SubagentChatView = {
    runs: subagentRuns.runs,
    now,
    frozenAt: subagentRuns.frozenAt,
    expandedByRunId,
    confirmingRunId,
    cancelBusyByRunId,
    cancelErrorByRunId,
    onToggleExpanded: toggleSubagentExpanded,
    onRequestCancel: requestCancelSubagent,
    onConfirmCancel: (runId) => void confirmCancelSubagent(runId),
    onDismissCancel: dismissCancelSubagent,
  };
  /**
   * 右侧预览选中的附件项（规格 §5）：选择记在标签上；标签里没有附件项时
   * （如重建后日志未含该条）回落空占位，不显示下载。
   */
  const previewAttachment = activeChat.previewFile ? items.find((item) => item.kind === "attachment") : undefined;
  const previewFile = previewAttachment ? activeChat.previewFile : undefined;
  const previewContent = useMemo(() => {
    // 预览页不可见时不解析/渲染：token 流会持续替换 items，不能每次刷新都重算。
    if (rightTab !== "preview" || !previewAttachment || !previewFile) return undefined;
    return previewFile === RESULT_ATTACHMENT_FILES[0]
      ? renderResultMarkdown(previewAttachment.sourceText)
      : renderResultHtml(previewAttachment.sourceText);
  }, [previewAttachment, previewFile, rightTab]);
  const sessionFailed = activeChat.sessionFailed;
  /** 相位 → 展示决策；`stopped` 是中性终态，不再显示无响应与结束按钮。 */
  const hostNotice = hostLivenessNotice(hostPhase);
  /** 当前 tab 的父会话是否有活跃运行卡(设计 D4:stale 与终态都不算活跃)。 */
  const hasActiveChild = activeChat.sessionId !== undefined
    && [...subagentRuns.runs.values()].some(
      (run) => run.parentSessionId === activeChat.sessionId && isSubagentRunActive(run),
    );
  const unconfirmedTools = toolsUnconfirmed(items, sidecarDead);
  /** 当前标签自己的执行态与进度；另一个标签的回合不影响这一标签的句子。 */
  const activeTabRunning = tabRuns[activeChat.id]?.running === true;
  const activePulse = turnPulseByTab[activeChat.id];
  const showTurnLine = hasActiveChild || unconfirmedTools || activeTabRunning;
  const turnLine = parentTurnLine({
    hasActiveChild,
    toolsUnconfirmed: unconfirmedTools,
    current: turnStatus({
      latest: activePulse?.latest ?? "quiet",
      runningTool: runningToolName(items, sidecarDead),
      toolsUnconfirmed: unconfirmedTools,
      quietMs: Math.max(0, now - (activePulse?.at ?? now)),
    }),
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
    void rpcCall<{ items: AgentListItem[] }>("agent.invocableList")
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

  /** 向指定标签追加一条提示；标签已关闭时自然丢弃。 */
  function noteTab(tabId: string, text: string) {
    const note: ChatItem = { id: allocId(), kind: "note", text };
    setChatTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, items: [...tab.items, note] } : tab)));
  }

  /** 向最近激活的对话标签追加一条提示。 */
  function noteActive(text: string) {
    noteTab(activeTab, text);
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
        // 空子任务：建标签后预铸独立会话。项目根显式作为 cwd，宿主不改前台工作区。
        const projectRoot = projects.find((item) => item.id === task.projectId)?.root;
        setChatTabs((prev) => [
          ...prev,
          { id, label: task.name, items: [], sessionFailed: false, projectId: task.projectId, pendingPick: false, taskId: task.id },
        ]);
        setActiveTab(id);
        void rpcCall<{ sessionId?: string; cwd?: string }>("session.new", {
          fresh: true,
          ...(projectRoot ? { cwd: projectRoot } : {}),
        })
          .then((minted) => {
            rememberMinted(minted);
            if (typeof minted.sessionId === "string" && minted.sessionId) {
              setChatTabs((prev) =>
                prev.map((tab) => (tab.id === id && !tab.sessionId ? { ...tab, sessionId: minted.sessionId } : tab)),
              );
            }
          })
          .catch(() => undefined);
        return;
      }
      // 有会话：先读历史再 resume。resume 会把未闭合尾回合修补成合成结果并写盘，
      // 先读才能拿到修补前的真实日志；openFreeSession 也采用同一顺序。
      const sessionId = task.sessionId;
      try {
        const opened = await rpcCall<{ records?: SessionDetailRecord[] }>("session.open", { sessionId });
        const view: SessionLogView = {
          sessionId,
          title: task.name,
          log: "",
          records: Array.isArray(opened.records) ? opened.records : [],
        };
        await rpcCall("session.resume", { sessionId });
        const items = historyToChatItems(view);
        setChatTabs((prev) => [
          ...prev,
          {
            id,
            label: task.name,
            items,
            sessionFailed: false,
            projectId: task.projectId,
            pendingPick: false,
            taskId: task.id,
            sessionId,
            turnFinalByUserId: historicalTurnFinalByUserId(items),
            turnFinalWithoutUser: true,
          },
        ]);
        // 历史回放只有消息条目:补拉宿主快照,把上次运行留下的子代理运行卡补回来。
        void reconcileSubagentRuns(id, sessionId);
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
    setSelectedTaskId((current) => (current === task.id ? null : current));
    const seedId = `work-${nextChatSeq.current}`;
    nextChatSeq.current += 1;
    // 只处理绑定该会话的标签：其它标签正在执行的回合不受删除影响。
    const removedTabId = tabIdForSession(task.sessionId);
    const removedTurn = tabTurnOf(removedTabId);
    if (removedTabId !== undefined && task.sessionId && removedTurn.sessionId === task.sessionId && canStartStop(removedTurn.pending)) {
      const sessionId = task.sessionId;
      const ticket: StopTicket = { id: stopSeqRef.current + 1, sessionId, epoch: removedTurn.epoch };
      stopSeqRef.current = ticket.id;
      patchTabTurn(removedTabId, { sessionId: null, stopping: true, pending: ticket });
      writeTabRun(removedTabId, noteTurnEnded);
      void rpcCall("session.cancel", { sessionId }).then(() => {
        settleStop(removedTabId, ticket, true);
      }).catch(() => {
        settleStop(removedTabId, ticket, false);
      });
    } else if (removedTabId !== undefined && task.sessionId && removedTurn.sessionId === task.sessionId) {
      patchTabTurn(removedTabId, { sessionId: null });
      writeTabRun(removedTabId, noteTurnEnded);
    }
    const matchesRemoved = (tab: { taskId?: string; sessionId?: string }) =>
      Boolean((tab.taskId && tab.taskId === task.id) || (task.sessionId && tab.sessionId === task.sessionId));
    // 被删标签的在途发送与排队归属随标签一起清掉：迟到的队列事件不能再把它们拉回执行中。
    for (const tab of chatTabsRef.current) {
      if (matchesRemoved(tab)) pruneTabBookkeeping(tab.id);
    }
    const seed = { id: seedId, label: "对话", items: [], sessionFailed: false, projectId: null, pendingPick: false };
    setChatTabs((prev) => {
      const filtered = prev.filter((tab) => !matchesRemoved(tab));
      return filtered.length > 0 ? filtered : [seed];
    });
    await refreshTasks();
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
    if (root) neutralRootRef.current = root;
    if (!root || workspaceRef.current === root) return;
    setWorkspace(root);
    workspaceRef.current = root;
    setActiveProjectId(null);
    activeProjectIdRef.current = null;
    setGitWarning("");
    await rebindTabSession("work-1");
  }

  /** 中立根：`workspace.close` 的应答恒为中立根；只取一次并缓存，避免每次新建会话都切前台根。 */
  async function neutralWorkspaceRoot(): Promise<string | undefined> {
    if (neutralRootRef.current) return neutralRootRef.current;
    try {
      const closed = await rpcCall<{ workspaceRoot?: string }>("workspace.close");
      const root = typeof closed.workspaceRoot === "string" ? closed.workspaceRoot : "";
      if (!root) return undefined;
      neutralRootRef.current = root;
      return root;
    } catch {
      return undefined;
    }
  }

  /**
   * 这条标签新建会话时使用的 cwd：已绑定项目用项目根，未绑定项目用中立根。
   * 宿主把该目录只用于这条新会话，不改 `workspaceRoot.current`；前台工作区与界面状态都不动。
   */
  async function sessionCwdForTab(tab: ChatTab | undefined): Promise<string | undefined> {
    const project = tab?.projectId ? projects.find((item) => item.id === tab.projectId) : undefined;
    if (project) return project.root;
    return neutralWorkspaceRoot();
  }

  /** 启动后为默认对话标签绑定稳定会话（跨重启延续上下文）。 */
  async function bindDefaultTabSessions() {
    try {
      const minted = await rpcCall<{ sessionId?: string; cwd?: string }>("session.new", {});
      rememberMinted(minted);
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
      // 运行记录出现即表示该轮已落盘：丢失 run-end 或 stop 返回 stopped:false 时，
      // 任务行/运行对话的在途状态不能永远停在「停止」。
      setRunningRuns((prev) => settleRunningRuns(prev, listed.runs ?? {}));
      // 重启重建（规格 L544 修订）：run tab 只由实时 run-start 事件创建进内存，重启即消失；
      // 这里按「每任务最近一次带会话的运行」补出骨架标签，内容首开时懒加载（见 runBackfill effect）。
      // 去重键 run-<runId> 与实时创建相同，幂等；只 append 不重置，chatTabs 恒非空不变量不破。
      // 删除过运行记录的会话进抑制集：最新一条被抑制时整个任务跳过，不退回更早的运行。
      const rebuild = runTabsToRebuild(
        nextAutomations,
        listed.runs ?? {},
        new Set(chatTabsRef.current.map((tab) => tab.id)),
        suppressedRunSessionIdsRef.current,
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

  /**
   * 运行记录删除成功后关掉它绑定的运行对话标签（规格 §6）。
   * 只关自动化运行标签：默认对话标签即使 sessionId 相同也保留。
   * 被关的是当前标签时改选最近的存活标签，选择交给 closeRunTabsForSession 决定。
   *
   * 抑制被删会话及其更早的运行：删掉的最新一条不能在下一次 automation.list 刷新时
   * 被重建；更新的运行仍允许刷新重建，不能连同它们一起误抑制。
   */
  function handleRunDeleted(sessionId: string, automationId: string, startedAt: number) {
    const suppressed = suppressedRunSessionIdsRef.current;
    for (const id of sessionsToSuppressAfterDelete(automationRuns[automationId] ?? [], sessionId, startedAt)) {
      suppressed.add(id);
    }
    const result = closeRunTabsForSession(chatTabsRef.current, sessionId, activeTab);
    setChatTabs(result.tabs);
    setActiveTab(result.nextActiveId);
  }

  /** Task 10：判定驱动在前端——automation.list 每次刷新后重算期望的 hold 并交给驱动。
   * sidecar 无法 invoke Tauri command，只能由这里发起。断言/重试/过期结果丢弃的
   * 状态机在 logic/keepAwake.ts（M4 评审 D4：失败不提交、同值刷新不丢成功回调）。 */
  useEffect(() => {
    keepAwakeDriver.refresh(shouldHoldKeepAwake(keepAwake, automations));
  }, [keepAwake, automations, keepAwakeDriver]);

  /**
   * 把一次回合终结结算到拥有该会话的标签。只有真实的 goal 动作或真实结束
   * 会走到这里；断连只影响展示（`sidecarDead`），从不结算回合。
   */
  function applyFinalForTab(tabId: string | undefined, sessionId: string | undefined, event: TurnFinalEvent) {
    if (!tabId) return;
    // 相位在事件处理时同步取样，避免 React 延后执行 updater 时读到已跳变的相位。
    const phase = goalTurnRef.current.phases[sessionId ?? ""];
    // 终态落到该标签活动回合的用户消息；没记录过活动消息时回落到最后一条已启动的用户消息，
    // 排队中或本次已抛错的消息都不算活动回合。
    const activeUserId = tabTurnOf(tabId).activeUserId
      ?? latestUserItemId(chatTabsRef.current.find((tab) => tab.id === tabId)?.items ?? []);
    setChatTabs((prev) => applyTurnFinalToTabs(prev, tabId, event, phase, activeUserId));
  }

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
    /** 带会话 id 的事件只进绑定标签。删掉的会话不再回落到当前对话。 */
    const targetTabFor = (sessionId?: string): string | undefined =>
      eventTargetTab(
        sessionId,
        chatTabsRef.current,
        liveChatRef.current,
        tabTurnOf(liveChatRef.current).sessionId,
      );
    const setChannelItems = (updater: (prev: ChatItem[]) => ChatItem[], sessionId?: string) => {
      const target = targetTabFor(sessionId);
      if (!target) return;
      setChatTabs((prev) => prev.map((tab) => (tab.id === target ? { ...tab, items: updater(tab.items) } : tab)));
    };
    /** 读取本回合的标签与条目；只读状态，不列工作区树。子代理会话不属于任何标签时返回 undefined。 */
    const readTurnItems = async (sessionId?: string) => {
      const tabId = outcomeTargetTab(sessionId, chatTabsRef.current, liveChatRef.current);
      if (!tabId) return undefined;
      // chatTabsRef 在提交后才同步，可能还看不到同一批事件里的 tool/end。
      // 函数式更新按队列顺序执行，拿到的 prev 已含这批事件；这里只读取，不改状态。
      const items = await new Promise<ChatItem[] | undefined>((resolve) => {
        setChatTabs((prev) => {
          resolve(prev.find((candidate) => candidate.id === tabId)?.items);
          return prev;
        });
      });
      if (!items || !items.some((item) => item.kind === "user")) return undefined;
      return { tabId, items };
    };
    /** 读出本回合要核对的内容；只认用户对话标签，工作区树只在确有必核文件时列出。 */
    const readTurn = async (sessionId?: string, pending?: { tabId: string; items: ChatItem[] }) => {
      const turn = pending ?? await readTurnItems(sessionId);
      if (!turn) return undefined;
      const { tabId, items } = turn;
      // 以该标签记录的活动消息为准：应答未回窗口里刚插入的那条还不能接走本回合的核对。
      const turnUserId = turnUserIdFor(tabTurnOf(tabId), items);
      // 核对只读本回合那条用户消息：排在后面的排队消息还没开始，不能改文件/命令要求。
      const checks = turnChecks(contentItems(items), turnUserId);
      const listedCwd = lookupSessionCwd(sessionId, sessionsRef.current, sessionCwdRef.current);
      const root = outcomeWorkspace(workspaceRef.current, listedCwd);
      let tree: TreeNode[] = [];
      const treeKnown = checks.requiredFiles.length === 0 || root.length > 0;
      if (checks.requiredFiles.length > 0 && root) {
        try {
          tree = await listTree(root, WORKSPACE_SCAN_DEPTH);
        } catch {
          tree = [];
        }
      }
      return { tabId, turnUserId, items, checks, tree, treeKnown, root };
    };
    const appendTurnNotes = (turn: NonNullable<Awaited<ReturnType<typeof readTurn>>>, texts: string[]) => {
      const notes = texts.map((text) => ({ id: allocId(), kind: "note" as const, text }));
      // 等待期间用户可能已发出新消息：在最新状态上判断，旧回合的结论不落到新消息之后。
      setChatTabs((prev) =>
        prev.map((candidate) =>
          candidate.id === turn.tabId
            ? { ...candidate, items: appendOutcomeNotes(candidate.items, turn.turnUserId, notes) as ChatItem[] }
            : candidate,
        ),
      );
    };
    /** 回合正常结束：读侧核对用户写明的文件与命令，把结果写进对话；不重跑任何命令。 */
    const appendTurnOutcome = async (sessionId?: string) => {
      // 计划模式还在等确认：本回合只提交计划，执行在批准后的下一回合，不写文件/命令核对。
      // 先判定再列工作区树：计划回合不该为一次注定跳过的核对付 depth-6 的列表 RPC。
      const pending = await readTurnItems(sessionId);
      if (!pending || cancelled) return;
      if (!shouldCheckTurnOutcome(pending.items)) return;
      const turn = await readTurn(sessionId, pending);
      if (!turn || cancelled) return;
      const notes = turnOutcomeNotes(turn.checks, turn.tree, turn.treeKnown, { root: turn.root });
      if (notes.length === 0) return;
      appendTurnNotes(turn, notes);
    };
    /** 官方续轮到上限停下：把停下的轮数和尚未核对的缺项写进对话，不自动建下一个目标。 */
    const appendGoalStopped = async (round: number, sessionId?: string) => {
      const turn = await readTurn(sessionId);
      if (!turn || cancelled) return;
      appendTurnNotes(turn, [goalRoundStopped(round, turnGaps(turn.checks, turn.tree, turn.treeKnown, { root: turn.root }))]);
    };
    /**
     * 目标事件进入纯状态机。返回本回合应写的结论：同一用户回合里
     * `session/end` 与终态 `goal/state` 无论谁先到，都只有第一次拿到 outcome。
     */
    const noteGoalEvent = (event: GoalTurnEvent): GoalTurnAction => {
      const result = reduceGoalTurn(goalTurnRef.current, event);
      goalTurnRef.current = result.state;
      return result.action;
    };
    const setChannelSessionFailed = (failed: boolean, sessionId?: string) => {
      const target = targetTabFor(sessionId);
      if (!target) return;
      setChatTabs((prev) => prev.map((tab) => (tab.id === target ? { ...tab, sessionFailed: failed } : tab)));
    };
    /**
     * 子代理 run 事件只进 reducer 与运行卡,绝不进入父消息流(设计 D8 / §7)。
     * 实时事件不传 `allowSnapshotFallback`:只有 `clientMessageId` 精确命中本 tab
     * 某条用户消息时才挂卡,不按 active tab 或最后一个用户消息猜测归属。
     */
    const applySubagentEvent = (event: SubagentRunEvent) => {
      setSubagentRuns((prev) => reduceSubagentRuns(prev, { type: "event", event }));
      if (event.event === "subagent/run") {
        const run = event.run;
        setChatTabs((prev) =>
          prev.map((tab) => {
            if (tab.sessionId !== run.parentSessionId) return tab;
            const nextItems = insertSubagentRunCard(tab.items, {
              runId: run.runId,
              ...(run.clientMessageId === undefined ? {} : { clientMessageId: run.clientMessageId }),
              allocateId: allocId,
            });
            return nextItems === tab.items ? tab : { ...tab, items: nextItems };
          }),
        );
        return;
      }
      // 终态历史被淘汰:卡片从所有标签移除,该 run 的 UI 状态一并清掉。
      const { runId } = event;
      setChatTabs((prev) =>
        prev.map((tab) => {
          const nextItems = tab.items.filter((item) => item.kind !== "subagent-run" || item.runId !== runId);
          return nextItems.length === tab.items.length ? tab : { ...tab, items: nextItems };
        }),
      );
      setExpandedByRunId((prev) => withoutKey(prev, runId));
      setCancelBusyByRunId((prev) => withoutKey(prev, runId));
      setCancelErrorByRunId((prev) => withoutKey(prev, runId));
      setConfirmingRunId((prev) => (prev === runId ? null : prev));
    };
    const applyEvent = (event: RpcEvent) => {
      if (cancelled) return;
      // 子代理事件在父消息流之前拦截:它们没有父会话的 token/tool 语义。
      if (event.event === "subagent/run" || event.event === "subagent/run-remove") {
        applySubagentEvent(event);
        return;
      }
      // WS ready 后对所有已绑定父会话补拉 snapshot;ready 本身不解除冻结,
      // 只有对账完成的 snapshot 才清 frozenAt(设计 D6/D7)。此步必须早于下方
      // 所有早退闸门:sidecar/status 没有会话归属,后台自动化运行期间也照样对账,
      // 否则断线重连后 run 卡会停在冻结态(计时冻结、终止禁用)直到下一次重连。
      if (event.event === "sidecar/status" && event.ready) {
        // 产品修复:ready 说明新的执行进程已接管同一来源。断连时置位的死锁存
        // (setSidecarDead(true))只有这里能撤销——否则一次瞬时断连之后,即使宿主
        // 已重连成功,发送/停止/自动化仍被永久禁用,只能重启应用。
        setSidecarDead(false);
        reconcileEpochRef.current += 1;
        reconcileBoundSubagentRuns();
      }
      /**
       * 本次发送的应答还没回来：把尚不能结算的早到事件按到达顺序暂存。
       * 上一回合仍在执行时它的事件照常即时处理——不能为了新发送而缓冲。
       */
      const holdEarlyEvent = (incoming: RpcEvent): boolean => {
        if (incoming.event === "session/queue-start" || incoming.event === "session/queue-fail") {
          // 已能匹配某条等待消息的队列事件照常即时处理。
          if (queueItemTab(incoming.queueItemId) !== undefined) return false;
          const pending = pendingSendOfTab(incoming.tabId);
          if (pending === undefined) return false;
          pending.buffered.push(incoming);
          return true;
        }
        const isGoalEvent = incoming.event === "session/end" || incoming.event === "goal/state"
          || incoming.event === "goal/round" || incoming.event === "goal/round-limit";
        if (!isGoalEvent) return false;
        const sessionId = sessionIdOfEvent(incoming);
        const pending = pendingSendOfSession(sessionId);
        if (pending === undefined) return false;
        if (tabRunOf(pending.tabId).running && tabTurnOf(pending.tabId).sessionId === sessionId) return false;
        // 跨标签同会话:任一标签正把这个会话作为执行中的回合跟踪时,这条事件属于
        // 那个回合,必须照常即时结算——进本发送的 pending 缓冲会被 waiting 应答的
        // 按 queueItemId 过滤丢弃,那个标签将永久 running(最终评审 Important 1)。
        const turnTab = turnTabForSession(sessionId);
        if (turnTab !== undefined && tabRunOf(turnTab).running && tabTurnOf(turnTab).sessionId === sessionId) return false;
        pending.buffered.push(incoming);
        return true;
      };
      if (holdEarlyEvent(event)) return;
      if (event.event === "session/end") {
        // 停止票据与代际都按事件所属标签读取：另一个标签的当前 epoch 不能判定这一条结束。
        const eventTabId = tabIdForSession(event.sessionId);
        const eventEpoch = tabTurnOf(eventTabId).epoch;
        const owner = stopOwnerForSession(event.sessionId);
        if (owner !== undefined && isStopPending(owner.turn.pending, event.sessionId)) {
          heldEndsRef.current.push(event);
          return;
        }
        const consumed = consumeStaleIdle(staleIdleRef.current, event, eventEpoch);
        staleIdleRef.current = consumed.stale;
        if (consumed.drop) return;
      }
      // 后台任务事件：更新任务运行角标并刷新数据；agent 运行另建运行对话标签承载过程与结果。
          if (event.event === "automation/run-start") {
            automationActiveRef.current = true;
            setRunningRuns((prev) => {
              const next = new Map(prev);
              next.set(event.runId, { automationId: event.automationId });
              return next;
            });
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
            // 只摘自己这一条 runId:同一任务的另一条并发运行仍在途时,任务行的
            // 「停止」与角标不得提前消失。
            setRunningRuns((prev) => {
              const next = new Map(prev);
              next.delete(event.runId);
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
                      ? {
                          ...tab,
                          items: [
                            // 整段 JSON 输出先收成附件项，结果脚注仍在末尾。
                            ...foldRunAssistantItems(tab.items, (sourceText) => ({
                              id: allocId(),
                              kind: "attachment" as const,
                              sourceText,
                            })),
                            { id: allocId(), kind: "note" as const, text: resultLabel },
                          ],
                        }
                      : tab,
                  ),
                );
                // 运行的权威结束事件；session/end 可能被 stale-idle 闸门丢弃。
                applyFinalForTab(target, event.sessionId, {
                  kind: "run-end",
                  interrupted: !event.ok || event.status === "cancelled",
                });
              }
            }
            void refreshAutomations();
            void refreshSessions();
            // 只有失败/超时才发系统失败通知；用户主动取消不是失败，missed 走应用内横幅
            // （missed 从未经过 run-end，见 automation/missed 分支）。
            if (runEndNeedsFailureNotice(event.status)) {
              const name = automationsRef.current.find((item) => item.id === event.automationId)?.name ?? "任务";
              const statusLabel = event.status === "timeout" ? "超时" : "失败";
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
      // 智能体包事件：会话内提示、结构化创建确认卡，以及列表刷新信号（面板与 @ 补全共用）。
      // 放在自动化会话泄漏门之后，自动化会话的 agent 事件不会写进可见对话标签。
      if (event.event === "agent/notice") {
        const target = targetTabFor(eventSessionId);
        if (target) {
          lastAgentNoticeRef.current[target] = event.text;
          noteTab(target, event.text);
        }
        return;
      }
      if (event.event === "agent/confirm") {
        const target = targetTabFor(eventSessionId);
        if (target) {
          setChatTabs((prev) =>
            prev.map((tab) =>
              tab.id === target
                ? { ...tab, items: [...tab.items, { id: allocId(), kind: "agent-confirm" as const, card: event.card }] }
                : tab,
            ),
          );
        }
        return;
      }
      if (event.event === "agent/changed") {
        setAgentChangeSignal((prev) => prev + 1);
        void rpcCall<{ items: AgentListItem[] }>("agent.invocableList")
          .then((res) => {
            if (!cancelled) setAtCatalog(Array.isArray(res.items) ? res.items : []);
          })
          .catch(() => {
            // 目录暂不可读时保留旧补全数据
          });
        return;
      }
      // 排队项出队/复检失败：早到的那条已在上方按 pending 暂存，这里只处理能归属的。
      if (event.event === "session/queue-start") {
        beginQueuedTurn(queueItemTab(event.queueItemId) ?? event.tabId, event.sessionId, event.queueItemId);
        return;
      }
      if (event.event === "session/queue-fail") {
        failQueuedTurn(queueItemTab(event.queueItemId) ?? event.tabId, event.queueItemId, event.reason);
        return;
      }
      // 差异按标签：只写该会话绑定的标签；不是可见标签时不改它、也不把右栏切到 diff。
      if (event.event === "diff") {
        const diffTab = tabIdForSession(event.sessionId);
        if (diffTab !== undefined) {
          setDiffsByTab((prev) => noteDiffForTab(prev, diffTab, event.text));
          if (activeTabRef.current === diffTab) setRightTab("diff");
        }
        return;
      }
          // 回合身份、停止票据与代际都按事件所属标签读取：另一个标签的回合不参与判定。
          const endTab = event.event === "session/end" ? targetTabFor(eventSessionId) ?? turnTabForSession(eventSessionId) : undefined;
          const endTurn = tabTurnOf(endTab);
          const userStopped = event.event === "session/end"
            && typeof eventSessionId === "string"
            && eventSessionId.length > 0
            && stopOwnerForSession(eventSessionId)?.turn.stopSessionId === eventSessionId;
          // 目标仍 active 时这条结束是官方续轮的中间结束：不清执行态、不撤停止按钮。
          const goalIntermediate = event.event === "session/end"
            && endTab !== undefined
            && event.ok
            && event.cancelled !== true
            && !userStopped
            && goalTurnRef.current.phases[eventSessionId ?? ""] === "active";
          const endsTrackedTurn = event.event === "session/end"
            && endTab !== undefined
            && !goalIntermediate
            && endTurn.sessionId === eventSessionId;
          // 官方续轮只恢复该标签自己的执行态；后台目标不能卡住其它标签。
          const goalRoundTab = event.event === "goal/round" ? turnTabForSession(eventSessionId) : undefined;
          const goalRoundDrives = goalRoundTab !== undefined && tabTurnOf(goalRoundTab).sessionId === eventSessionId;
          handleEvent(event, allocId, setReady, setChannelItems, setTurnRunningForSession, setChannelSessionFailed, async () => {
            await refreshSessions();
          }, sawReady, endsTrackedTurn, userStopped, goalRoundDrives);
          if (event.event === "session/end" && endsTrackedTurn && endTab !== undefined) {
            // 取消/失败的终局摘掉会话跟踪；正常结束留着它，目标续轮还要按会话判断。
            if (event.cancelled || !event.ok || userStopped) patchTabTurn(endTab, { sessionId: null });
          }
          if (userStopped && !event.cancelled) {
            // 停止闩锁只释放这一条会话自己的那份，别的标签的闩锁不动。
            const owner = stopOwnerForSession(eventSessionId);
            if (owner !== undefined) patchTabTurn(owner.tabId, { stopSessionId: null, stopping: false });
          }
          const kind = activityKind(event);
          const pulseTab = tabIdForSession(eventSessionId);
          if (kind && pulseTab !== undefined && tabTurnOf(pulseTab).sessionId === eventSessionId) {
            const at = Date.now();
            setTurnPulseByTab((prev) => ({ ...prev, [pulseTab]: { latest: kind, at } }));
            setNow(at);
          }
          if (event.event === "goal/state") {
            // 用户停止时官方驱动先在空闲处理里暂停目标，随后才是取消结束；
            // 只看现存停止信号（取消在飞 / 已扣闩锁），这条终态只结算、不写结论。
            const stopped = "phase" in event && stopRequestedForSession(event.sessionId);
            const action = "cleared" in event
              ? noteGoalEvent({ kind: "goal-cleared", sessionId: event.sessionId })
              : noteGoalEvent({
                kind: "goal-state",
                phase: event.phase,
                sessionId: event.sessionId,
                ...(stopped ? { stopped: true as const } : {}),
              });
            applyFinalForTab(targetTabFor(event.sessionId), event.sessionId, { kind: "goal-action", action });
            if (action.kind === "outcome") void appendTurnOutcome(event.sessionId);
          }
          if (event.event === "goal/round-limit") {
            const action = noteGoalEvent({ kind: "goal-round-limit", round: event.round, sessionId: eventSessionId });
            applyFinalForTab(targetTabFor(eventSessionId), eventSessionId, { kind: "goal-action", action });
            if (action.kind === "goal-stopped") void appendGoalStopped(action.round, eventSessionId);
          }
          if (event.event === "session/end") {
            const action = noteGoalEvent({
              kind: "session-end",
              sessionId: eventSessionId,
              ok: event.ok,
              ...(event.cancelled === true || userStopped ? { cancelled: true as const } : {}),
            });
            applyFinalForTab(targetTabFor(eventSessionId), eventSessionId, { kind: "session-end", ok: event.ok, cancelled: event.cancelled === true || userStopped });
            if (action.kind === "outcome") void appendTurnOutcome(eventSessionId);
          }
          if (event.event === "sidecar/status" && event.ready && authPhaseRef.current !== "logged-in") {
            pullAuthStatusRef.current();
          }
    };
    applySidecarEventRef.current = applyEvent;
    void (async () => {
      unlisten.push(await onSidecarEvent(applyEvent));
      unlisten.push(
        await onSidecarExit((payload) => {
          if (cancelled) return;
          setSidecarDead(true);
          // 执行进程没了：所有标签的回合都不可能再回报结束，执行态一并清空。
          tabRunsRef.current = {};
          setTabRuns({});
          // WS 断开:run 卡保留最后已知归属并冻结计时,不把断连当作 run 失败;
          // 迟到的对账应答由 epoch 丢弃,冻结只由下一次 snapshot 对账解除(设计 D7)。
          if (!payload.ready) {
            reconcileEpochRef.current += 1;
            setSubagentRuns((prev) => reduceSubagentRuns(prev, { type: "disconnect", at: Date.now() }));
          }
          // 执行进程没了，所有在途运行都不再可能回报 run-end；不清会让任务行、
          // 运行对话与工作区切换永久卡在「运行中」。
          setRunningRuns((prev) => (prev.size === 0 ? prev : new Map()));
          if (!payload.ready && !sawReady.current) setPluginFail(PLUGIN_APPLY_FAIL);
          // 用户主动停止不是崩溃：中性脚注、不标失败（失败标签会拉起红色横幅）。
          const exitNotice = hostExitNotice(hostStoppedByUserRef.current);
          setChatTabs((prev) =>
            prev.map((tab) =>
              tab.items.length > 0
                ? {
                    ...tab,
                    ...(exitNotice.sessionFailed ? { sessionFailed: true } : {}),
                    items: [...tab.items, { id: allocId(), kind: "note" as const, text: exitNotice.text }],
                  }
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
    setWorkAllowNetwork(settings.allow_network === true);
    setKeepAwake(settings.keep_awake !== false);
    setGuardMode(parseGuardMode(settings.guard_mode));
  }, []);

  const refreshModelLabel = useCallback(async () => {
    try {
      hydrateModels(await rpcCall<ModelSettingsPayload>("settings.get"));
    } catch {
      // 设置页关闭时刷新失败：保留现有模型列表，等下次设置读写再同步。
    }
  }, [hydrateModels]);

  /**
   * 发送区选择模型：只改这个标签（不切全局当前模型）。标签已绑定子任务时用 Task 9 的
   * `task.setModel` 写回任务；还没有任务的标签先记在本地，发送时随 `session.send` 交给宿主。
   */
  async function selectTabModel(id: string) {
    const tab = chatTabs.find((item) => item.id === activeTab);
    if (!tab) return;
    setModelPickByTab((prev) => ({ ...prev, [tab.id]: id }));
    if (!tab.taskId) return;
    try {
      const saved = await setTaskModel({ taskId: tab.taskId, modelId: id });
      setProjectTasks((prev) => prev.map((task) => (task.id === saved.task.id ? saved.task : task)));
    } catch (error) {
      noteTab(tab.id, `模型选择未保存：${error instanceof Error ? error.message : String(error)}`);
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
    subagentRunsRef.current = subagentRuns;
  }, [subagentRuns]);

  /** 切 tab 取消确认态:确认对象可能已不在当前标签里(设计 D17 的 UI 边界)。 */
  useEffect(() => {
    setConfirmingRunId((prev) => (prev === null ? prev : null));
  }, [activeTab]);

  useEffect(() => {
    // 分享同一秒表:任一标签的回合或任一子代理 run 活跃时都走;每张运行卡不得自建 interval。
    if (!anyTabRunning && !hasAnyActiveSubagentRun) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyTabRunning, hasAnyActiveSubagentRun]);

  useEffect(() => {
    const bridge = hostLivenessBridge();
    if (!bridge) return;
    let alive = true;
    const observe = (phase: HostLivenessPhase) => {
      hostStoppedByUserRef.current = phase === "stopped";
      setHostPhase(phase);
      // WebSocket 关闭可能先于停止确认到达:撤回关闭路径误标在标签上的失败横幅。
      clearFailuresInTabs(phase, setChatTabs);
    };
    // 探活上报的是「在跑几轮」:占名额的执行中标签 + 在途运行,不能按任务 id 去重。
    const report = () => bridge.reportTurns(runningTurnCount + runningRuns.size);
    report();
    void bridge.read().then((state) => {
      if (!alive) return;
      observe(state.phase);
      report();
    }).catch(() => {});
    const stop = bridge.onChange((state) => {
      observe(state.phase);
      report();
    });
    return () => {
      alive = false;
      stop();
    };
  }, [runningTurnCount, runningRuns]);

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
        const items = [
          // 回放历史里的整段 JSON 回复同样收成附件项；结果脚注仍在其后（末尾）。
          ...foldRunAssistantItems(historyToChatItems(view), (sourceText) => ({
            id: allocId(),
            kind: "attachment" as const,
            sourceText,
          })),
        ];
        // 按 sessionId 匹配所属 run 取结果脚注：重建后同一任务又跑了新 run 也不会拿错。
        const run = (automationRuns[automationId] ?? []).find((item) => item.sessionId === sessionId);
        if (run) items.push({ id: allocId(), kind: "note", text: runResultNoteText(run.status) });
        setChatTabs((prev) =>
          prev.map((item) => (item.id === tabId
            ? { ...item, items, runPlaceholder: false, turnFinalByUserId: historicalTurnFinalByUserId(items), turnFinalWithoutUser: true }
            : item)),
        );
        // 历史回放只有消息条目:补拉宿主快照,把重启前的子代理运行卡补回来。
        void reconcileSubagentRuns(tabId, sessionId);
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
    sessionsRef.current = sessions;
  }, [workspace, sessions]);

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

  /**
   * snapshot 对账(设计 D6):补拉父会话的权威 run 清单。
   *
   * - 请求前捕获对账代际,断连或再次 ready 后到达的应答直接丢弃;
   * - 成功才 dispatch `snapshot`(唯一能清除断连冻结的动作),并为该 tab 里
   *   尚无卡片的 run 补卡;快照路径允许回退到该 tab 最后一条用户消息;
   * - 失败只在同一代际内重试一次,之后留给下一次 ready 或发送触发。
   */
  async function reconcileSubagentRuns(
    chatId: string,
    parentSessionId: string,
    allowRetry = true,
  ): Promise<void> {
    const epoch = reconcileEpochRef.current;
    let snapshot: SubagentRunSnapshot;
    try {
      snapshot = await rpcCall<SubagentRunSnapshot>("subagent.list", { parentSessionId });
    } catch {
      if (!allowRetry || epoch !== reconcileEpochRef.current) return;
      setTimeout(() => {
        if (epoch !== reconcileEpochRef.current) return;
        void reconcileSubagentRuns(chatId, parentSessionId, false);
      }, SUBAGENT_RECONCILE_RETRY_MS);
      return;
    }
    if (epoch !== reconcileEpochRef.current) return;
    setSubagentRuns((prev) => reduceSubagentRuns(prev, { type: "snapshot", snapshot, at: Date.now() }));
    anchorSnapshotSubagentCards(chatId, parentSessionId, snapshot.runs);
  }

  /**
   * 为快照里尚无卡片的 run 补卡。只改 `chatId` 指定的标签(绝不按 active tab
   * 归属),且只接受属于该父会话的 run;回退锚点由 `allowSnapshotFallback` 限定。
   */
  function anchorSnapshotSubagentCards(
    chatId: string,
    parentSessionId: string,
    runs: readonly SubagentRunProjection[],
  ): void {
    if (!Array.isArray(runs) || runs.length === 0) return;
    setChatTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== chatId) return tab;
        let nextItems = tab.items;
        for (const run of runs) {
          if (run.parentSessionId !== parentSessionId) continue;
          nextItems = insertSubagentRunCard(nextItems, {
            runId: run.runId,
            ...(run.clientMessageId === undefined ? {} : { clientMessageId: run.clientMessageId }),
            allowSnapshotFallback: true,
            allocateId: allocId,
          });
        }
        return nextItems === tab.items ? tab : { ...tab, items: nextItems };
      }),
    );
  }

  /** WS ready 后对每个绑定了会话的标签各对账一次;同一会话只跑一次。 */
  function reconcileBoundSubagentRuns(): void {
    const seen = new Set<string>();
    for (const tab of chatTabsRef.current) {
      const sessionId = tab.sessionId;
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      void reconcileSubagentRuns(tab.id, sessionId);
    }
  }

  /** 运行卡展开态只存 runId → 布尔,不进 reducer run 对象(设计 D26)。 */
  function toggleSubagentExpanded(runId: string): void {
    setExpandedByRunId((prev) => ({ ...prev, [runId]: prev[runId] !== true }));
  }

  /** 点「终止」只打开卡内二次确认,不发送任何 RPC。 */
  function requestCancelSubagent(runId: string): void {
    setConfirmingRunId(runId);
    setCancelErrorByRunId((prev) => withoutKey(prev, runId));
  }

  function dismissCancelSubagent(runId: string): void {
    setConfirmingRunId((prev) => (prev === runId ? null : prev));
  }

  /**
   * 定向终止(设计 D17 / B-05):只对仍活跃的 run 调 `subagent.cancel`,
   * 不碰父回合的执行态 / 停止票据;失败写回该卡的错误行。
   * 确认期间 run 已终态或失效时关闭确认且零 RPC。
   */
  async function confirmCancelSubagent(runId: string): Promise<void> {
    setConfirmingRunId((prev) => (prev === runId ? null : prev));
    const run = subagentRunsRef.current.runs.get(runId);
    if (!run || !isSubagentRunActive(run)) {
      setCancelErrorByRunId((prev) => withoutKey(prev, runId));
      return;
    }
    setCancelBusyByRunId((prev) => ({ ...prev, [runId]: true }));
    setCancelErrorByRunId((prev) => withoutKey(prev, runId));
    try {
      await rpcCall<SubagentCancelResult>("subagent.cancel", {
        parentSessionId: run.parentSessionId,
        runId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCancelErrorByRunId((prev) => ({ ...prev, [runId]: message }));
    } finally {
      setCancelBusyByRunId((prev) => withoutKey(prev, runId));
    }
  }

  /** 新建项目流程：Tauri 选文件夹 → 命名模态 → 创建并打开。 */
  async function createProjectFlow() {
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
      const minted = await rpcCall<{ sessionId?: string; cwd?: string }>("session.new", {
        fresh: chatId !== "work-1",
      });
      rememberMinted(minted);
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
    setHistoryView(null);
    setView("main");
    const id = `work-${nextChatSeq.current}`;
    nextChatSeq.current += 1;
    setChatTabs((prev) => {
      const tab = { id, label: `任务 ${prev.length + 1}`, items: [], sessionFailed: false, projectId: null, pendingPick: true };
      return [...prev, tab];
    });
    setActiveTab(id);
    liveChatRef.current = id;
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
      const projectRoot = tab.projectId ? projects.find((item) => item.id === tab.projectId)?.root : undefined;
      const minted = await rpcCall<{ sessionId?: string; cwd?: string }>("session.new", {
        fresh: true,
        ...(projectRoot ? { cwd: projectRoot } : {}),
      });
      rememberMinted(minted);
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
    if ((!text && !invokedAt) || sidecarDead || hostPhase !== "ok") return;
    if (tryOpenAutomationFromDraft(text)) return;
    // 同步重入护栏（R3-1）：按标签记录，覆盖到回合真正开始之前的整段异步前奏。
    // 它只挡同一标签的重入，不挡另一个标签。
    const chatId = activeTab;
    if (sendingRef.current.has(chatId)) return;
    sendingRef.current.add(chatId);
    try {
      liveChatRef.current = chatId;
      const sendingTab = chatTabs.find((tab) => tab.id === chatId);
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

      // 懒绑定会话：默认标签绑定通道稳定会话（跨重启延续），其余标签铸造独立会话。
      // cwd 只属于这条新会话：已绑定项目用项目根，未绑定项目用中立根。宿主不改前台工作区，
      // 因此这里也不再为了铸造会话去切工作区（ensureNeutralWorkspace / alignWorkspaceOnly）。
      if (!sessionId) {
        try {
          const cwd = await sessionCwdForTab(sendingTab);
          const minted = await rpcCall<{ sessionId?: string; cwd?: string }>("session.new", {
            fresh: chatId !== "work-1",
            ...(cwd ? { cwd } : {}),
          });
          rememberMinted(minted);
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
      // 本次发送的模型：本标签选择 > 子任务记住的模型 > 全局当前模型。
      const sendingTask = sendingTab?.taskId
        ? projectTasks.find((item) => item.id === sendingTab.taskId)
        : undefined;
      const modelId = resolveSendModelId(modelPickByTab, chatId, sendingTask?.modelId, activeModelId);
      // 注意：pendingPick 标签在此不再绑定 activeProjectId——项目归属只来自用户在 chip 里的显式选择
      // （applyOpenedProject），未选择的会话留在中立根，按 cwd 分组落入侧栏「任务」区。
      // 插入即标未启动：应答回来之前这条消息还没有开启回合，流式条目与终态选择都不能
      // 停在它后面。只有 started 应答（或排队项真正出队）才清掉这个标记。
      const userMsg: ChatItem = { id: allocId(), kind: "user", text, notStarted: true };
      setChatTabs((prev) => prev.map((tab) => (tab.id === chatId ? { ...tab, items: [...tab.items, userMsg] } : tab)));
      setDraft("");
      // 应答与 WebSocket 事件不保证先后：发送前先记下本次发送的身份（标签 + 本地消息 id），
      // 应答回来之前到达的事件按到达顺序暂存。pending 本身不开目标窗、不增加 epoch。
      const pending: PendingSend = {
        tabId: chatId,
        userId: userMsg.id,
        ...(sessionId ? { sessionId } : {}),
        buffered: [],
      };
      pendingSendsRef.current.set(chatId, pending);
      try {
        const sent = await rpcCall<SessionSendResult>("session.send", {
          text: invokedAt ? invokedAt.remainder : invokedSkill ? invokedSkill.remainder : text,
          tabId: chatId,
          ...(sessionId ? { sessionId } : {}),
          ...(modelId ? { modelId } : {}),
          ...(invokedAt
            ? { at: { name: invokedAt.name, clientMessageId: String(userMsg.id) } }
            : invokedSkill
              ? { skill: invokedSkill.name }
              : {}),
        });
        // 先写回身份：排队只追加等待项，started:true 才真正开始执行。
        writeTabRun(chatId, (state) => noteSendResult(state, sent));
        if (sent.waiting && sent.queueItemId !== undefined) {
          // 等待文案挂在已经插入的同一条用户消息上，不是标签级另一份列表。
          const queueItemId = sent.queueItemId;
          queueOwnersRef.current.set(queueItemId, { tabId: chatId, userId: userMsg.id });
          setChatTabs((prev) => prev.map((tab) => (
            tab.id === chatId
              ? {
                  ...tab,
                  items: tab.items.map((item) => (
                    item.kind === "user" && item.id === userMsg.id ? { ...item, queueItemId } : item
                  )),
                }
              : tab
          )));
        } else if (!sent.started) {
          // 宿主既没开始也没排队：这条消息不开启回合，也不参与最新用户消息的选择。
          setChatTabs((prev) => prev.map((tab) => (
            tab.id === chatId
              ? {
                  ...tab,
                  items: tab.items.map((item) => (
                    item.kind === "user" && item.id === userMsg.id ? { ...item, notStarted: true } : item
                  )),
                }
              : tab
          )));
        }
        if (sendOpensTurn(sent)) {
          // 回合真正开始：清掉插入时的未启动标记，这条消息从此是本标签的活动用户消息。
          setChatTabs((prev) => prev.map((tab) => (
            tab.id === chatId
              ? {
                  ...tab,
                  items: tab.items.map((item) => (
                    item.kind === "user" && item.id === userMsg.id ? startUserItem(item) : item
                  )),
                }
              : tab
          )));
          // 回合真正开始：只增加这条标签的 epoch，并记下这次的活动用户消息。
          openTurnForTab(
            chatId,
            typeof sent.sessionId === "string" && sent.sessionId ? sent.sessionId : sessionId ?? null,
            userMsg.id,
          );
        }
        // 对账以应答的 sessionId 为准:本地 mint 的 id 可能不是 sidecar 实际使用的会话。
        if (typeof sent.sessionId === "string" && sent.sessionId) {
          void reconcileSubagentRuns(chatId, sent.sessionId);
        }
        // 身份写回、回合初始化之后，最后按原顺序重放本次暂存的早到事件。
        for (const buffered of takePendingBuffer(pending, sent)) applySidecarEventRef.current(buffered);
      } catch (error) {
        // 只失败这一次发送：同标签正在执行的回合的停止闩锁、stopping、epoch 与执行态都不动。
        // 本次用户消息标成未启动，失败原因仍追加到发送标签（闩锁扣着也追加）。
        dropPending(pending);
        const note: ChatItem = { id: allocId(), kind: "note", text: error instanceof Error ? error.message : String(error) };
        setChatTabs((prev) =>
          prev.map((tab) =>
            tab.id === chatId
              ? {
                  ...tab,
                  // 该标签仍有正在执行的回合时，这条发送失败不是会话失败。
                  ...(tabRunOf(chatId).running ? {} : { sessionFailed: true }),
                  items: [
                    ...tab.items.map((item) => (
                      item.kind === "user" && item.id === userMsg.id ? { ...item, sendRejected: true } : item
                    )),
                    note,
                  ],
                }
              : tab,
          ),
        );
      }
    } finally {
      // 只清理本次发送的在途标记。
      sendingRef.current.delete(chatId);
    }
  }

  /**
   * 等待消息上的取消：只移掉这一条排队项，正在执行的回合照旧。
   * 取消后的消息留在列表里但标成未启动，不参与最新用户消息与终态选择。
   * 宿主不为取消回报事件，等待文案在本地撤掉；停止按钮仍只停整条回合。
   */
  async function cancelWaiting(queueItemId: string) {
    if (sidecarDead) return;
    const tabId = queueItemTab(queueItemId);
    if (tabId === undefined) return;
    writeTabRun(tabId, (state) => noteWaitingCancelled(state, queueItemId));
    clearQueueItem(tabId, queueItemId, "unstarted");
    try {
      await rpcCall("session.cancel", { queueItemId });
    } catch (error) {
      noteTab(tabId, `取消失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function stopTurn() {
    const tabId = activeChat.id;
    const turn = tabTurnOf(tabId);
    if (sidecarDead || !tabRunOf(tabId).running || !canStartStop(turn.pending)) return;
    const tabSession = chatTabs.find((tab) => tab.id === tabId)?.sessionId;
    const sessionId = resolveStopSession(turn.sessionId, tabSession);
    if (!sessionId) return;
    const ticket: StopTicket = { id: stopSeqRef.current + 1, sessionId, epoch: turn.epoch };
    stopSeqRef.current = ticket.id;
    patchTabTurn(tabId, { stopping: true, pending: ticket });
    const noteFor = (text: string) => {
      const note: ChatItem = { id: allocId(), kind: "note", text };
      setChatTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, items: [...tab.items, note] } : tab)));
    };
    try {
      await rpcCall("session.cancel", { sessionId });
      const settled = settleStop(tabId, ticket, true);
      if (settled.arm) {
        applyFinalForTab(tabId, ticket.sessionId, { kind: "session-end", ok: false, cancelled: true });
        setChatTabs((prev) => prev.map((tab) => (
          tab.id === tabId
            ? { ...tab, items: [...interruptTurnItems(tab.items), { id: allocId(), kind: "note" as const, text: "已停止" }] }
            : tab
        )));
      }
    } catch (error) {
      patchTabTurn(tabId, { stopping: false });
      const settled = settleStop(tabId, ticket, false);
      if (settled.note) noteFor(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 任务行与运行对话共用的停止入口。调用前快照该任务在途 runId；宿主回
   * stopped:false 时只摘掉快照里的条目。不能按 automationId 清空——调用在飞
   * 期间可能已经开了新一轮。
   */
  async function stopAutomationWithReconcile(automationId: string): Promise<{ stopped: boolean }> {
    const runIds = [...runningRuns]
      .filter(([, entry]) => entry.automationId === automationId)
      .map(([runId]) => runId);
    const result = await stopAutomation(automationId);
    if (!result.stopped) {
      setRunningRuns((prev) => dropRunningRunIds(prev, runIds));
    }
    return result;
  }

  /**
   * 运行对话的「停止」（规格 §8）：只走 automation.stop，不走普通用户回合的
   * stopTurn / session.cancel——那条路径会取消当前会话并改写回合闩锁。
   * stopped:false 表示调用时已无在途条目（竞态），由 reconciling 包装清掉陈旧条目。
   */
  async function stopRunTab() {
    const automationId = activeChat.automationId;
    const tabId = activeChat.id;
    if (!automationId || sidecarDead || stopRunInFlight.current) return;
    stopRunInFlight.current = true;
    setStopRunPending(true);
    try {
      await stopAutomationWithReconcile(automationId);
    } catch (error) {
      // 没有全局 toast：会话内脚注是既有的错误呈现方式（同发送路径）。
      // 落到点击停止时的标签，不跟着等待期间的当前激活标签走。
      noteTab(tabId, `停止失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      stopRunInFlight.current = false;
      setStopRunPending(false);
      void refreshAutomations();
    }
  }

  /**
   * 取消返回后才扣闩锁。比较的是这张标签自己的代际：轮次已经前进就只丢掉旧结束，
   * 不动新的一轮；另一个标签的回合不参与判定。
   */
  function settleStop(tabId: string, ticket: StopTicket, ok: boolean): { arm: boolean; note: boolean } {
    const turn = tabTurnOf(tabId);
    const done = finishStop({
      ticket,
      pending: turn.pending,
      currentEpoch: turn.epoch,
      ok,
      latchOwner: turn.latchOwner,
    });
    const patch: Partial<TabTurn> = { pending: done.pending };
    if (done.clearLatch) {
      patch.stopSessionId = null;
      patch.latchOwner = null;
    }
    if (done.arm) {
      patch.stopSessionId = ticket.sessionId;
      patch.latchOwner = ticket.id;
      patch.stopping = false;
    }
    patchTabTurn(tabId, patch);
    staleIdleRef.current = rememberStale(staleIdleRef.current, done.stale);
    if (done.arm) writeTabRun(tabId, noteTurnEnded);
    releaseHeldEnds(ticket.sessionId);
    return { arm: done.arm, note: done.note };
  }

  function releaseHeldEnds(sessionId: string) {
    const released = takeHeldEnds(heldEndsRef.current, sessionId, sessionIdOfEvent);
    heldEndsRef.current = released.rest;
    for (const end of released.taken) applySidecarEventRef.current(end);
  }

  function toggleThinking(itemId: number, userToggled: "expand" | "collapse") {
    setChatTabs((prev) => prev.map((tab) => {
      const items = withThinkingToggle(tab.items, itemId, userToggled);
      return items === tab.items ? tab : { ...tab, items: [...items] };
    }));
  }

  /** 手动展开/收起记在锚点工具条目上：随标签保留，压过按回合状态的自动折叠。 */
  function toggleToolPanel(anchorId: number, next: PanelToggle) {
    setChatTabs((prev) => prev.map((tab) => {
      const items = withToolPanelToggle(tab.items, anchorId, next);
      return items === tab.items ? tab : { ...tab, items: [...items] };
    }));
  }

  /** 点附件：留在当前对话，右侧切到预览并展开（规格 §5）。 */
  function handleOpenAttachment(file: ResultAttachmentFile) {
    setChatTabs((prev) => prev.map((tab) => (tab.id === activeTab ? { ...tab, previewFile: file } : tab)));
    setRightTab("preview");
    setRightCollapsed(false);
  }

  /**
   * 只下载当前打开的这一份（规格 §5）：渲染进程用附件的展示文件名发起 Blob 下载，
   * 内容与预览同源（Markdown 原文 / 完整 HTML 文档）。不写文件、不走宿主 RPC。
   */
  function downloadAttachment(file: ResultAttachmentFile, sourceText: string) {
    const markdown = file === RESULT_ATTACHMENT_FILES[0];
    const content = markdown ? renderResultMarkdown(sourceText) : renderResultHtml(sourceText);
    const blob = new Blob([content], { type: markdown ? "text/markdown" : "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file;
    anchor.click();
    // 下载已经发起后再释放；立即 revoke 会让尚未启动的下载拿到失效 URL。
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
    // 没有审批登记的说明卡点了只会静默失败:不发起 RPC,也不改卡片。
    if (!askCardWaitsForClick(card)) return;
    const method = decision === "approve" ? "session.approve" : "session.reject";
    await rpcCall(method, { approvalRequestId: card.approvalRequestId });
    // 卡片可能属于非当前查看的标签（liveChatRef 只表示谁拥有当前流）:按卡片自己的标签回写。
    answerApprovalInTabs(card.approvalRequestId, decision, setChatTabs);
  }

  /** `request_input` 卡片：提交的文字回到同一回合；取消结束这次调用并停止回合。 */
  async function answerInput(itemId: number, card: InputCard, reply: { answer: string } | { cancel: true }): Promise<boolean> {
    if (sidecarDead || card.state !== "open" || inputReplyPendingRef.current) return false;
    inputReplyPendingRef.current = true;
    setInputReplyPending(true);
    try {
      const result = await rpcCall<{ handled?: boolean }>("session.answerInput", { sessionId: card.sessionId, ...reply });
      const handled = result?.handled === true;
      // 宿主那边已不在等（回合已结束或问题被替换）：卡片关掉，不显示「已回答」。
      const state = !handled ? "closed" : "cancel" in reply ? "cancelled" : "answered";
      const answerText = state === "answered" && "answer" in reply ? reply.answer : undefined;
      setChatTabs((prev) => prev.map((tab) => {
        const items = settleInputCard(tab.items, itemId, state, answerText);
        return items === tab.items ? tab : { ...tab, items };
      }));
      return handled;
    } catch (error) {
      noteActive(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      inputReplyPendingRef.current = false;
      setInputReplyPending(false);
    }
  }

  async function submitComposer() {
    if (sidecarDead || hostPhase !== "ok" || inputReplyPendingRef.current) return;
    const submittedDraft = draft;
    const result = await dispatchComposerSubmission(activeChat.items, submittedDraft, {
      answer: (itemId, card, answer) => answerInput(itemId, card, { answer }),
      send,
    });
    if (result.kind === "answer" && result.answered) {
      setDraft((current) => (current === submittedDraft ? "" : current));
    }
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
          card: {
            key: callId ?? `tool-${allocId()}`,
            name: item.name,
            ...(callId ? { callId } : {}),
            status: "end",
            ...(item.args === undefined ? {} : { args: item.args }),
            ...(item.command === undefined ? {} : { command: item.command }),
            ...(item.output === undefined ? {} : { output: item.output }),
            hasResult: item.hasResult,
            ...(item.resultMissing === true ? { resultMissing: true } : {}),
            ...(item.interrupted === true ? { interrupted: true } : {}),
            ...(item.truncated === true ? { truncated: true } : {}),
            ...(item.isError === true ? { isError: true } : {}),
          },
        };
      }
      if (item.kind === "user") return { id: allocId(), kind: "user", text: item.text };
      if (item.kind === "thinking") {
        return { id: allocId(), kind: "thinking", thought: item.text, interrupted: false, historical: true };
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
    const existing = chatTabs.find((tab) => tab.sessionId === sessionId);
    if (existing) {
      // 已有标签的运行态（含子代理运行卡）是权威的:只撤失败标记,不用历史快照覆盖。
      setChatTabs((prev) =>
        prev.map((tab) => (tab.id === existing.id && tab.sessionFailed ? { ...tab, sessionFailed: false } : tab)),
      );
      setActiveTab(existing.id);
    } else {
      const id = `work-${nextChatSeq.current}`;
      nextChatSeq.current += 1;
      const label = view.title && view.title !== sessionId ? view.title.slice(0, 24) : `任务 ${nextChatSeq.current - 1}`;
      const items = historyToChatItems(view);
      // 防御：恢复的标签一律不绑项目（评审 P2-4），杜绝『有历史却命中懒创建』
      setChatTabs((prev) => [
        ...prev,
        {
          id,
          label,
          items,
          sessionFailed: false,
          projectId: null,
          pendingPick: false,
          sessionId,
          turnFinalByUserId: historicalTurnFinalByUserId(items),
          turnFinalWithoutUser: true,
        },
      ]);
      setActiveTab(id);
      // 历史回放只有消息条目:补拉宿主快照,把上次运行留下的子代理运行卡补回来。
      void reconcileSubagentRuns(id, sessionId);
    }
    setHistoryView(null);
    setView("main");
  }

  /** 「继续此会话」按钮：从历史详情视图恢复；打开失败的历史页先重试打开。 */
  async function resumeHistorySession() {
    const view = historyView;
    if (!view) return;
    if (view.records.length === 0) {
      await openFreeSession(view.sessionId);
      return;
    }
    await resumeFromView({ ...view, error: undefined });
  }

  async function removeSession(sessionId: string) {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      // 只处理把这条会话当回合跟踪的标签：其它标签正在执行的回合不受删除影响。
      const sessionTabId = tabIdForSession(sessionId);
      if (sessionTabId !== undefined && tabTurnOf(sessionTabId).sessionId === sessionId) {
        try {
          await rpcCall("session.cancel", { sessionId });
        } catch {
          // 日志马上删掉；取消失败也不再把停止按钮留在一个没有会话的标签上。
        }
        patchTabTurn(sessionTabId, {
          sessionId: null,
          pending: null,
          stopSessionId: null,
          latchOwner: null,
          stopping: false,
        });
        writeTabRun(sessionTabId, noteTurnEnded);
      }
      await rpcCall("session.remove", { sessionId });
      // 会话日志没了，沿用它的标签也拿不到可归属的排队项：清掉在途发送与等待项归属。
      for (const tab of chatTabsRef.current) {
        if (tab.sessionId === sessionId) pruneTabBookkeeping(tab.id);
      }
      setSessions((prev) => prev.filter((session, index) => String(session.id ?? `session-${index}`) !== sessionId));
      setHistoryView((view) => (view?.sessionId === sessionId ? null : view));
      setChatTabs((prev) => prev.map((tab) => (
        tab.sessionId === sessionId
          ? { ...tab, items: [], sessionId: undefined, sessionFailed: false }
          : tab
      )));
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
   * 运行对话标签仅在「这一轮自动化运行进行中」锁输入；运行结束后可继续对话（规格 L544 修订，
   * 发送路径会自动对齐工作区到运行会话目录）。判据按 runId：同一任务的新一轮开跑后，
   * 旧一轮的标签不再显示「停止」，否则点下去停的是最新那轮。
   */
  const runTabLive = isRunTabLive(activeChat.id, runningRunIds);
  const chatEmpty = items.length === 0;
  /** 自动化运行对话（live tab）：不进最近对话/历史列表。 */
  const runTabs = chatTabs.filter((tab) => tab.automationId);
  /** 「任务」区的游离会话：中立工作区对话（项目分组已退役，项目会话收编进子任务）。 */
  const unscopedWorkSessions = unscopedSessions(sessions, projects);
  const showRightPane = view === "main";
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const pendingAsk = hasPendingAsk(chatTabs);
  const logoutDisabled = anyTabRunning || pendingAsk;

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
            {hostNotice.kind === "unresponsive" ? <p className="side-muted">{HOST_UNRESPONSIVE_TEXT}</p> : null}
            {unscopedWorkSessions.length === 0 && runTabs.length === 0 ? (
              <p className="side-muted">暂无任务</p>
            ) : (
              <ul className="recent-list">
                {/* 进行中的自动化运行对话：每次运行在「任务」区新建一个对话。 */}
                {runTabs.map((tab) => {
                  const running = isRunTabLive(tab.id, runningRunIds);
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
                        <span className="recent-meta">自动化运行{running ? " · 运行中" : ""}{hostNotice.kind === "unresponsive" ? ` · ${HOST_UNRESPONSIVE_TEXT}` : ""}</span>
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
                        <span className="recent-meta">{sessionMetaOf(session)}{hostNotice.kind === "unresponsive" ? ` · ${HOST_UNRESPONSIVE_TEXT}` : ""}</span>
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
                disabled={sidecarDead}
                onClick={() => void createProjectFlow()}
              >
                ＋ 新建
              </button>
            </header>
            {hostNotice.kind === "unresponsive" ? <p className="side-muted">{HOST_UNRESPONSIVE_TEXT}</p> : null}
            <ProjectsPanel
              projects={projects}
              activeProjectId={activeProjectId}
              subtasks={projectTasks}
              selectedTaskId={selectedTaskId}
              disabled={sidecarDead || selectBusy}
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
          {hostNotice.kind === "unresponsive" ? (
            <div className="banner warn" role="status">
              {HOST_UNRESPONSIVE_TEXT}
              {hostNotice.canStop ? (
                <button type="button" className="chip" onClick={() => void hostLivenessBridge()?.requestStop()}>
                  结束进程
                </button>
              ) : null}
            </div>
          ) : null}
          {hostNotice.kind === "stopped" ? (
            // The focused window never receives notifyAttention, so the neutral
            // stop phrase must live in the app itself. No error banner, no restart.
            <div className="banner" role="status">{hostNotice.text}</div>
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
              onStopAutomation={stopAutomationWithReconcile}
              enterIntent={automationEnter}
              onEnterIntentConsumed={() => setAutomationEnter(null)}
              onChanged={() => void refreshAutomations()}
              onRunDeleted={handleRunDeleted}
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
            <AgentsView agentChangeSignal={agentChangeSignal} />
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
              <div className="chat-log" key={activeChat.id}>
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
                {toolRows.map((row) => row.kind === "panel" ? (
                  <ToolPanel key={row.id} panel={row.panel} onToggle={toggleToolPanel} />
                ) : (
                  <ChatRow
                    key={row.item.id}
                    item={row.item}
                    blocked={blocked}
                    subagent={subagentChat}
                    onAnswer={answer}
                    onInput={answerInput}
                    onThinkingToggle={toggleThinking}
                    onOpenAttachment={handleOpenAttachment}
                    onCancelWaiting={(queueItemId) => void cancelWaiting(queueItemId)}
                    reasoning={row.item.kind === "assistant" ? (thinkingBefore(items, row.index)?.thought ?? "") : ""}
                    hasAssistantText={
                      row.item.kind === "thinking"
                        ? hasAssistantTextAfter(contentView, contentIndexById.get(row.item.id) ?? -1)
                        : false
                    }
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
                void submitComposer();
              }}
            >
              {pendingInput ? <div className="composer-context">正在回答：{pendingInput.card.question}</div> : null}
              {!pendingInput && slashOpen ? (
                <SlashSkillMenu
                  skills={slashMatches}
                  activeIndex={slashIndex}
                  onHover={setSlashIndex}
                  onPick={pickSlashSkill}
                />
              ) : !pendingInput && atOpen ? (
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
                  pendingInput
                    ? "请输入回答，Enter 提交，Shift+Enter 换行"
                    : runTabLive
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
                  if (!pendingInput && slashOpen) {
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
                  } else if (!pendingInput && atOpen) {
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
                    void submitComposer();
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
                {sendModelLabel ? (
                  <ModelChip
                    label={sendModelLabel}
                    models={savedModels}
                    activeId={sendModelId}
                    onSelect={(id) => void selectTabModel(id)}
                    onManage={() => openSettings("model")}
                  />
                ) : null}
                {planModeActive(items) ? (
                  <button type="button" className="chip" disabled={blocked} onClick={() => void exitPlanMode()}>
                    退出计划模式
                  </button>
                ) : null}
                <span className="composer-spacer" />
                {pendingInput ? (
                  <button
                    type="submit"
                    className="send"
                    aria-label="提交回答"
                    disabled={blocked || inputReplyPending || !draft.trim() || hostPhase !== "ok"}
                  >
                    ↑
                  </button>
                ) : tabRuns[activeChat.id]?.running === true ? (
                  <button type="button" className="send stop" disabled={blocked} onClick={() => void stopTurn()}>
                    停止
                  </button>
                ) : runTabLive ? (
                  // 运行对话的停止只停这一轮自动化，不碰普通用户回合的 stopTurn / session.cancel。
                  <button
                    type="button"
                    className="send stop"
                    disabled={blocked || stopRunPending}
                    onClick={() => void stopRunTab()}
                  >
                    {stopRunPending ? "停止中…" : "停止"}
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
                previewFile && previewAttachment ? (
                  <div className="panel-card preview-card">
                    <p className="h preview-head">
                      <span>{previewFile}</span>
                      <button
                        type="button"
                        className="side-action"
                        onClick={() => downloadAttachment(previewFile, previewAttachment.sourceText)}
                      >
                        下载
                      </button>
                    </p>
                    {previewFile === RESULT_ATTACHMENT_FILES[0] ? (
                      <pre className="preview-md">{previewContent ?? ""}</pre>
                    ) : (
                      <iframe
                        className="preview-frame"
                        sandbox=""
                        title="结果"
                        srcDoc={previewContent ?? ""}
                      />
                    )}
                  </div>
                ) : (
                  <div className="panel-card">
                    <p className="h">预览</p>
                    <p className="panel-empty">AI 生成的摘要、代码片段等预览内容会显示在这里</p>
                  </div>
                )
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

const COMPACTION_NOTE = "更早的工具输出已被压缩";

function handleEvent(
  event: RpcEvent,
  allocId: () => number,
  setReady: (ready: boolean) => void,
  setItems: (updater: (prev: ChatItem[]) => ChatItem[], sessionId?: string) => void,
  setTurnRunning: (running: boolean, sessionId?: string) => void,
  setSessionFailed: (failed: boolean, sessionId?: string) => void,
  refreshRecent: () => Promise<void>,
  sawReady: MutableRefObject<boolean>,
  endsTrackedTurn: boolean,
  userStopped: boolean,
  drivesTrackedTurn: boolean,
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
      setItems((prev) => appendToken(prev, event.text, allocId), event.sessionId);
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
      setItems(
        (prev) => insertTurnItem(prev, {
          id: allocId(),
          kind: "tool",
          card: {
            key: event.callId ?? `${event.name}-${prev.length}`,
            name: event.name,
            callId: event.callId,
            status: "start",
            ...(event.args === undefined ? {} : { args: event.args }),
            ...(event.command === undefined ? {} : { command: event.command }),
          },
        }),
        event.sessionId,
      );
      break;
    case "tool/end":
      setItems((prev) => applyToolEnd(prev, event), event.sessionId);
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
          actionable: event.actionable,
        },
      };
      setItems((prev) => (event.toolName === "plan-review" ? insertBeforeToolRow(prev, ask, event.callId) : insertTurnItem(prev, ask)), event.sessionId);
      break;
    }
    case "input/asked":
      setItems((prev) => appendOpenInputInTurn(prev, allocId(), event.question, event.sessionId), event.sessionId);
      break;
    case "compaction/done":
      // 固定提示走聊天 note，不进思考面板。
      setItems((prev) => insertTurnItem(prev, { id: allocId(), kind: "note", text: COMPACTION_NOTE }), event.sessionId);
      break;
    case "goal/round":
      // 官方驱动器开了新一轮：只恢复事件所属标签的执行态；后台会话的续轮
      // 只把说明写进它自己的标签，不能卡住其它标签。
      if (drivesTrackedTurn) setTurnRunning(true, event.sessionId);
      setItems((prev) => insertTurnItem(prev, { id: allocId(), kind: "note", text: goalRoundLabel(event.round) }), event.sessionId);
      break;
    case "session/end":
      if (endsTrackedTurn) setTurnRunning(false, event.sessionId);
      // 回合结束刷新会话列表（任务区/最近对话）。日志写回是 ~200ms 批处理，
      // 等一拍再拉，避免新会话因 messageCount 仍为 0 被空壳过滤漏掉。
      setTimeout(() => void refreshRecent(), 600);
      setItems((prev) => closeOpenInputs(prev), event.sessionId);
      if (event.cancelled || !event.ok || userStopped) {
        setItems((prev) => interruptTurnItems(prev), event.sessionId);
      }
      if (event.cancelled || userStopped) break;
      if (!event.ok) {
        setSessionFailed(true, event.sessionId);
        setItems(
          (prev) => insertTurnItem(prev, { id: allocId(), kind: "note", text: event.error ?? "会话失败（保留 diff，不回滚）" }),
          event.sessionId,
        );
      }
      break;
  }
}

/**
 * 活动回合的写入位置：第一条未启动用户消息之前，没有就追加到末尾。
 * 排队中（带 `queueItemId`）、本次已抛错（`sendRejected`）或宿主没启动（`notStarted`）
 * 的消息虽然排在后面，但还没开启回合，流式条目必须落在它们前面。
 * 标签还没有任何已启动回合时（首条消息刚插入、应答未回），这条消息就是回合的开头，
 * 写入位置是末尾——不能把流式正文插到问题前面。
 */
function turnAppendIndex(items: readonly ChatItem[]): number {
  const turnStart = currentTurnStart(items);
  if (turnStart === 0) return items.length;
  for (let index = turnStart; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind === "user" && isUnstartedUserItem(item)) return index;
  }
  return items.length;
}

/**
 * 这条用户消息真正成为活动回合：去掉等待项与插入时的未启动标记。
 * 直接应答 `started: true` 与排队项真正出队都走这里。
 */
export function startUserItem<T extends { queueItemId?: string; notStarted?: boolean }>(item: T): T {
  const {
    queueItemId: _queueItemId,
    notStarted: _notStarted,
    ...started
  } = item;
  return started as T;
}

/** 本回合内的条目（工具行、审批卡、脚注）写在本回合的写入位置；没有排队消息时追加到末尾。 */
export function insertTurnItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const at = turnAppendIndex(items);
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/**
 * `request_input` 的卡片：先关掉没人回答的旧卡，再放进本回合的写入位置。
 * `appendOpenInput` 只会追加到末尾，这里把新卡挪回活动回合内，排队消息之后不再落卡片。
 */
export function appendOpenInputInTurn(items: ChatItem[], id: number, question: string, sessionId: string): ChatItem[] {
  const withCard = appendOpenInput(items, id, question, sessionId);
  const card = withCard[withCard.length - 1];
  if (!card) return withCard;
  return insertTurnItem(withCard.slice(0, -1), card);
}

/**
 * 本回合核对与结算归属的用户消息：以该标签记录的活动消息为准；
 * 还没记录（历史标签、自动化运行标签）时回落到最后一条已启动的用户消息。
 * 应答回来之前刚插入的那条（带 `notStarted`）不会被选中。
 */
export function turnUserIdFor(
  turn: Pick<TabTurn, "activeUserId">,
  items: Parameters<typeof latestUserItemId>[0],
): number | undefined {
  return turn.activeUserId ?? latestUserItemId(items);
}

/**
 * 排队项出队时该标签的新状态：归属消息还在才开始执行并置 `running`；
 * 归属消息已被取消或删除时只收掉这条等待项，不碰该标签的回合态
 * （同一标签上可能有另一个真正执行中的回合，不能替它结束）。
 *
 * @param state 该标签当前的回合状态
 * @param queueItemId 出队的排队项
 * @param hasOwner 该排队项是否仍挂着一条未启动的用户消息
 * @returns 更新后的状态
 */
export function queuedTurnRunState(state: TabRunState, queueItemId: string, hasOwner: boolean): TabRunState {
  return hasOwner
    ? noteWaitingStarted(state, queueItemId)
    : noteWaitingCancelled(state, queueItemId);
}

/** 本回合只保留最新一份待办列表（todo_write 每次发送完整替换列表）。 */
export function upsertTodoItem(items: ChatItem[], todos: TodoEntry[], allocId: () => number): ChatItem[] {
  const turnStart = currentTurnStart(items);
  const at = items.findIndex((item, index) => index >= turnStart && item.kind === "todo");
  if (at >= 0) return items.map((item, index) => (index === at ? { ...item, todos } : item));
  const insertAt = turnAppendIndex(items);
  return [...items.slice(0, insertAt), { id: allocId(), kind: "todo", todos }, ...items.slice(insertAt)];
}

/** 计划卡画在本回合 `exit_plan_mode` 那一行工具之前；找不到那一行就落在排队消息之前。 */
export function insertBeforeToolRow(items: ChatItem[], card: ChatItem, callId: string | undefined): ChatItem[] {
  const turnStart = currentTurnStart(items);
  const at = items.findIndex(
    (item, index) =>
      index >= turnStart &&
      item.kind === "tool" &&
      (callId ? item.card.callId === callId : item.card.name === "exit_plan_mode"),
  );
  if (at >= 0) return [...items.slice(0, at), card, ...items.slice(at)];
  const insertAt = turnAppendIndex(items);
  return [...items.slice(0, insertAt), card, ...items.slice(insertAt)];
}

/** 流式正文接在活动回合末尾；排队消息把末尾顶开时仍写回它自己那个回合。 */
export function appendToken(items: ChatItem[], text: string, allocId: () => number): ChatItem[] {
  const insertAt = turnAppendIndex(items);
  const last = insertAt > 0 ? items[insertAt - 1] : undefined;
  if (last?.kind === "assistant") {
    return [...items.slice(0, insertAt - 1), { ...last, text: last.text + text }, ...items.slice(insertAt)];
  }
  return [...items.slice(0, insertAt), { id: allocId(), kind: "assistant", text }, ...items.slice(insertAt)];
}

type ContentChatItem = Exclude<
  ChatItem,
  { kind: "attachment" } | { kind: "agent-confirm" } | { kind: "subagent-run" }
>;

/** 删除记录里的一个键;原本不存在时返回入参,React 状态可跳过更新。 */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * 回合核对与思考折叠用的对话内容视图：结果附件是折叠后的 JSON 渲染项，
 * 在内容视图里等价于一整段助手正文（同 id、同位置，正文取 sourceText）。
 * 创建确认卡映射成空 note——它不参与文件/命令核对，也不结束思考；用占位而不是
 * 删除，是为了让其余条目的相对顺序与 `thinkingBefore` 的 items 下标保持稳定。
 * 子代理运行卡没有内容和回合语义，直接从内容视图里剔除；`hasAssistantTextAfter`
 * 因此改用 id 映射后的内容视图下标（见调用方），不能再直接用 `items` 下标。
 *
 * 这直接决定思考面板的收尾状态：`hasAssistantTextAfter` 只认 assistant，
 * 若附件映射成空 note，运行结束后那条思考仍会展开并显示「进行中」。
 * 回合核对只读 user / tool / plan-review，不读 assistant，因此不受影响。
 */
function contentItems(items: readonly ChatItem[]): ContentChatItem[] {
  const visible: ContentChatItem[] = [];
  for (const item of items) {
    if (item.kind === "subagent-run") continue;
    visible.push(contentItem(item));
  }
  return visible;
}

function contentItem(item: Exclude<ChatItem, { kind: "subagent-run" }>): ContentChatItem {
  if (item.kind === "agent-confirm") return { id: item.id, kind: "note", text: "" };
  return item.kind === "attachment" ? attachmentAsAssistant(item) : item;
}

/** 同一回合只保留一块思考：非 final 追加当前步骤，final 只替换当前步骤，工具调用前已定稿的步骤保留。 */
export function applyReasoning(items: ChatItem[], text: string, final: boolean, allocId: () => number): ChatItem[] {
  const turnStart = currentTurnStart(items);
  const existing = items.findIndex((item, index) => index >= turnStart && item.kind === "thinking");
  if (existing >= 0) {
    const current = items[existing];
    if (current?.kind !== "thinking") return items;
    const steps = nextThinkingSteps(current.steps ?? { settled: current.thought, draft: "" }, text, final);
    const next = items.slice();
    next[existing] = { ...current, thought: thinkingStepsText(steps), steps };
    return next;
  }
  const steps = nextThinkingSteps({ settled: "", draft: "" }, text, final);
  const created: ChatItem = { id: allocId(), kind: "thinking", thought: thinkingStepsText(steps), interrupted: false, steps };
  const assistantAt = items.findIndex((item, index) => index >= turnStart && item.kind === "assistant");
  if (assistantAt >= 0) return [...items.slice(0, assistantAt), created, ...items.slice(assistantAt)];
  const insertAt = turnAppendIndex(items);
  return [...items.slice(0, insertAt), created, ...items.slice(insertAt)];
}

/** 运行卡渲染所需的 reducer 投影与 App 侧 UI 状态；UI 状态不写进 reducer run 对象。 */
type SubagentChatView = {
  runs: ReadonlyMap<string, SubagentRunView>;
  now: number;
  frozenAt?: number;
  expandedByRunId: Readonly<Record<string, boolean>>;
  confirmingRunId: string | null;
  cancelBusyByRunId: Readonly<Record<string, boolean>>;
  cancelErrorByRunId: Readonly<Record<string, string>>;
  onToggleExpanded(runId: string): void;
  onRequestCancel(runId: string): void;
  onConfirmCancel(runId: string): void;
  onDismissCancel(runId: string): void;
};

function ChatRow({
  item,
  blocked,
  subagent,
  onAnswer,
  onInput,
  onThinkingToggle,
  onOpenAttachment,
  onCancelWaiting,
  reasoning = "",
  hasAssistantText = false,
}: {
  item: Exclude<ChatItem, { kind: "tool" }>;
  blocked: boolean;
  subagent: SubagentChatView;
  onAnswer: (card: AskCard, decision: "approve" | "reject") => void;
  onInput: (itemId: number, card: InputCard, reply: { answer: string } | { cancel: true }) => void;
  onThinkingToggle?: (itemId: number, userToggled: "expand" | "collapse") => void;
  onOpenAttachment?: (file: ResultAttachmentFile) => void;
  /** 等待中的用户消息：取消这一条排队项。 */
  onCancelWaiting?: (queueItemId: string) => void;
  reasoning?: string;
  hasAssistantText?: boolean;
}) {
  if (item.kind === "subagent-run") {
    // 卡片只读 reducer 投影；run 已被移除时渲染为空，不保留过期卡片。
    const run = subagent.runs.get(item.runId);
    if (!run) return null;
    const sameParentRuns = [...subagent.runs.values()].filter(
      (other) => other.parentSessionId === run.parentSessionId,
    );
    return (
      <SubagentRunCard
        run={run}
        now={subagent.now}
        frozenAt={subagent.frozenAt}
        duplicateLabel={subagentNeedsStartTime(run, sameParentRuns)}
        expanded={subagent.expandedByRunId[run.runId] === true}
        confirming={subagent.confirmingRunId === run.runId}
        cancelBusy={subagent.cancelBusyByRunId[run.runId] === true || run.phase === "stopping"}
        cancelError={subagent.cancelErrorByRunId[run.runId]}
        onToggleExpanded={subagent.onToggleExpanded}
        onRequestCancel={subagent.onRequestCancel}
        onConfirmCancel={subagent.onConfirmCancel}
        onDismissCancel={subagent.onDismissCancel}
      />
    );
  }
  if (item.kind === "user") {
    if (item.queueItemId !== undefined) {
      const queueItemId = item.queueItemId;
      return (
        <div className="bubble user">
          {item.text}
          <div className="note">
            等待当前任务
            <button type="button" className="chip" disabled={blocked} onClick={() => onCancelWaiting?.(queueItemId)}>
              取消
            </button>
          </div>
        </div>
      );
    }
    return <div className="bubble user">{item.text}</div>;
  }
  if (item.kind === "thinking") {
    if (!shouldRenderThinking(item.thought)) return null;
    return (
      <ThinkingPanel
        thought={item.thought}
        hasAssistantText={hasAssistantText}
        interrupted={item.interrupted}
        historical={item.historical === true}
        userToggled={item.userToggled ?? null}
        onToggle={onThinkingToggle ? (next) => onThinkingToggle(item.id, next) : undefined}
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
          <ThinkingPanel
            thought={panelThought}
            hasAssistantText={answerReady}
            interrupted={item.interrupted === true}
            userToggled={item.userToggled ?? null}
            onToggle={onThinkingToggle ? (next) => onThinkingToggle(item.id, next) : undefined}
          />
        ) : null}
        {answerReady ? <div className="bubble assistant">{visible}</div> : null}
      </>
    );
  }
  if (item.kind === "note") return <div className="note">{item.text}</div>;
  if (item.kind === "agent-confirm") return <AgentConfirmCard card={item.card} />;
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
  if (item.kind === "attachment") {
    return (
      <div className="attachment-row">
        {RESULT_ATTACHMENT_FILES.map((file) => (
          <button key={file} type="button" className="attachment-file" onClick={() => onOpenAttachment?.(file)}>
            {file}
          </button>
        ))}
      </div>
    );
  }
  if (item.kind === "input") return <InputCardView itemId={item.id} card={item.card} blocked={blocked} onInput={onInput} />;
  if (item.card.toolName === "plan-review") return <PlanCard card={item.card} blocked={blocked} onAnswer={onAnswer} />;
  return (
    <div className="card ask-card">
      <span className="ttl">✋ 批准请求 · {item.card.toolName}</span>
      {item.card.summary ? <pre>{item.card.summary}</pre> : null}
      {item.card.actionable === false ? (
        // 说明卡没有审批登记：只讲一遍原因，不显示原始请求 id，也不渲染按钮。
        <p style={{ margin: 0 }}>{item.card.reason ?? "没有人接到这个请求，无法在这里回答"}</p>
      ) : (
        <>
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
        </>
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
      ) : card.actionable === false ? (
        <p style={{ margin: 0 }}>{card.reason ?? "没有人接到这个请求，无法在这里回答"}</p>
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

/** 模型用 `request_input` 提的问题：在底部会话框作答，取消后这一回合停止。 */
export function InputCardView({
  itemId,
  card,
  blocked,
  onInput,
}: {
  itemId: number;
  card: InputCard;
  blocked: boolean;
  onInput: (itemId: number, card: InputCard, reply: { answer: string } | { cancel: true }) => void;
}) {
  const status = inputCardStatus(card);
  return (
    <div className="card ask-card">
      <span className="ttl">需要你回答</span>
      <p style={{ margin: 0 }}>{card.question}</p>
      {status ? (
        <p style={{ margin: 0 }}>{status}</p>
      ) : (
        <div className="row">
          <button type="button" className="btn reject" disabled={blocked} onClick={() => onInput(itemId, card, { cancel: true })}>
            取消
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

function activityKind(event: RpcEvent): "reasoning" | "text" | "tool" | null {
  if (event.event === "reasoning") return "reasoning";
  if (event.event === "token") return "text";
  if (event.event === "tool/end") return "tool";
  return null;
}

/** `RpcEvent` 联合里有些成员不带 sessionId；按会话取回暂扣的结束事件时显式收窄。 */
function sessionIdOfEvent(event: RpcEvent): string | undefined {
  return "sessionId" in event ? event.sessionId : undefined;
}
