#!/usr/bin/env python3
"""Run every test in this repository, offline, and report which modules have none.

  ./test.py              run everything
  ./test.py --canary     prove every suite is capable of failing
  ./test.py --list       show what would run

WHY THIS EXISTS. There were four suites in `build/` and nothing ran them. Three could not even
import the pipeline's harness, the fourth said node had nothing to render, and no workflow called
any of them, so `build/pages.py`, `build/stubs.py` and `build/entrypoints.py` were covered by tests
that had not executed since they were written. STORE-PLAN §11 moved the interface and everything
that checks what a reader is shown into this repository; the runner did not come with it.

DISCOVERY, NOT A LIST, which is the same rule the pipeline's runner keeps. Anything matching
test_*.py is collected, and so is any module accepting `--self-test`. A suite added here cannot be
forgotten because nothing has to be told about it.

OFFLINE IS ENFORCED, NOT REQUESTED. Every child runs with connecting blocked. This repository reads
a store and renders files, so a test that wants the network is a test of something else.

AND FINDING NOTHING IS A FAILURE. A run that discovers no suites prints a green line and exits 0,
which is the exact shape of a harness that has quietly stopped working. Discovering nothing is
reported as such and exits non-zero.
"""
import argparse
import ast
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
SKIP_DIRS = {".git", "__pycache__", ".github", "node_modules", "kari", ".githooks"}

sys.path.insert(0, str(ROOT / "build"))
import rules                                                            # noqa: E402

# Installed into every child before the test imports anything. Blocking at the connect catches
# urllib, http.client and anything else, without needing to know which the module uses. Creating a
# socket is harmless, and replacing the type breaks `import ssl`, which subclasses it.
GUARD = """
import os as _os
import socket as _s

# THE GUARD SAYS IT IS HERE, so a suite can hold it to that. A blocker nothing asserts about is a
# blocker that can quietly stop blocking: `build/test_rules.py` reads this and requires the refusal.
_os.environ["YURARIUM_OFFLINE"] = "1"


class Offline(Exception):
    pass


def _refuse(*a, **k):
    raise Offline("this test tried to reach the network. Tests run offline: this repository "
                  "reads a store and writes files, and both are on disk.")


_s.socket.connect = _refuse
_s.socket.connect_ex = _refuse
_s.create_connection = _refuse
_s.socket.sendto = _refuse
"""


