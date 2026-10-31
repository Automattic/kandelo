#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec scripts/dev-shell.sh host/node_modules/.bin/tsx scripts/run-nodejs-network-tests.ts "$@"
