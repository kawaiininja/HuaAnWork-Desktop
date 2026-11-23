// @vitest-environment jsdom
/**
 * 专家团管理页组件级 spec（Task 14）：列表状态、结构化编辑器联动、成员排序、
 * 损坏记录删除、启停后 @ 可选列表排除、未保存离开与字段错误草稿保留。
 *
 * 真实组件 + fake `expertTeam.*` RPC。Harness 只通过 DOM 与记录到的调用操作，
 * 不直接改编辑器 state；fake host 维护定义行与启停状态，供列表刷新与
 * `expertTeam.invocableList` 消费。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
}));

import { rpcCall } from "../../src/client-huaanwork/api.ts";
import ExpertTeamsView, {
  type ExpertTeamAvailability,
  type ExpertTeamListResult,
  type ExpertTeamListRow,
  type ExpertTeamSelectablePackage,
  type ExpertTeamWriteResult,
} from "../../src/client-huaanwork/ExpertTeamsView.tsx";
import type { ExpertTeam, ExpertTeamMember } from "../../src/client-huaanwork/rpc-types.ts";
import { validTeamInput } from "../fixtures/expert-team/team.ts";

declare module "vitest" {
  // 与 Vitest 自带 Assertion 的泛型默认值保持一致；仅补齐本 spec 用到的 DOM 断言。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toBeDisabled(): T;
    toHaveValue(value: string): T;
  }
}

expect.extend({
  toBeDisabled(received) {
    const element = received as { disabled?: boolean };
    const pass = element.disabled === true;
    return {
      pass,
      message: () => `expected element ${pass ? "not " : ""}to be disabled`,
    };
  },
  toHaveValue(received, expected) {
    const element = received as { value?: string };
    const pass = element.value === expected;
    return {
      pass,
      message: () => `expected value ${String(element.value)} to be ${String(expected)}`,
    };
  },
});

/**
 * 同步 thenable：初版列表在 `act(() => root.render(...))` 内同步落进组件的
 * effect，`harness.text()` 才能在首个 await 之前读到列表。真实 rpcCall 仍是
 * 普通 Promise；harness 的 click/fill 都会 flush 微任务。
 */
function immediatePromise<T>(value: T): Promise<T> {
  const promise: Promise<T> = {
    then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return onfulfilled
        ? immediatePromise<TResult1 | TResult2>(onfulfilled(value) as TResult1 | TResult2)
        : (promise as Promise<TResult1 | TResult2>);
    },
    catch<TResult = never>(
      _onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<T | TResult> {
      return promise;
    },
    finally(onfinally?: (() => void) | null): Promise<T> {
      onfinally?.();
      return promise;
    },
    [Symbol.toStringTag]: "Promise",
  };
  return promise;
}

const PACKAGES: ExpertTeamSelectablePackage[] = [
  {
    slug: "writer",
    displayName: "合同条款提取员",
    source: "local",
    version: "1.0.0",
    description: "提取合同关键条款",
    capabilities: { tools: "none", skillScripts: [] },
  },
  {
    slug: "writer-2",
    displayName: "业务数据检查员",
    source: "local",
    version: "1.1.0",
    description: "核对业务数据口径",
    capabilities: { tools: "http", skillScripts: ["check.ts"] },
  },
  {
    slug: "reviewer",
    displayName: "合规审查员",
    source: "catalog",
    version: "2.0.0",
    description: "统一合规审查与风险标注",
    capabilities: { tools: "both", skillScripts: ["compliance.py"] },
  },
];

function invocableAvailability(team: ExpertTeam): ExpertTeamAvailability {
  return {
    kind: "invocable",
    invocable: true,
    reasons: [],
    members: team.members.flatMap((member) => {
      const pkg = PACKAGES.find(
        (candidate) => candidate.source === member.agentRef.source && candidate.slug === member.agentRef.slug,
      );
      if (!pkg) return [];
      const resolved: ExpertTeamAvailability["members"][number] = {
        memberId: member.memberId,
        displayName: pkg.displayName,
        version: pkg.version,
      };
      if (pkg.capabilities !== undefined) resolved.capabilities = pkg.capabilities;
      return [resolved];
    }),
  };
}

