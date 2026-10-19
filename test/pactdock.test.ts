import { test } from "node:test";
import assert from "node:assert/strict";
import { PactDock, sha256, type Context } from "../src/pactdock.ts";
import { individualPhrase, entityPhrase } from "../src/signing.ts";
import { COMMENT_MARKER } from "../src/report.ts";
import { FakeRepo, FakeStore, commit } from "./fakes.ts";

const ICLA_TEXT = "Individual CLA text v1.0\n";
const ECLA_TEXT = "Entity CLA text v1.0\n";

const ALICE = { id: 101, login: "alice" };
const BOB = { id: 202, login: "bob" };
const CAROL = { id: 303, login: "carol" };

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    rightsHolder: "ASPEC RACING PTY LTD",
    individual: { id: "aspec-icla", name: "ASPEC Individual CLA", version: "1.0", document: ".github/cla/ICLA.md" },
    entity: { id: "aspec-ecla", name: "ASPEC Entity CLA", version: "1.0", document: ".github/cla/ECLA.md" },
    storage: { repository: "aspec/cla-signatures" },
    allowlist: { accountIds: [49699333] },
    ...overrides,
  };
}

function setup(config: Record<string, unknown> = baseConfig()) {
  const repo = new FakeRepo();
  const store = new FakeStore();
  repo.files.set(".github/pactdock.json", JSON.stringify(config));
  repo.files.set(".github/cla/ICLA.md", ICLA_TEXT);
  repo.files.set(".github/cla/ECLA.md", ECLA_TEXT);
  repo.prs.set(7, {
    number: 7,
    state: "open",
    headSha: "a".repeat(40),
    author: { ...ALICE, type: "User" },
    htmlUrl: "https://github.com/aspec/widget/pull/7",
  });
  repo.commits.set(7, [commit("c1", [{ name: "Alice", email: "alice@example.com", ...ALICE }])]);
  return { repo, store };
}

const quiet = { info() {}, warning() {} };

function make(repo: FakeRepo, store: FakeStore, ctx: Partial<Context>) {
  const full: Context = {
    eventName: "pull_request_target",
    payload: { action: "opened", pull_request: { number: 7, head: { sha: "a".repeat(40) } } },
    serverUrl: "https://github.com",
    runUrl: "https://github.com/aspec/widget/actions/runs/1",
    configPath: ".github/pactdock.json",
    ...ctx,
  };
  return new PactDock(full, repo, async () => store, quiet, () => new Date("2026-10-20T03:00:00Z"));
}

function commentEvent(repo: FakeRepo, user: { id: number; login: string; type?: string }, body: string, opts: { edited?: boolean; sender?: number; action?: string } = {}): Partial<Context> {
  const c = repo.addUserComment(7, user, body, opts.edited);
  return {
    eventName: "issue_comment",
    payload: {
      action: opts.action ?? "created",
      issue: { number: 7, pull_request: { url: "x" } },
      comment: { id: c.id, body, user: { id: user.id, login: user.login, type: user.type ?? "User" } },
      sender: { id: opts.sender ?? user.id },
      repository: { id: 999 },
    },
  };
}

const ICLA_PATH = "signatures/individual/aspec-icla/101.json";
const phrase = individualPhrase({ id: "aspec-icla", name: "ASPEC Individual CLA", version: "1.0", document: "", acceptedVersions: ["1.0"] });

test("unsigned pull request fails and posts instructions", async () => {
  const { repo, store } = setup();
  const out = await make(repo, store, {}).run();
  assert.equal(out.result, "failed");
  assert.deepEqual(out.unsigned, ["alice"]);
  assert.equal(repo.statuses[0]?.state, "pending");
  assert.equal(repo.lastStatus()?.state, "failure");
  assert.equal(repo.lastStatus()?.context, "PactDock CLA");
  const body = repo.comments.get(7)?.[0]?.body ?? "";
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.ok(body.includes(phrase));
  assert.ok(body.includes("@alice"));
});

