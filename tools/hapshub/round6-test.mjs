// Drives the built app through round 6 (docs/hapshub/round6-requirements.md): the Settings clean-up, plugin options
// that fold open, themed controls, launch switches, and the rest as they land.
// Uses a throwaway data folder, no login and no VRChat traffic. Stops only what it started.
//   node tools/hapshub/round6-test.mjs [--release] [--only name[,name...]]   (HAPSHUB_KEEP_LOG=file saves the app log if the app quits mid-run)

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePng } from './lib/png.mjs';
import { checker, cleanUp, closeMain, crashDetail, crashes, freshData, hubLog, openMain, seen, sleep, waitFor, waitSeen } from './lib/harness.mjs';

const PORT = 9341;
const { check, state } = checker();
// --only takes one section name or several, comma-separated.
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',').map(n => n.trim()) : null;
const sections = [];
const section = (name, run) => sections.push({ name, run });
const savedSettings = dir => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

section('nav tabs', async main => {
    // Every sidebar entry must open its own page. Tab ids have gaps (tab17 is in the HTML, tab34 is not), and a
    // positional lookup once sent Space Calibrator to VRCT, VRCT to OVR Toolkit and OVR Toolkit to World Map.
    const entries = await main.json(`Object.entries(NAV_ITEMS_DEF).filter(([, d]) => Number.isInteger(d.tab)).map(([k, d]) => [k, d.tab])`);
    const wrong = [];
    for (const [key, tab] of entries) {
        const got = await main.json(`(() => {
            const btn = document.querySelector('#sidebarEl .nav-btn[onclick*="showTab(${tab})"]');
            if (btn) btn.click(); else showTab(${tab});
            const active = [...document.querySelectorAll('.tab.active')].map(t => t.id);
            return { via: btn ? 'button' : 'showTab', active };
        })()`);
        if (got.active.length !== 1 || got.active[0] !== 'tab' + tab) wrong.push(`${key}(${got.via}) -> ${got.active.join('+') || 'nothing'}`);
    }
    check('every sidebar entry opens its own tab', wrong.length === 0, wrong.join('; ') || `${entries.length} entries`);
    await main.eval(`showTab(NAV_ITEMS_DEF['world-map'].tab)`);
    const mapBuilt = await waitFor('the World Map tab', () => main.eval(`(() => { const t = document.getElementById('tab' + NAV_ITEMS_DEF['world-map'].tab); return !!t && t.classList.contains('active') && t.offsetHeight > 0 && t.children.length > 0; })()`), 5000).catch(() => false);
    check('the World Map tab shows something', !!mapBuilt);
    await main.eval(`showTab(0)`);
});

section('issue 12 layout state', async main => {
    // body:has(...) rules were replaced by body classes mirrored from the sidebars and the Dashboard tab.
    // eval, not json: json() does not wait for a promise.
    const got = JSON.parse(await main.eval(`(async () => {
        const frame = () => new Promise(r => setTimeout(r, 30));
        showTab(0); await frame();
        const onDash = document.body.classList.contains('tab0-active');
        showTab(8); await frame();
        const offDash = !document.body.classList.contains('tab0-active');
        const sb = document.getElementById('sidebarEl');
        const was = sb.classList.contains('collapsed');
        sb.classList.add('collapsed'); await frame();
        const collapsed = document.body.classList.contains('sb-l-collapsed');
        if (!was) sb.classList.remove('collapsed'); await frame();
        const restored = document.body.classList.contains('sb-l-collapsed') === was;
        const hasRules = [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => /body:has\\(/.test(r.selectorText || '')); } catch { return false; } });
        showTab(0);
        return JSON.stringify({ onDash, offDash, collapsed, restored, hasRules });
    })()`));
    check('body mirrors the Dashboard tab and the sidebar state', got.onDash && got.offDash && got.collapsed && got.restored, JSON.stringify(got));
    check('no body:has() rules are left in the page', !got.hasRules, JSON.stringify(got));
    const badge = await main.json(`(() => {
        _navApplyBadge('library', 12345);
        const el = document.querySelector('[data-nav-badge="library"]');
        if (!el) return { skipped: true };
        const node = el.firstChild;
        _navApplyBadge('library', 12345);
        return { same: el.firstChild === node, text: el.textContent };
    })()`);
    check('an unchanged sidebar badge is not rewritten', badge.skipped || badge.same, JSON.stringify(badge));
});

section('world tags (issue 13)', async main => {
    const got = await main.json(`(() => {
        showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
        setWorldFilter('recent');
        renderVisitedWorlds([
            { id: 'wrld_a', name: 'Alpha', tags: ['author_tag_horror', 'system_approved'] },
            { id: 'wrld_b', name: 'Beta', tags: ['author_tag_chill', 'author_tag_horror'] },
            { id: 'wrld_c', name: 'Gamma', tags: ['author_tag_chill'] },
        ]);
        const sel = document.getElementById('worldTagFilter');
        const options = [...sel.options].map(o => o.value + '=' + o.textContent);
        const shown = () => document.getElementById('worldRecentGrid').querySelectorAll('[onclick*="wrld_"], .vrcn-content-card, .world-card').length;
        const all = shown();
        setWorldTagFilter('author_tag_horror');
        const horror = document.getElementById('worldRecentGrid').textContent;
        setWorldTagFilter('author_tag_none');
        const none = document.getElementById('worldRecentGrid').textContent;
        setWorldFilter('explore');
        const hiddenOnSearch = document.getElementById('worldTagWrap').style.display === 'none';
        setWorldFilter('favorites');
        return { options, all, horror, none, hiddenOnSearch, reset: worldTagFilter === '' };
    })()`);
    check('the tag list offers author tags with counts, most common first, and no system tags',
        got.options[1]?.startsWith('author_tag_chill=') && got.options[2]?.startsWith('author_tag_horror=') && !got.options.some(o => o.startsWith('system_')), got.options.join(' | '));
    check('picking a tag shows only worlds with it', got.horror.includes('Alpha') && got.horror.includes('Beta') && !got.horror.includes('Gamma'), got.horror.slice(0, 120));
    check('a tag no world has says so', /tag/i.test(got.none), got.none.slice(0, 120));
    check('Explore hides the tag filter and switching clears it', got.hiddenOnSearch && got.reset, JSON.stringify(got));
});

section('explore', async main => {
    // Item 14: Explore replaces the Discover and Search sub-tabs. Requests are caught here (no login, no traffic) and
    // VRChat's answers are played in, so this checks what is asked for and what is shown.
    const got = await main.json(`(() => {
        const sent = [];
        const realSend = sendToCS;
        window.sendToCS = m => { sent.push(m); };
        const input = document.getElementById('searchWorldsInput');
        const grid = () => document.getElementById('searchWorldsResults').textContent;
        const rows = (n, p) => Array.from({ length: n }, (_, i) => ({ id: 'wrld_' + p + i, name: p + ' world ' + i, tags: [] }));
        try {
            _explore.entries = {}; _explore.view = 'active'; _explore.query = ''; input.value = '';
            showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
            const btns = [...document.querySelectorAll('#worldFilterBtns button')].map(b => b.id);
            setWorldFilter('search');
            const opened = worldFilter === 'explore' && document.getElementById('worldExploreArea').style.display === '';
            const firstAsk = sent.find(m => m.action === 'vrcGetWorldDiscover')?.mode;
            _handleBackendMessage('vrcWorldDiscover', { mode: 'popular', ok: true, worlds: [
                { id: 'wrld_a', name: 'Lounge One', authorName: 'Ann', tags: ['author_tag_chill'] },
                { id: 'wrld_b', name: 'Night Club', authorName: 'Bob', tags: ['author_tag_dance'] } ] });
            const live = grid();

            input.value = 'chill';
            sent.length = 0;
            setExploreView('active');
            const narrowed = grid();
            const note = document.getElementById('exploreNote').style.display !== 'none';
            const liveAsked = sent.length;

            exploreSearch();
            const rel = { view: _explore.view, ask: sent.find(m => m.action === 'vrcExploreWorlds') || null,
                shown: document.getElementById('exploreView_relevance').style.display !== 'none' };
            _handleBackendMessage('vrcExploreResults', { view: 'relevance', query: 'chill', offset: 0, ok: true, hasMore: true, worlds: rows(40, 'r') });
            const more = !!document.querySelector('#searchWorldsResults .explore-more button');
            sent.length = 0;
            exploreLoadMore();
            const moreAsk = sent.find(m => m.action === 'vrcExploreWorlds') || null;
            _handleBackendMessage('vrcExploreResults', { view: 'relevance', query: 'chill', offset: 40, ok: true, hasMore: false,
                worlds: [{ id: 'wrld_r0', name: 'r world 0', tags: [] }, { id: 'wrld_new', name: 'Fresh One', tags: [] }] });
            const after = { count: _explore.shown.length, more: !!document.querySelector('#searchWorldsResults .explore-more'), fresh: grid().includes('Fresh One') };

            input.value = '';
            sent.length = 0;
            setExploreView('new');
            const newAsk = sent.filter(m => m.action === 'vrcExploreWorlds').map(m => m.view + ':' + m.offset + ':' + m.query);
            _handleBackendMessage('vrcExploreResults', { view: 'new', query: '', offset: 0, ok: true, hasMore: false, worlds: rows(3, 'n') });
            setExploreView('active'); setExploreView('new');
            const again = sent.filter(m => m.action === 'vrcExploreWorlds').length;
            const relGone = document.getElementById('exploreView_relevance').style.display === 'none';
            sent.length = 0;
            exploreRefresh();
            const refreshAsk = sent.find(m => m.action === 'vrcExploreWorlds') || null;

            setExploreView('labs');
            _handleBackendMessage('vrcExploreResults', { view: 'labs', query: '', offset: 0, ok: false, hasMore: false, worlds: [] });
            const failed = /could not load/i.test(grid());
            return { btns, opened, firstAsk, live, narrowed, note, liveAsked, rel, more, moreAsk, after, newAsk, again, relGone, refreshAsk, failed };
        } finally {
            window.sendToCS = realSend;
            _explore.entries = {}; _explore.view = 'active'; _explore.query = ''; input.value = '';
            setWorldFilter('favorites');
        }
    })()`);
    check('Explore: one Explore sub-tab, no Search or Discover sub-tab, and old links open it',
        got.btns.includes('worldFilterExplore') && !got.btns.some(id => /Search|Discover/.test(id)) && got.opened, JSON.stringify(got.btns));
    check('Explore: opens on Active now (the old Popular list) and shows its worlds',
        got.firstAsk === 'popular' && got.live.includes('Lounge One') && got.live.includes('Night Club'), got.firstAsk + ' ' + got.live.slice(0, 80));
    check('Explore: text in a live view narrows it here, says so, and asks VRChat nothing',
        got.narrowed.includes('Lounge One') && !got.narrowed.includes('Night Club') && got.note && got.liveAsked === 0, JSON.stringify({ n: got.narrowed.slice(0, 80), note: got.note, asked: got.liveAsked }));
    check('Explore: Search in a live view searches all worlds by best match',
        got.rel.view === 'relevance' && got.rel.shown && got.rel.ask?.view === 'relevance' && got.rel.ask?.query === 'chill' && got.rel.ask?.offset === 0, JSON.stringify(got.rel));
    check('Explore: Load more asks for the next page and adds only worlds not shown yet',
        got.more && got.moreAsk?.offset === 40 && got.after.count === 41 && got.after.fresh && !got.after.more, JSON.stringify({ ask: got.moreAsk, after: got.after }));
    check('Explore: a view asks once, then comes from memory; Best match hides without text',
        got.newAsk.join() === 'new:0:' && got.again === 1 && got.relGone, JSON.stringify({ newAsk: got.newAsk, again: got.again, relGone: got.relGone }));
    check('Explore: Refresh asks VRChat again, past the cache', got.refreshAsk?.fresh === true && got.refreshAsk?.offset === 0, JSON.stringify(got.refreshAsk));
    check('Explore: a view that fails to load says so', got.failed);
});

