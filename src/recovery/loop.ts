// One failed renewal's recovery loop. The Workflow runs it with durable steps and
// step.sleep; the tests run it with an in-memory clock. Every decision comes from the
// rules engine via the ledger; this loop only carries the decisions out.

import type { AuthResult } from "../sim/world";
import type { Decision, RecoveryEvent } from "../core/types";
import type { Reservation } from "../ledger/logic";

export interface RecoveryIO {
  initialEvent(step: string): Promise<RecoveryEvent>;
  decide(step: string, event: RecoveryEvent): Promise<Decision>;
  /** Wait a number of simulated minutes (durable sleep in the Workflow). */
  sleep(step: string, minutes: number): Promise<void>;
  reserve(step: string, d: Decision): Promise<Reservation>;
  callPsp(step: string, reserveStep: string): Promise<AuthResult>;
  record(step: string, reserveStep: string, r: AuthResult): Promise<void>;
  updateCredential(step: string, at: number): Promise<{ updated: boolean; version: number }>;
  askCustomer(step: string, at: number): Promise<{ respondsAfter: number | null; windowMinutes: number }>;
  customerUpdated(step: string, at: number): Promise<void>;
  finish(step: string, d: Decision | null, at: number): Promise<void>;
}

export const MAX_STEPS = 30;

export async function runRecovery(io: RecoveryIO): Promise<"recovered" | string> {
  let event = await io.initialEvent("load");
  let now = event.at;
  for (let i = 0; i < MAX_STEPS; i++) {
    const d = await io.decide(`decide-${i}`, event);
    if (d.action === "stop") {
      await io.finish("finish", d, d.at);
      return d.stopOutcome ?? "stopped";
    }
    if (d.at > now) await io.sleep(`wait-${i}`, d.at - now);
    now = d.at;

    if (d.action === "retry") {
      const reserveStep = `attempt-${i}`;
      const r = await io.reserve(reserveStep, d);
      if (!r.ok) {
        event = { type: "reservation_refused", at: now, reason: r.reason };
        continue;
      }
      const result = await io.callPsp(`psp-${i}`, reserveStep);
      await io.record(`record-${i}`, reserveStep, result);
      if (result.approved) {
        await io.finish("finish", null, now);
        return "recovered";
      }
      event = { type: "declined", at: now, code: result.code, ...(result.mac ? { mac: result.mac } : {}), psp: d.psp!, credentialVersion: r.attempt.credential_version };
    } else if (d.action === "update_credential") {
      const u = await io.updateCredential(`update-${i}`, now);
      event = u.updated ? { type: "credential_updated", at: now, credentialVersion: u.version } : { type: "credential_unchanged", at: now };
    } else if (d.action === "ask_customer") {
      const a = await io.askCustomer(`ask-${i}`, now);
      if (a.respondsAfter !== null) {
        await io.sleep(`await-customer-${i}`, a.respondsAfter);
        now += a.respondsAfter;
        await io.customerUpdated(`customer-${i}`, now);
        event = { type: "customer_updated", at: now };
      } else {
        await io.sleep(`await-customer-${i}`, a.windowMinutes);
        now += a.windowMinutes;
        event = { type: "customer_no_response", at: now };
      }
    }
  }
  await io.finish("finish", null, now);
  return "exhausted";
}
