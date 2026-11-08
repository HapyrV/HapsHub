"""One-time copy of VRCNext's user data into a new HapsHub data folder.

The source is only read. Databases are copied with SQLite's backup API, so
VRCNext can stay open. Thumbnails, logs and the WebView2 profile are skipped,
except WebView2 Local Storage, which holds pins and nav layout. The image cache
is copied on purpose: without it the app downloads every image from VRChat again
at about 800 requests a minute.

In the copied settings: Start with Windows is off, the default bot name becomes
HapsHub, and entries that launch VRCNext.exe are removed.
"""
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

SRC = Path(os.environ['APPDATA']) / 'VRCNext'
DST = Path(os.environ['APPDATA']) / 'HapsHub'
LOCAL_STORAGE = Path('WebView2', 'EBWebView', 'Default', 'Local Storage')
SKIP = {Path('Logs'), Path('ThumbCache'), Path('WebView2')}
SETTINGS = {'settings.json', 'settings.json.bak'}


def is_sqlite(path):
    with open(path, 'rb') as f:
        return f.read(16) == b'SQLite format 3\0'


def copy_sqlite(src, dst):
    uri = src.resolve().as_uri() + '?mode=ro'
    source = sqlite3.connect(uri, uri=True, timeout=30)
    target = sqlite3.connect(dst)
    try:
        source.backup(target)
        result = target.execute('PRAGMA integrity_check').fetchone()[0]
        if result != 'ok':
            raise RuntimeError(f'{dst}: integrity_check returned {result}')
    finally:
        target.close()
        source.close()


def copy_settings(src, dst):
    with open(src, encoding='utf-8-sig') as f:
        settings = json.load(f)
    removed = []
    for key, value in settings.items():
        if isinstance(value, list):
            keep = [v for v in value
                    if not (isinstance(v, str) and v.lower().endswith('\\vrcnext.exe'))]
            if len(keep) != len(value):
                removed.append(key)
                settings[key] = keep
    settings['StartWithWindows'] = False
    if settings.get('BotName') == 'VRCNext':
        settings['BotName'] = 'HapsHub'
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    return removed


def main():
    if not SRC.is_dir():
        sys.exit(f'Source not found: {SRC}')
    if DST.exists():
        sys.exit(f'Destination already exists, nothing copied: {DST}')

    # Build in a temporary folder so a failed copy never looks like a finished one.
    tmp = DST.with_name('HapsHub.copying')
    if tmp.exists():
        shutil.rmtree(tmp)

    files = databases = size = 0
    for base, dirs, names in os.walk(SRC):
        rel = Path(base).relative_to(SRC)
        dirs[:] = [d for d in dirs if rel / d not in SKIP]
        for name in names:
            if name.endswith(('-wal', '-shm')):
                continue
            src, dst = Path(base) / name, tmp / rel / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            if rel == Path('.') and name in SETTINGS:
                removed = copy_settings(src, dst)
                if removed:
                    print(f'{name}: removed VRCNext.exe from {", ".join(removed)}')
            elif is_sqlite(src):
                copy_sqlite(src, dst)
                databases += 1
            else:
                shutil.copy2(src, dst)
            files += 1
            size += dst.stat().st_size

    local_storage = SRC / LOCAL_STORAGE
    if local_storage.is_dir():
        shutil.copytree(local_storage, tmp / LOCAL_STORAGE,
                        ignore=shutil.ignore_patterns('LOCK'))

    tmp.rename(DST)
    print(f'Copied {files} files ({databases} databases, {size / 1048576:.0f} MB) to {DST}')


if __name__ == '__main__':
    main()
