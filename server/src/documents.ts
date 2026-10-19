// Signed documents: rendering and write-once storage (local disk or S3/R2).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { S3Client, S3PreconditionError } from "../../src/s3.ts";
import type { S3Settings } from "./env.ts";
import { esc, markdown } from "./html.ts";

export interface DocumentStore {
  readonly label: string;
  /** Stores a document exactly once. Throws if the key already exists. */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;

function checkKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..")) throw new Error(`Invalid document key: ${key}`);
}

export class LocalDocumentStore implements DocumentStore {
  readonly label: string;
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true });
    this.label = `local:${this.#root}`;
  }

  #path(key: string): string {
    checkKey(key);
    const path = resolve(join(this.#root, key));
    if (!path.startsWith(this.#root + sep)) throw new Error("Document path escapes the storage directory.");
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.#path(key);
    mkdirSync(dirname(path), { recursive: true });
    // "wx" fails if the file exists; read-only afterwards.
    writeFileSync(path, data, { flag: "wx", mode: 0o444 });
    chmodSync(path, 0o444);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return readFileSync(this.#path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}

export class S3DocumentStore implements DocumentStore {
  readonly label: string;
  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(settings: S3Settings, fetchImpl?: typeof fetch) {
    this.#client = new S3Client({
      bucket: settings.bucket,
      region: settings.region,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      ...(settings.pathStyle !== undefined ? { pathStyle: settings.pathStyle } : {}),
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    this.#prefix = settings.prefix;
    this.label = this.#client.label;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    checkKey(key);
    try {
      await this.#client.put(`${this.#prefix}/${key}`, data, { contentType, ifNoneMatch: true });
    } catch (err) {
      if (err instanceof S3PreconditionError) throw new Error(`Document ${key} already exists; signed documents are never overwritten.`);
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    checkKey(key);
    return (await this.#client.get(`${this.#prefix}/${key}`))?.body ?? null;
  }
}

export interface SignedDocumentInput {
  id: string;
  agreementName: string;
  version: string;
  rightsHolder: string;
  agreementBody: string;
  agreementSha256: string;
  legalName: string;
  githubLogin: string;
  githubId: number;
  email: string | null;
  entityName: string | null;
  entityTitle: string | null;
  signatureType: "typed" | "drawn";
  /** Typed name, or SVG path data for a drawn signature. */
  signatureData: string;
  signedAt: string;
  ip: string;
  userAgent: string;
  repository: string;
  pullRequest: number | null;
  serverUrl: string;
}

/** Converts stored stroke data ("x,y x,y;x,y ...") into an inline SVG. */
export function signatureSvg(data: string): string {
  const strokes = data
    .split(";")
    .map((s) =>
      s
        .trim()
        .split(" ")
        .map((p) => p.split(",").map(Number))
        .filter((p) => p.length === 2 && p.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)),
    )
    .filter((s) => s.length > 0);
  const paths = strokes
    .map((s) => `<path d="M${s.map(([x, y]) => `${x!.toFixed(1)} ${y!.toFixed(1)}`).join(" L")}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" width="300" height="100" role="img" aria-label="Drawn signature">${paths}</svg>`;
}

/** Validates drawn-signature stroke data from the browser. */
export function normaliseStrokes(raw: string): string | null {
  if (raw.length > 60_000) return null;
  const strokes = raw.split(";").filter(Boolean);
  if (strokes.length === 0 || strokes.length > 100) return null;
  let points = 0;
  for (const s of strokes) {
    for (const p of s.trim().split(" ")) {
      const [x, y] = p.split(",").map(Number);
      if (x === undefined || y === undefined || !(x >= 0 && x <= 600 && y >= 0 && y <= 200)) return null;
      points++;
    }
  }
  return points >= 5 ? strokes.map((s) => s.trim()).join(";") : null;
}

/** A self-contained HTML copy of the signed agreement, suitable for download or printing. */
export function renderSignedDocument(d: SignedDocumentInput): string {
  const signature =
    d.signatureType === "typed" ? `<p class="typed-signature">${esc(d.signatureData)}</p>` : signatureSvg(d.signatureData);
  const party = d.entityName
    ? `${esc(d.legalName)}, ${esc(d.entityTitle ?? "")}, for and on behalf of <strong>${esc(d.entityName)}</strong>`
    : `<strong>${esc(d.legalName)}</strong>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(d.agreementName)} v${esc(d.version)}: signed by ${esc(d.legalName)}</title>
<style>
body{font:15px/1.55 Georgia,serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#111}
h1,h2,h3{font-family:Helvetica,Arial,sans-serif}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #bbb;padding:.35rem .5rem;text-align:left;vertical-align:top;font-size:13px}
.sigblock{border:2px solid #111;padding:1rem;margin-top:2rem;page-break-inside:avoid}
.typed-signature{font:italic 2rem "Brush Script MT","Segoe Script",cursive;margin:.5rem 0}
.evidence{font-family:Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
</style></head><body>
<p><small>Signed agreement record ${esc(d.id)}</small></p>
${markdown(d.agreementBody)}
<div class="sigblock">
<h2>Execution</h2>
<p>Accepted electronically by ${party} (GitHub account <strong>@${esc(d.githubLogin)}</strong>, ID ${d.githubId}) in favour of <strong>${esc(d.rightsHolder)}</strong>.</p>
${signature}
<table class="evidence">
<tr><th>Agreement</th><td>${esc(d.agreementName)}, version ${esc(d.version)}</td></tr>
<tr><th>Agreement SHA-256</th><td>${esc(d.agreementSha256)}</td></tr>
<tr><th>Signed at (UTC)</th><td>${esc(d.signedAt)}</td></tr>
<tr><th>Signer</th><td>${esc(d.legalName)}${d.email ? ` &lt;${esc(d.email)}&gt;` : ""}</td></tr>
<tr><th>GitHub account</th><td>@${esc(d.githubLogin)} (ID ${d.githubId}), authenticated with GitHub</td></tr>
<tr><th>IP address</th><td>${esc(d.ip)}</td></tr>
<tr><th>User agent</th><td>${esc(d.userAgent)}</td></tr>
<tr><th>Context</th><td>${esc(d.repository)}${d.pullRequest ? ` pull request #${d.pullRequest}` : ""}</td></tr>
<tr><th>Recorded by</th><td>${esc(d.serverUrl)}</td></tr>
</table>
<p><small>The terms above are the exact text of the agreement version identified by its SHA-256. They do not change after signing; later versions apply only if separately accepted.</small></p>
</div>
</body></html>
`;
}
