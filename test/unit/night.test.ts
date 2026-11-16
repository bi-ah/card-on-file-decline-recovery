import { describe, expect, it } from "vitest";
import { auditRun } from "../../src/ledger/audit";
import { recoverRunLocally } from "../../src/recovery/local";
import { memoryLedger } from "./support";

const SEEDS = [1, 2, 3, 4, 5];

describe.each(SEEDS)("whole night, seed %i", (seed) => {
  it("obeys every guardrail and recovers more revenue with fewer retries than the naive schedule", async () => {
    const ledger = memoryLedger();
    const runId = `run_test_${seed}`;
    ledger.createRun({ runId, seed, renewals: 2000, nightDate: "2026-11-16", dayMs: 0, label: "test", createdAt: 0 });
    await recoverRunLocally(ledger, runId);
    const s = ledger.summary(runId);
    expect(s.inProgress).toBe(0);
    expect(s.declined).toBeGreaterThan(220);
    expect(s.declined).toBeLessThan(450);
    expect(auditRun(ledger.exportRun(runId))).toEqual([]);
    expect(s.recoveredCents).toBeGreaterThan(s.naive.recoveredCents);
    expect(s.retries).toBeLessThan(s.naive.retries);
    expect(s.naive.neverRetryViolations).toBeGreaterThan(0);
    expect(ledger.getRun(runId)!.status).toBe("completed");
  });
});

describe("idempotency and atomic reservation", () => {
  it("returns the same decision, reservation and result when a step runs twice", () => {
    const ledger = memoryLedger();
    ledger.createRun({ runId: "r", seed: 9, renewals: 600, nightDate: "2026-11-16", dayMs: 0, label: "test", createdAt: 0 });
    const { paymentIds } = ledger.startRecovery("r", 0);
    const id = paymentIds.find((p) => {
      const e = ledger.initialEvent(p);
      return e.type === "declined" && e.code === "05";
    })!;
    const e = ledger.initialEvent(id);
    const d1 = ledger.decide(id, "decide-0", e);
    expect(ledger.decide(id, "decide-0", e)).toEqual(d1);
    const r1 = ledger.reserve(id, "attempt-0", d1);
    expect(ledger.reserve(id, "attempt-0", d1)).toEqual(r1);
    const res = ledger.simulatePsp(id, "attempt-0");
    ledger.record(id, "attempt-0", res);
    ledger.record(id, "attempt-0", res);
    expect(ledger.exportRun("r").attempts.filter((a) => a.payment_id === id)).toHaveLength(2);
    expect(ledger.payment(id).retries_used).toBe(1);
  });

  it("refuses to reserve an attempt on a blocked credential", () => {
    const ledger = memoryLedger();
    ledger.createRun({ runId: "r", seed: 4, renewals: 2000, nightDate: "2026-11-16", dayMs: 0, label: "test", createdAt: 0 });
    const { paymentIds } = ledger.startRecovery("r", 0);
    const id = paymentIds.find((p) => {
      const e = ledger.initialEvent(p);
      return e.type === "declined" && ["41", "43", "04"].includes(e.code);
    })!;
    const e = ledger.initialEvent(id);
    ledger.decide(id, "decide-0", e);
    const forged = { action: "retry" as const, at: e.at + 60, waitMinutes: 60, psp: "psp-us" as const, route: "same_psp" as const, reason: "forged", ruleIds: [], classification: "x" };
    expect(ledger.reserve(id, "attempt-x", forged)).toEqual({ ok: false, reason: "credential version is blocked (never-retry decline)" });
  });

  it("refuses a reservation that would break a network limit", () => {
    const ledger = memoryLedger();
    ledger.createRun({ runId: "r", seed: 6, renewals: 600, nightDate: "2026-11-16", dayMs: 0, label: "test", createdAt: 0 });
    const { paymentIds } = ledger.startRecovery("r", 0);
    const id = paymentIds.find((p) => ledger.payment(p).brand === "mastercard" && ledger.initialEvent(p).type === "declined" && (ledger.initialEvent(p) as { code: string }).code === "05")!;
    const at = ledger.initialEvent(id).at;
    let refused = false;
    for (let i = 0; i < 8; i++) {
      const d = { action: "retry" as const, at: at + i, waitMinutes: 0, psp: ledger.payment(id).first_psp, route: "same_psp" as const, reason: "test", ruleIds: [], classification: "x" };
      const r = ledger.reserve(id, `attempt-${i}`, d);
      if (!r.ok) {
        refused = true;
        expect(r.reason).toMatch(/network attempt limit|retry budget/);
        break;
      }
      ledger.record(id, `attempt-${i}`, { approved: false, code: "05" });
    }
    expect(refused).toBe(true);
  });
});
