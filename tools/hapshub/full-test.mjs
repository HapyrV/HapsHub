// Full pass over the whole app in every language: every page, every sub-page button, every Settings section and the
// dialogs that open without VRChat. On each it looks for what qa-pass.mjs looks for (lib/inspect.mjs) and for text
// problems: translation keys shown raw, {placeholders} left in, "undefined"/"NaN", empty buttons, and English left on
// screen although the language has its own words for it. In English it also scrolls every list (real mouse wheel, then
// to the end and back), switches Settings switches and plugins off and on again, and tries every colour theme.
// Throwaway copy, no login, no VRChat traffic. Stops only what it started.
//   node tools/hapshub/full-test.mjs [--langs en,ru] [--skip scroll,toggles,plugins,themes,modals,subtabs]
//                                    [--shots dir] [--report file]
// --shots saves a half-size picture of every page in every language plus contact sheets (shots/sheets/<lang>-N.png).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSPECT } from './lib/inspect.mjs';
import { ROOT, cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const PORT = 9357;
const arg = name => process.argv.includes('--' + name) ? process.argv[process.argv.indexOf('--' + name) + 1] : null;
const skip = new Set((arg('skip') || '').split(',').filter(Boolean));
const shots = arg('shots');
const reportFile = arg('report');
const LANG_FILES = { en: 'en', de: 'de', es: 'es', fr: 'fr', ja: 'ja', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', ru: 'ru', ko: 'ko', uk: 'uk' };
const langs = arg('langs') ? arg('langs').split(',') : Object.keys(LANG_FILES);
const readLang = code => JSON.parse(readFileSync(join(ROOT, 'frontend', 'i18n', LANG_FILES[code] + '.json'), 'utf8').replace(/^﻿/, ''));
const EN = readLang('en');

// qa-pass looks inside .modal-overlay only; dialogs here are marked data-ft-modal, so they are looked at too.
const INSPECT_ALL = INSPECT.replace(`'#taskbar *, .modal-overlay[style*="flex"] *'`, `'#taskbar *, .modal-overlay[style*="flex"] *, [data-ft-modal], [data-ft-modal] *'`);
// With a dialog open, only the dialog is looked at: the page behind it is covered on purpose.
const INSPECT_DIALOG = INSPECT_ALL.replace(`const root = document.querySelector('.tab.active') || document.body;`, `const root = document.querySelector('[data-ft-modal]') || document.querySelector('.tab.active') || document.body;`);
if (INSPECT_ALL === INSPECT || INSPECT_DIALOG === INSPECT_ALL) throw new Error('lib/inspect.mjs changed: the dialog scope could not be added');

// Switches never flipped: they reach outside the test copy (autostart, sharing data with outside databases, VRChat's
// own files) or restart things.
const NO_TOGGLE = new Set(['setStartWithWindows', 'setAutoUpdate', 'setRestartAfterCrash', 'setMediaFixEnabled', 'setRegBackupEnabled',
    'setAvtrdbReport', 'setAvtrIcuReport', 'setAvtrdbSubmit', 'setAvtrIcuSubmit', 'setVrcndbSubmit', 'setVrcndbReport', 'setVrcndbSyncLikes', 'setVrcndbSyncWears']);

// Dialogs that open without VRChat, and the ones that show one item (they ask the app, which answers "not signed in").
const DIALOGS = [
    ['openChangelogModal'], ['openNavEditor'], ['openDashLayoutEditor'], ['openStatusModal'], ['openMyProfileModal'],
    ['openCreateInstanceModal'], ['openCreateGroupModal'], ['openExportModal'], ['openImportModal'], ['openLogViewerModal'],
    ['openMessageTemplatesModal'], ['openMyReportsModal'], ['openPurchaseHistoryModal'], ['openRewardCodeModal'],
    ['openThemeEditor'], ['openProfileThemeEditor'], ['openVrcConfigModal'], ['openVrcLaunchOptionsModal'], ['showLaunchModal', 'wrld_a:123'],
    ['openProfileDecoPicker'], ['openUserTagPicker', 'usr_1'],
    ['openFriendDetail', 'usr_1'], ['openUserDetail', 'usr_2'], ['openWorldDetail', 'wrld_a'], ['openAvatarDetail', 'avtr_x'], ['openGroupDetail', 'grp_x'],
];

const report = new Map();
const firstSeen = new Map(); // key -> the page a top-bar problem was first seen on
const note = (lang, page, issue, seenOn) => {
    const key = `${issue.kind}: ${issue.what} @ ${page}`;
    if (seenOn && !firstSeen.has(key)) firstSeen.set(key, seenOn);
    if (!report.has(key)) report.set(key, new Set());
    report.get(key).add(lang);
};
const untranslated = new Map(); // lang -> Map(text -> page)
const counts = { pages: 0, subtabs: 0, dialogs: 0, scrollers: 0, toggles: 0, plugins: 0, themes: 0, shots: 0 };

// ---- page-side checks (sent as source, so they must not use anything from this file) ----

function textCheck(dialogOnly) {
    const out = [], english = [];
    const en = window.__ftEn || {}, byValue = window.__ftByValue || {};
    const lang = typeof currentLanguage === 'string' ? currentLanguage : 'en';
    const here = typeof i18nBundle === 'object' ? i18nBundle : {};
    const values = window.__ftValues || new Set();
    const shown = el => {
        if (!el.getClientRects().length) return false;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    const describe = el => {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const text = (el.textContent || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 50);
        return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
    };
    const root = document.querySelector('.tab.active') || document.body;
    const scopes = (dialogOnly ? [...document.querySelectorAll('[data-ft-modal]')]
        : [root, document.getElementById('taskbar'), document.getElementById('sidebarEl'), ...document.querySelectorAll('.modal-overlay[style*="flex"]')]).filter(Boolean);
    const done = new Set();
    for (const scope of scopes) for (const el of [scope, ...scope.querySelectorAll('*')]) {
        if (done.has(el)) continue;
        done.add(el);
        if (el.closest('.msi, script, style, svg, textarea, code, pre, [contenteditable="true"], .ft-ignore') || !shown(el)) continue;
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim().replace(/\s+/g, ' ');
        const items = [['text', own], ['placeholder', el.getAttribute('placeholder')], ['tooltip', el.getAttribute('title')]];
        for (const [where, raw] of items) {
            const text = (raw || '').trim().replace(/\s+/g, ' ');
            if (!text) continue;
            if (/^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_-]+){1,}$/.test(text) && (text in en || /^(nav|settings|common|hub|worlds|friends|dashboard|library|avatars|groups|explore|profile|notifications)\./.test(text)))
                out.push({ kind: 'raw key', what: where + ' ' + describe(el) });
            else if (/\{[a-zA-Z_]\w*\}/.test(text)) out.push({ kind: 'placeholder', what: where + ' ' + describe(el) });
            else if (/(^|[\s:(/])(undefined|NaN|\[object Object\])($|[\s.,)/])/.test(text) || text === 'null') out.push({ kind: 'bad value', what: where + ' ' + describe(el) });
            if (lang !== 'en' && byValue[text] && !values.has(text)) {
                const keys = byValue[text];
                if (keys.every(k => here[k] && here[k] !== en[k])) out.push({ kind: 'english', what: where + ' "' + text.slice(0, 60) + '" (' + keys[0] + ') in ' + describe(el).slice(0, 60) });
                else english.push(text);
            }
        }
        // A button with nothing in it: no words, no icon, no picture, no tooltip.
        if ((el.tagName === 'BUTTON' || el.classList.contains('vrcn-button')) && !el.innerText.trim() && !el.querySelector('.msi, img, svg, canvas, [style*="background-image"]')
            && !el.getAttribute('title') && !el.getAttribute('aria-label') && !/background-image: url/.test(el.getAttribute('style') || '') && getComputedStyle(el).backgroundImage === 'none')
            out.push({ kind: 'empty button', what: describe(el) + ' ' + (el.getAttribute('onclick') || '').slice(0, 50) });
        if (el.dataset.i18n && !el.textContent.trim()) out.push({ kind: 'blank label', what: el.dataset.i18n });
    }
    return { out, english: [...new Set(english)] };
}

function markScrollers() {
    const list = [];
    document.querySelectorAll('[data-ft-scroll]').forEach(e => e.removeAttribute('data-ft-scroll'));
    for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el);
        if (!/auto|scroll/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < 60) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.bottom < 0 || r.top > innerHeight || !el.getClientRects().length) continue;
        const x = Math.round(Math.min(innerWidth - 2, Math.max(1, r.left + Math.min(r.width / 2, 300))));
        const y = Math.round(Math.min(innerHeight - 2, Math.max(1, Math.max(r.top, 0) + 40)));
        const hit = document.elementFromPoint(x, y);
        if (!hit || !el.contains(hit)) continue;
        el.dataset.ftScroll = String(list.length);
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        // A list that already sits at its end (a log that follows its newest line) is wheeled up instead.
        const max = el.scrollHeight - el.clientHeight;
        list.push({ i: list.length, x, y, name: el.tagName.toLowerCase() + id + cls, max, atEnd: el.scrollTop > 0 && el.scrollTop >= max - 2 });
    }
    return list;
}

