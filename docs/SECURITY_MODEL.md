# PactDock security model

## Trust boundaries

| Source | Trusted? | Used for |
| --- | --- | --- |
| Webhook payload (`GITHUB_EVENT_PATH`) | Yes. GitHub generates it. | Event type, comment ID/author/body, PR number |
| Default-branch HEAD (config, agreement texts, workflow) | Yes. Changes need to land on the default branch. | Configuration, documents |
| Signature store | Yes, if access is restricted (see SETUP.md §2). Records are still validated. | Records |
| PR title, body, branch names, file contents, code | **No.** Never read, checked out or executed. | — |
| Git commit names and emails | **No.** They are self-asserted. | Only to identify extra people who must sign. Names are rendered inert. |

## Controls

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
9. **Append-only audit trail.** PactDock never deletes or rewrites signature entries. Every write is a Git commit with a descriptive message, and the evidence holds the comment ID, URL, exact text and hash, document hash and permalink, and the run URL.
10. **Injection resistance.** Untrusted names are reduced to a safe character set inside code spans. Entity names must match a conservative pattern. Store paths are built only from validated IDs and slugs.
11. **Supply chain.**
    - Zero runtime dependencies.
    - Dev dependencies are pinned exactly (`typescript`, `@types/node`), and `npm ci --ignore-scripts` is used in CI.
    - CI actions are pinned to full SHAs.
    - `check-dist` proves the committed `dist/` was built from the reviewed `src/`.

## Residual risks (accepted or mitigated by configuration)

- **Users with write access** to the protected repository can, in token mode, post a fake status through a workflow on a branch. *Mitigation:* GitHub App mode with source pinning.
- **Store writers** can alter records. *Mitigation:* restrict access, protect the branch, review the Git history.
- **Self-asserted git authorship.** Someone can attribute their commit to an account that has already signed. The authenticated PR author must still be covered, so responsibility stays with an identified, signed person.
- **Repository admins** can disable rulesets or the workflow. Use organisation-level rulesets and audit logs for oversight.
- **Merge queue** is not supported yet (blocks, does not bypass).

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
