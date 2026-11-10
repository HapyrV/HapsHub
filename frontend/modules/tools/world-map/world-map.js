// World Map: a globe with your friends placed by what their own profile says. Friends only, and never by IP address.
// Where someone is comes from, in this order: a flag in their bio or status, "from <country>" or "in <country>" in
// their bio, or a language tag for a language spoken mainly in one country. No clue means no pin.

const _wmap = { lon: 15, lat: 25, zoom: 1, places: new Map(), unplaced: 0, selected: null, drag: null, idleSince: 0, frame: 0, hover: null, dirty: true };

// Languages spoken mainly in one country. English, Spanish, Portuguese, Arabic, French and Chinese are left out:
// they say little about where someone lives.
const _WMAP_LANGUAGE_COUNTRY = {
    heb: 'IL', jpn: 'JP', kor: 'KR', deu: 'DE', pol: 'PL', nld: 'NL', swe: 'SE', nor: 'NO', dan: 'DK', fin: 'FI', ita: 'IT',
    ces: 'CZ', slk: 'SK', hun: 'HU', ron: 'RO', bul: 'BG', ell: 'GR', tur: 'TR', ukr: 'UA', rus: 'RU', tha: 'TH', vie: 'VN',
    ind: 'ID', msa: 'MY', fil: 'PH', tgl: 'PH', hrv: 'HR', srp: 'RS', slv: 'SI', lit: 'LT', lav: 'LV', est: 'EE', isl: 'IS',
};
const _WMAP_ALIASES = {
    usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US', 'united states': 'US', 'the us': 'US', uk: 'GB', 'u.k.': 'GB',
    england: 'GB', scotland: 'GB', wales: 'GB', britain: 'GB', 'great britain': 'GB', holland: 'NL', 'the netherlands': 'NL',
    korea: 'KR', 'south korea': 'KR', deutschland: 'DE', czech: 'CZ', 'czech republic': 'CZ', russia: 'RU', brasil: 'BR',
};

let _wmapNames = null;
function _wmapNameMap() {
    if (_wmapNames) return _wmapNames;
    _wmapNames = new Map(Object.entries(_WMAP_ALIASES));
    let display = null;
    try { display = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* old engine */ }
    for (const country of HUB_WORLD_COUNTRIES) {
        if (!country.c) continue;
        _wmapNames.set(country.n.toLowerCase(), country.c);
        const common = display?.of(country.c);
        if (common) _wmapNames.set(common.toLowerCase(), country.c);
    }
    return _wmapNames;
}

function _wmapCountry(code) { return HUB_WORLD_COUNTRIES.find(c => c.c === code) || null; }

function _wmapFlag(code) {
    return code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65)) : '';
}

/** Where a friend is, from their profile alone: { code, how } or null. */
function hubWorldPlace(friend) {
    const text = `${friend?.bio || ''}\n${friend?.statusDescription || ''}`;
    // 1. A flag: two regional indicator letters. Rainbow and other flags aren't letters, so they don't count.
    const flag = text.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
    if (flag) {
        const code = [...flag[0]].map(ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 65)).join('');
        if (_wmapCountry(code)) return { code, how: 'flag' };
    }
    // 2. "from Germany", "living in Japan": the longest country name after the words.
    const names = _wmapNameMap();
    const phrase = /\b(?:from|in|based in|living in|live in|lives in)\s+((?:the\s+)?[A-Za-z.'-]+(?:\s+[A-Za-z.'-]+){0,3})/gi;
    for (const match of text.matchAll(phrase)) {
        const words = match[1].toLowerCase().replace(/[.,!]+$/, '').split(/\s+/);
        for (let length = words.length; length > 0; length--) {
            const code = names.get(words.slice(0, length).join(' '));
            if (code && _wmapCountry(code)) return { code, how: 'bio' };
        }
    }
    // 3. A language spoken mainly in one country. Two such languages that disagree say nothing.
    const fromLanguage = [...new Set((friend?.tags || []).map(tag => /^language_([a-z]{3})$/.exec(tag)?.[1]).filter(Boolean).map(l => _WMAP_LANGUAGE_COUNTRY[l]).filter(Boolean))];
    if (fromLanguage.length === 1 && _wmapCountry(fromLanguage[0])) return { code: fromLanguage[0], how: 'language' };
    return null;
}

