/* === Importing a ban list, and blocked groups === */

// One import at a time. The state stays here so a redrawn group window picks it back up.
let _gbi = { groupId: '', stage: 'closed', text: '', preview: null, progress: null, result: null };

function _gbiCurrentGroup() {
    return window._currentGroupDetail?.id || '';
}

function _buildBanImport() {
    return `<div id="gdBanImport" style="margin-bottom:12px;">${_gbiHtml()}</div>`;
}

function _gbiRender() {
    const box = document.getElementById('gdBanImport');
    if (box) box.innerHTML = _gbiHtml();
}

function _gbiNote(text, color) {
    return `<div style="font-size:calc(12px + var(--fs-off, 0px));color:${color || 'var(--tx2)'};line-height:1.5;margin:8px 0;">${esc(text)}</div>`;
}

function _gbiHtml() {
    const running = _gbi.stage === 'running';
    if (_gbi.groupId && _gbi.groupId !== _gbiCurrentGroup() && running) {
        return _gbiNote(t('hub.groups.ban_running_elsewhere', 'A ban import is running on another group.'));
    }
    const stage = _gbi.groupId === _gbiCurrentGroup() ? _gbi.stage : 'closed';
    switch (stage) {
        case 'open': return _gbiOpenHtml();
        case 'checking': return _gbiNote(t('hub.groups.ban_checking', 'Checking the list and looking up names...'));
        case 'preview': return _gbiPreviewHtml();
        case 'running': return _gbiRunningHtml();
        case 'done': return _gbiDoneHtml();
    }
    return `<button class="vrcn-button" id="gbiOpen" onclick="gbiOpen()"><span class="msi" style="font-size:16px;">upload</span> ${esc(t('hub.groups.ban_import', 'Import bans'))}</button>`;
}

function _gbiOpenHtml() {
    return `${_gbiNote(t('hub.groups.ban_help', 'Paste user IDs (usr_...) from any list or export. Everything else in the text is ignored, and nobody is banned until you confirm.'))}
        <textarea id="gbiText" class="myp-textarea" rows="5" style="width:100%;box-sizing:border-box;resize:vertical;font-family:monospace;" placeholder="usr_00000000-0000-0000-0000-000000000000" oninput="_gbi.text=this.value">${esc(_gbi.text)}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="vrcn-button" id="gbiCheck" onclick="gbiCheck()"><span class="msi" style="font-size:16px;">search</span> ${esc(t('hub.groups.ban_check', 'Check list'))}</button>
            <button class="vrcn-button" onclick="gbiClose()"><span class="msi" style="font-size:16px;">close</span> ${esc(t('common.close', 'Close'))}</button>
        </div>`;
}

function _gbiPreviewHtml() {
    const p = _gbi.preview || {};
    const people = p.people || [];
    const skipped = [];
    if (p.alreadyBanned) skipped.push(tf('hub.groups.ban_skip_already', { count: p.alreadyBanned }, '{count} already banned'));
    if (p.skippedSelf) skipped.push(t('hub.groups.ban_skip_self', 'you'));
    if (p.overLimit) skipped.push(tf('hub.groups.ban_skip_over', { count: p.overLimit }, '{count} over the limit of 500 for one run'));
    const rows = people.map(person => `<div class="gbi-person" style="display:flex;gap:10px;align-items:baseline;padding:3px 0;font-size:calc(12px + var(--fs-off, 0px));">
            <span style="color:var(--tx0);">${esc(person.name || t('hub.groups.ban_unknown_name', 'Name not found'))}</span>
            <span style="color:var(--tx3);font-family:monospace;font-size:calc(11px + var(--fs-off, 0px));">${esc(person.id)}</span>
        </div>`).join('');
    const banButton = people.length
        ? `<button class="vrcn-button vrcn-btn-danger" id="gbiBan" onclick="gbiConfirm()"><span class="msi" style="font-size:16px;">gavel</span> ${esc(tf('hub.groups.ban_people', { count: people.length }, 'Ban {count}'))}</button>`
        : '';
    return `${_gbiNote(people.length
            ? tf('hub.groups.ban_ready', { count: people.length }, 'People to ban: {count}')
            : t('hub.groups.ban_nobody', 'Nobody on this list needs banning.'))}
        ${skipped.length ? _gbiNote(tf('hub.groups.ban_skipped', { list: skipped.join(', ') }, 'Left out: {list}.')) : ''}
        ${rows ? `<div style="max-height:220px;overflow:auto;margin-bottom:8px;">${rows}</div>` : ''}
        <div style="display:flex;gap:8px;">
            ${banButton}
            <button class="vrcn-button" onclick="gbiBack()"><span class="msi" style="font-size:16px;">arrow_back</span> ${esc(t('hub.groups.back', 'Back'))}</button>
        </div>`;
}

