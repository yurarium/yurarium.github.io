/* The status page. Reads data/status.json and renders it; it computes nothing.

   THAT IS THE WHOLE DESIGN. The old page derived its own numbers from whatever files it loaded,
   which is a second producer of a fact this project already has one of, and it disagreed: the
   budget recorded 232 works with no English name while counting the rows gave 236. A page that
   reports the health of the system must not be a source of the numbers it reports.

   TWO READERS. A person wants the sentence. Whoever maintains this wants the rows under it,
   complete and unrounded, because "maintain it" means reading the detail and acting. So every
   section states a count in prose and carries its rows in a block collapsed by default.

   Theme and language are the site's, handled here rather than inherited, so this page behaves like
   any other. The splitter is the same rule app.js uses: text reads "日本語 / English" and the
   preference decides which half survives. */

// app.js stores the language under a bare 'lang' and the theme under a prefixed key. Using the
// prefixed one here meant this page kept the theme a reader had chosen and ignored the language.
const PREF = { theme: 'yurarium.pref.theme', lang: 'lang' };
const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let LANG = get(PREF.lang, 'both');

/* "日本語 / English" split on the first bare slash. Kept identical to app.js's rule so a string
   written once reads correctly on both pages. */
function splitLang(text, lang) {
  const i = String(text).indexOf(' / ');
  if (i < 0) return text;
  const ja = text.slice(0, i), en = text.slice(i + 3);
  return lang === 'ja' ? ja : lang === 'en' ? en : text;
}
const T = (ja, en) => splitLang(`${ja} / ${en}`, LANG);
// A list separator belongs to the sentence it is in. 、 in an English sentence is as wrong as a
// comma would be in a Japanese one, and both were being used whatever the reader had chosen.
const SEP = () => (LANG === 'en' ? ', ' : '、 ');

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
  document.querySelectorAll('[data-theme-set]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode)));
}

