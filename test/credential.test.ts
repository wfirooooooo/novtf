import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startApi } from "../src/api.ts";
import { createUser, login } from "../src/auth.ts";
import { openCredentialSecret, runnerAuth, saveCredential } from "../src/credential.ts";
import { openDatabase } from "../src/db.ts";
import { renderTerraform } from "../src/render.ts";

const MASTER = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const ENV = { ...process.env, NOVTF_MASTER_KEY: MASTER };

function database() {
  const dir = mkdtempSync(join(tmpdir(), "novtf-cred-"));
  return openDatabase(join(dir, "novtf.sqlite"));
}

test("rejects incomplete cloud credentials before writing", () => {
  const db = database();
  assert.equal(saveCredential(db, 1, { platform: "gcp", auth_kind: "static_key" }, ENV).ok, false);
  const missingRole = saveCredential(
    db,
    1,
    { platform: "aws", auth_kind: "assume_role", account_hint: "123456789012", secret: { role_arn: "arn:aws:iam::123456789012:role/novtf" } },
    ENV,
  );
  assert.equal(missingRole.ok, false);
  if (!missingRole.ok) assert.equal(missingRole.code, "assume_role_missing_base_key");
  const missingPartition = saveCredential(db, 1, { platform: "aliyun", auth_kind: "static_key", account_hint: "1001", secret: {} }, ENV);
  assert.equal(missingPartition.ok, false);
  if (!missingPartition.ok) assert.equal(missingPartition.code, "aliyun_partition_missing");
  const federated = saveCredential(db, 1, { platform: "azure", auth_kind: "federated", secret: {} }, ENV);
  assert.equal(federated.ok, false);
  if (!federated.ok) assert.equal(federated.code, "auth_kind_unsupported");
  const count = db.prepare("SELECT COUNT(*) AS n FROM credential").get() as { n: number };
  assert.equal(count.n, 0);
});

test("seals the secret and builds runner environment without calling a cloud", () => {
  const db = database();
  const saved = saveCredential(
    db,
    1,
    {
      platform: "aws",
      auth_kind: "static_key",
      display_name: "sandbox",
      account_hint: "123456789012",
      secret: { access_key_id: "AKIAIOSFODNN7EXAMPLE", secret_access_key: AWS_SECRET },
    },
    ENV,
  );
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.credential.warning, "static_key");
  assert.equal(JSON.stringify(saved.credential).includes(AWS_SECRET), false);
  const secret = openCredentialSecret(db, saved.credential.id, ENV);
  assert.equal(secret?.secret_access_key, AWS_SECRET);
  const stored = db.prepare("SELECT ciphertext, account_hint FROM credential WHERE id = ?").get(saved.credential.id) as {
    ciphertext: Buffer;
    account_hint: string;
  };
  assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from(AWS_SECRET)), false);
  assert.equal(stored.account_hint, "123456789012");
  const audit = db.prepare("SELECT detail FROM audit").get() as { detail: string };
  assert.equal(audit.detail.includes(AWS_SECRET), false);
  const again = saveCredential(
    db,
    1,
    {
      platform: "aws",
      auth_kind: "static_key",
      account_hint: "123456789012",
      secret: { access_key_id: "AKIAIOSFODNN7EXAMPLE", secret_access_key: AWS_SECRET },
    },
    ENV,
  );
  assert.equal(again.ok, false);
  const direct = runnerAuth("aws", "static_key", secret ?? {});
  assert.equal(direct.env.AWS_ACCESS_KEY_ID, "AKIAIOSFODNN7EXAMPLE");
  assert.equal(direct.env.AWS_SECRET_ACCESS_KEY, AWS_SECRET);
  const assumed = saveCredential(
    db,
    1,
    {
      platform: "aws",
      auth_kind: "assume_role",
      account_hint: "123456789012",
      secret: {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: AWS_SECRET,
        role_arn: "arn:aws:iam::123456789012:role/novtf",
      },
    },
    ENV,
  );
  assert.equal(assumed.ok, true);
  if (!assumed.ok) return;
  const assumedSecret = openCredentialSecret(db, assumed.credential.id, ENV) ?? {};
  const role = runnerAuth("aws", "assume_role", assumedSecret);
  assert.deepEqual(role.env, {});
  assert.equal(role.assumeRole?.roleArn, "arn:aws:iam::123456789012:role/novtf");
  assert.equal(JSON.stringify(role.env).includes(AWS_SECRET), false);
  const azure = runnerAuth("azure", "service_principal", {
    client_id: "11111111-1111-1111-1111-111111111111",
    client_secret: "azure-secret-value",
    tenant_id: "22222222-2222-2222-2222-222222222222",
    subscription_id: "33333333-3333-3333-3333-333333333333",
  });
  assert.equal(azure.env.ARM_CLIENT_SECRET, "azure-secret-value");
  const aliyun = runnerAuth("aliyun", "static_key", { access_key_id: "LTAI5tExampleKeyId01", access_key_secret: "aliyun-secret-value" });
  assert.equal(aliyun.env.ALIBABA_CLOUD_ACCESS_KEY_ID, "LTAI5tExampleKeyId01");
  assert.equal(aliyun.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, "aliyun-secret-value");
  assert.equal("ALICLOUD_SECRET_KEY" in aliyun.env, false);
  const files = renderTerraform("11111111-1111-1111-1111-111111111111", {
    platform: "aws",
    region: "ap-east-1",
    services: ["aws_compute_vm"],
    networks: [{ name: "app", cidr: "10.1.0.0/16" }],
    zones: [],
    parameters: { aws_compute_vm: { network: "app", config: "small" } },
  });
  assert.equal(files.some((file) => file.body.includes(AWS_SECRET)), false);
});

