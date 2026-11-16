// Deterministic PSP router. Order: (1) capability: the PSP accepts this brand's network
// tokens in this region, else the card number fallback; (2) domestic acquiring for the
// BIN's issuing region; (3) measured approval rate; (4) cost.

import type { Brand, CredentialType, PspId, Region } from "./types";

export interface PspProfile {
  id: PspId;
  /** Regions where this PSP acquires domestically. */
  domestic: Region[];
  /** Regions where this PSP accepts network tokens, per brand. */
  tokenRegions: Record<Brand, Region[]>;
  /** Measured approval rate per card region (0 to 1), from the ledger's history. */
  approval: Record<Region, number>;
  /** Cost in basis points: domestic rate, plus the cross-border surcharge when not domestic. */
  costBps: number;
  crossBorderBps: number;
}

export interface RouteCard {
  brand: Brand;
  region: Region;
  /** True when the vault holds a network token for this card. */
  hasToken: boolean;
}

export interface RouteOption {
  psp: PspId;
  credentialType: CredentialType;
  domestic: boolean;
  approval: number;
  costBps: number;
  reasons: string[];
}

export function routeOptions(card: RouteCard, psps: PspProfile[], opts: { exclude?: PspId[] } = {}): RouteOption[] {
  const exclude = new Set(opts.exclude ?? []);
  const options = psps
    .filter((p) => !exclude.has(p.id))
    .map((p): RouteOption => {
      const tokenOk = card.hasToken && p.tokenRegions[card.brand].includes(card.region);
      const domestic = p.domestic.includes(card.region);
      const cost = p.costBps + (domestic ? 0 : p.crossBorderBps);
      return {
        psp: p.id,
        credentialType: tokenOk ? "network_token" : "pan_fallback",
        domestic,
        approval: p.approval[card.region],
        costBps: cost,
        reasons: [
          tokenOk ? "accepts the network token" : card.hasToken ? "no token support here: card-number fallback" : "card not tokenised: card-number fallback",
          domestic ? "domestic acquiring" : "cross-border",
          `approval ${(p.approval[card.region] * 100).toFixed(1)}%`,
          `cost ${cost} bps`,
        ],
      };
    });
  return options.sort(
    (a, b) =>
      rankType(card, b) - rankType(card, a) ||
      Number(b.domestic) - Number(a.domestic) ||
      b.approval - a.approval ||
      a.costBps - b.costBps ||
      a.psp.localeCompare(b.psp),
  );
}

function rankType(card: RouteCard, o: RouteOption): number {
  return card.hasToken && o.credentialType === "network_token" ? 1 : 0;
}

export function routerOrder(card: RouteCard, psps: PspProfile[]): PspId[] {
  return routeOptions(card, psps).map((o) => o.psp);
}
