// Shared domain types and the narrow GitHub "ports" PactDock depends on.
// Production code implements them over the GitHub API (github.ts); tests use
// in-memory fakes.

export interface Account {
  /** Immutable numeric GitHub account ID: the identity PactDock trusts. */
  id: number;
  /** Login at the time of observation (informational only; logins can change). */
  login: string;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  headSha: string;
  author: Account & { type: string };
  htmlUrl: string;
}

export interface GitIdentity {
  name: string;
  email: string;
  /** GitHub account the email resolves to, if any. */
  user: Account | null;
}

export interface CommitInfo {
  oid: string;
  /** Git author first, then Co-authored-by trailers (as resolved by GitHub). */
  authors: GitIdentity[];
  authorsTruncated: boolean;
  committer: GitIdentity;
}

export interface PullRequestCommits {
  headSha: string;
  totalCount: number;
  commits: CommitInfo[];
}

export interface IssueComment {
  id: number;
  body: string;
  user: Account & { type: string };
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export type StatusState = "pending" | "success" | "failure" | "error";

export interface RepoPort {
  readonly owner: string;
  readonly repo: string;
  getDefaultBranchHead(): Promise<{ branch: string; sha: string }>;
  getFile(path: string, ref: string): Promise<Buffer | null>;
  getPullRequest(number: number): Promise<PullRequest>;
  getPullRequestCommits(number: number, limit: number): Promise<PullRequestCommits>;
  listOpenPullRequests(limit: number): Promise<number[]>;
  getComment(id: number): Promise<IssueComment | null>;
  listComments(issue: number): Promise<IssueComment[]>;
  createComment(issue: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
  addReaction(commentId: number, content: "+1" | "eyes" | "confused"): Promise<void>;
  setStatus(sha: string, state: StatusState, context: string, description: string, targetUrl: string): Promise<void>;
}

export interface StoredFile {
  text: string;
  /** Blob SHA used for optimistic concurrency on write. */
  sha: string;
}

export interface StorePort {
  /** Human-readable location, e.g. "aspec/cla-signatures@main". */
  readonly label: string;
  read(path: string): Promise<StoredFile | null>;
  /** Lists file names (not directories) directly inside a directory. */
  list(directory: string): Promise<string[]>;
  /** Creates (sha null) or updates a file. Throws StoreConflictError if sha is stale. */
  write(path: string, text: string, sha: string | null, message: string): Promise<void>;
}

export class StoreConflictError extends Error {
  constructor(path: string) {
    super(`Concurrent modification of ${path} in the signature store.`);
    this.name = "StoreConflictError";
  }
}
