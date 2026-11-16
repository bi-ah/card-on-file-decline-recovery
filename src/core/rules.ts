// Network rules and merchant policy as configuration. Every rule names its source and
// how confident we are in it. docs/network-rules.md explains each one. Where public
// sources disagree, the reading that cannot incur a fee is used.

import type { Brand, StopOutcome } from "./types";

export type Confidence = "high" | "medium" | "low";

export interface Source {
  id: string;
  title: string;
  url?: string;
}

export type Timing =
  | { kind: "payday" } // retry on the next payday
  | { kind: "backoff"; scheduleMinutes: number[] } // indexed by retries used
  | { kind: "fixed"; minutes: number } // a fixed wait, e.g. a Mastercard MAC interval
  | { kind: "immediate" }; // acquirer-side failure: fail over now

export type Treatment =
  | { kind: "retry"; timing: Timing; cascade: boolean }
  /** Never retry this credential. Refresh it (token lifecycle or updater); if nothing new, ask the customer. */
  | { kind: "fix_credential" }
  /** Never retry this credential, no updater: ask the customer for another card. */
  | { kind: "ask_customer" }
  | { kind: "stop"; outcome: StopOutcome; notify: boolean };

export interface Rule {
  id: string;
  label: string;
  treatment: Treatment;
  /** True when no further attempt may use the declined credential version. */
  blocksCredential: boolean;
  source: string; // Source id
  confidence: Confidence;
  note?: string;
}

export interface CodeRule extends Rule {
  brand: Brand;
  codes: string[];
}

export interface MacRule extends Rule {
  macs: string[];
}

const SHORT = [60, 240, 1440]; // 1 h, 4 h, 1 day
const DAILY = [1440, 2880, 4320, 4320, 4320, 4320]; // 1, 2, 3 days, then every 3 days

export const SOURCES: Source[] = [
  {
    id: "visa-core-rules",
    title: "Visa Core Rules and Visa Product and Service Rules (public edition): decline categories and reattempt limits",
    url: "https://usa.visa.com/dam/VCOM/download/about-visa/visa-rules-public.pdf",
  },
  {
    id: "visa-reattempt-program",
    title: "Visa decline response code categories 1 to 4 and excessive reattempt fees, as summarised in Visa merchant and acquirer guidance (2020 to 2021)",
  },
  {
    id: "mc-tpr",
    title: "Mastercard Transaction Processing Rules: Merchant Advice Codes and authorization reattempts",
    url: "https://www.mastercard.us/content/dam/public/mastercardcom/na/global-site/documents/transaction-processing-rules.pdf",
  },
  {
    id: "mc-mac-program",
    title: "Mastercard Merchant Advice Code transaction excellence and excessive authorization attempts, as summarised in acquirer guidance",
  },
  { id: "merchant-policy", title: "This merchant's own dunning policy (not a network rule)" },
];

