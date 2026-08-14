#!/usr/bin/env python3
"""pages.py: the entry page a credit and a house each serve, and the ones they must not.

The fixtures are records `build.py` really emits. c00024 is 仲谷鳰 with two works; c00301 stands
for the 20 credits that are not people, here 電撃G'sマガジン, which DEFINITIONS treats as a place
where yuri is published rather than as a party to a work; c01276 is `大島永遠&大島智`, one of the
five identifiers left holding nobody once the splitter learned that an ampersand joins two.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import pages                                                                # noqa: E402
import testkit                                                             # noqa: E402

COVERS = ["adapters/pages.py"]

TITLES = {"w00001": "やがて君になる", "w00002": "君の名前", "w00003": "剣道娘は異世界でも斬り結ぶ"}

CREDITS = {
    "merged": {"c00999": "c00024"},
    "credits": {
        "c00024": {"credit": "仲谷鳰", "shape": "person",
                   "works": [{"id": "w00001", "roles": ["原作", "作画"]}, {"id": "w00002"}],
                   "homophones": [{"id": "c00777", "credit": "仲谷にお", "reading": "ナカタニニオ",
                                   "basis": "two credits a source filed differently"}]},
        "c00301": {"credit": "電撃G'sマガジン", "shape": "venue", "kind": "magazine",
                   "works": [{"id": "w00003"}]},
        "c01276": {"credit": "大島永遠&大島智", "shape": "person", "works": []},
    },
}

HOUSES = {
    "merged": {},
    "publishers": {
        "h00004": {"id": "h00004", "name": "一迅社", "rows": 3, "seats": ["publisher"],
                   "works": ["w00001", "w00002"],
                   "lines": [{"id": "yurihime-comics", "name": "百合姫コミックス",
                              "parent": "IDコミックス", "resolved": True, "rows": 2,
                              "works": ["w00001"],
                              "spellings": [{"raw": "IDコミックス. Yuri-hime comics", "rows": 1,
                                             "years": ["2009", "2014"]},
                                            {"raw": "IDコミックス. Yurihime comics", "rows": 1,
                                             "years": ["2016", "2018"]}]}]},
    },
}


def main(s):
    files = pages.written(CREDITS, HOUSES, TITLES)

    # ---- what is served, and what is not ---------------------------------------------------------
    s.check("credit/c00024/index.html" in files, "a credit with works gets a page")
    s.check("publisher/h00004/index.html" in files, "and so does a house")
    # THE FIVE THE AMPERSAND SPLIT LEFT BEHIND. The registry is append-only so the joined
    # identifier stays and keeps resolving in the data; heading a page with a name no source uses
    # and listing nothing under it would be asserting a credit the corpus no longer makes.
    s.check("credit/c01276/index.html" not in files,
            "a credit nobody is named on gets no page")

    page = files["credit/c00024/index.html"]
    s.check("仲谷鳰" in page, "the credit is the heading")
    s.check('href="../../work/w00001/"' in page and "やがて君になる" in page,
            "and each work is a real link a reader without JavaScript can follow")
    s.check("（原作 / story）" in page and "（作画 / art）" in page,
            "with the job stated in both languages where a source gave one")
    s.check("w00002" in page and "（" not in page.split("w00002")[1].split("</li>")[0],
            "and nothing invented for the work whose role no source states")

    # ---- the framing, which is the whole reason these pages are risky -----------------------------
    # An author page listing three works implies that is the body of work. A publisher reads as
    # obviously bigger than our slice; a person does not, so the page has to say what its list is.
    s.check("The yuri works in this database that name this person" in page,
            "a person's page says what its list is")
    house = files["publisher/h00004/index.html"]
    s.check("The yuri works this database holds from this publisher" in house,
            "and a house's page says what its list is")
    # SAYING WHAT IT IS NOT WAS THE OTHER HALF AND IS GONE. Both sentences used to close with a
    # denial, not their body of work and not its catalogue, which told a reader what they were not
    # looking at. The claim above already limits the list to what this database holds as yuri.
    for _p in (page, house):
        s.check("ではない" not in _p and "Not their body" not in _p and "Not its catalogue" not in _p,
                "and does not go on to say what it is not")

    # A MAGAZINE IS A PLACE, NOT A PERSON. 20 of these credits are not people and must not get a
    # person-shaped page: DEFINITIONS treats a magazine as somewhere yuri is published.
    venue = files["credit/c00301/index.html"]
    s.check("published in this venue" in venue, "a venue's page says where and not who")
    s.check("Not their body of work" not in venue, "and never the person's sentence")

    # ---- the imprint lines, which are what a publisher page is for --------------------------------
    s.check("百合姫コミックス" in house, "the line is named by its own name")
    s.check("IDコミックス" in house, "with the umbrella recorded beside it and not folded in")
    s.check("2009–2018" in house,
            "and the years its spellings cover, measured off the rows rather than written down")

    # ---- the handover, and the ampersand that has to be spelt twice --------------------------------
    s.check('href="../../?tab=ser&amp;credit=c00024"' in page,
            "the href carries the entity an HTML attribute needs")
    s.check('location.replace("../../?tab=ser&credit=c00024")' in page,
            "and the script carries the character JavaScript needs")
    s.check("noindex,nofollow,noarchive,nosnippet" in page, "nothing here asks to be indexed")

    # ---- a retired identifier still resolves ------------------------------------------------------
    fwd = files.get("credit/c00999/index.html")
    s.check(fwd and 'href="../../credit/c00024/"' in fwd,
            "a retired credit forwards inside the credit root, not into work/")
    s.check(fwd and "canonical" in fwd and "location.replace" in fwd,
            "with the same stub 49 retired work ids already serve")

    # ---- stale pages go ---------------------------------------------------------------------------
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        site = pathlib.Path(d)
        for rel, body in files.items():
            p = site / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body)
        (site / "credit" / "c09999").mkdir(parents=True)
        (site / "credit" / "c09999" / "index.html").write_text("a credit that has left")
        keep = {str(site / rel) for rel in files}
        s.eq(pages.prune(site, "credit", keep), 1,
             "a page whose credit is gone is deleted rather than left to assert a withdrawn record")
        s.check((site / "credit" / "c00024" / "index.html").exists(), "and a live one is kept")
        s.eq(pages.prune(site, "publisher", keep), 0, "nothing stale under the other root")


if __name__ == "__main__":
    raise SystemExit(testkit.run(main, pathlib.Path(__file__).name))
