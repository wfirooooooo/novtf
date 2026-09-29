import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { masterKeyFromEnv, open, seal } from "./crypto.ts";
import { withImmediate } from "./db.ts";

export type CredentialCode =
  | "platform_unsupported"
  | "auth_kind_unsupported"
  | "aliyun_partition_missing"
  | "assume_role_missing_base_key"
  | "account_hint_required"
  | "account_mismatch"
  | "secret_invalid"
  | "display_name_invalid"
  | "credential_exists"
  | "master_key_missing";

export const CREDENTIAL_TEXT: Record<CredentialCode, string> = {
  platform_unsupported: "目前只保存 AWS、Azure 和阿里云的鉴权",
  auth_kind_unsupported: "这种鉴权方式不能用",
  aliyun_partition_missing: "阿里云要选择国内站或国际站",
  assume_role_missing_base_key: "担任角色必须同时提供基础密钥和角色 ARN",
  account_hint_required: "账号提示不符合该云的格式",
  account_mismatch: "账号提示要和订阅 ID 一致",
  secret_invalid: "密钥字段不完整或格式不对",
  display_name_invalid: "名称最长 40 个字，不能含控制字符",
  credential_exists: "同一份鉴权已经保存过",
  master_key_missing: "这台机器还没有配置主密钥，不能保存",
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AWS_ACCOUNT = /^\d{12}$/;
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,128}$/;
const KEY_ID = /^[A-Za-z0-9]{16,128}$/;
const SECRET = /^[\x21-\x7e]{8,256}$/;
const ALIYUN_ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

export interface CredentialRequest {
  platform?: string;
  auth_kind?: string;
  partition?: string;
  display_name?: string;
  account_hint?: string;
  secret?: Record<string, unknown>;
}

export interface PublicCredential {
  id: string;
  platform: string;
  authKind: string;
  partition: string;
  displayName: string;
  accountHint: string;
  fingerprint: string;
  warning: "" | "static_key";
}

export interface CredentialChoice {
  id: string;
  platform: string;
  label: string;
}

interface Accepted {
  platform: "aws" | "azure" | "aliyun";
  authKind: "static_key" | "assume_role" | "service_principal";
  partition: "" | "cn" | "intl";
  displayName: string;
  accountHint: string;
  secret: Record<string, string | null>;
}

export interface RunnerAuth {
  env: Record<string, string>;
  assumeRole: { roleArn: string; externalId: string | null } | null;
}

type SaveResult = { ok: true; credential: PublicCredential } | { ok: false; code: CredentialCode };

export function saveCredential(db: DatabaseSync, actorUserId: number, request: CredentialRequest, env: NodeJS.ProcessEnv = process.env): SaveResult {
  const accepted = accept(request);
  if (!accepted.ok) return accepted;
  let master;
  try {
    master = masterKeyFromEnv(env);
  } catch {
    return { ok: false, code: "master_key_missing" };
  }
  const fingerprint = fingerprintOf(accepted.value);
  const existing = db.prepare("SELECT id FROM credential WHERE fingerprint = ?").get(fingerprint) as { id: string } | undefined;
  if (existing) return { ok: false, code: "credential_exists" };
  const sealed = seal(master, Buffer.from(JSON.stringify(accepted.value.secret)));
  const id = `cred_${randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  const row = accepted.value;
  withImmediate(db, () => {
    db.prepare(
      `INSERT INTO credential
       (id, platform, auth_kind, partition, display_name, account_hint, fingerprint, key_id, ciphertext, nonce, wrapped_dek, dek_nonce, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'local-1', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      row.platform,
      row.authKind,
      row.partition,
      row.displayName,
      row.accountHint,
      fingerprint,
      sealed.ciphertext,
      sealed.nonce,
      sealed.wrappedDek,
      sealed.dekNonce,
      actorUserId,
      now,
    );
    db.prepare("INSERT INTO audit (actor_user_id, action, detail, created_at) VALUES (?, 'credential_write', ?, ?)").run(
      actorUserId,
      JSON.stringify({ credential_id: id, platform: row.platform, auth_kind: row.authKind, fingerprint }),
      now,
    );
  });
  return { ok: true, credential: publish({ id, platform: row.platform, authKind: row.authKind, partition: row.partition, displayName: row.displayName, accountHint: row.accountHint, fingerprint }) };
}

