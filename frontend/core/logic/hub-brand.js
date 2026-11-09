// The name the app shows for itself, and the credit to VRCNext.
// The name can be changed in Settings > Appearance. The credit can't be switched off and doesn't change with the name:
// HapsHub is VRCNext's work with additions on top, and its licence asks every fork to say so.

const HUB_DEFAULT_NAME = 'HapsHub';
const HUB_NAME_MAX = 40;
const HUB_VRCNEXT_URL = 'https://github.com/shinyflvre/VRCNext';
const HUB_VRCNEXT_PATREON = 'https://www.patreon.com/cw/Shinyflvres';

let _hubBrandName = HUB_DEFAULT_NAME;

function hubBrandName() { return _hubBrandName; }

function hubBrandClean(name) {
    // One line, nothing invisible, and short enough for a title bar.
    const kept = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, HUB_NAME_MAX).trim();
    return kept || HUB_DEFAULT_NAME;
}

/** Text written for HapsHub, with the chosen name put in. */
function hubBrandText(text) {
    return _hubBrandName === HUB_DEFAULT_NAME || typeof text !== 'string' || !text.includes(HUB_DEFAULT_NAME)
        ? text
        : text.split(HUB_DEFAULT_NAME).join(_hubBrandName);
}

// Every translated string goes through t(), so this one place renames the whole interface.
(function () {
    const translate = t;
    t = function (key, fallback = '') { return hubBrandText(translate(key, fallback)); };
})();

function _hubBrandDraw() {
    document.title = _hubBrandName;
    document.querySelectorAll('.tb-brand, .logo-text').forEach(el => { el.textContent = _hubBrandName; });
    document.querySelectorAll('[data-hub-brand]').forEach(el => { el.textContent = hubBrandText(el.dataset.hubBrand); });
    const input = document.getElementById('hubAppNameInput');
    if (input && document.activeElement !== input) input.value = _hubBrandName === HUB_DEFAULT_NAME ? '' : _hubBrandName;
    const title = document.getElementById('creditPanelTitle');
    if (title) title.textContent = tf('hub.credit.title', { name: _hubBrandName }, '{name} is heavily based on VRCNext');
}

/** Called whenever the hub's settings arrive. Redraws the translated text only when the name really changed. */
function hubBrandApply(name) {
    const next = hubBrandClean(name);
    const changed = next !== _hubBrandName;
    _hubBrandName = next;
    _hubBrandDraw();
    if (changed && typeof applyTranslations === 'function') applyTranslations();
}

function hubBrandSave(value) {
    const name = hubBrandClean(value);
    sendToCS({ action: 'hubSetSetting', module: 'hub.ui', key: 'app_name', value: name === HUB_DEFAULT_NAME ? '' : name });
}

function hubBrandReset() {
    const input = document.getElementById('hubAppNameInput');
    if (input) input.value = '';
    hubBrandSave('');
}

// ---- The credit: a pill in the top bar that opens a small panel with ways to support VRCNext ----

let _hubCreditOpen = false;
let _hubCreditDismiss = null;

function hubCreditToggle() {
    const panel = document.getElementById('creditPanel');
    const pill = document.getElementById('tbCredit');
    if (!panel) return;
    _hubCreditOpen = !_hubCreditOpen;
    if (_hubCreditOpen) {
        _hubBrandDraw();
        panel.style.display = '';
        if (pill) {
            // Under the pill, kept inside the window.
            const box = pill.getBoundingClientRect();
            const width = Math.min(380, window.innerWidth - 16);
            panel.style.width = width + 'px';
            panel.style.right = 'auto';
            panel.style.left = Math.max(8, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - 8)) + 'px';
        }
        requestAnimationFrame(() => panel.classList.add('panel-open'));
        setTimeout(() => {
            _hubCreditDismiss = event => {
                if (!panel.contains(event.target) && !event.target.closest('#tbCredit')) hubCreditToggle();
            };
            document.addEventListener('click', _hubCreditDismiss);
        }, 0);
    } else {
        panel.classList.remove('panel-open');
        panel.style.display = 'none';
        if (_hubCreditDismiss) document.removeEventListener('click', _hubCreditDismiss);
        _hubCreditDismiss = null;
    }
}

function hubCreditOpenLink(which) {
    sendToCS({ action: 'openUrl', url: which === 'patreon' ? HUB_VRCNEXT_PATREON : HUB_VRCNEXT_URL });
}

document.documentElement.addEventListener('languagechange', _hubBrandDraw);
_hubBrandDraw();