test("signing comment records evidence and turns the check green", async () => {
  const { repo, store } = setup();
  await make(repo, store, {}).run();
  const out = await make(repo, store, commentEvent(repo, { ...ALICE }, phrase)).run();
  assert.equal(out.result, "passed");
  assert.equal(repo.lastStatus()?.state, "success");
  const record = store.json(ICLA_PATH);
  assert.equal(record.schema, "pactdock/individual@1");
  assert.equal(record.account.id, 101);
  const sig = record.signatures[0];
  assert.equal(sig.version, "1.0");
  assert.equal(sig.documentSha256, sha256(ICLA_TEXT));
  assert.equal(sig.signedAt, "2026-10-20T01:02:03Z");
  assert.equal(sig.recordedAt, "2026-10-20T03:00:00.000Z");
  assert.equal(sig.evidence.commentSha256, sha256(phrase));
  assert.equal(sig.evidence.repositoryId, 999);
  assert.match(sig.documentUrl, /blob\/d{40}\/\.github\/cla\/ICLA\.md$/);
  assert.ok(repo.reactions.some((r) => r.content === "+1"));
  // The sticky comment is updated to success, not duplicated.
  assert.equal(repo.comments.get(7)?.filter((c) => c.body.startsWith(COMMENT_MARKER)).length, 1);
  assert.match(repo.comments.get(7)?.find((c) => c.body.startsWith(COMMENT_MARKER))?.body ?? "", /check passed/);
});

test("signed contributor passes on the next push with no comment created", async () => {
  const { repo, store } = setup();
  await make(repo, store, commentEvent(repo, { ...ALICE }, phrase)).run();
  repo.comments.set(7, []);
  const out = await make(repo, store, {}).run();
  assert.equal(out.result, "passed");
  assert.equal(repo.comments.get(7)?.length, 0);
});

test("duplicate delivery of the same comment is idempotent", async () => {
  const { repo, store } = setup();
  const ev = commentEvent(repo, { ...ALICE }, phrase);
  await make(repo, store, ev).run();
  await make(repo, store, ev).run();
  assert.equal(store.json(ICLA_PATH).signatures.length, 1);
  assert.equal(store.writes.length, 1);
});

test("store write conflicts are retried", async () => {
  const { repo, store } = setup();
  store.conflicts = 2;
  const out = await make(repo, store, commentEvent(repo, { ...ALICE }, phrase)).run();
  assert.equal(out.result, "passed");
});

test("non-contributors cannot sign on someone else's pull request", async () => {
  const { repo, store } = setup();
  const out = await make(repo, store, commentEvent(repo, { ...BOB }, phrase)).run();
  assert.equal(out.result, "skipped");
  assert.equal(store.writes.length, 0);
  assert.ok(repo.reactions.some((r) => r.content === "confused"));
});

test("edited comments, edit events and sender mismatch never sign", async () => {
  for (const opts of [{ edited: true }, { action: "edited" }, { sender: 555 }]) {
    const { repo, store } = setup();
    const out = await make(repo, store, commentEvent(repo, { ...ALICE }, phrase, opts)).run();
    assert.equal(out.result, "skipped", JSON.stringify(opts));
    assert.equal(store.writes.length, 0);
  }
});

test("bots cannot sign", async () => {
  const { repo, store } = setup();
  const out = await make(repo, store, commentEvent(repo, { ...ALICE, type: "Bot" }, phrase)).run();
  assert.equal(out.result, "skipped");
  assert.equal(store.writes.length, 0);
});

test("payload body that differs from the live comment is rejected", async () => {
  const { repo, store } = setup();
  const ev = commentEvent(repo, { ...ALICE }, phrase);
  (await repo.getComment(ev.payload!["comment"].id))!.body = "something else";
  const out = await make(repo, store, ev).run();
  assert.equal(out.result, "skipped");
  assert.equal(store.writes.length, 0);
});

