import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Browser, csrf, startServer, type FakeGitHub } from "./harness.ts";
import { buildManifest } from "../src/setup.ts";
import { createBackup, restoreBackup } from "../src/backup.ts";
import { verifyIntegrity } from "../src/sign.ts";
import { Db } from "../src/db.ts";

const AGREEMENT = `# Example Individual Contributor Licence Agreement

You keep copyright in your contributions and grant Example Pty Ltd a licence to use them.

## 1. Grant

**Perpetual**, irrevocable licence. <script>alert(1)</script>`;

/** Full setup: App via manifest, first admin, agreement, repository enabled. */
async function configured() {
  const env = await startServer();
  const admin = new Browser(env.base);

  // 1. Setup token unlocks setup; the manifest form posts to GitHub.
  assert.equal((await admin.request("/setup")).status, 403);
  assert.equal((await admin.request("/setup?token=wrong")).status, 403);
  const unlocked = await admin.request("/setup?token=setup-token-123");
  assert.equal(unlocked.status, 303);
  const form = await admin.request("/setup/manifest", { form: { name: "PactDock CLA", ownerType: "org", org: "aspec" } });
  assert.match(form.text, /action="https:\/\/github\.test\/organizations\/aspec\/settings\/apps\/new\?state=([^"]+)"/);
  const state = /state=([^"]+)"/.exec(form.text)![1]!;

  // 2. GitHub redirects back with a code; credentials are stored encrypted.
  const cb = await admin.request(`/setup/callback?code=abc123&state=${state}`);
  assert.equal(cb.status, 200, cb.text);
  assert.equal(env.app.db.setting("app_id"), "4242");
  assert.match(env.app.db.setting("private_key")!, /^v1:/);
  assert.ok(!env.app.db.setting("private_key")!.includes("PRIVATE KEY"));

  // 3. First sign-in with the setup cookie becomes the administrator.
  const login = await admin.signIn("code-admin", "/admin");
  assert.equal(login.location, "/admin");
  assert.ok(env.app.db.isAdmin(900));

  // 4. Sync repositories, create and publish an agreement, enable the repository.
  const overview = await admin.request("/admin");
  await admin.request("/admin/sync", { form: { csrf: csrf(overview.text) } });
  assert.ok(env.app.db.repo(500));
  const agreements = await admin.request("/admin/agreements");
  const created = await admin.request("/admin/agreements", {
    form: { csrf: csrf(agreements.text), name: "Example Individual CLA", slug: "example-icla", kind: "individual", rightsHolder: "Example Pty Ltd" },
  });
  const agreementPage = await admin.request(created.location);
  await admin.request(`${created.location}/versions`, { form: { csrf: csrf(agreementPage.text), version: "1.0", body: AGREEMENT, confirm: "yes" } });
  const repoPage = await admin.request("/admin/repos/500");
  const saved = await admin.request("/admin/repos/500", {
    form: { csrf: csrf(repoPage.text), enabled: "1", individual: "1", policy: "current", coAuthors: "1", comment: "1", allowlist: "" },
  });
  assert.equal(saved.status, 303, saved.text);
  assert.equal(env.app.db.repo(500)!.enabled, 1);
  return { ...env, admin };
}

async function deliver(base: string, gh: FakeGitHub, event: string, payload: unknown, delivery = Math.random().toString(36)) {
  const body = JSON.stringify(payload);
  return fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": gh.sign(body) },
    body,
  });
}

const prEvent = { action: "opened", installation: { id: 9 }, repository: { id: 500, full_name: "aspec/widget" }, pull_request: { number: 7 } };

test("manifest requests only PR, checks, metadata and email permissions", () => {
  const m = buildManifest("https://cla.example.com", "PactDock");
  assert.deepEqual(m["default_permissions"], { pull_requests: "write", checks: "write", metadata: "read", email_addresses: "read" });
  assert.deepEqual(m["default_events"], ["pull_request", "check_run"]);
  assert.equal(m["public"], false);
  assert.deepEqual(m["hook_attributes"], { url: "https://cla.example.com/webhook", active: true });
});

