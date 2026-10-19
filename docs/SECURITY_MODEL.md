# PactDock security model

This document covers both editions. [PactDock Lite](#pactdock-lite-github-action) is described first, then [PactDock Server](#pactdock-server).

## PactDock Lite (GitHub Action)

### Trust boundaries

| Source | Trusted? | Used for |
| --- | --- | --- |
| Webhook payload (`GITHUB_EVENT_PATH`) | Yes. GitHub generates it. | Event type, comment ID/author/body, PR number |
| Default-branch HEAD (config, agreement texts, workflow) | Yes. Changes need to land on the default branch. | Configuration, documents |
| Signature store | Yes, if access is restricted (see SETUP.md §2). Records are still validated. | Records |
| PR title, body, branch names, file contents, code | **No.** Never read, checked out or executed. | — |
| Git commit names and emails | **No.** They are self-asserted. | Only to identify extra people who must sign. Names are rendered inert. |

### Controls

1. **No untrusted code execution.** There is no `actions/checkout` and no shell. The action is one Node process that talks only to the GitHub API.
2. **Workflow integrity.** `pull_request_target` and `issue_comment` always run the default-branch workflow (GitHub change effective 2025-12-08). A PR cannot alter PactDock's workflow or config.
3. **Authenticated signer.** The signer is `comment.user.id` from the payload. PactDock also requires:
   - `action == created`;
   - `sender.id == comment.user.id`;
   - a `User` account (not a bot);
   - the comment re-fetched from the API, identical to the payload and never edited (`updated_at == created_at`);
   - the signer to be a contributor to that PR.
4. **Exact, explicit acceptance.** Only a comment that is exactly the phrase for the current version counts. Quoted replies, negations and old versions do not.
5. **ID-based identity.** Records are keyed by immutable numeric account IDs. Logins are informational. Allowlists take IDs only.
6. **Fail closed.**
   - A `pending` status is set before evaluation.
   - Any exception sets `error` and exits 1.
   - These all fail: unresolved commit identities, more than 250 commits, truncated co-author lists, malformed records, an invalid config, missing documents and hash-pin mismatches.
   - If the workflow does not run at all, the required status is missing and the merge stays blocked.
7. **Least privilege.**
   - The workflow token asks only for `statuses`, `pull-requests` and `issues` write, plus `contents: read`.
   - App tokens are minted per repository with explicit permission subsets and expire within an hour.
   - The store token touches only the store.
8. **Required-check source pinning.** Rulesets can require that the status comes from a specific app (your PactDock App, or GitHub Actions in token mode). Statuses from anyone else do not satisfy the rule.
9. **Write-once records.** Each signature is a new file per account and agreement version, created only if absent (Contents API PUT without a SHA, or S3 `If-None-Match: *`). PactDock never rewrites or deletes records. On GitHub every write is also a commit; on R2 or S3 a bucket lock or a policy without Delete makes records undeletable. The evidence holds the comment ID, URL, exact text and hash, document hash and permalink, and the run URL.
10. **Injection resistance.** Untrusted names are reduced to a safe character set inside code spans. Entity names must match a conservative pattern. Store paths are built only from validated IDs and slugs.
11. **Supply chain.**
    - Zero runtime dependencies.
    - Dev dependencies are pinned exactly (`typescript`, `@types/node`), and `npm ci --ignore-scripts` is used in CI.
    - CI actions are pinned to full SHAs.
    - `check-dist` proves the committed `dist/` was built from the reviewed `src/`.

### Optional Discord copies

Discord receives copies only after the record is stored, is never read back, and cannot replace the store. Mentions are disabled and text is stripped of Markdown. The webhook URL is a secret: anyone holding it can post to, or delete messages from, that channel.

### Residual risks (accepted or mitigated by configuration)

- **Users with write access** to the protected repository can, in token mode, post a fake status through a workflow on a branch. *Mitigation:* GitHub App mode with source pinning.
- **Store writers** can alter records. *Mitigation:* restrict access, protect the branch, review the Git history, or use an R2 bucket lock or S3 policy without Delete.
- **Self-asserted git authorship.** Someone can attribute their commit to an account that has already signed. The authenticated PR author must still be covered, so responsibility stays with an identified, signed person.
- **Repository admins** can disable rulesets or the workflow. Use organisation-level rulesets and audit logs for oversight.
- **Merge queue** is not supported yet (blocks, does not bypass).

## PactDock Server

### Trust boundaries

| Source | Trusted? | Used for |
| --- | --- | --- |
| Webhooks | Only with a valid `X-Hub-Signature-256` from the App's secret | PR and installation events |
| GitHub API (installation token) | Yes | PR author, commits, co-author trailers, user IDs |
| GitHub sign-in (PKCE) | Yes | Account ID, login, verified emails |
| Signer-entered values (name, title, entity, signature) | **No.** Validated and escaped. | Evidence in the record and the signed copy |
| Agreement text | Admins only; immutable once published | Shown to signers, hashed into every record |
| Git commit names and emails | **No.** Self-asserted. | Extra people who must sign |

### Controls

1. **No code access.** The App has Checks, Pull requests and Metadata permissions (plus account Email addresses for sign-in). It has no Contents permission and never fetches or runs code.
2. **Own App per owner.** Each Server creates its own private App with the manifest flow. There is no shared ASPEC App or gateway that could see other owners' data.
3. **Authenticated signers.** Identity comes from GitHub sign-in with PKCE and a single-use state. User tokens are used once and discarded. Signing links are HMAC-signed, bound to the repository and PR, and expire.
4. **Exact terms.** The signing form is bound to one agreement version ID; the version text and its SHA-256 are immutable; every record and signed copy carries that hash.
5. **Immutable evidence.** Signatures, agreement versions and the audit log are insert-only, enforced by SQLite triggers. Records form a SHA-256 hash chain. Signed documents are written once (exclusive create, read-only mode, or S3 `If-None-Match`). The integrity check re-verifies both.
6. **Encrypted credentials.** The App private key, client secret and webhook secret are stored with AES-256-GCM under the master key. Supply the key as a Docker secret and keep it apart from backups.
7. **Protected records.** Documents are served only to their signer, to admins, or through an expiring link. Downloads use an attachment disposition and a sandbox CSP. Emails are stored as keyed hashes for co-author matching.
8. **Web hardening.** Strict CSP without inline scripts, CSRF tokens on every form, HttpOnly SameSite cookies, HSTS, `frame-ancestors 'none'`, `no-referrer`, `no-store`, request body limits and timeouts, and rate limits on sign-in, signing and recovery. Recovery responses never reveal whether an address is known.
9. **Fail closed.** API errors, unresolved identities and more than 250 commits produce a `failure` check. If the Server is unreachable no check is posted and the ruleset blocks the merge. Stale PRs are re-swept every 15 minutes.
10. **Secure backups.** Backups are encrypted with a separate passphrase (scrypt + AES-256-GCM), exclude the master key, and restore only into an empty data directory with path-escape checks.
11. **Container hardening.** Non-root user, read-only root filesystem, no capabilities, `no-new-privileges`, base image pinned by digest, port bound to localhost behind a TLS proxy.

### Residual risks

- **Server administrators and host root** can stop the Server or read the database. They cannot silently alter records without breaking the hash chain, but they could delete the whole database. Keep off-host encrypted backups.
- **Loss of the master key** makes stored GitHub credentials unusable. Signature records and documents are not encrypted and stay readable, but the Server cannot reach GitHub until it is set up again on a fresh data directory. Keep a separate copy of the key.
- **Co-authors** are matched by verified email only when exactly one signer has that email; anything else fails closed.
- **Ruleset admins** can remove the required check. Use organisation rulesets and audit logs.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
