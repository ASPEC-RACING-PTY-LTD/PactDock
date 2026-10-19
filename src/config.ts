// PactDock configuration: parsed from a JSON file on the repository's default
// branch (never from the pull request), validated strictly. Unknown keys are
// rejected so a typo cannot silently weaken enforcement.

export interface AgreementConfig {
  /** Stable identifier used in the signature store, e.g. "aspec-icla". */
  id: string;
  /** Human-readable name, used in the signing phrase. */
  name: string;
  /** Current version contributors sign. */
  version: string;
  /** Path of the agreement text in this repository (default branch). */
  document: string;
  /** Optional pin: fail closed if the document's SHA-256 differs. */
  sha256?: string;
  /** Versions whose existing signatures still satisfy the check. Defaults to [version]. */
  acceptedVersions: string[];
}

export interface GitHubStorageConfig {
  type: "github";
  /** "owner/name" of the (preferably private) signature repository, or "self". */
  repository: string;
  /** Branch holding the records. Defaults to the store repository's default branch ("self" requires an explicit branch). */
  branch?: string;
  /** Directory within the store. */
  directory: string;
}

export interface S3StorageConfig {
  type: "s3";
  bucket: string;
  /** "auto" for Cloudflare R2, otherwise an AWS region such as "ap-southeast-2". */
  region: string;
  /** Custom HTTPS endpoint (R2, other S3-compatible services). Omit for Amazon S3. */
  endpoint?: string;
  pathStyle?: boolean;
  /** Key prefix within the bucket. */
  directory: string;
}

export type StorageConfig = GitHubStorageConfig | S3StorageConfig;

export interface DiscordConfig {
  /** "notify": short message per signature. "signature": message plus the full record as a JSON attachment. */
  mode: "notify" | "signature";
}

export interface Config {
  /** Legal name of the party receiving the CLA rights. */
  rightsHolder: string;
  individual: AgreementConfig;
  entity?: AgreementConfig;
  storage: StorageConfig;
  statusContext: string;
  allowlist: { accountIds: number[] };
  coAuthors: boolean;
  committers: boolean;
  comment: boolean;
  /** Optional URL with instructions for entity (company) agreements. */
  entityInstructionsUrl?: string;
  /** Optional Discord logging. The webhook URL itself is a secret action input. */
  discord?: DiscordConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid PactDock configuration: ${message}`);
    this.name = "ConfigError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.\-]{0,31}$/;
const NAME_RE = /^[^\r\n`<>\\]{1,200}$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,200}$/;
const PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]{1,300}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTEXT_RE = /^[A-Za-z0-9 ._:\/()-]{1,100}$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Json, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (key === "$schema" || key === "$comment") continue;
    if (!allowed.includes(key)) throw new ConfigError(`unknown key "${key}" in ${where}.`);
  }
}

function str(obj: Json, key: string, where: string, re: RegExp, required: true): string;
function str(obj: Json, key: string, where: string, re: RegExp, required: false): string | undefined;
function str(obj: Json, key: string, where: string, re: RegExp, required: boolean): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    if (required) throw new ConfigError(`${where}.${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || !re.test(value)) {
    throw new ConfigError(`${where}.${key} has an invalid value.`);
  }
  return value;
}

function bool(obj: Json, key: string, where: string, fallback: boolean): boolean {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${where}.${key} must be true or false.`);
  return value;
}

function parseAgreement(value: unknown, where: string): AgreementConfig {
  if (!isObject(value)) throw new ConfigError(`${where} must be an object.`);
  checkKeys(value, ["id", "name", "version", "document", "sha256", "acceptedVersions"], where);
  const version = str(value, "version", where, VERSION_RE, true);
  let acceptedVersions = [version];
  if (value["acceptedVersions"] !== undefined) {
    const list = value["acceptedVersions"];
    if (!Array.isArray(list) || list.length === 0 || list.length > 50) {
      throw new ConfigError(`${where}.acceptedVersions must be a non-empty array.`);
    }
    for (const v of list) {
      if (typeof v !== "string" || !VERSION_RE.test(v)) throw new ConfigError(`${where}.acceptedVersions has an invalid version.`);
    }
    acceptedVersions = [...new Set(list as string[])];
    if (!acceptedVersions.includes(version)) {
      throw new ConfigError(`${where}.acceptedVersions must include the current version "${version}".`);
    }
  }
  const agreement: AgreementConfig = {
    id: str(value, "id", where, ID_RE, true),
    name: str(value, "name", where, NAME_RE, true),
    version,
    document: str(value, "document", where, PATH_RE, true),
    acceptedVersions,
  };
  const sha = str(value, "sha256", where, SHA256_RE, false);
  if (sha) agreement.sha256 = sha;
  return agreement;
}

