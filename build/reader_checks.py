#!/usr/bin/env python3
"""What a reader is shown, checked where the rendering lives. STORE-PLAN §11.

WHY THESE MOVED. They read `kari/app.js`, `kari/app-status.js` and the pages a reader opens, and
they are about how this repository renders what the pipeline compiled. Left there, the pipeline
would have needed a path naming this one; here they sit beside the thing they are about.

THEY GATE HERE BEFORE THEY STOPPED GATING THERE, which is the one sequencing rule §11 states: a
check that changes repository is a check that can quietly not be adopted, and these include the ones
that caught `????·Bun?Bun` and Japanese leaking into English-only mode.

A CANARY OR IT IS NOT A CHECK. Every probe below plants the fault as it actually arrived, which is
STANDING-INSTRUCTIONS §14b: an invented bad value proves the loop runs and not that it would catch
what the pipeline really produces.

    ./build/reader_checks.py --store corpus.sqlite
"""
import argparse
import html as html_module
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
KARI = ROOT / "kari"
DATA = KARI / "data"
# WHERE THE PIPELINE'S RULES ARE, ASKED OF `build/rules.py`. This spelled the same default and the
# same environment variable, which is two producers of one answer; the suites in this directory
# were a third that got it wrong and could not import the harness at all.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rules                                                            # noqa: E402
ADAPTERS = rules.ADAPTERS

#: The pages a reader opens, which say things in their own voice rather than reporting the corpus.
READER_TEXT = [ROOT / "index.html", ROOT / "README.md",
               KARI / "index.html", KARI / "status.html"]

UNMEASURED = None


def context(store):
    """What the checks read: this site's own files, and the store they were built from."""
    rules.on_path()
    import sqlite3
    db = sqlite3.connect(f"file:{store}?mode=ro", uri=True)
    from relational import emit
    generated = dict(db.execute("SELECT key, value FROM store_stamp")).get("generated") or ""
    series = json.loads((DATA / "series.json").read_text(encoding="utf-8"))
    names = json.loads((DATA / "feed" / "names.json").read_text(encoding="utf-8"))
    releases = []
    for f in sorted((DATA / "feed").glob("*.json")):
        got = json.loads(f.read_text(encoding="utf-8"))
        releases += got.get("releases") or []
    return {
        "store": db,
        "series": series.get("series") or [],
        "releases": releases,
        "names_shipped": names,
        "index": json.loads((DATA / "index.json").read_text(encoding="utf-8")),
        "works": (json.loads((DATA / "works.json").read_text(encoding="utf-8")) or {}).get("works")
                 or [],
        "credits": list(((json.loads((DATA / "credits.json").read_text(encoding="utf-8")) or {})
                         .get("credits") or {}).values()),
        "publishers": list(((json.loads((DATA / "publishers.json").read_text(encoding="utf-8"))
                             or {}).get("publishers") or {}).values()),
        "status": json.loads((DATA / "status.json").read_text(encoding="utf-8"))
                  if (DATA / "status.json").exists() else {},
        "interface_js": (KARI / "app.js").read_text(encoding="utf-8"),
        "status_js": (KARI / "app-status.js").read_text(encoding="utf-8"),
        "reader_text": {p.name: p.read_text(encoding="utf-8") for p in READER_TEXT if p.exists()},
        "generated": generated,
        "_emit": emit,
    }


def _status_interface(ctx):
    """status.html's own script, loaded in a context of its own.

    A SECOND CONTEXT AND NOT A SECOND SCRIPT IN THE FIRST. `app-status.js` declares `esc`, `T`,
    `splitLang`, `SEP` and `render` at the top level and so does `app.js`, and a `const` redeclared
    in one context's global lexical scope is a SyntaxError. They are two pages and they get two
    contexts, which is also what a browser gives them.
    """
    import tempfile
    sys.path.insert(0, str(ADAPTERS))
    import interface
    if "_siface" not in ctx:
        src = ctx.get("status_js") or ""
        if not src:
            return None
        fh = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8")
        fh.write(src)
        fh.close()
        # No name map. This page states facts about the collection and draws no name through the
        # store; handing it one would suggest otherwise.
        ctx["_siface"] = interface.Interface(names={"titles": {}, "authors": {}, "phrases": {}},
                                             prefs={"LANG": "en"}, app_js=fh.name)
    return ctx["_siface"]



def inv_names_reach_a_page_only_through_their_renderer(ctx):
    """No field carrying a name is put on a page except by the function that renders that kind.

    THE HALF A RUNNING RENDERER CANNOT DO. Every leak this project has shipped was a call site that
    did not call the renderer: `esc(w.t)` from index.json on the catalogue tab, a volume row
    labelled from the bibliographic record's title, `credit()` glossing the bracket and leaving the
    name. None of those reaches a renderer, so running one finds none of them.

    So this reads `kari/app.js` and asserts a relation between two sets. The fields carrying a name
    are DERIVED from the built data by `adapters/interface.py`, not listed here, so one added by a
    later pass has to be ruled on. The entry points are named beside them. Every read of one of
    those fields must be inside its entry point, an argument to it, or an entry in
    `entrypoints.SAFE` that says which function, which field, what is done with the value, how many
    times, and why.

    AND IT NOW ASKS THE OTHER HALF OF THE QUESTION. A field the data carries Japanese in is ruled
    either by a surface or by `interface.NOT_DRAWN`, which says nothing puts it on a page. The
    second answer was asserted and never verified: a volume's `designation` was ruled that way on
    2026-08-12 and drawn by the same change with `esc`, so 383 works showed Japanese in English
    mode with both guards green. `entrypoints.undrawn_findings` reads the source for it.

    §14b, WHAT IT SHARES: `interface.SURFACES`, which is also what the check above renders through.
    That is the point rather than a cost. The two checks ask different questions of one table, and
    a table naming a field the interface does not render fails this one, while a table missing a
    field the DATA carries fails `every Japanese field the data carries has a ruling`.

    What it cannot see is a fault inside an entry point, which is what running the renderer is for.

    fallback: none. This reads a file in another repository and cannot degrade a build.
    """
    sys.path.insert(0, str(ADAPTERS / "lint"))
    src = ctx.get("interface_js")
    if not src:
        return []
    try:
        import entrypoints
    except Exception as e:                                                      # noqa: BLE001
        return [f"adapters/lint/entrypoints.py will not import ({e}), so nothing was checked"]
    return entrypoints.findings(src) + entrypoints.undrawn_findings(src)


def inv_no_stock_phrasing_in_public_text(ctx):
    """Public prose says things rather than performing them.

    Not a disguise: the project does not hide being AI-driven, and nothing here defeats a detector.
    These are constructions that waste a sentence, reach for an abstraction where a fact belongs,
    or add rhythm in place of content. The documentation ships so a third party can pick the
    project up, which makes it part of the deliverable rather than notes to ourselves.

    Only the HARD list and density are absolute. Words that are filler only in bulk are a budget.
    fallback: none needed. This reads files already written; it cannot degrade a build.
    """
    out = subprocess.run(
        [sys.executable, str(ADAPTERS / "lint" / "tics.py"), "--prose",
         *[str(f) for f in READER_TEXT if f.exists()]],
        capture_output=True, text=True, timeout=60)
    # Parse on the lint's own markers, not on an em dash: this line used to split on " — " and the
    # lint's output separator changed, which would have made the invariant silently vacuous.
    # Structural findings count too, or the check would report them and block nothing.
    bad = [l.split(" -> ")[0].strip() for l in out.stdout.splitlines() if " -> " in l]
    bad += [l.strip() for l in out.stdout.splitlines() if l.startswith("STRUCTURE:")]
    return bad


