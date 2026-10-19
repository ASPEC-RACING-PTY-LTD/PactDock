# PactDock Master Plan

> This plan is the source of truth for the PactDock architecture and roadmap. Change it first, then the code.

**Owner:** ASPEC RACING PTY LTD (Australia)
**Status:** PactDock Server and PactDock Lite implemented (2026-10-20). Licence: PolyForm Shield 1.0.0. ASPEC agreements: v1.0 (licence) and v2.0 (assignment) published (§9).

---

## 1. Editions and goals

PactDock is a secure, self-contained Contributor Licence Agreement (CLA) tool for GitHub. It comes in two editions that share one code base and one record model.

| | **PactDock Server** (recommended) | **PactDock Lite** |
| --- | --- | --- |
| What it is | A self-hosted Docker application | A GitHub Action (`action.yml`) |
| GitHub connection | The owner's **own** GitHub App, created from the Server UI with the App Manifest flow | The workflow token, or an App or token for the store |
| How contributors sign | Sign in with GitHub, review the exact agreement, accept, type or draw a signature, download a signed copy | Post an exact acceptance phrase as a PR comment |
| Records | Local SQLite database (immutable, hash-chained) and signed documents on local disk or S3/R2 | Write-once JSON in a private GitHub repo or an S3/R2 bucket |
| Merge blocking | Check run `PactDock CLA` from the App | Commit status `PactDock CLA` |
| Extras | Admin portal, multi-repo management, entity management, expiring links, email recovery, encrypted backups | Optional Discord notifications or signature copies |

Shared goals:

| Goal | How |
| --- | --- |
| No subscription, no ASPEC-hosted service | Each owner runs their own Server or Action. There is **no global ASPEC App, gateway or hosted infrastructure**. |
| Owners control their agreements | Repository owners configure their own agreements, rights holder and versions. |
| Explicit, verifiable acceptance | Identity is the numeric GitHub account ID, proven by GitHub sign-in (Server) or by GitHub's authenticated comment payload (Lite). |
| Signed terms never change | Agreement versions and signature records are write-once. A new version needs a new acceptance. |
| Fail closed | Any error, unknown identity or unreadable store blocks the merge. |
| Never run PR code | Only API metadata is read. The Server has no source-code permission at all. |
| Minimal supply chain | Zero runtime npm dependencies. Node 24 built-ins (`fetch`, `node:crypto`, `node:sqlite`, `node:http`). CI actions and the Docker base image are pinned by digest. |

## 2. Research summary

| Topic | Finding | Effect on the design |
| --- | --- | --- |
| App Manifest flow | A form POSTs `manifest` (JSON) to `https://github.com/settings/apps/new` or `/organizations/<org>/settings/apps/new`, with `state`. GitHub redirects to `redirect_url?code=`. `POST /app-manifests/{code}/conversions` (no auth, code valid 1 h) returns `id`, `slug`, `client_id`, `client_secret`, `webhook_secret` and `pem`. | Fully automated App creation from the Server UI. Credentials are stored encrypted. |
| App permissions | Repository `checks: write`, `pull_requests: write`, `metadata: read`; account `email_addresses: read` (sign-in only). Events `pull_request`, `check_run`; installation events are always delivered. | **No `contents` permission**: the Server cannot read source code. |
| Co-authors without `contents` | `GET /repos/{o}/{r}/pulls/{n}/commits` works with `pull_requests: read` and includes commit messages, author IDs and `Co-authored-by` trailers (max 250 commits). | Trailers are parsed and resolved via GitHub-verified emails of signers. Unknown identities fail closed. |
| User sign-in | GitHub App user authorisation supports PKCE (S256). `GET /user/emails` needs Email addresses (read). | The Server proves the account ID and verified emails, then discards the user token. |
| Webhooks | `X-Hub-Signature-256` HMAC-SHA256. GitHub expects a response within 10 s; deliveries can repeat (`X-GitHub-Delivery`). | Verify, de-duplicate, answer 202, then process in a serial job queue. |
| Check runs | Need Checks write. `action_required` conclusion with a `details_url`. Rulesets can pin a required check to the App as the expected source. | Unsigned → `action_required` linking to the signing page. Errors → `failure`. |
| `node:sqlite` | Release candidate in Node 24.15+, no experimental warning from 24.16, supports `backup()`. | Embedded database with no dependency. `engines.node >=24.16`. |
| `pull_request_target` | The workflow and `GITHUB_SHA` always come from the default branch. It has write tokens and secrets even for fork PRs. | Lite uses it but never checks out or runs PR code. |
| `issue_comment` | On an edit, `comment.user` is the original author and `sender` the editor. | Lite accepts `created` only, requires `sender.id == comment.user.id` and re-fetches the comment. |
| S3 conditional writes | `If-None-Match: *` creates only if absent; failure is 412. | True write-once records on S3 and R2 without locks or a database. |
| Cloudflare R2 | S3 API, region `auto`, path-style endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. No versioning or Object Lock; **bucket locks** block delete and overwrite by prefix. | Write-once objects plus an R2 bucket lock make records undeletable. |
| Discord webhooks | Free-text messages and file attachments (multipart). No read or query API usable as a database; messages can be deleted by anyone with the webhook URL. | Discord is a **copy or notification target only**, never the store. |
| Existing tools | CLA Assistant is hosted (MongoDB). CLA Assistant Lite was archived 2026-03-23. EasyCLA is tied to the Linux Foundation. | PactDock fills the self-hosted, maintained niche. |
| Harmony agreements | v1.0 (2011), CC BY 3.0, both licence (HA-CLA) and assignment (HA-CAA) forms. | ASPEC texts are original drafting modelled on Harmony (§9). |

