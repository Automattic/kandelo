#!/usr/bin/env bash

# Lifecycle helpers for running a patched Homebrew worktree without changing
# the prefix and Cellar selected by the caller's brew executable.

HOMEBREW_PATCHED_REPO=""
HOMEBREW_PATCHED_PREFIX=""
HOMEBREW_PATCHED_OVERLAY=""
HOMEBREW_PATCHED_LAUNCHER=""
HOMEBREW_PATCHED_BREW_BIN=""
HOMEBREW_PATCHED_PROTECTED_DIR=""
HOMEBREW_PATCHED_INTEGRITY_SHA256=""
HOMEBREW_PATCHED_SUDO_BIN=""
HOMEBREW_PATCHED_SYSTEMD_RUN_BIN=""
HOMEBREW_PATCHED_SYSTEMCTL_BIN=""
HOMEBREW_PATCHED_GETENT_BIN=""
HOMEBREW_PATCHED_PGREP_BIN=""
HOMEBREW_PATCHED_PKILL_BIN=""
HOMEBREW_PATCHED_BUILD_USER=""
HOMEBREW_PATCHED_BUILD_UID=""
HOMEBREW_PATCHED_SYSTEMD_SLICE=""
HOMEBREW_PATCHED_TEARDOWN_COMPLETE=0

homebrew_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

homebrew_patched_launcher_integrity() {
  {
    git -C "$HOMEBREW_PATCHED_OVERLAY" diff --binary HEAD
    git -C "$HOMEBREW_PATCHED_OVERLAY" status --porcelain=v1 --untracked-files=all
  } | homebrew_sha256_stream
}

homebrew_assert_tree_not_writable_by_user() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_assert_tree_not_writable_by_user: expected USER TREE" >&2
    return 2
  fi
  local user="$1" tree="$2" writable
  [ -d "$tree" ] && [ ! -L "$tree" ] || {
    echo "homebrew-patched-launcher: protected source is not a real directory: $tree" >&2
    return 1
  }
  [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ] || {
    echo "homebrew-patched-launcher: privileged host boundary is not initialized" >&2
    return 2
  }
  writable="$("$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- \
    find "$tree" -xdev \
      \( -writable -print -quit \) -o \
      \( -type d \( ! -readable -o ! -executable \) -prune \) \
      2>/dev/null)"
  if [ -n "$writable" ]; then
    echo "homebrew-patched-launcher: build user can write protected source: $writable" >&2
    return 1
  fi
}

