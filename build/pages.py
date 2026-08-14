#!/usr/bin/env python3
"""A pre-rendered entry page per credit and per publishing house.

WHY THESE EXIST, and it is `stubs.py`'s reason applied to two more kinds of record. The interface is
one page and moving inside it costs no fetch, because the corpus is already client-side. What a
single page cannot do is answer a link followed from outside: a fragment never reaches the server,
and a citation that resolves only when JavaScript runs is a weaker promise than a bibliographic
database should make. A credit page IS a citation target by design, since the whole point of minting
2,238 identifiers was that somebody could link to one.

WHAT A CREDIT PAGE SHOWS. The credit as filed, what kind of thing it is where that is not a person,
and every work in this corpus it is named on with the role on each pairing where a source stated
one. Nothing else, and in particular no reading and no romanisation: those are the name's own
provenance, they belong to the person, and the interface renders them from `feed/names.json` with
the reader's own choices about style and order applied. Baking one into a static file would be a
second producer of a rendering that already has one.

WHAT A PUBLISHER PAGE SHOWS. The house, the imprint lines it runs with the number of print rows on
each, and the works. The lines are the point: 百合姫コミックス over 354 rows against a house with one
book somebody shelved as yuri is a difference no other page in this interface can show, and it is
what tells a reader which houses run a yuri line.

THE FRAMING THIS MUST NOT GET WRONG, and the pages say it in so many words. We hold KADOKAWA's yuri
works and KADOKAWA prints tens of thousands of books, so a page headed with a name and listing works
claims to describe a publisher when it describes our coverage. That binds an AUTHOR harder, because
a publisher reads as obviously bigger than our slice and a person does not: a page listing three
works implies that is the body of work, when they may have thirty and we hold the three that are
yuri. Each page states what its list is, in both languages, above the list.

A CREDIT NOBODY IS NAMED ON GETS NO PAGE. Five identifiers are in that state and all five are the
same artefact: `iimAn&惟丞` and four others were one identifier for two people until the splitter
learned that an ampersand joins two, and each half now holds its own. The registry is append-only so
the joined identifier stays and keeps resolving in the data; a page for it would head a record with a
name no source uses and list nothing under it. Same rule the work stubs already follow, where a page
that outlives its work asserts something withdrawn.
"""
import pathlib

import stubs

# THE SEAT A HOUSE HELD, and the job a credit did, in the reader's two languages. Small closed
# vocabularies, so they are glossed rather than left to strand a page in Japanese; a word not in the
# table shows as the source wrote it, which is the same fallback every other name takes.
SEAT_EN = {"publisher": ("出版", "published"), "distributor": ("発売", "distributed")}
ROLE_EN = {"原作": "story", "作画": "art", "漫画": "art", "著": "author", "著者": "author",
           "脚本": "script", "構成": "composition", "キャラクター原案": "character design",
           "原案": "original concept", "イラスト": "illustration", "企画": "planning",
           "監修": "supervision", "編": "editor", "編集": "editor", "訳": "translation",
           "翻訳": "translation", "絵": "art", "文": "text", "表紙": "cover", "協力": "assistance"}

# SAY WHAT THE LIST IS AND STOP. Each of these carried a second sentence saying what it was not:
# not their body of work, not the house's catalogue. The first sentence already says the list is
# what this database holds as yuri, so the second only tells a reader what they are not looking at,
# which is a use of their attention and not a fact about the works.
#
# A SECOND COPY OF THESE LIVES IN kari/app.js, which renders the same pages live while this
# pre-renders them. §3 says that will drift and it already had: the two wordings differed before
# either was trimmed. Neither can import the other because one runs in a browser, so they are kept
# aligned by hand and this comment is the warning.
SHAPE_NOTE = {
    "person": ("この人物が関わったとして本データベースが把握している百合作品の一覧。",
               "The yuri works in this database that name this person."),
    "venue": ("この媒体に掲載されたとして本データベースが把握している百合作品の一覧。",
              "The yuri works in this database published in this venue."),
    "organisation": ("この団体が関わったとして本データベースが把握している百合作品の一覧。",
                     "The yuri works in this database that name this organisation."),
}

