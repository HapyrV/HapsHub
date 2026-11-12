# HapsHub round 6: VR test checklist (2026-11-10)

These need a headset and the real apps, so the automated tests can't cover them.
Report back by ID, for example "V3 fail: OyasumiVR jumped to full screen".

Your running HapsHub is the Release build from 15:54. It does **not** include the VRCT order fix (F1) or the
new World Map. V2b needs the rebuild.

## V1 VR overlay (SteamVR)
- [ ] a. VR Overlay page: Show Overlay / Hide Overlay works in the headset.
- [ ] b. A notification (a friend coming online, an invite) shows as a toast in the overlay, with its sound if that's turned on.
- [ ] c. Overlay Opacity (Settings > Design) changes what you see in the headset.
- [ ] d. Any stutter or frame drops in VRChat while HapsHub is open vs minimised? Your impression is enough; it feeds H2.

## V2 VRCT inside HapsHub
- [ ] a. The VRCT page opens, and translated text reaches the VRChat chatbox.
- [ ] b. **(needs rebuild)** Switch the translator: the language lists change to what that translator offers.
- [ ] c. Quick pairs in the top bar come from the pairs you actually used; long language names fit.

## V3 OyasumiVR (C2, A6)
- [ ] a. Its page shows OyasumiVR embedded, and it works (sleep mode, brightness).
- [ ] b. Double-clicking its title bar never makes it bigger than the page.
- [ ] c. The VRChat tab reads "Start OyasumiVR".

## V4 Space Calibrator, Standable, OVR Advanced Settings (B2, B3)
- [ ] a. Each one's settings are under Plugins > its ⋯ menu > Options, not loose in Settings.
- [ ] b. The settings work: the app picks them up while you're in VR.
- [ ] c. Turn one plugin off: its page and settings disappear. Turn it back on: they come back.

## V5 Launch switches (A7)
- [ ] a. Rename a switch; the new name sticks after a restart.
- [ ] b. Add a new switch with a name and its apps; it starts those apps.

## V6 Closing (do this last)
- [ ] a. Quit HapsHub from the tray: apps held in its pages are minimised or closed as set, not left floating
      over VRChat.
