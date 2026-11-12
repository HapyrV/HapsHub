# G1: VRCX upstream commits (reviewed 2026-11-10)

HapsHub's VRCX reference was at `30e0009` (2026-11-07). The four commits that followed are reviewed below. HapsHub is
not built on VRCX's Vue code, so "ported" means the same behaviour was added to HapsHub's own code.

| Commit | What it does in VRCX | HapsHub |
| --- | --- | --- |
| `fc3a89a` Missing name fallback | Avatar, group and world dialogs show the ID (and the author's or owner's ID) when the name is missing, instead of a blank. | **Ported**: the avatar, group and world dialogs and their top-bar labels fall back to the ID; author and owner fall back to their IDs. |
| `8397c5f` Refresh notifications backoff | Only one notification refresh runs at a time, and after a 429 refreshes pause for 2 minutes. | **Ported**: `NotificationsController.GetNotificationsAsync` shares a running refresh, skips refreshes for 2 minutes after a 429, and keeps the shown list instead of replacing it with an empty one. |
| `267cb69` Empty session segments in Game Log | The Game Log's session view keeps sessions with no events, with the expand arrow hidden. | **Skipped**: HapsHub has no Game Log session view to change. |
| `f6b3714` Fix filter skip being removed | Follow-up to `267cb69`: with no filter, returns the segments as they are. | **Skipped**: same reason as `267cb69`. |

## Newer commits (after the round-6 list was written)

Seven more landed on 2026-11-10. Not ported in round 6; noted for the next round:

- `232ec8e` like/dislike button in the world dialog: a new VRChat API call. Worth adding to HapsHub's world dialog.
- `f877f0d`, `555f9cb`, `2929696` instance creation and instance tooltips: compare with HapsHub's create-instance flow.
- `0f748c7` (database variables after a dev hot reload), `3df81b1` and `76d8af2` (VRChat Store page moved to Tools):
  VRCX-only, nothing to port.
