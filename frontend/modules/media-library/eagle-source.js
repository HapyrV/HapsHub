// Media Library's Eagle source: Eagle's folders and pictures, read through Eagle's local API by the app
// (main/HubEagleMessages.cs), not by embedding Eagle's window. Like the Rose Database filter in Avatars, it belongs to
// its plugin: with the Eagle plugin off, the button and the pictures are gone.

const _libEagle = { on: false, folder: '', page: 0, count: 0, more: false, loading: false, running: null };

function libEagleToggle(on = !_libEagle.on) {
    if (on && typeof hubPluginOn === 'function' && !hubPluginOn('eagle')) on = false;
    _libEagle.on = on;
    document.getElementById('tab7')?.classList.toggle('lib-eagle-on', on);
    document.getElementById('libEagleBtn')?.classList.toggle('active', on);
    const area = document.getElementById('libEagleArea');
    if (area) area.hidden = !on;
    if (!on) return;
    sendToCS({ action: 'eagleFolders' });
    libEagleOpenFolder(_libEagle.folder);
}

function libEagleClose() {
    if (_libEagle.on) libEagleToggle(false);
}

function libEagleOpenFolder(folder) {
    Object.assign(_libEagle, { folder: folder || '', page: 0, count: 0, more: false, loading: false });
    const grid = document.getElementById('libEagleGrid');
    if (grid) grid.innerHTML = '';
    _libEagleStatus(t('library.eagle.loading', 'Loading Eagle\'s pictures...'));
    libEagleLoadMore();
}

function libEagleLoadMore() {
    if (_libEagle.loading) return;
    _libEagle.loading = true;
    _libEagleMoreButton();
    sendToCS({ action: 'eagleItems', folder: _libEagle.folder, page: _libEagle.page });
}

function libEagleView(card) {
    if (typeof openLightbox === 'function') openLightbox(card.dataset.url, card.dataset.kind);
}

function onEagleFolders(payload) {
    const pick = document.getElementById('libEagleFolder');
    if (!pick) return;
    const options = [`<option value="">${esc(t('library.eagle.all', 'All pictures'))}</option>`];
    const walk = (folders, depth) => {
        for (const f of folders || []) {
            options.push(`<option value="${esc(f.id)}">${'   '.repeat(depth)}${esc(f.name)}</option>`);
            walk(f.children, depth + 1);
        }
    };
    walk(payload?.folders, 0);
    pick.innerHTML = options.join('');
    pick.value = _libEagle.folder;
    if (pick.value !== _libEagle.folder) pick.value = '';
    pick._vnRefresh?.(); // the app's own dropdown drawn over the select
}

function onEagleItems(payload) {
    // An answer for a folder or page that's no longer the one asked for.
    if ((payload?.folder || '') !== _libEagle.folder || payload.page !== _libEagle.page) return;
    _libEagle.loading = false;
    _libEagle.running = !!payload.running;
    const grid = document.getElementById('libEagleGrid');
    if (!payload.running) {
        if (grid) grid.innerHTML = '';
        _libEagle.count = 0;
        _libEagleStatus(t('library.eagle.closed', 'Eagle isn\'t running. Open Eagle to see its pictures here.'), true);
        _libEagleMoreButton();
        return;
    }
    const items = payload.items || [];
    _libEagle.page++;
    _libEagle.count += items.length;
    _libEagle.more = !!payload.more;
    if (grid) grid.insertAdjacentHTML('beforeend', items.map(item => {
        const kind = /^(mp4|webm|mov|m4v)$/i.test(item.ext) ? 'video' : 'image';
        return `<div class="lib-card lib-eagle-card" data-id="${esc(item.id)}" data-url="${esc(item.url)}" data-kind="${kind}" title="${esc(item.name + (item.ext ? '.' + item.ext : ''))}" onclick="libEagleView(this)">
            <img src="${esc(item.thumb)}" loading="lazy" alt="">
            <div class="lib-eagle-name">${esc(item.name)}</div>
        </div>`;
    }).join(''));
    _libEagleStatus(_libEagle.count ? '' : t('library.eagle.empty', 'No pictures here.'));
    _libEagleMoreButton();
    // A page made only of pictures left out (trash, folders with a password): ask for the next one straight away.
    if (!items.length && _libEagle.more) libEagleLoadMore();
}

function _libEagleStatus(text, retry = false) {
    const el = document.getElementById('libEagleStatus');
    if (!el) return;
    el.hidden = !text;
    el.innerHTML = !text ? '' : `<span>${esc(text)}</span>`
        + (retry ? `<button class="vrcn-button" onclick="libEagleToggle(true)">${esc(t('library.eagle.retry', 'Try again'))}</button>` : '');
}

function _libEagleMoreButton() {
    const button = document.getElementById('libEagleMore');
    if (!button) return;
    button.hidden = !_libEagle.running || !_libEagle.more || !_libEagle.count;
    button.disabled = _libEagle.loading;
}
