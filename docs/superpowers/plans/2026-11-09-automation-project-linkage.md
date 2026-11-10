# 自动化项目与运行子任务联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 agent 自动化的每次实际运行建立持久化日期子任务与会话归属，运行记录直接跳转该子任务，并退役看板与采集结果展示。

**Architecture:** 宿主以 `runId/taskId/sessionId` 建立权威关联；running 注册项持久化 `activeRunId`，重启按原身份对账。跨文件删除使用“会话 → Task → Run/Automation/Project 注册项”的锚点顺序和幂等重试。客户端只由 `automation/run-task` 创建运行标签，运行记录按现存 Task 导航。

**Tech Stack:** TypeScript strict、React 19、Cordis Host、Node.js fs/path、Vitest、Yarn 4.18.0、Electron。

**Spec:** `docs/superpowers/specs/2026-11-09-automation-project-linkage-design.md`

## Global Constraints

- Node.js `^22.19.0` 或 `>=24.0.0`；根 Yarn `4.18.0` 经 Corepack。
- 只改 `dsh-plugin-huaanwork/` 与本计划/设计文档；禁止修改 `deepseek-harness/`。
- 默认新建同名项目、允许复用；只有 agent 实际 started 创建 Task；script/missed/准入跳过/queued 取消不创建。
- 子任务名固定为 `<自动化名称> · YYYY-MM-DD HH:mm:ss`，日期取宿主本地实际 `startedAt`。
- 新增线上字段均可选并条件展开；旧 tasks/automations/runs 零迁移可读。
- 禁止按名称或时间戳关联；权威键是 `runId/taskId/sessionId`。
- `taskRegistryLock` 内不得调用 `appendRun/markAutomation/finishAutomation`；跨文件删除最后删除持久锚点。
- `RunSummary.output` 和 merged 消费保留；只删除 UI 展示和看板运行时逻辑。
- `TurnScheduler` 只增加只读 activeSessionIds 快照，不改变按根单写者互斥语义。
- 单文件测试命令：`corepack yarn workspace dsh-plugin-huaanwork test <相对 tests/ 的路径>`。
- 每个 Task 完成后仅在用户明确授权 commit 时提交；本轮文档编写不执行任何 Git commit。
- 源码行号是编写时快照；实施时先按符号定位，禁止按漂移行号盲改。

## File Structure

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `src/client-huaanwork/rpc-types.ts` | Host/Client 权威契约 | 新增 Task 来源、Run.taskId、Automation.activeRunId、run-task；移除 widget |
| `src/client-huaanwork/logic/projects.ts` | 客户端镜像契约 | 同步全部字段和输入类型 |
| `src/client-huaanwork/projects.ts` | RPC 包装 | 同步 deleteRun/prune 应答类型 |
| `src/huaanwork-host/stores.ts` | tasks/projects 注册表 | 原子运行 Task 创建、查询和按来源删除 |
| `src/huaanwork-host/automations-store.ts` | 自动化/runs 持久化 | activeRunId、可重试级联、prune、移除 widget |
| `src/huaanwork-host/automations-host.ts` | 执行体与在途状态 | 创建运行 Task、run-task、终态关联、删除 guard |
| `src/huaanwork-host/automation-scheduler.ts` | 调度与恢复 | 准入 guard、按原身份对账 |
| `src/huaanwork-host/turn-scheduler.ts` | 活跃写者快照 | 新增 activeSessionIds，仅只读 |
| `src/huaanwork-host/routes.ts` | RPC 级联接线 | 删除/清理/活跃守卫、项目级 deleting guard |
| `src/huaanwork-host/acceptance-hooks.ts` | 验收故障注入 | 新增崩溃点纯判定（主开关惰性） |
| `src/client-huaanwork/logic/automationRunLink.ts` | 运行记录目标判定 | 新建纯函数模块 |
| `src/client-huaanwork/logic/runTabsLogic.ts` | 重启运行标签 | 只重建现存关联 Task |
| `src/client-huaanwork/logic/chatTabs.ts` | 标签关闭 | 按 session/task 关闭受影响标签 |
| `src/client-huaanwork/App.tsx` | 事件、导航、刷新 | run-task 单一路径和子任务恢复 |
| `src/client-huaanwork/AutomationsView.tsx` | 自动化页面 | 删除看板/output，新增运行跳转 |
| `src/client-huaanwork/BoardView.tsx` | 退役看板 | 删除 |
| `src/client-huaanwork/styles.css`、`styles.generated.ts` | 样式源与产物 | 删除失效规则并生成 |

---

### Task 1: 可选契约与运行子任务原子创建

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:271-324,479-491`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts:19-98`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts:184-267`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts`

**Interfaces:**
- Consumes: 既有 `TaskInfo`、`bindTaskSession` 的 session 一对一规则。
- Produces: `TaskInfo.automationId?/runId?`、`RunSummary.taskId?`、`AutomationInfo.activeRunId?`、`automation/run-task`、`createAutomationRunTask(storageRoot,input)`。

- [ ] **Step 1: 写失败测试**

```ts
test("createAutomationRunTask binds once and is idempotent by automation/run", async () => {
  const home = makeHome();
  const input = {
    projectId: "p1", name: "任务 · 2026-11-09 10:00:00", createdAt: 1000,
    automationId: "auto-1", runId: "run-1", sessionId: "sess-1",
  };
  const first = await createAutomationRunTask(home, input);
  expect(await createAutomationRunTask(home, { ...input, name: "用户已改名" })).toEqual(first);
  await expect(createAutomationRunTask(home, { ...input, sessionId: "other" }))
    .rejects.toThrow(/does not match/);
  await expect(createAutomationRunTask(home, { ...input, runId: "run-2" }))
    .rejects.toThrow(/already bound/);
  expect(await listTasks(home, "p1")).toEqual([first]);
});

test("legacy tasks without automation origin stay readable", async () => {
  const home = makeHome();
  writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [{
    id: "old", projectId: "p1", name: "旧任务", createdAt: 1, sessionId: "old-session",
  }] }));
  expect(await listTasks(home, "p1")).toHaveLength(1);
});
```

复用本文件既有 `makeHome()` 临时 profile fixture。

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/stores.spec.ts`

Expected: FAIL，`createAutomationRunTask` 尚不存在。

- [ ] **Step 3: 同步两份契约**

在两份 `TaskInfo` 加：

```ts
automationId?: string;
runId?: string;
```

在两份 `RunSummary` 加 `taskId?: string`，在两份 `AutomationInfo` 加 `activeRunId?: string`。在 `RpcEvent` 加：

```ts
| {
    event: "automation/run-task";
    automationId: string;
    projectId: string;
    runId: string;
    sessionId: string;
    trigger?: "manual" | "schedule" | "catchup";
    task: TaskInfo;
  }
```

- [ ] **Step 4: 实现 Task 单文件原子创建**

```ts
export type AutomationRunTaskInput = {
  projectId: string
  name: string
  createdAt: number
  automationId: string
  runId: string
  sessionId: string
}

