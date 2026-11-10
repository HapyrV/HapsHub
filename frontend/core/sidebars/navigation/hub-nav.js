// Edit the sidebar where it is, without opening the editor:
//  - drag a page to move it: onto a group's name to put it in that group, between pages to place it, out of a
//    group's pop-out to take it out; groups and headers can be dragged too
//  - double-click a group or a header to rename it
//  - right-click, or the + at the bottom, to add a group or a header, hide a page, or bring a hidden one back
// The full editor (icons, start page) stays under right-click > Edit Navigation.

const _hubNav = { drag: null, swallowClick: false };

function _hubNavT(key, fallback) { return typeof t === 'function' ? t(key, fallback) : fallback; }

function _hubNavState() { return navLoadLayout(); }

function _hubNavSave(state) {
    navSaveLayout(state.layout, state.hidden, state.start);
    navRender();
}

/** Takes a page out of wherever it is. Returns its entry, keeping a top-level icon choice. */
function _hubNavTakeItem(layout, key) {
    for (let i = 0; i < layout.length; i++) {
        const entry = layout[i];
        if (entry.type === 'item' && entry.key === key) return layout.splice(i, 1)[0];
        if (entry.type === 'folder') {
            const at = (entry.items || []).indexOf(key);
            if (at >= 0) { entry.items.splice(at, 1); return { type: 'item', key, icon: null }; }
        }
    }
    return { type: 'item', key, icon: null };
}

/** Moves what was dragged to where it was dropped, and saves. */
function hubNavMove(drag, drop) {
    const state = _hubNavState();
    const layout = state.layout;
    let entry;
    if (drag.kind === 'item') {
        if (drop.kind === 'item' && drop.key === drag.key) return false;
        entry = _hubNavTakeItem(layout, drag.key);
    } else {
        if (drop.id === drag.id) return false;
        const at = layout.findIndex(e => e.id === drag.id);
        if (at < 0) return false;
        entry = layout.splice(at, 1)[0];
    }
    if (drop.mode === 'into' && drag.kind === 'item') {
        const folder = layout.find(e => e.type === 'folder' && e.id === drop.id);
        if (!folder) return false;
        folder.items.push(drag.key);
    } else if (drop.folderId && drag.kind === 'item') {
        const folder = layout.find(e => e.type === 'folder' && e.id === drop.folderId);
        const at = folder ? folder.items.indexOf(drop.key) : -1;
        if (at < 0) return false;
        folder.items.splice(drop.mode === 'after' ? at + 1 : at, 0, drag.key);
    } else {
        // Top level: next to a page, a header or a group. Something dropped inside a group goes next to that group.
        const target = drop.folderId || drop.id;
        let at = layout.findIndex(e => (drop.kind === 'item' && !drop.folderId && e.type === 'item' && e.key === drop.key) || (target && e.id === target));
        if (at < 0) at = layout.length - 1;
        layout.splice(drop.mode === 'before' ? at : at + 1, 0, drag.kind === 'item' ? { type: 'item', key: drag.key, icon: entry.icon || null } : entry);
    }
    _hubNavSave(state);
    return true;
}

// ---- Dragging ----

function _hubNavSource(el) {
    const item = el.closest?.('#navEl .nav-btn[data-nav-key], .nav-folder-cell[data-nav-key]');
    if (item) return { kind: 'item', key: item.dataset.navKey, el: item };
    const sep = el.closest?.('#navEl .nav-sep[data-sep-id]');
    if (sep) return { kind: 'sep', id: sep.dataset.sepId, el: sep };
    const group = el.closest?.('#navEl .nav-group-btn');
    if (group) return { kind: 'folder', id: group.closest('.nav-group')?.dataset.groupId, el: group };
    return null;
}

