#!/usr/bin/env python3
"""entrypoints.py: proving a name cannot reach a page except through the function that renders it.

COVERS = ['adapters/lint/entrypoints.py']

WHAT THIS HAS TO PROVE. Not that the lint runs, but that it FAILS on each of the four escapes that
actually shipped, because a lint that passes on today's file has said nothing about tomorrow's.
Each probe below is one of them, written back into the real `kari/app.js` so the fault is in its own
setting rather than in a snippet built to be caught.

The tokeniser gets its own assertions first. Everything above it rests on the claim that a comment
mentioning `w.t`, a template holding a brace and a regular expression containing a slash are read as
what they are, and the first version of it emitted `&&` as two `&` tokens, which turned thirteen
conditions into thirteen renderings.
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import entrypoints
import interface
import testkit


def kinds(src):
    return [(k, t) for k, t, _ in entrypoints.tokens(src) if k not in ("ws",)]


# One surface and one entry point, so the rules can be exercised without the real table moving
# under the test.
ONE = [interface.Surface("rows[].work", "workLabel", "row:work", "title", "a row's title")]


def main(s):
    # ── the tokeniser ─────────────────────────────────────────────────────────────────────────
    tricky = ("const re = /a\\/b[/]c/g;\n"
              "// a comment mentioning w.t and `a backtick`\n"
              "const s = 'a string with ${not} an interpolation';\n"
              "const t = `outer ${ inner.work } and ${ {a: 1}.a } tail`;\n"
              "if (a && b !== c) esc(d.work);\n")
    s.eq("".join(t for _k, t, _p in entrypoints.tokens(tricky)), tricky,
         "the tokens concatenate back to the source byte for byte, which is the only thing making "
         "every rule below a statement about the file rather than about a lossy reading of it")
    s.check(("regex", "/a\\/b[/]c/g") in kinds(tricky),
            "a regular expression holding an escaped slash and a class is one token, not a divide")
    s.check(any(k == "comment" for k, _ in kinds(tricky)),
            "and a comment is a token, so `w.t` written in prose is not a read")
    s.check(("punct", "&&") in kinds(tricky),
            "a two-character operator is emitted whole; emitting it twice as `&` is what made "
            "every `a && b` look like a value being passed on")
    s.check(("punct", "!==") in kinds(tricky), "and so is a three-character one")
    s.check(("punct", "${") in kinds(tricky), "an interpolation opens with its own token")
    s.check(any(k == "template" for k, _ in kinds(tricky)),
            "the text around an interpolation is template, so a brace inside it is not a scope")
    s.check(not any(k == "name" and t == "not" for k, t in kinds(tricky)),
            "and `${not}` inside a single-quoted STRING is text, not an interpolation")

    # ── the rule ──────────────────────────────────────────────────────────────────────────────
    ok = "function draw(r) { return `<li>${workLabel(r)}</li>`; }"
    s.eq(entrypoints.findings(ok, ONE, {}), [],
         "a row handed to its entry point is what the rule asks for")

    s.eq(len(entrypoints.findings("function draw(r) { return `<li>${esc(r.work)}</li>`; }",
                                  ONE, {})), 1,
         "escaping the field instead is the fault that shipped 2,430 rows of Japanese")
    s.eq(len(entrypoints.findings("function draw(r) { return `<li>${r.work}</li>`; }", ONE, {})), 1,
         "and interpolating it raw is the same fault with the escaping left off")
    s.eq(entrypoints.findings("function draw(r) { return r.work ? workLabel(r) : ''; }", ONE, {}),
         [], "asking WHETHER there is a title is a yes or a no and reaches no page")
    s.eq(entrypoints.findings("function workLabel(r) { return esc(r.work); }", ONE, {}), [],
         "the entry point reads the field itself, which is where the read belongs")
    s.eq(entrypoints.findings("function sort(a, b) { return a.work.localeCompare(b.work); }",
                              ONE, {}), [],
         "a method called on the value is the consumer, and an ordering shows nothing")

    # The exception table, and the count that stops it laundering a second read.
    src = "function draw(r) { return group(r.work); }"
    s.eq(len(entrypoints.findings(src, ONE, {})), 1, "an unruled consumer is a finding")
    s.eq(entrypoints.findings(src, ONE, {("draw", "work", "through:group"): (1, "a grouping key")}),
         [], "and an exception naming the function, the field and the consumer allows it")
    two = "function draw(r) { return group(r.work) + group(r.work); }"
    s.check(any("2 times" in b for b in entrypoints.findings(
        two, ONE, {("draw", "work", "through:group"): (1, "a grouping key")})),
        "A SECOND READ UNDER THE SAME EXCEPTION FAILS. Keyed on the triple alone this let the "
        "fourth historical fault through: renderReleases was allowed one String(w.creator) for "
        "its search key and a second one splitting the field for display went unremarked")
    s.eq(len(entrypoints.findings(
        "function draw(r) { return workLabel(r); }", ONE,
        {("draw", "work", "through:group"): (1, "a grouping key")})), 1,
        "and an exception nobody exercises fails too, because a line claiming something nobody "
        "does is reasoning the next person will lean on")

    s.raises(ValueError, _refuse,
             "an exception that would allow a rendering is refused outright, so the table cannot "
             "be the place a leak is parked")

    # ── the four faults, in the real file ─────────────────────────────────────────────────────
    if not interface.APP_JS.exists():
        print("  note: kari/app.js is not beside this repository, so the probes did not run")
        return
    _comparisons(s)
    undrawn(s)
    app = interface.APP_JS.read_text(encoding="utf-8")
    s.eq(entrypoints.findings(app), [],
         "kari/app.js as it stands puts no name on a page except through its renderer")
    for what, before, after in (
            ("the catalogue tab printing index.json's title raw",
             "${workLabel({ work: w.t })}", "${esc(w.t)}"),
            ("the 発売 tab labelling a volume from the record title",
             "const label = workLabel({ work: w.title.ja });", "const label = esc(w.title.ja);"),
            ("a byline interpolated straight into a row", "${authorLabel(r)}", "${r.author}"),
            ("the credit field pulled apart outside its entry point",
             "const people = creditNames(w.creator);",
             "const people = String(w.creator || '').split('/').map(esc).join(' / ');")):
        s.check(before in app, f"{what}: the line the probe replaces is still in kari/app.js")
        s.check(bool(entrypoints.findings(app.replace(before, after, 1))),
                f"{what}: caught when written back into the file")
    _one_language(s, app)


def _one_language(s, app):
    """A renderer that answers in one language, asked once, under 併記.

    The fault a reader reported: the work page heading called `workLabel` directly, and `workLabel`
    answers in Japanese for anything that is not `en` because 併記 is `bilingual()`'s job. It was
    right in ja and right in en, so nothing but the third setting showed it.
    """
    ONELANG = {"workLabel": "a title", "creditNames": "the people in a credit field"}
    s.eq(entrypoints.single_language_findings(
        "function draw(r) { return `<li>${bilingual(() => workLabel(r))}</li>`; }", ONELANG, {}),
        [], "a renderer asked inside bilingual() is asked once per language")
    s.eq(len(entrypoints.single_language_findings(
        "function draw(r) { return `<li>${workLabel(r)}</li>`; }", ONELANG, {})), 1,
        "asked directly it answers in Japanese under 併記 and says nothing about it")
    s.eq(entrypoints.single_language_findings(
        "function cmp(r) { return inLang('ja', () => workLabel(r)); }", ONELANG, {}), [],
        "AND inLang IS THE OTHER WRAPPER. The credit page compares two renderings to decide "
        "whether to say 'credited as', and a comparison wants one language on purpose")
    s.eq(entrypoints.single_language_findings(
        "function draw(r) { const row = () => workLabel(r); return bilingual(row); }",
        ONELANG, {}), [],
        "A CALLBACK HANDED OVER BY NAME IS STILL WRAPPED. The 更新 and 発売 tabs both build the "
        "row in a named function and pass it, so a rule reading only the enclosing calls would "
        "report the two surfaces that have been right the longest")
    s.eq(len(entrypoints.single_language_findings(
        "function draw(r) { const row = () => workLabel(r); return row('ja'); }",
        ONELANG, {})), 1,
        "and the same callback called instead of handed over is the fault again")
    s.eq(entrypoints.single_language_findings(
        "function creditNames(c) { return workLabel(c); }", ONELANG,
        {("creditNames", "workLabel"): (1, "its own callers wrap it")}), [],
        "one such renderer calling another passes the obligation on, where an entry says so")
    s.check(any("2 times" in b for b in entrypoints.single_language_findings(
        "function creditNames(c) { return workLabel(c) + workLabel(c); }", ONELANG,
        {("creditNames", "workLabel"): (1, "its own callers wrap it")})),
        "a second call under the same entry fails, for the reason SAFE is counted")
    s.eq(len(entrypoints.single_language_findings(
        "function draw(r) { return bilingual(() => workLabel(r)); }", ONELANG,
        {("creditNames", "workLabel"): (1, "its own callers wrap it")})), 1,
        "and an entry nobody exercises fails, so the table cannot outlive the code it describes")

    s.eq(entrypoints.single_language_findings(app), [],
         "kari/app.js as it stands asks every one-language renderer once per language")
    for what, before, after in (
            ("the work page heading",
             "${bilingual(() => workLabel(r))}", "${workLabel(r)}"),
            ("the credit page heading",
             "${bilingual(() => authorLabel({ author: fact.credit }))}",
             "${authorLabel({ author: fact.credit })}"),
            ("the works list on a credit or publisher page",
             "bilingual(() => workLabel(w))}</a>", "workLabel(w)}</a>"),
            # The tail of this line moved when an anthology's Author row learned to say `Various`
            # in place of a byline, so the probe matches the wrapper and not what follows it.
            ("the work page byline",
             "r.author ? bilingual(() => creditLine(r))", "r.author ? creditLine(r)"),
            ("the 発売 row",
             '`<div class="relv">${bilingual(row)}</div>`',
             '`<div class="relv">${row(LANG)}</div>`'),
            ("the 作品 index row", "<span>${bilingual(() => `", "<span>${(() => `")):
        s.check(before in app, f"{what}: the line the probe replaces is still in kari/app.js")
        s.check(bool(entrypoints.single_language_findings(app.replace(before, after, 1))),
                f"{what}: caught when the wrapper is taken off again")


def _comparisons(s):
    """A comparison reads the same in either order, and the rule only saw one of them.

    `x !== ln.name` came back as a read consumed by whatever call enclosed it, which for a
    `.filter(...)` is the filter, while `ln.name !== x` came back as tested. That made the guarantee depend
    on which side of the operator somebody wrote the field, which is not a distinction it rests on.
    """
    for src, want, why in (
            ("function f(r) { return list.filter(x => x !== r.work); }", [],
             "a field compared from the right of the operator is a test"),
            ("function f(r) { return list.filter(x => r.work !== x); }", [],
             "and so is the same comparison written the other way round"),
            ("function f(r) { return list.filter(x => esc(r.work)); }", 1,
             "while a value handed to esc inside the same callback is still a rendering"),
            ("function f(r) { return g(a, r.work); }", 1,
             "and an argument after a comma is not a comparison, whatever sits before it")):
        got = entrypoints.findings(src, surfaces=ONE, safe={})
        s.eq(len(got) if want else got, want if want else [], f"{why}: {src[:44]}")


def undrawn(s):
    """A field ruled as one nothing draws must not reach a page.

    THE OTHER HALF OF THE MODULE, ADDED AFTER IT COST 383 WORKS. `interface.unruled` requires a
    ruling for every field the data carries Japanese in, and one of the two answers is "nothing
    draws this". That answer was asserted 46 times and checked none, so a volume's `designation`
    was ruled it on 2026-08-12 and drawn with `esc` by the same change, in English mode, with both
    existing guards green.
    """
    RULED = {"works[].volumes[].designation": "nothing draws it"}
    s.eq(entrypoints.undrawn_findings(
             "function draw(v) { return `<i>${esc(v.designation)}</i>`; }", RULED) and 1, 1,
         "a value escaped into markup is a page, and the fault is reported")
    s.eq(entrypoints.undrawn_findings(
             "function draw(v) { return `<i>${v.designation}</i>`; }", RULED) and 1, 1,
         "so is a value interpolated straight into a template")

    # AND A READ FOR LOGIC IS NOT A RENDERING, which is what makes the rule usable at all: these
    # fields exist to be tested, keyed on and counted, and a check that reported every read would
    # be answered by deleting the ruling rather than by fixing anything.
    for src, why in (
            ("function f(v) { return v.designation ? 1 : 0; }", "a test"),
            ("function f(v) { return rows.filter(x => x.designation === v.designation); }",
             "a comparison"),
            ("function f(v) { m.set(v.designation, v); }", "a map key"),
            ("function f(v) { return volLabel(v.designation); }", "an argument to a renderer")):
        s.eq(entrypoints.undrawn_findings(src, RULED), [],
             f"{why} does not put the value on a page")

    # A PATH ALSO RULED AS QUOTED IS NOT ASKED ABOUT, because a quotation is drawn on purpose. The
    # two lists together are the whole of the old NOT_A_NAME, so nothing lost a ruling in the split.
    s.check(not (set(interface.QUOTED) & set(interface.NOT_DRAWN)),
            "no path is ruled twice, so which answer applies is never a question")
    s.eq(dict(interface.NOT_A_NAME),
         {**interface.NOT_DRAWN, **interface.QUOTED},
         "and the union is what the older readers still see")
    s.check(all(str(v).strip() for v in interface.NOT_DRAWN.values()),
            "every undrawn ruling carries the reason somebody wrote for it")


def _refuse():
    """Load the module's own guard against an exception that would allow a rendering."""
    entrypoints.SAFE[("draw", "work", "interpolated")] = (1, "a leak somebody wanted through")
    try:
        entrypoints._refuse_bad_safe()
    finally:
        del entrypoints.SAFE[("draw", "work", "interpolated")]


if __name__ == "__main__":
    sys.exit(testkit.run(main, "entrypoints"))
