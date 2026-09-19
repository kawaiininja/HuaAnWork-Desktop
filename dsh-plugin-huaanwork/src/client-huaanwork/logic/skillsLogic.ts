export type SkillSource = "bundled" | "user" | "external";

export type SkillInfo = {
  name: string;
  description: string;
  source: SkillSource;
  whenToUse?: string;
  enabled?: boolean;
};

export type SkillDetail = SkillInfo & {
  content: string;
  /** invocation 策略（供查看/编辑回填；缺省 = dsh 默认：模型可调用、用户可调用）。 */
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
};

export type SkillTab = "all" | SkillSource;

export type SkillFieldError = { field: string; message: string };

export type SkillWriteResult = { ok: true; skill: SkillInfo } | { ok: false; fieldErrors: SkillFieldError[] };

export type SkillImportPreview =
  | {
      ok: true;
      preview: SkillDetail & { targetName: string; sourceName: string; nameMismatch: boolean; kind: "file" | "directory" };
    }
  | { ok: false; fieldErrors: SkillFieldError[] };

/** 与 dsh SKILL_NAME 及 sidecar 校验保持一致。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function sourceLabel(source: SkillSource): string {
  return source === "bundled" ? "内置" : source === "user" ? "我创建的" : "外部";
}

export function tabLabel(tab: SkillTab): string {
  return tab === "all" ? "全部" : sourceLabel(tab);
}

export function filterSkills(skills: SkillInfo[], tab: SkillTab, query: string): SkillInfo[] {
  const scoped = tab === "all" ? skills : skills.filter((skill) => skill.source === tab);
  const normalized = query.trim().toLowerCase();
  if (!normalized) return scoped;
  return scoped.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(normalized));
}

/** 系统技能：始终启用，技能中心不渲染开关（与 sidecar/bundle 的 SYSTEM_SKILLS 保持一致）。 */
export const SYSTEM_SKILLS: ReadonlySet<string> = new Set(["explore", "test-fix"]);

/** 内置技能是否渲染启用开关：仅 bundled 且非系统技能。 */
export function canToggleSkill(skill: Pick<SkillInfo, "source" | "name">): boolean {
  return skill.source === "bundled" && !SYSTEM_SKILLS.has(skill.name);
}

/** 可被 `/` 点名：内置必须 enabled；用户/外部无开关，视为已启用。 */
export function isSkillInvocable(skill: SkillInfo): boolean {
  return skill.source === "bundled" ? skill.enabled === true : true;
}

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

export function slashSkills(skills: readonly SkillInfo[], query: string): SkillInfo[] {
  const needle = query.trim().toLowerCase();
  const matched = skills.filter((skill) => {
    if (!isSkillInvocable(skill)) return false;
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
  userInvocable: boolean;
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
    else if (opts.takenNames.includes(values.name)) errors.name = "已存在同名技能（含内置技能）";
  }
  if (!values.description.trim()) errors.description = "描述必填";
  else if (values.description.length > 1024) errors.description = "描述不超过 1024 字符";
  if (!values.content.trim()) errors.content = "正文必填";
  return errors;
}
