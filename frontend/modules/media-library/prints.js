// VRChat prints (issue 11). VRChat saves every print as an extra 2048x1440 picture (the photo in a white frame with a
// "Captured By" footer) next to the normal photo. This finds those copies, shows them, and moves the ones you pick to
// the Recycle Bin after you confirm. Nothing is ever deleted outright.

const _libPrints = { list: [], picked: new Set(), busy: false };

function libPrintsOpen() {
    document.getElementById('libPrintsModal')?.remove();
    const o = document.createElement('div');
    o.className = 'modal-overlay';
    o.id = 'libPrintsModal';
    o.style.display = 'flex';
    o.onclick = e => { if (e.target === o) o.remove(); };
    o.innerHTML = `<div class="modal-box lib-prints-box">
        ${renderModalBar(t('library.prints.title', 'VRChat prints'), [modalCloseAction(`document.getElementById('libPrintsModal').remove()`)])}
        <div class="lib-prints-intro">${esc(t('library.prints.intro', 'VRChat saves each print twice: the normal photo, and a copy in a white frame with "Captured By" under it. These are the framed copies. The ones you pick go to the Recycle Bin, so you can still restore them.'))}</div>
        <div class="lib-prints-bar">
            <span id="libPrintsStatus" class="lib-prints-status"></span>
            <span style="flex:1"></span>
            <button class="vrcn-button" id="libPrintsAll" onclick="libPrintsPickAll(true)">${esc(t('library.prints.select_all', 'Select all'))}</button>
            <button class="vrcn-button" id="libPrintsNone" onclick="libPrintsPickAll(false)">${esc(t('library.prints.select_none', 'Select none'))}</button>
            <button class="vrcn-button-round vrcn-btn-danger" id="libPrintsGo" onclick="libPrintsConfirm()" disabled></button>
        </div>
        <div id="libPrintsGrid" class="lib-prints-grid"></div>
    </div>`;
    document.body.appendChild(o);
    _libPrints.list = []; _libPrints.picked.clear(); _libPrints.busy = true;
    _libPrintsRender(t('library.prints.searching', 'Looking for prints...'));
    sendToCS({ action: 'findVrcPrints' });
}

function libPrintsFound(payload) {
    _libPrints.busy = false;
    _libPrints.list = Array.isArray(payload?.prints) ? payload.prints : [];
    _libPrints.picked = new Set(_libPrints.list.map(p => p.path));
    _libPrintsRender();
}

function _libPrintsRender(message) {
    const grid = document.getElementById('libPrintsGrid');
    if (!grid) return;
    const status = document.getElementById('libPrintsStatus');
    const go = document.getElementById('libPrintsGo');
    const n = _libPrints.picked.size;
    if (go) {
        go.disabled = _libPrints.busy || n === 0;
        go.innerHTML = `<span class="msi">delete</span> ${esc(tf('library.prints.move', { count: n }, 'Move {count} to the Recycle Bin'))}`;
    }
    if (message) { if (status) status.textContent = message; grid.innerHTML = ''; return; }
    if (!_libPrints.list.length) {
        if (status) status.textContent = '';
        grid.innerHTML = emptyStateHtml('print', t('library.prints.none', 'No VRChat prints found in your picture folders'));
        return;
    }
    if (status) status.textContent = tf('library.prints.count', { count: _libPrints.list.length, picked: n }, '{count} prints found, {picked} selected');
    grid.innerHTML = _libPrints.list.map((p, i) => {
        const on = _libPrints.picked.has(p.path);
        return `<button class="lib-print-card${on ? ' picked' : ''}" onclick="libPrintsToggle(${i})" title="${esc(p.name)}">
            <img loading="lazy" src="${esc(p.url)}" alt="">
            <span class="lib-print-check msi">${on ? 'check_box' : 'check_box_outline_blank'}</span>
            <span class="lib-print-name">${esc(p.name.replace(/^VRChat_/, '').replace(/_2048x1440.*$/, ''))}</span>
        </button>`;
    }).join('');
}

function libPrintsToggle(i) {
    const p = _libPrints.list[i];
    if (!p || _libPrints.busy) return;
    if (_libPrints.picked.has(p.path)) _libPrints.picked.delete(p.path); else _libPrints.picked.add(p.path);
    _libPrintsRender();
}

function libPrintsPickAll(on) {
    if (_libPrints.busy) return;
    _libPrints.picked = on ? new Set(_libPrints.list.map(p => p.path)) : new Set();
    _libPrintsRender();
}

function libPrintsConfirm() {
    const paths = [..._libPrints.picked];
    if (!paths.length || _libPrints.busy) return;
    vnConfirmModal({
        title: t('library.prints.confirm_title', 'Move prints to the Recycle Bin?'),
        message: esc(tf('library.prints.confirm', { count: paths.length }, 'Move {count} framed print copies to the Recycle Bin? The normal photos stay where they are.')),
        icon: 'delete',
        confirmLabel: tf('library.prints.move', { count: paths.length }, 'Move {count} to the Recycle Bin'),
        onConfirm: () => {
            _libPrints.busy = true;
            _libPrintsRender(t('library.prints.moving', 'Moving to the Recycle Bin...'));
            sendToCS({ action: 'recycleVrcPrints', paths });
        },
    });
}

function libPrintsRecycled(payload) {
    _libPrints.busy = false;
    const moved = new Set(payload?.moved || []);
    _libPrints.list = _libPrints.list.filter(p => !moved.has(p.path));
    for (const p of moved) _libPrints.picked.delete(p);
    _libPrintsRender();
    const failed = (payload?.failed || []).length;
    const status = document.getElementById('libPrintsStatus');
    if (status) status.textContent = failed
        ? tf('library.prints.done_some', { moved: moved.size, failed }, 'Moved {moved} to the Recycle Bin; {failed} were left alone (no longer a print, or not in a watched folder).')
        : tf('library.prints.done', { moved: moved.size }, 'Moved {moved} to the Recycle Bin.');
}
