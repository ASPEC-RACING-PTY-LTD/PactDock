// Works out which GitHub accounts must have signed for a pull request.
// Identities are keyed by numeric account ID. Anything that cannot be tied to
// an account is reported as "unresolved", which fails the check (fail closed).

import type { Account, GitIdentity, PullRequest, PullRequestCommits } from "./types.ts";

export type Role = "pull request author" | "commit author" | "co-author" | "committer";

export interface Contributor extends Account {
  roles: Role[];
}

export interface UnresolvedIdentity {
  name: string;
  commit: string;
  role: Role;
}

export interface ContributorSet {
  contributors: Contributor[];
  unresolved: UnresolvedIdentity[];
  /** Fatal problems that make verification impossible (e.g. too many commits). */
  problems: string[];
}

export interface ContributorOptions {
  coAuthors: boolean;
  committers: boolean;
  maxCommits: number;
}

/** GitHub's web-flow account signs commits made in the web UI; it is never a contributor. */
export const WEB_FLOW_ID = 19864447;

const NOREPLY_RE = /^(\d{1,12})\+([A-Za-z0-9-]{1,39}(?:\[bot\])?)@users\.noreply\.github\.com$/i;

/**
 * Resolves a git identity to an account. GitHub's own resolution wins; the
 * ID-bearing noreply address format is used as a fallback (common for bots).
 */
export function resolveIdentity(identity: GitIdentity): Account | null {
  if (identity.user) return identity.user;
  const match = NOREPLY_RE.exec(identity.email.trim());
  if (match?.[1] && match[2]) return { id: Number(match[1]), login: match[2] };
  return null;
}

export function collectContributors(pr: PullRequest, history: PullRequestCommits, options: ContributorOptions): ContributorSet {
  const byId = new Map<number, Contributor>();
  const unresolved: UnresolvedIdentity[] = [];
  const problems: string[] = [];

  const add = (account: Account, role: Role) => {
    const existing = byId.get(account.id);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
    } else {
      byId.set(account.id, { id: account.id, login: account.login, roles: [role] });
    }
  };

  add(pr.author, "pull request author");

  if (history.totalCount > options.maxCommits) {
    problems.push(`This pull request has ${history.totalCount} commits; PactDock verifies at most ${options.maxCommits}. Split or squash it.`);
  } else if (history.commits.length !== history.totalCount) {
    problems.push(`Only ${history.commits.length} of ${history.totalCount} commits could be read.`);
  }

  for (const commit of history.commits) {
    if (commit.authorsTruncated) problems.push(`Commit ${commit.oid.slice(0, 7)} lists too many co-authors to verify.`);
    commit.authors.forEach((identity, index) => {
      const role: Role = index === 0 ? "commit author" : "co-author";
      if (role === "co-author" && !options.coAuthors) return;
      const account = resolveIdentity(identity);
      if (account) add(account, role);
      else unresolved.push({ name: identity.name, commit: commit.oid, role });
    });
    if (options.committers) {
      const account = resolveIdentity(commit.committer);
      if (account?.id === WEB_FLOW_ID) continue;
      if (account) add(account, "committer");
      else unresolved.push({ name: commit.committer.name, commit: commit.oid, role: "committer" });
    }
  }

  return { contributors: [...byId.values()], unresolved, problems };
}
