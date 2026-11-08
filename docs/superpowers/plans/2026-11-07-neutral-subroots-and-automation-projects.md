# 中立会话独立子根与自动化任务自动绑定项目 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task.

**Goal:** 为每个新建独立中立会话（`fresh: true`）派生与 `<profileDir>/workspace` 平级的独立可写根 `<profileDir>/workspace-sessions/<sessionId>`，并在新建自动化任务未选项目（`projectId: null`）时自动在 `<profileDir>/workspace-projects/<projectId>` 下创建同名项目并绑定（存量 `projectId: null` 自动化映射到 `<profileDir>/workspace-automations/<automationId>`），彻底消除 `<profileDir>/workspace` 的单写者并发瓶颈与父子目录单向沙箱越界问题。

**Architecture:** 保持 [`TurnScheduler`](../../../dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts) 的按根单写者互斥原语不变，将三类新增可写根（`workspace-sessions/*`、`workspace-projects/*`、`workspace-automations/*`）设计为 `<profileDir>/workspace` 的平级兄弟目录。[`writableRootForSession`](../../../dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts) 保持纯路径推导（零 `workspace-sessions` `mkdirSync` 副作用），仅在 [`sessionNew`](../../../dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts) 确认铸造独立中立会话时建目录；[`automationAdmissionRoot`](../../../dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts) 对无有效项目的自动化返回纯路径 `<profileDir>/workspace-automations/<automationId>`，仅在 `projectId === null` 真正执行前建目录，而已删项目在执行前早退记 `MISSING_PROJECT_OUTPUT` 且不留空目录。

**Tech Stack:** TypeScript, Node.js (`node:fs`, `node:path`, `node:crypto`), React 19, Vitest 4.

**关联规格与评审：**
- 设计规格：[`docs/superpowers/specs/2026-11-07-neutral-subroots-and-automation-projects-design.md`](../specs/2026-11-07-neutral-subroots-and-automation-projects-design.md)
- 规格评审：[`docs/superpowers/specs/2026-11-07-neutral-subroots-and-automation-projects-design-review.md`](../specs/2026-11-07-neutral-subroots-and-automation-projects-design-review.md)
- **实施就绪评审（本计划已按其结论修订）**：[`2026-11-07-neutral-subroots-and-automation-projects-implementation-review.md`](./2026-11-07-neutral-subroots-and-automation-projects-implementation-review.md)

**修订记录（2026-11-08，第二轮）：** 第一轮已补入 B1、B4、D5=E、D6=F、B3、T1–T7 与 E5，生产文件数为 **13**。第二轮按实施评审 §13 的 double-check 继续修正：合并既有导入、纠正 `ProjectInfo` 来源、统一 Vitest `expect`、改用真实自动化测试 helper、将回滚最后一步改为非递归 `rmdir` 并补失败补偿、补路由级 T4 与当前轮/下一轮 T6、补 chmod 平台条件和 UI 项目夹具，并修正残留与级联删除口径。评审真正撤回的只有 **§6 原第 4/7 条**；原第 6 条的测试改名仍是有效任务。T2 的「只测静态删除」错误前提与 D5 的 A/C 方案不得据以修改本计划。

---

## Global Constraints

- **实施边界**：所有源码与测试改动仅限 `dsh-plugin-huaanwork/`，严禁修改 `deepseek-harness/` 子模块，不修改 [`turn-scheduler.ts`](../../../dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts)。
- **分支约束**：在 `feat/huaanwork-neutral-subroots-and-automation-projects` 分支上实施，不在 `master` 上直接提交。每个任务只有用户明确要求 commit 时才执行 `git commit`。基线 = master `e3d62edf68`：前置的并发回合特性（21 个提交）已 fast-forward 合并并推送，本地 `corepack yarn check` 真实退出码 0，CI run `42440172283` 六个 job 全绿（含 desktop-windows 与 desktop-macos）。原分支 `feat/huaanwork-concurrent-project-turns` 已合并完毕并删除，不再是实施分支。
- **平级目录铁律（P1-1）**：`<profileDir>/workspace-sessions/<sessionId>`、`<profileDir>/workspace-projects/<projectId>`、`<profileDir>/workspace-automations/<automationId>` 必须与 `<profileDir>/workspace` 平级，绝不能作为 `<profileDir>/workspace` 的子目录。
- **推导无副作用铁律（P1-2）**：`writableRootForSession` 与 `automationAdmissionRoot` 绝不能为独立会话或未绑定自动化调用 `mkdirSync`；非法路径分量（含 `/`、`\`、`..`、`.` 或空串）直接抛错拒绝，绝不回落到 `<profileDir>/workspace`。
- **类型门禁铁律（B4）**：`dsh-plugin-huaanwork/tsconfig.json:22` 开了 `noUnusedLocals: true`，include 覆盖 `src/huaanwork-host/**/*.ts`。替换某个导入的唯一使用点时，**必须同时删掉旧导入**，否则 Task 8 的 `corepack yarn typecheck` 会以 TS6133 失败。
- **删除时序铁律（D5 = E）**：独立会话根的物理清理**保持在 `removeSession` 内立即执行**。**禁止**新增收尾观测机制、禁止新增 tombstone、禁止修改 `turn-scheduler.ts`、禁止改动客户端删除流程（`App.tsx:3239-3275` 的「先 cancel 再 remove」原样保留）、禁止新增启动补扫。`rm` 失败必须写日志且不抛出。
- **既有回归钉铁律（D5 = E）**：`tests/huaanwork-host/sessions.spec.ts` 的四条删除钉子 —— `:1521`（live agent + 等待中的 `request_input`）、`:2240`（仅排队会话被删后 drain 不得复活）、`:2563`（在途回合删除并清掉模型/根登记）、`:2869`（dequeue→followup 窗口内删除）—— **必须不改一字仍通过**。任何要求改写它们的方案都已被评审证伪，不得重新提出。
- **客户端测试形态铁律（D6 = F）**：`send()` 是 `App()` 内未导出的闭包，全仓没有渲染 `App` 的测试先例，**本计划不引入**。需要行为级验证的判定一律抽成 `src/client-huaanwork/logic/` 下的导出纯函数（不新建模块），行为测试落该模块的专属 spec，`appWiring.spec.ts` 只保留「App 确实调用了它」的接线钉。不得把接线层断言声称为渲染级验证。

---

## File Structure

| 文件 | 职责与改动概要 |
| --- | --- |
| `dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts` | 新增 `assertSafePathSegment`、`neutralSessionsBaseDir`、`neutralSessionRootPath`、`neutralSessionRoot`、`autoProjectRootPath`、`neutralAutomationsBaseDir`、`neutralAutomationRootPath`、`neutralAutomationRoot` |
| `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts` | 识别已铸造独立中立会话（`<profileDir>/workspace-sessions/<sessionId>`）、存量 `isInside(neutralRoot, headerCwd)` 中立会话（`<profileDir>/workspace`）与存量未绑定自动化运行会话（`<profileDir>/workspace-automations/<automationId>`）。workspace 被登记成项目时，已铸造目录优先于该项目（D3）。中立前缀的其余情况留在 workspace，不改判到其他项目（D4）。推导阶段不创建任何新子根目录 |
| `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts` | `sessionNew` 在 `fresh: true` 且基准 `cwd` 等于中立根时创建并返回 `<profileDir>/workspace-sessions/<sessionId>`；`removeSession` 校验 `sessionId` 并顺带清理对应的 `<profileDir>/workspace-sessions/<sessionId>`（**D5 = E**：立即删；`rm` 失败写日志不抛出；删除条件收窄为「安全分量 + 中立稳定前缀」的显式不变量） |
| `dsh-plugin-huaanwork/src/huaanwork-host/index.ts` | 启动清扫 `protectedRoots` 扩展为 `[neutralWorkspaceRoot, neutralSessionsBaseDir, neutralAutomationsBaseDir]` |
| `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts` | 为 `projects.json` 补齐 `withProjectRegistryLock`；`createProject` 支持可选 `id` 参数；新增导出纯函数 `autoProjectRollbackAction`（**B3**：判定自动建项目失败时该整体撤掉还是保留现场） |
| `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts` | `updateAutomation` 支持修改非空字符串 `projectId`；同步 `:74` 的「创建后不可改」注释 |
| `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts` | `automationAdmissionRoot` 返回纯路径 `neutralAutomationRootPath`；`executeRun` 在 `automation.projectId === null` 真正执行前调用 `neutralAutomationRoot` 建目录；导出 `hasInFlightAutomationRun`；**B4**：`:29` 的 `neutralWorkspaceRoot` 导入被替换为 `neutralAutomationRoot`/`neutralAutomationRootPath`，不得并存 |
| `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts` | `automation.create` 在 `projectId === null` 时预检 `MAX_AUTOMATIONS`、自动创建同名项目并绑定（**B3**：回滚覆盖 `mkdir → createProject → createAutomation` 整段，按 `autoProjectRollbackAction` 判定；保留现场时注册表条目与目录一并保留并写日志）；`automation.update` 校验目标项目存在且无在途运行 |
| `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx` | 创建表单默认项改为「自动创建同名项目（推荐）」；编辑态开放归属项目下拉框（运行中禁用）；删除 `:867` 的「仅创建模式可选,编辑不可改」过期注释 |
| `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx` | `AutomationsView` 的 `onChanged` 同步调用 `refreshProjects()`；**D6 = F**：`:2689-2691` 的空 catch 改为调用 `sessionMintFailureNote` + `noteActive` + `return`（`:2695-2698` 的既有守卫保留不动） |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts` | **D6 = F**：新增导出纯函数 `sessionMintFailureNote`（`session.new` 铸造失败时该显示哪一句）。落在此文件是因为它已是「发送/回合簿记」纯函数的归处，且 `App.tsx:174` 已从它导入 —— 不新建模块 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts` | **B1**：`AutomationPatch` 增加 `projectId?: string`（否则 Task 7 的对象字面量触发多余属性检查、typecheck 必红）；同步 `:21` 的「创建后不可改」过期注释 |
| `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts` | 删除 `:268-269` 的「归属在创建后不可改（update 白名单不含 projectId）」过期说明（纯注释；`AutomationInfo.projectId` 已是 `string \| null`，类型不动） |

---

### Task 1: 平级命名空间路径辅助与沙箱双向隔离单测

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts:39-50`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/sandbox-cwd.spec.ts`

**Step 1: Write the failing test**

在 `dsh-plugin-huaanwork/tests/huaanwork-guardrails/sandbox-cwd.spec.ts` 末尾追加平级目录双向沙箱夹紧与 `assertSafePathSegment` 校验测试：

```typescript
import {
  assertSafePathSegment,
  autoProjectRootPath,
  neutralAutomationRootPath,
  neutralSessionRootPath,
  neutralWorkspaceRootPath,
} from "../../src/huaanwork-host/workspace-state.ts";

test("assertSafePathSegment rejects empty, dot, and path-separator segments", () => {
  assert.equal(assertSafePathSegment("huaanwork-0123456789abcdef-12345678", "sessionId"), "huaanwork-0123456789abcdef-12345678");
  for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "../workspace", "a\0b"]) {
    assert.throws(() => assertSafePathSegment(bad, "sessionId"), /非法 sessionId/);
  }
});

