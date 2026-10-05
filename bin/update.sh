#!/usr/bin/env bash
# Re-extract wiki data from the local game install into public/.
#   bin/update.sh                         # default Steam path
#   WT2_GAME=/path/to/Wild-Terra-2_Data bin/update.sh
#   bin/update.sh --force-icons           # extra args go to extract.py
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
    python3 -m venv .venv
fi
.venv/bin/pip install -q -r requirements.txt

args=()
if [ -n "${WT2_GAME:-}" ]; then
    args+=(--game "$WT2_GAME")
fi
exec .venv/bin/python extract.py "${args[@]}" "$@"
