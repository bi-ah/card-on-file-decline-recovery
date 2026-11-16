import type { SimMinute } from "./types";

export const MINUTES_PER_DAY = 1440;
export const HOUR = 60;
export const DAY = MINUTES_PER_DAY;

/** The UTC Date for a simulated minute on a run's night. */
export function simDate(nightDate: string, minute: SimMinute): Date {
  const base = Date.parse(`${nightDate}T00:00:00Z`);
  return new Date(base + minute * 60_000);
}

/** Simulated minute for a UTC Date, relative to the night. */
export function toSimMinute(nightDate: string, date: Date): SimMinute {
  const base = Date.parse(`${nightDate}T00:00:00Z`);
  return Math.round((date.getTime() - base) / 60_000);
}

/** "Day 3, 06:00" style label: day 1 is the night of the run. */
export function simLabel(minute: SimMinute): string {
  const day = Math.floor(minute / DAY) + 1;
  const m = ((minute % DAY) + DAY) % DAY;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `Day ${day}, ${hh}:${mm}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/**
 * Paydays: the 1st, 15th, 25th and last day of each month, at `hour` UTC.
 * Returns the first payday at or after `from + minGap`.
 */
export function nextPayday(nightDate: string, from: SimMinute, hour: number, minGap: number, paydays: number[]): SimMinute {
  const earliest = from + minGap;
  const start = simDate(nightDate, earliest);
  for (let i = 0; i < 70; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i, hour));
    const day = d.getUTCDate();
    const last = lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth());
    const isPayday = paydays.includes(day) || (paydays.includes(-1) && day === last);
    if (isPayday) {
      const m = toSimMinute(nightDate, d);
      if (m >= earliest) return m;
    }
  }
  throw new Error("no payday found");
}
