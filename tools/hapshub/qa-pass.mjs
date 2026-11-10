// QA pass: opens every page and every Settings section in a throwaway copy, at several window sizes, display scalings,
// languages and text sizes, and reports what looks broken: page errors, things poking out sideways, text cut off without
// "...", controls on top of each other, missing icons, pages without a title. Every slider is pushed to both ends.
//   node tools/hapshub/qa-pass.mjs [--quick] [--shots dir]
// --quick runs one setup only. --shots saves a picture of each page that had a problem.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const PORT = 9356;
const quick = process.argv.includes('--quick');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const SETUPS = [
    { name: '1280x720 100% English', width: 1280, height: 720, scale: 1, language: 'en', font: 0 },
    { name: '1920x1080 150% English', width: 1280, height: 720, scale: 1.5, language: 'en', font: 0 },
    { name: '960x600 125% Russian', width: 960, height: 600, scale: 1.25, language: 'ru', font: 0 },
    { name: '1280x720 100% German, larger text', width: 1280, height: 720, scale: 1, language: 'de', font: 4 },
    { name: '1280x720 100% Japanese', width: 1280, height: 720, scale: 1, language: 'ja', font: 0 },
];

// Runs in the page: what's wrong with what's on screen now.
const INSPECT = `(() => {
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
        if ((field || (hasText && el.closest('button, select, .vn-select, label'))) && !el.closest('.msi') && !/mono|consol|courier/i.test(s.fontFamily) && s.fontFamily.split(',')[0].trim() !== appFont)
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
        for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { range.selectNodeContents(n); lines.push(...range.getClientRects()); }
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

const SLIDERS = `(() => {
    const out = [];
    for (const slider of document.querySelectorAll('.tab.active input[type=range]')) {
        for (const value of [slider.min || 0, slider.max || 100]) {
            slider.value = value;
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
        out.push(slider.id || slider.className);
    }
    return out;
})()`;

const report = new Map();
const note = (setup, page, issue) => {
    const key = `${issue.kind}: ${issue.what} @ ${page}`;
    if (!report.has(key)) report.set(key, new Set());
    report.get(key).add(setup);
};

let sliderCount = 0;
const dir = freshData('hapshub-qa-');
try {
    const main = await openMain(dir, PORT);
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    // Lists only show their layout with something in them: a few hundred made-up friends fill the friend lists.
    await main.eval(`(() => {
        const pic = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#5a7'; x.fillRect(0, 0, 64, 64); return c.toDataURL(); })();
        const friends = [];
        for (let i = 0; i < 400; i++) friends.push({ id: 'usr_' + i, displayName: i % 7 ? 'Friend ' + i : 'A rather long display name number ' + i,
            status: ['active', 'join me', 'busy', 'ask me'][i % 4], statusDescription: i % 5 ? 'Status ' + i : 'A long status that goes on and on about the day ' + i,
            location: i % 3 === 0 ? 'wrld_' + (i % 20) + ':' + i : i % 3 === 1 ? 'private' : 'offline', presence: i % 3 === 2 ? 'offline' : 'online',
            platform: 'standalonewindows', currentAvatarThumbnailImageUrl: pic, image: pic, tags: ['language_eng'], bio: '' });
        try { renderVrcFriends(friends, null); } catch (e) { console.warn(e); }
        vrcFriendsData = friends;
    })()`);
    const tabs = await main.json(`[...document.querySelectorAll('.content > .tab')].map(t => Number(t.id.replace('tab', ''))).filter(n => !isNaN(n))`);
    const sections = await main.json(`[...new Set([...document.querySelectorAll('#tab9 .settings-nav-item[onclick*="switchSettingsSection"]')].map(b => (b.getAttribute('onclick').match(/switchSettingsSection\\('([^']+)'/) || [])[1]).filter(Boolean))]`);
    for (const setup of quick ? SETUPS.slice(0, 1) : SETUPS) {
        await main.send('Emulation.setDeviceMetricsOverride', { width: setup.width, height: setup.height, deviceScaleFactor: setup.scale, mobile: false });
        await main.eval(`(() => { if (typeof setLanguage === 'function') setLanguage(${JSON.stringify(setup.language)}); else if (typeof requestTranslation === 'function') requestTranslation(${JSON.stringify(setup.language)}); document.documentElement.style.setProperty('--fs-off', '${setup.font}px'); })()`);
        await sleep(1500);
        const errorsBefore = main.errors.length;
        const visit = async (page, open) => {
            await main.eval(open);
            await sleep(450);
            for (const issue of await main.json(INSPECT)) note(setup.name, issue.where || page, issue);
            if (shots && [...report.keys()].some(k => k.endsWith('@ ' + page))) await main.screenshot(join(shots, `${page.replace(/\W+/g, '_')}-${setup.name.replace(/\W+/g, '_')}.png`));
        };
        for (const tab of tabs) {
            if (tab === 9) continue;
            await visit(`tab ${tab}`, `showTab(${tab})`);
            if (setup === SETUPS[0]) sliderCount += (await main.json(SLIDERS)).length;
        }
        for (const section of sections) {
            await visit(`settings ${section}`, `showTab(9); switchSettingsSection(${JSON.stringify(section)})`);
            if (setup === SETUPS[0]) sliderCount += (await main.json(SLIDERS)).length;
        }
        // Every plugin's options, folded open in the Plugins list.
        await visit('settings plugin options', `showTab(9); switchSettingsSection('plugins'); HUB_PLUGINS.forEach(p => _hubPluginHasOptions(p) && hubPluginToggleOptions(p.id, true))`);
        for (const error of main.errors.slice(errorsBefore)) note(setup.name, 'page', { kind: 'error', what: String(error).split('\n')[0].slice(0, 200) });
    }
    await main.send('Emulation.clearDeviceMetricsOverride');
} catch (error) {
    note('run', 'run', { kind: 'error', what: error.message });
} finally {
    await cleanUp(dir);
}

const kinds = {};
for (const key of report.keys()) { const kind = key.split(':')[0]; kinds[kind] = (kinds[kind] || 0) + 1; }
console.log(`QA pass: ${report.size} problem(s) ${JSON.stringify(kinds)}; ${sliderCount} sliders pushed to both ends.`);
for (const [key, setups] of [...report].sort()) console.log(`- ${key}  [${[...setups].length === (quick ? 1 : SETUPS.length) ? 'every setup' : [...setups].join('; ')}]`);
process.exit(report.size ? 1 : 0);
