import type { DatabaseSync } from "node:sqlite";

const INTERVAL_MS = 60_000;
const STALE_AFTER_MS = INTERVAL_MS * 3;

export function markStale(db: DatabaseSync, now = Date.now()): number {
  const cutoff = new Date(now - STALE_AFTER_MS).toISOString();
  const result = db
    .prepare("UPDATE runtime_status SET stale = 1 WHERE checked_at IS NULL OR checked_at < ?")
    .run(cutoff);
  db.prepare("UPDATE runtime_status SET stale = 0 WHERE checked_at IS NOT NULL AND checked_at >= ?").run(cutoff);
  return Number(result.changes);
}

export async function runCollector(db: DatabaseSync): Promise<void> {
  for (;;) {
    markStale(db);
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}