export const VISA_RULES: CodeRule[] = [
  // Category 1: the issuer will never approve. Handling per code is merchant policy within the network rule.
  {
    id: "visa.cat1.pickup_special",
    brand: "visa",
    codes: ["07"],
    label: "Category 1: pick up card, special condition. Stop, no outreach",
    treatment: { kind: "stop", outcome: "stopped_silent", notify: false },
    blocksCredential: true,
    source: "visa-reattempt-program",
    confidence: "high",
  },
  {
    id: "visa.cat1.lost_stolen",
    brand: "visa",
    codes: ["04", "41", "43"],
    label: "Category 1: pick up, lost or stolen card. Never retry this card; look for a replacement, else ask the customer",
    treatment: { kind: "fix_credential" },
    blocksCredential: true,
    source: "visa-reattempt-program",
    confidence: "high",
  },
  {
    id: "visa.cat1.account",
    brand: "visa",
    codes: ["46", "14"],
    label: "Category 1: closed account or invalid account number. Updater, then the customer",
    treatment: { kind: "fix_credential" },
    blocksCredential: true,
    source: "visa-reattempt-program",
    confidence: "high",
  },
  {
    id: "visa.cat1.no_issuer_not_permitted",
    brand: "visa",
    codes: ["15", "57"],
    label: "Category 1: no such issuer or not permitted to cardholder. Ask the customer for another card",
    treatment: { kind: "ask_customer" },
    blocksCredential: true,
    source: "visa-reattempt-program",
    confidence: "high",
  },
  {
    id: "visa.cat1.invalid_transaction",
    brand: "visa",
    codes: ["12"],
    label: "Category 1: invalid transaction. Stop and alert operations (likely our own request is wrong)",
    treatment: { kind: "stop", outcome: "alert_ops", notify: false },
    blocksCredential: true,
    source: "visa-reattempt-program",
    confidence: "high",
  },
  {
    id: "visa.cat1.revoked",
    brand: "visa",
    codes: ["R0", "R1", "R3"],
    label: "Category 1: customer stopped the recurring payment. Stop and cancel the subscription, no dunning",
    treatment: { kind: "stop", outcome: "cancelled", notify: false },
    blocksCredential: true,
    source: "visa-reattempt-program",
    confidence: "high",
  },
  // Category 2: the issuer cannot approve now.
  {
    id: "visa.cat2.funds",
    brand: "visa",
    codes: ["51", "61", "65"],
    label: "Category 2: insufficient funds or limit exceeded. Retry on the next payday, same PSP",
    treatment: { kind: "retry", timing: { kind: "payday" }, cascade: false },
    blocksCredential: false,
    source: "visa-reattempt-program",
    confidence: "high",
    note: "Never cascaded to another PSP: a different acquirer cannot add funds.",
  },
  {
    id: "visa.cat2.unavailable",
    brand: "visa",
    codes: ["19", "91", "96"],
    label: "Category 2: issuer unavailable or processing error. Short backoff; another PSP allowed",
    treatment: { kind: "retry", timing: { kind: "backoff", scheduleMinutes: SHORT }, cascade: true },
    blocksCredential: false,
    source: "visa-reattempt-program",
    confidence: "high",
  },
  {
    id: "visa.cat2.later",
    brand: "visa",
    codes: ["03", "59", "62", "75", "78", "86", "93", "N3", "N4", "5C", "9G"],
    label: "Category 2: cannot approve now (including risk). Retry later, same PSP",
    treatment: { kind: "retry", timing: { kind: "backoff", scheduleMinutes: DAILY }, cascade: false },
    blocksCredential: false,
    source: "visa-reattempt-program",
    confidence: "high",
    note: "Risk declines such as 59 are never cascaded.",
  },
  // Category 3: data quality.
  {
    id: "visa.cat3.data",
    brand: "visa",
    codes: ["54", "55", "63", "6P", "82", "N7"],
    label: "Category 3: data quality (for example expired card). Fix the credential first, then retry",
    treatment: { kind: "fix_credential" },
    blocksCredential: true,
    source: "visa-reattempt-program",
    confidence: "high",
  },
];

/** Category 4: generic decline (05 and any code not listed above). */
export const VISA_GENERIC: CodeRule = {
  id: "visa.cat4.generic",
  brand: "visa",
  codes: ["05"],
  label: "Category 4: generic decline. Retry later; another PSP allowed",
  treatment: { kind: "retry", timing: { kind: "backoff", scheduleMinutes: DAILY }, cascade: true },
  blocksCredential: false,
  source: "visa-reattempt-program",
  confidence: "medium",
};

/** Mastercard Merchant Advice Codes override the response code. */
export const MC_MAC_RULES: MacRule[] = [
  {
    id: "mastercard.mac.01",
    macs: ["01"],
    label: "MAC 01: updated information needed. Account updater, then the customer",
    treatment: { kind: "fix_credential" },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "high",
  },
  {
    id: "mastercard.mac.02",
    macs: ["02"],
    label: "MAC 02: try again later. Retry later, same PSP",
    treatment: { kind: "retry", timing: { kind: "backoff", scheduleMinutes: DAILY }, cascade: false },
    blocksCredential: false,
    source: "mc-tpr",
    confidence: "high",
  },
  {
    id: "mastercard.mac.03",
    macs: ["03"],
    label: "MAC 03: do not try again. Never retry this card; ask the customer for another",
    treatment: { kind: "ask_customer" },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "high",
  },
  {
    id: "mastercard.mac.21",
    macs: ["21"],
    label: "MAC 21: payment cancellation (recurring payment stopped). Stop and cancel the subscription, no dunning",
    treatment: { kind: "stop", outcome: "cancelled", notify: false },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "high",
  },
  ...(
    [
      ["24", 60, "1 hour"],
      ["25", 1440, "24 hours"],
      ["26", 2880, "2 days"],
      ["27", 5760, "4 days"],
      ["28", 8640, "6 days"],
      ["29", 11520, "8 days"],
      ["30", 14400, "10 days"],
    ] as Array<[string, number, string]>
  ).map(
    ([mac, minutes, text]): MacRule => ({
      id: `mastercard.mac.${mac}`,
      macs: [mac],
      label: `MAC ${mac}: retry after ${text}, same PSP`,
      treatment: { kind: "retry", timing: { kind: "fixed", minutes }, cascade: false },
      blocksCredential: false,
      source: "mc-mac-program",
      confidence: "medium",
    }),
  ),
  {
    id: "mastercard.mac.40_42",
    macs: ["40", "41", "42"],
    label: "MAC 40, 41, 42: never retry. Stop and tell the customer",
    treatment: { kind: "stop", outcome: "stopped", notify: true },
    blocksCredential: true,
    source: "mc-mac-program",
    confidence: "low",
    note: "Meanings vary by source (card-type and policy restrictions); all are treated as never retry.",
  },
];