export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`file is not valid JSON (${(err as Error).message}).`);
  }
  if (!isObject(raw)) throw new ConfigError("top level must be an object.");
  checkKeys(
    raw,
    ["rightsHolder", "individual", "entity", "storage", "statusContext", "allowlist", "coAuthors", "committers", "comment", "entityInstructionsUrl", "discord"],
    "config",
  );

  const storage = parseStorage(raw["storage"]);

  const allowRaw = raw["allowlist"] ?? {};
  if (!isObject(allowRaw)) throw new ConfigError("allowlist must be an object.");
  checkKeys(allowRaw, ["accountIds"], "allowlist");
  const ids = allowRaw["accountIds"] ?? [];
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)) {
    throw new ConfigError("allowlist.accountIds must be an array of numeric GitHub account IDs.");
  }

  const config: Config = {
    rightsHolder: str(raw, "rightsHolder", "config", NAME_RE, true),
    individual: parseAgreement(raw["individual"], "individual"),
    storage,
    statusContext: str(raw, "statusContext", "config", CONTEXT_RE, false) ?? "PactDock CLA",
    allowlist: { accountIds: ids as number[] },
    coAuthors: bool(raw, "coAuthors", "config", true),
    committers: bool(raw, "committers", "config", false),
    comment: bool(raw, "comment", "config", true),
  };
  if (raw["entity"] !== undefined) {
    config.entity = parseAgreement(raw["entity"], "entity");
    if (config.entity.id === config.individual.id) throw new ConfigError("entity.id must differ from individual.id.");
  }
  const url = str(raw, "entityInstructionsUrl", "config", /^https:\/\/[^\s<>`]{1,500}$/, false);
  if (url) config.entityInstructionsUrl = url;
  if (raw["discord"] !== undefined) {
    const d = raw["discord"];
    if (!isObject(d)) throw new ConfigError("discord must be an object.");
    checkKeys(d, ["mode"], "discord");
    const mode = d["mode"] ?? "notify";
    if (mode !== "notify" && mode !== "signature") throw new ConfigError('discord.mode must be "notify" or "signature".');
    config.discord = { mode };
  }
  return config;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^(auto|[a-z]{2}(-[a-z]+)+-\d)$/;
const ENDPOINT_RE = /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?\/?$/;

function parseStorage(value: unknown): StorageConfig {
  if (!isObject(value)) throw new ConfigError("storage is required.");
  const type = value["type"] ?? "github";
  const directory = str(value, "directory", "storage", PATH_RE, false) ?? "signatures";
  if (type === "s3") {
    checkKeys(value, ["type", "bucket", "region", "endpoint", "pathStyle", "directory"], "storage");
    const s3: S3StorageConfig = {
      type: "s3",
      bucket: str(value, "bucket", "storage", BUCKET_RE, true),
      region: str(value, "region", "storage", REGION_RE, true),
      directory,
    };
    const endpoint = str(value, "endpoint", "storage", ENDPOINT_RE, false);
    if (endpoint) s3.endpoint = endpoint.replace(/\/$/, "");
    if (value["pathStyle"] !== undefined) s3.pathStyle = bool(value, "pathStyle", "storage", true);
    return s3;
  }
  if (type !== "github") throw new ConfigError('storage.type must be "github" or "s3".');
  checkKeys(value, ["type", "repository", "branch", "directory"], "storage");
  const repository = value["repository"];
  if (typeof repository !== "string" || (repository !== "self" && !REPO_RE.test(repository))) {
    throw new ConfigError('storage.repository must be "owner/name" or "self".');
  }
  const storage: GitHubStorageConfig = { type: "github", repository, directory };
  const branch = str(value, "branch", "storage", BRANCH_RE, false);
  if (branch) storage.branch = branch;
  if (repository === "self" && !branch) {
    throw new ConfigError('storage.branch is required when storage.repository is "self" (use a dedicated branch such as "pactdock-signatures").');
  }
  return storage;
}
