/* Preference persistence (localStorage, never cookies).
   Cookies are sent to the server on every request; localStorage never leaves the browser, so
   nothing about the reader reaches GitHub or anyone else. Values are written only in response to
   an explicit choice, and hold no identifier: see the note in the footer. */
const PREF_THEME = 'yurarium.pref.theme';
const PREF_VIEW  = 'yurarium.pref.view';

function prefGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }          // private mode or storage disabled
}
function prefSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* non-fatal */ }
}

function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  document.querySelectorAll('.themebtn[data-theme-set]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode)));
}
applyTheme(prefGet(PREF_THEME, 'auto'));
document.querySelectorAll('.themebtn[data-theme-set]').forEach(b =>
  b.addEventListener('click', () => {
    applyTheme(b.dataset.themeSet);
    prefSet(PREF_THEME, b.dataset.themeSet);   // explicit action only
  }));

// Search text is deliberately NOT persisted: restoring a stale query on load is surprising.
// `spage` is here for the same reason `fview` is: how much of a list is drawn at once is a
// preference about the reader's machine, not a statement about the works, so it persists and it
// stays out of RESETS and out of the chip row.
const VIEW_FIELDS = ['fmodel', 'ftype', 'fview', 'fplat', 'sort', 'filter',
                     'sstate', 'sfree', 'splat', 'ssort', 'spage', 'fvis', 'svis', 'rvis'];
function saveView() {
  const v = { tab: document.querySelector('nav button[aria-selected=true]')?.dataset.tab };
  VIEW_FIELDS.forEach(id => { const e = el(id); if (e) v[id] = e.value; });
  prefSet(PREF_VIEW, v);
}
function restoreView() {
  const v = prefGet(PREF_VIEW, null);
  if (!v) return;
  VIEW_FIELDS.forEach(id => {
    const e = el(id);
    if (e && v[id] != null && [...e.options].some(o => o.value === v[id])) e.value = v[id];
  });
  if (v.tab) document.querySelector(`nav button[data-tab="${v.tab}"]`)?.click();
  // The three visibility selects hold one value between them, and this sets element values
  // directly rather than going through the change handler that keeps them in step.
  if (typeof syncVis === 'function') syncVis();
}

const KANA = 0x60;
/* SEARCH FOLDING. NFKC, case, and hiragana to katakana, plus the macrons.
   Diacritics are folded because a reader who sees Waingāruzu and cannot type ā will write
   Waingaruzu, and ā is never anything but a long a, so the fold cannot lose a distinction.
   ASCII doubles are deliberately NOT folded. Collapsing ou or ee looks symmetrical but titles mix
   scripts: Yuri Fechi LIFE, IDOL×IDOL STORY！. Folding doubles turns Free into Fre, and it erases
   a real difference, since ゆり and ゆうり are different words. The doubled romanisation is indexed
   in full instead, which covers the same input without the damage. */
const MACRONS = { 'ā':'a', 'ī':'i', 'ū':'u', 'ē':'e', 'ō':'o', 'â':'a', 'î':'i', 'û':'u', 'ê':'e', 'ô':'o' };
const norm = s => String(s||'').normalize('NFKC').toLowerCase()
  .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0)+KANA))
  .replace(/[āīūēōâîûêô]/g, c => MACRONS[c] || c);

/* Spacing is presentation, not identity, which is the judgement store.same_reading already makes
   on the build side. Readings arrive word-separated (ハル ナツ アキ フユ) and a reader typing
   ハルナツアキフユ means the same thing; equally "bloom into you" must still match when typed with
   its spaces. Both sides are compared stripped as well as intact, in ONE place, so every field
   gets the same treatment whether or not it came through searchIndex. */
const bare = s => s.replace(/\s+/g, '');
const hits = (index, q) => index.includes(q) || bare(index).includes(bare(q));

/* Every form of a name, whichever one is on screen.

   English mode showed romaji for 87% of the catalogue and searched none of it: the box matched the
   stored Japanese only, so a reader could search only the text the interface was hiding
   from them. Typing Yuri returned nothing.

   All forms go in regardless of which is displayed. That matters most once a work HAS a
   translation: the interface then shows the English name and hides the romanisation, so indexing
   only what is shown would mean translating a title makes it unfindable by the romaji somebody
   already knew it by. The kana reading is in too, so 百合の花 answers to ゆりのはな without the
   reader knowing the kanji.

   Built once per render rather than per keystroke, and independent of the style toggle: a
   preference about display should not change which rows exist. */
function searchIndex(kind, raw, existing) {
  const rec = nameFor(kind, raw, existing);
  const out = [raw];
  if (rec) {
    if (rec.reading) out.push(rec.reading);
    if (rec.en) out.push(rec.en);
    if (rec.romaji) out.push(rec.romaji.macron, rec.romaji.double, rec.romaji.plain);
  }
  return norm(out.filter(Boolean).join(' '));
}
const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

let INDEX = [], FEED = null, SERIES = null, DETAIL = null, open = null;
// The releases tab's rows, rendered once and then only filtered. See renderReleases.
let REL_ROWS = [];
/* The updates tab is a 14-day window. Earlier months are separate files, fetched only when a reader
   asks for one, and kept once fetched: going back and forth between two months should not re-cost
   the download. META is feed/meta.json: everything in the old feed.json that was not a release row,
   held once instead of repeated in every month. */
let META = null;
const ARCHIVE = new Map();      // "YYYY-MM" -> the parsed month file
const ARCH_PENDING = new Set(); // months being fetched, so a re-render does not fetch twice
let LANG = prefGet('lang', 'both');

/* Split the "日本語 / english" strings the interface is already written in. Captured once into a
   data attribute, so switching back and forth is lossless: re-splitting an already-split string
   would strip a further half each time. */
function splitLang(s, lang) {
  const i = s.indexOf(' / ');
  // A platform name has no " / " to split on, so it falls through here. The filter dropdowns
  // are built from raw names. PLAT_EN is consulted alongside EN so those options localise too;
  // dataset.orig keeps the Japanese, which is what the filter actually matches on.
  if (i < 0) return lang === 'en' ? curly(respell(EN[s.trim()] || PLAT_EN[s.trim()] || s)) : s;
  // Respelt on the English half only. The Japanese half is untouched, and 併記 keeps both.
  return lang === 'ja' ? s.slice(0, i)
       : lang === 'en' ? curly(respell(s.slice(i + 3)))
       : s.slice(0, i) + ' / ' + curly(respell(s.slice(i + 3)));
}
/* Bilingual strings built in JS, where there is no element to carry data-i18n.
   One argument is a badge: look it up in EN, and in 併記 mode show the Japanese alone, because
   "話 / ch" is wider than the row it sits in. Two arguments is prose, which gets both. */
/* The interface's own English is text we wrote, so it follows the spelling setting like the
   translations do. Romanisation is itself one of the words the switch is about, and it is the
   label on the control offering the switch, which is where the omission showed. */
function T(ja, en) {
  const e = en !== undefined ? en : EN[ja];
  if (!e || e === ja) return ja;
  if (LANG === 'en') return curly(respell(e));
  if (LANG === 'ja') return ja;
  return en !== undefined ? `${ja} / ${curly(respell(e))}` : ja;
}

/* Label form: always ONE language, never both. Badges and the volume-count column have no room
   for "巻 / vols", and a two-language string in a 3-character cell reads as noise rather than as
   help. Use T() for prose, L() for anything that sits in a fixed-width slot. */
function L(ja, en) {
  return LANG === 'en' ? curly(respell(en !== undefined ? en : EN[ja] || ja)) : ja;
}



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

/* ── WORKS HELD OUT OF THE DEFAULT LISTING ────────────────────────────────────────────────────

   DEFINITIONS §2 admits a work a comparator lists and calls that admission presumptive and
   rebuttable. `visibility` on a series row is the rebuttal, and it is NOT a deletion: the work
   keeps its record, its identifier and its page, and the page has to go on answering. What changes
   is the listing, because the two errors are not the same size. A work wrongly present is visible
   and can be argued with; a work wrongly absent is invisible, and the reader who needed it never
   learns it was ever there.

   TWO VALUES AND THEY DO NOT MEAN THE SAME THING, which is why a reader who opts in is shown
   which is which. `rebutted` is a source disagreeing with a source: the publisher's own platform
   declined a designation a shop applied, and DEFINITIONS §4 says which of the two speaks for the
   publisher. `marginal` is the operator declining to decide, which DEFINITIONS §9 says is where
   this database stops rather than a gap in it.

   §15 SAYS WHAT KIND OF CONTROL THIS IS. It narrows the body already on screen, so it is a filter:
   it sits with the other filters, it persists like them, and it is not in history, so Back never
   changes what a reader can see. That is deliberately unlike the language and theme controls,
   which are preferences, and unlike the tab, which is navigation. */
const VIS_LABEL = {
  rebutted: ['異議あり', 'rebutted'],
  marginal: ['判断保留', 'marginal'],
};
const VIS_WHY = {
  rebutted: 'A source disagrees with a source: the publisher\u2019s own platform declines the '
          + 'designation a listing applied. The work is kept, and its page answers as usual.',
  marginal: 'The operator has declined to decide. The work is kept, and its page answers as usual.',
};

/* The row-level answer, wherever the row came from. `visibility` is put on the SERIES row and on
   nothing else, so a release row and a feed row have to be joined back to it: by work id where the
   row carries one, and by title where it does not. Built once, from SERIES, so the three lists
   cannot come to different conclusions about the same work. */
let VIS_BY_ID = new Map(), VIS_BY_WORK = new Map();
function indexVisibility() {
  VIS_BY_ID = new Map(); VIS_BY_WORK = new Map();
  ((SERIES && SERIES.series) || []).forEach(r => {
    if (!r.visibility) return;
    if (r.id) VIS_BY_ID.set(r.id, r.visibility);
    if (r.work) VIS_BY_WORK.set(foldKey(r.work), r.visibility);
    (r.print || []).forEach(pr => pr.work_id && VIS_BY_ID.set(pr.work_id, r.visibility));
  });
}

function visOf(row) {
  if (!row) return null;
  if (row.visibility) return row.visibility;
  return (row.id && VIS_BY_ID.get(row.id))
      || (row.work_id && VIS_BY_ID.get(row.work_id))
      || (row.work && VIS_BY_WORK.get(foldKey(row.work)))
      || null;
}

// Whether the reader has asked to see them. One value behind three controls, because the three
// lists are three views of one decision and a reader who opted in on one has opted in.
let VIS_SHOW = false;
function visShown(row) { return VIS_SHOW || !visOf(row); }

/* The mark a row carries when it is on screen BECAUSE the reader asked. A reader who opted in is
   owed which ones they opted into, and the two dispositions are different claims. */
function visTag(row) {
  const how = visOf(row);
  if (!how || !VIS_SHOW) return '';
  const [ja, en] = VIS_LABEL[how] || [how, how];
  return `<span class="k k-vis" title="${esc(VIS_WHY[how] || '')}">${esc(T(ja, en))}</span>`;
}

/* ── the sources table on a work page ─────────────────────────────────────────────────────────

   A SOURCE NAME IS A PROPER NOUN and needs no translation, which is why the sources section
   authors so few strings: the column headers, five words for what kind of party a source is, and
   two for what it was read for. Everything else in those tables is a name or a quotation.

   Some of those proper nouns have an English form all the same, and one function has to find it
   wherever it lives. A shop is neither a publisher nor a platform, so it fits neither map already
   here; a bibliography is neither either. Reading all three in one place keeps "what is this
   source called in English" a single question with a single answer. */
const SRC_EN = {
  'コミックシーモア': 'Comic Cmoa',
  'メディア芸術データベース': 'Media Arts Database',
  '国立国会図書館サーチ': 'NDL Search',
};

function sourceBoth(n) {
  if (!n) return '';
  const en = SRC_EN[n] || pubEn(n) || PLAT_EN[n];
  if (!en || en === n) return n;
  return LANG === 'en' ? en : LANG === 'ja' ? n : `${n} / ${en}`;
}

/* WHAT KIND OF PARTY IS SPEAKING, in words, because the table shows strength as an ordering and a
   reader still needs to know who each row is. The enum is credence.py's and is closed. */
const EV_TYPE = {
  publisher: ['出版社', 'publisher'],
  platform: ['掲載サイト', 'platform'],
  magazine: ['掲載誌', 'magazine'],
  retailer: ['書店', 'retailer'],
  listing: ['情報サイト', 'listing site'],
};
const EV_HOLDS = {
  volumes: ['巻数・刊行日', 'volume counts and dates'],
  chapters: ['話数・公開状況', 'chapters and availability'],
  // What a platform says about whether the serialisation is still going. `state_claims` carries
  // the platform's own word for it, so the row quotes that and this only names the subject.
  'serialisation-status': ['連載状況', 'serialisation status'],
  'delivery-date': ['配信開始日', 'delivery start date'],
  // WHO SAYS THE BOOK IS BY THIS PERSON. The page cited who catalogued a volume count and not who
  // states the byline, which is the fact at the top of it. The project owner's ruling of
  // 2026-08-08 puts the ATTRIBUTION here and the NAME's own provenance on the credit's page: the
  // reading and its source belong to the person, and repeating them on every work they are on
  // would be one fact with many producers.
  // EVERY OTHER VALUE HERE NAMES THE FACT CITED, and so does this one now. A catalogue states a
  // byline the publisher set, which is the fact, and the label says so.
  attribution: ['作者の出典', 'the byline'],
  // AND WHERE AN ENGLISH TITLE CAME FROM. `official-jp` and `licensed` are shown unmarked, because
  // neither is our claim, so the one form a reader has no reason to doubt was the one carrying no
  // evidence at all. 286 titles were in that state with the licensor's page sitting in the store.
  'english-title': ['英語題の出典', 'the English title'],
};
const evType = k => (EV_TYPE[k] ? T(EV_TYPE[k][0], EV_TYPE[k][1]) : (k || ''));
const evHolds = k => (EV_HOLDS[k] ? T(EV_HOLDS[k][0], EV_HOLDS[k][1]) : (k || ''));

/* WHO MADE THE CLAIM. The row names the party, and for an imprint row that party is the publisher
   whose imprint it is, which `adapters/classify/credence.py` reads off the record's `publisher`
   field and nothing else.

   THIS COLUMN CARRIED THE SAME FAULT AS THE VOLUMES SECTION, one layer removed and worse for it.
   The evidence table exists to say who is claiming a work is yuri, and while the record stored
   `[発売]講談社` this cell took the bracket off and printed 講談社: the table stated that 講談社
   had filed 132 works as yuri under a 一迅社 imprint. It agreed with the volumes section, which
   was the intent, and both were wrong about the same field. The record separates the two roles
   now, so neither reading has anything left to strip and the agreement is on a fact instead of on
   a habit.

   AN IMPRINT IS STILL NORMALISED, and that is a different job. MADB spells one imprint at least
   six ways, `IDコミックス. Yurihime comics = コミック百合姫` among them, and six spellings of
   百合姫 in one table read as six different imprints. `imprintOf` picks the most specific segment
   and maps a Latin spelling onto the Japanese name of the same line, which drops notation and
   never a term. Same function the volumes section uses, so the two cannot drift. */
const evSource = e => ((e.type === 'publisher' || e.type === 'magazine')
  ? pubBoth(e.source) : sourceBoth(e.source));
/* A GENRE WORD IS A SHORT CONTROLLED VOCABULARY, and a shop uses a handful of them. Quoting the
   source is the point of this column, so the Japanese is what the row means, and an English-only
   reader was still being shown 百合 with no way in. The English is given and the source's own word
   is kept on the title, so the quotation survives and the page carries no untranslated Japanese.

   An imprint is a NAME and goes through imprintOf, which is the publisher store's job and not a
   glossary's. Nothing here invents an English form for one. */
const TERM_EN = {
  '百合': 'yuri', '百合・GL': 'yuri and GL', 'GL': 'GL', 'ゆり': 'yuri',
  'ongoing': 'ongoing', '連載中': 'ongoing', 'finished': 'finished', '完結': 'finished',
};
const evTerm = e => {
  // AN IMPRINT IS A NAME AND THE PUBLISHER STORE HOLDS ITS ENGLISH. imprintOf normalises the six
  // spellings MADB uses onto one Japanese name, which is a different job from rendering it, so ten
  // terms reached an English page reading IDコミックス. The volumes section already pairs the two.
  if (e.kind === 'imprint') return pubBoth(imprintOf(e.term));
  const en = TERM_EN[e.term];
  return (LANG === 'en' && en) ? en : e.term;
};
const evTermTitle = e => ((LANG === 'en' && TERM_EN[e.term] && TERM_EN[e.term] !== e.term)
  ? e.term : '');

/* THE CUE IS A SHAPE, NOT A COLOUR, so it carries for a reader who cannot tell two colours apart.
   Three segments over five ranks: the publisher's own imprint fills all three, its other §4
   labelling fills two, and a comparator fills one. That is the line the documents actually draw,
   and grouping to it beats inventing five gradations nobody decided.

   It is hidden from assistive technology on purpose. The rows are sorted strongest first and the
   heading says so, so a bar repeating that in a language nobody wrote would be noise. */
const RANK_BARS = { 1: 3, 2: 2, 3: 2, 4: 1, 5: 1 };
const rankCue = rank => `<span class="wp-bars" aria-hidden="true">${
  [1, 2, 3].map(i => `<i${i <= (RANK_BARS[rank] || 1) ? ' class="on"' : ''}></i>`).join('')}</span>`;

/* THE DATE IS THE LINK, and the source name is not. What we hold is the page a claim was READ
   from, and that page belongs to whoever served it rather than to whoever made the claim: an
   imprint is the publisher's act recorded by the national bibliography, so a link under 一迅社
   would take a reader to mediaarts-db. Putting it on the date says what it is, and the same
   mistake in the other direction put the bibliography under a heading reading "Sold at". */
/* Rows of rendered cells to table markup, keeping the first of any two that READ alike and the
   order they arrived in. Two rows a reader cannot tell apart are one row.

   Compared on the text and not on the markup, which is the whole point. Two editions of one work
   have two catalogue records, so the same imprint claim arrives twice with a different address
   behind the date, and comparing the markup left both rows standing and the table saying the same
   thing twice. The reader is being shown one claim; the first address stands for it. */
function onceEach(rows) {
  const seen = new Set(), out = [];
  for (const cells of rows) {
    const html = cells.join('');
    const key = html.replace(/<[^>]*>/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`<tr>${html}</tr>`);
  }
  return out.join('');
}

function readCell(x) {
  const d = x.read ? esc(fmtDate(x.read, { year: true })) : '';
  if (!d || !x.url) return d;
  const host = String(x.url).replace(/^https?:\/\//, '').split('/')[0];
  return `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer nofollow"
     title="${esc(host)}">${d}</a>`;
}

/* Set once from run.json, re-rendered on every language change like the rest of the chrome. */
let TRACK_FROM = null;
/* The footer, in whichever language is showing. The reasoning behind the dating caveat and the
   whole of the storage arrangement live on status.html; a footer states the consequence and points
   there, rather than explaining the machinery to somebody who came to read about manga. */
/* STACKED, NOT SLASHED. T() joins the two languages with " / ", which is right for a badge or a
   count line where the pair is short. A footer paragraph is a sentence, and two sentences spliced
   by a slash read as one long broken one. The rows already stack their English underneath in
   .bi-en; the footer uses the same treatment so the page has one answer to this rather than two. */
function ftLine(ja, en) {
  if (LANG === 'ja') return ja;
  if (LANG === 'en') return en;
  return `${ja}<span class="bi-en">${en}</span>`;
}

function renderByline() {
  const p = el('byline');
  if (p) p.innerHTML = ftLine('日本の百合漫画のデータベース', 'A database of Japanese yuri manga');
}

function renderFooter() {
  // EACH HALF IS BUILT WHOLE, in its own language, and T() then picks. Calling T() for the
  // database name and dropping the result into another T() nested the doubling: 併記 mode read
  // "文化庁メディア芸術データベース / Media Arts Database" inside the Japanese sentence AND inside
  // the English one. A name is part of the sentence it sits in, not a separate decision.
  const MADB_URL = 'https://mediaarts-db.artmuseums.go.jp/';
  const OPENBD = '<a href="https://openbd.jp/">openBD</a>';
  el('ftsource').innerHTML = ftLine(
    `書誌情報は<a href="${MADB_URL}">文化庁メディア芸術データベース</a>（1.2.18）と${OPENBD}、`
    + `更新情報は各プラットフォームの配信元から。事実に著作権はなく、独自の分類と注記は CC0。`
    + `表紙画像・あらすじ・漫画本編は掲載していません。`,
    `Bibliographic facts from <a href="${MADB_URL}">Media Arts Database</a> (1.2.18) and ${OPENBD};`
    + ` release data from publishers' own feeds. Facts are not copyrightable; original`
    + ` classifications and notes are CC0. No cover art, synopses or manga are hosted here.`);

  // A link, not a paragraph. What the page contains is the page's business, and a footer that
  // explains its own links is spending a reader's attention on navigation rather than on manga.
  el('ftstatus').innerHTML =
    `<a href="status.html">${T('内部状態', 'build status')}</a>`;

  // The button follows the whole pair rather than riding on the English line, which is where a
  // trailing concatenation would put it in 併記 mode. Its LABEL keeps the slash form, unlike the
  // sentences above it: that is what every other control on the page does in 併記 (the tabs read
  // "更新 / Updates"), and a two-word label is the case the slash was always for. Stacking a
  // button's label would make the control two lines tall for no gain.
  el('ftprefs').innerHTML = ftLine(
    '表示設定（テーマ・タブ・絞り込み）はブラウザのローカルストレージに保存されます。'
    + 'クッキーは使用せず、設定がインターネットに送信されることはありません。',
    "This site stores your display preferences (theme, tab and filters) in your own browser's "
    + 'local storage. No cookies are set, and no preferences are sent over the Internet.')
    + `<span class="ftclear"><button id="clearprefs" class="themebtn">`
    + `${T('設定を消去', 'clear preferences')}</button></span>`;
  wireClearPrefs();
}

/* SAID ONCE. The dating caveat used to carry its own build-status link, and there was a second
   paragraph carrying another one, so the footer pointed at the same page twice within four lines.
   The caveat states the consequence; the reasoning is on status.html, which the line below links. */
function renderTrackNote() {
  const p = el('trackfrom');
  if (!p || !TRACK_FROM) return;
  p.hidden = false;
  /* AND WHOSE CLOCK THEY ARE ON. Every date here is Japan's, because every publication this
     database describes is dated in JST and a run just after midnight in Tokyo is the middle of the
     previous afternoon in UTC. The consequence a reader meets is a retrieval date that has not
     happened yet where they are: 1,561 rows read 2026-08-11 on the 10th. The dates were right and
     nothing said which clock they were read by. */
  p.innerHTML = ftLine(
    `更新の追跡開始は ${TRACK_FROM}。それ以前のウェブ漫画の公開日は正確とは限りません。`
    + `日付はすべて日本時間です。`,
    `Update tracking began on ${TRACK_FROM}. Web manga publication dates before ${TRACK_FROM}`
    + ` may not be reliable. Every date on this site is Japan time, so one may be a day ahead of`
    + ` yours.`);
}

/* Said once rather than stamped on every reading. While essentially all of them are machine
   guesses, a per-item mark states the default and tells a reader nothing; this states the actual
   situation and stops being needed when sourced readings outnumber guessed ones. */
/* WHERE THE CONVENTION IS EXPLAINED, and where it is not. This used to be a paragraph above the
   list, shown whenever furigana was on. It said in aggregate what the page already says per
   reading: an unverified one is marked where it appears, which is better, because it names WHICH
   are guesses rather than saying most of them are. Above the list it also stacked a third grey
   line under the count and the period note.

   It is still worth saying once, because the mark is quiet by design and a reader meeting it for
   the first time has nothing to read it against. So it sits beside the control that turns the
   readings on, like the spelling and precedence notes do, and it says the marks exist.

   The MARK itself is untouched and is not up for tidying: FEATURES-INTERFACE §5 makes it the one
   piece of our own uncertainty shown to readers, on purpose. */
function renderFuriNote() {
  const n = el('furinote');
  if (!n) return;
  // WHAT THE READER HAS TO KNOW IS WHAT THE MARK MEANS, and nothing else. This opened by saying
  // most readings are generated, which put a proportion in front of somebody looking at one name,
  // and the proportion is no longer even the same for both: 85% of title readings are the
  // analyser's against 14% of author readings, after a round of sourcing moved 460 of them.
  // The mark's own tooltip says the reading is not attested by any source, so the note says
  // the same thing in fewer words. Estimated was wrong: a reading is not an approximation,
  // it is either what people say or it is not.
  n.textContent = T('出典のない読みには印がつきます。', 'A reading no source states is marked.');
}

/* A control that is not applicable keeps its space. Using [hidden] meant every language switch
   removed a group from the layout and the whole header (and the tab strip under it) jumped. The
   space costs nothing; the jump costs the reader their place. Kept out of the tab order and the
   accessibility tree while inert, so it is only visually reserved. */
function setApplicable(box, on) {
  box.classList.toggle('inert', !on);
  box.setAttribute('aria-hidden', String(!on));
  box.querySelectorAll('button').forEach(b => { b.tabIndex = on ? 0 : -1; });
}

/* Inside the popup a group is a block, so it marks itself with an attribute the panel's own rules
   read. Same idea as setApplicable: keep the space, drop out of the tab order. */
function setGroupApplicable(box, on) {
  if (!box) return;
  if (on) box.removeAttribute('data-inert'); else box.setAttribute('data-inert', '1');
  box.setAttribute('aria-hidden', String(!on));
  box.querySelectorAll('button').forEach(b => { b.tabIndex = on ? 0 : -1; });
}

function applyRomajiVisibility() {
  const box = el('rjbox');
  if (box) {
    // Not applicable in 日本語 mode. It would offer a choice about text that is not on the page.
    setGroupApplicable(box, LANG !== 'ja');
    box.querySelectorAll('[data-romaji-set]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.romajiSet === ROMAJI_STYLE)));
  }
  const fb = el('furibox');
  if (fb) {
    setGroupApplicable(fb, LANG !== 'en');   // nothing to annotate when the Japanese is replaced
    el('furibtn').setAttribute('aria-pressed', String(!!FURIGANA));
  }
  setGroupApplicable(el('enorderbox'), LANG !== 'ja');
  const nb = el('norderbox');
  if (nb) {
    // Only in English. In 日本語 the name is shown as written and there is no order to choose.
    setGroupApplicable(nb, LANG !== 'ja');
    nb.querySelectorAll('[data-nameorder-set]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.nameorderSet === NAME_ORDER)));
  }
  const fb2 = el('datebox');
  /* THE EXAMPLE IS TODAY'S DATE. Both buttons carried a frozen `2026-08-05` written into the
     markup on the day they were added, so the tip offered a sample that was neither today nor
     anything on the page, and drifted further from both every day. Rendered through `fmtDate`,
     which is the function the choice actually changes, so the tip cannot disagree with the
     setting it describes. */
  if (fb2) fb2.querySelectorAll('[data-datefmt-set]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.datefmtSet === DATEFMT));
    const was = DATEFMT;
    DATEFMT = b.dataset.datefmtSet;
    try { b.setAttribute('title', fmtDate(todayISO(), { year: true })); } finally { DATEFMT = was; }
  });
  const db = el('dialbox');
  if (db) {
    setGroupApplicable(db, LANG !== 'ja');
    db.querySelectorAll('[data-dialect-set]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.dialectSet === DIALECT)));
  }
  renderEnOrder();
  renderDialNote();
  markMoreActive();
  renderFuriNote();
}

/* The "…" button lights when anything behind it is set, because a control that hides its own state
   is a control the reader has to open to check. Same accent as the filter row uses for the same
   meaning: this is set, not this is wrong. */
function markMoreActive() {
  const b = el('morebtn');
  if (!b) return;
  const changed = ROMAJI_STYLE !== 'macron' || FURIGANA || DIALECT !== 'gb'
    || EN_ORDER.join() !== EN_DEFAULT.join();
  if (changed) b.setAttribute('data-active', '1'); else b.removeAttribute('data-active');
}

/* HOW MANY WORKS EACH LEVEL WOULD ACTUALLY BE USED FOR, in the order currently set. Not how many
   hold that form, which is a different and much less useful number: with the default order,
   Licensed is held by six works and used for the four of them that have no official English name.

   Counting the effect rather than the availability is also what makes "this will not apply"
   exact. An earlier version guessed at it by looking for a level held by every work, which never
   fired, because romaji is held for 1,045 of 1,074 and not for all of them. A level used zero
   times is used zero times, and there is nothing to infer.

   Counted from the data on screen rather than baked at build time, so the numbers cannot drift
   away from the file they describe. */
function enLevelCounts(order) {
  order = order || EN_ORDER;
  const out = { licensed: 0, 'official-jp': 0, translated: 0, romaji: 0, total: 0, none: 0 };
  if (!NAMES || !NAMES.titles) return out;
  for (const k in NAMES.titles) {
    out.total++;
    const have = enAvailable(NAMES.titles[k]);
    const used = order.find(lv => have[lv]);
    if (used) out[used]++; else out.none++;
  }
  return out;
}

function renderEnOrder() {
  const ol = el('enorder');
  if (!ol) return;
  const counts = enLevelCounts();
  ol.innerHTML = '';
  EN_ORDER.forEach((lv, i) => {
    const li = document.createElement('li');
    li.className = 'enorow';
    li.draggable = true;
    li.dataset.level = lv;
    // Zero works reach this level in the order as it stands, so moving it about below its current
    // position changes nothing on the page. Struck through rather than hidden: the reader put it
    // there, and it has to stay visible to be dragged back out.
    if (!counts[lv]) li.dataset.dead = '1';
    const [ja, en] = EN_LEVEL_LABEL[lv];
    li.innerHTML =
      `<span class="grip" aria-hidden="true">⠿</span>` +
      `<span class="nm">${esc(T(ja, en))}</span>` +
      `<span class="ct">${counts[lv]}</span>` +
      `<button class="mv" data-mv="up" ${i === 0 ? 'disabled' : ''} ` +
        `aria-label="${esc(T('上へ', 'move up'))}">▲</button>` +
      `<button class="mv" data-mv="down" ${i === EN_ORDER.length - 1 ? 'disabled' : ''} ` +
        `aria-label="${esc(T('下へ', 'move down'))}">▼</button>`;
    ol.appendChild(li);
  });
  const note = el('enordernote');
  if (note) {
    const dead = EN_LEVELS.filter(lv => !counts[lv]);
    const base = T('数字はこの順序で実際に使われる作品数です。',
                   'The number is how many works actually use that form, in this order.');
    note.textContent = dead.length
      ? base + T(' 取り消し線の項目は現在どの作品にも使われません。',
                 ' Struck-through entries are used by no work as things stand.')
      : base;
  }
}

function renderDialNote() {
  const n = el('dialnote');
  if (!n) return;
  n.textContent = T(
    'ライセンス版・公式英題には適用されません。題名そのものだからです。',
    'Not applied to licensed or official titles: the spelling is part of the name.');
}

function setEnOrder(next) {
  EN_ORDER = next;
  prefSet(PREF_ENORDER, EN_ORDER);
  renderEnOrder();
  markMoreActive();
  repaintAll();
}

function moveLevel(from, to) {
  if (to < 0 || to >= EN_ORDER.length || from === to) return;
  const next = EN_ORDER.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  setEnOrder(next);
}
document.addEventListener('DOMContentLoaded', () => {
  const fb = el('furibtn');
  if (fb) fb.addEventListener('click', () => {
    FURIGANA = !FURIGANA;
    prefSet(PREF_FURI, FURIGANA);
    applyRomajiVisibility();
    repaintAll();
  });
  document.querySelectorAll('[data-romaji-set]').forEach(b =>
    b.addEventListener('click', () => {
      ROMAJI_STYLE = b.dataset.romajiSet;
      prefSet(PREF_ROMAJI, ROMAJI_STYLE);
      applyRomajiVisibility();
      repaintAll();
    }));
  document.querySelectorAll('[data-nameorder-set]').forEach(b =>
    b.addEventListener('click', () => {
      NAME_ORDER = b.dataset.nameorderSet;
      prefSet(PREF_NORDER, NAME_ORDER);
      applyRomajiVisibility();
      repaintAll();
    }));
  document.querySelectorAll('[data-datefmt-set]').forEach(b =>
    b.addEventListener('click', () => {
      DATEFMT = b.dataset.datefmtSet;
      prefSet(PREF_DATEFMT, DATEFMT);
      applyRomajiVisibility();
      repaintAll();
    }));
  document.querySelectorAll('[data-dialect-set]').forEach(b =>
    b.addEventListener('click', () => {
      DIALECT = b.dataset.dialectSet;
      prefSet(PREF_DIALECT, DIALECT);
      // The markup-level strings are rewritten by the language pass and by nothing else, so the
      // panel's own label kept saying romanisation after the reader asked for en-US.
      applyLang(LANG);
      applyRomajiVisibility();
      repaintAll();
    }));

  // THE POPUP. Same open/close contract as the month picker: the button toggles, a click outside
  // or Escape closes, and focus returns to the button so a keyboard is not left adrift.
  const mb = el('morebtn'), mp = el('morepop');
  if (mb && mp) {
    const setOpen = on => {
      mp.hidden = !on;
      mb.setAttribute('aria-expanded', String(on));
    };
    mb.addEventListener('click', e => { e.stopPropagation(); setOpen(mp.hidden); });
    // Clicks inside must not reach the document handler that closes it, or dragging a row would
    // shut the panel underneath the reader's hand.
    mp.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !mp.hidden) { setOpen(false); mb.focus(); }
    });
  }

  // REORDERING. Drag for a mouse, buttons for everything else. The buttons are not a fallback
  // bolted on: drag is unavailable to a keyboard and unreliable on a touch screen, and this is a
  // setting a reader may want to change once and never again.
  const ol = el('enorder');
  if (ol) {
    let dragging = null;
    ol.addEventListener('click', e => {
      const btn = e.target.closest('.mv');
      if (!btn) return;
      const row = btn.closest('.enorow');
      const from = EN_ORDER.indexOf(row.dataset.level);
      moveLevel(from, from + (btn.dataset.mv === 'up' ? -1 : 1));
      // Keep the keyboard on the row that moved rather than on the index it vacated.
      const moved = ol.querySelector(`[data-level="${row.dataset.level}"]`);
      const same = moved && moved.querySelector(`[data-mv="${btn.dataset.mv}"]`);
      if (same && !same.disabled) same.focus(); else if (moved) moved.focus();
    });
    ol.addEventListener('dragstart', e => {
      const row = e.target.closest('.enorow');
      if (!row) return;
      dragging = row.dataset.level;
      row.setAttribute('aria-grabbed', 'true');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without data set on the transfer.
      try { e.dataTransfer.setData('text/plain', dragging); } catch (err) { /* older browsers */ }
    });
    ol.addEventListener('dragover', e => {
      e.preventDefault();
      const row = e.target.closest('.enorow');
      ol.querySelectorAll('.enorow').forEach(r => r.classList.toggle('over', r === row));
    });
    ol.addEventListener('dragleave', e => {
      const row = e.target.closest('.enorow');
      if (row) row.classList.remove('over');
    });
    ol.addEventListener('drop', e => {
      e.preventDefault();
      const row = e.target.closest('.enorow');
      if (!row || !dragging) return;
      moveLevel(EN_ORDER.indexOf(dragging), EN_ORDER.indexOf(row.dataset.level));
      dragging = null;
    });
    ol.addEventListener('dragend', () => {
      dragging = null;
      ol.querySelectorAll('.enorow').forEach(r => {
        r.classList.remove('over'); r.removeAttribute('aria-grabbed');
      });
    });
  }
  applyRomajiVisibility();
});

