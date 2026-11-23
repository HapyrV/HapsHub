'use strict';
// Hapsplorer web UI. No build step, no dependencies. All text goes through textContent (h()).

const $ = (s) => document.querySelector(s);
const LIST_KEYS = ['cat', 'sub', 'avatar', 'tag', 'rawtag', 'bcat', 'rating', 'feat'];
const SCALAR_KEYS = ['q', 'mode', 'similar', 'shop', 'minprice', 'maxprice', 'minlikes', 'adult', 'status', 'within', 'after', 'before', 'sort', 'seed', 'verified', 'fit'];
const PAGE = 60;
/** The API version this page was written for; the server says which range it accepts (/api/health). */
const API_VERSION = 1;
// Views other than Items keep their own params in the URL (?view=avatars&gender=male), so links stay shareable.
const VIEWS = ['items', 'avatars', 'avatar', 'shops', 'shop', 'bookmarks', 'tiers'];
// Asset-type quick tabs above the item grid: each sets the category/subcategory filters.
const TABS = [
  ['All', {}], ['Outfits', { cat: ['clothing'] }], ['Shoes', { sub: ['clothing--shoes-and-footwear'] }], ['Hair', { cat: ['hair'] }],
  ['Accessories', { cat: ['avatar-accessories'] }], ['Textures', { cat: ['avatar-textures-materials-and-shaders'] }],
  ['Animations', { cat: ['avatar-animations-physbones-gestures-and-gimmicks'] }], ['Tools', { cat: ['avatar-systems-and-tools'] }],
  ['Props', { cat: ['avatar-props'] }], ['Avatars', { cat: ['3d-characters'] }], ['Worlds', { cat: ['world'] }],
];
const WITHIN = [['', 'Any time'], ['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 3 months'], ['365', 'Last year']];
const GENDERS = [['', 'Any'], ['female', 'Female'], ['male', 'Male'], ['unknown', 'Unknown']];
const AVATAR_SORTS = [['assets', 'Most assets'], ['new', 'Most new assets (30 days)'], ['likes', 'Most liked assets'], ['newest', 'Newest avatar'], ['price', 'Price: low to high'], ['name', 'Name'], ['random', 'Random']];
const SHOP_SORTS = [['items', 'Most items'], ['likes', 'Most liked'], ['newest', 'Newest item'], ['name', 'Name']];
const FEATURE_NAMES = { quest: 'Quest', liltoon: 'lilToon', poiyomi: 'Poiyomi', vrcfury: 'VRCFury', 'modular-avatar': 'Modular Avatar', 'face-tracking': 'Face tracking', mochifitter: 'MochiFitter' };
// VRCatalogue's "Adult Content" levels. The choice is remembered in this browser (a setting), and shows in the URL.
const ADULT_MODES = [['safe', 'SFW/Safe only'], ['include', 'All content'], ['suggestive', 'Suggestive'], ['adult_only', 'Adult only']];
const RATING_NAMES = { sfw: 'Safe', suggestive: 'Suggestive', nsfw: 'NSFW', unknown: 'Unrated' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('hx.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem('hx.' + k, JSON.stringify(v)); },
};

const state = {
  f: {}, page: 0, total: 0, loading: false, done: false, items: [], facets: null, meta: null,
  rates: { JPY: 1 }, active: -1, reqId: 0, pageReq: 0, view: 'items', vp: {}, searched: null,
  dl: null, // the list the drawer steps through: { list, box }
  prevVisit: store.get('lastVisit', 0), owned: store.get('owned', {}), myAvatars: store.get('myAvatars', []),
  hiddenShops: store.get('hiddenShops', []), // [{ s: subdomain, n: name }]
  hiddenWords: store.get('hiddenWords', []),
  bookmarks: store.get('bookmarks', []), // item ids, newest first
  shopMarks: store.get('shopMarks', []), // [{ s: subdomain, n: name }]
};
store.set('lastVisit', Math.floor(Date.now() / 1000));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---------- API ----------
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { showLogin(); throw new Error('auth'); }
  if (res.status === 503) {
    const j = await res.json().catch(() => ({}));
    if (j.offline) { showOffline(j); throw new Error('offline'); }
  }
  if (res.headers.get('X-Hapsplorer-Offline')) notice('The server is offline: showing results saved earlier. They may be out of date.');
  if (res.status === 429) throw new Error('Too many requests, wait a moment.');
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json();
}

// ---------- URL state ----------
/** Reads the view and its params from the URL. Item filters are kept in memory while another view is open. */
function readUrl() {
  const p = new URLSearchParams(location.search);
  const v = p.get('view');
  state.view = VIEWS.includes(v) ? v : 'items';
  if (state.view !== 'items') {
    state.vp = Object.fromEntries([...p].filter(([k, x]) => k !== 'view' && x));
    return;
  }
  const f = {};
  for (const k of LIST_KEYS) { const v = p.getAll(k).flatMap((x) => x.split(',')).filter(Boolean); if (v.length) f[k] = [...new Set(v)]; }
  for (const k of SCALAR_KEYS) if (p.get(k)) f[k] = p.get(k);
  state.f = f;
}
/** Item search params plus this browser's hidden shops and words (sent so counts and paging stay right; never in the URL). */
/** With one avatar picked, show what was made for it (listed for at most this many avatars) unless "Everything that fits" is chosen. */
const MADE_FOR_MAX = 3;
function madeForOn(f = state.f) { return f.avatar?.length === 1 && f.fit !== 'all'; }
function apiParams(f, page) {
  const p = toParams(f, page);
  p.delete('fit');
  if (madeForOn(f)) p.set('maxav', String(MADE_FOR_MAX));
  hideParams(p, f.shop);
  return p;
}
function hideParams(p, keepShop) {
  const shops = state.hiddenShops.map((x) => x.s).filter((s) => s !== keepShop);
  if (shops.length) p.set('hide_shops', shops.join(','));
  if (state.hiddenWords.length) p.set('hide', state.hiddenWords.join(','));
  return p;
}
/** Params for avatar/shop pages: the adult setting of this browser plus the hide lists. */
function viewerParams(extra = {}) {
  const p = new URLSearchParams(extra);
  const adult = store.get('adult', 'safe');
  if (adult !== 'safe') p.set('adult', adult);
  return hideParams(p, extra.shop);
}
function toParams(f, page) {
  const p = new URLSearchParams();
  for (const k of SCALAR_KEYS) if (f[k] != null && f[k] !== '') p.set(k, f[k]);
  for (const k of LIST_KEYS) if (f[k]?.length) p.set(k, f[k].join(','));
  if (page) { p.set('page', page); p.set('size', PAGE); }
  return p;
}
function writeUrl(push) {
  const s = state.view === 'items' ? toParams(state.f).toString()
    : new URLSearchParams({ view: state.view, ...Object.fromEntries(Object.entries(state.vp).filter(([, v]) => v)) }).toString();
  const url = s ? '?' + s : location.pathname;
  if (url !== location.search) (push ? history.pushState : history.replaceState).call(history, null, '', url);
}

// ---------- views ----------
/** Opens a view (items, avatars, avatar, shops, shop) with its params. */
function go(view, vp = {}, push = true) {
  state.view = view; state.vp = vp;
  writeUrl(push);
  render();
  scrollTo(0, 0);
}
function render() {
  const v = state.view;
  document.body.dataset.view = v;
  document.title = 'Hapsplorer';
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v || b.dataset.view === v + 's'));
  $('#itemsView').hidden = v !== 'items';
  $('#pageView').hidden = v === 'items';
  sb.itemsBox.hidden = v !== 'items';
  sb.avatarsBox.hidden = v !== 'avatars';
  if (v !== 'items') closeDrawer();
  state.pageMore = null;
  if (v === 'items') {
    renderTabs();
    // Coming back from another view: keep the loaded grid when the filters didn't change.
    if (state.searched !== apiParams(state.f).toString()) search();
    return;
  }
  ({ avatars: renderAvatarsView, avatar: renderAvatarPage, shops: renderShopsView, shop: renderShopPage, bookmarks: renderBookmarksView, tiers: renderTiersView })[v]();
}

