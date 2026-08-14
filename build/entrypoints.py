#!/usr/bin/env python3
"""Every field carrying a name reaches a page only through the function that renders names.

WHY A RUNTIME CHECK IS NOT ENOUGH. `adapters/interface.py` loads kari/app.js and asks it what it
would show, which proves that what reaches the renderer comes out right. It cannot say anything
about a call site that never calls the renderer, and every leak this project has shipped was one of
those:

  the catalogue tab wrote `esc(w.t)` from index.json and 2,430 rows stayed Japanese in English mode
  while `workLabel` sat unused two lines away;

  `credit()` translated the role in the bracket and left the name beside it, so a reader met
  `[author]やまじえびね`;

  the 発売 tab labelled a volume row from the bibliographic record's title, which the name store is
  not keyed on, and eight works were English on three tabs and Japanese on the fourth;

  `publisherParts` returned a plain string that its callers escaped, so the mark saying a reading
  is unattested could not travel with the name and a second function had to be written to carry it.

None of those reaches a renderer, so no amount of running one finds them. They are all visible in
the source: a field is read, and what is done with the value is not a call to the function that
renders that kind of field.

WHAT IS ASSERTED. For every field `adapters/interface.py` rules as carrying a name, every read of
it in kari/app.js must be one of:

  inside the body of the function that renders it, which is where the read belongs;
  an argument to a call to that function, which is a caller handing the field over;
  an entry in `SAFE` below, which names the function, the field and what is done with the value,
  and carries a reason a person wrote.

Anything else is a finding. `SAFE` cannot be used to wave one through: an entry whose consumer is
`esc` or a template interpolation is refused when this module loads, because those are the two ways
a string becomes part of a page and they are the whole of what this exists to prevent.

WHY A TOKENISER AND NOT A REGULAR EXPRESSION. `esc(w.t)` is easy to find and `workLabel({ work:
w.t })` is not, because what matters is which call encloses the read and which function encloses
that. A comment mentioning `w.t`, a template holding `${...}` inside a string, and a regex literal
containing a slash all defeat a pattern. The tokeniser below is small, it is proved on the file it
reads by requiring that the tokens it emits concatenate back to the source byte for byte, and its
test reintroduces each of the four faults above and requires this to catch them.

WHAT THIS CANNOT SEE. Data that reaches no call site at all. A field the build writes and the
interface never reads is not a leak and is not found here; it is found by `interface.unruled`,
which reads the DATA and requires a ruling for every Japanese-bearing field, so a new field is a
decision somebody has to make rather than a silence. Between the two, a field can be neither
unruled nor wrongly rendered and still be wrong in its content, which is what a reader is for.

  ./entrypoints.py                  check kari/app.js
  ./entrypoints.py --self-test      plant each historical fault and require a catch
"""
import argparse
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import interface  # noqa: E402

# The two ways a value becomes part of a page. A `SAFE` entry may never name one of these, which is
# what stops the exception table from being the place a leak is parked.
OUTPUT = ("esc", "interpolated")

IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
NUMBER = re.compile(r"(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*)n?")
# After one of these a `/` divides; after anything else it opens a regular expression. `}` counts
# as "anything else": it ends a block far more often than it ends an object literal here, and the
# round-trip assertion in `tokens` fails loudly rather than silently if that ever stops holding.
DIVIDES_AFTER = {")", "]", "}"}
KEYWORDS_BEFORE_REGEX = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
                         "throw", "case", "do", "else", "yield", "await"}
# A value the next operator turns into a yes or a no never reaches a page. `||` is deliberately not
# here: `r.work || ''` yields the title when there is one, so the value passes straight through.
TEST_OPS = {"?", "&&", "===", "!==", "==", "!=", "<", ">", "<=", ">="}
# Emitted whole. A tokeniser handing back `&` twice cannot tell `a && b` from `a & b`, and the
# first version of this did exactly that, so every `&&` and every `!==` read as a bare value and
# thirteen conditions were reported as renderings.
PUNCTUATORS = sorted(
    (">>>=", "...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??=", ">>>", "=>", "==",
     "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=",
     "|=", "^=", "**", "<<", ">>"), key=len, reverse=True)
CONDITIONS = {"if", "while", "switch"}


