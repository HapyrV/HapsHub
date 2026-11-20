// Other apps in a page. Their windows are real windows held in the pane, so this only reports where the pane is,
// and where hub menus cover it: the app's window gets a hole there so the menu shows through.

// VRCT has its own page (modules/tools/vrct): HapsHub runs its engine instead of holding its window.
// Eagle is held in a tab inside Media Library (tab7); its pane only counts as visible while that tab is shown.
const _AEMB_TABS = { oyasumi: 'tab33', eagle: 'tab7', spacecal: 'tab36', ovrtoolkit: 'tab38' };
const _AEMB_APPS = Object.keys(_AEMB_TABS);
const _aemb = { sent: {}, holes: {}, holesKey: {}, selectOpen: false };
let _aembLastChange = 0;
(function _aembWatchChanges() {
    const mark = () => { _aembLastChange = performance.now(); };
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'keydown', 'wheel', 'scroll', 'resize'])
        window.addEventListener(type, mark, { capture: true, passive: true });
    const start = () => new MutationObserver(mark).observe(document.documentElement,
        { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();

function _aembEl(app, part) { return document.getElementById(`aemb-${part}-${app}`); }

// A dropdown's list isn't part of the page, so it can't be found by looking. One counts as open from the click
// that opens it until a choice, Escape, or focus leaving it, and the whole pane opens for it meanwhile.
document.addEventListener('mousedown', event => { _aemb.selectOpen = event.target?.tagName === 'SELECT' && !_aemb.selectOpen; }, true);
document.addEventListener('change', event => { if (event.target?.tagName === 'SELECT') _aemb.selectOpen = false; }, true);
document.addEventListener('focusout', event => { if (event.target?.tagName === 'SELECT') _aemb.selectOpen = false; }, true);
document.addEventListener('keydown', event => {
    if (event.target?.tagName !== 'SELECT') return;
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === 'Tab') _aemb.selectOpen = false;
    else if (event.key === ' ' || (event.altKey && event.key === 'ArrowDown') || event.key === 'F4') _aemb.selectOpen = true;
}, true);

/** The box of what covers the pane at this element: its outermost floating ancestor (a menu, popup or backdrop). */
function _aembCover(element, pane) {
    let cover = element;
    for (let node = element; node && node !== document.body && !node.contains(pane); node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'absolute') cover = node;
    }
    return cover.getBoundingClientRect();
}

/** Holes in pane pixels where something of the page lies over the pane. */
function _aembHoles(pane, rect, scale) {
    if (_aemb.selectOpen) return [{ x: 0, y: 0, w: Math.round(rect.width * scale), h: Math.round(rect.height * scale) }];
    const points = [];
    // Menus drop in from above, so the top edge is checked closely as well as a grid over the rest.
    for (let column = 0; column < 20; column++) points.push([rect.left + (rect.width * (column + 0.5)) / 20, rect.top + 3]);
    const steps = 10;
    for (let row = 0; row < steps; row++)
        for (let column = 0; column < steps; column++)
            points.push([rect.left + (rect.width * (column + 0.5)) / steps, rect.top + (rect.height * (row + 0.5)) / steps]);

    const seen = new Set();
    const holes = [];
    for (const [x, y] of points) {
        const top = document.elementFromPoint(x, y);
        if (!top || pane.contains(top) || seen.has(top)) continue;
        seen.add(top);
        const box = _aembCover(top, pane);
        const left = Math.max(box.left, rect.left), right = Math.min(box.right, rect.right);
        const upper = Math.max(box.top, rect.top), lower = Math.min(box.bottom, rect.bottom);
        if (right <= left || lower <= upper) continue;
        const hole = {
            x: Math.floor((left - rect.left) * scale), y: Math.floor((upper - rect.top) * scale),
            w: Math.ceil((right - left) * scale), h: Math.ceil((lower - upper) * scale),
        };
        if (!holes.some(h => h.x === hole.x && h.y === hole.y && h.w === hole.w && h.h === hole.h)) holes.push(hole);
        if (holes.length >= 16) break;
    }
    return holes;
}

