#!/usr/bin/env python3
"""build-app.py: kari/app.js is the concatenation of kari/src, in filename order.

COVERS = ['build-app.py']

WHY A CONCATENATION IS WORTH A SUITE. The files share one scope, as `app.js` always has, so the
join is the whole build: a source file that does not end in a newline welds its last line onto the
next file's first, and the result is valid JavaScript that means something else. `kari/src/BUILD.md`
argues for this over a bundler because a renderer reached only by a string key is invisible to
static analysis; what it costs is that the join has to be right, and nothing was asking.
"""
import importlib.util
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rules                                                    # noqa: E402
rules.on_path()                    # the pipeline's harness, and this repository as the site
import testkit                                                  # noqa: E402

COVERS = ["build-app.py"]

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _module():
    """`build-app.py`, loaded by path because its name is not an identifier."""
    spec = importlib.util.spec_from_file_location("build_app", ROOT / "build-app.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tree(d, files):
    """A src directory and an app.js beside it, as the builder expects to find them."""
    src = pathlib.Path(d) / "kari" / "src"
    src.mkdir(parents=True)
    for name, text in files.items():
        (src / name).write_text(text, encoding="utf-8")
    return src


def main(s):
    import tempfile

    app = _module()

    # ── THE SHIPPED TREE, WHICH IS THE CLAIM THAT MATTERS ─────────────────────────────────────
    s.check(app.parts(), "the site has sources to build from")
    s.eq(app.derive(), app.OUT.read_text(encoding="utf-8"),
         "and the shipped app.js is exactly what they concatenate to")

    # EVERY SOURCE ENDS WITH A NEWLINE, which is what makes concatenation safe. Without it the last
    # statement of one file and the first of the next become one line: `const A = 1` followed by
    # `const B = 2` is a syntax error where the two are lucky, and a different program where they
    # are not. The join adds nothing between files, so the files have to.
    s.eq([p.name for p in app.parts() if not p.read_text(encoding="utf-8").endswith("\n")], [],
         "every source file ends with a newline, so no two lines are welded together")

    # ── FILENAME ORDER, AND IT IS THE FILENAME'S ORDER RATHER THAN A NUMBER'S ─────────────────
    #
    # The numeric prefixes are what make lexical order the intended order, and a file added
    # without one sorts by its name like everything else. Said here because a reader of BUILD.md
    # could reasonably expect `9-x.js` to come before `10-y.js`, and it does not.
    with tempfile.TemporaryDirectory() as d:
        app.SRC = _tree(d, {"10-b.js": "b\n", "20-c.js": "c\n", "05-a.js": "a\n", "9-z.js": "z\n"})
        app.OUT = pathlib.Path(d) / "kari" / "app.js"
        s.eq([p.name for p in app.parts()], ["05-a.js", "10-b.js", "20-c.js", "9-z.js"],
             "the files concatenate in filename order, which sorts 9- after 20-")
        s.eq(app.derive(), "a\nb\nc\nz\n", "and the join puts nothing between them")

        # ── WHAT `--check` IS FOR ─────────────────────────────────────────────────────────────
        sys.argv = ["build-app.py", "--check"]
        s.eq(app.main(), 1, "a missing app.js is not the derivation of anything")
        sys.argv = ["build-app.py"]
        s.eq(app.main(), 0, "building writes it")
        s.eq(app.OUT.read_text(encoding="utf-8"), "a\nb\nc\nz\n", "as the sources concatenate")
        sys.argv = ["build-app.py", "--check"]
        s.eq(app.main(), 0, "and then the check agrees")

        # A SOURCE EDITED AND NOT REBUILT IS THE CASE THIS EXISTS FOR. The shipped file is what the
        # reader runs and what the interface checks are run against, so a stale one means every
        # answer about the interface is about a version nobody is served.
        (app.SRC / "10-b.js").write_text("b2\n", encoding="utf-8")
        s.eq(app.main(), 1, "an edited source with no rebuild is reported")
        sys.argv = ["build-app.py"]
        s.eq(app.main(), 0, "and rebuilding settles it")
        sys.argv = ["build-app.py", "--check"]
        s.eq(app.main(), 0, "which the check confirms")

        # A SOURCE REMOVED IS A CHANGE TOO, and a check that only compared the files it still found
        # would call the tree clean while shipping the deleted one's code.
        (app.SRC / "20-c.js").unlink()
        s.eq(app.main(), 1, "and a source removed leaves app.js stale as surely as one edited")


if __name__ == "__main__":
    sys.exit(testkit.run(main, __file__))
