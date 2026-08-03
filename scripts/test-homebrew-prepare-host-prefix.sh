#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-host-prefix.XXXXXX")"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
test_uid="$(id -u)"
runner_gid="$(id -g)"
LINUX_PRIVILEGE_FIXTURE=""

cleanup() {
  if [ -n "$LINUX_PRIVILEGE_FIXTURE" ] && \
     [ -e "$LINUX_PRIVILEGE_FIXTURE" ]; then
    case "$LINUX_PRIVILEGE_FIXTURE" in
      "$TEST_ROOT"/*) ;;
      *)
        echo "test-homebrew-prepare-host-prefix: refusing unsafe cleanup" >&2
        return 1
        ;;
    esac
    # Restore only the exact mktemp child that this test made root-owned. The
    # ordinary unprivileged cleanup below then remains the deletion boundary.
    /usr/bin/sudo -n -- /usr/bin/chown -R \
      "$test_uid:$runner_gid" -- "$LINUX_PRIVILEGE_FIXTURE" || return
    /usr/bin/sudo -n -- /usr/bin/chmod -R u+rwX -- \
      "$LINUX_PRIVILEGE_FIXTURE" || return
  fi
  chmod -R u+rwX -- "$TEST_ROOT" || return
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh"

HOMEBREW_HOST_PREFIX_STAT="$(command -v stat)"
HOMEBREW_HOST_PREFIX_INSTALL="$(command -v install)"
HOMEBREW_HOST_PREFIX_REALPATH="$(command -v realpath)"
HOMEBREW_HOST_PREFIX_CHMOD="$(command -v chmod)"
HOMEBREW_HOST_PREFIX_SUDO="$TEST_ROOT/fake-sudo"
cat >"$HOMEBREW_HOST_PREFIX_SUDO" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = -n ] && shift
[ "${1:-}" = -- ] && shift
exec "$@"
EOF
chmod 0755 "$HOMEBREW_HOST_PREFIX_SUDO"

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

# GitHub-hosted Ubuntu runners provision /opt as 0777. Privileged setup must
# remove only its group/world write bits before it creates the protected
# Kandelo anchor, while leaving the Formula-owned prefix writable.
mkdir -m 0777 "$TEST_ROOT/hosted-runner-opt"
hosted_parent="$TEST_ROOT/hosted-runner-opt"
hosted_anchor="$hosted_parent/kandelo"
hosted_prefix="$hosted_anchor/homebrew"
homebrew_prepare_host_prefix_harden_anchor_parent \
  "$hosted_parent" "$hosted_anchor" "$test_uid" "$test_gid"
[ "$(state "$hosted_parent")" = "$test_uid:$test_gid:755" ]
homebrew_prepare_prefix_campaign_tree \
  "$hosted_prefix" "$test_uid" "$test_gid" "$test_uid" "$test_gid"
[ "$(state "$hosted_anchor")" = "$test_uid:$test_gid:755" ]
[ "$(state "$hosted_prefix")" = "$test_uid:$test_gid:755" ]
printf 'hosted runner child write succeeds\n' >"$hosted_prefix/write-probe"
rm "$hosted_prefix/write-probe"

# Hardening must never turn a hostile pre-existing child into the protected
# anchor merely by making its parent non-writable.
mkdir -m 0777 "$TEST_ROOT/hostile-runner-opt"
hostile_parent="$TEST_ROOT/hostile-runner-opt"
hostile_anchor="$hostile_parent/kandelo"
mkdir -m 0777 "$hostile_anchor"
expect_failure "prefix anchor must be traversable" \
  homebrew_prepare_host_prefix_harden_anchor_parent \
    "$hostile_parent" "$hostile_anchor" "$test_uid" "$test_gid"
[ "$(state "$hostile_parent")" = "$test_uid:$test_gid:777" ]
[ "$(state "$hostile_anchor")" = "$test_uid:$test_gid:777" ]

mkdir -m 0777 "$TEST_ROOT/linked-runner-opt"
linked_parent="$TEST_ROOT/linked-runner-opt"
ln -s "$TEST_ROOT/symlink-target" "$linked_parent/kandelo"
expect_failure "prefix anchor must be a real non-symlink directory" \
  homebrew_prepare_host_prefix_harden_anchor_parent \
    "$linked_parent" "$linked_parent/kandelo" "$test_uid" "$test_gid"
[ "$(state "$linked_parent")" = "$test_uid:$test_gid:777" ]

mkdir -m 0755 "$TEST_ROOT/prefix-link-parent"
mkdir -m 0755 "$TEST_ROOT/prefix-link-parent/kandelo"
ln -s "$TEST_ROOT/symlink-target" \
  "$TEST_ROOT/prefix-link-parent/kandelo/homebrew"
expect_failure "mutable Homebrew prefix must be a real non-symlink directory" \
  homebrew_prepare_prefix_campaign_tree \
    "$TEST_ROOT/prefix-link-parent/kandelo/homebrew" \
    "$test_uid" "$test_gid" "$test_uid" "$test_gid"

if [ "$(uname -s)" = Linux ] && [ "$test_uid" != 0 ] && \
   [ -x /usr/bin/sudo ] && \
   /usr/bin/sudo -n -- /usr/bin/true >/dev/null 2>&1; then
  LINUX_PRIVILEGE_FIXTURE="$TEST_ROOT/linux-privilege-boundary"
  /usr/bin/sudo -n -- "$HOMEBREW_HOST_PREFIX_INSTALL" -d \
    -o 0 -g 0 -m 0755 -- "$LINUX_PRIVILEGE_FIXTURE"
  privileged_prefix="$LINUX_PRIVILEGE_FIXTURE/kandelo/homebrew"
  portable_sudo="$HOMEBREW_HOST_PREFIX_SUDO"
  HOMEBREW_HOST_PREFIX_SUDO=/usr/bin/sudo
  homebrew_prepare_prefix_campaign_tree \
    "$privileged_prefix" 0 0 "$test_uid" "$runner_gid"
  [ "$(state "$LINUX_PRIVILEGE_FIXTURE")" = "0:0:755" ]
  [ "$(state "$LINUX_PRIVILEGE_FIXTURE/kandelo")" = "0:0:755" ]
  [ "$(state "$privileged_prefix")" = "$test_uid:$runner_gid:755" ]
  [ "$(state "$privileged_prefix/bin")" = \
    "$test_uid:$runner_gid:755" ]
  printf 'runner child write succeeds\n' >"$privileged_prefix/write-probe"
  if mv -- "$privileged_prefix" \
    "$LINUX_PRIVILEGE_FIXTURE/kandelo/homebrew-replaced" \
    >"$TEST_ROOT/linux-rename.out" 2>"$TEST_ROOT/linux-rename.err"; then
    echo "test-homebrew-prepare-host-prefix:" \
      "runner replaced a prefix below the root-owned anchor" >&2
    exit 1
  fi
  [ -d "$privileged_prefix" ] && \
    [ ! -e "$LINUX_PRIVILEGE_FIXTURE/kandelo/homebrew-replaced" ]
  HOMEBREW_HOST_PREFIX_SUDO="$portable_sudo"
else
  echo "test-homebrew-prepare-host-prefix:" \
    "skipping root-owned anchor proof" \
    "(requires non-root Linux with passwordless sudo)" >&2
fi

expect_failure "not a reviewed pair" \
  homebrew_prepare_host_prefix_main \
    --layout-mode prefix-campaign --prefix "$TEST_ROOT/not-opt/homebrew"
expect_failure "not a reviewed pair" \
  homebrew_prepare_host_prefix_main \
    --layout-mode current --prefix /opt/kandelo/homebrew

grep -F 'prefix-campaign:/opt/kandelo/homebrew)' \
  "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh" >/dev/null
grep -F 'canonical:/opt/kandelo/homebrew' \
  "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh" >/dev/null
grep -F '"$prefix" 0 0 "$(/usr/bin/id -u)" "$(/usr/bin/id -g)"' \
  "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh" >/dev/null
grep -F '/opt /opt/kandelo 0 0 || return' \
  "$REPO_ROOT/scripts/homebrew-prepare-host-prefix.sh" >/dev/null

echo "test-homebrew-prepare-host-prefix: pass"
