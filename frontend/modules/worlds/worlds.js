/* === Search (Worlds, Groups, People) === */
/* === World Tab: Favorites / Search filter === */
document.documentElement.addEventListener('languagechange', () => {
    if (worldFilter === 'explore') { _exploreSyncUi(); renderExplore(); }
});
let _favRefreshTimer = null;
let _favWorldsLoaded = false;
let _worldEditMode = false;
let _worldEditSelected = new Set();
function _scheduleBgFavRefresh() {
    clearTimeout(_favRefreshTimer);
    _favRefreshTimer = setTimeout(() => sendToCS({ action: 'vrcGetFavoriteWorlds' }), 2000);
}
function refreshFavWorlds() {
    const btn = document.getElementById('favWorldsRefreshBtn');
    if (btn) { btn.disabled = true; btn.querySelector('.msi').textContent = 'hourglass_empty'; }
    sendToCS({ action: 'vrcGetFavoriteWorlds' });
}
let _myWorldsLoaded = false;

function getWorldRegionLabel(region) {
    const key = (region || '').toLowerCase();
    const labels = {
        eu: t('worlds.regions.eu', 'Europe'),
        us: t('worlds.regions.us', 'US West'),
        use: t('worlds.regions.use', 'US East'),
        jp: t('worlds.regions.jp', 'Japan')
    };
    return labels[key] || String(region || '').toUpperCase();
}

function getWorldPlayersLabel(count) {
    const key = count === 1 ? 'worlds.meta.players.one' : 'worlds.meta.players.other';
    const fallback = count === 1 ? '{count} player' : '{count} players';
    return tf(key, { count }, fallback);
}

function getWorldVisitCountLabel(count) {
    const key = count === 1 ? 'worlds.time_spent.visits.one' : 'worlds.time_spent.visits.other';
    const fallback = count === 1 ? '{count} visit' : '{count} visits';
    return tf(key, { count }, fallback);
}

function setWorldFilter(filter) {
    if (_worldEditMode) exitWorldEditMode();
    if (filter === 'search' || filter === 'discover') filter = 'explore';   // both live in Explore now (item 14)
    worldFilter = filter;
    worldTagFilter = '';
    document.getElementById('worldFilterFav').classList.toggle('active', filter === 'favorites');
    document.getElementById('worldFilterExplore').classList.toggle('active', filter === 'explore');
    document.getElementById('worldFilterRecent').classList.toggle('active', filter === 'recent');
    document.getElementById('worldFilterMine').classList.toggle('active', filter === 'mine');
    document.getElementById('worldFavArea').style.display     = filter === 'favorites' ? '' : 'none';
    document.getElementById('worldExploreArea').style.display = filter === 'explore'   ? '' : 'none';
    document.getElementById('worldRecentArea').style.display  = filter === 'recent'    ? '' : 'none';
    document.getElementById('worldMineArea').style.display    = filter === 'mine'      ? '' : 'none';
    document.getElementById('worldToolbar')?.classList.toggle('tt-split', filter === 'favorites' || filter === 'explore');
    const editBtn = document.getElementById('worldEditModeBtn');
    if (editBtn) editBtn.style.display = (filter === 'favorites' || filter === 'mine') ? '' : 'none';
    const wlBtn = document.getElementById('worldViewList');
    if (wlBtn) wlBtn.style.display = '';
    setPaginator('worldRecentPaginatorBar', '');
    renderWorldsListView();
    _wdRefreshTagOptions();
    if (filter === 'favorites' && favWorldsData.length === 0) sendToCS({ action: 'vrcGetFavoriteWorlds' });
    if (filter === 'mine' && !_myWorldsLoaded) {
        _myWorldsLoaded = true;
        sendToCS({ action: 'vrcGetMyWorlds' });
    }
    if (filter === 'recent') sendToCS({ action: 'vrcGetVisitedWorlds' });
    if (filter === 'explore') { if (!_explore.started) _exploreApplyStart(); _exploreSyncUi(); _exploreEnsure(); _exploreAskChipSources(); }
}

let _visitedWorldsData = [];
let _worldRecentPage = 0;

function renderVisitedWorlds(worlds) {
    if (Array.isArray(worlds)) { _visitedWorldsData = worlds; _visitedWorldsLoaded = true; }
    _wdUpdateCounts();
    if (worldFilter === 'explore') _exploreRenderChips();
    if (worldFilter === 'explore' && _explore.view === 'foryou') { _exploreEnsure(); renderExplore(); }
    _wdRefreshTagOptions();
    const el = document.getElementById('worldRecentGrid');
    if (!el) return;
    const list = Array.isArray(_visitedWorldsData) ? _visitedWorldsData.filter(_wdHasTag) : _visitedWorldsData;
    if (stillLoading(_visitedWorldsLoaded, false)) {
        el.innerHTML = loadingStateHtml();
        setPaginator('worldRecentPaginatorBar', '');
        return;
    }
    if (!Array.isArray(list) || list.length === 0) {
        el.innerHTML = worldTagFilter
            ? emptyStateHtml('search', t('worlds.tags.no_match', 'No worlds have this tag'))
            : emptyStateHtml('history', t('worlds.recent.empty', 'No recently visited worlds'));
        setPaginator('worldRecentPaginatorBar', '');
        return;
    }
    if (lvViewMode('worlds') === 'list' && lvReady()) {
        lvKeepScroll(el, () => _worldsListPage(el, list, _worldRecentPage, 'worldRecentPaginatorBar', 'worldRecentGoPage', p => { _worldRecentPage = p; }));
        return;
    }
    const per = 100;
    const pages = Math.ceil(list.length / per) || 1;
    if (_worldRecentPage >= pages) _worldRecentPage = pages - 1;
    setPaginator('worldRecentPaginatorBar', pages > 1 ? buildPaginator(_worldRecentPage, pages, 'worldRecentGoPage') : '');
    el.classList.add('search-grid');
    el.innerHTML = list.slice(_worldRecentPage * per, (_worldRecentPage + 1) * per).map(w => renderWorldCard(w)).join('');
}

let _myWorldsData = [];
let _worldMinePage = 0;
let _favWorldsPage = 0;
let _visitedWorldsLoaded = false;
let _myWorldsDataLoaded = false;

function _wdUpdateCounts() {
    const counts = {
        worldFilterFavCount: _favWorldsLoaded ? favWorldsData : null,
        worldFilterRecentCount: _visitedWorldsLoaded ? _visitedWorldsData : null,
        worldFilterMineCount: _myWorldsDataLoaded ? _myWorldsData : null
    };
    Object.keys(counts).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = Array.isArray(counts[id]) ? String(counts[id].length) : 'X';
    });
}

function setWorldsViewMode(mode) {
    lvSetViewMode('worlds', mode);
    _worldMinePage = 0; _favWorldsPage = 0; _worldRecentPage = 0; _explore.page = 0;
    _worldsSyncViewBtns();
    renderWorldsListView();
}

function _worldsSyncViewBtns() {
    const isList = lvViewMode('worlds') === 'list';
    document.getElementById('worldViewList')?.classList.toggle('active', isList);
    if (isList) {
        document.getElementById('worldGridLarge')?.classList.remove('active');
        document.getElementById('worldGridSmall')?.classList.remove('active');
    } else {
        const compact = localStorage.getItem('vrcn_gridSize_worlds') === 'compact';
        document.getElementById('worldGridLarge')?.classList.toggle('active', !compact);
        document.getElementById('worldGridSmall')?.classList.toggle('active', compact);
    }
}

// ---- Tag filter (issue 13): one dropdown for Favorites, Recently Visited and My Worlds ----
let worldTagFilter = '';

/** A readable name for tags people pick (author tags and content warnings); null for system tags. */
function _wdTagLabel(tag) {
    if (typeof tag !== 'string') return null;
    if (tag.startsWith('author_tag_')) return tag.slice(11).replace(/_/g, ' ');
    if (tag.startsWith('content_')) return t('worlds.tags.content', 'Content') + ': ' + tag.slice(8).replace(/_/g, ' ');
    return null;
}

function _wdHasTag(w) { return !worldTagFilter || (Array.isArray(w?.tags) && w.tags.includes(worldTagFilter)); }

function _wdTagSource() {
    if (worldFilter === 'recent') return _visitedWorldsData;
    if (worldFilter === 'mine') return _myWorldsData;
    if (worldFilter === 'favorites') return favWorldGroupFilter ? favWorldsData.filter(w => w.favoriteGroup === favWorldGroupFilter) : favWorldsData;
    return [];
}

/** Lists the tags of the worlds on screen, most common first; only touches the page when the list changed. */
function _wdRefreshTagOptions() {
    const sel = document.getElementById('worldTagFilter');
    const wrap = document.getElementById('worldTagWrap');
    if (!sel) return;
    const counts = new Map();
    for (const w of (Array.isArray(_wdTagSource()) ? _wdTagSource() : []))
        for (const tag of new Set(Array.isArray(w?.tags) ? w.tags : [])) if (_wdTagLabel(tag)) counts.set(tag, (counts.get(tag) || 0) + 1);
    if (worldTagFilter && !counts.has(worldTagFilter)) counts.set(worldTagFilter, 0);
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || _wdTagLabel(a[0]).localeCompare(_wdTagLabel(b[0]))).slice(0, 300);
    if (wrap) wrap.style.display = sorted.length ? '' : 'none';
    const html = `<option value="">${esc(t('worlds.tags.all', 'All tags'))}</option>`
        + sorted.map(([tag, n]) => `<option value="${esc(tag)}">${esc(_wdTagLabel(tag))} (${n})</option>`).join('');
    if (sel._wdTagHtml === html && sel.value === worldTagFilter) return;
    sel._wdTagHtml = html;
    sel.innerHTML = html;
    sel.value = worldTagFilter;
    if (sel._vnRefresh) sel._vnRefresh();
}

function setWorldTagFilter(tag) {
    worldTagFilter = tag || '';
    _worldMinePage = 0; _favWorldsPage = 0; _worldRecentPage = 0;
    renderWorldsListView();
}

function renderWorldsListView() {
    if (worldFilter === 'mine') renderMyWorlds(_myWorldsData);
    else if (worldFilter === 'recent') renderVisitedWorlds();
    else if (worldFilter === 'explore') renderExplore();
    else filterFavWorlds();
}

function setWorldsListPageSize(v) { lvSetPageSize('worlds', v, () => { _worldMinePage = 0; _favWorldsPage = 0; _worldRecentPage = 0; _explore.page = 0; renderWorldsListView(); }); }
function worldMineGoPage(p) { if (p < 0) return; _worldMinePage = p; renderMyWorlds(_myWorldsData); document.getElementById('worldMineGrid')?.scrollTo(0, 0); }
function favWorldsGoPage(p) { if (p < 0) return; _favWorldsPage = p; filterFavWorlds(); document.getElementById('favWorldsGrid')?.scrollTo(0, 0); }
function worldRecentGoPage(p) { if (p < 0) return; _worldRecentPage = p; renderVisitedWorlds(); document.getElementById('worldRecentGrid')?.scrollTo(0, 0); }
function exploreGoPage(p) { if (p < 0) return; _explore.page = p; renderExplore(); document.getElementById('searchWorldsResults')?.scrollTo(0, 0); }

function _wlAuthorTags(w) {
    return (w.tags || []).filter(x => x.startsWith('author_tag_')).map(x => x.replace('author_tag_', ''));
}

function _wlPublished(w) { return w.created_at || w.createdAt || ''; }
function _wlUpdated(w)   { return w.updated_at || w.updatedAt || ''; }

function _wlListDate(value) {
    if (!value) return '';
    const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00' : value;
    const d = new Date(raw);
    return isNaN(d) ? String(value) : fmtShortDate(d);
}

function _wlValue(w, field) {
    switch (field) {
        case 'name':      return (w.name || '').toLowerCase();
        case 'tags':      return _wlAuthorTags(w).join(' ').toLowerCase();
        case 'favorites': return w.favorites || 0;
        case 'users':     return w.occupants || 0;
        case 'visits':    return w.worldVisitCount || 0;
        case 'published': return Date.parse(_wlPublished(w)) || 0;
        case 'updated':   return Date.parse(_wlUpdated(w)) || 0;
        case 'time':      return w.worldTimeSeconds || 0;
        case 'lastseen':  return w.worldLastVisited || '';
        default:          return (w.name || '').toLowerCase();
    }
}

function buildWorldsListHtml(worlds, staticHeader) {
    let rows = '';
    worlds.forEach(w => {
        const wid = jsq(w.id || '');
        const thumb = w.thumbnailImageUrl || w.imageUrl || '';
        const tags = _wlAuthorTags(w);
        const tagsHtml = tags.length
            ? `<div class="lv-tags" title="${esc(tags.join(', '))}">${tags.slice(0, 3).map(x => `<span class="vrcn-badge">${esc(x)}</span>`).join('')}${tags.length > 3 ? `<span class="lv-tags-more">+${tags.length - 3}</span>` : ''}</div>`
            : '';
        rows += tlTableRow('worldsList', ` data-wid="${esc(w.id || '')}" onclick="openWorldSearchDetail('${wid}')"`, {
            icon:      `<td>${lvIcon(thumb, w.name, true)}</td>`,
            name:      `<td class="lv-name">${esc(w.name || '')}</td>`,
            tags:      `<td>${tagsHtml}</td>`,
            favorites: `<td class="lv-num">${w.favorites ? esc(Number(w.favorites).toLocaleString()) : ''}</td>`,
            users:     `<td class="lv-num">${w.occupants ? esc(Number(w.occupants).toLocaleString()) : ''}</td>`,
            visits:    `<td class="lv-num">${w.worldVisitCount ? esc(String(w.worldVisitCount)) : ''}</td>`,
            published: `<td class="lv-sub">${esc(_wlListDate(_wlPublished(w)))}</td>`,
            updated:   `<td class="lv-sub">${esc(_wlListDate(_wlUpdated(w)))}</td>`,
            time:      `<td class="lv-num">${esc(lvDuration(w.worldTimeSeconds))}</td>`,
            lastseen:  `<td class="lv-date">${esc(lvDateTime(w.worldLastVisited))}</td>`,
        });
    });
    return `<div class="lv-scroll">${tlTableHtml('worldsList', rows, staticHeader)}</div>`;
}

function _worldsListPage(el, all, page, barId, pageFn, setPage) {
    const sorted = lvSort(all, 'worldsList', _wlValue);
    const size = lvPageSize('worlds');
    const totalPages = Math.ceil(sorted.length / size) || 1;
    let p = page;
    if (p >= totalPages) p = totalPages - 1;
    if (p < 0) p = 0;
    setPage(p);
    el.classList.remove('search-grid');
    el.innerHTML = buildWorldsListHtml(sorted.slice(p * size, (p + 1) * size));
    lvEditDecorateList(el, 'worlds');
    setPaginator(barId, lvPaginator('worlds', p, totalPages, pageFn, sorted.length, 'setWorldsListPageSize'));
}

function renderMyWorlds(worlds) {
    const el = document.getElementById('worldMineGrid');
    if (!el) return;
    if (Array.isArray(worlds)) { _myWorldsData = worlds; _myWorldsDataLoaded = true; }
    _wdUpdateCounts();
    _wdRefreshTagOptions();
    const list = Array.isArray(_myWorldsData) ? _myWorldsData.filter(_wdHasTag) : _myWorldsData;
    if (stillLoading(_myWorldsDataLoaded)) { el.innerHTML = loadingStateHtml(t('worlds.mine.loading', 'Loading your worlds...')); return; }
    if (worldTagFilter && Array.isArray(list) && list.length === 0) {
        el.innerHTML = emptyStateHtml('search', t('worlds.tags.no_match', 'No worlds have this tag'));
        setPaginator('worldMinePaginatorBar', '');
        return;
    }
    if (!Array.isArray(list) || list.length === 0) {
        el.innerHTML = `<div class="empty-msg"><div class="empty-msg-icon"><span class="msi">upload</span></div><div class="empty-msg-title">${t('worlds.mine.upload_title', 'Upload a world')}</div><div class="empty-msg-desc">${t('worlds.mine.empty', 'No worlds uploaded yet')}</div></div>`;
        setPaginator('worldMinePaginatorBar', '');
        return;
    }
    if (lvViewMode('worlds') === 'list' && lvReady()) {
        lvKeepScroll(el, () => _worldsListPage(el, list, _worldMinePage, 'worldMinePaginatorBar', 'worldMineGoPage', p => { _worldMinePage = p; }));
        return;
    }
    setPaginator('worldMinePaginatorBar', '');
    el.classList.add('search-grid');
    el.innerHTML = list.map(w => renderWorldCard(w)).join('');
}

// ---- Explore (item 14): every public world, replacing the old Discover and Search sub-tabs ----
// Live views ("Active now", "Discover") are VRChat's instance lists grouped by world (vrcGetWorldDiscover); the other
// views are pages of GET /worlds (vrcExploreWorlds). Search text searches VRChat in the API views and only narrows
// the loaded list in the live views. Pages are kept a few minutes, so going back to a view does not call VRChat again.
const _EXPLORE_LIVE = { active: 'popular', discover: 'discover' };   // view -> vrcGetWorldDiscover mode
// Views built here from the user's own lists: Liked, and lists imported from a code or file ("list:<id>").
function _exploreIsLocal(view) { return view === 'liked' || (typeof view === 'string' && view.startsWith('list:')); }
const _EXPLORE_TTL_MS = 5 * 60 * 1000;
const _explore = { view: 'active', query: '', page: 0, entries: {}, shown: [] };

