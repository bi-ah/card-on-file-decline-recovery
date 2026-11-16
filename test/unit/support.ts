import { DatabaseSync } from "node:sqlite";
import { LedgerLogic, type SqlStore } from "../../src/ledger/logic";

const norm = (v: unknown) => (v === undefined ? null : v);

/** The real ledger logic over an in-memory SQLite database (node:sqlite). */
export function memoryLedger(): LedgerLogic {
  const db = new DatabaseSync(":memory:");
  const store: SqlStore = {
    all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p.map(norm) as never[])) as T[],
    run: (sql: string, ...p: unknown[]) => {
      db.prepare(sql).run(...(p.map(norm) as never[]));
    },
  };
  const l = new LedgerLogic(store);
  l.migrate();
  return l;
}
