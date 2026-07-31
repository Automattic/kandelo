#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd)"
exec python3 \
  "$SCRIPT_ROOT/homebrew_browser_proof_runtime_handoff.py" create "$@"
