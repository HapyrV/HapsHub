// Friend Schedule: when friends are usually online, worked out from local history only.
// The analysis is the same engine as the VRCX version, in engine.js.

const _FSCH_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _FSCH_MAX_PLANNER = 5;
const _FSCH_MAX_PICK_ROWS = 200;
const _FSCH_PREFS_KEY = 'fschPrefs';

let _fschData = null;           // The raw rows from the app.
let _fschResult = null;         // The engine's latest answer.
let _fschSelected = null;       // The selected cell's index.
let _fschView = 'heatmap';
let _fschWorker = null;
let _fschSeq = 0;
let _fschForce = false;         // The next analysis ignores saved results.
let _fschPending = null;        // What the worker is working on, for saving its answer.
let _fschShownKey = null;       // Which options the page is showing.
let _fschChosen = new Set();    // Friends picked by hand.
let _fschPickTimer = null;

function _fschVal(id) { return document.getElementById(id)?.value; }

function _fschDay(index) { return t(`hub.schedule.day.${index}`, _FSCH_DAYS[index]); }

function _fschLoadPrefs() {
    let prefs = null;
    try { prefs = JSON.parse(localStorage.getItem(_FSCH_PREFS_KEY) || 'null'); } catch { /* start from the defaults */ }
    if (!prefs || typeof prefs !== 'object') return;
    if (Array.isArray(prefs.chosen)) _fschChosen = new Set(prefs.chosen.filter(id => typeof id === 'string'));
    const on = document.getElementById('fschExcludeOn');
    if (on) on.checked = !!prefs.excludeOn;
    const hour = (id, value) => {
        const input = document.getElementById(id);
        if (input && Number.isInteger(value) && value >= 0 && value <= 23) input.value = value;
    };
    hour('fschExcludeFrom', prefs.excludeFrom);
    hour('fschExcludeTo', prefs.excludeTo);
}

function _fschSavePrefs() {
    try {
        localStorage.setItem(_FSCH_PREFS_KEY, JSON.stringify({
            chosen: [..._fschChosen],
            excludeOn: !!document.getElementById('fschExcludeOn')?.checked,
            excludeFrom: Number(_fschVal('fschExcludeFrom')),
            excludeTo: Number(_fschVal('fschExcludeTo')),
        }));
    } catch { /* still works, it just won't be remembered */ }
}

function fschRefresh(force) {
    if (force) _fschForce = true;
    else if (!_fschResult) _fschShowSaved();
    _fschSetStatus(t('hub.schedule.loading', 'Reading your history...'));
    sendToCS({ action: 'hubScheduleData' });
}

function onHubSchedule(payload) {
    if (payload.error) { _fschSetStatus(payload.error, true); return; }
    _fschData = payload;
    fschOptionChanged();
    fschRenderPicker();
}

function fschOptionChanged() {
    _fschSavePrefs();
    const picking = _fschVal('fschScope') === 'selected';
    const picker = document.getElementById('fschPicker');
    if (picker && (picker.style.display === 'none') === picking) {
        picker.style.display = picking ? '' : 'none';
        if (picking) fschRenderPicker();
    }
    if (_fschData) _fschAnalyze();
}

// Everyone who can be picked: friends now, then anyone in the history, with chosen people first.
function _fschPickCandidates() {
    const people = new Map();
    for (const [id, name] of Object.entries(_fschData?.names || {})) people.set(id, { id, name, current: false });
    for (const friend of _fschFriends()) people.set(friend.userId, { id: friend.userId, name: friend.displayName || people.get(friend.userId)?.name || '', current: true });
    for (const id of _fschChosen) if (!people.has(id)) people.set(id, { id, name: '', current: false });
    const rank = person => (_fschChosen.has(person.id) ? 0 : person.current ? 1 : 2);
    return [...people.values()].sort((a, b) => rank(a) - rank(b) || (a.name || a.id).localeCompare(b.name || b.id));
}

