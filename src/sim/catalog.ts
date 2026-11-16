// SIMULATED. Fictional PSPs, BIN ranges and issuers. None of these are real institutions.

import type { PspProfile } from "../core/router";
import type { Brand, Region } from "../core/types";

export const SIMULATED_LABEL = "Simulated: fictional PSPs, BINs, issuers, vault, token service and account updater";

export const PSPS: PspProfile[] = [
  {
    id: "psp-us",
    domestic: ["US"],
    tokenRegions: { visa: ["US", "EU", "UK", "APAC"], mastercard: ["US"] },
    approval: { US: 0.93, EU: 0.86, UK: 0.86, APAC: 0.83 },
    costBps: 210,
    crossBorderBps: 100,
  },
  {
    id: "psp-eu",
    domestic: ["EU"],
    tokenRegions: { visa: ["EU", "UK"], mastercard: ["EU", "UK"] },
    approval: { US: 0.85, EU: 0.94, UK: 0.9, APAC: 0.82 },
    costBps: 160,
    crossBorderBps: 110,
  },
  {
    id: "psp-uk",
    domestic: ["UK"],
    tokenRegions: { visa: ["UK", "EU"], mastercard: ["UK"] },
    approval: { US: 0.84, EU: 0.89, UK: 0.94, APAC: 0.81 },
    costBps: 170,
    crossBorderBps: 110,
  },
  {
    id: "psp-apac",
    domestic: ["APAC"],
    tokenRegions: { visa: ["APAC"], mastercard: [] },
    approval: { US: 0.82, EU: 0.81, UK: 0.81, APAC: 0.92 },
    costBps: 230,
    crossBorderBps: 120,
  },
];

export interface IssuerProfile {
  id: string;
  name: string;
  region: Region;
  brand: Brand;
  bin: string;
}

const ISSUER_NAMES: Record<Region, string[]> = {
  US: ["Fictional Harbor Bank", "Fictional Prairie Credit Union"],
  EU: ["Fictional Rhine Bank", "Fictional Iberia Savings"],
  UK: ["Fictional Thames Bank", "Fictional Pennine Building Society"],
  APAC: ["Fictional Coral Bank", "Fictional Lotus Bank"],
};

/** Fictional 6-digit BINs: 4xxxxx for Visa and 5xxxxx for Mastercard, invented for this demo. */
export const ISSUERS: IssuerProfile[] = (["US", "EU", "UK", "APAC"] as Region[]).flatMap((region, ri) =>
  (["visa", "mastercard"] as Brand[]).flatMap((brand, bi) =>
    ISSUER_NAMES[region].map((name, ni) => ({
      id: `iss-${region.toLowerCase()}-${brand === "visa" ? "v" : "m"}${ni + 1}`,
      name,
      region,
      brand,
      bin: `${brand === "visa" ? 4 : 5}9${ri}${bi}${ni}0`,
    })),
  ),
);

export const REGION_WEIGHTS: Array<[Region, number]> = [
  ["US", 0.45],
  ["EU", 0.25],
  ["UK", 0.18],
  ["APAC", 0.12],
];