function applyLang(lang) {
  LANG = lang;
  prefSet('lang', lang);
  document.documentElement.lang = lang === 'en' ? 'en' : 'ja';
  document.querySelectorAll('[data-lang-set]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.langSet === lang)));
  document.querySelectorAll('option, [data-i18n], nav button').forEach(e => {
    if (e.dataset.orig === undefined) {
      // nav buttons carry a count span that must survive the rewrite
      const n = e.querySelector && e.querySelector('.n');
      e.dataset.orig = n ? e.firstChild.textContent.trim() : e.textContent.trim();
    }
    const out = splitLang(e.dataset.orig, lang);
    const n = e.querySelector && e.querySelector('.n');
    if (n) { e.firstChild.textContent = out + ' '; } else { e.textContent = out; }
  });
  document.querySelectorAll('input[placeholder]').forEach(e => {
    if (e.dataset.origPh === undefined) e.dataset.origPh = e.placeholder;
    e.placeholder = splitLang(e.dataset.origPh, lang);
  });
  applyRomajiVisibility();
  renderTrackNote();
  renderByline();
  renderFooter();
  // The picker's button and grid are built in JS rather than from data-i18n text, so they need
  // repainting on a language change like any other rendered thing.
  if (typeof paintMonthPicker === 'function' && el('fmonthbtn')) paintMonthPicker();
  repaintAll();
  // The chips and the density buttons are written in JS, so the data-i18n pass above never reaches
  // them. markActive is what rewrites the chips; applyView repaints the pressed state.
  markActive();
  applyView();
}
document.querySelectorAll('[data-lang-set]').forEach(b =>
  b.addEventListener('click', () => applyLang(b.dataset.langSet)));

const TYPE_JA = { chapter:'話', oneshot:'読み切り', trial:'試し読み', extra:'番外編',
                  notice:'お知らせ', 'apology-art':'お詫び', republication:'再掲',
                  unclassified:'未分類' };

// De-emphasise only what is KNOWN not to advance the story. `unclassified` is not known either
// way: dimming it would assert something the data does not support (REQUIREMENTS §6: unmatched
// values are quarantined, not coerced).
const NON_STORY = new Set(['trial', 'notice', 'apology-art', 'republication']);

/* ── tabs ─────────────────────────────────────────────── */
/* ── Where the browser's Back button goes ─────────────────────────────────────────────────────
   NAVIGATION IS IN THE URL; PREFERENCE IS NOT. What moves a reader somewhere is the tab, the
   period being read, and opening a work's record. Pressing Back after any of those should undo it,
   and until now Back left the site entirely, because nothing here ever touched history.

   Everything else stays out. Language, theme, romanisation, furigana and compact/detailed are
   preferences: Back flipping a reader's language would be a bug, not a feature. Filters and sort
   are deliberately not here yet either; see docs/FEATURES-INTERFACE.md for why the first step is
   the navigational three alone.

   The URL is also the only way to LINK to a view. Before this every address was identical, so
   "the works tab, filtered to 一迅プラス" could not be sent to anyone.

   PRECEDENCE. The URL wins over the saved view on load, and the saved view supplies only what the
   URL leaves out. Without that rule a shared link silently picks up the recipient's stored tab and
   shows them something other than what was sent. */
let NAV_APPLYING = false;      // true while popstate is being applied, so we do not push a reply

function navState() {
  const tab = document.querySelector('nav button[aria-selected=true]')?.dataset.tab || 'feed';
  // PAGE_WORK IS WHICH WORK IS OPEN. This read `.rel.here`, a class the list stopped carrying when
  // the work page replaced the in-list panel, so any control calling navSync while a work was open
  // computed "no work" and rewrote the address back to the bare list.
  return { tab, month: el('fmonth') ? el('fmonth').value : '',
           // A WORK PAGE IS ITS OWN PLACE, reachable from the updates tab as well as the works
           // list, so which tab is selected does not decide whether a work is open. The tab is
           // still carried, because it is where Back goes.
           work: PAGE_WORK
               || (tab === 'cat' && open ? (open.parentElement?.dataset.id || '') : ''),
           // A CREDIT AND A HOUSE ARE PLACES TOO, on the same reasoning: each selects a body of
           // data, so each pushes a history entry and each belongs in the URL. §15's first kind.
           rec: PAGE_REC ? { kind: PAGE_REC.kind, id: PAGE_REC.id } : null };
}

function navUrl(st) {
  const q = new URLSearchParams();
  if (st.tab && st.tab !== 'feed') q.set('tab', st.tab);
  // The period only means anything on the updates tab, and an open record only on the volumes tab.
  // Carrying either into a URL for a different tab describes something the recipient will not see,
  // which is the opposite of what a shareable address is for. The DOM keeps the record open behind
  // the scenes; the address simply stops claiming it.
  if (st.month && st.tab === 'feed') q.set('month', st.month);
  if (st.work && (st.tab === 'cat' || st.tab === 'ser')) q.set('work', st.work);
  const qs = q.toString();
  // A work on the works tab gets a path of its own. BASE is the app's directory, so this works
  // whether it is served at /kari/ or anywhere else.
  // A work gets a path of its own whatever tab it was opened from, and the tab rides along so
  // that leaving the page returns the reader to the list they were reading.
  if (st.work && st.tab !== 'cat') {
    const q2 = new URLSearchParams();
    if (st.tab && st.tab !== 'ser') q2.set('tab', st.tab);
    const rest = q2.toString();
    return BASE + 'work/' + st.work + '/' + (rest ? '?' + rest : '');
  }
  // A credit and a house each get a path of their own, which is where the pre-rendered page sits
  // and what a citation should look like. Nothing else is carried into it: a period means
  // something on the updates tab and an open work on the volumes tab, and neither describes what
  // a reader of this address will see.
  if (st.rec && st.rec.id) return BASE + st.rec.kind + '/' + st.rec.id + '/';
  return BASE + (qs ? '?' + qs : '');
}

function navSync(push) {
  if (NAV_APPLYING) return;
  const st = navState();
  const url = navUrl(st);
  if (url === location.pathname + location.search) {
    history.replaceState(st, '', url);
    return;
  }
  (push ? history.pushState : history.replaceState).call(history, st, '', url);
}


// The detail a row cannot carry: the work's other publication, and why we say what we say about
// its state. INTERFACE-PLAN §4. Evidence is not uncertainty: "four volumes from 幻冬舎コミックス,
// and the shop marks the series finished" is a statement about the world and belongs here. What we
// are unsure of belongs on status.html and is not rendered.
/* EVERY VIEW A PREFERENCE TOUCHES, in one place.

   This line existed seven times, once beside each control that changes how something reads, and
   the work page was in none of them: a reader who changed the date format or the romanisation
   while looking at a work kept the old rendering until they navigated away and came back. Seven
   copies of a list is seven chances to forget the eighth view, which is what happened. */
function repaintAll() {
  if (!FEED) return;
  renderFeed(); renderCat(); renderSeries(); renderReleases();
  if (PAGE_WORK) renderWorkPage();
  // A RECORD PAGE IS A VIEW LIKE THE OTHERS. Language, romanisation style, name order and furigana
  // are preferences, so changing one repaints what is on screen; a credit page left alone would
  // have kept the language it was drawn in while every list behind it changed.
  if (PAGE_REC) renderRecordPage();
}

/* WHAT VOLUME THIS IS, out of the twelve ways MADB writes it.

   889 volumes carry a bare `1`. The rest carry `vol. 8`, `vol.2`, `volume 1`, `Volume1`,
   `volume.2`, `Vol. 1`, `v.1` or `第1巻`, and the page was printing the notation inside its own:
   `第v.1巻 / vol. v.1`. The number is the fact; the word in front of it is the cataloguer's.

   上 and 下 are NOT numbers. They are the designation of a two-volume set and they are passed
   through as written, because rendering them as 1 and 2 would be the interface deciding something
   the record does not say. */
// 巻 and 集 are both volume counters. 集 was missing, so `3集` fell past every branch below and
// reached the page as it was written: "Holy Girl Apocalypse: Despair 3集" in English-only mode.
const VOLNUM = /^\s*(?:第\s*)?(?:v(?:ol)?(?:ume)?\s*\.?\s*)?(\d+)\s*(?:巻|集)?\s*$/i;

// 上 before 下, which no collator will tell you. Japanese orders a two or three volume set this
// way and `localeCompare(…, 'ja')` sorts by reading, which puts 下 first.
const VOLPART = { '上': 1, '中': 2, '下': 3 };

// A count and its unit are one phrase. `6 ${T('巻','vol')}` renders "6 巻 / vol" in 併記, which is
// the number once and the units run together, and it has no plural.
/* ONE SPELLING OF AN IMPRINT, wherever it is shown.

   MADB catalogues 百合姫 at least six ways: "IDコミックス", "コミック百合姫", "IDコミックス.
   Yurihime comics = コミック百合姫", "IDコミックス／Yuri-hime comics", "Yuri-hime comics", with
   half and full-width separators. Six spellings in one list read as six imprints, which is the
   opposite of what an imprint is for. The "A = B" form gives two names for one thing, so the
   Japanese side is taken and the Latin alias maps onto it.

   It lived inside the releases renderer and the work page showed the raw string beside it, so one
   work read "アフタヌーンKC" in one place and "IDコミックス. Yurihime comics" in another. */
/* ONE LINE, MANY RECORDED SPELLINGS, AND THE BUILD DECIDES WHICH. This held a hand-written table
   of four aliases and a rule that took the most specific segment, which could only ever know about
   the spellings somebody had met. 一迅社 writes its yuri line about twenty ways and the variation
   is not all noise: the 2015 hyphen drop is the publisher restyling the logotype, proved by MADB
   re-cataloguing every pre-2025 record in one 2024 sweep and emitting both forms, while the
   separators and the case are the cataloguer's.

   So the registry is curated and shipped in feed/names.json, keyed by the raw catalogued string and
   by its folded form. A string the map does not know keeps its catalogued spelling, which is what
   this did before and is a finished state rather than a failure.

   IT IS NOT SAFE TO GUESS THE PARENT. Bare `IDコミックス` is not the yuri line: all 47 rows
   carrying it alone are `marketing_label: none` and entered on a retailer's shelf, so folding it in
   would attach a publisher-side label to works the publisher labelled nothing. */
function imprintOf(s) {
  const raw = String(s || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  if (!raw) return '';
  const m = NAMES && NAMES.imprints;
  if (m) {
    const hit = m[raw] || m[foldKey(raw)];
    if (hit && hit.name) return hit.name;
  }
  return raw;
}

/* A PUBLISHER ARRIVES AS A NAME AND IS SHOWN AS ONE. There was a `publisherOf` here that took a
   leading `[頒布]` and a trailing `(発売)` off the string, because MADB writes the distributor and
   the publisher into one field and the record stored whichever came first. It has gone, and what
   replaced it is upstream: `adapters/madb/extract.py` reads the role out of the bracket, stores
   the publisher, the distributor and the raw string in fields of their own, and `check.py`'s
   `a publisher is a name, not a role` blocks check-in on a stored name that still holds notation
   or was lifted out of it.

   THIS IS THE POINT OF THE WHOLE CHANGE and not a tidy-up. Stripping the bracket here made the
   page agree with itself while both halves were wrong: the volumes section and the evidence table
   each took the same field, each took the same bracket off, and each named 講談社 as the publisher
   of 132 works 一迅社 published. A renderer cannot tell a distributor from a publisher by looking
   at the string, so it must not be the thing deciding (STANDING-INSTRUCTIONS §3).

   The two strippers had already drifted, which is what that costs. `publisherOf` returned an empty
   string for `[Shueisha]`, a publisher MADB brackets because the bracket is how it writes a name
   from a Latin catalogue, while `stripRole` in the volumes section kept it. One field, two
   renderings, and one of them printing nobody. */

/* WHAT A PRINT ROW SAYS ABOUT WHO MADE THE BOOK, in one place because the works list, the work
   page and the evidence table all ask it and had three answers between them.

   `publisher_basis` IS SHOWN AND NOT SWALLOWED. Where MADB names only a distributor the publisher
   is unknown, and an empty cell reads as a field nobody has filled in. Naming the distributor and
   saying it is one is the honest row; guessing 一迅社 from a 百合姫 imprint would be the database
   inventing a fact, which is what the source layer refuses to do (DEFINITIONS §5). */
/* WHAT A CREATOR FIELD SAID WHERE IT NAMED NOBODY. Same shape as PUB_UNKNOWN below and for the
   same reason: the field is not empty, and printing nothing would say something untrue about the
   book. `Various` is what an English catalogue writes for a book of many hands. */
const AUTHOR_UNNAMED = {
  'many-unnamed': ['複数の作家', 'Various'],
};

const PUB_UNKNOWN = {
  'not-stated': ['出版社の記載なし', 'publisher not stated'],
  'unknown-to-source': ['出版者不明', 'publisher unknown'],
  absent: ['出版社の記載なし', 'publisher not stated'],
};

/* The same parts, escaped, each carrying its own mark. Separate from publisherParts because that
   returns a plain string which callers escape, and it also fills a <select> option value on the
   releases filter, where markup would be shown literally.

   BUILT FROM THE RAW FIELDS AND NOT FROM publisherParts' OUTPUT. That returns the name as SHOWN,
   and PUBS is keyed by the catalogued Japanese, so asking it about an English string would find
   nothing and mark nothing. */
/* THE HOUSE IS A LINK AND THE LINE IS NOT. A publisher and a distributor are the same kind of
   object in one namespace and each holds a minted address; an imprint belongs to the house that
   runs it and has none, which is the shape DEFINITIONS gives the two. A page for 百合姫コミックス
   would be a second address competing with 一迅社's own.

   THE LINK IS ADDED HERE AND NOT AT THE CALL SITE. The work page grew its own copy of these three
   names so it could wrap two of them in an anchor, which is a second producer of what this
   function is for, and `names reach a page only through their renderer` reported five reads for
   it. One renderer for the publisher record, and every caller gets the links. */
/* A SEPARATOR IS PUNCTUATION AND NOT A TRANSLATION. `T('・', ' · ')` renders `・ / ·` in 併記,
   which is right for a label and wrong between two things: the publishers line came out
   `講談社 / Kodansha・ / ・秋田書店 / Akita Publishing`. The volumes section on the work page has
   settled this already and uses a middle dot with spaces in every mode, which reads cleanly
   between two names that are themselves two names in 併記. Same mark here.

   DEFINED HERE, ABOVE EVERY CALLER. It was declared 200 lines below the first two lists that
   needed it, so those two were still joining on `T('・', ' · ')` after this was written and a
   reader in 併記 got `10巻 / 10 volumes・ / · 4巻 / 4 volumes` on the Length line and
   `3話無料 / 3 free・ / · 38話有料 / 38 to buy` in the Reading column. */
const SEP = ' \u00b7 ';

/* A COUNT WITH A `+` ON IT, and the `+` said nothing. `90+ ch` on the works list means the platform
   lists more chapters than we hold, which the work page spells out as `3 listed of 90` and the list
   had no room for. The mark stays, because the number really is a floor and printing it bare would
   claim a total we do not have; the tooltip is what it was missing. */
function partialCount(n, partial) {
  if (!partial) return String(n);
  return `<span title="${esc(T('掲載サイトにはこれより多くの話があり、ここに持っているのはこの数です。',
    'the platform lists more chapters than we hold; this is what we have'))}">${esc(String(n))}+</span>`;
}


/* THE `発売` SUFFIX ALONE, never the name with it.

   A NAME IS NOT PROSE AND MUST NOT ENTER `T()`. Both functions below used to build
   `T(`${chip}（発売）`, `${chip} (distributor)`)`, which is wrong twice over. `T` runs `curly()` over
   whatever it is handed, and a chip is markup: `class="wplink pub"` came out `class=“wplink pub”`
   and `href="/kari/publisher/h00004/"` came out wrapped in curly quotes, so every distributor link
   on the site resolved to a path that does not exist. 208 records carry a distributor. `respell()`
   ran too, which is why one tooltip in the corpus read `romanized` where every other read
   `romanised`. And in 併記 `T` joins its two arguments, so the name printed twice:
   `講談社（発売） / 講談社 (distributor)`.

   `L` AND NOT `T`, because this is a label in a fixed slot beside a name that is already bilingual
   in 併記. `T` would put the marker in both languages after a chip that is itself two names, and
   the row is four names long before it says anything. */
function DISTRIBUTOR_MARK() { return L('（発売）', ' (distributor)'); }

function publisherPartsHtml(p) {
  const out = [];
  if (p.publisher) out.push(publisherChip(p.publisher));
  else if (p.publisher_basis) {
    const w = PUB_UNKNOWN[p.publisher_basis] || PUB_UNKNOWN.absent;
    out.push(esc(T(w[0], w[1])));
  }
  if (p.distributor) out.push(publisherChip(p.distributor) + DISTRIBUTOR_MARK());
  if (p.imprint) {
    const im = imprintOf(p.imprint);
    out.push(floorHtml(esc(pubBoth(im))) + pubMark(im));
  }
  return out.filter(Boolean);
}

function publisherParts(p) {
  const out = [];
  if (p.publisher) out.push(pubBoth(p.publisher));
  else if (p.publisher_basis) {
    const w = PUB_UNKNOWN[p.publisher_basis] || PUB_UNKNOWN.absent;
    out.push(T(w[0], w[1]));
  }
  // A distributor put the book into shops and did not publish it, so the row says which it is.
  // 講談社 has handled 発売 for 一迅社 since it bought the house in 2016, and a reader shown the
  // name alone has no way to tell that from 講談社 publishing the book.
  if (p.distributor) out.push(pubBoth(p.distributor) + DISTRIBUTOR_MARK());
  if (p.imprint) out.push(pubBoth(imprintOf(p.imprint)));
  return out.filter(Boolean);
}

/* THE ROLE IN FRONT OF A NAME, taken off however many of them there are.
   MADB writes one role as `[著]やまじえびね` and the single strip below handled that. It also
   writes `[[翻訳協力]][BPS株式会社]`, a role inside a role, and one pass takes `[[翻訳協力]` and
   leaves the credit reading `][BPS株式会社]`: a stray bracket in front of a company's name on the
   releases list. Two rows are in that state. Looping is the fix, and the loop is here once rather
   than in each caller, because this was the same three-line closure written twice. */
function stripRole(s) {
  let out = String(s || '').trim();
  // NEVER STRIP THE LAST THING LEFT. `[BPS株式会社]` is a name inside notation, and a loop that
  // took every bracketed group would return nothing and print an empty credit, which is the
  // silent failure this project keeps meeting rather than a visible one.
  for (let n = 0; n < 8; n++) {
    const cut = out.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/^\]\s*/, '').trim();
    if (!cut || cut === out) break;
    out = cut;
  }
  // What is left is the name, whether or not the cataloguer wrapped it as well.
  return out.replace(/^\[([^[\]]+)\]$/, '$1');
}

function volCount(n) {
  return T(n + '巻', n + (n === 1 ? ' volume' : ' volumes'));
}

/* THE VOLUME THAT ENDED THE SERIES. A claim and labelled as one: a shop said the series is
   complete and said how many volumes it has, and that many were read. The tooltip names the shop,
   because a reader deciding whether to trust it is owed the source. */
/* THE SERIES FINISHED, on a shop's say-so. 258 works published only in volumes had no completion
   information from any source, and the shop that told us which editions they are also says whether
   they are done. Shown as its own badge beside 単行本 rather than replacing it: one says how the
   work is published and the other says whether it is still coming. */
function completedTag(basis) {
  if (!basis) return '';
  const tip = `${basis.source} lists this series as complete`
            + (basis.volumes ? ` in ${basis.volumes} volume(s)` : '')
            + ". The shop's claim, not the publisher's statement.";
  return `<span class="k k-fin" title="${esc(tip)}">${esc(T('完結', 'complete'))}</span>`;
}

function finalTag(basis) {
  // A one-volume work has no final volume: the volume is the work, and calling it the last of a
  // series says something about a series that never existed.
  if (!basis || (basis.volumes || 0) < 2) return '';
  const who = (basis && basis.source) || '';
  const tip = `${who} lists this series as complete in ${basis && basis.volumes} volume(s), `
            + 'and this is the last of them. The shop\'s claim, not the publisher\'s statement.';
  return ` <span class="k k-fin" title="${esc(tip)}">${esc(T('完結巻', 'final volume'))}</span>`;
}