section('explore filters', async main => {
    // Item 14 step 2. Platform, warnings and tag chips go to VRChat with the request and key the cache; published,
    // capacity and language are checked on the loaded worlds, fetching at most three pages for one click.
    const got = await main.json(`(() => {
        const sent = [];
        const realSend = sendToCS;
        window.sendToCS = m => { sent.push(m); };
        const asks = () => sent.filter(m => m.action === 'vrcExploreWorlds');
        const ids = () => _explore.shown.map(w => w.id).join(',');
        const grid = () => document.getElementById('searchWorldsResults').textContent;
        const ago = d => new Date(Date.now() - d * 86400000).toISOString();
        const real = { fav: favWorldsData, visited: _visitedWorldsData, loaded: _visitedWorldsLoaded };
        const out = {};
        try {
            exploreClearFilters();
            _explore.entries = {}; _explore.view = 'active'; _explore.query = ''; _explore.askedVisited = false;
            document.getElementById('searchWorldsInput').value = '';
            favWorldsData = [{ id: 'wrld_f1', tags: ['author_tag_chill', 'author_tag_flowers'] }, { id: 'wrld_f2', tags: ['author_tag_chill', 'system_approved'] }];
            _visitedWorldsData = [{ id: 'wrld_f1', tags: ['author_tag_chill'] }, { id: 'wrld_v1', tags: ['author_tag_photography', 'author_tag_chill'] }];
            _visitedWorldsLoaded = false;
            showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
            setWorldFilter('explore'); setWorldFilter('favorites'); setWorldFilter('explore');
            out.visitedAsks = sent.filter(m => m.action === 'vrcGetVisitedWorlds').length;
            out.chips = [...document.querySelectorAll('#exploreChips .explore-chip')].map(b => b.dataset.tag);

            exploreCycleTag('author_tag_chill');
            out.chipIn = document.querySelector('#exploreChips [data-tag="author_tag_chill"]')?.className || '';
            exploreSetFilter('platform', 'quest');
            exploreToggleContent('content_horror', true);
            sent.length = 0;
            setExploreView('new');
            out.ask = asks()[0] || null;
            const W = (id, extra) => ({ id, name: id, tags: ['author_tag_chill'], platforms: ['standalonewindows', 'android'], capacity: 16, publicationDate: ago(10), ...extra });
            _handleBackendMessage('vrcExploreResults', { view: 'new', query: '', offset: 0, ok: true, hasMore: false, sig: out.ask?.sig, worlds: [
                W('wrld_ok'), W('wrld_pconly', { platforms: ['standalonewindows'] }), W('wrld_horror', { tags: ['author_tag_chill', 'content_horror'] }),
                W('wrld_dance', { tags: ['author_tag_dance'] }), W('wrld_old', { publicationDate: ago(800) }), W('wrld_big', { capacity: 80 }),
                W('wrld_jp', { name: 'まったりカフェ' }) ] });
            out.serverOnly = ids();
            sent.length = 0;
            exploreSetFilter('age', 365); exploreSetFilter('capMax', 32);
            out.client = ids();
            exploreSetFilter('lang', 'ja'); out.ja = ids();
            exploreSetFilter('lang', 'en'); out.en = ids();
            out.clientAsks = asks().length;
            out.note = document.getElementById('exploreNote').textContent;
            out.count = document.querySelector('#exploreFilterBtn .explore-filter-count')?.textContent;
            out.saved = JSON.parse(localStorage.getItem('vrcn_exploreFilters') || '{}');
            out.langs = [{ name: 'Bienvenidos al mundo', description: 'un lugar para relajarse con amigos' }, { name: '한국 카페' },
                { name: 'Cozy Room', tags: ['author_tag_japanese'] }, { name: '夜の街' }, { name: '中文世界' }, { name: 'Midnight Rooftop' }]
                .map(w => [..._exploreLangs(w)].sort().join('+'));

            // Each set of server filters is its own page in the cache: in -> out -> off asks twice, back to "in" asks nothing.
            sent.length = 0;
            exploreCycleTag('author_tag_chill'); exploreCycleTag('author_tag_chill'); exploreCycleTag('author_tag_chill');
            out.cycle = asks().map(m => (m.tags || []).join('+') + '/' + (m.notags || []).join('+'));
            out.backShown = ids();

            // Filters that hide a whole page fetch the next one, three requests at most for one click.
            exploreClearFilters();
            exploreSetFilter('capMin', 50);
            sent.length = 0;
            setExploreView('popular');
            const small = p => Array.from({ length: 40 }, (_, i) => ({ id: 'wrld_' + p + i, name: p + i, tags: [], capacity: 10 }));
            for (const [i, p] of ['p', 'q', 's'].entries()) {
                const a = asks()[i];
                if (a) _handleBackendMessage('vrcExploreResults', { view: 'popular', query: '', offset: a.offset, ok: true, hasMore: true, sig: a.sig, worlds: small(p) });
            }
            out.chain = asks().map(m => m.offset);
            out.chainEmpty = /match your filters/i.test(grid());
            out.chainMoreBtn = !!document.querySelector('#searchWorldsResults .explore-more .load-more-btn');
            sent.length = 0;
            exploreLoadMore();
            out.nextClick = asks().map(m => m.offset);

            // "New" with a Published limit stops paging once a page reaches past it.
            exploreClearFilters();
            exploreSetFilter('age', 30);
            _explore.entries = {};
            sent.length = 0;
            setExploreView('new');
            const na = asks()[0];
            _handleBackendMessage('vrcExploreResults', { view: 'new', query: '', offset: 0, ok: true, hasMore: true, sig: na?.sig,
                worlds: [W('wrld_n1', { publicationDate: ago(5) }), W('wrld_n2', { publicationDate: ago(20) }), W('wrld_n3', { publicationDate: ago(60) })] });
            out.newStop = { asks: asks().length, shown: ids(), more: !!document.querySelector('#searchWorldsResults .load-more-btn') };

            // Live views are filtered here too, and never ask GET /worlds.
            exploreClearFilters();
            exploreSetFilter('platform', 'pc');
            sent.length = 0;
            setExploreView('active');
            _handleBackendMessage('vrcWorldDiscover', { mode: 'popular', ok: true, worlds: [
                { id: 'wrld_l1', name: 'Quest Club', tags: [], unityPackages: [{ platform: 'standalonewindows' }, { platform: 'android' }] },
                { id: 'wrld_l2', name: 'PC Lounge', tags: [], unityPackages: [{ platform: 'standalonewindows' }] },
                { id: 'wrld_l3', name: 'Unknown', tags: [] } ] });
            out.live = ids();
            out.liveAsks = asks().length;

            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            const panel = document.getElementById('exploreFilterPanel');
            out.panel = { open: panel?.style.display === 'block', selects: panel?.querySelectorAll('select').length, boxes: panel?.querySelectorAll('.explore-cw-grid input[type=checkbox]').length };
            exploreAddTag('#Night Life');
            out.added = _exploreFilters.tagsIn.join();
            exploreAddTag('bad,tag');
            out.badKept = _exploreFilters.tagsIn.join();
            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            out.closed = panel?.style.display !== 'block';
            return out;
        } finally {
            window.sendToCS = realSend;
            exploreClearFilters();
            favWorldsData = real.fav; _visitedWorldsData = real.visited; _visitedWorldsLoaded = real.loaded;
            _explore.entries = {}; _explore.view = 'active'; _explore.query = '';
            setWorldFilter('favorites');
        }
    })()`);
    check('Explore filters: chips are the author tags of favorite and visited worlds, most common first; visited worlds are asked for once',
        got.chips.join() === 'author_tag_chill,author_tag_flowers,author_tag_photography' && got.visitedAsks === 1, JSON.stringify({ chips: got.chips, asks: got.visitedAsks }));
    check('Explore filters: platform, warnings and tag chips go to VRChat with the request',
        /\bin\b/.test(got.chipIn) && got.ask?.platform === 'quest' && got.ask?.tags?.join() === 'author_tag_chill' && got.ask?.notags?.join() === 'content_horror' && typeof got.ask?.sig === 'string',
        JSON.stringify({ chip: got.chipIn, ask: got.ask }));
    check('Explore filters: the page also checks those filters on what comes back',
        got.serverOnly === 'wrld_ok,wrld_old,wrld_big,wrld_jp', got.serverOnly);
    check('Explore filters: published, capacity and language filter the loaded worlds without asking VRChat',
        got.client === 'wrld_ok,wrld_jp' && got.ja === 'wrld_jp' && got.en === 'wrld_ok' && got.clientAsks === 0, JSON.stringify({ client: got.client, ja: got.ja, en: got.en, asks: got.clientAsks }));
    check('Explore filters: the count, the "hidden" note and saved filters follow the choices',
        got.count === '6' && /6 of 7/.test(got.note) && got.saved.age === 365 && got.saved.capMax === 32 && got.saved.lang === 'en' && got.saved.platform === 'quest',
        JSON.stringify({ count: got.count, note: got.note, saved: got.saved }));
    check('Explore filters: language is guessed from tags, script and common words',
        got.langs.join() === 'es,ko,ja,ja,zh,en', got.langs.join());
    check('Explore filters: each set of VRChat filters is cached on its own',
        got.cycle.join(' ') === '/author_tag_chill+content_horror /content_horror' && got.backShown === 'wrld_ok', JSON.stringify({ cycle: got.cycle, back: got.backShown }));
    check('Explore filters: when filters hide a page, one click fetches at most three pages, then Load more goes on',
        got.chain.join() === '0,40,80' && got.chainEmpty && got.chainMoreBtn && got.nextClick.join() === '120', JSON.stringify({ chain: got.chain, empty: got.chainEmpty, btn: got.chainMoreBtn, next: got.nextClick }));
    check('Explore filters: New stops paging once it is past the Published limit',
        got.newStop.asks === 1 && got.newStop.shown === 'wrld_n1,wrld_n2' && !got.newStop.more, JSON.stringify(got.newStop));
    check('Explore filters: live views are filtered here and never ask GET /worlds',
        got.live === 'wrld_l2,wrld_l3' && got.liveAsks === 0, JSON.stringify({ live: got.live, asks: got.liveAsks }));
    check('Explore filters: the panel opens with its controls, adds a typed tag, refuses a bad one, and closes',
        got.panel.open && got.panel.selects >= 3 && got.panel.boxes === 6 && got.added === 'author_tag_night_life' && got.badKept === 'author_tag_night_life' && got.closed,
        JSON.stringify({ panel: got.panel, added: got.added, bad: got.badKept, closed: got.closed }));
});

