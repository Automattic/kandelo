#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-host-prefix.XXXXXX")"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh"

HOMEBREW_HOST_PREFIX_STAT="$(command -v stat)"
HOMEBREW_HOST_PREFIX_INSTALL="$(command -v install)"
HOMEBREW_HOST_PREFIX_REALPATH="$(command -v realpath)"
HOMEBREW_HOST_PREFIX_SUDO="$TEST_ROOT/fake-sudo"
cat >"$HOMEBREW_HOST_PREFIX_SUDO" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = -n ] && shift
[ "${1:-}" = -- ] && shift
exec "$@"
EOF
chmod 0755 "$HOMEBREW_HOST_PREFIX_SUDO"

test_uid="$(id -u)"
# macOS temporary roots may inherit wheel through a setgid ancestor even when
# the interactive primary group is staff. Use the fixture's actual group so
# the portable, unprivileged contract test can recreate that exact ownership.
test_gid="$("$HOMEBREW_HOST_PREFIX_STAT" -c '%g' -- "$TEST_ROOT")"

state() {
  "$HOMEBREW_HOST_PREFIX_STAT" -c '%u:%g:%a' -- "$1"
}

expect_failure() {
  local expected="$1"
  shift
  local error="$TEST_ROOT/error.txt"
  if "$@" >"$TEST_ROOT/output.txt" 2>"$error"; then
    echo "test-homebrew-prepare-host-prefix: unexpectedly accepted: $*" >&2
    exit 1
  fi
  grep -F "$expected" "$error" >/dev/null || {
    echo "test-homebrew-prepare-host-prefix: missing error: $expected" >&2
    cat "$error" >&2
    exit 1
  }
}

mkdir -m 0755 "$TEST_ROOT/absent-parent"
absent_prefix="$TEST_ROOT/absent-parent/kandelo/homebrew"
homebrew_prepare_prefix_campaign_tree \
  "$absent_prefix" "$test_uid" "$test_gid" "$test_uid" "$test_gid"
[ "$(state "$TEST_ROOT/absent-parent/kandelo")" = \
  "$test_uid:$test_gid:755" ]
[ "$(state "$absent_prefix")" = "$test_uid:$test_gid:755" ]
[ "$(state "$absent_prefix/bin")" = "$test_uid:$test_gid:755" ]
printf 'writable\n' >"$absent_prefix/activation-probe"
rm "$absent_prefix/activation-probe"

# A second activation must accept the exact safe anchor it created.
homebrew_prepare_prefix_campaign_tree \
  "$absent_prefix" "$test_uid" "$test_gid" "$test_uid" "$test_gid"

mkdir -m 0755 "$TEST_ROOT/symlink-parent" "$TEST_ROOT/symlink-target"
ln -s "$TEST_ROOT/symlink-target" "$TEST_ROOT/symlink-parent/kandelo"
expect_failure "prefix anchor must be a real non-symlink directory" \
  homebrew_prepare_prefix_campaign_tree \
    "$TEST_ROOT/symlink-parent/kandelo/homebrew" \
    "$test_uid" "$test_gid" "$test_uid" "$test_gid"

mkdir -m 0755 "$TEST_ROOT/replaceable-parent"
mkdir -m 0555 "$TEST_ROOT/replaceable-parent/kandelo"
expect_failure "prefix anchor is replaceable" \
  homebrew_prepare_host_prefix_assert_trusted_directory \
    "$TEST_ROOT/replaceable-parent/kandelo" 999999 "$test_gid" \
    "prefix anchor"
expect_failure "prefix anchor does not have its required trusted group" \
  homebrew_prepare_host_prefix_assert_trusted_directory \
    "$TEST_ROOT/replaceable-parent/kandelo" "$test_uid" 999999 \
    "prefix anchor"

mkdir -m 0775 "$TEST_ROOT/writable-parent"
expect_failure "prefix anchor parent must be traversable" \
  homebrew_prepare_prefix_campaign_tree \
    "$TEST_ROOT/writable-parent/kandelo/homebrew" \
    "$test_uid" "$test_gid" "$test_uid" "$test_gid"

mkdir -m 0755 "$TEST_ROOT/writable-anchor-parent"
mkdir -m 0775 "$TEST_ROOT/writable-anchor-parent/kandelo"
expect_failure "prefix anchor must be traversable" \
  homebrew_prepare_prefix_campaign_tree \
    "$TEST_ROOT/writable-anchor-parent/kandelo/homebrew" \
    "$test_uid" "$test_gid" "$test_uid" "$test_gid"

mkdir -m 0755 "$TEST_ROOT/prefix-link-parent"
mkdir -m 0755 "$TEST_ROOT/prefix-link-parent/kandelo"
ln -s "$TEST_ROOT/symlink-target" \
  "$TEST_ROOT/prefix-link-parent/kandelo/homebrew"
expect_failure "mutable Homebrew prefix must be a real non-symlink directory" \
  homebrew_prepare_prefix_campaign_tree \
    "$TEST_ROOT/prefix-link-parent/kandelo/homebrew" \
    "$test_uid" "$test_gid" "$test_uid" "$test_gid"

expect_failure "not a reviewed pair" \
  homebrew_prepare_host_prefix_main \
    --layout-mode prefix-campaign --prefix "$TEST_ROOT/not-opt/homebrew"
expect_failure "not a reviewed pair" \
  homebrew_prepare_host_prefix_main \
    --layout-mode current --prefix /opt/kandelo/homebrew

grep -F 'prefix-campaign:/opt/kandelo/homebrew)' \
  "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh" >/dev/null
grep -F '"$prefix" 0 0 "$(/usr/bin/id -u)" "$(/usr/bin/id -g)"' \
  "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh" >/dev/null

echo "test-homebrew-prepare-host-prefix: pass"