// API pages are keyed by view, text and the filters VRChat applies (sig); live and local views by view only.
function _exploreKey(view, query, sig = _exploreServerSig()) {
    if (_EXPLORE_LIVE[view] || _exploreIsLocal(view)) return view;
    if (view === 'foryou') return view + '|' + sig;   // For You ignores the search text
    return view + '|' + String(query || '').toLowerCase() + '|' + sig;
}

function _exploreEntry(view = _explore.view, query = _explore.query, sig) {
    const key = _exploreKey(view, query, sig);
    const e = _explore.entries[key]
        || (_explore.entries[key] = { worlds: null, offset: 0, hasMore: false, loading: false, failed: false, at: 0 });
    if (_exploreIsLocal(view)) { e.worlds = view === 'liked' ? _exploreLikedList() : _exploreListWorlds(view); e.at = Date.now(); }
    return e;
}

function _exploreReadQuery() {
    const input = document.getElementById('searchWorldsInput');
    if (input) _explore.query = input.value.trim();
    if (!_explore.query && _explore.view === 'relevance') _explore.view = 'active';
}

/** chain = how many requests this click already sent (filters that hide most of a page fetch the next one too). */
function _exploreFetch(view, query, offset, fresh, chain = 0) {
    const e = _exploreEntry(view, query);
    e.loading = true;
    e.failed = false;
    e.chain = chain;
    if (!chain) e.shownBefore = (_exploreVisible(e, view) || []).length;
    if (_EXPLORE_LIVE[view]) sendToCS({ action: 'vrcGetWorldDiscover', mode: _EXPLORE_LIVE[view] });
    else sendToCS({ action: 'vrcExploreWorlds', view, query, offset, fresh: !!fresh, ..._exploreServerParams(), sig: _exploreServerSig() });
    _exploreSyncUi();
    if (worldFilter === 'explore') renderExplore();
}

/** Loads the current view if it has nothing yet (or an API page went stale); fresh = the Refresh button. */
function _exploreEnsure(fresh) {
    if (_exploreIsLocal(_explore.view)) { _exploreListFill(_explore.view); if (fresh && worldFilter === 'explore') renderExplore(); return; }
    if (_explore.view === 'foryou') { _exploreForYouEnsure(fresh); return; }
    const e = _exploreEntry();
    if (e.loading) return;
    const stale = !Array.isArray(e.worlds) || (!_EXPLORE_LIVE[_explore.view] && Date.now() - e.at > _EXPLORE_TTL_MS);
    if (fresh || stale) _exploreFetch(_explore.view, _explore.query, 0, fresh);
}

function setExploreView(view) {
    _exploreReadQuery();
    if (view === 'relevance' && !_explore.query) return;
    _explore.view = view;
    _explore.page = 0;
    _exploreSyncUi();
    _exploreEnsure();
    renderExplore();
    document.getElementById('searchWorldsResults')?.scrollTo(0, 0);
}

/** Search button / Enter. In a live view a search means "all worlds", so it moves to Best match. */
function exploreSearch() {
    if (worldFilter !== 'explore') setWorldFilter('explore');
    _exploreReadQuery();
    if (_explore.query && (_EXPLORE_LIVE[_explore.view] || _explore.view === 'foryou')) _explore.view = 'relevance';
    _explore.page = 0;
    _exploreSyncUi();
    _exploreEnsure();
    renderExplore();
}

function exploreRefresh() { _exploreReadQuery(); _exploreEnsure(true); }

function exploreLoadMore() {
    if (_EXPLORE_LIVE[_explore.view] || _exploreIsLocal(_explore.view) || _explore.view === 'foryou') return;
    const e = _exploreEntry();
    if (e.loading || !e.hasMore) return;
    _exploreFetch(_explore.view, _explore.query, e.offset, false);
}

function _exploreAfterLoad(view, query, sig) {
    if (_exploreKey(view, query, sig) !== _exploreKey(_explore.view, _explore.query)) return;
    _exploreSyncUi();
    if (worldFilter === 'explore') renderExplore();
}

function _exploreLoadFailed(e) {
    if (Array.isArray(e.worlds)) showToast(false, t('worlds.discover.load_failed', 'Could not load worlds'));
    else e.failed = true;
}

/** Live views (instance lists). */
function onWorldDiscover(payload) {
    const view = payload.mode === 'discover' ? 'discover' : 'active';
    const e = _exploreEntry(view, '');
    e.loading = false;
    if (payload.ok) { e.worlds = payload.worlds || []; e.at = Date.now(); e.hasMore = false; }
    else _exploreLoadFailed(e);
    _exploreAfterLoad(view, '');
}

/** API views (GET /worlds pages). Offset 0 replaces the list, later pages add worlds not shown yet. */
function onExploreResults(payload) {
    const query = payload.query || '';
    const sig = typeof payload.sig === 'string' ? payload.sig : _exploreServerSig();
    const e = _exploreEntry(payload.view, query, sig);
    e.loading = false;
    if (payload.ok) {
        const add = Array.isArray(payload.worlds) ? payload.worlds : [];
        if (payload.offset > 0 && Array.isArray(e.worlds)) {
            const seen = new Set(e.worlds.map(w => w.id));
            e.worlds = e.worlds.concat(add.filter(w => !seen.has(w.id)));
        } else {
            e.worlds = add;
            e.at = Date.now();
        }
        e.offset = (payload.offset || 0) + add.length;
        e.hasMore = !!payload.hasMore;
        // "New" comes newest first: once a page reaches past the Published limit, later pages cannot match.
        const lastAt = add.length ? _exploreWorldTime(add[add.length - 1]) : 0;
        if (payload.view === 'new' && _exploreFilters.age && lastAt && Date.now() - lastAt > _exploreFilters.age * 86400000) e.hasMore = false;
        if (_exploreChainOn(e, payload.view, query, sig)) return;
    } else _exploreLoadFailed(e);
    _exploreAfterLoad(payload.view, query, sig);
}

function _exploreSyncUi() {
    const live = !!_EXPLORE_LIVE[_explore.view];
    document.querySelectorAll('#exploreViewBtns [id^="exploreView_"]')
        .forEach(b => b.classList.toggle('active', b.id === 'exploreView_' + _explore.view));
    document.getElementById('exploreRowsBtn')?.classList.toggle('active', _explore.view.startsWith('row:'));
    document.getElementById('exploreSavedBtn')?.classList.toggle('active', _explore.view.startsWith('list:'));
    const rel = document.getElementById('exploreView_relevance');
    if (rel) rel.style.display = _explore.query ? '' : 'none';
    const loading = _exploreEntry().loading;
    const btn = document.getElementById('exploreRefreshBtn');
    if (btn) {
        btn.disabled = loading;
        const ico = btn.querySelector('.msi');
        if (ico) ico.textContent = loading ? 'hourglass_empty' : 'refresh';
    }
    const count = _exploreFilterCount();
    const fbtn = document.getElementById('exploreFilterBtn');
    if (fbtn) {
        fbtn.classList.toggle('active', count > 0);
        const c = fbtn.querySelector('.explore-filter-count');
        if (c) { c.textContent = count ? String(count) : ''; c.style.display = count ? '' : 'none'; }
    }
    _exploreRenderChips();
    const note = document.getElementById('exploreNote');
    if (note) {
        const view = _explore.view;
        const all = _exploreEntry().worlds;
        const passing = count && Array.isArray(all) ? all.filter(w => _explorePasses(w, view)) : all;
        const hidden = count && Array.isArray(all) ? all.length - passing.length : 0;
        const personal = Array.isArray(passing) && _explorePersonalHiding(view) ? passing.filter(w => _exploreHiddenWhy(w)).length : 0;
        const text = [
            view === 'foryou' ? _exploreForYouNote() : '',
            view.startsWith('row:') ? tf('worlds.explore.rows.note', { name: _exploreRowName(view) }, 'VRChat row: {name}.') : '',
            live && _explore.query
                ? tf('worlds.explore.note_live_filter', { query: _explore.query }, 'Showing live worlds whose name, author or tags contain "{query}". Press Search to search all worlds.')
                : '',
            view.startsWith('list:') ? _exploreListNote(view) : '',
            view.startsWith('list:') && _explore.query
                ? tf('worlds.explore.lists.note_filter', { query: _explore.query }, 'Showing worlds in this list whose name, author or tags contain "{query}".')
                : '',
            view === 'liked' && _explore.query
                ? tf('worlds.explore.personal.note_liked_filter', { query: _explore.query }, 'Showing liked worlds whose name, author or tags contain "{query}".')
                : '',
            hidden > 0 ? tf('worlds.explore.filters.note_hidden', { hidden, total: all.length }, 'Filters hide {hidden} of {total} loaded worlds.') : '',
            personal > 0 ? tf('worlds.explore.personal.note_hidden', { n: personal }, 'Your hide list hides {n}.') : '',
        ].filter(Boolean).join(' ');
        note.textContent = text;
        note.style.display = text ? '' : 'none';
    }
}

/** The loaded worlds of a view that pass the filters and the hide list; live and local views are also narrowed by the search text. */
function _exploreVisible(e = _exploreEntry(), view = _explore.view) {
    const all = e.worlds;
    if (!Array.isArray(all)) return null;
    let list = _exploreFilterCount() ? all.filter(w => _explorePasses(w, view)) : all;
    if (_explorePersonalHiding(view)) list = list.filter(w => !_exploreHiddenWhy(w));
    if (view === 'foryou' && !_explorePersonal.feedVisited) list = list.filter(w => !_exploreVisited(w));
    const q = _explore.query.toLowerCase();
    if (q && (_EXPLORE_LIVE[view] || _exploreIsLocal(view))) list = list.filter(w => (w.name || '').toLowerCase().includes(q)
        || (w.authorName || '').toLowerCase().includes(q)
        || _wlAuthorTags(w).some(tag => tag.toLowerCase().includes(q)));
    return _exploreSorted(list);
}

function renderExplore() {
    const el = document.getElementById('searchWorldsResults');
    if (!el) return;
    const e = _exploreEntry();
    const list = _exploreVisible();
    _explore.shown = list || [];
    const moreBtn = e.hasMore && !_EXPLORE_LIVE[_explore.view]
        ? `<button class="vrcn-button load-more-btn" onclick="exploreLoadMore()"${e.loading ? ' disabled' : ''}><span class="msi" style="font-size:16px;">expand_more</span> ${esc(e.loading ? searchLoadingText() : searchLoadMoreText())}</button>`
        : '';
    const more = moreBtn ? `<div class="explore-more">${moreBtn}</div>` : '';
    if (!list || list.length === 0) {
        setPaginator('worldExplorePaginatorBar', '');
        el.classList.add('search-grid');
        if (Array.isArray(list) && _explore.view === 'liked' && !e.worlds.length) el.innerHTML = emptyStateHtml('mood', t('worlds.explore.personal.empty_liked', 'No liked worlds yet. Right-click a world in Explore and choose Like.'));
        else if (Array.isArray(list) && _exploreIsLocal(_explore.view) && !e.worlds.length) el.innerHTML = emptyStateHtml('format_list_bulleted', t('worlds.explore.lists.empty_list', 'This list has no worlds.'));
        else if (Array.isArray(list) && _exploreFilterCount()) el.innerHTML = emptyStateHtml('tune', t('worlds.explore.filters.none_match', 'No worlds match your filters'))
            + `<div class="explore-more"><button class="vrcn-button" onclick="exploreClearFilters()">${esc(t('worlds.explore.filters.clear', 'Clear filters'))}</button> ${moreBtn}</div>`;
        else if (Array.isArray(list) && e.worlds.length && _explorePersonalHiding(_explore.view)) el.innerHTML = emptyStateHtml('visibility_off', t('worlds.explore.personal.all_hidden', 'Every world loaded here is on your hide list.'))
            + (more || '');
        else if (Array.isArray(list)) el.innerHTML = _explore.query
            ? emptyStateHtml('search', t('search.no_results', 'No results found'))
            : emptyStateHtml('public', t('worlds.discover.empty', 'No worlds to show'));
        else if (e.failed) el.innerHTML = emptyStateHtml('error', t('worlds.discover.load_failed', 'Could not load worlds'));
        else el.innerHTML = sk('world', 3);
        return;
    }
    if (lvViewMode('worlds') === 'list' && lvReady()) {
        lvKeepScroll(el, () => { _worldsListPage(el, list, _explore.page, 'worldExplorePaginatorBar', 'exploreGoPage', p => { _explore.page = p; }); _exploreMarkListRows(el, list); });
        if (more) el.insertAdjacentHTML('beforeend', more);
        return;
    }
    setPaginator('worldExplorePaginatorBar', '');
    el.classList.add('search-grid');
    el.innerHTML = list.map(w => renderWorldCard(w, _exploreCardOpts(w))).join('') + more;
}

// ---- Explore filters (item 14, step 2) ----
// Platform, content warnings and tag chips go to VRChat with the request (platform/noplatform, tag/notag), so they
// cover all worlds, not one page. Published, capacity and language are checked here on the worlds already loaded; when
// they hide most of a page, the next page is fetched too, at most three requests per click. Kept between runs.
const _EXPLORE_CONTENT = ['content_sex', 'content_adult', 'content_violence', 'content_gore', 'content_horror', 'content_other'];
const _EXPLORE_AGES = [7, 30, 90, 365, 730, 1095, 1825];   // days
const _EXPLORE_LANGS = ['en', 'ja', 'ko', 'zh', 'ru', 'es', 'fr', 'de', 'pt', 'th'];
const _EXPLORE_VIEW_TAG = { labs: 'system_labs' };          // the tag a view itself asks VRChat for
const _EXPLORE_CHAIN_MAX = 3;                               // requests one click may send when filters hide most of a page
const _EXPLORE_MIN_GAIN = 12;                               // fewer new worlds than this after filtering: fetch the next page
const _EXPLORE_TAG_MAX = 10;
const _EXPLORE_FILTER_DEFAULT = { platform: 'any', hideContent: [], tagsIn: [], tagsOut: [], age: 0, capMin: 0, capMax: 0, lang: 'any', hideVisited: false, friendsOnly: false, ai: 'all' };
const _EXPLORE_LANG_TAGS = {
    en: ['english', 'en', 'eng'],
    ja: ['japanese', 'japan', 'jp', 'ja', '日本語', '日本'],
    ko: ['korean', 'korea', 'kr', 'ko', '한국어', '한국'],
    zh: ['chinese', 'china', 'cn', 'zh', 'mandarin', 'taiwan', '中文', '中国', '中國'],
    ru: ['russian', 'russia', 'ru', 'русский'],
    es: ['spanish', 'espanol', 'español', 'es', 'latino', 'latam'],
    fr: ['french', 'francais', 'français', 'fr'],
    de: ['german', 'deutsch', 'de'],
    pt: ['portuguese', 'portugues', 'português', 'pt', 'brasil', 'brazil', 'br'],
    th: ['thai', 'thailand', 'th', 'ไทย'],
};
// Common words that point to a language written in Latin letters; two or more in a name or description count.
const _EXPLORE_LANG_WORDS = Object.fromEntries(Object.entries({
    en: 'the and with this your you are for welcome enjoy please from have our',
    es: 'el los las una para con por del mundo bienvenidos bienvenido que muy aquí',
    fr: 'le les des une avec pour est et dans sur monde bienvenue cette vous nous',
    de: 'der die das und ist mit für ein eine nicht welt willkommen auf ich wir',
    pt: 'não você voce uma com muito olá isso sua seu nossa dos ao bem',
}).map(([lang, words]) => [lang, new Set(words.split(' '))]));
const _exploreLangMemo = new WeakMap();
const _exploreFilters = _exploreLoadFilters();