section('explore personal', async main => {
    // Item 14 step 3. Visited badge and "hide visited", the hide list (a world, an author, a tag) and private like/dislike
    // with a Liked view. Kept in localStorage only, never sent to VRChat; the right-click menu on Explore cards drives it.
    const got = await main.json(`(() => {
        const sent = [];
        const realSend = sendToCS;
        window.sendToCS = m => { sent.push(m); };
        const ids = () => _explore.shown.map(w => w.id).join(',');
        const real = { visited: _visitedWorldsData, loaded: _visitedWorldsLoaded, asked: _explore.askedVisited, store: localStorage.getItem('vrcn_explorePersonal') };
        const out = {};
        try {
            exploreClearFilters();
            Object.assign(_explorePersonal, { liked: {}, disliked: {}, worlds: {}, authors: {}, tags: [], showHidden: false });
            _exploreSavePersonal();
            _explore.entries = {}; _explore.view = 'active'; _explore.query = ''; _explore.askedVisited = true;
            document.getElementById('searchWorldsInput').value = '';
            _visitedWorldsData = [{ id: 'wrld_b', tags: [] }]; _visitedWorldsLoaded = true;
            showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
            setWorldFilter('explore');
            setExploreView('popular');
            const ask = sent.find(m => m.action === 'vrcExploreWorlds');
            const W = (id, extra) => ({ id, name: 'World ' + id.slice(5), authorId: 'usr_x', authorName: 'Xan', tags: ['author_tag_chill'], capacity: 16, occupants: 3, favorites: 9, ...extra });
            _handleBackendMessage('vrcExploreResults', { view: 'popular', query: '', offset: 0, ok: true, hasMore: false, sig: ask?.sig, worlds: [
                W('wrld_a', { worldVisitCount: 4 }), W('wrld_b'), W('wrld_c', { authorId: 'usr_y', authorName: 'Yui' }),
                W('wrld_d', { authorId: 'usr_y', authorName: 'Yui', tags: ['author_tag_horror'] }),
                W('wrld_e', { authorId: 'usr_z', authorName: 'Zed', tags: ['author_tag_dance'] }) ] });
            const before = sent.length;
            const card = id => [...document.querySelectorAll('#searchWorldsResults .vrcn-content-card')].find(c => (c.getAttribute('onclick') || '').includes(id));
            out.visitedBadges = ['wrld_a', 'wrld_b', 'wrld_c'].map(id => !!card(id)?.querySelector('.explore-badge.visited'));
            out.visitTitle = card('wrld_a')?.querySelector('.explore-badge.visited')?.title || '';
            exploreSetFilter('hideVisited', true);
            out.hideVisited = ids();
            out.count = document.querySelector('#exploreFilterBtn .explore-filter-count')?.textContent;
            out.savedVisited = JSON.parse(localStorage.getItem('vrcn_exploreFilters') || '{}').hideVisited;
            exploreSetFilter('hideVisited', false);

            // Right-click an Explore card: the usual world items, then like, dislike and hide.
            const menuFor = id => {
                card(id)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
                return document.getElementById('vn-ctx-menu');
            };
            const labels = menu => [...menu.querySelectorAll('.vn-ctx-item .vn-ctx-label')].map(x => x.textContent.trim());
            const pick = (menu, text) => [...menu.querySelectorAll('.vn-ctx-item')].find(b => b.querySelector('.vn-ctx-label')?.textContent.trim() === text)?.click();
            let menu = menuFor('wrld_c');
            out.menu = labels(menu);
            pick(menu, 'Hide all worlds by Yui');
            out.afterAuthor = ids();
            out.note = document.getElementById('exploreNote').textContent;
            pick(menuFor('wrld_a'), 'Like');
            pick(menuFor('wrld_e'), 'Dislike (hide)');
            out.afterDislike = ids();
            out.likedMenuChecked = !![...menuFor('wrld_a').querySelectorAll('.vn-ctx-item')].find(b => b.querySelector('.vn-ctx-label')?.textContent.trim() === 'Like')?.querySelector('.vn-ctx-check');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            exploreHideTag('author_tag_chill', true);
            out.afterTag = ids();
            exploreHideTag('author_tag_chill', false);
            exploreHideWorld('wrld_b', true);
            out.afterWorld = ids();

            // Show hidden: all back, the hidden ones marked; the panel lists them and unhides an author.
            exploreShowHidden(true);
            out.shown = ids();
            out.marked = document.querySelectorAll('#searchWorldsResults .explore-hidden').length;
            setWorldsViewMode('list');
            out.listMarked = document.querySelectorAll('#searchWorldsResults [data-wid].explore-hidden').length;
            setWorldsViewMode('grid');
            out.dislikeBadge = !!card('wrld_e')?.querySelector('.explore-badge.hidden');
            out.likedBadge = !!card('wrld_a')?.querySelector('.explore-badge.liked');
            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            const panel = document.getElementById('exploreFilterPanel');
            out.panelSum = panel.querySelector('.explore-personal-sum')?.textContent || '';
            out.panelChips = [...panel.querySelectorAll('.explore-personal-chips .explore-chip')].map(b => b.dataset.kind + ':' + b.dataset.key);
            out.panelBoxes = ['exploreHideVisited', 'exploreShowHidden'].map(id => !!panel.querySelector('#' + id));
            panel.querySelector('.explore-personal-chips [data-key="usr_y"]')?.click();
            out.panelAfter = panel.querySelectorAll('.explore-personal-chips .explore-chip').length;
            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            exploreShowHidden(false);
            out.afterUnhide = ids();

            // Liked view: built from the copy kept at the like, asks nothing; search narrows it; unlike empties it.
            setExploreView('liked');
            out.liked = ids();
            out.likedCard = document.getElementById('searchWorldsResults').textContent.includes('World a');
            document.getElementById('searchWorldsInput').value = 'zzz';
            exploreSearch();
            out.likedSearch = _explore.view + '/' + ids();
            document.getElementById('searchWorldsInput').value = '';
            exploreSearch();
            pick(menuFor('wrld_a'), 'Like');
            out.likedEmpty = /No liked worlds/.test(document.getElementById('searchWorldsResults').textContent);
            out.sentAfter = sent.slice(before).map(m => m.action);

            // Stored on this computer only; bad entries are dropped when read back.
            const stored = JSON.parse(localStorage.getItem('vrcn_explorePersonal') || '{}');
            out.stored = [stored.disliked, stored.worlds, stored.authors, stored.liked].map(m => Object.keys(m || {}).join('+')).join('|');
            localStorage.setItem('vrcn_explorePersonal', JSON.stringify({ liked: { wrld_ok: { name: 'Ok', at: 2 }, 'bad id!': { name: 'x' }, wrld_arr: [1] },
                tags: ['author_tag_ok', 'nope tag'], showHidden: 'yes' }));
            const re = _exploreLoadPersonal();
            out.reload = Object.keys(re.liked).join() + '|' + re.tags.join() + '|' + re.showHidden;
            return out;
        } finally {
            window.sendToCS = realSend;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            exploreClearFilters();
            if (real.store == null) localStorage.removeItem('vrcn_explorePersonal'); else localStorage.setItem('vrcn_explorePersonal', real.store);
            Object.assign(_explorePersonal, _exploreLoadPersonal());
            _exploreLikedMemo = null;
            _visitedWorldsData = real.visited; _visitedWorldsLoaded = real.loaded; _explore.askedVisited = real.asked;
            _explore.entries = {}; _explore.view = 'active'; _explore.query = '';
            document.getElementById('searchWorldsInput').value = '';
            setWorldFilter('favorites');
        }
    })()`);
    check('Explore personal: cards show Visited from the visit count or the visited list; "hide visited" filters them and is saved',
        got.visitedBadges.join() === 'true,true,false' && got.visitTitle === 'Visits: 4' && got.hideVisited === 'wrld_c,wrld_d,wrld_e' && got.count === '1' && got.savedVisited === true,
        JSON.stringify({ badges: got.visitedBadges, title: got.visitTitle, hide: got.hideVisited, count: got.count, saved: got.savedVisited }));
    check('Explore personal: right-clicking an Explore card adds Like, Dislike and the hide items under the world items',
        ['Open Details', 'Like', 'Dislike (hide)', 'Hide this world', 'Hide all worlds by Yui', 'Hide a tag'].every(x => got.menu.includes(x)), JSON.stringify(got.menu));
    check('Explore personal: hiding an author, a dislike, a tag and a world take worlds out; a like wins over a hidden tag',
        got.afterAuthor === 'wrld_a,wrld_b,wrld_e' && /hide list hides 2/.test(got.note) && got.afterDislike === 'wrld_a,wrld_b' && got.likedMenuChecked
            && got.afterTag === 'wrld_a' && got.afterWorld === 'wrld_a',
        JSON.stringify({ author: got.afterAuthor, note: got.note, dislike: got.afterDislike, checked: got.likedMenuChecked, tag: got.afterTag, world: got.afterWorld }));
    check('Explore personal: "Show hidden worlds" brings them back marked, and the Filters panel lists and unhides',
        got.shown === 'wrld_a,wrld_b,wrld_c,wrld_d,wrld_e' && got.marked === 4 && got.listMarked === 4 && got.dislikeBadge && got.likedBadge
            && /1 worlds, 1 authors, 0 tags\. Disliked: 1/.test(got.panelSum) && got.panelChips.join() === 'author:usr_y' && got.panelBoxes.join() === 'true,true'
            && got.panelAfter === 0 && got.afterUnhide === 'wrld_a,wrld_c,wrld_d',
        JSON.stringify({ shown: got.shown, marked: got.marked, listMarked: got.listMarked, dis: got.dislikeBadge, liked: got.likedBadge, sum: got.panelSum, chips: got.panelChips, boxes: got.panelBoxes, after: got.panelAfter, unhide: got.afterUnhide }));
    check('Explore personal: the Liked view lists liked worlds, search narrows it, unliking empties it, and nothing goes to VRChat',
        got.liked === 'wrld_a' && got.likedCard && got.likedSearch === 'liked/' && got.likedEmpty && got.sentAfter.length === 0,
        JSON.stringify({ liked: got.liked, card: got.likedCard, search: got.likedSearch, empty: got.likedEmpty, sent: got.sentAfter }));
    check('Explore personal: the lists are kept in localStorage and bad entries are dropped when read back',
        got.stored === 'wrld_e|wrld_b||' && got.reload === 'wrld_ok|author_tag_ok|false', JSON.stringify({ stored: got.stored, reload: got.reload }));
});

section('explore active', async main => {
    // Item 14 step 4. Cards say which friends are in the world now (from the friends list, no request); the loaded worlds
    // can be ordered by people there now or friends first, and narrowed to worlds where friends are.
    const got = await main.json(`(() => {
        const sent = [];
        const realSend = sendToCS;
        window.sendToCS = m => { sent.push(m); };
        const ids = () => _explore.shown.map(w => w.id).join(',');
        const real = { friends: vrcFriendsData, order: localStorage.getItem('vrcn_exploreOrder') };
        const out = {};
        try {
            exploreClearFilters();
            exploreSetOrder('default');
            vrcFriendsData = [{ id: 'usr_1', displayName: 'Ann', location: 'wrld_b:123~region(eu)' }, { id: 'usr_2', displayName: 'Bob', location: 'wrld_b:999' },
                { id: 'usr_3', displayName: 'Cy', location: 'wrld_c:1' }, { id: 'usr_4', displayName: 'Dee', location: 'private' }, { id: 'usr_5', displayName: 'Eve', location: 'offline' }];
            _explore.entries = {}; _explore.view = 'active'; _explore.query = ''; _explore.askedVisited = true;
            document.getElementById('searchWorldsInput').value = '';
            showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
            setWorldFilter('explore');
            setExploreView('popular');
            const ask = sent.find(m => m.action === 'vrcExploreWorlds');
            const W = (id, occupants) => ({ id, name: 'World ' + id.slice(5), authorId: 'usr_x', authorName: 'Xan', tags: [], capacity: 16, occupants, favorites: 1 });
            _handleBackendMessage('vrcExploreResults', { view: 'popular', query: '', offset: 0, ok: true, hasMore: false, sig: ask?.sig,
                worlds: [W('wrld_a', 5), W('wrld_b', 2), W('wrld_c', 9), W('wrld_d', 0)] });
            const before = sent.length;
            const card = id => [...document.querySelectorAll('#searchWorldsResults .vrcn-content-card')].find(c => (c.getAttribute('onclick') || '').includes(id));
            out.badges = ['wrld_a', 'wrld_b', 'wrld_c'].map(id => card(id)?.querySelector('.explore-badge.friends')?.lastChild?.textContent.trim() || '');
            out.title = card('wrld_b')?.querySelector('.explore-badge.friends')?.title || '';
            exploreSetOrder('people'); out.people = ids();
            exploreSetOrder('friends'); out.friends = ids();
            out.savedOrder = localStorage.getItem('vrcn_exploreOrder');
            exploreSetOrder('default'); out.plain = ids();
            exploreSetFilter('friendsOnly', true);
            out.only = ids();
            out.count = document.querySelector('#exploreFilterBtn .explore-filter-count')?.textContent;
            out.saved = JSON.parse(localStorage.getItem('vrcn_exploreFilters') || '{}').friendsOnly;
            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            const panel = document.getElementById('exploreFilterPanel');
            out.panel = [!!panel.querySelector('#exploreFriendsOnly:checked'), panel.querySelector('#exploreOrder')?.options.length || 0];
            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            out.sent = sent.slice(before).map(m => m.action);
            return out;
        } finally {
            window.sendToCS = realSend;
            exploreClearFilters();
            vrcFriendsData = real.friends;
            if (real.order == null) localStorage.removeItem('vrcn_exploreOrder'); else localStorage.setItem('vrcn_exploreOrder', real.order);
            _exploreOrder = 'default';
            _explore.entries = {}; _explore.view = 'active'; _explore.query = '';
            setWorldFilter('favorites');
        }
    })()`);
    check('Explore active: cards count the friends in each world now, names in the tooltip',
        got.badges.join() === ',2,1' && got.title === 'Friends here now: Ann, Bob', JSON.stringify({ badges: got.badges, title: got.title }));
    check('Explore active: order by people now or friends first, saved; VRChat order back',
        got.people === 'wrld_c,wrld_a,wrld_b,wrld_d' && got.friends === 'wrld_b,wrld_c,wrld_a,wrld_d' && got.savedOrder === 'friends' && got.plain === 'wrld_a,wrld_b,wrld_c,wrld_d',
        JSON.stringify({ people: got.people, friends: got.friends, saved: got.savedOrder, plain: got.plain }));
    check('Explore active: "only worlds where friends are" filters, counts, is saved, sits in the panel, and sends nothing',
        got.only === 'wrld_b,wrld_c' && got.count === '1' && got.saved === true && got.panel.join() === 'true,3' && got.sent.length === 0,
        JSON.stringify({ only: got.only, count: got.count, saved: got.saved, panel: got.panel, sent: got.sent }));
});

