#!/usr/bin/env bash
# Deny official-devnet / throwaway identities on the mainnet publish set.
# Target list is derived - not operator-typed paths.
#
#   ichor/governance-ui/scripts/deny-list-mainnet.sh [dist-dir]
#
# Optional dist-dir is the tree that will be shipped (deploy-dao.sh passes
# SHIP_DIST). Default is ichor/governance-ui/dist. When an override is given,
# deployment.devnet.json is NOT skipped — a mainnet ship that still contains
# it must fail.
#
# Exit 0 = clean. Exit 1 = hit. Exit 2 = tool/fixture error.
# Do not fold those with && / ||.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
if [[ $# -gt 1 ]]; then
  echo "usage: $0 [dist-dir]" >&2
  exit 2
fi
DENY_LIST_DIST="${1:-}"
export DENY_LIST_DIST

if ! command -v grep >/dev/null 2>&1; then
  echo 'ERROR: grep not found' >&2
  exit 2
fi

DENY="$(python3 - <<'PY'
import json, pathlib, re, sys

paths = [
    pathlib.Path("ichor/governance-ui/fixtures/official-devnet-kekbull.json"),
    pathlib.Path("ichor/governance-ui/fixtures/official-devnet-abandoned.json"),
]
allow = {
    "5E6eeUqF2UunqwGDavfCgh28smQe88JSN7MXGvCdh4Zd",
    "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj",
    "87iypjzaf4HiFKfqbpHRMqxA7hV2UZPiaFFxuPyUrVAA",
}
extra = {
    "3dWPo9uvnTw6DeQiksqe8XoLa28h8H4EuEPNeJu89JmW",
    "CfTgyYgnZcmpM68uHqXnZ36vM5zXw31JBZkR4T5zpump",
    "9E67LHAXYX9JfrvWcGbdVhYHTxgxXyD55ayTyVa6J9Jr",
    "APwSUektCPqJBiEd588wZrYrNMeK51VhNhqDMvUvRs3u",
    "5hY8L3pT4p4z4ji533dMUp2KKLQuWZe9JsHnZPreU74k",
}
pk = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
keys = []
seen = set()

def walk(value):
    if isinstance(value, dict):
        for item in value.values():
            walk(item)
    elif isinstance(value, list):
        for item in value:
            walk(item)
    elif isinstance(value, str) and pk.fullmatch(value):
        if value not in allow and value not in seen:
            seen.add(value)
            keys.append(value)

for path in paths:
    if not path.is_file():
        print(f"ERROR: missing fixture {path}", file=sys.stderr)
        sys.exit(2)
    walk(json.loads(path.read_text()))

for key in extra:
    if key not in seen:
        seen.add(key)
        keys.append(key)

if not keys:
    print("ERROR: empty deny-list", file=sys.stderr)
    sys.exit(2)
print("|".join(keys))
PY
)" || { echo 'ERROR: failed to build deny-list from fixtures' >&2; exit 2; }

if [ -z "$DENY" ]; then
  echo 'ERROR: empty deny-list' >&2
  exit 2
fi

LOCK_INT="$(python3 - <<'PY'
import json, pathlib, sys
path = pathlib.Path("ichor/governance-ui/fixtures/official-devnet-kekbull.json")
raw = json.loads(path.read_text())["expectedLockedLiquidityBaseUnits"]
if not isinstance(raw, str) or not raw.isdigit() or raw[0] == "0":
    print("ERROR: expectedLockedLiquidityBaseUnits missing or non-numeric", file=sys.stderr)
    sys.exit(2)
print(raw)
PY
)" || { echo 'ERROR: failed to read lock integer from fixture' >&2; exit 2; }

TARGETS="$(python3 - <<'PY'
import os
from pathlib import Path

root = Path(".")
required = [
    root / "ichor/governance-ui/public/deployment.json",
    root / "ichor/governance-ui/public/deployment.mainnet.json",
    root / "docs/ICHOR_MAINNET.md",
    root / "docs/LAUNCH_DAO_AFTER_KEKBULL.md",
    root / "website/index.html",
    root / "website/token.json",
    root / "website/site.js",
]
optional_files = [
    root / "ichor/e2e/run-ichor-mainnet-d.sh",
    root / "ichor/kekbull_governance/scripts/deploy-mainnet.sh",
]
skip_names = {
    "deployment.devnet.json",
}
skip_suffixes = (".map", ".d.ts")
dist_override = os.environ.get("DENY_LIST_DIST", "").strip()
# Default in-repo dist still skips the Vite-copied official-devnet file.
# A ship-tree override must not — that is the file deploy-dao.sh strips.
skip_devnet_named = not bool(dist_override)

missing = [str(p) for p in required if not p.is_file()]
if missing:
    raise SystemExit("ERROR: missing required target(s): " + ", ".join(missing))

out = []
for p in required + optional_files:
    if p.is_file():
        out.append(p)

dist = Path(dist_override) if dist_override else root / "ichor/governance-ui/dist"
if dist_override and not dist.is_dir():
    raise SystemExit(f"ERROR: deny-list dist override is not a directory: {dist}")
if dist.is_dir():
    for p in sorted(dist.rglob("*")):
        if not p.is_file():
            continue
        if skip_devnet_named and p.name in skip_names:
            continue
        if p.name.endswith(skip_suffixes):
            continue
        out.append(p)

seen = set()
uniq = []
for p in out:
    key = str(p)
    if key in seen:
        continue
    seen.add(key)
    uniq.append(key)
print("\n".join(uniq))
PY
)" || { echo 'ERROR: failed to derive deny-list targets' >&2; exit 2; }

if [ -z "$TARGETS" ]; then
  echo 'ERROR: empty target set' >&2
  exit 2
fi

mapfile -t TARGET_ARR <<<"$TARGETS"

deny_check() {
  local pattern="$1" label="$2" fixed="$3"
  if [ "$fixed" = "fixed" ]; then
    grep -n -F -e "$pattern" -- "${TARGET_ARR[@]}"
  else
    grep -n -E -e "$pattern" -- "${TARGET_ARR[@]}"
  fi
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: deny-list hit ($label)"
    return 1
  fi
  if [ "$rc" -eq 1 ]; then
    return 0
  fi
  echo "ERROR: grep failed (exit $rc) ($label)" >&2
  return 2
}

deny_check "$DENY" "pubkey" regex || exit $?
deny_check "$LOCK_INT" "locked-liquidity integer" fixed || exit $?
echo "OK: no deny-list hit (${#TARGET_ARR[@]} files)"
