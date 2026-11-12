// A stand-in for Eagle's local API (http://localhost:41595/api/...), answering the way Eagle 4 does: "offset" is a
// page number, item/thumbnail answers a file path, folders can have a password. Its library lives in a temp folder.
//   const eagle = await startFakeEagle(); ... eagle.url ... await eagle.close();
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePng } from './png.mjs';

export async function startFakeEagle() {
    const root = mkdtempSync(join(tmpdir(), 'hapshub-eagle-'));
    const library = join(root, 'Test.library');
    // A file outside the library that a bad answer points at: it must never be served.
    const outside = join(root, 'outside.png');
    writePng(outside, 8, 8, [255, 0, 255]);

    const folders = [
        { id: 'F1', name: 'Sunsets', password: '', children: [{ id: 'F1A', name: 'Beach', password: '', children: [] }] },
        { id: 'F2', name: 'Lots', password: '', children: [] },
        { id: 'L1', name: 'Private', password: '1234', children: [{ id: 'L1A', name: 'Inner', password: '', children: [] }] },
    ];
    const items = [];
    const add = (id, name, inFolders, { thumb = true, file = true, deleted = false } = {}) => {
        items.push({ id, name, ext: 'png', width: 64, height: 36, tags: [], folders: inFolders, isDeleted: deleted, size: 1 });
        const dir = join(library, 'images', id + '.info');
        mkdirSync(dir, { recursive: true });
        if (file) writePng(join(dir, name + '.png'), 64, 36, [30, 120, 220]);
        if (thumb) writePng(join(dir, name + '_thumbnail.png'), 32, 18, [220, 120, 30]);
    };
    add('SECRET1', 'secret', ['L1A']);
    add('TRASH1', 'trashed', ['F1'], { deleted: true });
    add('SUN1', 'sunset', ['F1']);
    add('TINY1', 'tiny', ['F1'], { thumb: false });
    add('BEACH1', 'beach', ['F1A']);
    items.push({ id: 'EVIL1', name: '..\\..\\..\\outside', ext: 'png', width: 8, height: 8, tags: [], folders: [], isDeleted: false });
    for (let i = 0; i < 105; i++) add('LOT' + i, 'lot ' + i, ['F2'], { thumb: false, file: i < 2 });

    const thumbFor = item => item.id === 'EVIL1' ? outside : join(library, 'images', item.id + '.info', item.name + '_thumbnail.png');
    const answer = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'success', data })); };
    const requests = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        requests.push(url.pathname + url.search);
        const q = Object.fromEntries(url.searchParams);
        const item = items.find(i => i.id === q.id);
        switch (url.pathname) {
            case '/api/application/info': return answer(res, { version: '4.0.0', platform: 'win32' });
            case '/api/library/info': return answer(res, { folders, library: { path: library, name: 'Test' } });
            case '/api/folder/list': return answer(res, folders);
            case '/api/item/list': {
                const limit = Number(q.limit || 200), page = Number(q.offset || 0);
                const wanted = q.folders ? q.folders.split(',') : null;
                const shown = items.filter(i => !wanted || i.folders.some(f => wanted.includes(f)));
                return answer(res, shown.slice(page * limit, (page + 1) * limit));
            }
            case '/api/item/info': return item ? answer(res, item) : (res.writeHead(200), res.end(JSON.stringify({ status: 'error' })));
            case '/api/item/thumbnail': return item ? answer(res, thumbFor(item)) : (res.writeHead(200), res.end(JSON.stringify({ status: 'error' })));
            default: res.writeHead(404); res.end();
        }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url, root, library, requests,
        close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
    };
}