def tokens(src):
    """`(kind, text, start)` for the whole file, in order.

    Kinds: `ws`, `comment`, `string`, `template`, `regex`, `name`, `number`, `punct`. A template
    literal is emitted as its own `template` chunks around the tokens of each `${…}`, so an
    interpolation's contents are ordinary tokens and the `${` shows up as punctuation.

    PROVED ON WHAT IT READ. The caller checks that the texts concatenate back to the source. A
    tokeniser that quietly dropped a byte would make every rule below true of a file nobody has.
    """
    out, i, n = [], 0, len(src)
    tmpl = []                         # brace depth at each open `${`, innermost last
    braces = 0

    def last_significant():
        for kind, text, _ in reversed(out):
            if kind not in ("ws", "comment"):
                return kind, text
        return None, None

    while i < n:
        c = src[i]
        if c in " \t\r\n":
            j = i
            while j < n and src[j] in " \t\r\n":
                j += 1
            out.append(("ws", src[i:j], i)); i = j; continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(("comment", src[i:j], i)); i = j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(("comment", src[i:j], i)); i = j; continue
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            out.append(("string", src[i:j + 1], i)); i = j + 1; continue
        if c == "`":
            j, i0 = i + 1, i
            while j < n:
                if src[j] == "\\":
                    j += 2; continue
                if src[j] == "`":
                    out.append(("template", src[i0:j + 1], i0)); i = j + 1; break
                if src.startswith("${", j):
                    out.append(("template", src[i0:j], i0))
                    out.append(("punct", "${", j))
                    tmpl.append(braces); braces += 1
                    i = j + 2; break
                j += 1
            else:
                out.append(("template", src[i0:], i0)); i = n
            continue
        if c == "}" and tmpl and braces - 1 == tmpl[-1]:
            # Closing an interpolation: what follows is template text again, up to the next `${`
            # or the closing backtick.
            tmpl.pop(); braces -= 1
            out.append(("punct", "}", i))
            j, i0 = i + 1, i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2; continue
                if src[j] == "`":
                    out.append(("template", src[i0:j + 1], i0)); i = j + 1; break
                if src.startswith("${", j):
                    out.append(("template", src[i0:j], i0))
                    out.append(("punct", "${", j))
                    tmpl.append(braces); braces += 1
                    i = j + 2; break
                j += 1
            else:
                out.append(("template", src[i0:], i0)); i = n
            continue
        if c == "/":
            kind, text = last_significant()
            divides = (kind in ("name", "number", "string", "template", "regex")
                       and text not in KEYWORDS_BEFORE_REGEX) or text in DIVIDES_AFTER
            if not divides:
                j, klass = i + 1, False
                while j < n:
                    if src[j] == "\\":
                        j += 2; continue
                    if src[j] == "[":
                        klass = True
                    elif src[j] == "]":
                        klass = False
                    elif src[j] == "/" and not klass:
                        break
                    elif src[j] == "\n":
                        break
                    j += 1
                if j < n and src[j] == "/":
                    j += 1
                    while j < n and src[j].isalpha():
                        j += 1
                    out.append(("regex", src[i:j], i)); i = j; continue
        m = IDENT.match(src, i)
        if m:
            out.append(("name", m.group(0), i)); i = m.end(); continue
        m = NUMBER.match(src, i)
        if m:
            out.append(("number", m.group(0), i)); i = m.end(); continue
        for op in PUNCTUATORS:
            if src.startswith(op, i):
                out.append(("punct", op, i)); i += len(op); break
        else:
            if c == "{":
                braces += 1
            elif c == "}":
                braces -= 1
            out.append(("punct", c, i)); i += 1
    return out


def _significant(toks):
    return [t for t in toks if t[0] not in ("ws", "comment", "template")]


def function_at(toks):
    """`[(name, first token index, last token index)]` for each `function NAME(…) {…}`.

    Only named declarations. An arrow function inside a renderer is part of that renderer for this
    purpose: a callback building a row is the same call site as the loop around it, and treating it
    as its own scope would let a read escape by being written as `rows.map(w => …)`.
    """
    sig = _significant(toks)
    at = {id(t): k for k, t in enumerate(sig)}
    out = []
    for k, (kind, text, _) in enumerate(sig):
        if kind != "name" or text != "function":
            continue
        if k + 1 >= len(sig) or sig[k + 1][0] != "name":
            continue
        name = sig[k + 1][1]
        j = k + 2
        while j < len(sig) and sig[j][1] != "{":
            j += 1
        depth, e = 0, j
        while e < len(sig):
            if sig[e][1] in ("{", "${"):
                depth += 1
            elif sig[e][1] == "}":
                depth -= 1
                if depth == 0:
                    break
            e += 1
        out.append((name, sig[k][2], sig[min(e, len(sig) - 1)][2]))
    del at
    return out