/** Mastercard response codes when there is no MAC. */
export const MC_CODE_RULES: CodeRule[] = [
  {
    id: "mastercard.hard.lost_stolen",
    brand: "mastercard",
    codes: ["04", "41", "43"],
    label: "Hard decline: pick up, lost or stolen card. Never retry this card; look for a replacement, else ask the customer",
    treatment: { kind: "fix_credential" },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "high",
  },
  {
    id: "mastercard.hard.account",
    brand: "mastercard",
    codes: ["14", "54"],
    label: "Hard decline: invalid account number or expired card. Fix the credential, then the customer",
    treatment: { kind: "fix_credential" },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "high",
  },
  {
    id: "mastercard.hard.no_issuer",
    brand: "mastercard",
    codes: ["15"],
    label: "Hard decline: no such issuer. Ask the customer for another card",
    treatment: { kind: "ask_customer" },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "high",
  },
  {
    id: "mastercard.not_permitted",
    brand: "mastercard",
    codes: ["57"],
    label: "Not permitted to cardholder. Ask the customer for another card",
    treatment: { kind: "ask_customer" },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "medium",
  },
  {
    id: "mastercard.invalid_transaction",
    brand: "mastercard",
    codes: ["12"],
    label: "Invalid transaction. Stop and alert operations",
    treatment: { kind: "stop", outcome: "alert_ops", notify: false },
    blocksCredential: true,
    source: "mc-tpr",
    confidence: "medium",
  },
  {
    id: "mastercard.funds",
    brand: "mastercard",
    codes: ["51", "61", "65"],
    label: "Insufficient funds or limit exceeded. Retry on the next payday, same PSP",
    treatment: { kind: "retry", timing: { kind: "payday" }, cascade: false },
    blocksCredential: false,
    source: "mc-tpr",
    confidence: "medium",
  },
  {
    id: "mastercard.unavailable",
    brand: "mastercard",
    codes: ["91", "92", "96"],
    label: "Issuer unavailable or system error. Short backoff; another PSP allowed",
    treatment: { kind: "retry", timing: { kind: "backoff", scheduleMinutes: SHORT }, cascade: true },
    blocksCredential: false,
    source: "mc-tpr",
    confidence: "medium",
  },
  {
    id: "mastercard.risk",
    brand: "mastercard",
    codes: ["59", "63"],
    label: "Suspected fraud or security violation. Retry later, same PSP",
    treatment: { kind: "retry", timing: { kind: "backoff", scheduleMinutes: DAILY }, cascade: false },
    blocksCredential: false,
    source: "mc-tpr",
    confidence: "medium",
  },
];

export const MC_GENERIC: CodeRule = {
  id: "mastercard.generic",
  brand: "mastercard",
  codes: ["05"],
  label: "Generic decline without a MAC. Retry later; another PSP allowed",
  treatment: { kind: "retry", timing: { kind: "backoff", scheduleMinutes: DAILY }, cascade: true },
  blocksCredential: false,
  source: "mc-tpr",
  confidence: "medium",
};

/** Acquirer-side failure: the PSP did not answer (simulated outage). Not an issuer decline. */
export const ACQUIRER_OUTAGE: Rule & { codes: string[] } = {
  id: "merchant.acquirer_outage",
  codes: ["PSP_UNAVAILABLE"],
  label: "PSP unavailable (acquirer-side). Fail over now to the next capable PSP with the same token",
  treatment: { kind: "retry", timing: { kind: "immediate" }, cascade: true },
  blocksCredential: false,
  source: "merchant-policy",
  confidence: "high",
};

export interface LimitRule {
  id: string;
  brand: Brand;
  windowMinutes: number;
  maxAttempts: number;
  label: string;
  source: string;
  confidence: Confidence;
  note: string;
}

