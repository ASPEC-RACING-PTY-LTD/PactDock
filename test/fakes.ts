// In-memory fakes of the GitHub ports used by PactDock.

import {
  type CommitInfo,
  type IssueComment,
  type PullRequest,
  type PullRequestCommits,
  type RepoPort,
  type StatusState,
  type StoredFile,
  type StorePort,
} from "../src/types.ts";

export interface Status {
  sha: string;
  state: StatusState;
  context: string;
  description: string;
}

export class FakeRepo implements RepoPort {
  readonly owner = "aspec";
  readonly repo = "widget";
  files = new Map<string, string>();
  prs = new Map<number, PullRequest>();
  commits = new Map<number, CommitInfo[]>();
  comments = new Map<number, IssueComment[]>();
  statuses: Status[] = [];
  reactions: { commentId: number; content: string }[] = [];
  nextCommentId = 1000;

  async getDefaultBranchHead() {
    return { branch: "main", sha: "d".repeat(40) };
  }
  async getFile(path: string) {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, "utf8");
  }
  async getPullRequest(number: number) {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    return pr;
  }
  async getPullRequestCommits(number: number, limit: number): Promise<PullRequestCommits> {
    const pr = await this.getPullRequest(number);
    const commits = this.commits.get(number) ?? [];
    return { headSha: pr.headSha, totalCount: commits.length, commits: commits.length > limit ? [] : commits };
  }
  async listOpenPullRequests() {
    return [...this.prs.values()].filter((p) => p.state === "open").map((p) => p.number);
  }
  async getComment(id: number) {
    for (const list of this.comments.values()) {
      const found = list.find((c) => c.id === id);
      if (found) return found;
    }
    return null;
  }
  async listComments(issue: number) {
    return this.comments.get(issue) ?? [];
  }
  async createComment(issue: number, body: string) {
    const list = this.comments.get(issue) ?? [];
    const now = new Date().toISOString();
    list.push({ id: this.nextCommentId++, body, user: { id: 41898282, login: "github-actions[bot]", type: "Bot" }, createdAt: now, updatedAt: now, htmlUrl: "" });
    this.comments.set(issue, list);
  }
  async updateComment(id: number, body: string) {
    const c = await this.getComment(id);
    if (!c) throw new Error("missing comment");
    c.body = body;
  }
  async addReaction(commentId: number, content: string) {
    this.reactions.push({ commentId, content });
  }
  async setStatus(sha: string, state: StatusState, context: string, description: string) {
    this.statuses.push({ sha, state, context, description });
  }

  /** Adds a user comment and returns the matching issue_comment payload fragment. */
  addUserComment(issue: number, user: { id: number; login: string; type?: string }, body: string, edited = false) {
    const id = this.nextCommentId++;
    const createdAt = "2026-10-20T01:02:03Z";
    const comment: IssueComment = {
      id,
      body,
      user: { id: user.id, login: user.login, type: user.type ?? "User" },
      createdAt,
      updatedAt: edited ? "2026-10-20T02:00:00Z" : createdAt,
      htmlUrl: `https://github.com/aspec/widget/pull/${issue}#issuecomment-${id}`,
    };
    const list = this.comments.get(issue) ?? [];
    list.push(comment);
    this.comments.set(issue, list);
    return comment;
  }

  lastStatus(): Status | undefined {
    return this.statuses.at(-1);
  }
}

export class FakeStore implements StorePort {
  readonly label = "aspec/cla-signatures@main";
  files = new Map<string, StoredFile>();
  writes: { path: string; message: string }[] = [];

  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async list(directory: string) {
    const prefix = directory.endsWith("/") ? directory : directory + "/";
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map((p) => p.slice(prefix.length));
  }
  async create(path: string, text: string, message: string): Promise<"created" | "exists"> {
    if (this.files.has(path)) return "exists";
    this.files.set(path, { text });
    this.writes.push({ path, message });
    return "created";
  }
  put(path: string, value: unknown) {
    this.files.set(path, { text: JSON.stringify(value) });
  }
  json(path: string): any {
    const f = this.files.get(path);
    return f ? JSON.parse(f.text) : undefined;
  }
}

export function commit(oid: string, authors: { name: string; email: string; id?: number; login?: string }[], committer?: { name: string; email: string; id?: number; login?: string }): CommitInfo {
  const toIdentity = (a: { name: string; email: string; id?: number; login?: string }) => ({
    name: a.name,
    email: a.email,
    user: a.id ? { id: a.id, login: a.login ?? `user${a.id}` } : null,
  });
  return {
    oid: oid.padEnd(40, "0"),
    authors: authors.map(toIdentity),
    authorsTruncated: false,
    committer: toIdentity(committer ?? { name: "GitHub", email: "noreply@github.com", id: 19864447, login: "web-flow" }),
  };
}