// ---------- filters ----------
function setAdult(v) {
  store.set('adult', v);
  setFilter('adult', v === 'safe' ? null : v);
}
function setFilter(k, v, push = true) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete state.f[k]; else state.f[k] = v;
  if (k === 'sort' && v === 'random' && !state.f.seed) state.f.seed = String(Math.floor(Math.random() * 1e6));
  if (k === 'sort' && v !== 'random') delete state.f.seed;
  // Relevance only means something for a meaning search or "more like this".
  if ((k === 'mode' || k === 'similar' || k === 'q') && state.f.sort === 'relevance' && !hasRelevance()) delete state.f.sort;
  showItems(push);
}
/** Writes the URL and shows the item grid for the current filters (switching to the Items view if needed). */
function showItems(push = true) {
  const from = state.view;
  state.view = 'items';
  writeUrl(push || from !== 'items');
  if (from !== 'items') render(); else { renderTabs(); search(); }
}
/** Items view with fresh filters (the adult setting is kept). */
function browse(f) {
  state.f = { ...f, ...(state.f.adult ? { adult: state.f.adult } : {}) };
  showItems(true);
  scrollTo(0, 0);
}
function toggleIn(k, v) {
  const cur = state.f[k] || [];
  setFilter(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
}
function hasRelevance(f = state.f) { return !!f.similar || (f.mode === 'meaning' && !!f.q); }
function sameSet(a, b) { return a.length === b.length && a.every((x) => b.includes(x)); }

// ---------- search ----------
async function search() {
  const id = ++state.reqId;
  pending.clear();
  state.page = 0; state.done = false; state.items = []; state.active = -1; state.dl = null;
  state.searched = apiParams(state.f).toString();
  // Keep the old cards (dimmed after a moment) until the new ones arrive, so the page doesn't blink empty.
  $('#grid').classList.add('stale');
  await loadMore(id, true);
}

async function loadMore(id = state.reqId, first = false) {
  if (state.loading && !first) return;
  if (state.done) return;
  state.loading = true;
  const page = state.page + 1;
  try {
    const res = await api('/api/search?' + apiParams(state.f, page));
    if (id !== state.reqId) return;
    state.page = page;
    state.total = res.total;
    const start = state.items.length;
    state.items.push(...res.items);
    state.done = state.items.length >= res.total || res.items.length === 0;
    if (first) { clearStale(); state.facets = res.facets; renderSidebar(); renderChips(); renderTabs(); renderWarnings(res.warnings); }
    $('#count').textContent = `${res.total.toLocaleString()} items · ${Math.round(res.tookMs)} ms`;
    $('#empty').hidden = res.total > 0;
    appendCards(res.items, start);
  } catch (e) {
    if (first && id === state.reqId) clearStale();
    if (e.message !== 'auth') renderWarnings([e.message]);
  } finally {
    if (id === state.reqId) state.loading = false;
  }
  // keep filling until the sentinel is off-screen
  if (id === state.reqId && !state.done && sentinelVisible()) loadMore(id);
}
function clearStale() { $('#grid').replaceChildren(); $('#grid').classList.remove('stale'); }
function sentinelVisible() { const r = $('#sentinel').getBoundingClientRect(); return r.top < innerHeight + 600; }

function renderWarnings(w) {
  const el = $('#warnings');
  el.hidden = !w?.length;
  el.textContent = (w || []).join(' ');
}

// ---------- cards ----------
/** BOOTH lists an item at its cheapest variation; true when that is below the price we show. */
const cheaper = (it) => it.listPriceJpy != null && it.priceJpy != null && it.listPriceJpy < it.priceJpy;
const cheapNote = (it) => `cheapest${it.listPriceJpy === 0 ? ': free' : ' ' + money(it.listPriceJpy)}`;

function money(jpy) {
  if (jpy == null) return '–';
  if (jpy === 0) return 'Free';
  const cur = store.get('currency', 'JPY'), rate = state.rates[cur] ?? 1;
  const c = state.rates[cur] ? cur : 'JPY';
  // Each currency's usual digits (JPY, KRW, VND, CLP… none; most others 2).
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(jpy * (c === 'JPY' ? 1 : rate));
}
function isNew(it) { return state.prevVisit && it.published && Date.parse(it.published) / 1000 > state.prevVisit; }

function appendCards(items, start) {
  const grid = $('#grid'), frag = document.createDocumentFragment();
  items.forEach((it, k) => { frag.append(card(it, start + k)); if (!it.title && it.status !== 'deleted') pending.add(start + k); });
  grid.append(frag);
  schedulePoll();
}

// Cards without BOOTH data yet: the server fetches them (1/s) and we poll for the results.
const pending = new Set();
let pollTimer = null;
function schedulePoll() { if (!pollTimer && pending.size) pollTimer = setTimeout(pollPending, 4000); }
async function pollPending() {
  pollTimer = null;
  const reqId = state.reqId;
  const idx = [...pending].filter((i) => i < state.items.length).slice(0, 120);
  if (!idx.length) { pending.clear(); return; }
  try {
    const fresh = await api('/api/cards?ids=' + idx.map((i) => state.items[i].id).join(','));
    if (reqId !== state.reqId) return;
    const byId = new Map(fresh.map((x) => [x.id, x]));
    for (const i of idx) {
      const f = byId.get(state.items[i].id);
      if (f && (f.title || f.status === 'deleted')) {
        state.items[i] = f; pending.delete(i);
        $('#grid').querySelector(`.card[data-i="${i}"]`)?.replaceWith(card(f, i));
      }
    }
  } catch { /* try again later */ }
  schedulePoll();
}

function gallery(images, thumb) {
  const hero = h('div', { class: 'hero' });
  const list = images?.length ? images.slice(0, 40) : thumb ? [{ thumb, full: thumb }] : [];
  const show = (i) => hero.replaceChildren(h('img', { src: list[i].thumb, alt: '', referrerpolicy: 'no-referrer', title: 'View full size', onclick: () => openViewer(list, i) }));
  if (list.length) show(0); else hero.append(h('span', { text: 'No images yet' }));
  if (list.length < 2) return hero;
  return h('div', {}, hero, h('div', { class: 'strip' }, list.map((im, i) =>
    h('img', { src: im.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onclick: () => show(i) }))));
}
/** Full-size image viewer inside the app (left/right step through the item's images; Esc or a click outside closes). */
function openViewer(images, start) {
  let i = start;
  const img = h('img', { alt: '', referrerpolicy: 'no-referrer' });
  const count = h('span', { class: 'count' });
  const orig = h('a', { class: 'orig', target: '_blank', rel: 'noopener noreferrer', text: 'Original ↗', title: 'Open the original image in a new tab' });
  const show = () => { img.src = images[i].full || images[i].thumb; orig.href = img.src; count.textContent = images.length > 1 ? `${i + 1} / ${images.length}` : ''; };
  const step = (d) => { i = (i + d + images.length) % images.length; show(); };
  const arrow = (cls, text, d) => h('button', { class: cls, text, title: d < 0 ? 'Previous (←)' : 'Next (→)', onclick: (ev) => { ev.stopPropagation(); step(d); } });
  const v = h('dialog', { class: 'viewer', onclose: () => v.remove(),
    onclick: (ev) => { if (ev.target === v || ev.target.classList.contains('stage')) v.close(); },
    // keys stay inside the viewer (Esc must not also close the drawer)
    onkeydown: (ev) => { ev.stopPropagation(); if (ev.key === 'ArrowLeft') step(-1); else if (ev.key === 'ArrowRight') step(1); } },
    h('div', { class: 'stage' }, img),
    images.length > 1 ? [arrow('prev', '‹', -1), arrow('next', '›', 1)] : null,
    h('div', { class: 'bar' }, count, orig, h('button', { text: '✕', title: 'Close (Esc)', onclick: () => v.close() })));
  document.body.append(v);
  show();
  v.showModal();
}
function card(it, index, list = state.items, box = $('#grid')) {
  const badges = h('div', { class: 'badges' },
    isNew(it) && h('span', { class: 'badge new', text: 'NEW' }),
    state.owned[it.id] && h('span', { class: 'badge owned', text: 'OWNED' }),
    it.adult && h('span', { class: 'badge adult', text: 'R-18' }),
    it.status !== 'ok' && h('span', { class: 'badge', text: it.status }));
  const thumb = h('div', { class: 'thumb' },
    it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
             : h('div', { class: 'ph', text: it.boothCategory || 'BOOTH item' }),
    badges, bmButton(it.id));
  return h('article', { class: 'card', tabindex: '0', 'data-i': index, 'data-id': it.id, onclick: () => openItem(index, list, box),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openItem(index, list, box); } },
    thumb,
    h('div', { class: 'body' },
      h('div', { class: 'title', translate: 'yes', text: it.title || `#${it.id}` }),
      h('div', { class: 'shop', text: it.shop || '' }),
      h('div', { class: 'meta' },
        h('span', { class: 'price', title: it.priceReason ? `Price: ${it.priceReason}` : null }, money(it.priceJpy),
          cheaper(it) ? h('span', { class: 'cheap', text: cheapNote(it) }) : null),
        h('span', { class: 'likes', text: `♥ ${it.likes.toLocaleString()}` })),
      it.features.length ? h('div', { class: 'feats' }, it.features.map((f) => h('span', { class: 'feat', text: FEATURE_NAMES[f] || f }))) : null));
}

// The top bar wraps to a second row when the window is narrow; the sticky sidebar and drawer sit below it.
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--top-h', `${Math.ceil(e.target.getBoundingClientRect().height)}px`)).observe(document.querySelector('header.top'));

// ---------- sidebar ----------
const sb = {};
function buildSidebar() {
  const s = $('#sidebar');
  sb.cats = h('div'); sb.avatars = h('div'); sb.tagSuggest = h('div', { class: 'suggest', hidden: true });
  sb.ratings = h('div'); sb.feats = h('div'); sb.bcats = h('div');
  sb.avatarFind = h('input', { class: 'find', type: 'search', placeholder: 'Find an avatar…', oninput: () => renderAvatars() });
  sb.tagFind = h('input', { class: 'find', type: 'search', placeholder: 'Add a tag…', oninput: debounce(suggestTags, 180) });
  sb.verified = h('input', { type: 'checkbox', onchange: (e) => setFilter('verified', e.target.checked ? '1' : null) });
  sb.minp = h('input', { type: 'number', min: 0, placeholder: 'Min', onchange: priceChanged });
  sb.maxp = h('input', { type: 'number', min: 0, placeholder: 'Max', onchange: priceChanged });
  sb.priceLabel = h('span');
  sb.likes = h('select', { onchange: (e) => setFilter('minlikes', e.target.value || null) },
    [['', 'Any'], ['10', '10+'], ['50', '50+'], ['100', '100+'], ['500', '500+'], ['1000', '1,000+']].map(([v, t]) => h('option', { value: v, text: t })));
  sb.after = h('input', { type: 'date', onchange: (e) => setFilter('after', e.target.value || null) });
  sb.before = h('input', { type: 'date', onchange: (e) => setFilter('before', e.target.value || null) });
  sb.adult = h('select', { title: 'Adult content (remembered in this browser)', onchange: (e) => setAdult(e.target.value) },
    ADULT_MODES.map(([v, t]) => h('option', { value: v, text: t })));
  sb.status = h('select', { onchange: (e) => setFilter('status', e.target.value === 'ok' ? null : e.target.value) },
    [['ok', 'Available'], ['delisted', 'Delisted'], ['all', 'All']].map(([v, t]) => h('option', { value: v, text: t })));

  sb.within = h('select', { onchange: (e) => setFilter('within', e.target.value || null) }, WITHIN.map(([v, t]) => h('option', { value: v, text: t })));
  sb.hideWord = h('input', { class: 'find', type: 'search', placeholder: 'Hide items with a word…', title: 'Press Enter. Items whose title or tags contain it are hidden (this browser only).',
    onkeydown: (e) => { if (e.key === 'Enter') { addHiddenWord(e.target.value); e.target.value = ''; } } });
  sb.hidden = h('div');
  sb.itemsBox = h('div', { class: 'items-box' },
    h('div', { class: 'sheet-head mobile-only' }, h('b', { text: 'Filters' }), h('button', { class: 'primary', text: 'Show items', onclick: () => openFilters(false) })),
    h('div', { class: 'sb-cat' }, h('h3', {}, 'Category'), sb.cats),
    h('div', { class: 'sb-avatar' },
      h('h3', {}, 'Avatar', h('button', { onclick: openAvatarsDialog, text: 'My avatars ✎' })), sb.avatarFind, sb.avatars,
      h('label', { class: 'row' }, sb.verified, 'Only checked matches')),
    h('h3', {}, 'Tags'), sb.tagFind, sb.tagSuggest,
    h('h3', {}, sb.priceLabel), h('div', { class: 'row' }, sb.minp, '–', sb.maxp),
    h('h3', {}, 'Likes'), h('div', { class: 'row' }, sb.likes),
    h('h3', {}, 'Rating'), sb.ratings,
    h('h3', {}, 'Works with'), sb.feats,
    h('h3', {}, 'Released'), h('div', { class: 'row' }, sb.within),
    h('div', { class: 'dates' }, h('label', {}, h('span', { text: 'From' }), sb.after), h('label', {}, h('span', { text: 'To' }), sb.before)),
    h('h3', {}, 'Adult content & status'), h('div', { class: 'row' }, sb.adult, sb.status),
    h('h3', {}, 'Hide'), sb.hideWord, sb.hidden,
    h('h3', {}, 'BOOTH category'), sb.bcats);
  sb.avatarsBox = buildAvatarFilters();
  s.replaceChildren(sb.itemsBox, sb.avatarsBox);
}

// ---------- hidden shops / words (this browser only) ----------
function renderHidden() {
  const x = (label, title, onclick) => h('button', { class: 'chip', title, onclick }, label, ' ×');
  sb.hidden.replaceChildren(
    state.hiddenWords.length ? h('div', { class: 'chips' }, state.hiddenWords.map((w) => x(w, 'Show items with this word again', () => removeHiddenWord(w)))) : '',
    state.hiddenShops.length ? h('details', { class: 'hidden-shops' }, h('summary', { text: `${state.hiddenShops.length} hidden shop${state.hiddenShops.length > 1 ? 's' : ''}` }),
      h('div', { class: 'chips' }, state.hiddenShops.map((sh) => x(sh.n || sh.s, 'Show this shop again', () => toggleHiddenShop(sh.s, sh.n))))) : '',
    !state.hiddenWords.length && !state.hiddenShops.length ? h('p', { class: 'hint', text: 'Hide shops from their shop page.' }) : '');
}
function hiddenChanged() {
  renderHidden();
  if (state.view === 'items') search(); else render();
}
function addHiddenWord(w) {
  w = w.trim().replace(/,/g, ' ');
  if (!w || state.hiddenWords.some((x) => x.toLowerCase() === w.toLowerCase())) return;
  state.hiddenWords = [...state.hiddenWords, w];
  store.set('hiddenWords', state.hiddenWords);
  hiddenChanged();
}
function removeHiddenWord(w) {
  state.hiddenWords = state.hiddenWords.filter((x) => x !== w);
  store.set('hiddenWords', state.hiddenWords);
  hiddenChanged();
}
const isHiddenShop = (sub) => state.hiddenShops.some((x) => x.s === sub);
function toggleHiddenShop(sub, name, rerender = true) {
  state.hiddenShops = isHiddenShop(sub) ? state.hiddenShops.filter((x) => x.s !== sub) : [...state.hiddenShops, { s: sub, n: name }];
  store.set('hiddenShops', state.hiddenShops);
  if (rerender) hiddenChanged(); else renderHidden();
}

