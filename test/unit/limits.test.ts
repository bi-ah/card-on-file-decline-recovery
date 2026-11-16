import { describe, expect, it } from "vitest";
import { countInWindow, earliestWithinLimits, withinLimits } from "../../src/core/limits";

describe("network limits", () => {
  it("counts attempts in (t - window, t]", () => {
    expect(countInWindow([0, 10, 1440], 1440, 1440)).toBe(2);
  });

  it("Visa allows the 15th attempt in 30 days and refuses the 16th", () => {
    const fourteen = Array.from({ length: 14 }, (_, i) => i * 60);
    expect(withinLimits("visa", fourteen, 1000)).toBe(true);
    expect(withinLimits("visa", [...fourteen, 900], 1000)).toBe(false);
  });

  it("Mastercard refuses an 8th attempt in 24 hours and a 36th in 30 days", () => {
    expect(withinLimits("mastercard", [0, 1, 2, 3, 4, 5, 6], 100)).toBe(false);
    expect(withinLimits("mastercard", [0, 1, 2, 3, 4, 5], 100)).toBe(true);
    const spread = Array.from({ length: 35 }, (_, i) => i * 1190);
    expect(withinLimits("mastercard", spread, 41000)).toBe(false);
    expect(withinLimits("mastercard", spread.slice(1), 41000)).toBe(true);
  });

  it("moves a retry to when the oldest attempt leaves the window", () => {
    const r = earliestWithinLimits("mastercard", [0, 10, 20, 30, 40, 50, 60], 100);
    expect(r.at).toBe(1440);
    expect(r.limitIds).toEqual(["mastercard.limit.24h"]);
  });

  it("leaves a retry unchanged when within limits", () => {
    expect(earliestWithinLimits("visa", [0], 60)).toEqual({ at: 60, limitIds: [] });
  });
});
