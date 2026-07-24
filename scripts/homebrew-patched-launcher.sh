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
HOMEBREW_PATCHED_OVERLAY_OWNER_UID=""
HOMEBREW_PATCHED_OVERLAY_SEAL_STATE=""
HOMEBREW_PATCHED_DEPENDENCY_PLAN=""
HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256=""
HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE=""
HOMEBREW_PATCHED_TIER2_ATTESTATION=""
HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256=""
HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE=""
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_PATH=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_BASENAME=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_LABEL=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_SHA256=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_STATE=()
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
HOMEBREW_PATCHED_NATIVE_PREFIX=""
HOMEBREW_PATCHED_NATIVE_CACHE=""
HOMEBREW_PATCHED_NATIVE_TEMP=""
HOMEBREW_PATCHED_NATIVE_CONFIG=""
HOMEBREW_PATCHED_NATIVE_HOME=""
HOMEBREW_PATCHED_NATIVE_BREW_BIN=""
HOMEBREW_PATCHED_NATIVE_RUNNER=""
HOMEBREW_PATCHED_NATIVE_SEALED=0
HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES=()
HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP=""
HOMEBREW_PATCHED_STAGED_INPUT_DIR=""
HOMEBREW_PATCHED_STAGED_INPUT_PATH=""

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

homebrew_patched_launcher_snapshot_target_cellar_layout() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_snapshot_target_cellar_layout: expected no arguments" >&2
    return 2
  fi
  local cellar="$HOMEBREW_PATCHED_PREFIX/Cellar" rack rack_name keg
  local -a entries=()
  if [ -z "$HOMEBREW_PATCHED_PREFIX" ] || [ ! -d "$cellar" ] || [ -L "$cellar" ]; then
    echo "homebrew-patched-launcher: target Cellar is unavailable" >&2
    return 2
  fi
  for rack in "$cellar"/*; do
    [ -e "$rack" ] || [ -L "$rack" ] || continue
    if [ ! -d "$rack" ] || [ -L "$rack" ]; then
      echo "homebrew-patched-launcher: target Cellar rack is not a real directory: $rack" >&2
      return 1
    fi
    rack_name="${rack##*/}"
    entries+=("rack:$rack_name")
    for keg in "$rack"/*; do
      [ -e "$keg" ] || [ -L "$keg" ] || continue
      if [ ! -d "$keg" ] || [ -L "$keg" ]; then
        echo "homebrew-patched-launcher: target Cellar keg is not a real directory: $keg" >&2
        return 1
      fi
      entries+=("keg:$rack_name/${keg##*/}")
    done
  done
  if [ "${#entries[@]}" -gt 0 ]; then
    printf '%s\n' "${entries[@]}" | LC_ALL=C sort
  fi
}

homebrew_patched_launcher_stage_control_file() {
  if [ "$#" -ne 5 ]; then
    echo "homebrew_patched_launcher_stage_control_file: expected KEY SOURCE BASENAME MAX_BYTES LABEL" >&2
    return 2
  fi
  local key="$1" source="$2" basename="$3" max_bytes="$4" label="$5"
  local destination source_state source_uid source_mode source_links bytes digest
  if [ -z "$HOMEBREW_PATCHED_PREFIX" ] || [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: stage the $label after preparation and before isolation" >&2
    return 2
  fi
  if ! [[ "$key" =~ ^[a-z][a-z0-9_]*$ ]] ||
     ! [[ "$basename" =~ ^\.[a-z0-9][a-z0-9._-]*\.json$ ]] ||
     ! [[ "$max_bytes" =~ ^[1-9][0-9]*$ ]]; then
    echo "homebrew-patched-launcher: invalid protected control-file declaration for $label" >&2
    return 2
  fi
  if [ -n "${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]:-}" ]; then
    echo "homebrew-patched-launcher: $label is already staged" >&2
    return 2
  fi
  if [ ! -f "$source" ] || [ -L "$source" ]; then
    echo "homebrew-patched-launcher: $label is not a private regular file" >&2
    return 2
  fi
  if source_state="$(stat -c '%u:%a:%h:%s' "$source" 2>/dev/null)"; then
    IFS=: read -r source_uid source_mode source_links bytes <<<"$source_state"
  else
    source_state="$(stat -f '%u:%Lp:%l:%z' "$source")" || return 2
    IFS=: read -r source_uid source_mode source_links bytes <<<"$source_state"
  fi
  if [ "$source_uid" != "$(id -u)" ] || [ "$source_links" != "1" ] ||
     ! [[ "$source_mode" =~ ^[0-7]{3,4}$ ]] ||
     [ $((8#$source_mode & 0077)) -ne 0 ]; then
    echo "homebrew-patched-launcher: $label is not a private regular file" >&2
    return 2
  fi
  if ! [[ "$bytes" =~ ^[1-9][0-9]*$ ]] || [ "$bytes" -gt "$max_bytes" ]; then
    echo "homebrew-patched-launcher: $label exceeds the size limit" >&2
    return 2
  fi
  destination="$HOMEBREW_PATCHED_PREFIX/$basename"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "homebrew-patched-launcher: $label destination already exists" >&2
    return 1
  fi
  HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]="$destination"
  HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]="$basename"
  HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]="$label"
  HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES[$key]="$max_bytes"
  HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]=""
  HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]="staging"
  if ! cp "$source" "$destination" || ! chmod 0444 "$destination" ||
     ! digest="$(homebrew_sha256_stream <"$destination")"; then
    echo "homebrew-patched-launcher: could not stage the $label" >&2
    homebrew_patched_launcher_remove_control_file "$key" || true
    return 1
  fi
  HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]="$digest"
  HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]="ready"
  if ! homebrew_patched_launcher_verify_control_file "$key"; then
    HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]="staging"
    homebrew_patched_launcher_remove_control_file "$key" || true
    return 1
  fi
}

homebrew_patched_launcher_verify_control_file() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_verify_control_file: expected KEY" >&2
    return 2
  fi
  local key="$1" path
  path="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]:-}"
  [ -n "$path" ] || return 0
  local label="${HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]}"
  local expected="$HOMEBREW_PATCHED_PREFIX/${HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]}"
  local max_bytes="${HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES[$key]}"
  local state prefix_uid actual_sha size
  if [ "${HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]:-}" != "ready" ] ||
     [ "$path" != "$expected" ] ||
     [ ! -f "$expected" ] || [ -L "$expected" ]; then
    echo "homebrew-patched-launcher: protected $label changed" >&2
    return 1
  fi
  if state="$(stat -c '%u:%a:%h:%s' "$expected" 2>/dev/null)"; then
    prefix_uid="$(stat -c '%u' "$HOMEBREW_PATCHED_PREFIX")"
  else
    state="$(stat -f '%u:%Lp:%l:%z' "$expected")"
    prefix_uid="$(stat -f '%u' "$HOMEBREW_PATCHED_PREFIX")"
  fi
  case "$state" in
    "$prefix_uid":444:1:*) ;;
    *)
      echo "homebrew-patched-launcher: protected $label ownership or mode is unsafe" >&2
      return 1
      ;;
  esac
  size="${state##*:}"
  if ! [[ "$size" =~ ^[1-9][0-9]*$ ]] || [ "$size" -gt "$max_bytes" ]; then
    echo "homebrew-patched-launcher: protected $label size changed" >&2
    return 1
  fi
  actual_sha="$(homebrew_sha256_stream <"$expected")"
  if [ -z "${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]:-}" ] ||
     [ "$actual_sha" != "${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]}" ]; then
    echo "homebrew-patched-launcher: protected $label content changed" >&2
    return 1
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
      /usr/bin/test -r "$expected" &&
      ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
        /usr/bin/test -w "$expected" || {
        echo "homebrew-patched-launcher: Formula identity has unsafe $label access" >&2
        return 1
      }
  fi
}

homebrew_patched_launcher_remove_control_file() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_remove_control_file: expected KEY" >&2
    return 2
  fi
  local key="$1" path
  path="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]:-}"
  [ -n "$path" ] || return 0
  local label="${HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]}"
  local expected="$HOMEBREW_PATCHED_PREFIX/${HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]}"
  if [ "${HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]:-}" = "staging" ]; then
    local destination_uid prefix_uid destination_links
    if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] || \
       [ "$path" != "$expected" ]; then
      echo "homebrew-patched-launcher: refusing to remove an unsafe partial $label" >&2
      return 1
    fi
    if [ -e "$expected" ] || [ -L "$expected" ]; then
      if [ ! -f "$expected" ] || [ -L "$expected" ]; then
        echo "homebrew-patched-launcher: partial $label is not a regular file" >&2
        return 1
      fi
      if destination_uid="$(stat -c '%u' "$expected" 2>/dev/null)"; then
        prefix_uid="$(stat -c '%u' "$HOMEBREW_PATCHED_PREFIX")"
        destination_links="$(stat -c '%h' "$expected")"
      else
        destination_uid="$(stat -f '%u' "$expected")"
        prefix_uid="$(stat -f '%u' "$HOMEBREW_PATCHED_PREFIX")"
        destination_links="$(stat -f '%l' "$expected")"
      fi
      if [ "$destination_uid" != "$prefix_uid" ] || [ "$destination_links" != "1" ]; then
        echo "homebrew-patched-launcher: partial $label ownership is unsafe" >&2
        return 1
      fi
      rm -f -- "$expected" || return
    fi
  else
    homebrew_patched_launcher_verify_control_file "$key" || return
    if [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -f -- "$path" || return
    else
      rm -f -- "$path" || return
    fi
  fi
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]'
}

homebrew_patched_launcher_seal_control_files() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_seal_control_files: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" key path label
  for key in "${!HOMEBREW_PATCHED_CONTROL_FILE_PATH[@]}"; do
    path="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]}"
    label="${HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]}"
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown root:root "$path" || return
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chmod 0444 "$path" || return
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$path")" = "0:0:444:1" ] &&
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- /usr/bin/test -r "$path" &&
      ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- /usr/bin/test -w "$path" || {
      echo "homebrew-patched-launcher: could not protect the $label" >&2
      return 1
    }
    homebrew_patched_launcher_verify_control_file "$key" || return
  done
}

homebrew_patched_launcher_stage_dependency_plan() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_stage_dependency_plan: expected PLAN" >&2
    return 2
  fi
  homebrew_patched_launcher_stage_control_file dependency_plan "$1" \
    .kandelo-publisher-build-dependencies.json 65536 "dependency plan" || return
  HOMEBREW_PATCHED_DEPENDENCY_PLAN="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[dependency_plan]}"
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256="${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[dependency_plan]}"
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE="${HOMEBREW_PATCHED_CONTROL_FILE_STATE[dependency_plan]}"
}

homebrew_patched_launcher_verify_dependency_plan() {
  homebrew_patched_launcher_verify_control_file dependency_plan
}

homebrew_patched_launcher_remove_dependency_plan() {
  homebrew_patched_launcher_remove_control_file dependency_plan || return
  HOMEBREW_PATCHED_DEPENDENCY_PLAN=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE=""
}

homebrew_patched_launcher_stage_tier2_attestation() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_stage_tier2_attestation: expected ATTESTATION" >&2
    return 2
  fi
  homebrew_patched_launcher_stage_control_file tier2_attestation "$1" \
    .kandelo-publisher-tier2-attestation.json 16384 "Tier-2 attestation" || return
  HOMEBREW_PATCHED_TIER2_ATTESTATION="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[tier2_attestation]}"
  HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256="${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[tier2_attestation]}"
  HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE="${HOMEBREW_PATCHED_CONTROL_FILE_STATE[tier2_attestation]}"
}

homebrew_patched_launcher_verify_tier2_attestation() {
  homebrew_patched_launcher_verify_control_file tier2_attestation
}

