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
import os
import json
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
KNOWN_SCHEMAS = ("d07040c96d75baaa",)


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
    a = ap.parse_args(argv)
    if a.adapters:
        globals()["ADAPTERS"] = pathlib.Path(a.adapters)
    if not (ADAPTERS / "facts").is_dir():
        raise SystemExit(f"no adapters at {ADAPTERS}; clone yurison beside this repository or "
                         "pass --adapters")

    db, stamp = open_store(a.store)
    generated = stamp.get("generated") or ""
    written = json.loads(json.dumps(files(db, generated)))

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
        was = data / name
        if not was.exists():
            continue
        held = {r.get("id") for r in (json.loads(was.read_text(encoding="utf-8")).get("releases")
                                      or [])}
        now = {r.get("id") for r in json.loads(text).get("releases") or []}
        if held - now:
            lost.append(f"{name}: {len(held - now)} published row(s) no longer built, "
                        f"first {sorted(held - now)[0]}")
    if lost:
        for line in lost:
            print(f"REFUSING: {line}")
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

    # A FILE THE STORE NO LONGER PRODUCES IS DELETED, never left to rot. `cp` adds and overwrites
    # and never removes, which is how a file the pipeline stopped emitting went on being served.
    stale = [p for p in sorted(data.rglob("*.json"))
             if str(p.relative_to(data)) not in written
             and p.name not in ("run.json", "checks.json", "status.json")]
    for p in stale:
        changed.append(f"-{p.relative_to(data)}")
        if not a.check:
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
