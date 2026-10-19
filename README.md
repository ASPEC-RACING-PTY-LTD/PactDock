# PactDock

**Self-hosted Contributor Licence Agreement (CLA) enforcement for GitHub.** No subscription, no external CLA service and nothing hosted by ASPEC: you run it, you own the records.

PactDock is owned by **ASPEC RACING PTY LTD** (Australia). It is free and source-available for anyone to use on their own repositories, under the [PolyForm Shield License 1.0.0](LICENSE.md).

## Two editions

| | **PactDock Server** (recommended) | **PactDock Lite** |
| --- | --- | --- |
| Runs as | A Docker container you host | A GitHub Action in your workflows |
| Signing | Contributors sign in with GitHub, review the exact agreement, type or draw a signature and download a signed copy | Contributors post an exact acceptance phrase as a PR comment |
| Records | Immutable, hash-chained SQLite records and write-once signed documents (local disk or S3/R2), encrypted backups | Write-once JSON in a private GitHub repository or an S3/R2 bucket, optional Discord copies |
| GitHub access | Your own GitHub App, created in one click from the setup page. Checks, pull requests and metadata only: **no source-code access** | The workflow token, or your own App or token for the store |
| Management | Admin portal: repositories, agreements and immutable versions, signatures, entities, admins, audit log, integrity check | A JSON config file |
| Guide | [docs/SERVER.md](docs/SERVER.md) | [docs/SETUP.md](docs/SETUP.md) |

Both editions:

- identify people by **numeric GitHub account ID**, covering the PR author, commit authors and `Co-authored-by` identities;
- support individual and entity (company) agreements, with entities active only after an admin verifies them;
- report a required `PactDock CLA` check for rulesets, so unsigned PRs cannot be merged;
- **fail closed** on anything they cannot verify, and never check out or run PR code;
- never change signed terms: every agreement version and signature record is write-once;
- have **zero runtime npm dependencies** (Node 24 built-ins only).

## Quick start: Server

1. Create the secrets and set `PACTDOCK_PUBLIC_URL` in [`server/docker-compose.yml`](server/docker-compose.yml).
2. Run `docker compose -f server/docker-compose.yml up -d --build` behind an HTTPS reverse proxy.
3. Open the setup link, create your GitHub App and install it on your repositories.
4. Publish your agreement in the admin portal, enable the repositories, and require the `PactDock CLA` check in a ruleset with your App as the source.

## Quick start: Lite

1. Add your agreement text, e.g. `.github/cla/ICLA-1.0.md`.
2. Create a **private** repository for signatures, e.g. `your-org/cla-signatures`, or an S3/R2 bucket.
3. Create a GitHub App, or a fine-grained token for the store ([setup guide](docs/SETUP.md#3-choose-authentication)).
4. Add `.github/pactdock.json` ([example](examples/pactdock.json), [S3/R2 example](examples/pactdock-s3.json), [reference](docs/CONFIGURATION.md)).
5. Add `.github/workflows/pactdock.yml` ([example](examples/workflows/pactdock.yml)), pinned to a reviewed commit SHA.
6. In **Settings → Rules → Rulesets**, require the `PactDock CLA` status, with the source set to your App ([details](docs/SETUP.md#6-require-the-check-block-unsigned-merges)).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/SERVER.md](docs/SERVER.md) | PactDock Server: Docker, GitHub App setup, agreements, signing, backups, environment variables |
| [docs/SETUP.md](docs/SETUP.md) | PactDock Lite: step-by-step setup, rulesets, entity agreements, version changes |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every config key, input, output and record format |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Threat model, controls, residual risks |
| [MASTER_PLAN.md](MASTER_PLAN.md) | Architecture, research, roadmap, testing |
| [templates/cla/](templates/cla) | ASPEC agreements: v1.0 licence and v2.0 assignment, individual and entity (modelled on Harmony) |
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
- the Lite build to `dist/` and the Server build to `server/dist/`;
- the Lite and Server unit, integration and end-to-end tests;
- a check that `dist/` matches `src/`.

Commit `dist/` together with any change to `src/`.

## Licence

Copyright (c) 2026 ASPEC RACING PTY LTD. PactDock is **free and source-available** under the [PolyForm Shield License 1.0.0](LICENSE.md). Anyone, including businesses, may use and modify it, for example to manage contributions to their own repositories. Providing a product or service that competes with PactDock (selling it, hosting it as a service, or offering a rebranded substitute, paid or free) is not permitted without written permission from ASPEC RACING PTY LTD. PactDock is not "open source" in the OSI sense. See [docs/LICENSING.md](docs/LICENSING.md).
