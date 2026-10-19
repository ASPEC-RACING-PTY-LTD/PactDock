# Changelog

## Unreleased

### PactDock Server (new)

- Self-hosted Docker application with zero runtime dependencies (Node 24, `node:sqlite`).
- Automated GitHub App creation with the App Manifest flow. Each owner creates their own App, with Checks, Pull requests and Metadata permissions only (plus account email addresses for sign-in) and no source-code access.
- Signing portal: GitHub sign-in with PKCE, review of the exact agreement, typed or drawn signatures, downloadable signed copies.
- Immutable, hash-chained signature records with timestamps, IP and user agent evidence and agreement version hashes; write-once documents on local disk or S3/R2.
- Check runs and PR comments with expiring signing links, automatic rechecks and a 15-minute sweep.
- Expiring download links, emailed copies and email recovery (optional SMTP).
- Admin portal: multi-repository management, agreements with immutable versions, signatures, entity verification, administrators, audit log, integrity check.
- Encrypted credentials (AES-256-GCM), encrypted scheduled backups and restore, hardened container and compose file.

### PactDock Lite

- Records are now write-once: one file per account and agreement version (`pactdock/individual@2`).
- New S3-compatible store for Amazon S3 and Cloudflare R2 (`storage.type: "s3"`), with SigV4 signing and conditional writes.
- Optional Discord notifications or signature copies (`discord` config and `discord-webhook-url` input). Discord is never the store.

### Agreements

- Added the ASPEC Individual and Entity Contributor Agreements v2.0 (copyright assignment with licence back, fallback licence, limited waiver and irrevocable grants for existing contributions). The v1.0 texts are unchanged. PactDock's own config now requires v2.0.

## 1.0.0 (unreleased)

- First implementation. Covers:
  - individual and entity CLAs signed by PR comment;
  - identity by numeric account ID, including co-author detection;
  - a private-repository signature store with append-only records;
  - required commit status;
  - GitHub App, PAT and GITHUB_TOKEN authentication;
  - scheduled and manual rechecks;
  - fail-closed handling throughout.
- Licensed under PolyForm Shield 1.0.0.
