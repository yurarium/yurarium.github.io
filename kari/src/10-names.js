/* ── 併記 as two complete lines ───────────────────────────────────────────────────────────────
   併記 means "show both", and the first attempt read it as "add an English title underneath",
   which left a compact row at three lines (Japanese row / English title / platform) and every
   badge stubbornly Japanese. Taken at its word instead: render the WHOLE row once in each
   language and stack the two. Everything that can be translated is, on its own line, so the
   English line is a row a reader of English can use without reference to the one above it.
   Duplication is the point, not a cost to minimise.

   `inLang` renders a fragment as if the toggle were set to one language. Every label helper
   already reads LANG, so nothing else has to know this is happening. */
function inLang(lang, fn) {
  const prev = LANG;
  LANG = lang;
  try { return fn(); } finally { LANG = prev; }
}

/* One row, or two stacked and distinguished. `render(lang)` must produce a complete row.

   TWO IDENTICAL LINES ARE ONE LINE. 127 works are titled in Latin script alone: citrus, MURCIELAGO,
   GIRL FRIENDS, Girl@Girl. There is no Japanese form to put above the English because the Japanese
   form IS the English one, so 併記 stacked `citrus` over `citrus` and the work page's heading read
   the name twice. This is not the duplication the note above defends: that one is about each line
   being a COMPLETE row, and a second line that repeats the first character for character is not a
   row a reader of either language gets anything from. Compared after rendering rather than by
   asking whether the title has kanji, because the row is the thing that has to differ and any of
   its parts may be what differs. */
function bilingual(render, cls) {
  if (LANG !== 'both') return render(LANG);
  const ja = inLang('ja', () => render('ja'));
  const en = inLang('en', () => render('en'));
  if (ja === en) return ja;
  return `<span class="bi ${cls || ''}">${ja}<span class="bi-en">${en}</span></span>`;
}

/* ── English names and readings ──────────────────────────────────────────────────────────────
   The build ships a kana reading plus all three romanisation styles precomputed, because the
   stored form is kana (NAMES-PLAN §8.1) and the style is the reader's choice: Yūri / Yuuri / Yuri
   are all derivable from kana and none from each other, so nothing is baked and no romanisation
   engine ships to the browser.

   A record is absent for most works, and that is a finished state, not a gap: §6 says show the
   Japanese. So every function here returns null rather than a placeholder when it has nothing. */
const PREF_ROMAJI = 'yurarium.pref.romaji';
const PREF_FURI   = 'yurarium.pref.furigana';
const PREF_ENORDER = 'yurarium.pref.enorder';
const PREF_DIALECT = 'yurarium.pref.dialect';
let ROMAJI_STYLE = prefGet(PREF_ROMAJI, 'macron');
const PREF_NORDER = 'yurarium.pref.nameorder';
/* Family first by default: it is how the name is written, and this is a Japanese database. */
let NAME_ORDER = prefGet(PREF_NORDER, 'family');
let FURIGANA     = prefGet(PREF_FURI, false);

/* WHICH ENGLISH, IN WHAT ORDER. The build ships every English form it holds for a work under
   `en_forms`, keyed by what makes it that form, plus the romanisation separately. This was a fixed
   precedence in the code: the work's own name, then a licensor's, then ours, then the romanisation.
   That order is defensible and it is still the default, but it is a preference and not a fact, and
   a reader who knows a series by what its licensor calls it should not have to know that we think
   the Japanese publisher's English outranks it.

   `romaji` is a level like the others, and it is the one that makes the control worth having: a
   reader who would rather see Anata no Tonari than a translation nobody has checked can put it at
   the top and get romanisations throughout. */
const EN_LEVELS = ['licensed', 'official-jp', 'translated', 'romaji'];
const EN_LEVEL_LABEL = {
  'licensed':    ['ライセンス版', 'Licensed'],
  'official-jp': ['公式英題', 'Official'],
  // Named for what it is. NAMES-PLAN §5 calls this `translated` and marks it as ours in the
  // interface; from the reader's side the honest word for who did the translating is this one.
  'translated':  ['機械翻訳', 'Machine translation'],
  'romaji':      ['ローマ字', 'Romanisation'],
};
const EN_DEFAULT = ['official-jp', 'licensed', 'translated', 'romaji'];

function enOrder() {
  const saved = prefGet(PREF_ENORDER, null);
  if (!Array.isArray(saved)) return EN_DEFAULT.slice();
  // Repaired rather than trusted. A stored order from an older build may be missing a level that
  // has since been added, and a level absent from the list would be unreachable for ever with
  // nothing on screen to say why.
  const clean = saved.filter(x => EN_LEVELS.includes(x));
  return clean.concat(EN_LEVELS.filter(x => !clean.includes(x)));
}
let EN_ORDER = enOrder();

/* SPELLING. Applied to text WE wrote and to nothing else: a licensed or official English title is
   a name, and names are not respelt. Kodansha publishes The Moon on a Rainy Night, and if a
   licensor spells a title with -ize then that is the title.

   Suffix rules are unusable here: this page is full of romaji, and a rule that rewrites -our or
   -re eats Kaeru, Namae, Sumire and Mae. So it is a dictionary, whole words only, case kept. */
const SPELL_US = {
  colour:'color', colours:'colors', coloured:'colored', colourful:'colorful',
  favour:'favor', favours:'favors', favourite:'favorite', favourites:'favorites',
  honour:'honor', honours:'honors', neighbour:'neighbor', neighbours:'neighbors',
  behaviour:'behavior', flavour:'flavor', flavours:'flavors', humour:'humor',
  rumour:'rumor', rumours:'rumors', savour:'savor', harbour:'harbor', labour:'labor',
  romanisation:'romanization', romanise:'romanize', romanised:'romanized', romanising:'romanizing',
  realise:'realize', realised:'realized', realises:'realizes', realising:'realizing',
  emphasise:'emphasize', normalise:'normalize', capitalise:'capitalize',
  summarise:'summarize', analyse:'analyze', analysed:'analyzed', initialise:'initialize',
  recognise:'recognize', recognised:'recognized', apologise:'apologize',
  organise:'organize', organised:'organized', memorise:'memorize', memorised:'memorized',
  theatre:'theater', theatres:'theaters', centre:'center', centres:'centers',
  metre:'meter', metres:'meters', litre:'liter', litres:'liters', fibre:'fiber',
  grey:'gray', greyer:'grayer', jewellery:'jewelry', practise:'practice',
  travelling:'traveling', travelled:'traveled', traveller:'traveler',
  cancelled:'canceled', cancelling:'canceling', marvellous:'marvelous',
  defence:'defense', offence:'offense', pretence:'pretense', licence:'license',
  catalogue:'catalog', dialogue:'dialog', mould:'mold', moustache:'mustache',
  plough:'plow', pyjamas:'pajamas', storey:'story', storeys:'stories',
};
let DIALECT = prefGet(PREF_DIALECT, 'gb');
const PREF_DATEFMT = 'yurarium.pref.datefmt';
let DATEFMT = prefGet(PREF_DATEFMT, 'iso');

/* Every preference that changes what a render produces. Anything cached on a render must key on
   this rather than on a hand-picked subset: a cache that names four of six settings serves a
   stale view for the other two, which reads to a reader as the feature being broken. */
const RENDER_PREFS = () => [LANG, FURIGANA, ROMAJI_STYLE, NAME_ORDER, DIALECT, DATEFMT, EN_ORDER];
/* TYPOGRAPHY, applied at display time and never stored. Straight quotes are a typewriter
   limitation, and the page has no reason to inherit one.

   Applied to LICENSED and OFFICIAL titles too, unlike the spelling switch, because the shape of an
   apostrophe is not part of a name the way its spelling is: There's and There’s are the same
   title set in different type, where realise and realize are different words.

   Display time rather than in the data, so the stored string stays ASCII. That is what the search
   index is built from, so a reader typing an ordinary apostrophe still matches, and it keeps the
   YAML greppable. */
