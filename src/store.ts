// Signature records kept as JSON files in a Git repository. One file per
// account (individual) or per entity keeps writes small and conflict-free, and
// Git history provides the audit trail. PactDock only ever appends.

import type { AgreementConfig } from "./config.ts";
import { entitySlug } from "./signing.ts";
import { StoreConflictError, type Account, type StorePort } from "./types.ts";

export const INDIVIDUAL_SCHEMA = "pactdock/individual@1";
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
  signatures: SignatureEntry[];
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

export function individualPath(directory: string, agreement: AgreementConfig, accountId: number): string {
  return `${directory}/individual/${agreement.id}/${accountId}.json`;
}

export function entityDirectory(directory: string, agreement: AgreementConfig): string {
  return `${directory}/entity/${agreement.id}`;
}

function isAccount(value: unknown): value is Account {
  const v = value as Account;
  return typeof v === "object" && v !== null && Number.isSafeInteger(v.id) && v.id > 0 && typeof v.login === "string";
}

function checkEntries(path: string, list: unknown): SignatureEntry[] {
  if (!Array.isArray(list)) throw new RecordError(path, "signatures must be an array");
  for (const entry of list as SignatureEntry[]) {
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
  }
  return list as SignatureEntry[];
}

export function parseIndividual(path: string, text: string, expectedId: number): IndividualRecord {
  let raw: IndividualRecord;
  try {
    raw = JSON.parse(text) as IndividualRecord;
  } catch {
    throw new RecordError(path, "not valid JSON");
  }
  if (raw?.schema !== INDIVIDUAL_SCHEMA) throw new RecordError(path, "unknown schema");
  if (!isAccount(raw.account) || raw.account.id !== expectedId) throw new RecordError(path, "account does not match file name");
  checkEntries(path, raw.signatures);
  // A record may only contain the account's own signatures.
  if (raw.signatures.some((s) => s.signer.id !== expectedId)) throw new RecordError(path, "contains a signature by another account");
  return raw;
}

export function parseEntity(path: string, text: string): EntityRecord {
  let raw: EntityRecord;
  try {
    raw = JSON.parse(text) as EntityRecord;
  } catch {
    throw new RecordError(path, "not valid JSON");
  }
  if (raw?.schema !== ENTITY_SCHEMA) throw new RecordError(path, "unknown schema");
  if (typeof raw.entityName !== "string" || !raw.entityName) throw new RecordError(path, "entityName missing");
  if (!["pending", "active", "revoked"].includes(raw.status)) throw new RecordError(path, "status must be pending, active or revoked");
  if (!Array.isArray(raw.authorisedAccounts) || !raw.authorisedAccounts.every(isAccount)) {
    throw new RecordError(path, "authorisedAccounts must be a list of {id, login}");
  }
  checkEntries(path, raw.signatures);
  return raw;
}

/** True if the record holds a signature for one of the accepted versions of this agreement. */
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

  async getIndividual(agreement: AgreementConfig, accountId: number): Promise<IndividualRecord | null> {
    const path = individualPath(this.#directory, agreement, accountId);
    const file = await this.#port.read(path);
    return file ? parseIndividual(path, file.text, accountId) : null;
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

  /**
   * Appends an individual signature. Idempotent per comment ID. Retries on
   * concurrent modification and never rewrites existing entries.
   */
  async appendIndividual(agreement: AgreementConfig, account: Account, entry: SignatureEntry, message: string): Promise<"recorded" | "duplicate"> {
    const path = individualPath(this.#directory, agreement, account.id);
    return this.#append(path, message, (text) => {
      const record: IndividualRecord = text
        ? parseIndividual(path, text, account.id)
        : { schema: INDIVIDUAL_SCHEMA, account, signatures: [] };
      if (isDuplicate(record.signatures, entry)) return null;
      record.account = account; // keep the latest observed login
      record.signatures.push(entry);
      return record;
    });
  }

  /**
   * Appends an entity signature. New entities start as "pending" until a
   * maintainer verifies the signatory's authority and sets status "active".
   */
  async appendEntity(agreement: AgreementConfig, entityName: string, entry: SignatureEntry, message: string): Promise<"recorded" | "duplicate"> {
    const path = `${entityDirectory(this.#directory, agreement)}/${entitySlug(entityName)}.json`;
    this.#entityCache = null;
    return this.#append(path, message, (text) => {
      const record: EntityRecord = text
        ? parseEntity(path, text)
        : { schema: ENTITY_SCHEMA, entityName, status: "pending", signatures: [], authorisedAccounts: [] };
      if (record.entityName.toLowerCase() !== entityName.toLowerCase()) {
        throw new Error(`An entity record named "${record.entityName}" already uses the identifier for "${entityName}". A maintainer must resolve this.`);
      }
      if (isDuplicate(record.signatures, entry)) return null;
      record.signatures.push(entry);
      // Proposed only: coverage starts when a maintainer sets status "active".
      if (!record.authorisedAccounts.some((a) => a.id === entry.signer.id)) record.authorisedAccounts.push(entry.signer);
      return record;
    });
  }

  async #append(path: string, message: string, update: (text: string | null) => object | null): Promise<"recorded" | "duplicate"> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const file = await this.#port.read(path);
      const next = update(file?.text ?? null);
      if (!next) return "duplicate";
      try {
        await this.#port.write(path, JSON.stringify(next, null, 2) + "\n", file?.sha ?? null, message);
        return "recorded";
      } catch (err) {
        if (!(err instanceof StoreConflictError) || attempt === 4) throw err;
      }
    }
    throw new Error("unreachable");
  }
}

function isDuplicate(existing: SignatureEntry[], entry: SignatureEntry): boolean {
  return entry.evidence.commentId !== undefined && existing.some((s) => s.evidence.commentId === entry.evidence.commentId);
}