function _hubNavTarget(x, y, drag) {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.closest('#navEl')) return null;
    const box = node => node.getBoundingClientRect();
    const half = node => (y < box(node).top + box(node).height / 2 ? 'before' : 'after');
    const groupBtn = el.closest('.nav-group-btn');
    if (groupBtn) {
        const id = groupBtn.closest('.nav-group')?.dataset.groupId;
        // A page dropped on a group's name goes into the group; a group or header goes beside it.
        return drag.kind === 'item' ? { kind: 'folder', id, mode: 'into', el: groupBtn } : { kind: 'folder', id, mode: half(groupBtn), el: groupBtn };
    }
    const item = el.closest('.nav-btn[data-nav-key]');
    if (item) {
        const folderId = item.closest('.nav-group')?.dataset.groupId || null;
        return { kind: 'item', key: item.dataset.navKey, folderId, mode: half(item), el: item };
    }
    const sep = el.closest('.nav-sep[data-sep-id]');
    if (sep) return { kind: 'sep', id: sep.dataset.sepId, mode: half(sep), el: sep };
    // Below everything: the end of the list.
    const last = [...document.querySelectorAll('#navEl > .nav-btn, #navEl > .nav-sep, #navEl > .nav-group')].pop();
    if (!last) return null;
    if (last.classList.contains('nav-group')) return { kind: 'folder', id: last.dataset.groupId, mode: 'after', el: last.querySelector('.nav-group-btn') };
    if (last.classList.contains('nav-sep')) return { kind: 'sep', id: last.dataset.sepId, mode: 'after', el: last };
    return { kind: 'item', key: last.dataset.navKey, mode: 'after', el: last };
}

function _hubNavMark(target) {
    document.querySelectorAll('.hub-drop-before, .hub-drop-after, .hub-drop-into').forEach(e => e.classList.remove('hub-drop-before', 'hub-drop-after', 'hub-drop-into'));
    if (target?.el) target.el.classList.add(`hub-drop-${target.mode}`);
}

function _hubNavEndDrag() {
    const drag = _hubNav.drag;
    _hubNav.drag = null;
    if (!drag) return;
    drag.ghost?.remove();
    document.body.classList.remove('hub-nav-dragging');
    _hubNavMark(null);
}

document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('input, .hub-nav-rename')) return;
    const source = _hubNavSource(event.target);
    if (!source) return;
    _hubNav.drag = { ...source, x: event.clientX, y: event.clientY, started: false };
});

document.addEventListener('mousemove', event => {
    const drag = _hubNav.drag;
    if (!drag) return;
    if (!drag.started) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.started = true;
        document.body.classList.add('hub-nav-dragging');
        const box = drag.el.getBoundingClientRect();
        drag.ghost = drag.el.cloneNode(true);
        drag.ghost.classList.add('hub-nav-ghost');
        drag.ghost.style.width = box.width + 'px';
        document.body.appendChild(drag.ghost);
        // A page dragged out of a group's pop-out: the pop-out goes so the sidebar can be dropped on.
        if (drag.el.classList.contains('nav-folder-cell') && typeof closeNavFolderPopout === 'function') closeNavFolderPopout();
    }
    drag.ghost.style.left = (event.clientX + 10) + 'px';
    drag.ghost.style.top = (event.clientY - 12) + 'px';
    drag.target = _hubNavTarget(event.clientX, event.clientY, drag);
    // Groups and headers only move at the top level.
    if (drag.kind !== 'item' && drag.target?.mode === 'into') drag.target = null;
    _hubNavMark(drag.target);
});

document.addEventListener('mouseup', () => {
    const drag = _hubNav.drag;
    if (!drag) return;
    if (drag.started) {
        const target = drag.target;
        _hubNavEndDrag();
        // The click that ends a drag isn't a click on the page.
        _hubNav.swallowClick = true;
        setTimeout(() => { _hubNav.swallowClick = false; }, 0);
        if (target) hubNavMove(drag, target);
    } else {
        _hubNav.drag = null;
    }
});

document.addEventListener('click', event => {
    if (!_hubNav.swallowClick) return;
    _hubNav.swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
}, true);