function validTeamRecord(): ExpertTeamListRow {
  const team = validTeamInput();
  return { id: team.id, team, availability: invocableAvailability(team) };
}

function teamWithMissingMember(): ExpertTeamListRow {
  const team = validTeamInput({
    slug: "missing-member-team",
    members: [
      {
        memberId: "m-exec-1",
        agentRef: { source: "local", slug: "writer" },
        role: "executor",
        responsibility: "提取合同关键条款",
      },
      {
        memberId: "m-rev-1",
        agentRef: { source: "local", slug: "ghost-reviewer" },
        role: "reviewer",
        responsibility: "统一合规审查",
      },
    ],
  });
  return {
    id: team.id,
    team,
    availability: {
      kind: "member-invalid",
      invocable: false,
      reasons: ["expert-team-member-missing"],
      members: [
        { memberId: "m-exec-1", displayName: "合同条款提取员", version: "1.0.0" },
        { memberId: "m-rev-1", displayName: "ghost-reviewer", reason: "expert-team-member-missing" },
      ],
    },
  };
}

function incompleteTeamRecord(id: string): ExpertTeamListRow {
  const team = validTeamInput({
    id,
    slug: "incomplete-team",
    name: "",
    description: "",
    members: [],
  });
  return {
    id,
    team,
    availability: {
      kind: "incomplete",
      invocable: false,
      reasons: ["expert-team-invalid"],
      members: [],
    },
  };
}

function corruptTeamRecord(id: string): ExpertTeamListRow {
  return {
    id,
    error: "expert-team-corrupt",
    availability: {
      kind: "incomplete",
      invocable: false,
      reasons: ["expert-team-corrupt"],
      members: [],
    },
  };
}

type RenderOptions = {
  teams?: ExpertTeamListRow[];
  packages?: ExpertTeamSelectablePackage[];
  createResult?: ExpertTeamWriteResult;
};

type RecordedUpdate = { id: string; patch: Record<string, unknown> };

type FakeHost = {
  teams: ExpertTeamListRow[];
  creates: Record<string, unknown>[];
  updates: RecordedUpdate[];
  removes: Record<string, unknown>[];
  createResult?: ExpertTeamWriteResult;
};

let host: FakeHost;

function cloneRow(row: ExpertTeamListRow): ExpertTeamListRow {
  return {
    ...row,
    availability: {
      ...row.availability,
      reasons: [...row.availability.reasons],
      members: row.availability.members.map((member) => ({ ...member })),
    },
    ...(row.team === undefined
      ? {}
      : {
          team: {
            ...row.team,
            members: row.team.members.map((member) => ({
              ...member,
              agentRef: { ...member.agentRef },
            })),
            orchestration: { ...row.team.orchestration },
            review: { ...row.team.review },
            summary: { ...row.team.summary },
          },
        }),
  };
}

function teamFromCreate(body: Record<string, unknown>, index: number): ExpertTeam {
  const team = validTeamInput({
    id: `created-team-${index}`,
    slug: typeof body.slug === "string" ? body.slug : `team-${index}`,
    name: typeof body.name === "string" ? body.name : "",
    description: typeof body.description === "string" ? body.description : "",
    members: Array.isArray(body.members) ? (body.members as ExpertTeamMember[]) : [],
    orchestration: (body.orchestration as ExpertTeam["orchestration"] | undefined) ?? validTeamInput().orchestration,
    review: (body.review as ExpertTeam["review"] | undefined) ?? validTeamInput().review,
    summary: (body.summary as ExpertTeam["summary"] | undefined) ?? validTeamInput().summary,
  });
  if (typeof body.scenarios === "string") team.scenarios = body.scenarios;
  team.enabled = body.enabled === true;
  return team;
}

function applyUpdate(row: ExpertTeamListRow, body: Record<string, unknown>): ExpertTeam | undefined {
  if (row.team === undefined) return undefined;
  const next: ExpertTeam = { ...row.team };
  if (typeof body.name === "string") next.name = body.name;
  if (typeof body.description === "string") next.description = body.description;
  if (typeof body.scenarios === "string") next.scenarios = body.scenarios;
  if (Array.isArray(body.members)) next.members = body.members as ExpertTeamMember[];
  if (body.orchestration !== undefined) next.orchestration = body.orchestration as ExpertTeam["orchestration"];
  if (body.review !== undefined) next.review = body.review as ExpertTeam["review"];
  if (body.summary !== undefined) next.summary = body.summary as ExpertTeam["summary"];
  row.team = next;
  return next;
}

