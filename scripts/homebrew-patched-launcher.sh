#!/usr/bin/env bash

# Lifecycle helpers for running a patched Homebrew worktree without changing
# the prefix and Cellar selected by the caller's brew executable.

HOMEBREW_PATCHED_REPO=""
HOMEBREW_PATCHED_PREFIX=""
HOMEBREW_PATCHED_OVERLAY=""
HOMEBREW_PATCHED_LAUNCHER=""
HOMEBREW_PATCHED_BREW_BIN=""

homebrew_patched_launcher_cleanup() {
  if [ -n "$HOMEBREW_PATCHED_LAUNCHER" ] && [ -L "$HOMEBREW_PATCHED_LAUNCHER" ]; then
    rm -f "$HOMEBREW_PATCHED_LAUNCHER"
  fi
  if [ -n "$HOMEBREW_PATCHED_REPO" ] &&
     [ -n "$HOMEBREW_PATCHED_OVERLAY" ] &&
     [ -d "$HOMEBREW_PATCHED_OVERLAY" ]; then
    git -C "$HOMEBREW_PATCHED_REPO" worktree remove --force "$HOMEBREW_PATCHED_OVERLAY" \
      >/dev/null 2>&1 || rm -rf "$HOMEBREW_PATCHED_OVERLAY"
  fi
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