test("admin can store a credential and other roles cannot read the secret", async () => {
  const db = database();
  process.env.NOVTF_OPERATOR_PASSWORD = "bootstrap-secret";
  process.env.NOVTF_MASTER_KEY = MASTER;
  const server = await startApi(db, "127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const loggedIn = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=bootstrap-secret",
      redirect: "manual",
    });
    const cookie = String(loggedIn.headers.get("set-cookie")).split(";")[0];
    const home = await fetch(`${base}/credentials`, { headers: { cookie } });
    const html = await home.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    assert.match(html, /保存鉴权/);
    const deniedShape = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ platform: "aliyun", auth_kind: "static_key", account_hint: "1001", secret: { access_key_id: "LTAI5tExampleKeyId01" } }),
    });
    assert.equal(deniedShape.status, 422);
    assert.equal((await deniedShape.json()).code, "aliyun_partition_missing");
    const created = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({
        platform: "aws",
        auth_kind: "static_key",
        display_name: "sandbox",
        account_hint: "123456789012",
        secret: { access_key_id: "AKIAIOSFODNN7EXAMPLE", secret_access_key: AWS_SECRET },
      }),
    });
    const payload = (await created.json()) as { id: string; warning?: string; fingerprint?: string };
    assert.equal(created.status, 201);
    assert.equal(payload.warning, "static_key");
    assert.equal(JSON.stringify(payload).includes(AWS_SECRET), false);
    const listed = await fetch(`${base}/api/v1/credentials`, { headers: { cookie } });
    const listBody = await listed.text();
    assert.equal(listBody.includes(AWS_SECRET), false);
    assert.match(listBody, /123456789012/);
    const page = await fetch(`${base}/credentials`, { headers: { cookie } });
    const pageHtml = await page.text();
    assert.equal(pageHtml.includes(AWS_SECRET), false);
    assert.match(pageHtml, /静态密钥长期有效/);
    assert.match(pageHtml, new RegExp(payload.fingerprint ?? ""));
    const kept = await fetch(`${base}/credentials`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf,
        platform: "aws",
        auth_kind: "static_key",
        display_name: "keep-name",
        account_hint: "bad",
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: AWS_SECRET,
      }),
      redirect: "manual",
    });
    const failedLocation = kept.headers.get("location") ?? "";
    assert.match(failedLocation, /error=account_hint_required/);
    assert.equal(failedLocation.includes(AWS_SECRET), false);
    const failedPage = await fetch(new URL(failedLocation, base), { headers: { cookie } });
    const failedHtml = await failedPage.text();
    assert.match(failedHtml, /value="keep-name"/);
    assert.match(failedHtml, /value="AKIAIOSFODNN7EXAMPLE"/);
    assert.equal(failedHtml.includes(AWS_SECRET), false);
    const operatorId = await createUser(db, "op", "operator-secret", "operator");
    assert.ok(operatorId > 0);
    const opSession = await login(db, "op", "operator-secret");
    assert.ok(opSession);
    const opCookie = `novtf_session=${opSession.sessionId}`;
    const opPage = await fetch(`${base}/credentials`, { headers: { cookie: opCookie } });
    const opHtml = await opPage.text();
    assert.match(opHtml, /123456789012/);
    assert.equal(opHtml.includes(AWS_SECRET), false);
    assert.equal(opHtml.includes("secret_access_key"), false);
    assert.equal(opHtml.includes(payload.fingerprint ?? "missing"), false);
    const opWrite = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json", "x-csrf-token": opSession.csrfSecret },
      body: JSON.stringify({ platform: "aws", auth_kind: "static_key" }),
    });
    assert.equal(opWrite.status, 403);
    const bound = await fetch(`${base}/stacks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf,
        stack_name: "with-cred",
        platform: "aws",
        aws_region: "ap-east-1",
        aws_service: "aws_compute_vm",
        aws_net_name: "app",
        aws_aws_compute_vm_network: "1",
        aws_aws_compute_vm_config: "small",
        aws_credential: payload.id,
      }),
      redirect: "manual",
    });
    assert.equal(bound.status, 302);
    const audit = await fetch(new URL(bound.headers.get("location") ?? "/", base), { headers: { cookie } });
    const auditHtml = await audit.text();
    assert.equal(auditHtml.includes(AWS_SECRET), false);
    assert.match(auditHtml, /鉴权 sandbox · 123456789012/);
    const unknown = await fetch(`${base}/stacks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf,
        stack_name: "missing-cred",
        platform: "aws",
        aws_region: "ap-east-1",
        aws_service: "aws_compute_vm",
        aws_net_name: "app",
        aws_aws_compute_vm_network: "1",
        aws_aws_compute_vm_config: "small",
        aws_credential: "cred_missing",
      }),
      redirect: "manual",
    });
    const unknownPage = await fetch(new URL(unknown.headers.get("location") ?? "/", base), { headers: { cookie } });
    const unknownHtml = await unknownPage.text();
    assert.match(unknownHtml, /所选鉴权不存在/);
    assert.match(unknownHtml, /value="missing-cred"/);
    const count = db.prepare("SELECT COUNT(*) AS n FROM stack WHERE name = 'missing-cred'").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    server.close();
  }
});
