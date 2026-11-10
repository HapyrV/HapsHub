// Hub modules card: each module's state and the settings it declares.

const _HUB_STATUS_LABELS = {
    Registered: ['hub.modules.status.waiting', 'Waiting to start'],
    Disabled:   ['hub.modules.status.off', 'Off'],
    Starting:   ['hub.modules.status.starting', 'Starting'],
    Running:    ['hub.modules.status.running', 'Running'],
    Degraded:   ['hub.modules.status.degraded', 'Limited'],
    Failed:     ['hub.modules.status.failed', 'Failed'],
    Stopped:    ['hub.modules.status.stopped', 'Stopped'],
};

function hubModulesRefresh() {
    sendToCS({ action: 'hubGetModules' });
}

function hubSettingChanged(input) {
    sendToCS({
        action: 'hubSetSetting',
        module: input.dataset.module,
        key: input.dataset.key,
        value: input.type === 'checkbox' ? (input.checked ? 'true' : 'false') : input.value,
    });
}

// Settings shown on another settings page instead of under General > Hub modules.
// A slot id that doesn't exist hides the setting; its own page edits it.
const _HUB_MOVED_SETTINGS = {
    'hub.forwarding': { forward_avatar_data: 'hubForwardingSlot' },
    // Settings > Plugins and Settings > Performance draw these themselves.
    'hub.plugins': { enabled: 'hubOwnPage', picked: 'hubOwnPage' },
    'hub.vrct': { auto_start: 'hubOwnPage' },
    'hub.performance': { mode: 'hubOwnPage', cut_blur: 'hubOwnPage', cut_animations: 'hubOwnPage', cut_pictures: 'hubOwnPage', cut_glass: 'hubOwnPage', cut_polling: 'hubOwnPage' },
    'hub.ui': {
        welcome_off: 'hubOwnPage', welcome_custom: 'hubOwnPage', letter_spacing: 'hubOwnPage', app_name: 'hubOwnPage',
        dash_welcome: 'hubOwnPage', dash_online: 'hubOwnPage', dash_status: 'hubOwnPage', dash_friends: 'hubOwnPage', dash_web: 'hubOwnPage',
    },
};

function _hubModuleRow(module, onlyKey) {
    const moved = _HUB_MOVED_SETTINGS[module.id] || {};
    const keep = s => onlyKey ? s.key === onlyKey : !moved[s.key];
    module = { ...module, settings: (module.settings || []).filter(keep) };
    const [key, fallback] = _HUB_STATUS_LABELS[module.status] || ['', module.status];
    const problem = module.status === 'Failed' || module.status === 'Degraded';
    const status = t(key, fallback) + (module.detail ? `: ${module.detail}` : '');
    // A module's own English text is the fallback; a translation, when there is one, is found by module and key.
    const label = s => esc(t(`hub.set.${module.id}.${s.key}`, s.label));
    const settings = (module.settings || []).filter(s => s.kind === 'Toggle').map(s => `
        <div class="sf-toggle-row" style="margin-top:6px;">
            <div>${label(s)}</div>
            <label class="toggle">
                <input type="checkbox" data-module="${esc(module.id)}" data-key="${esc(s.key)}" ${s.value === 'true' ? 'checked' : ''} onchange="hubSettingChanged(this)">
                <div class="toggle-track"><div class="toggle-knob"></div></div>
            </label>
        </div>`).join('') + (module.settings || []).filter(s => s.kind === 'Choice').map(s => `
        <div class="sf-toggle-row" style="margin-top:6px;">
            <div>${label(s)}</div>
            <select class="vrcn-dropdown hub-setting-choice" data-module="${esc(module.id)}" data-key="${esc(s.key)}" onchange="hubSettingChanged(this)">
                ${(s.options || []).map(o => `<option value="${esc(o.value)}"${o.value === s.value ? ' selected' : ''}>${esc(t(`hub.set.${module.id}.${s.key}.${o.value}`, o.label))}</option>`).join('')}
            </select>
        </div>`).join('') + (module.settings || []).filter(s => s.kind === 'Text').map(s => `
        <div style="margin-top:6px;">
            <div>${label(s)}</div>
            <input type="text" class="hub-setting-text" style="width:100%;box-sizing:border-box;margin-top:4px;padding:6px 10px;border-radius:8px;border:1px solid transparent;background:var(--bg-input);color:var(--tx0);"
                data-module="${esc(module.id)}" data-key="${esc(s.key)}" value="${esc(s.value || '')}" spellcheck="false" onchange="hubSettingChanged(this)">
        </div>`).join('');
    const info = t('hub.modules.info.' + module.id, '');
    const infoHtml = info ? `<span class="hub-info" tabindex="0"><span class="msi">info</span><span class="hub-info-pop">${esc(info)}</span></span>` : '';
    return `<div class="hub-module-row" data-module="${esc(module.id)}" style="margin-top:12px;">
        <div><strong>${esc(module.name)}</strong>${infoHtml} <span class="sf-desc"${problem ? ' style="color:var(--err);"' : ''}>${esc(status)}</span></div>
        ${settings}
    </div>`;
}

function onHubModules(payload) {
    const list = document.getElementById('hubModulesList');
    // Empty only in the moment before the hub has started. Keep the button so it can be retried.
    // A module whose every setting lives on another page isn't listed here.
    const listed = (payload.modules || []).filter(m => {
        const moved = _HUB_MOVED_SETTINGS[m.id];
        return !moved || !(m.settings || []).length || (m.settings || []).some(s => !moved[s.key]);
    });
    if (list && payload.modules?.length) list.innerHTML = listed.map(m => _hubModuleRow(m)).join('');
    for (const module of payload.modules || []) {
        for (const [key, slotId] of Object.entries(_HUB_MOVED_SETTINGS[module.id] || {})) {
            const slot = document.getElementById(slotId);
            if (slot) slot.innerHTML = _hubModuleRow(module, key);
        }
    }
    if (payload.system) window.hubSystemInfo = payload.system;
    if (payload.modules?.length) hubUiApply(payload.modules);
    if (typeof hubPluginsRenderOptions === 'function') hubPluginsRenderOptions();
    if (payload.modules?.length && typeof vrctOnModules === 'function') vrctOnModules(payload.modules);
}
