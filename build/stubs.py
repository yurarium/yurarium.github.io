#!/usr/bin/env python3
"""A pre-rendered entry page per work, for cold arrivals.

WHY THESE EXIST. INTERFACE-PLAN §5. The single page is kept, and moving between works inside it
costs no fetch because the whole corpus is already client-side. What a single page cannot do is
answer a link followed from outside: a fragment never reaches the server, and a citation that
resolves only when JavaScript runs is a weaker promise than a bibliographic database should make.

So each work gets a small file at `work/<id>/index.html` holding its facts as real HTML. Someone
following a citation sees the work immediately, with no JavaScript and no fetch. Where scripts do
run, the page hands over to the interface at that work, so a reader ends up in the same view a
click would have produced. The stub is hit once per visit at most and never during use.

The handover is a redirect and NOT the bundle. app.js renders into the interface's own markup,
which a stub does not carry, so loading it here left the script with nothing to do and the reader
on a dead page. That was the first version and the browser found it, not the tests.

INDEXING IS NOT THE REASON. The site carries `noindex,nofollow,noarchive,nosnippet` and that stands.
The reasons are that a citation should survive a reader without JavaScript, and that a stable
address is most of what makes a reference work citable.

STALE STUBS ARE THE FAILURE MODE. A pre-rendered page outlives the work it describes: プリンセ「ス」
left the corpus and returned on the same day. `written()` returns every path it produced so the
deploy can delete the rest, which is the inverse of the carry-over rule and the one thing this
generator must get right.
"""
import html
import pathlib
import re

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def summary(work):
    """One line of prose about the work, for a reader with no JavaScript and no styling."""
    bits = []
    if work.get("chapters"):
        bits.append(f"{work['chapters']} chapters")
    for p in work.get("print") or []:
        if p.get("volumes"):
            bits.append(f"{p['volumes']} volumes in print")
            break
    if work.get("latest"):
        bits.append(f"latest {work['latest']}")
    return ", ".join(bits)


def both(ja, en):
    """`ja / en`, which is how the heading has always shown a name, or the Japanese alone.

    ONE SHAPE FOR EVERY NAME ON THE PAGE. The heading did this and nothing else did, so a stub
    carried its title in two languages and its byline, its publisher and its line in Japanese only.
    A stub is what a reader without JavaScript gets and what a reader with it sees first, so those
    fields reached an English reader untranslated on every work in the corpus.
    """
    ja, en = str(ja or ""), str(en or "")
    return f"{ja} / {en}" if ja and en and en != ja else ja


def _english_for(work, names):
    """The English the BUILD already derived for this work's byline and houses.

    NOT A SECOND RENDERER (§3). Every string here is a field build.py wrote and the interface reads;
    this looks them up and does not decide anything. A stub that composed its own English would be
    a second producer of a name, which is the fault this project has spent two rounds removing.
    """
    out = {}
    a = work.get("author_en") or {}
    out["author"] = a.get("en") or ((a.get("romaji") or {}).get("macron") or "")
    pubs = (names or {}).get("publishers") or {}
    out["publishers"] = {k: (v or {}).get("en") for k, v in pubs.items()}
    return out


def render(work, depth=2, names=None):
    """The stub for one work. `depth` is how far the file sits below the app's own directory."""
    up = "../" * depth
    title = work.get("work") or ""
    en = (work.get("work_en") or {}).get("en") or ""
    heading = both(title, en)
    english = _english_for(work, names)
    lines = [
        "<!doctype html>",
        '<html lang="ja">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">',
        f"<title>{esc(heading)} — Yurarium</title>",
        f'<link rel="stylesheet" href="{up}app.css">',
        "</head>",
        "<body>",
        f"<h1>{esc(heading)}</h1>",
    ]
    if work.get("author"):
        lines.append(f"<p>{esc(both(work['author'], english['author']))}</p>")
    if summary(work):
        lines.append(f"<p>{esc(summary(work))}</p>")
    for p in work.get("print") or []:
        _pub = re.sub(r"^\s*\[[^\]]*\]\s*", "", str(p.get("publisher") or ""))
        who = " · ".join(x for x in (both(_pub, english["publishers"].get(_pub)),
                                     re.sub(r"^\s*\[[^\]]*\]\s*", "", str(p.get("imprint") or "")),
                                     p.get("first") or "") if x)
        if who:
            lines.append(f"<p>{esc(who)}</p>")
    why = work.get("completed_basis") or work.get("state_basis")
    if why:
        lines.append(f"<p>{esc(why)}</p>")
    if work.get("url"):
        lines.append(f'<p><a href="{esc(work["url"])}" rel="noopener nofollow">'
                     f"{esc(work.get('platform') or 'Read')}</a></p>")
    # HANDING OVER, and this is not what the first version did. app.js renders into the interface's
    # own markup, which a stub does not carry, so loading it here left the script with nothing to
    # do and the reader on a dead page. A stub is a real page for a reader without JavaScript, and
    # a doorway for one with it: the redirect runs only where scripts run, and the content above
    # is what remains when they do not.
    wid = esc(work.get("id"))
    lines += [
        f'<p><a href="{up}?tab=ser&amp;work={wid}">Yurarium</a></p>',
        "<script>location.replace(" + f'"{up}?tab=ser&work={wid}"' + ");</script>",
        "</body>",
        "</html>",
        "",
    ]
    return "\n".join(lines)


