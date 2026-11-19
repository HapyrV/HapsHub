/* === HapsHub: status presets, reading the VRCX archive, and exporting notes. === */

/* --- Status presets: your own list, beside VRChat's short history of recent statuses. --- */

const HUB_STATUS_MAX_TEXT = 32;
const HUB_STATUS_MAX_PRESETS = 12;

function hubStatusPresets() {
    try {
        const saved = JSON.parse(localStorage.getItem('hubStatusPresets') || '[]');
        return Array.isArray(saved) ? saved : [];
    } catch {
        return [];
    }
}

function _hubStatusPresetsSave(list) {
    localStorage.setItem('hubStatusPresets', JSON.stringify(list));
    _hubStatusPresetsRender();
}

function hubStatusPresetAdd(status, text) {
    const clean = (text || '').trim().slice(0, HUB_STATUS_MAX_TEXT);
    const list = hubStatusPresets();
    if (list.some(p => p.status === status && p.text === clean) || list.length >= HUB_STATUS_MAX_PRESETS) return;
    list.push({ status, text: clean });
    _hubStatusPresetsSave(list);
}

function hubStatusPresetRemove(index) {
    const list = hubStatusPresets();
    list.splice(index, 1);
    _hubStatusPresetsSave(list);
}

function hubStatusPresetApply(index) {
    const preset = hubStatusPresets()[index];
    if (!preset) return;
    selectStatusOption(preset.status);
    const input = document.getElementById('statusDescInput');
    input.value = preset.text;
    setStatusDescMode(true);
    updateStatusDescCount(preset.text.length);
}

function hubStatusPresetSaveCurrent() {
    const input = document.getElementById('statusDescInput');
    const select = document.getElementById('statusDescSelect');
    hubStatusPresetAdd(selectedStatus, input.style.display !== 'none' ? input.value : select.value);
}

function _hubStatusPresetsRender() {
    const options = document.getElementById('statusOptions');
    if (!options) return;
    let box = document.getElementById('hubStatusPresets');
    if (!box) {
        box = document.createElement('div');
        box.id = 'hubStatusPresets';
        box.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;align-items:center;';
        options.after(box);
    }
    const colors = Object.fromEntries((typeof STATUS_LIST !== 'undefined' ? STATUS_LIST : []).map(s => [s.key, s.color]));
    box.innerHTML = hubStatusPresets().map((preset, index) => `<span style="display:inline-flex;align-items:center;gap:2px;">
            <button class="vrcn-button" onclick="hubStatusPresetApply(${index})"><span class="status-option-dot" style="background:${esc(colors[preset.status] || 'var(--tx3)')};"></span> ${esc(preset.text || t('profiles.status.no_message', 'No status message'))}</button>
            <button class="vrcn-button" title="${esc(t('common.delete', 'Delete'))}" onclick="hubStatusPresetRemove(${index})"><span class="msi" style="font-size:14px;">close</span></button>
        </span>`).join('')
        + `<button class="vrcn-button" onclick="hubStatusPresetSaveCurrent()"><span class="msi" style="font-size:14px;">add</span> ${esc(t('hub.status.save_preset', 'Save as preset'))}</button>`;
}

const _hubOpenStatusModalUpstream = openStatusModal;
openStatusModal = function () {
    _hubOpenStatusModalUpstream();
    _hubStatusPresetsRender();
};

/* --- Reading the archive --- */

let _hubBrowse = { table: '', search: '', offset: 0, more: false };

function hubVrcxBrowserTables(tables) {
    const box = document.getElementById('hubVrcxBrowser');
    const select = document.getElementById('hubVrcxBrowseTable');
    if (!box || !select) return;
    box.style.display = tables.length ? '' : 'none';
    if (!tables.length) return;
    const current = select.value;
    // Tables named usr..._feed_gps are per account, so the name alone tells you little.
    select.innerHTML = tables.map(table =>
        `<option value="${esc(table.name)}">${esc(table.name)} (${Number(table.rows).toLocaleString()})</option>`).join('');
    if (tables.some(table => table.name === current)) select.value = current;
    if (!_hubBrowse.table) hubVrcxBrowse(0);
}

function hubVrcxBrowse(offset) {
    const table = document.getElementById('hubVrcxBrowseTable')?.value || '';
    const search = document.getElementById('hubVrcxBrowseSearch')?.value || '';
    _hubBrowse = { ..._hubBrowse, table, search, offset };
    if (table) sendToCS({ action: 'hubVrcxBrowse', table, search, offset });
}

function hubVrcxBrowsePage(direction) {
    hubVrcxBrowse(Math.max(0, _hubBrowse.offset + direction * 50));
}