export function listCredentials(db: DatabaseSync): PublicCredential[] {
  const rows = db
    .prepare(
      `SELECT id, platform, auth_kind, partition, display_name, account_hint, fingerprint
       FROM credential ORDER BY created_at, rowid`,
    )
    .all() as Array<Record<string, string>>;
  return rows.map((row) =>
    publish({
      id: row.id,
      platform: row.platform as Accepted["platform"],
      authKind: row.auth_kind as Accepted["authKind"],
      partition: row.partition as Accepted["partition"],
      displayName: row.display_name,
      accountHint: row.account_hint,
      fingerprint: row.fingerprint,
    }),
  );
}

export function credentialChoices(db: DatabaseSync): CredentialChoice[] {
  return listCredentials(db).map((item) => ({
    id: item.id,
    platform: item.platform,
    label: item.displayName ? `${item.displayName} · ${item.accountHint}` : item.accountHint,
  }));
}

export function credentialPlatform(db: DatabaseSync, id: string): string | null {
  const row = db.prepare("SELECT platform FROM credential WHERE id = ?").get(id) as { platform: string } | undefined;
  return row?.platform ?? null;
}

export function openCredentialSecret(db: DatabaseSync, id: string, env: NodeJS.ProcessEnv = process.env): Record<string, string | null> | null {
  const row = db.prepare("SELECT ciphertext, nonce, wrapped_dek, dek_nonce FROM credential WHERE id = ?").get(id) as
    | { ciphertext: Buffer; nonce: Buffer; wrapped_dek: Buffer; dek_nonce: Buffer }
    | undefined;
  if (!row) return null;
  const plain = open(masterKeyFromEnv(env), {
    ciphertext: Buffer.from(row.ciphertext),
    nonce: Buffer.from(row.nonce),
    wrappedDek: Buffer.from(row.wrapped_dek),
    dekNonce: Buffer.from(row.dek_nonce),
  });
  return JSON.parse(plain.toString("utf8")) as Record<string, string | null>;
}

export function runnerAuth(platform: string, authKind: string, secret: Record<string, string | null>): RunnerAuth {
  if (platform === "aws" && authKind === "static_key") {
    return {
      env: {
        AWS_ACCESS_KEY_ID: String(secret.access_key_id ?? ""),
        AWS_SECRET_ACCESS_KEY: String(secret.secret_access_key ?? ""),
      },
      assumeRole: null,
    };
  }
  if (platform === "aws" && authKind === "assume_role") {
    return {
      env: {},
      assumeRole: { roleArn: String(secret.role_arn ?? ""), externalId: secret.external_id },
    };
  }
  if (platform === "azure" && authKind === "service_principal") {
    return {
      env: {
        ARM_CLIENT_ID: String(secret.client_id ?? ""),
        ARM_CLIENT_SECRET: String(secret.client_secret ?? ""),
        ARM_TENANT_ID: String(secret.tenant_id ?? ""),
        ARM_SUBSCRIPTION_ID: String(secret.subscription_id ?? ""),
      },
      assumeRole: null,
    };
  }
  if (platform === "aliyun" && authKind === "static_key") {
    return {
      env: {
        ALIBABA_CLOUD_ACCESS_KEY_ID: String(secret.access_key_id ?? ""),
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: String(secret.access_key_secret ?? ""),
      },
      assumeRole: null,
    };
  }
  return { env: {}, assumeRole: null };
}

function publish(row: Omit<Accepted, "secret"> & { id: string; fingerprint: string }): PublicCredential {
  return {
    id: row.id,
    platform: row.platform,
    authKind: row.authKind,
    partition: row.partition,
    displayName: row.displayName,
    accountHint: row.accountHint,
    fingerprint: row.fingerprint,
    warning: row.authKind === "static_key" ? "static_key" : "",
  };
}