homebrew_patched_launcher_remove_tier2_attestation() {
  homebrew_patched_launcher_remove_control_file tier2_attestation || return
  HOMEBREW_PATCHED_TIER2_ATTESTATION=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE=""
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
    /usr/bin/find "$tree" -xdev \
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
  current="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- \
    /usr/bin/realpath -- "$current")" || {
    echo "homebrew-patched-launcher: could not resolve protected source: $current" >&2
    return 2
  }
  while [ "$current" != "/" ]; do
    parent="$(dirname "$current")"
    if "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$parent"; then
      mode="$(/usr/bin/stat -c '%a' "$parent")"
      current_uid="$(/usr/bin/stat -c '%u' "$current")"
      parent_uid="$(/usr/bin/stat -c '%u' "$parent")"
      if [ $((8#$mode & 01000)) -eq 0 ] || \
         [ "$current_uid" = "$user_uid" ] || [ "$parent_uid" = "$user_uid" ]; then
        echo "homebrew-patched-launcher: build user can replace protected source: $current" >&2
        return 1
      fi
    fi
    current="$parent"
  done
}

homebrew_assert_tree_symlinks_contained() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_assert_tree_symlinks_contained: expected TREE LABEL" >&2
    return 2
  fi
  local tree="$1" label="$2" physical_tree unsafe_entry
  physical_tree="$(cd "$tree" && pwd -P)" || {
    echo "homebrew-patched-launcher: could not resolve protected $label tree" >&2
    return 2
  }
  unsafe_entry="$(/usr/bin/find "$physical_tree" -xdev \
    ! \( -type d -o -type f -o -type l \) -print -quit)" || return 2
  [ -z "$unsafe_entry" ] || {
    echo "homebrew-patched-launcher: protected $label contains a special entry: $unsafe_entry" >&2
    return 1
  }
  if ! /usr/bin/find "$physical_tree" -xdev -type l \
       -exec /usr/bin/bash -c '
         set -euo pipefail
         root="$1"
         label="$2"
         shift 2
         for link in "$@"; do
           raw_target="$(/usr/bin/readlink -- "$link")" || exit 1
           case "$raw_target" in
             /*) lexical_input="$raw_target" ;;
             *) lexical_input="${link%/*}/$raw_target" ;;
           esac
           lexical_target="$(/usr/bin/realpath -m -s -- "$lexical_input")" || exit 1
           case "$lexical_target" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: protected %s symlink crosses its tree: %s\n" \
                 "$label" "$link" >&2
               exit 1
               ;;
           esac
           resolved="$(/usr/bin/realpath -- "$link")" || {
             printf "homebrew-patched-launcher: protected %s symlink is unresolved: %s\n" \
               "$label" "$link" >&2
             exit 1
           }
           case "$resolved" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: protected %s symlink escapes its tree: %s\n" \
                 "$label" "$link" >&2
               exit 1
               ;;
           esac
         done
       ' kandelo-protected-tree "$physical_tree" "$label" {} +; then
    echo "homebrew-patched-launcher: protected $label symlink validation failed" >&2
    return 1
  fi
}

homebrew_patched_launcher_emit_sysroot_access_audit() {
  cat <<'EOF'
if ! sysroot_access_violation="$(/usr/bin/find "$expected_sysroot" -xdev \( -writable -o ! -readable -o \( -type d ! -executable \) \) -print -quit)"; then
  echo "homebrew-patched-launcher: could not inspect the protected sysroot alias" >&2
  exit 2
fi
if [ -n "$sysroot_access_violation" ]; then
  echo "homebrew-patched-launcher: protected sysroot alias has unsafe access: $sysroot_access_violation" >&2
  exit 1
fi
EOF
}

homebrew_patched_launcher_verify_overlay_seal() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_verify_overlay_seal: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" unsafe_entry
  if [ "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" != "sealed" ] || \
     [ -z "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" ] || \
     [ ! -d "$HOMEBREW_PATCHED_OVERLAY" ] || \
     [ -L "$HOMEBREW_PATCHED_OVERLAY" ]; then
    echo "homebrew-patched-launcher: patched Homebrew overlay is not sealed" >&2
    return 1
  fi
  unsafe_entry="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
    "$HOMEBREW_PATCHED_OVERLAY" -xdev \
    \( ! -uid "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" -o \
       ! \( -type d -o -type f -o -type l \) -o \
       \( -type f -links +1 \) -o \
       \( -type d ! -perm 0555 \) -o \
       \( -type f \( ! -perm -0444 -o -perm /0222 -o -perm /07000 \) \) \
    \) -print -quit)" || {
    echo "homebrew-patched-launcher: could not inspect the sealed Homebrew overlay" >&2
    return 2
  }
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-patched-launcher: sealed Homebrew overlay entry is unsafe: $unsafe_entry" >&2
    return 1
  fi
  homebrew_patched_launcher_assert_overlay_symlinks_contained || return
  homebrew_assert_tree_not_writable_by_user \
    "$build_user" "$HOMEBREW_PATCHED_OVERLAY" || return
  homebrew_assert_tree_not_replaceable_by_user \
    "$build_user" "$HOMEBREW_PATCHED_OVERLAY" || return
}

homebrew_patched_launcher_assert_overlay_symlinks_contained() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_assert_overlay_symlinks_contained: expected no arguments" >&2
    return 2
  fi
  local physical_overlay
  physical_overlay="$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" || {
    echo "homebrew-patched-launcher: could not resolve the Homebrew overlay" >&2
    return 2
  }
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type l \
       -exec /usr/bin/bash -c '
         root="$1"
         shift
         for link in "$@"; do
           raw_target="$(/usr/bin/readlink -- "$link")" || {
             printf "homebrew-patched-launcher: overlay symlink cannot be read: %s\\n" "$link" >&2
             exit 1
           }
           case "$raw_target" in
             /*) lexical_input="$raw_target" ;;
             *) lexical_input="${link%/*}/$raw_target" ;;
           esac
           lexical_target="$(/usr/bin/realpath -m -s -- "$lexical_input")" || {
             printf "homebrew-patched-launcher: overlay symlink target cannot be normalized: %s\\n" "$link" >&2
             exit 1
           }
           case "$lexical_target" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: overlay symlink crosses its worktree: %s\\n" "$link" >&2
               exit 1
               ;;
           esac
           resolved="$(/usr/bin/realpath -- "$link")" || {
             printf "homebrew-patched-launcher: overlay symlink is unresolved: %s\\n" "$link" >&2
             exit 1
           }
           case "$resolved" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: overlay symlink escapes its worktree: %s\\n" "$link" >&2
               exit 1
               ;;
           esac
         done
       ' bash "$physical_overlay" {} +; then
    echo "homebrew-patched-launcher: Homebrew overlay symlink validation failed" >&2
    return 1
  fi
}

homebrew_patched_launcher_seal_overlay() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_seal_overlay: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" unsafe_entry
  if [ -n "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" ] || \
     [ -z "$HOMEBREW_PATCHED_SUDO_BIN" ] || \
     [ ! -d "$HOMEBREW_PATCHED_OVERLAY" ] || \
     [ -L "$HOMEBREW_PATCHED_OVERLAY" ]; then
    echo "homebrew-patched-launcher: patched Homebrew overlay cannot be sealed" >&2
    return 2
  fi
  HOMEBREW_PATCHED_OVERLAY_OWNER_UID="$(/usr/bin/id -u)"
  if [ "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" = \
       "$(/usr/bin/id -u "$build_user")" ]; then
    echo "homebrew-patched-launcher: overlay owner must differ from the build user" >&2
    return 2
  fi
  unsafe_entry="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
    "$HOMEBREW_PATCHED_OVERLAY" -xdev \
    \( ! -uid "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" -o \
       ! \( -type d -o -type f -o -type l \) -o \
       \( -type f -links +1 \) \) -print -quit)" || {
    echo "homebrew-patched-launcher: could not inspect the Homebrew overlay before sealing" >&2
    return 2
  }
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-patched-launcher: Homebrew overlay entry cannot be sealed: $unsafe_entry" >&2
    return 1
  fi
  homebrew_patched_launcher_assert_overlay_symlinks_contained || return

  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealing"
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type d \
       -exec /usr/bin/chmod 0555 {} + || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type f -perm /0111 \
       -exec /usr/bin/chmod 0555 {} + || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type f ! -perm /0111 \
       -exec /usr/bin/chmod 0444 {} +; then
    echo "homebrew-patched-launcher: could not seal the Homebrew overlay" >&2
    return 1
  fi
  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealed"
  homebrew_patched_launcher_verify_overlay_seal "$build_user"
}

homebrew_patched_launcher_restore_overlay_for_cleanup() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_restore_overlay_for_cleanup: expected no arguments" >&2
    return 2
  fi
  case "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" in
    "") return 0 ;;
    cleanup-ready) return 0 ;;
    sealing|sealed) ;;
    *)
      echo "homebrew-patched-launcher: Homebrew overlay seal state is invalid" >&2
      return 2
      ;;
  esac
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] && \
     [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" != "1" ]; then
    echo "homebrew-patched-launcher: refusing to restore the overlay before Formula process teardown" >&2
    return 1
  fi
  if [ ! -d "$HOMEBREW_PATCHED_OVERLAY" ] || [ -L "$HOMEBREW_PATCHED_OVERLAY" ] || \
     [ "$(/usr/bin/stat -c '%u' "$HOMEBREW_PATCHED_OVERLAY")" != \
       "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" ]; then
    echo "homebrew-patched-launcher: refusing to restore a changed Homebrew overlay" >&2
    return 1
  fi
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type d \
       -exec /usr/bin/chmod u+rwx {} + || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type f \
       -exec /usr/bin/chmod u+rw {} +; then
    echo "homebrew-patched-launcher: could not restore the Homebrew overlay for cleanup" >&2
    return 1
  fi
  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="cleanup-ready"
}

homebrew_patched_launcher_worktree_registration_status() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_patched_launcher_worktree_registration_status: expected REPO WORKTREE" >&2
    return 2
  fi
  local repo="$1" worktree="$2" listing line
  listing="$(git -C "$repo" worktree list --porcelain)" || {
    echo "homebrew-patched-launcher: could not inspect Homebrew worktree registrations" >&2
    return 2
  }
  while IFS= read -r line; do
    [ "$line" = "worktree $worktree" ] && return 0
  done <<<"$listing"
  return 1
}

homebrew_patched_launcher_git_version_is_supported() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_git_version_is_supported: expected VERSION" >&2
    return 2
  fi
  local version="$1" major minor
  if ! [[ "$version" =~ ^git\ version\ ([0-9]+)\.([0-9]+)(\.[0-9]+)*([.+-][^[:space:]]+)?$ ]]; then
    return 1
  fi
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 7 ]; }
}

# Keep Homebrew's host-side repository and trust operations on the declared
# dev-shell Git even after a target Formula installs a Wasm `git` into the
# selected Homebrew prefix. Homebrew preserves HOMEBREW_* variables when its
# launcher resets PATH and gives this documented absolute override precedence
# over the brewed Git shim.
homebrew_patched_launcher_select_host_git() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_select_host_git: expected no arguments" >&2
    return 2
  fi
  local git_path git_version git_root
  unset HOMEBREW_GIT_PATH
  git_path="$(command -v git || true)"
  git_root="${git_path%/bin/git}"
  git_version="$("$git_path" --version 2>/dev/null || true)"
  git_version="${git_version%%$'\n'*}"
  if ! [[ "$git_path" =~ ^/nix/store/[0-9a-z]{32}-git-[^/]+/bin/git$ ]] ||
     [ ! -f "$git_path" ] || [ -L "$git_path" ] || [ ! -x "$git_path" ] ||
     [ -w "$git_path" ] || [ -w "${git_path%/*}" ] || [ -w "$git_root" ] ||
     ! homebrew_patched_launcher_git_version_is_supported "$git_version"; then
    echo "homebrew-patched-launcher: dev shell does not provide protected Nix Git 2.7.0 or newer" >&2
    return 2
  fi
  HOMEBREW_GIT_PATH="$git_path"
  export HOMEBREW_GIT_PATH
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
  resolved="$(/usr/bin/readlink -f -- "$path" 2>/dev/null || true)"
  if [ -L "$path" ]; then
    parent="${path%/*}"
    parent_mode="$(/usr/bin/stat -c '%a' "$parent" 2>/dev/null || true)"
    if [ -z "$symlink_target" ] || [ "$resolved" != "$symlink_target" ] || \
       [ "$(/usr/bin/stat -c '%u' "$path" 2>/dev/null || true)" != "0" ] || \
       [ "$(/usr/bin/stat -c '%u' "$parent" 2>/dev/null || true)" != "0" ] || \
       ! [[ "$parent_mode" =~ ^[0-7]{3,4}$ ]] || \
       [ $((8#$parent_mode & 0022)) -ne 0 ] || \
       "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$parent"; then
      echo "homebrew-patched-launcher: $label symlink is not protected" >&2
      return 2
    fi
  elif [ -n "$symlink_target" ] && [ "$resolved" != "$path" ]; then
    echo "homebrew-patched-launcher: $label resolves outside $expected" >&2
    return 2
  fi
  mode="$(/usr/bin/stat -Lc '%a' "$resolved" 2>/dev/null || true)"
  if [ ! -f "$resolved" ] || [ ! -x "$resolved" ] || \
     [ "$(/usr/bin/stat -Lc '%u' "$resolved" 2>/dev/null || true)" != "0" ] || \
     ! [[ "$mode" =~ ^[0-7]{3,4}$ ]] || [ $((8#$mode & 0022)) -ne 0 ]; then
    echo "homebrew-patched-launcher: $label must be the protected $expected" >&2
    return 2
  fi
  if "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$path"; then
    echo "homebrew-patched-launcher: build user can replace $label" >&2
    return 2
  fi
}

homebrew_patched_launcher_remove_native_bridges() {
  local formula target_cellar target_opt native_rack native_opt native_opt_target
  local native_version target_rack target_keg target_opt_link expected_opt_target
  local rack_present opt_present rack_state formula_status status=0
  local -a remaining_bridges=()
  [ -n "$HOMEBREW_PATCHED_PREFIX" ] || return 0
  target_cellar="$HOMEBREW_PATCHED_PREFIX/Cellar"
  target_opt="$HOMEBREW_PATCHED_PREFIX/opt"
  for formula in "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}"; do
    formula_status=0
    rack_present=0
    opt_present=0
    native_rack="$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar/$formula"
    native_opt="$HOMEBREW_PATCHED_NATIVE_PREFIX/opt/$formula"
    native_opt_target="$(cd "$native_opt" && pwd -P)" || formula_status=1
    if [ "$formula_status" -eq 0 ] && \
       [ "${native_opt_target%/*}" != "$native_rack" ]; then
      echo "homebrew-patched-launcher: native Formula opt link changed before bridge cleanup: $formula" >&2
      formula_status=1
    fi
    native_version="${native_opt_target##*/}"
    target_rack="$target_cellar/$formula"
    target_keg="$target_rack/$native_version"
    target_opt_link="$target_opt/$formula"
    expected_opt_target="../Cellar/$formula/$native_version"

    if [ -e "$target_rack" ] || [ -L "$target_rack" ]; then
      if [ -d "$target_rack" ] && [ ! -L "$target_rack" ]; then
        rack_present=1
      else
        echo "homebrew-patched-launcher: refusing to remove changed native Formula rack: $target_rack" >&2
        formula_status=1
      fi
    fi
    if [ -e "$target_opt_link" ] || [ -L "$target_opt_link" ]; then
      if [ -L "$target_opt_link" ] && \
         [ "$(/usr/bin/readlink "$target_opt_link")" = "$expected_opt_target" ]; then
        opt_present=1
      else
        echo "homebrew-patched-launcher: refusing to remove changed native Formula opt bridge: $target_opt_link" >&2
        formula_status=1
      fi
    fi
    if [ "$rack_present" -eq 1 ] && [ "$opt_present" -eq 1 ] && \
       { [ ! -d "$target_keg" ] || [ -L "$target_keg" ] || \
         [ "$(cd "$target_keg" && pwd -P)" != "$target_keg" ]; }; then
      echo "homebrew-patched-launcher: refusing to remove changed native Formula keg: $target_keg" >&2
      formula_status=1
    fi
    if [ "$rack_present" -eq 1 ] && [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
      rack_state="$(/usr/bin/stat -c '%u:%g:%a' "$target_rack")"
      case "$rack_state:$opt_present" in
        0:0:700:0)
          if "$HOMEBREW_PATCHED_SUDO_BIN" -n -H \
               -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
               /usr/bin/test -r "$target_rack" || \
             "$HOMEBREW_PATCHED_SUDO_BIN" -n -H \
               -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
               /usr/bin/test -w "$target_rack" || \
             "$HOMEBREW_PATCHED_SUDO_BIN" -n -H \
               -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
               /usr/bin/test -x "$target_rack"; then
            echo "homebrew-patched-launcher: build user can access partial native Formula proxy: $target_rack" >&2
            formula_status=1
          fi
          ;;
        0:0:555:0|0:0:555:1) ;;
        *)
          echo "homebrew-patched-launcher: refusing to remove changed native Formula proxy: $target_rack" >&2
          formula_status=1
          ;;
      esac
      if [ "$formula_status" -eq 0 ]; then
        if [ "$rack_state" != "0:0:700" ]; then
          homebrew_assert_tree_not_writable_by_user \
            "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" || formula_status=1
        fi
        if [ "$formula_status" -eq 0 ]; then
          homebrew_assert_tree_not_replaceable_by_user \
            "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" || formula_status=1
        fi
      fi
    fi

    if [ "$formula_status" -eq 0 ] && [ "$opt_present" -eq 1 ]; then
      if [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
        "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -f -- \
          "$target_opt_link" || formula_status=1
      else
        rm -f -- "$target_opt_link" || formula_status=1
      fi
    fi
    if [ "$formula_status" -eq 0 ] && [ "$rack_present" -eq 1 ]; then
      if [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
        "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -rf -- \
          "$target_rack" || formula_status=1
      else
        find "$target_rack" -type d -exec chmod u+w {} + && \
          rm -rf -- "$target_rack" || formula_status=1
      fi
    fi
    if [ "$formula_status" -ne 0 ]; then
      remaining_bridges+=("$formula")
      status=1
    fi
  done
  HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES=("${remaining_bridges[@]}")
  return "$status"
}

homebrew_patched_launcher_cleanup() {
  local teardown_status worktree_registration_status
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] && \
     [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" != "1" ]; then
    if homebrew_patched_launcher_teardown "$HOMEBREW_PATCHED_BUILD_USER" \
      >/dev/null; then
      :
    else
      teardown_status="$?"
      echo "homebrew-patched-launcher: Formula process teardown failed; preserving launcher state for retry" >&2
      return "$teardown_status"
    fi
  fi
  if ! homebrew_patched_launcher_remove_staged_input; then
    echo "homebrew-patched-launcher: protected input remains; preserving launcher state for retry" >&2
    return 1
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] && \
     [ "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" = "sealed" ]; then
    if ! homebrew_patched_launcher_verify_overlay_seal \
         "$HOMEBREW_PATCHED_BUILD_USER" || \
       [ -z "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ] || \
       [ "$(homebrew_patched_launcher_integrity)" != \
         "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ]; then
      echo "homebrew-patched-launcher: patched Homebrew overlay changed; preserving launcher state for inspection" >&2
      return 1
    fi
  fi
  if ! homebrew_patched_launcher_remove_native_bridges; then
    echo "homebrew-patched-launcher: native Formula bridges remain; preserving launcher state for retry" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_remove_dependency_plan; then
    echo "homebrew-patched-launcher: protected dependency plan changed; preserving launcher state for retry" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_remove_tier2_attestation; then
    echo "homebrew-patched-launcher: protected Tier-2 attestation changed; preserving launcher state for retry" >&2
    return 1
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
  if ! homebrew_patched_launcher_restore_overlay_for_cleanup; then
    echo "homebrew-patched-launcher: sealed Homebrew overlay could not be restored; preserving launcher state for retry" >&2
    return 1
  fi
  if [ -n "$HOMEBREW_PATCHED_REPO" ] && \
     [ -n "$HOMEBREW_PATCHED_OVERLAY" ]; then
    if homebrew_patched_launcher_worktree_registration_status \
         "$HOMEBREW_PATCHED_REPO" "$HOMEBREW_PATCHED_OVERLAY"; then
      worktree_registration_status=0
    else
      worktree_registration_status="$?"
    fi
    if [ "$worktree_registration_status" -eq 2 ]; then
      echo "homebrew-patched-launcher: Homebrew overlay registration could not be verified; preserving launcher state for retry" >&2
      return 1
    fi
    if [ -d "$HOMEBREW_PATCHED_OVERLAY" ] || \
       [ "$worktree_registration_status" -eq 0 ]; then
      if ! git -C "$HOMEBREW_PATCHED_REPO" worktree remove --force \
           "$HOMEBREW_PATCHED_OVERLAY" >/dev/null 2>&1; then
        echo "homebrew-patched-launcher: Homebrew overlay removal failed; preserving launcher state for retry" >&2
        return 1
      fi
    fi
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
  HOMEBREW_PATCHED_INTEGRITY_SHA256=""
  HOMEBREW_PATCHED_OVERLAY_OWNER_UID=""
  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE=""
  HOMEBREW_PATCHED_CONTROL_FILE_PATH=()
  HOMEBREW_PATCHED_CONTROL_FILE_BASENAME=()
  HOMEBREW_PATCHED_CONTROL_FILE_LABEL=()
  HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES=()
  HOMEBREW_PATCHED_CONTROL_FILE_SHA256=()
  HOMEBREW_PATCHED_CONTROL_FILE_STATE=()
  HOMEBREW_PATCHED_NATIVE_PREFIX=""
  HOMEBREW_PATCHED_NATIVE_CACHE=""
  HOMEBREW_PATCHED_NATIVE_TEMP=""
  HOMEBREW_PATCHED_NATIVE_CONFIG=""
  HOMEBREW_PATCHED_NATIVE_HOME=""
  HOMEBREW_PATCHED_NATIVE_BREW_BIN=""
  HOMEBREW_PATCHED_NATIVE_RUNNER=""
  HOMEBREW_PATCHED_NATIVE_SEALED=0
  HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES=()
  HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP=""
  HOMEBREW_PATCHED_STAGED_INPUT_DIR=""
  HOMEBREW_PATCHED_STAGED_INPUT_PATH=""
  HOMEBREW_PATCHED_REPO=""
  HOMEBREW_PATCHED_PREFIX=""
  HOMEBREW_PATCHED_BREW_BIN=""
  HOMEBREW_PATCHED_OVERLAY=""
  HOMEBREW_PATCHED_LAUNCHER=""
}

