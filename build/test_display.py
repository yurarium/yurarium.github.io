#!/usr/bin/env python3
"""Display-time transforms must not reach the markup they are carried in.

COVERS = ['kari/src/10-names.js', 'kari/src/20-app.js']

THE FAULT THIS IS FOR. `T()` runs `curly()` and `respell()` over whatever it is handed, because it
exists to set the interface's own prose. `publisherPartsHtml` handed it a publisher CHIP, which is
an anchor, so `class="wplink pub"` came back `class=“wplink pub”` and
`href="/kari/publisher/h00004/"` came back wrapped in curly quotes. Every distributor link on the
site resolved to a path that does not exist, and 208 records carry a distributor. The same call
printed the name twice in 併記, because `T` joins its two arguments.

WHY A RENDERED-OUTPUT TEST AND NOT A READING OF THE SOURCE. The bug is invisible in the source: the
line looked like every other bilingual label. It is only visible in what node produces, which is
what this asks for.

OFFLINE. node is handed a file path and a request on stdin. Where node is not installed nothing
here asserts, and the runner reports that as vacuous rather than as a pass.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import interface                                                        # noqa: E402
import testkit                                                          # noqa: E402

#: A publisher record shaped like the ones that broke: a house, a distributor, and an imprint.
#: 一迅社 is published by itself and distributed by 講談社, which is the real arrangement.
WITH_DISTRIBUTOR = {"publisher": "一迅社", "distributor": "講談社", "imprint": "百合姫コミックス"}

#: Names keyed as the build keys them, so the chips carry ids and render as anchors. An anchor is
#: the point: a chip with no `href` has no attribute for `curly` to break.
NAMES = {
    "titles": {"citrus": {"en": "citrus", "basis": "official-jp",
                          "en_forms": {"official-jp": "citrus"}}},
    "publishers": {
        "一迅社": {"en": "Ichijinsha", "basis": "romaji", "id": "h00012"},
        "講談社": {"en": "Kodansha", "basis": "romaji", "id": "h00004"},
        "百合姫コミックス": {"en": "Comic Yuri Hime", "basis": "romaji", "id": "h00090"},
    },
}

CURLY = "“”‘’"


def attributes_of(html):
    """Every `name="value"` the markup declares, as raw text, for inspection."""
    return re.findall(r'(\w[\w-]*)="([^"]*)"', html)


def main(s):
    try:
        interface.render([("publisherPartsHtml", WITH_DISTRIBUTOR)], names=NAMES,
                         prefs={"LANG": "en"})
    except interface.Unavailable as e:
        s.check(None, f"node is needed to run the shipped interface and is not available: {e}")
        return

    def parts(lang):
        got = interface.render([("publisherPartsHtml", WITH_DISTRIBUTOR)], names=NAMES,
                               prefs={"LANG": lang})
        return got[0]["html"], got[0]["text"]

    # ── the markup survives the transform ──────────────────────────────────────────────────────
    for lang in ("en", "ja", "both"):
        html, _ = parts(lang)
        s.check(not any(c in html for c in CURLY),
                f"in {lang}, no typographic quote reaches the markup a chip is built from")
        hrefs = [v for k, v in attributes_of(html) if k == "href"]
        s.check(hrefs, f"in {lang}, the distributor is a link at all")
        s.check(all(h.startswith("/") or h.startswith("http") for h in hrefs),
                f"in {lang}, every href is an address and not a quoted copy of one: {hrefs}")

    # THE DISTRIBUTOR'S OWN LINK, which is the one that was broken while its neighbour was intact.
    html, _ = parts("en")
    s.check("/kari/publisher/h00004/" in html,
            "the distributor's link points at the publisher page it names")

    # ── the name is not printed twice in 併記 ───────────────────────────────────────────────────
    _, text = parts("both")
    s.eq(text.count("講談社"), 1,
         "a distributor is named once in 併記, not once per language")
    s.check("（発売）" in text, "and is still marked as the distributor")

    # ── a separator is punctuation ─────────────────────────────────────────────────────────────
    # `T('・', ' · ')` renders `・ / ·` in 併記, which is why the two lists that still used it were
    # showing the separator itself in two languages. `SEP` is the mark; nothing may translate it.
    app = pathlib.Path(interface.APP_JS).read_text(encoding="utf-8")
    # THE CALL AND NOT THE MENTION. The comments that record this fault quote it verbatim, so a
    # bare substring count reads its own documentation as two more instances of the bug.
    s.eq(len(re.findall(r"join\(\s*T\('・'", app)), 0,
         "no list in the shipped interface joins its items on a translated separator")
    s.check("const SEP" in app, "and the separator every list uses is defined once")

    # ── two identical lines are one line ───────────────────────────────────────────────────────
    # 127 works are titled in Latin alone, so 併記 stacked `citrus` over `citrus`. `recWorkRows` is
    # a real list renderer that wraps its rows in `bilingual`, which is the function under test;
    # `workLabel` answers in ONE language by design and would prove nothing about stacking.
    series = {"series": [{"id": "w1", "work": "citrus"}, {"id": "w2", "work": "雨夜の月"}]}
    names = {"titles": dict(NAMES["titles"],
                            **{"雨夜の月": {"en": "the moon on a rainy night", "basis": "official-jp",
                                          "en_forms": {"official-jp": "the moon on a rainy night"}}})}
    got = interface.render([("recWorkRows", ["w1"], {}, {}), ("recWorkRows", ["w2"], {}, {})],
                           names=names, prefs={"LANG": "both", "SERIES": series})
    s.eq(got[0]["text"].strip().count("citrus"), 1,
         "a title that is the same in both languages is shown once in 併記")

    # AND A TITLE THAT DIFFERS IS STILL STACKED, or the rule above is just suppression.
    s.check("雨夜の月" in got[1]["text"] and "moon" in got[1]["text"],
            "a title whose two languages differ still shows both")


if __name__ == "__main__":
    sys.exit(testkit.run(main, "display-transforms"))
