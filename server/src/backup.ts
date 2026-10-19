// Encrypted backups: a consistent SQLite snapshot plus locally stored signed
// documents, packed into one file and encrypted with a passphrase
// (scrypt + AES-256-GCM). Restore refuses to overwrite existing data.

import { backup as sqliteBackup } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { decryptWithPassphrase, encryptWithPassphrase, randomToken } from "./crypto.ts";
import type { Db } from "./db.ts";

interface Entry {
  name: string;
  data: Buffer;
}

export function pack(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const head = Buffer.alloc(12);
    head.writeUInt32BE(name.length, 0);
    head.writeBigUInt64BE(BigInt(e.data.length), 4);
    parts.push(head, name, e.data);
  }
  return Buffer.concat(parts);
}

export function unpack(buf: Buffer): Entry[] {
  const out: Entry[] = [];
  let i = 0;
  while (i < buf.length) {
    const nameLen = buf.readUInt32BE(i);
    const dataLen = Number(buf.readBigUInt64BE(i + 4));
    i += 12;
    const name = buf.subarray(i, i + nameLen).toString("utf8");
    i += nameLen;
    out.push({ name, data: Buffer.from(buf.subarray(i, i + dataLen)) });
    i += dataLen;
  }
  return out;
}

function walk(dir: string, root: string, out: Entry[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out.push({ name: relative(root, path).split(sep).join("/"), data: readFileSync(path) });
  }
}

/** Creates an encrypted backup file and returns its path. Old backups beyond `keep` are pruned. */
export async function createBackup(db: Db, dataDir: string, outDir: string, passphrase: string, keep: number): Promise<string> {
  if (passphrase.length < 12) throw new Error("PACTDOCK_BACKUP_PASSPHRASE must be at least 12 characters.");
  const tmp = join(tmpdir(), `pactdock-snapshot-${randomToken(8)}.db`);
  try {
    await sqliteBackup(db.sql, tmp);
    const entries: Entry[] = [{ name: "pactdock.db", data: readFileSync(tmp) }];
    walk(join(dataDir, "documents"), dataDir, entries);
    const manifest = { format: "pactdock-backup@1", createdAt: new Date().toISOString(), files: entries.map((e) => e.name) };
    entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) });
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `pactdock-${manifest.createdAt.replace(/[:.]/g, "-")}.pdbk`);
    writeFileSync(file, encryptWithPassphrase(pack(entries), passphrase), { mode: 0o600, flag: "wx" });
    const existing = readdirSync(outDir).filter((f) => /^pactdock-.*\.pdbk$/.test(f)).sort();
    for (const old of existing.slice(0, Math.max(0, existing.length - keep))) rmSync(join(outDir, old));
    return file;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Restores a backup into an empty data directory. */
export function restoreBackup(file: string, passphrase: string, dataDir: string): string[] {
  if (existsSync(join(dataDir, "pactdock.db"))) throw new Error(`${dataDir} already contains a database; restore into an empty data directory.`);
  const entries = unpack(decryptWithPassphrase(readFileSync(file), passphrase));
  const manifest = entries.find((e) => e.name === "manifest.json");
  if (!manifest || (JSON.parse(manifest.data.toString()) as { format: string }).format !== "pactdock-backup@1") throw new Error("Unrecognised backup format.");
  const root = resolve(dataDir);
  const written: string[] = [];
  for (const e of entries) {
    if (e.name === "manifest.json") continue;
    const target = resolve(join(root, e.name));
    if (!target.startsWith(root + sep)) throw new Error(`Backup entry ${e.name} escapes the data directory.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data, { flag: "wx", mode: e.name === "pactdock.db" ? 0o600 : 0o444 });
    written.push(e.name);
  }
  return written;
}
