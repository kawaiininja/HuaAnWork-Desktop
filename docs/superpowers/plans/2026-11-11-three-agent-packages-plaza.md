# 三个智能体包与广场接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 typo-check / code-review / task-orch 三个完全 LLM 化的智能体包经 M2 签名链路接入智能体广场，并为此完成「包允许 subagent 派发 + 孙代工具收窄继承」运行时扩展。

**Architecture:** 运行时扩展只改 huaanwork 自有五个文件（C1 允许名单、C2 血缘 holder、C3 绑定/清理、C4 孙代收窄、C5 执行期强制），不改上游子模块与 manifest schema。三个包源文件落 `dsh-plugin-huaanwork/agent-packages/{slug}/`，规则全部内联 SKILL.md；播种脚本写入隔离 profile，验证脚本走「隔离 catalog + 一次性开发密钥 + admin CLI 签名 + 广场卡断言 + 安装验签」，真机走查用 CDP 驱动最新构建。原目录备份并经 owner 再次确认后删除。

**Tech Stack:** TypeScript（Cordis host/client）、vitest、Node `--experimental-transform-types` 脚本（M2 验收先例）、Ed25519 签名（`@huaanwork/catalog-signing`）、Electron + CDP 真机走查。

**Spec:** `docs/superpowers/specs/2026-11-11-three-agent-packages-plaza-design.md`（已获 owner 批准，commit cbfbba993a）

## Global Constraints

- C1–C5 是**一个安全单元**：Task 1–4 必须全部完成并通过独立评审（Task 11）后才可合并/发布；只加 `subagent` 不做继承 = 沙箱绕过（spec §4.1 第 4 条）。
- `deepseek-harness/` 子模块零修改；manifest schema、admin CLI、catalog server 代码、广场卡 schema、`agent-catalog-server/tests/fixtures/entries/` 三份 kind:"tool" fixture 均不改。
- 开发密钥每运行一次性生成，**绝不提交私钥**；生产签名只用 owner 真实密钥，本计划不生成、不持有、不提交任何生产私钥。
- 任何输出（日志/报告/截图）不得打印 token、api_key、私钥；脚本一律经 `scripts/huaanwork-acceptance-redaction.mjs` 脱敏。
- 验收只用隔离临时 profile，**绝不触碰生产 profile**；生产模型设置只读复制（`~/.huaanwork/profiles/desktop/huaanwork-settings.json`），绝不打印 api_key。
- 绝不自动 kill 正在运行的应用实例；真机脚本只清理自己启动的进程。
- 中文 displayName/description 逐字取自 spec §5.1–5.3；@ 派发只用 slug（`@typo-check`/`@code-review`/`@task-orch`），dispatch 正则不认中文。
- 只提交本任务文件；工作树存在无关改动（README、package.json、update-server fixture 等），一律不碰。git 命令一律在仓库根执行。
- Windows 无第二台真机 ⇒ 真机项记 BLOCKED（R-ACCEPT-1 豁免先例），不声称跨机器通过；pwsh 提取与 win32 allow 形态做单元测试。
- 诚实记录：CI 绿 ≠ 真机；BLOCKED 项如实登记；`verify:aa` 并发竞态为已登记既有 flaky，失败时隔离重跑并记录。
- **能力披露口径订正（spec §5.0/§7.3 措辞与 UI 现实的差异，实施按本条执行）**：签名广场包**没有**安装/启用确认对话框——安装 = 广场卡直接「下载」按钮，启用 = 我的智能体页直接「启用」开关。实际披露面是**详情对话框**：未安装卡只显示包信息 + `INSTALL_DETAIL_NOTICE`（"安装后可查看签名与文件清单"）；已安装卡显示发布状态/签名（keyId/签名时间/槽位/验签结果：通过）/人设/技能/工具（`tools.mode:"none"` ⇒ "无"）/文件 digest 清单 + `PACKAGE_SANDBOX_WARNING`（"脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。"）。验证断言按此真实形态写，**不伪造对话框测试**；此订正记入证据文档。
- **嵌套 lane 无运行卡**：孙代 subagent 没有 Host runId，不产生 `.subagent-run-card`；真机走查观测 lane 数量经 zstd 会话日志的 subagent tool/call 计数，不靠运行卡。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts` | C1：允许名单基础集加 `subagent` |
| `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts` | C2：`huaanworkPackageChildAllow` holder 声明+props+初始化 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts` | C3：bindChild 写血缘表、releaseChildBindings 按引用清理 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts` | C4：start/startActivation 孙代收窄+传递绑定 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts` | C5：pre-execute/guard 血缘越权拒绝 |
| `dsh-plugin-huaanwork/agent-packages/{typo-check,code-review,task-orch}/{agent.json,persona.md,skill/SKILL.md}` | 三包源文件（规则内联） |
| `dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs` | 播种：源文件 → 隔离 profile（store API） |
| `dsh-plugin-huaanwork/scripts/verify-agent-packages-plaza.mjs` | 发布验证：409 负例 + 签名链路 + 广场断言 + 安装验签 |
| `dsh-plugin-huaanwork/scripts/huaanwork-accept-three-packages.mjs` | 真机走查：CDP 驱动广场/安装/启用/三包对话 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts` | C1 既有测试扩展 + C3 派发血缘测试 |
| `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts` | C4 八项矩阵（新文件） |
| `dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts` | C5 执行期强制测试 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-sources.spec.ts` | 三包 manifest/预算/内容钉（新文件） |
| `dsh-plugin-huaanwork/tests/huaanwork-host/seed-agent-packages.spec.ts` | 播种脚本自测（新文件） |
| `docs/evidence/2026-11-11-three-agent-packages.md` | 逐项命令/退出码/截图指针 |

---

### Task 1: C1 允许名单加 subagent

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:153-185`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts:287-308`

**Interfaces:**
- Consumes: 无（起点任务）。
- Produces: `composeAgentPackageToolAllowList(manifest, mcpNames?, skillScripts?)` 返回数组恒含 `'subagent'`（基础集，所有 mode 统一）。Task 2/3 的测试断言依赖此顺序：`['read','read_file','glob','grep',SHELL,'subagent', ...运行时工具]`。

- [ ] **Step 1: 改既有测试期望 + 写平台形态新测试（先红）**

把 `agent-package-runtime.spec.ts:289-295` 的 `toEqual` 期望数组改为：

```ts
    expect(composeAgentPackageToolAllowList(manifestWithMode('none'), [], [])).toEqual([
      'read',
      'read_file',
      'glob',
      'grep',
      SHELL,
      'subagent',
    ])
```

在同一 `describe('agent package tool allow list')` 块内追加：

```ts
  test('includes subagent for both platform shells', () => {
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(composeAgentPackageToolAllowList(manifestWithMode('none'), [], [])).toEqual([
        'read', 'read_file', 'glob', 'grep', 'bash', 'subagent',
      ])
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(composeAgentPackageToolAllowList(manifestWithMode('none'), [], [])).toEqual([
        'read', 'read_file', 'glob', 'grep', 'pwsh', 'subagent',
      ])
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts -t "allow list"`
Expected: FAIL — 期望数组含 `subagent` 但实际不含。

- [ ] **Step 3: 实现 C1**

`runtime.ts` 的 `composeAgentPackageToolAllowList` 基础 Set 改为（只加一行 `'subagent'`，其余不动）：

```ts
  const allow = new Set<string>([
    'read', 'read_file', 'glob', 'grep',
    process.platform === 'win32' ? 'pwsh' : 'bash',
    'subagent',
  ])
```

并把该函数 doc 注释中描述基础集的句子更新为含 `subagent`（harness 原生工具，孙代收窄由 skills.ts 血缘分支保证，见 spec §4.2 C1）。

- [ ] **Step 4: 跑测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts`
Expected: PASS（全文件，含既有 processes 测试）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts
git commit -m "feat(agent-package): allow subagent dispatch in package tool allow list (C1)"
```

---

### Task 2: C2 血缘 holder + C3 绑定与引用清理

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`（三处：declare ~:48、HUAANWORK_CONTEXT_PROPS ~:82、init ~:168）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`（AgentPackageDispatchContext ~:77、dispatch 闭包 ~:617、bindChild ~:727-737、releaseChildBindings ~:750-770、allow 计算 ~:992）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`（新增派发血缘测试）

**Interfaces:**
- Consumes: Task 1 的 allow 数组（含 `subagent`）。
- Produces: `ctx.huaanworkPackageChildAllow: Map<string, readonly string[]>`（会话 id → 本回合 allow 数组引用）。Task 3（skills.ts 读/写）、Task 4（policy.ts 读）依赖此 holder 名与类型。bindChild 写入的 value 与 `request.allow` 是**同一引用**；releaseChildBindings 按 `value === turnAllow` 引用同一性清理。

- [ ] **Step 1: 写派发血缘测试（先红）**

在 `agent-package-runtime.spec.ts` 的 `tracks bound child sessions...` 测试（:831-910）之后追加。fixture 写法与该测试完全一致（minimal weekly-report 包 + agents-state.json），ctx 增加 `huaanworkPackageChildAllow`：

```ts
  test('binds the turn allow reference for children and clears by reference on cleanup', async () => {
    const profileDir = makeRoot('agent-package-profile-')
    const packageDir = join(profileDir, 'agents', 'weekly-report')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, 'agent.json'),
      JSON.stringify({
        schemaVersion: 1,
        slug: 'weekly-report',
        displayName: '周报助手',
        description: '把一周工作整理成周报',
        version: '1.0.0',
        draftId: 'draft-minimal',
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
        persona: 'persona.md',
        skill: null,
        tools: { mode: 'none' },
        allowSkills: [],
      }),
      'utf8',
    )
    writeFileSync(join(packageDir, 'persona.md'), '你是周报助手。', 'utf8')
    writeFileSync(
      join(profileDir, 'agents-state.json'),
      JSON.stringify({ 'local:weekly-report': { source: 'local', enabled: true, installedVersion: '1.0.0' } }),
      'utf8',
    )

    const childSessions = new Set<string>()
    const childAllow = new Map<string, readonly string[]>()
    // 另一并发回合的条目：不同数组引用，清理绝不能误删。
    const otherTurnAllow: readonly string[] = ['read']
    childAllow.set('other-turn-child', otherTurnAllow)
    const ctx = {
      huaanworkAttachments: emptyAttachments(),
      huaanworkWorkspaceRoot: { current: makeRoot('agent-package-ws-') },
      huaanworkAgentPackageRequest: { current: null },
      huaanworkPackageChildSessions: childSessions,
      huaanworkPackageChildAllow: childAllow,
      huaanworkSubagentRuns: createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined }),
      subagents: {
        startActivation: async () => ({
          childId: 'child',
          result: Promise.resolve({}),
          dispose: async () => undefined,
        }),
      },
    }
    const host = createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      createRuntime: async (options) => ({
        slug: options.manifest.slug,
        packageDir: options.packageDir,
        workspaceRoot: options.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
      }),
    })
    const pkg = await host.findInvocable('weekly-report')
    const dispatched = await host.dispatch({
      ctx: ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    const request = ctx.huaanworkAgentPackageRequest.current as {
      childId: string
      allow: readonly string[]
      bindChild(sessionId: string): void
    } | null
    expect(request).not.toBeNull()
    expect(request!.allow).toContain('subagent')
    // 预留 id、activation 返回 id、late-bind id 都写同一引用。
    expect(childAllow.get(request!.childId)).toBe(request!.allow)
    expect(childAllow.get('child')).toBe(request!.allow)
    request!.bindChild('late-child')
    expect(childAllow.get('late-child')).toBe(request!.allow)

    await dispatched.afterIdle()
    expect(childSessions.size).toBe(0)
    expect(childAllow.has(request!.childId)).toBe(false)
    expect(childAllow.has('child')).toBe(false)
    expect(childAllow.has('late-child')).toBe(false)
    // 跨回合隔离：其他回合的条目原样保留。
    expect(childAllow.get('other-turn-child')).toBe(otherTurnAllow)
  })
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts -t "binds the turn allow reference"`
Expected: FAIL — `childAllow.get(...)` 为 undefined（holder 未接线）。

- [ ] **Step 3: 实现 C2（holders.ts 三处）**

declare module Context 内，紧跟 `huaanworkPackageChildSessions: Set<string>`（~:48）之后加：

```ts
    /** 包回合血缘允许表：会话 id → 本回合 allow 数组引用（孙代收窄继承用，C2）。 */
    huaanworkPackageChildAllow: Map<string, readonly string[]>
```

`HUAANWORK_CONTEXT_PROPS` 数组（~:68-90）在 `'huaanworkPackageChildSessions'`（~:82）之后加 `'huaanworkPackageChildAllow'`。

初始化处（~:168 `ctx.huaanworkPackageChildSessions = new Set<string>()` 之后）加：

```ts
  ctx.huaanworkPackageChildAllow = new Map<string, readonly string[]>()
```

- [ ] **Step 4: 实现 C3（host.ts 五处）**

① `AgentPackageDispatchContext`（~:70-84），在 `huaanworkPackageChildSessions?: Set<string>`（~:77）之后加：

```ts
  huaanworkPackageChildAllow?: Map<string, readonly string[]>
```

② dispatch 闭包，在 `const packageChildSessions = new Set<string>()`（~:617）之后加：

```ts
    let turnAllow: readonly string[] | undefined
```

③ `bindChild`（~:727-737），在 `packageChildSessions.add(childSessionId)` 之后、`if (runtime === undefined) return` 之前插入：

```ts
      if (turnAllow !== undefined) ctx.huaanworkPackageChildAllow?.set(childSessionId, turnAllow)
```

④ `releaseChildBindings`（~:750-770），在 `packageChildSessions.clear()` 之后追加：

```ts
    const allowTable = ctx.huaanworkPackageChildAllow
    if (allowTable !== undefined && turnAllow !== undefined) {
      for (const [childSessionId, bound] of allowTable) {
        if (bound === turnAllow) allowTable.delete(childSessionId)
      }
    }
```

⑤ allow 计算处（~:992 `const allow = composeAgentPackageToolAllowList(manifest, mcpNames, runtime.skillScripts)`）之后加：

```ts
    turnAllow = allow