section('explore rows saved', async main => {
    // Item 14 step 5. VRChat's own rows (asked for once, when the menu first opens), saved searches (view, text and
    // filters under a name) and the view Explore opens on. Saved searches stay in localStorage.
    const got = await main.json(`(() => {
        const sent = [];
        const realSend = sendToCS;
        window.sendToCS = m => { sent.push(m); };
        const ids = () => _explore.shown.map(w => w.id).join(',');
        const real = { saved: localStorage.getItem('vrcn_exploreSaved'), rows: { ..._exploreRowsState }, started: _explore.started };
        const out = {};
        try {
            exploreClearFilters();
            Object.assign(_exploreRowsState, { list: null, loading: false, failed: false });
            _explore.entries = {}; _explore.view = 'active'; _explore.query = ''; _explore.askedVisited = true;
            document.getElementById('searchWorldsInput').value = '';
            showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
            setWorldFilter('explore');
            const rowsBtn = document.getElementById('exploreRowsBtn');
            exploreToggleRows(rowsBtn);
            const panel = document.getElementById('exploreRowsPanel');
            out.ask = sent.filter(m => m.action === 'vrcExploreRows').length;
            out.loading = /Asking VRChat/.test(panel.textContent);
            _handleBackendMessage('vrcExploreRows', { ok: true, rows: [{ id: 'row:0', name: 'Spotlight', tag: 'admin_spotlight' }, { id: 'row:4', name: 'Games', tag: '' }, { id: 'bad', name: 'x' }] });
            out.items = [...panel.querySelectorAll('.explore-row-item')].map(b => b.textContent.trim() + '=' + b.dataset.view);
            exploreToggleRows(rowsBtn); exploreToggleRows(rowsBtn);
            out.askAgain = sent.filter(m => m.action === 'vrcExploreRows').length;
            panel.querySelector('[data-view="row:0"]').click();
            out.panelClosed = panel.style.display === 'none';
            const ask = sent.filter(m => m.action === 'vrcExploreWorlds').pop();
            out.rowAsk = ask ? ask.view : '';
            out.rowActive = rowsBtn.classList.contains('active');
            out.note = document.getElementById('exploreNote').textContent;
            // A row's own tag is checked again when chips widen the "any of" list.
            exploreCycleTag('author_tag_chill');
            const ask2 = sent.filter(m => m.action === 'vrcExploreWorlds').pop();
            _handleBackendMessage('vrcExploreResults', { view: 'row:0', query: '', offset: 0, ok: true, hasMore: false, sig: ask2?.sig, worlds: [
                { id: 'wrld_s', name: 'S', tags: ['admin_spotlight', 'author_tag_chill'], occupants: 1, favorites: 1 },
                { id: 'wrld_t', name: 'T', tags: ['author_tag_chill'], occupants: 1, favorites: 1 } ] });
            out.rowWorlds = ids();
            exploreClearFilters();

            // Saved searches.
            setExploreView('hot');
            document.getElementById('searchWorldsInput').value = 'cozy';
            exploreSetFilter('platform', 'quest');
            const savedBtn = document.getElementById('exploreSavedBtn');
            exploreToggleSaved(savedBtn);
            const sp = document.getElementById('exploreSavedPanel');
            out.savedEmpty = /Nothing saved yet/.test(sp.textContent);
            sp.querySelector('#exploreSavedName').value = 'Cozy Quest';
            exploreSaveCurrent();
            out.savedItems = [...sp.querySelectorAll('.explore-saved-name')].map(b => b.textContent.trim());
            const stored = JSON.parse(localStorage.getItem('vrcn_exploreSaved') || '{}');
            out.stored = (stored.list || []).map(x => [x.name, x.view, x.query, x.filters?.platform].join('/')).join();
            exploreClearFilters();
            document.getElementById('searchWorldsInput').value = '';
            setExploreView('active');
            sp.querySelector('.explore-saved-name').click();
            out.applied = [_explore.view, _explore.query, _exploreFilters.platform, document.getElementById('searchWorldsInput').value, sp.style.display].join('/');
            // Explore opens on the pinned saved search the next time it opens in a run.
            exploreToggleSaved(savedBtn);
            sp.querySelector('.explore-saved-pin').click();
            out.pinned = JSON.parse(localStorage.getItem('vrcn_exploreSaved')).start + '|' + sp.querySelector('#exploreStartSel').value;
            exploreToggleSaved(savedBtn);
            exploreClearFilters();
            document.getElementById('searchWorldsInput').value = '';
            _explore.view = 'active'; _explore.query = ''; _explore.started = false;
            setWorldFilter('favorites'); setWorldFilter('explore');
            out.started = [_explore.view, _explore.query, _exploreFilters.platform].join('/');
            exploreSetStart('trending');
            _explore.started = false; setWorldFilter('favorites'); setWorldFilter('explore');
            out.startView = _explore.view;
            exploreDeleteSaved(0);
            out.afterDelete = _exploreSaved.list.length + '|' + _exploreSaved.start;
            exploreSetStart('saved:nope');
            out.badStart = _exploreSaved.start;
            localStorage.setItem('vrcn_exploreSaved', JSON.stringify({ list: [{ name: 'Ok', view: 'new', query: 'x', filters: { platform: 'pc', age: 3 } }, { name: 'ok', view: 'hot' },
                { name: 'Bad view', view: 'evil' }, { name: '', view: 'hot' }, { name: 'Row', view: 'row:12' }], start: 'saved:Gone' }));
            const re = _exploreLoadSaved();
            out.reload = re.list.map(x => x.name + ':' + x.view + ':' + x.filters.platform + ':' + x.filters.age).join() + '|' + re.start;
            return out;
        } finally {
            window.sendToCS = realSend;
            exploreClearFilters();
            _exploreClosePanel('exploreRowsPanel'); _exploreClosePanel('exploreSavedPanel');
            if (real.saved == null) localStorage.removeItem('vrcn_exploreSaved'); else localStorage.setItem('vrcn_exploreSaved', real.saved);
            Object.assign(_exploreSaved, _exploreLoadSaved());
            Object.assign(_exploreRowsState, real.rows);
            _explore.started = real.started;
            _explore.entries = {}; _explore.view = 'active'; _explore.query = '';
            document.getElementById('searchWorldsInput').value = '';
            setWorldFilter('favorites');
        }
    })()`);
    check('Explore rows: the menu asks VRChat once, lists its rows, and a row opens as a view',
        got.ask === 1 && got.loading && got.items.join() === 'Spotlight=row:0,Games=row:4' && got.askAgain === 1 && got.panelClosed
            && got.rowAsk === 'row:0' && got.rowActive && /VRChat row: Spotlight/.test(got.note),
        JSON.stringify({ ask: got.ask, loading: got.loading, items: got.items, again: got.askAgain, closed: got.panelClosed, view: got.rowAsk, active: got.rowActive, note: got.note }));
    check('Explore rows: a row keeps only worlds with its own tag when tag chips widen the request', got.rowWorlds === 'wrld_s', got.rowWorlds);
    check('Explore saved: saving keeps view, text and filters; clicking one puts them back',
        got.savedEmpty && got.savedItems.join() === 'Cozy Quest' && got.stored === 'Cozy Quest/hot/cozy/quest' && got.applied === 'hot/cozy/quest/cozy/none',
        JSON.stringify({ empty: got.savedEmpty, items: got.savedItems, stored: got.stored, applied: got.applied }));
    check('Explore saved: Explore opens on the pinned search or view; deleting it falls back to Active now',
        got.pinned === 'saved:Cozy Quest|saved:Cozy Quest' && got.started === 'hot/cozy/quest' && got.startView === 'trending' && got.afterDelete === '0|trending' && got.badStart === 'active',
        JSON.stringify({ pinned: got.pinned, started: got.started, startView: got.startView, del: got.afterDelete, bad: got.badStart }));
    check('Explore saved: bad saved searches are dropped when read back',
        got.reload === 'Ok:new:pc:0,Row:row:12:any:0|active', got.reload);
});

section('explore ai', async main => {
    // Item 14 step 6. "Maybe AI" is a local guess from tags and text ("no AI" counts against); the user's own marks
    // (a world or an author) sit with the hide list. The filter shows all, hides guesses and marks, or only marks.
    const got = await main.json(`(() => {
        const sent = [];
        const realSend = sendToCS;
        window.sendToCS = m => { sent.push(m); };
        const ids = () => _explore.shown.map(w => w.id).join(',');
        const real = { store: localStorage.getItem('vrcn_explorePersonal') };
        const out = {};
        try {
            exploreClearFilters();
            Object.assign(_explorePersonal, { liked: {}, disliked: {}, worlds: {}, authors: {}, tags: [], showHidden: false, ai: {}, aiAuthors: {} });
            _exploreSavePersonal();
            _explore.entries = {}; _explore.view = 'active'; _explore.query = ''; _explore.askedVisited = true;
            document.getElementById('searchWorldsInput').value = '';
            showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
            setWorldFilter('explore');
            setExploreView('popular');
            const ask = sent.find(m => m.action === 'vrcExploreWorlds');
            const W = (id, extra) => ({ id, name: 'World ' + id.slice(5), authorId: 'usr_x', authorName: 'Xan', tags: [], capacity: 16, occupants: 1, favorites: 1, ...extra });
            _handleBackendMessage('vrcExploreResults', { view: 'popular', query: '', offset: 0, ok: true, hasMore: false, sig: ask?.sig, worlds: [
                W('wrld_a', { description: 'Skybox made with Midjourney.' }), W('wrld_b', { tags: ['author_tag_AI'] }),
                W('wrld_c', { description: 'Handmade, no AI generated art here.' }), W('wrld_d', { name: 'Aiko house' }),
                W('wrld_e', { authorId: 'usr_z', authorName: 'Zed' }) ] });
            const before = sent.length;
            const card = id => [...document.querySelectorAll('#searchWorldsResults .vrcn-content-card')].find(c => (c.getAttribute('onclick') || '').includes(id));
            out.maybe = ['wrld_a', 'wrld_b', 'wrld_c', 'wrld_d', 'wrld_e'].map(id => card(id)?.querySelector('.explore-badge.ai.maybe') ? 1 : 0).join('');
            out.tip = card('wrld_a')?.querySelector('.explore-badge.ai')?.title || '';
            exploreSetFilter('ai', 'hide');
            out.hide = ids();
            out.count = document.querySelector('#exploreFilterBtn .explore-filter-count')?.textContent;
            const menuFor = id => {
                card(id)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
                return document.getElementById('vn-ctx-menu');
            };
            const labels = menu => [...menu.querySelectorAll('.vn-ctx-item .vn-ctx-label')].map(x => x.textContent.trim());
            const pick = (menu, text) => [...menu.querySelectorAll('.vn-ctx-item')].find(b => b.querySelector('.vn-ctx-label')?.textContent.trim() === text)?.click();
            const menu = menuFor('wrld_d');
            out.menu = labels(menu);
            pick(menu, 'Mark as AI');
            out.afterMark = ids();
            exploreSetFilter('ai', 'marks');
            out.marks = ids();
            pick(menuFor('wrld_e'), 'Mark all worlds by Zed as AI');
            out.afterAuthor = ids();
            exploreSetFilter('ai', 'all');
            out.all = ids();
            out.markBadge = !!card('wrld_d')?.querySelector('.explore-badge.ai:not(.maybe)') && !!card('wrld_e')?.querySelector('.explore-badge.ai:not(.maybe)');
            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            const panel = document.getElementById('exploreFilterPanel');
            out.panel = [panel.querySelector('#exploreAiSel')?.options.length || 0, /1 worlds, 1 authors/.test(panel.textContent)].join();
            panel.querySelector('.explore-chip[data-kind="aiauthor"]')?.click();
            out.unmarked = Object.keys(_explorePersonal.aiAuthors).length;
            exploreToggleFilters(document.getElementById('exploreFilterBtn'));
            const stored = JSON.parse(localStorage.getItem('vrcn_explorePersonal') || '{}');
            out.stored = Object.keys(stored.ai || {}).join() + '|' + Object.keys(stored.aiAuthors || {}).join();
            out.sent = sent.slice(before).map(m => m.action);
            return out;
        } finally {
            window.sendToCS = realSend;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            exploreClearFilters();
            if (real.store == null) localStorage.removeItem('vrcn_explorePersonal'); else localStorage.setItem('vrcn_explorePersonal', real.store);
            Object.assign(_explorePersonal, _exploreLoadPersonal());
            _explore.entries = {}; _explore.view = 'active'; _explore.query = '';
            setWorldFilter('favorites');
        }
    })()`);
    check('Explore AI: "Maybe AI" comes from tags or words in the text, "no AI" counts against, names like Aiko do not',
        got.maybe === '11000' && /Not a fact/.test(got.tip), JSON.stringify({ maybe: got.maybe, tip: got.tip }));
    check('Explore AI: right-click marks a world or an author; the filter hides guesses and marks, or only marks',
        got.hide === 'wrld_c,wrld_d,wrld_e' && got.count === '1' && got.menu.includes('Mark as AI') && got.menu.includes('Mark all worlds by Xan as AI')
            && got.afterMark === 'wrld_c,wrld_e' && got.marks === 'wrld_a,wrld_b,wrld_c,wrld_e' && got.afterAuthor === 'wrld_a,wrld_b,wrld_c',
        JSON.stringify({ hide: got.hide, count: got.count, menu: got.menu, mark: got.afterMark, marks: got.marks, author: got.afterAuthor }));
    check('Explore AI: marked cards say AI, the panel counts marks and unmarks an author, kept locally and nothing sent',
        got.all === 'wrld_a,wrld_b,wrld_c,wrld_d,wrld_e' && got.markBadge && got.panel === '3,true' && got.unmarked === 0 && got.stored === 'wrld_d|' && got.sent.length === 0,
        JSON.stringify({ all: got.all, badge: got.markBadge, panel: got.panel, unmarked: got.unmarked, stored: got.stored, sent: got.sent }));
});

