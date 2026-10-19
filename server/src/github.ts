// GitHub API access for PactDock Server: App installation tokens (cached and
// scoped to one repository), pull request data, check runs, comments, the App
// Manifest conversion and GitHub user sign-in (OAuth with PKCE).

import { createAppJwt } from "../../src/app-auth.ts";
import { Http } from "../../src/http.ts";
import type { CommitInfo, GitIdentity, PullRequest, PullRequestCommits } from "../../src/types.ts";

export interface AppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

export interface GitHubEndpoints {
  apiUrl: string;
  githubUrl: string;
  fetchImpl?: typeof fetch;
}

/** Permissions requested for every installation token: nothing beyond PRs and checks. */
export const TOKEN_PERMISSIONS = { pull_requests: "write", checks: "write", metadata: "read" } as const;

const enc = encodeURIComponent;

function repoPath(fullName: string): string {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error(`Invalid repository name: ${fullName}`);
  return `/repos/${enc(owner)}/${enc(name)}`;
}

interface RestCommit {
  sha: string;
  commit: { message: string; author: { name: string; email: string } | null; committer: { name: string; email: string } | null };
  author: { id: number; login: string } | null;
  committer: { id: number; login: string } | null;
}

const TRAILER_RE = /^co-authored-by:\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/gim;

/** Parses Co-authored-by trailers from a commit message. */
export function coAuthorTrailers(message: string): { name: string; email: string }[] {
  return [...message.matchAll(TRAILER_RE)].map((m) => ({ name: m[1] ?? "", email: m[2] ?? "" })).slice(0, 50);
}

export class GitHubClient {
  readonly #creds: AppCredentials;
  readonly #ep: GitHubEndpoints;
  readonly #tokens = new Map<string, { token: string; expires: number }>();

  constructor(creds: AppCredentials, endpoints: GitHubEndpoints) {
    this.#creds = creds;
    this.#ep = endpoints;
  }

  #http(token: string, scheme: "token" | "Bearer" = "token"): Http {
    return new Http({
      token,
      scheme,
      apiUrl: this.#ep.apiUrl,
      graphqlUrl: `${this.#ep.apiUrl}/graphql`,
      ...(this.#ep.fetchImpl ? { fetchImpl: this.#ep.fetchImpl } : {}),
    });
  }

  app(): Http {
    return this.#http(createAppJwt(this.#creds.appId, this.#creds.privateKey), "Bearer");
  }

  /** Installation token limited to one repository (when given) and the minimal permission set. */
  async installation(installationId: number, repositoryId?: number): Promise<Http> {
    const key = `${installationId}:${repositoryId ?? "*"}`;
    const cached = this.#tokens.get(key);
    if (cached && cached.expires > Date.now() + 5 * 60_000) return this.#http(cached.token);
    const body: Record<string, unknown> = { permissions: TOKEN_PERMISSIONS };
    if (repositoryId) body["repository_ids"] = [repositoryId];
    const res = await this.app().request<{ token: string; expires_at: string }>("POST", `/app/installations/${installationId}/access_tokens`, { body });
    this.#tokens.set(key, { token: res.token, expires: Date.parse(res.expires_at) });
    return this.#http(res.token);
  }

  async pullRequest(http: Http, fullName: string, number: number): Promise<PullRequest & { draft: boolean }> {
    const pr = await http.request<{
      number: number;
      state: "open" | "closed";
      draft?: boolean;
      head: { sha: string };
      user: { id: number; login: string; type: string };
      html_url: string;
    }>("GET", `${repoPath(fullName)}/pulls/${number}`);
    return {
      number: pr.number,
      state: pr.state,
      draft: Boolean(pr.draft),
      headSha: pr.head.sha,
      author: { id: pr.user.id, login: pr.user.login, type: pr.user.type },
      htmlUrl: pr.html_url,
    };
  }

  /**
   * Commits of a pull request (REST, Pull requests: read). Co-authors come from
   * Co-authored-by trailers; `resolveEmail` maps an address to a GitHub account
   * using emails verified by signers on this server.
   */
  async pullRequestCommits(http: Http, fullName: string, number: number, headSha: string, resolveEmail: (email: string) => { id: number; login: string } | null): Promise<PullRequestCommits> {
    const list = await http.paginate<RestCommit>(`${repoPath(fullName)}/pulls/${number}/commits`, 250).catch((err: Error) => {
      if (/more than 250/.test(err.message)) return null;
      throw err;
    });
    if (!list) return { headSha, totalCount: 251, commits: [] };
    const commits: CommitInfo[] = list.map((c) => {
      const author: GitIdentity = {
        name: c.commit.author?.name ?? "",
        email: c.commit.author?.email ?? "",
        user: c.author ? { id: c.author.id, login: c.author.login } : null,
      };
      const coAuthors: GitIdentity[] = coAuthorTrailers(c.commit.message).map((t) => ({ ...t, user: resolveEmail(t.email) }));
      return {
        oid: c.sha,
        authors: [author, ...coAuthors],
        authorsTruncated: false,
        committer: {
          name: c.commit.committer?.name ?? "",
          email: c.commit.committer?.email ?? "",
          user: c.committer ? { id: c.committer.id, login: c.committer.login } : null,
        },
      };
    });
    return { headSha, totalCount: commits.length, commits };
  }

