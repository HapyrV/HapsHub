#!/usr/bin/env sh
# Starts HapsHub from this folder. If HapsHub doesn't open, run this from a terminal: it says what's missing.
here="$(cd "$(dirname "$0")" && pwd)"

missing=$(ldd "$here/Photino.Native.so" "$here/libnfd.so" 2>/dev/null | grep "not found" | sort -u)
if [ -n "$missing" ]; then
    echo "HapsHub needs these system libraries, which aren't installed:"
    echo "$missing"
    echo
    echo "Ubuntu, Debian, Mint, Pop!_OS:  sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libnotify4"
    echo "Fedora:                         sudo dnf install webkit2gtk4.1 gtk3 libnotify"
    echo "Arch, Manjaro, EndeavourOS:     sudo pacman -S webkit2gtk-4.1 gtk3 libnotify"
    exit 1
fi

exec "$here/HapsHub" "$@"
