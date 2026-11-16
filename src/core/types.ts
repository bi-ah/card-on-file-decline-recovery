// Shared types. Pure: no Cloudflare or Node imports anywhere under src/core.

export type Brand = "visa" | "mastercard";
export type Region = "US" | "EU" | "UK" | "APAC";
export type PspId = "psp-us" | "psp-eu" | "psp-uk" | "psp-apac";

/** How a transaction carries the card. The merchant never sees a card number. */
export type CredentialType = "network_token" | "pan_fallback";

/** Simulated time: minutes since 00:00 UTC on the night of the run. */
export type SimMinute = number;

export type Action = "retry" | "update_credential" | "ask_customer" | "stop";

export type StopOutcome =
  | "stopped" // never-retry code or merchant decision; customer told
  | "stopped_silent" // no outreach (for example Visa 07, pick up card, special condition)
  | "cancelled" // customer revoked the recurring payment: cancel, no dunning
  | "alert_ops" // something is wrong on our side: stop and alert operations
  | "exhausted"; // retry budget, network limits or dunning window used up

/** Events the recovery loop feeds into the rules engine. */
export type RecoveryEvent =
  | { type: "declined"; at: SimMinute; code: string; mac?: string; psp: PspId; credentialVersion: number }
  | { type: "credential_updated"; at: SimMinute; credentialVersion: number }
  | { type: "credential_unchanged"; at: SimMinute }
  | { type: "customer_updated"; at: SimMinute }
  | { type: "customer_no_response"; at: SimMinute }
  | { type: "reservation_refused"; at: SimMinute; reason: string };

export interface Decision {
  action: Action;
  /** When to act, in simulated minutes. */
  at: SimMinute;
  /** Simulated minutes to wait from the event to `at`. */
  waitMinutes: number;
  /** Plain-language reason, written by code, never by the model. */
  reason: string;
  /** Ids of the rules in `RULES` that produced this decision. */
  ruleIds: string[];
  /** For example "visa.cat2.funds" or "mastercard.mac.26". */
  classification: string;
  psp?: PspId;
  route?: "same_psp" | "next_psp" | "router";
  /** True when the charge follows the customer entering a new card (customer-initiated). */
  customerInitiated?: boolean;
  stopOutcome?: StopOutcome;
  notifyCustomer?: boolean;
  /** The credential version this decline blocks from any further attempt. */
  blocksCredentialVersion?: number;
}

/** What the rules engine needs to know about one failed renewal. */
export interface RecoveryState {
  brand: Brand;
  nightDate: string; // YYYY-MM-DD
  firstDeclineAt: SimMinute;
  retriesUsed: number; // merchant retries for this renewal (original and customer-initiated charges excluded)
  altPspRetriesUsed: number;
  lastPsp: PspId;
  credentialVersion: number;
  blockedVersions: number[];
  updaterTriedVersions: number[];
  customerAsked: boolean;
  /** Times of every attempt on this card lineage at this merchant, all PSPs, original included. */
  lineageAttempts: SimMinute[];
  /** Capable PSPs in router order for this card. */
  routerOrder: PspId[];
  /** The classification of the last decline, kept for decisions after a credential update. */
  lastClassification?: string;
}
