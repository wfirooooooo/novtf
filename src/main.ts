import { masterKeyFromEnv } from "./crypto.ts";
import { openDatabase } from "./db.ts";
import { ensureDataDirs } from "./paths.ts";
import { startApi } from "./api.ts";
import { runCollector } from "./collector.ts";
import { startState } from "./state-server.ts";
import { runSupervisor } from "./supervisor.ts";

const role = process.argv[2] ?? process.env.NOVTF_ROLE ?? "api";
const dirs = ensureDataDirs();
const db = openDatabase(dirs.dbFile);

if (role === "api") {
  const host = process.env.NOVTF_API_HOST ?? "127.0.0.1";
  const port = Number(process.env.NOVTF_API_PORT ?? 8080);
  await startApi(db, host, port);
  console.log(`api listening on ${host}:${port}`);
} else if (role === "state") {
  masterKeyFromEnv();
  const host = process.env.NOVTF_STATE_HOST ?? "0.0.0.0";
  const port = Number(process.env.NOVTF_STATE_PORT ?? 8081);
  startState(db, host, port);
  console.log(`state listening on ${host}:${port}`);
} else if (role === "supervisor") {
  await runSupervisor(db, dirs.backups);
} else if (role === "collector") {
  await runCollector(db);
} else {
  throw new Error(`unknown role ${role}`);
}
