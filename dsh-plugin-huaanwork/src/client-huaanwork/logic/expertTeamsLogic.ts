import type { ExpertTeam, ExpertTeamMember } from "../rpc-types.ts";

/**
 * 专家团定义、默认规则、校验与 `@` 检索的共享纯函数。
 *
 * Host 定义存储、CRUD 路由与客户端编辑器共用这一份字段规则，避免两侧出现
 * 不同的默认值、约束或中文检索行为。校验只读入参，不抛异常，也不静默修复：
 * 任何非法字段都按编辑器字段名返回错误。
 */

export type ExpertTeamValidationField =
  | "slug"
  | "name"
  | "description"
  | "scenarios"
  | "members"
  | "orchestration"
  | "review"
  | "summary";

export type ExpertTeamValidationErrors = Partial<Record<ExpertTeamValidationField, string>>;

export type ExpertTeamValidationResult =
  | { ok: true; team: ExpertTeam }
  | { ok: false; errors: ExpertTeamValidationErrors };

const TEAM_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEAM_SLUG_MAX = 32;
const TEAM_NAME_MAX = 40;
const TEAM_DESCRIPTION_MAX = 200;
const TEAM_TEXT_MAX = 500;
const TEAM_MEMBER_MIN = 2;
const TEAM_MEMBER_MAX = 8;

const ASSIGNMENT_MODES: ReadonlySet<string> = new Set(["by-responsibility", "broadcast"]);
const EXECUTION_ORDERS: ReadonlySet<string> = new Set(["sequential", "parallel", "dynamic"]);
const MAX_PARALLEL_VALUES: ReadonlySet<number> = new Set([1, 2, 3, 4]);
const REVIEW_MODES: ReadonlySet<string> = new Set(["none", "unified", "per-member"]);
const MAX_REVISION_ROUND_VALUES: ReadonlySet<number> = new Set([0, 1, 2]);
const SUMMARY_DELIVERIES: ReadonlySet<string> = new Set(["artifact", "message"]);
const ARTIFACT_FORMATS: ReadonlySet<string> = new Set(["markdown", "html"]);
const SUMMARY_MODES: ReadonlySet<string> = new Set(["integrated", "by-member", "integrated-with-appendix"]);

const AGENT_REF_SOURCES: ReadonlySet<string> = new Set(["local", "catalog"]);
const MEMBER_ROLES: ReadonlySet<string> = new Set(["executor", "reviewer"]);

/** 结构化规则的规格默认值；有 reviewer 时默认统一审查，否则关闭审查。 */
export function defaultExpertTeamRules(
  members: readonly ExpertTeamMember[],
): Pick<ExpertTeam, "orchestration" | "review" | "summary"> {
  return {
    orchestration: { assignmentMode: "by-responsibility", executionOrder: "parallel", maxParallel: 2 },
    review: { mode: members.some((member) => member.role === "reviewer") ? "unified" : "none", maxRevisionRounds: 1 },
    summary: { delivery: "artifact", artifactFormat: "markdown", mode: "integrated" },
  };
}

/** sequential 的有效执行并发固定为 1，与配置的 maxParallel 无关。 */
export function effectiveTeamMaxParallel(team: ExpertTeam): 1 | 2 | 3 | 4 {
  return team.orchestration.executionOrder === "sequential" ? 1 : team.orchestration.maxParallel;
}

