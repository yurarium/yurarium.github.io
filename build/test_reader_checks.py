#!/usr/bin/env python3
"""reader_checks.py: the checks over what a reader is shown, and the shape of the suite itself.

COVERS = ['build/reader_checks.py']

WHAT IS ASKED HERE AND WHAT IS ASKED THERE. `reader_checks.py --store …` plants four canaries in a
real context every run, so the checks that need the corpus are proved against it where the corpus
is. What that cannot reach is the SUITE: whether a budget has a ceiling to exceed, whether a canary
names a check anybody runs, whether a check that cannot read its subject says so. Every one of
those is a way for the whole report to come out green while asking nothing, and none of them needs
a compiled store to answer.

THE ONE THAT ALREADY HAPPENED. `every renderer is ruled` derives its renderer set from the shipped
`app.js`, found through `YURARIUM_SITE`, which no workflow set: the read raised, the check caught
every exception and returned no violations, and it printed `ok` on every published build while
`workLabelText` sat unruled. STANDING-INSTRUCTIONS §4 is what that broke, and the check now names
what it could not read. This is what holds it to that.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rules                                                    # noqa: E402
rules.on_path()                    # the pipeline's harness, and this repository as the site
import reader_checks as rc                                      # noqa: E402
import testkit                                                  # noqa: E402

COVERS = ["build/reader_checks.py"]


def main(s):
    import tempfile

    # ── THE SUITE'S OWN SHAPE ─────────────────────────────────────────────────────────────────
    #
    # A BUDGET WITH NO CEILING IS NEVER EXCEEDED. `main` compares against `RECORDED[name]` and
    # skips the comparison where there is none, so a budget added without a number reports its
    # count every run and blocks nothing, which reads exactly like a budget that is being kept.
    budgets = [name for name, _fn, _why in rc.BUDGETS]
    s.eq([b for b in budgets if b not in rc.RECORDED], [],
         "every budget has a recorded ceiling, or it enforces nothing")
    s.eq(sorted(set(rc.RECORDED) - set(budgets)), [],
         "and every recorded ceiling belongs to a budget that is still measured")

    # ONE NAME PER CHECK, because the report is read by name and the store the pipeline keeps is
    # keyed on it. Two checks sharing one would report as each other.
    names = [n for n, _ in rc.INVARIANTS] + budgets
    s.eq(sorted(n for n in set(names) if names.count(n) > 1), [],
         "no two checks answer to the same name")

    # A CANARY FOR A CHECK NOBODY RUNS PROVES NOTHING, and it would sit there looking like proof.
    # `canaries` plants each fault as it really arrived and fails the run when a check does not
    # notice; this asks the question one level up, whether the check it names is in the list.
    import inspect
    planted = {line.split('("')[1].split('"')[0]
               for line in inspect.getsource(rc.canaries).splitlines()
               if line.strip().startswith('("')}
    s.check(planted, "the self-test plants canaries at all")
    s.eq(sorted(planted - {n for n, _ in rc.INVARIANTS}), [],
         "and every one of them names an invariant this suite actually runs")

    # ── A CHECK THAT CANNOT READ ITS SUBJECT SAYS SO, §4 ──────────────────────────────────────
    sys.path.insert(0, str(rc.ADAPTERS))
    import interface
    was = interface.APP_JS
    try:
        interface.APP_JS = pathlib.Path("/nonexistent/kari/app.js")
        got = rc.inv_every_renderer_is_ruled({})
        s.eq(len(got), 1, "with no interface to read, the check reports rather than passing")
        s.check("could not be read" in got[0] and "FileNotFoundError" in got[0],
                "and says what stopped it, which is how §4 was broken here in the first place")
    finally:
        interface.APP_JS = was
    s.eq(rc.inv_every_renderer_is_ruled({}), [],
         "and with the shipped interface in front of it, every renderer is ruled")

    # ── THE SHIPPED SCRIPT IS THE DERIVATION OF ITS SOURCE ────────────────────────────────────
    #
    # The checks run the real `app.js` in a Node vm, so what they verify is what ships. That holds
    # only while the shipped file is exactly the sources, which is what this asks.
    s.eq(rc.inv_the_interface_is_the_derivation_of_its_source({}), [],
         "the interface this repository serves is what its sources concatenate to")
    kari = rc.KARI
    try:
        with tempfile.TemporaryDirectory() as d:
            rc.KARI = pathlib.Path(d)
            (rc.KARI / "src").mkdir()
            (rc.KARI / "src" / "10-a.js").write_text("a\n", encoding="utf-8")
            (rc.KARI / "app.js").write_text("a\n", encoding="utf-8")
            s.eq(rc.inv_the_interface_is_the_derivation_of_its_source({}), [],
                 "a tree whose script matches its source passes")
            (rc.KARI / "src" / "10-a.js").write_text("a2\n", encoding="utf-8")
            got = rc.inv_the_interface_is_the_derivation_of_its_source({})
            s.eq(len(got), 1, "an edited source with no rebuild is caught")
            s.check("build-app.py" in got[0], "and the reader is told what to run")
    finally:
        rc.KARI = kari

    # ── THE PROSE A READER MEETS ──────────────────────────────────────────────────────────────
    #
    # The documentation ships so a third party can pick the project up, which makes it part of the
    # deliverable. This runs the pipeline's lint over the pages a reader opens, and it parses the
    # lint's own markers: an earlier version split on an em dash, so a change to the lint's output
    # separator would have made the check silently vacuous.
    s.eq(rc.inv_no_stock_phrasing_in_public_text({}), [],
         "the pages this site serves carry none of it")
    text = rc.READER_TEXT
    try:
        with tempfile.TemporaryDirectory() as d:
            clean = pathlib.Path(d) / "clean.md"
            clean.write_text("The corpus holds 3,038 works. Each carries the source it came "
                             "from.\n", encoding="utf-8")
            rc.READER_TEXT = [clean]
            s.eq(rc.inv_no_stock_phrasing_in_public_text({}), [],
                 "prose that says things is left alone")
            bad = pathlib.Path(d) / "bad.md"
            bad.write_text("This project is a testament to what a small database can do. Let us "
                           "delve into the rich tapestry of yuri publishing.\n", encoding="utf-8")
            rc.READER_TEXT = [bad]
            s.check(len(rc.inv_no_stock_phrasing_in_public_text({})) >= 2,
                    "and prose that performs is reported, one finding per phrase")
    finally:
        rc.READER_TEXT = text


if __name__ == "__main__":
    sys.exit(testkit.run(main, __file__))