# Return a child of BASE whose byte length exactly matches Linuxbrew's bottle
# prefix. Homebrew's fixed-prefix binary relocation pads shorter replacements
# with NUL bytes; some runtimes (notably Perl) expose those bytes through their
# compiled search paths instead of treating them as harmless string padding.
homebrew_patched_launcher_native_prefix_path() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_native_prefix_path: expected BASE" >&2
    return 2
  fi
  local base realpath_bin bottle_prefix=/home/linuxbrew/.linuxbrew
  local base_bytes bottle_prefix_bytes suffix_bytes suffix
  realpath_bin="$(command -v realpath || true)"
  [ -n "$realpath_bin" ] && [ -x "$realpath_bin" ] || {
    echo "homebrew-patched-launcher: realpath is required to select the native prefix" >&2
    return 2
  }
  base="$("$realpath_bin" -m -- "$1")" || return 2
  base_bytes="$(LC_ALL=C printf '%s' "$base" | wc -c | tr -d '[:space:]')"
  bottle_prefix_bytes="$(LC_ALL=C printf '%s' "$bottle_prefix" | wc -c | tr -d '[:space:]')"
  suffix_bytes=$((bottle_prefix_bytes - base_bytes - 1))
  if [ "$suffix_bytes" -lt 1 ]; then
    echo "homebrew-patched-launcher: native prefix base leaves no room for an exact Linuxbrew relocation path: $base" >&2
    return 2
  fi
  printf -v suffix '%*s' "$suffix_bytes" ''
  suffix="${suffix// /p}"
  printf '%s/%s\n' "$base" "$suffix"
}

