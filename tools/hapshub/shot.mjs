// Takes pictures of the built app in a throwaway copy, for looking at a page without opening the real app.
//   node tools/hapshub/shot.mjs <out.png> [--tab N] [--eval "js"] [--wait ms] [--clip x,y,w,h] [--size WxH] [--scale 1.25] [--keep-splash]
// --eval runs in the page before the picture; --size and --scale emulate a window size and a display scaling.
// Several pictures in one run: repeat the group  --next <out.png> [--tab N] [--eval ...] [--clip ...]

import { cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const PORT = 9339;
const argv = process.argv.slice(2);
const shots = [];
let current = null;
let size = null, scale = null;
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--release') continue;
    if (arg === '--next') { current = { file: argv[++i] }; shots.push(current); }
    else if (!arg.startsWith('--') && !current) { current = { file: arg }; shots.push(current); }
    else if (arg === '--tab') current.tab = Number(argv[++i]);
    else if (arg === '--eval') current.eval = argv[++i];
    else if (arg === '--wait') current.wait = Number(argv[++i]);
    else if (arg === '--clip') { const [x, y, width, height] = argv[++i].split(',').map(Number); current.clip = { x, y, width, height }; }
    else if (arg === '--size') { const [width, height] = argv[++i].split('x').map(Number); size = { width, height }; }
    else if (arg === '--scale') scale = Number(argv[++i]);
}
if (!shots.length) { console.log('usage: node tools/hapshub/shot.mjs <out.png> [--tab N] [--eval "js"] [--clip x,y,w,h] [--size WxH] [--scale S]'); process.exit(2); }

const dir = freshData('hapshub-shot-');
try {
    const main = await openMain(dir, PORT);
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    if (size || scale) {
        const view = size || await main.json(`({ width: innerWidth, height: innerHeight })`);
        await main.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: scale || 1, mobile: false });
        await sleep(400);
    }
    for (const shot of shots) {
        if (shot.tab !== undefined) await main.eval(`showTab(${shot.tab})`);
        if (shot.eval) await main.eval(shot.eval);
        await sleep(shot.wait ?? 700);
        await main.screenshot(shot.file, shot.clip);
        console.log(`saved ${shot.file}`);
    }
    if (main.errors.length) console.log(`page errors: ${main.errors.join(' | ')}`);
} catch (error) {
    console.log(`FAIL ${error.message}`);
    process.exitCode = 1;
} finally {
    await cleanUp(dir);
}