document.addEventListener('keydown', event => { if (event.key === 'Escape' && _hubNav.drag?.started) _hubNavEndDrag(); });

// ---- Renaming: double-click a group or a header ----

function hubNavRename(kind, id) {
    const node = kind === 'folder'
        ? document.querySelector(`#navEl .nav-group[data-group-id="${CSS.escape(id)}"] .nav-group-btn .nl`)
        : document.querySelector(`#navEl .nav-sep[data-sep-id="${CSS.escape(id)}"] .nav-sep-label`);
    if (!node) return;
    const input = document.createElement('input');
    input.className = 'hub-nav-rename';
    input.maxLength = 40;
    input.value = node.textContent.trim();
    node.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = save => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (save && name) {
            const state = _hubNavState();
            const entry = state.layout.find(e => e.id === id);
            if (entry) entry.name = name;
            _hubNavSave(state);
        } else {
            navRender();
        }
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('mousedown', e => e.stopPropagation());
}

document.addEventListener('dblclick', event => {
    const group = event.target.closest?.('#navEl .nav-group-btn');
    const sep = event.target.closest?.('#navEl .nav-sep[data-sep-id]');
    if (!group && !sep) return;
    event.preventDefault();
    if (group) hubNavRename('folder', group.closest('.nav-group').dataset.groupId);
    else hubNavRename('sep', sep.dataset.sepId);
});

// ---- Adding and removing ----

/** Adds a group or a header after the entry the menu was opened on (or at the end), then names it. */
function hubNavAdd(kind, after) {
    const state = _hubNavState();
    const id = kind === 'folder' ? 'folder-' + Math.random().toString(36).slice(2, 9) : 'sep-' + Math.random().toString(36).slice(2, 9);
    const entry = kind === 'folder'
        ? { type: 'folder', id, name: _hubNavT('hub.nav.new_group', 'New group'), icon: 'folder', items: [] }
        : { type: 'separator', id, name: _hubNavT('hub.nav.new_header', 'New header') };
    let at = after ? state.layout.findIndex(e => (after.key && e.type === 'item' && e.key === after.key) || (after.id && e.id === after.id) || (after.folderId && e.id === after.folderId)) : -1;
    if (at < 0) at = state.layout.length - 1;
    state.layout.splice(at + 1, 0, entry);
    _hubNavSave(state);
    hubNavRename(kind, id);
}

/** Removes a group (its pages move out to where it was) or a header. */
function hubNavRemove(id) {
    const state = _hubNavState();
    const at = state.layout.findIndex(e => e.id === id);
    if (at < 0) return;
    const [entry] = state.layout.splice(at, 1);
    if (entry.type === 'folder') state.layout.splice(at, 0, ...(entry.items || []).map(key => ({ type: 'item', key, icon: null })));
    _hubNavSave(state);
}

function hubNavHide(key, hide) {
    const state = _hubNavState();
    state.hidden = state.hidden.filter(k => k !== key);
    if (hide) state.hidden.push(key);
    _hubNavSave(state);
}

function _hubNavLabel(key) {
    const def = NAV_ITEMS_DEF[key];
    return def ? _hubNavT(def.i18n, def.label) : key;
}

