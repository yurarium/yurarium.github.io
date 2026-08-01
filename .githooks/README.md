# Leak guard (fail-closed) — `.githooks/`

Keeps this pseudonymous repo from ever publishing the maintainer's real identity. Runs on **every** commit
and push and **self-tests against a canary each run** — a clean report means "the guard ran and caught its
canary", never "the guard did nothing". If the guard is broken or un-wired it **blocks** (fail closed).

## What it checks
- **Identity (allowlist, always on):** every commit's author *and* committer — and the about-to-commit git
  identity — must be the pseudonym. Load-bearing, needs no configuration.
- **Content (denylist):** the diff / tree must not contain forbidden strings. Generic *shapes* (absolute
  home-directory paths, internal tracker-tag formats) are built in; the *specific* real-name/email strings
  are supplied out of band, so the committed guard never contains the thing it guards:
  - locally via `.githooks/leak-deny.local` (gitignored; seed from the `.example`),
  - in CI via the `LEAK_DENY` repository secret.

## Layers (weakest to strongest)
1. **pre-commit / pre-push** — local, fast, fail-closed — but bypassable (`--no-verify`) and absent on a
   fresh clone until `install.sh` runs.
2. **CI (`.github/workflows/leak-guard.yml`)** — committed, server-side, runs on every push regardless of
   local setup; the un-bypassable layer. github.com has no pre-receive, so CI *detects* right after the
   push (contained while the repo is private) rather than blocking before it.

Prevention still comes first: git `includeIf` should make the commit author correct by construction, so
the identity check has nothing to catch.

## Setup (once per clone)
    .githooks/install.sh        # sets core.hooksPath=.githooks, seeds the local denylist

## Prove it is live (after install, and periodically)
    .githooks/fire-drill.sh     # makes git try to commit a canary leak; it must be rejected

Also set the `LEAK_DENY` repository secret (the real-name/email fixed strings) so CI's content layer is
active — CI fails closed if the secret is missing.
