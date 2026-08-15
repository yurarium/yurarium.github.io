#!/usr/bin/env bash
# A COMPILED CACHE IS NOT SOURCE, AND .gitignore DOES NOT SAY SO ABOUT A FILE ALREADY TRACKED.
#
# `__pycache__/` and `*.pyc` have been in .gitignore since this repository was made, and three
# `build/__pycache__/*.pyc` files were tracked anyway: an ignore rule is consulted for an UNTRACKED
# path and says nothing about one git is already following. They were committed before the rule
# existed, `git add -A` kept updating them, and every one carried a byte-for-byte record of the
# source beside it into a public repository.
#
# SO THE RULE IS CHECKED RATHER THAN DECLARED. This asks the index, which is the only thing that
# settles whether a file is tracked, and it asks about the WHOLE index rather than about what is
# staged, so a file that slipped in earlier is caught by the next commit rather than by nobody.
#
#   .githooks/no-caches.sh          refuse a tracked cache anywhere in the tree
#   .githooks/no-caches.sh --list   name them and say nothing else
#
# BYPASSABLE WITH --no-verify, like every local hook, which is why the gate workflow runs it too.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# WHAT A PYTHON CACHE IS, AS PATHS. `__pycache__` anywhere, plus the three extensions the
# interpreter writes, plus the two directories a checker leaves. Kept as one list so a person
# adding to it edits one place.
readonly PATTERNS=(
  '__pycache__/'
  '*.pyc'
  '*.pyo'
  '*.pyd'
  '.mypy_cache/'
  '.pytest_cache/'
  '.ruff_cache/'
)

found=""
for pattern in "${PATTERNS[@]}"; do
  # `git ls-files` TAKES A GLOB AND THE INDEX IS THE SUBJECT. A directory pattern needs the star to
  # match what is under it; a file pattern is matched against the whole path either way.
  got="$(git ls-files -- "*${pattern%/}/*" "$pattern" 2>/dev/null | sort -u)"
  [ -n "$got" ] && found="${found}${got}"$'\n'
done

found="$(printf '%s' "$found" | sed '/^$/d' | sort -u)"

if [ -n "$found" ]; then
  if [ "${1:-}" = "--list" ]; then
    printf '%s\n' "$found"
    exit 1
  fi
  echo "no-caches: REFUSED — a compiled cache is tracked, which .gitignore cannot undo:" >&2
  printf '  %s\n' $found >&2
  echo >&2
  echo "  git rm -r --cached $(printf '%s ' $found)" >&2
  echo >&2
  echo "  removes them from the index and leaves the files on disk. They are ignored from then on." >&2
  exit 1
fi

[ "${1:-}" = "--list" ] || echo "no-caches: clean (no compiled cache is tracked)"
exit 0
