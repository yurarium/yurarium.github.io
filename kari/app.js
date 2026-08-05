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
const VIEW_FIELDS = ['fmodel', 'ftype', 'fview', 'fplat', 'sort', 'filter',
                     'sstate', 'sfree', 'splat', 'ssort'];
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

/* One row, or two stacked and distinguished. `render(lang)` must produce a complete row. */
function bilingual(render, cls) {
  if (LANG !== 'both') return render(LANG);
  return `<span class="bi ${cls || ''}">${inLang('ja', () => render('ja'))}` +
         `<span class="bi-en">${inLang('en', () => render('en'))}</span></span>`;
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
  if (styled) out.romaji = styled;
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
  return unattested
    ? `<sup class="unc" title="${esc('the reading this is romanised from is not attested by any source, and may be wrong')}">[?]</sup>`
    : '';
}

function enHtml(rec, cls, isPerson) {
  const e = enOf(rec);
  if (!e) return '';
  // A person's name follows the reader's order. Done here rather than at the call site so the
  // mark and the tooltip come with it: a swapped name that lost its [?] would be worse than one
  // in the wrong order.
  const shown = (isPerson && personName(rec)) || e.text;
  const why = e.unverified
    ? 'reading not confirmed against a source. This romanisation may be wrong'
    : e.ours
      ? (e.basis === 'romaji' ? 'our romanisation of the Japanese, not an English title the work has'
                              : 'our translation, not an English title the work has')
      : 'the English name the work itself uses';
  const mark = (e.ours || e.unverified) ? ' ours' : '';
  return `<span class="en${mark} ${cls || ''}" title="${esc(why)}">${esc(shown)}</span>${uncertainMark(rec, e)}`;
}

/* Titles: EN replaces the Japanese, and in 併記 the whole ROW is rendered again in English by
   bilingual() rather than a title being appended here, so this only ever produces one language. */
/* A collection is a work, so it gets a work's rendering. It was the one title-shaped string on the
   row that never went through the store. */
/* Chapter names, collections and credit lines. Not titles. A chapter name is mostly structure
   (第12話 -> Ch. 12) and a credit line is roles plus names, so they live in their own map, but
   they are looked up exactly the same way. Falls through to the Japanese when nothing is held. */
function phraseOf(ja) {
  if (LANG !== 'en' || !ja || !NAMES || !NAMES.phrases) return ja;
  return NAMES.phrases[foldKey(ja)] || ja;
}

function workTextOf(ja) {
  const e = enOf(nameFor('titles', ja, null));
  return (LANG === 'en' && e) ? e.text : phraseOf(ja);
}

function workLabel(r) {
  const e = enOf(nameFor('titles', r.work, r.work_en));
  const rec = nameFor('titles', r.work, r.work_en);
  if (LANG === 'en' && e) return esc(e.text) + uncertainMark(rec, e);
  if (LANG === 'en') { const ph = phraseOf(r.work); if (ph !== r.work) return esc(ph); }
  return ruby(r.work, rec) + (FURIGANA ? uncertainMark(rec) : '');
}

/* Authors likewise: one language, chosen by the caller's context. A romanisation and its Japanese are the same name
   twice, so the toggle picks one (§5b). */
/* A person's romanisation in the reader's chosen order. The stored form is family first, as the
   name is written; `given` swaps the two halves. Only a two-part name can be swapped: a single
   token is one name and reversing it would invent a structure the name does not have. */
function personName(rec) {
  const rj = rec && rec.romaji && rec.romaji[ROMAJI_STYLE];
  if (!rj) return null;
  if (NAME_ORDER !== 'given') return rj;
  const bits = rj.split(' ').filter(Boolean);
  return bits.length === 2 ? `${bits[1]} ${bits[0]}` : rj;
}

/* A credit line built from the people in it, so it follows the same choices a single name does.
   Null where any of them is unknown to the store: half a line composed and half romanised whole
   reads as neither, and a reader cannot tell which half to trust. */
function creditFromParts(ja) {
  const parts = NAMES && NAMES.credit_parts && NAMES.credit_parts[foldKey(ja)];
  if (!parts || parts.length < 2) return null;
  const out = [];
  for (const n of parts) {
    const shown = personName(nameFor('authors', n, null));
    if (!shown) return null;
    out.push(shown);
  }
  return out.join(', ');
}

