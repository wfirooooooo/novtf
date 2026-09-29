import { DatabaseSync } from "node:sqlite";
import { ensureCatalog } from "./catalog-store.ts";
import { ensureDataDirs } from "./paths.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  csrf_secret TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_platform_grant (
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  PRIMARY KEY (user_id, platform)
);
CREATE TABLE IF NOT EXISTS stack (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stack_selection (
  stack_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  region TEXT NOT NULL,
  services TEXT NOT NULL,
  networks TEXT NOT NULL,
  parameters TEXT NOT NULL,
  PRIMARY KEY (stack_id, platform)
);
CREATE TABLE IF NOT EXISTS provider_run (
  id TEXT PRIMARY KEY,
  stack_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  region TEXT NOT NULL,
  action TEXT NOT NULL,
  phase TEXT NOT NULL,
  container_id TEXT,
  last_error TEXT,
  actor_user_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_run_stack_platform ON provider_run(stack_id, platform);
CREATE INDEX IF NOT EXISTS provider_run_phase ON provider_run(phase);
CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider_run_id, seq)
);
CREATE INDEX IF NOT EXISTS run_log_run_seq ON run_log(provider_run_id, seq);
CREATE TABLE IF NOT EXISTS runtime_status (
  stack_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  address TEXT NOT NULL,
  health TEXT NOT NULL,
  status_raw TEXT,
  cloud_id TEXT,
  checked_at TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stack_id, platform, address)
);
CREATE INDEX IF NOT EXISTS runtime_status_stack_platform ON runtime_status(stack_id, platform);
CREATE TABLE IF NOT EXISTS service_record (
  stack_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  region TEXT NOT NULL,
  address TEXT NOT NULL,
  service TEXT NOT NULL,
  network_name TEXT,
  cloud_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_user_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (stack_id, platform, region, address)
);
CREATE TABLE IF NOT EXISTS catalog_platform (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_service (
  platform_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  group_name TEXT NOT NULL,
  network TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  PRIMARY KEY (platform_id, id)
);
CREATE TABLE IF NOT EXISTS catalog_region (
  platform_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (platform_id, id)
);
CREATE TABLE IF NOT EXISTS catalog_zone (
  platform_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (platform_id, region_id, id)
);
CREATE TABLE IF NOT EXISTS credential (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  auth_kind TEXT NOT NULL,
  partition TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  account_hint TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  dek_nonce BLOB NOT NULL,
  actor_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS credential_platform ON credential(platform, created_at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state_object (
  stack_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  region TEXT NOT NULL,
  serial INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  dek_nonce BLOB NOT NULL,
  lock_id TEXT,
  lock_info TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stack_id, platform, region)
);
`;

export function openDatabase(dbFile?: string): DatabaseSync {
  const file = dbFile ?? ensureDataDirs().dbFile;
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const columns = db.prepare("PRAGMA table_info(provider_run)").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "actor_user_id")) {
    db.exec("ALTER TABLE provider_run ADD COLUMN actor_user_id INTEGER");
  }
  const selectionColumns = db.prepare("PRAGMA table_info(stack_selection)").all() as unknown as Array<{ name: string }>;
  if (!selectionColumns.some((column) => column.name === "zones")) {
    db.exec("ALTER TABLE stack_selection ADD COLUMN zones TEXT NOT NULL DEFAULT '[]'");
  }
  const serviceColumns = db.prepare("PRAGMA table_info(catalog_service)").all() as unknown as Array<{ name: string }>;
  if (!serviceColumns.some((column) => column.name === "config")) {
    db.exec("ALTER TABLE catalog_service ADD COLUMN config TEXT NOT NULL DEFAULT ''");
  }
  const sessionColumns = db.prepare("PRAGMA table_info(session)").all() as unknown as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "compose_draft")) {
    db.exec("ALTER TABLE session ADD COLUMN compose_draft TEXT");
  }
  if (!selectionColumns.some((column) => column.name === "credential_id")) {
    db.exec("ALTER TABLE stack_selection ADD COLUMN credential_id TEXT");
  }
  ensureCatalog(db);
  return db;
}

export function withImmediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