def reads(toks, accessors):
    """Every read of one of `accessors`, as `(accessor, position, consumer)`.

    An accessor is what the JavaScript writes: `t`, `work`, `title.ja`. The consumer is what is
    done with the value, and it is the innermost of the call that encloses the read and the
    template interpolation that encloses it: `esc(pubBoth(p.publisher))` consumes through
    `pubBoth`, and `${w.t}` consumes by being interpolated.
    """
    sig = _significant(toks)
    stack = []                       # ("call", name) | ("group",) | ("interp",)
    out = []
    for k, (kind, text, pos) in enumerate(sig):
        if text == "(":
            callee = None
            if k and sig[k - 1][0] == "name" and sig[k - 1][1] not in (
                    "if", "for", "while", "switch", "catch", "return", "function"):
                callee = sig[k - 1][1]
            if callee:
                stack.append(("call", callee))
            elif k and sig[k - 1][0] == "name" and sig[k - 1][1] in CONDITIONS:
                # `if (fromUrl.work)` asks whether a deep link names a work. Marked so it is not
                # read as an argument to whatever call happens to be further out.
                stack.append(("cond", None))
            else:
                stack.append(("group", None))
        elif text == "${":
            stack.append(("interp", None))
        elif text in ("[", "{"):
            stack.append(("group", None))
        elif text in (")", "]", "}"):
            if stack:
                stack.pop()
        # `?.` reads a field exactly as `.` does. `SERIES?.series` is a read and a rule that only
        # knew about `.` would let an optional chain through.
        if kind != "punct" or text not in (".", "?."):
            continue
        if k + 1 >= len(sig) or sig[k + 1][0] != "name":
            continue
        # `a.title.ja` is read as `title.ja`; the longer accessor is preferred so a rule about
        # `title.ja` is not answered by a rule about `ja`.
        one = sig[k + 1][1]
        two = None
        if k + 3 < len(sig) and sig[k + 2][1] in (".", "?.") and sig[k + 3][0] == "name":
            two = f"{one}.{sig[k + 3][1]}"
        hit = two if two in accessors else (one if one in accessors else None)
        if not hit:
            continue
        # A DOM data attribute is not a field of the built data. `row.dataset.work` carries the
        # minted identifier a click has to resolve, and it got there as an escaped attribute.
        if k and sig[k - 1][1] == "dataset":
            continue
        # A property being WRITTEN or DEFINED is not a read of the built data: `{ work: r.work }`
        # defines `work` and reads `r.work`, and only the second is a field of a row.
        after = k + (3 if hit == two else 1) + 1
        nxt = sig[after][1] if after < len(sig) else ""
        # A METHOD CALLED ON THE VALUE IS THE CONSUMER. `a.work.localeCompare(b.work)` reads more
        # clearly as sorting than as whatever call encloses the comparator, and the enclosing call
        # is what the stack would otherwise report.
        if nxt in (".", "?.") and after + 2 < len(sig) and sig[after + 2][1] == "(":
            consumer = f"through:{sig[after + 1][1]}"
        elif nxt in TEST_OPS or _compared_before(sig, k, hit == two):
            consumer = "tested"
        else:
            consumer = "bare"
            for entry in reversed(stack):
                if entry[0] == "call":
                    consumer = f"through:{entry[1]}"
                    break
                if entry[0] == "interp":
                    consumer = "interpolated"
                    break
                if entry[0] == "cond":
                    consumer = "tested"
                    break
        out.append((hit, pos, consumer))
    return out


def _compared_before(sig, k, is_pair):
    """Whether a comparison operator sits immediately in front of this read.

    A COMPARISON IS A COMPARISON IN EITHER ORDER, and this only looked at the operator AFTER the
    read. `x !== ln.name` and `ln.name !== x` say the same thing, and the first came back as a read
    consumed by whatever call enclosed it, which for a `.filter(...)` is the filter. That makes the
    rule depend on which side of `!==` somebody wrote the field, which is not a distinction the
    guarantee rests on. The token before the read's base identifier answers it.

    NOT WIDENED FURTHER ON PURPOSE. `f(a, b.name)` has a comma in front and stays a read, and
    `x || r.work` has `||`, which yields the title when there is one and so passes the value
    straight through; `TEST_OPS` leaves `||` out for exactly that reason and this shares the list.
    """
    base = k - (4 if is_pair else 2)
    return base >= 0 and sig[base][1] in TEST_OPS