function hubWorldRefresh() {
    const friends = typeof vrcFriendsData !== 'undefined' && Array.isArray(vrcFriendsData) ? vrcFriendsData : [];
    const places = new Map();
    let unplaced = 0;
    for (const friend of friends) {
        const place = hubWorldPlace(friend);
        if (!place) { unplaced++; continue; }
        if (!places.has(place.code)) places.set(place.code, []);
        places.get(place.code).push({ friend, how: place.how });
    }
    _wmap.places = places;
    _wmap.unplaced = unplaced;
    _wmap.dirty = true;
    _wmapDrawSide();
}

// ---- The globe: an orthographic projection drawn on a canvas ----

const _WMAP_RAD = Math.PI / 180;

function _wmapProject(lon, lat, view) {
    const l = (lon - view.lon) * _WMAP_RAD, p = lat * _WMAP_RAD, p0 = view.lat * _WMAP_RAD;
    const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
    const x = view.r * Math.cos(p) * Math.sin(l);
    const y = view.r * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l));
    return { x: view.cx + x, y: view.cy - y, front: cosc >= 0, dx: x, dy: y };
}

function _wmapView(canvas) {
    const w = canvas.width, h = canvas.height;
    return { lon: _wmap.lon, lat: _wmap.lat, cx: w / 2, cy: h / 2, r: Math.min(w, h) * 0.42 * _wmap.zoom };
}