test("sibling roots under profileDir are mutually isolated under pinnedCwd", () => {
  const profileDir = mkdtempSync(join(tmpdir(), "huaanwork-sibling-profile-"));
  try {
    const neutralRoot = neutralWorkspaceRootPath(profileDir);
    const sessionA = neutralSessionRootPath(profileDir, "huaanwork-aaaaaaaaaaaaaaaa-11111111");
    const sessionB = neutralSessionRootPath(profileDir, "huaanwork-aaaaaaaaaaaaaaaa-22222222");
    const autoProject = autoProjectRootPath(profileDir, "proj-1");
    const legacyAuto = neutralAutomationRootPath(profileDir, "auto-1");

    // 1. 默认会话 (allowedRoot = <profileDir>/workspace) 不能写进任何平级新根，全部夹回 neutralRoot
    for (const target of [
      sessionA,
      join(sessionA, "secret.txt"),
      autoProject,
      join(autoProject, "src", "index.ts"),
      legacyAuto,
    ]) {
      assert.equal(
        pinnedCwd({ huaanworkWorkspaceRoot: { current: neutralRoot } }, target, neutralRoot),
        neutralRoot,
      );
    }

    // 2. 两个独立中立会话互不包含，越界访问对方或默认根均被夹回自身根
    assert.equal(
      pinnedCwd({ huaanworkWorkspaceRoot: { current: neutralRoot } }, join(sessionB, "file.txt"), sessionA),
      sessionA,
    );
    assert.equal(
      pinnedCwd({ huaanworkWorkspaceRoot: { current: neutralRoot } }, join(neutralRoot, "file.txt"), sessionA),
      sessionA,
    );
    assert.equal(
      pinnedCwd({ huaanworkWorkspaceRoot: { current: neutralRoot } }, join(sessionA, "sub", "ok.txt"), sessionA),
      join(sessionA, "sub", "ok.txt"),
    );
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});
```

**Step 2: Run test to verify it fails**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/sandbox-cwd.spec.ts`
Expected: FAIL (`assertSafePathSegment` / `neutralSessionRootPath` not exported from `workspace-state.ts`).

**Step 3: Write minimal implementation**

在 `dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts` 的 `neutralWorkspaceRoot` 下方补充平级路径函数与路径分量安全校验：

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

/** 存量未绑定自动化根（确保目录存在，仅在 projectId === null 真正执行前调用）。 */
export function neutralAutomationRoot(profileDir: string, automationId: string): string {
  const root = neutralAutomationRootPath(profileDir, automationId)
  mkdirSync(root, { recursive: true })
  return root
}
```

**Step 4: Run test to verify it passes**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/sandbox-cwd.spec.ts`
Expected: PASS.

---

### Task 2: 无 `mkdirSync` 副作用的可写根推导（`writable-root.ts`）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts:1-80`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts`

**Step 1: Write the failing test**

在 `dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts` 中新增独立中立会话、存量中立会话兼容、无副作用推导与存量未绑定自动化运行会话测试。**先替换** 文件 `:12` 已有的单行 `workspace-state.ts` 导入为下面的合并导入，不要在测试末尾再追加第二个 `neutralWorkspaceRoot` 绑定：

```typescript
import {
  neutralAutomationRoot,
  neutralSessionRoot,
  neutralSessionRootPath,
  neutralSessionsBaseDir,
  neutralWorkspaceRoot,
} from '../../src/huaanwork-host/workspace-state.ts'

test('minted fresh neutral session resolves to its workspace-sessions sibling root without side effects on unknown ids', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-fresh-neutral-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const mintedId = freshSessionIdFor(neutral)
  const mintedRoot = resolve(neutralSessionRoot(profile, mintedId))

  // 1. 刚由 session.new 铸造（目录已存在，尚未落首条 headerCwd）⇒ 返回该独立子根
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: mintedId,
    projects: [],
    tasks: [],
  })).toBe(mintedRoot)

  // 2. 已落盘在独立根（或其子目录）上的会话 ⇒ 返回该独立子根（即使不靠 existsSync 分支）
  const persistedId = freshSessionIdFor(neutral)
  const persistedRoot = resolve(neutralSessionRootPath(profile, persistedId))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: persistedId,
    projects: [],
    tasks: [],
    headerCwd: join(persistedRoot, 'subdir'),
  })).toBe(persistedRoot)
  expect(existsSync(persistedRoot)).toBe(false)

  // 3. 未经 session.new 铸造的未知/伪造中立前缀 id ⇒ 回落 neutralRoot 且绝不创建 workspace-sessions 目录
  const unmintedId = `${sessionIdFor(neutral)}-deadbeef`
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: unmintedId,
    projects: [],
    tasks: [],
  })).toBe(neutral)
  expect(existsSync(neutralSessionRootPath(profile, unmintedId))).toBe(false)
})

test('legacy neutral sessions with headerCwd equal to or inside <profileDir>/workspace stay on <profileDir>/workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-legacy-neutral-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const legacyId = freshSessionIdFor(neutral)

  expect(writableRootForSession({
    profileDir: profile,
    sessionId: legacyId,
    projects: [],
    tasks: [],
    headerCwd: neutral,
  })).toBe(neutral)

  expect(writableRootForSession({
    profileDir: profile,
    sessionId: legacyId,
    projects: [],
    tasks: [],
    headerCwd: join(neutral, 'docs', 'notes'),
  })).toBe(neutral)
  expect(existsSync(neutralSessionsBaseDir(profile))).toBe(false)
})

test('legacy unbound automation session with headerCwd under workspace-automations resolves to its automation root', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-legacy-auto-root-'))
  dirs.push(profile)
  const autoRoot = resolve(neutralAutomationRoot(profile, 'auto-legacy-1'))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'huaanwork-auto-auto-legacy-1-run1',
    projects: [],
    tasks: [],
    headerCwd: autoRoot,
  })).toBe(autoRoot)
})

test('invalid path segment in sessionId with neutral prefix throws instead of falling back to neutral root', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-bad-seg-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const neutralStable = sessionIdFor(neutral)
  expect(() =>
    writableRootForSession({
      profileDir: profile,
      sessionId: `${neutralStable}-../escape`,
      projects: [],
      tasks: [],
    }),
  ).toThrow(/非法 sessionId/)
})

test('a project registered on the neutral workspace does not capture a minted fresh session', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-workspace-project-'))
  dirs.push(profile)
  const neutral = resolve(neutralWorkspaceRoot(profile))
  const mintedId = freshSessionIdFor(neutral)
  const mintedRoot = resolve(neutralSessionRoot(profile, mintedId))
  const projects = [{ id: 'workspace-as-project', root: neutral }]
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: mintedId,
    projects,
    tasks: [],
  })).toBe(mintedRoot)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: sessionIdFor(neutral),
    projects,
    tasks: [],
  })).toBe(neutral)
})
```

**Step 2: Run test to verify it fails**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/writable-root.spec.ts`
Expected: FAIL (`mintedId` currently returns `neutral` instead of `mintedRoot`).

**Step 3: Write minimal implementation**

修改 `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts`。保留已有的 `soleContainingProjectRoot` 与 `isInside`。文件顶部注释改成下面这一段，避免下次修改把 `existsSync` 当成多余读盘删掉：

```typescript
/**
 * 会话可写根推导(规格 §3.2.3)。projects / tasks / headerCwd 由调用方先载入再传入。
 * 这里不调 listProjects / listTasks / findSessionHeader，也不创建 workspace-sessions。
 * 中立前缀的已铸造会话会 existsSync + statSync 一次，用来确认目录已由 session.new 建好。
 * 删掉这次读取后，刚铸造、尚未写 header 的会话会掉回共享 workspace。
 *
 * 推导顺序(前一级命中即返回):
 * 1. 任务绑定。
 * 2. 项目稳定 id。例外:项目根解析后等于中立 workspace，且会话 id 以中立稳定 id 加 `-`
 *    开头，并且 workspace-sessions/<sessionId> 已存在或 headerCwd 在该目录内时，
 *    不返回这个项目。恰好等于 work-1 稳定 id 的会话仍返回 workspace。
 * 3. 中立稳定 id 与中立前缀。前缀会话只认 workspace 内的存量 cwd、已铸造的会话目录，
 *    以及「目录已存在且还没有 header」。其余情况返回 workspace，不再按 cwd 改判到其他项目。
 * 4. 非中立前缀时，header.cwd 位于且仅位于一个项目根内。
 * 5. 非中立前缀时，header.cwd 位于 workspace-automations/<automationId>。
 * 6. 中立根。只有中立根作为结果返回时才创建 <profile>/workspace。
 */
```

先将 `writable-root.ts:1-4` 的现有导入块**整体替换**为下面代码块顶部的四组导入（包括新增 `node:fs`），再替换 `writableRootForSession` 并追加 `containingAutomationRoot`；不得把新导入块追加在旧导入之后形成重复绑定：

```typescript
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { sessionIdFor } from './session-id.ts'
import {
  neutralAutomationRootPath,
  neutralAutomationsBaseDir,
  neutralSessionRootPath,
  neutralWorkspaceRoot,
  neutralWorkspaceRootPath,
} from './workspace-state.ts'

export function writableRootForSession(input: {
  profileDir: string
  sessionId: string
  projects: readonly { id: string; root: string }[]
  tasks: readonly { sessionId?: string; projectId: string }[]
  headerCwd?: string | undefined
}): string {
  const { profileDir, sessionId, projects, tasks, headerCwd } = input

  const boundTask = tasks.find((task) => task.sessionId === sessionId)
  if (boundTask) {
    const project = projects.find((item) => item.id === boundTask.projectId)
    if (project) return resolve(project.root)
  }

  const neutralRoot = resolve(neutralWorkspaceRootPath(profileDir))
  const neutralStable = sessionIdFor(neutralRoot)
  const neutralPrefixed = sessionId.startsWith(`${neutralStable}-`)
  // 非法分量在这里抛错，不回落到共享 workspace。合法 id 只是拼出路径，不建目录。
  const mintedRoot = neutralPrefixed
    ? resolve(neutralSessionRootPath(profileDir, sessionId))
    : undefined
  const mintedDirectoryReady = mintedRoot !== undefined
    && (
      (typeof headerCwd === 'string' && headerCwd.length > 0 && isInside(mintedRoot, headerCwd))
      || (existsSync(mintedRoot) && statSync(mintedRoot).isDirectory())
    )

  for (const project of projects) {
    const projectRoot = resolve(project.root)
    const stable = sessionIdFor(project.root)
    if (sessionId !== stable && !sessionId.startsWith(`${stable}-`)) continue
    // D3: workspace 被登记成项目时，已铸造的会话目录优先。work-1 的精确稳定 id 不带 `-` 后缀，不会进这个分支。
    if (projectRoot === neutralRoot && mintedDirectoryReady) continue
    return projectRoot
  }

  if (sessionId === neutralStable) {
    return resolve(neutralWorkspaceRoot(profileDir))
  }
  if (neutralPrefixed && mintedRoot !== undefined) {
    if (typeof headerCwd === 'string' && headerCwd.length > 0) {
      if (isInside(neutralRoot, headerCwd)) {
        return resolve(neutralWorkspaceRoot(profileDir))
      }
      if (isInside(mintedRoot, headerCwd)) {
        return mintedRoot
      }
    } else if (existsSync(mintedRoot) && statSync(mintedRoot).isDirectory()) {
      return mintedRoot
    }
    // D4: 中立前缀的其余情况留在 workspace，不落到下面的项目 cwd / 自动化目录识别。
    return resolve(neutralWorkspaceRoot(profileDir))
  }

  const cwdRoot = soleContainingProjectRoot(projects, headerCwd)
  if (cwdRoot !== undefined) return cwdRoot

  const autoRoot = containingAutomationRoot(profileDir, headerCwd)
  if (autoRoot !== undefined) return autoRoot

  return resolve(neutralWorkspaceRoot(profileDir))
}

function containingAutomationRoot(profileDir: string, headerCwd: string | undefined): string | undefined {
  if (typeof headerCwd !== 'string' || headerCwd.length === 0) return undefined
  const base = resolve(neutralAutomationsBaseDir(profileDir))
  const rel = relative(base, resolve(headerCwd))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const firstSegment = rel.split(sep)[0]
  if (!firstSegment) return undefined
  return resolve(neutralAutomationRootPath(profileDir, firstSegment))
}
```

上面的函数已经包含 D3 和 D4，与规格 §3.2.3 一致。不要把项目循环改回「前缀命中即返回」，也不要让中立前缀的其余情况落到 `soleContainingProjectRoot`。保留测试 `the neutral stable id stays neutral even when the logged cwd is inside a project`。

**Step 4: Run test to verify it passes**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/writable-root.spec.ts`
Expected: PASS.

---

### Task 3: 独立中立会话铸造、删除清理与启动清扫保护（`sessions.ts`, `index.ts`）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:598-611,1024-1042`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts:41,197-202`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts`（D6 = F：新增导出纯函数 `sessionMintFailureNote`）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:2689-2691`（D2 + D6 = F：空 catch 改为调用该函数 + `noteActive` + `return`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/session-sweep.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts`（D6 = F 行为层）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`（D2 + D6 = F 接线层）

**Interfaces:**
- Consumes: Task 1 的 `assertSafePathSegment(profileDir 无关, id, label)`、`neutralSessionRoot(profileDir, sessionId)`、`neutralSessionRootPath(profileDir, sessionId)`、`neutralSessionsBaseDir(profileDir)`、`neutralAutomationsBaseDir(profileDir)`、`neutralWorkspaceRootPath(profileDir)`。
- Produces: `sessionMintFailureNote(input: { error: unknown; tabProjectId: string | null | undefined }): string`（`logic/concurrentTurn.ts` 导出，`App.tsx` 的 `send()` catch 调用）。后续任务不依赖它，但 Task 8 的门禁会跑它的两层测试。

**Step 1: Write the failing tests**

1. 在 `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts:294-307` 更新 `session.new` 单测并新增独立中立会话并行发送、存量中立会话恢复与 `session.remove` 子目录清理测试：

```typescript
describe('session.new (旧 host.ts:988-992)', () => {
  test('mints stable root for default session and isolated workspace-sessions roots for fresh neutral sessions', () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const stable = sessionNew(routeCtx, {})
    expect(stable.sessionId).toBe(sessionIdFor(routeCtx.workspaceRoot.current))
    expect(stable.cwd).toBe(routeCtx.workspaceRoot.current)
    const freshA = sessionNew(routeCtx, { fresh: true })
    const freshB = sessionNew(routeCtx, { fresh: true })
    expect(freshA.sessionId).not.toBe(freshB.sessionId)
    expect(freshA.sessionId).toMatch(/^huaanwork-[0-9a-f]{16}-[0-9a-f]{8}$/)
    expect(freshA.cwd).toBe(join(routeCtx.profileDir, 'workspace-sessions', freshA.sessionId))
    expect(freshB.cwd).toBe(join(routeCtx.profileDir, 'workspace-sessions', freshB.sessionId))
    expect(existsSync(freshA.cwd)).toBe(true)
    expect(existsSync(freshB.cwd)).toBe(true)
  })
})
```

在 `describe('session.send 调度器接线')` 内追加。两个 fresh 会话的 `whenIdle` 必须先挂起，否则第一回合可能在第二次 `send` 之前释放，测不到并行：

```typescript
test('two fresh neutral sessions start together when the cap is at least 2', async () => {
  const root = freshTmp()
  const h = await makeHarness(root, { max: 2 })
  const freshA = sessionNew(h.routeCtx, { fresh: true })
  const freshB = sessionNew(h.routeCtx, { fresh: true })
  const idleA = makeDeferred()
  const idleB = makeDeferred()
  h.addAgent(freshA.sessionId, () => idleA.promise)
  h.addAgent(freshB.sessionId, () => idleB.promise)

  const sentA = await h.send({ text: 'a', sessionId: freshA.sessionId, tabId: 'tab-a', modelId: 'm1' })
  const sentB = await h.send({ text: 'b', sessionId: freshB.sessionId, tabId: 'tab-b', modelId: 'm1' })

  expect(sentA).toMatchObject({ started: true, waiting: false })
  expect(sentB).toMatchObject({ started: true, waiting: false })
  expect(h.followupsBySession.get(freshA.sessionId)).toEqual(['a'])
  expect(h.followupsBySession.get(freshB.sessionId)).toEqual(['b'])
  idleA.resolve()
  idleB.resolve()
})
```

在 `describe('session.resume ...')` 内追加。`writePersistedSession` 与 `fakeAgentsRegistry` 已在该文件：

```typescript
test('legacy neutral-prefix sessions whose cwd is the workspace or inside it still resume', async () => {
  const root = freshTmp()
  const routeCtx = makeRouteCtx(root)
  const workspace = resolve(neutralWorkspaceRoot(routeCtx.profileDir))
  const onRoot = freshSessionIdFor(workspace)
  const nested = freshSessionIdFor(workspace)
  writePersistedSession(routeCtx.dshHome, onRoot, workspace)
  writePersistedSession(routeCtx.dshHome, nested, join(workspace, 'sub'))
  const { ctx } = fakeAgentsRegistry()

  await expect(sessionResume(ctx, routeCtx, { sessionId: onRoot })).resolves.toEqual({ sessionId: onRoot, resumed: true })
  await expect(sessionResume(ctx, routeCtx, { sessionId: nested })).resolves.toEqual({ sessionId: nested, resumed: true })
})
```

在 `describe('session.open / session.remove ...')` 内追加：

```typescript
test('sessionRemove deletes the sibling directory of a fresh neutral session', async () => {
  const root = freshTmp()
  const routeCtx = makeRouteCtx(root)
  const fresh = sessionNew(routeCtx, { fresh: true })
  writePersistedSession(routeCtx.dshHome, fresh.sessionId, fresh.cwd)
  expect(existsSync(fresh.cwd)).toBe(true)

  await expect(sessionRemove(undefined, routeCtx, { sessionId: fresh.sessionId })).resolves.toEqual({ removed: true })

  expect(existsSync(fresh.cwd)).toBe(false)
})
```

2. 在 `dsh-plugin-huaanwork/tests/huaanwork-host/session-sweep.spec.ts` 的 `startup project legacy sweep` describe 内追加。会话日志用该文件已有的 `writeSessionLog`；祖先项目根是 `hostConfig(root)` 所用的临时 `root`（`profileDir` 实为 `<root>/profile`），这样三个平级目录都落在该祖先项目根的前缀里：

```typescript
test('protects sibling neutral namespaces and still sweeps an unreferenced auto-project session', async () => {
  const root = freshRoot()
  const config = hostConfig(root)
  const autoProject = join(config.profileDir, 'workspace-projects', 'p-auto')
  mkdirSync(autoProject, { recursive: true })
  writeJsonFile(join(config.profileDir, 'projects.json'), {
    projects: [
      { id: 'ancestor', name: 'Ancestor', root, createdAt: 1 },
      { id: 'p-auto', name: 'Auto', root: autoProject, createdAt: 2 },
    ],
  })
  const sessionsRoot = join(config.dshHome, 'sessions')
  const keptNeutral = writeSessionLog(sessionsRoot, 'neutral', 'huaanwork-aaaaaaaaaaaaaaaa', join(config.profileDir, 'workspace'))
  const keptSession = writeSessionLog(sessionsRoot, 'fresh', 'huaanwork-bbbbbbbbbbbbbbbb', join(config.profileDir, 'workspace-sessions', 's1'))
  const keptAutomation = writeSessionLog(sessionsRoot, 'legacy-auto', 'huaanwork-cccccccccccccccc', join(config.profileDir, 'workspace-automations', 'a1'))
  const swept = writeSessionLog(sessionsRoot, 'auto-project', 'huaanwork-dddddddddddddddd', autoProject)

  const booted = await bootHuaanworkHost(config)

  expect(existsSync(keptNeutral)).toBe(true)
  expect(existsSync(keptSession)).toBe(true)
  expect(existsSync(keptAutomation)).toBe(true)
  expect(existsSync(swept)).toBe(false)
  await booted.ctx.fiber.dispose()
})
```

3. D2 + D6 = F 接线层：在 `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts` 追加源码断言。该文件用 `functionBody` 切 `send()`，不渲染组件（全仓无渲染 `App` 的先例，本计划不引入）。**语义（显示哪一句）由第 4 项的行为层验证；这里只钉「catch 调用了抽出的函数」与「`return` 在 `session.send` 和 `setDraft("")` 之前」**：

```typescript
test("a neutral tab does not send when session.new fails", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  const mintAt = body.indexOf('"session.new"');
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  assert.ok(mintAt >= 0 && sendAt > mintAt);
  const between = body.slice(mintAt, sendAt);
  // 接线钉：catch 调用抽出的判定函数，随后 return。catch 内不再有分支。
  assert.match(
    between,
    /catch \(error\) \{\s*noteActive\(sessionMintFailureNote\(\{ error, tabProjectId: sendingTab\?\.projectId \}\)\);\s*return;\s*\}/,
  );
  // 不得退回改造前的空 catch。
  assert.doesNotMatch(between, /catch \{\s*sessionId = undefined;\s*\}/);
  // 草稿清空必须在这个 return 之后：否则「失败时草稿留存」不成立。
  assert.ok(
    between.indexOf("setDraft(") > between.indexOf("sessionMintFailureNote"),
    "setDraft must come after the mint-failure return",
  );
});
```

同时在 `appWiring.spec.ts` 的 `App.tsx` 导入检查处（该文件已有 `import * as AppModule from "../../src/client-huaanwork/App.tsx"` 与 `APP_SOURCE`）追加一条：`APP_SOURCE` 必须从 `./logic/concurrentTurn.ts` 导入 `sessionMintFailureNote`，防止调用点留着而导入被删。

4. D6 = F 行为层：在 `dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts` 的既有 import 列表里加入 `sessionMintFailureNote`，并追加用例。该文件用 `node:assert/strict`，不是 `expect`：

```typescript
test("session.new failure shows the real error on a neutral tab and the existing copy on a project tab", () => {
  // 中立标签（projectId 为 null 或缺失）：目录建不出来这件事必须可见，显示真实错误。
  assert.equal(
    sessionMintFailureNote({ error: new Error("ENOSPC: no space left on device"), tabProjectId: null }),
    "ENOSPC: no space left on device",
  );
  assert.equal(sessionMintFailureNote({ error: new Error("EACCES"), tabProjectId: undefined }), "EACCES");
  // 非 Error 值也要可见，不得变成空串或 [object Object]。
  assert.equal(sessionMintFailureNote({ error: "磁盘已满", tabProjectId: null }), "磁盘已满");

  // 项目标签：与 App.tsx:2695-2698 既有守卫同一句，避免同一种失败出现两种措辞。
  assert.equal(
    sessionMintFailureNote({ error: new Error("EACCES"), tabProjectId: "p1" }),
    "子任务会话尚未就绪，消息未发送。请重试。",
  );
});
```

5. T2（D5 = E 的两条新钉子）：在 `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts` 的 `describe('session.remove lifecycle')` 内追加。需要给该文件第 1 行的 `node:fs` 导入补 `chmodSync`，给第 51 行的 `workspace-state.ts` 导入补 `neutralSessionsBaseDir`：

```typescript
test('sessionRemove only ever touches the minted sibling root, never the shared workspace or a project root', async () => {
  const root = freshTmp()
  const routeCtx = makeRouteCtx(root)
  const workspace = resolve(neutralWorkspaceRoot(routeCtx.profileDir))
  const projectRoot = join(root, 'project-a')
  mkdirSync(projectRoot, { recursive: true })
  // 存量中立前缀会话：cwd 是共享 workspace，本身没有兄弟根。
  const legacyId = `${sessionIdFor(workspace)}-legacy01`
  writePersistedSession(routeCtx.dshHome, legacyId, workspace)
  // 项目会话：id 与中立前缀无关。
  writePersistedSession(routeCtx.dshHome, 'project-session-1', projectRoot)
  // 两个根里各放一个文件：任何越界递归删除都会留下痕迹。
  writeFileSync(join(workspace, 'keep.txt'), 'neutral', 'utf8')
  writeFileSync(join(projectRoot, 'keep.txt'), 'project', 'utf8')

  await expect(sessionRemove(undefined, routeCtx, { sessionId: legacyId })).resolves.toEqual({ removed: true })
  await expect(sessionRemove(undefined, routeCtx, { sessionId: 'project-session-1' })).resolves.toEqual({ removed: true })

  expect(existsSync(join(workspace, 'keep.txt'))).toBe(true)
  expect(existsSync(join(projectRoot, 'keep.txt'))).toBe(true)
  // 连兄弟根的父容器都不该被创建出来。
  expect(existsSync(neutralSessionsBaseDir(routeCtx.profileDir))).toBe(false)
})

test.skipIf(process.platform === 'win32')('sessionRemove logs and still reports removed when the sibling root cannot be deleted', async () => {
  const root = freshTmp()
  const routeCtx = makeRouteCtx(root)
  const fresh = sessionNew(routeCtx, { fresh: true })
  writePersistedSession(routeCtx.dshHome, fresh.sessionId, fresh.cwd)
  const logs: string[] = []
  const loggingCtx: RouteContext = { ...routeCtx, logger: (message: string) => { logs.push(message) } }
  // POSIX mode bits 才可制造这次失败；Windows 与既有先例一致显式 skip（automations-store.spec.ts:1107/:1131）。
  // 父目录只读 ⇒ 非 root POSIX 用户删不掉里面的会话根；root 运行不属于本用例的验证环境。
  const base = neutralSessionsBaseDir(routeCtx.profileDir)
  chmodSync(base, 0o555)
  try {
    // 日志已经删掉、删除照样报成功；rm 失败只记日志，不抛给调用方。
    await expect(sessionRemove(undefined, loggingCtx, { sessionId: fresh.sessionId })).resolves.toEqual({ removed: true })
    expect(logs.some((line) => line.includes(fresh.sessionId))).toBe(true)
  } finally {
    chmodSync(base, 0o755)
  }
})
```

**这两条是 D5 = E 的全部新增测试面。** 评审明确不要求「活跃回合完整收尾后才删根」的用例——那是被证伪的 A/C 方案的验收条。相反，下面四条**既有**钉子必须不改一字仍通过，它们才是本任务真正的回归门：

- `sessions.spec.ts:1521` `releases a waiting request_input, cancels the live agent, and forgets the session`
- `sessions.spec.ts:2240` `session.remove cancels the removed session’s queued items so a drain cannot resurrect it`
- `sessions.spec.ts:2563` `the send records the session model and writable root until removal`
- `sessions.spec.ts:2869` `session.remove during the dequeue→followup window stops a persisted session’s text`

**Step 2: Run tests to verify they fail**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/session-sweep.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/concurrentTurn.spec.ts`
Expected: FAIL —— `freshA.cwd` 仍等于 `routeCtx.workspaceRoot.current`；`sessionRemove` 不删兄弟根；`workspace-sessions` 不在 `protectedRoots`；`send()` 仍是空 `catch { sessionId = undefined }`；`sessionMintFailureNote` 未从 `logic/concurrentTurn.ts` 导出（行为层用例报导入错误）。

**此时上面列出的四条既有钉子必须仍然通过**——它们在本步骤就应该绿；如果其中任何一条在实现前就红了，说明夹具被改动了，先修回来再继续。

**Step 3: Write minimal implementation**

1. 在 `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts` 中：
   - 从 `node:fs/promises` 增加导入 `rm`，从 `./workspace-state.ts` 导入 `assertSafePathSegment`、`neutralSessionRoot`、`neutralSessionRootPath`、`neutralWorkspaceRootPath`。
   - 修改 `removeSession` 与 `sessionRemove`（`:598-611`、`:1024-1030`）。当前 `removeSession` 只有 3 个参数；**新增**选项对象作为第 4 参，因为 **D5 = E 要求 `rm` 失败写日志**，需要把 `logger` 传进来：
     ```typescript
     async function removeSession(
       ctx: SessionRuntimeContext | undefined,
       sessionsRoot: string,
       params: unknown,
       opts: { profileDir?: string; logger?: (message: string) => void } = {},
     ): Promise<{ removed: true }> {
       const rawSessionId = objectString(params, 'sessionId')
       if (!rawSessionId) throw new Error('session.remove requires params.sessionId')
       const sessionId = assertSafePathSegment(rawSessionId, 'sessionId')
       const located = await locateSessionFile(sessionsRoot, sessionId)
       if (!located) throw new Error(`session ${sessionId} was not found`)
       releaseSessionRuntime(ctx, sessionId)
       await unlink(located.file)
       // D5 = E 不变量:只有「通过 assertSafePathSegment **且** 带中立稳定前缀」的会话
       // 才有专属兄弟根可删。放宽其中任何一个条件,都会把共享 workspace 或某个项目根
       // 变成递归删除的目标(负例见 sessions.spec.ts 的
       // `sessionRemove only ever touches the minted sibling root …`)。
       const { profileDir, logger } = opts
       if (profileDir) {
         const neutralStable = sessionIdFor(resolve(neutralWorkspaceRootPath(profileDir)))
         if (sessionId.startsWith(`${neutralStable}-`)) {
           const siblingRoot = neutralSessionRootPath(profileDir, sessionId)
           // 立即删,不等回合/子代理收尾(D5 = E)。失败只记日志不抛出:会话日志已经删掉,
           // 把删除报告成失败会让界面停在一个已经不存在的会话上。
           await rm(siblingRoot, { recursive: true, force: true }).catch((error: unknown) => {
             logger?.(
               `session.remove: 未能删除独立会话根 ${siblingRoot}: ${error instanceof Error ? error.message : String(error)}`,
             )
           })
         }
       }
       return { removed: true }
     }
     ```
     并在 `sessionRemove` 中传入 `profileDir` 与 `logger`：
     ```typescript
     export async function sessionRemove(
       ctx: SessionRuntimeContext | undefined,
       routeCtx: RouteContext,
       params: unknown,
     ): Promise<{ removed: true }> {
       return removeSession(ctx, join(routeCtx.dshHome, 'sessions'), params, {
         profileDir: routeCtx.profileDir,
         logger: routeCtx.logger,
       })
     }
     ```

   **D5 = E 的诚实口径（必须原样写进代码注释或本计划，不得美化）：** 删除一个仍有在途回合的独立会话时，物理目录在写者仍活跃时被删掉，该轮剩余的工具写可能因 ENOENT 失败；子代理收尾期间可能重建部分目录。启动清扫**不会**回收这类残留（清扫只遍历已登记项目根，且 `workspace-sessions` 被列进 `protectedRoots`）。爆炸半径限于该会话**自己**的兄弟根：设计 §3.1 的双向夹紧保证它写不进共享 `workspace`、其他独立会话、任何项目根或自动化目录，反之亦然，因此受损的只有用户刚刚亲手删掉的那一轮。**不得**声称「删除会等收尾完成」，也**不得**声称「不会留下任何残留」。
   - 修改 `sessionNew`（`:1032-1042`）：
     ```typescript
     export function sessionNew(routeCtx: RouteContext, params: unknown): { sessionId: string; cwd: string } {
       const requested = objectString(params, 'cwd')
       const cwd = requested !== undefined && isAbsolute(requested) && existsSync(requested) && statSync(requested).isDirectory()
         ? resolve(requested)
         : resolve(routeCtx.workspaceRoot.current)
       const fresh = objectBool(params, 'fresh')
       const sessionId = fresh ? freshSessionIdFor(cwd) : sessionIdFor(cwd)
       const neutralRoot = resolve(neutralWorkspaceRootPath(routeCtx.profileDir))
       if (fresh && cwd === neutralRoot) {
         const sessionCwd = resolve(neutralSessionRoot(routeCtx.profileDir, sessionId))
         return { sessionId, cwd: sessionCwd }
       }
       return { sessionId, cwd }
     }
     ```

2. 在 `dsh-plugin-huaanwork/src/huaanwork-host/index.ts` 中：
   - 从 `./workspace-state.ts` 导入 `neutralAutomationsBaseDir`、`neutralSessionsBaseDir`；
   - 将 `sweepProjectLegacySessionsOncePerProcess` 的第 4 参数更新为：
     ```typescript
     [
       neutralWorkspaceRoot(config.profileDir),
       neutralSessionsBaseDir(config.profileDir),
       neutralAutomationsBaseDir(config.profileDir),
     ]
     ```

3. D6 = F：在 `dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts` 末尾新增导出纯函数。放在这个文件是因为它已是「发送/回合簿记」纯函数的归处，且 `App.tsx:174` 已经从它导入 —— **不新建模块**（Global Constraints 与 Scope record 都要求这一点）：

```typescript
/**
 * `session.new` 铸造失败时给用户看哪一句。两种归属都不发送(设计 D2):
 * 中立标签显示真实错误——目录建不出来这件事必须可见;项目标签沿用
 * `App.tsx` 既有守卫那一句,避免同一种失败出现两种措辞。
 * 只做判定,不做副作用:调用方负责 noteActive 与 return。
 */
export function sessionMintFailureNote(input: {
  error: unknown;
  tabProjectId: string | null | undefined;
}): string {
  if (input.tabProjectId != null) return "子任务会话尚未就绪，消息未发送。请重试。";
  return input.error instanceof Error ? input.error.message : String(input.error);
}
```

4. D2 + D6 = F：把 `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:2689-2691` 的空 `catch` 换成下面这一段，并在 `:174` 那条 `./logic/concurrentTurn.ts` 的既有 import 里加入 `sessionMintFailureNote`。`return` 位于外层 `try` 内，已有的 `finally` 仍会 `sendingRef.current.delete(chatId)`；`setDraft("")`（`:2718`）和用户消息插入都在这个 `return` 之后，所以草稿留下、`session.send` 不会被调用：

```tsx
        } catch (error) {
          noteActive(sessionMintFailureNote({ error, tabProjectId: sendingTab?.projectId }));
          return;
        }
