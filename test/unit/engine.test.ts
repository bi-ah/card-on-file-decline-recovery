import { describe, expect, it } from "vitest";
import { decide } from "../../src/core/engine";
import { allRules, classify, isCascadable } from "../../src/core/rules";
import type { RecoveryState } from "../../src/core/types";
import { CASES, NOW } from "./decline-cases";

function baseState(over: Partial<RecoveryState> = {}): RecoveryState {
  return {
    brand: "visa",
    nightDate: "2026-11-16",
    firstDeclineAt: NOW,
    retriesUsed: 0,
    altPspRetriesUsed: 0,
    lastPsp: "psp-eu",
    credentialVersion: 1,
    blockedVersions: [],
    updaterTriedVersions: [],
    customerAsked: false,
    lineageAttempts: [NOW],
    routerOrder: ["psp-eu", "psp-uk", "psp-us", "psp-apac"],
    ...over,
  };
}

describe("decline table", () => {
  it("has at least 50 labelled cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
  });

  for (const c of CASES) {
    it(c.label, () => {
      const state = baseState({ brand: c.brand ?? "visa", ...c.state });
      const event = c.event ?? { type: "declined" as const, at: NOW, code: c.code!, ...(c.mac ? { mac: c.mac } : {}), psp: "psp-eu" as const, credentialVersion: 1 };
      const d = decide(state, event);
      expect(d.action).toBe(c.expect.action);
      expect([d.classification, ...d.ruleIds]).toContain(c.expect.rule);
      if (c.expect.psp) expect(d.psp).toBe(c.expect.psp);
      if (c.expect.route) expect(d.route).toBe(c.expect.route);
      if (c.expect.waitMinutes !== undefined) expect(d.waitMinutes).toBe(c.expect.waitMinutes);
      if (c.expect.stopOutcome) expect(d.stopOutcome).toBe(c.expect.stopOutcome);
      if (c.expect.blocks !== undefined) expect(d.blocksCredentialVersion).toBe(c.expect.blocks);
      expect(d.reason.length).toBeGreaterThan(10);
      expect(d.at).toBe(NOW + d.waitMinutes);
    });
  }
});

describe("rules engine properties", () => {
  it("is deterministic", () => {
    const s = baseState();
    const e = { type: "declined" as const, at: NOW, code: "05", psp: "psp-eu" as const, credentialVersion: 1 };
    expect(decide(s, e)).toEqual(decide(s, e));
  });

  it("never schedules a retry for a Visa Category 1 code or Mastercard MAC 03 or 21 on the same credential", () => {
    const cases: Array<[RecoveryState["brand"], string, string | undefined]> = [
      ...["04", "07", "12", "14", "15", "41", "43", "46", "57", "R0", "R1", "R3"].map((c) => ["visa", c, undefined] as [RecoveryState["brand"], string, undefined]),
      ["mastercard", "05", "03"],
      ["mastercard", "51", "21"],
    ];
    for (const [brand, code, mac] of cases) {
      for (const over of [{}, { updaterTriedVersions: [1] }, { customerAsked: true }, { updaterTriedVersions: [1], customerAsked: true }]) {
        const d = decide(baseState({ brand, ...over }), { type: "declined", at: NOW, code, ...(mac ? { mac } : {}), psp: "psp-eu", credentialVersion: 1 });
        expect(d.action, `${brand} ${code} ${mac ?? ""}`).not.toBe("retry");
        expect(d.blocksCredentialVersion).toBe(1);
      }
    }
  });

  it("never cascades insufficient funds, risk or hard declines", () => {
    for (const [brand, code, mac] of [
      ["visa", "51"],
      ["visa", "61"],
      ["visa", "59"],
      ["mastercard", "51"],
      ["mastercard", "59"],
      ["mastercard", "63"],
      ["mastercard", "51", "26"],
    ] as Array<[RecoveryState["brand"], string, string?]>) {
      expect(isCascadable(classify(brand, code, mac))).toBe(false);
      const d = decide(baseState({ brand }), { type: "declined", at: NOW, code, ...(mac ? { mac } : {}), psp: "psp-eu", credentialVersion: 1 });
      if (d.action === "retry") expect(d.route).toBe("same_psp");
    }
  });

  it("gives every rule a source and a confidence", () => {
    for (const r of allRules()) {
      expect(r.source, r.id).toBeTruthy();
      expect(["high", "medium", "low"]).toContain(r.confidence);
    }
  });
});
