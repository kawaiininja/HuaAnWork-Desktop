# 中立会话独立子根与自动化任务自动绑定项目设计

- 日期：2026-11-07（已按评审意见 [`2026-11-07-neutral-subroots-and-automation-projects-design-review.md`](./2026-11-07-neutral-subroots-and-automation-projects-design-review.md) 修订）
- 状态：已修订。D3（中立 workspace 被登记成项目时，已铸造目录优先）与 D4（中立前缀的其余情况留在 workspace）已写入 §2 与 §3.2.3，与实施计划一致
- 实施边界：仅 `dsh-plugin-huaanwork/`。不改 `deepseek-harness/`，不改 [`TurnScheduler`](../../dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts) 的核心互斥原语。
- 关联规格：
  - [`2026-11-03-concurrent-project-turns-design.md`](./2026-11-03-concurrent-project-turns-design.md)
  - [`2026-11-07-neutral-subroots-and-automation-projects-design-review.md`](./2026-11-07-neutral-subroots-and-automation-projects-design-review.md)

---

## 1. 背景与问题陈述

在《多项目并发任务设计》（2026-11-03）落地后，[`TurnScheduler`](../../dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts) 通过 `rootWriters: Map<string, RootWriter>` 保证**同一可写根最多一个活跃写者**，并通过 `max_concurrent_turns`（默认 `3`，范围 `1–8`）控制全局并发回合数。

但在实际使用中暴露出一个严重的并发瓶颈：

1. **所有中立会话共享唯一中立根 `<profileDir>/workspace`**：
   - 未归属项目的日常任务会话（侧栏「任务」区对话、新建的未绑定项目标签）经 [`writableRootForSession`](../../dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts) 全部落到 `<profileDir>/workspace`。
   - 即便 `max_concurrent_turns = 3`，用户在「任务」区同时开启两个中立对话标签时，第二个标签也会因 `rootWriters.has("<profileDir>/workspace")` 而被强制排队（显示「等待当前任务」）。
2. **自动化任务默认 `projectId: null`，同样抢占 `<profileDir>/workspace`**：
   - 新建自动化任务在 [`AutomationsView.tsx`](../../dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx) 中默认不绑定项目（`projectId: null`），[`automationAdmissionRoot`](../../dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts) 将其解析到同一个 `<profileDir>/workspace`。
   - 一旦任何未绑定项目的自动化任务（甚至是不占模型并发名额的 `script` 脚本自动化）开始运行，`<profileDir>/workspace` 即被锁定：用户无法在中立工作区发起任何日常任务，其他未绑定项目的自动化任务也全部因 `root-busy` 被跳过；反之，用户在中立区对话期间，所有到期自动化也无法启动。

### 设计目标

同时落地两项互补改造，彻底解开中立根的单写者瓶颈，并保证并发回合之间的沙箱双向物理隔离：

1. **为独立中立会话派生与 `<profileDir>/workspace` 平级的独立可写根**：每个新建独立中立会话（`fresh: true`）拥有与 `<profileDir>/workspace` 平级的专属可写目录 `<profileDir>/workspace-sessions/<sessionId>`，使多个中立对话之间、以及新建中立对话与默认稳定会话 `work-1` 之间可以按 `max_concurrent_turns` 真正并行，且沙箱互不可写。
2. **将自动化任务绑定成项目（未选项目时自动创建专属项目）**：新建自动化任务时，若未选择已有项目（`projectId: null`），自动在 `<profileDir>/workspace-projects/<projectId>` 下创建物理目录并登记到 `projects.json`，将该自动化绑定到新项目；自动创建的项目直接出现在侧栏「项目」列表中。

---

## 2. 已确认的产品与架构裁定