// ---------- asset-type tabs ----------
function renderTabs() {
  const f = state.f, fc = state.facets;
  const catN = Object.fromEntries((fc?.categories || []).map((c) => [c.key, c.count]));
  const subN = Object.fromEntries((fc?.subcategories || []).map((c) => [c.key, c.count]));
  $('#tabs').replaceChildren(...TABS.map(([label, t]) => {
    const on = sameSet(f.cat || [], t.cat || []) && sameSet(f.sub || [], t.sub || []);
    const n = t.cat ? catN[t.cat[0]] : t.sub ? subN[t.sub[0]] : null;
    return h('button', { class: on ? 'on' : '', title: n != null ? `${n.toLocaleString()} items` : null,
      onclick: () => { if (t.cat) state.f.cat = [...t.cat]; else delete state.f.cat; if (t.sub) state.f.sub = [...t.sub]; else delete state.f.sub; showItems(true); } }, label);
  }));
}

function facetRow({ label, count, sel, onclick, cls = '', extra = null }) {
  return h('div', { class: `facet ${cls} ${sel ? 'sel' : ''} ${count === 0 && !sel ? 'zero' : ''}`, onclick }, extra, h('span', { text: label }), h('span', { class: 'n', text: count?.toLocaleString() ?? '' }));
}