export async function createAutomationRunTask(
  storageRoot: string,
  input: AutomationRunTaskInput,
): Promise<TaskInfo> {
  const projectId = input.projectId.trim()
  const name = input.name.trim()
  const automationId = input.automationId.trim()
  const runId = input.runId.trim()
  const sessionId = input.sessionId.trim()
  if (!projectId || !name || !automationId || !runId || !sessionId) {
    throw new Error('automation run task requires project, name, automation, run and session')
  }
  return withTaskRegistryLock(async () => {
    const registry = await readTaskRegistry(storageRoot)
    const existing = registry.tasks.find((task) =>
      task.automationId === automationId && task.runId === runId)
    if (existing) {
      if (existing.projectId !== projectId || existing.sessionId !== sessionId) {
        throw new Error(`automation run task ${automationId}/${runId} does not match existing binding`)
      }
      return existing
    }
    const conflict = registry.tasks.find((task) => task.sessionId === sessionId)
    if (conflict) throw new Error(`session ${sessionId} is already bound to task ${conflict.id}`)
    const task: TaskInfo = {
      id: randomUUID(), projectId, name, createdAt: input.createdAt,
      sessionId, automationId, runId,
    }
    registry.tasks.push(task)
    await writeTaskRegistry(storageRoot, registry)
    return task
  })
}
```

在 Task 读取规范化中仅保留成对的非空来源字段；普通 Task 和旧 Task 不加字段。

- [ ] **Step 5: 验证并提交边界**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/stores.spec.ts`

Expected: PASS。仅在用户明确授权后提交本任务文件。

---

### Task 2: agent 执行创建日期子任务并持久化 activeRunId

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:436-459`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:558-740`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:480-489`（run-end 变体补 `taskId?: string`，M3 归属）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `createAutomationRunTask` 和契约。
- Produces: `automationRunTaskName(name,startedAt)`、running 状态中的 `activeRunId`、带 taskId 的 Run/run-end、run-task 事件。

- [ ] **Step 1: 写失败测试**

```ts
test("bound agent run creates one dated task and carries taskId through completion", async () => {
  const h = makeHarness();
  const projectRoot = mkdtempSync(join(tmpdir(), "hw-run-task-project-"));
  dirs.push(projectRoot);
  const project = await createProject(h.profileDir, { root: projectRoot, name: "每日十万个为什么" });
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: "每日十万个为什么" });
  const started = await startAutomation(h, automation, { trigger: "manual", runId: "run-task-1" });
  await started.done;
  await waitRunEnd(h.events, automation.id);
  const run = (await recentRuns(h.profileDir, automation.id))[0]!;
  const task = (await listTasks(h.profileDir, project.id))[0]!;
  expect(task.runId).toBe("run-task-1");
  expect(task.automationId).toBe(automation.id);
  expect(task.sessionId).toBe(automationRunSessionId(automation.id, "run-task-1"));
  expect(task.createdAt).toBe(run.startedAt);
  expect(task.name).toMatch(/^每日十万个为什么 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  expect(run.taskId).toBe(task.id);
  expect(h.events.map((event) => event.event)).toContain("automation/run-task");
  expect((await findAutomation(h.profileDir, automation.id)).activeRunId).toBeUndefined();
});

test("task registry failure prevents model execution and leaves an unlinked error run", async () => {
  const h = makeHarness();
  const projectRoot = mkdtempSync(join(tmpdir(), "hw-run-task-fail-"));
  dirs.push(projectRoot);
  const project = await createProject(h.profileDir, { root: projectRoot });
  const automation = await agentTask(h.profileDir, { projectId: project.id });
  mkdirSync(join(h.profileDir, "tasks.json"));
  const started = await startAutomation(h, automation, { runId: "task-fail-1" });
  await started.done;
  const run = (await recentRuns(h.profileDir, automation.id))[0]!;
  expect(run.status).toBe("error");
  expect(run.taskId).toBeUndefined();
  expect(run.sessionId).toBeUndefined();
});
```

另在 store 测试中断言 running 必须带 activeRunId，ok/error 收尾后字段消失。

M2 回归钉（agent 软失败路径，script 有 finally 兜底不适用）：

```ts
test("appendRun failure still removes the handed-off in-flight entry", async () => {
  const h = makeHarness();
  const automation = await agentTask(h.profileDir);
  // runs.jsonl 占位成目录 → appendRun 的 writeFile 抛 EISDIR，进程不退出。
  mkdirSync(join(h.profileDir, "automations", `${automation.id}.runs.jsonl`), { recursive: true });
  const started = await startAutomation(h, automation, { runId: "soft-fail-1" });
  await expect(started.done).rejects.toThrow();
  expect(inFlightRuns.has("soft-fail-1")).toBe(false);
});
```

`inFlightRuns` 从 `automation-inflight.ts` 导入。该钉针对「appendRun 抛出但进程继续运行」：泄漏条目会让改绑/删自动化/删项目预检一直拒绝到 Host 重启（删除面阻塞系本计划新守卫引入）。

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automations-store.spec.ts`

Expected: FAIL，运行未建 Task、Run 无 taskId。

- [ ] **Step 3: 扩展 running 持久化**

将 `markAutomation` 状态参数加 `activeRunId?: string`；running 分支拒绝空 runId 并写入，所有非 running 分支删除旧字段。注册表读取只保留非空字符串 activeRunId。`executeRun` 调用处传 `activeRunId: runId`。

- [ ] **Step 4: 在执行前创建 Task 并发射关联事件**

```ts
export function automationRunTaskName(name: string, startedAt: number): string {
  const d = new Date(startedAt)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${name} · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
```

在有效项目校验后、`runAgentTurn` 前：

```ts
let runTask: TaskInfo | undefined
if (automation.kind === 'agent' && project) {
  try {
    runTask = await createAutomationRunTask(routeCtx.profileDir, {
      projectId: project.id,
      name: automationRunTaskName(automation.name, startedAt),
      createdAt: startedAt,
      automationId: automation.id,
      runId,
      sessionId: sessionId!,
    })
  } catch (error) {
    await finishAutomation(routeCtx, automation, {
      runId, startedAt, ok: false, status: 'error',
      output: error instanceof Error ? error.message : String(error),
    }, trigger, coalescedCount)
    return
  }
  routeCtx.emit({
    event: 'automation/run-task', automationId: automation.id,
    projectId: project.id, runId, sessionId: sessionId!, trigger, task: runTask,
  })
}
```

`finishAutomation` 的 run 参数和 RunSummary 条件展开 `taskId`；run-end 同步带 taskId（RpcEvent 变体改动归本 Task Files）。绑定项目缺失和 Task 创建失败路径不写 sessionId；存量 projectId:null 的 agent 仍执行但不建 Task，保留旧 sessionId 供只读历史降级。

M2 修复：`finishAutomation` 的摘条目移入 finally，appendRun 软失败不再泄漏 inFlight（成功路径次序不变）：

```ts
try {
  await appendRun(routeCtx.profileDir, automation.id, summary)
} finally {
  inFlightRuns.delete(run.runId)
}
```

- [ ] **Step 5: 验证并提交边界**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automations-store.spec.ts`

Expected: PASS；script、queued cancel、missed 既有测试继续通过。仅在用户明确授权后提交。

---

### Task 3: 重启按原运行身份对账

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts:235-253`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automation-scheduler.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 activeRunId、Task 来源字段、`automationRunSessionId`。
- Produces: `recoverInterruptedAutomation(routeCtx,automation,now)`。

- [ ] **Step 1: 写失败测试**

