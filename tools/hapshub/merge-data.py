"""Brings HapsHub's split data back into one folder.

The Claude app is a packaged Windows app, so anything it starts has its %APPDATA% redirected to a
private copy. The migration and every launch from it went there, while a launch from Explorer uses
the real folder. This must run outside the package (double-click it), or it would only see the copy.

Nothing is deleted: the real folder and the private copy are both renamed and kept.

  python merge-data.py                 the real thing
  python merge-data.py --real A --overlay B --staging C --no-wait --no-build --no-launch    for a test
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from contextlib import closing

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXE = os.path.join(REPO, 'bin', 'Release', 'net10.0-windows10.0.19041.0', 'HapsHub.exe')

# Rows the Explorer-launched session recorded. Keyed tables, so a row already present is left alone.
DELTA_TABLES = [
    'friend_events', 'friend_event_colocated', 'event_players', 'known_users', 'logged_notifs',
    'photo_records', 'photo_record_players', 'user_memos', 'local_fav_groups', 'local_fav_items',
    'image_versions', 'avatar_tracking', 'world_tracking', 'user_tracking', 'group_tracking',
    'event_tracking',
]
HUB_TABLES = [('module_settings', 'REPLACE'), ('upstream_reviewed', 'IGNORE'), ('steam_reviewed', 'IGNORE')]
# The staged copies of these replace the private copy's, because they hold the finished import.
STAGED = {'VRCNData.db', 'VRCNData.db-wal', 'VRCNData.db-shm'}


def say(*parts):
    print(*parts, flush=True)
    if REPORT:
        print(*parts, file=REPORT, flush=True)


REPORT = None


def running(name):
    out = subprocess.run(['tasklist', '/FI', f'IMAGENAME eq {name}', '/NH'], capture_output=True, text=True).stdout
    return name.lower() in out.lower()


def columns(db, schema, table):
    return [row[1] for row in db.execute(f'PRAGMA {schema}.table_info("{table}")')]


def merge_tables(db, tables, mode='IGNORE'):
    for table in tables:
        shared = [c for c in columns(db, 'old', table) if c in columns(db, 'main', table)]
        if not shared:
            continue
        names = ','.join(f'"{c}"' for c in shared)
        before = db.total_changes
        db.execute(f'INSERT OR {mode} INTO main."{table}" ({names}) SELECT {names} FROM old."{table}"')
        say(f'  {table}: {db.total_changes - before} rows added')


def merge_timeline(db):
    """The fresh session knew nobody and had no photos, so its first meetings and photo rescans need care."""
    shared = [c for c in columns(db, 'old', 'events') if c in columns(db, 'main', 'events')]
    names = ','.join(f'"{c}"' for c in shared)
    picked = ','.join("CASE WHEN o.type = 'first_meet' AND EXISTS (SELECT 1 FROM main.events e WHERE e.type = 'first_meet' "
                      "AND e.user_id = o.user_id) THEN 'meet_again' ELSE o.type END" if c == 'type' else f'o."{c}"' for c in shared)
    before = db.total_changes
    db.execute(f"""INSERT OR IGNORE INTO main.events ({names}) SELECT {picked} FROM old.events o
                   WHERE NOT (o.type = 'photo' AND EXISTS (SELECT 1 FROM main.events e WHERE e.type = 'photo' AND e.photo_path = o.photo_path))""")
    say(f'  events: {db.total_changes - before} rows added')


def copy_database(src, dst):
    with closing(sqlite3.connect(src)) as source, closing(sqlite3.connect(dst)) as target:
        source.backup(target)


def move_with_retries(src, dst):
    for attempt in range(10):
        try:
            os.rename(src, dst)
            return True
        except OSError:
            time.sleep(1)
    return False


def main():
    global REPORT
    parser = argparse.ArgumentParser()
    appdata = os.environ.get('APPDATA', '')
    local = os.environ.get('LOCALAPPDATA', '')
    parser.add_argument('--real', default=os.path.join(appdata, 'HapsHub'))
    parser.add_argument('--overlay', default=os.path.join(local, r'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\HapsHub'))
    parser.add_argument('--staging', default=r'D:\VR\HapsHub-staging')
    parser.add_argument('--no-wait', action='store_true')
    parser.add_argument('--no-build', action='store_true')
    parser.add_argument('--no-launch', action='store_true')
    args = parser.parse_args()

    stamp = time.strftime('%Y%m%d-%H%M%S')
    kept = f'{args.real}.before-merge-{stamp}'
    for label, path in (('private copy', args.overlay), ('staged import', args.staging)):
        if not os.path.isdir(path):
            sys.exit(f'The {label} is missing: {path}\nNothing was changed.')
    if not os.path.exists(os.path.join(args.staging, 'VRCNData.db')):
        sys.exit('The staged import has no database. Nothing was changed.')

    if not args.no_wait:
        if running('HapsHub.exe'):
            print('Please close HapsHub: right-click its tray icon and choose Exit. Waiting...', flush=True)
        while running('HapsHub.exe'):
            time.sleep(1)
        time.sleep(2)

    if not args.no_build:
        print('Building the latest HapsHub...', flush=True)
        build = subprocess.run(['dotnet', 'build', '-c', 'Release'], cwd=REPO, capture_output=True, text=True)
        if build.returncode != 0:
            print(build.stdout[-1500:])
            sys.exit('The build failed. Your data was not touched.')

    had_real = os.path.isdir(args.real)
    if had_real:
        os.rename(args.real, kept)
    REPORT = open(os.path.join(os.path.dirname(args.staging.rstrip('\\/')), f'merge-report-{stamp}.txt'), 'w', encoding='utf-8')
    say('Kept your previous folder as', kept if had_real else '(there was none)')

    try:
        say('Copying your full data...')
        def skip(folder, names):
            return STAGED if os.path.normcase(folder) == os.path.normcase(args.overlay) else []
        shutil.copytree(args.overlay, args.real, ignore=skip)

        hub_dir = os.path.join(args.real, 'Hub')
        os.makedirs(hub_dir, exist_ok=True)
        for leftover in ('hub.db', 'hub.db-wal', 'hub.db-shm'):
            path = os.path.join(hub_dir, leftover)
            if os.path.exists(path):
                os.remove(path)
        for src, dst in ((os.path.join(args.staging, 'VRCNData.db'), os.path.join(args.real, 'VRCNData.db')),
                         (os.path.join(args.staging, 'Hub', 'hub.db'), os.path.join(hub_dir, 'hub.db'))):
            copy_database(src, dst)

        if had_real:
            say('Adding what your open session recorded since it started...')
            old_db = os.path.join(kept, 'VRCNData.db')
            if os.path.exists(old_db):
                with closing(sqlite3.connect(os.path.join(args.real, 'VRCNData.db'))) as db:
                    db.execute('ATTACH ? AS old', (old_db,))
                    with db:
                        merge_timeline(db)
                        merge_tables(db, DELTA_TABLES)
                    db.execute('DETACH old')
            old_hub = os.path.join(kept, 'Hub', 'hub.db')
            if os.path.exists(old_hub):
                with closing(sqlite3.connect(os.path.join(hub_dir, 'hub.db'))) as db:
                    db.execute('ATTACH ? AS old', (old_hub,))
                    with db:
                        for table, mode in HUB_TABLES:
                            merge_tables(db, [table], mode)
                    db.execute('DETACH old')
            for name in ('vrcx-history.db', 'vrcx-history.db-wal', 'vrcx-history.db-shm'):
                path = os.path.join(kept, 'Hub', name)
                if os.path.exists(path):
                    shutil.copy2(path, os.path.join(hub_dir, name))
            logs = os.path.join(kept, 'Logs')
            if os.path.isdir(logs):
                shutil.copytree(logs, os.path.join(args.real, 'Logs'), dirs_exist_ok=True)

            # Your settings come from the full copy, with the login from your latest session.
            settings = os.path.join(args.real, 'settings.json')
            current = json.load(open(settings, encoding='utf-8-sig'))
            latest = json.load(open(os.path.join(kept, 'settings.json'), encoding='utf-8-sig'))
            if latest.get('Accounts'):
                current['Accounts'] = latest['Accounts']
                current['ActiveAccountId'] = latest.get('ActiveAccountId', '')
                say('Kept the login from your latest session.')
            with open(settings, 'w', encoding='utf-8') as out:
                json.dump(current, out, indent=2, ensure_ascii=False)

        say('Checking...')
        with closing(sqlite3.connect(os.path.join(args.real, 'VRCNData.db'))) as db:
            check = db.execute('PRAGMA integrity_check').fetchone()[0]
            say('  database check:', check)
            say('  timeline events:', db.execute('SELECT COUNT(*) FROM events').fetchone()[0])
            say('  friend events:', db.execute('SELECT COUNT(*) FROM friend_events').fetchone()[0])
            say('  world hours:', (db.execute('SELECT SUM(total_seconds) FROM world_tracking').fetchone()[0] or 0) // 3600)
        with closing(sqlite3.connect(os.path.join(hub_dir, 'hub.db'))) as hub:
            hub_check = hub.execute('PRAGMA integrity_check').fetchone()[0]
            say('  hub check:', hub_check, '| import ledger rows:', hub.execute('SELECT COUNT(*) FROM vrcx_merge_ledger').fetchone()[0])
        if check != 'ok' or hub_check != 'ok':
            raise RuntimeError('A database check failed.')
    except Exception as error:
        say('FAILED:', error)
        # Put things back as they were. The half-made folder is kept beside them for a look.
        cleared = not os.path.isdir(args.real) or move_with_retries(args.real, f'{args.real}.failed-merge-{stamp}')
        if had_real and (not cleared or not move_with_retries(kept, args.real)):
            say('Could not put your previous folder back by itself. Nothing was lost: it is at', kept)
            say(f'Rename that folder to {args.real} before opening HapsHub.')
            return 2
        say('Your previous folder is back in place, so nothing was lost.')
        return 1

    # So the Claude app sees the real folder from now on, instead of this stale copy.
    os.rename(args.overlay, f'{args.overlay}.merged-{stamp}')
    say('Done. The private copy is kept as', f'{args.overlay}.merged-{stamp}')
    if not args.no_launch:
        subprocess.Popen([EXE], cwd=os.path.dirname(EXE), close_fds=True)
        say('Reopened HapsHub.')
    return 0


if __name__ == '__main__':
    code = main()
    if REPORT:
        REPORT.close()
    sys.exit(code)