```

**这一版比原计划的分支写法更简单，且对项目标签行为等价**：原写法是 `sessionId = undefined` 后落到 `:2695-2698` 的既有守卫、显示同一句「子任务会话尚未就绪，消息未发送。请重试。」；新写法在 catch 内直接显示同一句并 `return`。**`:2695-2698` 的守卫必须保留不动** —— 它还负责「铸造成功但应答没带 `sessionId`」这条不抛错的路径。

**Step 4: Run tests to verify they pass**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/session-sweep.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/concurrentTurn.spec.ts`
Expected: PASS —— 含 Step 1 列出的四条既有删除钉子（`:1521`/`:2240`/`:2563`/`:2869`）**不改一字**仍绿。若其中任何一条变红，说明实现偏离了 D5 = E（多半是误加了「在途则拒删」一类守卫），按 Global Constraints 的「既有回归钉铁律」修回，不要改测试。

---

### Task 4: 项目注册表并发写锁与 `updateAutomation` 支持改绑 `projectId`（`stores.ts`, `automations-store.ts`）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts:27-112`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:72-76,302-349`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`

**Interfaces:**
- Produces（Task 6 依赖，签名必须逐字一致）：
  - `createProject(storageRoot: string, params: { id?: string; name?: string; root: string }): Promise<ProjectInfo>`
  - `autoProjectRollbackAction(input: { dirEntries: readonly string[] | undefined; referencedByAutomations: boolean }): 'remove' | 'keep'`
  - `withProjectRegistryLock<T>(fn: () => Promise<T>): Promise<T>`
- Consumes: Task 1 的 `assertSafePathSegment(id, label)`。

**Step 1: Write the failing tests**

1. 在 `dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts` 新增用例：
   - 并发调用 `createProject`（含显式传入 `id`）与 `renameProject` 不会因读写交错丢失条目；
   - `createProject(storageRoot, { id: 'custom-id', name: 'P', root })` 使用传入的 `id`。同一个 `id` 再创建一次必须抛错，注册表里仍然只有一条。
   - **B3 的回滚判定**（纯函数，直接单测；这样 Task 6 的回滚不需要 mock 缝就能被覆盖）：

```typescript
test('autoProjectRollbackAction only removes a directory this request created and nobody reused', () => {
  // 沿用本文件既有 Vitest expect，不新增 node:assert 导入。
  expect(autoProjectRollbackAction({ dirEntries: [], referencedByAutomations: false })).toBe('remove')
  // 目录里已经有东西 ⇒ 保留现场（注册表条目一并保留，见 Task 6）。
  expect(autoProjectRollbackAction({ dirEntries: ['notes.md'], referencedByAutomations: false })).toBe('keep')
  // 已被别的自动化绑定 ⇒ 保留现场，否则会把别人的归属抽掉。
  expect(autoProjectRollbackAction({ dirEntries: [], referencedByAutomations: true })).toBe('keep')
  // 目录读不到（undefined）⇒ 无法证明为空 ⇒ 保留现场，不得递归抢删。
  expect(autoProjectRollbackAction({ dirEntries: undefined, referencedByAutomations: false })).toBe('keep')
})
```
2. 在 `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts` 新增用例，并改写既有测试 `issue #2: updateAutomation ignores projectId — binding is immutable after creation`：
   - 该测试目前断言 `{ projectId: 'p2' }` 被忽略、结果仍为 `'p1'`，`{ projectId: 'p1' }` 也不能把 `null` 绑上。实现按本任务写入非空 `projectId` 后，这条断言会失败，Task 4 的 PASS 不成立。
   - 改写后的期望：`updateAutomation(home, automation.id, { projectId: 'p2' })` 将 `automation.projectId` 更新为 `'p2'`；`null`、空串或非字符串不会把已有 `projectId` 清为 `null`。

**Step 2: Run tests to verify they fail**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/stores.spec.ts tests/huaanwork-host/automations-store.spec.ts`
Expected: FAIL (`updateAutomation` ignores `projectId`, `createProject` ignores custom `id`).

**Step 3: Write minimal implementation**

1. 在 `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts` 中：
   - 导入 `assertSafePathSegment`（来自 `./workspace-state.ts`）；
   - 新增 `withProjectRegistryLock`：
     ```typescript
     let projectRegistryLock: Promise<unknown> = Promise.resolve()

     export function withProjectRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
       const run = projectRegistryLock.then(fn)
       projectRegistryLock = run.catch(() => undefined)
       return run
     }
     ```
   - 将 `createProject`、`renameProject`、`removeProject`、`touchProject` 包裹进 `withProjectRegistryLock`，并在 `createProject` 中支持可选 `id?: string`：
     ```typescript
     export async function createProject(
       storageRoot: string,
       params: { id?: string; name?: string; root: string },
     ): Promise<ProjectInfo> {
       return withProjectRegistryLock(async () => {
         const root = typeof params.root === 'string' ? params.root.trim() : ''
         if (!root) throw new Error('project.create requires params.root')
         const info = await stat(root).catch(() => undefined)
         if (!info?.isDirectory()) throw new Error(`project.create requires an existing directory: ${root}`)

         const registry = await readProjectRegistry(storageRoot)
         if (registry.projects.some((project) => project.root === root)) {
           throw new Error(`该目录已是项目：${registry.projects.find((project) => project.root === root)?.name ?? root}`)
         }

         const id = typeof params.id === 'string' && params.id.trim()
           ? assertSafePathSegment(params.id, 'projectId')
           : randomUUID()
         if (registry.projects.some((project) => project.id === id)) {
           throw new Error(`project ${id} already exists`)
         }
         const name = (typeof params.name === 'string' ? params.name.trim() : '') || basename(root) || root
         const project: ProjectInfo = { id, name, root, createdAt: Date.now() }
         registry.projects.push(project)
         await writeProjectRegistry(storageRoot, registry)
         return project
       })
     }
     ```
   - **B3**：新增导出纯函数 `autoProjectRollbackAction`。抽成纯函数是为了让 Task 6 的回滚分支**不需要 mock 缝**就能被单测覆盖（与 D6 = F 同一套做法：判定抽出来，副作用留在调用方）：
     ```typescript
     /**
      * 自动建项目失败时该整体撤掉还是保留现场(B3)。
      * 只有「本次创建、仍为空、仍无引用」三条同时成立才可以撤:
      * - `dirEntries === undefined` 表示目录读不到,无法证明为空 ⇒ 保留;
      * - 目录非空 ⇒ 里面可能已经是别人的产物 ⇒ 保留;
      * - 已被别的自动化绑定 ⇒ 撤掉注册表条目会抽掉别人的归属 ⇒ 保留。
      * 保留现场时调用方必须**连注册表条目一起保留**并写日志,不得只留目录。
      */
     export function autoProjectRollbackAction(input: {
       dirEntries: readonly string[] | undefined
       referencedByAutomations: boolean
     }): 'remove' | 'keep' {
       if (input.dirEntries === undefined) return 'keep'
       if (input.dirEntries.length > 0) return 'keep'
       return input.referencedByAutomations ? 'keep' : 'remove'
     }
     ```

2. 在 `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts` 的 `updateAutomation` 中（`:314` 附近）增加：
   ```typescript
   if (typeof patch.projectId === 'string' && patch.projectId.trim()) {
     next.projectId = patch.projectId.trim()
   }
   ```
   同时把 `AutomationInput.projectId` 上「创建后不可改」的注释（`automations-store.ts:74`）改成：更新路由可以把 `projectId` 改成非空且已存在的项目 id，不能改回 `null`。

**Step 4: Run tests to verify they pass**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/stores.spec.ts tests/huaanwork-host/automations-store.spec.ts`
Expected: PASS.

---

### Task 5: 存量未绑定自动化与已删项目的准入根分离及按需建目录（`automations-host.ts`）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:29,195-201,600-626,674`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts:288-294,865-901`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/automation-scheduler.spec.ts:248-251,501`

**Interfaces:**
- Consumes: Task 1 的 `neutralAutomationRoot(profileDir, automationId)`（建目录）与 `neutralAutomationRootPath(profileDir, automationId)`（纯路径）。
- Produces（Task 6 依赖）：`hasInFlightAutomationRun(automationId: string): boolean`。

**Step 1: Write the failing test**

在 `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts` 中：
0. 先补测试导入：在 `automations-host.ts` 的既有导入块加入 `automationAdmissionRoot`；在 `workspace-state.ts` 导入中保留 `neutralWorkspaceRoot` 并新增 `neutralAutomationRootPath`；在 `node:path` 导入中新增 `dirname`。`automation-scheduler.spec.ts:17-23` 的 `automations-host.ts` 导入块同样加入 `automationAdmissionRoot`。这些符号分别被下面的 helper 与断言使用，不留未使用导入。
1. 将测试辅助函数 `admissionRoot`（`:288-294`）改为调用 `automationAdmissionRoot(h.routeCtx, automation)`；在 `automation-scheduler.spec.ts:248-251` 的 `admitAndEnqueue` 中同样改为调用 `automationAdmissionRoot(h.routeCtx, automation)`。
2. 更新 `automations-host.spec.ts:872-901` 的 `'unbound agent runs on the neutral root and a vanished project still queues a failed run'`：
   - 存量 `projectId: null` 的 `script` 运行时 `process.cwd()` 断言为 `await realpath(neutralAutomationRootPath(h.profileDir, script.id))`（位于 `<profileDir>/workspace-automations/<script.id>`，不再占用 `h.neutral`）；
   - 已删项目的 `ghost` 任务运行失败记 `MISSING_PROJECT_OUTPUT`，且断言 `expect(existsSync(neutralAutomationRootPath(h.profileDir, ghost.id))).toBe(false)`（准入阶段不建空目录）；
   - 新增断言：当前台默认会话 `work-1` 正在占用 `<profileDir>/workspace` 时，存量 `projectId: null` 的自动化任务仍可立即准入并执行完成（不被 `root-busy` 阻塞）。