function fschRenderPicker() {
    const list = document.getElementById('fschPickList');
    if (!list || document.getElementById('fschPicker')?.style.display === 'none') return;
    const search = (_fschVal('fschPickSearch') || '').trim().toLowerCase();
    const matches = _fschPickCandidates().filter(person => !search || (person.name || person.id).toLowerCase().includes(search));
    const rows = matches.slice(0, _FSCH_MAX_PICK_ROWS).map(person => {
        const label = person.name || person.id;
        const title = person.current ? label : `${label} (${t('hub.schedule.pick_not_friend', 'not a friend now')})`;
        return `<label class="fsch-pick-row${person.current ? '' : ' fsch-pick-former'}" title="${esc(title)}"><input type="checkbox" data-id="${esc(person.id)}"${_fschChosen.has(person.id) ? ' checked' : ''} onchange="fschTogglePick(this)"><span>${esc(label)}</span></label>`;
    });
    const more = matches.length - rows.length;
    list.innerHTML = rows.join('') + (more > 0 ? `<div class="sf-desc">${esc(tf('hub.schedule.pick_more', { count: more }, '{count} more. Search to narrow the list.'))}</div>` : '');
    if (!matches.length) list.innerHTML = `<div class="sf-desc">${esc(t('hub.schedule.pick_empty', 'Nobody matches.'))}</div>`;
    _fschShowPickCount();
}

function _fschShowPickCount() {
    const count = document.getElementById('fschPickCount');
    if (count) count.textContent = tf('hub.schedule.pick_count', { count: _fschChosen.size }, '{count} chosen');
}

function _fschPicksChanged() {
    _fschShowPickCount();
    _fschSavePrefs();
    // Picking several people in a row shouldn't start an analysis for each click.
    clearTimeout(_fschPickTimer);
    _fschPickTimer = setTimeout(() => { if (_fschData) _fschAnalyze(); }, 500);
}

function fschTogglePick(box) {
    if (box.checked) _fschChosen.add(box.dataset.id); else _fschChosen.delete(box.dataset.id);
    _fschPicksChanged();
}

function fschClearPicks() {
    _fschChosen.clear();
    fschRenderPicker();
    _fschPicksChanged();
}

function _fschSetStatus(text, problem) {
    const status = document.getElementById('fschStatus');
    if (!status) return;
    status.textContent = text || '';
    status.style.color = problem ? 'var(--err)' : '';
}

function _fschFriends() {
    const live = typeof vrcFriendsData !== 'undefined' ? vrcFriendsData : [];
    return live.map(friend => ({ userId: friend.id, displayName: friend.displayName || '' }));
}

function _fschOptions() {
    const friends = _fschFriends();
    const favorites = typeof favFriendsData !== 'undefined' ? favFriendsData.map(friend => friend.id || friend.userId).filter(Boolean) : [];
    const from = Number(_fschVal('fschExcludeFrom')), to = Number(_fschVal('fschExcludeTo'));
    const scope = _fschVal('fschScope');
    // The engine reads equal hours as the whole day, which would leave nothing to show.
    const leaveOut = !!document.getElementById('fschExcludeOn')?.checked && from !== to;
    return {
        rangeDays: Number(_fschVal('fschRange')),
        resolutionMinutes: Number(_fschVal('fschResolution')),
        probabilityThreshold: Number(_fschVal('fschThreshold')) || 20,
        scope,
        timezone: (_fschVal('fschTimezone') || '').trim() || 'system',
        includeSelf: !!document.getElementById('fschOnlySelf')?.checked,
        // Only what changes the answer, because these also decide which saved result applies.
        excludeHours: leaveOut ? { enabled: true, startHour: from, endHour: to } : { enabled: false },
        selectedFriendIds: scope === 'selected' ? [..._fschChosen].sort() : [],
        currentFriendIds: friends.map(friend => friend.userId),
        favoriteFriendIds: favorites,
    };
}

function _fschPayload(options) {
    const names = _fschData.names || {};
    const toEvents = (rows, on, off) => (rows || []).map((row, index) => ({
        id: index + 1,
        createdAt: row[0],
        type: row[1] ? on : off,
        userId: row[2],
        displayName: names[row[2]] || '',
    }));
    return {
        nowMs: Date.now(),
        presenceEvents: toEvents(_fschData.presence, 'Online', 'Offline'),
        friendHistory: toEvents(_fschData.relationships, 'Friend', 'Unfriend'),
        currentFriends: _fschFriends(),
        selfActivityRows: (_fschData.self || []).map(row => ({ createdAt: row[0], time: row[1] })),
        options,
    };
}

