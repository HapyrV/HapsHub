// Smooth scrolling and Performance mode.
//
// Scrolling: a scroll area that isn't on its own GPU layer is redrawn on every frame it moves, which halved the
// frame rate of Settings. The main areas get the hint in hub.css; any other area is given it the first time the
// wheel turns over it. The listener is passive, so it never holds up the scroll itself.
//
// Performance mode: one switch for slower PCs. Each thing it turns off can be kept on. Blur and animations go
// through the existing switches' functions, so turning the mode off again brings back exactly what was chosen there.

(function () {
    const promoted = new WeakSet();
    // Boxes found not to scroll aren't measured again for a few seconds: measuring can make the page lay itself out.
    const plain = new WeakMap();
    const canScroll = node => {
        const style = getComputedStyle(node);
        return (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1)
            || (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1);
    };
    document.addEventListener('wheel', event => {
        for (let node = event.target; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
            if (promoted.has(node)) return;
            const now = performance.now();
            if (now - (plain.get(node) || -1e9) < 5000) continue;
            if (!canScroll(node)) { plain.set(node, now); continue; }
            promoted.add(node);
            if (!node.style.willChange) node.style.willChange = 'scroll-position';
            return;
        }
    }, { passive: true, capture: true });
})();

let _hubPerf = { on: false, blur: false, animations: false, pictures: false, glass: false, polling: false };
let _hubPerfModules = null;

const _HUB_PERF_CUTS = [
    ['blur', 'hub.perf.cut_blur', 'No blur behind menus and cards'],
    ['animations', 'hub.perf.cut_animations', 'No animations'],
    ['pictures', 'hub.perf.cut_pictures', 'No profile pictures in the Mutual Network'],
    ['glass', 'hub.perf.cut_glass', 'No fade effect while scrolling the dashboard'],
    ['polling', 'hub.perf.cut_polling', 'Check app pages less often'],
];

// The existing Blur and Animations switches keep their own saved value; Performance mode only overrides it while on.
if (typeof applyBlurSetting === 'function') {
    const blur = applyBlurSetting;
    applyBlurSetting = enabled => blur(enabled && !_hubPerf.blur);
}
if (typeof applyAnimationsSetting === 'function') {
    const animations = applyAnimationsSetting;
    applyAnimationsSetting = enabled => animations(enabled && !_hubPerf.animations);
}

function hubPerfApply(modules) {
    _hubPerfModules = modules;
    const get = key => _hubSetting(modules, 'hub.performance', key);
    const on = get('mode') === 'true';
    const cut = key => on && get('cut_' + key) !== 'false';
    const before = JSON.stringify(_hubPerf);
    _hubPerf = { on, blur: cut('blur'), animations: cut('animations'), pictures: cut('pictures'), glass: cut('glass'), polling: cut('polling') };
    const root = document.documentElement.classList;
    root.toggle('hub-perf', on);
    root.toggle('hub-perf-pictures', _hubPerf.pictures);
    root.toggle('hub-perf-glass', _hubPerf.glass);
    root.toggle('hub-perf-polling', _hubPerf.polling);
    if (JSON.stringify(_hubPerf) !== before) {
        applyBlurSetting(document.getElementById('setPerfBlur')?.checked ?? true);
        applyAnimationsSetting(document.getElementById('setPerfAnimations')?.checked ?? true);
        // The dashboard's fade reads the class on its next scroll; this puts it right straight away.
        document.documentElement.dispatchEvent(new Event('themechange'));
    }
    _hubPerfDraw();
}

function _hubPerfDraw() {
    const modules = _hubPerfModules;
    if (!modules) return;
    const get = key => _hubSetting(modules, 'hub.performance', key);
    const mode = document.getElementById('hubPerfMode');
    if (mode) mode.checked = _hubPerf.on;
    const cuts = document.getElementById('hubPerfCuts');
    if (cuts) {
        cuts.classList.toggle('is-off', !_hubPerf.on);
        cuts.innerHTML = _HUB_PERF_CUTS.map(([key, i18n, fallback]) => `
            <div class="sf-toggle-row">
                <div>${esc(t(i18n, fallback))}</div>
                <label class="toggle"><input type="checkbox" data-cut="${key}" ${get('cut_' + key) !== 'false' ? 'checked' : ''} ${_hubPerf.on ? '' : 'disabled'} onchange="hubPerfSet('cut_${key}', this.checked)"><div class="toggle-track"><div class="toggle-knob"></div></div></label>
            </div>`).join('');
    }
    const system = document.getElementById('hubPerfSystem');
    const info = window.hubSystemInfo;
    if (system && info) {
        system.textContent = tf(info.weak ? 'hub.perf.system_weak' : 'hub.perf.system_ok',
            { threads: info.threads, memory: Math.round(info.memoryGb) },
            info.weak ? 'This PC: {threads} threads, {memory} GB of memory. Performance mode is recommended.' : 'This PC: {threads} threads, {memory} GB of memory. It shouldn\'t need Performance mode.');
    }
}

function hubPerfSet(key, on) {
    sendToCS({ action: 'hubSetSetting', module: 'hub.performance', key, value: on ? 'true' : 'false' });
}

document.documentElement.addEventListener('languagechange', _hubPerfDraw);
