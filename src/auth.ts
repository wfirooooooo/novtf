import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashPassword, verifyPassword } from "./password.ts";

export type Role = "admin" | "operator" | "auditor";

export interface SessionUser {
  sessionId: string;
  userId: number;
  username: string;
  role: Role;
  csrfSecret: string;
}

const SESSION_MS = 12 * 60 * 60 * 1000;
const ROLES = new Set<Role>(["admin", "operator", "auditor"]);

export function isRole(value: string): value is Role {
  return ROLES.has(value as Role);
}

export async function bootstrapAdmin(db: DatabaseSync, password: string | undefined): Promise<void> {
  const row = db.prepare("SELECT COUNT(*) AS n FROM local_user").get() as { n: number };
  if (row.n > 0 || !password) return;
  const passwordHash = await hashPassword(password);
  db.prepare("INSERT INTO local_user (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(passwordHash);
}

export async function createUser(
  db: DatabaseSync,
  username: string,
  password: string,
  role: Role,
): Promise<number> {
  const passwordHash = await hashPassword(password);
  const result = db
    .prepare("INSERT INTO local_user (username, password_hash, role) VALUES (?, ?, ?)")
    .run(username, passwordHash, role);
  return Number(result.lastInsertRowid);
}

export function grantPlatform(db: DatabaseSync, userId: number, platform: string): void {
  db.prepare("INSERT OR IGNORE INTO user_platform_grant (user_id, platform) VALUES (?, ?)").run(userId, platform);
}

export async function login(db: DatabaseSync, username: string, password: string, now = Date.now()): Promise<SessionUser | null> {
  const user = db
    .prepare("SELECT id, username, password_hash, role FROM local_user WHERE username = ?")
    .get(username) as { id: number; username: string; password_hash: string; role: string } | undefined;
  if (!user || !isRole(user.role) || !(await verifyPassword(password, user.password_hash))) return null;
  const sessionId = randomBytes(32).toString("hex");
  const csrfSecret = randomBytes(32).toString("hex");
  const expiresAt = new Date(now + SESSION_MS).toISOString();
  db.prepare("INSERT INTO session (id, user_id, expires_at, csrf_secret) VALUES (?, ?, ?, ?)").run(
    sessionId,
    user.id,
    expiresAt,
    csrfSecret,
  );
  return { sessionId, userId: user.id, username: user.username, role: user.role, csrfSecret };
}

export function readSession(db: DatabaseSync, cookieHeader: string | undefined, now = Date.now()): SessionUser | null {
  const sessionId = readCookie(cookieHeader, "novtf_session");
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT session.id AS session_id, session.expires_at, session.csrf_secret,
              local_user.id AS user_id, local_user.username, local_user.role
       FROM session JOIN local_user ON local_user.id = session.user_id
       WHERE session.id = ?`,
    )
    .get(sessionId) as
    | { session_id: string; expires_at: string; csrf_secret: string; user_id: number; username: string; role: string }
    | undefined;
  if (!row || !isRole(row.role)) return null;
  if (Date.parse(row.expires_at) <= now) {
    db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
    return null;
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    username: row.username,
    role: row.role,
    csrfSecret: row.csrf_secret,
  };
}

export function logout(db: DatabaseSync, sessionId: string): void {
  db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
}

export function cookieHeader(sessionId: string): string {
  return `novtf_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`;
}

export function clearCookieHeader(): string {
  return "novtf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

export function hasPlatformGrant(db: DatabaseSync, userId: number, platform: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM user_platform_grant WHERE user_id = ? AND platform = ?")
    .get(userId, platform) as { ok: number } | undefined;
  return Boolean(row);
}

export function authorizeRun(
  role: Role,
  action: string,
  platformGranted: boolean,
): { ok: true } | { ok: false; status: number; code: string } {
  if (role === "auditor") return { ok: false, status: 403, code: "forbidden" };
  if (action === "destroy" && role !== "admin") return { ok: false, status: 403, code: "destroy_forbidden" };
  if (role === "operator" && !platformGranted) return { ok: false, status: 403, code: "platform_not_granted" };
  return { ok: true };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