section('explore for you', async main => {
    // Item 14 step 7. For You: a tag profile from visits (time and recency), favorites and likes; dislikes and hidden
    // tags count against. One request per top tag, scored and mixed here; visited worlds out unless switched on;
    // Trending when the history is too thin; waits for the visit history; kept 30 minutes.
    const got = await main.json(`(() => {
        const sent = [];
        const realSend = sendToCS;
        window.sendToCS = m => { sent.push(m); };
        const ids = () => _explore.shown.map(w => w.id).join(',');
        const real = { visited: _visitedWorldsData, loaded: _visitedWorldsLoaded, asked: _explore.askedVisited, fav: favWorldsData, store: localStorage.getItem('vrcn_explorePersonal') };
        const out = {};
        const day = 86400000, now = Date.now();
        const iso = d => new Date(now - d * day).toISOString();
        const V = (id, tags, secs, ago) => ({ id, name: id, tags, worldTimeSeconds: secs, worldLastVisited: iso(ago) });
        const visits = [V('wrld_v1', ['author_tag_chill', 'author_tag_photo'], 7200, 1), V('wrld_v2', ['author_tag_chill'], 3600, 2),
            V('wrld_v3', ['author_tag_chill', 'author_tag_dance'], 600, 5), V('wrld_v4', ['author_tag_photo'], 1800, 3),
            V('wrld_v5', ['author_tag_horror'], 60, 400), V('wrld_v6', ['author_tag_chill'], 100, 10)];
        try {
            exploreClearFilters();
            Object.assign(_explorePersonal, { liked: {}, disliked: { wrld_zz: { tags: ['author_tag_horror'], at: 1 } }, worlds: {}, authors: {},
                tags: ['author_tag_dance'], showHidden: false, ai: {}, aiAuthors: {}, feedVisited: false });
            _exploreSavePersonal();
            favWorldsData = [];
            _visitedWorldsData = visits; _visitedWorldsLoaded = true; _explore.askedVisited = true;
            _explore.entries = {}; _explore.view = 'active'; _explore.query = '';
            document.getElementById('searchWorldsInput').value = '';
            showTab(NAV_ITEMS_DEF.worlds?.tab ?? 1);
            setWorldFilter('explore');
            setExploreView('foryou');
            const ask = sent.filter(m => m.action === 'vrcExploreForYou').pop();
            out.ask = ask ? ask.profileTags.join() : 'none';
            out.btn = document.getElementById('exploreView_foryou').classList.contains('active');
            const W = (id, authorId, tags, ago, favorites = 1) => ({ id, name: 'W ' + id.slice(5), authorId, authorName: authorId, tags, occupants: 1, favorites,
                publicationDate: ago == null ? '' : iso(ago) });
            _handleBackendMessage('vrcExploreForYou', { key: 'stale', sig: ask?.sig, ok: true, fallback: false, results: [{ tag: 'x', worlds: [W('wrld_old', 'usr_o', [], 1)] }] });
            out.staleIgnored = _explore.shown.length === 0;
            _handleBackendMessage('vrcExploreForYou', { key: ask?.key, sig: ask?.sig, ok: true, fallback: false, results: [
                { tag: 'author_tag_chill', worlds: [W('wrld_f1', 'usr_a', ['author_tag_chill', 'author_tag_photo'], 10, 100), W('wrld_f2', 'usr_a', ['author_tag_chill'], 1000, 5000),
                    W('wrld_f3', 'usr_a', ['author_tag_chill'], 100, 10), W('wrld_v2', 'usr_b', ['author_tag_chill'], 20),
                    W('wrld_f5', 'usr_c', ['author_tag_chill', 'author_tag_horror'], 5)] },
                { tag: 'author_tag_photo', worlds: [W('wrld_f6', 'usr_d', ['author_tag_photo'], 1), W('wrld_f1', 'usr_a', ['author_tag_chill', 'author_tag_photo'], 10, 100),
                    W('wrld_f7', 'usr_e', ['author_tag_photo'], null), W('wrld_f8', 'usr_f', ['author_tag_dance'], 2)] } ] });
            out.feed = ids();
            const card = id => [...document.querySelectorAll('#searchWorldsResults .vrcn-content-card')].find(c => (c.getAttribute('onclick') || '').includes(id));
            out.why1 = card('wrld_f1')?.querySelector('.explore-why')?.textContent.trim() || '';
            out.why6 = card('wrld_f6')?.querySelector('.explore-why')?.textContent.trim() || '';
            out.note = document.getElementById('exploreNote').textContent;
            exploreFeedVisited(true);
            out.withVisited = ids();
            exploreFeedVisited(false);
            setExploreView('hot'); setExploreView('foryou');
            out.asks = sent.filter(m => m.action === 'vrcExploreForYou').length;

            // Too little history: Trending, said so.
            _visitedWorldsData = visits.slice(0, 2);
            exploreRefresh();
            const ask2 = sent.filter(m => m.action === 'vrcExploreForYou').pop();
            out.ask2 = (ask2?.profileTags || ['?']).join() + '|' + ask2?.fresh;
            _handleBackendMessage('vrcExploreForYou', { key: ask2?.key, sig: ask2?.sig, ok: true, fallback: true, results: [{ tag: '', worlds: [W('wrld_t1', 'usr_t', [], 3), W('wrld_t2', 'usr_t', [], 4)] }] });
            out.fallback = ids() + '|' + /Trending/.test(document.getElementById('exploreNote').textContent) + '|' + document.querySelectorAll('#searchWorldsResults .explore-why').length;

            // It waits for the visit history before asking.
            _explore.entries = {}; _visitedWorldsLoaded = false;
            setExploreView('hot'); setExploreView('foryou');
            const before = sent.filter(m => m.action === 'vrcExploreForYou').length;
            renderVisitedWorlds(visits);
            out.waited = before + '>' + sent.filter(m => m.action === 'vrcExploreForYou').length;
            out.stored = JSON.parse(localStorage.getItem('vrcn_explorePersonal') || '{}').feedVisited;
            return out;
        } finally {
            window.sendToCS = realSend;
            exploreClearFilters();
            if (real.store == null) localStorage.removeItem('vrcn_explorePersonal'); else localStorage.setItem('vrcn_explorePersonal', real.store);
            Object.assign(_explorePersonal, _exploreLoadPersonal());
            _exploreLikedMemo = null;
            favWorldsData = real.fav;
            _visitedWorldsData = real.visited; _visitedWorldsLoaded = real.loaded; _explore.askedVisited = real.asked;
            _explore.entries = {}; _explore.view = 'active'; _explore.query = '';
            setWorldFilter('favorites');
        }
    })()`);
    check('Explore For You: asks about the top tags of visits, favorites and likes; dislikes and hidden tags stay out',
        got.ask === 'author_tag_chill,author_tag_photo' && got.btn && got.staleIgnored, JSON.stringify({ ask: got.ask, btn: got.btn, stale: got.staleIgnored }));
    check('Explore For You: scored and mixed (two per author, a new world every fifth card), visited and hidden out, each card says why',
        got.feed === 'wrld_f1,wrld_f3,wrld_f5,wrld_f6,wrld_f7' && /Because you like/.test(got.why1) && /,/.test(got.why1) && /Something new/.test(got.why6)
            && /Picked from the tags/.test(got.note),
        JSON.stringify({ feed: got.feed, why1: got.why1, why6: got.why6, note: got.note }));
    check('Explore For You: visited worlds can be switched on; going back within 30 minutes asks nothing',
        got.withVisited === 'wrld_f1,wrld_v2,wrld_f3,wrld_f5,wrld_f6,wrld_f7' && got.asks === 1 && got.stored === false,
        JSON.stringify({ visited: got.withVisited, asks: got.asks, stored: got.stored }));
    check('Explore For You: too little history shows Trending and says so; it waits for the visit history',
        got.ask2 === '|true' && got.fallback === 'wrld_t1,wrld_t2|true|0' && got.waited === '2>3',
        JSON.stringify({ ask2: got.ask2, fallback: got.fallback, waited: got.waited }));
});

section('avatar filters (issue 10)', async main => {
    const got = await main.json(`(() => {
        const mk = (id, extra) => ({ id, name: id, releaseStatus: 'public', authorName: 'Someone', tags: [], ...extra });
        const avs = [
            mk('a_good_pc', { performance: { standalonewindows: 'Good', android: 'VeryPoor' }, unityPackages: [{ platform: 'standalonewindows' }, { platform: 'android' }, { platform: 'android', variant: 'impostor' }], authorName: 'Haps', created_at: '2025-03-01T00:00:00Z', tags: ['author_tag_cat_ears'] }),
            mk('a_poor', { performance: { standalonewindows: 'Poor' }, unityPackages: [{ platform: 'standalonewindows' }], created_at: '2024-01-01T00:00:00Z' }),
            mk('a_unknown', {}),
        ];
        const pass = () => avs.filter(_avPassesFilters).map(a => a.id).join(',');
        const out = {};
        avClearMoreFilters();
        out.none = pass();
        avSetMoreFilter('perfMax', 'good'); out.goodAny = pass();
        avSetMoreFilter('perfPlat', 'quest'); out.goodQuest = pass();
        avClearMoreFilters();
        avSetMoreFilter('impostor', 'yes'); out.impostor = pass();
        avClearMoreFilters();
        avSetMoreFilter('author', 'haps'); out.author = pass();
        avClearMoreFilters();
        avSetMoreFilter('tag', 'cat ears'); out.tag = pass();
        avClearMoreFilters();
        avSetMoreFilter('createdFrom', '2025-01-01'); out.created = pass();
        out.count = document.querySelector('.av-more-btn .av-more-count')?.textContent;
        avClearMoreFilters();
        const btn = document.querySelector('.av-more-btn');
        if (btn) avToggleMoreFilters(btn);
        const panel = document.getElementById('avMoreFilters');
        out.panel = !!panel && panel.style.display === 'block' && panel.querySelectorAll('select').length >= 3 && panel.querySelectorAll('input[type=date]').length === 4;
        if (panel) panel.style.display = 'none';
        return out;
    })()`);
    check('with no extra filters every avatar passes', got.none === 'a_good_pc,a_poor,a_unknown', JSON.stringify(got));
    check('"Good or better" keeps rated avatars that qualify and unrated ones', got.goodAny === 'a_good_pc,a_unknown', got.goodAny);
    check('the rank can be checked per platform (Quest)', got.goodQuest === 'a_poor,a_unknown' || got.goodQuest === 'a_unknown', got.goodQuest);
    check('impostor, author, tag and date filters each narrow the list',
        got.impostor === 'a_good_pc,a_unknown' && got.author === 'a_good_pc' && got.tag === 'a_good_pc' && got.created === 'a_good_pc', JSON.stringify(got));
    check('the Filters button counts active filters and opens its panel', got.count === '1' && got.panel, JSON.stringify(got));
});

section('prints (issue 11)', async main => {
    // The page side: list, pick, confirm, then only the picked paths are sent. sendToCS is stubbed, so nothing moves.
    const got = await main.json(`(() => {
        const sentNow = [];
        const real = sendToCS;
        sendToCS = m => sentNow.push(m);
        try {
            showTab(7);
            document.getElementById('libPrintsBtn').click();
            const asked = sentNow.some(m => m.action === 'findVrcPrints');
            const searching = document.getElementById('libPrintsStatus').textContent;
            const goWhileSearching = document.getElementById('libPrintsGo').disabled;
            libPrintsFound({ prints: [
                { path: 'C:\\\\p\\\\VRChat_a_2048x1440.png', name: 'VRChat_a_2048x1440.png', url: 'about:blank' },
                { path: 'C:\\\\p\\\\VRChat_b_2048x1440.png', name: 'VRChat_b_2048x1440.png', url: 'about:blank' },
            ] });
            const cards = document.querySelectorAll('#libPrintsGrid .lib-print-card.picked').length;
            libPrintsToggle(1);
            const label = document.getElementById('libPrintsGo').textContent;
            document.getElementById('libPrintsGo').click();
            const confirmShown = !!document.getElementById('vnConfirmModal');
            const sentBeforeConfirm = sentNow.filter(m => m.action === 'recycleVrcPrints').length;
            document.getElementById('vnConfirmModalOk').click();
            const recycle = sentNow.find(m => m.action === 'recycleVrcPrints');
            libPrintsRecycled({ moved: recycle ? recycle.paths : [], failed: [] });
            const left = document.querySelectorAll('#libPrintsGrid .lib-print-card').length;
            const done = document.getElementById('libPrintsStatus').textContent;
            document.getElementById('libPrintsModal')?.remove();
            return { asked, searching, goWhileSearching, cards, label, confirmShown, sentBeforeConfirm, paths: recycle?.paths, left, done };
        } finally { sendToCS = real; }
    })()`);
    check('the print finder asks the app and waits', got.asked && got.searching.length > 0 && got.goWhileSearching, JSON.stringify(got));
    check('found prints all start picked; unpicking one updates the button', got.cards === 2 && /1/.test(got.label), got.label);
    check('nothing is sent until the confirm dialog is accepted', got.confirmShown && got.sentBeforeConfirm === 0, JSON.stringify(got));
    check('only the picked prints are sent, and moved ones leave the list', JSON.stringify(got.paths) === JSON.stringify(['C:\\p\\VRChat_a_2048x1440.png']) && got.left === 1 && /1/.test(got.done), JSON.stringify(got));
});