function volLabel(n) {
  const raw = String(n == null ? '' : n).trim();
  if (!raw) return '';
  const m = raw.match(VOLNUM);
  if (m) return T('第' + m[1] + '巻', 'vol. ' + m[1]);
  /* A TWO OR THREE VOLUME SET IS NUMBERED 上 中 下, NOT 1 2 3. VOLPART already orders them and
     nothing rendered them, so 17 volumes reached an English page as a bare 上 or 下巻. English
     publishing calls these parts, and the number is the position the set puts them in. */
  const part = VOLPART[raw] || VOLPART[raw.replace(/巻$/, '')];
  if (part) return T(raw, 'part ' + part);
  /* Anything else is a NAMED part, 難問編 or 前夜, which is a section title and not a counter.
     Seven of them, and they want translating the way a chapter name does. Shown as written until
     they are, because inventing an English name for a section is worse than showing its own. */
  return raw;
}

/* Where a volume sits in its work. A NUMBER, not the text of one: sorted as strings, volume 10
   comes before volume 9, and it only takes two volumes sharing a publication month for that to
   show. Anything neither numbered nor part of a 上中下 set sorts last, by its own text. */
function volOrder(n) {
  const raw = String(n == null ? '' : n).trim();
  const m = raw.match(VOLNUM);
  if (m) return [0, +m[1], ''];
  // Written 上 and 下 on eight works and 上巻 and 下巻 on 最後の制服, whose two volumes share a
  // publication month and so were ordered by the collator, backwards. One rule covers both
  // spellings rather than two entries that can be added to singly.
  const part = VOLPART[raw] || VOLPART[raw.replace(/巻$/, '')];
  if (part) return [0, part, ''];
  return [1, 0, raw];
}

/* THE NUMBER IS THE ORDER, AND THE DATE IS EVIDENCE ABOUT PUBLICATION. Sorting on the date first
   put an undated volume last, because a missing date was read as '9999': 私を喰べたい、ひとでなし
   listed eleven volumes starting at vol. 2, with vol. 1 at the bottom. A volume set numbers itself
   and that numbering does not depend on what dates we happen to hold.

   The date still decides where a set has no numbering to go on, which is the case volOrder returns
   kind 1 for: 難問編 and 前夜 are section titles and nothing about them says which came first. */
function byVolume(a, b) {
  const [ka, na, ta] = volOrder(a.number), [kb, nb, tb] = volOrder(b.number);
  if (ka === 0 && kb === 0) return na - nb || ta.localeCompare(tb, 'ja');
  const da = String(a.published || '9999'), db = String(b.published || '9999');
  if (da !== db) return da.localeCompare(db);
  return ka - kb || na - nb || ta.localeCompare(tb, 'ja');
}

function workDetail(r) {
  const bits = [];
  (r.print || []).forEach(p => {
    const span = [p.first, p.last].filter(Boolean).join(' \u2013 ');
    // WHO PUBLISHED IT, WHO DELIVERED IT, AND UNDER WHAT IMPRINT. This row used to run the
    // publisher field through stripRole() and print whatever came out, which is how a distributor
    // got named as the publisher here and in two other places besides. One reader of those fields
    // now, so the works list and the work page cannot disagree about one book.
    const who = publisherPartsHtml(p).join(' \u00b7 ');
    bits.push(`<div class="dl"><span class="dk">${T('\u5358\u884c\u672c', 'In print')}</span>` +
      `<span class="dv">${[esc(p.volumes ? p.volumes + (T(' \u5DFB', ' vol')) : ''), who, esc(span)]
        .filter(Boolean).join(' \u00b7 ')}</span></div>`);
  });
  const why = r.completed_basis || r.state_basis;
  if (why) bits.push(`<div class="dl"><span class="dk">${T('\u6839\u62E0', 'Basis')}</span>` +
    `<span class="dv">${esc(why)}</span></div>`);
  // The work's own page. It has existed since the identifiers landed and nothing pointed at it,
  // so the address was reachable only by typing it.
  if (r.id) bits.push(`<div class="dl"><span class="dk">${T('固定リンク', 'Permalink')}</span>` +
    `<span class="dv"><a class="mono" href="${esc(BASE)}work/${esc(r.id)}/">${esc(r.id)}</a></span></div>`);
  return bits.length ? `<div class="detail">${bits.join('')}</div>` : '';
}


/* A works row opens the work's page. Delegated, because the list is redrawn on every filter
   change and a handler bound to a row would not survive that.

   The title is a real link to `work/<id>/`, so this intercepts it and renders in place instead of
   letting the browser fetch the stub, which would only redirect back here. A click carrying a
   modifier, or any button other than the left one, is left alone: a reader asking for a new tab
   is asking for the address, and the address works. */
/* The updates tab's subsidiary link to a work's record. Its own handler, because a feed row is
   keyed by chapter and carries no data-work of its own. */
