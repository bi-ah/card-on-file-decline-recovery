// The merchant platform's HTTP API and the operator page.

import { allRules, POLICY, ruleById, SOURCES } from "../core/rules";
import { simLabel } from "../core/time";
import { SIMULATED_LABEL } from "../sim/catalog";
import type { AttemptRow, DecisionRow, EventRow, PaymentRow, RunRow } from "../ledger/logic";
import { answer } from "./chat";
import readme from "../../README.md";
import { ledgerOf, type LedgerApi } from "./ledger-do";

export { Ledger } from "./ledger-do";
export { RecoveryWorkflow } from "./workflow";

const SIZES = { full: 2000, ci: 350 } as const;

type Stub = LedgerApi;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const ledger = ledgerOf(env);
    try {
      return await route(req, url, env, ledger);
    } catch (e) {
      console.error("api error", e instanceof Error ? e.message : String(e));
      return err(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, url: URL, env: Env, ledger: Stub): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, "");
  const m = (re: RegExp) => re.exec(p);
  let r: RegExpExecArray | null;

  if (p === "/api/health") return json({ ok: true });
  if (p === "/api/rules" && req.method === "GET") return json({ rules: allRules(), sources: SOURCES, policy: POLICY });
  if (p === "/api/overview" && req.method === "GET") {
    return new Response(readme, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
  }

  if (p === "/api/runs" && req.method === "GET") return json({ runs: (await ledger.listRuns(20)).map(runItem) });
  if (p === "/api/runs" && req.method === "POST") return createRun(req, env, ledger);
  if (p === "/api/runs/latest" && req.method === "GET") {
    const runs = await ledger.listRuns(20);
    const run = runs.find((x) => x.label === "full" && x.status === "completed") ?? runs[0];
    return run ? json({ run: runItem(run) }) : err(404, "no runs yet");
  }
  if ((r = m(/^\/api\/runs\/([\w-]+)$/)) && req.method === "GET") {
    const run = await ledger.getRun(r[1]!);
    if (!run) return err(404, "run not found");
    return json({ run: runItem(run), summary: await ledger.summary(run.id), simulatedLabel: SIMULATED_LABEL });
  }
  if ((r = m(/^\/api\/runs\/([\w-]+)\/recover$/)) && req.method === "POST") return startRecovery(r[1]!, env, ledger, url.searchParams.get("restart") === "1");
  if ((r = m(/^\/api\/runs\/([\w-]+)\/workflows$/)) && req.method === "GET") return workflowStatus(r[1]!, env, ledger);
  if ((r = m(/^\/api\/runs\/([\w-]+)\/live$/)) && req.method === "GET") {
    const run = await ledger.getRun(r[1]!);
    if (!run) return err(404, "run not found");
    const live = (await ledger.live(run.id, int(url.searchParams.get("after") ?? undefined, 0)))!;
    return json({
      run: runItem(run),
      serverNow: Date.now(),
      ...live,
      activity: live.activity.map((a) => ({ id: a.id, paymentId: a.payment_id, at: a.at, atLabel: simLabel(a.at), kind: a.kind, text: a.text })),
    });
  }
  if ((r = m(/^\/api\/runs\/([\w-]+)\/incidents$/)) && req.method === "GET") {
    const list = await ledger.incidents(r[1]!);
    return json({ incidents: list.map((i) => ({ ...i, fromLabel: simLabel(i.from), toLabel: simLabel(i.to) })) });
  }
  if ((r = m(/^\/api\/runs\/([\w-]+)\/payments$/)) && req.method === "GET") {
    const q = url.searchParams;
    const f: Record<string, string> = {};
    for (const k of ["status", "path", "brand", "psp", "region", "code", "q"]) {
      const v = q.get(k);
      if (v) f[k] = v.slice(0, 40);
    }
    const res = await ledger.listPayments(r[1]!, { ...f, limit: Math.min(int(q.get("limit") ?? undefined, 50), 200), offset: int(q.get("offset") ?? undefined, 0) });
    return json({ total: res.total, rows: res.rows.map(paymentItem) });
  }
  if ((r = m(/^\/api\/runs\/([\w-]+)\/breakdown$/)) && req.method === "GET") {
    const by = url.searchParams.get("by") ?? "classification";
    if (!["code", "path", "psp", "brand", "region", "outcome", "classification"].includes(by)) return err(400, "unknown breakdown");
    return json({ rows: await ledger.breakdown(r[1]!, by as "code") });
  }
  if ((r = m(/^\/api\/runs\/([\w-]+)\/export$/)) && req.method === "GET") {
    const run = await ledger.getRun(r[1]!);
    if (!run) return err(404, "run not found");
    return json({ run: runItem(run), ...(await ledger.exportRun(run.id)) });
  }
  if ((r = m(/^\/api\/runs\/([\w-]+)\/chat$/)) && req.method === "GET") return json({ messages: await ledger.chatHistory(r[1]!, 30) });
  if ((r = m(/^\/api\/payments\/([\w-]+)$/)) && req.method === "GET") {
    const t = await ledger.timeline(r[1]!);
    if (!t) return err(404, "payment not found");
    return json({ payment: paymentItem(t.payment), timeline: timeline(t.attempts, t.decisions, t.events) });
  }
  if (p === "/api/chat" && req.method === "POST") return chat(req, env, ledger);
  return err(404, "not found");
}