def inv_a_name_in_both_mode_is_rendered_in_both(ctx):
    """Every call to a one-language renderer in kari/app.js sits inside a 併記 wrapper.

    THE FAULT. `workLabel` and `authorLabel` answer in the reader's language and leave 併記 to
    `bilingual()`, which calls them once per language with LANG forced. Called directly with the
    toggle on 併記 they answer in Japanese and report nothing, so the work page heading, the 作品
    rows, the 発売 rows and the works list on a credit or a publisher page shipped with no English
    at all. Each of them was right in ja and right in en, which is why a reader found it before any
    check did.

    WHY THE RENDERER CHECKS ABOVE MISS IT. Those ask whether a name reaches a page through the
    function that renders it, and every one of these call sites does. What was wrong is how many
    times it was asked.

    §14b, WHAT THIS CANNOT SEE. It reads call sites and not output, so a renderer added to app.js
    and left out of `entrypoints.ONE_LANGUAGE` is invisible to it, and `creditText` composing a
    byline out of `personShown` is not covered today.

    fallback: none. This reads a file already written and cannot degrade a build.
    """
    sys.path.insert(0, str(ADAPTERS / "lint"))
    # THE SOURCE THE CONTEXT HOLDS, which is what the entry-point invariant above reads and what
    # the canary is planted in. Reading the file again here would give a check the probe cannot
    # reach, and a canary that lands somewhere the check does not look proves nothing (§4).
    src = ctx.get("interface_js")
    if not src:
        return []
    try:
        import entrypoints
    except Exception as e:                                                      # noqa: BLE001
        return [f"adapters/lint/entrypoints.py will not import, so nothing was checked: {e}"]
    return entrypoints.single_language_findings(src)


def inv_status_page_shows_no_japanese_of_its_own(ctx):
    """status.html in English says nothing in Japanese except the rows it is reporting on.

    THE PAGE FOR FACTS ABOUT US IS STILL A PAGE. §1 puts coverage and backlog here rather than in
    front of a reader, and nothing had ever asked it what it renders: `app-status.js` builds every
    sentence out of `T('日本語', 'English')` pairs, and a pair whose Japanese half contains a bare
    ` / ` loses its own numbers, which happened once and was fixed by hand.

    THE DATA IT REPORTS IS ANOTHER MATTER AND IS NOT EXCUSED, IT IS RULED. `outstanding[].rows[]`
    is the list of works with no English name; naming them in English is the thing that queue
    exists to do, so the Japanese in it is the subject rather than a failure to render. Those
    values are ruled in `interface.NOT_A_NAME` and are recognised HERE by being the values
    themselves, not by the check looking away from a region of the page.

    fallback: none. This reads a file in another repository and cannot degrade a build.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    iface = _status_interface(ctx)
    doc = ctx.get("status") or {}
    if not iface or not doc:
        return []
    sections = ["lastRun", "connectors", "outstanding", "stats", "gate"]
    try:
        shown = iface.labels([(fn, doc) for fn in sections])
    except interface.Unavailable as e:
        return [f"status.html could not be run, so nothing here was checked: {e}"]
    ruled = {str(v) for row in (doc.get("outstanding") or [])
             for v in (row.get("rows") or []) if isinstance(v, str)}
    ruled |= {str(b.get("means") or "") for b in ((doc.get("gate") or {}).get("budgets") or [])}
    bad = []
    for name, text in zip(sections, shown):
        for run in set(re.findall(r"[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+", text)):
            if any(run in v for v in ruled):
                continue
            bad.append(f"status.html:{name} shows {run} in English mode")
    return sorted(set(bad))


def budget_interface_tooltips_a_reader_of_japanese_cannot_read(ctx):
    """`title="…"` attributes in kari/app.js written in English whatever the language toggle says.

    THE SITE IS BILINGUAL AND ITS TOOLTIPS ARE NOT. 30 of the 32 in the file are English string
    literals: a Japanese reader who sets 日本語 gets a Japanese page whose explanations are all in
    English, and those explanations are where the interface accounts for itself. `有料先行` said
    `18 chapter(s) of this series sit ahead of the free line` to everyone.

    COUNTED RATHER THAN FIXED IN ONE GO, because each one needs Japanese somebody means, and thirty
    sentences invented at once would be thirty guesses. A budget makes each new tooltip pay for
    itself and lets the existing ones come down as they are written.

    §14b, WHAT IT REUSES: the shipped file's text, and `T(`/`L(` as the marks of a string that
    follows the toggle. It consults no list of which tooltips are done, so a tooltip cannot be
    counted as bilingual by being named somewhere.
    """
    src = (KARI / "app.js")
    if not src.exists():
        return UNMEASURED    # this could not be measured; see UNMEASURED
    text = src.read_text(encoding="utf-8")
    # A tooltip is bilingual when its value is built by the translation helpers. Anything else is
    # a literal, and a literal is one language.
    return sum(1 for m in re.finditer(r'title="([^"]*)"', text)
               if "${" not in m.group(1) or not re.search(r"\b[TL]\(", m.group(1)))





def _collections(ctx):
    """The built collections under the names `adapters/interface.py` rules them by.

    THE RECORD PAGES ARE HERE BECAUSE A READER CAN OPEN THEM. `credits.json` and `publishers.json`
    are fetched only when one of those 2,405 addresses is visited, so neither was in this list and
    neither was measured; `status.json` is a whole published page nothing walked. A surface nobody
    walks is a surface nobody measures, and the first walk of the credit pages found the homophone
    list writing a name into the markup without asking the renderer for it.
    """
    return {"index": ctx["index"], "series": ctx["series"], "works": ctx["works"],
            "releases": ctx["releases"],
            "credits": ctx["credits"], "publishers": ctx["publishers"],
            "status": [ctx["status"]] if ctx.get("status") else []}


# WHAT kari/app.js PUTS ON A NAME IT SPELLED ITSELF, in its two forms. `enFallback` appends the
# TOKEN, which travels as text so that a credit line can be composed by index and a chapter name
# can have a work name stripped off its front; `floorHtml` turns the token into the MARKUP that
# carries the tooltip, at the point the text becomes part of a page.
#
# Written once here because two checks below read one and a budget counts the other. §14b: these
# are a string and a class name, not a rule, and nothing in this file holds a copy of the decision
# about when the mark is warranted. A renderer that stopped marking its guesses would make these
# checks report clean, which is why `English mode has no Japanese` blocks on the Japanese itself
# and does not ask about a mark at all.
FLOOR_TOKEN = '[?]'
FLOOR_MARKUP = 'class="unc floor"'


def _role_vocabulary(ctx):
    """Every role string a credit field can state, from the splitter and from the corpus.

    BOTH, BECAUSE NEITHER IS THE WHOLE ANSWER. `inputs.ROLES` is what the splitter will recognise
    and so is what it can hand the interface tomorrow; the corpus is what it hands it today, and it
    states compounds that no list holds, because they are built rather than written down:
    `キャラクター原案・漫画` and `原作監修・文` are two roles joined by the field that wrote them.
    """
    sys.path.insert(0, str(ADAPTERS))
    from names import creditline, inputs
    fields = [str((r.get("c") or "")) for r in ctx["index"]]
    fields += [str((w.get("creator") or "")) for w in ctx["works"]]
    fields += [str((r.get("author") or "")) for r in ctx["series"]]
    fields += [str((r.get("author") or "")) for r in ctx["releases"]]
    stated = set(creditline.roles_stated([f for f in fields if f]))
    stated |= {r for e in ctx["credits"]
               for w in (e.get("works") or []) for r in (w.get("roles") or [])}
    return sorted(stated | set(inputs.ROLES) | set(inputs.BRACKET_ROLES))


def _interface(ctx):
    """The interface, loaded once for this run and holding the names the browser would fetch.

    Built from `ctx` rather than from the files, so a canary planted in the context reaches the
    renderer like any other row (§14b). Kept on the context so several checks share one load.
    """
    import tempfile
    sys.path.insert(0, str(ADAPTERS))
    import interface
    if "_iface" not in ctx:
        # RUN THE SOURCE THE CONTEXT HOLDS, not the file on disk. `interface_js` is loaded in
        # `context()` for the reason everything else is: a check that opens its own file cannot be
        # shown a canary, and self_test plants one in this string to prove the fold comparison can
        # fail. Written out because node loads a path.
        src = ctx.get("interface_js") or ""
        path = None
        if src:
            fh = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8")
            fh.write(src)
            fh.close()
            path = fh.name
        ctx["_iface_path"] = path
        ctx["_iface"] = interface.Interface(names=ctx["names_shipped"] or {}, prefs={"LANG": "en"},
                                            app_js=path)
    return ctx["_iface"]



def inv_a_link_goes_where_its_label_says(ctx):
    """A row's platform name and the address behind it name the same platform.

    WHAT THIS CAUGHT. On the "coming soon" view five rows read `KADOKOMI` and linked to
    manga.nicovideo.jp, with a tooltip agreeing with the label and not with the link, and `· also
    on KADOKOMI` beside it. A reader clicking the name of one company opened another's site. Seven
    works are in the state that produced it: `stated_next.platform` names カドコミ while the row's
    headline `url` is the Niconico address, and `predictedRows` took the name from one and the
    address from the other.

    NEITHER FIELD IS WRONG ON ITS OWN, which is why nothing had caught it. The rule is about the
    PAIR, and a check that asked either half would pass. The data even held both addresses: those
    works carry a カドコミ source with its own comic-walker URL beside the Niconico one.

    ASKED OF THE RENDERER'S OWN OUTPUT, §14b. It sets `SERIES` and calls `predictedRows`, which is
    the function that builds the view, so there is no model here of what the view would do. What
    decides the answer is the work's own source list: where a row names a platform the work has an
    address for, the row's address has to be that one.

    fallback: none. A link that goes somewhere else is worse than no link.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    rows = ctx.get("series") or []
    if not rows:
        return ["no work rows were collected, so nothing here was checked"]
    try:
        iface = interface.Interface(names=ctx["names_shipped"] or {},
                                    # THE SHAPE app.js HOLDS, which is the document rather than
                                    # its array: `predictedRows` walks `SERIES.series`.
                                    prefs={"LANG": "en", "SERIES": {"series": rows}},
                                    app_js=ctx.get("_iface_path"))
        got = iface.values([("predictedRows", None)])
    except interface.Unavailable as e:
        return [f"the interface could not be run, so nothing here was checked: {e}"]
    predicted = got[0] if got else []
    if not isinstance(predicted, list):
        return ["predictedRows answered something this cannot read"]
    # WHERE EACH WORK REALLY IS, from the rows the view was built from.
    where = {}
    for r in rows:
        for s in (r.get("sources") or []):
            if s.get("platform") and s.get("url"):
                where.setdefault(r.get("id"), {}).setdefault(s["platform"], s["url"])
    bad = []
    for row in predicted or []:
        if not isinstance(row, dict):
            continue
        name, url, wid = row.get("plat_name"), row.get("url"), row.get("wid")
        held = (where.get(wid) or {}).get(name)
        if name and url and held and url != held:
            bad.append(f"{wid}: the row says {name} and links to {url}, "
                       f"where {name} is {held}")
        # AND IT MAY NOT SAY A WORK IS ALSO ON THE PLATFORM IT IS ALREADY SHOWING.
        if name and name in (row.get("also_on") or []):
            bad.append(f"{wid}: shown on {name} and said to be also on {name}")
    return bad


