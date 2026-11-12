// OVR Advanced Settings: its movement settings. The app reads and writes OVRAS's settings file; this only draws it.

const _ovr = { fields: {}, running: false, found: true, loaded: false };

function _ovrDrawValue(key, value) {
    const out = document.querySelector(`[data-ovr-value="${key}"]`);
    if (out) out.textContent = `${Number(value)}${out.dataset.unit || ''}`;
}

function onHubOvrasState(payload) {
    _ovr.running = !!payload.running;
    _ovr.found = !!payload.found;
    for (const field of payload.fields || []) _ovr.fields[field.key] = field;
    _ovr.loaded = true;

    for (const input of document.querySelectorAll('[data-ovr]')) {
        const key = input.dataset.ovr;
        const field = _ovr.fields[key];
        const value = payload.values ? payload.values[key] : undefined;
        if (!field || value === undefined || document.activeElement === input) continue;
        input.disabled = false;
        if (input.type === 'checkbox') {
            input.checked = !!value;
        } else {
            // Range first, then the value: a slider clamps its value to whatever range it has at that moment.
            input.min = field.min;
            input.max = field.max;
            input.step = field.step;
            input.value = value;
            _ovrDrawValue(key, value);
        }
    }
    for (const card of document.querySelectorAll('#tab35 .ovr-card')) card.classList.toggle('ovr-locked', _ovr.running);

    const status = document.getElementById('ovrStatus');
    if (!status) return;
    let text = '';
    let problem = false;
    if (_ovr.running) {
        text = t('hub.ovras.running', 'OVR Advanced Settings is running. Close it to change these; it would overwrite them when it closes.');
        problem = true;
    } else if (payload.result === 'write') {
        text = t('hub.ovras.write_failed', "Couldn't save OVR Advanced Settings' file.");
        problem = true;
    } else if (!_ovr.found) {
        text = t('hub.ovras.not_found', "OVR Advanced Settings' file wasn't found. Start it once, then come back.");
    } else if (payload.result === 'saved') {
        text = t('hub.ovras.saved', 'Saved. OVR Advanced Settings uses this the next time it starts.');
    }
    status.textContent = text;
    status.classList.toggle('ovr-problem', problem);
}

function _ovrSave(input) {
    const key = input.dataset.ovr;
    const field = _ovr.fields[key];
    // Before the file's values and ranges arrive, a slider has the browser's own 0-100 range: never save that.
    if (!_ovr.loaded || !field || _ovr.running) return;
    let value = input.type === 'checkbox' ? input.checked : Number(input.value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return;
        value = Math.min(field.max, Math.max(field.min, value));
    }
    sendToCS({ action: 'hubOvrasSave', values: { [key]: value } });
}

document.addEventListener('input', e => {
    const input = e.target.closest && e.target.closest('[data-ovr]');
    if (input && input.type === 'range') _ovrDrawValue(input.dataset.ovr, input.value);
});
document.addEventListener('change', e => {
    const input = e.target.closest && e.target.closest('[data-ovr]');
    if (input) _ovrSave(input);
});

/* --- Asks for the state whenever the page comes into view, since unused tabs are unloaded --- */

/* Sliders stay off until the file's ranges arrive (the tab's HTML is reloaded when it comes back into view). */
function _ovrLockUntilLoaded() {
    _ovr.loaded = false;
    for (const input of document.querySelectorAll('[data-ovr]')) input.disabled = true;
}

(function _ovrWatchTab() {
    const tab = document.getElementById('tab35');
    if (!tab) { setTimeout(_ovrWatchTab, 1000); return; }
    new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { _ovrLockUntilLoaded(); sendToCS({ action: 'hubOvrasState' }); }
    }).observe(tab);
})();
