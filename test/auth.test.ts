import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorizeRun, createUser, grantPlatform, login } from "../src/auth.ts";
import { startApi } from "../src/api.ts";
import { openDatabase } from "../src/db.ts";

function database() {
  const dir = mkdtempSync(join(tmpdir(), "novtf-auth-"));
  return openDatabase(join(dir, "novtf.sqlite"));
}

test("operator without a grant cannot plan, and only admin can destroy", () => {
  assert.equal(authorizeRun("operator", "plan", false).ok, false);
  assert.equal(authorizeRun("operator", "destroy", true).ok, false);
  assert.equal(authorizeRun("auditor", "plan", true).ok, false);
  assert.equal(authorizeRun("admin", "destroy", false).ok, true);
  assert.equal(authorizeRun("operator", "apply", true).ok, true);
});

test("login, enqueue and reject auditor", async () => {
  const db = database();
  process.env.NOVTF_OPERATOR_PASSWORD = "bootstrap-secret";
  const server = await startApi(db, "127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);

  const failed = await fetch(`${base}/provider-runs`, { method: "POST", body: "{}" });
  assert.equal(failed.status, 401);

  const loggedIn = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=bootstrap-secret",
    redirect: "manual",
  });
  assert.equal(loggedIn.status, 302);
  const cookie = String(loggedIn.headers.get("set-cookie")).split(";")[0];
  const home = await fetch(`${base}/`, { headers: { cookie } });
  const html = await home.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);

  const operatorId = await createUser(db, "op", "operator-secret", "operator");
  grantPlatform(db, operatorId, "aws");
  const auditorId = await createUser(db, "aud", "auditor-secret", "auditor");
  assert.ok(auditorId > 0);

  const queued = await fetch(`${base}/provider-runs`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf ?? "" },
    body: JSON.stringify({ id: "run1", stackId: "stk_a", platform: "aws", region: "ap-east-1", action: "plan" }),
  });
  assert.equal(queued.status, 201);

  const opSession = await login(db, "op", "operator-secret");
  assert.ok(opSession);
  const opCookie = `novtf_session=${opSession.sessionId}`;
  const denied = await fetch(`${base}/provider-runs`, {
    method: "POST",
    headers: { cookie: opCookie, "content-type": "application/json", "x-csrf-token": opSession.csrfSecret },
    body: JSON.stringify({ id: "run2", stackId: "stk_a", platform: "azure", region: "eastasia", action: "plan" }),
  });
  assert.equal(denied.status, 403);
  const audSession = await login(db, "aud", "auditor-secret");
  assert.ok(audSession);
  const auditorDenied = await fetch(`${base}/provider-runs`, {
    method: "POST",
    headers: {
      cookie: `novtf_session=${audSession.sessionId}`,
      "content-type": "application/json",
      "x-csrf-token": audSession.csrfSecret,
    },
    body: JSON.stringify({ id: "run4", stackId: "stk_a", platform: "aws", region: "ap-east-1", action: "plan" }),
  });
  assert.equal(auditorDenied.status, 403);
  const destroyDenied = await fetch(`${base}/provider-runs`, {
    method: "POST",
    headers: { cookie: opCookie, "content-type": "application/json", "x-csrf-token": opSession.csrfSecret },
    body: JSON.stringify({ id: "run3", stackId: "stk_a", platform: "aws", region: "ap-east-1", action: "destroy" }),
  });
  assert.equal(destroyDenied.status, 403);

  server.close();
});
