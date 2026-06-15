#!/usr/bin/env bash
set -euo pipefail

# Executable JS-shell shim for Mozilla's official SpiderMonkey harnesses.
#
# The upstream Python harnesses expect a native `js` shell path. This wrapper
# gives them one while actually launching Kandelo's js.wasm under NodeKernelHost
# via examples/run-example.ts.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${SPIDERMONKEY_NODE_JS_SHELL_URL:-}" ]; then
  exec node --import tsx/esm \
    "$REPO_ROOT/scripts/kandelo-node-js-shell-client.ts" \
    "$@"
fi

JS_WASM="${SPIDERMONKEY_WASM:-}"

if [ -z "$JS_WASM" ]; then
  for candidate in \
    "$("$REPO_ROOT/scripts/resolve-binary.sh" programs/js.wasm 2>/dev/null || true)" \
    "$("$REPO_ROOT/scripts/resolve-binary.sh" programs/spidermonkey.wasm 2>/dev/null || true)" \
    "$REPO_ROOT/packages/registry/spidermonkey/bin/js.wasm"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      JS_WASM="$candidate"
      break
    fi
  done
fi

if [ ! -f "$JS_WASM" ]; then
  echo "ERROR: SpiderMonkey js.wasm not found." >&2
  echo "Run: bash packages/registry/spidermonkey/build-spidermonkey.sh" >&2
  exit 127
fi

export TIMEOUT="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-600000}"

exec node --experimental-wasm-exnref --import tsx/esm \
  "$REPO_ROOT/examples/run-example.ts" \
  "$JS_WASM" \
  "$@"