function scrollState() {
    return [...document.querySelectorAll('[data-ft-scroll]')].map(e => Math.round(e.scrollTop));
}

// To the end: whatever loads more gets its chance, and something must still be on screen down there.
function scrollEnd(i, back) {
    const el = document.querySelector(`[data-ft-scroll="${i}"]`);
    if (!el) return { gone: true };
    if (back) { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); return { top: el.scrollTop }; }
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
    const r = el.getBoundingClientRect();
    const box = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, innerWidth), bottom: Math.min(r.bottom, innerHeight) };
    let shownKids = 0;
    for (const c of el.querySelectorAll('*')) {
        if (!c.getClientRects().length || c.children.length) continue;
        const cr = c.getBoundingClientRect();
        if (cr.width > 2 && cr.height > 2 && cr.bottom > box.top && cr.top < box.bottom && cr.right > box.left && cr.left < box.right) { shownKids++; if (shownKids > 2) break; }
    }
    return { top: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight, shownKids };
}

function openDialog(name, argument) {
    const fixed = () => [...document.querySelectorAll('body *')].filter(e => {
        if (!e.getClientRects().length || e.closest('#taskbar, #sidebarEl, .toast, #toastContainer')) return false;
        const s = getComputedStyle(e);
        return (s.position === 'fixed' || s.position === 'absolute' && /modal|overlay|dialog|popup/i.test(e.className)) && s.visibility !== 'hidden' && Number(s.opacity) > 0;
    });
    const before = new Set(fixed());
    if (typeof window[name] !== 'function') return Promise.resolve({ missing: true });
    let result;
    try { result = argument === undefined ? window[name]() : window[name](argument); }
    catch (e) { return Promise.resolve({ threw: String(e && e.message || e).slice(0, 160) }); }
    return Promise.race([Promise.resolve(result), new Promise(d => setTimeout(d, 1500))]).catch(() => {}).then(() => new Promise(d => setTimeout(d, 450))).then(() => {
        // Dialogs fade in from opacity 0; a test window behind other windows gets no frames, so the fade never ends.
        for (const a of document.getAnimations()) { try { a.finish(); } catch { /* endless animations can't finish */ } }
        const now = fixed().filter(e => !before.has(e));
        const tops = now.filter(e => !now.some(o => o !== e && o.contains(e))).filter(e => { const r = e.getBoundingClientRect(); return r.width > 120 && r.height > 80; });
        tops.forEach(e => e.setAttribute('data-ft-modal', '1'));
        return { opened: tops.length, what: tops.map(e => e.id || e.className).join(', ').slice(0, 120) };
    });
}

