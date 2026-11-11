#!/usr/bin/env python3
"""Every English title a reader is shown, in title case, Chicago style.

THE PROJECT OWNER'S RULING, 2026-11-11. A title is recorded with the capitals its source provides,
an image included, and presented in title case whatever the record holds. So `HOSHIKUZU TELEPATH`
is what the publisher printed and what the store keeps, and `Hoshikuzu Telepath` is what a page
shows. Casing is presentation, which is why it happens here and not in the pipeline: the record
keeps the evidence and the view does the normalising.

ONE PLACE, applied to the data files before they are written. `app.js` and the pre-rendered pages
both read those files, so a second implementation in JavaScript would be a second producer of one
fact, and the two would drift.

WHAT CHICAGO MEANS HERE. The first and last word of the title and of every subtitle is
capitalised. Articles, the coordinating conjunctions and, but, for, or and nor, `to`, `as`, and
prepositions are lowercase elsewhere. Everything else is capitalised. A preposition used as a
particle (`Blows Off Steam`, `Loosen Up`) cannot be told from one used as a preposition without
parsing the sentence, so the prepositions most often used as particles are left out of the list
and always capitalised: up, off, out, down, like, near, past, round, since, until. `over` stays
lowercase, as Chicago has it, because `Gushing over Magical Girls` is the commoner use.

WHAT IS NOT TOUCHED, each for its own reason:
  - a romanisation, which follows the project's romanisation rules and keeps its particles low;
  - a word with a capital past its first letter, which is a styling the publisher chose
    (VTuber, NullMeta, YuruYuri), unless the whole title is in capitals and so says nothing;
  - an acronym on ACRONYMS, in any title;
  - letters right after a digit (1st, 0.1mm, 2DK);
  - an honorific after a hyphen (Hime-chan, Makoto-senpai);
  - one of our own edition labels in lower case at the end, `(single chapters)`;
  - a title in a language other than English, listed in NOT_ENGLISH, since French, Italian and
    German case titles by their own rules.

Usage:  imported by from_store.py; `titlecase.py "SOME TITLE"` prints the presented form.
"""
import re
import sys

SMALL = frozenset("""
    a an the and but for or nor to as vs vs. via per
    about above across after against along amid among around at before behind below beneath beside
    besides between beyond by despite during except from in inside into of on onto opposite outside over
    than through throughout toward towards under underneath unlike unto upon with within without
""".split())

#: Kept in capitals in any title. Read off the corpus on 2026-11-11: every word in capitals inside
#: a mixed-case title, and every short title in capitals, judged one by one.
ACRONYMS = frozenset("""
    AI AM ASMR BBB BL CPL DK FC GL GP HG JC JD JK JS NEET NTR OL PM SAL SHWD SM SQ SSSS TS TV VR XX
    II III IV VI VII VIII IX XI XII
""".split())

#: Words that stay exactly as written wherever they appear.
KEEP_TOKENS = frozenset({"K-ON!", "K-ON"})

HONORIFICS = frozenset("""
    chan san kun sama senpai sempai sensei tan dono chin nee nii neesan oneesan
""".split())

#: Titles in another language, presented as recorded. By value, because the store does not say
#: which language a title is in and these are few enough to name.
NOT_ENGLISH = frozenset({
    "toi et moi", "Mémoire", "Lilium Terrarium", "prima stella",
    "Il cavaliere della principessa cannibale", "schadenliebe", "Schwestern in Liebe!",
    "Weg nach innen", "saudade", "au printemps", "Die Sekundenzeiger Tickt",
    "Die 10. Sinfonie: Eine Geschichte zwischen Wahrheit und Fiktion",
})

WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*")
#: Text between two words that starts a new subtitle or sentence, so the next word is capitalised.
BREAK = re.compile(r"[:;!?.()\[\]{}~～〜「」『』“”\"/–—|]|\s-\s")
#: An edition label of ours on the end, in lower case.
LABEL = re.compile(r"(\s*\([a-z][a-z ,]*\))$")


def _cap(w):
    return w[:1].upper() + w[1:]


def title_case(s):
    """`s` as a reader is shown it."""
    if not s or s in NOT_ENGLISH:
        return s
    label = ""
    m = LABEL.search(s)
    if m and m.start() > 0:
        s, label = s[:m.start()], m.group(1)
    shouting = not any(c.islower() for c in s)
    words = list(WORD.finditer(s))
    keep = set()
    for t in re.finditer(r"\S+", s):
        if t.group().rstrip(",.") in KEEP_TOKENS:
            keep.update(range(t.start(), t.end()))
    out, at = [], 0
    for i, m in enumerate(words):
        w, start, end = m.group(), m.start(), m.end()
        out.append(s[at:start])
        at = end
        before = s[words[i - 1].end():start] if i else ""
        after = s[end:words[i + 1].start()] if i + 1 < len(words) else ""
        first = i == 0 or bool(BREAK.search(before))
        last = i + 1 == len(words) or bool(BREAK.search(after))
        prev = s[start - 1] if start else ""
        if start in keep:
            out.append(w)
        elif prev.isdigit():
            out.append(w)
        elif prev == "-" and w.lower() in HONORIFICS:
            out.append(w.lower())
        elif w.upper() in ACRONYMS and w.isupper() and (len(w) > 1):
            out.append(w)
        elif w.upper() == "VTUBER":
            out.append("VTuber")
        elif not shouting and any(c.isupper() for c in w[1:]) and any(c.islower() for c in w):
            out.append(w)
        else:
            low = w.lower() if (shouting or w.isupper()) else w
            if low.lower() in SMALL and not first and not last:
                out.append(low.lower())
            else:
                out.append(_cap(low))
    out.append(s[at:])
    return "".join(out) + label


#: The English forms a reader can be shown. A romanisation is not one of them.
CASED_BASES = ("official-jp", "licensed", "translated")


def present(rec):
    """Case one title record in place: its `en` and every form in `en_forms`."""
    if not isinstance(rec, dict):
        return rec
    if rec.get("en") and rec.get("basis") in CASED_BASES:
        rec["en"] = title_case(rec["en"])
    forms = rec.get("en_forms")
    if isinstance(forms, dict):
        for b in list(forms):
            if b in CASED_BASES and forms[b]:
                forms[b] = title_case(forms[b])
    return rec


def present_rows(doc, key="work_en"):
    """Every `work_en` in a document, wherever it sits."""
    if isinstance(doc, dict):
        for k, v in doc.items():
            if k == key:
                present(v)
            else:
                present_rows(v, key)
    elif isinstance(doc, list):
        for v in doc:
            present_rows(v, key)
    return doc


if __name__ == "__main__":
    for a in sys.argv[1:]:
        print(title_case(a))
