/**
 * 旧 sidecar 三面 61 例对账。label 四态:已覆盖 / Task N 新增 / 本任务补 / 裁定不移植。
 * 非「裁定不移植」的 evidence 必须是可追溯行号。
 */
export interface TestPortRow {
  file: string
  title: string
  label: string
  evidence: string
}

export const PORT_LABEL_PATTERN = /^(?:已覆盖|本任务补|裁定不移植|Task [1-7] 新增)$/

export const testPortMapping: TestPortRow[] = [
  {
    file: 'loop.test.ts',
    title: 'write lands and diff is nonempty',
    label: '本任务补',
    evidence: 'tests/huaanwork-guardrails/bridge.spec.ts:186',
  },
  {
    file: 'loop.test.ts',
    title: 'non-whitelist bash asks then reject does not execute',
    label: '已覆盖',
    evidence: 'scripts/huaanwork-host-loop.spec.mjs:522',
  },
  {
    file: 'loop.test.ts',
    title: 'test-fix fails then write then pass without git tools',
    label: '已覆盖',
    evidence: 'tests/huaanwork-guardrails/skills.spec.ts:327',
  },
  {
    file: 'loop.test.ts',
    title: 'test-fix five failing rounds summarize remaining failures and keep writes',
    label: '已覆盖',
    evidence: 'tests/huaanwork-guardrails/skills.spec.ts:392',
  },
  {
    file: 'loop.test.ts',
    title: 'explore subagent bash is denied and parent only sees the conclusion',
    label: '本任务补',
    evidence: 'tests/huaanwork-guardrails/skills.spec.ts:243',
  },
  {
    file: 'loop.test.ts',
    title: 'more than 40 tool calls still finish without a session cap',
    label: '已覆盖',
    evidence: 'tests/huaanwork-guardrails/skills.spec.ts:345',
  },
  {
    file: 'loop.test.ts',
    title: 'same tool and key args failing three times stops without rollback',
    label: '已覆盖',
    evidence: 'tests/huaanwork-guardrails/skills.spec.ts:364',
  },
  {
    file: 'loop.test.ts',
    title: 'session.cancel stops an in-flight turn without failing the session',
    label: '已覆盖',
    evidence: 'scripts/huaanwork-host-loop.spec.mjs:553',
  },
  {
    file: 'loop.test.ts',
    title: '@http catalog path: call_host_tool attached, cross-tab denied, and disable immediate',
    label: '已覆盖',
    evidence: 'tests/huaanwork-guardrails/present-as.cordis.spec.ts:134',
  },
  {
    file: 'loop.test.ts',
    title: '@http local endpoint: addEndpoint attaches tool, removal immediately denies without refresh',
    label: 'Task 2 新增',
    evidence: 'tests/huaanwork-host/agents-host.spec.ts:313',
  },
  {
    file: 'loop.test.ts',
    title: '@agent persona catalog: bridged tokens, session.list single tab, and clean cancel',
    label: '已覆盖',
    evidence: 'tests/huaanwork-host/sessions.spec.ts:196',
  },
  {
    file: 'loop.test.ts',
    title: 'baseline without @: no mcp__* in agentToolNames and explore subagent has no call_host_tool',
    label: '本任务补',
    evidence: 'tests/huaanwork-guardrails/skills.spec.ts:287',
  },
  {
    file: 'loop.test.ts',
    title: 'dynamic work session has same restrict allowlist as default huaanwork',
    label: '已覆盖',
    evidence: 'tests/huaanwork-guardrails/present-as.cordis.spec.ts:92',
  },
  {
    file: 'loop.test.ts',
    title: '@mcp lifecycle: agentToolNames contains mcp__* during turn and detaches after idle',
    label: '已覆盖',
    evidence: 'tests/huaanwork-guardrails/agent-mcp.cordis.spec.ts:118',
  },
  {
    file: 'automations-host.test.ts',
    title: 'project RPCs create, open, rename, remove and cascade automations',
    label: 'Task 3 新增',
    evidence: 'tests/huaanwork-host/automations-store.spec.ts:265',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation.run executes a script task and emits widget and run events',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:270',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation.run returns runId; run events carry runId, sessionId, trigger, status and durationMs',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:295',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation.runs filters by status and truncates by limit',
    label: '已覆盖',
    evidence: 'tests/huaanwork-host/routes.spec.ts:868',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation.pruneSessions removes stale run session dirs but keeps recorded ones',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:653',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation.templates returns the six built-in templates and each creates successfully',
    label: '本任务补',
    evidence: 'tests/huaanwork-host/automation-templates.spec.ts:21',
  },
  {
    file: 'automations-host.test.ts',
    title: 'cross-project script automation neither switches the workspace nor blocks session.send',
    label: '裁定不移植',
    evidence: '旧 automations-host.test.ts:463 依赖跨根 script 在当前进程内执行;不移植清单旧 :668-676。替代:手动跨根拒绝 tests/huaanwork-host/automations-host.spec.ts:591',
  },
  {
    file: 'automations-host.test.ts',
    title: 'session.list filters sessions by project root',
    label: '已覆盖',
    evidence: 'tests/huaanwork-host/sessions.spec.ts:556',
  },
  {
    file: 'automations-host.test.ts',
    title: 'scheduler tick runs a due automation without manual trigger',
    label: 'Task 5 新增',
    evidence: 'tests/huaanwork-host/automation-scheduler.spec.ts:237',
  },
  {
    file: 'automations-host.test.ts',
    title: 'scheduler tick records a missed run for stale automations without executing',
    label: 'Task 5 新增',
    evidence: 'tests/huaanwork-host/automation-scheduler.spec.ts:296',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation agent task runs through stubLlm, strips thinking, and captures output',
    label: '本任务补',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:761',
  },
  {
    file: 'automations-host.test.ts',
    title: "Phase 2: agentToolNames() never contains run_code even when an automation's unattended.enabled is true",
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:432',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation run attributes tokens by sessionId; other sessions and sessionless extras do not leak',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:386',
  },
  {
    file: 'automations-host.test.ts',
    title: "Phase 2: ctx.huaanworkUnattended.current is scoped to the run and cleared by runAgentTurn's finally",
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:432',
  },
  {
    file: 'automations-host.test.ts',
    title: 'session.send is rejected while an agent automation runs',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:357',
  },
  {
    file: 'automations-host.test.ts',
    title: 'session.cancel is rejected while an agent automation runs',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:357',
  },
  {
    file: 'automations-host.test.ts',
    title: 'session.send succeeds while a script automation runs',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:357',
  },
  {
    file: 'automations-host.test.ts',
    title: 'scheduler tick defers a cross-project agent task while a session turn is live',
    label: '裁定不移植',
    evidence: '旧 automations-host.test.ts:1192 依赖 liveAgentsIdle 旧 :1630-1647。方案①跨根一律顺延,见 tests/huaanwork-host/automation-scheduler.spec.ts:271',
  },
  {
    file: 'automations-host.test.ts',
    title: 'scheduler tick groups due automations by project to minimize re-boots',
    label: '裁定不移植',
    evidence: '旧 automations-host.test.ts:1276 的再启动计数依赖进程内热切换旧 :668-676。同根分组见 tests/huaanwork-host/automation-scheduler.spec.ts:237',
  },
  {
    file: 'automations-host.test.ts',
    title: 'automation.run rejects a cross-project agent task while any live turn is running',
    label: '裁定不移植',
    evidence: '旧 automations-host.test.ts:1360 后半段热切回依赖旧 :668-676 与 liveAgentsIdle。方案①改为一律拒绝,见 tests/huaanwork-host/automations-host.spec.ts:591',
  },
  {
    file: 'automations-host.test.ts',
    title: 'session.send is rejected with a workspace-switch message while displaced by a cross-project agent task',
    label: '裁定不移植',
    evidence: '旧 automations-host.test.ts:1417 依赖运行期工作区被切走。不移植清单旧 :668-676 / :700-721;workspaceDisplaced 恒 false',
  },
  {
    file: 'automations-host.test.ts',
    title: 'cross-project agent switch waits for a live session turn before disposing the runtime',
    label: '裁定不移植',
    evidence: '旧 automations-host.test.ts:1474 依赖 waitForLiveIdleBeforeSwitch 旧 :1653-1662',
  },
  {
    file: 'automations-host.test.ts',
    title: 'restore skips while a session turn is live and retries on the next scheduler tick',
    label: '裁定不移植',
    evidence: '旧 automations-host.test.ts:1579 依赖 restoreUserRoot 旧 :700-721',
  },
  {
    file: 'automations-host.test.ts',
    title: 'stream network gate blocks public endpoints unless allow_network is on',
    label: '本任务补',
    evidence: 'tests/huaanwork-host/sessions.spec.ts:680',
  },
  {
    file: 'automations-host.test.ts',
    title: 'agent run exceeding the settings-configured timeout records status timeout',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:557',
  },
  {
    file: 'automations-host.test.ts',
    title: 'settings.json alone (no test seam) drives the automation timeout',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:557',
  },
  {
    file: 'automations-host.test.ts',
    title: 'script task exceeding the timeout records status timeout',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:557',
  },
  {
    file: 'automations-host.test.ts',
    title: 'agent task runs in an independent session with an automation-fire envelope',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:524',
  },
  {
    file: 'automations-host.test.ts',
    title: 'merged taskShape injects the previous successful output truncated to 4 KB',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:524',
  },
  {
    file: 'automations-host.test.ts',
    title: 'two parallel script tasks do not lock workspace.open',
    label: '本任务补',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:840',
  },
  {
    file: 'automations-host.test.ts',
    title: 'scheduler tick still enqueues a due agent task while a script task runs',
    label: '本任务补',
    evidence: 'tests/huaanwork-host/automation-scheduler.spec.ts:450',
  },
  {
    file: 'automations-host.test.ts',
    title: 'missedPolicy run-once catchup executes once with catchup envelope and coalescedCount',
    label: 'Task 5 新增',
    evidence: 'scripts/huaanwork-host-loop.spec.mjs:754',
  },
  {
    file: 'automations-host.test.ts',
    title: 'expired automations are disabled without executing or recording missed',
    label: 'Task 5 新增',
    evidence: 'tests/huaanwork-host/automation-scheduler.spec.ts:364',
  },
  {
    file: 'automations-host.test.ts',
    title: 'once automation disables itself after firing and never records missed',
    label: '本任务补',
    evidence: 'tests/huaanwork-host/automation-scheduler.spec.ts:484',
  },
  {
    file: 'automations-host.test.ts',
    title: 'first tick after restart rewrites residual running automations as cancelled',
    label: 'Task 5 新增',
    evidence: 'tests/huaanwork-host/automation-scheduler.spec.ts:405',
  },
  {
    file: 'automations-host.test.ts',
    title: 'script task end does not reject approvals pending on a concurrent agent run',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:386',
  },
  {
    file: 'automations-host.test.ts',
    title: 'residual recovery skips runs started after host boot',
    label: 'Task 5 新增',
    evidence: 'tests/huaanwork-host/automation-scheduler.spec.ts:409',
  },
  {
    file: 'automations-host.test.ts',
    title: 'agent automation runs with a huaanwork-auto- session prefix',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:386',
  },
  {
    file: 'automations-host.test.ts',
    title: 'issue #2: unbound agent automation runs without any project existing',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:633',
  },
  {
    file: 'automations-host.test.ts',
    title: 'issue #2: unbound script automation runs with the neutral default root as cwd',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:638',
  },
  {
    file: 'automations-host.test.ts',
    title: 'issue #2: automation bound to a vanished project still fails with the missing-project message',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:650',
  },
  {
    file: 'unified-channel.test.ts',
    title: 'boot pins a single huaanwork agent and never creates huaanwork-chat',
    label: '已覆盖',
    evidence: 'scripts/huaanwork-host-loop.spec.mjs:607',
  },
  {
    file: 'unified-channel.test.ts',
    title: 'legacy huaanwork-chat-* sessions can list, open, and resume',
    label: '裁定不移植',
    evidence: '旧 unified-channel.test.ts:219 legacy chat 会话语义,数据迁移归 M6',
  },
  {
    file: 'unified-channel.test.ts',
    title: 'legacy huaanwork-chat-* resume is rejected when cwd is another workspace',
    label: '裁定不移植',
    evidence: '旧 unified-channel.test.ts:269 legacy chat 会话语义,数据迁移归 M6',
  },
  {
    file: 'unified-channel.test.ts',
    title: 'legacy huaanwork-chat-* session.send is network-gated like any other session',
    label: '裁定不移植',
    evidence: '旧 unified-channel.test.ts:309 legacy chat 会话语义,数据迁移归 M6',
  },
  {
    file: 'unified-channel.test.ts',
    title: 'legacy channel:chat automations can become script, enable unattended, and mint huaanwork-auto- runs',
    label: 'Task 4 新增',
    evidence: 'tests/huaanwork-host/automations-host.spec.ts:485',
  },
  {
    file: 'unified-channel.test.ts',
    title: 'startHost sweeps legacy chat-auto run sessions and leaves user chat sessions',
    label: '已覆盖',
    evidence: 'tests/huaanwork-host/sessions.spec.ts:689',
  },
]
