#!/usr/bin/env python3
"""Turn the published store into what this site serves. STORE-PLAN §11.

WHAT CROSSES THE LINE IS A FILE WITH A VERSION ON IT. `yurison` compiles the corpus and publishes
`corpus.sqlite`; everything about how a reader is served it is decided here. The pipeline repository
has no path that names this one, and this repository has no opinion about how the corpus is
gathered.

NO GUARANTEE OF FORMAT IS OFFERED, which is the project owner's ruling and is why this checks the
stamp rather than trusting it. A store whose schema digest this build does not know is refused
outright: reading a column that has moved would produce a site that is wrong rather than a build
that failed, and a build that failed is the better of the two.

WHAT THIS WRITES. The ten files under `kari/data/`, the pre-rendered entry page for every work,
credit and publisher, and the cache-busting version on the script and the stylesheet. That is the
whole of what a deploy used to be, and it used to live in the pipeline.

    ./build/from_store.py --store corpus.sqlite          write everything
    ./build/from_store.py --store corpus.sqlite --check  say what would change and write nothing

NAMED FOR WHAT IT READS, and not `site.py`, which is a module the standard library already has: an
`import site` anywhere on this path would get whichever came first.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
KARI = ROOT / "kari"
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

#: WHERE THE CORPUS'S OWN RULES LIVE, and the dependency runs one way. How a name folds, what a
#: citation may show a reader, where a personal name parts: those are facts about the corpus and
#: they have one home, in the pipeline. This build reads them; the pipeline knows nothing about this
#: repository and has no path that names it. Both are public, so the clone needs no credential.
#:
#: PINNED TO THE COMMIT THAT MADE THE STORE, because a rule and the data it was applied to belong
#: together: the store's stamp says which schema it carries and the checkout says which rules.
ADAPTERS = pathlib.Path(
    os.environ.get("YURARIUM_ADAPTERS") or ROOT.parent / "yurison" / "adapters")

#: The schema digests this build knows how to read. A store stamped with anything else is refused.
#: More than one is listed while a schema change is in flight, so the two repositories can be
#: updated in either order rather than in lockstep.
#:
#: `5ad476caca453555` is the run's own report, §13: `run_source`, `run_queue`, `run_drop`, `check_result`
#: and `check_finding`, the last carrying the order `check.py` declares its checks in. `d07040c9`
#: stays listed because a store published before the change is still readable by this build, which
#: is what "either order" means; it comes out when nothing in flight needs it.
KNOWN_SCHEMAS = ("6d3bb09b1f977b25",)


def open_store(path):
    """The store, with its stamp checked. Raises where the shape is one this build does not know."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.execute("PRAGMA foreign_keys = ON")
    try:
        stamp = dict(db.execute("SELECT key, value FROM store_stamp"))
    except sqlite3.OperationalError:
        raise SystemExit(f"{path} carries no stamp; it is older than STORE-PLAN §11 or not a store")
    if stamp.get("schema") not in KNOWN_SCHEMAS:
        raise SystemExit(
            f"{path} is stamped {stamp.get('schema')!r} and this build knows {KNOWN_SCHEMAS}. "
            "The schema has moved; update `build/from_store.py` rather than reading it anyway.")
    return db, stamp