function curly(s) {
  if (!s) return s;
  return String(s)
    .replace(/"([^"]*)"/g, '\u201c$1\u201d')
    // PAIRS BEFORE APOSTROPHES. The other order turned the closing half of 'Manslayer' into an
    // apostrophe, because a quote after a letter and before a space is exactly what the Eguchis'
    // looks like. A pair is unambiguous, so it is claimed first and what is left is an apostrophe.
    .replace(/(^|[\s(\[\u2014])'([^']+)'(?=[\s.,;:!?)\]\u2014]|$)/g, '$1\u2018$2\u2019')
    .replace(/(\p{L})'(?=\p{L})/gu, '$1\u2019')
    .replace(/(\p{L})'(?=\s|$|[,.;:!?)\]])/gu, '$1\u2019');
}


function respell(s) {
  if (DIALECT !== 'us' || !s) return s;
  return s.replace(/[A-Za-z]+/g, w => {
    const hit = SPELL_US[w.toLowerCase()];
    if (!hit) return w;
    // Preserve the case the author used: Colour at the start of a title must not become color.
    if (w === w.toUpperCase() && w.length > 1) return hit.toUpperCase();
    if (w[0] === w[0].toUpperCase()) return hit[0].toUpperCase() + hit.slice(1);
    return hit;
  });
}

const HAS_KANJI = /[\u4e00-\u9fff]/;

/* Whole-string ruby: NAMES-PLAN §5c level 1. Per-kanji alignment is level 2 and is not attempted
   here: ruby over the wrong character is worse than none, and unlike a whole-string reading it is
   wrong in a specific, visible place. Suppressed when the title has no kanji, because furigana over
   ワインガールズ tells a reader nothing they cannot already read. */
/* Ruby per KANJI RUN. The build ships spans aligned with the anchor algorithm, so 雨夜の月 gets
   あまよ over 雨夜 and つき over 月, with の bare. The earlier version stacked the whole reading over
   the whole title, which is not how furigana works and broke the column on long titles.
   No length cap is needed any more: aligned ruby wraps with the text it annotates. */
function ruby(ja, rec) {
  if (!FURIGANA || !rec || !rec.ruby || !HAS_KANJI.test(ja)) return esc(ja);
  /* WHAT KIND OF READING THIS IS, not merely whether to doubt it. `researched` is a person's
     decision with a reason recorded, which is the same standing a translation has on the English
     side and deserves the same treatment: shown as ours, not as a machine's guess. */
  const cls = rec.reading_basis === 'researched' ? ' class="rt-said"'
            : rec.unverified ? ' class="rt-guess"' : '';
  return rec.ruby.map(([text, rd]) => rd
    ? `<ruby>${esc(text)}<rt${cls}>${esc(rd)}</rt></ruby>`
    : esc(text)).join('');
}

/* Names for rows that carry none. An archived month is written once and never rewritten (that is
   what protects its dates), so 2026-07 was frozen before any of this existed and every row in it
   showed Japanese only. Dates must not change; a romanisation improving is the system working. So
   the archive keeps its rows as published and the current names are joined on here, at render
   time, from one file covering every month.

   Folded exactly as the build folds, because （私に） and (私に) are different strings and the same
   work arrives as both. */
let NAMES = null;
/* SPELLING TO CREDIT IDENTIFIER. The registry unifies the spellings one person is written as, and
   this is that map, shipped so a search can reach them by any of it: `アオトヒビキ` finds the works
   credited to `あおと響`. Null until the boot loads it, and null is a working state, because the
   search that reads it falls back to matching the raw credit field the row carries. */
let CREDIT_KEYS = null;
function foldKey(t) {
  return (t || '').normalize('NFKC').replace(/ /g, '');
}
function nameFor(kind, raw, existing) {
  if (existing) return existing;
  if (!NAMES || !raw) return null;
  return NAMES[kind][foldKey(raw)] || null;
}

/* ── THE FLOOR UNDER AN ENGLISH PAGE ──────────────────────────────────────────────────────────

   THE RULE THIS FILE NOW KEEPS. An English page shows no kana and no kanji. Where nothing states
   how a name is read, it shows a mechanical romanisation and marks it, and the mark carries a
   tooltip saying the reading is not attested. That is the owner's ruling, and it reverses what
   this file used to do: 77 renderings fell through to the Japanese, because every English branch
   below ended in `return raw`.

   Showing incorrect kana in JAPANESE stays the least acceptable thing here, which is why none of
   this touches the Japanese side. Furigana and kana are exactly as they were. The asymmetry is the
   point: a reader in Japanese has the name itself and can judge our reading against it, and a
   reader in English has this string and nothing to fall back on.

   THE SPELLING IS THE BUILD'S. `adapters/names/romfloor.py` romanises every Japanese string that
   can reach a surface, in the reader's three styles, and ships them under `floor`. A romaniser
   written here would be a second producer of the one fact `kana.romanise` produces, which is the
   shape STANDING-INSTRUCTIONS §3 counts seven shipped bugs from. Nothing here spells anything.

   ONE SCRIPT CLASS FOR THE WHOLE FILE. `JA_TEXT` used to hold the same ranges four hundred lines
   below, and `adapters/interface.py` holds them a third time. The check that blocks tests these
   exact ranges, so a string that fails there has to be a string that fails here or the two
   disagree about what a reader can read. U+3005 repeats the character before it, so it belongs to
   a run and travels with its neighbour. */
const JA_ANY     = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u3005]/;
const JA_ANY_RUN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u3005]+/g;

/* THE MARK IS PLAIN TEXT AND THE TOOLTIP IS ADDED WHERE THERE IS MARKUP TO ADD IT TO.

   A credit line is composed as TEXT. `creditText` walks the field by index replacing spans of the
   original, `epText` strips a rendered work name off the front of a rendered chapter name, and the
   search index reads the same strings; markup inside any of those breaks arithmetic they do on
   characters. So a floored name carries `[?]` as part of its text, which is the same token
   `uncertainMark` has always shown, and `floorHtml` turns that token into the hoverable mark once
   the text has been escaped.

   THE DEGRADED CASE IS STILL RIGHT, which is why the mark is text and not a pair of control
   characters. A call site that forgets `floorHtml` shows `Ikuta Hana[?]` with no tooltip, and a
   reader can still see the claim is ours. A pair of control characters would have gone out
   invisible, which is the silence §4 is about. */
const FLOOR_MARK = '[?]';
const FLOOR_WHY = 'No source states how this name is read. It is romanised here by machine and '
                + 'may be wrong.';

/* WHAT THE CLASS MEANS, AND IT IS ONE SENTENCE: no source states how this name is read, so the
   Latin a reader is looking at is ours. `renderings resting on a mechanical romanisation` counts
   it by asking the interface for its markup, which makes this the one class name shared between
   this file and check.py, and the whole of the coupling: the check owns no copy of the rule that
   decides when to emit it.

   TWO PLACES EMIT IT AND THE STRING IS WRITTEN ONCE (§3). `floorHtml` marks a name the store holds
   nothing for, spelled out of the characters. `uncertainMark` marks a name whose reading came from
   a community database, spelled out of kana an anonymous editor typed. The second arrived with the
   project owner's correction of 2026-08-09: Wikidata raises the floor on the string and does not
   overcome the record's fallback basis, so a reading from it is a better spelling of a name still
   resting on our own work, and it belongs in the same count as the rest of them.

   `unc` WITHOUT `floor` IS STILL A DIFFERENT STATEMENT. It says we hold a reading nobody states,
   which is what an analyser's answer is: no editor typed it and there is no page to send anyone to.
   The floor class says the string is ours and names why. */
const FLOOR_CLASS = 'unc floor';

/* Escaped text on its way into a page, with the floor's mark made hoverable.

   ON ESCAPED TEXT ONLY. `uncertainMark` already emits this token inside a `<sup>`, so running this
   over composed markup would put a mark inside a mark. Every caller below hands over the output of
   `esc` and nothing else. */
function floorHtml(html) {
  return String(html ?? '').split(FLOOR_MARK).join(
    `<sup class="${FLOOR_CLASS}" title="${esc(FLOOR_WHY)}">${FLOOR_MARK}</sup>`);
}

/* What the build spelled for this string, in the style the reader chose.

   A STRING WHERE THE THREE STYLES AGREE, AND AN OBJECT WHERE THEY DIFFER. Two thirds of these
   hold no long vowel, so there is nothing for macron, doubled and plain to disagree about, and
   writing the same spelling three times put half a megabyte on a file that loads on every visit. */
function floorText(ja) {
  const f = NAMES && NAMES.floor && NAMES.floor[foldKey(ja)];
  if (!f) return null;
  return (typeof f === 'string' ? f : (f[ROMAJI_STYLE] || f.macron)) || null;
}

/* THE ANSWER OF LAST RESORT, AND IT IS TOTAL. Every English branch in this file ends here, and it
   returns no kana and no kanji whatever it is handed.

   A STRING WITH NO JAPANESE IN IT IS ITS OWN ENGLISH FORM and takes no mark: a Latin pen name is
   not a transliteration of anything, so folding `Ｍａｇｐｉｅ` to the width it is read at asserts
   nothing. Everything else is ours and is marked. Where the build spelled the whole string, that
   is the answer; where it did not, each Japanese run is spelled on its own, and a run the build
   never reached becomes question marks. That last one should be unreachable, because the build
   floors every string every surface carries, and it is written this way so that a hole in the map
   arrives as something a reader can see rather than as Japanese under an English heading. */
function enFallback(ja) {
  const s = String(ja ?? '').normalize('NFKC');
  if (!s || !JA_ANY.test(s)) return s;
  const whole = floorText(s);
  if (whole) return whole + FLOOR_MARK;
  return s.replace(JA_ANY_RUN, run => {
    const got = floorText(run);
    if (got) return got + FLOOR_MARK;
    /* WHETHER A ・ SEPARATES TWO PEOPLE IS NOT A QUESTION THIS FUNCTION MAY ANSWER, and the
       attempt is what this comment replaces. A reader met `???? · Bun?Bun` for 安田剛助・文尾文, so
       this branch was taught to offer each side of a ・ to the floor map and join the two answers.
       It spelled those two people, and it also reached `くろば・Ｕ` sitting inside a longer field
       and answered `Kuroba U`, one artist's name with the character taken out of the middle of it.
       A test made of "is each half in the floor map" agrees with whatever split filled the map, so
       it cannot tell 矢立肇・富野由悠季 from くろば・Ｕ (STANDING-INSTRUCTIONS §14b). The corpus
       settles that question in `adapters/names/interpunct.py` and the build ships the answer as
       `credit_parts`.

       The fault was upstream. `creditLine` cut the field on the slash and passed the pieces on as
       a field of their own, so the division shipped for the whole field was thrown away and the
       line fell to this function. It reads `creditPeople` now, and a credit field no longer
       arrives here with two people inside one run. */
    // THE INTERPUNCT IS PUNCTUATION SITTING IN THE KANA BLOCK, and the build keeps it out of a run
    // for that reason, so it is the one character here whose answer is not a reading.
    return Array.from(run).map(
      c => floorText(c) || (c === '\u30fb' ? ' \u00b7 ' : '?')).join('') + FLOOR_MARK;
  });
}

/* What this record can offer at each level. Kept separate from the choosing, so the popup can
   count what is available without duplicating the rules that decide what is shown. */
function enAvailable(rec) {
  if (!rec) return {};
  const out = Object.assign({}, rec.en_forms || {});
  // A record predating en_forms, or one whose only claim is the live one.
  if (rec.en && rec.basis && rec.basis !== 'romaji' && !out[rec.basis]) out[rec.basis] = rec.en;
  // basis 'romaji' is a ROMANISATION, so render it from the kana whenever we hold the kana,
  // otherwise the style control silently does nothing to it, which is exactly the failure §8.1
  // exists to prevent. Some records arrived as a romanised string with no reading behind it; those
  // fall back to the stored string and cannot follow the toggle. That is a property of the record,
  // not of the design, and it disappears as readings are filled in.
  const styled = rec.romaji && rec.romaji[ROMAJI_STYLE];
  /* A COMPANY'S NAME IS NOT RESPELT FROM ITS KANA. The rule above is about a PERSON, whose Latin
     name is their reading spelt out and should follow the style control. An organisation's is a
     string somebody decided, and ネジ式１３番地 is the case: the digits are part of the name, so it
     was settled as Nejishiki 13-banchi, which no speller reading ネジシキ ジュウサン バンチ can
     produce. Respelling it gave Nejishikijūsanbanchi beside its own name and Nejishiki 13-banchi
     beside its books, which is one name in two places and is what `names rendered two ways`
     counts. `kind` is what the store calls a credit that is not a person. */
  if (rec.kind && rec.en && rec.basis === 'romaji') out.romaji = rec.en;
  else if (styled) out.romaji = styled;
  else if (rec.en && rec.basis === 'romaji') out.romaji = rec.en;
  return out;
}

