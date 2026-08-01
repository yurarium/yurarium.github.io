#!/usr/bin/env bash
# Fire-drill: prove the guard is actually WIRED and live (not merely present) by making git try to commit a
# synthetic leak and confirming the wired pre-commit hook REJECTS it. Touches no real history — the canary
# file is removed and any wrongly-created commit is undone. Run after install and periodically.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
CANARY_FILE=_leak_canary.txt
cleanup() { git reset -q -- "$CANARY_FILE" 2>/dev/null; rm -f "$CANARY_FILE"; }
trap cleanup EXIT

hp="$(git config core.hooksPath || true)"
[ "$hp" = ".githooks" ] || echo "WARNING: core.hooksPath is '$hp' (expected .githooks — run .githooks/install.sh)"

printf 'fire-drill canary: /home/leakcanary/secret must be rejected\n' > "$CANARY_FILE"
git add -f "$CANARY_FILE"
if git commit -q -m "fire-drill canary (must be rejected)" >/dev/null 2>&1; then
  echo "FIRE-DRILL FAILED: the wired hook did NOT block a canary leak — commits are not protected." >&2
  git reset -q --soft HEAD~1
  exit 1
fi
echo "fire-drill passed: the wired pre-commit hook blocked the canary (guard is live, fail-closed)."