function _wmapColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function _wmapRender() {
    const canvas = document.getElementById('wmapCanvas');
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(box.width * ratio)), height = Math.max(1, Math.round(box.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    const view = _wmapView(canvas);
    _wmap.view = view;
    ctx.clearRect(0, 0, width, height);

    const accent = _wmapColor('--accent', '#5C76FF');
    // The sea.
    const sea = ctx.createRadialGradient(view.cx - view.r * 0.3, view.cy - view.r * 0.3, view.r * 0.1, view.cx, view.cy, view.r);
    sea.addColorStop(0, 'rgba(70, 90, 140, 0.55)');
    sea.addColorStop(1, 'rgba(20, 26, 44, 0.9)');
    ctx.beginPath();
    ctx.arc(view.cx, view.cy, view.r, 0, Math.PI * 2);
    ctx.fillStyle = sea;
    ctx.fill();

    // Lines of latitude and longitude every 30 degrees.
    ctx.lineWidth = ratio * 0.6;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let lon = -180; lon < 180; lon += 30) _wmapLine(ctx, view, step => [lon, -90 + step * 180]);
    for (let lat = -60; lat <= 60; lat += 30) _wmapLine(ctx, view, step => [-180 + step * 360, lat]);

    // Countries. A point behind the globe is pulled to its edge, which keeps the shapes closed.
    const counts = _wmap.places;
    const most = Math.max(1, ...[...counts.values()].map(list => list.length));
    for (const country of HUB_WORLD_COUNTRIES) {
        const friends = counts.get(country.c)?.length || 0;
        ctx.beginPath();
        let any = false;
        for (const ring of country.r) {
            let started = false;
            for (let i = 0; i < ring.length; i += 2) {
                const point = _wmapProject(ring[i], ring[i + 1], view);
                let { x, y } = point;
                if (!point.front) {
                    const length = Math.hypot(point.dx, point.dy) || 1;
                    x = view.cx + point.dx / length * view.r;
                    y = view.cy - point.dy / length * view.r;
                } else any = true;
                if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
            }
            ctx.closePath();
        }
        if (!any) continue;
        const selected = _wmap.selected === country.c;
        ctx.fillStyle = friends ? _wmapMix(ctx, accent, 0.6 + 0.4 * friends / most) : 'rgba(150, 165, 190, 0.22)';
        if (selected) ctx.fillStyle = accent;
        ctx.fill('evenodd');
        ctx.strokeStyle = selected ? '#fff' : friends ? 'rgba(255, 255, 255, 0.55)' : 'rgba(10, 12, 20, 0.55)';
        ctx.lineWidth = ratio * (selected ? 1.6 : friends ? 1 : 0.6);
        ctx.stroke();
    }

    // Pins: one per country with friends, sized by how many.
    _wmap.pins = [];
    ctx.font = `700 ${Math.round(11 * ratio)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [code, list] of counts) {
        const country = _wmapCountry(code);
        if (!country) continue;
        const point = _wmapProject(country.p[0], country.p[1], view);
        if (!point.front) continue;
        const radius = (7 + Math.sqrt(list.length) * 3) * ratio;
        _wmap.pins.push({ code, x: point.x, y: point.y, r: radius });
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = _wmap.selected === code ? '#fff' : accent;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 6 * ratio;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = _wmap.selected === code ? accent : '#fff';
        ctx.fillText(String(list.length), point.x, point.y + 0.5);
    }
    // A soft rim.
    ctx.beginPath();
    ctx.arc(view.cx, view.cy, view.r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = ratio;
    ctx.stroke();
    _wmap.dirty = false;
    _wmap.frame++;
}

/** The accent colour mixed into a slate grey; the canvas turns any CSS colour into #rrggbb for reading. */
function _wmapMix(ctx, color, amount) {
    ctx.fillStyle = color;
    const hex = /^#([0-9a-f]{6})$/i.exec(ctx.fillStyle)?.[1] || '5c76ff';
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    // Lifted towards white first, so a dark or grey accent still stands out from land without friends.
    const lift = [r, g, b].map(v => v + (255 - v) * 0.35);
    const base = [58, 66, 88];
    return `rgb(${lift.map((v, i) => Math.round(base[i] + (v - base[i]) * amount)).join(',')})`;
}

function _wmapLine(ctx, view, at) {
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i <= 90; i++) {
        const [lon, lat] = at(i / 90);
        const point = _wmapProject(lon, lat, view);
        if (!point.front) { drawing = false; continue; }
        if (drawing) ctx.lineTo(point.x, point.y); else { ctx.moveTo(point.x, point.y); drawing = true; }
    }
    ctx.stroke();
}

// Draws only while the page is open; spins slowly when left alone, except in Performance mode.
function _wmapLoop() {
    // Stops by itself when the page closes; opening it starts it again.
    if (!document.querySelector('.tab.active .wmap-page') || document.hidden) { _wmap.running = false; return; }
    const still = Date.now() - _wmap.idleSince > 6000 && !_wmap.drag && !document.documentElement.classList.contains('hub-perf');
    if (still && !_wmap.selected) { _wmap.lon = (_wmap.lon + 0.08 + 540) % 360 - 180; _wmap.dirty = true; }
    if (_wmap.dirty) _wmapRender();
    requestAnimationFrame(_wmapLoop);
}

function _wmapWake() {
    if (_wmap.running) return;
    _wmap.running = true;
    requestAnimationFrame(_wmapLoop);
}

function wmapZoom(factor) {
    _wmap.zoom = Math.min(6, Math.max(0.6, _wmap.zoom * factor));
    _wmap.idleSince = Date.now();
    _wmap.dirty = true;
    _wmapWake();
}

function wmapReset() {
    Object.assign(_wmap, { lon: 15, lat: 25, zoom: 1, selected: null, idleSince: 0, dirty: true });
    _wmapDrawSide();
}

/** Turns the globe to a country and opens its list. */
function wmapSelect(code) {
    const country = _wmapCountry(code);
    if (!country) return;
    _wmap.selected = _wmap.selected === code ? null : code;
    if (_wmap.selected) { _wmap.lon = country.p[0]; _wmap.lat = Math.max(-60, Math.min(60, country.p[1])); }
    _wmap.idleSince = Date.now();
    _wmap.dirty = true;
    _wmapDrawSide();
}

function _wmapDrawSide() {
    const summary = document.getElementById('wmapSummary');
    const list = document.getElementById('wmapList');
    if (!summary || !list) return;
    const placed = [..._wmap.places.values()].reduce((sum, l) => sum + l.length, 0);
    summary.textContent = tf('hub.map.summary', { placed, countries: _wmap.places.size, unplaced: _wmap.unplaced },
        '{placed} friends in {countries} countries. {unplaced} more don\'t say where they are.');
    const how = { flag: t('hub.map.how_flag', 'flag'), bio: t('hub.map.how_bio', 'bio'), language: t('hub.map.how_language', 'language') };
    const rows = [..._wmap.places.entries()].sort((a, b) => b[1].length - a[1].length).map(([code, friends]) => {
        const country = _wmapCountry(code);
        const open = _wmap.selected === code;
        const people = open ? `<div class="wmap-friends">${friends.map(({ friend, how: by }) => `<button class="wmap-friend" onclick="openFriendDetail('${esc(friend.id)}')">
            <img src="${esc(friend.image || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span>${esc(friend.displayName || friend.id)}</span><small>${esc(how[by])}</small></button>`).join('')}</div>` : '';
        return `<button class="wmap-country${open ? ' is-on' : ''}" onclick="wmapSelect('${code}')"><span class="wmap-flag">${code}</span><span class="wmap-name">${esc(country?.n || code)}</span><span class="wmap-count">${friends.length}</span></button>${people}`;
    });
    list.innerHTML = rows.join('') || `<div class="folder-empty">${esc(t('hub.map.empty', 'None of your friends say where they are yet.'))}</div>`;
}

(function () {
    const start = () => {
        const canvas = document.getElementById('wmapCanvas');
        if (!canvas || typeof HUB_WORLD_COUNTRIES === 'undefined') { setTimeout(start, 800); return; }
        canvas.addEventListener('pointerdown', event => {
            _wmap.drag = { x: event.clientX, y: event.clientY, lon: _wmap.lon, lat: _wmap.lat, moved: false };
            canvas.setPointerCapture(event.pointerId);
            canvas.classList.add('is-dragging');
        });
        canvas.addEventListener('pointermove', event => {
            const drag = _wmap.drag;
            if (drag) {
                const scale = 180 / (Math.PI * (_wmap.view?.r || 300)) * (window.devicePixelRatio || 1);
                const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
                if (Math.hypot(dx, dy) > 3) drag.moved = true;
                _wmap.lon = ((drag.lon - dx * scale) + 540) % 360 - 180;
                _wmap.lat = Math.max(-80, Math.min(80, drag.lat + dy * scale));
                _wmap.idleSince = Date.now();
                _wmap.dirty = true;
                return;
            }
            // Hovering a pin names the country and who's there.
            const box = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            const x = (event.clientX - box.left) * ratio, y = (event.clientY - box.top) * ratio;
            const pin = (_wmap.pins || []).find(p => Math.hypot(p.x - x, p.y - y) <= p.r);
            const tip = document.getElementById('wmapTip');
            if (!pin) { tip.hidden = true; return; }
            const friends = _wmap.places.get(pin.code) || [];
            tip.innerHTML = `<strong>${esc(_wmapCountry(pin.code)?.n || pin.code)}</strong><br>${friends.slice(0, 8).map(f => esc(f.friend.displayName || '')).join(', ')}${friends.length > 8 ? ' …' : ''}`;
            tip.hidden = false;
            tip.style.left = Math.min(event.clientX - box.left + 14, box.width - tip.offsetWidth - 8) + 'px';
            tip.style.top = Math.max(8, event.clientY - box.top - tip.offsetHeight - 10) + 'px';
        });
        const end = event => {
            const drag = _wmap.drag;
            _wmap.drag = null;
            canvas.classList.remove('is-dragging');
            if (!drag || drag.moved) return;
            const box = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            const pin = (_wmap.pins || []).find(p => Math.hypot(p.x - (event.clientX - box.left) * ratio, p.y - (event.clientY - box.top) * ratio) <= p.r);
            if (pin) wmapSelect(pin.code);
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', () => { _wmap.drag = null; canvas.classList.remove('is-dragging'); });
        canvas.addEventListener('pointerleave', () => { document.getElementById('wmapTip').hidden = true; });
        // The page doesn't scroll, so the wheel can zoom without holding scrolling up.
        canvas.addEventListener('wheel', event => wmapZoom(event.deltaY < 0 ? 1.12 : 0.89), { passive: true });
        new ResizeObserver(() => { _wmap.dirty = true; }).observe(canvas);
        // Friends change while HapsHub runs; the map is worked out again whenever its page is opened.
        new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { hubWorldRefresh(); _wmapWake(); } }).observe(canvas);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) _wmapWake(); });
        document.documentElement.addEventListener('themechange', () => { _wmap.dirty = true; });
        document.documentElement.addEventListener('languagechange', () => { _wmapNames = null; _wmapDrawSide(); });
        _wmapWake();
    };
    start();
})();
