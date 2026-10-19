// GitHub API implementations of RepoPort and StorePort.

import { GitHubApiError, Http } from "./http.ts";
import {
  StoreConflictError,
  type Account,
  type CommitInfo,
  type GitIdentity,
  type IssueComment,
  type PullRequest,
  type PullRequestCommits,
  type RepoPort,
  type StatusState,
  type StoredFile,
  type StorePort,
} from "./types.ts";

const enc = encodeURIComponent;

function encPath(path: string): string {
  return path.split("/").map(enc).join("/");
}

interface RestUser {
  id: number;
  login: string;
  type: string;
}

interface RestComment {
  id: number;
  body?: string | null;
  user: RestUser | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface RestContent {
  type: string;
  content?: string;
  encoding?: string;
  sha: string;
  name: string;
}

function toComment(c: RestComment): IssueComment {
  return {
    id: c.id,
    body: c.body ?? "",
    user: { id: c.user?.id ?? 0, login: c.user?.login ?? "ghost", type: c.user?.type ?? "User" },
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    htmlUrl: c.html_url,
  };
}

async function readContent(http: Http, base: string, path: string, ref: string | undefined): Promise<RestContent | RestContent[] | null> {
  const query = ref ? `?ref=${enc(ref)}` : "";
  return http.request<RestContent | RestContent[]>("GET", `${base}/contents/${encPath(path)}${query}`, { allow404: true });
}

function decodeFile(content: RestContent | RestContent[], path: string): Buffer {
  if (Array.isArray(content) || content.type !== "file") throw new Error(`${path} is not a file.`);
  if (content.encoding !== "base64" || content.content === undefined) {
    throw new Error(`${path} is too large to read through the contents API (limit 1 MB).`);
  }
  return Buffer.from(content.content, "base64");
}

export class GitHubRepo implements RepoPort {
  readonly owner: string;
  readonly repo: string;
  readonly #http: Http;
  readonly #base: string;

  constructor(http: Http, owner: string, repo: string) {
    this.#http = http;
    this.owner = owner;
    this.repo = repo;
    this.#base = `/repos/${enc(owner)}/${enc(repo)}`;
  }

  async getDefaultBranchHead(): Promise<{ branch: string; sha: string }> {
    const repo = await this.#http.request<{ default_branch: string }>("GET", this.#base);
    const commit = await this.#http.request<{ sha: string }>("GET", `${this.#base}/commits/${enc(repo.default_branch)}`);
    return { branch: repo.default_branch, sha: commit.sha };
  }

  async getFile(path: string, ref: string): Promise<Buffer | null> {
    const content = await readContent(this.#http, this.#base, path, ref);
    return content ? decodeFile(content, path) : null;
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const pr = await this.#http.request<{
      number: number;
      state: "open" | "closed";
      head: { sha: string };
      user: RestUser;
      html_url: string;
    }>("GET", `${this.#base}/pulls/${number}`);
    return {
      number: pr.number,
      state: pr.state,
      headSha: pr.head.sha,
      author: { id: pr.user.id, login: pr.user.login, type: pr.user.type },
      htmlUrl: pr.html_url,
    };
  }

