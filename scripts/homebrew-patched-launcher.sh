#!/usr/bin/env bash

# Lifecycle helpers for running a patched Homebrew worktree without changing
# the prefix and Cellar selected by the caller's brew executable.

HOMEBREW_PATCHED_REPO=""
HOMEBREW_PATCHED_PREFIX=""
HOMEBREW_PATCHED_OVERLAY=""
HOMEBREW_PATCHED_LAUNCHER=""
HOMEBREW_PATCHED_BREW_BIN=""
HOMEBREW_PATCHED_PROTECTED_DIR=""
HOMEBREW_PATCHED_SOURCE_ALIAS_DIR=""
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
  if ! writable="$("$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- \
    find "$tree" -xdev \
      \( -writable -print -quit \) -o \
      \( -type d \( ! -readable -o ! -executable \) -prune \))"; then
    echo "homebrew-patched-launcher: could not inspect protected source as $user: $tree" >&2
    return 2
  fi
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
  if [ -n "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" rm -rf "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR" \
      >/dev/null 2>&1 || true
    HOMEBREW_PATCHED_SOURCE_ALIAS_DIR=""
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
  if [ "$#" -ne 5 ]; then
    echo "homebrew_patched_launcher_isolate: expected BUILD_USER WORK_DIR KANDELO_ROOT TAP_ROOT OUTPUT_ROOT" >&2
    return 2
  fi
  local build_user="$1" work_dir="$2" kandelo_root="$3" tap_root="$4" output_root="$5"
  local build_group build_home protected_brew protected_audit
  local wrapper_source wrapper_path audit_source
  local mutable_root protected_root
  local sudo_bin sudo_mode env_bin variable value patched_prefix patched_repo
  local systemd_run_bin systemctl_bin getent_bin pgrep_bin pkill_bin
  local build_uid systemd_slice unit_prefix source_alias_dir
  local config_root config_file unsafe_config_entry trust_file trust_lock
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
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/findmnt /usr/bin/findmnt findmnt
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/find /usr/bin/find find
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

  for protected_root in "$kandelo_root" "$tap_root" "$output_root"; do
    if [ ! -d "$protected_root" ] || [ -L "$protected_root" ]; then
      echo "homebrew-patched-launcher: protected root is not a real directory: $protected_root" >&2
      return 2
    fi
    case "$protected_root" in
      *:*)
        echo "homebrew-patched-launcher: protected root cannot contain ':' for a systemd bind: $protected_root" >&2
        return 2
        ;;
    esac
  done

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
  for config_root in "$HOMEBREW_PATCHED_PREFIX/etc/homebrew" "$XDG_CONFIG_HOME"; do
    if ! unsafe_config_entry="$("$sudo_bin" -n -- /usr/bin/find "$config_root" \
      -xdev ! \( -type d -o -type f \) -print -quit)"; then
      echo "homebrew-patched-launcher: could not inspect isolated config: $config_root" >&2
      return 2
    fi
    [ -z "$unsafe_config_entry" ] || {
      echo "homebrew-patched-launcher: isolated config contains a non-regular entry: $unsafe_config_entry" >&2
      return 2
    }
    "$sudo_bin" chown -R root:root "$config_root"
    "$sudo_bin" -n -- /usr/bin/find "$config_root" -xdev -type d \
      -exec chmod 0555 {} +
    "$sudo_bin" -n -- /usr/bin/find "$config_root" -xdev -type f \
      -exec chmod 0444 {} +
  done

  # The publisher overlay does not persist redundant item trust for an already
  # trusted tap. Keep both the trust data and any existing lock inode readable
  # but immutable; explicit trust mutations must still fail in this identity.
  trust_file="$XDG_CONFIG_HOME/homebrew/trust.json"
  trust_lock="${trust_file}.lock"
  for config_file in "$trust_file" "$trust_lock"; do
    [ -f "$config_file" ] && [ ! -L "$config_file" ] || {
      echo "homebrew-patched-launcher: required trust-store file is not regular: $config_file" >&2
      return 2
    }
  done
  [ ! "$trust_file" -ef "$trust_lock" ] &&
    [ "$(stat -c '%h' "$trust_file")" = "1" ] &&
    [ "$(stat -c '%h' "$trust_lock")" = "1" ] || {
      echo "homebrew-patched-launcher: trust-store files must use distinct private inodes" >&2
      return 2
    }
  [ "$(stat -c '%u:%g:%a:%h' "$trust_file")" = "0:0:444:1" ] &&
    [ "$(stat -c '%u:%g:%a:%h' "$trust_lock")" = "0:0:444:1" ] &&
    [ "$(stat -c '%u:%g:%a' "$XDG_CONFIG_HOME")" = "0:0:555" ] &&
    [ "$(stat -c '%u:%g:%a' "$XDG_CONFIG_HOME/homebrew")" = "0:0:555" ] || {
      echo "homebrew-patched-launcher: isolated trust-store ownership or mode is unsafe" >&2
      return 2
    }
  for config_file in "$trust_file" "$trust_lock"; do
    "$sudo_bin" -H -u "$build_user" -- test -r "$config_file" &&
      ! "$sudo_bin" -H -u "$build_user" -- test -w "$config_file" || {
        echo "homebrew-patched-launcher: isolated trust-store access is unsafe: $config_file" >&2
        return 2
      }
  done
  for mutable_root in "$work_dir" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP" "$build_home"; do
    if ! "$sudo_bin" -H -u "$build_user" -- test -r "$mutable_root" -a \
      -x "$mutable_root" -a -w "$mutable_root"; then
      echo "homebrew-patched-launcher: build user cannot access mutable build root: $mutable_root" >&2
      return 2
    fi
  done

  HOMEBREW_PATCHED_PROTECTED_DIR="$HOMEBREW_PATCHED_PREFIX/.kandelo-homebrew-$$-${RANDOM}"
  "$sudo_bin" install -d -o root -g root -m 0755 "$HOMEBREW_PATCHED_PROTECTED_DIR"
  source_alias_dir="$work_dir/source-aliases"
  "$sudo_bin" install -d -o root -g root -m 0555 \
    "$source_alias_dir" "$source_alias_dir/kandelo" "$source_alias_dir/tap"
  HOMEBREW_PATCHED_SOURCE_ALIAS_DIR="$source_alias_dir"
  protected_brew="$HOMEBREW_PATCHED_PROTECTED_DIR/brew"
  "$sudo_bin" ln -s "$HOMEBREW_PATCHED_OVERLAY/bin/brew" "$protected_brew"

  audit_source="$work_dir/audit-source-aliases"
  protected_audit="$HOMEBREW_PATCHED_PROTECTED_DIR/audit-source-aliases"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'expected_kandelo=%q\n' "$source_alias_dir/kandelo"
    printf 'expected_tap=%q\n' "$source_alias_dir/tap"
    printf 'if [ "${HOMEBREW_KANDELO_ROOT:-}" != "$expected_kandelo" ] || '
    printf '[ "${KANDELO_HOMEBREW_KANDELO_ROOT:-}" != "$expected_kandelo" ]; then\n'
    printf '  echo "homebrew-patched-launcher: isolated Kandelo root does not use the protected alias" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'for source_alias in "$expected_kandelo" "$expected_tap"; do\n'
    printf '  if [ ! -d "$source_alias" ] || [ ! -r "$source_alias" ] || [ ! -x "$source_alias" ]; then\n'
    printf '    echo "homebrew-patched-launcher: protected source alias is inaccessible: $source_alias" >&2\n'
    printf '    exit 2\n  fi\n'
    printf '  mount_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$source_alias")" || {\n'
    printf '    echo "homebrew-patched-launcher: could not inspect protected source mount: $source_alias" >&2\n'
    printf '    exit 2\n  }\n'
    printf '  case ",${mount_options// /}," in\n'
    printf '    *,ro,*) ;;\n'
    printf '    *) echo "homebrew-patched-launcher: protected source mount is writable: $source_alias" >&2; exit 1 ;;\n'
    printf '  esac\ndone\n'
    printf 'for hidden_root in %q %q %q; do\n' \
      "$kandelo_root" "$tap_root" "$output_root"
    printf '  if [ -e "$hidden_root" ] || [ -r "$hidden_root" ] || [ -x "$hidden_root" ]; then\n'
    printf '    echo "homebrew-patched-launcher: original protected root is visible to Formula execution: $hidden_root" >&2\n'
    printf '    exit 1\n  fi\ndone\n'
  } >"$audit_source"
  "$sudo_bin" install -o root -g root -m 0555 "$audit_source" "$protected_audit"
  rm -f "$audit_source"

  wrapper_source="$work_dir/run-isolated-brew"
  wrapper_path="$HOMEBREW_PATCHED_PROTECTED_DIR/run-brew"
  systemd_slice="kandelo-homebrew-build-${build_uid}.slice"
  unit_prefix="kandelo-homebrew-build-${build_uid}"
  preserved_variables=(
    CI GITHUB_ACTIONS RUNNER_OS LANG LC_ALL TZ SOURCE_DATE_EPOCH
    PATH XDG_CONFIG_HOME
    HOMEBREW_CACHE HOMEBREW_TEMP HOMEBREW_NO_AUTO_UPDATE
    HOMEBREW_NO_INSTALL_CLEANUP HOMEBREW_NO_ANALYTICS HOMEBREW_DEVELOPER
    KANDELO_HOMEBREW_ARCH
    HOMEBREW_KANDELO_ARCH HOMEBREW_KANDELO_NODE
    HOMEBREW_KANDELO_LLVM_BIN HOMEBREW_KANDELO_ABI
    HOMEBREW_KANDELO_NODE_RECEIPT_PATH
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
    printf 'command_path=%q\n' "$protected_brew"
    printf 'if [ "${1:-}" = __kandelo_verify_source_aliases ]; then\n'
    printf '  [ "$#" -eq 1 ] || { echo "homebrew-patched-launcher: source audit accepts no arguments" >&2; exit 2; }\n'
    printf '  command_path=%q\n' "$protected_audit"
    printf '  shift\nfi\n'
    printf 'working_directory=%q\n' "$work_dir"
    printf 'unit=%q-$$-${RANDOM}.service\n' "$unit_prefix"
    printf 'exec %q -n -- %q --quiet --wait --collect --pipe' \
      "$sudo_bin" "$systemd_run_bin"
    printf ' --unit="$unit"'
    printf ' %q' "--slice=$systemd_slice" \
      "--uid=$build_user" "--gid=$build_group" \
      "--property=KillMode=control-group" "--property=SendSIGKILL=yes" \
      "--property=TimeoutStopSec=10s" "--property=NoNewPrivileges=yes" \
      "--property=BindReadOnlyPaths=$kandelo_root:$source_alias_dir/kandelo" \
      "--property=BindReadOnlyPaths=$tap_root:$source_alias_dir/tap" \
      "--property=InaccessiblePaths=$kandelo_root" \
      "--property=InaccessiblePaths=$tap_root" \
      "--property=InaccessiblePaths=$output_root" \
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
    printf ' %q %q' "HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo" \
      "KANDELO_HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo"
    printf ' "${bottle_tag_env[@]}" "$command_path" "$@"\n'
  } >"$wrapper_source"
  "$sudo_bin" install -o root -g root -m 0555 "$wrapper_source" "$wrapper_path"
  rm -f "$wrapper_source"
  "$sudo_bin" chmod 0555 "$HOMEBREW_PATCHED_PROTECTED_DIR"

  # The overlay is a Git worktree, so its backing repository must remain
  # traversable. Protect the Formula-executing overlay itself instead.
  for protected_root in "$source_alias_dir" "$HOMEBREW_PATCHED_OVERLAY"; do
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
  "$HOMEBREW_PATCHED_BREW_BIN" __kandelo_verify_source_aliases || {
    echo "homebrew-patched-launcher: isolated source aliases failed verification" >&2
    return 1
  }
  if ! patched_prefix="$("$HOMEBREW_PATCHED_BREW_BIN" --prefix)"; then
    echo "homebrew-patched-launcher: isolated wrapper could not report the Homebrew prefix" >&2
    return 1
  fi
  if ! patched_repo="$("$HOMEBREW_PATCHED_BREW_BIN" --repository)"; then
    echo "homebrew-patched-launcher: isolated wrapper could not report the Homebrew repository" >&2
    return 1
  fi
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
  if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "homebrew_patched_launcher_prepare: expected BREW_BIN PATCH_FILE WORK_DIR [EXTRA_PATCH_FILE]" >&2
    return 2
  fi

  local brew_bin="$1"
  local patch_file="$2"
  local work_dir="$3"
  local extra_patch_file="${4:-}"
  local attempt candidate patched_prefix patched_repo

  if [ -n "$extra_patch_file" ] && [ ! -f "$extra_patch_file" ]; then
    echo "homebrew-patched-launcher: extra patch is unavailable: $extra_patch_file" >&2
    return 2
  fi

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
  if [ -n "$extra_patch_file" ]; then
    git -C "$HOMEBREW_PATCHED_OVERLAY" apply --check "$extra_patch_file" || return
    git -C "$HOMEBREW_PATCHED_OVERLAY" apply --whitespace=nowarn "$extra_patch_file" || return
  fi

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
