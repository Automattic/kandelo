#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
TMPDIR="$(cd "$TMPDIR" && pwd -P)"
. "$REPO_ROOT/scripts/homebrew-patched-launcher.sh"
ISOLATION_BUILD_USER=""
ISOLATION_RECIPE_USER=""
ISOLATION_ROOT=""
NATIVE_TEST_BASE=""
ISOLATION_NATIVE_BASE=""

cleanup() {
  homebrew_patched_launcher_cleanup
  if [ -n "$ISOLATION_RECIPE_USER" ] && id "$ISOLATION_RECIPE_USER" >/dev/null 2>&1; then
    /usr/bin/sudo -n -- /usr/bin/pkill -KILL -u "$(id -u "$ISOLATION_RECIPE_USER")" \
      >/dev/null 2>&1 || true
    /usr/bin/sudo -n -- /usr/sbin/userdel "$ISOLATION_RECIPE_USER" \
      >/dev/null 2>&1 || true
  fi
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

PYTHONDONTWRITEBYTECODE=1 \
  python3 "$REPO_ROOT/scripts/test-homebrew-tap-recipe-runner.py"

assert_real_relocated_xtask_uses_source_alias() {
  if [ "$#" -ne 1 ]; then
    fail "real relocated xtask regression expects one isolated build user"
  fi
  local build_user="$1"
  local build_group host_target release_xtask regression_root protected_root
  local protected_xtask source_alias runner_source runner unit
  build_group="$(id -gn "$build_user")"
  host_target="$(rustc -vV | sed -n 's/^host: //p')"
  release_xtask="$REPO_ROOT/target/$host_target/release/xtask"
  [ -n "$host_target" ] && [ -f "$release_xtask" ] && \
    [ ! -L "$release_xtask" ] && [ -x "$release_xtask" ] ||
    fail "real relocated xtask regression requires the prebuilt host release checker"

  regression_root="$ISOLATION_ROOT/real-relocated-xtask"
  case "$regression_root/" in
    "$ISOLATION_ROOT/"*) ;;
    *) fail "real relocated xtask regression escaped its isolated root" ;;
  esac
  protected_root="$regression_root/protected"
  protected_xtask="$protected_root/xtask"
  source_alias="$regression_root/source/kandelo"
  runner_source="$ISOLATION_ROOT/verify-relocated-xtask-$$-${RANDOM}.source"
  runner="$protected_root/verify-relocated-xtask"
  /usr/bin/sudo -n -- /usr/bin/install -d -o root -g root -m 0555 \
    "$protected_root" "${source_alias%/*}" "$source_alias"
  /usr/bin/sudo -n -- /usr/bin/install -o root -g root -m 0555 -- \
    "$release_xtask" "$protected_xtask"
  /usr/bin/sudo -n -- /usr/bin/cmp -s -- "$release_xtask" "$protected_xtask" ||
    fail "real relocated xtask regression did not stage the exact release bytes"

  cat >"$runner_source" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
original_root="$1"
source_alias="$2"
checker="$3"
host_target="$4"
expected_registry="$source_alias/packages/registry"

# The negative control must reproduce the publisher failure: the checker was
# compiled in original_root, but that checkout is deliberately inaccessible.
if [ -r "$original_root" ] || [ -w "$original_root" ] || \
   [ -x "$original_root" ] || ls "$original_root" >/dev/null 2>&1; then
  echo "real relocated xtask regression can still access the compile checkout" >&2
  exit 1
fi
[ -r "$source_alias/Cargo.toml" ] &&
  [ -r "$expected_registry/program-packages.json" ] ||
  { echo "real relocated xtask regression cannot read the source alias" >&2; exit 1; }
[ "$checker" = "$source_alias/target/$host_target/release/xtask" ]
[ -f "$checker" ] && [ ! -L "$checker" ] && [ -r "$checker" ] &&
  [ -x "$checker" ] && [ ! -w "$checker" ]
[ "$(/usr/bin/realpath -- "$checker")" = "$checker" ]
[ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$checker")" = "0:0:555:1" ]
for read_only_path in "$source_alias" "$checker"; do
  mount_options="$(
    /usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$read_only_path"
  )"
  case ",${mount_options// /}," in
    *,ro,*) ;;
    *)
      echo "real relocated xtask regression found a writable bind: $read_only_path" >&2
      exit 1
      ;;
  esac
done

export WASM_POSIX_DEPS_REGISTRY="$expected_registry"
if negative_output="$(
    "$checker" build-deps program-index-context-check 2>&1
  )"; then
  echo "relocated checker unexpectedly used its inaccessible compile checkout" >&2
  exit 1
fi
# WHY: The package closure can gain an earlier required source input over time.
# Match the inaccessible compile root rather than coupling this regression to
# whichever input the resolver happens to validate first.
case "$negative_output" in
  *"build input \""*"\" not found"*"$original_root/"*) ;;
  *)
    echo "relocated checker negative control failed for the wrong reason:" >&2
    echo "$negative_output" >&2
    exit 1
    ;;
esac

"$checker" build-deps program-index-context-check \
  --source-repo-root "$source_alias"
EOF
  chmod 0555 "$runner_source"
  /usr/bin/sudo -n -- /usr/bin/install -o root -g root -m 0555 -- \
    "$runner_source" "$runner"
  rm -f "$runner_source"

  unit="kandelo-real-relocated-xtask-$$-${RANDOM}.service"
  /usr/bin/sudo -n -- /usr/bin/systemd-run \
    --quiet --wait --collect --pipe \
    --unit="$unit" \
    --uid="$build_user" --gid="$build_group" \
    --property=KillMode=control-group \
    --property=SendSIGKILL=yes \
    --property=TimeoutStopSec=10s \
    --property=NoNewPrivileges=yes \
    "--property=BindReadOnlyPaths=$REPO_ROOT:$source_alias" \
    "--property=BindReadOnlyPaths=$protected_xtask:$source_alias/target/$host_target/release/xtask" \
    "--property=InaccessiblePaths=$REPO_ROOT" \
    --service-type=exec \
    --expand-environment=no \
    --working-directory="$source_alias" \
    -- /usr/bin/env -i \
      "HOME=/home/$build_user" "USER=$build_user" "LOGNAME=$build_user" \
      "PATH=$PATH" \
      "$runner" "$REPO_ROOT" "$source_alias" \
      "$source_alias/target/$host_target/release/xtask" "$host_target"

  /usr/bin/sudo -n -- rm -rf -- "$regression_root"
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
    [ "$#" -eq 21 ]
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
    output_root="$1"; shift
    sysroot_owner="$1"; shift
    dependency_tap_root="$1"

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
      HOMEBREW_KANDELO_GNU_TAR HOMEBREW_KANDELO_NODE HOMEBREW_KANDELO_NODE_RECEIPT_PATH \
      HOMEBREW_KANDELO_PRIMARY_TAP_ROOT HOMEBREW_KANDELO_ROOT \
      HOMEBREW_KANDELO_SYSROOT HOMEBREW_KANDELO_XTASK_BIN LLVM_BIN \
      PLAYWRIGHT_BROWSERS_PATH WASM_POSIX_LLVM_DIR WASM_POSIX_SYSROOT; do
      [ -z "${!target_only+x}" ] || exit 1
    done
    while IFS='=' read -r env_name _; do
      case "$env_name" in
        HOME|USER|LOGNAME|TMPDIR|XDG_CONFIG_HOME|HOMEBREW_CACHE|HOMEBREW_TEMP|PATH|PWD|OLDPWD|SHLVL|_) ;;
        CI|GITHUB_ACTIONS|RUNNER_OS|LANG|LC_ALL|TZ|SOURCE_DATE_EPOCH) ;;
        HOMEBREW_NO_AUTO_UPDATE|HOMEBREW_NO_INSTALL_CLEANUP|HOMEBREW_NO_ANALYTICS|HOMEBREW_DEVELOPER|HOMEBREW_GIT_PATH) ;;
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
      "$target_config" "$target_home" "$kandelo_root" "$tap_root" "$output_root" \
      "$sysroot_owner" "$dependency_tap_root"; do
      # systemd exposes InaccessiblePaths as mode-000 mount points. The path may
      # still stat successfully, but the Formula must not be able to use it.
      if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then
        exit 1
      fi
      if ls "$hidden_root" >/dev/null 2>&1; then exit 1; fi
      if (: >"$hidden_root/native-write-probe") 2>/dev/null; then exit 1; fi
    done
    ;;
  assert-protected-gnu-tar)
    [ "$#" -eq 2 ]
    [ "${HOMEBREW_KANDELO_GNU_TAR:-}" = "$2" ]
    [ -f "$2" ] && [ -x "$2" ] && [ ! -L "$2" ]
    [ ! -w "$2" ] && [ ! -w "${2%/*}" ]
    ;;
  assert-protected-git)
    [ "$#" -eq 2 ]
    [ "${HOMEBREW_GIT_PATH:-}" = "$2" ]
    [ -f "$2" ] && [ -x "$2" ] && [ ! -L "$2" ]
    [ ! -w "$2" ] && [ ! -w "${2%/*}" ]
    [[ "$("$2" --version)" =~ ^git\ version\ ([0-9]+)\.([0-9]+) ]]
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
  assert-target-dependency-sealed)
    [ "$#" -eq 3 ]
    dependency_file="$2"
    dependency_opt="$3"
    [ -r "$dependency_file" ] && [ ! -w "$dependency_file" ]
    [ -L "$dependency_opt" ] && [ ! -w "$(dirname "$dependency_file")" ]
    if printf 'mutated\n' >>"$dependency_file" 2>/dev/null; then exit 1; fi
    if chmod u+w "$dependency_file" 2>/dev/null; then exit 1; fi
    if rm -f "$dependency_file" 2>/dev/null; then exit 1; fi
    if rm -f "$dependency_opt" 2>/dev/null; then exit 1; fi
    if ln -snf /tmp/changed "$dependency_opt" 2>/dev/null; then exit 1; fi
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
    [ "$#" -eq 11 ]
    [ "${HOMEBREW_KANDELO_ROOT:-}" = "$2" ]
    [ "${KANDELO_HOMEBREW_KANDELO_ROOT:-}" = "$2" ]
    [ "${HOMEBREW_KANDELO_SYSROOT:-}" = "$4" ]
    [ "${WASM_POSIX_SYSROOT:-}" = "$4" ]
    [ "${HOMEBREW_KANDELO_XTASK_BIN:-}" = "$5" ]
    [ "${WASM_POSIX_XTASK_BIN:-}" = "$5" ]
    [ -f "$5" ] && [ ! -L "$5" ] && [ -r "$5" ] && [ -x "$5" ] && [ ! -w "$5" ]
    [ "$(/usr/bin/realpath -- "$5")" = "$5" ]
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$5")" = "0:0:555:1" ]
    actual_xtask_sha256="$(/usr/bin/sha256sum "$5")"
    actual_xtask_sha256="${actual_xtask_sha256%% *}"
    [ "$actual_xtask_sha256" = "$6" ]
    [ "$("$5" build-deps program-index-context-check \
      --source-repo-root "$2")" = "checked source projection" ]
    [ -r "$2/source-marker" ]
    [ -r "$3/tap-marker" ]
    [ "$(cat "$4/lib/libc.a")" = "reviewed sysroot" ]
    if printf 'changed\n' >>"$5" 2>/dev/null; then exit 1; fi
    if chmod u+w "$5" 2>/dev/null; then exit 1; fi
    if rm -f "$5" 2>/dev/null; then exit 1; fi
    if mv "$5" "$5-replaced" 2>/dev/null; then exit 1; fi
    if ln -snf /tmp/changed "$5" 2>/dev/null; then exit 1; fi
    for hidden_root in "$7" "$8" "$9" "${10}" "${11}"; do
      if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then
        exit 1
      fi
      if ls "$hidden_root" >/dev/null 2>&1; then exit 1; fi
      if (: >"$hidden_root/source-write-probe") 2>/dev/null; then exit 1; fi
    done
    if ( : >"$2/write-probe" ) 2>/dev/null; then exit 1; fi
    if ( : >"$3/write-probe" ) 2>/dev/null; then exit 1; fi
    if ( : >"$4/write-probe" ) 2>/dev/null; then exit 1; fi
    ;;
  assert-closed-source-aliases)
    [ "$#" -eq 11 ]
    platform_root="$2"
    source_xtask="$3"
    protected_xtask="$4"
    original_kandelo="$5"
    original_tap="$6"
    original_output="$7"
    original_sysroot_owner="$8"
    original_dependency_tap="$9"
    expected_fork_tool="${10}"
    expected_spill_tool="${11}"
    [ -z "${HOMEBREW_KANDELO_XTASK_BIN+x}" ]
    [ -z "${WASM_POSIX_XTASK_BIN+x}" ]
    for checker in "$source_xtask" "$protected_xtask"; do
      [ ! -e "$checker" ] && [ ! -L "$checker" ] &&
        [ ! -r "$checker" ] && [ ! -w "$checker" ] && [ ! -x "$checker" ]
    done
    [ "${HOMEBREW_KANDELO_ROOT:-}" = "$platform_root" ]
    [ "${KANDELO_HOMEBREW_KANDELO_ROOT:-}" = "$platform_root" ]
    [ "${HOMEBREW_KANDELO_FORK_INSTRUMENT:-}" = "$expected_fork_tool" ]
    [ "${HOMEBREW_KANDELO_LOCAL_ROOT_SPILL:-}" = "$expected_spill_tool" ]
    for required in \
      sdk/bin/wasm32posix-cc sdk/src/bin/cc.ts libc/glue/abi_constants.h \
      scripts/run-wasm-fork-instrument.sh tools/bin/wasm-fork-instrument \
      tools/bin/wasm-local-root-spill crates/shared/src/lib.rs; do
      [ -f "$platform_root/$required" ] && [ ! -L "$platform_root/$required" ] &&
        [ -r "$platform_root/$required" ] && [ ! -w "$platform_root/$required" ]
    done
    for forbidden in .git Cargo.toml packages local-binaries target tools/xtask \
      scripts/dev-shell.sh scripts/install-local-binary.sh; do
      [ ! -e "$platform_root/$forbidden" ] && [ ! -L "$platform_root/$forbidden" ]
    done
    for hidden_root in "$original_kandelo" "$original_tap" "$original_output" \
      "$original_sysroot_owner" "$original_dependency_tap"; do
      [ ! -r "$hidden_root" ] && [ ! -w "$hidden_root" ] && [ ! -x "$hidden_root" ]
      if ls "$hidden_root" >/dev/null 2>&1; then exit 1; fi
    done
    ;;
  assert-primary-tap-root)
    [ "$#" -eq 2 ]
    [ "${HOMEBREW_KANDELO_PRIMARY_TAP_ROOT:-}" = "$2" ]
    [ "$(cd "$2" && pwd -P)" = "$2" ]
    [ "$(cat "$2/primary-tap-marker")" = "selected primary tap" ]
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
  assert-protected-input)
    [ "$#" -eq 6 ]
    protected_path="$2"
    expected_basename="$3"
    shared_temp="$4"
    expected_uid="$5"
    expected_content="$6"
    protected_dir="${protected_path%/*}"
    [ "$(/usr/bin/id -u)" = "$expected_uid" ]
    [ "${protected_path##*/}" = "$expected_basename" ]
    case "$protected_dir" in
      "$shared_temp"/homebrew-bottle-input.??????) ;;
      *) exit 1 ;;
    esac
    [ "$(/usr/bin/stat -c '%u:%g:%a' "$protected_dir")" = "0:0:555" ]
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$protected_path")" = "0:0:444:1" ]
    [ -r "$protected_path" ] && [ ! -w "$protected_path" ] && [ ! -w "$protected_dir" ]
    [ "$(<"$protected_path")" = "$expected_content" ]
    if printf 'changed\n' >>"$protected_path" 2>/dev/null; then exit 1; fi
    if rm -f "$protected_path" 2>/dev/null; then exit 1; fi
    if mv "$protected_path" "$protected_path-replaced" 2>/dev/null; then exit 1; fi
    if (: >"$protected_dir/new-input") 2>/dev/null; then exit 1; fi
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
local_tier2_attestation="$TMPDIR/local-tier2-attestation.json"
printf '%s\n' '{"build":[],"build_and_test":[],"formula":"hello","full_name":"kandelo-dev/tap-core/hello","runtime_and_test":[],"schema":2,"tap":"kandelo-dev/tap-core"}' \
  >"$local_dependency_plan"
