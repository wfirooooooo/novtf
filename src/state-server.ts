import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { masterKeyFromEnv, open, seal, type Sealed } from "./crypto.ts";
import { withImmediate } from "./db.ts";

interface StateRow {
  serial: number;
  ciphertext: Buffer;
  nonce: Buffer;
  wrapped_dek: Buffer;
  dek_nonce: Buffer;
  lock_id: string | null;
  lock_info: string | null;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function authorized(request: IncomingMessage): boolean {
  const expectedUser = process.env.NOVTF_STATE_USER ?? "novtf";
  const expectedPass = process.env.NOVTF_STATE_PASSWORD ?? "";
  if (!expectedPass) return false;
  const header = request.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split < 0) return false;
  const user = decoded.slice(0, split);
  const pass = decoded.slice(split + 1);
  const userOk = user.length === expectedUser.length && timingSafeEqual(Buffer.from(user), Buffer.from(expectedUser));
  const passOk = pass.length === expectedPass.length && timingSafeEqual(Buffer.from(pass), Buffer.from(expectedPass));
  return userOk && passOk;
}

function parseKey(pathname: string): { stackId: string; platform: string; region: string } | null {
  const match = pathname.match(/^\/v1\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { stackId: decodeURIComponent(match[1]), platform: decodeURIComponent(match[2]), region: decodeURIComponent(match[3]) };
}

function load(db: DatabaseSync, key: { stackId: string; platform: string; region: string }): StateRow | undefined {
  return db
    .prepare(
      `SELECT serial, ciphertext, nonce, wrapped_dek, dek_nonce, lock_id, lock_info
       FROM state_object WHERE stack_id = ? AND platform = ? AND region = ?`,
    )
    .get(key.stackId, key.platform, key.region) as StateRow | undefined;
}

export function startState(db: DatabaseSync, host: string, port: number): void {
  const master = masterKeyFromEnv();
  const server = createServer(async (request, response) => {
    if (!authorized(request)) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="novtf"' });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const key = parseKey(url.pathname);
    if (!key) {
      response.writeHead(404);
      response.end();
      return;
    }
    const method = request.method ?? "GET";
    const body = await readBody(request);
    if (method === "LOCK" || (method === "POST" && url.pathname.endsWith("/lock"))) {
      lock(db, key, body.toString("utf8"), response);
      return;
    }
    if (method === "UNLOCK" || (method === "POST" && url.pathname.endsWith("/unlock"))) {
      unlock(db, key, body.toString("utf8"), response);
      return;
    }
    if (method === "GET") {
      const row = load(db, key);
      if (!row) {
        response.writeHead(404);
        response.end();
        return;
      }
      const plain = open(master, {
        ciphertext: Buffer.from(row.ciphertext),
        nonce: Buffer.from(row.nonce),
        wrappedDek: Buffer.from(row.wrapped_dek),
        dekNonce: Buffer.from(row.dek_nonce),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(plain);
      return;
    }
    if (method === "POST") {
      writeState(db, master, key, body, url.searchParams.get("ID"), response);
      return;
    }
    if (method === "DELETE") {
      removeState(db, key, url.searchParams.get("ID"), response);
      return;
    }
    response.writeHead(405);
    response.end();
  });
  server.listen(port, host);
}

function lock(
  db: DatabaseSync,
  key: { stackId: string; platform: string; region: string },
  body: string,
  response: ServerResponse,
): void {
  const info = JSON.parse(body) as { ID?: string };
  const lockId = info.ID;
  if (!lockId) {
    response.writeHead(400);
    response.end();
    return;
  }
  const conflict = withImmediate(db, () => {
    const row = load(db, key);
    if (row?.lock_id && row.lock_id !== lockId) return row.lock_info;
    const now = new Date().toISOString();
    if (row) {
      db.prepare("UPDATE state_object SET lock_id = ?, lock_info = ?, updated_at = ? WHERE stack_id = ? AND platform = ? AND region = ?").run(
        lockId,
        body,
        now,
        key.stackId,
        key.platform,
        key.region,
      );
    } else {
      const empty = seal(masterKeyFromEnv(), Buffer.from("{}"));
      db.prepare(
        `INSERT INTO state_object
         (stack_id, platform, region, serial, ciphertext, nonce, wrapped_dek, dek_nonce, lock_id, lock_info, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key.stackId,
        key.platform,
        key.region,
        empty.ciphertext,
        empty.nonce,
        empty.wrappedDek,
        empty.dekNonce,
        lockId,
        body,
        now,
      );
    }
    return null;
  });
  if (conflict) {
    response.writeHead(423, { "content-type": "application/json" });
    response.end(conflict);
    return;
  }
  response.writeHead(200);
  response.end();
}

function unlock(
  db: DatabaseSync,
  key: { stackId: string; platform: string; region: string },
  body: string,
  response: ServerResponse,
): void {
  const info = JSON.parse(body) as { ID?: string };
  const conflict = withImmediate(db, () => {
    const row = load(db, key);
    if (!row?.lock_id) return null;
    if (row.lock_id !== info.ID) return row.lock_info;
    db.prepare("UPDATE state_object SET lock_id = NULL, lock_info = NULL, updated_at = ? WHERE stack_id = ? AND platform = ? AND region = ?").run(
      new Date().toISOString(),
      key.stackId,
      key.platform,
      key.region,
    );
    return null;
  });
  if (conflict) {
    response.writeHead(423, { "content-type": "application/json" });
    response.end(conflict);
    return;
  }
  response.writeHead(200);
  response.end();
}

function writeState(
  db: DatabaseSync,
  master: Buffer,
  key: { stackId: string; platform: string; region: string },
  body: Buffer,
  lockId: string | null,
  response: ServerResponse,
): void {
  const sealed: Sealed = seal(master, body);
  const conflict = withImmediate(db, () => {
    const row = load(db, key);
    if (row?.lock_id && row.lock_id !== lockId) return row.lock_info;
    const now = new Date().toISOString();
    const serial = (row?.serial ?? 0) + 1;
    if (row) {
      db.prepare(
        `UPDATE state_object
         SET serial = ?, ciphertext = ?, nonce = ?, wrapped_dek = ?, dek_nonce = ?, updated_at = ?
         WHERE stack_id = ? AND platform = ? AND region = ?`,
      ).run(serial, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.dekNonce, now, key.stackId, key.platform, key.region);
    } else {
      db.prepare(
        `INSERT INTO state_object
         (stack_id, platform, region, serial, ciphertext, nonce, wrapped_dek, dek_nonce, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(key.stackId, key.platform, key.region, serial, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.dekNonce, now);
    }
    return null;
  });
  if (conflict) {
    response.writeHead(423, { "content-type": "application/json" });
    response.end(conflict);
    return;
  }
  response.writeHead(200);
  response.end();
}

function removeState(
  db: DatabaseSync,
  key: { stackId: string; platform: string; region: string },
  lockId: string | null,
  response: ServerResponse,
): void {
  const conflict = withImmediate(db, () => {
    const row = load(db, key);
    if (row?.lock_id && row.lock_id !== lockId) return row.lock_info;
    db.prepare("DELETE FROM state_object WHERE stack_id = ? AND platform = ? AND region = ?").run(key.stackId, key.platform, key.region);
    return null;
  });
  if (conflict) {
    response.writeHead(423, { "content-type": "application/json" });
    response.end(conflict);
    return;
  }
  response.writeHead(200);
  response.end();
}
