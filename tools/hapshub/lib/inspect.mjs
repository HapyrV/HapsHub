// What looks broken on screen now, shared by qa-pass.mjs and full-test.mjs. Runs in the page; returns a list of
// { kind, what, where }: page errors, things poking out sideways, text cut off without "...", controls on top of each
// other, missing icons, plain Windows controls, a page without a title.
export const INSPECT = `(() => {
    const out = [];
    const view = { w: innerWidth, h: innerHeight };
    const describe = el => {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
        const text = (el.textContent || el.value || el.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
        return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
    };
    const shown = el => {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };
    // What's actually visible of an element once every scrolling or clipping box around it has cut it down.
    const visible = el => {
        let r = el.getBoundingClientRect();
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
            const ps = getComputedStyle(p);
            if (!/hidden|clip|auto|scroll/.test(ps.overflowX + ps.overflowY)) continue;
            const pr = p.getBoundingClientRect();
            box = { left: Math.max(box.left, pr.left), top: Math.max(box.top, pr.top), right: Math.min(box.right, pr.right), bottom: Math.min(box.bottom, pr.bottom) };
            if (box.right <= box.left || box.bottom <= box.top) return null;
        }
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.right - box.left, height: box.bottom - box.top };
    };
    const where = el => el.closest('#taskbar') ? 'top bar' : null;
    const root = document.querySelector('.tab.active') || document.body;
    const scope = [...root.querySelectorAll('*'), ...document.querySelectorAll('#taskbar *, .modal-overlay[style*="flex"] *')];

    // The window scrolling sideways means something is wider than it.
    if (document.documentElement.scrollWidth > view.w + 1) out.push({ kind: 'wide', what: 'the window scrolls sideways by ' + (document.documentElement.scrollWidth - view.w) + 'px' });
    const content = document.querySelector('.content');
    if (content && content.scrollWidth > content.clientWidth + 1) out.push({ kind: 'wide', what: 'the page scrolls sideways by ' + (content.scrollWidth - content.clientWidth) + 'px' });

    const controls = [];
    const texts = [];
    const appFont = getComputedStyle(document.body).fontFamily.split(',')[0].trim();
    for (const el of scope) {
        if (!shown(el)) continue;
        const s = getComputedStyle(el);
        // A Windows-looking control: a select that never got the themed dropdown, a plain white checkbox, or the
        // system font instead of the app's.
        if (el.tagName === 'SELECT' && !el._vnSelect && !el.hasAttribute('data-no-vn')) out.push({ kind: 'native', what: 'plain select ' + describe(el), where: where(el) });
        if (el.tagName === 'INPUT' && el.type === 'checkbox' && s.appearance !== 'none') out.push({ kind: 'native', what: 'plain checkbox ' + describe(el), where: where(el) });
        const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        const field = (el.tagName === 'INPUT' && /^(text|search|number|password|email|url|)$/.test(el.type)) || el.tagName === 'TEXTAREA';
        if ((field || (hasText && el.closest('button, select, .vn-select, label'))) && !el.closest('.msi, .font-preview') &&!/mono|consol|courier/i.test(s.fontFamily) && s.fontFamily.split(',')[0].trim() !== appFont)
            out.push({ kind: 'font', what: describe(el) + ' uses ' + s.fontFamily.split(',')[0], where: where(el) });
        // Text cut off with no "..." to show it.
        const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        const seen = visible(el);
        if (!seen || seen.width < 2 || seen.height < 2) continue;
        if (ownText && /hidden|clip/.test(s.overflowX) && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)
            out.push({ kind: 'clipped', what: describe(el) + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ')', where: where(el) });
        // Off the right edge of the window.
        const r = el.getBoundingClientRect();
        if ((ownText || /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) && r.right > view.w + 1 && r.left < view.w && !el.closest('[style*="overflow"], .vrcn-scrollbar'))
            out.push({ kind: 'offscreen', what: describe(el) + ' ends at ' + Math.round(r.right) + 'px of ' + view.w, where: where(el) });
        // A missing icon shows its name as wide text.
        if (el.classList.contains('msi') && el.textContent.trim() && !/\\s/.test(el.textContent.trim()) && r.width > parseFloat(s.fontSize) * 1.6)
            out.push({ kind: 'icon', what: 'missing icon "' + el.textContent.trim() + '"', where: where(el) });
        // Inline links wrap across lines and their line boxes touch; only boxes are compared.
        if ((/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName) || el.classList.contains('toggle')) && s.display !== 'inline') controls.push([el, seen]);
        if (ownText && !el.closest('button, a, select, label.toggle, .vn-select')) texts.push(el);
    }
    // Text running under a switch or button: compares the text's own line boxes, not its element's box.
    for (const el of texts) {
        const range = document.createRange();
        const lines = [];
        // Line boxes are cut down to what a scrolling or clipping box around the text lets through.
        const cut = visible(el);
        if (!cut) continue;
        for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) {
            range.selectNodeContents(n);
            for (const r of range.getClientRects()) {
                const b = { left: Math.max(r.left, cut.left), top: Math.max(r.top, cut.top), right: Math.min(r.right, cut.right), bottom: Math.min(r.bottom, cut.bottom) };
                if (b.right > b.left && b.bottom > b.top) lines.push(b);
            }
        }
        for (const [c, rc] of controls) {
            if (c.contains(el) || el.contains(c) || (c.tagName === 'INPUT' && el.classList.contains('msi'))) continue;
            const hit = lines.find(r => Math.min(r.right, rc.right) - Math.max(r.left, rc.left) > 3 && Math.min(r.bottom, rc.bottom) - Math.max(r.top, rc.top) > 3);
            if (hit) { out.push({ kind: 'overlap', what: 'text ' + describe(el) + ' under ' + describe(c), where: where(el) || where(c) }); break; }
        }
    }
    // Controls on top of each other: more than a third of the smaller one covered, and neither inside the other.
    for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
            const [a, ra] = controls[i], [b, rb] = controls[j];
            if (a.contains(b) || b.contains(a)) continue;
            const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (w <= 2 || h <= 2) continue;
            const small = Math.min(ra.width * ra.height, rb.width * rb.height);
            if (w * h > small / 3) out.push({ kind: 'overlap', what: describe(a) + ' and ' + describe(b), where: where(a) || where(b) });
        }
    }
    const title = document.getElementById('pageTitle')?.textContent.trim();
    if (!title) out.push({ kind: 'title', what: 'the page has no title' });
    return out;
})()`;