chmod 0600 "$local_dependency_plan"
active_tier2_attestation_json='{"arch":"wasm32","formula":"hello","formula_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","full_name":"kandelo-dev/tap-core/hello","schema":2,"support_runtime_sha256":"1111111111111111111111111111111111111111111111111111111111111111","support_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tap":"kandelo-dev/tap-core","tier2_bridge":{"build_toml_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","package":"hello","package_toml_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","script":"build-hello.sh","script_env_keys":[],"script_sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","source_mode":"exact","source_sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","source_url":"https://example.test/hello-1.0.tar.gz","version":"1.0"}}'
printf '%s\n' "$active_tier2_attestation_json" \
  >"$local_tier2_attestation"
chmod 0600 "$local_tier2_attestation"
[ "$(homebrew_patched_launcher_tier2_schema "$local_tier2_attestation")" = "2" ] ||
  fail "Tier-2 schema reader did not identify a registry bridge"
tap_recipe_attestation="$TMPDIR/tap-recipe-attestation.json"
printf '%s\n' \
  '{"schema":3,"arch":"wasm32","tap_recipe":{"entrypoint":"build.sh"},"tier2_bridge":null}' \
  >"$tap_recipe_attestation"
[ "$(homebrew_patched_launcher_tier2_schema "$tap_recipe_attestation")" = "3" ] ||
  fail "Tier-2 schema reader did not identify a tap recipe"
printf '%s\n%s\n' '{"schema":3,"tap_recipe":{}}' '{"unexpected":true}' \
  >"$tap_recipe_attestation"
if homebrew_patched_launcher_tier2_schema "$tap_recipe_attestation" >/dev/null 2>&1; then
  fail "Tier-2 schema reader accepted a multiline control document"
fi
printf '%s\n' '{"schema":1}' >"$tap_recipe_attestation"
if homebrew_patched_launcher_tier2_schema "$tap_recipe_attestation" >/dev/null 2>&1; then
  fail "Tier-2 schema reader accepted a retired control schema"
fi
xtask_audit_source="$(declare -f homebrew_patched_launcher_emit_xtask_access_audit)"
isolate_source="$(declare -f homebrew_patched_launcher_isolate)"
projection_source="$(declare -f homebrew_patched_launcher_prepare_platform_projection)"
projection_manifest_source="$(
  declare -f homebrew_patched_launcher_platform_projection_manifest
)"
sealed_directory_source="$(
  declare -f homebrew_patched_launcher_sealed_directory_state
)"
recipe_verifier_source="$(
  declare -f homebrew_patched_launcher_verify_recipe_runner
)"
grep -Fq 'expected_protected_xtask=%q' <<<"$xtask_audit_source" &&
  grep -Fq '[ -n "${WASM_POSIX_XTASK_BIN+x}" ]' <<<"$xtask_audit_source" &&
  grep -Fq '[ -n "${HOMEBREW_KANDELO_XTASK_BIN+x}" ]' <<<"$xtask_audit_source" &&
  grep -Fq '[ -e "$expected_protected_xtask" ]' <<<"$xtask_audit_source" &&
  grep -Fq 'tap_recipe_inaccessible_paths=("-$xtask_alias" "$protected_xtask")' \
    <<<"$isolate_source" &&
  grep -Fq 'tools/bin/wasm-fork-instrument' <<<"$projection_source" &&
  grep -Fq 'tools/bin/wasm-local-root-spill' <<<"$projection_source" ||
  fail "schema-3 isolation does not remove both resolver paths from a minimal platform projection"
grep -Fq "stat -c '%u:%g:%a'" <<<"$sealed_directory_source" &&
  ! grep -Fq '%h' <<<"$sealed_directory_source" &&
  grep -Fq 'sealed_directory_state "$root"' <<<"$projection_manifest_source" &&
  grep -Fq 'sealed_directory_state "$entry"' <<<"$projection_manifest_source" &&
  grep -Fq 'homebrew_patched_launcher_sealed_directory_state' \
    <<<"$recipe_verifier_source" &&
  grep -Fq '"$HOMEBREW_PATCHED_RECIPE_SEALED_ROOT"' \
    <<<"$recipe_verifier_source" ||
  fail "schema-3 isolation treats filesystem-specific directory link counts as security state"

if [ "$(uname -s)" = "Linux" ]; then
  xtask_audit_root="$TMPDIR/xtask-audit"
  schema2_xtask="$xtask_audit_root/schema2/xtask"
  schema2_protected="$xtask_audit_root/schema2/protected-xtask"
  schema3_xtask="$xtask_audit_root/schema3/xtask"
  schema3_protected="$xtask_audit_root/schema3/protected-xtask"
  readonly_findmnt="$xtask_audit_root/findmnt-ro"
  writable_findmnt="$xtask_audit_root/findmnt-rw"
  mkdir -p "${schema2_xtask%/*}" "${schema3_xtask%/*}"
  printf '#!/bin/sh\nexit 0\n' >"$schema2_xtask"
  chmod 0555 "$schema2_xtask"
  cat >"$readonly_findmnt" <<'EOF'
#!/bin/sh
printf 'ro\n'
EOF
  cat >"$writable_findmnt" <<'EOF'
