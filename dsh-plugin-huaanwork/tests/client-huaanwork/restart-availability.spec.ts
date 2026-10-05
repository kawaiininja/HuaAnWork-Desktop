import { describe, expect, it } from "vitest";
import { resolveRestartAvailability } from "../../src/client-huaanwork/logic/restartAvailability.ts";

describe("resolveRestartAvailability (M1/D5)", () => {
  it("prefers the market action when both channels are available", () => {
    expect(resolveRestartAvailability({ marketRestartAction: true, desktopRestartRoute: true }))
      .toEqual({ canRestart: true, route: "market-action" });
  });

  it("falls back to the desktop route when the market bundle is not registered (D5)", () => {
    expect(resolveRestartAvailability({ marketRestartAction: false, desktopRestartRoute: true }))
      .toEqual({ canRestart: true, route: "desktop-route" });
  });

  it("reports no entry point only when the desktop route is also gone", () => {
    expect(resolveRestartAvailability({ marketRestartAction: false, desktopRestartRoute: false }))
      .toEqual({ canRestart: false, route: "none" });
    expect(resolveRestartAvailability({ marketRestartAction: true, desktopRestartRoute: false }))
      .toEqual({ canRestart: true, route: "market-action" });
  });

  it("never lets the market-side signals veto the desktop route", () => {
    for (const marketRestartAction of [true, false]) {
      const result = resolveRestartAvailability({ marketRestartAction, desktopRestartRoute: true });
      expect(result.canRestart).toBe(true);
      expect(result.route).toBe(marketRestartAction ? "market-action" : "desktop-route");
    }
  });
});
