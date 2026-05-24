#!/bin/bash
# Drop-in nginx binary replacement for the upstream test suite.
# Delegates to nginx-wrapper.ts which runs nginx in CentralizedKernelWorker.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx tsx "$SCRIPT_DIR/nginx-wrapper.ts" "$@"
