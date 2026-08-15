#!/usr/bin/env python3
"""from_store.py: what this site refuses to build, and what it writes when it does not refuse.

COVERS = ['build/from_store.py']

WHY THE REFUSALS ARE THE SUBJECT. This module turns a published store into the files a reader is
served, and the emitters it calls are the pipeline's, tested there. What is this repository's own
is the set of guards around them, and every one was written after something went wrong: a store
with an empty `run_report` emitted no feed and the sweep deleted the live one, a published month
quietly lost rows a reader had already been shown, and `index.html` asked for a script version
nobody computed, so a day of interface fixes reached no returning reader.

NO STORE IS NEEDED FOR ANY OF IT. `files()` is the one part that reads the corpus, and a test that
needed a compiled store would be a test of whether somebody had built recently. It is replaced with
what a store would have produced, which is exactly what these guards read.
"""
import json
import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rules                                                    # noqa: E402
rules.on_path()                    # the pipeline's harness, and this repository as the site
import from_store                                               # noqa: E402
import testkit                                                  # noqa: E402

COVERS = ["build/from_store.py"]


def _store(path, schema, generated="2026-08-15"):
    """A file with a stamp and nothing else, which is all `open_store` reads."""
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE store_stamp (key TEXT PRIMARY KEY, value TEXT)")
    db.executemany("INSERT INTO store_stamp VALUES (?,?)",
                   [(k, v) for k, v in (("schema", schema), ("generated", generated)) if v])
    db.commit()
    db.close()
    return path


def _feed(ids):
    return json.dumps({"releases": [{"id": i} for i in ids]}, ensure_ascii=False)


#: THE EMPTY SHAPES THE WRITE PATH NEEDS, and it needs them because it really runs: `stubs` and
#: `pages` pre-render the entry pages a citation resolves to, and both read files this produces.
#: An empty corpus is a corpus, and a build that fell over on one would be a build that could not
#: be the first.
EMPTY = {"series.json": '{"series": []}', "feed/names.json": "{}", "index.json": "[]",
         "works.json": '{"works": []}', "credits.json": '{"credits": {}}',
         "publishers.json": '{"publishers": {}}'}


