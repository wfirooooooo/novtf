import type { DatabaseSync } from "node:sqlite";
import { withImmediate } from "./db.ts";

export type RunAction = "plan" | "apply" | "destroy" | "drift";

const PLAN_LIMIT = 4;
const APPLY_LIMIT = 2;
const DRIFT_LIMIT = 1;

export interface ClaimedRun {
  id: string;
  stackId: string;
  platform: string;
  region: string;
  action: RunAction;
  phase: "planning" | "applying" | "destroying";
}

interface QueuedRow {
  id: string;
  stack_id: string;
  platform: string;
  region: string;
  action: string;
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number };
  return row.n;
}

function phaseFor(action: RunAction): ClaimedRun["phase"] {
  if (action === "apply") return "applying";
  if (action === "destroy") return "destroying";
  return "planning";
}

export function claimNext(db: DatabaseSync, now = new Date().toISOString()): ClaimedRun | null {
  return withImmediate(db, () => {
    const plans = count(db, "SELECT COUNT(*) AS n FROM provider_run WHERE action = 'plan' AND phase = 'planning'");
    const applies = count(
      db,
      "SELECT COUNT(*) AS n FROM provider_run WHERE action IN ('apply', 'destroy') AND phase IN ('applying', 'destroying')",
    );
    const drifts = count(db, "SELECT COUNT(*) AS n FROM provider_run WHERE action = 'drift' AND phase = 'planning'");
    const operatorWaiting = count(
      db,
      "SELECT COUNT(*) AS n FROM provider_run WHERE action IN ('plan', 'apply', 'destroy') AND phase IN ('queued', 'planning', 'applying', 'destroying')",
    );
    const queued = db
      .prepare(
        "SELECT id, stack_id, platform, region, action FROM provider_run WHERE phase = 'queued' ORDER BY created_at ASC, id ASC",
      )
      .all() as unknown as QueuedRow[];

    for (const row of queued) {
      const action = row.action as RunAction;
      if (action === "drift") {
        if (operatorWaiting > 0 || drifts >= DRIFT_LIMIT) continue;
      } else if (action === "plan") {
        if (plans >= PLAN_LIMIT) continue;
      } else if (applies >= APPLY_LIMIT) {
        continue;
      }
      const phase = phaseFor(action);
      db.prepare(
        "UPDATE provider_run SET phase = ?, updated_at = ? WHERE id = ? AND phase = 'queued'",
      ).run(phase, now, row.id);
      return {
        id: row.id,
        stackId: row.stack_id,
        platform: row.platform,
        region: row.region,
        action,
        phase,
      };
    }
    return null;
  });
}
