#!/usr/bin/env python3
"""Where the corpus's own rules are, and putting them on the path. STORE-PLAN §11.

WHY THIS IS A MODULE. How a name folds, what a citation may show a reader, where a personal name
parts: those are facts about the corpus with one home, in the pipeline, and this repository reads
them rather than keeping a second copy that would drift. Finding them is a question with one
answer, and it was spelled in `from_store.py` and nowhere else, so the four suites in `build/`
could not import `testkit` at all: three failed on `ModuleNotFoundError` and the fourth said node
had nothing to run, because `YURARIUM_SITE` was unset and the pipeline's harness looked for an
interface at `../no-site-configured`. None of them ran in CI, so nothing said so.

`YURARIUM_SITE` IS SET HERE, AND THIS REPOSITORY IS THE ANSWER. The pipeline stopped assuming a
sibling checkout when §11 moved the interface, so it takes the site's location from the
environment. A suite in the repository that IS the site should not have to be told.
"""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

#: PINNED TO THE COMMIT THAT MADE THE STORE, because a rule and the data it was applied to belong
#: together. CI clones the pipeline beside this repository and names it in `YURARIUM_ADAPTERS`; a
#: person working locally has the same clone as a sibling, which is what the default says.
ADAPTERS = pathlib.Path(
    os.environ.get("YURARIUM_ADAPTERS") or ROOT.parent / "yurison" / "adapters")

#: The three directories the pipeline expects on the path. `names` and `relational` are packages
#: whose modules import each other by bare name, so being inside one is not enough.
WITHIN = ("", "names", "relational")


def on_path(at=None):
    """Put the pipeline's modules on `sys.path` and return where they were found.

    `at` NAMES A DIFFERENT CHECKOUT, which is what `from_store.py --adapters` passes. Calling this
    twice is harmless: a path already there is not added again, so a suite importing this after
    something else did gets the same answer rather than a longer path.
    """
    global ADAPTERS
    if at:
        ADAPTERS = pathlib.Path(at)
    for part in WITHIN:
        p = str(ADAPTERS / part if part else ADAPTERS)
        if p not in sys.path:
            sys.path.insert(0, p)
    # THE SITE IS THIS REPOSITORY, said once. `adapters/interface.py` runs the shipped `app.js`
    # under node and reads `YURARIUM_SITE` to find it; unset, it looks in a directory whose name
    # says there is no site, and every display suite reports it had nothing to run.
    os.environ.setdefault("YURARIUM_SITE", str(ROOT))
    return ADAPTERS


def present():
    """Whether the rules are actually where `ADAPTERS` says. A caller decides what to do about it."""
    return (ADAPTERS / "facts").is_dir()


def missing():
    """What to tell somebody who has no pipeline checkout, in one sentence."""
    return (f"no adapters at {ADAPTERS}; clone yurison beside this repository, set "
            "YURARIUM_ADAPTERS, or pass --adapters")
