// One Workflow instance per failed renewal. Each ledger call is a durable step keyed by
// (payment, step); waits are step.sleep on the compressed clock.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runRecovery, type RecoveryIO } from "../recovery/loop";
import type { Decision, RecoveryEvent } from "../core/types";
import type { AuthResult } from "../sim/world";
import type { Reservation } from "../ledger/logic";
import { ledgerOf } from "./ledger-do";

export interface RecoveryParams {
  runId: string;
  paymentId: string;
  dayMs: number;
}

export class RecoveryWorkflow extends WorkflowEntrypoint<Env, RecoveryParams> {
  async run(event: WorkflowEvent<RecoveryParams>, step: WorkflowStep): Promise<string> {
    const { paymentId, dayMs } = event.payload;
    const ledger = ledgerOf(this.env);
    const msPerMinute = dayMs / 1440;
    const cfg = { retries: { limit: 5, delay: 500, backoff: "exponential" as const }, timeout: 30_000 };
    const run = <T>(name: string, fn: () => Promise<T>): Promise<T> => step.do(name, cfg, async () => (await fn()) as never) as Promise<T>;

    const io: RecoveryIO = {
      initialEvent: (s) => run<RecoveryEvent>(s, () => ledger.initialEvent(paymentId) as Promise<RecoveryEvent>),
      decide: (s, e) => run<Decision>(s, () => ledger.decide(paymentId, s, e) as Promise<Decision>),
      sleep: async (s, minutes) => {
        const ms = Math.round(minutes * msPerMinute);
        if (ms >= 1) await step.sleep(s, ms);
      },
      reserve: (s, d) => run<Reservation>(s, () => ledger.reserve(paymentId, s, d) as Promise<Reservation>),
      callPsp: (s, reserveStep) => run<AuthResult>(s, () => ledger.simulatePsp(paymentId, reserveStep) as Promise<AuthResult>),
      record: (s, reserveStep, r) => run<void>(s, () => ledger.record(paymentId, reserveStep, r) as Promise<void>),
      updateCredential: (s, at) => run<{ updated: boolean; version: number }>(s, () => ledger.updateCredential(paymentId, s, at) as Promise<{ updated: boolean; version: number }>),
      askCustomer: (s, at) => run<{ respondsAfter: number | null; windowMinutes: number }>(s, () => ledger.askCustomer(paymentId, s, at) as Promise<{ respondsAfter: number | null; windowMinutes: number }>),
      customerUpdated: (s, at) => run<void>(s, () => ledger.customerUpdated(paymentId, s, at) as Promise<void>),
      finish: (s, d, at) => run<void>(s, () => ledger.finish(paymentId, d, at) as Promise<void>),
    };
    return runRecovery(io);
  }
}
