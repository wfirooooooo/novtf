import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";

export async function writeBackup(db: DatabaseSync, backupDir: string, now = new Date()): Promise<string> {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().slice(0, 10);
  const destination = join(backupDir, `novtf-${stamp}.sqlite`);
  await backup(db, destination);
  return destination;
}