  async createCheckRun(
    http: Http,
    fullName: string,
    headSha: string,
    check: { name: string; conclusion: "success" | "failure" | "action_required"; title: string; summary: string; detailsUrl: string },
  ): Promise<void> {
    await http.request("POST", `${repoPath(fullName)}/check-runs`, {
      body: {
        name: check.name,
        head_sha: headSha,
        status: "completed",
        conclusion: check.conclusion,
        details_url: check.detailsUrl,
        completed_at: new Date().toISOString(),
        output: { title: check.title.slice(0, 250), summary: check.summary.slice(0, 60_000) },
      },
    });
  }

  async markerComment(http: Http, fullName: string, number: number, marker: string, botLogin: string): Promise<{ id: number; body: string } | null> {
    const comments = await http.paginate<{ id: number; body: string; user: { login: string; type: string } | null }>(`${repoPath(fullName)}/issues/${number}/comments`, 3000);
    const found = comments.find((c) => c.user?.type === "Bot" && c.user.login === botLogin && c.body?.startsWith(marker));
    return found ? { id: found.id, body: found.body } : null;
  }

  async createComment(http: Http, fullName: string, number: number, body: string): Promise<void> {
    await http.request("POST", `${repoPath(fullName)}/issues/${number}/comments`, { body: { body } });
  }

  async updateComment(http: Http, fullName: string, id: number, body: string): Promise<void> {
    await http.request("PATCH", `${repoPath(fullName)}/issues/comments/${id}`, { body: { body } });
  }

  async userByLogin(http: Http, login: string): Promise<{ id: number; login: string; type: string } | null> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
    return http.request<{ id: number; login: string; type: string }>("GET", `/users/${enc(login)}`, { allow404: true });
  }

  async installationRepositories(http: Http): Promise<{ id: number; full_name: string }[]> {
    const repos: { id: number; full_name: string }[] = [];
    let page = 1;
    for (;;) {
      const res = await http.request<{ total_count: number; repositories: { id: number; full_name: string }[] }>("GET", `/installation/repositories?per_page=100&page=${page}`);
      repos.push(...res.repositories.map((r) => ({ id: r.id, full_name: r.full_name })));
      if (res.repositories.length < 100 || repos.length >= 2000) break;
      page++;
    }
    return repos;
  }

  async installations(): Promise<{ id: number; account: { login: string; id: number; type: string }; suspended_at: string | null }[]> {
    return this.app().paginate("/app/installations", 500);
  }

  // ---- user sign-in (GitHub App user authorization with PKCE) ----

  authorizeUrl(redirectUri: string, state: string, codeChallenge: string): string {
    const u = new URL(`${this.#ep.githubUrl}/login/oauth/authorize`);
    u.searchParams.set("client_id", this.#creds.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("allow_signup", "false");
    return u.toString();
  }

  /**
   * Exchanges an authorization code and returns the GitHub identity and its
   * verified email addresses. The user token is used once and discarded.
   */
  async signIn(code: string, redirectUri: string, codeVerifier: string): Promise<{ id: number; login: string; type: string; emails: string[] }> {
    const fetchImpl = this.#ep.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.#ep.githubUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.#creds.clientId, client_secret: this.#creds.clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      redirect: "error",
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new Error(`GitHub sign-in failed: ${data.error_description ?? data.error ?? res.status}`);
    const http = new Http({ token: data.access_token, scheme: "Bearer", apiUrl: this.#ep.apiUrl, graphqlUrl: `${this.#ep.apiUrl}/graphql`, ...(this.#ep.fetchImpl ? { fetchImpl: this.#ep.fetchImpl } : {}) });
    const user = await http.request<{ id: number; login: string; type: string }>("GET", "/user");
    const emails = await http
      .request<{ email: string; verified: boolean }[]>("GET", "/user/emails")
      .then((list) => list.filter((e) => e.verified).map((e) => e.email))
      .catch(() => [] as string[]);
    return { id: user.id, login: user.login, type: user.type, emails };
  }
}

/** Completes the App Manifest flow: exchanges the one-time code for the new App's credentials. */
export async function convertManifest(
  apiUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; slug: string; client_id: string; client_secret: string; webhook_secret: string | null; pem: string; owner: { login: string } | null; html_url: string }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new Error("Invalid manifest code.");
  const res = await fetchImpl(`${apiUrl}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "PactDock-Server" },
    redirect: "error",
  });
  if (!res.ok) throw new Error(`GitHub rejected the App manifest code (HTTP ${res.status}). Codes expire after one hour; start again.`);
  return (await res.json()) as never;
}
