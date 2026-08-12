#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/kandelo-launcher-batch.XXXXXX)"
BUILD_USER="kandelo-hb-batch-$$"
BUILD_USER="${BUILD_USER:0:31}"
BUILD_USER_CREATED=false

# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-patched-launcher.sh"

cleanup() {
  local original_status="$?"
  trap - EXIT
  homebrew_patched_launcher_cleanup >/dev/null 2>&1 || true
  if [ "$BUILD_USER_CREATED" = true ] && /usr/bin/id "$BUILD_USER" >/dev/null 2>&1; then
    /usr/bin/sudo -n -- /usr/bin/pkill -KILL -u "$(/usr/bin/id -u "$BUILD_USER")" \
      >/dev/null 2>&1 || true
    /usr/bin/sudo -n -- /usr/sbin/userdel "$BUILD_USER" >/dev/null 2>&1 || true
  fi
  /usr/bin/sudo -n -- /usr/bin/rm -rf -- "$TEST_ROOT" >/dev/null 2>&1 || true
  exit "$original_status"
}
trap cleanup EXIT

fail() {
  echo "test-homebrew-patched-launcher-batch.sh: $*" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "requires Linux"
for required in /usr/bin/id /usr/bin/ln /usr/bin/pkill /usr/bin/readlink \
  /usr/bin/stat /usr/bin/sudo /usr/sbin/useradd /usr/sbin/userdel; do
  [ -x "$required" ] || fail "missing required host tool: $required"
done
/usr/bin/sudo -n true >/dev/null 2>&1 || fail "requires passwordless sudo"
chmod 0711 "$TEST_ROOT"

SOURCE_REPO="$TEST_ROOT/homebrew-source"
PREFIX="$TEST_ROOT/prefix"
FIRST_WORK="$TEST_ROOT/first-work"
SECOND_WORK="$TEST_ROOT/second-work"
CACHE="$TEST_ROOT/cache"
TEMP="$TEST_ROOT/temp"
PATCH_FILE="$TEST_ROOT/platform.patch"
DEPENDENCY_PLAN="$TEST_ROOT/dependency-plan.json"
TIER2_ATTESTATION="$TEST_ROOT/tier2-attestation.json"
POISON_SUDO="$TEST_ROOT/poison-sudo"
POISON_MARKER="$TEST_ROOT/poison-sudo-ran"
mkdir -p "$SOURCE_REPO/bin" "$PREFIX/bin" "$FIRST_WORK" "$SECOND_WORK" \
  "$CACHE" "$TEMP"
export BATCH_PREFIX="$PREFIX"

cat >"$SOURCE_REPO/bin/brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --repository)
    resolved="$(/usr/bin/readlink -f -- "$0")"
    printf '%s\n' "${resolved%/bin/brew}"
    ;;
  --prefix)
    if [ "$#" -eq 1 ]; then
      printf '%s\n' "${BATCH_PREFIX:?}"
    else
      printf '%s/opt/%s\n' "${BATCH_PREFIX:?}" "$2"
    fi
    ;;
  --cellar) printf '%s/Cellar\n' "${BATCH_PREFIX:?}" ;;
  *) exit 2 ;;
esac
EOF
chmod 0755 "$SOURCE_REPO/bin/brew"
printf 'unpatched\n' >"$SOURCE_REPO/marker.txt"
printf '{"schema":1,"dependencies":[]}\n' >"$DEPENDENCY_PLAN"
printf '{"schema":3,"formula":"batch"}\n' >"$TIER2_ATTESTATION"
chmod 0600 "$DEPENDENCY_PLAN" "$TIER2_ATTESTATION"
cat >"$POISON_SUDO" <<EOF
#!/usr/bin/env bash
set -euo pipefail
: >"$POISON_MARKER"
exit 97
EOF
chmod 0755 "$POISON_SUDO"
git -C "$SOURCE_REPO" init -q
git -C "$SOURCE_REPO" config user.name 'Kandelo Test'
git -C "$SOURCE_REPO" config user.email kandelo-test@example.invalid
git -C "$SOURCE_REPO" add .
git -C "$SOURCE_REPO" commit -q -m fixture
cat >"$PATCH_FILE" <<'EOF'
diff --git a/marker.txt b/marker.txt
index 5742de9..a95d2c7 100644
--- a/marker.txt
+++ b/marker.txt
@@ -1 +1 @@
-unpatched
+patched
EOF
ln -s "$SOURCE_REPO/bin/brew" "$PREFIX/bin/brew"