HOUSE_NOTE = ("この出版社の作品のうち、本データベースが百合として収録しているものの一覧。",
              "The yuri works this database holds from this publisher.")


def _page(title, depth, body, query):
    """The shell every one of these shares, which is `stubs.render`'s shell.

    Not imported from it, because that function renders a WORK and takes a work row; what is shared
    is the head, the stylesheet, the robots line and the handover, and those are here. A stub is a
    real page for a reader without JavaScript and a doorway for one with it: the redirect runs only
    where scripts run, and the content above is what remains when they do not.
    """
    up = "../" * depth
    return "\n".join([
        "<!doctype html>", '<html lang="ja">', "<head>", '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">',
        f"<title>{stubs.esc(title)} — Yurarium</title>",
        f'<link rel="stylesheet" href="{up}app.css">',
        "</head>", "<body>",
        body,
        # THE ENTITY BELONGS IN THE HREF AND NOT IN THE SCRIPT. `&amp;` is how an ampersand is
        # written inside an HTML attribute and is a literal five characters inside a JavaScript
        # string, so one address written both ways needs both spellings. The work stubs already
        # do this; writing it once for both would send every reader of a credit page to
        # `?tab=ser&amp;credit=c00001`.
        f'<p><a href="{up}?{query.replace("&", "&amp;")}">Yurarium</a></p>',
        f'<script>location.replace("{up}?{query}");</script>',
        "</body>", "</html>", ""])


def _works_list(work_ids, titles, roles_by_work=None):
    """The works, as real links a reader without JavaScript can follow."""
    out = []
    for wid in work_ids:
        label = titles.get(wid) or wid
        roles = (roles_by_work or {}).get(wid) or []
        # The job in both languages where the vocabulary knows it, because a page whose
        # whole content is a list of works should still say who drew and who wrote to a
        # reader who cannot read the label.
        said = " ".join(f"（{r}{' / ' + ROLE_EN[r] if r in ROLE_EN else ''}）" for r in roles)
        out.append(f'<li><a href="../../work/{stubs.esc(wid)}/">{stubs.esc(label)}</a>'
                   f"{stubs.esc(said)}</li>")
    return "<ul>" + "".join(out) + "</ul>" if out else ""


def credit_page(cid, fact, titles):
    """One credit's entry page. `fact` is a record out of `credits.json`."""
    name = fact.get("credit") or cid
    note = SHAPE_NOTE.get(fact.get("shape") or "person", SHAPE_NOTE["person"])
    works = [w.get("id") for w in fact.get("works") or [] if w.get("id")]
    roles = {w["id"]: list(w.get("roles") or []) for w in fact.get("works") or [] if w.get("id")}
    body = [f"<h1>{stubs.esc(name)}</h1>"]
    if fact.get("kind"):
        body.append(f"<p>{stubs.esc(fact['kind'])}</p>")
    body.append(f"<p>{stubs.esc(note[0])}</p><p>{stubs.esc(note[1])}</p>")
    body.append(_works_list(works, titles, roles))
    for other in fact.get("homophones") or []:
        # INFORMATION HUNG BESIDE A CREDIT, never a merge. Two credits a source filed differently
        # are two objects, and the owner's ruling is that anything linking them is ancillary.
        body.append(f'<p>{stubs.esc(other.get("reading") or "")}: '
                    f'<a href="../../credit/{stubs.esc(other.get("id"))}/">'
                    f'{stubs.esc(other.get("credit"))}</a></p>')
    return _page(name, 2, "".join(body), f"tab=ser&credit={cid}")