## 3. PactDock Server

### 3.1 Architecture

```
 GitHub ──webhooks (HMAC)──▶ ┌──────────────────────────── PactDock Server (Docker, node24) ───────────────────────────┐
   ▲                         │ web.ts       node:http, router, CSP/HSTS headers, body limits, rate limits               │
   │ check runs, comments    │ setup.ts     App Manifest flow → encrypted App credentials                               │
   │ (installation token,    │ webhooks.ts  signature check, de-dup, serial job queue                                   │
   │  one repo, 3 perms)     │ verify.ts    contributors → coverage → check run + sticky comment + signing link         │
   └─────────────────────────│ sign.ts      GitHub sign-in (PKCE), signing portal, documents, /my, email recovery       │
                             │ admin.ts     repos, agreements + immutable versions, entities, admins, audit, integrity  │
 Contributors ──https──────▶ │ db.ts        node:sqlite, triggers forbid UPDATE/DELETE on records                       │
 Admins ───────https──────▶  │ crypto.ts    AES-256-GCM vault, HMAC links, hash chain                                   │
                             │ documents.ts write-once signed copies: local volume (default) or S3/R2                   │
                             │ mailer.ts    optional SMTP (STARTTLS/TLS) for copies and recovery                        │
                             │ backup.ts    encrypted snapshots (database + documents)                                  │
                             └─────────────────────────────────────────────────────────────────────────────────────────┘
                                        /data volume: pactdock.db, documents/, master.key (if not supplied)
```

### 3.2 Setup and GitHub App

1. The owner runs the container with `PACTDOCK_PUBLIC_URL` (HTTPS, reachable by GitHub) and opens the one-time setup link (`PACTDOCK_SETUP_TOKEN`, or a random token printed to the log).
2. The setup page builds a manifest and POSTs it to GitHub (personal account or a named organisation). Permissions: `checks: write`, `pull_requests: write`, `metadata: read`, `email_addresses: read`. Events: `pull_request`, `check_run`. The App is private.
3. GitHub redirects to `/setup/callback`. The Server converts the code, stores the App ID, slug, client ID, and the **encrypted** private key, client secret and webhook secret.
4. The owner installs the App on the chosen repositories. Installation events and `/admin/sync` register them.
5. The person who completes setup while holding the setup cookie becomes the first administrator after GitHub sign-in. Further admins are added by GitHub login and stored by account ID.

### 3.3 Verification

- Triggers: `pull_request` opened, synchronize, reopened, ready_for_review, edited (base change only); `check_run` rerequested; signing; admin recheck; a 15-minute sweep of open PRs that are not green.
- Contributors: the PR author, commit authors and committers (optional), and `Co-authored-by` trailers (optional). Trailers resolve to an account only if exactly one signer has that verified email (stored as an HMAC). Unresolved identities, more than 250 commits, or any API error fail the check.
- Coverage: allowlisted account IDs, an individual signature of an accepted version, or an `active` entity that lists the account ID. Version policy per repository: `current` (only the latest version) or `any`.
- Output: one check run (`success`, `action_required` or `failure`) and one sticky PR comment with a personal signing link per missing contributor. Signing links are HMAC-signed, bound to the repository and PR, and expire after 14 days.

