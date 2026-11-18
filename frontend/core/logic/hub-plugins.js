// Plugins: optional features that can be switched off, like Obsidian's plugin list.
// A plugin that's off loses its page, its buttons, its settings and its auto-start; the hub stops any background
// module it owns. Everything is on until switched off, so nothing changes for anyone who never opens this.
// Stage 1 lists what ships with HapsHub. Downloading more (stage 2) comes later.

const HUB_PLUGINS = [
    // --- Added by HapsHub ---
    { id: 'oyasumi', name: 'OyasumiVR', by: 'HapsHub', icon: 'bedtime', nav: ['oyasumi'], hide: ['[data-known-app="oyasumi"]'], settings: [{ module: 'hub.app-embeds', keys: ['oyasumi_path', 'on_exit'] }],
      desc: 'Shows OyasumiVR, the sleep helper for VR, inside a HapsHub page.' },
    { id: 'eagle', name: 'Eagle', by: 'HapsHub', icon: 'photo_library', hide: ['#libTabEagle', '#libEagleView', '#libEagleTools'], settings: [{ module: 'hub.app-embeds', keys: ['eagle_path', 'on_exit'] }],
      onOff: () => { if (typeof libEagleClose === 'function') libEagleClose(); },
      desc: 'Shows the Eagle picture organizer in a tab inside Media Library.' },
    { id: 'spacecal', name: 'Space Calibrator', by: 'HapsHub', icon: 'gps_fixed', nav: ['spacecal'], hide: ['#hubSteamBranch'], slots: ['hubSteamBranch'],
      settings: [{ module: 'hub.app-embeds', keys: ['spacecal_path', 'on_exit'] }, { module: 'hub.steam-branch' }],
      desc: 'Space Calibrator in a page, and a switch between its Steam public and beta versions.' },
    { id: 'vrct', name: 'VRCT', by: 'HapsHub', icon: 'translate', nav: ['vrct'], hide: ['[data-known-app="vrct"]'], settings: [{ module: 'hub.vrct', keys: ['auto_start'] }, { module: 'hub.app-embeds', keys: ['vrct_path'] }],
      desc: 'The VRCT voice translator, run by HapsHub with its own page: speech to chatbox, translation both ways.' },
    { id: 'ovrtoolkit', name: 'OVR Toolkit', by: 'HapsHub', icon: 'view_in_ar', nav: ['ovrtoolkit'], settings: [{ module: 'hub.app-embeds', keys: ['ovrtoolkit_path', 'on_exit'] }],
      desc: 'OVR Toolkit\'s desktop window inside a HapsHub page.' },
    { id: 'ovr-advanced', name: 'OVR Advanced Settings', by: 'HapsHub', icon: 'open_with', nav: ['ovr-advanced'],
      desc: 'Edit OVR Advanced Settings\' movement options: dragging, gravity, snap turn.' },
    { id: 'youtube-tunnel', name: 'YouTube Tunnel', by: 'HapsHub', icon: 'music_note', licences: ['naudio', 'naudio-vorbis'], nav: ['youtube-tunnel'], settings: [{ module: 'hub.youtube-tunnel' }],
      desc: 'Plays a YouTube song into your VRChat microphone through a virtual cable.' },
    { id: 'history', name: 'History', by: 'HapsHub', icon: 'history', nav: ['history'], settings: [{ module: 'hub.history' }],
      desc: 'Records name and trust changes, notifications, videos, avatars and visits for the History page.' },
    { id: 'friend-schedule', name: 'Friend Schedule', by: 'HapsHub', icon: 'date_range', nav: ['friend-schedule'],
      desc: 'Shows when your friends are usually online, to find a good time to meet.' },
    { id: 'world-map', name: 'World Map', by: 'HapsHub', icon: 'public', licences: ['world-atlas'], nav: ['world-map'],
      desc: 'A globe with your friends placed by the languages and countries on their profiles.' },
    { id: 'hapsplorer', name: 'Hapsplorer', by: 'HapsHub', icon: 'storefront', licences: ['vrcatalogue-data'], nav: ['hapsplorer'],
      desc: 'Search BOOTH avatar assets on a Hapsplorer server. Needs its address and an access key from whoever runs it.' },
    { id: 'launch-switches', name: 'Launch switches', by: 'HapsHub', icon: 'rocket_launch', hide: ['.launch-addons', '#launchAddonsBlock'],
      desc: 'Haptics, face tracking and full-body tracking switches in the Launch window, each starting its apps with VRChat.' },
    { id: 'vr-autostart', name: 'Start with VR', by: 'HapsHub', icon: 'play_circle', hide: ['#knownVrAppToggles'],
      desc: 'One switch each to start OyasumiVR, Standable and VRCT when VRChat starts in VR.' },
    { id: 'crash-rejoin', name: 'Crash rejoin', by: 'HapsHub', icon: 'refresh', settings: [{ module: 'hub.crash-rejoin' }],
      desc: 'Brings you back to the instance you were in when VRChat crashes.' },
    { id: 'overlay-events', name: 'Overlay events', by: 'HapsHub', icon: 'notifications_active', settings: [{ module: 'hub.overlay-events' }],
      desc: 'Extra events for the VR overlay, such as friends joining your instance.' },
    { id: 'photo-metadata', name: 'Screenshot details', by: 'HapsHub', icon: 'photo_camera', settings: [{ module: 'hub.photo-metadata' }],
      desc: 'Writes the world and the people with you into each new VRChat screenshot.' },
    { id: 'vrcx', name: 'VRCX import and archive', by: 'HapsHub', icon: 'download', hide: ['.settings-nav-item[onclick*="\'vrcx\'"]', '#tab9 [data-section="vrcx"]'], section: 'vrcx',
      desc: 'Brings your VRCX history into HapsHub and keeps a full copy of it.' },
    { id: 'proxy', name: 'Proxy', by: 'HapsHub', icon: 'vpn_key', settings: [{ module: 'hub.proxy' }],
      desc: 'Sends HapsHub\'s web requests through a proxy you choose.' },
    { id: 'upstream-watch', name: 'Upstream watch', by: 'HapsHub', icon: 'merge', hide: ['#hubUpstreamList'], settings: [{ module: 'hub.upstream-watch' }],
      desc: 'For whoever maintains HapsHub: what changed in VRCNext, VRCX and Space Calibrator since the last review.' },
    // --- From VRCNext ---
    { id: 'rose-db', name: 'Rose Database', by: 'VRCNext', icon: 'local_florist', hide: ['#avatarFilterRose', '#avatarRoseArea'],
      onOff: () => { if (typeof avatarFilter !== 'undefined' && avatarFilter === 'rose' && typeof setAvatarFilter === 'function') setAvatarFilter('own'); },
      desc: 'A shared list of public avatars, as a filter on the Avatars page.' },
    { id: 'space-flight', name: 'Space Flight', by: 'VRCNext', icon: 'rocket_launch', nav: ['space-flight'], hide: ['#badgeSpace'], autostart: ['setSfAutoStartVR'],
      desc: 'Fly through your play space in VR with your controllers.' },
    { id: 'space-turn', name: 'Space Turn', by: 'VRCNext', icon: 'rotate_right', nav: ['space-turn'], hide: ['#badgeSpaceTurn'], autostart: ['setStAutoStartVR'],
      desc: 'Turn your play space in VR with your controllers.' },
    { id: 'youtube-fix', name: 'YouTube Fix', by: 'VRCNext', icon: 'smart_display', nav: ['youtube-fix'], hide: ['#badgeYt'], autostart: ['setYtAutoStartVR', 'setYtAutoStartDesktop'],
      desc: 'Makes YouTube videos play in VRChat worlds through VRCVideoCacher.' },
    { id: 'frame-shot', name: 'FrameShot', by: 'VRCNext', icon: 'photo_camera', licences: ['naudio', 'naudio-vorbis', 'zxing-net'], nav: ['frame-shot'], hide: ['#badgeFrameShot'], autostart: ['setFsAutoStartVR'],
      desc: 'Take pictures and clips of what you see in VR.' },
    { id: 'osc-tool', name: 'OSC Tool', by: 'VRCNext', icon: 'tune', nav: ['osc-tool'],
      desc: 'Read and change your avatar\'s OSC parameters.' },
    { id: 'voice-fight', name: 'Voice Fight', by: 'VRCNext', icon: 'mic', licences: ['vosk', 'naudio', 'naudio-vorbis'], nav: ['voice-fight'], hide: ['#badgeVoice'], autostart: ['setVfAutoStartVR', 'setVfAutoStartDesktop'],
      desc: 'Voice-to-chatbox with blocked words and sound effects.' },
    { id: 'discord-presence', name: 'Discord Presence', by: 'VRCNext', icon: 'sensors', licences: ['discord-rpc'], nav: ['discord-presence'], hide: ['#badgeDp'], autostart: ['setDpAutoStartVR', 'setDpAutoStartDesktop'],
      desc: 'Shows the world you\'re in on your Discord profile.' },
    { id: 'vr-overlay', name: 'VR Overlay', by: 'VRCNext', icon: 'watch', nav: ['vr-overlay'], hide: ['#badgeVroTop'], autostart: ['setVroAutoStartVR'],
      desc: 'A wrist overlay in VR with friends, notifications and the time.' },
    { id: 'permini', name: 'Permini', by: 'VRCNext', icon: 'lock', nav: ['permini'],
      desc: 'Decides who may join your instances.' },
    { id: 'kikitan-xd', name: 'Kikitan XD', by: 'VRCNext', icon: 'translate', licences: ['naudio', 'naudio-vorbis', 'whisper-net', 'llamasharp'], nav: ['kikitan-xd'], hide: ['#badgeKxd'],
      desc: 'Speech to text and translation into your chatbox.' },
    { id: 'event-snipe', name: 'Event Snipe', by: 'VRCNext', icon: 'gps_fixed', nav: ['event-snipe'],
      desc: 'Joins a group event\'s instance the moment it opens.' },
    { id: 'avatar-scaling', name: 'Avatar Scaling', by: 'VRCNext', icon: 'height', nav: ['avatar-scaling'], autostart: ['setAsAutoStartVR', 'setAsAutoStartDesktop'],
      desc: 'Change your avatar\'s height with your controllers.' },
    { id: 'action-flow', name: 'Action Flow', by: 'VRCNext', icon: 'auto_awesome', nav: ['action-flow'],
      desc: 'Build your own automations: when something happens, do something.' },
    { id: 'status-schedule', name: 'Status Schedule', by: 'VRCNext', icon: 'event_available', nav: ['status-schedule'],
      desc: 'Changes your status and status text on a schedule.' },
    { id: 'media-relay', name: 'Media Relay', by: 'VRCNext', icon: 'cell_tower', nav: ['media-relay'], hide: ['#badgeRelay'], autostart: ['setAutoStartVR', 'setAutoStartDesktop'],
      desc: 'Sends your new screenshots to Discord.' },
    { id: 'chatbox', name: 'Custom Chatbox', by: 'VRCNext', icon: 'chat', licences: ['perfcounter'], nav: ['chatbox'], hide: ['#badgeChatbox'], autostart: ['setCbAutoStartVR', 'setCbAutoStartDesktop'],
      desc: 'Shows the time, music and stats in your VRChat chatbox.' },
];

