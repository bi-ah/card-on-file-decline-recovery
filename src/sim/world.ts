// SIMULATED. Seeded, deterministic stand-ins for the vault provider, token service,
// account updater, PSPs, issuers and customers. The merchant platform only ever sees
// what a real one would: vault references, BIN, last four, expiry, response codes and MACs.

import { nextPayday, DAY, HOUR } from "../core/time";
import { pick, unit } from "../core/rng";
import { POLICY } from "../core/rules";
import type { Brand, PspId, Region, SimMinute } from "../core/types";
import { ISSUERS, PSPS, REGION_WEIGHTS } from "./catalog";

export type Scenario =
  | "ok"
  | "funds"
  | "limit"
  | "expired"
  | "lost"
  | "closed"
  | "generic"
  | "revoked"
  | "fraud"
  | "restricted"
  | "invalid"
  | "data"
  | "risk";

export interface SimCard {
  index: number;
  paymentId: string;
  customerId: string;
  brand: Brand;
  region: Region;
  issuerId: string;
  bin: string;
  last4: string;
  expiry: string; // MM/YY
  tokenised: boolean;
  amountCents: number;
  currency: "USD";
  billAt: SimMinute;
  scenario: Scenario;
  /** When funds arrive for insufficient-funds cards (null: never in the window). */
  fundsAt: SimMinute | null;
  /** When a risk hold clears. */
  riskClearsAt: SimMinute | null;
  /** D4 prevention before billing: the credential was already refreshed. */
  preventedBy: "token_lifecycle" | "account_updater" | null;
  /** The legacy PSP's black-box updater would have refreshed it before billing. */
  legacyUpdaterCaught: boolean;
  /** A refresh during recovery (token lifecycle or updater) finds a new credential. */
  updaterHelps: boolean;
  /** Minutes after being asked that the customer enters a new card (null: never). */
  customerRespondsAfter: number | null;
}

export interface Outage {
  from: SimMinute;
  to: SimMinute;
}

export interface SimNight {
  seed: number;
  nightDate: string;
  cards: SimCard[];
  pspOutage: Outage & { psp: PspId };
  issuerOutage: Outage & { issuerId: string };
}

export interface WorldConfig {
  customerResponseRate: number;
}

export const DEFAULT_WORLD: WorldConfig = { customerResponseRate: 0.3 };

const SCENARIOS: Array<[Scenario, number]> = [
  ["ok", 0.80],
  ["funds", 0.04],
  ["limit", 0.006],
  ["expired", 0.045],
  ["lost", 0.018],
  ["closed", 0.008],
  ["generic", 0.022],
  ["revoked", 0.005],
  ["fraud", 0.002],
  ["restricted", 0.003],
  ["invalid", 0.001],
  ["data", 0.004],
  ["risk", 0.004],
];

export function generateNight(seed: number, renewals: number, nightDate: string, world: WorldConfig = DEFAULT_WORLD): SimNight {
  const cards: SimCard[] = [];
  for (let i = 0; i < renewals; i++) {
    const u = (k: string) => unit(seed, i, k);
    const region = pick(u("region"), REGION_WEIGHTS);
    const brand: Brand = u("brand") < 0.58 ? "visa" : "mastercard";
    const issuers = ISSUERS.filter((x) => x.region === region && x.brand === brand);
    const issuer = issuers[Math.floor(u("issuer") * issuers.length)]!;
    const scenario = pick(u("scenario"), SCENARIOS);
    const tokenised = u("token") < 0.82;
    const billAt = HOUR + Math.floor((i * 4 * HOUR) / Math.max(1, renewals));
    const amountCents = pick(u("amount"), [
      [999, 0.3],
      [1499, 0.25],
      [2499, 0.2],
      [4999, 0.15],
      [9900, 0.1],
    ] as Array<[number, number]>);

    let fundsAt: SimMinute | null = null;
    if (scenario === "funds" || scenario === "limit") {
      const k = pick(u("payday"), [
        [0, 0.5],
        [1, 0.25],
        [-1, 0.25],
      ] as Array<[number, number]>);
      if (k >= 0) {
        let p = nextPayday(nightDate, billAt, 6, 0, POLICY.paydays);
        if (k === 1) p = nextPayday(nightDate, p + 1, 6, 0, POLICY.paydays);
        fundsAt = p;
      }
    }
    let preventedBy: SimCard["preventedBy"] = null;
    if (scenario === "expired") {
      if (tokenised && u("prevent") < 0.9) preventedBy = "token_lifecycle";
      else if (!tokenised && u("prevent") < 0.6) preventedBy = "account_updater";
    }
    if (scenario === "lost") {
      if (tokenised && u("prevent") < 0.5) preventedBy = "token_lifecycle";
      else if (!tokenised && u("prevent") < 0.3) preventedBy = "account_updater";
    }
    const helps: Partial<Record<Scenario, number>> = { expired: 0.6, lost: 0.5, data: 0.35 };
    const legacyCatch: Partial<Record<Scenario, number>> = { expired: 0.4, lost: 0.2 };
    cards.push({
      index: i,
      paymentId: `pay_${seed}_${String(i).padStart(4, "0")}`,
      customerId: `cus_${seed}_${String(i).padStart(4, "0")}`,
      brand,
      region,
      issuerId: issuer.id,
      bin: issuer.bin,
      last4: String(1000 + Math.floor(u("last4") * 9000)),
      expiry: `${String(1 + Math.floor(u("expm") * 12)).padStart(2, "0")}/${scenario === "expired" ? "26" : String(27 + Math.floor(u("expy") * 4))}`,
      tokenised,
      amountCents,
      currency: "USD",
      billAt,
      scenario,
      fundsAt,
      riskClearsAt: scenario === "risk" ? billAt + (2 + Math.floor(u("risk") * 4)) * DAY : null,
      preventedBy,
      legacyUpdaterCaught: u("legacy") < (legacyCatch[scenario] ?? 0),
      updaterHelps: u("helps") < (helps[scenario] ?? 0),
      customerRespondsAfter: u("customer") < world.customerResponseRate ? Math.floor((0.5 + u("customer-delay") * 6) * DAY) : null,
    });
  }
  const outagePsp = pick(unit(seed, "psp-outage"), [
    ["psp-us", 1],
    ["psp-eu", 1],
    ["psp-uk", 1],
  ] as Array<[PspId, number]>);
  const issuer = ISSUERS[Math.floor(unit(seed, "issuer-outage") * ISSUERS.length)]!;
  return {
    seed,
    nightDate,
    cards,
    pspOutage: { psp: outagePsp, from: 2 * HOUR, to: 2 * HOUR + 20 },
    issuerOutage: { issuerId: issuer.id, from: 3 * HOUR, to: 5 * HOUR },
  };
}

