// HapsHub's own interface changes, kept here so upstream merges stay simple:
// dashboard toggles and status, letter spacing, font search, collapsible People groups,
// and the avatar database toggles that do nothing while the forwarding block is closed.

const _HUB_DASH_STATS = { dash_online: 'dashStatOnline', dash_status: 'dashStatVrcStatus', dash_friends: 'dashStatFriends', dash_web: 'dashStatSession' };
const _HUB_FORWARD_TOGGLES = ['setAvtrdbReport', 'setAvtrIcuReport', 'setAvtrdbSubmit', 'setAvtrIcuSubmit', 'setVrcndbSubmit', 'setVrcndbReport'];
const _HUB_PEOPLE_GRIDS = ['favFriendsGrid', 'allFriendsGrid', 'instancePlayersGrid', 'recentSeenGrid'];
const _HUB_COLLAPSED_KEY = 'hapshub.people.collapsed';

let _hubUiSettings = null;

function _hubSetting(modules, moduleId, key) {
    return modules.find(m => m.id === moduleId)?.settings?.find(s => s.key === key)?.value;
}

// ---- Applied whenever the module list arrives ----

function hubUiApply(modules) {
    _hubUiSettings = modules;
    _hubApplyDashboard();
    _hubApplyLetterSpacing();
    _hubApplyForwardingNote(_hubSetting(modules, 'hub.forwarding', 'forward_avatar_data') === 'true');
}

function _hubApplyDashboard() {
    if (!_hubUiSettings) return;
    const welcome = document.getElementById('dashWelcome');
    if (welcome) welcome.style.display = _hubSetting(_hubUiSettings, 'hub.ui', 'dash_welcome') === 'false' ? 'none' : '';

    const stats = document.getElementById('dashHeroStats');
    if (!stats) return;
    for (const [key, id] of Object.entries(_HUB_DASH_STATS)) {
        const stat = document.getElementById(id)?.closest('.dash-hero-stat');
        if (stat) stat.style.display = _hubSetting(_hubUiSettings, 'hub.ui', key) === 'false' ? 'none' : '';
    }
    // A separator only belongs between two stats that are showing.
    let seenStat = false, pending = null;
    for (const child of stats.children) {
        if (child.classList.contains('dash-hero-stat-sep')) {
            child.style.display = 'none';
            pending = child;
        } else if (child.style.display !== 'none') {
            if (seenStat && pending) pending.style.display = '';
            seenStat = true;
            pending = null;
        }
    }
}

function _hubApplyLetterSpacing() {
    const value = parseFloat(_hubSetting(_hubUiSettings, 'hub.ui', 'letter_spacing')) || 0;
    document.body.style.letterSpacing = value ? `${value}px` : '';
    const slider = document.getElementById('setLetterSpacing');
    if (slider && document.activeElement !== slider) slider.value = value;
    const label = document.getElementById('letterSpacingVal');
    if (label) label.textContent = `${value > 0 ? '+' : ''}${value} px`;
}

function hubLetterSpacingChanged(value) {
    const label = document.getElementById('letterSpacingVal');
    const number = parseFloat(value) || 0;
    if (label) label.textContent = `${number > 0 ? '+' : ''}${number} px`;
    document.body.style.letterSpacing = number ? `${number}px` : '';
}

function hubLetterSpacingSave(value) {
    sendToCS({ action: 'hubSetSetting', module: 'hub.ui', key: 'letter_spacing', value: String(parseFloat(value) || 0) });
}

function _hubApplyForwardingNote(open) {
    for (const id of _HUB_FORWARD_TOGGLES) {
        const toggle = document.getElementById(id);
        if (toggle) toggle.disabled = !open;
    }
    for (const id of ['avtrdbTabSupport', 'vrcndbTabSupport']) {
        const tab = document.getElementById(id);
        if (!tab) continue;
        let note = tab.querySelector('.hub-forwarding-note');
        if (!note) {
            note = document.createElement('div');
            note.className = 'set-desc hub-forwarding-note';
            note.style.cssText = 'color:var(--err);margin-bottom:10px;';
            note.textContent = t('hub.forwarding.closed_note', 'Nothing is sent while the forwarding block is closed, so these are off. Open it with "Send avatar data to avatar databases" in General > Hub modules.');
            tab.prepend(note);
        }
        note.style.display = open ? 'none' : '';
    }
}