const _HUB_PLUGINS_CACHE = 'hapshub.plugins.states';
let _hubPluginStates = (() => { try { return JSON.parse(localStorage.getItem(_HUB_PLUGINS_CACHE) || '{}'); } catch { return {}; } })();
let _hubPluginQuery = '';

function hubPluginOn(id) { return _hubPluginStates[id] !== false; }

function hubPluginById(id) { return HUB_PLUGINS.find(p => p.id === id); }

/** The plugin a page belongs to, by its tab number. */
function hubPluginForTab(tab) {
    return HUB_PLUGINS.find(p => (p.nav || []).some(key => typeof NAV_ITEMS_DEF !== 'undefined' && NAV_ITEMS_DEF[key]?.tab === Number(tab)));
}

/** Sidebar entries that belong to plugins that are off. */
function hubPluginHiddenNav() {
    return HUB_PLUGINS.filter(p => !hubPluginOn(p.id)).flatMap(p => p.nav || []);
}

/** True when an auto-start switch belongs to a plugin that's off, so its tool doesn't start with VRChat. */
function hubPluginBlocks(checkboxId) {
    return HUB_PLUGINS.some(p => !hubPluginOn(p.id) && (p.autostart || []).includes(checkboxId));
}

// Each plugin names the third-party libraries it brings (data-licence in Settings > About). A library shows while any
// plugin using it is on; libraries no plugin names belong to HapsHub itself and always show.
function hubPluginOffLicences() {
    const owners = {};
    for (const p of HUB_PLUGINS) for (const l of p.licences || []) (owners[l] = owners[l] || []).push(p.id);
    return Object.keys(owners).filter(l => !owners[l].some(hubPluginOn));
}