/** Extra right-click entries for the sidebar. The menu adds its own after these. */
function hubNavMenuItems(el) {
    const items = [];
    const source = _hubNavSource(el);
    if (source?.kind === 'item') {
        const folderId = source.el.closest('.nav-group')?.dataset.groupId
            || (source.el.classList.contains('nav-folder-cell') ? _hubNavState().layout.find(e => e.type === 'folder' && (e.items || []).includes(source.key))?.id : null);
        if (folderId) items.push({ icon: 'logout', label: _hubNavT('hub.nav.move_out', 'Take out of the group'), action: () => hubNavMove({ kind: 'item', key: source.key }, { kind: 'folder', id: folderId, mode: 'after' }) });
        items.push({ icon: 'visibility_off', label: _hubNavT('hub.nav.hide', 'Hide this page'), action: () => hubNavHide(source.key, true) });
    } else if (source?.kind === 'folder') {
        items.push({ icon: 'edit', label: _hubNavT('hub.nav.rename_group', 'Rename group'), action: () => hubNavRename('folder', source.id) });
        items.push({ icon: 'delete', label: _hubNavT('hub.nav.remove_group', 'Remove group, keep its pages'), action: () => hubNavRemove(source.id) });
    } else if (source?.kind === 'sep') {
        items.push({ icon: 'edit', label: _hubNavT('hub.nav.rename_header', 'Rename header'), action: () => hubNavRename('sep', source.id) });
        items.push({ icon: 'delete', label: _hubNavT('hub.nav.remove_header', 'Remove header'), action: () => hubNavRemove(source.id) });
    }
    const after = source ? { key: source.kind === 'item' ? source.key : null, id: source.kind !== 'item' ? source.id : null, folderId: source.el.closest?.('.nav-group')?.dataset.groupId } : null;
    items.push({ icon: 'create_new_folder', label: _hubNavT('hub.nav.new_group', 'New group'), action: () => hubNavAdd('folder', after) });
    items.push({ icon: 'horizontal_rule', label: _hubNavT('hub.nav.add_header', 'Add header'), action: () => hubNavAdd('sep', after) });
    items.push('sep');
    return items;
}

/** The + at the bottom of the sidebar: add a group or a header, or bring back a hidden page. */
function hubNavAddMenu(button) {
    document.getElementById('hubNavAddMenu')?.remove();
    const { hidden } = _hubNavState();
    const visibleHidden = hidden.filter(k => NAV_ITEMS_DEF[k] && !(typeof hubPluginHiddenNav === 'function' && hubPluginHiddenNav().includes(k)));
    const entries = [
        ['create_new_folder', _hubNavT('hub.nav.new_group', 'New group'), () => hubNavAdd('folder', null)],
        ['horizontal_rule', _hubNavT('hub.nav.add_header', 'Add header'), () => hubNavAdd('sep', null)],
        ...visibleHidden.map(k => ['visibility', _hubNavT('hub.nav.show_page', 'Show {page}').replace('{page}', _hubNavLabel(k)), () => hubNavHide(k, false)]),
        ['tune', _hubNavT('context_menu.nav_edit', 'Edit Navigation'), () => openNavEditor()],
    ];
    const menu = document.createElement('div');
    menu.id = 'hubNavAddMenu';
    menu.className = 'hub-plugin-menu';
    entries.forEach(([icon, label, run]) => {
        const item = document.createElement('button');
        item.className = 'tb-dd-item';
        item.innerHTML = `<span class="msi">${icon}</span><span></span>`;
        item.lastChild.textContent = label;
        item.addEventListener('click', () => { menu.remove(); run(); });
        menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const box = button.getBoundingClientRect();
    menu.style.left = Math.min(box.right + 6, innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.max(8, Math.min(box.top, innerHeight - menu.offsetHeight - 8)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function close(e) {
        if (menu.contains(e.target)) return;
        menu.remove();
        document.removeEventListener('mousedown', close);
    }), 0);
}

// After every redraw: the + button at the end of the list.
(function () {
    const draw = () => {
        const nav = document.getElementById('navEl');
        if (!nav || nav.querySelector('.hub-nav-add')) return;
        const add = document.createElement('button');
        add.className = 'hub-nav-add';
        add.title = _hubNavT('hub.nav.add_title', 'Add a group or a header, or show a hidden page');
        add.innerHTML = '<span class="msi">add</span>';
        add.addEventListener('click', event => { event.stopPropagation(); hubNavAddMenu(add); });
        nav.appendChild(add);
    };
    if (typeof navRender === 'function') {
        const render = navRender;
        navRender = function (...args) { const result = render.apply(this, args); draw(); return result; };
    }
    draw();
})();
