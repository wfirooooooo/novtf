import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeBackup } from "../src/backup.ts";
import { open, seal } from "../src/crypto.ts";
import { openDatabase, withImmediate } from "../src/db.ts";

test("seal round trip", () => {
  const master = Buffer.alloc(32, 7);
  const plain = Buffer.from('{"version":4,"serial":1}');
  const sealed = seal(master, plain);
  assert.deepEqual(open(master, sealed), plain);
});

test("state write commits serial and ciphertext together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novtf-"));
  const database = openDatabase(join(dir, "novtf.sqlite"));
  const master = Buffer.alloc(32, 3);
  const sealed = seal(master, Buffer.from('{"serial":1}'));
  withImmediate(database, () => {
    database
      .prepare(
        `INSERT INTO state_object
         (stack_id, platform, region, serial, ciphertext, nonce, wrapped_dek, dek_nonce, updated_at)
         VALUES ('stk_a', 'aws', 'ap-east-1', 1, ?, ?, ?, ?, '2026-09-28T00:00:00Z')`,
      )
      .run(sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.dekNonce);
  });
  const row = database.prepare("SELECT serial, ciphertext, nonce, wrapped_dek, dek_nonce FROM state_object").get() as {
    serial: number;
    ciphertext: Buffer;
    nonce: Buffer;
    wrapped_dek: Buffer;
    dek_nonce: Buffer;
  };
  assert.equal(row.serial, 1);
  assert.equal(
    open(master, {
      ciphertext: Buffer.from(row.ciphertext),
      nonce: Buffer.from(row.nonce),
      wrappedDek: Buffer.from(row.wrapped_dek),
      dekNonce: Buffer.from(row.dek_nonce),
    }).toString(),
    '{"serial":1}',
  );
  const copy = await writeBackup(database, join(dir, "backups"));
  const restored = openDatabase(copy);
  const again = restored.prepare("SELECT serial FROM state_object").get() as { serial: number };
  assert.equal(again.serial, 1);
});