function _exploreTagOk(tag) { return typeof tag === 'string' && /^(author_tag_|content_)[^\s,&=?#]{1,64}$/.test(tag); }
function _exploreCap(v) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0; }

function _exploreLoadFilters() {
    try { return _exploreCleanFilters(JSON.parse(localStorage.getItem('vrcn_exploreFilters') || '{}')); }
    catch { return _exploreCleanFilters({}); }
}

/** Filters read back from storage or a saved search: anything unknown or malformed falls back to the default. */
function _exploreCleanFilters(s) {
    const f = { ..._EXPLORE_FILTER_DEFAULT, hideContent: [], tagsIn: [], tagsOut: [] };
    try {
        s = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
        const list = (v, ok) => [...new Set(Array.isArray(v) ? v : [])].filter(ok).slice(0, _EXPLORE_TAG_MAX);
        if (['quest', 'pc', 'ios'].includes(s.platform)) f.platform = s.platform;
        f.hideContent = list(s.hideContent, x => _EXPLORE_CONTENT.includes(x));
        f.tagsIn = list(s.tagsIn, _exploreTagOk);
        f.tagsOut = list(s.tagsOut, x => _exploreTagOk(x) && !f.tagsIn.includes(x));
        if (_EXPLORE_AGES.includes(s.age)) f.age = s.age;
        f.capMin = _exploreCap(s.capMin);
        f.capMax = _exploreCap(s.capMax);
        if (_EXPLORE_LANGS.includes(s.lang)) f.lang = s.lang;
        f.hideVisited = s.hideVisited === true;
        f.friendsOnly = s.friendsOnly === true;
        if (['hide', 'marks'].includes(s.ai)) f.ai = s.ai;
    } catch { }
    return f;
}

function _exploreSaveFilters() { try { localStorage.setItem('vrcn_exploreFilters', JSON.stringify(_exploreFilters)); } catch { } }

/** What VRChat is asked to filter. Part of each page's cache key, so other filters never reuse a page. */
function _exploreServerParams() {
    const f = _exploreFilters;
    return {
        platform: f.platform === 'any' ? '' : f.platform,
        tags: [...f.tagsIn].sort(),
        notags: [...new Set([...f.hideContent, ...f.tagsOut])].sort(),
    };
}

function _exploreServerSig() { const p = _exploreServerParams(); return [p.platform, p.tags.join(','), p.notags.join(',')].join('|'); }

function _exploreFilterCount() {
    const f = _exploreFilters;
    return [f.platform !== 'any', f.hideContent.length > 0, f.tagsIn.length > 0, f.tagsOut.length > 0, f.age > 0,
        f.capMin > 0 || f.capMax > 0, f.lang !== 'any', f.hideVisited, f.friendsOnly, f.ai !== 'all'].filter(Boolean).length;
}

function _explorePlatforms(w) {
    if (Array.isArray(w.platforms)) return w.platforms;
    return Array.isArray(w.unityPackages) ? w.unityPackages.map(p => p?.platform).filter(Boolean) : [];
}

/** When the world was published (its created date when VRChat gives none), in ms; 0 = unknown. */
function _exploreWorldTime(w) {
    for (const v of [w.publicationDate, w.created_at]) {
        const ms = Date.parse(v || '');
        if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return 0;
}

/** Best guess at the languages a world is in, from its author tags and the script and words of its name and description. */
function _exploreLangs(w) {
    let set = _exploreLangMemo.get(w);
    if (set) return set;
    set = new Set();
    for (const tag of _wlAuthorTags(w)) {
        const x = tag.toLowerCase();
        for (const [lang, names] of Object.entries(_EXPLORE_LANG_TAGS)) if (names.includes(x)) set.add(lang);
    }
    const text = `${w.name || ''} ${w.description || ''}`;
    if (/[぀-ヿ]/.test(text)) set.add('ja');
    else if (/[一-鿿]/.test(text)) set.add('zh');
    if (/[가-힯]/.test(text)) set.add('ko');
    if (/[Ѐ-ӿ]/.test(text)) set.add('ru');
    if (/[฀-๿]/.test(text)) set.add('th');
    const words = text.toLowerCase().match(/\p{L}+/gu) || [];
    for (const [lang, dict] of Object.entries(_EXPLORE_LANG_WORDS))
        if (words.filter(x => dict.has(x)).length >= 2) set.add(lang);
    // Latin letters and nothing else found: most such world names are English.
    if (!set.size && /[a-z]/i.test(text)) set.add('en');
    _exploreLangMemo.set(w, set);
    return set;
}

/** Whether a world passes the filters. Lenient where a world lacks the data (no platform list, no date, no capacity). */
function _explorePasses(w, view) {
    const f = _exploreFilters;
    const tags = Array.isArray(w.tags) ? w.tags : [];
    if (f.tagsIn.length) {
        if (!f.tagsIn.some(x => tags.includes(x))) return false;
        // The view's own tags go in the same "any of" list, so check the world really has one of them.
        const own = _exploreViewTags(view);
        if (own.length && !own.some(x => tags.includes(x))) return false;
    }
    if (f.tagsOut.some(x => tags.includes(x)) || f.hideContent.some(x => tags.includes(x))) return false;
    if (f.platform !== 'any') {
        const p = _explorePlatforms(w);
        if (p.length) {
            const quest = p.includes('android'), ios = p.includes('ios'), pc = p.includes('standalonewindows');
            if (f.platform === 'quest' ? !quest : f.platform === 'ios' ? !ios : !(pc && !quest && !ios)) return false;
        }
    }
    if (f.age) {
        const at = _exploreWorldTime(w);
        if (at && Date.now() - at > f.age * 86400000) return false;
    }
    const cap = Number(w.capacity) || 0;
    if (cap && f.capMin && cap < f.capMin) return false;
    if (cap && f.capMax && cap > f.capMax) return false;
    if (f.lang !== 'any' && !_exploreLangs(w).has(f.lang)) return false;
    // Liked worlds are mostly visited ones, so the Liked view keeps them.
    if (f.hideVisited && view !== 'liked' && _exploreVisited(w)) return false;
    if (f.friendsOnly && !_exploreFriendsByWorld().has(w.id)) return false;
    if (f.ai !== 'all') {
        const ai = _exploreAiWhy(w);
        if (ai === 'mark' || (ai === 'text' && f.ai === 'hide')) return false;
    }
    return true;
}

/** Filters or the hide list hid most of what came in: fetch the next page too, up to _EXPLORE_CHAIN_MAX requests for one click. */
function _exploreChainOn(e, view, query, sig) {
    if (!e.hasMore || !(_exploreFilterCount() || _explorePersonalHiding(view)) || (e.chain || 0) + 1 >= _EXPLORE_CHAIN_MAX) return false;
    if (_exploreKey(view, query, sig) !== _exploreKey(_explore.view, _explore.query)) return false;
    if ((_exploreVisible(e, view) || []).length - (e.shownBefore || 0) >= _EXPLORE_MIN_GAIN) return false;
    _exploreFetch(view, query, e.offset, false, (e.chain || 0) + 1);
    return true;
}

function _exploreFiltersChanged() {
    _exploreSaveFilters();
    _explore.page = 0;
    _exploreSyncUi();
    if (worldFilter !== 'explore') return;
    _exploreEnsure();
    renderExplore();
}

function exploreSetFilter(key, value) {
    const f = _exploreFilters;
    if (key === 'platform') f.platform = ['quest', 'pc', 'ios'].includes(value) ? value : 'any';
    else if (key === 'age') f.age = _EXPLORE_AGES.includes(Number(value)) ? Number(value) : 0;
    else if (key === 'capMin' || key === 'capMax') f[key] = _exploreCap(value);
    else if (key === 'lang') f.lang = _EXPLORE_LANGS.includes(value) ? value : 'any';
    else if (key === 'hideVisited') f.hideVisited = value === true || value === 'true';
    else if (key === 'friendsOnly') f.friendsOnly = value === true || value === 'true';
    else if (key === 'ai') f.ai = ['hide', 'marks'].includes(value) ? value : 'all';
    else return;
    _exploreFiltersChanged();
}

function exploreToggleContent(tag, on) {
    if (!_EXPLORE_CONTENT.includes(tag)) return;
    const f = _exploreFilters;
    f.hideContent = f.hideContent.filter(x => x !== tag);
    if (on) f.hideContent.push(tag);
    _exploreFiltersChanged();
}

/** Tag chip click: off -> only worlds with the tag -> hide worlds with the tag -> off. */
function exploreCycleTag(tag) {
    if (!_exploreTagOk(tag)) return;
    const f = _exploreFilters;
    if (f.tagsIn.includes(tag)) {
        f.tagsIn = f.tagsIn.filter(x => x !== tag);
        if (f.tagsOut.length < _EXPLORE_TAG_MAX) f.tagsOut.push(tag);
    } else if (f.tagsOut.includes(tag)) f.tagsOut = f.tagsOut.filter(x => x !== tag);
    else if (f.tagsIn.length < _EXPLORE_TAG_MAX) f.tagsIn.push(tag);
    else return;
    _exploreFiltersChanged();
}

/** A tag typed in the filter panel ("chill", "#Flowers", "night life") becomes an "only worlds with" chip. */
function exploreAddTag(text) {
    let tag = String(text || '').trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '_');
    if (!tag) return;
    if (!/^(author_tag_|content_)/.test(tag)) tag = 'author_tag_' + tag;
    if (!_exploreTagOk(tag)) { showToast(false, t('worlds.explore.filters.bad_tag', 'A tag cannot contain , & = ? or #')); return; }
    const f = _exploreFilters;
    f.tagsOut = f.tagsOut.filter(x => x !== tag);
    if (!f.tagsIn.includes(tag)) {
        if (f.tagsIn.length >= _EXPLORE_TAG_MAX) return;
        f.tagsIn.push(tag);
    }
    const input = document.getElementById('exploreTagInput');
    if (input) input.value = '';
    _exploreFiltersChanged();
}

function exploreClearFilters() {
    Object.assign(_exploreFilters, _EXPLORE_FILTER_DEFAULT, { hideContent: [], tagsIn: [], tagsOut: [] });
    const panel = document.getElementById('exploreFilterPanel');
    if (panel && panel.style.display === 'block') panel.innerHTML = _exploreFilterHtml();
    _exploreFiltersChanged();
}

/** Chips: the tags already picked, then the author tags most common in the user's favorite and visited worlds. */
function _exploreChipTags() {
    const f = _exploreFilters;
    const counts = new Map();
    const seen = new Set();
    const lists = [typeof favWorldsData !== 'undefined' ? favWorldsData : [], _visitedWorldsData];
    for (const list of lists) for (const w of (Array.isArray(list) ? list : [])) {
        if (!w || !w.id || seen.has(w.id)) continue;
        seen.add(w.id);
        for (const tag of new Set(Array.isArray(w.tags) ? w.tags : []))
            if (tag.startsWith('author_tag_') && _exploreTagOk(tag)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(x => x[0])
        .filter(tag => !f.tagsIn.includes(tag) && !f.tagsOut.includes(tag)).slice(0, 16);
    return [...f.tagsIn, ...f.tagsOut, ...top];
}

function _exploreRenderChips() {
    const row = document.getElementById('exploreChips');
    if (!row) return;
    const f = _exploreFilters;
    const tags = _exploreChipTags();
    const hint = esc(t('worlds.explore.filters.chip_hint', 'Click: only worlds with this tag. Again: hide worlds with it. Again: off.'));
    const html = tags.length
        ? `<span class="explore-chips-label">${esc(t('worlds.explore.filters.tags', 'Tags'))}</span>` + tags.map(tag => {
            const state = f.tagsIn.includes(tag) ? 'in' : f.tagsOut.includes(tag) ? 'out' : '';
            const icon = state === 'in' ? 'check' : state === 'out' ? 'block' : 'add';
            return `<button class="explore-chip${state ? ' ' + state : ''}" data-tag="${esc(tag)}" onclick="exploreCycleTag(this.dataset.tag)" title="${hint}"><span class="msi">${icon}</span>${esc(_wdTagLabel(tag) || tag)}</button>`;
        }).join('')
        : '';
    row.style.display = html ? '' : 'none';
    if (row._html === html) return;
    row._html = html;
    row.innerHTML = html;
}

/** The user's favorite worlds come with the Worlds tab; their visited worlds are asked for once, for the chips. */
function _exploreAskChipSources() {
    if (_explore.askedVisited || _visitedWorldsLoaded) return;
    _explore.askedVisited = true;
    sendToCS({ action: 'vrcGetVisitedWorlds' });
}

function _exploreLangName(code) {
    try { return new Intl.DisplayNames([typeof getLanguageLocale === 'function' ? getLanguageLocale() : 'en-US'], { type: 'language' }).of(code) || code; }
    catch { return code; }
}

function _exploreFilterHtml() {
    const f = _exploreFilters;
    const L = (key, fallback) => esc(t('worlds.explore.filters.' + key, fallback));
    const A = (key, fallback) => esc(t('worlds.explore.active.' + key, fallback));
    const opt = (v, label, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
    const ages = _EXPLORE_AGES.map(d => opt(d, d < 365 ? tf('worlds.explore.filters.age_days', { n: d }, 'Last {n} days')
        : d === 365 ? t('worlds.explore.filters.age_year', 'Last year')
        : tf('worlds.explore.filters.age_years', { n: Math.round(d / 365) }, 'Last {n} years'), f.age)).join('');
    const cw = {
        content_sex: 'Sexually suggestive', content_adult: 'Adult language and themes', content_violence: 'Graphic violence',
        content_gore: 'Excessive gore', content_horror: 'Extreme horror', content_other: 'Other warnings',
    };
    const content = _EXPLORE_CONTENT.map(tag => `<label class="explore-cw"><input type="checkbox"${f.hideContent.includes(tag) ? ' checked' : ''} onchange="exploreToggleContent('${tag}', this.checked)"> <span>${L('cw_' + tag.slice(8), cw[tag])}</span></label>`).join('');
    return `<div class="av-more-title">${L('title', 'Filters')}</div>
        <div class="av-more-row"><span>${L('platform', 'Platform')}</span>
            <select class="vrcn-dropdown" onchange="exploreSetFilter('platform', this.value)">${opt('any', t('worlds.explore.filters.platform_any', 'Any platform'), f.platform)}${opt('quest', t('worlds.explore.filters.platform_quest', 'Quest / Android'), f.platform)}${opt('pc', t('worlds.explore.filters.platform_pc', 'PC only'), f.platform)}${opt('ios', 'iOS', f.platform)}</select></div>
        <div class="av-more-row explore-cw-row"><span>${L('content', 'Hide warnings')}</span><div class="explore-cw-grid">${content}</div></div>
        <div class="av-more-row"><span>${L('published', 'Published')}</span>
            <select class="vrcn-dropdown" onchange="exploreSetFilter('age', this.value)">${opt(0, t('worlds.explore.filters.age_any', 'Any time'), f.age)}${ages}</select></div>
        <div class="av-more-row"><span>${L('capacity', 'Capacity')}</span>
            <input type="number" min="1" max="999" class="vrcn-input" placeholder="${L('min', 'Min')}" value="${f.capMin || ''}" onchange="exploreSetFilter('capMin', this.value)">
            <input type="number" min="1" max="999" class="vrcn-input" placeholder="${L('max', 'Max')}" value="${f.capMax || ''}" onchange="exploreSetFilter('capMax', this.value)"></div>
        <div class="av-more-row"><span>${L('language', 'Language')}</span>
            <select class="vrcn-dropdown" onchange="exploreSetFilter('lang', this.value)">${opt('any', t('worlds.explore.filters.lang_any', 'Any language'), f.lang)}${_EXPLORE_LANGS.map(c => opt(c, _exploreLangName(c), f.lang)).join('')}</select></div>
        <div class="av-more-row"><span>${L('add_tag', 'Add tag')}</span>
            <input id="exploreTagInput" type="text" class="vrcn-input" maxlength="64" placeholder="${L('tag_placeholder', 'e.g. chill, then Enter')}" onkeydown="if(event.key==='Enter')exploreAddTag(this.value)"></div>
        <div class="av-more-row"><span>${L('visited', 'Visited')}</span>
            <div class="explore-cw-stack"><label class="explore-cw"><input type="checkbox" id="exploreHideVisited"${f.hideVisited ? ' checked' : ''} onchange="exploreSetFilter('hideVisited', this.checked)"> <span>${L('hide_visited', 'Hide worlds I have visited')}</span></label>
            <label class="explore-cw"><input type="checkbox" id="exploreFeedVisited"${_explorePersonal.feedVisited ? ' checked' : ''} onchange="exploreFeedVisited(this.checked)"> <span>${esc(t('worlds.explore.foryou.show_visited', 'Show visited worlds in For You'))}</span></label></div></div>
        <div class="av-more-row"><span>${A('friends', 'Friends')}</span>
            <label class="explore-cw"><input type="checkbox" id="exploreFriendsOnly"${f.friendsOnly ? ' checked' : ''} onchange="exploreSetFilter('friendsOnly', this.checked)"> <span>${A('friends_only', 'Only worlds where friends are now')}</span></label></div>
        <div class="av-more-row"><span>${A('order', 'Order')}</span>
            <select id="exploreOrder" class="vrcn-dropdown" onchange="exploreSetOrder(this.value)">${opt('default', t('worlds.explore.active.order_default', "VRChat's order"), _exploreOrder)}${opt('people', t('worlds.explore.active.order_people', 'People here now'), _exploreOrder)}${opt('friends', t('worlds.explore.active.order_friends', 'Friends here first'), _exploreOrder)}</select></div>
        <div class="explore-filter-hint">${L('hint', 'VRChat applies platform, warnings and tags to all worlds. Published, capacity and language check the worlds loaded so far; language is a best guess from tags and text.')}</div>
        ${_explorePersonalHtml()}
        ${_exploreAiHtml()}
        <div class="av-more-foot"><button class="vrcn-button" onclick="exploreClearFilters()">${L('clear', 'Clear filters')}</button></div>`;
}

function exploreToggleFilters(btn) {
    let panel = document.getElementById('exploreFilterPanel');
    if (panel && panel.style.display === 'block') { panel.style.display = 'none'; return; }
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'exploreFilterPanel';
        panel.className = 'av-more-panel explore-filter-panel';
        document.body.appendChild(panel);
        document.addEventListener('mousedown', e => {
            if (panel.style.display !== 'block' || panel.contains(e.target) || e.target.closest?.('#exploreFilterBtn, .vn-select-panel, .vn-select')) return;
            panel.style.display = 'none';
        }, true);
    }
    panel.innerHTML = _exploreFilterHtml();
    const r = btn.getBoundingClientRect();
    panel.style.top = Math.round(r.bottom + 6) + 'px';
    panel.style.left = Math.round(Math.max(8, Math.min(r.right - 380, innerWidth - 388))) + 'px';
    panel.style.maxHeight = Math.max(200, Math.round(innerHeight - r.bottom - 18)) + 'px';   // the hide list makes it tall
    panel.style.display = 'block';
}

// ---- Explore: Active now (item 14, step 4) ----
// Cards say which friends are in the world now, from the friends list HapsHub already keeps (no request). The loaded
// worlds can be ordered by people there now or friends first, and narrowed to worlds where friends are.
const _EXPLORE_ORDERS = ['default', 'people', 'friends'];
let _exploreOrder = (() => { try { const v = localStorage.getItem('vrcn_exploreOrder'); return _EXPLORE_ORDERS.includes(v) ? v : 'default'; } catch { return 'default'; } })();
let _exploreFriendsMemo = { src: null, len: -1, at: 0, map: new Map() };

/** World id -> names of the friends in it now. Rebuilt when the friends list changes, at most every few seconds. */
function _exploreFriendsByWorld() {
    const src = typeof vrcFriendsData !== 'undefined' && Array.isArray(vrcFriendsData) ? vrcFriendsData : [];
    const m = _exploreFriendsMemo;
    if (m.src === src && m.len === src.length && Date.now() - m.at < 5000) return m.map;
    const map = new Map();
    for (const f of src) {
        const loc = typeof f?.location === 'string' ? f.location : '';
        if (!loc.startsWith('wrld_')) continue;
        const wid = loc.split(':')[0];
        if (!map.has(wid)) map.set(wid, []);
        map.get(wid).push(String(f.displayName || f.id || ''));
    }
    _exploreFriendsMemo = { src, len: src.length, at: Date.now(), map };
    return map;
}

/** The order picked in Filters: VRChat's, people in the world now, or friends there first (then people). */
function _exploreSorted(list) {
    if (_exploreOrder === 'default' || list.length < 2) return list;
    const people = w => Number(w.occupants) || 0;
    const friends = _exploreOrder === 'friends' ? _exploreFriendsByWorld() : null;
    const nf = w => friends ? (friends.get(w.id)?.length || 0) : 0;
    return list.map((w, i) => [w, i]).sort((a, b) => nf(b[0]) - nf(a[0]) || people(b[0]) - people(a[0]) || a[1] - b[1]).map(x => x[0]);
}

function exploreSetOrder(value) {
    _exploreOrder = _EXPLORE_ORDERS.includes(value) ? value : 'default';
    try { localStorage.setItem('vrcn_exploreOrder', _exploreOrder); } catch { }
    _explore.page = 0;
    if (worldFilter === 'explore') renderExplore();
}

// ---- Explore personal tools (item 14, step 3) ----
// Likes, dislikes and the hide list are kept on this computer only (localStorage vrcn_explorePersonal), never sent to
// VRChat. A dislike, or a hidden world, author or tag, takes worlds out of Explore; "Show hidden worlds" brings them
// back, marked, so the right-click menu can restore them. A like wins over a hidden author or tag. Liked worlds have
// their own view, from a copy of each world kept at the time of the like.
const _EXPLORE_KEEP = { liked: 1000, disliked: 5000, worlds: 5000, authors: 1000, tags: 200, ai: 5000, aiAuthors: 1000 };
const _EXPLORE_SNAPSHOT = ['name', 'authorName', 'authorId', 'thumbnailImageUrl', 'imageUrl', 'tags', 'capacity', 'favorites',
    'occupants', 'visits', 'platforms', 'publicationDate', 'created_at', 'updated_at', 'description'];
const _explorePersonal = _exploreLoadPersonal();
let _exploreLikedMemo = null;
let _exploreVisitedMemo = { src: null, ids: new Set() };

function _exploreIdOk(id, prefix = '') { return typeof id === 'string' && id.length <= 80 && id.startsWith(prefix) && /^[\w-]+$/.test(id); }
function _exploreHas(m) { for (const k in m) return true; return false; }

function _exploreLoadPersonal() {
    const p = { liked: {}, disliked: {}, worlds: {}, authors: {}, tags: [], showHidden: false, ai: {}, aiAuthors: {}, feedVisited: false };
    try {
        const s = JSON.parse(localStorage.getItem('vrcn_explorePersonal') || '{}') || {};
        const map = (v, prefix, max) => Object.fromEntries(Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
            .filter(([id, x]) => _exploreIdOk(id, prefix) && x && typeof x === 'object' && !Array.isArray(x))
            .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0)).slice(0, max));
        p.liked = map(s.liked, 'wrld_', _EXPLORE_KEEP.liked);
        p.disliked = map(s.disliked, 'wrld_', _EXPLORE_KEEP.disliked);
        p.worlds = map(s.worlds, 'wrld_', _EXPLORE_KEEP.worlds);
        p.authors = map(s.authors, '', _EXPLORE_KEEP.authors);
        p.tags = [...new Set(Array.isArray(s.tags) ? s.tags : [])].filter(_exploreTagOk).slice(0, _EXPLORE_KEEP.tags);
        p.showHidden = s.showHidden === true;
        p.feedVisited = s.feedVisited === true;
        p.ai = map(s.ai, 'wrld_', _EXPLORE_KEEP.ai);
        p.aiAuthors = map(s.aiAuthors, '', _EXPLORE_KEEP.aiAuthors);
    } catch { }
    return p;
}

function _exploreSavePersonal() {
    _exploreLikedMemo = null;
    try { localStorage.setItem('vrcn_explorePersonal', JSON.stringify(_explorePersonal)); } catch { }
}

/** Adds or refreshes an entry; past the limit the oldest entries go. */
function _explorePut(name, id, value) {
    const m = _explorePersonal[name];
    delete m[id];
    m[id] = { ...value, at: Date.now() };
    const ids = Object.keys(m);
    if (ids.length > _EXPLORE_KEEP[name])
        ids.sort((a, b) => (m[a].at || 0) - (m[b].at || 0)).slice(0, ids.length - _EXPLORE_KEEP[name]).forEach(k => delete m[k]);
}

function _exploreSnapshot(w) {
    const o = {};
    for (const k of _EXPLORE_SNAPSHOT) if (w[k] != null && w[k] !== '') o[k] = k === 'description' ? String(w[k]).slice(0, 300) : w[k];
    if (!o.platforms && Array.isArray(w.unityPackages)) o.platforms = _explorePlatforms(w);
    return o;
}

/** The Liked view: newest like first. */
function _exploreLikedList() {
    if (_exploreLikedMemo) return _exploreLikedMemo;
    const m = _explorePersonal.liked;
    return (_exploreLikedMemo = Object.keys(m).sort((a, b) => (m[b].at || 0) - (m[a].at || 0))
        .map(id => ({ occupants: 0, favorites: 0, ...m[id], id })));
}

/** Visited = HapsHub's own visit history: the count on the row, or the visited list asked for when Explore opens. */
function _exploreVisited(w) {
    if (!w) return false;
    if (Number(w.worldVisitCount) > 0) return true;
    const src = typeof _visitedWorldsData !== 'undefined' ? _visitedWorldsData : null;
    if (_exploreVisitedMemo.src !== src)
        _exploreVisitedMemo = { src, ids: new Set((Array.isArray(src) ? src : []).map(x => x && x.id).filter(Boolean)) };
    return _exploreVisitedMemo.ids.has(w.id);
}

/** Why the hide list takes a world out: 'disliked', 'world', 'author', 'tag', or '' when it stays. */
function _exploreHiddenWhy(w) {
    const p = _explorePersonal;
    if (!w || p.liked[w.id]) return '';
    if (p.disliked[w.id]) return 'disliked';
    if (p.worlds[w.id]) return 'world';
    if (w.authorId && p.authors[w.authorId]) return 'author';
    if (p.tags.length && Array.isArray(w.tags) && p.tags.some(x => w.tags.includes(x))) return 'tag';
    return '';
}

/** Whether the hide list takes worlds out of this view: not in Liked, not while "Show hidden worlds" is on. */
function _explorePersonalHiding(view = _explore.view) {
    const p = _explorePersonal;
    return !_exploreIsLocal(view) && !p.showHidden
        && (p.tags.length > 0 || _exploreHas(p.disliked) || _exploreHas(p.worlds) || _exploreHas(p.authors));
}

/** List view: the rows get the same dimming as the cards while "Show hidden worlds" is on, with the reason as tooltip. */
function _exploreMarkListRows(el, list) {
    if (!_explorePersonal.showHidden || _exploreIsLocal(_explore.view)) return;
    const byId = new Map(list.map(w => [w.id, w]));
    el.querySelectorAll('[data-wid]').forEach(row => {
        const w = byId.get(row.dataset.wid);
        const why = w ? _exploreHiddenWhy(w) : '';
        if (!why) return;
        row.classList.add('explore-hidden');
        row.title = why === 'disliked' ? t('worlds.explore.personal.badge_disliked', 'Disliked') : t('worlds.explore.personal.badge_hidden', 'Hidden');
    });
}

/** Badges and an extra class for an Explore card: Liked, Hidden/Disliked (while shown), Visited. */
function _exploreCardOpts(w) {
    const P = (key, fallback) => esc(t('worlds.explore.personal.' + key, fallback));
    const p = _explorePersonal;
    const badges = [];
    if (p.liked[w.id]) badges.push(`<span class="explore-badge liked" title="${P('badge_liked', 'Liked')}"><span class="msi">mood</span></span>`);
    const why = p.showHidden && !_exploreIsLocal(_explore.view) ? _exploreHiddenWhy(w) : '';
    if (why) badges.push(why === 'disliked'
        ? `<span class="explore-badge hidden"><span class="msi">do_not_disturb</span>${P('badge_disliked', 'Disliked')}</span>`
        : `<span class="explore-badge hidden"><span class="msi">visibility_off</span>${P('badge_hidden', 'Hidden')}</span>`);
    const ai = _exploreAiWhy(w);
    if (ai) badges.push(ai === 'mark'
        ? `<span class="explore-badge ai" title="${esc(t('worlds.explore.ai.badge_mark_tip', 'You marked this as AI. Kept on this computer only.'))}"><span class="msi">smart_toy</span>${esc(t('worlds.explore.ai.badge_mark', 'AI'))}</span>`
        : `<span class="explore-badge ai maybe" title="${esc(t('worlds.explore.ai.badge_maybe_tip', 'Guessed from its tags, name and description. Not a fact.'))}"><span class="msi">smart_toy</span>${esc(t('worlds.explore.ai.badge_maybe', 'Maybe AI'))}</span>`);
    const friends = _exploreFriendsByWorld().get(w.id);
    if (friends) badges.push(`<span class="explore-badge friends" title="${esc(tf('worlds.explore.active.friends_here', { names: friends.join(', ') }, 'Friends here now: {names}'))}"><span class="msi">group</span>${friends.length}</span>`);
    if (_exploreVisited(w)) {
        const n = Number(w.worldVisitCount) || 0;
        const title = n ? esc(tf('worlds.explore.personal.visits', { n }, 'Visits: {n}')) : P('badge_visited', 'Visited');
        badges.push(`<span class="explore-badge visited" title="${title}"><span class="msi">history</span>${P('badge_visited', 'Visited')}</span>`);
    }
    const feed = _explore.view === 'foryou' ? _exploreFeedWhy.get(w.id) : null;
    const reason = !feed ? '' : feed.kind === 'new' ? t('worlds.explore.foryou.why_new', 'Something new')
        : feed.tags.length ? tf('worlds.explore.foryou.why', { tags: feed.tags.map(tag => _wdTagLabel(tag) || tag).join(', ') }, 'Because you like {tags}') : '';
    return { badges: (badges.length ? `<div class="explore-badges">${badges.join('')}</div>` : '')
        + (reason ? `<div class="explore-why" title="${esc(reason)}"><span class="msi">auto_awesome</span>${esc(reason)}</div>` : ''), cls: why ? ' explore-hidden' : '' };
}

function _exploreFindWorld(id) {
    const hit = list => (Array.isArray(list) ? list : []).find(w => w && w.id === id);
    let w = hit(_explore.shown);
    if (w) return w;
    for (const e of Object.values(_explore.entries)) if ((w = hit(e.worlds))) return w;
    return _explorePersonal.liked[id] ? { ..._explorePersonal.liked[id], id } : null;
}

function _explorePersonalChanged() {
    _exploreSavePersonal();
    _exploreSyncUi();
    const panel = document.getElementById('exploreFilterPanel');
    if (panel && panel.style.display === 'block') panel.innerHTML = _exploreFilterHtml();
    if (worldFilter === 'explore') renderExplore();
}

function exploreSetLike(id, on) {
    if (!_exploreIdOk(id, 'wrld_')) return;
    const p = _explorePersonal;
    if (on) {
        const w = _exploreFindWorld(id) || { id };
        _explorePut('liked', id, _exploreSnapshot(w));
        delete p.disliked[id];
        delete p.worlds[id];
        showToast(true, tf('worlds.explore.personal.toast_liked', { name: w.name || id }, '"{name}" added to Liked.'));
    } else delete p.liked[id];
    _explorePersonalChanged();
}

function exploreSetDislike(id, on) {
    if (!_exploreIdOk(id, 'wrld_')) return;
    const p = _explorePersonal;
    if (on) {
        const w = _exploreFindWorld(id) || { id };
        const tags = (Array.isArray(w.tags) ? w.tags : []).filter(x => x.startsWith('author_tag_')).slice(0, 20);
        _explorePut('disliked', id, { name: w.name || '', authorId: w.authorId || '', tags });
        delete p.liked[id];
        showToast(true, tf('worlds.explore.personal.toast_disliked', { name: w.name || id }, '"{name}" disliked and hidden.'));
    } else delete p.disliked[id];
    _explorePersonalChanged();
}

function exploreHideWorld(id, on) {
    if (!_exploreIdOk(id, 'wrld_')) return;
    const p = _explorePersonal;
    if (on) {
        const w = _exploreFindWorld(id) || { id };
        _explorePut('worlds', id, { name: w.name || '', authorId: w.authorId || '' });
        delete p.liked[id];
        showToast(true, tf('worlds.explore.personal.toast_hidden', { name: w.name || id }, '"{name}" hidden. Filters > Show hidden worlds brings it back.'));
    } else delete p.worlds[id];
    _explorePersonalChanged();
}

function exploreHideAuthor(authorId, name, on) {
    if (!_exploreIdOk(authorId)) return;
    if (on) {
        _explorePut('authors', authorId, { name: String(name || '').slice(0, 80) });
        showToast(true, tf('worlds.explore.personal.toast_author', { name: name || authorId }, 'Worlds by {name} hidden. Filters lists hidden authors.'));
    } else delete _explorePersonal.authors[authorId];
    _explorePersonalChanged();
}

function exploreHideTag(tag, on) {
    if (!_exploreTagOk(tag)) return;
    const p = _explorePersonal;
    p.tags = p.tags.filter(x => x !== tag);
    if (on) {
        if (p.tags.length >= _EXPLORE_KEEP.tags) return;
        p.tags.push(tag);
        showToast(true, tf('worlds.explore.personal.toast_tag', { tag: _wdTagLabel(tag) || tag }, 'Worlds tagged {tag} hidden. Filters lists hidden tags.'));
    }
    _explorePersonalChanged();
}

function exploreShowHidden(on) { _explorePersonal.showHidden = !!on; _explorePersonalChanged(); }

function exploreUnhideChip(kind, key) {
    if (kind === 'author') exploreHideAuthor(key, '', false);
    else if (kind === 'tag') exploreHideTag(key, false);
    else if (kind === 'aiauthor') exploreMarkAiAuthor(key, '', false);
}

/** Right-click items for an Explore card; context-menu.js adds them under the usual world items (`sub` = a submenu). */
function exploreContextItems(id) {
    if (!_exploreIdOk(id, 'wrld_')) return [];
    const p = _explorePersonal;
    const w = _exploreFindWorld(id) || { id };
    const P = (key, fallback) => t('worlds.explore.personal.' + key, fallback);
    const liked = !!p.liked[id], disliked = !!p.disliked[id], hidden = !!p.worlds[id];
    const items = [
        { icon: 'mood', filled: liked, checked: liked, label: P('like', 'Like'), action: () => exploreSetLike(id, !liked) },
        { icon: 'do_not_disturb', filled: disliked, checked: disliked, label: P('dislike', 'Dislike (hide)'), action: () => exploreSetDislike(id, !disliked) },
        { icon: 'visibility_off', checked: hidden, label: P('hide_world', 'Hide this world'), action: () => exploreHideWorld(id, !hidden) },
    ];
    if (_exploreIdOk(w.authorId)) {
        const on = !!p.authors[w.authorId];
        items.push({ icon: 'no_accounts', checked: on,
            label: w.authorName ? tf('worlds.explore.personal.hide_author', { name: w.authorName }, 'Hide all worlds by {name}') : P('hide_author_unknown', 'Hide all worlds by this author'),
            action: () => exploreHideAuthor(w.authorId, w.authorName || '', !on) });
    }
    const tags = (Array.isArray(w.tags) ? w.tags : []).filter(x => x.startsWith('author_tag_') && _exploreTagOk(x)).slice(0, 12);
    if (tags.length) items.push({ icon: 'label', label: P('hide_tag', 'Hide a tag'), sub: tags.map(tag => {
        const on = p.tags.includes(tag);
        const name = _wdTagLabel(tag) || tag;
        return { icon: on ? 'visibility' : 'visibility_off', label: on ? tf('worlds.explore.personal.unhide_tag', { tag: name }, 'Unhide {tag}') : tf('worlds.explore.personal.hide_tag_item', { tag: name }, 'Hide {tag}'),
            action: () => exploreHideTag(tag, !on) };
    }) });
    const A = (key, fallback) => t('worlds.explore.ai.' + key, fallback);
    const aiOn = !!p.ai[id];
    items.push({ icon: 'smart_toy', checked: aiOn, label: A('mark', 'Mark as AI'), action: () => exploreMarkAi(id, !aiOn) });
    if (_exploreIdOk(w.authorId)) {
        const on = !!p.aiAuthors[w.authorId];
        items.push({ icon: 'smart_toy', checked: on,
            label: w.authorName ? tf('worlds.explore.ai.mark_author', { name: w.authorName }, 'Mark all worlds by {name} as AI') : A('mark_author_unknown', 'Mark all worlds by this author as AI'),
            action: () => exploreMarkAiAuthor(w.authorId, w.authorName || '', !on) });
    }
    return items;
}

/** The hide list part of the Filters panel: counts, hidden authors and tags (click to unhide), and "Show hidden worlds". */
function _explorePersonalHtml() {
    const p = _explorePersonal;
    const P = (key, fallback) => esc(t('worlds.explore.personal.' + key, fallback));
    const n = m => Object.keys(m).length;
    const counts = { worlds: n(p.worlds), authors: n(p.authors), tags: p.tags.length, disliked: n(p.disliked) };
    const sum = counts.worlds + counts.authors + counts.tags + counts.disliked
        ? esc(tf('worlds.explore.personal.summary', counts, 'Hidden: {worlds} worlds, {authors} authors, {tags} tags. Disliked: {disliked}.'))
        : P('summary_empty', 'Nothing hidden yet.');
    const chip = (kind, key, label) => `<button class="explore-chip out" data-kind="${kind}" data-key="${esc(key)}" onclick="exploreUnhideChip(this.dataset.kind, this.dataset.key)" title="${P('unhide', 'Unhide')}"><span class="msi">close</span>${esc(label)}</button>`;
    const chips = [
        ...Object.entries(p.authors).map(([id, x]) => chip('author', id, x.name || id)),
        ...p.tags.map(tag => chip('tag', tag, _wdTagLabel(tag) || tag)),
    ].join('');
    return `<div class="av-more-title explore-personal-title">${P('hide_list', 'Hide list')}</div>
        <div class="explore-personal-sum">${sum}</div>
        ${chips ? `<div class="explore-personal-chips">${chips}</div>` : ''}
        <label class="explore-cw explore-personal-show"><input type="checkbox" id="exploreShowHidden"${p.showHidden ? ' checked' : ''} onchange="exploreShowHidden(this.checked)"> <span>${P('show_hidden', 'Show hidden worlds, marked, to bring them back')}</span></label>
        <div class="explore-filter-hint">${P('hint', 'Right-click a world in Explore to like or dislike it, or to hide it, everything by its author, or one of its tags. Kept on this computer only, never sent to VRChat.')}</div>`;
}

// ---- Explore: AI filter (item 14, step 6) ----
// VRChat has no AI label, so this stays local. "Maybe AI" is a guess from a world's author tags, name and description
// (words such as "AI generated", "Midjourney"; "no AI" / "handmade" count against), never stated as fact. The user's
// own marks (a world, or every world by an author) live with the hide list in vrcn_explorePersonal. The filter shows
// all, hides guesses and marks, or hides only marks.
const _EXPLORE_AI_TAGS = new Set(['ai', 'aiart', 'ai_art', 'aigenerated', 'ai_generated', 'generativeai', 'generative_ai',
    'midjourney', 'stablediffusion', 'stable_diffusion', 'aiworld', 'ai_world']);
const _EXPLORE_AI_YES = /\b(?:ai[\s_-]*(?:generated|made|art|assisted|created)|(?:made|generated|created) (?:with|using|by|in|through) (?:an? |the )?ai|midjourney|stable[\s-]?diffusion|dall[\s·-]?e|novelai|niji[\s-]?journey|meshy|tripo[\s-]?ai|luma[\s-]?ai)\b|AI生成|生成AI|AIイラスト|AI绘画|AI繪圖|AI ?생성|생성형 ?AI|ИИ[\s-]*(?:генер|арт)|сгенерирован\S* (?:ии|нейросет)/i;
const _EXPLORE_AI_NO = /\b(?:no[\s-]+ai|not[\s-]+ai|non[\s-]ai|ai[\s-]free|without[\s-]+(?:any[\s-]+)?ai|human[\s-]made|hand[\s-]?made|no[\s-]+generative[\s-]+ai)\b|AI不使用|AI未使用|AI 미사용/i;
const _exploreAiMemo = new WeakMap();

/** Whether a world's own tags or text say it was made with AI. A tag counts even next to "no AI" text. */
function _exploreAiGuess(w) {
    let hit = _exploreAiMemo.get(w);
    if (hit !== undefined) return hit;
    const tagged = _wlAuthorTags(w).some(tag => _EXPLORE_AI_TAGS.has(tag.toLowerCase()));
    const text = `${w.name || ''} ${w.description || ''}`;
    hit = tagged || (_EXPLORE_AI_YES.test(text) && !_EXPLORE_AI_NO.test(text));
    _exploreAiMemo.set(w, hit);
    return hit;
}

/** 'mark' (the user marked it or its author), 'text' (the guess), or ''. */
function _exploreAiWhy(w) {
    if (!w) return '';
    const p = _explorePersonal;
    if (p.ai[w.id] || (w.authorId && p.aiAuthors[w.authorId])) return 'mark';
    return _exploreAiGuess(w) ? 'text' : '';
}

function exploreMarkAi(id, on) {
    if (!_exploreIdOk(id, 'wrld_')) return;
    if (on) {
        const w = _exploreFindWorld(id) || { id };
        _explorePut('ai', id, { name: String(w.name || '').slice(0, 80), authorId: w.authorId || '' });
        showToast(true, tf('worlds.explore.ai.toast_marked', { name: w.name || id }, '"{name}" marked as AI.'));
    } else delete _explorePersonal.ai[id];
    _explorePersonalChanged();
}

function exploreMarkAiAuthor(authorId, name, on) {
    if (!_exploreIdOk(authorId)) return;
    if (on) {
        _explorePut('aiAuthors', authorId, { name: String(name || '').slice(0, 80) });
        showToast(true, tf('worlds.explore.ai.toast_author', { name: name || authorId }, 'Worlds by {name} marked as AI.'));
    } else delete _explorePersonal.aiAuthors[authorId];
    _explorePersonalChanged();
}

/** The AI part of the Filters panel: what to hide, the marks so far (authors as chips, click to unmark). */
function _exploreAiHtml() {
    const p = _explorePersonal;
    const f = _exploreFilters;
    const A = (key, fallback) => esc(t('worlds.explore.ai.' + key, fallback));
    const opt = (v, label) => `<option value="${v}"${f.ai === v ? ' selected' : ''}>${label}</option>`;
    const counts = { worlds: Object.keys(p.ai).length, authors: Object.keys(p.aiAuthors).length };
    const chips = Object.entries(p.aiAuthors).map(([id, x]) => `<button class="explore-chip out" data-kind="aiauthor" data-key="${esc(id)}" onclick="exploreUnhideChip(this.dataset.kind, this.dataset.key)" title="${A('unmark', 'Remove the mark')}"><span class="msi">close</span>${esc(x.name || id)}</button>`).join('');
    return `<div class="av-more-title explore-personal-title">${A('title', 'AI')}</div>
        <div class="av-more-row"><span>${A('filter', 'Show')}</span>
            <select id="exploreAiSel" class="vrcn-dropdown" onchange="exploreSetFilter('ai', this.value)">${opt('all', A('show_all', 'All worlds'))}${opt('hide', A('hide_all', 'Hide "Maybe AI" and my marks'))}${opt('marks', A('hide_marks', 'Hide only my marks'))}</select></div>
        <div class="explore-personal-sum">${esc(tf('worlds.explore.ai.summary', counts, 'Your AI marks: {worlds} worlds, {authors} authors.'))}</div>
        ${chips ? `<div class="explore-personal-chips">${chips}</div>` : ''}
        <div class="explore-filter-hint">${A('hint', 'VRChat has no AI label. "Maybe AI" is a guess from the world\'s tags and text, so it can be wrong. Right-click a world to mark it or its author; marks stay on this computer.')}</div>`;
}

// ---- Explore: For You (item 14, step 7) ----
// A feed built from the user's own taste: the author tags of worlds they visit (weighted by time spent there and how
// recently, half-life 30 days), favorite and like; dislikes count against and hidden tags never count. One request
// per top tag (5 at most, Hot, 50 each), only when For You opens or Refresh is pressed; kept 30 minutes. Scored by
// tag overlap times freshness plus a little for favorites; at most two worlds per author, every fifth card the newest
// world not shown yet. Visited worlds stay out unless switched on. Too little history: VRChat's Trending, said so.
const _EXPLORE_FEED_TTL_MS = 30 * 60 * 1000;
const _EXPLORE_FEED_MIN = 5;        // visited worlds with author tags needed before For You uses the history
const _EXPLORE_FEED_TAGS = 5;       // requests per refresh at most
let _exploreFeedWhy = new Map();    // world id -> { kind: 'tags', tags } | { kind: 'new' }
let _exploreFeedProfile = null;

function _exploreTimeMs(v) {
    const n = typeof v === 'number' ? v : Date.parse(v || '');
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
}

/** Tag weights from visits, favorites, likes and dislikes; top = the tags to ask VRChat about. */
function _exploreProfile() {
    const weights = new Map();
    const add = (w, k) => {
        for (const tag of new Set(Array.isArray(w?.tags) ? w.tags : []))
            if (typeof tag === 'string' && tag.startsWith('author_tag_') && _exploreTagOk(tag)) weights.set(tag, (weights.get(tag) || 0) + k);
    };
    const now = Date.now();
    let tagged = 0;
    for (const w of Array.isArray(_visitedWorldsData) ? _visitedWorldsData : []) {
        if (!w || !(Array.isArray(w.tags) && w.tags.some(x => typeof x === 'string' && x.startsWith('author_tag_')))) continue;
        tagged++;
        const hours = Math.max(0, Number(w.worldTimeSeconds) || 0) / 3600;
        const last = _exploreTimeMs(w.worldLastVisited);
        const recency = last ? Math.pow(0.5, Math.max(0, now - last) / (30 * 86400000)) : 0.25;
        add(w, (1 + Math.log1p(hours)) * (0.25 + recency));
    }
    for (const w of typeof favWorldsData !== 'undefined' && Array.isArray(favWorldsData) ? favWorldsData : []) add(w, 1);
    const p = _explorePersonal;
    for (const w of Object.values(p.liked)) add(w, 1.5);
    for (const w of Object.values(p.disliked)) add(w, -1.5);
    for (const tag of p.tags) weights.set(tag, -Infinity);
    const top = [...weights].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, _EXPLORE_FEED_TAGS).map(x => x[0]);
    return { weights, top, tagged, enough: tagged >= _EXPLORE_FEED_MIN && top.length > 0 };
}

