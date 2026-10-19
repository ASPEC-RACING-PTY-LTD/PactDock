import { test } from "node:test";
import assert from "node:assert/strict";
import { S3Client, parseListKeys, signV4 } from "../src/s3.ts";
import { S3Store } from "../src/s3-store.ts";
import { SignatureStore } from "../src/store.ts";
import { parseConfig } from "../src/config.ts";
import { discordMessage, isDiscordWebhookUrl, postToDiscord, type SignatureEvent } from "../src/discord.ts";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ---------- SigV4 (AWS published examples) ----------

test("sigv4: AWS test suite get-vanilla", () => {
  const h = signV4({
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: {},
    payloadHash: EMPTY,
    region: "us-east-1",
    service: "service",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.match(h["authorization"]!, /Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/);
});

test("sigv4: AWS S3 documentation GET Object example", () => {
  const h = signV4({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY },
    payloadHash: EMPTY,
    region: "us-east-1",
    service: "s3",
    credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.match(h["authorization"]!, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

// ---------- In-memory S3 over fetch ----------

function fakeS3() {
  const objects = new Map<string, string>();
  const requests: { method: string; url: URL; headers: Record<string, string> }[] = [];
  const impl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    requests.push({ method: init.method ?? "GET", url, headers });
    if (!headers["authorization"]?.startsWith("AWS4-HMAC-SHA256 ")) return new Response("", { status: 403 });
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    if (bucket !== "sigs") return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
    if (init.method === "PUT") {
      if (headers["if-none-match"] === "*" && objects.has(key)) return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
      objects.set(key, Buffer.from(init.body as Uint8Array).toString("utf8"));
      return new Response("", { status: 200, headers: { etag: '"x"' } });
    }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"));
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
    }
    const body = objects.get(key);
    return body === undefined ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }) : new Response(body, { headers: { etag: '"x"' } });
  }) as unknown as typeof fetch;
  return { objects, requests, impl };
}

const r2 = (fetchImpl: typeof fetch) =>
  new S3Client({
    bucket: "sigs",
    region: "auto",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    fetchImpl,
  });

test("s3: R2-style path addressing, signed requests, write-once create", async () => {
  const s3 = fakeS3();
  const store = new S3Store(r2(s3.impl));
  assert.equal(await store.create("signatures/a.json", '{"v":1}', "m"), "created");
  assert.equal(await store.create("signatures/a.json", '{"v":2}', "m"), "exists");
  assert.equal(s3.objects.get("signatures/a.json"), '{"v":1}', "existing record never overwritten");
  const put = s3.requests.find((r) => r.method === "PUT")!;
  assert.equal(put.url.href, "https://acct.r2.cloudflarestorage.com/sigs/signatures/a.json");
  assert.equal(put.headers["if-none-match"], "*");
  assert.match(put.headers["authorization"]!, /\/auto\/s3\/aws4_request/);
  assert.equal((await store.read("signatures/a.json"))?.text, '{"v":1}');
  assert.equal(await store.read("signatures/missing.json"), null);
  assert.deepEqual(await store.list("signatures"), ["a.json"]);
});

test("s3: AWS virtual-hosted addressing by default", async () => {
  const calls: string[] = [];
  const client = new S3Client({
    bucket: "my-bucket",
    region: "ap-southeast-2",
    credentials: { accessKeyId: "id", secretAccessKey: "s" },
    fetchImpl: (async (u: URL) => {
      calls.push(String(u));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch,
  });
  assert.equal(await client.get("x/y.json"), null);
  assert.equal(calls[0], "https://my-bucket.s3.ap-southeast-2.amazonaws.com/x/y.json");
  assert.throws(() => new S3Client({ bucket: "b", region: "auto", endpoint: "http://insecure", credentials: { accessKeyId: "a", secretAccessKey: "b" } }));
});

test("s3: errors fail closed and list parsing decodes XML", async () => {
  const client = r2((async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })) as unknown as typeof fetch);
  await assert.rejects(client.get("k"), /HTTP 403: AccessDenied/);
  assert.deepEqual(parseListKeys("<Contents><Key>a&amp;b.json</Key></Contents><Contents><Key>c.json</Key></Contents>"), ["a&b.json", "c.json"]);
});

test("s3: signature store round trip over R2", async () => {
  const s3 = fakeS3();
  const store = new SignatureStore(new S3Store(r2(s3.impl)), "signatures");
  const agreement = { id: "icla", name: "CLA", version: "1.0", document: "CLA.md", acceptedVersions: ["1.0"] };
  const entry = {
    agreementId: "icla",
    agreementName: "CLA",
    version: "1.0",
    documentPath: "CLA.md",
    documentSha256: "x",
    documentUrl: "u",
    signedAt: "t",
    recordedAt: "t",
    signer: { id: 5, login: "e" },
    evidence: { method: "manual" as const },
  };
  assert.equal(await store.recordIndividual(agreement, { id: 5, login: "e" }, entry, "m"), "recorded");
  assert.equal(await store.recordIndividual(agreement, { id: 5, login: "e" }, entry, "m"), "duplicate");
  assert.ok(s3.objects.has("signatures/individual/icla/1.0/5.json"));
  assert.equal((await store.getIndividual(agreement, 5))?.signer.id, 5);
  assert.equal(await store.getIndividual(agreement, 6), null);
});

test("config: s3 storage validated strictly", () => {
  const base = { rightsHolder: "X", individual: { id: "i", name: "CLA", version: "1", document: "C.md" } };
  const ok = parseConfig(JSON.stringify({ ...base, storage: { type: "s3", bucket: "aspec-cla", region: "auto", endpoint: "https://a.r2.cloudflarestorage.com" } }));
  assert.equal(ok.storage.type, "s3");
  for (const storage of [
    { type: "s3", bucket: "aspec-cla", region: "auto", endpoint: "http://a.example" },
    { type: "s3", bucket: "Bad_Bucket", region: "auto" },
    { type: "s3", bucket: "aspec-cla", region: "auto", repository: "o/r" },
    { type: "ftp" },
  ]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...base, storage })), /Invalid PactDock configuration/, JSON.stringify(storage));
  }
  assert.throws(() => parseConfig(JSON.stringify({ ...base, storage: { repository: "o/r" }, discord: { mode: "store" } })), /discord.mode/);
});