function renderSidebar() {
  const f = state.f, fc = state.facets, meta = state.meta;
  if (!fc || !meta) return;
  renderCats();
  renderAvatars();
  sb.ratings.replaceChildren(...fc.ratings.map((r) => facetRow({ label: RATING_NAMES[r.key] || r.key, count: r.count, sel: r.selected, onclick: () => toggleIn('rating', r.key) })));
  sb.feats.replaceChildren(...fc.features.map((r) => facetRow({ label: FEATURE_NAMES[r.key] || r.key, count: r.count, sel: r.selected, onclick: () => toggleIn('feat', r.key) })));
  const bc = fc.boothCategories, showAll = sb.bcatsAll;
  sb.bcats.replaceChildren(...(showAll ? bc : bc.slice(0, 12)).map((r) => facetRow({ label: r.name, count: r.count, sel: r.selected, onclick: () => toggleIn('bcat', r.key) })),
    bc.length > 12 ? h('button', { class: 'more', text: showAll ? 'Show fewer' : `Show all ${bc.length}`, onclick: () => { sb.bcatsAll = !showAll; renderSidebar(); } }) : '');
  // inputs
  sb.verified.checked = f.verified === '1';
  const cur = store.get('currency', 'JPY'), rate = state.rates[cur] ?? 1;
  sb.priceLabel.textContent = `Price (${state.rates[cur] ? cur : 'JPY'})`;
  sb.minp.value = f.minprice ? round(f.minprice * rate) : '';
  sb.maxp.value = f.maxprice ? round(f.maxprice * rate) : '';
  sb.likes.value = f.minlikes || '';
  sb.after.value = f.after || ''; sb.before.value = f.before || ''; sb.within.value = f.within || '';
  renderHidden();
  sb.adult.value = f.adult || 'safe'; sb.status.value = f.status || 'ok';
  if (document.activeElement !== $('#q')) $('#q').value = f.q || '';
  const rel = $('#sort option[value="relevance"]');
  rel.hidden = !hasRelevance(f);
  $('#sort').value = f.sort || (hasRelevance(f) ? 'relevance' : 'popular');
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', (b.dataset.mode || '') === (f.mode || '')));
  $('#myAvatarsBtn').classList.toggle('on', state.myAvatars.length > 0 && sameSet(f.avatar || [], state.myAvatars));
}
/** Category headers only open and close (no search); the rows inside filter. "All ..." picks the whole category. */
function renderCats() {
  const f = state.f, fc = state.facets, meta = state.meta;
  const subCounts = Object.fromEntries(fc.subcategories.map((x) => [x.key, x.count]));
  // Open at first: the categories the URL already filters on. After that only the headers open and close them.
  sb.openCats ??= new Set(meta.categories.filter((m) => f.cat?.includes(m.key) || m.subcategories.some((s) => f.sub?.includes(s.key))).map((m) => m.key));
  sb.cats.replaceChildren(...fc.categories.flatMap((c) => {
    const mc = meta.categories.find((m) => m.key === c.key);
    const catSel = !!f.cat?.includes(c.key), nSel = (mc?.subcategories || []).filter((s) => f.sub?.includes(s.key)).length;
    const open = sb.openCats.has(c.key);
    const head = h('div', { class: `facet cat-head ${c.count === 0 && !catSel && !nSel ? 'zero' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': String(open),
      onclick: () => toggleCat(c.key), onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleCat(c.key); } } },
      h('span', { class: 'caret', text: open ? '▾' : '▸' }), h('span', { text: c.name }),
      catSel || nSel ? h('span', { class: 'dot', title: catSel ? 'Whole category selected' : `${nSel} selected` }) : null,
      h('span', { class: 'n', text: c.count?.toLocaleString() ?? '' }));
    if (!open || !mc) return [head];
    const rows = [head, facetRow({ label: `All ${c.name}`, count: c.count, sel: catSel, cls: 'sub all', onclick: () => toggleIn('cat', c.key) })];
    // Keyword groups (e.g. Swimsuit) are dropdowns: closed at first, open when one of their rows is selected.
    const groups = new Map(); // group name (or '' for none) -> visible subcategories, in first-seen order
    for (const s of mc.subcategories) {
      const n = subCounts[s.key] ?? 0, ssel = f.sub?.includes(s.key);
      if (!(n > 0 || ssel)) continue;
      const g = s.group || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ s, n, ssel });
    }
    const row = ({ s, n, ssel }) => facetRow({ label: s.name, count: n, sel: ssel, cls: s.group ? 'sub in-group' : 'sub', onclick: () => toggleIn('sub', s.key) });
    let afterGroup = false;
    for (const [g, subs] of groups) {
      if (!g) { if (afterGroup) rows.push(h('div', { class: 'subgroup end' })); rows.push(...subs.map(row)); afterGroup = false; continue; }
      const gk = `${c.key}/${g}`, nSelG = subs.filter((x) => x.ssel).length;
      sb.openGroups ??= new Set();
      if (nSelG && !sb.seenGroups?.has(gk)) { sb.openGroups.add(gk); (sb.seenGroups ??= new Set()).add(gk); }
      const gOpen = sb.openGroups.has(gk);
      const toggle = () => { if (!sb.openGroups.delete(gk)) sb.openGroups.add(gk); renderCats(); };
      rows.push(h('div', { class: 'facet subgroup-head', role: 'button', tabindex: '0', 'aria-expanded': String(gOpen), onclick: toggle,
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } } },
        h('span', { class: 'caret', text: gOpen ? '▾' : '▸' }), h('span', { text: g }),
        nSelG ? h('span', { class: 'dot', title: `${nSelG} selected` }) : null));
      if (gOpen) rows.push(...subs.map(row));
      afterGroup = true;
    }
    return rows;
  }));
}
function toggleCat(key) {
  if (!sb.openCats.delete(key)) sb.openCats.add(key);
  renderCats();
}
function round(x) { return Math.round(x * 100) / 100; }
function priceChanged() {
  const cur = store.get('currency', 'JPY'), rate = state.rates[cur] ?? 1;
  const toJpy = (v) => (v === '' ? null : String(Math.round(Number(v) / rate)));
  state.f.minprice = toJpy(sb.minp.value); state.f.maxprice = toJpy(sb.maxp.value);
  if (!state.f.minprice) delete state.f.minprice;
  if (!state.f.maxprice) delete state.f.maxprice;
  showItems(true);
}

function renderAvatars() {
  const fc = state.facets, meta = state.meta;
  if (!fc || !meta) return;
  const find = sb.avatarFind.value.trim().toLowerCase();
  const counts = Object.fromEntries(fc.avatars.map((a) => [a.key, a.count]));
  const selected = state.f.avatar || [];
  let list;
  if (find) list = meta.avatars.filter((a) => a.name.toLowerCase().includes(find) || a.key.includes(find) || (a.nameJa || '').includes(find)).slice(0, 40);
  else {
    const top = fc.avatars.map((a) => meta.avatars.find((m) => m.key === a.key)).filter(Boolean);
    const mine = state.myAvatars.map((k) => meta.avatars.find((m) => m.key === k)).filter(Boolean);
    list = [...new Map([...mine, ...top].map((a) => [a.key, a])).values()].slice(0, 25);
  }
  for (const k of selected) if (!list.some((a) => a.key === k)) { const m = meta.avatars.find((a) => a.key === k); if (m) list.unshift(m); }
  sb.avatars.replaceChildren(...list.map((a) => {
    const mine = state.myAvatars.includes(a.key);
    const star = h('button', { class: `star ${mine ? 'on' : ''}`, title: mine ? 'Remove from my avatars' : 'Add to my avatars', text: mine ? '★' : '☆',
      onclick: (e) => { e.stopPropagation(); toggleMyAvatar(a.key); } });
    return facetRow({ label: a.name, count: counts[a.key] ?? (find ? null : 0), sel: selected.includes(a.key), onclick: () => toggleIn('avatar', a.key), extra: star });
  }));
}

function toggleMyAvatar(key) {
  const wasOn = state.myAvatars.length && sameSet(state.f.avatar || [], state.myAvatars);
  state.myAvatars = state.myAvatars.includes(key) ? state.myAvatars.filter((k) => k !== key) : [...state.myAvatars, key];
  store.set('myAvatars', state.myAvatars);
  if (wasOn) {
    if (state.view === 'items') return setFilter('avatar', [...state.myAvatars]);
    if (state.myAvatars.length) state.f.avatar = [...state.myAvatars]; else delete state.f.avatar;   // the Items view re-searches when it is opened again
  }
  renderSidebar();
}

async function suggestTags() {
  const q = sb.tagFind.value.trim();
  if (!q) { sb.tagSuggest.hidden = true; return; }
  try {
    const r = await api('/api/tags?q=' + encodeURIComponent(q));
    const rows = [
      ...r.unified.map((t) => facetRow({ label: t.name, count: t.items, onclick: () => pickTag('tag', t.key) })),
      ...r.raw.map((t) => facetRow({ label: '#' + t.name, count: t.items, onclick: () => pickTag('rawtag', t.key) })),
    ];
    sb.tagSuggest.replaceChildren(...rows);
    sb.tagSuggest.hidden = rows.length === 0;
  } catch { /* ignore */ }
}
function pickTag(k, v) { sb.tagFind.value = ''; sb.tagSuggest.hidden = true; if (!(state.f[k] || []).includes(v)) toggleIn(k, v); }

// ---------- chips ----------
function renderChips() {
  const f = state.f, meta = state.meta, chips = [];
  const name = {
    cat: (k) => meta.categories.find((c) => c.key === k)?.name,
    sub: (k) => meta.categories.flatMap((c) => c.subcategories).find((s) => s.key === k)?.name,
    avatar: (k) => meta.avatars.find((a) => a.key === k)?.name,
    rating: (k) => RATING_NAMES[k], feat: (k) => FEATURE_NAMES[k], rawtag: (k) => '#' + k,
  };
  const label = { cat: 'Category', sub: 'Type', avatar: 'Avatar', tag: 'Tag', rawtag: 'Tag', bcat: 'BOOTH', rating: 'Rating', feat: 'Works with' };
  for (const k of LIST_KEYS) for (const v of f[k] || [])
    chips.push(h('button', { class: 'chip', title: 'Remove', onclick: () => toggleIn(k, v) }, h('b', { text: label[k] + ':' }), (name[k]?.(v)) || v, ' ×'));
  const scalar = {
    q: (v) => `${state.f.mode === 'meaning' ? 'Meaning: ' : ''}“${v}”`, similar: (v) => `Like #${v}`, shop: (v) => `Shop: ${v}`, minprice: (v) => `From ${money(+v)}`, maxprice: (v) => `Up to ${money(+v)}`,
    minlikes: (v) => `♥ ${v}+`, within: (v) => (WITHIN.find(([k]) => k === v) || [, `Last ${v} days`])[1], after: (v) => `After ${v}`, before: (v) => `Before ${v}`, verified: () => 'Checked matches only',
    adult: (v) => (ADULT_MODES.find(([k]) => k === v) || [, v])[1], status: (v) => (v === 'all' ? 'All statuses' : 'Delisted'),
  };
  for (const [k, fmt] of Object.entries(scalar)) if (f[k]) chips.push(h('button', { class: 'chip', title: 'Remove', onclick: () => (k === 'adult' ? setAdult('safe') : setFilter(k, null)) }, fmt(f[k]), ' ×'));
  if (chips.length > 1) chips.push(h('button', { class: 'chip clear', text: 'Clear all', onclick: () => { state.f = { ...(f.sort ? { sort: f.sort, seed: f.seed } : {}), ...(f.adult ? { adult: f.adult } : {}) }; showItems(true); } }));
  $('#chips').replaceChildren(...chips);
  renderHint();
}
/** Under the result count: "made for this avatar" switch, or turning a search for an avatar's name into the avatar filter. */
function renderHint() {
  const f = state.f, meta = state.meta, box = $('#hint');
  if (!box || !meta) return;
  const parts = [];
  if (f.avatar?.length === 1) {
    const name = meta.avatars.find((a) => a.key === f.avatar[0])?.name || f.avatar[0];
    const pick = (fit) => setFilter('fit', fit);
    parts.push(h('div', { class: 'seg fit', role: 'group', 'aria-label': 'Which items' },
      h('button', { class: madeForOn() ? 'on' : '', title: `Items listed for ${MADE_FOR_MAX} avatars or fewer`, text: `Made for ${name}`, onclick: () => pick(null) }),
      h('button', { class: madeForOn() ? '' : 'on', title: 'Also items that list many avatars (poses, accessories, textures)', text: 'Everything that fits', onclick: () => pick('all') })));
  }
  const q = (f.q || '').trim().toLowerCase();
  if (q && f.mode !== 'meaning' && !f.avatar?.length) {
    const av = meta.avatars.find((a) => a.name.toLowerCase() === q || a.key === q || (a.nameJa || '') === f.q.trim());
    if (av) parts.push(h('button', { class: 'pill suggest-avatar', onclick: () => { delete state.f.q; delete state.f.fit; state.f.avatar = [av.key]; showItems(true); } },
      `${av.name} is an avatar: show items for ${av.name}`));
  }
  box.replaceChildren(...parts);
  box.hidden = !parts.length;
}

// ---------- drawer ----------
async function openItem(index, list = state.dl?.list ?? state.items, box = state.dl?.box ?? $('#grid')) {
  if (index < 0 || index >= list.length) return;
  state.active = index; state.dl = { list, box };
  document.querySelectorAll('.card.active').forEach((c) => c.classList.remove('active'));
  const el = box.querySelector(`.card[data-i="${index}"]`);
  el?.classList.add('active');
  el?.scrollIntoView({ block: 'nearest' });
  const it = list[index], d = $('#drawer');
  d.hidden = false;
  d.replaceChildren(h('p', { text: 'Loading…' }));
  if (list === state.items && index >= list.length - 3 && !state.done) loadMore();
  let det;
  try { det = await api('/api/item/' + it.id); } catch (e) { if (state.active === index) d.replaceChildren(h('p', { class: 'error', text: e.message })); return; }
  if (state.active !== index || state.dl.list !== list) return;
  const s = det.summary, owned = !!state.owned[s.id];
  const date = (x) => (x ? new Date(x).toLocaleDateString() : '–');
  d.replaceChildren(h('div', {},
    h('div', { class: 'nav' },
      h('button', { class: 'btn', title: 'Previous (←)', text: '←', onclick: () => openItem(index - 1) }),
      h('button', { class: 'btn', title: 'Next (→)', text: '→', onclick: () => openItem(index + 1) }),
      h('button', { class: 'btn close', title: 'Close (Esc)', text: '✕', onclick: closeDrawer, style: 'margin-left:auto' })),
    gallery(det.images, s.thumb),
    h('h2', { translate: 'yes', text: s.title || `BOOTH item #${s.id}` }),
    s.shop ? h('div', { class: 'shopline' },
      h('a', { href: '?view=shop&s=' + encodeURIComponent(s.shopSubdomain), text: s.shop, title: 'Shop page', onclick: (e) => { e.preventDefault(); go('shop', { s: s.shopSubdomain }); } }),
      h('a', { href: '#', class: 'muted', text: 'all items', onclick: (e) => { e.preventDefault(); setFilter('shop', s.shopSubdomain); } })) : '',
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary', href: s.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on BOOTH' }),
      h('button', { class: `btn ${owned ? 'on' : ''}`, text: owned ? '✓ I own this' : 'I own this', onclick: () => toggleOwned(s.id, index) }),
      bmButton(s.id, true)),
    h('dl', {},
      h('dt', { text: 'Price' }), h('dd', {}, money(s.priceJpy),
        cheaper(s) ? h('span', { class: 'cheap', text: ` · ${cheapNote(s)}` }) : null,
        s.priceReason ? h('div', { class: 'price-reason', text: s.priceReason }) : null),
      h('dt', { text: 'Likes' }), h('dd', { text: s.likes.toLocaleString() }),
      h('dt', { text: 'Published' }), h('dd', { text: date(s.published) }),
      h('dt', { text: 'Rating' }), h('dd', { text: (RATING_NAMES[s.rating] || 'Unrated') + (s.adult ? ' · R-18' : '') }),
      h('dt', { text: 'BOOTH category' }), h('dd', { text: s.boothCategory || '–' }),
      h('dt', { text: 'Status' }), h('dd', { text: s.status }),
      s.features.length ? [h('dt', { text: 'Works with' }), h('dd', { text: s.features.map((f) => FEATURE_NAMES[f] || f).join(', ') })] : ''),
    det.variations.length > 1 ? [h('h4', { text: `${det.variations.length} variations` }),
      h('table', { class: 'vars' }, det.variations.map((v) => h('tr', {}, h('td', { text: v.name || '–' }), h('td', { class: 'num', text: money(v.price) }))))] : '',
    det.description ? [h('h4', { text: 'Description' }), h('div', { class: 'desc collapsed', translate: 'yes', text: det.description, onclick: (e) => e.currentTarget.classList.toggle('collapsed') })] : '',
    det.avatars.length ? [h('h4', { text: `Fits ${det.avatars.length} avatar${det.avatars.length > 1 ? 's' : ''}` }),
      h('div', { class: 'taglist' }, det.avatars.map((a) => h('button', { title: (a.verified ? 'Checked match' : 'Detected from the listing') + ' · open the avatar page', onclick: () => go('avatar', { slug: a.key }) },
        a.verified ? h('span', { class: 'v', text: '✓ ' }) : '', a.name)))] : '',
    det.categories.length ? [h('h4', { text: 'Categories' }),
      h('div', { class: 'taglist' }, det.categories.map((c) => h('button', { text: `${c.categoryName} › ${c.subcategoryName}`, onclick: () => setFilter('sub', [c.subcategory]) })))] : '',
    det.tags.length ? [h('h4', { text: 'Tags' }),
      h('div', { class: 'taglist' }, det.tags.map((t) => h('button', { title: t.unifiedName || '', text: t.name, onclick: () => pickTag('rawtag', t.name) })))] : '',
    state.meta.semantic ? [h('h4', {}, 'Similar items ', h('a', { href: '#', class: 'more', text: 'More like this →',
      onclick: (e) => { e.preventDefault(); moreLike(s.id); } })), h('div', { class: 'similar', id: 'similar' }, h('p', { class: 'muted', text: 'Looking…' }))] : '',
    h('p', { class: 'checked', text: det.fetchedAt ? `Checked on BOOTH ${date(det.checkedAt || det.fetchedAt)}.`
      : `From the dataset snapshot of ${date(state.meta.datasetSnapshot)}. Not checked on BOOTH yet.` })));
  if (state.meta.semantic) loadSimilar(s.id, index);
}
async function loadSimilar(id, index) {
  const p = viewerParams({ similar: id, size: 9 });
  let res;
  try { res = await api('/api/search?' + p); } catch { res = { items: [] }; }
  const box = document.getElementById('similar');
  if (!box || state.active !== index || state.dl.list[index]?.id !== id) return;
  if (!res.items.length) { box.replaceChildren(h('p', { class: 'muted', text: 'Nothing close yet (this item has no meaning vector).' })); return; }
  box.replaceChildren(...res.items.map((it) => h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer', title: it.title || '' },
    h('div', { class: 'thumb' }, it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'ph', text: it.boothCategory || 'BOOTH item' })),
    h('span', { text: it.title || `#${it.id}` }))));
}
function moreLike(id) {
  // Keep the narrowing filters (avatar, category, price…), drop the text query: the item is the query now.
  delete state.f.q; delete state.f.mode;
  if (state.f.sort === 'popular') delete state.f.sort;
  closeDrawer();
  setFilter('similar', String(id));
}
function closeDrawer() {
  $('#drawer').hidden = true;
  document.querySelectorAll('.card.active').forEach((c) => c.classList.remove('active'));
  state.active = -1;
}
function toggleOwned(id, index) {
  if (state.owned[id]) delete state.owned[id]; else state.owned[id] = 1;
  store.set('owned', state.owned);
  const { list, box } = state.dl;
  box.querySelector(`.card[data-i="${index}"]`)?.replaceWith(card(list[index], index, list, box));
  openItem(index);
}