```ts
async function boundAgentForRecovery(h: Harness): Promise<AutomationInfo> {
  const root = mkdtempSync(join(tmpdir(), "hw-recovery-project-"));
  dirs.push(root);
  const project = await createProject(h.profileDir, { root, name: "恢复项目" });
  return createAutomation(h.profileDir, normalizeAutomationInput({
    projectId: project.id, name: "恢复任务", kind: "agent",
    schedule: { kind: "manual" }, prompt: "恢复测试",
  }));
}

test("recovery reconciles an already persisted successful run without duplicating it", async () => {
  const h = makeHarness();
  const created = await boundAgentForRecovery(h);
  await markAutomation(h.profileDir, created.id, {
    lastRunAt: 1000, lastStatus: "running", activeRunId: "original-1",
  });
  await appendRun(h.profileDir, created.id, {
    runId: "original-1", startedAt: 1000, endedAt: 1200, ok: true,
    output: "done", status: "ok", durationMs: 200,
  });
  const running = await findAutomation(h.profileDir, created.id);
  await recoverInterruptedAutomation(h.routeCtx, running, 2000);
  const runs = await recentRuns(h.profileDir, created.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.runId).toBe("original-1");
  expect((await findAutomation(h.profileDir, created.id)).lastStatus).toBe("ok");
});

test("recovery reuses the persisted run task instead of matching timestamps", async () => {
  const h = makeHarness();
  const created = await boundAgentForRecovery(h);
  const sessionId = automationRunSessionId(created.id, "original-2");
  const task = await createAutomationRunTask(h.profileDir, {
    projectId: created.projectId!, name: "原运行", createdAt: 1000,
    automationId: created.id, runId: "original-2", sessionId,
  });
  await markAutomation(h.profileDir, created.id, {
    lastRunAt: 1000, lastStatus: "running", activeRunId: "original-2",
  });
  const running = await findAutomation(h.profileDir, created.id);
  await recoverInterruptedAutomation(h.routeCtx, running, 2000);
  const run = (await recentRuns(h.profileDir, created.id))[0]!;
  expect(run.runId).toBe("original-2");
  expect(run.taskId).toBe(task.id);
  expect(run.sessionId).toBe(sessionId);
  expect(run.status).toBe("cancelled");
});
```

在测试导入中补 `appendRun/updateAutomation`、`createAutomationRunTask/listTasks` 和 `recoverInterruptedAutomation`。

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automation-scheduler.spec.ts`

Expected: FAIL，恢复函数不存在或仍随机生成 runId。

- [ ] **Step 3: 实现对账函数并接入首个 tick**

```ts
export async function recoverInterruptedAutomation(
  routeCtx: RouteContext,
  automation: AutomationInfo,
  now: number,
): Promise<void> {
  const startedAt = automation.lastRunAt ?? now
  const runId = automation.activeRunId
  if (!runId) {
    await appendRun(routeCtx.profileDir, automation.id, {
      runId: randomUUID(), startedAt, endedAt: now, ok: false,
      output: 'sidecar 重启，上次运行被中断', status: 'cancelled',
      trigger: 'schedule', durationMs: Math.max(0, now - startedAt),
    })
    await markAutomation(routeCtx.profileDir, automation.id, { lastRunAt: now, lastStatus: 'error' })
    return
  }
  const existing = (await recentRuns(routeCtx.profileDir, automation.id)).find((run) => run.runId === runId)
  if (existing) {
    await markAutomation(routeCtx.profileDir, automation.id, {
      lastRunAt: existing.endedAt, lastStatus: existing.ok ? 'ok' : 'error',
    })
    if (automation.schedule.kind === 'once') {
      await updateAutomation(routeCtx.profileDir, automation.id, { enabled: false })
    }
    return
  }
  const task = (await listTasks(routeCtx.profileDir)).find((item) =>
    item.automationId === automation.id && item.runId === runId)
  const sessionId = task?.sessionId
    ?? (automation.kind === 'agent' ? automationRunSessionId(automation.id, runId) : undefined)
  await appendRun(routeCtx.profileDir, automation.id, {
    runId, startedAt, endedAt: now, ok: false,
    output: 'sidecar 重启，上次运行被中断', status: 'cancelled', trigger: 'schedule',
    durationMs: Math.max(0, now - startedAt),
    ...(task ? { taskId: task.id } : {}),
    ...(sessionId ? { sessionId } : {}),
  })
  await markAutomation(routeCtx.profileDir, automation.id, { lastRunAt: now, lastStatus: 'error' })
  if (automation.schedule.kind === 'once') {
    await updateAutomation(routeCtx.profileDir, automation.id, { enabled: false })
  }
}
```

首个 tick 循环**逐自动化 try/catch** 调用该函数（M4：一条失败不得中断同批其余项；失败项保留 running/activeRunId，下次启动重试）：

```ts
for (const automation of list) {
  if (automation.lastStatus !== 'running' || (automation.lastRunAt ?? 0) >= hostStartedAt) continue
  try {
    await recoverInterruptedAutomation(routeCtx, automation, now)
  } catch (error) {
    console.error(`automation recovery failed for ${automation.id}:`, error)
  }
}
```

- [ ] **Step 4: 验证并提交边界**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automation-scheduler.spec.ts`

Expected: PASS，包括旧无 activeRunId fixture。仅在用户明确授权后提交。

---

### Task 4: 退役看板和运行结果展示

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx`
- Delete: `dsh-plugin-huaanwork/src/client-huaanwork/BoardView.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Generate: `dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/automations-runs-delete.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/test-port-mapping.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-migration-smoke.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-migration/end-to-end.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts`

**Interfaces:**
- Consumes: 现有 AutomationsView 组件测试 mount。
- Produces: 仅 tasks/runs 两 tab；无 widget 输入/事件；页面不读取 Run.output。

- [ ] **Step 1: 写失败测试**

```ts
test("automation page has no board tab, widget control, or collected output", async () => {
  const view = await mount({
    onChanged: () => undefined,
    onRunDeleted: () => undefined,
    runs: { [AUTOMATION.id]: [run("r1", "s1", 1000, "SECRET-COLLECTED-OUTPUT")] },
  });
  expect(view.textContent).not.toContain("看板");
  expect(view.textContent).not.toContain("SECRET-COLLECTED-OUTPUT");
  expect(view.querySelector(".run-output")).toBeNull();
  expect(view.textContent).not.toContain("推送到项目看板");
});
```

