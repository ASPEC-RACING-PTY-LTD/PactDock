// GitHub App installation-token minting using only node:crypto.
// https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app

import { createPrivateKey, createSign } from "node:crypto";
import { Http, type HttpOptions } from "./http.ts";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Creates a short-lived (9 minute) RS256 JWT identifying the GitHub App. */
export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!/^[A-Za-z0-9.]+$/.test(appId)) throw new Error("app-id must be a numeric App ID or a Client ID.");
  // Accept keys pasted with literal "\n" sequences (common when stored as secrets).
  const pem = privateKeyPem.includes("\\n") && !privateKeyPem.includes("\n") ? privateKeyPem.replace(/\\n/g, "\n") : privateKeyPem;
  const key = createPrivateKey(pem);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated 60s to tolerate clock drift, exp stays under the 10 minute maximum.
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(key))}`;
}

export type Permissions = Record<string, "read" | "write">;

/**
 * Mints an installation token scoped to exactly one repository and the given
 * permissions (least privilege), regardless of what the installation could grant.
 */
export async function createInstallationToken(
  http: Omit<HttpOptions, "token" | "scheme">,
  appId: string,
  privateKey: string,
  owner: string,
  repo: string,
  permissions: Permissions,
): Promise<string> {
  const jwt = createAppJwt(appId, privateKey);
  const app = new Http({ ...http, token: jwt, scheme: "Bearer" });
  const installation = await app.request<{ id: number }>("GET", `/repos/${enc(owner)}/${enc(repo)}/installation`);
  const token = await app.request<{ token: string }>("POST", `/app/installations/${installation.id}/access_tokens`, {
    body: { repositories: [repo], permissions },
  });
  if (!token?.token) throw new Error(`GitHub did not return an installation token for ${owner}/${repo}.`);
  return token.token;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
