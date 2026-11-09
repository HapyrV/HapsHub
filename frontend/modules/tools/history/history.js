/* === HapsHub: the History page. Everything VRCX and HapsHub kept, in one place. === */

const HHIST_VIEWS = [
    { id: 'names',         icon: 'badge',           key: 'hub.history.view_names',         label: 'Names and trust' },
    { id: 'friends',       icon: 'group_add',       key: 'hub.history.view_friends',       label: 'Friend log' },
    { id: 'notifications', icon: 'notifications',   key: 'hub.history.view_notifications', label: 'Notifications' },
    { id: 'videos',        icon: 'smart_display',   key: 'hub.history.view_videos',        label: 'Video plays' },
    { id: 'avatars',       icon: 'checkroom',       key: 'hub.history.view_avatars',       label: 'Avatars you wore' },
    { id: 'friendavatars', icon: 'face',            key: 'hub.history.view_friendavatars', label: "Friends' avatars" },
    { id: 'portals',       icon: 'blur_circular',   key: 'hub.history.view_portals',       label: 'Portals' },
    { id: 'gamelog',       icon: 'article',         key: 'hub.history.view_gamelog',       label: 'Game events' },
    { id: 'instances',     icon: 'bar_chart',       key: 'hub.history.view_instances',     label: 'Instance chart', mode: 'chart' },
    { id: 'purchases',     icon: 'shopping_bag',    key: 'hub.history.view_purchases',     label: 'Purchases', mode: 'account' },
    { id: 'moderation',    icon: 'shield',          key: 'hub.history.view_moderation',    label: 'Moderation reports', mode: 'account' },
];

const _hhist = { view: 'names', search: '', offset: 0, total: 0, pageSize: 100, request: 0, searchTimer: 0, accountRows: [], accountMore: false };

function _hhistEl(id) { return document.getElementById(id); }