def line_of(src, pos):
    return src.count("\n", 0, pos) + 1


# Reads outside an entry point that are not a rendering. Each names the function doing the reading,
# the field, what it does with the value, and why that is not a name reaching a page. The consumer
# is part of the key on purpose: adding `esc(r.work)` to a function already allowed to sort on
# `r.work` is a different consumer and fails.
# Consumers that cannot put anything on a page, whatever they are handed. Named here rather than
# once per call site, because each is a whole category and repeating it twenty times would bury the
# entries below that are about one place.
NOT_SHOWN = {
    "searchIndex": "the search index: it matches on every form of a name and shows none of them",
    "norm": "the same index's normaliser",
    "hits": "asking whether an index matches a query",
    "foldKey": "the key the name store is keyed on",
    "localeCompare": "an ordering",
    # A LOOKUP THAT ANSWERS WITH A RECORD. Interpolating one prints `[object Object]`, so nothing
    # it is handed can reach a page through it. `nameFor` is deliberately NOT here and has entries
    # in SAFE instead: it returns its third argument when there is one, and that argument is a
    # string, so it CAN hand a name straight back.
    "pubRec": "the publisher registry lookup, which answers with a record and not with a name",
}

# Reads outside an entry point that are not a rendering. Each names the function doing the reading,
# the field, what is done with the value, HOW MANY there are, and why that is not a name reaching a
# page.
#
# THE NUMBER IS LOAD-BEARING AND WAS ADDED AFTER THE PROBE GOT THROUGH. Keyed on the triple alone,
# an exception covers every read that matches it, so `renderReleases` was allowed one
# `String(w.creator)` for its search key and a second one splitting the field apart for display
# went unremarked. That is the fourth historical fault, laundered by the table meant to make
# exceptions visible. A count turns each entry into a statement about the file, so a read added
# beside an allowed one fails, and a read taken away fails too rather than leaving a line here
# claiming something nobody does any more.
SAFE = {
    # A work IDENTIFIER, which shares a field name with a title and is not one. `navState().work`
    # is the minted id in the address bar, opaque by design so a published address keeps resolving.
    ("navUrl", "work", "bare"): (
        1, "the identifier a work page is addressed by, on its way into a URL"),
    ("navUrl", "work", "through:set"): (
        1, "the same identifier, written into a query string"),
    ("navApply", "work", "bare"): (
        1, "the identifier a deep link names"),

    # Sorting on the Japanese, because that is the order asked for: the yomi order on the catalogue
    # tab is an order over Japanese, and a romanisation would sort it somewhere else.
    ("renderCat", "t", "bare"): (
        1, "the yomi comparator falls back to the title when a row carries no reading"),

    # Keys. A string used to group rows or to strip a prefix, never drawn.
    ("compactList", "work", "bare"): (
        1, "rows for one work on one platform are grouped on the title as written"),
    ("epLine", "work", "bare"): (
        1, "the work's own name, taken off the front of its chapter name"),

    # A row being built, not rendered. `predictedRows` synthesises the chapter a platform has
    # announced but not yet posted, and it copies the fields across so the row it hands back is the
    # shape every renderer already knows. Those renderers then call the entry points on it.
    ("predictedRows", "work", "bare"): (
        1, "copying the title onto a synthesised row, which is rendered like any other"),
    ("predictedRows", "author", "bare"): (
        1, "copying the byline onto the same row"),
    ("predictedRows", "work", "through:String"): (
        1, "the same row, ordered against the others before it is handed back"),

    # `creditLine` HAD AN EXCEPTION HERE AND DOES NOT NEED ONE. It read the byline to split it on
    # the slash, which is a second answer to how a credit divides and the reason `安田剛助・文尾文`
    # reached a reader as `???? · Bun?Bun`. It is a ruled entry point in `adapters/interface.py`
    # now, so the read is inside a renderer and the exception went with the split.

    # The credit field folded into a row's search key, where the row is built once and filtered
    # afterwards. `String` is the innermost call, so this cannot be answered by NOT_SHOWN above.
    ("renderReleases", "creator", "through:String"): (
        1, "the credit field on its way into the row's search key"),

    # THE TITLE AS A LOOKUP KEY, not as a title. The work page shows where an official or licensed
    # English title came from, and the citation is a source name, an address and a date; the title
    # itself is drawn by `workLabel` in the heading above it. `nameFor` is the lookup every
    # renderer performs, and here it is the whole of what is wanted.
    ("renderWorkPage", "work", "through:nameFor"): (
        1, "the title as a key, to reach the citation for its own English name"),

    # THE CREDIT PAGE'S OWN NAME AS A LOOKUP KEY. The heading is drawn by `authorLabel` two lines
    # below; this reads the record for the reading, the romanisation and the identifier, which are
    # what the page is for. Same shape and same reason as `renderWorkPage` above, and `nameFor` is
    # not in NOT_SHOWN because it hands its third argument straight back.
    ("renderCreditPage", "credit", "through:nameFor"): (
        1, "the credit as a key, to reach the record holding its reading and its address"),
}


