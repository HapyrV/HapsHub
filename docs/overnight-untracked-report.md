# Untracked files in the repo (2026-11-19)

`git status` at `aa3a4ed8` shows four untracked entries. Nothing was deleted or moved. Each one has a suggestion below for you to act on.

| Path | What it is | Suggestion |
|---|---|---|
| `VRCatalogue-remake-spec.md` (10 KB, 2026-11-12) | A spec for a local remake of the VRCatalogue Booth.pm explorer site. It is not HapsHub code. | **Keep, but move it out of the repo root.** Put it in `docs/` if the remake will live in HapsHub, or in its own project folder if not. |
| `image-1795028329468.png` (640 KB, 2026-11-18 20:58) | A "Nova – We will dance again" poster, portrait layout. It is not a HapsHub asset. It was probably saved here when it was pasted into a chat. | **Move it to your own pictures folder.** It doesn't belong in the repo. |
| `image-1795028333426.png` (910 KB, 2026-11-18 20:58) | The same poster in landscape layout. | **Move it**, same as above. |
| `tools/hapshub/out/` | Output from the test tools: `lag-profile.json`, `lag-watch.json` and `lag-watch-before.json` (20 KB) from `lag-profile.mjs` and `lag-watch.mjs`. The `out/hapshub/` subfolder shown earlier is a temporary test profile that the test run creates and removes. | **Ignore.** Add `tools/hapshub/out/` to `.gitignore`. It is regenerated on every profiler run. |
