// Write-once signature records. Each signature is one JSON file, created once
// and never modified by PactDock:
//
//   <dir>/individual/<agreementId>/<version>/<accountId>.json
//   <dir>/entity/<agreementId>/<entity-slug>.json   (maintainers activate these)
//
// Because a record is never rewritten, the signed terms of a record can never
// change retroactively, and concurrent signers cannot overwrite each other.

import type { AgreementConfig } from "./config.ts";
import { entitySlug } from "./signing.ts";
import type { Account, StorePort } from "./types.ts";

export const INDIVIDUAL_SCHEMA = "pactdock/individual@2";
export const ENTITY_SCHEMA = "pactdock/entity@1";

export interface Evidence {
  method: "pull-request-comment" | "manual";
  repository?: string;
  repositoryId?: number;
  pullRequest?: number;
  commentId?: number;
  commentUrl?: string;
  /** Exact comment text and its SHA-256, as delivered by GitHub. */
  commentBody?: string;
  commentSha256?: string;
  workflowRunUrl?: string;
  /** Free text for manual records, e.g. "Signed PDF stored at evidence/acme.pdf". */
  note?: string;
}

export interface SignatureEntry {
  agreementId: string;
  agreementName: string;
  version: string;
  documentPath: string;
  documentSha256: string;
  documentUrl: string;
  /** When the contributor accepted (comment creation time reported by GitHub). */
  signedAt: string;
  /** When PactDock wrote the record. */
  recordedAt: string;
  signer: Account;
  evidence: Evidence;
}

export interface IndividualRecord {
  schema: typeof INDIVIDUAL_SCHEMA;
  account: Account;
  signature: SignatureEntry;
}

export type EntityStatus = "pending" | "active" | "revoked";

export interface EntityRecord {
  schema: typeof ENTITY_SCHEMA;
  entityName: string;
  /** Only "active" entities cover contributors. Maintainers set this after verifying authority. */
  status: EntityStatus;
  signatures: SignatureEntry[];
  /** Accounts the entity has authorised to contribute on its behalf. */
  authorisedAccounts: Account[];
  /** Optional maintainer notes (who approved, when, evidence location). */
  notes?: string;
}

export class RecordError extends Error {
  constructor(path: string, message: string) {
    super(`Signature record ${path} is invalid: ${message}`);
    this.name = "RecordError";
  }
}

export function individualPath(directory: string, agreement: AgreementConfig, version: string, accountId: number): string {
  return `${directory}/individual/${agreement.id}/${version}/${accountId}.json`;
}

export function entityDirectory(directory: string, agreement: AgreementConfig): string {
  return `${directory}/entity/${agreement.id}`;
}

function isAccount(value: unknown): value is Account {
  const v = value as Account;
  return typeof v === "object" && v !== null && Number.isSafeInteger(v.id) && v.id > 0 && typeof v.login === "string";
}

function checkEntry(path: string, entry: SignatureEntry): SignatureEntry {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.agreementId !== "string" ||
    typeof entry.version !== "string" ||
    typeof entry.signedAt !== "string" ||
    !isAccount(entry.signer) ||
    typeof entry.evidence !== "object"
  ) {
    throw new RecordError(path, "malformed signature entry");
  }
  return entry;
}

function parseJson<T>(path: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RecordError(path, "not valid JSON");
  }
}

export function parseIndividual(path: string, text: string, expectedId: number, agreement: AgreementConfig, version: string): IndividualRecord {
  const raw = parseJson<IndividualRecord>(path, text);
  if (raw?.schema !== INDIVIDUAL_SCHEMA) throw new RecordError(path, "unknown schema");
  if (!isAccount(raw.account) || raw.account.id !== expectedId) throw new RecordError(path, "account does not match file name");
  checkEntry(path, raw.signature);
  // A record may only hold the account's own signature for the agreement and version in its path.
  if (raw.signature.signer.id !== expectedId) throw new RecordError(path, "contains a signature by another account");
  if (raw.signature.agreementId !== agreement.id || raw.signature.version !== version) {
    throw new RecordError(path, "agreement or version does not match its location");
  }
  return raw;
}