function _gbiRunningHtml() {
    const progress = _gbi.progress || { done: 0, total: 0 };
    const label = _gbi.undoing ? 'hub.groups.ban_undo_progress' : 'hub.groups.ban_progress';
    const fallback = _gbi.undoing ? 'Undoing: {done} of {total}' : 'Banning: {done} of {total}';
    return `${_gbiNote(tf(label, { done: progress.done, total: progress.total }, fallback))}
        <button class="vrcn-button" id="gbiStop" onclick="sendToCS({action:'hubGroupBanCancel'})"><span class="msi" style="font-size:16px;">close</span> ${esc(t('hub.groups.ban_stop', 'Stop'))}</button>`;
}

function _gbiStopReason(stopped) {
    switch (stopped) {
        case 'cancelled': return t('hub.groups.ban_stopped_cancelled', 'You stopped it.');
        case 'rate_limited': return t('hub.groups.ban_stopped_limited', 'VRChat asked to slow down. Wait a while, then import the same list again: anyone already banned is left out.');
        case 'signed_out': return t('hub.groups.ban_stopped_signed_out', 'You are signed out.');
        case 'failures': return t('hub.groups.ban_stopped_failures', 'Stopped after several failures in a row. Check that you still have permission to ban in this group.');
    }
    return '';
}

function _gbiDoneHtml() {
    const r = _gbi.result || {};
    const failed = r.failed || [];
    const summary = tf(r.undo ? 'hub.groups.ban_undo_done' : 'hub.groups.ban_done', { done: r.done || 0 }, r.undo ? 'Unbanned: {done}.' : 'Banned: {done}.');
    return `${_gbiNote(summary)}
        ${failed.length ? _gbiNote(tf('hub.groups.ban_failed', { count: failed.length, list: failed.join(', ') }, '{count} failed: {list}'), 'var(--err)') : ''}
        ${r.notTried ? _gbiNote(tf('hub.groups.ban_not_tried', { count: r.notTried }, '{count} not tried.')) : ''}
        ${r.stopped ? _gbiNote(_gbiStopReason(r.stopped)) : ''}
        <div style="display:flex;gap:8px;">
            ${!r.undo && r.done > 0 ? `<button class="vrcn-button" id="gbiUndo" onclick="gbiUndo()"><span class="msi" style="font-size:16px;">refresh</span> ${esc(t('hub.groups.ban_undo', 'Undo this import'))}</button>` : ''}
            <button class="vrcn-button" onclick="gbiClose()"><span class="msi" style="font-size:16px;">close</span> ${esc(t('common.close', 'Close'))}</button>
        </div>`;
}

function gbiOpen() {
    _gbi = { groupId: _gbiCurrentGroup(), stage: 'open', text: '', preview: null, progress: null, result: null };
    _gbiRender();
}

function gbiClose() {
    _gbi = { groupId: '', stage: 'closed', text: '', preview: null, progress: null, result: null };
    _gbiRender();
}

function gbiBack() {
    _gbi.stage = 'open';
    _gbiRender();
}

function gbiCheck() {
    if (!_gbi.text.trim()) return;
    _gbi.stage = 'checking';
    _gbiRender();
    sendToCS({ action: 'hubGroupBanPreview', groupId: _gbi.groupId, text: _gbi.text });
}

function onHubGroupBanPreview(payload) {
    if (payload.groupId !== _gbi.groupId || _gbi.stage !== 'checking') return;
    if (!payload.ok) {
        _gbi.stage = 'open';
        _gbiRender();
        showToast(false, t('hub.groups.ban_check_failed', 'The list could not be checked.'));
        return;
    }
    _gbi.preview = payload;
    _gbi.stage = 'preview';
    _gbiRender();
}

function gbiConfirm() {
    const people = _gbi.preview?.people || [];
    if (!people.length) return;
    const groupName = window._currentGroupDetailFull?.name || '';
    vrcnConfirmDelete({
        title: t('hub.groups.ban_import', 'Import bans'),
        icon: 'gavel',
        message: tf('hub.groups.ban_confirm', { count: people.length, name: groupName }, 'Ban {count} from {name}? This is real and happens right away.'),
        confirmLabel: tf('hub.groups.ban_people', { count: people.length }, 'Ban {count}'),
        onConfirm: () => {
            _gbi.stage = 'running';
            _gbi.undoing = false;
            _gbi.progress = { done: 0, total: people.length };
            _gbiRender();
            sendToCS({ action: 'hubGroupBanRun', groupId: _gbi.groupId });
        },
    });
}