function applyLang(lang) {
  LANG = lang;
  document.documentElement.lang = lang === 'en' ? 'en' : 'ja';
  document.querySelectorAll('[data-lang-set]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.langSet === lang)));
  document.querySelectorAll('[data-i18n]').forEach(e => {
    if (e.dataset.orig === undefined) e.dataset.orig = e.textContent.trim();
    e.textContent = splitLang(e.dataset.orig, lang);
  });
  if (window.STATUS) render(window.STATUS);
}

document.querySelectorAll('[data-theme-set]').forEach(b =>
  b.addEventListener('click', () => { set(PREF.theme, b.dataset.themeSet); applyTheme(b.dataset.themeSet); }));
document.querySelectorAll('[data-lang-set]').forEach(b =>
  b.addEventListener('click', () => { set(PREF.lang, b.dataset.langSet); applyLang(b.dataset.langSet); }));

/* ── rendering ─────────────────────────────────────────── */

const table = (cols, rows) =>
  `<table class="st"><thead><tr>${cols.map(c =>
    `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${cols.map(c =>
      `<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const section = (title, lede, detailLabel, detail) => `
  <section class="st-sec">
    <h2>${esc(title)}</h2>
    <p class="st-lede">${lede}</p>
    ${detail ? `<details><summary>${esc(detailLabel)}</summary>${detail}</details>` : ''}
  </section>`;

function lastRun(d) {
  const r = d.last_run || {}, s = d.since_last || {};
  const ch = Object.entries(s.statistics || {});
  const sign = n => (n > 0 ? '+' : '') + n;
  // AN UPDATE IS WHAT CHANGED. The totals are the statistics section's question, not this one's.
  const changed = ch.length
    ? esc(T(`前回のビルド（${s.at ? s.at.slice(0, 10) : '—'}）からの変化: `,
            `Changed since the previous build on ${s.at ? s.at.slice(0, 10) : '—'}: `))
      + ch.map(([k, v]) => `<strong>${esc(sign(v))}</strong> ${esc((d.labels || {})[k] || k.replace(/_/g, ' '))}`).join(SEP())
    : esc(T('前回のビルドから、集計に変化はない。',
            'Nothing the statistics count moved since the previous build.'));
  const lede = changed + `<br><span class="dim">` + esc(T(
    `${r.releases} 件の更新を ${r.platforms} プラットフォームから取り込み、${r.series_rows} 作品に集約。`,
    `It read ${r.releases} releases from ${r.platforms} platforms into ${r.series_rows} works.`))
    + `</span>`;
  const rows = Object.entries(r.collapsed || {}).concat(Object.entries(r.identification || {}))
    .map(([k, v]) => ({ k, v, means: (d.means || {})[k] || '' }));
  return section(T('直近の更新', 'The last update'), lede, T('この回が行ったこと', 'What this run did'),
    table([{ h: T('件数', 'count'), num: true, cell: x => esc(x.v) },
           { h: T('内容', 'what'), cell: x => esc(x.means || x.k) }], rows));
}

function connectors(d) {
  const c = d.connectors || [];
  const stale = c.filter(x => (x.age_days || 0) > 7);
  const empty = c.filter(x => x.empty);
  // WHAT IS, NOT WHAT IS NOT. The sentence states the newest and oldest capture rather than
  // announcing an absence of failures, which is a claim this page cannot yet support.
  const oldest = c[0] || {};
  const mal = c.reduce((n, x) => n + (x.malformed || 0), 0);
  const lede = esc(T(
    `${c.length} 系統のソースを読み込み。最も古い取得は ${oldest.source}（${oldest.age_days} 日前）。`,
    `${c.length} sources were read. The oldest capture is ${oldest.source}, ${oldest.age_days} days old.`))
    + (stale.length ? ' ' + esc(T(`${stale.length} 件が 7 日を超過。`, `${stale.length} are over a week old.`)) : '')
    + (empty.length ? ' ' + esc(T(`${empty.length} 件が空。`, `${empty.length} returned nothing.`)) : '')
    + ' ' + esc(mal
        ? T(`${mal} 行が宣言した形と異なる。`, `${mal} rows differ from the shape declared for their source.`)
        : T('取得した行はいずれも宣言した形どおり。', 'Every captured row matches the shape declared for its source.'))
    + `<br><span class="dim">${esc(T(
        '取得量が前回より落ちた場合の検出には前回との差分が必要で、その台帳は未作成。',
        'Spotting a source that returned less than last time needs a comparison against the previous run, and that ledger does not exist.'))}</span>`;
  return section(T('取得の状態', 'Connector health'), lede, T('ソース一覧', 'Every source'),
    table([{ h: T('ソース', 'source'), cell: x => esc(x.source) },
           { h: T('取得日', 'retrieved'), cell: x => `<span class="${(x.age_days||0) > 7 ? 'st-old' : ''}">${esc(x.retrieved)}</span>` },
           { h: T('日数', 'age'), num: true, cell: x => esc(x.age_days) },
           { h: T('作品', 'works'), num: true, cell: x => esc(x.works) },
           { h: T('行', 'rows'), num: true, cell: x => esc(x.rows) },
           { h: T('相違', 'differs'), num: true,
             cell: x => x.checked_rows ? `<span class="${x.malformed ? 'st-old' : ''}">${esc(x.malformed)}</span>` : '—' }], c));
}

const KIND = {
  decision:    ['判断', 'decision'],
  research:    ['調査', 'research'],
  candidate:   ['候補', 'candidate'],
  debt:        ['負債', 'data debt'],
};

function outstanding(d) {
  const o = (d.outstanding || []).filter(x => x.count);
  const manual = o;
  const lede = esc(T(
    `自動化されていない作業が ${manual.length} 分類。`,
    `${manual.length} categories of work that are not automated.`));
  const detail = manual.map(x => `
    <div class="st-sec" style="margin:.7rem 0">
      <span class="st-kind">${esc(splitLang(KIND[x.kind][0] + ' / ' + KIND[x.kind][1], LANG))}</span>
      <strong>${esc(x.count)}</strong> ${esc(x.what)}
      ${x.rows ? `<div class="st-rows">${Array.isArray(x.rows)
        ? x.rows.map(esc).join(SEP())
        : Object.entries(x.rows).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>')}</div>` : ''}
    </div>`).join('');
  return section(T('残作業', 'Outstanding'), lede, T('分類ごとの内訳', 'By category'),
    detail);
}

function stats(d) {
  const s = d.statistics || {};
  const lede = esc(T(
    `${s.works} 作品、${s.chapters} 話、${s.volumes} 巻。うち ${s.print_only} 作品は単行本のみ。`,
    `${s.works} works, ${s.chapters} chapters, ${s.volumes} volumes. ${s.print_only} of them exist only in print.`));
  const rows = Object.entries(s.states || {}).map(([k, v]) => ({ k: T('状態: ', 'state: ') + k, v }))
    .concat(Object.entries(s.english_basis || {}).map(([k, v]) => ({ k: T('英題の根拠: ', 'English basis: ') + k, v })))
    .concat([{ k: T('識別子を持つ作品', 'works carrying an identifier'), v: s.with_identifier },
             { k: T('単行本のある作品', 'works with a print edition'), v: s.print_works },
             { k: T('単行本のみの作品', 'works published only in volumes'), v: s.print_only }]);
  return section(T('統計', 'Statistics'), lede, T('内訳', 'Breakdown'),
    table([{ h: T('項目', 'measure'), cell: x => esc(x.k) },
           { h: T('件数', 'count'), num: true, cell: x => esc(x.v) }], rows));
}

function gate(d) {
  const g = d.gate || {};
  const inv = g.invariants || [];
  // NO BARE SLASH INSIDE A T() ARGUMENT. splitLang cuts on the first " / ", so "13 / 13" inside the
  // Japanese half was read as the language boundary and the sentence lost its own numbers.
  const lede = esc(T(
    `不変条件は ${inv.length} 件中 ${g.invariants_passing} 件が成立。`,
    `${g.invariants_passing} of ${inv.length} invariants hold.`));
  const cols = [{ h: T('検査', 'check'), cell: x => esc(x.name || '') },
                { h: T('違反', 'violations'), num: true, cell: x => esc(x.violations ?? 0) }];
  return section(T('検査', 'Checks'), lede, T('全項目', 'Every check'),
    table(cols, inv));
}

function render(d) {
  document.getElementById('st').innerHTML =
    lastRun(d) + connectors(d) + outstanding(d) + stats(d) + gate(d) +
    `<p class="dim" style="font-size:.85em">${esc(T('生成: ', 'generated '))}${esc(d.generated)}</p>`;
}

applyTheme(get(PREF.theme, 'auto'));
applyLang(LANG);
fetch('data/status.json', { cache: 'no-cache' })
  .then(r => r.json())
  .then(d => { window.STATUS = d; render(d); })
  .catch(() => {
    document.getElementById('st').textContent =
      T('status.json を読み込めない。', 'status.json could not be loaded.');
  });
