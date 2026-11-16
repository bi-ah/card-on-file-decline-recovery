// Audits a run's ledger against the guardrails. Used by the invariant tests (in-process)
// and the functional tests (over the API export), so both check the same things.

import { classify, isCascadable, RULES } from "../core/rules";
import { DAY } from "../core/time";
import type { Decision } from "../core/types";
import type { AttemptRow, DecisionRow, EventRow, PaymentRow } from "./logic";

export interface RunExport {
  payments: PaymentRow[];
  attempts: AttemptRow[];
  decisions: DecisionRow[];
  events: EventRow[];
}

export interface Violation {
  rule: string;
  paymentId: string;
  detail: string;
}

const PAN_LIKE = /(?<![\w.])\d{13,19}(?![\w.])/;

export function auditRun(x: RunExport): Violation[] {
  const v: Violation[] = [];
  const byPayment = new Map<string, AttemptRow[]>();
  for (const a of x.attempts) {
    const list = byPayment.get(a.payment_id) ?? [];
    list.push(a);
    byPayment.set(a.payment_id, list);
  }
  const decisionsBy = new Map<string, Array<{ row: DecisionRow; d: Decision }>>();
  for (const row of x.decisions) {
    const list = decisionsBy.get(row.payment_id) ?? [];
    list.push({ row, d: JSON.parse(row.json) as Decision });
    decisionsBy.set(row.payment_id, list);
  }

  for (const p of x.payments) {
    const attempts = (byPayment.get(p.id) ?? []).sort((a, b) => a.seq - b.seq);
    const decisions = (decisionsBy.get(p.id) ?? []).sort((a, b) => a.row.at - b.row.at || stepNo(a.row.step) - stepNo(b.row.step));

    // Guardrail 3a: no attempt on a credential version after a never-retry decline blocked it.
    for (const { row, d } of decisions) {
      if (d.blocksCredentialVersion === undefined) continue;
      const later = attempts.filter((a) => a.at >= row.at && a.step !== "initial" && a.customer_initiated === 0 && a.credential_version === d.blocksCredentialVersion && stepNo(a.step) >= stepNo(row.step));
      for (const a of later) v.push({ rule: "guardrail-3.never-retry", paymentId: p.id, detail: `attempt ${a.step} reused credential version ${a.credential_version} blocked by ${d.classification}` });
    }

    // Guardrail 3b: no cascade of insufficient funds, risk or hard declines.
    for (let i = 1; i < attempts.length; i++) {
      const prev = attempts[i - 1]!;
      const cur = attempts[i]!;
      if (cur.customer_initiated || prev.status !== "declined" || prev.psp === cur.psp) continue;
      const dec = decisions.find((d) => d.row.step === `decide-${stepNo(cur.step)}`);
      if (dec?.d.route !== "next_psp") continue; // a router choice after a credential refresh is not a cascade
      const rule = classify(p.brand, prev.code!, prev.mac ?? undefined);
      if (!isCascadable(rule)) v.push({ rule: "guardrail-3.no-cascade", paymentId: p.id, detail: `${prev.code}${prev.mac ? `/MAC ${prev.mac}` : ""} cascaded from ${prev.psp} to ${cur.psp}` });
    }

    // Policy: retry budget, alternative PSPs, dunning window.
    const merchantRetries = attempts.filter((a) => a.step !== "initial" && a.customer_initiated === 0);
    if (merchantRetries.length > RULES.policy.maxRetriesPerRenewal) v.push({ rule: "policy.max_retries", paymentId: p.id, detail: `${merchantRetries.length} retries` });
    if (p.alt_retries_used > RULES.policy.maxAltPspRetries) v.push({ rule: "policy.max_alt_psp", paymentId: p.id, detail: `${p.alt_retries_used} retries via another PSP` });
    for (const a of merchantRetries) {
      if (p.first_decline_at !== null && a.at > p.first_decline_at + RULES.policy.dunningWindowDays * DAY) v.push({ rule: "policy.dunning_window", paymentId: p.id, detail: `attempt ${a.step} outside the window` });
    }

    // Guardrail 6 and the brief: every attempt carries credential type, MIT flag and NTID.
    for (const a of attempts) {
      if (a.credential_type !== "network_token" && a.credential_type !== "pan_fallback") v.push({ rule: "attempt.credential_type", paymentId: p.id, detail: `${a.step}: ${a.credential_type}` });
      if (a.mit !== 0 && a.mit !== 1) v.push({ rule: "attempt.mit_flag", paymentId: p.id, detail: a.step });
      if (!a.ntid) v.push({ rule: "attempt.ntid", paymentId: p.id, detail: a.step });
      if (a.status === "reserved") v.push({ rule: "guardrail-5.unrecorded", paymentId: p.id, detail: `${a.step} reserved but never recorded` });
    }
  }

  // Guardrail 4: limits per card lineage across PSPs, original included.
  const byLineage = new Map<string, { brand: string; times: number[]; payment: string }>();
  const brandOf = new Map(x.payments.map((p) => [p.id, p.brand]));
  for (const a of x.attempts) {
    const e = byLineage.get(a.lineage_id) ?? { brand: brandOf.get(a.payment_id)!, times: [], payment: a.payment_id };
    e.times.push(a.at);
    byLineage.set(a.lineage_id, e);
  }
  for (const [lineage, e] of byLineage) {
    for (const l of RULES.limits.filter((l) => l.brand === e.brand)) {
      for (const t of e.times) {
        const n = e.times.filter((s) => s > t - l.windowMinutes && s <= t).length;
        if (n > l.maxAttempts) {
          v.push({ rule: `guardrail-4.${l.id}`, paymentId: e.payment, detail: `${n} attempts on ${lineage} in the window ending ${t}` });
          break;
        }
      }
    }
  }

  // Guardrail 6: nothing that looks like a card number anywhere in the ledger.
  const text = JSON.stringify([x.payments, x.attempts, x.decisions, x.events]);
  if (PAN_LIKE.test(text)) v.push({ rule: "guardrail-6.no-pan", paymentId: "-", detail: "a 13 to 19 digit number appears in the ledger" });
  return v;
}

function stepNo(step: string): number {
  const m = /-(\d+)$/.exec(step);
  return m ? Number(m[1]) : -1;
}