/** Counted per card lineage and merchant, across all PSPs, original attempt included. */
export const LIMITS: LimitRule[] = [
  {
    id: "visa.limit.30d",
    brand: "visa",
    windowMinutes: 30 * 1440,
    maxAttempts: 15,
    label: "Visa: at most 15 attempts in 30 days",
    source: "visa-core-rules",
    confidence: "medium",
    note: "Conservative reading. Sources differ on whether the count is per card or per card and merchant; counting per card lineage across all PSPs is the stricter reading.",
  },
  {
    id: "mastercard.limit.24h",
    brand: "mastercard",
    windowMinutes: 1440,
    maxAttempts: 7,
    label: "Mastercard: at most 7 attempts in 24 hours",
    source: "mc-mac-program",
    confidence: "medium",
    note: "Conservative reading of the excessive-attempts rules.",
  },
  {
    id: "mastercard.limit.30d",
    brand: "mastercard",
    windowMinutes: 30 * 1440,
    maxAttempts: 35,
    label: "Mastercard: at most 35 attempts in 30 days",
    source: "mc-mac-program",
    confidence: "medium",
    note: "Conservative reading of the excessive-attempts rules.",
  },
];

export interface Policy {
  maxRetriesPerRenewal: number;
  dunningWindowDays: number;
  customerResponseDays: number;
  maxAltPspRetries: number;
  paydays: number[]; // day of month; -1 means the last day
  paydayHourUtc: number;
  paydayMinGapMinutes: number;
}

export const POLICY: Policy = {
  maxRetriesPerRenewal: 6,
  dunningWindowDays: 21,
  customerResponseDays: 7,
  maxAltPspRetries: 2,
  paydays: [1, 15, 25, -1],
  paydayHourUtc: 8,
  paydayMinGapMinutes: 720,
};

export const POLICY_RULES: Rule[] = [
  { id: "policy.max_retries", label: "At most 6 retries per renewal", treatment: { kind: "stop", outcome: "exhausted", notify: true }, blocksCredential: false, source: "merchant-policy", confidence: "high" },
  { id: "policy.dunning_window", label: "21-day dunning window from the first decline", treatment: { kind: "stop", outcome: "exhausted", notify: true }, blocksCredential: false, source: "merchant-policy", confidence: "high" },
  { id: "policy.customer_window", label: "7 days for the customer to respond", treatment: { kind: "stop", outcome: "exhausted", notify: true }, blocksCredential: false, source: "merchant-policy", confidence: "high" },
  { id: "policy.max_alt_psp", label: "At most 2 retries via another PSP", treatment: { kind: "stop", outcome: "exhausted", notify: true }, blocksCredential: false, source: "merchant-policy", confidence: "high" },
  { id: "policy.customer_card", label: "A card the customer enters is charged at once as a customer-initiated payment, outside the retry budget", treatment: { kind: "stop", outcome: "stopped", notify: false }, blocksCredential: false, source: "merchant-policy", confidence: "high" },
];

export interface RulesConfig {
  visa: CodeRule[];
  visaGeneric: CodeRule;
  mcMac: MacRule[];
  mcCodes: CodeRule[];
  mcGeneric: CodeRule;
  acquirerOutage: Rule & { codes: string[] };
  limits: LimitRule[];
  policy: Policy;
}

export const RULES: RulesConfig = {
  visa: VISA_RULES,
  visaGeneric: VISA_GENERIC,
  mcMac: MC_MAC_RULES,
  mcCodes: MC_CODE_RULES,
  mcGeneric: MC_GENERIC,
  acquirerOutage: ACQUIRER_OUTAGE,
  limits: LIMITS,
  policy: POLICY,
};

/** Every rule, for lookup by id (explanations, the operator page, docs). */
export function allRules(cfg: RulesConfig = RULES): Array<Rule | LimitRule> {
  return [...cfg.visa, cfg.visaGeneric, ...cfg.mcMac, ...cfg.mcCodes, cfg.mcGeneric, cfg.acquirerOutage, ...cfg.limits, ...POLICY_RULES];
}

export function ruleById(id: string, cfg: RulesConfig = RULES): Rule | LimitRule | undefined {
  return allRules(cfg).find((r) => r.id === id);
}

/** Classify a decline: a Mastercard MAC overrides the response code. */
export function classify(brand: Brand, code: string, mac: string | undefined, cfg: RulesConfig = RULES): Rule {
  if (cfg.acquirerOutage.codes.includes(code)) return cfg.acquirerOutage;
  if (brand === "mastercard") {
    if (mac) {
      const m = cfg.mcMac.find((r) => r.macs.includes(mac));
      if (m) return m;
    }
    return cfg.mcCodes.find((r) => r.codes.includes(code)) ?? cfg.mcGeneric;
  }
  return cfg.visa.find((r) => r.codes.includes(code)) ?? cfg.visaGeneric;
}

/** Codes that must never be sent to another PSP (guardrail 3): funds, risk and hard declines. */
export function isCascadable(rule: Rule): boolean {
  return rule.treatment.kind === "retry" && rule.treatment.cascade;
}
