# Configuration reference

PactDock reads `.github/pactdock.json` (or the `config-path` input) from the **head of the default branch**, never from a pull request. The file is strict JSON. Unknown keys are rejected so that a typo fails loudly instead of weakening enforcement. Use `"$comment"` keys for notes.

```json
{
  "rightsHolder": "ASPEC RACING PTY LTD",
  "individual": {
    "id": "aspec-icla",
    "name": "ASPEC Individual Contributor Licence Agreement",
    "version": "1.0",
    "document": ".github/cla/ASPEC-ICLA-1.0.md",
    "sha256": "optional 64-hex pin",
    "acceptedVersions": ["1.0"]
  },
  "entity": { "id": "aspec-ecla", "name": "...", "version": "1.0", "document": "..." },
  "storage": { "repository": "ASPEC-RACING-PTY-LTD/cla-signatures", "branch": "main", "directory": "signatures" },
  "statusContext": "PactDock CLA",
  "allowlist": { "accountIds": [49699333] },
  "coAuthors": true,
  "committers": false,
  "comment": true,
  "entityInstructionsUrl": "https://example.com/entity-cla"
}
```

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `rightsHolder` | yes | | Legal name of the party receiving the rights. Shown to contributors. |
| `individual.id` | yes | | Stable store identifier (`a-z0-9-`). Keep it unchanged across versions. |
| `individual.name` | yes | | Agreement name. Forms part of the signing phrase. |
| `individual.version` | yes | | Current version. Forms part of the signing phrase. |
| `individual.document` | yes | | Repository path of the text. Its SHA-256 and a commit permalink are recorded with each signature. |
| `individual.sha256` | no | | If set, PactDock fails closed when the document's hash differs. This stops silent edits. |
| `individual.acceptedVersions` | no | `[version]` | Versions whose existing signatures still satisfy the check. Must include `version`. |
| `entity` | no | | Same shape as `individual`. Enables entity signing (see SETUP.md). |
| `storage.type` | no | `github` | `github` (a repository) or `s3` (Amazon S3, Cloudflare R2 or another S3 API with conditional writes). |
| `storage.repository` | for `github` | | `owner/name` of the store, or `"self"`. |
| `storage.branch` | for `self` | store default branch | Branch holding records. |
| `storage.bucket` | for `s3` | | Bucket name. |
| `storage.region` | for `s3` | | `auto` for R2, or an AWS region such as `ap-southeast-2`. |
| `storage.endpoint` | no | Amazon S3 | `https://` endpoint, e.g. `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. |
| `storage.pathStyle` | no | `true` with `endpoint`, else `false` | Path-style addressing (`endpoint/bucket/key`). |
| `storage.directory` | no | `signatures` | Directory (key prefix) within the store. |
| `discord.mode` | no | | `notify` (short message) or `signature` (message plus the stored record JSON). Needs the `discord-webhook-url` input. |
| `statusContext` | no | `PactDock CLA` | Commit-status name to require in rulesets. |
| `allowlist.accountIds` | no | `[]` | Numeric account IDs exempt from signing (bots). Logins are not accepted because they can be renamed and re-registered. |
| `coAuthors` | no | `true` | Require `Co-authored-by:` identities to sign. |
| `committers` | no | `false` | Also require committers to sign. GitHub's `web-flow` is always ignored. |
| `comment` | no | `true` | Post and update a single status comment on the PR. |
| `entityInstructionsUrl` | no | | HTTPS link shown in the entity section of the comment. |

## Signing phrases

These are generated from the config. The contributor's comment must consist of the phrase alone. Case, whitespace and curly quotes do not matter, and the final full stop is optional.

- Individual: `I have read and agree to the <name> version <version>.`
- Entity: `I have read and agree to the <name> version <version> on behalf of <Entity Legal Name>, and I am authorised to bind it.`
- Recheck: `/pactdock recheck`

## Action inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Token for the PR repository when no App is configured. |
| `app-id`, `app-private-key` | | GitHub App credentials (recommended). |
| `store-token` | | Fine-grained PAT for the store (alternative to an App). |
| `s3-access-key-id`, `s3-secret-access-key`, `s3-session-token` | `AWS_*` env | Credentials for an `s3` store. Pass them from secrets, or leave blank and set `AWS_ACCESS_KEY_ID` etc. (for example via OIDC). |
| `discord-webhook-url` | | Discord webhook (a secret) used when `discord` is configured. |
| `config-path` | `.github/pactdock.json` | Config location on the default branch. |
| `pull-request` | | For `workflow_dispatch`: PR number to recheck. Leave blank to recheck all open PRs (max 100). |

## Outputs

| Output | Values |
| --- | --- |
| `result` | `passed`, `failed`, `signed` (recorded, others still missing), `skipped`, `mixed` (sweep), `error` |
| `unsigned` | Comma-separated logins still to sign |
| `checked` | Comma-separated PR numbers evaluated |

## Record formats

- Individual: `signatures/individual/<agreementId>/<version>/<accountId>.json`, schema `pactdock/individual@2`. One file per account and version.
- Entity: `signatures/entity/<agreementId>/<slug>.json`, schema `pactdock/entity@1`.

Records are **write-once**. PactDock creates each file only if it does not exist (Contents API PUT without a SHA, or S3 `If-None-Match: *`) and never rewrites or deletes it. A new agreement version creates a new file. Only maintainers edit entity records, to activate them.

Records are validated on every read. A malformed record, or a record whose contents do not match its location (account, agreement or version), fails the check.

## S3 and Cloudflare R2

```json
"storage": {
  "type": "s3",
  "bucket": "example-cla-signatures",
  "region": "auto",
  "endpoint": "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
  "directory": "signatures"
}
```

- **R2:** create a private bucket and an API token with **Object Read & Write scoped to that bucket only**. Add a **bucket lock** rule on the `signatures/` prefix (indefinite retention) so records cannot be deleted or overwritten, even with the token. Store the token's key ID and secret as `PACTDOCK_S3_ACCESS_KEY_ID` and `PACTDOCK_S3_SECRET_ACCESS_KEY` repository secrets.
- **Amazon S3:** turn on Block Public Access. Grant `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::<bucket>/signatures/*` and `s3:ListBucket` limited by an `s3:prefix` condition, with **no** `s3:DeleteObject`. Prefer OIDC (`aws-actions/configure-aws-credentials` pinned to a SHA) over long-lived keys. Object Lock adds a further guarantee.
- PactDock follows no redirects, requires `https://` endpoints and fails closed on any unexpected response.

## Discord

```json
"discord": { "mode": "signature" }
```

Discord receives a copy **after** the record is stored in `storage`. It is a log, not a store: PactDock never reads from it, failures only produce a warning, and mentions are disabled. Keep the webhook URL in a secret; anyone holding it can post to or delete from that channel. See [`examples/store/entity-record.json`](../examples/store/entity-record.json).
