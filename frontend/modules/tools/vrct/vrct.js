// VRCT page: HapsHub runs VRCT's engine (no VRCT window) and this page is its window.
// Everything goes through hubVrctSend to the engine; its answers and events come back as hubVrct messages.

const _vrct = { state: 'off', ready: false, data: {}, on: {}, log: [], autoTried: false, found: true, windowOpen: false };

const _VRCT_SWITCHES = [
    ['translation', 'hub.vrct.sw_translation', 'Translate'],
    ['transcription_send', 'hub.vrct.sw_send', 'Turn what I say into chatbox messages'],
    ['transcription_receive', 'hub.vrct.sw_receive', 'Show what others say, translated'],
    ['send_message_to_vrc', 'hub.vrct.sw_to_vrc', 'Send to the VRChat chatbox'],
    ['send_only_translated_messages', 'hub.vrct.sw_only_translated', 'Send only the translation'],
    ['overlay_small_log', 'hub.vrct.sw_overlay', 'Show messages in VR'],
];

// The four pairs asked for, one click each.
const _VRCT_PAIRS = [['Hebrew', 'English'], ['English', 'Hebrew'], ['English', 'Japanese'], ['Hebrew', 'Japanese']];
const _VRCT_PREFERRED_COUNTRY = { English: 'United States', Hebrew: 'Israel', Japanese: 'Japan' };

function _vrctEl(id) { return document.getElementById(id); }

function vrctSend(endpoint, data) {
    sendToCS(data === undefined ? { action: 'hubVrctSend', endpoint } : { action: 'hubVrctSend', endpoint, data });
}

function vrctStart() { sendToCS({ action: 'hubVrctStart' }); _vrct.state = 'starting'; _vrctDraw(); }
function vrctStop() { sendToCS({ action: 'hubVrctStop' }); }

function vrctSetAuto(on) {
    sendToCS({ action: 'hubSetSetting', module: 'hub.vrct', key: 'auto_start', value: on ? 'true' : 'false' });
}

function vrctOnModules(modules) {
    const auto = modules.find(m => m.id === 'hub.vrct')?.settings?.find(s => s.key === 'auto_start')?.value === 'true';
    const box = _vrctEl('vrctAuto');
    if (box) box.checked = auto;
    if (auto && !_vrct.autoTried && (typeof hubPluginOn !== 'function' || hubPluginOn('vrct'))) {
        _vrct.autoTried = true;
        sendToCS({ action: 'hubVrctStart' });
    }
}

// ---- Languages ----

function _vrctTab() { return String(_vrct.data.selected_tab_no || '1'); }

function _vrctLanguages() { return Array.isArray(_vrct.data.selectable_language_list) ? _vrct.data.selectable_language_list : []; }

function _vrctFind(language) {
    const list = _vrctLanguages();
    return list.find(l => l.language === language && l.country === _VRCT_PREFERRED_COUNTRY[language]) || list.find(l => l.language === language);
}

function _vrctCurrent(kind) {
    const all = _vrct.data[kind === 'your' ? 'selected_your_languages' : 'selected_target_languages'];
    return all?.[_vrctTab()]?.['1'] || null;
}

function vrctSetLanguage(kind, value) {
    const [language, country] = String(value).split('|');
    const key = kind === 'your' ? 'selected_your_languages' : 'selected_target_languages';
    const all = JSON.parse(JSON.stringify(_vrct.data[key] || {}));
    const tab = _vrctTab();
    all[tab] = all[tab] || {};
    all[tab]['1'] = { language, country, enable: true };
    // One translation at a time: the other target slots are switched off.
    if (kind === 'target') for (const slot of ['2', '3']) if (all[tab][slot]) all[tab][slot].enable = false;
    _vrct.data[key] = all;
    vrctSend('/set/data/' + key, all);
    _vrctDraw();
}

function vrctPair(from, to) {
    const a = _vrctFind(from), b = _vrctFind(to);
    if (!a || !b) return;
    vrctSetLanguage('your', `${a.language}|${a.country}`);
    vrctSetLanguage('target', `${b.language}|${b.country}`);
    // Picking a pair means wanting it translated.
    if (!_vrct.on.translation) vrctToggle('translation', true);
}

function vrctSetEngine(engine) {
    const all = JSON.parse(JSON.stringify(_vrct.data.selected_translation_engines || {}));
    all[_vrctTab()] = engine;
    _vrct.data.selected_translation_engines = all;
    vrctSend('/set/data/selected_translation_engines', all);
}

// ---- Switches and messages ----

function vrctToggle(key, on) {
    _vrct.on[key] = on;
    vrctSend(`/set/${on ? 'enable' : 'disable'}/${key}`);
    _vrctDraw();
}

