#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
TMPDIR="$(cd "$TMPDIR" && pwd -P)"
. "$REPO_ROOT/scripts/homebrew-patched-launcher.sh"
ISOLATION_BUILD_USER=""
ISOLATION_ROOT=""

cleanup() {
  homebrew_patched_launcher_cleanup
  if [ -n "$ISOLATION_BUILD_USER" ] && id "$ISOLATION_BUILD_USER" >/dev/null 2>&1; then
    /usr/bin/sudo -n -- /usr/bin/pkill -KILL -u "$(id -u "$ISOLATION_BUILD_USER")" \
      >/dev/null 2>&1 || true
    /usr/bin/sudo -n -- /usr/sbin/userdel -r "$ISOLATION_BUILD_USER" \
      >/dev/null 2>&1 || true
  fi
  if [ -n "$ISOLATION_ROOT" ]; then
    /usr/bin/sudo -n -- rm -rf "$ISOLATION_ROOT" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

fail() {
  echo "test-homebrew-patched-launcher.sh: $*" >&2
  exit 1
}

prefix="$TMPDIR/prefix"
patch_file="$TMPDIR/marker.patch"
work_dir="$TMPDIR/work"
mkdir -p "$prefix/bin" "$work_dir"

cat >"$prefix/bin/brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

brew_file="$(cd "${0%/*}" && pwd -P)/${0##*/}"
prefix="${brew_file%/*/*}"
repository="$prefix"
if [ -L "$brew_file" ]; then
  target="$(readlink "$brew_file")"
  target_dirname="$(dirname "$target")"
  if [[ "$target_dirname" = /* ]]; then
    target_dir="$(cd "$target_dirname" && pwd -P)"
  else
    target_dir="$(cd "$(dirname "$brew_file")/$target_dirname" && pwd -P)"
  fi
  repository="${target_dir%/*}"
fi

case "${1:-}" in
  --prefix)
    if [ "$#" -eq 2 ]; then
      printf '%s/opt/%s\n' "$prefix" "$2"
    elif [ -L "$brew_file" ] && [ "${FAKE_BREW_BAD_PREFIX:-}" = "1" ]; then
      printf '%s/bad\n' "$prefix"
    else
      printf '%s\n' "$prefix"
    fi
    ;;
  --cellar) printf '%s/Cellar\n' "$prefix" ;;
  --repository) printf '%s\n' "$repository" ;;
  spawn-daemon)
    marker="$2"
    started="$3"
    (/usr/bin/setsid bash -c \
      'printf started >"$2"; trap "" HUP; sleep 2; printf survived >"$1"' \
      bash "$marker" "$started" \
      </dev/null >/dev/null 2>&1 &)
    for ((attempt = 0; attempt < 50; attempt++)); do
      [ -e "$started" ] && exit 0
      sleep 0.02
    done
    exit 1
    ;;
  assert-no-new-privileges)
    awk '$1 == "NoNewPrivs:" { found = 1; if ($2 != 1) exit 1 } END { if (!found) exit 1 }' \
      /proc/self/status
    ;;
  assert-identity)
    [ "$(/usr/bin/id -u)" = "$2" ]
    [ "$(/usr/bin/id -g)" = "$3" ]
    ;;
  assert-working-directory)
    [ "$(pwd -P)" = "$2" ]
    ;;
  assert-source-aliases)
    [ "$#" -eq 6 ]
    [ "${HOMEBREW_KANDELO_ROOT:-}" = "$2" ]
    [ "${KANDELO_HOMEBREW_KANDELO_ROOT:-}" = "$2" ]
    [ -r "$2/source-marker" ]
    [ -r "$3/tap-marker" ]
    [ ! -e "$4" ]
    [ ! -e "$5" ]
    [ ! -e "$6" ]
    if ( : >"$2/write-probe" ) 2>/dev/null; then exit 1; fi
    if ( : >"$3/write-probe" ) 2>/dev/null; then exit 1; fi
    ;;
  assert-argv)
    [ "$#" -eq 6 ]
    [ "$2" = "" ]
    [ "$3" = "with spaces" ]
    [ "$4" = '$dollar' ]
    [ "$5" = '%percent' ]
    [ "$6" = $'line one\nline two' ]
    ;;
  assert-bottle-tags)
    [ "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" = "$2" ]
    [ "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" = "$3" ]
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$prefix/bin/brew"
printf 'unpatched\n' >"$prefix/marker.txt"

git -C "$prefix" init -q
git -C "$prefix" config user.name "Kandelo Test"
git -C "$prefix" config user.email "kandelo-test@example.invalid"
git -C "$prefix" add .
git -C "$prefix" commit -q -m "fixture"

cat >"$patch_file" <<'EOF'
diff --git a/marker.txt b/marker.txt
index 5742de9..a95d2c7 100644
--- a/marker.txt
+++ b/marker.txt
@@ -1 +1 @@
-unpatched
+patched
EOF

homebrew_patched_launcher_prepare "$prefix/bin/brew" "$patch_file" "$work_dir"

[ "$HOMEBREW_PATCHED_PREFIX" = "$prefix" ] || fail "selected prefix changed"
[ "$($HOMEBREW_PATCHED_BREW_BIN --prefix)" = "$prefix" ] || fail "launcher reports the wrong prefix"
[ "$($HOMEBREW_PATCHED_BREW_BIN --cellar)" = "$prefix/Cellar" ] || fail "launcher reports the wrong Cellar"
[ "$($HOMEBREW_PATCHED_BREW_BIN --prefix cmake)" = "$prefix/opt/cmake" ] ||
  fail "launcher moved a core dependency prefix"
[ "$($HOMEBREW_PATCHED_BREW_BIN --repository)" = "$HOMEBREW_PATCHED_OVERLAY" ] ||
  fail "launcher reports the wrong repository"
[ "$(cat "$prefix/marker.txt")" = "unpatched" ] || fail "original repository was modified"
[ "$(cat "$HOMEBREW_PATCHED_OVERLAY/marker.txt")" = "patched" ] || fail "overlay patch was not applied"
[ -L "$HOMEBREW_PATCHED_LAUNCHER" ] || fail "launcher symlink was not created"

launcher="$HOMEBREW_PATCHED_LAUNCHER"
overlay="$HOMEBREW_PATCHED_OVERLAY"
homebrew_patched_launcher_cleanup
[ ! -e "$launcher" ] || fail "launcher symlink was not removed"
[ ! -e "$overlay" ] || fail "overlay worktree was not removed"

failure_work_dir="$TMPDIR/failure-work"
mkdir -p "$failure_work_dir"
set +e
(
  set -e
  trap homebrew_patched_launcher_cleanup EXIT
  export FAKE_BREW_BAD_PREFIX=1
  homebrew_patched_launcher_prepare "$prefix/bin/brew" "$patch_file" "$failure_work_dir"
)
failure_status=$?
set -e
[ "$failure_status" -ne 0 ] || fail "invalid patched prefix unexpectedly succeeded"
[ ! -e "$failure_work_dir/homebrew-overlay" ] || fail "failed prepare left its overlay worktree"
if find "$prefix/bin" -maxdepth 1 -type l -name '.kandelo-brew-*' -print -quit | grep -q .; then
  fail "failed prepare left its launcher symlink"
fi
[ "$(cat "$prefix/marker.txt")" = "unpatched" ] || fail "failed prepare modified the original repository"
[ -z "$(git -C "$prefix" status --short)" ] || fail "failed prepare left the original repository dirty"

process_probe_dir="$TMPDIR/process-probe"
mkdir -p "$process_probe_dir"
cat >"$process_probe_dir/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "-n" ] && shift
[ "${1:-}" = "--" ] && shift
exec "$@"
EOF
cat >"$process_probe_dir/pgrep" <<'EOF'
#!/usr/bin/env bash
exit "${FAKE_PGREP_STATUS:?}"
EOF
chmod +x "$process_probe_dir/sudo" "$process_probe_dir/pgrep"
HOMEBREW_PATCHED_SUDO_BIN="$process_probe_dir/sudo"
HOMEBREW_PATCHED_PGREP_BIN="$process_probe_dir/pgrep"
HOMEBREW_PATCHED_BUILD_UID=1234
for expected_status in 0 1 2; do
  export FAKE_PGREP_STATUS="$expected_status"
  if homebrew_patched_launcher_uid_has_processes 2>/dev/null; then
    actual_status=0
  else
    actual_status="$?"
  fi
  [ "$actual_status" -eq "$expected_status" ] ||
    fail "process inspection status $expected_status was reported as $actual_status"
done
HOMEBREW_PATCHED_SUDO_BIN=""
HOMEBREW_PATCHED_PGREP_BIN=""
HOMEBREW_PATCHED_BUILD_UID=""

audit_probe_dir="$TMPDIR/audit-probe"
mkdir -p "$audit_probe_dir/tree"
cat >"$audit_probe_dir/sudo" <<'EOF'
#!/usr/bin/env bash
echo "fixture traversal denied" >&2
exit 13
EOF
chmod +x "$audit_probe_dir/sudo"
HOMEBREW_PATCHED_SUDO_BIN="$audit_probe_dir/sudo"
set +e
audit_error="$(homebrew_assert_tree_not_writable_by_user \
  fixture-user "$audit_probe_dir/tree" 2>&1)"
audit_status="$?"
set -e
[ "$audit_status" -eq 2 ] || fail "failed source audit did not return its contract error"
[[ "$audit_error" == *"fixture traversal denied"* ]] ||
  fail "failed source audit suppressed the underlying traversal error"
[[ "$audit_error" == *"could not inspect protected source"* ]] ||
  fail "failed source audit did not identify the rejected tree"
HOMEBREW_PATCHED_SUDO_BIN=""

if [ "$(uname -s)" = "Linux" ] && [ -x /usr/bin/sudo ] && \
   [ -x /usr/bin/systemd-run ] && [ -x /usr/bin/systemctl ] && \
   [ -x /usr/bin/getent ] && [ -x /usr/bin/pgrep ] && [ -x /usr/bin/pkill ] && \
   [ -x /usr/bin/setsid ] && \
   [ -d /run/systemd/system ] && /usr/bin/sudo -n true >/dev/null 2>&1; then
  ISOLATION_BUILD_USER="kandelo-hb-$$-${RANDOM}"
  ISOLATION_BUILD_USER="${ISOLATION_BUILD_USER:0:31}"
  ISOLATION_ROOT="$(mktemp -d /tmp/kandelo-launcher-test.XXXXXX)"
  /usr/bin/sudo -n -- chmod 1777 "$ISOLATION_ROOT"
  isolated_repo="$ISOLATION_ROOT/repo"
  isolated_prefix="$ISOLATION_ROOT/prefix"
  isolated_work="$ISOLATION_ROOT/work"
  isolated_cache="$ISOLATION_ROOT/cache"
  isolated_temp="$ISOLATION_ROOT/temp"
  isolated_source_parent="$ISOLATION_ROOT/private-runner-home"
  isolated_kandelo="$isolated_source_parent/kandelo"
  isolated_tap="$isolated_source_parent/tap"
  isolated_output="$isolated_source_parent/output"
  isolated_home="/home/$ISOLATION_BUILD_USER"
  daemon_marker="$isolated_work/detached-process-survived"
  daemon_started="$isolated_work/detached-process-started"
  mkdir -p "$isolated_repo/bin" "$isolated_prefix/bin" "$isolated_work" \
    "$isolated_cache" "$isolated_temp" "$isolated_kandelo" "$isolated_tap" \
    "$isolated_output"
  printf 'reviewed source\n' >"$isolated_kandelo/source-marker"
  printf 'reviewed tap\n' >"$isolated_tap/tap-marker"
  mkdir "$isolated_kandelo/runner-control"
  chmod 0700 "$isolated_kandelo/runner-control"
  chmod 0700 "$isolated_source_parent"
  cp "$prefix/bin/brew" "$isolated_repo/bin/brew"
  chmod +x "$isolated_repo/bin/brew"
  printf 'unpatched\n' >"$isolated_repo/marker.txt"
  git -C "$isolated_repo" init -q
  git -C "$isolated_repo" config user.name "Kandelo Test"
  git -C "$isolated_repo" config user.email "kandelo-test@example.invalid"
  git -C "$isolated_repo" add .
  git -C "$isolated_repo" commit -q -m fixture
  ln -s "$isolated_repo/bin/brew" "$isolated_prefix/bin/brew"

  /usr/bin/sudo -n -- /usr/sbin/useradd --system --user-group --create-home \
    --home-dir "$isolated_home" --shell /usr/sbin/nologin "$ISOLATION_BUILD_USER"
  export HOMEBREW_CACHE="$isolated_cache"
  export HOMEBREW_TEMP="$isolated_temp"
  export XDG_CONFIG_HOME="$isolated_work/xdg-config"
  export KANDELO_HOMEBREW_SUDO_BIN=/usr/bin/sudo
  export KANDELO_HOMEBREW_SYSTEMD_RUN_BIN=/usr/bin/systemd-run
  export KANDELO_HOMEBREW_SYSTEMCTL_BIN=/usr/bin/systemctl
  export KANDELO_HOMEBREW_GETENT_BIN=/usr/bin/getent
  export KANDELO_HOMEBREW_PGREP_BIN=/usr/bin/pgrep
  export KANDELO_HOMEBREW_PKILL_BIN=/usr/bin/pkill
  mkdir -p "$XDG_CONFIG_HOME/homebrew"

  homebrew_patched_launcher_prepare \
    "$isolated_prefix/bin/brew" "$patch_file" "$isolated_work"
  homebrew_patched_launcher_isolate \
    "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
    "$isolated_output"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-identity \
    "$(id -u "$ISOLATION_BUILD_USER")" "$(id -g "$ISOLATION_BUILD_USER")"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-working-directory "$isolated_work"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-source-aliases \
    "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR/kandelo" \
    "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR/tap" \
    "$isolated_kandelo" "$isolated_tap" "$isolated_output"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-argv \
    "" "with spaces" '$dollar' '%percent' $'line one\nline two'
  "$HOMEBREW_PATCHED_BREW_BIN" assert-bottle-tags "" ""
  HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo \
  KANDELO_HOMEBREW_BOTTLE_TAG=wasm32_kandelo \
    "$HOMEBREW_PATCHED_BREW_BIN" assert-bottle-tags \
      wasm32_kandelo wasm32_kandelo
  "$HOMEBREW_PATCHED_BREW_BIN" assert-no-new-privileges
  "$HOMEBREW_PATCHED_BREW_BIN" spawn-daemon "$daemon_marker" "$daemon_started"
  [ -e "$daemon_started" ] || fail "detached Formula process never started"
  sleep 3
  [ ! -e "$daemon_marker" ] || fail "detached Formula process survived its transient service"
  set +e
  /usr/bin/sudo -n -- /usr/bin/pgrep -u "$(id -u "$ISOLATION_BUILD_USER")" \
    >/dev/null 2>&1
  pgrep_status="$?"
  set -e
  [ "$pgrep_status" -eq 1 ] || fail "Formula process check did not prove an empty UID"
  homebrew_patched_launcher_teardown "$ISOLATION_BUILD_USER"
  homebrew_patched_launcher_verify_isolation
  homebrew_patched_launcher_cleanup
  /usr/bin/sudo -n -- /usr/sbin/userdel -r "$ISOLATION_BUILD_USER"
  ! id "$ISOLATION_BUILD_USER" >/dev/null 2>&1 || fail "Formula build identity survived retirement"
  ISOLATION_BUILD_USER=""
  /usr/bin/sudo -n -- rm -rf "$ISOLATION_ROOT"
  ISOLATION_ROOT=""
fi

echo "test-homebrew-patched-launcher.sh: ok"
