#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREPARER="$SCRIPT_DIR/prepare-homebrew-package-materializer.sh"
AUTHORITY_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
TMP_ROOT="$(mktemp -d)"
HOST_TARGET="fixture-host-$$"
cleanup() {
  rm -rf "$TMP_ROOT" "$AUTHORITY_ROOT/target/$HOST_TARGET"
}
trap cleanup EXIT
mkdir -p "$TMP_ROOT/bin"

cat >"$TMP_ROOT/bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[ "$PWD" = "${TEST_AUTHORITY_ROOT:?}" ] || {
  echo "Cargo did not run from publisher authority" >&2
  exit 1
}

case "${1:-}" in
  fetch)
    actual=("$@")
    expected=(
      fetch
      --locked
      --manifest-path
      "$TEST_AUTHORITY_ROOT/Cargo.toml"
      --target
      "$TEST_HOST_TARGET"
    )
    [ "$#" -eq "${#expected[@]}" ]
    for index in "${!expected[@]}"; do
      [ "${actual[$index]}" = "${expected[$index]}" ]
    done
    [ ! -e "$TEST_LOG" ]
    printf 'fetch\n' >"$TEST_LOG"
    ;;
  build)
    actual=("$@")
    expected=(
      build
      --locked
      --release
      -p
      xtask
      --manifest-path
      "$TEST_AUTHORITY_ROOT/Cargo.toml"
      --target
      "$TEST_HOST_TARGET"
      --target-dir
      "$TEST_AUTHORITY_ROOT/target"
      --quiet
    )
    [ "$#" -eq "${#expected[@]}" ]
    for index in "${!expected[@]}"; do
      [ "${actual[$index]}" = "${expected[$index]}" ]
    done
    [ "$(cat "$TEST_LOG")" = fetch ] || {
      echo "xtask build ran before the complete locked host fetch" >&2
      exit 1
    }
    printf 'build\n' >>"$TEST_LOG"
    mkdir -p "$TEST_AUTHORITY_ROOT/target/$TEST_HOST_TARGET/release"
    printf '#!/usr/bin/env bash\nexit 0\n' \
      >"$TEST_AUTHORITY_ROOT/target/$TEST_HOST_TARGET/release/xtask"
    chmod +x "$TEST_AUTHORITY_ROOT/target/$TEST_HOST_TARGET/release/xtask"
    ;;
  *)
    echo "unexpected Cargo action: ${1:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$TMP_ROOT/bin/cargo"

rm -f "$AUTHORITY_ROOT/target/$HOST_TARGET/release/xtask"
PATH="$TMP_ROOT/bin:$PATH" \
TEST_AUTHORITY_ROOT="$AUTHORITY_ROOT" \
TEST_HOST_TARGET="$HOST_TARGET" \
TEST_LOG="$TMP_ROOT/cargo.log" \
  bash "$PREPARER" --host-target "$HOST_TARGET"

[ "$(cat "$TMP_ROOT/cargo.log")" = $'fetch\nbuild' ]
[ -x "$AUTHORITY_ROOT/target/$HOST_TARGET/release/xtask" ]

assert_invalid_target() {
  local invalid_target="$1"
  rm -f "$TMP_ROOT/cargo.log"
  if PATH="$TMP_ROOT/bin:$PATH" \
     TEST_AUTHORITY_ROOT="$AUTHORITY_ROOT" \
     TEST_HOST_TARGET="$HOST_TARGET" \
     TEST_LOG="$TMP_ROOT/cargo.log" \
       bash "$PREPARER" --host-target "$invalid_target" >/dev/null 2>&1; then
    echo "preparer accepted invalid host target: $invalid_target" >&2
    exit 1
  fi
  [ ! -e "$TMP_ROOT/cargo.log" ]
}

assert_invalid_target 'fixture/host'
assert_invalid_target '..'

echo "test-prepare-homebrew-package-materializer: ok"
