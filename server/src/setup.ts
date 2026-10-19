// First-run setup: registers this server's own GitHub App through GitHub's App
// Manifest flow, then stores the returned credentials encrypted.
// https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

import { createAppJwt } from "../../src/app-auth.ts";
import { Http } from "../../src/http.ts";
import type { App } from "./app.ts";
import { randomToken, safeEqual, sha256 } from "./crypto.ts";
import { convertManifest } from "./github.ts";
import { esc } from "./html.ts";
import { cookie, HttpError, redirect, type Request } from "./web.ts";

/** The App this server asks GitHub to create: PRs, checks, metadata and verified emails only. */
export function buildManifest(publicUrl: string, name: string): Record<string, unknown> {
  return {
    name,
    url: publicUrl,
    description: "Self-hosted contributor licence agreement checks (PactDock Server).",
    public: false,
    hook_attributes: { url: `${publicUrl}/webhook`, active: true },
    redirect_url: `${publicUrl}/setup/callback`,
    callback_urls: [`${publicUrl}/auth/callback`],
    setup_url: `${publicUrl}/setup/installed`,
    setup_on_update: true,
    request_oauth_on_install: false,
    default_permissions: {
      pull_requests: "write",
      checks: "write",
      metadata: "read",
      email_addresses: "read",
    },
    default_events: ["pull_request", "check_run"],
  };
}

const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{3,34}$/;

function setupAllowed(app: App, req: Request): boolean {
  return app.vault.verify("setup", req.cookies["pd_setup"] ?? "") === "ok";
}