def _refuse_bad_safe():
    for key, (_n, why) in SAFE.items():
        fn, field, consumer = key
        if consumer == "interpolated" or consumer == f"through:{OUTPUT[0]}":
            raise ValueError(
                f"SAFE names {fn} putting {field} on a page through {consumer}, which is the fault "
                f"this module exists to find. An exception cannot be the place a leak is parked. "
                f"({why})")


_refuse_bad_safe()


# ── 併記: a renderer that answers in one language has to be asked twice ────────────────────────
#
# WHAT WENT WRONG. `workLabel` and `authorLabel` each test `LANG === 'en'` and otherwise answer in
# Japanese, because 併記 is `bilingual()`'s job: it calls a renderer once per language with LANG
# forced and stacks the two lines. Asked directly with the toggle on 併記 they answer in Japanese
# and say nothing about it, so the work page heading, the 作品 rows, the 発売 rows and the works
# list on a credit or a publisher page all lost their English half. Every one of them looked right
# in ja and in en, which is why it survived a reader, a build and a green gate.
#
# The reads rule above cannot see this. Those call sites DO go through the renderer, which is the
# whole of what it asks.
#
# WHAT IS ASSERTED. Every call to one of `ONE_LANGUAGE` sits inside a call to `bilingual` or to
# `inLang`, or inside a callback handed to `bilingual` by name, or is named in `PASSES_ON` below.
#
# §14b, WHAT THIS CANNOT SEE. It reads call sites and not output, so a renderer added to app.js
# and left out of `ONE_LANGUAGE` is invisible to it. `creditText` and `personShown` compose names
# without going through the three below and are not covered today.
ONE_LANGUAGE = {
    "workLabel": "a title, in the reader's language",
    "authorLabel": "a byline, in the reader's language",
    "workTextOf": "a collection's title, which is a title",
    "creditNames": "the people in a credit field, each rendered by authorLabel",
    "creditChip": "one credited name, with the address of its page",
    "linkedCredits": "a whole byline, linked name by name",
    "creditLine": "the same byline, with the tail counted where it is long",
    "epText": "a chapter name with the work's own name taken off the front",
}
WRAPPERS = ("bilingual", "inLang")

# A call from one of the above into another. The obligation passes to the OUTER one's callers, and
# each entry says which caller carries it, so an entry cannot stand for a site nobody wraps. Keyed
# with a count for the reason SAFE is: an entry with no number covers a second call added beside
# the first.
PASSES_ON = {
    ("creditNames", "authorLabel"): (
        1, "the 発売 row wraps creditNames, and the row is built once per language"),
    ("creditChip", "authorLabel"): (
        1, "a chip is wrapped where it is placed: in linkedCredits, or on the credit page"),
    ("linkedCredits", "authorLabel"): (
        2, "the byline the work page draws, wrapped at the fact it fills"),
    ("linkedCredits", "creditChip"): (
        1, "the same byline, one linked name at a time"),
    ("creditLine", "linkedCredits"): (
        3, "the 作者 fact on the work page wraps creditLine: the short byline, the shortened one, "
           "and the whole byline again where the shortening could not place its names"),
    ("epText", "workTextOf"): (
        1, "the 更新 row wraps epText, and epText only runs at all in English"),
}