function _hubBrowseValue(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function onHubVrcxRows(payload) {
    const box = document.getElementById('hubVrcxBrowseRows');
    if (!box || payload.table !== _hubBrowse.table || payload.search !== _hubBrowse.search || payload.offset !== _hubBrowse.offset) return;
    const info = document.getElementById('hubVrcxBrowseInfo');
    if (payload.error) {
        box.textContent = payload.error;
        return;
    }
    const rows = (payload.rows || []).map(text => {
        try { return JSON.parse(text); } catch { return { value: text }; }
    });
    _hubBrowse.more = !!payload.more;
    document.getElementById('hubVrcxBrowsePrev').disabled = payload.offset === 0;
    document.getElementById('hubVrcxBrowseNext').disabled = !payload.more;
    if (info) {
        info.textContent = rows.length
            ? t('hub.vrcx.browse_range', 'Rows {from} to {to}').replace('{from}', (payload.offset + 1).toLocaleString()).replace('{to}', (payload.offset + rows.length).toLocaleString())
            : '';
    }
    if (!rows.length) {
        box.innerHTML = `<div class="set-desc">${esc(t('hub.vrcx.browse_empty', 'Nothing here.'))}</div>`;
        return;
    }
    box.innerHTML = rows.map(row => `<div style="padding:8px 10px;margin-bottom:6px;background:var(--bg-input);border-radius:8px;">${
        Object.entries(row).filter(([, value]) => value !== null && value !== '').map(([key, value]) =>
            `<div style="font-size:calc(12px + var(--fs-off, 0px));overflow-wrap:anywhere;"><span style="color:var(--tx3);">${esc(key)}:</span> ${esc(_hubBrowseValue(value))}</div>`).join('')
    }</div>`).join('');
}

/* --- Exporting notes --- */

function onHubNotesExported(payload) {
    const status = document.getElementById('hubNotesStatus');
    if (!status) return;
    status.style.color = payload.error ? 'var(--err)' : '';
    status.textContent = payload.error || t('hub.notes.done', '{count} notes saved to {path}').replace('{count}', Number(payload.count).toLocaleString()).replace('{path}', payload.path);
}

/* --- From VRCX: a queue you joined for a full instance has a place for you. --- */

// Two short tones, as VRCX plays them. Made on the spot, so there is no sound file to pick or load.
function _hubQueueChime() {
    try {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        [880, 1320].forEach((frequency, i) => {
            const start = ctx.currentTime + i * 0.15;
            const osc = ctx.createOscillator();
            osc.frequency.value = frequency;
            osc.connect(gain);
            gain.gain.setValueAtTime(0.3, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
            osc.start(start);
            osc.stop(start + 0.15);
            if (i === 1) osc.onended = () => ctx.close();
        });
        return true;
    } catch {
        return false;
    }
}

// The message always shows; the chime only with the queue alarm on (the hub flashes the taskbar too).
function hubQueueReady(payload) {
    const location = String(payload?.location || '');
    const world = (typeof worldInfoCache !== 'undefined' && worldInfoCache[location.split(':')[0]]?.name) || '';
    const msg = world
        ? tf('hub.queue.ready_in', { world }, 'Your place in {world} is ready. Join before it runs out.')
        : t('hub.queue.ready', 'Your place in the queue is ready. Join before it runs out.');
    if (typeof showToast === 'function') showToast(true, msg);
    if (typeof addLog === 'function') addLog(msg, 'ok');
    const chimed = !!payload?.alarm && _hubQueueChime();
    window._hubLastQueueReady = { location, world, chimed };
}

/* --- From VRCX: a clock beside friends you invited, or asked for an invite, in the last hour. --- */

const HUB_RECENT_INVITE_MS = 60 * 60 * 1000;
const _HUB_INVITE_ACTIONS = new Set(['vrcInviteFriend', 'vrcInviteFriendWithPhoto', 'vrcRequestInvite', 'vrcRequestInviteWithPhoto', 'vrcBatchInvite']);
const _HUB_RECENT_INVITES_KEY = 'hapshub.recentInvites';
let _hubInviteTimes = null;
let _hubInviteSweep = 0;

function _hubInviteLoad() {
    if (_hubInviteTimes) return _hubInviteTimes;
    try { _hubInviteTimes = JSON.parse(localStorage.getItem(_HUB_RECENT_INVITES_KEY) || '{}') || {}; } catch { _hubInviteTimes = {}; }
    return _hubInviteTimes;
}

function hubRecentInvite(userId) {
    if (!window._hubRecentInvitesOn || !userId) return false;
    const at = _hubInviteLoad()[userId];
    return !!at && Date.now() - at < HUB_RECENT_INVITE_MS;
}

function hubRecentInviteIcon(userId) {
    return hubRecentInvite(userId)
        ? `<span class="msi hub-recent-invite" title="${esc(t('hub.recent_invite', 'You invited them, or asked for an invite, in the last hour'))}">schedule</span>`
        : '';
}

// Called for every message to the hub; only invites are noted. Kept even while the clock is off, so turning it on shows them.
function hubNoteInvite(m) {
    if (!m || !_HUB_INVITE_ACTIONS.has(m.action)) return;
    const ids = Array.isArray(m.userIds) ? m.userIds : (m.userId ? [m.userId] : []);
    if (!ids.length) return;
    const times = _hubInviteLoad(), now = Date.now();
    for (const id of ids) times[id] = now;
    hubRecentInvitesRefresh();
}

// Drops old entries, saves, and puts the clock on or takes it off the friend cards already drawn.
function hubRecentInvitesRefresh() {
    const times = _hubInviteLoad(), now = Date.now();
    for (const [id, at] of Object.entries(times)) if (!at || now - at >= HUB_RECENT_INVITE_MS) delete times[id];
    try { localStorage.setItem(_HUB_RECENT_INVITES_KEY, JSON.stringify(times)); } catch { }
    document.querySelectorAll('.vrc-friend-card[data-uid]').forEach(card => {
        const name = card.querySelector('.vrc-friend-name');
        if (!name) return;
        const icon = name.querySelector('.hub-recent-invite');
        const want = hubRecentInvite(card.dataset.uid);
        if (want && !icon) name.insertAdjacentHTML('afterbegin', hubRecentInviteIcon(card.dataset.uid));
        else if (!want && icon) icon.remove();
    });
    // Look again when the next clock runs out; nothing runs while there are none.
    clearTimeout(_hubInviteSweep);
    const left = window._hubRecentInvitesOn ? Object.values(times).map(at => at + HUB_RECENT_INVITE_MS - now) : [];
    if (left.length) _hubInviteSweep = setTimeout(hubRecentInvitesRefresh, Math.max(1000, Math.min(...left) + 500));
}