```

（该赋值必须先于 ~:1009 的 `bindChild(reservedChildId)` 与 ~:1087 的 `bindChild(activationChildId)`；~:992 在两者之前，顺序天然成立。）

- [ ] **Step 5: 跑测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts`
Expected: PASS（新测试 + 既有 `tracks bound child sessions` 零改动全绿）。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts
git commit -m "feat(agent-package): track per-turn allow lineage and clear by reference (C2+C3)"
```

---

### Task 3: C4 孙代收窄与传递绑定（skills.ts）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`（Context ~:68-104、start 包装 ~:288-362、startActivation 包装 ~:364-477）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`（新文件，八项矩阵）

**Interfaces:**
- Consumes: Task 2 的 `ctx.huaanworkPackageChildAllow`（读父会话条目、写孙代同引用条目）。
- Produces: 孙代/曾孙代 `tools.restrict({ allow: 继承allow ∩ schemas })` + map 传递写入。Task 4 的 policy 强制依赖 map 条目存在。上游 restrict 组合语义已核实：`deepseek-harness/packages/core/tools/src/index.ts:1105`「Restrictions intersect; scoped registrations remain visible」，disposer 只解除本层 ⇒ 血缘层不被 present-as 的 lift/re-restrict 解除。测试 fake 用**相交层**模型镜像此语义。

- [ ] **Step 1: 写八项矩阵测试（先红）**

新建 `tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`。helper 模式取自 `skills.spec.ts`（createTools :58-76、lifecycleContext :887-901、activateOf :903-905、liveParent :907-909），但 tools fake 改为**相交层**模型（镜像上游 restrict 组合语义）：

```ts
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { resetChildSessionRegistry } from "../../src/huaanwork-host/child-sessions.ts";
import { HUAANWORK_LEGACY_AGENT_REQUEST } from "../../src/huaanwork-host/subagents-service.ts";
import { emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply as applySkills } from "../../src/huaanwork-guardrails/skills.ts";

afterEach(() => {
  resetChildSessionRegistry();
});

type Schema = { name: string };
type ToolsService = {
  schemas: () => Schema[];
  restrict: (filter: { allow: readonly string[] }) => () => void;
};
type Agent = { id: string; ctx: { get: (name: string) => ToolsService | undefined } };

const BASE_NAMES = [
  "read", "read_file", "glob", "grep", "edit", "write",
  "bash", "pwsh", "skill", "subagent", "git_push", "web_search", "call_host_tool",
] as const;

/** 相交层 fake：每层 restrict 独立生效，schemas = 全部活跃层的交集；disposer 只移除本层。 */
function createComposingTools(names: readonly string[] = BASE_NAMES) {
  const all = names.map((name) => ({ name }));
  const layers: Array<readonly string[]> = [];
  const tools = {
    layers,
    schemas(): Schema[] {
      return all.filter((schema) => layers.every((allow) => allow.includes(schema.name)));
    },
    restrict({ allow }: { allow: readonly string[] }): () => void {
      layers.push(allow);
      return () => {
        const index = layers.indexOf(allow);
        if (index >= 0) layers.splice(index, 1);
      };
    },
  };
  return tools;
}

function agentOf(id: string, tools: ReturnType<typeof createComposingTools>): Agent {
  return { id, ctx: { get: (name) => (name === "tools" ? tools : undefined) } };
}

function lifecycleContext() {
  const listeners: Record<string, Array<(info: unknown) => void>> = {};
  const ctx: Record<string, unknown> = {
    skills: { register: () => () => undefined },
    on(event: string, listener: (info: unknown) => void) {
      (listeners[event] ??= []).push(listener);
    },
  };
  return {
    ctx,
    emit(event: string, info: unknown) {
      for (const listener of listeners[event] ?? []) listener(info);
    },
  };
}

function activateOf(ctx: Record<string, unknown>): (spec: unknown) => Promise<unknown> {
  return (ctx.subagents as { startActivation(spec: unknown): Promise<unknown> }).startActivation;
}

function liveParent(sessionId: string): { session: { id: string } } {
  return { session: { id: sessionId } };
}

const PKG_ALLOW: readonly string[] = ["read", "read_file", "glob", "grep", "bash", "subagent"];

/**
 * 通用血缘 harness：pkg-child 会话已在血缘表中（模拟 C3 bindChild 写入），
 * 模型从 pkg-child 自主派 subagent（无 Host runId、无包请求、无 legacy 符号）。
 */
function lineageHarness(options?: {
  allow?: readonly string[];
  parentSessionId?: string;
  grandchildId?: string;
  greatGrandchildId?: string;
}) {
  const allow = options?.allow ?? PKG_ALLOW;
  const parentSessionId = options?.parentSessionId ?? "pkg-child";
  const grandchildId = options?.grandchildId ?? "grandchild";
  const greatGrandchildId = options?.greatGrandchildId ?? "great-grandchild";
  const { ctx, emit } = lifecycleContext();
  const childAllow = new Map<string, readonly string[]>([[parentSessionId, allow]]);
  const attachments = emptyAttachments();
  const grandchildTools = createComposingTools();
  const grandchild = agentOf(grandchildId, grandchildTools);
  const greatGrandchildTools = createComposingTools();
  const greatGrandchild = agentOf(greatGrandchildId, greatGrandchildTools);
  const agentsById = new Map<string, Agent>([
    [grandchildId, grandchild],
    [greatGrandchildId, greatGrandchild],
  ]);
  Object.assign(ctx, {
    huaanworkAttachments: attachments,
    huaanworkPackageChildAllow: childAllow,
    huaanworkPackageChildSessions: new Set([parentSessionId]),
    agents: { get: (id: string) => agentsById.get(id) },
    subagents: {
      async startActivation(spec: { childId?: string }) {
        const id = spec.childId ?? grandchildId;
        emit("subagent/start", { provider: "spawn", id, local: true });
        return {
          childId: id,
          localAgent: agentsById.get(id),
          result: new Promise(() => undefined),
          dispose: async () => undefined,
        };
      },
      async start(_name: unknown, request: { parent?: unknown }) {
        const parentId = (request?.parent as { session?: { id?: string } })?.session?.id;
        const id = parentId === parentSessionId ? grandchildId : greatGrandchildId;
        return { localAgent: agentsById.get(id), result: Promise.resolve({}) };
      },
    },
  });
  applySkills(ctx as never);
  return {
    ctx, emit, childAllow, attachments, allow, agentsById,
    parentSessionId, grandchildId, greatGrandchildId,
    grandchildTools, greatGrandchildTools, grandchild, greatGrandchild,
  };
}

function activationSpec(childId: string, parentSessionId: string) {
  return {
    provider: "spawn",
    label: "lane",
    childId,
    request: { prompt: [], parent: liveParent(parentSessionId) },
    delivery: "parent",
  };
}

// 矩阵 2：孙代 schemas 收窄为 继承allow ∩ schemas；不挂包运行时附件。
test("grandchild schemas narrow to inherited allow intersected with its tool table", async () => {
  const h = lineageHarness();
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "read_file", "glob", "grep", "bash", "subagent"]);
  assert.equal(names.includes("write"), false);
  assert.equal(names.includes("call_host_tool"), false);
  // 孙代不挂包运行时附件（v1）：附件表里只有父会话，没有孙代条目。
  assert.equal(h.attachments.sessionAgentTools.has(h.grandchildId), false);
  // 传递绑定：孙代条目与父条目同一引用。
  assert.equal(h.childAllow.get(h.grandchildId), h.allow);
});

// 矩阵 3：传递性——曾孙代同样收窄。
test("great-grandchild inherits the same narrowing transitively", async () => {
  const h = lineageHarness();
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  await activateOf(h.ctx)(activationSpec(h.greatGrandchildId, h.grandchildId));
  const names = h.greatGrandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "read_file", "glob", "grep", "bash", "subagent"]);
  assert.equal(h.childAllow.get(h.greatGrandchildId), h.allow);
});

// 矩阵 7（基线）：无血缘条目的主会话 subagent 行为零变化。
test("a session without a lineage entry keeps its baseline tools", async () => {
  const h = lineageHarness();
  h.childAllow.clear();
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, [...BASE_NAMES]);
  assert.equal(h.childAllow.has(h.grandchildId), false);
});

// 矩阵 7（legacy）：legacy 符号在场时不走血缘分支。
test("legacy activation skips the lineage branch", async () => {
  const h = lineageHarness();
  const spec = {
    ...activationSpec(h.grandchildId, h.parentSessionId),
    [HUAANWORK_LEGACY_AGENT_REQUEST]: { allow: ["read"], persona: "legacy" },
  };
  await activateOf(h.ctx)(spec);
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read"]);
  assert.equal(h.childAllow.has(h.grandchildId), false);
});

// 矩阵 5（包优先）：包请求命中时走既有 pkg 分支，不写血缘 map（bindChild 负责）。
test("a matching package request takes precedence over the lineage branch", async () => {
  const h = lineageHarness();
  let bindCalls: string[] = [];
  const pkg = {
    runId: "run-1",
    allow: ["read", "glob"],
    persona: "包人设",
    runtime: { slug: "pkg", packageDir: "/tmp/pkg", workspaceRoot: "/tmp", skillScripts: [], runSkillScript: async () => ({ text: "" }) },
    parentSessionId: h.parentSessionId,
    childId: h.grandchildId,
    bindChild: (id: string) => { bindCalls.push(id); },
  };
  (h.ctx as Record<string, unknown>).huaanworkAgentPackageRequest = { current: pkg };
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  assert.deepEqual(bindCalls, [h.grandchildId]);
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "glob"]);
  // 血缘 map 不被 C4 写入（pkg 分支的绑定由 host bindChild 负责，fake 里只记录调用）：
  // 孙代条目不存在，map 里只剩 harness 播种的父条目。
  assert.equal(h.childAllow.has(h.grandchildId), false);
  assert.equal(h.childAllow.get(h.parentSessionId), h.allow);
  assert.equal(h.childAllow.size, 1);
});

// 矩阵 2（start 旧签名回落）：start 包装同形收窄。
test("the legacy start wrapper narrows grandchildren identically", async () => {
  const h = lineageHarness();
  const start = (h.ctx.subagents as { start: (...args: never[]) => Promise<unknown> }).start;
  await start("lane" as never, { parent: liveParent(h.parentSessionId), prompt: [] } as never);
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "read_file", "glob", "grep", "bash", "subagent"]);
  assert.equal(h.childAllow.get(h.grandchildId), h.allow);
});

// 矩阵 8：tools/change 触发基线 lift/re-restrict 后，血缘层保持（相交语义）。
test("baseline re-restrict on tools/change preserves the lineage layer", async () => {
  const h = lineageHarness();
  // 模拟 present-as 基线层：先装一层宽基线，拿到其 disposer。
  const liftBaseline = h.grandchildTools.restrict({ allow: [...BASE_NAMES] });
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  assert.deepEqual(
    h.grandchildTools.schemas().map((schema) => schema.name),
    ["read", "read_file", "glob", "grep", "bash", "subagent"],
  );
  // present-as 的 restrictAll：解除自己的基线层、再装一层新基线；血缘层不在其追踪内。
  liftBaseline();
  h.grandchildTools.restrict({ allow: [...BASE_NAMES] });
  h.emit("tools/change", {});
  assert.deepEqual(
    h.grandchildTools.schemas().map((schema) => schema.name),
    ["read", "read_file", "glob", "grep", "bash", "subagent"],
  );
});

