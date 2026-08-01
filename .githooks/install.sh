#!/usr/bin/env bash
# One-time per-clone bootstrap: point git at the tracked hooks and seed the local (gitignored) denylist.
# core.hooksPath is per-clone local config, so a fresh clone has no local guard until this runs — which is
# exactly why CI is the backstop that does not depend on it. Prove the guard is live with fire-drill.sh.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/*.sh .githooks/pre-commit .githooks/pre-push 2>/dev/null || true
if [ ! -f .githooks/leak-deny.local ]; then
  cp .githooks/leak-deny.local.example .githooks/leak-deny.local
  echo "seeded .githooks/leak-deny.local (gitignored) — add your real name/email as fixed strings, one per line"
fi
echo "core.hooksPath -> .githooks. Verify the guard is wired: .githooks/fire-drill.sh"
