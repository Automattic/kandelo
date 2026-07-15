#!/usr/bin/env bash
# Focused checks for the protected Formula browser cache.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
TMPDIR="$(cd "$TMPDIR" && pwd -P)"
cleanup() {
  local status="$?"
  if [ "$status" -ne 0 ]; then
    [ ! -f "$TMPDIR/node.log" ] || sed 's/^/node: /' "$TMPDIR/node.log" >&2
    [ ! -f "$TMPDIR/sudo.log" ] || sed 's/^/sudo: /' "$TMPDIR/sudo.log" >&2
  fi
  chmod -R u+w "$TMPDIR" 2>/dev/null || true
  rm -rf "$TMPDIR"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "test-homebrew-provision-formula-browser.sh: $*" >&2
  exit 1
}

BROWSER_APP="$TMPDIR/browser-app"
FAKE_NODE="$TMPDIR/node"
FAKE_SUDO="$TMPDIR/sudo"
NODE_LOG="$TMPDIR/node.log"
SUDO_LOG="$TMPDIR/sudo.log"
mkdir -p "$BROWSER_APP/node_modules/playwright"
printf '{"private":true}\n' >"$BROWSER_APP/package.json"
printf '// reviewed fixture\n' >"$BROWSER_APP/node_modules/playwright/cli.js"

cat >"$FAKE_NODE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_NODE_LOG"
if [ "${1:-}" = "$FAKE_PLAYWRIGHT_CLI" ]; then
  [ "$*" = "$FAKE_PLAYWRIGHT_CLI install chromium --with-deps" ] || exit 41
  executable="$PLAYWRIGHT_BROWSERS_PATH/chromium-fixture/chrome"
  mkdir -p "$(dirname "$executable")"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$executable"
  chmod 0755 "$executable"
  exit 0
fi
if [ "${1:-}" = "-" ]; then
  printf '%s' "${FAKE_BROWSER_EXECUTABLE:-$PLAYWRIGHT_BROWSERS_PATH/chromium-fixture/chrome}"
  exit 0
fi
exit 42
EOF
chmod 0755 "$FAKE_NODE"

cat >"$FAKE_SUDO" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_SUDO_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|-H) shift ;;
    -u) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
case "${1:-}" in
  chown) exit 0 ;;
  chmod) shift; command chmod "$@" ;;
  test) shift; command test "$@" ;;
  *) exit 43 ;;
esac
EOF
chmod 0755 "$FAKE_SUDO"

run_provisioner() {
  local shared_temp="$1"
  FAKE_NODE_LOG="$NODE_LOG" \
    FAKE_SUDO_LOG="$SUDO_LOG" \
    FAKE_PLAYWRIGHT_CLI="$BROWSER_APP/node_modules/playwright/cli.js" \
    FAKE_BROWSER_EXECUTABLE="${FAKE_BROWSER_EXECUTABLE:-}" \
    bash "$REPO_ROOT/scripts/homebrew-provision-formula-browser.sh" \
      --shared-temp "$shared_temp" \
      --build-user kandelo-homebrew-build \
      --sudo-bin "$FAKE_SUDO" \
      --node-bin "$FAKE_NODE" \
      --browser-app "$BROWSER_APP"
}

SHARED_TEMP="$TMPDIR/shared"
mkdir "$SHARED_TEMP"
run_provisioner "$SHARED_TEMP" >/dev/null
BROWSER_CACHE="$SHARED_TEMP/ms-playwright"
BROWSER_EXECUTABLE="$BROWSER_CACHE/chromium-fixture/chrome"
[ -x "$BROWSER_EXECUTABLE" ] || fail "provisioner did not install Chromium"
[ ! -w "$BROWSER_CACHE" ] && [ ! -w "$BROWSER_EXECUTABLE" ] ||
  fail "provisioned browser cache remained writable"
grep -Fx "$BROWSER_APP/node_modules/playwright/cli.js install chromium --with-deps" \
  "$NODE_LOG" >/dev/null || fail "provisioner did not use the reviewed Playwright CLI"
grep -Fx -- "-n -- chown -R root:root $BROWSER_CACHE" "$SUDO_LOG" >/dev/null ||
  fail "provisioner did not transfer the browser cache to the protected identity"
grep -Fx -- "-n -H -u kandelo-homebrew-build -- test -w $BROWSER_CACHE -o -w $BROWSER_EXECUTABLE" \
  "$SUDO_LOG" >/dev/null || fail "provisioner did not verify browser immutability"

PREEXISTING="$TMPDIR/preexisting"
mkdir -p "$PREEXISTING/ms-playwright"
if run_provisioner "$PREEXISTING" >/dev/null 2>&1; then
  fail "provisioner accepted a pre-existing browser cache"
fi

ESCAPE_ROOT="$TMPDIR/escape-root"
ESCAPE_TARGET="$TMPDIR/outside/chrome"
mkdir -p "$ESCAPE_ROOT" "$(dirname "$ESCAPE_TARGET")"
printf '#!/usr/bin/env bash\nexit 0\n' >"$ESCAPE_TARGET"
chmod 0755 "$ESCAPE_TARGET"
if FAKE_BROWSER_EXECUTABLE="$ESCAPE_TARGET" run_provisioner "$ESCAPE_ROOT" \
  >/dev/null 2>"$TMPDIR/escape.err"; then
  fail "provisioner accepted a browser executable outside its cache"
fi
grep -F "Playwright Chromium escaped its cache" "$TMPDIR/escape.err" >/dev/null ||
  fail "provisioner did not explain an escaped browser executable"

echo "test-homebrew-provision-formula-browser.sh: ok"
