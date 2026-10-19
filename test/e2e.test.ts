// Runs the compiled action (dist/index.js) as a child process against a local
// mock of the GitHub REST/GraphQL API. Requires `npm run build` first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "../dist/index.js");
const b64 = (s: string) => Buffer.from(s).toString("base64");

interface Recorded {
  method: string;
  url: string;
  auth: string;
  body: any;
}

function mockGitHub(store: Map<string, string>) {
  const requests: Recorded[] = [];
  const config = {
    rightsHolder: "ASPEC RACING PTY LTD",
    individual: { id: "aspec-icla", name: "ASPEC Individual CLA", version: "1.0", document: "CLA.md" },
    storage: { repository: "aspec/sigs" },
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = req.url ?? "";
    requests.push({ method: req.method ?? "", url, auth: String(req.headers.authorization), body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const path = url.split("?")[0]!;
    if (path === "/repos/aspec/widget") return send(200, { default_branch: "main" });
    if (path === "/repos/aspec/widget/commits/main") return send(200, { sha: "d".repeat(40) });
    if (path === "/repos/aspec/widget/contents/.github/pactdock.json") return send(200, { type: "file", encoding: "base64", content: b64(JSON.stringify(config)), sha: "c1", name: "pactdock.json" });
    if (path === "/repos/aspec/widget/contents/CLA.md") return send(200, { type: "file", encoding: "base64", content: b64("CLA text"), sha: "c2", name: "CLA.md" });
    if (path === "/repos/aspec/widget/pulls/7")
      return send(200, { number: 7, state: "open", head: { sha: "a".repeat(40) }, user: { id: 101, login: "alice", type: "User" }, html_url: "https://github.com/aspec/widget/pull/7" });
    if (path === "/graphql")
      return send(200, {
        data: {
          repository: {
            pullRequest: {
              headRefOid: "a".repeat(40),
              commits: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: "1".repeat(40),
                      authors: { totalCount: 1, nodes: [{ name: "Alice", email: "a@x", user: { databaseId: 101, login: "alice" } }] },
                      committer: { name: "GitHub", email: "noreply@github.com", user: { databaseId: 19864447, login: "web-flow" } },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    if (path.startsWith("/repos/aspec/widget/statuses/")) return send(201, {});
    if (path === "/repos/aspec/widget/issues/7/comments") return req.method === "POST" ? send(201, {}) : send(200, []);
    if (path === "/repos/aspec/widget/issues/comments/55")
      return send(200, { id: 55, body: "I have read and agree to the ASPEC Individual CLA version 1.0.", user: { id: 101, login: "alice", type: "User" }, created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z", html_url: "https://github.com/c/55" });
    if (path === "/repos/aspec/widget/issues/comments/55/reactions") return send(201, {});
    if (path.startsWith("/repos/aspec/sigs/contents/")) {
      const file = decodeURIComponent(path.slice("/repos/aspec/sigs/contents/".length));
      if (req.method === "PUT") {
        store.set(file, Buffer.from(body.content, "base64").toString());
        return send(201, {});
      }
      const text = store.get(file);
      return text === undefined ? send(404, { message: "Not Found" }) : send(200, { type: "file", encoding: "base64", content: b64(text), sha: "s", name: file });
    }
    send(404, { message: `unmocked ${req.method} ${url}` });
  });
  return { server, requests };
}

async function runAction(apiUrl: string, eventName: string, payload: unknown, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pactdock-e2e-"));
  const eventPath = join(dir, "event.json");
  const outputPath = join(dir, "output");
  writeFileSync(eventPath, JSON.stringify(payload));
  writeFileSync(outputPath, "");
  const env = {
    PATH: process.env["PATH"] ?? "",
    SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
    GITHUB_REPOSITORY: "aspec/widget",
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_API_URL: apiUrl,
    GITHUB_GRAPHQL_URL: `${apiUrl}/graphql`,
    GITHUB_RUN_ID: "42",
    "INPUT_GITHUB-TOKEN": "ghs_repo_token",
    "INPUT_STORE-TOKEN": "github_pat_store",
    "INPUT_CONFIG-PATH": ".github/pactdock.json",
    ...extraEnv,
  };
  const child = spawn(process.execPath, [DIST], { env });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
  return { code, stdout, output: readFileSync(outputPath, "utf8") };
}

test("e2e: compiled action fails an unsigned PR then passes after signing", { skip: !existsSync(DIST) && "run npm run build first" }, async () => {
  const store = new Map<string, string>();
  const { server, requests } = mockGitHub(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const first = await runAction(apiUrl, "pull_request_target", { action: "opened", pull_request: { number: 7, head: { sha: "a".repeat(40) } } });
    assert.equal(first.code, 0, first.stdout);
    assert.match(first.output, /result<<\S+\r?\nfailed\r?\n/);
    const statuses = requests.filter((r) => r.url.includes("/statuses/"));
    assert.deepEqual(statuses.map((s) => s.body.state), ["pending", "failure"]);
    assert.ok(requests.filter((r) => r.url.startsWith("/repos/aspec/sigs")).every((r) => r.auth === "token github_pat_store"), "store uses store token");
    assert.ok(statuses.every((r) => r.auth === "token ghs_repo_token"), "statuses use repo token");

    requests.length = 0;
    const second = await runAction(apiUrl, "issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { id: 55, body: "I have read and agree to the ASPEC Individual CLA version 1.0.", user: { id: 101, login: "alice", type: "User" } },
      sender: { id: 101 },
      repository: { id: 9 },
    });
    assert.equal(second.code, 0, second.stdout);
    assert.match(second.output, /result<<\S+\r?\npassed\r?\n/);
    const record = JSON.parse(store.get("signatures/individual/aspec-icla/101.json")!);
    assert.equal(record.signatures[0].evidence.commentId, 55);
    assert.equal(requests.filter((r) => r.url.includes("/statuses/")).at(-1)?.body.state, "success");
  } finally {
    server.close();
  }
});

test("e2e: errors exit non-zero and set an error status (fail closed)", { skip: !existsSync(DIST) && "run npm run build first" }, async () => {
  const { server, requests } = mockGitHub(new Map());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const result = await runAction(apiUrl, "pull_request_target", { pull_request: { number: 7, head: { sha: "a".repeat(40) } } }, { "INPUT_CONFIG-PATH": "missing.json" });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /::error::Configuration file missing.json was not found/);
    assert.equal(requests.filter((r) => r.url.includes("/statuses/")).at(-1)?.body.state, "error");
  } finally {
    server.close();
  }
});