// ---- VRChat status beside the online counts ----

function hubDashStatus(payload) {
    const value = document.getElementById('dashStatVrcStatus');
    if (!value || !payload) return;
    const level = _apiHealthLevel(payload.indicator);
    value.textContent = level === 'ok'
        ? t('hub.dash.status_ok', 'OK')
        : level === 'warn' ? t('hub.dash.status_minor', 'Issues') : t('hub.dash.status_major', 'Outage');
    value.style.color = level === 'ok' ? '' : 'var(--err)';
    value.title = payload.description || '';
}

// ---- Installed font search ----

function hubFontSearch(query) {
    window._hubFontFilter = query.trim().toLowerCase();
    renderCustomFontOptions();
}

// ---- Collapsible People groups ----

function _hubCollapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(_HUB_COLLAPSED_KEY) || '[]')); }
    catch { return new Set(); }
}

function _hubGroupKey(grid, header) {
    const title = header.querySelector('.topbar-title') || header;
    return `${grid.id}:${title.textContent.trim()}`;
}

function _hubApplyCollapsed(grid) {
    const collapsed = _hubCollapsed();
    let hidden = false;
    for (const child of grid.children) {
        if (child.classList.contains('fav-group-header')) {
            hidden = collapsed.has(_hubGroupKey(grid, child));
            child.classList.add('hub-group-header');
            child.classList.toggle('hub-group-collapsed', hidden);
        } else {
            child.classList.toggle('hub-group-hidden', hidden);
        }
    }
}

function _hubPeopleClick(event) {
    const header = event.target.closest?.('.fav-group-header');
    const grid = header?.parentElement;
    if (!grid || !_HUB_PEOPLE_GRIDS.includes(grid.id)) return;
    // The world link and edit controls in a header keep doing what they did.
    if (event.target.closest('button, a, input, select, .pl-inst-link, .vrcn-dropdown')) return;
    const collapsed = _hubCollapsed();
    const key = _hubGroupKey(grid, header);
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    localStorage.setItem(_HUB_COLLAPSED_KEY, JSON.stringify([...collapsed]));
    _hubApplyCollapsed(grid);
}

function _hubWatchPeopleGrids() {
    const remaining = _HUB_PEOPLE_GRIDS.filter(id => {
        const grid = document.getElementById(id);
        if (!grid) return true;
        if (!grid._hubWatched) {
            grid._hubWatched = true;
            new MutationObserver(() => _hubApplyCollapsed(grid)).observe(grid, { childList: true });
            _hubApplyCollapsed(grid);
        }
        return false;
    });
    if (remaining.length) setTimeout(_hubWatchPeopleGrids, 1000);
}

// ---- Start ----

(function _hubUiStart() {
    const style = document.createElement('style');
    style.textContent = `
        .hub-group-hidden { display: none !important; }
        .hub-group-header { cursor: pointer; user-select: none; }
        .hub-group-header::before { content: '\\25BE'; margin-right: 6px; opacity: .7; }
        .hub-group-header.hub-group-collapsed::before { content: '\\25B8'; }`;
    document.head.appendChild(style);
    document.addEventListener('click', _hubPeopleClick);
    _hubWatchPeopleGrids();

    // A reply sent before messages.js registers is lost, and the hub starts in the background, so keep asking.
    let attempts = 0;
    const ask = () => {
        if (_hubUiSettings?.length || ++attempts > 30) return;
        if (typeof sendToCS === 'function') sendToCS({ action: 'hubGetModules' });
        setTimeout(ask, 2000);
    };
    setTimeout(ask, 1000);
})();