function _hubPluginSelectors(plugin) {
    const selectors = [...(plugin.hide || [])];
    for (const key of plugin.nav || []) {
        const def = typeof NAV_ITEMS_DEF !== 'undefined' ? NAV_ITEMS_DEF[key] : null;
        if (!def) continue;
        selectors.push(`[onclick="showTab(${def.tab})"]`, `.nav-folder-cell[data-nav-key="${key}"]`, `.settings-nav-item[data-plugin="${plugin.id}"]`);
    }
    return selectors;
}

function _hubPluginsApply() {
    try { localStorage.setItem(_HUB_PLUGINS_CACHE, JSON.stringify(_hubPluginStates)); } catch { /* full or blocked */ }
    // One style sheet hides everything that belongs to plugins that are off, so redrawn lists stay hidden too.
    let style = document.getElementById('hubPluginHide');
    if (!style) {
        style = document.createElement('style');
        style.id = 'hubPluginHide';
        document.head.appendChild(style);
    }
    const offPlugins = HUB_PLUGINS.filter(p => !hubPluginOn(p.id));
    // A plugin that's off may still be showing something (a filter, a panel); it puts the page back first.
    for (const p of offPlugins) { try { p.onOff?.(); } catch { /* the page isn't loaded yet */ } }
    const off = [...offPlugins.flatMap(_hubPluginSelectors), ...hubPluginOffLicences().map(l => `.attrib-item[data-licence="${l}"]`)];
    // Modules that belong to a plugin are set on its own options page, not in the general Hub modules list.
    const owned = HUB_PLUGINS.flatMap(p => (p.settings || []).map(s => s.module));
    const ownedRules = [...new Set(owned)].map(m => `#hubModulesList .hub-module-row[data-module="${m}"]`);
    style.textContent = [...(off.length ? [`${off.join(',\n')} { display: none !important; }`] : []),
        `${ownedRules.join(',\n')} { display: none !important; }`].join('\n');
    if (typeof navRender === 'function') navRender();
    // The open page may have just been switched off.
    const active = document.querySelector('.tab.active')?.id;
    const plugin = active ? hubPluginForTab(active.replace('tab', '')) : null;
    if (plugin && !hubPluginOn(plugin.id) && typeof showTab === 'function') showTab(0);
    hubPluginsRender();
}