test("old-version signature does not satisfy a new version unless accepted", async () => {
  const { repo, store } = setup();
  store.put(ICLA_PATH, {
    schema: "pactdock/individual@1",
    account: ALICE,
    signatures: [{ agreementId: "aspec-icla", version: "0.9", signedAt: "x", signer: ALICE, evidence: { method: "manual" } }],
  });
  assert.equal((await make(repo, store, {}).run()).result, "failed");
  const cfg = baseConfig();
  (cfg.individual as Record<string, unknown>)["acceptedVersions"] = ["0.9", "1.0"];
  repo.files.set(".github/pactdock.json", JSON.stringify(cfg));
  assert.equal((await make(repo, store, {}).run()).result, "passed");
});

test("a record for one account cannot vouch for another (fail closed)", async () => {
  const { repo, store } = setup();
  store.put(ICLA_PATH, {
    schema: "pactdock/individual@1",
    account: ALICE,
    signatures: [{ agreementId: "aspec-icla", version: "1.0", signedAt: "x", signer: BOB, evidence: { method: "manual" } }],
  });
  await assert.rejects(make(repo, store, {}).run(), /signature by another account/);
});

test("co-authors and commit authors must all sign; unresolved emails fail", async () => {
  const { repo, store } = setup();
  repo.commits.set(7, [
    commit("c1", [
      { name: "Alice", email: "alice@example.com", ...ALICE },
      { name: "Bob", email: "202+bob@users.noreply.github.com" },
      { name: "Mystery <b>Person</b> @everyone", email: "who@example.com" },
    ]),
    commit("c2", [{ name: "Carol", email: "carol@example.com", ...CAROL }]),
  ]);
  const out = await make(repo, store, {}).run();
  assert.equal(out.result, "failed");
  assert.deepEqual(out.unsigned.sort(), ["alice", "bob", "carol"]);
  const body = repo.comments.get(7)?.[0]?.body ?? "";
  assert.ok(body.includes("not linked to a GitHub account"));
  assert.ok(!body.includes("<b>"), "untrusted names are rendered inert");
  assert.ok(!body.includes("@everyone"));
});

test("co-author checking can be disabled", async () => {
  const { repo, store } = setup(baseConfig({ coAuthors: false }));
  repo.commits.set(7, [commit("c1", [{ name: "Alice", email: "a@x", ...ALICE }, { name: "Nobody", email: "n@x" }])]);
  await make(repo, store, commentEvent(repo, { ...ALICE }, phrase)).run();
  assert.equal(repo.lastStatus()?.state, "success");
});

