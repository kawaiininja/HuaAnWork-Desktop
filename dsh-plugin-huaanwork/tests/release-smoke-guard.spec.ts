import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const guard = join(repoRoot, "dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs");

function unprovisionedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "huaanwork-smoke-gate-"));
  const configPath = join(root, "dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts");
  const updatePath = join(root, "dsh-plugin-huaanwork/src/update-checker.ts");
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dirname(updatePath), { recursive: true });
  writeFileSync(configPath, [
    "export const HUAANWORK_MARKET_DEFAULT_ORIGIN = 'http://market.intranet.example:8787'",
    "export const PINS_AT_RELEASE: MarketVerificationPins = DEFAULT_MARKET_VERIFICATION_PINS",
    "export function assertMarketVerificationReady() { return PINS_AT_RELEASE }",
    "",
  ].join("\n"));
  writeFileSync(updatePath, "export const HUAANWORK_UPDATE_DEFAULT_ORIGIN = 'http://update.intranet.example:8790'\n");
  return root;
}

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
  it("accepts this repository on the smoke path without the exemption", () => {
    const result = runGuard(["--smoke"], {});
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("f34f6afeb6d36759dafeb218d1b70a851ac08e9cdcc4ae6d9cbc12c2860fb531");
    expect(result.out).not.toContain("exemption accepted");
    expect(result.out).not.toContain(".example");
  });

  it("still refuses an unprovisioned smoke path unless the exemption is declared", () => {
    const root = unprovisionedRoot();
    try {
      const refused = runGuard(["--smoke", "--root", root], {});
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("unprovisioned release build");

      const allowed = runGuard(["--smoke", "--root", root], { HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: "1" });
      expect(allowed.status).toBe(0);
      expect(allowed.out).toContain("HUAANWORK_ALLOW_UNPROVISIONED_SMOKE");
      expect(allowed.out).toContain("unsigned");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never honours the exemption on the release path (--smoke absent)", () => {
    const root = unprovisionedRoot();
    try {
      const result = runGuard(["--root", root], { HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: "1" });
      expect(result.status).not.toBe(0);
      expect(result.out).not.toContain("exemption accepted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