#!/bin/sh
printf 'rw\n'
EOF
  chmod 0555 "$readonly_findmnt" "$writable_findmnt"
  schema2_state="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$schema2_xtask")"
  schema2_sha="$(/usr/bin/sha256sum "$schema2_xtask")"
  schema2_sha="${schema2_sha%% *}"

  emit_xtask_audit_fixture() {
    local schema="$1" xtask="$2" protected="$3" findmnt="$4" output="$5"
    {
      printf '#!/usr/bin/env bash\nset -euo pipefail\n'
      homebrew_patched_launcher_emit_xtask_access_audit \
        "$schema" "$xtask" "$protected" "$schema2_state" "$schema2_sha" \
        "$findmnt"
    } >"$output"
    chmod 0555 "$output"
  }

  expect_xtask_audit_failure() {
    local label="$1"
    shift
    if "$@" >/dev/null 2>&1; then
      fail "generated xtask audit accepted $label"
    fi
  }

  schema2_audit="$xtask_audit_root/schema2-audit"
  emit_xtask_audit_fixture \
    0 "$schema2_xtask" "$schema2_protected" "$readonly_findmnt" \
    "$schema2_audit"
  env -i \
    "HOMEBREW_KANDELO_XTASK_BIN=$schema2_xtask" \
    "WASM_POSIX_XTASK_BIN=$schema2_xtask" \
    /usr/bin/bash "$schema2_audit"
  expect_xtask_audit_failure "schema-2 without both checker aliases" \
    env -i "WASM_POSIX_XTASK_BIN=$schema2_xtask" \
    /usr/bin/bash "$schema2_audit"

  schema2_writable_audit="$xtask_audit_root/schema2-writable-audit"
  emit_xtask_audit_fixture \
    0 "$schema2_xtask" "$schema2_protected" "$writable_findmnt" \
    "$schema2_writable_audit"
  expect_xtask_audit_failure "schema-2 checker on a writable mount" \
    env -i \
    "HOMEBREW_KANDELO_XTASK_BIN=$schema2_xtask" \
    "WASM_POSIX_XTASK_BIN=$schema2_xtask" \
    /usr/bin/bash "$schema2_writable_audit"
  chmod 0755 "$schema2_xtask"
  printf 'changed\n' >>"$schema2_xtask"
  chmod 0555 "$schema2_xtask"
  expect_xtask_audit_failure "mutated schema-2 checker bytes" \
    env -i \
    "HOMEBREW_KANDELO_XTASK_BIN=$schema2_xtask" \
    "WASM_POSIX_XTASK_BIN=$schema2_xtask" \
    /usr/bin/bash "$schema2_audit"

  schema3_audit="$xtask_audit_root/schema3-audit"
  emit_xtask_audit_fixture \
    1 "$schema3_xtask" "$schema3_protected" "$readonly_findmnt" \
    "$schema3_audit"
  env -i /usr/bin/bash "$schema3_audit"
  expect_xtask_audit_failure "schema-3 checker environment authority" \
    env -i "HOMEBREW_KANDELO_XTASK_BIN=$schema3_xtask" \
    /usr/bin/bash "$schema3_audit"
  printf '#!/bin/sh\nexit 0\n' >"$schema3_xtask"
  chmod 0555 "$schema3_xtask"
  expect_xtask_audit_failure "schema-3 source-alias checker authority" \
    env -i /usr/bin/bash "$schema3_audit"
  rm "$schema3_xtask"
  printf '#!/bin/sh\nexit 0\n' >"$schema3_protected"
  chmod 0555 "$schema3_protected"
  expect_xtask_audit_failure "schema-3 root-staged checker authority" \
    env -i /usr/bin/bash "$schema3_audit"
fi

expect_tier2_staging_rejection() {
  local source="$1" label="$2"
  if homebrew_patched_launcher_stage_tier2_attestation "$source" \
    >/dev/null 2>&1; then
    fail "unsafe $label Tier-2 attestation unexpectedly staged"
  fi
  [ -z "$HOMEBREW_PATCHED_TIER2_ATTESTATION" ] &&
    [ -z "${HOMEBREW_PATCHED_CONTROL_FILE_PATH[tier2_attestation]:-}" ] &&
    [ ! -e "$prefix/.kandelo-publisher-tier2-attestation.json" ] ||
    fail "rejected $label Tier-2 attestation retained control-file state"
}

unsafe_tier2_source="$TMPDIR/unsafe-tier2-source.json"
printf '%s\n' "$active_tier2_attestation_json" >"$unsafe_tier2_source"
chmod 0644 "$unsafe_tier2_source"
expect_tier2_staging_rejection "$unsafe_tier2_source" "non-private"
chmod 0600 "$unsafe_tier2_source"
unsafe_tier2_hardlink="$TMPDIR/unsafe-tier2-hardlink.json"
ln "$unsafe_tier2_source" "$unsafe_tier2_hardlink"
expect_tier2_staging_rejection "$unsafe_tier2_source" "hard-linked"
rm "$unsafe_tier2_hardlink"
unsafe_tier2_symlink="$TMPDIR/unsafe-tier2-symlink.json"
ln -s "$unsafe_tier2_source" "$unsafe_tier2_symlink"
expect_tier2_staging_rejection "$unsafe_tier2_symlink" "symlinked"
unsafe_tier2_empty="$TMPDIR/unsafe-tier2-empty.json"
: >"$unsafe_tier2_empty"
chmod 0600 "$unsafe_tier2_empty"
expect_tier2_staging_rejection "$unsafe_tier2_empty" "empty"
unsafe_tier2_oversize="$TMPDIR/unsafe-tier2-oversize.json"
dd if=/dev/zero of="$unsafe_tier2_oversize" bs=16385 count=1 2>/dev/null
chmod 0600 "$unsafe_tier2_oversize"
expect_tier2_staging_rejection "$unsafe_tier2_oversize" "oversized"
if [ "$(id -u)" -ne 0 ] && [ -x /usr/bin/sudo ] &&
   /usr/bin/sudo -n true >/dev/null 2>&1; then
  unsafe_tier2_owner="$TMPDIR/unsafe-tier2-owner.json"
  /usr/bin/sudo -n install -o root -g 0 -m 0600 \
    "$local_tier2_attestation" "$unsafe_tier2_owner"
  expect_tier2_staging_rejection "$unsafe_tier2_owner" "foreign-owned"
  /usr/bin/sudo -n rm -f "$unsafe_tier2_owner"
fi
printf '%s\n' occupied >"$prefix/.kandelo-publisher-tier2-attestation.json"
if homebrew_patched_launcher_stage_tier2_attestation "$local_tier2_attestation" \
  >/dev/null 2>&1; then
  fail "Tier-2 attestation staged over an occupied destination"
fi
[ -z "${HOMEBREW_PATCHED_CONTROL_FILE_PATH[tier2_attestation]:-}" ] ||
  fail "occupied Tier-2 destination retained launcher state"
rm "$prefix/.kandelo-publisher-tier2-attestation.json"

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
homebrew_patched_launcher_stage_tier2_attestation "$local_tier2_attestation"
staged_tier2_attestation="$HOMEBREW_PATCHED_TIER2_ATTESTATION"
homebrew_patched_launcher_verify_tier2_attestation
if homebrew_patched_launcher_stage_tier2_attestation "$local_tier2_attestation" \
  >/dev/null 2>&1; then
  fail "duplicate Tier-2 attestation staging unexpectedly succeeded"
fi
[ "$HOMEBREW_PATCHED_TIER2_ATTESTATION" = "$staged_tier2_attestation" ] ||
  fail "duplicate Tier-2 staging changed the protected destination"

launcher="$HOMEBREW_PATCHED_LAUNCHER"
overlay="$HOMEBREW_PATCHED_OVERLAY"
homebrew_patched_launcher_cleanup
[ ! -e "$launcher" ] || fail "launcher symlink was not removed"
[ ! -e "$overlay" ] || fail "overlay worktree was not removed"
[ ! -e "$staged_dependency_plan" ] || fail "publisher dependency plan was not removed"
[ ! -e "$staged_tier2_attestation" ] || fail "publisher Tier-2 attestation was not removed"

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
native_prefix="$(homebrew_patched_launcher_native_prefix_path "$native_base")"
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
[[ "$long_native_error" == *"must exactly match fixed-prefix Linuxbrew bottle path lengths"* ]] ||
  fail "long native prefix failure did not identify the exact relocation boundary"
for rejected_native_root in "$long_native_prefix" "$long_native_cache" \
  "$long_native_temp" "$long_native_config" "$long_native_home"; do
  [ ! -e "$rejected_native_root" ] ||
    fail "long native prefix rejection created state before validation"