export function parseEntity(path: string, text: string): EntityRecord {
  const raw = parseJson<EntityRecord>(path, text);
  if (raw?.schema !== ENTITY_SCHEMA) throw new RecordError(path, "unknown schema");
  if (typeof raw.entityName !== "string" || !raw.entityName) throw new RecordError(path, "entityName missing");
  if (!["pending", "active", "revoked"].includes(raw.status)) throw new RecordError(path, "status must be pending, active or revoked");
  if (!Array.isArray(raw.authorisedAccounts) || !raw.authorisedAccounts.every(isAccount)) {
    throw new RecordError(path, "authorisedAccounts must be a list of {id, login}");
  }
  if (!Array.isArray(raw.signatures)) throw new RecordError(path, "signatures must be an array");
  raw.signatures.forEach((s) => checkEntry(path, s));
  return raw;
}

/** True if the signatures include one for an accepted version of this agreement. */
export function hasValidSignature(signatures: SignatureEntry[], agreement: AgreementConfig): SignatureEntry | null {
  return signatures.find((s) => s.agreementId === agreement.id && agreement.acceptedVersions.includes(s.version)) ?? null;
}

export class SignatureStore {
  readonly #port: StorePort;
  readonly #directory: string;
  #entityCache: Map<string, EntityRecord[]> | null = null;

  constructor(port: StorePort, directory: string) {
    this.#port = port;
    this.#directory = directory;
  }

  get label(): string {
    return this.#port.label;
  }

  /** The account's signature for the newest accepted version that has one, or null. */
  async getIndividual(agreement: AgreementConfig, accountId: number): Promise<SignatureEntry | null> {
    for (const version of [...agreement.acceptedVersions].reverse()) {
      const path = individualPath(this.#directory, agreement, version, accountId);
      const file = await this.#port.read(path);
      if (file) return parseIndividual(path, file.text, accountId, agreement, version).signature;
    }
    return null;
  }

  /** All entity records for an agreement (any status). Invalid files fail closed. */
  async getEntities(agreement: AgreementConfig): Promise<EntityRecord[]> {
    this.#entityCache ??= new Map();
    const cached = this.#entityCache.get(agreement.id);
    if (cached) return cached;
    const dir = entityDirectory(this.#directory, agreement);
    const names = (await this.#port.list(dir)).filter((n) => n.endsWith(".json"));
    if (names.length > 500) throw new Error(`More than 500 entity records in ${dir}; refusing to scan.`);
    const records: EntityRecord[] = [];
    for (const name of names) {
      const path = `${dir}/${name}`;
      const file = await this.#port.read(path);
      if (file) records.push(parseEntity(path, file.text));
    }
    this.#entityCache.set(agreement.id, records);
    return records;
  }

  /** Records an individual signature for the agreement's current version, exactly once. */
  async recordIndividual(agreement: AgreementConfig, account: Account, entry: SignatureEntry, message: string): Promise<"recorded" | "duplicate"> {
    const path = individualPath(this.#directory, agreement, agreement.version, account.id);
    const record: IndividualRecord = { schema: INDIVIDUAL_SCHEMA, account, signature: entry };
    const result = await this.#port.create(path, JSON.stringify(record, null, 2) + "\n", message);
    return result === "created" ? "recorded" : "duplicate";
  }

  /**
   * Creates a pending entity record. Coverage starts only when a maintainer
   * verifies the signatory's authority and sets status "active". If a record
   * for the entity already exists, nothing is changed.
   */
  async recordEntity(agreement: AgreementConfig, entityName: string, entry: SignatureEntry, message: string): Promise<"recorded" | "duplicate"> {
    const path = `${entityDirectory(this.#directory, agreement)}/${entitySlug(entityName)}.json`;
    this.#entityCache = null;
    const record: EntityRecord = {
      schema: ENTITY_SCHEMA,
      entityName,
      status: "pending",
      signatures: [entry],
      authorisedAccounts: [entry.signer],
    };
    const result = await this.#port.create(path, JSON.stringify(record, null, 2) + "\n", message);
    return result === "created" ? "recorded" : "duplicate";
  }
}
