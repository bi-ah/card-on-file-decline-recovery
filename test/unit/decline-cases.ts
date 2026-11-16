// The labelled decline table: each case's expected action, reason (rule), PSP and timing.
// Base state: a Visa card declined at minute 120 on 2026-11-16 through psp-eu; router
// order psp-eu, psp-uk, psp-us, psp-apac. Next payday: 25 Nov 08:00 = minute 13440.

import type { Action, Brand, PspId, RecoveryEvent, RecoveryState, StopOutcome } from "../../src/core/types";

export interface DeclineCase {
  label: string;
  brand?: Brand;
  code?: string;
  mac?: string;
  event?: RecoveryEvent;
  state?: Partial<RecoveryState>;
  expect: {
    action: Action;
    rule: string; // classification, or a rule id that must appear in ruleIds
    psp?: PspId;
    route?: "same_psp" | "next_psp" | "router";
    waitMinutes?: number;
    stopOutcome?: StopOutcome;
    blocks?: number;
  };
}

export const NOW = 120;
const PAYDAY_WAIT = 13440 - NOW;
const UPDATE = (rule: string): DeclineCase["expect"] => ({ action: "update_credential", rule, waitMinutes: 0, blocks: 1 });
const ASK = (rule: string): DeclineCase["expect"] => ({ action: "ask_customer", rule, waitMinutes: 0 });
const SAME = (rule: string, wait: number): DeclineCase["expect"] => ({ action: "retry", rule, psp: "psp-eu", route: "same_psp", waitMinutes: wait });
const NEXT = (rule: string, wait: number): DeclineCase["expect"] => ({ action: "retry", rule, psp: "psp-uk", route: "next_psp", waitMinutes: wait });
const STOP = (rule: string, outcome: StopOutcome): DeclineCase["expect"] => ({ action: "stop", rule, stopOutcome: outcome });

