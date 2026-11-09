/* === Your own calendar events: stored in the hub database, shown beside VRChat's. === */

const CAL_CUSTOM_OWNER = 'hub-custom';
let _calCustom = [];
let _calCustomLoaded = false;

function _calCustomLastDay(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

// Every start of one event inside a range. Built from local parts, so 20:00 stays 20:00 across clock changes.
function calCustomOccurrences(ev, from, to) {
    const start = new Date(ev.startsAt);
    const end = new Date(ev.endsAt);
    if (isNaN(start) || isNaN(end)) return [];
    const length = end - start;
    const until = ev.repeatUntil ? new Date(`${ev.repeatUntil}T23:59:59`) : null;
    const found = [];
    const y = start.getFullYear(), m = start.getMonth(), d = start.getDate();
    const h = start.getHours(), min = start.getMinutes(), s = start.getSeconds();
    for (let n = 0; n < 20000; n++) {
        let at;
        switch (ev.repeat) {
            case 'daily': at = new Date(y, m, d + n, h, min, s); break;
            case 'weekly': at = new Date(y, m, d + n * 7, h, min, s); break;
            case 'monthly': {
                // The 31st falls on the last day of shorter months instead of spilling into the next.
                const target = new Date(y, m + n, 1);
                at = new Date(target.getFullYear(), target.getMonth(), Math.min(d, _calCustomLastDay(target.getFullYear(), target.getMonth())), h, min, s);
                break;
            }
            case 'yearly':
                at = new Date(y + n, m, Math.min(d, _calCustomLastDay(y + n, m)), h, min, s);
                break;
            default:
                if (n > 0) return found;
                at = start;
        }
        if (at > to || (until && at > until)) return found;
        if (at.getTime() + length >= from.getTime()) found.push(at);
    }
    return found;
}

function _calCustomRange() {
    const ym = _calFetchYM();
    return { from: new Date(ym.year, ym.month - 1, -7), to: new Date(ym.year, ym.month, 14) };
}

// Called with what VRChat returned, and gives back the list to show.
function calCustomMerge(events) {
    if (!_calCustomLoaded) {
        sendToCS({ action: 'hubCalendarList' });
        return events;
    }
    if (calendarFilter === 'featured') return events;
    const { from, to } = _calCustomRange();
    const added = [];
    _calCustom.forEach(ev => {
        const length = new Date(ev.endsAt) - new Date(ev.startsAt);
        calCustomOccurrences(ev, from, to).forEach(at => added.push({
            id: `${ev.id}~${at.getTime()}`,
            ownerId: CAL_CUSTOM_OWNER,
            title: ev.title,
            description: ev.description,
            imageUrl: '',
            tags: [],
            startsAt: at.toISOString(),
            endsAt: new Date(at.getTime() + length).toISOString(),
            _custom: true,
        }));
    });
    return events.concat(added);
}

function onHubCalendarEvents(payload) {
    if (payload.error) {
        if (typeof showToast === 'function') showToast(false, payload.error);
        return;
    }
    _calCustom = payload.events || [];
    _calCustomLoaded = true;
    if (!calendarLoaded) return;
    _calEvents = calCustomMerge(_calEvents.filter(e => !e._custom));
    _calEvents.forEach(evt => _eventDayKeys(evt).forEach(key => _calEventDays.add(key)));
    _syncCalView();
}

// VRChat's events open their own page. Ours open the editor, on the original event, not the single repeat.
const _calCustomOpenUpstream = openEventDetail;
openEventDetail = function (groupId, calendarId) {
    if (groupId === CAL_CUSTOM_OWNER) {
        const ev = _calCustom.find(item => item.id === String(calendarId).split('~')[0]);
        if (ev) calCustomEdit(ev);
        return;
    }
    return _calCustomOpenUpstream(groupId, calendarId);
};

function _calCustomLocalInput(iso) {
    const at = new Date(iso);
    const pad = value => String(value).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function calCustomNew() {
    const base = _calSelectedDay ? new Date(`${_calSelectedDay}T20:00:00`) : new Date();
    if (!_calSelectedDay) base.setHours(base.getHours() + 1, 0, 0, 0);
    calCustomEdit({ id: '', title: '', description: '', startsAt: base.toISOString(), endsAt: new Date(base.getTime() + 3600000).toISOString(), repeat: 'none', repeatUntil: '' });
}

function calCustomEdit(ev) {
    let overlay = document.getElementById('modalCalCustom');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modalCalCustom';
        overlay.onclick = e => { if (e.target === overlay) calCustomClose(); };
        document.body.appendChild(overlay);
    }
    const repeat = [
        ['none', t('hub.calendar.repeat.none', 'Does not repeat')],
        ['daily', t('hub.calendar.repeat.daily', 'Every day')],
        ['weekly', t('hub.calendar.repeat.weekly', 'Every week')],
        ['monthly', t('hub.calendar.repeat.monthly', 'Every month')],
        ['yearly', t('hub.calendar.repeat.yearly', 'Every year')],
    ].map(([value, label]) => `<option value="${value}"${ev.repeat === value ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const label = (text, field) => `<label style="display:block;margin:10px 0 4px;font-size:calc(12px + var(--fs-off, 0px));color:var(--tx2);">${esc(text)}</label>${field}`;
    overlay.innerHTML = `<div class="modal-box narrow" style="padding:20px;max-width:440px;">
        <div class="vrcn-panel-card-header"><span class="msi">event</span> ${esc(ev.id ? t('hub.calendar.edit', 'Edit event') : t('hub.calendar.new', 'New event'))}</div>
        <input type="hidden" id="calCustomId" value="${esc(ev.id)}">
        ${label(t('hub.calendar.name', 'Name'), `<input class="vrcn-input" style="width:100%;" id="calCustomTitle" maxlength="200" value="${esc(ev.title)}">`)}
        ${label(t('hub.calendar.starts', 'Starts'), `<input class="vrcn-input" style="width:100%;" type="datetime-local" id="calCustomStart" value="${_calCustomLocalInput(ev.startsAt)}">`)}
        ${label(t('hub.calendar.ends', 'Ends'), `<input class="vrcn-input" style="width:100%;" type="datetime-local" id="calCustomEnd" value="${_calCustomLocalInput(ev.endsAt)}">`)}
        ${label(t('hub.calendar.repeat', 'Repeat'), `<select class="vrcn-input" style="width:100%;" id="calCustomRepeat">${repeat}</select>`)}
        ${label(t('hub.calendar.until', 'Repeat until (optional)'), `<input class="vrcn-input" style="width:100%;" type="date" id="calCustomUntil" value="${esc(ev.repeatUntil || '')}">`)}
        ${label(t('hub.calendar.notes', 'Notes'), `<textarea class="vrcn-input" style="width:100%;min-height:64px;" id="calCustomDescription">${esc(ev.description || '')}</textarea>`)}
        <div id="calCustomError" style="display:none;margin-top:10px;color:var(--err);font-size:calc(13px + var(--fs-off, 0px));"></div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
            ${ev.id ? `<button class="vrcn-button" style="margin-right:auto;" onclick="calCustomDelete()"><span class="msi" style="font-size:16px;">delete</span> ${esc(t('common.delete', 'Delete'))}</button>` : ''}
            <button class="vrcn-button" onclick="calCustomClose()">${esc(t('common.cancel', 'Cancel'))}</button>
            <button class="vrcn-button vrcn-btn-join" onclick="calCustomSave()">${esc(t('common.save', 'Save'))}</button>
        </div>
    </div>`;
    overlay.style.display = 'flex';
}

function calCustomClose() {
    const overlay = document.getElementById('modalCalCustom');
    if (overlay) overlay.style.display = 'none';
}

function _calCustomProblem(text) {
    const box = document.getElementById('calCustomError');
    if (!box) return;
    box.textContent = text;
    box.style.display = '';
}

function calCustomSave() {
    const start = new Date(document.getElementById('calCustomStart').value);
    const end = new Date(document.getElementById('calCustomEnd').value);
    if (isNaN(start) || isNaN(end)) return _calCustomProblem(t('hub.calendar.bad_time', 'Choose a start and an end.'));
    if (end < start) return _calCustomProblem(t('hub.calendar.bad_order', "The end can't be before the start."));
    const title = document.getElementById('calCustomTitle').value.trim();
    if (!title) return _calCustomProblem(t('hub.calendar.no_name', 'Give the event a name.'));
    sendToCS({
        action: 'hubCalendarSave',
        id: document.getElementById('calCustomId').value,
        title,
        description: document.getElementById('calCustomDescription').value,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        repeat: document.getElementById('calCustomRepeat').value,
        repeatUntil: document.getElementById('calCustomUntil').value,
    });
    calCustomClose();
}

function calCustomDelete() {
    const id = document.getElementById('calCustomId').value;
    if (id) sendToCS({ action: 'hubCalendarDelete', id });
    calCustomClose();
}
