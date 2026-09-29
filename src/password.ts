import { randomBytes, timingSafeEqual } from "node:crypto";
import { argon2id } from "hash-wasm";

const MEMORY_KIB = 19456;
const ITERATIONS = 2;
const PARALLELISM = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2id({
    password,
    salt,
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: 32,
    outputType: "binary",
  });
  return `${salt.toString("hex")}:${Buffer.from(hash).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const actual = await argon2id({
    password,
    salt: Buffer.from(saltHex, "hex"),
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: 32,
    outputType: "binary",
  });
  const expected = Buffer.from(hashHex, "hex");
  const got = Buffer.from(actual);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