function enOf(rec) {
  if (!rec) return null;
  const have = enAvailable(rec);
  for (const level of EN_ORDER) {
    if (!have[level]) continue;
    const ours = level === 'translated' || level === 'romaji';
    // Respelt only where it is ours to respell. See SPELL_US.
    // Spelling is ours to change; typography applies to every form, including a
    // licensor's, because the shape of an apostrophe is not part of the name.
    const text = curly(ours ? respell(have[level]) : have[level]);
    // AN "ENGLISH NAME" THAT IS THE JAPANESE IS NOT AN ANSWER. MangaUpdates files 時一二 with an
    // English heading equal to the characters, so the store holds `en: 時一二` at basis `romaji`
    // and this function handed the kanji back as a rendering. Three credit lines and a work page
    // heading printed it under an English toggle with a [?] beside it, which reads as a claim that
    // this is how the name is written in English.
    //
    // SKIPPED RATHER THAN REFUSED, so a record whose first form is Japanese and whose second is
    // real still answers with the second. Where none of them is Latin the record answers nothing
    // and the caller reaches `enFallback`, which is where a name with no English belongs.
    if (JA_ANY.test(text)) continue;
    return { text, ours, unverified: !!rec.unverified, basis: level };
  }
  return null;
}

/* Marked when it is OURS or when the reading behind it is unverified; unmarked when it is the
   work's own English name or a licensor's. §5d: an unverified reading IS marked in the reader
   interface, and that is not a return of 要確認. It is a fact about the name, a reader who knows
   Japanese can judge it on sight, and it stops a real person being authoritatively misnamed. */
/* A reading we assembled character by character, because nothing could read the word. Marked
   visibly and separately from an ordinary guess: those are merely unsourced, this one is likely to
   be WRONG in a specific way a reader can see. The isolated reading of a character is often not
   its reading in a compound, so 抱き came out カカエ where it should be ダキ. The mark is the
   smallest thing that cannot be mistaken for part of the name. */
/* THE READING IS ATTESTED OR IT IS NOT, and that is the whole of what a reader can act on. There
   were three states here: our romanisation of a sourced reading, our romanisation of a guessed
   one, and a reading assembled character by character. The last two differ in how the guess was
   arrived at, which is our problem and not the reader's, and the first two looked identical.
   One mark now, on the binary.

   It matters most in English. A reader in Japanese who is shown no furigana still has the name
   itself; a reader in English has only this string and nothing to fall back on. */
function uncertainMark(rec, e) {
  // THE DOUBT IS ABOUT THE READING, so it only reaches a string the reading produced. A
  // romanisation is spelled out of the reading and inherits every doubt about it. A translation,
  // an official English name and a licensor's name do not: "Bloom Into You" is no less right for
  // our not knowing how the Japanese is pronounced. Marking on the reading alone put the mark on
  // essentially every title, and a mark on everything is not a mark.
  //
  // ASYMMETRIC, BECAUSE THE TWO READERS ARE. In English the romanisation is all there is, so an
  // unattested reading has to be marked. In Japanese the reader has the Japanese: the furigana is
  // already styled as a guess where it is one, and the characters themselves are right whatever we
  // think they sound like. Marking on the same rule there put 722 of these on one screen, which is
  // the flood this mark exists to avoid. So Japanese keeps the narrow trigger it always had, the
  // reading assembled character by character, which is the case worth interrupting a reader for.
  const unattested = rec && (e
    ? (e.basis === 'romaji' && (rec.uncertain || rec.unverified))
    : rec.uncertain);
  if (!unattested) return '';
  // THE SAME MARK, AND A DIFFERENT SENTENCE, WHERE A SOURCE DID PRINT THE KANA. The project owner
  // ruled on 2026-08-09 that Wikidata is noncanonical and is used to raise the floor on romaji, so
  // 73 readings hold `community-printed`: somebody typed the kana, and nobody who answers for the
  // person's name did. "not attested by any source" would be false of those, and dropping the mark
  // would be worse, because the pronunciation is exactly what is unconfirmed. So the superscript
  // stands and the tooltip says which of the two states this is.
  //
  // AND IT CARRIES THE FLOOR CLASS, which is the owner's correction of the same day: Wikidata does
  // not overcome the record's fallback basis, so a name resting on it is a name an English page
  // spells for itself and belongs in the count that says so. The sentence stays the specific one
  // rather than becoming FLOOR_WHY, because naming the community database tells a reader where to
  // go and settle it; the class and the tooltip answer two different questions and only the class
  // is counted.
  // ONE REGISTER ACROSS THE THREE. These two and FLOOR_WHY are three different statements and stay
  // three, but they were written in two styles: FLOOR_WHY a pair of sentences, these two lower-case
  // fragments with no stop. A reader hovering two marks in the same byline met both, which reads as
  // two different hands rather than as two different facts. All three are sentences now.
  const wikidata = rec.reading_basis === 'community-printed';
  const why = wikidata
    ? 'The reading this is romanised from comes from a community-edited database. No publisher '
      + 'or library confirms it.'
    : 'No source states the reading this is romanised from, and it may be wrong.';
  return `<sup class="${wikidata ? FLOOR_CLASS : 'unc'}" title="${esc(why)}">[?]</sup>`;
}

function enHtml(rec, cls, isPerson) {
  const e = enOf(rec);
  if (!e) return '';
  // A person's name follows the reader's order. Done here rather than at the call site so the
  // mark and the tooltip come with it: a swapped name that lost its [?] would be worse than one
  // in the wrong order.
  const shown = (isPerson && personName(rec)) || e.text;
  // A PERSON HAS NO TITLE. The same note was reaching a name and telling a reader that
  // "Tsumugi Meme" is "not an English title the work has", which is a sentence about a work said
  // about a person. isPerson is already known here, so it decides the wording too.
  // TWO DIFFERENT CLAIMS, and they were sharing a sentence. `unverified` says the READING behind
  // the Latin is unconfirmed, so the pronunciation itself is in doubt. `ours` with a romaji basis
  // says the reading IS attested and only the spelling is ours, where "not confirmed" would be
  // false. A translation is a third thing again: nothing about it is a pronunciation claim.
  const thing = isPerson ? 'name' : 'title';
  const who = isPerson ? 'person' : 'work';
  // A ROMANISATION OF A CONFIRMED READING NEEDS NO NOTE. Transliterating attested kana is
  // mechanical, not a judgement, and a note saying we did it tells a reader nothing they can act
  // on. What is worth saying is that a pronunciation is UNCONFIRMED, and that a title is our
  // English invention rather than one the work publishes. Silence everywhere else.
  // A THIRD CLAIM, AND THE QUIETEST OF THE THREE. `undivided` says the reading is attested and
  // states no word break, so the romanisation runs together: 太陽まりい is filed タイヨウマリイ by
  // the national media-arts catalogue, which is correct, and comes out `Taiyōmarii` when the
  // person is 太陽 まりい. Nothing about the characters says where a Japanese name divides, and
  // guessing publishes a wrong claim about somebody under their own work, so the run-on form
  // stands and this is what stops it standing as though it were settled.
  //
  // IT GETS THE UNDERLINE AND NOT THE [?]. The superscript says the pronunciation may be wrong,
  // which would be false here: the sounds are sourced and only the spacing is missing. It is also
  // the commoner state by far, and a superscript on one name in five is the flood `uncertainMark`
  // was narrowed to avoid.
  // A FOURTH CLAIM, AND IT IS THE UNDERLINE'S OTHER HALF. `undivided` says nothing states where a
  // name breaks; `division_basis` says something does and that something is a community-edited
  // database. アカイマルボロウ is a kana credit whose sounds are its own surface, so the [?] would be
  // false about it, and the only part of the rendering anybody typed is the SPACE. Eight people
  // reached a reader divided by an anonymous edit with no mark at all, because the doubt was
  // recorded on a different record of the same person and the interface never sees that one.
  // A FIFTH CLAIM, AND IT OUTRANKS THE PRONUNCIATION ONE. Where the kana are themselves a
  // transliteration, romanising them takes a reader FURTHER from the name than the Japanese did:
  // ステファン・セジク comes out `Sutefan Sejiku` and the person is Stjepan Šejić. Saying only that
  // the pronunciation is unconfirmed would be true and would send a reader looking for the wrong
  // thing, so this is said first. Nothing about a string can find it, since katakana pen names are
  // ordinary, so it is a ruling recorded per name in curated.yaml.
  const why = rec.transliterates
    ? `These kana spell a ${thing} from another language, and its own spelling has not been found, `
      + 'so what is shown is a transliteration of a transliteration.'
    : e.unverified
    ? `The pronunciation of this ${thing} has not been confirmed.`
    : (isPerson && e.basis === 'romaji' && rec.undivided)
      ? 'No source states where this name divides, so it is romanised as one word.'
      : (isPerson && e.basis === 'romaji' && rec.division_basis === 'community-printed')
        ? 'Where this name divides comes from a community-edited database, and no publisher or library confirms it.'
        : (e.ours && e.basis !== 'romaji')
          ? `Translated by us. The ${who} publishes no English ${thing}.`
          : '';
  // A NOTE ON EVERYTHING IS A NOTE ON NOTHING. Every name carried one, including the ones whose
  // note said only that the name is the one the work or person uses, which a reader can assume.
  // Annotate what is OURS; say nothing about what is theirs.
  // THE MARK GOES WITH THE NOTE, not with the category. `ours` was set on every name we spelt,
  // including a plain romanisation of an attested reading, which has nothing to say. That put a
  // dotted underline under a name and offered no tooltip when a reader went looking for one.
  const mark = why ? ' ours' : '';
  const tip = why ? ` title="${esc(why)}"` : '';
  return `<span class="en${mark} ${cls || ''}"${tip}>${esc(shown)}</span>${uncertainMark(rec, e)}`;
}

/* Titles: EN replaces the Japanese, and in 併記 the whole ROW is rendered again in English by
   bilingual() rather than a title being appended here, so this only ever produces one language. */
/* A collection is a work, so it gets a work's rendering. It was the one title-shaped string on the
   row that never went through the store. */
/* Chapter names, collections and credit lines. Not titles. A chapter name is mostly structure
   (第12話 -> Ch. 12) and a credit line is roles plus names, so they live in their own map, but
   they are looked up exactly the same way.

   IT USED TO FALL THROUGH TO THE JAPANESE and that is the branch the owner's ruling closes. A
   phrase nobody has rendered now reaches `enFallback`, and so does a phrase the map answers with
   the Japanese it was given, which happens where the analyser could read nothing at all. */
