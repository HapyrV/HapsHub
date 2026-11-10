// A tidier Settings page: the explanation under each setting folds away behind a small (i) button next to its
// name, rows get a clear line between them, and spacing is the same everywhere. "Show all details" at the top of
// the settings list opens every explanation, and so does searching. Warnings and status lines stay visible.

const _HUB_TIDY_KEY = 'hapshub.settings.details';
let _hubTidyQueued = 0;

function _hubTidyKeep(desc) {
    // Status lines, warnings and anything coloured or named are information, not explanation.
    return !!(desc.id || desc.style.color || desc.classList.contains('hub-forwarding-note') || desc.closest('#hubPluginList, .hub-plugin-row, #hubPerfCuts, .exe-list, #welcomeList'));
}

function _hubTidyButton(desc) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hub-more';
    button.title = t('hub.tidy.more', 'More info');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span class="msi">info</span>';
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const open = !desc.classList.contains('hub-desc-open');
        desc.classList.toggle('hub-desc-open', open);
        button.setAttribute('aria-expanded', String(open));
    });
    return button;
}

function hubTidySettings() {
    const root = document.querySelector('#tab9 .settings-content');
    if (!root) return;
    for (const desc of root.querySelectorAll('.vrcn-panel-card .set-desc, .vrcn-panel-card .sf-desc')) {
        if (desc.dataset.hubTidy || _hubTidyKeep(desc) || !desc.textContent.trim()) continue;
        desc.dataset.hubTidy = '1';
        const before = desc.previousElementSibling;
        const wrap = desc.parentElement;
        if (before?.classList.contains('sf-toggle-row')) {
            // Explanation under a row: the button goes right after the row's name.
            const label = before.firstElementChild;
            if (!label || before.querySelector(':scope > .hub-more')) { desc.dataset.hubTidy = 'skip'; continue; }
            desc.classList.add('hub-desc-collapsed');
            label.insertAdjacentElement('afterend', _hubTidyButton(desc));
        } else if (wrap?.parentElement?.classList.contains('sf-toggle-row') && before && wrap.firstElementChild === before) {
            // Name and explanation stacked inside the row.
            desc.classList.add('hub-desc-collapsed');
            wrap.classList.add('hub-label-wrap');
            before.insertAdjacentElement('afterend', _hubTidyButton(desc));
        } else if (before?.classList.contains('vrcn-panel-card-header') && desc.textContent.trim().length > 110) {
            // A long introduction to a whole card folds behind a button in its header.
            desc.classList.add('hub-desc-collapsed');
            before.appendChild(_hubTidyButton(desc));
        } else {
            desc.dataset.hubTidy = 'skip';
        }
    }
}

function _hubTidySoon() {
    if (_hubTidyQueued) return;
    _hubTidyQueued = requestAnimationFrame(() => { _hubTidyQueued = 0; hubTidySettings(); });
}

function hubTidyShowAll(on) {
    document.getElementById('tab9')?.classList.toggle('hub-show-details', !!on);
    try { localStorage.setItem(_HUB_TIDY_KEY, on ? '1' : '0'); } catch { /* blocked */ }
}

(function () {
    const start = () => {
        const tab = document.getElementById('tab9');
        const content = tab?.querySelector('.settings-content');
        const nav = tab?.querySelector('.settings-nav .settings-search');
        if (!content || !nav) { setTimeout(start, 500); return; }
        // The "Show all details" switch sits under the settings search.
        if (!document.getElementById('hubTidyAll')) {
            const row = document.createElement('label');
            row.className = 'hub-tidy-all';
            row.innerHTML = `<input type="checkbox" id="hubTidyAll"><span data-i18n="hub.tidy.show_all">${esc(t('hub.tidy.show_all', 'Show all details'))}</span>`;
            nav.insertAdjacentElement('afterend', row);
            const box = row.querySelector('input');
            box.checked = localStorage.getItem(_HUB_TIDY_KEY) === '1';
            box.addEventListener('change', () => hubTidyShowAll(box.checked));
            hubTidyShowAll(box.checked);
        }
        // Searching shows every explanation, since the match may be in one.
        const search = document.getElementById('settingsSearchInput');
        search?.addEventListener('input', () => tab.classList.toggle('hub-searching', !!search.value.trim()));
        // Cards fill in as settings arrive; only changes inside Settings, and only while it's open, are looked at.
        new MutationObserver(() => { if (tab.classList.contains('active')) _hubTidySoon(); }).observe(content, { childList: true, subtree: true });
        hubTidySettings();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    document.documentElement.addEventListener('languagechange', () => {
        document.querySelectorAll('#tab9 .hub-more').forEach(b => { b.title = t('hub.tidy.more', 'More info'); });
    });
})();
