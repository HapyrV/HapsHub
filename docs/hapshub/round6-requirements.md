# HapsHub round 6: requirements

Each item has a check that passes or fails. Numbers in brackets are the request numbers from the list.

## A. Settings: look, layout and structure

- **A1 Themed controls [3]**: every select, option, input, textarea and checkbox in Settings and in plugin option dialogs
  uses the app font and theme colours.
  Check: QA pass fails when a visible form control's computed font-family lacks the app font, or its background is
  lighter than 85% while the theme is dark.
- **A2 No tiny tabs [6]**: no Settings tab holds fewer than 3 settings; small tabs merge into the closest related tab.
  Check: a script counts setting rows per tab and lists any tab under 3.
- **A3 One VRCX tab [5]**: VRCX Import and Archive are sections inside the existing VRCX tab.
  Check: Settings nav has exactly one VRCX entry, and it contains the import and archive controls.
- **A4 Resizable sidebar [13]**: the Settings page never shows a horizontal scrollbar; its sidebar width is dragged
  between 160 and 360 px and remembered.
  Check: at every QA window size, scrollWidth <= clientWidth on the Settings page; after a drag and reload the width
  is the same.
- **A5 Performance tab [14]**: no overlapping controls in the Performance tab at any QA size or scale.
  Check: QA overlap check on that tab passes, and the detector is shown to catch the case that was reported.
- **A6 OyasumiVR name [12]**: the VRChat tab reads "Start OyasumiVR", never "Oyasumi VR".
  Check: no visible text matches /Oyasumi\s+VR/i.
- **A7 Launch switches [11]**: each Launch window switch can be renamed, and new ones (a name and the apps it starts)
  can be added and removed.
  Check: a new switch, its app and a new name for a built-in switch are saved, show in the Launch window and survive a
  restart.

## B. Plugins

- **B1 Plugins as a dropdown [7]**: a plugin's options fold open under it in the Plugins list (a chevron, or Options in
  its ⋯ menu); there is no Settings tab per plugin.
- **B2 Options in the ⋯ menu [17]**: each plugin with settings has "Options" in its ⋯ menu, which opens its settings in
  a dialog.
  Check: Settings nav has no per-plugin tabs; every plugin that has settings shows "Options" and the dialog lists them.
- **B3 Personal settings belong to plugins [8]**: Space Calibrator, OyasumiVR, Standable, VRCT and other app-specific
  settings live only in their plugin's options (General keeps app-wide settings only).
  Check: with a plugin off, none of its settings appear anywhere in Settings.
- **B4 Rose Database plugin [19]**: Rose Database is a plugin; off hides its Avatars filter and settings.
- **B5 Licences follow plugins [15]**: each plugin declares its third-party licences; Attribution lists only those of
  installed plugins and updates on install or removal.
  Check: installing a test plugin adds its licence to Attribution; removing it removes it.
- **B6 Plugins stage 2 [23]**: a gallery lists plugins from a registry file, with install, update and uninstall.
  Downloads are checked against the registry's SHA-256 before they are unpacked.
- **B7 Your own plugins [23]**: a folder with `manifest.json` + `main.js` (+ optional `styles.css`) in the plugins folder
  shows up as a community plugin. Community plugins are off until the user accepts an Obsidian-style warning (they run
  with HapsHub's access to your files and accounts, and HapsHub doesn't review them). Turning one off unloads it.
  Check: a sample plugin loads, runs `onload`, and runs `onunload` when turned off; nothing runs before the warning is
  accepted.

## C. Embedded apps

- **C1 Eagle in Media Library [1, 18]**: Eagle is a source inside Media Library, the way Rose Database is a filter in
  Avatars, read through Eagle's local API instead of embedding its window.
  Check: with Eagle running, Media Library > Eagle lists folders and items with thumbnails; with Eagle closed it says so.
- **C2 OyasumiVR stays in its page [16]**: double-clicking an embedded app's title bar never makes it larger than the
  page.
  Check: after a simulated title-bar double-click the window rect still fits the page area.

## D. Dashboard and profile

- **D1 Random picture works [10]**: the dashboard picture is picked at random from the pool on each start.
  Check: with 2+ pictures in the pool, starts with different seeds show different pictures.
- **D2 Shuffle button [20]**: a small refresh icon in the top-left of the dashboard picture picks a different picture.
  Check: one click changes the picture when the pool has 2+.
- **D3 Edit your own profile [new]**: on your own profile you can change the banner and the profile picture (VRC+;
  upload a new image or pick from your gallery and icons), plus status, status text, bio, pronouns, links and languages.
  Without VRC+ the picture and banner buttons explain why they're off.
  Check: each edit sends the right API call (fake server in tests) and the profile updates without reopening it.

## E. World map [2]

- **E1 Fewer wrong pins**: a pin needs a flag, an explicit "from <country>", a manual pin, or exactly one non-English
  language. English is ignored when other languages are listed; two or more languages from different countries leave
  the friend unplaced.
  Check: test profiles cover each rule, including [eng, jpn] -> Japan and [jpn, kor] -> unplaced.
- **E2 Search**: a search box finds friends by name and turns the globe to their pin, or offers to set one.
- **E3 Your pins win**: you can set or clear a friend's country; it overrides detection, survives restarts and looks
  different on the map.
- **E4 Shorter text**: "Pins are guessed from profiles: flags, 'from …' and languages. Never from IP addresses."
- Each pin says why it is there ("flag in bio", "language: Japanese", "set by you").

## F. VRCT [9]

- **F1 VRCT's own languages**: the language lists come from VRCT's engine for the selected translator, not a fixed list.
  No Hebrew pairs are built in; quick pairs are the user's own recent pairs.
  Check: with the fake engine reporting a language list, the dropdowns show exactly that list.

## G. VRCX [4]

- **G1 Upstream commits**: review VRCX's four new commits; port what applies to HapsHub and note what was skipped and why.

## H. App-wide

- **H1 Info boxes [21]**: every page reachable from the sidebar has a non-empty info box when its title in the top bar
  is clicked, in every language.
  Check: a test opens each page, clicks the title, and asserts the box text is 20+ characters.
- **H2 Memory [22]**: measure HapsHub plus its WebView2 processes after 2 minutes idle on the dashboard, then cut it.
  Check: at least 20% lower when idle and 40% lower when minimised, with no failed tests.

## I. Release [24]

- **I1 v1.0.0**: after A-H pass, create HapsHub on GitHub, push, and attach the release zip and notes as v1.0.0.
  Check: a fresh clone (with the photino submodule) builds, and the release zip starts on a clean profile.
