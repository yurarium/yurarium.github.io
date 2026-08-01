#!/usr/bin/env bash
# leak-guard.sh — fail-closed identity + content guard for this pseudonymous repo.
#
# Shared by .githooks/{pre-commit,pre-push} and CI. On EVERY run it first self-tests against a planted
# canary and aborts (exit 3) if the canary slips through, so a broken or un-wired guard blocks rather than
# passing silently: a clean report means "the guard ran and caught its canary", never "the guard did
# nothing". Fail closed.
#
# Contains NO real identity. The pseudonym allowlist is safe to commit; the specific real-name denylist is
# supplied out of band via $LEAK_DENY (newline-separated FIXED strings, from a gitignored local file or a
# CI secret), so committing this guard never publishes the thing it guards.
#
# Usage:
#   leak-guard.sh identity-config          # the about-to-author git identity must be the pseudonym
#   leak-guard.sh identity  <git-range>    # every commit's author + committer must be the pseudonym
#   leak-guard.sh content   staged|tree|<git-range>
#   leak-guard.sh all       <git-range>    # identity <range> + content over <range>
# Exit: 0 clean · 2 leak found · 3 self-test failed (guard broken) · 64 usage.
set -uo pipefail

ALLOW='Yurarium <311755991+yurarium@users.noreply.github.com>'

# Safe-to-commit structural denylist — shapes, not specific values (reveals no real identity):
#   /home/<user>/ absolute paths; internal tracker-tag formats.
STRUCT_DENY='/home/[[:alnum:]._-]+/|(^|[^A-Za-z])(BH|IR|PV)-[0-9]|(^|[^A-Za-z])WS[0-9]([^0-9]|$)'

# Out-of-band specific denylist: newline-separated FIXED strings (real name / emails / codenames). Empty
# when not supplied.
DENY="${LEAK_DENY:-}"

die() { echo "leak-guard: FATAL — self-test failed: $1. Guard broken/un-wired; refusing (fail closed)." >&2; exit 3; }

# Print forbidden-content hits from stdin; exit 0 if any, 1 if none. Both the real scan and the self-test
# route through this one matcher, so a passing canary proves the real path is live. STRUCT_DENY is a
# regex; $DENY entries are fixed strings (grep -F) so an escaped denylist can't silently fail to self-match.
content_hits() {
  local input found=1
  input="$(cat)"
  if printf '%s\n' "$input" | grep -nEi "$STRUCT_DENY"; then found=0; fi
  if [ -n "$DENY" ]; then
    if printf '%s\n' "$input" | grep -nFi -f <(printf '%s\n' "$DENY" | grep -vE '^[[:space:]]*(#|$)'); then found=0; fi
  fi
  return "$found"
}

# 0 = violation (not the pseudonym), 1 = ok.
identity_violation() { [ "$1" != "$ALLOW" ]; }

selftest() {
  printf '/home/canary/x PV-0\n' | content_hits >/dev/null || die "structural matcher missed its canary"
  if [ -n "$DENY" ]; then
    local first; first="$(printf '%s\n' "$DENY" | grep -vE '^[[:space:]]*(#|$)' | head -n1)"
    [ -z "$first" ] || printf 'x %s x\n' "$first" | content_hits >/dev/null || die "supplied denylist did not self-match"
  fi
  identity_violation 'Canary <canary@example.invalid>' || die "identity allowlist accepted a bad canary"
}

# 0 = a violation was found, 1 = clean.
check_identity() {
  local range="$1" found=1 who
  while IFS= read -r who; do
    [ -z "$who" ] && continue
    if identity_violation "$who"; then echo "leak-guard: ✗ non-pseudonym identity: $who" >&2; found=0; fi
  done < <(git log --format='%an <%ae>%n%cn <%ce>' "$range" 2>/dev/null | sort -u)
  return "$found"
}

# The guard's own machinery legitimately contains denylist patterns / canaries, so it is excluded from
# the content scan (it is reviewed; it holds no real identity — the real-name denylist is out of band).
EXCL=(':!*.jar' ':!*.png' ':!.githooks/leak-guard.sh' ':!.githooks/fire-drill.sh')

# 0 = forbidden content found, 1 = clean.
check_content() {
  local mode="$1" text hits
  case "$mode" in
    staged) text="$(git diff --cached -U0 --diff-filter=d -- "${EXCL[@]}" | grep -E '^\+[^+]|^\+\+\+ ' | sed -E 's#^\+\+\+ b/#FILE #')" ;;
    tree)   text="$(git grep -nI '' -- "${EXCL[@]}" 2>/dev/null)" ;;
    *)      text="$(git diff -U0 "$mode" -- "${EXCL[@]}" | grep -E '^\+[^+]|^\+\+\+ ' | sed -E 's#^\+\+\+ b/#FILE #')" ;;
  esac
  [ -z "$text" ] && return 1
  hits="$(printf '%s\n' "$text" | content_hits)" || return 1
  echo "leak-guard: ✗ forbidden content:" >&2; printf '%s\n' "$hits" >&2; return 0
}

cmd="${1:-}"; arg="${2:-}"
selftest
rc=0
case "$cmd" in
  identity-config)
    who="$(git config user.name) <$(git config user.email)>"
    if identity_violation "$who"; then echo "leak-guard: ✗ configured author is not the pseudonym: $who" >&2; rc=2; fi ;;
  identity) [ -n "$arg" ] || { echo "range required" >&2; exit 64; }; check_identity "$arg" && rc=2 ;;
  content)  [ -n "$arg" ] || { echo "mode required" >&2; exit 64; };  check_content  "$arg" && rc=2 ;;
  all)      [ -n "$arg" ] || { echo "range required" >&2; exit 64; }
            check_identity "$arg" && rc=2; check_content "$arg" && rc=2 ;;
  *) echo "usage: leak-guard.sh identity-config|identity <range>|content staged|tree|<range>|all <range>" >&2; exit 64 ;;
esac
[ "$rc" = 0 ] && echo "leak-guard: clean (self-test passed; $cmd${arg:+ $arg})"
exit "$rc"