/* WHAT THE MAP HOLDS, WHICH IS NOT THE SAME QUESTION AS WHAT TO SHOW. `phraseOf` now always
   answers something, so a caller choosing between the phrase and a record's own rendering can no
   longer tell the two apart by comparing the answer with what it asked about. This is the map
   speaking or staying silent, and a phrase that came back as the Japanese it was given counts as
   silence: the analyser reads a string it cannot parse by handing it back. */
function phraseHeld(ja) {
  const got = (NAMES && NAMES.phrases && NAMES.phrases[foldKey(ja)]) || null;
  return (got && !JA_ANY.test(got)) ? got : null;
}

function phraseOf(ja) {
  if (LANG !== 'en' || !ja) return ja;
  return phraseHeld(ja) || enFallback(ja);
}

function workTextOf(ja) {
  const e = enOf(nameFor('titles', ja, null));
  return (LANG === 'en' && e) ? e.text : phraseOf(ja);
}

/* An edition marker a catalogue appends to a title. A small closed set, so it is glossed rather
   than left to strand an otherwise translated title in Japanese. */
const EDITION_EN = {
  '完全版': 'Complete Edition', '電子単行本': 'Digital Edition', '新装版': 'New Edition',
  '合本版': 'Omnibus Edition', '分冊版': 'Serialised Edition', '雑誌掲載版': 'Magazine Edition',
};
const EDITION_TAIL = /\s*[:：]\s*(完全版|新装版|合本版)\s*$|\s*【\s*([^】]+?)\s*】\s*$/;

/* A TITLE PLUS AN EDITION MARKER IS THE SAME WORK. 恋愛遺伝子XX is "The Romance Gene XX" and
   恋愛遺伝子XX : 完全版 had no English at all, so a translated title was stranded in Japanese by a
   two-character suffix. The base is asked for its name and the marker is glossed beside it. Only
   markers in the set above qualify: a subtitle is part of a title and is not guessed at. */
function editionLabel(work) {
  const m = EDITION_TAIL.exec(work || '');
  if (!m) return null;
  const marker = (m[1] || m[2] || '').trim();
  const en = EDITION_EN[marker];
  if (!en) return null;
  const base = work.slice(0, m.index).trim();
  const e = enOf(nameFor('titles', base, null));
  return e ? `${e.text} (${en})` : null;
}

/* ONE LANGUAGE, AND 併記 IS THE CALLER'S JOB. `bilingual()` runs a renderer once per language with
   LANG forced, so every branch below tests `en` and otherwise answers in Japanese. A `both` branch
   here would print the pair again on each of the two lines it is already inside.

   THE COST OF THAT CONTRACT IS THAT A CALLER OUTSIDE `bilingual()` GETS JAPANESE AND NO WARNING.
   That is what hid the English title on the work page heading, on the 作品 index rows, on the 発売
   rows and in the works list of a credit or a publisher page: four surfaces, one shape, and each
   of them silently correct-looking in ja and in en. Every one of those call sites now wraps, and
   the answer to "how does a title read" is still this function alone. `pubBoth` is the exception
   and says why in its own comment: it fills slots that cannot take a second line. */
function workLabel(r) {
  const e = enOf(nameFor('titles', r.work, r.work_en));
  const rec = nameFor('titles', r.work, r.work_en);
  if (LANG === 'en' && e) return esc(e.text) + uncertainMark(rec, e);
  if (LANG === 'en') { const ed = editionLabel(r.work); if (ed) return esc(ed); }
  // ENGLISH LEAVES HERE AND NEVER FALLS PAST IT. `phraseOf` used to answer with the Japanese where
  // the map held nothing, so this test was `ph !== r.work` and a title with no rendering dropped
  // to the ruby line below and printed the Japanese under an English toggle. It now answers with
  // the floor, which is Latin whatever the store holds.
  if (LANG === 'en') return floorHtml(esc(phraseOf(r.work)));
  return ruby(r.work, rec) + (FURIGANA ? uncertainMark(rec) : '');
}

/* Authors likewise: one language, chosen by the caller's context. A romanisation and its Japanese are the same name
   twice, so the toggle picks one (§5b). */
/* A person's romanisation in the reader's chosen order. The stored form is family first, as the
   name is written; `given` swaps the two halves. Only a two-part name can be swapped: a single
   token is one name and reversing it would invent a structure the name does not have. */
function personName(rec) {
  /* AN ORGANISATION HAS NO PERSONAL NAME TO ORDER, and answering with one is what kept an English
     name out of a record that held it. `kind` is what the store calls a credit that is not a
     person, and 百合姫編集部 is a magazine and a department: its record carries Yuri Hime Editorial
     Department, and every caller here asked for the reading's romanisation first because the
     argument they pass says person. Declining sends them to `enOf`, which reads the record's own
     order of English forms and answers with the romanisation anyway where that is all there is. */
  if (rec && rec.kind) return null;
  const rj = rec && rec.romaji && rec.romaji[ROMAJI_STYLE];
  if (!rj) return null;
  if (NAME_ORDER !== 'given') return rj;
  const bits = rj.split(' ').filter(Boolean);
  return bits.length === 2 ? `${bits[1]} ${bits[0]}` : rj;
}

/* HOW A CREDIT FIELD DIVIDES, ASKED OF THE BUILD RATHER THAN WORKED OUT HERE.

   `adapters/names/creditline.py` divides every credit field in the corpus with the same splitter
   the name store is keyed on, and ships the answer under `credit_parts`. This file used to divide
   the field itself in two different places \u2014 `credit()` on the catalogue tab and `creditNames()`
   on the \u767a\u58f2 tab \u2014 and neither knew about a role in round brackets, a doubled bracket, `\u307b\u304b`, an
   ampersand or an interpunct. `\u5357\u90e8\u304f\u307e\u3053(\u4f5c) / \u6771\u6cb3\u307f\u305d(\u7d75)` matched nothing in a store that holds
   both people, and `iimAn&\u60df\u4e1e` was one name nobody is called.

   `{ p: [{ n: name, r: role }, \u2026, { etc: 1 }], part: 1 }`. `etc` is the field saying the people it
   names are some of them; `part` is the build saying its division does NOT account for the whole
   field, which is the flag that keeps a rebuilt byline from quietly losing a credit. */
function creditDiv(field) {
  const d = NAMES && NAMES.credit_parts && NAMES.credit_parts[foldKey(String(field || '').trim())];
  return (d && Array.isArray(d.p)) ? d : null;
}

/* The people in a division, without the marker that says there are more of them. */
function creditPeople(field) {
  const d = creditDiv(field);
  return d ? d.p.filter(x => x.n).map(x => x.n) : null;
}

/* A credit line built from the people in it, so it follows the same choices a single name does.
   Null where any of them is unknown to the store: half a line composed and half romanised whole
   reads as neither, and a reader cannot tell which half to trust. */

/* A NAME ALREADY IN LATIN, WITH THE CATALOGUE'S TYPING TAKEN OFF.

   `Ｍａｇｐｉｅ`, `ｆｉｎｉｔｅ` and `Ｈｏｕｒａｉ　Ｄｏｌｌ` are Latin pen names a cataloguer typed
   in full width, and the store holds nothing for them because there is nothing to hold: a Latin
   pen name is not a transliteration of anything (NAMES-PLAN §1) and `pass0_cache` files it as
   `stated` off the surface. So the surface reached an English page with its width intact, and
   `full-width forms in English renderings` counted 308 of them.

   NFKC IS NOT A TRANSLATION and not a reading. It maps Ｍ to M and leaves everything else alone,
   which is the same fold `pass4_analyser.latin_reading` already applies for the same reason. The
   test is that the name holds no kana and no kanji, so a title published with a full-width mark —
   `2×2＝SHINOBUDEN+` is the recorded one — never reaches this: it is a TITLE and goes through
   `workLabel`, and the work's own name is what it publishes. */
function plainLatin(n) {
  const s = String(n || '');
  return (s && !JA_ANY.test(s)) ? s.normalize('NFKC') : null;
}

/* ONE PERSON INSIDE A CREDIT LINE, in the form a reader is shown. Never null in English.

   THE ROMANISATION IS NOT THE ONLY ENGLISH A RECORD CAN HOLD, which is what this was missing.
   `personName` is built from the kana, so a record with an English name and no reading behind it
   answered nothing and the line kept the Japanese: 時一二 is not a Japanese name, the National
   Diet Library holds no kana for it and does hold the heading Shi Yi Er, and that name sat in the
   store while three credit lines printed the characters. `authorLabel` has always fallen through
   to `enOf` for a single byline; the lines composed out of parts did not.

   Order follows the single-name path exactly: the reader's romanisation and name order first,
   then whatever English the record holds, then the surface where it is already Latin, and then the
   floor, which is where the 31 compound credit lines were losing a name each.

   IT STILL ANSWERS NULL IN JAPANESE, and every caller tests for that. A Japanese page shows the
   name as written and has nothing to fall back to. */
function personShown(n) {
  const rec = nameFor('authors', n, null);
  const e = rec && enOf(rec);
  /* A NAME ALREADY IN LATIN NEEDS NO RECORD. `倫理きよ, Syousa., jimao` composed nothing because
     Syousa. and jimao are not in the store, having no reading to hold, so the whole line fell
     through to the Japanese. A part with no Japanese in it is its own English form. */
  return personName(rec) || (e && e.text) || plainLatin(n)
    || (LANG === 'en' ? enFallback(n) : null);
}

/* `creditFromParts` STOOD HERE AND IS `composedCredit` NOW. It composed the people and dropped
   every role the field stated, so `[作画]蔵王大志 / [原作]影木栄貴` reached a reader as
   `Zaō Taishi, Eiki Eiki` and the catalogue's own statement about who drew and who wrote was
   thrown away at the last step. One composer, further down beside the role table it reads. */