// Switches sent to the app and not yet answered, oldest first. The app answers each one with the full list, so while
// several are on their way an answer can be older than the page: switches still pending stay as the page set them.
const _hubPluginPending = [];

function onHubPlugins(payload) {
    window.__hubPluginsAnswered = true;
    if (payload?.switched) _hubPluginPending.shift();
    _hubPluginStates = { ...(payload?.states || {}) };
    for (const p of _hubPluginPending) _hubPluginStates[p.id] = p.on;
    _hubPluginsApply();
}

/** True once the app has answered every plugin switch the page sent. */
function hubPluginsSettled() { return _hubPluginPending.length === 0; }

function hubPluginSet(id, on) {
    _hubPluginStates[id] = !!on;
    _hubPluginPending.push({ id, on: !!on });
    _hubPluginsApply();
    sendToCS({ action: 'hubPluginSet', id, on: !!on });
}

// ---- The Plugins page (Settings > Plugins) ----

function _hubPluginText(plugin, field) {
    return t(`hub.plugin.${plugin.id}.${field}`, field === 'name' ? plugin.name : plugin.desc);
}

function hubPluginsRender() {
    const list = document.getElementById('hubPluginList');
    if (list) {
        const query = _hubPluginQuery.trim().toLowerCase();
        const shown = HUB_PLUGINS.filter(p => !query || `${_hubPluginText(p, 'name')} ${_hubPluginText(p, 'desc')} ${p.by}`.toLowerCase().includes(query));
        const group = by => {
            const rows = shown.filter(p => p.by === by);
            if (!rows.length) return '';
            const title = by === 'HapsHub' ? t('hub.plugins.from_hub', 'Added by {name}').replace('{name}', typeof hubBrandName === 'function' ? hubBrandName() : 'HapsHub')
                : t('hub.plugins.from_vrcnext', 'From VRCNext');
            return `<div class="hub-plugin-group">${esc(title)}</div>` + rows.map(p => {
                const on = hubPluginOn(p.id);
                return `<div class="hub-plugin-row${on ? '' : ' is-off'}" data-plugin="${p.id}">
                    <span class="msi hub-plugin-icon">${esc(p.icon)}</span>
                    <div class="hub-plugin-main">
                        <div class="hub-plugin-name">${esc(_hubPluginText(p, 'name'))} <span class="hub-plugin-meta">${esc(tf('hub.plugins.by', { version: '1.0.0', author: p.by }, 'v{version} by {author}'))}</span></div>
                        <div class="hub-plugin-desc">${esc(_hubPluginText(p, 'desc'))}</div>
                    </div>
                    ${_hubPluginHasOptions(p) && on ? `<button class="vrcn-icon-button hub-plugin-expand" title="${esc(t('hub.plugins.options', 'Options'))}" aria-expanded="${_hubPluginOpen.has(p.id)}" onclick="hubPluginToggleOptions('${p.id}')"><span class="msi">expand_more</span></button>` : ''}
                    <button class="vrcn-icon-button hub-plugin-more" title="${esc(t('hub.plugins.more', 'More'))}" onclick="hubPluginMenu(event, '${p.id}')"><span class="msi">more_horiz</span></button>
                    <label class="toggle"><input type="checkbox" ${on ? 'checked' : ''} onchange="hubPluginSet('${p.id}', this.checked)"><div class="toggle-track"><div class="toggle-knob"></div></div></label>
                </div>${_hubPluginHasOptions(p) ? `<div class="hub-plugin-opts" data-plugin-opts="${p.id}" hidden></div>` : ''}`;
            }).join('');
        };
        list.innerHTML = (group('HapsHub') + group('VRCNext')) || `<div class="folder-empty">${esc(t('hub.plugins.none_found', 'No plugins match.'))}</div>`;
    }
    const count = document.getElementById('hubPluginCount');
    if (count) count.textContent = tf('hub.plugins.count', { on: HUB_PLUGINS.filter(p => hubPluginOn(p.id)).length, total: HUB_PLUGINS.length }, '{on} of {total} on');
    _hubPluginNavRender();
    hubPluginsRenderOptions();
}

