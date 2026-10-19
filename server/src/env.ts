// PactDock Server settings, read once from environment variables.
// Secrets can be supplied directly or via *_FILE (Docker secrets).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface S3Settings {
  bucket: string;
  region: string;
  endpoint?: string;
  pathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** "tls" = implicit TLS (465), "starttls" = upgrade (587), "none" = plaintext (tests/local relays only). */
  security: "tls" | "starttls" | "none";
  user?: string;
  pass?: string;
  from: string;
}

export interface Settings {
  port: number;
  /** Public HTTPS base URL GitHub and browsers use, e.g. https://cla.example.com */
  publicUrl: string;
  dataDir: string;
  /** One-time token required to start first-run setup. */
  setupToken: string | undefined;
  masterKey: string | undefined;
  trustProxy: boolean;
  githubUrl: string;
  githubApiUrl: string;
  s3: S3Settings | undefined;
  smtp: SmtpSettings | undefined;
  backup: { dir: string; intervalHours: number; keep: number; passphrase: string | undefined };
}

function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const value = env[name];
  return value ? value.trim() : undefined;
}

function url(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use https:// (http is only allowed for localhost).`);
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const publicUrl = env["PACTDOCK_PUBLIC_URL"];
  if (!publicUrl) throw new Error("PACTDOCK_PUBLIC_URL is required (the public https:// address of this server).");
  const dataDir = env["PACTDOCK_DATA_DIR"] ?? "/data";

  let s3: S3Settings | undefined;
  if (env["PACTDOCK_S3_BUCKET"]) {
    const accessKeyId = secret(env, "PACTDOCK_S3_ACCESS_KEY_ID");
    const secretAccessKey = secret(env, "PACTDOCK_S3_SECRET_ACCESS_KEY");
    if (!accessKeyId || !secretAccessKey) throw new Error("PACTDOCK_S3_ACCESS_KEY_ID and PACTDOCK_S3_SECRET_ACCESS_KEY are required with PACTDOCK_S3_BUCKET.");
    s3 = {
      bucket: env["PACTDOCK_S3_BUCKET"],
      region: env["PACTDOCK_S3_REGION"] ?? "auto",
      accessKeyId,
      secretAccessKey,
      prefix: (env["PACTDOCK_S3_PREFIX"] ?? "pactdock").replace(/^\/+|\/+$/g, ""),
    };
    if (env["PACTDOCK_S3_ENDPOINT"]) s3.endpoint = url(env["PACTDOCK_S3_ENDPOINT"], "PACTDOCK_S3_ENDPOINT");
    if (env["PACTDOCK_S3_PATH_STYLE"]) s3.pathStyle = env["PACTDOCK_S3_PATH_STYLE"] === "true";
  }

  let smtp: SmtpSettings | undefined;
  if (env["PACTDOCK_SMTP_HOST"]) {
    const port = Number(env["PACTDOCK_SMTP_PORT"] ?? "587");
    const security = (env["PACTDOCK_SMTP_SECURITY"] ?? (port === 465 ? "tls" : "starttls")) as SmtpSettings["security"];
    if (!["tls", "starttls", "none"].includes(security)) throw new Error("PACTDOCK_SMTP_SECURITY must be tls, starttls or none.");
    const from = env["PACTDOCK_SMTP_FROM"];
    if (!from) throw new Error("PACTDOCK_SMTP_FROM is required with PACTDOCK_SMTP_HOST.");
    smtp = { host: env["PACTDOCK_SMTP_HOST"], port, security, from };
    const user = secret(env, "PACTDOCK_SMTP_USER");
    const pass = secret(env, "PACTDOCK_SMTP_PASS");
    if (user) smtp.user = user;
    if (pass) smtp.pass = pass;
  }

  return {
    port: Number(env["PACTDOCK_PORT"] ?? "8080"),
    publicUrl: url(publicUrl, "PACTDOCK_PUBLIC_URL"),
    dataDir,
    setupToken: secret(env, "PACTDOCK_SETUP_TOKEN"),
    masterKey: secret(env, "PACTDOCK_MASTER_KEY"),
    trustProxy: env["PACTDOCK_TRUST_PROXY"] === "true",
    githubUrl: url(env["PACTDOCK_GITHUB_URL"] ?? "https://github.com", "PACTDOCK_GITHUB_URL"),
    githubApiUrl: url(env["PACTDOCK_GITHUB_API_URL"] ?? "https://api.github.com", "PACTDOCK_GITHUB_API_URL"),
    s3,
    smtp,
    backup: {
      dir: env["PACTDOCK_BACKUP_DIR"] ?? join(dataDir, "backups"),
      intervalHours: Number(env["PACTDOCK_BACKUP_INTERVAL_HOURS"] ?? "0"),
      keep: Number(env["PACTDOCK_BACKUP_KEEP"] ?? "14"),
      passphrase: secret(env, "PACTDOCK_BACKUP_PASSPHRASE"),
    },
  };
}