// ---------- page helpers ----------
const enc = encodeURIComponent;
const fmtDate = (x) => (x ? new Date(x).toLocaleDateString() : '–');
const pageBox = () => $('#pageView');
function stat(v, label) { return h('div', { class: 'stat' }, h('b', { text: typeof v === 'number' ? v.toLocaleString() : v }), h('span', { text: label })); }
function backLink(label, onclick) { return h('a', { href: '#', class: 'back', text: '← ' + label, onclick: (e) => { e.preventDefault(); onclick(); } }); }
function pageError(e, what) { return h('p', { class: 'error', text: e.message === 'Server error 404' ? `No such ${what}.` : e.message }); }
function link(text, view, vp, cls) {
  return h('a', { href: '?' + new URLSearchParams({ view, ...vp }), class: cls, text, onclick: (e) => { e.preventDefault(); go(view, vp); } });
}
/** A row of item cards that open in the drawer, with a "See all" link to the Items view. */
function section(title, items, f) {
  if (!items?.length) return '';
  const box = h('div', { class: 'grid' });
  box.append(...items.map((it, i) => card(it, i, items, box)));
  return h('section', { class: 'psec' },
    h('h3', {}, title, f ? h('a', { href: '?' + toParams(f), class: 'more', text: 'See all →', onclick: (e) => { e.preventDefault(); browse(f); } }) : null), box);
}
const weekLabel = (k) => (k === 0 ? 'Last 7 days' : `${k} week${k > 1 ? 's' : ''} ago`);
/** New assets per week as bars (oldest left). */
function sparkline(weeks, cls) {
  const NS = 'http://www.w3.org/2000/svg', n = weeks.length, max = Math.max(1, ...weeks);
  const el = (tag, attrs) => { const x = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v); return x; };
  const svg = el('svg', { viewBox: `0 0 ${n * 4} 20`, preserveAspectRatio: 'none', class: 'spark ' + (cls || ''), role: 'img', 'aria-label': 'New assets per week' });
  weeks.forEach((v, i) => {
    const ht = v ? Math.max(1.5, (v / max) * 20) : 0.6;
    const r = el('rect', { x: i * 4 + 0.5, width: 3, y: 20 - ht, height: ht, class: v ? '' : 'z' });
    const t = el('title', {}); t.textContent = `${weekLabel(n - 1 - i)}: ${v} new`;
    r.append(t); svg.append(r);
  });
  return svg;
}
function factBadges(a) {
  const g = a.gender === 'female' ? '♀ Female' : a.gender === 'male' ? '♂ Male' : null;
  const facts = [g, a.quest && 'Quest', a.faceTracking && 'Face tracking', a.mochiFitter && 'MochiFitter', a.sample && 'Sample'].filter(Boolean);
  return facts.length ? h('div', { class: 'feats' }, facts.map((f) => h('span', { class: 'feat', text: f }))) : null;
}
function starButton(slug, big) {
  const mine = state.myAvatars.includes(slug);
  return h('button', { class: `star ${mine ? 'on' : ''} ${big ? 'big' : ''}`, title: mine ? 'Remove from my avatars' : 'Add to my avatars', text: mine ? '★' : '☆',
    onclick: (e) => { e.stopPropagation(); toggleMyAvatar(slug); e.currentTarget.replaceWith(starButton(slug, big)); } });
}

// ---------- Avatars view ----------
function setAv(k, v, push = true) {
  const vp = { ...state.vp };
  if (v) vp[k] = v; else delete vp[k];
  state.vp = vp;
  writeUrl(push);
  renderAvatarsView();
}
function buildAvatarFilters() {
  const av = sb.av = {};
  av.find = h('input', { class: 'find', type: 'search', placeholder: 'Find an avatar…', oninput: debounce((e) => setAv('q', e.target.value.trim(), false), 250) });
  av.mine = h('input', { type: 'checkbox', onchange: (e) => setAv('mine', e.target.checked ? '1' : null) });
  av.gender = h('div');
  av.checks = [['quest', 'Quest / Android'], ['ft', 'Face tracking'], ['mochifitter', 'MochiFitter'], ['sample', 'Has a sample']].map(([k, label]) => {
    const cb = h('input', { type: 'checkbox', onchange: (e) => setAv(k, e.target.checked ? '1' : null) });
    return [k, cb, h('label', { class: 'row' }, cb, label)];
  });
  av.likes = h('select', { onchange: (e) => setAv('minlikes', e.target.value || null) },
    [['', 'Any'], ['1000', '1,000+'], ['10000', '10,000+'], ['100000', '100,000+']].map(([v, t]) => h('option', { value: v, text: t })));
  return h('div', { hidden: true },
    h('h3', {}, 'Avatar'), av.find, h('label', { class: 'row' }, av.mine, 'Only my avatars'),
    h('h3', {}, 'Gender'), av.gender,
    h('h3', {}, 'Facts'), av.checks.map((c) => c[2]),
    h('h3', {}, 'Likes on its assets'), h('div', { class: 'row' }, av.likes),
    h('p', { class: 'hint', text: 'Facts are read from each avatar\'s BOOTH listing and may be incomplete until its page has been checked.' }));
}
function syncAvatarFilters() {
  const vp = state.vp, av = sb.av;
  if (document.activeElement !== av.find) av.find.value = vp.q || '';
  av.mine.checked = vp.mine === '1';
  av.gender.replaceChildren(...GENDERS.map(([v, t]) => facetRow({ label: t, sel: (vp.gender || '') === v, onclick: () => setAv('gender', v || null) })));
  for (const [k, cb] of av.checks) cb.checked = vp[k] === '1';
  av.likes.value = vp.minlikes || '';
}
function avatarCard(a) {
  const b = a.base;
  return h('article', { class: 'card avatar', tabindex: '0', onclick: () => go('avatar', { slug: a.slug }), onkeydown: (e) => { if (e.key === 'Enter') go('avatar', { slug: a.slug }); } },
    h('div', { class: 'thumb' },
      b?.thumb ? h('img', { src: b.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph', text: a.name }),
      h('div', { class: 'badges' }, a.new7 ? h('span', { class: 'badge new', text: `+${a.new7} this week` }) : null)),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, starButton(a.slug), a.name),
      h('div', { class: 'shop', text: a.nameJa && a.nameJa !== a.name ? a.nameJa : b?.shop || '' }),
      h('div', { class: 'meta' }, h('span', { text: `${a.assets.toLocaleString()} assets` }),
        h('span', { class: 'likes', title: 'New assets in the last 30 days', text: a.new30 ? `+${a.new30.toLocaleString()} / 30 d` : '' })),
      sparkline(a.weekly, 'mini'),
      factBadges(a)));
}
async function renderAvatarsView() {
  const vp = state.vp, req = ++state.pageReq;
  state.avVp = vp;
  syncAvatarFilters();
  const sort = h('select', { title: 'Sort', onchange: (e) => setAv('sort', e.target.value === 'assets' ? null : e.target.value) },
    AVATAR_SORTS.map(([v, t]) => h('option', { value: v, text: t })));
  sort.value = vp.sort || 'assets';
  const count = h('span', { class: 'count', text: 'Loading…' }), grid = h('div', { class: 'grid avatars' });
  pageBox().replaceChildren(h('div', { class: 'resultbar' }, h('h2', { text: 'Avatars' }), count, h('span', { class: 'spacer' }), sort), grid);
  const p = new URLSearchParams({ size: 500 });
  for (const k of ['q', 'gender', 'quest', 'ft', 'mochifitter', 'sample', 'minlikes', 'sort']) if (vp[k]) p.set(k, vp[k]);
  if (store.get('adult', 'safe') !== 'safe') p.set('adult', 'include');
  let res;
  try { res = await api('/api/avatars?' + p); } catch (e) { if (req === state.pageReq) count.replaceWith(pageError(e, 'avatars')); return; }
  if (req !== state.pageReq) return;
  const list = vp.mine === '1' ? res.avatars.filter((a) => state.myAvatars.includes(a.slug)) : res.avatars;
  count.textContent = `${list.length.toLocaleString()} avatar${list.length === 1 ? '' : 's'}`;
  grid.replaceChildren(...list.map(avatarCard));
  if (!list.length) grid.append(h('p', { class: 'empty', text: 'No avatars match these filters.' }));
}

