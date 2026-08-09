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
                     'sstate', 'sfree', 'splat', 'ssort', 'fvis', 'svis', 'rvis'];
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