function gbiUndo() {
    const done = _gbi.result?.done || 0;
    _gbi.stage = 'running';
    _gbi.undoing = true;
    _gbi.progress = { done: 0, total: done };
    _gbiRender();
    sendToCS({ action: 'hubGroupBanUndo', groupId: _gbi.groupId });
}

function onHubGroupBanProgress(payload) {
    if (payload.groupId !== _gbi.groupId) return;
    _gbi.progress = { done: payload.done, total: payload.total };
    _gbiRender();
}

function onHubGroupBanDone(payload) {
    if (payload.groupId !== _gbi.groupId) return;
    _gbi.stage = 'done';
    _gbi.result = payload;
    _gbiRender();
    if (_gbi.groupId === _gbiCurrentGroup()) loadGroupBans();
}

// --- Blocked groups ---

function _groupBlockStatus(g) {
    const raw = (g.id && _gdRawJsonCache[g.id]) || {};
    return g.membershipStatus || raw.membershipStatus || raw.myMember?.membershipStatus || '';
}

function confirmBlockGroup(groupId, groupName) {
    vrcnConfirmDelete({
        title: t('hub.groups.block', 'Block group'),
        icon: 'block',
        message: tf('hub.groups.block_confirm', { name: groupName }, 'Block {name}? It can no longer invite you. You can undo this under Groups, Blocked groups.'),
        confirmLabel: t('hub.groups.block', 'Block group'),
        onConfirm: () => sendToCS({ action: 'hubBlockGroup', groupId }),
    });
}

function openBlockedGroups() {
    document.getElementById('blockedGroupsModal')?.remove();
    const o = document.createElement('div');
    o.className = 'modal-overlay';
    o.style.display = 'flex'; // inline display required by _closeTopModal (Escape)
    o.id = 'blockedGroupsModal';
    o.style.zIndex = '10003';
    o.onclick = e => { if (e.target === o) o.remove(); };
    o.innerHTML = `<div class="modal-box" style="max-width:520px;width:90%;">
        ${renderModalBar(t('hub.groups.blocked', 'Blocked groups'), [modalCloseAction("document.getElementById('blockedGroupsModal').remove()")])}
        <div id="blockedGroupsList" style="padding:12px 16px;max-height:60vh;overflow:auto;text-align:left;">${_gbiNote(t('common.loading', 'Loading...'))}</div>
    </div>`;
    document.body.appendChild(o);
    sendToCS({ action: 'hubBlockedGroups' });
}

function onHubBlockedGroups(payload) {
    const list = document.getElementById('blockedGroupsList');
    if (!list) return;
    if (!payload.ok) {
        list.innerHTML = _gbiNote(t('hub.groups.blocked_failed', 'The list could not be loaded. Are you signed in?'), 'var(--err)');
        return;
    }
    if (!payload.groups.length) {
        list.innerHTML = _gbiNote(t('hub.groups.blocked_none', 'You have not blocked any groups.'));
        return;
    }
    list.innerHTML = payload.groups.map(g => {
        const code = g.shortCode ? `${g.shortCode}.${g.discriminator}` : '';
        const icon = g.iconUrl ? `<img src="${esc(g.iconUrl)}" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover;flex-shrink:0;">` : '';
        return `<div class="blocked-group-row" style="display:flex;align-items:center;gap:10px;padding:6px 0;">
            ${icon}
            <div style="flex:1;min-width:0;cursor:pointer;" onclick="document.getElementById('blockedGroupsModal')?.remove();navOpenModal('group','${jsq(g.id)}','${jsq(g.name)}')">
                <div style="color:var(--tx0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(g.name)}</div>
                <div style="color:var(--tx3);font-size:calc(11px + var(--fs-off, 0px));">${esc(code)}</div>
            </div>
            <button class="vrcn-button" onclick="sendToCS({action:'hubUnblockGroup',groupId:'${jsq(g.id)}'})">${esc(t('hub.groups.unblock', 'Unblock'))}</button>
        </div>`;
    }).join('');
}

function onHubGroupBlocked(payload) {
    const name = payload.blocked ? 'hub.groups.block' : 'hub.groups.unblock';
    if (payload.success) {
        showToast(true, payload.blocked ? t('hub.groups.blocked_ok', 'Group blocked.') : t('hub.groups.unblocked_ok', 'Group unblocked.'));
        if (document.getElementById('blockedGroupsList')) sendToCS({ action: 'hubBlockedGroups' });
    } else {
        showToast(false, tf('hub.groups.block_failed', { action: t(name, payload.blocked ? 'Block group' : 'Unblock') }, '{action}: VRChat did not accept this.'));
    }
}