function hubPluginsSearch(value) {
    _hubPluginQuery = value || '';
    hubPluginsRender();
}

function hubPluginsAll(on) {
    for (const p of HUB_PLUGINS) if (hubPluginOn(p.id) !== on) hubPluginSet(p.id, on);
}

function hubPluginMenu(event, id) {
    event.stopPropagation();
    document.getElementById('hubPluginMenu')?.remove();
    const plugin = hubPluginById(id);
    if (!plugin) return;
    const page = (plugin.nav || []).map(k => typeof NAV_ITEMS_DEF !== 'undefined' ? NAV_ITEMS_DEF[k] : null).find(Boolean);
    const items = [];
    if (page && hubPluginOn(id)) items.push(['open_in_new', t('hub.plugins.open_page', 'Open its page'), `showTab(${page.tab})`]);
    if (_hubPluginHasOptions(plugin) && hubPluginOn(id)) items.push(['settings', t('hub.plugins.options', 'Options'), `hubPluginToggleOptions('${id}', true)`]);
    if (plugin.section && hubPluginOn(id)) items.push(['settings', t('hub.plugins.open_settings', 'Open its settings'), `hubPluginSection('${id}')`]);
    items.push([hubPluginOn(id) ? 'close' : 'toggle_on', hubPluginOn(id) ? t('hub.plugins.turn_off', 'Turn off') : t('hub.plugins.turn_on', 'Turn on'), `hubPluginSet('${id}', ${!hubPluginOn(id)})`]);
    const menu = document.createElement('div');
    menu.id = 'hubPluginMenu';
    menu.className = 'hub-plugin-menu';
    menu.innerHTML = items.map(([icon, label, run]) => `<button class="tb-dd-item" onclick="document.getElementById('hubPluginMenu')?.remove(); ${run}"><span class="msi">${icon}</span><span>${esc(label)}</span></button>`).join('');
    document.body.appendChild(menu);
    const box = event.currentTarget.getBoundingClientRect();
    menu.style.top = Math.min(box.bottom + 4, innerHeight - menu.offsetHeight - 8) + 'px';
    menu.style.left = Math.max(8, Math.min(box.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function close(e) {
        if (menu.contains(e.target)) return;
        menu.remove();
        document.removeEventListener('mousedown', close);
    }), 0);
}

function hubOpenPlugins() {
    if (typeof showTab === 'function') showTab(9);
    if (typeof switchSettingsSection === 'function') switchSettingsSection('plugins', document.querySelector('.settings-nav-item[data-section-id="plugins"]'));
}