function _hhistWhen(value) {
    const date = new Date(value);
    return isNaN(date) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function _hhistRenderViews() {
    const box = _hhistEl('hhistViews');
    if (!box) return;
    box.innerHTML = HHIST_VIEWS.map(view => `<button class="vrcn-button${view.id === _hhist.view ? ' active' : ''}" onclick="hhistShow('${view.id}')"><span class="msi" style="font-size:15px;">${view.icon}</span> ${esc(t(view.key, view.label))}</button>`).join('');
}

function hhistShow(view) {
    const def = HHIST_VIEWS.find(item => item.id === view);
    if (!def) return;
    // A search still waiting to run belongs to the list being left.
    clearTimeout(_hhist.searchTimer);
    _hhist.view = view;
    _hhist.offset = 0;
    _hhist.search = '';
    _hhistEl('hhistSearch').value = '';
    _hhist.accountRows = [];
    _hhistRenderViews();
    _hhistEl('hhistListControls').style.display = def.mode ? 'none' : '';
    _hhistEl('hhistDayControls').style.display = def.mode === 'chart' ? '' : 'none';
    _hhistEl('hhistBody').innerHTML = `<div class="hhist-empty">${esc(t('hub.history.loading', 'Reading your history...'))}</div>`;
    if (def.mode === 'chart') {
        const input = _hhistEl('hhistDay');
        if (!input.value) input.value = _hhistDayString(new Date());
        hhistLoadDay();
    } else if (def.mode === 'account') {
        sendToCS({ action: 'hubHistoryAccount', view, offset: 0 });
    } else {
        _hhistRead();
    }
}

function _hhistRead() {
    _hhist.request++;
    sendToCS({ action: 'hubHistoryRead', view: _hhist.view, search: _hhist.search, offset: _hhist.offset, request: _hhist.request });
}

function hhistSearchChanged() {
    clearTimeout(_hhist.searchTimer);
    _hhist.searchTimer = setTimeout(() => {
        _hhist.search = _hhistEl('hhistSearch').value;
        _hhist.offset = 0;
        _hhistRead();
    }, 250);
}

function hhistPage(direction) {
    _hhist.offset = Math.max(0, _hhist.offset + direction * _hhist.pageSize);
    _hhistRead();
}

function _hhistUser(row) {
    if (!row.name && !row.userId) return '';
    const name = esc(row.name || row.userId);
    return row.userId ? `<button class="hhist-link" data-user="${esc(row.userId)}" onclick="openFriendDetail(this.dataset.user)">${name}</button>` : name;
}

function _hhistKindLabel(kind) {
    const labels = {
        DisplayName: t('hub.history.kind_name', 'Name'),
        TrustLevel: t('hub.history.kind_trust', 'Trust'),
        Friend: t('hub.history.kind_friend', 'Added'),
        Unfriend: t('hub.history.kind_unfriend', 'Removed'),
        FriendRequest: t('hub.history.kind_request', 'Request'),
        spawn: t('hub.history.kind_portal_spawn', 'Portal opened'),
        used: t('hub.history.kind_portal_used', 'Portal used'),
        video: t('hub.history.kind_video', 'Video'),
        avatar: t('hub.history.kind_avatar', 'Avatar'),
        event: t('hub.history.kind_event', 'Event'),
    };
    return labels[kind] || kind;
}

function _hhistDuration(milliseconds) {
    const minutes = Math.round(Number(milliseconds) / 60000);
    if (!minutes) return '';
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function _hhistMain(row) {
    const user = _hhistUser(row);
    switch (_hhist.view) {
        case 'names':
            return `${user}<div class="hhist-sub">${esc(row.oldValue || '?')}<span class="hhist-arrow">&rarr;</span>${esc(row.newValue)}</div>`;
        case 'friends':
            return user;
        case 'notifications':
            return `${user}${row.newValue ? ` <span class="hhist-sub">${esc(row.newValue)}</span>` : ''}${row.text ? `<div class="hhist-sub">${esc(row.text)}</div>` : ''}`;
        case 'videos': {
            const safe = /^https?:\/\//i.test(row.link);
            const title = esc(row.text || row.link);
            const link = safe ? `<button class="hhist-link" data-url="${esc(row.link)}" onclick="sendToCS({ action: 'openUrl', url: this.dataset.url })">${title}</button>` : title;
            return `${link}${user || row.newValue ? `<div class="hhist-sub">${user}${user && row.newValue ? ' · ' : ''}${esc(row.newValue)}</div>` : ''}`;
        }
        case 'avatars': {
            const worn = _hhistDuration(row.newValue);
            const label = esc(row.text || row.link);
            return `<button class="hhist-link" data-avatar="${esc(row.link)}" onclick="openAvatarDetail(this.dataset.avatar)">${label}</button>${worn ? ` <span class="hhist-sub">${esc(worn)}</span>` : ''}`;
        }
        case 'friendavatars':
            return `${user}<div class="hhist-sub">${esc(row.text)}</div>`;
        case 'portals':
            return esc(row.text || row.link || t('hub.history.unknown_place', 'Unknown place'));
        default:
            return esc(row.text);
    }
}

function onHubHistory(payload) {
    if (!_hhistEl('hhistBody') || payload.view !== _hhist.view || payload.request !== _hhist.request) return;
    const body = _hhistEl('hhistBody');
    if (payload.error) {
        body.innerHTML = `<div class="hhist-empty">${esc(payload.error)}</div>`;
        return;
    }
    _hhist.total = payload.total;
    _hhist.pageSize = payload.pageSize;
    _hhist.offset = payload.offset;
    const rows = payload.rows || [];
    _hhistEl('hhistPrev').disabled = payload.offset === 0;
    _hhistEl('hhistNext').disabled = payload.offset + rows.length >= payload.total;
    _hhistEl('hhistCount').textContent = rows.length
        ? t('hub.history.range', '{from} to {to} of {total}')
            .replace('{from}', (payload.offset + 1).toLocaleString())
            .replace('{to}', (payload.offset + rows.length).toLocaleString())
            .replace('{total}', payload.total.toLocaleString())
        : '';
    if (!rows.length) {
        body.innerHTML = `<div class="hhist-empty">${esc(t(payload.search ? 'hub.history.no_match' : 'hub.history.empty', payload.search ? 'Nothing matches that search.' : 'Nothing here yet.'))}</div>`;
        return;
    }
    body.innerHTML = rows.map(row => `<div class="hhist-row">
        <span class="hhist-at">${esc(_hhistWhen(row.at))}</span>
        <span class="hhist-kind" title="${esc(row.kind)}">${esc(_hhistKindLabel(row.kind))}</span>
        <span class="hhist-main">${_hhistMain(row)}</span>
        <span class="hhist-source">${esc(row.source)}</span>
    </div>`).join('');
    body.scrollTop = 0;
}

/* --- Instance chart: one line per place, across a day in your local time --- */

function _hhistDayString(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function _hhistDayBounds(day) {
    const [year, month, date] = day.split('-').map(Number);
    return { start: new Date(year, month - 1, date), end: new Date(year, month - 1, date + 1) };
}

function hhistDayStep(direction) {
    const input = _hhistEl('hhistDay');
    const { start } = _hhistDayBounds(input.value);
    start.setDate(start.getDate() + direction);
    input.value = _hhistDayString(start);
    hhistLoadDay();
}

function hhistLoadDay() {
    const day = _hhistEl('hhistDay').value;
    if (!day) return;
    const { start, end } = _hhistDayBounds(day);
    sendToCS({ action: 'hubHistoryInstances', from: start.toISOString(), to: end.toISOString(), day });
}

function _hhistFormatHours(milliseconds) {
    const minutes = Math.round(milliseconds / 60000);
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** Works out each visit's place on the day. A visit with no recorded end runs until the next one, up to an hour. */
function hhistLayoutVisits(visits, dayStart, dayEnd, now = Date.now()) {
    const span = dayEnd - dayStart;
    const sorted = visits.map(visit => ({ ...visit, began: new Date(visit.at).getTime(), ended: new Date(visit.leftAt).getTime() }))
        .filter(visit => !isNaN(visit.began))
        .sort((a, b) => a.began - b.began);
    const lanes = new Map();
    sorted.forEach((visit, index) => {
        const open = isNaN(visit.ended) || visit.ended <= visit.began;
        const nextStart = sorted[index + 1]?.began ?? Infinity;
        const end = open ? Math.min(nextStart, visit.began + 3600000, now) : visit.ended;
        const from = Math.max(visit.began, dayStart.getTime());
        const to = Math.min(end, dayEnd.getTime());
        if (to <= dayStart.getTime() || from >= dayEnd.getTime() || to <= from) return;
        const name = visit.worldName || visit.worldId || visit.location || '?';
        if (!lanes.has(name)) lanes.set(name, { name, worldId: visit.worldId, total: 0, bars: [] });
        const lane = lanes.get(name);
        lane.total += to - from;
        lane.bars.push({ left: (from - dayStart.getTime()) / span * 100, width: (to - from) / span * 100, from, to, open, players: visit.players });
    });
    return [...lanes.values()].sort((a, b) => b.total - a.total);
}

function onHubHistoryInstances(payload) {
    const body = _hhistEl('hhistBody');
    if (!body || _hhist.view !== 'instances' || payload.day !== _hhistEl('hhistDay').value) return;
    if (payload.error) {
        body.innerHTML = `<div class="hhist-empty">${esc(payload.error)}</div>`;
        return;
    }
    const { start, end } = _hhistDayBounds(payload.day);
    const lanes = hhistLayoutVisits(payload.visits || [], start, end);
    const total = lanes.reduce((sum, lane) => sum + lane.total, 0);
    _hhistEl('hhistDayTotal').textContent = total ? t('hub.history.day_total', '{time} in {places} places').replace('{time}', _hhistFormatHours(total)).replace('{places}', lanes.length) : '';
    if (!lanes.length) {
        body.innerHTML = `<div class="hhist-empty">${esc(t('hub.history.no_visits', 'No visits on this day.'))}</div>`;
        return;
    }
    const clock = time => new Date(time).toLocaleTimeString([], { timeStyle: 'short' });
    const hours = Array.from({ length: 24 }, (_, hour) => `<span>${hour % 3 === 0 ? hour : ''}</span>`).join('');
    body.innerHTML = `<div class="hhist-chart"><div class="hhist-axis">${hours}</div>${lanes.map(lane => `<div class="hhist-lane">
        <span class="hhist-lane-name" title="${esc(lane.name)} (${esc(_hhistFormatHours(lane.total))})">${esc(lane.name)}</span>
        <span class="hhist-lane-track">${lane.bars.map(bar => `<button class="hhist-bar${bar.open ? ' hhist-open' : ''}" style="left:${bar.left.toFixed(3)}%;width:${bar.width.toFixed(3)}%;"
            data-world="${esc(lane.worldId || '')}" onclick="if (this.dataset.world) openWorldSearchDetail(this.dataset.world)"
            title="${esc(lane.name)}: ${esc(clock(bar.from))} - ${esc(clock(bar.to))}${bar.open ? ` (${esc(t('hub.history.no_end', 'end not recorded'))})` : ''}${bar.players ? `, ${esc(t('hub.history.people', '{count} people').replace('{count}', bar.players))}` : ''}"></button>`).join('')}</span>
    </div>`).join('')}</div>`;
}

/* --- Your account: purchases and moderation reports, read from VRChat when you open them --- */

function _hhistAccountRow(view, item) {
    if (view === 'moderation') {
        const target = esc(item.contentName || item.contentId || '');
        return `<div class="hhist-row"><span class="hhist-at">${esc(_hhistWhen(item.created))}</span><span class="hhist-kind">${esc(item.type || '')}</span>
            <span class="hhist-main">${target}<div class="hhist-sub">${esc([item.category, item.reason].filter(Boolean).join(' · '))}</div>${item.description ? `<div class="hhist-sub">${esc(item.description)}</div>` : ''}</span></div>`;
    }
    const flags = [item.isGift ? t('hub.history.gift', 'Gift') : '', item.purchaseActive === false ? t('hub.history.inactive', 'Not active') : ''].filter(Boolean).join(' · ');
    const price = item.purchasePrice ? `${Number(item.purchasePrice).toLocaleString()} V` : '';
    return `<div class="hhist-row"><span class="hhist-at">${esc(_hhistWhen(item.purchaseDate))}</span><span class="hhist-kind">${esc(item.listingType || '')}</span>
        <span class="hhist-main">${esc(item.listingDisplayName || '')}<div class="hhist-sub">${esc([item.listingSubtitle, item.sellerDisplayName, flags].filter(Boolean).join(' · '))}</div></span>
        <span class="hhist-source">${esc(price)}</span></div>`;
}

function onHubHistoryAccount(payload) {
    const body = _hhistEl('hhistBody');
    if (!body || payload.view !== _hhist.view) return;
    if (payload.error) {
        body.innerHTML = `<div class="hhist-empty">${esc(payload.error)}</div>`;
        return;
    }
    if (payload.offset === 0) _hhist.accountRows = [];
    _hhist.accountRows.push(...(payload.items || []));
    _hhist.accountMore = !!payload.more;
    if (!_hhist.accountRows.length) {
        body.innerHTML = `<div class="hhist-empty">${esc(t('hub.history.empty', 'Nothing here yet.'))}</div>`;
        return;
    }
    body.innerHTML = _hhist.accountRows.map(item => _hhistAccountRow(payload.view, item)).join('')
        + (_hhist.accountMore ? `<button class="vrcn-button" onclick="sendToCS({ action: 'hubHistoryAccount', view: _hhist.view, offset: _hhist.accountRows.length })">${esc(t('hub.history.more', 'Show more'))}</button>` : '');
}

/* --- Fills the page whenever it comes into view empty, since unused tabs are unloaded --- */

(function _hhistWatchTab() {
    const tab = document.getElementById('tab31');
    if (!tab) { setTimeout(_hhistWatchTab, 1000); return; }
    new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        const fill = (tries = 0) => {
            const body = _hhistEl('hhistBody');
            if (!body) { if (tries < 100) setTimeout(() => fill(tries + 1), 50); return; }
            if (!body.children.length) {
                _hhist.search = '';
                hhistShow(_hhist.view);
            }
        };
        fill();
    }).observe(tab);
})();

document.documentElement.addEventListener('languagechange', () => {
    if (_hhistEl('hhistViews')) _hhistRenderViews();
});
