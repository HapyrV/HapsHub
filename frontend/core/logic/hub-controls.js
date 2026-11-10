// Controls that look the same everywhere, and a Settings sidebar you can resize.

// Every <select> gets the themed dropdown, including the ones drawn after startup (plugin options, hub module rows,
// HapsHub's own pages). Without this they show as a white Windows box in the system font.
(function () {
    let queued = false;
    const upgrade = () => {
        queued = false;
        if (typeof initVnSelect !== 'function') return;
        for (const el of [...document.getElementsByTagName('select')]) if (!el._vnSelect && !el.hasAttribute('data-no-vn')) initVnSelect(el);
    };
    const watch = () => {
        upgrade();
        new MutationObserver(records => {
            if (queued) return;
            for (const r of records) for (const n of r.addedNodes) {
                if (n.nodeType === 1 && (n.tagName === 'SELECT' || n.getElementsByTagName('select').length)) {
                    queued = true;
                    requestAnimationFrame(upgrade);
                    return;
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();

// The Settings sidebar: drag its right edge to make it wider or narrower. The width is remembered.
(function () {
    const KEY = 'hapshub.settingsNavWidth';
    const MIN = 160, MAX = 360;
    const apply = width => document.documentElement.style.setProperty('--settings-nav-w', Math.max(MIN, Math.min(MAX, width)) + 'px');
    const saved = Number(localStorage.getItem(KEY));
    if (saved) apply(saved);
    const attach = () => {
        const nav = document.querySelector('#tab9 .settings-nav');
        if (!nav || nav.querySelector('.settings-nav-resizer')) return !!nav;
        const grip = document.createElement('div');
        grip.className = 'settings-nav-resizer';
        grip.title = typeof t === 'function' ? t('hub.settings.resize_nav', 'Drag to resize') : 'Drag to resize';
        grip.addEventListener('pointerdown', e => {
            e.preventDefault();
            grip.setPointerCapture(e.pointerId);
            const left = nav.getBoundingClientRect().left;
            document.body.classList.add('hub-resizing');
            const move = ev => apply(ev.clientX - left);
            const up = () => {
                grip.removeEventListener('pointermove', move);
                document.body.classList.remove('hub-resizing');
                try { localStorage.setItem(KEY, String(Math.round(nav.getBoundingClientRect().width))); } catch { /* full */ }
            };
            grip.addEventListener('pointermove', move);
            grip.addEventListener('pointerup', up, { once: true });
            grip.addEventListener('pointercancel', up, { once: true });
        });
        grip.addEventListener('dblclick', () => { apply(190); try { localStorage.removeItem(KEY); } catch { } });
        nav.appendChild(grip);
        return true;
    };
    let tries = 0;
    const retry = () => { if (!attach() && ++tries < 40) setTimeout(retry, 500); };
    retry();
})();
