# PactDock

**Self-contained Contributor Licence Agreement (CLA) enforcement for GitHub.** It needs no servers, subscriptions, databases or external CLA service. Signatures are stored in a GitHub repository you control.

PactDock is owned by **ASPEC RACING PTY LTD** (Australia). It is free and source-available for anyone to use on their own repositories, under the [PolyForm Shield License 1.0.0](LICENSE.md).

## How it works

1. A pull request is opened or updated. PactDock reads the PR metadata through the API; it never checks out or runs PR code. It works out every contributor by **numeric GitHub account ID**: the PR author, each commit author, and each `Co-authored-by:` identity.
2. Contributors without a valid signature get a ❌ `PactDock CLA` status and one comment with instructions.
3. Each contributor posts the exact acceptance phrase as a new comment, for example:

   ```text
   I have read and agree to the ASPEC Individual Contributor Licence Agreement version 1.0.
   ```

4. PactDock verifies that the comment really came from that account and has not been edited. It then appends a signed record to your **private signature repository**. The record holds the account ID, timestamps, agreement version, document SHA-256 and permalink, the exact comment text and its hash, and a link to the run.
5. The status turns ✅. Because the status is a **required check** in your ruleset, unsigned PRs cannot be merged.

Entity (company) agreements are signed by an authorised signatory in the same way. They take effect once a maintainer verifies the signatory and lists the authorised contributor IDs.

## Highlights

- **Secure by default.**
  - No checkout; workflows always come from the default branch.
  - Least-privilege, repository-scoped GitHub App tokens.
  - ID-based identity, and edit-proof signing.
  - Fails closed on anything it cannot verify.
- **Lightweight.**
  - One Node 24 action with **zero runtime dependencies**, under 2,000 lines of TypeScript.
  - Works on GitHub-hosted and self-hosted runners, and on GitHub Enterprise Server (via `GITHUB_API_URL`).
- **Auditable.** The store is append-only JSON in Git, so every signature is a commit.
- **Configurable.** Your own agreements, rights holder, versions, document hash pins, store location and bot allowlist.

## Quick start

1. Add your agreement text, e.g. `.github/cla/ICLA-1.0.md`.
2. Create a **private** repository for signatures, e.g. `your-org/cla-signatures`.
3. Create a GitHub App, or a fine-grained token for the store ([setup guide](docs/SETUP.md#3-choose-authentication)).
4. Add `.github/pactdock.json` ([example](examples/pactdock.json), [reference](docs/CONFIGURATION.md)).
5. Add `.github/workflows/pactdock.yml` ([example](examples/workflows/pactdock.yml)), pinned to a reviewed commit SHA.
6. In **Settings → Rules → Rulesets**, require the `PactDock CLA` status, with the source set to your App ([details](docs/SETUP.md#6-require-the-check-block-unsigned-merges)).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Step-by-step setup, rulesets, entity agreements, version changes |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every config key, input, output and record format |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Threat model, controls, residual risks |
| [MASTER_PLAN.md](MASTER_PLAN.md) | Architecture, research, roadmap, testing |
| [templates/cla/](templates/cla) | Draft ASPEC Individual and Entity CLAs (Harmony-modelled; **pending legal review**) |
| [docs/LEGAL_REVIEW.md](docs/LEGAL_REVIEW.md) | Items flagged for legal review |
| [docs/LICENSING.md](docs/LICENSING.md) | Why PolyForm Shield was chosen, and the remaining open items |

## Development

```bash
npm ci --ignore-scripts
```

```bash
npm run all
```

`npm run all` runs, in order:

- typecheck;
- the unit, integration and end-to-end tests;
- the build to `dist/`;
- a check that `dist/` matches `src/`.

Commit `dist/` together with any change to `src/`.

## Licence

Copyright (c) 2026 ASPEC RACING PTY LTD. PactDock is **free and source-available** under the [PolyForm Shield License 1.0.0](LICENSE.md). Anyone, including businesses, may use and modify it, for example to manage contributions to their own repositories. Providing a product or service that competes with PactDock (selling it, hosting it as a service, or offering a rebranded substitute, paid or free) is not permitted without written permission from ASPEC RACING PTY LTD. PactDock is not "open source" in the OSI sense. See [docs/LICENSING.md](docs/LICENSING.md).