/usr/bin/sudo -n -- /usr/sbin/useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin "$BUILD_USER"
BUILD_USER_CREATED=true
BUILD_GID="$(/usr/bin/id -g "$BUILD_USER")"
export KANDELO_HOMEBREW_BUILD_USER="$BUILD_USER"
export KANDELO_HOMEBREW_SUDO_BIN=/usr/bin/sudo
export HOMEBREW_CACHE="$CACHE"
export HOMEBREW_TEMP="$TEMP"
export HOMEBREW_GUEST_PREFIX="$PREFIX"

# A freshly activated prefix is still owned by the trusted invoker and has not
# run Brew yet, so its lock directory is truthfully absent. The handoff must be
# a no-op for that exact state and must not manufacture unrelated prefix paths.
[ ! -e "$PREFIX/var" ] && [ ! -L "$PREFIX/var" ] ||
  fail "fresh prefix fixture unexpectedly contains Homebrew state"
homebrew_patched_launcher_restore_invoker_bootstrap_roots \
  "$BUILD_USER" "$PREFIX"
[ ! -e "$PREFIX/var" ] && [ ! -L "$PREFIX/var" ] ||
  fail "fresh bootstrap handoff created unrelated prefix state"

# Once a Formula identity owns the reused prefix, a missing exact lock root is
# ambiguous and must reject instead of silently treating it as a fresh prefix.
/usr/bin/sudo -n -- /usr/bin/chown "$BUILD_USER:$BUILD_GID" "$PREFIX"
if homebrew_patched_launcher_restore_invoker_bootstrap_roots \
    "$BUILD_USER" "$PREFIX" >"$TEST_ROOT/missing-lock.out" \
    2>"$TEST_ROOT/missing-lock.err"; then
  fail "reused build-owned prefix accepted a missing lock root"
fi
grep -F "reused prefix requires its exact Homebrew lock root" \
  "$TEST_ROOT/missing-lock.err" >/dev/null ||
  fail "reused missing-lock rejection was not explicit"
/usr/bin/sudo -n -- /usr/bin/install -d -o "$BUILD_USER" -g "$BUILD_GID" \
  -m 0755 "$PREFIX/var" "$PREFIX/var/homebrew" \
  "$PREFIX/var/homebrew/locks"
/usr/bin/sudo -n -- /usr/bin/touch \
  "$PREFIX/var/homebrew/locks/attacker-owned"
if homebrew_patched_launcher_restore_invoker_bootstrap_roots \
    "$BUILD_USER" "$PREFIX" >"$TEST_ROOT/attacker-owner.out" \
    2>"$TEST_ROOT/attacker-owner.err"; then
  fail "reused prefix accepted an unexpected lock owner"
fi
grep -F "bootstrap root has an unexpected owner" \
  "$TEST_ROOT/attacker-owner.err" >/dev/null ||
  fail "unexpected lock owner rejection was not explicit"
/usr/bin/sudo -n -- /usr/bin/rm \
  "$PREFIX/var/homebrew/locks/attacker-owned"

# Model the exact state left after one isolated Formula lifecycle: the
# canonical seed is protected and the insertion directory remains sticky and
# writable only to the continuing Formula build group.
/usr/bin/sudo -n -- /usr/bin/install -d -o root -g "$BUILD_GID" -m 1775 \
  "$PREFIX" "$PREFIX/bin"
/usr/bin/sudo -n -- /usr/bin/chown -h root:root "$PREFIX/bin/brew"
[ "$(/usr/bin/stat -c '%u:%g:%a' "$PREFIX/bin")" = "0:$BUILD_GID:1775" ] &&
  [ "$(/usr/bin/stat -c '%u:%g' "$PREFIX/bin/brew")" = "0:0" ] ||
  fail "fixture did not model a completed Formula launcher lifecycle"