async function ipBucket(req: Request, ledger: Stub): Promise<string> {
  // Per-IP limits use a salted hash only; the raw address is never stored or logged.
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const salt = await ledger.ipSalt();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createRun(req: Request, env: Env, ledger: Stub): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { size?: string; seed?: number; dayMs?: number; start?: boolean };
  const size = body.size === "ci" ? "ci" : "full";
  const now = Date.now();
  const active = await ledger.activeRun(now);
  if (active) return err(409, "a run is already in progress; one active run at a time", { runId: active.id });
  const ip = await ipBucket(req, ledger);
  const ok = await ledger.takeQuotas(
    [
      { bucket: "runs:all", limit: int(env.QUOTA_RUNS_PER_HOUR, 10) },
      { bucket: `runs:ip:${ip}`, limit: int(env.QUOTA_RUNS_PER_IP_PER_HOUR, 3) },
    ],
    now,
  );
  if (!ok) return err(429, "hourly quota for generating nights reached; try again later", { resetsAt: nextHour(now) });
  const seed = Number.isInteger(body.seed) && body.seed! > 0 && body.seed! < 1e9 ? body.seed! : 1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 999_999);
  const dayMs = Number.isFinite(body.dayMs) ? Math.min(Math.max(Math.round(body.dayMs!), 200), 10_000) : int(env.SIM_DAY_MS, 3000);
  const runId = `run_${now.toString(36)}_${seed}`;
  const run = await ledger.createRun(
    { runId, seed, renewals: SIZES[size], nightDate: new Date(now).toISOString().slice(0, 10), dayMs, label: size, createdAt: now },
    int(env.KEEP_RUNS, 5),
  );
  if (body.start) {
    // One action: generate the night, then start recovery straight away.
    const started = await startRecovery(run.id, env, ledger);
    return json(await started.json(), started.status === 202 ? 201 : started.status);
  }
  return json({ run: runItem(run) }, 201);
}

