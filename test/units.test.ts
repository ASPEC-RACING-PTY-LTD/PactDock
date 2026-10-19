import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { entityPhrase, entitySlug, individualPhrase, parseComment } from "../src/signing.ts";
import { collectContributors, resolveIdentity } from "../src/contributors.ts";
import { Http, GitHubApiError } from "../src/http.ts";
import { createAppJwt, createInstallationToken } from "../src/app-auth.ts";
import { inert, statusDescription } from "../src/report.ts";
import { getInput, setOutput } from "../src/runtime.ts";
import { commit } from "./fakes.ts";

const minimal = {
  rightsHolder: "ASPEC RACING PTY LTD",
  individual: { id: "icla", name: "Example CLA", version: "1.0", document: "CLA.md" },
  storage: { repository: "o/signatures" },
};

// ---------- config ----------

test("config: defaults are applied", () => {
  const c = parseConfig(JSON.stringify(minimal));
  assert.equal(c.statusContext, "PactDock CLA");
  assert.equal(c.storage.directory, "signatures");
  assert.equal(c.coAuthors, true);
  assert.equal(c.committers, false);
  assert.deepEqual(c.individual.acceptedVersions, ["1.0"]);
});

test("config: unknown keys, bad values and path traversal are rejected", () => {
  const bad: unknown[] = [
    { ...minimal, typo: true },
    { ...minimal, storage: { repository: "not a repo" } },
    { ...minimal, storage: { repository: "self" } },
    { ...minimal, individual: { ...minimal.individual, document: "../secret" } },
    { ...minimal, individual: { ...minimal.individual, id: "Bad ID" } },
    { ...minimal, individual: { ...minimal.individual, name: "x`y" } },
    { ...minimal, individual: { ...minimal.individual, acceptedVersions: ["0.9"] } },
    { ...minimal, individual: { ...minimal.individual, sha256: "abc" } },
    { ...minimal, allowlist: { accountIds: ["dependabot"] } },
    { ...minimal, coAuthors: "yes" },
    { ...minimal, entity: { ...minimal.individual } },
    { ...minimal, entityInstructionsUrl: "http://insecure" },
    [],
  ];
  for (const value of bad) assert.throws(() => parseConfig(JSON.stringify(value)), /Invalid PactDock configuration/, JSON.stringify(value));
  assert.throws(() => parseConfig("{"), /not valid JSON/);
});

test("config: self storage with a branch is accepted", () => {
  const c = parseConfig(JSON.stringify({ ...minimal, storage: { repository: "self", branch: "pactdock-signatures" } }));
  assert.equal(c.storage.branch, "pactdock-signatures");
});

// ---------- signing ----------

const agreement = { id: "icla", name: "Example CLA", version: "1.0", document: "", acceptedVersions: ["1.0"] };
const entity = { id: "ecla", name: "Example Entity CLA", version: "2.1", document: "", acceptedVersions: ["2.1"] };

test("signing: exact phrase is recognised with whitespace/case/quote normalisation", () => {
  const p = individualPhrase(agreement);
  assert.deepEqual(parseComment(p, agreement), { kind: "individual" });
  assert.deepEqual(parseComment(`  ${p.toUpperCase().replace(/ /g, "\n ")}  `, agreement), { kind: "individual" });
  assert.deepEqual(parseComment(p.replace(/\.$/, ""), agreement), { kind: "individual" });
});

test("signing: anything other than the exact phrase does not sign", () => {
  const p = individualPhrase(agreement);
  for (const body of [`> ${p}`, `${p} but not really`, `I have NOT read and agree to the Example CLA version 1.0.`, p.replace("1.0", "0.9"), "", "lgtm"]) {
    assert.deepEqual(parseComment(body, agreement), { kind: "none" }, body);
  }
});

test("signing: entity phrase extracts the entity name with original case", () => {
  const p = entityPhrase(entity, "Acme Widgets Pty Ltd");
  assert.deepEqual(parseComment(p, agreement, entity), { kind: "entity", entityName: "Acme Widgets Pty Ltd" });
  assert.deepEqual(parseComment(entityPhrase(entity, "<script>"), agreement, entity), { kind: "none" });
  assert.deepEqual(parseComment(p, agreement), { kind: "none" }, "entity signing disabled without entity config");
});

test("signing: recheck command and entity slugs", () => {
  assert.deepEqual(parseComment(" /PactDock   recheck ", agreement), { kind: "recheck" });
  assert.equal(entitySlug("Ünïcode & Sons Pty. Ltd."), "unicode-sons-pty-ltd");
  assert.throws(() => entitySlug("!!!"));
});