// ---------- avatar page ----------
async function renderAvatarPage() {
  const slug = state.vp.slug, req = ++state.pageReq, box = pageBox();
  box.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  let d;
  try { d = await api(`/api/avatar/${enc(slug)}?` + viewerParams()); } catch (e) { if (req === state.pageReq) box.replaceChildren(pageError(e, 'avatar')); return; }
  if (req !== state.pageReq) return;
  const a = d.avatar, b = a.base, browseAll = { avatar: [a.slug] };
  document.title = `${a.name} · Hapsplorer`;
  box.replaceChildren(
    backLink('Avatars', () => go('avatars', state.avVp || {})),
    h('section', { class: 'profile' },
      h('div', { class: 'pimg' }, b?.thumb ? h('img', { src: b.thumb, alt: '', referrerpolicy: 'no-referrer', title: 'Open on BOOTH', onclick: () => window.open(b.url, '_blank', 'noopener,noreferrer') })
        : h('div', { class: 'ph', text: 'No image yet' })),
      h('div', { class: 'pinfo' },
        h('h1', {}, a.name, ' ', starButton(a.slug, true)),
        a.nameJa && a.nameJa !== a.name ? h('div', { class: 'muted', text: a.nameJa }) : null,
        b?.shop ? h('div', {}, 'by ', link(b.shop, 'shop', { s: b.shopSubdomain })) : null,
        factBadges(a),
        h('div', { class: 'stats' }, stat(a.assets, 'assets'), stat(a.new7, 'new in 7 days'), stat(a.new30, 'new in 30 days'), stat(a.likes, 'likes on assets'),
          b ? stat(money(b.priceJpy), 'price') : null, b ? stat(b.likes, 'likes') : null),
        h('div', { class: 'sparkbox' }, h('div', { class: 'muted small', text: 'New assets per week, last 26 weeks' }), sparkline(a.weekly, 'big')),
        d.siblings.length ? h('p', {}, 'Shares a body with ', d.siblings.flatMap((s, i) => [i ? ', ' : '', link(s.name, 'avatar', { slug: s.slug })]),
          h('span', { class: 'muted', text: ' (their assets are included)' })) : null,
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: '?' + toParams(browseAll), text: `Browse ${a.assets.toLocaleString()} assets for ${a.name} →`, onclick: (e) => { e.preventDefault(); browse(browseAll); } }),
          b ? h('a', { class: 'btn', href: b.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on BOOTH' }) : null))),
    section('Face tracking packages', d.faceTracking, { avatar: [slug], feat: ['face-tracking'] }),
    section('MochiFitter profiles', d.mochiFitter, { avatar: [slug], feat: ['mochifitter'] }),
    section('Newest assets', d.newest, { avatar: [slug], sort: 'newest' }),
    section('Most liked assets', d.popular, browseAll));
}

// ---------- Shops view ----------
function shopRow(s) {
  const hidden = isHiddenShop(s.subdomain);
  const row = h('div', { class: `shoprow ${hidden ? 'is-hidden' : ''}` },
    link(s.name, 'shop', { s: s.subdomain }, 'name'),
    h('span', { class: 'muted sub', text: s.subdomain }),
    h('span', { class: 'num', text: `${s.items.toLocaleString()} items` }),
    h('span', { class: 'num muted', text: `♥ ${s.likes.toLocaleString()}` }),
    h('span', { class: 'num muted', text: s.newest ? `newest ${fmtDate(s.newest)}` : '' }),
    h('button', { class: 'btn small', text: hidden ? 'Unhide' : 'Hide', title: hidden ? 'Show this shop\'s items again' : 'Hide this shop\'s items from your searches (this browser only)',
      onclick: () => { toggleHiddenShop(s.subdomain, s.name, false); row.replaceWith(shopRow(s)); } }));
  return row;
}
function renderShopsView() {
  const vp = state.vp;
  state.shopsVp = vp;
  const find = h('input', { type: 'search', class: 'find', placeholder: 'Find a shop…', value: vp.q || '',
    oninput: debounce((e) => { state.vp = { ...state.vp, q: e.target.value.trim() }; writeUrl(false); load(); }, 250) });
  const sort = h('select', { title: 'Sort', onchange: (e) => { state.vp = { ...state.vp, sort: e.target.value === 'items' ? '' : e.target.value }; writeUrl(true); load(); } },
    SHOP_SORTS.map(([v, t]) => h('option', { value: v, text: t })));
  sort.value = vp.sort || 'items';
  const count = h('span', { class: 'count' }), list = h('div', { class: 'shoplist' });
  pageBox().replaceChildren(h('div', { class: 'resultbar' }, h('h2', { text: 'Shops' }), find, count, h('span', { class: 'spacer' }), sort), list);
  let cur;
  async function more(me) {
    if (me !== cur || me.done || me.loading) return;
    me.loading = true;
    try {
      const p = new URLSearchParams({ size: 100, page: me.page + 1 });
      if (state.vp.q) p.set('q', state.vp.q);
      if (state.vp.sort) p.set('sort', state.vp.sort);
      const r = await api('/api/shops?' + p);
      if (me !== cur || me.req !== state.pageReq) return;
      me.page++;
      count.textContent = `${r.total.toLocaleString()} shop${r.total === 1 ? '' : 's'}`;
      list.append(...r.shops.map(shopRow));
      me.done = me.page * 100 >= r.total;
      if (!r.total) list.append(h('p', { class: 'empty', text: 'No shops match.' }));
    } catch (e) { me.done = true; count.textContent = e.message; } finally { me.loading = false; }
    if (!me.done && me === cur && pageSentinelVisible()) more(me);
  }
  function load() {
    const me = cur = { page: 0, done: false, loading: false, req: ++state.pageReq };
    list.replaceChildren(); count.textContent = 'Loading…';
    state.pageMore = () => more(me);
    more(me);
  }
  load();
}
function pageSentinelVisible() { const r = $('#pageSentinel').getBoundingClientRect(); return r.top < innerHeight + 600; }

// ---------- shop page ----------
async function renderShopPage() {
  const sub = state.vp.s, req = ++state.pageReq, box = pageBox();
  box.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  let d;
  try { d = await api(`/api/shop/${enc(sub)}?` + viewerParams()); } catch (e) { if (req === state.pageReq) box.replaceChildren(pageError(e, 'shop')); return; }
  if (req !== state.pageReq) return;
  const s = d.shop, hidden = isHiddenShop(s.subdomain), shopUrl = `https://${s.subdomain}.booth.pm/`;
  document.title = `${s.name} · Hapsplorer`;
  box.replaceChildren(
    backLink('Shops', () => go('shops', state.shopsVp || {})),
    h('section', { class: 'profile shop' },
      h('div', { class: 'pinfo' },
        h('h1', { text: s.name }),
        h('a', { class: 'muted', href: shopUrl, target: '_blank', rel: 'noopener noreferrer', text: `${s.subdomain}.booth.pm` }),
        h('div', { class: 'stats' }, stat(s.items, 'items'), stat(s.likes, 'likes'), stat(fmtDate(s.newest), 'newest item')),
        hidden ? h('p', { class: 'warnings', text: 'You hid this shop: its items don\'t show in your searches.' }) : null,
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: '?' + toParams({ shop: s.subdomain }), text: `Browse ${d.shown.toLocaleString()} items →`, onclick: (e) => { e.preventDefault(); browse({ shop: s.subdomain }); } }),
          h('a', { class: 'btn', href: shopUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open shop on BOOTH' }),
          shopMarkButton(s),
          h('button', { class: 'btn', text: hidden ? 'Unhide shop' : 'Hide shop', title: 'Hidden shops are left out of your searches (this browser only)', onclick: () => toggleHiddenShop(s.subdomain, s.name) })))),
    d.avatars.length ? h('section', { class: 'psec' }, h('h3', { text: `Avatars by ${s.name}` }), h('div', { class: 'grid' }, d.avatars.map(avatarCard))) : '',
    d.categories.length ? h('section', { class: 'psec' }, h('h3', { text: 'Categories' }),
      h('div', { class: 'taglist' }, d.categories.map((c) => h('button', { onclick: () => browse({ shop: sub, cat: [c.key] }) }, c.name + ' ', h('span', { class: 'muted', text: c.count.toLocaleString() }))))) : '',
    section('Most liked items', d.top, { shop: sub }));
}

// ---------- bookmarks ----------
const isMarked = (id) => state.bookmarks.includes(id);
function toggleBookmark(id) {
  state.bookmarks = isMarked(id) ? state.bookmarks.filter((x) => x !== id) : [id, ...state.bookmarks];
  store.set('bookmarks', state.bookmarks);
  document.querySelectorAll(`.bm[data-id="${id}"]`).forEach(syncBm);
}
/** Star buttons for one item stay in step everywhere (cards, drawer). */
function syncBm(b) {
  const on = isMarked(Number(b.dataset.id));
  b.classList.toggle('on', on);
  b.textContent = (on ? '★' : '☆') + (b.dataset.label ? (on ? ' Bookmarked' : ' Bookmark') : '');
  b.title = on ? 'Remove bookmark (b)' : 'Bookmark (b)';
}
function bmButton(id, labelled) {
  const b = h('button', { class: labelled ? 'btn bm' : 'bm', 'data-id': id, 'data-label': labelled ? '1' : null, onclick: (e) => { e.stopPropagation(); toggleBookmark(id); } });
  syncBm(b);
  return b;
}
const isMarkedShop = (sub) => state.shopMarks.some((x) => x.s === sub);
function shopMarkButton(s) {
  const on = isMarkedShop(s.subdomain);
  return h('button', { class: `btn bm ${on ? 'on' : ''}`, text: on ? '★ Bookmarked' : '☆ Bookmark shop', onclick: (e) => {
    state.shopMarks = on ? state.shopMarks.filter((x) => x.s !== s.subdomain) : [{ s: s.subdomain, n: s.name }, ...state.shopMarks];
    store.set('shopMarks', state.shopMarks);
    e.currentTarget.replaceWith(shopMarkButton(s));
  } });
}
async function renderBookmarksView() {
  const req = ++state.pageReq, ids = state.bookmarks;
  document.title = 'Bookmarks · Hapsplorer';
  const count = h('span', { class: 'count', text: ids.length ? 'Loading…' : '' }), grid = h('div', { class: 'grid' });
  pageBox().replaceChildren(
    h('div', { class: 'resultbar' }, h('h2', { text: 'Bookmarks' }), count, h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', text: 'Export my data', title: 'Save bookmarks, owned items, avatars, hidden lists and the tier list to a file', onclick: exportData }),
      h('button', { class: 'btn small', text: 'Import', title: 'Load a file saved with Export', onclick: importData })),
    state.shopMarks.length ? h('section', { class: 'psec' }, h('h3', { text: 'Shops' }),
      h('div', { class: 'taglist' }, state.shopMarks.map((x) => h('button', { text: x.n || x.s, title: x.s, onclick: () => go('shop', { s: x.s }) })))) : '',
    h('section', { class: 'psec' }, state.shopMarks.length ? h('h3', { text: 'Items' }) : null, grid));
  if (!ids.length) {
    grid.append(h('p', { class: 'empty', text: 'No bookmarks yet. Press ☆ on an item (or b) to keep it here. Bookmarks live in this browser: use Export to back them up or move them.' }));
    return;
  }
  const got = [];
  try { for (let i = 0; i < ids.length; i += 120) got.push(...await api('/api/cards?ids=' + ids.slice(i, i + 120).join(','))); }
  catch (e) { if (req === state.pageReq) count.replaceWith(pageError(e, 'bookmarks')); return; }
  if (req !== state.pageReq) return;
  const byId = new Map(got.map((x) => [x.id, x])), list = ids.map((id) => byId.get(id)).filter(Boolean), gone = ids.length - list.length;
  count.textContent = `${list.length.toLocaleString()} item${list.length === 1 ? '' : 's'}` + (gone ? ` · ${gone} no longer in the catalog` : '');
  grid.replaceChildren(...list.map((it, i) => card(it, i, list, grid)));
}

// ---------- export / import of this browser's data ----------
// Everything Hapsplorer keeps in this browser, in one file. 'lastVisit' stays per browser.
const DATA_KINDS = { owned: 'object', myAvatars: 'array', hiddenShops: 'array', hiddenWords: 'array', bookmarks: 'array', shopMarks: 'array',
  tiers: 'object', adult: 'string', currency: 'string', theme: 'string' };
const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
function exportData() {
  const data = {};
  for (const k of Object.keys(DATA_KINDS)) { const v = store.get(k, undefined); if (v !== undefined) data[k] = v; }
  const blob = new Blob([JSON.stringify({ app: 'hapsplorer', version: 1, exported: new Date().toISOString(), data }, null, 1)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `hapsplorer-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function importData() {
  const inp = h('input', { type: 'file', accept: '.json,application/json' });
  inp.addEventListener('change', async () => {
    const file = inp.files[0];
    if (!file) return;
    let j;
    try { j = JSON.parse(await file.text()); } catch { alert('That file isn\'t valid JSON.'); return; }
    if (j?.app !== 'hapsplorer' || kindOf(j.data) !== 'object') { alert('That isn\'t a Hapsplorer export.'); return; }
    applyImport(j);
  });
  inp.click();
}
/** Merges an export into this browser after asking, then reloads. */
function applyImport(j, ask = true) {
  const d = Object.fromEntries(Object.entries(j.data).filter(([k, v]) => DATA_KINDS[k] && DATA_KINDS[k] === kindOf(v)));
  const n = (k) => (!d[k] ? 0 : Array.isArray(d[k]) ? d[k].length : Object.keys(d[k]).length);
  const msg = `Import the data saved ${String(j.exported || '').slice(0, 10) || 'in this file'}?\n\n`
    + `${n('bookmarks')} bookmarked items, ${n('shopMarks')} bookmarked shops, ${n('owned')} owned items, ${n('myAvatars')} of your avatars, `
    + `${n('hiddenShops')} hidden shops, ${n('hiddenWords')} hidden words${d.tiers ? ', a tier list' : ''}.\n\n`
    + 'Lists are merged with what this browser already has. The tier list and settings (theme, currency, adult content) are replaced.';
  if (ask && !confirm(msg)) return false;
  for (const [k, v] of Object.entries(d)) store.set(k, mergeData(k, store.get(k, undefined), v));
  if (ask) location.reload();
  return true;
}
function mergeData(k, cur, inc) {
  if (k === 'bookmarks') inc = inc.map(Number).filter(Number.isFinite);
  const key = (x) => (x && typeof x === 'object' ? x.s ?? JSON.stringify(x) : x);
  if (Array.isArray(cur) && Array.isArray(inc)) { const seen = new Set(cur.map(key)); return [...cur, ...inc.filter((x) => !seen.has(key(x)) && seen.add(key(x)))]; }
  if (k === 'owned' && kindOf(cur) === 'object') return { ...cur, ...inc };
  return inc;
}

// ---------- tier list ----------
// One avatar tier list per browser: { title, rows: [{ name, color, items: [slug] }] }. Saved on every change.
const TIER_COLORS = ['#ff7f7f', '#ffbf7f', '#ffdf7f', '#bfff7f', '#7fbfff', '#bf7fff', '#ff7fbf', '#c8c8c8'];
const tierColor = (i) => TIER_COLORS[i % TIER_COLORS.length];
const defaultTiers = () => ({ title: 'My avatar tier list', rows: ['S', 'A', 'B', 'C', 'D'].map((name, i) => ({ name, color: tierColor(i), items: [] })) });
/** Reads the saved list, repairing anything an import may have broken. */
function loadTiers() {
  const t = store.get('tiers', null);
  if (!t || !Array.isArray(t.rows) || !t.rows.length) return defaultTiers();
  const seen = new Set();
  return { title: String(t.title || 'Tier list').slice(0, 80), rows: t.rows.slice(0, 20).map((r, i) => ({
    name: String(r?.name ?? '?').slice(0, 20), color: /^#[0-9a-f]{6}$/i.test(r?.color) ? r.color : tierColor(i),
    items: (Array.isArray(r?.items) ? r.items : []).map(String).filter((s) => !seen.has(s) && seen.add(s)) })) };
}
function saveTiers() { store.set('tiers', state.tiers); }
async function renderTiersView() {
  const req = ++state.pageReq, box = pageBox();
  document.title = 'Tier list · Hapsplorer';
  if (!state.avList) {
    box.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    const p = new URLSearchParams({ size: 500 });
    if (store.get('adult', 'safe') !== 'safe') p.set('adult', 'include');
    try { state.avList = (await api('/api/avatars?' + p)).avatars; } catch (e) { if (req === state.pageReq) box.replaceChildren(pageError(e, 'avatars')); return; }
    if (req !== state.pageReq) return;
    state.avBy = new Map(state.avList.map((a) => [a.slug, a]));
  }
  state.tiers ??= loadTiers();
  drawTiers();
}
function drawTiers() {
  const t = state.tiers, edit = (fn) => { fn(); saveTiers(); drawTiers(); };
  const pool = h('div', { class: 'tier-items tier-pool' });
  dropZone(pool, -1);
  const fill = () => {
    const placed = new Set(t.rows.flatMap((r) => r.items)), q = (state.tierQ || '').trim().toLowerCase();
    const list = state.avList.filter((a) => !placed.has(a.slug) && (!state.tierMine || state.myAvatars.includes(a.slug))
      && (!q || a.name.toLowerCase().includes(q) || a.slug.includes(q) || (a.nameJa || '').includes(q)));
    pool.replaceChildren(...list.slice(0, 200).map((a) => tierTile(a.slug)),
      list.length > 200 ? h('p', { class: 'muted small', text: `+${list.length - 200} more: narrow it with the search box.` }) : '',
      list.length ? '' : h('p', { class: 'muted small', text: 'No avatars left here.' }));
  };
  const exportBtn = h('button', { class: 'btn primary', text: 'Save as PNG', onclick: async () => {
    exportBtn.disabled = true; exportBtn.textContent = 'Drawing…';
    try { await exportTiersPng(); } catch (e) { alert('Couldn\'t draw the image: ' + e.message); }
    exportBtn.disabled = false; exportBtn.textContent = 'Save as PNG';
  } });
  pageBox().replaceChildren(
    h('div', { class: 'tier-bar' },
      h('input', { class: 'tier-title', value: t.title, maxlength: 80, 'aria-label': 'Tier list title', onchange: (e) => { t.title = e.target.value.trim() || 'Tier list'; saveTiers(); } }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', text: '+ Add tier', disabled: t.rows.length >= 20, onclick: () => edit(() => {
        const used = new Set(t.rows.map((r) => r.name));
        t.rows.push({ name: [...'SABCDEFGH'].find((x) => !used.has(x)) || '?', color: tierColor(t.rows.length), items: [] });
      }) }),
      h('button', { class: 'btn', text: 'Clear', title: 'Move every avatar back to the pool', onclick: () => { if (confirm('Move every avatar back to the pool?')) edit(() => t.rows.forEach((r) => { r.items = []; })); } }),
      exportBtn),
    h('p', { class: 'hint', text: 'Drag avatars into tiers, or click one and then click a tier. Double-click opens its page. Saved in this browser (Export backs it up).' }),
    h('div', { class: 'tiers' }, t.rows.map((r, i) => {
      const items = h('div', { class: 'tier-items' }, r.items.map((s) => tierTile(s)));
      dropZone(items, i);
      const label = h('div', { class: 'tier-label', style: `background:${r.color}` },
        h('input', { value: r.name, maxlength: 20, 'aria-label': 'Tier name', onchange: (e) => { r.name = e.target.value.trim() || '?'; saveTiers(); } }));
      return h('div', { class: 'tier' }, label, items,
        h('div', { class: 'tier-tools' },
          h('input', { type: 'color', value: r.color, title: 'Colour', oninput: (e) => { r.color = e.target.value; label.style.background = r.color; }, onchange: saveTiers }),
          h('button', { class: 'btn small', text: '↑', title: 'Move up', disabled: i === 0, onclick: () => edit(() => t.rows.splice(i - 1, 0, ...t.rows.splice(i, 1))) }),
          h('button', { class: 'btn small', text: '↓', title: 'Move down', disabled: i === t.rows.length - 1, onclick: () => edit(() => t.rows.splice(i + 1, 0, ...t.rows.splice(i, 1))) }),
          h('button', { class: 'btn small', text: '✕', title: 'Remove this tier (its avatars go back to the pool)', disabled: t.rows.length <= 1, onclick: () => edit(() => t.rows.splice(i, 1)) })));
    })),
    h('div', { class: 'tier-poolbar' }, h('h3', { text: 'Avatars' }),
      h('input', { type: 'search', class: 'find', placeholder: 'Find an avatar…', value: state.tierQ || '', oninput: (e) => { state.tierQ = e.target.value; fill(); } }),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!state.tierMine, onchange: (e) => { state.tierMine = e.target.checked; fill(); } }), 'Only my avatars')),
    pool);
  fill();
}
function tierTile(slug) {
  const a = state.avBy.get(slug), name = a?.name || slug, thumb = a?.base?.thumb;
  const el = h('div', { class: `tile ${state.tierSel === slug ? 'sel' : ''}`, draggable: 'true', title: name, 'data-slug': slug,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', slug); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); },
    ondragend: () => el.classList.remove('dragging'),
    onclick: (e) => {
      e.stopPropagation();
      state.tierSel = state.tierSel === slug ? null : slug;
      document.querySelectorAll('.tile.sel').forEach((x) => x.classList.remove('sel'));
      if (state.tierSel) el.classList.add('sel');
    },
    ondblclick: () => go('avatar', { slug }) },
    thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' }) : h('div', { class: 'noimg', text: name.slice(0, 2) }),
    h('span', { text: name }));
  return el;
}
/** A tier (row ≥ 0) or the pool (row -1) that takes dropped or click-moved avatars. */
function dropZone(el, row) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('over'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const tile = e.target.closest('.tile');
    // Dropped on the right half of a tile: goes after it.
    let before = tile?.dataset.slug;
    if (tile) { const r = tile.getBoundingClientRect(); if (e.clientX > r.left + r.width / 2) before = tile.nextElementSibling?.dataset.slug; }
    moveTile(e.dataTransfer.getData('text/plain'), row, before);
  });
  el.addEventListener('click', () => { const s = state.tierSel; if (s) { state.tierSel = null; moveTile(s, row); } });
}
function moveTile(slug, row, before) {
  const t = state.tiers;
  if (!slug || slug === before || !(state.avBy.has(slug) || t.rows.some((r) => r.items.includes(slug)))) return;
  for (const r of t.rows) r.items = r.items.filter((x) => x !== slug);
  if (row >= 0) {
    const items = t.rows[row].items, i = before ? items.indexOf(before) : -1;
    items.splice(i < 0 ? items.length : i, 0, slug);
  }
  saveTiers();
  drawTiers();
}
const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image')); i.src = src; });
/** Draws the tier list on a canvas and downloads it. Thumbnails come through /api/thumb (same origin), or the canvas couldn't be saved. */
async function exportTiersPng(download = true) {
  const t = state.tiers, S = 96, NAME = 18, GAP = 4, LABEL = 110, PER = 10, TOP = 56, FOOT = 28;
  const W = LABEL + GAP + PER * (S + GAP);
  const rowH = (r) => Math.max(1, Math.ceil(r.items.length / PER)) * (S + NAME + GAP) + GAP;
  const H = TOP + t.rows.reduce((s, r) => s + rowH(r), 0) + FOOT;
  const imgs = new Map();
  await Promise.all(t.rows.flatMap((r) => r.items).map(async (slug) => {
    const u = state.avBy.get(slug)?.base?.thumb;
    if (u) imgs.set(slug, await loadImg('/api/thumb?u=' + enc(u)).catch(() => null));
  }));
  const c = h('canvas', { width: W, height: H }), g = c.getContext('2d');
  const dark = document.documentElement.dataset.theme === 'dark';
  const col = dark ? { bg: '#1b1b23', row: '#24242e', tile: '#2e2e3a', text: '#ececf2', muted: '#9a9aab' } : { bg: '#ffffff', row: '#f0f0f4', tile: '#e2e2ea', text: '#1d1d24', muted: '#6b6b7b' };
  const font = (px, w = 400) => `${w} ${px}px system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  const fit = (s, max) => { if (g.measureText(s).width <= max) return s; while (s && g.measureText(s + '…').width > max) s = s.slice(0, -1); return s + '…'; };
  g.fillStyle = col.bg; g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';
  g.fillStyle = col.text; g.font = font(24, 700); g.fillText(fit(t.title, W - 24), 12, TOP / 2);
  let y = TOP;
  for (const r of t.rows) {
    const rh = rowH(r) - GAP;
    g.fillStyle = r.color; g.fillRect(0, y, LABEL, rh);
    g.fillStyle = col.row; g.fillRect(LABEL, y, W - LABEL, rh);
    g.fillStyle = '#1d1d24'; g.font = font(28, 800); g.textAlign = 'center';
    g.fillText(fit(r.name, LABEL - 12), LABEL / 2, y + rh / 2);
    r.items.forEach((slug, k) => {
      const x = LABEL + GAP + (k % PER) * (S + GAP), ty = y + GAP + Math.floor(k / PER) * (S + NAME + GAP), im = imgs.get(slug);
      g.fillStyle = col.tile; g.fillRect(x, ty, S, S);
      if (im) { const sc = Math.max(S / im.width, S / im.height), sw = S / sc, sh = S / sc; g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, x, ty, S, S); }
      g.fillStyle = col.text; g.font = font(12);
      g.fillText(fit(state.avBy.get(slug)?.name || slug, S), x + S / 2, ty + S + NAME / 2);
    });
    g.textAlign = 'left';
    y += rh + GAP;
  }
  g.fillStyle = col.muted; g.font = font(12); g.fillText(`Hapsplorer · ${new Date().toLocaleDateString()}`, 12, H - FOOT / 2);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
  if (!download) return { blob, images: imgs.size, drawn: [...imgs.values()].filter(Boolean).length };
  const a = h('a', { href: URL.createObjectURL(blob), download: (t.title.replace(/[\\/:*?"<>|]+/g, '_') || 'tier-list') + '.png' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- dialogs ----------
function showLogin() {
  const d = $('#login');
  if (!d.open) d.showModal();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginError');
  err.hidden = true;
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ key: $('#loginKey').value }) });
  if (!res.ok) { err.textContent = 'That key isn\'t valid.'; err.hidden = false; return; }
  $('#login').close();
  $('#loginKey').value = '';
  start();
});

function openAvatarsDialog() {
  const d = $('#avatarsDialog'), list = $('#avatarsList'), find = $('#avatarsFilter');
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    const avs = state.meta.avatars.filter((a) => !q || a.name.toLowerCase().includes(q) || a.key.includes(q) || (a.nameJa || '').includes(q));
    list.replaceChildren(...avs.slice(0, 120).map((a) => {
      const cb = h('input', { type: 'checkbox', checked: state.myAvatars.includes(a.key), onchange: () => toggleMyAvatar(a.key) });
      return h('label', { class: 'facet' }, cb, h('span', { text: a.name + (a.nameJa && a.nameJa !== a.name ? ` (${a.nameJa})` : '') }), h('span', { class: 'n', text: a.items.toLocaleString() }));
    }));
  };
  find.oninput = draw;
  draw();
  d.showModal();
}

// ---------- top bar ----------
function applyTheme() {
  const t = store.get('theme', 'system');
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeBtn').title = `Theme: ${t}`;
}
$('#themeBtn').addEventListener('click', () => {
  const order = ['system', 'dark', 'light'];
  store.set('theme', order[(order.indexOf(store.get('theme', 'system')) + 1) % 3]);
  applyTheme();
});
$('#q').addEventListener('input', debounce((e) => setFilter('q', e.target.value.trim() || null, false), 300));
$('#sort').addEventListener('change', (e) => {
  const v = e.target.value, def = hasRelevance() ? 'relevance' : 'popular';
  setFilter('sort', v === def ? null : v);
});
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setFilter('mode', b.dataset.mode || null);
});
$('#currency').addEventListener('change', (e) => { store.set('currency', e.target.value); rerenderCards(); renderSidebar(); renderChips(); });
$('#myAvatarsBtn').addEventListener('click', () => {
  if (!state.myAvatars.length) return openAvatarsDialog();
  setFilter('avatar', sameSet(state.f.avatar || [], state.myAvatars) ? null : [...state.myAvatars]);
});
$('#views').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.view;
  if (v === 'items') go('items');
  else if (v === 'avatars') go('avatars', state.avVp || {});
  else if (v === 'shops') go('shops', state.shopsVp || {});
  else if (v === 'bookmarks' || v === 'tiers') go(v);
});
$('#exportLink').addEventListener('click', (e) => { e.preventDefault(); exportData(); });
$('#importLink').addEventListener('click', (e) => { e.preventDefault(); importData(); });
/** Phones: the filters are a sheet over the page, closed by its button, the backdrop or Escape. */
function openFilters(on) {
  $('#sidebar').classList.toggle('open', on);
  document.body.classList.toggle('filters-open', on);
}
$('#filtersBtn').addEventListener('click', () => openFilters(!$('#sidebar').classList.contains('open')));
$('#backdrop').addEventListener('click', () => openFilters(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('filters-open')) openFilters(false); });
function rerenderCards() { $('#grid').replaceChildren(...state.items.map((it, i) => card(it, i))); }

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'Escape') {
    // Closing the drawer puts keyboard focus back on its card, so j/k carry on from there.
    if (!$('#drawer').hidden) { const c = document.querySelector('.card.active'); closeDrawer(); c?.focus({ preventScroll: true }); } else document.activeElement?.blur();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('#drawer').hidden) {
    // Drawer closed: j/k move between cards, Enter opens one (card keydown), b bookmarks the focused card.
    if (e.key === 'j' || e.key === 'k') { e.preventDefault(); stepFocus(e.key === 'j' ? 1 : -1); }
    else if (e.key === 'b') { const id = document.activeElement?.closest?.('.card[data-id]')?.dataset.id; if (id) toggleBookmark(Number(id)); }
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'j') openItem(state.active + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'k') openItem(state.active - 1);
  else if (e.key === 'o') window.open(state.dl?.list[state.active]?.url, '_blank', 'noopener,noreferrer');
  else if (e.key === 'm' && state.active >= 0) toggleOwned(state.dl.list[state.active].id, state.active);
  else if (e.key === 'b' && state.active >= 0) toggleBookmark(state.dl.list[state.active].id);
});
function stepFocus(d) {
  const cards = [...(state.view === 'items' ? $('#grid') : pageBox()).querySelectorAll('.card')];
  if (!cards.length) return;
  const i = cards.indexOf(document.activeElement?.closest?.('.card'));
  const next = cards[i < 0 ? (d > 0 ? 0 : cards.length - 1) : Math.min(cards.length - 1, Math.max(0, i + d))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest' });
}
window.addEventListener('popstate', () => { readUrl(); render(); });

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- currency ----------
const COMMON_CURRENCIES = ['JPY', 'USD', 'EUR', 'GBP', 'KRW', 'CNY', 'TWD', 'HKD', 'AUD', 'CAD'];
function fillCurrencies() {
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { /* codes only */ }
  const opt = (c) => h('option', { value: c, text: c, title: names?.of(c) || c });
  const all = Object.keys(state.rates), common = COMMON_CURRENCIES.filter((c) => all.includes(c));
  const rest = all.filter((c) => !common.includes(c)).sort();
  $('#currency').replaceChildren(...(rest.length ? [h('optgroup', { label: 'Common' }, common.map(opt)), h('optgroup', { label: 'More' }, rest.map(opt))] : common.map(opt)));
  $('#currency').title = `Currency (${all.length} available; rates update twice a day)`;
}

// ---------- start ----------
function notice(text) {
  let n = $('#notice');
  if (!n) { n = h('div', { id: 'notice', class: 'notice', role: 'alert' }); document.body.prepend(n); }
  n.textContent = text;
}
async function checkVersion() {
  try {
    const v = await (await fetch('/api/health', { cache: 'no-store' })).json();
    if (API_VERSION < v.minClientApiVersion || API_VERSION > v.apiVersion)
      notice(`Update needed: this page speaks API v${API_VERSION}, the server (Hapsplorer ${v.version}) accepts v${v.minClientApiVersion}–v${v.apiVersion}. Reload, or update the app.`);
  } catch { /* offline: the first API call reports it */ }
}
/** Full-page "server offline" screen (from the Worker or the desktop client) with Retry and, in the client, connection settings. */
function showOffline(j) {
  if ($('#offline')) return;
  const box = h('div', { id: 'offline', class: 'offline' },
    h('div', { class: 'offline-box' },
      h('h2', { text: 'The Hapsplorer server is offline' }),
      h('p', { text: (j.error || 'It can\'t be reached.') + ' The PC it runs on may be off or restarting.' }),
      h('div', { class: 'row' },
        h('button', { class: 'primary', text: 'Retry', onclick: () => location.reload() }),
        state.client ? h('button', { text: 'Connection settings', onclick: openClientSettings }) : null)));
  document.body.append(box);
}

// ---------- desktop client ----------
/** Running inside the Hapsplorer launcher or the HapsHub plugin (a local proxy that adds the key)? */
async function detectClient() {
  try {
    const r = await fetch('/_client/settings', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) state.client = await r.json();
  } catch { /* hosted by the server itself */ }
  if (state.client) {
    const b = h('button', { class: 'ghost', title: 'Connection settings', text: '⚙', onclick: openClientSettings });
    document.querySelector('.top')?.append(b);
  }
}
function openClientSettings() {
  const c = state.client || {};
  const srv = h('input', { type: 'url', value: c.server || '', placeholder: 'https://hapsplorer.<name>.workers.dev' });
  const lan = h('input', { type: 'url', value: c.lan || '', placeholder: 'http://192.168.1.10:8780 (optional)' });
  const key = h('input', { type: 'password', value: '', placeholder: c.hasKey ? 'saved (leave empty to keep)' : 'hk_…', autocomplete: 'off' });
  const msg = h('p', { class: 'muted', text: c.via ? `Connected via ${c.via}` : 'Not connected.' });
  const d = h('dialog', { class: 'client-settings' },
    h('form', { method: 'dialog' },
      h('h3', { text: 'Connection' }),
      h('label', { text: 'Server address (from the server owner)' }), srv,
      h('label', { text: 'LAN address (when you\'re on the same network)' }), lan,
      h('label', { text: 'Access key' }), key, msg,
      h('div', { class: 'row' },
        h('button', { class: 'primary', text: 'Save and connect', onclick: async (e) => {
          e.preventDefault();
          const r = await fetch('/_client/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hapsplorer-Client': '1' },
            body: JSON.stringify({ server: srv.value, lan: lan.value, key: key.value }) });
          const j = await r.json().catch(() => ({}));
          if (j.via) location.reload(); else msg.textContent = 'Saved, but the server can\'t be reached at those addresses.';
        } }),
        h('button', { text: 'Close', onclick: (e) => { e.preventDefault(); d.close(); d.remove(); } }))));
  document.body.append(d);
  d.showModal();
}