把原 script widget 事件测试改成：运行 script 后事件序列不含 `automation/widget`，Run.output 仍保存脚本 stdout。

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/automations-runs-delete.spec.ts tests/huaanwork-host/automations-host.spec.ts`

Expected: FAIL，看板、widget 或 output 仍存在。

- [ ] **Step 3: 删除生产和 UI 逻辑**

- 删除 BoardView 导入、board tab、BoardView 分支、widget state/checkbox/chip/提交字段及页头文案。
- 两份 AutomationInfo 删除 `widget: boolean`；AutomationInput/Draft/Patch 删除 widget；normalize/update 不再读写。
- `finishAutomation` 删除 widget 事件块；RpcEvent 删除 `automation/widget`；App 删除该分支。
- 删除任务行和 RunsPanel 两处 `<pre className="run-output">`。
- 保留 `RunSummary.output`、`clipOutput`、merged 读取与 HistoryDetailPane。

核心删除形状：

```ts
// normalizeAutomationInput return 不再包含 widget
// updateAutomation 不再接受 patch.widget
// finishAutomation 不再 emit automation/widget
```

- [ ] **Step 4: 更新样式、fixture 与生成产物**

删除 `.board-*`、`.automation-chip.widget`、`.run-output` 的无消费者规则；运行：

```bash
corepack yarn workspace dsh-plugin-huaanwork gen:styles
```

类型 fixture 删除 widget；迁移测试中的旧 JSON 保留未知 widget 属性以证明兼容读取。

- [ ] **Step 5: 验证并提交边界**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/automations-runs-delete.spec.ts tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/stores.spec.ts tests/huaanwork-migration-smoke.spec.ts tests/huaanwork-migration/end-to-end.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS，merged output 回归仍绿，widget 合同删除后全仓类型一致。仅在用户明确授权后提交。

---

### Task 5: 运行标签单一路径与运行记录跳转

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/automationRunLink.ts`
- Create: `dsh-plugin-huaanwork/tests/client-huaanwork/automationRunLink.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/runTabsLogic.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/runTabsLogic.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/automations-runs-delete.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`

**Interfaces:**
- Consumes: Task 1/2 的 run-task、Run.taskId、Task 来源字段。
- Produces: `resolveAutomationRunNavigation(automation,run,tasks)`、`staleAutomationRunTabs(tabs,tasks)`、带 taskId 的 RunTabDescriptor、`onOpenRunTask(task)`。

- [ ] **Step 1: 写导航判定失败测试**

```ts
const AUTOMATION: AutomationInfo = {
  id: "auto-1", projectId: "old-project", name: "任务", kind: "agent",
  schedule: { kind: "manual" }, prompt: "执行", enabled: true, createdAt: 1,
};
const RUN: RunSummary = {
  runId: "r1", startedAt: 1000, endedAt: 1100, ok: true,
  output: "done", status: "ok", sessionId: "s1",
};

test("run navigation uses the historical task, not current automation project", () => {
  const automation = { ...AUTOMATION, projectId: "new-project" };
  const task = {
    id: "task-1", projectId: "old-project", name: "任务 · 2026-11-09 10:00:00",
    createdAt: 1000, automationId: automation.id, runId: "r1", sessionId: "s1",
  };
  expect(resolveAutomationRunNavigation(automation, { ...RUN, taskId: "task-1" }, [task]))
    .toEqual({ kind: "task", task });
  expect(resolveAutomationRunNavigation(automation, { ...RUN, taskId: "missing" }, []))
    .toEqual({ kind: "unavailable", reason: "对应子任务或会话已删除/清理" });
  expect(resolveAutomationRunNavigation(automation, RUN, []))
    .toEqual({ kind: "legacy", sessionId: "s1" });
});
```

在 runTabsLogic 测试中传入 tasks，断言缺 Task/无 taskId 的 Run 不重建，现存 Task 提供 label/projectId/taskId。另断言：

```ts
test("stale automation tabs close only after an authoritative task snapshot removes them", () => {
  const tabs = [
    { id: "run-r1", automationId: "auto-1", taskId: "task-1", sessionId: "s1" },
    { id: "work-1" },
  ];
  expect(staleAutomationRunTabs(tabs, [{ id: "task-1" } as TaskInfo])).toEqual([]);
  expect(staleAutomationRunTabs(tabs, [])).toEqual([tabs[0]]);
});
```

`staleAutomationRunTabs` 只返回带 automationId/taskId 且 taskId 不在快照中的标签；App 仅在首次 `refreshTasks` 成功后启用重建和该对账，避免启动并发把空列表当成删除证据。

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/automationRunLink.spec.ts tests/client-huaanwork/runTabsLogic.spec.ts`

Expected: FAIL，模块不存在或签名不匹配。

- [ ] **Step 3: 实现纯导航函数**

```ts
export type AutomationRunNavigation =
  | { kind: "task"; task: TaskInfo }
  | { kind: "legacy"; sessionId: string }
  | { kind: "unavailable"; reason: string }

export function resolveAutomationRunNavigation(
  automation: AutomationInfo,
  run: RunSummary,
  tasks: readonly TaskInfo[],
): AutomationRunNavigation {
  if (run.taskId) {
    const task = tasks.find((item) => item.id === run.taskId)
    if (!task || task.automationId !== automation.id || task.runId !== run.runId || !task.sessionId) {
      return { kind: "unavailable", reason: "对应子任务或会话已删除/清理" }
    }
    if (run.sessionId && task.sessionId !== run.sessionId) {
      return { kind: "unavailable", reason: "运行与子任务会话关联不一致" }
    }
    return { kind: "task", task }
  }
  if (run.sessionId) return { kind: "legacy", sessionId: run.sessionId }
  return { kind: "unavailable", reason: automation.kind === "script" ? "脚本运行无会话" : "该运行未建立子任务会话" }
}

export function staleAutomationRunTabs<T extends { automationId?: string; taskId?: string }>(
  tabs: readonly T[],
  tasks: readonly TaskInfo[],
): T[] {
  const alive = new Set(tasks.map((task) => task.id))
  return tabs.filter((tab) => tab.automationId && tab.taskId && !alive.has(tab.taskId))
}
```

- [ ] **Step 4: 改 run tab 创建和重建**

- run-start 只更新 runningRuns。
- run-task 用完整 task 创建或补齐唯一标签；查找键依次为 tabId、taskId、sessionId；manual 才聚焦；随后 `refreshTasks()`。
- `runTabsToRebuild` 签名改为 `(automations, automationRuns, tasks, existingTabIds, suppressedSessionIds?)`；只选 taskId 能解析且来源/session 一致的 Run。
- App 增加 `tasksLoaded`，只在首次 task.list 成功后置 true；重建 effect 依赖 automations/runs/projectTasks/tasksLoaded，未加载时不重建也不执行 stale 对账。
- tasks 快照更新后调用 `staleAutomationRunTabs`，复用现有标签关闭与 active-tab 选择逻辑关闭失效自动化标签。
- 重建回填失败关闭该骨架并提示，不保留可输入 sessionId。
- `selectSubtask` 查找条件改为：

```ts
const existing = chatTabs.find((tab) =>
  tab.taskId === task.id ||
  (task.sessionId !== undefined && tab.sessionId === task.sessionId));
