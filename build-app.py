#!/usr/bin/env python3
"""Build kari/app.js from kari/src, or check that it is the derivation of it.

CONCATENATION IN FILENAME ORDER, because the files share one scope as app.js always has. See
kari/src/BUILD.md for why this and not a bundler; the short version is that a renderer reached only
by a string key is invisible to static analysis, and tree-shaking one away would be silent.

    ./build-app.py            rebuild
    ./build-app.py --check    exit non-zero if app.js is not what src derives to
"""
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "kari" / "src"
OUT = ROOT / "kari" / "app.js"


def parts():
    """The source files, in the order they are concatenated."""
    return sorted(p for p in SRC.glob("*.js"))


def derive():
    """What `kari/app.js` should contain."""
    return "".join(p.read_text(encoding="utf-8") for p in parts())


def main():
    check = "--check" in sys.argv
    want = derive()
    have = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
    if check:
        if want == have:
            print(f"  app.js is the derivation of {len(parts())} source file(s)")
            return 0
        print("  app.js DIFFERS from kari/src")
        print(f"    src   sha256 {hashlib.sha256(want.encode()).hexdigest()[:16]}")
        print(f"    app.js sha256 {hashlib.sha256(have.encode()).hexdigest()[:16]}")
        return 1
    OUT.write_text(want, encoding="utf-8")
    print(f"  wrote kari/app.js from {len(parts())} source file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