function authorLabel(r) {
  const rec = nameFor('authors', (r.author || '').trim(), r.author_en);
  const e = enOf(rec);
  // COMPOSED FIRST, because a credit line usually has no record of its own and the early return
  // below would hand it to the phrase map before anything else got a look. That is what kept
  // 入間人間's line reading "Iruma Ningen" while the name itself was right, and what stopped the
  // name-order choice reaching a line at all.
  if (LANG === 'en') {
    const composedEarly = composedCredit((r.author || '').trim());
    if (composedEarly !== null) return floorHtml(esc(composedEarly));
    /* AND WHERE ONE NAME IN THE LINE IS UNKNOWN, THE REST STILL RENDER. The composition above is
       all-or-nothing on the argument that half a line composed and half romanised whole reads as
       neither, and that argument is about the FALLBACK it had: the analyser's phrase, one fixed
       string covering the whole field. `creditText` is a different fallback. It renders each name
       in its own state and leaves the field's own separators alone, so `ZCloud / 伊実 / 角川青羽`
       no longer puts all three in Japanese because two of them have no reading.

       IT USED TO STOP HALF WAY, and that is the shape the owner's ruling closes. Each name was
       rendered in its own state, and one of those states was the Japanese, so 31 credit lines had
       some names romanised and some not: `Sasa Tōgorō / 黒布直導`. Every part now reaches the
       floor, so no part of a line can be Japanese while its neighbours are not. */
    const div = creditDiv((r.author || '').trim());
    if (div && div.p.filter(x => x.n).length > 1) {
      const inPlace = creditText((r.author || '').trim());
      if (inPlace) return floorHtml(esc(inPlace));
    }
  }
  // A CREDIT LINE IS ANNOTATED PERSON BY PERSON. The line as a whole has no record, so it had no
  // furigana at all even once every person in it had a sourced reading. The raw string is kept
  // exactly as written, separators and roles included, and each name inside it is replaced by its
  // own ruby: joining the parts with a comma would rewrite the credit as well as annotate it.
  //
  // NEVER IN ENGLISH-ONLY MODE. Furigana annotates Japanese, so this branch returns Japanese, and
  // it ran before the English one: a line whose composition failed on a single name fell through
  // to here and printed 倫理きよ, Syousa., jimao with ruby, under an English heading, while
  // `author_en` held Rinri Kiyo, Syousa., jimao all along. The composition is allowed to fail; the
  // fallback has to be the romanisation and not the surface.
  const rawJa = (r.author || '').trim();
  const parts = creditPeople(rawJa);
  if (LANG !== 'en' && FURIGANA && parts && parts.length > 1) {
    let out = '', rest = rawJa, any = false;
    for (const nm of parts) {
      const at = rest.indexOf(nm);
      if (at < 0) continue;
      const prec = nameFor('authors', nm, null);
      const piece = ruby(nm, prec);
      if (piece !== esc(nm)) any = true;
      out += esc(rest.slice(0, at)) + piece;
      rest = rest.slice(at + nm.length);
    }
    if (any) return out + esc(rest);
  }

  if (!e) {
    // A LATIN NAME THE STORE HAS NOTHING FOR IS STILL THE NAME, and the catalogue's full width is
    // not part of it. `enFallback` folds it, at the end of `creditText`, and only where the phrase
    // map added nothing, so a rendering somebody recorded is never overwritten by a fold.
    const raw0 = (r.author || '').trim();
    if (LANG !== 'en') return esc(phraseOf(raw0));
    // ONE FALLBACK FOR A CREDIT FIELD AND NOT TWO. This called `enFallback`, which spells every
    // Japanese run the same way, so `ぐう(作画)水無瀬(原作)` came back with 作画 spelled `Sakuga`
    // beside the names it labels, while `creditText` on the same string glossed it. `creditText` is
    // the credit renderer: it composes where the build divided the field, walks it where the
    // division is incomplete, and glosses the roles either way.
    return floorHtml(esc(phraseHeld(raw0) || creditText(raw0)));
  }
  if (LANG === 'en') {
    // A CREDIT LINE is roles and several people, and the phrase map renders those: the roles
    // translate and the names inside are romanised together. A SINGLE NAME is a name, and the
    // store holds its reading.
    //
    // Preferring the phrase for both published a frozen romanisation that no correction could
    // reach, because the phrase map is written once per string and never revisited. 大熊らすこ
    // stayed "Ōkumara Suko" after its reading was sourced as オオクマ ラスコ, and 涼海来夏 stayed
    // "Suzuka Raika" after スズミ ライカ. It also dropped the mark: the phrase path returns a plain
    // string, so a romanisation resting on a guess was shown to an English reader with nothing to
    // say so, and an English reader has no Japanese to fall back on.
    //
    // ASKED WHETHER THE MAP HOLDS ONE, not whether its answer differs from the question. `phraseOf`
    // now answers with the floor where the map is silent, so the old test was true of every line
    // and would have taken a mechanical romanisation of the whole field over the record's own
    // rendering of the name in it.
    // THE PHRASE MAP NO LONGER ANSWERS FOR A CREDIT LINE, and this is where it used to. A phrase is
    // one string written once by the analyser for the whole field, so it romanised the roles along
    // with the names: `[著]中村明日美子` came back `[Cho]Nakamura Asumiko` and `カボちゃ(著)` came
    // back `Kabocha(Cho)`, which names a job in a language nobody outside Japan reads. The analyser
    // does not write phrases for credit fields any more (`pass4_analyser.credit_line_phrase`), and
    // a field with a division reaches `composedCredit` above before it could get here.
    return enHtml(rec, 'byen', true);
  }
  // No 'both' branch any more. In 併記 this is called twice (once per line) so pairing the two
  // scripts HERE would print the romanisation twice on the English line and once on the Japanese.
  //
  // FURIGANA OVER THE NAME, where the build shipped any. It only ships spans for a reading a
  // source states, so a name whose reading is a machine's guess arrives without them and falls
  // through to the plain string. A credit line naming several people has no record of its own and
  // does the same. ruby() applies the same test it applies to a title.
  return ruby(r.author || '', rec);
}

/* Weekday, short. Web serials run to a weekly slot far more than to a date. A reader tracking a
   Saturday series reads the day before the number. Parsed as UTC so the label cannot slip a day on
   a browser west of Greenwich; these dates are calendar days, not instants. */
const DOW_JA = ['日','月','火','水','木','金','土'];
const DOW_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
/* A DATE IS MOSTLY NOT A TRANSLATION PROBLEM. 08-03 and 2026-08-03 belong to neither language:
   English would write 3 Aug and Japanese 8月3日, and the ISO order reads correctly to both. Only
   two tokens are language-bound, the weekday and the month name, and they are what these two
   functions produce.

   併記 SHOWS BOTH, as it does everywhere else. The day heading is a divider, so it cannot take a
   second line the way §5b gives one to a title, but the token is three characters and doubles
   along the axis that is free. The month picker's own button already did this, from
   the same mode, because it happens to route through T().

   Neither used to decide anything for 併記. `LANG === 'en' ? EN : JA` gave it Japanese because it
   is not 'en', so the page showed 月 beside a button reading 最新 / latest. */
function dow(d) {
  if (!/^\d{4}-\d\d-\d\d/.test(d || '')) return '';
  const n = new Date(d.slice(0, 10) + 'T00:00:00Z').getUTCDay();
  return LANG === 'en' ? DOW_EN[n] : LANG === 'ja' ? DOW_JA[n] : `${DOW_JA[n]} ${DOW_EN[n]}`;
}

const MON_EN = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/* ISO or the reader's own convention, and ISO is the default because it sorts, it is unambiguous,
   and it is what somebody selecting text off the page should get.

   THE TWO CONVENTIONS ARE NOT ONE TEMPLATE REORDERED. English puts the weekday in front, "Wed 5
   Aug"; Japanese puts it after, in parentheses, 8月5日（水）. So this resolves against the language
   rather than shuffling tokens, and 併記 takes the Japanese form, because both-mode already puts
   Japanese first everywhere and a date is not a name to be shown twice.

   Day order inside English follows DIALECT, which already exists and already decides spelling, so
   a reader who has chosen American gets "Wed Aug 5" without a second control that could disagree
   with the first.

   PRECISION IS NEVER INVENTED. A record catalogued to the month renders as a month. Handing a
   month to a date formatter and taking the first of it would be the interface asserting a day the
   record does not have, which is the same fault as a day-level release calendar. */
function fmtDate(iso, opts) {
  const s = String(iso || '');
  const o = opts || {};
  const md = /^(\d{4})-(\d\d)-(\d\d)/.exec(s);
  const mm = /^(\d{4})-(\d\d)$/.exec(s);
  if (!md && !mm) return s;
  const [y, m, d] = md ? [md[1], md[2], md[3]] : [mm[1], mm[2], null];
  const yr = o.year ? y : null;

  if (DATEFMT !== 'local') {
    // The ISO form, with the year where the rule asks for it and the weekday where there is a day.
    const core = d ? (yr ? `${y}-${m}-${d}` : `${m}-${d}`) : `${y}-${m}`;
    return d && o.dow ? `${core} ${dow(s)}` : core;
  }

  const ja = LANG !== 'en';                      // 併記 takes the Japanese form
  if (!d) return ja ? `${y}年${+m}月` : `${MON_EN[+m - 1]} ${y}`;
  if (ja) {
    const w = o.dow ? `（${DOW_JA[new Date(s.slice(0, 10) + 'T00:00:00Z').getUTCDay()]}）` : '';
    return (yr ? `${y}年` : '') + `${+m}月${+d}日${w}`;
  }
  const mon = MON_EN[+m - 1].slice(0, 3);
  const day = DIALECT === 'us' ? `${mon} ${+d}` : `${String(+d).padStart(2, '0')} ${mon}`;
  const w = o.dow ? DOW_EN[new Date(s.slice(0, 10) + 'T00:00:00Z').getUTCDay()] + ' ' : '';
  return w + day + (yr ? ` ${y}` : '');
}

/* THE YEAR RULE. Within the current year a month and day are unambiguous, so the year is left off.
   Outside it the year is shown, because the archive goes back through completed months where "05
   Aug" alone says nothing about which August.

   NOT "not the current month", which is what this said first. The updates window is fourteen days
   and crosses a month boundary twice a month, so late July sat beside early August with a year on
   one of them, days apart. The rule the feed already had before this setting existed was the year
   one, and it was right. */
function needsYear(iso) {
  const s = String(iso || '');
  return s.slice(0, 4) !== String(new Date().getFullYear());
}

/* Platform names in English.
   Where the platform publishes its own Latin-script name: pixiv Comic, Comic Days, Sunday Webry,
   KADOKOMI, Magazine Pocket. That name is used, because it is the one the platform answers to and
   the one a reader will find. Where it publishes none, this is a romanisation and nothing more: a
   best-effort reading of the Japanese, marked as such rather than invented as a translation.
   Names already in Latin script are absent from the map and pass through untouched. */