done
[ -z "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] ||
  fail "long native prefix rejection changed launcher state"
short_native_prefix="$native_base/q"
set +e
short_native_error="$(homebrew_patched_launcher_prepare_native_prefix \
  "$short_native_prefix" "$TMPDIR/short-native-cache" \
  "$TMPDIR/short-native-temp" "$TMPDIR/short-native-config" \
  "$TMPDIR/short-native-home" 2>&1)"
short_native_status="$?"
set -e
[ "$short_native_status" -eq 2 ] ||
  fail "native Homebrew accepted a prefix shorter than the bottle build prefix"
[[ "$short_native_error" == *"must exactly match fixed-prefix Linuxbrew bottle path lengths"* ]] ||
  fail "short native prefix failure did not identify the exact relocation boundary"
[ ! -e "$short_native_prefix" ] ||
  fail "short native prefix rejection created state before validation"
[ -z "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] ||
  fail "short native prefix rejection changed launcher state"
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
  cmake cmake-cross-final cmake-cross
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native create-native-relative-link \
  cmake ../../../ninja/1.0/bin/ninja cmake-cross-final
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native create-native-relative-link \
  badlink ../../../../../../untrusted-native-tool relative-escape
GITHUB_ACTIONS=false homebrew_patched_launcher_run_native create-native-relative-link \
  abslink /tmp/untrusted-native-tool absolute-escape
[ -d "$native_prefix/Cellar/cmake/1.0" ] || fail "native Formula was not installed"
[ ! -e "$prefix/Cellar/cmake" ] || fail "native Formula polluted the target Cellar"
homebrew_patched_launcher_seal_native_prefix
if GITHUB_ACTIONS=false homebrew_patched_launcher_run_native --prefix >/dev/null 2>&1; then
  fail "sealed native Homebrew unexpectedly accepted another command"
fi

if homebrew_patched_launcher_bridge_native_formula badlink >/dev/null 2>&1; then
  fail "native Formula proxy accepted a relative symlink outside the native prefix"
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
[ -L "$native_proxy_opt/bin/cmake-cross" ] && \
  [ -L "$native_proxy_opt/bin/cmake-cross-final" ] && \
  [ "$(readlink "$native_proxy_opt/bin/cmake-cross")" = \
    "$native_prefix/Cellar/ninja/1.0/bin/ninja" ] && \
  [ "$(readlink "$native_proxy_opt/bin/cmake-cross-final")" = \
    "$native_prefix/Cellar/ninja/1.0/bin/ninja" ] && \
  [ "$("$native_proxy_opt/bin/cmake-cross")" = "native fixture" ] ||
  fail "native Formula proxy did not preserve links into its sealed native closure"
[ ! -e "$prefix/Cellar/ninja" ] && [ ! -L "$prefix/Cellar/ninja" ] && \
  [ ! -e "$prefix/opt/ninja" ] && [ ! -L "$prefix/opt/ninja" ] ||
  fail "native Formula proxy exposed a transitive native dependency in the target prefix"
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
command="$1"
shift
if [ "$command" = /usr/bin/rm ] && [ ! -x "$command" ]; then
  command="$(command -v rm)"
fi
exec "$command" "$@"
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

sysroot_audit_script="$TMPDIR/sysroot-access-audit.sh"
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  homebrew_patched_launcher_emit_sysroot_access_audit
} >"$sysroot_audit_script"
bash -n "$sysroot_audit_script" ||
  fail "generated protected sysroot audit is not valid Bash"

staged_retry_shared="$TMPDIR/staged-input-retry"
staged_retry_dir="$staged_retry_shared/homebrew-bottle-input.ABCDEF"
staged_retry_path="$staged_retry_dir/fixture.bottle.tar.gz"
mkdir -p "$staged_retry_dir"
printf 'protected retry fixture\n' >"$staged_retry_path"
HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP="$staged_retry_shared"
HOMEBREW_PATCHED_STAGED_INPUT_DIR="$staged_retry_dir"
HOMEBREW_PATCHED_STAGED_INPUT_PATH="$staged_retry_path"
HOMEBREW_PATCHED_SUDO_BIN="$audit_probe_dir/sudo"
if homebrew_patched_launcher_remove_staged_input >/dev/null 2>&1; then
  fail "protected input cleanup ignored a privileged removal failure"
fi
[ -f "$staged_retry_path" ] && \
  [ "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" = "$staged_retry_shared" ] && \
  [ "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" = "$staged_retry_dir" ] && \
  [ "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" = "$staged_retry_path" ] ||
  fail "failed protected input cleanup discarded retry state"
HOMEBREW_PATCHED_SUDO_BIN="$process_probe_dir/sudo"
homebrew_patched_launcher_remove_staged_input
[ ! -e "$staged_retry_dir" ] && \
  [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] && \
  [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] && \
  [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ] ||
  fail "protected input cleanup retry left staged state"
HOMEBREW_PATCHED_SUDO_BIN=""

for supported_git_version in \
  "git version 2.7.0" "git version 2.51.2" "git version 3.0.0"; do
  homebrew_patched_launcher_git_version_is_supported "$supported_git_version" ||
    fail "protected Git version parser rejected $supported_git_version"
done
for unsupported_git_version in \
  "git version 2.6.9" "git version 1.99.0" "git version unknown"; do
  if homebrew_patched_launcher_git_version_is_supported "$unsupported_git_version"; then
    fail "protected Git version parser accepted $unsupported_git_version"
  fi
done
untrusted_git_dir="$TMPDIR/untrusted-git/bin"
mkdir -p "$untrusted_git_dir"
cat >"$untrusted_git_dir/git" <<'EOF'
#!/usr/bin/env bash
printf 'git version 99.0.0\n'
EOF
chmod +x "$untrusted_git_dir/git"
if PATH="$untrusted_git_dir:$PATH" \
    homebrew_patched_launcher_select_host_git >/dev/null 2>&1; then
  fail "host Git selection accepted an executable outside the Nix store"
fi
caller_git_poison="$TMPDIR/caller-selected-git"
HOMEBREW_GIT_PATH="$caller_git_poison"
export HOMEBREW_GIT_PATH
homebrew_patched_launcher_select_host_git
[ "$HOMEBREW_GIT_PATH" != "$caller_git_poison" ] &&
  [[ "$HOMEBREW_GIT_PATH" =~ ^/nix/store/[0-9a-z]{32}-git-[^/]+/bin/git$ ]] &&
  [ -f "$HOMEBREW_GIT_PATH" ] && [ -x "$HOMEBREW_GIT_PATH" ] &&
  [ ! -L "$HOMEBREW_GIT_PATH" ] && [ ! -w "$HOMEBREW_GIT_PATH" ] ||
  fail "host Git selection did not replace caller state with protected Nix Git"

if [ "$(uname -s)" = "Linux" ] && [ -x /usr/bin/sudo ] && \
   [ -x /usr/bin/systemd-run ] && [ -x /usr/bin/systemctl ] && \
   [ -x /usr/bin/getent ] && [ -x /usr/bin/pgrep ] && [ -x /usr/bin/pkill ] && \
   [ -x /usr/bin/setsid ] && \
   [ -d /run/systemd/system ] && /usr/bin/sudo -n true >/dev/null 2>&1; then
  ISOLATION_BUILD_USER="kandelo-hb-$$-${RANDOM}"
  ISOLATION_BUILD_USER="${ISOLATION_BUILD_USER:0:31}"
  ISOLATION_ROOT="$(mktemp -d /tmp/kandelo-launcher-test.XXXXXX)"
  /usr/bin/sudo -n -- chmod 1777 "$ISOLATION_ROOT"
  platform_fixture="$ISOLATION_ROOT/platform-fixture"
  platform_projection="$ISOLATION_ROOT/platform-projection"
  mkdir -p \
    "$platform_fixture/sdk/bin" "$platform_fixture/sdk/src/bin" \
    "$platform_fixture/sdk/src/lib" "$platform_fixture/libc/glue" \
    "$platform_fixture/scripts" "$platform_fixture/tools/bin" \
    "$platform_fixture/crates/shared/src" \
    "$platform_fixture/.git" "$platform_fixture/packages/registry"
  for platform_file in \
    sdk/activate.sh sdk/bin/wasm32posix-cc sdk/bin/wasm64posix-cc \
    sdk/src/bin/cc.ts sdk/src/lib/toolchain.ts sdk/config.site \
    sdk/package.json libc/glue/abi_constants.h \
    scripts/run-wasm-fork-instrument.sh \
    scripts/run-wasm-local-root-spill.sh scripts/wasm-artifact-guards.sh \
    tools/bin/wasm-fork-instrument tools/bin/wasm-local-root-spill \
    crates/shared/src/lib.rs; do
    printf 'platform fixture: %s\n' "$platform_file" \
      >"$platform_fixture/$platform_file"
  done
  chmod 0755 \
    "$platform_fixture/sdk/activate.sh" \
    "$platform_fixture/sdk/bin/wasm32posix-cc" \
    "$platform_fixture/sdk/bin/wasm64posix-cc" \
    "$platform_fixture/scripts/run-wasm-fork-instrument.sh" \
    "$platform_fixture/scripts/run-wasm-local-root-spill.sh" \
    "$platform_fixture/scripts/wasm-artifact-guards.sh" \
    "$platform_fixture/tools/bin/wasm-fork-instrument" \
    "$platform_fixture/tools/bin/wasm-local-root-spill"
  printf 'must stay hidden\n' >"$platform_fixture/.git/config"
  printf 'must stay hidden\n' >"$platform_fixture/packages/registry/package.toml"
  homebrew_patched_launcher_prepare_platform_projection \
    "$platform_fixture" "$platform_projection" /usr/bin/sudo
  homebrew_patched_launcher_verify_platform_projection
  [ ! -e "$platform_projection/.git" ] &&
    [ ! -e "$platform_projection/packages" ] &&
    [ -x "$platform_projection/tools/bin/wasm-fork-instrument" ] &&
    [ ! -w "$platform_projection/crates/shared/src/lib.rs" ] ||
    fail "minimal platform projection exposed undeclared source or unsafe modes"
  while IFS= read -r -d '' projected_directory; do
    [ "$(/usr/bin/stat -c '%u:%g:%a' "$projected_directory")" = "0:0:555" ] ||
      fail "platform projection left an unsealed ancestor: $projected_directory"
  done < <(/usr/bin/find "$platform_projection" -type d -print0)
  projected_directory="$platform_projection/crates/shared/src"
  /usr/bin/sudo -n -- chmod 0755 "$projected_directory"
  if homebrew_patched_launcher_verify_platform_projection >/dev/null 2>&1; then
    fail "platform projection verification accepted a writable directory"
  fi
  /usr/bin/sudo -n -- chmod 0555 "$projected_directory"
  homebrew_patched_launcher_verify_platform_projection
  projected_file="$platform_projection/crates/shared/src/lib.rs"
  projected_file_alias="$ISOLATION_ROOT/platform-file-hardlink"
  /usr/bin/sudo -n -- /usr/bin/ln "$projected_file" "$projected_file_alias"
  if homebrew_patched_launcher_verify_platform_projection >/dev/null 2>&1; then
    fail "platform projection verification accepted a hard-linked file"
  fi
  /usr/bin/sudo -n -- /usr/bin/unlink "$projected_file_alias"
  homebrew_patched_launcher_verify_platform_projection
  /usr/bin/sudo -n -- chmod 0644 \
    "$projected_file"
  if homebrew_patched_launcher_verify_platform_projection >/dev/null 2>&1; then
    fail "platform projection verification accepted a mutable projected file"
  fi
  /usr/bin/sudo -n -- rm -rf "$platform_projection"
  HOMEBREW_PATCHED_PLATFORM_ROOT=""
  HOMEBREW_PATCHED_PLATFORM_SHA256=""
  isolated_repo="$ISOLATION_ROOT/repo"
  isolated_prefix="$ISOLATION_ROOT/prefix"
  isolated_work="$ISOLATION_ROOT/work"
  isolated_cache="$ISOLATION_ROOT/cache"
  isolated_temp="$ISOLATION_ROOT/temp"
  ISOLATION_NATIVE_BASE="$(mktemp -d /tmp/k.XXXXXX)"
  ISOLATION_NATIVE_BASE="$(cd "$ISOLATION_NATIVE_BASE" && pwd -P)"
  isolated_native_base="$ISOLATION_NATIVE_BASE"
  isolated_native_prefix="$(
    homebrew_patched_launcher_native_prefix_path "$isolated_native_base"
  )"
  isolated_native_cache="$isolated_native_base/c"
  isolated_native_temp="$isolated_native_base/t"
  isolated_native_config="$isolated_native_base/g"
  isolated_native_home="$isolated_native_base/h"
  isolated_source_parent="$ISOLATION_ROOT/private-runner-home"
  isolated_private_bottle_dir="$ISOLATION_ROOT/private-runner-cache"
  isolated_shared_temp="$ISOLATION_ROOT/shared-temp"
  isolated_kandelo="$isolated_source_parent/kandelo"
  isolated_tap="$isolated_source_parent/tap"
  isolated_dependency_tap="$isolated_source_parent/dependency-tap"
  isolated_output="$isolated_source_parent/output"
  isolated_sysroot_private_parent="$ISOLATION_ROOT/private-sysroot-owner"
  isolated_sysroot_owner="$isolated_sysroot_private_parent/sysroot-build"
  isolated_sysroot="$isolated_sysroot_owner/sysroot"
  isolated_xtask_dir="$isolated_kandelo/target/x86_64-unknown-linux-gnu/release"
  isolated_xtask="$isolated_xtask_dir/xtask"
  isolated_dependency_plan="$isolated_output/host-dependencies.json"
  isolated_tier2_attestation="$isolated_output/tier2-attestation.json"
  isolated_home="/home/$ISOLATION_BUILD_USER"
  daemon_marker="$isolated_work/detached-process-survived"
  daemon_started="$isolated_work/detached-process-started"
  native_daemon_marker="$isolated_native_temp/detached-process-survived"
  native_daemon_started="$isolated_native_temp/detached-process-started"
  external_cellar="$isolated_work/external-cellar"
  external_opt="$isolated_work/external-opt"
  mkdir -p "$isolated_repo/bin" "$isolated_prefix/bin" "$isolated_work" \
    "$isolated_cache" "$isolated_temp" "$isolated_kandelo" "$isolated_tap" \
    "$isolated_dependency_tap" "$isolated_output" "$isolated_native_base" \
    "$external_cellar" "$external_opt" \
    "$isolated_private_bottle_dir" "$isolated_shared_temp" "$isolated_sysroot/lib" \
    "$isolated_xtask_dir"
  chmod 0711 "$isolated_native_base"
  chmod 0700 "$isolated_private_bottle_dir"
  chmod 0700 "$isolated_sysroot_private_parent"
  /usr/bin/sudo -n -- chown root:root "$isolated_shared_temp"
  /usr/bin/sudo -n -- chmod 1777 "$isolated_shared_temp"
  protected_bottle_basename="hello--1.0.wasm32_kandelo.bottle.tar.gz"
  protected_bottle_content="canonical protected bottle bytes"
  private_bottle="$isolated_private_bottle_dir/$protected_bottle_basename"
  printf '%s\n' "$protected_bottle_content" >"$private_bottle"
  printf 'reviewed source\n' >"$isolated_kandelo/source-marker"
  cp -R "$platform_fixture"/. "$isolated_kandelo"/
  printf 'reviewed tap\n' >"$isolated_tap/tap-marker"
  printf 'reviewed dependency tap\n' >"$isolated_dependency_tap/tap-marker"
  printf 'reviewed sysroot\n' >"$isolated_sysroot/lib/libc.a"
  cat >"$isolated_xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 4 ]
