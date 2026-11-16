// Network attempt limits, counted per card lineage and merchant across all PSPs,
// original attempt included.

import { LIMITS, type LimitRule } from "./rules";
import type { Brand, SimMinute } from "./types";

/** Number of attempts in the window (t - window, t]. */
export function countInWindow(attempts: SimMinute[], t: SimMinute, windowMinutes: number): number {
  return attempts.filter((a) => a > t - windowMinutes && a <= t).length;
}

/** True when one more attempt at time t stays within every limit for the brand. */
export function withinLimits(brand: Brand, attempts: SimMinute[], t: SimMinute, limits: LimitRule[] = LIMITS): boolean {
  return limits.filter((l) => l.brand === brand).every((l) => countInWindow(attempts, t, l.windowMinutes) + 1 <= l.maxAttempts);
}

/**
 * The earliest time at or after `proposed` when one more attempt stays within every
 * limit, and the ids of the limits that moved it.
 */
export function earliestWithinLimits(
  brand: Brand,
  attempts: SimMinute[],
  proposed: SimMinute,
  limits: LimitRule[] = LIMITS,
): { at: SimMinute; limitIds: string[] } {
  let t = proposed;
  const moved = new Set<string>();
  const sorted = [...attempts].sort((a, b) => a - b);
  for (let guard = 0; guard < 100; guard++) {
    let changed = false;
    for (const l of limits.filter((x) => x.brand === brand)) {
      const inWindow = sorted.filter((a) => a > t - l.windowMinutes && a <= t);
      if (inWindow.length + 1 > l.maxAttempts) {
        // Wait until enough of the oldest attempts leave the window.
        const mustLeave = inWindow.length + 1 - l.maxAttempts;
        t = inWindow[mustLeave - 1]! + l.windowMinutes;
        moved.add(l.id);
        changed = true;
      }
    }
    if (!changed) return { at: t, limitIds: [...moved] };
  }
  throw new Error("limits did not converge");
}