export interface AuthRequest {
  at: SimMinute;
  psp: PspId;
  credentialType: "network_token" | "pan_fallback" | "psp_token";
  credentialVersion: number;
  /** The customer just entered this card in the hosted form. */
  customerCard: boolean;
  /** 0 for the first attempt on the renewal. */
  attemptNo: number;
}

export type AuthResult = { approved: true } | { approved: false; code: string; mac?: string };

function decline(code: string, mac?: string): AuthResult {
  return mac ? { approved: false, code, mac } : { approved: false, code };
}

/** SIMULATED PSP, card network and issuer. Deterministic in its inputs. */
export function authorize(night: SimNight, card: SimCard, req: AuthRequest): AuthResult {
  const seed = night.seed;
  const u = (k: string) => unit(seed, card.index, req.at, req.psp, req.credentialVersion, k);
  if (req.psp === night.pspOutage.psp && req.at >= night.pspOutage.from && req.at < night.pspOutage.to) return decline("PSP_UNAVAILABLE");
  if (card.issuerId === night.issuerOutage.issuerId && req.at >= night.issuerOutage.from && req.at < night.issuerOutage.to) return decline("91");
  if (req.customerCard) return u("newcard") < 0.95 ? { approved: true } : decline("05");

  const visa = card.brand === "visa";
  const fixed = req.credentialVersion >= 2;
  const cardPick = (k: string, options: string[]) => options[Math.floor(unit(seed, card.index, k) * options.length)]!;
  switch (card.scenario) {
    case "funds":
    case "limit":
      if (card.fundsAt === null || req.at < card.fundsAt) {
        const code = card.scenario === "funds" ? "51" : "61";
        if (visa) return decline(code);
        const mac = cardPick("mac", ["", "", "02", "26"]);
        return decline(code, mac || undefined);
      }
      break;
    case "expired":
      if (!fixed) return visa ? decline("54") : decline("54", cardPick("mac", ["", "01"]) || undefined);
      break;
    case "lost":
      if (!fixed) return decline(visa ? cardPick("lost", ["41", "43", "04"]) : cardPick("lost", ["41", "43"]));
      break;
    case "closed":
      return decline(visa ? "46" : "14");
    case "generic":
      if (req.attemptNo === 0) return decline("05");
      if (u("generic") >= (PSPS.find((p) => p.id === req.psp)!.domestic.includes(card.region) ? 0.55 : 0.3)) return decline("05");
      break;
    case "revoked":
      return visa ? decline(cardPick("revoked", ["R0", "R1", "R3"])) : decline("05", "21");
    case "fraud":
      return visa ? decline("07") : decline("04", "03");
    case "restricted":
      return decline("57");
    case "invalid":
      return decline("12");
    case "data":
      if (!fixed) return visa ? decline(cardPick("data", ["N7", "6P", "82"])) : decline("05", "01");
      break;
    case "risk":
      if (req.at < (card.riskClearsAt ?? 0)) return decline("59");
      break;
    case "ok":
      break;
  }
  if (u("transient") < 0.004) return decline("96");
  const domestic = PSPS.find((p) => p.id === req.psp)!.domestic.includes(card.region);
  if (!domestic && u("cross-border") < 0.06) return decline("05");
  return { approved: true };
}

/** SIMULATED token lifecycle refresh or account updater inquiry during recovery. */
export function refreshCredential(card: SimCard): { updated: boolean; expiry?: string; last4?: string; closed?: boolean } {
  if (card.scenario === "closed") return { updated: false, closed: true };
  if (!card.updaterHelps) return { updated: false };
  return {
    updated: true,
    expiry: `${card.expiry.slice(0, 3)}${String(Number(card.expiry.slice(3)) + 4).padStart(2, "0")}`,
    last4: card.scenario === "lost" ? String(1000 + ((Number(card.last4) * 7) % 9000)) : card.last4,
  };
}

/** SIMULATED customer: minutes until they enter a new card in the hosted form, or null. */
export function customerResponse(card: SimCard): number | null {
  if (card.scenario === "revoked") return null;
  return card.customerRespondsAfter;
}
