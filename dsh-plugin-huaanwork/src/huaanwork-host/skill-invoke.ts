import { dirname } from "node:path";

import { SYSTEM_SKILLS, SKILL_NAME_RE, bundledSkillDir, readSkillToggles } from "../huaanwork-guardrails/skills.ts";
import type { SkillDetail } from "../client-huaanwork/rpc-types.ts";

import { externalSkillsRoot, findEntry, getSkill, userSkillsRoot } from "./skills-host.ts";

/**
 * @skill 分发(旧 sidecar skill-invoke.ts 逐字移植)。
 * 定向改动(逐处,禁全局替换):
 * - `@huaanwork/bundle/skills` → `../huaanwork-guardrails/skills.ts`(Task 2 平移);
 * - `@huaanwork/rpc/types` → `../client-huaanwork/rpc-types.ts`(fork 的 RPC 类型事实源);
 * - 存储根参数名 dshHome → storageRoot:旧 sidecar 技能存于 $DSH_HOME/skills,
 *   Desktop 组合下存于 profileDir/skills(计划 Task 10 口径);函数体逐字,
 *   仅形参与内部引用重命名。
 */

export type InvocableSkill = { skill: SkillDetail; resourceDir?: string };

/** 用户显式点名时：内置必须已启用；用户/外部技能始终可调用。 */
export async function resolveInvocableSkill(storageRoot: string, name: string): Promise<InvocableSkill> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`skill ${name} is not invocable`);
  const skill = await getSkill(storageRoot, name);
  if (!skill) throw new Error(`skill ${name} was not found`);
  if (skill.source === "bundled" && !SYSTEM_SKILLS.has(skill.name)) {
    if (readSkillToggles(storageRoot)[skill.name] !== true) throw new Error(`skill ${skill.name} is disabled`);
  }
  const resourceDir = await resourceDirFor(storageRoot, skill);
  return { skill, ...(resourceDir !== undefined ? { resourceDir } : {}) };
}

async function resourceDirFor(storageRoot: string, skill: SkillDetail): Promise<string | undefined> {
  if (skill.source === "bundled") return bundledSkillDir(skill.name);
  const root = skill.source === "user" ? userSkillsRoot(storageRoot) : externalSkillsRoot();
  const entry = await findEntry(root, skill.name);
  if (!entry) return undefined;
  return entry.kind === "bundle" ? dirname(entry.path) : root;
}

export function wrapSkillPrompt(opts: {
  name: string;
  content: string;
  text: string;
  resourceDir?: string;
}): string {
  const request = opts.text.trim() || "按该技能开始。";
  const workNote = "这是 Work 回合：按技能说明执行。若技能引用 scripts/ 等相对路径，以技能目录为准。";
  const resourceLine = opts.resourceDir ? `\n技能目录：${opts.resourceDir}` : "";
  return [
    `# 已启用技能：${opts.name}`,
    "",
    "用户显式点名了这个技能。必须遵循下面的说明完成本轮，不要改用其他技能，也不要忽略这些说明。",
    workNote + resourceLine,
    "",
    opts.content.trim(),
    "",
    "---",
    "用户请求：",
    request,
  ].join("\n");
}

/** 把点名技能编进本轮用户消息。 */
export async function invokeSkillText(storageRoot: string, name: string, text: string): Promise<string> {
  const { skill, resourceDir } = await resolveInvocableSkill(storageRoot, name);
  return wrapSkillPrompt({
    name: skill.name,
    content: skill.content,
    text,
    ...(resourceDir !== undefined ? { resourceDir } : {}),
  });
}
