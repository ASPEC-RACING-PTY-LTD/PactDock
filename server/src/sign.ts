// Signing portal, signed-document downloads and email-based recovery.

import { randomUUID } from "node:crypto";
import type { App, Session } from "./app.ts";
import { canonicalJson, sha256 } from "./crypto.ts";
import type { AgreementRow, RepoRow, SignatureRow, VersionRow } from "./db.ts";
import { normaliseStrokes, renderSignedDocument } from "./documents.ts";
import { esc, markdown } from "./html.ts";
import { isEmail } from "./mailer.ts";
import { acceptedVersions, recheckForAccount } from "./verify.ts";
import { HttpError, redirect, text, type Request, type Response } from "./web.ts";

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,'’-]{1,119}$/u;
const ENTITY_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\/-]{1,149}$/u;
const TITLE_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\/-]{1,79}$/u;

interface SignTarget {
  repo: RepoRow;
  pr: number | null;
  agreement: AgreementRow;
  version: VersionRow;
  kind: "individual" | "entity";
}

function target(app: App, token: string, kind: "individual" | "entity"): SignTarget {
  const payload = app.vault.verify("sign", token);
  if (!payload) throw new HttpError(410, "This signing link has expired. Open the latest link from the PactDock check or comment on your pull request.");
  const [repoId, pr] = payload.split("-").map(Number);
  const repo = app.db.repo(repoId ?? 0);
  if (!repo || !repo.enabled || repo.removed) throw new HttpError(404, "This repository does not use PactDock any more.");
  const agreementId = kind === "entity" ? repo.entity_agreement_id : repo.individual_agreement_id;
  const agreement = agreementId ? app.db.agreement(agreementId) : undefined;
  const version = agreementId ? app.db.currentVersion(agreementId) : undefined;
  if (!agreement || !version) throw new HttpError(404, kind === "entity" ? "This repository has no entity agreement." : "This repository has no published agreement.");
  return { repo, pr: pr ? pr : null, agreement, version, kind };
}

function existingSignature(app: App, t: SignTarget, githubId: number): SignatureRow | undefined {
  const ids = acceptedVersions(app.db, t.agreement.id, t.repo.version_policy).map((v) => v.id);
  return app.db.get<SignatureRow>(
    `SELECT * FROM signatures WHERE github_id = ? AND entity_name IS NULL AND agreement_version_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq DESC LIMIT 1`,
    githubId,
    ...ids,
  );
}

export interface NewSignature {
  session: Session;
  target: SignTarget;
  legalName: string;
  email: string | null;
  entityName: string | null;
  entityTitle: string | null;
  signatureType: "typed" | "drawn";
  signatureData: string;
  ip: string;
  userAgent: string;
}

