// YouTube Tunnel: paste a link, and it plays into the VRChat mic. The app owns the state, this only draws it.

const _ytt = { state: 'idle', seconds: 0, startedAt: 0, timer: null };

function _yttEl(id) { return document.getElementById(id); }

function _yttTime(total) {
    const whole = Math.max(0, Math.floor(total));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function _yttFillDevices(select, devices, chosen, emptyLabel) {
    if (!select) return;
    select.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = emptyLabel;
    select.appendChild(none);
    for (const device of devices) {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.name;
        select.appendChild(option);
    }
    select.value = devices.some(d => d.id === chosen) ? chosen : '';
}

function _yttDrawClock() {
    const status = _yttEl('yttStatus');
    if (!status || _ytt.state !== 'playing') return;
    const clock = status.querySelector('.ytt-clock');
    if (clock) clock.textContent = `${_yttTime((Date.now() - _ytt.startedAt) / 1000)} / ${_yttTime(_ytt.seconds)}`;
}

function onHubTunnelState(payload) {
    const wasPlaying = _ytt.state === 'playing';
    _ytt.state = payload.state || 'idle';
    _ytt.seconds = payload.seconds || 0;
    if (_ytt.state === 'playing' && !wasPlaying) _ytt.startedAt = Date.now();

    clearInterval(_ytt.timer);
    _ytt.timer = _ytt.state === 'playing' ? setInterval(_yttDrawClock, 1000) : null;

    const stop = _yttEl('yttStopBtn');
    if (stop) stop.disabled = _ytt.state === 'idle';
    const status = _yttEl('yttStatus');
    if (status) {
        status.classList.toggle('ytt-problem', !!payload.message || !payload.found);
        status.replaceChildren();
        if (_ytt.state === 'fetching') {
            status.textContent = t('hub.tunnel.fetching', 'Getting the song...');
        } else if (_ytt.state === 'playing') {
            const title = document.createElement('span');
            title.textContent = `${payload.title || ''} `;
            const clock = document.createElement('span');
            clock.className = 'ytt-clock';
            status.append(title, clock);
            _yttDrawClock();
        } else if (payload.message) {
            status.textContent = payload.message;
        } else if (!payload.found) {
            status.textContent = t('hub.tunnel.no_ytdlp', 'yt-dlp was not found. Set its path under YouTube tunnel in Settings, Hub modules.');
        }
    }

    // Don't redraw a list someone has open.
    const send = _yttEl('yttSend');
    const hear = _yttEl('yttHear');
    if (send && document.activeElement !== send) _yttFillDevices(send, payload.devices || [], payload.send, t('hub.tunnel.choose', 'Choose a device'));
    if (hear && document.activeElement !== hear) _yttFillDevices(hear, payload.devices || [], payload.hear, t('hub.tunnel.nowhere', "Don't play it for me"));
    const sendVolume = _yttEl('yttSendVolume');
    const hearVolume = _yttEl('yttHearVolume');
    if (sendVolume && document.activeElement !== sendVolume) sendVolume.value = payload.sendVolume ?? 100;
    if (hearVolume && document.activeElement !== hearVolume) hearVolume.value = payload.hearVolume ?? 50;
}

function yttPlay() {
    const link = _yttEl('yttLink');
    sendToCS({ action: 'hubTunnelPlay', link: link ? link.value : '' });
}

function yttStop() {
    sendToCS({ action: 'hubTunnelStop' });
}

function yttDevicesChanged() {
    sendToCS({ action: 'hubTunnelDevices', send: _yttEl('yttSend')?.value || '', hear: _yttEl('yttHear')?.value || '' });
}

function yttVolumeChanged(save) {
    sendToCS({
        action: 'hubTunnelVolume',
        send: Number(_yttEl('yttSendVolume')?.value ?? 100),
        hear: Number(_yttEl('yttHearVolume')?.value ?? 50),
        save,
    });
}

/* --- Asks for the state whenever the page comes into view, since unused tabs are unloaded --- */

(function _yttWatchTab() {
    const tab = document.getElementById('tab32');
    if (!tab) { setTimeout(_yttWatchTab, 1000); return; }
    new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) sendToCS({ action: 'hubTunnelState' });
    }).observe(tab);
})();
