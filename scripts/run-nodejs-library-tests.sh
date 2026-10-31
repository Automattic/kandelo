#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
exec scripts/dev-shell.sh host/node_modules/.bin/tsx scripts/run-nodejs-library-tests.ts "$@"
