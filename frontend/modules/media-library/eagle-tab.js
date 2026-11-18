// Media Library's Eagle tab: Eagle's own window, held in the tab the way OyasumiVR is held in its page
// (modules/tools/app-embed/app-embed.js reports where the pane is). With the Eagle plugin off, the tab is gone.

let _libSource = 'library';

function libShowSource(source) {
    if (source === 'eagle' && typeof hubPluginOn === 'function' && !hubPluginOn('eagle')) source = 'library';
    _libSource = source;
    const eagle = source === 'eagle';
    document.getElementById('tab7')?.classList.toggle('lib-eagle-on', eagle);
    for (const [id, on] of [['libTabLibrary', !eagle], ['libTabEagle', eagle]]) {
        const tab = document.getElementById(id);
        if (!tab) continue;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
    }
    const view = document.getElementById('libEagleView');
    if (view) view.hidden = !eagle;
    if (eagle) sendToCS({ action: 'hubEmbedState', app: 'eagle' });
    try { localStorage.setItem('libSource', source); } catch { /* storage off */ }
}

function libEagleClose() {
    if (_libSource === 'eagle') libShowSource('library');
}

// Comes back on the tab it was left on.
(function _libRestoreSource() {
    if (!document.getElementById('libTabEagle')) { setTimeout(_libRestoreSource, 500); return; }
    let saved = 'library';
    try { saved = localStorage.getItem('libSource') || 'library'; } catch { /* storage off */ }
    if (saved === 'eagle') libShowSource('eagle');
})();