### 3.4 Signing portal

- The contributor opens the link and signs in with GitHub. The Server proves the account ID and verified emails.
- The page shows the **exact** agreement version text (rendered from Markdown with a safe renderer) and its SHA-256. The form is bound to that version ID, so a version published mid-signing is rejected.
- The contributor gives their legal name, optionally an email (one of their GitHub-verified addresses), ticks the agreement (and authority for entities), and types or draws a signature.
- The Server renders a self-contained signed HTML document (agreement text, execution block, signature, evidence), stores it **write-once**, and records the signature in a transaction.
- The contributor can download the copy at once, later from `/my`, or by email link (7 days). Lost access: `/recover` emails a 30-minute link to the addresses on file, without revealing whether an address exists.

### 3.5 Records and integrity

| Table | Rule |
| --- | --- |
| `agreement_versions` | Insert only. Text and SHA-256 never change; a duplicate version number is refused. |
| `signatures` | Insert only. Account ID, login, legal name, entity, email, signature data, time, IP, user agent, repository and PR, agreement version and hash, document key and hash, `prev_hash` and `record_hash` (SHA-256 chain over canonical JSON). |
| `audit_log` | Insert only. Every admin and security-relevant action. |
| `entity_status` | Mutable status (pending, active, revoked) and authorised IDs, maintained by admins, every change audited. |

SQLite triggers abort any `UPDATE` or `DELETE` on the insert-only tables. `/admin/integrity` re-walks the hash chain and re-hashes every stored document. Records for different repositories share agreements but each signature names its repository; admins see all repositories, contributors see only their own records.

### 3.6 Storage

- **Default:** the `/data` volume (SQLite + `documents/`, files created exclusively with mode 0444).
- **Optional S3/R2** for signed documents (`PACTDOCK_S3_*`), written with `If-None-Match: *` under a prefix. The database stays local.
- **Backups:** `backup` CLI or a schedule (`PACTDOCK_BACKUP_INTERVAL_HOURS`). A consistent SQLite snapshot plus local documents, packed and encrypted with a passphrase (scrypt + AES-256-GCM, format `PDBK1`), with pruning. `restore` refuses a non-empty data directory.

### 3.7 Security controls

| Threat | Control |
| --- | --- |
| Source-code exposure | No `contents` permission; the Server never fetches or runs code. |
| Forged webhooks | HMAC-SHA256 with the App's webhook secret, constant-time compare, 10 MB limit, delivery de-duplication. |
| Account impersonation | Identity only from GitHub sign-in (PKCE, state bound to a stored verifier). User tokens are discarded after sign-in. |
| Stolen or guessed links | 256-bit random or HMAC-signed tokens, purpose-bound and expiring. Links in the database are stored as SHA-256 hashes. |
| Credential theft from disk | App key, client secret and webhook secret are AES-256-GCM encrypted with the master key, which should be supplied as a Docker secret and kept apart from backups. |
| Record tampering | Insert-only tables enforced by triggers, hash chain, write-once documents, integrity check, audit log. |
| Web attacks | Strict CSP (no inline script), CSRF tokens on every form, `SameSite=Lax` HttpOnly cookies, no-referrer, no-store, HSTS, `frame-ancestors 'none'`, output escaping, sandboxed document downloads. |
| Brute force and enumeration | Rate limits on sign-in, signing and recovery; recovery responses do not reveal accounts. |
| Fake green check | Ruleset requires `PactDock CLA` with the App as the expected source. |
| Errors | Fail closed: errors become a `failure` check; a missing check blocks the merge. |
| Container escape and drift | Non-root `node` user, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, base image pinned by digest, port bound to localhost behind a TLS reverse proxy. |

## 4. PactDock Lite (GitHub Action)

### 4.1 Architecture

