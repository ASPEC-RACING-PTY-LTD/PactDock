// Small fetch-based GitHub REST/GraphQL client. No third-party dependencies.

export const API_VERSION = "2022-11-28";
const USER_AGENT = "PactDock (+https://github.com/aspec-racing/pactdock)";

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, message: string) {
    super(`GitHub API ${method} ${path} failed with HTTP ${status}: ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export interface HttpOptions {
  token: string;
  /** e.g. https://api.github.com or https://ghe.example.com/api/v3 */
  apiUrl: string;
  /** e.g. https://api.github.com/graphql */
  graphqlUrl: string;
  /** Authorization scheme; GitHub App JWTs use "Bearer", tokens use "token". */
  scheme?: "token" | "Bearer";
  fetchImpl?: typeof fetch;
  /** Injected for tests so retries do not slow the suite down. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Return null instead of throwing on HTTP 404. */
  allow404?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Http {
  readonly #opts: Required<Omit<HttpOptions, "fetchImpl" | "sleep">> & {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(opts: HttpOptions) {
    if (!opts.token) throw new Error("A GitHub token is required.");
    this.#opts = {
      token: opts.token,
      apiUrl: opts.apiUrl.replace(/\/+$/, ""),
      graphqlUrl: opts.graphqlUrl,
      scheme: opts.scheme ?? "token",
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? defaultSleep,
      maxAttempts: opts.maxAttempts ?? 3,
    };
  }

  async request<T>(method: string, path: string, options: RequestOptions & { allow404: true }): Promise<T | null>;
  async request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T | null> {
    const url = path.startsWith("https://") || path.startsWith("http://") ? path : `${this.#opts.apiUrl}${path}`;
    const response = await this.#send(method, url, options.body);
    if (response.status === 404 && options.allow404) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(method, path, response.status, summariseError(text));
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Follows `Link: rel="next"` headers. Throws if more than maxItems would be returned. */
  async paginate<T>(path: string, maxItems = 1000): Promise<T[]> {
    const items: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    let url: string | null = `${this.#opts.apiUrl}${path}${sep}per_page=100`;
    while (url) {
      const response = await this.#send("GET", url, undefined);
      const text = await response.text();
      if (!response.ok) throw new GitHubApiError("GET", path, response.status, summariseError(text));
      const page = JSON.parse(text) as T[];
      items.push(...page);
      if (items.length > maxItems) {
        throw new Error(`GitHub API ${path} returned more than ${maxItems} items; refusing to continue.`);
      }
      url = nextLink(response.headers.get("link"));
    }
    return items;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.#send("POST", this.#opts.graphqlUrl, { query, variables });
    const text = await response.text();
    if (!response.ok) throw new GitHubApiError("POST", "/graphql", response.status, summariseError(text));
    const parsed = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
    if (parsed.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    if (!parsed.data) throw new Error("GitHub GraphQL response contained no data.");
    return parsed.data;
  }

  async #send(method: string, url: string, body: unknown): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#opts.maxAttempts; attempt++) {
      try {
        const init: RequestInit = {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `${this.#opts.scheme} ${this.#opts.token}`,
            "user-agent": USER_AGENT,
            "x-github-api-version": API_VERSION,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          redirect: "error",
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await this.#opts.fetchImpl(url, init);
        const retryAfter = retryDelay(response, attempt);
        if (retryAfter !== null && attempt < this.#opts.maxAttempts) {
          await response.body?.cancel();
          await this.#opts.sleep(retryAfter);
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt < this.#opts.maxAttempts) await this.#opts.sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw new Error(`Network request to GitHub failed: ${String(lastError)}`);
  }
}

/** Returns a delay in ms when the response is worth retrying, otherwise null. */
function retryDelay(response: Response, attempt: number): number | null {
  if (response.status >= 500) return 1000 * 2 ** (attempt - 1);
  if (response.status === 429 || (response.status === 403 && response.headers.get("retry-after"))) {
    const seconds = Number(response.headers.get("retry-after") ?? "5");
    // Never wait longer than a minute: failing (closed) is better than hanging.
    return Number.isFinite(seconds) && seconds <= 60 ? Math.max(seconds, 1) * 1000 : null;
  }
  return null;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

function summariseError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // fall through
  }
  return text.slice(0, 200) || "(empty response)";
}
