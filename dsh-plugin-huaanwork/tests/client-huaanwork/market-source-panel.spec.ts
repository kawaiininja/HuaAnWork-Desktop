import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panelSource = () =>
  readFileSync(
    resolve(import.meta.dirname, "../../src/client-huaanwork/MarketSourcePanel.tsx"),
    "utf8",
  );

describe("MarketSourcePanel copy invariants (D4)", () => {
  it("makes no milestone promise for multi-source management", () => {
    expect(panelSource()).not.toMatch(/将在\s*M\d+\s*提供/u);
    expect(panelSource()).not.toContain("多来源管理将在 M6 提供");
  });

  it("keeps the honest single-trusted-source statement", () => {
    expect(panelSource()).toContain("当前版本仅支持内网单一受信任源");
  });

  it("keeps the disabled block non-interactive", () => {
    expect(panelSource()).toContain('<div className="market-source-disabled" aria-disabled="true">');
  });
});