def _bilingual_callbacks(sig):
    """Source spans of every `const NAME = …` that `bilingual(NAME)` is handed.

    `bilingual(row)` and `bilingual(line)` pass a function by name, so a call inside that
    function's body is wrapped without any `bilingual(` enclosing it lexically. Without this the
    rule reports the two tabs that have been correct the longest.
    """
    byref = {sig[k + 2][1] for k in range(len(sig) - 3)
             if sig[k][1] == "bilingual" and sig[k + 1][1] == "(" and sig[k + 2][0] == "name"
             and sig[k + 3][1] in (")", ",")}
    spans = []
    for k in range(len(sig) - 2):
        if sig[k][1] not in ("const", "let") or sig[k + 1][0] != "name":
            continue
        if sig[k + 1][1] not in byref or sig[k + 2][1] != "=":
            continue
        depth, j = 0, k + 3
        while j < len(sig):
            t = sig[j][1]
            if t in ("(", "[", "{", "${"):
                depth += 1
            elif t in (")", "]", "}"):
                depth -= 1
            elif t == ";" and depth == 0:
                break
            j += 1
        spans.append((sig[k + 3][2], sig[min(j, len(sig) - 1)][2]))
    return spans


def single_language_findings(src, renderers=None, passes_on=None):
    """Every call to a one-language renderer that no 併記 wrapper encloses."""
    renderers = ONE_LANGUAGE if renderers is None else renderers
    passes_on = PASSES_ON if passes_on is None else passes_on
    toks = tokens(src)
    if "".join(t[1] for t in toks) != src:
        return ["the tokeniser did not read kari/app.js back byte for byte, so nothing below can "
                "be relied on"]
    sig = _significant(toks)
    spans = function_at(toks)
    callbacks = _bilingual_callbacks(sig)
    bad, seen, stack = [], {}, []
    for k, (kind, text, pos) in enumerate(sig):
        if text == "(":
            stack.append(sig[k - 1][1] if k and sig[k - 1][0] == "name" else None)
        elif text in ("[", "{", "${"):
            stack.append(None)
        elif text in (")", "]", "}"):
            if stack:
                stack.pop()
        if kind != "name" or text not in renderers:
            continue
        if k + 1 >= len(sig) or sig[k + 1][1] != "(":
            continue
        # The declaration is not a call. `function workLabel(r)` reads as one to a rule that only
        # looks for a name followed by a bracket.
        if k and sig[k - 1][1] == "function":
            continue
        if any(c in WRAPPERS for c in stack):
            continue
        if any(a <= pos <= b for a, b in callbacks):
            continue
        holder = None
        for name, a, b in spans:
            if a <= pos <= b and (holder is None or a >= holder[1]):
                holder = (name, a)
        fn = holder[0] if holder else "(top level)"
        key = (fn, text)
        if key in passes_on:
            seen[key] = seen.get(key, 0) + 1
            if seen[key] <= passes_on[key][0]:
                continue
            bad.append(f"kari/app.js:{line_of(src, pos)}: {fn} calls {text} {seen[key]} times "
                       f"outside 併記; the entry below allows {passes_on[key][0]} "
                       f"({passes_on[key][1]})")
            continue
        bad.append(f"kari/app.js:{line_of(src, pos)}: {fn} calls {text} outside bilingual(), so "
                   f"under 併記 it answers in Japanese alone ({renderers[text]})")
    for key, (n, why) in sorted(passes_on.items()):
        if seen.get(key, 0) != n:
            bad.append(f"PASSES_ON says {key[0]} calls {key[1]} {n} time(s) and it happens "
                       f"{seen.get(key, 0)}; the entry is stale ({why})")
    return bad


