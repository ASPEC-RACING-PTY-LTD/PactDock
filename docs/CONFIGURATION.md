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
| `storage.repository` | yes | | `owner/name` of the store, or `"self"`. |
| `storage.branch` | for `self` | store default branch | Branch holding records. |
| `storage.directory` | no | `signatures` | Directory within the store. |
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
| `config-path` | `.github/pactdock.json` | Config location on the default branch. |
| `pull-request` | | For `workflow_dispatch`: PR number to recheck. Leave blank to recheck all open PRs (max 100). |

## Outputs

| Output | Values |
| --- | --- |
| `result` | `passed`, `failed`, `signed` (recorded, others still missing), `skipped`, `mixed` (sweep), `error` |
| `unsigned` | Comma-separated logins still to sign |
| `checked` | Comma-separated PR numbers evaluated |

## Record formats

- Individual: `signatures/individual/<agreementId>/<accountId>.json`, schema `pactdock/individual@1`.
- Entity: `signatures/entity/<agreementId>/<slug>.json`, schema `pactdock/entity@1`.

Records are validated on every read. A malformed record, or a record holding another account's signature, fails the check. See [`examples/store/entity-record.json`](../examples/store/entity-record.json).
