// Tests the VRCT page against the real VRCT engine in a throwaway copy of HapsHub: start it, translate a Hebrew
// message with the Hebrew → English pair, then put VRCT's languages back as they were and stop the engine.
// Needs VRCT installed and not running. The message also goes to the VRChat chatbox if VRChat is open.
//   node tools/hapshub/vrct-live.mjs

import { spawnSync } from 'node:child_process';
import { checker, cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const { check, state } = checker();
if (spawnSync('tasklist', ['/FI', 'IMAGENAME eq VRCT-sidecar.exe', '/NH'], { encoding: 'utf8' }).stdout.includes('VRCT-sidecar')) {
    console.log('NOT CHECKED  VRCT is running; close it first');
    process.exit(0);
}
const dir = freshData('hapshub-vrctlive-');
try {
    const main = await openMain(dir, 9354);
    await waitFor('splash', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    await main.eval(`showTab(NAV_ITEMS_DEF.vrct.tab); vrctStart()`);
    await waitFor('the engine', () => main.eval(`_vrct.state === 'ready'`), 120000);
    check('the real engine starts', true);
    const before = await main.json(`({ your: _vrct.data.selected_your_languages, target: _vrct.data.selected_target_languages, translating: !!_vrct.on.translation })`);
    check('Hebrew, English and Japanese are offered', await main.eval(`!!_vrctFind('Hebrew') && !!_vrctFind('English') && !!_vrctFind('Japanese')`));
    await main.eval(`vrctPair('Hebrew', 'English')`);
    await sleep(1500);
    check('the pair took, and translation is on', await main.eval(`_vrctCurrent('your')?.language === 'Hebrew' && _vrctCurrent('target')?.language === 'English' && _vrct.on.translation === true`));
    await main.eval(`document.getElementById('vrctInput').value = 'שלום, מה שלומך?'; vrctSendTyped()`);
    await waitFor('a translation', () => main.eval(`_vrct.log.some(l => l.kind === 'typed' && l.translations.length > 0)`), 30000).catch(() => {});
    const line = await main.json(`_vrct.log.find(l => l.kind === 'typed') || null`);
    console.log(`      ${JSON.stringify(line)}`);
    check('a Hebrew message comes back in English', !!line && line.translations.some(t => /[a-z]/i.test(t)), JSON.stringify(line));
    // Back the way it was.
    await main.eval(`vrctSend('/set/data/selected_your_languages', ${JSON.stringify(before.your)}); vrctSend('/set/data/selected_target_languages', ${JSON.stringify(before.target)})`);
    await sleep(1500);
    check('VRCT\'s languages are put back', JSON.stringify(await main.json(`_vrct.data.selected_your_languages`)) === JSON.stringify(before.your));
    await main.eval(`vrctStop()`);
    await waitFor('the engine to stop', () => main.eval(`_vrct.state === 'off'`), 20000).catch(() => {});
    check('the engine stops', await main.eval(`_vrct.state === 'off'`));
    check('no page errors', main.errors.length === 0, main.errors.join(' | '));
} catch (error) {
    check('the run finished', false, error.message);
} finally {
    await cleanUp(dir);
    spawnSync('taskkill', ['/IM', 'VRCT-sidecar.exe', '/F']);
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