def inv_english_mode_has_no_japanese(ctx):
    """English-only mode shows no kana and no kanji, asked of the interface rather than modelled.

    WHAT THIS USED TO BE, AND WHY IT WENT GREEN OVER A VISIBLE FAULT. It held a `fold`, a `render`
    reimplementing the name lookup and a `joins` guessing at app.js's fallback order, and the guess
    was generous: it tried the title with its subtitle stripped and with the separator turned into
    a space, and app.js tries neither. So
    `シャドウ・アサシンズ・ワールド : 影は薄いけど、最強忍者やってます` was on the 発売 tab in
    English mode with this check reporting nothing, which is the third drift of the same shape in
    one day (STANDING-INSTRUCTIONS §3).

    It now loads `kari/app.js` and calls the file's own label functions over every row of every
    surface `adapters/interface.py` rules. There is no model of the renderer left to be wrong.

    KANA AND KANJI, WHICH IS NARROWER THAN THIS USED TO ASK, and the narrowing is a finding rather
    than a relaxation. The old test also failed a full-width character, and running the real
    renderer showed why that is wrong: `2×2＝SHINOBUDEN+` is the work's OWN English name, published
    with a full-width ＝, and the interface renders `en_forms` where the transcription read `en`,
    an ASCII-folded copy. A reader in English meets the title the work publishes. What they must
    not meet is a script they cannot read. `full-width forms in English renderings` counts the rest
    so the narrowing is a number rather than a silence.

    EVERY SURFACE, WHICH IT DID NOT USED TO BE, AND THIS IS WHY IT PASSED WHILE A BUDGET COUNTED
    77. `Surface.holds_at_zero` split the table in two and this check read one half: the titles and
    the chapter names, where Japanese was called a fault. The other half was the credit lines, the
    people and the publishing lines, where Japanese was called a coverage deficit, and
    `renderings still Japanese in English mode` counted those and ratcheted. So the two checks
    partitioned the surfaces between them and neither could ever see what the other measured. This
    one was not passing over a fault it could see. It was reading eleven surfaces of twenty-one.

    THE OWNER OVERRULED THE SPLIT. An unclear romanisation with an explanatory tooltip is required
    wherever the alternative is Japanese under an English heading, so there is no surface left
    where Japanese is a finished state. The flag is gone from `adapters/interface.py`, the budget
    is gone from the list below, and this reads the whole table.

    §14b, WHAT THIS CANNOT SEE. A call site that never calls the renderer. Running the interface
    proves that what reaches it comes out right, and says nothing about `esc(w.t)` written beside
    it, which is how 2,430 rows shipped Japanese once already. `adapters/lint/entrypoints.py` is
    the other half and `names reach a page only through their renderer` is where it blocks.

    fallback: `enFallback` in kari/app.js, which spells the name from `feed/names.json`'s floor and
    marks it. A violation here means that fallback did not run, which is a fault in the renderer
    and not a name nobody has looked up.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    try:
        iface = _interface(ctx)
        calls, about = interface.calls_for(_collections(ctx))
        if not calls:
            return []
        out = iface.labels(calls)
    except interface.Unavailable as e:
        # A check that could not run has not passed. Reported rather than skipped, because a
        # renderer nobody ran answers "no Japanese anywhere" for exactly the same reason a clean
        # page does (§4).
        return [f"the interface could not be run, so nothing here was checked: {e}"]
    bad = []
    for (surface, value), shown in zip(about, out):
        if interface.KANA_KANJI.search(value) and interface.KANA_KANJI.search(shown):
            bad.append(f"{surface.path}:{value[:32]}")
    return sorted(set(bad))



def budget_renderings_resting_on_a_mechanical_romanisation(ctx):
    """Renderings the interface spelled itself because no source states how the name is read.

    WHAT THIS REPLACES. `renderings still Japanese in English mode` counted 77 rows that reached an
    English page as kana or kanji, and its docstring said a name the store cannot render shows as
    the Japanese and that this is a finished state. The owner overruled that: a marked romanisation
    with a tooltip is REQUIRED where the alternative is Japanese. So the count of Japanese rows is
    an invariant at zero and this is what is left, which is the number of names carrying our guess
    instead of somebody's reading.

    IT FALLS ONLY WHEN A NAME IS RESEARCHED and nothing about the renderer can move it. A record
    with a sourced reading is spelled from the reading and never reaches the floor; a record with
    no reading at all reaches it every time. That makes this the data gap stated as a number, and
    the one measure a later naming pass should be aimed at.

    A COMMUNITY DATABASE'S READING IS COUNTED HERE, from the project owner's correction of
    2026-08-09: "I mistyped 'without overcoming their fallback basis'". Wikidata raises the floor on
    the string and leaves the record resting on a fallback, so a name spelled off its kana is a name
    an English page spelled for itself and belongs in this number. 44 before, 628 after, and the
    rise is the correction working rather than anything getting worse. `uncertainMark` in
    kari/app.js is what emits the class for them, beside `floorHtml`, and the tooltip stays the one
    naming the database.

    WHAT IT STILL DOES NOT COUNT, said here because a measure that catches the stronger case and
    misses the weaker one is worth nobody's trust (§14b). 1,914 renderings carry `unc` without
    `floor`: a reading a morphological analyser produced, or one assembled character by character.
    Those rest on less than a Wikidata edit does, and whether the class should widen to take them is
    a ruling nobody has made. `author readings no source states` counts the RECORDS behind them,
    which is why the population is not invisible in the meantime.

    MEASURED FROM THE MARKUP THE INTERFACE PRODUCES, so it counts what a reader is actually shown.
    §14b, WHAT IT SHARES: one CSS class name, `unc floor`, which kari/app.js emits from a single
    constant. That is the whole of the coupling. Nothing here holds a copy of the rule deciding when
    the mark is warranted, so a renderer that stopped marking a guess would show up as this falling
    to zero rather than as this agreeing with it.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    try:
        calls, _about = interface.calls_for(_collections(ctx))
        if not calls:
            return 0
        out = _interface(ctx).values(calls)
    except interface.Unavailable:
        return UNMEASURED    # this could not be measured; see UNMEASURED
    return sum(html.count(FLOOR_MARKUP) for html in out)


