// Pull request verification: who must sign, who has, and the resulting check
// run and PR comment. Any error produces a failing check (fail closed).

import { collectContributors, type Contributor, type UnresolvedIdentity } from "../../src/contributors.ts";
import type { Http } from "../../src/http.ts";
import type { Vault } from "./crypto.ts";
import type { Db, RepoRow, VersionRow } from "./db.ts";
import type { GitHubClient } from "./github.ts";

export const CHECK_NAME = "PactDock CLA";
export const COMMENT_MARKER = "<!-- pactdock-server:status -->";
const MAX_COMMITS = 250;

export interface Coverage {
  covered: (Contributor & { how: string })[];
  unsigned: (Contributor & { pendingEntity?: string })[];
  unresolved: UnresolvedIdentity[];
  problems: string[];
  passed: boolean;
}

export interface VerifyContext {
  db: Db;
  vault: Vault;
  github: GitHubClient;
  publicUrl: string;
  botLogin: string;
  log: (message: string) => void;
}

/** Versions of an agreement that satisfy a repository's policy. */
export function acceptedVersions(db: Db, agreementId: number, policy: "current" | "any"): VersionRow[] {
  const all = db.all<VersionRow>("SELECT * FROM agreement_versions WHERE agreement_id = ? ORDER BY id DESC", agreementId);
  return policy === "any" ? all : all.slice(0, 1);
}

export function coverageFor(db: Db, repo: RepoRow, contributors: Contributor[]): { covered: Coverage["covered"]; unsigned: Coverage["unsigned"] } {
  const allow = new Set((JSON.parse(repo.allowlist) as number[]) ?? []);
  const individual = repo.individual_agreement_id ? acceptedVersions(db, repo.individual_agreement_id, repo.version_policy).map((v) => v.id) : [];
  const entity = repo.entity_agreement_id ? acceptedVersions(db, repo.entity_agreement_id, repo.version_policy).map((v) => v.id) : [];
  const covered: Coverage["covered"] = [];
  const unsigned: Coverage["unsigned"] = [];

  for (const c of contributors) {
    if (allow.has(c.id)) {
      covered.push({ ...c, how: "allowlisted" });
      continue;
    }
    if (individual.length) {
      const sig = db.get<{ version: string }>(
        `SELECT v.version FROM signatures s JOIN agreement_versions v ON v.id = s.agreement_version_id
         WHERE s.github_id = ? AND s.entity_name IS NULL AND s.agreement_version_id IN (${individual.map(() => "?").join(",")}) LIMIT 1`,
        c.id,
        ...individual,
      );
      if (sig) {
        covered.push({ ...c, how: `individual agreement v${sig.version}` });
        continue;
      }
    }
    if (entity.length) {
      const rows = db.all<{ entity_name: string; status: string; authorised: string }>(
        `SELECT s.entity_name, e.status, e.authorised FROM signatures s JOIN entity_status e ON e.signature_id = s.id
         WHERE s.agreement_version_id IN (${entity.map(() => "?").join(",")})`,
        ...entity,
      );
      const mine = rows.filter((r) => (JSON.parse(r.authorised) as number[]).includes(c.id));
      const active = mine.find((r) => r.status === "active");
      if (active) {
        covered.push({ ...c, how: `entity agreement (${active.entity_name})` });
        continue;
      }
      const pending = mine.find((r) => r.status === "pending");
      if (pending) {
        unsigned.push({ ...c, pendingEntity: pending.entity_name });
        continue;
      }
    }
    unsigned.push(c);
  }
  return { covered, unsigned };
}

