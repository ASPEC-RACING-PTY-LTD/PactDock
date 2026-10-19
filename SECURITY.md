# Security policy

Please report suspected vulnerabilities **privately**, using GitHub's "Report a vulnerability" (private vulnerability reporting) on this repository. Do not open public issues for them.

Include the affected version or commit, a description, reproduction steps and the impact. We aim to acknowledge reports within 5 business days.

In scope:

- forged or replayed signatures;
- ways to make an unsigned pull request pass;
- tampering with records through PactDock;
- token leakage;
- injection through comments or commit metadata.

The design and accepted residual risks are described in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

Only the latest release receives security fixes.