const PLAT_EN = {
  'pixivコミック':'pixiv Comic', 'コミックDAYS':'Comic Days', 'サンデーうぇぶり':'Sunday Webry',
  'カドコミ':'KADOKOMI', 'マガポケ':'Magazine Pocket', '少年ジャンプ+':'Shonen Jump+',
  'ガンガンONLINE':'GANGAN ONLINE', 'ニコニコ漫画':'Niconico Manga', 'コロコロオンライン':'CoroCoro Online',
  'となりのヤングジャンプ':'Tonari no Young Jump', 'くらげバンチ':'Kurage Bunch',
  'コミックガルド':'Comic Gardo', 'コミックゼノン':'Comic Zenon', 'コミックボーダー':'Comic Border',
  'コミック アース・スター':'Comic Earth Star', 'チャンピオンクロス':'Champion Cross',
  'ヤングチャンピオン':'Young Champion', 'ヤンマガWeb':'Yanmaga Web', 'マンガワン':'Manga One',
  'マンガPark':'Manga Park', 'マンガよもんが':'Manga Yomonga', '一迅プラス':'Ichijin Plus',
  '花とゆめ+':'Hanayume+', 'webアクション':'Web Action', 'まんがタイムSquare':'Manga Time Square',
  'ダ・ヴィンチニュース':'Da Vinci News', 'ゼロサムオンライン':'Zero-Sum Online',
  'コミックPASH! neo':'Comic PASH! neo', 'コミックトレイル':'Comic Trail',
  'コミックグロウル':'Comic Growl', 'コミックノヴァ':'Comic Nova', 'コミックリュエル':'Comic Ruelle',
  'COMICリュエル':'COMIC Ruelle', 'COMIC熱帯':'COMIC Nettai', 'コミックオギャー!!':'Comic Ogyaaa!!',
  'ファイアCROSS':'Fire CROSS', 'フラコミlike!':'Furacomi like!', 'ゼノン編集部':'Zenon editorial',
  '竹コミ':'Takecomi', 'キミコミ':'Kimicomi', 'ビッコミ':'Bikkomi', 'ライコミ':'Raicomi',
  'Gコミ':'G-Comi', 'アサコミ':'Asacomi', 'きららベース':'Kirara Base',
  'GANMA!(更新終了)':'GANMA! (ended)', 'コミックゼノン':'Comic Zenon',
  'マイナビニュース':'Mynavi News', 'ヤンジャン+':'Yanjan+', 'コミックエッセイ劇場':'Comic Essay Gekijo',
};
/* THE JOB A CREDIT DID, GLOSSED. ONE TABLE, and until this line there were two: this one held six
   words for the catalogue tab and `CREDIT_ROLE` further down held twenty for the credit pages, so
   キャラクターデザイン was English on one page and Japanese on another and neither table knew that
   校正, 編纂 or ほか著 exist. The corpus states 34 role strings and the splitter's vocabulary allows
   a few more; `every credit role has an English gloss` asks this table for every one of them.

   COMPOSED RATHER THAN LISTED, because a role is written as a compound as often as not:
   `イラスト・漫画`, `表紙 ・ 漫画`, `キャラクター原案・漫画`, `原作監修・文`. Spelling every
   combination out is the mistake the old table made at a smaller size — it carried
   `キャラクターデザイン原案` as one entry and had neither of its halves. The atoms are glossed and
   the joiner is rendered, so a compound this corpus has never written still comes out in English.

   THE NAME BESIDE IT IS NOT TRANSLATED. Transliterating a mangaka is guessing; the role is a label
   and is the only part of the notation that belongs to us. */
const ROLE_EN = {
  '著': 'author', '著者': 'author', '作': 'author', '文': 'text', '画': 'art', '絵': 'art',
  // 漫画 IS THE JOB OF MAKING THE COMIC AND 作画 IS DRAWING IT, and the corpus states both on the
  // same book: `[原作]王月よう / [漫画]アジイチ` names a writer and the person who made the manga of
  // it, while `原作／宮澤伊織　作画／水野英多` names a writer and an artist working from somebody
  // else's layout. Both read `art` until this line, so a field distinguishing two jobs came out
  // naming one.
  '原作': 'story', '作画': 'art', '漫画': 'manga', 'コミック': 'manga', 'ストーリー': 'story',
  '話': 'story',
  // ネーム is the panel-by-panel draft a comic is drawn from, which English publishing calls the
  // storyboard. It read `layout`, which is what a book designer does to a finished page.
  'シナリオ': 'scenario', '脚本': 'script', '構成': 'composition', 'ネーム': 'storyboard',
  '原案': 'original concept', 'キャラクター原案': 'character design',
  'キャラクターデザイン': 'character design', 'キャラクターデザイン原案': 'character design',
  'イラスト': 'illustration', 'カバーイラスト': 'cover illustration', 'カバー': 'cover',
  '表紙': 'cover', 'デザイン': 'design', '企画': 'planning', '監修': 'supervision',
  // A ROLE NAMES SOMEBODY, so both of these are the person and not the act. 編纂 read
  // `compilation`, which is the book, and a byline reading `Name (compilation)` says the person is
  // one.
  '原作監修': 'story supervision', '編': 'editor', '編集': 'editor', '編纂': 'compiler',
  // The author of the work a comic is drawn from, as distinct from 原作, who wrote the story for
  // this comic. English publishing calls both the original work, and the distinction the Japanese
  // makes is between adapting a book and writing a script.
  '原著': 'original work',
  '校正': 'proofreading', '訳': 'translation', '翻訳': 'translation', '協力': 'assistance',
  '構成協力': 'composition assistance', '原案協力': 'concept assistance',
  '作画協力': 'art assistance', '翻訳協力': 'translation assistance',
  '取材協力': 'research assistance',
  // `ほか著雪子` is an anthology naming one of its contributors: the role says both what the person
  // did and that there are more of them.
  'ほか著': 'author, with others', '他著': 'author, with others',
  // `ほか` closes a credit that names some of its contributors and stops. It is glossed here rather
  // than in a function of its own so that the word a byline shows and the word a credit page shows
  // come out of one table; `andOthers` reads this entry.
  'ほか': 'and others', '他': 'and others',
  'story': 'story', 'art': 'art', 'Story': 'story', 'Art': 'art',
};

/* THE ROLE THAT IS THE DEFAULT, AND WHAT IS LEFT OF IT ON A BYLINE.

   The project owner's ruling: 著, 著者, 作 and no role at all are one concept, the unmarked author,
   and a byline never states it. `[著]中村明日美子` is that person's book and `中村明日美子` is the
   same fact written without the cataloguing, so a reader meeting `Nakamura Asumiko (author)` on one
   row and `Nakamura Asumiko` on the next would be reading a distinction the catalogue never made.

   IT STAYS ON A CREDIT PAGE, which is why this is a second reading of the table and not an entry
   removed from it. That page lists a person's works with the job beside each, the job is the
   payload, and eliding it leaves an empty cell. `roleWord` is what that page calls.

   THE VALUE IS WHAT SURVIVES, not a flag. `ほか著雪子` is an anthology saying both that this person
   wrote and that there are more of them; the author half elides and the `ほか` half is a thing the
   field says that a reader is owed. */
const ROLE_ELIDED = { '著': '', '著者': '', '作': '', 'ほか著': 'ほか', '他著': 'ほか' };

/* One role as a reader reads it, compound and all. An atom with no gloss is left as the source
   wrote it, which is the fallback every name on this site takes; the invariant is what stops that
   fallback from being where a role quietly lives. */
function roleWord(r) {
  const raw = String(r || '').trim();
  if (!raw) return '';
  const atoms = raw.split(/[・･/／\s\u3000]+/).filter(Boolean);
  // A ROLE WITH NO GLOSS IS A MISSING TABLE ENTRY, and `every credit role has an English gloss`
  // blocks on one at zero, so this fallback should never be what a reader meets. It is the floor
  // anyway, because a role sitting in kanji on an English page is the thing that may not happen
  // and an invariant is a check rather than a guarantee about the next role somebody adds.
  if (!atoms.every(a => ROLE_EN[a])) {
    return ROLE_EN[raw] ? T(raw, ROLE_EN[raw]) : T(raw, enFallback(raw));
  }
  return T(raw, atoms.map(a => ROLE_EN[a]).join(' and '));
}

/* A LIST OF ROLES, glossed and joined. Its own function because a caller copying a role list out
   of a record and glossing it later is a field read in one place and rendered in another, which is
   the shape `adapters/lint/entrypoints.py` refuses. */
function roleWords(rs) {
  return (rs || []).map(roleWord).filter(Boolean).join(SEP);
}

/* THE SAME ROLE AS A BYLINE STATES IT: empty where the field stated the default.

   ATOM BY ATOM, because a role is written as a compound as often as not and the default can be one
   half of one. `roleWord` already splits `表紙 ・ 漫画` and glosses each side, and a compound
   holding 著 has to lose that side and keep the other rather than falling through whole.

   THE GLOSS IS STILL `roleWord`'s. What this decides is which atoms survive; how a surviving atom
   is spelled in English is the one table's answer, so a role cannot read one way here and another
   way on a credit page. */
function bylineRole(r) {
  const raw = String(r || '').trim();
  if (!raw) return '';
  const atoms = raw.split(/[・･/／\s　]+/).filter(Boolean);
  const kept = atoms.map(a => (a in ROLE_ELIDED) ? ROLE_ELIDED[a] : a).filter(Boolean);
  if (!kept.length) return '';
  // The raw string where nothing elided, so a role the atom split does not account for is glossed
  // exactly as `roleWord` glosses it and no rejoining happens behind its back.
  if (kept.length === atoms.length && kept.every((k, i) => k === atoms[i])) return roleWord(raw);
  return roleWord(kept.join('・'));
}

/* `ほか` closes a credit that names some of its contributors and stops. Read off the role table,
   because a byline can also meet the word as a role the field stated (`ほか著`) and two producers
   of one gloss is the shape §3 counts seven shipped bugs from. */
function andOthers() { return roleWord('ほか'); }