```

自动化 Task 的 open/resume 失败分支只 `noteActive(...)` 并 return，不创建普通降级 Task 标签。

- [ ] **Step 5: refreshTasks 请求序号与过期应答丢弃（T3）**

`refreshTasks` 改为单调序号，只有最新请求能写快照；否则早于 Task 落盘发出、晚于 run-task 返回的旧应答会误关刚建的运行标签（run-end 只刷新 automations/sessions，不刷新 tasks，误关后不能自愈）：

```ts
const taskRequestSeq = useRef(0);
async function refreshTasks() {
  const seq = ++taskRequestSeq.current;
  try {
    const listed = await listTasks();
    if (seq !== taskRequestSeq.current) return;
    setProjectTasks(Array.isArray(listed.tasks) ? listed.tasks : []);
    setTasksLoaded(true);
  } catch {
    // 任务数据不可得时保留旧数据
  }
}
```

在 `appWiring.spec.ts` 补接线钉（沿用该文件 readFileSync 源码断言形态）：

```ts
test("refreshTasks discards stale responses before writing projectTasks", () => {
  const source = readFileSync(new URL("../../src/client-huaanwork/App.tsx", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function refreshTasks"), source.indexOf("async function createSubtask"));
  expect(fn).toContain("taskRequestSeq");
  expect(fn.indexOf("seq !== taskRequestSeq.current")).toBeGreaterThanOrEqual(0);
  expect(fn.indexOf("seq !== taskRequestSeq.current")).toBeLessThan(fn.indexOf("setProjectTasks"));
});
```

- [ ] **Step 6: 改 RunsPanel 点击与刷新**

AutomationsView 增加 `tasks: TaskInfo[]`、`onOpenRunTask(task)`；用纯函数决定按钮或不可点原因。taskId 分支调用回调；legacy 分支保留现有 `openRunSession`。每个运行 `<li>` 加 `data-run-id={run.runId}`，测试定位不再依赖 output。

App 的 AutomationsView `onChanged` 改为：

```ts
onChanged={() => {
  void refreshAutomations();
  void refreshProjects();
  void refreshTasks();
  void refreshSessions();
}}
onOpenRunTask={(task) => void selectSubtask(task)}
tasks={projectTasks}
```

- [ ] **Step 7: 验证并提交边界**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/automationRunLink.spec.ts tests/client-huaanwork/runTabsLogic.spec.ts tests/client-huaanwork/automations-runs-delete.spec.ts tests/client-huaanwork/appWiring.spec.ts`

Expected: PASS。仅在用户明确授权后提交。

---

### Task 6: 单条运行可重试删除与标签关闭

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:549-579`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:1295-1309,1398-1412`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts:35-70,206-215`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/chatTabs.ts:17-38`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/projects.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/chatTabs.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts`

**Interfaces:**
- Consumes: Task 来源字段、现有 `removeSessionDir/removeTask/releaseSessionRuntime`。
- Produces: `TurnScheduler.activeSessionIds(): ReadonlySet<string>`、`activeAutomationIds(): ReadonlySet<string>`；`deleteAutomationRun` 的 session→task→run 顺序；按 session 关闭所有受影响标签。

- [ ] **Step 1: 写失败重试测试**

```ts
test("failed task cleanup keeps the run anchor and a retry finishes deletion", async () => {
  const home = makeHome();
  const automation = await createAutomation(home, normalizeAutomationInput(agentInput({
    projectId: "p1", schedule: { kind: "manual" },
  })));
  const task = await createAutomationRunTask(home, {
    projectId: "p1", name: "运行子任务", createdAt: 1000,
    automationId: automation.id, runId: "r1", sessionId: "s1",
  });
  await appendRun(home, automation.id, {
    runId: "r1", startedAt: 1000, endedAt: 1100, ok: true,
    output: "done", status: "ok", sessionId: "s1", taskId: task.id,
  });
  let failTaskWrite = true;
  const opts = {
    sessionsRoot: join(home, "sessions"),
    releaseSession: () => {
      if (!failTaskWrite) return;
      failTaskWrite = false;
      renameSync(join(home, "tasks.json"), join(home, "tasks.saved"));
      mkdirSync(join(home, "tasks.json"));
    },
  };
  await expect(deleteAutomationRun(home, automation.id, "r1", opts)).rejects.toThrow();
  expect((await recentRuns(home, automation.id))[0]?.runId).toBe("r1");
  rmSync(join(home, "tasks.json"), { recursive: true });
  renameSync(join(home, "tasks.saved"), join(home, "tasks.json"));
  await deleteAutomationRun(home, automation.id, "r1", { sessionsRoot: opts.sessionsRoot });
  expect(await recentRuns(home, automation.id)).toEqual([]);
  expect(await listTasks(home)).toEqual([]);
});
```

在测试导入中补 `renameSync`、`createAutomationRunTask/listTasks`；`makeHome/agentInput/createAutomation/normalizeAutomationInput` 复用本文件既有 fixture。测试必须验证第一次失败后 Run 仍在。

在 `turn-scheduler.spec.ts` 增加：

```ts
test("activeSessionIds covers writers, queued sessions, and starting sessions", () => {
  const scheduler = createTurnScheduler({ maxConcurrentTurns: () => 1, modelExists: () => true });
  scheduler.admitUserTurn({ sessionId: "s1", tabId: "t1", text: "一", modelId: "m", root: "/a" });
  const queued = scheduler.admitUserTurn({ sessionId: "s2", tabId: "t2", text: "二", modelId: "m", root: "/b" });
  if (queued.kind !== "queued") throw new Error("expected queued admission");
  expect(scheduler.activeSessionIds()).toEqual(new Set(["s1", "s2"]));
  scheduler.release("s1");
  scheduler.drainQueue();
  expect(scheduler.activeSessionIds()).toEqual(new Set(["s2"]));
  scheduler.finishStart(queued.queueItemId);
});

test("activeAutomationIds covers admit-to-enqueue before an in-flight entry exists", () => {
  const scheduler = createTurnScheduler({ maxConcurrentTurns: () => 3, modelExists: () => true });
  scheduler.admitAutomation({
    automationId: "auto-catchup", sessionId: "huaanwork-auto-auto-catchup-r1",
    root: "/project", runId: "r1", countsTowardCap: true,
  });
  expect(scheduler.activeAutomationIds()).toEqual(new Set(["auto-catchup"]));
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts tests/client-huaanwork/chatTabs.spec.ts`

Expected: FAIL，现实现先删 Run，重试丢锚点；activeSessionIds 尚不存在。

- [ ] **Step 3: 增加只读活跃快照**

在 `RootWriter` 增加 `automationId?: string`，`admitAutomation` 原样写入。在 `TurnScheduler` 类型和返回对象增加：

```ts
activeSessionIds() {
  return new Set([
    ...[...rootWriters.values()].map((writer) => writer.sessionId),
    ...[...starting.values()].map((item) => item.sessionId),
    ...queue.map((item) => item.sessionId),
  ])
},
activeAutomationIds() {
  return new Set([...rootWriters.values()]
    .filter((writer) => writer.kind !== 'user' && writer.automationId)
    .map((writer) => writer.automationId!))
}
```

不修改任何写者获取、释放或排队逻辑。

- [ ] **Step 4: 改删除顺序和活跃守卫**

```ts
export async function deleteAutomationRun(
  storageRoot: string,
  automationId: string,
  runId: string,
  opts: { sessionsRoot: string; activeSessionIds?: ReadonlySet<string>; releaseSession?: (id: string) => void },
): Promise<{ removed: boolean; sessionDirRemoved: boolean; taskId?: string }> {
  if (inFlightRuns.has(runId)) throw new Error('运行中的记录不能删除')
  const target = (await recentRuns(storageRoot, automationId)).find((run) => run.runId === runId)
  if (!target) return { removed: false, sessionDirRemoved: true }
  if (target.sessionId && opts.activeSessionIds?.has(target.sessionId)) throw new Error('会话正在使用，暂不能删除')
  const task = (await listTasks(storageRoot)).find((item) =>
    item.id === target.taskId || (item.automationId === automationId && item.runId === runId))
  if (task && (task.automationId !== automationId || task.runId !== runId)) {
    throw new Error('运行与子任务关联不一致')
  }
  if (target.sessionId) {
    opts.releaseSession?.(target.sessionId)
    if (!await removeSessionDir(opts.sessionsRoot, target.sessionId)) {
      throw new Error('会话目录未能删除，运行记录已保留以便重试')
    }
  }
  if (task) await removeTask(storageRoot, task.id)
  const removed = await withAppendRunLock(storageRoot, automationId, async () => {
    const existing = await recentRuns(storageRoot, automationId)
    if (!existing.some((run) => run.runId === runId)) return false
    const lines = existing.filter((run) => run.runId !== runId).map((entry) => JSON.stringify(entry))
    await writeFile(runsPath(storageRoot, automationId), lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
    return true
  })
  await rewriteLastRunFromRuns(storageRoot, automationId).catch((error) => {
    console.warn(`[automations] failed to rewrite last-run fields: ${String(error)}`)
  })
  return { removed, sessionDirRemoved: true, ...(task ? { taskId: task.id } : {}) }
}
```

`automation.deleteRun` 传入 `new Set([...automationCollector.keys(), ...scheduler.activeSessionIds()])`。`task.remove` 对自动化 Task 在途/活跃时拒绝，普通 Task 行为保持；新增路由级测试证明活跃自动化 Task 删除被拒绝。客户端 `projects.ts` 的 `deleteAutomationRun` 应答补 `taskId?: string`。

- [ ] **Step 5: 关闭全部关联标签**

将运行删除关闭判据改为 sessionId 命中即可关闭本次运行关联标签，并让 App 删除成功后刷新 tasks/sessions。默认普通会话不会被赋予自动 run session；一对一约束保证不误伤其他 Task。

- [ ] **Step 6: 验证并提交边界**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts tests/client-huaanwork/chatTabs.spec.ts tests/client-huaanwork/automations-runs-delete.spec.ts`

Expected: PASS。仅在用户明确授权后提交。

---

### Task 7: Automation/Project 删除 guard 与跨项目级联

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:358-373`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:1128-1153,1191-1266,1269-1280,1312-1342,1382-1396`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`

**Interfaces:**
- Consumes: `hasInFlightAutomationRun`、Task 来源字段、Task 6 的 `activeSessionIds/activeAutomationIds`。
- Produces: `beginAutomationDeletion(id)`、`assertAutomationNotDeleting(id)`、routes 模块内 `beginProjectDeletion/assertProjectNotDeleting`、`removeTasksOfAutomation(storageRoot,id)`、锚点最后的 Automation/Project 级联。

- [ ] **Step 1: 写失败测试**

```ts
test("automation deletion removes generated tasks from old and current projects", async () => {
  const home = makeHome();
  const automation = await createAutomation(home, normalizeAutomationInput(agentInput({
    projectId: "p1", schedule: { kind: "manual" },
  })));
  const oldTask = await createAutomationRunTask(home, {
    projectId: "p1", name: "旧项目运行", createdAt: 1000,
    automationId: automation.id, runId: "r1", sessionId: "s1",
  });
  await updateAutomation(home, automation.id, { projectId: "p2" });
  const newTask = await createAutomationRunTask(home, {
    projectId: "p2", name: "新项目运行", createdAt: 2000,
    automationId: automation.id, runId: "r2", sessionId: "s2",
  });
  await removeAutomation(home, automation.id, join(home, "sessions"));
  expect((await listTasks(home)).map((task) => task.id)).not.toContain(oldTask.id);
  expect((await listTasks(home)).map((task) => task.id)).not.toContain(newTask.id);
  expect(await listAutomations(home)).toEqual([]);
});

test("deletion guard blocks admission synchronously", () => {
  const release = beginAutomationDeletion("auto-delete");
  try {
    expect(() => assertAutomationNotDeleting("auto-delete")).toThrow(/正在删除/);
  } finally {
    release();
  }
});
```

另加四条路由级回归：①只调用 `scheduler.admitAutomation`、尚未 `enqueueAutomation` 时删除自动化仍被拒绝；②级联中 Task 写盘失败时 Automation 注册项仍在、重试完成；③（T1）`beginProjectDeletion("p1")` 存续期间，`automation.create` 显式绑定 p1、`automation.update` 改绑到 p1、`task.create` 到 p1 均被拒绝，释放后恢复；④（N1）普通任务会话活跃时 `project.remove` 仍走 release-then-delete 成功，不得因活跃拒绝（既有 sessions.spec.ts:1735 级联钉子语义不变）。

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/routes.spec.ts`

Expected: FAIL，跨项目 Task 未清或 guard 不存在。

- [ ] **Step 3: 实现 guard 和来源级联**

```ts
const deletingAutomationIds = new Set<string>()
export function beginAutomationDeletion(id: string): () => void {
  if (deletingAutomationIds.has(id)) throw new Error('该自动化正在删除')
  deletingAutomationIds.add(id)
  return () => deletingAutomationIds.delete(id)
}
export function assertAutomationNotDeleting(id: string): void {
  if (deletingAutomationIds.has(id)) throw new Error('该自动化正在删除')
}
```

手动路由和 scheduler 在调用 `scheduler.admitAutomation` 前的同步段执行 assert。`removeTasksOfAutomation` 在 Task 锁内按 automationId 删除并返回 Task 列表。

项目级 guard 放 routes.ts 模块 scope（仅 routes 消费，不进 automations-host，避免名不副实）：

```ts
const deletingProjectIds = new Set<string>()
function beginProjectDeletion(id: string): () => void {
  if (deletingProjectIds.has(id)) throw new Error('该项目正在删除')
  deletingProjectIds.add(id)
  return () => deletingProjectIds.delete(id)
}
function assertProjectNotDeleting(id: string): void {
  if (deletingProjectIds.has(id)) throw new Error('该项目正在删除，暂不能绑定')
}
```

三个同步消费点（T1：锚点最后删使级联期间项目仍存在于 projects.json，存在性检查 alone 挡不住绑入）：
- `automation.create` 显式绑定分支：项目存在性校验后、`createAutomation` 前 `assertProjectNotDeleting(input.projectId)`；自动新建分支的项目是 fresh UUID，无需 assert。
- `automation.update` 改绑分支：目标存在性校验后、写入前 `assertProjectNotDeleting(targetProjectId)`。
- `task.create`：项目存在性校验后、`createTask` 前 `assertProjectNotDeleting(projectId)`。

- [ ] **Step 4: 改 Automation 删除锚点顺序**

路由先 begin guard，再同时拒绝 `hasInFlightAutomationRun(id)`、`scheduler.activeAutomationIds().has(id)` 和目标 active session；store 内按顺序清会话、清全部自动 Task、删 runs/audit，最后删 automation 注册项。非 ENOENT 清理失败抛出且保留注册项；finally 释放 guard。

- [ ] **Step 5: 改 Project 删除顺序**

`project.remove` 先 `beginProjectDeletion(projectId)`，再列 doomed Automations 并逐个 `beginAutomationDeletion`，完成全量 inFlight/activeAutomationIds/自动化来源 active session 预检；预检全过后才逐项执行可重试删除，再清该项目剩余 Task，最后 `removeProject`；guard 全部在 finally 释放。不得先删项目注册项；中途失败不回滚已完成子级联，项目锚点保留供重试。项目目录不删除。

剩余普通 Task 的清理保持既有 release-then-delete（先 `releaseSessionRuntime` 再删日志），**不适用活跃拒绝**（N1）：活跃拒绝只覆盖自动化生成的 Task 与运行会话；普通任务正在对话不构成拒绝删除项目的理由。

删除成功后沿用 AutomationsView `onChanged` 刷新 tasks/sessions；Task 5 的 `staleAutomationRunTabs` 对账关闭已失 Task 的自动化标签。新增 appWiring 钉证明删除自动化后不是只刷新列表而遗留标签。

- [ ] **Step 6: 验证并提交边界**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/automation-scheduler.spec.ts tests/client-huaanwork/appWiring.spec.ts`

Expected: PASS。仅在用户明确授权后提交。

---

### Task 8: prune 保护续聊并可重试清理 Task

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:492-535`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:1364-1375`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/projects.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`

**Interfaces:**
- Consumes: Task 来源字段、最近 20 条 Run keep 集、Task 6 的 `TurnScheduler.activeSessionIds()`。
- Produces: `pruneAutomationSessions(storageRoot,activeSessionIds,sessionsRoot,opts?)` 返回 `{removed:number,tasksRemoved:number,failed:string[]}`，`opts.releaseSession` 在删目录前释放运行态。

- [ ] **Step 1: 写失败测试**

```ts
async function pruneFixture(home: string): Promise<{ automation: AutomationInfo; task: TaskInfo }> {
  const automation = await createAutomation(home, normalizeAutomationInput(agentInput({
    projectId: "p1", schedule: { kind: "manual" },
  })));
  const task = await createAutomationRunTask(home, {
    projectId: "p1", name: "待清理运行", createdAt: 1,
    automationId: automation.id, runId: "r0", sessionId: "s0",
  });
  for (let i = 0; i < 21; i += 1) {
    await appendRun(home, automation.id, {
      runId: `r${i}`, startedAt: i + 1, endedAt: i + 2, ok: true,
      output: "done", status: "ok", sessionId: `s${i}`,
      ...(i === 0 ? { taskId: task.id } : {}),
    });
  }
  return { automation, task };
}

test("prune skips a resumed automation session owned by a live user writer", async () => {
  const home = makeHome();
  const { task } = await pruneFixture(home);
  const sessionsRoot = join(home, "sessions");
  mkdirSync(join(sessionsRoot, "project", task.sessionId!), { recursive: true });
  const scheduler = createTurnScheduler({ maxConcurrentTurns: () => 3, modelExists: () => true });
  scheduler.admitUserTurn({
    sessionId: task.sessionId!, tabId: "tab-1", text: "继续",
    modelId: "model-1", root: join(home, "project"),
  });
  expect(scheduler.activeSessionIds().has(task.sessionId!)).toBe(true);
  const result = await pruneAutomationSessions(home, scheduler.activeSessionIds(), sessionsRoot);
  expect(result.removed).toBe(0);
  expect((await listTasks(home)).map((item) => item.id)).toContain(task.id);
});

test("prune keeps task candidate when task deletion fails and retries it", async () => {
  const home = makeHome();
  const { automation, task } = await pruneFixture(home);
  const sessionsRoot = join(home, "sessions");
  mkdirSync(join(sessionsRoot, "project", task.sessionId!), { recursive: true });
  let first = true;
  const result = await pruneAutomationSessions(home, new Set(), sessionsRoot, {
    releaseSession: () => {
      if (!first) return;
      first = false;
      renameSync(join(home, "tasks.json"), join(home, "tasks.saved"));
      mkdirSync(join(home, "tasks.json"));
    },
  });
  expect(result.failed).toContain(task.id);
  expect(await recentRuns(home, automation.id)).toHaveLength(21);
  rmSync(join(home, "tasks.json"), { recursive: true });
  renameSync(join(home, "tasks.saved"), join(home, "tasks.json"));
  const retry = await pruneAutomationSessions(home, new Set(), sessionsRoot);
  expect(retry.tasksRemoved).toBe(1);
});
```

在测试导入中补 `renameSync/createTurnScheduler/createAutomationRunTask/listTasks` 及 `TaskInfo` 类型；`releaseSession` 是生产路由本来就需要传入的运行态释放回调，不新增测试专用开关。

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/automations-store.spec.ts`

Expected: FAIL，快照不存在或 prune 只返回 number。

- [ ] **Step 3: 实现 union 候选和失败协议**

- keep = activeSessionIds ∪ 每 Automation 最近 20 条 Run.sessionId。
- candidates = 自动 Task.sessionId ∪ 扫描到的旧 auto-prefix session entry。
- 对每个非 keep 候选先 `removeSessionDir`；false 时计 failed 且保留 Task。
- 删除成功后才删来源/session 匹配的自动 Task；Task 删除失败同样计 failed，下一轮由 Task 注册表重试。
- Run 不删除；返回三个计数字段，UI 文案报告部分失败。`failed` 对 Task 清理失败记录 taskId，对无 Task 的旧会话清理失败记录 sessionId。

route 的活跃集：

```ts
new Set([
  ...automationCollector.keys(),
  ...(ctx.runtimeCtx?.huaanworkTurnScheduler?.activeSessionIds() ?? []),
]),
join(ctx.dshHome, 'sessions'),
{ releaseSession: (sessionId) => releaseSessionRuntime(ctx.runtimeCtx, sessionId) },
```

完整调用为 `pruneAutomationSessions(profileDir, activeSet, sessionsRoot, opts)`。

同步 `src/client-huaanwork/projects.ts`：

```ts
export function pruneAutomationSessions(): Promise<{
  removed: number;
  tasksRemoved: number;
  failed: string[];
}> {
  return rpcCall("automation.pruneSessions");
}
```

AutomationsView 根据 failed 是否为空显示完整或部分成功；成功后调用既有 `onChanged`，由 App 刷新 tasks/sessions 并执行 Task 5 的 stale 标签对账。把 `automations-host.spec.ts` 的 prune 路由断言改为 `{removed:1,tasksRemoved:0,failed:[]}`。

- [ ] **Step 4: 验证并提交边界**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/automations-host.spec.ts tests/client-huaanwork/automations-runs-delete.spec.ts tests/client-huaanwork/appWiring.spec.ts`

Expected: PASS。仅在用户明确授权后提交。

---

### Task 9: 全量门禁与真机验收证据

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/acceptance-hooks.ts`（T4 崩溃点判定，纯函数）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`（三个崩溃点调用，主开关惰性）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/acceptance-hooks.spec.ts`（已存在，追加用例）
- Create after execution: `docs/evidence/2026-11-09-automation-project-linkage.md`
- Modify if acceptance exposes a defect: only files owned by Tasks 1-8

**Interfaces:**
- Consumes: Tasks 1-8 全部产物；既有 `acceptanceHooksEnabled` 主开关（acceptance-hooks.ts:56）。
- Produces: `acceptanceCrashPointMatches(point,env)`；逐项 PASS/BLOCKED 证据，不把单测、CI 结果或优雅重启冒充真机/崩溃验收。

- [ ] **Step 1: 跑完整门禁并保存退出码**

```bash
corepack yarn test
corepack yarn typecheck
corepack yarn check
```

Expected: 三条命令均 exit 0；失败时回到对应 Task 修复，不跳过 hook 或裁剪门禁。

- [ ] **Step 2: 崩溃点判定与调用点（T4，先单测后真机）**

在 `acceptance-hooks.ts` 追加纯判定（可单测，不直接 exit）：

```ts
export const HUAANWORK_ACCEPTANCE_CRASH_POINT_ENV = 'HUAANWORK_ACCEPTANCE_CRASH_POINT'
export type AcceptanceCrashPoint = 'after-running-mark' | 'after-run-task' | 'after-run-append'

export function acceptanceCrashPointMatches(point: AcceptanceCrashPoint, env: NodeJS.ProcessEnv = process.env): boolean {
  return acceptanceHooksEnabled(env) && env[HUAANWORK_ACCEPTANCE_CRASH_POINT_ENV] === point
}
```

单测：`HUAANWORK_ACCEPTANCE_HOOKS` 非 1 时任意 point 均 false；主开关开 + 精确匹配才 true；未知值 false。

在 `automations-host.ts` 三处调用（生产默认惰性，与既有 acceptance hooks 同形）：

```ts
// executeRun: markAutomation(running + activeRunId) 成功之后
if (acceptanceCrashPointMatches('after-running-mark')) process.exit(1)
// executeRun: createAutomationRunTask + run-task 发射之后、runAgentTurn 之前
if (acceptanceCrashPointMatches('after-run-task')) process.exit(1)
// finishAutomation: appendRun 成功之后、摘 inFlight/写终态之前
if (acceptanceCrashPointMatches('after-run-append')) process.exit(1)
```

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/acceptance-hooks.spec.ts tests/huaanwork-host/automations-host.spec.ts`
Expected: PASS；主开关关闭时既有全部用例行为不变。

- [ ] **Step 3: 构建并启动隔离真机实例**

```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native
REPO="$(pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/huaanwork-auto-link.XXXXXX")"
chmod 700 "$TMP_ROOT"
mkdir -p "$TMP_ROOT/.huaanwork" "$TMP_ROOT/userData/profile-selection"
cp -R "$HOME/.huaanwork/." "$TMP_ROOT/.huaanwork/"
cp "$HOME/Library/Application Support/HuaAnWork/profile-selection/state.json" \
   "$TMP_ROOT/userData/profile-selection/state.json"
echo "$TMP_ROOT" > /tmp/huaanwork-auto-link-tmp-root
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  DSH_HOME="$TMP_ROOT/.huaanwork" \
  HUAANWORK_ACCEPTANCE_HOOKS=1 \
  "$REPO/dsh-plugin-huaanwork/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  "$REPO/dsh-plugin-huaanwork/lib/main.js" \
  --user-data-dir="$TMP_ROOT/userData" --remote-debugging-port=9333 \
  > "$TMP_ROOT/electron.log" 2>&1 &
echo $! > "$TMP_ROOT/electron.pid"
```

Expected: build/prepare exit 0；临时根 700；CDP 9333 可达。不得使用共用生产数据的 dev 实例代替。若模型/登录 profile 复制后不可用，记 BLOCKED 并说明，不伪造运行。

- [ ] **Step 4: 三个崩溃窗口逐项验证**

每个窗口独立执行：以 `HUAANWORK_ACCEPTANCE_CRASH_POINT=<point>` 追加到 Step 3 启动 env 重启隔离实例 → 手动触发一次 agent 自动化 → Host 进程在注入点退出、supervisor 重启 → 去掉该 env 正常启动后核对：

| point | 崩溃时磁盘状态 | 恢复后断言 |
| --- | --- | --- |
| after-running-mark | running + activeRunId，无 Task | 补 cancelled 复用原 runId；agent 带推导 sessionId；无 Task 不伪造 |
| after-run-task | 上述 + Task 已建 | cancelled 带原 runId/taskId/sessionId；Task 仍在且可跳转或明确报无日志 |
| after-run-append | 上述 + Run 已落盘，注册表仍 running | 不重复补记；按原 Run 对账 lastStatus；ok Run 不得改报失败 |

证据：runs.jsonl 内容、tasks.json 关联字段、host 日志恢复行。任一窗口无法稳定注入或恢复不符，记 BLOCKED/FAIL 并保留现场，不得以 Task 3 单测冒充真机通过。

- [ ] **Step 5: 逐项执行交互验收**

1. 创建“每日十万个为什么”，侧栏立即出现同名项目；同名再建得到不同 UUID。
2. 手动运行，项目下出现带本机日期时间的子任务，运行标签与运行记录指向同一 Session。
3. 等待一次定时运行并触发一次 catchup；每次实际 started 各一个新 Task。
4. 运行记录点击切到正确项目/Task；重复点击不产生重复标签。
5. 改绑项目后点击旧 Run，仍回旧项目；新 Run 进新项目。
6. 删除 Run、Task、Automation、Project 各走一遍；确认无悬空 Task/Session；项目删除期间新建/改绑/建子任务被拒绝（T1）。
7. 对旧 Run 执行续聊，再 prune；活跃续聊会话不被删，超保留期 Task 与会话按协议清理，Run 保留且不可跳。
8. 自动化页确认无看板、widget、采集结果；script 记录明确无会话。

每项记录命令/操作、截图或 CDP 证据、PASS/BLOCKED 与残余风险。

- [ ] **Step 6: 清理、独立复核与交付**

```bash
TMP_ROOT="$(cat /tmp/huaanwork-auto-link-tmp-root)"
kill "$(cat "$TMP_ROOT/electron.pid")" 2>/dev/null || true
```

对照 spec §12 与本文 Step 4/5 逐项核对证据；没有真实执行的项目必须标 BLOCKED。临时根确认只含本次验收数据后再清理。仅在用户明确授权后提交实现和证据文档，不自动 push、不自动建 PR。

---

## Plan Self-Review

- Spec 覆盖：创建项目、agent 运行关联、日期命名、失败、重启、UI 退役、导航、删除/prune、历史兼容和验收分别映射到 Tasks 1-9。
- 类型一致：`automationId/runId/taskId/activeRunId`、`automation/run-task`、`activeSessionIds/activeAutomationIds` 在所有任务中同名；客户端 RPC 包装同步落在 `src/client-huaanwork/projects.ts`。
- 锚点顺序一致：单 Run 最后删 Run；Automation/Project 最后删注册项；prune 由 Task 注册表保证失败重试。
- 客户端对账一致：Task 5 先提供 tasksLoaded、请求序号与 staleAutomationRunTabs，Task 6/7/8 的删除和清理均复用，不遗留失效自动化标签。
- Review §6 必修点已落：T1 项目 guard（Task 7，含 task.create）；T3 过期应答丢弃（Task 5 Step 5）；T4 真机命令与崩溃注入（Task 9 Step 2-4）；N1 活跃拒绝只覆盖自动化来源（Task 7 Step 5）。
- GLM §8.6 六项收尾已落：spec §2 批准链来源、§9.1/§10/§12 T2 快照语义与残余窗口、§9.4 N2 边界；计划 Task 2 M2 摘条目 + agent 软失败回归钉、Task 3 逐条 catch、M3 三处同步（spec §11 补 automationRunLink.ts、run-end taskId 归 Task 2 Files、spec §8.1 统一为常驻快照口径）。
- 无占位符：所有实施步骤均给出目标文件、接口和验证命令；测试 helper 只允许复用现有 fixture，不允许留下待补逻辑。
