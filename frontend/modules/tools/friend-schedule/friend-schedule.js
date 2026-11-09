// Friend Schedule: when friends are usually online, worked out from local history only.
// The analysis is the same engine as the VRCX version, in engine.js.

const _FSCH_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _FSCH_MAX_PLANNER = 5;

let _fschData = null;           // The raw rows from the app.
let _fschResult = null;         // The engine's latest answer.
let _fschSelected = null;       // The selected cell's index.
let _fschView = 'heatmap';
let _fschWorker = null;
let _fschSeq = 0;

function _fschVal(id) { return document.getElementById(id)?.value; }

function fschRefresh() {
    _fschSetStatus(t('hub.schedule.loading', 'Reading your history...'));
    sendToCS({ action: 'hubScheduleData' });
}

function onHubSchedule(payload) {
    if (payload.error) { _fschSetStatus(payload.error, true); return; }
    _fschData = payload;
    fschOptionChanged();
}

function fschOptionChanged() {
    if (_fschData) _fschAnalyze();
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

function _fschPayload() {
    const names = _fschData.names || {};
    const toEvents = (rows, on, off) => (rows || []).map((row, index) => ({
        id: index + 1,
        createdAt: row[0],
        type: row[1] ? on : off,
        userId: row[2],
        displayName: names[row[2]] || '',
    }));
    const friends = _fschFriends();
    const favorites = typeof favFriendsData !== 'undefined' ? favFriendsData.map(friend => friend.id || friend.userId).filter(Boolean) : [];
    return {
        nowMs: Date.now(),
        presenceEvents: toEvents(_fschData.presence, 'Online', 'Offline'),
        friendHistory: toEvents(_fschData.relationships, 'Friend', 'Unfriend'),
        currentFriends: friends,
        selfActivityRows: (_fschData.self || []).map(row => ({ createdAt: row[0], time: row[1] })),
        options: {
            rangeDays: Number(_fschVal('fschRange')),
            resolutionMinutes: Number(_fschVal('fschResolution')),
            probabilityThreshold: Number(_fschVal('fschThreshold')) || 20,
            scope: _fschVal('fschScope'),
            timezone: (_fschVal('fschTimezone') || '').trim() || 'system',
            includeSelf: !!document.getElementById('fschOnlySelf')?.checked,
            currentFriendIds: friends.map(friend => friend.userId),
            favoriteFriendIds: favorites,
        },
    };
}

function _fschGetWorker() {
    if (_fschWorker) return _fschWorker;
    _fschWorker = new Worker('modules/tools/friend-schedule/engine.js');
    _fschWorker.onmessage = event => {
        if (event.data.seq !== _fschSeq) return;   // A newer request has replaced this one.
        if (event.data.error) { _fschSetStatus(event.data.error, true); return; }
        _fschShow(event.data.result);
    };
    _fschWorker.onerror = () => {
        _fschWorker?.terminate();
        _fschWorker = null;
        _fschSetStatus(t('hub.schedule.failed', 'The analysis stopped. Refresh to try again.'), true);
    };
    return _fschWorker;
}

function _fschAnalyze() {
    _fschSetStatus(t('hub.schedule.working', 'Working it out...'));
    const seq = ++_fschSeq;
    const payload = _fschPayload();
    try {
        _fschGetWorker().postMessage({ seq, payload });
    } catch {
        // Worse on a long history, but a page without workers still gets an answer.
        _fschShow(FriendScheduleEngine.buildFriendSchedule(payload));
    }
}

function _fschShow(result) {
    _fschResult = result;
    _fschSelected = null;
    fschRender();
    fschRenderPlanner();
    _fschRenderDetail();
    const hasData = (result.cells || []).some(cell => cell.sampleCount > 0);
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

function fschToggleView() {
    _fschView = _fschView === 'heatmap' ? 'graph' : 'heatmap';
    const label = document.querySelector('#fschViewBtn span');
    if (label) label.textContent = _fschView === 'heatmap' ? t('hub.schedule.graph', 'Graph') : t('hub.schedule.heatmap', 'Heatmap');
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
        peak ? stat(`${_FSCH_DAYS[peak.dayIndex]} ${_fschTimeLabel(peak.startMinutes)}`, t('hub.schedule.peak', 'Busiest time')) : '',
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
        html += `<div class="fsch-day">${esc(t(`hub.schedule.day.${day}`, _FSCH_DAYS[day]))}</div>`;
        for (let slot = 0; slot < slots; slot++) {
            const index = day * slots + slot;
            const cell = cells[index];
            if (!cell || cell.excluded || !cell.sampleCount) {
                html += `<div class="fsch-cell fsch-empty"></div>`;
                continue;
            }
            const value = _fschValue(cell, metric);
            const opacity = (0.08 + 0.92 * (value / top)).toFixed(3);
            const label = `${_FSCH_DAYS[day]} ${_fschTimeLabel(cell.startMinutes)}: ${_fschNumber(value)}${metric === 'probability' ? '%' : ''}`;
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
    const top = Math.max(1, ...cells.map(cell => _fschValue(cell, metric)));
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
            + `<text x="${position + 4}" y="${height - 7}" fill="var(--tx2)" font-size="12">${esc(_FSCH_DAYS[day])}</text>`;
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
    if (title) title.textContent = `${_FSCH_DAYS[cell.dayIndex]} ${_fschTimeLabel(cell.startMinutes)}`;
    const people = [...(_fschResult.contributorsByCell?.[_fschSelected] || [])].sort((a, b) => b.probability - a.probability).slice(0, 40);
    const stats = t('hub.schedule.cell_stats', 'Average {average}, median {median}, most {maximum}, from {samples} periods.')
        .replace('{average}', _fschNumber(cell.average)).replace('{median}', _fschNumber(cell.median))
        .replace('{maximum}', _fschNumber(cell.maximum)).replace('{samples}', cell.sampleCount);
    const rows = people.map(person => {
        const trend = person.trend === 'limited' ? t('hub.schedule.trend_limited', 'not enough data') : (person.trend || '');
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
        return `<button class="fsch-meet" onclick="fschSelectCell(${first})"><strong>${esc(_FSCH_DAYS[block.dayIndex])} ${_fschTimeLabel(block.startMinutes)} to ${_fschTimeLabel(block.endMinutes)}</strong>
            ${esc(t('hub.schedule.block_stats', 'about {average} online, {weeks} weeks of history').replace('{average}', _fschNumber(block.average)).replace('{weeks}', block.coveredWeeks))}</button>`;
    }).join('');
}

// Load when the tab first shows, and when it's opened again.
(function _fschWatchTab() {
    const tab = document.getElementById('tab30');
    if (!tab) { setTimeout(_fschWatchTab, 1000); return; }
    let wasVisible = false;
    new IntersectionObserver(entries => {
        const visible = entries.some(entry => entry.isIntersecting);
        if (visible && !wasVisible && document.getElementById('fschChart')) fschRefresh();
        wasVisible = visible;
    }).observe(tab);
})();
