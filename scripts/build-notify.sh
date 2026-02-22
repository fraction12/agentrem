#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="$REPO_ROOT/assets/notify-src/main.swift"
OUT="$REPO_ROOT/assets/Agentrem.app/Contents/MacOS/agentrem-notify"

echo "Building agentrem-notify..."
swiftc "$SRC" -o "$OUT"
echo "✅  Built: $OUT"