def budget_full_width_forms_in_english_renderings(ctx):
    """English renderings that still hold a full-width character, having no kana and no kanji.

    WHY THIS IS SEPARATE FROM THE INVARIANT. `English mode has no Japanese` used to fail a
    full-width character as well as a script, and running the real renderer showed that rule
    catching the work's own name: `2×2＝SHINOBUDEN+` is published with a full-width ＝ and the
    interface renders `en_forms`, where the transcription had read `en`, an ASCII-folded copy of
    it. Blocking there would ask a reader to be shown a title the work does not use.

    So the invariant narrowed to kana and kanji, and this counts what the narrowing let past, which
    is what stops a narrowing from being a silence (§13).

    308 OF THEM WERE A CATALOGUER'S TYPING AND ARE GONE. `Ｍａｇｐｉｅ`, `ｆｉｎｉｔｅ` and
    `Ｈｏｕｒａｉ　Ｄｏｌｌ` are Latin pen names typed full width, and the store holds nothing for
    them because a Latin pen name is not a transliteration of anything; the surface reached an
    English page with its width intact. `plainLatin` in kari/app.js folds a name holding no kana
    and no kanji, which is NFKC and not a reading. What is left is mostly a TITLE published with a
    full-width mark, `2×2＝SHINOBUDEN+` being the recorded one, and those are correct.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    fw = re.compile(r"[！-｠￠-￮　]")
    try:
        calls, about = interface.calls_for(_collections(ctx))
        if not calls:
            return 0
        out = _interface(ctx).labels(calls)
    except interface.Unavailable:
        return UNMEASURED    # this could not be measured; see UNMEASURED
    return sum(1 for (_s, _v), shown in zip(about, out)
               if fw.search(shown) and not interface.KANA_KANJI.search(shown))



def inv_every_renderer_is_ruled(ctx):
    """Every function that returns rendered name text is a surface or is argued not to be.

    THE FAULT THIS IS FOR. `interface.SURFACES` is hand-written and `creditLine` was missing from it.
    The work page called it, it cut the byline on a slash and passed the pieces on as a field the
    build had never seen, and 安田剛助・文尾文 reached a reader as `???? · Bun?Bun` while every probe
    over the table reported zero. A table of what reaches a reader cannot be what decides it.

    DERIVED FROM THE SOURCE, seeded with the floor primitives and with whatever the table already
    names, so the derived set is a superset of the table by construction and the answer here is what
    it holds that the table does not. `NOT_A_SURFACE` is where an orchestrator goes, with a reason.

    §14b, WHAT IT SHARES WITH ITS SUBJECT: it reads `app.js` as text and asks nothing of the table
    except which names are in it. Its blind spot is a renderer written as an arrow function or a
    method, stated in interface.renderers, which is why the exemptions carry reasons and not names.
    """
    # A CHECK THAT CANNOT READ ITS SUBJECT SAYS SO, §4. This swallowed every exception and returned
    # clean, and `interface.APP_JS` is resolved from `YURARIUM_SITE`, which no workflow set: in CI
    # the file it derives the renderer set from did not exist, `renderers()` raised
    # FileNotFoundError, and this printed `ok every renderer is ruled` on every published build.
    # `workLabelText` had been unruled since READER-PLAN item 8 and nothing said a word.
    sys.path.insert(0, str(ADAPTERS))
    try:
        import interface as _iface
        got = _iface.unruled_renderers()
    except Exception as why:                                            # noqa: BLE001
        return [f"the interface could not be read, so nothing was asked: "
                f"{why.__class__.__name__}: {why}"]
    return [f"{n} returns rendered name text and is in neither SURFACES nor NOT_A_SURFACE"
            for n in got]


def inv_interface_folds_a_name_key_as_the_build_does(ctx):
    """The browser's fold and the build's fold, run against each other on the corpus.

    WHY THERE ARE TWO COPIES AT ALL. `data/build/feed/names.json` is keyed on the FOLDED Japanese
    string and on nothing else, so the browser has to fold a row's title the same way to find its
    rendering. `adapters/names/key.fold` is the definition and `foldKey` in `kari/app.js` is the
    same two operations in JavaScript, which cannot import it.

    WHAT A DISAGREEMENT COSTS. Not a degraded lookup: a lost one. Unlike the publisher map, which
    is keyed by the raw catalogued string as well as the normalised one so either answer finds the
    record, the title map holds the folded key alone. A browser folding differently renders
    Japanese on a work whose English this project holds, and the page says nothing about why.

    THIS USED TO READ THE SOURCE AND ASK FOR THE TWO OPERATIONS BY NAME, and said so: it could not
    run the JavaScript, so it could not see a disagreement the two implementations would only
    reveal on a particular string. It runs the JavaScript now. Every title, author and chapter name
    the corpus holds is folded both ways and the two answers are compared, so the check is over the
    strings this project actually has rather than over a regular expression matching a function
    body.

    §14b: the corpus is the input to both sides, and neither fold produced it, so this can fail on
    anything the build is able to emit. What it cannot see is a string neither collection carries.

    fallback: none. A key is either the same key on both sides or the map stops answering.
    """
    sys.path.insert(0, str(ADAPTERS))
    sys.path.insert(0, str(ADAPTERS / "names"))
    import interface
    try:
        import key as _key
    except Exception as why:                                                    # noqa: BLE001
        # THE SAME RULE AS ABOVE, §4. A missing fold is a check that asked nothing, not a check
        # with nothing to report.
        return [f"the build's fold could not be imported, so nothing was compared: "
                f"{why.__class__.__name__}: {why}"]
    strings = sorted({s for r in list(ctx["series"]) + list(ctx["releases"])
                      for s in (r.get("work"), (r.get("author") or "").strip(), r.get("ep"),
                                r.get("collection"), r.get("latest_ep"))
                      if s and isinstance(s, str)})
    if not strings:
        return []
    try:
        theirs = _interface(ctx).values([("foldKey", s) for s in strings])
    except interface.Unavailable as e:
        return [f"the interface could not be run, so the two folds were not compared: {e}"]
    return [f"{s[:28]}: app.js folds it {a!r} and adapters/names/key.fold folds it {b!r}"
            for s, a, b in zip(strings, theirs, (_key.fold(s) for s in strings)) if a != b]


def budget_imprint_names_the_interface_disagrees_with(ctx):
    """Imprint strings the browser renders as one name and the shipped map calls another.

    THE SECOND PRODUCER, COUNTED WHILE IT LASTS. `imprintOf` in app.js decides which imprint a
    string names and `data/names/imprints.yaml` decides the same thing with a registry behind it.
    Both now read the map the build ships, so the two stopped having separate opinions, and this
    number went to zero by the disagreement ending rather than by anybody hiding it.

    IT IS MEASURED BY RUNNING `imprintOf`, not by a copy of it. This file used to hold
    `_app_imprint_of`, a transcription kept so the two could be compared, which is a comparison
    between the map and a Python function claiming to be the browser. It is now the browser.

    Counted on distinct pairs so that one wrong name does not read as hundreds.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    shipped = (ctx["names_shipped"] or {}).get("imprints") or {}
    raw = sorted({str(pr.get("imprint") or "").strip()
                  for r in ctx["series"] for pr in (r.get("print") or [])
                  if str(pr.get("imprint") or "").strip() in shipped})
    if not raw:
        return 0
    try:
        shown = _interface(ctx).labels([("imprintOf", s) for s in raw])
    except interface.Unavailable:
        return UNMEASURED    # this could not be measured; see UNMEASURED
    return len({(got, shipped[s]["name"]) for s, got in zip(raw, shown)
                if got != shipped[s]["name"]})



