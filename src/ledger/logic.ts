// The ledger: payments, attempts, decisions, events and chat history over SQLite.
// The same code runs inside the Durable Object (ctx.storage.sql) and in Node tests
// (node:sqlite). Every mutating method is keyed by (payment, step) and idempotent.

import { decide } from "../core/engine";
import { withinLimits } from "../core/limits";
import { classify, isCascadable, RULES } from "../core/rules";
import { routeOptions } from "../core/router";
import { hash32 } from "../core/rng";
import type { Decision, PspId, RecoveryEvent, RecoveryState } from "../core/types";
import { PSPS } from "../sim/catalog";
import { legacySinglePsp, naiveOnSameDeclines, type InitialAttempt } from "../sim/baseline";
import { authorize, customerResponse, generateNight, refreshCredential, type AuthResult, type SimCard, type SimNight } from "../sim/world";
import { DAY } from "../core/time";
import { auditRun } from "./audit";

export interface SqlStore {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  run(sql: string, ...params: unknown[]): void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, seed INTEGER, label TEXT, night_date TEXT, renewals INTEGER, declines INTEGER,
     day_ms INTEGER, status TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, baseline_json TEXT, summary_json TEXT)`,
  // SIMULATED state. Read only by the simulator calls, never by merchant decisions.
  `CREATE TABLE IF NOT EXISTS sim_nights (run_id TEXT PRIMARY KEY, json TEXT)`,
  `CREATE TABLE IF NOT EXISTS sim_cards (payment_id TEXT PRIMARY KEY, run_id TEXT, json TEXT)`,
  `CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, run_id TEXT, customer_id TEXT, brand TEXT, region TEXT, issuer_id TEXT,
     bin TEXT, last4 TEXT, expiry TEXT, vault_ref TEXT, has_token INTEGER, lineage_id TEXT, credential_version INTEGER,
     amount_cents INTEGER, currency TEXT, bill_at INTEGER, status TEXT, outcome TEXT, path TEXT, final_reason TEXT,
     first_psp TEXT, last_psp TEXT, ntid TEXT, first_code TEXT, first_mac TEXT, first_decline_at INTEGER, now INTEGER,
     retries_used INTEGER DEFAULT 0, alt_retries_used INTEGER DEFAULT 0, blocked_versions TEXT DEFAULT '[]',
     updater_tried TEXT DEFAULT '[]', customer_asked INTEGER DEFAULT 0, last_classification TEXT, prevented_by TEXT,
     initial_version INTEGER, recovered_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS payments_run ON payments(run_id, status)`,
  `CREATE TABLE IF NOT EXISTS attempts (payment_id TEXT, step TEXT, run_id TEXT, lineage_id TEXT, seq INTEGER, at INTEGER, psp TEXT,
     credential_type TEXT, credential_version INTEGER, mit INTEGER, customer_initiated INTEGER, ntid TEXT, status TEXT,
     code TEXT, mac TEXT, PRIMARY KEY (payment_id, step))`,
  `CREATE INDEX IF NOT EXISTS attempts_lineage ON attempts(lineage_id)`,
  `CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id)`,
  `CREATE TABLE IF NOT EXISTS decisions (payment_id TEXT, step TEXT, run_id TEXT, at INTEGER, event TEXT, action TEXT, psp TEXT,
     route TEXT, wait_minutes INTEGER, reason TEXT, rule_ids TEXT, classification TEXT, stop_outcome TEXT, json TEXT,
     PRIMARY KEY (payment_id, step))`,
  `CREATE INDEX IF NOT EXISTS decisions_run ON decisions(run_id)`,
  `CREATE TABLE IF NOT EXISTS events (payment_id TEXT, step TEXT, run_id TEXT, at INTEGER, type TEXT, detail TEXT, PRIMARY KEY (payment_id, step))`,
  `CREATE INDEX IF NOT EXISTS events_run ON events(run_id)`,
  `CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, role TEXT, content TEXT, tools TEXT, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS quotas (bucket TEXT, window_start INTEGER, count INTEGER, PRIMARY KEY (bucket, window_start))`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  // A feed of what happened, in the order it happened (for the live view on the operator page).
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, payment_id TEXT, at INTEGER, kind TEXT, text TEXT)`,
  `CREATE INDEX IF NOT EXISTS activity_run ON activity(run_id, id)`,
];

export interface ActivityRow {
  id: number;
  run_id: string;
  payment_id: string;
  at: number;
  kind: string;
  text: string;
}

export interface LiveProgress {
  status: string;
  declined: number;
  settled: number;
  inProgress: number;
  recovered: number;
  recoveredCents: number;
  attempts: number;
  /** The furthest simulated minute any renewal in the run has reached. */
  simNow: number;
  activity: ActivityRow[];
  cursor: number;
}