// ---- Options: a plugin's settings fold open under it in the Plugins list (no tab per plugin) ----

const _hubPluginOpen = new Set();

function _hubPluginHasOptions(p) { return (p.settings || []).length > 0 || (p.slots || []).length > 0; }

// Settings > Plugins used to get one sidebar entry per plugin. They live in the list now; this clears any old ones.
function _hubPluginNavRender() {
    const box = document.getElementById('hubPluginNavItems');
    if (box) box.innerHTML = '';
}

function hubPluginToggleOptions(id, open) {
    const show = open ?? !_hubPluginOpen.has(id);
    if (show) _hubPluginOpen.add(id); else _hubPluginOpen.delete(id);
    const panel = document.querySelector(`.hub-plugin-opts[data-plugin-opts="${id}"]`);
    const button = document.querySelector(`.hub-plugin-row[data-plugin="${id}"] .hub-plugin-expand`);
    if (panel) panel.hidden = !show;
    if (button) button.setAttribute('aria-expanded', String(show));
    hubPluginsRenderOptions();
}

/** Opens Settings > Plugins with this plugin's options folded open. */
function hubPluginOptions(id) {
    hubOpenPlugins();
    const search = document.getElementById('hubPluginSearch');
    if (search && search.value) { search.value = ''; hubPluginsSearch(''); }
    hubPluginToggleOptions(id, true);
    document.querySelector(`.hub-plugin-row[data-plugin="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** Opens the Settings tab a plugin keeps its controls on (VRCX). */
function hubPluginSection(id) {
    const section = hubPluginById(id)?.section;
    if (!section) return;
    if (typeof showTab === 'function') showTab(9);
    switchSettingsSection(section);
}

function _hubPluginPark() {
    let park = document.getElementById('hubPluginPark');
    if (!park) {
        park = document.createElement('div');
        park.id = 'hubPluginPark';
        park.hidden = true;
        document.body.appendChild(park);
    }
    return park;
}

function hubPluginsRenderOptions() {
    if (typeof _hubUiSettings === 'undefined') return;
    // Panels drawn by other code (Space Calibrator's Steam branch) are moved, not redrawn, so they keep their state.
    const park = _hubPluginPark();
    for (const p of HUB_PLUGINS) for (const id of p.slots || []) {
        const el = document.getElementById(id);
        if (el && !park.contains(el)) park.appendChild(el);
    }
    for (const p of HUB_PLUGINS.filter(_hubPluginHasOptions)) {
        const panel = document.querySelector(`.hub-plugin-opts[data-plugin-opts="${p.id}"]`);
        if (!panel) continue;
        const open = _hubPluginOpen.has(p.id) && hubPluginOn(p.id);
        panel.hidden = !open;
        if (!open) continue;
        // Typing in a box here must not be wiped by a redraw.
        if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') continue;
        const rows = (p.settings || []).map(s => {
            const module = (_hubUiSettings || []).find(m => m.id === s.module);
            if (!module) return '';
            return s.keys ? s.keys.map(key => _hubModuleRow(module, key)).join('') : _hubModuleRow(module);
        }).join('');
        panel.innerHTML = rows + (p.slots || []).map(id => `<div data-slot-for="${id}"></div>`).join('')
            + (rows || (p.slots || []).length ? '' : `<div class="set-desc">${esc(t('hub.plugins.no_options', 'Nothing to set here yet.'))}</div>`);
        for (const id of p.slots || []) {
            const el = document.getElementById(id);
            const slot = panel.querySelector(`[data-slot-for="${id}"]`);
            if (el && slot) slot.appendChild(el);
        }
    }
}

// ---- Start: the last known states apply at once, the hub's answer follows ----

(function () {
    if (typeof showTab === 'function') {
        const show = showTab;
        showTab = function (tab, ...rest) {
            const plugin = hubPluginForTab(tab);
            return show.call(this, plugin && !hubPluginOn(plugin.id) ? 0 : tab, ...rest);
        };
    }
    _hubPluginsApply();
    let attempts = 0;
    const ask = () => {
        if (window.__hubPluginsAnswered || ++attempts > 30) return;
        if (typeof sendToCS === 'function') sendToCS({ action: 'hubPlugins' });
        setTimeout(ask, 2000);
    };
    setTimeout(ask, 800);
    document.documentElement.addEventListener('languagechange', hubPluginsRender);
})();