/** 中文 `@team:` 检索：匹配名称、调用名、描述与适用场景，保持输入顺序。 */
export function atExpertTeams(items: readonly ExpertTeam[], query: string): ExpertTeam[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((team) => {
    const fields = [team.name, team.slug, team.description, team.scenarios ?? ""];
    return fields.some((field) => field.toLocaleLowerCase().includes(needle));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isOptionalText(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isOneOf(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function isOneOfNumbers(value: unknown, allowed: ReadonlySet<number>): value is number {
  return typeof value === "number" && allowed.has(value);
}

function hasReviewerMember(members: unknown): boolean {
  return Array.isArray(members) && members.some((member) => isRecord(member) && member.role === "reviewer");
}

function membersError(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "成员必须为数组";
  if (value.length < TEAM_MEMBER_MIN || value.length > TEAM_MEMBER_MAX) {
    return `成员数量必须为 ${TEAM_MEMBER_MIN}–${TEAM_MEMBER_MAX} 名（当前 ${value.length} 名）`;
  }
  const memberIds = new Set<string>();
  const agentRefs = new Set<string>();
  let executorCount = 0;
  for (const entry of value) {
    if (!isRecord(entry)) return "成员格式不正确";
    const { memberId, agentRef, role, responsibility, outputInstructions } = entry;
    if (!isNonBlankString(memberId)) return "成员 id 不能为空";
    if (memberIds.has(memberId)) return "成员 id 不能重复";
    memberIds.add(memberId);
    if (!isRecord(agentRef)) return "成员智能体引用格式不正确";
    if (!isOneOf(agentRef.source, AGENT_REF_SOURCES)) return "成员智能体来源只能为 local 或 catalog";
    if (!isNonBlankString(agentRef.slug)) return "成员智能体调用名不能为空";
    const refKey = `${agentRef.source}/${agentRef.slug}`;
    if (agentRefs.has(refKey)) return "同一智能体只能加入专家团一次";
    agentRefs.add(refKey);
    if (!isOneOf(role, MEMBER_ROLES)) return "成员角色只能为 executor 或 reviewer";
    if (role === "executor") executorCount += 1;
    if (!isNonBlankString(responsibility)) return "成员职责不能为空";
    if (!isOptionalText(outputInstructions, TEAM_TEXT_MAX)) {
      return `成员输出要求最长 ${TEAM_TEXT_MAX} 个字符`;
    }
  }
  if (executorCount < 1) return "至少需要一名执行成员";
  return undefined;
}

function orchestrationError(value: unknown): string | undefined {
  if (!isRecord(value)) return "调度规则格式不正确";
  if (!isOneOf(value.assignmentMode, ASSIGNMENT_MODES)) {
    return "分配模式只能为 by-responsibility 或 broadcast";
  }
  if (!isOneOf(value.executionOrder, EXECUTION_ORDERS)) {
    return "执行顺序只能为 sequential、parallel 或 dynamic";
  }
  if (!isOneOfNumbers(value.maxParallel, MAX_PARALLEL_VALUES)) {
    return "并发上限只能为 1、2、3 或 4";
  }
  if (!isOptionalText(value.instructions, TEAM_TEXT_MAX)) {
    return `调度说明最长 ${TEAM_TEXT_MAX} 个字符`;
  }
  return undefined;
}

function reviewError(value: unknown, hasReviewer: boolean): string | undefined {
  if (!isRecord(value)) return "审查规则格式不正确";
  if (!isOneOf(value.mode, REVIEW_MODES)) return "审查模式只能为 none、unified 或 per-member";
  if (value.mode !== "none" && !hasReviewer) return "审查模式需要至少一名审查成员";
  if (!isOneOfNumbers(value.maxRevisionRounds, MAX_REVISION_ROUND_VALUES)) {
    return "返修轮次只能为 0、1 或 2";
  }
  if (!isOptionalText(value.criteria, TEAM_TEXT_MAX)) {
    return `审查标准最长 ${TEAM_TEXT_MAX} 个字符`;
  }
  return undefined;
}

function summaryError(value: unknown): string | undefined {
  if (!isRecord(value)) return "汇总规则格式不正确";
  if (!isOneOf(value.delivery, SUMMARY_DELIVERIES)) return "交付方式只能为 artifact 或 message";
  if (!isOneOf(value.artifactFormat, ARTIFACT_FORMATS)) return "Artifact 格式只能为 markdown 或 html";
  if (!isOneOf(value.mode, SUMMARY_MODES)) {
    return "汇总方式只能为 integrated、by-member 或 integrated-with-appendix";
  }
  if (!isOptionalText(value.instructions, TEAM_TEXT_MAX)) {
    return `汇总要求最长 ${TEAM_TEXT_MAX} 个字符`;
  }
  return undefined;
}

/**
 * 在不可信 JSON 边界校验完整专家团定义。
 *
 * 只返回编辑器字段名对应的本地化错误，不抛未本地化异常，不静默补默认值后放行。
 * 团队级 envelope 字段（schemaVersion、id、时间戳与 enabled）不属于可编辑字段，
 * 出错时统一挂在 `slug` 上，避免引入编辑器不认识的错误键。
 */
export function validateExpertTeam(value: unknown): ExpertTeamValidationResult {
  if (!isRecord(value)) {
    return { ok: false, errors: { slug: "专家团定义格式不正确" } };
  }
  const errors: ExpertTeamValidationErrors = {};
  const fail = (field: ExpertTeamValidationField, message: string): void => {
    if (errors[field] === undefined) errors[field] = message;
  };

  if (value.schemaVersion !== 1) fail("slug", "专家团定义版本不受支持");
  if (!isNonBlankString(value.id)) fail("slug", "专家团 id 不能为空");
  if (typeof value.enabled !== "boolean") fail("slug", "团队启停状态必须为布尔值");
  if (!isNonBlankString(value.createdAt) || !isNonBlankString(value.updatedAt)) {
    fail("slug", "团队创建或更新时间不能为空");
  }

  if (typeof value.slug !== "string" || value.slug.length < 1 || value.slug.length > TEAM_SLUG_MAX || !TEAM_SLUG_RE.test(value.slug)) {
    fail("slug", `调用名只能使用小写字母、数字和连字符，且不超过 ${TEAM_SLUG_MAX} 个字符`);
  }
  if (!isNonBlankString(value.name) || value.name.length > TEAM_NAME_MAX) {
    fail("name", `名称不能为空且不超过 ${TEAM_NAME_MAX} 个字符`);
  }
  if (!isNonBlankString(value.description) || value.description.length > TEAM_DESCRIPTION_MAX) {
    fail("description", `描述不能为空且不超过 ${TEAM_DESCRIPTION_MAX} 个字符`);
  }
  if (!isOptionalText(value.scenarios, TEAM_TEXT_MAX)) {
    fail("scenarios", `适用场景最长 ${TEAM_TEXT_MAX} 个字符`);
  }

  const memberIssue = membersError(value.members);
  if (memberIssue !== undefined) fail("members", memberIssue);

  const orchestrationIssue = orchestrationError(value.orchestration);
  if (orchestrationIssue !== undefined) fail("orchestration", orchestrationIssue);

  const reviewIssue = reviewError(value.review, hasReviewerMember(value.members));
  if (reviewIssue !== undefined) fail("review", reviewIssue);

  const summaryIssue = summaryError(value.summary);
  if (summaryIssue !== undefined) fail("summary", summaryIssue);

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, team: value as unknown as ExpertTeam };
}