// Saved results, so coming back to the page or to earlier options doesn't wait for the engine again.
// A saved result is used as it is for a short while. After that it shows at once and gets replaced.
const _FSCH_SAVED_FRESH_MS = 15 * 60 * 1000;
const _FSCH_SAVED_KEEP = 6;
const _fschSaved = new Map();
let _fschSavedDb = null;

function _fschHash(ids) {
    let hash = 0x811c9dc5;
    const text = [...ids].sort().join(',');
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return `${ids.length}:${(hash >>> 0).toString(36)}`;
}

function _fschSavedKey(options) {
    const { currentFriendIds, favoriteFriendIds, ...rest } = options;
    return JSON.stringify([FriendScheduleEngine.FRIEND_SCHEDULE_CACHE_VERSION, rest, _fschHash(currentFriendIds), _fschHash(favoriteFriendIds)]);
}

function _fschOpenSaved() {
    if (!_fschSavedDb) {
        _fschSavedDb = new Promise((done, fail) => {
            const request = indexedDB.open('fschSaved', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('results', { keyPath: 'key' }).createIndex('at', 'at');
            request.onsuccess = () => done(request.result);
            request.onerror = () => fail(request.error);
        }).catch(() => null);
    }
    return _fschSavedDb;
}

async function _fschReadSaved(key) {
    const held = _fschSaved.get(key);
    if (held) return held;
    try {
        const db = await _fschOpenSaved();
        if (!db) return null;
        const entry = await new Promise((done, fail) => {
            const request = db.transaction('results').objectStore('results').get(key);
            request.onsuccess = () => done(request.result);
            request.onerror = () => fail(request.error);
        });
        return Array.isArray(entry?.result?.cells) ? entry : null;
    } catch { return null; }
}

async function _fschSave(entry) {
    _fschSaved.delete(entry.key);
    _fschSaved.set(entry.key, entry);
    while (_fschSaved.size > _FSCH_SAVED_KEEP) _fschSaved.delete(_fschSaved.keys().next().value);
    try {
        const db = await _fschOpenSaved();
        if (!db) return;
        const store = db.transaction('results', 'readwrite').objectStore('results');
        store.put(entry);
        // Oldest first, so whatever is past the limit goes.
        const keys = store.index('at').getAllKeys();
        keys.onsuccess = () => keys.result.slice(0, Math.max(0, keys.result.length - _FSCH_SAVED_KEEP)).forEach(key => store.delete(key));
    } catch { /* not saved, it gets worked out again next time */ }
}

function _fschRowCounts() {
    return { presence: _fschData?.presence?.length || 0, relationships: _fschData?.relationships?.length || 0 };
}

// New friend traffic trickles in all the time and barely moves the answer. An import doesn't trickle.
function _fschSavedIsFresh(entry) {
    const counts = _fschRowCounts();
    return Date.now() - entry.at < _FSCH_SAVED_FRESH_MS
        && entry.relationships === counts.relationships
        && Math.abs(entry.presence - counts.presence) <= 20 + counts.presence / 100;
}

function _fschPresent(key, result) {
    const sameView = key === _fschShownKey;
    _fschShownKey = key;
    _fschShow(result, sameView);
}

// The page's first look: a saved answer, while the history is still on its way.
async function _fschShowSaved() {
    const seq = _fschSeq;
    const key = _fschSavedKey(_fschOptions());
    const entry = await _fschReadSaved(key);
    if (entry && seq === _fschSeq && !_fschResult) _fschPresent(key, entry.result);
}

function _fschGetWorker() {
    if (_fschWorker) return _fschWorker;
    _fschWorker = new Worker('modules/tools/friend-schedule/engine.js');
    _fschWorker.onmessage = event => {
        if (event.data.seq !== _fschSeq) return;   // A newer request has replaced this one.
        if (event.data.error) { _fschSetStatus(event.data.error, true); return; }
        _fschFinish(event.data.result);
    };
    _fschWorker.onerror = () => {
        _fschWorker?.terminate();
        _fschWorker = null;
        _fschSetStatus(t('hub.schedule.failed', 'The analysis stopped. Refresh to try again.'), true);
    };
    return _fschWorker;
}

async function _fschAnalyze() {
    const force = _fschForce;
    _fschForce = false;
    const seq = ++_fschSeq;
    const options = _fschOptions();
    const key = _fschSavedKey(options);
    const entry = force ? null : await _fschReadSaved(key);
    if (seq !== _fschSeq) return;   // The options changed again while reading.
    if (entry) {
        _fschPresent(key, entry.result);
        if (_fschSavedIsFresh(entry)) {
            _fschSaveStatus(entry);
            return;
        }
        _fschSetStatus(t('hub.schedule.updating', 'Updating this saved result...'));
    } else {
        _fschSetStatus(t('hub.schedule.working', 'Working it out...'));
    }
    _fschPending = { key, ..._fschRowCounts() };
    const payload = _fschPayload(options);
    try {
        _fschGetWorker().postMessage({ seq, payload });
    } catch {
        // Worse on a long history, but a page without workers still gets an answer.
        try { _fschFinish(FriendScheduleEngine.buildFriendSchedule(payload)); }
        catch (error) { _fschSetStatus(String(error?.message || error), true); }
    }
}

function _fschFinish(result) {
    const pending = _fschPending;
    _fschPending = null;
    if (pending) {
        _fschPresent(pending.key, result);
        _fschSave({ ...pending, at: Date.now(), result });
    } else {
        _fschShow(result);
    }
}

function _fschSaveStatus(entry) {
    if (_fschVal('fschScope') === 'selected' && !_fschChosen.size) return;
    if (!(_fschResult?.cells || []).some(cell => cell.sampleCount > 0)) return;   // The empty message says more.
    const minutes = Math.floor((Date.now() - entry.at) / 60000);
    _fschSetStatus(minutes < 1
        ? t('hub.schedule.saved_now', 'Saved just now. Refresh to work it out again.')
        : tf('hub.schedule.saved_ago', { minutes }, 'Saved {minutes} min ago. Refresh to work it out again.'));
}

function _fschShow(result, keepSelection) {
    _fschResult = result;
    if (!keepSelection) _fschSelected = null;
    fschRender();
    fschRenderPlanner();
    _fschRenderDetail();
    const hasData = (result.cells || []).some(cell => cell.sampleCount > 0);
    if (_fschVal('fschScope') === 'selected' && !_fschChosen.size)
        _fschSetStatus(t('hub.schedule.pick_none', 'Choose at least one friend below.'));
    else
        _fschSetStatus(hasData ? '' : t('hub.schedule.no_data', 'Nothing to show yet. HapsHub records this while running, and importing from VRCX in Settings adds your older history.'));
}

function _fschTimeLabel(minutes) {
    const hour = String(Math.floor(minutes / 60) % 24).padStart(2, '0');
    return `${hour}:${String(minutes % 60).padStart(2, '0')}`;
}

function _fschNumber(value) {
    return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}

function _fschValue(cell, metric) {
    return Number(cell[metric]) || 0;
}

function _fschSyncViewLabel() {
    const label = document.querySelector('#fschViewBtn span');
    if (label) label.textContent = _fschView === 'heatmap' ? t('hub.schedule.graph', 'Graph') : t('hub.schedule.heatmap', 'Heatmap');
}

function fschToggleView() {
    _fschView = _fschView === 'heatmap' ? 'graph' : 'heatmap';
    _fschSyncViewLabel();
    fschRender();
}

function fschRender() {
    if (!_fschResult) return;
    _fschRenderSummary();
    if (_fschView === 'heatmap') _fschRenderHeatmap(); else _fschRenderGraph();
}

function _fschRenderSummary() {
    const box = document.getElementById('fschSummary');
    if (!box) return;
    const summary = _fschResult.summary || {};
    const peak = summary.peakCell;
    const live = typeof vrcFriendsData !== 'undefined'
        ? vrcFriendsData.filter(friend => friend.presence === 'game' || (friend.location && friend.location !== 'offline' && friend.presence !== 'web')).length
        : null;
    const stat = (value, label, title) => `<div title="${esc(title || '')}"><div class="fsch-stat-val">${esc(String(value))}</div><div class="fsch-stat-label">${esc(label)}</div></div>`;
    box.innerHTML = [
        live === null ? '' : stat(live, t('hub.schedule.now', 'Online now')),
        stat(`${summary.representedFriends || 0} / ${summary.selectedFriends || 0}`, t('hub.schedule.represented', 'Friends with history'),
            t('hub.schedule.represented_tip', 'Friends in this view who were seen online at least once in the range.')),
        stat(`${Math.round(summary.coveragePercent || 0)}%`, t('hub.schedule.coverage', 'Time recorded'),
            t('hub.schedule.coverage_tip', 'Long quiet gaps count as not recorded instead of zero friends online.')),
        stat(summary.recordingGaps || 0, t('hub.schedule.gaps', 'Recording gaps')),
        stat(summary.coveredWeeks || 0, t('hub.schedule.weeks', 'Weeks covered')),
        peak ? stat(`${_fschDay(peak.dayIndex)} ${_fschTimeLabel(peak.startMinutes)}`, t('hub.schedule.peak', 'Busiest time')) : '',
    ].join('');
}

function _fschRenderHeatmap() {
    const chart = document.getElementById('fschChart');
    if (!chart) return;
    const metric = _fschVal('fschMetric') || 'average';
    const slots = _fschResult.slotsPerDay;
    const cells = _fschResult.cells || [];
    const top = Math.max(1, ...cells.filter(cell => !cell.excluded).map(cell => _fschValue(cell, metric)));
    const everyHours = _fschResult.resolutionMinutes === 60 ? 2 : 3;
    const slotsPerLabel = (everyHours * 60) / _fschResult.resolutionMinutes;

    let html = `<div class="fsch-heat" style="grid-template-columns:44px repeat(${slots}, minmax(0, 1fr));"><div></div>`;
    for (let slot = 0; slot < slots; slot += slotsPerLabel)
        html += `<div class="fsch-hour" style="grid-column:span ${slotsPerLabel};">${_fschTimeLabel(slot * _fschResult.resolutionMinutes)}</div>`;
    for (let day = 0; day < 7; day++) {
        html += `<div class="fsch-day">${esc(_fschDay(day))}</div>`;
        for (let slot = 0; slot < slots; slot++) {
            const index = day * slots + slot;
            const cell = cells[index];
            if (cell?.excluded) {
                html += `<div class="fsch-cell fsch-empty fsch-excluded" title="${esc(t('hub.schedule.excluded', 'Left out'))}"></div>`;
                continue;
            }
            if (!cell || !cell.sampleCount) {
                html += `<div class="fsch-cell fsch-empty"></div>`;
                continue;
            }
            const value = _fschValue(cell, metric);
            const opacity = (0.08 + 0.92 * (value / top)).toFixed(3);
            const label = `${_fschDay(day)} ${_fschTimeLabel(cell.startMinutes)}: ${_fschNumber(value)}${metric === 'probability' ? '%' : ''}`;
            html += `<button class="fsch-cell${_fschSelected === index ? ' fsch-selected' : ''}" style="opacity:${opacity}" title="${esc(label)}" aria-label="${esc(label)}" onclick="fschSelectCell(${index})"></button>`;
        }
    }
    chart.innerHTML = `${html}</div>`;
}

function _fschRenderGraph() {
    const chart = document.getElementById('fschChart');
    if (!chart) return;
    const metric = _fschVal('fschMetric') || 'average';
    const cells = _fschResult.cells || [];
    const width = 1000, height = 240, left = 34, bottom = 22;
    const top = Math.max(1, ...cells.filter(cell => !cell.excluded).map(cell => _fschValue(cell, metric)));
    const x = index => left + (index / Math.max(1, cells.length - 1)) * (width - left - 4);
    const y = value => (height - bottom) - (value / top) * (height - bottom - 8);

    let line = '', pen = false;
    cells.forEach((cell, index) => {
        if (cell.excluded || !cell.sampleCount) { pen = false; return; }
        line += `${pen ? 'L' : 'M'}${x(index).toFixed(1)} ${y(_fschValue(cell, metric)).toFixed(1)} `;
        pen = true;
    });
    let days = '';
    for (let day = 0; day < 7; day++) {
        const position = x(day * _fschResult.slotsPerDay);
        days += `<line x1="${position}" x2="${position}" y1="4" y2="${height - bottom}" stroke="var(--tx3)" stroke-opacity=".25"/>`
            + `<text x="${position + 4}" y="${height - 7}" fill="var(--tx2)" font-size="12">${esc(_fschDay(day))}</text>`;
    }
    chart.innerHTML = `<svg class="fsch-graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(t('hub.schedule.graph_label', 'Friends online across the week'))}">
        ${days}
        <text x="2" y="16" fill="var(--tx2)" font-size="12">${esc(_fschNumber(top))}</text>
        <text x="2" y="${height - bottom}" fill="var(--tx2)" font-size="12">0</text>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>`;
}

function fschSelectCell(index) {
    _fschSelected = index;
    if (_fschView === 'heatmap') _fschRenderHeatmap();
    _fschRenderDetail();
}

function _fschRenderDetail() {
    const box = document.getElementById('fschDetail');
    const title = document.getElementById('fschDetailTitle');
    if (!box) return;
    const cell = _fschSelected === null ? null : _fschResult?.cells?.[_fschSelected];
    if (!cell) {
        if (title) title.textContent = t('hub.schedule.selected', 'Selected period');
        box.textContent = t('hub.schedule.select_hint', 'Select a period in the chart to see who is usually online.');
        return;
    }
    if (title) title.textContent = `${_fschDay(cell.dayIndex)} ${_fschTimeLabel(cell.startMinutes)}`;
    const people = [...(_fschResult.contributorsByCell?.[_fschSelected] || [])].sort((a, b) => b.probability - a.probability).slice(0, 40);
    const stats = t('hub.schedule.cell_stats', 'Average {average}, median {median}, most {maximum}, from {samples} periods.')
        .replace('{average}', _fschNumber(cell.average)).replace('{median}', _fschNumber(cell.median))
        .replace('{maximum}', _fschNumber(cell.maximum)).replace('{samples}', cell.sampleCount);
    const rows = people.map(person => {
        const trend = person.trend ? t(`hub.schedule.trend.${person.trend}`, person.trend === 'limited' ? 'not enough data' : person.trend) : '';
        return `<div class="fsch-person"><span>${esc(person.displayName || person.userId || '')}</span>
            <span title="${esc(t('hub.schedule.person_tip', 'Periods this friend was online, out of the periods they could be counted in.'))}">${Math.round(person.probability)}% (${person.observedPeriods}/${person.eligiblePeriods}) ${esc(trend)}</span></div>`;
    }).join('');
    box.innerHTML = `<div style="margin-bottom:6px;">${esc(stats)}</div>${rows || esc(t('hub.schedule.no_people', 'Nobody was seen online in this period.'))}`;
}

function fschRenderPlanner() {
    const box = document.getElementById('fschPlanner');
    if (!box || !_fschResult) return;
    const blocks = FriendScheduleEngine.rankBestRecurringBlocks(_fschResult.cells || [], _fschResult.resolutionMinutes, {
        durationHours: Number(_fschVal('fschMeetHours')) || 3,
    }).slice(0, _FSCH_MAX_PLANNER);
    if (!blocks.length) { box.textContent = t('hub.schedule.no_blocks', 'Not enough history to suggest a time yet.'); return; }
    box.innerHTML = blocks.map(block => {
        const first = block.recurringIndexes?.[0] ?? '';
        const when = tf('hub.schedule.block_time', { day: _fschDay(block.dayIndex), from: _fschTimeLabel(block.startMinutes), to: _fschTimeLabel(block.endMinutes) }, '{day} {from} to {to}');
        return `<button class="fsch-meet" onclick="fschSelectCell(${first})"><strong>${esc(when)}</strong>
            ${esc((block.coveredWeeks === 1 ? t('hub.schedule.block_stats_one', 'about {average} online, 1 week of history') : t('hub.schedule.block_stats', 'about {average} online, {weeks} weeks of history')).replace('{average}', _fschNumber(block.average)).replace('{weeks}', block.coveredWeeks))}</button>`;
    }).join('');
}

// Load when the tab first shows, and when it's opened again.
(function _fschWatchTab() {
    const tab = document.getElementById('tab30');
    if (!tab) { setTimeout(_fschWatchTab, 1000); return; }
    let wasVisible = false;
    let prefsLoaded = false;
    new IntersectionObserver(entries => {
        const visible = entries.some(entry => entry.isIntersecting);
        if (visible && !wasVisible && document.getElementById('fschChart')) {
            if (!prefsLoaded) { prefsLoaded = true; _fschLoadPrefs(); }
            fschRefresh();
        }
        wasVisible = visible;
    }).observe(tab);
})();

// The page's own text is drawn from data, so a language switch has to draw it again.
document.documentElement.addEventListener('languagechange', () => {
    _fschSyncViewLabel();
    fschRenderPicker();
    if (!_fschResult) return;
    fschRender();
    fschRenderPlanner();
    _fschRenderDetail();
});