homebrew_patched_launcher_select_host_git
homebrew_patched_launcher_prepare \
  "$PREFIX/bin/brew" "$PATCH_FILE" "$FIRST_WORK"
FIRST_LAUNCHER="$HOMEBREW_PATCHED_LAUNCHER"
[ -L "$FIRST_LAUNCHER" ] &&
  [ "${FIRST_LAUNCHER%/*}" = "$PREFIX/bin" ] &&
  [ "$(/usr/bin/stat -c '%u:%g' "$FIRST_LAUNCHER")" = 0:0 ] &&
  [ "$(/usr/bin/readlink "$FIRST_LAUNCHER")" = \
    "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] ||
  fail "second Formula lifecycle did not create its exact patched launcher"
printf 'must remain unchanged\n' >"$TEST_ROOT/control-symlink-target"
/usr/bin/sudo -n -H -u "$BUILD_USER" -- /usr/bin/ln -s -- \
  "$TEST_ROOT/control-symlink-target" \
  "$PREFIX/.kandelo-publisher-build-dependencies.json"
if homebrew_patched_launcher_stage_dependency_plan \
    "$DEPENDENCY_PLAN" >/dev/null 2>&1; then
  fail "batch control staging followed a pre-existing destination symlink"
fi
[ "$(cat "$TEST_ROOT/control-symlink-target")" = "must remain unchanged" ] ||
  fail "batch control staging changed a symlink target"
/usr/bin/sudo -n -- /usr/bin/rm -f -- \
  "$PREFIX/.kandelo-publisher-build-dependencies.json"
homebrew_patched_launcher_stage_dependency_plan "$DEPENDENCY_PLAN"
homebrew_patched_launcher_stage_tier2_attestation "$TIER2_ATTESTATION"
for control_file in \
  "$PREFIX/.kandelo-publisher-build-dependencies.json" \
  "$PREFIX/.kandelo-publisher-tier2-attestation.json"; do
  [ -f "$control_file" ] && [ ! -L "$control_file" ] &&
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$control_file")" = "0:0:444:1" ] ||
    fail "batch control file was not atomically root-owned and immutable"
done
/usr/bin/cmp "$DEPENDENCY_PLAN" \
  "$PREFIX/.kandelo-publisher-build-dependencies.json" >/dev/null &&
  /usr/bin/cmp "$TIER2_ATTESTATION" \
    "$PREFIX/.kandelo-publisher-tier2-attestation.json" >/dev/null ||
  fail "batch control staging changed exact source bytes"
if homebrew_patched_launcher_stage_control_file invalid "$DEPENDENCY_PLAN" \
    ../arbitrary-prefix-write.json 65536 "invalid control" >/dev/null 2>&1; then
  fail "batch control staging accepted an arbitrary prefix path"
fi
[ ! -e "$TEST_ROOT/arbitrary-prefix-write.json" ] ||
  fail "batch control staging escaped the exact prefix"
homebrew_patched_launcher_remove_tier2_attestation
homebrew_patched_launcher_remove_dependency_plan
[ ! -e "$PREFIX/.kandelo-publisher-build-dependencies.json" ] &&
  [ ! -e "$PREFIX/.kandelo-publisher-tier2-attestation.json" ] ||
  fail "batch control cleanup left staged prefix files"
VALID_SUDO="$HOMEBREW_PATCHED_SUDO_BIN"
HOMEBREW_PATCHED_SUDO_BIN="$POISON_SUDO"
if homebrew_patched_launcher_stage_dependency_plan \
    "$DEPENDENCY_PLAN" >/dev/null 2>&1; then
  fail "batch control staging accepted caller-selected sudo"
fi
[ ! -e "$POISON_MARKER" ] ||
  fail "batch control staging executed caller-selected sudo"
