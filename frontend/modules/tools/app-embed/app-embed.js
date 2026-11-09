// OyasumiVR and Eagle in a page. Their windows are real windows sitting over the pane, so this only
// reports where the pane is, and swaps in a picture while a hub menu needs to open over it.

const _aemb = { sent: {}, frozen: {}, covered: {} };
const _AEMB_APPS = ['oyasumi', 'eagle'];

function _aembEl(app, part) { return document.getElementById(`aemb-${part}-${app}`); }

function _aembCovered(pane, rect) {
    const steps = 6;
    for (let row = 0; row < steps; row++) {
        for (let column = 0; column < steps; column++) {
            const x = rect.left + (rect.width * (column + 0.5)) / steps;
            const y = rect.top + (rect.height * (row + 0.5)) / steps;
            const top = document.elementFromPoint(x, y);
            if (top && !pane.contains(top)) return true;
        }
    }
    return false;
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

    const covered = _aembCovered(pane, rect);
    if (covered !== !!_aemb.covered[app]) {
        _aemb.covered[app] = covered;
        if (covered) sendToCS({ action: 'hubEmbedFreeze', app });
        else {
            sendToCS({ action: 'hubEmbedUnfreeze', app });
            pane.style.backgroundImage = '';
        }
    }
}

function onHubEmbedFrozen(payload) {
    const pane = _aembEl(payload.app, 'pane');
    if (pane && _aemb.covered[payload.app] && payload.image) pane.style.backgroundImage = `url("${payload.image}")`;
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
    _aembEl(app, 'result').textContent = payload.result || '';

    if (payload.checks) {
        results.replaceChildren(...payload.checks.map(check => {
            const row = document.createElement('div');
            row.className = check.passed ? 'aemb-pass' : 'aemb-fail';
            row.textContent = `${check.passed ? '✓' : '✗'} ${check.name}${!check.passed && check.detail ? ` (${check.detail})` : ''}`;
            return row;
        }));
    }
}

function aembStart(app) { sendToCS({ action: 'hubEmbedStart', app }); }
function aembRelease(app) { sendToCS({ action: 'hubEmbedRelease', app }); }
function aembTest(app) { sendToCS({ action: 'hubEmbedTest', app }); }
function aembMode(app) { sendToCS({ action: 'hubEmbedMode', app, mode: _aembEl(app, 'mode')?.value || 'child' }); }

/* --- Polls because the pane has many reasons to move or vanish: tabs, the sidebar, window size, unloaded pages --- */

setInterval(() => _AEMB_APPS.forEach(_aembReport), 200);

(function _aembWatchTabs() {
    const tabs = { oyasumi: 'tab33', eagle: 'tab34' };
    if (!document.getElementById(tabs.oyasumi)) { setTimeout(_aembWatchTabs, 1000); return; }
    for (const app of _AEMB_APPS) {
        new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) sendToCS({ action: 'hubEmbedState', app });
        }).observe(document.getElementById(tabs[app]));
    }
})();
