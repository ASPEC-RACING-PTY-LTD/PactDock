// Test harness: a real PactDock Server on an ephemeral port, talking to an
// in-memory fake of GitHub's API through an injected fetch.

import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomBytes, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp, httpHandler } from "../src/main.ts";
import type { App } from "../src/app.ts";
import { loadSettings } from "../src/env.ts";

export const API = "https://api.github.test";
export const WEB = "https://github.test";

export interface FakeUser {
  id: number;
  login: string;
  emails: string[];
}

export class FakeGitHub {
  readonly pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  readonly webhookSecret = "whsec_" + randomBytes(8).toString("hex");
  users = new Map<string, FakeUser>(); // oauth code -> user
  checkRuns: { repo: string; head_sha: string; conclusion: string; title: string; summary: string; details_url: string }[] = [];
  comments: { id: number; body: string; user: { login: string; type: string } }[] = [];
  pr = { number: 7, state: "open", draft: false, head: { sha: "a".repeat(40) }, user: { id: 101, login: "alice", type: "User" }, html_url: "https://github.test/aspec/widget/pull/7" };
  commits: unknown[] = [];
  tokenRequests: unknown[] = [];
  lastAuthorize: URL | null = null;

  constructor() {
    this.users.set("code-alice", { id: 101, login: "alice", emails: ["alice@example.com"] });
    this.users.set("code-admin", { id: 900, login: "boss", emails: ["boss@example.com"] });
    this.users.set("code-bob", { id: 202, login: "bob", emails: ["bob@example.org"] });
    this.commits = [
      {
        sha: "1".repeat(40),
        commit: { message: "Add feature\n\nCo-authored-by: Bob <bob@example.org>", author: { name: "Alice", email: "alice@example.com" }, committer: { name: "GitHub", email: "noreply@github.com" } },
        author: { id: 101, login: "alice" },
        committer: { id: 19864447, login: "web-flow" },
      },
    ];
  }

  fetch: typeof fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = String((init.headers as Record<string, string>)?.["authorization"] ?? "");
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    const path = url.pathname;

    if (url.origin === WEB && path === "/login/oauth/access_token") {
      const user = this.users.get(body.code);
      if (!user || !body.code_verifier) return ok({ error: "bad_verification_code" });
      return ok({ access_token: `ghu_${user.login}`, token_type: "bearer" });
    }
    if (url.origin !== API) return ok({ message: "unknown host" }, 404);
    if (method === "POST" && /^\/app-manifests\/[^/]+\/conversions$/.test(path)) {
      return ok({ id: 4242, slug: "aspec-pactdock", client_id: "Iv1.client", client_secret: "client-secret", webhook_secret: this.webhookSecret, pem: this.pem, owner: { login: "aspec" }, html_url: "https://github.test/apps/aspec-pactdock" }, 201);
    }
    if (auth.startsWith("Bearer ghu_")) {
      const login = auth.slice("Bearer ghu_".length);
      const user = [...this.users.values()].find((u) => u.login === login)!;
      if (path === "/user") return ok({ id: user.id, login: user.login, type: "User" });
      if (path === "/user/emails") return ok(user.emails.map((email) => ({ email, verified: true, primary: true })));
    }
    if (path === "/app/installations") return ok([{ id: 9, account: { login: "aspec", id: 1, type: "Organization" }, suspended_at: null }]);
    if (method === "POST" && path === "/app/installations/9/access_tokens") {
      if (!auth.startsWith("Bearer ")) return ok({ message: "jwt required" }, 401);
      this.tokenRequests.push(body);
      return ok({ token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if (auth !== "token ghs_installation") return ok({ message: "Bad credentials" }, 401);
    if (path === "/installation/repositories") return ok({ total_count: 1, repositories: [{ id: 500, full_name: "aspec/widget" }] });
    if (path === "/repos/aspec/widget/pulls/7") return ok(this.pr);
    if (path === "/repos/aspec/widget/pulls/7/commits") return ok(this.commits);
    if (path === "/repos/aspec/widget/pulls") return ok([{ number: 7 }]);
    if (method === "POST" && path === "/repos/aspec/widget/check-runs") {
      this.checkRuns.push({ repo: "aspec/widget", head_sha: body.head_sha, conclusion: body.conclusion, title: body.output.title, summary: body.output.summary, details_url: body.details_url });
      return ok({ id: this.checkRuns.length }, 201);
    }
    if (path === "/repos/aspec/widget/issues/7/comments") {
      if (method === "POST") {
        this.comments.push({ id: this.comments.length + 1, body: body.body, user: { login: "aspec-pactdock[bot]", type: "Bot" } });
        return ok({}, 201);
      }
      return ok(this.comments);
    }
    const commentMatch = /^\/repos\/aspec\/widget\/issues\/comments\/(\d+)$/.exec(path);
    if (commentMatch && method === "PATCH") {
      const c = this.comments.find((x) => x.id === Number(commentMatch[1]))!;
      c.body = body.body;
      return ok(c);
    }
    const userMatch = /^\/users\/([^/]+)$/.exec(path);
    if (userMatch) {
      const user = [...this.users.values()].find((u) => u.login === userMatch[1]);
      return user ? ok({ id: user.id, login: user.login, type: "User" }) : ok({ message: "Not Found" }, 404);
    }
    return ok({ message: `unmocked ${method} ${path}` }, 404);
  }) as typeof fetch;

  sign(body: string): string {
    return "sha256=" + createHmac("sha256", this.webhookSecret).update(body).digest("hex");
  }
}

export class Browser {
  cookies = new Map<string, string>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async request(path: string, init: { method?: string; form?: Record<string, string>; headers?: Record<string, string>; body?: string } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.cookies.size) headers["cookie"] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body = init.body;
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    const res = await fetch(this.base + path, { method: init.method ?? (body ? "POST" : "GET"), headers, ...(body !== undefined ? { body } : {}), redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair!.split("=");
      if (/Max-Age=0/.test(c)) this.cookies.delete(k!);
      else this.cookies.set(k!, v!);
    }
    return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text(), headers: res.headers };
  }

  /** Follows the GitHub sign-in round trip using the fake's OAuth code for a user. */
  async signIn(code: string, next = "/") {
    const start = await this.request(`/auth/login?next=${encodeURIComponent(next)}`);
    const authorize = new URL(start.location);
    if (authorize.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE missing");
    const cb = await this.request(`/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`);
    return cb;
  }
}

export function csrf(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("no csrf field");
  return m[1]!;
}

export async function startServer(extraEnv: Record<string, string> = {}): Promise<{ app: App; gh: FakeGitHub; base: string; server: Server; dataDir: string; close: () => Promise<void> }> {
  const dataDir = mkdtempSync(join(tmpdir(), "pactdock-server-"));
  const gh = new FakeGitHub();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  const settings = loadSettings({
    PACTDOCK_PUBLIC_URL: base,
    PACTDOCK_DATA_DIR: dataDir,
    PACTDOCK_MASTER_KEY: randomBytes(32).toString("base64"),
    PACTDOCK_SETUP_TOKEN: "setup-token-123",
    PACTDOCK_GITHUB_URL: WEB,
    PACTDOCK_GITHUB_API_URL: API,
    ...extraEnv,
  });
  const app = buildApp(settings, { fetchImpl: gh.fetch, logger: { info() {}, error() {} } });
  server.on("request", httpHandler(app));
  return {
    app,
    gh,
    base,
    server,
    dataDir,
    close: async () => {
      await app.idle();
      await new Promise<void>((r) => server.close(() => r()));
      app.db.close();
    },
  };
}
