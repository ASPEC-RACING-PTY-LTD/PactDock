import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson, decryptWithPassphrase, encryptWithPassphrase, Vault } from "../src/crypto.ts";
import { esc, markdown } from "../src/html.ts";
import { normaliseStrokes, renderSignedDocument, signatureSvg } from "../src/documents.ts";
import { coAuthorTrailers } from "../src/github.ts";
import { SmtpMailer } from "../src/mailer.ts";
import { pack, unpack } from "../src/backup.ts";
import { verifySignature } from "../src/webhooks.ts";
import { loadSettings } from "../src/env.ts";
import { parseCookies, Router, RateLimiter } from "../src/web.ts";

const vault = new Vault(randomBytes(32));

test("vault: encrypt/decrypt and tamper detection", () => {
  const enc = vault.encrypt("-----BEGIN PRIVATE KEY-----");
  assert.match(enc, /^v1:/);
  assert.equal(vault.decrypt(enc), "-----BEGIN PRIVATE KEY-----");
  const raw = Buffer.from(enc.slice(3), "base64");
  raw[raw.length - 1]! ^= 1;
  assert.throws(() => vault.decrypt(`v1:${raw.toString("base64")}`));
  assert.throws(() => new Vault(randomBytes(16)));
});

test("vault: signed expiring tokens", () => {
  const t = vault.sign("sign", "500-7", new Date(Date.now() + 60_000));
  assert.equal(vault.verify("sign", t), "500-7");
  assert.equal(vault.verify("download", t), null, "purpose is bound");
  assert.equal(vault.verify("sign", t.replace("500-7", "501-7")), null);
  assert.equal(vault.verify("sign", vault.sign("sign", "x", new Date(Date.now() - 1))), null);
  assert.equal(vault.emailHash(" Alice@Example.com "), vault.emailHash("alice@example.com"));
});

test("passphrase encryption and canonical JSON", () => {
  const blob = encryptWithPassphrase(Buffer.from("secret data"), "long passphrase");
  assert.equal(decryptWithPassphrase(blob, "long passphrase").toString(), "secret data");
  assert.throws(() => decryptWithPassphrase(blob, "nope"), /could not be decrypted/);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  assert.deepEqual(unpack(pack([{ name: "a/b", data: Buffer.from("1") }, { name: "c", data: Buffer.alloc(0) }])).map((e) => e.name), ["a/b", "c"]);
});

test("markdown renderer escapes everything and only allows https links", () => {
  const out = markdown('# Title <img src=x>\n\nText **bold** [x](javascript:alert(1)) [ok](https://a.example)\n\n| A | B |\n| --- | --- |\n| <b> | 2 |\n\n- one\n- two\n\n<!-- hidden -->');
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("<b>"));
  assert.ok(!out.includes("javascript:alert(1)\""));
  assert.match(out, /<a href="https:\/\/a\.example"/);
  assert.match(out, /<table>/);
  assert.match(out, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.ok(!out.includes("hidden"));
  assert.equal(esc(`<"'&>`), "&lt;&quot;&#39;&amp;&gt;");
});

test("signature strokes are validated and rendered as SVG", () => {
  assert.equal(normaliseStrokes("1,1 2,2"), null, "too few points");
  assert.equal(normaliseStrokes("1,1 2,2 3,3 4,4 5,5 9999,1"), null, "out of range");
  assert.equal(normaliseStrokes("1,1 2,2 3,3;4,4 5,5"), "1,1 2,2 3,3;4,4 5,5");
  assert.match(signatureSvg("1,1 2,2 3,3"), /<path d="M1\.0 1\.0 L2\.0 2\.0 L3\.0 3\.0"/);
  assert.ok(!signatureSvg('1,1 2,2"/><script>').includes("<script>"));
});