test("allowlisted bot accounts are exempt by ID", async () => {
  const { repo, store } = setup();
  repo.prs.get(7)!.author = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
  repo.commits.set(7, [commit("c1", [{ name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" }])]);
  const out = await make(repo, store, {}).run();
  assert.equal(out.result, "passed");
});

test("entity signature is pending until a maintainer activates it", async () => {
  const { repo, store } = setup();
  const ephrase = entityPhrase(
    { id: "aspec-ecla", name: "ASPEC Entity CLA", version: "1.0", document: "", acceptedVersions: ["1.0"] },
    "Acme Widgets Pty Ltd",
  );
  const out = await make(repo, store, commentEvent(repo, { ...ALICE }, ephrase)).run();
  assert.equal(out.result, "signed");
  assert.equal(repo.lastStatus()?.state, "failure");
  const path = "signatures/entity/aspec-ecla/acme-widgets-pty-ltd.json";
  const record = store.json(path);
  assert.equal(record.status, "pending");
  assert.equal(record.entityName, "Acme Widgets Pty Ltd");
  assert.deepEqual(record.authorisedAccounts, [ALICE]);
  assert.match(repo.comments.get(7)?.find((c) => c.body.startsWith(COMMENT_MARKER))?.body ?? "", /awaiting maintainer approval/);

  // Maintainer verifies authority and activates the entity.
  record.status = "active";
  store.put(path, record);
  assert.equal((await make(repo, store, {}).run()).result, "passed");

  record.status = "revoked";
  store.put(path, record);
  assert.equal((await make(repo, store, {}).run()).result, "failed");
});

test("malformed entity records fail closed", async () => {
  const { repo, store } = setup();
  store.files.set("signatures/entity/aspec-ecla/bad.json", { text: "{nope", sha: "1" });
  await assert.rejects(make(repo, store, {}).run(), /not valid JSON/);
});

test("pinned document hash mismatch fails closed", async () => {
  const cfg = baseConfig();
  (cfg.individual as Record<string, unknown>)["sha256"] = "0".repeat(64);
  const { repo, store } = setup(cfg);
  await assert.rejects(make(repo, store, {}).run(), /does not match the pinned sha256/);
});

test("matching document pin passes", async () => {
  const cfg = baseConfig();
  (cfg.individual as Record<string, unknown>)["sha256"] = sha256(ICLA_TEXT);
  const { repo, store } = setup(cfg);
  assert.equal((await make(repo, store, {}).run()).result, "failed");
});

test("missing config fails closed and reports an error status", async () => {
  const { repo, store } = setup();
  repo.files.delete(".github/pactdock.json");
  const pd = make(repo, store, {});
  await assert.rejects(pd.run(), /was not found/);
  await pd.reportFailure(new Error("boom"));
  assert.equal(repo.lastStatus()?.state, "error");
  assert.equal(repo.lastStatus()?.sha, "a".repeat(40));
});

test("too many commits fails closed", async () => {
  const { repo, store } = setup();
  repo.commits.set(7, Array.from({ length: 251 }, (_, i) => commit(`c${i}`, [{ name: "Alice", email: "a@x", ...ALICE }])));
  await make(repo, store, commentEvent(repo, { ...ALICE }, phrase)).run();
  assert.equal(repo.lastStatus()?.state, "failure");
  assert.match(repo.lastStatus()?.description ?? "", /Cannot verify/);
});

test("comments that are not commands are ignored without API writes", async () => {
  const { repo, store } = setup();
  const out = await make(repo, store, commentEvent(repo, { ...ALICE }, `> ${phrase}\nI do not agree`)).run();
  assert.equal(out.result, "skipped");
  assert.equal(repo.statuses.length, 0);
});

test("/pactdock recheck re-evaluates", async () => {
  const { repo, store } = setup();
  const out = await make(repo, store, commentEvent(repo, { ...BOB }, "/pactdock recheck")).run();
  assert.equal(out.result, "failed");
  assert.equal(repo.lastStatus()?.state, "failure");
});

test("scheduled sweep rechecks every open pull request", async () => {
  const { repo, store } = setup();
  repo.prs.set(8, { number: 8, state: "open", headSha: "b".repeat(40), author: { ...BOB, type: "User" }, htmlUrl: "" });
  repo.commits.set(8, [commit("c9", [{ name: "Bob", email: "b@x", ...BOB }])]);
  repo.prs.set(9, { number: 9, state: "closed", headSha: "c".repeat(40), author: { ...BOB, type: "User" }, htmlUrl: "" });
  await make(repo, store, commentEvent(repo, { ...ALICE }, phrase)).run();
  const out = await make(repo, store, { eventName: "schedule", payload: {} }).run();
  assert.equal(out.result, "mixed");
  assert.deepEqual(out.checked, [7, 8]);
  assert.deepEqual(out.unsigned, ["bob"]);
});

test("unsupported events fail", async () => {
  const { repo, store } = setup();
  await assert.rejects(make(repo, store, { eventName: "push", payload: {} }).run(), /does not handle/);
});

test("closed pull requests are skipped", async () => {
  const { repo, store } = setup();
  repo.prs.get(7)!.state = "closed";
  assert.equal((await make(repo, store, {}).run()).result, "skipped");
  assert.equal(repo.statuses.length, 0);
});

test("only bot-authored marker comments are updated", async () => {
  const { repo, store } = setup();
  repo.addUserComment(7, { ...BOB }, `${COMMENT_MARKER}\nfake`);
  await make(repo, store, {}).run();
  const markers = repo.comments.get(7)!.filter((c) => c.body.startsWith(COMMENT_MARKER));
  assert.equal(markers.length, 2);
  assert.equal(markers[0]!.body, `${COMMENT_MARKER}\nfake`);
});
