# PactDock Master Plan

> This plan is the source of truth for the PactDock architecture and roadmap. Change it first, then the code.

**Owner:** ASPEC RACING PTY LTD (Australia)
**Status:** v1.0 implemented. Licence approved: PolyForm Shield 1.0.0 (2026-10-20). CLA texts are **pending legal review** (see §8).

---

## 1. Goals

PactDock is a lightweight, secure and reusable Contributor Licence Agreement (CLA) enforcement tool for GitHub.

| Goal | How PactDock meets it |
| --- | --- |
| No subscriptions, servers, external services or databases | A single JavaScript GitHub Action. State lives in a Git repository you own. |
| Reusable by anyone, on any repository or organisation | A JSON config file names the agreements, rights holder and signature store. |
| ASPEC keeps full control | Source-available licence (PolyForm Shield 1.0.0). No third-party runtime code. |
| Explicit, verifiable acceptance | The contributor posts an exact acceptance phrase from their authenticated GitHub account. The record is keyed by numeric account ID. |
| Merges blocked until signed | A commit status that you make a required check in rulesets or branch protection. |

Non-goals for v1: a hosted web UI, e-signature pads, CLA document templating, merge-queue (`merge_group`) support (see §10).

## 2. Research summary

| Topic | Finding | Effect on the design |
| --- | --- | --- |
| `pull_request_target` | Since 2025-12-08 the workflow file and `GITHUB_SHA` always come from the **default branch**. It has write tokens and secrets even for fork PRs, and runs regardless of fork-approval settings. | Use it, but **never check out or run PR code**. A PR cannot change the workflow. |
| `issue_comment` | Runs from the default branch. Activity types are `created`, `edited` and `deleted`. On an edit, `comment.user` stays the original author while `sender` is the editor. | Only accept `created`, require `sender.id == comment.user.id`, and re-fetch the comment to confirm it is unedited. |
| Commit statuses | Need `statuses: write` and push access. A fork-PR `pull_request` token is read-only. Rulesets can pin a required status to an **expected source app**; the GitHub Actions app is ID 15368. | Report a status context (`PactDock CLA`). Recommend a GitHub App plus a pinned source. |
| GitHub App tokens | JWT (RS256, at most 10 min), then `POST /app/installations/{id}/access_tokens`. The `repositories` and `permissions` fields can only narrow access. Tokens last 1 h. | Mint per-repository, least-privilege tokens with `node:crypto`. No dependency needed. |
| `Commit.authors` (GraphQL) | Includes the git author and `Co-authored-by:` trailers, resolved by GitHub to users where the email is linked. A PR commit list is capped at 250. | Use it for co-authors. Fail closed above 250 commits or for unresolved identities. |
| Contents API | Optimistic concurrency via blob `sha`; 409/422 on conflict; 1 MB read limit. | One file per signer, retry on conflict, append-only. |
| Branch protection / rulesets on **private** repos | Need GitHub Pro, Team or Enterprise (unverified for Free). | The store-protection advice covers both cases (§6). |
| Runtimes | `node24` is the default; `node20` was removed in Sept 2026. | `runs.using: node24`. |
| Existing tools | CLA Assistant (SAP) is a hosted service with MongoDB. CLA Assistant Lite was **archived 2026-03-23**, used one shared JSON file (commit races) and needed a PAT. EasyCLA is heavy and tied to the Linux Foundation. | PactDock fills the self-contained, maintained niche. |
| Harmony CLAs | Only release is v1.0 (4 July 2011), licensed CC BY 3.0. Outbound "Option Five" allows any licence. The copyright grant is limited to "as part of the Material". The moral-rights clause is a waiver. | ASPEC drafts are original text modelled on Harmony, with a broadened grant and Australian moral-rights *consent* (§8). |
| Licences | PolyForm Shield 1.0.0 blocks competing products and services (paid or free) with no expiry. BSL and FSL convert to open source after 4 or 2 years. ELv2 does not block resale of copies. Commons Clause is ambiguous and blocks paid installation consulting. | Shield adopted (§9). |

## 3. Architecture

```
            GitHub events (default-branch workflow)
  pull_request_target ─┐   issue_comment ─┐   schedule / workflow_dispatch ─┐
                       ▼                  ▼                                  ▼
                 ┌─────────────────────────────────────────────────────────────┐
                 │ PactDock action (node24, zero runtime dependencies)          │
                 │  index.ts      inputs, tokens, fail-closed wrapper            │
                 │  pactdock.ts   orchestration per event                        │
                 │  config.ts     strict JSON config (default branch only)       │
                 │  contributors  PR author + commit authors + co-authors (IDs)  │
                 │  signing.ts    exact-phrase parsing                           │
                 │  store.ts      append-only JSON records, schema validation    │
                 │  evaluate.ts   pure pass/fail decision                        │
                 │  report.ts     status text + sticky comment (inert rendering) │
                 │  http/github   fetch REST + GraphQL, retries, pagination      │
                 │  app-auth.ts   GitHub App JWT → scoped installation tokens    │
                 └───────────────┬───────────────────────────────┬─────────────┘
                                 │ statuses, comments (repo token) │ contents (store token)
                                 ▼                               ▼
                        PR repository                 Private signature repository
                  (required status "PactDock CLA")    signatures/individual/<agreement>/<accountId>.json
                                                      signatures/entity/<agreement>/<entity-slug>.json
```

