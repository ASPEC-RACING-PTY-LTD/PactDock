# Contributing to PactDock

Thank you for helping. Before your pull request can be merged, you will be asked to accept the ASPEC Individual Contributor Agreement version 2.0 (or your employer the Entity agreement). Version 2.0 assigns the copyright in your contributions to ASPEC and licenses them back to you; see [`templates/cla/`](templates/cla).

Ground rules:

- **No runtime dependencies.** PactDock's security story depends on it. Dev dependencies need a strong reason.
- Pin any GitHub Action to a full commit SHA with the version in a comment.
- Every behaviour change needs a test. Run `npm run all` before pushing.
- Rebuild and commit `dist/` with any `src/` change (CI enforces this).
- Update [MASTER_PLAN.md](MASTER_PLAN.md) first if you change architecture or security behaviour.
- Report vulnerabilities privately (see [SECURITY.md](SECURITY.md)).