3. **T5：建目录失败必须进入现有失败收口。** 成功路径覆盖不到这条分支，用同路径的**文件**冲突制造真实的 `mkdirSync` 错误（`neutralAutomationRoot` 对已存在的同名文件会抛 `EEXIST`/`ENOTDIR`），断言运行被记成失败、`lastStatus` 不留在 `running`、准入被释放：

```typescript
test('an unbound automation whose root path is blocked by a file fails the run and releases admission', async () => {
  const h = makeHarness()
  const script = await scriptTask(h.profileDir, 'echo never', { name: '被文件挡住' })
  expect(script.projectId).toBeNull()
  // 在 <profileDir>/workspace-automations/<id> 上先放一个同名文件：
  // neutralAutomationRoot 的 mkdirSync(recursive) 对它必抛。
  const blocked = neutralAutomationRootPath(h.profileDir, script.id)
  mkdirSync(dirname(blocked), { recursive: true })
  writeFileSync(blocked, 'not a directory', 'utf8')

  // startAutomation 先真实准入，再返回可等待执行完成的 done；本文件没有 runOnce。
  const { root, done } = await startAutomation(h, script)
  await done

  const [run] = await recentRuns(h.profileDir, script.id)
  expect(run?.ok).toBe(false)
  expect(run?.output).toContain('EEXIST')
  expect((await listAutomations(h.profileDir)).find((item) => item.id === script.id)?.lastStatus).not.toBe('running')
  // 准入已释放：同一根可以再次准入。
  // 注意不能用 activeTurnCount() 证明释放——脚本不计入 cap
  // （turn-scheduler.ts:72 `countsTowardCap = kind !== 'script-automation'`，
  //   :135 只在 countsTowardCap 时 +1，:206-208 返回 activeTurns），
  // 本用例全程 activeTurns 恒为 0，那条断言无论释放与否都会通过。
  // 直接探测 rootWriters：用 startAutomation 返回的同一个 root 键。
  const probe = h.scheduler.admitAutomation({
    automationId: script.id,
    sessionId: 'probe-after-failure',
    root,
    runId: 'probe-after-failure',
    countsTowardCap: false,
    recordSkip: false,
  })
  expect(probe).toEqual({ kind: 'start', root })
  h.scheduler.release('probe-after-failure')
})
```

> 夹具签名以现有源码为准：`scriptTask(profileDir, command, patch)` 的命令是第 2 个字符串参数；`startAutomation(h, task)` 返回 `{ runId, root, done }`，等待 `done` 即覆盖真实执行与收口。不要新增 `runOnce` 或生产注入缝。`dirname` 需从 `node:path` 导入，`mkdirSync`/`writeFileSync` 该文件已导入。

**Step 2: Run test to verify it fails**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automation-scheduler.spec.ts`
Expected: FAIL (`automationAdmissionRoot` still returns `neutralWorkspaceRoot(routeCtx.profileDir)`).

**Step 3: Write minimal implementation**

在 `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts` 中：
1. **B4（必须替换，不是新增）**：`:29` 现在是 `import { neutralWorkspaceRoot } from './workspace-state.ts'`，而 `neutralWorkspaceRoot` 的**唯一**使用点是 `:200`（`automationAdmissionRoot` 的返回语句），下面第 2 步会把它换掉。因此把 `:29` 整行**替换**为：
   ```typescript
   import { neutralAutomationRoot, neutralAutomationRootPath } from './workspace-state.ts'
   ```
   `dsh-plugin-huaanwork/tsconfig.json:22` 开了 `noUnusedLocals: true`，include 覆盖 `src/huaanwork-host/**/*.ts`；若旧导入与新导入并存，Task 8 的 `corepack yarn typecheck` 会以 TS6133 失败。本任务结束时执行 `grep -n neutralWorkspaceRoot dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`，**必须零命中**。
2. 修改 `automationAdmissionRoot`（`:195-201`）为纯路径返回（不调用 `mkdirSync`）：
   ```typescript
   export async function automationAdmissionRoot(routeCtx: RouteContext, automation: AutomationInfo): Promise<string> {
     if (automation.projectId) {
       const project = (await listProjects(routeCtx.profileDir)).find((item) => item.id === automation.projectId)
       if (project) return pathResolve(project.root)
     }
     return pathResolve(neutralAutomationRootPath(routeCtx.profileDir, automation.id))
   }
   ```
3. 在 `executeRun` 中，为 `automation.projectId === null` 的存量任务按需建目录。这一调用必须放在包住 `runAgentTurn` / `runScript` 的内层 `try` 里面（`automations-host.ts:604` 起），不能放在 `markAutomation` 已把 `lastStatus` 写成 `running`（`:576`）之后、内层 `try` 之前。建目录抛错时走现有 catch，随后 `finishAutomation` 把这次运行记成失败并释放准入。已删除项目的早退仍在建目录之前返回，不创建空目录：
   ```typescript
   if (!automation.projectId) {
     neutralAutomationRoot(routeCtx.profileDir, automation.id)
   }
   ```
4. 新增并导出 `hasInFlightAutomationRun`（供 Task 6 的 `automation.update` 改绑守卫调用）：
   ```typescript
   export function hasInFlightAutomationRun(automationId: string): boolean {
     return inFlightRunsOf(automationId).length > 0
   }
   ```

**Step 4: Run test to verify it passes**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automation-scheduler.spec.ts`
Expected: PASS.

随后：
- `grep -n neutralWorkspaceRoot dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts` ⇒ **零命中**（B4 验收）。
- 把 `automation-scheduler.spec.ts:501` 的测试名 `'neutral tasks run when the current root is the neutral root'` 改成 `'unbound tasks run in their own workspace-automations root, not the neutral root'`。本任务之后未绑定自动化的根不再是中立根，旧名字会误导下一次读测试的人。（实施评审 §6 第 6 条；注意该行号是**测试名所在行**，不是测试体。）

---

### Task 6: `automation.create` 自动建同名项目与 `automation.update` 在途改绑守卫（`routes.ts`）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:100-115,1132-1168`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts:625-700`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`（T6：已准入轮次冻结旧根，下一次准入/运行用新根）

**Interfaces:**
- Consumes: Task 1 的 `autoProjectRootPath(profileDir, projectId)`；Task 4 的 `createProject(storageRoot, { id?, name?, root })`、`autoProjectRollbackAction({ dirEntries, referencedByAutomations })`；Task 5 的 `hasInFlightAutomationRun(automationId)`、`automationAdmissionRoot(routeCtx, automation)`。
- Produces: 无（本任务是路由层终点）。

**Step 1: Write the failing test**

**先补夹具与导入（否则下面的用例编译不过）：**

- `automations-store.spec.ts`：保留 `:612-627` 的原有内联 `ctx`（它仍用 `releasedSessions` 验证 remove），不要搬改那条用例。另加下面这个最小 helper 供自动建项目与回滚用例共用；`logs` 让 keep/补偿分支能断言日志：
  ```typescript
  function makeCtx(home: string, logs: string[] = []) {
    return {
      dshHome: home,
      profileDir: home,
      workspaceRoot: { current: home },
      emit: () => {},
      logger: (message: string) => { logs.push(message) },
      requestRestart: async () => false,
      runtimeCtx: { agents: { get: (_id: string) => undefined } },
    }
  }
  ```
  既有 import 补差集：类型 `ProjectInfo` 加入 `../../src/client-huaanwork/rpc-types.ts` 的类型导入；从 `../../src/huaanwork-host/stores.ts` 加 `createProject`、`listProjects`、`withAutomationRegistryLock`、`writeAutomationRegistry`；从 `../../src/huaanwork-host/workspace-state.ts` 加 `autoProjectRootPath`。`chmodSync`、`mkdirSync`、`rmSync`、`writeFileSync`、`readdirSync`、`existsSync`、`join`、`vi` 已导入。
- `automations-host.spec.ts`：T6 直接复用文件已有的 `makeHarness`、`scriptTask`、`startAutomation`、`holdCommand`、`poll`、`waitRunEnd`、`nodeEval`、`dirs` 与 `h.releaseFiles`。`automationAdmissionRoot`、`neutralAutomationRootPath` 与 `dirname` 已在 Task 5 Step 1.0 补入，本任务不得重复导入；`createProject`、`listProjects`、`recentRuns`、`updateAutomation`、`realpath`、`existsSync`、`mkdirSync`、`mkdtempSync`、`tmpdir`、`join` 均已导入。路径归一化直接用既有 `resolve`，不要再加 `pathResolve` 别名。`scriptTask` 的第 2 参必须是命令字符串；不要写 `runOnce`、`makeProject` 或 `h.root`。

在 `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts` 中：
1. 更新 `CRUD routes return automation / removed`（`:643-655`）：
   - `create!.handler` 不传 `projectId`（即 `projectId: null`）时，断言 `automation.projectId` 为非空字符串，且 `await listProjects(home)` 中存在 `id === automation.projectId`、`name === '每日早报'`、`root === autoProjectRootPath(home, automation.projectId)` 的项目，磁盘目录 `existsSync(project.root)` 为 `true`。
   - 调用 `remove!.handler` 删除该自动化后，断言 `await listProjects(home)` 仍保留该项目。
2. 新增测试 `automation.create pre-checks MAX_AUTOMATIONS and automation.update guards projectId rebinding`：
   - 当自动化数量已达 `MAX_AUTOMATIONS`（50 条）时，调用 `automation.create`（`projectId: null`）抛上限错误，且 `await listProjects(home)` 为空、`<profileDir>/workspace-projects` 下无残留目录；
   - 调用 `automation.update` 将 `projectId` 改绑到已存在项目 `p2` 成功；改绑到不存在项目 `'missing'` 抛 `was not found`；
   - 当 `startInFlightRun` 登记了该自动化的在途运行时，调用 `automation.update` 修改 `projectId` 抛 `/正在运行/`，而不修改 `projectId`（仅改 `name`）正常成功。用固定 `runId: 'update-in-flight'`，并仿照既有 `automations-store.spec.ts:982-997` 用 `try { ... } finally { inFlightRuns.delete('update-in-flight') }` 清理，避免失败路径污染后续用例。
3. **T3（真实回滚路径）**：上限预检在创建之前就抛错，根本进不到回滚分支——原计划只有这一条，等于回滚代码零覆盖。用该文件 `:1160-1173` 已有的故障注入先例（把 `automations.json.tmp` 造成目录 ⇒ `writeAutomationRegistry` 的 `writeFile` 报 EISDIR）强制 `createAutomation` 在**项目与目录都已创建之后**失败：

```typescript
test('automation.create rolls back the auto-created project when createAutomation fails after the directory exists', async () => {
  const home = makeHome()
  const ctx = makeCtx(home)
  const create = ROUTE_TABLE.find((route) => route.method === 'automation.create')!
  // 让 writeAutomationRegistry 的临时文件路径不可写：目录存在时 writeFile 报 EISDIR。
  // 此时 mkdir 与 createProject 都已经成功，正好落在回滚分支上。
  const tmpPath = join(home, 'automations.json.tmp')
  mkdirSync(tmpPath)
  try {
    await expect(
      create.handler(
        { params: {}, body: { name: '回滚', kind: 'agent', schedule: { kind: 'manual' }, prompt: 'x' }, query: new URLSearchParams() },
        ctx,
      ),
    ).rejects.toThrow()
  } finally {
    rmSync(tmpPath, { recursive: true, force: true })
  }
  // 项目登记与物理目录都被撤掉：不留孤儿项目、不留空目录。
  expect(await listProjects(home)).toEqual([])
  const projectsDir = join(home, 'workspace-projects')
  expect(existsSync(projectsDir) ? readdirSync(projectsDir) : []).toEqual([])
})
```

4. **T4（`createProject` 失败也要按所有权清理）**：把 `projects.json` 造成只读文件 ⇒ 读（预检 `listProjects`）正常、写（`writeProjectRegistry`）报 EACCES，而 `mkdir(projectRoot)` 仍然成功。这是 B3 指出的「`try` 从 `createProject` 之后才开始」那个未保护路径：

```typescript
test.skipIf(process.platform === 'win32')('automation.create cleans the directory it created when createProject itself fails', async () => {
  const home = makeHome()
  const ctx = makeCtx(home)
  const create = ROUTE_TABLE.find((route) => route.method === 'automation.create')!
  // 可读不可写：预检 listProjects 正常，writeProjectRegistry 的 writeFile 报 EACCES。
  writeFileSync(join(home, 'projects.json'), '{"projects":[]}\n', 'utf8')
  chmodSync(join(home, 'projects.json'), 0o444)
  try {
    await expect(
      create.handler(
        { params: {}, body: { name: '登记失败', kind: 'agent', schedule: { kind: 'manual' }, prompt: 'x' }, query: new URLSearchParams() },
        ctx,
      ),
    ).rejects.toThrow(/EACCES/)
  } finally {
    chmodSync(join(home, 'projects.json'), 0o644)
  }
  // 目录已建但未登记 ⇒ 必须按所有权清掉，不留未登记空目录。
  const projectsDir = join(home, 'workspace-projects')
  expect(existsSync(projectsDir) ? readdirSync(projectsDir) : []).toEqual([])
  expect(await listProjects(home)).toEqual([])
})
```

5. **T4 的真实路由 keep / 补偿覆盖**：纯函数用例只证明判定，不证明路由采集与副作用。用既有 `withAutomationRegistryLock` 把原请求的 `createAutomation` 卡在项目登记之后，再用 `vi.waitFor` 等项目出现；这不需要生产 mock 缝。加入下面的 helper 与四种模式：

```typescript
type RollbackMode = 'nonempty' | 'referenced' | 'remove-fails' | 'read-fails'

async function failAutoProjectCreate(home: string, mode: RollbackMode, logs: string[]) {
  const ctx = makeCtx(home, logs)
  const create = ROUTE_TABLE.find((route) => route.method === 'automation.create')!
  const tmpPath = join(home, 'automations.json.tmp')
  const automationsPath = join(home, 'automations.json')
  const projectsPath = join(home, 'projects.json')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const locked = withAutomationRegistryLock(() => gate)
  // 立即接住成功/失败，避免故障注入阶段出现未处理 rejection。
  const creating = create.handler(
    { params: {}, body: { name: `回滚-${mode}`, kind: 'agent', schedule: { kind: 'manual' }, prompt: 'x' }, query: new URLSearchParams() },
    ctx,
  ).then(() => ({ error: undefined as unknown }), (error: unknown) => ({ error }))
  let project: ProjectInfo | undefined
  let setupError: unknown
  try {
    await vi.waitFor(async () => { expect(await listProjects(home)).toHaveLength(1) })
    project = (await listProjects(home))[0]!
    if (mode === 'nonempty') writeFileSync(join(project.root, 'keep.txt'), 'keep', 'utf8')
    if (mode === 'referenced') {
      const other: AutomationInfo = {
        id: 'other-automation',
        ...normalizeAutomationInput({ name: '占用', kind: 'agent', schedule: { kind: 'manual' }, prompt: 'x', projectId: project.id }),
        createdAt: T0,
      }
      await writeAutomationRegistry(home, { automations: [other] })
    }
    if (mode === 'remove-fails') chmodSync(projectsPath, 0o444)
    if (mode === 'read-fails') {
      await writeAutomationRegistry(home, { automations: [] })
      chmodSync(automationsPath, 0o000)
    } else {
      // 前三种模式让原请求在写 automations.json.tmp 时失败。
      mkdirSync(tmpPath)
    }
  } catch (error) {
    setupError = error
  } finally {
    release()
    await locked
  }
  const { error } = await creating
  if (mode === 'read-fails' && existsSync(automationsPath)) chmodSync(automationsPath, 0o644)
  if (mode === 'remove-fails' && existsSync(projectsPath)) chmodSync(projectsPath, 0o644)
  rmSync(tmpPath, { recursive: true, force: true })
  if (setupError) throw setupError
  expect(error).toBeInstanceOf(Error)
  if (mode === 'remove-fails') expect(String(error)).toContain('EISDIR') // 原始错误不被补偿错误替换
  return { project: project! }
}

for (const mode of ['nonempty', 'referenced'] as const) {
  test(`automation.create preserves the registered project and directory on ${mode}`, async () => {
    const home = makeHome()
    const logs: string[] = []
    const { project } = await failAutoProjectCreate(home, mode, logs)
    expect((await listProjects(home)).some((item) => item.id === project.id)).toBe(true)
    expect(existsSync(project.root)).toBe(true)
    expect(logs.some((line) => line.includes(project.id) || line.includes(project.root))).toBe(true)
    if (mode === 'nonempty') expect(readFileSync(join(project.root, 'keep.txt'), 'utf8')).toBe('keep')
    if (mode === 'referenced') {
      expect((await listAutomations(home)).some((item) => item.projectId === project.id)).toBe(true)
    }
  })
}

// 以下两种权限故障都只模拟 POSIX 非 root 环境，与既有 chmod 先例一致。
test.skipIf(process.platform === 'win32')('automation.create restores the empty root when registry removal fails', async () => {
  const home = makeHome()
  const logs: string[] = []
  const { project } = await failAutoProjectCreate(home, 'remove-fails', logs)
  expect((await listProjects(home)).some((item) => item.id === project.id)).toBe(true)
  expect(existsSync(project.root)).toBe(true)
  expect(logs.some((line) => line.includes(project.id))).toBe(true)
})

test.skipIf(process.platform === 'win32')('automation.create keeps the project when references cannot be read', async () => {
  const home = makeHome()
  const logs: string[] = []
  const { project } = await failAutoProjectCreate(home, 'read-fails', logs)
  expect((await listProjects(home)).some((item) => item.id === project.id)).toBe(true)
  expect(existsSync(project.root)).toBe(true)
  expect(logs.some((line) => line.includes(project.root))).toBe(true)
})
```

`nonempty` 证明路由不会删迟到/既有内容；`referenced` 证明并发复用时登记与目录都保留；`remove-fails` 证明空根已删而登记删除失败时会恢复空根；`read-fails` 证明未知引用不会被当成无引用。Task 4 的纯函数用例继续保留，但不再被描述成这些路由副作用的替代品。

6. **T6（已准入轮次冻结旧根 + 下一次准入/运行用新根）**：在 `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts` 追加。首轮用相对 marker 证明真实 `cwd`；在途时直接调用 store 层 `updateAutomation` 是为了模拟路由 check-then-act 窗口，不是绕过产品的正常操作路径：

