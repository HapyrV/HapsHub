// QA pass: opens every page and every Settings section in a throwaway copy, at several window sizes, display scalings,
// languages and text sizes, and reports what looks broken: page errors, things poking out sideways, text cut off without
// "...", controls on top of each other, missing icons, pages without a title. Every slider is pushed to both ends.
//   node tools/hapshub/qa-pass.mjs [--quick] [--setup Russian] [--shots dir]
// --quick runs one setup only; --setup runs the setups whose name matches the given pattern ("150%|Russian"). --shots saves a picture of each page that had a problem.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';
import { INSPECT } from './lib/inspect.mjs';

const PORT = 9356;
const quick = process.argv.includes('--quick');
const setupFilter = process.argv.includes('--setup') ? process.argv[process.argv.indexOf('--setup') + 1] : null;
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const SETUPS = [
    { name: '1280x720 100% English', width: 1280, height: 720, scale: 1, language: 'en', font: 0 },
    { name: '1920x1080 150% English', width: 1280, height: 720, scale: 1.5, language: 'en', font: 0 },
    { name: '960x600 125% Russian', width: 960, height: 600, scale: 1.25, language: 'ru', font: 0 },
    { name: '1280x720 100% German, larger text', width: 1280, height: 720, scale: 1, language: 'de', font: 4 },
    { name: '1280x720 100% Japanese', width: 1280, height: 720, scale: 1, language: 'ja', font: 0 },
];

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
    for (const setup of quick ? SETUPS.slice(0, 1) : SETUPS.filter(x => !setupFilter || new RegExp(setupFilter).test(x.name))) {
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