```
  pull_request_target ─┐  issue_comment ─┐  schedule / workflow_dispatch ─┐
                       ▼                 ▼                                ▼
                 ┌───────────────────────────────────────────────────────────┐
                 │ PactDock action (node24, zero runtime dependencies)        │
                 │  config, contributors, signing, evaluate, report           │
                 │  store.ts  write-once records behind StorePort             │
                 │  github.ts / s3-store.ts   storage backends                │
                 │  discord.ts  optional notification or signature copy       │
                 └──────────┬─────────────────────────────┬──────────────────┘
                            ▼                             ▼
                 PR repository (status, comment)   Store: private GitHub repo / branch, or S3 / R2
```

### 4.2 Records (write-once)

- Individual: `<dir>/individual/<agreementId>/<version>/<accountId>.json`, schema `pactdock/individual@2`, one file per account and version. A new version creates a new file; existing files are never rewritten.
- Entity: `<dir>/entity/<agreementId>/<slug>.json`, created once as `pending`. Maintainers activate it and list authorised IDs by a reviewed edit in the store.
- Creation is conditional: Contents API PUT without a SHA (GitHub store) or `If-None-Match: *` (S3/R2). If the object already exists, the signature is treated as a duplicate.
- Each record is validated against its location (account, agreement, version) before it counts.

### 4.3 Storage options

| `storage.type` | Use | Protection |
| --- | --- | --- |
| `github` (default) | Private repository, or a dedicated branch of the same repository | Ruleset blocking force-push and deletion; minimal write access |
| `s3` | Amazon S3 or Cloudflare R2 | AWS: IAM Get/Put/List on the prefix, no Delete, optional Object Lock. R2: bucket-scoped token, bucket lock on the prefix |

S3 credentials come only from action inputs (secrets) or `AWS_*` environment variables (OIDC). SigV4 is implemented with `node:crypto` and tested against AWS's published vectors.

### 4.4 Discord (optional)

`"discord": { "mode": "notify" | "signature" }` plus the `discord-webhook-url` secret. `notify` posts a short message; `signature` also attaches the stored record JSON. It runs only **after** the record is safely stored, failures are warnings, and mentions are disabled. Discord is never accepted as the only store: a readable `storage` is always required.

## 5. Legal model

- Repository owners configure their own agreements (Server admin portal, or Lite config files). PactDock does not impose terms.
- Each agreement version is immutable once published. Signatures name the version and its SHA-256. A new version applies only to people who accept it; earlier signatures continue under their own terms. Owners decide per repository whether older versions still satisfy the check.
- Evidence kept per signature: account ID and login, legal name, time, IP and user agent (Server), the exact agreement text hash, the signature (typed, drawn or comment), repository and PR, and a downloadable signed copy.
- Electronic acceptance relies on the *Electronic Transactions Act 1999* (Cth) and equivalents; the ASPEC agreements state the contributor's consent to electronic signature.

## 6. Features

| # | Feature | Edition | Status |
| --- | --- | --- | --- |
| F1 | Check PRs on open, update, reopen; recheck on sign, request, sweep | Both | Done |
| F2 | Identity by numeric GitHub account ID | Both | Done |
| F3 | Contributors: PR author, commit authors, co-authors, optional committers; fail closed on unknown identities and >250 commits | Both | Done |
| F4 | Individual and entity agreements; entity activation with authorised IDs | Both | Done |
| F5 | App Manifest setup, own App per owner, minimal permissions | Server | Done |
| F6 | Signing portal: review, accept, typed or drawn signature, signed copy | Server | Done |
| F7 | Expiring signing, download and recovery links; email recovery | Server | Done |
| F8 | Admin portal: repos, agreements and versions, signatures, entities, admins, audit, integrity | Server | Done |
| F9 | Immutable records, hash chain, write-once documents, encrypted credentials | Server | Done |
| F10 | Local or S3/R2 document storage; encrypted scheduled backups and restore | Server | Done |
| F11 | Docker image and hardened compose file | Server | Done |
| F12 | Comment signing with exact phrase and edit protection | Lite | Done |
| F13 | Write-once records in a GitHub repo or S3/R2 | Lite | Done |
| F14 | Discord notifications or signature copies | Lite | Done |
| F15 | GitHub Enterprise Server | Both | Configurable, untested |

## 7. Implementation phases