def inv_every_credit_role_has_an_english_gloss(ctx):
    """Every job a credit can state comes out of the interface in English.

    WHY THIS IS AN INVARIANT AND NOT A COUNT. A role is a closed vocabulary somebody wrote down, so
    a role with no gloss is a missing table entry and not a name nobody has researched. That is the
    difference between this and `renderings resting on a mechanical romanisation`, which counts
    the names an English page spells for itself and falls only as readings are researched.

    236 catalogue credit lines were in Japanese under an English heading and the largest single
    cause was this: `ROLE_EN` in kari/app.js held six words and a second table further down the
    same file held twenty more, so キャラクターデザイン was English on a credit page and Japanese on
    the catalogue tab. Neither knew about 校正, 編纂, カバーイラスト or ほか著.

    §14b, WHAT IT SHARES AND WHAT IT THEREFORE CANNOT SEE. The vocabulary comes from the PYTHON
    splitter and from the corpus; the gloss comes from the JavaScript table. Nothing produces both,
    so the two can disagree and this is where they do. What it cannot see is a role the splitter
    fails to recognise at all, which is not a gloss problem: that role never becomes a role, and it
    shows up as notation surviving into a rendering, which the check below is for.

    §14b, AND THIS CHECK ALMOST LOST ITS SIGHT. It used to look for kana or kanji in what
    `roleWord` returned, and `roleWord` now floors a role it cannot gloss, so a table that had lost
    an entry came back `Cho` and this reported clean. The subject had grown a fallback the measure
    was blind to, which is the shape §14b is about. It reads the MARK instead: the floor puts
    `unc floor` on anything it spelled, and a role carrying that mark is a role with no gloss
    whatever it looks like. Japanese is still a violation too, because a renderer that stopped
    flooring should not read as a pass.

    fallback: the role is spelled from the floor and marked, which is Latin and visibly a guess.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    roles = _role_vocabulary(ctx)
    if not roles:
        return ["no role vocabulary was collected, so nothing here was checked"]
    try:
        shown = _interface(ctx).values([("roleWord", r) for r in roles])
    except interface.Unavailable as e:
        return [f"the interface could not be run, so nothing here was checked: {e}"]
    return [f"{r} has no English gloss in kari/app.js"
            for r, out in zip(roles, shown)
            if FLOOR_TOKEN in out or interface.KANA_KANJI.search(out)]


def inv_a_byline_never_states_the_default_role(ctx):
    """A byline names people and the jobs that distinguish them, and never the unmarked author.

    THE OWNER'S RULING. `著`, `著者`, `作` and no role at all are one concept, and `[著]中村明日美子`
    and `中村明日美子` are the same fact written two ways. A reader meeting `Nakamura Asumiko
    (author)` on one row and `Nakamura Asumiko` on the next would be reading a distinction the
    catalogue never made, so the word may not appear on a byline at all.

    AND IT MUST STILL APPEAR ON A CREDIT PAGE, which is why this is an invariant over the OUTPUT
    rather than an entry removed from the gloss table. That page lists a person's works with the job
    beside each, the job is the payload, and eliding it leaves an empty cell. Surfaces of category
    `role` are therefore not scanned; they are the page where the word belongs.

    §14b, WHAT IT SHARES. The words it forbids come from asking the interface which roles elide,
    which is `bylineRole` answering about itself, so a table that stopped eliding would also stop
    forbidding. What it cannot share is where those words then turn up: the scan is over the
    rendered person surfaces, and the renderer that draws them consults no list of forbidden words.
    A role glossed on a byline through any path at all shows here.

    fallback: none. A role is a closed vocabulary somebody wrote down, so this holds at zero.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    roles = _role_vocabulary(ctx)
    if not roles:
        return ["no role vocabulary was collected, so nothing here was checked"]
    try:
        iface = _interface(ctx)
        byline = iface.labels([("bylineRole", r) for r in roles])
        page = iface.labels([("roleWord", r) for r in roles])
    except interface.Unavailable as e:
        return [f"the interface could not be run, so nothing here was checked: {e}"]
    # The English a role has on a credit page and does not have on a byline. Empty for every role
    # that is not the default, which is what leaves this scanning for three or four words.
    gone = sorted({p.strip() for r, b, p in zip(roles, byline, page)
                   if p.strip() and not b.strip()}, key=len, reverse=True)
    if not gone:
        return []
    calls, about = interface.calls_for(_collections(ctx))
    if not calls:
        return []
    bad = []
    for (surface, value), shown in zip(about, iface.labels(calls)):
        if surface.category != "person":
            continue
        for word in gone:
            if re.search(r"(?:^|[\s\[\](){}（）/,·、]|\b)" + re.escape(word) + r"(?:$|[\s\[\](){}（）/,·、]|\b)",
                         shown):
                bad.append(f"{surface.path}: {value!r} renders as {shown!r}, "
                           f"which states the default role {word!r}")
                break
    return sorted(set(bad))


