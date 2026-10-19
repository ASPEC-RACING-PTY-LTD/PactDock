// Application context shared by all routes: settings, database, vault,
// document storage, mailer, GitHub client, sessions and the job queue.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomToken, sha256, safeEqual, type Vault } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { DocumentStore } from "./documents.ts";
import type { Settings } from "./env.ts";
import { GitHubClient, type GitHubEndpoints } from "./github.ts";
import { esc, layout } from "./html.ts";
import type { Mailer } from "./mailer.ts";
import { cookie, html, HttpError, redirect, RateLimiter, Router, type Request, type Response } from "./web.ts";
import type { VerifyContext } from "./verify.ts";

export interface Session {
  githubId: number;
  login: string;
  emails: string[];
  csrf: string;
  admin: boolean;
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export class App {
  readonly router = new Router();
  readonly limits = {
    auth: new RateLimiter(30, 10 * 60_000),
    recover: new RateLimiter(5, 60 * 60_000),
    sign: new RateLimiter(20, 10 * 60_000),
  };
  #queue: Promise<void> = Promise.resolve();
  #github: GitHubClient | null = null;
  readonly setupToken: string;
  readonly settings: Settings;
  readonly db: Db;
  readonly vault: Vault;
  readonly documents: DocumentStore;
  readonly mailer: Mailer | null;
  readonly log: Logger;
  readonly endpoints: Pick<GitHubEndpoints, "fetchImpl">;

  constructor(
    settings: Settings,
    db: Db,
    vault: Vault,
    documents: DocumentStore,
    mailer: Mailer | null,
    log: Logger,
    endpoints: Pick<GitHubEndpoints, "fetchImpl"> = {},
  ) {
    this.settings = settings;
    this.db = db;
    this.vault = vault;
    this.documents = documents;
    this.mailer = mailer;
    this.log = log;
    this.endpoints = endpoints;
    // Without a configured token, first-run setup is protected by a random one printed to the log.
    this.setupToken = settings.setupToken ?? randomToken(18);
    if (!settings.setupToken && !this.configured) {
      log.info(`First-run setup: open ${settings.publicUrl}/setup?token=${this.setupToken}`);
    }
  }

  get configured(): boolean {
    return Boolean(this.db.setting("app_id"));
  }

  /** The GitHub client for the configured App, or null before setup. */
  github(): GitHubClient | null {
    if (this.#github) return this.#github;
    const appId = this.db.setting("app_id");
    if (!appId) return null;
    this.#github = new GitHubClient(
      {
        appId,
        clientId: this.db.setting("client_id") ?? "",
        clientSecret: this.vault.decrypt(this.db.setting("client_secret") ?? ""),
        privateKey: this.vault.decrypt(this.db.setting("private_key") ?? ""),
      },
      { apiUrl: this.settings.githubApiUrl, githubUrl: this.settings.githubUrl, ...this.endpoints },
    );
    return this.#github;
  }

  resetGithubClient(): void {
    this.#github = null;
  }

  requireGithub(): GitHubClient {
    const gh = this.github();
    if (!gh) throw new HttpError(503, "This server has not been connected to GitHub yet.");
    return gh;
  }

  verifyContext(): VerifyContext {
    return {
      db: this.db,
      vault: this.vault,
      github: this.requireGithub(),
      publicUrl: this.settings.publicUrl,
      botLogin: `${this.db.setting("app_slug") ?? "pactdock"}[bot]`,
      log: (m) => this.log.info(m),
    };
  }

  /** Runs background jobs one at a time, so PR updates never race each other. */
  enqueue(name: string, job: () => Promise<unknown>): void {
    this.#queue = this.#queue.then(job).then(
      () => undefined,
      (err: unknown) => this.log.error(`Job ${name} failed: ${(err as Error).stack ?? String(err)}`),
    );
  }

