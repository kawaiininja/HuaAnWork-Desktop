import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "vitest";

import { declaresAskTool, planTarget, targetChanged } from "../../src/huaanwork-guardrails/plan-signals.ts";

const env = { workspaceRoot: tmpdir(), gitDirty: () => false, attachedTools: [] as string[] };

test("declaresAskTool follows the policy ask-set", () => {
  assert.equal(declaresAskTool("# 汇总\n\n读 `docs/a.md`，运行 `npm test`", env), false);
  assert.equal(declaresAskTool("# 发布\n\n`git push origin main`", env), true);
  assert.equal(declaresAskTool("# 清理\n\n```sh\nrm -rf build\n```", env), true);
  assert.equal(declaresAskTool("# 抓取\n\n`curl http://x`", env), true);
  assert.equal(declaresAskTool("# 外发\n\n把报告发送给财务", env), true);
  assert.equal(declaresAskTool("# 切换\n\ngit checkout main", env), false);
  assert.equal(declaresAskTool("# 切换\n\ngit checkout main", { ...env, gitDirty: () => true }), true);
  assert.equal(declaresAskTool("# 查询\n\n用 issue_search 查", { ...env, attachedTools: ["issue_search"] }), true);
  assert.equal(declaresAskTool("# 代码\n\n```ts\nconst a = b && c;\n```", env), false);
});

test("targetChanged compares goal, recipients and write scope with the last confirmed plan", () => {
  const base = planTarget("# 周报\n\n写入 `out/report.md`，收件人：张三");
  assert.equal(targetChanged(undefined, base), false);
  assert.equal(targetChanged(base, planTarget("# 周报\n\n先读，再写入 `out/report.md`，收件人：张三")), false);
  assert.equal(targetChanged(base, planTarget("# 月报\n\n写入 `out/report.md`，收件人：张三")), true);
  assert.equal(targetChanged(base, planTarget("# 周报\n\n写入 `out/report.md`，收件人：李四")), true);
  assert.equal(targetChanged(base, planTarget("# 周报\n\n写入 `out/other.md`，收件人：张三")), true);
  assert.equal(targetChanged(base, planTarget("# 周报\n\n写入 `out/report.md`，发给 a@b.com，收件人：张三")), true);
});