/** Asks for the feed when For You has none yet, it is 30 minutes old, or Refresh was pressed. Waits for the visit history. */
function _exploreForYouEnsure(fresh) {
    const e = _exploreEntry('foryou', '');
    if (e.loading) return;
    if (!_visitedWorldsLoaded) { _exploreAskChipSources(); return; }
    if (!fresh && Array.isArray(e.worlds) && Date.now() - e.at < _EXPLORE_FEED_TTL_MS) return;
    const prof = _exploreProfile();
    const tags = prof.enough ? prof.top : [];
    e.loading = true;
    e.failed = false;
    e.reqKey = _exploreKey('foryou', '') + '|' + tags.join(',') + '|' + Date.now();
    e.profile = prof;
    sendToCS({ action: 'vrcExploreForYou', ..._exploreServerParams(), profileTags: tags, fresh: !!fresh, key: e.reqKey, sig: _exploreServerSig() });
    _exploreSyncUi();
    if (worldFilter === 'explore') renderExplore();
}

function onExploreForYou(payload) {
    const sig = typeof payload?.sig === 'string' ? payload.sig : _exploreServerSig();
    const e = _exploreEntry('foryou', '', sig);
    if (!payload || payload.key !== e.reqKey) return;   // an older request
    e.loading = false;
    if (payload.ok) {
        _exploreFeedProfile = e.profile || _exploreProfile();
        e.fallback = !!payload.fallback;
        e.worlds = _exploreForYouBuild(Array.isArray(payload.results) ? payload.results : [], _exploreFeedProfile, e.fallback);
        e.at = Date.now();
        e.hasMore = false;
    } else _exploreLoadFailed(e);
    _exploreAfterLoad('foryou', '', sig);
}

