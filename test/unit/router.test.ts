import { describe, expect, it } from "vitest";
import { routeOptions, routerOrder, type PspProfile } from "../../src/core/router";
import { PSPS } from "../../src/sim/catalog";

describe("router", () => {
  it("prefers a PSP that accepts the network token and acquires domestically", () => {
    const o = routeOptions({ brand: "visa", region: "US", hasToken: true }, PSPS);
    expect(o[0]).toMatchObject({ psp: "psp-us", credentialType: "network_token", domestic: true });
  });

  it("Visa UK token: domestic token-capable PSP first, then other token-capable PSPs by approval, card-number fallback last", () => {
    const o = routeOptions({ brand: "visa", region: "UK", hasToken: true }, PSPS);
    expect(o.map((x) => x.psp)).toEqual(["psp-uk", "psp-eu", "psp-us", "psp-apac"]);
    expect(o.map((x) => x.credentialType)).toEqual(["network_token", "network_token", "network_token", "pan_fallback"]);
  });

  it("Mastercard EU token: only psp-eu takes the token; the rest fall back to the card number", () => {
    const o = routeOptions({ brand: "mastercard", region: "EU", hasToken: true }, PSPS);
    expect(o.map((x) => [x.psp, x.credentialType])).toEqual([
      ["psp-eu", "network_token"],
      ["psp-uk", "pan_fallback"],
      ["psp-us", "pan_fallback"],
      ["psp-apac", "pan_fallback"],
    ]);
  });

  it("falls back to the card number when no PSP accepts the token in the region (Mastercard APAC)", () => {
    const o = routeOptions({ brand: "mastercard", region: "APAC", hasToken: true }, PSPS);
    expect(o.every((x) => x.credentialType === "pan_fallback")).toBe(true);
    expect(o[0]!.psp).toBe("psp-apac");
  });

  it("an untokenised card uses the card number everywhere and still prefers domestic acquiring", () => {
    const o = routeOptions({ brand: "visa", region: "UK", hasToken: false }, PSPS);
    expect(o.every((x) => x.credentialType === "pan_fallback")).toBe(true);
    expect(o[0]!.psp).toBe("psp-uk");
  });

  it("excludes a PSP (failover gets the next capable PSP with the same token)", () => {
    const o = routeOptions({ brand: "visa", region: "UK", hasToken: true }, PSPS, { exclude: ["psp-uk"] });
    expect(o[0]).toMatchObject({ psp: "psp-eu", credentialType: "network_token" });
  });

  it("breaks ties by approval, then by cost", () => {
    const base: Omit<PspProfile, "id" | "costBps"> = {
      domestic: ["US"],
      tokenRegions: { visa: ["US"], mastercard: [] },
      approval: { US: 0.9, EU: 0.9, UK: 0.9, APAC: 0.9 },
      crossBorderBps: 100,
    };
    const psps: PspProfile[] = [
      { ...base, id: "psp-eu", costBps: 200 },
      { ...base, id: "psp-uk", costBps: 150 },
      { ...base, id: "psp-us", costBps: 150, approval: { US: 0.95, EU: 0.9, UK: 0.9, APAC: 0.9 } },
    ];
    expect(routerOrder({ brand: "visa", region: "US", hasToken: true }, psps)).toEqual(["psp-us", "psp-uk", "psp-eu"]);
  });

  it("adds the cross-border surcharge to cost when not domestic", () => {
    const o = routeOptions({ brand: "visa", region: "APAC", hasToken: true }, PSPS);
    const us = o.find((x) => x.psp === "psp-us")!;
    expect(us.domestic).toBe(false);
    expect(us.costBps).toBe(210 + 100);
  });
});