def main(s):
    import contextlib
    import io
    import os
    import tempfile

    d = pathlib.Path(tempfile.mkdtemp())

    # ── A STORE IS OPENED ONLY WHERE ITS SHAPE IS ONE THIS BUILD KNOWS ────────────────────────
    #
    # The two repositories are updated in either order, so more than one schema is listed while a
    # change is in flight. What may never happen is building from a store whose shape this does not
    # understand: the emitters would read columns that mean something else and the site would serve
    # it without a word.
    good = _store(str(d / "good.sqlite"), from_store.KNOWN_SCHEMAS[0])
    db, stamp = from_store.open_store(good)
    s.eq(stamp["schema"], from_store.KNOWN_SCHEMAS[0], "a stamped store opens and says what it is")
    s.eq(stamp["generated"], "2026-08-15", "carrying the date it was compiled")
    db.close()

    raised = ""
    try:
        from_store.open_store(_store(str(d / "odd.sqlite"), "0000000000000000"))
    except SystemExit as why:
        raised = str(why)
    s.check("knows" in raised and "0000000000000000" in raised,
            "a schema this build does not know is refused, naming what it found")

    bare = sqlite3.connect(str(d / "bare.sqlite"))
    bare.execute("CREATE TABLE work (id TEXT)")
    bare.commit()
    bare.close()
    raised = ""
    try:
        from_store.open_store(str(d / "bare.sqlite"))
    except SystemExit as why:
        raised = str(why)
    s.check("carries no stamp" in raised, "and a database with no stamp at all is not a store")

    # ── WHAT THE GUARDS READ, IN PLACE OF A COMPILED CORPUS ───────────────────────────────────
    site = d / "site"
    (site / "data" / "feed").mkdir(parents=True)
    from_store.KARI = site
    was_files = from_store.files
    produced = {}
    from_store.files = lambda db_, generated: dict(produced)

    def run(*argv):
        """`main` with its output captured, returning `(code, text)`."""
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                code = from_store.main(["--store", good, *argv])
        except SystemExit as why:
            return why.code if isinstance(why.code, int) else 1, out.getvalue() + str(why)
        return code, out.getvalue()

    # A STORE THAT CANNOT SAY WHAT THE FEED IS. The window, the first archived month and the run's
    # date live in `run_report`; compiled without them the store emits no feed, which is a broken
    # artefact rather than a corpus with no releases. The day it happened the site lost its feed.
    produced = {"index.json": "[]"}
    code, said = run("--check")
    s.check("no feed window" in said, "a store that yields no feed window is refused")
    s.check(not (site / "data" / "index.json").exists(),
            "and nothing is written on the way to refusing")

    # ── A PUBLISHED MONTH DOES NOT LOSE ROWS ──────────────────────────────────────────────────
    #
    # The archive is re-derived every build and what is locked is the ROW SET: a name the store has
    # since corrected reaches a month published before the correction, which is right, and an
    # update that happened does not stop having happened, which is what this refuses.
    produced = dict(EMPTY, **{"feed/current.json": _feed(["r1"]),
                              "feed/2026-07.json": _feed(["a", "b", "c"])})
    (site / "data" / "feed" / "2026-07.json").write_text(_feed(["a", "b", "c"]),
                                                        encoding="utf-8")
    produced["feed/2026-07.json"] = _feed(["a", "c"])
    code, said = run()
    s.eq(code, 2, "a build that would drop a published row stops")
    s.check("2026-07" in said and " b" in said,
            "naming the month and the rows, because only a person can tell a re-mint from a loss")
    s.eq(json.loads((site / "data" / "feed" / "2026-07.json").read_text())["releases"],
         [{"id": "a"}, {"id": "b"}, {"id": "c"}],
         "and the published month is left exactly as it was served")

    # SAID OUT LOUD, IN THE RUN'S OWN RECORD. `--regenerate` is how an accepted loss is accepted,
    # rather than by a guard that quietly gave way.
    code, said = run("--regenerate", "2026-07")
    s.eq(code, 0, "the month named on the command line may lose rows")
    s.eq(json.loads((site / "data" / "feed" / "2026-07.json").read_text())["releases"],
         [{"id": "a"}, {"id": "c"}], "and is rebuilt as the store now states it")

    # ── `--check` WRITES NOTHING, WHICH IS THE WHOLE OF WHAT IT PROMISES ──────────────────────
    produced = dict(EMPTY, **{"feed/current.json": _feed(["r1", "r2"]),
                              "feed/2026-07.json": _feed(["a", "c"])})
    before = (site / "data" / "feed" / "current.json").read_text(encoding="utf-8")
    code, said = run("--check")
    s.eq(code, 1, "a file that would change is reported as a change")
    s.eq((site / "data" / "feed" / "current.json").read_text(encoding="utf-8"), before,
         "and the file on disk is untouched")
    s.check("would change" in said, "which the wording says as well as the exit code")
    code, said = run()
    s.eq(code, 0, "writing it settles the difference")
    code, said = run("--check")
    s.eq(code, 0, "so the next check finds nothing to do")

    # ── A FILE THE STORE NO LONGER PRODUCES IS REPORTED, AND DELETED ONLY WHEN ASKED ──────────
    #
    # It used to be deleted outright, and an emitter producing NOTHING is indistinguishable here
    # from a pipeline that meant to stop. One store with an empty `run_report` took the feed off
    # the live site.
    (site / "data" / "gone.json").write_text("{}", encoding="utf-8")
    code, said = run()
    s.check("?gone.json" in said, "a file nothing produces is named")
    s.check((site / "data" / "gone.json").exists(), "and left alone, a removal being deliberate")
    code, said = run("--prune")
    s.check(not (site / "data" / "gone.json").exists(), "`--prune` is what actually removes it")

    # ── THE RUN'S OWN DATE, WHERE A WORKFLOW CAN READ IT ──────────────────────────────────────
    #
    # `site.yml` labelled its commit with the runner's clock, so a run at 09:00 in Japan published
    # today's corpus under yesterday's date. The store says when it was compiled.
    stamped = d / "github_output"
    os.environ["GITHUB_OUTPUT"] = str(stamped)
    try:
        run("--check")
        s.check("generated=2026-08-15" in stamped.read_text(encoding="utf-8"),
                "the store's own date is handed to the workflow that publishes it")
    finally:
        del os.environ["GITHUB_OUTPUT"]

    from_store.files = was_files

    # ── THE SCRIPT A RETURNING READER ACTUALLY RUNS ───────────────────────────────────────────
    #
    # `index.html` carried a hand-written version and `app.js` changed a dozen times the day it
    # last moved, so a whole day of interface fixes reached nobody who had the page cached.
    (site / "app.js").write_text("console.log(1)\n", encoding="utf-8")
    (site / "app.css").write_text("body{}\n", encoding="utf-8")
    (site / "index.html").write_text(
        '<link rel="stylesheet" href="app.css"><script src="app.js?v=deadbeef"></script>',
        encoding="utf-8")
    got = from_store.cache_bust()
    html = (site / "index.html").read_text(encoding="utf-8")
    s.eq(len(got), 2, "both assets are versioned")
    s.check("app.js?v=deadbeef" not in html, "a stale version is replaced rather than appended")
    s.check(all(f"{a}?v=" in html for a in ("app.js", "app.css")),
            "and each carries a version of its own")
    first = html
    s.eq(from_store.cache_bust() and (site / "index.html").read_text(encoding="utf-8"), first,
         "running it again with the same content changes nothing")
    (site / "app.js").write_text("console.log(2)\n", encoding="utf-8")
    from_store.cache_bust()
    s.check((site / "index.html").read_text(encoding="utf-8") != first,
            "and an edited script gets a new version, which is the whole point")


if __name__ == "__main__":
    sys.exit(testkit.run(main, __file__))