/** Scores and mixes what came back; fills _exploreFeedWhy with the reason each card shows. */
function _exploreForYouBuild(results, prof, fallback) {
    const byId = new Map();
    for (const r of results) for (const w of Array.isArray(r?.worlds) ? r.worlds : []) if (w && w.id && !byId.has(w.id)) byId.set(w.id, w);
    const why = new Map();
    _exploreFeedWhy = why;
    if (fallback) return [...byId.values()];
    const now = Date.now();
    const weight = tag => prof.weights.get(tag) || 0;
    const maxW = Math.max(1e-9, ...prof.top.map(weight));
    const scored = [...byId.values()].map(w => {
        const tags = [...new Set((Array.isArray(w.tags) ? w.tags : []).filter(x => typeof x === 'string' && x.startsWith('author_tag_')))];
        const hits = tags.filter(x => weight(x) > 0).sort((a, b) => weight(b) - weight(a));
        const against = tags.some(x => weight(x) < 0);
        const overlap = Math.min(1.5, hits.reduce((n, x) => n + weight(x), 0) / maxW);
        const at = _exploreWorldTime(w);
        const ageDays = at ? Math.max(0, (now - at) / 86400000) : 365;
        const score = overlap * (0.5 + 1 / (1 + ageDays / 180)) + 0.08 * Math.log10(1 + (Number(w.favorites) || 0)) - (against ? 0.5 : 0);
        return { w, score, hits, ageDays };
    }).sort((a, b) => b.score - a.score);
    const out = [];
    const perAuthor = new Map();
    const used = new Set();
    const author = x => x.w.authorId || x.w.id;
    const ok = x => !used.has(x.w.id) && (perAuthor.get(author(x)) || 0) < 2;
    const take = x => { used.add(x.w.id); out.push(x.w); perAuthor.set(author(x), (perAuthor.get(author(x)) || 0) + 1); };
    const newest = [...scored].sort((a, b) => a.ageDays - b.ageDays);
    for (const x of scored) {
        if (!ok(x)) continue;
        if (out.length % 5 === 4) {
            const pick = newest.find(ok);
            if (pick) { take(pick); why.set(pick.w.id, { kind: 'new' }); }
            if (!ok(x)) continue;
        }
        take(x);
        why.set(x.w.id, { kind: 'tags', tags: x.hits.slice(0, 2) });
    }
    return out;
}

function _exploreForYouNote() {
    const e = _exploreEntry('foryou', '');
    if (!Array.isArray(e.worlds)) return '';
    if (e.fallback) return tf('worlds.explore.foryou.note_fallback', { n: _EXPLORE_FEED_MIN }, 'Not enough visit history yet (fewer than {n} visited worlds with tags), so this is VRChat\'s Trending. It fills in as you visit worlds.');
    const tags = (_exploreFeedProfile?.top || []).map(tag => _wdTagLabel(tag) || tag).join(', ');
    return tf('worlds.explore.foryou.note', { tags }, 'Picked from the tags of worlds you visit, favorite and like: {tags}. Refresh for a new mix.');
}

function exploreFeedVisited(on) {
    _explorePersonal.feedVisited = !!on;
    _exploreSavePersonal();
    _explore.page = 0;
    if (worldFilter === 'explore') { _exploreSyncUi(); renderExplore(); }
}

// ---- Explore: VRChat's rows, saved searches, the view Explore opens on (item 14, step 5) ----
// "VRChat rows" lists the rows VRChat shows in game (GET /config dynamicWorldRows, asked for the first time the menu
// opens); each is a view "row:<index>" that C# turns into its GET /worlds sort and tag. A saved search keeps the view,
// the search text and the filters under a name; one view or saved search can be where Explore opens. Kept in
// localStorage vrcn_exploreSaved, on this computer only.
const _EXPLORE_SAVED_MAX = 30;
const _EXPLORE_START_VIEWS = ['active', 'foryou', 'discover', 'hot', 'trending', 'popular', 'new', 'labs', 'favorites', 'random', 'liked'];
const _EXPLORE_VIEW_NAMES = { active: 'Active now', foryou: 'For You', discover: 'Discover', hot: 'Hot', trending: 'Trending', popular: 'Popular', new: 'New',
    labs: 'Community Labs', favorites: 'Most favorited', random: 'Random', liked: 'Liked', relevance: 'Best match' };
