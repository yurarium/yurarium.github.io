#!/usr/bin/env python3
"""titlecase.py: every English title shown in title case, Chicago style, and nothing else touched."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rules                                                    # noqa: E402
rules.on_path()                    # the pipeline's harness, and this repository as the site

import testkit  # noqa: E402
import titlecase  # noqa: E402

tc = titlecase.title_case


def main(s):
    # THE RULING ITSELF: what the source printed is recorded, and title case is what is shown.
    s.eq(tc("HOSHIKUZU TELEPATH"), "Hoshikuzu Telepath", "a title in capitals throughout is cased")
    s.eq(tc("missing moon and doughnuts"), "Missing Moon and Doughnuts", "and one in lower case")
    s.eq(tc("Crushing On You"), "Crushing on You", "a publisher's capital on a preposition goes")
    s.eq(tc("Gushing over Magical Girls"), "Gushing over Magical Girls",
         "Chicago keeps prepositions low, whatever their length")
    s.eq(tc("High school girl VTuber who clearly lies about her age"),
         "High School Girl VTuber Who Clearly Lies about Her Age", "a sentence-case title is cased")

    # FIRST AND LAST, OF THE TITLE AND OF EVERY SUBTITLE.
    s.eq(tc("a curtain call for you"), "A Curtain Call for You", "the first word is capitalised")
    s.eq(tc("We Promised to Marry Ten Years Ago, but"), "We Promised to Marry Ten Years Ago, But",
         "and the last")
    s.eq(tc("SAL: stories about love"), "SAL: Stories about Love", "and the first after a colon")
    s.eq(tc("Onee-sama and the Giant ~the young lady's isekai reincarnation~"),
         "Onee-sama and the Giant ~The Young Lady's Isekai Reincarnation~",
         "a subtitle between tildes opens with a capital")

    # WHAT IS LEFT AS WRITTEN.
    s.eq(tc("The Gal JK and the OL"), "The Gal JK and the OL", "an acronym keeps its capitals")
    s.eq(tc("GAL MAID & NEET PRINCESS"), "Gal Maid & NEET Princess",
         "even in a title that is otherwise shouting")
    s.eq(tc("BLOODY by DAY by DAY"), "Bloody by Day by Day",
         "a word in capitals for emphasis is cased like any other")
    s.eq(tc("the nullMeta of YuruYuri"), "The nullMeta of YuruYuri",
         "a capital inside a word is the publisher's styling and stands")
    s.eq(tc("MY BEST FRIEND IS IN LOVE WITH MY VTUBER"), "My Best Friend Is in Love with My VTuber",
         "VTuber keeps its styling even out of a title in capitals")
    s.eq(tc("The 11th Cat on the 1st Floor, 0.1mm Shorter"), "The 11th Cat on the 1st Floor, 0.1mm Shorter",
         "nothing after a digit is capitalised")
    s.eq(tc("too much thinking girl, her name is Hime-chan."),
         "Too Much Thinking Girl, Her Name Is Hime-chan.", "an honorific stays low after its hyphen")
    s.eq(tc("Alcohol and Ogre-girls"), "Alcohol and Ogre-Girls",
         "while any other word after a hyphen is capitalised, as Chicago has it")
    s.eq(tc("K-ON! shuffle"), "K-ON! Shuffle", "a name kept whole is kept whole")
    s.eq(tc("Hime-chan Is a Heavy Woman (single chapters)"),
         "Hime-chan Is a Heavy Woman (single chapters)", "our own edition label is not the title")
    s.eq(tc("Il cavaliere della principessa cannibale"), "Il cavaliere della principessa cannibale",
         "a title in another language follows that language's rules")
    s.eq(tc("Blows off Steam"), "Blows Off Steam",
         "a preposition most often used as a particle is capitalised")
    s.eq(tc(""), "", "nothing is nothing")

    # PRESENTING IS IDEMPOTENT, since a carried archive row may already have been cased.
    for t in ("The Maid Dragon of Kobayashi-san", "Too Much Thinking Girl, Her Name Is Hime-chan.",
              "SAL: Stories about Love"):
        s.eq(tc(tc(t)), tc(t), f"casing {t!r} twice changes nothing")

    # WHICH FORMS: the three English kinds, never a romanisation.
    rec = {"en": "HOSHIKUZU TELEPATH", "basis": "official-jp",
           "en_forms": {"official-jp": "HOSHIKUZU TELEPATH", "translated": "stardust telepath"},
           "romaji": {"macron": "Hoshikuzu Terepasu"}}
    titlecase.present(rec)
    s.eq((rec["en"], rec["en_forms"]),
         ("Hoshikuzu Telepath", {"official-jp": "Hoshikuzu Telepath",
                                 "translated": "Stardust Telepath"}), "every English form is cased")
    rom = {"en": "Sake to Onna wa ni Gō made", "basis": "romaji"}
    titlecase.present(rom)
    s.eq(rom["en"], "Sake to Onna wa ni Gō made", "a romanisation keeps its own rules")
    doc = {"series": [{"work_en": {"en": "magic hour", "basis": "official-jp"}}],
           "author_en": {"en": "kei", "basis": "official-jp"}}
    titlecase.present_rows(doc)
    s.eq(doc["series"][0]["work_en"]["en"], "Magic Hour", "a title is found wherever a row holds one")
    s.eq(doc["author_en"]["en"], "kei", "and a person's name is not a title")


if __name__ == "__main__":
    raise SystemExit(testkit.run(main, pathlib.Path(__file__).name))