/* A CREDIT FIELD AS A BYLINE, COMPOSED FROM THE DIVISION: the people the build found, each with the
   job the field gave them, and nothing the catalogue wrote around them.

   WHY COMPOSED AND NOT RENDERED IN PLACE. `[著]中村明日美子`, `中村明日美子` and
   `中村明日美子(著者)` are one fact written three ways, and rendering in place published the
   cataloguing with it: a reader met `[author]Nakamura Asumiko` on the catalogue tab and
   `Kabocha(Cho)` on the updates tab for the same shape. The brackets, the slashes and the colons
   are MADB's notation for saying which part is the job, and once the job is stated in English
   beside the name there is nothing left for them to say.

   NULL WHERE THE BUILD SAYS ITS DIVISION IS INCOMPLETE, which is `part`, and null where the field
   is a single name with no job. The first is the rule `creditText` already had, and it is the
   reason composing is safe at all: a byline that has quietly lost a company is worse than one a
   reader can see is in Japanese, so the incomplete ones keep the in-place walk. The second is not a
   line to compose: one bare name is the store's own rendering of that name, and routing it through
   here would take the mark and the markup off 2,300 rows that are right today.

   ALL OF THEM OR NONE. A part `personShown` cannot render returns null and the whole composition
   declines, which is the rule `creditFromParts` has always had: half a line composed and half
   rendered some other way reads as neither. In Japanese `personShown` answers null for everything,
   so this never composes there and the field the source wrote stands. */
/* WHAT THE FIELD PUT BETWEEN TWO PEOPLE, as an English page writes it.

   The build ships the field's own answer under `j`, from `names.credits.joiner`, because a row
   composed with a slash sitting in a tab of comma-separated rows reads as a different kind of row.
   The one substitution is the Japanese comma, which is Japanese typography and not a separator an
   English reader has: `、` and `, ` say the same thing and only one of them belongs on this page. */
function creditJoiner(div) {
  const j = (div && div.j) || ', ';
  return j === '、' ? ', ' : j;
}

function composedCredit(ja) {
  const div = creditDiv(ja);
  if (!div || div.part) return null;
  const people = div.p.filter(x => x.n);
  const etc = div.p.some(x => x.etc);
  if (!people.length) return null;
  if (people.length === 1 && !people[0].r && !etc) return null;
  const out = [];
  for (const p of people) {
    const shown = personShown(p.n);
    if (shown === null) return null;
    const role = bylineRole(p.r);
    out.push(role ? `${shown} (${role})` : shown);
  }
  if (etc) out.push(andOthers());
  return out.join(creditJoiner(div));
}

/* THE FIELD AS THE STORE IS KEYED ON IT, character by character, with the way back.

   `foldKey` normalises NFKC and drops every space, and the shipped division is keyed the same way,
   so the NAMES inside it are folded too. The field a page is drawing is not: `仲谷 鳰` reaches the
   catalogue tab with its space and `2C=がろあ` with a half-width equals, while the division holds
   `仲谷鳰` and `2C＝がろあ`. Two fields that fold alike share one entry, which is the point of a
   fold, and it means `indexOf` on the raw string finds nothing at all — 49 credit lines went back
   to Japanese the day the division started being shipped for every field rather than for the few
   that had an analyser phrase.

   So the search runs over the folded form and the map says which character of the original each
   folded character came from. Folding per character keeps that map honest where NFKC changes a
   length. */
function foldSpans(raw) {
  let f = '';
  const idx = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i].normalize('NFKC');
    for (const ch of c) {
      if (ch === ' ') continue;
      f += ch;
      idx.push(i);
    }
  }
  idx.push(raw.length);
  return { f, idx };
}

/* Where `needle` sits in `raw`, compared as the name store compares. `[start, end)` in the
   original, or null. */
function foldFind(map, raw, needle, from) {
  const want = foldKey(needle);
  if (!want) return null;
  const at = map.f.indexOf(want, from);
  if (at < 0) return null;
  // THE END IS ONE PAST THE LAST CHARACTER MATCHED, not the start of the next folded one. Those
  // differ by exactly the spaces the fold removed, so taking `idx[at + len]` swallowed the space
  // after a name and `年中麦茶太郎 / iimAn` came out `Nenjūmugichatarō/ iimAn`.
  return [map.idx[at], map.idx[at + want.length - 1] + 1, at + want.length];
}

/* THE INTERPUNCT BETWEEN TWO NAMES THE BUILD DIVIDED, in the script the row is being read in.

   矢立肇・富野由悠季 is two names, and leaving the ・ standing puts a katakana middle dot between two
   romanisations on an English page. The one inside a name the build did NOT divide never reaches
   here, because there the character is part of somebody's name and るいす・まくられん is one credit.

   ONE RULE, TWO RENDERERS. `creditText` composes the catalogue line and `linkedCredits` composes
   the same field on a work page with each person wrapped in their address, and both walk the
   division placing names into the field as written. `linkedCredits` copied the gap through
   verbatim, so `Yadate Hajime・Tomino Yoshiyuki` was on four work pages while the catalogue tab
   read the same credit correctly (STANDING-INSTRUCTIONS §3). Returns null where the gap is not a
   separator to translate, which is every other gap. */
function creditGap(text) {
  return (LANG === 'en' && /^[・･]$/.test(text)) ? ' / ' : null;
}

/* WHATEVER SITS BETWEEN TWO NAMES THE BUILD DIVIDED, in English.

   A gap holds the field's brackets and separators, and where the division did not account for the
   whole field it holds words as well: a company nobody split out, or a role the splitter did not
   attach to anybody. `[[翻訳協力]][BPS株式会社]` is both at once.

   GLOSSED BEFORE IT IS ROMANISED. `roleWord` reads the one role table this file has, so 原著 comes
   out `original work` rather than `Gencho`, and a run that is not a role falls through the same
   function to the floor. Asking the table first is not a second opinion about what a role is: the
   division already claimed every role it recognised, and this is the vocabulary answering about
   what it left. */
function creditGapText(text) {
  // FOLDED TO THE WIDTH IT IS READ AT, like every other English rendering here. `enFallback` does
  // this for the strings it is given and this replaced it on the gaps, so `Ｓｙｏｕｓａ．` in a
  // bracket went back to full width and `full-width forms in English renderings` rose by three.
  return String(text ?? '').normalize('NFKC')
    .replace(JA_ANY_RUN, run => bylineRole(run))
    // THE NOTATION GOES WITH THE ROLE IT HELD. `bylineRole` answers '' for the default, so a gap
    // reading `[著]` came back `[]` and `(作)` came back `()`: the catalogue's brackets with
    // nothing left inside them. No field the build ships reaches this walk, and the probes that
    // found it were written by hand, so this is what the path should do rather than a report of
    // what it did to a reader.
    .replace(/[[(（【]\s*[\])）】]/g, ' ')
    // AND TWO NAMES DO NOT RUN TOGETHER WHERE A ROLE SAT BETWEEN THEM. `ぐう(作画)水無瀬` renders
    // the gap as `(art)` and left `Gū(art)Minase`; a rendered gap is a word and takes the spacing
    // of one.
    .replace(/([)\]）】])(?=\S)/g, '$1 ')
    .replace(/\s{2,}/g, ' ');
}

/* A CREDIT FIELD WITH EVERY NAME AND EVERY ROLE IN IT RENDERED, IN PLACE.

   IN PLACE AND NOT REBUILT, because rebuilding drops whatever the division did not find and a
   byline that has quietly lost a company is worse than one a reader can see is in Japanese. The
   field keeps its own separators, its brackets and its order; what changes is that each name the
   store can render is replaced by the rendering and each role the build identified is replaced by
   its gloss.

   THE SPANS COME FROM THE BUILD. This function decides nothing about what is a name and what is
   notation — `creditDiv` carries that — so the store, the credit registry and this line can no
   longer disagree about who is on a book.

   A NAME CLAIMS ITS SPAN WHETHER OR NOT IT RENDERS. `COMIC BRIDGE編集部(編)` names an editorial
   desk the store has never met and states 編 as the job, and glossing the role without claiming the
   name first put the word "editor" inside the desk's own name. */
