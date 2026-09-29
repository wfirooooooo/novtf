import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function dataDir(): string {
  return process.env.NOVTF_DATA_DIR ?? "/var/lib/novtf";
}

export function ensureDataDirs(): { root: string; dbFile: string; work: string; pluginCache: string; backups: string } {
  const root = dataDir();
  const work = join(root, "work");
  const pluginCache = join(root, "plugin-cache");
  const backups = join(root, "backups");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  mkdirSync(pluginCache, { recursive: true, mode: 0o700 });
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  return { root, dbFile: join(root, "novtf.sqlite"), work, pluginCache, backups };
}
