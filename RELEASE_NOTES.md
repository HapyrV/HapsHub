# HapsHub 1.1.4

Built on VRCNext 2027.2.4.

**New**
- From VRCNext 2027.2.4: set content tags such as Sexually Suggestive or Graphic Violence on your own avatars in the avatar details, and on several at once with **Bulk Content Tag** in the Avatars edit mode.
- Time Spent counts group joins and time from your whole visit history, so groups match the timeline.

**Fixed**
- Settings > "Automatic updates" didn't do anything: HapsHub still checked for updates at startup and downloaded them in the background. Turning it off now stops both ("Check for updates" in Settings still works). On Linux, updates are only announced; "Download & Install" opens the download page.
- Time Spent > Groups: a visit with no recorded leave time (for example after VRChat crashed) no longer counts as lasting until now, which could add months to a group.

# HapsHub 1.1.3

**New**
- Hapsplorer: word searches can be sorted by "Best match", which puts the closest matches first. Searches also match full-width letters and hiragana/katakana spellings, and are faster.

**Fixed**
- Windows: a maximized window was cut off at the edges (the top bar and window buttons were partly off-screen). It now fits the screen exactly.
- The "What's new" popup showed VRCNext's links. It now shows HapsHub, with Star on GitHub and Report a bug, and credits VRCNext.
- The sidebar always showed "v1.0.0" under the HapsHub name. It now shows the version you're running.
- Hapsplorer: signing in while the Hapsplorer server was unreachable said your key wasn't valid. It now says the server is offline, and your key is kept.

# HapsHub 1.1.2

**New**
- Updates install themselves on Windows: when a new version is out, HapsHub downloads it in the background and checks it, and "Download & Install" just restarts into it. Your settings and data stay as they are. (This is the last update you need to install by hand.)
- Hapsplorer: with one avatar picked, "Made for <avatar>" shows what was made for it and hides poses, accessories and textures that list dozens of avatars ("Everything that fits" shows them again). Searching an avatar's name offers to filter by that avatar.

**Fixed**
- Linux: no way to open the window again after closing it to the tray. The tray menu now has "Open HapsHub" (also middle-click), opening HapsHub again or a vrcn:// link brings the window back, and on a desktop without a tray (GNOME without the AppIndicator extension) HapsHub stays open instead of disappearing.
- Windows: clicking your profile in the tray popup hid the window if it was already open; it now always opens it.
- Linux: "Download & Install" opened the wrong project's download page.

# HapsHub 1.1.1

**Fixed**
- With "Minimize to tray" on, opening HapsHub only showed a tray icon and no window. The window now opens as usual; HapsHub only starts hidden in the tray when it starts with Windows.

# HapsHub 1.1.0

Built on VRCNext 2027.2.2.

**New**
- Free Store Items: lists the free items in the VRChat stores that you don't own yet, with a Claim All button. It opens a few seconds after sign-in when there are items it hasn't shown you yet ("Don't show this again" turns that off).
- Linux: the "hide to tray" setting, tray menus that say "Close HapsHub", and a one-file install. A message tells you when the tray helper can't start, and the README lists the packages to install for each distro.
- Linux: Steam apps start through Proton, other Windows apps through Wine, and app pages open the app in its own window. YouTube Tunnel plays into a "HapsHub Tunnel Mic" virtual microphone.
- From VRCNext 2027.2.2: VRCNDb's new address, signed VRCN+ requests, and Voice Fight / Kikitan XD switches that update the VR overlay.

**Changed**
- The Hapsplorer page stays inside the content area and matches the latest Hapsplorer interface. Its top bar wraps to a second row when space is short instead of piling buttons on top of each other, keyword groups such as Swimwear open and close like dropdowns, and prices and likes no longer get cut off on narrow cards.
- HapsHub checks whether VRChat and SteamVR are running from one shared process list instead of a full system snapshot on every check, which saves work.
- Linux: smoother window. Page messages no longer run on the drawing thread. NVIDIA PCs keep the faster renderer unless you start with `--safe-graphics` or turn on Settings > Force Software Rendering. Efficiency mode steps aside while the window is in use.

**Fixed**
- Linux: a crash report on every start when VRChat isn't installed (the automatic VRChat settings backup no longer runs without it).

# HapsHub 1.0.0

The first release of HapsHub, built on VRCNext 2027.2.0, with dozens of HapsHub features and systems on top. Thanks to shinyflvre and the VRCNext contributors for the base.

**New**
- Plugins (Settings > Plugins): switch off what you don't use. The first run asks what you use and ticks what's installed.
- VRCT built in: run VRCT's translator from HapsHub, with one-click language pairs.
- World Map: where your friends are, from their own profiles.
- Pages for OyasumiVR, Eagle, Space Calibrator and OVR Toolkit, and one for OVR Advanced Settings' movement options.
- History, Friend Schedule, YouTube Tunnel, crash rejoin, screenshot details, VRCX import and archive.
- Performance mode for slower PCs, and a setting to rename the app.
- Rearrange the sidebar by dragging; rename groups by double-clicking them.
- From VRCNext 2027.2.0: Space Walk, My Reports, Purchase History, reporting users, reward codes, instance descriptions and vibes, Worlds Discover, Ukrainian, Linux support, and faster loading and tab switching.
- From VRCX, off until you turn them on: a chime and a flashing taskbar button when a queued instance has a place for you (Settings > Sounds), and a clock beside friends you invited in the last hour (Settings > Sidebar).
- Worlds > Explore replaces Discover and Search: browse all public worlds by Active now, Discover, Hot, Trending, Popular, New, Community Labs, Most favorited or Random, and search from the same bar.
- Explore filters: platform (Quest/Android, PC only, iOS), hide content warnings, tag chips from your favorite and visited worlds (click to show only, again to hide), published within, capacity and language.
- Explore, just for you: a Visited badge and "hide worlds I have visited", right-click a world to like or dislike it or hide it, its author or a tag, and a Liked view. Kept on your PC only, never sent to VRChat.
- Explore, Active now: cards show how many friends are in each world right now, "only worlds where friends are", and order by people there now or friends first.
- Explore, VRChat rows and saved searches: open the same world rows VRChat shows in game, save a view with its search and filters under a name, and pick which view or saved search Explore opens on.
- Explore AI filter: a "Maybe AI" badge guessed from a world's tags and text (never stated as fact), right-click to mark a world or a whole author as AI, and hide guesses and marks or only your marks. Kept on your PC only.
- Explore For You: a feed picked from the tags of worlds you visit, favorite and like, with newer worlds getting a fair chance, at most two per creator, and a note on each card saying why it is there.
- Explore lists: share your Liked worlds as a code or a file (with your AI marks if you like), and import lists from friends; each opens as its own view.

**Fixed**
- Scrolling in Settings dropped half its frames.
- Apps shown in HapsHub's pages stayed open, or popped out, when HapsHub closed.
- Eagle and VRCT stayed blank inside their pages.
- Pages added by HapsHub had no title in the top bar.
- "Start with Windows" could switch itself off: a second copy of HapsHub removed the startup entry. HapsHub puts it back on its next start while the setting is on.
- Ukrainian showed blank labels where a text had no Ukrainian yet; they now show in English.
- Worlds > Explore list view didn't dim the worlds you hid.
- Dropdowns kept their old language after switching languages.
- Text left in English in other languages: the VRCT page, the first-run plugin picks, game log entries in Timeline, Event Snipe, the log viewer, Action Flow's toolbar, plugin names in Settings and some tooltips.