function closeDialogs(name) {
    const closer = window['close' + name.replace(/^(open|show)/, '')];
    try { if (typeof closer === 'function') closer(); } catch { /* try the next way */ }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (const m of document.querySelectorAll('[data-ft-modal]')) {
        if (m.getClientRects().length) {
            const x = m.querySelector('.modal-close, .vrcn-modal-close, .close-btn, [onclick*="close" i]:not(input), [aria-label="Close"]');
            try { if (x) x.click(); } catch { /* hidden below */ }
        }
        if (m.getClientRects().length) { m.dataset.ftHidden = m.style.display; m.style.display = 'none'; }
        m.removeAttribute('data-ft-modal');
    }
    // A dialog hidden here gets its own display back, so its next opening works as usual.
    setTimeout(() => document.querySelectorAll('[data-ft-hidden]').forEach(m => { m.style.display = m.dataset.ftHidden; m.removeAttribute('data-ft-hidden'); }), 0);
    return true;
}

// ---- the run ----

const run = async (main, lang) => {
    const page = (fn, ...args) => main.json(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);
    const pageAsync = async (fn, ...args) => JSON.parse(await main.eval(`Promise.resolve((${fn})(${args.map(a => JSON.stringify(a)).join(',')})).then(r => JSON.stringify(r))`));
    const consoleErrors = [];
    main.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') consoleErrors.push(p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)); });
    await main.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    await sleep(1200);
    // Something in the lists: made-up friends, and a page of made-up worlds in Explore.
    await main.eval(`(() => {
        const pic = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#5a7'; x.fillRect(0, 0, 64, 64); return c.toDataURL(); })();
        const friends = [];
        for (let i = 0; i < 300; i++) friends.push({ id: 'usr_' + i, displayName: i % 7 ? 'Friend ' + i : 'A rather long display name number ' + i,
            status: ['active', 'join me', 'busy', 'ask me'][i % 4], statusDescription: i % 5 ? 'Status ' + i : 'A long status that goes on and on about the day ' + i,
            location: i % 3 === 0 ? 'wrld_' + (i % 20) + ':' + i : i % 3 === 1 ? 'private' : 'offline', presence: i % 3 === 2 ? 'offline' : 'online',
            platform: 'standalonewindows', currentAvatarThumbnailImageUrl: pic, image: pic, tags: ['language_eng'], bio: '' });
        try { renderVrcFriends(friends, null); } catch (e) { console.warn(e); }
        vrcFriendsData = friends;
        window.__ftPic = pic;
    })()`);
    const labels = await main.json(`Object.fromEntries(Object.entries(NAV_ITEMS_DEF).filter(([, d]) => Number.isInteger(d.tab)).map(([k, d]) => [d.tab, k]))`);
    const tabs = await main.json(`[...document.querySelectorAll('.content > .tab')].map(t => Number(t.id.replace('tab', ''))).filter(n => !isNaN(n) && n !== 9)`);
    const sections = await main.json(`[...new Set([...document.querySelectorAll('#tab9 .settings-nav-item[onclick*="switchSettingsSection"]')].map(b => (b.getAttribute('onclick').match(/switchSettingsSection\\('([^']+)'/) || [])[1]).filter(Boolean))]`);
    const tabName = n => `${labels[n] || 'tab'} (tab ${n})`;
    const enByValue = {};
    for (const [k, v] of Object.entries(EN)) if (typeof v === 'string' && /[A-Za-z]{3}/.test(v) && v.length < 200) (enByValue[v.trim()] ||= []).push(k);
    await main.eval(`window.__ftEn = ${JSON.stringify(EN)}; window.__ftByValue = ${JSON.stringify(enByValue)};`);

    const sheet = [];
    const look = async (lang, where, { dialog = false } = {}) => {
        const errorsBefore = main.errors.length, consoleBefore = consoleErrors.length;
        for (const issue of await main.json(dialog ? INSPECT_DIALOG : INSPECT_ALL)) if (!dialog || issue.kind !== 'title') note(lang, issue.where || where, issue, issue.where && where);
        const text = await page(textCheck, dialog);
        for (const issue of text.out) note(lang, where, issue);
        if (text.english.length) {
            if (!untranslated.has(lang)) untranslated.set(lang, new Map());
            for (const s of text.english) if (!untranslated.get(lang).has(s)) untranslated.get(lang).set(s, where);
        }
        for (const e of main.errors.slice(errorsBefore)) note(lang, where, { kind: 'page error', what: String(e).split('\n')[0].slice(0, 200) });
        for (const e of consoleErrors.slice(consoleBefore)) note(lang, where, { kind: 'console error', what: e });
        if (shots) {
            const shot = await main.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 } });
            const file = join(shots, lang, `${String(sheet.length).padStart(3, '0')}-${where.replace(/\W+/g, '_').slice(0, 60)}.png`);
            writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
            sheet.push({ file, where, data: shot.result.data });
            counts.shots++;
        }
    };
    const pageErrors = async (lang, where, action) => {
        const before = main.errors.length;
        await action();
        for (const e of main.errors.slice(before)) note(lang, where, { kind: 'page error', what: String(e).split('\n')[0].slice(0, 200) });
    };

    {
        // The copy was started in this language, the way a user sees it (a live switch asks for a restart).
        const errorsAtStart = main.errors.length;
        if (shots) mkdirSync(join(shots, lang), { recursive: true });
        const want = readLang(lang)['nav.worlds'] ?? EN['nav.worlds'];
        const loaded = await waitFor(`language ${lang}`, () => main.eval(`currentLanguage === ${JSON.stringify(lang)} && i18nBundle['nav.worlds'] === ${JSON.stringify(want)}`), 20000).catch(() => false);
        if (!loaded) { note(lang, 'language', { kind: 'language', what: `${lang} did not load` }); return; }
        await main.eval(`window.__ftValues = new Set(Object.entries(i18nBundle).filter(([k, v]) => v !== (window.__ftEn[k])).map(([, v]) => String(v).trim()))`);
        console.log(`-- ${lang}`);

        for (const tab of tabs) {
            const where = tabName(tab);
            await pageErrors(lang, where, () => main.eval(`showTab(${tab})`));
            await sleep(450);
            await look(lang, where);
            counts.pages++;
            if (skip.has('subtabs')) continue;
            // Every sub-page button on the page, then back to the first one that was on.
            const buttons = await main.json(`[...document.querySelectorAll('.tab.active .sub-tab-btn')].filter(b => b.getClientRects().length && !b.disabled).map((b, i) => { b.dataset.ftSub = i; return { i, on: b.classList.contains('active'), id: (b.getAttribute('onclick') || b.id || b.dataset.filter || b.textContent).trim().slice(0, 50) }; })`);
            for (const b of buttons) {
                const sub = `${where} > ${b.id}`;
                await pageErrors(lang, sub, () => main.eval(`document.querySelector('.tab.active [data-ft-sub="${b.i}"]')?.click()`));
                await sleep(350);
                await look(lang, sub);
                counts.subtabs++;
            }
            const first = buttons.find(b => b.on);
            if (first) await main.eval(`document.querySelector('.tab.active [data-ft-sub="${first.i}"]')?.click()`).catch(() => {});
        }
        for (const section of sections) {
            const where = `settings ${section}`;
            await pageErrors(lang, where, () => main.eval(`showTab(9); switchSettingsSection(${JSON.stringify(section)})`));
            await sleep(350);
            await look(lang, where);
            counts.pages++;
        }
        await pageErrors(lang, 'settings plugin options', () => main.eval(`showTab(9); switchSettingsSection('plugins'); HUB_PLUGINS.forEach(p => _hubPluginHasOptions(p) && hubPluginToggleOptions(p.id, true))`));
        await sleep(500);
        await look(lang, 'settings plugin options');
        await main.eval(`HUB_PLUGINS.forEach(p => _hubPluginHasOptions(p) && hubPluginToggleOptions(p.id, false))`);

        if (!skip.has('modals')) {
            await main.eval(`showTab(0)`);
            for (const [name, argument] of DIALOGS) {
                const where = `dialog ${name}`;
                const before = main.errors.length;
                const opened = await pageAsync(openDialog, name, argument);
                if (opened.threw) note(lang, where, { kind: 'dialog threw', what: opened.threw });
                else if (!opened.missing && opened.opened) { await look(lang, where, { dialog: true }); counts.dialogs++; }
                else if (!opened.missing) note(lang, where, { kind: 'dialog', what: 'nothing opened (may need VRChat)' });
                for (const e of main.errors.slice(before)) note(lang, where, { kind: 'page error', what: String(e).split('\n')[0].slice(0, 200) });
                await page(closeDialogs, name);
                await sleep(250);
            }
        }

        if (shots && sheet.length) {
            // Contact sheets: 16 half-size pages on one window-sized picture.
            mkdirSync(join(shots, 'sheets'), { recursive: true });
            for (let s = 0; s * 16 < sheet.length; s++) {
                const part = sheet.slice(s * 16, s * 16 + 16);
                await main.eval(`(() => {
                    const d = document.createElement('div'); d.id = 'ftSheet';
                    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000;display:grid;grid-template-columns:repeat(4,320px);grid-auto-rows:180px';
                    d.innerHTML = ${JSON.stringify(part.map(p => `<div style="position:relative"><img src="data:image/png;base64,${p.data}" style="width:320px;height:180px;display:block"><span style="position:absolute;left:0;bottom:0;background:#000c;color:#ff0;font:10px monospace;padding:1px 3px">${p.where.replace(/[<&]/g, '')}</span></div>`).join(''))};
                    document.body.appendChild(d); })()`);
                await sleep(400);
                const shot = await main.send('Page.captureScreenshot', { format: 'png' });
                writeFileSync(join(shots, 'sheets', `${lang}-${s + 1}.png`), Buffer.from(shot.result.data, 'base64'));
                await main.eval(`document.getElementById('ftSheet')?.remove()`);
            }
        }
        console.log(`   ${lang}: ${main.errors.length - errorsAtStart} page error(s), ${report.size} problem line(s) so far`);
    }

    // Scrolling, switches, themes and plugins don't depend on the language: English only.
    if (lang !== 'en') return;

    if (!skip.has('scroll')) {
        // Every list that scrolls, on every page: the mouse wheel must move it, and its end must show something.
        const places = [...tabs.map(t => [tabName(t), `showTab(${t})`]), ...sections.map(s => [`settings ${s}`, `showTab(9); switchSettingsSection(${JSON.stringify(s)})`])];
        for (const [where, open] of places) {
            await pageErrors('en', where, () => main.eval(open));
            await sleep(400);
            const list = await page(markScrollers);
            for (const s of list) {
                const before = await page(scrollState);
                for (let k = 0; k < 3; k++) await main.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.x, y: s.y, deltaX: 0, deltaY: s.atEnd ? -240 : 240 });
                await sleep(450);
                const after = await page(scrollState);
                if (!after.some((v, i) => v !== before[i])) note('en', where, { kind: 'wheel', what: `the mouse wheel does not scroll ${s.name}` });
                await pageErrors('en', where, async () => {
                    const end = await page(scrollEnd, s.i, false);
                    await sleep(600);
                    if (!end.gone && end.shownKids === 0) note('en', where, { kind: 'scroll', what: `${s.name} shows nothing at its end (${end.top}/${end.max})` });
                    if (!end.gone) for (const issue of await main.json(INSPECT_ALL)) if (issue.kind !== 'title') note('en', issue.where || where + ' (scrolled)', issue);
                    await page(scrollEnd, s.i, true);
                });
                counts.scrollers++;
            }
        }
    }

    if (!skip.has('toggles')) {
        // Every Settings switch: on, look, back. Plugin and module switches are the plugins pass's job.
        for (const section of sections) {
            const where = `settings ${section}`;
            await main.eval(`showTab(9); switchSettingsSection(${JSON.stringify(section)})`);
            await sleep(300);
            const boxes = await main.json(`[...document.querySelectorAll('#tab9 input[type=checkbox]')].filter(b => b.id && !${JSON.stringify([...NO_TOGGLE])}.includes(b.id)
                && !b.closest('.hub-plugin-opts, #hubModulesList, .hub-plugin-row') && !b.disabled
                && (b.getClientRects().length || b.closest('label')?.getClientRects().length)).map(b => b.id)`);
            for (const id of boxes) {
                await pageErrors('en', `${where} switch #${id}`, async () => {
                    const was = await main.eval(`document.getElementById(${JSON.stringify(id)}).checked`);
                    await main.eval(`document.getElementById(${JSON.stringify(id)}).click()`);
                    await sleep(300);
                    const flipped = await main.eval(`document.getElementById(${JSON.stringify(id)}).checked`);
                    if (flipped === was) note('en', where, { kind: 'switch', what: `#${id} did not change when clicked` });
                    for (const issue of await main.json(INSPECT_ALL)) if (issue.kind !== 'title') note('en', `${where} with #${id} ${flipped ? 'on' : 'off'}`, issue);
                    await main.eval(`document.getElementById(${JSON.stringify(id)}).checked !== ${was} && document.getElementById(${JSON.stringify(id)}).click()`);
                    await sleep(250);
                    if (await main.eval(`document.getElementById(${JSON.stringify(id)}).checked`) !== was) note('en', where, { kind: 'switch', what: `#${id} did not go back` });
                });
                counts.toggles++;
            }
        }
    }

    if (!skip.has('themes')) {
        await main.eval(`showTab(9); switchSettingsSection('appearance')`);
        await sleep(300);
        const chips = await main.json(`[...document.querySelectorAll('#tab9 .theme-chip')].filter(c => !c.closest('#languageGrid') && c.getClientRects().length).map((c, i) => { c.dataset.ftTheme = i; return { i, on: c.classList.contains('active'), name: c.textContent.trim().slice(0, 30) }; })`);
        for (const c of chips) {
            await pageErrors('en', `theme ${c.name}`, async () => {
                await main.eval(`document.querySelector('[data-ft-theme="${c.i}"]')?.click()`);
                await sleep(300);
                for (const t of [0, 1]) { await main.eval(`showTab(${t})`); await sleep(300); for (const issue of await main.json(INSPECT_ALL)) if (issue.kind !== 'title') note('en', `theme ${c.name} on ${tabName(t)}`, issue); }
                await main.eval(`showTab(9); switchSettingsSection('appearance')`);
                await sleep(200);
            });
            counts.themes++;
        }
        const first = chips.find(c => c.on);
        if (first) await main.eval(`document.querySelector('[data-ft-theme="${first.i}"]')?.click()`);
    }

    if (!skip.has('plugins')) {
        // A plugin switched off takes its sidebar entries with it, and switched on brings them back.
        const plugins = await main.json(`HUB_PLUGINS.filter(p => (p.nav || []).length).map(p => ({ id: p.id, tabs: p.nav.map(k => NAV_ITEMS_DEF[k]?.tab).filter(Number.isInteger) }))`);
        const navShown = tab => main.eval(`[...document.querySelectorAll('#sidebarEl .nav-btn[onclick*="showTab(${tab})"]')].some(b => b.getClientRects().length && getComputedStyle(b).display !== 'none')`);
        for (const p of plugins) {
            await pageErrors('en', `plugin ${p.id}`, async () => {
                const before = {};
                for (const t of p.tabs) before[t] = await navShown(t);
                await main.eval(`hubPluginSet(${JSON.stringify(p.id)}, false)`);
                await waitFor('switch answered', () => main.eval(`hubPluginsSettled()`), 15000).catch(() => {});
                await sleep(250);
                for (const t of p.tabs) if (await navShown(t)) note('en', `plugin ${p.id}`, { kind: 'plugin', what: `off, but the sidebar still has ${tabName(t)}` });
                await main.eval(`hubPluginSet(${JSON.stringify(p.id)}, true)`);
                await waitFor('switch answered', () => main.eval(`hubPluginsSettled()`), 15000).catch(() => {});
                await sleep(250);
                for (const t of p.tabs) if (before[t] && !await navShown(t)) note('en', `plugin ${p.id}`, { kind: 'plugin', what: `on again, but ${tabName(t)} did not come back to the sidebar` });
            });
            counts.plugins++;
        }
    }
    await main.send('Emulation.clearDeviceMetricsOverride');
};