// 矩阵 5（跨包隔离）：A 包血缘不拿 B 包 allow；两引用互不串。
test("two package lineages stay isolated by reference", async () => {
  const h = lineageHarness();
  const allowB: readonly string[] = ["read", "grep"];
  h.childAllow.set("pkg-child-b", allowB);
  const toolsB = createComposingTools();
  const childB = agentOf("grandchild-b", toolsB);
  // 既有 fake startActivation 按 agentsById 解析 localAgent，登记新孙代即可，
  // 不重新 apply（重复 apply 会叠加事件监听器，造成双重收窄）。
  h.agentsById.set("grandchild-b", childB);
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  await activateOf(h.ctx)(activationSpec("grandchild-b", "pkg-child-b"));
  assert.deepEqual(
    h.grandchildTools.schemas().map((schema) => schema.name),
    ["read", "read_file", "glob", "grep", "bash", "subagent"],
  );
  assert.deepEqual(toolsB.schemas().map((schema) => schema.name), ["read", "grep"]);
  assert.equal(h.childAllow.get(h.grandchildId), h.allow);
  assert.equal(h.childAllow.get("grandchild-b"), allowB);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`
Expected: FAIL — 孙代 schemas 仍为基线全量（血缘分支未实现）。

- [ ] **Step 3: 实现 C4（skills.ts 三处）**

① Context 类型（~:68-104），在 `huaanworkAttachments?: AttachmentMaps`（~:94）之后加：

```ts
  /** 包回合血缘允许表（C2）：孙代收窄继承读父条目、写同引用条目（C4）。 */
  huaanworkPackageChildAllow?: Map<string, readonly string[]>;
```

② startActivation 包装：在 legacy 分支（~:449-457 `if (!packageApplied && legacy !== undefined && run !== undefined) {...}`）之后、`if (run?.localAgent) { consumePendingSpawn(...) }`（~:458）之前插入：

```ts
        // 血缘分支（C4）：本次 activation 未命中包请求与 legacy，且父会话在血缘表中
        // ⇒ 孙代按 继承allow ∩ schemas 收窄，并写同引用条目供曾孙代继续继承。
        // 不挂包运行时附件（v1）；allow ∩ schemas 自然滤掉未挂载的运行时工具名。
        if (
          !packageApplied &&
          legacy === undefined &&
          run !== undefined &&
          childSessionId !== undefined &&
          parentFromCall !== undefined
        ) {
          const inherited = ctx.huaanworkPackageChildAllow?.get(parentFromCall);
          if (inherited !== undefined) {
            const childAgent = ctx.agents?.get?.(childSessionId) ?? run.localAgent;
            const tools = childAgent?.ctx?.get?.("tools");
            const schemas = tools?.schemas?.() ?? [];
            const existing = schemas.flatMap((schema) => (schema.name ? [schema.name] : []));
            const allow = inherited.filter((name) => existing.includes(name));
            tools?.restrict?.({ allow });
            ctx.huaanworkPackageChildAllow?.set(childSessionId, inherited);
          }
        }
```

③ start 包装（旧签名回落，~:288-362）同形处理：
- 在 `const run: any = await startParent.run(...)`（~:304）之后加 `let packageApplied = false;`
- 在 pkg 分支（~:315 `if (pkg && run?.localAgent && parentFromCall !== undefined && pkg.parentSessionId === parentFromCall) {`）体内第一行加 `packageApplied = true;`
- 在 pkg 分支结束（~:339）之后、`if (run?.localAgent) { consumePendingSpawn(...) }`（~:340）之前插入：

```ts
        // 血缘分支（C4，start 旧签名回落）：与 activation 路径同形。
        if (!current && !packageApplied && run?.localAgent && parentFromCall !== undefined) {
          const inherited = ctx.huaanworkPackageChildAllow?.get(parentFromCall);
          if (inherited !== undefined) {
            const childSessionId =
              sessionIdOf(run.localAgent.session?.header ?? run.localAgent) ?? sessionIdOf(run.localAgent);
            if (childSessionId !== undefined) {
              const tools = run.localAgent.ctx?.get?.("tools");
              const schemas = tools?.schemas?.() ?? [];
              const existing = schemas.flatMap((s: { name?: string }) => (s.name ? [s.name] : []));
              const allow = inherited.filter((name) => existing.includes(name));
              tools?.restrict?.({ allow });
              ctx.huaanworkPackageChildAllow?.set(childSessionId, inherited);
            }
          }
        }
```

- [ ] **Step 4: 跑新测试 + 既有 skills 钉子确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/huaanwork-guardrails/skills.spec.ts`
Expected: PASS — 八项矩阵全绿；既有 skills.spec.ts **零改动**全绿（矩阵 7：legacy 与主会话行为不变）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts
git commit -m "feat(guardrails): narrow grandchild tools by package lineage with transitive binding (C4)"
```

---

### Task 4: C5 执行期强制（policy.ts）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`（Context ~:58-79、apply() 两个监听器 ~:98-129）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts`（新增血缘强制测试）

**Interfaces:**
- Consumes: Task 2 的 `ctx.huaanworkPackageChildAllow`（只读）。
- Produces: 血缘会话调用 allow 外工具 ⇒ pre-execute `{kind:"deny", reason:"huaanwork-policy: 智能体包链路会话不允许使用工具 <name>"}`；guard 返回 `"huaanwork-guard: 智能体包链路会话不允许使用工具 <name>"`。map 缺席/条目不存在 ⇒ 现状行为不变（fail-closed 不放宽）。

- [ ] **Step 1: 写执行期强制测试（先红）**

在 `policy.cordis.spec.ts` 的 mcp 测试（:868-930）之后追加，harness 与该测试同形（smart 档 + 临时 profileDir + apply 收集 preExecute/guard）：

```ts
test("lineage sessions are denied out-of-allow tools at execute time even before schema narrowing", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const profileDir = mkdtempSync(join(tmpdir(), "huaanwork-policy-lineage-"));
  try {
    writeFileSync(join(profileDir, "huaanwork-settings.json"), JSON.stringify({ guard_mode: "smart" }), "utf8");
    const childAllow = new Map<string, readonly string[]>([
      ["grandchild", ["read", "read_file", "glob", "grep", "bash", "subagent"]],
      ["pkg-child", ["read", "read_file", "glob", "grep", "bash", "subagent"]],
    ]);

    let preExecute: PreExecute | undefined;
    let guard:
      | ((execution: {
          name: string;
          arguments: Record<string, unknown>;
          agent?: { id?: string; session?: { id?: string } };
          callId?: string;
        }) => string | undefined)
      | undefined;

    apply({
      huaanworkWorkspaceRoot: { current: process.cwd() },
      huaanworkProfileDir: profileDir,
      huaanworkAttachments: emptyAttachments(),
      huaanworkPackageChildSessions: new Set(["pkg-child"]),
      huaanworkPackageChildAllow: childAllow,
      on(event: string, listener: PreExecute) {
        if (event === "tools/pre-execute") preExecute = listener;
      },
      tools: {
        guard(listener: typeof guard) {
          guard = listener;
          return () => undefined;
        },
      },
    });

    const call = (sessionId: string, name: string, callId: string) => ({
      name,
      arguments: {},
      agent: { session: { id: sessionId } },
      callId,
    });

    // 血缘会话 allow 内工具：血缘层不拦，落到常规策略判定（glob 无路径参数在 smart 档
    // 本就 allow；read 需工作区内真实路径，空参会被路径越界拒绝，故不用 read 做放行样例）。
    assert.deepEqual(
      await preExecute?.(call("grandchild", "glob", "g-1"), async () => ({ kind: "allow" })),
      { kind: "allow" },
    );
    // 血缘会话 allow 外工具：即使 schemas 尚未收窄，执行期也拒绝（首步时序窗封死）。
    const writeCall = call("grandchild", "write", "g-2");
    assert.deepEqual(await preExecute?.(writeCall, async () => ({ kind: "allow" })), {
      kind: "deny",
      reason: POLICY("智能体包链路会话不允许使用工具 write"),
    });
    assert.equal(guard?.(writeCall), GUARD("智能体包链路会话不允许使用工具 write"));
    // 直接包子会话同样受强制（有意的安全收紧，spec §4.3）。
    const hostCall = call("pkg-child", "call_host_tool", "p-1");
    assert.deepEqual(await preExecute?.(hostCall, async () => ({ kind: "allow" })), {
      kind: "deny",
      reason: POLICY("智能体包链路会话不允许使用工具 call_host_tool"),
    });
    // 普通会话不在血缘表：git_push 保持 smart 档原有 ask（git_push 不检查参数，空参即
    // ask；write 空参会被路径越界拒绝，无法体现 ask 基线，故用 git_push）。
    assert.deepEqual(
      await preExecute?.(call("normal-session", "git_push", "n-1"), async () => ({ kind: "allow" })),
      { kind: "ask" },
    );
    // 清理后同一会话回到普通询问：标志不是永久的。
    childAllow.delete("grandchild");
    assert.deepEqual(
      await preExecute?.(call("grandchild", "git_push", "g-3"), async () => ({ kind: "allow" })),
      { kind: "ask" },
    );
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/policy.cordis.spec.ts -t "lineage sessions"`
Expected: FAIL — write 调用返回 ask 而非 deny。

- [ ] **Step 3: 实现 C5（policy.ts 三处）**

① Context 类型（~:58-79），在 `huaanworkPackageChildSessions?: Set<string>`（~:68）之后加：

```ts
  huaanworkPackageChildAllow?: Map<string, readonly string[]>
```

② `tools/pre-execute` 监听器（apply() ~:98-129 内）体首插入（在 readGuardMode 之前）：

```ts
    const lineageAllow = ctx.huaanworkPackageChildAllow?.get(sessionIdOfAgentRef(execution.agent) ?? "")
    if (lineageAllow !== undefined && !lineageAllow.includes(execution.name)) {
      return { kind: "deny", reason: `huaanwork-policy: 智能体包链路会话不允许使用工具 ${execution.name}` }
    }
```

③ `tools.guard` 监听器体首插入（同判定，返回字符串）：

```ts
    const lineageAllow = ctx.huaanworkPackageChildAllow?.get(sessionIdOfAgentRef(execution.agent) ?? "")
    if (lineageAllow !== undefined && !lineageAllow.includes(execution.name)) {
      return `huaanwork-guard: 智能体包链路会话不允许使用工具 ${execution.name}`
    }
```

（`sessionIdOfAgentRef` 已在 policy.ts:6 从 `@huaanwork/policy/channels` 导入，无需新增 import。）

- [ ] **Step 4: 跑测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/policy.cordis.spec.ts`
Expected: PASS（新测试 + 既有全部钉子零改动全绿）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts
git commit -m "feat(guardrails): deny out-of-allow tool calls from package lineage sessions (C5)"
```

---

### Task 5: typo-check 包源文件 + 三包共测骨架

**Files:**
- Create: `dsh-plugin-huaanwork/agent-packages/typo-check/agent.json`
- Create: `dsh-plugin-huaanwork/agent-packages/typo-check/persona.md`
- Create: `dsh-plugin-huaanwork/agent-packages/typo-check/skill/SKILL.md`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-sources.spec.ts`（新文件）

**Interfaces:**
- Consumes: store 预算常量 `MAX_PERSONA_BYTES`/`MAX_SKILL_BYTES`/`MAX_PACKAGE_BYTES`（store.ts:37-43）、`agentPackageBytes`（store.ts:66）、`parseAgentPackageManifest`（`@huaanwork/agent-package-format/manifest`）。
- Produces: 三包源目录布局 `agent-packages/{slug}/{agent.json,persona.md,skill/SKILL.md}`；Task 8 播种脚本按此布局读取。manifest 固定字段：schemaVersion 1、version `1.0.0`、persona `"persona.md"`、skill `{entry:"skill/SKILL.md",summary}`、`tools:{mode:"none"}`、`allowSkills:[]`；draftId/createdAt/updatedAt 源文件用固定占位（播种时重新生成）。

- [ ] **Step 1: 写三包共测骨架 + typo-check 断言（先红）**

新建 `tests/huaanwork-host/agent-package-sources.spec.ts`：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { parseAgentPackageManifest } from '@huaanwork/agent-package-format/manifest'

import {
  agentPackageBytes,
  MAX_PACKAGE_BYTES,
  MAX_PERSONA_BYTES,
  MAX_SKILL_BYTES,
} from '../../src/huaanwork-host/agent-package/store.ts'

const SOURCES_ROOT = join(import.meta.dirname, '..', '..', 'agent-packages')

function readSource(slug: string, relativePath: string): string {
  return readFileSync(join(SOURCES_ROOT, slug, relativePath), 'utf8')
}

function loadSourceManifest(slug: string) {
  const parsed = parseAgentPackageManifest(JSON.parse(readSource(slug, 'agent.json')))
  if (!parsed.ok) throw new Error(`${slug} manifest invalid: ${JSON.stringify(parsed.fieldErrors)}`)
  return parsed.manifest
}

function fileSet(slug: string) {
  const manifest = loadSourceManifest(slug)
  return {
    manifest,
    persona: readSource(slug, 'persona.md'),
    skill: { markdown: readSource(slug, 'skill/SKILL.md'), scripts: [] },
  }
}

describe('typo-check package source', () => {
  test('manifest matches the approved spec fields', () => {
    const manifest = loadSourceManifest('typo-check')
    expect(manifest.slug).toBe('typo-check')
    expect(manifest.displayName).toBe('错别字检测')
    expect(manifest.description).toBe(
      '对指定文件夹中的 Word 文档做错别字与用语规范检测：两个独立子代理背靠背双盲检测，主代理仲裁分歧，输出带行号定位与置信度的报告。',
    )
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.persona).toBe('persona.md')
    expect(manifest.skill?.entry).toBe('skill/SKILL.md')
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
  })

  test('stays within store budgets', () => {
    const files = fileSet('typo-check')
    expect(Buffer.byteLength(files.persona, 'utf8')).toBeLessThanOrEqual(MAX_PERSONA_BYTES)
    expect(Buffer.byteLength(files.skill.markdown, 'utf8')).toBeLessThanOrEqual(MAX_SKILL_BYTES)
    expect(agentPackageBytes(files)).toBeLessThanOrEqual(MAX_PACKAGE_BYTES)
  })

  test('SKILL.md pins the dual-blind workflow and honest degradation', () => {
    const skill = readSource('typo-check', 'skill/SKILL.md')
    for (const pin of ['subagent', '双盲', '仲裁', '同一宿主模型', 'textutil', 'System.IO.Compression', '30000', '500']) {
      expect(skill).toContain(pin)
    }
    // 7 类 canonical 标签齐全
    for (const label of ['别字', '高频易混字', '多字漏字倒字', '字词重复', '专名前后不一致', '全角半角混用', '英文拼写错误']) {
      expect(skill).toContain(label)
    }
    // 明确不报与两可词
    expect(skill).toContain('其他/其它')
    expect(skill).toContain('唯一/惟一')
    expect(skill).toContain('帐')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-sources.spec.ts`
Expected: FAIL — 源文件不存在（ENOENT）。

- [ ] **Step 3: 写 typo-check 三个源文件**

`agent-packages/typo-check/agent.json`：

```json
{
  "schemaVersion": 1,
  "slug": "typo-check",
  "displayName": "错别字检测",
  "description": "对指定文件夹中的 Word 文档做错别字与用语规范检测：两个独立子代理背靠背双盲检测，主代理仲裁分歧，输出带行号定位与置信度的报告。",
  "version": "1.0.0",
  "draftId": "00000000-0000-4000-8000-000000000101",
  "createdAt": "2026-11-11T00:00:00.000Z",
  "updatedAt": "2026-11-11T00:00:00.000Z",
  "persona": "persona.md",
  "skill": { "entry": "skill/SKILL.md", "summary": "Word 文档错别字双盲检测与仲裁报告" },
  "tools": { "mode": "none" },
  "allowSkills": []
}
```

`agent-packages/typo-check/persona.md`：

```markdown
你是中文公文与金融文档校对专家，负责基金定期报告等披露文档的错别字审查。

- 严谨、克制：只报有原文证据的确定性错误，宁缺毋滥；没有把握时不强行报告。
- 只出报告，绝不修改原文档，不提供任何改写原文的入口。
- 每条发现必须给出行号定位、原文子串证据、建议改法、类别与置信度。
- 你通过两个独立子代理背靠背双盲检测，再逐条仲裁分歧；仲裁时回读原文上下文，不凭印象裁定。
```

`agent-packages/typo-check/skill/SKILL.md`（规则蒸馏自原项目 `review-spec-v2.md` 与 `lanes/prompts.py`，全部内联）：

````markdown
---
name: typo-check
description: Word 文档错别字与用语规范双盲检测
---

# 错别字检测工作流

## 边界与降级声明（如实告知用户）

- 只出报告，绝不修改原文档。
- 两个 lane 使用**同一宿主模型**，不等于原跨厂商（DeepSeek+Kimi）交叉验证；同模型相关盲区不可消除（owner 裁定 R1 的降级）。
- 定位锚点为提取后 txt 的行号（无 python-docx 结构化锚定）；无断点续跑。

## 工作流（六步）

1. **枚举**：按用户给定路径用 `glob` 匹配 `*.docx`（单文件亦支持）。路径不存在或无 docx ⇒ 如实报告，不编造。
2. **提取**：
   - macOS：`bash` 执行 `textutil -convert txt -output <工作区临时目录>/<名>.txt <docx>`（系统自带，零依赖）。
   - Windows：`pwsh` 用 `System.IO.Compression` 打开 docx，读 `word/document.xml`，把 `</w:p>` 替换为换行、去除全部标签、解码 XML 实体，写 UTF-8 txt。
   - 临时文件落工作区临时目录；报告完成后清理。txt 行号即定位锚点。
3. **条件分块**：提取文本 ≤30000 字整篇检测；超过则按 ≤30000 字/块、相邻块重叠 500 字切块，逐块检测后按（行号,原文）合并去重。
4. **双盲派发**：用 `subagent` 工具派两个独立 lane（A/B）。每个 lane 的 prompt 只含：本文件「检测规则」「明确不报」「两可词」「输出格式」节全文 + 目标 txt 路径 + 各自角色指令；**不含另一 lane 的任何信息**、不含主流程的中间判断。两 lane 独立会话即双盲（运行时串行或并行调度不影响独立性）。
   - lane A 角色：「你是基金定期报告错别字审查员（A 路）。逐行审读给定文本，找出确定的错别字。」
   - lane B 角色：「你是金融披露文档校对专家（B 路），以怀疑但克制的态度复核文本。允许零发现：没有把握时不要强行报告，宁缺毋滥；但每条发现必须给出 evidence（行原文中的确切子串），无法给出证据的条目视为无效。」
5. **仲裁**：两路返回后按（行号+原文）对齐逐条比对——
   - 双路一致 ⇒ 高置信收录（置信度=双路一致）。
   - 单路报告 ⇒ 回读原文上下文裁决：成立则收录并标「仲裁」；不成立则丢弃。
   - 两路冲突（同位置不同建议）⇒ 回读原文给出裁定。
6. **报告**：按文件输出发现列表：行号/段落、原文、建议、类别（canonical 中文标签）、置信度（双路一致/仲裁）、依据。对话输出为主；用户要求时用 bash 写报告文件。零发现时如实输出「未发现确定错误」。

## 检测规则（仅报以下 7 类；lane prompt 内联复制本节）

### 类别 1：别字（音近/形近误用，含简体中混入零星繁体字）
- 应报：「按装」→安装；「会议纪录」→记录；「基金資产净值」→资（繁体混入）。
- 不报：「截止日期」「歧义」写法正确。

### 类别 2：高频易混字（的/地/得、在/再、做/作、帐/账）
结构明确、可机械判定者才报；需整句句法分析才能判定者不报（归语法/语病，显式排除）。
- 的/地：「认真的审核了本报告」→认真地（审核为动词）；「系统性的下降了」→系统性地。不报：「认真的态度」「系统性的风险」（名词前「的」正确）。
- 的/得：「取得了显著得成效」→显著的；「增长较的快」→较快。不报：「跑得快」（得+补语正确）。
- 在/再：「在次提醒」→再次；「再现有基础上」→在。不报：「再次确认」「在本报告期内」。
- 做/作：「做为基金管理人」→作为。不报：「做出投资决定」（规范惯用）。
- 帐/账：金融披露语境「帐」一律应报——「银行帐户」→账户、「帐务处理」→账务。不报：「账户余额」「账面价值」。

### 类别 3：多字漏字倒字
- 应报：「市市场」→市场（多字）；「注册会师」→会计师（漏字）；「料材」→材料（倒字）。
- 不报：「份额持有人大会」；「资管新规」（通行简称非漏字）。

### 类别 4：字词重复
- 应报：「我们将我们持续披露」→重复「我们将」；「投资的投资范围」→重复「投资」。
- 不报：「一级、二级市场」（列举合理重复）；「各项样本齐全、各项指标达标」（平行结构）。

### 类别 5：专名前后不一致（含专名大小写不一致）
- 应报：同一人「张明」/「张铭」两种写法；同文「MORGAN STANLEY」与「Morgan Stanley」混用。
- 不报：首次全称后统一用「本基金」（规范简称）；「本基金」/「该基金」交替指代（代词替换）。

### 类别 6a：全角半角混用（中文句中半角标点、全角数字）
- 应报：「本设备安装,运行良好」→中文句中半角逗号应为「，」；「截至２０２５年」→全角数字应为半角 2025。
- 不报：表格代码列「021937」（数字语境半角正常）；英文句 "The ratio is 0.85, which is stable."（英文语境半角正常）。

### 类别 8：英文拼写错误（不含大小写）
- 应报：「Managment Report」→Management；「recieve dividends」→receive。
- 不报：「ETF」写作「etf」（大小写风格；若属专名前后不一致则归类别 5）。

## 明确不报（一律不报）

- 语法/语病（如「通过…使得…」句式杂糅、「约 100 万元左右」语义重复）。
- 文风偏好（如「综上所述」多次出现、口语化表达）。
- 英文大小写风格、日期格式混用（2026年08月 vs 2026年8月）、中英之间空格。
- 数字/金额/百分比问题（原类别 7 已移除，不再检测）。
- 标点误用（原类别 6b 默认关闭，当前不报）。
- 的/地/得需整句句法分析才能判定者：「持续的增长」「投资的回报率」不报。

## 两可词（两种写法均正确，不报）

- 其他/其它
- 唯一/惟一

**帐/账不是两可词**：金融披露语境「帐」必报（账户/账号/账务）。

## 输出格式（lane 严格 JSON，不要多余文字）

```json
{"block_id": "<块ID>", "responsibility_range": ["Lxxxx", "Lxxxx"], "lines_checked": 0,
 "findings": [{"line": 0, "char_start": 0, "char_end": 0, "original": "<行原文[start:end]确切子串>",
   "suggestion": "<建议改法>", "type": "<上述 canonical 中文标签之一>",
   "evidence": "<包含该错误的行原文子串>", "confidence": "high|medium|low"}]}
```

- `line` 为全局行号数字；`char_start` 从 0 起；`char_end` 左闭右开。
- `type` 只用 canonical 中文标签：别字 / 高频易混字 / 多字漏字倒字 / 字词重复 / 专名前后不一致 / 全角半角混用 / 英文拼写错误。禁止别名。
- 仅报告责任范围内的行；语境区只读不报。
````

- [ ] **Step 4: 跑测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-sources.spec.ts`
Expected: PASS（typo-check 三测试）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/agent-packages/typo-check dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-sources.spec.ts
git commit -m "feat(agent-packages): add typo-check package source with inline dual-blind rules"
```

---

### Task 6: code-review 包源文件

**Files:**
- Create: `dsh-plugin-huaanwork/agent-packages/code-review/agent.json`
- Create: `dsh-plugin-huaanwork/agent-packages/code-review/persona.md`
- Create: `dsh-plugin-huaanwork/agent-packages/code-review/skill/SKILL.md`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-sources.spec.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 5 的共测骨架（readSource/loadSourceManifest/fileSet）。
- Produces: `agent-packages/code-review/` 三件套；REVIEW_SPEC 逐字移植自原项目 `代码审查智能体/src/spec.ts`（保留 5 严重度与输出格式，剔除服务/HTTP 内容）。

- [ ] **Step 1: 追加 code-review 测试（先红）**

在 `agent-package-sources.spec.ts` 追加：

```ts
describe('code-review package source', () => {
  test('manifest matches the approved spec fields', () => {
    const manifest = loadSourceManifest('code-review')
    expect(manifest.slug).toBe('code-review')
    expect(manifest.displayName).toBe('代码审查')
    expect(manifest.description).toBe(
      '对指定代码文件或目录做结构化审查：按审查规格逐项检查正确性、安全、性能与可维护性，输出按严重度分级的发现与修复建议。',
    )
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
  })

  test('stays within store budgets', () => {
    const files = fileSet('code-review')
    expect(Buffer.byteLength(files.persona, 'utf8')).toBeLessThanOrEqual(MAX_PERSONA_BYTES)
    expect(Buffer.byteLength(files.skill.markdown, 'utf8')).toBeLessThanOrEqual(MAX_SKILL_BYTES)
    expect(agentPackageBytes(files)).toBeLessThanOrEqual(MAX_PACKAGE_BYTES)
  })

  test('SKILL.md pins the review spec structure and severity discipline', () => {
    const skill = readSource('code-review', 'skill/SKILL.md')
    for (const pin of ['严重度统计', '问题清单', 'critical', 'high', 'medium', 'low', 'info', '先反证', '安全漏洞']) {
      expect(skill).toContain(pin)
    }
    expect(skill).toContain('文件:行号')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-sources.spec.ts -t "code-review"`
Expected: FAIL — 源文件不存在。

- [ ] **Step 3: 写 code-review 三个源文件**

`agent-packages/code-review/agent.json`：

```json
{
  "schemaVersion": 1,
  "slug": "code-review",
  "displayName": "代码审查",
  "description": "对指定代码文件或目录做结构化审查：按审查规格逐项检查正确性、安全、性能与可维护性，输出按严重度分级的发现与修复建议。",
  "version": "1.0.0",
  "draftId": "00000000-0000-4000-8000-000000000102",
  "createdAt": "2026-11-11T00:00:00.000Z",
  "updatedAt": "2026-11-11T00:00:00.000Z",
  "persona": "persona.md",
  "skill": { "entry": "skill/SKILL.md", "summary": "按规格审查代码安全与质量，输出分级发现" },
  "tools": { "mode": "none" },
  "allowSkills": []
}
```

`agent-packages/code-review/persona.md`：

```markdown
你是资深代码安全与质量评审者。

- 先反证再定严重度：每条发现先尝试推翻它（是否有上下文使其成立？是否误读？），反证不成立才收录。
- 只报有证据的问题：给出文件:行号与代码子串证据，不编造文件内容。
- 安全漏洞最高优先级；描述具体可复现，建议可执行。
- 单会话审查，不派子代理；大文件按阈值分块读。
```

`agent-packages/code-review/skill/SKILL.md`（REVIEW_SPEC 逐字移植 + 工作流）：

````markdown
---
name: code-review
description: 按规格审查代码安全与质量，输出分级发现
---

# 代码审查工作流

## 工作流

1. 用 `glob`/`grep` 定位用户指定的代码文件或目录；用 `read` 读目标代码。
2. 大文件条件分块：单文件 >30000 字按 ≤30000 字/块、重叠 500 字分块读，逐块审查后合并去重。
3. 按下方「审查规格」逐项审查；每条发现先反证再定严重度。
4. 输出结构化 Markdown 报告（格式见规格）。

## 审查规格（逐字移植自原项目 REVIEW_SPEC）

你是一名资深代码安全与质量审查专家。请对给定的源码进行严格审查。

### 审查优先级（务必遵循）
1. 【最高优先级】安全漏洞：命令/SQL/代码注入、XSS、CSRF、鉴权与授权缺陷（越权、未校验身份）、敏感信息/密钥硬编码与泄露、不安全反序列化、路径穿越、弱加密或不安全随机数、日志中打印密钥等。任何安全类问题都应标记较高严重度。
2. 代码规范：命名、结构、重复代码、异常处理、日志规范、可读性。
3. 性能：不必要的循环/IO、N+1 查询、同步阻塞、内存泄漏风险。
4. 可维护性：模块耦合、魔法数字、缺失注释、难以测试、接口设计。

### 输出要求
- 直接返回 Markdown，不要使用代码块包裹整体内容。
- 必须包含以下结构：
  ## 总览
  （2-4 句整体结论，先说安全状况）
  ## 严重度统计
  （critical / high / medium / low / info 各计数，可用表格或列表）
  ## 问题清单
  （表格，列：文件:行号 | 严重度 | 类型 | 描述 | 建议）
- 行号如无法精确定位可写为「文件」或「文件:约N」。
- 若未发现某类问题，请在表格中写「无」或省略该行，但保留结构。
- 使用中文描述。

### 约束
- 只基于提供的代码给出结论，不要编造文件内容。
- 问题描述要具体、可复现；建议要可执行。

## 严重度定义与三档对应

- critical：可直接利用的安全漏洞或数据丢失/损坏。
- high：高危安全缺陷或必然导致错误结果的正确性问题。
- medium：重要质量/性能/可维护性问题，特定条件下出错。
- low：次要规范/可读性问题。
- info：提示性观察，非缺陷。

三档对应（供用户快速分级）：critical/high ≈ 阻断，medium ≈ 重要，low/info ≈ 建议。

## 定级纪律

每条发现先反证：是否有上下文使其成立？是否误读代码？反证不成立才收录并定级；
安全类问题宁可标高待人工复核，不可静默降级。
````

- [ ] **Step 4: 跑测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-sources.spec.ts`
Expected: PASS（typo-check + code-review）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/agent-packages/code-review dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-sources.spec.ts
git commit -m "feat(agent-packages): add code-review package source with ported REVIEW_SPEC"
```

---

### Task 7: task-orch 包源文件

**Files:**
- Create: `dsh-plugin-huaanwork/agent-packages/task-orch/agent.json`
- Create: `dsh-plugin-huaanwork/agent-packages/task-orch/persona.md`
- Create: `dsh-plugin-huaanwork/agent-packages/task-orch/skill/SKILL.md`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-sources.spec.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 5 的共测骨架。
- Produces: `agent-packages/task-orch/` 三件套；方法论蒸馏自原项目 `系统化说明书.md`（5 编排模式/3 分解策略/DAG）与 `types.ts`（schedule/retry/alert 字段形态）。边界：只出计划不执行。

- [ ] **Step 1: 追加 task-orch 测试（先红）**

```ts
describe('task-orch package source', () => {
  test('manifest matches the approved spec fields', () => {
    const manifest = loadSourceManifest('task-orch')
    expect(manifest.slug).toBe('task-orch')
    expect(manifest.displayName).toBe('任务编排')
    expect(manifest.description).toBe(
      '把复杂任务拆解为可实施的执行计划：子任务依赖分析、每步输入产出与验收标准、顺序与并行建议、周期任务的 cron/interval 调度建议。只出计划，不执行。',
    )
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
  })

  test('stays within store budgets', () => {
    const files = fileSet('task-orch')
    expect(Buffer.byteLength(files.persona, 'utf8')).toBeLessThanOrEqual(MAX_PERSONA_BYTES)
    expect(Buffer.byteLength(files.skill.markdown, 'utf8')).toBeLessThanOrEqual(MAX_SKILL_BYTES)
    expect(agentPackageBytes(files)).toBeLessThanOrEqual(MAX_PACKAGE_BYTES)
  })

  test('SKILL.md pins the plan-only boundary and scheduling forms', () => {
    const skill = readSource('task-orch', 'skill/SKILL.md')
    for (const pin of ['只出计划', '验收标准', 'cron', 'interval', '依赖', '可并行', '拓扑']) {
      expect(skill).toContain(pin)
    }
    expect(skill).toContain('30s')
    expect(skill).toContain('执行者')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-sources.spec.ts -t "task-orch"`
Expected: FAIL — 源文件不存在。

- [ ] **Step 3: 写 task-orch 三个源文件**

`agent-packages/task-orch/agent.json`：

```json
{
  "schemaVersion": 1,
  "slug": "task-orch",
  "displayName": "任务编排",
  "description": "把复杂任务拆解为可实施的执行计划：子任务依赖分析、每步输入产出与验收标准、顺序与并行建议、周期任务的 cron/interval 调度建议。只出计划，不执行。",
  "version": "1.0.0",
  "draftId": "00000000-0000-4000-8000-000000000103",
  "createdAt": "2026-11-11T00:00:00.000Z",
  "updatedAt": "2026-11-11T00:00:00.000Z",
  "persona": "persona.md",
  "skill": { "entry": "skill/SKILL.md", "summary": "复杂任务拆解与可实施执行计划顾问" },
  "tools": { "mode": "none" },
  "allowSkills": []
}
```

`agent-packages/task-orch/persona.md`：

```markdown
你是任务编排顾问，把复杂任务拆解为可实施、可验收的执行计划。

- 拆解落在真实工程上：若用户附项目路径，先读实际代码/文档再拆解，不凭空假设。
- 计划可执行、可验收：每步有输入、动作、产出、验收标准与执行者。
- 只出计划，不执行：无定时触发、无运行监控、不自动派发其他智能体；执行由用户或主会话驱动。
- 按用户反馈迭代修订计划。
```

`agent-packages/task-orch/skill/SKILL.md`（方法论蒸馏自原项目说明书与 types.ts）：

````markdown
---
name: task-orch
description: 复杂任务拆解与可实施执行计划顾问
---

# 任务编排顾问工作流

## 边界（务必遵守）

**只出计划，不执行。** 无定时触发、无运行监控、不自动派发其他智能体。
执行由用户或主会话驱动；你不承诺自动执行，也不调用 subagent 去跑计划。

## 工作流

1. **理解任务**：明确目标、约束、完成标准。若用户附项目路径，用 `read`/`glob`/`grep` 读实际代码/文档再拆解。信息不足时先列出待澄清问题，不凭空假设。
2. **选择分解策略**（可组合）：
   - 目标分解（goal-driven）：先问「完成标准是什么」，反向拆出中间结果（如报表 = 采集→清洗→聚合→渲染）。
   - 按能力分解（capability-driven）：按工具/角色能力边界切分（A 爬取、B 摘要）。
   - 按数据分片（data-sharding）：同构任务按数据键（用户 ID 区间、日期分片）水平拆分，便于并发与失败隔离。
3. **依赖分析（DAG）**：子任务间 `dependsOn` 构成有向无环图；按拓扑序排执行顺序，**可并行项显式标注**；发现循环依赖即拒绝并指出环，不输出不可执行的计划。条件分支用「当…时走…」描述。
4. **每步规格**：每个子任务给出 输入 | 动作 | 产出 | 验收标准 | 执行者（人/智能体/脚本）。验收标准必须可判定（命令+期望退出码、文件存在+内容断言、数值阈值等）。
5. **工程化建议**：为每步给超时、重试（max/backoff/策略 fixed|exp）、幂等性说明、失败告警级别（info|warn|critical）。
6. **周期任务调度建议**：cron 5 段「分 时 日 月 周」（可带 timezone 如 Asia/Shanghai）或 interval 形态 `30s|5m|1h|1d`；建议互斥（禁止重叠）与并发上限。
7. **输出与迭代**：Markdown 计划为主；周期任务可附 tasks.json 风格 JSON 附录。按用户反馈修订。

## 编排模式速查（选型用）

| 模式 | 适用 | 特征 |
| --- | --- | --- |
| DAG | 结构稳定、依赖明确、可重跑（ETL/固定步骤） | 拓扑序、失败局部重跑 |
| 流水线 | 顺序阶段移交（内容采编→写作→审校→发布） | 低耦合、阶段产出移交 |
| 中心式 orchestrator-worker | 动态分解+需综合+子任务独立（Deep Research） | 并行派发+汇总，token 成本高 |
| 分层 hierarchical | 需验收/委派/质量门（软件工程多角色） | Manager 验证与回退 |
| 去中心式辩论/投票 | 多视角聚合、无硬层级（评审/方案比选） | 必须设终止条件 |

## 输出形态

### Markdown 计划（主）

```
# <任务名> 执行计划
## 目标与完成标准
## 子任务分解（DAG）
- T1 …（dependsOn: []）【可并行】
- T2 …（dependsOn: [T1]）
## 逐步规格
| 步骤 | 输入 | 动作 | 产出 | 验收标准 | 执行者 | 超时 | 重试 | 幂等 |
## 执行顺序与并行建议
## 周期调度建议（如适用）
## 风险与质量门
```

### tasks.json 风格 JSON 附录（周期任务，可选）

借鉴原 orch 调度模型；`endpoint` 语义泛化为「执行者：人/智能体/脚本」，不含真实 HTTP 调用：

```json
{
  "tasks": [{
    "id": "t1",
    "name": "示例子任务",
    "executor": "人|智能体|脚本",
    "action": "做什么",
    "schedule": { "type": "cron", "expr": "*/5 * * * *", "timezone": "Asia/Shanghai" },
    "timeout_ms": 8000,
    "retry": { "max": 2, "backoff_ms": 1000, "strategy": "exp" },
    "alert": { "enabled": true, "min_severity": "warn" },
    "dependsOn": [],
    "completion": "可判定的验收标准"
  }]
}
```

interval 形态：`{ "type": "interval", "expr": "30s" }`（支持 30s|5m|1h|1d）。

## 质量门

- 计划必须可执行：每步验收标准可判定，无循环依赖，执行者明确。
- 不编造项目事实：未读到的代码/文档不假设其存在。
- 高风险步骤（删除/发布/跨系统写）显式标注「需人工确认」。
````

- [ ] **Step 4: 跑测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-sources.spec.ts`
Expected: PASS（三包全部）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/agent-packages/task-orch dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-sources.spec.ts
git commit -m "feat(agent-packages): add task-orch plan-only advisor package source"
```

---

### Task 8: 播种脚本 + 自测

**Files:**
- Create: `dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/seed-agent-packages.spec.ts`（新文件）

**Interfaces:**
- Consumes: Task 5–7 的源目录；store API `writeAgentPackageAtomically`/`readAgentPackageState`/`writeAgentPackageState`/`agentPackageBytes`/`MAX_PACKAGE_BYTES`（store.ts）；`parseAgentPackageManifest`（`@huaanwork/agent-package-format/manifest`）。
- Produces: CLI `node --experimental-transform-types scripts/seed-agent-packages.mjs --profile <profileDir>`；把三包写入 `{profileDir}/agents/{slug}` + `agents-state.json`（`local:{slug}` → `{source:'local',enabled:true,installedVersion:'1.0.0',publishStatus:'none'}`）；draftId/createdAt/updatedAt 重新生成；stdout 输出 JSON 结果。Task 9 验证脚本 spawn 此脚本。

- [ ] **Step 1: 写播种自测（先红）**

新建 `tests/huaanwork-host/seed-agent-packages.spec.ts`：

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import {
  agentPackageDir,
  readAgentPackage,
  readAgentPackageFile,
  readAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'seed-agent-packages.mjs')
const SLUGS = ['typo-check', 'code-review', 'task-orch']

let roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

test('seeds all three packages into an isolated profile with regenerated identity', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'huaanwork-seed-test-'))
  roots.push(profileDir)
  const stdout = execFileSync(
    process.execPath,
    ['--experimental-transform-types', SCRIPT, '--profile', profileDir],
    { encoding: 'utf8', cwd: join(import.meta.dirname, '..', '..') },
  )
  const result = JSON.parse(stdout)
  expect(result.seeded).toEqual(SLUGS)

  const state = readAgentPackageState(profileDir)
  for (const slug of SLUGS) {
    const entry = state[`local:${slug}`]
    expect(entry?.source).toBe('local')
    expect(entry?.enabled).toBe(true)
    expect(entry?.installedVersion).toBe('1.0.0')
    expect(entry?.publishStatus).toBe('none')

    const detail = readAgentPackage(profileDir, slug)
    expect(detail?.slug).toBe(slug)
    expect(detail?.version).toBe('1.0.0')
    expect(detail?.source).toBe('local')
    expect(detail?.enabled).toBe(true)

    // manifest 字段经磁盘 agent.json 核对（AgentPackageDetail 无 manifest 字段）。
    const manifest = JSON.parse(readAgentPackageFile(profileDir, slug, 'agent.json')!)
    expect(manifest.tools).toEqual({ mode: 'none' })
    expect(manifest.allowSkills).toEqual([])
    // draftId 已重新生成，不再是源文件占位。
    expect(manifest.draftId).not.toMatch(/^00000000-0000-4000-8000-0000000001/)
    expect(manifest.createdAt).not.toBe('2026-11-11T00:00:00.000Z')
    expect(agentPackageDir(profileDir, slug)).toContain(slug)
  }
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/seed-agent-packages.spec.ts`
Expected: FAIL — 脚本不存在。

- [ ] **Step 3: 写播种脚本**

新建 `scripts/seed-agent-packages.mjs`（M2 验收先例形态：直接 import desktop TS src）：

```js
#!/usr/bin/env node
/**
 * 把 agent-packages/ 三个源包播种到指定隔离 profile。
 * 用法: node --experimental-transform-types scripts/seed-agent-packages.mjs --profile <profileDir>
 * 绝不触碰生产 profile；draftId/createdAt/updatedAt 每次重新生成。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAgentPackageManifest } from '@huaanwork/agent-package-format/manifest'

import {
  agentPackageBytes,
  MAX_PACKAGE_BYTES,
  readAgentPackageState,
  writeAgentPackageAtomically,
  writeAgentPackageState,
} from '../src/huaanwork-host/agent-package/store.ts'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const SOURCES_ROOT = join(SCRIPT_DIR, '..', 'agent-packages')
const SLUGS = ['typo-check', 'code-review', 'task-orch']

function parseArgs(argv) {
  const index = argv.indexOf('--profile')
  if (index < 0 || !argv[index + 1]) {
    console.error('usage: seed-agent-packages.mjs --profile <profileDir>')
    process.exit(2)
  }
  return { profileDir: argv[index + 1] }
}

function seedOne(profileDir, slug) {
  const dir = join(SOURCES_ROOT, slug)
  const rawManifest = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'))
  const now = new Date().toISOString()
  const manifest = { ...rawManifest, draftId: randomUUID(), createdAt: now, updatedAt: now }
  const parsed = parseAgentPackageManifest(manifest)
  if (!parsed.ok) {
    throw new Error(`${slug} manifest 校验失败: ${JSON.stringify(parsed.fieldErrors)}`)
  }
  const persona = readFileSync(join(dir, 'persona.md'), 'utf8')
  const skillMarkdown = readFileSync(join(dir, 'skill', 'SKILL.md'), 'utf8')
  const files = { manifest: parsed.manifest, persona, skill: { markdown: skillMarkdown, scripts: [] } }
  const bytes = agentPackageBytes(files)
  if (bytes > MAX_PACKAGE_BYTES) {
    throw new Error(`${slug} 超过整包预算: ${bytes} > ${MAX_PACKAGE_BYTES}`)
  }
  writeAgentPackageAtomically({ profileDir, ...files, replace: true })
  const state = readAgentPackageState(profileDir)
  state[`local:${slug}`] = {
    source: 'local',
    enabled: true,
    installedVersion: parsed.manifest.version,
    publishStatus: 'none',
  }
  writeAgentPackageState(profileDir, state)
  return { slug, version: parsed.manifest.version, bytes }
}

const { profileDir } = parseArgs(process.argv.slice(2))
const seeded = []
const details = []
for (const slug of SLUGS) {
  details.push(seedOne(profileDir, slug))
  seeded.push(slug)
}
console.log(JSON.stringify({ seeded, details }, null, 2))
```

- [ ] **Step 4: 跑测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/seed-agent-packages.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/scripts/seed-agent-packages.mjs dsh-plugin-huaanwork/tests/huaanwork-host/seed-agent-packages.spec.ts
git commit -m "feat(scripts): seed three agent packages into an isolated profile"
```

---

### Task 9: 广场发布验证脚本

**Files:**
- Create: `dsh-plugin-huaanwork/scripts/verify-agent-packages-plaza.mjs`

**Interfaces:**
- Consumes: Task 8 播种脚本；M2 验收先例 `scripts/huaanwork-agent-package-m2-acceptance.mjs` 的全部机制（makeTokens/installKeyring/runCli/requireCliOk/makeDirs/bootCatalog/configureCreator/configureConsumerProfile/adminEnv，逐字复用其形态）；`publishLocalAgentPackage(slug)`、`refreshLocalAgentPackagePublishStatus(slug)`、`installCatalogAgentPackage(slug, version)`、`configureAgentCatalog`、`createAgentCatalogSecurity`、`createAgentPackageActiveTurnRegistry`、`createAgentPackageHost`、`verifyAgentPackageDirectory`、`generateKeyPair`/`fingerprintPublicKeyHex`、`plazaCards`/`packageActions`/`packageActionLabel`（client logic）。
- Produces: CLI `node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs [--keep-catalog] [--out <report.json>]`；exit 0 PASS / 1 FAIL / 3 BLOCKED / 2 usage。`--keep-catalog` 时写 `{outDir}/catalog-connection.json`（baseUrl/port/readToken/keyring/pid）并等待 SIGINT/SIGTERM，供 Task 12 真机走查复用同一 catalog。

**关键事实（已核实，写断言时务必遵守）：**
- catalog 客户端**不回显服务端错误正文**（catalog-client.ts:183-185）：409 legacy-conflict 抛 `AgentCatalogClientError('目录请求失败（HTTP 409）', 'http', 409)`；`publishLocalAgentPackage` 原样重抛（catalog-publish.ts:419-425）。**负例断言 `error.status === 409 && error.code === 'http'`，不断言消息含「标识与目录条目冲突」**（该文案只在服务端，客户端不可见）。
- 广场断言**必须先于安装**：`plazaCards` 把已安装 catalog slug 从摘要卡中排除（agentPackagesLogic.ts:362-374）。
- `packageActionLabel(action, card)` 取**两个**参数；install → "下载"。
- 未安装签名卡：`source:'catalog'`、`installed:false`、`enabled:false`；`packageActions` ⇒ `["install","detail"]`。

- [ ] **Step 1: 写脚本骨架 + Phase A（409 负例）**

新建 `scripts/verify-agent-packages-plaza.mjs`。import 与 helper 形态逐字取自 M2 脚本（下列行号为 M2 脚本锚点，复制时按本脚本路径调整相对深度）：

```js
#!/usr/bin/env node
/**
 * 三个智能体包的广场发布验证（隔离 catalog + 一次性开发密钥）。
 * Phase A: 同名 kind:"tool" legacy 条目 ⇒ publish 必须 409。
 * Phase B: 空 entries ⇒ 播种→发布→CLI 签名批准→广场卡断言（先于安装）→安装→验签→启用。
 * 用法: node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs [--keep-catalog] [--out <report.json>]
 * exit: 0 PASS / 1 FAIL / 3 BLOCKED / 2 usage
 */
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyAgentPackageDirectory } from '@huaanwork/agent-package-format/digest'
import { fingerprintPublicKeyHex, generateKeyPair } from '@huaanwork/catalog-signing'

import { loadAgentCatalogConfig } from '../../agent-catalog-server/src/config.ts'
import { createAgentCatalogRuntime, createAgentCatalogServer } from '../../agent-catalog-server/src/server.ts'
import { configureAgentCatalog } from '../src/huaanwork-host/agent-package/catalog-client.ts'
import { installCatalogAgentPackage } from '../src/huaanwork-host/agent-package/catalog-install.ts'
import {
  publishLocalAgentPackage,
  refreshLocalAgentPackagePublishStatus,
} from '../src/huaanwork-host/agent-package/catalog-publish.ts'
import { createAgentCatalogSecurity } from '../src/huaanwork-host/agent-package/catalog-security.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
} from '../src/huaanwork-host/agent-package/host.ts'
import { agentPackageDir, readAgentPackageState } from '../src/huaanwork-host/agent-package/store.ts'
import { writeHuaanworkSettings } from '../src/huaanwork-host/settings.ts'
import { plazaCards, packageActions, packageActionLabel } from '../src/client-huaanwork/logic/agentPackagesLogic.ts'
import { containsPrivateKey, redactReport, redactSecrets } from './huaanwork-acceptance-redaction.mjs'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..')
const CLI_PATH = join(REPO_ROOT, 'agent-catalog-admin', 'src', 'cli.ts')
const SEED_SCRIPT = join(SCRIPT_DIR, 'seed-agent-packages.mjs')
const FIXTURE_ENTRIES = join(REPO_ROOT, 'agent-catalog-server', 'tests', 'fixtures', 'entries')
const SLUGS = ['typo-check', 'code-review', 'task-orch']
const VERSION = '1.0.0'
const CLI_TIMEOUT_MS = 90_000
const DISPLAY_NAMES = { 'typo-check': '错别字检测', 'code-review': '代码审查', 'task-orch': '任务编排' }

const activeSecrets = []
function log(message) { console.log(`[verify-plaza] ${redactSecrets(message, activeSecrets)}`) }
function registerSecrets(values) { for (const v of values) if (v && !activeSecrets.includes(v)) activeSecrets.push(v) }

function parseArgs(argv) {
  const out = { keepCatalog: false, outPath: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep-catalog') out.keepCatalog = true
    else if (argv[i] === '--out') { out.outPath = argv[i + 1]; i += 1 }
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2) }
  }
  return out
}

function makeTokens() {
  const nonce = randomUUID().replaceAll('-', '')
  return {
    read: `plaza-probe-read-${nonce}-000000000000`,
    publish: `plaza-probe-publish-${nonce}-000000000000`,
    admin: `plaza-probe-admin-${nonce}-000000000000`,
  }
}

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-plaza-verify-'))
  const dirs = {
    root,
    entriesA: join(root, 'entries-a'),
    entriesB: join(root, 'entries-b'),
    data: join(root, 'data'),
    creatorProfile: join(root, 'creator-profile'),
    consumerProfile: join(root, 'consumer-profile'),
    review: join(root, 'review'),
    privateKey: join(root, 'private-key.pem'),
  }
  for (const dir of Object.values(dirs)) if (dir !== root && !dir.endsWith('.pem')) mkdirSync(dir, { recursive: true })
  return dirs
}

function installKeyring(profileDir, publicKeyHex, keyId) {
  writeFileSync(
    join(profileDir, 'agent-catalog-keyring.json'),
    JSON.stringify({ schemaVersion: 1, keys: [{ keyId, publicKeyHex, slot: 1 }] }),
    { encoding: 'utf8', mode: 0o600 },
  )
}

function adminEnv(baseUrl, tokens) {
  return {
    AGENT_CATALOG_URL: baseUrl,
    AGENT_CATALOG_ADMIN_TOKEN: tokens.admin,
    AGENT_CATALOG_TOKEN: tokens.read,
    AGENT_CATALOG_PUBLISH_TOKEN: tokens.publish,
  }
}

function runCli(args, env) {
  const childEnv = { ...process.env, ...env }
  for (const key of Object.keys(childEnv)) if (key.startsWith('AGENT_CATALOG_') && !(key in env)) delete childEnv[key]
  return spawnSync(process.execPath, ['--experimental-strip-types', CLI_PATH, ...args], {
    encoding: 'utf8', env: childEnv, timeout: CLI_TIMEOUT_MS,
  })
}

function requireCliOk(result, secrets) {
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (containsPrivateKey(stdout) || containsPrivateKey(stderr)) throw new Error('CLI output leaked a private key')
  if (result.status !== 0) {
    throw new Error(`CLI failed (${result.status}): ${redactSecrets(stdout + stderr, secrets)}`)
  }
  return { stdout: redactSecrets(stdout, secrets), stderr: redactSecrets(stderr, secrets) }
}

async function bootCatalog(entriesDir, dirs, tokens) {
  const config = loadAgentCatalogConfig({
    HOST: '127.0.0.1', PORT: '18080',
    AGENT_CATALOG_ENTRIES_DIR: entriesDir,
    AGENT_CATALOG_DATA_DIR: dirs.data,
    AGENT_CATALOG_TOKEN: tokens.read,
    AGENT_CATALOG_PUBLISH_TOKEN: tokens.publish,
    AGENT_CATALOG_ADMIN_TOKEN: tokens.admin,
    AGENT_CATALOG_KEYRING_PATH: join(dirs.root, 'keyring.json'),
  })
  const runtime = createAgentCatalogRuntime(config)
  const server = createAgentCatalogServer(runtime, config)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, runtime, config, port, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

function configureCreator(profileDir, port, tokens) {
  return configureAgentCatalog({
    profileDir,
    readSettings: () => ({ agents_host: '127.0.0.1', agents_port: port, agents_catalog_token: tokens.read, agents_catalog_publish_token: tokens.publish }),
    logger: (m) => log(`creator: ${m}`),
  })
}

async function configureConsumerProfile(profileDir, port, tokens) {
  await writeHuaanworkSettings(profileDir, { agents_host: '127.0.0.1', agents_port: port, agents_catalog_token: tokens.read })
  return configureAgentCatalog({
    profileDir,
    readSettings: () => ({ agents_host: '127.0.0.1', agents_port: port, agents_catalog_token: tokens.read, agents_catalog_publish_token: '' }),
    logger: (m) => log(`consumer: ${m}`),
  })
}

function seedCreator(profileDir) {
  const result = spawnSync(process.execPath, ['--experimental-transform-types', SEED_SCRIPT, '--profile', profileDir], {
    encoding: 'utf8', cwd: PACKAGE_ROOT, timeout: 60_000,
  })
  if (result.status !== 0) throw new Error(`seed failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}
```

Phase A 主流程（接在 helper 之后）：

```js
async function phaseA(dirs, tokens, keyring) {
  // 三份同名 kind:"tool" fixture 拷入隔离 entries（仓库 fixture 本身不改）。
  for (const slug of SLUGS) cpSync(join(FIXTURE_ENTRIES, `${slug}.json`), join(dirs.entriesA, `${slug}.json`))
  const catalog = await bootCatalog(dirs.entriesA, dirs, tokens)
  try {
    seedCreator(dirs.creatorProfile)
    configureCreator(dirs.creatorProfile, catalog.port, tokens)
    for (const slug of SLUGS) {
      let rejected = false
      try {
        await publishLocalAgentPackage(slug)
      } catch (error) {
        // 客户端不回显服务端正文：只断言 status/code（见任务头「关键事实」）。
        if (error?.status === 409 && error?.code === 'http') rejected = true
        else throw error
      }
      if (!rejected) throw new Error(`Phase A: ${slug} publish 未被同名 tool 条目拒绝（期望 409）`)
      log(`Phase A OK: ${slug} ⇒ 409 legacy-conflict`)
    }
  } finally {
    await catalog.close()
  }
}
```

- [ ] **Step 2: 写 Phase B（签名链路 + 广场断言 + 安装验签 + 启用）**

```js
async function phaseB(dirs, tokens, keyring, privateKeyPem) {
  const catalog = await bootCatalog(dirs.entriesB, dirs, tokens)
  const steps = {}
  try {
    // creator 已在 Phase A 播种；空 entries 重新配置后发布。
    configureCreator(dirs.creatorProfile, catalog.port, tokens)
    installKeyring(dirs.consumerProfile, keyring.publicKeyHex, keyring.keyId)
    const submissions = {}
    for (const slug of SLUGS) {
      const submission = await publishLocalAgentPackage(slug)
      const entry = readAgentPackageState(dirs.creatorProfile)[`local:${slug}`]
      if (entry?.publishStatus !== 'pending-review') throw new Error(`${slug} publish 未记录 pending-review`)
      submissions[slug] = submission.submissionId
    }
    steps.submitted = submissions

    // admin CLI：pending → review → approve（真实离线签名）。
    const pending = requireCliOk(await runCli(['pending'], adminEnv(catalog.baseUrl, tokens)), activeSecrets)
    for (const slug of SLUGS) {
      if (!pending.stdout.includes(submissions[slug])) throw new Error(`pending 未列出 ${slug}`)
      const reviewDir = join(dirs.review, slug)
      mkdirSync(reviewDir, { recursive: true })
      requireCliOk(await runCli(['review', submissions[slug], '--out', reviewDir], adminEnv(catalog.baseUrl, tokens)), activeSecrets)
      const approve = requireCliOk(await runCli(
        ['approve', submissions[slug], '--review', join(reviewDir, 'review.json'), '--private-key', dirs.privateKey, '--slot', '1', '--yes'],
        adminEnv(catalog.baseUrl, tokens),
      ), activeSecrets)
      if (!approve.stdout.includes(keyring.keyId)) throw new Error(`approve 未打印 ${slug} 的 keyId`)
      const published = await fetchJson(`${catalog.baseUrl}/v1/agent-packages/${slug}/${VERSION}`, { headers: { authorization: `Bearer ${tokens.read}` } })
      if (published.status !== 200 || published.body?.status !== 'published') throw new Error(`${slug} 未 published`)
    }
    steps.reviewedAndSigned = { keyId: keyring.keyId, slugs: SLUGS }

    configureCreator(dirs.creatorProfile, catalog.port, tokens)
    for (const slug of SLUGS) {
      const publication = await refreshLocalAgentPackagePublishStatus(slug)
      if (publication.publishStatus !== 'published') throw new Error(`${slug} creator 状态 ${publication.publishStatus}`)
    }

    // 广场断言必须先于安装（plazaCards 排除已安装 catalog slug）。
    const consumerClient = await configureConsumerProfile(dirs.consumerProfile, catalog.port, tokens)
    const summaries = await consumerClient.listPackages()
    const cardsBefore = plazaCards({ packages: [], catalogAgents: [], catalogPackages: summaries })
    for (const slug of SLUGS) {
      const card = cardsBefore.find((c) => c.slug === slug)
      if (!card) throw new Error(`广场未出现 ${slug} 卡`)
      if (card.source !== 'catalog' || card.installed !== false) throw new Error(`${slug} 卡不是未安装签名卡`)
      if (card.displayName !== DISPLAY_NAMES[slug]) throw new Error(`${slug} displayName 不符: ${card.displayName}`)
      const actions = packageActions(card)
      if (JSON.stringify(actions) !== JSON.stringify(['install', 'detail'])) throw new Error(`${slug} 动作不符: ${actions}`)
      if (packageActionLabel('install', card) !== '下载') throw new Error(`${slug} install 文案不是「下载」`)
    }
    steps.plazaBeforeInstall = cardsBefore.map((c) => ({ slug: c.slug, displayName: c.displayName, installed: c.installed }))

    // 安装 + 状态 + 独立验签。
    for (const slug of SLUGS) {
      const installed = await installCatalogAgentPackage(slug, VERSION)
      if (installed.manifest.version !== VERSION) throw new Error(`${slug} 安装版本不符`)
      const entry = readAgentPackageState(dirs.consumerProfile)[`catalog:${slug}`]
      if (entry?.source !== 'catalog' || entry.enabled !== false) throw new Error(`${slug} 首装必须 catalog+disabled`)
      if (entry.installedVersion !== VERSION || entry.publishStatus !== 'installed') throw new Error(`${slug} 安装状态不符`)
      const verified = verifyAgentPackageDirectory(agentPackageDir(dirs.consumerProfile, slug), [keyring])
      if (verified.signature.keyId !== keyring.keyId) throw new Error(`${slug} 验签 keyId 不符`)
    }
    steps.installedAndVerified = SLUGS

    // 安装后广场不再显示这三张摘要卡。
    const summariesAfter = await consumerClient.listPackages()
    const installedState = readAgentPackageState(dirs.consumerProfile)
    const packagesAfter = SLUGS.map((slug) => ({ slug, source: 'catalog', ...installedState[`catalog:${slug}`] }))
    const cardsAfter = plazaCards({ packages: packagesAfter, catalogAgents: [], catalogPackages: summariesAfter })
    for (const slug of SLUGS) if (cardsAfter.some((c) => c.slug === slug)) throw new Error(`${slug} 安装后仍在广场摘要卡中`)
    steps.plazaAfterInstall = 'installed slugs excluded'

    // 宿主接线 + 启用（与 index.ts boot 同形）。
    const activeTurns = createAgentPackageActiveTurnRegistry()
    const security = createAgentCatalogSecurity({ profileDir: dirs.consumerProfile, registry: activeTurns, client: consumerClient })
    const host = createAgentPackageHost({ profileDir: dirs.consumerProfile, takenSlugs: () => [], activeTurns, security })
    for (const slug of SLUGS) {
      await host.setEnabled(slug, true)
      const entry = readAgentPackageState(dirs.consumerProfile)[`catalog:${slug}`]
      if (entry.enabled !== true) throw new Error(`${slug} 启用失败`)
    }
    steps.enabled = SLUGS

    return { catalog, steps }
  } catch (error) {
    await catalog.close()
    throw error
  }
}
```

- [ ] **Step 3: 写主入口（密钥生成 + 脱敏报告 + --keep-catalog）**

```js
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dirs = makeDirs()
  const tokens = makeTokens()
  const keyPair = generateKeyPair()
  const keyId = fingerprintPublicKeyHex(keyPair.publicKeyHex)
  const keyring = { keyId, publicKeyHex: keyPair.publicKeyHex, slot: 1 }
  writeFileSync(dirs.privateKey, keyPair.privateKeyPem, { encoding: 'utf8', mode: 0o600 })
  registerSecrets([tokens.read, tokens.publish, tokens.admin, keyPair.privateKeyPem])

  const report = { outcome: 'PASS', phases: {}, startedAt: new Date().toISOString() }
  let keepHandle = null
  try {
    await phaseA(dirs, tokens, keyring)
    report.phases.legacyConflict = 'PASS (409 for all three slugs)'
    const { catalog, steps } = await phaseB(dirs, tokens, keyring, keyPair.privateKeyPem)
    report.phases = { ...report.phases, ...steps }

    if (args.keepCatalog) {
      const connection = {
        baseUrl: catalog.baseUrl, port: catalog.port, readToken: tokens.read,
        keyring: { keyId, publicKeyHex: keyPair.publicKeyHex, slot: 1 }, pid: process.pid,
      }
      const connectionPath = join(dirs.root, 'catalog-connection.json')
      writeFileSync(connectionPath, JSON.stringify(connection, null, 2), 'utf8')
      log(`--keep-catalog: connection written to ${connectionPath}; waiting for SIGINT/SIGTERM`)
      report.connectionPath = connectionPath
      await new Promise((resolve) => {
        keepHandle = resolve
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
      await catalog.close()
    } else {
      await catalog.close()
    }
  } catch (error) {
    report.outcome = 'FAIL'
    report.error = redactSecrets(String(error?.stack ?? error), activeSecrets)
    process.exitCode = 1
  } finally {
    if (!args.keepCatalog) rmSync(dirs.root, { recursive: true, force: true })
    const safe = redactReport(report, activeSecrets)
    const text = JSON.stringify(safe, null, 2)
    if (args.outPath) writeFileSync(args.outPath, text, 'utf8')
    console.log(text)
  }
}

main().catch((error) => { console.error(redactSecrets(String(error), activeSecrets)); process.exit(1) })
```

- [ ] **Step 4: 跑脚本确认 PASS**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs --out /tmp/plaza-verify-report.json`
Expected: exit 0；报告 `outcome:"PASS"`，`phases.legacyConflict` 含 409，`plazaBeforeInstall` 三张中文 displayName 卡，`installedAndVerified`/`enabled` 三 slug。报告与 stdout 经脱敏，无 token/私钥。

- [ ] **Step 5: 验证 --keep-catalog 形态（供 Task 12）**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs --keep-catalog --out /tmp/plaza-keep-report.json`（后台运行，记录 connectionPath；确认 catalog-connection.json 存在且含 baseUrl/port/readToken/keyring/pid；随后向该 pid 发 SIGTERM 确认优雅退出、临时目录保留）。
Expected: 连接文件可被 Task 12 读取；SIGTERM 后进程退出。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/scripts/verify-agent-packages-plaza.mjs
git commit -m "feat(scripts): verify three-package plaza publish chain with dev keypair"
```

---

### Task 10: 全量门禁 + 证据文档

**Files:**
- Create: `docs/evidence/2026-11-11-three-agent-packages.md`

**Interfaces:**
- Consumes: Task 1–9 全部代码与脚本。
- Produces: 门禁退出码记录 + 证据文档（逐项命令/退出码/产物指针；能力披露口径订正、Windows BLOCKED、verify:aa flaky 处置如实登记）。

- [ ] **Step 1: 跑 typecheck**

Run: `corepack yarn typecheck`
Expected: exit 0。失败则修复后重跑（只改本任务文件）。

- [ ] **Step 2: 跑 test**

Run: `corepack yarn test`
Expected: exit 0，全部 workspace 测试绿（含新增 lineage/sources/seed/policy 测试与既有钉子零改动）。

- [ ] **Step 3: 跑完整 check**

Run: `corepack yarn check`
Expected: exit 0。若 `verify:aa` 因已登记并发竞态失败（AGENTS.md 债表），隔离重跑 `corepack yarn workspace dsh-plugin-huaanwork verify:aa` 并在证据中如实记录「并发竞态 flaky，隔离重跑通过」；其他步骤失败必须修复，不得绕过。

- [ ] **Step 4: 写证据文档**

新建 `docs/evidence/2026-11-11-three-agent-packages.md`，逐节记录：
- 运行时扩展 C1–C5：每项对应 commit、测试文件、退出码。
- 三包源文件：manifest 字段、预算实测字节数（从 sources 测试输出取）。
- 播种/发布验证：Task 8 测试退出码、Task 9 脚本报告指针（/tmp/plaza-verify-report.json 内容摘要，脱敏）。
- 门禁：typecheck/test/check 三条命令与退出码；verify:aa 处置（如有）。
- **能力披露口径订正**：spec §5.0/§7.3「安装/启用对话框披露」与 UI 现实的差异（签名包无安装/启用对话框；披露面为详情对话框；未安装=包信息+INSTALL_DETAIL_NOTICE，已安装=工具"无"+PACKAGE_SANDBOX_WARNING+验签结果），按 Global Constraints 订正条执行。
- Windows：pwsh 提取与 win32 allow 形态单元测试覆盖；真机项 BLOCKED（R-ACCEPT-1 豁免先例，无第二台 Windows 机器）。
- 待补：Task 11 评审结论、Task 12 真机走查、Task 13 备份删除（后续任务完成后回填）。

- [ ] **Step 5: Commit**

```bash
git add docs/evidence/2026-11-11-three-agent-packages.md
git commit -m "docs(evidence): record gates and verification for three agent packages"
```

---

### Task 11: 独立代码评审（安全敏感文件）

**Files:**
- 评审对象: `runtime.ts`/`holders.ts`/`host.ts`/`skills.ts`/`policy.ts` + 对应测试（Task 1–4 改动）
- 可能修改: 上述文件（按评审 P0/P1 发现修复）

**Interfaces:**
- Consumes: Task 1–4 的 commit 范围。
- Produces: 评审结论（经反证校准）+ P0/P1 修复 commit + 证据文档评审节回填。

- [ ] **Step 1: 发起独立评审**

REQUIRED SUB-SKILL: `superpowers:requesting-code-review`。评审范围 = Task 1–4 的五个运行时文件与测试。评审提示须包含：
- spec §4.2 C1–C5 与 §4.3 不变量全文；
- 上游 restrict 组合语义锚点（`deepseek-harness/packages/core/tools/src/index.ts:1105`「Restrictions intersect」，disposer 只解除本层）；
- 重点核查：引用同一性清理是否误清并发回合；血缘分支是否漏掉 legacy/pkg 优先；C5 是否对直接子会话有意收紧且不改已收窄行为；孙代是否可能拿到 call_host_tool/未挂载运行时工具；tools/change 后收窄是否保持。

- [ ] **Step 2: 反证校准评审结论**

对每条发现先反证（是否误读？是否有既有钉子覆盖？严重度是否夸大？），校准后再处置。他方结论先复核证据链，不盲从。

- [ ] **Step 3: 修复 P0/P1 并补回归钉**

每条 P0/P1 修复附回归测试；修复后重跑 `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails tests/huaanwork-host/agent-package-runtime.spec.ts` 确认绿。P2/P3 登记为债或当场小修（不扩大范围）。

- [ ] **Step 4: 回填证据 + Commit**

证据文档补「独立评审」节：评审范围、发现清单（严重度+反证结论）、修复 commit、重跑退出码。

```bash
git add docs/evidence/2026-11-11-three-agent-packages.md
git commit -m "docs(evidence): record independent security review of runtime extension"
```

（若 Step 3 改了运行时文件，相应 src/test 一并 add 进修复 commit。）

---

### Task 12: 真机走查脚本（CDP）+ 执行

**Files:**
- Create: `dsh-plugin-huaanwork/scripts/huaanwork-accept-three-packages.mjs`

**Interfaces:**
- Consumes: Task 9 `--keep-catalog` 的 `catalog-connection.json`；GUI 走查先例 `scripts/huaanwork-subagent-run-windows-acceptance.mjs` 的 helper（逐字复制下列行号范围，按本脚本适配）：`writeAuthState`(:131-144)、`setupWizardStatePath`(:146-149)、`prepareProfile`(:151-218，模型设置改为只读复制生产)、`freePort`(:220-232)、`launchApp`(:234-271)、`mainPathArg`(:273-276)、`listPageTargets`(:278-287)、`connectCdp`(:289-348)、`APP_PROBE`(:350-357)、`waitFor`(:389-398)、`connectAppPage`(:400-432)、`ensureLoggedIn`(:434-465)、`sendText`(:478-498)、`waitForComposerIdle`(:471-476)、`appVersions`(:121-129)。
- Produces: CLI `node scripts/huaanwork-accept-three-packages.mjs --connection <catalog-connection.json> --out <dir> [--timeout <ms>]`；exit 0 PASS / 1 FAIL / 3 BLOCKED。截图 + 事实报告落 out 目录。

**关键事实（务必遵守）：**
- @ 派发只用 slug：`@typo-check`/`@code-review`/`@task-orch`（dispatch 正则 `AT_INVOKE_RE` 不认中文 displayName）。
- 回到聊天输入框：点 `button[title="新建任务"]`（App.tsx:3509，newTask 设 view "main"）。
- 广场卡 DOM：`.agent-plaza-panel .skill-card[data-slug]`，`.nm` = displayName；动作按钮 `.agent-package-actions button.filter-tab`（查看详情/下载）。
- 我的智能体页：`.agent-packages-panel`，启用按钮文案「启用」。
- 详情对话框：`.settings-overlay[role="dialog"][aria-label="智能体详情：<displayName>"]`，关闭按钮文案「关闭」。
- 运行卡：`.subagent-run-card[data-phase]`；**lane 无运行卡**，lane 计数经 zstd 会话日志 subagent tool/call。
- 模型设置只读复制 `~/.huaanwork/profiles/desktop/huaanwork-settings.json`（绝不打印 api_key；缺失 ⇒ BLOCKED exit 3）；全链路用 deepseek-chat。
- 样例 docx 用 `textutil -convert docx` 从含已知错别字的 txt 生成（按装/银行帐户/市市场/我们将我们/Managment/２０２５/在次），**不用真实基金报告**。

- [ ] **Step 1: 写脚本骨架（helper 复制 + 隔离 profile + 样例生成）**

新建 `scripts/huaanwork-accept-three-packages.mjs`。helper 按 Interfaces 所列行号范围从 Windows 先例脚本逐字复制（`prepareProfile` 的模型设置段改为：读生产 `huaanwork-settings.json` → 只取 base_url/model/api_key/models/active_model_id/allow_network 写入隔离 profile，绝不打印 api_key；生产文件缺失 ⇒ 报告 BLOCKED、exit 3）。新增本脚本专属逻辑：

```js
const AUTH_USERNAME = 'acceptance'
const AUTH_PASSWORD = 'acceptance-pass-1'
const SLUGS = ['typo-check', 'code-review', 'task-orch']
const DISPLAY_NAMES = { 'typo-check': '错别字检测', 'code-review': '代码审查', 'task-orch': '任务编排' }
const INSTALL_DETAIL_NOTICE = '安装后可查看签名与文件清单'
const PACKAGE_SANDBOX_WARNING = '脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。'

function parseArgs(argv) {
  const out = { connection: null, outDir: null, timeout: 180_000 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--connection') { out.connection = argv[i + 1]; i += 1 }
    else if (argv[i] === '--out') { out.outDir = argv[i + 1]; i += 1 }
    else if (argv[i] === '--timeout') { out.timeout = Number(argv[i + 1]); i += 1 }
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2) }
  }
  if (!out.connection || !out.outDir) { console.error('usage: --connection <json> --out <dir>'); process.exit(2) }
  return out
}

/** 生成含已知错别字的样例 docx（textutil，零依赖；不用真实基金报告）。 */
function makeSampleDocx(workDir) {
  const txt = join(workDir, 'sample.txt')
  const docx = join(workDir, 'sample.docx')
  writeFileSync(txt, [
    '本设备按装完毕，运行良好。',
    '银行帐户余额核对无误。',
    '积极应对市市场波动。',
    '我们将我们持续披露信息。',
    'Managment Report 已提交。',
    '截至２０２５年 6 月 30 日。',
    '在次提醒投资者注意风险。',
  ].join('\n'), 'utf8')
  const result = spawnSync('textutil', ['-convert', 'docx', '-output', docx, txt], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`textutil failed: ${result.stderr}`)
  return docx
}

function makeSampleCode(workDir) {
  const file = join(workDir, 'sample-review.js')
  writeFileSync(file, [
    "const apiKey = 'sk-hardcoded-secret-12345';",
    "function run(userInput) {",
    "  return eval(userInput);",
    "}",
    "module.exports = { run, apiKey };",
  ].join('\n'), 'utf8')
  return file
}
```

隔离 profile 准备：`initProfile(profileDir, ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'])`（从 `@deepseek-ai/dsh-app-boot`）；profileDir = homeDir/profiles/desktop；settings.json 落 dirname(homeDir)；scrypt 认证（writeAuthState）；wizard skip state（setupWizardStatePath）；keyring 从 connection.keyring 写入 `agent-catalog-keyring.json`；agents_host/agents_port/agents_catalog_token 从 connection 写入 huaanwork-settings.json；agents-state.json 初始为空 `{}`（让广场卡走「未安装→下载」真实路径）。

- [ ] **Step 2: 写驱动序列（广场→详情→下载→启用→详情→三包对话）**

```js
async function drive(client, ctx) {
  const facts = { plaza: [], installs: [], enables: [], details: [], runs: [] }
  const shot = async (name) => { /* CDP Page.captureScreenshot → join(ctx.outDir, `${name}.png`) */ }

  // 1. 进入智能体广场。
  await client.evaluate(`document.querySelector('button[title="智能体"]').click()`)
  await waitFor('plaza cards', async () => {
    const cards = await client.evaluate(`[...document.querySelectorAll('.agent-plaza-panel .skill-card')].map((el) => ({ slug: el.dataset.slug, name: el.querySelector('.nm')?.textContent }))`)
    return { ok: SLUGS.every((slug) => cards.some((c) => c.slug === slug)), value: cards }
  }, ctx.timeout, 500)
  const plazaCards = await client.evaluate(`[...document.querySelectorAll('.agent-plaza-panel .skill-card')].map((el) => ({ slug: el.dataset.slug, name: el.querySelector('.nm')?.textContent }))`)
  for (const slug of SLUGS) {
    const card = plazaCards.find((c) => c.slug === slug)
    if (card?.name !== DISPLAY_NAMES[slug]) throw new Error(`广场 ${slug} displayName 不符: ${card?.name}`)
  }
  facts.plaza = plazaCards
  await shot('01-plaza')

  // 2. 未安装详情：只有包信息 + INSTALL_DETAIL_NOTICE（无签名/文件清单）。
  for (const slug of SLUGS) {
    await client.evaluate(`document.querySelector('.agent-plaza-panel .skill-card[data-slug="${slug}"] .agent-package-actions button.filter-tab:last-child').click()`)
    await waitFor(`detail ${slug}`, async () => {
      const text = await client.evaluate(`document.querySelector('.settings-overlay[role="dialog"]')?.textContent ?? ''`)
      return { ok: text.includes(INSTALL_DETAIL_NOTICE), value: text }
    }, 30_000, 300)
    await shot(`02-detail-pre-${slug}`)
    await client.evaluate(`[...document.querySelectorAll('.settings-overlay button')].find((b) => b.textContent.trim() === '关闭')?.click()`)
  }

  // 3. 下载 ×3（直接按钮，无确认对话框）。
  for (const slug of SLUGS) {
    await client.evaluate(`[...document.querySelectorAll('.agent-plaza-panel .skill-card[data-slug="${slug}"] .agent-package-actions button')].find((b) => b.textContent.trim() === '下载')?.click()`)
    await waitFor(`install note ${slug}`, async () => {
      const text = await client.evaluate(`document.body.textContent`)
      return { ok: text.includes(`已下载「${DISPLAY_NAMES[slug]}」`), value: true }
    }, 60_000, 500)
    facts.installs.push(slug)
  }
  await shot('03-after-install')

  // 4. 我的智能体 → 启用 ×3。
  await client.evaluate(`[...document.querySelectorAll('.filter-tab')].find((b) => b.textContent.includes('我的智能体'))?.click()`)
  for (const slug of SLUGS) {
    await waitFor(`enable button ${slug}`, async () => {
      const ok = await client.evaluate(`!![...document.querySelectorAll('.agent-packages-panel .skill-card[data-slug="${slug}"] button')].find((b) => b.textContent.trim() === '启用')`)
      return { ok, value: ok }
    }, 30_000, 300)
    await client.evaluate(`[...document.querySelectorAll('.agent-packages-panel .skill-card[data-slug="${slug}"] button')].find((b) => b.textContent.trim() === '启用')?.click()`)
    await waitFor(`enable note ${slug}`, async () => {
      const text = await client.evaluate(`document.body.textContent`)
      return { ok: text.includes(`已启用「${DISPLAY_NAMES[slug]}」`), value: true }
    }, 30_000, 500)
    facts.enables.push(slug)
  }
  await shot('04-enabled')

  // 5. 已安装详情：验签结果：通过 + 工具「无」+ 沙箱警告。
  for (const slug of SLUGS) {
    await client.evaluate(`[...document.querySelectorAll('.agent-packages-panel .skill-card[data-slug="${slug}"] button')].find((b) => b.textContent.trim() === '查看详情')?.click()`)
    await waitFor(`installed detail ${slug}`, async () => {
      const text = await client.evaluate(`document.querySelector('.settings-overlay[role="dialog"]')?.textContent ?? ''`)
      return { ok: text.includes('验签结果：通过') && text.includes(PACKAGE_SANDBOX_WARNING), value: text }
    }, 30_000, 300)
    const detailText = await client.evaluate(`document.querySelector('.settings-overlay[role="dialog"]')?.textContent ?? ''`)
    if (!detailText.includes('无')) throw new Error(`${slug} 详情工具行未显示「无」`)
    facts.details.push({ slug, verified: true, sandboxWarning: true })
    await shot(`05-detail-post-${slug}`)
    await client.evaluate(`[...document.querySelectorAll('.settings-overlay button')].find((b) => b.textContent.trim() === '关闭')?.click()`)
  }

  // 6. 回到聊天，逐包派发（slug-only @）。
  const prompts = {
    'typo-check': `@typo-check 检测这个文件夹里的 Word 文档：${ctx.sampleDir}`,
    'code-review': `@code-review 审查这个文件：${ctx.sampleCode}`,
    'task-orch': '@task-orch 把「为市场模块增加离线缓存」拆解为可实施的执行计划，给出依赖、每步验收标准与调度建议。',
  }
  for (const slug of SLUGS) {
    await client.evaluate(`document.querySelector('button[title="新建任务"]').click()`)
    await waitForComposerIdle(client)
    await sendText(client, prompts[slug])
    // 运行卡完成（硬断言）；lane 无运行卡，计数经会话日志（Step 3）。
    await waitFor(`run card ${slug}`, async () => {
      const cards = await client.evaluate(`[...document.querySelectorAll('.subagent-run-card')].map((el) => ({ label: el.textContent, phase: el.dataset.phase }))`)
      const match = cards.filter((c) => c.label.includes(`@${slug}`))
      const done = match.find((c) => c.phase === 'completed' || c.phase === 'done')
      return { ok: !!done, value: cards }
    }, ctx.timeout, 1000)
    facts.runs.push({ slug, completed: true })
    await shot(`06-run-${slug}`)
  }
  return facts
}
```

- [ ] **Step 3: 写 lane 观测 + 主入口 + 清理**

lane 观测（typo-check 运行后）：定位隔离 profile 的会话日志（`{homeDir}/profiles/desktop/.../sessions/` 下最新会话），用 **zstd CLI 多帧解压**（`zstd -d -c <file>`，Node zlib 只解首帧不可用）读日志，统计 `subagent` 工具的 tool/call 次数 ⇒ 期望 ≥2（两个 lane）。把计数记入 facts（模型输出质量记为事实，不做硬断言；lane 计数 <2 记 FAIL）。

主入口：读 connection → 准备隔离 profile（模型设置缺失 ⇒ BLOCKED exit 3）→ 生成样例 → build workspace + prepare:electron-native（若 lib/ 已存在可跳过 build，但须记录）→ launchApp（清 ELECTRON_RUN_AS_NODE/NODE_OPTIONS，DSH_TELEMETRY_DISABLED=1，--remote-debugging-port，--disable-gpu --no-first-run --disable-background-timer-throttling --disable-renderer-backgrounding）→ connectAppPage → ensureLoggedIn → drive → 写 facts 报告（脱敏）→ finally 只 kill 自己启动的 app 进程 + 向 connection.pid 发 SIGTERM。exit 0/1/3。

- [ ] **Step 4: 启动 keep-catalog 并跑真机走查**

先后台启动 Task 9 的 `--keep-catalog`（记录 connectionPath），再：
Run: `corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-three-packages.mjs --connection <connectionPath> --out /tmp/three-packages-accept`
Expected: exit 0；facts 含三张中文广场卡、三次下载/启用、详情验签通过+工具无+沙箱警告、三包运行卡 completed、typo-check lane 计数 ≥2。截图落 out 目录。

- [ ] **Step 5: 回填证据 + Commit**

证据文档补「真机走查」节：命令、退出码、facts 摘要、截图指针、lane 计数、模型输出事实摘录（脱敏）、能力披露真实形态确认。Windows 真机项记 BLOCKED。

```bash
git add dsh-plugin-huaanwork/scripts/huaanwork-accept-three-packages.mjs docs/evidence/2026-11-11-three-agent-packages.md
git commit -m "feat(scripts): CDP acceptance walkthrough for three plaza agent packages"
```

---

### Task 13: 原目录备份 + owner 再次确认 + 删除

**Files:**
- 仓库外: `~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz`
- Modify: `docs/evidence/2026-11-11-three-agent-packages.md`（清理节）

**Interfaces:**
- Consumes: Task 10–12 验证全部通过（或 BLOCKED 项经 owner 接受）。
- Produces: 备份 tar + sha256 + owner 明确同意记录 + 三目录删除。

**安全约束（绝不违反）：** 三个目录均无 git remote，备份是唯一安全网；**未经 owner 再次明确确认绝不删除**；含 typo `data/` 真实基金报告与 orch.db 248MB 历史。

- [ ] **Step 1: 备份**

Run:
```bash
tar -czf ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz -C ~/Downloads/cursor 错别字检测智能体 代码审查智能体 任务编排智能体
```
Expected: exit 0，备份落仓库外。

- [ ] **Step 2: 校验备份完整性**

Run: `tar -tzf ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz | head -50`（确认三目录条目齐全）+ `shasum -a 256 ~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz`（记录哈希）。
Expected: 列表含三目录；哈希记入证据。

- [ ] **Step 3: owner 再次确认（硬门禁）**

用 AskUserQuestion 向 owner 明示：备份位置与 sha256、删除范围（三个目录绝对路径）、三目录无 git remote（备份是唯一安全网）、验证结论（含 BLOCKED 项）。**只有 owner 明确同意才进入 Step 4**；不同意则保留目录、记录裁定。

- [ ] **Step 4: 删除（仅在 owner 明确同意后）**

Run:
```bash
rm -rf ~/Downloads/cursor/错别字检测智能体 ~/Downloads/cursor/代码审查智能体 ~/Downloads/cursor/任务编排智能体
```
Expected: 三目录删除；备份仍在。

- [ ] **Step 5: 回填证据 + Commit**

证据文档补「原目录清理」节：备份路径、sha256、tar 校验结果、owner 确认记录（日期+裁定）、删除执行结果。

```bash
git add docs/evidence/2026-11-11-three-agent-packages.md
git commit -m "docs(evidence): record backup, owner confirmation and original directory cleanup"
```

---

## Self-Review（写计划后自查，已执行）

**1. Spec coverage：**
- §4.2 C1→Task 1；C2+C3→Task 2；C4→Task 3；C5→Task 4。✓
- §4.4 测试矩阵 8 项：1→Task 1 平台测试；2/3/5/6/8→Task 3 八测试；4→Task 4；7→Task 3 基线/legacy 测试 + 既有钉子零改动。✓（矩阵 6「清理/id 复用」由 Task 2 引用清理测试 + Task 4 map.delete 后回 ask 覆盖。）
- §5.0 共同形态→Task 5–7 manifest/预算/内联；§5.1→Task 5；§5.2→Task 6；§5.3→Task 7。✓
- §6.1 播种→Task 8；发布验证→Task 9；旧条目 fixture 保留→Task 9 Phase A 拷贝不改仓库。✓
- §6.2 正式上架 owner 运维→Global Constraints（不生成生产私钥）+ Task 9 409 负例证明退役必要性。✓
- §7.1 单元→Task 1–9；§7.2 门禁→Task 10；§7.3 真机→Task 12；§7.4 独立评审→Task 11；§7.5 Windows→Task 1 平台测试 + Task 10/12 BLOCKED；§7.6 证据→Task 10。✓
- §8 备份删除→Task 13。✓
- §9 边界→Global Constraints + 各包 SKILL.md 边界节。✓
- **口径订正**：§5.0/§7.3「安装/启用对话框披露」与 UI 现实差异已在 Global Constraints 订正条 + Task 12 真实 DOM 断言中诚实处理。✓

**2. Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码；Task 12 helper 复制给出精确源文件+行号范围（可验证引用，非未定义符号）；驱动序列/样例/主入口逻辑完整。✓

**3. Type consistency：** `huaanworkPackageChildAllow: Map<string, readonly string[]>` 在 C2/C3/C4/C5 四处同名同型；`composeAgentPackageToolAllowList` 返回顺序 Task 1 定义、Task 2/3 断言一致；`packageActionLabel(action, card)` 两参；`plazaCards({packages,catalogAgents,catalogPackages})` 三字段；`publishLocalAgentPackage(slug)`/`installCatalogAgentPackage(slug,version)`/`refreshLocalAgentPackagePublishStatus(slug)` 签名与源码一致；`AgentPackageDetail` 无 manifest 字段 ⇒ seed 测试经 readAgentPackageFile 读 agent.json。✓

**4. 写后对源码复核订正（已修）：** 对照 `packages/huaanwork-policy/src/decide.ts` 判定表与 `skills.ts` 包装实测，修正三处测试断言：
- Task 4 放行样例 `read`→`glob`：`read` 空参经 `pathsAreInside(…,false,false)` 返回路径越界 **deny**（非 allow）；`glob` 的 `allowMissing=true`，空参即 allow，且 glob 在继承 allow 内，能干净验证「血缘层不拦 allow 内工具」。
- Task 4 ask 基线 `write`→`git_push`（普通会话与清理后两处）：`write` 空参同样路径越界 deny，无法体现 smart 档 ask；`git_push` 不检查参数、smart 档恒 ask，且不在继承 allow 内，清理前会被血缘 deny、清理后回 ask，正确证明「标志非永久」。
- Task 3 包优先测试：pkg 分支命中时 C4 跳过、fake bindChild 只记录调用 ⇒ 血缘 map 无孙代条目，断言改为 `has(grandchildId)===false` + `get(parentSessionId)===allow` + `size===1`。
- Task 3 跨包隔离测试：删除「替换 startActivation 后重新 applySkills」（会叠加事件监听器造成双重收窄），改为 harness 暴露 `agentsById`、登记 `grandchild-b` 后直接两次 activateOf（既有 fake 按 agentsById 解析 localAgent）。✓