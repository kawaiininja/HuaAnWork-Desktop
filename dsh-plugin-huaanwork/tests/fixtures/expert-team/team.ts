import type {
  ExpertTeam,
  ExpertTeamMember,
  ExpertTeamResult,
  TaskArtifactSummary,
} from "../../../src/client-huaanwork/rpc-types.ts";
import { defaultExpertTeamRules } from "../../../src/client-huaanwork/logic/expertTeamsLogic.ts";

/**
 * 专家团共享测试对象源。每次调用都返回全新克隆，避免用例原地修改串染；
 * 可选属性只在显式提供时出现，不向可选属性写入显式 `undefined`。
 */

export type ExpertTeamInputOverrides = Partial<Omit<ExpertTeam, "orchestration" | "review" | "summary">> & {
  orchestration?: Partial<ExpertTeam["orchestration"]>;
  review?: Partial<ExpertTeam["review"]>;
  summary?: Partial<ExpertTeam["summary"]>;
};

export type ExpertTeamResultOverrides = Partial<Omit<ExpertTeamResult, "resultId">>;

function definedOnly<T extends object>(source: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
}

function mergeSection<T extends object>(defaults: T, overrides: Partial<T> | undefined): T {
  const merged: T = { ...defaults };
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) Object.assign(merged, { [key]: value });
    }
  }
  return merged;
}

function cloneMember(member: ExpertTeamMember): ExpertTeamMember {
  const cloned: ExpertTeamMember = {
    memberId: member.memberId,
    agentRef: { ...member.agentRef },
    role: member.role,
    responsibility: member.responsibility,
  };
  if (member.outputInstructions !== undefined) cloned.outputInstructions = member.outputInstructions;
  return cloned;
}

export function validTeamInput(overrides: ExpertTeamInputOverrides = {}): ExpertTeam {
  const members: ExpertTeamMember[] = [
    {
      memberId: "m-exec-1",
      agentRef: { source: "local", slug: "writer" },
      role: "executor",
      responsibility: "提取合同关键条款并起草结论",
    },
    {
      memberId: "m-rev-1",
      agentRef: { source: "local", slug: "reviewer" },
      role: "reviewer",
      responsibility: "统一合规审查并指出风险项",
    },
  ];
  // 规则默认值必须基于最终成员列表推导：否则调用方覆盖 members 后，fixture 会
  // 返回一个自身校验器都拒绝的团队（例如只剩 executor 却仍是 unified 审查）。
  const effectiveMembers = overrides.members ?? members;
  const rules = defaultExpertTeamRules(effectiveMembers);
  const base: ExpertTeam = {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    slug: "compliance-team",
    name: "合规审查小分队",
    description: "审查合同与业务合规条款",
    scenarios: "合同条款复核",
    enabled: true,
    members: effectiveMembers,
    orchestration: rules.orchestration,
    review: rules.review,
    summary: rules.summary,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
  const team: ExpertTeam = { ...base };
  Object.assign(team, definedOnly(overrides));
  team.members = team.members.map(cloneMember);
  team.orchestration = mergeSection(rules.orchestration, overrides.orchestration);
  team.review = mergeSection(rules.review, overrides.review);
  team.summary = mergeSection(rules.summary, overrides.summary);
  return team;
}

export function validTeam(): ExpertTeam {
  return validTeamInput();
}

export function executeResult(resultId: string, overrides: ExpertTeamResultOverrides = {}): ExpertTeamResult {
  const result: ExpertTeamResult = {
    resultId,
    dispatchId: `dispatch-${resultId}`,
    memberId: "m-exec-1",
    agentRef: { source: "local", slug: "writer" },
    packageVersion: "1.0.0",
    kind: "execute",
    inputResultIds: [],
    status: "completed",
    output: "有效文本",
    startedAt: "2026-11-22T00:00:00.000Z",
    ...definedOnly(overrides),
  };
  return {
    ...result,
    agentRef: { ...result.agentRef },
    inputResultIds: [...result.inputResultIds],
  };
}

export function artifact(overrides: Partial<TaskArtifactSummary> = {}): TaskArtifactSummary {
  const summary: TaskArtifactSummary = {
    artifactId: "artifact-1",
    sessionId: "s1",
    title: "专家团报告",
    format: "markdown",
    downloadName: "expert-team-report.md",
    sizeBytes: 4,
    sha256: "0".repeat(64),
    createdAt: "2026-11-22T00:00:00.000Z",
    anchor: { kind: "turn", clientMessageId: "m1" },
    ...definedOnly(overrides),
  };
  return { ...summary, anchor: { ...summary.anchor } };
}