const started = Date.now();
for (const lang of langs) {
    const dir = freshData('hapshub-full-', { Language: lang });
    try {
        const main = await openMain(dir, PORT);
        await run(main, lang);
    } catch (error) {
        note(lang, 'run', { kind: 'run', what: (error.stack || error.message).split('\n').slice(0, 3).join(' | ') });
    } finally {
        await cleanUp(dir);
    }
}

const kinds = {};
for (const key of report.keys()) { const kind = key.split(':')[0]; kinds[kind] = (kinds[kind] || 0) + 1; }
const allLangs = langs.join(',');
const lines = [...report].sort().map(([key, set]) => `- ${key}${firstSeen.has(key) ? ` (first on ${firstSeen.get(key)})` : ''}  [${[...set].join(',') === allLangs ? 'every language' : [...set].join(',')}]`);
const summary = `Full test: ${report.size} problem line(s) ${JSON.stringify(kinds)}; ${JSON.stringify(counts)}; ${Math.round((Date.now() - started) / 60000)} min.`;
const english = [...untranslated].map(([lang, m]) => `## ${lang}: ${m.size} English string(s) on screen without their own translation\n` + [...m].slice(0, 400).map(([s, w]) => `- "${s.slice(0, 80)}" @ ${w}`).join('\n'));
if (reportFile) writeFileSync(reportFile, `# HapsHub full test\n\n${summary}\n\n## Problems\n${lines.join('\n')}\n\n${english.join('\n\n')}\n`);
console.log(summary);
for (const l of lines.slice(0, 120)) console.log(l.slice(0, 300));
if (lines.length > 120) console.log(`... ${lines.length - 120} more in the report file`);
for (const [lang, m] of untranslated) console.log(`untranslated on screen, ${lang}: ${m.size}`);
process.exit(report.size ? 1 : 0);
