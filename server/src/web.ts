// Minimal HTTP layer on node:http: routing, body parsing with limits, cookies,
// security headers and a small in-memory rate limiter. No dependencies.

import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Request {
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  headers: IncomingMessage["headers"];
  cookies: Record<string, string>;
  ip: string;
  userAgent: string;
  secure: boolean;
  rawBody(limit?: number): Promise<Buffer>;
  form(limit?: number): Promise<URLSearchParams>;
}

export interface Response {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
}

export type Handler = (req: Request) => Promise<Response> | Response;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Signing and download links carry tokens; never leak them via Referer.
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store",
};

export function html(body: string, status = 200, headers: Record<string, string | string[]> = {}): Response {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

export function text(body: string, status = 200): Response {
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body };
}

export function json(value: unknown, status = 200): Response {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export function redirect(location: string, headers: Record<string, string | string[]> = {}): Response {
  return { status: 303, headers: { location, ...headers }, body: "" };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { secure: boolean; maxAge?: number; path?: string; sameSite?: "Lax" | "Strict" }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, "HttpOnly", `SameSite=${opts.sameSite ?? "Lax"}`];
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  readonly #routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
          keys.push(key);
          return "([^/]+)";
        }) +
        "$",
    );
    this.#routes.push({ method, pattern, keys, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.#routes) {
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
      return { handler: r.handler, params };
    }
    return null;
  }
}

export class RateLimiter {
  readonly #hits = new Map<string, { count: number; reset: number }>();
  readonly limit: number;
  readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const entry = this.#hits.get(key);
    if (!entry || entry.reset < now) {
      this.#hits.set(key, { count: 1, reset: now + this.windowMs });
      if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (v.reset < now) this.#hits.delete(k);
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createHandler(
  router: Router,
  opts: {
    trustProxy: boolean;
    publicUrl: string;
    onError: (err: unknown) => void;
    errorPage: (status: number, message: string) => string;
    /** Turns special errors (e.g. "login required") into responses. */
    mapError?: (err: unknown) => Response | undefined;
  },
) {
  const publicSecure = opts.publicUrl.startsWith("https://");
  return async (raw: IncomingMessage, res: ServerResponse): Promise<void> => {
    let response: Response;
    try {
      const url = new URL(raw.url ?? "/", "http://internal");
      const forwarded = opts.trustProxy ? String(raw.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
      let bodyCache: Promise<Buffer> | null = null;
      const req: Request = {
        method: raw.method ?? "GET",
        url,
        path: url.pathname,
        params: {},
        headers: raw.headers,
        cookies: parseCookies(raw.headers.cookie),
        ip: forwarded || raw.socket.remoteAddress || "unknown",
        userAgent: String(raw.headers["user-agent"] ?? "").slice(0, 400),
        secure: publicSecure,
        rawBody: (limit = 1024 * 1024) => (bodyCache ??= readBody(raw, limit)),
        form: async (limit = 1024 * 1024) => {
          const type = String(raw.headers["content-type"] ?? "");
          if (!type.startsWith("application/x-www-form-urlencoded")) throw new HttpError(415, "Expected a form submission.");
          return new URLSearchParams((await req.rawBody(limit)).toString("utf8"));
        },
      };
      const match = router.match(req.method, req.path);
      if (!match) throw new HttpError(404, "Not found.");
      req.params = match.params;
      response = await match.handler(req);
    } catch (err) {
      const mapped = opts.mapError?.(err);
      if (mapped) {
        response = mapped;
        const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS, ...response.headers };
        res.writeHead(response.status, headers);
        res.end(response.body);
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) opts.onError(err);
      const message = err instanceof HttpError ? err.message : "Something went wrong. The error has been logged.";
      response = html(opts.errorPage(status, message), status);
    }
    const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS, ...response.headers };
    if (publicSecure) headers["strict-transport-security"] = "max-age=31536000";
    res.writeHead(response.status, headers);
    res.end(raw.method === "HEAD" ? undefined : response.body);
  };
}