def undrawn_findings(src, undrawn=None):
    """Every read of a field ruled as one nothing draws, whose value reaches a page.

    THE SECOND HALF OF THIS MODULE'S JOB, AND IT HAD ONLY THE FIRST. `interface.unruled` requires a
    ruling for every field the data carries Japanese in, and the two answers are a SURFACE, which
    names the function that renders it, or a path in `interface.NOT_DRAWN`, which says nothing puts
    it on a page. `findings` above holds the first answer to account. Nothing held the second, so
    it was asserted 46 times and verified none.

    IT COST 383 WORKS. A volume's `designation` was added on 2026-08-12, ruled here on the
    reasoning that nothing drew it, and drawn by the same change with `esc`. Neither guard could
    see it: `English mode has no Japanese` renders the surfaces and this walked the surfaces, and
    the field was in neither list. `ゆるゆり 特装版小冊子電子版` was on an English page for four
    hours.

    ESCAPED OR INTERPOLATED, which is the same pair `_refuse_bad_safe` already treats as the
    definition of reaching a page. A read consumed by anything else is a read for logic: a test, a
    map key, a comparison, an argument to something that decides rather than draws.

    §14b, what it cannot see. The accessor is the field's last name, so two rulings sharing one
    name share one answer: `series[].evidence[].source` is QUOTED and `series[].sources[].platform`
    is NOT_DRAWN, and a third `source` added under a NOT_DRAWN path would be allowed by the first.
    The fault this exists for is a NEW field name drawn without a renderer, which no other ruling
    covers, and that is the shape the designation had.
    """
    undrawn = interface.NOT_DRAWN if undrawn is None else undrawn
    by_accessor = {}
    for path in undrawn:
        accessor = path.rstrip("[]").split(".")[-1].replace("[]", "")
        if accessor:
            by_accessor.setdefault(accessor, []).append(path)
    # A NAME ALSO RULED AS QUOTED IS NOT ASKED ABOUT, because the quotation is what draws it.
    for path in interface.QUOTED:
        accessor = path.rstrip("[]").split(".")[-1].replace("[]", "")
        by_accessor.pop(accessor, None)
    toks = tokens(src)
    if "".join(x[1] for x in toks) != src:
        return ["the tokeniser did not read kari/app.js back byte for byte, so nothing below can "
                "be relied on"]
    bad = []
    for accessor, pos, consumer in reads(toks, set(by_accessor)):
        if consumer != "interpolated" and not str(consumer).startswith("through:esc"):
            continue
        paths = ", ".join(sorted(by_accessor[accessor]))
        bad.append(f"line {line_of(src, pos)}: `{accessor}` reaches the page {consumer}, and "
                   f"{paths} is ruled as a field nothing draws. Either it needs a surface naming "
                   f"the function that renders it, or it belongs in interface.QUOTED with a reason")
    return sorted(set(bad))


def findings(src, surfaces=None, safe=None):
    """Every read of a name-carrying field that does not go through its entry point."""
    surfaces = interface.SURFACES if surfaces is None else surfaces
    safe = SAFE if safe is None else safe
    entry_of, why_of = {}, {}
    for s in surfaces:
        for accessor in s.accessors:
            entry_of.setdefault(accessor, set()).update(s.entry)
            why_of.setdefault(accessor, s.why)
    toks = tokens(src)
    if "".join(t[1] for t in toks) != src:
        return ["the tokeniser did not read kari/app.js back byte for byte, so nothing below can "
                "be relied on"]
    spans = function_at(toks)
    bad, seen = [], {}
    for accessor, pos, consumer in reads(toks, set(entry_of)):
        entries = entry_of[accessor]
        holder = None
        for name, a, b in spans:
            if a <= pos <= b and (holder is None or a >= holder[1]):
                holder = (name, a)
        fn = holder[0] if holder else "(top level)"
        if fn in entries:
            continue
        if consumer.startswith("through:") and consumer[len("through:"):] in entries:
            continue
        # A CONDITION IS NOT A RENDERING. `r.author ? … : ''` asks whether there is a byline, and
        # the answer is a yes or a no rather than a name, so it needs no entry in the table below.
        if consumer == "tested":
            continue
        if consumer.startswith("through:") and consumer[len("through:"):] in NOT_SHOWN:
            continue
        key = (fn, accessor, consumer)
        if key in safe:
            seen[key] = seen.get(key, 0) + 1
            if seen[key] <= safe[key][0]:
                continue
            bad.append(f"kari/app.js:{line_of(src, pos)}: {fn} reads {accessor} and {consumer} "
                       f"{seen[key]} times; the exception below allows {safe[key][0]} "
                       f"({safe[key][1]})")
            continue
        bad.append(f"kari/app.js:{line_of(src, pos)}: {fn} reads {accessor} and {consumer}; "
                   f"{'/'.join(sorted(entries))} is what renders it ({why_of[accessor]})")
    # An exception nobody exercises is a claim about a file that has moved on, and leaving it would
    # let the next read of that field in that function pass on somebody else's reasoning.
    for key, (n, why) in sorted(safe.items()):
        if seen.get(key, 0) != n:
            bad.append(f"SAFE says {key[0]} reads {key[1]} and {key[2]} {n} time(s) and it happens "
                       f"{seen.get(key, 0)}; the exception is stale ({why})")
    return bad