  async getPullRequestCommits(number: number, limit: number): Promise<PullRequestCommits> {
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$number){
        headRefOid
        commits(first:100, after:$after){
          totalCount
          pageInfo{ hasNextPage endCursor }
          nodes{ commit{
            oid
            authors(first:25){ totalCount nodes{ name email user{ databaseId login } } }
            committer{ name email user{ databaseId login } }
          } }
        }
      } }
    }`;
    type Actor = { name: string | null; email: string | null; user: { databaseId: number; login: string } | null };
    type Page = {
      repository: {
        pullRequest: {
          headRefOid: string;
          commits: {
            totalCount: number;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { commit: { oid: string; authors: { totalCount: number; nodes: Actor[] }; committer: Actor } }[];
          };
        } | null;
      } | null;
    };
    const toIdentity = (a: Actor): GitIdentity => ({
      name: a.name ?? "",
      email: a.email ?? "",
      user: a.user ? ({ id: a.user.databaseId, login: a.user.login } satisfies Account) : null,
    });

    const commits: CommitInfo[] = [];
    let after: string | null = null;
    let headSha = "";
    let totalCount = 0;
    do {
      const data: Page = await this.#http.graphql<Page>(query, { owner: this.owner, name: this.repo, number, after });
      const pr = data.repository?.pullRequest;
      if (!pr) throw new Error(`Pull request #${number} was not found.`);
      if (headSha && headSha !== pr.headRefOid) throw new Error("Pull request head changed while reading commits; retry.");
      headSha = pr.headRefOid;
      totalCount = pr.commits.totalCount;
      if (totalCount > limit) break;
      for (const node of pr.commits.nodes) {
        commits.push({
          oid: node.commit.oid,
          authors: node.commit.authors.nodes.map(toIdentity),
          authorsTruncated: node.commit.authors.totalCount > node.commit.authors.nodes.length,
          committer: toIdentity(node.commit.committer),
        });
      }
      after = pr.commits.pageInfo.hasNextPage ? pr.commits.pageInfo.endCursor : null;
    } while (after);
    return { headSha, totalCount, commits };
  }

  async listOpenPullRequests(limit: number): Promise<number[]> {
    const prs = await this.#http.paginate<{ number: number }>(`${this.#base}/pulls?state=open`, limit);
    return prs.map((p) => p.number);
  }

  async getComment(id: number): Promise<IssueComment | null> {
    const c = await this.#http.request<RestComment>("GET", `${this.#base}/issues/comments/${id}`, { allow404: true });
    return c ? toComment(c) : null;
  }

  async listComments(issue: number): Promise<IssueComment[]> {
    const list = await this.#http.paginate<RestComment>(`${this.#base}/issues/${issue}/comments`, 3000);
    return list.map(toComment);
  }

  async createComment(issue: number, body: string): Promise<void> {
    await this.#http.request("POST", `${this.#base}/issues/${issue}/comments`, { body: { body } });
  }

  async updateComment(id: number, body: string): Promise<void> {
    await this.#http.request("PATCH", `${this.#base}/issues/comments/${id}`, { body: { body } });
  }

  async addReaction(commentId: number, content: "+1" | "eyes" | "confused"): Promise<void> {
    await this.#http.request("POST", `${this.#base}/issues/comments/${commentId}/reactions`, { body: { content } });
  }

  async setStatus(sha: string, state: StatusState, context: string, description: string, targetUrl: string): Promise<void> {
    await this.#http.request("POST", `${this.#base}/statuses/${enc(sha)}`, {
      body: { state, context, description: description.slice(0, 140), target_url: targetUrl },
    });
  }
}

export class GitHubStore implements StorePort {
  readonly label: string;
  readonly #http: Http;
  readonly #base: string;
  readonly #branch: string | undefined;

  constructor(http: Http, owner: string, repo: string, branch: string | undefined) {
    this.#http = http;
    this.#base = `/repos/${enc(owner)}/${enc(repo)}`;
    this.#branch = branch;
    this.label = `${owner}/${repo}${branch ? `@${branch}` : ""}`;
  }

  async read(path: string): Promise<StoredFile | null> {
    const content = await readContent(this.#http, this.#base, path, this.#branch);
    if (!content) return null;
    if (Array.isArray(content)) throw new Error(`${path} is a directory.`);
    return { text: decodeFile(content, path).toString("utf8"), sha: content.sha };
  }

  async list(directory: string): Promise<string[]> {
    const content = await readContent(this.#http, this.#base, directory, this.#branch);
    if (!content) return [];
    if (!Array.isArray(content)) throw new Error(`${directory} is not a directory.`);
    return content.filter((c) => c.type === "file").map((c) => c.name);
  }

  async write(path: string, text: string, sha: string | null, message: string): Promise<void> {
    const body: Record<string, string> = { message, content: Buffer.from(text, "utf8").toString("base64") };
    if (sha) body["sha"] = sha;
    if (this.#branch) body["branch"] = this.#branch;
    try {
      await this.#http.request("PUT", `${this.#base}/contents/${encPath(path)}`, { body });
    } catch (err) {
      // 409, or 422 complaining about the blob sha, means someone else wrote first.
      // Other 422s (e.g. a missing branch) are real errors and must surface as such.
      if (err instanceof GitHubApiError && (err.status === 409 || (err.status === 422 && /sha/i.test(err.message)))) {
        throw new StoreConflictError(path);
      }
      throw err;
    }
  }
}
