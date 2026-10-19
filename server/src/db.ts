// Local SQLite database (node:sqlite, built into Node 24). Signed records,
// published agreement versions and the audit log are immutable: triggers abort
// any UPDATE or DELETE on them.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS admins (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  account_type TEXT NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  individual_agreement_id INTEGER REFERENCES agreements(id),
  entity_agreement_id INTEGER REFERENCES agreements(id),
  version_policy TEXT NOT NULL DEFAULT 'current' CHECK (version_policy IN ('current','any')),
  co_authors INTEGER NOT NULL DEFAULT 1,
  committers INTEGER NOT NULL DEFAULT 0,
  comment INTEGER NOT NULL DEFAULT 1,
  allowlist TEXT NOT NULL DEFAULT '[]',
  removed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('individual','entity')),
  name TEXT NOT NULL,
  rights_holder TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agreement_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES agreements(id),
  version TEXT NOT NULL,
  body TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by INTEGER NOT NULL,
  UNIQUE (agreement_id, version)
);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  agreement_version_id INTEGER NOT NULL REFERENCES agreement_versions(id),
  github_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  email TEXT,
  email_hash TEXT,
  entity_name TEXT,
  entity_title TEXT,
  signature_type TEXT NOT NULL CHECK (signature_type IN ('typed','drawn')),
  signature_data TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  ip TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  repository TEXT NOT NULL,
  pull_request INTEGER,
  agreement_sha256 TEXT NOT NULL,
  document_key TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  prev_record_sha256 TEXT NOT NULL,
  record_sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signatures_by_account ON signatures (github_id, agreement_version_id);
CREATE INDEX IF NOT EXISTS signatures_by_email ON signatures (email_hash);

CREATE TABLE IF NOT EXISTS entity_status (
  signature_id TEXT PRIMARY KEY REFERENCES signatures(id),
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  authorised TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS email_identities (
  email_hash TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, github_id)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  repository_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  state TEXT NOT NULL,
  conclusion TEXT,
  pending TEXT NOT NULL DEFAULT '[]',
  comment_id INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, number)
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  emails TEXT NOT NULL DEFAULT '[]',
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('download','recovery')),
  subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TRIGGER IF NOT EXISTS signatures_immutable_u BEFORE UPDATE ON signatures BEGIN SELECT RAISE(ABORT, 'signed records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS signatures_immutable_d BEFORE DELETE ON signatures BEGIN SELECT RAISE(ABORT, 'signed records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS versions_immutable_u BEFORE UPDATE ON agreement_versions BEGIN SELECT RAISE(ABORT, 'published agreement versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS versions_immutable_d BEFORE DELETE ON agreement_versions BEGIN SELECT RAISE(ABORT, 'published agreement versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_immutable_u BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_immutable_d BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
`;

export type Row = Record<string, unknown>;

export interface AgreementRow {
  id: number;
  slug: string;
  kind: "individual" | "entity";
  name: string;
  rights_holder: string;
  created_at: string;
}

export interface VersionRow {
  id: number;
  agreement_id: number;
  version: string;
  body: string;
  sha256: string;
  published_at: string;
}

export interface RepoRow {
  id: number;
  installation_id: number;
  full_name: string;
  enabled: number;
  individual_agreement_id: number | null;
  entity_agreement_id: number | null;
  version_policy: "current" | "any";
  co_authors: number;
  committers: number;
  comment: number;
  allowlist: string;
  removed: number;
}

export interface SignatureRow {
  id: string;
  seq: number;
  agreement_version_id: number;
  github_id: number;
  github_login: string;
  legal_name: string;
  email: string | null;
  email_hash: string | null;
  entity_name: string | null;
  entity_title: string | null;
  signature_type: "typed" | "drawn";
  signature_data: string;
  signed_at: string;
  ip: string;
  user_agent: string;
  repository: string;
  pull_request: number | null;
  agreement_sha256: string;
  document_key: string;
  document_sha256: string;
  prev_record_sha256: string;
  record_sha256: string;
}

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec(SCHEMA);
  }

  close(): void {
    this.sql.close();
  }

  all<T = Row>(query: string, ...params: (string | number | null)[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T = Row>(query: string, ...params: (string | number | null)[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: (string | number | null)[]): { changes: number; lastInsertRowid: number } {
    const r = this.sql.prepare(query).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- settings (values may be encrypted by the caller) ----

  setting(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
  }

  setSetting(key: string, value: string): void {
    this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  audit(actor: string, action: string, detail = ""): void {
    this.run("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)", new Date().toISOString(), actor, action, detail.slice(0, 2000));
  }

  isAdmin(githubId: number): boolean {
    return Boolean(this.get("SELECT 1 FROM admins WHERE github_id = ?", githubId));
  }

  adminCount(): number {
    return Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM admins")?.n ?? 0);
  }

  repo(id: number): RepoRow | undefined {
    return this.get<RepoRow>("SELECT * FROM repositories WHERE id = ?", id);
  }

  agreement(id: number): AgreementRow | undefined {
    return this.get<AgreementRow>("SELECT * FROM agreements WHERE id = ?", id);
  }

  /** Newest published version of an agreement. */
  currentVersion(agreementId: number): VersionRow | undefined {
    return this.get<VersionRow>("SELECT * FROM agreement_versions WHERE agreement_id = ? ORDER BY id DESC LIMIT 1", agreementId);
  }

  version(id: number): VersionRow | undefined {
    return this.get<VersionRow>("SELECT * FROM agreement_versions WHERE id = ?", id);
  }

  signature(id: string): SignatureRow | undefined {
    return this.get<SignatureRow>("SELECT * FROM signatures WHERE id = ?", id);
  }

  lastSignature(): SignatureRow | undefined {
    return this.get<SignatureRow>("SELECT * FROM signatures ORDER BY seq DESC LIMIT 1");
  }

  /** Purges expired sessions, links, OAuth states and old delivery IDs. */
  cleanup(now = new Date()): void {
    const iso = now.toISOString();
    this.run("DELETE FROM sessions WHERE expires_at < ?", iso);
    this.run("DELETE FROM links WHERE expires_at < ?", iso);
    this.run("DELETE FROM oauth_states WHERE expires_at < ?", iso);
    this.run("DELETE FROM deliveries WHERE received_at < ?", new Date(now.getTime() - 7 * 864e5).toISOString());
  }
}