def files(db, generated):
    """Every file this site is served, as `{path: text}`.

    THE EMITTERS ARE THE CORPUS'S OWN SERIALISATION AND ARE IMPORTED RATHER THAN FORKED. Copying
    them here would make two producers of one fact, which is the fault the pipeline names most
    often; what this repository decides is WHICH files it wants, where they go, and what else a
    reader needs beside them. A site that wanted a different shape would write its own emitter
    against the same tables, and nothing in the pipeline would have to know.
    """
    for p in (ADAPTERS, ADAPTERS / "names", ADAPTERS / "relational"):
        sys.path.insert(0, str(p))
    import emit
    out = {}
    out["credits.json"] = emit.as_text(emit.credits(db, generated))
    out["publishers.json"] = emit.as_text(emit.publishers(db, generated))
    out["feed/credit-keys.json"] = emit.as_compact(emit.credit_keys(db))
    out["index.json"] = emit.as_compact(emit.index(db))
    out["works.json"] = emit.as_text(emit.works(db))
    out["feed/names.json"] = emit.as_text(emit.names(db, generated))
    out["series.json"] = emit.as_text(emit.series(db, generated))
    out.update(emit.feed_files(db))

    # ── THE RUN'S REPORT ON ITSELF, §13 ──────────────────────────────────────────────────────
    #
    # THESE THREE ARE NOT THE CORPUS AND THE SITE SERVES THEM ANYWAY. `app.js` reads `run.json`
    # for the date this pipeline began watching, and the status page is built from `status.json`
    # entire. They used to be copied across by `deploy.sh`; §11 removed that step and nothing
    # replaced it, so all three froze on 2026-08-13 while the corpus beside them moved on. A page
    # reporting on a run that is not the run that produced the data around it is worse than a
    # missing page, because it answers.
    #
    # `status.py` STAYS THE ONE PRODUCER OF THE STATUS DOCUMENT and only its inputs moved. A
    # second assembler here would be a second answer to what the run did.
    import status
    out["run.json"] = emit.as_text(emit.run(db))
    out["checks.json"] = emit.as_text(emit.checks(db))
    # THE PREVIOUS DOCUMENT IS THE ONE THING THE STORE CANNOT HOLD, being the file about to be
    # replaced and the only record of the run before this one. `since_last` is computed from it.
    was = KARI / "data" / "status.json"
    previous = json.loads(was.read_text(encoding="utf-8")) if was.exists() else None
    out["status.json"] = emit.as_text(status.from_store(db, previous))
    return out


