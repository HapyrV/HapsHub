"""Fails if an upstream merge adds or reopens a way to send avatar data past ForwardingBlock.

Run after merging upstream:  python tools/hapshub/check-forwarding.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Each sending or queueing function must start with a ForwardingBlock check.
GATED = {
    "main/MessageRouter.cs": [
        "QueueAvtrdbReport", "QueueAvtrdbSubmit", "SendToAvtrdb",
        "QueueAvtrIcuReport", "QueueAvtrIcuSubmit", "SendToAvtrIcu",
        "QueueVrcndbSubmit", "QueueVrcndbRecheck", "PostToVrcndb",
    ],
    "Services/Avatar Databases/PopularityReporter.cs": ["Report", "SyncFavoriteLikes"],
    "Services/VRCNPlusAPI/VRCNPlusService.cs": ["CheckEntitlementAsync"],
}

# Every address on these hosts must be a known send (above) or a known lookup.
HOSTS = re.compile(r"avtr\.icu/|avtrdb\.com/|vrcnext\.com/|VrcndbBase\b.*\+|\{VrcndbBase\}")
KNOWN = re.compile(
    r"/avatar/ingest|upload-bulk|\{VrcndbBase\}/\{endpoint\}|hit\.php|like\.php|vrcnplus\.php"  # gated sends
    r"|/resolve|/search|/similar/|/api/(vrcn/)?query|avatar\.php|wiki\.vrcnext\.com"  # lookups, kept on by decision
)

problems = []

for rel, functions in GATED.items():
    text = (ROOT / rel).read_text(encoding="utf-8-sig")
    for name in functions:
        pattern = re.compile(
            r"\b" + name + r"\([^)]*\)\s*\{\s*(?://[^\n]*\s*)?if \(!ForwardingBlock\.Allows\("
        )
        if not pattern.search(text):
            problems.append(f"{rel}: {name} doesn't start with a ForwardingBlock check")

for folder in ("main", "Services", "frontend"):
    for path in (ROOT / folder).rglob("*"):
        if path.suffix not in (".cs", ".js", ".html") or not path.is_file():
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8-sig", errors="replace").splitlines(), 1):
            if "openUrl" in line:  # A link the user clicks, not something the app sends.
                continue
            if HOSTS.search(line) and "http" in line and not KNOWN.search(line):
                base_only = "VrcndbBase =" in line or 'db.vrcnext.com" + t' in line
                if not base_only:
                    problems.append(f"{path.relative_to(ROOT)}:{number}: unknown address: {line.strip()[:110]}")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("Forwarding check passed: all send paths are gated and no unknown addresses were found.")