// ---------- contributors ----------

test("contributors: noreply IDs resolve; plain emails do not", () => {
  assert.deepEqual(resolveIdentity({ name: "", email: "123+octo@users.noreply.github.com", user: null }), { id: 123, login: "octo" });
  assert.equal(resolveIdentity({ name: "", email: "octo@users.noreply.github.com", user: null }), null);
  assert.equal(resolveIdentity({ name: "", email: "evil@example.com", user: null }), null);
});

test("contributors: committers are optional and web-flow is ignored", () => {
  const pr = { number: 1, state: "open" as const, headSha: "h", author: { id: 1, login: "a", type: "User" }, htmlUrl: "" };
  const history = {
    headSha: "h",
    totalCount: 2,
    commits: [
      commit("x", [{ name: "A", email: "a@x", id: 1, login: "a" }], { name: "C", email: "c@x", id: 3, login: "c" }),
      commit("y", [{ name: "A", email: "a@x", id: 1, login: "a" }]),
    ],
  };
  const without = collectContributors(pr, history, { coAuthors: true, committers: false, maxCommits: 250 });
  assert.deepEqual(without.contributors.map((c) => c.id), [1]);
  const withC = collectContributors(pr, history, { coAuthors: true, committers: true, maxCommits: 250 });
  assert.deepEqual(withC.contributors.map((c) => c.id), [1, 3]);
  assert.deepEqual(withC.contributors[0]!.roles, ["pull request author", "commit author"]);
});

test("contributors: truncated author lists fail closed", () => {
  const pr = { number: 1, state: "open" as const, headSha: "h", author: { id: 1, login: "a", type: "User" }, htmlUrl: "" };
  const c = commit("x", [{ name: "A", email: "a@x", id: 1 }]);
  c.authorsTruncated = true;
  const set = collectContributors(pr, { headSha: "h", totalCount: 1, commits: [c] }, { coAuthors: true, committers: false, maxCommits: 250 });
  assert.equal(set.problems.length, 1);
});

// ---------- report ----------

test("report: untrusted text is rendered inert", () => {
  assert.equal(inert("<img src=x onerror=alert(1)> @org/team `code`"), "`img srcx onerroralert1 orgteam code`");
  assert.equal(inert("<>"), "`(unnamed)`");
  const desc = statusDescription({ passed: false, covered: [], unsigned: [], unresolved: [], problems: ["x".repeat(500)] });
  assert.ok(desc.length <= 140);
});

// ---------- http ----------

function fakeFetch(responses: (Response | Error)[], calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

const httpBase = { apiUrl: "https://api.test", graphqlUrl: "https://api.test/graphql", sleep: async () => {} };

test("http: sends auth and API version headers, retries 5xx", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = new Http({ ...httpBase, token: "t0k", fetchImpl: fakeFetch([new Response("", { status: 502 }), new Response('{"ok":1}')], calls) });
  assert.deepEqual(await http.request("GET", "/x"), { ok: 1 });
  assert.equal(calls.length, 2);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "token t0k");
  assert.equal(headers["x-github-api-version"], "2022-11-28");
});

test("http: 404 handling and errors", async () => {
  const http = new Http({ ...httpBase, token: "t", fetchImpl: fakeFetch([new Response("", { status: 404 }), new Response('{"message":"Bad"}', { status: 403 })]) });
  assert.equal(await http.request("GET", "/missing", { allow404: true }), null);
  await assert.rejects(http.request("GET", "/forbidden"), (err: unknown) => err instanceof GitHubApiError && err.status === 403 && /Bad/.test(err.message));
});

test("http: pagination follows Link headers and enforces a cap", async () => {
  const page = (items: number[], next?: string) =>
    new Response(JSON.stringify(items), { headers: next ? { link: `<${next}>; rel="next"` } : {} });
  const http = new Http({ ...httpBase, token: "t", fetchImpl: fakeFetch([page([1, 2], "https://api.test/x?page=2"), page([3])]) });
  assert.deepEqual(await http.paginate("/x"), [1, 2, 3]);
  const capped = new Http({ ...httpBase, token: "t", fetchImpl: fakeFetch([page([1, 2, 3])]) });
  await assert.rejects(capped.paginate("/x", 2), /more than 2/);
});

test("http: graphql errors are surfaced", async () => {
  const http = new Http({ ...httpBase, token: "t", fetchImpl: fakeFetch([new Response('{"errors":[{"message":"nope"}]}')]) });
  await assert.rejects(http.graphql("{x}", {}), /nope/);
});

