#!/usr/bin/env bash
set -euo pipefail

homebrew_prepare_host_prefix_fail() {
  echo "homebrew-prepare-host-prefix: $*" >&2
  return 2
}

homebrew_prepare_host_prefix_assert_trusted_directory() {
  if [ "$#" -ne 4 ]; then
    homebrew_prepare_host_prefix_fail \
      "expected PATH TRUSTED_UID TRUSTED_GID LABEL"
    return
  fi
  local path="$1" trusted_uid="$2" trusted_gid="$3" label="$4"
  local physical state owner group mode

  [ -d "$path" ] && [ ! -L "$path" ] || {
    homebrew_prepare_host_prefix_fail \
      "$label must be a real non-symlink directory: $path"
    return
  }
  physical="$("$HOMEBREW_HOST_PREFIX_REALPATH" -- "$path")" || return
  [ "$physical" = "$path" ] || {
    homebrew_prepare_host_prefix_fail \
      "$label must use its physical canonical path: $path"
    return
  }
  state="$(
    "$HOMEBREW_HOST_PREFIX_SUDO" -n -- \
      "$HOMEBREW_HOST_PREFIX_STAT" -c '%u:%g:%a' -- "$path"
  )" || return
  IFS=: read -r owner group mode <<<"$state"
  [[ "$owner" =~ ^[0-9]+$ && "$group" =~ ^[0-9]+$ && \
     "$mode" =~ ^[0-7]+$ ]] || {
    homebrew_prepare_host_prefix_fail \
      "could not read a numeric owner and mode for $label: $path"
    return
  }
  [ "$owner" = "$trusted_uid" ] || {
    # WHY: removing write bits is not sufficient when the build identity owns
    # the directory. Its owner could restore write access and replace the
    # protected Homebrew prefix before the isolated Formula starts.
    homebrew_prepare_host_prefix_fail \
      "$label is replaceable because its owner is not trusted: $path"
    return
  }
  [ "$group" = "$trusted_gid" ] || {
    homebrew_prepare_host_prefix_fail \
      "$label does not have its required trusted group: $path"
    return
  }
  [ $((8#$mode & 0022)) -eq 0 ] && \
    [ $((8#$mode & 0111)) -eq $((0111)) ] || {
    homebrew_prepare_host_prefix_fail \
      "$label must be traversable and not group- or world-writable: $path"
    return
  }
}

homebrew_prepare_host_prefix_assert_mutable_directory() {
  if [ "$#" -ne 5 ]; then
    homebrew_prepare_host_prefix_fail \
      "expected PATH OWNER_UID OWNER_GID MODE LABEL"
    return
  fi
  local path="$1" wanted_uid="$2" wanted_gid="$3" wanted_mode="$4" label="$5"
  local physical state

  [ -d "$path" ] && [ ! -L "$path" ] || {
    homebrew_prepare_host_prefix_fail \
      "$label must be a real non-symlink directory: $path"
    return
  }
  physical="$("$HOMEBREW_HOST_PREFIX_REALPATH" -- "$path")" || return
  [ "$physical" = "$path" ] || {
    homebrew_prepare_host_prefix_fail \
      "$label must use its physical canonical path: $path"
    return
  }
  state="$(
    "$HOMEBREW_HOST_PREFIX_SUDO" -n -- \
      "$HOMEBREW_HOST_PREFIX_STAT" -c '%u:%g:%a' -- "$path"
  )" || return
  [ "$state" = "$wanted_uid:$wanted_gid:$wanted_mode" ] || {
    homebrew_prepare_host_prefix_fail \
      "$label has unexpected ownership or permissions: $path ($state)"
    return
  }
}

# GitHub-hosted Ubuntu runners deliberately make /opt group- and
# world-writable so preinstalled tools can update themselves. That is not a
# safe parent for a prefix which becomes protected before untrusted Formula
# code runs. Validate the runner-owned directory and any existing anchor
# before changing permissions, remove only the unsafe write bits, and then
# revalidate both paths.
homebrew_prepare_host_prefix_harden_anchor_parent() {
  if [ "$#" -ne 4 ]; then
    homebrew_prepare_host_prefix_fail \
      "expected PARENT ANCHOR TRUSTED_UID TRUSTED_GID"
    return
  fi
  local parent="$1" anchor="$2" trusted_uid="$3" trusted_gid="$4"
  local physical state owner group mode

  [ "$anchor" = "$parent/kandelo" ] || {
    homebrew_prepare_host_prefix_fail \
      "prefix anchor is not the reviewed child of its parent: $anchor"
    return
  }
  [ -d "$parent" ] && [ ! -L "$parent" ] || {
    homebrew_prepare_host_prefix_fail \
      "prefix anchor parent must be a real non-symlink directory: $parent"
    return
  }
  physical="$("$HOMEBREW_HOST_PREFIX_REALPATH" -- "$parent")" || return
  [ "$physical" = "$parent" ] || {
    homebrew_prepare_host_prefix_fail \
      "prefix anchor parent must use its physical canonical path: $parent"
    return
  }
  state="$(
    "$HOMEBREW_HOST_PREFIX_SUDO" -n -- \
      "$HOMEBREW_HOST_PREFIX_STAT" -c '%u:%g:%a' -- "$parent"
  )" || return
  IFS=: read -r owner group mode <<<"$state"
  [[ "$owner" =~ ^[0-9]+$ && "$group" =~ ^[0-9]+$ && \
    "$mode" =~ ^[0-7]+$ ]] || {
    homebrew_prepare_host_prefix_fail \
      "could not read a numeric owner and mode for prefix anchor parent:" \
      "$parent"
    return
  }
  [ "$owner" = "$trusted_uid" ] && [ "$group" = "$trusted_gid" ] || {
    homebrew_prepare_host_prefix_fail \
      "prefix anchor parent does not have its required trusted ownership:" \
      "$parent"
    return
  }
  [ $((8#$mode & 0111)) -eq $((0111)) ] || {
    homebrew_prepare_host_prefix_fail \
      "prefix anchor parent must be traversable before hardening: $parent"
    return
  }

  # WHY: locking a writable parent after accepting an attacker-controlled
  # child would preserve that child as the trusted anchor. Reject it first.
  if [ -e "$anchor" ] || [ -L "$anchor" ]; then
    homebrew_prepare_host_prefix_assert_trusted_directory \
      "$anchor" "$trusted_uid" "$trusted_gid" "prefix anchor" || return
  fi

  if [ $((8#$mode & 0022)) -ne 0 ]; then
    "$HOMEBREW_HOST_PREFIX_SUDO" -n -- \
      "$HOMEBREW_HOST_PREFIX_CHMOD" g-w,o-w -- "$parent" || return
  fi
  homebrew_prepare_host_prefix_assert_trusted_directory \
    "$parent" "$trusted_uid" "$trusted_gid" \
    "prefix anchor parent" || return
  if [ -e "$anchor" ] || [ -L "$anchor" ]; then
    homebrew_prepare_host_prefix_assert_trusted_directory \
      "$anchor" "$trusted_uid" "$trusted_gid" "prefix anchor" || return
  fi
}

# Prepare the prefix-campaign layout below a trusted anchor. This function is
# kept separately callable so its filesystem contract can be tested in a
# temporary tree without creating host-global /opt state.
homebrew_prepare_prefix_campaign_tree() {
  if [ "$#" -ne 5 ]; then
    homebrew_prepare_host_prefix_fail \
      "expected PREFIX TRUSTED_UID TRUSTED_GID BUILD_UID BUILD_GID"
    return
  fi
  local prefix="$1" trusted_uid="$2" trusted_gid="$3"
  local build_uid="$4" build_gid="$5" anchor anchor_parent

  anchor="${prefix%/*}"
  anchor_parent="${anchor%/*}"
  [ -n "$anchor" ] && [ -n "$anchor_parent" ] && \
    [ "$anchor" != "$prefix" ] && [ "$anchor_parent" != "$anchor" ] || {
    homebrew_prepare_host_prefix_fail "prefix has no protected parent: $prefix"
    return
  }

  homebrew_prepare_host_prefix_assert_trusted_directory \
    "$anchor_parent" "$trusted_uid" "$trusted_gid" \
    "prefix anchor parent" || return

  if [ -e "$anchor" ] || [ -L "$anchor" ]; then
    homebrew_prepare_host_prefix_assert_trusted_directory \
      "$anchor" "$trusted_uid" "$trusted_gid" "prefix anchor" || return
  else
    "$HOMEBREW_HOST_PREFIX_SUDO" -n -- \
      "$HOMEBREW_HOST_PREFIX_INSTALL" -d \
        -o "$trusted_uid" -g "$trusted_gid" -m 0755 -- "$anchor" || return
  fi
  homebrew_prepare_host_prefix_assert_trusted_directory \
    "$anchor" "$trusted_uid" "$trusted_gid" "prefix anchor" || return

  # Reject links before install(1), which otherwise may follow a privileged
  # link supplied by unexpected pre-existing host state.
  if { [ -e "$prefix" ] || [ -L "$prefix" ]; } && \
     { [ ! -d "$prefix" ] || [ -L "$prefix" ]; }; then
    homebrew_prepare_host_prefix_fail \
      "mutable Homebrew prefix must be a real non-symlink directory: $prefix"
    return
  fi
  if { [ -e "$prefix/bin" ] || [ -L "$prefix/bin" ]; } && \
     { [ ! -d "$prefix/bin" ] || [ -L "$prefix/bin" ]; }; then
    homebrew_prepare_host_prefix_fail \
      "mutable Homebrew bin must be a real non-symlink directory: $prefix/bin"
    return
  fi

  "$HOMEBREW_HOST_PREFIX_SUDO" -n -- \
    "$HOMEBREW_HOST_PREFIX_INSTALL" -d \
      -o "$build_uid" -g "$build_gid" -m 0755 -- \
      "$prefix" "$prefix/bin" || return

  # WHY: the isolated launcher later treats the Homebrew prefix as protected
  # source. A root-owned /opt/kandelo prevents the build user from renaming the
  # whole prefix, while this child stays writable long enough to activate Brew
  # and install the selected Formula.
  homebrew_prepare_host_prefix_assert_trusted_directory \
    "$anchor" "$trusted_uid" "$trusted_gid" "prefix anchor" || return
  homebrew_prepare_host_prefix_assert_mutable_directory \
    "$prefix" "$build_uid" "$build_gid" 755 \
    "mutable Homebrew prefix" || return
  homebrew_prepare_host_prefix_assert_mutable_directory \
    "$prefix/bin" "$build_uid" "$build_gid" 755 \
    "mutable Homebrew bin" || return
}

homebrew_prepare_host_prefix_main() {
  local layout_mode="" prefix=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --layout-mode)
        [ "$#" -ge 2 ] || {
          homebrew_prepare_host_prefix_fail "--layout-mode requires a value"
          return
        }
        layout_mode="$2"
        shift 2
        ;;
      --prefix)
        [ "$#" -ge 2 ] || {
          homebrew_prepare_host_prefix_fail "--prefix requires a value"
          return
        }
        prefix="$2"
        shift 2
        ;;
      *)
        homebrew_prepare_host_prefix_fail "unknown argument: $1"
        return
        ;;
    esac
  done

  case "$layout_mode:$prefix" in
    canonical:/opt/kandelo/homebrew|prefix-campaign:/opt/kandelo/homebrew)
      # WHY: both modes use the post-cutover guest layout. The campaign name
      # remains valid so already sealed handoffs can bind their layout digest.
      homebrew_prepare_host_prefix_harden_anchor_parent \
        /opt /opt/kandelo 0 0 || return
      homebrew_prepare_prefix_campaign_tree \
        "$prefix" 0 0 "$(/usr/bin/id -u)" "$(/usr/bin/id -g)"
      ;;
    *)
      homebrew_prepare_host_prefix_fail \
        "layout mode and prefix are not a reviewed pair: $layout_mode:$prefix"
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ "$(uname -s)" = Linux ] || {
    homebrew_prepare_host_prefix_fail "host prefix preparation requires Linux"
    exit 2
  }
  HOMEBREW_HOST_PREFIX_SUDO=/usr/bin/sudo
  HOMEBREW_HOST_PREFIX_STAT=/usr/bin/stat
  HOMEBREW_HOST_PREFIX_INSTALL=/usr/bin/install
  HOMEBREW_HOST_PREFIX_REALPATH=/usr/bin/realpath
  HOMEBREW_HOST_PREFIX_CHMOD=/usr/bin/chmod
  for required in \
    "$HOMEBREW_HOST_PREFIX_SUDO" "$HOMEBREW_HOST_PREFIX_STAT" \
    "$HOMEBREW_HOST_PREFIX_INSTALL" "$HOMEBREW_HOST_PREFIX_REALPATH" \
    "$HOMEBREW_HOST_PREFIX_CHMOD" /usr/bin/id; do
    [ -x "$required" ] || {
      homebrew_prepare_host_prefix_fail "missing required host tool: $required"
      exit 2
    }
  done
  homebrew_prepare_host_prefix_main "$@"
fi