homebrew_assert_tree_not_replaceable_by_user() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_assert_tree_not_replaceable_by_user: expected USER TREE" >&2
    return 2
  fi
  local user="$1" current="$2" parent mode current_uid parent_uid user_uid
  user_uid="$(id -u "$user")"
  current="$(cd "$current" && pwd -P)"
  while [ "$current" != "/" ]; do
    parent="$(dirname "$current")"
    if "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- test -w "$parent"; then
      mode="$(stat -c '%a' "$parent")"
      current_uid="$(stat -c '%u' "$current")"
      parent_uid="$(stat -c '%u' "$parent")"
      if [ $((8#$mode & 01000)) -eq 0 ] || \
         [ "$current_uid" = "$user_uid" ] || [ "$parent_uid" = "$user_uid" ]; then
        echo "homebrew-patched-launcher: build user can replace protected source: $current" >&2
        return 1
      fi
    fi
    current="$parent"
  done
}

homebrew_assert_protected_host_executable() {
  if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "homebrew_assert_protected_host_executable: expected USER PATH EXPECTED LABEL [SYMLINK_TARGET]" >&2
    return 2
  fi
  local user="$1" path="$2" expected="$3" label="$4"
  local symlink_target="${5:-}" mode resolved parent parent_mode
  if [ "$path" != "$expected" ] || [ ! -f "$path" ] || [ ! -x "$path" ]; then
    echo "homebrew-patched-launcher: $label must be the protected $expected" >&2
    return 2
  fi
  resolved="$(readlink -f -- "$path" 2>/dev/null || true)"
  if [ -L "$path" ]; then
    parent="$(dirname "$path")"
    parent_mode="$(stat -c '%a' "$parent" 2>/dev/null || true)"
    if [ -z "$symlink_target" ] || [ "$resolved" != "$symlink_target" ] || \
       [ "$(stat -c '%u' "$path" 2>/dev/null || true)" != "0" ] || \
       [ "$(stat -c '%u' "$parent" 2>/dev/null || true)" != "0" ] || \
       ! [[ "$parent_mode" =~ ^[0-7]{3,4}$ ]] || \
       [ $((8#$parent_mode & 0022)) -ne 0 ] || \
       "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- test -w "$parent"; then
      echo "homebrew-patched-launcher: $label symlink is not protected" >&2
      return 2
    fi
  elif [ -n "$symlink_target" ] && [ "$resolved" != "$path" ]; then
    echo "homebrew-patched-launcher: $label resolves outside $expected" >&2
    return 2
  fi
  mode="$(stat -Lc '%a' "$resolved" 2>/dev/null || true)"
  if [ ! -f "$resolved" ] || [ ! -x "$resolved" ] || \
     [ "$(stat -Lc '%u' "$resolved" 2>/dev/null || true)" != "0" ] || \
     ! [[ "$mode" =~ ^[0-7]{3,4}$ ]] || [ $((8#$mode & 0022)) -ne 0 ]; then
    echo "homebrew-patched-launcher: $label must be the protected $expected" >&2
    return 2
  fi
  if "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- test -w "$path"; then
    echo "homebrew-patched-launcher: build user can replace $label" >&2
    return 2
  fi
}

homebrew_patched_launcher_cleanup() {
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] && \
     [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" != "1" ]; then
    homebrew_patched_launcher_teardown "$HOMEBREW_PATCHED_BUILD_USER" \
      >/dev/null 2>&1 || true
  fi
  if [ -n "$HOMEBREW_PATCHED_PROTECTED_DIR" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" rm -rf "$HOMEBREW_PATCHED_PROTECTED_DIR" \
      >/dev/null 2>&1 || true
    HOMEBREW_PATCHED_PROTECTED_DIR=""
  fi
  if [ -n "$HOMEBREW_PATCHED_LAUNCHER" ] && [ -L "$HOMEBREW_PATCHED_LAUNCHER" ]; then
    rm -f "$HOMEBREW_PATCHED_LAUNCHER" 2>/dev/null || \
      "$HOMEBREW_PATCHED_SUDO_BIN" rm -f "$HOMEBREW_PATCHED_LAUNCHER" \
        >/dev/null 2>&1 || true
  fi
  if [ -n "$HOMEBREW_PATCHED_REPO" ] &&
     [ -n "$HOMEBREW_PATCHED_OVERLAY" ] &&
     [ -d "$HOMEBREW_PATCHED_OVERLAY" ]; then
    git -C "$HOMEBREW_PATCHED_REPO" worktree remove --force "$HOMEBREW_PATCHED_OVERLAY" \
      >/dev/null 2>&1 || rm -rf "$HOMEBREW_PATCHED_OVERLAY"
  fi
  HOMEBREW_PATCHED_SUDO_BIN=""
  HOMEBREW_PATCHED_SYSTEMD_RUN_BIN=""
  HOMEBREW_PATCHED_SYSTEMCTL_BIN=""
  HOMEBREW_PATCHED_GETENT_BIN=""
  HOMEBREW_PATCHED_PGREP_BIN=""
  HOMEBREW_PATCHED_PKILL_BIN=""
  HOMEBREW_PATCHED_BUILD_USER=""
  HOMEBREW_PATCHED_BUILD_UID=""
  HOMEBREW_PATCHED_SYSTEMD_SLICE=""
  HOMEBREW_PATCHED_TEARDOWN_COMPLETE=0
}

# Move all Formula-evaluating Brew calls behind a fixed wrapper that switches
# to a dedicated user inside a transient systemd service. KillMode=control-group
# makes double-forked or session-detached descendants part of the call lifecycle.
homebrew_patched_launcher_isolate() {
  if [ "$#" -ne 4 ]; then
    echo "homebrew_patched_launcher_isolate: expected BUILD_USER WORK_DIR KANDELO_ROOT TAP_ROOT" >&2
    return 2
  fi
  local build_user="$1" work_dir="$2" kandelo_root="$3" tap_root="$4"
  local build_group build_home protected_brew wrapper_source wrapper_path
  local mutable_root protected_root
  local sudo_bin sudo_mode env_bin variable value patched_prefix patched_repo
  local systemd_run_bin systemctl_bin getent_bin pgrep_bin pkill_bin
  local build_uid systemd_slice unit_prefix
  local -a preserved_variables

  [ "$(uname -s)" = "Linux" ] || {
    echo "homebrew-patched-launcher: isolated Formula execution requires Linux" >&2
    return 2
  }
  id "$build_user" >/dev/null 2>&1 || {
    echo "homebrew-patched-launcher: build user does not exist: $build_user" >&2
    return 2
  }
  [ "$(id -u "$build_user")" != "$(id -u)" ] || {
    echo "homebrew-patched-launcher: build user must differ from the workflow user" >&2
    return 2
  }
  sudo_bin="${KANDELO_HOMEBREW_SUDO_BIN:-}"
  sudo_mode="$(stat -c '%a' "$sudo_bin" 2>/dev/null || true)"
  if [ "$sudo_bin" != "/usr/bin/sudo" ] || [ ! -f "$sudo_bin" ] || \
     [ -L "$sudo_bin" ] || [ ! -x "$sudo_bin" ] || \
     [ "$(stat -c '%u' "$sudo_bin" 2>/dev/null || true)" != "0" ] || \
     ! [[ "$sudo_mode" =~ ^[0-7]{3,4}$ ]] || \
     [ $((8#$sudo_mode & 0022)) -ne 0 ]; then
    echo "homebrew-patched-launcher: KANDELO_HOMEBREW_SUDO_BIN must be the protected /usr/bin/sudo" >&2
    return 2
  fi
  HOMEBREW_PATCHED_SUDO_BIN="$sudo_bin"
  if "$sudo_bin" -H -u "$build_user" -- test -w "$sudo_bin"; then
    echo "homebrew-patched-launcher: build user can replace the privileged host boundary" >&2
    return 2
  fi
  systemd_run_bin="${KANDELO_HOMEBREW_SYSTEMD_RUN_BIN:-}"
  systemctl_bin="${KANDELO_HOMEBREW_SYSTEMCTL_BIN:-}"
  getent_bin="${KANDELO_HOMEBREW_GETENT_BIN:-}"
  pgrep_bin="${KANDELO_HOMEBREW_PGREP_BIN:-}"
  pkill_bin="${KANDELO_HOMEBREW_PKILL_BIN:-}"
  homebrew_assert_protected_host_executable \
    "$build_user" "$systemd_run_bin" /usr/bin/systemd-run systemd-run
  homebrew_assert_protected_host_executable \
    "$build_user" "$systemctl_bin" /usr/bin/systemctl systemctl
  homebrew_assert_protected_host_executable \
    "$build_user" "$getent_bin" /usr/bin/getent getent
  homebrew_assert_protected_host_executable \
    "$build_user" "$pgrep_bin" /usr/bin/pgrep pgrep
  homebrew_assert_protected_host_executable \
    "$build_user" "$pkill_bin" /usr/bin/pkill pkill /usr/bin/pgrep
  [ -d /run/systemd/system ] || {
    echo "homebrew-patched-launcher: systemd is not the active service manager" >&2
    return 2
  }
  "$sudo_bin" -n -- "$systemctl_bin" show --property=Version --value >/dev/null || {
    echo "homebrew-patched-launcher: systemd manager is unavailable" >&2
    return 2
  }
  env_bin="$(command -v env)"
  build_group="$(id -gn "$build_user")"
  build_uid="$(id -u "$build_user")"
  build_home="$("$getent_bin" passwd "$build_user" | awk -F: '{print $6}')"
  [ -n "$build_home" ] || {
    echo "homebrew-patched-launcher: build user has no home directory" >&2
    return 2
  }

  for mutable_root in "$work_dir" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP"; do
    if [ ! -d "$mutable_root" ] || [ -L "$mutable_root" ]; then
      echo "homebrew-patched-launcher: mutable build root is not a real directory: $mutable_root" >&2
      return 2
    fi
  done
  chmod 1777 "$work_dir"
  "$sudo_bin" chown -R "$build_user:$build_group" \
    "$HOMEBREW_PATCHED_PREFIX" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP"
  "$sudo_bin" chown "root:$build_group" "$HOMEBREW_PATCHED_PREFIX"
  "$sudo_bin" chmod 1775 "$HOMEBREW_PATCHED_PREFIX"
  "$sudo_bin" install -d -o root -g root -m 0755 \
    "$HOMEBREW_PATCHED_PREFIX/etc/homebrew" "$XDG_CONFIG_HOME/homebrew"
  "$sudo_bin" chown -R root:root "$HOMEBREW_PATCHED_PREFIX/etc/homebrew" "$XDG_CONFIG_HOME"
  "$sudo_bin" chmod -R a-w "$HOMEBREW_PATCHED_PREFIX/etc/homebrew" "$XDG_CONFIG_HOME"
  "$sudo_bin" chmod a+rx "$HOMEBREW_PATCHED_PREFIX/etc/homebrew" \
    "$XDG_CONFIG_HOME" "$XDG_CONFIG_HOME/homebrew"
  for mutable_root in "$work_dir" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP" "$build_home"; do
    if ! "$sudo_bin" -H -u "$build_user" -- test -r "$mutable_root" -a \
      -x "$mutable_root" -a -w "$mutable_root"; then
      echo "homebrew-patched-launcher: build user cannot access mutable build root: $mutable_root" >&2
      return 2
    fi
  done

  HOMEBREW_PATCHED_PROTECTED_DIR="$HOMEBREW_PATCHED_PREFIX/.kandelo-homebrew-$$-${RANDOM}"
  "$sudo_bin" install -d -o root -g root -m 0755 "$HOMEBREW_PATCHED_PROTECTED_DIR"
  protected_brew="$HOMEBREW_PATCHED_PROTECTED_DIR/brew"
  "$sudo_bin" ln -s "$HOMEBREW_PATCHED_OVERLAY/bin/brew" "$protected_brew"

  wrapper_source="$work_dir/run-isolated-brew"
  wrapper_path="$HOMEBREW_PATCHED_PROTECTED_DIR/run-brew"
  systemd_slice="kandelo-homebrew-build-${build_uid}.slice"
  unit_prefix="kandelo-homebrew-build-${build_uid}"
  preserved_variables=(
    CI GITHUB_ACTIONS RUNNER_OS LANG LC_ALL TZ SOURCE_DATE_EPOCH
    PATH XDG_CONFIG_HOME
    HOMEBREW_CACHE HOMEBREW_TEMP HOMEBREW_NO_AUTO_UPDATE
    HOMEBREW_NO_INSTALL_CLEANUP HOMEBREW_NO_ANALYTICS HOMEBREW_DEVELOPER
    KANDELO_HOMEBREW_ARCH KANDELO_HOMEBREW_KANDELO_ROOT
    HOMEBREW_KANDELO_ARCH HOMEBREW_KANDELO_ROOT HOMEBREW_KANDELO_NODE
    HOMEBREW_KANDELO_LLVM_BIN
    LLVM_BIN WASM_POSIX_LLVM_DIR
    NIX_SSL_CERT_FILE SSL_CERT_FILE PLAYWRIGHT_BROWSERS_PATH
  )
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'bottle_tag_env=()\n'
    for variable in KANDELO_HOMEBREW_BOTTLE_TAG HOMEBREW_KANDELO_BOTTLE_TAG; do
      printf 'if [ -n "${%s+x}" ]; then bottle_tag_env+=("%s=${%s}"); fi\n' \
        "$variable" "$variable" "$variable"
    done
    # The workflow checkout may live below a home directory that the isolated
    # build identity cannot traverse. The mutable work root was already
    # verified for that identity, so use it as the service working directory.
    printf 'working_directory=%q\n' "$work_dir"
    printf 'unit=%q-$$-${RANDOM}.service\n' "$unit_prefix"
    printf 'exec %q -n -- %q --quiet --wait --collect --pipe' \
      "$sudo_bin" "$systemd_run_bin"
    printf ' --unit="$unit"'
    printf ' %q' "--slice=$systemd_slice" \
      "--uid=$build_user" "--gid=$build_group" \
      "--property=KillMode=control-group" "--property=SendSIGKILL=yes" \
      "--property=TimeoutStopSec=10s" "--property=NoNewPrivileges=yes" \
      "--service-type=exec" \
      "--expand-environment=no"
    printf ' --working-directory="$working_directory" -- %q -i' "$env_bin"
    printf ' %q' "HOME=$build_home" "USER=$build_user" "LOGNAME=$build_user" \
      "TMPDIR=$HOMEBREW_TEMP"
    for variable in "${preserved_variables[@]}"; do
      if [ -n "${!variable+x}" ]; then
        value="${!variable}"
        printf ' %q' "$variable=$value"
      fi
    done
    printf ' "${bottle_tag_env[@]}" %q "$@"\n' "$protected_brew"
  } >"$wrapper_source"
  "$sudo_bin" install -o root -g root -m 0555 "$wrapper_source" "$wrapper_path"
  rm -f "$wrapper_source"
  "$sudo_bin" chmod 0555 "$HOMEBREW_PATCHED_PROTECTED_DIR"

  for protected_root in \
    "$kandelo_root" "$tap_root" "$HOMEBREW_PATCHED_REPO" "$HOMEBREW_PATCHED_OVERLAY"; do
    homebrew_assert_tree_not_writable_by_user "$build_user" "$protected_root"
    homebrew_assert_tree_not_replaceable_by_user "$build_user" "$protected_root"
  done
  HOMEBREW_PATCHED_INTEGRITY_SHA256="$(homebrew_patched_launcher_integrity)"
  HOMEBREW_PATCHED_SYSTEMD_RUN_BIN="$systemd_run_bin"
  HOMEBREW_PATCHED_SYSTEMCTL_BIN="$systemctl_bin"
  HOMEBREW_PATCHED_GETENT_BIN="$getent_bin"
  HOMEBREW_PATCHED_PGREP_BIN="$pgrep_bin"
  HOMEBREW_PATCHED_PKILL_BIN="$pkill_bin"
  HOMEBREW_PATCHED_BUILD_USER="$build_user"
  HOMEBREW_PATCHED_BUILD_UID="$build_uid"
  HOMEBREW_PATCHED_SYSTEMD_SLICE="$systemd_slice"
  HOMEBREW_PATCHED_TEARDOWN_COMPLETE=0

  # The old launcher lives in the writable prefix bin directory. Retire it so
  # all subsequent parent-process calls use the root-owned sticky entry.
  "$sudo_bin" rm -f "$HOMEBREW_PATCHED_LAUNCHER"
  HOMEBREW_PATCHED_LAUNCHER="$protected_brew"
  HOMEBREW_PATCHED_BREW_BIN="$wrapper_path"
  patched_prefix="$("$HOMEBREW_PATCHED_BREW_BIN" --prefix)" || return
  patched_repo="$("$HOMEBREW_PATCHED_BREW_BIN" --repository)" || return
  [ "$patched_prefix" = "$HOMEBREW_PATCHED_PREFIX" ] || {
    echo "homebrew-patched-launcher: isolated wrapper changed Homebrew prefix" >&2
    return 1
  }
  [ "$(cd "$patched_repo" && pwd -P)" = "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ] || {
    echo "homebrew-patched-launcher: isolated wrapper changed Homebrew repository" >&2
    return 1
  }
}

homebrew_patched_launcher_uid_has_processes() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_uid_has_processes: expected no arguments" >&2
    return 2
  fi
  local status
  if "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PGREP_BIN" \
    -u "$HOMEBREW_PATCHED_BUILD_UID" >/dev/null 2>&1; then
    return 0
  else
    status="$?"
  fi
  if [ "$status" -eq 1 ]; then
    return 1
  fi
  echo "homebrew-patched-launcher: could not inspect Formula build identity processes" >&2
  return 2
}

homebrew_patched_launcher_teardown() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_teardown: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" attempt process_status
  if [ -z "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    return 0
  fi
  if [ "$build_user" != "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: teardown user differs from isolated build user" >&2
    return 2
  fi
  if [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" = "1" ]; then
    return 0
  fi

  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
    stop "$HOMEBREW_PATCHED_SYSTEMD_SLICE" >/dev/null 2>&1 || true
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PKILL_BIN" \
    -TERM -u "$HOMEBREW_PATCHED_BUILD_UID" >/dev/null 2>&1 || true
  for ((attempt = 0; attempt < 50; attempt++)); do
    if homebrew_patched_launcher_uid_has_processes; then
      sleep 0.1
      continue
    else
      process_status="$?"
    fi
    if [ "$process_status" -eq 1 ]; then
      break
    fi
    return "$process_status"
  done
  if homebrew_patched_launcher_uid_has_processes; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PKILL_BIN" \
      -KILL -u "$HOMEBREW_PATCHED_BUILD_UID" >/dev/null 2>&1 || true
    sleep 1
  else
    process_status="$?"
    [ "$process_status" -eq 1 ] || return "$process_status"
  fi
  if homebrew_patched_launcher_uid_has_processes; then
    echo "homebrew-patched-launcher: Formula build identity still owns live processes" >&2
    return 1
  else
    process_status="$?"
    [ "$process_status" -eq 1 ] || return "$process_status"
  fi
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
    reset-failed "$HOMEBREW_PATCHED_SYSTEMD_SLICE" >/dev/null 2>&1 || true
  HOMEBREW_PATCHED_TEARDOWN_COMPLETE=1
}

homebrew_patched_launcher_verify_isolation() {
  if [ -z "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || [ -z "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ]; then
    echo "homebrew-patched-launcher: isolated execution was not initialized" >&2
    return 2
  fi
  [ "$(homebrew_patched_launcher_integrity)" = "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ] || {
    echo "homebrew-patched-launcher: patched Homebrew source changed during Formula execution" >&2
    return 1
  }
  [ -L "$HOMEBREW_PATCHED_LAUNCHER" ] && \
    [ "$(readlink "$HOMEBREW_PATCHED_LAUNCHER")" = "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] || {
    echo "homebrew-patched-launcher: protected Brew launcher changed during Formula execution" >&2
    return 1
  }
}

homebrew_patched_launcher_prepare() {
  if [ "$#" -ne 3 ]; then
    echo "homebrew_patched_launcher_prepare: expected BREW_BIN PATCH_FILE WORK_DIR" >&2
    return 2
  fi

  local brew_bin="$1"
  local patch_file="$2"
  local work_dir="$3"
  local attempt candidate patched_prefix patched_repo

  HOMEBREW_PATCHED_REPO="$("$brew_bin" --repository)" || return
  HOMEBREW_PATCHED_PREFIX="$("$brew_bin" --prefix)" || return
  HOMEBREW_PATCHED_BREW_BIN="$brew_bin"

  if [ ! -f "$patch_file" ] ||
     ! git -C "$HOMEBREW_PATCHED_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  git -C "$HOMEBREW_PATCHED_REPO" apply --check "$patch_file" || return
  HOMEBREW_PATCHED_OVERLAY="$work_dir/homebrew-overlay"
  git -C "$HOMEBREW_PATCHED_REPO" worktree add --detach "$HOMEBREW_PATCHED_OVERLAY" HEAD >/dev/null || return
  git -C "$HOMEBREW_PATCHED_OVERLAY" apply --whitespace=nowarn "$patch_file" || return

  # Homebrew derives HOMEBREW_PREFIX from the path used to invoke bin/brew and
  # HOMEBREW_REPOSITORY from that symlink's target. Invoking the worktree's
  # launcher directly would move the prefix into work_dir, making ordinary
  # host build-dependency bottles non-relocatable.
  attempt=0
  while [ "$attempt" -lt 100 ]; do
    attempt=$((attempt + 1))
    candidate="$HOMEBREW_PATCHED_PREFIX/bin/.kandelo-brew-$$-${RANDOM}-${attempt}"
    if ln -s "$HOMEBREW_PATCHED_OVERLAY/bin/brew" "$candidate" 2>/dev/null; then
      HOMEBREW_PATCHED_LAUNCHER="$candidate"
      break
    fi
  done
  if [ -z "$HOMEBREW_PATCHED_LAUNCHER" ]; then
    echo "homebrew-patched-launcher: could not create a launcher under $HOMEBREW_PATCHED_PREFIX/bin" >&2
    return 1
  fi

  HOMEBREW_PATCHED_BREW_BIN="$HOMEBREW_PATCHED_LAUNCHER"
  patched_prefix="$("$HOMEBREW_PATCHED_BREW_BIN" --prefix)" || return
  patched_repo="$("$HOMEBREW_PATCHED_BREW_BIN" --repository)" || return
  if [ "$patched_prefix" != "$HOMEBREW_PATCHED_PREFIX" ]; then
    echo "homebrew-patched-launcher: changed Homebrew prefix: $HOMEBREW_PATCHED_PREFIX -> $patched_prefix" >&2
    return 1
  fi
  if [ "$(cd "$patched_repo" && pwd -P)" != "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ]; then
    echo "homebrew-patched-launcher: did not select its temporary repository" >&2
    return 1
  fi
}