const _exploreRowsState = { list: null, loading: false, failed: false };
const _exploreSaved = _exploreLoadSaved();

function _exploreViewOk(v) { return typeof v === 'string' && (_EXPLORE_START_VIEWS.includes(v) || v === 'relevance' || /^row:\d{1,3}$/.test(v) || /^list:[a-z0-9]{1,16}$/.test(v)); }

function _exploreViewLabel(v) {
    if (v.startsWith('row:')) return _exploreRowName(v);
    if (v.startsWith('list:')) return _exploreLists.lists[v.slice(5)]?.name || t('worlds.explore.lists.untitled', 'Shared list');
    return t('worlds.explore.views.' + v, _EXPLORE_VIEW_NAMES[v] || v);
}

/** The tags a view itself asks VRChat for (Labs, a VRChat row); filters check them again on what comes back. */
function _exploreViewTags(view) {
    if (_EXPLORE_VIEW_TAG[view]) return [_EXPLORE_VIEW_TAG[view]];
    if (!view.startsWith('row:')) return [];
    return _exploreRowsState.list?.find(r => r.id === view)?.tags || [];
}

function _exploreRowName(view) { return _exploreRowsState.list?.find(r => r.id === view)?.name || t('worlds.explore.rows.unknown', 'VRChat row'); }

/** A panel under a toolbar button, closed by a click outside it. Returns null when the click closed it. */
function _exploreOpenPanel(id, btn, width) {
    let panel = document.getElementById(id);
    if (panel && panel.style.display === 'block') { panel.style.display = 'none'; return null; }
    if (!panel) {
        panel = document.createElement('div');
        panel.id = id;
        panel.className = 'av-more-panel explore-filter-panel';
        document.body.appendChild(panel);
        document.addEventListener('mousedown', e => {
            if (panel.style.display !== 'block' || panel.contains(e.target) || e.target.closest?.('#' + btn.id + ', .vn-select-panel, .vn-select')) return;
            panel.style.display = 'none';
        }, true);
    }
    const r = btn.getBoundingClientRect();
    panel.style.width = width + 'px';
    panel.style.top = Math.round(r.bottom + 6) + 'px';
    panel.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - width - 8))) + 'px';
    panel.style.maxHeight = Math.max(200, Math.round(innerHeight - r.bottom - 18)) + 'px';
    panel.style.display = 'block';
    return panel;
}

function _exploreRefreshPanel(id, html) {
    const panel = document.getElementById(id);
    if (panel && panel.style.display === 'block') panel.innerHTML = html();
}

function _exploreClosePanel(id) { const panel = document.getElementById(id); if (panel) panel.style.display = 'none'; }

function _exploreRowsHtml() {
    const R = (key, fallback) => esc(t('worlds.explore.rows.' + key, fallback));
    const st = _exploreRowsState;
    const body = st.list?.length
        ? st.list.map(r => `<button class="vrcn-button explore-row-item${_explore.view === r.id ? ' active' : ''}" data-view="${esc(r.id)}" onclick="exploreOpenRow(this.dataset.view)">${esc(r.name)}</button>`).join('')
        : `<div class="explore-personal-sum">${st.loading ? R('loading', 'Asking VRChat for its rows...') : st.failed ? R('failed', 'Could not load VRChat\'s rows. Open this again to retry.') : R('empty', 'VRChat lists no rows HapsHub can show.')}</div>`;
    return `<div class="av-more-title">${R('title', 'Rows VRChat shows in game')}</div>
        <div class="explore-row-list">${body}</div>
        <div class="explore-filter-hint">${R('hint', 'The same rows as VRChat\'s own world menu. Your filters still apply.')}</div>`;
}

function exploreToggleRows(btn) {
    const panel = _exploreOpenPanel('exploreRowsPanel', btn, 300);
    if (!panel) return;
    const st = _exploreRowsState;
    if (!st.list && !st.loading) {
        st.loading = true;
        st.failed = false;
        sendToCS({ action: 'vrcExploreRows' });
    }
    panel.innerHTML = _exploreRowsHtml();
}

function onExploreRows(payload) {
    const st = _exploreRowsState;
    st.loading = false;
    if (payload?.ok) st.list = (Array.isArray(payload.rows) ? payload.rows : [])
        .filter(r => r && /^row:\d{1,3}$/.test(r.id) && typeof r.name === 'string' && r.name.trim())
        .map(r => ({ id: r.id, name: r.name.trim().slice(0, 60), tags: String(r.tag || '').split(',').filter(Boolean) }));
    else st.failed = true;
    _exploreRefreshPanel('exploreRowsPanel', _exploreRowsHtml);
    _exploreSyncUi();
}

function exploreOpenRow(id) {
    if (!/^row:\d{1,3}$/.test(id)) return;
    _exploreClosePanel('exploreRowsPanel');
    setExploreView(id);
}

function _exploreLoadSaved() {
    const out = { list: [], start: 'active' };
    try {
        const s = JSON.parse(localStorage.getItem('vrcn_exploreSaved') || '{}') || {};
        const seen = new Set();
        for (const x of Array.isArray(s.list) ? s.list : []) {
            const name = typeof x?.name === 'string' ? x.name.trim().slice(0, 40) : '';
            if (!name || seen.has(name.toLowerCase()) || !_exploreViewOk(x.view)) continue;
            seen.add(name.toLowerCase());
            out.list.push({ name, view: x.view, query: typeof x.query === 'string' ? x.query.slice(0, 100) : '', filters: _exploreCleanFilters(x.filters), at: Number(x.at) || 0 });
            if (out.list.length >= _EXPLORE_SAVED_MAX) break;
        }
        if (typeof s.start === 'string' && (_EXPLORE_START_VIEWS.includes(s.start) || out.list.some(x => 'saved:' + x.name === s.start))) out.start = s.start;
    } catch { }
    return out;
}

function _exploreSaveSaved() { try { localStorage.setItem('vrcn_exploreSaved', JSON.stringify(_exploreSaved)); } catch { } }

function _exploreSavedHtml() {
    const S = (key, fallback) => esc(t('worlds.explore.saved.' + key, fallback));
    const sv = _exploreSaved;
    const items = sv.list.map((x, i) => `<div class="explore-saved-item">
            <button class="vrcn-button explore-saved-name" onclick="exploreApplySaved(${i})" title="${esc(_exploreViewLabel(x.view) + (x.query ? ' · ' + x.query : ''))}">${esc(x.name)}</button>
            <button class="vrcn-button explore-saved-pin${sv.start === 'saved:' + x.name ? ' active' : ''}" onclick="exploreTogglePin(${i})" title="${S('pin', 'Open Explore here')}"><span class="msi">push_pin</span></button>
            <button class="vrcn-button explore-saved-del" onclick="exploreDeleteSaved(${i})" title="${S('delete', 'Delete')}"><span class="msi">close</span></button></div>`).join('');
    const opt = (v, label) => `<option value="${esc(v)}"${sv.start === v ? ' selected' : ''}>${esc(label)}</option>`;
    const starts = _EXPLORE_START_VIEWS.map(v => opt(v, _exploreViewLabel(v))).join('')
        + sv.list.map(x => opt('saved:' + x.name, tf('worlds.explore.saved.start_item', { name: x.name }, 'Saved: {name}'))).join('');
    return `<div class="av-more-title">${S('title', 'Saved searches')}</div>
        <div class="explore-saved-list">${items || `<div class="explore-personal-sum">${S('empty', 'Nothing saved yet.')}</div>`}</div>
        <div class="av-more-row"><input id="exploreSavedName" type="text" class="vrcn-input" maxlength="40" placeholder="${S('name_placeholder', 'Name this search')}" onkeydown="if(event.key==='Enter')exploreSaveCurrent()"><button class="vrcn-button" onclick="exploreSaveCurrent()">${S('save', 'Save')}</button></div>
        <div class="av-more-row"><span>${S('start', 'Explore opens on')}</span><select id="exploreStartSel" class="vrcn-dropdown" onchange="exploreSetStart(this.value)">${starts}</select></div>
        <div class="explore-filter-hint">${S('hint', 'Saves the view, the search text and the filters. Kept on this computer only.')}</div>
        ${_exploreListsHtml()}`;
}

function exploreToggleSaved(btn) {
    const panel = _exploreOpenPanel('exploreSavedPanel', btn, 340);
    if (panel) panel.innerHTML = _exploreSavedHtml();
}

/** Saves the current view, search text and filters under the typed name (the same name replaces it). */
function exploreSaveCurrent() {
    const input = document.getElementById('exploreSavedName');
    const name = (input?.value || '').trim().slice(0, 40);
    if (!name) { showToast(false, t('worlds.explore.saved.need_name', 'Type a name first.')); return; }
    _exploreReadQuery();
    const sv = _exploreSaved;
    const i = sv.list.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
    if (i < 0 && sv.list.length >= _EXPLORE_SAVED_MAX) {
        showToast(false, tf('worlds.explore.saved.full', { n: _EXPLORE_SAVED_MAX }, 'You can keep {n} saved searches. Delete one first.'));
        return;
    }
    const entry = { name, view: _explore.view, query: _explore.query, filters: _exploreCleanFilters(_exploreFilters), at: Date.now() };
    if (i >= 0) {
        if (sv.start === 'saved:' + sv.list[i].name) sv.start = 'saved:' + name;
        sv.list[i] = entry;
    } else sv.list.push(entry);
    _exploreSaveSaved();
    showToast(true, tf('worlds.explore.saved.toast_saved', { name }, '"{name}" saved.'));
    _exploreRefreshPanel('exploreSavedPanel', _exploreSavedHtml);
}

/** Puts a saved search's filters and text back without loading anything; the caller shows the view. */
function _exploreUseSaved(x) {
    Object.assign(_exploreFilters, _exploreCleanFilters(x.filters));
    _exploreSaveFilters();
    _explore.query = x.query;
    const input = document.getElementById('searchWorldsInput');
    if (input) input.value = x.query;
    _explore.page = 0;
    return x.view === 'relevance' && !x.query ? 'active' : x.view;
}

function exploreApplySaved(i) {
    const x = _exploreSaved.list[i];
    if (!x) return;
    _exploreClosePanel('exploreSavedPanel');
    if (worldFilter !== 'explore') setWorldFilter('explore');
    const view = _exploreUseSaved(x);
    setExploreView(view.startsWith('list:') && !_exploreLists.lists[view.slice(5)] ? 'active' : view);
}

function exploreDeleteSaved(i) {
    const sv = _exploreSaved;
    const x = sv.list[i];
    if (!x) return;
    sv.list.splice(i, 1);
    if (sv.start === 'saved:' + x.name) sv.start = 'active';
    _exploreSaveSaved();
    _exploreRefreshPanel('exploreSavedPanel', _exploreSavedHtml);
}

function exploreSetStart(v) {
    const sv = _exploreSaved;
    sv.start = _EXPLORE_START_VIEWS.includes(v) || sv.list.some(x => 'saved:' + x.name === v) ? v : 'active';
    _exploreSaveSaved();
    _exploreRefreshPanel('exploreSavedPanel', _exploreSavedHtml);
}

function exploreTogglePin(i) {
    const x = _exploreSaved.list[i];
    if (x) exploreSetStart(_exploreSaved.start === 'saved:' + x.name ? 'active' : 'saved:' + x.name);
}

/** The first time Explore opens in a run: the view or saved search picked under "Explore opens on". */
function _exploreApplyStart() {
    _explore.started = true;
    const st = _exploreSaved.start;
    const x = st.startsWith('saved:') ? _exploreSaved.list.find(s => 'saved:' + s.name === st) : null;
    if (x) _explore.view = _exploreUseSaved(x);
    else if (_EXPLORE_START_VIEWS.includes(st)) _explore.view = st;
    if (_explore.view.startsWith('list:') && !_exploreLists.lists[_explore.view.slice(5)]) _explore.view = 'active';
    _explore.page = 0;
}

// ---- Explore: share and import world lists (item 14, step 8) ----
// Liked worlds go out as a code (HAPSLIST1. + base64url of the JSON) or a .json file, with the user's AI marks if
// ticked. A list carries world ids, names, creators, author tags and capacity; pictures only from VRChat's own image
// hosts, so a list can't make HapsHub load anything from elsewhere. Imported lists open as views "list:<id>" and are
// kept in localStorage vrcn_exploreLists; their missing pictures are asked for once per run (50 worlds at most).
const _EXPLORE_LIST_CODE = 'HAPSLIST1.';
const _EXPLORE_LISTS_MAX = 10;
const _EXPLORE_LIST_WORLDS_MAX = 500;
const _EXPLORE_LIST_IMG = /^https:\/\/(?:api\.vrchat\.cloud|assets\.vrchat\.com|files\.vrchat\.cloud)\/[^\s'"()<>]{1,400}$/;
const _exploreLists = _exploreLoadLists();
const _exploreListFilled = new Set();

function _exploreListText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

/** One world as a list carries it; anything else is dropped. */
function _exploreListWorld(w) {
    if (!w || !_exploreIdOk(w.id, 'wrld_')) return null;
    const img = typeof w.thumbnailImageUrl === 'string' && _EXPLORE_LIST_IMG.test(w.thumbnailImageUrl) ? w.thumbnailImageUrl : '';
    return {
        id: w.id, name: _exploreListText(w.name, 120), authorId: _exploreIdOk(w.authorId) ? w.authorId : '', authorName: _exploreListText(w.authorName, 80),
        tags: (Array.isArray(w.tags) ? w.tags : []).filter(x => typeof x === 'string' && x.startsWith('author_tag_') && _exploreTagOk(x)).slice(0, 12),
        capacity: _exploreCap(w.capacity), thumbnailImageUrl: img, imageUrl: img,
    };
}

/** A list from a code or a file's JSON; null when it is neither. */
function _exploreParseList(text) {
    text = String(text || '').trim();
    if (!text || text.length > 3000000) return null;
    let obj;
    try {
        if (text.startsWith(_EXPLORE_LIST_CODE)) {
            const b64 = text.slice(_EXPLORE_LIST_CODE.length).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
            const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
            obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
        } else obj = JSON.parse(text);
    } catch { return null; }
    if (!obj || typeof obj !== 'object' || obj.v !== 1 || !Array.isArray(obj.worlds)) return null;
    const seen = new Set();
    const worlds = [];
    for (const x of obj.worlds) {
        const w = _exploreListWorld(x);
        if (!w || seen.has(w.id)) continue;
        seen.add(w.id);
        worlds.push(w);
        if (worlds.length >= _EXPLORE_LIST_WORLDS_MAX) break;
    }
    const ai = [...new Set((Array.isArray(obj.ai) ? obj.ai : []).filter(id => _exploreIdOk(id, 'wrld_')))].slice(0, _EXPLORE_KEEP.ai);
    return { name: _exploreListText(obj.name, 60), worlds, ai };
}

function _exploreLoadLists() {
    const out = { lists: {} };
    try {
        const s = JSON.parse(localStorage.getItem('vrcn_exploreLists') || '{}') || {};
        const entries = Object.entries(s.lists && typeof s.lists === 'object' && !Array.isArray(s.lists) ? s.lists : {})
            .filter(([id, x]) => /^[a-z0-9]{1,16}$/.test(id) && x && Array.isArray(x.worlds))
            .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0)).slice(0, _EXPLORE_LISTS_MAX);
        for (const [id, x] of entries)
            out.lists[id] = { name: _exploreListText(x.name, 60) || 'List', at: Number(x.at) || 0,
                worlds: x.worlds.map(_exploreListWorld).filter(Boolean).slice(0, _EXPLORE_LIST_WORLDS_MAX) };
    } catch { }
    return out;
}

function _exploreSaveLists() {
    try { localStorage.setItem('vrcn_exploreLists', JSON.stringify(_exploreLists)); return true; }
    catch { return false; }
}

function _exploreListWorlds(view) {
    const x = _exploreLists.lists[String(view).slice(5)];
    return x ? x.worlds.map(w => ({ occupants: 0, favorites: 0, ...w, thumbnailImageUrl: w.thumbnailImageUrl || w._img || '' })) : [];
}

function _exploreListNote(view) {
    const x = _exploreLists.lists[view.slice(5)];
    return x ? tf('worlds.explore.lists.note', { name: x.name, n: x.worlds.length }, 'List: {name}, {n} worlds.') : '';
}

/** Imported worlds without a picture: ask VRChat about them once per run (50 at most, C# goes four at a time and caches). */
function _exploreListFill(view) {
    if (!view.startsWith('list:') || _exploreListFilled.has(view)) return;
    const x = _exploreLists.lists[view.slice(5)];
    if (!x) return;
    _exploreListFilled.add(view);
    const ids = x.worlds.filter(w => !w.thumbnailImageUrl).map(w => w.id).slice(0, 50);
    if (ids.length) sendToCS({ action: 'vrcExploreFillWorlds', ids });
}

