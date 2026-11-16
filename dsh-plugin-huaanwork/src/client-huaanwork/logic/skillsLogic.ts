/**
 * Skill page pure logic (Task 9).
 *
 * Types are the RPC projections from `rpc-types.ts` (one source of truth);
 * this module owns only tab/search/button/label decisions so they can be
 * tested without React. The page has exactly two tabs; the center is the
 * bundled+shared catalog, "我的技能" is the profile's local copies.
 */

import type {
  CenterSkillInfo,
  InvocableSkillInfo,
  LocalSkillInfo,
  SkillDetail,
  SkillDownloadState,
  SkillFieldError,
  SkillImportPreview,
  SkillOrigin,
  SkillSource,
  SkillWriteResult,
} from "../rpc-types.ts";

export type {
  CenterSkillInfo,
  InvocableSkillInfo,
  LocalSkillInfo,
  SkillDetail,
  SkillDownloadState,
  SkillFieldError,
  SkillImportPreview,
  SkillOrigin,
  SkillSource,
  SkillWriteResult,
};

export const SKILL_TABS = ["center", "mine"] as const;
export type SkillTab = (typeof SKILL_TABS)[number];

export function tabLabel(tab: SkillTab): string {
  return tab === "center" ? "技能中心" : "我的技能";
}

/** Source badge for CENTER cards only; local cards use {@link originLabel}. */
export function sourceLabel(source: SkillSource): string {
  switch (source) {
    case "bundled": return "内置";
    case "catalog": return "共享";
    case "user": return "我的技能";
  }
}

/** Local-card origin badge (spec §5.3). */
export function originLabel(origin: SkillOrigin): string {
  switch (origin.kind) {
    case "created": return "创建";
    case "imported": return "导入";
    case "bundled": return "内置副本";
    case "catalog": return "共享副本";
  }
}

function matches(name: string, description: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${name} ${description}`.toLowerCase().includes(normalized);
}

export function filterCenterSkills(skills: readonly CenterSkillInfo[], query: string): CenterSkillInfo[] {
  return skills.filter(skill => matches(skill.name, skill.description, query));
}

export function filterLocalSkills(skills: readonly LocalSkillInfo[], query: string): LocalSkillInfo[] {
  return skills.filter(skill => matches(skill.name, skill.description, query));
}

/** Center action button label; independent from any enable state. */
export function centerActionLabel(state: SkillDownloadState): string {
  switch (state) {
    case "available": return "下载";
    case "downloaded": return "已下载";
    case "update-available": return "更新";
    case "local-conflict": return "本地有修改";
    case "not-applicable": return "系统技能·始终启用";
  }
}

/** My-skills upload button label. */
export function uploadActionLabel(state: LocalSkillInfo["publishState"]): string {
  switch (state) {
    case "not-published": return "上传";
    case "published": return "已上传";
    case "modified": return "更新上传";
  }
}

/** Reserved names a local skill must not take (system + internal). */
export const RESERVED_SKILL_NAMES: readonly string[] = ["explore", "test-fix", "create-agent", "create-skill"];

/** Busy key shared by every action on one card. */
export function busyKeyFor(source: "bundled" | "catalog" | "user", name: string): string {
  return `${source}:${name}`;
}

/** A local skill that reuses a bundled (or downloaded-bundled) name cannot be
 * uploaded as a FIRST publish; it must be duplicated under a new name. */
export function isBuiltinNameConflict(
  skill: Pick<LocalSkillInfo, "name" | "origin">,
  bundledNames: ReadonlySet<string>,
): boolean {
  return skill.origin.kind === "bundled" || bundledNames.has(skill.name);
}

export function isUploadDisabled(
  skill: LocalSkillInfo,
  bundledNames: ReadonlySet<string>,
): boolean {
  return skill.publishState === "published" || isBuiltinNameConflict(skill, bundledNames);
}

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SlashToken = { start: number; end: number; query: string };

const RESERVED_SLASH = "schedule";

/** 光标所在词若是 `/name`（非 URL/路径），返回该 token。 */
export function slashTokenAt(text: string, cursor: number): SlashToken | undefined {
  const pos = Math.max(0, Math.min(cursor, text.length));
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  let end = pos;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  const token = text.slice(start, end);
  if (!token.startsWith("/") || token.startsWith("//")) return undefined;
  const query = token.slice(1);
  if (!query ? token !== "/" : !/^[a-z0-9-]*$/.test(query)) return undefined;
  return { start, end, query };
}

export function isReservedSlash(query: string): boolean {
  return query === RESERVED_SLASH || query.startsWith(`${RESERVED_SLASH}-`);
}

/** `/` catalog query + ordering. Every entry is invocable by construction. */
export function slashSkills(skills: readonly InvocableSkillInfo[], query: string): InvocableSkillInfo[] {
  const needle = query.trim().toLowerCase();
  const matched = skills.filter((skill) => {
    if (!needle) return true;
    return skill.name.includes(needle) || skill.description.toLowerCase().includes(needle);
  });
  matched.sort((a, b) => {
    const aPrefix = needle && a.name.startsWith(needle) ? 0 : 1;
    const bPrefix = needle && b.name.startsWith(needle) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return a.name.localeCompare(b.name);
  });
  return matched;
}

/** 整段草稿以 `/name` 开头时解析为硬调用；`/schedule` 留给自动化拦截。 */
export function parseSlashInvoke(text: string): { name: string; remainder: string } | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/);
  if (!match || match[1] === RESERVED_SLASH) return undefined;
  return { name: match[1], remainder: (match[2] ?? "").trim() };
}

export type SkillFormValues = {
  name: string;
  description: string;
  whenToUse: string;
  content: string;
  disableModelInvocation: boolean;
};

/** 客户端预校验（服务端仍会复检并返回 fieldErrors）。编辑模式名称锁定、不校验。 */
export function validateSkillForm(
  values: SkillFormValues,
  opts: { editing: boolean; takenNames: readonly string[] },
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!opts.editing) {
    if (!SKILL_NAME_RE.test(values.name)) errors.name = "名称需为小写字母/数字/连字符（kebab-case）";
    else if (values.name.length > 64) errors.name = "名称不超过 64 字符";
    else if (opts.takenNames.includes(values.name)) errors.name = "已存在同名技能";
  }
  if (!values.description.trim()) errors.description = "描述必填";
  else if (values.description.length > 1024) errors.description = "描述不超过 1024 字符";
  if (!values.content.trim()) errors.content = "正文必填";
  return errors;
}

/** Target-name validation for “另存为新技能”. */
export function validateDuplicateName(
  target: string,
  opts: { sourceName: string; takenNames: readonly string[] },
): string | undefined {
  if (target === opts.sourceName) return "请输入一个新的技能名称";
  if (!SKILL_NAME_RE.test(target)) return "名称需为小写字母/数字/连字符（kebab-case）";
  if (target.length > 64) return "名称不超过 64 字符";
  if (opts.takenNames.includes(target)) return "已存在同名技能";
  return undefined;
}