def inv_no_name_is_spelled_with_question_marks(ctx):
    """No name a reader meets in English holds a question mark the field it came from did not.

    THE FAULT, WHICH REACHED A READER. `enFallback` spells a Japanese run it cannot look up one
    character at a time, and a character nothing can read becomes `?`. The work page's byline for
    w01700 came out `???? · Bun?Bun` where the field says 安田剛助・文尾文, two artists whose
    readings openBD and the publisher both state. Neither name was missing from anything: the
    corpus had settled that field as two people, the build had shipped the division and floored the
    two of them separately, and `creditLine` threw the division away by cutting the field on the
    slash and passing the pieces on as a field of their own.

    ARITHMETIC ON THE RENDERED RESULT, per §14b. It counts question marks in the answer against
    question marks in the question, so it consults no store, no division and nothing in
    `enFallback`, and it fails on anything the interface is able to draw. The floor's own `[?]`,
    which says a spelling is ours, is taken off before counting: it is a mark on a name rather than
    a character nothing could read, and this must not read one as the other.

    NAMES AND ROLES, WHICH IS WHERE A QUESTION MARK IS NEVER PUNCTUATION. A TITLE may gain one
    honestly, because a translation is not a transliteration and 月が綺麗ですね is published as
    `The Moon Is Beautiful, Isn't It?`; 21 titles are in that state and every one of them is a
    translator's sentence. Nobody is called `?`, so the surfaces this walks are the ones whose
    values are people, houses and the jobs they did.

    WHY IT IS AN INVARIANT AND NOT A BUDGET. A `?` in place of a name is not a deficit that shrinks
    as readings are sourced. It says the renderer was handed a string the build never floored,
    which is a fault in the renderer every time.

    §14b, what it cannot see: a name spelled wrongly but spellably. `Yasuda Takesuke` for
    ヤスダ コウスケ holds no question mark, and `a person is spelled one way` is the check for that.

    fallback: none in the build. `enFallback` already IS the fallback, and a violation says it ran
    out of map rather than that a name is unresearched.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    try:
        calls, about = interface.calls_for(_collections(ctx))
        if not calls:
            return []
        out = _interface(ctx).labels(calls)
    except interface.Unavailable as e:
        return [f"the interface could not be run, so nothing here was checked: {e}"]

    def marks(text):
        return str(text).replace(FLOOR_TOKEN, "").count("?") + str(text).count("？")

    bad = []
    for (surface, value), shown in zip(about, out):
        if surface.category in ("person", "publisher", "role") and marks(shown) > marks(value):
            bad.append(f"{surface.path}:{value[:32]} renders as {shown[:48]}")
    return sorted(set(bad))



def budget_publisher_keys_the_interface_misses(ctx):
    """Publisher, distributor and imprint names the browser still shows in Japanese.

    THE FAULT THIS FOUND, and it had been invisible to every measure in the file.
    `GP-KIDS/高菜しんの` is catalogued in the publisher field AND the imprint field, and the two
    normalise differently, so whichever field was read first decided what the shown name was, the
    other field's name never entered the map, and the interface asked for a key nothing held.

    HOW IT USED TO ASK, AND WHY THAT WENT. It held `_app_publisher_of` and `_app_imprint_of`, this
    file's transcriptions of the browser's normalisers, kept deliberately as a third copy so a
    drift between the interface and the pipeline would show up as a disagreement. The copy went
    stale the way §3 says a copy does: `publisherOf` no longer exists in `kari/app.js` at all, the
    cataloguing having moved upstream into `adapters/madb/extract.py`, and this file was still
    stripping brackets on the browser's behalf.

    So it asks the browser. `pubBoth` and `imprintOf` are called through
    `adapters/interface.py`, on the strings the corpus holds, and what comes back Japanese is what
    a reader sees in Japanese. There is nothing left here to drift.

    Japanese only. A name already in Latin passes through the interface untouched and needs no
    entry, which is the same rule `platName` follows.

    THE IMPRINT MAP IS PASSED IN, and for one round it was not. `imprintOf` stopped segmenting and
    started returning the registry's canonical name for the line, this copy followed it, and the
    caller went on invoking it with no map. So the copy of the consumer resolved every imprint
    string to itself, which is what the OLD interface did, and the measure quietly went on
    answering the previous question: it read 5 while 11 canonical line names reached a reader in
    Japanese and 4 catalogued strings it was counting had stopped being shown at all. A copy of the
    consumer has to be called the way the consumer is called (STANDING-INSTRUCTIONS §14b).
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    if (ctx["names_shipped"] or {}).get("publishers") is None:
        return 0
    raw = {}
    for r in ctx["series"]:
        for pr in (r.get("print") or []):
            for field, fn in (("publisher", "pubBoth"), ("distributor", "pubBoth"),
                              ("imprint", "imprintOf")):
                s = str(pr.get(field) or "").strip()
                if s and interface.KANA_KANJI.search(s):
                    raw[(fn, s)] = True
    if not raw:
        return 0
    keys = sorted(raw)
    try:
        # `imprintOf` answers with the LINE, which is then shown like any other publisher name, so
        # the two-step is what a reader meets and asking only the first step would count a line
        # resolved as a line rendered.
        shown = _interface(ctx).labels([(fn, s) for fn, s in keys])
        second = _interface(ctx).labels([("pubBoth", v) for v in shown])
    except interface.Unavailable:
        return UNMEASURED    # this could not be measured; see UNMEASURED
    return len({v for v in second if interface.KANA_KANJI.search(v)})


