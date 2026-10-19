# PactDock Server

PactDock Server is a self-hosted Docker application. It connects to GitHub through **your own GitHub App**, created for you from the Server's setup page. Contributors sign in with GitHub, read the exact agreement, sign it with a typed or drawn signature and download a signed copy. The Server checks every pull request and blocks merges until everyone involved has signed.

Nothing runs on ASPEC infrastructure. Each owner runs their own Server and their own App.

- [Requirements](#requirements)
- [1. Prepare secrets](#1-prepare-secrets)
- [2. Configure and start](#2-configure-and-start)
- [3. Put it behind HTTPS](#3-put-it-behind-https)
- [4. Connect to GitHub](#4-connect-to-github)
- [5. Add agreements and enable repositories](#5-add-agreements-and-enable-repositories)
- [6. Require the check](#6-require-the-check)
- [How contributors sign](#how-contributors-sign)
- [Entity agreements](#entity-agreements)
- [Storage, backups and restore](#storage-backups-and-restore)
- [Environment variables](#environment-variables)
- [Security notes](#security-notes)

## Requirements

- Docker with Compose (or any container runtime).
- A public HTTPS address that GitHub can reach, for example `https://cla.example.com`, through a reverse proxy (Caddy, nginx, Traefik) or a tunnel (Cloudflare Tunnel).
- Optional: an SMTP account for emailed copies and recovery links. Optional: an S3 or Cloudflare R2 bucket for signed documents.

## 1. Prepare secrets

From the repository root:

```bash
mkdir -p server/secrets server/backups
```

```bash
openssl rand -base64 32 > server/secrets/master_key
```

```bash
openssl rand -hex 16 > server/secrets/setup_token
```

```bash
openssl rand -base64 33 > server/secrets/backup_passphrase
```

- **`master_key`** encrypts the App's private key, client secret and webhook secret in the database, and signs links. Keep a copy somewhere safe and **separate from your backups**. Without it, a restored database cannot use its GitHub credentials.
- **`setup_token`** protects first-run setup. Without it, the Server prints a random setup link to its log.
- **`backup_passphrase`** encrypts backups. Store it separately as well.

`server/secrets/` and `server/backups/` are ignored by Git.

## 2. Configure and start

Edit [`server/docker-compose.yml`](../server/docker-compose.yml): set `PACTDOCK_PUBLIC_URL` to your HTTPS address, and uncomment SMTP or S3 settings if you want them. Then:

```bash
docker compose -f server/docker-compose.yml up -d --build
```

The container listens on `127.0.0.1:8080` only. It runs as the unprivileged `node` user with a read-only root filesystem, no Linux capabilities and `no-new-privileges`. Data lives in the `pactdock-data` volume (`/data`). Check it with:

```bash
docker compose -f server/docker-compose.yml logs pactdock
```

## 3. Put it behind HTTPS

Point your reverse proxy at `127.0.0.1:8080` and set `PACTDOCK_TRUST_PROXY=true` so the Server records the client IP from `X-Forwarded-For`. Only set it when a proxy you control always sets that header. A minimal Caddyfile:

```text
cla.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

## 4. Connect to GitHub

1. Open `https://cla.example.com/setup?token=<setup_token>`.
2. Choose a name for the App and whether it belongs to your personal account or an organisation (you must be an owner of that organisation).
3. Select **Create GitHub App**. GitHub shows the App it will create, with these permissions only:

   | Permission | Access | Why |
   | --- | --- | --- |
   | Checks | Read and write | The `PactDock CLA` check run |
   | Pull requests | Read and write | PR details, commit list, the status comment |
   | Metadata | Read | Mandatory for every App |
   | Email addresses (account) | Read | Verified emails at sign-in, used for co-authors and copies |

   There is **no Contents permission**: the Server cannot read your source code. Events: `pull_request` and `check_run`.
4. Confirm on GitHub. You return to the Server, which stores the credentials encrypted.
5. Install the App on the repositories you want to protect.
6. Sign in with GitHub when asked. The person who finishes setup becomes the first administrator.

## 5. Add agreements and enable repositories

In the **Admin** portal:

1. **Agreements → New agreement.** Give it a name, an identifier, the rights holder and the kind (individual or entity).
2. **Publish a version.** Paste the final Markdown text and a version number, and confirm it is final. A published version can never be edited or deleted. To change the terms, publish a new version.
3. **Repositories.** Select **Sync repositories from GitHub** if a repository is missing. For each repository, choose:
   - the individual agreement and, optionally, the entity agreement;
   - the version policy: **current** (everyone must have signed the latest version) or **any** (any published version counts);
   - whether co-authors and committers must sign, and whether to post a PR comment;
   - allowlisted accounts (bots), by GitHub login, stored as numeric IDs;
   - **Enforce contributor agreements on this repository**.
4. Select **Recheck all open pull requests now**.

The ASPEC agreements in [`templates/cla/`](../templates/cla) are ASPEC's own. Other organisations must use their own agreements.

## 6. Require the check

In **Settings → Rules → Rulesets** (repository or organisation):

1. Target the default branch and any release branches.
2. Enable **Require status checks to pass** and add `PactDock CLA`.
3. Set the check's **source** to your PactDock App, so nothing else can satisfy it.
4. Enable **Require a pull request before merging** and **Block force pushes**.
5. Leave the bypass list empty, and set enforcement to **Active**.

If the Server is down or errors, the check is missing or failed, and the merge stays blocked.

## How contributors sign

1. A pull request is opened or updated. The Server lists every contributor by numeric account ID: the PR author, commit authors, `Co-authored-by` identities and, optionally, committers.
2. Anyone not covered gets a ⚠️ check (`action_required`) and a comment with a personal signing link. Links expire after 14 days.
3. The contributor signs in with GitHub, reads the full agreement (with its SHA-256), enters their legal name, optionally picks one of their verified emails, ticks the agreement box and types or draws a signature.
4. The Server stores a write-once signed document and an immutable record. The record holds the time, IP address, user agent, agreement version and hash, repository and PR. The contributor can download the copy straight away, at `/my` later, or from an emailed link (valid 7 days).
5. Their open pull requests are rechecked automatically.

Lost access to GitHub? `/recover` emails a 30-minute link to the contributor's documents to the addresses they signed with. It never says whether an address is on file.

Co-authors are matched by the verified email they signed with. A co-author email that no signer has verified fails the check, so ask that person to sign, or allowlist them.

## Entity agreements

1. The signatory follows **Use the entity agreement instead** on the signing page, gives the entity's legal name and their title, and confirms they are authorised.
2. The entity is recorded as **pending**. Only the signatory is listed.
3. An administrator verifies the signatory's authority out of band, then opens **Admin → Entities**, sets the status to **active** and lists the authorised contributors' GitHub logins (stored as account IDs). Every change is audited.
4. To end coverage, remove people or set the status to **revoked**.

## Storage, backups and restore

| What | Where |
| --- | --- |
| Database (agreements, signatures, settings, audit log) | `/data/pactdock.db` (SQLite) |
| Signed documents | `/data/documents/` (default), or an S3/R2 bucket with `PACTDOCK_S3_*` |
| Master key (if not supplied) | `/data/master.key`, generated with a warning. Move it to a Docker secret. |

Signature records, agreement versions and the audit log cannot be updated or deleted: database triggers refuse it. Each record is chained to the previous one with SHA-256. **Admin → Integrity** re-checks the chain and every stored document.

**S3 / R2 documents.** Documents are written with `If-None-Match: *` under `PACTDOCK_S3_PREFIX` (default `pactdock`). For R2, use a token with Object Read & Write on that bucket only, and add a bucket lock on the prefix. For AWS, grant Get and Put on the prefix without Delete.

**Backups.** With `PACTDOCK_BACKUP_INTERVAL_HOURS` set, the Server writes an encrypted backup (`*.pdbk`) to `PACTDOCK_BACKUP_DIR` on that schedule and keeps the newest `PACTDOCK_BACKUP_KEEP`. To make one now:

```bash
docker compose -f server/docker-compose.yml exec pactdock node server/dist/server/src/main.js backup
```

A backup holds a consistent database snapshot and the local documents, encrypted with the backup passphrase (scrypt + AES-256-GCM). It does **not** hold the master key or S3 documents (protect and back up the bucket separately). Copy backups off the host.

**Restore** into an empty data volume, with the same master key and the backup passphrase:

```bash
docker compose -f server/docker-compose.yml run --rm pactdock restore /backups/<file>.pdbk
```

Stop the Server first. Restore refuses to write into a data directory that already has a database.

## Environment variables

Every secret can also be given as a file with the `_FILE` suffix (for Docker secrets).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PACTDOCK_PUBLIC_URL` | required | Public base URL. Must be `https://` (http only for localhost). |
| `PACTDOCK_PORT` | `8080` | Listening port inside the container. |
| `PACTDOCK_DATA_DIR` | `/data` | Database, documents and generated key. |
| `PACTDOCK_MASTER_KEY` | generated | 32 random bytes, base64. |
| `PACTDOCK_SETUP_TOKEN` | random, logged | Token for first-run setup. |
| `PACTDOCK_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for client IPs. |
| `PACTDOCK_GITHUB_URL`, `PACTDOCK_GITHUB_API_URL` | github.com | For GitHub Enterprise Server. |
| `PACTDOCK_SMTP_HOST`, `PACTDOCK_SMTP_PORT`, `PACTDOCK_SMTP_SECURITY`, `PACTDOCK_SMTP_FROM`, `PACTDOCK_SMTP_USER`, `PACTDOCK_SMTP_PASS` | off; 587; `tls` on 465, else `starttls` | Email for copies and recovery. |
| `PACTDOCK_S3_BUCKET`, `PACTDOCK_S3_REGION`, `PACTDOCK_S3_ENDPOINT`, `PACTDOCK_S3_PATH_STYLE`, `PACTDOCK_S3_PREFIX`, `PACTDOCK_S3_ACCESS_KEY_ID`, `PACTDOCK_S3_SECRET_ACCESS_KEY` | off; `auto`; AWS; per endpoint; `pactdock` | S3 or R2 for signed documents. |
| `PACTDOCK_BACKUP_DIR`, `PACTDOCK_BACKUP_INTERVAL_HOURS`, `PACTDOCK_BACKUP_KEEP`, `PACTDOCK_BACKUP_PASSPHRASE` | `/data/backups`; `0` (off); `14`; none | Encrypted backups. The passphrase needs at least 12 characters. |

## Security notes

- Webhooks are verified with the App's secret (`X-Hub-Signature-256`) and de-duplicated by delivery ID.
- Installation tokens are scoped to one repository and the three repository permissions above. Contributors' GitHub tokens are used once at sign-in and never stored.
- Pages use a strict Content Security Policy with no inline scripts, CSRF tokens on every form, HttpOnly SameSite cookies and HSTS.
- Sign-in, signing and recovery are rate limited.
- Update by rebuilding the image from a reviewed commit. The base image is pinned by digest in [`server/Dockerfile`](../server/Dockerfile).

The full threat model is in [SECURITY_MODEL.md](SECURITY_MODEL.md).