[ "$1" = "build-deps" ]
[ "$2" = "program-index-context-check" ]
[ "$3" = "--source-repo-root" ]
[ "$4" = "${HOMEBREW_KANDELO_ROOT:?}" ]
[ -r "$4/source-marker" ]
printf 'checked source projection\n'
EOF
  chmod 0555 "$isolated_xtask"
  printf 'target work\n' >"$isolated_work/target-work-marker"
  printf 'external target untouched\n' >"$external_cellar/sentinel"
  printf 'external target untouched\n' >"$external_opt/sentinel"
  dependency_plan_json='{"build":["cmake"],"build_and_test":["cmake","ninja"],"formula":"hello","full_name":"kandelo-dev/tap-core/hello","native_requirements":[],"runtime_and_test":["ninja"],"schema":4,"tap":"kandelo-dev/tap-core","target_taps":[{"tap_commit":"1111111111111111111111111111111111111111","tap_name":"kandelo-dev/tap-core","tap_repository":"kandelo-dev/homebrew-tap-core"}]}'
  printf '%s\n' "$dependency_plan_json" >"$isolated_dependency_plan"
  chmod 0600 "$isolated_dependency_plan"
  tier2_attestation_json='{"arch":"wasm32","formula":"hello","formula_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","full_name":"kandelo-dev/tap-core/hello","schema":3,"support_runtime_sha256":"1111111111111111111111111111111111111111111111111111111111111111","support_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tap":"kandelo-dev/tap-core","tap_recipe":{"dependencies":[],"entrypoint":"build.sh","file_count":1,"manifest_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","script_env_keys":[],"source_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","source_url":"https://example.test/hello-1.0.tar.gz","total_bytes":1,"version":"1.0"},"tier2_bridge":null}'
  printf '%s\n' "$tier2_attestation_json" >"$isolated_tier2_attestation"
  chmod 0600 "$isolated_tier2_attestation"
  mkdir "$isolated_kandelo/runner-control"
  chmod 0700 "$isolated_kandelo/runner-control"
  # Model GitHub's workflow-private home: the Formula identity cannot traverse
  # the original checkout. The launcher must expose only its root-created,
  # read-only bind aliases inside the isolated service.
  chmod 0700 "$isolated_source_parent"
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

  if id kandelo-homebrew-recipe >/dev/null 2>&1; then
    fail "reserved tap recipe identity already exists"
  fi
  /usr/bin/sudo -n -- /usr/sbin/useradd --system --user-group --create-home \
    --home-dir "$isolated_home" --shell /usr/sbin/nologin "$ISOLATION_BUILD_USER"
  # WHY: staging preflight runs before the publisher creates its production
  # identities. The live fixture must own the same exact third identity so it
  # exercises schema-3 isolation instead of relying on later workflow state.
  ISOLATION_RECIPE_USER="kandelo-homebrew-recipe"
  /usr/bin/sudo -n -- /usr/sbin/useradd --system --user-group --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin "$ISOLATION_RECIPE_USER"
  export KANDELO_HOMEBREW_RECIPE_USER="$ISOLATION_RECIPE_USER"
  protected_selector_root="$ISOLATION_ROOT/protected-version-selector"
  escaped_selector_root="$ISOLATION_ROOT/escaped-version-selector"
  escaped_selector_target_root="$ISOLATION_ROOT/escaped-version-target"
  replaceable_selector_root="$ISOLATION_ROOT/replaceable-version-selector"
  /usr/bin/sudo -n -- /usr/bin/install -d -o root -g root -m 0555 \
    "$protected_selector_root" "$escaped_selector_root" \
    "$escaped_selector_target_root"
  /usr/bin/sudo -n -- /usr/bin/install -d \
    -o "$ISOLATION_BUILD_USER" -g "$(id -gn "$ISOLATION_BUILD_USER")" -m 0755 \
    "$replaceable_selector_root"
  /usr/bin/sudo -n -- /usr/bin/install -o root -g root -m 0555 \
    /usr/bin/true "$protected_selector_root/python3.42"
  /usr/bin/sudo -n -- /usr/bin/install -o root -g root -m 0555 \
    /usr/bin/true "$escaped_selector_target_root/python3.42"
  /usr/bin/sudo -n -- /usr/bin/install \
    -o "$ISOLATION_BUILD_USER" -g "$(id -gn "$ISOLATION_BUILD_USER")" -m 0755 \
    /usr/bin/true "$replaceable_selector_root/python3.42"
  /usr/bin/sudo -n -- /usr/bin/ln -s python3.42 \
    "$protected_selector_root/python3"
  /usr/bin/sudo -n -- /usr/bin/ln -s \
    "$escaped_selector_target_root/python3.42" "$escaped_selector_root/python3"
  /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- /usr/bin/ln -s python3.42 \
    "$replaceable_selector_root/python3"
  HOMEBREW_PATCHED_SUDO_BIN=/usr/bin/sudo
  homebrew_assert_protected_host_versioned_executable \
    "$ISOLATION_BUILD_USER" "$protected_selector_root/python3" \
    "$protected_selector_root/python3" "protected test Python" python3 ||
    fail "protected root-owned version selector was rejected"
  homebrew_assert_protected_host_versioned_executable \
    "$ISOLATION_BUILD_USER" /usr/bin/python3 /usr/bin/python3 python3 python3 ||
    fail "distribution-provided protected Python selector was rejected"
  if homebrew_assert_protected_host_versioned_executable \
      "$ISOLATION_BUILD_USER" "$escaped_selector_root/python3" \
      "$escaped_selector_root/python3" "escaped test Python" python3 \
      >/dev/null 2>&1; then
    fail "version selector escaped its protected system directory"
  fi
  if homebrew_assert_protected_host_versioned_executable \
      "$ISOLATION_BUILD_USER" "$replaceable_selector_root/python3" \
      "$replaceable_selector_root/python3" "replaceable test Python" python3 \
      >/dev/null 2>&1; then
    fail "version selector accepted a build-user-replaceable tool"
  fi
  HOMEBREW_PATCHED_SUDO_BIN=""
  assert_real_relocated_xtask_uses_source_alias "$ISOLATION_BUILD_USER"
  /usr/bin/sudo -n -- chown -R \
    "$ISOLATION_BUILD_USER:$(id -gn "$ISOLATION_BUILD_USER")" \
    "$external_cellar" "$external_opt"
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    /usr/bin/test -r "$private_bottle"; then
    fail "build identity can read the workflow-private bottle path"
  fi
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    /usr/bin/test -x "$isolated_sysroot_owner"; then
    fail "sysroot fixture does not model a workflow-private owner path"
  fi
  if /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    /usr/bin/test -r "$isolated_xtask"; then
    fail "program-index checker fixture does not model a workflow-private checkout"
  fi
  export HOMEBREW_CACHE="$isolated_cache"
  export HOMEBREW_TEMP="$isolated_temp"
  export XDG_CONFIG_HOME="$isolated_work/xdg-config"
  export KANDELO_HOMEBREW_SUDO_BIN=/usr/bin/sudo
  export KANDELO_HOMEBREW_SYSTEMD_RUN_BIN=/usr/bin/systemd-run
  export KANDELO_HOMEBREW_SYSTEMCTL_BIN=/usr/bin/systemctl
  export KANDELO_HOMEBREW_GETENT_BIN=/usr/bin/getent
  export KANDELO_HOMEBREW_PGREP_BIN=/usr/bin/pgrep
  export KANDELO_HOMEBREW_PKILL_BIN=/usr/bin/pkill
  HOMEBREW_KANDELO_NODE="$(command -v node)"
  export HOMEBREW_KANDELO_NODE
  [[ "$HOMEBREW_KANDELO_NODE" =~ ^/nix/store/[0-9a-z]{32}-nodejs-[^/]+/bin/node$ ]] ||
    fail "launcher isolation test requires the declared Nix Node executable"
  HOMEBREW_KANDELO_GNU_TAR="$(command -v tar)"
  export HOMEBREW_KANDELO_GNU_TAR
  [[ "$HOMEBREW_KANDELO_GNU_TAR" =~ ^/nix/store/[0-9a-z]{32}-gnutar-[^/]+/bin/tar$ ]] ||
    fail "launcher isolation test requires the declared Nix GNU tar"
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
  isolated_primary_tap="$isolated_overlay/Library/Taps/kandelo-dev/homebrew-tap-core"
  mkdir -p "$isolated_primary_tap"
  printf 'selected primary tap\n' >"$isolated_primary_tap/primary-tap-marker"
  isolated_recipe_root="$isolated_primary_tap/Kandelo/recipes/hello"
  isolated_recipe_script="$isolated_recipe_root/build.sh"
  isolated_recipe_manifest="$isolated_recipe_root/recipe.json"
  isolated_recipe_host_secret="$ISOLATION_ROOT/recipe-host-secret"
  mkdir -p "$isolated_recipe_root"
  printf 'workflow credential canary\n' >"$isolated_recipe_host_secret"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'host_secret=%q\n' "$isolated_recipe_host_secret"
    cat <<'EOF'
