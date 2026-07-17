#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
TMPDIR="$(cd "$TMPDIR" && pwd -P)"
. "$REPO_ROOT/scripts/homebrew-patched-launcher.sh"
ISOLATION_BUILD_USER=""
ISOLATION_ROOT=""
NATIVE_TEST_BASE=""
ISOLATION_NATIVE_BASE=""

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
  if [ -n "$ISOLATION_NATIVE_BASE" ]; then
    /usr/bin/sudo -n -- rm -rf "$ISOLATION_NATIVE_BASE" >/dev/null 2>&1 || true
  fi
  if [ -n "$NATIVE_TEST_BASE" ]; then
    rm -rf "$NATIVE_TEST_BASE"
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
publisher_patch_file="$TMPDIR/publisher-marker.patch"
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
  assert-native-context)
    [ "$#" -eq 12 ]
    [ "$prefix" = "$2" ]
    [ "${HOMEBREW_CACHE:-}" = "$3" ]
    [ "${HOMEBREW_TEMP:-}" = "$4" ]
    [ "${XDG_CONFIG_HOME:-}" = "$5" ]
    [ "${HOME:-}" = "$6" ]
    [ "$(/usr/bin/id -u)" = "$7" ]
    [ "$(/usr/bin/id -g)" = "$8" ]
    [ -z "${HOMEBREW_KANDELO_BOTTLE_TAG+x}" ]
    [ -z "${KANDELO_HOMEBREW_BOTTLE_TAG+x}" ]
    [ "${HOMEBREW_RELOCATE_BUILD_PREFIX:-}" = 1 ]
    printf 'native write\n' >"$prefix/native-write"
    printf 'native config write\n' >"$5/native-config-write"
    printf 'native home write\n' >"$6/native-home-write"
    case "${12}" in
      visible)
        [ -e "$9" ] && [ -e "${10}" ] && [ -e "${11}" ]
        ;;
      hidden)
        [ ! -e "$9" ] && [ ! -e "${10}" ] && [ ! -e "${11}" ]
        if (: >"$9/native-prefix-write-probe") 2>/dev/null; then exit 1; fi
        if (: >"${10}/native-config-write-probe") 2>/dev/null; then exit 1; fi
        if (: >"${11}/native-home-write-probe") 2>/dev/null; then exit 1; fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  assert-native-isolation-runtime)
    [ "$#" -eq 19 ]
    shift
    native_prefix="$1"; shift
    native_cache="$1"; shift
    native_temp="$1"; shift
    native_config="$1"; shift
    native_home="$1"; shift
    native_base="$1"; shift
    expected_uid="$1"; shift
    expected_gid="$1"; shift
    expected_user="$1"; shift
    target_prefix="$1"; shift
    target_cache="$1"; shift
    target_temp="$1"; shift
    target_config="$1"; shift
    target_home="$1"; shift
    target_work="$1"; shift
    kandelo_root="$1"; shift
    tap_root="$1"; shift
    output_root="$1"

    [ "$prefix" = "$native_prefix" ]
    [ "$(pwd -P)" = "$native_temp" ]
    [ "$HOME" = "$native_home" ]
    [ "$USER" = "$expected_user" ] && [ "$LOGNAME" = "$expected_user" ]
    [ "$TMPDIR" = "$native_temp" ] && [ "$HOMEBREW_TEMP" = "$native_temp" ]
    [ "$HOMEBREW_CACHE" = "$native_cache" ]
    [ "$XDG_CONFIG_HOME" = "$native_config" ]
    [ "$(/usr/bin/id -u)" = "$expected_uid" ]
    [ "$(/usr/bin/id -g)" = "$expected_gid" ]
    [ -n "${PATH:-}" ]
    [ -z "${HOMEBREW_KANDELO_BOTTLE_TAG+x}" ]
    [ -z "${KANDELO_HOMEBREW_BOTTLE_TAG+x}" ]
    [ "${HOMEBREW_RELOCATE_BUILD_PREFIX:-}" = 1 ]
    for target_only in KANDELO_HOMEBREW_ARCH KANDELO_HOMEBREW_KANDELO_ROOT \
      HOMEBREW_KANDELO_ABI HOMEBREW_KANDELO_ARCH HOMEBREW_KANDELO_LLVM_BIN \
      HOMEBREW_KANDELO_NODE HOMEBREW_KANDELO_NODE_RECEIPT_PATH \
      HOMEBREW_KANDELO_ROOT LLVM_BIN PLAYWRIGHT_BROWSERS_PATH WASM_POSIX_LLVM_DIR; do
      [ -z "${!target_only+x}" ] || exit 1
    done
    while IFS='=' read -r env_name _; do
      case "$env_name" in
        HOME|USER|LOGNAME|TMPDIR|XDG_CONFIG_HOME|HOMEBREW_CACHE|HOMEBREW_TEMP|PATH|PWD|OLDPWD|SHLVL|_) ;;
        CI|GITHUB_ACTIONS|RUNNER_OS|LANG|LC_ALL|TZ|SOURCE_DATE_EPOCH) ;;
        HOMEBREW_NO_AUTO_UPDATE|HOMEBREW_NO_INSTALL_CLEANUP|HOMEBREW_NO_ANALYTICS|HOMEBREW_DEVELOPER) ;;
        HOMEBREW_RELOCATE_BUILD_PREFIX) ;;
        NIX_SSL_CERT_FILE|SSL_CERT_FILE) ;;
        *) echo "unexpected native Homebrew environment: $env_name" >&2; exit 1 ;;
      esac
    done < <(env)
    awk '$1 == "NoNewPrivs:" { found = 1; if ($2 != 1) exit 1 } END { if (!found) exit 1 }' \
      /proc/self/status

    [ -x "$native_base" ] && [ ! -r "$native_base" ] && [ ! -w "$native_base" ]
    if ls "$native_base" >/dev/null 2>&1; then exit 1; fi
    if mv "$native_base" "$native_base-replaced" >/dev/null 2>&1; then exit 1; fi
    printf 'native prefix write\n' >"$native_prefix/runtime-write"
    printf 'native cache write\n' >"$native_cache/runtime-write"
    printf 'native temp write\n' >"$native_temp/runtime-write"
    printf 'native config write\n' >"$native_config/runtime-write"
    printf 'native home write\n' >"$native_home/runtime-write"

    [ -r "$target_work/target-work-marker" ]
    target_work_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$target_work")"
    case ",${target_work_options// /}," in *,ro,*) ;; *) exit 1 ;; esac
    if (: >"$target_work/native-write-probe") 2>/dev/null; then exit 1; fi
    for hidden_root in "$target_prefix" "$target_cache" "$target_temp" \
      "$target_config" "$target_home" "$kandelo_root" "$tap_root" "$output_root"; do
      # systemd exposes InaccessiblePaths as mode-000 mount points. The path may
      # still stat successfully, but the Formula must not be able to use it.
      if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then
        exit 1
      fi
      if ls "$hidden_root" >/dev/null 2>&1; then exit 1; fi
      if (: >"$hidden_root/native-write-probe") 2>/dev/null; then exit 1; fi
    done
    ;;
  assert-target-native-boundary)
    [ "$#" -eq 7 ]
    native_prefix="$2"
    native_cache="$3"
    native_temp="$4"
    native_config="$5"
    native_home="$6"
    native_marker="$7"
    [ -z "${HOMEBREW_RELOCATE_BUILD_PREFIX+x}" ]
    [ -r "$native_marker" ]
    native_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$native_prefix")"
    case ",${native_options// /}," in *,ro,*) ;; *) exit 1 ;; esac
    if (: >"$native_prefix/target-write-probe") 2>/dev/null; then exit 1; fi
    for hidden_root in "$native_cache" "$native_temp" "$native_config" "$native_home"; do
      if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then
        exit 1
      fi
      if ls "$hidden_root" >/dev/null 2>&1; then exit 1; fi
      if (: >"$hidden_root/target-write-probe") 2>/dev/null; then exit 1; fi
    done
    ;;
  attempt-target-root-replacement)
    [ "$#" -eq 4 ]
    external_roots=("$2" "$3")
    target_roots=("$prefix/Cellar" "$prefix/opt")
    for replacement_index in 0 1; do
      external_root="${external_roots[$replacement_index]}"
      target_root="${target_roots[$replacement_index]}"
      replacement="$prefix/.kandelo-replacement-$replacement_index"
      [ -d "$target_root" ] && [ ! -L "$target_root" ]
      [ "$(cat "$external_root/sentinel")" = "$4" ]
      if rm -rf "$target_root" >/dev/null 2>&1; then exit 1; fi
      if mv "$target_root" "$target_root-replaced" >/dev/null 2>&1; then exit 1; fi
      if /usr/bin/ln -sfnT "$external_root" "$target_root" >/dev/null 2>&1; then exit 1; fi
      rm -f "$replacement"
      ln -s "$external_root" "$replacement"
      if mv -Tf "$replacement" "$target_root" >/dev/null 2>&1; then exit 1; fi
      rm -f "$replacement"
      printf 'target-root-write\n' >"$target_root/replacement-probe"
      [ "$(cat "$external_root/sentinel")" = "$4" ]
      rm -f "$target_root/replacement-probe"
      [ -d "$target_root" ] && [ ! -L "$target_root" ]
    done
    ;;
  install-native-fixture)
    [ "$#" -eq 2 ]
    mkdir -p "$prefix/Cellar/$2/0.9/bin" "$prefix/Cellar/$2/1.0/bin" \
      "$prefix/opt"
    printf 'unselected native fixture\n' >"$prefix/Cellar/$2/0.9/bin/$2"
    printf '#!/usr/bin/env bash\nprintf "native fixture\\n"\n' \
      >"$prefix/Cellar/$2/1.0/bin/$2"
    chmod 0755 "$prefix/Cellar/$2/1.0/bin/$2"
    printf '{"name":"%s","version":"1.0"}\n' "$2" \
      >"$prefix/Cellar/$2/1.0/INSTALL_RECEIPT.json"
    ln -s "$2" "$prefix/Cellar/$2/1.0/bin/$2-link"
    ln -s "../Cellar/$2/1.0" "$prefix/opt/$2"
    ;;
  create-native-link)
    [ "$#" -eq 3 ]
    ln -s "$2" "$prefix/$3"
    ;;
  create-native-fifo)
    [ "$#" -eq 2 ]
    mkfifo "$prefix/$2"
    ;;
  remove-native-entry)
    [ "$#" -eq 2 ]
    rm -f "$prefix/$2"
    ;;
  create-native-relative-link)
    [ "$#" -eq 4 ]
    ln -s "$3" "$prefix/Cellar/$2/1.0/bin/$4"
    ;;
  assert-native-target-boundary)
    [ "$#" -eq 12 ]
    native_prefix="$2"
    target_rack="$3"
    target_keg="$4"
    target_opt_link="$5"
    expected_opt_target="$6"
    native_runner="$7"
    native_write="$8"
    native_cache="$9"
    native_temp="${10}"
    native_config="${11}"
    native_home="${12}"
    [ -r "$native_write" ]
    [ ! -w "$native_prefix" ]
    if (: >"$native_prefix/target-write-probe") 2>/dev/null; then exit 1; fi
    [ -d "$target_rack" ] && [ ! -L "$target_rack" ]
    [ -d "$target_keg" ] && [ ! -L "$target_keg" ]
    [ "$(cd "$target_keg" && pwd -P)" = "$target_keg" ]
    [ "$(stat -c '%u:%g:%a' "$target_rack")" = "0:0:555" ]
    [ "$(stat -c '%u:%g:%a' "$target_keg")" = "0:0:555" ]
    [ ! -e "$target_rack/0.9" ]
    [ "$(cat "$target_keg/INSTALL_RECEIPT.json")" = \
      '{"name":"cmake","version":"1.0"}' ]
    [ -L "$target_opt_link" ]
    [ "$(readlink "$target_opt_link")" = "$expected_opt_target" ]
    [ "$(cd "$target_opt_link" && pwd -P)" = "$target_keg" ]
    [ "$(stat -c '%u:%g' "$target_opt_link")" = "0:0" ]
    [ "$("$target_opt_link/bin/cmake")" = "native fixture" ]
    [ "$("$target_opt_link/bin/cmake-link")" = "native fixture" ]
    if "$native_runner" --prefix >/dev/null 2>&1; then exit 1; fi
    if (: >"$target_keg/build-user-write") 2>/dev/null; then exit 1; fi
    if chmod u+w "$target_rack" 2>/dev/null; then exit 1; fi
    if rm -rf "$target_rack" 2>/dev/null; then exit 1; fi
    if mv "$target_rack" "$target_rack-replaced" 2>/dev/null; then exit 1; fi
    if ln -snf /tmp/changed "$target_rack" 2>/dev/null; then exit 1; fi
    if rm -f "$target_opt_link" 2>/dev/null; then exit 1; fi
    if ln -snf /tmp/changed "$target_opt_link" 2>/dev/null; then exit 1; fi
    for hidden_root in "$native_cache" "$native_temp" "$native_config" "$native_home"; do
      if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then
        exit 1
      fi
      if ls "$hidden_root" >/dev/null 2>&1; then exit 1; fi
      if (: >"$hidden_root/target-write-probe") 2>/dev/null; then exit 1; fi
    done
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
  assert-immutable-trust)
    trust_file="${XDG_CONFIG_HOME:?}/homebrew/trust.json"
    trust_lock="${trust_file}.lock"
    [ -r "$trust_file" ]
    [ "$(cat "$trust_file")" = "$2" ]
    [ ! -w "$trust_file" ]
    [ "$(stat -c '%u:%a:%h' "$trust_file")" = "0:444:1" ]
    [ "$(stat -c '%u:%g:%a:%h' "$trust_lock")" = "0:0:444:1" ]
    [ "$(stat -c '%u:%g:%a' "$XDG_CONFIG_HOME")" = "0:0:555" ]
    [ "$(stat -c '%u:%g:%a' "$XDG_CONFIG_HOME/homebrew")" = "0:0:555" ]
    [ -r "$trust_lock" ] && [ ! -w "$trust_lock" ]
    [ ! -w "$XDG_CONFIG_HOME" ] && [ ! -w "$XDG_CONFIG_HOME/homebrew" ]
    if (exec 9<>"$trust_lock") 2>/dev/null; then exit 1; fi
    if (printf 'mutated\n' >>"$trust_file") 2>/dev/null; then exit 1; fi
    if (printf 'mutated\n' >>"$trust_lock") 2>/dev/null; then exit 1; fi
    if (: >"$XDG_CONFIG_HOME/homebrew/formula-write") 2>/dev/null; then exit 1; fi
    ;;
  assert-dependency-plan)
    [ "$#" -eq 3 ]
    plan="$2"
    expected="$3"
    [ -f "$plan" ] && [ ! -L "$plan" ] && [ -r "$plan" ] && [ ! -w "$plan" ]
    [ "$(stat -c '%u:%g:%a:%h' "$plan")" = "0:0:444:1" ]
    [ "$(cat "$plan")" = "$expected" ]
    if chmod u+w "$plan" 2>/dev/null; then exit 1; fi
    if rm -f "$plan" 2>/dev/null; then exit 1; fi
    if mv "$plan" "$plan-replaced" 2>/dev/null; then exit 1; fi
    if ln -snf /tmp/changed "$plan" 2>/dev/null; then exit 1; fi
    ;;
  assert-publisher-patch)
    [ "$(cat "$repository/publisher-marker.txt")" = "publisher-patched" ]
    ;;
  install-bundler-gems)
    [ "$*" = "install-bundler-gems --groups=bottle,formula_test" ]
    vendor_root="$repository/Library/Homebrew/vendor/bundle/ruby"
    bindata_root="$vendor_root/4.0.0/gems/bindata-2.5.1/lib/bindata"
    mkdir -p "$bindata_root"
    printf 'bottle\nformula_test\n' >"$vendor_root/.homebrew_gem_groups"
    printf '7\n' >"$vendor_root/4.0.0/.homebrew_vendor_version"
    printf 'seeded gem\n' >"$bindata_root/base.rb"
    printf '#!/bin/sh\nprintf "seeded executable\\n"\n' >"$bindata_root/tool"
    chmod 0777 "$bindata_root" "$bindata_root/tool"
    chmod 0666 "$bindata_root/base.rb"
    ;;
  assert-bundler-seed)
    vendor_root="$repository/Library/Homebrew/vendor/bundle/ruby"
    bindata_root="$vendor_root/4.0.0/gems/bindata-2.5.1/lib/bindata"
    [ "$(cat "$vendor_root/.homebrew_gem_groups")" = $'bottle\nformula_test' ]
    [ "$(cat "$vendor_root/4.0.0/.homebrew_vendor_version")" = "7" ]
    [ ! -w "$vendor_root/.homebrew_gem_groups" ]
    [ ! -w "$vendor_root/4.0.0/.homebrew_vendor_version" ]
    [ "$(stat -c '%a' "$bindata_root")" = "555" ]
    [ "$(stat -c '%a' "$bindata_root/base.rb")" = "444" ]
    [ "$(stat -c '%a' "$bindata_root/tool")" = "555" ]
    [ "$("$bindata_root/tool")" = "seeded executable" ]
    if (: >"$bindata_root/new-file") 2>/dev/null; then exit 1; fi
    if printf 'mutation\n' >>"$bindata_root/base.rb" 2>/dev/null; then exit 1; fi
    if chmod u+w "$bindata_root/base.rb" 2>/dev/null; then exit 1; fi
    if rm -f "$bindata_root/base.rb" 2>/dev/null; then exit 1; fi
    if mv "$bindata_root" "$bindata_root-replaced" 2>/dev/null; then exit 1; fi
    ;;
  trust)
    printf 'mutation\n' >>"${XDG_CONFIG_HOME:?}/homebrew/trust.json"
    ;;
  assert-source-aliases)
    [ "$#" -eq 6 ]
    [ "${HOMEBREW_KANDELO_ROOT:-}" = "$2" ]
    [ "${KANDELO_HOMEBREW_KANDELO_ROOT:-}" = "$2" ]
    [ -r "$2/source-marker" ]
    [ -r "$3/tap-marker" ]
    for hidden_root in "$4" "$5" "$6"; do
      if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then
        exit 1
      fi
      if ls "$hidden_root" >/dev/null 2>&1; then exit 1; fi
      if (: >"$hidden_root/source-write-probe") 2>/dev/null; then exit 1; fi
    done
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
  list)
    [ "$#" -eq 3 ] && [ "$2" = "--formula" ]
    formula="$3"
    rack="$prefix/Cellar/$formula"
    [ -d "$rack" ]
    resolved_rack="$(cd "$rack" && pwd -P)"
    found_keg=0
    for keg in "$resolved_rack"/*; do
      [ -d "$keg" ] && [ ! -L "$keg" ]
      [ "$(cd "$keg/../.." && pwd -P)" = "$(cd "$prefix/Cellar" && pwd -P)" ]
      found_keg=1
    done
    [ "$found_keg" -eq 1 ]
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$prefix/bin/brew"
printf 'unpatched\n' >"$prefix/marker.txt"
printf 'publisher-unpatched\n' >"$prefix/publisher-marker.txt"

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

cat >"$publisher_patch_file" <<'EOF'
diff --git a/publisher-marker.txt b/publisher-marker.txt
index c9bb6f9..8728fa5 100644
--- a/publisher-marker.txt
+++ b/publisher-marker.txt
@@ -1 +1 @@
-publisher-unpatched
+publisher-patched
EOF

homebrew_patched_launcher_prepare \
  "$prefix/bin/brew" "$patch_file" "$work_dir" "$publisher_patch_file"
if homebrew_patched_launcher_seed_bundler_groups 'bad/group' >/dev/null 2>&1; then
  fail "invalid Bundler group unexpectedly succeeded"
fi
homebrew_patched_launcher_seed_bundler_groups bottle formula_test

[ "$HOMEBREW_PATCHED_PREFIX" = "$prefix" ] || fail "selected prefix changed"
[ "$($HOMEBREW_PATCHED_BREW_BIN --prefix)" = "$prefix" ] || fail "launcher reports the wrong prefix"
[ "$($HOMEBREW_PATCHED_BREW_BIN --cellar)" = "$prefix/Cellar" ] || fail "launcher reports the wrong Cellar"
mkdir -p "$prefix/Cellar/zlib/1.3.1" "$prefix/Cellar/bzip2/1.0.8"
[ "$(homebrew_patched_launcher_snapshot_target_cellar_layout)" = \
  $'keg:bzip2/1.0.8\nkeg:zlib/1.3.1\nrack:bzip2\nrack:zlib' ] ||
  fail "launcher did not snapshot the target Cellar deterministically"
rm -rf "$prefix/Cellar/zlib/1.3.1"
ln -s "$prefix/Cellar/bzip2/1.0.8" "$prefix/Cellar/zlib/1.3.1"
if homebrew_patched_launcher_snapshot_target_cellar_layout >/dev/null 2>&1; then
  fail "launcher accepted a same-name symlinked target keg"
fi
rm -rf "$prefix/Cellar"
[ "$($HOMEBREW_PATCHED_BREW_BIN --prefix cmake)" = "$prefix/opt/cmake" ] ||
  fail "launcher moved a core dependency prefix"
[ "$($HOMEBREW_PATCHED_BREW_BIN --repository)" = "$HOMEBREW_PATCHED_OVERLAY" ] ||
  fail "launcher reports the wrong repository"
[ "$(cat "$prefix/marker.txt")" = "unpatched" ] || fail "original repository was modified"
[ "$(cat "$prefix/publisher-marker.txt")" = "publisher-unpatched" ] ||
  fail "publisher patch modified the original repository"
[ "$(cat "$HOMEBREW_PATCHED_OVERLAY/marker.txt")" = "patched" ] || fail "overlay patch was not applied"
[ "$(cat "$HOMEBREW_PATCHED_OVERLAY/publisher-marker.txt")" = "publisher-patched" ] ||
  fail "extra publisher patch was not applied"
[ "$(cat "$HOMEBREW_PATCHED_OVERLAY/Library/Homebrew/vendor/bundle/ruby/.homebrew_gem_groups")" = \
  $'bottle\nformula_test' ] || fail "publisher Bundler groups were not seeded"
[ -L "$HOMEBREW_PATCHED_LAUNCHER" ] || fail "launcher symlink was not created"

local_dependency_plan="$TMPDIR/local-dependency-plan.json"
printf '%s\n' '{"build":[],"build_and_test":[],"formula":"hello","full_name":"kandelo-dev/tap-core/hello","runtime_and_test":[],"schema":2,"tap":"kandelo-dev/tap-core"}' \
  >"$local_dependency_plan"
chmod 0600 "$local_dependency_plan"
real_cp="$(command -v cp)"
failing_cp_bin="$TMPDIR/failing-cp-bin"
mkdir -p "$failing_cp_bin"
cat >"$failing_cp_bin/cp" <<EOF
#!/usr/bin/env bash
"$real_cp" "\$@"
exit 1
EOF
chmod 0755 "$failing_cp_bin/cp"
if PATH="$failing_cp_bin:$PATH" \
  homebrew_patched_launcher_stage_dependency_plan "$local_dependency_plan"; then
  fail "partially staged dependency plan unexpectedly succeeded"
fi
[ -z "$HOMEBREW_PATCHED_DEPENDENCY_PLAN" ] && \
  [ -z "$HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256" ] && \
  [ -z "$HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE" ] ||
  fail "failed dependency plan staging retained launcher state"
[ ! -e "$prefix/.kandelo-publisher-build-dependencies.json" ] ||
  fail "failed dependency plan staging retained a partial control file"
homebrew_patched_launcher_stage_dependency_plan "$local_dependency_plan"
staged_dependency_plan="$HOMEBREW_PATCHED_DEPENDENCY_PLAN"
homebrew_patched_launcher_verify_dependency_plan

launcher="$HOMEBREW_PATCHED_LAUNCHER"
overlay="$HOMEBREW_PATCHED_OVERLAY"
homebrew_patched_launcher_cleanup
[ ! -e "$launcher" ] || fail "launcher symlink was not removed"
[ ! -e "$overlay" ] || fail "overlay worktree was not removed"
[ ! -e "$staged_dependency_plan" ] || fail "publisher dependency plan was not removed"

retry_real_work_dir="$TMPDIR/worktree-removal-retry"
retry_work_dir="$TMPDIR/worktree-removal-retry-alias"
mkdir -p "$retry_real_work_dir"
ln -s "$retry_real_work_dir" "$retry_work_dir"
homebrew_patched_launcher_prepare \
  "$prefix/bin/brew" "$patch_file" "$retry_work_dir" "$publisher_patch_file"
retry_overlay="$HOMEBREW_PATCHED_OVERLAY"
retry_repo="$HOMEBREW_PATCHED_REPO"
[ "$retry_overlay" = "$retry_real_work_dir/homebrew-overlay" ] ||
  fail "prepared Homebrew worktree path was not canonicalized"
real_git="$(command -v git)"
failing_git_bin="$TMPDIR/failing-git-bin"
failure_marker="$TMPDIR/worktree-remove-failed"
mkdir -p "$failing_git_bin"
cat >"$failing_git_bin/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${3:-}" = worktree ] && [ "\${4:-}" = remove ] && \
   [ "\${5:-}" = --force ] && [ ! -e "$failure_marker" ]; then
  rm -rf -- "\$6"
  : >"$failure_marker"
  exit 255
fi
exec "$real_git" "\$@"
EOF
chmod 0755 "$failing_git_bin/git"
if PATH="$failing_git_bin:$PATH" \
   homebrew_patched_launcher_cleanup >/dev/null 2>&1; then
  fail "partial Git worktree removal unexpectedly succeeded"
fi
[ ! -e "$retry_overlay" ] || fail "partial Git worktree removal left its directory"
[ -n "$HOMEBREW_PATCHED_OVERLAY" ] || \
  fail "partial Git worktree removal discarded launcher state"
homebrew_patched_launcher_worktree_registration_status "$retry_repo" "$retry_overlay" ||
  fail "partial Git worktree removal did not retain the registration for retry"
homebrew_patched_launcher_cleanup
if homebrew_patched_launcher_worktree_registration_status \
     "$retry_repo" "$retry_overlay"; then
  fail "retried Git worktree removal left stale administrative state"
fi
[ -z "$HOMEBREW_PATCHED_OVERLAY" ] || \
  fail "successful Git worktree removal retry retained launcher state"

base_only_work_dir="$TMPDIR/base-only-work"
mkdir -p "$base_only_work_dir"
homebrew_patched_launcher_prepare "$prefix/bin/brew" "$patch_file" "$base_only_work_dir"
[ "$(cat "$HOMEBREW_PATCHED_OVERLAY/marker.txt")" = "patched" ] ||
  fail "base-only overlay did not apply the platform patch"
[ "$(cat "$HOMEBREW_PATCHED_OVERLAY/publisher-marker.txt")" = "publisher-unpatched" ] ||
  fail "publisher patch leaked into a base-only overlay"
homebrew_patched_launcher_cleanup

native_lifecycle_work="$TMPDIR/native-lifecycle-work"
NATIVE_TEST_BASE="$(mktemp -d /tmp/k.XXXXXX)"
NATIVE_TEST_BASE="$(cd "$NATIVE_TEST_BASE" && pwd -P)"
native_base="$NATIVE_TEST_BASE"
native_prefix="$native_base/p"
native_cache="$native_base/c"
native_temp="$native_base/t"
native_config="$native_base/g"
native_home="$native_base/h"
target_cache="$TMPDIR/target-cache"
target_temp="$TMPDIR/target-temp"
target_config="$TMPDIR/target-config"
target_home="$TMPDIR/target-home"
mkdir -p "$native_lifecycle_work" "$native_base" "$target_cache" "$target_temp" \
  "$target_config" "$target_home"
chmod 0711 "$native_base"
chmod 0751 "$target_cache"
export HOMEBREW_CACHE="$target_cache"
export HOMEBREW_TEMP="$target_temp"
export XDG_CONFIG_HOME="$target_config"
homebrew_patched_launcher_prepare \
  "$prefix/bin/brew" "$patch_file" "$native_lifecycle_work" "$publisher_patch_file"
target_cache_mode="$(stat -c %a "$target_cache" 2>/dev/null || stat -f %Lp "$target_cache")"
if homebrew_patched_launcher_prepare_native_prefix \
  "$target_cache/nested-native" "$TMPDIR/overlap-cache" "$TMPDIR/overlap-temp" \
  "$TMPDIR/overlap-config" "$TMPDIR/overlap-home" >/dev/null 2>&1; then
  fail "native Homebrew accepted a root nested under target state"
fi
[ "$(stat -c %a "$target_cache" 2>/dev/null || stat -f %Lp "$target_cache")" = \
  "$target_cache_mode" ] || fail "rejected native overlap changed target permissions"
[ ! -e "$target_cache/nested-native" ] && [ ! -e "$TMPDIR/overlap-cache" ] ||
  fail "rejected native overlap created state before validation"
long_native_prefix="$TMPDIR/native-prefix-too-long-for-fixed-prefix-bottles"
long_native_cache="$TMPDIR/long-native-cache"
long_native_temp="$TMPDIR/long-native-temp"
long_native_config="$TMPDIR/long-native-config"
long_native_home="$TMPDIR/long-native-home"
set +e
long_native_error="$(homebrew_patched_launcher_prepare_native_prefix \
  "$long_native_prefix" "$long_native_cache" "$long_native_temp" \
  "$long_native_config" "$long_native_home" 2>&1)"
long_native_status="$?"
set -e
[ "$long_native_status" -eq 2 ] ||
  fail "native Homebrew accepted a prefix too long for bottle relocation"
[[ "$long_native_error" == *"too long for fixed-prefix Linuxbrew bottle relocation"* ]] ||
  fail "long native prefix failure did not identify the relocation boundary"
for rejected_native_root in "$long_native_prefix" "$long_native_cache" \
  "$long_native_temp" "$long_native_config" "$long_native_home"; do
  [ ! -e "$rejected_native_root" ] ||
    fail "long native prefix rejection created state before validation"
done
[ -z "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] ||
  fail "long native prefix rejection changed launcher state"
homebrew_patched_launcher_prepare_native_prefix \
  "$native_prefix" "$native_cache" "$native_temp" "$native_config" "$native_home"
native_base_mode="$(stat -c %a "$native_base" 2>/dev/null || stat -f %Lp "$native_base")"
[ "$native_base_mode" = 711 ] ||
  fail "native Homebrew changed its caller-owned parent mode: $native_base_mode"
for native_root in "$native_prefix" "$native_cache" "$native_temp" "$native_config" \
  "$native_home"; do
  [ "$(stat -c %a "$native_root" 2>/dev/null || stat -f %Lp "$native_root")" = 700 ] ||
    fail "native Homebrew root is not private: $native_root"
done
[ "$HOMEBREW_PATCHED_NATIVE_PREFIX" = "$native_prefix" ] ||
  fail "native Homebrew selected the wrong prefix"
if GITHUB_ACTIONS=true homebrew_patched_launcher_run_native --repository >/dev/null 2>&1; then
  fail "CI accepted unisolated native Homebrew execution"
fi
[ "$(GITHUB_ACTIONS=false homebrew_patched_launcher_run_native --repository)" = \
  "$HOMEBREW_PATCHED_OVERLAY" ] ||
  fail "native Homebrew did not use the reviewed overlay"
HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo \
KANDELO_HOMEBREW_BOTTLE_TAG=wasm32_kandelo \
HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
GITHUB_ACTIONS=false \
  homebrew_patched_launcher_run_native assert-native-context \
    "$native_prefix" "$native_cache" "$native_temp" "$native_config" "$native_home" \
    "$(id -u)" "$(id -g)" "$prefix" "$target_config" "$target_home" visible
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native install-native-fixture cmake
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native install-native-fixture ninja
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native install-native-fixture badlink
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native install-native-fixture abslink
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native create-native-relative-link \
  badlink ../../../cmake/1.0/bin/cmake cross-rack
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native create-native-relative-link \
  abslink /tmp/untrusted-native-tool absolute-escape
[ -d "$native_prefix/Cellar/cmake/1.0" ] || fail "native Formula was not installed"
[ ! -e "$prefix/Cellar/cmake" ] || fail "native Formula polluted the target Cellar"
homebrew_patched_launcher_seal_native_prefix
if GITHUB_ACTIONS=false homebrew_patched_launcher_run_native --prefix >/dev/null 2>&1; then
  fail "sealed native Homebrew unexpectedly accepted another command"
fi

if homebrew_patched_launcher_bridge_native_formula badlink >/dev/null 2>&1; then
  fail "native Formula proxy accepted a relative symlink that changes meaning"
fi
[ ! -e "$prefix/Cellar/badlink" ] && [ ! -L "$prefix/Cellar/badlink" ] && \
  [ ! -e "$prefix/opt/badlink" ] && [ ! -L "$prefix/opt/badlink" ] ||
  fail "rejected native Formula proxy changed target state"
[ "${#HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}" -eq 0 ] ||
  fail "rejected native Formula proxy left lifecycle state"
if homebrew_patched_launcher_bridge_native_formula abslink >/dev/null 2>&1; then
  fail "native Formula proxy accepted an unsafe absolute symlink"
fi
[ ! -e "$prefix/Cellar/abslink" ] && [ ! -L "$prefix/Cellar/abslink" ] && \
  [ ! -e "$prefix/opt/abslink" ] && [ ! -L "$prefix/opt/abslink" ] ||
  fail "rejected absolute native Formula link changed target state"
[ "${#HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}" -eq 0 ] ||
  fail "rejected absolute native Formula link left lifecycle state"

bridge_cp_probe="$TMPDIR/bridge-cp-probe"
mkdir -p "$bridge_cp_probe"
cat >"$bridge_cp_probe/cp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for destination; do :; done
printf 'partial copy\n' >"$destination/partial-copy"
exit 91
EOF
chmod +x "$bridge_cp_probe/cp"
if PATH="$bridge_cp_probe:$PATH" \
   homebrew_patched_launcher_bridge_native_formula ninja >/dev/null 2>&1; then
  fail "native Formula proxy accepted a partial copy"
fi
[ ! -e "$prefix/Cellar/ninja" ] && [ ! -L "$prefix/Cellar/ninja" ] && \
  [ ! -e "$prefix/opt/ninja" ] && [ ! -L "$prefix/opt/ninja" ] ||
  fail "failed native Formula copy left partial target state"
[ "${#HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}" -eq 0 ] ||
  fail "partial copy rollback left stale lifecycle state"

bridge_ln_probe="$TMPDIR/bridge-ln-probe"
mkdir -p "$bridge_ln_probe"
cat >"$bridge_ln_probe/ln" <<'EOF'
#!/usr/bin/env bash
exit 92
EOF
chmod +x "$bridge_ln_probe/ln"
if PATH="$bridge_ln_probe:$PATH" \
   homebrew_patched_launcher_bridge_native_formula ninja >/dev/null 2>&1; then
  fail "native Formula proxy accepted a failed opt link"
fi
[ ! -e "$prefix/Cellar/ninja" ] && [ ! -L "$prefix/Cellar/ninja" ] && \
  [ ! -e "$prefix/opt/ninja" ] && [ ! -L "$prefix/opt/ninja" ] ||
  fail "failed native Formula opt link left a copied target keg"
[ "${#HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}" -eq 0 ] ||
  fail "opt-link rollback left stale lifecycle state"

ln -s "$native_prefix/Cellar/cmake" "$prefix/Cellar/cmake"
ln -s "$native_prefix/opt/cmake" "$prefix/opt/cmake"
if "$HOMEBREW_PATCHED_BREW_BIN" list --formula cmake >/dev/null 2>&1; then
  fail "target Homebrew accepted a rack symlink as a canonical keg"
fi
rm -f "$prefix/Cellar/cmake" "$prefix/opt/cmake"

homebrew_patched_launcher_bridge_native_formula cmake
native_proxy_rack="$prefix/Cellar/cmake"
native_proxy_keg="$native_proxy_rack/1.0"
native_proxy_opt="$prefix/opt/cmake"
[ -d "$native_proxy_rack" ] && [ ! -L "$native_proxy_rack" ] && \
  [ -d "$native_proxy_keg" ] && [ ! -L "$native_proxy_keg" ] ||
  fail "native Formula proxy is not a real target keg"
[ "$(cd "$native_proxy_keg" && pwd -P)" = "$native_proxy_keg" ] ||
  fail "native Formula proxy leaves the target Cellar"
[ ! -e "$native_proxy_rack/0.9" ] ||
  fail "native Formula proxy copied an unselected keg"
[ "$(cat "$native_proxy_keg/INSTALL_RECEIPT.json")" = \
  '{"name":"cmake","version":"1.0"}' ] ||
  fail "native Formula proxy changed its receipt"
[ "$("$native_proxy_opt/bin/cmake")" = "native fixture" ] && \
  [ "$("$native_proxy_opt/bin/cmake-link")" = "native fixture" ] ||
  fail "native Formula proxy did not preserve executable links"
[ "$(readlink "$native_proxy_opt")" = "../Cellar/cmake/1.0" ] && \
  [ "$(cd "$native_proxy_opt" && pwd -P)" = "$native_proxy_keg" ] ||
  fail "native Formula opt link is not canonical"
[ "$(stat -c %a "$native_proxy_rack" 2>/dev/null || stat -f %Lp "$native_proxy_rack")" = 555 ] && \
  [ "$(stat -c %a "$native_proxy_keg" 2>/dev/null || stat -f %Lp "$native_proxy_keg")" = 555 ] ||
  fail "native Formula proxy directories are writable by mode"
[ -z "$($HOMEBREW_PATCHED_BREW_BIN list --formula cmake)" ] ||
  fail "target Homebrew did not recognize the native Formula proxy as a keg"

tampered_opt_target="$TMPDIR/tampered-native-opt"
mkdir -p "$tampered_opt_target"
printf 'external opt untouched\n' >"$tampered_opt_target/sentinel"
rm -f "$native_proxy_opt"
ln -s "$tampered_opt_target" "$native_proxy_opt"
if homebrew_patched_launcher_cleanup >/dev/null 2>&1; then
  fail "cleanup removed or ignored a tampered native opt link"
fi
[ "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[*]}" = cmake ] ||
  fail "failed cleanup forgot the native Formula proxy needed for retry"
[ -d "$HOMEBREW_PATCHED_OVERLAY" ] ||
  fail "failed proxy cleanup discarded launcher state"
[ "$(cat "$tampered_opt_target/sentinel")" = "external opt untouched" ] ||
  fail "cleanup followed a tampered native opt link"
rm -f "$native_proxy_opt"
ln -s ../Cellar/cmake/1.0 "$native_proxy_opt"

tampered_rack_target="$TMPDIR/tampered-native-rack"
saved_proxy_rack="$TMPDIR/saved-native-proxy-rack"
mkdir -p "$tampered_rack_target"
printf 'external rack untouched\n' >"$tampered_rack_target/sentinel"
chmod u+w "$native_proxy_rack"
mv "$native_proxy_rack" "$saved_proxy_rack"
chmod a-w "$saved_proxy_rack"
ln -s "$tampered_rack_target" "$native_proxy_rack"
if homebrew_patched_launcher_cleanup >/dev/null 2>&1; then
  fail "cleanup removed or ignored a replaced native Formula rack"
fi
[ "$(cat "$tampered_rack_target/sentinel")" = "external rack untouched" ] ||
  fail "cleanup followed a replaced native Formula rack"
[ "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[*]}" = cmake ] ||
  fail "failed rack cleanup forgot the native Formula proxy"
rm -f "$native_proxy_rack"
chmod u+w "$saved_proxy_rack"
mv "$saved_proxy_rack" "$native_proxy_rack"
chmod a-w "$native_proxy_rack"

bridge_rm_probe="$TMPDIR/bridge-rm-probe"
bridge_rm_state="$TMPDIR/bridge-rm-state"
mkdir -p "$bridge_rm_probe"
cat >"$bridge_rm_probe/rm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count=0
[ ! -f "${FAKE_RM_STATE:?}" ] || count="$(cat "$FAKE_RM_STATE")"
count=$((count + 1))
printf '%s\n' "$count" >"$FAKE_RM_STATE"
[ "$count" -ne 2 ] || exit 93
exec "${REAL_RM:?}" "$@"
EOF
chmod +x "$bridge_rm_probe/rm"
real_rm="$(command -v rm)"
if PATH="$bridge_rm_probe:$PATH" FAKE_RM_STATE="$bridge_rm_state" \
   REAL_RM="$real_rm" homebrew_patched_launcher_cleanup >/dev/null 2>&1; then
  fail "cleanup accepted a failed native Formula rack removal"
fi
[ ! -e "$native_proxy_opt" ] && [ ! -L "$native_proxy_opt" ] && \
  [ -d "$native_proxy_rack" ] ||
  fail "partial cleanup did not stop between opt and rack removal"
[ "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[*]}" = cmake ] ||
  fail "partial cleanup forgot the remaining native Formula rack"
homebrew_patched_launcher_cleanup
[ ! -e "$native_proxy_rack" ] && [ ! -L "$native_proxy_rack" ] ||
  fail "cleanup left the native Formula proxy rack"
[ ! -e "$native_proxy_opt" ] && [ ! -L "$native_proxy_opt" ] ||
  fail "cleanup left the native Formula opt link"
[ -z "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] &&
  [ "${#HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}" -eq 0 ] ||
  fail "cleanup left native Homebrew lifecycle state"
unset HOMEBREW_CACHE HOMEBREW_TEMP XDG_CONFIG_HOME

failure_work_dir="$TMPDIR/failure-work"
mkdir -p "$failure_work_dir"
set +e
(
  set -e
  trap homebrew_patched_launcher_cleanup EXIT
  export FAKE_BREW_BAD_PREFIX=1
  homebrew_patched_launcher_prepare \
    "$prefix/bin/brew" "$patch_file" "$failure_work_dir" "$publisher_patch_file"
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

cat >"$process_probe_dir/noop" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$process_probe_dir/noop"
teardown_retry_work="$TMPDIR/teardown-retry-work"
mkdir -p "$teardown_retry_work"
homebrew_patched_launcher_prepare \
  "$prefix/bin/brew" "$patch_file" "$teardown_retry_work" "$publisher_patch_file"
teardown_retry_overlay="$HOMEBREW_PATCHED_OVERLAY"
teardown_retry_launcher="$HOMEBREW_PATCHED_LAUNCHER"
HOMEBREW_PATCHED_SUDO_BIN="$process_probe_dir/sudo"
HOMEBREW_PATCHED_SYSTEMCTL_BIN="$process_probe_dir/noop"
HOMEBREW_PATCHED_PGREP_BIN="$process_probe_dir/pgrep"
HOMEBREW_PATCHED_PKILL_BIN="$process_probe_dir/noop"
HOMEBREW_PATCHED_BUILD_USER=fixture-build-user
HOMEBREW_PATCHED_BUILD_UID=1234
HOMEBREW_PATCHED_SYSTEMD_SLICE=fixture.slice
HOMEBREW_PATCHED_TEARDOWN_COMPLETE=0
export FAKE_PGREP_STATUS=2
if homebrew_patched_launcher_cleanup >/dev/null 2>&1; then
  fail "cleanup ignored a failed Formula process inspection"
else
  teardown_cleanup_status="$?"
fi
[ "$teardown_cleanup_status" -eq 2 ] ||
  fail "cleanup changed the Formula teardown failure status"
[ -d "$teardown_retry_overlay" ] && [ -L "$teardown_retry_launcher" ] && \
  [ "$HOMEBREW_PATCHED_BUILD_USER" = fixture-build-user ] ||
  fail "failed Formula teardown discarded launcher state needed for retry"
export FAKE_PGREP_STATUS=1
homebrew_patched_launcher_cleanup
[ ! -e "$teardown_retry_overlay" ] && [ ! -L "$teardown_retry_launcher" ] && \
  [ -z "$HOMEBREW_PATCHED_BUILD_USER" ] ||
  fail "successful Formula teardown retry left launcher state"

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
  ISOLATION_NATIVE_BASE="$(mktemp -d /tmp/k.XXXXXX)"
  ISOLATION_NATIVE_BASE="$(cd "$ISOLATION_NATIVE_BASE" && pwd -P)"
  isolated_native_base="$ISOLATION_NATIVE_BASE"
  isolated_native_prefix="$isolated_native_base/p"
  isolated_native_cache="$isolated_native_base/c"
  isolated_native_temp="$isolated_native_base/t"
  isolated_native_config="$isolated_native_base/g"
  isolated_native_home="$isolated_native_base/h"
  isolated_source_parent="$ISOLATION_ROOT/private-runner-home"
  isolated_kandelo="$isolated_source_parent/kandelo"
  isolated_tap="$isolated_source_parent/tap"
  isolated_output="$isolated_source_parent/output"
  isolated_dependency_plan="$isolated_output/host-dependencies.json"
  isolated_home="/home/$ISOLATION_BUILD_USER"
  daemon_marker="$isolated_work/detached-process-survived"
  daemon_started="$isolated_work/detached-process-started"
  native_daemon_marker="$isolated_native_temp/detached-process-survived"
  native_daemon_started="$isolated_native_temp/detached-process-started"
  external_cellar="$isolated_work/external-cellar"
  external_opt="$isolated_work/external-opt"
  mkdir -p "$isolated_repo/bin" "$isolated_prefix/bin" "$isolated_work" \
    "$isolated_cache" "$isolated_temp" "$isolated_kandelo" "$isolated_tap" \
    "$isolated_output" "$isolated_native_base" "$external_cellar" "$external_opt"
  chmod 0711 "$isolated_native_base"
  printf 'reviewed source\n' >"$isolated_kandelo/source-marker"
  printf 'reviewed tap\n' >"$isolated_tap/tap-marker"
  printf 'target work\n' >"$isolated_work/target-work-marker"
  printf 'external target untouched\n' >"$external_cellar/sentinel"
  printf 'external target untouched\n' >"$external_opt/sentinel"
  dependency_plan_json='{"build":["cmake"],"build_and_test":["cmake","ninja"],"formula":"hello","full_name":"kandelo-dev/tap-core/hello","runtime_and_test":["ninja"],"schema":2,"tap":"kandelo-dev/tap-core"}'
  printf '%s\n' "$dependency_plan_json" >"$isolated_dependency_plan"
  chmod 0600 "$isolated_dependency_plan"
  mkdir "$isolated_kandelo/runner-control"
  chmod 0700 "$isolated_kandelo/runner-control"
  # Keep the parent traversable so only systemd's InaccessiblePaths protects
  # these roots. A mode-000 mountpoint can still exist and stat successfully.
  chmod 0755 "$isolated_source_parent"
  cp "$prefix/bin/brew" "$isolated_repo/bin/brew"
  chmod +x "$isolated_repo/bin/brew"
  printf 'unpatched\n' >"$isolated_repo/marker.txt"
  printf 'publisher-unpatched\n' >"$isolated_repo/publisher-marker.txt"
  git -C "$isolated_repo" init -q
  git -C "$isolated_repo" config user.name "Kandelo Test"
  git -C "$isolated_repo" config user.email "kandelo-test@example.invalid"
  git -C "$isolated_repo" add .
  git -C "$isolated_repo" commit -q -m fixture
  ln -s "$isolated_repo/bin/brew" "$isolated_prefix/bin/brew"

  /usr/bin/sudo -n -- /usr/sbin/useradd --system --user-group --create-home \
    --home-dir "$isolated_home" --shell /usr/sbin/nologin "$ISOLATION_BUILD_USER"
  /usr/bin/sudo -n -- chown -R \
    "$ISOLATION_BUILD_USER:$(id -gn "$ISOLATION_BUILD_USER")" \
    "$external_cellar" "$external_opt"
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
  printf 'reviewed-trust\n' >"$XDG_CONFIG_HOME/homebrew/trust.json"
  : >"$XDG_CONFIG_HOME/homebrew/trust.json.lock"
  chmod 0600 "$XDG_CONFIG_HOME/homebrew/trust.json" \
    "$XDG_CONFIG_HOME/homebrew/trust.json.lock"

  homebrew_patched_launcher_prepare \
    "$isolated_prefix/bin/brew" "$patch_file" "$isolated_work" \
    "$publisher_patch_file"
  homebrew_patched_launcher_seed_bundler_groups bottle formula_test
  isolated_overlay="$HOMEBREW_PATCHED_OVERLAY"
  ln -s marker.txt "$isolated_overlay/internal-source-link"
  HOMEBREW_PATCHED_SUDO_BIN=/usr/bin/sudo
  homebrew_patched_launcher_assert_overlay_symlinks_contained
  ln -s "$isolated_output" "$isolated_overlay/escaping-source-link"
  if homebrew_patched_launcher_assert_overlay_symlinks_contained >/dev/null 2>&1; then
    fail "Homebrew overlay accepted a symlink outside its integrity boundary"
  fi
  rm -f "$isolated_overlay/escaping-source-link"
  outside_link_dir="$isolated_output/reentry-links"
  mkdir -p "$outside_link_dir"
  ln -s "$isolated_overlay/marker.txt" "$outside_link_dir/reentry"
  ln -s "$outside_link_dir/reentry" "$isolated_overlay/reentry-source-link"
  if homebrew_patched_launcher_assert_overlay_symlinks_contained >/dev/null 2>&1; then
    fail "Homebrew overlay accepted a symlink chain that exits and re-enters its integrity boundary"
  fi
  rm -f "$isolated_overlay/reentry-source-link"
  HOMEBREW_PATCHED_SUDO_BIN=""
  homebrew_patched_launcher_prepare_native_prefix \
    "$isolated_native_prefix" "$isolated_native_cache" "$isolated_native_temp" \
    "$isolated_native_config" "$isolated_native_home"
  homebrew_patched_launcher_stage_dependency_plan "$isolated_dependency_plan"
  [ "$(stat -c '%u:%a' "$isolated_native_base")" = "$(id -u):711" ] ||
    fail "workflow-owned native parent changed during preparation"
  for native_root in "$isolated_native_prefix" "$isolated_native_cache" \
    "$isolated_native_temp" "$isolated_native_config" "$isolated_native_home"; do
    [ "$(stat -c '%u:%a' "$native_root")" = "$(id -u):700" ] ||
      fail "prepared native child does not match the production private mode: $native_root"
  done
  printf 'native boundary marker\n' >"$isolated_native_prefix/boundary-marker"
  homebrew_patched_launcher_isolate \
    "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
    "$isolated_output"
  /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    test -x "$isolated_native_base" ||
    fail "build identity cannot traverse the workflow-owned native parent"
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    test -r "$isolated_native_base"; then
    fail "build identity can list the workflow-owned native parent"
  fi
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    test -w "$isolated_native_base"; then
    fail "build identity can write the workflow-owned native parent"
  fi
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    ls "$isolated_native_base" >/dev/null 2>&1; then
    fail "build identity listed the workflow-owned native parent"
  fi
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    mv "$isolated_native_base" "$isolated_native_base-replaced" >/dev/null 2>&1; then
    fail "build identity replaced the workflow-owned native parent"
  fi
  for native_root in "$isolated_native_prefix" "$isolated_native_cache" \
    "$isolated_native_temp" "$isolated_native_config" "$isolated_native_home"; do
    /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
      test -r "$native_root" -a -w "$native_root" -a -x "$native_root" ||
      fail "build identity cannot use a native child root: $native_root"
  done
  "$HOMEBREW_PATCHED_BREW_BIN" assert-identity \
    "$(id -u "$ISOLATION_BUILD_USER")" "$(id -g "$ISOLATION_BUILD_USER")"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-working-directory "$isolated_work"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-immutable-trust reviewed-trust
  "$HOMEBREW_PATCHED_BREW_BIN" assert-dependency-plan \
    "$HOMEBREW_PATCHED_DEPENDENCY_PLAN" "$dependency_plan_json"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-publisher-patch
  "$HOMEBREW_PATCHED_BREW_BIN" assert-bundler-seed
  if "$HOMEBREW_PATCHED_BREW_BIN" trust >/dev/null 2>&1; then
    fail "explicit trust mutation succeeded against the sealed store"
  fi
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
  HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
    "$HOMEBREW_PATCHED_BREW_BIN" assert-target-native-boundary \
    "$isolated_native_prefix" "$isolated_native_cache" "$isolated_native_temp" \
    "$isolated_native_config" "$isolated_native_home" \
    "$isolated_native_prefix/boundary-marker"
  "$HOMEBREW_PATCHED_BREW_BIN" attempt-target-root-replacement \
    "$external_cellar" "$external_opt" "external target untouched"
  [ "$(cat "$external_cellar/sentinel")" = "external target untouched" ] &&
    [ "$(cat "$external_opt/sentinel")" = "external target untouched" ] ||
    fail "target root replacement reached an external sentinel"
  [ -d "$isolated_prefix/Cellar" ] && [ ! -L "$isolated_prefix/Cellar" ] &&
    [ -d "$isolated_prefix/opt" ] && [ ! -L "$isolated_prefix/opt" ] ||
    fail "target Formula replaced a root-owned Homebrew state directory"
  HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo \
  KANDELO_HOMEBREW_BOTTLE_TAG=wasm32_kandelo \
  HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
    homebrew_patched_launcher_run_native assert-native-isolation-runtime \
      "$isolated_native_prefix" "$isolated_native_cache" "$isolated_native_temp" \
      "$isolated_native_config" "$isolated_native_home" "$isolated_native_base" \
      "$(id -u "$ISOLATION_BUILD_USER")" "$(id -g "$ISOLATION_BUILD_USER")" \
      "$ISOLATION_BUILD_USER" "$isolated_prefix" "$isolated_cache" "$isolated_temp" \
      "$XDG_CONFIG_HOME" "$isolated_home" "$isolated_work" "$isolated_kandelo" \
      "$isolated_tap" "$isolated_output"
  homebrew_patched_launcher_run_native spawn-daemon \
    "$native_daemon_marker" "$native_daemon_started"
  /usr/bin/sudo -n -- test -e "$native_daemon_started" ||
    fail "detached native Formula process never started"
  sleep 3
  if /usr/bin/sudo -n -- test -e "$native_daemon_marker"; then
    fail "detached native Formula process survived its transient service"
  fi
  set +e
  /usr/bin/sudo -n -- /usr/bin/pgrep -u "$(id -u "$ISOLATION_BUILD_USER")" \
    >/dev/null 2>&1
  native_pgrep_status="$?"
  set -e
  [ "$native_pgrep_status" -eq 1 ] ||
    fail "native Formula process check did not prove an empty UID"

  homebrew_patched_launcher_run_native create-native-link \
    "$isolated_output" unsafe-link
  if homebrew_patched_launcher_seal_native_prefix >/dev/null 2>&1; then
    fail "native Homebrew accepted an escaping symlink"
  fi
  homebrew_patched_launcher_run_native remove-native-entry unsafe-link
  homebrew_patched_launcher_run_native create-native-fifo unsafe-fifo
  if homebrew_patched_launcher_seal_native_prefix >/dev/null 2>&1; then
    fail "native Homebrew accepted a special filesystem entry"
  fi
  homebrew_patched_launcher_run_native remove-native-entry unsafe-fifo
  homebrew_patched_launcher_run_native install-native-fixture cmake
  homebrew_patched_launcher_run_native install-native-fixture ninja
  homebrew_patched_launcher_seal_native_prefix
  [ "$(stat -c '%u:%g:%a' "$isolated_native_prefix")" = "0:0:555" ] ||
    fail "sealed native prefix ownership or mode is unsafe"
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    /bin/sh -c ': >"$1"' sh "$isolated_native_prefix/build-user-write" \
    >/dev/null 2>&1; then
    fail "build user can write the sealed native prefix"
  fi
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    mv "$isolated_native_prefix" "$isolated_native_prefix-replaced" \
    >/dev/null 2>&1; then
    fail "build user can replace the sealed native prefix"
  fi
  native_runner="$HOMEBREW_PATCHED_NATIVE_RUNNER"
  native_rack="$isolated_native_prefix/Cellar/cmake"
  partial_proxy_rack="$isolated_prefix/Cellar/ninja"
  /usr/bin/sudo -n -- /usr/bin/install -d -o root -g root -m 0700 \
    "$partial_proxy_rack" "$partial_proxy_rack/1.0"
  /usr/bin/sudo -n -- /bin/sh -c 'printf partial >"$1/partial-copy"' \
    sh "$partial_proxy_rack/1.0"
  HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES+=(ninja)
  homebrew_patched_launcher_remove_native_bridges
  [ ! -e "$partial_proxy_rack" ] && [ ! -L "$partial_proxy_rack" ] && \
    [ "${#HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}" -eq 0 ] ||
    fail "isolated rollback left a partial native Formula proxy"
  target_proxy_rack="$isolated_prefix/Cellar/cmake"
  target_proxy_keg="$target_proxy_rack/1.0"
  target_proxy_opt="$isolated_prefix/opt/cmake"
  homebrew_patched_launcher_bridge_native_formula cmake
  "$HOMEBREW_PATCHED_BREW_BIN" assert-native-target-boundary \
    "$isolated_native_prefix" "$target_proxy_rack" "$target_proxy_keg" \
    "$target_proxy_opt" "../Cellar/cmake/1.0" "$native_runner" \
    "$isolated_native_prefix/runtime-write" "$isolated_native_cache" \
    "$isolated_native_temp" "$isolated_native_config" "$isolated_native_home"
  [ -d "$target_proxy_rack" ] && [ ! -L "$target_proxy_rack" ] && \
    [ -d "$target_proxy_keg" ] && [ ! -L "$target_proxy_keg" ] && \
    [ "$(stat -c '%u:%g:%a' "$target_proxy_rack")" = "0:0:555" ] && \
    [ "$(stat -c '%u:%g:%a' "$target_proxy_keg")" = "0:0:555" ] ||
    fail "target execution changed the native Formula proxy keg"
  [ "$(readlink "$target_proxy_opt")" = "../Cellar/cmake/1.0" ] && \
    [ "$(stat -c '%u:%g' "$target_proxy_opt")" = "0:0" ] ||
    fail "target execution changed the native Formula proxy opt link"
  [ -z "$($HOMEBREW_PATCHED_BREW_BIN list --formula cmake)" ] ||
    fail "isolated target Homebrew rejected the native Formula proxy keg"
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
  /usr/bin/sudo -n -- chmod 0755 "$target_proxy_rack"
  if homebrew_patched_launcher_verify_isolation >/dev/null 2>&1; then
    fail "isolation verification accepted a writable native Formula proxy"
  fi
  /usr/bin/sudo -n -- chmod 0555 "$target_proxy_rack"
  /usr/bin/sudo -n -- rm -f "$target_proxy_opt"
  /usr/bin/sudo -n -- ln -s /tmp/changed-native-opt "$target_proxy_opt"
  if homebrew_patched_launcher_verify_isolation >/dev/null 2>&1; then
    fail "isolation verification accepted a changed native Formula opt link"
  fi
  /usr/bin/sudo -n -- rm -f "$target_proxy_opt"
  /usr/bin/sudo -n -- ln -s ../Cellar/cmake/1.0 "$target_proxy_opt"
  homebrew_patched_launcher_verify_isolation
  homebrew_patched_launcher_cleanup
  [ ! -e "$isolated_overlay" ] && \
    [ -z "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" ] ||
    fail "isolated cleanup left the sealed Homebrew overlay"
  [ ! -e "$target_proxy_rack" ] && [ ! -L "$target_proxy_rack" ] ||
    fail "isolated cleanup left the native Formula proxy rack"
  [ ! -e "$target_proxy_opt" ] && [ ! -L "$target_proxy_opt" ] ||
    fail "isolated cleanup left the native Formula proxy opt link"
  [ ! -e "$isolated_prefix/.kandelo-publisher-build-dependencies.json" ] ||
    fail "isolated cleanup left the publisher dependency plan"
  /usr/bin/sudo -n -- /usr/sbin/userdel -r "$ISOLATION_BUILD_USER"
  ! id "$ISOLATION_BUILD_USER" >/dev/null 2>&1 || fail "Formula build identity survived retirement"
  ISOLATION_BUILD_USER=""
  /usr/bin/sudo -n -- rm -rf "$ISOLATION_ROOT"
  ISOLATION_ROOT=""
fi

echo "test-homebrew-patched-launcher.sh: ok"