function vrctSendTyped() {
    const input = _vrctEl('vrctInput');
    const text = (input?.value || '').trim();
    if (!text || !_vrct.ready) return;
    input.value = '';
    vrctSend('/run/send_message_box', { id: String(Date.now()), message: text });
}

function _vrctLog(kind, result) {
    const original = result?.original?.message ?? (typeof result?.message === 'string' ? result.message : '');
    if (!original) return;
    const translations = (result?.translations || []).map(t => t?.message).filter(Boolean);
    _vrct.log.push({ kind, original, translations, at: Date.now() });
    if (_vrct.log.length > 200) _vrct.log.shift();
    _vrctDrawLog();
}

function _vrctDrawLog() {
    const box = _vrctEl('vrctLog');
    if (!box) return;
    if (!_vrct.log.length) return;
    const who = { mine: t('hub.vrct.you_said', 'You said'), typed: t('hub.vrct.you_typed', 'You typed'), theirs: t('hub.vrct.they_said', 'Someone said') };
    box.innerHTML = _vrct.log.map(line => `<div class="vrct-line${line.kind === 'theirs' ? '' : ' is-mine'}">
        <div class="vrct-line-who">${esc(who[line.kind])} · ${esc(new Date(line.at).toLocaleTimeString([], { timeStyle: 'short' }))}</div>
        <div class="vrct-line-original" dir="auto">${esc(line.original)}</div>
        ${line.translations.map(tr => `<div class="vrct-line-translation" dir="auto">${esc(tr)}</div>`).join('')}
    </div>`).join('');
    box.scrollTop = box.scrollHeight;
}

// ---- Drawing ----