test("end to end: unsigned PR blocked, contributor signs, check passes", async () => {
  const env = await configured();
  try {
    const { gh, app, base } = env;

    // Webhook: bad signatures rejected, valid ones processed.
    const bad = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=00" }, body: "{}" });
    assert.equal(bad.status, 401);
    assert.equal((await deliver(base, gh, "pull_request", prEvent, "d1")).status, 202);
    assert.equal(((await (await deliver(base, gh, "pull_request", prEvent, "d1")).json()) as { duplicate?: boolean }).duplicate, true);
    await app.idle();

    // Both the author and the co-author (unknown email yet -> unresolved) block the PR.
    let run = gh.checkRuns.at(-1)!;
    assert.equal(run.conclusion, "action_required");
    assert.match(run.details_url, new RegExp(`^${base}/sign/`));
    assert.match(gh.comments[0]!.body, /contributor agreement required/);
    assert.match(gh.comments[0]!.body, /@alice/);
    assert.match(gh.comments[0]!.body, /not linked to a GitHub account/);
    // Installation tokens are limited to the repository and minimal permissions.
    assert.deepEqual(gh.tokenRequests.at(-1), { permissions: { pull_requests: "write", checks: "write", metadata: "read" }, repository_ids: [500] });

    // Alice signs through the portal.
    const alice = new Browser(base);
    const signPath = new URL(run.details_url).pathname;
    const first = await alice.request(signPath);
    assert.equal(first.status, 303);
    assert.match(first.location, /^\/auth\/login/);
    await alice.signIn("code-alice", signPath);
    const formPage = await alice.request(signPath);
    assert.match(formPage.text, /Example Individual CLA/);
    assert.ok(!formPage.text.includes("<script>alert(1)</script>"), "agreement text is escaped");
    const versionId = /name="version" value="(\d+)"/.exec(formPage.text)![1]!;

    // Validation: agreement must be ticked; email must be a verified GitHub email.
    const missing = await alice.request(signPath, { form: { csrf: csrf(formPage.text), version: versionId, legalName: "Alice Example", signatureType: "typed", typedSignature: "Alice Example" } });
    assert.match(missing.text, /must confirm/);
    const badEmail = await alice.request(signPath, {
      form: { csrf: csrf(formPage.text), version: versionId, legalName: "Alice Example", email: "someone@else.com", signatureType: "typed", typedSignature: "Alice Example", agree: "yes" },
    });
    assert.match(badEmail.text, /verified GitHub email/);
    const forged = await alice.request(signPath, { form: { csrf: "forged", version: versionId, agree: "yes" } });
    assert.equal(forged.status, 403);

    const signed = await alice.request(signPath, {
      form: { csrf: csrf(formPage.text), version: versionId, legalName: "Alice Example", email: "alice@example.com", signatureType: "drawn", strokes: "10,10 20,20 30,30;40,40 50,50 60,60", agree: "yes" },
    });
    assert.equal(signed.status, 303, signed.text);
    await app.idle();

    const row = app.db.get<Record<string, unknown>>("SELECT * FROM signatures WHERE github_id = 101")!;
    assert.equal(row["legal_name"], "Alice Example");
    assert.equal(row["ip"], "127.0.0.1");
    assert.equal(row["signature_type"], "drawn");
    assert.equal(row["pull_request"], 7);
    assert.equal(row["prev_record_sha256"], "0".repeat(64));
    // Records are immutable at the database level.
    assert.throws(() => app.db.run("UPDATE signatures SET legal_name = 'X'"), /immutable/);
    assert.throws(() => app.db.run("DELETE FROM signatures"), /immutable/);
    assert.throws(() => app.db.run("UPDATE agreement_versions SET body = 'changed'"), /immutable/);

    // The recheck after signing: Alice is covered; co-author Bob still unresolved (no signature/email on file).
    run = gh.checkRuns.at(-1)!;
    assert.equal(run.conclusion, "action_required");
    assert.match(run.summary, /Covered:\*\* @alice/);

    // Bob signs; his verified email now resolves the co-author trailer and the PR passes.
    const bob = new Browser(base);
    await bob.signIn("code-bob", signPath);
    const bobForm = await bob.request(signPath);
    await bob.request(signPath, { form: { csrf: csrf(bobForm.text), version: versionId, legalName: "Bob Builder", signatureType: "typed", typedSignature: "Bob Builder", agree: "yes" } });
    await app.idle();
    await deliver(base, gh, "pull_request", { ...prEvent, action: "synchronize" });
    await app.idle();
    run = gh.checkRuns.at(-1)!;
    assert.equal(run.conclusion, "success", run.summary);
    assert.match(gh.comments[0]!.body, /all contributors are covered/);
    assert.equal(gh.comments.length, 1, "the status comment is updated, not duplicated");

    // Already signed: revisiting the link shows the existing record.
    assert.match((await alice.request(signPath)).text, /already signed/);

    // Downloads: owner via session, others not, tokens work, and the document is self-contained.
    const id = row["id"] as string;
    const doc = await alice.request(`/documents/${id}`);
    assert.equal(doc.status, 200);
    assert.match(doc.text, /Alice Example/);
    assert.match(doc.text, /<svg/);
    assert.match(doc.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal((await bob.request(`/documents/${id}`)).status, 404);
    assert.equal((await new Browser(base).request(`/documents/${id}?t=nope`)).status, 404);
    const token = app.createLink("download", id, 60_000);
    assert.equal((await new Browser(base).request(`/documents/${id}?t=${token}`)).status, 200);
    assert.match((await alice.request("/my")).text, /Example Individual CLA v1\.0/);

    // Integrity: intact, then detects a tampered document.
    assert.deepEqual(await verifyIntegrity(app), []);
    const docPath = join(env.dataDir, "documents", row["document_key"] as string);
    chmodSync(docPath, 0o644);
    writeFileSync(docPath, readFileSync(docPath, "utf8").replace("Alice Example", "Mallory"));
    assert.match((await verifyIntegrity(app)).join("\n"), /was modified/);

    // Audit log is append-only.
    assert.ok(app.db.get("SELECT 1 FROM audit_log WHERE action = 'signature.individual'"));
    assert.throws(() => app.db.run("DELETE FROM audit_log"), /append-only/);
  } finally {
    await env.close();
  }
});

test("expired or forged signing links are rejected", async () => {
  const env = await configured();
  try {
    const b = new Browser(env.base);
    const expired = env.app.vault.sign("sign", "500-7", new Date(Date.now() - 1000));
    assert.equal((await b.request(`/sign/${expired}`)).status, 410);
    assert.equal((await b.request(`/sign/500-7.zz.forged`)).status, 410);
  } finally {
    await env.close();
  }
});

test("verification errors fail closed with a failing check", async () => {
  const env = await configured();
  try {
    env.gh.commits = Array.from({ length: 251 }, (_, i) => ({ sha: String(i), commit: { message: "x", author: null, committer: null }, author: null, committer: null }));
    // Paginated fake returns all 251 in one page; more than 250 must fail closed.
    await deliver(env.base, env.gh, "pull_request", prEvent);
    await env.app.idle();
    const run = env.gh.checkRuns.at(-1)!;
    assert.equal(run.conclusion, "failure");
    assert.match(run.summary, /250/);
  } finally {
    await env.close();
  }
});

test("entity agreements stay pending until an administrator activates them", async () => {
  const env = await configured();
  try {
    const { app, admin, base } = env;
    // Add an entity agreement and assign it.
    const page = await admin.request("/admin/agreements");
    const created = await admin.request("/admin/agreements", { form: { csrf: csrf(page.text), name: "Example Entity CLA", slug: "example-ecla", kind: "entity", rightsHolder: "Example Pty Ltd" } });
    const ap = await admin.request(created.location);
    await admin.request(`${created.location}/versions`, { form: { csrf: csrf(ap.text), version: "1.0", body: AGREEMENT.replace("Individual", "Entity"), confirm: "yes" } });
    const rp = await admin.request("/admin/repos/500");
    await admin.request("/admin/repos/500", { form: { csrf: csrf(rp.text), enabled: "1", individual: "1", entity: "2", policy: "current", coAuthors: "0", comment: "1", allowlist: "" } });

    const alice = new Browser(base);
    const link = new URL(env.app.vault.sign("sign", "500-7", new Date(Date.now() + 60_000)), base).pathname;
    const path = `/sign/${link.slice(1)}?as=entity`;
    await alice.signIn("code-alice", path);
    const f = await alice.request(path);
    assert.match(f.text, /Entity's full legal name/);
    const done = await alice.request(path, {
      form: { csrf: csrf(f.text), version: /name="version" value="(\d+)"/.exec(f.text)![1]!, entityName: "Acme Widgets Pty Ltd", entityTitle: "Director", legalName: "Alice Example", signatureType: "typed", typedSignature: "Alice Example", authority: "yes", agree: "yes" },
    });
    assert.equal(done.status, 303, done.text);
    await deliver(base, env.gh, "pull_request", prEvent);
    await app.idle();
    assert.equal(env.gh.checkRuns.at(-1)!.conclusion, "action_required");
    assert.match(env.gh.checkRuns.at(-1)!.summary, /awaiting approval/);

    const sigId = app.db.get<{ id: string }>("SELECT id FROM signatures WHERE entity_name IS NOT NULL")!.id;
    const ep = await admin.request("/admin/entities");
    await admin.request(`/admin/entities/${sigId}`, { form: { csrf: csrf(ep.text), status: "active", logins: "alice", notes: "Verified letter 2026-10-20" } });
    await app.idle();
    assert.equal(env.gh.checkRuns.at(-1)!.conclusion, "success");
  } finally {
    await env.close();
  }
});

test("non-admins cannot reach the admin portal; setup cannot be re-run", async () => {
  const env = await configured();
  try {
    const alice = new Browser(env.base);
    await alice.signIn("code-alice", "/");
    assert.equal((await alice.request("/admin")).status, 403);
    assert.equal(env.app.db.isAdmin(101), false, "only the setup holder became admin");
    assert.match((await alice.request("/setup")).text, /Already connected/);
    const p = await env.admin.request("/admin/agreements/1");
    const dup = await env.admin.request("/admin/agreements/1/versions", { form: { csrf: csrf(p.text), version: "1.0", body: AGREEMENT, confirm: "yes" } });
    assert.equal(dup.status, 409, "a published version can never be replaced");
  } finally {
    await env.close();
  }
});

test("encrypted backup round trip", async () => {
  const env = await configured();
  try {
    const out = mkdtempSync(join(tmpdir(), "pactdock-bk-"));
    const file = await createBackup(env.app.db, env.dataDir, out, "correct horse battery", 3);
    assert.ok(!readFileSync(file).includes(Buffer.from("Example Individual CLA")), "backup is encrypted");
    assert.throws(() => restoreBackup(file, "wrong passphrase!!", mkdtempSync(join(tmpdir(), "r-"))), /could not be decrypted/);
    const target = mkdtempSync(join(tmpdir(), "pactdock-restore-"));
    restoreBackup(file, "correct horse battery", target);
    const restored = new Db(join(target, "pactdock.db"));
    assert.equal(restored.get<{ n: number }>("SELECT COUNT(*) AS n FROM agreement_versions")!.n, 1);
    restored.close();
    assert.throws(() => restoreBackup(file, "correct horse battery", target), /already contains/);
    await assert.rejects(createBackup(env.app.db, env.dataDir, out, "short", 3), /at least 12/);
  } finally {
    await env.close();
  }
});