HOMEBREW_PATCHED_SUDO_BIN="$VALID_SUDO"
homebrew_patched_launcher_cleanup
[ ! -e "$FIRST_LAUNCHER" ] &&
  [ "$(/usr/bin/stat -c '%u:%g:%a' "$PREFIX/bin")" = "0:$BUILD_GID:1775" ] &&
  [ "$(/usr/bin/stat -c '%u:%g' "$PREFIX/bin/brew")" = "0:0" ] ||
  fail "second Formula cleanup changed the protected prefix or canonical seed"

# The reusable workflow gives build and verification separate fresh runners.
# A batch campaign reuses one prefix, so the next trusted workflow invocation
# must regain only its declared Homebrew bootstrap lock/cache/temp roots after
# the isolated Formula identity owned them. Keep all surrounding prefix state
# build-owned to prove this is not a broad ownership reset.
/usr/bin/sudo -n -- /usr/bin/install -d -o "$BUILD_USER" -g "$BUILD_GID" \
  -m 0755 "$PREFIX/var" "$PREFIX/var/homebrew" \
  "$PREFIX/var/homebrew/locks" "$PREFIX/Cellar"
/usr/bin/sudo -n -H -u "$BUILD_USER" -- /usr/bin/touch \
  "$PREFIX/var/homebrew/locks/vendor-install-ruby"
: >"$CACHE/download"
: >"$TEMP/work"
/usr/bin/sudo -n -- /usr/bin/chown -R "$BUILD_USER:$BUILD_GID" \
  "$PREFIX/var" "$PREFIX/Cellar" "$CACHE" "$TEMP"
/usr/bin/sudo -n -H -u "$BUILD_USER" -- /usr/bin/install -d -m 0700 \
  "$TEMP/private-worker-entry"
/usr/bin/sudo -n -H -u "$BUILD_USER" -- /usr/bin/touch \
  "$TEMP/private-worker-entry/state"
if /usr/bin/find "$TEMP" -xdev -print >/dev/null 2>&1; then
  fail "private Formula temp fixture was unexpectedly traversable by invoker"
fi
homebrew_patched_launcher_restore_invoker_bootstrap_roots \
  "$BUILD_USER" "$PREFIX"
INVOKER_UID="$(/usr/bin/id -u)"
INVOKER_GID="$(/usr/bin/id -g)"
for restored in "$PREFIX/var/homebrew/locks" "$CACHE" "$TEMP"; do
  [ -z "$(/usr/bin/find "$restored" -xdev \
    \( ! -uid "$INVOKER_UID" -o ! -gid "$INVOKER_GID" \) -print -quit)" ] ||
    fail "batch handoff did not restore exact invoker ownership: $restored"
done
[ "$(/usr/bin/stat -c '%u:%g' "$PREFIX/var/homebrew")" = \
    "$(/usr/bin/id -u "$BUILD_USER"):$BUILD_GID" ] &&
  [ "$(/usr/bin/stat -c '%u:%g' "$PREFIX/Cellar")" = \
    "$(/usr/bin/id -u "$BUILD_USER"):$BUILD_GID" ] ||
  fail "batch handoff changed Homebrew state outside bootstrap roots"
: >"$PREFIX/var/homebrew/locks/verifier-bootstrap"
: >"$CACHE/verifier-download"
: >"$TEMP/verifier-work"
[ -f "$TEMP/private-worker-entry/state" ] ||
  fail "batch handoff lost private Formula temporary state"

export KANDELO_HOMEBREW_SUDO_BIN="$POISON_SUDO"
if homebrew_patched_launcher_restore_invoker_bootstrap_roots \
    "$BUILD_USER" "$PREFIX" >/dev/null 2>&1; then
  fail "batch handoff accepted caller-selected sudo"
fi
[ ! -e "$POISON_MARKER" ] || fail "batch handoff executed caller-selected sudo"
if homebrew_patched_launcher_prepare \
    "$PREFIX/bin/brew" "$PATCH_FILE" "$SECOND_WORK" >/dev/null 2>&1; then
  fail "sealed launcher preparation accepted caller-selected sudo"
fi
[ ! -e "$POISON_MARKER" ] || fail "sealed launcher preparation executed caller-selected sudo"
homebrew_patched_launcher_cleanup

echo "test-homebrew-patched-launcher-batch.sh: ok"