# Give native Homebrew its own prefix while reusing the exact reviewed source
# overlay. Host Formulae and their recursive closure never occupy the target
# Cellar, so a native dependency may share a short name with the Kandelo target.
homebrew_patched_launcher_prepare_native_prefix() {
  if [ "$#" -ne 5 ]; then
    echo "homebrew_patched_launcher_prepare_native_prefix: expected PREFIX CACHE TEMP CONFIG HOME" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_OVERLAY" ] || [ -z "$HOMEBREW_PATCHED_PREFIX" ]; then
    echo "homebrew-patched-launcher: prepare the reviewed Homebrew overlay first" >&2
    return 2
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: cannot prepare the native prefix after isolation" >&2
    return 2
  fi

  local native_prefix="$1" native_cache="$2" native_temp="$3" native_config="$4"
  local native_home="$5"
  local path other native_brew reported_prefix reported_repo realpath_bin i j
  local native_prefix_bytes native_cellar_bytes
  local bottle_prefix_bytes bottle_cellar_bytes
  local -a native_inputs native_roots target_inputs target_roots
  realpath_bin="$(command -v realpath || true)"
  [ -n "$realpath_bin" ] && [ -x "$realpath_bin" ] || {
    echo "homebrew-patched-launcher: realpath is required to validate native roots" >&2
    return 2
  }
  native_inputs=("$native_prefix" "$native_cache" "$native_temp" "$native_config" "$native_home")
  for path in "${native_inputs[@]}"; do
    if [ -e "$path" ] && { [ ! -d "$path" ] || [ -L "$path" ]; }; then
      echo "homebrew-patched-launcher: native Homebrew root is not a real directory: $path" >&2
      return 2
    fi
    case "$path" in
      *:*)
        echo "homebrew-patched-launcher: native Homebrew root cannot contain ':' for a systemd bind: $path" >&2
        return 2
        ;;
    esac
    path="$("$realpath_bin" -m -- "$path")" || return 2
    [ "$path" != / ] || {
      echo "homebrew-patched-launcher: native Homebrew root cannot be /" >&2
      return 2
    }
    native_roots+=("$path")
  done

  target_inputs=(
    "$HOMEBREW_PATCHED_PREFIX"
    "$HOMEBREW_CACHE"
    "$HOMEBREW_TEMP"
    "$XDG_CONFIG_HOME"
  )
  for other in "${target_inputs[@]}"; do
    [ -n "$other" ] || continue
    target_roots+=("$("$realpath_bin" -m -- "$other")") || return 2
  done
  for ((i = 0; i < ${#native_roots[@]}; i++)); do
    path="${native_roots[$i]}"
    for ((j = i + 1; j < ${#native_roots[@]}; j++)); do
      other="${native_roots[$j]}"
      if [ "$path" = "$other" ]; then
        echo "homebrew-patched-launcher: native Homebrew roots must differ: $path" >&2
        return 2
      fi
      case "$path/" in
        "$other/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $other -> $path" >&2
          return 2
          ;;
      esac
      case "$other/" in
        "$path/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $path -> $other" >&2
          return 2
          ;;
      esac
    done
    for other in "${target_roots[@]}"; do
      [ -n "$other" ] || continue
      if [ "$path" = "$other" ]; then
        echo "homebrew-patched-launcher: native and target Homebrew roots must differ: $path" >&2
        return 2
      fi
      case "$path/" in
        "$other/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $other -> $path" >&2
          return 2
          ;;
      esac
      case "$other/" in
        "$path/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $path -> $other" >&2
          return 2
          ;;
      esac
    done
  done
  # A shorter binary replacement is NUL-padded by Homebrew. That is acceptable
  # for many native tools but corrupts compiled path arrays in runtimes such as
  # Perl, which then surface the padding as part of @INC. Use the exact build
  # prefix length so native bottles need neither padding nor truncation.
  native_prefix_bytes="$(LC_ALL=C printf '%s' "${native_roots[0]}" | wc -c | tr -d '[:space:]')"
  native_cellar_bytes="$(LC_ALL=C printf '%s' "${native_roots[0]}/Cellar" | wc -c | tr -d '[:space:]')"
  bottle_prefix_bytes="$(LC_ALL=C printf '%s' /home/linuxbrew/.linuxbrew | wc -c | tr -d '[:space:]')"
  bottle_cellar_bytes="$(LC_ALL=C printf '%s' /home/linuxbrew/.linuxbrew/Cellar | wc -c | tr -d '[:space:]')"
  if [ "$native_prefix_bytes" -ne "$bottle_prefix_bytes" ] ||
     [ "$native_cellar_bytes" -ne "$bottle_cellar_bytes" ]; then
    echo "homebrew-patched-launcher: native prefix must exactly match fixed-prefix Linuxbrew bottle path lengths: ${native_roots[0]}" >&2
    return 2
  fi
  for path in "${native_roots[@]}"; do
    mkdir -p "$path"
    [ -d "$path" ] && [ ! -L "$path" ] || {
      echo "homebrew-patched-launcher: native Homebrew root changed during preparation: $path" >&2
      return 2
    }
    chmod 0700 "$path"
  done
  HOMEBREW_PATCHED_NATIVE_PREFIX="${native_roots[0]}"
  HOMEBREW_PATCHED_NATIVE_CACHE="${native_roots[1]}"
  HOMEBREW_PATCHED_NATIVE_TEMP="${native_roots[2]}"
  HOMEBREW_PATCHED_NATIVE_CONFIG="${native_roots[3]}"
  HOMEBREW_PATCHED_NATIVE_HOME="${native_roots[4]}"
  mkdir -p "$HOMEBREW_PATCHED_NATIVE_PREFIX/bin"
  native_brew="$HOMEBREW_PATCHED_NATIVE_PREFIX/bin/brew"
  [ ! -e "$native_brew" ] && [ ! -L "$native_brew" ] || {
    echo "homebrew-patched-launcher: native Homebrew launcher already exists" >&2
    return 2
  }
  ln -s "$HOMEBREW_PATCHED_OVERLAY/bin/brew" "$native_brew"
  HOMEBREW_PATCHED_NATIVE_BREW_BIN="$native_brew"

  reported_prefix="$(
    unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG \
      HOMEBREW_KANDELO_PRIMARY_TAP_ROOT
    HOME="$HOMEBREW_PATCHED_NATIVE_HOME" \
      XDG_CONFIG_HOME="$HOMEBREW_PATCHED_NATIVE_CONFIG" \
      HOMEBREW_CACHE="$HOMEBREW_PATCHED_NATIVE_CACHE" \
      HOMEBREW_TEMP="$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$native_brew" --prefix
  )" || return
  reported_repo="$(
    unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG
    HOME="$HOMEBREW_PATCHED_NATIVE_HOME" \
      XDG_CONFIG_HOME="$HOMEBREW_PATCHED_NATIVE_CONFIG" \
      HOMEBREW_CACHE="$HOMEBREW_PATCHED_NATIVE_CACHE" \
      HOMEBREW_TEMP="$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$native_brew" --repository
  )" || return
  if [ "$reported_prefix" != "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    echo "homebrew-patched-launcher: native Homebrew reported the wrong prefix" >&2
    return 1
  fi
  if [ "$(cd "$reported_repo" && pwd -P)" != "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ]; then
    echo "homebrew-patched-launcher: native Homebrew did not use the reviewed overlay" >&2
    return 1
  fi
}

homebrew_patched_launcher_run_native() {
  if [ "$#" -eq 0 ]; then
    echo "homebrew_patched_launcher_run_native: expected a Homebrew command" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ]; then
    echo "homebrew-patched-launcher: native Homebrew is not prepared" >&2
    return 2
  fi
  if [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ]; then
    echo "homebrew-patched-launcher: native Homebrew is sealed" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    [ "${GITHUB_ACTIONS:-}" != "true" ] || {
      echo "homebrew-patched-launcher: CI native Formula execution requires isolation" >&2
      return 2
    }
    (
      unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG \
        HOMEBREW_KANDELO_PRIMARY_TAP_ROOT
      HOME="$HOMEBREW_PATCHED_NATIVE_HOME" \
        XDG_CONFIG_HOME="$HOMEBREW_PATCHED_NATIVE_CONFIG" \
        HOMEBREW_CACHE="$HOMEBREW_PATCHED_NATIVE_CACHE" \
        HOMEBREW_TEMP="$HOMEBREW_PATCHED_NATIVE_TEMP" \
        HOMEBREW_RELOCATE_BUILD_PREFIX=1 \
        "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" "$@"
    )
    return
  fi
  [ -n "$HOMEBREW_PATCHED_NATIVE_RUNNER" ] || {
    echo "homebrew-patched-launcher: isolated native Homebrew runner is unavailable" >&2
    return 2
  }
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_NATIVE_RUNNER" "$@"
}

homebrew_patched_launcher_seal_native_prefix() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_seal_native_prefix: expected no arguments" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] || [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ]; then
    echo "homebrew-patched-launcher: native Homebrew is unavailable or already sealed" >&2
    return 2
  fi
  local unsafe_entry status
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    if homebrew_patched_launcher_uid_has_processes; then
      echo "homebrew-patched-launcher: native Formula process survived before sealing" >&2
      return 1
    else
      status="$?"
      [ "$status" -eq 1 ] || return "$status"
    fi
    unsafe_entry="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev \
      ! \( -type d -o -type f -o -type l \) -print -quit)" || return 2
    [ -z "$unsafe_entry" ] || {
      echo "homebrew-patched-launcher: native Homebrew contains a special entry: $unsafe_entry" >&2
      return 1
    }
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev -type l \
      -exec /usr/bin/bash -c '
        set -euo pipefail
        native_prefix="$1"
        native_brew="$2"
        overlay_brew="$3"
        shift 3
        for link; do
          target="$(/usr/bin/readlink "$link")"
          if [ "$link" = "$native_brew" ] && [ "$target" = "$overlay_brew" ]; then
            continue
          fi
          if [[ "$target" = /* ]]; then
            resolved="$(/usr/bin/realpath -m -- "$target")"
          else
            resolved="$(/usr/bin/realpath -m -- "${link%/*}/$target")"
          fi
          case "$resolved" in
            "$native_prefix"|"$native_prefix"/*|/bin/*|/etc/ssl/*|/lib/*|/lib64/*|/usr/*) ;;
            *)
              echo "homebrew-patched-launcher: native Homebrew symlink escapes protected roots: $link -> $target" >&2
              exit 1
              ;;
          esac
        done
      ' kandelo-native-link-audit \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" \
      "$HOMEBREW_PATCHED_OVERLAY/bin/brew" {} + || return 1
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown -hR root:root \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX"
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev -type d -exec /usr/bin/chmod 0555 {} +
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev -type f \
      -exec /usr/bin/chmod a-w,u-s,g-s {} +
    homebrew_assert_tree_not_writable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"
    homebrew_assert_tree_not_replaceable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"
  fi
  HOMEBREW_PATCHED_NATIVE_SEALED=1
}

# Preserve relative links from a direct native Formula into its recursive
# closure without copying that closure into the target Cellar. The source
# prefix has already been sealed root-owned and read-only, so an absolute link
# to the exact resolved source is stable for the remainder of Formula execution.
homebrew_patched_launcher_rewrite_native_bridge_links() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_patched_launcher_rewrite_native_bridge_links: expected NATIVE_KEG TARGET_KEG" >&2
    return 2
  fi
  local native_keg="$1" target_keg="$2"
  local rewrite_bash rewrite_find rewrite_ln rewrite_readlink rewrite_realpath rewrite_rm
  local rewrite_script
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    rewrite_bash=/usr/bin/bash
    rewrite_find=/usr/bin/find
    rewrite_ln=/usr/bin/ln
    rewrite_readlink=/usr/bin/readlink
    rewrite_realpath=/usr/bin/realpath
    rewrite_rm=/usr/bin/rm
  else
    rewrite_bash="$(command -v bash)"
    rewrite_find="$(command -v find)"
    rewrite_ln="$(command -v ln)"
    rewrite_readlink="$(command -v readlink)"
    rewrite_realpath="$(command -v realpath)"
    rewrite_rm="$(command -v rm)"
  fi
  rewrite_script='
    set -euo pipefail
    native_keg="$1"
    target_keg="$2"
    native_prefix="$3"
    find_bin="$4"
    ln_bin="$5"
    readlink_bin="$6"
    realpath_bin="$7"
    rm_bin="$8"
    while IFS= read -r -d "" link; do
      target="$("$readlink_bin" "$link")"
      [[ "$target" != /* ]] || continue
      resolved="$("$realpath_bin" -m -- "${link%/*}/$target")"
      case "$resolved" in
        "$native_keg"|"$native_keg"/*) continue ;;
        "$native_prefix"|"$native_prefix"/*)
          [ -e "$resolved" ] || {
            echo "homebrew-patched-launcher: native Formula cross-keg link is unresolved: $link -> $target" >&2
            exit 1
          }
          ;;
        *)
          echo "homebrew-patched-launcher: native Formula cross-keg link escaped after validation: $link -> $target" >&2
          exit 1
          ;;
      esac
      case "$link" in
        "$native_keg"/*) relative="${link#"$native_keg"/}" ;;
        *)
          echo "homebrew-patched-launcher: native Formula link left its selected keg: $link" >&2
          exit 1
          ;;
      esac
      target_link="$target_keg/$relative"
      [ -L "$target_link" ] && [ "$("$readlink_bin" "$target_link")" = "$target" ] || {
        echo "homebrew-patched-launcher: copied native Formula link differs from its sealed source: $relative" >&2
        exit 1
      }
      "$rm_bin" -f -- "$target_link"
      "$ln_bin" -s -- "$resolved" "$target_link"
    done < <("$find_bin" "$native_keg" -xdev -type l -print0)
  '
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$rewrite_bash" -c "$rewrite_script" \
      kandelo-native-bridge-link-rewrite \
      "$native_keg" "$target_keg" "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$rewrite_find" "$rewrite_ln" "$rewrite_readlink" "$rewrite_realpath" \
      "$rewrite_rm"
  else
    "$rewrite_bash" -c "$rewrite_script" kandelo-native-bridge-link-rewrite \
      "$native_keg" "$target_keg" "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$rewrite_find" "$rewrite_ln" "$rewrite_readlink" "$rewrite_realpath" \
      "$rewrite_rm"
  fi
}

# Surface only a direct native dependency to target Homebrew. Its selected keg
# is copied into a canonical target rack; its recursive native closure remains
# in the separate prefix for embedded absolute paths and cannot collide with a
# target rack of the same short name.
homebrew_patched_launcher_bridge_native_formula() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_bridge_native_formula: expected FORMULA" >&2
    return 2
  fi
  local formula="$1" native_rack native_opt native_opt_target native_version
  local target_cellar target_opt target_rack target_keg target_opt_target
  local build_gid="" target_state_root unsafe_link bridge_status=0
  local audit_bash audit_readlink audit_realpath
  if ! [[ "$formula" =~ ^[a-z0-9][a-z0-9@+_.-]*$ ]]; then
    echo "homebrew-patched-launcher: invalid native Formula name: $formula" >&2
    return 2
  fi
  [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ] || {
    echo "homebrew-patched-launcher: seal native Homebrew before bridging Formulae" >&2
    return 2
  }
  if [[ " ${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[*]} " == *" $formula "* ]]; then
    echo "homebrew-patched-launcher: duplicate native Formula bridge: $formula" >&2
    return 2
  fi
  native_rack="$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar/$formula"
  native_opt="$HOMEBREW_PATCHED_NATIVE_PREFIX/opt/$formula"
  target_cellar="$HOMEBREW_PATCHED_PREFIX/Cellar"
  target_opt="$HOMEBREW_PATCHED_PREFIX/opt"
  [ -d "$native_rack" ] && [ ! -L "$native_rack" ] && \
    [ -e "$native_opt" ] && [ -L "$native_opt" ] || {
    echo "homebrew-patched-launcher: native Formula is not completely installed: $formula" >&2
    return 1
  }
  native_opt_target="$(cd "$native_opt" && pwd -P)" || {
    echo "homebrew-patched-launcher: native Formula opt link is unresolved: $formula" >&2
    return 1
  }
  [ "${native_opt_target%/*}" = "$native_rack" ] || {
    echo "homebrew-patched-launcher: native Formula opt link leaves its rack: $formula" >&2
    return 1
  }
  native_version="${native_opt_target##*/}"
  target_rack="$target_cellar/$formula"
  target_keg="$target_rack/$native_version"
  target_opt_target="../Cellar/$formula/$native_version"
  [ ! -e "$target_rack" ] && [ ! -L "$target_rack" ] && \
    [ ! -e "$target_opt/$formula" ] && [ ! -L "$target_opt/$formula" ] || {
      echo "homebrew-patched-launcher: target prefix already contains native Formula name: $formula" >&2
      return 1
    }

  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    audit_bash=/usr/bin/bash
    audit_readlink=/usr/bin/readlink
    audit_realpath=/usr/bin/realpath
  else
    audit_bash="$(command -v bash)"
    audit_readlink="$(command -v readlink)"
    audit_realpath="$(command -v realpath)"
  fi
  unsafe_link="$(/usr/bin/find "$native_opt_target" -xdev -type l \
    -exec "$audit_bash" -c '
      set -euo pipefail
      readlink_bin="$1"
      realpath_bin="$2"
      native_keg="$3"
      native_prefix="$4"
      shift 4
      for link; do
        target="$("$readlink_bin" "$link")"
        if [[ "$target" = /* ]]; then
          resolved="$("$realpath_bin" -m -- "$target")"
          case "$resolved" in
            "$native_prefix"|"$native_prefix"/*|/bin/*|/etc/ssl/*|/lib/*|/lib64/*|/usr/*) ;;
            *)
              printf "%s -> %s\n" "$link" "$target"
              exit 1
              ;;
          esac
          continue
        fi
        resolved="$("$realpath_bin" -m -- "${link%/*}/$target")"
        case "$resolved" in
          "$native_keg"|"$native_keg"/*) ;;
          "$native_prefix"|"$native_prefix"/*)
            [ -e "$resolved" ] || {
              printf "%s -> %s\n" "$link" "$target"
              exit 1
            }
            ;;
          *)
            printf "%s -> %s\n" "$link" "$target"
            exit 1
            ;;
        esac
      done
    ' kandelo-native-proxy-link-audit "$audit_readlink" "$audit_realpath" \
      "$native_opt_target" "$HOMEBREW_PATCHED_NATIVE_PREFIX" {} +)" || {
      echo "homebrew-patched-launcher: native Formula has a symlink that cannot be safely relocated: ${unsafe_link:-$formula}" >&2
      return 1
    }

  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    build_gid="$(/usr/bin/id -g "$HOMEBREW_PATCHED_BUILD_USER")"
    for target_state_root in "$target_cellar" "$target_opt"; do
      [ -d "$target_state_root" ] && [ ! -L "$target_state_root" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_state_root")" = "0:$build_gid:1775" ] || {
          echo "homebrew-patched-launcher: protected target Homebrew root changed: $target_state_root" >&2
          return 1
        }
    done
  else
    for target_state_root in "$target_cellar" "$target_opt"; do
      if [ -e "$target_state_root" ] || [ -L "$target_state_root" ]; then
        [ -d "$target_state_root" ] && [ ! -L "$target_state_root" ] || {
          echo "homebrew-patched-launcher: target Homebrew root is not a real directory: $target_state_root" >&2
          return 1
        }
      else
        mkdir -p "$target_state_root"
      fi
    done
  fi

  # Register the transaction before its first filesystem change. Cleanup then
  # knows about a partially copied rack even if the opt link or verification
  # fails.
  HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES+=("$formula")
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/install -d \
      -o root -g root -m 0700 "$target_rack" "$target_keg" || bridge_status=1
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/cp -R -p \
        "$native_opt_target/." "$target_keg/" || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      homebrew_patched_launcher_rewrite_native_bridge_links \
        "$native_opt_target" "$target_keg" || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown -hR root:root \
        "$target_rack" || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
        "$target_rack" -xdev -type d -exec /usr/bin/chmod 0555 {} + || \
        bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
        "$target_rack" -xdev -type f \
        -exec /usr/bin/chmod a-w,u-s,g-s {} + || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/ln -s \
        "$target_opt_target" "$target_opt/$formula" || bridge_status=1
    fi
  else
    if ! install -d -m 0755 "$target_rack" "$target_keg"; then
      bridge_status=1
    elif ! cp -R -p "$native_opt_target/." "$target_keg/"; then
      bridge_status=1
    elif ! homebrew_patched_launcher_rewrite_native_bridge_links \
      "$native_opt_target" "$target_keg"; then
      bridge_status=1
    elif ! find "$target_rack" -type d -exec chmod a-w {} +; then
      bridge_status=1
    elif ! find "$target_rack" -type f -exec chmod a-w,u-s,g-s {} +; then
      bridge_status=1
    elif ! ln -s "$target_opt_target" "$target_opt/$formula"; then
      bridge_status=1
    fi
  fi
  if [ "$bridge_status" -eq 0 ] && \
     { [ ! -d "$target_rack" ] || [ -L "$target_rack" ] || \
       [ ! -d "$target_keg" ] || [ -L "$target_keg" ] || \
       [ "$(cd "$target_keg" && pwd -P)" != "$target_keg" ] || \
       [ "$(/usr/bin/readlink "$target_opt/$formula")" != "$target_opt_target" ] || \
       [ "$(cd "$target_opt/$formula" && pwd -P)" != "$target_keg" ]; }; then
    echo "homebrew-patched-launcher: native Formula proxy is not a canonical target keg" >&2
    bridge_status=1
  fi
  if [ "$bridge_status" -eq 0 ] && [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_rack")" = "0:0:555" ] && \
      [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_keg")" = "0:0:555" ] && \
      homebrew_assert_tree_not_writable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" && \
      homebrew_assert_tree_not_replaceable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" || bridge_status=1
  fi
  if [ "$bridge_status" -ne 0 ]; then
    echo "homebrew-patched-launcher: native Formula bridge creation failed; rolling back" >&2
    if ! homebrew_patched_launcher_remove_native_bridges; then
      echo "homebrew-patched-launcher: native Formula bridge rollback failed; preserving launcher state for retry" >&2
    fi
    return 1
  fi
}

# Materialize the exact Homebrew developer-command gem groups while the
# workflow identity still owns the temporary overlay. Formula execution sees
# the resulting gem code and state only after the whole overlay is sealed.
homebrew_patched_launcher_seed_bundler_groups() {
  if [ "$#" -eq 0 ]; then
    echo "homebrew_patched_launcher_seed_bundler_groups: expected at least one group" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_OVERLAY" ]; then
    return 0
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: cannot seed Bundler groups after isolation" >&2
    return 2
  fi

  local group groups groups_csv group_count
  local vendor_root groups_file expected_groups actual_groups unsafe_entry
  local unsafe_marker marker_count marker_path marker_value
  for group in "$@"; do
    if ! [[ "$group" =~ ^[a-z][a-z0-9_]*$ ]]; then
      echo "homebrew-patched-launcher: invalid Bundler group: $group" >&2
      return 2
    fi
  done
  groups="$(printf '%s\n' "$@" | LC_ALL=C sort -u)"
  group_count="$(printf '%s\n' "$groups" | awk 'NF { count++ } END { print count + 0 }')"
  if [ "$group_count" -ne "$#" ]; then
    echo "homebrew-patched-launcher: Bundler groups must be unique" >&2
    return 2
  fi
  if [ "$group_count" -gt 32 ]; then
    echo "homebrew-patched-launcher: too many Bundler groups" >&2
    return 2
  fi
  groups_csv="$(printf '%s\n' "$groups" | paste -sd, -)"

  "$HOMEBREW_PATCHED_BREW_BIN" install-bundler-gems --groups="$groups_csv"

  vendor_root="$HOMEBREW_PATCHED_OVERLAY/Library/Homebrew/vendor/bundle/ruby"
  if [ ! -d "$vendor_root" ] || [ -L "$vendor_root" ]; then
    echo "homebrew-patched-launcher: Bundler vendor root is not a real directory" >&2
    return 1
  fi
  unsafe_entry="$(find "$vendor_root" -mindepth 1 ! \( -type d -o -type f \) -print -quit)"
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-patched-launcher: Bundler vendor tree contains a non-regular entry" >&2
    return 1
  fi
  groups_file="$vendor_root/.homebrew_gem_groups"
  if [ ! -f "$groups_file" ] || [ -L "$groups_file" ]; then
    echo "homebrew-patched-launcher: Bundler group state is not a regular file" >&2
    return 1
  fi
  expected_groups="$groups"
  actual_groups="$(LC_ALL=C sort "$groups_file")"
  if [ "$actual_groups" != "$expected_groups" ]; then
    echo "homebrew-patched-launcher: Bundler group state differs from the requested groups" >&2
    return 1
  fi

  unsafe_marker="$(find "$vendor_root" -mindepth 2 -maxdepth 2 \
    -name .homebrew_vendor_version ! -type f -print -quit)"
  if [ -n "$unsafe_marker" ]; then
    echo "homebrew-patched-launcher: Bundler vendor version is not a regular file" >&2
    return 1
  fi
  marker_count="$(find "$vendor_root" -mindepth 2 -maxdepth 2 \
    -type f -name .homebrew_vendor_version -print | awk 'END { print NR + 0 }')"
  if [ "$marker_count" -ne 1 ]; then
    echo "homebrew-patched-launcher: expected one Bundler vendor version, found $marker_count" >&2
    return 1
  fi
  marker_path="$(find "$vendor_root" -mindepth 2 -maxdepth 2 \
    -type f -name .homebrew_vendor_version -print)"
  marker_value="$(cat "$marker_path")"
  if ! [[ "$marker_value" =~ ^[0-9]+$ ]]; then
    echo "homebrew-patched-launcher: invalid Bundler vendor version" >&2
    return 1
  fi
}

# Move all Formula-evaluating Brew calls behind a fixed wrapper that switches
# to a dedicated user inside a transient systemd service. KillMode=control-group
# makes double-forked or session-detached descendants part of the call lifecycle.
homebrew_patched_launcher_isolate() {
  if [ "$#" -lt 6 ]; then
    echo "homebrew_patched_launcher_isolate: expected BUILD_USER WORK_DIR KANDELO_ROOT TAP_ROOT OUTPUT_ROOT SYSROOT_BUILD_ROOT [ADDITIONAL_PROTECTED_ROOT ...]" >&2
    return 2
  fi
  local build_user="$1" work_dir="$2" kandelo_root="$3" tap_root="$4" output_root="$5"
  local sysroot_build_root="$6" sysroot
  shift 6
  local build_group build_home protected_brew protected_audit
  local wrapper_source wrapper_path audit_source native_runner_source native_runner_path
  local mutable_root protected_root target_state_root native_reported_prefix native_reported_repo
  local physical_repo physical_prefix
  local sudo_bin sudo_mode env_bin variable value protected_bin patched_prefix patched_repo
  local systemd_run_bin systemctl_bin getent_bin pgrep_bin pkill_bin
  local build_uid systemd_slice unit_prefix source_alias_dir
  local config_root config_file unsafe_config_entry trust_file trust_lock
  local primary_tap_root primary_tap_owner_root taps_root
  local xtask_bin xtask_relative xtask_alias xtask_mode xtask_links
  local xtask_uid xtask_state xtask_sha256
  local -a preserved_variables native_preserved_variables mutable_roots
  local -a xtask_path_parts
  local -a additional_protected_roots=("$@")

  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    physical_repo="$(cd "$HOMEBREW_PATCHED_REPO" && pwd -P)" || return 2
    physical_prefix="$(cd "$HOMEBREW_PATCHED_PREFIX" && pwd -P)" || return 2
    case "$physical_repo/" in
      "$physical_prefix/"*)
        echo "homebrew-patched-launcher: Homebrew backing repository cannot be inside the hidden target prefix" >&2
        return 2
        ;;
    esac
    for mutable_root in "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$HOMEBREW_PATCHED_NATIVE_CACHE" "$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$HOMEBREW_PATCHED_NATIVE_CONFIG" "$HOMEBREW_PATCHED_NATIVE_HOME"; do
      if [ ! -d "$mutable_root" ] || [ -L "$mutable_root" ]; then
        echo "homebrew-patched-launcher: native Homebrew root is not a real directory: $mutable_root" >&2
        return 2
      fi
    done
    [ -L "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ] && \
      [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_NATIVE_BREW_BIN")" = \
        "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] || {
        echo "homebrew-patched-launcher: native Homebrew launcher changed before isolation" >&2
        return 2
      }
  elif [ -n "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_CACHE" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_TEMP" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_CONFIG" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_HOME" ]; then
    echo "homebrew-patched-launcher: native Homebrew state is incomplete" >&2
    return 2
  fi

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
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/realpath /usr/bin/realpath realpath
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/bash /usr/bin/bash bash
  for protected_bin in chmod chown cmp cp id install ln ls mktemp readlink rm \
    sha256sum stat test; do
    homebrew_assert_protected_host_executable \
      "$build_user" "/usr/bin/$protected_bin" "/usr/bin/$protected_bin" "$protected_bin"
  done
  if [ -z "${HOMEBREW_GIT_PATH:-}" ]; then
    echo "homebrew-patched-launcher: protected host Git was not selected before isolation" >&2
    return 2
  fi
  homebrew_assert_protected_host_executable \
    "$build_user" "$HOMEBREW_GIT_PATH" "$HOMEBREW_GIT_PATH" \
    "Nix Git" || return
  homebrew_assert_tree_not_replaceable_by_user \
    "$build_user" "$HOMEBREW_GIT_PATH" || return
  if [ -n "${HOMEBREW_KANDELO_GNU_TAR:-}" ]; then
    homebrew_assert_protected_host_executable \
      "$build_user" "$HOMEBREW_KANDELO_GNU_TAR" \
      "$HOMEBREW_KANDELO_GNU_TAR" "Nix GNU tar" || return
    homebrew_assert_tree_not_replaceable_by_user \
      "$build_user" "$HOMEBREW_KANDELO_GNU_TAR" || return
  fi
  [ -d /run/systemd/system ] || {
    echo "homebrew-patched-launcher: systemd is not the active service manager" >&2
    return 2
  }
  "$sudo_bin" -n -- "$systemctl_bin" show --property=Version --value >/dev/null || {
    echo "homebrew-patched-launcher: systemd manager is unavailable" >&2
    return 2
  }
  env_bin="$(command -v env)"
  build_group="$(/usr/bin/id -gn "$build_user")"
  build_uid="$(id -u "$build_user")"
  build_home="$("$getent_bin" passwd "$build_user" | awk -F: '{print $6}')"
  [ -n "$build_home" ] || {
    echo "homebrew-patched-launcher: build user has no home directory" >&2
    return 2
  }

  primary_tap_root="${HOMEBREW_KANDELO_PRIMARY_TAP_ROOT:-}"
  if [ -z "$primary_tap_root" ] || [ ! -d "$primary_tap_root" ] || \
     [ -L "$primary_tap_root" ]; then
    echo "homebrew-patched-launcher: selected primary tap root must be a real directory" >&2
    return 2
  fi
  primary_tap_root="$(cd "$primary_tap_root" && pwd -P)" || return 2
  # Taps belong to HOMEBREW_REPOSITORY, not HOMEBREW_PREFIX. The reviewed
  # launcher intentionally keeps the canonical Linuxbrew prefix while running
  # from a patched repository worktree, so only the active repository can own
  # the tapped checkouts that Formula resolution actually loads.
  taps_root="$HOMEBREW_PATCHED_OVERLAY/Library/Taps"
  if [ ! -d "$taps_root" ] || [ -L "$taps_root" ]; then
    echo "homebrew-patched-launcher: active Homebrew repository tap storage must be a real directory" >&2
    return 2
  fi
  taps_root="$(cd "$taps_root" && pwd -P)" || return 2
  primary_tap_owner_root="${primary_tap_root%/*}"
  if [ "${primary_tap_owner_root%/*}" != "$taps_root" ] || \
     [ "$primary_tap_root" != "$HOMEBREW_KANDELO_PRIMARY_TAP_ROOT" ]; then
    echo "homebrew-patched-launcher: selected primary tap root is not one canonical tapped checkout" >&2
    return 2
  fi
  case "$primary_tap_root" in
    *:*)
      echo "homebrew-patched-launcher: selected primary tap root cannot contain ':'" >&2
      return 2
      ;;
  esac

  if [ ! -d "$sysroot_build_root" ] || [ -L "$sysroot_build_root" ]; then
    echo "homebrew-patched-launcher: sysroot build root must be a real directory" >&2
    return 2
  fi
  sysroot_build_root="$(cd "$sysroot_build_root" && pwd -P)" || return 2
  case "${KANDELO_HOMEBREW_ARCH:-}" in
    wasm32) sysroot="$sysroot_build_root/sysroot" ;;
    wasm64) sysroot="$sysroot_build_root/sysroot64" ;;
    *)
      echo "homebrew-patched-launcher: KANDELO_HOMEBREW_ARCH must select wasm32 or wasm64" >&2
      return 2
      ;;
  esac
  if [ ! -d "$sysroot" ] || [ -L "$sysroot" ] || \
     [ ! -f "$sysroot/lib/libc.a" ] || [ -L "$sysroot/lib/libc.a" ]; then
    echo "homebrew-patched-launcher: sysroot must be a real directory containing a regular libc archive" >&2
    return 2
  fi
  sysroot="$(cd "$sysroot" && pwd -P)" || return 2
  [ "$sysroot_build_root" != "/" ] || {
    echo "homebrew-patched-launcher: sysroot build root cannot be the filesystem root" >&2
    return 2
  }
  case "$sysroot" in
    *:*)
      echo "homebrew-patched-launcher: sysroot cannot contain ':' for a systemd bind" >&2
      return 2
      ;;
  esac
  homebrew_assert_tree_symlinks_contained "$sysroot" sysroot || return

  for protected_root in "$kandelo_root" "$tap_root" "$output_root" \
    "$sysroot_build_root" "${additional_protected_roots[@]}"; do
    if [ ! -d "$protected_root" ] || [ -L "$protected_root" ]; then
      echo "homebrew-patched-launcher: protected root is not a real directory: $protected_root" >&2
      return 2
    fi
    protected_root="$(cd "$protected_root" && pwd -P)" || return 2
    [ "$protected_root" != "/" ] || {
      echo "homebrew-patched-launcher: protected root cannot be the filesystem root" >&2
      return 2
    }
    case "$protected_root" in
      *:*)
        echo "homebrew-patched-launcher: protected root cannot contain ':' for a systemd bind: $protected_root" >&2
        return 2
        ;;
    esac
  done
  [ "$(cd "$kandelo_root" && pwd -P)" = "$kandelo_root" ] || {
    echo "homebrew-patched-launcher: Kandelo root must be one exact canonical checkout" >&2
    return 2
  }

  # WHY: WASM_POSIX_XTASK_BIN is caller-controlled until this boundary. Only
  # Cargo's exact release output below the reviewed checkout may become the
  # source-projection authority; accepting a cache, symlink, or adjacent tool
  # would let Formula evaluation select different package policy code.
  xtask_bin="${WASM_POSIX_XTASK_BIN:-}"
  if [ -z "$xtask_bin" ] || [ "${xtask_bin#/}" = "$xtask_bin" ] || \
     [ ! -f "$xtask_bin" ] || [ -L "$xtask_bin" ] || [ ! -x "$xtask_bin" ] || \
     [ "$(/usr/bin/realpath -- "$xtask_bin" 2>/dev/null || true)" != "$xtask_bin" ]; then
    echo "homebrew-patched-launcher: prepared program-index checker must be one exact regular executable" >&2
    return 2
  fi
  case "$xtask_bin" in
    "$kandelo_root"/*) xtask_relative="${xtask_bin#"$kandelo_root"/}" ;;
    *)
      echo "homebrew-patched-launcher: prepared program-index checker is outside the exact Kandelo root" >&2
      return 2
      ;;
  esac
  IFS=/ read -r -a xtask_path_parts <<<"$xtask_relative"
  if [ "${#xtask_path_parts[@]}" -ne 4 ] || \
     [ "${xtask_path_parts[0]}" != "target" ] || \
     ! [[ "${xtask_path_parts[1]}" =~ ^[A-Za-z0-9_.+-]+$ ]] || \
     [ "${xtask_path_parts[2]}" != "release" ] || \
     [ "${xtask_path_parts[3]}" != "xtask" ]; then
    echo "homebrew-patched-launcher: program-index checker is not the prepared release xtask" >&2
    return 2
  fi
  xtask_mode="$(/usr/bin/stat -c '%a' "$xtask_bin" 2>/dev/null || true)"
  xtask_links="$(/usr/bin/stat -c '%h' "$xtask_bin" 2>/dev/null || true)"
  xtask_uid="$(/usr/bin/stat -c '%u' "$xtask_bin" 2>/dev/null || true)"
  if ! [[ "$xtask_mode" =~ ^[0-7]{3,4}$ ]] || \
     [ $((8#$xtask_mode & 06022)) -ne 0 ] || [ "$xtask_links" != "1" ] || \
     [ "$xtask_uid" = "$build_uid" ] || \
     ! "$sudo_bin" -H -u "$build_user" -- \
       /usr/bin/test -r "$xtask_bin" -a -x "$xtask_bin" || \
     "$sudo_bin" -H -u "$build_user" -- /usr/bin/test -w "$xtask_bin"; then
    echo "homebrew-patched-launcher: prepared program-index checker has unsafe Formula access" >&2
    return 2
  fi
  homebrew_assert_tree_not_replaceable_by_user "$build_user" "$xtask_bin" || return
  xtask_state="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$xtask_bin")" || return 2
  xtask_sha256="$(/usr/bin/sha256sum "$xtask_bin")" || return 2
  xtask_sha256="${xtask_sha256%% *}"
  [[ "$xtask_sha256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "homebrew-patched-launcher: could not seal the prepared program-index checker" >&2
    return 2
  }

  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    for mutable_root in "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$HOMEBREW_PATCHED_NATIVE_CACHE" "$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$HOMEBREW_PATCHED_NATIVE_CONFIG" "$HOMEBREW_PATCHED_NATIVE_HOME"; do
      for protected_root in "$work_dir" "$kandelo_root" "$tap_root" "$output_root" \
        "$sysroot_build_root" "$build_home" "${additional_protected_roots[@]}"; do
        if [ "$mutable_root" = "$protected_root" ]; then
          echo "homebrew-patched-launcher: native and target execution roots must differ: $mutable_root" >&2
          return 2
        fi
        case "$mutable_root/" in
          "$protected_root/"*)
            echo "homebrew-patched-launcher: native state cannot be inside a target execution root: $mutable_root" >&2
            return 2
            ;;
        esac
        case "$protected_root/" in
          "$mutable_root/"*)
            echo "homebrew-patched-launcher: target execution root cannot be inside native state: $protected_root" >&2
            return 2
            ;;
        esac
      done
    done
  fi

  mutable_roots=(
    "$work_dir"
    "$HOMEBREW_PATCHED_PREFIX"
    "$HOMEBREW_CACHE"
    "$HOMEBREW_TEMP"
    "$XDG_CONFIG_HOME"
    "$build_home"
  )
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    mutable_roots+=(
      "$HOMEBREW_PATCHED_NATIVE_PREFIX"
      "$HOMEBREW_PATCHED_NATIVE_CACHE"
      "$HOMEBREW_PATCHED_NATIVE_TEMP"
      "$HOMEBREW_PATCHED_NATIVE_CONFIG"
      "$HOMEBREW_PATCHED_NATIVE_HOME"
    )
  fi
  for mutable_root in "${mutable_roots[@]}"; do
    if [ ! -d "$mutable_root" ] || [ -L "$mutable_root" ]; then
      echo "homebrew-patched-launcher: mutable build root is not a real directory: $mutable_root" >&2
      return 2
    fi
    case "$sysroot_build_root/" in
      "$mutable_root/"*)
        echo "homebrew-patched-launcher: sysroot build root cannot be inside mutable Formula state" >&2
        return 2
        ;;
    esac
    case "$mutable_root/" in
      "$sysroot_build_root/"*)
        echo "homebrew-patched-launcher: mutable Formula state cannot be inside the sysroot build root" >&2
        return 2
        ;;
    esac
  done
  for protected_root in "${additional_protected_roots[@]}"; do
    homebrew_assert_tree_not_replaceable_by_user "$build_user" "$protected_root" || return
  done
  for target_state_root in "$HOMEBREW_PATCHED_PREFIX/Cellar" \
    "$HOMEBREW_PATCHED_PREFIX/opt"; do
    if [ -e "$target_state_root" ] || [ -L "$target_state_root" ]; then
      [ -d "$target_state_root" ] && [ ! -L "$target_state_root" ] || {
        echo "homebrew-patched-launcher: target Homebrew root is not a real directory: $target_state_root" >&2
        return 2
      }
    fi
  done
  chmod 1777 "$work_dir"
  "$sudo_bin" chown -R "$build_user:$build_group" \
    "$HOMEBREW_PATCHED_PREFIX" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP"
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    "$sudo_bin" /usr/bin/chown -R "$build_user:$build_group" \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" "$HOMEBREW_PATCHED_NATIVE_CACHE" \
      "$HOMEBREW_PATCHED_NATIVE_TEMP" "$HOMEBREW_PATCHED_NATIVE_CONFIG" \
      "$HOMEBREW_PATCHED_NATIVE_HOME"
    "$sudo_bin" /usr/bin/install -d -o root -g "$build_group" -m 1775 \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" "$HOMEBREW_PATCHED_NATIVE_PREFIX/bin"
    "$sudo_bin" /usr/bin/chown -h root:root "$HOMEBREW_PATCHED_NATIVE_BREW_BIN"
    "$sudo_bin" /usr/bin/install -d -o "$build_user" -g "$build_group" -m 0755 \
      "$HOMEBREW_PATCHED_NATIVE_CONFIG/homebrew"
  fi
  "$sudo_bin" chown "root:$build_group" "$HOMEBREW_PATCHED_PREFIX"
  "$sudo_bin" chmod 1775 "$HOMEBREW_PATCHED_PREFIX"
  "$sudo_bin" /usr/bin/install -d -o root -g "$build_group" -m 1775 \
    "$HOMEBREW_PATCHED_PREFIX/Cellar" "$HOMEBREW_PATCHED_PREFIX/opt"
  homebrew_patched_launcher_seal_control_files "$build_user" || return
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
  mutable_roots=("$work_dir" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP" "$build_home")
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    mutable_roots+=(
      "$HOMEBREW_PATCHED_NATIVE_PREFIX"
      "$HOMEBREW_PATCHED_NATIVE_CACHE"
      "$HOMEBREW_PATCHED_NATIVE_TEMP"
      "$HOMEBREW_PATCHED_NATIVE_CONFIG"
      "$HOMEBREW_PATCHED_NATIVE_HOME"
    )
  fi
  for mutable_root in "${mutable_roots[@]}"; do
    if ! "$sudo_bin" -H -u "$build_user" -- test -r "$mutable_root" -a \
      -x "$mutable_root" -a -w "$mutable_root"; then
      echo "homebrew-patched-launcher: build user cannot access mutable build root: $mutable_root" >&2
      return 2
    fi
  done
  homebrew_assert_tree_not_replaceable_by_user "$build_user" "$sysroot" || return

  HOMEBREW_PATCHED_PROTECTED_DIR="$HOMEBREW_PATCHED_PREFIX/.kandelo-homebrew-$$-${RANDOM}"
  "$sudo_bin" install -d -o root -g root -m 0755 "$HOMEBREW_PATCHED_PROTECTED_DIR"
  source_alias_dir="$work_dir/source-aliases"
  "$sudo_bin" install -d -o root -g root -m 0555 \
    "$source_alias_dir" "$source_alias_dir/kandelo" "$source_alias_dir/tap" \
    "$source_alias_dir/sysroot"
  HOMEBREW_PATCHED_SOURCE_ALIAS_DIR="$source_alias_dir"
  xtask_alias="$source_alias_dir/kandelo/$xtask_relative"
  protected_brew="$HOMEBREW_PATCHED_PROTECTED_DIR/brew"
  "$sudo_bin" ln -s "$HOMEBREW_PATCHED_OVERLAY/bin/brew" "$protected_brew"

  audit_source="$work_dir/audit-source-aliases"
  protected_audit="$HOMEBREW_PATCHED_PROTECTED_DIR/audit-source-aliases"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'expected_kandelo=%q\n' "$source_alias_dir/kandelo"
    printf 'expected_tap=%q\n' "$source_alias_dir/tap"
    printf 'expected_sysroot=%q\n' "$source_alias_dir/sysroot"
    printf 'expected_xtask=%q\n' "$xtask_alias"
    printf 'expected_xtask_state=%q\n' "$xtask_state"
    printf 'expected_xtask_sha256=%q\n' "$xtask_sha256"
    printf 'expected_primary_tap=%q\n' "$primary_tap_root"
    printf 'actual_xtask_sha256="$(/usr/bin/sha256sum "$expected_xtask" 2>/dev/null || true)"\n'
    printf 'actual_xtask_sha256="${actual_xtask_sha256%%%% *}"\n'
    printf 'if [ "${HOMEBREW_KANDELO_ROOT:-}" != "$expected_kandelo" ] || '
    printf '[ "${KANDELO_HOMEBREW_KANDELO_ROOT:-}" != "$expected_kandelo" ]; then\n'
    printf '  echo "homebrew-patched-launcher: isolated Kandelo root does not use the protected alias" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'if [ "${HOMEBREW_KANDELO_SYSROOT:-}" != "$expected_sysroot" ] || '
    printf '[ "${WASM_POSIX_SYSROOT:-}" != "$expected_sysroot" ]; then\n'
    printf '  echo "homebrew-patched-launcher: isolated sysroot does not use the protected alias" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'if [ "${HOMEBREW_KANDELO_PRIMARY_TAP_ROOT:-}" != "$expected_primary_tap" ]; then\n'
    printf '  echo "homebrew-patched-launcher: isolated primary tap root changed" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'if [ "${WASM_POSIX_XTASK_BIN:-}" != "$expected_xtask" ] || '
    printf '[ ! -f "$expected_xtask" ] || [ -L "$expected_xtask" ] || '
    printf '[ ! -r "$expected_xtask" ] || [ ! -x "$expected_xtask" ] || '
    printf '[ -w "$expected_xtask" ] || '
    printf '[ "$(/usr/bin/realpath -- "$expected_xtask")" != "$expected_xtask" ] || '
    printf '[ "$(/usr/bin/stat -c '\''%%d:%%i:%%u:%%g:%%a:%%h:%%s'\'' "$expected_xtask")" != "$expected_xtask_state" ] || '
    printf '[ "$actual_xtask_sha256" != "$expected_xtask_sha256" ]; then\n'
    printf '  echo "homebrew-patched-launcher: protected program-index checker changed or is inaccessible" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'if [ ! -f "$expected_sysroot/lib/libc.a" ] || [ -L "$expected_sysroot/lib/libc.a" ]; then\n'
    printf '  echo "homebrew-patched-launcher: protected sysroot libc archive is invalid" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'for source_alias in "$expected_kandelo" "$expected_tap" "$expected_sysroot"; do\n'
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
    printf 'primary_tap_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$expected_primary_tap")" || {\n'
    printf '  echo "homebrew-patched-launcher: could not inspect selected primary tap mount" >&2; exit 2;\n}\n'
    printf 'case ",${primary_tap_options// /}," in *,ro,*) ;; *) echo "homebrew-patched-launcher: selected primary tap is writable" >&2; exit 1 ;; esac\n'
    printf 'if (: >"$expected_primary_tap/.kandelo-write-probe") 2>/dev/null; then\n'
    printf '  echo "homebrew-patched-launcher: target Formula can modify the selected primary tap" >&2; exit 1\nfi\n'
    homebrew_patched_launcher_emit_sysroot_access_audit
    printf 'hidden_roots=('
    for protected_root in "$kandelo_root" "$tap_root" "$output_root" \
      "$sysroot_build_root" "${additional_protected_roots[@]}"; do
      printf ' %q' "$protected_root"
    done
    printf ')\nfor hidden_root in "${hidden_roots[@]}"; do\n'
    printf '  if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then\n'
    printf '    echo "homebrew-patched-launcher: original protected root is usable by Formula execution: $hidden_root" >&2\n'
    printf '    exit 1\n  fi\n'
    printf '  if /usr/bin/ls "$hidden_root" >/dev/null 2>&1; then\n'
    printf '    echo "homebrew-patched-launcher: Formula execution can list an original protected root: $hidden_root" >&2\n'
    printf '    exit 1\n  fi\n'
    printf '  if (: >"$hidden_root/.kandelo-write-probe") 2>/dev/null; then\n'
    printf '    echo "homebrew-patched-launcher: Formula execution can modify an original protected root: $hidden_root" >&2\n'
    printf '    exit 1\n  fi\ndone\n'
    if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
      printf 'native_prefix=%q\n' "$HOMEBREW_PATCHED_NATIVE_PREFIX"
      printf 'native_mount_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$native_prefix")" || {\n'
      printf '  echo "homebrew-patched-launcher: could not inspect native Homebrew mount" >&2; exit 2;\n}\n'
      printf 'case ",${native_mount_options// /}," in *,ro,*) ;; *) echo "homebrew-patched-launcher: native Homebrew prefix is writable" >&2; exit 1 ;; esac\n'
      printf 'if (: >"$native_prefix/.kandelo-write-probe") 2>/dev/null; then\n'
      printf '  echo "homebrew-patched-launcher: target Formula can modify native Homebrew" >&2; exit 1\nfi\n'
    fi
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
    HOMEBREW_KANDELO_PRIMARY_TAP_ROOT
    HOMEBREW_GIT_PATH
    HOMEBREW_KANDELO_GNU_TAR HOMEBREW_KANDELO_LLVM_BIN HOMEBREW_KANDELO_ABI
    HOMEBREW_KANDELO_NODE_RECEIPT_PATH
    LLVM_BIN WASM_POSIX_LLVM_DIR
    NIX_SSL_CERT_FILE SSL_CERT_FILE PLAYWRIGHT_BROWSERS_PATH
  )
  native_preserved_variables=(
    CI GITHUB_ACTIONS RUNNER_OS LANG LC_ALL TZ SOURCE_DATE_EPOCH PATH
    HOMEBREW_NO_AUTO_UPDATE HOMEBREW_NO_INSTALL_CLEANUP
    HOMEBREW_NO_ANALYTICS HOMEBREW_DEVELOPER HOMEBREW_GIT_PATH
    NIX_SSL_CERT_FILE SSL_CERT_FILE
  )
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'xtask_path=%q\n' "$xtask_bin"
    printf 'xtask_state=%q\n' "$xtask_state"
    printf 'xtask_sha256=%q\n' "$xtask_sha256"
    printf 'actual_xtask_sha256="$(/usr/bin/sha256sum "$xtask_path" 2>/dev/null || true)"\n'
    printf 'actual_xtask_sha256="${actual_xtask_sha256%%%% *}"\n'
    # WHY: the source checkout is trusted but workflow-owned. Rechecking its
    # inode and bytes for every Formula entry prevents a later workflow step
    # from silently turning the already-reviewed checker path into new code.
    printf 'if [ ! -f "$xtask_path" ] || [ -L "$xtask_path" ] || [ ! -x "$xtask_path" ] || '
    printf '[ "$(/usr/bin/realpath -- "$xtask_path")" != "$xtask_path" ] || '
    printf '[ "$(/usr/bin/stat -c '\''%%d:%%i:%%u:%%g:%%a:%%h:%%s'\'' "$xtask_path")" != "$xtask_state" ] || '
    printf '[ "$actual_xtask_sha256" != "$xtask_sha256" ]; then\n'
    printf '  echo "homebrew-patched-launcher: prepared program-index checker changed after isolation" >&2\n'
    printf '  exit 2\nfi\n'
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
      "--property=BindReadOnlyPaths=$sysroot:$source_alias_dir/sysroot" \
      "--property=BindReadOnlyPaths=$taps_root" \
      "--property=InaccessiblePaths=$kandelo_root" \
      "--property=InaccessiblePaths=$tap_root" \
      "--property=InaccessiblePaths=$output_root" \
      "--service-type=exec" \
      "--expand-environment=no"
    if [ "$sysroot_build_root" != "$kandelo_root" ] && \
       [ "$sysroot_build_root" != "$tap_root" ] && \
       [ "$sysroot_build_root" != "$output_root" ]; then
      printf ' %q' "--property=InaccessiblePaths=$sysroot_build_root"
    fi
    for protected_root in "${additional_protected_roots[@]}"; do
      printf ' %q' "--property=InaccessiblePaths=$protected_root"
    done
    if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
      printf ' %q' \
        "--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_NATIVE_PREFIX" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_CACHE" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_TEMP" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_CONFIG" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_HOME"
    fi
    printf ' --working-directory="$working_directory" -- %q -i' "$env_bin"
    printf ' %q' "HOME=$build_home" "USER=$build_user" "LOGNAME=$build_user" \
      "TMPDIR=$HOMEBREW_TEMP"
    for variable in "${preserved_variables[@]}"; do
      if [ -n "${!variable+x}" ]; then
        value="${!variable}"
        printf ' %q' "$variable=$value"
      fi
    done
    printf ' %q %q %q %q %q' "HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo" \
      "KANDELO_HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo" \
      "HOMEBREW_KANDELO_SYSROOT=$source_alias_dir/sysroot" \
      "WASM_POSIX_SYSROOT=$source_alias_dir/sysroot" \
      "WASM_POSIX_XTASK_BIN=$xtask_alias"
    printf ' "${bottle_tag_env[@]}" "$command_path" "$@"\n'
  } >"$wrapper_source"
  "$sudo_bin" install -o root -g root -m 0555 "$wrapper_source" "$wrapper_path"
  rm -f "$wrapper_source"

  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    native_runner_source="$work_dir/run-isolated-native-brew"
    native_runner_path="$HOMEBREW_PATCHED_PROTECTED_DIR/run-native-brew"
    {
      printf '#!/usr/bin/env bash\nset -euo pipefail\n'
      printf '[ "$#" -gt 0 ] || { echo "homebrew-patched-launcher: native Homebrew command is required" >&2; exit 2; }\n'
      printf 'working_directory=%q\n' "$HOMEBREW_PATCHED_NATIVE_TEMP"
      printf 'unit=%q-native-$$-${RANDOM}.service\n' "$unit_prefix"
      printf 'exec %q --quiet --wait --collect --pipe' "$systemd_run_bin"
      printf ' --unit="$unit"'
      printf ' %q' "--slice=$systemd_slice" \
        "--uid=$build_user" "--gid=$build_group" \
        "--property=KillMode=control-group" "--property=SendSIGKILL=yes" \
        "--property=TimeoutStopSec=10s" "--property=NoNewPrivileges=yes" \
        "--property=BindReadOnlyPaths=$work_dir" \
        "--property=InaccessiblePaths=$kandelo_root" \
        "--property=InaccessiblePaths=$tap_root" \
        "--property=InaccessiblePaths=$output_root" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_PREFIX" \
        "--property=InaccessiblePaths=$HOMEBREW_CACHE" \
        "--property=InaccessiblePaths=$HOMEBREW_TEMP" \
        "--property=InaccessiblePaths=$XDG_CONFIG_HOME" \
        "--property=InaccessiblePaths=$build_home" \
        "--service-type=exec" \
        "--expand-environment=no"
      if [ "$sysroot_build_root" != "$kandelo_root" ] && \
         [ "$sysroot_build_root" != "$tap_root" ] && \
         [ "$sysroot_build_root" != "$output_root" ]; then
        printf ' %q' "--property=InaccessiblePaths=$sysroot_build_root"
      fi
      for protected_root in "${additional_protected_roots[@]}"; do
        printf ' %q' "--property=InaccessiblePaths=$protected_root"
      done
      printf ' --working-directory="$working_directory" -- %q -i' "$env_bin"
      printf ' %q' "HOME=$HOMEBREW_PATCHED_NATIVE_HOME" \
        "USER=$build_user" "LOGNAME=$build_user" \
        "TMPDIR=$HOMEBREW_PATCHED_NATIVE_TEMP" \
        "XDG_CONFIG_HOME=$HOMEBREW_PATCHED_NATIVE_CONFIG" \
        "HOMEBREW_CACHE=$HOMEBREW_PATCHED_NATIVE_CACHE" \
        "HOMEBREW_TEMP=$HOMEBREW_PATCHED_NATIVE_TEMP"
      for variable in "${native_preserved_variables[@]}"; do
        if [ -n "${!variable+x}" ]; then
          value="${!variable}"
          printf ' %q' "$variable=$value"
        fi
      done
      printf ' %q' "HOMEBREW_RELOCATE_BUILD_PREFIX=1"
      printf ' %q "$@"\n' "$HOMEBREW_PATCHED_NATIVE_BREW_BIN"
    } >"$native_runner_source"
    "$sudo_bin" /usr/bin/install -o root -g root -m 0500 \
      "$native_runner_source" "$native_runner_path"
    rm -f "$native_runner_source"
    HOMEBREW_PATCHED_NATIVE_RUNNER="$native_runner_path"
  fi
  "$sudo_bin" chmod 0555 "$HOMEBREW_PATCHED_PROTECTED_DIR"

  # Git still needs the workflow-owned backing repository. Normalize every
  # trusted file materialized in the temporary worktree, including Bundler
  # output whose archive modes are not part of the publisher boundary.
  homebrew_patched_launcher_seal_overlay "$build_user" || return
  homebrew_assert_tree_not_writable_by_user \
    "$build_user" "$source_alias_dir" || return
  homebrew_assert_tree_not_replaceable_by_user \
    "$build_user" "$source_alias_dir" || return
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
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    native_reported_prefix="$(homebrew_patched_launcher_run_native --prefix)" || return
    native_reported_repo="$(homebrew_patched_launcher_run_native --repository)" || return
    [ "$native_reported_prefix" = "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] || {
      echo "homebrew-patched-launcher: isolated native Homebrew changed its prefix" >&2
      return 1
    }
    [ "$(cd "$native_reported_repo" && pwd -P)" = \
      "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ] || {
      echo "homebrew-patched-launcher: isolated native Homebrew changed its repository" >&2
      return 1
    }
  fi
}

# Remove the one registered protected input without discarding retry state on
# failure. Formula processes must already be stopped before normal cleanup
# calls this helper.
homebrew_patched_launcher_remove_staged_input() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_remove_staged_input: expected no arguments" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] && \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] && \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_SUDO_BIN" ] || \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] || \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] || \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ] || \
     [ "${HOMEBREW_PATCHED_STAGED_INPUT_PATH%/*}" != \
       "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ]; then
    echo "homebrew-patched-launcher: protected input cleanup state is incomplete" >&2
    return 1
  fi
  case "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" in
    "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP"/homebrew-bottle-input.??????) ;;
    *)
      echo "homebrew-patched-launcher: protected input cleanup path left its shared root" >&2
      return 1
      ;;
  esac
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -rf -- \
       "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" || \
     [ -e "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] || \
     [ -L "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ]; then
    echo "homebrew-patched-launcher: could not remove protected input; preserving cleanup state for retry" >&2
    return 1
  fi
  HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP=""
  HOMEBREW_PATCHED_STAGED_INPUT_DIR=""
  HOMEBREW_PATCHED_STAGED_INPUT_PATH=""
}

# Copy one workflow-owned input into a root-owned directory that the isolated
# Formula identity can read but cannot modify or replace.
homebrew_patched_launcher_stage_protected_input() {
  if [ "$#" -ne 4 ]; then
    echo "homebrew_patched_launcher_stage_protected_input: expected BUILD_USER SHARED_TEMP SOURCE BASENAME" >&2
    return 2
  fi
  local build_user="$1" shared_temp="$2" source="$3" basename="$4"
  local protected_dir="" protected_path=""

  if [ -z "$HOMEBREW_PATCHED_BUILD_USER" ] || \
     [ "$build_user" != "$HOMEBREW_PATCHED_BUILD_USER" ] || \
     [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" = "1" ] || \
     [ -z "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
    echo "homebrew-patched-launcher: protected input requires the initialized Formula identity" >&2
    return 2
  fi
  if [ -n "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] || \
     [ -n "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] || \
     [ -n "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ]; then
    echo "homebrew-patched-launcher: a protected input is already registered" >&2
    return 2
  fi
  if [ ! -f "$source" ] || [ -L "$source" ]; then
    echo "homebrew-patched-launcher: protected input source is not a regular file: $source" >&2
    return 2
  fi
  if [ "${#basename}" -gt 512 ] || \
     ! [[ "$basename" =~ ^[A-Za-z0-9][A-Za-z0-9@._+,\-]*$ ]]; then
    echo "homebrew-patched-launcher: invalid protected input basename: $basename" >&2
    return 2
  fi
  if [ ! -d "$shared_temp" ] || [ -L "$shared_temp" ]; then
    echo "homebrew-patched-launcher: protected input shared temp is not a real directory" >&2
    return 2
  fi
  shared_temp="$(cd "$shared_temp" && pwd -P)" || return 2
  if [ "$(/usr/bin/stat -c '%u:%g:%a' "$shared_temp")" != "0:0:1777" ]; then
    echo "homebrew-patched-launcher: protected input shared temp must be root-owned mode 1777" >&2
    return 2
  fi

  protected_dir="$(/usr/bin/mktemp -d "$shared_temp/homebrew-bottle-input.XXXXXX")" || return 1
  protected_path="$protected_dir/$basename"
  HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP="$shared_temp"
  HOMEBREW_PATCHED_STAGED_INPUT_DIR="$protected_dir"
  HOMEBREW_PATCHED_STAGED_INPUT_PATH="$protected_path"
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/install \
       -o root -g root -m 0444 -- "$source" "$protected_path" || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown root:root \
       "$protected_dir" || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chmod 0555 \
       "$protected_dir"; then
    echo "homebrew-patched-launcher: could not stage protected input" >&2
    homebrew_patched_launcher_remove_staged_input || true
    return 1
  fi

  if [ "$(/usr/bin/stat -c '%u:%g:%a' "$protected_dir")" != "0:0:555" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$protected_path")" != "0:0:444:1" ] || \
     [ "$source" -ef "$protected_path" ] || \
     ! /usr/bin/cmp -s -- "$source" "$protected_path" || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
       /usr/bin/test -r "$protected_path" || \
     "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
       /usr/bin/test -w "$protected_path" || \
     "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
       /usr/bin/test -w "$protected_dir" || \
     ! homebrew_assert_tree_not_writable_by_user "$build_user" "$protected_dir" || \
     ! homebrew_assert_tree_not_replaceable_by_user "$build_user" "$protected_dir"; then
    echo "homebrew-patched-launcher: protected input is not root-owned, exact, readable, and immutable" >&2
    homebrew_patched_launcher_remove_staged_input || true
    return 1
  fi

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
  homebrew_patched_launcher_verify_overlay_seal \
    "$HOMEBREW_PATCHED_BUILD_USER" || return
  [ "$(homebrew_patched_launcher_integrity)" = "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ] || {
    echo "homebrew-patched-launcher: patched Homebrew source changed during Formula execution" >&2
    return 1
  }
  homebrew_patched_launcher_verify_dependency_plan || return
  [ -L "$HOMEBREW_PATCHED_LAUNCHER" ] && \
    [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_LAUNCHER")" = "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] || {
    echo "homebrew-patched-launcher: protected Brew launcher changed during Formula execution" >&2
    return 1
  }
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ] || {
      echo "homebrew-patched-launcher: native Homebrew was not sealed" >&2
      return 1
    }
    [ -f "$HOMEBREW_PATCHED_NATIVE_RUNNER" ] && \
      [ ! -L "$HOMEBREW_PATCHED_NATIVE_RUNNER" ] && \
      [ "$(/usr/bin/stat -c '%u:%g:%a' "$HOMEBREW_PATCHED_NATIVE_RUNNER")" = "0:0:500" ] || {
      echo "homebrew-patched-launcher: protected native Homebrew runner changed" >&2
      return 1
    }
    [ -L "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ] && \
      [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_NATIVE_BREW_BIN")" = \
        "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] && \
      [ "$(/usr/bin/stat -c '%u:%g' "$HOMEBREW_PATCHED_NATIVE_BREW_BIN")" = "0:0" ] || {
      echo "homebrew-patched-launcher: protected native Brew launcher changed" >&2
      return 1
    }
    homebrew_assert_tree_not_writable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"
    homebrew_assert_tree_not_replaceable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"

    local formula native_rack native_opt native_opt_target native_version
    local target_cellar target_opt target_rack target_keg target_opt_link
    local expected_opt_target build_gid
    build_gid="$(/usr/bin/id -g "$HOMEBREW_PATCHED_BUILD_USER")"
    target_cellar="$HOMEBREW_PATCHED_PREFIX/Cellar"
    target_opt="$HOMEBREW_PATCHED_PREFIX/opt"
    for formula in "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}"; do
      native_rack="$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar/$formula"
      native_opt="$HOMEBREW_PATCHED_NATIVE_PREFIX/opt/$formula"
      [ -d "$native_rack" ] && [ -L "$native_opt" ] || {
        echo "homebrew-patched-launcher: sealed native Formula changed: $formula" >&2
        return 1
      }
      native_opt_target="$(cd "$native_opt" && pwd -P)" || {
        echo "homebrew-patched-launcher: sealed native Formula opt link is unresolved: $formula" >&2
        return 1
      }
      [ "${native_opt_target%/*}" = "$native_rack" ] || {
        echo "homebrew-patched-launcher: sealed native Formula opt link leaves its rack: $formula" >&2
        return 1
      }
      native_version="${native_opt_target##*/}"
      target_rack="$target_cellar/$formula"
      target_keg="$target_rack/$native_version"
      target_opt_link="$target_opt/$formula"
      expected_opt_target="../Cellar/$formula/$native_version"
      [ -d "$target_rack" ] && [ ! -L "$target_rack" ] && \
        [ -d "$target_keg" ] && [ ! -L "$target_keg" ] && \
        [ "$(cd "$target_keg" && pwd -P)" = "$target_keg" ] && \
        [ -L "$target_opt_link" ] && \
        [ "$(/usr/bin/readlink "$target_opt_link")" = "$expected_opt_target" ] && \
        [ "$(cd "$target_opt_link" && pwd -P)" = "$target_keg" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_rack")" = "0:0:555" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_keg")" = "0:0:555" ] && \
        [ "$(/usr/bin/stat -c '%u:%g' "$target_opt_link")" = "0:0" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_cellar")" = \
          "0:$build_gid:1775" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_opt")" = \
          "0:$build_gid:1775" ] || {
        echo "homebrew-patched-launcher: native Formula proxy changed: $formula" >&2
        return 1
      }
      homebrew_assert_tree_not_writable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack"
      homebrew_assert_tree_not_replaceable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack"
    done
  fi
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
  local attempt candidate canonical_overlay patched_prefix patched_repo

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
  canonical_overlay="$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" || return
  HOMEBREW_PATCHED_OVERLAY="$canonical_overlay"
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
