"""Adds interface text to all ten language files at once.

    python -I tools/hapshub/add-i18n.py tools/hapshub/i18n/<feature>.json [--update]

The file maps each key to its text per language:
    { "hub.example.title": { "en": "Example", "de": "Beispiel", ... } }
A language that is left out gets the English text. Keys already in a language file are kept as they are
unless --update is given. Each file keeps its own line endings and byte order mark.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = ["en", "de", "es", "fr", "ja", "ko", "ru", "uk", "zh-CN", "zh-TW"]


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    update = "--update" in sys.argv
    if not args:
        print(__doc__)
        return 2
    added = changed = 0
    for source in args:
        entries = json.loads(Path(source).read_text(encoding="utf-8-sig"))
        for key, texts in entries.items():
            if "en" not in texts:
                print(f"FAIL {key} has no English text")
                return 1
            unknown = set(texts) - set(LANGUAGES)
            if unknown:
                print(f"FAIL {key} names unknown languages: {sorted(unknown)}")
                return 1
        for language in LANGUAGES:
            path = ROOT / "frontend" / "i18n" / f"{language}.json"
            raw = path.read_bytes().decode("utf-8")
            newline = "\r\n" if "\r\n" in raw else "\n"
            existing = json.loads(raw.lstrip(chr(0xFEFF)))
            lines = []
            for key, texts in entries.items():
                value = texts.get(language, texts["en"])
                if key not in existing:
                    lines.append(f"  {json.dumps(key, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}")
                    added += 1
                elif update and existing[key] != value:
                    pattern = re.compile(r'^(\s*)' + re.escape(json.dumps(key, ensure_ascii=False)) + r'\s*:\s*"(?:[^"\\]|\\.)*"', re.M)
                    replacement = f"{json.dumps(key, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}"
                    raw, count = pattern.subn(lambda m: m.group(1) + replacement, raw, count=1)
                    if count != 1:
                        print(f"FAIL could not find {key} in {path.name}")
                        return 1
                    changed += 1
            if lines:
                match = re.search(r'"\s*}\s*$', raw)
                closing = raw[match.start() + 1:]
                raw = raw[:match.start() + 1] + "," + newline + ("," + newline).join(lines) + closing
            json.loads(raw.lstrip(chr(0xFEFF)))
            path.write_bytes(raw.encode("utf-8"))
    print(f"ok: {added} added, {changed} changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
