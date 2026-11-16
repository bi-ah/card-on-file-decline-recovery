import { describe, expect, it } from "vitest";
import { authorize, generateNight, refreshCredential } from "../../src/sim/world";
import { nextPayday, simLabel } from "../../src/core/time";
import { POLICY } from "../../src/core/rules";

describe("simulators", () => {
  it("are deterministic for a seed and differ across seeds", () => {
    expect(generateNight(7, 200, "2026-11-16")).toEqual(generateNight(7, 200, "2026-11-16"));
    expect(generateNight(7, 200, "2026-11-16")).not.toEqual(generateNight(8, 200, "2026-11-16"));
  });

  it("hold no card numbers: only fictional 6-digit BINs and last four", () => {
    const n = generateNight(3, 500, "2026-11-16");
    for (const c of n.cards) {
      expect(c.bin).toMatch(/^[45]\d{5}$/);
      expect(c.last4).toMatch(/^\d{4}$/);
    }
    expect(JSON.stringify(n)).not.toMatch(/\d{13,19}/);
  });

  it("answer PSP_UNAVAILABLE inside the PSP outage and 91 inside the issuer outage", () => {
    const n = generateNight(5, 400, "2026-11-16");
    const card = n.cards.find((c) => c.scenario === "ok" && c.issuerId !== n.issuerOutage.issuerId)!;
    const r = authorize(n, card, { at: n.pspOutage.from + 1, psp: n.pspOutage.psp, credentialType: "network_token", credentialVersion: 1, customerCard: false, attemptNo: 0 });
    expect(r).toEqual({ approved: false, code: "PSP_UNAVAILABLE" });
    const issuerCard = { ...card, issuerId: n.issuerOutage.issuerId };
    const r2 = authorize(n, issuerCard, { at: n.issuerOutage.from + 1, psp: "psp-apac", credentialType: "network_token", credentialVersion: 1, customerCard: false, attemptNo: 0 });
    expect(r2).toEqual({ approved: false, code: "91" });
  });

  it("decline insufficient funds until the funds arrive", () => {
    const n = generateNight(11, 2000, "2026-11-16");
    const c = n.cards.find((x) => x.scenario === "funds" && x.fundsAt !== null && x.issuerId !== n.issuerOutage.issuerId)!;
    const before = authorize(n, c, { at: c.fundsAt! - 1, psp: "psp-apac", credentialType: "pan_fallback", credentialVersion: 1, customerCard: false, attemptNo: 1 });
    expect(before.approved).toBe(false);
  });

  it("never refresh a closed account", () => {
    const n = generateNight(13, 2000, "2026-11-16");
    const c = n.cards.find((x) => x.scenario === "closed")!;
    expect(refreshCredential(c)).toEqual({ updated: false, closed: true });
  });

  it("put paydays on the 1st, 15th, 25th and last day of the month", () => {
    const p = nextPayday("2026-11-16", 0, 8, 0, POLICY.paydays);
    expect(simLabel(p)).toBe("Day 10, 08:00"); // 25 November
    const p2 = nextPayday("2026-11-16", p + 1, 8, 0, POLICY.paydays);
    expect(simLabel(p2)).toBe("Day 15, 08:00"); // 30 November, the last day
  });
});
