# Setting up PactDock

Setup takes about 15 minutes. You need admin access to the repositories (or organisation) you want to protect.

- [1. Choose agreements](#1-choose-agreements)
- [2. Create the signature store](#2-create-the-signature-store)
- [3. Choose authentication](#3-choose-authentication)
- [4. Add the configuration](#4-add-the-configuration)
- [5. Add the workflow](#5-add-the-workflow)
- [6. Require the check (block unsigned merges)](#6-require-the-check-block-unsigned-merges)
- [7. Verify](#7-verify)
- [Managing entity agreements](#managing-entity-agreements)
- [Changing an agreement version](#changing-an-agreement-version)

---

## 1. Choose agreements

Put the agreement text(s) in the repository, on the default branch, for example:

```
.github/cla/ICLA-1.0.md      # individual agreement (required)
.github/cla/ECLA-1.0.md      # entity agreement (optional)
```

ASPEC-owned repositories should use the ASPEC drafts in [`templates/cla/`](../templates/cla) **once legal review is complete** (see [LEGAL_REVIEW.md](LEGAL_REVIEW.md)). Other organisations must supply their own agreements. The ASPEC drafts name ASPEC as the rights recipient and are not a template for anyone else's legal needs.

## 2. Create the signature store

**Recommended: a private repository** shared by all your projects, e.g. `your-org/cla-signatures`.

1. Create the repository as **private**, with a README so the default branch exists.
2. Protect its default branch (ruleset or branch protection, where your plan allows it on private repos):
   - block force pushes and deletions;
   - limit who can push to the PactDock App (or the PAT owner) plus your legal/maintainer team.
3. Keep the collaborator list short. Everyone with write access can alter records. Git history still shows every change.

**Alternative: same repository, dedicated branch.** Use `"storage": { "repository": "self", "branch": "pactdock-signatures" }`. Create the branch once:

```bash
git switch --orphan pactdock-signatures
```

```bash
git commit --allow-empty -m "PactDock signature store"
```

```bash
git push origin pactdock-signatures
```

Records on that branch are as visible as the repository itself. Do not use self storage on a public repository unless you are comfortable publishing signers' GitHub IDs and comments.

## 3. Choose authentication

| Mode | When to use | What you need |
| --- | --- | --- |
| **GitHub App (recommended)** | Any setup; strongest. Statuses come from your App, so the required check can be pinned to it. | App ID + private key |
| Fine-grained PAT for the store | Quick start with a private store | `store-token` secret |
| `GITHUB_TOKEN` only | Self storage only | nothing |

### GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (under the organisation).
2. Set a name such as `YourOrg PactDock`. Untick **Webhook → Active**, because PactDock needs no webhooks.
3. Set these **repository permissions**:
   - Commit statuses: **Read and write**
   - Pull requests: **Read and write**
   - Issues: **Read and write** (needed to comment and react on PRs)
   - Contents: **Read and write** (needed for the store; PactDock requests read-only tokens for other repositories)
   - Metadata: Read (mandatory)
4. Set **Where can this app be installed?** to "Only on this account".
5. Create the App, note its **App ID** (or Client ID), and generate a **private key**.
6. Install the App on the repositories you want to protect **and** on the signature store repository.
7. In each protected repository (or at organisation level), add:
   - a variable `PACTDOCK_APP_ID`;
   - a secret `PACTDOCK_APP_PRIVATE_KEY` (the full PEM).

PactDock mints a separate one-hour token for each repository, scoped to that repository only. Protected repositories get statuses, pull requests and issues write plus contents read. The store gets contents write and nothing else.

### Fine-grained PAT (store only)

Create a fine-grained token with **Repository access: only the store repository** and **Contents: Read and write**. Save it as the `PACTDOCK_STORE_TOKEN` secret and pass `store-token`. Statuses and comments then use `GITHUB_TOKEN`. Give the token an expiry and rotate it.

## 4. Add the configuration

Create `.github/pactdock.json` on the default branch. Start from [`examples/pactdock.json`](../examples/pactdock.json). All options are in [CONFIGURATION.md](CONFIGURATION.md).

## 5. Add the workflow

Copy [`examples/workflows/pactdock.yml`](../examples/workflows/pactdock.yml) to `.github/workflows/pactdock.yml` on the **default branch**. Replace the placeholder with the full commit SHA of a PactDock release you have reviewed:

```yaml
- uses: aspec-racing/pactdock@<40-character-sha> # v1.0.0
```

Do **not** add `actions/checkout`. PactDock does not need the code, and checking out PR code in a `pull_request_target` workflow is the classic way these workflows get compromised.

If you use only `GITHUB_TOKEN` (self storage), add `contents: write` to the workflow `permissions`.

## 6. Require the check (block unsigned merges)

Open the PR once so the `PactDock CLA` status appears. Then go to **Settings → Rules → Rulesets → New branch ruleset**:

1. Target the default branch (and any release branches).
2. Enable **Require status checks to pass** and add `PactDock CLA`.
3. Set the check's **source** to the app that posts it, so no other app or workflow can satisfy it:
   - GitHub App mode: your PactDock App.
   - Token mode: **GitHub Actions**.
4. Enable **Require a pull request before merging**, and **Block force pushes**.
5. Leave **Bypass list** empty, or limited to people who may legally accept contributions without a CLA.
6. Set enforcement to **Active**.

Branch protection (classic) works too: require the `PactDock CLA` status and choose the expected source app.

> Token mode caveat: anyone with write access can run a workflow that posts a `PactDock CLA` status through GitHub Actions. Write access already allows pushing, so this is usually acceptable. GitHub App mode removes this gap.

## 7. Verify

Use a test repository first:

1. Open a PR from a fork using an account that has not signed. The status should be ❌ and PactDock should comment with instructions.
2. Comment the exact phrase from the bot comment. The comment gets a 👍, the status turns ✅, and a record appears in the store.
3. Push a commit with `Co-authored-by: Someone <someone@example.com>` for an account that has not signed. The status should be ❌ again.
4. Edit a comment so it contains the phrase. Nothing should be recorded, because only new comments sign.
5. Try to merge a failing PR. The ruleset should block it.
6. Run the workflow manually (**Actions → PactDock CLA → Run workflow**) to recheck all open PRs.

## Managing entity agreements

1. The entity's authorised signatory comments the entity phrase on a PR (shown in the bot comment's "Contributing on behalf of a company" section).
2. PactDock records `signatures/entity/<agreement>/<entity>.json` with `"status": "pending"` and adds the signatory to `authorisedAccounts`.
3. A maintainer verifies the signatory's authority out of band, for example with a signed PDF on letterhead.
4. The maintainer then edits the file through a reviewed commit in the store:
   - set `"status": "active"`;
   - list every authorised contributor as `{ "id": <numeric id>, "login": "<login>" }`;
   - add `notes` describing the verification.

   Find numeric IDs at `https://api.github.com/users/<login>`.
5. To end coverage, remove the account or set `"status": "revoked"`. Run a manual recheck.

You can also create entity records by hand from a signed paper agreement. Use `"method": "manual"` in the evidence and a `note`. See [`examples/store/entity-record.json`](../examples/store/entity-record.json).

## Changing an agreement version

1. Add the new document, for example `.github/cla/ICLA-2.0.md`.
2. Update `version`, `document` and, if used, `sha256` in the config.
3. Decide whether old signatures still count:
   - To keep them valid, set `"acceptedVersions": ["1.0", "2.0"]`.
   - To require everyone to re-sign, leave `acceptedVersions` out.
4. Run a manual recheck of open PRs.