function onExploreFill(payload) {
    const byId = new Map((Array.isArray(payload?.worlds) ? payload.worlds : []).filter(w => w && w.id).map(w => [w.id, w]));
    if (!byId.size) return;
    for (const x of Object.values(_exploreLists.lists)) x.worlds = x.worlds.map(w => {
        const got = byId.get(w.id);
        if (!got) return w;
        // Pictures from VRChat come back as HapsHub's own image cache; they are shown, not kept in the list.
        return { ...w, name: w.name || _exploreListText(got.name, 120), authorName: w.authorName || _exploreListText(got.authorName, 80),
            capacity: w.capacity || _exploreCap(got.capacity), _img: typeof got.thumbnailImageUrl === 'string' ? got.thumbnailImageUrl : '',
            occupants: Number(got.occupants) || 0, favorites: Number(got.favorites) || 0 };
    });
    if (worldFilter === 'explore' && _explore.view.startsWith('list:')) renderExplore();
}

/** Liked worlds as a list object, newest like first. */
function _exploreLikedAsList() {
    const name = _exploreListText(document.getElementById('exploreListName')?.value, 60) || t('worlds.explore.lists.default_name', 'My liked worlds');
    const list = { v: 1, name, worlds: _exploreLikedList().map(_exploreListWorld).filter(Boolean) };
    if (document.getElementById('exploreListGiveAi')?.checked) list.ai = Object.keys(_explorePersonal.ai);
    return list;
}

function _exploreListCode(list) {
    const bytes = new TextEncoder().encode(JSON.stringify(list));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return _EXPLORE_LIST_CODE + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function exploreCopyList() {
    const list = _exploreLikedAsList();
    if (!list.worlds.length) return;
    navigator.clipboard.writeText(_exploreListCode(list))
        .then(() => showToast(true, tf('worlds.explore.lists.toast_copied', { n: list.worlds.length }, 'List code copied ({n} worlds).')))
        .catch(() => showToast(false, t('worlds.explore.lists.toast_copy_failed', 'Could not copy to the clipboard.')));
}

function exploreSaveListFile() {
    const list = _exploreLikedAsList();
    if (list.worlds.length) sendToCS({ action: 'exploreListSave', text: JSON.stringify(list, null, 1) });
}

function exploreOpenListFile() { sendToCS({ action: 'exploreListOpen' }); }

function exploreImportList() {
    const box = document.getElementById('exploreListCode');
    if (_exploreImportText(box?.value || '') && box) box.value = '';
}

function onExploreListFile(payload) {
    if (payload?.kind === 'opened') _exploreImportText(payload.text || '');
    else if (payload?.kind === 'saved') showToast(!!payload.ok, payload.ok ? t('worlds.explore.lists.toast_saved', 'List saved.') : t('worlds.explore.lists.toast_save_failed', 'Could not save the list.'));
}

/** Adds a list from a code or file text; with "Also take its AI marks" its marks join the user's. */
function _exploreImportText(text) {
    const list = _exploreParseList(text);
    if (!list) { showToast(false, t('worlds.explore.lists.bad_code', 'That is not a HapsHub list code or file.')); return false; }
    if (Object.keys(_exploreLists.lists).length >= _EXPLORE_LISTS_MAX) {
        showToast(false, tf('worlds.explore.lists.too_many', { n: _EXPLORE_LISTS_MAX }, 'You can keep {n} lists. Delete one first.'));
        return false;
    }
    let id;
    do id = Math.random().toString(36).slice(2, 10); while (_exploreLists.lists[id]);
    const name = list.name || t('worlds.explore.lists.untitled', 'Shared list');
    _exploreLists.lists[id] = { name, at: Date.now(), worlds: list.worlds };
    if (!_exploreSaveLists()) {
        delete _exploreLists.lists[id];
        showToast(false, t('worlds.explore.lists.too_big', 'Could not keep this list: it is too big.'));
        return false;
    }
    let ai = 0;
    if (document.getElementById('exploreListTakeAi')?.checked) {
        const names = new Map(list.worlds.map(w => [w.id, w.name]));
        for (const wid of list.ai) if (!_explorePersonal.ai[wid]) { _explorePut('ai', wid, { name: names.get(wid) || '', authorId: '' }); ai++; }
        if (ai) _exploreSavePersonal();
    }
    showToast(true, ai ? tf('worlds.explore.lists.toast_imported_ai', { name, n: list.worlds.length, ai }, 'Imported "{name}": {n} worlds, {ai} AI marks.')
        : tf('worlds.explore.lists.toast_imported', { name, n: list.worlds.length }, 'Imported "{name}": {n} worlds.'));
    _exploreRefreshPanel('exploreSavedPanel', _exploreSavedHtml);
    if (worldFilter === 'explore') { _exploreSyncUi(); renderExplore(); }
    return true;
}

function exploreOpenList(id) {
    if (!_exploreLists.lists[id]) return;
    _exploreClosePanel('exploreSavedPanel');
    if (worldFilter !== 'explore') setWorldFilter('explore');
    setExploreView('list:' + id);
}

function exploreDeleteList(id) {
    if (!_exploreLists.lists[id]) return;
    delete _exploreLists.lists[id];
    _exploreSaveLists();
    delete _explore.entries['list:' + id];
    if (_explore.view === 'list:' + id) setExploreView('active');
    _exploreRefreshPanel('exploreSavedPanel', _exploreSavedHtml);
}

function _exploreListsHtml() {
    const S = (key, fallback) => esc(t('worlds.explore.lists.' + key, fallback));
    const items = Object.entries(_exploreLists.lists).sort((a, b) => b[1].at - a[1].at).map(([id, x]) => `<div class="explore-saved-item">
            <button class="vrcn-button explore-saved-name${_explore.view === 'list:' + id ? ' active' : ''}" onclick="exploreOpenList('${id}')" title="${esc(x.name)}">${esc(x.name)} <span class="explore-list-count">${x.worlds.length}</span></button>
            <button class="vrcn-button explore-saved-del" onclick="exploreDeleteList('${id}')" title="${S('delete', 'Delete this list')}"><span class="msi">close</span></button></div>`).join('');
    const liked = Object.keys(_explorePersonal.liked).length;
    const off = liked ? '' : ' disabled';
    return `<div class="av-more-title explore-personal-title">${S('title', 'Shared lists')}</div>
        <div class="explore-saved-list">${items || `<div class="explore-personal-sum">${S('empty', 'No lists imported yet.')}</div>`}</div>
        <textarea id="exploreListCode" class="vrcn-input explore-list-code" rows="2" placeholder="${S('paste', 'Paste a list code here')}"></textarea>
        <label class="explore-cw"><input type="checkbox" id="exploreListTakeAi"> <span>${S('take_ai', 'Also take its AI marks')}</span></label>
        <div class="explore-list-btns"><button class="vrcn-button" onclick="exploreImportList()"><span class="msi">upload</span> ${S('import', 'Import')}</button><button class="vrcn-button" onclick="exploreOpenListFile()"><span class="msi">upload_file</span> ${S('open_file', 'Open file')}</button></div>
        <div class="av-more-title explore-personal-title">${esc(tf('worlds.explore.lists.share_title', { n: liked }, 'Share your Liked worlds ({n})'))}</div>
        <input id="exploreListName" type="text" class="vrcn-input explore-list-name" maxlength="60" placeholder="${S('name_placeholder', 'List name')}" value="${S('default_name', 'My liked worlds')}">
        <label class="explore-cw"><input type="checkbox" id="exploreListGiveAi"> <span>${S('give_ai', 'Include my AI marks')}</span></label>
        <div class="explore-list-btns"><button class="vrcn-button" onclick="exploreCopyList()"${off}><span class="msi">content_copy</span> ${S('copy', 'Copy code')}</button><button class="vrcn-button" onclick="exploreSaveListFile()"${off}><span class="msi">download</span> ${S('save_file', 'Save file')}</button></div>
        <div class="explore-filter-hint">${S('hint', 'A list holds world IDs, names, creators and tags, plus your AI marks if ticked. Imported lists open as views here and stay on this computer.')}</div>`;
}

function _wdGroupOptionLabel(g) {
    const count = favWorldsData.filter(w => w.favoriteGroup === g.name).length;
    const cap   = isLocalFavGroup(g) ? (g.capacity || 200) : Math.max(g.capacity || 100, 100);
    const marker = (!isLocalFavGroup(g) && g.type === 'vrcPlusWorld') ? ' [VRC+]' : '';
    return `${esc(g.displayName || g.name)} ${count}/${cap}${marker}`;
}

function renderFavWorlds(payload) {
    // Reset refresh button if it was spinning
    const refreshBtn = document.getElementById('favWorldsRefreshBtn');
    if (refreshBtn) { refreshBtn.disabled = false; const ico = refreshBtn.querySelector('.msi'); if (ico) ico.textContent = 'refresh'; }
    // payload is { worlds: [...], groups: [...] }
    const worlds = payload?.worlds || payload || [];
    const groups = payload?.groups || [];
    _favWorldsLoaded = true;
    favWorldsData = worlds;
    favWorldGroups = groups;
    _wdUpdateCounts();
    if (worldFilter === 'explore') _exploreRenderChips();
    // Populate world info cache for library badges
    favWorldsData.forEach(w => {
        if (w.id) worldInfoCache[w.id] = { id: w.id, name: w.name, thumbnailImageUrl: w.thumbnailImageUrl || w.imageUrl };
    });
    // Populate group dropdown
    const sel = document.getElementById('favWorldGroupFilter');
    if (sel) {
        const prev = favWorldGroupFilter;
        sel.innerHTML = `<option value="">${t('worlds.favorites.group.all', 'All Favorites')}</option>` +
            groups.map(g => `<option value="${esc(g.name)}">${_wdGroupOptionLabel(g)}</option>`).join('');
        const stillValid = groups.some(g => g.name === prev);
        favWorldGroupFilter = stillValid ? prev : '';
        sel.value = favWorldGroupFilter;
        if (sel._vnRefresh) sel._vnRefresh();
    }
    updateFavWorldGroupHeader();
    filterFavWorlds();
    if (typeof renderDashFavWorlds === 'function') renderDashFavWorlds();
}

function setFavWorldGroup(val) {
    favWorldGroupFilter = val;
    updateFavWorldGroupHeader();
    filterFavWorlds();
}

function updateFavWorldGroupHeader() {
    const header = document.getElementById('favWorldGroupHeader');
    const delBtn = document.getElementById('favWorldGroupDeleteBtn');
    const badge = document.getElementById('favWorldGroupVrcPlusBadge');
    const localBadge = document.getElementById('favWorldGroupLocalBadge');
    if (!header) return;
    if (!favWorldGroupFilter) {
        if (delBtn) delBtn.style.display = 'none';
        if (badge) badge.style.display = 'none';
        if (localBadge) localBadge.style.display = 'none';
    } else {
        const g = favWorldGroups.find(x => x.name === favWorldGroupFilter);
        const isLocal = isLocalFavGroup(g);
        if (delBtn) delBtn.style.display = isLocal ? '' : 'none';
        if (badge) badge.style.display = (g?.type === 'vrcPlusWorld') ? '' : 'none';
        if (localBadge) localBadge.style.display = isLocal ? '' : 'none';
    }
    const anyVisible = [delBtn, badge, localBadge]
        .some(el => el && el.style.display !== 'none');
    header.style.display = anyVisible ? 'flex' : 'none';
}


function _favGroupVisDropdown(groupName, groupType, currentVis) {
    const opts = [
        { value: 'public',  key: 'worlds.favorites.visibility.public',  label: 'Visible for everyone' },
        { value: 'friends', key: 'worlds.favorites.visibility.friends', label: 'Visible for friends' },
        { value: 'private', key: 'worlds.favorites.visibility.private', label: 'Visible only to you' },
    ];
    const optsHtml = opts.map(o =>
        `<option value="${o.value}"${o.value === currentVis ? ' selected' : ''}>${esc(t(o.key, o.label))}</option>`
    ).join('');
    return `<select class="vrcn-dropdown" style="min-width:160px;" onchange="saveFavGroupVisibility(this.value,'${jsq(groupName)}')">${optsHtml}</select>`;
}

function saveFavGroupVisibility(visibility, groupName) {
    const name = groupName || favWorldGroupFilter;
    const g = favWorldGroups.find(x => x.name === name);
    if (!g) return;
    sendToCS({ action: 'vrcUpdateFavoriteGroup', groupType: g.type, groupName: g.name, displayName: g.displayName || g.name, visibility });
}

function onFavoriteGroupUpdated(data) {
    if (!data.ok) { if (_worldEditMode) filterFavWorlds(); return; }
    const g = favWorldGroups.find(x => x.name === data.groupName);
    if (g) {
        if (data.displayName) g.displayName = data.displayName;
        if (data.visibility)  g.visibility  = data.visibility;
    }
    // Update dropdown option
    const sel = document.getElementById('favWorldGroupFilter');
    if (sel) {
        const opt = [...sel.options].find(o => o.value === data.groupName);
        if (opt && g) opt.textContent = _wdGroupOptionLabel(g);
    }
    updateFavWorldGroupHeader();
    filterFavWorlds(); // re-render headers with updated visibility
}

function _wdGroupHeaderHtml(g, count, first) {
    const isLocal = isLocalFavGroup(g);
    const cap = isLocal ? (g.capacity || 200) : Math.max(g.capacity || 100, 100);
    const visHtml = (!isLocal && _worldEditMode)
        ? _favGroupVisDropdown(g.name, g.type, g.visibility)
        : '';
    return `<div class="fav-group-header${first ? ' fav-group-header-first' : ''}">
        ${_wdGroupTitleHtml(g)}
        ${favGroupBadge(g)}
        <span class="fav-group-count">${count}/${cap}</span>
        ${visHtml}
    </div>`;
}

function _wdGroupTitleHtml(g) {
    const disp = g.displayName || g.name;
    if (!_worldEditMode) return `<span class="topbar-title">${esc(disp)}</span>`;
    return `<span class="fav-group-name-edit">
        <input class="vrcn-edit-field fav-group-name-input" maxlength="64" value="${esc(disp)}" data-group="${esc(g.name)}" data-type="${esc(g.type || 'world')}" data-orig="${esc(disp)}" oninput="wdOnGroupNameInput(this)" onclick="event.stopPropagation()">
        <span class="fav-group-name-actions" style="display:none;">
            <button class="vrcn-button vrcn-btn-primary" onclick="wdSaveGroupName(this)">${t('common.save', 'Save')}</button>
            <button class="vrcn-button" onclick="wdCancelGroupName(this)">${t('common.cancel', 'Cancel')}</button>
        </span>
    </span>`;
}

function wdOnGroupNameInput(inp) {
    const actions = inp.closest('.fav-group-name-edit')?.querySelector('.fav-group-name-actions');
    if (!actions) return;
    const v = inp.value.trim();
    actions.style.display = (v && v !== inp.dataset.orig) ? 'inline-flex' : 'none';
}

function wdSaveGroupName(btn) {
    const inp = btn.closest('.fav-group-name-edit')?.querySelector('.fav-group-name-input');
    if (!inp) return;
    const newName = inp.value.trim();
    if (!newName || newName === inp.dataset.orig) return;
    btn.disabled = true;
    sendToCS({ action: 'vrcUpdateFavoriteGroup', groupType: inp.dataset.type, groupName: inp.dataset.group, displayName: newName });
}

function wdCancelGroupName(btn) {
    const wrap = btn.closest('.fav-group-name-edit');
    const inp = wrap?.querySelector('.fav-group-name-input');
    if (inp) inp.value = inp.dataset.orig;
    const actions = wrap?.querySelector('.fav-group-name-actions');
    if (actions) actions.style.display = 'none';
}

/* === Shared world card renderer (search + favorites) === */
/** opts (Explore): { badges: html over the card, cls: extra classes }. */
function renderWorldCard(w, opts) {
    const thumb = w.thumbnailImageUrl || w.imageUrl || '';
    const tags = (w.tags || []).filter(t => t.startsWith('author_tag_')).map(t => t.replace('author_tag_','')).slice(0,4);
    const tagsHtml = tags.length ? `<div class="cc-tags">${tags.map(t => `<span class="vrcn-badge">${esc(t)}</span>`).join('')}</div>` : '';
    const wid = jsq(w.id);
    const ts = w.worldTimeSeconds || 0;
    const timeBadge = ts > 0 ? `<div class="cc-time-top"><span class="msi">schedule</span> ${formatDuration(ts)}</div>` : '';
    if (_worldEditMode) {
        const isSelected = _worldEditSelected.has(w.id);
        const checkIcon = isSelected
            ? `<span class="msi" style="font-size:22px;color:var(--accent);">check_circle</span>`
            : `<span class="msi" style="font-size:22px;color:rgba(255,255,255,0.7);">radio_button_unchecked</span>`;
        return `<div class="vrcn-content-card" data-wid="${esc(w.id)}" onclick="toggleWorldEditSelect('${wid}',this)" style="user-select:none;">
            <div class="cc-bg" style="background-image:url('${cssUrl(imgThumb(thumb, 256))}')"></div>
            <div class="cc-scrim"></div>
            ${timeBadge}
            <div class="wd-edit-check">${checkIcon}</div>
            <div class="cc-content">
                <div class="cc-name">${esc(w.name)}</div>
                <div class="cc-bottom-row">
                    <div class="cc-meta">${esc(w.authorName)} · <span class="msi">person</span>${w.occupants} · <span class="msi">favorite</span>${w.favorites}</div>
                    ${tagsHtml}
                </div>
            </div>
            ${isSelected ? '<div class="wd-edit-sel-border"></div>' : ''}</div>`;
    }
    return `<div class="vrcn-content-card${opts?.cls || ''}" onclick="openWorldSearchDetail('${wid}')">
        <div class="cc-bg" style="background-image:url('${cssUrl(imgThumb(thumb, 256))}')"></div>
        <div class="cc-scrim"></div>
        ${timeBadge}${opts?.badges || ''}
        <div class="cc-content">
            <div class="cc-name">${esc(w.name)}</div>
            <div class="cc-bottom-row">
                <div class="cc-meta">${esc(w.authorName)} · <span class="msi">person</span>${w.occupants} · <span class="msi">favorite</span>${w.favorites}</div>
                ${tagsHtml}
            </div>
        </div>
    </div>`;
}

function filterFavWorlds() {
    _wdUpdateCounts();
    _wdRefreshTagOptions();
    const q = (document.getElementById('favWorldSearchInput')?.value || '').toLowerCase();
    let filtered = favWorldsData.filter(_wdHasTag);
    if (favWorldGroupFilter) filtered = filtered.filter(w => w.favoriteGroup === favWorldGroupFilter);
    if (q) filtered = filtered.filter(w => (w.name||'').toLowerCase().includes(q) || (w.authorName||'').toLowerCase().includes(q));
    const el = document.getElementById('favWorldsGrid');
    if (stillLoading(_favWorldsLoaded)) {
        el.innerHTML = loadingStateHtml(t('worlds.favorites.loading', 'Loading favorite worlds...'));
        setPaginator('favWorldsPaginatorBar', '');
        return;
    }
    if (!filtered.length) {
        el.innerHTML = q || favWorldGroupFilter || worldTagFilter
            ? emptyStateHtml('search', t('worlds.favorites.no_match', 'No favorites match your filter'))
            : emptyStateHtml('favorite', t('worlds.favorites.empty', 'No favorite worlds found'));
        setPaginator('favWorldsPaginatorBar', '');
        if (_worldEditMode) updateWorldEditBar();
        return;
    }
    if (lvViewMode('worlds') === 'list' && lvReady()) {
        lvKeepScroll(el, () => _worldsListPage(el, filtered, _favWorldsPage, 'favWorldsPaginatorBar', 'favWorldsGoPage', p => { _favWorldsPage = p; }));
        if (_worldEditMode) updateWorldEditBar();
        return;
    }
    setPaginator('favWorldsPaginatorBar', '');
    el.classList.add('search-grid');
    // Group by category when showing All Favorites
    if (!favWorldGroupFilter && favWorldGroups.length > 1) {
        let html = '';
        let first = true;
        favWorldGroups.forEach(g => {
            const groupWorlds = filtered.filter(w => w.favoriteGroup === g.name);
            if (!groupWorlds.length && !_worldEditMode) return;
            html += _wdGroupHeaderHtml(g, groupWorlds.length, first);
            html += groupWorlds.map(w => renderWorldCard(w)).join('');
            first = false;
        });
        el.innerHTML = html;
        el.querySelectorAll('select.vrcn-dropdown').forEach(initVnSelect);
    } else {
        const selected = favWorldGroupFilter
            ? favWorldGroups.find(x => x.name === favWorldGroupFilter)
            : null;
        const head = selected ? _wdGroupHeaderHtml(selected, filtered.length, true) : '';
        el.innerHTML = head + filtered.map(w => renderWorldCard(w)).join('');
        if (head) el.querySelectorAll('select.vrcn-dropdown').forEach(initVnSelect);
    }
    if (_worldEditMode) updateWorldEditBar();
}

/* === World Edit Mode === */
function toggleWorldEditMode() {
    if (_worldEditMode) { exitWorldEditMode(); return; }
    _worldEditMode = true;
    _worldEditSelected = new Set();
    const btn = document.getElementById('worldEditModeBtn');
    if (btn) { btn.innerHTML = `<span class="msi" style="font-size:16px;">check</span> <span>${t('worlds.edit.done', 'Done')}</span>`; btn.classList.add('active'); }
    const bar = document.getElementById('worldEditBar');
    if (bar) bar.style.display = 'flex';
    _wdEditRerender();
    updateFavWorldGroupHeader();
}

function exitWorldEditMode() {
    _worldEditMode = false;
    _worldEditSelected = new Set();
    const btn = document.getElementById('worldEditModeBtn');
    if (btn) { btn.innerHTML = `<span class="msi" style="font-size:16px;">edit</span> <span>${t('worlds.edit.button', 'Edit')}</span>`; btn.classList.remove('active'); }
    const bar = document.getElementById('worldEditBar');
    if (bar) bar.style.display = 'none';
    ['worldEditMovePicker', 'worldEditAddFavPicker'].forEach(id => {
        const picker = document.getElementById(id);
        if (picker) { picker.style.display = 'none'; picker.innerHTML = ''; }
    });
    _wdEditRerender();
    updateFavWorldGroupHeader();
}

function toggleWorldEditSelect(id, el) {
    if (_worldEditSelected.has(id)) {
        _worldEditSelected.delete(id);
        const chk = el?.querySelector('.wd-edit-check .msi');
        if (chk) { chk.textContent = 'radio_button_unchecked'; chk.style.color = 'rgba(255,255,255,0.7)'; }
        el?.querySelector('.wd-edit-sel-border')?.remove();
    } else {
        _worldEditSelected.add(id);
        const chk = el?.querySelector('.wd-edit-check .msi');
        if (chk) { chk.textContent = 'check_circle'; chk.style.color = 'var(--accent)'; }
        if (el && !el.querySelector('.wd-edit-sel-border')) {
            el.insertAdjacentHTML('beforeend', '<div class="wd-edit-sel-border"></div>');
        }
    }
    updateWorldEditBar();
}

function worldEditSelectAll() {
    const filtered = _wdEditVisibleList();
    const allSelected = filtered.length > 0 && filtered.every(w => _worldEditSelected.has(w.id));
    if (allSelected) filtered.forEach(w => _worldEditSelected.delete(w.id));
    else filtered.forEach(w => _worldEditSelected.add(w.id));
    _wdEditRerender();
}

function updateWorldEditBar() {
    const count = _worldEditSelected.size;
    const countEl = document.getElementById('worldEditCount');
    if (countEl) countEl.textContent = tf('worlds.edit.selected', { count }, '{count} selected');
    const selectAllBtn = document.getElementById('worldEditSelectAllBtn');
    if (selectAllBtn) {
        const filtered = _wdEditVisibleList();
        const allSel = filtered.length > 0 && filtered.every(w => _worldEditSelected.has(w.id));
        selectAllBtn.textContent = allSel ? t('worlds.edit.deselect_all', 'Deselect All') : t('worlds.edit.select_all', 'Select All');
    }
    document.querySelectorAll('.wd-edit-action').forEach(b => b.disabled = count === 0);
    _wdEditSyncButtons();
}

function worldEditShowMoveMenu(btn) {
    if (_worldEditSelected.size === 0) return;
    const picker = document.getElementById('worldEditMovePicker');
    if (!picker) return;
    if (picker.style.display === 'block') { picker.style.display = 'none'; picker.innerHTML = ''; return; }
    const groups = (typeof favWorldGroups !== 'undefined') ? favWorldGroups : [];
    picker.innerHTML = groups.map(g => {
        const count = favWorldsData.filter(fw => fw.favoriteGroup === g.name).length;
        const gn = jsq(g.name), gt = jsq(g.type);
        return `<div class="vn-select-option" onclick="worldEditMoveSelected('${gn}','${gt}')">
            <span class="msi" style="font-size:14px;flex-shrink:0;">folder</span>
            <span style="flex:1;">${esc(g.displayName || g.name)}</span>
            ${favGroupBadge(g)}
            <span style="font-size:calc(10px + var(--fs-off, 0px));color:var(--tx2);flex-shrink:0;">${count}</span>
        </div>`;
    }).join('');
    picker.style.display = 'block';
    setTimeout(() => {
        const close = (e) => {
            if (!picker.contains(e.target) && e.target !== btn) {
                picker.style.display = 'none';
                picker.innerHTML = '';
                document.removeEventListener('click', close);
            }
        };
        document.addEventListener('click', close);
    }, 0);
}

function worldEditMoveSelected(groupName, groupType) {
    if (_worldEditSelected.size === 0) return;
    const picker = document.getElementById('worldEditMovePicker');
    if (picker) { picker.style.display = 'none'; picker.innerHTML = ''; }
    const toMove = [..._worldEditSelected];
    toMove.forEach(worldId => {
        const entry = favWorldsData.find(w => w.id === worldId);
        if (entry && entry.favoriteGroup !== groupName) {
            sendToCS({ action: 'vrcAddWorldFavorite', worldId, groupName, groupType, oldFvrtId: entry.favoriteId || '' });
        }
    });
    exitWorldEditMode();
}

function worldEditRemoveSelected() {
    if (_worldEditSelected.size === 0) return;
    const toRemove = [..._worldEditSelected];
    toRemove.forEach(worldId => {
        const entry = favWorldsData.find(w => w.id === worldId);
        if (entry) sendToCS({ action: 'vrcRemoveWorldFavorite', worldId, fvrtId: entry.favoriteId });
    });
    exitWorldEditMode();
}

/* === Local Groups (Worlds) === */
function worldLocalGroupCount() {
    return (typeof favWorldGroups !== 'undefined' ? favWorldGroups : []).filter(isLocalFavGroup).length;
}

function worldShowCreateLocalGroup(btn) {
    const panel = document.getElementById('worldCreateLocalPanel');
    if (!panel) return;
    if (panel.style.display === 'block') { worldCancelCreateLocalGroup(); return; }
    if (worldLocalGroupCount() >= 100) { showToast(false, localFavErrorText('group_limit')); return; }
    panel.style.display = 'block';
    const input = document.getElementById('worldCreateLocalInput');
    if (input) { input.value = ''; input.focus(); }
    setTimeout(() => {
        const close = (e) => {
            if (!panel.contains(e.target) && !(btn && btn.contains(e.target))) {
                panel.style.display = 'none';
                document.removeEventListener('click', close);
            }
        };
        document.addEventListener('click', close);
    }, 0);
}

function worldCancelCreateLocalGroup() {
    const panel = document.getElementById('worldCreateLocalPanel');
    if (panel) panel.style.display = 'none';
}

function worldSaveLocalGroup() {
    const input = document.getElementById('worldCreateLocalInput');
    const name = (input?.value || '').trim();
    if (!name) { showToast(false, localFavErrorText('empty_name')); return; }
    sendToCS({ action: 'vrcCreateLocalGroup', kind: 'world', displayName: name });
    worldCancelCreateLocalGroup();
}

function deleteCurrentLocalWorldGroup(btn) {
    const g = favWorldGroups.find(x => x.name === favWorldGroupFilter);
    if (!g || !isLocalFavGroup(g)) return;
    if (btn && btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.classList.add('myp-edit-btn-danger');
        btn.title = t('favorites.delete_local_group_confirm', 'Click again to delete');
        clearTimeout(btn._confirmTimer);
        btn._confirmTimer = setTimeout(() => {
            btn.dataset.confirm = '0';
            btn.classList.remove('myp-edit-btn-danger');
            btn.title = t('favorites.delete_local_group', 'Delete local group');
        }, 3000);
        return;
    }
    if (btn) { btn.dataset.confirm = '0'; btn.classList.remove('myp-edit-btn-danger'); clearTimeout(btn._confirmTimer); }
    sendToCS({ action: 'vrcDeleteLocalGroup', kind: 'world', groupName: g.name });
    favWorldGroupFilter = '';
}


_worldsSyncViewBtns();

function _wdEditIsMine() {
    return worldFilter === 'mine';
}

function _wdEditVisibleList() {
    if (_wdEditIsMine()) {
        const q = (document.getElementById('worldMineSearchInput')?.value || '').toLowerCase();
        return q
            ? _myWorldsData.filter(w => (w.name || '').toLowerCase().includes(q) || (w.authorName || '').toLowerCase().includes(q))
            : _myWorldsData;
    }
    const q = (document.getElementById('favWorldSearchInput')?.value || '').toLowerCase();
    let filtered = favWorldsData;
    if (favWorldGroupFilter) filtered = filtered.filter(w => w.favoriteGroup === favWorldGroupFilter);
    if (q) filtered = filtered.filter(w => (w.name || '').toLowerCase().includes(q) || (w.authorName || '').toLowerCase().includes(q));
    return filtered;
}

function _wdEditRerender() {
    if (_wdEditIsMine()) renderMyWorlds();
    else filterFavWorlds();
}

function _wdEditSyncButtons() {
    const isMine = _wdEditIsMine();
    const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.style.display = on ? '' : 'none';
    };
    show('worldEditAddFavWrap', isMine);
    show('worldEditMoveWrap', !isMine);
    show('worldEditRemoveBtn', !isMine);
    show('worldEditDeleteBtn', isMine);
}

