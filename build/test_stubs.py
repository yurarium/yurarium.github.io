#!/usr/bin/env python3
"""stubs.py: a citation that resolves without JavaScript, and never for a work we withdrew."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import stubs  # noqa: E402
import testkit  # noqa: E402

COVERS = ["adapters/stubs.py"]

WORK = {"id": "w00055", "work": "ぜんぶ壊して地獄で愛して", "author": "くわばらたもつ",
        "chapters": 91, "latest": "2026-07-28", "url": "https://pocket.shonenmagazine.com/x",
        "state_basis": "no chapter for 18 days, and nothing states it has ended",
        "work_en": {"en": "Break It All, Love Me in Hell"},
        "print": [{"volumes": 4, "publisher": "[頒布]講談社",
                   "imprint": "IDコミックス. Yurihime comics", "first": "2023-09"}]}


def main(s):
    h = stubs.render(WORK)
    s.check("ぜんぶ壊して地獄で愛して" in h, "the work names itself")
    s.check("Break It All, Love Me in Hell" in h, "in both languages where it has both")
    s.check("91 chapters" in h and "4 volumes in print" in h,
            "and states its two publications, which is the whole point of the join")
    s.check("no chapter for 18 days" in h, "the basis travels with the state")

    # THE CATALOGUING PREFIX IS NOT THE PUBLISHER'S NAME. MADB writes [頒布] for the distributor.
    s.check("講談社" in h and "[頒布]" not in h, "the role prefix is stripped before a reader sees it")

    # NOT INDEXED. The site's posture is deliberate and a new page must not quietly opt in.
    s.check("noindex" in h, "a stub carries the same robots posture as the page it belongs to")
    s.check('href="../../app.css"' in h, "and reaches the shared stylesheet from two levels down")

    # THE HANDOVER, which the first version got wrong. app.js renders into the interface's own
    # markup, and a stub does not carry it, so loading the bundle here left a reader on a dead page.
    s.check('src="../../app.js"' not in h, "the bundle is not loaded where there is nothing to run it on")
    s.check("location.replace" in h and "work=w00055" in h,
            "a reader with scripts is handed to the interface, at this work")

    # A STUB IS STILL A PAGE. Somebody arrives here from a citation, so it must not depend on the
    # script it also loads.
    s.check(h.startswith("<!doctype html>"), "it is a document, not a fragment")

    esc = stubs.render({"id": "w1", "work": '<script>x</script>', "work_en": {}})
    s.check("<script>x</script>" not in esc, "a title is escaped, not executed")
    s.check("&lt;script&gt;" in esc, "and survives as text")

    files = stubs.written("work", [WORK, {"id": "w00056", "work": "b"}])
    s.eq(sorted(files), ["work/w00055/index.html", "work/w00056/index.html"],
         "one file per work, at its own address")

    # AN ID BUILDS A PATH, SO IT IS CHECKED RATHER THAN TRUSTED. Ours are [A-Za-z0-9], but a stray
    # slash would write outside the tree.
    s.eq(stubs.written("work", [{"id": "../../etc/x", "work": "b"}]), {},
         "an identifier that is not one writes nothing")
    s.eq(stubs.written("work", [{"work": "no id"}]), {},
         "and a work registered since the last identity run writes nothing either")

    s.eq(stubs.summary({}), "", "nothing known, nothing claimed")
    s.eq(stubs.summary({"chapters": 3}), "3 chapters", "and only what is known is stated")


    # A RETIRED IDENTIFIER STILL RESOLVES. Two records turning out to be one work retires an id, and
    # an address published once has to keep working: that is why an id here is opaque and minted
    # rather than derived from a title. `merged_into` recorded where it went from the beginning and
    # nothing acted on it, so 20 of 26 retired ids became blank pages in one afternoon.
    rows = [{"id": "w0002", "work": "残った作品", "state": "print", "chapters": 0}]
    files = stubs.written("work", rows, {"w0001": "w0002"})
    s.check("work/w0001/index.html" in files, "a retired id gets a page of its own")
    fwd = files["work/w0001/index.html"]
    s.check("../../work/w0002/" in fwd, "which points at the work it became")
    s.check("location.replace" in fwd, "replacing the entry so the dead address is not behind them")
    s.check('http-equiv="refresh"' in fwd, "and refreshing for a reader with no JavaScript")
    s.check("残った作品" not in fwd, "a forwarder carries no record, or the work would have two")

    # A CHAIN LANDS ON WHAT IS LIVE. A into B into C has to reach C, not a page that forwards again.
    chain = stubs.written("work", rows, {"a": "b", "b": "w0002"})
    s.check("../../work/w0002/" in chain["work/a/index.html"], "a chain is followed to the end")

    # And the guards. A live id is never forwarded, and a path is built from an id so it is checked.
    s.check("work/w0002/index.html" in stubs.written("work", rows, {"w0002": "w0001"}),
            "an id that still names a live work keeps its record")
    s.check("This record is now" not in stubs.written("work", rows, {"w0002": "w0001"})["work/w0002/index.html"],
            "and is not turned into a forwarder by a stale entry")
    s.eq([k for k in stubs.written("work", rows, {"../etc": "w0002"})], ["work/w0002/index.html"],
         "an id that is not an id writes nothing, because a path is built from it")
    s.eq([k for k in stubs.written("work", rows, {"w0001": "nowhere"})], ["work/w0002/index.html"],
         "and a target nothing resolves to forwards nowhere rather than to a blank page")

    # ── THE ROOT IS THE DIRECTORY, AND IT WAS ACCEPTED AND IGNORED ─────────────────────────────
    #
    # Every link in a forwarder was spelt `work/` regardless of what `root` said. Invisible while
    # `work` was the only root; a bug the moment a second kind of record needed the same page, since
    # a retired credit identifier would have sent its reader to a work that does not exist.
    other = stubs.forwarders("credit", {"c00001"}, {"c00002": "c00001"})
    s.eq(sorted(other), ["credit/c00002/index.html"], "a second root writes under its own name")
    s.check("../../credit/c00001/" in other["credit/c00002/index.html"],
            "and points inside it")
    s.check("work/" not in other["credit/c00002/index.html"],
            "with no path back to the work registry")
    s.check('rel="canonical" href="../../credit/c00001/"' in other["credit/c00002/index.html"],
            "the canonical link included, which is the one a search engine reads")


if __name__ == "__main__":
    raise SystemExit(testkit.run(main, pathlib.Path(__file__).name))