function invocableSlugsFromHost(): string[] {
  return host.teams.flatMap((row) => {
    if (row.team === undefined) return [];
    if (!row.team.enabled) return [];
    if (!row.availability.invocable) return [];
    return [row.team.slug];
  });
}

function fakeRpc(method: string, params?: unknown): unknown {
  if (method === "expertTeam.list") {
    const result: ExpertTeamListResult = {
      teams: host.teams.map(cloneRow),
      packages: PACKAGES.map((pkg) => ({ ...pkg, capabilities: pkg.capabilities === undefined ? undefined : { ...pkg.capabilities, skillScripts: [...pkg.capabilities.skillScripts] } })),
    };
    return result;
  }
  if (method === "expertTeam.invocableList") {
    return { teams: host.teams.flatMap((row) => (row.team === undefined ? [] : [cloneRow(row).team])) };
  }
  if (method === "expertTeam.create") {
    const body = (params ?? {}) as Record<string, unknown>;
    host.creates.push(body);
    if (host.createResult !== undefined) return host.createResult;
    const team = teamFromCreate(body, host.creates.length);
    host.teams.push({ id: team.id, team, availability: invocableAvailability(team) });
    return { ok: true, team } satisfies ExpertTeamWriteResult;
  }
  if (method === "expertTeam.update") {
    const body = (params ?? {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    host.updates.push({ id, patch: body });
    const row = host.teams.find((candidate) => candidate.id === id);
    const team = row === undefined ? undefined : applyUpdate(row, body);
    return team === undefined ? { ok: false, fieldErrors: [{ field: "slug", message: "团队不存在" }] } : ({ ok: true, team } satisfies ExpertTeamWriteResult);
  }
  if (method === "expertTeam.setEnabled") {
    const body = (params ?? {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const enabled = body.enabled === true;
    const row = host.teams.find((candidate) => candidate.id === id);
    if (row?.team === undefined) throw new Error("team not found");
    row.team = { ...row.team, enabled };
    row.availability = {
      ...row.availability,
      kind: enabled ? "invocable" : "disabled",
      invocable: enabled,
      reasons: enabled ? [] : ["expert-team-disabled"],
    };
    return { ok: true, team: row.team } satisfies ExpertTeamWriteResult;
  }
  if (method === "expertTeam.remove") {
    const body = (params ?? {}) as Record<string, unknown>;
    host.removes.push(body);
    const id = typeof body.id === "string" ? body.id : "";
    host.teams = host.teams.filter((row) => row.id !== id);
    return { removed: true };
  }
  throw new Error(`unexpected rpc: ${method}`);
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function flush(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function matchesLabel(element: HTMLElement, label: string): boolean {
  const aria = element.getAttribute("aria-label");
  if (aria !== null && aria.trim() === label) return true;
  return (element.textContent ?? "").trim() === label;
}

function findButton(label: string): HTMLButtonElement {
  const buttons = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  const match = buttons.find((button) => !button.disabled && matchesLabel(button, label));
  if (match === undefined) throw new Error(`clickable button not found: ${label}`);
  return match;
}

function requireField(label: string): FieldElement {
  const field = container?.querySelector<FieldElement>(`[aria-label="${label}"]`);
  if (!field) throw new Error(`field not found: ${label}`);
  return field;
}

async function click(label: string): Promise<void> {
  await flush(2);
  const button = findButton(label);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await flush(4);
}

async function fill(label: string, value: string): Promise<void> {
  await flush(2);
  const field = requireField(label);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(2);
}

async function select(label: string, value: string): Promise<void> {
  await flush(2);
  const field = requireField(label);
  if (!(field instanceof HTMLSelectElement)) throw new Error(`field is not a select: ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(2);
}

async function addMember(input: { slug: string; role: "executor" | "reviewer"; responsibility: string }): Promise<void> {
  await click(`添加成员 ${input.slug}`);
  await select(`成员 ${input.slug} 角色`, input.role);
  await fill(`成员 ${input.slug} 职责`, input.responsibility);
}

function memberSlugs(): string[] {
  return [...(container?.querySelectorAll<HTMLElement>("[data-member-slug]") ?? [])].map(
    (element) => element.dataset.memberSlug ?? "",
  );
}

function lastCreate(): Record<string, unknown> {
  return host.creates[host.creates.length - 1] ?? {};
}

function lastUpdate(): RecordedUpdate {
  return host.updates[host.updates.length - 1] ?? { id: "", patch: {} };
}

function lastRemove(): Record<string, unknown> {
  return host.removes[host.removes.length - 1] ?? {};
}

/** 列表卡片的可用性徽标：文本与类名（包含 disabled 等状态类）。 */
function statusBadge(slug: string): { text: string; className: string } | undefined {
  const card = container?.querySelector<HTMLElement>(`[data-team-slug="${slug}"]`);
  const badge = card?.querySelector<HTMLElement>(".team-status");
  if (!badge) return undefined;
  return { text: (badge.textContent ?? "").trim(), className: badge.className };
}

/** 健康提示行（.team-card-reasons.healthy）；缺失时返回 null。 */
function healthyNote(): { text: string; className: string } | null {
  const note = container?.querySelector<HTMLElement>(".team-card-reasons.healthy");
  if (!note) return null;
  return { text: (note.textContent ?? "").trim(), className: note.className };
}

type Harness = {
  text(): string;
  click(label: string): Promise<void>;
  fill(label: string, value: string): Promise<void>;
  select(label: string, value: string): Promise<void>;
  addMember(input: { slug: string; role: "executor" | "reviewer"; responsibility: string }): Promise<void>;
  field(label: string): FieldElement;
  queryField(label: string): FieldElement | null;
  memberSlugs(): string[];
  lastCreate(): Record<string, unknown>;
  lastUpdate(): RecordedUpdate;
  lastRemove(): Record<string, unknown>;
  invocableSlugs(): string[];
  dirtyReports(): boolean[];
  statusBadge(slug: string): { text: string; className: string } | undefined;
  healthyNote(): { text: string; className: string } | null;
};

function renderExpertTeamsView(options: RenderOptions = {}): Harness {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = {
    teams: (options.teams ?? [validTeamRecord()]).map(cloneRow),
    creates: [],
    updates: [],
    removes: [],
    ...(options.createResult === undefined ? {} : { createResult: options.createResult }),
  };
  const dirtyReports: boolean[] = [];
  const handleDirty = (dirty: boolean): void => {
    dirtyReports.push(dirty);
  };
  vi.mocked(rpcCall).mockImplementation(
    ((method: string, params?: unknown) => immediatePromise(fakeRpc(method, params))) as (
      method: string,
      params?: unknown,
    ) => Promise<never>,
  );

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ExpertTeamsView, { onDirtyChange: handleDirty }));
  });

  return {
    text: () => container?.textContent ?? "",
    click,
    fill,
    select,
    addMember,
    field: requireField,
    queryField: (label: string) => container?.querySelector<FieldElement>(`[aria-label="${label}"]`) ?? null,
    memberSlugs,
    lastCreate,
    lastUpdate,
    lastRemove,
    invocableSlugs: invocableSlugsFromHost,
    dirtyReports: () => [...dirtyReports],
    statusBadge,
    healthyNote,
  };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
  vi.mocked(rpcCall).mockReset();
});

describe("ExpertTeamsView（专家团管理）", () => {
  it('creates a team with structured rules, ordered members, and native package capabilities summary', async () => {
    const harness = renderExpertTeamsView()
    await harness.click('新建专家团')
    await harness.fill('名称', '合规审查小分队')
    await harness.fill('描述', '审查合同与业务数据')
    await harness.fill('适用场景', '合同合规')
    await harness.addMember({ slug: 'writer', role: 'executor', responsibility: '提取条款' })
    await harness.addMember({ slug: 'reviewer', role: 'reviewer', responsibility: '统一合规审查' })
    expect(harness.text()).toContain('HTTP / MCP') // 展示包原生能力摘要
    await harness.click('成员 reviewer：上移')
    expect(harness.memberSlugs()).toEqual(['reviewer', 'writer'])
    await harness.select('执行顺序', 'sequential')
    expect(harness.field('最大并发')).toBeDisabled()
    await harness.click('保存专家团')
    expect(harness.lastCreate()).toMatchObject({ slug: expect.any(String), review: { mode: 'unified', maxRevisionRounds: 1 }, orchestration: { executionOrder: 'sequential' } })
    expect(harness.lastCreate()).toMatchObject({ enabled: true })
    // 未填的可选说明字段在创建载荷中省略，不发送空串。
    const createdPayload = harness.lastCreate()
    expect(createdPayload.orchestration).not.toHaveProperty('instructions')
    expect(createdPayload.review).not.toHaveProperty('criteria')
    expect(createdPayload.summary).not.toHaveProperty('instructions')
    expect((createdPayload.members as Record<string, unknown>[])[0]).not.toHaveProperty('outputInstructions')
  })

  it('shows unavailable members without blocking edits to other fields, and allows deleting corrupt team files', async () => {
    const harness = renderExpertTeamsView({ teams: [teamWithMissingMember(), corruptTeamRecord('corrupt-1')] })
    expect(harness.text()).toContain('成员失效')
    expect(harness.text()).toContain('定义文件已损坏')
    await harness.click('删除损坏记录 corrupt-1')
    await harness.click('确认删除')
    expect(harness.lastRemove()).toEqual({ id: 'corrupt-1' })
    await harness.click('编辑')
    await harness.fill('描述', '更新后的描述')
    await harness.click('保存专家团')
    expect(harness.lastUpdate().patch.description).toBe('更新后的描述')
    expect(harness.invocableSlugs()).not.toContain('missing-member-team')
  })

  it('toggles enabled status, displays incomplete badges, enforces editor rule linkages, guards unsaved leave, and preserves draft on field errors', async () => {
    const harness = renderExpertTeamsView({
      teams: [validTeamRecord(), incompleteTeamRecord('incomplete-1')],
      createResult: { ok: false, fieldErrors: [{ field: 'slug', message: '调用名已存在' }] },
    })
    expect(harness.text()).toContain('配置不完整')
    // 启停 toggle 后标为已停用且从 @ 可选列表排除
    await harness.click('停用 compliance-team')
    expect(harness.text()).toContain('已停用')
    // 卡片徽标本身回显停用状态（@ 可选列表在组件内的排除断言留给 Task 15）
    expect(harness.statusBadge('compliance-team')).toEqual({
      text: '已停用',
      className: expect.stringContaining('disabled'),
    })
    expect(harness.invocableSlugs()).not.toContain('compliance-team')

    // 编辑器联动：仅会话隐藏 Artifact 格式；无 reviewer 时审查模式锁定为 none；未保存离开弹确认；字段错误回显并保留草稿
    await harness.click('新建专家团')
    await harness.fill('名称', '草稿团队')
    await harness.fill('描述', '草稿描述')
    await harness.addMember({ slug: 'writer', role: 'executor', responsibility: '执行 1' })
    await harness.addMember({ slug: 'writer-2', role: 'executor', responsibility: '执行 2' })
    expect(harness.field('审查模式')).toHaveValue('none')
    expect(harness.field('审查模式')).toBeDisabled()
    await harness.select('默认交付', 'message')
    expect(harness.queryField('报告格式')).toBeNull()
    await harness.click('保存专家团')
    expect(harness.text()).toContain('调用名已存在')
    expect(harness.field('名称')).toHaveValue('草稿团队')
    await harness.click('返回列表')
    expect(harness.text()).toContain('未保存')
  })

  it('reports draft dirty state upward and styles the healthy availability line as success', async () => {
    const harness = renderExpertTeamsView()
    expect(harness.healthyNote()).toEqual({
      text: '定义与成员均有效',
      className: 'team-card-reasons healthy',
    })
    expect(harness.dirtyReports()).toEqual([])

    await harness.click('新建专家团')
    // 新编辑器初始草稿与初始快照一致：未修改不上报脏
    expect(harness.dirtyReports()).toEqual([false])
    await harness.fill('名称', '草稿团队')
    expect(harness.dirtyReports().at(-1)).toBe(true)
    await harness.click('保存专家团')
    // 保存成功后编辑器卸载，离开守卫解除
    expect(harness.dirtyReports().at(-1)).toBe(false)
  })
});
