import assert from "node:assert/strict";
import { test } from "vitest";

import {
  SYSTEM_SKILLS,
  canToggleSkill,
  filterSkills,
  isReservedSlash,
  isSkillInvocable,
  parseSlashInvoke,
  slashSkills,
  slashTokenAt,
  sourceLabel,
  tabLabel,
  validateSkillForm,
  type SkillInfo,
} from "../../src/client-huaanwork/logic/skillsLogic.ts";

const SKILLS: SkillInfo[] = [
  { name: "explore", description: "只读探索", source: "bundled" },
  { name: "demo", description: "我的演示", source: "user" },
  { name: "ext", description: "外部演示", source: "external" },
];

test("sourceLabel and tabLabel map sources to Chinese labels", () => {
  assert.equal(sourceLabel("bundled"), "内置");
  assert.equal(sourceLabel("user"), "我创建的");
  assert.equal(sourceLabel("external"), "外部");
  assert.equal(tabLabel("all"), "全部");
  assert.equal(tabLabel("user"), "我创建的");
});

test("filterSkills scopes by tab then by query", () => {
  assert.deepEqual(filterSkills(SKILLS, "all", "").map((s) => s.name), ["explore", "demo", "ext"]);
  assert.deepEqual(filterSkills(SKILLS, "user", "").map((s) => s.name), ["demo"]);
  assert.deepEqual(filterSkills(SKILLS, "all", "演示").map((s) => s.name), ["demo", "ext"]);
  assert.deepEqual(filterSkills(SKILLS, "external", "演示").map((s) => s.name), ["ext"]);
  assert.deepEqual(filterSkills(SKILLS, "bundled", "不存在"), []);
});

test("validateSkillForm enforces name grammar, duplicates, and required fields", () => {
  const base = { name: "demo", description: "d", whenToUse: "", content: "c", disableModelInvocation: false, userInvocable: true };
  assert.deepEqual(validateSkillForm(base, { editing: false, takenNames: [] }), {});
  assert.ok(validateSkillForm({ ...base, name: "Bad_Name" }, { editing: false, takenNames: [] }).name);
  assert.ok(validateSkillForm(base, { editing: false, takenNames: ["demo"] }).name);
  assert.ok(validateSkillForm({ ...base, description: " " }, { editing: false, takenNames: [] }).description);
  assert.ok(validateSkillForm({ ...base, content: "" }, { editing: false, takenNames: [] }).content);
  // 编辑模式不校验名称（名称锁定）
  assert.deepEqual(validateSkillForm({ ...base, name: "" }, { editing: true, takenNames: [] }), {});
});

test("canToggleSkill: only bundled non-system skills", () => {
  assert.equal(canToggleSkill({ source: "bundled", name: "pdf" }), true);
  assert.equal(canToggleSkill({ source: "bundled", name: "explore" }), false);
  assert.equal(canToggleSkill({ source: "bundled", name: "test-fix" }), false);
  assert.equal(canToggleSkill({ source: "user", name: "pdf" }), false);
  assert.equal(canToggleSkill({ source: "external", name: "pdf" }), false);
  assert.ok(SYSTEM_SKILLS.has("explore") && SYSTEM_SKILLS.has("test-fix"));
});

test("slash helpers only list enabled skills and parse leading /name", () => {
  const catalog: SkillInfo[] = [
    { name: "explore", description: "只读探索", source: "bundled", enabled: true },
    { name: "pdf", description: "处理 PDF", source: "bundled", enabled: false },
    { name: "investigate", description: "根因分析", source: "bundled", enabled: true },
    { name: "my-note", description: "用户笔记", source: "user" },
  ];
  assert.equal(isSkillInvocable(catalog[1]!), false);
  assert.deepEqual(
    slashSkills(catalog, "inv").map((skill) => skill.name),
    ["investigate"],
  );
  assert.deepEqual(
    slashSkills(catalog, "").map((skill) => skill.name),
    ["explore", "investigate", "my-note"],
  );
  assert.equal(slashTokenAt("请看 /inv", 6)?.query, "inv");
  assert.equal(slashTokenAt("https://x.com", 4), undefined);
  assert.equal(slashTokenAt("foo/bar", 4), undefined);
  assert.equal(isReservedSlash("schedule"), true);
  assert.deepEqual(parseSlashInvoke("/investigate 登录 500"), { name: "investigate", remainder: "登录 500" });
  assert.equal(parseSlashInvoke("/schedule 每天 8 点"), undefined);
  assert.equal(parseSlashInvoke("先看看 /investigate"), undefined);
});
