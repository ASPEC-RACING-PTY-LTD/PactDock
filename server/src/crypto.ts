// Encryption of stored credentials (AES-256-GCM), random tokens, hashing and
// HMAC-signed values. Uses node:crypto only.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** JSON with sorted keys, so hashes of records are reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export class Vault {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("The master key must be 32 bytes.");
    this.#key = key;
  }

  /**
   * Master key from PACTDOCK_MASTER_KEY (base64, 32 bytes). If absent, one is
   * generated in the data directory (0600) with a warning: keeping it outside
   * the data volume is recommended so backups alone cannot decrypt secrets.
   */
  static load(configured: string | undefined, dataDir: string, warn: (m: string) => void): Vault {
    if (configured) {
      const key = Buffer.from(configured, "base64");
      if (key.length !== 32) throw new Error("PACTDOCK_MASTER_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).");
      return new Vault(key);
    }
    const path = join(dataDir, "master.key");
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
      warn(`Generated a master key at ${path}. Move it to PACTDOCK_MASTER_KEY or a Docker secret and back it up separately.`);
    }
    return new Vault(Buffer.from(readFileSync(path, "utf8").trim(), "base64"));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
  }

  decrypt(value: string): string {
    if (!value.startsWith("v1:")) throw new Error("Unknown encrypted value format.");
    const raw = Buffer.from(value.slice(3), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }

  /** HMAC with a key derived from the master key (domain-separated by purpose). */
  mac(purpose: string, data: string): string {
    const key = createHmac("sha256", this.#key).update(`pactdock:${purpose}`).digest();
    return createHmac("sha256", key).update(data).digest("base64url");
  }

  /** Signs a value with an expiry: "<payload>.<exp>.<mac>". */
  sign(purpose: string, payload: string, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000).toString(36);
    return `${payload}.${exp}.${this.mac(purpose, `${payload}.${exp}`)}`;
  }

  /** Returns the payload if the signature is valid and unexpired, otherwise null. */
  verify(purpose: string, token: string, now = new Date()): string | null {
    const last = token.lastIndexOf(".");
    const mid = token.lastIndexOf(".", last - 1);
    if (mid <= 0) return null;
    const payload = token.slice(0, mid);
    const exp = token.slice(mid + 1, last);
    if (!safeEqual(this.mac(purpose, `${payload}.${exp}`), token.slice(last + 1))) return null;
    if (parseInt(exp, 36) * 1000 < now.getTime()) return null;
    return payload;
  }

  /** Keyed hash of an email address, so stored lookups do not reveal addresses. */
  emailHash(email: string): string {
    return this.mac("email", email.trim().toLowerCase());
  }
}

/** Passphrase-based encryption for backups (scrypt + AES-256-GCM). */
export function encryptWithPassphrase(data: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from("PDBK1"), salt, iv, cipher.getAuthTag(), ct]);
}

export function decryptWithPassphrase(blob: Buffer, passphrase: string): Buffer {
  if (blob.subarray(0, 5).toString() !== "PDBK1") throw new Error("Not a PactDock backup file.");
  const salt = blob.subarray(5, 21);
  const iv = blob.subarray(21, 33);
  const tag = blob.subarray(33, 49);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(49)), decipher.final()]);
  } catch {
    throw new Error("Backup could not be decrypted: wrong passphrase or corrupted file.");
  }
}
