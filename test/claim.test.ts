import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimNext } from "../src/claim.ts";
import { openDatabase } from "../src/db.ts";

function db() {
  const dir = mkdtempSync(join(tmpdir(), "novtf-"));
  return openDatabase(join(dir, "novtf.sqlite"));
}

function enqueue(database: ReturnType<typeof openDatabase>, id: string, action: string, at: string): void {
  database
    .prepare(
      `INSERT INTO provider_run (id, stack_id, platform, region, action, phase, created_at, updated_at)
       VALUES (?, 'stk_a', 'aws', 'ap-east-1', ?, 'queued', ?, ?)`,
    )
    .run(id, action, at, at);
}

test("plan slot stops at 4 and drift waits behind operator work", () => {
  const database = db();
  for (const id of ["p1", "p2", "p3", "p4", "p5"]) enqueue(database, id, "plan", `2026-09-28T00:00:0${id.at(-1)}Z`);
  enqueue(database, "d1", "drift", "2026-09-28T00:00:00Z");
  const claimed = [claimNext(database), claimNext(database), claimNext(database), claimNext(database)];
  assert.deepEqual(claimed.map((item) => item?.id), ["p1", "p2", "p3", "p4"]);
  assert.equal(claimNext(database), null);
});

test("apply and destroy share two slots", () => {
  const database = db();
  enqueue(database, "a1", "apply", "2026-09-28T00:00:01Z");
  enqueue(database, "d1", "destroy", "2026-09-28T00:00:02Z");
  enqueue(database, "a2", "apply", "2026-09-28T00:00:03Z");
  assert.equal(claimNext(database)?.id, "a1");
  assert.equal(claimNext(database)?.id, "d1");
  assert.equal(claimNext(database), null);
});

test("drift runs when nothing else is queued", () => {
  const database = db();
  enqueue(database, "d1", "drift", "2026-09-28T00:00:01Z");
  const claimed = claimNext(database);
  assert.equal(claimed?.action, "drift");
  assert.equal(claimed?.phase, "planning");
});