# A tap controls this script. Exercise the escape paths an untrusted recipe
# would use rather than merely inspecting the generated systemd arguments.
if [ -e "$host_secret" ] || [ -r "$host_secret" ] ||
   /usr/bin/cat "$host_secret" >/dev/null 2>&1; then
  echo "tap recipe can read an unrelated host file" >&2
  exit 91
fi
if [ -e "/proc/1/root$host_secret" ] ||
   [ -r "/proc/1/root$host_secret" ]; then
  echo "tap recipe escaped its root through host procfs" >&2
  exit 94
fi
if [ -e /run/systemd/private ] || [ -S /run/dbus/system_bus_socket ]; then
  echo "tap recipe retained a host service-manager socket" >&2
  exit 92
fi
if /usr/bin/systemd-run --quiet --wait --pipe -- \
     /usr/bin/true >/dev/null 2>&1; then
  echo "tap recipe started a host transient service" >&2
  exit 93
fi
[ "$(/usr/bin/cat "$WASM_POSIX_DEP_SOURCE_DIR/input.txt")" = "reviewed source" ]
[ -r "$WASM_POSIX_DEP_RECIPE_DIR/recipe.json" ]
[ -r "$WASM_POSIX_GLUE_DIR/abi_constants.h" ]
[ -r "$WASM_POSIX_SYSROOT/lib/libc.a" ]
printf 'closed root projection\n' >"$WASM_POSIX_DEP_OUT_DIR/canary.txt"
EOF
  } >"$isolated_recipe_script"
  chmod 0755 "$isolated_primary_tap/Kandelo" \
    "$isolated_primary_tap/Kandelo/recipes" "$isolated_recipe_root" \
    "$isolated_recipe_script"
  isolated_recipe_bytes="$(wc -c <"$isolated_recipe_script" | tr -d '[:space:]')"
  isolated_recipe_sha="$(homebrew_sha256_stream <"$isolated_recipe_script")"
  jq -n \
    --argjson bytes "$isolated_recipe_bytes" \
    --arg sha256 "$isolated_recipe_sha" \
    '{
      schema: 1,
      dependencies: [],
      entrypoint: "build.sh",
      files: [{
        bytes: $bytes,
        mode: "0755",
        path: "build.sh",
        sha256: $sha256
      }]
    }' >"$isolated_recipe_manifest"
  chmod 0644 "$isolated_recipe_manifest"
  isolated_recipe_manifest_sha="$(
    homebrew_sha256_stream <"$isolated_recipe_manifest"
  )"
  tier2_attestation_json="$(
    jq -cn \
      --argjson file_count 1 \
      --arg manifest_sha256 "$isolated_recipe_manifest_sha" \
      --argjson total_bytes "$isolated_recipe_bytes" \
      '{
        arch: "wasm32",
        formula: "hello",
        formula_sha256: ("a" * 64),
        full_name: "kandelo-dev/tap-core/hello",
        schema: 3,
        support_runtime_sha256: ("1" * 64),
        support_sha256: ("b" * 64),
        tap: "kandelo-dev/tap-core",
        tap_recipe: {
          dependencies: [],
          entrypoint: "build.sh",
          file_count: $file_count,
          manifest_sha256: $manifest_sha256,
          script_env_keys: [],
          source_sha256: ("d" * 64),
          source_url: "https://example.test/hello-1.0.tar.gz",
          total_bytes: $total_bytes,
          version: "1.0"
        },
        tier2_bridge: null
      }'
  )"
  printf '%s\n' "$tier2_attestation_json" >"$isolated_tier2_attestation"
  chmod 0600 "$isolated_tier2_attestation"
  export HOMEBREW_KANDELO_PRIMARY_TAP_ROOT="$isolated_primary_tap"
  [ ! -e "$isolated_prefix/Library/Taps" ] ||
    fail "isolation fixture unexpectedly put repository-owned taps under the prefix"
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
  homebrew_patched_launcher_stage_tier2_attestation "$isolated_tier2_attestation"
  isolated_dependency_keg="$isolated_prefix/Cellar/dependency/1.0"
  isolated_dependency_file="$isolated_dependency_keg/lib/dependency.a"
  isolated_dependency_opt="$isolated_prefix/opt/dependency"
  mkdir -p "${isolated_dependency_file%/*}" "$isolated_prefix/opt"
  printf 'sealed target dependency\n' >"$isolated_dependency_file"
  ln -s ../Cellar/dependency/1.0 "$isolated_dependency_opt"
  [ "$(stat -c '%u:%a' "$isolated_native_base")" = "$(id -u):711" ] ||
    fail "workflow-owned native parent changed during preparation"
  for native_root in "$isolated_native_prefix" "$isolated_native_cache" \
    "$isolated_native_temp" "$isolated_native_config" "$isolated_native_home"; do
    [ "$(stat -c '%u:%a' "$native_root")" = "$(id -u):700" ] ||
      fail "prepared native child does not match the production private mode: $native_root"
  done
  printf 'native boundary marker\n' >"$isolated_native_prefix/boundary-marker"
  export KANDELO_HOMEBREW_ARCH=wasm64
  export WASM_POSIX_XTASK_BIN="$isolated_xtask"
  if homebrew_patched_launcher_isolate \
      "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
      "$isolated_output" "$isolated_sysroot_owner" >/dev/null 2>&1; then
    fail "Formula isolation accepted an absent architecture-specific sysroot"
  fi
  export KANDELO_HOMEBREW_ARCH=invalid
  if homebrew_patched_launcher_isolate \
      "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
      "$isolated_output" "$isolated_sysroot_owner" >/dev/null 2>&1; then
    fail "Formula isolation accepted an invalid target architecture"
  fi
  export KANDELO_HOMEBREW_ARCH=wasm32

  assert_xtask_rejected() {
    local candidate="$1" expected_error="$2" label="$3"
    local error_file="$ISOLATION_ROOT/rejected-xtask.err"
    local saved_xtask="$WASM_POSIX_XTASK_BIN"
    if [ -n "$candidate" ]; then
      export WASM_POSIX_XTASK_BIN="$candidate"
    else
      unset WASM_POSIX_XTASK_BIN
    fi
    if homebrew_patched_launcher_isolate \
        "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
        "$isolated_output" "$isolated_sysroot_owner" > /dev/null 2>"$error_file"; then
      fail "Formula isolation accepted $label"
    fi
    grep -F "$expected_error" "$error_file" >/dev/null ||
      fail "Formula isolation did not explain rejected $label"
    export WASM_POSIX_XTASK_BIN="$saved_xtask"
  }

  assert_xtask_rejected "" \
    "prepared program-index checker must be one exact regular executable" \
    "a missing program-index checker"

  isolated_xtask_link="$isolated_xtask_dir/xtask-link"
  ln -s xtask "$isolated_xtask_link"
  assert_xtask_rejected "$isolated_xtask_link" \
    "prepared program-index checker must be one exact regular executable" \
    "a symlinked program-index checker"
  rm "$isolated_xtask_link"

  outside_xtask="$isolated_output/xtask"
  cp "$isolated_xtask" "$outside_xtask"
  assert_xtask_rejected "$outside_xtask" \
    "prepared program-index checker is outside the exact Kandelo root" \
    "a program-index checker outside Kandelo"
  rm "$outside_xtask"

  misplaced_xtask="$isolated_kandelo/xtask"
  cp "$isolated_xtask" "$misplaced_xtask"
  assert_xtask_rejected "$misplaced_xtask" \
    "program-index checker is not the prepared release xtask" \
    "a non-release program-index checker"
  rm "$misplaced_xtask"

  inaccessible_xtask="$isolated_kandelo/target/inaccessible/release/xtask"
  mkdir -p "${inaccessible_xtask%/*}"
  cp "$isolated_xtask" "$inaccessible_xtask"
  chmod 0700 "$inaccessible_xtask"
  assert_xtask_rejected "$inaccessible_xtask" \
    "prepared program-index checker has an unsafe mode" \
    "an inaccessible program-index checker"
  rm -rf "$isolated_kandelo/target/inaccessible"

  writable_xtask="$isolated_kandelo/target/writable/release/xtask"
  mkdir -p "${writable_xtask%/*}"
  cp "$isolated_xtask" "$writable_xtask"
  chmod 0777 "$writable_xtask"
  assert_xtask_rejected "$writable_xtask" \
    "prepared program-index checker has an unsafe mode" \
    "a build-user-writable program-index checker"
  rm -rf "$isolated_kandelo/target/writable"

  hardlinked_xtask="$isolated_kandelo/target/hardlinked/release/xtask"
  mkdir -p "${hardlinked_xtask%/*}"
  cp "$isolated_xtask" "$hardlinked_xtask"
  ln "$hardlinked_xtask" "$hardlinked_xtask.alternate"
  assert_xtask_rejected "$hardlinked_xtask" \
    "prepared program-index checker is not single-linked" \
    "a hard-linked program-index checker"
  rm -rf "$isolated_kandelo/target/hardlinked"

  owned_xtask="$isolated_kandelo/target/owned/release/xtask"
  mkdir -p "${owned_xtask%/*}"
  cp "$isolated_xtask" "$owned_xtask"
  /usr/bin/sudo -n -- chown "$ISOLATION_BUILD_USER" "$owned_xtask"
  assert_xtask_rejected "$owned_xtask" \
    "prepared program-index checker is owned by the Formula user" \
    "a Formula-user-owned program-index checker"
  rm -rf "$isolated_kandelo/target/owned"

  replaceable_xtask="$isolated_kandelo/target/replaceable/release/xtask"
  mkdir -p "${replaceable_xtask%/*}"
  cp "$isolated_xtask" "$replaceable_xtask"
  /usr/bin/sudo -n -- chown "$ISOLATION_BUILD_USER" "${replaceable_xtask%/*}"
  # This negative case must expose the deliberately replaceable inner
  # directory. The positive production-shaped case below restores the private
  # runner-home boundary before exercising the read-only source alias.
  chmod 0711 "$isolated_source_parent"
  assert_xtask_rejected "$replaceable_xtask" \
    "build user can replace protected source" \
    "a build-user-replaceable program-index checker"
  chmod 0700 "$isolated_source_parent"
  /usr/bin/sudo -n -- chown "$(id -u):$(id -g)" "${replaceable_xtask%/*}"
  rm -rf "$isolated_kandelo/target/replaceable"

  assert_primary_tap_rejected() {
    local candidate="$1" expected_error="$2" label="$3"
    local error_file="$ISOLATION_ROOT/rejected-primary-tap.err"
    local saved_primary_tap="$HOMEBREW_KANDELO_PRIMARY_TAP_ROOT"
    export HOMEBREW_KANDELO_PRIMARY_TAP_ROOT="$candidate"
    if homebrew_patched_launcher_isolate \
        "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
        "$isolated_output" "$isolated_sysroot_owner" > /dev/null 2>"$error_file"; then
      fail "Formula isolation accepted $label"
    fi
    grep -F "$expected_error" "$error_file" >/dev/null ||
      fail "Formula isolation did not explain rejected $label"
    export HOMEBREW_KANDELO_PRIMARY_TAP_ROOT="$saved_primary_tap"
  }

  prefix_primary_tap="$isolated_prefix/Library/Taps/kandelo-dev/homebrew-tap-core"
  mkdir -p "$prefix_primary_tap"
  printf 'prefix lookalike\n' >"$prefix_primary_tap/primary-tap-marker"
  assert_primary_tap_rejected \
    "$prefix_primary_tap" \
    "selected primary tap root is not one canonical tapped checkout" \
    "a prefix-owned primary tap lookalike"
  rm -r "$isolated_prefix/Library"

  assert_primary_tap_rejected \
    "$isolated_tap" \
    "selected primary tap root is not one canonical tapped checkout" \
    "a primary tap outside the active repository tap store"

  primary_tap_link="$isolated_overlay/Library/Taps/kandelo-dev/homebrew-link"
  ln -s homebrew-tap-core "$primary_tap_link"
  assert_primary_tap_rejected \
    "$primary_tap_link" \
    "selected primary tap root must be a real directory" \
    "a symlinked primary tap"
  rm "$primary_tap_link"

  ln -s "$isolated_sysroot_owner" "$isolated_sysroot_owner-link"
  if homebrew_patched_launcher_isolate \
      "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
      "$isolated_output" "$isolated_sysroot_owner-link" >/dev/null 2>&1; then
    fail "Formula isolation accepted a symlinked sysroot build root"
  fi
  rm "$isolated_sysroot_owner-link"
  mv "$isolated_sysroot/lib/libc.a" "$isolated_sysroot/lib/libc-real.a"
  ln -s libc-real.a "$isolated_sysroot/lib/libc.a"
  if homebrew_patched_launcher_isolate \
      "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
      "$isolated_output" "$isolated_sysroot_owner" >/dev/null 2>&1; then
    fail "Formula isolation accepted a symlinked sysroot libc archive"
  fi
  rm "$isolated_sysroot/lib/libc.a"
  mv "$isolated_sysroot/lib/libc-real.a" "$isolated_sysroot/lib/libc.a"
  ln -s "$isolated_output" "$isolated_sysroot/escaping-link"
  if homebrew_patched_launcher_isolate \
      "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
      "$isolated_output" "$isolated_sysroot_owner" >/dev/null 2>&1; then
    fail "Formula isolation accepted a sysroot symlink outside its protected tree"
  fi
  rm "$isolated_sysroot/escaping-link"
  ln -s lib/libc.a "$isolated_sysroot/contained-link"
  homebrew_assert_tree_symlinks_contained "$isolated_sysroot" sysroot
  mkdir -p "$isolated_prefix/sysroot/lib"
  printf 'overlapping sysroot\n' >"$isolated_prefix/sysroot/lib/libc.a"
  if homebrew_patched_launcher_isolate \
      "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
      "$isolated_output" "$isolated_prefix" >/dev/null 2>&1; then
    fail "Formula isolation accepted a sysroot build root overlapping its mutable prefix"
  fi
  rm -rf "$isolated_prefix/sysroot"
  homebrew_patched_launcher_isolate \
    "$ISOLATION_BUILD_USER" "$isolated_work" "$isolated_kandelo" "$isolated_tap" \
    "$isolated_output" "$isolated_sysroot_owner" "$isolated_dependency_tap"
  protected_dir="$HOMEBREW_PATCHED_PROTECTED_DIR"
  source_alias_dir="$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR"
  protected_platform_root="$HOMEBREW_PATCHED_PLATFORM_ROOT"
  protected_xtask="$HOMEBREW_PATCHED_PROTECTED_DIR/xtask"
  [ "$(/usr/bin/sudo -n -- /usr/bin/stat -c '%u:%g:%a:%h' "$protected_xtask")" = \
      "0:0:555:1" ] &&
    /usr/bin/sudo -n -- /usr/bin/cmp -s -- "$isolated_xtask" "$protected_xtask" ||
    fail "isolated launcher did not stage one exact root-owned checker inode"
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
  if homebrew_patched_launcher_stage_protected_input \
       "$ISOLATION_BUILD_USER" "$isolated_shared_temp" "$private_bottle" \
       '../unsafe-bottle.tar.gz' >/dev/null 2>&1; then
    fail "protected input staging accepted an unsafe basename"
  fi
  if homebrew_patched_launcher_stage_protected_input \
       "$ISOLATION_BUILD_USER" "$isolated_shared_temp" "$private_bottle" \
       "$(printf '%0513d' 0)" >/dev/null 2>&1; then
    fail "protected input staging accepted an oversized basename"
  fi
  [ -z "$(find "$isolated_shared_temp" -mindepth 1 -print -quit)" ] ||
    fail "rejected protected input staging left partial state"
  homebrew_patched_launcher_stage_protected_input \
    "$ISOLATION_BUILD_USER" "$isolated_shared_temp" "$private_bottle" \
    "$protected_bottle_basename"
  protected_bottle="$HOMEBREW_PATCHED_STAGED_INPUT_PATH"
  protected_bottle_dir="$HOMEBREW_PATCHED_STAGED_INPUT_DIR"
  case "$protected_bottle_dir" in
    "$isolated_shared_temp"/homebrew-bottle-input.??????) ;;
    *) fail "protected bottle used an unexpected directory: $protected_bottle_dir" ;;
  esac
  [ "${protected_bottle##*/}" = "$protected_bottle_basename" ] &&
    [ "$(stat -c '%u:%g:%a' "$protected_bottle_dir")" = "0:0:555" ] &&
    [ "$(stat -c '%u:%g:%a:%h' "$protected_bottle")" = "0:0:444:1" ] &&
    cmp -s "$private_bottle" "$protected_bottle" ||
    fail "protected bottle path, ownership, or content changed"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-protected-input \
    "$protected_bottle" "$protected_bottle_basename" "$isolated_shared_temp" \
    "$(id -u "$ISOLATION_BUILD_USER")" "$protected_bottle_content"
  [ "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" = "$isolated_shared_temp" ] ||
    fail "protected bottle lifecycle lost its shared temp root"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-identity \
    "$(id -u "$ISOLATION_BUILD_USER")" "$(id -g "$ISOLATION_BUILD_USER")"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-protected-gnu-tar \
    "$HOMEBREW_KANDELO_GNU_TAR"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-protected-git \
    "$HOMEBREW_GIT_PATH"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-working-directory "$isolated_work"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-target-dependency-sealed \
    "$isolated_dependency_file" "$isolated_dependency_opt"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-immutable-trust reviewed-trust
  "$HOMEBREW_PATCHED_BREW_BIN" assert-dependency-plan \
    "$HOMEBREW_PATCHED_DEPENDENCY_PLAN" "$dependency_plan_json"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-dependency-plan \
    "$HOMEBREW_PATCHED_TIER2_ATTESTATION" "$tier2_attestation_json"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-publisher-patch
  "$HOMEBREW_PATCHED_BREW_BIN" assert-bundler-seed
  if "$HOMEBREW_PATCHED_BREW_BIN" trust >/dev/null 2>&1; then
    fail "explicit trust mutation succeeded against the sealed store"
  fi
  HOMEBREW_KANDELO_XTASK_BIN=caller-poison \
  WASM_POSIX_XTASK_BIN=caller-poison \
  "$HOMEBREW_PATCHED_BREW_BIN" assert-closed-source-aliases \
    "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR/kandelo" \
    "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR/kandelo/target/x86_64-unknown-linux-gnu/release/xtask" \
    "$protected_xtask" \
    "$isolated_kandelo" "$isolated_tap" "$isolated_output" \
    "$isolated_sysroot_owner" "$isolated_dependency_tap" \
    "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR/kandelo/tools/bin/wasm-fork-instrument" \
    "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR/kandelo/tools/bin/wasm-local-root-spill"
  HOMEBREW_KANDELO_PRIMARY_TAP_ROOT=caller-poison \
    "$HOMEBREW_PATCHED_BREW_BIN" assert-primary-tap-root \
      "$isolated_primary_tap"
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
      "$isolated_tap" "$isolated_output" "$isolated_sysroot_owner" \
      "$isolated_dependency_tap"
  homebrew_patched_launcher_run_native assert-protected-git \
    "$HOMEBREW_GIT_PATH"
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
  homebrew_patched_launcher_run_native create-native-relative-link \
    cmake cmake-cross-final cmake-cross
  homebrew_patched_launcher_run_native create-native-relative-link \
    cmake ../../../ninja/1.0/bin/ninja cmake-cross-final
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
  [ -L "$target_proxy_opt/bin/cmake-cross" ] && \
    [ -L "$target_proxy_opt/bin/cmake-cross-final" ] && \
    [ "$(readlink "$target_proxy_opt/bin/cmake-cross")" = \
      "$isolated_native_prefix/Cellar/ninja/1.0/bin/ninja" ] && \
    [ "$(readlink "$target_proxy_opt/bin/cmake-cross-final")" = \
      "$isolated_native_prefix/Cellar/ninja/1.0/bin/ninja" ] && \
    [ "$("$target_proxy_opt/bin/cmake-cross")" = "native fixture" ] ||
    fail "isolated native Formula proxy did not preserve its sealed native closure"
  [ ! -e "$isolated_prefix/Cellar/ninja" ] && \
    [ ! -L "$isolated_prefix/Cellar/ninja" ] && \
    [ ! -e "$isolated_prefix/opt/ninja" ] && \
    [ ! -L "$isolated_prefix/opt/ninja" ] ||
    fail "isolated native Formula proxy exposed its transitive closure"
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

  recipe_build_root="$isolated_temp/tap-recipe-canary"
  recipe_source_root="$recipe_build_root/kandelo-package-source"
  recipe_work_root="$recipe_build_root/kandelo-package-work"
  recipe_output_root="$recipe_build_root/kandelo-package-out"
  recipe_request="$recipe_build_root/.kandelo-tap-recipe-request.json"
  recipe_response="$recipe_build_root/.kandelo-tap-recipe-response.json"
  mkdir -p "$recipe_source_root" "$recipe_work_root" "$recipe_output_root"
  printf 'reviewed source\n' >"$recipe_source_root/input.txt"
  recipe_config_json="$(
    /usr/bin/sudo -n -- /usr/bin/cat "$HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG"
  )"
  mapfile -t recipe_native_formulae < <(
    jq -r '.native_formulae[]' <<<"$recipe_config_json"
  )
  recipe_native_roots=()
  for native_formula in "${recipe_native_formulae[@]}"; do
    mapfile -t native_versions < <(
      find "$isolated_native_prefix/Cellar/$native_formula" \
        -mindepth 1 -maxdepth 1 -type d -print
    )
    [ "${#native_versions[@]}" -eq 1 ] ||
      fail "recipe canary lacks one exact native keg for $native_formula"
    recipe_native_roots+=("${native_versions[0]}")
  done
  recipe_native_roots_json="$(
    if [ "${#recipe_native_roots[@]}" -eq 0 ]; then
      printf '[]'
    else
      printf '%s\n' "${recipe_native_roots[@]}" |
        LC_ALL=C sort | jq -Rsc 'split("\n")[:-1]'
    fi
  )"
  recipe_request_json="$(
    jq -cnS \
      --arg arch "$(jq -r '.arch' <<<"$recipe_config_json")" \
      --arg entrypoint "$(jq -r '.recipe_entrypoint' <<<"$recipe_config_json")" \
      --arg formula "$(jq -r '.formula' <<<"$recipe_config_json")" \
      --arg llvm_bin "$(jq -r '.llvm_bin' <<<"$recipe_config_json")" \
      --arg manifest_sha256 "$(jq -r '.manifest_sha256' <<<"$recipe_config_json")" \
      --arg output_root "$recipe_output_root" \
      --arg platform_root "$(jq -r '.platform_alias_root' <<<"$recipe_config_json")" \
      --arg recipe_root "$(jq -r '.recipe_alias_root' <<<"$recipe_config_json")" \
      --arg recipe_user "$(jq -r '.recipe_user' <<<"$recipe_config_json")" \
      --arg source_root "$recipe_source_root" \
      --arg source_sha256 "$(jq -r '.source_sha256' <<<"$recipe_config_json")" \
      --arg source_url "$(jq -r '.source_url' <<<"$recipe_config_json")" \
      --arg sysroot "$(jq -r '.sysroot_alias_root' <<<"$recipe_config_json")" \
      --arg version "$(jq -r '.version' <<<"$recipe_config_json")" \
      --arg work_root "$recipe_work_root" \
      --argjson native_roots "$recipe_native_roots_json" '
      {
        arch: $arch,
        dependencies: {},
        entrypoint: $entrypoint,
        environment: {
          HOME: ($work_root + "/home"),
          LOGNAME: $recipe_user,
          PATH: "/usr/bin:/bin",
          TMPDIR: ($work_root + "/tmp"),
          USER: $recipe_user,
          WASM_POSIX_DEP_NAME: "hello",
          WASM_POSIX_DEP_OUT_DIR: $output_root,
          WASM_POSIX_DEP_RECIPE_DIR: $recipe_root,
          WASM_POSIX_DEP_SOURCE_DIR: $source_root,
          WASM_POSIX_DEP_SOURCE_SHA256: $source_sha256,
          WASM_POSIX_DEP_SOURCE_URL: $source_url,
          WASM_POSIX_DEP_TARGET_ARCH: $arch,
          WASM_POSIX_DEP_VERSION: $version,
          WASM_POSIX_DEP_WORK_DIR: $work_root,
          WASM_POSIX_GLUE_DIR: ($platform_root + "/libc/glue"),
          WASM_POSIX_INSTALL_LOCAL_MIRROR: "0",
          WASM_POSIX_LLVM_DIR: $llvm_bin,
          WASM_POSIX_SYSROOT: $sysroot
        },
        formula: $formula,
        limits: {
          max_bytes: 2147483648,
          max_entries: 262144,
          max_file_bytes: 1073741824,
          max_path_bytes: 4096
        },
        manifest_sha256: $manifest_sha256,
        native_roots: $native_roots,
        output_root: $output_root,
        platform_root: $platform_root,
        recipe_root: $recipe_root,
        schema: 1,
        source_root: $source_root,
        sysroot: $sysroot,
        version: $version,
        work_root: $work_root
      }
    '
  )"
  printf '%s' "$recipe_request_json" >"$recipe_request"
  chmod 0400 "$recipe_request"
  /usr/bin/sudo -n -- /usr/bin/chown -R \
    "$ISOLATION_BUILD_USER:$(id -gn "$ISOLATION_BUILD_USER")" \
    "$recipe_build_root"
  /usr/bin/sudo -n -H -u "$ISOLATION_BUILD_USER" -- \
    /usr/bin/env -i "$HOMEBREW_PATCHED_RECIPE_RUNNER" \
      --request "$recipe_request" --response "$recipe_response"
  jq -e '
    .schema == 1 and .entry_count == 1 and .total_bytes == 23 and
    (.sealed_output_root | type == "string" and startswith("/run/")) and
    (.output_manifest_sha256 | test("^[0-9a-f]{64}$")) and
    (.request_sha256 | test("^[0-9a-f]{64}$"))
  ' "$recipe_response" >/dev/null ||
    fail "tap recipe canary returned an invalid sealed-output receipt"
  recipe_sealed_root="$(jq -r '.sealed_output_root' "$recipe_response")"
  [ "$(/usr/bin/cat "$recipe_sealed_root/canary.txt")" = \
      "closed root projection" ] ||
    fail "tap recipe canary did not return its declared output"
  [ "$(/usr/bin/cat "$isolated_recipe_host_secret")" = \
      "workflow credential canary" ] ||
    fail "tap recipe canary changed the unrelated host sentinel"
  homebrew_patched_launcher_sealed_directory_state \
    "$HOMEBREW_PATCHED_RECIPE_SEALED_ROOT" >/dev/null ||
    fail "populated sealed-output root lost its portable directory seal"
  homebrew_patched_launcher_verify_isolation

  cp "$isolated_xtask" "$isolated_xtask.backup"
  # WHY: production checkers are sealed 0555. Only the private fixture owner
  # may unseal this copy, and every launcher invocation must see it resealed.
  chmod 0755 "$isolated_xtask"
  printf 'stale replacement\n' >>"$isolated_xtask"
  chmod 0555 "$isolated_xtask"
  if "$HOMEBREW_PATCHED_BREW_BIN" assert-no-new-privileges \
      >/dev/null 2>"$ISOLATION_ROOT/stale-xtask.err"; then
    fail "isolated launcher accepted changed program-index checker bytes"
  fi
  grep -F "prepared program-index checker changed after isolation" \
    "$ISOLATION_ROOT/stale-xtask.err" >/dev/null ||
    fail "isolated launcher did not explain stale program-index checker bytes"
  chmod 0755 "$isolated_xtask"
  cp "$isolated_xtask.backup" "$isolated_xtask"
  chmod 0555 "$isolated_xtask"
  rm "$isolated_xtask.backup"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-no-new-privileges
  /usr/bin/sudo -n -- chmod 0755 "$protected_xtask"
  printf 'stale root copy\n' |
    /usr/bin/sudo -n -- tee -a "$protected_xtask" >/dev/null
  /usr/bin/sudo -n -- chmod 0555 "$protected_xtask"
  if "$HOMEBREW_PATCHED_BREW_BIN" assert-no-new-privileges \
      >/dev/null 2>"$ISOLATION_ROOT/stale-protected-xtask.err"; then
    fail "isolated launcher accepted changed root-owned checker bytes"
  fi
  grep -F "root-owned program-index checker changed after isolation" \
    "$ISOLATION_ROOT/stale-protected-xtask.err" >/dev/null ||
    fail "isolated launcher did not explain changed root-owned checker bytes"
  if homebrew_patched_launcher_verify_isolation \
      >/dev/null 2>"$ISOLATION_ROOT/stale-protected-xtask-verify.err"; then
    fail "isolation verification accepted changed root-owned checker bytes"
  fi
  grep -F "root-owned program-index checker changed after isolation" \
    "$ISOLATION_ROOT/stale-protected-xtask-verify.err" >/dev/null ||
    fail "isolation verification did not explain changed root-owned checker bytes"
  /usr/bin/sudo -n -- chmod 0755 "$protected_xtask"
  /usr/bin/sudo -n -- cp "$isolated_xtask" "$protected_xtask"
  /usr/bin/sudo -n -- chmod 0555 "$protected_xtask"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-no-new-privileges
  homebrew_patched_launcher_verify_isolation
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
  /usr/bin/sudo -n -- mv -- "$protected_xtask" "$protected_xtask.original"
  /usr/bin/sudo -n -- /usr/bin/install -o root -g root -m 0555 -- \
    "$isolated_xtask" "$protected_xtask"
  if "$HOMEBREW_PATCHED_BREW_BIN" assert-no-new-privileges \
      >/dev/null 2>"$ISOLATION_ROOT/replaced-protected-xtask.err"; then
    fail "isolated launcher accepted a replaced root-owned checker inode"
  fi
  grep -F "root-owned program-index checker changed after isolation" \
    "$ISOLATION_ROOT/replaced-protected-xtask.err" >/dev/null ||
    fail "isolated launcher did not explain the replaced root-owned checker inode"
  if homebrew_patched_launcher_verify_isolation \
      >/dev/null 2>"$ISOLATION_ROOT/replaced-protected-xtask-verify.err"; then
    fail "isolation verification accepted a replaced root-owned checker inode"
  fi
  grep -F "root-owned program-index checker changed after isolation" \
    "$ISOLATION_ROOT/replaced-protected-xtask-verify.err" >/dev/null ||
    fail "isolation verification did not explain the replaced root-owned checker inode"
  /usr/bin/sudo -n -- rm -f -- "$protected_xtask"
  /usr/bin/sudo -n -- mv -- "$protected_xtask.original" "$protected_xtask"
  "$HOMEBREW_PATCHED_BREW_BIN" assert-no-new-privileges
  homebrew_patched_launcher_verify_isolation
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
  [ -r "$protected_bottle" ] ||
    fail "protected bottle disappeared before launcher cleanup"
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
  [ ! -e "$isolated_prefix/.kandelo-publisher-tier2-attestation.json" ] ||
    fail "isolated cleanup left the publisher Tier-2 attestation"
  [ ! -e "$protected_dir" ] && [ ! -e "$source_alias_dir" ] && \
    [ ! -e "$protected_platform_root" ] && \
    [ -z "$HOMEBREW_PATCHED_PROTECTED_DIR" ] && \
    [ -z "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR" ] && \
    [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK" ] && \
    [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_STATE" ] && \
    [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256" ] && \
    [ -z "$HOMEBREW_PATCHED_PLATFORM_ROOT" ] && \
    [ -z "$HOMEBREW_PATCHED_PLATFORM_SHA256" ] ||
    fail "isolated cleanup left the protected checker or source aliases"
  [ ! -e "$protected_bottle" ] && [ ! -e "$protected_bottle_dir" ] && \
    [ -z "$(find "$isolated_shared_temp" -mindepth 1 -print -quit)" ] && \
    [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] && \
    [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] && \
    [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ] ||
    fail "isolated cleanup left the protected bottle or lifecycle state"
  /usr/bin/sudo -n -- /usr/sbin/userdel "$ISOLATION_RECIPE_USER"
  ! id "$ISOLATION_RECIPE_USER" >/dev/null 2>&1 ||
    fail "tap recipe identity survived retirement"
  ISOLATION_RECIPE_USER=""
  /usr/bin/sudo -n -- /usr/sbin/userdel -r "$ISOLATION_BUILD_USER"
  ! id "$ISOLATION_BUILD_USER" >/dev/null 2>&1 || fail "Formula build identity survived retirement"
  ISOLATION_BUILD_USER=""
  /usr/bin/sudo -n -- rm -rf "$ISOLATION_ROOT"
  ISOLATION_ROOT=""
fi

echo "test-homebrew-patched-launcher.sh: ok"
