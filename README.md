# HapsHub

[![Based on VRCNext](https://img.shields.io/badge/based%20on-VRCNext-7c4dff?style=for-the-badge)](https://github.com/shinyflvre/VRCNext)

> [!IMPORTANT]
> **HapsHub is built on [VRCNext](https://github.com/shinyflvre/VRCNext)**, the VRChat launcher and manager by
> shinyflvre and the VRCNext contributors. HapsHub started as a VRCNext fork and has since grown dozens of its own
> features and systems, listed below. If you like the VRCNext base, star VRCNext on GitHub or support them on
> [Patreon](https://www.patreon.com/cw/Shinyflvres).

Please don't take HapsHub problems to VRCNext's Discord or issue tracker: report them
[here](https://github.com/HapyrV/HapsHub/issues) instead.

HapsHub is not made, endorsed or supported by VRChat Inc. VRChat is a trademark of VRChat Inc.

## What HapsHub adds

Everything VRCNext does (friends, worlds, groups, avatars, instances, media library, timeline, VR tools), plus:

- **Plugins**: switch off what you don't use (Settings > Plugins). A plugin that's off loses its page, buttons, settings
  and background work. The first run asks what you use (VR, full-body tracking, face tracking, haptics, the apps below)
  and ticks what's already installed.
- **Pages for other apps**: OyasumiVR, Space Calibrator, VRCT and OVR Toolkit inside HapsHub's window. They minimize or
  close with HapsHub, as you choose.
- **VRCT built in**: HapsHub runs VRCT's translator itself, with one-click language pairs, your microphone turned into
  chatbox messages and what others say translated.
- **OVR Advanced Settings page** for its movement options (drag, gravity, snap turn).
- **World Map** of where your friends are, from the flags, countries and languages on their own profiles. Never from
  IP addresses.
- **History** (names, trust, notifications, videos, avatars, visits), **Friend Schedule**, **YouTube Tunnel** (a song
  into your VRChat microphone), crash rejoin, screenshot details, a full VRCX history import and archive.
- **Performance mode** for slower PCs, smoother scrolling, a tidier Settings page, and a sidebar you can rearrange by
  dragging.
- **Launch switches** that start your haptics, face tracking or full-body tracking apps with VRChat.
- **Your own name for it**: Settings > Appearance > App name.

## Install

1. Download `HapsHub-<version>-win-x64.zip` from [Releases](https://github.com/HapyrV/HapsHub/releases/latest).
2. Unzip it anywhere you like, for example `C:\Apps\HapsHub`.
3. Run `HapsHub.exe`. Windows may warn that it's from an unknown publisher, because the app isn't code-signed:
   choose **More info > Run anyway**.

It needs Windows 10 or 11 with Microsoft's WebView2 runtime, which Windows normally has. Your data is kept in
`%APPDATA%\HapsHub`, so it stays when you update.

**Updating**: HapsHub tells you when a new release is out. Close HapsHub, unzip the new release over the old folder
(or into a new one), and start it again.

**Moving from VRCNext**: HapsHub keeps its own data and doesn't touch VRCNext's. Both can be installed side by side.

## System requirements

| | Minimum | Recommended |
|---|---|---|
| Windows | 10 or 11, 64-bit, with WebView2 | 11 |
| CPU | 2 threads | 4 threads or more |
| Memory | 4 GB free beside VRChat | 8 GB free beside VRChat |
| Graphics | Optional: it also runs with the GPU off | Any GPU with DirectX 11 |
| Disk | 600 MB, plus its image cache (5 GB at most, adjustable) | |

Measured with `tools/hapshub/min-spec.mjs` on 400 friends, pinned to fewer threads of a desktop CPU, with and without
the GPU. Even on 1 thread with the GPU off it started in 5 s, switched pages in under 130 ms and scrolled at 60 fps, so
any 4-core PC from the last ten years has plenty of room. On a PC with 4 threads or fewer, or under 8 GB of memory,
Performance mode switches itself on the first time. VRCT's translator, when used, needs a few more gigabytes of memory
for its speech and translation models.

## Privacy

HapsHub talks to VRChat's API with your account, the same way VRCNext does, and identifies itself as
`HapsHub/<version>`. Anything that sends data to outside services (avatar databases, VRCN+ lookups) is blocked unless you
turn on "Send avatar data" in Settings > Avatar Search. The update check asks GitHub for HapsHub's latest release.
VRCNext's own privacy notes are in [docs/VRCNEXT-README.md](docs/VRCNEXT-README.md).

## Building it yourself

You need the .NET 10 SDK and Git.

```
git clone --recursive https://github.com/HapyrV/HapsHub.git
cd HapsHub
dotnet build VRCNext.csproj -c Release
```

`tools/hapshub/make-release.ps1` builds the release zip. `tools/hapshub/run-tests.ps1` runs the tests.

## Licence

HapsHub is a fork of VRCNext and is shared under the same licence, the VRCNext Non-Commercial Source Available
License (see [LICENSE](LICENSE)): free to use and share, never to sell. VRCNext's original README, with its feature
overview and credits, is in [docs/VRCNEXT-README.md](docs/VRCNEXT-README.md).
