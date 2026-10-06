import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const guard = join(repoRoot, "dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs");

function runGuard(args: string[], env: Record<string, string>) {
  try {
    const out = execFileSync(process.execPath, [guard, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (error) {
    const cause = error as { status?: number; stdout?: string; stderr?: string };
    return { status: cause.status ?? 1, out: `${cause.stdout ?? ""}${cause.stderr ?? ""}` };
  }
}

describe("dist:mac-smoke provisioning gate (M13, ruling R-M7-8)", () => {
  it("requires provisioning by default on the smoke path, like the three release commands", () => {
    const result = runGuard(["--smoke"], {});
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("unprovisioned release build");
  });

  it("allows the smoke path only when the exemption is declared explicitly", () => {
    const result = runGuard(["--smoke"], { HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: "1" });
    expect(result.status).toBe(0);
    expect(result.out).toContain("HUAANWORK_ALLOW_UNPROVISIONED_SMOKE");
    expect(result.out).toContain("unsigned");
  });

  it("never honours the exemption on the release path (--smoke absent)", () => {
    const result = runGuard([], { HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: "1" });
    expect(result.status).not.toBe(0);
    expect(result.out).not.toContain("exemption accepted");
  });

  it("wires the gate into the root smoke script and the CI smoke step", () => {
    const rootScripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(rootScripts["dist:mac-smoke:huaanwork"]).toContain("huaanwork-verify-provisioning.mjs --smoke");
    for (const key of ["dist:mac:huaanwork", "dist:win:huaanwork", "dist:win-portable:huaanwork"]) {
      expect(rootScripts[key]).toContain("huaanwork-verify-provisioning.mjs");
      expect(rootScripts[key]).not.toContain("--smoke");
    }
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("HUAANWORK_ALLOW_UNPROVISIONED_SMOKE");
  });
});