function authorLabel(r) {
  const rec = nameFor('authors', (r.author || '').trim(), r.author_en);
  const e = enOf(rec);
  // COMPOSED FIRST, because a credit line usually has no record of its own and the early return
  // below would hand it to the phrase map before anything else got a look. That is what kept
  // 入間人間's line reading "Iruma Ningen" while the name itself was right, and what stopped the
  // name-order choice reaching a line at all.
  if (LANG === 'en') {
    const composedEarly = creditFromParts((r.author || '').trim());
    if (composedEarly) return esc(composedEarly);
  }
  // A CREDIT LINE IS ANNOTATED PERSON BY PERSON. The line as a whole has no record, so it had no
  // furigana at all even once every person in it had a sourced reading. The raw string is kept
  // exactly as written, separators and roles included, and each name inside it is replaced by its
  // own ruby: joining the parts with a comma would rewrite the credit as well as annotate it.
  const rawJa = (r.author || '').trim();
  const parts = NAMES && NAMES.credit_parts && NAMES.credit_parts[foldKey(rawJa)];
  if (FURIGANA && parts && parts.length > 1) {
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
    const ph = phraseOf((r.author || '').trim());
    return esc(ph);
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
    const raw = (r.author || '').trim();
    if (/[\/／,、･・]|原作|作画|漫画|構成|脚本|企画/.test(raw)) {
      const ph = phraseOf(raw);
      if (ph !== raw) return esc(ph);
    }
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
/* Creator role markers, which arrive welded into the credit string: "[著]森永みるく",
   "[漫画]東雲水生 / [脚本]駒尾真子". The NAME is a proper noun and stays as it is in every mode:
   transliterating a mangaka is not translation, it is guessing. The bracketed ROLE is a label and
   is rendered. MADB's own vocabulary, so the set is small and closed. */
const ROLE_EN = {
  '著':'author', '原作':'story', '漫画':'art', '作画':'art', '脚本':'script',
  'キャラクターデザイン原案':'character design',
};
function credit(c) {
  if (LANG !== 'en' || !c) return c || '';
  return c.replace(/\[([^\]]+)\]/g, (m, r) => ROLE_EN[r] ? `[${ROLE_EN[r]}]` : m);
}

/* The source chips sit OUTSIDE bilingual(). They are links, and two sets of clickable chips to the
   same platforms reads as a bug rather than a translation. But that left them Japanese-only in
   併記, where the whole point is to show both. So the chip carries both names on ONE link instead
   of the row carrying two links. */
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
  p.innerHTML = ftLine(
    `更新の追跡開始は ${TRACK_FROM}。それ以前のウェブ漫画の公開日は正確とは限りません。`,
    `Update tracking began on ${TRACK_FROM}. Web manga publication dates before ${TRACK_FROM}`
    + ` may not be reliable.`);
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
  n.textContent = T(
    '大半は自動生成された推定で、出典に基づくものではありません。推定の読みには印がつきます。',
    'Most are generated rather than taken from a source. The generated ones are marked where they '
    + 'appear.');
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
  if (FEED) { renderFeed(); renderCat(); renderSeries(); }
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
    if (FEED) { renderFeed(); renderCat(); renderSeries(); }
  });
  document.querySelectorAll('[data-romaji-set]').forEach(b =>
    b.addEventListener('click', () => {
      ROMAJI_STYLE = b.dataset.romajiSet;
      prefSet(PREF_ROMAJI, ROMAJI_STYLE);
      applyRomajiVisibility();
      if (FEED) { renderFeed(); renderCat(); renderSeries(); }
    }));
  document.querySelectorAll('[data-nameorder-set]').forEach(b =>
    b.addEventListener('click', () => {
      NAME_ORDER = b.dataset.nameorderSet;
      prefSet(PREF_NORDER, NAME_ORDER);
      applyRomajiVisibility();
      if (FEED) { renderFeed(); renderCat(); renderSeries(); }
    }));
  document.querySelectorAll('[data-dialect-set]').forEach(b =>
    b.addEventListener('click', () => {
      DIALECT = b.dataset.dialectSet;
      prefSet(PREF_DIALECT, DIALECT);
      // The markup-level strings are rewritten by the language pass and by nothing else, so the
      // panel's own label kept saying romanisation after the reader asked for en-US.
      applyLang(LANG);
      applyRomajiVisibility();
      if (FEED) { renderFeed(); renderCat(); renderSeries(); }
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
  if (FEED) { renderFeed(); renderCat(); renderSeries(); }
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
  return { tab: document.querySelector('nav button[aria-selected=true]')?.dataset.tab || 'feed',
           month: el('fmonth') ? el('fmonth').value : '',
           work: (document.querySelector('nav button[aria-selected=true]')?.dataset.tab === 'ser')
                   ? (document.querySelector('.rel.here')?.dataset.work || '')
                   : (open ? (open.parentElement?.dataset.id || '') : '') };
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
  if (st.work && st.tab === 'ser') {
    q.delete('work'); q.delete('tab');
    const rest = q.toString();
    return BASE + 'work/' + st.work + '/' + (rest ? '?' + rest : '');
  }
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
function workDetail(r) {
  const bits = [];
  (r.print || []).forEach(p => {
    const span = [p.first, p.last].filter(Boolean).join(' \u2013 ');
    // MADB prefixes a publisher with its role, [頒布] for the distributor. That is cataloguing
    // notation and not part of the name a reader is being shown.
    const strip = s => String(s || '').replace(/^\s*\[[^\]]*\]\s*/, '');
    const who = [strip(p.publisher), strip(p.imprint)].filter(Boolean).join(' \u00b7 ');
    bits.push(`<div class="dl"><span class="dk">${T('\u5358\u884c\u672c', 'In print')}</span>` +
      `<span class="dv">${esc([p.volumes ? p.volumes + (T(' \u5DFB', ' vol')) : '', who, span]
        .filter(Boolean).join(' \u00b7 '))}</span></div>`);
  });
  const why = r.completed_basis || r.state_basis;
  if (why) bits.push(`<div class="dl"><span class="dk">${T('\u6839\u62E0', 'Basis')}</span>` +
    `<span class="dv">${esc(why)}</span></div>`);
  if (r.id) bits.push(`<div class="dl"><span class="dk">${T('ID', 'ID')}</span>` +
    `<span class="dv mono">${esc(r.id)}</span></div>`);
  return bits.length ? `<div class="detail">${bits.join('')}</div>` : '';
}


// A works row opens its own detail. Delegated, because the list is redrawn on every filter change
// and a handler bound to a row would not survive that.
document.addEventListener('click', ev => {
  const row = ev.target.closest('.rel[data-work]');
  if (!row || ev.target.closest('a')) return;   // a link is a link, not a disclosure
  const nowOpen = !row.classList.contains('here');
  document.querySelectorAll('.rel.here').forEach(n => n.classList.remove('here'));
  if (nowOpen) row.classList.add('here');
  navSync(true);
});


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
  if (el('rel-list').dataset.done === '1') return;
  el('rel-list').dataset.done = '1';
  const rows = [];
  (WORKS.works || []).forEach(w => (w.volumes || []).forEach(v => {
    if (v.published) rows.push({ d: String(v.published), w });
  }));
  rows.sort((a, b) => b.d.localeCompare(a.d) || a.w.title.ja.localeCompare(b.w.title.ja));
  const byMonth = new Map();
  rows.forEach(r => {
    const m = r.d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  });
  el('n-rel').textContent = rows.length;
  el('rel-note').textContent = T(
    '単行本の発売。カタログの日付は月単位。',
    'Volume releases. Catalogued to the month, which is the precision the record carries.');
  const strip = s => String(s || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  el('rel-list').innerHTML = [...byMonth.entries()].map(([m, list]) => {
    const items = list.map(r => {
      const w = r.w;
      // MADB writes a role before each name, [著] and [作画] among them, and joins creators
      // with a slash that survives even when one side is empty. Both are cataloguing
      // notation, not the credit a reader is being shown.
      const people = String(w.creator || '').split('/').map(x => strip(x.trim()))
        .filter(Boolean).join(' / ');
      const who = [strip(w.publisher), strip(w.imprint)].filter(Boolean).join(' · ');
      return `<div class="relv"><div class="relvt">${esc(w.title.ja)}</div>` +
        `<div class="relvm">${esc([people, who].filter(Boolean).join(' · '))}</div></div>`;
    }).join('');
    return `<div class="relmonth"><h3>${esc(m)}</h3>${items}</div>`;
  }).join('');
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
    const wantWork = st.work || '';
    // The works tab addresses a work by its own identifier and has no panel to open, so arriving
    // at one means bringing it into view and saying which row was asked for. Marking it is not
    // decoration: a list of a thousand rows scrolled to an unmarked position leaves a reader
    // guessing which of the visible rows the link meant.
    if (tab === 'ser') {
      document.querySelectorAll('.rel.here').forEach(n => n.classList.remove('here'));
      if (wantWork) {
        const node = document.querySelector(`.rel[data-work="${CSS.escape(wantWork)}"]`);
        if (node) {
          node.classList.add('here');
          node.scrollIntoView({ block: 'center' });
        }
      }
    } else {
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
const BASE = location.pathname.replace(/(?:work\/[A-Za-z0-9_-]+\/?|index\.html)?$/, '');

function workFromPath() {
  const m = location.pathname.match(/\/work\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : '';
}

function readNavUrl() {
  const q = new URLSearchParams(location.search);
  // A path names a work and implies the tab it lives on. Arriving at a pre-rendered stub is
  // exactly this case, and it must reach the same view a click would have produced.
  const onPath = workFromPath();
  if (onPath) return { tab: 'ser', month: '', work: onPath };
  return { tab: q.get('tab') || 'feed', month: q.get('month') || '', work: q.get('work') || '' };
}

document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x =>
    x.setAttribute('aria-selected', String(x === b)));
  ['feed','ser','cat','rel'].forEach(t => el('tab-'+t).hidden = (t !== b.dataset.tab));
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
    const base = { work: r.work, work_en: r.work_en, author: r.author, author_en: r.author_en,
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

  const count = rows.length === src.length
    ? nTotal(rows.length)
    : (LANG === 'en' ? `${rows.length} shown · ${src.length} total`
       : LANG === 'ja' ? `${rows.length} 件表示　·　${src.length} 件`
       : `${rows.length} 件 / shown　·　${src.length} 件 / total`);
  // The count says how many, and nothing about which set: the picker sits directly above it and
  // already carries the period on its own face. This line used to repeat it, which put 2026年7月
  // on two consecutive lines. That was worth doing when the period selector lived at the FOOT of
  // the tab and the count was the only thing near the list naming it.
  el('fcount').textContent = count;
  // The tab badge counts what the tab lists, which is now whichever set is showing.
  el('n-feed').textContent = src.filter(r => r.web !== 'promotional-sample-only').length;
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
  '更新':'Updates', '作品':'Works', '単行本':'Volumes',

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
    const dlabel = d.slice(0, 4) === String(new Date().getFullYear()) ? d.slice(5) : d;
    html += `<div class="cday"><div class="cday-d">${esc(dlabel)} <span class="dow"
      >${esc(dow(d))}</span></div><div class="cday-l">`;
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
          ? `<span class="k k-adv" title="${esc(lead.ahead_n)} chapter(s) of this series sit ahead of the free line, newest ${esc(lead.ahead_ep || '')}: readable now for points. Next free: ${esc(lead.ahead_next_ep || '')} on ${esc(lead.ahead_next_free || '')}. A standing fact about the series, not a count of what this update added.">${esc(T('有料先行'))}</span>` : ''}
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
      html += `<div class="date-h">${esc(d)} <span class="dow">${esc(dow(d))}</span></div>`;
    }
    // The whole row again in the other language, not an English title bolted under a Japanese
    // row: kind, type, access, author, platform and syndication all re-render.
    const inner = bilingual(() => `
      <div class="relhead">
        <span class="t">${workLabel(r)}</span>
        ${kindTag(r)}
        ${redundantType(r) ? '' : `<span class="tag grey">${esc(T(TYPE_JA[r.type] || r.type))}</span>`}
        ${accessTag(r)}
        ${r.access_changed ? `<span class="tag">${esc(r.access_changed)}</span>` : ''}
      </div>
      ${epText(r) ? `<div class="ep">${esc(epText(r))}</div>` : ''}
      ${r.late_discovered && r.feed_date !== r.pub ? `<div class="pubnote" title="published earlier; it reached this list on ${esc(r.feed_date)}">${esc(T('公開'))} ${esc(r.pub)}</div>` : ''}
      <div class="line2">
        ${r.author ? `<span class="meta by">${authorLabel(r)}</span>` : ''}
        ${r.collection && r.collection !== r.work ? `<span class="meta coll" title="an instalment of a collection. The collection's genre label does not necessarily describe every instalment">${esc(workTextOf(r.collection))}</span>` : ''}
        <span class="meta plat"${r.origin_note ? ` title="${esc(r.origin_note)}"` : ''}>${esc(platName(r.plat_name || r.plat))}</span>
        ${r.channel_name ? `<span class="meta chan" title="a channel within ${esc(platName(r.plat_name))}, not a platform of its own">${esc(r.channel_name)}</span>` : ''}
        ${r.syndicated ? `<span class="tag grey" title="${esc(r.origin_note || '')}">${esc(T('転載'))}</span>` : ''}
        ${(r.also_on && r.also_on.length) ? `<span class="meta">${LANG === 'en' ? '· ' : '・'}${esc(L('他', 'also on'))} ${esc(r.also_on.map(platName).join(LANG === 'en' ? ', ' : '、'))}</span>` : ''}
      </div>
      ${caveats(r)}`);
    html += `<div class="rel${NON_STORY.has(r.type) ? ' quiet' : ''}">${
      r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>` : inner
    }</div>`;
  }
  return html;
}

/* ── series ───────────────────────────────────────────────
   Built from data/series.json, which is the FULL chapter history per (work, platform) rather than
   the 60-day feed window. That is the whole point of the tab: a series between arcs is absent from
   the updates feed and perfectly readable, and it is exactly the kind a reader is looking for. */
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
    : (a, b) => (b.latest || '').localeCompare(a.latest || ''));

  el('scount').textContent = nTotal(rows.length);
  el('sempty').hidden = rows.length > 0;
  el('serlist').innerHTML = rows.map(r => {
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
    // Every work carries its identifier, so it has an address. Minted in
    // adapters/identity.py and stable across title corrections, which a slug would not be.
    return `<div class="rel" data-work="${esc(r.id || '')}">
      ${r.url ? `<a class="wlink" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer nofollow">` : ''}
        ${bilingual(() => `<div class="relhead">
          <span class="t">${workLabel(r)}</span>
          <span class="k ${cls}" title="${esc(why)}">${esc(T(lbl))}</span>
          ${acc()}
        </div>
        <div class="ep">${r.state === 'print'
          ? `${(r.print || []).reduce((n, p) => n + (p.volumes || 0), 0)} ${esc(T('巻'))}${
              r.first ? ` · ${esc(r.first)}` : ''}`
          : `${r.chapters}${r.partial ? '+' : ''} ${esc(T('話'))}${
            r.latest ? ` · ${esc(T('最新'))} ${esc(r.latest)}${
              r.latest_ep ? ' ' + esc(phraseOf(r.latest_ep)) : ''}` : ''}`}</div>
        ${r.author ? `<div class="line2"><span class="meta by">${authorLabel(r)}</span></div>` : ''}`)}
      ${r.url ? '</a>' : ''}
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
        }).join('')}</div>${workDetail(r)}
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
  el('list').innerHTML = rows.map(w => `
    <li data-id="${esc(w.id)}">
      <button class="row" aria-expanded="false">
        <span>
          <span class="t">${esc(w.t)}</span>${w.y ? `<span class="yomi">${esc(w.y)}</span>` : ''}
          <br><span class="meta">${esc(credit(w.c) || '—')}</span>
        </span>
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
  d.innerHTML = `
    <h3>初出 / first known publication</h3>
    <p>${esc(fp.date || '—')} · ${esc(fp.venue || '—')}
       <span class="tag grey">${esc(fp.country || '')}</span>
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
  const face = !m ? recentLabel() : m === SOON ? soonLabel()
             : monthLabel(m);      // follows the mode, including 併記
  return face + ' ▾';
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
['sq','sstate','sfree','splat','ssort'].forEach(i => el(i).addEventListener('input', renderSeries));
el('sreset').addEventListener('click', () => resetFilters(RESETS.ser, renderSeries));
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
  cat:  ['q', 'sort', 'filter'],
};

function isOffDefault(e) {
  if (!e) return false;
  return e.tagName === 'SELECT' ? e.value !== e.options[0].value : e.value.trim() !== '';
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
    const btn = el(tab === 'feed' ? 'freset' : tab === 'ser' ? 'sreset' : 'creset');
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
  ids.forEach(id => { const e = el(id); if (!e) return; e.value = e.tagName === 'SELECT' ? e.options[0].value : ''; });
  ids.forEach(id => { if (FACE_PAINTERS[id]) FACE_PAINTERS[id](); });
  saveView(); render(); markActive();
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
  DATA('feed/names.json').catch(() => null),
]).then(([idx, feed, series, meta, names]) => {
  NAMES = names && names.titles ? names : null;
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
}).catch(() => {
  el('fcount').textContent = 'データを読み込めません / could not load data';
});