| 决策点 | 已确认方案 |
| --- | --- |
| 总体方向 | 「中立会话派生独立根」与「自动化任务自动绑定项目」同时实施，互不矛盾 |
| 新根与 `<profileDir>/workspace` 的拓扑关系（P1-1） | 三类新根全部作为 `<profileDir>/workspace` 的**平级兄弟目录**（直接位于 `<profileDir>/` 下），绝不放在仍有活跃写者（`work-1` 及历史存量会话）的 `<profileDir>/workspace` 内部，杜绝父根回合越界写入子目录的单向沙箱洞 |
| 自动化创建归属与 RPC 合同变更（P2-1） | **破坏性 RPC 合同变更**：`automation.create` 传入 `projectId: null`（含创建表单默认项、输入框调度短语入口及直调方）的语义从「无归属中立自动化」改为「先自动创建同名项目写入 `projects.json`，再将自动化绑定到该新项目并返回非空 `projectId`」；同时保留下拉框供用户手动选择已有本地项目 |
| 自动创建项目的目录 | `<profileDir>/workspace-projects/<projectId>`（创建时确保物理目录存在，项目名取自动化任务名称 `input.name`） |
| 自动创建项目的展示与生命周期（P2-4） | 直接写入 `projects.json`，原样展示在侧栏「项目」列表（[`ProjectsPanel.tsx`](../../dsh-plugin-huaanwork/src/client-huaanwork/ProjectsPanel.tsx)）中；同名自动化产生同名项目（靠 UUID 物理路径区分）；后续重命名自动化不会联动改项目名 |
| 自动化与项目删除联动（P2-4） | 删除自动化任务（`automation.remove`）时**保留**该项目及其目录；在侧栏删除项目（`project.remove`）时，沿用现有逻辑级联清理该项目下的自动化任务与子任务，并仅移除 `projects.json` 注册表条目（与手动项目一致，不删磁盘目录 `<profileDir>/workspace-projects/<projectId>`） |
| 中立会话根布局（P1-1 / P1-2 / P1-3） | 独立中立会话（`fresh: true` 且由 `session.new` 铸造）的可写根为 `<profileDir>/workspace-sessions/<sessionId>`；通道默认稳定会话（`work-1`，`sessionId === sessionIdFor(neutralRoot)`）及升级前 `header.cwd` 等于或位于 `<profileDir>/workspace` 之内的存量中立会话保持 `<profileDir>/workspace` |
| workspace 被登记成项目（D3） | 项目根解析后等于 `<profileDir>/workspace` 时，会话 id 以中立稳定 id 加 `-` 开头，并且 `workspace-sessions/<sessionId>` 已存在，或持久化 `header.cwd` 落在该目录内，可写根仍是该会话目录。恰好等于 work-1 稳定 id 的会话仍用 `<profileDir>/workspace` |
| 中立前缀的其余情况（D4） | 带中立前缀、但既不是 workspace 内的存量会话、也不是已铸造会话目录的会话，可写根仍是 `<profileDir>/workspace`。不按 `header.cwd` 改判到另一个项目，也不改判到 `workspace-automations`。唯一项目归属和自动化目录识别只用于不带中立前缀的会话。保留现有测试 `the neutral stable id stays neutral even when the logged cwd is inside a project` |
| 存量 `projectId: null` 自动化与已删项目（P2-3） | 历史遗留的 `projectId: null` 自动化不强制改写注册表，在 `automationAdmissionRoot` 中映射到 `<profileDir>/workspace-automations/<automationId>` 并在此目录真正执行；`projectId !== null` 但对应项目已从 `projects.json` 删除时，准入同样使用 `<profileDir>/workspace-automations/<automationId>`（不占 `<profileDir>/workspace`），随后在 `executeRun` 调用 `runAgentTurn` / `runScript` **之前**立即按既有分支记 `MISSING_PROJECT_OUTPUT`（或取消态 `'已停止'`）并返回释放准入 |

---

## 3. 详细设计

### 3.1 目录拓扑与沙箱双向隔离（修正 P1-1）

`<profileDir>` 下的工作区相关目录采用**平级兄弟拓扑**，互不为父子关系：

```text
<profileDir>/
├── workspace/                                 ← 默认通道稳定会话（work-1）及升级前 cwd 在此树内的存量中立会话根
├── workspace-sessions/
│   └── <sessionId>/                           ← 每个由 session.new(fresh: true) 铸造的独立中立会话专属可写根
├── workspace-projects/
│   └── <projectId>/                           ← 自动化创建时自动生成的项目物理根（登记进 projects.json）
└── workspace-automations/
    └── <automationId>/                        ← 存量 projectId === null 自动化任务的独立可写根（及已删项目准入锁根）
```

**双向沙箱与调度隔离性质验证**：