  /** Resolves when all queued jobs have finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.#queue;
  }

  // ---- sessions ----

  session(req: Request): Session | null {
    const raw = req.cookies["pd_session"];
    if (!raw) return null;
    const row = this.db.get<{ github_id: number; login: string; emails: string; csrf: string; expires_at: string }>(
      "SELECT github_id, login, emails, csrf, expires_at FROM sessions WHERE id_hash = ?",
      sha256(raw),
    );
    if (!row || row.expires_at < new Date().toISOString()) return null;
    return { githubId: row.github_id, login: row.login, emails: JSON.parse(row.emails) as string[], csrf: row.csrf, admin: this.db.isAdmin(row.github_id) };
  }

  requireSession(req: Request): Session {
    const s = this.session(req);
    if (!s) throw new LoginRequired(req.path + req.url.search);
    return s;
  }

  requireAdmin(req: Request): Session {
    const s = this.requireSession(req);
    if (!s.admin) throw new HttpError(403, "Administrator access is required.");
    return s;
  }

  async checkCsrf(req: Request, session: Session): Promise<URLSearchParams> {
    const form = await req.form();
    if (!safeEqual(form.get("csrf") ?? "", session.csrf)) throw new HttpError(403, "The form expired. Go back, reload the page and try again.");
    return form;
  }

  createSession(user: { id: number; login: string; emails: string[] }, secure: boolean): string {
    const raw = randomToken();
    const now = new Date();
    this.db.run(
      "INSERT INTO sessions (id_hash, github_id, login, emails, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sha256(raw),
      user.id,
      user.login,
      JSON.stringify(user.emails.slice(0, 20)),
      randomToken(18),
      now.toISOString(),
      new Date(now.getTime() + 8 * 3600_000).toISOString(),
    );
    return cookie("pd_session", raw, { secure, maxAge: 8 * 3600 });
  }

  page(req: Request, title: string, body: string, status = 200, headers: Record<string, string | string[]> = {}): Response {
    const s = this.session(req);
    return html(layout(body, { title, user: s ? { login: s.login, admin: s.admin } : null, csrf: s?.csrf ?? "" }), status, headers);
  }

  // ---- one-time and expiring links ----

  createLink(kind: "download" | "recovery", subject: string, ttlMs: number): string {
    const token = randomToken();
    this.db.run(
      "INSERT INTO links (token_hash, kind, subject, expires_at) VALUES (?, ?, ?, ?)",
      sha256(token),
      kind,
      subject,
      new Date(Date.now() + ttlMs).toISOString(),
    );
    return token;
  }

  link(kind: "download" | "recovery", token: string): { subject: string } | null {
    const row = this.db.get<{ subject: string; kind: string; expires_at: string }>("SELECT subject, kind, expires_at FROM links WHERE token_hash = ?", sha256(token));
    if (!row || row.kind !== kind || row.expires_at < new Date().toISOString()) return null;
    this.db.run("UPDATE links SET used_at = COALESCE(used_at, ?) WHERE token_hash = ?", new Date().toISOString(), sha256(token));
    return { subject: row.subject };
  }
}

export class LoginRequired extends Error {
  readonly next: string;
  constructor(next: string) {
    super("Login required");
    this.next = next;
  }
}

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function errorPage(status: number, message: string): string {
  return layout(`<h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><p>${esc(message)}</p><p><a href="/">Home</a></p>`, { title: "Error" });
}

const STATIC_TYPES: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8" };

export function registerCoreRoutes(app: App, staticDir: string): void {
  const files = new Map<string, Buffer>();
  app.router.on("GET", "/static/:file", (req) => {
    const name = req.params["file"] ?? "";
    if (!/^[a-z0-9-]+\.(css|js)$/.test(name)) throw new HttpError(404, "Not found.");
    let data = files.get(name);
    if (!data) {
      try {
        data = readFileSync(join(staticDir, name));
      } catch {
        throw new HttpError(404, "Not found.");
      }
      files.set(name, data);
    }
    return { status: 200, headers: { "content-type": STATIC_TYPES[name.split(".").pop()!]!, "cache-control": "public, max-age=3600" }, body: data };
  });

  app.router.on("GET", "/healthz", () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "ok" }));

  app.router.on("GET", "/", (req) => {
    if (!app.configured) {
      return app.page(req, "Welcome", `<h1>PactDock Server</h1><p>This server is not connected to GitHub yet. The administrator should open the setup link printed in the server log.</p>`);
    }
    const s = app.session(req);
    return app.page(
      req,
      "Contributor agreements",
      `<h1>Contributor agreements</h1>
       <p>This server manages contributor licence agreements for ${esc(app.db.setting("app_owner") ?? "this organisation")}'s repositories.
       When a pull request needs your signature, the PactDock check and comment link you straight to the right agreement.</p>
       <p>${s ? `<a class="button" href="/my">View my signed agreements</a>` : `<a class="button" href="/auth/login?next=/my">Sign in with GitHub</a>`}
       <a href="/recover">Lost access? Recover your copies by email</a></p>`,
    );
  });

  // ---- GitHub sign-in ----

  app.router.on("GET", "/auth/login", (req) => {
    if (!app.limits.auth.allow(req.ip)) throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
    const github = app.requireGithub();
    const next = req.url.searchParams.get("next") ?? "/";
    const verifier = randomToken(48);
    const state = randomToken();
    app.db.run(
      "INSERT INTO oauth_states (state_hash, purpose, data, expires_at) VALUES (?, 'login', ?, ?)",
      sha256(state),
      JSON.stringify({ verifier, next: next.startsWith("/") && !next.startsWith("//") ? next : "/" }),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    return redirect(github.authorizeUrl(`${app.settings.publicUrl}/auth/callback`, state, pkceChallenge(verifier)));
  });

  app.router.on("GET", "/auth/callback", async (req) => {
    const github = app.requireGithub();
    const state = req.url.searchParams.get("state") ?? "";
    const code = req.url.searchParams.get("code") ?? "";
    const row = app.db.get<{ data: string; expires_at: string }>("SELECT data, expires_at FROM oauth_states WHERE state_hash = ? AND purpose = 'login'", sha256(state));
    app.db.run("DELETE FROM oauth_states WHERE state_hash = ?", sha256(state));
    if (!row || row.expires_at < new Date().toISOString() || !code) throw new HttpError(400, "The sign-in link expired. Please try again.");
    const { verifier, next } = JSON.parse(row.data) as { verifier: string; next: string };
    const user = await github.signIn(code, `${app.settings.publicUrl}/auth/callback`, verifier);
    if (user.type !== "User") throw new HttpError(403, "Only personal GitHub accounts can sign in.");

    // First administrator: whoever completes setup while holding the setup cookie.
    if (app.db.adminCount() === 0 && app.vault.verify("setup", req.cookies["pd_setup"] ?? "") === "ok") {
      app.db.run("INSERT INTO admins (github_id, login, added_at) VALUES (?, ?, ?)", user.id, user.login, new Date().toISOString());
      app.db.audit(`@${user.login}`, "admin.bootstrap", "First administrator created during setup.");
    }
    app.db.audit(`@${user.login}`, "auth.login", `GitHub ID ${user.id}`);
    return redirect(next, { "set-cookie": [app.createSession(user, req.secure), cookie("pd_setup", "", { secure: req.secure, maxAge: 0 })] });
  });

  app.router.on("POST", "/logout", async (req) => {
    const s = app.session(req);
    if (s) {
      await app.checkCsrf(req, s);
      app.db.run("DELETE FROM sessions WHERE id_hash = ?", sha256(req.cookies["pd_session"] ?? ""));
    }
    return redirect("/", { "set-cookie": cookie("pd_session", "", { secure: req.secure, maxAge: 0 }) });
  });
}