async function start() {
  await detectClient();
  checkVersion();
  try {
    state.meta = await api('/api/meta');
  } catch { return; }
  try {
    const r = await api('/api/rates');
    state.rates = r.values;
  } catch { /* JPY only */ }
  const cur = store.get('currency', 'JPY');
  fillCurrencies();
  $('#currency').value = state.rates[cur] ? cur : 'JPY';
  readUrl();
  if (!state.f.adult && store.get('adult', 'safe') !== 'safe') { state.f.adult = store.get('adult'); writeUrl(false); }
  $('#mode').hidden = !state.meta.semantic;
  if (state.meta.semantic) $('#q').placeholder = 'Search tags, shops, titles… or switch to Meaning  ( / )';
  buildSidebar();
  new IntersectionObserver((en) => { if (en[0].isIntersecting && state.view === 'items') loadMore(); }, { rootMargin: '600px' }).observe($('#sentinel'));
  new IntersectionObserver((en) => { if (en[0].isIntersecting) state.pageMore?.(); }, { rootMargin: '600px' }).observe($('#pageSentinel'));
  render();
  updaterBadge();
}
// ---------- updater badge ----------
function ago(t) {
  const s = (Date.now() - Date.parse(t)) / 1000;
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
async function updaterBadge() {
  try {
    const s = await api('/api/status');
    const b = $('#updBadge');
    b.hidden = false;
    b.className = 'upd' + (!s.updater ? ' off' : s.busy ? ' busy' : '');
    b.textContent = !s.updater ? 'Updater off' : `${s.lastDiscovery ? 'Checked ' + ago(s.lastDiscovery) : 'Checking BOOTH…'} · +${s.newWeek.toLocaleString()} new this week`;
    b.title = [
      `New items: ${s.newToday.toLocaleString()} in 24 h, ${s.newWeek.toLocaleString()} in 7 days`,
      s.pendingDetails ? `${s.pendingDetails.toLocaleString()} new items still loading details` : 'All new items have details',
      s.nextDiscovery ? `Next check: ${new Date(s.nextDiscovery).toLocaleTimeString()}` : '',
      s.backfill ? `Backfill: ${s.backfillRemaining.toLocaleString()} items left` : '',
      'Click to sort by newest',
    ].filter(Boolean).join('\n');
  } catch { /* keep the last state */ }
  setTimeout(updaterBadge, 60000);
}
$('#updBadge').addEventListener('click', () => { $('#sort').value = 'newest'; setFilter('sort', 'newest'); });

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
start();
