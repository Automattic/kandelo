#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd)"
exec env PYTHONDONTWRITEBYTECODE=1 python3 \
  "$SCRIPT_ROOT/test_homebrew_browser_proof_runtime_handoff.py"