function plain(text: string): string {
  const cleaned = text.replace(/[^\p{L}\p{N} .,'_-]/gu, "").trim().slice(0, 80);
  return cleaned ? `\`${cleaned}\`` : "`(unnamed)`";
}

export function signLink(vault: Vault, publicUrl: string, repoId: number, pr: number, days = 14): string {
  const token = vault.sign("sign", `${repoId}-${pr}`, new Date(Date.now() + days * 864e5));
  return `${publicUrl}/sign/${encodeURIComponent(token)}`;
}

export function renderComment(c: Coverage, link: string, agreementName: string): string {
  const lines = [COMMENT_MARKER, ""];
  if (c.passed) {
    lines.push("### ✅ PactDock: all contributors are covered", "", "Every contributor to this pull request has accepted the contributor agreement. Thank you!");
    return lines.join("\n");
  }
  lines.push("### ✍️ PactDock: contributor agreement required", "");
  lines.push(`Before this pull request can be merged, each contributor below must accept the **${agreementName}**.`, "");
  lines.push(`**[Review and sign the agreement](${link})** (sign in with GitHub, read the agreement, sign once). One signature covers all your future contributions to repositories that use this agreement.`, "");
  if (c.problems.length) {
    lines.push("**PactDock could not verify this pull request:**", "", ...c.problems.map((p) => `- ${p}`), "");
  }
  if (c.unsigned.length) {
    lines.push("**Still to sign:**", "");
    for (const u of c.unsigned) {
      lines.push(`- [ ] @${u.login} (${u.roles.join(", ")})${u.pendingEntity ? ` (entity agreement for ${plain(u.pendingEntity)} awaiting approval)` : ""}`);
    }
    lines.push("");
  }
  if (c.unresolved.length) {
    lines.push("**Commit identities that are not linked to a GitHub account:**", "");
    for (const u of c.unresolved) lines.push(`- ${plain(u.name)} (${u.role}) in ${u.commit.slice(0, 7)}`);
    lines.push("", "Each person should sign using a GitHub account that has that commit email verified, or the commit must be re-authored.", "");
  }
  if (c.covered.length) lines.push(`**Covered:** ${c.covered.map((x) => `@${x.login}`).join(", ")}`, "");
  lines.push("<sub>This check updates automatically after signing. Powered by PactDock.</sub>");
  return lines.join("\n");
}

/**
 * Evaluates one pull request and publishes the result. Returns the conclusion.
 * Throws only if even the failure check could not be published.
 */
export async function verifyPullRequest(ctx: VerifyContext, repo: RepoRow, number: number): Promise<"success" | "action_required" | "failure" | "skipped"> {
  const { db, github } = ctx;
  if (!repo.enabled || repo.removed) return "skipped";
  const http: Http = await github.installation(repo.installation_id, repo.id);
  const pr = await github.pullRequest(http, repo.full_name, number);
  const now = new Date().toISOString();
  if (pr.state !== "open") {
    db.run("UPDATE pull_requests SET state = 'closed', updated_at = ? WHERE repository_id = ? AND number = ?", now, repo.id, number);
    return "skipped";
  }
  const link = signLink(ctx.vault, ctx.publicUrl, repo.id, number);
  let coverage: Coverage;
  try {
    if (!repo.individual_agreement_id || !db.currentVersion(repo.individual_agreement_id)) {
      throw new Error("No published individual agreement is assigned to this repository.");
    }
    const resolveEmail = (email: string) => {
      const rows = db.all<{ github_id: number; login: string }>(
        `SELECT DISTINCT e.github_id, COALESCE((SELECT github_login FROM signatures WHERE github_id = e.github_id ORDER BY seq DESC LIMIT 1), '') AS login
         FROM email_identities e WHERE e.email_hash = ?`,
        ctx.vault.emailHash(email),
      );
      return rows.length === 1 ? { id: rows[0]!.github_id, login: rows[0]!.login || `id-${rows[0]!.github_id}` } : null;
    };
    const history = await github.pullRequestCommits(http, repo.full_name, number, pr.headSha, resolveEmail);
    const set = collectContributors(pr, history, { coAuthors: Boolean(repo.co_authors), committers: Boolean(repo.committers), maxCommits: MAX_COMMITS });
    const { covered, unsigned } = coverageFor(db, repo, set.contributors);
    coverage = { covered, unsigned, unresolved: set.unresolved, problems: set.problems, passed: unsigned.length === 0 && set.unresolved.length === 0 && set.problems.length === 0 };
  } catch (err) {
    ctx.log(`Verification error for ${repo.full_name}#${number}: ${(err as Error).message}`);
    coverage = { covered: [], unsigned: [], unresolved: [], problems: [`Verification error: ${(err as Error).message}`], passed: false };
  }

  const conclusion = coverage.passed ? "success" : coverage.problems.length ? "failure" : "action_required";
  const missing = coverage.unsigned.length + coverage.unresolved.length;
  const title = coverage.passed
    ? `All ${coverage.covered.length} contributor(s) covered`
    : coverage.problems.length
      ? "Could not verify contributor agreements"
      : `${missing} contributor(s) must sign the contributor agreement`;
  const agreementName = repo.individual_agreement_id ? (db.agreement(repo.individual_agreement_id)?.name ?? "contributor agreement") : "contributor agreement";
  const summary = renderComment(coverage, link, agreementName).replace(COMMENT_MARKER, "").trim();
  await github.createCheckRun(http, repo.full_name, pr.headSha, { name: CHECK_NAME, conclusion, title, summary, detailsUrl: link });

  db.run(
    `INSERT INTO pull_requests (repository_id, number, head_sha, state, conclusion, pending, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)
     ON CONFLICT(repository_id, number) DO UPDATE SET head_sha = excluded.head_sha, state = 'open', conclusion = excluded.conclusion, pending = excluded.pending, updated_at = excluded.updated_at`,
    repo.id,
    number,
    pr.headSha,
    conclusion,
    JSON.stringify(coverage.unsigned.map((u) => u.id)),
    now,
  );

  if (repo.comment) {
    try {
      const body = renderComment(coverage, link, agreementName);
      const existing = await github.markerComment(http, repo.full_name, number, COMMENT_MARKER, ctx.botLogin);
      if (existing) {
        if (existing.body !== body) await github.updateComment(http, repo.full_name, existing.id, body);
      } else if (!coverage.passed) {
        await github.createComment(http, repo.full_name, number, body);
      }
    } catch (err) {
      // The check run is authoritative; a comment failure must not hide it.
      ctx.log(`Could not update the PR comment on ${repo.full_name}#${number}: ${(err as Error).message}`);
    }
  }
  return conclusion;
}

/** Re-verifies every open pull request that was waiting on this account. */
export async function recheckForAccount(ctx: VerifyContext, githubId: number): Promise<number> {
  const rows = ctx.db.all<{ repository_id: number; number: number; pending: string }>("SELECT repository_id, number, pending FROM pull_requests WHERE state = 'open' AND conclusion != 'success'");
  let count = 0;
  for (const row of rows) {
    if (!(JSON.parse(row.pending) as number[]).includes(githubId)) continue;
    const repo = ctx.db.repo(row.repository_id);
    if (!repo) continue;
    try {
      await verifyPullRequest(ctx, repo, row.number);
      count++;
    } catch (err) {
      ctx.log(`Recheck of ${repo.full_name}#${row.number} failed: ${(err as Error).message}`);
    }
  }
  return count;
}
