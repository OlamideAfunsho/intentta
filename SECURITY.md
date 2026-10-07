# Security

## Status

This is a prototype. It has automated tests and has been run on local Canton networks, including one with DecMan nodes. It has not been audited and has not been run on DevNet, TestNet or MainNet. Do not use it with real assets as it stands.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), with steps to reproduce and the commit you tested. You will get a reply within five working days.

## Secrets

The repository contains no credentials and the local demos need none. The sandbox runs without authentication. The DecMan network uses Canton's unsafe shared-secret mode, whose secret is the literal word `unsafe`, as Canton and DecMan both document for local use; it protects nothing and is not a credential.

For a secured participant, the ledger client reads a token from the `LEDGER_TOKEN` environment variable at run time. It is sent as a bearer token and is never written to disk or logged. Keep it in your shell or a secret manager, not in a file in this tree.

Three things guard against a leak:

- `.gitignore` excludes `.env` files, key and certificate files, token files and the `.local/` runtime directory.
- `scripts/check-secrets.mjs` scans everything git would publish for private keys, JWTs, cloud and API keys, bearer tokens, password assignments and credentials in URLs, and for file names that should never be committed.
- `.githooks/pre-commit` and `.githooks/pre-push` run that scan and block the commit or push if it finds anything. Enable them once per clone:

```bash
git config core.hooksPath .githooks
```

The files under `evidence/` contain party ids and contract ids from a throwaway local ledger. They are identifiers, not credentials.

## Design-level safeguards

See [docs/SAFEGUARDS.md](docs/SAFEGUARDS.md) for the threat-by-threat list and the test that covers each, and [docs/PRIVACY.md](docs/PRIVACY.md) for what each party and operator can see.
