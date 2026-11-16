// Figures are formatted in code so the model can only quote them, never compute them.

export function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export const PATH_LABELS: Record<string, string> = {
  timed_retry: "timed retry through the same PSP",
  another_psp: "retry through another PSP",
  credential_refreshed: "credential refreshed (token lifecycle or account updater), then retried",
  customer_updated_card: "customer entered a new card",
  exhausted: "stopped: budget, limits or dunning window used up",
  cancelled: "cancelled: customer revoked the recurring payment",
  stopped: "stopped: never-retry code, customer told",
  stopped_silent: "stopped with no outreach (pick up card)",
  alert_ops: "stopped and operations alerted",
  in_progress: "still in progress",
  first_attempt: "approved on the first attempt",
};