def forward(root, retired, surviving, depth=2):
    """A page at a retired identifier that sends a reader to the work it became.

    AN ADDRESS PUBLISHED ONCE HAS TO KEEP RESOLVING. That is why an identifier here is opaque and
    minted rather than derived from a title: a title changes and an address must not. Two records
    turning out to be one work retires an id, and `merged_into` in the registry has recorded where
    it went since the beginning while nothing acted on it. 20 of 26 retired ids were live in a
    published build, so twenty addresses that resolved in the morning resolved nowhere by the
    evening, which is the exact failure the opaque id was chosen to prevent.

    It forwards. The work has one address now, and a second page carrying the same record would be
    a second address competing with it.

    `root` IS THE DIRECTORY THE RECORDS LIVE UNDER, and it was accepted and then ignored: every
    link in here was spelt `work/` regardless. That was invisible while `work` was the only root and
    became a bug the moment a second kind of record needed the same forwarder, because a retired
    credit id would have sent its reader to a work that does not exist.
    """
    up = "../" * depth
    to = f"{up}{root}/{esc(surviving)}/"
    return "\n".join([
        "<!doctype html>", '<html lang="ja">', "<head>", '<meta charset="utf-8">',
        '<meta name="robots" content="noindex,nofollow">',
        f'<link rel="canonical" href="{to}">',
        f'<meta http-equiv="refresh" content="0; url={to}">',
        f"<title>{esc(retired)} — Yurarium</title>", "</head>", "<body>",
        f'<p>This record is now <a href="{to}">{esc(surviving)}</a>.</p>',
        # The meta refresh serves a reader with no JavaScript; this is for everyone else and is
        # `replace` so the retired address does not sit in the history behind them.
        f'<script>location.replace("{to}");</script>',
        "</body>", "</html>", ""])


def forwarders(root, live, merged):
    """{relative path: html} for every retired identifier under `root` that still has somewhere to go.

    PULLED OUT OF `written` SO A SECOND KIND OF RECORD CAN HAVE IT. Retirement is the same operation
    for anything carrying a minted identifier, and a credit registry retires one for the same reason
    a work registry does: two records turned out to be one thing and an address published once has
    to keep resolving. `live` is the set of identifiers that have a page of their own.
    """
    out = {}
    for retired, surviving in sorted((merged or {}).items()):
        # Both ends checked: one builds a path and the other builds a URL inside it.
        if not SAFE_ID.match(str(retired)) or not SAFE_ID.match(str(surviving)):
            continue
        # A live id never gets a forwarder, and a chain is followed to whatever is live now: A into
        # B into C has to land on C rather than on a page that forwards again.
        if retired in live:
            continue
        seen, target = {retired}, str(surviving)
        while target not in live and target in (merged or {}) and target not in seen:
            seen.add(target)
            target = str(merged[target])
        if target in live:
            out[f"{root}/{retired}/index.html"] = forward(root, str(retired), target)
    return out


def written(root, works, merged=None, names=None):
    """{relative path: html} for every work with an identifier, and every id retired into one."""
    out = {}
    for w in works:
        wid = str(w.get("id") or "")
        # An id is minted by us and is [A-Za-z0-9], but a path is built from it, so it is checked
        # rather than trusted: a stray slash would write outside the tree.
        if not SAFE_ID.match(wid):
            continue
        out[f"{root}/{wid}/index.html"] = render(w, names=names)
    out.update(forwarders(root, {str(w.get("id") or "") for w in works}, merged))
    return out


def main(argv=None):
    """Write one stub per work into the site, and delete stubs whose work has gone."""
    import argparse, json

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--series", default="data/build/series.json")
    ap.add_argument("--site", required=True, help="the kari/ directory in the site repo")
    ap.add_argument("--root", default="work")
    # THE ENGLISH THE BUILD ALREADY DERIVED, read rather than composed. Without it a stub carries
    # its byline and its publisher in Japanese only, on every work in the corpus.
    ap.add_argument("--names", default="data/build/feed/names.json")
    a = ap.parse_args(argv)

    doc = json.loads(pathlib.Path(a.series).read_text())
    works = doc["series"]
    site = pathlib.Path(a.site)
    names_at = pathlib.Path(a.names)
    names = json.loads(names_at.read_text()) if names_at.exists() else {}
    files = written(a.root, works, doc.get("merged") or {}, names)
    for rel, body in files.items():
        p = site / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.exists() or p.read_text() != body:
            p.write_text(body)

    # Prune. A stub for a work that has left the corpus is a page asserting something withdrawn.
    keep = {str(site / rel) for rel in files}
    removed = 0
    base = site / a.root
    if base.exists():
        for p in sorted(base.glob("*/index.html")):
            if str(p) not in keep:
                p.unlink()
                try:
                    p.parent.rmdir()
                except OSError:
                    pass
                removed += 1
    fwd = sum(1 for rel in files if "This record is now" in files[rel])
    print(f"work stubs: {len(files) - fwd} written, {fwd} forwarding a retired id, "
          f"{removed} stale removed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