document.addEventListener('click', ev => {
  const wl = ev.target.closest('a.wplink');
  if (!wl) return;
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  const m = wl.getAttribute('href').match(/work\/([A-Za-z0-9_-]+)\//);
  if (m) openWorkPage(m[1]);
});

document.addEventListener('click', ev => {
  const row = ev.target.closest('.rel[data-work]');
  if (!row) return;
  const a = ev.target.closest('a');
  if (a && !a.classList.contains('wlink')) return;   // a source chip goes where it says
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  openWorkPage(row.dataset.work);
});

/* A work's own page, rendered over the list rather than inside it. The address is the one the
   pre-rendered stub sits at, so a reader who arrives from outside and one who clicks a row end up
   looking at the same thing at the same URL. */
let PAGE_WORK = null;

/* THE VOLUMES THEMSELVES, which the page has been summarising rather than listing.

   `series.json` carries a count and a span, because the works list needs one line per work. The
   volume records are in `works.json`, keyed by the MADB id the print edition already names, and
   the releases tab fetches that file anyway. 1,311 volumes are held across 598 works, every one
   with an ISBN.

   Loaded after the page is painted, never before it. The file is the largest thing here and a
   work with no print edition must not wait on it to show what it does have.

   A VOLUME NOBODY NUMBERED SAYS NOTHING. 982 of 1,311 carry a number in the record; the rest are
   left blank rather than numbered by their position in a sorted list, which would be the interface
   inventing a fact about the edition. Same rule the releases tab follows. */
async function paintVolumes(r) {
  const ids = (r.print || []).map(p => p.work_id).filter(Boolean);
  const box = el('wp-vols');
  if (!box || !ids.length) return;
  // Against BASE, for the reason `recData` gives: the address is rewritten to the work's own path
  // while the app stays loaded, and this fetch is the one other thing that happens after that.
  if (!DETAIL) DETAIL = fetch(BASE + 'data/works.json', { cache: 'no-cache' }).then(x => x.json());
  const WORKS = await DETAIL;
  // The reader may have left, or opened another work, while the file was in flight.
  if (PAGE_WORK !== r.id || !el('wp-vols')) return;
  let rows = [];
  (WORKS.works || []).forEach(w => {
    if (!ids.includes(w.work_id)) return;
    // WHICH PRINT RUN A VOLUME BELONGS TO. Flattening several catalogue records into one list lost
    // it, and citrus came out vol. 1, vol. 1, vol. 2, vol. 2, vol. 3, vol. 3, vol. 4 …: a ten
    // volume run interleaved with a four volume reissue whose books all appeared in one month.
    (w.volumes || []).forEach(v => rows.push({ ...v, run: w.work_id }));
  });
  /* THE ADMISSION AND THE CATALOGUE LINK USED TO BE ASSEMBLED HERE, as a line of prose at the
     foot of the page: which comparator shelved the work, and a link to its bibliography record.
     Both are rows in the sources tables now, with the shelf's own word quoted and the day each
     source was read beside it, so this said the same thing a second time in a weaker form. Two
     producers of one fact is the shape behind most of the bugs in this project, and the table is
     the better producer: it is built from `evidence` and `sourced_from`, which build.py derives
     from the source records rather than from whatever happens to be in works.json. */

  if (!rows.length) return;
  rows.sort(byVolume);
  /* ONE ROW PER VOLUME, however many editions of it exist.

     ささやくように恋を唄う holds volumes 9 to 12 twice, with different ISBNs, the same date and
     the same title, which is a standard and a special edition of one volume. MADB gives no way to
     tell which is which: the two records differ in the ISBN and in nothing else. So they are one
     row saying both, instead of four apparent duplicates a reader has to guess about. Merged only
     where the number AND the date agree, so a genuine reissue years later stays its own row. */
  const merged = [];
  for (const v of rows) {
    const prev = merged[merged.length - 1];
    /* AND ONLY WITHIN ONE RUN. Two editions of a volume are two ISBNs on one catalogue record;
       two catalogue records dating a volume 1 to the same month are two different printings, and
       folding those together took citrus's 2015 reissue from four volumes to three while the block
       above it still said four. `run` is the record each volume came from. */
    if (prev && v.number && prev.run === v.run
        && prev.number === v.number && prev.published === v.published) {
      prev.editions = (prev.editions || [prev.isbn]).concat(v.isbn ? [v.isbn] : []);
      continue;
    }
    merged.push({ ...v });
  }
  rows = merged;
  /* A ROW THAT SAYS NOTHING, SAID 133 TIMES, IS NOT A LIST.
     付き合ってあげてもいいかな【単話】 holds 133 releases and BOOK☆WALKER dates none of them, so
     the page ran to 17,501px of identical lines reading 刊行日不明. A volume carrying no date, no
     number and no ISBN distinguishes itself from its neighbours in nothing, and counting them is
     the whole of what there is to say. So they are counted, and the ones that carry something are
     listed. */
  const says = v => v.published || v.isbn || v.number || (v.editions || []).length;
  const told = rows.filter(says), silent = rows.length - told.length;
  /* A HOLE IN THE NUMBERING, NAMED. 63 works run 1–12, 14, 15, 16 because the catalogue holds no
     record of volume 13, and the list showed the jump and said nothing, under a heading counting
     the ROWS. A reader met `Volumes 15` above a list ending at 16 and had no way to tell a gap in
     the bibliography from a gap in the interface. This is a fact about what MADB holds, so it says
     that rather than asserting the volume does not exist. */
  const nums = told.map(v => parseInt(v.number, 10)).filter(n => Number.isFinite(n));
  const highest = nums.length ? Math.max(...nums) : 0;
  const have = new Set(nums);
  const gaps = [];
  for (let i = 1; i < highest; i++) if (!have.has(i)) gaps.push(i);
  const gapNote = gaps.length ? `<p class="vnone">${esc(T(
      `第${gaps.join('・')}巻は書誌に記録がない`,
      `no catalogue record for ${gaps.length === 1 ? 'volume' : 'volumes'} ${gaps.join(', ')}`))}</p>` : '';
  /* ONE LIST PER PRINT RUN, WHERE THERE IS MORE THAN ONE. Sorting every catalogue record's volumes
     into one sequence put a 2013 first volume next to a 2015 one and left the reader to work out
     that the second was a reissue. Each run is its own list, headed by what it is, in the order the
     runs are listed above it. Where there is one run there is one list and no heading, which is
     every work but the 37 the catalogue splits. */
  const runOrder = (r.print || []).map(pr => pr.work_id);
  const groups = runOrder.length > 1
    ? runOrder.map(id => told.filter(v => v.run === id)).filter(g => g.length)
    : [told];
  const runHead = g => {
    if (groups.length < 2) return '';
    const pr = (r.print || []).find(x => x.work_id === g[0].run);
    const from = pr && pr.first ? fmtDate(pr.first, { year: true }) : '';
    return `<h4 class="wp-subh">${esc(T(`${g.length}巻${from ? `　${from}から` : ''}`,
      `${g.length} ${g.length === 1 ? 'volume' : 'volumes'}${from ? ` from ${from}` : ''}`))}</h4>`;
  };
  el('wp-vols').innerHTML =
    `<h3 class="wp-sub">${esc(T('収録巻', 'Volumes'))} <span class="wp-n">${rows.length}</span></h3>` +
    (silent ? `<p class="vnone">${esc(T(
        `${silent}巻は刊行日も書誌情報も記録がない`,
        `${silent} with no date and nothing else recorded`))}</p>` : '') + gapNote +
    groups.map(g => runHead(g) + '<ol class="vols">' + g.map(v => {
      const n = v.number ? `<span class="voln">${esc(volLabel(v.number))}</span>` : '';
      const d = v.published
        ? `<time datetime="${esc(v.published)}">${esc(fmtDate(v.published, { year: true }))}</time>`
        : `<span class="vnod">${esc(T('刊行日不明', 'no date recorded'))}</span>`;
      // The ISBN is why most of these works are here at all: it is what a shop stated and what the
      // bibliography answered. A bibliographic record should show its identifier.
      const eds = (v.editions || []).filter(Boolean);
      const i = eds.length > 1
        ? `<span class="mono visbn" title="${esc(T(
            `この巻には${eds.length}種類の版があり、どちらがどれかは書誌からは判別できない`,
            `${eds.length} editions of this volume, which the catalogue does not tell apart`))}"
            >${esc(eds.join(' · '))}</span>`
        : (v.isbn ? `<span class="mono visbn">${esc(v.isbn)}</span>` : '');
      const f = v.final_volume ? finalTag(v.final_volume_basis) : '';
      return `<li class="vol">${n}${d}${i}${f}</li>`;
    }).join('') + '</ol>').join('');
}

/* OPENING AND CLOSING ARE STATE CHANGES; THE ADDRESS FOLLOWS FROM THE STATE.

   These two used to push URLs they built themselves, beside navUrl building the same addresses a
   different way. Two producers of one fact, and they disagreed: navUrl gives a work the path form
   and these gave it whatever the literal above said. Now they set PAGE_WORK and call navSync, so
   there is one function that knows what a work's address is. */
/* WHERE A RETIRED IDENTIFIER WENT.

   Two records turning out to be one work retires an id, and the registry has recorded where it
   went since the beginning. Nothing outside identity.py read it, so a work page asked for a retired
   id found no row and rendered a blank page: 20 of 26 retired ids were addresses that resolved in
   the morning and resolved nowhere by the evening, which is the failure an opaque minted id exists
   to prevent.

   A chain is followed to whatever is live now, because A into B into C must land on C. */
function liveId(id) {
  const map = (SERIES && SERIES.merged) || {};
  const rows = (SERIES && SERIES.series) || [];
  let cur = id, seen = new Set([id]);
  while (cur && !rows.some(r => r.id === cur) && map[cur] && !seen.has(map[cur])) {
    cur = map[cur];
    seen.add(cur);
  }
  return cur;
}

function openWorkPage(id, push = true) {
  if (!id) return;
  id = liveId(id);
  PAGE_REC = null;
  PAGE_WORK = id;
  renderWorkPage();
  navSync(push);
}

function closeWorkPage(push) {
  PAGE_WORK = null;
  el('workpage').hidden = true;
  // Back to whichever tab is selected, which is not always the works tab: a release row links to a
  // work page, and closing it used to drop the reader onto a list they had not been looking at.
  showSelectedTab();
  document.querySelector('nav').hidden = false;
  navSync(push);
}

/* WHICH SECTION IS ON SCREEN, from the tab strip, in one place.

   The tab handler hid the four tab sections and never hid #workpage, so switching tabs with a work
   open left the page stacked over the list it had just drawn. Every caller now goes through here
   and cannot forget the fifth section. */
function showSelectedTab() {
  const tab = document.querySelector('nav button[aria-selected=true]')?.dataset.tab || 'feed';
  ['feed', 'ser', 'cat', 'rel'].forEach(t => { const s = el('tab-' + t); if (s) s.hidden = t !== tab; });
  if (!PAGE_WORK && !PAGE_REC) el('workpage').hidden = true;
}

/* A WORK'S PAGE, ARRANGED BY WHAT A READER ASKS.

   It was a flat list of every field the row carried, in the order the code happened to add them,
   with our own identifier at the bottom and the phrase "in what we hold" in the middle. A reader
   arrives asking four things and they are not equally weighted: what is this, is it still going,
   where do I read it, and how much is there. So the page answers them in that order and stops.

   WHAT CAME OFF. The minted identifier, which is the address of the page it sat on and told a
   reader nothing they could not read in the URL bar. And any basis phrased about our own capture:
   "every chapter we hold arrived on the day a platform imported the series" is a statement about
   this project, and a reader can act on none of it. Evidence about the WORLD stays, because
   "the platform marks the serialisation finished" is why the badge above it says what it says.

   WHAT WENT ON. What the platform says about the next chapter, on 117 works, which is the single
   most useful fact for anybody following a running series and was in the data unread. How much of
   it is free, which the list has always shown and the page did not. And the newest chapter's own
   title, so 最新 is a chapter rather than a date. */

// A basis worth showing is one about the manga. These describe our own coverage instead, and a
// reader can do nothing with them.
const ABOUT_US = /in what we hold|we hold|nothing here says|this capture|we could read/i;
// And evidence that carries no information. "no chapter for 0 days" is the sentence a template
// produces when the newest chapter arrived today, and it tells a reader nothing the date above it
// has not already said.
const SAYS_NOTHING = /for 0 days/i;

// Local, not UTC: a reader in Japan asking whether a chapter is still to come means their today.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* THE READER'S LANGUAGE, where the build wrote one. Every one of these sentences was English, so
   the one place the interface explains itself was unusable to half the audience it is written for.
   The English is what the filters above are applied to, because it is the sentence that exists on
   every row; the Japanese is shown when there is one and the reader is reading Japanese. */
function readerBasis(r) {
  const en = r.completed_basis || r.state_basis || '';
  if (!en || ABOUT_US.test(en) || SAYS_NOTHING.test(en)) return '';
  const ja = r.completed_basis_ja || r.state_basis_ja || '';
  if (LANG === 'en' || !ja) return en;
  return LANG === 'ja' ? ja : `${ja} / ${en}`;
}

/* HOW MUCH OF IT COSTS NOTHING, as one sentence per language.

   It was assembled from nested T() calls, so 併記 interleaved the two: "7/58話が無料 / 7 of 58 free
   (5話が無料、2話が待てば無料 / 5 free now, 2 free with a daily ticket)". Each language is built
   whole here and the pair is joined once.

   AND A TIMER IS NOT FREE NOW. 21 of 21 chapters counted as free where 19 of them need a daily
   ticket, and the line read "all free to read" to a reader who can open two. Conditionally free is
   still free, which is why it counts, and it is not the same thing, which is why it is said. */
// How many credits a line shows before it counts the rest. Four fits one line at every width the
// facts grid uses; a fifth wraps on a phone.
const CREDITS_SHOWN = 4;

function creditLine(r) {
  // COUNTED OFF THE SHIPPED DIVISION, AND THE SLASH IS WHAT THIS REPLACES. This split the field on
  // `/` and handed the first four pieces to `linkedCredits` AS A FIELD OF THEIR OWN. That string
  // is not a field the build ever saw, so `credit_parts` answered nothing for it, and the whole
  // line dropped to the floor: `安田剛助・文尾文` reached a reader as `???? · Bun?Bun` on w01700
  // while the same field rendered `Yasuda Kōsuke / Fumio Aya` everywhere else. The slash is also
  // the wrong count. A field writes two people with a comma or a ・ as readily as with a slash, so
  // 46 rows counted one credit where the build had divided two, three or four.
  //
  // ONE PRODUCER OF THE DIVISION (§3). `creditPeople` reads `credit_parts`, which is the same
  // splitter the name store is keyed on, and `linkedCredits` walks that division and stops after
  // the count this line shows. Nothing here cuts a string.
  const raw = String(r.author || '').trim();
  const people = creditPeople(raw) || (raw ? [raw] : []);
  // EVERY NAME STILL REACHES OUTPUT THROUGH authorLabel. `linkedCredits` splits the field on the
  // parts the build shipped and hands each one to authorLabel, so the reader's language, style,
  // name order and furigana all apply exactly as they did; what it adds is the address.
  if (people.length <= CREDITS_SHOWN) return linkedCredits(r);
  const head = linkedCredits(r, CREDITS_SHOWN);
  if (head === null) return linkedCredits(r);
  const rest = people.length - CREDITS_SHOWN;
  return `${head}<span class="wf-sub" title="${esc(people.join(', '))}">${
    esc(T(`ほか${rest}名`, `and ${rest} others`))}</span>`;
}

function accessLine(r) {
  const now = r.free || 0, timed = r.free_timed || 0;
  const free = now + timed;
  if (!r.chapters || !(free + (r.priced || 0))) return '';
  const say = (ja) => {
    if (!free) return ja ? '有料' : 'paid';
    if (free >= r.chapters) {
      if (!timed) return ja ? '全話無料' : 'all free to read';
      return ja ? `全話無料（うち${timed}話は待てば無料）`
                : `all free (${timed} of them with a daily ticket)`;
    }
    const head = ja ? `${free}/${r.chapters}話が無料` : `${free} of ${r.chapters} free`;
    if (!timed) return head;
    return ja ? `${head}（${now}話がすぐに、${timed}話は待てば）`
              : `${head} (${now} now, ${timed} with a daily ticket)`;
  };
  return LANG === 'ja' ? say(true) : LANG === 'en' ? say(false) : `${say(true)} / ${say(false)}`;
}

function renderWorkPage() {
  const r = (SERIES.series || []).find(x => x.id === PAGE_WORK);
  const box = el('workpage');
  if (!r || !box) return;
  document.querySelector('nav').hidden = true;
  ['ser', 'feed', 'rel', 'cat'].forEach(x => { const s = el('tab-' + x); if (s) s.hidden = true; });
  box.hidden = false;

  // ── who and what, and whether it is still going ──────────────────────────────────────────────
  const why = readerBasis(r);
  // THE BADGE IS THE LABEL; THE SENTENCE IS THE TOOLTIP. stateLabel joins the two for a value in a
  // list of values, and used as a badge it put "published in volumes; no web serialisation we
  // track" where 単行本 belongs, which is an explanation of our own wearing the place of a name.
  const [slbl, scls, sdesc] = SSTATE[r.state] || SSTATE.unknown;
  // THE PAGE ALWAYS SAYS SO, whether or not the reader has opted the listing back in. A citation
  // resolves here directly, and arriving at a work with no idea why it is not in the list is worse
  // than being told. `visTag` is silent unless the reader opted in, so the mark is built here.
  const vhow = visOf(r);
  const badges = vhow
    ? [`<span class="k k-vis" title="${esc(VIS_WHY[vhow] || '')}">${
         esc(T(...(VIS_LABEL[vhow] || [vhow, vhow])))}</span>`]
    : [];
  badges.push(`<span class="k ${scls}" title="${esc(sdesc)}">${esc(T(slbl))}</span>`);
  if (r.state === 'print' && r.completed_claim) badges.push(completedTag(r.completed_claim));

  // ── where to read it, with what each source actually holds ───────────────────────────────────
  const src = (r.sources || []).map(s => {
    const f = (s.free || 0) + (s.free_timed || 0);
    const n = `<span class="srcn">${esc(s.chapters)}${s.partial ? '+' : ''}</span>`;
    const tip = T(`${s.chapters}話をここで確認${f ? `、うち${f}話が無料` : ''}`,
                  `${s.chapters} chapters here${f ? `, ${f} of them free` : ''}`);
    const body = `${esc(platBoth(s.platform))}${n}`;
    return s.url
      ? `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow"
           title="${esc(tip)}">${body}</a>`
      : `<span class="src" title="${esc(tip)}">${body}</span>`;
  }).join('');

  // ── the facts, as pairs, in one grid rather than one row each ────────────────────────────────
  const facts = [];
  const fact = (k, v) => { if (v) facts.push(`<div class="wf"><dt>${esc(k)}</dt><dd>${v}</dd></div>`); };
  /* A CREDIT LINE IS A LIST OF PEOPLE AND STOPS BEING READABLE AS ONE. コミック百合姫 credits
     more than twenty, run together, which is a paragraph where a reader wanted a name. The first
     few are shown and the rest counted, with every name still in the tooltip. */
  /* THE WHOLE BYLINE AGAIN, ONE LANGUAGE PER LINE. The label beside it is `T`, which pairs two
     short interface words inline; the value is a person's name, which `authorLabel` renders in one
     language on purpose. In 併記 this cell used to hold the Japanese alone, with furigana over it
     and the romanisation nowhere, on a page where every other cell said both. */
  /* A BOOK WITH MANY AUTHORS AND NONE OF THEM NAMED. A shop puts something in the creator field
     for every book it sells and has nobody to put for an anthology, so it writes the format of the
     book: `アンソロジー` reached the registry as a credit, an identifier was minted, and a page was
     published headed アンソロジー saying these are the works that name this person. The build
     refuses the string now and says on the row what the field had said, because an empty Author
     line reads as a book nobody made and these have many. */
  fact(T('作者', 'Author'),
       r.author ? bilingual(() => creditLine(r))
                : (r.author_basis ? esc(T(...(AUTHOR_UNNAMED[r.author_basis]
                                             || AUTHOR_UNNAMED['many-unnamed']))) : ''));
  // The newest chapter is a chapter, not a date. `latest_ep` was in the row and shown only in the
  // list, so the page said less about the same fact than the line that led to it.
  /* THESE THREE ARE ABOUT CHAPTERS, and the page below them lists volumes, so they say which.
     `first` is not even the same fact on every work: on a serialisation it is the first chapter,
     and on a work published only in volumes it is the first volume, so it is labelled for what it
     is rather than given one word that is right half the time. */
  const web = (r.chapters || 0) > 0;
  const hasPrint = (r.print || []).length > 0;
  /* WHEN THE WORK RAN, as one span rather than two facts a reader has to subtract. The end of it
     is the latest thing that happened of either kind, which is what `latest_any` carries; `latest`
     is the serialisation's own date and stays where it decides the state. */
  const ran = [r.first ? fmtDate(r.first, { year: true }) : '',
               r.latest_any ? fmtDate(r.latest_any, { year: true }) : '']
    .filter(Boolean);
  /* WHICH EVENT THE DATE NAMES. For 1,084 works the earliest thing anybody records is the day a
     shop began delivering the file, and DEFINITIONS §6 admits a doujinshi a platform sells, for
     which that may be the only datable event in its history. It is a true statement with no error
     bar, so the line says what it is instead of calling it publication and hoping. Where a printing
     is known the delivery date is not here at all: it never reaches print[].first. */
  /* A RANGE WITH A CLOSING DATE SAYS THE WORK ENDED. The second date is the newest thing that has
     happened so far, which on a running series is today's news and not a conclusion: Otherside
     Picnic read `2018-08 – 2026-08-09` under a badge saying 更新中. Only a state that means the
     serialisation has stopped closes the span; everything still running, dormant included, gets an
     open one, because dormant is a series nobody has declared finished. */
  const ENDED = { completed: 1, oneshot: 1, print: 1 };
  const span = ran.length === 2 && ran[0] !== ran[1]
    ? (ENDED[r.state] ? ran.join(' – ') : T(`${ran[0]}から`, `${ran[0]} – `))
    : (ran[0] || '');
  fact(r.first_event === 'shop-delivery' ? T('配信開始', 'Delivered from') : T('刊行', 'Published'),
       esc(span));
  /* LENGTH IS THE WORK'S SIZE, not our coverage of it. Chapters is a floor, so it is written as
     one; volumes is a count the bibliography states outright. */
  const len = [];
  if (r.chapters) {
    // A ONE-SHOT'S SINGLE CHAPTER IS THE WHOLE WORK, so the floor does not apply to it. "at least
    // 1 chapters" was wrong twice over on 394 rows: it hedged a length that is complete by
    // definition, and it pluralised one. The 65 rows holding one chapter OF a serialisation keep
    // the hedge, because there the floor is exactly what is being said.
    const n = r.chapters;
    const unit = n === 1 ? 'chapter' : 'chapters';
    len.push(r.oneshot ? T(`${n}話`, `${n} ${unit}`)
                       : T(`${n}話以上`, `at least ${n} ${unit}`));
  }
  /* A REISSUE IS NOT EXTRA LENGTH. Each print run pushed its own count, so citrus read
     `at least 41 chapters · 10 volumes · 4 volumes`, where the 4 are the first four volumes issued
     again in one month in 2015. The work is ten volumes long. The runs themselves are set out in
     the section below, which is where a second one belongs. */
  const runs = (r.print || []).filter(pr => pr.volumes);
  if (runs.length) len.push(volCount(Math.max(...runs.map(pr => pr.volumes))));
  fact(T('分量', 'Length'), esc(len.join(SEP)));
  /* WHAT FORM IT EXISTS IN. Every row can answer this and it had to be inferred from which
     sections happened to be populated. */
  fact(T('形態', 'Available as'), esc(
    web && hasPrint ? T('ウェブ連載と単行本', 'web serialisation and collected volumes')
    : web ? T('ウェブ連載', 'web serialisation')
    : hasPrint ? T('単行本', 'collected volumes') : ''));
  // What the platform says comes next. Marked as the platform's statement, because it is a date
  // for something that has not happened.
  /* A DATE FOR SOMETHING THAT HAS NOT HAPPENED has to still be in the future. アイドラトリィ
     carried a next-update date equal to the day its newest chapter arrived, so the page announced
     a chapter that was already on the shelf below it. Shown only when it is later than both the
     newest chapter and today. */
  /* A DATE FOR SOMETHING THAT HAS NOT HAPPENED has to still be in the future. アイドラトリィ
     carried a next-update date equal to the day its newest chapter arrived, so the page announced
     a chapter already on the shelf below it. Shown only when it is later than both the newest
     chapter and today, and it sits with the serialisation because it is a platform's statement. */
  /* THE PLATFORM ONLY WHERE THERE IS A CHOICE OF THEM. Which platform stated the date matters when
     the work runs on several and answers nothing when it runs on one: 裏世界ピクニック printed
     `Next chapter: 2026-08-16` and then `GANGAN ONLINE` directly under the single row that had just
     named GANGAN ONLINE. */
  const nx = (r.stated_next || {}).next_update || '';
  const nextWho = (r.sources || []).length > 1
    ? `<span class="wf-sub">${esc(platName(r.stated_next.platform))}</span>` : '';
  const nextLine = nx && nx > String(r.latest || '') && nx >= todayISO()
    ? `<p class="wp-next">${esc(T('次回更新：', 'Next chapter: '))}${
        esc(fmtDate(nx, { year: true }))}${nextWho}</p>`
    : '';
  if (r.collection && r.collection !== r.work) {
    // A collection is a work, so its name obeys the same contract `workLabel` does and needs the
    // same wrapper. `workTextOf` answers in Japanese for anything but `en`, so this cell was the
    // last title on the page still stuck in one script under 併記.
    fact(T('収録', 'Part of'), bilingual(() => floorHtml(esc(workTextOf(r.collection)))));
  }


  /* THE PAGE IS THE WORK, SO THE WORK NEEDS NO HEADING. What follows it does: a reader has to be
     able to tell a statement about a serialisation from a statement about a printed book, and the
     old page ran both through one grid where 話数 sat beside 単行本 as though they were the same
     kind of fact. Only the sections that could be mistaken for each other are named. */
  const sect = (title, body) => body
    ? `<section class="wp-sect"><h3>${esc(title)}</h3>${body}</section>` : '';

  /* WEB SERIALISATION. One row per platform, because what a platform holds, what it charges for
     and when it last updated are all properties of that platform's offer and not of the work.
     "12 of 99" rather than "12" keeps our coverage and the work's length apart, which is the same
     conflation the works list carries. */
  const chapRows = (r.sources || []).map(s => {
    const f = (s.free || 0) + (s.free_timed || 0);
    const held = r.chapters && s.chapters && r.chapters > s.chapters
      ? T(`${r.chapters}話中${s.chapters}話`, `${s.chapters} listed of ${r.chapters}`)
      : String(s.chapters || '') + (s.partial ? '+' : '');
    /* THE COLUMN HAS TO ACCOUNT FOR THE COLUMN BESIDE IT. `free` and `priced` are what the
       listing stated, and a chapter it said nothing about was counted in `chapters` and then
       dropped here: 裏世界ピクニック read `3 listed of 90 | 1 free · 1 to buy`, and 279 of 1,575
       platform rows are short this way. フレンドガールフレンド has 13 chapters and no mode on any of
       them, so the cell was empty beside a count of 13, which reads as a rendering fault. What is
       missing is our reading of the listing and not a fact about the offer, so it says so. */
    const unsaid = Math.max(0, (s.chapters || 0) - f - (s.priced || 0));
    const money = [f ? T(`${f}話無料`, `${f} free`) : '',
                   s.priced ? T(`${s.priced}話有料`, `${s.priced} to buy`) : '',
                   unsaid ? T(`${unsaid}話は不明`, `${unsaid} not recorded`) : '']
      .filter(Boolean).join(SEP);
    const nm = s.url
      ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow">${
           esc(platBoth(s.platform))}</a>`
      : esc(platBoth(s.platform));
    return `<tr><td>${nm}</td><td>${esc(held)}</td><td>${esc(money)}</td><td>${
      s.latest ? esc(fmtDate(s.latest, { year: true })) : ''}</td></tr>`;
  }).join('');
  const webBody = chapRows ? `<div class="wp-scroll"><table class="wp-rows">
      <tr><th>${esc(T('掲載サイト', 'Platform'))}</th><th>${esc(T('話数', 'Chapters'))}</th>
          <th>${esc(T('閲覧', 'Reading'))}</th><th>${esc(T('最新', 'Newest'))}</th></tr>
      ${chapRows}</table></div>${nextLine}` : '';

  /* COLLECTED VOLUMES. paintVolumes fills #wp-vols and is left where it is; what it lists belongs
     under this heading rather than after an undifferentiated run of facts. Seller links are NOT
     here yet: shop_url is on the source records and reaches no build output. */
  const printBody = (r.print || []).map(pr => {
    const who = publisherPartsHtml(pr).join(' \u00b7 ');
    /* WHERE TO BUY IT, beside the volumes it describes, which parallels the platform links the
       serialisation carries. A retailer is a Tier C source and its shelf is never a marketing
       label, so this says only that the shop sells the book. */
    const shop = pr.shop_url
      ? `<div class="wf"><dt>${esc(T('取扱', 'Sold at'))}</dt><dd><a href="${esc(pr.shop_url)}"
           target="_blank" rel="noopener noreferrer nofollow">${
           esc(pr.shop_url.includes('bookwalker') ? 'BOOK\u2606WALKER'
               : pr.shop_url.includes('cmoa') ? T('コミックシーモア', 'Comic Cmoa')
               : T('販売ページ', 'Shop page'))}</a></dd></div>`
      : '';
    return `<dl class="wp-facts"><div class="wf"><dt>${esc(T('出版社', 'Publisher'))}</dt>
      <dd>${who || ''}</dd></div><div class="wf"><dt>${esc(T('巻数', 'Volumes'))}</dt>
      <dd>${pr.volumes ? esc(volCount(pr.volumes)) : ''}${
        pr.first ? `<span class="wf-sub">${esc(T('初刊 ', 'from '))}${
          esc(fmtDate(pr.first, { year: true }))}</span>`
        : pr.delivered_from ? `<span class="wf-sub">${esc(T('配信開始 ', 'delivered from '))}${
          esc(fmtDate(pr.delivered_from, { year: true }))}</span>` : ''}</dd></div>${shop}</dl>`;
  }).join('');

  /* SOURCES OF INFORMATION, collapsed. Most readers want the book; the ones who want the
     provenance want all of it, so this opens onto every source rather than a summary of them. */
  /* THE STATE BASIS WAS THE LAST LOOSE SENTENCE HERE, and it was two facts welded together: what
     a platform said, and how old the newest chapter we hold is. The first is a source statement and
     belongs in the table below with every other one, quoting the platform's own term. The second is
     our own coverage and is already on the page as a date, so repeating it in prose said nothing
     twice. `state_basis` stays in the row because the badge tooltip reads it. */
  const basis = [];
  /* `why` falls back to state_basis, which the table below now carries as a row, so only the
     completion basis is prose here. That one has no structured equivalent: it is a short capture,
     a run of skipped slots, or a hand review's verdict, and each says something different. */
  if (r.completed_basis) basis.push(`<p class="wp-basis">${esc(r.completed_basis)}</p>`);
  /* WHY THE WORK IS FILED AS YURI, one row per source, strongest first.

     THE ORDER IS DECIDED IN build.py AND THIS ONLY SORTS BY IT. Which evidence outranks which
     follows from DEFINITIONS §2 and §4 and the source tiers in REQUIREMENTS §1, and working it
     out here would put a documented judgement in the one place with no access to the records.
     `rank` is emitted per row; `adapters/classify/credence.py` holds the reasoning.

     `Listed as` IS A QUOTATION. A genre word is a short controlled vocabulary and is glossed in
     English with the source's own word kept on the title, so nothing untranslated reaches an
     English page. 百合・GL and 百合 and an imprint
     name are visibly different claims, and a reader weighs them without a sentence of ours
     explaining which is stronger. An earlier draft wrote that sentence per row and it needed two
     authored strings per work per source. */
  /* DEDUPED AFTER RENDERING, NOT BEFORE. build.py drops rows that repeat, and it compares the
     strings MADB stored: 一迅社 spells one imprint `IDコミックス. Yurihime comics` on one edition
     of a work and `IDコミックス　／　Yuri-hime comics` on the next, so two rows survive that. Both
     then normalise to コミック百合姫 here and the table said the same thing twice on two works.
     What makes two rows one is what a reader sees, so the comparison belongs where that is made. */
  const evRows = onceEach((r.evidence || []).map(e => [
      `<td class="wp-cue">${rankCue(e.rank)}</td>`,
      `<td>${esc(evSource(e))}</td>`,
      `<td class="wp-kind">${esc(evType(e.type))}</td>`,
      `<td><span class="wp-term"${evTermTitle(e) ? ` title="${esc(evTermTitle(e))}"` : ''
        }>${esc(evTerm(e))}</span></td>`,
      `<td class="wp-read">${readCell(e)}</td>`]));
  /* EVERYTHING ELSE WE READ A SOURCE FOR, kept in its own table on purpose. A volume count and a
     chapter count say nothing about whether a work is yuri, and running them into the table above
     would pad the classification case with rows answering a different question, which would make
     it look better supported than it is. */
  /* The platform half is read off `sources`, which already states each platform, when it was read
     and where. series.json carries it once and this joins it here; copying it into a second list
     would be the same fact with two producers, and a megabyte of the works index besides. */
  /* WHERE THE ENGLISH TITLE CAME FROM, joined here from the name record rather than carried on
     every row. `provenance.cite` in the build decides what may be shown, so a title we translated
     ourselves contributes nothing: it is already marked as ours, and there is no document. */
  const _trec = nameFor('titles', r.work, r.work_en);
  const _tcite = _trec && _trec.en_cite;
  const heldRows = onceEach((r.sourced_from || []).concat(
      _tcite ? [{ source: _tcite.source, holds: 'english-title',
                  read: _tcite.reviewed, url: _tcite.url }] : [],
      (r.sources || []).map(s => ({ source: s.platform, holds: 'chapters',
                                    read: s.retrieved, url: s.url })),
      (r.state_claims || []).map(c => ({ source: c.source, holds: 'serialisation-status',
                                         term: c.term, read: c.read, url: c.url })))
    .map(x => [`<td>${esc(sourceBoth(x.source))}</td>`,
               `<td>${esc(evHolds(x.holds))}${x.term
                  ? `<span class="wf-sub"${evTermTitle(x) ? ` title="${esc(evTermTitle(x))}"` : ''
                    }>${esc(evTerm(x))}</span>` : ''}</td>`,
               `<td class="wp-read">${readCell(x)}</td>`]));
  const evTable = evRows ? `<h4 class="wp-subh">${esc(T('百合分類の根拠（根拠の強さ順）',
        'Basis for classification as yuri, by strength of evidence'))}</h4>
      <div class="wp-scroll"><table class="wp-rows wp-ev">
        <tr><th class="wp-cue"></th><th>${esc(T('出典', 'Source'))}</th>
            <th>${esc(T('種別', 'Type'))}</th><th>${esc(T('表記', 'Listed as'))}</th>
            <th>${esc(T('取得日', 'Read'))}</th></tr>
        ${evRows}</table></div>` : '';
  const heldTable = heldRows ? `<h4 class="wp-subh">${esc(T('その他の情報', 'Other data'))}</h4>
      <div class="wp-scroll"><table class="wp-rows">
        <tr><th>${esc(T('出典', 'Source'))}</th><th>${esc(T('内容', 'For'))}</th>
            <th>${esc(T('取得日', 'Read'))}</th></tr>
        ${heldRows}</table></div>` : '';
  /* REQUIREMENTS §4: a work's publication is a historical fact and no source dropping it takes it
     back. Nothing on this page carries a withdrawal marker today, because the only reachability
     sweep we run points at chapter pages and has never been pointed at these. Each row states the
     day it was read and claims nothing about today. */
  const keepLine = (evTable || heldTable)
    ? `<p class="wp-keep">${esc(T('出典が削除された場合も記録を保持し、その旨を示す。',
        'Entries are retained after a source is withdrawn, and marked as such.'))}</p>` : '';
  const srcBody = (basis.length || evTable || heldTable)
    ? `<details class="wp-src"><summary>${esc(T('出典', 'Sources of information'))}</summary>
         ${basis.join('')}${evTable}${heldTable}${keepLine}</details>` : '';

  const from = document.querySelector('nav button[aria-selected=true]')?.dataset.tab || 'ser';
  const backTo = from === 'feed' ? T('← 更新一覧', '← All updates')
               : from === 'rel' ? T('← 発売一覧', '← All releases')
               : T('← 作品一覧', '← All works');
  /* A RECORD PAGE'S HEADING STACKS THE TWO LANGUAGES, and all three record pages agree on it.
     The rest of a page like this pairs them inline, and that works because `T` holds two short
     interface words with a label sitting over them. A title has neither of those. 娘が彼女を連れて
     きた話 beside My Daughter Brought Her Girlfriend Home overflows the <h2> at the width this was
     read at, so the line breaks wherever the viewport puts it, and the Japanese half carries ruby,
     which means a break can land between a kanji and the kana above it. Two lines put the break
     where it means something and `.bi-en` already styles the second one as the same heading again.

     The publisher page's heading was the inline form and moved here, so the shape a reader meets
     at the top of a page no longer depends on which of the three they opened. */
  box.innerHTML = `<p class="wp-back"><a href="${BASE}?tab=${esc(from)}" id="wp-back">${
      esc(backTo)}</a></p>
    <header class="wp-head">
      <h2 class="wp-title">${bilingual(() => workLabel(r))}</h2>
      <p class="wp-badges">${badges.join('')}</p>
    </header>
    <dl class="wp-facts">${facts.join('')}</dl>
    ${sect(T('ウェブ連載', 'Web serialisation'), webBody)}
    ${sect(T('単行本', 'Collected volumes'), printBody + '<div id="wp-vols"></div>')}
    ${srcBody}`;
  el('wp-back').addEventListener('click', ev => { ev.preventDefault(); closeWorkPage(true); });
  paintVolumes(r);
  window.scrollTo(0, 0);
}

/* ── a credit's record, and a publisher's ─────────────────────────────────────────────────────
   WHY THESE ARE PAGES AND NOT A SEARCH. The project owner's ruling: they are URL-holding objects,
   minted for every credit and every house rather than for the ones above some threshold. An author
   with one work has a page holding that one work, and a reader following a citation to it arrives
   somewhere that answers. Making the address depend on how much of somebody's output this database
   happens to hold is a fact about our coverage standing in the reader's way.

   THE SHAPE IS THE WORK PAGE'S. The thing itself with no heading of its own, then its parts, then
   its sources collapsed. A credit page is the credit and the works it is named on; a house page is
   the house and the lines it runs.

   THE FRAMING THIS MUST NOT GET WRONG, and it binds the author side harder than the publisher one.
   Nobody thinks a KADOKAWA page listing 387 works is KADOKAWA's catalogue. A person's page listing
   three works reads as that person's body of work, when they may have thirty and we hold the three
   that are yuri. So the page says what its list is, above the list, in the reader's language. */
let PAGE_REC = null;                       // {kind: 'credit'|'publisher', id}
const RECDATA = {};                        // kind -> promise of the shipped file

function recData(kind) {
  if (!RECDATA[kind]) {
    // AGAINST BASE AND NOT AGAINST THE ADDRESS BAR. `navSync` rewrites the address to
    // `/kari/work/<id>/` while the app stays loaded, so a relative fetch started after that
    // resolves inside the work's directory and 404s. That was invisible while every fetch happened
    // at boot; a record page is fetched on demand, from wherever the reader already is.
    RECDATA[kind] = fetch(BASE + 'data/' + (kind === 'credit' ? 'credits' : 'publishers') + '.json',
                          { cache: 'no-cache' }).then(x => x.json()).catch(() => null);
  }
  return RECDATA[kind];
}

/* WHERE A RETIRED IDENTIFIER WENT, for a credit and a house, and it is `liveId`'s rule applied to
   another registry: A into B into C has to land on C. Minting about 2,400 addresses guarantees some
   will merge, and an address published once has to keep resolving. */
function liveRecId(doc, key, id) {
  const rows = (doc && doc[key]) || {};
  const map = (doc && doc.merged) || {};
  let cur = id;
  const seen = new Set([id]);
  while (cur && !rows[cur] && map[cur] && !seen.has(map[cur])) { cur = map[cur]; seen.add(cur); }
  return cur;
}

/* ONE CREDIT, RENDERED THE WAY EVERY OTHER CREDIT ON THE SITE IS RENDERED. It goes through
   authorLabel, so the reader's language, romanisation style, name order and furigana all reach it
   and nothing here is a second opinion about how a name is spelt. What this adds is the link.

   THE SPAN IS WHAT THE FIELD WRITES AND THE ADDRESS COMES OFF THE FOLD OF IT, and separating those
   two is what let the walk in `linkedCredits` be fixed. `credit_parts` spells a name the way the
   store is keyed on it, so the division says 山本和音 where the field says `山本 和音` and
   ｓｏｎｏ．Ｎ where the field says `sono.N`. Handing the DIVISION's spelling here drew the name a
   reader sees as the store spells it, which is somebody's name changed under their own work; the
   walk therefore located names in the field as written and missed those 38. `nameFor` folds
   whatever it is given, so the span addresses the same record the division's name does, and it is
   the span that is drawn.

   `existing` IS THE RECORD THE CALLER ALREADY RESOLVED, not a second lookup. A work page holds a
   rendering of its own byline in `author_en`, aligned to the spelling that row writes, and a chip
   covering the whole field belongs to that record: the store's copy carries the store's spacing,
   so its ruby draws 永田　さんずい over a field that says 永田さんずい. One resolution, in the
   caller, consumed here (§3). Called with one argument the chip resolves it itself, which is what
   a credit page's held-apart names do. */
function creditChip(span, existing) {
  const rec = nameFor('authors', span, existing);
  const inner = authorLabel({ author: span, author_en: rec });
  const id = rec && rec.id;
  return id ? `<a class="wplink credit" href="${esc(BASE)}credit/${esc(id)}/">${inner}</a>` : inner;
}

/* A CREDIT FIELD WITH EACH PERSON IN IT LINKED. The parts come from `credit_parts`, which the build
   composes from the same splitter the name store is keyed on, so this never divides a name itself:
   ・ sits inside さりい・Ｂ and separates 矢立肇 from 富野由悠季, and nothing in the string tells the
   two apart. Where the build shipped no parts the whole field goes through authorLabel unchanged,
   which is what it did before this existed.

   `shown` IS HOW MANY OF THEM TO DRAW, and the rest of the field is left off. `creditLine` used to
   shorten a long byline by cutting the FIELD on the slash and calling this with the first four
   pieces, which is a second answer to "how does this credit divide" and a worse one: the cut
   string is in no map, so the division went missing and the line fell to the floor. The count
   belongs here, where the division is already in hand. */
function linkedCredits(r, shown) {
  const raw = String(r.author || '').trim();
  if (!raw) return authorLabel(r);
  // A FIELD NAMING ONE PERSON HAS NO PARTS, and that is most of the corpus. `credit_parts` is
  // written for credit LINES, the fields holding several people, so asking it first and giving up
  // when it answers nothing left every single-author work unlinked: the whole field is the one
  // credit in that case, and the store is keyed on exactly that string.
  const all = creditPeople(raw) || [raw];
  const parts = (shown > 0 && shown < all.length) ? all.slice(0, shown) : all;
  /* COMPOSED ON AN ENGLISH PAGE, IN PLACE ON A JAPANESE ONE, and `creditText` splits the same way
     for the same reason. The catalogue's brackets and slashes say which part of the field is the
     job; once the job is stated in English beside the name they say nothing, and leaving them
     standing published `[author]Zaō Taishi / [story]Eiki Eiki`. A Japanese reader is owed the field
     the source wrote, so nothing is rebuilt there.

     NOT WHERE THE BUILD SAYS ITS DIVISION IS INCOMPLETE. `part` means the field says something the
     division did not account for, and composing then would drop it silently. */
  const div = creditDiv(raw);
  const composing = LANG === 'en' && div && !div.part;
  const roleOf = new Map((div ? div.p : []).filter(x => x.n).map(x => [x.n, x.r]));
  const pieces = [];
  /* LOCATED BY THE FOLD AND DRAWN AS THE FIELD WRITES IT, which are two different strings and were
     one value doing both jobs.

     `credit_parts` spells each name the way the store is keyed on it, so 38 fields here hold a
     name the division writes differently: `山本 和音` against 山本和音 and `sono.N` against
     ｓｏｎｏ．Ｎ. `indexOf` on the field as written misses those, the walk gives up, and the byline
     falls to `authorLabel` with no address on any name in it.

     THE ROUTE TRIED AND REJECTED WAS FOLDING ALONE. `foldFind` finds all 38, and the part handed to
     the chip was still the DIVISION's name, so 35 Japanese bylines came back rewritten: `sono.N` as
     ｓｏｎｏ．Ｎ and `2C=がろあ` as 2C＝がろあ, the artist's own name rewritten under their own work.
     What the fold gives is a pair of offsets, and the text between them is the field's own spelling.
     So the fold addresses the record and the span is what a reader sees. Measured over the corpus,
     every one of 4,931 placements folds back to the name the division gave, which is why the span
     needs no second key beside it: `nameFor` folds what it is handed.

     A CHIP COVERING THE WHOLE FIELD GETS THE ROW'S OWN RENDERING. `author_en` is this row's record
     for the string this row writes, so its ruby is aligned to that spelling where the store's copy
     carries the store's; 65 rows hold the two. It is only the row's answer while the span IS the
     field, so the offsets decide and the count of parts does not: `[著]山田` divides into one person
     and `author_en` there is the record for the bracket as well. */
  const map = foldSpans(raw);
  let out = '', linked = false, placed = 0, at = 0, from = 0;
  for (const nm of parts) {
    const hit = foldFind(map, raw, nm, from);
    if (!hit) continue;
    from = hit[2];
    const span = raw.slice(hit[0], hit[1]);
    // EVERY PART GOES THROUGH creditChip, INCLUDING THE ONES WITH NO ADDRESS. Skipping an
    // unregistered person left their Japanese surface sitting in the output between two rendered
    // names, so `宮澤伊織 / 水野英多` came out `宮澤伊織 / Mizuno Hideta` under an English heading.
    // The registry is minted from the works list and the store legitimately holds records nothing
    // credits, so this is the common case rather than an edge.
    //
    // RESOLVED ONCE, HERE, AND THE CHIP CONSUMES IT. Both this line and the chip need to know which
    // record answers for the span, and asking twice is the shape §3 counts seven shipped bugs from.
    const rec = nameFor('authors', span,
                        (hit[0] === 0 && hit[1] === raw.length) ? r.author_en : null);
    if (rec && rec.id) linked = true;
    // THE GAP BETWEEN TWO NAMES IS PART OF THE LINE. It holds the field's brackets and its
    // separators, and where the division did not account for the whole field it holds a name as
    // well, which is how a company sat in kanji between two romanised people on a work page.
    // `creditText` composes the same field on the catalogue tab and floors its gaps for the same
    // reason; the two walk one division and must not answer differently (§3).
    const gap = raw.slice(at, hit[0]);
    const sep = placed ? creditGap(gap) : null;
    const between = sep === null
      ? floorHtml(esc(LANG === 'en' ? creditGapText(gap) : gap)) : sep;
    const chip = creditChip(span, rec);
    if (composing) {
      const role = bylineRole(roleOf.get(nm));
      pieces.push(role ? `${chip} (${esc(role)})` : chip);
    } else {
      out += between + chip;
    }
    at = hit[1];
    placed += 1;
  }
  const rest = raw.slice(at);
  // ALL OF IT OR NONE OF IT. A line whose parts do not all appear in the field would come back
  // half rewritten, and `authorLabel` on the whole line is what this replaces rather than
  // improves: it composes a credit line from its people and knows to fail as a whole.
  //
  // WHAT IS LEFT OF THE FIELD BELONGS TO THE NAMES THAT WERE NOT DRAWN. A shortened line stops
  // after the count it was given, so the tail holds the other ten people and printing it would
  // undo the shortening.
  const tail = parts === all ? floorHtml(esc(LANG === 'en' ? creditGapText(rest) : rest)) : '';
  if (linked && placed === parts.length) {
    if (!composing) return out + tail;
    // `ほか` SURVIVES THE COMPOSITION, because it is the field saying the people it names are some
    // of them, which is a fact about the book rather than notation around a name.
    if (parts === all && div.p.some(x => x.etc)) pieces.push(esc(andOthers()));
    return pieces.join(creditJoiner(div));
  }
  // A SHORTENED WALK THAT FAILED HAS NOTHING TO OFFER, and `authorLabel` is the wrong answer for
  // it: that renders the WHOLE field, and the caller would print "and 9 others" under a line
  // already naming all fourteen. Null says so and the caller draws the byline in full.
  return parts === all ? authorLabel(r) : null;
}

/* A HOUSE'S NAME, LINKED. Same rule: the name itself is `pubBoth`'s, which is what the volumes
   section already shows, and the identifier comes off the shipped map beside it. */
function publisherChip(name) {
  const rec = pubRec(name) || pubRec(String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim());
  const shown = floorHtml(esc(pubBoth(name))) + pubMark(name);
  return rec && rec.id
    ? `<a class="wplink pub" href="${esc(BASE)}publisher/${esc(rec.id)}/">${shown}</a>` : shown;
}

/* THE WORKS A RECORD IS NAMED ON, as the rows they are. Every title goes through workLabel, so a
   work reads the same here as it does in the list it came from.

   AND WHERE THE WORK SPELLS THE NAME DIFFERENTLY, IT SAYS SO. A merge keeps one spelling and lends
   the retired one's addresses to it, so 獅尾's page correctly lists Crossline while Crossline's own
   byline reads ししお. Without the note a reader following that link meets a book that does not
   name the person whose page they came from, and has no way to tell a merge from a broken link.
   Same handling as the publisher page gives a line's older spellings: a variant is history and is
   shown, not thrown away. The build decides which spelling that is, because it holds the anchors. */
function recWorkRows(ids, rolesById, asById) {
  const by = new Map(((SERIES && SERIES.series) || []).map(x => [x.id, x]));
  return ids.map(id => by.get(id)).filter(Boolean).map(w => {
    // ALREADY GLOSSED. The caller reads the role list off the record and hands it to `roleWords`
    // there, so this row draws what it was given: a field read in one place and rendered in
    // another is the shape `adapters/lint/entrypoints.py` refuses.
    const said = (rolesById && rolesById[w.id])
      ? `<span class="wf-sub">${esc(rolesById[w.id])}</span>` : '';
    // ALREADY RENDERED, for the reason the roles are: the caller hands over what authorLabel made
    // of it, so the spelling follows the reader's language, style and furigana like every other
    // name instead of arriving as raw Japanese under an English heading.
    const spelt = (asById && asById[w.id])
      ? `<span class="wf-sub">${esc(T('この作品での表記', 'credited as'))} ${asById[w.id]}</span>` : '';
    const when = w.first ? `<span class="wf-sub">${esc(fmtDate(w.first, { year: true }))}</span>` : '';
    // THE TITLE IS THE ROW, so it stacks the way a title stacks in every other list of works. This
    // is a list, and the tabs it duplicates already wrap their rows, so a reader who has set 併記
    // and follows a link from the 作品 tab to an author's page met the same 208 titles with the
    // English half gone. `said`, `spelt` and `when` are sub-lines the caller already rendered.
    return `<li class="recw"><a class="wplink" href="${esc(BASE)}work/${esc(w.id)}/">${
      bilingual(() => workLabel(w))}</a>${said}${spelt}${when}</li>`;
  }).join('');
}

/* WHAT KIND OF THING A CREDIT IS, where it is not a person. 20 of them are not: 円谷プロダクション
   is a company, 「真夜中ぱんチ」製作委員会 a committee, 電撃G'sマガジン a magazine, and DEFINITIONS
   treats a magazine as a place where yuri is published rather than as a party to a work. The
   sentence above the list changes with it, because "not their body of work" is a sentence about a
   person and reads as nonsense over a limited company. */
const SHAPE_NOTE = {
  person: ['この人物が関わったとして本データベースが収録している百合作品。',
           'The yuri works this database holds that name this person.'],
  venue: ['この媒体に掲載されたとして本データベースが収録している百合作品。',
          'The yuri works this database holds that were published in this venue.'],
  organisation: ['この団体が関わったとして本データベースが収録している百合作品。',
                 'The yuri works this database holds that name this organisation.'],
};

/* THE CITATION FOR A CLAIM, rendered once for whichever claim asked. `provenance.cite` in the build
   decides what may be shown and this only draws it, so a route the project agreed not to take and
   an address that is a data endpoint rather than a document never reach here at all. */
function citeLine(cite, what) {
  if (!cite) return '';
  const who = esc(cite.source || '');
  const link = cite.url
    ? `<a href="${esc(cite.url)}" target="_blank" rel="noopener noreferrer nofollow">${who}</a>`
    : who;
  const when = cite.reviewed ? `<span class="wf-sub">${esc(fmtDate(cite.reviewed, { year: true }))}</span>` : '';
  return `<div class="wf"><dt>${esc(what)}</dt><dd>${link}${when}</dd></div>`;
}

function renderCreditPage(doc) {
  const box = el('workpage');
  const id = liveRecId(doc, 'credits', PAGE_REC.id);
  const fact = doc && doc.credits && doc.credits[id];
  if (!box) return;
  document.querySelector('nav').hidden = true;
  ['ser', 'feed', 'rel', 'cat'].forEach(x => { const s = el('tab-' + x); if (s) s.hidden = true; });
  box.hidden = false;
  if (!fact) {
    box.innerHTML = `<p class="wp-back"><a href="${BASE}?tab=ser" id="wp-back">${
      esc(T('← 作品一覧', '← All works'))}</a></p><p>${
      esc(T('この記録は見つからない。', 'No record answers to this address.'))}</p>`;
    el('wp-back').addEventListener('click', ev => { ev.preventDefault(); closeRecordPage(true); });
    return;
  }
  const rec = nameFor('authors', fact.credit, null);
  const shape = fact.shape || 'person';
  const note = SHAPE_NOTE[shape] || SHAPE_NOTE.person;
  const facts = [];
  const fact1 = (k, v) => { if (v) facts.push(`<div class="wf"><dt>${esc(k)}</dt><dd>${v}</dd></div>`); };
  /* THE READING AND WHERE IT CAME FROM. This is the credit page's distinctive content and the
     reason it earns an address: the name's own provenance belongs to the person and not to each of
     their works, and repeating it on every work page would be one fact with many producers.

     THE NOTE BESIDE IT DOES NOT COME HERE. The store holds our reasoning for our own decisions,
     which is a fact about us; the citation says which document, where and when, which is what a
     reader can act on. Decided by the project owner, 2026-08-08. */
  /* THE KANA GOES IN THE JAPANESE LINE AND THE LATIN IN THE ENGLISH ONE. EN mode contains no
     Japanese at all, which is §4 and which `English mode has no Japanese` enforces on the shipped
     names; a kana reading printed under an English heading would break the rule in the one place
     that check cannot see, and it would say the same thing twice besides, since the romanisation
     below is that reading spelt in Latin. */
  if (rec && rec.reading && LANG !== 'en') {
    fact1(T('読み', 'Reading'), esc(rec.reading) + (rec.unverified
      ? `<span class="wf-sub">${esc(T('未確認', 'not confirmed'))}</span>` : ''));
  } else if (!(rec && rec.reading) && shape === 'person' && !(fact.divided_into || []).length) {
    /* ONE SENTENCE, NOT A LIST OF WHO WAS ASKED. 2,171 names carry a recorded failed search, and a
       reader does not need to know which shop was asked on which Tuesday. What they need is that
       the reading is unknown rather than unexamined.

       NOT FOR A STRING THAT IS TWO PEOPLE. `iimAn&惟丞` has no reading because it is not a name,
       and saying nobody knows it invites somebody to go and find one. The two halves below have
       readings of their own, and each says so on its own page. */
    fact1(T('読み', 'Reading'),
          esc(T('この名前の読みは分かっていない。',
                'The reading of this name is not known.')));
  }
  if (rec && rec.romaji && LANG !== 'ja') {
    fact1(T('ローマ字', 'Romanised'), esc(personName(rec) || '')
      + (rec.unverified ? `<span class="wf-sub">${
          esc(T('読みは未確認', 'the reading is not confirmed'))}</span>` : ''));
  }
  if (fact.kind) fact1(T('種別', 'Kind'), esc(T(fact.kind, fact.kind)));
  const rolesById = {};
  (fact.works || []).forEach(w => { if (w.roles) rolesById[w.id] = roleWords(w.roles); });
  /* RENDERED HERE, LIKE THE ROLES ABOVE IT. The row below draws what it was handed, so the field
     is read in the same place it is rendered, which is what `adapters/lint/entrypoints.py` asks.

     AND ONLY WHERE THE READER WOULD SEE TWO DIFFERENT NAMES. Every merge in the registry today is
     one name written two ways, so all five romanise identically: 獅尾 and ししお are both Shishio,
     蛙田アメコ and 蛙田あめこ are both Kaeruda Ameko. "credited as Shishio" under a page headed
     Shishio is a line that answers a question the English reader never had. The comparison is on
     the RENDERED form for that reason, so the note appears in Japanese, where the two spellings
     differ on the page, and stays out of English, where they do not.

     WHICH RENDERING, UNDER 併記. The test above needs one string per name and the page now shows
     two, so `cmpLang` names the one the test reads. It is `ja` in 併記 because that is the line
     the two spellings differ on: 獅尾 and ししお sit one above their shared Shishio, and a reader
     seeing both wants to know which of them the book says. English on its own keeps the silence
     the paragraph above describes, because there `cmpLang` is still `en`. What is DISPLAYED is
     both, since the note carries a name and a name follows the toggle. */
  const asById = {};
  const cmpLang = LANG === 'both' ? 'ja' : LANG;
  const headLabel = inLang(cmpLang, () => authorLabel({ author: fact.credit }));
  (fact.works || []).forEach(w => {
    const shown = w.as ? inLang(cmpLang, () => authorLabel({ author: w.as })) : '';
    if (shown && shown !== headLabel) asById[w.id] = bilingual(() => authorLabel({ author: w.as }));
  });
  const rows = recWorkRows((fact.works || []).map(w => w.id), rolesById, asById);
  /* THE HOUSES BEHIND THE WORKS, which is the small graph the plan describes: a work names its
     author and its publisher, a publisher lists its lines, an author lists works and the houses
     behind them. */
  /* DEDUPED ON WHAT IS DRAWN, not on the field behind it. Two print rows naming one house render
     the same chip, and comparing the chips is comparing what a reader would see twice, which is
     the same rule `onceEach` applies to the evidence table. It also keeps the field's only read a
     hand-over to the function that renders it. */
  const houses = new Set();
  const byId = new Map(((SERIES && SERIES.series) || []).map(x => [x.id, x]));
  (fact.works || []).forEach(w => {
    const row = byId.get(w.id);
    (row && row.print || []).forEach(pr => {
      if (pr.publisher) houses.add(publisherChip(pr.publisher));
    });
  });
  if (houses.size) fact1(T('出版社', 'Publishers'), [...houses].join(SEP));
  /* CREDITS HELD APART, which is what the owner's ruling means by information hung beside a credit.
     Seven pairs share a reading and were examined and kept apart; a page for either should be able
     to say the other exists. It is never a merge and never replaces one with the other. */
  /* A NAME HERE GOES THROUGH THE RENDERER LIKE EVERY OTHER. This wrote `esc(o.credit)` into the
     anchor, so a reader in English met the held-apart credit in Japanese beside their own name
     rendered — the same fault as `esc(w.t)` on the catalogue tab, on a page nothing walked until
     `credits.json` was added to the surfaces. `creditChip` is the anchor and the rendering
     together, which is what the work page's volume rows already use.

     AND IN BOTH LANGUAGES, because `creditChip` reaches `authorLabel` and answers in one. The
     emptiness test is on the LIST and not on the string: `bilingual` wraps whatever it is given in
     a span, so an empty run of chips comes back as markup with nothing in it, which is truthy, and
     the sentence introducing the chips would have printed above no chips at all. */
  const homo = (fact.homophones || []).length
    ? bilingual(() => (fact.homophones || []).map(o => creditChip(o.credit)).join(SEP)) : '';
  /* A STRING THAT IS TWO PEOPLE, AND WHERE THEY BOTH ARE. `iimAn&惟丞` is one field カドコミ uses
     to credit two artists, and it held one identifier until the splitter learned that an ampersand
     joins two. There is no survivor to forward to, so the address answers with both. Without this
     the page reads as a person with no works, which says the opposite of what is true. */
  // Same wrapper and the same test on the list. This one also decides whether the works section is
  // drawn at all, so an empty run coming back truthy would have hidden it.
  const divided = (fact.divided_into || []).length
    ? bilingual(() => (fact.divided_into || []).map(o => creditChip(o.credit)).join(SEP)) : '';
  const srcBody = (rec && rec.reading_cite)
    ? `<details class="wp-src"><summary>${esc(T('出典', 'Sources of information'))}</summary>
         <dl class="wp-facts">${citeLine(rec.reading_cite, T('読みの出典', 'Reading'))}${
           citeLine(rec.en_cite, T('英語表記の出典', 'English name'))}</dl></details>` : '';
  box.innerHTML = `<p class="wp-back"><a href="${BASE}?tab=ser" id="wp-back">${
      esc(T('← 作品一覧', '← All works'))}</a></p>
    <header class="wp-head">
      <h2 class="wp-title">${bilingual(() => authorLabel({ author: fact.credit }))}</h2>
    </header>
    <dl class="wp-facts">${facts.join('')}</dl>
    ${divided ? `<p class="wp-basis">${esc(T(
        'この表記は二人の作者を一つの欄にまとめたもの。本データベースは次の二件として収録している：',
        'This spelling is one field crediting two people. This database files it as: '))}${
        divided}</p>` : ''}
    ${homo ? `<p class="wp-basis">${esc(T('同じ読みの別名義：', 'Held apart from: '))}${homo}</p>` : ''}
    ${divided ? '' : `<section class="wp-sect"><h3>${esc(T('作品', 'Works'))} <span class="wp-n">${
      (fact.works || []).length}</span></h3>
      <p class="wp-keep">${esc(T(note[0], note[1]))}</p>
      <ol class="recws">${rows}</ol></section>`}
    ${srcBody}`;
  el('wp-back').addEventListener('click', ev => { ev.preventDefault(); closeRecordPage(true); });
  window.scrollTo(0, 0);
}

function renderPublisherPage(doc) {
  const box = el('workpage');
  const id = liveRecId(doc, 'publishers', PAGE_REC.id);
  const fact = doc && doc.publishers && doc.publishers[id];
  if (!box) return;
  document.querySelector('nav').hidden = true;
  ['ser', 'feed', 'rel', 'cat'].forEach(x => { const s = el('tab-' + x); if (s) s.hidden = true; });
  box.hidden = false;
  if (!fact) {
    box.innerHTML = `<p class="wp-back"><a href="${BASE}?tab=ser" id="wp-back">${
      esc(T('← 作品一覧', '← All works'))}</a></p><p>${
      esc(T('この記録は見つからない。', 'No record answers to this address.'))}</p>`;
    el('wp-back').addEventListener('click', ev => { ev.preventDefault(); closeRecordPage(true); });
    return;
  }
  const rec = pubRec(fact.name);
  /* WHAT A PUBLISHER PAGE SHOWS THAT NOTHING ELSE CAN: which of its imprints are yuri lines.
     百合姫コミックス over 354 rows against a house with one book somebody shelved as yuri is the
     same structural signal used to find entries admitted on a shop's shelf with nothing behind
     them, and here a reader can see it directly.

     A SPELLING IS A HISTORICAL VARIANT AND IS NOT THROWN AWAY. The line's own name heads the row
     and the years each catalogued spelling covers sit under it, measured off the rows rather than
     written down, so a reader looking at a 2008 volume can see that `Yuri-hime comics` is what that
     volume says. */
  const lineRows = (fact.lines || []).map(ln => {
    const years = [...new Set((ln.spellings || []).flatMap(s => s.years || []).filter(Boolean))].sort();
    const span = years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : (years[0] || '');
    const spellings = (ln.spellings || []).map(s => s.raw).filter(x => ln.name !== x);
    const alt = spellings.length
      ? `<span class="wf-sub" title="${esc(spellings.join(' · '))}">${
          esc(T(`${spellings.length}種の表記`, `${spellings.length} recorded spellings`))}</span>` : '';
    return `<tr><td>${esc(pubBoth(ln.name))}${
        ln.parent ? `<span class="wf-sub">${esc(pubBoth(ln.parent))}</span>` : ''}${alt}</td>
      <td>${esc(String(ln.rows || 0))}</td><td>${esc(span)}</td></tr>`;
  }).join('');
  const lines = lineRows ? `<div class="wp-scroll"><table class="wp-rows">
      <tr><th>${esc(T('レーベル', 'Imprint line'))}</th><th>${esc(T('冊数', 'Books'))}</th>
          <th>${esc(T('年', 'Years'))}</th></tr>${lineRows}</table></div>` : '';
  const seats = (fact.seats || []).includes('distributor')
    ? `<p class="wp-basis">${esc(T('発売元としても記録がある。',
        'Also recorded as the distributor on books another house published.'))}</p>` : '';
  const srcBody = (rec && (rec.en_cite || rec.reading_cite))
    ? `<details class="wp-src"><summary>${esc(T('出典', 'Sources of information'))}</summary>
         <dl class="wp-facts">${citeLine(rec.en_cite, T('社名の出典', 'Company name'))}${
           citeLine(rec.reading_cite, T('読みの出典', 'Reading'))}</dl></details>` : '';
  box.innerHTML = `<p class="wp-back"><a href="${BASE}?tab=ser" id="wp-back">${
      esc(T('← 作品一覧', '← All works'))}</a></p>
    <header class="wp-head">
      <h2 class="wp-title">${bilingual(() => esc(pubBoth(fact.name)))}</h2>
    </header>
    ${seats}
    ${lines ? `<section class="wp-sect"><h3>${esc(T('レーベル', 'Imprint lines'))} <span class="wp-n">${
      (fact.lines || []).length}</span></h3>${lines}</section>` : ''}
    <section class="wp-sect"><h3>${esc(T('作品', 'Works'))} <span class="wp-n">${
      (fact.works || []).length}</span></h3>
      <p class="wp-keep">${esc(T(
        'この出版社の刊行物のうち、本データベースが百合として収録しているもの。',
        'The yuri works this database holds from this publisher.'))}</p>
      <ol class="recws">${recWorkRows(fact.works || [])}</ol></section>
    ${srcBody}`;
  el('wp-back').addEventListener('click', ev => { ev.preventDefault(); closeRecordPage(true); });
  window.scrollTo(0, 0);
}

function renderRecordPage() {
  if (!PAGE_REC) return;
  const want = PAGE_REC;
  recData(want.kind).then(doc => {
    // The reader may have left, or opened another record, while the file was in flight.
    if (!PAGE_REC || PAGE_REC.kind !== want.kind || PAGE_REC.id !== want.id) return;
    if (want.kind === 'credit') renderCreditPage(doc);
    else renderPublisherPage(doc);
  });
}

function openRecordPage(kind, id, push = true) {
  if (!id) return;
  PAGE_WORK = null;
  PAGE_REC = { kind, id };
  renderRecordPage();
  navSync(push);
}

function closeRecordPage(push) {
  PAGE_REC = null;
  el('workpage').hidden = true;
  showSelectedTab();
  document.querySelector('nav').hidden = false;
  navSync(push);
}

/* A credit or a publisher link renders in place instead of letting the browser fetch the
   pre-rendered page, which would only redirect back here. Same handler shape as the work links,
   including leaving a modified click alone: a reader asking for a new tab is asking for the
   address, and the address works. */
document.addEventListener('click', ev => {
  const a = ev.target.closest('a.credit, a.pub');
  if (!a) return;
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const m = a.getAttribute('href').match(/(credit|publisher)\/([A-Za-z0-9_-]+)\//);
  if (!m) return;
  ev.preventDefault();
  ev.stopPropagation();
  openRecordPage(m[1], m[2]);
});

function stateLabel(r) {
  const k = SSTATE[r.state];
  return k ? splitLang(k[0] + ' / ' + k[2], LANG === 'both' ? 'ja' : LANG) : (r.state || '');
}


/* ── releases ─────────────────────────────────────────────
   Print releases, newest first. This is what the corpus actually holds: MADB and openBD catalogue
   a volume to the MONTH, so the calendar the plan imagined is a month list, and openBD supplies
   almost no covers for these publishers, so it is a list rather than a grid. Saying so plainly is
   better than a grid of placeholders pretending at art we do not have.

   Forthcoming releases are not here. Nothing we hold is prospective: BOOK☆WALKER's 新着 listing is
   two weeks AFTER a release by its own definition, and the future dates on it are free-trial
   expiries. Announcing those as release dates would be a confident wrong answer. */
async function renderReleases() {
  // works.json is the same file the volumes tab opens a record from, fetched once and shared.
  if (!DETAIL) DETAIL = fetch('data/works.json', { cache: 'no-cache' }).then(r => r.json());
  const WORKS = await DETAIL;
  // Drawn once per SETTING. The guard exists so a tab click does not rebuild 640 rows, and it has
  // to name EVERY preference the render reads. Naming a subset is how this goes wrong twice: first
  // it named nothing and kept the language it was born in, then it named four of the six and a
  // date-format or spelling change left the tab stale. The list is built from the same place the
  // preferences live so a new one cannot be forgotten here without being forgotten there too.
  const drawnKey = RENDER_PREFS().join('|');
  if (el('rel-list').dataset.drawn === drawnKey) return;
  el('rel-list').dataset.drawn = drawnKey;
  // works.json knows a work by its MADB id; the minted identifier that addresses a work page is
  // on the series row that joined them. Without this map a release links nowhere.
  const byMadb = new Map();
  (SERIES?.series || []).forEach(r => (r.print || []).forEach(pr => {
    if (r.id && pr.work_id) byMadb.set(pr.work_id, r.id);
  }));
  const rows = [];
  (WORKS.works || []).forEach(w => (w.volumes || []).forEach(v => {
    if (v.published) rows.push({ d: String(v.published), w, n: v.number, isbn: v.isbn,
                                 fin: v.final_volume ? v.final_volume_basis : null });
  }));
  rows.sort((a, b) => b.d.localeCompare(a.d) || a.w.title.ja.localeCompare(b.w.title.ja));
  /* Each row is rendered ONCE, into a string, and the controls only choose which strings are
     joined. The alternative is re-running the creator and imprint normalisation below for 640
     volumes on every keystroke, and that work depends on the display preferences rather than on
     the query: the same reason drawnKey guards this whole function. */
  REL_ROWS = rows.map(r => {
      const w = r.w;
      const wid = byMadb.get(w.work_id);
      const href = wid ? `${BASE}work/${esc(wid)}/` : '';
      /* THE WHOLE ROW ONCE PER LANGUAGE, which is what the 作品 and 更新 tabs beside it already do
         and what the 併記 note at the top of this file describes. Only the title was reported
         missing, and wrapping the title alone would have left this row saying 講談社 / Kodansha
         inline, the volume 第6巻 / vol. 6 inline, and the byline in Japanese, under a title that
         had grown a second line. `creditNames` reaches `authorLabel`, so the byline was stuck for
         the same reason the title was.

         `pub` and `key` below stay outside: one is the value of an <option> and the other is a
         search index, and neither is a thing a reader reads.

         AND THE READER'S SETTING IS READ BEFORE THE CALLBACK RUNS. `inLang` assigns LANG for the
         length of each pass, so inside `row` the global says `ja` or `en` and never `both`, and a
         test on it there answers about the pass and not about the toggle. It answered wrongly with
         no error: every row kept its placeholder comment and the mark that fills it went missing
         from one of the two lines. `stacked` is read out here, where LANG is still what the reader
         chose, and the rows are rebuilt when it changes because LANG is one of RENDER_PREFS. */
      const stacked = LANG === 'both';
      const row = lang => {
        const people = creditNames(w.creator);
        // MADB catalogues one imprint three ways: "IDコミックス. Yurihime comics = コミック百合姫",
        // "IDコミックス. コミック百合姫" and "IDコミックス. Yurihime comics". The "A = B" form gives
        // two names for one thing, so the Japanese side is taken and the Latin alias maps onto it.
        // Three spellings of 百合姫 in a list sorted by date read as three different imprints.
        // MADB catalogues one imprint at least six ways: "IDコミックス", "コミック百合姫",
        // "IDコミックス. Yurihime comics = コミック百合姫", "IDコミックス／Yuri-hime comics",
        // "Yuri-hime comics", with half and full-width separators. Six spellings of 百合姫 in a list
        // sorted by date read as six different imprints, which is the opposite of what an imprint is
        // for. The segments are split apart and the most specific one kept; a Latin spelling of a
        // series that has a Japanese name maps onto it.
        const who = publisherPartsHtml(w).join(' · ');
        // A release is of a VOLUME, so the row says which. 471 of 646 are numbered in the record
        // and the rest say nothing rather than being numbered by their position in a sorted list.
        // Same rule as the work page, from the same function: the releases tab was printing
        // `第vol. 8巻` for every volume MADB numbered in words.
        const vol = r.n ? `<span class="relvn">${esc(volLabel(r.n))}</span>` : '';
        // The volume that ended the series, where a shop states both that it ended and how long it
        // is. The updates tab marks a final chapter the same way; a volume carries no such marking
        // of its own, so this says whose claim it is.
        const fin = r.fin ? finalTag(r.fin) : '';
        // The same rule the rest of the site uses. Printing w.title.ja left every release in
        // Japanese however a reader had set the language, which the works tab beside it does not do.
        const label = workLabel({ work: w.title.ja });
        const name = href ? `<a href="${href}">${label}</a>` : label;
        // ONE MARK PER ROW, ON THE JAPANESE LINE. The placeholder below is filled by a string
        // replace that takes the first match, so emitting it on both lines of a 併記 pair would
        // leave the second one showing nothing and the comment sitting in the markup. The mark
        // itself is `visTag`, which pairs its own two words with T().
        const held = (stacked && lang === 'en') ? '' : '<!--vis-->';
        return `<div class="relvt">${name} ${vol}${fin}${held}</div>` +
          `<div class="relvm">${[people, who].filter(Boolean).join(' · ')}</div>`;
      };
    return {
      d: r.d, m: r.d.slice(0, 7),
      // The identifier the series row is keyed on, so visOf() can ask whether this work is held
      // out of the default listing. works.json knows the work by its MADB id and nothing else.
      id: wid, work_id: w.work_id,
      // THE FILTER OFFERS PUBLISHERS AND NOT DISTRIBUTORS. The two are separate fields on
      // the record now, and a reader narrowing the releases list to 一迅社 wants the books
      // 一迅社 published, not every book 講談社 happened to deliver for it. The row still
      // names the distributor; only the filter is publisher-only, because that is the
      // question the control asks.
      pub: pubBoth(w.publisher) || '',
      // Searched on every form of the name, the same rule the other two tabs follow: a reader
      // typing a romanisation must reach a work the interface is showing them in romaji.
      key: searchIndex('titles', w.title.ja, w.title && w.title.en) + ' ' +
           norm(String(w.creator || '')),
      // A PLACEHOLDER, because the row's html is built once per display preference and the
      // held-out control is a filter rather than a preference: flipping it must not rebuild 3,191
      // rows, and the mark it adds has to appear without one.
      html: `<div class="relv">${bilingual(row)}</div>`,
    };
  });
  setRelOptions();
  paintReleases();
}

/* The publishers actually present, and the years actually present. Built from the rows rather
   than written down, so a filter can never offer a value that matches nothing. */
function setRelOptions() {
  const keep = (id, opts) => {
    const s = el(id);
    if (!s) return;
    const was = s.value;
    s.innerHTML = opts.join('');
    s.value = [...s.options].some(o => o.value === was) ? was : s.options[0].value;
  };
  const pubs = [...new Set(REL_ROWS.map(r => r.pub).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  keep('rpub', [`<option value="">${esc(T('全出版社', 'all publishers'))}</option>`]
    .concat(pubs.map(p => `<option value="${esc(p)}">${esc(p)}</option>`)));
  const years = [...new Set(REL_ROWS.map(r => r.d.slice(0, 4)))].sort().reverse();
  keep('rperiod', [`<option value="">${esc(T('直近12か月', 'last 12 months'))}</option>`,
                   `<option value="all">${esc(T('全期間', 'all time'))}</option>`]
    .concat(years.map(y => `<option value="${esc(y)}">${esc(T(y + '年', y))}</option>`)));
}

/* WHAT THE DEFAULT PERIOD IS FOR. This tab answers "what has just come out and what is coming",
   so it opens on the last twelve months. The full 640 volumes are one menu entry away, and the
   count line says which of the two is on screen. */
function relWindow() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
  return from.toISOString().slice(0, 10);
}

function paintReleases() {
  if (!REL_ROWS.length) return;
  const q = norm(el('rq').value.trim()), pub = el('rpub').value, per = el('rperiod').value;
  const from = per === '' ? relWindow() : '';
  const rows = REL_ROWS.filter(r => {
    if (!visShown(r)) return false;
    if (q && !hits(r.key, q)) return false;
    if (pub && r.pub !== pub) return false;
    if (from && r.d < from) return false;
    if (per && per !== 'all' && r.d.slice(0, 4) !== per) return false;
    return true;
  });
  const byMonth = new Map();
  rows.forEach(r => {
    if (!byMonth.has(r.m)) byMonth.set(r.m, []);
    byMonth.get(r.m).push(r);
  });
  // The unit is 巻, because what is listed is volumes and several of them may belong to one work.
  // THE DENOMINATOR IS THE BODY, not everything ever built. A volume held out of the default
  // listing is not part of "3191 volumes" while it is held out, and counting it there would put a
  // number on screen that no setting of the controls can reach.
  const body = REL_ROWS.filter(visShown);
  el('n-rel').textContent = body.length;
  el('rcount').textContent = rows.length === body.length
    ? `${rows.length} ${T('巻', 'volumes')}`
    : `${rows.length} ${T('巻表示', 'shown')}　·　${body.length} ${T('巻', 'volumes')}`;
  el('rempty').hidden = rows.length > 0;
  el('rel-list').innerHTML = [...byMonth.entries()].map(([m, list]) =>
    `<div class="relmonth"><h3><time datetime="${esc(m)}">${
      esc(fmtDate(m))}</time></h3>${
      list.map(r => r.html.replace('<!--vis-->', visTag(r))).join('')}</div>`).join('');
}

function navApply(st) {
  NAV_APPLYING = true;
  try {
    const tab = st.tab || 'feed';
    const btn = document.querySelector(`nav button[data-tab="${tab}"]`);
    if (btn && btn.getAttribute('aria-selected') !== 'true') btn.click();
    if (el('fmonth') && el('fmonth').value !== (st.month || '')) {
      el('fmonth').value = st.month || '';
      el('fmonth').dispatchEvent(new Event('change'));
    }
    // A work record is opened by clicking its row, which is also how it is closed, so the state is
    // reached by asking for the difference rather than by re-running the handler.
    // A RECORD PAGE IS REACHED BY ASKING FOR THE DIFFERENCE, the way a work page is. Done before
    // the work branch, because opening one closes the other and the two must not both be applied.
    const wantRec = st.rec || null;
    const haveRec = PAGE_REC ? PAGE_REC.kind + '/' + PAGE_REC.id : '';
    const askRec = wantRec ? wantRec.kind + '/' + wantRec.id : '';
    if (askRec !== haveRec) {
      if (askRec) openRecordPage(wantRec.kind, wantRec.id, false);
      else closeRecordPage(false);
    }
    const wantWork = st.work || '';
    if (tab !== 'cat') {
      // THE WORK PAGE IS THE DESTINATION. This marked a row in the list and scrolled to it, which
      // was right before work pages existed and survived them: arriving at a work's address showed
      // the list with a highlighted row and the old in-list panel, and every pre-rendered stub
      // sends its reader here, so that was the state a citation resolved to.
      if (wantWork && wantWork !== PAGE_WORK) openWorkPage(wantWork, false);
      else if (!wantWork && PAGE_WORK) closeWorkPage(false);
    } else {
      if (PAGE_WORK) closeWorkPage(false);
      const haveWork = open ? (open.parentElement?.dataset.id || '') : '';
      if (wantWork !== haveWork) {
        if (open) open.click();
        if (wantWork) document.querySelector(`li[data-id="${CSS.escape(wantWork)}"] .row`)?.click();
      }
    }
  } finally {
    NAV_APPLYING = false;
  }
}

window.addEventListener('popstate', e => navApply(e.state || readNavUrl()));

// A work may be addressed by a real path, /kari/work/<id>/, which is what the pre-rendered stubs
// sit at and what a citation should look like. The query form still works, because links to it are
// already out there and an address published once has to keep resolving.
// The app's own directory. A stub sits two levels below it, so an address cannot be built from
// location.pathname alone.
// Three roots sit two levels below it now, so all three come off. A credit page reached at
// /kari/credit/c00024/ would otherwise compute BASE as /kari/credit/c00024/ and every link on it
// would be built inside itself.
const BASE = location.pathname.replace(
  /(?:(?:work|credit|publisher)\/[A-Za-z0-9_-]+\/?|index\.html)?$/, '');

function workFromPath() {
  const m = location.pathname.match(/\/work\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : '';
}

function recFromPath() {
  const m = location.pathname.match(/\/(credit|publisher)\/([A-Za-z0-9_-]+)\/?$/);
  return m ? { kind: m[1], id: m[2] } : null;
}

function readNavUrl() {
  const q = new URLSearchParams(location.search);
  // A path names a work and implies the tab it lives on. Arriving at a pre-rendered stub is
  // exactly this case, and it must reach the same view a click would have produced.
  const onPath = workFromPath();
  // The tab rides in the query beside the path, so a work opened from the updates tab is left by
  // going back to the updates tab. Absent, it means the works list, which is where most arrive.
  if (onPath) return { tab: q.get('tab') || 'ser', month: '', work: onPath, rec: null };
  // A pre-rendered credit or publisher page hands over with the query form, and its own address is
  // the path form. Both resolve to the same view, because a link to either is already an address
  // somebody may hold.
  const onRec = recFromPath()
    || (q.get('credit') ? { kind: 'credit', id: q.get('credit') } : null)
    || (q.get('publisher') ? { kind: 'publisher', id: q.get('publisher') } : null);
  if (onRec) return { tab: q.get('tab') || 'ser', month: '', work: '', rec: onRec };
  return { tab: q.get('tab') || 'feed', month: q.get('month') || '', work: q.get('work') || '',
           rec: null };
}

document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x =>
    x.setAttribute('aria-selected', String(x === b)));
  // Choosing a tab leaves a work page, because a tab is a place and so is a work. And a credit
  // page and a house page, for the same reason.
  PAGE_WORK = null;
  PAGE_REC = null;
  showSelectedTab();
  document.querySelector('nav').hidden = false;
  if (b.dataset.tab === 'rel') renderReleases();
  saveView();
  navSync(true);
}));

/* ── feed ─────────────────────────────────────────────── */

/* A month is a name, not a phrase: same rule as a platform name, so L()/splitLang semantics apply:
   one language, never both, because it sits in a count line beside a number. */
const MONTH_EN = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
function monthLabel(m, lang) {
  const [y, mo] = String(m).split('-');
  const ja = `${y}年${+mo}月`, en = `${MONTH_EN[+mo - 1]} ${y}`;
  // An explicit `lang` still forces one: the hidden <select> builds both halves itself, and each
  // option needs them separately rather than as a string this function has already joined.
  const L = lang || LANG;
  return L === 'en' ? en : L === 'ja' ? ja : `${ja} / ${en}`;
}

/* Which set the tab is showing: the recent window, or one archived month. Read off the control
   rather than held in a variable of its own, so リセット, which clears every select to its first
   option: cannot leave the state and the control disagreeing. */
/* ── Predicted updates ────────────────────────────────────────────────────────────────────────
   Everything else in this tab is a record of what a platform published. This is not: it is what a
   series' own rhythm suggests comes next, and it is the only place the interface states something
   that has not happened. It is marked as inferred at the top of the list for that reason, in the
   same note style used for automatically generated readings.

   The rhythm is the mean gap between chapters, which needs a span and at least three chapters to
   mean anything: two chapters give one interval and no evidence it repeats.

   THE WINDOW IS AHEAD, NOT BEHIND, and this is where it differs from adapters/schedule.py. That
   module tolerates a prediction three intervals late, because being overdue is a reason to go and
   LOOK. It is not a reason to tell a reader something is coming: the first version of this reused
   that rule and offered a reader dates in November and January, one of them nine months past, on a
   series whose interval was long enough to make the tolerance enormous. A prediction that has
   already passed is not "coming soon", it is a series that has gone quiet. */
const SOON_HORIZON_DAYS = 31;
const SOON_MIN_CHAPTERS = 3;

function predictedRows() {
  if (!SERIES) return [];
  // Compared as DATE STRINGS. Rounding a millisecond difference into whole days let a prediction
  // for late yesterday round to zero and appear under tomorrow's heading, and `new Date('2026-01-01')`
  // is UTC midnight while setHours(0,0,0,0) is local, so the two were being mixed. Strings have
  // neither problem and are what the rows are keyed by anyway.
  const iso = d => d.toISOString().slice(0, 10);
  const todayISO = iso(new Date());
  const horizonISO = iso(new Date(Date.now() + SOON_HORIZON_DAYS * 86400000));
  const out = [];
  for (const r of SERIES.series) {
    // Dormant joins them. Its interval keeps predicting a chapter that is not coming, which is
    // most of what an overdue list fills up with if nothing stops it.
    if (r.state === 'completed' || r.state === 'oneshot' || r.state === 'dormant') continue;
    const src = (r.sources || [])[0] || {};
    // ANNOUNCED BEATS AVERAGED, and says so. A platform printing 次回無料更新は8/21 has stated a
    // date; an interval worked out from past chapters is our arithmetic about its habits. Both
    // belong on this tab and they are not the same kind of claim, so the row carries which it is
    // and the two never merge into one undifferentiated "expected".
    // A PREDICTED ROW IS ABOUT A WORK WE HOLD, so it carries the same identity a recorded one does.
    // Without `wid` the row rendered without its work-page link, so every entry under `coming soon`
    // was a dead end while every entry under `latest` led somewhere. `also_on` is likewise a fact
    // about the series that is true today, and the platform filter reads it.
    //
    // WHAT IS NOT COPIED HERE IS THE POINT. A chapter that has not appeared has no episode name and
    // no access terms, so `ep` and `free` stay absent and the row shows neither. Filling them from
    // the last chapter would be describing a different chapter, and the free filter treating an
    // unknown as not-free is the existing considered answer.
    const base = { work: r.work, work_en: r.work_en, author: r.author, author_en: r.author_en,
                   wid: r.id, also_on: (r.sources || []).slice(1).map(s => s.platform).filter(Boolean),
                   url: r.url || src.url, predicted: true, type: 'chapter', access_modes: [] };
    // A date the platform named, or the next one its stated rhythm falls on. The second is
    // computed at build time, because turning 毎月第3金曜 into a date is logic that already exists
    // and is tested, and a second copy of it here would be a second thing to keep right.
    const sn = r.stated_next || {};
    const stated = sn.next_update || sn.next_from_cadence;
    if (stated) {
      if (stated > horizonISO) continue;
      // A DATE THE PLATFORM NAMED THAT HAS PASSED. It is the strongest thing we can hold short of
      // a chapter, so a missed one belongs in front of the reader rather than dropped for being
      // in the past: the platform said a day, the day went by, and nothing arrived.
      const late = stated < todayISO;
      out.push(Object.assign({}, base, {
        plat: sn.platform || src.platform, plat_name: sn.platform || src.platform,
        pub: stated, announced: true, overdue: late, cadence: sn.cadence,
        kind: late ? 'overdue' : 'announced',
        kind_basis: (sn.next_update ? 'the platform announces this date'
                     : `the platform states it updates ${sn.cadence}`)
                    + (late ? ', and it has passed with nothing since' : ''),
        provenance: 'announced' }));
      continue;
    }
    if (!r.first || !r.latest || (r.chapters || 0) < SOON_MIN_CHAPTERS) continue;
    const first = new Date(r.first), latest = new Date(r.latest);
    const span = (latest - first) / 86400000;
    if (span <= 0) continue;
    const every = span / (r.chapters - 1);
    const next = new Date(latest.getTime() + every * 86400000);
    const pub = iso(next);
    if (pub > horizonISO) continue;
    // An interval WE averaged, past its date. Kept, because a reader may want it, and folded away,
    // because it is the weakest thing on the tab and there are a hundred of them: a platform
    // serving a rolling window of free chapters yields a short apparent interval and a truncated
    // latest at once, and both errors push a work into this list.
    const late = pub < todayISO;
    out.push(Object.assign({}, base, {
      plat: src.platform, plat_name: src.platform,
      pub, every: Math.round(every), overdue: late, inferredOverdue: late,
      kind: late ? 'overdue-inferred' : 'expected',
      kind_basis: `publishes about every ${Math.round(every)} days`
                  + (late ? ', and that date has passed' : ''),
      provenance: 'predicted' }));
  }
  // Within a day, what the platform said comes before what we worked out. The tab is grouped by
  // date, so this is the only ordering a reader sees inside a group, and the two are different
  // kinds of claim rather than two instances of one.
  const rank = r => (r.announced ? 0 : 1);
  return out.sort((a, b) => a.pub.localeCompare(b.pub) || rank(a) - rank(b)
                            || String(a.work).localeCompare(b.work));
}

function activeRows() {
  const m = el('fmonth').value;
  if (m === SOON) return predictedRows();
  if (!m) return FEED ? FEED.releases : [];
  const a = ARCHIVE.get(m);
  if (a) return a.releases || [];
  loadMonth(m);
  return null;                 // still loading; renderFeed says so rather than showing "no matches"
}

function loadMonth(m) {
  if (!m || ARCHIVE.has(m) || ARCH_PENDING.has(m)) return;
  ARCH_PENDING.add(m);
  DATA(`feed/${m}.json`).then(d => {
    ARCHIVE.set(m, d);
    ARCH_PENDING.delete(m);
    // A month can carry platforms the recent window does not, and the reverse, so the filter is
    // rebuilt against whatever is on screen. A dropdown offering platforms with nothing behind
    // them is a filter that does nothing, which is worse than a short list.
    setPlatOptions();
    renderFeed();
  }).catch(() => {
    ARCH_PENDING.delete(m);
    el('fcount').textContent = T('この月の更新を読み込めませんでした',
                                 'could not load this month');
  });
}

function setPlatOptions() {
  const sel = el('fplat'), keep = sel.value;
  const names = [...new Set((activeRows() || []).map(r => r.plat_name || r.plat))]
    .filter(Boolean).sort();
  // options[0] is the "全プラットフォーム / all platforms" placeholder written in the markup, and it
  // carries its own dataset.orig from the language pass. Only the generated options are replaced.
  while (sel.options.length > 1) sel.remove(1);
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.dataset.orig = n;              // the record; splitLang consults PLAT_EN for the rendering
    o.textContent = splitLang(n, LANG);
    sel.appendChild(o);
  }
  sel.value = names.includes(keep) ? keep : '';
}

function renderFeed() {
  const q = norm(el('fq').value.trim()), f = el('ftype').value;
  const model = el('fmodel').value, view = el('fview').value;
  const plat = el('fplat').value;
  const month = el('fmonth').value;
  // An archived month is a snapshot: it was written when the month closed and is never rewritten,
  // so it says what was recorded then rather than what we know now. A reader is owed that in one
  // line: NOT the machinery behind it. The write-once rule, the tracking-start date and the
  // fourteen-day window are all on status.html, and none of them changes how to read the page.
  const snap = el('fsnap');
  snap.hidden = !month;
  const src0 = month === SOON ? predictedRows() : [];
  if (month === SOON) {
    // The one place this tab states something that has not happened, so it says so before the list
    // rather than after it.
    // Two kinds of row, and the note has to name both now. It used to say every date here was
    // inferred, which was true until platforms started being read for what they announce.
    snap.textContent = T(
      '「公式予告」は各サイトが告知した日。「更新予定」は各作品のこれまでの更新間隔からの推定です。',
      '\u201cAnnounced\u201d is a date the platform states. \u201cExpected\u201d is estimated from '
      + 'the series\u2019 own past update interval.');
  } else if (month) {
    snap.textContent = T('これは当時記録された、この月のスナップショットです。',
                         'This is a snapshot of the month as it was recorded at the time.');
  }
  const src = activeRows();
  if (src === null) {
    el('fcount').textContent = T('読み込み中', 'loading') + '…';
    el('feed').innerHTML = ''; el('fempty').hidden = true;
    return;
  }
  const rows = src.filter(r => {
    // A feed row carries no `visibility` of its own: the field is on the series row, and this is
    // the same work. An ARCHIVED MONTH IS NEVER REWRITTEN, so the file on disk still holds the row
    // and only the listing hides it, which is what keeps `archives are unchanged` true.
    if (!visShown(r)) return false;
    if (q && !hits(searchIndex('titles', r.work, r.work_en), q)
           && !hits(searchIndex('authors', (r.author || '').trim(), r.author_en), q)
           && !hits(norm(r.ep), q) && !hits(norm(phraseOf(r.ep || '')), q))
      return false;
    // Two models of "update". Free includes rate-limited free and chapters that have flipped
    // out from behind a paywall, which is an update for a reader watching for free content.
    // "Became free" is a different event from "is free": a chapter moving out from behind a
    // paywall is news to a reader who has been waiting, where a normally-free release is not.
    if (model === 'free' && !r.free) return false;
    // The platform selector was populated, wired to re-render, and never read. A chapter carried
    // in several places counts for each of them, so an alternative carrier matches too: filtering
    // to マガポケ should not hide a chapter it carries merely because コミックDAYS is preferred.
    if (plat && (r.plat_name || r.plat) !== plat && !(r.also_on || []).includes(plat)) return false;
    if (f) return r.type === f;
    return true;
  });

  // THE DENOMINATOR IS THE BODY THE READER IS LOOKING AT. Works held out of the default listing
  // are not part of it while they are held out, so counting them there would put a number on
  // screen that no state of the controls can reach, and the tab badge below would disagree with
  // the line under it.
  const body = src.filter(visShown);
  const count = rows.length === body.length
    ? nTotal(rows.length)
    : (LANG === 'en' ? `${rows.length} shown · ${body.length} total`
       : LANG === 'ja' ? `${rows.length} 件表示　·　${body.length} 件`
       : `${rows.length} 件 / shown　·　${body.length} 件 / total`);
  // The count says how many, and nothing about which set: the picker sits directly above it and
  // already carries the period on its own face. This line used to repeat it, which put 2026年7月
  // on two consecutive lines. That was worth doing when the period selector lived at the FOOT of
  // the tab and the count was the only thing near the list naming it.
  el('fcount').textContent = count;
  // The tab badge counts what the tab lists, which is now whichever set is showing.
  el('n-feed').textContent = body.filter(r => r.web !== 'promotional-sample-only').length;
  el('fempty').hidden = rows.length > 0;
  // THE WEAKEST ROWS, FOLDED AWAY. A date we averaged and then watched go by is worth keeping and
  // is not worth a hundred lines at the top of the tab: it is our arithmetic about a series'
  // habits, and where our capture of a platform is thin the same thinness both shortens the
  // apparent interval and truncates the last date we hold. Behind a summary the reader can open.
  const soft = month === SOON ? rows.filter(r => r.inferredOverdue) : [];
  const firm = soft.length ? rows.filter(r => !r.inferredOverdue) : rows;
  const list = view === 'compact' ? compactList : detailList;
  el('feed').innerHTML = list(firm)
    + (soft.length
       ? `<details class="softlist"><summary>${esc(T(
             `推定日を過ぎた作品 ${soft.length} 件（更新間隔からの推定）`,
             `${soft.length} past a date estimated from their own update interval`))}</summary>`
         + list(soft) + '</details>'
       : '');
  if (view === 'compact') stackWrappedRows();
}

// An inline element reports one client rect per line box, so >1 means the title wrapped. All
// measuring is done before any class is set: interleaving reads and writes would re-layout the
// list on every row.
function stackWrappedRows() {
  const rows = [...document.querySelectorAll('#feed .crow')];
  // Measure the whole cell, not just the title. 怪異部〜M県Y市の怪現象について〜 fits on one line
  // and then pushes the source name onto the next, breaking it mid-word (カドコ / ミ): the title
  // had not wrapped but the row had, which is the case worth handling.
  // Height against line-height, not client rects. .ccell is a GRID ITEM, so it is blockified and
  // reports a single box however many lines it occupies: measuring its rects said "never wrapped"
  // for rows that plainly had. Whether the title or the source name caused the wrap does not
  // matter; the row costs two lines either way, so the source may as well own the second.
  const wrapped = rows.filter(r => {
    const c = r.querySelector('.ccell');
    if (!c) return false;
    const lh = parseFloat(getComputedStyle(c).lineHeight) || 20;
    return c.offsetHeight > lh * 1.4;
  });
  for (const r of wrapped) r.classList.add('stacked');
}

/* ── interface language ───────────────────────────────────
   Most chrome is already written as "日本語 / english", so the switch splits those at the
   separator rather than duplicating every string in a table. What needs a table is the chrome that
   is Japanese-only: tab names and the badges.

   The DATA is never translated. Work titles, creator names and platform names are the record, and
   an English rendering of 百合ナビ or くずしろ would be an invention, not a translation. */
/* Japanese carries no case, so English has to choose one, and the choice has to be the same for
   badges that sit side by side. "Free" next to "paid early" on the same row reads as two different
   kinds of thing. It had drifted both ways: Free/Chapter/Final were capitalised while
   syndicated/preview/extra/unclassified were not, and every badge added since followed whichever
   neighbour it was copied from.

   The rule, split into the two groups below: a BADGE is a label and takes an initial capital; a
   word that sits INSIDE running text is lower case, because capitalising it mid-sentence would be
   the error in the other direction. */
const EN = {
  /* tabs */
  '更新':'Updates', '作品':'Works', '単行本':'Volumes', '発売':'Releases',

  /* badges: initial capital */
  '更新中':'Updating', '停滞':'Slow', '休眠':'Dormant', '不明':'Unknown', '完結':'Completed',
  '読切':'One-shot', '最終回':'Final', '新連載':'New', '新話':'Chapter', 'その他':'Other',
  '更新予定':'Expected',
  '公式予告':'Announced',
  '予告日超過':'Overdue',
  '推定日超過':'Overdue (estimated)',
  '最新':'latest', '近日更新予定':'coming soon',
  '無料':'Free', '有料':'Paid', '無料（条件付）':'Free (paced)', '全話無料':'All free',
  '読み切り':'One-shot', '試し読み':'Preview', '番外編':'Extra', 'お知らせ':'Notice',
  'お詫び':'Apology', '再掲':'Reprint', '未分類':'Unclassified', '転載':'Syndicated',
  '公開予定':'Announced', '既出':'Seen',
  '作者未分離':'Author not split', '有料先行':'Paid early', '先行':'Early',

  /* words inside running text: lower case */
  '話':'ch', '巻':'vols', '最新':'latest', '公開':'published', '根拠':'basis',
  '未設定':'not yet assigned', '他':'also',
};
// Counts are generated, so they cannot carry the "日本語 / english" form the rest of the chrome uses.
function nTotal(n) {
  return LANG === 'en' ? `${n} total` : LANG === 'ja' ? `${n} 件` : `${n} 件 / total`;
}

const KIND = {
  'oneshot':     ['読切',   'k-one', 'complete in one instalment'],
  'final':       ['最終回', 'k-fin', 'the series ends here'],
  'new-series':  ['新連載', 'k-new', 'first numbered chapter, or a one-shot'],
  'new-chapter': ['新話',   'k-ch',  'a later numbered chapter'],
  'other':       ['その他', 'k-oth', 'notice, trial, reprint or artwork'],
  'unknown':     ['—',      'k-unk', 'no chapter information available'],
  // A prediction, and the only kind here that describes something which has not happened. It gets
  // its own badge because reusing 新話 would state that a chapter exists, which is exactly the
  // claim the note above the list exists to disclaim.
  'expected':    ['更新予定', 'k-adv', 'expected from this series\u2019 own past interval; not announced'],
  // A date the platform prints on its own page, as against one we worked out. Same slot, different
  // badge, because a reader deciding whether to go and look wants to know which they are reading.
  'announced':   ['公式予告', 'k-adv', 'the date the platform itself announces'],
  // Past its date. Two of them, because what was missed matters: a day the platform named, or an
  // average we took. The first is a fact about the platform, the second about our own arithmetic.
  'overdue':          ['予告日超過', 'k-warn', 'the platform named this date and it has passed'],
  'overdue-inferred': ['推定日超過', 'k-warn', 'past the date our own interval predicted'],
};

function kindTag(r) {
  // Tags are built in JS, so the markup-level data-i18n pass never reaches them; T() reads the
  // same EN dictionary the language toggle uses, rather than being hardcoded Japanese.
  const [label, cls, why] = KIND[r.kind] || KIND.unknown;
  // Every kind here is our inference rather than a publisher statement, so saying so on each tag
  // adds nothing. What is worth flagging is the weaker route to 最終回: the series is marked 完結
  // and this is simply the newest chapter we hold, rather than a title that says it is the last.
  const q = r.kind === 'final' && r.final_inferred;
  return `<span class="k ${cls}" title="${esc(why)}${
    q ? '. Inferred: the series is marked 完結 and this is the newest chapter we hold, but no title states it is the last' : ''
  }">${esc(T(label))}${q ? '?' : ''}</span>`;
}

function byDate(rows) {
  const days = new Map();
  for (const r of rows) {
    // feed_date, not pub: a late discovery is news today and carries its real
    // publication date as a badge rather than being filed months back.
    const d = (r.feed_date || r.pub || '').slice(0, 10);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  return days;
}

// BADGE ORDER, and why 有料先行 carries no count.
//
// The free badge comes first. If an update put out a chapter anyone can read, that is the fact a
// reader wants off the row, and it should not be queued behind anything.
//
// 有料先行 is a fact about the SERIES (how many chapters currently sit ahead of the free line),
// and it used to render as "有料先行 11" on an update row, which reads as a claim about this
// update. It is not: all 58 rows carrying ahead_n also carry free:true, so the update added a FREE
// chapter while the badge announced eleven paid ones.
//
// There is no count that survives both readings. Counting what is ahead describes the series;
// counting what this update added describes the event; the same number cannot mean both, and the
// data only ever holds the first. So the badge is a flag and the tooltip carries the detail.

// A series dropping several instalments at once is one event to a reader, not N. Collapsed to a
// single line with a count. Precedence: the start of a series outranks a further chapter, which
// outranks a notice, so a new series arriving with several chapters still reads as 新連載.
// An ending outranks an ordinary chapter but not a new series: a series starting is the thing a
// reader most wants surfaced, and a finale should not be shouting over it.
const KIND_RANK = { 'new-series': 4, 'oneshot': 4, 'final': 3, 'new-chapter': 2, 'announced': 2, 'overdue': 2, 'expected': 2, 'overdue-inferred': 2, 'other': 1, 'unknown': 0 };

function compactList(rows) {
  let html = '';
  for (const [d, list] of byDate(rows)) {
    const groups = new Map();
    for (const r of list) {
      const k = (r.work || '') + '\u0000' + (r.plat_name || r.plat || '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    // THE YEAR, WHEN IT IS NOT THIS YEAR. A date two years old shown as 08-22 reads as the
    // twenty-second of this month, so an overdue row from 2024 looked like an upcoming one.
    // 頂のリヴィーツァ was announced for 2024-08-22 and displayed 08-22 beside 予告日超過.
    html += `<div class="cday"><div class="cday-d"><time datetime="${esc(d)}">${
      esc(fmtDate(d, { dow: true, year: needsYear(d) }))}</time></div><div class="cday-l">`;
    for (const g of groups.values()) {
      const lead = g.reduce((a, b) =>
        (KIND_RANK[b.kind] ?? 0) > (KIND_RANK[a.kind] ?? 0) ? b : a);
      // A work dropping several chapters at once is still ONE row. That has not changed. What is
      // gone is the "他 N 件 / also N" counter beside it. The number was a property of how this
      // page groups, not of the release: the platform published chapters, not "a chapter and 11
      // others", and the reader either wants the list or wants the row. The row names the
      // instalment that ranks highest and links to the work, which is where the rest are.
      const anyFree = g.some(x => x.free);
      // WHERE THE LINK GOES when a work drops several chapters at once. The row is NAMED after the
      // instalment that ranks highest, which is a statement about what happened; the link is a
      // place to send a reader, which is a different question. Picking both by kind meant a group
      // holding eleven paid chapters and one free one could show 無料 and then open a paywall.
      //
      // Preference is free, then free-timed, then whatever the lead had. free-timed counts here
      // because this project treats rate-limited free as free: it costs a reader nothing but a
      // wait, which is more use than a chapter they cannot open at all.
      const openable = g.find(x => x.url && x.free)
                    || g.find(x => x.url && (x.access_modes || []).includes('free'))
                    || g.find(x => x.url && (x.access_modes || []).includes('free-timed'));
      const goTo = (openable && openable.url) || lead.url;
      // One complete row per language. Everything in it. The kind badge, the platform name, the
      // access badges: is rendered again on the English line rather than left in Japanese, which
      // is what 併記 asks for and what the previous "English title underneath" did not give.
      const line = () => `${kindTag(lead)}
        <span class="ccell"><span class="cmain">${goTo ? `<a href="${esc(goTo)}" target="_blank" rel="noopener noreferrer nofollow">${workLabel(lead)}</a>`
                   : `<span style="font-weight:600">${workLabel(lead)}</span>`}
        ${lead.late_discovered ? `<span class="k k-adv" title="published ${esc(lead.pub)}; we only learned of it on ${esc(lead.feed_date)}. Editorial coverage of one-shots runs weeks behind publication, so it is shown on the day it became known rather than buried under its publication date.">${esc(T('既出'))} ${esc((lead.pub || '').slice(5))}</span>` : ''}
        ${lead.title_unsplit ? `<span class="k k-unk" title="the source runs title and author together in one cell; we have no confirmed title to split it on, so it is shown as given">${esc(T('作者未分離'))}</span>` : ''}
        </span><span class="cmeta"><span class="m"${lead.origin_note ? ` title="${esc(lead.origin_note)}"` : ''}>${esc(platName(lead.plat_name || lead.plat))}</span>
        ${lead.syndicated ? `<span class="k k-unk" title="${esc(lead.origin_note || 'a syndicated appearance, not original web publication')}">${esc(T('転載'))}</span>` : ''}
        ${anyFree ? `<span class="k k-free">${esc(T('無料'))}</span>` : ''}
        ${(el('fmodel').value === 'all' && lead.ahead_n)
          ? `<span class="k k-adv" title="${esc(aheadTip(lead))}">${esc(T('有料先行'))}</span>` : ''}
        </span></span>`;
      html += `<div class="crow">${bilingual(line)}</div>`;
    }
    html += '</div></div>';
  }
  return html;
}

/* ── detail row helpers ───────────────────────────────────
   This view is for a reader deciding what to open, so it answers four questions in order: what
   updated, can I read it now, where, and is there any reason to doubt it. Anything that is only
   true of OUR processing (that we have not classified a work yet, the date we first saw a row)
   is bookkeeping and is not shown. It stays in the data and in the coverage files, where it is
   for us. What survives here is only what changes what a reader should believe about the manga. */

// The kind tag already says 読切; TYPE_JA says 読み切り. Same fact, twice, side by side.
function redundantType(r) {
  return (r.type === 'oneshot' && r.kind === 'oneshot') ||
         (r.type === 'chapter' && r.kind !== 'unknown');
}

// One badge for access, because free / free-timed / paid are one question with one answer.
function accessTag(r) {
  if (r.free) return `<span class="tag">${esc(T('無料'))}</span>`;
  const m = r.access_modes || [];
  if (m.includes('free-timed'))
    return `<span class="tag" title="free, but paced. A daily ticket or a limited window. Every chapter marked this way can be read at no cost eventually; the systems differ by platform, the outcome does not.">${esc(T('無料（条件付）'))}</span>`;
  if (r.ahead_n)
    return `<span class="tag grey" title="this series runs chapters ahead of the free line, readable now for points; next free ${esc(r.ahead_next_ep || '')} on ${esc(r.ahead_next_free || '')}">${esc(T('先行'))}</span>`;
  if (m.includes('purchase')) return `<span class="tag grey">${esc(T('有料'))}</span>`;
  return '';
}

// Platforms routinely name a one-shot's episode after the work, so the detail view showed
// 吸血少女とウンディーネ with 【読切】吸血少女とウンディーネ directly beneath it. Strip the repeat, and
// the bracketed 読切 marker with it. The kind tag beside the title already says that.
/* The rendered chapter name.

   epLine() strips the work's name off the front of its own chapter name: 大室家の135 under the
   work 大室家 becomes の135, and that strip has to happen AFTER translation, not before. Stripping
   first left a fragment that was never a key in the store, so it fell through untranslated and put
   the one remaining piece of Japanese on the English page.

   So: render the WHOLE chapter name, then strip the rendered work name off the front of it. */
function epText(r) {
  if (LANG !== 'en') return epLine(r);
  const full = phraseOf((r.ep || '').trim());
  if (!full) return '';
  const w = workTextOf(r.work);
  let ep = full;
  if (w && ep.startsWith(w)) ep = ep.slice(w.length).replace(/^[\s:：・: -]+/, '');
  ep = ep.trim();
  // A remainder that is only a particle or a counter is a fragment, not a name.
  return (!ep || ep === w || /^(no|wa|ga|ni|de|to|Ch\.?)$/i.test(ep)) ? '' : ep;
}

function epLine(r) {
  let ep = (r.ep || '').trim();
  if (!ep) return '';
  const stripped = ep.replace(/^[【\[]?(読切|読み切り|よみきり)[】\]]?\s*/, '');
  // Only take the stripped form if what is left still says something. 読み切り作品 reduces to 作品,
  // which is a fragment, not a chapter name: better to show nothing than a leftover.
  if (stripped && !/^(作品|版|話|回)?$/.test(stripped.trim())) ep = stripped;
  const w = (r.work || '').trim();
  if (w && ep.startsWith(w)) ep = ep.slice(w.length).replace(/^[\s:：・: -]+/, '');
  ep = ep.trim();
  return (ep === w || /^(作品|版|話|回)?$/.test(ep)) ? '' : ep;
}

// One caveat survives, and only because it is a fact about the MANGA rather than about us: the
// platform itself moved the publication date, and we keep the earliest.
//
// Removed: 要確認 (a listing site reported it, no platform confirmed). A note about us, addressed
// to someone who cannot act on it; claims are traced by the build now and land on status.html.
// Removed: 日付は推定 (the date was pattern-matched rather than stated). It matched zero rows, so
// it was reassurance about a problem that no longer exists in the data.
function caveats(r) {
  return r.moved
    ? `<div class="datewarn">${T('公開日が変更された', 'publication date was moved')}（${esc(r.moved)}） ·
       ${T('最も早い日付を保持', 'earliest date kept')}</div>` : '';
}

function detailList(rows) {
  let html = '', day = null;
  for (const r of rows) {
    // feed_date, not pub: a late discovery is news today and carries its real
    // publication date as a badge rather than being filed months back.
    const d = (r.feed_date || r.pub || '').slice(0, 10);
    if (d !== day) {
      day = d;
      // No badge here. This was 日付要確認, then 一括掲載: each an improvement on the last and
      // each still the wrong kind of thing to put in front of a reader, who can no more act on
      // "the platform batched these" than on "we should check this". The general fact: that
      // update tracking starts on a known date and dates before it are the platforms' own,
      // imported in one pass and only as good as each platform's back-catalogue dating: is a
      // single statement about the whole database. It belongs in the accompanying text, said once,
      // not re-asserted per day on the rows that happen to trip a heuristic.
      html += `<div class="date-h"><time datetime="${esc(d)}">${
        esc(fmtDate(d, { dow: true, year: needsYear(d) }))}</time></div>`;
    }
    /* WHERE EACH LINK GOES, AND WHY THE ROW STOPPED BEING ONE.
       The row was a single anchor to the chapter on its platform, with a "record for this work"
       line underneath and OUTSIDE that anchor, because an anchor cannot hold another one. The
       project owner's ruling, 2026-08-10: the main link is the work's own record, and the source
       description carries the way out to the platform.

       The anchor being the whole row is what caused both of the things reported about this view.
       It is why the record link had to be a caption in a shape no other layout has, and it is why
       the byline here was the one place on this site where a credit that resolves to a page was
       drawn as plain text: `authorLabel` was not a considered choice, it was the only renderer
       that could be called inside a link. Nothing else was ever wrong with `creditLine`.

       So the row is not an anchor. The title and the chapter name are one, addressing the work,
       exactly as the works tab wraps its title and the source chips sit outside it. Everything on
       line 2 is a name that resolves somewhere, and each now says so.

       THE COMPACT VIEW KEEPS THE OPPOSITE ARRANGEMENT and the owner accepted that. It has one line
       per work with no source description to hang the platform link on, so the same rule applied
       there would take a reader's way out and give nothing back.

       A ROW WITH NO RECORD KEEPS ITS TITLE AS TEXT. 609 rows carry no work identifier, 605 of them
       the archived month, written before the build put one on a release row and never rewritten
       (REQUIREMENTS §5). Those rows lose nothing: the platform link is on the source name either
       way, which is the one thing every row here has always had. */
    // The whole row again in the other language, not an English title bolted under a Japanese
    // row: kind, type, access, author, platform and syndication all re-render.
    const inner = bilingual(() => {
      const head = `<div class="relhead">
        <span class="t">${workLabel(r)}</span>
        ${visTag(r)}
        ${kindTag(r)}
        ${redundantType(r) ? '' : `<span class="tag grey">${esc(T(TYPE_JA[r.type] || r.type))}</span>`}
        ${accessTag(r)}
        ${r.access_changed ? `<span class="tag">${esc(r.access_changed)}</span>` : ''}
      </div>
      ${epText(r) ? `<div class="ep">${esc(epText(r))}</div>` : ''}
      ${r.late_discovered && r.feed_date !== r.pub ? `<div class="pubnote" title="published earlier; it reached this list on ${esc(r.feed_date)}">${esc(T('公開'))} ${esc(r.pub)}</div>` : ''}`;
      const where = platName(r.plat_name || r.plat);
      return `${r.wid
        ? `<a class="wplink relmain" href="${esc(BASE)}work/${esc(r.wid)}/?tab=feed">${head}</a>`
        : head}
      <div class="line2">
        ${r.author ? `<span class="meta by">${creditLine(r)}</span>` : ''}
        ${r.collection && r.collection !== r.work ? `<span class="meta coll" title="an instalment of a collection. The collection's genre label does not necessarily describe every instalment">${floorHtml(esc(workTextOf(r.collection)))}</span>` : ''}
        ${r.url
          ? `<a class="meta plat" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer nofollow" title="${
              esc(r.origin_note || `read this instalment on ${where}`)}">${esc(where)}</a>`
          : `<span class="meta plat"${r.origin_note ? ` title="${esc(r.origin_note)}"` : ''}>${esc(where)}</span>`}
        ${r.channel_name ? `<span class="meta chan" title="a channel within ${esc(platName(r.plat_name))}, not a platform of its own">${esc(r.channel_name)}</span>` : ''}
        ${r.syndicated ? `<span class="tag grey" title="${esc(r.origin_note || '')}">${esc(T('転載'))}</span>` : ''}
        ${(r.also_on && r.also_on.length) ? `<span class="meta">${LANG === 'en' ? '· ' : '・'}${esc(L('他', 'also on'))} ${esc(r.also_on.map(platName).join(LANG === 'en' ? ', ' : '、'))}</span>` : ''}
      </div>
      ${caveats(r)}`;
    });
    html += `<div class="rel${NON_STORY.has(r.type) ? ' quiet' : ''}">${inner}</div>`;
  }
  return html;
}

/* ── series ───────────────────────────────────────────────
   Built from data/series.json, which is the FULL chapter history per (work, platform) rather than
   the 60-day feed window. That is the whole point of the tab: a series between arcs is absent from
   the updates feed and perfectly readable, and it is exactly the kind a reader is looking for. */
/* THE 有料先行 TOOLTIP, in the reader's language and agreeing with its own count.

   It read `1 chapter(s) of this series sit ahead of the free line`, which pluralises by bracket and
   then disagrees with itself in the verb. It was also English whatever the language toggle said,
   which is the state 30 of the 32 tooltips in this file are in; `interface tooltips a reader of
   Japanese cannot read` counts them.

   THE CHAPTER NAMES STAY AS THE PLATFORM PRINTS THEM. `５巻 第５６話「彗星エンカウント」` is the name of
   a thing and not prose about one, so it is quoted rather than translated, in English too. */
function aheadTip(lead) {
  const n = lead.ahead_n;
  const newest = lead.ahead_ep || '';
  const nextEp = lead.ahead_next_ep || '';
  const when = lead.ahead_next_free || '';
  return T(
    `この作品は無料公開より${n}話先まで進んでおり、最新は${newest}。ポイントで今すぐ読めます。` +
    `次に無料になるのは${when}の${nextEp}。作品全体の状態であり、この更新で増えた数ではありません。`,
    `${n} ${n === 1 ? 'chapter' : 'chapters'} of this series sit ahead of the free line, newest ` +
    `${newest}: readable now for points. Next free: ${nextEp} on ${when}. A standing fact about ` +
    `the series, not a count of what this update added.`);
}

const SSTATE = {
  active:    ['更新中', 'k-new', 'a chapter within the last 45 days'],
  // 103 works reach this state and there was no entry for it, so they fell through to `unknown`
  // and were labelled 不明 ("the platform states no date we could read") about series we know
  // have ENDED, on the firmest evidence the build accepts (a 最終話 title, or the platform's own
  // serialisation status). The fallback made a confident finding look like a failure to look.
  completed: ['完結', 'k-fin', 'the series has finished. A final chapter, or the platform says so'],
  oneshot:   ['読切', 'k-one', 'complete in one instalment: finished, not dormant'],
  slow:      ['停滞', 'k-ch',  'last chapter within a year'],
  dormant:   ['休眠', 'k-unk', 'nothing for over a year'],
  unknown:   ['不明', 'k-unk', 'the platform states no date we could read'],
  // A work published in volumes and not online. Not a serialisation that went quiet: there is
  // no serialisation here to have a state, and saying 不明 about one would be the interface
  // reporting a gap in itself as a fact about the manga.
  print:     ['単行本', 'k-fin', 'published in volumes; no web serialisation we track'],
};

/* THE DATE THIS LIST ORDERS ITSELF BY, FOR A ROW OF EITHER KIND.

   The default sort was `latest`, labelled 最終更新順 / last updated, and `latest` is the
   SERIALISATION's own date: it is what decides whether a work is 更新中 or 休眠 and it is null for
   every work published in volumes. 1,948 of the 3,046 rows here carry none — 1,697 print works and
   251 web rows whose platform states no date we could read — so nearly two thirds of the list tied
   on the empty string and sat below the dated rows in whatever order the file happened to be in.
   A control offering to sort by a fact most of its rows do not have was not sorting them.

   `latest_any` IS THE FACT THE BUILD ALREADY SHIPS FOR EXACTLY THIS QUESTION, and it is consumed
   here rather than recomputed (§3). build.py takes the newest of the serialisation's last chapter
   and each print run's last volume, and says so in its own words: a reader scanning the list wants
   to know when the work last did anything, and `latest` answers only when the serialisation last
   updated, so a work whose volume shipped last month reads as a year stale. The work page has drawn
   its 刊行 span off it since that field landed. The list was the one place still asking `latest`.
   `latest` keeps its job untouched, which is deciding the state badge.

   AND THE FALLBACK IS NOT A SECOND FACT. `latest_any` covers 1,911 rows; `first` carries the rest
   to 2,981 of 3,046. A row with exactly one dated event has that event as both its first and its
   latest, so taking `first` where there is no `latest_any` is the same question answered from the
   only evidence there is, not a different question. 65 rows carry no date at all and sort last.

   A ROUTE REJECTED: clamping a date in the future, so that "newest" could mean "most recently
   happened". 12 rows are dated ahead of today and 11 of them are announced volumes, which is what
   the 発売 tab is a list of. A publication date a publisher has stated is a fact about the manga,
   and hiding it at the bottom of the list to protect a word would be the label deciding the key. */
function workDate(r) {
  return r.latest_any || r.first || '';
}

/* HOW MANY ROWS ARE DRAWN AT ONCE, AND WHY THIS IS NOT THE WHOLE LIST.

   The tab drew all 3,046 rows on every render: 2.08 MB of markup and 32,190 elements in Japanese,
   3.73 MB and 60,846 in 併記. For scale, the updates tab's detailed view is the busiest list on
   this site and comes to 255 KB and 4,185 elements. The works list is fourteen times that, it is
   rebuilt on every keystroke in the search box beside it, and it is built at boot for every
   visitor whichever tab they arrived on.

   200 IS NOT A ROUND NUMBER, IT IS THE YARDSTICK. At about 1.2 KB and 20 elements a row, 200 rows
   is roughly what the updates tab already paints, which is the one list here that has always drawn
   its whole body and has never been reported as slow.

   THE ESCAPE HATCH IS THE POINT OF THE PREFERENCE. Drawing part of a list breaks the browser's own
   find-in-page over the rest of it, and that is a real thing to lose: a reader looking for a title
   they cannot spell has been able to press ctrl-F over the entire corpus. So "all at once" stays
   available and the button below the list says how many rows are not drawn, rather than the list
   simply stopping.

   A PREFERENCE, NOT A FILTER (§15). It changes how the same data looks, so it persists, it is
   never in history, and it is deliberately absent from RESETS.ser and from the chip row: the same
   line 簡易/詳細 sits on. Back must not move a reader between pages of a list they did not
   navigate.

   THE SIZES ARE THE SELECT'S, and it is the only place they are written. A copy of the default
   here would be a second answer to a question the markup already answers, and the two would agree
   until somebody changed one of them. `serStep` is what everything below asks. */
let SER_SHOWN = 0, SER_BODY = null;
// 0 is the reader asking for all of them, and it is also what a missing control answers: an
// index.html without this select gets the whole list, which is what this tab did before.
const serStep = () => Number(el('spage')?.value) || 0;

function paintSerMore(shown, total) {
  const b = el('smore');
  if (!b) return;
  b.hidden = shown >= total;
  if (b.hidden) return;
  const left = total - shown;
  const next = Math.min(left, serStep() || left);
  b.textContent = T(`さらに${next}件を表示（残り${left}件）`,
                    `show ${next} more (${left} not drawn)`);
}

function renderSeries() {
  if (!SERIES) return;
  const q = norm(el('sq').value.trim());
  const state = el('sstate').value, freeOnly = el('sfree').value, plat = el('splat').value;
  const sort = el('ssort').value;
  let rows = SERIES.series.filter(r => {
    // 45 rows carry a title and a platform and nothing else: no chapters, no dates, no URL. They
    // rendered as 不明 / Unknown, which is the interface admitting it has nothing rather than
    // telling the reader something. A work we cannot say one fact about is a lead, not an entry;
    // it belongs in the coverage gaps on status.html, where it is work to do.
    // A print-only work has no chapters and is still a work. What the rule excludes is a row
    // we can say nothing about, not one published in volumes rather than online.
    if (!r.chapters && !(r.print || []).length) return false;
    // Held out of the default listing, and kept: see visOf(). Applied FIRST so the tab badge below
    // counts the same body the list draws from.
    if (!visShown(r)) return false;
    if (q && !hits(searchIndex('titles', r.work, r.work_en), q)
           && !hits(searchIndex('authors', (r.author || '').trim(), r.author_en), q)) return false;
    if (state && r.state !== state) return false;
    if (plat && !r.sources.some(s => s.platform === plat)) return false;
    if (freeOnly && !(r.free + r.free_timed)) return false;   // unknown is not free either
    return true;
  });
  rows = rows.slice().sort(
    sort === 'chapters' ? (a, b) => b.chapters - a.chapters
    : sort === 'work'   ? (a, b) => a.work.localeCompare(b.work, 'ja')
    : (a, b) => workDate(b).localeCompare(workDate(a)));

  /* ONE PRODUCER OF "IS THIS A DIFFERENT LIST". Every control that changes which rows there are or
     what order they come in starts the reveal again, and deriving that from the controls' own
     values means a call site added later cannot forget to do it. Language, theme, romanisation and
     furigana are absent on purpose: they repaint the same list, and a reader who has asked for 800
     rows and then switched language should still have 800. */
  // Joined on a NUL, written as the escape, because it is the one character no control's value can
  // hold: a search for "a b" and a state of "b" must not compose the same key as "a" and "b b".
  const key = [q, state, freeOnly, plat, sort, VIS_SHOW, serStep()].join('\u0000');
  if (key !== SER_BODY) { SER_BODY = key; SER_SHOWN = serStep(); }
  const drawn = SER_SHOWN ? rows.slice(0, SER_SHOWN) : rows;
  paintSerMore(drawn.length, rows.length);

  // THE COUNT IS ABOUT THE BODY, NOT THE DRAW. It says how many works match, which is the reader's
  // question; how many of them are on the page is what the button under the list says.
  el('scount').textContent = nTotal(rows.length);
  // THE BADGE COUNTS WHAT THE TAB LISTS. It was assigned once from index.json, which was the same
  // number right up until some rows stopped being listed by default; then the tab said 3076 and
  // the line under it said 3072. A count that disagrees with the list beside it is the failure the
  // chapter count already taught this interface once.
  el('n-cat').textContent = SERIES.series.filter(
    r => (r.chapters || (r.print || []).length) && visShown(r)).length;
  el('sempty').hidden = rows.length > 0;
  el('serlist').innerHTML = drawn.map(r => {
    const [lbl, cls, why] = SSTATE[r.state] || SSTATE.unknown;
    // Free count is the reader's actual question: not "is it free" but "how much of it is".
    // "全話無料" of a single chapter is a category error. There is no proportion to state, only
    // whether the thing is free. A two-part 読切 is different: those genuinely differ in access
    // part to part, so the count is the useful answer there and the badge shows it.
    // NO access badge where there is no access data. This read 有料 for every row whose source
    // states nothing: 293 of 1145, including all 261 カドコミ rows, whose adapter records no access
    // at all. オタクサキュバスの才能がありすぎる！ is free and was listed as paid on that basis. Zero
    // free chapters known is not the same fact as zero free chapters, and only the second is 有料.
    // "6話無料" of a ten-chapter series reads as "four are paid", which was wrong for
    // 運命は役に立たない: nine of its ten are readable now: four outright, five on a 作品チケット or a
    // 待てば無料 timer, and exactly one is behind a coin. Conditionally free IS free to a reader
    // deciding what to open tonight, so it counts here, and the proportion is stated as N/M so the
    // denominator is visible rather than implied.
    const freeN = r.free + r.free_timed;
    const known = freeN + r.priced;
    // A FUNCTION, not a string. Computed once it would be evaluated under 併記, where T() returns
    // Japanese, and the English line would carry 無料. The badge that most needs translating being
    // the one that silently did not. Anything language-dependent has to be called inside
    // bilingual()'s callback, not captured before it.
    const acc = () => !r.chapters || !known ? ''
      : r.chapters === 1 ? (freeN ? `<span class="tag">${esc(T('無料'))}</span>`
                                  : `<span class="tag grey">${esc(T('有料'))}</span>`)
      : freeN >= r.chapters ? `<span class="tag">${esc(T('全話無料'))}</span>`
      : freeN ? `<span class="tag" title="${r.free} free now${
            r.free_timed ? `, ${r.free_timed} free with a daily ticket: readable at no cost, just paced` : ''}${
            r.priced ? `; ${r.priced} paid` : ''}">${freeN}/${r.chapters}${
            ' ' + esc(T('無料'))}</span>`
      : `<span class="tag grey">${esc(T('有料'))}</span>`;
    /* THE TITLE OPENS THE WORK'S PAGE. It used to be a link off to whichever platform serialises
       the work, so the one thing on the row that looked like a link led away from the database,
       and the page a reader wanted was reachable only by clicking the parts that did not.
       Going off-site is still one click, on the named source chips below, which say where they
       go. The updates tab keeps the opposite arrangement, because there the point is to open
       what has just been published.

       An href, not a click handler: a work page is a place, so it must be openable in a new tab
       and copyable from the context menu like any other address. */
    return `<div class="rel" data-work="${esc(r.id || '')}">
      ${r.id ? `<a class="wlink" href="${esc(BASE)}work/${esc(r.id)}/">` : ''}
        ${bilingual(() => `<div class="relhead">
          <span class="t">${workLabel(r)}</span>
          ${visTag(r)}
          <span class="k ${cls}" title="${esc(why)}">${esc(T(lbl))}</span>
          ${r.state === 'print' ? completedTag(r.completed_claim) : ''}
          ${acc()}
        </div>
        <div class="ep">${r.state === 'print'
          ? (() => {
              /* THE UNIT AGREES WITH THE COUNT. `T('巻')` reaches EN as the fixed plural `vols`,
                 so 1,698 print rows read `1 vols`. The volume list on the work page already
                 counts and pluralises in one place; this is the same rule, one row up. */
              const nv = (r.print || []).reduce((n, p) => n + (p.volumes || 0), 0);
              return `${nv} ${esc(L('巻', nv === 1 ? 'vol' : 'vols'))}${
                r.first ? ` · ${esc(r.first)}` : ''}`;
            })()
          : `${partialCount(r.chapters, r.partial)} ${esc(T('話'))}${
            r.latest ? ` · ${esc(T('最新'))} ${esc(fmtDate(r.latest, { year: true }))}${
              r.latest_ep ? ' ' + floorHtml(esc(phraseOf(r.latest_ep))) : ''}` : ''}`}</div>
        ${r.author ? `<div class="line2"><span class="meta by">${authorLabel(r)}</span></div>` : ''}`)}
      ${r.id ? '</a>' : ''}
        <div class="srcs">${r.sources.map(s => {
          // Each source states its OWN coverage. コミックDAYS holds 121 chapters of 雨夜の月 and
          // マガポケ 10. That is what we can see on each, not two different lengths of one story,
          // so the count is shown per source rather than rolled up or summed.
          //
          // And each is a LINK to that platform. A chip naming a place you can read something, that
          // you cannot click, is a worse version of the row's single link. The whole reason to
          // list sources is so a reader can choose one.
          const f = s.free + s.free_timed;
          const tip = `${s.chapters}${s.partial ? '+' : ''} chapters held here${
              f ? `, ${f} free` : ''}${s.priced ? `, ${s.priced} paid` : ''}`;
          const body = `${esc(platBoth(s.platform))}${
              s.format !== 'standard' ? ` <span class="fmt">${esc(s.format)}</span>` : ''}<span
              class="srcn">${s.chapters}${s.partial ? '+' : ''}</span>`;
          return s.url
            ? `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow" title="${tip}">${body}</a>`
            : `<span class="src" title="${tip}">${body}</span>`;
        }).join('')}</div>
    </div>`;
  }).join('');
}

/* ── catalogue ────────────────────────────────────────── */
function renderCat() {
  const q = norm(el('q').value.trim()), f = el('filter').value, mode = el('sort').value;
  const by = {
    'date':      (x,y) => (x.d||'9999').localeCompare(y.d||'9999'),
    'date-desc': (x,y) => (y.d||'').localeCompare(x.d||''),
    'yomi':      (x,y) => (x.y||x.t).localeCompare(y.y||y.t, 'ja'),
    'vols':      (x,y) => y.n - x.n || (x.d||'').localeCompare(y.d||''),
  }[mode];
  const rows = INDEX.filter(w => {
    // w.y is the YOMI, not the author: every print row carries MADB's reading, and the creator is
    // w.c, a credit line with roles in it rather than a bare name. Passing the reading to the
    // author index looked harmless because searchIndex returns the raw string either way, but it
    // was asking the name store a question about the wrong kind of thing.
    if (q && !hits(searchIndex('titles', w.t, null), q)
           && !hits(norm(w.y), q)
           && !hits(norm(w.c), q)) return false;
    if (f === 'multi') return w.n > 1;
    if (f === 'single') return w.n <= 1;
    return true;
  }).sort(by);

  el('count').textContent = rows.length === INDEX.length
    // The count is a number followed by a unit, so only the UNIT is bilingual: translating the
    // whole phrase gave "302 作品 / 302 works", printing the figure twice.
    ? `${rows.length} ${T('作品', 'works')}`
    : `${rows.length} ${T('作品表示', 'shown')}　·　${INDEX.length} ${T('作品', 'works')}`;
  el('empty').hidden = rows.length > 0;
  /* THE TITLE GOES THROUGH THE NAME STORE, LIKE EVERY OTHER LIST. This one printed index.json's
     raw `t`, so パロスの剣 stayed Japanese in English-only mode while its row held en "The Sword of
     Paros" and workLabel returned that on demand. An index row is compact and carries no work_en,
     so the title is the key and the store answers from it.

     The yomi is a reading aid for Japanese and has no place on an English page.

     TITLE, READING AND BYLINE TOGETHER, ONCE PER LANGUAGE. `workLabel` and `credit` both answer in
     one language, so under 併記 this row was Japanese throughout while the 更新 and 発売 tabs next
     to it stacked both. Wrapping the whole cell also settles the yomi, which now sits on the
     Japanese line where the test above always meant to put it. The date and the volume count stay
     out: a date is digits and `L` gives a counter one language on purpose. */
  el('list').innerHTML = rows.map(w => `
    <li data-id="${esc(w.id)}">
      <button class="row" aria-expanded="false">
        <span>${bilingual(() => `
          <span class="t">${workLabel({ work: w.t })}</span>${
            w.y && LANG !== 'en' ? `<span class="yomi">${esc(w.y)}</span>` : ''}
          <br><span class="meta">${credit(w.c) || '—'}</span>`)}</span>
        <span class="num">${esc(w.d || '—')}<br>${w.n} ${esc(L('巻', w.n === 1 ? 'vol' : 'vols'))}</span>
      </button>
    </li>`).join('');
}

async function detail(id, li) {
  if (!DETAIL) DETAIL = fetch('data/works.json', { cache: 'no-cache' }).then(r => r.json());
  const w = ((await DETAIL).works || []).find(x => x.work_id === id);
  if (!w) return;
  const b = w.marketing_label_basis || {}, fp = w.first_publication || {};
  const vols = (w.volumes || []).map(v => `<tr><td>${esc(v.number ?? '—')}</td>
    <td>${esc(v.published ?? '—')}</td><td>${esc(v.isbn ?? '—')}</td>
    <td>${v.openbd === 'present' ? 'openBD' : '—'}</td></tr>`).join('');
  li.querySelector('.detail')?.remove();
  const d = document.createElement('div');
  d.className = 'detail';
  /* THE COUNTRY TAG APPEARS ONLY WHERE A COUNTRY IS ATTESTED. It was esc(fp.country || ''), which
     renders an empty grey pill on any record without one, and until now there were none: build.py
     wrote the literal "JP" on every work. DEFINITIONS §6 makes this field the inclusion test,
     adapters/facts/origin decides it now, and it is empty wherever nothing establishes where the
     work was first published. An empty chip is the interface reporting our own uncertainty at a
     reader, which belongs on status.html; a work with no attested country shows the venue and the
     date it has and says nothing it cannot support. */
  d.innerHTML = `
    <h3>初出 / first known publication</h3>
    <p>${esc(fp.date || '—')} · ${esc(fp.venue || '—')}
       ${fp.country ? `<span class="tag grey">${esc(fp.country)}</span>` : ''}
       <span class="tag grey">date via ${esc(fp.date_source || '?')}</span></p>
    <p class="meta">${esc(fp.note || '')}</p>
    <h3>巻 / volumes (${(w.volumes || []).length})</h3>
    <div class="scroll"><table class="vols">
      <tr><th>巻</th><th>刊行</th><th>ISBN</th><th>source</th></tr>${vols}</table></div>
    <h3>分類 / classification</h3>
    <p><strong>marketing_label:</strong> ${esc(w.marketing_label || '—')} &nbsp;
       <strong>content_tier:</strong> ${w.content_tier ? esc(w.content_tier)
         : `<em>${esc(T('未設定'))}</em>`}</p>
    <div class="basis"><strong>${esc(T('根拠'))}</strong>: ${esc(b.source || '?')}${
      b.retrieved ? `, retrieved ${esc(b.retrieved)}` : ''}<br>${esc(b.note || '')}
      ${b.url ? `<br><a href="${esc(b.url)}" rel="noreferrer">${esc(b.url)}</a>` : ''}</div>
    <h3>出典 / sources</h3>
    <p class="meta">${esc((w.sources || []).join(', '))} · grouping: ${esc(w.grouping || '?')}</p>`;
  li.appendChild(d);
}

el('list').addEventListener('click', e => {
  const btn = e.target.closest('.row'); if (!btn) return;
  const li = btn.parentElement, wasOpen = btn.getAttribute('aria-expanded') === 'true';
  if (open && open !== btn) {
    open.setAttribute('aria-expanded', 'false');
    open.parentElement.querySelector('.detail')?.remove();
  }
  btn.setAttribute('aria-expanded', String(!wasOpen));
  if (wasOpen) { li.querySelector('.detail')?.remove(); open = null; }
  else { open = btn; detail(li.dataset.id, li); }
  // Opening a record is going somewhere, so Back closes it. Closing is a move too, or a reader who
  // opens, closes, then presses Back would jump past both and leave the site.
  navSync(true);
});

['fq','ftype','fplat','fmodel','fview'].forEach(i => el(i).addEventListener('input', renderFeed));
['rq','rpub','rperiod'].forEach(i => el(i).addEventListener('input', paintReleases));
// The selector sits at the BOTTOM of the tab and the list it changes is above it, so a reader who
// picks a month would otherwise be left looking at the control they just used with no sign anything
// happened. Send them back to the top of the list they asked for.
/* ── The month picker ─────────────────────────────────────────────────────────────────────────
   It drives the hidden <select id="fmonth">, which stays the one piece of state. Everything that
   already read that value keeps working, and the picker is only a way of setting it. */
let MPYEAR = null;                       // the year the grid is showing, not the year selected

function monthsAvailable() {
  return ((META && META.archive_months) || []).slice().sort();
}

const SOON = 'soon';                       // the sentinel period: predicted, not recorded

function windowDays() { return (FEED && FEED.window_days) || 14; }

// The BUTTON says what you are looking at; the POPOVER says what that means. "last 14 days" as a
// permanent label spends the widest control in the bar on a number the reader rarely needs, and
// reads as a filter rather than as the default view. The window length belongs where the choice
// is made.
function recentLabel() { return T('最新', 'latest'); }
function recentSubLabel() { return T(`直近${windowDays()}日`, `last ${windowDays()} days`); }
function soonLabel() { return T('近日更新予定', 'coming soon'); }
// Shorter so it sits on one line beside its label at 375px, as "last 14 days" does above it.
function soonSubLabel() { return T('今後1か月', 'in the next month'); }

function monthBtnLabel() {
  const m = el('fmonth').value;
  // The chevron is drawn by .chipmenu in CSS, because that is what marks this as the one chip
  // that opens a menu rather than carrying a cross. Appending one here too gave it two.
  return !m ? recentLabel() : m === SOON ? soonLabel()
       : monthLabel(m);            // follows the mode, including 併記
}

function paintMonthPicker() {
  const avail = monthsAvailable();
  const cur = el('fmonth').value;
  el('fmonthbtn').textContent = monthBtnLabel();
  const rec = el('mrecent');
  rec.innerHTML = `${esc(recentLabel())} <span class="msub">${esc(recentSubLabel())}</span>`;
  rec.setAttribute('aria-current', String(!cur));
  const soon = el('msoon');
  soon.innerHTML = `${esc(soonLabel())} <span class="msub">${esc(soonSubLabel())}</span>`;
  soon.setAttribute('aria-current', String(cur === SOON));
  if (!avail.length) return;

  const years = [...new Set(avail.map(m => +m.slice(0, 4)))].sort();
  if (MPYEAR == null) MPYEAR = cur ? +cur.slice(0, 4) : years[years.length - 1];
  el('myear').textContent = MPYEAR;
  el('mprev').disabled = MPYEAR <= years[0];
  el('mnext').disabled = MPYEAR >= years[years.length - 1];

  const names = LANG === 'en'
    ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    : ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  el('mgrid').innerHTML = names.map((n, i) => {
    const key = `${MPYEAR}-${String(i + 1).padStart(2, '0')}`;
    const has = avail.includes(key);
    return `<button data-m="${key}"${has ? '' : ' disabled'}
      aria-current="${String(key === cur)}">${esc(n)}</button>`;
  }).join('');
}

function openMonthPicker(show) {
  const pop = el('fmonthpop');
  const want = show == null ? pop.hidden : show;
  pop.hidden = !want;
  el('fmonthbtn').setAttribute('aria-expanded', String(want));
  if (want) paintMonthPicker();
}

function setMonth(v) {
  if (el('fmonth').value === v) { openMonthPicker(false); return; }
  el('fmonth').value = v;
  el('fmonth').dispatchEvent(new Event('change'));
  openMonthPicker(false);
}

el('fmonthbtn').addEventListener('click', e => { e.stopPropagation(); openMonthPicker(); });
el('mrecent').addEventListener('click', () => setMonth(''));
el('msoon').addEventListener('click', () => setMonth(SOON));
el('mprev').addEventListener('click', () => { MPYEAR--; paintMonthPicker(); });
el('mnext').addEventListener('click', () => { MPYEAR++; paintMonthPicker(); });
el('mgrid').addEventListener('click', e => {
  const b = e.target.closest('button[data-m]');
  if (b && !b.disabled) setMonth(b.dataset.m);
});
// Click-away and Escape, because a popover that only closes by re-clicking its own button traps a
// reader who opened it by accident.
document.addEventListener('click', e => {
  if (!el('fmonthpop').hidden && !e.target.closest('.monthpick')) openMonthPicker(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !el('fmonthpop').hidden) { openMonthPicker(false); el('fmonthbtn').focus(); }
});

el('fmonth').addEventListener('change', () => {
  paintMonthPicker();
  markActive();
  setPlatOptions();
  renderFeed();
  navSync(true);
  // NO SCROLL. It was deliberate once: the period selector lived at the FOOT of the tab, below the
  // list it governs, so choosing a month left a reader looking at the bottom of a list that had
  // just been replaced, and this carried them back up to it. The control is first in the bar now,
  // so the reader is already at the top and the scroll only moves the page out from under them.
  // A behaviour that was right for a layout outlives the layout unless somebody goes and looks.
});
['sq','sstate','sfree','splat','ssort','spage'].forEach(i => el(i).addEventListener('input', renderSeries));
/* THE BUTTON LIVES OUTSIDE #serlist, and that is the whole reason it is a separate element rather
   than the last row of the list. Revealing more redraws the list, and a control inside what it
   redraws takes the keyboard focus with it: a reader pressing it twice would be returned to the
   top of the page in between. */
el('smore').addEventListener('click', () => {
  SER_SHOWN += serStep();
  renderSeries();
  if (!el('smore').hidden) el('smore').focus();
});
el('sreset').addEventListener('click', () => resetFilters(RESETS.ser, renderSeries));
el('rreset').addEventListener('click', () => resetFilters(RESETS.rel, paintReleases));
['q','sort','filter'].forEach(i => el(i).addEventListener('input', renderCat));
// Persist only the durable controls, and only when the reader changes one.
VIEW_FIELDS.forEach(i => el(i)?.addEventListener('change', saveView));
/* WHAT RESET CLEARS IS WHAT GETS HIGHLIGHTED, from one list per tab, so the two cannot drift.
   Deriving the highlight from anything else would eventually mark a control the button does not
   clear, or leave one lit that it does. Note fview is absent from all three: compact against
   detailed is presentation, and a preference is not something a reader needs warning about. */
const RESETS = {
  feed: ['fq', 'fmodel', 'ftype', 'fplat', 'fmonth'],
  ser:  ['sq', 'sstate', 'sfree', 'splat', 'ssort'],
  rel:  ['rq', 'rpub', 'rperiod'],
  cat:  ['q', 'sort', 'filter'],
};

/* ── ONE BAR, THREE TABS ──────────────────────────────────────────────────────────────────────
   The tabs had grown three different interfaces over the same idea. Updates carried a period, a
   search box, three filters and a layout select; Works carried a search box and four selects;
   Releases carried nothing at all, over 640 volumes. Each tab now has a search box, a disclosure
   holding its filters, a chip row saying what is set, and a result line with the controls that
   arrange the output.

   WHY THE CHIPS ARE NOT DECORATION. The filters are collapsed by default, and these preferences
   persist in localStorage, so without them a reader returns days later to a narrowed list with
   nothing on screen saying so. A collapsed panel may hide a control; it must not hide a fact. */
const BARS = {
  feed: { pane: 'ffilt', btn: 'ffiltbtn', gen: 'fchipgen',
          chipped: ['fmodel', 'ftype', 'fplat', 'fvis'] },
  ser:  { pane: 'sfilt', btn: 'sfiltbtn', gen: 'schipgen',
          chipped: ['sstate', 'sfree', 'splat', 'svis'] },
  // rperiod is IN the chip row already, as a menu chip: a period always has a value, so it is the
  // one thing here that cannot be removed and it is not generated as a removable chip.
  rel:  { pane: 'rfilt', btn: 'rfiltbtn', gen: 'rchipgen', chipped: ['rpub', 'rvis'] },
};

/* THE CONTROL IS BUILT HERE RATHER THAN WRITTEN IN index.html, and that is a compromise worth
   naming: the markup belongs in the document with the other selects, and this file is the half of
   the interface this change owns. Three selects and not one, because each tab's filters are its
   own disclosure and a control that narrows THIS list has to sit with the controls that narrow it.
   They share one value: the three lists are three views of one decision, and a reader who opted in
   on one has opted in.

   `data-chip` gives the chip a shorter wording than the option, the same as 無料あり does: inside
   the dropdown the option has to read as a sentence, and on a chip it has to read as a label. */
const VIS_SELECTS = { ffilt: 'fvis', sfilt: 'svis', rfilt: 'rvis' };
function buildVisControls() {
  Object.entries(VIS_SELECTS).forEach(([pane, id]) => {
    if (el(id) || !el(pane)) return;
    const s = document.createElement('select');
    s.id = id;
    s.dataset.chip = '異議・保留も表示 / including held-out';
    s.innerHTML =
      `<option value="">${'指定に異議のあるものを除く / excluding held-out entries'}</option>`
      + `<option value="all">${'異議・判断保留のものも含める / include held-out entries'}</option>`;
    el(pane).appendChild(s);
    // saveView is bound to every VIEW_FIELD at parse time, and these do not exist then, so the
    // binding is done here. Without it the choice was applied and never remembered, which is the
    // half-wired state a filter can be in while looking entirely correct.
    s.addEventListener('change', saveView);
  });
  syncVis();
}

// One value behind three controls. Whichever the reader touched decides, and the other two follow,
// so a chip cleared on one tab does not leave another tab silently narrowed.
function syncVis(from) {
  const ids = Object.values(VIS_SELECTS);
  if (from) ids.forEach(id => { if (el(id) && id !== from) el(id).value = el(from).value; });
  VIS_SHOW = ids.some(id => el(id) && el(id).value === 'all');
  ids.forEach(id => { if (el(id)) el(id).value = VIS_SHOW ? 'all' : ''; });
}

function repaintLists() {
  renderFeed();
  renderSeries();
  paintReleases();
  renderChips(document.querySelector('nav button[aria-selected=true]')?.dataset.tab);
}

// One listener for all three, because they hold one value. `change` is what persists (saveView is
// bound to it for every VIEW_FIELD) and `input` is what the ordinary renders listen on, so this
// takes the same route the hand-written selects take and adds only the syncing.
['change', 'input'].forEach(ev => document.addEventListener(ev, e => {
  const id = e.target && e.target.id;
  if (!Object.values(VIS_SELECTS).includes(id)) return;
  syncVis(id);
  repaintLists();
}));

/* The chip says what the reader chose, in the language they are reading. `data-chip` on an option
   is a shorter form for the cases where the dropdown wording only reads as a sentence inside the
   dropdown: "無料で読める話がある" is the right label for an option and too long for a chip. */
function chipLabel(sel) {
  const o = sel.options[sel.selectedIndex];
  if (!o) return '';
  // dataset.orig holds the bilingual source once applyLang has run; before that the text still is
  // the source. splitLang is right either way, which is why neither branch is special-cased.
  return splitLang(o.dataset.chip || sel.dataset.chip || o.dataset.orig || o.textContent, LANG);
}

function renderChips(tab) {
  const b = BARS[tab];
  if (!b || !el(b.gen)) return;
  el(b.gen).innerHTML = b.chipped.map(id => {
    const s = el(id);
    if (!s || !isOffDefault(s)) return '';
    return `<button class="chip chipx" data-clear="${esc(id)}" title="${esc(T('この条件を外す', 'remove this filter'))}">${esc(chipLabel(s))}</button>`;
  }).join('');
}

// Delegated, because the chips are rewritten on every change and a listener bound to one would be
// bound to an element that no longer exists.
document.addEventListener('click', e => {
  const c = e.target.closest('.chip[data-clear]');
  if (!c) return;
  const s = el(c.dataset.clear);
  if (!s) return;
  s.value = s.options[0].value;
  // `input` is what the renders listen on and `change` is what persists the choice. Setting
  // .value fires neither.
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
});

Object.values(BARS).forEach(b => {
  const btn = el(b.btn), pane = el(b.pane);
  if (!btn || !pane) return;
  btn.addEventListener('click', () => {
    const open = pane.hidden;
    pane.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
});

/* DENSITY IS ONE PREFERENCE. It reads as a property of the reader rather than of the tab, so the
   three segmented controls are faces on a single hidden <select>, the same arrangement the month
   picker uses. Switching costs no render: the lists carry both and CSS drops what compact omits. */
function applyView() {
  const v = el('fview').value;
  document.querySelectorAll('[data-view-set]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.viewSet === v)));
  el('serlist')?.classList.toggle('compact', v === 'compact');
  el('rel-list')?.classList.toggle('compact', v === 'compact');
}
document.querySelectorAll('[data-view-set]').forEach(b => b.addEventListener('click', () => {
  if (el('fview').value === b.dataset.viewSet) return;
  el('fview').value = b.dataset.viewSet;
  el('fview').dispatchEvent(new Event('input', { bubbles: true }));
  el('fview').dispatchEvent(new Event('change', { bubbles: true }));
}));
el('fview').addEventListener('input', applyView);

function isOffDefault(e) {
  if (!e) return false;
  // A select whose options are built from the data has none until the data lands, and comparing
  // against options[0] of an empty select made every one of them look set.
  if (e.tagName === 'SELECT') return e.options.length ? e.value !== e.options[0].value : false;
  return e.value.trim() !== '';
}

/* WHY THIS IS WORTH DOING AT ALL. These filters persist in localStorage, so a reader returns days
   later to a list already narrowed by a choice they have forgotten making. "Why are there only 38
   works" has an answer sitting in a dropdown that looks exactly like the five beside it. State
   that survives a reload and announces nothing is a trap, and the controls wrap on a narrow screen,
   so the one that is set may not even be on the same line as the rest.

   Kept slight on purpose: an accent border and a touch of weight. Colour alone does not carry the
   meaning, since the option text differs too, and the reset button opposite goes live at the same
   moment, which is the second cue and the way out. */
function markActive() {
  for (const [tab, ids] of Object.entries(RESETS)) {
    let n = 0;
    for (const id of ids) {
      const e = el(id);
      if (!e) continue;
      const on = isOffDefault(e);
      if (on) n++;
      // fmonth is the hidden state holder; its visible face is the picker button.
      const face = id === 'fmonth' ? el('fmonthbtn') : e;
      if (face) face.toggleAttribute('data-active', on);
    }
    renderChips(tab);
    const btn = el({ feed: 'freset', ser: 'sreset', rel: 'rreset', cat: 'creset' }[tab]);
    if (btn) {
      // Disabled when there is nothing to clear, which is also how a reader learns the highlight
      // and the button are about the same thing.
      btn.disabled = n === 0;
      btn.title = n === 0 ? 'nothing to clear'
                          : `clear ${n} active filter${n === 1 ? '' : 's'}`;
    }
  }
}

/* A control whose FACE is drawn separately from the element holding its value. Assigning .value
   fires no event, so anything that paints itself from that value has to be told. The month picker
   is a button over a hidden <select>: reset put the select back to the recent window and left the
   button still reading 近日更新予定, so the tab showed one period and the control claimed another.
   Adding a control with a rendered face means adding it here, which is the point of the table. */
const FACE_PAINTERS = {
  fmonth: () => { if (typeof paintMonthPicker === 'function' && el('fmonthbtn')) paintMonthPicker(); },
};

function resetFilters(ids, render) {
  ids.forEach(id => {
    const e = el(id);
    if (!e) return;
    e.value = e.tagName === 'SELECT' ? (e.options[0] ? e.options[0].value : '') : '';
  });
  ids.forEach(id => { if (FACE_PAINTERS[id]) FACE_PAINTERS[id](); });
  saveView(); render(); markActive();
  // THE ADDRESS IS STATE TOO. These values are assigned directly, so no `change` fires and the
  // handlers that would have called navSync never run. The period is the one filter the URL
  // carries, so clearing it left `month=soon` in the address: the list cleared, and reloading
  // brought the period back from a URL that had never been told. Pushed rather than replaced,
  // because clearing the filters is somewhere a reader can sensibly go Back from.
  navSync(true);
}
// fmonth is in the list: a reader who has gone back to an archived month and then asks for a clean
// slate means the whole tab, not the filters within one month. Clearing it returns to the recent
// window, and the platform options are rebuilt for it before anything is drawn.
el('freset').addEventListener('click', () =>
  resetFilters(RESETS.feed, () => { setPlatOptions(); renderFeed(); }));
el('creset').addEventListener('click', () => resetFilters(RESETS.cat, renderCat));
// Every control that can move off its default keeps the marking current.
Object.values(RESETS).flat().forEach(id => {
  const e = el(id);
  if (e) ['input', 'change'].forEach(ev => e.addEventListener(ev, markActive));
});

/* Re-bound whenever the footer is rendered, because the button is created there now and a
   listener attached at load time would have nothing to attach to. */
function wireClearPrefs() {
  const b = el('clearprefs');
  if (!b) return;
  b.addEventListener('click', () => {
    // EVERY preference, not the two it used to remove. A button labelled "clear" that leaves the
    // language, the romanisation style and the furigana setting behind has not cleared anything a
    // reader would notice, and the ones it did remove were the ones they were least likely to mean.
    try {
      // 'lang' is stored unprefixed, unlike the four PREF_ keys. Checked against the browser
      // rather than assumed: a guessed key removes nothing and fails silently.
      // Enumerated, but checked against the constants rather than typed out again: every
      // PREF_ key this file defines, plus the one stored unprefixed.
      [PREF_THEME, PREF_VIEW, PREF_ROMAJI, PREF_FURI, PREF_ENORDER, PREF_DIALECT, 'lang']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) { /* private mode; nothing was stored to remove */ }
    applyTheme('auto');
    location.reload();
  });
}

// no-cache means REVALIDATE, not "don't cache": the browser still stores the file and the server
// still answers 304 when it has not changed, so this costs a conditional request and not a
// download. Without it the data is cached indefinitely and a reader keeps seeing the previous
// build: 運命は役に立たない sat at a stale 6/10 through a hard reload while the file on disk said
// 13. A bibliographic feed that silently serves yesterday is worse than one that loads slowly.
const DATA = f => fetch('data/' + f, { cache: 'no-cache' }).then(r => r.json());
Promise.all([
  DATA('index.json'),
  // Not feed.json. That file was 1.3 MB and every visitor downloaded all of it to render the first
  // screen: at a year of accumulation, unloadable. current.json is the recent window the tab opens
  // on; the months behind it are separate files, fetched only if asked for.
  DATA('feed/current.json'),
  DATA('series.json').catch(() => null),
  DATA('feed/meta.json').catch(() => null),
  // Names, keyed by folded title/author, joined onto rows at render time: see nameFor(). Shipped
  // apart from the rows so an archived month, which is never rewritten, still gets current ones.
  // PUBLISHERS RIDE IN THE SAME FILE. They were a second fetch of a second file written by a
  // second script, and a company name is a name like the other two. Absent means every publisher
  // renders as Japanese, which is the fallback the whole naming design already takes.
  DATA('feed/names.json').catch(() => null),
]).then(([idx, feed, series, meta, names]) => {
  NAMES = names && names.titles ? names : null;
  PUBS = (names && names.publishers) || null;
  INDEX = idx; FEED = feed; SERIES = series; META = meta;
  // The header used to restate the totals: "1350 更新 · 302 作品 · 646 巻" and a release/platform
  // count under it. The tabs already carry those numbers, next to the thing they count, and a
  // reader arriving wants the list rather than its size. Gone; the tab badges remain.
  el('n-cat').textContent   = idx.length;

  // The archive selector. Its first option is the recent window, so returning from a month is the
  // same gesture as leaving it. There is no separate "back". The window length comes from the
  // file rather than being written in, so it stays true if the build changes it.
  const days = feed.window_days || 14;
  // `soon` must exist as an OPTION or the select silently refuses the value: assigning a value a
  // select has no option for leaves it at '', so the picker appeared to do nothing.
  const opts = [`<option value="">${esc(`最新 / latest`)}</option>`,
                `<option value="${SOON}">${esc('近日更新予定 / coming soon')}</option>`]
    .concat(((meta && meta.archive_months) || [])
      .map(m => `<option value="${esc(m)}">${esc(monthLabel(m, 'ja'))} / ${esc(monthLabel(m, 'en'))}</option>`));
  el('fmonth').innerHTML = opts.join('');
  // The picker reads the same list. The button is hidden rather than the bar, since the control
  // now sits among the filters and an empty gap there would read as a missing control.
  el('fmonthbtn').hidden = !(meta && (meta.archive_months || []).length);
  paintMonthPicker();
  // Only offer the way back if there is something behind. Months before update tracking began are
  // not published as archives. They were imported in one pass from platform back catalogues and
  // are not a record of updates as they happened, so early on there may be none.
  el('archbar').hidden = true;      // the bar is gone; the button above carries it now
  // Said once, in the accompanying text, instead of per-row badges nobody can act on. Dates before
  // this pipeline started watching are the platforms' own, imported in one pass, and a platform
  // that stamps a whole back catalogue with the day it listed it gives a date that is real but is
  // not a publication date. The cutoff is read from run.json rather than written in, so it stays
  // true without anyone remembering to update it.
  fetch('data/run.json', { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(run => {
      TRACK_FROM = (run?.sources || []).map(s => s.retrieved).filter(Boolean).sort()[0] || null;
      renderTrackNote();
    }).catch(() => {});

  setPlatOptions();


  if (SERIES) {
    // Count what the tab actually lists. Rows with no chapters are filtered out of the view, so
    // counting the raw array promised 45 works that are not there when you open it.
    el('n-ser').textContent =
      SERIES.series.filter(r => r.chapters || (r.print || []).length).length;
    // Releases reads works.json, which is fetched lazily so the first screen is not waiting on it.
    // Kicking it off here rather than on the first click means the count is simply there, like the
    // others. A number that appears only because somebody clicked is a number they cannot trust.
    renderReleases();
    // From sources[], not a top-level r.platform. There is no such field. The series index became
    // one row per WORK carrying a sources[] list when works on several platforms were collapsed
    // into one row; this line was not updated, so every value was undefined, filter(Boolean) threw
    // them all away and the dropdown rendered with only its "all platforms" placeholder. The
    // FILTER already read sources[], so the control was unusable rather than wrong.
    const sp = [...new Set(SERIES.series.flatMap(r => (r.sources || []).map(s => s.platform)))]
      .filter(Boolean).sort();
    el('splat').insertAdjacentHTML('beforeend',
      sp.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join(''));
  }
  // THE URL WINS, and the order below is the whole of how. Read the address FIRST: restoreView()
  // clicks the saved tab, that click runs navSync, and navSync rewrites the address from whatever
  // is on screen. Reading location.search afterwards therefore returns the view we just restored
  // rather than the link that was followed, which silently destroyed every deep link. The restore
  // is also run with NAV_APPLYING set, so it cannot push a history entry of its own before the
  // reader has done anything.
  // BEFORE restoreView, so a saved value has a control to land in, and before the first render,
  // so no list is drawn without knowing which rows are held out.
  indexVisibility();
  buildVisControls();
  const fromUrl = readNavUrl();
  const hasUrlState = ['tab', 'month', 'work'].some(k => new URLSearchParams(location.search).has(k));
  NAV_APPLYING = true;
  try { restoreView(); } finally { NAV_APPLYING = false; }
  if (hasUrlState) navApply(fromUrl);
  renderFeed(); renderCat(); renderSeries();
  applyLang(LANG);
  // A work record is opened by clicking a row that only exists after the lists are rendered, so
  // the deep link to one is applied here rather than above.
  if (hasUrlState && fromUrl.work) navApply(fromUrl);
  // Seed the first entry with the state actually on screen, so the first Back has somewhere to go
  // that is not "off the site".
  navSync(false);
  // After the restore, not before: the whole point is to show a reader the filters they are
  // returning to, and those are applied by restoreView above.
  markActive();
  // The density control is a face on a stored select, so it starts out saying whatever it was
  // born with rather than what the reader last chose.
  applyView();
}).catch(() => {
  el('fcount').textContent = 'データを読み込めません / could not load data';
});
