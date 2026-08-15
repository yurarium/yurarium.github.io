#!/usr/bin/env python3
"""rules.py: where the corpus's own rules are, and the runner's offline guard held to its word.

COVERS = ['build/rules.py', 'test.py']

WHY THE RUNNER IS COVERED FROM IN HERE. `test.py` installs a network blocker into every child and
says so in its docstring, and a blocker nobody asserts about is one that can quietly stop blocking:
the suites would keep passing, offline would stop being enforced, and the first sign would be a
test that mysteriously needs the internet. This suite runs INSIDE that child, so it is the one
place that can ask the guard whether it is really there.
"""
import os
import pathlib
import socket
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rules                                                    # noqa: E402
rules.on_path()                    # the pipeline's harness, and this repository as the site
import testkit                                                  # noqa: E402

COVERS = ["build/rules.py", "test.py"]

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main(s):
    # ── THE PATH, AND SAYING IT ONCE ──────────────────────────────────────────────────────────
    #
    # Three directories, because `names` and `relational` hold modules that import each other by
    # bare name: being inside one of them is not being on the path for the others.
    where = rules.on_path()
    for part in rules.WITHIN:
        p = str(where / part if part else where)
        s.check(p in sys.path, f"the pipeline's {part or 'own'} directory is on the path")

    # CALLING IT TWICE ADDS NOTHING, which is what lets a suite ask for the rules without knowing
    # whether something else already did. An earlier shape appended every time and a long run grew
    # a path with the same three entries in it repeatedly.
    before = list(sys.path)
    rules.on_path()
    s.eq(sys.path, before, "asking twice leaves the path as it was")

    # THE SITE IS THIS REPOSITORY. `adapters/interface.py` runs the shipped `app.js` under node and
    # takes the site's location from the environment; unset, it looks in a directory whose name
    # says there is no site and every display check reports it had nothing to run. That is how
    # `test_display.py` sat green with 0 of its 16 checks executed.
    s.eq(os.environ.get("YURARIUM_SITE"), str(ROOT),
         "the site's own suites are told this repository is the site")
    import interface
    s.eq(interface.APP_JS, ROOT / "kari" / "app.js",
         "so the pipeline's harness finds the interface that is actually shipped")
    s.check(interface.APP_JS.exists(), "and it is there to be run")

    # ── ABSENCE IS A STATE, NOT AN EMPTY ANSWER ───────────────────────────────────────────────
    s.check(rules.present(), "the rules are where this checkout says they are")
    s.check("clone yurison" in rules.missing() and str(rules.ADAPTERS) in rules.missing(),
            "and a checkout without them is told where they should be")

    # ── THE RUNNER'S OFFLINE GUARD, ASKED RATHER THAN TRUSTED ─────────────────────────────────
    #
    # `test.py` marks the child it has guarded. Under the runner the refusal must be real; run by
    # hand there is no guard and the ordinary socket must still be intact, so this asserts
    # something either way rather than going quiet in the case it was not written for.
    guarded = os.environ.get("YURARIUM_OFFLINE") == "1"
    refused = None
    try:
        socket.create_connection(("127.0.0.1", 9), timeout=0.01)
    except Exception as why:                                            # noqa: BLE001
        refused = why.__class__.__name__
    if guarded:
        s.eq(refused, "Offline", "under the runner a connection is refused by the guard")
    else:
        s.check(refused != "Offline",
                "and run by hand there is no guard, which is what the runner adds")


if __name__ == "__main__":
    sys.exit(testkit.run(main, __file__))
