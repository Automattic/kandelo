#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREPARER="$SCRIPT_DIR/prepare-current-authority-validator.sh"
AUTHORITY_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/producer/.cargo" \
  "$TMP_ROOT/producer-cargo-home"

cat >"$TMP_ROOT/producer/.cargo/config.toml" <<EOF
[build]
rustc-wrapper = "$TMP_ROOT/producer-wrapper"
EOF
cp "$TMP_ROOT/producer/.cargo/config.toml" \
  "$TMP_ROOT/producer-cargo-home/config.toml"
cat >"$TMP_ROOT/producer-wrapper" <<'EOF'
#!/usr/bin/env bash
printf 'producer config executed\n' >"${TEST_PRODUCER_MARKER:?}"
exit 99
EOF
chmod +x "$TMP_ROOT/producer-wrapper"
printf '[workspace]\n' >"$TMP_ROOT/producer/Cargo.toml"

cat >"$TMP_ROOT/bin/rustc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = "-vV" ]
printf 'rustc 1.0.0\nhost: test-host\n'
EOF
chmod +x "$TMP_ROOT/bin/rustc"

cat >"$TMP_ROOT/bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[ "$PWD" = "${TEST_AUTHORITY_ROOT:?}" ] || {
  echo "cargo did not run from current authority" >&2
  exit 1
}
[ "${CARGO_HOME:?}" = "${TEST_STATE_DIR:?}/cargo-home" ] || {
  echo "cargo inherited a non-isolated home" >&2
  exit 1
}
if printf '%s\n' "$@" | grep -F "${TEST_PRODUCER_ROOT:?}" >/dev/null; then
  echo "cargo consulted the producer path" >&2
  exit 1
fi

case "${1:-}" in
  fetch)
    actual=("$@")
    expected=(
      fetch
      --locked
      --manifest-path
      "$TEST_AUTHORITY_ROOT/Cargo.toml"
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
      test-host
      --target-dir
      "$TEST_STATE_DIR/target"
    )
    [ "$#" -eq "${#expected[@]}" ]
    for index in "${!expected[@]}"; do
      [ "${actual[$index]}" = "${expected[$index]}" ]
    done
    [ "$(cat "$TEST_LOG")" = fetch ] || {
      echo "validator build ran before the authority lock fetch" >&2
      exit 1
    }
    printf 'build\n' >>"$TEST_LOG"
    mkdir -p "$TEST_STATE_DIR/target/test-host/release"
    printf '#!/usr/bin/env bash\nexit 0\n' \
      >"$TEST_STATE_DIR/target/test-host/release/xtask"
    chmod +x "$TEST_STATE_DIR/target/test-host/release/xtask"
    ;;
  *)
    echo "unexpected cargo action: ${1:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$TMP_ROOT/bin/cargo"

state_dir="$TMP_ROOT/authority-state"
marker="$TMP_ROOT/producer-config-executed"
PATH="$TMP_ROOT/bin:$PATH" \
CARGO_HOME="$TMP_ROOT/producer-cargo-home" \
TEST_AUTHORITY_ROOT="$AUTHORITY_ROOT" \
TEST_PRODUCER_ROOT="$TMP_ROOT/producer" \
TEST_PRODUCER_MARKER="$marker" \
TEST_STATE_DIR="$state_dir" \
TEST_LOG="$TMP_ROOT/cargo.log" \
  bash "$PREPARER" --state-dir "$state_dir"

[ "$(cat "$TMP_ROOT/cargo.log")" = $'fetch\nbuild' ]
[ "$(cat "$state_dir/cargo-home-path")" = "$state_dir/cargo-home" ]
[ "$(cat "$state_dir/xtask-path")" = \
  "$state_dir/target/test-host/release/xtask" ]
[ -x "$state_dir/target/test-host/release/xtask" ]
[ ! -e "$marker" ]

if PATH="$TMP_ROOT/bin:$PATH" \
   TEST_AUTHORITY_ROOT="$AUTHORITY_ROOT" \
   TEST_PRODUCER_ROOT="$TMP_ROOT/producer" \
   TEST_PRODUCER_MARKER="$marker" \
   TEST_STATE_DIR="$state_dir" \
   TEST_LOG="$TMP_ROOT/cargo.log" \
     bash "$PREPARER" --state-dir "$state_dir" >/dev/null 2>&1; then
  echo "validator preparation reused an existing trust-phase state" >&2
  exit 1
fi

echo "test-prepare-current-authority-validator: ok"