section('loading states', async main => {
    // A list says "nothing here" only once its load has answered; before that it shows a loading state.
    const got = await main.json(`(() => {
        const grid = () => document.getElementById('worldRecentGrid');
        _visitedWorldsLoaded = false; _visitedWorldsData = [];
        renderVisitedWorlds();
        const before = { loading: !!grid().querySelector('.loading-msg'), text: grid().textContent.trim() };
        renderVisitedWorlds([]);
        const after = { loading: !!grid().querySelector('.loading-msg'), text: grid().textContent.trim() };
        const savedUser = currentVrcUser; currentVrcUser = null;
        const signedOut = stillLoading(false);
        currentVrcUser = { id: 'usr_test' };
        const signedIn = stillLoading(false);
        currentVrcUser = savedUser;
        return { before, after, signedOut, signedIn };
    })()`);
    check('Recently visited shows loading before its answer', got.before.loading, JSON.stringify(got.before));
    check('Recently visited shows empty after an empty answer', !got.after.loading && got.after.text.length > 0, JSON.stringify(got.after));
    check('lists fed by VRChat do not wait while signed out', got.signedOut === false && got.signedIn === true, JSON.stringify(got));
});

section('settings', async main => {
    await main.eval(`showTab(9); switchSettingsSection('general')`);
    const nav = await main.json(`[...document.querySelectorAll('#tab9 .settings-nav-item')].map(b => b.dataset.sectionId || (b.getAttribute('onclick').match(/'([^']+)'/) || [])[1])`);
    check('A2: Friends and Attribution are no longer tabs of their own', !nav.includes('friends') && !nav.includes('attribution'), nav.join(','));
    check('B2: no Settings tab per plugin', !nav.some(n => String(n).startsWith('plugin-')), nav.join(','));
    check('A3: one VRCX tab', nav.filter(n => n === 'vrcx').length === 1, nav.join(','));
    await main.eval(`switchSettingsSection('about')`);
    check('A2: the licences are part of About', await main.eval(`!!document.getElementById('settingsAttributionCard')?.offsetParent`));
    await main.eval(`switchSettingsSection('attribution')`);
    check('A2: an old link to Attribution lands on About', await main.eval(`document.querySelector('#tab9 .settings-nav-item.active')?.getAttribute('onclick')?.includes("'about'")`));
    await main.eval(`switchSettingsSection('sidebar')`);
    check('A2: the People stats switch moved to Sidebar', await main.eval(`!!document.getElementById('setPeopleAlwaysStats')?.closest('.vrcn-panel-card')?.offsetParent`));

    // A4: the sidebar resizes and never scrolls sideways.
    const grip = await main.eval(`!!document.querySelector('#tab9 .settings-nav-resizer')`);
    check('A4: the Settings sidebar has a resize handle', grip);
    const sizes = await main.json(`(() => {
        const nav = document.querySelector('#tab9 .settings-nav');
        const out = [];
        for (const w of [100, 240, 500]) {
            document.documentElement.style.setProperty('--settings-nav-w', Math.max(160, Math.min(360, w)) + 'px');
            out.push({ w: Math.round(nav.getBoundingClientRect().width), sideways: nav.scrollWidth > nav.clientWidth + 1 });
        }
        document.documentElement.style.removeProperty('--settings-nav-w');
        return out;
    })()`);
    check('A4: the sidebar keeps between 160 and 360 px and never scrolls sideways', sizes.every(s => s.w >= 160 && s.w <= 361 && !s.sideways), JSON.stringify(sizes));

    // A6: "Start OyasumiVR", never "Oyasumi VR".
    await main.eval(`switchSettingsSection('vrchat'); renderKnownVrApps([{ id: 'oyasumi', name: 'OyasumiVR', path: null }, { id: 'vrct', name: 'VRCT', path: null }])`);
    const text = await main.eval(`document.getElementById('knownVrAppToggles').innerText`);
    check('A6: the VRChat tab reads "Start OyasumiVR"', /Start OyasumiVR/i.test(text) && !/Oyasumi\s+VR/i.test(text), text);
});

section('plugin options', async main => {
    await main.eval(`hubOpenPlugins()`);
    await waitFor('plugin rows', () => main.eval(`document.querySelectorAll('.hub-plugin-row').length > 20`), 5000);
    check('B1: plugins with options have a fold-open button', await main.eval(`!!document.querySelector('.hub-plugin-row[data-plugin="spacecal"] .hub-plugin-expand')`));
    // The ⋯ menu offers Options.
    await main.eval(`document.querySelector('.hub-plugin-row[data-plugin="spacecal"] .hub-plugin-more').click()`);
    const menu = await main.eval(`document.getElementById('hubPluginMenu')?.innerText || ''`);
    check('B2: the ⋯ menu has Options', /Options/.test(menu), menu);
    await main.eval(`[...document.querySelectorAll('#hubPluginMenu .tb-dd-item')].find(b => /Options/.test(b.innerText)).click()`);
    await waitFor('the options panel', () => main.eval(`!document.querySelector('.hub-plugin-opts[data-plugin-opts="spacecal"]').hidden`), 5000).catch(() => {});
    const panel = await main.json(`(() => { const p = document.querySelector('.hub-plugin-opts[data-plugin-opts="spacecal"]'); return { open: !p.hidden, rows: p.querySelectorAll('.hub-module-row').length, branch: !!p.querySelector('#hubSteamBranch') }; })()`);
    check('B2: Options folds open Space Calibrator\'s settings under it', panel.open && panel.rows > 0, JSON.stringify(panel));
    check('B3: Space Calibrator\'s Steam branch lives in its options, not in General', panel.branch, JSON.stringify(panel));
    await sleep(400);
    const selects = await main.json(`[...document.querySelectorAll('.hub-plugin-opts select')].map(s => !!s._vnSelect)`);
    check('A1: dropdowns in plugin options are themed', selects.length > 0 && selects.every(Boolean), JSON.stringify(selects));
    await main.eval(`hubPluginToggleOptions('spacecal', false)`);
    check('B1: it folds closed again', await main.eval(`document.querySelector('.hub-plugin-opts[data-plugin-opts="spacecal"]').hidden`));
    // VRCX's plugin points at its tab instead of a second VRCX page.
    await main.eval(`document.querySelector('.hub-plugin-row[data-plugin="vrcx"] .hub-plugin-more').click()`);
    const vrcxMenu = await main.eval(`document.getElementById('hubPluginMenu')?.innerText || ''`);
    await main.eval(`[...document.querySelectorAll('#hubPluginMenu .tb-dd-item')].find(b => /settings/i.test(b.innerText))?.click()`);
    check('A3: VRCX\'s ⋯ menu opens the VRCX tab', /settings/i.test(vrcxMenu) && await main.eval(`document.querySelector('#tab9 .settings-nav-item.active')?.getAttribute('onclick')?.includes("'vrcx'")`), vrcxMenu);
    // A checkbox drawn by HapsHub isn't a white Windows box.
    const box = await main.eval(`getComputedStyle(document.getElementById('hubTidyAll')).appearance`);
    check('A1: "Show all details" is a themed checkbox', box === 'none', box);
});

section('rose', async main => {
    // Rose Database is a plugin: off hides its Avatars filter and moves off it; on brings it back.
    await main.eval(`showTab(NAV_ITEMS_DEF.avatars.tab); setAvatarFilter('rose')`);
    await sleep(300);
    await main.eval(`hubPluginSet('rose-db', false)`);
    await sleep(300);
    const off = await main.json(`({ shown: getComputedStyle(document.getElementById('avatarFilterRose')).display !== 'none', area: getComputedStyle(document.getElementById('avatarRoseArea')).display !== 'none', filter: avatarFilter })`);
    check('B4: with Rose Database off, its Avatars filter is hidden and the page moves to your avatars', !off.shown && !off.area && off.filter === 'own', JSON.stringify(off));
    await main.eval(`setAvatarFilter('rose')`);
    check('B4: with it off, the Rose filter can\'t be picked', await main.eval(`avatarFilter === 'own'`));
    await main.eval(`hubPluginSet('rose-db', true)`);
    await sleep(300);
    check('B4: turned back on, the filter is back', await main.eval(`getComputedStyle(document.getElementById('avatarFilterRose')).display !== 'none'`));
    check('B4: Rose Database is listed in Plugins', await main.eval(`hubPluginsRender(), !!hubPluginById('rose-db')`));
    await main.eval(`showTab(0)`);
});