1. **沙箱双向不可互写（[`sandbox-cwd.ts:71-78`](../../dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts#L71-L78)）**：
   - `work-1` 的允许根为 `<profileDir>/workspace`。由于 `isInside` 使用 `relative(resolve(root), resolve(candidate))` 判定路径包含关系，`<profileDir>/workspace-sessions/*`、`<profileDir>/workspace-projects/*`、`<profileDir>/workspace-automations/*` 相对于 `<profileDir>/workspace` 的相对路径均为 `../workspace-*`，`isInside` 恒为 `false`。
   - 因此：`work-1` 无法写入任何独立中立会话、自动项目或存量自动化目录；反之，任何独立中立会话或自动项目也无法写回 `<profileDir>/workspace` 或其他兄弟目录。
2. **`TurnScheduler` 写者锁天然隔离**：
   - `work-1` 锁 `<profileDir>/workspace`；
   - 新建中立任务 `S1`、`S2` 分别锁 `<profileDir>/workspace-sessions/<S1>`、`<profileDir>/workspace-sessions/<S2>`；
   - 自动化绑定的自动项目 `P1`、`P2` 分别锁 `<profileDir>/workspace-projects/<P1>`、`<profileDir>/workspace-projects/<P2>`；
   - 存量 `projectId === null` 自动化 `A1` 锁 `<profileDir>/workspace-automations/<A1>`。
   - 各 `root` 路径两两不同且物理目录互不包含，[`TurnScheduler`](../../dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts) 无需修改原语即可在 `max_concurrent_turns` 额度内安全并行。
3. **同一会话 / 同一项目内部仍严格串行**：
   - 同一中立会话连续发送两条消息，共享同一个 `<profileDir>/workspace-sessions/<sessionId>`，第二条照常排队。
   - 绑定到同一项目 P 的自动化与该项目下的子任务共享 `project.root`，保证同一项目工作区内不会并发写冲突。

---

### 3.2 Part A：中立会话独立根

#### 3.2.1 路径辅助与路径分量安全校验（`workspace-state.ts`）

在 [`workspace-state.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts) 中新增平级命名空间路径函数，并对拼入路径的动态标识做严格单路径分量校验（修正 P1-1、P1-2）：

```typescript
/** 校验 id 为合法的单层目录名（非空、不含 / 或 \、不为 . 或 ..）。不合法直接抛错拒绝，绝不回退到共享中立根。 */
export function assertSafePathSegment(id: string, label: string): string {
  const trimmed = id.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    throw new Error(`非法 ${label}: ${id}`)
  }
  return trimmed
}

/** 独立中立会话根目录父容器：<profileDir>/workspace-sessions */
export function neutralSessionsBaseDir(profileDir: string): string {
  return join(profileDir, 'workspace-sessions')
}

/** 独立中立会话根的纯路径推导（不创建目录，无磁盘写副作用）。 */
export function neutralSessionRootPath(profileDir: string, sessionId: string): string {
  return join(neutralSessionsBaseDir(profileDir), assertSafePathSegment(sessionId, 'sessionId'))
}

/** 独立中立会话根（确保目录存在，仅在 sessionNew 确认分配给新会话时调用）。 */
export function neutralSessionRoot(profileDir: string, sessionId: string): string {
  const root = neutralSessionRootPath(profileDir, sessionId)
  mkdirSync(root, { recursive: true })
  return root
}

/** 自动化自动创建的项目目录路径：<profileDir>/workspace-projects/<projectId>（纯路径）。 */
export function autoProjectRootPath(profileDir: string, projectId: string): string {
  return join(profileDir, 'workspace-projects', assertSafePathSegment(projectId, 'projectId'))
}

/** 存量未绑定自动化根目录父容器：<profileDir>/workspace-automations */
export function neutralAutomationsBaseDir(profileDir: string): string {
  return join(profileDir, 'workspace-automations')
}

/** 存量未绑定自动化根的纯路径推导（不创建目录）。 */
export function neutralAutomationRootPath(profileDir: string, automationId: string): string {
  return join(neutralAutomationsBaseDir(profileDir), assertSafePathSegment(automationId, 'automationId'))
}

/** 存量未绑定自动化根（确保目录存在，在自动化准入/执行时调用）。 */
export function neutralAutomationRoot(profileDir: string, automationId: string): string {
  const root = neutralAutomationRootPath(profileDir, automationId)
  mkdirSync(root, { recursive: true })
  return root
}
```

#### 3.2.2 会话铸造（`sessions.ts` 的 `sessionNew`）

修改 [`sessionNew`](../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L1032-L1042)（修正 P1-2）：

- 先按现有规则计算基准 `cwd`（传入合法存在的绝对目录则 `resolve(requested)`，否则 `resolve(routeCtx.workspaceRoot.current)`）。
- 设 `neutralRoot = resolve(neutralWorkspaceRootPath(routeCtx.profileDir))`。
- **当 `fresh === true` 且 `cwd === neutralRoot` 时**：
  1. `sessionId` 仍由 `freshSessionIdFor(neutralRoot)` 生成（格式见 [`session-id.ts:5-11`](../../dsh-plugin-huaanwork/src/huaanwork-host/session-id.ts#L5-L11)：`huaanwork-<16位sha256十六进制>-<8位随机串>`，即 `${sessionIdFor(neutralRoot)}-<8hex>`）；
  2. 在 `sessionNew` 中显式创建该会话专属目录：`const sessionCwd = resolve(neutralSessionRoot(routeCtx.profileDir, sessionId))`；
  3. 返回 `{ sessionId, cwd: sessionCwd }`。
- **当 `fresh === false`（如 `work-1` 默认通道稳定会话）或 `cwd !== neutralRoot`（属于具体项目根）时**：
  保持现有行为不变，返回 `{ sessionId, cwd }`。

这样客户端 `App.tsx` 的 `rememberMinted(minted)`（[`App.tsx:692-696`](../../dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L692-L696)）会直接记录该会话的真实独立根 `cwd`，用于回合结束时的 `outcomeWorkspace` 文件核对。

#### 3.2.3 无副作用的可写根推导（`writable-root.ts` 的 `writableRootForSession`）

[`writableRootForSession`](../../dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts#L23-L55) 不调用 `mkdirSync`（修正 P1-2、P1-3、D3、D4）。中立前缀会话在确认「目录已由 `session.new` 建好」时可以 `existsSync` 加 `statSync` 一次；这个读取不能删，否则尚未写入 header 的新会话会掉回共享 workspace。

先算出 `neutralRoot = resolve(neutralWorkspaceRootPath(profileDir))` 与 `neutralStable = sessionIdFor(neutralRoot)`。

1. **任务绑定（不变）**：`tasks.find((task) => task.sessionId === sessionId)` 命中且对应项目存在 ⇒ 返回 `resolve(project.root)`。
2. **项目稳定会话前缀**：`sessionId === stable || sessionId.startsWith(`${stable}-`)` 命中某项目时，默认返回 `resolve(project.root)`。例外（D3）：该项目根解析后等于 `neutralRoot`，会话 id 以 `${neutralStable}-` 开头，并且 `workspace-sessions/<sessionId>` 已存在或 `headerCwd` 落在该目录内时，不返回这个项目根，继续步骤 3。恰好等于 `neutralStable` 的 work-1 不走这个例外，仍返回 `<profileDir>/workspace`。
3. **中立会话分支（精确识别已铸造独立会话与存量中立会话）**：
   - **3a. 通道默认稳定会话**（`sessionId === neutralStable`）：
     返回 `neutralRoot`（`<profileDir>/workspace`）。
   - **3b. 带中立稳定前缀的独立会话**（`sessionId.startsWith(`${neutralStable}-`)`）：
     先通过 `neutralSessionRootPath(profileDir, sessionId)` 推导候选独立根 `sessionRoot = resolve(neutralSessionRootPath(profileDir, sessionId))`（若 `sessionId` 含非法路径分量则直接抛错拒绝）：
     - **存量中立会话兼容（P1-3）**：若传入了持久化 `headerCwd`，且 `isInside(neutralRoot, headerCwd)` 为真（即升级前持久化 `cwd` 等于 `<profileDir>/workspace` 或位于 `<profileDir>/workspace` 子目录内的存量会话），返回 `neutralRoot`。
     - **已落盘在独立根上的中立会话**：若传入了持久化 `headerCwd`，且 `isInside(sessionRoot, headerCwd)` 为真，返回 `sessionRoot`（不调 `mkdirSync`；若磁盘目录已被外部删除，后续 [`sessions.ts:955`](../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L955) 的 `existsSync(root)` 检查将按既有逻辑拒绝）。
     - **刚由 `session.new(fresh: true)` 铸造、尚未落首条 header 的新会话（P1-2）**：若 `headerCwd === undefined`，且磁盘上 `existsSync(sessionRoot) && statSync(sessionRoot).isDirectory()` 为真（证明已由 `sessionNew` 铸造建好目录），返回 `sessionRoot`。
     - **其余情况（D4）**：未知或伪造的中立前缀，以及 `headerCwd` 落在其他项目里的中立前缀，都返回 `neutralRoot`。到此结束，不继续步骤 4–5。因此 cwd 已经落在别的项目里的这类旧会话仍会在恢复时被「属于其他工作区」拒绝；这是相对「按 cwd 改判到那个项目」的明确取舍，现有测试 `the neutral stable id stays neutral even when the logged cwd is inside a project` 继续有效。
4. **持久化 `header.cwd` 唯一项目归属回退**：只用于会话 id 既不等于 `neutralStable`、也不以 `${neutralStable}-` 开头的会话。`soleContainingProjectRoot(projects, headerCwd)` 命中唯一项目 ⇒ 返回该项目根。
5. **存量未绑定自动化运行会话恢复识别**：同样只用于不带中立前缀的会话。若 `headerCwd` 存在且位于 `neutralAutomationsBaseDir(profileDir)` 之内（即存量 `projectId: null` 自动化运行产生的会话，其 `header.cwd` 为 `<profileDir>/workspace-automations/<automationId>`），返回该 `<profileDir>/workspace-automations/<automationId>` 根路径（不调 `mkdirSync`）。
6. **最终兜底（维持 2026-11-03 规格 §5.1.1 现有回落，P1-2）**：
   步骤 1–5 都没有返回的会话（包括已删除项目的旧会话、无日志的未知会话 id；不含已在步骤 3 返回的中立前缀）一律返回 `neutralRoot`（`resolve(neutralWorkspaceRootPath(profileDir))`），**绝不在推导阶段创建任何 `workspace-sessions/*` 目录**：
   - 若该会话已有持久化日志且 `persisted.cwd` 不在 `neutralRoot` 内（如已删除项目的旧会话），在 [`ensureChannelAgent`](../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L417) 中因 `!isInside(root, persisted.cwd)` 被拒绝恢复，不留空目录；
   - 若该会话无持久化日志（未知新 id 直调发送），则沿用现有行为在 `neutralRoot`（`<profileDir>/workspace`）下新建会话，同样不在 `workspace-sessions/` 下产生目录。

#### 3.2.4 会话删除与启动清扫联动（修正 P1-1、P1-2）

1. **删除中立会话时清理独立根（`sessions.ts`）**：
   在 [`removeSession`](../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L598-L611) 中：先对 `sessionId` 执行 `assertSafePathSegment(sessionId, 'sessionId')` 校验（非法直接拒绝）；删除会话日志文件后，若 `sessionId.startsWith(`${sessionIdFor(neutralWorkspaceRootPath(profileDir))}-`)`，顺带调用 `await rm(neutralSessionRootPath(profileDir, sessionId), { recursive: true, force: true }).catch(() => undefined)` 清理其独立沙箱目录。
2. **启动清扫保护（`session-sweep.ts` 与 `index.ts`）**：
   - 由于自动创建的项目位于平级的 `<profileDir>/workspace-projects/<projectId>`，不在 `<profileDir>/workspace` 内，[`session-sweep.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/session-sweep.ts) 的现有 `cwdWithinAnyRoot(dirCwd, protectedRoots)` 逻辑**无需任何收窄或特判**。
   - 在 [`index.ts:197-202`](../../dsh-plugin-huaanwork/src/huaanwork-host/index.ts#L197-L202) 中，将 `protectedRoots` 扩展为三个中立保护根：
     ```typescript
     const protectedRoots = [
       neutralWorkspaceRoot(config.profileDir),
       neutralSessionsBaseDir(config.profileDir),
       neutralAutomationsBaseDir(config.profileDir),
     ]
     ```
   - 效果：
     - `<profileDir>/workspace`（默认会话与存量中立会话）、`<profileDir>/workspace-sessions/*`（独立中立会话）、`<profileDir>/workspace-automations/*`（存量未绑定自动化）即使落在某个祖先项目的目录前缀内，也永不参加项目存量清扫；
     - `<profileDir>/workspace-projects/<projectId>` 作为登记在 `projects.json` 中的普通项目根，直接沿用现有项目存量清扫规则，清理其下无 task 引用的游离会话。

---

### 3.3 Part B：自动化任务自动创建项目并绑定

#### 3.3.1 项目注册表并发写锁（`stores.ts`）

在 [`stores.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/stores.ts) 中为 `projects.json` 补齐与 `withTaskRegistryLock`、`withAutomationRegistryLock` 同构的进程内串行写锁 `withProjectRegistryLock`：

```typescript
let projectRegistryLock: Promise<unknown> = Promise.resolve()

export function withProjectRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = projectRegistryLock.then(fn)
  projectRegistryLock = run.catch(() => undefined)
  return run
}
```

将 `createProject`、`renameProject`、`removeProject`、`touchProject` 全部包裹在 `withProjectRegistryLock` 内，避免自动创建项目与用户手动操作 `projects.json` 并发交错时互相覆盖。

#### 3.3.2 `automation.create` 自动建项目流程与破坏性合同说明（`routes.ts` & `automations-store.ts`）

> **破坏性 RPC 合同变更（P2-1）**：
> `automation.create` 接收 `projectId: null`（或省略 `projectId`）时，不再创建 `projectId === null` 的无归属自动化，而是自动在 `projects.json` 中新建一个同名项目（`name = input.name`，`root = <profileDir>/workspace-projects/<projectId>`），并将新自动化绑定到该 `projectId`（返回的 `AutomationInfo.projectId` 恒为非空字符串）。
> 所有经过 `automation.create` 的入口——包括自动化弹窗默认项、聊天输入框的调度短语快捷创建（[`App.tsx:2572-2578`](../../dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2572-L2578)）以及直接调用该 RPC 的测试——都会遵守这一新合同并产生 `projects.json` 条目。既有单测中若断言 `automation.create` 返回 `projectId: null` 的用例需同步更新；专门测试历史存量 `projectId: null` 兜底行为的单测应直接构造或写入存储层 fixture。

在 [`routes.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1132-L1149) 的 `automation.create` 路由中：

1. 先调用 `const input = normalizeAutomationInput(req.body as Record<string, unknown>)` 完成全部字段、cron/once 时间、提示词长度校验（校验不过直接抛错，不产生任何目录或项目副作用）。
2. **分支一：用户显式选择了已有项目（`input.projectId !== null`）**
   - 校验 `input.projectId` 在 `listProjects(ctx.profileDir)` 中存在，不存在则报错 `project ${input.projectId} was not found`。
   - 调用 `createAutomation(ctx.profileDir, input)`。
3. **分支二：用户未选择已有项目（`input.projectId === null`，默认「自动创建同名项目」）**
   - 先预检自动化数量上限（若当前 `automations.length >= MAX_AUTOMATIONS`，先抛上限错误，避免多建空项目）。
   - 生成新项目 id 与目录：
     ```typescript
     const projectId = randomUUID()
     const projectRoot = autoProjectRootPath(ctx.profileDir, projectId)
     await mkdir(projectRoot, { recursive: true })
     const project = await createProject(ctx.profileDir, {
       id: projectId,
       name: input.name,
       root: projectRoot,
     })
     ```
   - 将 `project.id` 传入 `createAutomation(ctx.profileDir, { ...input, projectId: project.id })`。
   - **尽最大努力回滚（Best-Effort Rollback，P2-4）**：若 `createAutomation` 抛错（例如并发请求同时跨过预检触发 `MAX_AUTOMATIONS` 或写盘失败），在 `catch` 中尽最大努力调用 `removeProject(ctx.profileDir, project.id)` 与 `rm(projectRoot, { recursive: true, force: true })` 清理刚创建的项目与空目录，再向外抛出原异常。由于 `projects.json` 与 `automations.json` 是两个独立文件，这不是跨文件事务：若进程在 `createProject` 落盘后、`createAutomation` 完成前崩溃退出，或回滚本身失败，侧栏 `projects.json` 中可能留下一个无害的空项目，用户可按常规项目直接删除或复用。

#### 3.3.3 支持编辑态修改归属项目及在途保护（`automations-store.ts` & `routes.ts`，修正 P2-2）

放开 [`updateAutomation`](../../dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts#L302-L349) 对 `projectId` 的修改限制，并明确在途回合与旧文件语义：

1. **合法目标校验**：只允许将 `projectId` 改为非空且在 `projects.json` 中真实存在的项目 id（不允许通过 `automation.update` 把 `projectId` 改回 `null`）。
2. **在途运行拒绝改绑（P2-2）**：在 `routes.ts` 的 `automation.update` 中，若请求传入了 `patch.projectId` 且与当前 `existing.projectId` 不同，先检查该自动化是否有在途运行（调用 `automations-host.ts` 导出的 `hasInFlightAutomationRun(id)`，即 `inFlightRunsOf(id).length > 0`）；若存在在途运行（`queued` 或 `started`），直接拒绝本次改绑并报错 `该自动化任务正在运行，请等待运行结束或停止后再修改归属项目`。
3. **文件与轮次边界（P2-2）**：
   - 已经准入的轮次始终使用准入时锁定的 `admission.root` 直至该轮结束；改绑成功后，从**下一轮触发**起使用新项目的 `project.root`。
   - 旧项目目录中的历史文件与产物**不迁移、不删除**，保留在原项目目录内。

#### 3.3.4 存量 `projectId: null` 自动化与已删项目的准入与执行顺序（`automations-host.ts`，修正 P2-3）

在 [`automationAdmissionRoot`](../../dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L195-L201) 与 [`executeRun`](../../dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L578-L599) 中，严格区分**存量 `projectId === null`** 与**已绑定项目被删除（`projectId !== null && !project`）**两种情况：

1. **准入根计算（`automationAdmissionRoot` 保持纯路径、不建目录）**：
   ```typescript
   export async function automationAdmissionRoot(routeCtx: RouteContext, automation: AutomationInfo): Promise<string> {
     if (automation.projectId) {
       const project = (await listProjects(routeCtx.profileDir)).find((item) => item.id === automation.projectId)
       if (project) return pathResolve(project.root)
     }
     return pathResolve(neutralAutomationRootPath(routeCtx.profileDir, automation.id))
   }
   ```
   - 若 `automation.projectId` 命中有效项目 ⇒ 返回 `pathResolve(project.root)`；
   - 若 `automation.projectId === null`（历史存量未绑定自动化）或 `automation.projectId !== null` 但项目已从 `projects.json` 删除 ⇒ 返回纯路径 `pathResolve(neutralAutomationRootPath(routeCtx.profileDir, automation.id))`（即 `<profileDir>/workspace-automations/<automation.id>`，**准入阶段不调 `mkdirSync`**）。两者都不会占用 `<profileDir>/workspace` 写者锁。
2. **执行体分支顺序与按需建目录（`executeRun`，P2-3）**：
   - **情况 A：已绑定项目但项目已删除（`automation.projectId !== null && !project`）**：
     在 `executeRun`（[`automations-host.ts:578-599`](../../dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts#L578-L599)）进入 `runAgentTurn` / `runScript` **之前**，命中现有的 `if (automation.projectId && !project)` 分支，立即调用 `finishAutomation` 记录 `MISSING_PROJECT_OUTPUT`（若已被停止则记 `'已停止'`）并 `return`，随后在 `finally` 中通过未交接的 `admission.release()` 立即释放准入锁——**既不在兜底目录里执行提示词或脚本，也不会在磁盘上创建 `<profileDir>/workspace-automations/<automation.id>` 空目录**。
   - **情况 B：历史存量未绑定任务（`automation.projectId === null`）**：
     `automation.projectId && !project` 为假，不触发缺失项目早退；在进入 `runAgentTurn` 或 `runScript` 之前调用 `neutralAutomationRoot(routeCtx.profileDir, automation.id)` 确保 `<profileDir>/workspace-automations/<automation.id>` 物理目录存在，并在该目录中真正执行。

#### 3.3.5 前端交互与状态刷新（`AutomationsView.tsx` & `App.tsx`）

1. **创建/编辑模态框文案与交互（[`AutomationsView.tsx`](../../dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx#L1112-L1132)）**：
   - 将创建表单中「归属项目」下拉框的默认项文案从 `不绑定（中立任务）` 改为 `自动创建同名项目（推荐）`（值仍为 `""`，提交 `projectId: null` 触发后端自动建项目）。
   - 下方辅助说明改为：`未选择已有项目时，将自动为您创建同名项目并绑定；也可选择已有项目`。
   - 编辑模式（`editing.mode === "edit"`）开放「归属项目」下拉框（仅展示已有项目列表，不含「自动创建」空项；若为历史存量 `projectId === null` 的任务，显示占位提示允许改绑到任一已有项目）。当该任务正在运行时（`running === true`），下拉框置为 `disabled` 并提示运行中不可改绑。
2. **创建自动化后同步刷新项目列表（[`App.tsx`](../../dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2572-L2578)、[`App.tsx:3557-3559`](../../dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3557-L3559)）**：
   - `AutomationsView` 的 `onChanged` 同时触发 `void refreshAutomations()` 与 `void refreshProjects()`，确保无论从自动化面板还是从聊天输入框调度短语创建自动化，自动创建的项目都立即出现在左侧「项目」面板中，且自动化列表行的项目徽标立即可见。

---

## 4. 关键边界与异常场景（Edge Cases）

| 场景 | 行为与保障 |
| --- | --- |
| **1. 升级前已存在的旧中立会话恢复（`session.resume`，P1-3）** | 旧会话 id 带 `neutralStable-` 前缀，且日志 `header.cwd` 等于 `<profileDir>/workspace` 或位于 `<profileDir>/workspace` 之内。`writableRootForSession` 检测到 `isInside(neutralRoot, headerCwd)` 时返回 `<profileDir>/workspace`，满足 `ensureChannelAgent` 的 `isInside(root, cwd)` 守卫，无缝恢复。 |
| **2. 默认会话 `work-1` 与新建独立中立会话、自动项目同时运行（P1-1）** | `work-1` 根为 `<profileDir>/workspace`；新建中立会话根为 `<profileDir>/workspace-sessions/<sessionId>`；自动项目根为 `<profileDir>/workspace-projects/<projectId>`。三者为平级兄弟目录，互不包含，`TurnScheduler` 锁互不冲突，`sandbox-cwd` 双向夹回各自根，杜绝越界读写。 |
| **3. 未知会话 id 或已删除项目的旧会话调用推导（P1-2）** | `writableRootForSession` 无 `mkdirSync` 副作用，未知会话 id 或已删项目会话均回落到 `<profileDir>/workspace`，不会在 `workspace-sessions/` 下留下任何空目录：其中已有日志且 `persisted.cwd` 不在 `<profileDir>/workspace` 内的旧会话（如已删项目会话）在 `ensureChannelAgent` 中被拒绝恢复；无持久化日志的未知 id 则沿用现有行为在 `<profileDir>/workspace` 下新建会话。 |
| **4. 自动化任务创建校验失败、达 50 条上限或写盘失败（P2-4）** | 先校验入参与预检 `MAX_AUTOMATIONS`，再建项目目录与 `projects.json` 条目；若写 `automations.json` 失败则尽最大努力回滚删除刚建的项目记录与空目录（进程崩溃窗口可能留下空项目）。 |
| **5. 两个同名的自动化任务先后自动建项目与后续重命名（P2-4）** | 项目物理路径按 `<profileDir>/workspace-projects/<projectId>`（UUID）区分，`createProject` 按 `root` 判重而非按 `name` 判重，同名自动化各自拥有独立的同名项目；后续重命名自动化任务不改写项目名。 |
| **6. 用户在侧栏删除了自动化关联的项目（P2-4）** | 走现有 `project.remove` 路由，级联调用 `removeAutomationsOfProject` 清理该项目下的自动化及运行记录；与手动添加的项目一致，`removeProject` 只移除 `projects.json` 条目，保留磁盘上的 `<profileDir>/workspace-projects/<projectId>` 目录。 |
| **7. 用户删除自动化任务（P2-4）** | 走现有 `automation.remove` 路由，只删该自动化及其运行会话记录，保留 `projects.json` 中的项目与 `<profileDir>/workspace-projects/<projectId>` 目录，避免误删用户在该项目下产生的文件或子任务。 |
| **8. 编辑自动化修改归属项目（P2-2）** | 有在途运行（`queued` / `started`）时拒绝改绑；无在途运行时更新 `projectId`，旧项目目录文件不搬家，下一轮运行起使用新项目的 `root`。 |
| **9. 存量 `projectId: null` 自动化 vs 已删项目自动化触发运行（P2-3）** | 两者准入锁键均为纯路径 `<profileDir>/workspace-automations/<automationId>`（不占 `<profileDir>/workspace` 且准入阶段不建目录）；已删项目自动化在 `executeRun` 执行模型或脚本前立即记 `MISSING_PROJECT_OUTPUT` 并返回释放锁，磁盘上不产生空目录；存量 `projectId: null` 自动化在执行前由 `neutralAutomationRoot` 建好目录并正常执行。 |

---

## 5. 改动文件清单

| 文件 | 改动摘要 |
| --- | --- |
| [`dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts) | 新增 `assertSafePathSegment`、`neutralSessionsBaseDir`、`neutralSessionRootPath`、`neutralSessionRoot`、`autoProjectRootPath`、`neutralAutomationsBaseDir`、`neutralAutomationRootPath`、`neutralAutomationRoot`（平级兄弟目录拓扑） |
| [`dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts) | 纯函数无 `mkdirSync` 推导：已铸造独立中立会话返回 `<profileDir>/workspace-sessions/<sessionId>`，存量 `isInside(neutralRoot, headerCwd)` 会话返回 `<profileDir>/workspace`，存量未绑定自动化会话返回 `<profileDir>/workspace-automations/<automationId>`，未知/已删项目会话回落 `<profileDir>/workspace` |
| [`dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts) | `sessionNew` 在 `fresh: true` 且基准 `cwd` 为中立根时调用 `neutralSessionRoot` 创建并返回独立会话根；`removeSession` 校验 `sessionId` 并顺带清理对应的 `<profileDir>/workspace-sessions/<sessionId>` |
| [`dsh-plugin-huaanwork/src/huaanwork-host/index.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/index.ts) | `sweepProjectLegacySessionsOncePerProcess` 的 `protectedRoots` 传入 `[neutralWorkspaceRoot, neutralSessionsBaseDir, neutralAutomationsBaseDir]`（`session-sweep.ts` 本身无需特判） |
| [`dsh-plugin-huaanwork/src/huaanwork-host/stores.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/stores.ts) | 为 `projects.json` 读写补齐 `withProjectRegistryLock`；`createProject` 支持传入指定 `id` |
| [`dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts) | `updateAutomation` 支持修改 `projectId`（非空字符串） |
| [`dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts) | `automationAdmissionRoot` 对无有效项目的自动化返回纯路径 `neutralAutomationRootPath(profileDir, automation.id)`（不建目录）；`executeRun` 在 `if (automation.projectId && !project)` 早退之后、`automation.projectId === null` 真正执行之前调用 `neutralAutomationRoot` 建目录；导出 `hasInFlightAutomationRun(automationId)` 供改绑守卫使用 |
| [`dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`](../../dsh-plugin-huaanwork/src/huaanwork-host/routes.ts) | `automation.create` 在 `projectId === null` 时预检上限、自动创建项目并绑定（含尽最大努力回滚）；`automation.update` 校验新 `projectId` 存在且无在途运行 |
| [`dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx`](../../dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx) | 创建表单默认项文案更新为「自动创建同名项目（推荐）」，编辑态开放项目改绑（运行中禁用） |
| [`dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`](../../dsh-plugin-huaanwork/src/client-huaanwork/App.tsx) | `AutomationsView` 的 `onChanged` 同步调用 `refreshProjects()` |

---

## 6. 测试计划（含 P2-5 沙箱隔离锁死用例）

1. **平级目录沙箱双向隔离单测（`sandbox-cwd.spec.ts` / `writable-root.spec.ts`，P1-1 & P2-5）**：
   - 默认会话（允许根为 `<profileDir>/workspace`）尝试向 `<profileDir>/workspace-sessions/<S1>`、`<profileDir>/workspace-projects/<P1>` 或 `<profileDir>/workspace-automations/<A1>` 写入或切换 `cwd` 时，被 [`pinnedCwd`](../../dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts#L71-L78) 夹回 `<profileDir>/workspace`，目标兄弟目录中不出现越界文件。
   - 两个独立中立会话 `<profileDir>/workspace-sessions/<S1>` 与 `<profileDir>/workspace-sessions/<S2>` 的允许根互不包含，任一方请求对方路径时均被 `pinnedCwd` 夹回自身根。
   - `writableRootForSession` 推导未知 `sessionId` 或已删除项目的旧 `sessionId` 时，返回 `<profileDir>/workspace` 且磁盘上**不会创建** `<profileDir>/workspace-sessions/<sessionId>` 目录（无副作用）。
   - `assertSafePathSegment` 对含 `/`、`\`、`..` 的非法 `sessionId` / `automationId` 直接抛错拒绝，不回落到 `<profileDir>/workspace`。
2. **中立会话并发与存量恢复单测（`sessions.spec.ts`，P1-2 & P1-3）**：
   - `neutralStable`（`work-1`）推导结果为 `<profileDir>/workspace`。
   - `session.new(fresh: true)` 铸造的两个中立会话 `S1`、`S2` 各自生成 `huaanwork-<16hex>-<8hex>` 格式 id 并分配 `<profileDir>/workspace-sessions/<S1>` 与 `<profileDir>/workspace-sessions/<S2>`，在 `max_concurrent_turns >= 2` 时同时发送消息均返回 `started: true`（不进入 `waiting`）。
   - 持久化 `header.cwd` 等于 `<profileDir>/workspace` 或位于 `<profileDir>/workspace/subdir` 内的存量中立会话，推导结果仍为 `<profileDir>/workspace`，`session.resume` 成功不报错。
   - `session.remove` 删除独立中立会话后，对应的 `<profileDir>/workspace-sessions/<sessionId>` 目录一并被清理。
3. **自动化自动创建项目、改绑守卫与存量/已删项目行为单测（`automations.spec.ts`，P2-1 ~ P2-4）**：
   - `automation.create` 传 `projectId: null` 时，自动在 `projects.json` 新增同名项目（`root` 为 `<profileDir>/workspace-projects/<projectId>` 且目录存在），返回的 `automation.projectId` 等于新项目 `id`。
   - 达到 `MAX_AUTOMATIONS` 上限时，`automation.create` 失败且不会在 `projects.json` 中留下孤儿项目；模拟 `createAutomation` 失败时验证回滚清理了刚创建的项目与目录。
   - `automation.update` 在任务无在途运行时可将 `projectId` 改绑到另一已存在项目，下一轮运行使用新项目 `root`；当任务有在途运行时，`automation.update` 修改 `projectId` 被拒绝。
   - 存量 `projectId: null` 的自动化任务（直接写入存储 fixture）在 `automationAdmissionRoot` 中解析到 `<profileDir>/workspace-automations/<automationId>`，执行时建好该目录并正常完成，运行期间不阻塞 `<profileDir>/workspace` 或任何中立会话。
   - `projectId !== null` 但对应项目已被删除的自动化任务，准入锁落在纯路径 `<profileDir>/workspace-automations/<automationId>`，且在 `executeRun` 调用模型或脚本前立即记 `MISSING_PROJECT_OUTPUT` 失败并返回释放锁——既不在兜底目录中执行命令或提示词，也**不在磁盘上创建 `<profileDir>/workspace-automations/<automationId>` 目录**。
4. **启动清扫与前端展示测试（`session-sweep.spec.ts` / `AutomationsView.spec.ts`，P1-1 & P2-5）**：
   - 当 `<profileDir>`（祖先目录）被登记为项目时，`sweepProjectLegacySessions` 仍保护 `<profileDir>/workspace`、`<profileDir>/workspace-sessions/*` 与 `<profileDir>/workspace-automations/*` 下的会话日志不被删除；同时正常清扫 `<profileDir>/workspace-projects/<projectId>` 下无 task 引用的游离会话。
   - 创建自动化后前端同步刷新 `projects` 与 `automations`，侧栏「项目」列表与自动化行徽标立即显示新项目。
