// The comparisons, computed in code against the same seeded simulators.
// Naive: retry on days 1, 3, 5 and 7 through the same PSP, every code, no updater, no customer.
// Legacy: the same naive schedule, but with one PSP's own token (no network tokens,
// black-box updater, cross-border for non-US cards).

import { classify } from "../core/rules";
import { DAY } from "../core/time";
import type { PspId } from "../core/types";
import { authorize, type AuthResult, type SimCard, type SimNight } from "./world";

export interface BaselineResult {
  declines: number;
  recovered: number;
  recoveredCents: number;
  declinedCents: number;
  retries: number;
  neverRetryViolations: number;
}

export interface InitialAttempt {
  psp: PspId;
  credentialType: "network_token" | "pan_fallback" | "psp_token";
  credentialVersion: number;
  result: AuthResult;
}

const NAIVE_DAYS = [1, 3, 5, 7];

function naiveRetries(night: SimNight, card: SimCard, first: InitialAttempt, out: BaselineResult): void {
  if (first.result.approved) return;
  out.declines++;
  out.declinedCents += card.amountCents;
  let last: AuthResult = first.result;
  for (const [k, d] of NAIVE_DAYS.entries()) {
    if (last.approved) break;
    const rule = classify(card.brand, last.code, last.mac);
    if (rule.blocksCredential || rule.treatment.kind === "stop") out.neverRetryViolations++;
    out.retries++;
    last = authorize(night, card, {
      at: card.billAt + d * DAY,
      psp: first.psp,
      credentialType: first.credentialType,
      credentialVersion: first.credentialVersion,
      customerCard: false,
      attemptNo: k + 1,
    });
    if (last.approved) {
      out.recovered++;
      out.recoveredCents += card.amountCents;
    }
  }
}

function empty(): BaselineResult {
  return { declines: 0, recovered: 0, recoveredCents: 0, declinedCents: 0, retries: 0, neverRetryViolations: 0 };
}

/** The naive schedule applied to the same declines the platform saw. */
export function naiveOnSameDeclines(night: SimNight, initial: Map<string, InitialAttempt>): BaselineResult {
  const out = empty();
  for (const card of night.cards) {
    const first = initial.get(card.paymentId);
    if (first) naiveRetries(night, card, first, out);
  }
  return out;
}

/** The legacy single-PSP setup from the problem statement, with the naive schedule. */
export function legacySinglePsp(night: SimNight): BaselineResult & { renewals: number; approvedFirst: number } {
  const out = empty();
  let approvedFirst = 0;
  for (const card of night.cards) {
    const version = (card.scenario === "expired" || card.scenario === "lost") && card.legacyUpdaterCaught ? 2 : 1;
    const first: InitialAttempt = {
      psp: "psp-us",
      credentialType: "psp_token",
      credentialVersion: version,
      result: authorize(night, card, { at: card.billAt, psp: "psp-us", credentialType: "psp_token", credentialVersion: version, customerCard: false, attemptNo: 0 }),
    };
    if (first.result.approved) approvedFirst++;
    naiveRetries(night, card, first, out);
  }
  return { ...out, renewals: night.cards.length, approvedFirst };
}