def publisher_page(hid, fact, titles):
    """One house's entry page. `fact` is a record out of `publishers.json`."""
    name = fact.get("name") or hid
    body = [f"<h1>{stubs.esc(name)}</h1>",
            f"<p>{stubs.esc(HOUSE_NOTE[0])}</p><p>{stubs.esc(HOUSE_NOTE[1])}</p>"]
    seats = [SEAT_EN.get(s, (s, s))[1] for s in fact.get("seats") or []]
    if seats and seats != ["published"]:
        body.append(f"<p>{stubs.esc(', '.join(seats))}</p>")
    for line in fact.get("lines") or []:
        years = sorted({y for sp in line.get("spellings") or [] for y in (sp.get("years") or [])
                        if y})
        span = f" {years[0]}–{years[-1]}" if len(years) > 1 else (f" {years[0]}" if years else "")
        parent = f" / {line['parent']}" if line.get("parent") else ""
        body.append(f"<p>{stubs.esc(line.get('name'))}{stubs.esc(parent)} "
                    f"{line.get('rows', 0)}{stubs.esc(span)}</p>")
    body.append(_works_list(fact.get("works") or [], titles))
    return _page(name, 2, "".join(body), f"tab=ser&publisher={hid}")


def written(credits_doc, publishers_doc, titles):
    """{relative path: html} for every credit and house with a page, and every retired id."""
    out = {}
    live_c = set()
    for cid, fact in sorted((credits_doc or {}).get("credits", {}).items()):
        if not stubs.SAFE_ID.match(str(cid)):
            continue
        # A CREDIT NOBODY IS NAMED ON GETS NO PAGE. See the module docstring: all five are the
        # joined spellings the ampersand split left behind, and heading a page with a name no
        # source uses would be asserting a credit the corpus no longer makes.
        if not (fact.get("works") or []):
            continue
        live_c.add(str(cid))
        out[f"credit/{cid}/index.html"] = credit_page(cid, fact, titles)
    out.update(stubs.forwarders("credit", live_c, (credits_doc or {}).get("merged") or {}))
    live_h = set()
    for hid, fact in sorted((publishers_doc or {}).get("publishers", {}).items()):
        if not stubs.SAFE_ID.match(str(hid)):
            continue
        live_h.add(str(hid))
        out[f"publisher/{hid}/index.html"] = publisher_page(hid, fact, titles)
    out.update(stubs.forwarders("publisher", live_h, (publishers_doc or {}).get("merged") or {}))
    return out


def prune(site, root, keep):
    """Delete pages under `root` that this run did not write. Returns how many went.

    STALE PAGES ARE THE FAILURE MODE, exactly as they are for a work stub. A credit that leaves the
    corpus, or one whose identifier is retired into another, leaves a page behind asserting a record
    we no longer make, and `cp` never removes anything.
    """
    removed = 0
    base = pathlib.Path(site) / root
    if not base.exists():
        return 0
    for p in sorted(base.glob("*/index.html")):
        if str(p) not in keep:
            p.unlink()
            try:
                p.parent.rmdir()
            except OSError:
                pass
            removed += 1
    return removed


def main(argv=None):
    import argparse, json                                                   # noqa: E401

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--build", default="data/build")
    ap.add_argument("--site", required=True, help="the kari/ directory in the site repo")
    a = ap.parse_args(argv)

    b = pathlib.Path(a.build)
    creds = json.loads((b / "credits.json").read_text()) if (b / "credits.json").exists() else {}
    pubs = (json.loads((b / "publishers.json").read_text())
            if (b / "publishers.json").exists() else {})
    rows = json.loads((b / "series.json").read_text()).get("series") or []
    titles = {str(r.get("id")): r.get("work") for r in rows if r.get("id")}

    site = pathlib.Path(a.site)
    files = written(creds, pubs, titles)
    for rel, body in files.items():
        p = site / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.exists() or p.read_text() != body:
            p.write_text(body)
    keep = {str(site / rel) for rel in files}
    gone = prune(site, "credit", keep) + prune(site, "publisher", keep)
    fwd = sum(1 for rel in files if "This record is now" in files[rel])
    print(f"credit and publisher pages: {len(files) - fwd} written, "
          f"{fwd} forwarding a retired id, {gone} stale removed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