def budget_bylines_drawn_in_a_spelling_the_field_does_not_write(ctx):
    """Work rows whose byline reaches a reader spelt differently from the credit field itself.

    THE FAULT, AND IT HAS BEEN SHIPPED TWICE. `credit_parts` spells each person the way the name
    store is keyed on them and a credit field spells them the way its cataloguer typed them, so
    `山本 和音` is 山本和音 in the division and `sono.N` is ｓｏｎｏ．Ｎ. `linkedCredits` located
    names with `indexOf` on the field, missed all 38 of those, and drew their work pages with no
    address on any name. The patch that fixed the address by searching the FOLD then handed the
    division's spelling to `creditChip`, so 35 Japanese bylines came back with the artist's name
    rewritten underneath their work. Both are one fault: the string that addresses a record and the
    string a reader sees are not the same string.

    MEASURED WITH FURIGANA ON, because that is where the last of them live. `ruby` draws the spans
    a record carries, and a record carries the store's spelling of the name, so the space in
    永田　さんずい reached a field that says 永田さんずい. A chip covering the whole field takes the
    row's own `author_en`, whose spans are aligned to what that row writes, which is what carried
    this from 70 to 23.

    §14b, WHAT IT SHARES WITH ITS SUBJECT: the shape of a ruby element, because the reading has to
    come off before the surface can be compared. Nothing else. The comparison is against
    `series[].author` as the data holds it, which no part of the renderer consults, so a walk that
    starts rewriting names shows up here as a rise rather than as agreement. Run against the patch
    that was reverted it reads 92.

    A budget. The residue is the parts of a MULTI-person field, which have no `author_en` of their
    own and take the store's record, spelling and all. It reaches zero when a part carries the
    alignment the whole field already has.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    rows = [r for r in ctx["series"] if str(r.get("author") or "").strip()]
    if not rows:
        return 0
    try:
        drawn = _interface(ctx).with_prefs(LANG="ja", FURIGANA=True).values(
            [("linkedCredits", r) for r in rows])
    except interface.Unavailable:
        return UNMEASURED    # this could not be measured; see UNMEASURED
    bad = 0
    for row, markup in zip(rows, drawn):
        # The reading comes off and the surface stays: `<ruby>永田<rt>ながた</rt></ruby>` is the
        # name 永田 annotated, and the annotation is not part of the spelling.
        surface = re.sub(r"<rt[^>]*>.*?</rt>", "", markup)
        surface = html_module.unescape(re.sub(r"<[^>]*>", "", surface))
        if surface != str(row.get("author") or "").strip():
            bad += 1
    return bad




def _notation_left(ctx):
    """`[(surface, value, the notation that survived)]` over every rendering.

    THE OUTPUT MEASURED AGAINST A VOCABULARY THE RENDERER NEVER CONSULTED (§14b). The roles come
    from the Python splitter and the words below are the ones the splitter drops; kari/app.js has
    its own table and its own division, and neither of them is asked here. A role the interface
    glosses cannot appear in the output, so anything that does is a role the DIVISION did not find
    or a gloss that did not reach the page, and those are exactly the two ways this class comes
    back.

    AND NOW A ROLE WITH NO GLOSS IS NOT JAPANESE ON THE PAGE, IT IS A ROMANISATION OF IT. Dropping
    `著` from the table used to leave `[著]` standing in an English credit line, which is what this
    scanned for. It now leaves `[Cho]`, which is the same fault wearing Latin letters, and a scan
    for the Japanese word would report clean. So each role is put through `roleWord` first and the
    ones the renderer FLOORED are added to the vocabulary under the spelling it gave them. The
    vocabulary still comes from the splitter; what the interface supplies is how each word looks
    once it has failed to be glossed.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    roles = [r for r in _role_vocabulary(ctx) if interface.KANA_KANJI.search(r)]
    # `ほか` closes a credit that names some of its contributors; the interface says "and others".
    # Neither is a name, and a reader in English has no way to read either as one.
    words = set(roles) | {"ほか"}
    if roles:
        # `roleWord` ANSWERS WITH TEXT AND NOT WITH MARKUP, which is why the token is what is
        # read here. The gloss goes into a credit line that is escaped and marked later, so at this
        # point a floored role is the spelling followed by the token and nothing else.
        for out in _interface(ctx).labels([("roleWord", r) for r in roles]):
            if FLOOR_TOKEN in out and out.strip():
                words.add(out.strip())
    words = sorted(words, key=len, reverse=True)
    calls, about = interface.calls_for(_collections(ctx))
    if not calls:
        return []
    out = _interface(ctx).labels(calls)
    bad = []
    for (surface, value), shown in zip(about, out):
        if surface.category not in ("person", "role"):
            continue
        for word in words:
            # DELIMITED, because a role word is also an ordinary word and pen names are built out
            # of ordinary words. 文 sits inside 文尾文 and 作 inside 佐喜ハジメ's neighbours; what
            # makes an occurrence notation is that a bracket or a separator stands either side.
            if re.search(r"(?:^|[\s\u3000\[\](){}（）〔〕【】/／、,，・･&＆:：])"
                         + re.escape(word)
                         + r"(?:$|[\s\u3000\[\](){}（）〔〕【】/／、,，・･&＆:：])", shown):
                bad.append((surface, value, word))
                break
    return bad


def inv_no_cataloguing_notation_in_an_english_rendering(ctx):
    """A credit line in English holds names and nothing else the catalogue wrote around them.

    WHAT THIS BLOCKS THAT A BUDGET TOLERATED. `renderings still Japanese in English mode` counted
    a row as one number whatever was Japanese about it, so a role nobody glossed and a pen name
    nobody has researched were the same event. They are not: a pen name nobody has researched now
    gets a mechanical romanisation, which is a guess about a sound, and `[キャラクターデザイン]`,
    `(校正)`, `ほか` and a reading printed beside the name it reads are none of them names at all.
    Those are the catalogue's notation, they have a right answer, and once the answer exists
    nothing should be able to lose it quietly.

    So the guarantee splits. This holds at zero on the notation;
    `renderings resting on a mechanical romanisation` counts the guesses at the names.

    fallback: the notation shows as the catalogue wrote it, which is what it did before.
    """
    sys.path.insert(0, str(ADAPTERS))
    import interface
    try:
        return sorted({f"{s.path}:{v[:32]} still shows {w}" for s, v, w in _notation_left(ctx)})
    except interface.Unavailable as e:
        return [f"the interface could not be run, so nothing here was checked: {e}"]








def inv_the_interface_is_the_derivation_of_its_source(ctx):
    """`kari/app.js` is what `kari/src` concatenates to.

    THE PROPERTY A BUNDLE WOULD HAVE COST US. The checks run the real `app.js` in a Node vm, so
    what is verified is what ships. Splitting the file into modules keeps that only if the shipped
    file is exactly the modules, and this is what says so.

    IT IS THE SHAPE `deployed data matches built` ALREADY HAS. A derived artefact and its inputs,
    compared by content, with the answer being that one is stale.

    Section 14b: it re-derives from the source files and compares bytes. It shares nothing with the
    builder except the concatenation order, which is filename order and stated in kari/src/BUILD.md.
    """
    src = KARI / "src"
    out = KARI / "app.js"
    if not src.is_dir() or not out.exists():
        return []
    want = "".join(p.read_text(encoding="utf-8") for p in sorted(src.glob("*.js")))
    if want == out.read_text(encoding="utf-8"):
        return []
    return ["kari/app.js is not the derivation of kari/src; run ./build-app.py"]




def budget_interface_reads_outside_an_entry_point(ctx):
    """Reads of a name field in kari/app.js that are excepted rather than going through a renderer.

    THE EXCEPTIONS, COUNTED. `entrypoints.SAFE` lets a call site read a name field without
    rendering it, because some of them must: a comparator sorts on the Japanese, a grouping key is
    the string as written, and the work identifier in the address bar shares a field name with a
    title without being one. Each entry says which function, which field, what is done with the
    value and how many times, so a read added beside an allowed one fails.

    A number here rather than a list nobody looks at (§13). Every entry is a place where the
    guarantee rests on a sentence somebody wrote instead of on the arrangement, and the count is
    what makes adding one an argument rather than an edit.
    """
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    try:
        import entrypoints
    except Exception:                                                           # noqa: BLE001
        return UNMEASURED    # this could not be measured; see UNMEASURED
    return sum(n for n, _why in entrypoints.SAFE.values())









#: What runs, and what each is. An invariant returns the offending rows; a budget returns a number
#: that may not exceed the one recorded beside it.
INVARIANTS = [
    ("names reach a page only through their renderer", inv_names_reach_a_page_only_through_their_renderer),
    ("no stock phrasing in public text", inv_no_stock_phrasing_in_public_text),
    ("a name reaches both lines of a bilingual row", inv_a_name_in_both_mode_is_rendered_in_both),
    ("status.html shows no Japanese of its own", inv_status_page_shows_no_japanese_of_its_own),
    ("English mode has no Japanese", inv_english_mode_has_no_japanese),
    ("a link goes where its label says", inv_a_link_goes_where_its_label_says),
    ("every renderer is ruled", inv_every_renderer_is_ruled),
    ("the interface folds a name key as the build does", inv_interface_folds_a_name_key_as_the_build_does),
    ("every credit role has an English gloss", inv_every_credit_role_has_an_english_gloss),
    ("a byline never states the default role", inv_a_byline_never_states_the_default_role),
    ("no name is spelled with question marks", inv_no_name_is_spelled_with_question_marks),
    ("no cataloguing notation in an English rendering",
     inv_no_cataloguing_notation_in_an_english_rendering),
    ("app.js is the derivation of kari/src", inv_the_interface_is_the_derivation_of_its_source),
]