def has_code(p):
    """Whether there is anything in the file to test. A re-export has no behaviour of its own."""
    try:
        tree = ast.parse(p.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return True                      # unparseable is a problem, not an exemption
    return any(not isinstance(n, (ast.Import, ast.ImportFrom, ast.Expr))
               or (isinstance(n, ast.Expr) and not isinstance(n.value, ast.Constant))
               for n in tree.body)


def modules():
    """Every module in the repository, this one included.

    THE RUNNER COUNTED EVERY MODULE BUT ITSELF, which is the exemption a harness should be last to
    take: `test.py` decides what a green tree means, and it could have had no test at all without
    appearing in the number it prints. It is not collected as a suite, having no `--self-test` and
    no `test_` name; it is in the denominator, and `build/test_rules.py` names it in `COVERS`.
    """
    for p in sorted(ROOT.rglob("*.py")):
        rel = p.relative_to(ROOT)
        if SKIP_DIRS & set(rel.parts):
            continue
        if any(part.startswith(".") for part in rel.parts):
            continue
        if has_code(p):
            yield p


def subjects(p):
    """Which modules a suite covers: its `COVERS` list, or its namesake beside it.

    `COVERS` HERE NAMES THE PIPELINE'S PATHS, because these suites were written there: they say
    `adapters/pages.py` for what is now `build/pages.py`. The basename is what is matched, so a
    declaration written before §11 still names the module it is about.
    """
    try:
        t = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    m = re.search(r"^COVERS\s*=\s*\[(.*?)\]", t, re.S | re.M)
    named = ({s.strip().strip("'\"") for s in m.group(1).split(",") if s.strip().strip("'\"")}
             if m else set())
    if not named:
        stem = re.sub(r"^test_|_test$", "", p.stem)
        sib = p.parent / f"{stem}.py"
        named = {str(sib.relative_to(ROOT))} if sib.exists() else set()
    out = set()
    for name in named:
        want = pathlib.Path(name).name
        out |= {str(m_.relative_to(ROOT)) for m_ in modules() if m_.name == want}
    return out


def collect():
    """`(runnables, covered)`, where a runnable is `(label, argv)`."""
    runnables, covered = [], set()
    for p in modules():
        rel = str(p.relative_to(ROOT))
        # THE DETECTOR MATCHES ITS OWN DEFINITION, which is how this file collected ITSELF as a
        # self-testing module the moment it stopped being excluded from the walk: the line below
        # searches for a string that the line below is, so `test.py --self-test` ran, argparse
        # refused the flag, and the runner reported itself vacuous. A rule written as a literal
        # matches the place the literal is written.
        if p.resolve() == pathlib.Path(__file__).resolve():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        if p.name.startswith("test_"):
            runnables.append((rel, [sys.executable, str(p)]))
            covered |= subjects(p)
            covered.add(rel)                      # a suite is covered by being run
        elif 'add_argument("--self-test"' in text or "add_argument('--self-test'" in text:
            runnables.append((f"{rel} --self-test", [sys.executable, str(p), "--self-test"]))
            covered.add(rel)
    return runnables, covered


def child(argv, canary):
    """Run one suite with the offline guard installed, returning `(code, output)`."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ROOT / "build")] + [p for p in (env.get("PYTHONPATH") or "").split(os.pathsep) if p])
    # THE GUARD GOES IN BEFORE THE MODULE IMPORTS ANYTHING, which is what `-c` buys over a wrapper
    # the suite would have to cooperate with.
    if canary:
        env["YURA_CANARY"] = "1"
    code = f"{GUARD}\nimport runpy, sys\nsys.argv = {argv[1:]!r}\nrunpy.run_path({argv[1]!r}, run_name='__main__')"
    got = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    return got.returncode, (got.stdout or "") + (got.stderr or "")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--canary", action="store_true",
                    help="invert every suite and require each to fail")
    ap.add_argument("--list", action="store_true", help="show what would run")
    a = ap.parse_args()

    runnables, covered = collect()
    if a.list:
        for label, _ in runnables:
            print(label)
        print(f"{len(runnables)} suite(s)")
        return 0

    # A SUITE THAT CANNOT IMPORT ITS HARNESS FAILS FOR THE WRONG REASON, and every one of these
    # imports `testkit` from the pipeline. Said once, here, rather than four times as a traceback.
    if not rules.present():
        print(rules.missing(), file=sys.stderr)
        return 1
    if not runnables:
        print("no suites discovered, which is a broken runner rather than a clean tree",
              file=sys.stderr)
        return 1

    bad, vacuous, unproven = [], [], []
    t0 = time.perf_counter()
    for label, argv in runnables:
        started = time.perf_counter()
        code, out = child(argv, a.canary)
        took = time.perf_counter() - started
        if a.canary:
            # INVERTED, SO FAILURE IS THE HEALTHY OUTCOME. A suite that ignores YURA_CANARY passes
            # and looks identical to one that was inverted and failed as it should, so the marker
            # `testkit` prints is the evidence and its absence is unproven rather than success.
            if "CANARY-PROVEN" not in out:
                unproven.append(label)
                print(f"  UNPROVEN {label}  {took:.1f}s")
            else:
                print(f"  ok   {label} fails when inverted  {took:.1f}s")
            continue
        if code == 2:
            vacuous.append(label)
            print(f"  VACUOUS {label}  {took:.1f}s")
            print(out.rstrip())
        elif code != 0:
            bad.append(label)
            print(f"  FAIL {label}  {took:.1f}s")
            print(out.rstrip())
        else:
            print(f"  ok   {label}  {took:.1f}s")

    untested = sorted({str(p.relative_to(ROOT)) for p in modules()} - covered)
    print(f"\n{len(runnables) - len(bad) - len(vacuous) - len(unproven)} passed, {len(bad)} failed, "
          f"{len(vacuous)} vacuous, {len(unproven)} unproven; {len(untested)} module(s) untested "
          f"in {time.perf_counter() - t0:.1f}s")
    if bad:
        print("failed: " + ", ".join(bad))
    if vacuous:
        print("vacuous (asserts nothing that can fail): " + ", ".join(vacuous))
    if unproven:
        print("not canary-aware (passed inversion untouched, so unproven): " + ", ".join(unproven))
    if untested:
        print("untested: " + ", ".join(untested))
    return 1 if (bad or vacuous or unproven) else 0


if __name__ == "__main__":
    sys.exit(main())