lvEditRegister('worlds', {
    attr: 'data-wid',
    isActive: () => _worldEditMode,
    isSelected: id => _worldEditSelected.has(id),
    toggle: id => { if (_worldEditSelected.has(id)) _worldEditSelected.delete(id); else _worldEditSelected.add(id); },
    onChange: () => updateWorldEditBar(),
});

function worldEditShowAddFavMenu(btn) {
    if (_worldEditSelected.size === 0) return;
    const picker = document.getElementById('worldEditAddFavPicker');
    if (!picker) return;
    if (picker.style.display === 'block') { picker.style.display = 'none'; picker.innerHTML = ''; return; }
    const groups = (typeof favWorldGroups !== 'undefined') ? favWorldGroups : [];
    picker.innerHTML = groups.map(g => {
        const count = favWorldsData.filter(w => w.favoriteGroup === g.name).length;
        const gn = jsq(g.name), gt = jsq(g.type);
        return `<div class="vn-select-option" onclick="worldEditAddToFavorites('${gn}','${gt}')">
            <span class="msi" style="font-size:14px;flex-shrink:0;">favorite</span>
            <span style="flex:1;">${esc(g.displayName || g.name)}</span>
            ${favGroupBadge(g)}
            <span style="font-size:calc(10px + var(--fs-off, 0px));color:var(--tx2);flex-shrink:0;">${count}</span>
        </div>`;
    }).join('') || `<div class="vn-select-option" style="pointer-events:none;color:var(--tx3);">${esc(t('worlds.favorites.no_groups', 'No favorite groups'))}</div>`;
    picker.style.display = 'block';
    setTimeout(() => {
        const close = (e) => {
            if (!picker.contains(e.target) && e.target !== btn) {
                picker.style.display = 'none';
                picker.innerHTML = '';
                document.removeEventListener('click', close);
            }
        };
        document.addEventListener('click', close);
    }, 0);
}

function worldEditAddToFavorites(groupName, groupType) {
    if (_worldEditSelected.size === 0) return;
    const picker = document.getElementById('worldEditAddFavPicker');
    if (picker) { picker.style.display = 'none'; picker.innerHTML = ''; }
    const ids = [..._worldEditSelected];
    ids.forEach(worldId => {
        if (favWorldsData.some(w => w.id === worldId && w.favoriteGroup === groupName)) return;
        sendToCS({ action: 'vrcAddWorldFavorite', worldId, groupName, groupType, oldFvrtId: '' });
    });
    showToast(true, tf('worlds.edit.added_to_favorites', { count: ids.length }, 'Added {count} worlds to favorites'));
    exitWorldEditMode();
}

let _wdBulkDeletePending = 0;
let _wdBulkDeleteOk = 0;

function worldEditDeleteSelected() {
    const ids = [..._worldEditSelected];
    if (!ids.length) return;
    const names = ids.map(id => (_myWorldsData.find(w => w.id === id)?.name) || id).slice(0, 6);
    const more = ids.length - names.length;
    const listHtml = names.map(n => `<div>${esc(n)}</div>`).join('')
        + (more > 0 ? `<div>${esc(tf('worlds.edit.bulk_delete_more', { count: more }, '+{count} more'))}</div>` : '');

    vrcnConfirmDelete({
        id: 'worldBulkDeleteModal',
        title: t('worlds.edit.bulk_delete', 'Bulk Delete'),
        icon: 'delete',
        message: tf('worlds.edit.bulk_delete_confirm', { count: ids.length },
            'Delete {count} worlds? They are hidden and their files are removed. This cannot be undone.'),
        listHtml,
        confirmLabel: t('worlds.edit.bulk_delete', 'Bulk Delete'),
        onConfirm: () => {
            _wdBulkDeletePending = ids.length;
            _wdBulkDeleteOk = 0;
            ids.forEach(worldId => sendToCS({ action: 'vrcDeleteWorld', worldId }));
            const gone = new Set(ids);
            _myWorldsData = _myWorldsData.filter(w => !gone.has(w.id));
            _wdUpdateCounts();
            exitWorldEditMode();
        },
    });
}

function wdBulkDeleteConsume(success) {
    if (_wdBulkDeletePending <= 0) return false;
    _wdBulkDeletePending--;
    if (success) _wdBulkDeleteOk++;
    if (_wdBulkDeletePending === 0) {
        showToast(_wdBulkDeleteOk > 0, tf('worlds.edit.bulk_delete_done', { count: _wdBulkDeleteOk }, 'Deleted {count} worlds'));
        sendToCS({ action: 'vrcGetMyWorlds' });
    }
    return true;
}