// ---------- Discord ----------

const event: SignatureEvent = {
  kind: "individual",
  entry: {
    agreementId: "icla",
    agreementName: "ASPEC CLA",
    version: "1.0",
    documentPath: "",
    documentSha256: "",
    documentUrl: "",
    signedAt: "2026-10-20T00:00:00Z",
    recordedAt: "2026-10-20T00:00:01Z",
    signer: { id: 101, login: "alice" },
    evidence: { method: "pull-request-comment", repository: "o/r", pullRequest: 7 },
  },
  recordJson: '{"a":1}',
  storeLabel: "s3://sigs",
};
const HOOK = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz_-0123";

test("discord: webhook URL validation", () => {
  assert.ok(isDiscordWebhookUrl(HOOK));
  for (const bad of ["http://discord.com/api/webhooks/1/x", "https://evil.example/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz", "https://discord.com.evil.io/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz"]) {
    assert.ok(!isDiscordWebhookUrl(bad), bad);
  }
});

test("discord: notify mode posts JSON with mentions disabled", async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  await postToDiscord(HOOK, "notify", event, (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response("{}");
  }) as unknown as typeof fetch);
  assert.equal(sent!.url, `${HOOK}?wait=true`);
  const body = JSON.parse(String(sent!.init.body));
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.content, /alice \(GitHub ID 101\) accepted the ASPEC CLA v1\.0 in o\/r PR #7/);
});

test("discord: signature mode attaches the record", async () => {
  let form: FormData | undefined;
  await postToDiscord(HOOK, "signature", event, (async (_: string, init: RequestInit) => {
    form = init.body as FormData;
    return new Response("{}");
  }) as unknown as typeof fetch);
  const file = form!.get("files[0]") as File;
  assert.equal(file.name, "pactdock-icla-1.0-101.json");
  assert.equal(await file.text(), '{"a":1}');
});

test("discord: untrusted text cannot inject markup or mentions", () => {
  const msg = discordMessage({ ...event, kind: "entity", entityName: "@everyone [x](http://evil)" });
  assert.ok(!msg.includes("@everyone"));
  assert.ok(!msg.includes("](http"));
});