```typescript
test('rebinding keeps the admitted run on the old root and moves the next run to the new root', async () => {
  const h = makeHarness()
  const roots = mkdtempSync(join(tmpdir(), 'hw-auto-rebind-'))
  dirs.push(roots)
  const p1Root = join(roots, 'p1')
  const p2Root = join(roots, 'p2')
  mkdirSync(p1Root)
  mkdirSync(p2Root)
  const p1 = await createProject(h.profileDir, { root: p1Root, name: 'P1' })
  const p2 = await createProject(h.profileDir, { root: p2Root, name: 'P2' })
  const release = join(roots, 'release-first')
  h.releaseFiles.push(release)
  const task = await scriptTask(h.profileDir, holdCommand('first-cwd.txt', release), {
    projectId: p1.id,
    name: '改绑',
  })

  const first = await startAutomation(h, task)
  expect(first.root).toBe(resolve(p1.root))
  await poll(() => existsSync(join(p1.root, 'first-cwd.txt')))

  // 模拟「update 的在途检查之后、注册表写入之前，另一轮已按旧根准入」的窗口。
  // 路由自身的在途拒绝由本任务既有 automation.update 用例另行验证。
  const rebound = await updateAutomation(h.profileDir, task.id, {
    projectId: p2.id,
    command: nodeEval('process.stdout.write(process.cwd())'),
  })
  expect(await automationAdmissionRoot(h.routeCtx, rebound)).toBe(resolve(p2.root))
  expect(existsSync(join(p2.root, 'first-cwd.txt'))).toBe(false)

  writeFileSync(release, '1')
  await first.done
  await waitRunEnd(h.events, task.id, 1)
  expect(existsSync(join(p1.root, 'first-cwd.txt'))).toBe(true)
  expect(existsSync(join(p2.root, 'first-cwd.txt'))).toBe(false)

  const second = await startAutomation(h, rebound)
  expect(second.root).toBe(resolve(p2.root))
  await second.done
  await waitRunEnd(h.events, task.id, 2)
  // recentRuns 按时间顺序返回：appendRun 写的是 `[...existing, clipped]`
  // （automations-store.ts），recentRuns 再 `runs.slice(-limit)`（stores.ts）。
  // 所以 [0] 是首轮（holdCommand，无 stdout），[1] 才是第二轮的 cwd 输出。
  // 既有顺序证据：automations-store.spec.ts:1179 在 [r1,r2] 删掉 r2 后断言 ['r1']。
  expect((await recentRuns(h.profileDir, task.id))[1]?.output).toBe(await realpath(p2.root))
  // 旧项目目录与其中的产物不搬家、不删除。
  expect(existsSync(p1.root)).toBe(true)
})
```

这条同时覆盖「当前轮仍用旧根」和「下一准入/下一轮用新根」。它**不声称消除** update 守卫的 check-then-act 窗口；路由在途拒绝和这里的冻结根语义是两个独立断言。

**Step 2: Run test to verify it fails**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/automations-host.spec.ts`
Expected: FAIL (`automation.projectId` is still `null`，且 T6 的当前轮/下一轮根断言尚未实现)。

**Step 3: Write minimal implementation**

在 `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts` 中：
1. 从 `node:fs/promises` 导入 `mkdir`、`readdir`、`rmdir`（这里不得使用 recursive `rm`）；从 `./workspace-state.ts` 导入 `autoProjectRootPath`；从 `./stores.ts` 补导入 `autoProjectRollbackAction`、`removeProject`；把 `type ProjectInfo` 加入 `routes.ts:7-12` 既有的 `../client-huaanwork/rpc-types.ts` 类型导入（`stores.ts` **不导出**该类型）；从 `./automations-store.ts` 导入 `MAX_AUTOMATIONS`；从 `./automations-host.ts` 导入 `hasInFlightAutomationRun`。**先核对既有 import 再补差集**；替换掉某个导入的唯一使用点时要删掉旧导入（Global Constraints 的「类型门禁铁律」）。
2. 新增文件内局部 helper（**B3**：回滚判定用 Task 4 的纯函数，这里只做副作用）：
   ```typescript
   /**
    * 自动建项目的尽最大努力回滚(B3)。判定抽成 stores.ts 的纯函数,
    * autoProjectRollbackAction,这里只做副作用。
    *
    * 先非递归 rmdir 空目录再摘登记:迟到文件会让 rmdir(ENOTEMPTY)失败,
    * 登记尚未改变,不会被 recursive rm 抢走。摘登记失败则恢复刚删的空根。
    * 所有保留/补偿失败都写日志;调用方重新抛出原始创建错误。
    *
    * 跨文件不是事务:进程在两步之间退出仍可能留下空项目(设计 §3.3.2 已如实写明,
    * 用户可按常规项目删除或复用)。
    */
   async function rollbackAutoProject(
     ctx: { profileDir: string; logger: (message: string) => void },
     projectId: string,
     projectRoot: string,
     registered: ProjectInfo | undefined,
   ): Promise<void> {
     const dirEntries = await readdir(projectRoot).catch(() => undefined)
     // mkdir 本身就失败了:既没登记也没目录,无现场可留,也不必写误导性日志。
     if (registered === undefined && dirEntries === undefined) return
     const automations = await listAutomations(ctx.profileDir).catch(() => undefined)
     if (dirEntries === undefined || automations === undefined) {
       ctx.logger(`automation.create: 回滚保留现场 ${projectRoot}（目录或自动化引用不可读）`)
       return
     }
     const referencedByAutomations = automations.some((item) => item.projectId === projectId)
     if (autoProjectRollbackAction({ dirEntries, referencedByAutomations }) === 'keep') {
       ctx.logger(`automation.create: 回滚保留现场 ${projectRoot}（目录非空或已被其他自动化引用）`)
       return
     }

     try {
       // 只删空目录;若检查后又有文件到达,ENOTEMPTY 且登记仍保留。
       await rmdir(projectRoot)
     } catch (error) {
       ctx.logger(`automation.create: 回滚保留项目 ${projectId}，空目录删除失败 ${projectRoot}: ${error instanceof Error ? error.message : String(error)}`)
       return
     }
     if (registered === undefined) return
     try {
       await removeProject(ctx.profileDir, registered.id)
     } catch (error) {
       // 目录已删而登记没删掉:恢复空根,避免侧栏项目指向不存在的目录。
       await mkdir(projectRoot, { recursive: true }).catch((recoveryError: unknown) => {
         ctx.logger(`automation.create: 恢复自动项目空目录失败 ${projectRoot}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`)
       })
       ctx.logger(`automation.create: 项目登记删除失败，保留项目 ${registered.id}: ${error instanceof Error ? error.message : String(error)}`)
     }
   }
   ```
3. 修改 `automation.create` 路由（`:1132-1149`）。**回滚保护覆盖 `mkdir → createProject → createAutomation` 整段**（原计划的 `try` 从 `createProject` 之后才开始，留下「目录已建、项目未登记」的无保护路径）：
   ```typescript
   {
     method: 'automation.create',
     http: 'POST',
     path: '/huaanwork/automation/create',
     handler: storeRoute(async (req, ctx) => {
       if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
         throw new Error('automation.create requires an object params')
       }
       const input = normalizeAutomationInput(req.body as Record<string, unknown>)
       if (input.projectId !== null) {
         const projects = await listProjects(ctx.profileDir)
         if (!projects.some((project) => project.id === input.projectId)) {
           throw new Error(`project ${input.projectId} was not found`)
         }
         return { automation: await createAutomation(ctx.profileDir, input) }
       }
       // 预检放在建目录之前:并发跨过预检的情况由 createAutomation 的锁内复检
       // (automations-store.ts:286-288)兜住,那条路径正好走下面的回滚。
       if ((await listAutomations(ctx.profileDir)).length >= MAX_AUTOMATIONS) {
         throw new Error(`任务数量已达上限（${MAX_AUTOMATIONS} 个），请先删除不再需要的任务`)
       }
       const projectId = randomUUID()
       const projectRoot = autoProjectRootPath(ctx.profileDir, projectId)
       let registered: ProjectInfo | undefined
       try {
         await mkdir(projectRoot, { recursive: true })
         registered = await createProject(ctx.profileDir, {
           id: projectId,
           name: input.name,
           root: projectRoot,
         })
         const automation = await createAutomation(ctx.profileDir, { ...input, projectId })
         return { automation }
       } catch (error) {
         await rollbackAutoProject(ctx, projectId, projectRoot, registered)
         throw error
       }
     }),
   },
   ```
4. 修改 `automation.update` 路由（`:1151-1168`）。**在途守卫是 check-then-act，不得在注释或文档里承诺不存在并发窗口**（实施评审 §6 第 5 条）：准确的说法是「已准入的轮次继续使用准入时冻结的旧根，之后的准入使用新根」。
   ```typescript
   {
     method: 'automation.update',
     http: 'POST',
     path: '/huaanwork/automation/update',
     handler: storeRoute(async (req, ctx) => {
       if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
         throw new Error('automation.update requires an object params')
       }
       const id = bodyParam(req.body, 'id')
       if (!id) throw new Error('automation.update requires params.id')
       const patch = req.body as Record<string, unknown>
       if (patch.projectId !== undefined) {
         const targetProjectId = typeof patch.projectId === 'string' ? patch.projectId.trim() : ''
         if (!targetProjectId) {
           // 不允许通过 automation.update 把 projectId 改回 null(设计 §3.3.3 第 1 点)。
           throw new Error('automation.update requires a non-empty projectId')
         }
         const existing = await findAutomation(ctx.profileDir, id)
         if (existing.projectId !== targetProjectId) {
           // check-then-act:守卫与随后的写入之间存在窗口。窗口内已准入的轮次不受影响
           // (root 在 admitAutomation 时按值冻结),下一轮起才用新根。不承诺消除该窗口。
           if (hasInFlightAutomationRun(id)) {
             throw new Error('该自动化任务正在运行，请等待运行结束或停止后再修改归属项目')
           }
           const projects = await listProjects(ctx.profileDir)
           if (!projects.some((project) => project.id === targetProjectId)) {
             throw new Error(`project ${targetProjectId} was not found`)
           }
         }
       }
       const updated = await updateAutomation(ctx.profileDir, id, patch)
       if (patch.enabled !== undefined || patch.schedule !== undefined || patch.projectId !== undefined) {
         ctx.runtimeCtx?.huaanworkTurnScheduler?.clearAdmissionSkip(id)
       }
       return { automation: updated }
     }),
   },
   ```

**Step 4: Run test to verify it passes**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/stores.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/route-contract.spec.ts`
Expected: PASS —— 含 T3（真实回滚）、T4（createProject 失败清理 + 路由级非空/引用/读取/登记删除失败保护）、T6（已准入轮次保持旧根，下一准入与下一轮落新根）与 Task 4 的 `autoProjectRollbackAction` 纯函数用例。

---

### Task 7: 前端创建/编辑归属项目交互与侧栏项目列表同步刷新（`AutomationsView.tsx`, `App.tsx`）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx:318-333,845-875,1060-1075,1112-1133`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:3557`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts:21,85-97`（**B1**：`AutomationPatch` 加 `projectId?: string`；`:21` 过期注释）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:268-269`（过期注释）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/automations-runs-delete.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`

**Interfaces:**
- Consumes: `updateAutomation(id: string, patch: AutomationPatch)`（`client-huaanwork/projects.ts:59-61`）。**B1 的关键**：`AutomationsView.tsx:1060` 以对象字面量调用它，因此 `AutomationPatch` 不含 `projectId` 时 TypeScript 的多余属性检查会让 `corepack yarn typecheck` 必红 —— 这一步不是可选清理，是本任务的前置。
- Produces: `AutomationPatch.projectId?: string`（编辑态改绑用）。`AutomationDraft.projectId: string | null` **不动**，创建路径已有该字段。

**Step 1: Write the failing tests**

0. 先扩展现有测试夹具，不碰生产组件：`automations-runs-delete.spec.ts` 从 `logic/projects.ts` 的类型导入中补 `ProjectInfo`，给 `mount(options)` 的 options 类型增加下面这个可选字段，并把 `:106` 的 `projects: []` 改成 `projects: options.projects ?? []`。既有调用方不传时行为不变；本任务用例显式传入两个项目。
   ```typescript
   projects?: ProjectInfo[];
   projects: options.projects ?? [],
   ```
1. 在 `dsh-plugin-huaanwork/tests/client-huaanwork/automations-runs-delete.spec.ts` 新增用例：
   - 点击「新建任务」打开创建模态框时，「归属项目」下拉框默认选中值 `""` 的文案为 `自动创建同名项目（推荐）`，辅助说明包含 `将自动为您创建同名项目并绑定`；
   - 点击任务行的「编辑」打开编辑模态框时，同样展示「归属项目」下拉框；当任务未运行时可选择新项目并在 `automation.update` 请求体中携带 `projectId`；当该任务 id 在 `runningIds` 中时，「归属项目」下拉框为 `disabled`。
2. 在 `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts` 新增源码接线断言：
   - `AutomationsView` 的 `onChanged` 同时触发 `refreshAutomations()` 与 `refreshProjects()`。

**Step 2: Run tests to verify they fail**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/client-huaanwork/automations-runs-delete.spec.ts tests/client-huaanwork/appWiring.spec.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

0. **B1（必须先做，否则本任务后面每一步都通不过 typecheck）**：在 `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts` 的 `AutomationPatch`（`:85-97`）里加一个可选字段，并把 `:21` 的过期注释改掉：
   ```typescript
   export type AutomationPatch = {
     name?: string;
     kind?: "agent" | "script";
     schedule?: AutomationSchedule;
     prompt?: string;
     command?: string;
     widget?: boolean;
     enabled?: boolean;
     expiresAt?: number | "";
     missedPolicy?: "skip" | "run-once" | "";
     taskShape?: "independent" | "merged" | "";
     unattended?: { enabled: boolean; allow: string[] } | "";
     /** 改绑归属项目（设计 §3.3.3）：只接受非空且真实存在的项目 id，不能改回 null。 */
     projectId?: string;
   };
   ```
   同批清理三处会变成假话的注释（实施评审 §6 第 1、2、3 条）：
   - `logic/projects.ts:21`：`projectId: string | null;  // null = 中立归属(issue #2),创建后不可改` ⇒ 改成 `// null = 历史存量中立归属；新建任务由 automation.create 自动建项目并绑定，改绑见 AutomationPatch.projectId`。
   - `rpc-types.ts:268-269`：删掉「归属在创建后不可改（update 白名单不含 projectId）」那两句，保留「`projectId` 可为 `null`；旧记录均为 string，向前兼容」。类型本身不动。
   - `AutomationsView.tsx:867`：删掉「仅创建模式可选,编辑不可改(sidecar update 白名单不含 projectId)」。
   - （`automations-store.ts:74` 的同源注释已在 Task 4 Step 3.2 处理，不要重复改。）
1. 在 `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx` 中：
   - 给 `AutomationFormModal` 增加 `running?: boolean` prop，并在调用处（`:320`）传入 `running={editing.mode === "edit" && runningIds.has(editing.automation.id)}`；
   - 在 `submit()` 的编辑分支（`:1060-1073`）中，当 `bindProjectId && bindProjectId !== editing.automation.projectId` 时向 `updateAutomation` 传入 `projectId: bindProjectId`；
   - 将 `:1112-1132` 的归属项目字段改为创建/编辑通用展示：
     ```tsx
     <label className="modal-field">
       {editing.mode === "create" ? "归属项目（可选）" : "归属项目"}
       <select
         className="modal-input"
         value={bindProjectId ?? ""}
         aria-label="归属项目"
         disabled={editing.mode === "edit" && Boolean(running)}
         onChange={(event) => setBindProjectId(event.target.value || null)}
       >
         {editing.mode === "create" ? (
           <option value="">自动创建同名项目（推荐）</option>
         ) : source?.projectId === null ? (
           <option value="" disabled>
             未绑定项目（历史任务，可选择项目绑定）
           </option>
         ) : !projects.some((project) => project.id === source?.projectId) ? (
           <option value={source?.projectId ?? ""} disabled>
             原归属项目已删除（请选择新项目）
           </option>
         ) : null}
         {projects.map((project) => (
           <option key={project.id} value={project.id}>
             {project.name}
           </option>
         ))}
       </select>
       <span className="muted" style={{ fontSize: 12 }}>
         {editing.mode === "create"
           ? "未选择已有项目时，将自动为您创建同名项目并绑定；也可选择已有项目"
           : running
             ? "任务正在运行，请等待运行结束或停止后再修改归属项目"
             : "修改归属项目后，下一轮运行将在新项目目录中执行（原项目文件不会迁移）"}
       </span>
     </label>
     ```
2. 在 `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:3557` 中，将 `AutomationsView` 的 `onChanged` 更新为：
   ```tsx
   onChanged={() => {
     void refreshAutomations();
     void refreshProjects();
   }}
   ```

**Step 4: Run tests to verify they pass**

Run: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/client-huaanwork/automations-runs-delete.spec.ts tests/client-huaanwork/appWiring.spec.ts`
Expected: PASS.

再跑一次客户端 typecheck，确认 B1 的字段补齐生效（`AutomationsView.tsx:1060` 传 `projectId` 不再触发多余属性检查）：

Run: `corepack yarn --cwd dsh-plugin-huaanwork typecheck`
Expected: PASS (exit code 0)。

---

### Task 8: 全量类型检查与单元测试门禁验证

**Files:**
- Modify: 无新增修改（验证全仓门禁通过）

**Step 1: Run typecheck**

Run: `corepack yarn typecheck`
Expected: PASS (exit code 0)。这一步会同时验掉 **B1**（`AutomationPatch.projectId`）与 **B4**（`automations-host.ts` 的未使用导入）——两者都是「照抄即红」的编译缺口。

**Step 2: 定向跑本次改动涉及的测试文件**

Run:
```bash
corepack yarn --cwd dsh-plugin-huaanwork vitest run \
  tests/huaanwork-guardrails/sandbox-cwd.spec.ts \
  tests/huaanwork-host/writable-root.spec.ts \
  tests/huaanwork-host/sessions.spec.ts \
  tests/huaanwork-host/session-sweep.spec.ts \
  tests/huaanwork-host/stores.spec.ts \
  tests/huaanwork-host/automations-store.spec.ts \
  tests/huaanwork-host/automations-host.spec.ts \
  tests/huaanwork-host/automation-scheduler.spec.ts \
  tests/huaanwork-host/routes.spec.ts \
  tests/huaanwork-host/route-contract.spec.ts \
  tests/client-huaanwork/appWiring.spec.ts \
  tests/client-huaanwork/concurrentTurn.spec.ts \
  tests/client-huaanwork/automations-runs-delete.spec.ts
