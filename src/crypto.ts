import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const TAG_BYTES = 16;

export function masterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.NOVTF_MASTER_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error("NOVTF_MASTER_KEY must be 64 hex characters");
  }
  return Buffer.from(raw, "hex");
}

export interface Sealed {
  ciphertext: Buffer;
  nonce: Buffer;
  wrappedDek: Buffer;
  dekNonce: Buffer;
}

export function seal(master: Buffer, plain: Buffer): Sealed {
  const dek = randomBytes(32);
  const dekNonce = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", master, dekNonce);
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final(), wrap.getAuthTag()]);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce, wrappedDek: wrapped, dekNonce };
}

export function open(master: Buffer, sealed: Sealed): Buffer {
  const wrap = createDecipheriv("aes-256-gcm", master, sealed.dekNonce);
  wrap.setAuthTag(sealed.wrappedDek.subarray(sealed.wrappedDek.length - TAG_BYTES));
  const dek = Buffer.concat([
    wrap.update(sealed.wrappedDek.subarray(0, sealed.wrappedDek.length - TAG_BYTES)),
    wrap.final(),
  ]);
  const cipher = createDecipheriv("aes-256-gcm", dek, sealed.nonce);
  cipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
  return Buffer.concat([
    cipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)),
    cipher.final(),
  ]);
}
