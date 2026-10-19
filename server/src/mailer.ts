// Minimal SMTP client (RFC 5321) for signed-copy and recovery emails.
// Supports implicit TLS (465), STARTTLS (587) and AUTH PLAIN. No dependencies.

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";
import type { SmtpSettings } from "./env.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

function header(value: string): string {
  // Prevent header injection and encode non-ASCII (RFC 2047).
  const clean = value.replace(/[\r\n]+/g, " ").slice(0, 200);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

class Conversation {
  #socket: Socket | TLSSocket;
  #buffer = "";
  #waiters: ((line: string) => void)[] = [];
  #lines: string[] = [];
  #error: Error | null = null;

  constructor(socket: Socket | TLSSocket) {
    this.#socket = socket;
    this.#attach(socket);
  }

  #attach(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let i: number;
      while ((i = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, i).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(i + 1);
        const waiter = this.#waiters.shift();
        if (waiter) waiter(line);
        else this.#lines.push(line);
      }
    });
    socket.on("error", (err) => {
      this.#error = err;
      for (const w of this.#waiters.splice(0)) w("");
    });
  }

  upgrade(socket: TLSSocket): void {
    this.#socket = socket;
    this.#buffer = "";
    this.#attach(socket);
  }

  get socket(): Socket | TLSSocket {
    return this.#socket;
  }

  #line(): Promise<string> {
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Reads a (possibly multi-line) reply and checks its code. */
  async expect(code: number): Promise<string> {
    let line: string;
    const all: string[] = [];
    do {
      line = await this.#line();
      if (this.#error) throw this.#error;
      all.push(line);
    } while (/^\d{3}-/.test(line));
    if (!line.startsWith(String(code))) throw new Error(`SMTP error: expected ${code}, got "${all.join(" | ").slice(0, 200)}"`);
    return all.join("\n");
  }

  async command(line: string, code: number): Promise<string> {
    this.#socket.write(line + "\r\n");
    return this.expect(code);
  }
}

export class SmtpMailer implements Mailer {
  readonly #s: SmtpSettings;
  readonly #timeoutMs: number;

  constructor(settings: SmtpSettings, timeoutMs = 20_000) {
    this.#s = settings;
    this.#timeoutMs = timeoutMs;
  }

  async send(mail: Mail): Promise<void> {
    if (!isEmail(mail.to)) throw new Error("Invalid recipient address.");
    const s = this.#s;
    const socket: Socket | TLSSocket =
      s.security === "tls" ? tlsConnect({ host: s.host, port: s.port, servername: s.host }) : netConnect({ host: s.host, port: s.port });
    socket.setTimeout(this.#timeoutMs, () => socket.destroy(new Error("SMTP connection timed out.")));
    const conv = new Conversation(socket);
    try {
      await conv.expect(220);
      const ehlo = `EHLO pactdock.local`;
      let caps = await conv.command(ehlo, 250);
      if (s.security === "starttls") {
        if (!/STARTTLS/i.test(caps)) throw new Error("SMTP server does not offer STARTTLS.");
        await conv.command("STARTTLS", 220);
        const secure = tlsConnect({ socket: conv.socket as Socket, servername: s.host });
        await new Promise<void>((resolve, reject) => {
          secure.once("secureConnect", () => resolve());
          secure.once("error", reject);
        });
        conv.upgrade(secure);
        caps = await conv.command(ehlo, 250);
      }
      if (s.user && s.pass) {
        const token = Buffer.from(`\0${s.user}\0${s.pass}`).toString("base64");
        await conv.command(`AUTH PLAIN ${token}`, 235);
      }
      const from = /<([^>]+)>/.exec(s.from)?.[1] ?? s.from;
      await conv.command(`MAIL FROM:<${from}>`, 250);
      await conv.command(`RCPT TO:<${mail.to}>`, 250);
      await conv.command("DATA", 354);
      const domain = from.split("@")[1] ?? "pactdock.local";
      const body = [
        `From: ${header(s.from)}`,
        `To: <${mail.to}>`,
        `Subject: ${header(mail.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        (Buffer.from(mail.text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
      ].join("\r\n");
      // Base64 bodies cannot contain a lone "." line, so no dot-stuffing is needed.
      await conv.command(`${body}\r\n.`, 250);
      await conv.command("QUIT", 221).catch(() => undefined);
    } finally {
      conv.socket.destroy();
    }
  }
}

/** Used when SMTP is not configured: email features are hidden and nothing is sent. */
export class NoMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error("Email is not configured on this server.");
  }
}
