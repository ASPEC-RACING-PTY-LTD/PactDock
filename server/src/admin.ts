// Admin portal: repositories, agreements, signatures, entity approvals,
// administrators, audit log and integrity verification.

import type { App, Session } from "./app.ts";
import { sha256 } from "./crypto.ts";
import type { AgreementRow, RepoRow, SignatureRow, VersionRow } from "./db.ts";
import { esc } from "./html.ts";
import { syncInstallations } from "./setup.ts";
import { verifyIntegrity } from "./sign.ts";
import { signLink, verifyPullRequest } from "./verify.ts";
import { HttpError, redirect, type Request } from "./web.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.\-]{0,31}$/;
const TEXT_RE = /^[^\r\n<>`]{2,200}$/;

function csrfField(s: Session): string {
  return `<input type="hidden" name="csrf" value="${esc(s.csrf)}">`;
}

function adminNav(): string {
  return `<p class="subnav"><a href="/admin">Overview</a> <a href="/admin/agreements">Agreements</a> <a href="/admin/signatures">Signatures</a>
    <a href="/admin/entities">Entity approvals</a> <a href="/admin/admins">Administrators</a> <a href="/admin/audit">Audit log</a> <a href="/admin/integrity">Integrity</a></p>`;
}

function agreementOptions(agreements: AgreementRow[], kind: "individual" | "entity", selected: number | null): string {
  return [`<option value="">None</option>`, ...agreements.filter((a) => a.kind === kind).map((a) => `<option value="${a.id}"${a.id === selected ? " selected" : ""}>${esc(a.name)} (${esc(a.slug)})</option>`)].join("");
}

async function resolveLogins(app: App, raw: string): Promise<{ id: number; login: string }[]> {
  const logins = raw
    .split(/[\s,]+/)
    .map((l) => l.trim().replace(/^@/, ""))
    .filter(Boolean)
    .slice(0, 200);
  if (!logins.length) return [];
  const github = app.requireGithub();
  const inst = app.db.get<{ id: number }>("SELECT id FROM installations WHERE suspended = 0 LIMIT 1");
  if (!inst) throw new HttpError(400, "Install the GitHub App first so account names can be looked up.");
  const http = await github.installation(inst.id);
  const out: { id: number; login: string }[] = [];
  for (const login of logins) {
    const user = await github.userByLogin(http, login);
    if (!user) throw new HttpError(400, `GitHub account "${login}" was not found.`);
    out.push({ id: user.id, login: user.login });
  }
  return out;
}

export function registerAdminRoutes(app: App): void {
  const page = (req: Request, title: string, body: string) => app.page(req, title, `${adminNav()}${body}`);

  app.router.on("GET", "/admin", (req) => {
    const s = app.requireAdmin(req);
    const repos = app.db.all<RepoRow>("SELECT * FROM repositories WHERE removed = 0 ORDER BY full_name");
    const agreements = app.db.all<AgreementRow>("SELECT * FROM agreements ORDER BY name");
    const counts = app.db.get<{ sigs: number; pending: number }>(
      "SELECT (SELECT COUNT(*) FROM signatures) AS sigs, (SELECT COUNT(*) FROM entity_status WHERE status = 'pending') AS pending",
    )!;
    const slug = app.db.setting("app_slug") ?? "";
    const repoRows = repos
      .map((r) => {
        const a = r.individual_agreement_id ? agreements.find((x) => x.id === r.individual_agreement_id) : undefined;
        return `<tr><td>${esc(r.full_name)}</td><td>${r.enabled ? "✅ Enforcing" : "Off"}</td><td>${a ? esc(a.name) : "<em>none</em>"}</td><td><a href="/admin/repos/${r.id}">Configure</a></td></tr>`;
      })
      .join("");
    return page(
      req,
      "Admin",
      `<h1>PactDock admin</h1>
       <p>GitHub App <a href="${esc(app.db.setting("app_html_url") ?? "")}">${esc(slug)}</a> · owner ${esc(app.db.setting("app_owner") ?? "")} ·
       <a href="${esc(app.settings.githubUrl)}/apps/${esc(slug)}/installations/new">Install on more repositories</a></p>
       <p>${counts.sigs} signed record(s) · ${counts.pending} entity agreement(s) awaiting approval · documents stored in ${esc(app.documents.label)}</p>
       <h2>Repositories</h2>
       ${repos.length ? `<table><tr><th>Repository</th><th>Status</th><th>Individual agreement</th><th></th></tr>${repoRows}</table>` : "<p>No repositories yet. Install the App, then sync.</p>"}
       <form method="post" action="/admin/sync">${csrfField(s)}<button>Sync repositories from GitHub</button></form>
       ${agreements.length ? "" : `<p class="note">Create an agreement first: <a href="/admin/agreements">Agreements</a>.</p>`}`,
    );
  });

  app.router.on("POST", "/admin/sync", async (req) => {
    const s = app.requireAdmin(req);
    await app.checkCsrf(req, s);
    await syncInstallations(app);
    app.db.audit(`@${s.login}`, "repos.sync");
    return redirect("/admin");
  });

  // ---- repositories ----

  app.router.on("GET", "/admin/repos/:id", (req) => {
    const s = app.requireAdmin(req);
    const repo = app.db.repo(Number(req.params["id"]));
    if (!repo) throw new HttpError(404, "Not found.");
    const agreements = app.db.all<AgreementRow>("SELECT * FROM agreements ORDER BY name");
    const checked = (v: number) => (v ? " checked" : "");
    return page(
      req,
      repo.full_name,
      `<h1>${esc(repo.full_name)}</h1>
       <form method="post" action="/admin/repos/${repo.id}" class="card">${csrfField(s)}
         <label class="check"><input type="checkbox" name="enabled" value="1"${checked(repo.enabled)}> Enforce contributor agreements on this repository</label>
         <label>Individual agreement <select name="individual">${agreementOptions(agreements, "individual", repo.individual_agreement_id)}</select></label>
         <label>Entity agreement (optional) <select name="entity">${agreementOptions(agreements, "entity", repo.entity_agreement_id)}</select></label>
         <label>Which signed versions count <select name="policy">
           <option value="current"${repo.version_policy === "current" ? " selected" : ""}>Only the current version (new versions require re-signing)</option>
           <option value="any"${repo.version_policy === "any" ? " selected" : ""}>Any published version</option></select></label>
         <label class="check"><input type="checkbox" name="coAuthors" value="1"${checked(repo.co_authors)}> Co-authors must sign</label>
         <label class="check"><input type="checkbox" name="committers" value="1"${checked(repo.committers)}> Committers must sign</label>
         <label class="check"><input type="checkbox" name="comment" value="1"${checked(repo.comment)}> Post a status comment on pull requests</label>
         <label>Exempt accounts (GitHub logins, e.g. bots; resolved to permanent IDs) <input name="allowlist" value="" placeholder="dependabot[bot] is exempt by ID 49699333"></label>
         <p class="meta">Currently exempt IDs: ${esc((JSON.parse(repo.allowlist) as number[]).join(", ") || "none")}. <label class="check inline"><input type="checkbox" name="clearAllowlist" value="1"> clear</label></p>
         <button>Save</button>
       </form>
       <form method="post" action="/admin/repos/${repo.id}/recheck">${csrfField(s)}<button>Recheck all open pull requests now</button></form>
       <p class="meta">General signing link (valid 14 days): <code>${esc(signLink(app.vault, app.settings.publicUrl, repo.id, 0))}</code></p>
       <p class="note">In GitHub, add a ruleset requiring the <strong>PactDock CLA</strong> check with this App as its source to block unsigned merges.</p>`,
    );
  });

  app.router.on("POST", "/admin/repos/:id", async (req) => {
    const s = app.requireAdmin(req);
    const form = await app.checkCsrf(req, s);
    const repo = app.db.repo(Number(req.params["id"]));
    if (!repo) throw new HttpError(404, "Not found.");
    const pick = (name: string, kind: "individual" | "entity") => {
      const id = Number(form.get(name) || 0);
      if (!id) return null;
      const a = app.db.agreement(id);
      if (!a || a.kind !== kind) throw new HttpError(400, "Invalid agreement selection.");
      return id;
    };
    const individual = pick("individual", "individual");
    const enabled = form.get("enabled") === "1";
    if (enabled && (!individual || !app.db.currentVersion(individual))) throw new HttpError(400, "Assign an individual agreement with a published version before enabling enforcement.");
    let allow = form.get("clearAllowlist") === "1" ? [] : (JSON.parse(repo.allowlist) as number[]);
    const added = await resolveLogins(app, form.get("allowlist") ?? "");
    allow = [...new Set([...allow, ...added.map((a) => a.id)])];
    app.db.run(
      `UPDATE repositories SET enabled = ?, individual_agreement_id = ?, entity_agreement_id = ?, version_policy = ?, co_authors = ?, committers = ?, comment = ?, allowlist = ?, updated_at = ? WHERE id = ?`,
      enabled ? 1 : 0,
      individual,
      pick("entity", "entity"),
      form.get("policy") === "any" ? "any" : "current",
      form.get("coAuthors") === "1" ? 1 : 0,
      form.get("committers") === "1" ? 1 : 0,
      form.get("comment") === "1" ? 1 : 0,
      JSON.stringify(allow),
      new Date().toISOString(),
      repo.id,
    );
    app.db.audit(`@${s.login}`, "repo.configure", `${repo.full_name}: enabled=${enabled} individual=${individual} exempt=${allow.join(",")}`);
    return redirect(`/admin/repos/${repo.id}`);
  });

  app.router.on("POST", "/admin/repos/:id/recheck", async (req) => {
    const s = app.requireAdmin(req);
    await app.checkCsrf(req, s);
    const repo = app.db.repo(Number(req.params["id"]));
    if (!repo) throw new HttpError(404, "Not found.");
    app.enqueue(`recheck ${repo.full_name}`, async () => {
      const github = app.requireGithub();
      const http = await github.installation(repo.installation_id, repo.id);
      const prs = await http.paginate<{ number: number }>(`/repos/${repo.full_name}/pulls?state=open`, 500);
      for (const pr of prs) await verifyPullRequest(app.verifyContext(), repo, pr.number);
    });
    app.db.audit(`@${s.login}`, "repo.recheck", repo.full_name);
    return redirect(`/admin/repos/${repo.id}`);
  });

  // ---- agreements ----

  app.router.on("GET", "/admin/agreements", (req) => {
    const s = app.requireAdmin(req);
    const rows = app.db.all<AgreementRow & { versions: number }>(
      "SELECT a.*, (SELECT COUNT(*) FROM agreement_versions v WHERE v.agreement_id = a.id) AS versions FROM agreements a ORDER BY a.name",
    );
    return page(
      req,
      "Agreements",
      `<h1>Agreements</h1>
       ${rows.length ? `<table><tr><th>Name</th><th>Type</th><th>Rights holder</th><th>Versions</th><th></th></tr>${rows.map((a) => `<tr><td>${esc(a.name)}</td><td>${a.kind}</td><td>${esc(a.rights_holder)}</td><td>${a.versions}</td><td><a href="/admin/agreements/${a.id}">Open</a></td></tr>`).join("")}</table>` : "<p>No agreements yet.</p>"}
       <h2>New agreement</h2>
       <form method="post" action="/admin/agreements" class="card">${csrfField(s)}
         <label>Name (shown to contributors) <input name="name" required maxlength="200" placeholder="Example Individual Contributor Licence Agreement"></label>
         <label>Identifier (lower-case, dashes) <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,62}" placeholder="example-icla"></label>
         <label>Type <select name="kind"><option value="individual">Individual</option><option value="entity">Entity (company)</option></select></label>
         <label>Party receiving the rights (legal name) <input name="rightsHolder" required maxlength="200"></label>
         <button>Create</button>
       </form>`,
    );
  });

  app.router.on("POST", "/admin/agreements", async (req) => {
    const s = app.requireAdmin(req);
    const form = await app.checkCsrf(req, s);
    const name = (form.get("name") ?? "").trim();
    const slug = (form.get("slug") ?? "").trim();
    const rightsHolder = (form.get("rightsHolder") ?? "").trim();
    const kind = form.get("kind") === "entity" ? "entity" : "individual";
    if (!TEXT_RE.test(name) || !SLUG_RE.test(slug) || !TEXT_RE.test(rightsHolder)) throw new HttpError(400, "Check the name, identifier and rights holder.");
    if (app.db.get("SELECT 1 FROM agreements WHERE slug = ?", slug)) throw new HttpError(409, "That identifier is already used.");
    const { lastInsertRowid } = app.db.run("INSERT INTO agreements (slug, kind, name, rights_holder, created_at) VALUES (?, ?, ?, ?, ?)", slug, kind, name, rightsHolder, new Date().toISOString());
    app.db.audit(`@${s.login}`, "agreement.create", `${slug} (${kind})`);
    return redirect(`/admin/agreements/${lastInsertRowid}`);
  });

  app.router.on("GET", "/admin/agreements/:id", (req) => {
    const s = app.requireAdmin(req);
    const a = app.db.agreement(Number(req.params["id"]));
    if (!a) throw new HttpError(404, "Not found.");
    const versions = app.db.all<VersionRow & { signed: number }>(
      "SELECT v.*, (SELECT COUNT(*) FROM signatures s WHERE s.agreement_version_id = v.id) AS signed FROM agreement_versions v WHERE v.agreement_id = ? ORDER BY v.id DESC",
      a.id,
    );
    return page(
      req,
      a.name,
      `<h1>${esc(a.name)}</h1><p class="meta">${a.kind} agreement · <code>${esc(a.slug)}</code> · rights holder ${esc(a.rights_holder)}</p>
       <h2>Published versions</h2>
       ${versions.length ? `<table><tr><th>Version</th><th>Published</th><th>SHA-256</th><th>Signatures</th><th></th></tr>${versions.map((v) => `<tr><td>${esc(v.version)}</td><td>${esc(v.published_at)}</td><td><code>${esc(v.sha256.slice(0, 16))}…</code></td><td>${v.signed}</td><td><a href="/agreements/${v.id}/text">Text</a></td></tr>`).join("")}</table>` : "<p>No versions yet.</p>"}
       <h2>Publish a new version</h2>
       <p class="note">Published versions can never be edited or deleted, so signed terms never change. Existing signatures stay bound to the version that was signed.</p>
       <form method="post" action="/admin/agreements/${a.id}/versions" class="card">${csrfField(s)}
         <label>Version <input name="version" required pattern="[0-9A-Za-z][0-9A-Za-z.\\-]{0,31}" placeholder="1.0"></label>
         <label>Agreement text (Markdown) <textarea name="body" rows="20" required maxlength="200000"></textarea></label>
         <label class="check"><input type="checkbox" name="confirm" value="yes" required> I confirm this text is final. It cannot be changed after publishing.</label>
         <button>Publish version</button>
       </form>`,
    );
  });

  app.router.on("POST", "/admin/agreements/:id/versions", async (req) => {
    const s = app.requireAdmin(req);
    const form = await app.checkCsrf(req, s);
    const a = app.db.agreement(Number(req.params["id"]));
    if (!a) throw new HttpError(404, "Not found.");
    const version = (form.get("version") ?? "").trim();
    const body = (form.get("body") ?? "").replace(/\r\n/g, "\n");
    if (!VERSION_RE.test(version)) throw new HttpError(400, "Invalid version label.");
    if (body.trim().length < 50) throw new HttpError(400, "The agreement text is too short.");
    if (form.get("confirm") !== "yes") throw new HttpError(400, "Confirm that the text is final.");
    if (app.db.get("SELECT 1 FROM agreement_versions WHERE agreement_id = ? AND version = ?", a.id, version)) throw new HttpError(409, "That version already exists. Publish a new version label instead.");
    const hash = sha256(body);
    app.db.run(
      "INSERT INTO agreement_versions (agreement_id, version, body, sha256, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?)",
      a.id,
      version,
      body,
      hash,
      new Date().toISOString(),
      s.githubId,
    );
    app.db.audit(`@${s.login}`, "agreement.publish", `${a.slug} v${version} sha256 ${hash}`);
    return redirect(`/admin/agreements/${a.id}`);
  });

  // ---- signatures & entities ----

  app.router.on("GET", "/admin/signatures", (req) => {
    app.requireAdmin(req);
    const q = (req.url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const rows = app.db.all<SignatureRow & { name: string; version: string }>(
      `SELECT s.*, a.name, v.version FROM signatures s JOIN agreement_versions v ON v.id = s.agreement_version_id JOIN agreements a ON a.id = v.agreement_id
       WHERE ? = '' OR s.github_login LIKE ? OR s.legal_name LIKE ? OR s.repository LIKE ? ORDER BY s.seq DESC LIMIT 500`,
      q,
      `%${q}%`,
      `%${q}%`,
      `%${q}%`,
    );
    return page(
      req,
      "Signatures",
      `<h1>Signed records</h1>
       <form method="get" class="inline"><input name="q" value="${esc(q)}" placeholder="Search login, name or repository"> <button>Search</button></form>
       <table><tr><th>#</th><th>Signer</th><th>Agreement</th><th>Signed (UTC)</th><th>IP</th><th>Context</th><th></th></tr>
       ${rows.map((r) => `<tr><td>${r.seq}</td><td>${esc(r.legal_name)}<br><small>@${esc(r.github_login)} (${r.github_id})${r.entity_name ? `<br>for ${esc(r.entity_name)}` : ""}</small></td><td>${esc(r.name)} v${esc(r.version)}</td><td>${esc(r.signed_at)}</td><td>${esc(r.ip)}</td><td>${esc(r.repository)}${r.pull_request ? ` #${r.pull_request}` : ""}</td><td><a href="/documents/${esc(r.id)}">Document</a></td></tr>`).join("")}
       </table>`,
    );
  });

  app.router.on("GET", "/admin/entities", (req) => {
    const s = app.requireAdmin(req);
    const rows = app.db.all<SignatureRow & { status: string; authorised: string; notes: string; name: string }>(
      `SELECT s.*, e.status, e.authorised, e.notes, a.name FROM signatures s JOIN entity_status e ON e.signature_id = s.id
       JOIN agreement_versions v ON v.id = s.agreement_version_id JOIN agreements a ON a.id = v.agreement_id ORDER BY e.status = 'pending' DESC, s.seq DESC`,
    );
    const items = rows
      .map((r) => {
        const ids = JSON.parse(r.authorised) as number[];
        return `<div class="card"><h3>${esc(r.entity_name)} <small>(${esc(r.status)})</small></h3>
          <p>Signed by ${esc(r.legal_name)}, ${esc(r.entity_title)} (@${esc(r.github_login)}) on ${esc(r.signed_at)} · ${esc(r.name)} · <a href="/documents/${esc(r.id)}">document</a></p>
          <p class="meta">Authorised account IDs: ${esc(ids.join(", ") || "none")}</p>
          <form method="post" action="/admin/entities/${esc(r.id)}">${csrfField(s)}
            <label>Status <select name="status">${["pending", "active", "revoked"].map((x) => `<option${x === r.status ? " selected" : ""}>${x}</option>`).join("")}</select></label>
            <label>Authorised contributors (GitHub logins, replaces the list) <input name="logins" placeholder="alice, bob"></label>
            <label>Verification notes <input name="notes" value="${esc(r.notes)}" maxlength="500"></label>
            <button>Save</button></form></div>`;
      })
      .join("");
    return page(req, "Entity approvals", `<h1>Entity agreements</h1><p class="note">Activate an entity only after verifying the signatory's authority (for example a signed letter on letterhead).</p>${items || "<p>No entity agreements yet.</p>"}`);
  });

  app.router.on("POST", "/admin/entities/:id", async (req) => {
    const s = app.requireAdmin(req);
    const form = await app.checkCsrf(req, s);
    const id = req.params["id"] ?? "";
    const current = app.db.get<{ authorised: string }>("SELECT authorised FROM entity_status WHERE signature_id = ?", id);
    if (!current) throw new HttpError(404, "Not found.");
    const status = form.get("status");
    if (status !== "pending" && status !== "active" && status !== "revoked") throw new HttpError(400, "Invalid status.");
    const logins = (form.get("logins") ?? "").trim();
    const authorised = logins ? (await resolveLogins(app, logins)).map((a) => a.id) : (JSON.parse(current.authorised) as number[]);
    const notes = (form.get("notes") ?? "").slice(0, 500);
    app.db.run("UPDATE entity_status SET status = ?, authorised = ?, notes = ?, updated_at = ?, updated_by = ? WHERE signature_id = ?", status, JSON.stringify(authorised), notes, new Date().toISOString(), s.githubId, id);
    app.db.audit(`@${s.login}`, "entity.update", `${id}: ${status}, authorised ${authorised.join(",")}`);
    for (const accountId of authorised) {
      app.enqueue(`recheck entity ${accountId}`, async () => {
        const { recheckForAccount } = await import("./verify.ts");
        await recheckForAccount(app.verifyContext(), accountId);
      });
    }
    return redirect("/admin/entities");
  });

  // ---- administrators, audit, integrity ----

  app.router.on("GET", "/admin/admins", (req) => {
    const s = app.requireAdmin(req);
    const rows = app.db.all<{ github_id: number; login: string; added_at: string }>("SELECT * FROM admins ORDER BY login");
    return page(
      req,
      "Administrators",
      `<h1>Administrators</h1><table><tr><th>Account</th><th>Added</th><th></th></tr>
       ${rows.map((r) => `<tr><td>@${esc(r.login)} (${r.github_id})</td><td>${esc(r.added_at)}</td><td>${r.github_id === s.githubId ? "you" : `<form method="post" action="/admin/admins/remove">${csrfField(s)}<input type="hidden" name="id" value="${r.github_id}"><button class="link">Remove</button></form>`}</td></tr>`).join("")}
       </table>
       <form method="post" action="/admin/admins" class="card">${csrfField(s)}<label>Add administrator (GitHub login) <input name="login" required></label><button>Add</button></form>`,
    );
  });

  app.router.on("POST", "/admin/admins", async (req) => {
    const s = app.requireAdmin(req);
    const form = await app.checkCsrf(req, s);
    const [user] = await resolveLogins(app, form.get("login") ?? "");
    if (!user) throw new HttpError(400, "Enter a GitHub login.");
    app.db.run("INSERT OR IGNORE INTO admins (github_id, login, added_at) VALUES (?, ?, ?)", user.id, user.login, new Date().toISOString());
    app.db.audit(`@${s.login}`, "admin.add", `@${user.login} (${user.id})`);
    return redirect("/admin/admins");
  });

  app.router.on("POST", "/admin/admins/remove", async (req) => {
    const s = app.requireAdmin(req);
    const form = await app.checkCsrf(req, s);
    const id = Number(form.get("id"));
    if (id === s.githubId) throw new HttpError(400, "You cannot remove yourself.");
    app.db.run("DELETE FROM admins WHERE github_id = ?", id);
    app.db.audit(`@${s.login}`, "admin.remove", String(id));
    return redirect("/admin/admins");
  });

  app.router.on("GET", "/admin/audit", (req) => {
    app.requireAdmin(req);
    const rows = app.db.all<{ id: number; at: string; actor: string; action: string; detail: string }>("SELECT * FROM audit_log ORDER BY id DESC LIMIT 500");
    return page(req, "Audit log", `<h1>Audit log</h1><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>${rows.map((r) => `<tr><td>${esc(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join("")}</table>`);
  });

  app.router.on("GET", "/admin/integrity", async (req) => {
    const s = app.requireAdmin(req);
    const problems = await verifyIntegrity(app);
    app.db.audit(`@${s.login}`, "integrity.check", problems.length ? `${problems.length} problem(s)` : "intact");
    return page(
      req,
      "Integrity",
      problems.length
        ? `<h1>⚠️ Integrity problems found</h1><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
        : `<h1>✅ All records intact</h1><p>Every signed record matches its hash, the hash chain is unbroken and every stored document is unmodified.</p>`,
    );
  });
}