def cache_bust():
    """The script and the stylesheet, versioned from their own content.

    `index.html` ASKED FOR A NUMBER NOBODY COMPUTED. It was written by hand and last moved on
    2026-08-07 while `app.js` changed a dozen times the same day, so every returning reader kept
    running the script they first loaded. A whole day of interface fixes reached nobody.
    """
    index = KARI / "index.html"
    if not index.exists():
        return []
    html, done = index.read_text(encoding="utf-8"), []
    for asset in ("app.js", "app.css"):
        f = KARI / asset
        if not f.exists():
            continue
        v = hashlib.sha256(f.read_bytes()).hexdigest()[:8]
        html = re.sub(rf'(?<=["\'/]){re.escape(asset)}(\?v=[0-9a-f]+)?', f"{asset}?v={v}", html)
        done.append(f"{asset}?v={v}")
    index.write_text(html, encoding="utf-8")
    return done


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--store", required=True, help="the published corpus.sqlite")
    ap.add_argument("--check", action="store_true",
                    help="say what would change and write nothing")
    ap.add_argument("--adapters", help="the pipeline's adapters/, where the corpus's rules live")
    ap.add_argument("--regenerate", metavar="YYYY-MM", action="append", default=[],
                    help="a month whose published row set may change, said deliberately")
    ap.add_argument("--prune", action="store_true",
                    help="delete data files the store no longer produces, which is never automatic")
    a = ap.parse_args(argv)
    if a.adapters:
        globals()["ADAPTERS"] = pathlib.Path(a.adapters)
    if not (ADAPTERS / "facts").is_dir():
        raise SystemExit(f"no adapters at {ADAPTERS}; clone yurison beside this repository or "
                         "pass --adapters")

    db, stamp = open_store(a.store)
    generated = stamp.get("generated") or ""
    written = json.loads(json.dumps(files(db, generated)))

    # A STORE THAT CANNOT SAY WHAT THE FEED IS IS A STORE THIS MAY NOT BUILD FROM. The window's
    # width, the first archived month and the run's date live in `run_report`, and a store compiled
    # without them emits no feed at all. That is a broken artefact rather than a corpus with no
    # releases, and the difference is worth refusing over: the day it happened, the site lost its
    # feed and rendered nothing.
    if "feed/current.json" not in written:
        raise SystemExit(f"{a.store} yields no feed window; its `run_report` is empty or its "
                         "releases carry no dates. Refusing to build from it.")

    data = KARI / "data"
    # ── A PUBLISHED MONTH DOES NOT LOSE ROWS, §11 ────────────────────────────────────────────
    #
    # THE ARCHIVE IS RE-DERIVED EVERY BUILD AND WHAT IS LOCKED IS THE ROW SET. A name the store has
    # since corrected reaches a month published before the correction, which is right; an update
    # that HAPPENED does not stop having happened, which is what this refuses. It was a check in
    # the pipeline comparing the built tree against the deployed one, and here it is a guard: the
    # build that would drop the row is the build that stops.
    lost = []
    for name, text in written.items():
        if not re.fullmatch(r"feed/[0-9]{4}-[0-9]{2}\.json", name):
            continue
        if name[len("feed/"):-len(".json")] in a.regenerate:
            continue
        was = data / name
        if not was.exists():
            continue
        held = {r.get("id") for r in (json.loads(was.read_text(encoding="utf-8")).get("releases")
                                      or [])}
        now = {r.get("id") for r in json.loads(text).get("releases") or []}
        gone = sorted(held - now)
        if gone:
            # EVERY ONE OF THEM, not the first. A row leaves for more than one reason and they are
            # told apart by reading them: a moving address mints a new id for a chapter nobody
            # lost, and a first-sighting date that arrives late carries a row into another month.
            # The operator can only tell those apart with the list in front of them.
            lost.append(f"{name}: {len(gone)} published row(s) no longer built")
            lost.extend(f"    {i}" for i in gone[:12])
            if len(gone) > 12:
                lost.append(f"    ... and {len(gone) - 12} more")
    if lost:
        for line in lost:
            print(f"REFUSING: {line}")
        print("A published month's ROW SET is what is locked, not its bytes. If the loss is "
              "understood and accepted, name the month with --regenerate, which says so out loud "
              "and in the commit rather than quietly.")
        return 2

    changed, same = [], 0
    for name, text in written.items():
        path = data / name
        if path.exists() and path.read_text(encoding="utf-8") == text:
            same += 1
            continue
        changed.append(name)
        if not a.check:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    # A FILE THE STORE NO LONGER PRODUCES IS REPORTED, AND DELETED ONLY WHEN ASKED. It used to be
    # deleted outright, on the reasoning that a file the pipeline stopped emitting would otherwise be
    # served for ever. That reasoning holds and the ACTION was still wrong: an emitter that produces
    # NOTHING is indistinguishable here from a pipeline that meant to stop, and one that produced
    # nothing took the feed off the live site. A store with an empty `run_report` is all it took.
    #
    # SO A REMOVAL IS A DELIBERATE ACT NOW, `--prune`, and everything else about this build stays
    # automatic. The cost of leaving a stale file for a day is a file nobody fetches; the cost of
    # deleting a live one is the site.
    # THE THREE REPORT FILES USED TO BE EXEMPT HERE, because nothing built them and the sweep
    # would have deleted what `deploy.sh` had copied. §13 builds them, so they are in `written`
    # like everything else and the exemption would only hide a run that stopped producing one.
    stale = [p for p in sorted(data.rglob("*.json"))
             if str(p.relative_to(data)) not in written]
    for p in stale:
        changed.append(f"{'-' if a.prune else '?'}{p.relative_to(data)}")
        if a.prune and not a.check:
            p.unlink()

    print(f"store  : schema {stamp.get('schema')}, generated {generated or 'unstated'}")
    print(f"data   : {len(changed)} file(s) {'would change' if a.check else 'written'}, "
          f"{same} unchanged")
    for name in changed:
        print(f"       : {name}")
    if a.check:
        return 1 if changed else 0

    import pages
    import stubs
    stubs.main(["--series", str(data / "series.json"), "--site", str(KARI),
                "--names", str(data / "feed" / "names.json")])
    pages.main(["--build", str(data), "--site", str(KARI)])
    got = cache_bust()
    if got:
        print("assets :", " ".join(got))
    return 0


if __name__ == "__main__":
    sys.exit(main())