export interface PaymentRow {
  id: string;
  run_id: string;
  customer_id: string;
  brand: "visa" | "mastercard";
  region: "US" | "EU" | "UK" | "APAC";
  issuer_id: string;
  bin: string;
  last4: string;
  expiry: string;
  vault_ref: string;
  has_token: number;
  lineage_id: string;
  credential_version: number;
  amount_cents: number;
  currency: string;
  bill_at: number;
  status: "approved" | "recovering" | "recovered" | "failed" | "cancelled";
  outcome: string | null;
  path: string | null;
  final_reason: string | null;
  first_psp: PspId;
  last_psp: PspId;
  ntid: string;
  first_code: string | null;
  first_mac: string | null;
  first_decline_at: number | null;
  now: number;
  retries_used: number;
  alt_retries_used: number;
  blocked_versions: string;
  updater_tried: string;
  customer_asked: number;
  last_classification: string | null;
  prevented_by: string | null;
  initial_version: number;
  recovered_at: number | null;
}

export interface AttemptRow {
  payment_id: string;
  step: string;
  run_id: string;
  lineage_id: string;
  seq: number;
  at: number;
  psp: PspId;
  credential_type: string;
  credential_version: number;
  mit: number;
  customer_initiated: number;
  ntid: string;
  status: "reserved" | "approved" | "declined";
  code: string | null;
  mac: string | null;
}

export interface DecisionRow {
  payment_id: string;
  step: string;
  run_id: string;
  at: number;
  event: string;
  action: string;
  psp: string | null;
  route: string | null;
  wait_minutes: number;
  reason: string;
  rule_ids: string;
  classification: string;
  stop_outcome: string | null;
  json: string;
}

export interface EventRow {
  payment_id: string;
  step: string;
  run_id: string;
  at: number;
  type: string;
  detail: string;
}

export interface RunRow {
  id: string;
  seed: number;
  label: string;
  night_date: string;
  renewals: number;
  declines: number;
  day_ms: number;
  status: "generated" | "recovering" | "completed" | "abandoned";
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  baseline_json: string | null;
  summary_json: string | null;
}

export type Reservation =
  | { ok: true; attempt: AttemptRow }
  | { ok: false; reason: string };

const json = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);

function vaultRef(seed: string | number, ...parts: Array<string | number>): string {
  return `vref_${hash32(seed, ...parts).toString(36)}${hash32("v", seed, ...parts).toString(36)}`;
}

export class LedgerLogic {
  constructor(private readonly db: SqlStore) {}

  migrate(): void {
    for (const s of SCHEMA) this.db.run(s);
  }

  // ---------- runs ----------

  activeRun(nowMs: number, staleMs = 20 * 60_000): RunRow | undefined {
    const r = this.db.all<RunRow>(`SELECT * FROM runs WHERE status IN ('generated','recovering') ORDER BY created_at DESC LIMIT 1`)[0];
    if (!r) return undefined;
    if (nowMs - r.created_at > staleMs) {
      this.db.run(`UPDATE runs SET status='abandoned' WHERE id=?`, r.id);
      return undefined;
    }
    return r;
  }

  createRun(p: { runId: string; seed: number; renewals: number; nightDate: string; dayMs: number; label: string; createdAt: number; customerResponseRate?: number }): RunRow {
    const existing = this.getRun(p.runId);
    if (existing) return existing;
    const night = generateNight(p.seed, p.renewals, p.nightDate, { customerResponseRate: p.customerResponseRate ?? 0.3 });
    const { cards, ...nightMeta } = night;
    this.db.run(`INSERT INTO sim_nights (run_id, json) VALUES (?, ?)`, p.runId, JSON.stringify(nightMeta));
    const initial = new Map<string, InitialAttempt>();
    let declines = 0;
    for (const card of cards) {
      this.db.run(`INSERT INTO sim_cards (payment_id, run_id, json) VALUES (?, ?, ?)`, card.paymentId, p.runId, JSON.stringify(card));
      const options = routeOptions({ brand: card.brand, region: card.region, hasToken: card.tokenised }, PSPS);
      const best = options[0]!;
      const version = card.preventedBy ? 2 : 1;
      const lineage = `lin_${card.paymentId}`;
      const ntid = `ntid_${hash32(p.seed, card.index, "ntid").toString(36)}`;
      const result = authorize(night, card, { at: card.billAt, psp: best.psp, credentialType: best.credentialType, credentialVersion: version, customerCard: false, attemptNo: 0 });
      initial.set(card.paymentId, { psp: best.psp, credentialType: best.credentialType, credentialVersion: version, result });
      const declined = !result.approved;
      if (declined) declines++;
      this.db.run(
        `INSERT INTO payments (id, run_id, customer_id, brand, region, issuer_id, bin, last4, expiry, vault_ref, has_token, lineage_id,
          credential_version, amount_cents, currency, bill_at, status, outcome, path, first_psp, last_psp, ntid, first_code, first_mac,
          first_decline_at, now, prevented_by, initial_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        card.paymentId, p.runId, card.customerId, card.brand, card.region, card.issuerId, card.bin, card.last4,
        card.preventedBy ? refreshedExpiry(card.expiry) : card.expiry, vaultRef(p.seed, card.index), card.tokenised ? 1 : 0, lineage,
        version, card.amountCents, card.currency, card.billAt, declined ? "recovering" : "approved", declined ? null : "approved_first_time",
        declined ? null : "first_attempt", best.psp, best.psp, ntid, declined ? result.code : null, declined ? (result.mac ?? null) : null,
        declined ? card.billAt : null, card.billAt, card.preventedBy, version,
      );
      if (card.preventedBy) {
        this.event(card.paymentId, "prevention", p.runId, card.billAt - 60, card.preventedBy === "token_lifecycle" ? "token_lifecycle_update" : "account_updater_update", {
          text: card.preventedBy === "token_lifecycle" ? "Network token lifecycle update before billing: expiry or card refreshed, token unchanged" : "Account updater refreshed the card before billing",
        });
      }
      this.db.run(
        `INSERT INTO attempts (payment_id, step, run_id, lineage_id, seq, at, psp, credential_type, credential_version, mit, customer_initiated, ntid, status, code, mac)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        card.paymentId, "initial", p.runId, lineage, 0, card.billAt, best.psp, best.credentialType, version, 1, 0, ntid,
        result.approved ? "approved" : "declined", result.approved ? null : result.code, result.approved ? null : (result.mac ?? null),
      );
      this.event(card.paymentId, "route", p.runId, card.billAt, "routed", { psp: best.psp, credentialType: best.credentialType, reasons: best.reasons, alternatives: options.slice(1).map((o) => o.psp) });
    }
    const baseline = {
      naive: naiveOnSameDeclines(night, new Map([...initial].filter(([, a]) => !a.result.approved))),
      legacy: legacySinglePsp(night),
      pspOutage: night.pspOutage,
      issuerOutage: night.issuerOutage,
    };
    this.db.run(
      `INSERT INTO runs (id, seed, label, night_date, renewals, declines, day_ms, status, created_at, baseline_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      p.runId, p.seed, p.label, p.nightDate, p.renewals, declines, p.dayMs, "generated", p.createdAt, JSON.stringify(baseline),
    );
    return this.getRun(p.runId)!;
  }

  startRecovery(runId: string, nowMs: number): { run: RunRow; paymentIds: string[] } {
    const run = this.getRun(runId);
    if (!run) throw new Error("run not found");
    if (run.status === "generated") this.db.run(`UPDATE runs SET status='recovering', started_at=? WHERE id=?`, nowMs, runId);
    const ids = this.db.all<{ id: string }>(`SELECT id FROM payments WHERE run_id=? AND first_decline_at IS NOT NULL ORDER BY id`, runId).map((r) => r.id);
    if (ids.length === 0) this.completeRun(runId, nowMs);
    return { run: this.getRun(runId)!, paymentIds: ids };
  }

  getRun(runId: string): RunRow | undefined {
    return this.db.all<RunRow>(`SELECT * FROM runs WHERE id=?`, runId)[0];
  }

  listRuns(limit = 20): RunRow[] {
    return this.db.all<RunRow>(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`, limit);
  }

