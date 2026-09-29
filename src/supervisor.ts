import type { DatabaseSync } from "node:sqlite";
import { writeBackup } from "./backup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runSupervisor(db: DatabaseSync, backupDir: string): Promise<void> {
  let lastBackup = 0;
  console.log("queued runs stay queued until a runner image is launched");
  for (;;) {
    const now = Date.now();
    if (now - lastBackup >= DAY_MS) {
      const file = await writeBackup(db, backupDir);
      console.log(`backup ${file}`);
      lastBackup = now;
    }
    await new Promise((resolve) => setTimeout(resolve, DAY_MS));
  }
}