export function registerSetupRoutes(app: App): void {
  app.router.on("GET", "/setup", (req) => {
    if (app.configured) {
      return app.page(req, "Setup", `<h1>Already connected</h1><p>This server is connected to the GitHub App <strong>${esc(app.db.setting("app_slug"))}</strong>. Manage it from the <a href="/admin">admin portal</a>.</p>`);
    }
    const headers: Record<string, string> = {};
    const token = req.url.searchParams.get("token");
    if (token) {
      if (!safeEqual(sha256(token), sha256(app.setupToken))) throw new HttpError(403, "That setup token is not valid.");
      headers["set-cookie"] = cookie("pd_setup", app.vault.sign("setup", "ok", new Date(Date.now() + 3600_000)), { secure: req.secure, maxAge: 3600 });
      return redirect("/setup", headers);
    }
    if (!setupAllowed(app, req)) throw new HttpError(403, "Open the setup link printed in the server log (or use PACTDOCK_SETUP_TOKEN).");
    return app.page(
      req,
      "Connect to GitHub",
      `<h1>Connect PactDock to GitHub</h1>
       <p>PactDock creates a <strong>private GitHub App owned by you</strong>. GitHub will show you exactly what it can access before you confirm:</p>
       <ul><li>Pull requests: read and write (to read contributors and post one status comment)</li>
       <li>Checks: read and write (the merge-blocking "PactDock CLA" check)</li>
       <li>Metadata: read (required by GitHub)</li>
       <li>Email addresses: read (only for people who sign, to match co-author emails)</li></ul>
       <p>It cannot read or change repository code, workflows, secrets or settings.</p>
       <p>Public URL: <code>${esc(app.settings.publicUrl)}</code>. GitHub must be able to reach <code>${esc(app.settings.publicUrl)}/webhook</code>.</p>
       <form method="post" action="/setup/manifest" class="card">
         <label>App name <input name="name" required pattern="[A-Za-z0-9 ._-]{3,34}" value="PactDock CLA" maxlength="34"></label>
         <label>Owner <select name="ownerType"><option value="org">An organisation</option><option value="user">My personal account</option></select></label>
         <label>Organisation login (if owned by an organisation) <input name="org" pattern="[A-Za-z0-9-]{1,39}" maxlength="39"></label>
         <button>Continue to GitHub</button>
       </form>`,
      200,
    );
  });

  app.router.on("POST", "/setup/manifest", async (req) => {
    if (app.configured) throw new HttpError(409, "Already configured.");
    if (!setupAllowed(app, req)) throw new HttpError(403, "Setup session expired; open the setup link again.");
    const form = await req.form();
    const name = form.get("name") ?? "";
    const ownerType = form.get("ownerType");
    const org = form.get("org") ?? "";
    if (!NAME_RE.test(name)) throw new HttpError(400, "App name must be 3-34 letters, numbers, spaces, dots, dashes or underscores.");
    if (ownerType === "org" && !ORG_RE.test(org)) throw new HttpError(400, "Enter the organisation's login.");
    const state = randomToken();
    app.db.run("INSERT INTO oauth_states (state_hash, purpose, data, expires_at) VALUES (?, 'manifest', '{}', ?)", sha256(state), new Date(Date.now() + 3600_000).toISOString());
    const target = ownerType === "org" ? `${app.settings.githubUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${app.settings.githubUrl}/settings/apps/new`;
    const manifest = JSON.stringify(buildManifest(app.settings.publicUrl, name));
    return app.page(
      req,
      "Create the GitHub App",
      `<h1>Create the GitHub App</h1>
       <p>GitHub will show the App's name and permissions. Review them, then choose <strong>Create GitHub App</strong>.</p>
       <form method="post" action="${esc(target)}?state=${esc(state)}">
         <input type="hidden" name="manifest" value="${esc(manifest)}">
         <button>Open GitHub to create the App</button>
       </form>`,
    );
  });

  app.router.on("GET", "/setup/callback", async (req) => {
    if (app.configured) return redirect("/admin");
    if (!setupAllowed(app, req)) throw new HttpError(403, "Setup session expired; open the setup link again.");
    const state = req.url.searchParams.get("state") ?? "";
    const row = app.db.get<{ expires_at: string }>("SELECT expires_at FROM oauth_states WHERE state_hash = ? AND purpose = 'manifest'", sha256(state));
    app.db.run("DELETE FROM oauth_states WHERE state_hash = ?", sha256(state));
    if (!row || row.expires_at < new Date().toISOString()) throw new HttpError(400, "This setup attempt expired. Start again from /setup.");
    const created = await convertManifest(app.settings.githubApiUrl, req.url.searchParams.get("code") ?? "", app.endpoints.fetchImpl);

    let webhookSecret = created.webhook_secret;
    if (!webhookSecret) {
      // GitHub did not generate one: set our own through the App's hook config.
      webhookSecret = randomToken(32);
      const jwt = createAppJwt(String(created.id), created.pem);
      const http = new Http({ token: jwt, scheme: "Bearer", apiUrl: app.settings.githubApiUrl, graphqlUrl: "", ...(app.endpoints.fetchImpl ? { fetchImpl: app.endpoints.fetchImpl } : {}) });
      await http.request("PATCH", "/app/hook/config", { body: { secret: webhookSecret, content_type: "json" } });
    }
    app.db.transaction(() => {
      app.db.setSetting("app_id", String(created.id));
      app.db.setSetting("app_slug", created.slug);
      app.db.setSetting("app_owner", created.owner?.login ?? "");
      app.db.setSetting("app_html_url", created.html_url);
      app.db.setSetting("client_id", created.client_id);
      app.db.setSetting("client_secret", app.vault.encrypt(created.client_secret));
      app.db.setSetting("webhook_secret", app.vault.encrypt(webhookSecret));
      app.db.setSetting("private_key", app.vault.encrypt(created.pem));
      app.db.audit("setup", "app.created", `GitHub App ${created.slug} (ID ${created.id}) created via manifest.`);
    });
    app.resetGithubClient();
    return app.page(
      req,
      "App created",
      `<h1>GitHub App created</h1>
       <ol><li><strong>Sign in with GitHub</strong> to become this server's first administrator.</li>
       <li>Install the App on the repositories you want to protect.</li></ol>
       <p><a class="button" href="/auth/login?next=/admin">Sign in with GitHub</a></p>
       <p>Install link: <a href="${esc(app.settings.githubUrl)}/apps/${esc(created.slug)}/installations/new">${esc(app.settings.githubUrl)}/apps/${esc(created.slug)}/installations/new</a></p>`,
    );
  });

  app.router.on("GET", "/setup/installed", (req) => {
    app.enqueue("sync-installations", () => syncInstallations(app));
    return app.page(req, "Installed", `<h1>Installation received</h1><p>Repositories will appear in the <a href="/admin">admin portal</a>, where you assign agreements and enable checks.</p>`);
  });
}

/** Pulls installations and their repositories from GitHub into the database. */
export async function syncInstallations(app: App): Promise<void> {
  const github = app.requireGithub();
  const now = new Date().toISOString();
  for (const inst of await github.installations()) {
    app.db.run(
      `INSERT INTO installations (id, account_login, account_id, account_type, suspended, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_login = excluded.account_login, suspended = excluded.suspended, updated_at = excluded.updated_at`,
      inst.id,
      inst.account.login,
      inst.account.id,
      inst.account.type,
      inst.suspended_at ? 1 : 0,
      now,
    );
    const http = await github.installation(inst.id);
    for (const repo of await github.installationRepositories(http)) upsertRepo(app, inst.id, repo.id, repo.full_name);
  }
}

export function upsertRepo(app: App, installationId: number, id: number, fullName: string): void {
  app.db.run(
    `INSERT INTO repositories (id, installation_id, full_name, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, removed = 0, updated_at = excluded.updated_at`,
    id,
    installationId,
    fullName,
    new Date().toISOString(),
  );
}