export const CASES: DeclineCase[] = [
  // Visa Category 1
  { label: "Visa 07 pick up, special condition: stop, no outreach", code: "07", expect: { ...STOP("visa.cat1.pickup_special", "stopped_silent"), blocks: 1 } },
  { label: "Visa 04 pick up card: updater first", code: "04", expect: UPDATE("visa.cat1.lost_stolen") },
  { label: "Visa 41 lost card: updater first", code: "41", expect: UPDATE("visa.cat1.lost_stolen") },
  { label: "Visa 43 stolen card: updater first", code: "43", expect: UPDATE("visa.cat1.lost_stolen") },
  { label: "Visa 41 after the updater found nothing: ask the customer", code: "41", state: { updaterTriedVersions: [1] }, expect: ASK("visa.cat1.lost_stolen") },
  { label: "Visa 41 after updater and customer: stop", code: "41", state: { updaterTriedVersions: [1], customerAsked: true }, expect: STOP("visa.cat1.lost_stolen", "exhausted") },
  { label: "Visa 46 closed account: updater first", code: "46", expect: UPDATE("visa.cat1.account") },
  { label: "Visa 14 invalid account number: updater first", code: "14", expect: UPDATE("visa.cat1.account") },
  { label: "Visa 15 no such issuer: ask the customer, no updater", code: "15", expect: ASK("visa.cat1.no_issuer_not_permitted") },
  { label: "Visa 57 not permitted: ask the customer, no updater", code: "57", expect: ASK("visa.cat1.no_issuer_not_permitted") },
  { label: "Visa 57 when the customer was already asked: stop", code: "57", state: { customerAsked: true }, expect: STOP("visa.cat1.no_issuer_not_permitted", "exhausted") },
  { label: "Visa 12 invalid transaction: stop and alert operations", code: "12", expect: STOP("visa.cat1.invalid_transaction", "alert_ops") },
  { label: "Visa R0 stop payment order: cancel", code: "R0", expect: STOP("visa.cat1.revoked", "cancelled") },
  { label: "Visa R1 revocation of authorisation: cancel", code: "R1", expect: STOP("visa.cat1.revoked", "cancelled") },
  { label: "Visa R3 revocation of all authorisations: cancel", code: "R3", expect: STOP("visa.cat1.revoked", "cancelled") },
  // Visa Category 2
  { label: "Visa 51 insufficient funds: next payday, same PSP", code: "51", expect: SAME("visa.cat2.funds", PAYDAY_WAIT) },
  { label: "Visa 61 exceeds amount limit: next payday, same PSP", code: "61", expect: SAME("visa.cat2.funds", PAYDAY_WAIT) },
  { label: "Visa 65 exceeds frequency limit: next payday, same PSP", code: "65", expect: SAME("visa.cat2.funds", PAYDAY_WAIT) },
  { label: "Visa 91 issuer unavailable: next capable PSP after 1 h", code: "91", expect: NEXT("visa.cat2.unavailable", 60) },
  { label: "Visa 96 system malfunction: next capable PSP after 1 h", code: "96", expect: NEXT("visa.cat2.unavailable", 60) },
  { label: "Visa 19 re-enter transaction: next capable PSP after 1 h", code: "19", expect: NEXT("visa.cat2.unavailable", 60) },
  { label: "Visa 91 with both alternative-PSP retries used: same PSP after 1 h", code: "91", state: { altPspRetriesUsed: 2 }, expect: { ...SAME("visa.cat2.unavailable", 60), rule: "policy.max_alt_psp" } },
  { label: "Visa 91, second retry, alternatives used: same PSP after 4 h", code: "91", state: { altPspRetriesUsed: 2, retriesUsed: 1 }, expect: SAME("visa.cat2.unavailable", 240) },
  { label: "Visa 59 suspected fraud: same PSP after 1 day, never cascaded", code: "59", expect: SAME("visa.cat2.later", 1440) },
  { label: "Visa 62 restricted card: same PSP after 1 day", code: "62", expect: SAME("visa.cat2.later", 1440) },
  { label: "Visa 03 invalid merchant: same PSP after 1 day", code: "03", expect: SAME("visa.cat2.later", 1440) },
  { label: "Visa 93 violation of law: same PSP after 1 day", code: "93", expect: SAME("visa.cat2.later", 1440) },
  { label: "Visa N3 cash service unavailable: same PSP after 1 day", code: "N3", expect: SAME("visa.cat2.later", 1440) },
  { label: "Visa 5C: same PSP after 1 day", code: "5C", expect: SAME("visa.cat2.later", 1440) },
  { label: "Visa 9G: same PSP after 1 day", code: "9G", expect: SAME("visa.cat2.later", 1440) },
  { label: "Visa 59, third retry: same PSP after 3 days", code: "59", state: { retriesUsed: 2 }, expect: SAME("visa.cat2.later", 4320) },
  // Visa Category 3
  { label: "Visa 54 expired card: fix the credential first", code: "54", expect: UPDATE("visa.cat3.data") },
  { label: "Visa N7 CVV2 failure: fix the credential first", code: "N7", expect: UPDATE("visa.cat3.data") },
  { label: "Visa 6P verification data failed: fix the credential first", code: "6P", expect: UPDATE("visa.cat3.data") },
  { label: "Visa 82 negative CAM/dCVV result: fix the credential first", code: "82", expect: UPDATE("visa.cat3.data") },
  // Visa Category 4
  { label: "Visa 05 do not honour: next capable PSP after 1 h", code: "05", expect: NEXT("visa.cat4.generic", 60) },
  { label: "Visa unlisted code Z9: generic", code: "Z9", expect: NEXT("visa.cat4.generic", 60) },
  { label: "Visa 05, second retry, alternatives used: same PSP after 2 days", code: "05", state: { altPspRetriesUsed: 2, retriesUsed: 1 }, expect: SAME("visa.cat4.generic", 2880) },
  { label: "Visa 05 with the retry budget used: ask the customer", code: "05", state: { retriesUsed: 6 }, expect: ASK("policy.max_retries") },
  { label: "Visa 05 with budget used and customer asked: stop", code: "05", state: { retriesUsed: 6, customerAsked: true }, expect: STOP("policy.max_retries", "exhausted") },
  { label: "Visa 51 when the payday falls outside the dunning window: ask the customer", code: "51", state: { firstDeclineAt: NOW - 15 * 1440 }, expect: ASK("policy.dunning_window") },
  {
    label: "Visa 05 with 15 attempts in 30 days: moved later by the Visa limit",
    code: "05",
    state: { lineageAttempts: [...Array.from({ length: 14 }, (_, i) => -40000 + i * 10), NOW] },
    expect: { action: "retry", rule: "visa.limit.30d", psp: "psp-uk", route: "next_psp", waitMinutes: 3200 - NOW },
  },
  {
    label: "Visa 05 when the Visa limit pushes past the dunning window: ask the customer",
    code: "05",
    state: { lineageAttempts: Array.from({ length: 15 }, (_, i) => -1000 + i * 10) },
    expect: ASK("visa.limit.30d"),
  },
  // Mastercard: MAC overrides the response code
  { label: "Mastercard 05 + MAC 01: account updater", brand: "mastercard", code: "05", mac: "01", expect: UPDATE("mastercard.mac.01") },
  { label: "Mastercard 51 + MAC 02: later, same PSP (MAC overrides the payday rule)", brand: "mastercard", code: "51", mac: "02", expect: SAME("mastercard.mac.02", 1440) },
  { label: "Mastercard 05 + MAC 03: never retry; ask the customer", brand: "mastercard", code: "05", mac: "03", expect: ASK("mastercard.mac.03") },
  { label: "Mastercard 05 + MAC 21: cancel, no dunning", brand: "mastercard", code: "05", mac: "21", expect: STOP("mastercard.mac.21", "cancelled") },
  { label: "Mastercard 51 + MAC 24: retry after 1 hour", brand: "mastercard", code: "51", mac: "24", expect: SAME("mastercard.mac.24", 60) },
  { label: "Mastercard 51 + MAC 25: retry after 24 hours", brand: "mastercard", code: "51", mac: "25", expect: SAME("mastercard.mac.25", 1440) },
  { label: "Mastercard 51 + MAC 26: retry after 2 days", brand: "mastercard", code: "51", mac: "26", expect: SAME("mastercard.mac.26", 2880) },
  { label: "Mastercard 51 + MAC 27: retry after 4 days", brand: "mastercard", code: "51", mac: "27", expect: SAME("mastercard.mac.27", 5760) },
  { label: "Mastercard 51 + MAC 28: retry after 6 days", brand: "mastercard", code: "51", mac: "28", expect: SAME("mastercard.mac.28", 8640) },
  { label: "Mastercard 51 + MAC 29: retry after 8 days", brand: "mastercard", code: "51", mac: "29", expect: SAME("mastercard.mac.29", 11520) },
  { label: "Mastercard 51 + MAC 30: retry after 10 days", brand: "mastercard", code: "51", mac: "30", expect: SAME("mastercard.mac.30", 14400) },
  { label: "Mastercard MAC 30 past the dunning window: ask the customer", brand: "mastercard", code: "51", mac: "30", state: { firstDeclineAt: NOW - 15 * 1440 }, expect: ASK("policy.dunning_window") },
  { label: "Mastercard 05 + MAC 40: stop and tell the customer", brand: "mastercard", code: "05", mac: "40", expect: STOP("mastercard.mac.40_42", "stopped") },
  { label: "Mastercard 05 + MAC 41: stop and tell the customer", brand: "mastercard", code: "05", mac: "41", expect: STOP("mastercard.mac.40_42", "stopped") },
  { label: "Mastercard 05 + MAC 42: stop and tell the customer", brand: "mastercard", code: "05", mac: "42", expect: STOP("mastercard.mac.40_42", "stopped") },
  { label: "Mastercard 51 + unknown MAC 99: falls back to the response code (payday)", brand: "mastercard", code: "51", mac: "99", expect: SAME("mastercard.funds", PAYDAY_WAIT) },
  // Mastercard without a MAC
  { label: "Mastercard 04 hard decline: updater first", brand: "mastercard", code: "04", expect: UPDATE("mastercard.hard.lost_stolen") },
  { label: "Mastercard 41 hard decline: updater first", brand: "mastercard", code: "41", expect: UPDATE("mastercard.hard.lost_stolen") },
  { label: "Mastercard 43 hard decline: updater first", brand: "mastercard", code: "43", expect: UPDATE("mastercard.hard.lost_stolen") },
  { label: "Mastercard 54 expired (hard): fix the credential", brand: "mastercard", code: "54", expect: UPDATE("mastercard.hard.account") },
  { label: "Mastercard 14 hard decline: fix the credential", brand: "mastercard", code: "14", expect: UPDATE("mastercard.hard.account") },
  { label: "Mastercard 15 hard decline: ask the customer", brand: "mastercard", code: "15", expect: ASK("mastercard.hard.no_issuer") },
  { label: "Mastercard 57: ask the customer", brand: "mastercard", code: "57", expect: ASK("mastercard.not_permitted") },
  { label: "Mastercard 12: stop and alert operations", brand: "mastercard", code: "12", expect: STOP("mastercard.invalid_transaction", "alert_ops") },
  { label: "Mastercard 51 without a MAC: next payday, same PSP", brand: "mastercard", code: "51", expect: SAME("mastercard.funds", PAYDAY_WAIT) },
  { label: "Mastercard 96 system error: next capable PSP after 1 h", brand: "mastercard", code: "96", expect: NEXT("mastercard.unavailable", 60) },
  { label: "Mastercard 59 suspected fraud: same PSP after 1 day, never cascaded", brand: "mastercard", code: "59", expect: SAME("mastercard.risk", 1440) },
  { label: "Mastercard 05 generic: next capable PSP after 1 h", brand: "mastercard", code: "05", expect: NEXT("mastercard.generic", 60) },
  {
    label: "Mastercard 91 with 7 attempts in 24 hours: moved later by the 24-hour limit",
    brand: "mastercard",
    code: "91",
    state: { lineageAttempts: [60, 70, 80, 90, 100, 110, 120] },
    expect: { action: "retry", rule: "mastercard.limit.24h", psp: "psp-uk", route: "next_psp", waitMinutes: 1500 - NOW },
  },
  // Acquirer side
  { label: "PSP unavailable: fail over now to the next capable PSP", code: "PSP_UNAVAILABLE", expect: NEXT("merchant.acquirer_outage", 0) },
  { label: "PSP unavailable with alternatives used: same PSP after 1 h", code: "PSP_UNAVAILABLE", state: { altPspRetriesUsed: 2 }, expect: SAME("merchant.acquirer_outage", 60) },
  // Events after the first decision
  { label: "Credential refreshed: retry now through the router's first choice", event: { type: "credential_updated", at: NOW, credentialVersion: 2 }, state: { credentialVersion: 2, blockedVersions: [1] }, expect: { action: "retry", rule: "credential.updated", psp: "psp-eu", route: "router", waitMinutes: 0 } },
  { label: "Credential unchanged: ask the customer", event: { type: "credential_unchanged", at: NOW }, expect: ASK("credential.unchanged") },
  { label: "Customer entered a new card: charge now (customer-initiated)", event: { type: "customer_updated", at: NOW }, expect: { action: "retry", rule: "policy.customer_card", psp: "psp-eu", route: "router", waitMinutes: 0 } },
  { label: "Customer did not respond: stop", event: { type: "customer_no_response", at: NOW }, expect: STOP("policy.customer_window", "exhausted") },
  { label: "Ledger refused the reservation: ask the customer", event: { type: "reservation_refused", at: NOW, reason: "limit" }, expect: ASK("policy.max_retries") },
];
