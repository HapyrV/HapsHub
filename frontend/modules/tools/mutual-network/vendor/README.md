# Mutual Network libraries

The same graph stack VRCX's Mutual Friends chart uses, bundled for HapsHub's plain scripts.
All are MIT licensed.

| Package | Version |
|---|---|
| graphology | 0.26.0 |
| graphology-communities-louvain | 2.0.2 |
| graphology-layout-forceatlas2 | 0.10.1 |
| graphology-layout-noverlap | 0.4.2 |
| sigma | 3.0.3 |
| @sigma/edge-curve | 3.1.0 |
| @sigma/node-border | 3.0.0 |
| @sigma/node-image | 3.0.0 |

`graph-lib.js` is built from `src/lib-entry.js` and sets `window.HHGraphLib`.
`net-layout-worker.js` is built from `src/worker-entry.js`, VRCX's layout steps (ForceAtlas2, then noverlap).

To rebuild, in an empty folder:

    npm install graphology@0.26.0 graphology-communities-louvain@2.0.2 graphology-layout-forceatlas2@0.10.1 graphology-layout-noverlap@0.4.2 sigma@3.0.3 @sigma/edge-curve@3.1.0 @sigma/node-border@3.0.0 @sigma/node-image@3.0.0 esbuild
    npx esbuild lib-entry.js --bundle --minify --format=iife --legal-comments=eof --outfile=graph-lib.js
    npx esbuild worker-entry.js --bundle --minify --format=iife --legal-comments=eof --outfile=net-layout-worker.js