function _vrctOptions(select, values, current, label = v => v) {
    if (!select) return;
    const key = JSON.stringify(values) + '|' + current;
    if (select.dataset.key === key) return;
    select.dataset.key = key;
    select.innerHTML = values.map(v => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label(v))}</option>`).join('');
    select.value = current ?? '';
}

function _vrctDraw() {
    const page = document.querySelector('.vrct-page');
    if (!page) return;
    _vrct.ready = _vrct.state === 'ready';
    page.classList.toggle('is-off', !_vrct.ready);
    const status = _vrctEl('vrctStatus');
    const labels = {
        off: t('hub.vrct.state_off', 'Off'), starting: t('hub.vrct.state_starting', 'Starting...'),
        ready: t('hub.vrct.state_ready', 'Running'), failed: t('hub.vrct.state_failed', 'Stopped'),
    };
    status.textContent = labels[_vrct.state] || _vrct.state;
    status.classList.toggle('is-ready', _vrct.ready);
    status.classList.toggle('is-problem', _vrct.state === 'failed');
    _vrctEl('vrctStart').disabled = !_vrct.found || _vrct.state === 'starting' || _vrct.ready;
    _vrctEl('vrctStop').disabled = !(_vrct.ready || _vrct.state === 'starting');
    const progress = _vrctEl('vrctProgress');
    progress.hidden = _vrct.state !== 'starting';
    // The engine reports a handful of start-up steps; each moves the bar along.
    _vrctEl('vrctProgressFill').style.width = Math.min(95, 15 + (_vrct.progress || 0) * 15) + '%';
    const problem = _vrctEl('vrctProblem');
    const text = !_vrct.found ? t('hub.vrct.not_found', 'VRCT isn\'t installed. Install it, or set where it is under Settings > Plugins > VRCT.')
        : _vrct.problem || (_vrct.windowOpen && !_vrct.ready ? t('hub.vrct.window_open', 'VRCT\'s own window is open. Close it first: it runs its own copy of the translator.') : '');
    problem.hidden = !text;
    problem.textContent = text;

    const languages = _vrctLanguages();
    const counts = {};
    for (const l of languages) counts[l.language] = (counts[l.language] || 0) + 1;
    const values = languages.map(l => `${l.language}|${l.country}`);
    const label = v => { const [language, country] = v.split('|'); return counts[language] > 1 ? `${language} (${country})` : language; };
    const your = _vrctCurrent('your'), target = _vrctCurrent('target');
    _vrctOptions(_vrctEl('vrctYour'), values, your ? `${your.language}|${your.country}` : '', label);
    _vrctOptions(_vrctEl('vrctTarget'), values, target ? `${target.language}|${target.country}` : '', label);

    _vrctEl('vrctPairs').innerHTML = _VRCT_PAIRS.filter(([a, b]) => _vrctFind(a) && _vrctFind(b)).map(([a, b]) =>
        `<button class="vrct-pair${your?.language === a && target?.language === b ? ' is-on' : ''}" onclick="vrctPair('${a}', '${b}')">${esc(a)} → ${esc(b)}</button>`).join('');

    const engines = Array.isArray(_vrct.data.translation_engines) ? _vrct.data.translation_engines : (_vrct.data.selectable_translation_engines || []);
    _vrctOptions(_vrctEl('vrctEngine'), engines, _vrct.data.selected_translation_engines?.[_vrctTab()] || '');
    _vrctOptions(_vrctEl('vrctSpeech'), _vrct.data.selectable_transcription_engines || [], _vrct.data.selected_transcription_engine || '');
    _vrctOptions(_vrctEl('vrctMic'), _vrct.data.selectable_mic_device_list || [], _vrct.data.selected_mic_device || '');
    _vrctOptions(_vrctEl('vrctSpeaker'), _vrct.data.selectable_speaker_device_list || [], _vrct.data.selected_speaker_device || '');

    const switches = _vrctEl('vrctSwitches');
    switches.innerHTML = _VRCT_SWITCHES.map(([key, i18n, fallback]) => `<div class="sf-toggle-row">
        <span>${esc(t(i18n, fallback))}</span>
        <label class="toggle"><input type="checkbox" data-vrct="${key}" ${_vrct.on[key] ? 'checked' : ''} onchange="vrctToggle('${key}', this.checked)"><div class="toggle-track"><div class="toggle-knob"></div></div></label>
    </div>`).join('');
}

function onHubVrctState(payload) {
    _vrct.state = payload.state || 'off';
    _vrct.progress = payload.progress || 0;
    _vrct.problem = payload.problem || '';
    _vrct.found = payload.found !== false;
    _vrct.windowOpen = !!payload.windowOpen;
    if (payload.snapshot) _vrctTakeSnapshot(payload.snapshot);
    _vrctDraw();
}

function _vrctTakeSnapshot(snapshot) {
    for (const [endpoint, value] of Object.entries(snapshot || {})) {
        const name = endpoint.replace(/^\/get\/data\//, '');
        _vrct.data[name] = value;
        if (typeof value === 'boolean' && _VRCT_SWITCHES.some(([key]) => key === name)) _vrct.on[name] = value;
    }
}

function onHubVrct(message) {
    const { endpoint = '', status, result } = message || {};
    let match;
    if (status !== 200) {
        if (status >= 400) { _vrct.problem = `${endpoint}: ${typeof result === 'string' ? result : JSON.stringify(result)}`.slice(0, 200); _vrctDraw(); }
        return;
    }
    if (endpoint === '/run/initialization_complete') {
        _vrctTakeSnapshot(result);
        _vrct.state = 'ready';
        _vrct.problem = '';
    } else if (endpoint === '/run/initialization_progress') {
        _vrct.progress = Number(result) || 0;
    } else if ((match = endpoint.match(/^\/(?:set|get)\/data\/(.+)$/)) || (match = endpoint.match(/^\/run\/((?:selected|selectable)_.+|translation_engines)$/))) {
        _vrct.data[match[1]] = result;
        if (typeof result === 'boolean' && _VRCT_SWITCHES.some(([key]) => key === match[1])) _vrct.on[match[1]] = result;
    } else if ((match = endpoint.match(/^\/set\/(enable|disable)\/(.+)$/))) {
        _vrct.on[match[2]] = typeof result === 'boolean' ? result : match[1] === 'enable';
    } else if ((match = endpoint.match(/^\/run\/enable_(.+)$/))) {
        _vrct.on[match[1]] = !!(result && typeof result === 'object' ? result.data : result);
    } else if (endpoint === '/run/transcription_send_mic_message') {
        _vrctLog('mine', result);
    } else if (endpoint === '/run/transcription_receive_speaker_message') {
        _vrctLog('theirs', result);
    } else if (endpoint === '/run/send_message_box') {
        _vrctLog('typed', result);
    } else if (endpoint === '/run/swap_your_language_and_target_language') {
        vrctSend('/get/data/selected_your_languages');
        vrctSend('/get/data/selected_target_languages');
    } else if (/^\/run\/(error_|transcription_recognition_error)/.test(endpoint)) {
        _vrct.problem = `${endpoint.replace('/run/', '').replace(/_/g, ' ')}: ${typeof result === 'string' ? result : JSON.stringify(result)}`.slice(0, 200);
    } else {
        return;
    }
    _vrctDraw();
}

(function () {
    const watch = () => {
        const tab = document.getElementById('tab37');
        if (!tab || !document.querySelector('.vrct-page')) { setTimeout(watch, 1000); return; }
        new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) sendToCS({ action: 'hubVrctState' }); }).observe(tab);
        _vrctDraw();
    };
    watch();
    document.documentElement.addEventListener('languagechange', () => { _vrctDraw(); _vrctDrawLog(); });
})();