```
Expected: PASS。实施评审 2026-11-07/08 两轮实跑的基线是 **12 个既有测试文件 / 378 条**（A 组 180 + B 组 198）；本计划还加入 `concurrentTurn.spec.ts` 及新增用例，总数应高于 378。四条既有删除钉子必须仍在其中并通过、**测试名与断言一字未改**：

- `sessions.spec.ts` `releases a waiting request_input, cancels the live agent, and forgets the session`
- `sessions.spec.ts` `session.remove cancels the removed session’s queued items so a drain cannot resurrect it`
- `sessions.spec.ts` `the send records the session model and writable root until removal`
- `sessions.spec.ts` `session.remove during the dequeue→followup window stops a persisted session’s text`

用 `git diff -- dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts` 自查：这四条用例的 diff 必须为**纯新增邻居**，不得出现对它们自身的 `-` 行。

**Step 3: Run unit test suite**

Run: `corepack yarn test`
Expected: PASS (all test files green).

**Step 4: 核对诚实口径（文本检查，不是测试）**

- `sessions.ts` 的 `removeSession` 附近有 D5 = E 的残留口径注释：写明在途删除时该轮工具写可能失败、子代理可能重建部分目录、启动清扫不回收；且**不含**「删除会等收尾完成」或「不会留下任何残留」一类承诺。
- `routes.ts` 的 `rollbackAutoProject` 只调用非递归 `rmdir` 删除空项目根，不得出现 `rm(projectRoot, { recursive: true`；目录/引用读取失败直接保留并写日志，登记删除失败会尝试恢复空根。附近保留「跨文件不是事务、进程崩溃可能留下空项目」的口径。
- 直接 `session.remove` 与 project/automation 级联删除不是同一条物理清理链，后者可能留下独立会话根；不得宣称级联路径也已清根。
- `automation.update` 的在途守卫注释写成 check-then-act：「已准入轮次保持冻结的旧根，之后的准入使用新根」，**不承诺**不存在并发窗口。
- 孤儿目录（E5）的处置已写进下面「NOT in scope」一节。
- 三处「创建后不可改」文案（`logic/projects.ts:21`、`rpc-types.ts:268-269`、`AutomationsView.tsx:867`）与 `automations-store.ts:74` 均已改写。

**Step 5: Check git status & diff boundary**

Run: `git status --short`
Expected: 仅 `dsh-plugin-huaanwork/` 与 `docs/superpowers/` 下有预期变更，`deepseek-harness/` 子模块与 `turn-scheduler.ts` 零改动。改动到的生产文件应当**恰好**是 File Structure 表里的 13 个。

**Step 6: 真实界面验收（T7）**

单元测试锁的是 `started: true`、路径夹紧与接线；**不代替人在窗口里看**。至少走查并留存实际步骤与结果：

1. 「任务」区同时开两个新建中立对话标签，两边都发消息 ⇒ 两个回合**同时**执行，不出现「等待当前任务」。
2. 各自的工作区文件落在自己的 `<profileDir>/workspace-sessions/<sessionId>` 里，`work-1` 的 `<profileDir>/workspace` 不受影响。
3. 铸造失败恢复：把 profile 目录置为只读后在新建中立标签发消息 ⇒ 看到真实错误、**草稿仍在**、消息没有发出去；恢复权限后重试成功。
4. 删除一个正在跑 `@` 子代理的独立会话 ⇒ 界面立即消失；宿主日志若有 `rm` 失败必须出现对应一行（不得静默）。
5. 新建自动化（不选项目）⇒ 侧栏「项目」列表**立即**出现同名项目，自动化行徽标可见。
6. 编辑该自动化改绑到另一个项目 ⇒ 运行中时下拉框禁用并给出提示；非运行时可改绑，下一轮运行落在新项目目录，旧目录文件未搬走。
7. 记录**未验证的平台**（例如 Windows）——不得把 macOS 走查写成全平台通过。

## Scope record

feature answers: 没有提议砍功能。设计 §2 要求中立会话独立根与自动化自动建项目一起做。
structure: A — 确认原有安排（D1，plan-eng-review-structure，用户选择 A）
accepted scope: 计划文件表里的 **13** 个生产文件（`workspace-state.ts`、`writable-root.ts`、`sessions.ts`、`index.ts`、`stores.ts`、`automations-store.ts`、`automations-host.ts`、`routes.ts`、`AutomationsView.tsx`、`App.tsx`，以及实施评审补入的 `client-huaanwork/logic/projects.ts`、`client-huaanwork/logic/concurrentTurn.ts`、`client-huaanwork/rpc-types.ts`）以及各任务已经点名的测试。路径函数留在 `workspace-state.ts`。项目注册表锁与 `autoProjectRollbackAction` 留在 `stores.ts`。铸造失败判定留在 `logic/concurrentTurn.ts`。**不新建模块**（三个补入文件都是既有文件）。计数订正自实施评审 §2：原写 10，评审一度订正为 11/12，最终为 13。
pending remedies: none
approved remedies: R5 D2 A — session.new 失败时显示错误、留下草稿、不调用 session.send。R1 D3 A — workspace 被登记成项目时，已铸造的会话目录优先，work-1 仍用 workspace。R2 D4 B — 中立前缀的其余情况留在 workspace，不执行设计步骤 4–5。R4 事实订正 — `neutralAutomationRoot` 放在 executeRun 的内层 try 里。R3 已在 Task 4 改为改写旧测试。**R6 D5 E（2026-11-08）— 独立会话根保持立即删除，补 `rm` 失败日志、收窄条件与残留诚实口径；不新增收尾观测/tombstone，不改 `turn-scheduler.ts` 与客户端删除流程。R7 D6 F（2026-11-08）— 把铸造失败判定抽成 `logic/concurrentTurn.ts` 的 `sessionMintFailureNote` 后做行为测试，源码切片断言降为接线钉。**

## Decision ledger

> 各条目的 `Project/branch/task` 记录的是**提问当时**的分支，属历史事实，不随分支迁移改写。R5/R1/R2 提问时在 `feat/huaanwork-concurrent-project-turns`；该分支已于 2026-11-08 合并进 master 并删除，当前实施分支见 Global Constraints 的「分支约束」。

### R5: session.new 失败时，新建中立对话是否继续发送
Finding: A1, CRITICAL, confidence 9/10, dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:2689, reviewer eng
Plan baseline: 计划没有写这条路径。session.new 成功时返回独立目录；失败时沿用今天的空 catch。
Runtime evidence: `catch { sessionId = undefined }` 在 App.tsx:2689-2691。只有 `projectId != null` 才停发（App.tsx:2695-2697）。中立标签继续调用 `session.send` 且不带 sessionId（App.tsx:2729-2732）。服务端用 `sessionIdFor(routeCtx.workspaceRoot.current)`（dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:936）。计划里的 `neutralSessionRoot` 会 `mkdirSync`（docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md:148-151），磁盘满或无权限时这条 throw 变得可达。
Comparison grid:

| Choice | Current | A | B |
| --- | --- | --- | --- |
| R5 铸造失败 | 吞掉错误，不带 sessionId 发送，落到前台稳定会话 | 显示错误，留下草稿，不调用 session.send | 保持吞掉并发送 |
| R1 workspace 已是项目 | 未决 | 未决 | 未决 |
| R2 步骤 4–5 回落 | 未决 | 未决 | 未决 |
| R4 mkdirSync 落点 | 未决 | 未决 | 未决 |

Question D2:
D2 — session.new 失败时，新的中立对话还发不发
Project/branch/task: feat/huaanwork-concurrent-project-turns，中立会话独立子根计划。
ELI10: 计划会在新建中立会话时创建它自己的目录。目录建失败（磁盘满或没有权限）时，界面现在把错误吃掉，仍然把消息发出去。服务端没拿到会话 id，就写进当前前台工作区的稳定会话。用户看不到失败，这条新对话并没有自己的目录。
Stakes if we pick wrong: 用户以为新开了并行任务，实际和 work-1 或当前打开的项目挤在同一个可写根上，这次要解开的排队又回来了。
Recommendation: A because 新增的 mkdirSync 让这次抛错变得可达，而设计目标是新的中立对话不再占用共享根。
Completeness: A=9/10, B=4/10
Pros / cons:
A) 失败就停，不发送 (recommended)
  ✅ 用户看得到错误，草稿还在，消息不会写进共享的 workspace 或当前前台项目
  ✅ 改动就在计划已经要改的 App.tsx，补一条客户端测试就能把这条回退锁住
  ❌ 目录暂时建不出来时，这个新标签发不出消息，要等目录能创建再重试
B) 保持吞掉错误并发送
  ✅ 不改界面的 catch，session.new 抛错时消息仍然会发出去
  ✅ 前台已经打开的稳定会话能立刻接到这条消息，用户不用重试
  ❌ 用户看不到失败，消息进入前台稳定会话，新对话的独立目录没有生效
Net: 要么失败可见并且不发送，要么接受失败时悄悄回到共享根。
Header: 铸造失败是否发送
Options:
A) 失败就停，不发送
失败时向用户显示错误，保留输入框草稿，不调用 session.send。在 App.tsx 现有 catch 处改，并加一条客户端测试：session.new 拒绝时中立标签不发出 session.send。约 human 1 小时 / CC 10 分钟。
B) 保持吞掉错误并发送
不改 catch。计划里写明：目录创建失败时，这条消息进入前台稳定会话。不新增测试。

State: approved
Actual answer: A — 失败就停，不发送（D2，用户选择 A）
Accepted scope: session.new 失败时向用户显示错误，保留输入框草稿，不调用 session.send。改 App.tsx 现有空 catch。加一条客户端测试：session.new 拒绝时中立标签不发出 session.send。
History: 提问前为 pending / unanswered / none。

### R1: 中立 workspace 被登记成项目时，新中立会话用哪个目录
Finding: A2, CRITICAL, confidence 8/10, dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts:38-41, reviewer eng
Plan baseline: 计划保留「项目稳定 id 优先」循环，随后才识别 `workspace-sessions`。`sessionNew` 在 `fresh && cwd === neutralRoot` 时仍创建并返回 sibling 目录。
Runtime evidence: `writable-root.ts:38-41` 对 `sessionId.startsWith(sessionIdFor(project.root) + '-')` 直接返回项目根。新建 id 来自 `freshSessionIdFor(neutralRoot)`，形状是 `sessionIdFor(workspace)` 加 `-<8hex>`（`session-id.ts:10-11`）。若某个项目的 `root` 解析后等于 `<profileDir>/workspace`，这个前缀就是该项目的稳定 id。第一次发送没有已登记根，走 `writableRootForSession`（`sessions.ts:947-953`）。客户端把 `session.new` 返回的 cwd 记在 `rememberMinted`（`App.tsx:692-695`）。用户可以用文件夹选择器把任意现存目录登记成项目（`App.tsx:2413-2417`，`stores.ts:68-69`）。
Comparison grid:

| Choice | Current | A | B |
| --- | --- | --- | --- |
| R1 workspace 已是项目 | 未决。计划会铸造 sibling，推导却返回 workspace | 已铸造的 sibling 目录优先，work-1 仍用 workspace | 不铸造 sibling，两边都用 workspace |
| R5 铸造失败 | 已批准 D2 A：显示错误，不发送 | 已批准 D2 A：显示错误，不发送 | 已批准 D2 A：显示错误，不发送 |
| R2 步骤 4–5 回落 | 未决 | 未决 | 未决 |
| R4 mkdirSync 落点 | 未决 | 未决 | 未决 |

Question D3:
D3 — workspace 被登记成项目时，新中立对话用哪个目录
Project/branch/task: feat/huaanwork-concurrent-project-turns，中立会话独立子根计划。
ELI10: 新中立对话的会话 id 以 workspace 的稳定 id 开头。如果有人把 workspace 这个文件夹本身登记成项目，现有推导会认为这些新会话都属于那个项目，于是回到共享目录。计划却又给它们建了另一个目录。界面记住的是新目录，真正写文件的是共享目录。
Stakes if we pick wrong: 要么两个新对话继续互相排队，要么界面和磁盘各记一个目录，回合结束核对和沙箱根对不上。
Recommendation: A because 这次改动的目标就是让新的中立对话不再共用 workspace，文件夹选择器又确实允许把那个目录登记成项目。
Completeness: A=8/10, B=6/10
Pros / cons:
A) 已铸造目录优先 (recommended)
  ✅ 即使 workspace 已经被登记成项目，新建的中立对话仍然各自使用 workspace-sessions 下的目录
  ✅ work-1 仍留在 workspace，和设计里的默认稳定会话一致
  ❌ 项目列表里可以留下一个根就是共享 workspace 的项目，它和那些独立会话看起来像一家人
B) 两边都用共享目录
  ✅ 铸造返回的 cwd 和可写根是同一个目录，不会一边记新目录、一边往 workspace 写文件
  ✅ 推导顺序仍是设计写的「项目稳定 id 优先」，不用为这一种项目开例外
  ❌ 这个 profile 上的新中立对话继续互相排队，计划要解开的瓶颈在这里不成立
Net: 要么隔离继续有效，要么这个 profile 明确退回共享目录并且两边一致。
Header: workspace 项目是否抢会话
Options:
A) 已铸造目录优先
会话 id 带中立稳定前缀，并且 `workspace-sessions/<sessionId>` 已存在，或持久化 cwd 在该目录内时，返回该目录，即使有项目的 root 就是 workspace。精确等于 work-1 的稳定 id 仍返回 workspace。补一条 writable-root 测试。约 human 2 小时 / CC 15 分钟。
B) 两边都用共享目录
`sessionNew` 发现已有项目根解析后等于中立 workspace 时，不创建 sibling，返回 workspace。可写根保持今天的项目前缀优先。计划写明这个 profile 不提供逐会话目录。约 human 1 小时 / CC 10 分钟。

State: approved
Actual answer: A — 已铸造目录优先（D3，用户选择 A）
Accepted scope: 会话 id 带中立稳定前缀，并且 workspace-sessions/<sessionId> 已存在，或持久化 cwd 在该目录内时，返回该目录，即使有项目的 root 就是 workspace。精确等于 work-1 的稳定 id 仍返回 workspace。补一条 writable-root 测试。
History: 提问前为 pending / unanswered / none。2026-11-07 补记：该例外已写进 Task 2 的函数体，规格 §2 与 §3.2.3 步骤 2 同步。

### R2: 带中立前缀、但 cwd 在别的项目里的会话，要不要改判到那个项目
Finding: A3, CRITICAL, confidence 8/10, docs/superpowers/specs/2026-11-07-neutral-subroots-and-automation-projects-design.md:176, reviewer eng
Plan baseline: 计划在中立前缀分支的末尾直接返回 workspace，不继续做唯一项目归属和自动化目录识别。
Runtime evidence: 现有测试 `the neutral stable id stays neutral even when the logged cwd is inside a project` 断言 `${neutralStable}-abc12345` 在 cwd 位于某个项目内时仍返回中立根（dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts:148-155）。文件头注释写明命中稳定 id 后不再看 cwd（dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts:15-18）。裁定当时的规格把其余情况继续送进步骤 4–5；该句已改掉，现行规格 §3.2.3 的 D4 条与本裁定一致。
Comparison grid:

| Choice | Current | A | B |
| --- | --- | --- | --- |
| R2 中立前缀且 cwd 在其他项目 | 留在 workspace，恢复时因 cwd 不在根内被拒绝 | 改判到那个唯一项目，并改写现有测试的后缀断言 | 留在 workspace，计划写明不执行设计的步骤 4–5 |
| R1 workspace 已是项目 | 已批准 D3 A | 已批准 D3 A | 已批准 D3 A |
| R5 铸造失败 | 已批准 D2 A | 已批准 D2 A | 已批准 D2 A |
| R4 mkdirSync 落点 | 未决 | 未决 | 未决 |

Question D4:
D4 — 中立前缀会话的 cwd 在别的项目里时，要不要跟着走
Project/branch/task: feat/huaanwork-concurrent-project-turns，中立会话独立子根计划。
ELI10: 有些旧会话的 id 带 workspace 的稳定前缀，但日志里的目录落在另一个项目里。设计说这种情况要继续往下认，认到唯一项目就用那个项目。现有测试说不行，这种 id 必须留在 workspace。计划跟的是测试，不是设计那一句。
Stakes if we pick wrong: 选设计，一条已经钉死的测试会改义，这类会话会从中立通道被搬到项目里。选测试，设计里写的「继续往下认」不会发生，cwd 已经跑到项目里的旧会话仍然恢复失败。
Recommendation: B because 现有测试和文件注释是已经发出去的规则，专门防止用 cwd 把中立通道会话改判到项目。设计那一句会直接打翻它。
Completeness: A=8/10, B=7/10
Pros / cons:
A) 按设计改判到项目
  ✅ cwd 只落在一个项目里的旧中立前缀会话可以在那个项目里恢复，而不是被「属于其他工作区」拒绝
  ✅ 和设计 §3.2.3 的步骤 4、5 字面一致
  ❌ 必须改写现有测试里「后缀 id 即使 cwd 在项目里也留在中立根」的断言
B) 留在 workspace (recommended)
  ✅ 现有测试和「命中稳定 id 就不再看 cwd」的注释继续有效，中立通道不会被项目目录抢走
  ✅ 计划里的实现不用再改这一段，只要写明不执行设计的步骤 4–5
  ❌ cwd 已经落在项目里的这类旧会话仍然恢复失败，设计那一句不会落地
Net: 要么让设计的恢复路径打翻现有测试，要么让计划明确不跟设计的那一次回落。
Header: 中立前缀是否跟 cwd
Options:
A) 按设计改判到项目
中立前缀会话如果不是 workspace 内的存量，也不是已铸造的会话目录，就继续做唯一项目和自动化目录识别。改写 writable-root.spec.ts 里后缀 id 的那条断言。约 human 1 小时 / CC 10 分钟。
B) 留在 workspace
计划写明：中立前缀分支的其余情况返回 workspace，不执行设计的步骤 4–5。保留现有测试。约 human 15 分钟 / CC 5 分钟。

State: approved
Actual answer: B — 留在 workspace（D4，用户选择 B）
Accepted scope: 中立前缀分支的其余情况返回 workspace，不执行唯一项目归属和自动化目录识别。保留测试 `the neutral stable id stays neutral even when the logged cwd is inside a project`。
History: 提问前为 pending / unanswered / none。2026-11-07 补记：规格 §3.2.3 已改成这一裁定。步骤 4–5 只处理不带中立前缀的会话。

### R4: 存量自动化建目录失败时，运行记录停在哪里
Finding: CQ1, INFORMATIONAL, confidence 8/10, dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:576, reviewer eng
Plan baseline: 计划把 `neutralAutomationRoot` 插在缺失项目早退之后、`runAgentTurn` 之前，没有写明必须在内层 try 里。
Runtime evidence: `markAutomation` 在 :576 把 `lastStatus` 写成 `running`。内层 try 从 :604 包住执行，失败后 :647 的 `finishAutomation` 收口。插在内层 try 外面时，建目录抛错会跳过收口。
Comparison grid: 不单列选项。成功路径不变，只有放进现有 catch 才能收口。这是事实订正，没有另问。
State: approved
Actual answer: factual — 放进内层 try
Accepted scope: `neutralAutomationRoot` 放在包住 `runAgentTurn` / `runScript` 的内层 try 里。抛错走现有 catch 和 `finishAutomation`。已删除项目的早退仍不建目录。
History: none

### R6: 删除活跃独立会话时，物理目录什么时候删（D5）
Finding: B2, CRITICAL（竞态事实）, confidence 9/10, dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:576-596, reviewer impl-review + 2026-11-08 独立复核
Plan baseline: 计划 Task 3 在 `releaseSessionRuntime` 与 `unlink` 之后立即 `rm(neutralSessionRootPath(...), { recursive: true, force: true }).catch(() => undefined)`。
Runtime evidence: `releaseSessionRuntime`（:576-596）只发 `cancel?.({ kind: 'user' })`，其 :584 注释自陈「只动队列,不碰活动写者」；完整收尾是 `cleanup()`（:146-159，`afterIdle()` → 子代理清理 → 父会话 `whenIdle()` → `releaseOnce()`）。客户端 `App.tsx:3247` 先 `session.cancel`、`:3260` 紧接着 `session.remove`，cancel 不等于收尾完成。⇒ 目录可能在写者仍活跃时被删。
Comparison grid:

| Choice | 原计划 | A 在途则拒删 | B 有界等待后删 | C 延迟异步删 + tombstone | **E 立即删 + 收窄与诚实口径** |
| --- | --- | --- | --- | --- | --- |
| 竞态 | 存在，静默 | 消除 | 消除 | 消除 | 存在，但半径受限且日志可见 |
| 既有四条删除钉子 | 绿 | **红**（`:1521`/`:2563`/`:2869`） | 需改写 | 绿 | **绿，一字不改** |
| 需要新机制 | 无 | 在途查询点 | 收尾 Promise 登记 | 收尾观测 + tombstone | 无 |
| 碰 `turn-scheduler.ts` | 否 | 可能 | 可能 | 可能 | **否** |
| 复活已删会话 | 不会（fail-closed） | 不会 | 不会 | **会**（无 tombstone 时） | 不会（fail-closed） |

Question D5:
D5 — 删除正在跑的独立中立会话时，物理目录什么时候删
ELI10: 每个新建中立对话现在有自己的目录。用户在这个对话还在跑的时候点删除，计划是「立刻连目录一起删」。那时候可能还有工具在往这个目录里写。
Stakes if we pick wrong: 选「等跑完再删」要新造一套收尾观测机制，还可能让已经删掉的会话被复活后又删掉活根；选「不许删」会打翻四条既有回归钉，而且宿主没有「已经停完了」的信号，用户点了停止也可能永远删不掉。
Recommendation（2026-11-08 复核后）: E。因为这个目录是该会话**专属**的平级兄弟根，设计 §3.1 的双向夹紧保证它写不进共享 workspace、别的会话、任何项目根或自动化目录，反之亦然 ⇒ 受损的只有用户刚刚亲手删掉的那一轮自己。
Completeness: E=9/10, A=3/10, B=5/10, C=5/10
Pros / cons:
E) 立即删 + 收窄与诚实口径 (recommended)
  ✅ 四条既有钉子一字不改；不新增任何机制；不碰禁改文件；客户端删除流程不动
  ✅ 保留现有的 fail-closed 性质：目录删掉后陈旧标签再发该 id 会回落中立根，不会复活
  ✅ 改动面收敛到 `removeSession` 里的 `rm` 一行加日志
  ❌ 在途删除时该轮剩余工具写可能 ENOENT 失败（该轮在界面上已不存在）
  ❌ 子代理收尾期间可能重建部分目录，且启动清扫不回收（与 E5 同源）
A) 在途则拒删
  ✅ 语义与既有 `automation.deleteRun`（`automations-store.ts:548`）一致
  ❌ **已证伪**：打翻 `sessions.spec.ts:1521`/`:2563`/`:2869`；`cancelAgent`（:444-465）不等收尾也不摘 agent ⇒「先停止再删除」无可满足信号；客户端 `App.tsx:3245-3259` 会先摘掉停止按钮再 remove，被拒后用户无从操作
C) 延迟异步删
  ❌ 收尾观测点在计划禁改的 `turn-scheduler.ts` 里；不引入 tombstone 就会复活已删会话再删掉活根
Net: 要么接受一个半径受限、日志可见、文档如实描述的竞态，要么为它新造机制并打翻既有产品行为。
Header: 活跃会话删除时序
Options:
A) 在途则拒删　B) 有界等待后删　C) 延迟异步删 + tombstone　E) 立即删 + 收窄与诚实口径

State: approved
Actual answer: **E — 立即删 + 收窄与诚实口径（D5，用户 2026-11-08 裁定）**
Accepted scope: 物理清理保持在 `removeSession` 内立即执行；`rm` 失败改为写日志（不抛出）；删除条件收窄为「通过 `assertSafePathSegment` **且**带中立稳定前缀」并写成显式不变量 + 负例测试；计划与代码注释写明在途删除的残留口径。**明确不做**：收尾观测机制、tombstone、改 `turn-scheduler.ts`、改客户端删除流程、启动补扫。四条既有删除钉子必须不改一字仍绿。
History: 2026-11-07 实施评审曾记为「D3 / A（收尾后异步清理）」——编号与既有 D3 重名，且该选择经复核不成立（未评估既有先例、观测点在禁改文件、新开复活窗口），已作废。2026-11-08 复核一度推荐 A，随后被四条已核实证据证伪（见上），同日由用户裁定 E。

### R7: `session.new` 失败判定的测试形态（D6）
Finding: T1, confidence 9/10, dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:2689-2691, reviewer impl-review + 2026-11-08 独立复核
Plan baseline: 计划 Task 3 用一条精确匹配 catch 分支的长正则钉住 D2 行为，语义全部藏在正则里。
Runtime evidence: `send()` 是 `App()`（`App.tsx:508`，全文 4780 行）内部闭包，**未导出**；全仓没有任何测试渲染 `App`，唯一的 `App.tsx` 渲染先例是导出的子组件 `InputCardView`（`inputCardView.spec.ts:6`）。⇒ 实施评审原要求的「mock RPC 后驱动组件验证不发送」不可实现。`appWiring.spec.ts:30-37` 的头注释写明本仓既有形态是「驱动生产函数 + 钉住调用点」两层。
Comparison grid:

| Choice | 原计划 | F 抽取判定函数 | G 维持源码切片 |
| --- | --- | --- | --- |
| 语义有行为测试 | 否（藏在正则里） | **是** | 否 |
| 需要渲染 `App` | — | **否** | 否 |
| 新建模块 | — | **否**（落 `logic/concurrentTurn.ts`） | — |
| 生产文件计数 | 10 | 13 | 12 |

Question D6:
D6 — 铸造失败判定要不要抽出来做行为测试
ELI10: 「建目录失败就不要发消息」这条规则现在只被一条正则看着。正则匹配的是代码长什么样，不是代码做了什么。把这条判定抽成一个小函数，就能直接测它的行为。
Stakes if we pick wrong: 不抽 ⇒ 语义改动只能靠改正则发现，而正则本身没人测；抽 ⇒ 多改一个文件，且要重写计划里那条长正则。
Recommendation: F。抽取成本是一个既有文件里加一个纯函数，而收益是这条安全相关分支第一次有行为级覆盖；`App.tsx:174` 已从 `logic/concurrentTurn.ts` 导入，不新建模块。
Completeness: F=9/10, G=5/10
Pros / cons:
F) 抽取判定函数 (recommended)
  ✅ 语义进 `sessionMintFailureNote`，由 `concurrentTurn.spec.ts` 行为级验证（中立标签显示真实错误、项目标签显示既有那句、非 Error 值也能可见）
  ✅ `App.tsx` 的 catch 变得更简单（无分支），且对项目标签**行为等价**
  ✅ 接线钉缩小为「catch 调用了它 + `return` 在 `session.send` 与 `setDraft` 之前」，不再承载语义
  ❌ 生产文件 +1；计划 Task 3 Step 1.3 的长正则必须重写
G) 维持源码切片断言
  ✅ 不改文件清单
  ❌ 语义无行为覆盖；正则一改就静默失守
Net: 要么让这条安全分支第一次可测，要么继续只钉代码形状。
Header: 铸造失败判定测试形态
Options:
F) 抽取到 `logic/concurrentTurn.ts` 后做行为测试　G) 维持源码切片断言

State: approved
Actual answer: **F — 抽取判定函数做行为测试（D6，用户 2026-11-08 裁定）**
Accepted scope: 新增导出纯函数 `sessionMintFailureNote(input: { error: unknown; tabProjectId: string | null | undefined }): string` 于 `logic/concurrentTurn.ts`；`App.tsx:2689-2691` 的空 catch 改为调用它 + `noteActive` + `return`；`:2695-2698` 的既有守卫**保留不动**（它还负责「铸造成功但应答没带 sessionId」这条不抛错路径）；行为测试落 `concurrentTurn.spec.ts`，接线钉留 `appWiring.spec.ts`。**诚实边界**：只有「显示哪一句」是行为级验证的，「不调用 `session.send`」与「草稿留存」仍只由接线层的顺序断言保证 —— 不引入渲染整个 `App` 的先例，也不得声称做到了渲染级验证。
History: 实施评审原把 T1 写成「行为级验证，seam=mock RPC」，2026-11-08 复核证明该 seam 不存在并退回待裁定，同日由用户裁定 F。

Approval readiness: PASS
Checked: D1 A 文件安排；R5 D2 A；R1 D3 A；R2 D4 B；R4 事实订正；R3 事实订正（Task 4 改写旧测试）；**R6 D5 E（2026-11-08）；R7 D6 F（2026-11-08）**。重复 id 拒绝和过期注释跟这些已批准行为一起改，没有单独再问。B1（`AutomationPatch.projectId`）、B4（未使用导入）、B3（回滚收窄，P2）、E5（孤儿目录）是实施评审的事实订正与加固项，已并入对应任务，不单列裁定。

## Architecture review

Dispositions: R5 接受 D2 A；R1 接受 D3 A；R2 接受 D4 B。

[CRITICAL] (confidence: 9/10) dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:2689 — `session.new` 抛错时中立标签仍会 `session.send`。空 catch 把 sessionId 清空（:2689-2691），只有 `projectId != null` 才停发（:2695-2697），发送在 :2729。服务端缺省 id 用前台稳定会话（sessions.ts:936）。计划新增的 `mkdirSync` 让这次抛错变得可达。已按 D2 A 写入 Task 3。

[CRITICAL] (confidence: 8/10) dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts:38-41 — 项目稳定前缀先于中立会话分支。workspace 被登记成项目时，`freshSessionIdFor(neutralRoot)` 的 id 会被判成那个项目，而 `sessionNew` 仍返回 `workspace-sessions/<id>`。第一次发送没有已登记根（sessions.ts:947-953），界面却记住铸造 cwd（App.tsx:692-695）。已按 D3 A 写进 Task 2 的函数体，规格 §3.2.3 步骤 2 有同一例外。

[CRITICAL] (confidence: 8/10) 原设计要求中立前缀的其余情况继续步骤 4–5。现有测试要求 `${neutralStable}-abc12345` 在 cwd 位于项目内时仍返回中立根（writable-root.spec.ts:148-155）。已按 D4 B 改规格：这类会话返回 workspace，步骤 4–5 只处理不带中立前缀的会话。Task 2 的函数在中立前缀分支末尾直接返回 workspace。

```text
<profileDir>/
├── workspace/                  work-1 与升级前 cwd 在这棵树里的存量会话
├── workspace-sessions/<id>/    fresh 中立会话
├── workspace-projects/<id>/    自动创建的项目
└── workspace-automations/<id>/ 存量 projectId null，以及已删项目的准入键
```

`path.relative` 下，`workspace-sessions` 相对 `workspace` 是 `../workspace-sessions/...`，`isInside` 为 false。`workspace/sessions` 才会落在里面。这是现有 `writable-root.ts:77-79` 的规则，不是新库。

一条新路径的生产失败：目录创建失败。会话铸造失败现在对用户可见并且不发送。自动化建目录失败进入现有失败收口，不把 `lastStatus` 留在 `running`。

## Code quality review

Dispositions: 三处都是事实订正，已写入计划，没有另问。

[INFORMATIONAL] (confidence: 8/10) dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:576 — `neutralAutomationRoot` 若放在内层 try 外面，`markAutomation` 已经写成 `running`，抛错会跳过 `finishAutomation`。已要求放进 :604 起的内层 try。

[INFORMATIONAL] (confidence: 8/10) dsh-plugin-huaanwork/src/huaanwork-host/stores.ts:77 — 计划让 `createProject` 接受调用方 id，原片段不查重。同一 id 会写出两条项目。已补「id 已存在就抛错」，并要求测试覆盖第二次创建。

[INFORMATIONAL] (confidence: 8/10) dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:74 — 「创建后不可改」和 `writable-root.ts` 顶部「不读盘、不再看 cwd」会在实现后变成假注释。计划已要求改这两句。

共享代码：`isInside` 已经在 `writable-root.ts`、`sessions.ts`、`sandbox-cwd.ts` 各有一份。这次继续用本地那份。不抽新的公共函数。三份的调用方不在同一次部署边界里合并，抽出去不会少掉失败模式。

## Test review

> 2026-11-08 按实施评审修订：原图把 D2 记作「源码断言即可」、把回滚记作「上限预检已覆盖」、把删除记作「清掉 sibling 即可」，三处都经复核不成立。下图为修订后的覆盖形态。

```text
CODE PATHS                                              USER FLOWS
[+] writableRootForSession                              [+] 新建中立对话
  ├── [PLAN Task 2] 已铸造目录，未知 id 不建目录           ├── [PLAN Task 3] 两个 fresh 会话同时 started
  ├── [PLAN Task 2][D3] workspace 项目不抢走已铸造会话     ├── [PLAN Task 3][D2+D6=F] 铸造失败显示正确那句且不发送
  ├── [★★ TESTED] 中立前缀 cwd 在项目里仍留 workspace      └── [PLAN Task 8 Step 6] 真实双标签走查（T7）
  │     writable-root.spec.ts:148-155  [D4 保留]
  └── [PLAN Task 2] 非法路径分量抛错
[+] sessionNew / removeSession                          [+] 删除独立会话
  ├── [PLAN Task 3] fresh 返回 sibling 并建目录            ├── [PLAN Task 3] 静态会话删除
  ├── [PLAN Task 3][T2] 误删共享根/项目根的负例            ├── [★★ TESTED] 在途/活跃删除 4 条既有钉子
  ├── [PLAN Task 3][T2] rm 失败写日志不抛出                │     sessions.spec.ts:1521/:2240/:2563/:2869
  └── [ACCEPTED D5=E] 在途删除时该轮工具写可能失败          └── [ACCEPTED D5=E] 子代理可能重建部分目录（E5 同源）
[+] sessionMintFailureNote（D6 = F 抽出）                [+] 自动化
  ├── [PLAN Task 3][T1] 行为层：三种归属各显示哪一句        ├── [PLAN Task 6] projectId null 建同名项目
  └── [PLAN Task 3][T1] 接线层：catch 调用它且先 return     ├── [PLAN Task 6][T3] 真实回滚（automations.json.tmp 目录化）
[+] autoProjectRollbackAction（B3 抽出）                  ├── [PLAN Task 6][T4] createProject 失败清理 + 路由级 keep/补偿
  ├── [PLAN Task 4] 纯函数：空+无引用⇒remove，其余⇒keep    ├── [PLAN Task 6][T6] 当前轮旧根、下一轮新根、旧目录不搬
  └── [PLAN Task 6] 路由级：非空/引用/读取失败保留，登记失败恢复空根
[+] automationAdmissionRoot / executeRun                 ├── [PLAN Task 7] 编辑改绑，运行中禁用
  ├── [PLAN Task 5] 已删项目不建空目录                     └── [PLAN Task 7] onChanged 刷新项目列表
  ├── [PLAN Task 5] mkdir 在内层 try
  ├── [PLAN Task 5][T5] 同名文件 + startAutomation ⇒ 记失败并释放准入
  └── [PLAN Task 5][B4] 旧导入被替换，无未使用导入
[+] pinnedCwd                                           [+] 清扫
  └── [PLAN Task 1] 兄弟目录夹回各自的根                   └── [PLAN Task 3] 保护三个中立根，清扫自动项目下游离会话

COVERAGE: 现有可保留 5 条（writable-root 的 D4 钉子 + sessions 的四条删除钉子）；其余新行为由计划里的测试接住
GAPS: 0 阻断。D5=E 的在途删除风险已裁定接受。改绑的 check-then-act 窗口仍存在且不被承诺消除，但「已准入轮次冻结旧根」已由 T6 明确测试；T7 真机走查是完成标准，不是可选观察项。
```

Value: protects=中立标签在 session.new 失败时不调用 session.send 且显示正确那句; fails_when=空 catch 仍继续发送，或两种归属显示同一句; why_new=现有客户端测试没有这条失败分支，且语义原先全藏在一条正则里; seam=抽取到 logic/concurrentTurn.ts 的 sessionMintFailureNote（行为层 concurrentTurn.spec.ts + 接线层 appWiring.spec.ts，即该文件 :30-37 头注释的既有两层形态）; no_claim=不证明真实磁盘满；「不发送」与「草稿留存」仍只由接线层顺序断言保证，不是渲染级验证

Value: protects=自动项目回滚不删非空或已复用现场，且已知失败路径保留登记/目录一致性; fails_when=使用 recursive rm、引用读取失败被当成无引用，或登记删除失败后不恢复空根; why_new=纯函数不驱动路由副作用，上限预检也进不了回滚; seam=withAutomationRegistryLock + vi.waitFor + 真实文件系统; no_claim=不证明跨文件事务或消除全部并发窗口

Value: protects=自动化已准入轮次保持旧根，下一轮才用新根; fails_when=执行体中途重读 projectId 或改绑不生效; why_new=只测下一准入覆盖不到当前轮; seam=startAutomation + holdCommand + store 层 updateAutomation; no_claim=不消除路由 check-then-act 窗口，路由在途拒绝由另一条用例验证

没有要退役的测试。D4 保留 `the neutral stable id stays neutral even when the logged cwd is inside a project`；D5 = E 保留 `sessions.spec.ts` 的四条删除钉子（`:1521`/`:2240`/`:2563`/`:2869`）**一字不改**。唯一需要改写的是 `automations-store.spec.ts:581` 的 `issue #2: updateAutomation ignores projectId — binding is immutable after creation`（Task 4 已写明改写后的期望），以及 `automation-scheduler.spec.ts:501` 的测试名（Task 5 Step 4）。

## Performance review

没有问题。中立前缀推导多一次 `existsSync` 加 `statSync`，每次发送一次，本地目录，没有按目录条目循环。注册表锁是进程内 Promise 链，和现有任务锁同一形状。规模未知的部分只有「一个 profile 里有多少中立会话」，不构成新的热路径。

## NOT in scope

- 不改 `TurnScheduler` 的单写者原语，也不把 `work-1` 迁走。设计评审第四节已经排除。
- 不把 `isInside` 改成 `realpath`。现有沙箱是词法比较。符号链接逃逸是旧界限，这次不扩大。
- 不把 `projects.json` 改成临时文件加 rename。现有写法和任务注册表一样，设计接受崩溃窗口留下空项目。
- **不回收孤儿目录（E5，实施评审 2026-11-08 复核新增，已裁定接受累积）**：`<profileDir>/workspace-automations/<automationId>` 在 `automation.remove` 之后不会被删除（该路由只删运行**会话日志**，见 `routes.ts:1177-1178`），`<profileDir>/workspace-projects/<projectId>` 在 `project.remove` 之后按设计 §2/§4-6 明确保留。两者也都不在启动清扫的遍历范围内（清扫只走**已登记**项目根，且 `neutralAutomationsBaseDir` 被列进 `protectedRoots`）。因此这两个命名空间会随 profile 生命周期累积，没有 UI 入口也没有后台任务会让它们消失。
  - **处置依据**：设计对自动项目已经裁定「保留磁盘目录，避免误删用户在该项目下产生的文件或子任务」（§4 场景 6/7）。`workspace-automations/<id>` 里同样是自动化自己产出的文件，按同一条裁定类推保留，**不是**新做的产品决定。
  - **必须如实写进用户文档或本计划的已知限制**，不得默认用户知道。若将来要回收，需要单独裁定「自动化产物算不算用户数据」，届时再决定是随 `automation.remove` 删、还是提供一个显式的清理入口。
- **只给直接 `session.remove` 增加独立会话根清理，不扩展级联删除链**：`project.remove` 走 `removeSessionFilesById`，`automation.remove` 走 `removeAutomation`，都不经过本任务修改的 `removeSession`。若这些级联路径只删会话日志，对应 `workspace-sessions/<id>` 目录仍可能残留；本计划不宣称级联删除会物理清根，也不借此新增级联递归删目录。
- **不做「在途则拒删」与「延迟异步清理」（D5 的 A/C 方案，均已证伪）**：见 Decision ledger R6。任何要求改写 `sessions.spec.ts:1521`/`:2240`/`:2563`/`:2869` 四条既有删除钉子的方案都不得重新提出。
- **不引入渲染整个 `App` 的测试先例（D6 = F 的边界）**：需要行为级覆盖的判定一律抽成 `logic/` 下的导出纯函数。

## What already exists

- `neutralWorkspaceRootPath` 与 `isInside` 已经在 `workspace-state.ts`、`writable-root.ts`。新的兄弟路径函数放在同一文件。
- `withTaskRegistryLock` 与 `withAutomationRegistryLock` 已经在 `stores.ts`。项目锁照抄，不引入新的锁库。
- `executeRun` 已经在跑模型或脚本之前对已删项目记 `MISSING_PROJECT_OUTPUT`。
- 打开另一个项目根今天会走重启。自动项目出现在侧栏，不表示点开它能热切换。这是现有 `workspace` 行为，计划没有改它。

## Failure modes

- 会话目录创建失败：D2 显示错误且不发送；D6 = F 后由 `sessionMintFailureNote` 决定显示哪一句（中立标签=真实错误，项目标签=既有那句）。有行为层测试（`concurrentTurn.spec.ts`）+ 接线钉（`appWiring.spec.ts`）。用户看得到，草稿留存。
- workspace 被登记成项目：D3 让已铸造目录胜出。有计划中的 writable-root 测试。不会一边记新目录、一边写共享目录。
- 中立前缀会话的 cwd 在别的项目：D4 留在 workspace，现有恢复拒绝仍然出现。有现有测试。用户看到「该会话属于其他工作区」。
- 存量自动化建目录失败：放进内层 try 后记失败并释放锁。**T5 用同路径文件冲突制造真实的 `mkdirSync` 失败来覆盖这条**，不另做注入缝。不是静默留在 running。
- 建项目成功、写自动化表失败：回滚覆盖 `mkdir → createProject → createAutomation` 整段（B3）。先非递归 `rmdir` 空根，再摘项目登记；目录/引用不可读、目录非空或已有引用时**登记与目录一并保留并写日志**。登记删除失败会尝试恢复刚删的空根；恢复失败也写日志。进程崩溃仍可能留下空项目，不声称跨文件事务。
- **删除活跃独立会话（D5 = E，已接受的受限风险）**：物理目录在写者仍活跃时被删，该轮剩余工具写可能 ENOENT 失败；子代理收尾期间可能重建部分目录。爆炸半径限于该会话**自己**的兄弟根（设计 §3.1 双向夹紧），受损的只有用户刚亲手删掉的那一轮。`rm` 失败会写日志，不再静默。**重建部分可能残留，本计划没有回收路径** —— 见 NOT in scope 的 E5 条。**不得**声称删除会等收尾完成。
- **已删会话被陈旧标签再次发送**：立即删 ⇒ `existsSync(mintedRoot)` 为假 ⇒ 推导回落中立根（fail-closed）。这是 E 相对 C 的一项优势：C 需要 tombstone 才能达到同样效果。
- 改绑与准入的 check-then-act 窗口：已准入轮次继续用冻结的旧根，下一轮起用新根。窗口**不被消除**，只在注释与文档里如实描述。

Failure modes: 0 critical gaps flagged（D5 = E 的在途删除竞态为**已裁定接受**的受限风险，非未处置缺口）

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship.

> **命名冲突警告（2026-11-08）**：本节的 `T1`–`T5` 是 **plan-eng-review 自己的实施任务**，与[实施就绪评审](./2026-11-07-neutral-subroots-and-automation-projects-implementation-review.md) §5 的 **T1–T7 测试覆盖缺口**是两套完全不同的编号。引用时必须写明来源（例如「实施评审 T3」= 真实回滚覆盖），否则会指错东西。本节 T1–T5 的内容已全部并入上面 Task 1–8，保留只为审计轨迹；实施评审的 T1–T7 落点见下表。

| 实施评审编号 | 落点 |
| --- | --- |
| T1（铸造失败行为测试，D6 = F） | Task 3 Step 1.3/1.4 + Step 3.3/3.4 |
| T2（独立根删除边界与失败日志） | Task 3 Step 1.5 + Step 3.1 |
| T3（真实回滚路径） | Task 6 Step 1.3 |
| T4（`createProject` 失败清理 + 路由级非空/引用/读取/登记删除失败保护） | Task 4 Step 1.1（纯函数）+ Task 6 Step 1.4/1.5（路由级） |
| T5（建目录失败进入失败收口） | Task 5 Step 1.3 |
| T6（已准入轮次旧根 + 下一次准入/运行新根） | Task 6 Step 1.6 |
| T7（真实界面走查） | Task 8 Step 6 |

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — App.tsx — session.new 失败时中立标签不发送
  - Surfaced by: Architecture — App.tsx:2689 空 catch
  - Files: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`, `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`
  - Verify: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts`
  - **2026-11-08 订正**：按 D6 = F，本条已扩为「抽取 `sessionMintFailureNote` 到 `logic/concurrentTurn.ts` + 行为层与接线层两层测试」，落 Task 3。
- [ ] **T2 (P1, human: ~2h / CC: ~15min)** — writable-root — workspace 项目不抢走已铸造会话
  - Surfaced by: Architecture — writable-root.ts:38-41
  - Files: `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts`, `dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts`
  - Verify: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/writable-root.spec.ts`
- [ ] **T3 (P2, human: ~15min / CC: ~5min)** — writable-root — 写明不执行设计步骤 4–5，并改文件头注释
  - Surfaced by: Architecture — design.md:176 与 writable-root.spec.ts:148-155
  - Files: `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts`
  - Verify: 现有 `the neutral stable id stays neutral` 仍然通过
- [ ] **T4 (P1, human: ~30min / CC: ~10min)** — automations-host — 建目录放进内层 try
  - Surfaced by: Code quality — automations-host.ts:576
  - Files: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`
  - Verify: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-host.spec.ts`
  - **2026-11-08 补充**：同一文件还要修 B4（`:29` 的 `neutralWorkspaceRoot` 导入必须替换掉而非并存），否则 `noUnusedLocals` 让 typecheck 红。
- [ ] **T5 (P2, human: ~30min / CC: ~10min)** — stores — 拒绝重复项目 id，并改掉过期注释
  - Surfaced by: Code quality — stores.ts:77 与 automations-store.ts:74
  - Files: `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts`, `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts`, `dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts`
  - Verify: `corepack yarn --cwd dsh-plugin-huaanwork vitest run tests/huaanwork-host/stores.spec.ts tests/huaanwork-host/automations-store.spec.ts`
  - **2026-11-08 补充**：同一文件还要加 B3 的 `autoProjectRollbackAction` 纯函数及其单测。
- [ ] **T6 (P1, 2026-11-08 新增)** — 客户端类型 — `AutomationPatch.projectId`（B1）
  - Surfaced by: 实施评审 B1，CRITICAL，confidence 10/10
  - Files: `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts`, `rpc-types.ts`, `AutomationsView.tsx`
  - Verify: `corepack yarn typecheck`
- [ ] **T7 (P2, 2026-11-08 新增)** — 文档同步 — 三处过期注释、一个测试名、E5 与 D5 = E 的诚实口径
  - Surfaced by: 实施评审 §6 与 §9
  - Files: `logic/projects.ts:21`, `rpc-types.ts:268-269`, `AutomationsView.tsx:867`, `automation-scheduler.spec.ts:501`, 本计划 NOT in scope / Failure modes
  - Verify: Task 8 Step 4 的文本核对

假设：这些是带回归测试的行为修复，人机时间比按大约 20 倍估计，T3 更接近注释，按研究类收短。

## Unresolved decisions

无。D1、D2、D3、D4、**D5（= E）、D6（= F）** 都有选择。R3 与 R4 是事实订正。B1/B3/B4/E5 是实施评审的事实订正与加固项，已并入对应任务，不含未决取舍。

## Completion summary

- Step 0: Scope Challenge — scope accepted as-is（2026-11-08：生产文件计数由 10 订正为 13，未新建模块）
- Reality rows: 首轮 8/8；最终对抗性复核 7/7 applicable rows emitted (`PLAN_REALITY: phase=eng rows=7/7 verdict=complete`), 0 unverified premises
- Architecture Review: 首轮问题均已修正；最终复审没有剩余架构阻断
- Code Quality Review: 导入、类型、helper、回滚失败处理与文档口径均已修正
- Test Review: diagram produced；T4 含真实路由 keep/补偿，T6 含当前轮旧根与下一轮新根；check-then-act 窗口仍诚实保留但不等于缺少冻结根测试；T7 真机走查列为完成标准
- Performance Review: 0 blocking issues；1 项无界累积（E5 孤儿目录，已接受并写进 NOT in scope）
- NOT in scope: written（含 E5、级联删除边界与 D5 的 A/C 方案证伪记录）
- What already exists: written
- TODOS.md updates: 0 items proposed
- Failure modes: 0 remaining critical plan gaps；实施后的运行验收不预先标记通过
- Unresolved decisions: 0（D1–D6 全部有选择）
- Adversarial review: Momus OKAY；原生 Plan 首轮 4 项已修复，跟进 Plan **PASS**
- Outside voice: codex unavailable；最终限时 Plan fallback 也未在五分钟内完成。上述同步 Momus/Plan 复核是原生评审，不构成外部模型覆盖
- Parallelization: 1 lane, 0 parallel / 1 sequential
- Lake Score: 2/6（沿用既有评分；第二轮没有新增评分问题）

Sequential implementation, no parallelization opportunity.

**2026-11-08 第二轮修订自查**：D5=E、D6=F、B1、B4 的第一轮落点保持不变；Task 2 合并既有导入，Task 4 改用 `expect`，Task 6 从 `rpc-types.ts` 导入 `ProjectInfo`；T5/T6 全部改用真实 `scriptTask` / `startAutomation` / `holdCommand`；回滚用非递归 `rmdir` + 登记失败恢复，并由 Task 6 Step 1.5 覆盖路由级非空、并发引用、读取失败和登记删除失败；T6 在 Step 1.6 同时覆盖当前轮与下一轮；chmod 测试 skip Windows，UI mount 可注入项目。E5 明确不回收，direct 与级联删除边界已写明。评审真正撤回的只有 **§6 原第 4/7 条**；第 6 条测试改名仍在 Task 5 Step 4，T2 的错误前提与 D5 的 A/C 方案未据以修改计划。

## Suppressed findings

无置信度 4 以下的条目。符号链接不在这次范围里，写在 NOT in scope。

REALITY: premise-table pass unverified=0 false=0 中立前缀今天回到 workspace dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts:47-48；无项目自动化准入用中立根 dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:195-200；调度器按路径字符串互斥 dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts:119-124；Task 4 已改为改写旧的不可改测试 docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md:523
REALITY: already-done pass origin/master fdcf80422e 自 2026-11-07 起计划点名的宿主文件无新提交，且没有 workspace-sessions、neutralSessionRoot、withProjectRegistryLock
REALITY: surface-check pass 无新 CLI；vitest 对应 dsh-plugin-huaanwork/package.json:189；根 typecheck 与 test 在 package.json:755-756；automation.create 与 automation.update 已在 dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:1132-1153
REALITY: binding-decisions pass gstack-decision-search 本分支无在先裁定；设计要求三类新根与 workspace 平级 docs/superpowers/specs/2026-11-07-neutral-subroots-and-automation-projects-design.md:39；计划平级目录铁律遵守同一句 docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md:21
REALITY: numbers pass MAX_AUTOMATIONS 为 50 [measured: dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:38]；max_concurrent_turns 缺省 3 [measured: dsh-plugin-huaanwork/src/huaanwork-host/settings.ts:49]，夹紧到 1 至 8 [measured: dsh-plugin-huaanwork/src/huaanwork-host/settings.ts:102-107]；会话 id 为 16 位十六进制加 8 位 [measured: dsh-plugin-huaanwork/src/huaanwork-host/session-id.ts:6-11]；计划文件表原有 10 个生产文件，2026-11-08 按实施评审补入 logic/projects.ts、logic/concurrentTurn.ts、rpc-types.ts 后为 **13** 个 [counted: docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md File Structure 表]
REALITY: impl-review pass 实施评审基线实跑复现 [measured: 2026-11-08 重跑 A 组 5 文件/180 通过/exit 0，B 组 7 文件/198 通过/exit 0，合计 378]；`noUnusedLocals` 为 true [measured: dsh-plugin-huaanwork/tsconfig.json:22]，include 覆盖 src/huaanwork-host/**/*.ts [measured: dsh-plugin-huaanwork/tsconfig.json:30-35]；`neutralWorkspaceRoot` 在 automations-host.ts 的唯一使用点是 :200 [measured: dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:29,200]；四条既有删除钉子 [measured: dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts:1521,2240,2563,2869]；`send()` 未导出且全仓无渲染 App 的测试 [measured: dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:508；tests/client-huaanwork/inputCardView.spec.ts:6 只渲染 InputCardView]；automations.json.tmp 目录化的故障注入先例 [measured: dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts:1160-1173]；chmodSync 故障注入先例 [measured: 同文件 :1117,:1139]
REALITY: deferred-asks pass 计划没有链接 issue；不改 TurnScheduler、不迁移 work-1 写在设计评审范围外 docs/superpowers/specs/2026-11-07-neutral-subroots-and-automation-projects-design-review.md:108
REALITY: pr-count pass 无 .gstack/ship-policy.json，默认一波一个 PR；本计划没有提议拆分 docs/superpowers/plans/2026-11-07-neutral-subroots-and-automation-projects.md:1；基线 fdcf80422e

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex / plan-eng-review | Independent 2nd opinion | 4 | unavailable | Codex 未安装；限时原生 fallback 未形成完整报告 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR | 最终修订后复审 0 issues / 0 critical gaps |
| **Implementation-Readiness Review** | double-check + Momus/Plan adversarial review | 实施前门禁（[评审文档](./2026-11-07-neutral-subroots-and-automation-projects-implementation-review.md)） | 3 | **PASS** | B1/B4、D5=E、D6=F、B3、T1–T7、E5 与第二轮片段问题均已关闭 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

OUTSIDE COVERAGE: codex, phase plan-review, unavailable. 没有外部完成的第二意见；同步完成的 Momus OKAY 与 Plan PASS 是原生评审，不记作外部覆盖。
VERDICT: ENG + IMPLEMENTATION READINESS CLEARED — ready to implement；实施后的 typecheck、Vitest 与 T7 仍须实际执行
NO UNRESOLVED DECISIONS