BUDGETS = [
    ("interface tooltips a reader of Japanese cannot read",
     budget_interface_tooltips_a_reader_of_japanese_cannot_read,
     "tooltips written in English alone, on a site that is bilingual everywhere else"),
    ("renderings resting on a mechanical romanisation", budget_renderings_resting_on_a_mechanical_romanisation,
     "names an English page spells itself, because no source states how they are read. That covers  a name the store holds nothing for and a name read off a community-edited database, which  improves the spelling without settling the pronunciation. Each carries a mark and a tooltip  saying so. It falls as"),
    ("full-width forms in English renderings", budget_full_width_forms_in_english_renderings,
     "English renderings holding a full-width character and no kana or kanji, which is what  narrowing the invariant to a script let past. Mostly a Latin pen name catalogued in full  width; some are official titles and are correct, so this will not reach zero."),
    ("imprint names the interface disagrees with", budget_imprint_names_the_interface_disagrees_with,
     "imprint strings app.js renders as one name and the shipped map calls another, counted as  distinct pairs. It is the second producer of one fact, live and visible to a reader: 一迅社's  yuri line shows as its magazine's name on 346 rows. It goes to zero when the interface reads  feed/names.json's imprin"),
    ("publisher keys the interface misses", budget_publisher_keys_the_interface_misses,
     "publisher names app.js asks the shipped map for and does not get, normalised the way the  browser normalises. A rise means the two implementations of the cataloguing rule have  drifted, which is the one failure the budget above cannot see."),
    ("interface reads outside an entry point", budget_interface_reads_outside_an_entry_point,
     "reads of a name-carrying field in kari/app.js excepted in entrypoints.SAFE rather than going "
     "through the function that renders that kind of name"),
    ("bylines drawn in a spelling the field does not write", budget_bylines_drawn_in_a_spelling_the_field_does_not_write,
     "work rows whose byline reaches a reader spelt differently from the credit field the row  holds, measured with furigana on. The division spells a name the way the store is keyed on  it and a field spells it the way a cataloguer typed it, and a walk that confuses the two  either loses the address on 3"),
]

#: The number each budget may not exceed. Ratchets down only, like the pipeline's own.
#: CARRIED ACROSS AT THE NUMBER THE PIPELINE RECORDED, not at a rounder one. A budget that moved
#: when it changed repository would have hidden whether anything actually changed with it.
RECORDED = {
    "interface tooltips a reader of Japanese cannot read": 34,
    # THE TWO THAT ROSE ON THE WAY ACROSS, and the reason is the data rather than the move: this
    # site is built from a store compiled today and the numbers recorded in the pipeline were
    # measured against yesterday's. Recorded where they stand, so the ratchet starts from the truth.
    "renderings resting on a mechanical romanisation": 638,
    "full-width forms in English renderings": 44,
    "imprint names the interface disagrees with": 0,
    "publisher keys the interface misses": 0,
    "bylines drawn in a spelling the field does not write": 24,
    "interface reads outside an entry point": 12,
}


def canaries(ctx):
    """Plant each fault as it actually arrived, and fail if the check does not notice.

    §14b: AN INVENTED BAD VALUE PROVES THE LOOP RUNS. Every canary here is a string this site really
    rendered or a shape the pipeline really produced.
    """
    import copy
    ok = True
    probes = [
        # A NAME PUT ON A PAGE WITHOUT GOING THROUGH THE RENDERER, which is how a reader came to see
        # `????·Bun?Bun`: the row's raw field reached the DOM and the store's spelling did not.
        ("names reach a page only through their renderer",
         inv_names_reach_a_page_only_through_their_renderer,
         lambda c: c.update({"interface_js": c["interface_js"] + "\nel.textContent = r.author;\n"})),
        # THE STATUS PAGE WRITING A SENTENCE OF ITS OWN IN JAPANESE. `T('統計', 'Statistics')` is a
        # pair; dropping the English half is what a section added in a hurry looks like.
        ("status.html shows no Japanese of its own", inv_status_page_shows_no_japanese_of_its_own,
         lambda c: c.update({"status_js": (c.get("status_js") or "").replace(
             "T('統計', 'Statistics')", "T('統計', '統計')")})),
    ]+[

        # THE CANARY IS THE FALLBACK REMOVED, planted in the SOURCE the context holds. A row of
        # Japanese data no longer proves anything: the renderer floors whatever it is handed, so a
        # planted row comes back romanised and the check correctly reports nothing. What this now
        # asserts is a property of the RENDERER, so the canary has to break the renderer, and
        # taking `enFallback` back to a pass-through is exactly the state the 77 were in.
        ("English mode has no Japanese", inv_english_mode_has_no_japanese,
         lambda c: c.update({"interface_js": (c.get("interface_js") or "").replace(
             "  if (!s || !JA_ANY.test(s)) return s;\n  const whole = floorText(s);",
             "  if (s) return s;\n  const whole = floorText(s);")})),

        # reaches the file the check evaluates. 著 is the commonest role in the corpus by a long
        # way, 766 credits state it, and it was in the six-word table this replaced, so a round
        # that rewrites `ROLE_EN` and drops it is not a hypothetical.
        ("every credit role has an English gloss", inv_every_credit_role_has_an_english_gloss,
         lambda c: c.update({"interface_js": (c.get("interface_js") or "").replace(
             "'著': 'author', '著者': 'author',", "'著者': 'author',")})),

        # 著 stops eliding and 578 catalogue bylines state a job the catalogue never distinguished,
        # while 著者 and 作 go on eliding, so the word this scans for is still derived and the
        # canary is a real disagreement rather than an empty vocabulary.
        ("a byline never states the default role", inv_a_byline_never_states_the_default_role,
         lambda c: c.update({"interface_js": (c.get("interface_js") or "").replace(
             "const ROLE_ELIDED = { '著': '',", "const ROLE_ELIDED = {")})),

        # `creditLine` shortened a long byline by cutting the field on the slash and calling
        # `linkedCredits` with the pieces joined back up, which is a field the build never divided,
        # so the division went missing and the line dropped to the floor. That is how
        # `安田剛助・文尾文` reached a reader as `???? · Bun?Bun`. Nothing invented: this is the two
        # statements the file held, restored.
        ("no name is spelled with question marks", inv_no_name_is_spelled_with_question_marks,
         lambda c: c.update({"interface_js": (c.get("interface_js") or "")
                             .replace("const people = creditPeople(raw) || (raw ? [raw] : []);",
                                      "const people = raw.split(/\\s*\\/\\s*/).filter(Boolean);")
                             .replace("const head = linkedCredits(r, CREDITS_SHOWN);",
                                      "const head = linkedCredits({ ...r, author: "
                                      "people.slice(0, CREDITS_SHOWN).join(' / ') });")})),
    ]
    for name, fn, plant in probes:
        c = copy.deepcopy({k: v for k, v in ctx.items() if k not in ("store", "_emit")})
        c["store"], c["_emit"] = ctx["store"], ctx["_emit"]
        plant(c)
        if not fn(c):
            print(f"  self-test FAILED — '{name}' did not catch its canary")
            ok = False
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--store", required=True, help="the published corpus.sqlite")
    a = ap.parse_args(argv)
    ctx = context(a.store)

    if not canaries(ctx):
        print("REFUSING: a check could not be shown to fail, so a clean report means nothing")
        return 3

    bad = 0
    print("what a reader is shown:")
    for name, fn in INVARIANTS:
        got = fn(ctx)
        if got:
            bad += 1
            print(f"  FAIL  {name}: {len(got)}")
            for x in got[:4]:
                print(f"          {x}")
        else:
            print(f"  ok    {name}")
    for name, fn, why in BUDGETS:
        n = fn(ctx)
        limit = RECORDED.get(name)
        if n is UNMEASURED:
            bad += 1
            print(f"  FAIL  {name}: could not be measured")
        elif limit is not None and n > limit:
            bad += 1
            print(f"  FAIL  {name}: {n} (budget {limit}) — {why}")
        else:
            print(f"  ok    {name}: {n}")
    print("all right" if not bad else f"NO GO: {bad} check(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
