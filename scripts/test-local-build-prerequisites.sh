#!/usr/bin/env bash
# The full graph must provision both SDK architectures before deriving keys.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/scripts" "$test_root/bin"
cp "$REPO_ROOT/scripts/run-local-build.sh" "$test_root/scripts/"
cat > "$test_root/bin/rustc" <<'RUSTC'
#!/usr/bin/env bash
echo 'host: test-host'
RUSTC
cat > "$test_root/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$PREREQUISITE_TEST_ROOT/commands"
case "$*" in
    *' -- bootstrap sdk')
        echo 'SDK prerequisite output'
        [ "${PREREQUISITE_TEST_FAILURE:-}" != sdk ] || exit 17
        touch "$PREREQUISITE_TEST_ROOT/sdk-ready"
        ;;
    *' -- bootstrap sysroot64')
        test -f "$PREREQUISITE_TEST_ROOT/sdk-ready"
        echo 'wasm64 prerequisite output'
        [ "${PREREQUISITE_TEST_FAILURE:-}" != wasm64 ] || exit 18
        touch "$PREREQUISITE_TEST_ROOT/wasm64-ready"
        ;;
    *' -- local-build run '*)
        test -f "$PREREQUISITE_TEST_ROOT/sdk-ready"
        test -f "$PREREQUISITE_TEST_ROOT/wasm64-ready"
        echo '{"outcome":"succeeded"}'
        ;;
    *) exit 99 ;;
esac
CARGO
chmod +x "$test_root/bin/rustc" "$test_root/bin/cargo"
export KANDELO_DEV_SHELL_TOOL_PATH="$test_root/bin:$PATH"
export KANDELO_SOURCE_CACHE_ROOT="$test_root/cache"
export PREREQUISITE_TEST_ROOT="$test_root"
for failure in none sdk wasm64; do
    rm -f "$test_root/sdk-ready" "$test_root/wasm64-ready" "$test_root/commands"
    status=0
    PREREQUISITE_TEST_FAILURE="$failure" \
        bash "$test_root/scripts/run-local-build.sh" \
        > "$test_root/output" 2> "$test_root/error" || status=$?
    case "$failure" in
        none)
            test "$status" = 0
            test "$(cat "$test_root/output")" = '{"outcome":"succeeded"}'
            test "$(wc -l < "$test_root/commands" | tr -d ' ')" = 3
            ;;
        sdk) test "$status" = 17 ;;
        wasm64) test "$status" = 18 ;;
    esac
    if [ "$failure" != none ]; then
        test ! -s "$test_root/output"
        ! grep -F -- ' -- local-build run ' "$test_root/commands"
    fi
done
echo 'test-local-build-prerequisites.sh: ok'