test("http: network failures retry then fail", async () => {
  const http = new Http({ ...httpBase, token: "t", fetchImpl: fakeFetch([new Error("a"), new Error("b"), new Error("c")]) });
  await assert.rejects(http.request("GET", "/x"), /Network request to GitHub failed/);
});

// ---------- app auth ----------

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("app-auth: JWT is RS256-signed with bounded lifetime", () => {
  const jwt = createAppJwt("12345", pem, 1_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p!, "base64url").toString()), { iat: 999_940, exp: 1_000_540, iss: "12345" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(s!, "base64url")));
  assert.ok(createAppJwt("1", pem.replace(/\n/g, "\\n")), "escaped newlines accepted");
  assert.throws(() => createAppJwt("1; rm", pem));
});

test("app-auth: installation token is down-scoped to one repository", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = fakeFetch([new Response('{"id":77}'), new Response('{"token":"ghs_x"}', { status: 201 })], calls);
  const token = await createInstallationToken({ ...httpBase, fetchImpl }, "1", pem, "aspec", "sigs", { contents: "write" });
  assert.equal(token, "ghs_x");
  assert.equal(calls[0]!.url, "https://api.test/repos/aspec/sigs/installation");
  assert.match((calls[0]!.init.headers as Record<string, string>)["authorization"]!, /^Bearer /);
  assert.equal(calls[1]!.url, "https://api.test/app/installations/77/access_tokens");
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { repositories: ["sigs"], permissions: { contents: "write" } });
});

// ---------- runtime ----------

test("runtime: inputs and multiline outputs", () => {
  assert.equal(getInput("github-token", { "INPUT_GITHUB-TOKEN": "  abc " }), "abc");
  const dir = mkdtempSync(join(tmpdir(), "pactdock-"));
  const file = join(dir, "out");
  const prev = process.env["GITHUB_OUTPUT"];
  process.env["GITHUB_OUTPUT"] = file;
  try {
    setOutput("unsigned", "a\nb");
  } finally {
    if (prev === undefined) delete process.env["GITHUB_OUTPUT"];
    else process.env["GITHUB_OUTPUT"] = prev;
  }
  assert.match(readFileSync(file, "utf8"), /^unsigned<<(pactdock_[0-9a-f-]+)\r?\na\nb\r?\n\1\r?\n$/);
});

// ---------- shipped examples ----------

test("examples: bundled configuration files are valid", () => {
  for (const file of ["examples/pactdock.json", "examples/pactdock-self-storage.json", ".github/pactdock.json"]) {
    const path = join(import.meta.dirname, "..", file);
    assert.doesNotThrow(() => parseConfig(readFileSync(path, "utf8")), file);
  }
});

// ---------- GitHub adapters ----------

test("github: store maps sha conflicts but surfaces other 422s", async () => {
  const { GitHubStore } = await import("../src/github.ts");
  const { StoreConflictError } = await import("../src/types.ts");
  const mk = (r: Response) => new GitHubStore(new Http({ ...httpBase, token: "t", fetchImpl: fakeFetch([r]) }), "o", "s", "main");
  await assert.rejects(mk(new Response('{"message":"x"}', { status: 409 })).write("a.json", "{}", null, "m"), StoreConflictError);
  await assert.rejects(mk(new Response('{"message":"sha wasn\'t supplied"}', { status: 422 })).write("a.json", "{}", null, "m"), StoreConflictError);
  await assert.rejects(mk(new Response('{"message":"Branch main not found"}', { status: 422 })).write("a.json", "{}", null, "m"), /Branch main not found/);
});

test("github: PR commits parsed from GraphQL, co-authors kept in order", async () => {
  const { GitHubRepo } = await import("../src/github.ts");
  const data = {
    data: {
      repository: {
        pullRequest: {
          headRefOid: "h",
          commits: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                commit: {
                  oid: "c",
                  authors: {
                    totalCount: 2,
                    nodes: [
                      { name: "A", email: "a@x", user: { databaseId: 1, login: "a" } },
                      { name: "B", email: "b@x", user: null },
                    ],
                  },
                  committer: { name: "A", email: "a@x", user: { databaseId: 1, login: "a" } },
                },
              },
            ],
          },
        },
      },
    },
  };
  const repo = new GitHubRepo(new Http({ ...httpBase, token: "t", fetchImpl: fakeFetch([new Response(JSON.stringify(data))]) }), "o", "r");
  const result = await repo.getPullRequestCommits(1, 250);
  assert.equal(result.headSha, "h");
  assert.deepEqual(result.commits[0]!.authors.map((a) => a.user?.id ?? null), [1, null]);
  assert.equal(result.commits[0]!.authorsTruncated, false);
});
