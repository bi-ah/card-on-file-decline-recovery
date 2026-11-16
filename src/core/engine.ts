// The rules engine. Pure and deterministic: the same state, event and configuration
// always give the same decision. It makes every decision; the language model never does.

import { classify, RULES, type Rule, type RulesConfig } from "./rules";
import { earliestWithinLimits } from "./limits";
import { nextPayday, DAY } from "./time";
import type { Decision, PspId, RecoveryEvent, RecoveryState } from "./types";

export function decide(state: RecoveryState, event: RecoveryEvent, cfg: RulesConfig = RULES): Decision {
  switch (event.type) {
    case "declined":
      return onDecline(state, event, cfg);
    case "credential_updated":
      return scheduleRetry(state, event.at, 0, routerPsp(state), "router", ["credential.updated"], "Credential refreshed; retry with the new credential", state.lastClassification ?? "credential.updated", cfg);
    case "credential_unchanged":
      return askOrStop(state, event.at, "The credential could not be refreshed", ["credential.unchanged"], state.lastClassification ?? "credential.unchanged", cfg);
    case "customer_updated":
      return {
        action: "retry",
        at: event.at,
        waitMinutes: 0,
        psp: routerPsp(state),
        route: "router",
        customerInitiated: true,
        reason: "The customer entered a new card; charge it now as a customer-initiated payment",
        ruleIds: ["policy.customer_card"],
        classification: "customer.updated",
      };
    case "customer_no_response":
      return stop(event.at, "exhausted", true, "The customer did not update the card within the response window", ["policy.customer_window"], "customer.no_response");
    case "reservation_refused":
      return askOrStop(state, event.at, `The ledger refused the attempt: ${event.reason}`, ["policy.max_retries"], "reservation.refused", cfg);
  }
}

function onDecline(state: RecoveryState, ev: Extract<RecoveryEvent, { type: "declined" }>, cfg: RulesConfig): Decision {
  const rule = classify(state.brand, ev.code, ev.mac, cfg);
  const blocks = rule.blocksCredential ? ev.credentialVersion : undefined;
  const t = rule.treatment;
  const label = `${ev.mac ? `MAC ${ev.mac} on ` : ""}response ${ev.code}: ${rule.label}`;
  let d: Decision;

  switch (t.kind) {
    case "stop":
      d = stop(ev.at, t.outcome, t.notify, label, [rule.id], rule.id);
      break;
    case "ask_customer":
      d = askOrStop({ ...state, lastClassification: rule.id }, ev.at, label, [rule.id], rule.id, cfg);
      break;
    case "fix_credential":
      if (!state.updaterTriedVersions.includes(ev.credentialVersion)) {
        d = {
          action: "update_credential",
          at: ev.at,
          waitMinutes: 0,
          reason: `${label}. Refresh the credential (token lifecycle or account updater) before any retry`,
          ruleIds: [rule.id],
          classification: rule.id,
        };
      } else {
        d = askOrStop(state, ev.at, `${label}. The credential was already refreshed`, [rule.id], rule.id, cfg);
      }
      break;
    case "retry": {
      d = retryAfterDecline(state, ev, rule, cfg);
      break;
    }
  }
  if (blocks !== undefined) d.blocksCredentialVersion = blocks;
  return d;
}

function retryAfterDecline(state: RecoveryState, ev: Extract<RecoveryEvent, { type: "declined" }>, rule: Rule, cfg: RulesConfig): Decision {
  const t = rule.treatment;
  if (t.kind !== "retry") throw new Error("not a retry rule");
  const policy = cfg.policy;
  const next = nextCapablePsp(state, ev.psp);
  const canCascade = t.cascade && state.altPspRetriesUsed < policy.maxAltPspRetries && next !== undefined;

  let wait: number;
  switch (t.timing.kind) {
    case "payday":
      wait = nextPayday(state.nightDate, ev.at, policy.paydayHourUtc, policy.paydayMinGapMinutes, policy.paydays) - ev.at;
      break;
    case "fixed":
      wait = t.timing.minutes;
      break;
    case "immediate":
      wait = canCascade ? 0 : 60;
      break;
    case "backoff": {
      const s = t.timing.scheduleMinutes;
      wait = s[Math.min(state.retriesUsed, s.length - 1)]!;
      // Cascading to another acquirer does not need the full wait.
      if (canCascade) wait = Math.min(wait, 60);
      break;
    }
  }
  const ruleIds = [rule.id];
  if (t.cascade && !canCascade && state.altPspRetriesUsed >= policy.maxAltPspRetries) ruleIds.push("policy.max_alt_psp");
  const psp = canCascade ? next! : ev.psp;
  const label = `${ev.mac ? `MAC ${ev.mac} on ` : ""}response ${ev.code}: ${rule.label}`;
  return scheduleRetry(state, ev.at, wait, psp, canCascade ? "next_psp" : "same_psp", ruleIds, label, rule.id, cfg);
}

/** Apply merchant policy and network limits to a proposed retry. */
function scheduleRetry(
  state: RecoveryState,
  now: number,
  wait: number,
  psp: PspId,
  route: Decision["route"],
  ruleIds: string[],
  reason: string,
  classification: string,
  cfg: RulesConfig,
): Decision {
  const policy = cfg.policy;
  if (state.blockedVersions.includes(state.credentialVersion)) {
    return askOrStop(state, now, `${reason}. This credential is blocked from further attempts`, [...ruleIds], classification, cfg);
  }
  if (state.retriesUsed >= policy.maxRetriesPerRenewal) {
    return askOrStop(state, now, `${reason}. Retry budget used (${policy.maxRetriesPerRenewal})`, [...ruleIds, "policy.max_retries"], classification, cfg);
  }
  const proposed = now + wait;
  const { at, limitIds } = earliestWithinLimits(state.brand, state.lineageAttempts, proposed, cfg.limits);
  const windowEnd = state.firstDeclineAt + policy.dunningWindowDays * DAY;
  if (at > windowEnd) {
    return askOrStop(state, now, `${reason}. The next allowed attempt falls outside the ${policy.dunningWindowDays}-day dunning window`, [...ruleIds, ...limitIds, "policy.dunning_window"], classification, cfg);
  }
  return {
    action: "retry",
    at,
    waitMinutes: at - now,
    psp,
    route,
    reason: limitIds.length ? `${reason}. Moved later to stay within network limits` : reason,
    ruleIds: [...ruleIds, ...limitIds],
    classification,
  };
}

function askOrStop(state: RecoveryState, now: number, reason: string, ruleIds: string[], classification: string, _cfg: RulesConfig): Decision {
  if (!state.customerAsked) {
    return {
      action: "ask_customer",
      at: now,
      waitMinutes: 0,
      reason: `${reason}. Ask the customer to update the card through the hosted form`,
      ruleIds,
      classification,
    };
  }
  return stop(now, "exhausted", true, `${reason}. The customer was already asked`, ruleIds, classification);
}

function stop(at: number, outcome: Decision["stopOutcome"], notify: boolean, reason: string, ruleIds: string[], classification: string): Decision {
  return { action: "stop", at, waitMinutes: 0, stopOutcome: outcome, notifyCustomer: notify, reason, ruleIds, classification };
}

function routerPsp(state: RecoveryState): PspId {
  return state.routerOrder[0] ?? state.lastPsp;
}

function nextCapablePsp(state: RecoveryState, current: PspId): PspId | undefined {
  return state.routerOrder.find((p) => p !== current);
}