**Why a JavaScript action rather than a reusable workflow or composite action?** A JS action runs in one process with no shell interpolation of untrusted strings. It needs no `actions/checkout`, and can be pinned by SHA. A reusable workflow would still need the same triggers in each caller and adds `secrets: inherit` risks.

**Why zero runtime dependencies?** The GitHub API is reached with Node 24's `fetch`, JWTs are signed with `node:crypto`, and workflow commands are written directly. That leaves nothing in the supply chain to compromise at runtime. The dev dependencies are `typescript` and `@types/node` only. Tests use the built-in `node:test`.

## 4. Features (v1.0)

| # | Feature | Status |
| --- | --- | --- |
| F1 | Check contributors on PR opened/synchronize/reopened | Done |
| F2 | Sign by PR comment with the exact acceptance phrase of the current version | Done |
| F3 | Identity = numeric GitHub account ID (logins are informational only) | Done |
| F4 | Contributors = PR author + every commit author + `Co-authored-by` (optional: committers) | Done |
| F5 | Unresolvable commit identities fail the check | Done |
| F6 | Individual CLA | Done |
| F7 | Entity CLA: signatory signs by comment → record **pending** → maintainer verifies and sets `active` with authorised account IDs | Done |
| F8 | Evidence: comment ID, URL, exact body + SHA-256, document path + SHA-256 + permalink, signed/recorded times, run URL, repository ID | Done |
| F9 | Automatic recheck after signing; `/pactdock recheck`; scheduled or manual sweep of open PRs | Done |
| F10 | Commit status for rulesets / required checks | Done |
| F11 | Configurable agreements, rights holder, accepted versions, document hash pin, storage repo/branch/directory, allowlist by ID | Done |
| F12 | Storage in a private repo (recommended) or a dedicated branch of the same repo | Done |
| F13 | GitHub App auth (recommended), fine-grained PAT or GITHUB_TOKEN (self storage) | Done |
| F14 | GitHub Enterprise Server via `GITHUB_API_URL` / `GITHUB_GRAPHQL_URL` | Done (untested on GHES) |
| F15 | GitHub-hosted and self-hosted runners (Node 24 capable) | Done |

## 5. Security design

Threat model and controls (details in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)):