function creditText(c) {
  const raw = String(c || '');
  if (LANG !== 'en' || !raw) return raw;
  // COMPOSED WHERE THE DIVISION ACCOUNTS FOR THE FIELD, which is 3,381 of 3,381 fields today. The
  // walk below is what a field the build could not fully divide still gets, and it is why the
  // in-place rendering is kept rather than deleted.
  const composed = composedCredit(raw);
  if (composed !== null) return composed;
  const div = creditDiv(raw);
  // A FIELD NOBODY DIVIDED IS STILL A FIELD A READER MEETS. This handed the string back as the
  // catalogue wrote it, which is Japanese under an English heading whenever the splitter met a
  // shape it could not divide. The floor spells the whole field instead, marked.
  //
  // AND THE ROLES IN IT ARE STILL ROLES. `enFallback` spells every Japanese run the same way, so a
  // field the build never saw came back with `作画` spelled `Sakuga` beside the names. Each run goes
  // through the role table first and only what is not a role reaches the floor, which is exactly
  // what the gaps inside a divided field already get.
  if (!div) return creditGapText(raw);
  const map = foldSpans(raw);
  const spans = [];
  const claim = (s, e, text) => { spans.push([s, e, text]); };
  const taken = (s, e) => spans.some(([a, b]) => s < b && a < e);
  let cursor = 0;
  let previous = -1;
  for (const part of div.p) {
    if (!part.n) continue;
    const at = foldFind(map, raw, part.n, cursor);
    if (!at) continue;
    const sep = previous >= 0 ? creditGap(raw.slice(previous, at[0])) : null;
    if (sep !== null) claim(previous, at[0], sep);
    cursor = at[2];
    previous = at[1];
    // `personShown` answers for every name in English mode, so the claimed span is never the
    // surface any more. The guard stays because this function is also the one place a null would
    // put Japanese back into a line, and §4 says to test for the bad value rather than assume it
    // cannot arrive.
    const shown = personShown(part.n);
    claim(at[0], at[1], shown === null ? enFallback(raw.slice(at[0], at[1])) : shown);
  }
  // A NAME THE FIELD WRITES TWICE IS RENDERED TWICE. `シチサブロー / シチサブロー` and
  // `ホマレ / 大鷹シン / オオタカシン / ホマレ` repeat a credit, and the splitter records each name
  // once, so the ordered pass above claimed the first occurrence and left the second in Japanese
  // beside its own romanisation. Longest first, so a short name cannot claim a span inside a
  // longer one that has not been reached yet.
  for (const part of [...div.p].filter(x => x.n).sort((a, b) => b.n.length - a.n.length)) {
    const shown = personShown(part.n);
    if (shown === null) continue;
    let from = 0;
    for (;;) {
      const at = foldFind(map, raw, part.n, from);
      if (!at) break;
      from = at[2];
      if (!taken(at[0], at[1])) claim(at[0], at[1], shown);
    }
  }
  // THE ROLE SITS EITHER SIDE OF THE NAME. `[著]X` puts it in front and `X(作)` after it, so each
  // role is looked for across the whole field and the first occurrence outside a claimed name is
  // the notation. A role string that is part of somebody's pen name cannot be hit, because every
  // name claimed its span above.
  for (const part of div.p) {
    if (!part.r) continue;
    // THE BYLINE FORM, so a field this walk is drawing states the same jobs the composed line
    // states. `[著]` claimed the span and glossed it `author`, which is the role the owner's ruling
    // says a byline never carries.
    const en = bylineRole(part.r);
    if (en === part.r) continue;
    let from = 0;
    for (;;) {
      const at = foldFind(map, raw, part.r, from);
      if (!at) break;
      from = at[2];
      if (taken(at[0], at[1])) continue;
      claim(at[0], at[1], en);
      break;
    }
  }
  if (div.p.some(x => x.etc)) {
    const at = foldFind(map, raw, 'ほか', 0) || foldFind(map, raw, '他', 0);
    if (at && !taken(at[0], at[1])) claim(at[0], at[1], andOthers());
  }
  // A READING PRINTED BESIDE ITS OWN NAME, taken off. The build hands over the literal because it
  // is the half that knows a bracket holds a reading rather than a note.
  for (const text of div.drop || []) {
    const at = foldFind(map, raw, text, 0);
    if (at && !taken(at[0], at[1])) claim(at[0], at[1], '');
  }
  spans.sort((a, b) => a[0] - b[0]);
  // WHAT NOBODY CLAIMED IS THE OTHER HALF OF THE LINE. The spans are the names and the roles the
  // build identified; between them sit the field's brackets, its separators and anything the
  // division did not account for, and that last group is where a company sat in kanji between two
  // romanised people. `[[翻訳協力]][BPS株式会社] / [著]時一二` glossed the role, romanised nothing
  // else, and printed the firm's name in Japanese. Each gap is floored on its own, so a gap that
  // is only punctuation comes back untouched and a gap holding a name comes back spelled.
  let out = '', at = 0;
  for (const [s, e, text] of spans) {
    if (s < at) continue;
    out += creditGapText(raw.slice(at, s)) + text;
    at = e;
  }
  out += creditGapText(raw.slice(at));
  // TAKING A SPAN OUT LEAVES THE PUNCTUATION THAT WAS AROUND IT. A reading removed from
  // `紬めめ / ツムギメメ` leaves a trailing space and a line ending in a separator reads as a
  // credit the page failed to draw. Only whitespace and separators are touched, and only at the
  // ends or where two have run together.
  return out.replace(/[ \u3000]{2,}/g, ' ')
            .replace(/^[\s\u3000/／、,，・･]+|[\s\u3000/／、,，・･]+$/g, '');
}

/* The catalogue tab's credit line. Kept as a name of its own because the tab reads `index[].c` and
   `adapters/interface.py` names the function that renders it.

   IT RETURNS MARKUP AND THE TAB NO LONGER ESCAPES IT. `creditText` composes text, and a name it
   floored carries the `[?]` token; the tooltip that says why is markup, and this is where the line
   becomes markup. The escaping happens here rather than at the call site so that a second caller
   cannot get the raw text by accident. */
function credit(c) {
  return floorHtml(esc(creditText(c)));
}

/* THE PEOPLE IN A CATALOGUED CREDIT FIELD, each rendered by the store like any other name.

   This was fifteen lines inside renderReleases, which made `w.creator` a field the 発売 tab read
   and pulled apart on its own. A field read in one place and rendered in another is how the works
   list came to print `esc(w.t)` from index.json while workLabel sat unused beside it, so the
   pipeline now asks this function what the tab shows and `adapters/lint/entrypoints.py` refuses a
   read of `creator` anywhere else.

   THE DIVISION IS THE BUILD'S. This split on the slash, took a leading bracket off with
   `stripRole` and dropped a trailing katakana part on the argument that MADB writes one creator as
   `紬めめ / ツムギメメ`. It does, and it also writes `[原作]王月よう / [漫画]アジイチ`, which is two
   people whose second name happens to be katakana; this tab dropped アジイチ, フライ, ヨリフジ and
   サトウナンキ from four bylines in every language. `creditline.py` asks the roles and the store
   before it decides, and the answer arrives here already made.

   A FIELD THE DIVISION DOES NOT ACCOUNT FOR IS RENDERED AS WRITTEN. `part` says the build could
   not place everything the field says, and rebuilding a byline out of an incomplete division is
   how a credit disappears without anything reporting it. */
function creditNames(creator) {
  const div = creditDiv(creator);
  // MARKUP, LIKE THE BRANCH BELOW IT. This returned `creditText`'s plain text into a slot the
  // releases tab interpolates, so the one branch of this function that could carry a floored name
  // was also the one that went out unescaped and without its tooltip.
  if (!div || div.part) return floorHtml(esc(creditText(creator)));
  // THE PEOPLE AND NOT THEIR JOBS. This tab has never shown a role and showing one here would
  // widen a byline the 発売 list has one line for; `creditText` above keeps the role where the
  // field put it, and the work page states it in full.
  const people = div.p.filter(x => x.n).map(x => authorLabel({ author: x.n }));
  if (div.p.some(x => x.etc)) people.push(esc(andOthers()));
  return people.join(' / ');
}

/* The source chips sit OUTSIDE bilingual(). They are links, and two sets of clickable chips to the
   same platforms reads as a bug rather than a translation. But that left them Japanese-only in
   併記, where the whole point is to show both. So the chip carries both names on ONE link instead
   of the row carrying two links. */
/* Publishers and imprints are names, and were the only names on the releases tab left untranslated:
   a reader in English met "講談社 · コミック百合姫" beside an English title. Same rule as a platform
   name, and the same fallback: where there is no English the Japanese stands, because a name we
   cannot render is still the name.

   READ FROM DATA. This was `PUB_EN`, seven names typed here, under a comment saying the corpus
   holds four publishers and a handful of imprints. It holds 389, so 301 of them fell through the
   map and rendered as Japanese beside an English title, and a longer literal would have made the
   same mistake at a larger size. Publisher names live in data/names now, with the basis for each
   rendering and the page it was read from beside it, exactly as titles and authors do.

   KEYED BOTH WAYS, by the string the catalogue holds and by the string this file shows. That was
   written when the cataloguing was stripped here as well as in the generator, and a drift between
   the two cost a lookup the other key still answered. Nothing strips it here now, so the second
   key is a fallback for a name that reaches the shipped data unresolved rather than a hedge
   against two implementations of one rule.

   READ OUT OF feed/names.json, under `publishers`. It was a file of its own, fetched separately
   and written by a script that ran after the build; the map is now one key beside titles and
   authors, which is what it always was. */
let PUBS = null;

function pubRec(n) {
  return (PUBS && (PUBS[n] || PUBS[String(n || '').normalize('NFKC')])) || null;
}

/* A PUBLISHER ROMANISATION FOLLOWS THE ROMANISATION CONTROL, the same rule enAvailable applies to
   a title. This read `rec.en` alone, so a name we spelled ourselves was presented exactly like an
   official one and ignored a preference the reader had set. The three styles are shipped only
   where a romanisation is the name being shown, so this can never replace a reviewed name such as
   Aokishi Comics with a transliteration of it. */
function pubEn(n) {
  const rec = pubRec(n);
  if (!rec) return null;
  return (rec.basis === 'romaji' && rec.romaji && rec.romaji[ROMAJI_STYLE]) || rec.en || null;
}

/* MARKED WHERE THE READING IT IS BUILT FROM IS NOT ATTESTED, which is the rule already settled for
   titles and not a new one. 254 of 323 publisher names are romanisations and marking every one of
   them would land on most of the list, and uncertainMark's own argument is that a mark on
   everything is not a mark. 134 have a reading nothing states, and those are the ones where the
   English could be wrong in a way a reader who knows Japanese can see.

   Returns HTML, so it cannot travel through pubBoth: that returns a plain string which callers
   escape, and its output also fills a <select> option value on the releases filter, where markup
   would be shown literally. The display sites use publisherPartsHtml instead. */
function pubMark(n) {
  const rec = pubRec(n);
  return (LANG === 'en' && rec && rec.basis === 'romaji' && (rec.uncertain || rec.unverified))
    ? `<sup class="unc" title="${esc('the reading this is romanised from is not attested by any '
      + 'source, and may be wrong')}">[?]</sup>`
    : '';
}

/* THE PAIR ON ONE LINE, because every slot this fills is a slot a second line would break: a
   clickable chip, a cell in the imprint table, a run of names joined by ·, and the option value
   on the 発売 filter, which is a string in a <select>. `workLabel` and `authorLabel` answer in one
   language and let `bilingual()` stack the two, and a house name in a heading follows them, so the
   publisher page's own <h2> asks bilingual() for this and gets one language per line. */
function pubBoth(n) {
  if (!n) return '';
  const en = pubEn(n);
  // A HOUSE THE MAP HAS NOTHING FOR IS FLOORED LIKE ANY OTHER NAME. 集英社ホームコミックス is the
  // umbrella a sub-line sits under and no entry answers for it, so this returned the Japanese into
  // an English page's imprint cell. The floor spells it and marks it, and the pair form keeps the
  // Japanese on its own side where a reader asked for both.
  const shown = (en && en !== n) ? en : (LANG === 'en' ? enFallback(n) : null);
  if (shown === null) return n;
  return LANG === 'en' ? shown : LANG === 'ja' ? n : `${n} / ${shown}`;
}

function platBoth(n) {
  if (!n) return '';
  const en = PLAT_EN[n];
  if (!en || en === n) return n;
  return LANG === 'en' ? en : LANG === 'ja' ? n : `${n} / ${en}`;
}

function platName(n) {
  // A name, not a phrase: shown as one or the other, never "ガンガンONLINE / GANGAN ONLINE".
  // That doubles the width of a meta line for no gain. Absent from the map means already Latin,
  // or no rendering worth asserting.
  return (LANG === 'en' && PLAT_EN[n]) || n || '';
}