function accept(request: CredentialRequest): { ok: true; value: Accepted } | { ok: false; code: CredentialCode } {
  const platform = request.platform ?? "";
  if (platform !== "aws" && platform !== "azure" && platform !== "aliyun") return { ok: false, code: "platform_unsupported" };
  const authKind = request.auth_kind ?? "";
  const displayName = (request.display_name ?? "").trim();
  if (displayName && (displayName.length > 40 || /[\u0000-\u001f\u007f]/.test(displayName))) {
    return { ok: false, code: "display_name_invalid" };
  }
  const secret = request.secret ?? {};
  const text = (key: string) => (typeof secret[key] === "string" ? secret[key].trim() : "");
  if (platform === "aws" && authKind === "static_key") {
    const accountHint = (request.account_hint ?? "").trim();
    if (!AWS_ACCOUNT.test(accountHint)) return { ok: false, code: "account_hint_required" };
    const accessKeyId = text("access_key_id");
    const secretAccessKey = text("secret_access_key");
    if (!KEY_ID.test(accessKeyId) || !SECRET.test(secretAccessKey)) return { ok: false, code: "secret_invalid" };
    return { ok: true, value: { platform, authKind, partition: "", displayName, accountHint, secret: { access_key_id: accessKeyId, secret_access_key: secretAccessKey } } };
  }
  if (platform === "aws" && authKind === "assume_role") {
    const accountHint = (request.account_hint ?? "").trim();
    if (!AWS_ACCOUNT.test(accountHint)) return { ok: false, code: "account_hint_required" };
    const accessKeyId = text("access_key_id");
    const secretAccessKey = text("secret_access_key");
    const roleArn = text("role_arn");
    if (!accessKeyId || !secretAccessKey || !roleArn) return { ok: false, code: "assume_role_missing_base_key" };
    if (!KEY_ID.test(accessKeyId) || !SECRET.test(secretAccessKey) || !ROLE_ARN.test(roleArn)) return { ok: false, code: "secret_invalid" };
    const external = text("external_id");
    if (external && !SECRET.test(external)) return { ok: false, code: "secret_invalid" };
    return {
      ok: true,
      value: {
        platform,
        authKind,
        partition: "",
        displayName,
        accountHint,
        secret: { access_key_id: accessKeyId, secret_access_key: secretAccessKey, role_arn: roleArn, external_id: external || null },
      },
    };
  }
  if (platform === "azure" && authKind === "service_principal") {
    const clientId = text("client_id").toLowerCase();
    const tenantId = text("tenant_id").toLowerCase();
    const subscriptionId = text("subscription_id").toLowerCase();
    const clientSecret = text("client_secret");
    if (!GUID.test(clientId) || !GUID.test(tenantId) || !GUID.test(subscriptionId) || !SECRET.test(clientSecret)) {
      return { ok: false, code: "secret_invalid" };
    }
    const hinted = (request.account_hint ?? "").trim().toLowerCase();
    if (hinted && hinted !== subscriptionId) return { ok: false, code: "account_mismatch" };
    return {
      ok: true,
      value: {
        platform,
        authKind,
        partition: "",
        displayName,
        accountHint: subscriptionId,
        secret: { client_id: clientId, client_secret: clientSecret, tenant_id: tenantId, subscription_id: subscriptionId },
      },
    };
  }
  if (platform === "aliyun" && authKind === "static_key") {
    const partition = request.partition ?? "";
    if (partition !== "cn" && partition !== "intl") return { ok: false, code: "aliyun_partition_missing" };
    const accountHint = (request.account_hint ?? "").trim();
    if (!ALIYUN_ACCOUNT.test(accountHint)) return { ok: false, code: "account_hint_required" };
    const accessKeyId = text("access_key_id");
    const accessKeySecret = text("access_key_secret");
    if (!KEY_ID.test(accessKeyId) || !SECRET.test(accessKeySecret)) return { ok: false, code: "secret_invalid" };
    return { ok: true, value: { platform, authKind, partition, displayName, accountHint, secret: { access_key_id: accessKeyId, access_key_secret: accessKeySecret } } };
  }
  if (platform === "aliyun" && !request.partition) return { ok: false, code: "aliyun_partition_missing" };
  return { ok: false, code: "auth_kind_unsupported" };
}

function fingerprintOf(value: Accepted): string {
  const body = canonical({
    platform: value.platform,
    auth_kind: value.authKind,
    partition: value.partition,
    account_hint: value.accountHint,
    secret: value.secret,
  });
  return createHash("sha256").update(body).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
