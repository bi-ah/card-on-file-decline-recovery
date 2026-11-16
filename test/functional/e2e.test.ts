// Functional tests: drive the running Worker through its API.
//   E2E_BASE_URL=http://localhost:8787 npm run test:functional          (wrangler dev)
//   E2E_BASE_URL=https://<worker>.workers.dev npm run test:functional  (deployed)
// Generate a small night, recover it with real Workflows, wait for completion, then audit
// the ledger against every guardrail and check the chat answers from tools.

import { beforeAll, describe, expect, it } from "vitest";
import { auditRun, type RunExport } from "../../src/ledger/audit";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:8787").replace(/\/+$/, "");
const DAY_MS = Number(process.env.DAY_MS ?? 500);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 600_000);

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunItem {
  id: string;
  status: string;
  declines: number;
}

let runId = "";
let exported: RunExport & { run: RunItem };
let summary: { declined: number; recovered: number; recoveredCents: number; retries: number; inProgress: number; violations: number | null; naive: { recoveredCents: number; retries: number } };

describe(`functional: ${BASE}`, () => {
  beforeAll(async () => {
    expect((await api<{ ok: boolean }>("/api/health")).body.ok).toBe(true);
    // One active run at a time: wait for any run already in progress to finish.
    const deadline = Date.now() + TIMEOUT_MS;
    let created: { status: number; body: { run?: RunItem; error?: string } };
    for (;;) {
      created = await api("/api/runs", { method: "POST", body: JSON.stringify({ size: "ci", dayMs: DAY_MS }) });
      if (created.status !== 409 || Date.now() > deadline) break;
      await wait(5000);
    }
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    runId = created.body.run!.id;
    const rec = await api<{ started: number }>(`/api/runs/${runId}/recover`, { method: "POST" });
    expect(rec.status).toBe(202);
    expect(rec.body.started).toBe(created.body.run!.declines);
    for (;;) {
      const r = await api<{ run: RunItem; summary: typeof summary }>(`/api/runs/${runId}`);
      summary = r.body.summary;
      if (r.body.run.status === "completed" || Date.now() > deadline) break;
      await wait(3000);
    }
    exported = (await api<RunExport & { run: RunItem }>(`/api/runs/${runId}/export`)).body;
  });

  it("completes every failed renewal", () => {
    expect(exported.run.status).toBe("completed");
    expect(summary.inProgress).toBe(0);
    expect(summary.declined).toBeGreaterThan(20);
    expect(exported.payments.filter((p) => p.first_decline_at !== null).every((p) => p.status !== "recovering")).toBe(true);
  });

  it("obeys every guardrail in the ledger (never-retry, no cascade, limits, policy, MIT/NTID, no card numbers)", () => {
    expect(auditRun(exported)).toEqual([]);
    expect(summary.violations).toBe(0);
  });

  it("records every attempt before and after the PSP call, keyed by (payment, step)", () => {
    expect(exported.attempts.every((a) => a.status === "approved" || a.status === "declined")).toBe(true);
    const keys = exported.attempts.map((a) => `${a.payment_id}/${a.step}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starting recovery twice creates no duplicate work", async () => {
    const before = exported.attempts.length;
    await api(`/api/runs/${runId}/recover`, { method: "POST" });
    await wait(3000);
    const after = (await api<RunExport>(`/api/runs/${runId}/export`)).body;
    expect(after.attempts.length).toBe(before);
  });

  it("recovers more revenue with fewer retries than the naive schedule", () => {
    expect(summary.recoveredCents).toBeGreaterThan(summary.naive.recoveredCents);
    expect(summary.retries).toBeLessThan(summary.naive.retries);
  });

  it("explains every decision with its rules in the payment timeline", async () => {
    const declined = exported.payments.find((p) => p.first_decline_at !== null)!;
    const t = await api<{ timeline: Array<{ kind: string; rules?: Array<{ id: string; source: string; confidence: string }> }> }>(`/api/payments/${declined.id}`);
    const decisions = t.body.timeline.filter((e) => e.kind === "decision");
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.rules!.length).toBeGreaterThan(0);
      for (const r of d.rules!) expect(r.source).toBeTruthy();
    }
  });

  it("answers in chat from read-only tools", async () => {
    const r = await api<{ answer: string; tools: Array<{ name: string }> }>("/api/chat", { method: "POST", body: JSON.stringify({ runId, message: "Why did renewals fail last night?" }) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tools.length).toBeGreaterThan(0);
    const allowed = ["get_run_summary", "breakdown_declines", "list_incidents", "find_payments", "get_payment_timeline", "explain_rule"];
    for (const t of r.body.tools) expect(allowed).toContain(t.name);
    expect(r.body.answer.length).toBeGreaterThan(20);
    const history = await api<{ messages: Array<{ role: string }> }>(`/api/runs/${runId}/chat`);
    expect(history.body.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("rejects bad input and unknown routes", async () => {
    expect((await api("/api/chat", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await api("/api/payments/nope")).status).toBe(404);
    expect((await api("/api/nope")).status).toBe(404);
  });
});