/** Creates the immutable signed record and its document. Returns the record ID. */
export async function createSignature(app: App, n: NewSignature): Promise<string> {
  const id = randomUUID();
  const signedAt = new Date().toISOString();
  const t = n.target;
  const document = renderSignedDocument({
    id,
    agreementName: t.agreement.name,
    version: t.version.version,
    rightsHolder: t.agreement.rights_holder,
    agreementBody: t.version.body,
    agreementSha256: t.version.sha256,
    legalName: n.legalName,
    githubLogin: n.session.login,
    githubId: n.session.githubId,
    email: n.email,
    entityName: n.entityName,
    entityTitle: n.entityTitle,
    signatureType: n.signatureType,
    signatureData: n.signatureData,
    signedAt,
    ip: n.ip,
    userAgent: n.userAgent,
    repository: t.repo.full_name,
    pullRequest: t.pr,
    serverUrl: app.settings.publicUrl,
  });
  const documentKey = `signatures/${t.agreement.slug}/${signedAt.slice(0, 7)}/${id}.html`;
  const documentBuffer = Buffer.from(document, "utf8");
  // Stored once (write-once) before the record exists, so a record never points at a missing document.
  await app.documents.put(documentKey, documentBuffer, "text/html; charset=utf-8");

  app.db.transaction(() => {
    const last = app.db.lastSignature();
    const record = {
      id,
      seq: (last?.seq ?? 0) + 1,
      agreement_version_id: t.version.id,
      github_id: n.session.githubId,
      github_login: n.session.login,
      legal_name: n.legalName,
      email: n.email,
      email_hash: n.email ? app.vault.emailHash(n.email) : null,
      entity_name: n.entityName,
      entity_title: n.entityTitle,
      signature_type: n.signatureType,
      signature_data: n.signatureData,
      signed_at: signedAt,
      ip: n.ip,
      user_agent: n.userAgent,
      repository: t.repo.full_name,
      pull_request: t.pr,
      agreement_sha256: t.version.sha256,
      document_key: documentKey,
      document_sha256: sha256(documentBuffer),
      prev_record_sha256: last?.record_sha256 ?? "0".repeat(64),
    };
    const recordSha = sha256(canonicalJson(record));
    app.db.run(
      `INSERT INTO signatures (id, seq, agreement_version_id, github_id, github_login, legal_name, email, email_hash, entity_name, entity_title,
        signature_type, signature_data, signed_at, ip, user_agent, repository, pull_request, agreement_sha256, document_key, document_sha256,
        prev_record_sha256, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.seq,
      record.agreement_version_id,
      record.github_id,
      record.github_login,
      record.legal_name,
      record.email,
      record.email_hash,
      record.entity_name,
      record.entity_title,
      record.signature_type,
      record.signature_data,
      record.signed_at,
      record.ip,
      record.user_agent,
      record.repository,
      record.pull_request,
      record.agreement_sha256,
      record.document_key,
      record.document_sha256,
      record.prev_record_sha256,
      recordSha,
    );
    if (n.entityName) {
      app.db.run(
        "INSERT INTO entity_status (signature_id, status, authorised, updated_at) VALUES (?, 'pending', ?, ?)",
        id,
        JSON.stringify([n.session.githubId]),
        signedAt,
      );
    }
    // Verified emails (hashed) let co-author trailers be matched to this account.
    for (const email of n.session.emails) {
      app.db.run("INSERT OR IGNORE INTO email_identities (email_hash, github_id, seen_at) VALUES (?, ?, ?)", app.vault.emailHash(email), n.session.githubId, signedAt);
    }
    app.db.audit(`@${n.session.login}`, n.entityName ? "signature.entity" : "signature.individual", `${t.agreement.slug} v${t.version.version} record ${id}`);
  });
  return id;
}

/** Recomputes the hash chain and document hashes. Returns a list of problems (empty = intact). */
export async function verifyIntegrity(app: App): Promise<string[]> {
  const problems: string[] = [];
  let prev = "0".repeat(64);
  for (const row of app.db.all<SignatureRow>("SELECT * FROM signatures ORDER BY seq")) {
    const { record_sha256, ...rest } = row;
    if (row.prev_record_sha256 !== prev) problems.push(`Record ${row.id} (seq ${row.seq}) breaks the hash chain.`);
    if (sha256(canonicalJson(rest)) !== record_sha256) problems.push(`Record ${row.id} (seq ${row.seq}) does not match its hash.`);
    const doc = await app.documents.get(row.document_key);
    if (!doc) problems.push(`Document for record ${row.id} is missing.`);
    else if (sha256(doc) !== row.document_sha256) problems.push(`Document for record ${row.id} was modified.`);
    prev = record_sha256;
  }
  return problems;
}

function signForm(app: App, req: Request, s: Session, t: SignTarget, token: string, error = ""): Response {
  const entity = t.kind === "entity";
  const emailOptions = s.emails.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join("");
  const otherKind =
    !entity && t.repo.entity_agreement_id
      ? `<p class="note">Signing on behalf of a company or other organisation? <a href="/sign/${esc(token)}?as=entity">Use the entity agreement instead</a>.</p>`
      : entity
        ? `<p class="note">Contributing only for yourself? <a href="/sign/${esc(token)}">Use the individual agreement</a>.</p>`
        : "";
  return app.page(
    req,
    `Sign: ${t.agreement.name}`,
    `<h1>${esc(t.agreement.name)}</h1>
     <p class="meta">Version ${esc(t.version.version)} · in favour of ${esc(t.agreement.rights_holder)} · for <strong>${esc(t.repo.full_name)}</strong>${t.pr ? ` pull request #${t.pr}` : ""}</p>
     ${otherKind}
     ${error ? `<p class="error">${esc(error)}</p>` : ""}
     <section class="agreement" tabindex="0" aria-label="Agreement text">${markdown(t.version.body)}</section>
     <p class="meta">SHA-256 of this exact text: <code>${esc(t.version.sha256)}</code> · <a href="/agreements/${t.version.id}/text">Download the exact text</a></p>
     <form method="post" action="/sign/${esc(token)}${entity ? "?as=entity" : ""}" class="card" id="sign-form">
       <input type="hidden" name="csrf" value="${esc(s.csrf)}">
       <input type="hidden" name="version" value="${t.version.id}">
       <p>You are signed in as <strong>@${esc(s.login)}</strong> (GitHub ID ${s.githubId}).</p>
       ${
         entity
           ? `<label>Entity's full legal name <input name="entityName" required maxlength="150"></label>
              <label>Your title or position <input name="entityTitle" required maxlength="80"></label>`
           : ""
       }
       <label>Your full legal name <input name="legalName" required maxlength="120" autocomplete="name"></label>
       <label>Email for your signed copy and recovery (optional)
         <select name="email"><option value="">Do not store an email</option>${emailOptions}</select></label>
       <fieldset><legend>Signature</legend>
         <label class="inline"><input type="radio" name="signatureType" value="typed" checked> Type my name</label>
         <label class="inline"><input type="radio" name="signatureType" value="drawn"> Draw my signature</label>
         <label>Typed signature <input name="typedSignature" maxlength="120" class="typed-signature"></label>
         <div class="pad-wrap"><canvas id="pad" width="600" height="200" aria-label="Draw your signature"></canvas>
         <button type="button" id="pad-clear" class="link">Clear drawing</button></div>
         <input type="hidden" name="strokes" id="strokes">
       </fieldset>
       ${entity ? `<label class="check"><input type="checkbox" name="authority" value="yes" required> I am authorised to sign this agreement on behalf of the entity named above.</label>` : ""}
       <label class="check"><input type="checkbox" name="agree" value="yes" required> I have read the ${esc(t.agreement.name)} version ${esc(t.version.version)} above and I agree to its terms${entity ? " on behalf of the entity" : ""}.</label>
       <p class="note">Your GitHub account, the time, your IP address and browser are recorded as evidence. The signed terms never change after you sign.</p>
       <button>Sign the agreement</button>
     </form>
     <script src="/static/sign.js"></script>`,
  );
}

export function registerSignRoutes(app: App): void {
  app.router.on("GET", "/agreements/:id/text", (req) => {
    const v = app.db.version(Number(req.params["id"]));
    if (!v) throw new HttpError(404, "Not found.");
    return { ...text(v.body), headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="agreement-${v.id}.md"` } };
  });

  app.router.on("GET", "/sign/:token", (req) => {
    const kind = req.url.searchParams.get("as") === "entity" ? "entity" : "individual";
    const token = req.params["token"] ?? "";
    const t = target(app, token, kind);
    const s = app.requireSession(req);
    if (kind === "individual") {
      const existing = existingSignature(app, t, s.githubId);
      if (existing) {
        return app.page(
          req,
          "Already signed",
          `<h1>You have already signed</h1><p>Your signature of the ${esc(t.agreement.name)} (recorded ${esc(existing.signed_at)}) covers this pull request and your future contributions. The check updates automatically.</p>
           <p><a class="button" href="/signed/${esc(existing.id)}">View and download your copy</a></p>`,
        );
      }
    }
    return signForm(app, req, s, t, token);
  });

  app.router.on("POST", "/sign/:token", async (req) => {
    const kind = req.url.searchParams.get("as") === "entity" ? "entity" : "individual";
    const token = req.params["token"] ?? "";
    const t = target(app, token, kind);
    const s = app.requireSession(req);
    const form = await app.checkCsrf(req, s);
    if (!app.limits.sign.allow(`${s.githubId}`)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
    const fail = (message: string) => signForm(app, req, s, t, token, message);

    if (Number(form.get("version")) !== t.version.id) return fail("A new version of this agreement was published while you were reading. Please review it and sign again.");
    if (form.get("agree") !== "yes") return fail("You must confirm that you have read and agree to the agreement.");
    const legalName = (form.get("legalName") ?? "").trim().replace(/\s+/g, " ");
    if (!NAME_RE.test(legalName)) return fail("Enter your full legal name (letters, spaces, apostrophes and hyphens).");
    const email = (form.get("email") ?? "").trim();
    if (email && (!isEmail(email) || !s.emails.includes(email))) return fail("Choose one of your verified GitHub email addresses.");

    let entityName: string | null = null;
    let entityTitle: string | null = null;
    if (kind === "entity") {
      entityName = (form.get("entityName") ?? "").trim().replace(/\s+/g, " ");
      entityTitle = (form.get("entityTitle") ?? "").trim().replace(/\s+/g, " ");
      if (!ENTITY_RE.test(entityName)) return fail("Enter the entity's full legal name.");
      if (!TITLE_RE.test(entityTitle)) return fail("Enter your title or position.");
      if (form.get("authority") !== "yes") return fail("Confirm that you are authorised to sign for the entity.");
    } else if (existingSignature(app, t, s.githubId)) {
      return redirect("/my");
    }

    const type = form.get("signatureType") === "drawn" ? "drawn" : "typed";
    let signatureData: string;
    if (type === "typed") {
      signatureData = (form.get("typedSignature") ?? "").trim().replace(/\s+/g, " ");
      if (!NAME_RE.test(signatureData)) return fail("Type your name as your signature.");
    } else {
      const strokes = normaliseStrokes(form.get("strokes") ?? "");
      if (!strokes) return fail("Draw your signature in the box (or choose to type it).");
      signatureData = strokes;
    }

    const id = await createSignature(app, {
      session: s,
      target: t,
      legalName,
      email: email || null,
      entityName,
      entityTitle,
      signatureType: type,
      signatureData,
      ip: req.ip,
      userAgent: req.userAgent,
    });
    app.enqueue(`recheck @${s.login}`, () => recheckForAccount(app.verifyContext(), s.githubId));
    if (email && app.mailer) {
      const link = app.createLink("download", id, 7 * 864e5);
      app.enqueue(`email copy ${id}`, () =>
        app.mailer!.send({
          to: email,
          subject: `Your signed ${t.agreement.name}`,
          text: `You signed the ${t.agreement.name} version ${t.version.version} on ${new Date().toUTCString()}.\n\nDownload your copy (link valid for 7 days):\n${app.settings.publicUrl}/documents/${id}?t=${link}\n\nYou can always find it again at ${app.settings.publicUrl}/my or ${app.settings.publicUrl}/recover.\n`,
        }),
      );
    }
    return redirect(`/signed/${id}`);
  });

  app.router.on("GET", "/signed/:id", (req) => {
    const s = app.requireSession(req);
    const row = app.db.signature(req.params["id"] ?? "");
    if (!row || (row.github_id !== s.githubId && !s.admin)) throw new HttpError(404, "Not found.");
    const v = app.db.version(row.agreement_version_id)!;
    const a = app.db.agreement(v.agreement_id)!;
    const pending = row.entity_name ? app.db.get<{ status: string }>("SELECT status FROM entity_status WHERE signature_id = ?", row.id)?.status : null;
    return app.page(
      req,
      "Signed",
      `<h1>Signed</h1>
       <p>You signed the <strong>${esc(a.name)}</strong> version ${esc(v.version)}${row.entity_name ? ` on behalf of <strong>${esc(row.entity_name)}</strong>` : ""} on ${esc(row.signed_at)}.</p>
       ${pending === "pending" ? `<p class="note">Entity agreements take effect once a maintainer has verified your authority and the list of authorised contributors.</p>` : `<p>Your pull request checks are being updated now.</p>`}
       <p><a class="button" href="/documents/${esc(row.id)}">Download your signed copy</a></p>
       <p class="meta">Record ${esc(row.id)} · record hash <code>${esc(row.record_sha256)}</code></p>`,
    );
  });

  app.router.on("GET", "/my", (req) => {
    const s = app.requireSession(req);
    const rows = app.db.all<SignatureRow & { name: string; version: string }>(
      `SELECT s.*, a.name, v.version FROM signatures s JOIN agreement_versions v ON v.id = s.agreement_version_id JOIN agreements a ON a.id = v.agreement_id
       WHERE s.github_id = ? ORDER BY s.seq DESC`,
      s.githubId,
    );
    const list = rows.length
      ? `<table><tr><th>Agreement</th><th>Signed</th><th>For</th><th></th></tr>${rows
          .map(
            (r) =>
              `<tr><td>${esc(r.name)} v${esc(r.version)}</td><td>${esc(r.signed_at)}</td><td>${r.entity_name ? esc(r.entity_name) : "Myself"}</td><td><a href="/documents/${esc(r.id)}">Download</a></td></tr>`,
          )
          .join("")}</table>`
      : "<p>You have not signed any agreements on this server.</p>";
    return app.page(req, "My agreements", `<h1>My signed agreements</h1>${list}`);
  });

  app.router.on("GET", "/documents/:id", async (req) => {
    const id = req.params["id"] ?? "";
    const row = app.db.signature(id);
    const token = req.url.searchParams.get("t");
    let allowed = false;
    if (token) allowed = app.link("download", token)?.subject === id;
    if (!allowed) {
      const s = app.session(req);
      if (!s && !token) return redirect(`/auth/login?next=${encodeURIComponent(`/documents/${id}`)}`);
      allowed = Boolean(s && row && (row.github_id === s.githubId || s.admin));
    }
    if (!row || !allowed) throw new HttpError(404, "This document link is invalid or has expired.");
    const doc = await app.documents.get(row.document_key);
    if (!doc) throw new HttpError(500, "The stored document is missing. Contact the administrator.");
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="signed-agreement-${row.id}.html"`,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      },
      body: doc,
    };
  });

  // ---- recovery by email ----

  app.router.on("GET", "/recover", (req) => {
    if (!app.mailer) return app.page(req, "Recover", `<h1>Find your signed agreements</h1><p>Sign in with GitHub to see everything you have signed.</p><p><a class="button" href="/auth/login?next=/my">Sign in with GitHub</a></p>`);
    return app.page(
      req,
      "Recover",
      `<h1>Find your signed agreements</h1>
       <p><a class="button" href="/auth/login?next=/my">Sign in with GitHub</a> to see everything you have signed, or have a link emailed to the address you chose when signing.</p>
       <form method="post" action="/recover" class="card"><label>Email address <input type="email" name="email" required maxlength="254"></label><button>Email me a link</button></form>`,
    );
  });

  app.router.on("POST", "/recover", async (req) => {
    if (!app.mailer) throw new HttpError(404, "Email recovery is not enabled.");
    const form = await req.form();
    const email = (form.get("email") ?? "").trim();
    const done = app.page(req, "Check your email", `<h1>Check your email</h1><p>If we hold signed agreements for that address, a link valid for 30 minutes is on its way.</p>`);
    if (!isEmail(email)) return done;
    const hash = app.vault.emailHash(email);
    // Limit by IP and by address; the response is identical either way (no account probing).
    if (!app.limits.recover.allow(`ip:${req.ip}`) || !app.limits.recover.allow(`email:${hash}`)) return done;
    if (!app.db.get("SELECT 1 FROM signatures WHERE email_hash = ? LIMIT 1", hash)) return done;
    const token = app.createLink("recovery", hash, 30 * 60_000);
    app.enqueue("recovery email", () =>
      app.mailer!.send({
        to: email,
        subject: "Your signed contributor agreements",
        text: `Use this link within 30 minutes to download your signed agreements:\n${app.settings.publicUrl}/recover/${token}\n\nIf you did not ask for this, ignore this email.\n`,
      }),
    );
    return done;
  });

  app.router.on("GET", "/recover/:token", (req) => {
    const link = app.link("recovery", req.params["token"] ?? "");
    if (!link) throw new HttpError(410, "This recovery link is invalid or has expired. Request a new one.");
    const rows = app.db.all<SignatureRow & { name: string; version: string }>(
      `SELECT s.*, a.name, v.version FROM signatures s JOIN agreement_versions v ON v.id = s.agreement_version_id JOIN agreements a ON a.id = v.agreement_id
       WHERE s.email_hash = ? ORDER BY s.seq DESC`,
      link.subject,
    );
    const items = rows
      .map((r) => `<li>${esc(r.name)} v${esc(r.version)}, signed ${esc(r.signed_at)}: <a href="/documents/${esc(r.id)}?t=${esc(app.createLink("download", r.id, 3600_000))}">download</a></li>`)
      .join("");
    return app.page(req, "Your agreements", `<h1>Your signed agreements</h1><ul>${items}</ul><p class="note">Download links are valid for one hour.</p>`);
  });
}