async function startRecovery(runId: string, env: Env, ledger: Stub, restart = false): Promise<Response> {
  const run = await ledger.getRun(runId);
  if (!run) return err(404, "run not found");
  if (run.status === "abandoned") return err(409, "run abandoned");
  const { run: started, paymentIds } = await ledger.startRecovery(runId, Date.now());
  if (restart) {
    // Operations: restart instances of renewals still in progress. Safe because every
    // ledger step is idempotent by (payment, step): a replay gets the stored results.
    const { rows } = await ledger.listPayments(runId, { status: "recovering", limit: 500 });
    let restarted = 0;
    for (const p of rows) {
      const id = `${runId}-${p.id}`;
      try {
        await (await env.RECOVERY.get(id)).restart();
      } catch {
        await env.RECOVERY.create({ id, params: { runId, paymentId: p.id, dayMs: run.day_ms } });
      }
      restarted++;
    }
    return json({ run: runItem(started), started: 0, restarted }, 202);
  }
  // Deterministic instance ids: starting the same run twice cannot create duplicates.
  // createBatch reports per-instance errors; "already exists" (10405, 10415) is fine,
  // anything else is retried one by one so no failed renewal is left without a Workflow.
  const failed: string[] = [];
  for (let i = 0; i < paymentIds.length; i += 100) {
    const chunk = paymentIds.slice(i, i + 100);
    const res = await env.RECOVERY.createBatch({ instances: chunk.map((paymentId) => ({ id: `${runId}-${paymentId}`, params: { runId, paymentId, dayMs: run.day_ms } })) });
    for (const e of res.errors) {
      if (e.code === 10405 || e.code === 10415) continue;
      const paymentId = chunk[e.index]!;
      if (!(await createOne(env, runId, paymentId, run.day_ms))) failed.push(paymentId);
    }
  }
  if (failed.length) console.error("workflow create failed", failed.length);
  return json({ run: runItem(started), started: paymentIds.length - failed.length, failed: failed.length }, failed.length ? 500 : 202);
}