section('launch switches', async main => {
    await main.eval(`showTab(9); switchSettingsSection('vrchat')`);
    const builtins = await main.json(`launchSwitches().map(s => s.id)`);
    check('A7: the three built-in switches are listed', ['haptics', 'faceTracking', 'fbt'].every(id => builtins.includes(id)), builtins.join(','));
    // Add one, name it, give it an app that exists, and rename a built-in one.
    await main.eval(`launchSwitchAdd()`);
    await sleep(200);
    const renaming = await main.eval(`!!document.querySelector('.launch-sw-rename')`);
    check('A7: a new switch opens with its name ready to type', renaming);
    await main.eval(`(() => { const i = document.querySelector('.launch-sw-rename'); i.value = 'With lights'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    const id = await main.eval(`launchSwitches().find(s => s.label === 'With lights')?.id || ''`);
    check('A7: the new switch has the name typed', !!id);
    await main.eval(`addLaunchAddonApp(${JSON.stringify(id)}, ${JSON.stringify(process.execPath)})`);
    await main.eval(`launchSwitchRename('fbt')`);
    await main.eval(`(() => { const i = document.querySelector('.launch-sw-rename'); i.value = 'With trackers'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await waitFor('the switches saved', () => {
        const s = savedSettings(main.dataDir);
        return (s.LaunchCustomSwitches || []).some(x => x.Name === 'With lights' && (x.Apps || []).length === 1) && s.LaunchSwitchNames?.fbt === 'With trackers';
    }, 10000).then(() => check('A7: the new switch, its app and the new name are saved', true))
        .catch(() => check('A7: the new switch, its app and the new name are saved', false, JSON.stringify({ c: savedSettings(main.dataDir).LaunchCustomSwitches, n: savedSettings(main.dataDir).LaunchSwitchNames })));
    // The Launch window shows them.
    const buttons = await main.eval(`_launchAddonButtons()`);
    check('A7: the Launch window shows the new switch and the new name', buttons.includes('With lights') && buttons.includes('With trackers'));
    main.switchId = id;
});

section('dashboard', async main => {
    await main.eval(`showTab(0)`);
    const first = await waitFor('a random picture', () => main.eval(`dashBgPath || ''`), 15000).catch(() => '');
    check('D1: a random picture is shown at start', /(red|green|blue)\.png$/.test(first) && !/_thumbnail/.test(first), first);
    const where = await main.json(`(() => { const b = document.getElementById('dashShuffleBtn').getBoundingClientRect(), nav = document.getElementById('sidebarEl')?.getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, vw: innerWidth, vh: innerHeight, navRight: nav ? nav.right : 0 }; })()`);
    check('D2: the shuffle button sits at the top-left of the picture', where.w > 0 && where.left >= where.navRight && where.left < where.vw / 3 && where.top < where.vh / 3, JSON.stringify(where));
    let previous = first, ok = true, seen = [];
    for (let i = 0; i < 5; i++) {
        await main.eval(`document.getElementById('dashShuffleBtn').click()`);
        const next = await waitFor('another picture', async () => { const p = await main.eval(`dashBgPath || ''`); return p !== previous ? p : null; }, 8000).catch(() => previous);
        seen.push(next.split(/[\/]/).pop());
        if (next === previous || /_thumbnail/.test(next)) ok = false;
        previous = next;
    }
    check('D2: each click shows a different picture, never an Eagle preview', ok, seen.join(','));
});

section('from vrcx', async main => {
    // VRCX de1633f and e819c4e: both off to start with, each under its own settings card, and not listed twice.
    await main.eval(`showTab(9); hubModulesRefresh()`);
    await waitFor('the From VRCX switches', () => main.eval(`!!document.querySelector('#hubRecentInvitesSlot input[data-module="hub.vrcx-extras"]')`), 15000).catch(() => {});
    const rows = await main.json(`(() => {
        const alarm = document.querySelector('#hubQueueAlarmSlot input[data-module="hub.vrcx-extras"][data-key="queue_alarm"]');
        const clock = document.querySelector('#hubRecentInvitesSlot input[data-module="hub.vrcx-extras"][data-key="recent_invites"]');
        return { alarm: !!alarm, alarmOn: !!alarm?.checked, clock: !!clock, clockOn: !!clock?.checked, twice: !!document.querySelector('#hubModulesList [data-module="hub.vrcx-extras"]') };
    })()`);
    check('VRCX: the queue alarm (Sounds) and the invite clock (Sidebar) switches are there, off, and not in the module list too',
        rows.alarm && rows.clock && !rows.alarmOn && !rows.clockOn && !rows.twice, JSON.stringify(rows));

    // The hub's message as it arrives when VRChat says a queued place is ready.
    const ready = await main.json(`(() => {
        worldInfoCache['wrld_queuetest'] = { id: 'wrld_queuetest', name: 'Queue Test World' };
        _handleBackendMessage('hubQueueReady', { location: 'wrld_queuetest:123~group(grp_x)', alarm: true });
        const loud = window._hubLastQueueReady;
        _handleBackendMessage('hubQueueReady', { location: 'wrld_unknown:1', alarm: false });
        return { loud, quiet: window._hubLastQueueReady, toast: document.body.innerText.includes('Queue Test World') };
    })()`);
    check('VRCX queue alarm: a ready queue names the world and chimes only with the alarm on',
        ready.loud?.world === 'Queue Test World' && ready.loud?.chimed === true && ready.quiet?.chimed === false && ready.toast, JSON.stringify(ready));

    // Turning the clock on goes through the hub and back.
    await main.eval(`(() => { const i = document.querySelector('#hubRecentInvitesSlot input[data-key="recent_invites"]'); i.checked = true; i.dispatchEvent(new Event('change')); })()`);
    const on = await waitFor('the clock setting', () => main.eval(`window._hubRecentInvitesOn === true`), 10000).then(() => true, () => false);
    check('VRCX invite clock: the switch turns it on', on);
    const clock = await main.json(`(() => {
        hubNoteInvite({ action: 'vrcRequestInvite', userId: 'usr_clock' });
        hubNoteInvite({ action: 'vrcBatchInvite', userIds: ['usr_batch'] });
        hubNoteInvite({ action: 'vrcGetInviteMessages', userId: 'usr_not' });
        const card = id => buildFriendCardHtml({ id, displayName: id, status: 'active', location: 'private' }, 'game').includes('hub-recent-invite');
        const out = { asked: card('usr_clock'), batch: card('usr_batch'), other: card('usr_not') };
        window._hubRecentInvitesOn = false;
        out.off = card('usr_clock');
        window._hubRecentInvitesOn = true;
        return out;
    })()`);
    check('VRCX invite clock: invited and asked friends get the clock, others and the switched-off list do not',
        clock.asked && clock.batch && !clock.other && !clock.off, JSON.stringify(clock));
    await main.eval(`(() => { const i = document.querySelector('#hubRecentInvitesSlot input[data-key="recent_invites"]'); i.checked = false; i.dispatchEvent(new Event('change')); })()`);
});

section('help', async main => {
    const read = () => main.json(`(() => {
        const out = {};
        const tabs = [...new Set(Object.values(NAV_ITEMS_DEF).map(d => d.tab))];
        for (const tab of tabs) {
            showTab(tab);
            toggleHelpPanel();
            out[tab] = document.getElementById('helpPanelText').textContent.trim();
            toggleHelpPanel();
        }
        return out;
    })()`);
    const en = await read();
    const short = Object.entries(en).filter(([, text]) => text.length < 20).map(([tab]) => tab);
    check('H1: every page in the sidebar has an info box', short.length === 0, 'empty: ' + short.join(','));
    await main.eval(`typeof setLanguage === 'function' ? setLanguage('ja') : requestTranslation('ja')`);
    await sleep(2000);
    const ja = await read();
    const same = [30, 31, 37, 39].filter(tab => !ja[tab] || ja[tab] === en[tab]);
    check('H1: the new info boxes are translated', same.length === 0, 'not translated: ' + same.join(','));
    await main.eval(`typeof setLanguage === 'function' ? setLanguage('en') : requestTranslation('en')`);
    await sleep(1500);
    await main.eval(`showTab(0)`);
});

section('profile', async main => {
    // A signed-in user without VRC+ first, then with it. Nothing is sent to VRChat: the picker is checked, not used.
    await main.eval(`currentVrcUser = { id: 'usr_me', displayName: 'Me', tags: ['system_trust_known'], status: 'active', bio: 'hi', bioLinks: [], pronouns: '' }`);
    await main.eval(`openFriendDetail('usr_me')`);
    await sleep(500);
    const opened = await main.json(`({ mine: getComputedStyle(document.getElementById('modalMyProfile')).display !== 'none', other: getComputedStyle(document.getElementById('modalFriendDetail')).display !== 'none' })`);
    check('D3: clicking yourself opens your own, editable profile', opened.mine && !opened.other, JSON.stringify(opened));
    const buttons = await main.json(`({ banner: !!document.querySelector('#modalMyProfile .myp-banner-change'), picture: !!document.querySelector('#modalMyProfile .myp-avatar-change'),
        edits: [...document.querySelectorAll('#modalMyProfile [onclick^="editMyField"]')].map(b => b.getAttribute('onclick').match(/'([a-z]+)'/)[1]) })`);
    check('D3: your profile has buttons to change the banner and the picture', buttons.banner && buttons.picture, JSON.stringify(buttons));
    // Both buttons must be the topmost element at their centre, so nothing else in the profile covers them.
    const hits = await main.json(`['.myp-banner-change', '.myp-avatar-change'].map(sel => { const b = document.querySelector('#modalMyProfile ' + sel); const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { sel, clickable: !!top && (top === b || b.contains(top)), on: top ? (top.className || top.tagName) + '' : null }; })`);
    check('D3: the banner and picture buttons are not covered by anything', hits.every(h => h.clickable), JSON.stringify(hits));
    check('D3: bio, pronouns, links and languages can be edited', ['bio', 'pronouns', 'links', 'languages'].every(f => buttons.edits.includes(f)), buttons.edits.join(','));
    await main.eval(`document.querySelector('#modalMyProfile .myp-avatar-change').click()`);
    await sleep(300);
    const without = await main.json(`({ picker: getComputedStyle(document.getElementById('imagePickerOverlay') || document.body).display !== 'none' && !!document.getElementById('imagePickerOverlay'), tip: document.querySelector('#modalMyProfile .myp-avatar-change').title })`);
    check('D3: without VRC+ it explains instead of opening an empty picker', !without.picker && /VRC\+/.test(without.tip), JSON.stringify(without));
    await main.eval(`currentVrcUser.tags.push('system_supporter'); renderMyProfileContent(); document.querySelector('#modalMyProfile .myp-avatar-change').click()`);
    await sleep(400);
    const withPlus = await main.eval(`!!document.getElementById('imagePickerOverlay') && getComputedStyle(document.getElementById('imagePickerOverlay')).display !== 'none'`);
    check('D3: with VRC+ the picture button opens the picker', withPlus);
    await main.eval(`typeof closeImagePicker === 'function' && closeImagePicker(); closeMyProfile(); currentVrcUser = null`);
});

section('map', async main => {
    // E1: who gets a pin. Asked of hubWorldPlace with no pins of your own, so only the profile counts.
    await main.eval(`(() => {
        const friend = (id, displayName, extra) => ({ id, displayName, status: 'active', image: '', tags: [], bio: '', statusDescription: '', ...extra });
        window.__savedFriends = vrcFriendsData;
        vrcFriendsData = [
            friend('mapflag', 'Flaggy', { bio: 'hi 🇩🇪 here' }),
            friend('mapfrom', 'Fromage', { bio: 'Hello, I am from Japan!' }),
            friend('mapin', 'Inny', { bio: 'chilling in Japan rn, in love with Georgia' }),
            friend('mapengjpn', 'Kenji', { tags: ['language_eng', 'language_jpn'] }),
            friend('mapjk', 'Jinwoo', { tags: ['language_jpn', 'language_kor'] }),
            friend('mapph', 'Pinoy', { tags: ['language_fil', 'language_tgl'] }),
            friend('mapspa', 'Sakura', { tags: ['language_spa', 'language_jpn'] }),
            friend('mapeng', 'Engla', { tags: ['language_eng'] }),
        ];
    })()`);
    const placed = await main.json(`Object.fromEntries(vrcFriendsData.map(f => { const p = hubWorldPlace(f, {}); return [f.id, p ? p.code + ':' + p.how : null]; }))`);
    check('E1: a flag places a friend', placed.mapflag === 'DE:flag', JSON.stringify(placed));
    check('E1: an explicit "from Japan" places a friend', placed.mapfrom === 'JP:bio', JSON.stringify(placed));
    check('E1: a bare "in Japan" places nobody', placed.mapin === null, JSON.stringify(placed));
    check('E1: [eng, jpn] -> Japan (English is ignored)', placed.mapengjpn === 'JP:language', JSON.stringify(placed));
    check('E1: [jpn, kor] -> unplaced', placed.mapjk === null, JSON.stringify(placed));
    check('E1: [fil, tgl] -> the Philippines (two languages, one country)', placed.mapph === 'PH:language', JSON.stringify(placed));
    check('E1: [spa, jpn] -> unplaced', placed.mapspa === null, JSON.stringify(placed));
    check('E1: English alone -> unplaced', placed.mapeng === null, JSON.stringify(placed));
    const why = await main.json(`(() => { const of = id => _wmapWhy(hubWorldPlace(vrcFriendsData.find(f => f.id === id), {})); return { flag: of('mapflag'), bio: of('mapfrom'), language: of('mapengjpn'), none: of('mapjk') }; })()`);
    check('each pin says why it is there', why.flag === 'flag 🇩🇪 in profile' && why.bio === 'profile says "from Japan"' && why.language === 'language: Japanese' && why.none === 'Not on the map', JSON.stringify(why));
    await main.eval(`showTab(NAV_ITEMS_DEF['world-map'].tab)`);
    await waitFor('the globe', () => main.eval(`_wmap.frame > 0 && _wmap.places.size > 0`), 10000);
    check('E4: the note is the short one', (await main.eval(`document.querySelector('#tab39 .wmap-note').textContent`)) === "Pins are guessed from profiles: flags, 'from …' and languages. Never from IP addresses.");
    const rowWhy = await main.eval(`wmapSelect('JP', true), [...document.querySelectorAll('.wmap-friends .wmap-friend small')].map(s => s.textContent).sort().join(' / ')`);
    check('the country list shows each reason', rowWhy === 'language: Japanese / profile says "from Japan"', rowWhy);

    // E2: search by name.
    const search = async text => main.json(`(() => { const box = document.getElementById('wmapSearch'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input')); return [...document.querySelectorAll('#wmapResults .wmap-result')].map(r => ({ name: r.querySelector('span').textContent, why: r.querySelector('small').textContent, off: r.classList.contains('is-off'), set: !!r.querySelector('.wmap-set-btn') })); })()`);
    const many = await search('n');
    check('E2: search lists matching friends, up to 8', many.length >= 4 && many.length <= 8, JSON.stringify(many));
    await main.eval(`wmapSelect('JP'); wmapReset()`);
    const kenji = await search('ken');
    await main.eval(`document.querySelector('#wmapResults .wmap-result .wmap-friend').click()`);
    check('E2: choosing a placed friend turns the globe to their pin', kenji.length === 1 && await main.eval(`_wmap.selected === 'JP' && Math.abs(_wmap.lon - _wmapCountry('JP').p[0]) < 1`), JSON.stringify(kenji));
    const jinwoo = await search('jinwoo');
    check('E2: an unplaced friend says so and offers to set a country', jinwoo.length === 1 && jinwoo[0].off && jinwoo[0].set && jinwoo[0].why === 'Not on the map', JSON.stringify(jinwoo));
    await main.eval(`document.querySelector('#wmapResults .wmap-set-btn').click()`);
    check('E3: the country picker opens', await main.eval(`!!document.querySelector('#wmapResults #wmapPinSelect') && document.querySelectorAll('#wmapPinSelect option').length > 150`));
    await search('i');
    await main.eval(`wmapPinEdit('mapjk')`);
    const side = await main.json(`(() => { const r = document.querySelector('#tab39 .wmap-side').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    await main.screenshot(join(tmpdir(), 'hapshub-round6-map.png'), side);
    await search('jinwoo');
    await main.eval(`wmapPinEdit('mapjk')`);
    await main.eval(`(() => { const s = document.getElementById('wmapPinSelect'); s.value = 'KR'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    const afterSet = await main.json(`({ place: hubWorldPlace(vrcFriendsData.find(f => f.id === 'mapjk')), selected: _wmap.selected, row: document.querySelector('#wmapResults .wmap-result small')?.textContent, saved: JSON.parse(localStorage.getItem('hapshub.map.pins') || '{}').mapjk })`);
    check('E3: setting a country places the friend, says "set by you" and turns the globe there', afterSet.place?.code === 'KR' && afterSet.place?.how === 'manual' && afterSet.selected === 'KR' && afterSet.row?.endsWith('set by you') && afterSet.saved === 'KR', JSON.stringify(afterSet));
    await waitFor('the pin drawn', () => main.eval(`(_wmap.pins || []).some(p => p.code === 'KR')`), 5000).catch(() => {});
    check('E3: a pin you set looks different on the globe', await main.eval(`(_wmap.pins || []).some(p => p.code === 'KR' && p.manual) && !(_wmap.pins || []).some(p => p.code !== 'KR' && p.manual)`));
    await main.eval(`wmapSetPin('mapflag', 'FR')`);
    check('E3: your pin wins over a flag in the profile', await main.eval(`hubWorldPlace(vrcFriendsData.find(f => f.id === 'mapflag')).code === 'FR'`));
    await main.eval(`wmapSetPin('mapflag', null)`);
    check('E3: clearing it goes back to the profile', await main.eval(`hubWorldPlace(vrcFriendsData.find(f => f.id === 'mapflag')).code === 'DE' && !('mapflag' in JSON.parse(localStorage.getItem('hapshub.map.pins')))`));
    await search('');
    check('E2: an empty search hides the results', await main.eval(`document.getElementById('wmapResults').hidden`));
    await main.eval(`vrcFriendsData = window.__savedFriends; showTab(0)`);
});

section('plugins off', async main => {
    // B3: with a plugin off, nothing of it is left anywhere in Settings: not its options (even when they were open),
    // its slots, its own section or its module rows. Every Settings section is visited for every plugin.
    await main.eval(`hubOpenPlugins()`);
    await waitFor('plugin rows', () => main.eval(`document.querySelectorAll('.hub-plugin-row').length > 20`), 5000);
    const result = JSON.parse(await main.eval(`(async () => {
        const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const navs = [...document.querySelectorAll('#tab9 .settings-nav-item')];
        const found = [];
        let visits = 0;
        for (const p of HUB_PLUGINS) {
            const options = _hubPluginHasOptions(p);
            if (options) hubPluginToggleOptions(p.id, true);
            hubPluginSet(p.id, false);
            const selectors = [..._hubPluginSelectors(p), '.hub-plugin-opts[data-plugin-opts="' + p.id + '"]',
                ...(p.settings || []).map(s => '#hubModulesList .hub-module-row[data-module="' + s.module + '"]')];
            for (const nav of navs.filter(visible)) {
                nav.click();
                visits++;
                await null; // no timers: a test window left in the background gets them throttled to one a minute
                for (const selector of selectors)
                    for (const el of document.querySelectorAll(selector))
                        if (el.closest('#tab9') && visible(el)) found.push(p.id + ': ' + selector + ' in ' + nav.textContent.trim());
            }
            hubPluginSet(p.id, true);
            if (options) hubPluginToggleOptions(p.id, false);
        }
        return JSON.stringify({ found: [...new Set(found)], visits, plugins: HUB_PLUGINS.length });
    })()`));
    check('B3: with a plugin off, none of its settings appear anywhere in Settings', result.found.length === 0 && result.visits > result.plugins * 5, JSON.stringify(result).slice(0, 600));
    // The app answers every switch with the full list; wait until it has answered the last one.
    const stillOff = () => main.json(`HUB_PLUGINS.filter(p => !hubPluginOn(p.id)).map(p => p.id)`);
    await waitFor('every switch answered', () => main.eval(`hubPluginsSettled()`), 30000).catch(() => {});
    const off = await stillOff();
    check('B3: every plugin is back on afterwards', off.length === 0, 'still off: ' + off.join(', '));
    await main.eval(`showTab(0)`);
});

section('licences', async main => {
    await main.eval(`showTab(9); switchSettingsSection('about')`);
    const shown = id => main.eval(`(() => { const el = document.querySelector('#settingsAttributionCard .attrib-item[data-licence="${id}"]'); return !!el && getComputedStyle(el).display !== 'none'; })()`);
    const missing = await main.json(`HUB_PLUGINS.flatMap(p => p.licences || []).filter(l => !document.querySelector('#settingsAttributionCard .attrib-item[data-licence="' + l + '"]'))`);
    check('B5: every licence a plugin names is in Attribution', missing.length === 0, missing.join(','));
    check('B5: a plugin that is on shows its licence', await shown('vosk') && await shown('world-atlas'));
    await main.eval(`hubPluginSet('voice-fight', false); hubPluginSet('world-map', false)`);
    check('B5: turning a plugin off removes its licences', !(await shown('vosk')) && !(await shown('world-atlas')));
    check('B5: a library another plugin still uses stays', await shown('naudio'));
    check("B5: HapsHub's own libraries always show", await main.eval(`[...document.querySelectorAll('#settingsAttributionCard .attrib-item:not([data-licence])')].every(el => getComputedStyle(el).display !== 'none')`));
    await main.eval(`['voice-fight', 'youtube-tunnel', 'frame-shot', 'kikitan-xd'].forEach(id => hubPluginSet(id, false))`);
    // The app answers every switch with the full list, so earlier answers can briefly undo later switches: wait.
    await waitFor('NAudio to go', async () => !(await shown('naudio')), 10000).catch(() => {});
    check('B5: with every plugin that uses it off, a shared library goes too', !(await shown('naudio')));
    await main.eval(`['voice-fight', 'youtube-tunnel', 'frame-shot', 'kikitan-xd', 'world-map'].forEach(id => hubPluginSet(id, true))`);
    const back = async () => await shown('vosk') && await shown('naudio') && await shown('world-atlas');
    await waitFor('every switch answered', () => main.eval(`hubPluginsSettled()`), 30000).catch(() => {});
    await waitFor('the licences to come back', back, 10000).catch(() => {});
    check('B5: turning them back on lists them again', await back());
});

section('licences install', async main => {
    // B5: a plugin that is installed brings its licence, and removing it cleans the licence up again. Plugins ship
    // with HapsHub for now, so the test takes World Map (the only plugin naming world-atlas) out of the list and
    // puts it back, the way an installer would, and restores it whatever happens.
    await main.eval(`showTab(9); switchSettingsSection('about')`);
    const shown = id => main.eval(`(() => { const el = document.querySelector('#settingsAttributionCard .attrib-item[data-licence="${id}"]'); return !!el && getComputedStyle(el).display !== 'none'; })()`);
    const listed = () => main.eval(`!!document.querySelector('#hubPluginList .hub-plugin-row[data-plugin="world-map"]')`);
    await main.eval(`window.__b5Def = HUB_PLUGINS.find(p => p.id === 'world-map'); window.__b5At = HUB_PLUGINS.indexOf(window.__b5Def)`);
    const remove = () => main.eval(`HUB_PLUGINS.splice(HUB_PLUGINS.indexOf(window.__b5Def), 1); _hubPluginsApply()`);
    const install = () => main.eval(`if (!HUB_PLUGINS.includes(window.__b5Def)) HUB_PLUGINS.splice(window.__b5At, 0, window.__b5Def); _hubPluginsApply()`);
    try {
        check('B5: World Map is on before the test', await main.eval(`hubPluginOn('world-map')`) && await shown('world-atlas'));
        await remove();
        check('B5: before install, its licence is not listed', !(await shown('world-atlas')));
        await install();
        check('B5: installing the plugin lists its licence', await shown('world-atlas'));
        check('B5: installing the plugin lists it in Plugins', await listed());
        await remove();
        check('B5: removing the plugin cleans its licence up', !(await shown('world-atlas')));
        check('B5: removing the plugin takes it out of Plugins', !(await listed()));
        check('B5: removing it leaves the other licences alone', await shown('vosk') && await shown('naudio'));
    } finally {
        await install();
    }
    check('B5: World Map and its licence are back after the test', await shown('world-atlas') && await listed());
    await main.eval(`showTab(0)`);
});

section('eagle', async main => {
    // Issue 9: Eagle is held in a tab inside Media Library, the way OyasumiVR is held in its page.
    const visible = sel => main.eval(`!!document.querySelector(${JSON.stringify(sel)})?.offsetParent`);
    await main.eval(`showTab(7); libShowSource('library')`);
    await waitFor('the Eagle tab', () => visible('#libTabEagle'), 10000).catch(() => {});
    check('9: Media Library has Library and Eagle tabs', await visible('#libTabLibrary') && await visible('#libTabEagle'));
    const tab = await main.center('#libTabEagle');
    if (!tab) return;
    await main.click(tab.x, tab.y);
    await waitFor('the Eagle pane', () => visible('#aemb-pane-eagle'), 5000).catch(() => {});
    // The mode <select> is hidden inside its custom .vn-select dropdown; the wrapper is what shows.
    const hiddenParts = [];
    for (const s of ['#aemb-pane-eagle', '#aemb-start-eagle', '.vn-select:has(> #aemb-mode-eagle)']) if (!await visible(s)) hiddenParts.push(s);
    check('9: the Eagle tab shows the pane and Eagle\'s controls', !hiddenParts.length, hiddenParts.length ? 'hidden: ' + hiddenParts.join(' ') : '');
    check('9: the library\'s own grid and filters make way', await main.eval(`!document.getElementById('libFavBtn').offsetParent && !document.querySelector('#tab7 .lib-wrap').offsetParent && !!document.getElementById('libTabLibrary').offsetParent`));
    const state = await waitSeen(main, 'hubEmbedState', p => p.app === 'eagle', 10000).catch(() => null);
    check('9: the app answers for Eagle', !!state, JSON.stringify(state).slice(0, 160));
    await waitFor('the pane report', () => main.eval(`(_aemb.sent.eagle || '').includes('"visible":true')`), 5000).catch(() => {});
    check('9: the page tells the app where the pane is', await main.eval(`(_aemb.sent.eagle || '').includes('"visible":true')`), await main.eval(`_aemb.sent.eagle || 'nothing sent'`));
    const lib = await main.center('#libTabLibrary');
    await main.click(lib.x, lib.y);
    await waitFor('the pane hidden report', () => main.eval(`(_aemb.sent.eagle || '').includes('"visible":false')`), 5000).catch(() => {});
    check('9: back on Library, the grid is back and the app hears the pane is hidden', await visible('#libFavBtn') && !(await visible('#aemb-pane-eagle')) && await main.eval(`(_aemb.sent.eagle || '').includes('"visible":false')`));

    // The plugin owns it: off, the tab is gone and Media Library is the library again.
    await main.eval(`libShowSource('eagle')`);
    await main.eval(`hubPluginSet('eagle', false)`);
    await waitFor('the Eagle tab to go', async () => !(await visible('#libTabEagle')), 10000).catch(() => {});
    check('9: with the Eagle plugin off, Media Library has no Eagle tab', !(await visible('#libTabEagle')) && !(await visible('#aemb-pane-eagle')) && await visible('#libFavBtn'));
    await main.eval(`hubPluginSet('eagle', true)`);
    await waitFor('every switch answered', () => main.eval(`hubPluginsSettled()`), 30000).catch(() => {});
    check('9: Eagle\'s path setting is back under the plugin', await main.eval(`HUB_PLUGINS.find(p => p.id === 'eagle').settings?.[0]?.keys?.includes('eagle_path')`));
    await main.eval(`showTab(0)`);
});

// A picture folder for the dashboard: three wide pictures and an Eagle-style preview that must never be picked.
const pics = mkdtempSync(join(tmpdir(), 'hapshub-pics-'));
writePng(join(pics, 'red.png'), 64, 36, [200, 30, 30]);
writePng(join(pics, 'green.png'), 64, 36, [30, 200, 30]);
writePng(join(pics, 'blue.png'), 64, 36, [30, 30, 200]);
writePng(join(pics, 'red_thumbnail.png'), 64, 36, [250, 250, 30]);
const dir = freshData('hapshub-round6-', { RandomDashBg: true, DashBgFolders: [pics], DashBgLandscapeOnly: true });
let main;
try {
    main = await openMain(dir, PORT);
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    await sleep(1500);
    for (const { name, run } of sections) {
        if (only && !only.includes(name)) continue;
        try { await run(main); }
        catch (error) {
            const log = main.closed ? ' | app log: ' + hubLog(dir).trim().split(/\r?\n/).slice(-10).join(' | ') : '';
            check(`${name}: the section finished`, false, error.message + log);
            if (main.closed) { if (process.env.HAPSHUB_KEEP_LOG) writeFileSync(process.env.HAPSHUB_KEEP_LOG, hubLog(dir)); break; }
        }
    }
    check('no page errors', main.errors.length === 0, main.errors.join(' | '));
    const switchId = main.switchId;
    const closed = await closeMain(main);
    check('the app closes cleanly', closed, hubLog(dir).trim().split(/\r?\n/).slice(-6).join(' | '));
    const switches = switchId && (!only || only.includes('launch switches'));
    const pins = !only || only.includes('map');
    if (switches || pins) {
        main = await openMain(dir, PORT);
        if (switches) {
            // After a restart the switch and the names are still there.
            await waitFor('settings loaded', () => main.eval(`typeof launchSwitches === 'function' && launchSwitches().length > 3`), 20000).catch(() => {});
            const after = await main.json(`launchSwitches().map(s => s.label)`);
            check('A7: after a restart the new switch and the new name are still there', after.includes('With lights') && after.includes('With trackers'), after.join(','));
        }
        if (pins) {
            await waitFor('the map code', () => main.eval(`typeof hubWorldPlace === 'function'`), 20000).catch(() => {});
            const pin = await main.json(`({ saved: JSON.parse(localStorage.getItem('hapshub.map.pins') || '{}').mapjk, place: hubWorldPlace({ id: 'mapjk', tags: ['language_jpn', 'language_kor'] }) })`);
            check('E3: after a restart the country you set is still there and still wins', pin.saved === 'KR' && pin.place?.code === 'KR' && pin.place?.how === 'manual', JSON.stringify(pin));
        }
        await closeMain(main);
    }
    check('no crash report', crashes(dir) === 0, crashDetail(dir));
} catch (error) {
    check('the run finished', false, error.stack || error.message);
} finally {
    await cleanUp(dir, pics);
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