| Threat | Control |
| --- | --- |
| Executing untrusted PR code | No checkout. Only API metadata is read. The workflow comes from the default branch. |
| PR modifies the workflow or config to bypass checks | `pull_request_target` and `issue_comment` use the default-branch workflow. Config and documents are read from the default-branch HEAD via the API. |
| Forged signature (someone signs for another) | Signer = `comment.user.id` from GitHub's payload. `sender.id` must equal the author. `created` events only. The comment is re-fetched and must be unedited and identical. Bots cannot sign. The signer must be a contributor to the PR. |
| Maintainer edits a contributor's comment to add the phrase | `edited` events are ignored. Comments with `updated_at != created_at` are rejected. |
| Record tampering | Records are append-only in Git, so history is the audit log. Each record is validated (schema, file name = account ID, every signature's signer = that account). Recommended store protections are in §6. |
| Spoofed git author emails | The PR author (authenticated) must always sign, and every attributed identity must sign too. That is stricter, never looser. |
| Fake "success" status from another workflow or user | Use a GitHub App and pin the ruleset's required check to that app as the expected source. In GITHUB_TOKEN mode, pin it to GitHub Actions (15368), which leaves only users with write access able to forge it (documented). |
| Merge bypass | Required status in rulesets, with "Do not allow bypassing" and no bypass actors (see docs/SETUP.md). |
| Errors or partial runs | Fail closed: a `pending` status is set before evaluation. Errors set `error` and exit 1. A missing status blocks the merge. |
| Markdown or mention injection via git names | Untrusted strings are stripped to a safe character set and rendered in code spans. |
| Token leakage | Tokens are masked (`::add-mask::`). App tokens are scoped to one repository with minimal permissions and expire within an hour. No `persist-credentials`. |
| Dependency or action supply chain | Zero runtime dependencies. CI actions are pinned to SHAs. Dependabot proposes updates for review. `check-dist` proves `dist/` equals the reviewed source. |
| Config typos weakening enforcement | Strict validation: unknown keys are rejected and all values are pattern-checked. |
| Silent agreement text change | Optional `sha256` pin. Every signature records the document hash. |

## 6. Storage design

- **Location:** a private repository (e.g. `aspec-racing/cla-signatures`) shared by every repository that uses the same agreements. The alternative is `"self"` with a dedicated branch.
- **Layout:** one file per signer or entity, to avoid write races:
  - `signatures/individual/<agreementId>/<accountId>.json`, schema `pactdock/individual@1`.
  - `signatures/entity/<agreementId>/<slug>.json`, schema `pactdock/entity@1`, with `status` set to pending, active or revoked, plus `authorisedAccounts`.
- **Writes:** Contents API with blob-SHA optimistic concurrency, retried up to 4 times. Idempotent per comment ID. Existing entries are never modified or deleted by PactDock.
- **Audit:** every write is a Git commit naming the signer, account ID and PR. Git history is the audit log.
- **Store protection (recommended):** a ruleset or branch protection on the store's branch that blocks force-pushes and deletions. Limit write access to the PactDock App and the legal or maintainer team. Turn on audit-log streaming where available. On GitHub Free private repos, where rulesets may be unavailable, keep collaborators to a minimum and mirror or back up the repository.
- **Privacy:** records hold GitHub account IDs, logins and comment text, but no emails. Keep the store private. Consider a retention and privacy notice under the *Privacy Act 1988* (Cth) (flagged in docs/LEGAL_REVIEW.md).

## 7. Implementation phases

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Research, this plan | Done |
| 1 | Runtime helpers, HTTP client, App auth, config | Done |
| 2 | Contributors, signing, store, evaluation, reporting, orchestration | Done |
| 3 | Unit, integration (fakes) and end-to-end (compiled action vs mock API) tests; CI on Linux, Windows and macOS; dist check | Done |
| 4 | Docs, example workflows and configs, draft ASPEC CLAs | Done |
| 5 | **Approvals:** licence (§9, done), CLA legal review (§8) | **Partly done: CLA legal review outstanding** |
| 6 | Publish: create the GitHub repo, tag `v1.0.0`, record the release SHA in the examples, optionally list on the Marketplace | After phase 5 |
| 7 | Future: merge-queue support, an organisation-member exemption, a helper script for entity records, signature export/report | Backlog |

## 8. CLA rights (ASPEC repositories)

- Rights recipient: **ASPEC RACING PTY LTD**.
- Model: Harmony HA-CLA-I / HA-CLA-E v1.0 structure, with original drafting in `templates/cla/`.
- Contributors **keep copyright**. ASPEC gets a perpetual, irrevocable, worldwide, non-exclusive, royalty-free, transferable, sublicensable copyright licence, a patent licence and an express right to relicense under any terms, including proprietary or commercial ones.
- Differences from Harmony that need review are listed in [docs/LEGAL_REVIEW.md](docs/LEGAL_REVIEW.md). They include:
  - the broadened grant;
  - removing the Option Five condition;
  - Australian moral-rights consent instead of a waiver;
  - the governing-law State;
  - ACL carve-out;
  - electronic acceptance;
  - consideration;
  - minors;
  - entity employee consents;
  - the defensive patent clause.
- **The texts are drafts and must not be published to contributors until they are legally reviewed.**

## 9. PactDock licensing (approved 2026-10-20)

ASPEC approved the standard, unmodified **PolyForm Shield 1.0.0** on 2026-10-20. `LICENSE.md` holds the verbatim text with ASPEC's `Required Notice:` line, and `package.json` declares `PolyForm-Shield-1.0.0`. No custom licence is used.

ASPEC decided not to trademark "PactDock", so there is no trademark policy. Rebranded forks are restricted only when they compete with PactDock. Still open (see [docs/LICENSING.md](docs/LICENSING.md)): whether to restrict bundling inside non-competing paid products. Shield does not restrict this, so it remains allowed unless ASPEC decides otherwise.

## 10. Known limitations

- Merge queues: `merge_group` events are not handled yet, so a required PactDock status blocks queued merges. Use the status without a merge queue, or add this in phase 7.
- Signing in one PR does not immediately update the author's other open PRs. The scheduled sweep or `/pactdock recheck` does.
- Git author identity is self-asserted. PactDock requires the authenticated PR author **and** every attributed identity to be covered, but it cannot prove who wrote the code.
- More than 250 commits, or more than 25 authors on one commit, fails closed.
- Entity authority is verified by humans (status `active`), by design.

## 11. Testing strategy

| Layer | What | Where |
| --- | --- | --- |
| Unit | config validation, phrase parsing, identity resolution, rendering, HTTP retry and pagination, JWT signing, token down-scoping, output files | `test/units.test.ts` |
| Integration | full event flows against in-memory GitHub fakes: sign, forgery attempts, edits, bots, entities, versions, pins, conflicts, sweeps, fail-closed paths | `test/pactdock.test.ts` |
| End-to-end | the compiled `dist/index.js` run as a child process against a local mock of the GitHub REST and GraphQL API | `test/e2e.test.ts` |
| CI | typecheck, dist-matches-source, all tests on ubuntu, windows and macos | `.github/workflows/ci.yml` |
| Manual (pre-release) | sandbox org: App install, private store, ruleset with expected source, fork PR, sign, co-author, entity activation | `docs/SETUP.md` §Verification |