| Phase | Scope | Status |
| --- | --- | --- |
| 0–5 | Research, Lite action, tests, docs, licence and v1.0 agreements | Done |
| 6 | Publish Lite (`v1.0.0` tag, release SHA in examples) | In progress |
| 7 | Lite write-once records, S3/R2 store, Discord option | Done |
| 8 | PactDock Server: core, setup, webhooks, verification, signing portal, admin, storage, backups, Docker | Done |
| 9 | ASPEC v2.0 assignment agreements | Done (texts published; dogfood config uses v2.0) |
| 10 | Pre-release manual checks: real App via manifest, ruleset with the App as source, fork PR, sign (typed and drawn), co-author, entity activation, email, R2 documents, backup and restore | Pending |
| 11 | Backlog: merge-queue (`merge_group`) support, export or report of signatures, published container image, migration tool from Lite records to the Server | Backlog |

## 8. Testing strategy

| Layer | What | Where |
| --- | --- | --- |
| Lite unit and integration | config, phrases, identities, rendering, HTTP, JWT, write-once store, entity flow, fail-closed paths | `test/units.test.ts`, `test/pactdock.test.ts` |
| Lite S3 and Discord | SigV4 against AWS vectors, R2 and AWS addressing, conditional writes, Discord payloads | `test/s3.test.ts` |
| Lite end-to-end | compiled `dist/index.js` against a mock GitHub API | `test/e2e.test.ts` |
| Server unit | vault, tokens, backups, canonical JSON, Markdown escaping, strokes, documents, trailers, webhook HMAC, settings, router, SMTP | `server/test/units.test.ts` |
| Server integration | a real HTTP server against a fake GitHub: manifest permissions, full sign flow, link expiry and forgery, >250 commits, entities, admin protection, immutable versions, backup round trip | `server/test/server.test.ts` |
| Container | image build, hardened run (read-only, non-root, no capabilities), healthcheck, setup page, backup CLI, compose validation | manual (`docs/SERVER.md`) |
| CI | typecheck, Lite build, Server build, dist check, all tests on Ubuntu, Windows and macOS | `.github/workflows/ci.yml` |

## 9. Agreements (ASPEC repositories)

- Rights recipient: **ASPEC RACING PTY LTD**. Governing law: Victoria, Australia.
- **v1.0 (licence)**, `ASPEC-ICLA-1.0.md` / `ASPEC-ECLA-1.0.md`: contributors keep copyright and grant a broad licence. These texts never change; signatures under them keep their terms.
- **v2.0 (assignment)**, `ASPEC-ICA-2.0.md` / `ASPEC-ECA-2.0.md`, modelled on Harmony HA-CAA:
  - assignment of copyright, including future copyright (s 197 *Copyright Act 1968* (Cth));
  - licence back to the contributor for their own contributions;
  - fallback exclusive licence where an assignment is ineffective;
  - Harmony-style outbound condition: also licensed under the Project's licence on the Submission Date;
  - patent licence and Australian moral-rights consent;
  - limited waiver of claims, covering only the contributor's own contributions and the rights granted;
  - irrevocable grants for Existing Contributions, with earlier licences preserved;
  - the contributor may end the agreement for future contributions; grants for past contributions stay permanent;
  - ASPEC's discretionary removal right and a good-faith removal-request process;
  - no unilateral changes: new versions apply only when accepted;
  - electronic signature consent covering s 196(3) of the *Copyright Act 1968* (Cth).
- Because v2.0 is an assignment, v1.0 signatures do not satisfy it; contributors accept v2.0 once.

## 10. PactDock licensing

ASPEC approved the standard, unmodified **PolyForm Shield 1.0.0** on 2026-10-20. `LICENSE.md` holds the verbatim text with ASPEC's `Required Notice:` line. ASPEC decided not to trademark "PactDock". See [docs/LICENSING.md](docs/LICENSING.md).

## 11. Known limitations

- Merge queues (`merge_group`) are not handled, so a required check blocks queued merges.
- Git author identity is self-asserted; PactDock requires the authenticated PR author **and** every attributed identity to be covered, but cannot prove authorship.
- Server co-author resolution needs the co-author to have signed with that verified email; otherwise the PR fails closed until they sign or an admin allowlists them.
- Entity authority is verified by humans, by design.
- Server: one instance per database (SQLite); scale by running one Server per organisation.