  /** Keep the newest `keep` runs; delete older ones. */
  pruneRuns(keep: number): void {
    const old = this.db.all<{ id: string }>(`SELECT id FROM runs ORDER BY created_at DESC LIMIT -1 OFFSET ?`, keep);
    const keepFull = this.db.all<{ id: string }>(`SELECT id FROM runs WHERE label='full' AND status='completed' ORDER BY created_at DESC LIMIT 1`)[0]?.id;
    for (const { id } of old) {
      if (id === keepFull) continue;
      for (const t of ["payments", "attempts", "decisions", "events", "sim_cards", "chat", "activity"]) this.db.run(`DELETE FROM ${t} WHERE run_id=?`, id);
      this.db.run(`DELETE FROM sim_nights WHERE run_id=?`, id);
      this.db.run(`DELETE FROM runs WHERE id=?`, id);
    }
  }

  // ---------- recovery steps ----------

  payment(id: string): PaymentRow {
    const p = this.db.all<PaymentRow>(`SELECT * FROM payments WHERE id=?`, id)[0];
    if (!p) throw new Error(`payment ${id} not found`);
    return p;
  }

  initialEvent(paymentId: string): RecoveryEvent {
    const a = this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE payment_id=? AND step='initial'`, paymentId)[0]!;
    return { type: "declined", at: a.at, code: a.code!, ...(a.mac ? { mac: a.mac } : {}), psp: a.psp, credentialVersion: a.credential_version };
  }

  state(p: PaymentRow, night: string): RecoveryState {
    const lineage = this.db.all<{ at: number }>(`SELECT at FROM attempts WHERE lineage_id=? ORDER BY at`, p.lineage_id).map((r) => r.at);
    const order = routeOptions({ brand: p.brand, region: p.region, hasToken: p.has_token === 1 }, PSPS).map((o) => o.psp);
    return {
      brand: p.brand,
      nightDate: night,
      firstDeclineAt: p.first_decline_at ?? p.bill_at,
      retriesUsed: p.retries_used,
      altPspRetriesUsed: p.alt_retries_used,
      lastPsp: p.last_psp,
      credentialVersion: p.credential_version,
      blockedVersions: json<number[]>(p.blocked_versions, []),
      updaterTriedVersions: json<number[]>(p.updater_tried, []),
      customerAsked: p.customer_asked === 1,
      lineageAttempts: lineage,
      routerOrder: order,
      ...(p.last_classification ? { lastClassification: p.last_classification } : {}),
    };
  }

  decide(paymentId: string, step: string, event: RecoveryEvent): Decision {
    const existing = this.db.all<DecisionRow>(`SELECT * FROM decisions WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (existing) return JSON.parse(existing.json) as Decision;
    const p = this.payment(paymentId);
    const run = this.getRun(p.run_id)!;
    const d = decide(this.state(p, run.night_date), event, RULES);
    const blocked = json<number[]>(p.blocked_versions, []);
    if (d.blocksCredentialVersion !== undefined && !blocked.includes(d.blocksCredentialVersion)) blocked.push(d.blocksCredentialVersion);
    this.db.run(
      `UPDATE payments SET blocked_versions=?, last_classification=?, now=? WHERE id=?`,
      JSON.stringify(blocked), event.type === "declined" ? d.classification : (p.last_classification ?? d.classification), event.at, paymentId,
    );
    this.db.run(
      `INSERT INTO decisions (payment_id, step, run_id, at, event, action, psp, route, wait_minutes, reason, rule_ids, classification, stop_outcome, json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      paymentId, step, p.run_id, event.at, JSON.stringify(event), d.action, d.psp ?? null, d.route ?? null, d.waitMinutes, d.reason,
      JSON.stringify(d.ruleIds), d.classification, d.stopOutcome ?? null, JSON.stringify(d),
    );
    return d;
  }

  /** Reserve an attempt before calling the PSP. Re-checks every guardrail atomically. */
  reserve(paymentId: string, step: string, d: Decision): Reservation {
    const existing = this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (existing) return { ok: true, attempt: existing };
    const refused = this.db.all<EventRow>(`SELECT * FROM events WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (refused) return { ok: false, reason: json<{ reason: string }>(refused.detail, { reason: "refused" }).reason };
    const p = this.payment(paymentId);
    const refuse = (reason: string): Reservation => {
      this.event(paymentId, step, p.run_id, d.at, "reservation_refused", { reason });
      return { ok: false, reason };
    };
    if (p.status !== "recovering") return refuse(`payment is ${p.status}`);
    if (d.action !== "retry" || !d.psp) return refuse("not a retry decision");
    const blocked = json<number[]>(p.blocked_versions, []);
    if (!d.customerInitiated && blocked.includes(p.credential_version)) return refuse("credential version is blocked (never-retry decline)");
    const lineage = this.db.all<{ at: number }>(`SELECT at FROM attempts WHERE lineage_id=?`, p.lineage_id).map((r) => r.at);
    if (!withinLimits(p.brand, lineage, d.at, RULES.limits)) return refuse("network attempt limit for this card");
    if (!d.customerInitiated && p.retries_used >= RULES.policy.maxRetriesPerRenewal) return refuse("retry budget used");
    const alt = d.route === "next_psp";
    if (alt && p.alt_retries_used >= RULES.policy.maxAltPspRetries) return refuse("retries via another PSP used");
    if (!d.customerInitiated && p.first_decline_at !== null && d.at > p.first_decline_at + RULES.policy.dunningWindowDays * DAY) return refuse("outside the dunning window");
    const option = routeOptions({ brand: p.brand, region: p.region, hasToken: p.has_token === 1 }, PSPS).find((o) => o.psp === d.psp)!;
    const seq = this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM attempts WHERE payment_id=?`, paymentId)[0]!.n;
    this.db.run(
      `INSERT INTO attempts (payment_id, step, run_id, lineage_id, seq, at, psp, credential_type, credential_version, mit, customer_initiated, ntid, status, code, mac)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      paymentId, step, p.run_id, p.lineage_id, seq, d.at, d.psp, option.credentialType, p.credential_version,
      d.customerInitiated ? 0 : 1, d.customerInitiated ? 1 : 0, p.ntid, "reserved",
    );
    this.db.run(
      `UPDATE payments SET retries_used=retries_used+?, alt_retries_used=alt_retries_used+?, now=?, last_psp=? WHERE id=?`,
      d.customerInitiated ? 0 : 1, alt ? 1 : 0, d.at, d.psp, paymentId,
    );
    return { ok: true, attempt: this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE payment_id=? AND step=?`, paymentId, step)[0]! };
  }

  /** SIMULATED PSP call for a reserved attempt. Reads simulator state only; writes nothing. */
  simulatePsp(paymentId: string, step: string): AuthResult {
    const a = this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (!a) throw new Error("no reserved attempt");
    if (a.status !== "reserved") return a.status === "approved" ? { approved: true } : { approved: false, code: a.code!, ...(a.mac ? { mac: a.mac } : {}) };
    const { night, card } = this.sim(paymentId);
    return authorize(night, card, {
      at: a.at,
      psp: a.psp,
      credentialType: a.credential_type as "network_token" | "pan_fallback",
      credentialVersion: a.credential_version,
      customerCard: a.customer_initiated === 1,
      attemptNo: a.seq,
    });
  }

  /** Record the PSP result after the call. */
  record(paymentId: string, step: string, r: AuthResult): void {
    const a = this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (!a || a.status !== "reserved") return;
    this.db.run(
      `UPDATE attempts SET status=?, code=?, mac=? WHERE payment_id=? AND step=?`,
      r.approved ? "approved" : "declined", r.approved ? null : r.code, r.approved ? null : (r.mac ?? null), paymentId, step,
    );
    if (r.approved) {
      const p = this.payment(paymentId);
      const path = a.customer_initiated ? "customer_updated_card" : p.credential_version > p.initial_version ? "credential_refreshed" : a.psp !== p.first_psp ? "another_psp" : "timed_retry";
      const ntid = a.customer_initiated ? `ntid_${hash32(paymentId, step).toString(36)}` : p.ntid;
      this.db.run(`UPDATE payments SET status='recovered', outcome='recovered', path=?, recovered_at=?, ntid=? WHERE id=?`, path, a.at, ntid, paymentId);
    }
    const what = a.customer_initiated ? "new card charged" : "retry";
    this.activity(a.run_id, paymentId, a.at, r.approved ? "approved" : "declined", r.approved ? `${what} via ${a.psp} approved` : `${what} via ${a.psp} declined ${r.code}${r.mac ? ` / MAC ${r.mac}` : ""}`);
  }

  updateCredential(paymentId: string, step: string, at: number): { updated: boolean; version: number } {
    const done = this.db.all<EventRow>(`SELECT * FROM events WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (done) return json<{ updated: boolean; version: number }>(done.detail, { updated: false, version: 0 });
    const p = this.payment(paymentId);
    const tried = json<number[]>(p.updater_tried, []);
    tried.push(p.credential_version);
    const { card } = this.sim(paymentId);
    const via = p.has_token ? "token lifecycle refresh" : "account updater inquiry";
    // A refresh helps at most once per renewal (the simulator has one newer credential).
    const r = p.credential_version > p.initial_version ? { updated: false } : refreshCredential(card);
    let version = p.credential_version;
    if (r.updated) {
      version = p.credential_version + 1;
      this.db.run(`UPDATE payments SET credential_version=?, expiry=COALESCE(?, expiry), last4=COALESCE(?, last4), updater_tried=?, now=? WHERE id=?`, version, r.expiry ?? null, r.last4 ?? null, JSON.stringify(tried), at, paymentId);
    } else {
      this.db.run(`UPDATE payments SET updater_tried=?, now=? WHERE id=?`, JSON.stringify(tried), at, paymentId);
    }
    const detail = { updated: r.updated, version, via, text: r.updated ? `${via}: new credential (expiry or card replaced)` : `${via}: no newer credential${"closed" in r && r.closed ? " (account closed)" : ""}` };
    this.event(paymentId, step, p.run_id, at, r.updated ? "credential_refreshed" : "credential_unchanged", detail);
    this.activity(p.run_id, paymentId, at, "credential", detail.text);
    return { updated: r.updated, version };
  }

  askCustomer(paymentId: string, step: string, at: number): { respondsAfter: number | null; windowMinutes: number } {
    const windowMinutes = RULES.policy.customerResponseDays * DAY;
    const done = this.db.all<EventRow>(`SELECT * FROM events WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (done) return json(done.detail, { respondsAfter: null, windowMinutes });
    const p = this.payment(paymentId);
    const { card } = this.sim(paymentId);
    const after = customerResponse(card);
    const respondsAfter = after !== null && after <= windowMinutes ? after : null;
    this.db.run(`UPDATE payments SET customer_asked=1, now=? WHERE id=?`, at, paymentId);
    this.event(paymentId, step, p.run_id, at, "customer_asked", {
      respondsAfter,
      windowMinutes,
      text: customerMessage(p.last_classification),
    });
    this.activity(p.run_id, paymentId, at, "customer", "customer asked to update the card");
    return { respondsAfter, windowMinutes };
  }

  customerUpdated(paymentId: string, step: string, at: number): void {
    const done = this.db.all<EventRow>(`SELECT * FROM events WHERE payment_id=? AND step=?`, paymentId, step)[0];
    if (done) return;
    const p = this.payment(paymentId);
    const lineage = `${p.lineage_id}_c`;
    const last4 = String(1000 + (hash32(paymentId, "new-card") % 9000));
    this.db.run(
      `UPDATE payments SET lineage_id=?, credential_version=credential_version+1, vault_ref=?, has_token=1, last4=?, now=? WHERE id=?`,
      lineage, vaultRef(paymentId, "customer"), last4, at, paymentId,
    );
    this.event(paymentId, step, p.run_id, at, "customer_updated_card", { text: "The customer entered a new card in the hosted form; the vault provisioned a new network token" });
    this.activity(p.run_id, paymentId, at, "customer", "customer entered a new card");
  }

  finish(paymentId: string, d: Decision | null, at: number): void {
    const done = this.db.all<EventRow>(`SELECT * FROM events WHERE payment_id=? AND step='finish'`, paymentId)[0];
    const p = this.payment(paymentId);
    if (!done) {
      if (p.status === "recovering") {
        const outcome = d?.stopOutcome ?? "exhausted";
        this.db.run(`UPDATE payments SET status=?, outcome=?, path=?, final_reason=?, now=? WHERE id=?`, outcome === "cancelled" ? "cancelled" : "failed", outcome, outcome, d?.reason ?? "stopped", at, paymentId);
        if (d?.notifyCustomer) this.event(paymentId, "notify", p.run_id, at, "customer_notified", { text: stopMessage(outcome) });
        this.activity(p.run_id, paymentId, at, "stopped", `stopped: ${outcome.replace("_", " ")}`);
        if (outcome === "alert_ops") this.event(paymentId, "alert", p.run_id, at, "operations_alerted", { text: "Invalid transaction (12): operations alerted to check the request format" });
      }
      this.event(paymentId, "finish", p.run_id, at, "finished", { status: this.payment(paymentId).status });
    }
    const left = this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM payments WHERE run_id=? AND status='recovering'`, p.run_id)[0]!.n;
    if (left === 0) this.completeRun(p.run_id, Date.now());
  }

  completeRun(runId: string, nowMs: number): void {
    const run = this.getRun(runId);
    if (!run || run.status === "completed") return;
    const summary = { ...this.summary(runId), status: "completed", violations: auditRun(this.exportRun(runId)).length };
    this.db.run(`UPDATE runs SET status='completed', completed_at=?, summary_json=? WHERE id=?`, nowMs, JSON.stringify(summary), runId);
  }

  // ---------- reads ----------

  sim(paymentId: string): { night: SimNight; card: SimCard } {
    const c = this.db.all<{ json: string; run_id: string }>(`SELECT json, run_id FROM sim_cards WHERE payment_id=?`, paymentId)[0]!;
    const n = this.db.all<{ json: string }>(`SELECT json FROM sim_nights WHERE run_id=?`, c.run_id)[0]!;
    const card = JSON.parse(c.json) as SimCard;
    return { night: { ...(JSON.parse(n.json) as Omit<SimNight, "cards">), cards: [card] }, card };
  }

  summary(runId: string): RunSummary {
    const run = this.getRun(runId)!;
    const pay = this.db.all<PaymentRow>(`SELECT * FROM payments WHERE run_id=?`, runId);
    const att = this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE run_id=?`, runId);
    const declined = pay.filter((p) => p.first_decline_at !== null);
    const recovered = declined.filter((p) => p.status === "recovered");
    const sum = (xs: PaymentRow[]) => xs.reduce((s, p) => s + p.amount_cents, 0);
    const byPath: Record<string, { count: number; cents: number }> = {};
    for (const p of declined) {
      const k = p.status === "recovering" ? "in_progress" : (p.path ?? "unknown");
      byPath[k] ??= { count: 0, cents: 0 };
      byPath[k].count++;
      byPath[k].cents += p.amount_cents;
    }
    const retries = att.filter((a) => a.step !== "initial" && a.customer_initiated === 0 && a.status !== "reserved").length;
    const altRetries = declined.reduce((s, p) => s + p.alt_retries_used, 0);
    const baseline = json<{ naive: BaselineLike; legacy: BaselineLike & { approvedFirst: number; renewals: number } }>(run.baseline_json, null as never);
    const initial = att.filter((a) => a.step === "initial");
    return {
      runId,
      status: run.status,
      renewals: pay.length,
      approvedFirstTime: pay.length - declined.length,
      declined: declined.length,
      declinedCents: sum(declined),
      recovered: recovered.length,
      recoveredCents: sum(recovered),
      recoveryRateByAmount: declined.length ? sum(recovered) / sum(declined) : 0,
      inProgress: declined.filter((p) => p.status === "recovering").length,
      retries,
      altPspRetries: altRetries,
      customersAsked: declined.filter((p) => p.customer_asked === 1).length,
      byPath,
      prevention: {
        tokenLifecycle: pay.filter((p) => p.prevented_by === "token_lifecycle").length,
        accountUpdater: pay.filter((p) => p.prevented_by === "account_updater").length,
      },
      credentialTypes: {
        networkToken: initial.filter((a) => a.credential_type === "network_token").length,
        panFallback: initial.filter((a) => a.credential_type === "pan_fallback").length,
      },
      naive: baseline.naive,
      legacy: baseline.legacy,
      violations: null,
    };
  }

  exportRun(runId: string): { payments: PaymentRow[]; attempts: AttemptRow[]; decisions: DecisionRow[]; events: EventRow[] } {
    return {
      payments: this.db.all<PaymentRow>(`SELECT * FROM payments WHERE run_id=? ORDER BY id`, runId),
      attempts: this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE run_id=? ORDER BY payment_id, seq`, runId),
      decisions: this.db.all<DecisionRow>(`SELECT * FROM decisions WHERE run_id=? ORDER BY payment_id, at`, runId),
      events: this.db.all<EventRow>(`SELECT * FROM events WHERE run_id=? ORDER BY payment_id, at`, runId),
    };
  }

  listPayments(runId: string, f: { status?: string; path?: string; brand?: string; psp?: string; code?: string; region?: string; q?: string; declinedOnly?: boolean; limit?: number; offset?: number }): { total: number; rows: PaymentRow[] } {
    const where = ["run_id=?"];
    const args: unknown[] = [runId];
    const add = (sql: string, v: unknown) => {
      where.push(sql);
      args.push(v);
    };
    if (f.declinedOnly !== false) where.push("first_decline_at IS NOT NULL");
    if (f.status) add("status=?", f.status);
    if (f.path) add("path=?", f.path);
    if (f.brand) add("brand=?", f.brand);
    if (f.psp) add("first_psp=?", f.psp);
    if (f.region) add("region=?", f.region);
    if (f.code) add("first_code=?", f.code);
    if (f.q) add("(id LIKE ? OR customer_id LIKE ?)", `%${f.q}%`), args.push(`%${f.q}%`);
    const w = where.join(" AND ");
    const total = this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM payments WHERE ${w}`, ...args)[0]!.n;
    const rows = this.db.all<PaymentRow>(`SELECT * FROM payments WHERE ${w} ORDER BY id LIMIT ? OFFSET ?`, ...args, Math.min(f.limit ?? 50, 500), f.offset ?? 0);
    return { total, rows };
  }

  timeline(paymentId: string): { payment: PaymentRow; attempts: AttemptRow[]; decisions: DecisionRow[]; events: EventRow[] } {
    return {
      payment: this.payment(paymentId),
      attempts: this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE payment_id=? ORDER BY seq`, paymentId),
      decisions: this.db.all<DecisionRow>(`SELECT * FROM decisions WHERE payment_id=? ORDER BY at, step`, paymentId),
      events: this.db.all<EventRow>(`SELECT * FROM events WHERE payment_id=? ORDER BY at`, paymentId),
    };
  }

  /** Incidents detected from the ledger alone: clusters of PSP-unavailable and issuer-unavailable responses. */
  incidents(runId: string): Incident[] {
    const out: Incident[] = [];
    const psp = this.db.all<{ psp: string; n: number; first: number; last: number }>(
      `SELECT psp, COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM attempts WHERE run_id=? AND code='PSP_UNAVAILABLE' GROUP BY psp HAVING n >= 3`, runId,
    );
    for (const r of psp) {
      const recovered = this.db.all<{ n: number }>(
        `SELECT COUNT(DISTINCT a.payment_id) AS n FROM attempts a JOIN payments p ON p.id=a.payment_id WHERE a.run_id=? AND a.psp=? AND a.code='PSP_UNAVAILABLE' AND p.status='recovered'`, runId, r.psp,
      )[0]!.n;
      out.push({ kind: "psp_outage", subject: r.psp, from: r.first, to: r.last, affected: r.n, recovered, text: `${r.psp} did not answer ${r.n} authorisations; the router failed over to the next capable PSP with the same token` });
    }
    const iss = this.db.all<{ issuer_id: string; n: number; first: number; last: number }>(
      `SELECT p.issuer_id, COUNT(*) AS n, MIN(a.at) AS first, MAX(a.at) AS last FROM attempts a JOIN payments p ON p.id=a.payment_id
       WHERE a.run_id=? AND a.code='91' GROUP BY p.issuer_id HAVING n >= 3`, runId,
    );
    for (const r of iss) {
      const recovered = this.db.all<{ n: number }>(
        `SELECT COUNT(DISTINCT a.payment_id) AS n FROM attempts a JOIN payments p ON p.id=a.payment_id WHERE a.run_id=? AND p.issuer_id=? AND a.code='91' AND p.status='recovered'`, runId, r.issuer_id,
      )[0]!.n;
      out.push({ kind: "issuer_outage", subject: r.issuer_id, from: r.first, to: r.last, affected: r.n, recovered, text: `Issuer ${r.issuer_id} answered 91 (issuer unavailable) ${r.n} times; retries backed off and could use another PSP` });
    }
    return out;
  }

  /** Decline counts grouped for the chat and the page. */
  breakdown(runId: string, by: "code" | "path" | "psp" | "brand" | "region" | "outcome" | "classification"): Array<{ key: string; count: number; cents: number }> {
    const col = { code: "p.first_code", path: "p.path", psp: "p.first_psp", brand: "p.brand", region: "p.region", outcome: "p.outcome", classification: "d.classification" }[by];
    if (by === "classification") {
      return this.db.all<{ key: string; count: number; cents: number }>(
        `SELECT d.classification AS key, COUNT(*) AS count, SUM(p.amount_cents) AS cents FROM decisions d JOIN payments p ON p.id=d.payment_id
         WHERE d.run_id=? AND d.step='decide-0' GROUP BY key ORDER BY count DESC`, runId,
      );
    }
    return this.db.all<{ key: string; count: number; cents: number }>(
      `SELECT COALESCE(${col}, 'in_progress') AS key, COUNT(*) AS count, SUM(p.amount_cents) AS cents FROM payments p WHERE p.run_id=? AND p.first_decline_at IS NOT NULL GROUP BY key ORDER BY count DESC`, runId,
    );
  }

  addChat(runId: string, role: string, content: string, tools: unknown, nowMs: number): void {
    this.db.run(`INSERT INTO chat (run_id, role, content, tools, created_at) VALUES (?,?,?,?,?)`, runId, role, content, JSON.stringify(tools ?? []), nowMs);
  }

  chatHistory(runId: string, limit = 20): Array<{ role: string; content: string; tools: unknown }> {
    return this.db
      .all<{ role: string; content: string; tools: string }>(`SELECT role, content, tools FROM chat WHERE run_id=? ORDER BY id DESC LIMIT ?`, runId, limit)
      .reverse()
      .map((r) => ({ role: r.role, content: r.content, tools: json(r.tools, []) }));
  }

  // ---------- quotas and meta ----------

  takeQuota(bucket: string, limit: number, nowMs: number, windowMs = 3_600_000): boolean {
    const start = Math.floor(nowMs / windowMs) * windowMs;
    const row = this.db.all<{ count: number }>(`SELECT count FROM quotas WHERE bucket=? AND window_start=?`, bucket, start)[0];
    if ((row?.count ?? 0) >= limit) return false;
    this.db.run(`INSERT INTO quotas (bucket, window_start, count) VALUES (?,?,1) ON CONFLICT(bucket, window_start) DO UPDATE SET count=count+1`, bucket, start);
    this.db.run(`DELETE FROM quotas WHERE window_start < ?`, start - windowMs);
    return true;
  }

  meta(key: string, init: () => string): string {
    const r = this.db.all<{ value: string }>(`SELECT value FROM meta WHERE key=?`, key)[0];
    if (r) return r.value;
    const v = init();
    this.db.run(`INSERT INTO meta (key, value) VALUES (?, ?)`, key, v);
    return v;
  }

  /** Progress counters and the activity since `after`, from cheap aggregate queries. */
  live(runId: string, after: number, limit = 40): LiveProgress | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const c = this.db.all<{ declined: number; inProgress: number; recovered: number; recoveredCents: number; simNow: number | null }>(
      `SELECT COUNT(*) AS declined, SUM(status='recovering') AS inProgress, SUM(status='recovered') AS recovered,
              SUM(CASE WHEN status='recovered' THEN amount_cents ELSE 0 END) AS recoveredCents, MAX(now) AS simNow
       FROM payments WHERE run_id=? AND first_decline_at IS NOT NULL`, runId,
    )[0]!;
    const attempts = this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM attempts WHERE run_id=? AND step<>'initial'`, runId)[0]!.n;
    const rows = this.db.all<ActivityRow>(`SELECT * FROM activity WHERE run_id=? AND id>? ORDER BY id DESC LIMIT ?`, runId, after, limit).reverse();
    const cursor = this.db.all<{ m: number | null }>(`SELECT MAX(id) AS m FROM activity WHERE run_id=?`, runId)[0]!.m ?? 0;
    return {
      status: run.status,
      declined: c.declined ?? 0,
      settled: (c.declined ?? 0) - (c.inProgress ?? 0),
      inProgress: c.inProgress ?? 0,
      recovered: c.recovered ?? 0,
      recoveredCents: c.recoveredCents ?? 0,
      attempts,
      simNow: c.simNow ?? 0,
      activity: rows,
      cursor,
    };
  }

  private activity(runId: string, paymentId: string, at: number, kind: string, text: string): void {
    this.db.run(`INSERT INTO activity (run_id, payment_id, at, kind, text) VALUES (?,?,?,?,?)`, runId, paymentId, at, kind, text);
  }

  private event(paymentId: string, step: string, runId: string, at: number, type: string, detail: unknown): void {
    this.db.run(`INSERT OR IGNORE INTO events (payment_id, step, run_id, at, type, detail) VALUES (?,?,?,?,?,?)`, paymentId, step, runId, at, type, JSON.stringify(detail));
  }
}

export interface Incident {
  kind: "psp_outage" | "issuer_outage";
  subject: string;
  from: number;
  to: number;
  affected: number;
  recovered: number;
  text: string;
}

export interface BaselineLike {
  declines: number;
  recovered: number;
  recoveredCents: number;
  declinedCents: number;
  retries: number;
  neverRetryViolations: number;
}

export interface RunSummary {
  runId: string;
  status: string;
  renewals: number;
  approvedFirstTime: number;
  declined: number;
  declinedCents: number;
  recovered: number;
  recoveredCents: number;
  recoveryRateByAmount: number;
  inProgress: number;
  retries: number;
  altPspRetries: number;
  customersAsked: number;
  byPath: Record<string, { count: number; cents: number }>;
  prevention: { tokenLifecycle: number; accountUpdater: number };
  credentialTypes: { networkToken: number; panFallback: number };
  naive: BaselineLike;
  legacy: BaselineLike & { approvedFirst: number; renewals: number };
  /** Guardrail violations found by the audit when the run completed (null while running). */
  violations: number | null;
}

function refreshedExpiry(expiry: string): string {
  return `${expiry.slice(0, 3)}${String(Number(expiry.slice(3)) + 4).padStart(2, "0")}`;
}

/** Customer messages are templates chosen by code, never written by the model. */
export function customerMessage(classification: string | null): string {
  const c = classification ?? "";
  if (c.includes("lost_stolen")) return "Your card was reported lost or stolen, so we could not renew your subscription. Add a new card here to keep your subscription: [update link]";
  if (c.includes("account")) return "Your bank says this card's account is closed or not valid. Add another card here to keep your subscription: [update link]";
  if (c.includes("cat3") || c.includes("mac.01")) return "Your card details need updating (for example a new expiry date). Update them here: [update link]";
  if (c.includes("funds")) return "We could not take your renewal payment. Update your card or try another one here: [update link]";
  return "We could not take your renewal payment with this card. Add another card here to keep your subscription: [update link]";
}

function stopMessage(outcome: string): string {
  if (outcome === "exhausted") return "We could not renew your subscription after several attempts. You can restart it at any time with a new card: [update link]";
  return "We could not renew your subscription with this card. You can restart it at any time with another card: [update link]";
}

export function isCascadeAllowedFor(brand: "visa" | "mastercard", code: string, mac?: string): boolean {
  return isCascadable(classify(brand, code, mac));
}
