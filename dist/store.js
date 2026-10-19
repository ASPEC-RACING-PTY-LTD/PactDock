// Signature records kept as JSON files in a Git repository. One file per
// account (individual) or per entity keeps writes small and conflict-free, and
// Git history provides the audit trail. PactDock only ever appends.
import { entitySlug } from "./signing.js";
import { StoreConflictError } from "./types.js";
export const INDIVIDUAL_SCHEMA = "pactdock/individual@1";
export const ENTITY_SCHEMA = "pactdock/entity@1";
export class RecordError extends Error {
    constructor(path, message) {
        super(`Signature record ${path} is invalid: ${message}`);
        this.name = "RecordError";
    }
}
export function individualPath(directory, agreement, accountId) {
    return `${directory}/individual/${agreement.id}/${accountId}.json`;
}
export function entityDirectory(directory, agreement) {
    return `${directory}/entity/${agreement.id}`;
}
function isAccount(value) {
    const v = value;
    return typeof v === "object" && v !== null && Number.isSafeInteger(v.id) && v.id > 0 && typeof v.login === "string";
}
function checkEntries(path, list) {
    if (!Array.isArray(list))
        throw new RecordError(path, "signatures must be an array");
    for (const entry of list) {
        if (typeof entry !== "object" ||
            entry === null ||
            typeof entry.agreementId !== "string" ||
            typeof entry.version !== "string" ||
            typeof entry.signedAt !== "string" ||
            !isAccount(entry.signer) ||
            typeof entry.evidence !== "object") {
            throw new RecordError(path, "malformed signature entry");
        }
    }
    return list;
}
export function parseIndividual(path, text, expectedId) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw new RecordError(path, "not valid JSON");
    }
    if (raw?.schema !== INDIVIDUAL_SCHEMA)
        throw new RecordError(path, "unknown schema");
    if (!isAccount(raw.account) || raw.account.id !== expectedId)
        throw new RecordError(path, "account does not match file name");
    checkEntries(path, raw.signatures);
    // A record may only contain the account's own signatures.
    if (raw.signatures.some((s) => s.signer.id !== expectedId))
        throw new RecordError(path, "contains a signature by another account");
    return raw;
}
export function parseEntity(path, text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw new RecordError(path, "not valid JSON");
    }
    if (raw?.schema !== ENTITY_SCHEMA)
        throw new RecordError(path, "unknown schema");
    if (typeof raw.entityName !== "string" || !raw.entityName)
        throw new RecordError(path, "entityName missing");
    if (!["pending", "active", "revoked"].includes(raw.status))
        throw new RecordError(path, "status must be pending, active or revoked");
    if (!Array.isArray(raw.authorisedAccounts) || !raw.authorisedAccounts.every(isAccount)) {
        throw new RecordError(path, "authorisedAccounts must be a list of {id, login}");
    }
    checkEntries(path, raw.signatures);
    return raw;
}
/** True if the record holds a signature for one of the accepted versions of this agreement. */
export function hasValidSignature(signatures, agreement) {
    return signatures.find((s) => s.agreementId === agreement.id && agreement.acceptedVersions.includes(s.version)) ?? null;
}
export class SignatureStore {
    #port;
    #directory;
    #entityCache = null;
    constructor(port, directory) {
        this.#port = port;
        this.#directory = directory;
    }
    get label() {
        return this.#port.label;
    }
    async getIndividual(agreement, accountId) {
        const path = individualPath(this.#directory, agreement, accountId);
        const file = await this.#port.read(path);
        return file ? parseIndividual(path, file.text, accountId) : null;
    }
    /** All entity records for an agreement (any status). Invalid files fail closed. */
    async getEntities(agreement) {
        this.#entityCache ??= new Map();
        const cached = this.#entityCache.get(agreement.id);
        if (cached)
            return cached;
        const dir = entityDirectory(this.#directory, agreement);
        const names = (await this.#port.list(dir)).filter((n) => n.endsWith(".json"));
        if (names.length > 500)
            throw new Error(`More than 500 entity records in ${dir}; refusing to scan.`);
        const records = [];
        for (const name of names) {
            const path = `${dir}/${name}`;
            const file = await this.#port.read(path);
            if (file)
                records.push(parseEntity(path, file.text));
        }
        this.#entityCache.set(agreement.id, records);
        return records;
    }
    /**
     * Appends an individual signature. Idempotent per comment ID. Retries on
     * concurrent modification and never rewrites existing entries.
     */
    async appendIndividual(agreement, account, entry, message) {
        const path = individualPath(this.#directory, agreement, account.id);
        return this.#append(path, message, (text) => {
            const record = text
                ? parseIndividual(path, text, account.id)
                : { schema: INDIVIDUAL_SCHEMA, account, signatures: [] };
            if (isDuplicate(record.signatures, entry))
                return null;
            record.account = account; // keep the latest observed login
            record.signatures.push(entry);
            return record;
        });
    }
    /**
     * Appends an entity signature. New entities start as "pending" until a
     * maintainer verifies the signatory's authority and sets status "active".
     */
    async appendEntity(agreement, entityName, entry, message) {
        const path = `${entityDirectory(this.#directory, agreement)}/${entitySlug(entityName)}.json`;
        this.#entityCache = null;
        return this.#append(path, message, (text) => {
            const record = text
                ? parseEntity(path, text)
                : { schema: ENTITY_SCHEMA, entityName, status: "pending", signatures: [], authorisedAccounts: [] };
            if (record.entityName.toLowerCase() !== entityName.toLowerCase()) {
                throw new Error(`An entity record named "${record.entityName}" already uses the identifier for "${entityName}". A maintainer must resolve this.`);
            }
            if (isDuplicate(record.signatures, entry))
                return null;
            record.signatures.push(entry);
            // Proposed only: coverage starts when a maintainer sets status "active".
            if (!record.authorisedAccounts.some((a) => a.id === entry.signer.id))
                record.authorisedAccounts.push(entry.signer);
            return record;
        });
    }
    async #append(path, message, update) {
        for (let attempt = 1; attempt <= 4; attempt++) {
            const file = await this.#port.read(path);
            const next = update(file?.text ?? null);
            if (!next)
                return "duplicate";
            try {
                await this.#port.write(path, JSON.stringify(next, null, 2) + "\n", file?.sha ?? null, message);
                return "recorded";
            }
            catch (err) {
                if (!(err instanceof StoreConflictError) || attempt === 4)
                    throw err;
            }
        }
        throw new Error("unreachable");
    }
}
function isDuplicate(existing, entry) {
    return entry.evidence.commentId !== undefined && existing.some((s) => s.evidence.commentId === entry.evidence.commentId);
}