test("signed document escapes signer-provided values", () => {
  const doc = renderSignedDocument({
    id: "x", agreementName: "CLA", version: "1", rightsHolder: "R", agreementBody: "Body", agreementSha256: "h",
    legalName: "<script>x</script>", githubLogin: "a", githubId: 1, email: null, entityName: null, entityTitle: null,
    signatureType: "typed", signatureData: "<b>sig</b>", signedAt: "t", ip: "1.2.3.4", userAgent: "<ua>", repository: "o/r", pullRequest: 1, serverUrl: "s",
  });
  assert.ok(!doc.includes("<script>x"));
  assert.ok(!doc.includes("<b>sig"));
  assert.match(doc, /1\.2\.3\.4/);
});

test("co-author trailers are parsed", () => {
  assert.deepEqual(coAuthorTrailers("Fix\n\nCo-authored-by: Bob B <bob@example.org>\nco-authored-by: Eve <123+eve@users.noreply.github.com>\nNot-a-trailer: x"), [
    { name: "Bob B", email: "bob@example.org" },
    { name: "Eve", email: "123+eve@users.noreply.github.com" },
  ]);
});

test("webhook signatures", () => {
  const body = Buffer.from('{"a":1}');
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.ok(verifySignature("s3cret", body, sig));
  assert.ok(!verifySignature("other", body, sig));
  assert.ok(!verifySignature("s3cret", body, undefined));
  assert.ok(!verifySignature("s3cret", body, sig.replace("sha256=", "sha1=")));
});


test("settings require https public URL and validate SMTP/S3", () => {
  assert.throws(() => loadSettings({}), /PACTDOCK_PUBLIC_URL/);
  assert.throws(() => loadSettings({ PACTDOCK_PUBLIC_URL: "http://cla.example.com" }), /https/);
  const s = loadSettings({ PACTDOCK_PUBLIC_URL: "https://cla.example.com/", PACTDOCK_SMTP_HOST: "smtp.example.com", PACTDOCK_SMTP_FROM: "PactDock <cla@example.com>", PACTDOCK_SMTP_PORT: "465" });
  assert.equal(s.publicUrl, "https://cla.example.com");
  assert.equal(s.smtp?.security, "tls");
  assert.throws(() => loadSettings({ PACTDOCK_PUBLIC_URL: "https://x.example", PACTDOCK_S3_BUCKET: "b" }), /ACCESS_KEY_ID/);
});

test("router, cookies and rate limiter", () => {
  const r = new Router().on("GET", "/sign/:token", () => ({ status: 200, headers: {}, body: "" }));
  assert.deepEqual(r.match("GET", "/sign/abc%2Edef")?.params, { token: "abc.def" });
  assert.equal(r.match("POST", "/sign/abc"), null);
  assert.deepEqual(parseCookies("a=1; pd_session=x%3Dy"), { a: "1", pd_session: "x=y" });
  const rl = new RateLimiter(2, 1000);
  assert.ok(rl.allow("k", 0) && rl.allow("k", 1));
  assert.ok(!rl.allow("k", 2));
  assert.ok(rl.allow("k", 2000));
});

test("SMTP client speaks the protocol and base64-encodes the body", async () => {
  const received: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake ESMTP\r\n");
    let data = false;
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        received.push(line);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN")) socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const mailer = new SmtpMailer({ host: "127.0.0.1", port, security: "none", user: "u", pass: "p", from: "PactDock <cla@example.com>" });
    await mailer.send({ to: "alice@example.com", subject: "Your signed CLA\r\nBcc: evil@x", text: "Hello\n.\nlink" });
    assert.ok(received.includes("MAIL FROM:<cla@example.com>"));
    assert.ok(received.includes("RCPT TO:<alice@example.com>"));
    assert.ok(received.some((l) => l.startsWith("Subject: Your signed CLA Bcc: evil@x")), "header injection neutralised");
    assert.ok(!received.includes("Bcc: evil@x"));
    const bodyLine = received[received.indexOf("Content-Transfer-Encoding: base64") + 2]!;
    assert.equal(Buffer.from(bodyLine, "base64").toString(), "Hello\n.\nlink");
    await assert.rejects(mailer.send({ to: "not an email", subject: "x", text: "y" }), /Invalid recipient/);
  } finally {
    server.close();
  }
});