function _aembReport(app) {
    const pane = _aembEl(app, 'pane');
    const rect = pane?.getBoundingClientRect();
    const visible = !!(pane && pane.offsetParent !== null && rect.width > 0 && rect.height > 0 && !document.hidden);
    const scale = window.devicePixelRatio || 1;
    const next = visible
        ? { visible, x: Math.round(rect.left * scale), y: Math.round(rect.top * scale), w: Math.round(rect.width * scale), h: Math.round(rect.height * scale) }
        : { visible: false, x: 0, y: 0, w: 0, h: 0 };
    const key = JSON.stringify(next);
    if (_aemb.sent[app] !== key) {
        // A page that was never opened has nothing to say.
        if (visible || _aemb.sent[app]) sendToCS({ action: 'hubEmbedPane', app, ...next });
        _aemb.sent[app] = key;
    }
    if (!visible) return;

    // Something can only start to cover the pane after the page changes, the pane moves, or you use the mouse or
    // keyboard. Checking 120 points five times a second regardless cost about 3 s in 10 minutes (issue 12). The
    // check keeps running for a short while after each change so menus that slide in are caught at rest.
    if (_aemb.holesKey[app] === key && performance.now() - _aembLastChange > 800) return;
    _aemb.holesKey[app] = key;
    const holes = JSON.stringify(_aembHoles(pane, rect, scale));
    if (holes !== (_aemb.holes[app] || '[]')) {
        _aemb.holes[app] = holes;
        sendToCS({ action: 'hubEmbedHoles', app, holes: JSON.parse(holes) });
    }
}

function onHubEmbedState(payload) {
    const app = payload.app;
    const start = _aembEl(app, 'start');
    const release = _aembEl(app, 'release');
    const test = _aembEl(app, 'test');
    const mode = _aembEl(app, 'mode');
    const status = _aembEl(app, 'status');
    const hint = _aembEl(app, 'hint');
    const results = _aembEl(app, 'results');
    if (!start) return;

    const open = payload.state === 'open';
    const busy = payload.state === 'starting' || payload.testing;
    start.disabled = open || busy || !payload.found;
    release.disabled = !open || busy;
    test.disabled = busy || !payload.found;
    mode.disabled = busy;
    if (document.activeElement !== mode) mode.value = payload.mode;

    let text = payload.message || '';
    if (!payload.found) text = t('hub.embed.not_found', '{app} was not found. Set its path under App embeds in Settings, Hub modules.').replace('{app}', payload.name);
    else if (payload.testing) text = t('hub.embed.testing', 'Testing...');
    else if (payload.state === 'starting') text = t('hub.embed.opening', 'Opening...');
    status.textContent = text;
    status.classList.toggle('aemb-problem', payload.state === 'failed' || !payload.found);
    hint.hidden = open || busy;
    // The test report only takes room from the app while it isn't open.
    _aembEl(app, 'result').textContent = open ? '' : payload.result || '';

    if (payload.checks) {
        results.replaceChildren(...payload.checks.map(check => {
            const row = document.createElement('div');
            row.className = check.passed ? 'aemb-pass' : 'aemb-fail';
            row.textContent = `${check.passed ? '✓' : '✗'} ${check.name}${!check.passed && check.detail ? ` (${check.detail})` : ''}`;
            return row;
        }));
    } else if (open) {
        results.replaceChildren();
    }

    // Linux can't hold another app's window in this page: the app opens in its own window instead.
    if (payload.linux) {
        for (const el of [mode, release, test, hint]) el.hidden = true;
        start.disabled = !payload.found;
    }
}

function aembStart(app) { sendToCS({ action: 'hubEmbedStart', app }); }
function aembRelease(app) { sendToCS({ action: 'hubEmbedRelease', app }); }
function aembTest(app) { sendToCS({ action: 'hubEmbedTest', app }); }
function aembMode(app) { sendToCS({ action: 'hubEmbedMode', app, mode: _aembEl(app, 'mode')?.value || 'child' }); }

/* --- Polls because the pane has many reasons to move or vanish: tabs, the sidebar, window size, unloaded pages --- */

// Only the open page, and a page that was just left (so its app hears it's hidden), is checked. Performance mode checks less often.
function _aembTick() {
    const active = document.querySelector('.tab.active')?.id;
    for (const app of _AEMB_APPS) {
        if (_AEMB_TABS[app] === active || (_aemb.sent[app] || '').includes('"visible":true')) _aembReport(app);
    }
    setTimeout(_aembTick, document.documentElement.classList.contains('hub-perf-polling') ? 600 : 200);
}
setTimeout(_aembTick, 200);

(function _aembWatchTabs() {
    if (!document.getElementById(_AEMB_TABS.oyasumi)) { setTimeout(_aembWatchTabs, 1000); return; }
    for (const app of _AEMB_APPS) {
        const tab = document.getElementById(_AEMB_TABS[app]);
        if (!tab) continue;
        new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) sendToCS({ action: 'hubEmbedState', app });
        }).observe(tab);
    }
})();