def _self_test():
    """Reintroduce each fault this was written for and require a catch.

    A lint that passes on today's file has proved nothing about tomorrow's, so the probes below are
    the four escapes that actually shipped, written back into a copy of the source.
    """
    src = interface.APP_JS.read_text(encoding="utf-8")
    ok = (not findings(src) and not single_language_findings(src)
          and not undrawn_findings(src))
    print(f"{'ok' if ok else 'FAIL'}  kari/app.js as it stands: "
          f"{len(findings(src))} read finding(s), "
          f"{len(single_language_findings(src))} 併記 finding(s), "
          f"{len(undrawn_findings(src))} undrawn-and-drawn finding(s)")
    probes = [
        (findings, "the catalogue tab prints index.json's title raw",
         "${workLabel({ work: w.t })}", "${esc(w.t)}"),
        (findings, "the 発売 tab labels a volume from the record title",
         "const label = workLabel({ work: w.title.ja });", "const label = esc(w.title.ja);"),
        (findings, "a byline interpolated straight into the row",
         "${authorLabel(r)}", "${r.author}"),
        (findings, "the credit field pulled apart outside its entry point",
         "const people = creditNames(w.creator);",
         "const people = String(w.creator || '').split('/').map(esc).join(' / ');"),
        # The 併記 escapes, each one a heading or a row that shipped in Japanese alone.
        (single_language_findings, "the work page heading asks the renderer once",
         "${bilingual(() => workLabel(r))}", "${workLabel(r)}"),
        (single_language_findings, "the credit page heading asks it once",
         "${bilingual(() => authorLabel({ author: fact.credit }))}",
         "${authorLabel({ author: fact.credit })}"),
        (single_language_findings, "the works list on a record page asks it once",
         "bilingual(() => workLabel(w))}</a>", "workLabel(w)}</a>"),
        (single_language_findings, "the work page byline asks it once",
         "r.author ? bilingual(() => creditLine(r))", "r.author ? creditLine(r)"),
        (single_language_findings, "the 発売 row is built for one language",
         '`<div class="relv">${bilingual(row)}</div>`', '`<div class="relv">${row(LANG)}</div>`'),
        (single_language_findings, "the 作品 index row is built for one language",
         "<span>${bilingual(() => `", "<span>${(() => `"),
        # THE FAULT OF 2026-08-12, WRITTEN BACK AS IT SHIPPED. A volume's designation was ruled a
        # field nothing draws and drawn with `esc` by the same change. It has a surface now, so the
        # probe rules it undrawn again and puts the call site back, which is both halves of what
        # went wrong and is the only probe here that needs the ruling moved as well as the code.
        (lambda s: undrawn_findings(s, {"works[].volumes[].designation": "nothing draws it"}),
         "a volume's designation escaped straight into the row",
         "const lab = volLabel(v);\n      const n = lab\n        ? `<span class=\"voln${v.number "
         "? '' : ' vdesig'}\">${esc(lab)}</span>` : '';",
         "const n = v.number ? `<span class=\"voln\">${esc(volLabel(v))}</span>`\n        : "
         "(v.designation ? `<span class=\"voln vdesig\">${esc(v.designation)}</span>` : '');"),
    ]
    caught = 0
    for rule, what, before, after in probes:
        if before not in src:
            print(f"  ?    {what}: the line it replaces is not in kari/app.js any more")
            continue
        got = rule(src.replace(before, after, 1))
        if got:
            caught += 1
            print(f"  ok   {what}: caught, {got[0].split(': ', 1)[1][:70]}")
        else:
            print(f"  FAIL {what}: NOT caught")
    print("CANARY-PROVEN" if caught == len(probes) else "canary uncaught")
    return 0 if ok and caught == len(probes) else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--app", default=None)
    a = ap.parse_args()
    if a.self_test:
        return _self_test()
    src = pathlib.Path(a.app or interface.APP_JS).read_text(encoding="utf-8")
    bad = findings(src)
    for b in bad:
        print(f"  {b}")
    print(f"{len(bad)} field read(s) that do not go through an entry point")
    one = single_language_findings(src)
    for b in one:
        print(f"  {b}")
    print(f"{len(one)} renderer call(s) that 併記 never reaches")
    drawn = undrawn_findings(src)
    for b in drawn:
        print(f"  {b}")
    print(f"{len(drawn)} field(s) ruled as undrawn that reach a page")
    return 1 if bad or one or drawn else 0


if __name__ == "__main__":
    sys.exit(main())
