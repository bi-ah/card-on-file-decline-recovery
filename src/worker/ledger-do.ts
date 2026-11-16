// The ledger Durable Object: a thin RPC wrapper over LedgerLogic and its SQLite storage.
// A Durable Object runs one request at a time, so each method is atomic.

import { DurableObject } from "cloudflare:workers";
import { LedgerLogic, type SqlStore } from "../ledger/logic";
import type { Decision, RecoveryEvent } from "../core/types";
import type { AuthResult } from "../sim/world";

/** Plain typed view of the RPC stub (avoids deep stub type instantiation). */
export type LedgerApi = {
  [K in Exclude<keyof Ledger, keyof DurableObject | "logic">]: Ledger[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
};

export function ledgerOf(env: Env): LedgerApi {
  return env.LEDGER.get(env.LEDGER.idFromName("main")) as unknown as LedgerApi;
}

export class Ledger extends DurableObject<Env> {
  private readonly logic: LedgerLogic;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const store: SqlStore = {
      all: <T>(q: string, ...p: unknown[]) => sql.exec(q, ...(p.map((v) => (v === undefined ? null : v)) as never[])).toArray() as T[],
      run: (q: string, ...p: unknown[]) => {
        sql.exec(q, ...(p.map((v) => (v === undefined ? null : v)) as never[]));
      },
    };
    this.logic = new LedgerLogic(store);
    ctx.blockConcurrencyWhile(async () => this.logic.migrate());
  }

  // Runs
  activeRun(nowMs: number) {
    return this.logic.activeRun(nowMs) ?? null;
  }
  createRun(p: Parameters<LedgerLogic["createRun"]>[0], keep: number) {
    const run = this.logic.createRun(p);
    this.logic.pruneRuns(keep);
    return run;
  }
  startRecovery(runId: string, nowMs: number) {
    return this.logic.startRecovery(runId, nowMs);
  }
  getRun(runId: string) {
    return this.logic.getRun(runId) ?? null;
  }
  listRuns(limit: number) {
    return this.logic.listRuns(limit);
  }
  summary(runId: string) {
    const run = this.logic.getRun(runId);
    if (!run) return null;
    return run.status === "completed" && run.summary_json ? JSON.parse(run.summary_json) : this.logic.summary(runId);
  }

  // Recovery steps (called from the Workflow)
  initialEvent(paymentId: string): RecoveryEvent {
    return this.logic.initialEvent(paymentId);
  }
  decide(paymentId: string, step: string, event: RecoveryEvent): Decision {
    return this.logic.decide(paymentId, step, event);
  }
  reserve(paymentId: string, step: string, d: Decision) {
    return this.logic.reserve(paymentId, step, d);
  }
  simulatePsp(paymentId: string, step: string): AuthResult {
    return this.logic.simulatePsp(paymentId, step);
  }
  record(paymentId: string, step: string, r: AuthResult): void {
    this.logic.record(paymentId, step, r);
  }
  updateCredential(paymentId: string, step: string, at: number) {
    return this.logic.updateCredential(paymentId, step, at);
  }
  askCustomer(paymentId: string, step: string, at: number) {
    return this.logic.askCustomer(paymentId, step, at);
  }
  customerUpdated(paymentId: string, step: string, at: number): void {
    this.logic.customerUpdated(paymentId, step, at);
  }
  finish(paymentId: string, d: Decision | null, at: number): void {
    this.logic.finish(paymentId, d, at);
  }

  // Reads (operator page and chat tools)
  exportRun(runId: string) {
    return this.logic.exportRun(runId);
  }
  listPayments(runId: string, f: Parameters<LedgerLogic["listPayments"]>[1]) {
    return this.logic.listPayments(runId, f);
  }
  timeline(paymentId: string) {
    try {
      return this.logic.timeline(paymentId);
    } catch {
      return null;
    }
  }
  live(runId: string, after: number) {
    return this.logic.live(runId, after);
  }
  incidents(runId: string) {
    return this.logic.incidents(runId);
  }
  breakdown(runId: string, by: Parameters<LedgerLogic["breakdown"]>[1]) {
    return this.logic.breakdown(runId, by);
  }
  chatHistory(runId: string, limit: number) {
    return this.logic.chatHistory(runId, limit);
  }
  addChat(runId: string, role: string, content: string, tools: unknown, nowMs: number): void {
    this.logic.addChat(runId, role, content, tools, nowMs);
  }

  /** Take every quota or none: checked and counted in one atomic call. */
  takeQuotas(buckets: Array<{ bucket: string; limit: number }>, nowMs: number): boolean {
    const start = Math.floor(nowMs / 3_600_000) * 3_600_000;
    const ok = buckets.every(({ bucket, limit }) => {
      const row = this.ctx.storage.sql.exec(`SELECT count FROM quotas WHERE bucket=? AND window_start=?`, bucket, start).toArray()[0] as { count: number } | undefined;
      return (row?.count ?? 0) < limit;
    });
    if (!ok) return false;
    for (const { bucket, limit } of buckets) this.logic.takeQuota(bucket, limit, nowMs);
    return true;
  }

  /** A random salt for hashing IP addresses, created once and kept only in this object. */
  ipSalt(): string {
    return this.logic.meta("ip_salt", () => crypto.randomUUID());
  }
}