async function createOne(env: Env, runId: string, paymentId: string, dayMs: number): Promise<boolean> {
  const id = `${runId}-${paymentId}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.RECOVERY.create({ id, params: { runId, paymentId, dayMs } });
      return true;
    } catch (e) {
      // It may have been created after all: an existing instance is a success.
      try {
        await (await env.RECOVERY.get(id)).status();
        return true;
      } catch {
        if (attempt === 2) console.error("workflow create", e instanceof Error ? e.message : String(e));
      }
    }
  }
  return false;
}

/** Workflow instance states for the payments still in progress (operations view). */
async function workflowStatus(runId: string, env: Env, ledger: Stub): Promise<Response> {
  const { rows } = await ledger.listPayments(runId, { status: "recovering", limit: 200 });
  const counts: Record<string, number> = {};
  const sample: Array<{ id: string; status: string; error?: string }> = [];
  for (const p of rows.slice(0, 50)) {
    const id = `${runId}-${p.id}`;
    try {
      const s = await (await env.RECOVERY.get(id)).status();
      counts[s.status] = (counts[s.status] ?? 0) + 1;
      if (sample.length < 5) sample.push({ id, status: s.status, ...(s.error ? { error: String(s.error.message ?? s.error) } : {}) });
    } catch (e) {
      counts.missing = (counts.missing ?? 0) + 1;
      if (sample.length < 5) sample.push({ id, status: "missing", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ checked: Math.min(rows.length, 50), inProgress: rows.length, counts, sample });
}

async function chat(req: Request, env: Env, ledger: Stub): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { runId?: string; message?: string };
  const message = String(body.message ?? "").trim().slice(0, 500);
  if (!body.runId || !message) return err(400, "runId and message are required");
  const run = await ledger.getRun(body.runId);
  if (!run) return err(404, "run not found");
  const ip = await ipBucket(req, ledger);
  const ok = await ledger.takeQuotas(
    [
      { bucket: "chat:all", limit: int(env.QUOTA_CHAT_PER_HOUR, 100) },
      { bucket: `chat:ip:${ip}`, limit: int(env.QUOTA_CHAT_PER_IP_PER_HOUR, 20) },
    ],
    Date.now(),
  );
  if (!ok) return err(429, "hourly chat quota reached; try again later", { resetsAt: nextHour(Date.now()) });
  const history = await ledger.chatHistory(run.id, 6);
  const res = await answer(env.AI, env.AI_MODEL, ledger, run.id, history, message);
  await ledger.addChat(run.id, "user", message, [], Date.now());
  await ledger.addChat(run.id, "assistant", res.answer, res.tools, Date.now());
  return json(res);
}

function nextHour(nowMs: number): number {
  return (Math.floor(nowMs / 3_600_000) + 1) * 3_600_000;
}

function runItem(r: RunRow) {
  return {
    id: r.id,
    label: r.label,
    status: r.status,
    seed: r.seed,
    nightDate: r.night_date,
    renewals: r.renewals,
    declines: r.declines,
    dayMs: r.day_ms,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

function paymentItem(p: PaymentRow) {
  return {
    id: p.id,
    customerId: p.customer_id,
    brand: p.brand,
    region: p.region,
    bin: p.bin,
    last4: p.last4,
    expiry: p.expiry,
    credentialType: p.has_token ? "network_token" : "pan_fallback",
    amountCents: p.amount_cents,
    status: p.status,
    path: p.path,
    outcome: p.outcome,
    firstPsp: p.first_psp,
    lastPsp: p.last_psp,
    firstCode: p.first_code,
    firstMac: p.first_mac,
    retries: p.retries_used,
    altRetries: p.alt_retries_used,
    customerAsked: p.customer_asked === 1,
    preventedBy: p.prevented_by,
    finalReason: p.final_reason,
  };
}

function ruleRefs(ids: string[]) {
  return ids.map((id) => {
    const r = ruleById(id);
    const src = r ? SOURCES.find((s) => s.id === r.source) : undefined;
    return { id, label: r?.label ?? id, source: src?.title ?? "engine event", ...(src?.url ? { sourceUrl: src.url } : {}), confidence: r?.confidence ?? "high" };
  });
}

const EVENT_TITLES: Record<string, string> = {
  token_lifecycle_update: "Prevented: network token lifecycle update",
  account_updater_update: "Prevented: account updater",
  routed: "Routed",
  credential_refreshed: "Credential refreshed",
  credential_unchanged: "Credential not refreshed",
  customer_asked: "Customer asked to update the card",
  customer_updated_card: "Customer entered a new card",
  customer_notified: "Customer told",
  operations_alerted: "Operations alerted",
  reservation_refused: "Ledger refused the attempt",
  finished: "Finished",
};

function timeline(attempts: AttemptRow[], decisions: DecisionRow[], events: EventRow[]) {
  const out: Array<Record<string, unknown> & { at: number; order: number }> = [];
  for (const e of events) {
    const d = JSON.parse(e.detail) as Record<string, unknown>;
    const detail = typeof d.text === "string" ? d.text : e.type === "routed" ? `${d.psp} (${String(d.credentialType).replace("_", " ")}): ${(d.reasons as string[]).join(", ")}` : e.type === "reservation_refused" ? String(d.reason) : "";
    out.push({ at: e.at, order: e.type === "routed" || e.step === "prevention" ? 0 : 3, kind: "event", title: EVENT_TITLES[e.type] ?? e.type, detail });
  }
  for (const a of attempts) {
    out.push({
      at: a.at,
      order: 1,
      kind: "attempt",
      title: a.step === "initial" ? "Renewal charge" : a.customer_initiated ? "Charge of the new card" : "Retry",
      detail: `${a.psp}, ${a.credential_type === "network_token" ? "network token" : "card-number fallback"}, ${a.customer_initiated ? "customer-initiated" : "merchant-initiated recurring"}, NTID ${a.ntid}`,
      status: a.status,
      psp: a.psp,
      credentialType: a.credential_type,
      mit: a.mit === 1,
      customerInitiated: a.customer_initiated === 1,
      code: a.code,
      mac: a.mac,
    });
  }
  for (const d of decisions) {
    const dec = JSON.parse(d.json) as { action: string; psp?: string; at: number };
    const title = { retry: `Decision: retry${dec.psp ? ` via ${dec.psp}` : ""} at ${simLabel(dec.at)}`, update_credential: "Decision: refresh the credential", ask_customer: "Decision: ask the customer", stop: `Decision: stop (${d.stop_outcome})` }[d.action] ?? d.action;
    out.push({ at: d.at, order: 2, kind: "decision", title, detail: d.reason, action: d.action, rules: ruleRefs(JSON.parse(d.rule_ids) as string[]) });
  }
  return out.sort((a, b) => a.at - b.at || a.order - b.order).map(({ order: _o, ...rest }) => ({ ...rest, atLabel: simLabel(rest.at) }));
}
