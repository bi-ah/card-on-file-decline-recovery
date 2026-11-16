// Runs recovery for a whole run in-process, against a LedgerLogic, with no real sleeping.
// Used by the invariant tests; the deployed system uses Workflows instead.

import type { LedgerLogic } from "../ledger/logic";
import { runRecovery, type RecoveryIO } from "./loop";

export function localIO(ledger: LedgerLogic, paymentId: string): RecoveryIO {
  return {
    initialEvent: async () => ledger.initialEvent(paymentId),
    decide: async (step, e) => ledger.decide(paymentId, step, e),
    sleep: async () => {},
    reserve: async (step, d) => ledger.reserve(paymentId, step, d),
    callPsp: async (_step, reserveStep) => ledger.simulatePsp(paymentId, reserveStep),
    record: async (_step, reserveStep, r) => ledger.record(paymentId, reserveStep, r),
    updateCredential: async (step, at) => ledger.updateCredential(paymentId, step, at),
    askCustomer: async (step, at) => ledger.askCustomer(paymentId, step, at),
    customerUpdated: async (step, at) => ledger.customerUpdated(paymentId, step, at),
    finish: async (_step, d, at) => ledger.finish(paymentId, d, at),
  };
}

export async function recoverRunLocally(ledger: LedgerLogic, runId: string): Promise<void> {
  const { paymentIds } = ledger.startRecovery(runId, Date.now());
  for (const id of paymentIds) await runRecovery(localIO(ledger, id));
}
