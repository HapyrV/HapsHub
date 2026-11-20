#!/usr/bin/env sh
# Starts HapsHub from this folder. If HapsHub doesn't open, run this from a terminal: it says what's missing.
# If the window opens blank or flickers (some NVIDIA drivers), start it with --safe-graphics.
here="$(cd "$(dirname "$0")" && pwd)"

if [ "$1" = "--safe-graphics" ]; then
    shift
    # Slower, but works where the GPU path doesn't. Settings > Performance > Force Software Rendering keeps it on.
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi

missing=$(ldd "$here/Photino.Native.so" "$here/libnfd.so" 2>/dev/null | grep "not found" | sort -u)
if [ -n "$missing" ]; then
    echo "HapsHub needs these system libraries, which aren't installed:"
    echo "$missing"
    echo
    echo "Arch, Manjaro, EndeavourOS, CachyOS:  sudo pacman -S --needed webkit2gtk-4.1 gtk3 libnotify"
    echo "Ubuntu, Debian, Mint, Pop!_OS:        sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libnotify4"
    echo "Fedora:                               sudo dnf install webkit2gtk4.1 gtk3 libnotify"
    exit 1
fi

exec "$here/HapsHub" "$@"
