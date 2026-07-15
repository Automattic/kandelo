#!/usr/bin/env bash
# Provision the browser runtime used by Homebrew Formula tests.
set -euo pipefail

SHARED_TEMP=""
BUILD_USER=""
SUDO_BIN=""
NODE_BIN=""
BROWSER_APP=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-provision-formula-browser.sh --shared-temp <dir> --build-user <user> --sudo-bin <path> --node-bin <path> --browser-app <dir>

Installs Playwright Chromium into the protected cache next to HOMEBREW_CACHE.
The Homebrew Formula runner derives that cache from HOMEBREW_CACHE so browser
tests continue to work under the isolated Formula identity and HOME directory.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --shared-temp) SHARED_TEMP="${2:-}"; shift 2 ;;
    --build-user) BUILD_USER="${2:-}"; shift 2 ;;
    --sudo-bin) SUDO_BIN="${2:-}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:-}"; shift 2 ;;
    --browser-app) BROWSER_APP="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "homebrew-provision-formula-browser.sh: unknown flag $1" >&2
      usage
      exit 2
      ;;
  esac
done

require_value() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-provision-formula-browser.sh: --$name is required" >&2
    exit 2
  fi
}

require_value shared-temp "$SHARED_TEMP"
require_value build-user "$BUILD_USER"
require_value sudo-bin "$SUDO_BIN"
require_value node-bin "$NODE_BIN"
require_value browser-app "$BROWSER_APP"

if ! [[ "$BUILD_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "homebrew-provision-formula-browser.sh: invalid build user: $BUILD_USER" >&2
  exit 2
fi
if [ ! -d "$SHARED_TEMP" ] || [ -L "$SHARED_TEMP" ]; then
  echo "homebrew-provision-formula-browser.sh: shared temp must be a real directory" >&2
  exit 2
fi
if [ ! -x "$SUDO_BIN" ] || [ -L "$SUDO_BIN" ]; then
  echo "homebrew-provision-formula-browser.sh: sudo boundary is unavailable" >&2
  exit 2
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "homebrew-provision-formula-browser.sh: Node executable is unavailable" >&2
  exit 2
fi
if [ ! -d "$BROWSER_APP" ] || [ -L "$BROWSER_APP" ]; then
  echo "homebrew-provision-formula-browser.sh: browser app must be a real directory" >&2
  exit 2
fi

SHARED_TEMP="$(cd "$SHARED_TEMP" && pwd -P)"
BROWSER_APP="$(cd "$BROWSER_APP" && pwd -P)"
PLAYWRIGHT_CLI="$BROWSER_APP/node_modules/playwright/cli.js"
if [ ! -f "$PLAYWRIGHT_CLI" ] || [ -L "$PLAYWRIGHT_CLI" ]; then
  echo "homebrew-provision-formula-browser.sh: reviewed Playwright CLI is unavailable" >&2
  exit 2
fi

BROWSER_CACHE="$SHARED_TEMP/ms-playwright"
if [ -e "$BROWSER_CACHE" ] || [ -L "$BROWSER_CACHE" ]; then
  echo "homebrew-provision-formula-browser.sh: browser cache already exists" >&2
  exit 2
fi
mkdir "$BROWSER_CACHE"
BROWSER_CACHE="$(cd "$BROWSER_CACHE" && pwd -P)"

HOST_SYSTEM_PATH="$(dirname "$SUDO_BIN"):/usr/sbin:/usr/bin:/sbin:/bin"
PATH="$PATH:$HOST_SYSTEM_PATH" PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE" \
  "$NODE_BIN" "$PLAYWRIGHT_CLI" install chromium --with-deps

BROWSER_EXECUTABLE="$({
  PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE" \
    "$NODE_BIN" - "$BROWSER_APP/package.json" <<'NODE'
const { createRequire } = require("node:module");
const requireFromBrowserApp = createRequire(process.argv[2]);
const { chromium } = requireFromBrowserApp("@playwright/test");
process.stdout.write(chromium.executablePath());
NODE
} 2>/dev/null)"
if [ -z "$BROWSER_EXECUTABLE" ] || [ ! -f "$BROWSER_EXECUTABLE" ] || \
   [ -L "$BROWSER_EXECUTABLE" ] || [ ! -x "$BROWSER_EXECUTABLE" ]; then
  echo "homebrew-provision-formula-browser.sh: Playwright Chromium executable is unavailable" >&2
  exit 2
fi

BROWSER_EXECUTABLE_DIR="$(cd "$(dirname "$BROWSER_EXECUTABLE")" && pwd -P)"
BROWSER_EXECUTABLE="$BROWSER_EXECUTABLE_DIR/$(basename "$BROWSER_EXECUTABLE")"
case "$BROWSER_EXECUTABLE" in
  "$BROWSER_CACHE"/*) ;;
  *)
    echo "homebrew-provision-formula-browser.sh: Playwright Chromium escaped its cache" >&2
    exit 2
    ;;
esac

"$SUDO_BIN" -n -- chown -R root:root "$BROWSER_CACHE"
"$SUDO_BIN" -n -- chmod -R a-w "$BROWSER_CACHE"
"$SUDO_BIN" -n -- chmod -R a+rX "$BROWSER_CACHE"

if ! "$SUDO_BIN" -n -H -u "$BUILD_USER" -- \
  test -r "$BROWSER_CACHE" -a -x "$BROWSER_CACHE" -a \
  -r "$BROWSER_EXECUTABLE" -a -x "$BROWSER_EXECUTABLE"; then
  echo "homebrew-provision-formula-browser.sh: Formula identity cannot execute Chromium" >&2
  exit 2
fi
if "$SUDO_BIN" -n -H -u "$BUILD_USER" -- \
  test -w "$BROWSER_CACHE" -o -w "$BROWSER_EXECUTABLE"; then
  echo "homebrew-provision-formula-browser.sh: Formula identity can modify Chromium" >&2
  exit 2
fi

echo "homebrew-provision-formula-browser.sh: provisioned $BROWSER_EXECUTABLE"
